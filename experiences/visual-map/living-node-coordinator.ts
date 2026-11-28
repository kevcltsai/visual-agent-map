/** Shared per-vault coordinator. A formal round owns all of its potential target paths until settlement. */
export interface LivingLease {
  readonly signal: AbortSignal;
  current(): boolean;
  stop(): void;
  release(): void;
}

interface ActiveLease {
  mapId: string;
  viewSession: string;
  paths: Set<string>;
  controller: AbortController;
  formal: boolean;
}

/** Progress of one formal run on a map, shared by every view that shows the map. */
export type LivingRunEvent =
  /** `total` counts only the cards to process (`queued`); `excluded` (blocked before the start, locked) settle at once, outside it. */
  | { kind: "start"; total: number; excluded: readonly string[]; queued: readonly string[] }
  | { kind: "running"; id: string }
  | { kind: "settled"; id: string; result: string }
  | { kind: "failure"; id: string; reason: string }
  /** Trial cards are an execution boundary: `frozen` valid ones are used as-is, `blocked` ones block their dependents. */
  | { kind: "trial"; skipped: string[]; frozen: string[]; blocked: string[] }
  | { kind: "done"; error?: boolean };

/**
 * One formal run per map. A view or a second Run on the same map subscribes instead of starting another.
 * Any subscriber may cancel; leaving only unsubscribes, and the last one to leave cancels.
 */
export class LivingRun {
  readonly controller = new AbortController();
  private readonly events: LivingRunEvent[] = [];
  private readonly subscribers = new Set<(event: LivingRunEvent) => void>();
  private ended = false;

  constructor(private readonly onEnd: () => void) {}

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  emit(event: LivingRunEvent): void {
    if (this.ended) return;
    if (event.kind === "done") this.ended = true;
    else this.events.push(event);
    for (const subscriber of [...this.subscribers]) {
      try {
        subscriber(event);
      } catch {
        // One view's repaint failure cannot affect the run or the other views.
      }
    }
    if (this.ended) this.onEnd();
  }

  /** Replays what already happened, then follows the run. Returns the leave function. */
  subscribe(subscriber: (event: LivingRunEvent) => void): () => void {
    this.subscribers.add(subscriber);
    for (const event of [...this.events]) subscriber(event);
    return () => {
      if (!this.subscribers.delete(subscriber)) return;
      if (!this.subscribers.size && !this.ended) this.controller.abort();
    };
  }

  cancel(): void {
    this.controller.abort();
  }
}

export class LivingCoordinator {
  private readonly runs = new Map<string, LivingRun>();
  private readonly active = new Set<ActiveLease>();
  private readonly byPath = new Map<string, ActiveLease>();
  private readonly formalByMap = new Map<string, ActiveLease>();
  private closed = false;

  acquire(mapId: string, viewSession: string, paths: readonly string[], formal: boolean): LivingLease | undefined {
    const unique = new Set(paths);
    if (
      this.closed ||
      !mapId ||
      !viewSession ||
      !unique.size ||
      [...unique].some(path => !path || this.byPath.has(path)) ||
      (formal && this.formalByMap.has(mapId))
    )
      return undefined;
    const entry = { mapId, viewSession, paths: unique, controller: new AbortController(), formal };
    this.active.add(entry);
    for (const path of unique) this.byPath.set(path, entry);
    if (formal) this.formalByMap.set(mapId, entry);
    return {
      signal: entry.controller.signal,
      current: () => !entry.controller.signal.aborted && this.active.has(entry) && !this.closed,
      stop: () => entry.controller.abort(),
      release: () => this.release(entry)
    };
  }

  busy(path: string): boolean {
    return this.byPath.has(path);
  }

  /** A trial (non-formal) lease holds the path: the card is an execution boundary for Run All. */
  trialBusy(path: string): boolean {
    const entry = this.byPath.get(path);
    return !!entry && !entry.formal;
  }

  formalBusy(path: string): boolean {
    return this.byPath.get(path)?.formal === true;
  }

  runOf(mapPath: string): LivingRun | undefined {
    return this.runs.get(mapPath);
  }

  /** Registers the formal run of a map; undefined when one is already running there. */
  beginRun(mapPath: string): LivingRun | undefined {
    if (this.closed || !mapPath || this.runs.has(mapPath)) return undefined;
    const run: LivingRun = new LivingRun(() => {
      if (this.runs.get(mapPath) === run) this.runs.delete(mapPath);
    });
    this.runs.set(mapPath, run);
    return run;
  }

  stopView(viewSession: string): void {
    for (const entry of this.active) if (entry.viewSession === viewSession) entry.controller.abort();
  }

  unload(): void {
    this.closed = true;
    for (const run of this.runs.values()) run.cancel();
    for (const entry of this.active) entry.controller.abort();
  }

  private release(entry: ActiveLease): void {
    if (!this.active.delete(entry)) return;
    entry.controller.abort();
    for (const path of entry.paths) if (this.byPath.get(path) === entry) this.byPath.delete(path);
    if (entry.formal && this.formalByMap.get(entry.mapId) === entry) this.formalByMap.delete(entry.mapId);
  }
}
