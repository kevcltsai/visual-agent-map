/** The plugin-folder DataAdapter operations used for short-lived recovery snapshots. */
export interface RecoveryAdapter {
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  rename(path: string, target: string): Promise<void>;
  remove(path: string): Promise<void>;
  list(path: string): Promise<{ files: string[] }>;
}

interface RecoveryWrite {
  path(): string;
  read(): Promise<string>;
  process(change: (content: string) => string): Promise<string>;
  change(content: string): string;
  stopped(): boolean;
  stoppedError(): Error;
  conflictError(): Error;
  backupError(): Error;
}

/**
 * Preserve the exact preimage before an existing Markdown file is changed via Vault.process.
 * The journal is not a second authority and is never replayed automatically: a later user edit may be newer.
 * Only a read-back-verified snapshot is published; it is kept if the source write might have been interrupted.
 * This protects against a process interruption, not a power-loss durability guarantee (the adapter exposes no fsync).
 */
export class VaultWriteRecovery {
  constructor(
    private readonly adapter: RecoveryAdapter,
    readonly folder: string,
    private readonly retained: (path: string) => void,
    private readonly newId: () => string = () => crypto.randomUUID()
  ) {}

  /** The retained recovery files, as sorted file names inside the folder. */
  async pendingFiles(): Promise<string[]> {
    if (!(await this.adapter.exists(this.folder))) return [];
    const { files } = await this.adapter.list(this.folder);
    return files
      .filter(path => /\/[0-9a-f-]+\.(?:json|writing)$/i.test(path))
      .map(path => path.slice(path.lastIndexOf("/") + 1))
      .sort();
  }

  async pendingCount(): Promise<number> {
    return (await this.pendingFiles()).length;
  }

  /**
   * Whether the startup notice is due: only when the set of retained files differs from the set already reported.
   * `fingerprint` is the new value to remember (undefined when the folder is empty, so a later new file is reported again).
   */
  async unreported(reported: string | undefined): Promise<{ notify: boolean; fingerprint: string | undefined }> {
    const names = await this.pendingFiles();
    const fingerprint = names.length ? names.join("\n") : undefined;
    return { notify: fingerprint !== undefined && fingerprint !== reported, fingerprint };
  }

  async process(write: RecoveryWrite): Promise<string> {
    // Another writer may change the file between our snapshot and Vault.process. Take a fresh snapshot and retry,
    // so overlapping writers still apply on top of the latest content. Rename/delete and stop still refuse at once.
    for (let attempt = 1; ; attempt++) {
      const stale = { value: false };
      try {
        return await this.processOnce(write, stale);
      } catch (error) {
        if (!stale.value) throw error;
        if (attempt >= VaultWriteRecovery.MAX_ATTEMPTS) throw write.conflictError();
      }
    }
  }

  private static readonly MAX_ATTEMPTS = 3;

  private async processOnce(write: RecoveryWrite, stale: { value: boolean }): Promise<string> {
    const ensureActive = (): void => {
      if (write.stopped()) throw write.stoppedError();
    };
    ensureActive();
    const originalPath = write.path();
    const before = await write.read();
    ensureActive();
    if (write.path() !== originalPath) throw write.conflictError();
    const encoded = JSON.stringify({ version: 1, path: originalPath, content: before });
    const id = this.newId();
    const staging = `${this.folder}/${id}.writing`;
    const snapshot = `${this.folder}/${id}.json`;
    try {
      if (!(await this.adapter.exists(this.folder))) {
        ensureActive();
        try {
          await this.adapter.mkdir(this.folder);
        } catch (error) {
          if (!(await this.adapter.exists(this.folder))) throw error;
        }
      }
      if ((await this.adapter.exists(staging)) || (await this.adapter.exists(snapshot))) throw write.backupError();
      ensureActive();
      await this.adapter.write(staging, encoded);
      if ((await this.adapter.read(staging)) !== encoded) throw write.backupError();
      ensureActive();
      await this.adapter.rename(staging, snapshot);
    } catch {
      // No source write was attempted. Leave any recovery bytes for inspection, not silent overwrite.
      throw write.backupError();
    }

    let mayHaveWritten = false;
    let completed = false;
    try {
      ensureActive();
      const result = await write.process(current => {
        ensureActive();
        if (write.path() !== originalPath) throw write.conflictError();
        // Vault.read drops a leading BOM that the process callback still sees (see math-repair).
        if (current.replace(/^\uFEFF/, "") !== before.replace(/^\uFEFF/, "")) {
          stale.value = true;
          throw write.conflictError();
        }
        const next = write.change(current);
        // Even a no-op callback can be followed by a physical write in the host.
        mayHaveWritten = true;
        return next;
      });
      completed = true;
      return result;
    } finally {
      if (!write.stopped() && (completed || !mayHaveWritten)) {
        try {
          // Only remove our own unchanged snapshot. A user's change to a recovery file is not ours to delete.
          if ((await this.adapter.read(snapshot)) === encoded && !write.stopped()) {
            await this.adapter.remove(snapshot);
          } else {
            this.reportRetained(snapshot);
          }
        } catch {
          this.reportRetained(snapshot);
        }
      } else {
        this.reportRetained(snapshot);
      }
    }
  }

  private reportRetained(path: string): void {
    try {
      this.retained(path);
    } catch {
      // Diagnostic failure must never change the outcome of the source write.
    }
  }
}
