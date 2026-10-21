import { readStoreText, writeStoreAtomically, type StoreAdapter } from "./store-adapter";
import type { Suggestion } from "./ai/types";
import { t } from "./i18n";

export class PendingSuggestions extends Map<string, Suggestion[]> {
  private writes: Promise<void> = Promise.resolve();
  private writeError: unknown = null;
  private loadError: unknown = null;
  constructor(
    private readonly adapter: StoreAdapter,
    private readonly path: string,
    private readonly onError: (error: unknown) => void
  ) {
    super();
  }

  async load(): Promise<void> {
    try {
      const text = await readStoreText(this.adapter, this.path);
      if (text === null) return;
      const parsed: unknown = JSON.parse(text);
      if (!Array.isArray(parsed)) throw new Error(t("error.pending_suggestions_invalid"));
      const entries: Array<[string, Suggestion[]]> = [];
      for (const item of parsed as unknown[]) {
        if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== "string" || !Array.isArray(item[1]))
          throw new Error(t("error.pending_suggestions_fields_invalid"));
        const suggestions = (item[1] as unknown[]).filter((value): value is Suggestion => {
          if (!value || typeof value !== "object") return false;
          const suggestion = value as Record<string, unknown>;
          return (
            typeof suggestion.title === "string" &&
            typeof suggestion.task === "string" &&
            typeof suggestion.contribution === "string" &&
            (suggestion.parentTitle === undefined || typeof suggestion.parentTitle === "string") &&
            (suggestion.thinkingOriginBaseline === undefined || typeof suggestion.thinkingOriginBaseline === "string")
          );
        });
        if (suggestions.length !== item[1].length) throw new Error(t("error.pending_suggestions_fields_invalid"));
        entries.push([item[0], suggestions]);
      }
      for (const [key, suggestions] of entries) if (suggestions.length) super.set(key, suggestions);
      this.loadError = null;
    } catch (error: unknown) {
      this.loadError = error;
      this.onError(error);
    }
  }

  override set(key: string, value: Suggestion[]): this {
    super.set(key, value);
    this.save();
    return this;
  }
  override delete(key: string): boolean {
    const removed = super.delete(key);
    if (removed) this.save();
    return removed;
  }
  override clear(): void {
    if (!this.size) return;
    super.clear();
    this.save();
  }
  async flush(): Promise<void> {
    await this.writes;
    if (this.writeError)
      throw this.writeError instanceof Error ? this.writeError : new Error(t("error.pending_suggestions_save_failed"));
  }
  private save(): void {
    if (this.loadError) {
      this.writeError = this.loadError;
      this.onError(this.loadError);
      return;
    }
    const snapshot = JSON.stringify([...this.entries()]);
    this.writes = this.writes
      .then(() => writeStoreAtomically(this.adapter, this.path, snapshot))
      .then(
        () => {
          this.writeError = null;
        },
        error => {
          this.writeError = error;
          this.onError(error);
        }
      );
  }
}
