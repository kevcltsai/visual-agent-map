/**
 * Argument map state machine, version 2 (methodology 6, spec docs/history/tasks/2026-11-09-argument-map-layout). Pure: `nextActions(state)`
 * says what may happen next and the `apply*`/`begin*`/`release*` reducers are the only functions that change a state. A reducer that would
 * break a gate throws `GateError` and returns nothing, so the input is never half written; a success returns a new state. The AI only fills
 * content; every gate is decided here. Lives beside the v1 machine (`machine.ts`, still used by the v1 runner) until the runner switches.
 *
 * This file covers: building a locked map, the premise gate, hypotheses, pre-registered needs, research, evidence assessment, the derived
 * test status and the program's own "insufficient" at the limit. Verdicts by the AI, the comparison, the conclusion and the inference
 * check are the next packet.
 */
import { GateError } from "./machine";
import {
  CANDIDATE_KINDS,
  CLAIM_ROLES,
  CLAIM_TYPES,
  EVIDENCE_STANCES,
  MAX_FRAMING_CALLS,
  MAX_HYPOTHESES,
  MAX_NEEDS,
  MAX_PREMISE_ATTEMPTS,
  MAX_PREMISE_DATA,
  MAX_PREMISES,
  MAX_RESEARCH_CALLS,
  MAX_ROUND,
  MAX_ROUND_NEEDS,
  MAX_TESTABLE,
  OVERLAP_STRENGTHS,
  PREDICTION_KINDS,
  PREMISE_RESULTS,
  PROOF_CHECKS,
  VERDICT_VALUES,
  type ArgumentMapData,
  type ArgumentRoles,
  type Assessment,
  type Claim,
  type ClaimRole,
  type ClaimType,
  type Criteria,
  type Definition,
  type Framing,
  type Hypothesis,
  type HypothesisRole,
  type Identification,
  type Need,
  type OverlapEntry,
  type PredictionKind,
  type PremiseDatum,
  type PremiseResult,
  type SourceProof,
  type StopReason,
  type VerdictValue
} from "./model";

export { GateError };

export type ArgumentAction =
  | { type: "research_premise"; claimId: string; dataId: string }
  | { type: "premise_missing"; claimId: string }
  | { type: "assess_premise"; claimId: string }
  | { type: "judge_premise"; claimId: string }
  | { type: "propose_hypotheses"; claimId: string }
  | { type: "add_needs"; hypothesisId: string }
  | { type: "research_need"; hypothesisId: string; needId: string }
  | { type: "assess_evidence"; hypothesisId: string }
  | { type: "next_round"; hypothesisId: string }
  /** The program decides: no AI call. */
  | { type: "program_verdict"; hypothesisId: string }
  /** The AI judges (next packet). */
  | { type: "verdict"; hypothesisId: string };

/** What a research answer must be: a source the caller checked, or a miss with a reason. `stance` is only a hint and is not stored. */
export type EvidenceResult = { found: true; stance?: string; proof: SourceProof } | { found: false; reason: string };

export interface ClaimDraft {
  id: string;
  text: string;
  type: ClaimType;
  role: ClaimRole;
  dependsOn: string[];
  definitions: Definition[];
  /** Premises only: the data each needs (1 to MAX_PREMISE_DATA). */
  data?: { id: string; need: string }[];
  /** Testable claims only: the id of the comparison card the program creates. */
  comparisonNodeId?: string;
}
export interface NewMapInput {
  runId: string;
  roles: ArgumentRoles;
  claims: ClaimDraft[];
}
export interface PredictionDraft {
  id: string;
  kind: PredictionKind;
  text: string;
  required: boolean;
  alsoPredictedBy?: OverlapEntry[];
  auxiliary?: string[];
  reason?: string;
}
export interface HypothesisDraft {
  id: string;
  role: HypothesisRole;
  predictions: PredictionDraft[];
  identification?: Identification;
}
export interface NeedDraft {
  id: string;
  predictionId: string;
  text: string;
  criteria: Criteria;
}
export interface RoundNeedDraft extends NeedDraft {
  /** The id of a dead need of this hypothesis this one stands in for. Without it the need is exploratory. */
  replaces?: string;
}
export interface AssessmentDraft {
  relevant: boolean;
  stance: string;
  scopeFit: boolean;
  scopeNote?: string;
  sourceType: string;
  underlyingSource: string;
  alsoRelevantTo: string[];
}

const TERMINAL = ["concluded", "stopped_premise"];
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const blank = (value: unknown): boolean => typeof value !== "string" || value.trim() === "";
const isTerminal = (state: ArgumentMapData): boolean => TERMINAL.includes(state.run.phase);
const oneOf = <T extends string>(list: readonly T[], value: unknown): value is T =>
  typeof value === "string" && (list as readonly string[]).includes(value);

