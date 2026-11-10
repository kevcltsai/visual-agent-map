/**
 * Argument map data contract, version 2 (Map.md top-level `argumentMap`, docs/product/DATA_CONTRACTS.md). Pure: no vault, no UI.
 * `map-model.ts` carries the key through untouched; this file reads it. Four outcomes:
 * - `absent`: no key.
 * - `usable`: a well-formed `"v": 2` value.
 * - `legacy`: a well-formed `"v": 1` value (the first method, `model-v1.ts`). Read-only: shown the old way, its nodes stay locked,
 *   nothing writes it, no flow runs on it.
 * - `unusable`: any other `v`, an unknown enum value, a role or reference that does not resolve, a malformed field. The caller keeps
 *   it exactly as saved, shows the map as an ordinary map and refuses to run the flow on it.
 */
import { readArgumentMap as readArgumentMapV1, type ArgumentMapData as ArgumentMapDataV1 } from "./model-v1";

export const ARGUMENT_MAP_VERSION = 2;
export const MAX_ROUND = 3;
export const MAX_HYPOTHESES = 6;
export const MAX_NEEDS = 6;
export const MAX_ROUND_NEEDS = 3;
export const MAX_RESEARCH_CALLS = 66;

export const ROLE_KEYS = ["proposition", "premises", "conclusion"] as const;
export type RoleKey = (typeof ROLE_KEYS)[number];
export type ArgumentRoles = Record<RoleKey, string>;

