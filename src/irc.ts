/*
    irc.js - Node JS IRC client library

    (C) Copyright Martyn Smith 2010

    This library is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This library is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this library.  If not, see <http://www.gnu.org/licenses/>.
*/

import { createConnection, type Socket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { inspect } from "node:util";
import { EventEmitter } from "node:events";

import { parseMessage } from "./parse_message";
import type { IChannel, IClientOpts, handlers } from "./types";

export * as colors from "./colors";

var pingCounter = 1;

import { CyclingPingTimer } from "./cycling_ping_timer";

var lineDelimiter = new RegExp("\r\n|\r|\n");

export class Client extends EventEmitter {
  public opt: IClientOpts & {
    server: string;
    nick: string;
    nickMod?: number | undefined;
  } = {
    server: undefined!,
    nick: undefined!,
    password: null,
    userName: "nodebot",
    realName: "nodeJS IRC client",
    port: 6667,
    localAddress: null,
    debug: false,
    showErrors: false,
    autoRejoin: false,
    autoConnect: true,
    channels: [],
    retryCount: null,
    retryDelay: 2000,
    secure: false,
    selfSigned: false,
    certExpired: false,
    floodProtection: false,
    floodProtectionDelay: 1000,
    sasl: false,
    stripColors: false,
    channelPrefixes: "&#",
    messageSplit: 512,
    encoding: false,
    webirc: {
      pass: "",
      ip: "",
      host: "",
    },
    millisecondsOfSilenceBeforePingSent: 15 * 1000,
    millisecondsBeforePingTimeout: 8 * 1000,
  };

  /** Features supported by the server */
  // (initial values are RFC 1459 defaults. Zeros signify
  // no default or unlimited value)
  public supported = {
    channel: {
      idlength: [] as string[],
      length: 200,
      limit: [] as number[],
      modes: { a: "", b: "", c: "", d: "" } as {
        [index: string]: string;
      },
      types: "&#",
    },
    kicklength: 0,
    maxlist: [] as number[],
    maxtargets: [] as string[],
    modes: 3,
    nicklength: 9,
    topiclength: 0,
    usermodes: "",
  };

  hostMask = "";

  /** The server's message of the day */
  motd = "";

  channellist: IChannel[] = [];

  /** Maximum line length */
  maxLineLength = 200;

  constructor(
    server: string,
    public nick: string,
    opts?: Partial<IClientOpts>
  ) {
    super();
    this.opt = { ...this.opt, ...opts, server, nick };
    this.supported.channel.types = this.opt.channelPrefixes;

    if (this.opt.floodProtection) {
      this.activateFloodProtection();
    }

    // TODO - fail if nick or server missing
    // TODO - fail if username has a space in it
    if (this.opt.autoConnect === true) {
      this.connect();
    }

    this.addListener("raw", (message) => {
      var channels: string[] = [];
      var channel;
      var nick;
      var from;
      var text;
      var to;

      switch (message.command) {
        case "rpl_welcome":
          // Set nick to whatever the server decided it really is
          // (normally this is because you chose something too long and
          // the server has shortened it
          this.nick = message.args[0];
          // Note our hostmask to use it in splitting long messages.
          // We don't send our hostmask when issuing PRIVMSGs or NOTICEs,
          // of course, but rather the servers on the other side will
          // include it in messages and will truncate what we send if
          // the string is too long. Therefore, we need to be considerate
          // neighbors and truncate our messages accordingly.
          var welcomeStringWords = message.args[1].split(/\s+/);
          this.hostMask = welcomeStringWords[welcomeStringWords.length - 1];
          this._updateMaxLineLength();
          this.emit("registered", message);
          this.whois(this.nick, (args) => {
            this.nick = args.nick;
            this.hostMask = args.user + "@" + args.host;
            this._updateMaxLineLength();
          });
          break;
        case "rpl_myinfo":
          this.supported.usermodes = message.args[3];
          break;
        case "rpl_isupport":
          message.args.forEach((arg) => {
            var match;
            match = arg.match(/([A-Z]+)=(.*)/);
            if (match) {
              var param = match[1];
              var value = match[2];
              switch (param) {
                case "CHANLIMIT":
                  value.split(",").forEach((val) => {
                    val = val.split(":");
                    this.supported.channel.limit[val[0]] = parseInt(val[1]);
                  });
                  break;
                case "CHANMODES":
                  value = value.split(",");
                  var type = ["a", "b", "c", "d"];
                  for (var i = 0; i < type.length; i++) {
                    this.supported.channel.modes[type[i]] += value[i];
                  }
                  break;
                case "CHANTYPES":
                  this.supported.channel.types = value;
                  break;
                case "CHANNELLEN":
                  this.supported.channel.length = parseInt(value);
                  break;
                case "IDCHAN":
                  value.split(",").forEach((val) => {
                    val = val.split(":");
                    this.supported.channel.idlength[val[0]] = val[1];
                  });
                  break;
                case "KICKLEN":
                  this.supported.kicklength = value;
                  break;
                case "MAXLIST":
                  value.split(",").forEach((val) => {
                    val = val.split(":");
                    this.supported.maxlist[val[0]] = parseInt(val[1]);
                  });
                  break;
                case "NICKLEN":
                  this.supported.nicklength = parseInt(value);
                  break;
                case "PREFIX":
                  match = value.match(/\((.*?)\)(.*)/);
                  if (match) {
                    match[1] = match[1].split("");
                    match[2] = match[2].split("");
                    while (match[1].length) {
                      this.modeForPrefix[match[2][0]] = match[1][0];
                      this.supported.channel.modes.b += match[1][0];
                      this.prefixForMode[match[1].shift()] = match[2].shift();
                    }
                  }
                  break;
                case "STATUSMSG":
                  break;
                case "TARGMAX":
                  value.split(",").forEach((val) => {
                    val = val.split(":");
                    val[1] = !val[1] ? 0 : parseInt(val[1]);
                    this.supported.maxtargets[val[0]] = val[1];
                  });
                  break;
                case "TOPICLEN":
                  this.supported.topiclength = parseInt(value);
                  break;
              }
            }
          });
          break;
        case "rpl_yourhost":
        case "rpl_created":
        case "rpl_luserclient":
        case "rpl_luserop":
        case "rpl_luserchannels":
        case "rpl_luserme":
        case "rpl_localusers":
        case "rpl_globalusers":
        case "rpl_statsconn":
        case "rpl_luserunknown":
        case "396":
        case "042":
          // Random welcome crap, ignoring
          break;
        case "err_nicknameinuse":
          if (this.opt.nickMod === undefined) this.opt.nickMod = 0;
          this.opt.nickMod++;
          this.send("NICK", this.opt.nick + this.opt.nickMod);
          this.nick = this.opt.nick + this.opt.nickMod;
          this._updateMaxLineLength();
          break;
        case "PING":
          this.send("PONG", message.args[0]);
          this.emit("ping", message.args[0]);
          break;
        case "PONG":
          this.emit("pong", message.args[0]);
          break;
        case "NOTICE":
          from = message.nick;
          to = message.args[0];
          if (!to) {
            to = null;
          }
          text = message.args[1] || "";
          if (text[0] === "\u0001" && text.lastIndexOf("\u0001") > 0) {
            this._handleCTCP(from, to, text, "notice", message);
            break;
          }
          this.emit("notice", from, to, text, message);

          if (this.opt.debug && to == this.nick)
            console.info(
              "GOT NOTICE from " +
                (from ? '"' + from + '"' : "the server") +
                ': "' +
                text +
                '"'
            );
          break;
        case "MODE":
          if (this.opt.debug)
            console.info(
              "MODE: " + message.args[0] + " sets mode: " + message.args[1]
            );

          channel = this.chanData(message.args[0]);
          if (!channel) break;
          var modeList = message.args[1].split("");
          var adding = true;
          var modeArgs = message.args.slice(2);
          modeList.forEach((mode) => {
            if (mode == "+") {
              adding = true;
              return;
            }
            if (mode == "-") {
              adding = false;
              return;
            }

            var eventName = (adding ? "+" : "-") + "mode";
            var supported = this.supported.channel.modes;
            var modeArg;
            var chanModes = (mode, param?) => {
              var arr = param && Array.isArray(param);
              if (adding) {
                if (channel.mode.indexOf(mode) == -1) {
                  channel.mode += mode;
                }
                if (param === undefined) {
                  channel.modeParams[mode] = [];
                } else if (arr) {
                  channel.modeParams[mode] = channel.modeParams[mode]
                    ? channel.modeParams[mode].concat(param)
                    : param;
                } else {
                  channel.modeParams[mode] = [param];
                }
              } else {
                if (arr) {
                  channel.modeParams[mode] = channel.modeParams[mode].filter(
                    (v) => v !== param[0]
                  );
                }
                if (!arr || channel.modeParams[mode].length === 0) {
                  channel.mode = channel.mode.replace(mode, "");
                  delete channel.modeParams[mode];
                }
              }
            };
            if (mode in this.prefixForMode) {
              modeArg = modeArgs.shift();
              if (channel.users.hasOwnProperty(modeArg)) {
                if (adding) {
                  if (
                    channel.users[modeArg].indexOf(this.prefixForMode[mode]) ===
                    -1
                  )
                    channel.users[modeArg] += this.prefixForMode[mode];
                } else
                  channel.users[modeArg] = channel.users[modeArg].replace(
                    this.prefixForMode[mode],
                    ""
                  );
              }
              this.emit(
                eventName,
                message.args[0],
                message.nick,
                mode,
                modeArg,
                message
              );
            } else if (supported.a.indexOf(mode) !== -1) {
              modeArg = modeArgs.shift();
              chanModes(mode, [modeArg]);
              this.emit(
                eventName,
                message.args[0],
                message.nick,
                mode,
                modeArg,
                message
              );
            } else if (supported.b.indexOf(mode) !== -1) {
              modeArg = modeArgs.shift();
              chanModes(mode, modeArg);
              this.emit(
                eventName,
                message.args[0],
                message.nick,
                mode,
                modeArg,
                message
              );
            } else if (supported.c.indexOf(mode) !== -1) {
              if (adding) modeArg = modeArgs.shift();
              else modeArg = undefined;
              chanModes(mode, modeArg);
              this.emit(
                eventName,
                message.args[0],
                message.nick,
                mode,
                modeArg,
                message
              );
            } else if (supported.d.indexOf(mode) !== -1) {
              chanModes(mode);
              this.emit(
                eventName,
                message.args[0],
                message.nick,
                mode,
                undefined,
                message
              );
            }
          });
          break;
        case "NICK":
          if (message.nick == this.nick) {
            // the user just changed their own nick
            this.nick = message.args[0];
            this._updateMaxLineLength();
          }

          if (this.opt.debug)
            console.info(
              "NICK: " + message.nick + " changes nick to " + message.args[0]
            );

          channels = [];

          // TODO better way of finding what channels a user is in?
          Object.keys(this.chans).forEach((channame) => {
            var channel = this.chans[channame];
            channel.users[message.args[0]] = channel.users[message.nick];
            delete channel.users[message.nick];
            channels.push(channame);
          });

          // old nick, new nick, channels
          this.emit("nick", message.nick, message.args[0], channels, message);
          break;
        case "rpl_motdstart":
          this.motd = message.args[1] + "\n";
          break;
        case "rpl_motd":
          this.motd += message.args[1] + "\n";
          break;
        case "rpl_endofmotd":
        case "err_nomotd":
          this.motd += message.args[1] + "\n";
          this.emit("motd", this.motd);
          break;
        case "rpl_namreply":
          channel = this.chanData(message.args[2]);
          var users = message.args[3].trim().split(/ +/);
          if (channel) {
            users.forEach((user) => {
              var match = user.match(/^(.)(.*)$/);
              if (match) {
                if (match[1] in this.modeForPrefix) {
                  channel.users[match[2]] = match[1];
                } else {
                  channel.users[match[1] + match[2]] = "";
                }
              }
            });
          }
          break;
        case "rpl_endofnames":
          channel = this.chanData(message.args[1]);
          if (channel) {
            this.emit("names", message.args[1], channel.users);
            this.emit("names" + message.args[1], channel.users);
            this.send("MODE", message.args[1]);
          }
          break;
        case "rpl_topic":
          channel = this.chanData(message.args[1]);
          if (channel) {
            channel.topic = message.args[2];
          }
          break;
        case "rpl_away":
          this._addWhoisData(message.args[1], "away", message.args[2], true);
          break;
        case "rpl_whoisuser":
          this._addWhoisData(message.args[1], "user", message.args[2]);
          this._addWhoisData(message.args[1], "host", message.args[3]);
          this._addWhoisData(message.args[1], "realname", message.args[5]);
          break;
        case "rpl_whoisidle":
          this._addWhoisData(message.args[1], "idle", message.args[2]);
          break;
        case "rpl_whoischannels":
          // TODO - clean this up?
          this._addWhoisData(
            message.args[1],
            "channels",
            message.args[2].trim().split(/\s+/)
          );
          break;
        case "rpl_whoisserver":
          this._addWhoisData(message.args[1], "server", message.args[2]);
          this._addWhoisData(message.args[1], "serverinfo", message.args[3]);
          break;
        case "rpl_whoisoperator":
          this._addWhoisData(message.args[1], "operator", message.args[2]);
          break;
        case "330": // rpl_whoisaccount?
          this._addWhoisData(message.args[1], "account", message.args[2]);
          this._addWhoisData(message.args[1], "accountinfo", message.args[3]);
          break;
        case "rpl_endofwhois":
          this.emit("whois", this._clearWhoisData(message.args[1]));
          break;
        case "rpl_whoreply":
          this._addWhoisData(message.args[5], "user", message.args[2]);
          this._addWhoisData(message.args[5], "host", message.args[3]);
          this._addWhoisData(message.args[5], "server", message.args[4]);
          this._addWhoisData(
            message.args[5],
            "realname",
            /[0-9]+\s*(.+)/g.exec(message.args[7])![1]
          );
          // emit right away because rpl_endofwho doesn't contain nick
          this.emit("whois", this._clearWhoisData(message.args[5]));
          break;
        case "rpl_liststart":
          this.channellist = [];
          this.emit("channellist_start");
          break;
        case "rpl_list":
          channel = {
            name: message.args[1],
            users: message.args[2],
            topic: message.args[3],
          };
          this.emit("channellist_item", channel);
          this.channellist.push(channel);
          break;
        case "rpl_listend":
          this.emit("channellist", this.channellist);
          break;
        case "rpl_topicwhotime":
          channel = this.chanData(message.args[1]);
          if (channel) {
            channel.topicBy = message.args[2];
            // channel, topic, nick
            this.emit(
              "topic",
              message.args[1],
              channel.topic,
              channel.topicBy,
              message
            );
          }
          break;
        case "TOPIC":
          // channel, topic, nick
          this.emit(
            "topic",
            message.args[0],
            message.args[1],
            message.nick,
            message
          );

          channel = this.chanData(message.args[0]);
          if (channel) {
            channel.topic = message.args[1];
            channel.topicBy = message.nick;
          }
          break;
        case "rpl_channelmodeis":
          channel = this.chanData(message.args[1]);
          if (channel) {
            channel.mode = message.args[2];
          }
          break;
        case "rpl_creationtime":
          channel = this.chanData(message.args[1]);
          if (channel) {
            channel.created = message.args[2];
          }
          break;
        case "JOIN":
          // channel, who
          if (this.nick == message.nick) {
            this.chanData(message.args[0], true);
          } else {
            channel = this.chanData(message.args[0]);
            if (channel && channel.users) {
              channel.users[message.nick] = "";
            }
          }
          this.emit("join", message.args[0], message.nick, message);
          this.emit("join" + message.args[0], message.nick, message);
          if (message.args[0] != message.args[0].toLowerCase()) {
            this.emit(
              "join" + message.args[0].toLowerCase(),
              message.nick,
              message
            );
          }
          break;
        case "PART":
          // channel, who, reason
          this.emit(
            "part",
            message.args[0],
            message.nick,
            message.args[1],
            message
          );
          this.emit(
            "part" + message.args[0],
            message.nick,
            message.args[1],
            message
          );
          if (message.args[0] != message.args[0].toLowerCase()) {
            this.emit(
              "part" + message.args[0].toLowerCase(),
              message.nick,
              message.args[1],
              message
            );
          }
          if (this.nick == message.nick) {
            channel = this.chanData(message.args[0]);
            delete this.chans[channel.key];
          } else {
            channel = this.chanData(message.args[0]);
            if (channel && channel.users) {
              delete channel.users[message.nick];
            }
          }
          break;
        case "KICK":
          // channel, who, by, reason
          this.emit(
            "kick",
            message.args[0],
            message.args[1],
            message.nick,
            message.args[2],
            message
          );
          this.emit(
            "kick" + message.args[0],
            message.args[1],
            message.nick,
            message.args[2],
            message
          );
          if (message.args[0] != message.args[0].toLowerCase()) {
            this.emit(
              "kick" + message.args[0].toLowerCase(),
              message.args[1],
              message.nick,
              message.args[2],
              message
            );
          }

          if (this.nick == message.args[1]) {
            channel = this.chanData(message.args[0]);
            delete this.chans[channel.key];
          } else {
            channel = this.chanData(message.args[0]);
            if (channel && channel.users) {
              delete channel.users[message.args[1]];
            }
          }
          break;
        case "KILL":
          nick = message.args[0];
          channels = [];
          Object.keys(this.chans).forEach((channame) => {
            var channel = this.chans[channame];
            channels.push(channame);
            delete channel.users[nick];
          });
          this.emit("kill", nick, message.args[1], channels, message);
          break;
        case "PRIVMSG":
          from = message.nick;
          to = message.args[0];
          text = message.args[1] || "";
          if (text[0] === "\u0001" && text.lastIndexOf("\u0001") > 0) {
            this._handleCTCP(from, to, text, "privmsg", message);
            break;
          }
          this.emit("message", from, to, text, message);
          if (this.supported.channel.types.indexOf(to.charAt(0)) !== -1) {
            this.emit("message#", from, to, text, message);
            this.emit("message" + to, from, text, message);
            if (to != to.toLowerCase()) {
              this.emit("message" + to.toLowerCase(), from, text, message);
            }
          }
          if (to.toUpperCase() === this.nick.toUpperCase())
            this.emit("pm", from, text, message);

          if (this.opt.debug && to == this.nick)
            console.info("GOT MESSAGE from " + from + ": " + text);
          break;
        case "INVITE":
          from = message.nick;
          to = message.args[0];
          channel = message.args[1];
          this.emit("invite", channel, from, message);
          break;
        case "QUIT":
          if (this.opt.debug)
            console.info(
              "QUIT: " + message.prefix + " " + message.args.join(" ")
            );
          if (this.nick == message.nick) {
            // TODO handle?
            break;
          }
          // handle other people quitting

          channels = [];

          // TODO better way of finding what channels a user is in?
          Object.keys(this.chans).forEach((channame) => {
            var channel = this.chans[channame];
            delete channel.users[message.nick];
            channels.push(channame);
          });

          // who, reason, channels
          this.emit("quit", message.nick, message.args[0], channels, message);
          break;

        // for sasl
        case "CAP":
          if (
            message.args[0] === "*" &&
            message.args[1] === "ACK" &&
            message.args[2] === "sasl "
          )
            // there's a space after sasl
            this.send("AUTHENTICATE", "PLAIN");
          break;
        case "AUTHENTICATE":
          if (message.args[0] === "+")
            this.send(
              "AUTHENTICATE",
              new Buffer(
                this.opt.nick +
                  "\0" +
                  this.opt.userName +
                  "\0" +
                  this.opt.password
              ).toString("base64")
            );
          break;
        case "903":
          this.send("CAP", "END");
          break;

        case "err_umodeunknownflag":
          if (this.opt.showErrors)
            console.info(
              "\u001b[01;31mERROR: " + inspect(message) + "\u001b[0m"
            );
          break;

        case "err_erroneusnickname":
          if (this.opt.showErrors)
            console.info(
              "\u001b[01;31mERROR: " + inspect(message) + "\u001b[0m"
            );
          this.emit("error", message);
          break;

        // Commands relating to OPER
        case "err_nooperhost":
          if (this.opt.showErrors) {
            this.emit("error", message);
            if (this.opt.showErrors)
              console.info(
                "\u001b[01;31mERROR: " + inspect(message) + "\u001b[0m"
              );
          }
          break;

        case "rpl_youreoper":
          this.emit("opered");
          break;

        default:
          if (message.commandType == "error") {
            this.emit("error", message);
            if (this.opt.showErrors)
              console.info(
                "\u001b[01;31mERROR: " + inspect(message) + "\u001b[0m"
              );
          } else {
            if (this.opt.debug)
              console.info(
                "\u001b[01;31mUnhandled message: " +
                  inspect(message) +
                  "\u001b[0m"
              );
            break;
          }
      }
    });

    this.addListener("kick", (channel, who, by, reason) => {
      if (this.opt.autoRejoin)
        this.send.apply(this, ["JOIN"].concat(channel.split(" ")));
    });
    this.addListener("motd", (motd) => {
      this.opt.channels.forEach((channel) => {
        this.send.apply(this, ["JOIN"].concat(channel.split(" ")));
      });
    });
  }

  conn:
    | ((Socket | TLSSocket) & {
        requestedDisconnect?: boolean;
        cyclingPingTimer?: CyclingPingTimer;
      })
    | null = null;
  prefixForMode = {};
  modeForPrefix = {};
  chans = {};
  _whoisData = {};

  connectionTimedOut(conn) {
    if (conn !== this.conn) {
      // Only care about a timeout event if it came from the connection
      // that is most current.
      return;
    }
    this.end();
  }

  connectionWantsPing(conn) {
    if (conn !== this.conn) {
      // Only care about a wantPing event if it came from the connection
      // that is most current.
      return;
    }
    this.send("PING", (pingCounter++).toString());
  }

  chanData(name: string, create?: boolean) {
    var key = name.toLowerCase();
    if (create) {
      this.chans[key] = this.chans[key] ?? {
        key: key,
        serverName: name,
        users: {},
        modeParams: {},
        mode: "",
      };
    }

    return this.chans[key];
  }

  _connectionHandler = () => {
    if (this.opt.webirc.ip && this.opt.webirc.pass && this.opt.webirc.host) {
      this.send(
        "WEBIRC",
        this.opt.webirc.pass,
        this.opt.userName,
        this.opt.webirc.host,
        this.opt.webirc.ip
      );
    }
    if (this.opt.sasl) {
      // see http://ircv3.atheme.org/extensions/sasl-3.1
      this.send("CAP REQ", "sasl");
    } else if (this.opt.password) {
      this.send("PASS", this.opt.password);
    }
    if (this.opt.debug) console.info("Sending irc NICK/USER");
    this.send("NICK", this.opt.nick);
    this.nick = this.opt.nick;
    this._updateMaxLineLength();
    this.send("USER", this.opt.userName, "8", "*", this.opt.realName);

    (this.conn as any).cyclingPingTimer.start();

    this.emit("connect");
  };

  connect(retryCount?: number | handlers.IRaw, callback?: handlers.IRaw) {
    if (typeof retryCount === "function") {
      callback = retryCount;
      retryCount = undefined;
    }
    retryCount = retryCount || 0;
    if (typeof callback === "function") {
      this.once("registered", callback);
    }
    this.chans = {};

    // socket opts
    var connectionOpts = {
      host: this.opt.server,
      port: this.opt.port,
      localAddress: undefined as string | undefined,
      rejectUnauthorized: undefined as boolean | undefined,
    };

    // local address to bind to
    if (this.opt.localAddress)
      connectionOpts.localAddress = this.opt.localAddress;

    // try to connect to the server
    if (this.opt.secure) {
      connectionOpts.rejectUnauthorized = !this.opt.selfSigned;

      if (typeof this.opt.secure == "object") {
        // copy "secure" opts to options passed to connect()
        for (var f in this.opt.secure) {
          connectionOpts[f] = this.opt.secure[f];
        }
      }

      this.conn = tlsConnect(connectionOpts, () => {
        // callback called only after successful socket connection

        // upstream bug: https://github.com/DefinitelyTyped/DefinitelyTyped/pull/49461
        const { authorized, authorizationError } = this.conn! as any as Omit<
          TLSSocket,
          "authorizationError"
        > & { authorizationError: string | null };

        if (
          authorized ||
          (this.opt.selfSigned &&
            (authorizationError === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
              authorizationError === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
              authorizationError === "SELF_SIGNED_CERT_IN_CHAIN")) ||
          (this.opt.certExpired && authorizationError === "CERT_HAS_EXPIRED")
        ) {
          // authorization successful

          if (!this.opt.encoding) {
            this.conn!.setEncoding("utf-8");
          }

          if (
            this.opt.certExpired &&
            authorizationError === "CERT_HAS_EXPIRED"
          ) {
            console.info("Connecting to server with expired certificate");
          }

          this._connectionHandler();
        } else {
          // authorization failed
          console.error(authorizationError);
        }
      });
    } else {
      this.conn = createConnection(
        connectionOpts,
        this._connectionHandler.bind(this)
      );
    }
    this.conn.requestedDisconnect = false;
    this.conn.setTimeout(0);

    // Each connection gets its own CyclingPingTimer. The connection forwards the timer's 'timeout' and 'wantPing' events
    // to the client object via calling the connectionTimedOut() and connectionWantsPing() functions.
    //
    // Since the client's "current connection" value changes over time because of retry functionality,
    // the client should ignore timeout/wantPing events that come from old connections.
    this.conn.cyclingPingTimer = new CyclingPingTimer(this);

    this.conn.cyclingPingTimer!.on("pingTimeout", () => {
      this.connectionTimedOut(this.conn);
    });
    this.conn.cyclingPingTimer.on("wantPing", () => {
      this.connectionWantsPing(this.conn);
    });

    if (!this.opt.encoding) {
      this.conn.setEncoding("utf8");
    }

    var buffer = new Buffer("");

    const handleData = (chunk) => {
      this.conn!.cyclingPingTimer!.notifyOfActivity();

      if (typeof chunk === "string") {
        (buffer as any) += chunk;
      } else {
        buffer = Buffer.concat([buffer, chunk]);
      }

      var lines = this.convertEncoding(buffer).toString().split(lineDelimiter);

      if (lines.pop()) {
        // if buffer is not ended with \r\n, there's more chunks.
        return;
      } else {
        // else, initialize the buffer.
        buffer = new Buffer("");
      }

      lines.forEach((line) => {
        if (line.length) {
          var message = parseMessage(line, this.opt.stripColors);

          try {
            this.emit("raw", message);
          } catch (err) {
            if (!this.conn!.requestedDisconnect) {
              throw err;
            }
          }
        }
      });
    };

    this.conn.addListener("data", handleData);
    this.conn.addListener("end", () => {
      if (this.opt.debug) console.info('Connection got "end" event');
    });
    this.conn.addListener("close", () => {
      if (this.opt.debug) console.info('Connection got "close" event');

      if (this.conn && this.conn.requestedDisconnect) return;
      if (this.opt.debug) console.info("Disconnected: reconnecting");
      if (this.opt.retryCount !== null && retryCount >= this.opt.retryCount) {
        if (this.opt.debug) {
          console.info(
            "Maximum retry count (" +
              this.opt.retryCount +
              ") reached. Aborting"
          );
        }
        this.emit("abort", this.opt.retryCount);
        return;
      }

      if (this.opt.debug) {
        console.info("Waiting " + this.opt.retryDelay + "ms before retrying");
      }
      setTimeout(() => {
        this.connect(retryCount + 1);
      }, this.opt.retryDelay);
    });
    this.conn.addListener("error", (exception) => {
      this.emit("netError", exception);
      if (this.opt.debug) {
        console.info("Network error: " + exception);
      }
    });
  }

  end() {
    if (this.conn) {
      this.conn.cyclingPingTimer!.stop();
      this.conn.destroy();
    }
    this.conn = null;
  }

  disconnect(message, callback) {
    if (typeof message === "function") {
      callback = message;
      message = undefined;
    }
    message = message || "node-irc says goodbye";

    if (this.conn!.readyState == "open") {
      var sendFunction;
      if (this.opt.floodProtection) {
        sendFunction = this._sendImmediate;
        this._clearCmdQueue();
      } else {
        sendFunction = this.send;
      }
      sendFunction.call(this, "QUIT", message);
    }
    this.conn!.requestedDisconnect = true;
    if (typeof callback === "function") {
      this.conn!.once("end", callback);
    }
    this.conn!.end();
  }

  send(...args: [string, ...string[]]) {
    if (
      args[args.length - 1].match(/\s/) ||
      args[args.length - 1].match(/^:/) ||
      args[args.length - 1] === ""
    ) {
      args[args.length - 1] = ":" + args[args.length - 1];
    }

    if (this.opt.debug) console.info("SEND: " + args.join(" "));

    if (!(this.conn as any).requestedDisconnect) {
      this.conn!.write(args.join(" ") + "\r\n");
    }
  }

  _sendImmediate = () => {};
  _clearCmdQueue = () => {};

  activateFloodProtection(interval?: number) {
    var cmdQueue: string[][] = [];
    var safeInterval = interval ?? this.opt.floodProtectionDelay;
    var origSend = this.send;
    var dequeue;

    // Wrapper for the original function. Just put everything to on central
    // queue.
    this.send = (...args) => {
      cmdQueue.push(args);
    };

    this._sendImmediate = () => {
      origSend.apply(this, arguments);
    };

    this._clearCmdQueue = () => {
      cmdQueue = [];
    };

    dequeue = () => {
      var args = cmdQueue.shift();
      if (args) {
        origSend.apply(this, args);
      }
    };

    // Slowly unpack the queue without flooding.
    setInterval(dequeue, safeInterval);
    dequeue();
  }

  join(channel, callback) {
    var channelName = channel.split(" ")[0];
    this.once("join" + channelName, () => {
      // if join is successful, add this channel to opts.channels
      // so that it will be re-joined upon reconnect (as channels
      // specified in options are)
      if (this.opt.channels.indexOf(channel) == -1) {
        this.opt.channels.push(channel);
      }

      if (typeof callback == "function") {
        return callback.apply(this, arguments);
      }
    });
    this.send.apply(this, ["JOIN"].concat(channel.split(" ")));
  }

  part(channel, message, callback) {
    if (typeof message === "function") {
      callback = message;
      message = undefined;
    }
    if (typeof callback == "function") {
      this.once("part" + channel, callback);
    }

    // remove this channel from this.opt.channels so we won't rejoin
    // upon reconnect
    if (this.opt.channels.indexOf(channel) != -1) {
      this.opt.channels.splice(this.opt.channels.indexOf(channel), 1);
    }

    if (message) {
      this.send("PART", channel, message);
    } else {
      this.send("PART", channel);
    }
  }

  action(channel, text) {
    if (typeof text !== "undefined") {
      text
        .toString()
        .split(/\r?\n/)
        .filter((line) => line.length > 0)
        .forEach((line) => {
          this.say(channel, "\u0001ACTION " + line + "\u0001");
        });
    }
  }

  _splitLongLines(words, maxLength, destination) {
    maxLength = maxLength || 450; // If maxLength hasn't been initialized yet, prefer an arbitrarily low line length over crashing.
    if (words.length == 0) {
      return destination;
    }
    if (words.length <= maxLength) {
      destination.push(words);
      return destination;
    }
    var c = words[maxLength];
    var cutPos;
    var wsLength = 1;
    if (c.match(/\s/)) {
      cutPos = maxLength;
    } else {
      var offset = 1;
      while (maxLength - offset > 0) {
        var c = words[maxLength - offset];
        if (c.match(/\s/)) {
          cutPos = maxLength - offset;
          break;
        }
        offset++;
      }
      if (maxLength - offset <= 0) {
        cutPos = maxLength;
        wsLength = 0;
      }
    }
    var part = words.substring(0, cutPos);
    destination.push(part);
    return this._splitLongLines(
      words.substring(cutPos + wsLength, words.length),
      maxLength,
      destination
    );
  }

  say(target, text) {
    this._speak("PRIVMSG", target, text);
  }

  notice(target, text) {
    this._speak("NOTICE", target, text);
  }

  _speak(kind, target, text) {
    var maxLength = Math.min(
      this.maxLineLength - target.length,
      this.opt.messageSplit
    );
    if (typeof text !== "undefined") {
      text
        .toString()
        .split(/\r?\n/)
        .filter((line) => line.length > 0)
        .forEach((line) => {
          var linesToSend = this._splitLongLines(line, maxLength, []);
          linesToSend.forEach((toSend) => {
            this.send(kind, target, toSend);
            if (kind == "PRIVMSG") {
              this.emit("selfMessage", target, toSend);
            }
          });
        });
    }
  }

  whois(nick, callback) {
    if (typeof callback === "function") {
      var callbackWrapper = (info) => {
        if (info.nick.toLowerCase() == nick.toLowerCase()) {
          this.removeListener("whois", callbackWrapper);
          return callback.apply(this, arguments);
        }
      };
      this.addListener("whois", callbackWrapper);
    }
    this.send("WHOIS", nick);
  }

  list() {
    var args = Array.prototype.slice.call(arguments, 0);
    args.unshift("LIST");
    this.send.apply(this, args);
  }

  _addWhoisData(nick: string, key, value, onlyIfExists?: boolean) {
    if (onlyIfExists && !this._whoisData[nick]) return;
    this._whoisData[nick] = this._whoisData[nick] || { nick: nick };
    this._whoisData[nick][key] = value;
  }

  _clearWhoisData(nick: string) {
    // Ensure that at least the nick exists before trying to return
    this._addWhoisData(nick, "nick", nick);
    var data = this._whoisData[nick];
    delete this._whoisData[nick];
    return data;
  }

  _handleCTCP(from, to, text, type, message) {
    text = text.slice(1);
    text = text.slice(0, text.indexOf("\u0001"));
    var parts = text.split(" ");
    this.emit("ctcp", from, to, text, type, message);
    this.emit("ctcp-" + type, from, to, text, message);
    if (type === "privmsg" && text === "VERSION")
      this.emit("ctcp-version", from, to, message);
    if (parts[0] === "ACTION" && parts.length > 1)
      this.emit("action", from, to, parts.slice(1).join(" "), message);
    if (parts[0] === "PING" && type === "privmsg" && parts.length > 1)
      this.ctcp(from, "notice", text);
  }

  ctcp(to, type, text) {
    return this[type === "privmsg" ? "say" : "notice"](
      to,
      "\u0001" + text + "\u0001"
    );
  }

  convertEncoding(str) {
    var out = str;

    if (this.opt.encoding) {
      try {
        var charsetDetector = require("node-icu-charset-detector");
        var Iconv = require("iconv").Iconv;
        var charset = charsetDetector.detectCharset(str);
        var converter = new Iconv(charset.toString(), this.opt.encoding);

        out = converter.convert(str);
      } catch (err) {
        if (this.opt.debug) {
          console.info("\u001b[01;31mERROR: " + err + "\u001b[0m");
          inspect({ str: str, charset: charset });
        }
      }
    }

    return out;
  }
  // blatantly stolen from irssi's splitlong.pl. Thanks, Bjoern Krombholz!
  _updateMaxLineLength() {
    // 497 = 510 - (":" + "!" + " PRIVMSG " + " :").length;
    // target is determined in _speak() and subtracted there
    this.maxLineLength = 497 - this.nick.length - this.hostMask.length;
  }
}