function live(state: ArgumentMapData): void {
  if (isTerminal(state)) throw new GateError(`run is finished (${state.run.phase})`);
}
function running(state: ArgumentMapData): void {
  live(state);
  if (state.run.status !== "running") throw new GateError("run is not running");
}
function inPremises(state: ArgumentMapData): void {
  live(state);
  if (state.run.phase !== "premises") throw new GateError("the premise phase is over");
}
function inAnalysis(state: ArgumentMapData): void {
  live(state);
  if (state.run.phase !== "analysis") throw new GateError("the premises are not settled");
}
function allIds(state: ArgumentMapData): Set<string> {
  const ids = new Set<string>(Object.values(state.roles));
  for (const claim of state.claims) {
    ids.add(claim.id);
    for (const datum of claim.data ?? []) ids.add(datum.id);
    if (claim.comparison) ids.add(claim.comparison.nodeId);
  }
  for (const h of state.hypotheses) {
    ids.add(h.id);
    for (const p of h.predictions) ids.add(p.id);
    for (const need of h.needs) ids.add(need.id);
  }
  return ids;
}
function newId(ids: Set<string>, id: unknown): string {
  if (blank(id)) throw new GateError("empty id");
  const text = id as string;
  if (ids.has(text)) throw new GateError(`duplicate id ${text}`);
  ids.add(text);
  return text;
}
/** A proof must come from a source check: an http(s) URL, a quote, a claim, a known check kind and a time. */
function checkedProof(value: unknown): SourceProof {
  const p = value as Partial<SourceProof> | undefined;
  if (!p || typeof p !== "object" || blank(p.url) || blank(p.quote) || blank(p.claim) || blank(p.checkedAt))
    throw new GateError("evidence needs a source");
  if (!oneOf(PROOF_CHECKS, p.check)) throw new GateError("unknown source check");
  let protocol = "";
  try {
    protocol = new URL(p.url as string).protocol;
  } catch {
    throw new GateError("source url is not a url");
  }
  if (protocol !== "http:" && protocol !== "https:") throw new GateError("source url must be http(s)");
  return {
    url: p.url as string,
    quote: p.quote as string,
    claim: p.claim as string,
    check: p.check,
    checkedAt: p.checkedAt as string
  };
}
/** An assessment's fields, checked: relevance and stance agree, a scope miss says why, other hypotheses are of the same claim. */
function checkedAssessment(value: unknown, siblings: ReadonlySet<string>): Assessment {
  const a = value as Partial<AssessmentDraft> | null | undefined;
  if (!a || typeof a !== "object") throw new GateError("assessment missing");
  if (typeof a.relevant !== "boolean" || typeof a.scopeFit !== "boolean") throw new GateError("assessment malformed");
  if (!oneOf(EVIDENCE_STANCES, a.stance)) throw new GateError("unknown assessment stance");
  if (a.relevant !== (a.stance !== "irrelevant")) throw new GateError("assessment relevance and stance disagree");
  if (!a.scopeFit && blank(a.scopeNote)) throw new GateError("a scope miss needs a note");
  if (blank(a.sourceType) || blank(a.underlyingSource))
    throw new GateError("assessment needs a source type and an underlying source");
  const also = Array.isArray(a.alsoRelevantTo) ? a.alsoRelevantTo : [];
  if (also.some(id => !siblings.has(id))) throw new GateError("alsoRelevantTo names a hypothesis outside this claim");
  const out: Assessment = {
    relevant: a.relevant,
    stance: a.stance,
    scopeFit: a.scopeFit,
    sourceType: a.sourceType as string,
    underlyingSource: a.underlyingSource as string,
    alsoRelevantTo: [...new Set(also)]
  };
  if (typeof a.scopeNote === "string" && a.scopeNote.trim() !== "") out.scopeNote = a.scopeNote;
  return out;
}
function claimOf(state: ArgumentMapData, id: string): Claim {
  const found = state.claims.find(c => c.id === id);
  if (!found) throw new GateError(`unknown claim ${id}`);
  return found;
}
function openPremise(state: ArgumentMapData, id: string): Claim {
  const claim = claimOf(state, id);
  if (claim.role !== "premise") throw new GateError(`${id} is not a premise`);
  if (claim.status === "done" || claim.status === "not_evaluated") throw new GateError(`premise ${id} is closed`);
  return claim;
}
function liveTestable(state: ArgumentMapData, id: string): Claim {
  const claim = claimOf(state, id);
  if (claim.role !== "testable") throw new GateError(`${id} is not a testable claim`);
  if (claim.status === "not_evaluated") throw new GateError(`claim ${id} was not evaluated`);
  return claim;
}
/** An open hypothesis (no verdict yet) of a claim that was not stopped. */
function hypothesisOf(state: ArgumentMapData, id: string): Hypothesis {
  const found = state.hypotheses.find(h => h.id === id);
  if (!found) throw new GateError(`unknown hypothesis ${id}`);
  liveTestable(state, found.claimId);
  if (found.verdict !== undefined) throw new GateError(`hypothesis ${id} already has a verdict`);
  return found;
}
const premisesOf = (state: ArgumentMapData): Claim[] => state.claims.filter(c => c.role === "premise");
const budgetLeft = (state: ArgumentMapData): number => MAX_RESEARCH_CALLS - state.run.researchCalls;
const verifiedProof = (item: { proof?: SourceProof }): boolean => item.proof?.check === "page_match";

// ---- creation -----------------------------------------------------------------------------------------------------------------
/**
 * Builds a map from a locked framing and the breakdown it produced. Nothing is built unless the user confirmed (`lockedAt`), the chosen
 * question is one of the candidates and every claim is of a legal type and role. There is no reducer that edits the framing, the claims'
 * text, type, role, dependencies or definitions afterwards.
 */
