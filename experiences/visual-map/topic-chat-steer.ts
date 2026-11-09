import type { ResearchSteer, SteerSender } from "../../ai/research-observer";

/** Where one addition typed while a topic-chat task runs is: not handed over, being handed over, taken in, or waiting for the end. */
export type TopicSteerState = "pending" | "sending" | "delivered" | "queued";

export interface TopicSteerEntry {
  text: string;
  state: TopicSteerState;
}

/** What the window shows for an addition: "live" went (or is going) into the running task, "queued" waits for the reply to end. */
export interface TopicSteerView {
  text: string;
  state: "live" | "queued";
}

export interface TopicChatSteersOptions {
  /** Called after any entry changes state, so the window can repaint. */
  onChange?: () => void;
  /** False once the owner (view or map) is gone: a late answer then changes nothing. */
  alive?: () => boolean;
}

/**
 * The additions of one running topic-chat task (pure class, no DOM). Every addition is in exactly one state of `entries`;
 * hand-overs run one after the other so additions go in as typed. Delivered means the handler resolved; any reject is
 * "not taken in" and the addition waits (queued). A new attempt drops the handler and what the old one took is handed over
 * again, once, to the new one; an answer from an older handler never changes anything (gen fence).
 */
export class TopicChatSteers implements ResearchSteer {
  readonly entries: TopicSteerEntry[] = [];
  private handler: SteerSender | null = null;
  private gen = 0;
  private chain: Promise<void> = Promise.resolve();
  private noLive = false;
  private closed = false;

  constructor(private readonly options: TopicChatSteersOptions = {}) {}

  /** Takes an addition; returns its entry. After `close` or on a run that cannot take one it waits (queued) at once. */
  add(text: string): TopicSteerEntry {
    const entry: TopicSteerEntry = { text, state: this.closed || this.noLive ? "queued" : "pending" };
    this.entries.push(entry);
    this.changed();
    this.pump();
    return entry;
  }

  /** `null`: a new attempt starts, the old handler and every answer still on its way are dropped. A function: the new attempt's way in. */
  bind(send: SteerSender | null): void {
    if (this.closed || !this.isAlive()) return;
    this.gen++;
    this.chain = Promise.resolve();
    this.handler = send;
    // What the earlier attempt took, or was taking, is not in this one: hand it over again (once) when there is a way in.
    for (const entry of this.entries)
      if (entry.state === "sending" || entry.state === "delivered") entry.state = "pending";
    this.changed();
    this.pump();
  }

  live(on: boolean): void {
    this.setLive(on);
  }

  /** `false`: the request cannot take an addition as it runs; everything not queued yet waits for the end. */
  setLive(on: boolean): void {
    if (this.closed || !this.isAlive()) return;
    this.noLive = !on;
    if (on) return;
    this.gen++;
    this.handler = null;
    for (const entry of this.entries) if (entry.state !== "queued") entry.state = "queued";
    this.changed();
  }

  /** The reply is in: hand-overs still running settle, then what has not gone in waits. Later additions are queued. */
  async close(): Promise<void> {
    await this.chain;
    this.closed = true;
    for (const entry of this.entries) if (entry.state !== "delivered") entry.state = "queued";
    this.handler = null;
    this.changed();
  }

  /** The texts of the additions the task took in, in typed order (what a request or record should carry). */
  delivered(): string[] {
    return this.entries.filter(entry => entry.state === "delivered").map(entry => entry.text);
  }

  /** Removes and returns the waiting additions, in typed order. */
  takeQueued(): string[] {
    const texts = this.entries.filter(entry => entry.state === "queued").map(entry => entry.text);
    if (!texts.length) return texts;
    this.entries.splice(0, this.entries.length, ...this.entries.filter(entry => entry.state !== "queued"));
    this.changed();
    return texts;
  }

  /** What the window shows, in typed order. */
  views(): TopicSteerView[] {
    return this.entries.map(entry => ({ text: entry.text, state: entry.state === "queued" ? "queued" : "live" }));
  }

  private isAlive(): boolean {
    return this.options.alive ? this.options.alive() : true;
  }

  private changed(): void {
    this.options.onChange?.();
  }

  private pump(): void {
    const handler = this.handler;
    if (!handler || this.noLive || this.closed) return;
    const gen = this.gen;
    for (const entry of this.entries) {
      if (entry.state !== "pending") continue;
      entry.state = "sending";
      this.chain = this.chain.then(async () => {
        const current = (): boolean => gen === this.gen && entry.state === "sending" && this.isAlive();
        if (!current()) return;
        try {
          await handler(entry.text);
        } catch {
          if (!current()) return;
          entry.state = "queued";
          this.changed();
          return;
        }
        if (!current()) return;
        entry.state = "delivered";
        this.changed();
      });
    }
    this.changed();
  }
}
