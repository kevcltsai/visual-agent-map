import { createHash } from "node:crypto";

/** Pure change-set validator. Storage must independently reconcile ownership against the actual Markdown. */
export interface LivingEvidence {
  id: string;
  source: string;
  retrievedAt: string;
}

export interface LivingRecord {
  id: string;
  subject: string;
  scope: string;
  granularity: string;
  eventTime: string | null;
  claim: string;
  evidence: readonly LivingEvidence[];
  validity: "active" | "disputed" | "invalidated";
  owner: "ai" | "user";
  history: readonly {
    claim: string;
    reason: string;
    at: string;
    evidence: readonly LivingEvidence[];
    previousEvidence: readonly LivingEvidence[];
  }[];
}

/** The AI's own latest result, kept apart from `output` so a hand-edited output is never overwritten or rejected. */
export interface LivingAiLatest {
  text: string;
  owner: "ai" | "user";
  /** When the AI produced this result. */
  at: string;
  evidence: readonly LivingEvidence[];
}

export interface LivingKnowledge {
  revision: string;
  records: readonly LivingRecord[];
  suppressed: readonly string[];
  output: { text: string; owner: "ai" | "user"; evidence: readonly LivingEvidence[] };
  /** Absent until the AI writes a result while `output` is user-owned. */
  aiLatest?: LivingAiLatest;
  /** Hash of an AI latest text the owner deleted (never the text). The same text is not written back. */
  aiLatestDeleted?: string;
}

/** Deletion memory only (not the ownership hashes): trivial variants of the deleted text hash the same. */
export const livingDeletedTextHash = (text: string): string =>
  createHash("sha256").update(text.normalize("NFC").replace(/\r\n?/g, "\n").replace(/\s+/g, " ").trim()).digest("hex");

export type LivingAiLatestBlock = "ai-latest-user-edited" | "ai-latest-deleted";

/** Why an AI output operation must not write the separate AI result slot, or undefined when it may. */
export function livingAiLatestBlocked(
  base: Pick<LivingKnowledge, "output" | "aiLatest" | "aiLatestDeleted">,
  text: string
): LivingAiLatestBlock | undefined {
  if (base.output.owner === "ai") return undefined;
  if (base.aiLatest) return base.aiLatest.owner === "user" ? "ai-latest-user-edited" : undefined;
  return base.aiLatestDeleted && base.aiLatestDeleted === livingDeletedTextHash(text) ? "ai-latest-deleted" : undefined;
}

/** Readable formal knowledge is required for a successful check; metadata alone is not a result. */
export function hasLivingResult(knowledge: Pick<LivingKnowledge, "records" | "output" | "aiLatest">): boolean {
  return (
    !!knowledge.output.text.trim() ||
    !!knowledge.aiLatest?.text.trim() ||
    knowledge.records.some(record => !!record.claim.trim())
  );
}

/** What a trial would change against the committed formal knowledge. Computed on demand, never stored. */
export interface LivingChangeSummary {
  /** No formal result exists yet, so there is nothing to compare against. */
  firstRun: boolean;
  added: string[];
  supplemented: string[];
  corrected: string[];
  disputed: string[];
  invalidated: string[];
  /** The formal output or the AI latest result text differs. */
  outputUpdated: boolean;
}

export function summarizeLivingChanges(
  base: Pick<LivingKnowledge, "records" | "output" | "aiLatest">,
  next: Pick<LivingKnowledge, "records" | "output" | "aiLatest">
): LivingChangeSummary {
  const summary: LivingChangeSummary = {
    firstRun: !hasLivingResult(base),
    added: [],
    supplemented: [],
    corrected: [],
    disputed: [],
    invalidated: [],
    outputUpdated: next.output.text !== base.output.text || (next.aiLatest?.text ?? "") !== (base.aiLatest?.text ?? "")
  };
  if (summary.firstRun) return { ...summary, outputUpdated: false };
  const old = new Map(base.records.map(record => [record.id, record]));
  for (const record of next.records) {
    const before = old.get(record.id);
    if (!before) summary.added.push(record.id);
    else if (record.validity !== before.validity && record.validity === "invalidated")
      summary.invalidated.push(record.id);
    else if (record.validity !== before.validity && record.validity === "disputed") summary.disputed.push(record.id);
    else if (record.claim !== before.claim) summary.corrected.push(record.id);
    else if (record.evidence.length > before.evidence.length) summary.supplemented.push(record.id);
  }
  return summary;
}