export function newArgumentMap(framing: Framing, input: NewMapInput): ArgumentMapData {
  if (!framing || typeof framing !== "object") throw new GateError("framing missing");
  if (blank(framing.lockedAt)) throw new GateError("the framing is not locked");
  if (blank(framing.original) || blank(framing.restatement))
    throw new GateError("framing needs the original and a restatement");
  if (!Number.isInteger(framing.attempts) || framing.attempts < 1 || framing.attempts > MAX_FRAMING_CALLS)
    throw new GateError("framing attempts out of range");
  if (!Array.isArray(framing.candidates) || framing.candidates.length === 0)
    throw new GateError("framing has no candidate question");
  const candidateIds = new Set<string>();
  for (const candidate of framing.candidates) {
    if (blank(candidate?.id) || candidateIds.has(candidate.id))
      throw new GateError("candidate id missing or duplicated");
    candidateIds.add(candidate.id);
    if (blank(candidate.question) || blank(candidate.answerShape)) throw new GateError("candidate malformed");
    if (!oneOf(CANDIDATE_KINDS, candidate.kind)) throw new GateError("unknown candidate kind");
  }
  if (!candidateIds.has(framing.chosen)) throw new GateError("the chosen question is not a candidate");
  if (blank(input?.runId)) throw new GateError("a run needs an id");
  const roleIds = Object.values(input.roles ?? {});
  if (roleIds.length !== 3 || roleIds.some(blank)) throw new GateError("roles missing");
  const drafts = Array.isArray(input.claims) ? input.claims : [];
  const premises = drafts.filter(c => c.role === "premise");
  const testable = drafts.filter(c => c.role === "testable");
  if (premises.length + testable.length !== drafts.length) throw new GateError("unknown claim role");
  if (premises.length > MAX_PREMISES) throw new GateError("too many premises");
  if (testable.length < 1 || testable.length > MAX_TESTABLE) throw new GateError("a map needs 1 or 2 testable claims");
  const ids = new Set<string>();
  for (const id of roleIds) newId(ids, id);
  const claims: Claim[] = [];
  for (const draft of drafts) {
    newId(ids, draft.id);
    if (blank(draft.text)) throw new GateError("empty claim");
    if (!oneOf(CLAIM_TYPES, draft.type) || !oneOf(CLAIM_ROLES, draft.role))
      throw new GateError("unknown claim type or role");
    if (!Array.isArray(draft.dependsOn) || !Array.isArray(draft.definitions)) throw new GateError("claim malformed");
    for (const d of draft.definitions)
      if (blank(d?.term) || blank(d?.meaning)) throw new GateError("definition malformed");
    const claim: Claim = {
      id: draft.id,
      text: draft.text,
      type: draft.type,
      role: draft.role,
      dependsOn: [...draft.dependsOn],
      definitions: draft.definitions.map(d => ({ term: d.term, meaning: d.meaning })),
      status: "pending"
    };
    if (draft.role === "premise") {
      if (draft.type !== "fact") throw new GateError("only a fact can be a premise");
      if (draft.comparisonNodeId !== undefined) throw new GateError("a premise has no comparison card");
      const data = Array.isArray(draft.data) ? draft.data : [];
      if (data.length < 1 || data.length > MAX_PREMISE_DATA) throw new GateError("a premise needs 1 or 2 data");
      claim.data = data.map(d => {
        if (blank(d?.need)) throw new GateError("empty premise need");
        return { id: newId(ids, d.id), need: d.need, attempts: 0, state: "pending" };
      });
    } else {
      if (draft.data !== undefined) throw new GateError("only a premise carries data");
      claim.comparison = {
        nodeId: newId(ids, draft.comparisonNodeId),
        attempts: 0,
        state: "pending",
        vetoes: [],
        allocations: [],
        missedAlternativeAdded: false
      };
    }
    claims.push(claim);
  }
  const byId = new Map(claims.map(c => [c.id, c]));
  for (const claim of claims)
    for (const dep of claim.dependsOn) {
      const target = byId.get(dep);
      if (!target || target === claim) throw new GateError("a claim depends on an unknown claim or on itself");
      if (target.role !== "premise") throw new GateError("a claim can only depend on a premise");
    }
  // premise dependencies must not loop
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const walk = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new GateError("premise dependencies loop");
    visiting.add(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) walk(dep);
    visiting.delete(id);
    visited.add(id);
  };
  for (const claim of claims) walk(claim.id);
  const state: ArgumentMapData = {
    v: 2,
    roles: { ...input.roles },
    framing: clone(framing),
    claims,
    hypotheses: [],
    run: { runId: input.runId, phase: premises.length ? "premises" : "analysis", status: "running", researchCalls: 0 },
    conclusion: { state: "pending", answers: [], deleted: [] }
  };
  return state;
}

// ---- test status (derived, never stored) -----------------------------------------------------------------------------------------
/** A need that counts: its own proof was checked against the page, and its assessment says relevant and in scope. */
const qualifies = (need: Need): boolean =>
  need.state === "found" &&
  verifiedProof(need) &&
  !!need.assessment &&
  need.assessment.relevant &&
  need.assessment.scopeFit;
/** A need is met by itself, or by a replacement the assessment confirmed to test the same condition. */
const met = (h: Hypothesis, need: Need): boolean =>
  qualifies(need) ||
  h.needs.some(r => r.replaces === need.id && r.sameCondition === true && r.registered === "pre" && qualifies(r));
