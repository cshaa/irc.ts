import { replyFor } from "./codes.ts";
import { stripColorsAndStyle } from "./color-utils.ts";
import type { IMessage } from "./types.ts";

/**
 * parseMessage(line, stripColors)
 *
 * takes a raw "line" from the IRC server and turns it into an object with
 * useful keys
 * @param line Raw message from IRC server.
 * @param stripColors If true, strip IRC colors.
 * @return A parsed message object.
 */
export function parseMessage(line: string, stripColors: boolean) {
  const message: Partial<IMessage> = {};

  if (stripColors) {
    line = stripColorsAndStyle(line);
  }

  // Parse prefix
  const [_a, prefix] = line.match(/^:([^ ]+) +/) ?? [undefined];
  if (prefix !== undefined) {
    message.prefix = prefix;
    line = line.replace(/^:[^ ]+ +/, "");
    const [_, nick, user, host] = message.prefix!.match(
      /^([_a-zA-Z0-9\~\[\]\\`^{}|-]*)(!([^@]+)@(.*))?$/
    ) ?? [undefined];
    if (nick !== undefined) {
      message.nick = nick;
      message.user = user;
      message.host = host;
    } else {
      message.server = message.prefix;
    }
  }

  // Parse command
  const [_b, command] = line.match(/^([^ ]+) */)!;
  message.command = command;
  message.rawCommand = command;
  message.commandType = "normal";
  line = line.replace(/^[^ ]+ +/, "");

  if (replyFor[message.rawCommand!]) {
    message.command = replyFor[message.rawCommand!].name;
    message.commandType = replyFor[message.rawCommand!].type;
  }

  message.args = [];

  // Parse parameters
  const [_c, middle, trailing] =
    line.search(/^:|\s+:/) !== -1
      ? line.match(/(.*?)(?:^:|\s+:)(.*)/)!
      : [undefined, line, undefined];

  if (middle) message.args = middle.split(/ +/);
  if (trailing) message.args.push(trailing);

  return message;
}