/** Diagnostic frontmatter key: the last changed commit's record ids per change kind. Never text; never part of a knowledge revision. */
export const LIVING_LAST_CHANGE_KEY = "living-node-last-change";
const LAST_CHANGE_KINDS = ["added", "supplemented", "corrected", "disputed", "invalidated"] as const;

/** The key's value for a changed commit that had a baseline: `at` is the commit time, then only record ids. */
export function livingLastChangeValue(summary: LivingChangeSummary, at: string): string {
  return JSON.stringify({
    at,
    ...Object.fromEntries(LAST_CHANGE_KINDS.map(kind => [kind, summary[kind]])),
    output: summary.outputUpdated
  });
}

/** What the key says, with the time it was written; undefined when absent or malformed (no baseline is then shown). */
export function readLivingLastChange(
  content: string,
  parse: (yaml: string) => unknown
): { at: string; checkedAt?: string; changes: LivingChangeSummary } | undefined {
  try {
    const block = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)?.[1];
    const fm = block ? (parse(block) as Record<string, unknown> | null) : null;
    const raw = fm?.[LIVING_LAST_CHANGE_KEY];
    const value = typeof raw === "string" ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
    if (!value || typeof value.at !== "string" || typeof value.output !== "boolean") return undefined;
    const lists = LAST_CHANGE_KINDS.map(kind => value[kind]);
    if (!lists.every(list => Array.isArray(list) && list.every(id => typeof id === "string"))) return undefined;
    const [added, supplemented, corrected, disputed, invalidated] = lists;
    return {
      at: value.at,
      ...(typeof fm?.["living-node-last-successful-check"] === "string"
        ? { checkedAt: fm["living-node-last-successful-check"] }
        : {}),
      changes: { firstRun: false, added, supplemented, corrected, disputed, invalidated, outputUpdated: value.output }
    };
  } catch {
    return undefined;
  }
}

export interface LivingChangeContext {
  /** Evidence collected by the trusted source resolver, not IDs invented by the model. */
  evidence: readonly LivingEvidence[];
  at: string;
  /** Web activity observed during the run (never model text): a page opened or a search made, and when. */
  checked?: readonly { url?: string; query?: string; at: string }[];
}

type ObjectValue = Record<string, unknown>;

function object(value: unknown): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid-change");
  return value as ObjectValue;
}

function string(value: unknown, max = 10000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error("invalid-text");
  return value.trim();
}

function id(value: unknown): string {
  const result = string(value, 160);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(result)) throw new Error("invalid-id");
  return result;
}

function exactKeys(value: ObjectValue, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error("unknown-field");
}

function evidenceFor(value: unknown, allowed: ReadonlyMap<string, LivingEvidence>): LivingEvidence[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error("invalid-evidence");
  const entries = new Map<string, LivingEvidence>();
  for (const raw of value as unknown[]) {
    const key = id(raw);
    const entry = allowed.get(key);
    if (!entry) throw new Error("unauthorized-evidence");
    entries.set(key, entry);
  }
  return [...entries.values()];
}

function mergeEvidence(old: readonly LivingEvidence[], next: readonly LivingEvidence[]): LivingEvidence[] {
  const entries = new Map(old.map(item => [item.id, item]));
  for (const item of next) if (!entries.has(item.id)) entries.set(item.id, item);
  return [...entries.values()];
}

/** Conservative deterministic equality; the model still has to resolve semantic paraphrases and event identities. */
const normalized = (value: string): string => value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();

function sameScope(a: LivingRecord, b: LivingRecord): boolean {
  return (
    normalized(a.subject) === normalized(b.subject) &&
    normalized(a.scope) === normalized(b.scope) &&
    normalized(a.granularity) === normalized(b.granularity)
  );
}