/** A required prediction holds only when it has pre-registered needs and each of them is met. Exploratory needs never count. */
function requiredMet(h: Hypothesis): boolean {
  const required = h.predictions.filter(p => p.required);
  if (!required.length) return false;
  return required.every(p => {
    const own = h.needs.filter(n => n.predictionId === p.id && n.registered === "pre" && n.replaces === undefined);
    return own.length > 0 && own.every(n => met(h, n));
  });
}
const awaitingAssessment = (h: Hypothesis): boolean => h.needs.some(n => n.state === "found" && !n.assessment);
const canAddRound = (h: Hypothesis): boolean => h.round < MAX_ROUND && h.needs.length < MAX_NEEDS;
/**
 * `in_progress`, `complete` or `limit_incomplete` (methodology 6). Derived from the needs, never stored. Only checked, assessed, relevant,
 * in-scope, pre-registered evidence meets a required test; "looked and found nothing" never does. `limit_incomplete`: nothing is in
 * flight, nothing is left to research and no round or need can be added (or the whole map's research budget is spent).
 */
export function testStatus(h: Hypothesis, researchCalls = 0): "in_progress" | "complete" | "limit_incomplete" {
  if (requiredMet(h)) return "complete";
  if (h.needs.some(n => n.state === "searching") || awaitingAssessment(h)) return "in_progress";
  const exhausted = researchCalls >= MAX_RESEARCH_CALLS;
  if (!exhausted && h.needs.some(n => n.state === "pending")) return "in_progress";
  if (exhausted) return "limit_incomplete";
  return canAddRound(h) ? "in_progress" : "limit_incomplete";
}
/** True when a checked, relevant, in-scope piece of evidence was assessed as refuting: then only the AI may judge this hypothesis. */
export const hasVerifiedRefutation = (h: Hypothesis): boolean =>
  h.needs.some(n => qualifies(n) && n.assessment?.stance === "refutes");

// ---- next actions -----------------------------------------------------------------------------------------------------------------
function premiseActions(state: ArgumentMapData, claim: Claim): ArgumentAction[] {
  const data = claim.data ?? [];
  if (data.some(d => d.state === "searching")) return [];
  const actions: ArgumentAction[] = [];
  let budget = budgetLeft(state);
  for (const datum of data)
    if (datum.state === "pending" && datum.attempts < MAX_PREMISE_ATTEMPTS && budget > 0) {
      actions.push({ type: "research_premise", claimId: claim.id, dataId: datum.id });
      budget -= 1;
    }
  if (actions.length) return actions;
  if (data.some(d => d.state !== "found")) return [{ type: "premise_missing", claimId: claim.id }];
  return [{ type: data.every(d => d.assessment) ? "judge_premise" : "assess_premise", claimId: claim.id }];
}

function hypothesisActions(state: ArgumentMapData, h: Hypothesis): ArgumentAction[] {
  if (h.verdict !== undefined) return [];
  if (h.needs.some(n => n.state === "searching") && !h.needs.some(n => n.state === "pending")) return [];
  const calls = state.run.researchCalls;
  if (h.needs.length === 0)
    return [{ type: calls >= MAX_RESEARCH_CALLS ? "program_verdict" : "add_needs", hypothesisId: h.id }];
  const actions: ArgumentAction[] = [];
  let budget = budgetLeft(state);
  for (const need of h.needs)
    if (need.state === "pending" && budget > 0) {
      actions.push({ type: "research_need", hypothesisId: h.id, needId: need.id });
      budget -= 1;
    }
  if (actions.length || h.needs.some(n => n.state === "searching")) return actions;
  if (awaitingAssessment(h)) return [{ type: "assess_evidence", hypothesisId: h.id }];
  const status = testStatus(h, calls);
  if (status === "complete") return [{ type: "verdict", hypothesisId: h.id }];
  if (status === "limit_incomplete")
    return [{ type: hasVerifiedRefutation(h) ? "verdict" : "program_verdict", hypothesisId: h.id }];
  return [{ type: "next_round", hypothesisId: h.id }];
}

/** Everything the runner may do next. Paused and finished runs have none. Stopped claims never appear. */
export function nextActions(state: ArgumentMapData): ArgumentAction[] {
  if (isTerminal(state) || state.run.status !== "running") return [];
  if (state.run.phase === "premises") {
    const out: ArgumentAction[] = [];
    for (const claim of premisesOf(state))
      if (claim.status === "pending" || claim.status === "in_progress") out.push(...premiseActions(state, claim));
    return out;
  }
  if (state.run.phase !== "analysis") return [];
  const out: ArgumentAction[] = [];
  for (const claim of state.claims) {
    if (claim.role !== "testable" || claim.status === "not_evaluated") continue;
    const own = state.hypotheses.filter(h => h.claimId === claim.id);
    if (own.length === 0) out.push({ type: "propose_hypotheses", claimId: claim.id });
    for (const h of own) out.push(...hypothesisActions(state, h));
  }
  return out;
}

// ---- premises ---------------------------------------------------------------------------------------------------------------------
function datumOf(claim: Claim, id: string): PremiseDatum {
  const datum = claim.data?.find(d => d.id === id);
  if (!datum) throw new GateError(`unknown premise datum ${id}`);
  return datum;
}

export function beginPremiseResearch(state: ArgumentMapData, claimId: string, dataId: string): ArgumentMapData {
  inPremises(state);
  running(state);
  const next = clone(state);
  const claim = openPremise(next, claimId);
  const datum = datumOf(claim, dataId);
  if (datum.state !== "pending") throw new GateError("premise datum is not waiting for research");
  if (datum.attempts >= MAX_PREMISE_ATTEMPTS) throw new GateError("premise datum is out of attempts");
  if (next.run.researchCalls >= MAX_RESEARCH_CALLS) throw new GateError("research call limit reached");
  datum.attempts += 1;
  datum.state = "searching";
  claim.status = "in_progress";
  next.run.researchCalls += 1;
  return next;
}

