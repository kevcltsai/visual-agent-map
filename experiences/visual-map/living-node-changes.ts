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

export interface LivingKnowledge {
  revision: string;
  records: readonly LivingRecord[];
  suppressed: readonly string[];
  output: { text: string; owner: "ai" | "user"; evidence: readonly LivingEvidence[] };
}

/** Readable formal knowledge is required for a successful check; metadata alone is not a result. */
export function hasLivingResult(knowledge: Pick<LivingKnowledge, "records" | "output">): boolean {
  return !!knowledge.output.text.trim() || knowledge.records.some(record => !!record.claim.trim());
}

export interface LivingChangeContext {
  /** Evidence collected by the trusted source resolver, not IDs invented by the model. */
  evidence: readonly LivingEvidence[];
  at: string;
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
  return /^(?:daily|day|daily close|hourly|hour|weekly|week|monthly|month|quarterly|quarter|yearly|year|每日|每小時|每小时|日|小時|小时|每週|每周|每月|每季|每年)$/.test(normalized(granularity));
}

function isChange(granularity: string): boolean {
  return /^(?:change|change only|on change|price change|變動|变化|變化|每次變動|每次变化)$/.test(normalized(granularity));
}

function duplicateRecord(records: ReadonlyMap<string, LivingRecord>, candidate: LivingRecord): LivingRecord | undefined {
  const existing = records.get(candidate.id);
  if (existing) {
    if (!sameScope(existing, candidate) || timeKey(existing.eventTime) !== timeKey(candidate.eventTime) || !sameClaim(existing, candidate))
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
      value !== null && time !== null &&
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

/** No file I/O and no arbitrary Markdown rewriting: a bad operation rejects the entire proposal. */
export function applyLivingChanges(base: LivingKnowledge, raw: unknown, context: LivingChangeContext) {
  const proposal = object(raw);
  exactKeys(proposal, ["baseRevision", "operations"]);
  if (proposal.baseRevision !== base.revision) throw new Error("stale-base");
  if (!Array.isArray(proposal.operations) || proposal.operations.length > 200) throw new Error("invalid-operations");
  const records = new Map(base.records.map(record => [record.id, record]));
  if (records.size !== base.records.length) throw new Error("duplicate-record");
  const suppressed = new Set(base.suppressed);
  const allowed = new Map(context.evidence.map(entry => [entry.id, entry]));
  let output = base.output;
  let changed = false;
  for (const rawOperation of proposal.operations as unknown[]) {
    const operation = object(rawOperation);
    const kind = operation.kind;
    if (kind === "output") {
      exactKeys(operation, ["kind", "text", "evidence"]);
      if (output.owner !== "ai") throw new Error("protected-output");
      const text = string(operation.text);
      const evidence = mergeEvidence(output.evidence, evidenceFor(operation.evidence, allowed));
      if (text !== output.text || evidence.length !== output.evidence.length) {
        output = { text, evidence, owner: "ai" };
        changed = true;
      }
      continue;
    }
    const recordId = id(operation.id);
    if (suppressed.has(recordId)) throw new Error("suppressed-record");
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
      const duplicate = duplicateRecord(records, candidate);
      if (duplicate) {
        if (duplicate.owner !== "ai") throw new Error("protected-record");
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
      kind === "invalidate" ? ["kind", "id", "reason", "evidence"] : ["kind", "id", "claim", "reason", "evidence"]
    );
    const evidence = evidenceFor(operation.evidence, allowed);
    if (!evidence.length) throw new Error("missing-evidence");
    const reason = string(operation.reason);
    const claim = kind === "invalidate" ? old.claim : string(operation.claim);
    if (kind === "correct" && claim === old.claim) throw new Error("unchanged-correction");
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
    if (duplicate && validity === old.validity && merged.length === old.evidence.length) continue;
    records.set(recordId, {
      ...old,
      claim: kind === "correct" ? claim : old.claim,
      validity,
      evidence: merged,
      history: [...old.history, history]
    });
    changed = true;
  }
  if (!hasLivingResult({ records: [...records.values()], output })) throw new Error("missing-formal-result");
  // Revision is assigned by the actual Markdown commit, not by model output.
  return { changed, records: [...records.values()], output };
}
