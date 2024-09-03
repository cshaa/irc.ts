# @csha/irc
A modernized fork of [`npm:irc`](https://www.npmjs.com/package/irc).

```ts
import { Client } from "@csha/irc";

const client = new Client("irc.libera.chat", "my-irc-bot", {
  channels: ["#my-irc-bot-test"],
});

client.addListener("message", (from: string, to: string, message: string) => {
  console.log(from + " => " + to + ": " + message);
  client.say(to, "I'm a bot!");
});

client.addListener("pm", (from: string, message: string) => {
  console.log(from + " => ME: " + message);
  client.say("csha", "I'm a bot!");
});
```
