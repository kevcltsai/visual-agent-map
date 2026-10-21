/** The part of a child process the warm pool needs, so the pool is testable without spawning anything. */
export interface WarmProcess {
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "close", listener: (code: number | null, signal?: string | null) => void): unknown;
}
export interface WarmClock {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}
/** A warm process nobody asked for within this time is killed. */
export const WARM_IDLE_MS = 180_000;
const KILL_ESCALATION_MS = 1_500;
const realClock: WarmClock = {
  setTimeout: (callback, ms) => window.setTimeout(callback, ms),
  clearTimeout: handle => window.clearTimeout(handle as number)
};

interface Slot<T> {
  key: string;
  child: T;
  idleTimer: unknown;
  exited: boolean;
}

/**
 * At most one idle, already-started Claude CLI (stream-json input, nothing written yet). `take` hands it to a run only
 * when the run would have started the very same command; any other key kills it. Nothing here calls the model: the
 * process waits on stdin until a user message arrives.
 */
export class ClaudeWarmPool<T extends WarmProcess = WarmProcess> {
  private slot: Slot<T> | null = null;
  private readonly clock: WarmClock;
  private readonly idleMs: number;
  constructor(options: { clock?: WarmClock; idleMs?: number; onLog?: (message: string) => void } = {}) {
    this.clock = options.clock ?? realClock;
    this.idleMs = options.idleMs ?? WARM_IDLE_MS;
    this.onLog = options.onLog;
  }
  private readonly onLog?: (message: string) => void;

  /** True when a warm process is waiting. */
  get size(): number {
    return this.slot ? 1 : 0;
  }
  /** Starts a process for `key` unless one for the same key is already waiting (then only the idle time restarts). */
  prewarm(key: string, start: () => T): boolean {
    if (this.slot && this.slot.key === key && !this.slot.exited) {
      this.armIdle(this.slot);
      return true;
    }
    this.release();
    let child: T;
    try {
      child = start();
    } catch {
      return false;
    }
    const slot: Slot<T> = { key, child, idleTimer: undefined, exited: false };
    const drop = (): void => {
      slot.exited = true;
      this.clearIdle(slot);
      if (this.slot === slot) this.slot = null;
    };
    child.on("error", drop);
    child.on("close", drop);
    this.slot = slot;
    this.armIdle(slot);
    return true;
  }
  /** The waiting process if it was started for exactly `key`; a process for another key is killed and null returned. */
  take(key: string): T | null {
    const slot = this.slot;
    if (!slot) return null;
    if (slot.exited) {
      this.slot = null;
      return null;
    }
    if (slot.key !== key) {
      this.release();
      return null;
    }
    this.slot = null;
    this.clearIdle(slot);
    return slot.child;
  }
  /** Kills the waiting process (an unused dialog, Stop, unload, runtime reset). Safe to call at any time. */
  release(): void {
    const slot = this.slot;
    if (!slot) return;
    this.slot = null;
    this.clearIdle(slot);
    if (slot.exited) return;
    this.kill(slot);
  }
  private kill(slot: Slot<T>): void {
    try {
      slot.child.kill("SIGTERM");
    } catch {
      return;
    }
    // A process that ignores SIGTERM is killed for good, so none can outlive the plugin.
    const escalate = this.clock.setTimeout(() => {
      if (slot.exited) return;
      try {
        slot.child.kill("SIGKILL");
      } catch {
        /* Already gone. */
      }
    }, KILL_ESCALATION_MS);
    slot.child.on("close", () => this.clock.clearTimeout(escalate));
  }
  private armIdle(slot: Slot<T>): void {
    this.clearIdle(slot);
    slot.idleTimer = this.clock.setTimeout(() => {
      slot.idleTimer = undefined;
      if (this.slot === slot) {
        this.onLog?.("idle");
        this.release();
      }
    }, this.idleMs);
  }
  private clearIdle(slot: Slot<T>): void {
    if (slot.idleTimer === undefined) return;
    this.clock.clearTimeout(slot.idleTimer);
    slot.idleTimer = undefined;
  }
}