function sameClaim(a: LivingRecord, b: LivingRecord): boolean {
  return normalized(a.claim) === normalized(b.claim);
}

function timeKey(value: string | null): string | null {
  if (!value) return null;
  // A precise timestamp may be written with different offsets; a day/month label is intentionally not shifted.
  if (/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/i.test(value)) {
    const instant = Date.parse(value);
    if (Number.isFinite(instant)) return new Date(instant).toISOString();
  }
  return value;
}

function isPeriod(granularity: string): boolean {
  return /^(?:daily|day|daily close|hourly|hour|weekly|week|monthly|month|quarterly|quarter|yearly|year|每日|每小時|每小时|日|小時|小时|每週|每周|每月|每季|每年)$/.test(
    normalized(granularity)
  );
}

/** Suppression uses stable normalized scope and time, not the old claim.
 * A match is a conservative hold, not a proof of semantic identity. */
function granularityKey(value: string): string {
  const key = normalized(value);
  if (/^(?:daily|day|daily close|每日|日)$/.test(key)) return "day";
  if (/^(?:hourly|hour|每小時|每小时|小時|小时)$/.test(key)) return "hour";
  if (/^(?:weekly|week|每週|每周)$/.test(key)) return "week";
  if (/^(?:monthly|month|每月)$/.test(key)) return "month";
  if (/^(?:quarterly|quarter|每季)$/.test(key)) return "quarter";
  if (/^(?:yearly|year|每年)$/.test(key)) return "year";
  if (isChange(key)) return "change";
  return key;
}

const fingerprint = (values: readonly unknown[]): string =>
  createHash("sha256").update(JSON.stringify(values)).digest("hex");

export function livingEventScopeFingerprint(record: LivingRecord): string {
  return fingerprint([normalized(record.subject), normalized(record.scope)]);
}

export function livingEventFingerprint(record: LivingRecord): string {
  const time = timeKey(record.eventTime);
  // Compare the time independently of the model's description or proposed ID.
  // Unknown times are ambiguous and get a separate scope-level hold.
  return fingerprint([livingEventScopeFingerprint(record), granularityKey(record.granularity), time]);
}

/** Suppression v2 entry. Legacy v1 tombstones stay as stored strings and are never recomputed. */
export interface LivingSuppressionV2 {
  v: 2;
  type: "event";
  scopeKey: string;
  periodKey: string | null;
  fp2: string;
  /** Hash of scope words + period + normalised value (no text); absent when the claim has no number. */
  valueKey?: string;
  /**
   * Hash of period + normalised value with its unit (subject and scope excluded, so a re-labelled subject or scope
   * still matches). Only written for a value with a currency, percent or "per ..." unit; absent on older entries.
   */
  valueKey2?: string;
}

const V2_PREFIX = "@v2:";

/** Scope identity ignores case, width, punctuation and spacing so a reworded scope label still matches. */
function scopeWords(value: string): string {
  return normalized(value)
    .replace(/[\p{P}\p{S}\s]+/gu, " ")
    .trim();
}

/** The wall-clock time as written (in its own offset) truncated to its observation period. Offset-less dates stay as is. */
function periodKey(record: LivingRecord): string | null {
  const raw = record.eventTime?.trim();
  if (!raw) return null;
  const granularity = granularityKey(record.granularity);
  const iso = /^(\d{4})-(\d\d)-(\d\d)(?:T(\d\d))?/.exec(raw);
  if (!iso) return timeKey(raw);
  const [, year, month, day, hour] = iso;
  if (granularity === "day") return year + "-" + month + "-" + day;
  if (granularity === "hour") return hour ? year + "-" + month + "-" + day + "T" + hour : timeKey(raw);
  if (granularity === "month") return year + "-" + month;
  if (granularity === "year") return year;
  if (granularity === "quarter") return year + "-Q" + (Math.floor((Number(month) - 1) / 3) + 1);
  if (granularity === "week") {
    // ISO 8601 week: the week belongs to the year of its Thursday.
    const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    const weekday = date.getUTCDay() || 7;
    date.setUTCDate(date.getUTCDate() + 4 - weekday);
    const first = Date.UTC(date.getUTCFullYear(), 0, 1);
    const week = Math.ceil(((date.getTime() - first) / 86_400_000 + 1) / 7);
    return date.getUTCFullYear() + "-W" + String(week).padStart(2, "0");
  }
  return timeKey(raw);
}

