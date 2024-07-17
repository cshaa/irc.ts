import { EventEmitter } from "node:events";
import type { Client } from "./irc";
let nextTimerId = 0;

/**
 * This class encapsulates the ping timeout functionality. When enough
 * silence (lack of server-sent activity) time passes, an object of this type
 * will emit a 'wantPing' event, indicating you should send a PING message
 * to the server in order to get some signs of life from it. If enough
 * time passes after that (i.e. server does not respond to PING), then
 * an object of this type will emit a 'pingTimeout' event.
 *
 * To start the gears turning, call start() on an instance of this class To
 * put it in the 'started' state.
 *
 * When server-side activity occurs, call notifyOfActivity() on the object.
 *
 * When a pingTimeout occurs, the object will go into the 'stopped' state.
 */
export class CyclingPingTimer extends EventEmitter {
  private started = false;
  private readonly timerId = nextTimerId++;

  // Only one of these two should be running at any given time.
  private loopingTimeout: NodeJS.Timeout | undefined;
  private pingWaitTimeout: NodeJS.Timeout | undefined;

  /** conditionally log debug messages */
  private debug(msg: string) {
    if (this.client.opt.debug) {
      console.error("CyclingPingTimer " + this.timerId + ": " + msg);
    }
  }

  constructor(private client: Client) {
    super();

    this.on("wantPing", () => {
      this.debug("server silent for too long, let's send a PING");
      this.pingWaitTimeout = setTimeout(() => {
        this.stop();
        this.debug("ping timeout!");
        this.emit("pingTimeout");
      }, client.opt.millisecondsBeforePingTimeout);
    });
  }

  notifyOfActivity() {
    if (this.started) {
      this.stop();
      this.start();
    }
  }

  stop() {
    if (!this.started) {
      return;
    }
    this.started = false;

    clearTimeout(this.loopingTimeout);
    clearTimeout(this.pingWaitTimeout);

    this.loopingTimeout = undefined;
    this.pingWaitTimeout = undefined;
  }

  start() {
    if (this.started) {
      this.debug("can't start, not stopped!");
      return;
    }
    this.started = true;

    this.loopingTimeout = setTimeout(() => {
      this.loopingTimeout = undefined;
      this.emit("wantPing");
    }, this.client.opt.millisecondsOfSilenceBeforePingSent);
  }
}
