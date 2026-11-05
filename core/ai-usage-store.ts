import { readStoreText, writeStoreAtomically, type StoreAdapter } from "../store-adapter";
import { promptMetrics, type AiExchange } from "../ai-exchange-log";

/** What the user was doing when the model was called; anything the service cannot classify is "other". */
export type UsageAction = "research" | "expand" | "synthesize" | "writeback" | "other";
export const USAGE_ACTIONS: readonly UsageAction[] = ["research", "expand", "synthesize", "writeback", "other"];

export interface UsageTokens {
  inputTokens: number;
  outputTokens: number;
}

export type UsageProvider = "claude" | "codex";

/** Query sums: `estimated` is present (true) only when at least one summed row was counted from text, not reported. */
export type UsageSum = UsageTokens & { estimated?: true };

/** One provider call. `at` is an ISO instant; `estimated` is true when the tokens were counted from text, not reported. */
export interface UsageEntry extends UsageTokens {
  at: string;
  action: UsageAction;
  mapPath?: string;
  topic?: string;
  provider: UsageProvider;
  model: string;
  estimated: boolean;
  durationMs?: number;
}

/** A query answer: the value, or "unreadable" when `ai-usage.json` could not be read (never shown as zero). */
export type UsageQuery<T> = { status: "ready"; value: T } | { status: "unreadable" };

/** Details older than this are folded into `monthly`. */
export const USAGE_DETAIL_DAYS = 90;

type ActionTokens = Partial<Record<UsageAction, UsageTokens>>;
/** One month of folded-away details: per map path ("" = no map) and action. */
interface MonthlyBucket {
  maps: Record<string, ActionTokens>;
}
interface UsageFile {
  version: 1;
  entries: UsageEntry[];
  monthly: Record<string, MonthlyBucket>;
}

const ZERO = (): UsageTokens => ({ inputTokens: 0, outputTokens: 0 });
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const isTokens = (value: unknown): value is UsageTokens =>
  isRecord(value) && isCount(value.inputTokens) && isCount(value.outputTokens);
const isAction = (value: unknown): value is UsageAction => USAGE_ACTIONS.includes(value as UsageAction);

function isEntry(value: unknown): value is UsageEntry {
  if (!isRecord(value)) return false;
  return (
    typeof value.at === "string" &&
    !Number.isNaN(Date.parse(value.at)) &&
    isAction(value.action) &&
    (value.mapPath === undefined || typeof value.mapPath === "string") &&
    (value.topic === undefined || typeof value.topic === "string") &&
    (value.provider === "claude" || value.provider === "codex") &&
    typeof value.model === "string" &&
    isTokens(value) &&
    typeof value.estimated === "boolean" &&
    (value.durationMs === undefined || isCount(value.durationMs))
  );
}

function isBucket(value: unknown): value is MonthlyBucket {
  if (!isRecord(value) || !isRecord(value.maps)) return false;
  return Object.values(value.maps).every(
    actions => isRecord(actions) && Object.entries(actions).every(([key, tokens]) => isAction(key) && isTokens(tokens))
  );
}

/** Local-time midnight of the day containing `now` ("today" is the user's local day). */
export function localDayStart(now: number | Date = Date.now()): number {
  const date = new Date(now);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}
/** Local-time start of the month containing `now`. */
export function localMonthStart(now: number | Date = Date.now()): number {
  const date = new Date(now);
  return new Date(date.getFullYear(), date.getMonth(), 1).getTime();
}
const monthKey = (time: number): string => {
  const date = new Date(time);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
};
const monthStartOf = (key: string): number => {
  const [year, month] = key.split("-").map(Number);
  return new Date(year, month - 1, 1).getTime();
};

/**
 * Token estimate of a text, the same formula the AI exchange log prints for a prompt (ASCII 4 characters per token,
 * every other character one token). Used only when a provider reports no usage.
 */
export function estimateUsageTokens(text: string): number {
  return text ? promptMetrics({ prompt: text, request: "", mode: "" } as AiExchange).estimatedTokens : 0;
}

/**
 * Token usage of every provider call, in the plugin folder's `ai-usage.json`. Always on (independent of the AI
 * exchange log setting). Detail rows of the last {@link USAGE_DETAIL_DAYS} days plus per-month totals of older ones.
 * A file that cannot be parsed stays untouched, persistence stops, and every query answers "unreadable" (the same
 * protection the other JSON stores have). `record` never throws.
 */