const CURRENCIES: Record<string, string> = {
  $: "usd",
  usd: "usd",
  US$: "usd",
  "€": "eur",
  eur: "eur",
  "£": "gbp",
  gbp: "gbp",
  "¥": "jpy",
  jpy: "jpy",
  NT$: "twd",
  twd: "twd",
  nt: "twd"
};

/** The first amount of a claim as "currency|number" (commas and trailing zeros normalised), or null without a number. */
function claimValue(claim: string): string | null {
  const text = claim.replace(/\d{4}-\d\d-\d\d(?:T[\d:.]+Z?)?/g, " ").replace(/(\d),(?=\d{3}\b)/g, "$1");
  const match =
    /(NT\$|US\$|[$€£¥]|\b(?:usd|eur|gbp|jpy|twd)\b)?\s*(\d+(?:\.\d+)?)\s*(%|\b(?:usd|eur|gbp|jpy|twd)\b)?/i.exec(text);
  if (!match) return null;
  const currency = CURRENCIES[(match[1] ?? match[3] ?? "").toLowerCase()] ?? CURRENCIES[match[1] ?? ""] ?? "";
  const percent = match[3] === "%" ? "%" : "";
  return currency + percent + "|" + String(Number(match[2]));
}

/** First amount with its unit ("usd|12|per user per month"); null unless a currency, percent or per-unit is present. */
function claimValueUnit(claim: string): string | null {
  const text = claim.replace(/\d{4}-\d\d-\d\d(?:T[\d:.]+Z?)?/g, " ").replace(/(\d),(?=\d{3}\b)/g, "$1");
  const match =
    /(NT\$|US\$|[$€£¥]|\b(?:usd|eur|gbp|jpy|twd)\b)?\s*(\d+(?:\.\d+)?)\s*(%|\b(?:usd|eur|gbp|jpy|twd)\b)?/i.exec(text);
  if (!match) return null;
  const currency = CURRENCIES[(match[1] ?? match[3] ?? "").toLowerCase()] ?? CURRENCIES[match[1] ?? ""] ?? "";
  const percent = match[3] === "%" ? "%" : "";
  const rest = text.slice(match.index + match[0].length);
  const unit = /^\s*(?:\/|\bper\b)\s*(\p{L}+)(?:\s*(?:\/|\bper\b)\s*(\p{L}+))?/iu.exec(rest);
  const perUnit = unit ? [unit[1], unit[2]].filter(Boolean).join(" per ").toLowerCase() : "";
  if (!currency && !percent && !perUnit) return null;
  return currency + percent + "|" + String(Number(match[2])) + "|" + perUnit;
}

export function livingSuppressionV2(record: LivingRecord): LivingSuppressionV2 {
  const scopeKey = fingerprint(["v2", scopeWords(record.subject), scopeWords(record.scope)]);
  const period = periodKey(record);
  const value = claimValue(record.claim);
  const unitValue = claimValueUnit(record.claim);
  return {
    v: 2,
    type: "event",
    scopeKey,
    periodKey: period,
    fp2: fingerprint([scopeKey, granularityKey(record.granularity), period]),
    ...(period !== null && value !== null
      ? { valueKey: fingerprint(["v2value", scopeWords(record.scope), period, value]) }
      : {}),
    ...(period !== null && unitValue !== null ? { valueKey2: fingerprint(["v2value2", period, unitValue]) } : {})
  };
}

/**
 * A `correct`/`invalidate` that states the period of its observation (`eventTime`) may only touch a record with that
 * same period, or one without a period: an observation for another period is a new record, never a correction.
 */
