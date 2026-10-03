import { readFile, rename, writeFile } from "node:fs/promises";
import type { Suggestion } from "./ai/types";

export class PendingSuggestions extends Map<string, Suggestion[]> {
  private writes: Promise<void> = Promise.resolve();
  private writeError: unknown = null;
  private loadError: unknown = null;
  constructor(private readonly path: string, private readonly onError: (error: unknown) => void) { super(); }

  async load(): Promise<void> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, "utf8"));
      if (!Array.isArray(parsed)) throw new Error("待確認建議格式錯誤");
      const entries: Array<[string, Suggestion[]]> = [];
      for (const item of parsed as unknown[]) {
        if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== "string" || !Array.isArray(item[1])) throw new Error("待確認建議欄位格式錯誤；保留原檔並停止寫入");
        const suggestions = (item[1] as unknown[]).filter((value): value is Suggestion => {
          if (!value || typeof value !== "object") return false;
          const suggestion = value as Record<string, unknown>;
          return typeof suggestion.title === "string" && typeof suggestion.task === "string" && typeof suggestion.contribution === "string" && (suggestion.parentTitle === undefined || typeof suggestion.parentTitle === "string") && (suggestion.thinkingOriginBaseline === undefined || typeof suggestion.thinkingOriginBaseline === "string");
        });
        if (suggestions.length !== item[1].length) throw new Error("待確認建議欄位格式錯誤；保留原檔並停止寫入");
        entries.push([item[0], suggestions]);
      }
      for (const [key, suggestions] of entries) if (suggestions.length) super.set(key, suggestions);
      this.loadError = null;
    } catch (error: unknown) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) { this.loadError = error; this.onError(error); }
    }
  }

  override set(key: string, value: Suggestion[]): this { super.set(key, value); this.save(); return this; }
  override delete(key: string): boolean { const removed = super.delete(key); if (removed) this.save(); return removed; }
  override clear(): void { if (!this.size) return; super.clear(); this.save(); }
  async flush(): Promise<void> { await this.writes; if (this.writeError) throw this.writeError instanceof Error ? this.writeError : new Error("待確認建議儲存失敗"); }
  private save(): void {
    if (this.loadError) { this.writeError = this.loadError; this.onError(this.loadError); return; }
    const snapshot = JSON.stringify([...this.entries()]);
    this.writes = this.writes.then(async () => {
      const temporary = `${this.path}.tmp`;
      await writeFile(temporary, snapshot, { mode: 0o600 });
      await rename(temporary, this.path);
    }).then(() => { this.writeError = null; }, error => { this.writeError = error; this.onError(error); });
  }
}
