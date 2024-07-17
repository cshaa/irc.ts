import { replyFor } from "./codes";
import { stripColorsAndStyle } from "./color-utils";
import type { IMessage } from "./irc";

/**
 * parseMessage(line, stripColors)
 *
 * takes a raw "line" from the IRC server and turns it into an object with
 * useful keys
 * @param line Raw message from IRC server.
 * @param stripColors If true, strip IRC colors.
 * @return A parsed message object.
 */
export default function parseMessage(line: string, stripColors: boolean) {
  var message: Partial<IMessage> = {};
  var match;

  if (stripColors) {
    line = stripColorsAndStyle(line);
  }

  // Parse prefix
  match = line.match(/^:([^ ]+) +/);
  if (match) {
    message.prefix = match[1];
    line = line.replace(/^:[^ ]+ +/, "");
    match = message.prefix!.match(
      /^([_a-zA-Z0-9\~\[\]\\`^{}|-]*)(!([^@]+)@(.*))?$/
    );
    if (match) {
      message.nick = match[1];
      message.user = match[3];
      message.host = match[4];
    } else {
      message.server = message.prefix;
    }
  }

  // Parse command
  match = line.match(/^([^ ]+) */);
  message.command = match[1];
  message.rawCommand = match[1];
  message.commandType = "normal";
  line = line.replace(/^[^ ]+ +/, "");

  if (replyFor[message.rawCommand!]) {
    message.command = replyFor[message.rawCommand!].name;
    message.commandType = replyFor[message.rawCommand!].type;
  }

  message.args = [];
  var middle, trailing;

  // Parse parameters
  if (line.search(/^:|\s+:/) != -1) {
    match = line.match(/(.*?)(?:^:|\s+:)(.*)/);
    middle = match[1].trimRight();
    trailing = match[2];
  } else {
    middle = line;
  }

  if (middle.length) message.args = middle.split(/ +/);

  if (typeof trailing != "undefined" && trailing.length)
    message.args!.push(trailing);

  return message;
}