export function livingSupersedeMismatch(base: Pick<LivingKnowledge, "records">, raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const op = raw as Record<string, unknown>;
  if ((op.kind !== "correct" && op.kind !== "invalidate") || typeof op.eventTime !== "string") return false;
  const old = base.records.find(record => record.id === op.id);
  if (!old || periodKey(old) === null) return false;
  return periodKey({ ...old, eventTime: op.eventTime }) !== periodKey(old);
}

export function livingSuppressionV2Entry(entry: LivingSuppressionV2): string {
  const parts: unknown[] = [entry.v, entry.type, entry.scopeKey, entry.periodKey, entry.fp2];
  if (entry.valueKey) parts.push(entry.valueKey);
  if (entry.valueKey && entry.valueKey2) parts.push(entry.valueKey2);
  return V2_PREFIX + JSON.stringify(parts);
}

/** Both stored forms of a record's entry: with the value hash and the legacy one without (older notes). */
export function livingSuppressionV2Forms(record: LivingRecord): string[] {
  const entry = livingSuppressionV2(record);
  const { valueKey2: _valueKey2, ...withValue } = entry;
  const { valueKey: _valueKey, ...legacy } = withValue;
  return [
    ...new Set([livingSuppressionV2Entry(entry), livingSuppressionV2Entry(withValue), livingSuppressionV2Entry(legacy)])
  ];
}

export function parseLivingSuppressionV2(value: string): LivingSuppressionV2 | undefined {
  if (!value.startsWith(V2_PREFIX)) return undefined;
  try {
    const raw: unknown = JSON.parse(value.slice(V2_PREFIX.length));
    if (!Array.isArray(raw) || raw.length < 5 || raw.length > 7) return undefined;
    const [v, type, scopeKey, period, fp2, valueKey, valueKey2] = raw as unknown[];
    const hash = (x: unknown): x is string => typeof x === "string" && /^[a-f0-9]{64}$/.test(x);
    if (v !== 2 || type !== "event" || !hash(scopeKey) || !hash(fp2)) return undefined;
    if (period !== null && (typeof period !== "string" || !period || period.length > 100)) return undefined;
    if (raw.length >= 6 && !hash(valueKey)) return undefined;
    if (raw.length === 7 && !hash(valueKey2)) return undefined;
    const entry: LivingSuppressionV2 = {
      v: 2,
      type: "event",
      scopeKey,
      periodKey: period,
      fp2,
      ...(raw.length >= 6 ? { valueKey: valueKey as string } : {}),
      ...(raw.length === 7 ? { valueKey2: valueKey2 as string } : {})
    };
    return livingSuppressionV2Entry(entry) === value ? entry : undefined;
  } catch {
    return undefined;
  }
}

export function livingEventTombstone(recordId: string, event: string, scope?: string, unknownTime = false): string {
  return scope
    ? "@event:" + event + ":" + scope + ":" + (unknownTime ? "u" : "k") + ":" + recordId
    : "@event:" + event + ":" + recordId;
}

export function parseLivingEventTombstone(
  value: string
): { fingerprint: string; recordId: string; scope?: string; unknownTime?: boolean } | undefined {
  const full = /^@event:([a-f0-9]{64}):([a-f0-9]{64}):([uk]):(.+)$/.exec(value);
  if (full) return { fingerprint: full[1], scope: full[2], unknownTime: full[3] === "u", recordId: full[4] };
  const legacy = /^@event:([a-f0-9]{64}):(.+)$/.exec(value);
  return legacy ? { fingerprint: legacy[1], recordId: legacy[2] } : undefined;
}

function isChange(granularity: string): boolean {
  return /^(?:change|change only|on change|price change|變動|变化|變化|每次變動|每次变化)$/.test(
    normalized(granularity)
  );
}

