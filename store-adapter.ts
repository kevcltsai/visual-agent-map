/** The slice of Obsidian's `DataAdapter` the plugin-folder JSON stores need (paths are vault-relative and normalized). */
export interface StoreAdapter {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
  rename(path: string, newPath: string): Promise<void>;
  remove(path: string): Promise<void>;
  /** Optional: atomically overwrite `path` with `newPath` (the primary never disappears). Desktop file systems only. */
  replace?(path: string, newPath: string): Promise<void>;
}

/**
 * Decode the primary, or a recoverable temp snapshot. Validate before promoting the temp: older versions could
 * leave a partial first write there. A rejected snapshot stays untouched, and the caller fails closed.
 */
export async function readStoreValue<T>(
  adapter: StoreAdapter,
  path: string,
  decode: (text: string) => T
): Promise<T | null> {
  if (await adapter.exists(path)) return decode(await adapter.read(path));
  const temporary = `${path}.tmp`;
  if (!(await adapter.exists(temporary))) return null;
  const value = decode(await adapter.read(temporary));
  await adapter.rename(temporary, path);
  return value;
}

export async function readStoreText(adapter: StoreAdapter, path: string): Promise<string | null> {
  return readStoreValue(adapter, path, text => text);
}

/**
 * Writes `<path>.tmp` then renames it over `path`. Obsidian's `DataAdapter.rename` refuses an existing destination
 * (unlike `fs.rename`). When the adapter offers `replace` (desktop `fs.rename`, atomic overwrite) the primary never
 * disappears; otherwise the old file is removed first and a crash in that window is repaired by `readStoreValue`.
 */
export async function writeStoreAtomically(adapter: StoreAdapter, path: string, text: string): Promise<void> {
  const temporary = `${path}.tmp`;
  // A previous write may have removed the old file but failed to publish its complete temp file.
  // Recover that snapshot before a retry can truncate it. The primary still wins when both exist.
  if (!(await adapter.exists(path)) && (await adapter.exists(temporary))) {
    // The production callers also validate their schema on load. Never promote a torn legacy JSON temp on a retry.
    JSON.parse(await adapter.read(temporary));
    await adapter.rename(temporary, path);
  }
  if (await adapter.exists(path)) {
    await adapter.write(temporary, text);
    if (adapter.replace) {
      try {
        await adapter.replace(temporary, path);
        return;
      } catch {
        // The primary is untouched after a failed replace (e.g. a file lock on Windows): use the recoverable path below.
      }
    }
    await adapter.remove(path);
  } else {
    // A partially written first snapshot must not look like a recoverable temp.
    const staging = `${temporary}.writing`;
    await adapter.write(staging, text);
    await adapter.rename(staging, temporary);
  }
  await adapter.rename(temporary, path);
}

/**
 * A serial writer with at most one in-flight snapshot and one pending request.
 * The snapshot is encoded when the write begins, not for every queued state
 * change. The caller still owns all data and the existing atomic-write policy.
 */
export class LatestSnapshotWriter {
  private dirty = false;
  private running = false;
  private writes: Promise<void> = Promise.resolve();
  private notificationError: { error: unknown } | null = null;

  constructor(
    private readonly writeLatest: () => Promise<void>,
    private readonly report: (error: unknown) => void
  ) {}

  request(): void {
    this.dirty = true;
    if (this.running) return;
    this.running = true;
    this.writes = Promise.resolve().then(async () => {
      try {
        while (this.dirty) {
          this.dirty = false;
          try {
            await this.writeLatest();
            this.notificationError = null;
          } catch (error) {
            try {
              this.report(error);
            } catch (reportError) {
              // A failing diagnostic must not strand a newer pending snapshot.
              this.notificationError = { error: reportError };
            }
          }
        }
      } finally {
        this.running = false;
      }
    });
  }

  async flush(): Promise<void> {
    // A request made as the previous drain settles may start a new drain.
    for (;;) {
      const writes = this.writes;
      await writes;
      if (writes === this.writes) break;
    }
    if (this.notificationError) throw this.notificationError.error;
  }
}
