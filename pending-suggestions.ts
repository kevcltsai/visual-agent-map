import { readFile, rename, writeFile } from "node:fs/promises";
import type { Suggestion } from "./ai/types";

export class PendingSuggestions extends Map<string, Suggestion[]> {
  private writes: Promise<void> = Promise.resolve();
  private writeError: unknown = null;
  constructor(private readonly path: string, private readonly onError: (error: unknown) => void) { super(); }

  async load(): Promise<void> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, "utf8"));
      if (!Array.isArray(parsed)) throw new Error("待確認建議格式錯誤");
      for (const item of parsed as unknown[]) {
        if (!Array.isArray(item) || typeof item[0] !== "string" || !Array.isArray(item[1])) continue;
        const suggestions = (item[1] as unknown[]).filter((value): value is Suggestion => {
          if (!value || typeof value !== "object") return false;
          const suggestion = value as Record<string, unknown>;
          return typeof suggestion.title === "string" && typeof suggestion.task === "string" && typeof suggestion.contribution === "string";
        });
        if (suggestions.length) super.set(item[0], suggestions);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.onError(error);
    }
  }

  override set(key: string, value: Suggestion[]): this { super.set(key, value); this.save(); return this; }
  override delete(key: string): boolean { const removed = super.delete(key); if (removed) this.save(); return removed; }
  override clear(): void { if (!this.size) return; super.clear(); this.save(); }
  async flush(): Promise<void> { await this.writes; if (this.writeError) throw this.writeError instanceof Error ? this.writeError : new Error("待確認建議儲存失敗"); }
  private save(): void {
    const snapshot = JSON.stringify([...this.entries()]);
    this.writes = this.writes.then(async () => {
      const temporary = `${this.path}.tmp`;
      await writeFile(temporary, snapshot, { mode: 0o600 });
      await rename(temporary, this.path);
    }).then(() => { this.writeError = null; }, error => { this.writeError = error; this.onError(error); });
  }
}