function duplicateRecord(
  records: ReadonlyMap<string, LivingRecord>,
  candidate: LivingRecord
): LivingRecord | undefined {
  const existing = records.get(candidate.id);
  if (existing) {
    if (
      !sameScope(existing, candidate) ||
      timeKey(existing.eventTime) !== timeKey(candidate.eventTime) ||
      !sameClaim(existing, candidate)
    )
      throw new Error("existing-record-conflict");
    return existing;
  }
  const related = [...records.values()].filter(item => sameScope(item, candidate));
  const time = timeKey(candidate.eventTime);
  for (const item of related) {
    const sameTime = time !== null && timeKey(item.eventTime) === time;
    const sharedEvidence = item.evidence.some(evidence => candidate.evidence.some(next => next.id === evidence.id));
    if (sameClaim(item, candidate) && (sameTime || (time === null && item.eventTime === null && sharedEvidence)))
      return item;
    if (sameTime && isPeriod(candidate.granularity)) throw new Error("period-conflict-requires-correction");
  }
  if (isChange(candidate.granularity)) {
    // Knowledge may arrive out of order (for example a historical backfill).
    // Compare with the most recent comparable observation at or before this event,
    // not the last inserted record. Do not guess the order of unknown times.
    const comparable = (value: string | null): boolean =>
      value !== null &&
      time !== null &&
      ((/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
        /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(time)) ||
        (/^\d{4}-\d\d-\d\d$/.test(value) && /^\d{4}-\d\d-\d\d$/.test(time)));
    let latest: LivingRecord | undefined;
    let latestTime: string | undefined;
    for (const item of related) {
      const previousTime = timeKey(item.eventTime);
      if (previousTime === null || time === null || !comparable(previousTime) || previousTime > time) continue;
      if (latestTime === undefined || previousTime > latestTime) {
        latest = item;
        latestTime = previousTime;
      } else if (previousTime === latestTime && latest && !sameClaim(latest, item)) {
        // Conflicting observations at the same instant are not a safe deduplication basis.
        latest = undefined;
      }
    }
    if (latest && latest.validity === "active" && sameClaim(latest, candidate)) return latest;
  }
  return undefined;
}

interface SuppressionIndex {
  /** Record IDs held by legacy ID-only or v1 tombstones: only that same ID is blocked. */
  ids: Set<string>;
  v1: ReturnType<typeof parseLivingEventTombstone>[];
  v2: LivingSuppressionV2[];
}

function suppressionIndex(base: Pick<LivingKnowledge, "suppressed">): SuppressionIndex {
  const index: SuppressionIndex = { ids: new Set(), v1: [], v2: [] };
  for (const value of base.suppressed) {
    const v2 = parseLivingSuppressionV2(value);
    if (v2) {
      index.v2.push(v2);
      continue;
    }
    const event = parseLivingEventTombstone(value);
    if (event) {
      index.v1.push(event);
      index.ids.add(event.recordId);
    } else index.ids.add(value);
  }
  return index;
}

function suppressionVerdict(index: SuppressionIndex, candidate: LivingRecord): string | undefined {
  const v1 = livingEventFingerprint(candidate);
  const v2 = livingSuppressionV2(candidate);
  if (
    index.v1.some(event => event?.fingerprint === v1) ||
    index.v2.some(
      entry =>
        entry.fp2 === v2.fp2 ||
        (!!v2.valueKey && entry.valueKey === v2.valueKey) ||
        (!!v2.valueKey2 && entry.valueKey2 === v2.valueKey2)
    )
  )
    return "suppressed-record";
  const scope = livingEventScopeFingerprint(candidate);
  if (
    index.v1.some(event => event?.scope === scope && (event.unknownTime || candidate.eventTime === null)) ||
    index.v2.some(entry => entry.scopeKey === v2.scopeKey && (entry.periodKey === null || candidate.eventTime === null))
  )
    return "ambiguous-suppression";
  return undefined;
}

