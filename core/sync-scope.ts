/**
 * Which files an open map view still has to read back after VAM's own writes (perf ticket 04). Vault events that arrive
 * while a write runs are collected per view as `path → event number`; the end of each write reads a view back only when
 * one of its collected paths is its Map.md or one of its notes. Nothing here depends on the view or on Obsidian.
 */

/** Past this many paths a view stops listing them and reads its whole map back once (a "full" mark). */
export const UNSYNCED_LIMIT = 500;

/** What one read-back covers: the paths and their event numbers, and the full mark's number, when taken. */
export interface UnsyncedSnapshot {
  readonly paths: ReadonlyMap<string, number>;
  /** The event number of the full mark, or null without one. */
  readonly full: number | null;
}

export class UnsyncedPaths {
  private paths = new Map<string, number>();
  private full: number | null = null;

  /** A vault event for `path` with event number `seq` (numbers only grow). */
  add(path: string, seq: number): void {
    if (this.full !== null) {
      this.full = Math.max(this.full, seq);
      return;
    }
    this.paths.set(path, seq);
    if (this.paths.size > UNSYNCED_LIMIT) this.markFull(seq);
  }

  /** The next read-back reads the whole map; `seq` is the event number the mark belongs to. */
  markFull(seq: number): void {
    this.full = Math.max(this.full ?? seq, seq);
    this.paths.clear();
  }

  isEmpty(): boolean {
    return this.full === null && this.paths.size === 0;
  }

  snapshot(): UnsyncedSnapshot {
    return { paths: new Map(this.paths), full: this.full };
  }

  /**
   * A read-back of `snapshot` ended without throwing. Only what it covered is forgotten: a path (or the full mark) that
   * got a newer event meanwhile stays. A path whose read threw stays too, or comes back with `seq` (the event number when
   * the snapshot was taken) when the snapshot did not list it (an ancestor read for a child); this never moves a newer
   * number back.
   */
  settle(snapshot: UnsyncedSnapshot, failedPaths: Iterable<string>, seq: number): void {
    const failed = new Set(failedPaths);
    if (snapshot.full !== null && this.full === snapshot.full) this.full = null;
    for (const [path, at] of snapshot.paths)
      if (!failed.has(path) && this.paths.get(path) === at) this.paths.delete(path);
    for (const path of failed) {
      if (this.full !== null) break;
      if (!this.paths.has(path)) this.paths.set(path, seq);
    }
    if (this.paths.size > UNSYNCED_LIMIT) this.markFull(seq);
  }

  /** The view closed: nothing is read back for it any more. */
  clear(): void {
    this.paths.clear();
    this.full = null;
  }
}

/** Whether a read-back of `snapshot` has to read the map at `mapPath` with notes at `nodePaths`. */
export function needsReadBack(snapshot: UnsyncedSnapshot, mapPath: string, nodePaths: Iterable<string>): boolean {
  if (snapshot.full !== null) return true;
  if (!snapshot.paths.size) return false;
  if (snapshot.paths.has(mapPath)) return true;
  for (const path of nodePaths) if (snapshot.paths.has(path)) return true;
  return false;
}