export function applyPremiseEvidence(
  state: ArgumentMapData,
  claimId: string,
  dataId: string,
  result: EvidenceResult
): ArgumentMapData {
  inPremises(state);
  const next = clone(state);
  const datum = datumOf(openPremise(next, claimId), dataId);
  if (datum.state !== "searching") throw new GateError("premise datum is not being researched");
  if (result.found === true) {
    datum.proof = checkedProof(result.proof);
    if (result.stance === "supports" || result.stance === "opposes") datum.stance = result.stance;
    datum.state = "found";
    return next;
  }
  if (blank(result.reason)) throw new GateError("a miss needs a reason");
  datum.reason = result.reason;
  datum.state = datum.attempts >= MAX_PREMISE_ATTEMPTS ? "not_found" : "pending";
  return next;
}

/** A provider failure is not a try (the model never answered): the datum goes back to pending and its attempt is refunded. The call stays counted. */
export function releasePremiseResearch(state: ArgumentMapData, claimId: string, dataId: string): ArgumentMapData {
  inPremises(state);
  const next = clone(state);
  const datum = datumOf(openPremise(next, claimId), dataId);
  if (datum.state !== "searching") throw new GateError("premise datum is not being researched");
  datum.state = "pending";
  datum.attempts -= 1;
  return next;
}

/** The claims that rest on `claimId`, directly or through other claims. */
function dependents(state: ArgumentMapData, claimId: string): Claim[] {
  const hit = new Set<string>([claimId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of state.claims)
      if (!hit.has(c.id) && c.dependsOn.some(d => hit.has(d))) {
        hit.add(c.id);
        grew = true;
      }
  }
  hit.delete(claimId);
  return state.claims.filter(c => hit.has(c.id));
}

/** After a premise closed: when every premise is closed the run moves to analysis, or stops if every testable claim was stopped. */
function settlePremises(next: ArgumentMapData): ArgumentMapData {
  if (!premisesOf(next).every(c => c.status === "done" || c.status === "not_evaluated")) return next;
  const testable = next.claims.filter(c => c.role === "testable");
  if (!testable.every(c => c.status === "not_evaluated")) {
    next.run.phase = "analysis";
    return next;
  }
  const blockers = premisesOf(next).filter(c => c.result === "fails" || c.result === "insufficient");
  const onlyMissing = blockers.length > 0 && blockers.every(c => (c.data ?? []).some(d => d.state === "not_found"));
  next.run.phase = "stopped_premise";
  next.run.status = "finished";
  next.run.stopReason = (onlyMissing ? "data_missing" : "premise") satisfies StopReason;
  next.conclusion = { state: "stopped_premise", answers: [], deleted: [] };
  return next;
}

function closePremise(next: ArgumentMapData, claim: Claim, result: PremiseResult): ArgumentMapData {
  claim.result = result;
  claim.status = "done";
  if (result !== "holds") for (const dependent of dependents(next, claim.id)) dependent.status = "not_evaluated";
  return settlePremises(next);
}

/** The premise's data are not all found and nothing more can be searched: the program decides "insufficient", no AI. */
export function applyPremiseMissing(state: ArgumentMapData, claimId: string): ArgumentMapData {
  inPremises(state);
  const next = clone(state);
  const claim = openPremise(next, claimId);
  const data = claim.data ?? [];
  if (data.some(d => d.state === "searching")) throw new GateError("premise data are still being researched");
  const researchable = (d: PremiseDatum): boolean =>
    d.state === "pending" && d.attempts < MAX_PREMISE_ATTEMPTS && next.run.researchCalls < MAX_RESEARCH_CALLS;
  if (data.some(researchable)) throw new GateError("premise data can still be researched");
  if (data.every(d => d.state === "found")) throw new GateError("no premise datum is missing");
  for (const d of data)
    if (d.state === "pending") {
      d.state = "not_found";
      d.reason = d.reason ?? "research limit reached";
    }
  return closePremise(next, claim, "insufficient");
}

/** One call per premise: every found datum is assessed together. */
export function applyPremiseAssessments(
  state: ArgumentMapData,
  claimId: string,
  items: { datumId: string; assessment: AssessmentDraft }[]
): ArgumentMapData {
  inPremises(state);
  const next = clone(state);
  const claim = openPremise(next, claimId);
  const data = claim.data ?? [];
  if (data.some(d => d.state !== "found" || !d.proof)) throw new GateError("every premise datum must be found first");
  const todo = data.filter(d => !d.assessment);
  const given = Array.isArray(items) ? items : [];
  if (!todo.length || given.length !== todo.length || new Set(given.map(i => i?.datumId)).size !== todo.length)
    throw new GateError("assess every unassessed premise datum, once");
  for (const item of given) {
    const datum = todo.find(d => d.id === item.datumId);
    if (!datum) throw new GateError("assessment names a datum outside this premise");
    datum.assessment = checkedAssessment(item.assessment, new Set());
  }
  return next;
}

/**
 * The AI's premise result. `holds` and `fails` must cite data of this premise whose source was checked against the page and was assessed
 * relevant and in scope; a tool-log quote alone gives only `insufficient`.
 */