/** An append that existing suppression would reject. The provider drops these locally and counts them. */
export function livingAppendSuppressed(base: Pick<LivingKnowledge, "suppressed">, raw: unknown): boolean {
  try {
    const op = object(raw);
    if (op.kind !== "append") return false;
    const index = suppressionIndex(base);
    if (index.ids.has(id(op.id))) return true;
    return !!suppressionVerdict(index, {
      id: id(op.id),
      subject: string(op.subject, 500),
      scope: string(op.scope, 500),
      granularity: string(op.granularity, 100),
      eventTime: op.eventTime === null ? null : string(op.eventTime, 100),
      claim: typeof op.claim === "string" ? op.claim : "",
      evidence: [],
      validity: "active",
      owner: "ai",
      history: []
    });
  } catch {
    return false;
  }
}

/** Legacy ID-only entries, listed for diagnostics. */
export function livingLegacySuppressionIds(base: Pick<LivingKnowledge, "suppressed">): string[] {
  return base.suppressed.filter(value => !parseLivingSuppressionV2(value) && !parseLivingEventTombstone(value));
}

/** No file I/O and no arbitrary Markdown rewriting: a bad operation rejects the entire proposal. */
export function applyLivingChanges(base: LivingKnowledge, raw: unknown, context: LivingChangeContext) {
  const proposal = object(raw);
  exactKeys(proposal, ["baseRevision", "operations"]);
  if (proposal.baseRevision !== base.revision) throw new Error("stale-base");
  if (!Array.isArray(proposal.operations) || proposal.operations.length > 200) throw new Error("invalid-operations");
  const records = new Map(base.records.map(record => [record.id, record]));
  if (records.size !== base.records.length) throw new Error("duplicate-record");
  const suppression = suppressionIndex(base);
  const allowed = new Map(context.evidence.map(entry => [entry.id, entry]));
  // Retained evidence can be selected explicitly for a new conclusion. It is
  // already formal knowledge, not a new retrieval or an invented source.
  const outputEvidence = new Map(
    [
      ...base.records.filter(record => record.validity === "active").flatMap(record => record.evidence),
      ...base.output.evidence,
      ...(base.aiLatest?.evidence ?? []),
      ...context.evidence
    ].map(entry => [entry.id, entry])
  );
  let output = base.output;
  let aiLatest = base.aiLatest;
  const warnings: LivingAiLatestBlock[] = [];
  let changed = false;
  for (const rawOperation of proposal.operations as unknown[]) {
    const operation = object(rawOperation);
    const kind = operation.kind;
    if (kind === "output") {
      exactKeys(operation, ["kind", "text", "evidence"]);
      const text = string(operation.text);
      // A user-owned output is never touched: the AI result goes to its own slot. An edited or deleted slot is the
      // owner's decision: this operation is dropped and disclosed, and the rest of the proposal still applies.
      const blocked = livingAiLatestBlocked({ output, aiLatest, aiLatestDeleted: base.aiLatestDeleted }, text);
      if (blocked) {
        if (!warnings.includes(blocked)) warnings.push(blocked);
        continue;
      }
      const slot = output.owner === "ai" ? output : (aiLatest ?? { text: "", owner: "ai" as const, evidence: [] });
      // Evidence for a replaced conclusion must be explicitly selected, not
      // inherited from a different claim. Preserve retrieval stamps for retained IDs.
      const selected = evidenceFor(operation.evidence, outputEvidence);
      const evidence =
        text === slot.text
          ? mergeEvidence(slot.evidence, selected)
          : selected.map(entry => slot.evidence.find(previous => previous.id === entry.id) ?? entry);
      if (text !== slot.text || evidence.length !== slot.evidence.length) {
        if (output.owner === "ai") output = { text, evidence, owner: "ai" };
        else aiLatest = { text, evidence, owner: "ai", at: context.at };
        changed = true;
      }
      continue;
    }
    const recordId = id(operation.id);
    if (suppression.ids.has(recordId)) throw new Error("suppressed-record");
    const old = records.get(recordId);
    if (kind === "append") {
      exactKeys(operation, ["kind", "id", "subject", "scope", "granularity", "eventTime", "claim", "evidence"]);
      const evidence = evidenceFor(operation.evidence, allowed);
      if (!evidence.length) throw new Error("missing-evidence");
      const candidate: LivingRecord = {
        id: recordId,
        subject: string(operation.subject, 500),
        scope: string(operation.scope, 500),
        granularity: string(operation.granularity, 100),
        eventTime: operation.eventTime === null ? null : string(operation.eventTime, 100),
        claim: string(operation.claim),
        evidence,
        validity: "active",
        owner: "ai",
        history: []
      };
      const blocked = suppressionVerdict(suppression, candidate);
      if (blocked) throw new Error(blocked);
      const duplicate = duplicateRecord(records, candidate);
      if (duplicate) {
        if (duplicate.owner !== "ai") throw new Error("protected-record");
        if (duplicate.validity !== "active") throw new Error("inactive-record-requires-resolution");
        const merged = mergeEvidence(duplicate.evidence, evidence);
        if (merged.length !== duplicate.evidence.length) {
          records.set(duplicate.id, { ...duplicate, evidence: merged });
          changed = true;
        }
      } else {
        records.set(recordId, candidate);
        changed = true;
      }
      continue;
    }
    if (!old) throw new Error("unknown-record");
    if (old.owner !== "ai") throw new Error("protected-record");
    if (kind === "supplement") {
      exactKeys(operation, ["kind", "id", "evidence"]);
      const evidence = mergeEvidence(old.evidence, evidenceFor(operation.evidence, allowed));
      if (evidence.length !== old.evidence.length) {
        records.set(recordId, { ...old, evidence });
        changed = true;
      }
      continue;
    }
    if (kind !== "correct" && kind !== "dispute" && kind !== "invalidate") throw new Error("unknown-operation");
    exactKeys(
      operation,
      kind === "invalidate"
        ? ["kind", "id", "reason", "evidence", "eventTime"]
        : ["kind", "id", "claim", "reason", "evidence", "eventTime"]
    );
    if (livingSupersedeMismatch({ records: [...records.values()] }, operation))
      throw new Error("period-mismatch-correction");
    const evidence = evidenceFor(operation.evidence, allowed);
    if (!evidence.length) throw new Error("missing-evidence");
    // A web excerpt is the model's summary, never verified page text: it cannot alone replace or retract a claim.
    // Unchanged old evidence of the record does not count as new support: a correction needs a non-web id that
    // the record did not already cite.
    if (
      kind !== "dispute" &&
      evidence.some(entry => entry.id.startsWith("web:")) &&
      !evidence.some(entry => !entry.id.startsWith("web:") && !old.evidence.some(e => e.id === entry.id))
    )
      throw new Error("unverified-web-correction");
    const reason = string(operation.reason);
    const claim = kind === "invalidate" ? old.claim : string(operation.claim);
    if (kind === "correct" && sameClaim(old, { ...old, claim })) throw new Error("unchanged-correction");
    const validity = kind === "invalidate" ? "invalidated" : kind === "dispute" ? "disputed" : "active";
    const merged = mergeEvidence(old.evidence, evidence);
    // Disputes preserve the original claim and record the conflicting one separately.
    const historyClaim = kind === "dispute" ? claim : old.claim;
    const history = { claim: historyClaim, reason, at: context.at, evidence, previousEvidence: old.evidence };
    const duplicate = old.history.some(
      item =>
        item.claim === historyClaim &&
        item.reason === reason &&
        evidence.every(entry => item.evidence.some(previous => previous.id === entry.id))
    );
    if (kind === "correct" && merged.length === old.evidence.length) throw new Error("missing-new-evidence");
    if (duplicate && validity === old.validity && kind !== "correct") continue;
    records.set(recordId, {
      ...old,
      claim: kind === "correct" ? claim : old.claim,
      validity,
      evidence: kind === "correct" ? evidence : old.evidence,
      history: [...old.history, history]
    });
    changed = true;
  }
  if (!hasLivingResult({ records: [...records.values()], output, aiLatest })) throw new Error("missing-formal-result");
  // Revision is assigned by the actual Markdown commit, not by model output.
  return {
    changed,
    records: [...records.values()],
    output,
    aiLatest,
    aiLatestDeleted: aiLatest ? undefined : base.aiLatestDeleted,
    warnings
  };
}
