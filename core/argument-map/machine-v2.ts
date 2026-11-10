/**
 * Argument map state machine, version 2 (methodology 6, spec docs/history/tasks/2026-11-09-argument-map-layout). Pure: `nextActions(state)`
 * says what may happen next and the `apply*`/`begin*`/`release*` reducers are the only functions that change a state. A reducer that would
 * break a gate throws `GateError` and returns nothing, so the input is never half written; a success returns a new state. The AI only fills
 * content; every gate is decided here. Lives beside the v1 machine (`machine.ts`, still used by the v1 runner) until the runner switches.
 *
 * This file covers the whole flow: building a locked map, the premise gate, hypotheses, pre-registered needs, research, evidence assessment,
 * the derived test status, the program's own "insufficient" at the limit, the AI's single-hypothesis verdict, the cross-hypothesis comparison
 * with its veto (send back once, add a late alternative once, or "undecidable"), the conclusion and the inference check.
 */
import { GateError } from "./machine";
import {
  ANSWER_KEYS,
  CANDIDATE_KINDS,
  CAUSAL_STATES,
  COMPARISON_BASES,
  CLAIM_ROLES,
  CLAIM_TYPES,
  CONFIDENCES,
  EVIDENCE_STANCES,
  MAX_COMPARISONS,
  MAX_FRAMING_CALLS,
  MAX_HYPOTHESES,
  MAX_INFERENCE_CHECKS,
  MAX_NEEDS,
  MAX_PREMISE_ATTEMPTS,
  MAX_PREMISE_DATA,
  MAX_PREMISES,
  MAX_RESEARCH_CALLS,
  MAX_REVERDICTS,
  MAX_ROUND,
  MAX_ROUND_NEEDS,
  MAX_TESTABLE,
  OVERLAP_STRENGTHS,
  PREDICTION_KINDS,
  PREMISE_RESULTS,
  PROOF_CHECKS,
  REFUTATION_CLASSES,
  VERDICT_VALUES,
  VETO_KINDS,
  ASSUMPTION_STATES,
  type AnswerKey,
  type ArgumentMapData,
  type ArgumentRoles,
  type Assessment,
  type Claim,
  type ClaimRole,
  type ClaimType,
  type ComparisonBasis,
  type Confidence,
  type Criteria,
  type Definition,
  type Framing,
  type Hypothesis,
  type HypothesisRole,
  type Identification,
  type Need,
  type OverlapEntry,
  type Verdict,
  type Veto,
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
  /** The AI judges one hypothesis. */
  | { type: "verdict"; hypothesisId: string }
  /** The program closes a claim that never got hypotheses (the research or hypothesis limit left no room): no AI call. */
  | { type: "no_hypotheses"; claimId: string }
  /** The comparison asked for a missed alternative: the second, and last, batch of hypotheses of this claim. */
  | { type: "propose_alternatives"; claimId: string }
  | { type: "compare"; claimId: string }
  | { type: "conclude" }
  | { type: "inference_check" };

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

const minHypotheses = (type: ClaimType): number => (type === "fact" ? 2 : 3);
/** Proposing hypotheses is worth an AI call only while research can still run and the 6-hypothesis cap leaves room for the type's floor. */
const canPropose = (state: ArgumentMapData, claim: Claim): boolean =>
  state.run.researchCalls < MAX_RESEARCH_CALLS && MAX_HYPOTHESES - state.hypotheses.length >= minHypotheses(claim.type);
const closedClaim = (claim: Claim): boolean =>
  claim.comparison?.state === "done" || claim.comparison?.state === "undecidable";
const claimHypotheses = (state: ArgumentMapData, claimId: string): Hypothesis[] =>
  state.hypotheses.filter(h => h.claimId === claimId);
const liveTestables = (state: ArgumentMapData): Claim[] =>
  state.claims.filter(c => c.role === "testable" && c.status !== "not_evaluated");
/** The comparison asked for a missed alternative that has not been added yet. */
const alternativePending = (claim: Claim): boolean =>
  claim.comparison?.state === "vetoed" &&
  !claim.comparison.missedAlternativeAdded &&
  claim.comparison.vetoes.some(v => !v.resolved && v.kind === "missed_alternative");
const verdictsComplete = (state: ArgumentMapData, claim: Claim): boolean => {
  const own = claimHypotheses(state, claim.id);
  return own.length > 0 && own.every(h => h.verdict !== undefined);
};
/** A claim may be compared when every hypothesis has a verdict, no alternative is owed, and a comparison is left to run. */
function readyToCompare(state: ArgumentMapData, claim: Claim): boolean {
  const c = claim.comparison;
  if (!c || claim.status === "not_evaluated") return false;
  if (c.state !== "pending" && c.state !== "vetoed") return false;
  if (c.attempts >= MAX_COMPARISONS || alternativePending(claim)) return false;
  return verdictsComplete(state, claim);
}
/**
 * Moves the run among analysis, comparison and conclusion after a reducer changed a verdict or a comparison: the phase names the earliest
 * stage some claim is still in. Claims progress on their own; the phase is only the map's progress and the stale-result fence.
 */
function settle(next: ArgumentMapData): ArgumentMapData {
  if (!["analysis", "comparison", "conclusion"].includes(next.run.phase)) return next;
  const live = liveTestables(next);
  if (live.every(closedClaim)) next.run.phase = "conclusion";
  else if (live.every(c => closedClaim(c) || (verdictsComplete(next, c) && !alternativePending(c))))
    next.run.phase = "comparison";
  else next.run.phase = "analysis";
  return next;
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
  if (state.run.phase === "conclusion") return [{ type: "conclude" }];
  if (state.run.phase === "inference_check")
    return (state.run.inferenceChecks ?? 0) < MAX_INFERENCE_CHECKS ? [{ type: "inference_check" }] : [];
  if (state.run.phase !== "analysis" && state.run.phase !== "comparison") return [];
  const out: ArgumentAction[] = [];
  for (const claim of state.claims) {
    if (claim.role !== "testable" || claim.status === "not_evaluated" || closedClaim(claim)) continue;
    const own = claimHypotheses(state, claim.id);
    if (own.length === 0) {
      out.push({ type: canPropose(state, claim) ? "propose_hypotheses" : "no_hypotheses", claimId: claim.id });
      continue;
    }
    if (alternativePending(claim)) out.push({ type: "propose_alternatives", claimId: claim.id });
    for (const h of own) out.push(...hypothesisActions(state, h));
    if (readyToCompare(state, claim)) out.push({ type: "compare", claimId: claim.id });
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
  const next = buildHypotheses(state, claimId, items, false);
  claimOf(next, claimId).status = "in_progress";
  return settle(next);
}

/**
 * Builds the hypotheses of `items` into a copy of `state`. `late` is the second batch after a comparison: `alsoPredictedBy` may then name the
 * claim's earlier hypotheses too, and each new hypothesis is marked `addedAfterComparison`.
 */
function buildHypotheses(
  state: ArgumentMapData,
  claimId: string,
  items: HypothesisDraft[],
  late: boolean
): ArgumentMapData {
  const next = clone(state);
  const claim = claimOf(next, claimId);
  const ids = allIds(next);
  const batch = new Set(items.map(i => i?.id));
  if (batch.size !== items.length) throw new GateError("duplicate hypothesis id");
  const known = new Set(batch);
  if (late) for (const h of next.hypotheses) if (h.claimId === claimId) known.add(h.id);
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
    if (late) h.addedAfterComparison = true;
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
          if (!known.has(entry.hypothesisId) || entry.hypothesisId === id)
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
    reverdicts: h.reverdicts ?? 0
  };
  return settle(next);
}
function requiredPrediction(h: Hypothesis, predictionId: string): boolean {
  const own = h.needs.filter(
    n => n.predictionId === predictionId && n.registered === "pre" && n.replaces === undefined
  );
  return own.length > 0 && own.every(n => met(h, n));
}

// ---- text guard -----------------------------------------------------------------------------------------------------------------------
/** Numbers as written, thousands commas dropped (full-width digits folded). An id such as `H1` carries no number: a digit glued to a letter is not one. */
function numbersIn(text: string): Set<string> {
  const found = text.normalize("NFKC").match(/(?<![\w.])\d+(?:,\d{3})*(?:\.\d+)?/gu) ?? [];
  return new Set(found.map(n => n.replace(/,/g, "")));
}
function urlsIn(text: string): Set<string> {
  const found = text.match(/https?:\/\/[^\s"'<>\])}，。；）]+/giu) ?? [];
  return new Set(found.map(u => u.replace(/[.,;:!?]+$/u, "").toLowerCase()));
}
/** The text of a step's input, the only place a number or a URL in the answer may come from. */
const sourceText = (input: unknown): string => JSON.stringify(input);
/** An AI-written text may use only the numbers and URLs its own input contained (methodology 10). */
function guardText(text: unknown, source: string, what: string): string {
  if (typeof text !== "string" || text.trim() === "") throw new GateError(`${what} is empty`);
  const okNumbers = numbersIn(source);
  for (const n of numbersIn(text))
    if (!okNumbers.has(n)) throw new GateError(`${what} has a number that is not in the input: ${n}`);
  const okUrls = urlsIn(source);
  for (const u of urlsIn(text)) if (!okUrls.has(u)) throw new GateError(`${what} has a URL that is not in the input`);
  return text;
}

// ---- views shared by the steps -----------------------------------------------------------------------------------------------------------
const unique = <T>(list: readonly T[]): T[] => [...new Set(list)];
const CAUSE_ROLES: readonly HypothesisRole[] = ["primary", "alternative", "reverse", "common_cause"];
/** A support prediction is distinguishing when no other hypothesis predicts it as strongly: every overlap is `weaker`, or there is none. */
const distinguishing = (p: { kind: string; alsoPredictedBy: OverlapEntry[] }): boolean =>
  p.kind === "support" && p.alsoPredictedBy.every(e => e.strength === "weaker");

interface Scoped {
  need: Need;
  owner: Hypothesis;
  own: boolean;
}
/** The evidence a hypothesis' verdict may see: its own needs, plus the counter-evidence the comparison allocated to it. Nothing else. */
function scopeOf(state: ArgumentMapData, h: Hypothesis): Map<string, Scoped> {
  const out = new Map<string, Scoped>();
  for (const need of h.needs) out.set(need.id, { need, owner: h, own: true });
  const allocations = claimOf(state, h.claimId).comparison?.allocations ?? [];
  for (const a of allocations) {
    if (a.hypothesisId !== h.id) continue;
    for (const o of state.hypotheses) {
      if (o.id === h.id) continue;
      const need = o.needs.find(n => n.id === a.needId);
      if (need) out.set(need.id, { need, owner: o, own: false });
    }
  }
  return out;
}
const refutesH = (need: Need): boolean => qualifies(need) && need.assessment?.stance === "refutes";
/** Every checked, relevant, in-scope piece of evidence that refutes the hypothesis (own or allocated): the verdict must answer each. */
const counterEvidenceOf = (scope: Map<string, Scoped>): string[] =>
  [...scope.values()].filter(s => refutesH(s.need)).map(s => s.need.id);

function evidenceView(s: Scoped): Record<string, unknown> {
  const { need } = s;
  const view: Record<string, unknown> = {
    needId: need.id,
    fromHypothesis: s.owner.id,
    own: s.own,
    predictionId: need.predictionId,
    text: need.text,
    criteria: need.criteria,
    registered: need.registered,
    state: need.state
  };
  if (need.reason) view.reason = need.reason;
  if (need.replaces) view.replaces = need.replaces;
  if (need.proof)
    view.source = { url: need.proof.url, quote: need.proof.quote, claim: need.proof.claim, check: need.proof.check };
  if (need.assessment) view.assessment = need.assessment;
  return view;
}
const premiseView = (c: Claim): Record<string, unknown> => ({ id: c.id, text: c.text, result: c.result ?? null });
const claimView = (c: Claim): Record<string, unknown> => ({
  id: c.id,
  text: c.text,
  type: c.type,
  definitions: c.definitions
});

// ---- verdict by the AI ------------------------------------------------------------------------------------------------------------------
export interface RefutationDraft {
  needId: string;
  class: string;
  auxiliary: string[];
}
export interface AssumptionDraft {
  assumption: string;
  status: string;
  defense?: string;
}
export interface VerdictDraft {
  value: string;
  reason: string;
  citedNeeds: string[];
  /** One note per refutation, in the same order. */
  counterNotes: string[];
  refutations: RefutationDraft[];
  causal: string;
  assumptionStatus: AssumptionDraft[];
  confidence: string;
}

/**
 * What the verdict step may see (decision 27: only this hypothesis): its claim and the premises its predictions lean on, its predictions,
 * its own needs with their checked sources and assessments, and the evidence the comparison allocated to it. No other hypothesis, no
 * verdict of another hypothesis, no user mark, no page text beyond the checked quote. `counterEvidence` lists the ids the answer must cover.
 */
export function prepareVerdict(state: ArgumentMapData, hypothesisId: string): Record<string, unknown> {
  const h = hypothesisOf(state, hypothesisId);
  const claim = claimOf(state, h.claimId);
  const scope = scopeOf(state, h);
  const auxiliary = unique(h.predictions.flatMap(p => p.auxiliary));
  return {
    hypothesis: { id: h.id, role: h.role, round: h.round, testStatus: testStatus(h, state.run.researchCalls) },
    claim: claimView(claim),
    identification: h.identification ?? null,
    predictions: h.predictions.map(p => ({
      id: p.id,
      kind: p.kind,
      text: p.text,
      required: p.required,
      distinguishing: distinguishing(p),
      auxiliary: p.auxiliary,
      ...(p.reason ? { reason: p.reason } : {})
    })),
    premises: auxiliary.map(id => premiseView(claimOf(state, id))),
    evidence: [...scope.values()].map(evidenceView),
    counterEvidence: counterEvidenceOf(scope)
  };
}

const rankOf = (c: Confidence): number => CONFIDENCES.indexOf(c);
// CONFIDENCES runs high -> low, so the lower confidence has the larger index
const lowerOf = (a: Confidence, b: Confidence): Confidence => (rankOf(a) >= rankOf(b) ? a : b);

/**
 * The AI's verdict on one hypothesis. Nothing outside `prepareVerdict`'s evidence is adopted (an id, a number or a URL that is not in the
 * input is refused). Gates: methodology 6 / plan "判定條件", "因果狀態", "信心上限". The AI cannot give `insufficient`; at the research limit
 * `undecided` is stored by the program as `insufficient` (the test never completed and nothing refuted decisively).
 */
export function applyVerdict(state: ArgumentMapData, hypothesisId: string, draft: VerdictDraft): ArgumentMapData {
  inAnalysis(state);
  const next = clone(state);
  const h = hypothesisOf(next, hypothesisId);
  const d = draft as Partial<VerdictDraft> | undefined;
  if (!d || typeof d !== "object") throw new GateError("verdict missing");
  if (!oneOf(VERDICT_VALUES, d.value)) throw new GateError("unknown verdict value");
  if (d.value === "insufficient") throw new GateError("only the program can give insufficient");
  const asked: VerdictValue = d.value;
  const source = sourceText(prepareVerdict(state, hypothesisId));
  const reason = guardText(d.reason, source, "the verdict reason");
  const status = testStatus(h, next.run.researchCalls);
  const scope = scopeOf(next, h);

  // evidence the verdict rests on: in scope, checked, relevant, in the claim's scope
  const cited = Array.isArray(d.citedNeeds) ? d.citedNeeds : [];
  if (new Set(cited).size !== cited.length) throw new GateError("a cited need is listed twice");
  for (const id of cited) {
    const s = scope.get(id);
    if (!s) throw new GateError(`the verdict cites evidence outside its scope: ${id}`);
    if (!qualifies(s.need))
      throw new GateError(`the verdict cites evidence that is not checked, relevant and in scope: ${id}`);
  }

  // every counter-evidence is answered, once, with a note
  const counter = counterEvidenceOf(scope);
  const refutations = Array.isArray(d.refutations) ? d.refutations : [];
  const notes = Array.isArray(d.counterNotes) ? d.counterNotes : [];
  if (refutations.length !== counter.length || new Set(refutations.map(r => r?.needId)).size !== counter.length)
    throw new GateError("the verdict must classify every counter-evidence, once");
  if (notes.length !== refutations.length) throw new GateError("counterNotes must cover every counter-evidence");
  const storedRefutations: Verdict["refutations"] = [];
  refutations.forEach((r, i) => {
    const s = scope.get(r?.needId);
    if (!s || !counter.includes(r.needId))
      throw new GateError(`a refutation names evidence that is not counter-evidence: ${r?.needId}`);
    if (!oneOf(REFUTATION_CLASSES, r.class)) throw new GateError("unknown refutation class");
    guardText(notes[i], source, "a counter note");
    const aux = Array.isArray(r.auxiliary) ? unique(r.auxiliary) : [];
    if (r.class !== "nondecisive") {
      // only a refute prediction of the hypothesis' own can state a decisive or conditional refutation
      const prediction = s.own ? h.predictions.find(p => p.id === s.need.predictionId) : undefined;
      if (!prediction || prediction.kind !== "refute")
        throw new GateError("only evidence for the hypothesis' own refute prediction can be decisive or conditional");
      if (!aux.length || prediction.auxiliary.some(a => !aux.includes(a)))
        throw new GateError("a refutation must name the auxiliary premises of its prediction");
      for (const a of aux) {
        const premise = next.claims.find(c => c.id === a);
        if (!premise || premise.role !== "premise") throw new GateError("an auxiliary is not a premise");
      }
      if (r.class === "decisive") {
        if (s.need.registered !== "pre") throw new GateError("an exploratory result cannot be a decisive refutation");
        if (aux.some(a => next.claims.find(c => c.id === a)?.result !== "holds"))
          throw new GateError(
            "a decisive refutation needs auxiliary premises that hold; otherwise it is only conditional"
          );
      }
    } else if (aux.length) throw new GateError("a nondecisive counter-evidence names no auxiliary premises");
    storedRefutations.push({ needId: r.needId, class: r.class, auxiliary: aux });
  });
  const decisive = storedRefutations.some(r => r.class === "decisive");
  const blocking = storedRefutations.some(r => r.class === "decisive" || r.class === "conditional");

  // the value
  let value: VerdictValue = asked;
  let by: Verdict["by"] = "ai";
  let storedReason = reason;
  if (asked === "refuted") {
    if (!decisive)
      throw new GateError("refuted needs a decisive refutation (pre-registered, auxiliary premises that hold)");
    if (!storedRefutations.some(r => r.class === "decisive" && cited.includes(r.needId)))
      throw new GateError("the decisive refutation must be cited");
  } else {
    if (decisive) throw new GateError("a decisive refutation exists: the verdict can only be refuted");
    if (asked === "supported") {
      if (status !== "complete") throw new GateError("supported needs a complete test");
      if (blocking) throw new GateError("a conditional refutation blocks supported");
      const support = h.predictions
        .filter(distinguishing)
        .flatMap(p =>
          h.needs.filter(n => n.predictionId === p.id && qualifies(n) && n.assessment?.stance === "supports")
        );
      if (!support.length) throw new GateError("supported needs a distinguishing support that was met");
      if (!support.some(n => cited.includes(n.id))) throw new GateError("cite the distinguishing support");
      for (const p of h.predictions.filter(q => q.kind === "refute"))
        if (!h.needs.some(n => n.predictionId === p.id && qualifies(n)))
          throw new GateError(`a refute prediction has no data: ${p.id}`);
    } else if (status === "complete") {
      // undecided: complete but neither supported nor refuted
    } else if (status === "limit_incomplete") {
      value = "insufficient";
      by = "program";
      storedReason = `limit_incomplete: ${reason}`;
    } else throw new GateError("undecided needs a complete test");
  }

  // causal status
  const identified = h.identification !== undefined;
  const assumptions: Verdict["assumptionStatus"] = [];
  let causal = d.causal;
  if (!oneOf(CAUSAL_STATES, causal)) throw new GateError("unknown causal state");
  if (value === "supported" && identified) {
    const given = Array.isArray(d.assumptionStatus) ? d.assumptionStatus : [];
    const wanted = h.identification?.assumptions ?? [];
    if (given.length !== wanted.length || wanted.some(w => given.filter(g => g?.assumption === w).length !== 1))
      throw new GateError("assumptionStatus must cover every identification assumption, once");
    for (const g of given) {
      if (!oneOf(ASSUMPTION_STATES, g.status)) throw new GateError("unknown assumption status");
      const entry: Verdict["assumptionStatus"][number] = { assumption: g.assumption, status: g.status };
      if (g.status === "defended") entry.defense = guardText(g.defense, source, "an assumption defense");
      assumptions.push(entry);
    }
    if (causal === "not_applicable") throw new GateError("a supported cause needs a causal state");
    const open = assumptions.filter(a => a.status !== "checked");
    if (causal === "established" && open.length)
      throw new GateError("established needs every identification assumption checked");
    if (causal === "conditional") {
      if (!open.length) throw new GateError("conditional needs an assumption that was not checked");
      if (open.some(a => a.status !== "defended"))
        throw new GateError("conditional needs a defense for every unchecked assumption");
    }
  } else if (causal !== "not_applicable")
    throw new GateError("only a supported cause can have a causal state; otherwise it is not_applicable");

  // confidence ceiling (clamped, never raised)
  let confidence: Confidence = "low";
  if (oneOf(CONFIDENCES, d.confidence)) confidence = d.confidence;
  else throw new GateError("unknown confidence");
  if (by === "program") confidence = "low";
  const sources = unique(
    cited.map(id => (scope.get(id)?.need.assessment?.underlyingSource ?? "").trim().toLowerCase()).filter(Boolean)
  );
  let ceiling: Confidence = "high";
  if (sources.length < 2) ceiling = "medium";
  if (value === "supported") {
    if (identified && causal !== "established") ceiling = lowerOf(ceiling, "medium");
    const preSupport = cited.some(id => {
      const n = scope.get(id)?.need;
      return !!n && n.registered === "pre" && n.assessment?.stance === "supports";
    });
    if (!preSupport) ceiling = "low";
  }
  confidence = lowerOf(confidence, ceiling);

  h.verdict = {
    value,
    by,
    reason: storedReason,
    citedNeeds: cited,
    counterNotes: notes.map(n => n),
    refutations: storedRefutations,
    causal: causal as Verdict["causal"],
    assumptionStatus: assumptions,
    confidence,
    reverdicts: h.reverdicts ?? 0
  };
  return settle(next);
}

// ---- a claim without hypotheses --------------------------------------------------------------------------------------------------------
/**
 * Conservative close for a claim that never got hypotheses because the research limit was reached or the 6-hypothesis cap left no room for
 * its floor: the program marks its comparison `undecidable` with the answer `insufficient`, calls no AI, and no positive answer exists for it.
 */
export function applyNoHypotheses(state: ArgumentMapData, claimId: string): ArgumentMapData {
  inAnalysis(state);
  const next = clone(state);
  const claim = liveTestable(next, claimId);
  if (closedClaim(claim)) throw new GateError("the claim is already closed");
  if (claimHypotheses(next, claimId).length) throw new GateError("the claim has hypotheses");
  if (canPropose(next, claim)) throw new GateError("hypotheses can still be proposed");
  const c = claim.comparison as NonNullable<Claim["comparison"]>;
  c.state = "undecidable";
  c.answer = "insufficient";
  claim.status = "done";
  return settle(next);
}

// ---- the second batch of hypotheses -----------------------------------------------------------------------------------------------------
/**
 * The comparison found a missed alternative: one more batch of hypotheses for this claim (1 AI call per claim, once). Only legal while the
 * comparison owes it and the 6-hypothesis cap has room. Their needs are pre-registered like any first-time needs (decision 29).
 */
export function applyAlternativeHypotheses(
  state: ArgumentMapData,
  claimId: string,
  items: HypothesisDraft[]
): ArgumentMapData {
  inAnalysis(state);
  const claim = liveTestable(state, claimId);
  if (!alternativePending(claim)) throw new GateError("the comparison does not owe an alternative");
  if (!Array.isArray(items) || !items.length) throw new GateError("no hypotheses");
  if (state.hypotheses.length + items.length > MAX_HYPOTHESES) throw new GateError("hypothesis limit reached");
  const allowed: readonly HypothesisRole[] = ROLES_OF[claim.type].filter(r => r !== "primary");
  if (items.some(i => !allowed.includes(i?.role))) throw new GateError("a late alternative cannot take this role");
  const next = buildHypotheses(state, claimId, items, true);
  const c = claimOf(next, claimId).comparison as NonNullable<Claim["comparison"]>;
  c.missedAlternativeAdded = true;
  for (const v of c.vetoes) if (v.kind === "missed_alternative") v.resolved = true;
  return settle(next);
}

// ---- comparison ---------------------------------------------------------------------------------------------------------------------------
/** What a claim's comparison may answer, by type (methodology 9). */
const ANSWERS_OF: Record<ClaimType, readonly AnswerKey[]> = {
  fact: ["holds", "fails", "insufficient"],
  causal: ["causal_established", "causal_conditional", "causal_compatible", "causal_against", "insufficient"],
  main_cause: [
    "main_cause_largest",
    "main_cause_secondary",
    "main_cause_not",
    "main_cause_undecidable",
    "insufficient"
  ],
  comparison: ["compare_greater", "compare_equivalent", "compare_opposite", "compare_undetermined", "insufficient"]
};
const undecidableAnswer = (type: ClaimType): AnswerKey =>
  type === "main_cause" ? "main_cause_undecidable" : type === "comparison" ? "compare_undetermined" : "insufficient";

interface AnswerExtra {
  contributors?: string[];
  largest?: string;
  basis?: ComparisonBasis;
}
/** Is `key` a legal answer for this claim given the verdicts now in the state? Throws a GateError when it is not. */
function checkAnswer(state: ArgumentMapData, claim: Claim, key: unknown, extra: AnswerExtra): void {
  if (!oneOf(ANSWER_KEYS, key)) throw new GateError("unknown answer");
  if (!ANSWERS_OF[claim.type].includes(key))
    throw new GateError(`the answer ${key} does not fit a ${claim.type} claim`);
  const hypotheses = claimHypotheses(state, claim.id);
  const value = (h: Hypothesis | undefined): VerdictValue | undefined => h?.verdict?.value;
  const primary = hypotheses.find(h => h.role === "primary");
  if (claim.type !== "main_cause" && (extra.contributors || extra.largest !== undefined || extra.basis !== undefined))
    throw new GateError("only a main-cause comparison has contributors");
  switch (key) {
    case "holds":
      if (!hypotheses.length || hypotheses.some(h => value(h) !== "supported"))
        throw new GateError("holds needs every facet supported (a refuted facet cannot be answered as holding)");
      break;
    case "fails":
      if (!hypotheses.some(h => value(h) === "refuted")) throw new GateError("fails needs a refuted facet");
      break;
    case "causal_established":
    case "causal_conditional":
    case "causal_compatible": {
      const want =
        key === "causal_established" ? "established" : key === "causal_conditional" ? "conditional" : "compatible";
      if (value(primary) !== "supported" || primary?.verdict?.causal !== want)
        throw new GateError(`the answer ${key} does not match the cause's verdict and causal state`);
      break;
    }
    case "causal_against":
      if (value(primary) !== "refuted") throw new GateError("causal_against needs a refuted cause");
      break;
    case "compare_greater":
    case "compare_opposite":
      if (value(primary) !== "supported") throw new GateError("a direction needs the supported measurement of A");
      if (hypotheses.some(h => h.role === "measurement" && value(h) !== "refuted"))
        throw new GateError("a direction needs the measurement explanation refuted");
      break;
    default:
      break;
  }
  if (claim.type !== "main_cause") return;
  // main cause: only causes that are established or conditional contribute; a partial set can only be named, never ranked
  const candidates = hypotheses.filter(h => CAUSE_ROLES.includes(h.role));
  const contributors = extra.contributors ?? [];
  if (new Set(contributors).size !== contributors.length) throw new GateError("a contributor is listed twice");
  for (const id of contributors) {
    const h = candidates.find(c => c.id === id);
    if (!h) throw new GateError("a contributor is not a candidate cause of this claim");
    if (h.verdict?.causal !== "established" && h.verdict?.causal !== "conditional")
      throw new GateError("a cause that is only compatible cannot enter the contribution comparison");
  }
  if (extra.largest !== undefined && !contributors.includes(extra.largest))
    throw new GateError("the largest contributor must be a contributor");
  if (extra.basis !== undefined && !oneOf(COMPARISON_BASES, extra.basis))
    throw new GateError("unknown comparison basis");
  const complete = candidates.every(h => contributors.includes(h.id) || value(h) === "refuted");
  const ranked = extra.basis === "difference_with_uncertainty" && contributors.length >= 2;
  if (key === "main_cause_not" && value(primary) !== "refuted")
    throw new GateError("main_cause_not needs a refuted cause");
  if (key === "main_cause_largest" || key === "main_cause_secondary") {
    if (!primary || !contributors.includes(primary.id))
      throw new GateError("the main cause is not among the contributors");
    if (!ranked)
      throw new GateError("only a direct difference with its uncertainty can rank causes; point estimates cannot");
    if (!complete)
      throw new GateError("a ranking needs every candidate compared (or refuted): otherwise the answer is undecidable");
    if (extra.largest === undefined) throw new GateError("a ranking names the largest contributor");
    if (key === "main_cause_largest" && extra.largest !== primary.id)
      throw new GateError("the main cause is not the largest");
    if (key === "main_cause_secondary" && extra.largest === primary.id)
      throw new GateError("the main cause is the largest");
  }
  if (key === "main_cause_undecidable" && extra.largest !== undefined && !ranked)
    throw new GateError("a subset result needs a direct difference over at least 2 contributors");
  if (
    key !== "main_cause_largest" &&
    key !== "main_cause_secondary" &&
    key !== "main_cause_undecidable" &&
    contributors.length
  )
    throw new GateError("contributors only belong to a ranking or a subset result");
}

export interface VetoDraft {
  kind: string;
  detail: string;
}
export interface ComparisonDraft {
  /** `complete` (no veto), or the remedy for the vetoes: send hypotheses back, add a late alternative, or give up. */
  decision: string;
  vetoes: VetoDraft[];
  /** Evidence of one hypothesis that also counts against another hypothesis of the same claim (the assessment marked it). */
  allocations: { needId: string; hypothesisId: string }[];
  rejudge?: string[];
  answer?: string;
  contributors?: string[];
  largest?: string;
  basis?: string;
}

/**
 * What the comparison may see: each hypothesis' verdict, confidence, causal state and the evidence that was checked and assessed, the sources
 * several pieces of evidence share, and the premises. No page text, no user mark, nothing of another claim.
 */
export function prepareComparison(state: ArgumentMapData, claimId: string): Record<string, unknown> {
  const claim = liveTestable(state, claimId);
  const c = claim.comparison as NonNullable<Claim["comparison"]>;
  const hypotheses = claimHypotheses(state, claimId);
  const shared = new Map<string, string[]>();
  const evidence = (h: Hypothesis): Record<string, unknown>[] =>
    h.needs
      .filter(n => n.state === "found" && n.assessment)
      .map(n => {
        const key = (n.assessment?.underlyingSource ?? "").trim().toLowerCase();
        shared.set(key, [...(shared.get(key) ?? []), n.id]);
        return evidenceView({ need: n, owner: h, own: true });
      });
  const hypothesesView = hypotheses.map(h => ({
    id: h.id,
    role: h.role,
    addedAfterComparison: h.addedAfterComparison === true,
    reverdicts: h.reverdicts ?? 0,
    verdict: h.verdict
      ? {
          value: h.verdict.value,
          by: h.verdict.by,
          confidence: h.verdict.confidence,
          causal: h.verdict.causal,
          reason: h.verdict.reason,
          citedNeeds: h.verdict.citedNeeds,
          counterNotes: h.verdict.counterNotes,
          refutations: h.verdict.refutations,
          assumptionStatus: h.verdict.assumptionStatus
        }
      : null,
    evidence: evidence(h)
  }));
  return {
    claim: claimView(claim),
    premises: premisesOf(state).map(premiseView),
    hypotheses: hypothesesView,
    sharedSources: [...shared.entries()]
      .filter(([, ids]) => ids.length > 1)
      .map(([underlyingSource, needIds]) => ({ underlyingSource, needIds })),
    comparison: {
      attempts: c.attempts,
      allocations: c.allocations,
      room: {
        lastAttempt: c.attempts + 1 >= MAX_COMPARISONS,
        canAddAlternative: !c.missedAlternativeAdded && state.hypotheses.length < MAX_HYPOTHESES,
        canSendBack: hypotheses
          .filter(h => h.verdict?.by === "ai" && (h.reverdicts ?? 0) < MAX_REVERDICTS)
          .map(h => h.id)
      }
    }
  };
}

const VETO_DECISIONS = ["complete", "rejudge", "add_alternative", "undecidable"] as const;

/**
 * The cross-hypothesis comparison of one claim (methodology 8). An unresolved veto forbids the positive answer: the claim is sent back (each
 * hypothesis once: its verdict is cleared and `reverdicts` goes up in this same write), gets one late alternative batch, or ends
 * `undecidable`. A second comparison that still vetoes ends `undecidable`. The program adds its own `unhandled_counter` veto when
 * allocated counter-evidence is missing from a supported hypothesis' verdict.
 */
export function applyComparison(state: ArgumentMapData, claimId: string, draft: ComparisonDraft): ArgumentMapData {
  live(state);
  if (state.run.phase !== "analysis" && state.run.phase !== "comparison")
    throw new GateError("the run is not at the comparison");
  const next = clone(state);
  const claim = liveTestable(next, claimId);
  if (!readyToCompare(next, claim)) throw new GateError("the claim is not ready for a comparison");
  const c = claim.comparison as NonNullable<Claim["comparison"]>;
  const d = draft as Partial<ComparisonDraft> | undefined;
  if (!d || typeof d !== "object") throw new GateError("comparison missing");
  if (!VETO_DECISIONS.includes(d.decision as (typeof VETO_DECISIONS)[number]))
    throw new GateError("unknown comparison decision");
  const decision = d.decision as (typeof VETO_DECISIONS)[number];
  const source = sourceText(prepareComparison(state, claimId));
  const hypotheses = claimHypotheses(next, claimId);
  const byId = new Map(hypotheses.map(h => [h.id, h]));

  // vetoes written by the AI
  const aiVetoes: Veto[] = (Array.isArray(d.vetoes) ? d.vetoes : []).map(v => {
    if (!oneOf(VETO_KINDS, v?.kind)) throw new GateError("unknown veto kind");
    return { kind: v.kind, detail: guardText(v.detail, source, "a veto detail"), resolved: false };
  });
  // allocations: evidence of one hypothesis the assessment marked as relevant to another of this claim
  const allocations = [...c.allocations];
  for (const a of Array.isArray(d.allocations) ? d.allocations : []) {
    const target = byId.get(a?.hypothesisId);
    const owner = hypotheses.find(h => h.needs.some(n => n.id === a?.needId));
    const need = owner?.needs.find(n => n.id === a.needId);
    if (!target || !owner || !need)
      throw new GateError("an allocation names evidence or a hypothesis outside this claim");
    if (owner.id === target.id) throw new GateError("evidence cannot be allocated to its own hypothesis");
    if (!refutesH(need) || !need.assessment?.alsoRelevantTo.includes(target.id))
      throw new GateError(
        "only checked refuting evidence that the assessment marked as relevant to that hypothesis can be allocated"
      );
    if (!allocations.some(x => x.needId === need.id && x.hypothesisId === target.id))
      allocations.push({ needId: need.id, hypothesisId: target.id });
  }
  // the program's own veto: a supported hypothesis whose verdict never answered allocated counter-evidence
  const unhandled = unique(
    allocations
      .filter(a => {
        const h = byId.get(a.hypothesisId);
        return h?.verdict?.value === "supported" && !h.verdict.refutations.some(r => r.needId === a.needId);
      })
      .map(a => a.hypothesisId)
  );
  const programVetoes: Veto[] = unhandled.map(id => ({
    kind: "unhandled_counter",
    detail: `counter-evidence allocated to ${id} is not answered by its verdict`,
    resolved: false
  }));
  const vetoes = [...aiVetoes, ...programVetoes];
  const last = c.attempts + 1 >= MAX_COMPARISONS;
  c.attempts += 1;
  c.allocations = allocations;
  for (const old of c.vetoes) old.resolved = true; // earlier vetoes were answered by the remedy that led here

  if (!vetoes.length) {
    if (decision !== "complete") throw new GateError("without a veto the comparison completes");
    const extra: AnswerExtra = {};
    if (d.contributors !== undefined) extra.contributors = Array.isArray(d.contributors) ? [...d.contributors] : [];
    if (d.largest !== undefined) extra.largest = d.largest;
    if (d.basis !== undefined) extra.basis = d.basis as ComparisonBasis;
    checkAnswer(next, claim, d.answer, extra);
    c.state = "done";
    c.answer = d.answer as AnswerKey;
    delete c.contributors;
    delete c.largest;
    delete c.basis;
    if (claim.type === "main_cause") {
      c.contributors = extra.contributors ?? [];
      if (extra.largest !== undefined) c.largest = extra.largest;
      if (extra.basis !== undefined) c.basis = extra.basis;
    }
    claim.status = "done";
    return settle(next);
  }

  // vetoed: the second comparison that still vetoes ends undecidable; otherwise one remedy
  let remedy: "rejudge" | "add_alternative" | "undecidable" = decision === "complete" ? "rejudge" : decision;
  const eligible = (h: Hypothesis): boolean => h.verdict?.by === "ai" && (h.reverdicts ?? 0) < MAX_REVERDICTS;
  let rejudge: string[] = [];
  if (!last && remedy !== "undecidable") {
    const chosen = decision === "rejudge" && Array.isArray(d.rejudge) ? unique(d.rejudge) : [];
    for (const id of chosen) {
      const h = byId.get(id);
      if (!h) throw new GateError("rejudge names a hypothesis outside this claim");
      if (!eligible(h)) throw new GateError("a hypothesis can be sent back once, and only if the AI judged it");
    }
    // a program veto cannot be left standing: send those hypotheses back too, or give up when that is no longer allowed
    if (unhandled.some(id => !eligible(byId.get(id) as Hypothesis))) remedy = "undecidable";
    rejudge = unique([...chosen, ...unhandled]);
    if (remedy === "rejudge" && !rejudge.length)
      throw new GateError("a veto needs a remedy: name the hypotheses to send back");
    if (remedy === "add_alternative") {
      if (!aiVetoes.some(v => v.kind === "missed_alternative"))
        throw new GateError("add_alternative needs a missed_alternative veto");
      if (c.missedAlternativeAdded || next.hypotheses.length >= MAX_HYPOTHESES)
        throw new GateError("no late alternative can be added; the answer is undecidable");
    }
  } else remedy = "undecidable";
  if (remedy === "undecidable") {
    c.state = "undecidable";
    c.answer = undecidableAnswer(claim.type);
    delete c.contributors;
    delete c.largest;
    delete c.basis;
    c.vetoes.push(...vetoes);
    claim.status = "done";
    return settle(next);
  }
  c.state = "vetoed";
  c.vetoes.push(...vetoes);
  for (const id of rejudge) {
    const h = byId.get(id) as Hypothesis;
    delete h.verdict;
    h.reverdicts = (h.reverdicts ?? 0) + 1;
  }
  // a veto is resolved once its remedy ran; a missed alternative stays open until the late batch is added
  for (const v of c.vetoes) v.resolved = !(remedy === "add_alternative" && v.kind === "missed_alternative");
  return settle(next);
}

// ---- conclusion ----------------------------------------------------------------------------------------------------------------------------
/** The assumptions a sentence must carry: the unchecked identification assumptions of every conditional cause the answer rests on. */
function conditionalAssumptions(state: ArgumentMapData, claim: Claim): string[] {
  const c = claim.comparison;
  if (!c?.answer) return [];
  const hypotheses = claimHypotheses(state, claim.id);
  const conditional = (h: Hypothesis | undefined): string[] =>
    h?.verdict?.causal === "conditional"
      ? h.verdict.assumptionStatus.filter(a => a.status !== "checked").map(a => a.assumption)
      : [];
  if (c.answer === "causal_conditional") return conditional(hypotheses.find(h => h.role === "primary"));
  if (
    claim.type === "main_cause" &&
    ["main_cause_largest", "main_cause_secondary", "main_cause_undecidable"].includes(c.answer)
  )
    return unique((c.contributors ?? []).flatMap(id => conditional(hypotheses.find(h => h.id === id))));
  return [];
}

/** What the conclusion step may see: the locked framing, each claim's comparison result and each hypothesis' verdict summary. No evidence text, no user mark. */
export function prepareConclusion(state: ArgumentMapData): Record<string, unknown> {
  const f = state.framing;
  const chosen = f.candidates.find(c => c.id === f.chosen);
  return {
    framing: {
      original: f.original,
      restatement: f.restatement,
      chosen: chosen
        ? { question: chosen.question, diff: chosen.diff, kind: chosen.kind, unanswered: chosen.unanswered }
        : null,
      settings: f.settings,
      composition: f.composition ?? null,
      outOfScope: f.outOfScope
    },
    premises: premisesOf(state).map(premiseView),
    claims: state.claims
      .filter(c => c.role === "testable")
      .map(c => ({
        ...claimView(c),
        evaluated: c.status !== "not_evaluated",
        comparison: c.comparison
          ? {
              state: c.comparison.state,
              answer: c.comparison.answer ?? null,
              contributors: c.comparison.contributors ?? [],
              largest: c.comparison.largest ?? null,
              blockers: c.comparison.vetoes.filter(v => !v.resolved).map(v => ({ kind: v.kind, detail: v.detail })),
              requiredAssumptions: conditionalAssumptions(state, c)
            }
          : null,
        hypotheses: claimHypotheses(state, c.id).map(h => ({
          id: h.id,
          role: h.role,
          addedAfterComparison: h.addedAfterComparison === true,
          verdict: h.verdict
            ? {
                value: h.verdict.value,
                confidence: h.verdict.confidence,
                causal: h.verdict.causal,
                assumptionStatus: h.verdict.assumptionStatus
              }
            : null
        }))
      }))
  };
}

export interface ConclusionDraft {
  answers: { claimId: string; answer: string; sentence: string; assumptions: string[] }[];
  /** The whole original sentence's answer. Only legal when the locked breakdown carries a composition rule. */
  overall?: string;
}

/** A sentence must carry the identification assumptions its answer rests on and, for a subset result, name each compared candidate. */
function checkSentence(state: ArgumentMapData, claim: Claim, sentence: string, assumptions: readonly string[]): void {
  const need = conditionalAssumptions(state, claim);
  if (assumptions.length !== need.length || need.some(a => !assumptions.includes(a)))
    throw new GateError("the answer must list exactly the identification assumptions it rests on");
  for (const a of need)
    if (!sentence.includes(a))
      throw new GateError("an identification assumption must be written into the sentence itself");
  const c = claim.comparison;
  if (c?.answer === "main_cause_undecidable" && c.largest !== undefined)
    for (const id of c.contributors ?? [])
      if (!sentence.includes(id)) throw new GateError("a subset result must name every compared candidate");
}

/**
 * The conclusion. Only after every hypothesis has a verdict and every claim's comparison is `done` or `undecidable` (the phase says so). Each
 * evaluated testable claim gets exactly one answer, equal to its comparison's; a veto that was never resolved leaves no positive answer. The
 * whole-sentence answer needs a composition rule. The inference check comes next.
 */
export function applyConclusion(state: ArgumentMapData, draft: ConclusionDraft): ArgumentMapData {
  live(state);
  if (state.run.phase !== "conclusion") throw new GateError("the conclusion is not due");
  const next = clone(state);
  const d = draft as Partial<ConclusionDraft> | undefined;
  if (!d || typeof d !== "object") throw new GateError("conclusion missing");
  const source = sourceText(prepareConclusion(state));
  const live_ = liveTestables(next);
  for (const claim of live_) if (!closedClaim(claim)) throw new GateError("a comparison is not finished");
  const given = Array.isArray(d.answers) ? d.answers : [];
  if (given.length !== live_.length || new Set(given.map(a => a?.claimId)).size !== live_.length)
    throw new GateError("answer every evaluated testable claim, once");
  const answers: ArgumentMapData["conclusion"]["answers"] = [];
  for (const claim of live_) {
    const item = given.find(a => a?.claimId === claim.id);
    if (!item) throw new GateError("an answer names a claim that is not evaluated");
    const c = claim.comparison as NonNullable<Claim["comparison"]>;
    if (!oneOf(ANSWER_KEYS, item.answer)) throw new GateError("unknown answer");
    if (item.answer !== c.answer) throw new GateError("the answer must be the comparison's");
    checkAnswer(next, claim, item.answer, { contributors: c.contributors, largest: c.largest, basis: c.basis });
    const sentence = guardText(item.sentence, source, "a conclusion sentence");
    const assumptions = Array.isArray(item.assumptions) ? item.assumptions : [];
    checkSentence(next, claim, sentence, assumptions);
    answers.push({ claimId: claim.id, answer: item.answer, sentence, assumptions: [...assumptions] });
  }
  const conclusion: ArgumentMapData["conclusion"] = { state: "pending", answers, deleted: [] };
  if (d.overall !== undefined) {
    if (blank(next.framing.composition))
      throw new GateError("the breakdown has no composition rule: report the claims, not a whole-sentence answer");
    conclusion.overall = guardText(d.overall, source, "the overall sentence");
  }
  next.conclusion = conclusion;
  next.run.phase = "inference_check";
  next.run.inferenceChecks = 0;
  return next;
}

// ---- inference check -----------------------------------------------------------------------------------------------------------------------
/** The sentences the check reads: one per answer, plus the whole-sentence answer. Deleted sentences are gone. */
function sentencesOf(state: ArgumentMapData): { id: string; sentence: string }[] {
  const out = state.conclusion.answers
    .filter(a => a.sentence !== "")
    .map(a => ({ id: a.claimId, sentence: a.sentence }));
  if (state.conclusion.overall) out.push({ id: "overall", sentence: state.conclusion.overall });
  return out;
}
/** What the inference check may see: the conclusion's own input plus the sentences. */
export function prepareInferenceCheck(state: ArgumentMapData): Record<string, unknown> {
  return {
    check: (state.run.inferenceChecks ?? 0) + 1,
    sentences: sentencesOf(state),
    basis: prepareConclusion(state)
  };
}

export interface InferenceItem {
  id: string;
  status: string;
  rewrite?: string;
}

/**
 * The independent inference check. `ok`, `rewrite` and `delete` only. A rewrite passes the number and URL guard and still carries what its
 * answer requires. The first check applies rewrites and deletions; if any sentence was rewritten a second check follows, and a sentence
 * still flagged there is deleted by the program. Every deleted sentence is kept in `conclusion.deleted`. The last check ends the run.
 */
export function applyInferenceCheck(state: ArgumentMapData, items: InferenceItem[]): ArgumentMapData {
  live(state);
  if (state.run.phase !== "inference_check") throw new GateError("the inference check is not due");
  const done = state.run.inferenceChecks ?? 0;
  if (done >= MAX_INFERENCE_CHECKS) throw new GateError("inference checks are used up");
  const next = clone(state);
  const sentences = sentencesOf(next);
  const given = Array.isArray(items) ? items : [];
  if (given.length !== sentences.length || new Set(given.map(i => i?.id)).size !== sentences.length)
    throw new GateError("check every sentence, once");
  const source = sourceText(prepareInferenceCheck(state));
  const finalCheck = done + 1 >= MAX_INFERENCE_CHECKS;
  let rewrote = false;
  for (const entry of sentences) {
    const item = given.find(i => i?.id === entry.id);
    if (!item || !["ok", "rewrite", "delete"].includes(item.status))
      throw new GateError("a check answers ok, rewrite or delete");
    const answer = next.conclusion.answers.find(a => a.claimId === entry.id);
    let text = entry.sentence;
    let remove = item.status === "delete";
    if (item.status === "rewrite") {
      const rewrite = guardText(item.rewrite, source, "a rewritten sentence");
      const claim = answer ? next.claims.find(c => c.id === answer.claimId) : undefined;
      if (claim && answer) checkSentence(next, claim, rewrite, answer.assumptions);
      if (finalCheck) remove = true;
      else text = rewrite;
    }
    if (remove) {
      next.conclusion.deleted.push(entry.sentence);
      if (answer) answer.sentence = "";
      else delete next.conclusion.overall;
    } else if (item.status === "rewrite") {
      rewrote = true;
      if (answer) answer.sentence = text;
      else next.conclusion.overall = text;
    }
  }
  next.run.inferenceChecks = done + 1;
  if (rewrote && !finalCheck) return next;
  const undecidable = liveTestables(next).some(c => c.comparison?.state === "undecidable");
  next.conclusion.state = undecidable ? "undecidable" : "concluded";
  next.run.phase = "concluded";
  next.run.status = "finished";
  delete next.run.stopReason;
  return next;
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