export function applyPremiseResult(
  state: ArgumentMapData,
  claimId: string,
  verdict: { result: unknown; reason: string; citedData: string[] }
): ArgumentMapData {
  inPremises(state);
  const next = clone(state);
  const claim = openPremise(next, claimId);
  const data = claim.data ?? [];
  if (data.some(d => d.state !== "found" || !d.assessment))
    throw new GateError("every premise datum must be found and assessed first");
  if (!oneOf(PREMISE_RESULTS, verdict.result)) throw new GateError("unknown premise result");
  if (blank(verdict.reason)) throw new GateError("a premise result needs a reason");
  const cited = Array.isArray(verdict.citedData) ? verdict.citedData : [];
  const known = new Map(data.map(d => [d.id, d]));
  if (cited.some(id => !known.has(id))) throw new GateError("the result cites data outside the premise");
  if (verdict.result !== "insufficient") {
    if (!cited.length) throw new GateError("holds and fails must cite data");
    for (const id of cited) {
      const datum = known.get(id) as PremiseDatum;
      if (!verifiedProof(datum) || !datum.assessment?.relevant || !datum.assessment.scopeFit)
        throw new GateError("a premise result may only rest on checked, relevant, in-scope data");
    }
  }
  return closePremise(next, claim, verdict.result);
}

// ---- hypotheses -------------------------------------------------------------------------------------------------------------------
const CAUSAL_ROLES: readonly HypothesisRole[] = ["primary", "alternative", "reverse", "common_cause"];
const ROLES_OF: Record<ClaimType, readonly HypothesisRole[]> = {
  fact: ["facet"],
  causal: CAUSAL_ROLES,
  main_cause: CAUSAL_ROLES,
  comparison: ["primary", "alternative", "measurement"]
};
function checkFloor(type: ClaimType, roles: HypothesisRole[]): void {
  const n = (role: HypothesisRole): number => roles.filter(r => r === role).length;
  if (roles.some(r => !ROLES_OF[type].includes(r)))
    throw new GateError("a hypothesis role does not fit the claim type");
  if (type === "fact" && n("facet") < 2) throw new GateError("a fact needs at least 2 facets");
  if (type === "comparison" && !(n("primary") === 1 && n("alternative") >= 1 && n("measurement") >= 1))
    throw new GateError("a comparison needs A, B and a measurement explanation");
  if ((type === "causal" || type === "main_cause") && !(n("primary") === 1 && roles.length >= 3))
    throw new GateError("a cause needs H-Y and 2 alternatives");
}

/** Every hypothesis of a claim at once (the floor is a property of the set). Each prediction is checked field by field. */
export function applyHypotheses(state: ArgumentMapData, claimId: string, items: HypothesisDraft[]): ArgumentMapData {
  inAnalysis(state);
  const type = liveTestable(state, claimId).type;
  if (state.hypotheses.some(h => h.claimId === claimId)) throw new GateError("the claim already has hypotheses");
  if (!Array.isArray(items) || !items.length) throw new GateError("no hypotheses");
  if (state.hypotheses.length + items.length > MAX_HYPOTHESES) throw new GateError("hypothesis limit reached");
  checkFloor(
    type,
    items.map(i => i?.role)
  );
  const next = clone(state);
  const claim = claimOf(next, claimId);
  const ids = allIds(next);
  const batch = new Set(items.map(i => i.id));
  if (batch.size !== items.length) throw new GateError("duplicate hypothesis id");
  const premiseIds = new Set(premisesOf(next).map(c => c.id));
  const causal = claim.type === "causal" || claim.type === "main_cause";
  for (const item of items) {
    const id = newId(ids, item.id);
    if (
      !oneOf(["primary", "alternative", "reverse", "common_cause", "measurement", "facet", "side"] as const, item.role)
    )
      throw new GateError("unknown hypothesis role");
    const predictions = Array.isArray(item.predictions) ? item.predictions : [];
    if (!predictions.some(p => p?.kind === "support") || !predictions.some(p => p?.kind === "refute"))
      throw new GateError("a hypothesis needs a support and a refute prediction");
    if (!predictions.some(p => p?.required === true)) throw new GateError("a hypothesis needs a required test");
    const h: Hypothesis = { id, claimId, role: item.role, round: 1, predictions: [], needs: [] };
    for (const p of predictions) {
      if (!p || !oneOf(PREDICTION_KINDS, p.kind)) throw new GateError("unknown prediction kind");
      if (blank(p.text) || typeof p.required !== "boolean") throw new GateError("prediction malformed");
      const prediction = {
        id: newId(ids, p.id),
        kind: p.kind,
        text: p.text,
        alsoPredictedBy: [] as OverlapEntry[],
        auxiliary: [] as string[],
        required: p.required
      };
      if (p.kind === "support") {
        if (!Array.isArray(p.alsoPredictedBy))
          throw new GateError("a support prediction must say who else predicts it");
        for (const entry of p.alsoPredictedBy) {
          if (!oneOf(OVERLAP_STRENGTHS, entry?.strength)) throw new GateError("unknown overlap strength");
          if (!batch.has(entry.hypothesisId) || entry.hypothesisId === id)
            throw new GateError("alsoPredictedBy names an unknown hypothesis");
          prediction.alsoPredictedBy.push({ hypothesisId: entry.hypothesisId, strength: entry.strength });
        }
      }
      if (p.kind === "refute") {
        if (!Array.isArray(p.auxiliary) || !p.auxiliary.length || p.auxiliary.some(a => !premiseIds.has(a)))
          throw new GateError("a refute prediction needs auxiliary premises");
        if (blank(p.reason)) throw new GateError("a refute prediction needs a reason");
        prediction.auxiliary = [...new Set(p.auxiliary)];
        Object.assign(prediction, { reason: p.reason });
      }
      h.predictions.push(prediction);
    }
    if (causal && CAUSAL_ROLES.includes(item.role)) {
      const ident = item.identification;
      if (
        !ident ||
        blank(ident.strategy) ||
        !Array.isArray(ident.assumptions) ||
        !ident.assumptions.length ||
        ident.assumptions.some(blank)
      )
        throw new GateError("a cause needs an identification strategy and its assumptions");
      h.identification = { strategy: ident.strategy, assumptions: [...ident.assumptions] };
    } else if (item.identification) h.identification = clone(item.identification);
    next.hypotheses.push(h);
  }
  claim.status = "in_progress";
  return next;
}

