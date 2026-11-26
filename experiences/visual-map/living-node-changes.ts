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
      if (old) throw new Error("existing-record");
      const evidence = evidenceFor(operation.evidence, allowed);
      if (!evidence.length) throw new Error("missing-evidence");
      records.set(recordId, {
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
      });
      changed = true;
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
  // Revision is assigned by the actual Markdown commit, not by model output.
  return { changed, records: [...records.values()], output };
}