export class AiUsageStore {
  private entries: UsageEntry[] = [];
  private monthly: Record<string, MonthlyBucket> = {};
  private loadError: unknown = null;
  private disposed = false;
  private writes: Promise<void> = Promise.resolve();
  private writeError: unknown = null;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly adapter: StoreAdapter,
    private readonly path: string,
    private readonly onError: (error: unknown) => void,
    private readonly now: () => number = Date.now
  ) {}

  async load(): Promise<void> {
    try {
      const text = await readStoreText(this.adapter, this.path);
      if (text === null) return;
      const parsed: unknown = JSON.parse(text);
      if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.entries) || !isRecord(parsed.monthly))
        throw new Error("ai-usage.json has an unexpected shape.");
      if (!parsed.entries.every(isEntry) || !Object.values(parsed.monthly).every(isBucket))
        throw new Error("ai-usage.json has invalid fields.");
      this.entries = parsed.entries;
      this.monthly = parsed.monthly as Record<string, MonthlyBucket>;
      this.loadError = null;
      this.compact();
    } catch (error: unknown) {
      this.loadError = error;
      this.entries = [];
      this.monthly = {};
      this.onError(error);
    }
    this.emit();
  }

  /** "unreadable" after a failed load; persistence stays stopped until the file is repaired and the plugin reloads. */
  get status(): "ready" | "unreadable" {
    return this.loadError ? "unreadable" : "ready";
  }

  /** Adds one call. Ignored (and reported once through `onError`) while the file is unreadable or after dispose. */
  record(entry: Omit<UsageEntry, "at"> & { at?: string }): void {
    try {
      if (this.disposed) return;
      if (this.loadError) {
        // The load already reported it; the first dropped call reports once more (as the save error), later ones are silent.
        if (!this.writeError) {
          this.writeError = this.loadError;
          this.onError(this.loadError);
        }
        return;
      }
      this.entries.push({ ...entry, at: entry.at ?? new Date(this.now()).toISOString() });
      this.compact();
      this.save();
      this.emit();
    } catch (error: unknown) {
      this.onError(error);
    }
  }

  /**
   * Input and output tokens since `since` (ms, inclusive; absent = all time), for one map or all, and one provider
   * or both. Folded months do not record the provider, so a provider filter counts detail rows only.
   */
  totals(query: { mapPath?: string; since?: number; provider?: UsageProvider } = {}): UsageQuery<UsageSum> {
    if (this.loadError) return { status: "unreadable" };
    const sum: UsageSum = ZERO();
    this.each(query, (_action, tokens, estimated) => {
      sum.inputTokens += tokens.inputTokens;
      sum.outputTokens += tokens.outputTokens;
      if (estimated) sum.estimated = true;
    });
    return { status: "ready", value: sum };
  }

  /** Tokens of one map per action (all five keys present); sums to `totals({ mapPath, since, provider })`. */
  byAction(mapPath: string, since?: number, provider?: UsageProvider): UsageQuery<Record<UsageAction, UsageSum>> {
    if (this.loadError) return { status: "unreadable" };
    const result = Object.fromEntries(USAGE_ACTIONS.map(action => [action, ZERO()])) as Record<UsageAction, UsageSum>;
    this.each({ mapPath, since, provider }, (action, tokens, estimated) => {
      result[action].inputTokens += tokens.inputTokens;
      result[action].outputTokens += tokens.outputTokens;
      if (estimated) result[action].estimated = true;
    });
    return { status: "ready", value: result };
  }

  /** The newest `limit` detail rows of one map (all maps when absent) and one provider (both when absent), newest first. */
  recent(mapPath: string | undefined, limit = 10, provider?: UsageProvider): UsageQuery<UsageEntry[]> {
    if (this.loadError) return { status: "unreadable" };
    const rows = this.entries
      .filter(entry => mapPath === undefined || entry.mapPath === mapPath)
      .filter(entry => provider === undefined || entry.provider === provider)
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
      .slice(0, limit)
      .map(entry => ({ ...entry }));
    return { status: "ready", value: rows };
  }

  /** Called after every recorded call and after load (also when load failed). Returns the unsubscribe function. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Waits for the pending writes; rejects with the last write error. */
  async flush(): Promise<void> {
    await this.writes;
    if (this.writeError)
      throw this.writeError instanceof Error ? this.writeError : new Error("ai-usage.json was not saved.");
  }

  /** Waits for the pending writes, then stops recording and drops listeners (onunload). Never rejects. */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.listeners.clear();
    await this.writes;
  }

  private each(
    query: { mapPath?: string; since?: number; provider?: UsageProvider },
    visit: (action: UsageAction, tokens: UsageTokens, estimated: boolean) => void
  ): void {
    const { mapPath, since, provider } = query;
    for (const entry of this.entries) {
      if (mapPath !== undefined && entry.mapPath !== mapPath) continue;
      if (provider !== undefined && entry.provider !== provider) continue;
      if (since !== undefined && Date.parse(entry.at) < since) continue;
      visit(entry.action, entry, entry.estimated);
    }
    // Folded months keep no provider (the file format is fixed), so they cannot be attributed to one.
    if (provider !== undefined) return;
    // A folded month counts when it starts at or after `since`; it only ever holds rows older than the detail window.
    for (const [key, bucket] of Object.entries(this.monthly)) {
      if (since !== undefined && monthStartOf(key) < since) continue;
      for (const [path, actions] of Object.entries(bucket.maps)) {
        if (mapPath !== undefined && path !== mapPath) continue;
        for (const [action, tokens] of Object.entries(actions)) visit(action as UsageAction, tokens, false);
      }
    }
  }

  /** Folds rows older than the detail window into their month. */
  private compact(): void {
    const cutoff = this.now() - USAGE_DETAIL_DAYS * 86_400_000;
    const keep: UsageEntry[] = [];
    for (const entry of this.entries) {
      const time = Date.parse(entry.at);
      if (time >= cutoff) {
        keep.push(entry);
        continue;
      }
      const bucket = (this.monthly[monthKey(time)] ??= { maps: {} });
      const actions = (bucket.maps[entry.mapPath ?? ""] ??= {});
      const tokens = (actions[entry.action] ??= ZERO());
      tokens.inputTokens += entry.inputTokens;
      tokens.outputTokens += entry.outputTokens;
    }
    this.entries = keep;
  }

  private save(): void {
    const file: UsageFile = { version: 1, entries: this.entries, monthly: this.monthly };
    const snapshot = JSON.stringify(file);
    this.writes = this.writes
      .then(() => writeStoreAtomically(this.adapter, this.path, snapshot))
      .then(
        () => {
          this.writeError = null;
        },
        (error: unknown) => {
          this.writeError = error;
          this.onError(error);
        }
      );
  }

  private emit(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error: unknown) {
        this.onError(error);
      }
    }
  }
}