// ---- needs ------------------------------------------------------------------------------------------------------------------------
/** True once any of the hypothesis' needs was dispatched: from then on every need added is `post`. */
const researchBegan = (h: Hypothesis): boolean =>
  h.round > 1 || h.needs.some(n => n.state === "searching" || n.state === "found" || n.state === "not_found");

function needFrom(item: NeedDraft, h: Hypothesis, ids: Set<string>, registered: Need["registered"]): Need {
  if (blank(item?.text)) throw new GateError("empty need");
  const prediction = h.predictions.find(p => p.id === item.predictionId);
  if (!prediction) throw new GateError("a need must name a prediction of its hypothesis");
  const c = item.criteria;
  if (!c || blank(c.supports) || blank(c.refutes) || blank(c.irrelevant))
    throw new GateError("a need must say what counts as support, refutation and irrelevance");
  return {
    id: newId(ids, item.id),
    predictionId: prediction.id,
    text: item.text,
    criteria: { supports: c.supports, refutes: c.refutes, irrelevant: c.irrelevant },
    registered,
    addedRound: h.round,
    state: "pending"
  };
}

/**
 * Lists a hypothesis' first needs. Add-only: there is no reducer that removes, rewrites or loosens a need. Needs listed before the first
 * research dispatch are pre-registered; every required prediction must have at least one.
 */
export function applyNeeds(state: ArgumentMapData, hypothesisId: string, items: NeedDraft[]): ArgumentMapData {
  inAnalysis(state);
  const next = clone(state);
  const h = hypothesisOf(next, hypothesisId);
  if (h.needs.length) throw new GateError("the needs are already listed");
  if (!Array.isArray(items) || !items.length) throw new GateError("no needs");
  if (items.length > MAX_ROUND_NEEDS) throw new GateError("too many needs in this round");
  const ids = allIds(next);
  for (const item of items) h.needs.push(needFrom(item, h, ids, researchBegan(h) ? "post" : "pre"));
  for (const p of h.predictions)
    if (p.required && !h.needs.some(n => n.predictionId === p.id))
      throw new GateError("every required prediction needs a need");
  return next;
}

/**
 * Round 2 or 3: only replacement needs (for a dead need of an earlier round, the same prediction, once) or exploratory ones. Both are
 * `post` until the evidence assessment confirms a replacement tests the same condition.
 */
export function startNextRound(state: ArgumentMapData, hypothesisId: string, items: RoundNeedDraft[]): ArgumentMapData {
  inAnalysis(state);
  const next = clone(state);
  const h = hypothesisOf(next, hypothesisId);
  if (!h.needs.length || h.needs.some(n => n.state === "pending" || n.state === "searching"))
    throw new GateError("the round is not finished");
  if (h.needs.some(n => !n.assessment && n.state === "found")) throw new GateError("the round is not assessed");
  if (testStatus(h) === "complete") throw new GateError("the tests are already complete");
  if (h.round >= MAX_ROUND) throw new GateError("round limit reached");
  if (!Array.isArray(items) || !items.length) throw new GateError("no needs");
  if (items.length > MAX_ROUND_NEEDS || h.needs.length + items.length > MAX_NEEDS)
    throw new GateError("too many needs");
  h.round += 1;
  const ids = allIds(next);
  const replaced = new Set(h.needs.map(n => n.replaces).filter((id): id is string => id !== undefined));
  for (const item of items) {
    const need = needFrom(item, h, ids, "post");
    if (item.replaces !== undefined) {
      const target = h.needs.find(n => n.id === item.replaces);
      if (!target || target.state !== "not_found" || target.addedRound >= h.round || replaced.has(target.id))
        throw new GateError("a replacement must stand in for a dead need of an earlier round, once");
      if (target.predictionId !== need.predictionId) throw new GateError("a replacement must test the same prediction");
      replaced.add(target.id);
      need.replaces = target.id;
    }
    h.needs.push(need);
  }
  return next;
}

// ---- research ---------------------------------------------------------------------------------------------------------------------
export function beginResearch(state: ArgumentMapData, hypothesisId: string, needId: string): ArgumentMapData {
  inAnalysis(state);
  running(state);
  const next = clone(state);
  const need = hypothesisOf(next, hypothesisId).needs.find(n => n.id === needId);
  if (!need || need.state !== "pending") throw new GateError("need is not waiting for research");
  if (next.run.researchCalls >= MAX_RESEARCH_CALLS) throw new GateError("research call limit reached");
  need.state = "searching";
  next.run.researchCalls += 1;
  return next;
}

export function applyEvidence(
  state: ArgumentMapData,
  hypothesisId: string,
  needId: string,
  result: EvidenceResult
): ArgumentMapData {
  inAnalysis(state);
  const next = clone(state);
  const need = hypothesisOf(next, hypothesisId).needs.find(n => n.id === needId);
  if (!need || need.state !== "searching") throw new GateError("need is not being researched");
  if (result.found === true) {
    need.proof = checkedProof(result.proof);
    need.state = "found";
    return next;
  }
  if (blank(result.reason)) throw new GateError("a miss needs a reason");
  need.reason = result.reason;
  need.state = "not_found";
  return next;
}