export const CLAIM_TYPES = ["fact", "causal", "main_cause", "comparison"] as const;
export type ClaimType = (typeof CLAIM_TYPES)[number];
export const CLAIM_ROLES = ["premise", "testable"] as const;
export type ClaimRole = (typeof CLAIM_ROLES)[number];
export const CLAIM_STATUSES = ["pending", "in_progress", "done", "not_evaluated"] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];
export const PREMISE_RESULTS = ["holds", "fails", "insufficient"] as const;
export type PremiseResult = (typeof PREMISE_RESULTS)[number];
export const CANDIDATE_KINDS = ["interpretation", "related"] as const;
export type CandidateKind = (typeof CANDIDATE_KINDS)[number];
export const HYPOTHESIS_ROLES = [
  "primary",
  "alternative",
  "reverse",
  "common_cause",
  "measurement",
  "facet",
  "side"
] as const;
export type HypothesisRole = (typeof HYPOTHESIS_ROLES)[number];
export const PREDICTION_KINDS = ["support", "refute", "identification"] as const;
export type PredictionKind = (typeof PREDICTION_KINDS)[number];
export const OVERLAP_STRENGTHS = ["same", "weaker"] as const;
export type OverlapStrength = (typeof OVERLAP_STRENGTHS)[number];
export const ITEM_STATES = ["pending", "searching", "found", "not_found"] as const;
export type ItemState = (typeof ITEM_STATES)[number];
export const DATA_STANCES = ["supports", "opposes"] as const;
export type DataStance = (typeof DATA_STANCES)[number];
export const REGISTRATIONS = ["pre", "post"] as const;
export type Registration = (typeof REGISTRATIONS)[number];
export const PROOF_CHECKS = ["page_match", "unverified_quote"] as const;
export type ProofCheck = (typeof PROOF_CHECKS)[number];
export const EVIDENCE_STANCES = ["supports", "refutes", "irrelevant"] as const;
export type EvidenceStance = (typeof EVIDENCE_STANCES)[number];
export const VERDICT_VALUES = ["supported", "refuted", "undecided", "insufficient"] as const;
export type VerdictValue = (typeof VERDICT_VALUES)[number];
export const VERDICT_BY = ["ai", "program"] as const;
export type VerdictBy = (typeof VERDICT_BY)[number];
export const REFUTATION_CLASSES = ["decisive", "conditional", "nondecisive"] as const;
export type RefutationClass = (typeof REFUTATION_CLASSES)[number];
export const CAUSAL_STATES = ["not_applicable", "established", "conditional", "compatible"] as const;
export type CausalState = (typeof CAUSAL_STATES)[number];
export const ASSUMPTION_STATES = ["checked", "unchecked", "defended"] as const;
export type AssumptionState = (typeof ASSUMPTION_STATES)[number];
export const CONFIDENCES = ["high", "medium", "low"] as const;
export type Confidence = (typeof CONFIDENCES)[number];
export const COMPARISON_STATES = ["pending", "done", "vetoed", "undecidable"] as const;
export type ComparisonState = (typeof COMPARISON_STATES)[number];
export const VETO_KINDS = ["contradiction", "double_count", "missed_alternative", "unhandled_counter"] as const;
export type VetoKind = (typeof VETO_KINDS)[number];
/** Every answer a conclusion may give (methodology section 9); the machine checks the answer against the claim's type. */
export const ANSWER_KEYS = [
  "holds",
  "fails",
  "causal_established",
  "causal_conditional",
  "causal_compatible",
  "causal_against",
  "main_cause_largest",
  "main_cause_secondary",
  "main_cause_not",
  "main_cause_undecidable",
  "compare_greater",
  "compare_equivalent",
  "compare_opposite",
  "compare_undetermined",
  "insufficient"
] as const;
export type AnswerKey = (typeof ANSWER_KEYS)[number];
export const RUN_PHASES = [
  "premises",
  "analysis",
  "comparison",
  "conclusion",
  "inference_check",
  "concluded",
  "stopped_premise"
] as const;
export type RunPhase = (typeof RUN_PHASES)[number];
export const RUN_STATUSES = ["running", "paused", "finished"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export const STOP_REASONS = ["premise", "data_missing", "limit", "user", "interrupted", "error"] as const;
export type StopReason = (typeof STOP_REASONS)[number];
export const CONCLUSION_STATES = ["pending", "concluded", "undecidable", "stopped_premise"] as const;
export type ConclusionState = (typeof CONCLUSION_STATES)[number];

export interface SourceProof {
  url: string;
  quote: string;
  claim: string;
  check: ProofCheck;
  checkedAt: string;
}
export interface Assessment {
  relevant: boolean;
  stance: EvidenceStance;
  scopeFit: boolean;
  scopeNote?: string;
  sourceType: string;
  underlyingSource: string;
  alsoRelevantTo: string[];
}
export interface Candidate {
  id: string;
  question: string;
  answerShape: string;
  diff: string;
  kind: CandidateKind;
  unanswered: boolean;
}
/** The locked restatement and breakdown. A map exists only after the user confirmed it, so `lockedAt` is always set. */
export interface Framing {
  original: string;
  restatement: string;
  presuppositions: string[];
  loadedTerms: string[];
  vagueTerms: string[];
  outOfScope: string[];
  candidates: Candidate[];
  chosen: string;
  settings: string[];
  composition?: string;
  attempts: number;
  lockedAt: string;
}
export interface Definition {
  term: string;
  meaning: string;
}
/** One piece of premise data (a leaf card). V1's shape plus the evidence assessment. */
export interface PremiseDatum {
  id: string;
  need: string;
  attempts: number;
  state: ItemState;
  stance?: DataStance;
  proof?: SourceProof;
  reason?: string;
  assessment?: Assessment;
}
export interface Veto {
  kind: VetoKind;
  detail: string;
  resolved: boolean;
}
export interface Allocation {
  needId: string;
  hypothesisId: string;
}
export interface Comparison {
  nodeId: string;
  attempts: number;
  state: ComparisonState;
  vetoes: Veto[];
  allocations: Allocation[];
  answer?: AnswerKey;
  missedAlternativeAdded: boolean;
}
export interface Claim {
  id: string;
  text: string;
  type: ClaimType;
  role: ClaimRole;
  dependsOn: string[];
  definitions: Definition[];
  status: ClaimStatus;
  /** Premises only. */
  data?: PremiseDatum[];
  result?: PremiseResult;
  /** Testable claims only. */
  comparison?: Comparison;
}
export interface OverlapEntry {
  hypothesisId: string;
  strength: OverlapStrength;
}
export interface Prediction {
  id: string;
  kind: PredictionKind;
  text: string;
  alsoPredictedBy: OverlapEntry[];
  /** Claim ids of the auxiliary premises this prediction leans on. */
  auxiliary: string[];
  required: boolean;
}
export interface Identification {
  strategy: string;
  assumptions: string[];
}
export interface Criteria {
  supports: string;
  refutes: string;
  irrelevant: string;
}
export interface Need {
  id: string;
  predictionId: string;
  text: string;
  criteria: Criteria;
  registered: Registration;
  addedRound: number;
  state: ItemState;
  proof?: SourceProof;
  reason?: string;
  /** The id of a `not_found` need of the same hypothesis this one stands in for. The dead need itself is never rewritten. */
  replaces?: string;
  /** The evidence assessment's answer to "is this the same condition as the need it replaces". */
  sameCondition?: boolean;
  assessment?: Assessment;
}
export interface Refutation {
  needId: string;
  class: RefutationClass;
  auxiliary: string[];
}
export interface AssumptionStatus {
  assumption: string;
  status: AssumptionState;
  defense?: string;
}
export interface Verdict {
  value: VerdictValue;
  by: VerdictBy;
  reason: string;
  citedNeeds: string[];
  counterNotes: string[];
  refutations: Refutation[];
  causal: CausalState;
  assumptionStatus: AssumptionStatus[];
  confidence: Confidence;
  reverdicts: number;
}
export interface Hypothesis {
  id: string;
  claimId: string;
  role: HypothesisRole;
  round: number;
  predictions: Prediction[];
  identification?: Identification;
  needs: Need[];
  verdict?: Verdict;
  /** A mark only: the user's reading, never an input to the comparison or the conclusion. */
  userVerdict?: VerdictValue;
}
export interface ArgumentRun {
  runId: string;
  phase: RunPhase;
  status: RunStatus;
  stopReason?: StopReason;
  researchCalls: number;
}
export interface ConclusionAnswer {
  claimId: string;
  answer: AnswerKey;
  sentence: string;
  assumptions: string[];
}
export interface ArgumentConclusion {
  state: ConclusionState;
  answers: ConclusionAnswer[];
  overall?: string;
  /** Sentences the inference check removed. */
  deleted: string[];
}
export interface ArgumentMapData {
  v: 2;
  roles: ArgumentRoles;
  framing: Framing;
  claims: Claim[];
  hypotheses: Hypothesis[];
  run: ArgumentRun;
  conclusion: ArgumentConclusion;
}

export type ArgumentMapRead =
  | { kind: "absent" }
  | { kind: "usable"; data: ArgumentMapData }
  | { kind: "legacy"; data: ArgumentMapDataV1 }
  | { kind: "unusable"; reason: string; raw: unknown };

type Rec = Record<string, unknown>;
const isRec = (value: unknown): value is Rec => !!value && typeof value === "object" && !Array.isArray(value);
const isStr = (value: unknown): value is string => typeof value === "string" && value !== "";
const oneOf = <T extends string>(list: readonly T[], value: unknown): value is T =>
  typeof value === "string" && (list as readonly string[]).includes(value);
const optOneOf = <T extends string>(list: readonly T[], value: unknown): boolean =>
  value === undefined || oneOf(list, value);
const count = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;
const bool = (value: unknown): value is boolean => typeof value === "boolean";
const strList = (value: unknown): value is string[] => Array.isArray(value) && value.every(isStr);
const optStr = (value: unknown): boolean => value === undefined || typeof value === "string";
const optBool = (value: unknown): boolean => value === undefined || bool(value);
const recList = (value: unknown): value is Rec[] => Array.isArray(value) && value.every(isRec);

function badProof(value: unknown): boolean {
  if (value === undefined) return false;
  return (
    !isRec(value) ||
    !isStr(value.url) ||
    !isStr(value.quote) ||
    !isStr(value.claim) ||
    !oneOf(PROOF_CHECKS, value.check) ||
    !isStr(value.checkedAt)
  );
}
function badAssessment(value: unknown): string | null {
  if (value === undefined) return null;
  if (!isRec(value)) return "assessment malformed";
  if (!bool(value.relevant) || !bool(value.scopeFit) || !isStr(value.sourceType) || !isStr(value.underlyingSource))
    return "assessment malformed";
  if (!optStr(value.scopeNote) || !strList(value.alsoRelevantTo)) return "assessment malformed";
  return oneOf(EVIDENCE_STANCES, value.stance) ? null : "unknown assessment enum";
}

/** Why the key cannot be used, or null when it is a well-formed version 2 value. Never mutates `raw`. */
function problem(raw: Rec, nodeIds: ReadonlySet<string>): string | null {
  if (!isRec(raw.roles)) return "roles missing";
  for (const key of ROLE_KEYS) {
    const id = raw.roles[key];
    if (!isStr(id)) return `role ${key} missing`;
    if (!nodeIds.has(id)) return `role ${key} points to a missing node`;
  }
  // framing
  const framing = raw.framing;
  if (!isRec(framing)) return "framing missing";
  if (!isStr(framing.original) || !isStr(framing.restatement) || !count(framing.attempts)) return "framing malformed";
  for (const key of ["presuppositions", "loadedTerms", "vagueTerms", "outOfScope", "settings"] as const)
    if (!strList(framing[key])) return "framing malformed";
  if (!optStr(framing.composition) || !isStr(framing.lockedAt)) return "framing malformed";
  if (!recList(framing.candidates)) return "framing malformed";
  const candidateIds = new Set<string>();
  for (const candidate of framing.candidates) {
    if (!isStr(candidate.id) || candidateIds.has(candidate.id)) return "candidate malformed";
    candidateIds.add(candidate.id);
    if (!isStr(candidate.question) || !isStr(candidate.answerShape) || typeof candidate.diff !== "string")
      return "candidate malformed";
    if (!oneOf(CANDIDATE_KINDS, candidate.kind)) return "unknown candidate enum";
    if (!bool(candidate.unanswered)) return "candidate malformed";
  }
  if (!isStr(framing.chosen) || !candidateIds.has(framing.chosen)) return "framing malformed";
  // run
  const run = raw.run;
  if (!isRec(run)) return "run missing";
  if (!isStr(run.runId) || !count(run.researchCalls)) return "run malformed";
  if (!oneOf(RUN_PHASES, run.phase) || !oneOf(RUN_STATUSES, run.status) || !optOneOf(STOP_REASONS, run.stopReason))
    return "unknown run enum";
  // claims
  if (!Array.isArray(raw.claims)) return "claims malformed";
  const ids = new Set<string>();
  const claimIds = new Set<string>();
  const claims = raw.claims as unknown[];
  for (const claim of claims) {
    if (!isRec(claim) || !isStr(claim.id) || ids.has(claim.id) || !isStr(claim.text)) return "claim malformed";
    ids.add(claim.id);
    claimIds.add(claim.id);
    if (!oneOf(CLAIM_TYPES, claim.type) || !oneOf(CLAIM_ROLES, claim.role) || !oneOf(CLAIM_STATUSES, claim.status))
      return "unknown claim enum";
    if (!strList(claim.dependsOn) || !Array.isArray(claim.definitions)) return "claim malformed";
    for (const definition of claim.definitions as unknown[])
      if (!isRec(definition) || !isStr(definition.term) || !isStr(definition.meaning)) return "claim malformed";
    if (!optOneOf(PREMISE_RESULTS, claim.result)) return "unknown claim enum";
    if (claim.role === "premise") {
      if (claim.type !== "fact") return "claim malformed"; // only a fact can be a premise
      if (claim.comparison !== undefined || !Array.isArray(claim.data)) return "claim malformed";
      for (const datum of claim.data as unknown[]) {
        if (!isRec(datum) || !isStr(datum.id) || !isStr(datum.need) || !count(datum.attempts) || ids.has(datum.id))
          return "premise data malformed";
        ids.add(datum.id);
        if (!oneOf(ITEM_STATES, datum.state) || !optOneOf(DATA_STANCES, datum.stance)) return "unknown datum enum";
        if (badProof(datum.proof) || !optStr(datum.reason)) return "premise data malformed";
        const bad = badAssessment(datum.assessment);
        if (bad) return bad;
      }
    } else {
      if (claim.data !== undefined || claim.result !== undefined) return "claim malformed";
      const comparison = claim.comparison;
      if (comparison !== undefined) {
        if (!isRec(comparison) || !isStr(comparison.nodeId) || ids.has(comparison.nodeId))
          return "comparison malformed";
        ids.add(comparison.nodeId);
        if (
          !count(comparison.attempts) ||
          !bool(comparison.missedAlternativeAdded) ||
          !optOneOf(ANSWER_KEYS, comparison.answer)
        )
          return "comparison malformed";
        if (!oneOf(COMPARISON_STATES, comparison.state)) return "unknown comparison enum";
        if (!recList(comparison.vetoes) || !recList(comparison.allocations)) return "comparison malformed";
        for (const veto of comparison.vetoes) {
          if (!oneOf(VETO_KINDS, veto.kind)) return "unknown veto kind";
          if (typeof veto.detail !== "string" || !bool(veto.resolved)) return "comparison malformed";
        }
      }
    }
  }
  for (const claim of claims as Rec[])
    for (const dep of claim.dependsOn as string[]) if (!claimIds.has(dep) || dep === claim.id) return "claim malformed";
  // hypotheses
  if (!Array.isArray(raw.hypotheses)) return "hypotheses malformed";
  const hypotheses = raw.hypotheses as unknown[];
  const predictionIds = new Set<string>();
  const needIds = new Set<string>();
  const hypothesisIds = new Set<string>();
  for (const hypothesis of hypotheses) {
    if (!isRec(hypothesis) || !isStr(hypothesis.id) || ids.has(hypothesis.id)) return "hypothesis malformed";
    ids.add(hypothesis.id);
    hypothesisIds.add(hypothesis.id);
    if (!isStr(hypothesis.claimId) || !claimIds.has(hypothesis.claimId)) return "hypothesis malformed";
    if (!count(hypothesis.round) || !recList(hypothesis.predictions) || !Array.isArray(hypothesis.needs))
      return "hypothesis malformed";
    if (!oneOf(HYPOTHESIS_ROLES, hypothesis.role) || !optOneOf(VERDICT_VALUES, hypothesis.userVerdict))
      return "unknown hypothesis enum";
    const identification = hypothesis.identification;
    if (
      identification !== undefined &&
      (!isRec(identification) || !isStr(identification.strategy) || !strList(identification.assumptions))
    )
      return "hypothesis malformed";
    const own = new Set<string>();
    for (const prediction of hypothesis.predictions) {
      if (!isStr(prediction.id) || predictionIds.has(prediction.id) || !isStr(prediction.text))
        return "prediction malformed";
      predictionIds.add(prediction.id);
      own.add(prediction.id);
      if (!oneOf(PREDICTION_KINDS, prediction.kind)) return "unknown prediction enum";
      if (!bool(prediction.required) || !strList(prediction.auxiliary) || !recList(prediction.alsoPredictedBy))
        return "prediction malformed";
      for (const id of prediction.auxiliary) if (!claimIds.has(id)) return "prediction malformed";
      for (const entry of prediction.alsoPredictedBy) {
        if (!isStr(entry.hypothesisId)) return "prediction malformed";
        if (!oneOf(OVERLAP_STRENGTHS, entry.strength)) return "unknown prediction enum";
      }
    }
    for (const need of hypothesis.needs as unknown[]) {
      if (!isRec(need) || !isStr(need.id) || !isStr(need.text) || !count(need.addedRound) || ids.has(need.id))
        return "need malformed";
      ids.add(need.id);
      needIds.add(need.id);
      if (!isStr(need.predictionId) || !own.has(need.predictionId)) return "need malformed";
      const criteria = need.criteria;
      if (!isRec(criteria) || !isStr(criteria.supports) || !isStr(criteria.refutes) || !isStr(criteria.irrelevant))
        return "need malformed";
      if (!oneOf(ITEM_STATES, need.state) || !oneOf(REGISTRATIONS, need.registered)) return "unknown need enum";
      if (badProof(need.proof) || !optStr(need.reason) || !optBool(need.sameCondition)) return "need malformed";
      if (need.replaces !== undefined && !isStr(need.replaces)) return "need malformed";
      const bad = badAssessment(need.assessment);
      if (bad) return bad;
    }
    const replaced = new Set<string>();
    for (const need of hypothesis.needs as Rec[]) {
      if (need.replaces === undefined) continue;
      const target = (hypothesis.needs as Rec[]).find(other => other.id === need.replaces);
      if (
        !target ||
        target.state !== "not_found" ||
        (target.addedRound as number) >= (need.addedRound as number) ||
        replaced.has(need.replaces as string)
      )
        return "need malformed";
      replaced.add(need.replaces as string);
    }
  }
  // cross references that only exist once every hypothesis is read
  for (const claim of claims as Rec[]) {
    const comparison = claim.comparison;
    if (!isRec(comparison)) continue;
    for (const allocation of comparison.allocations as Rec[])
      if (
        !isStr(allocation.needId) ||
        !needIds.has(allocation.needId) ||
        !isStr(allocation.hypothesisId) ||
        !hypothesisIds.has(allocation.hypothesisId)
      )
        return "comparison malformed";
  }
  for (const hypothesis of hypotheses as Rec[]) {
    for (const prediction of hypothesis.predictions as Rec[])
      for (const entry of prediction.alsoPredictedBy as Rec[])
        if (!hypothesisIds.has(entry.hypothesisId as string)) return "prediction malformed";
    for (const need of hypothesis.needs as Rec[]) {
      const assessment = need.assessment;
      if (isRec(assessment))
        for (const id of assessment.alsoRelevantTo as string[])
          if (!hypothesisIds.has(id)) return "assessment malformed";
    }
    const verdict = hypothesis.verdict;
    if (verdict === undefined) continue;
    if (!isRec(verdict) || typeof verdict.reason !== "string" || !count(verdict.reverdicts)) return "verdict malformed";
    if (!oneOf(VERDICT_VALUES, verdict.value) || !oneOf(VERDICT_BY, verdict.by)) return "unknown verdict enum";
    if (!oneOf(CAUSAL_STATES, verdict.causal) || !oneOf(CONFIDENCES, verdict.confidence)) return "unknown verdict enum";
    if (
      !strList(verdict.citedNeeds) ||
      !Array.isArray(verdict.counterNotes) ||
      !recList(verdict.refutations) ||
      !recList(verdict.assumptionStatus)
    )
      return "verdict malformed";
    if (!(verdict.counterNotes as unknown[]).every(note => typeof note === "string")) return "verdict malformed";
    for (const id of verdict.citedNeeds) if (!needIds.has(id)) return "verdict malformed";
    for (const refutation of verdict.refutations) {
      if (!isStr(refutation.needId) || !needIds.has(refutation.needId) || !strList(refutation.auxiliary))
        return "verdict malformed";
      if (!oneOf(REFUTATION_CLASSES, refutation.class)) return "unknown verdict enum";
      for (const id of refutation.auxiliary) if (!claimIds.has(id)) return "verdict malformed";
    }
    for (const entry of verdict.assumptionStatus) {
      if (!isStr(entry.assumption) || !optStr(entry.defense)) return "verdict malformed";
      if (!oneOf(ASSUMPTION_STATES, entry.status)) return "unknown verdict enum";
    }
  }
  // conclusion
  const conclusion = raw.conclusion;
  if (!isRec(conclusion) || !oneOf(CONCLUSION_STATES, conclusion.state)) return "conclusion malformed";
  if (!recList(conclusion.answers) || !strList(conclusion.deleted) || !optStr(conclusion.overall))
    return "conclusion malformed";
  for (const answer of conclusion.answers) {
    if (!isStr(answer.claimId) || !claimIds.has(answer.claimId) || typeof answer.sentence !== "string")
      return "conclusion malformed";
    if (!oneOf(ANSWER_KEYS, answer.answer)) return "unknown conclusion enum";
    if (!strList(answer.assumptions)) return "conclusion malformed";
  }
  return null;
}

/**
 * Reads `map.argumentMap`. A missing key is `absent`; `"v": 2` that validates is `usable`; `"v": 1` that validates as the old shape is
 * `legacy`; anything else is `unusable` (and must be kept as saved). Never mutates the map.
 */
export function readArgumentMap(map: { nodes: readonly { id: string }[]; argumentMap?: unknown }): ArgumentMapRead {
  const raw = map.argumentMap;
  if (raw === undefined) return { kind: "absent" };
  if (!isRec(raw)) return { kind: "unusable", reason: "not an object", raw };
  if (raw.v === 1) {
    const old = readArgumentMapV1(map);
    return old.kind === "usable"
      ? { kind: "legacy", data: old.data }
      : { kind: "unusable", reason: old.kind === "unusable" ? old.reason : "malformed version 1", raw };
  }
  if (raw.v !== ARGUMENT_MAP_VERSION) return { kind: "unusable", reason: "unsupported version", raw };
  const found = problem(raw, new Set(map.nodes.map(node => node.id)));
  if (found) return { kind: "unusable", reason: found, raw };
  return { kind: "usable", data: raw as unknown as ArgumentMapData };
}

/**
 * The node ids the flow owns, read tolerantly from the raw key (any version, usable or not) so a key that cannot be used still
 * protects what it names: the role nodes; version 1's situation data, hypotheses and needs; version 2's claims, premise data,
 * comparison cards, hypotheses and needs. Empty when the map has no `argumentMap` key. The AI lock treats these as locked.
 */
export function managedNodeIds(map: { argumentMap?: unknown } | null | undefined): Set<string> {
  const ids = new Set<string>();
  const raw = map?.argumentMap;
  if (!isRec(raw)) return ids;
  const add = (value: unknown): void => {
    if (isStr(value)) ids.add(value);
  };
  if (isRec(raw.roles)) for (const id of Object.values(raw.roles)) add(id);
  if (isRec(raw.situation) && Array.isArray(raw.situation.data))
    for (const datum of raw.situation.data) if (isRec(datum)) add(datum.id);
  if (Array.isArray(raw.claims))
    for (const claim of raw.claims) {
      if (!isRec(claim)) continue;
      add(claim.id);
      if (Array.isArray(claim.data)) for (const datum of claim.data) if (isRec(datum)) add(datum.id);
      if (isRec(claim.comparison)) add(claim.comparison.nodeId);
    }
  if (Array.isArray(raw.hypotheses))
    for (const h of raw.hypotheses) {
      if (!isRec(h)) continue;
      add(h.id);
      if (Array.isArray(h.needs)) for (const need of h.needs) if (isRec(need)) add(need.id);
    }
  return ids;
}
