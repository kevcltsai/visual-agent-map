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

export class LivingCoordinator {
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

  stopView(viewSession: string): void {
    for (const entry of this.active) if (entry.viewSession === viewSession) entry.controller.abort();
  }

  unload(): void {
    this.closed = true;
    for (const entry of this.active) entry.controller.abort();
  }

  private release(entry: ActiveLease): void {
    if (!this.active.delete(entry)) return;
    entry.controller.abort();
    for (const path of entry.paths) if (this.byPath.get(path) === entry) this.byPath.delete(path);
    if (entry.formal && this.formalByMap.get(entry.mapId) === entry) this.formalByMap.delete(entry.mapId);
  }
}
