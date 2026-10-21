// Plugin-level progress store for in-flight research, keyed by note path. No DOM; views subscribe and re-read via get().
export type ResearchStage = "waiting" | "searching" | "reading" | "writing" | "charts";
export interface ResearchPreview {
  summary?: string;
  detailTail?: string;
}
export interface ResearchProgress {
  attemptId: string;
  startedAt: number;
  stage: ResearchStage;
  stageAt: number;
  query?: string;
  slow: boolean;
  preview?: ResearchPreview;
}
export interface ResearchProgressClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}
export const PREVIEW_THROTTLE_MS = 200;
export const DETAIL_TAIL_CHARS = 600;
const realClock: ResearchProgressClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => window.setTimeout(callback, ms),
  clearTimeout: handle => window.clearTimeout(handle as number)
};

export class ResearchProgressStore {
  private entries = new Map<string, ResearchProgress>();
  private listeners = new Set<(path: string) => void>();
  private lastNotified = new Map<string, number>();
  private pending = new Map<string, unknown>();
  constructor(private clock: ResearchProgressClock = realClock) {}

  begin(path: string, attemptId: string, now: number): void {
    this.cancelPending(path);
    this.entries.set(path, { attemptId, startedAt: now, stage: "waiting", stageAt: now, slow: false });
    this.notify(path);
  }
  stage(path: string, attemptId: string, stage: ResearchStage, now: number, query?: string): void {
    const entry = this.current(path, attemptId);
    if (!entry) return;
    entry.stage = stage;
    entry.stageAt = now;
    if (query !== undefined) entry.query = query;
    else if (stage !== "searching") delete entry.query;
    this.notify(path);
  }
  markSlow(path: string, attemptId: string, slow: boolean): void {
    const entry = this.current(path, attemptId);
    if (!entry || entry.slow === slow) return;
    entry.slow = slow;
    this.notify(path);
  }
  preview(path: string, attemptId: string, fields: { summary?: string; detail?: string }): void {
    const entry = this.current(path, attemptId);
    if (!entry) return;
    const summary = fields.summary || undefined;
    const detail = fields.detail || undefined;
    if (summary === undefined && detail === undefined) {
      if (!entry.preview) return;
      delete entry.preview;
      this.notify(path);
      return;
    }
    const preview: ResearchPreview = {};
    if (summary !== undefined) preview.summary = summary;
    if (detail !== undefined)
      preview.detailTail = detail.length > DETAIL_TAIL_CHARS ? detail.slice(-DETAIL_TAIL_CHARS) : detail;
    entry.preview = preview;
    this.notifyThrottled(path);
  }
  newAttempt(path: string, attemptId: string, now: number): void {
    const entry = this.entries.get(path);
    if (!entry) return;
    this.cancelPending(path);
    entry.attemptId = attemptId;
    entry.stage = "waiting";
    entry.stageAt = now;
    entry.slow = false;
    delete entry.preview;
    delete entry.query;
    this.notify(path);
  }
  end(path: string): void {
    this.cancelPending(path);
    this.lastNotified.delete(path);
    if (!this.entries.delete(path)) return;
    for (const listener of [...this.listeners]) listener(path);
  }
  get(path: string): ResearchProgress | undefined {
    return this.entries.get(path);
  }
  subscribe(listener: (path: string) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) this.clearAllTimers();
    };
  }

  private current(path: string, attemptId: string) {
    const entry = this.entries.get(path);
    return entry && entry.attemptId === attemptId ? entry : undefined;
  }
  private cancelPending(path: string) {
    const handle = this.pending.get(path);
    if (handle === undefined) return;
    this.clock.clearTimeout(handle);
    this.pending.delete(path);
  }
  private clearAllTimers() {
    for (const path of [...this.pending.keys()]) this.cancelPending(path);
  }
  private notify(path: string) {
    this.cancelPending(path);
    this.lastNotified.set(path, this.clock.now());
    for (const listener of [...this.listeners]) listener(path);
  }
  private notifyThrottled(path: string) {
    if (this.pending.has(path)) return;
    const wait = (this.lastNotified.get(path) ?? -Infinity) + PREVIEW_THROTTLE_MS - this.clock.now();
    if (wait <= 0) {
      this.notify(path);
      return;
    }
    this.pending.set(
      path,
      this.clock.setTimeout(() => {
        this.pending.delete(path);
        if (this.entries.has(path)) this.notify(path);
      }, wait)
    );
  }
}