/** A provider failure is not a try (the model never answered): the need goes back to pending. `researchCalls` keeps the call. */
export function releaseNeedResearch(state: ArgumentMapData, hypothesisId: string, needId: string): ArgumentMapData {
  inAnalysis(state);
  const next = clone(state);
  const need = hypothesisOf(next, hypothesisId).needs.find(n => n.id === needId);
  if (!need || need.state !== "searching") throw new GateError("need is not being researched");
  need.state = "pending";
  return next;
}

/**
 * The independent evidence assessment of one settled round: every found, unassessed need of the hypothesis at once. For a replacement
 * need it must also say whether it tests the same condition; only `true` makes it pre-registered.
 */
export function applyEvidenceAssessment(
  state: ArgumentMapData,
  hypothesisId: string,
  items: { needId: string; assessment: AssessmentDraft; sameCondition?: boolean }[]
): ArgumentMapData {
  inAnalysis(state);
  const next = clone(state);
  const h = hypothesisOf(next, hypothesisId);
  if (h.needs.some(n => n.state === "pending" || n.state === "searching"))
    throw new GateError("the round is still being researched");
  const todo = h.needs.filter(n => n.state === "found" && !n.assessment);
  const given = Array.isArray(items) ? items : [];
  if (!todo.length || given.length !== todo.length || new Set(given.map(i => i?.needId)).size !== todo.length)
    throw new GateError("assess every found, unassessed need of the round, once");
  const siblings = new Set(next.hypotheses.filter(o => o.claimId === h.claimId && o.id !== h.id).map(o => o.id));
  for (const item of given) {
    const need = todo.find(n => n.id === item.needId);
    if (!need) throw new GateError("assessment names a need that is not waiting for one");
    need.assessment = checkedAssessment(item.assessment, siblings);
    if (need.replaces !== undefined) {
      if (typeof item.sameCondition !== "boolean")
        throw new GateError("a replacement assessment must say whether it is the same condition");
      need.sameCondition = item.sameCondition;
      if (item.sameCondition) need.registered = "pre";
    } else if (item.sameCondition !== undefined) throw new GateError("sameCondition belongs to a replacement need");
  }
  return next;
}

// ---- verdict by the program ---------------------------------------------------------------------------------------------------------
/**
 * The research limit decides without the AI: a hypothesis whose test is `limit_incomplete` and that has no checked, relevant, in-scope
 * evidence assessed as refuting is `insufficient` by the program. Nothing is called and `researchCalls` is untouched.
 */
export function applyProgramVerdict(state: ArgumentMapData, hypothesisId: string): ArgumentMapData {
  inAnalysis(state);
  const next = clone(state);
  const h = hypothesisOf(next, hypothesisId);
  if (testStatus(h, next.run.researchCalls) !== "limit_incomplete") throw new GateError("the test is not at its limit");
  if (hasVerifiedRefutation(h)) throw new GateError("refuting evidence exists: the verdict needs the AI");
  const open = h.predictions.filter(p => p.required && !requiredPrediction(h, p.id)).map(p => p.id);
  h.verdict = {
    value: "insufficient",
    by: "program",
    reason: `limit_incomplete: required tests without checked evidence: ${open.join(", ") || "none"}`,
    citedNeeds: [],
    counterNotes: [],
    refutations: [],
    causal: "not_applicable",
    assumptionStatus: [],
    confidence: "low",
    reverdicts: 0
  };
  return next;
}
function requiredPrediction(h: Hypothesis, predictionId: string): boolean {
  const own = h.needs.filter(
    n => n.predictionId === predictionId && n.registered === "pre" && n.replaces === undefined
  );
  return own.length > 0 && own.every(n => met(h, n));
}

// ---- user mark, pause and resume -----------------------------------------------------------------------------------------------------
/** The user's own reading: a mark only. It is never read by `testStatus`, `nextActions` or any input of a later step. `undefined` clears it. */
export function applyUserVerdict(
  state: ArgumentMapData,
  hypothesisId: string,
  value: VerdictValue | undefined
): ArgumentMapData {
  if (value !== undefined && !oneOf(VERDICT_VALUES, value)) throw new GateError("unknown verdict");
  const next = clone(state);
  const h = next.hypotheses.find(o => o.id === hypothesisId);
  if (!h) throw new GateError(`unknown hypothesis ${hypothesisId}`);
  if (value === undefined) delete h.userVerdict;
  else h.userVerdict = value;
  return next;
}

export function applyPause(
  state: ArgumentMapData,
  reason: Extract<StopReason, "user" | "interrupted" | "error">
): ArgumentMapData {
  live(state);
  if (!["user", "interrupted", "error"].includes(reason)) throw new GateError("unknown pause reason");
  const next = clone(state);
  for (const claim of next.claims) for (const d of claim.data ?? []) if (d.state === "searching") d.state = "pending";
  for (const h of next.hypotheses) for (const need of h.needs) if (need.state === "searching") need.state = "pending";
  next.run.status = "paused";
  next.run.stopReason = reason;
  return next;
}

/** Only a paused, unfinished run resumes. The call counter stays as it was. */
export function applyResume(state: ArgumentMapData): ArgumentMapData {
  live(state);
  if (state.run.status !== "paused") throw new GateError("the run is not paused");
  const next = clone(state);
  next.run.status = "running";
  delete next.run.stopReason;
  return next;
}
