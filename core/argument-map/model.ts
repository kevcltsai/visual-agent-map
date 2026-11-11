/**
 * Argument map data contract (Map.md top-level `argumentMap`, docs/product/DATA_CONTRACTS.md). Pure: no vault, no UI.
 * `map-model.ts` carries the key through untouched; this file reads it. A key that cannot be read (`v` other than 1, an unknown
 * enum value, a role pointing to a node that is not in the map, a malformed field) is `unusable`: the caller keeps it exactly
 * as saved, shows the map as an ordinary map and refuses to run the flow on it.
 */

export const ARGUMENT_MAP_VERSION = 1;
export const MAX_ROUND = 3;
export const MAX_HYPOTHESES = 6;
export const MAX_NEEDS = 6;
export const MAX_ROUND_NEEDS = 3;
export const MAX_RESEARCH_CALLS = 78;
export const MAX_SITUATION_DATA = 6;
export const MAX_SITUATION_ATTEMPTS = 2;
export const MIN_VERIFIED = 3;
/** Facet-judged maps (V1 boost): 3-5 facets, 1-3 needs each, 15 first-round needs, 9 retry needs, 24 situation research calls. */
export const MIN_FACETS = 3;
export const MAX_FACETS = 5;
export const MAX_FACET_NEEDS = 3;
export const MAX_SITUATION_NEEDS = 15;
export const MAX_RETRY_NEEDS = 9;
export const MAX_SITUATION_RESEARCH = 24;

/** The three role nodes every map has; the group nodes are optional (a fact map has none, a causal map has all three, a map made before question types has the first two). */
export const REQUIRED_ROLE_KEYS = ["proposition", "situation", "conclusion"] as const;
export const GROUP_ROLE_KEYS = ["verified", "eliminated", "unconfirmed"] as const;
export const ROLE_KEYS = [...REQUIRED_ROLE_KEYS, ...GROUP_ROLE_KEYS] as const;
export type RoleKey = (typeof ROLE_KEYS)[number];
export type ArgumentRoles = Record<(typeof REQUIRED_ROLE_KEYS)[number], string> &
  Partial<Record<(typeof GROUP_ROLE_KEYS)[number], string>>;
/** Decision #60: a fact question is concluded from its facets by the program; a causal question goes on to hypotheses. */
export const QUESTION_TYPES = ["fact", "causal"] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];
/** Source tier (decision #64): `primary` = official/government/international body, large news organisation or academic work; `other` needs a second independent source. */
export const SOURCE_TIERS = ["primary", "other"] as const;
export type SourceTier = (typeof SOURCE_TIERS)[number];

export const RUN_PHASES = ["situation", "analysis", "concluded", "stopped_mismatch", "stopped_limit"] as const;
export type RunPhase = (typeof RUN_PHASES)[number];
export const RUN_STATUSES = ["running", "paused", "finished"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export const STOP_REASONS = ["mismatch", "data_missing", "limit", "user", "interrupted", "error"] as const;
export type StopReason = (typeof STOP_REASONS)[number];
export const ITEM_STATES = ["pending", "searching", "found", "not_found"] as const;
export type ItemState = (typeof ITEM_STATES)[number];
export const DATA_STANCES = ["supports", "opposes"] as const;
export type DataStance = (typeof DATA_STANCES)[number];
export const NEED_STANCES = ["supports", "contradicts", "uncertain"] as const;
export type NeedStance = (typeof NEED_STANCES)[number];
export const PROOF_CHECKS = ["page_match", "provider_read"] as const;
export type ProofCheck = (typeof PROOF_CHECKS)[number];
/** `unconfirmed` (decision #58): the facets stayed insufficient after the retry round; the run goes on with the situation marked unconfirmed. */
export const GATE_STATES = ["pending", "matched", "unmatched", "unconfirmed"] as const;
export type GateState = (typeof GATE_STATES)[number];
export const GATE_KINDS = ["not_matching", "data_missing", "data_insufficient"] as const;
export type GateKind = (typeof GATE_KINDS)[number];
export const PROP_STANCES = ["supports", "refutes", "irrelevant"] as const;
export type PropStance = (typeof PROP_STANCES)[number];
export const FACET_VERDICTS = ["supports", "refutes", "insufficient", "pending"] as const;
export type FacetVerdict = (typeof FACET_VERDICTS)[number];
/**
 * A found datum's stance is locked once the facet judge decided `supports` or `refutes`: it never changes. An `irrelevant` stance may be
 * judged again in round 2, and a found datum with no stance is simply not judged yet. Research stance (relative to the need) never decides
 * the stance toward the proposition, so nothing is locked before the judge has judged it.
 */
export const isStanceLocked = (datum: { propStance?: PropStance; stanceReason?: string }): boolean =>
  datum.propStance !== undefined && datum.propStance !== "irrelevant";
export const VERDICTS = ["supported", "refuted", "undecided"] as const;
export type Verdict = (typeof VERDICTS)[number];
export const LOCATIONS = ["verifying", "eliminated"] as const;
export type Location = (typeof LOCATIONS)[number];
export const CONCLUSION_STATES = ["pending", "concluded", "stopped"] as const;
export type ConclusionState = (typeof CONCLUSION_STATES)[number];

/** What the page reports as a number, as text: the chart turns it into a number later. */
export interface SourceFigure {
  number: string;
  period: string;
  unit: string;
}
/** What was searched for one item: queries the program recorded, pages it opened, and why the result was not used. At most 5 queries and 5 pages, each at most 200 characters. */
export interface SearchLog {
  queries: string[];
  opened: string[];
  why: string;
}
/** Insights of a facet map's verdict (V1 boost): how the evidence agrees, pulls against itself, or is still missing. At most 3, each at most 300 characters. */
export const INSIGHT_KINDS = ["consistent", "tension", "missing"] as const;
export type InsightKind = (typeof INSIGHT_KINDS)[number];
export const MAX_INSIGHTS = 3;
export const INSIGHT_MAX_TEXT = 300;
export interface HypothesisInsight {
  kind: InsightKind;
  text: string;
}
export const SEARCH_LOG_MAX_ITEMS = 5;
export const SEARCH_LOG_MAX_TEXT = 200;
export interface SourceProof {
  url: string;
  quote: string;
  claim: string;
  /** Set when the AI's claim carried a number the quote does not: `claim` was then replaced by the quote. */
  claimUnverified?: boolean;
  check: ProofCheck;
  checkedAt: string;
  figure?: SourceFigure;
  /** Decision #64. Absent on every older proof. */
  tier?: SourceTier;
  /** A second, independent source that agrees and passed the same source check. Stored only then. */
  second?: SecondSource;
}
export interface SecondSource {
  url: string;
  quote: string;
  check: ProofCheck;
  checkedAt: string;
}
/** An `other`-tier source with no verified second source: its data cannot alone carry a facet's supports or refutes (decision #64). Older proofs (no tier) are not uncertain. */
export const isUncertainSource = (proof: { tier?: SourceTier; second?: unknown } | undefined): boolean =>
  proof?.tier === "other" && !proof.second;
export interface SituationDatum {
  id: string;
  need: string;
  attempts: number;
  state: ItemState;
  stance?: DataStance;
  proof?: SourceProof;
  reason?: string;
  /** Facet-judged maps only: the facet this datum belongs to, its stance toward the proposition and why. */
  facetId?: string;
  propStance?: PropStance;
  stanceReason?: string;
  searchLog?: SearchLog;
}
export interface SituationGate {
  state: GateState;
  kind?: GateKind;
  reason?: string;
  citedData: string[];
  /** Facet-judged maps: the round (1 or 2) the gate is in or finished in. */
  round?: 1 | 2;
}
export interface AssumptionItem {
  label: string;
  value: string;
  reason: string;
}
export interface Facet {
  /** Node id of the facet card. */
  id: string;
  title: string;
  verdict: FacetVerdict;
  reason: string;
  citedData: string[];
  summary: string;
  /** What data supports this facet's sub-claim and what refutes it. Absent on maps made before facets carried one. */
  criterion?: string;
  /** The comparison baseline this facet checks against (one of the definitions card's values). */
  baseline?: string;
}
export interface Need {
  id: string;
  text: string;
  addedRound: number;
  state: ItemState;
  stance?: NeedStance;
  proof?: SourceProof;
  reason?: string;
  /** On a need added in a later round: the id of a `not_found` need of the same hypothesis it stands in for. The dead need itself is never rewritten. */
  replaces?: string;
  /** Decision #62: the one need whose finding decides the hypothesis (exactly one per hypothesis in the first round; a later round may replace a dead one). */
  core?: true;
  searchLog?: SearchLog;
}
export interface Hypothesis {
  id: string;
  citedData: string[];
  round: number;
  location: Location;
  needs: Need[];
  /** Facet-judged maps: what the verdict step said about how the evidence agrees, pulls against itself or is missing (kept so the note can be rewritten). */
  insights?: HypothesisInsight[];
  /** Facet-judged maps: "from datum X we observe Y, so we guess Z", and whether it explains the proposition by a cause other than the one it names. */
  basis?: string;
  alternative?: boolean;
  /** The statement as the AI proposed it, stored at creation. Verdict, needs and conclusion read this, never the editable note text. Absent on maps made before it was stored. */
  statement?: string;
  aiVerdict?: Verdict;
  userVerdict?: Verdict;
  eliminationReason?: string;
}
export interface ArgumentRun {
  runId: string;
  phase: RunPhase;
  status: RunStatus;
  stopReason?: StopReason;
  researchCalls: number;
  /** A re-run: the definitions the owner kept. Saved here so a run paused before the facet plan still uses them on resume. */
  presetAssumptions?: AssumptionItem[];
  /** A re-run: the question type the owner kept on the definitions card; it wins over the AI's. */
  presetQuestionType?: QuestionType;
}
export interface ArgumentConclusion {
  state: ConclusionState;
  basedOn: string[];
  missing: string[];
  /** Decision #59: written from fewer verified hypotheses than the target, at the research limit. Absent on every older map. */
  partial?: boolean;
}
export interface ArgumentMapData {
  v: 1;
  roles: ArgumentRoles;
  run: ArgumentRun;
  situation: {
    data: SituationDatum[];
    gate: SituationGate;
    /** `id` is the node id of the assumption card. Facet-judged maps only. `insights` is the last facet judgement's reading of the card (0 to 3 sentences). */
    assumptions?: { id: string; items: AssumptionItem[]; insights?: string[]; definitionNeeds?: string[] };
    /** Present only on a facet-judged map; a map without it runs the V1 path unchanged. */
    facets?: Facet[];
    causalQuestions?: string[];
    /** Facet-judged maps: the question the situation card is titled with. */
    question?: string;
    /** Decision #60. Absent on a map made before question types: with facets it is a legacy facet map (see isLegacyFacetMap). */
    questionType?: QuestionType;
  };
  hypotheses: Hypothesis[];
  conclusion: ArgumentConclusion;
}

export type ArgumentMapRead =
  { kind: "absent" } | { kind: "usable"; data: ArgumentMapData } | { kind: "unusable"; reason: string; raw: unknown };

type Rec = Record<string, unknown>;
const isRec = (value: unknown): value is Rec => !!value && typeof value === "object" && !Array.isArray(value);
const isStr = (value: unknown): value is string => typeof value === "string" && value !== "";
const oneOf = <T extends string>(list: readonly T[], value: unknown): value is T =>
  typeof value === "string" && (list as readonly string[]).includes(value);
const optOneOf = <T extends string>(list: readonly T[], value: unknown): boolean =>
  value === undefined || oneOf(list, value);
const count = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;
const strList = (value: unknown): value is string[] => Array.isArray(value) && value.every(isStr);
const optStr = (value: unknown): boolean => value === undefined || typeof value === "string";
const insightText = (value: unknown): boolean => isStr(value) && value.length <= INSIGHT_MAX_TEXT;
function badInsights(value: unknown): boolean {
  if (value === undefined) return false;
  return !Array.isArray(value) || value.length > MAX_INSIGHTS || !value.every(insightText);
}
function badHypothesisInsights(value: unknown): boolean {
  if (value === undefined) return false;
  if (!Array.isArray(value) || value.length > MAX_INSIGHTS) return true;
  return value.some(
    entry =>
      !isRec(entry) || Object.keys(entry).length !== 2 || !oneOf(INSIGHT_KINDS, entry.kind) || !insightText(entry.text)
  );
}

function badFigure(value: unknown): boolean {
  if (value === undefined) return false;
  if (!isRec(value) || Object.keys(value).length !== 3) return true;
  return !isStr(value.number) || !isStr(value.period) || !isStr(value.unit);
}

function badSecond(value: unknown): boolean {
  if (value === undefined) return false;
  return (
    !isRec(value) ||
    !isStr(value.url) ||
    !isStr(value.quote) ||
    !oneOf(PROOF_CHECKS, value.check) ||
    !isStr(value.checkedAt)
  );
}

function badProof(value: unknown): boolean {
  if (value === undefined) return false;
  return (
    !isRec(value) ||
    !isStr(value.url) ||
    !isStr(value.quote) ||
    !isStr(value.claim) ||
    !oneOf(PROOF_CHECKS, value.check) ||
    !isStr(value.checkedAt) ||
    badFigure(value.figure) ||
    !optOneOf(SOURCE_TIERS, value.tier) ||
    badSecond(value.second)
  );
}

function badSearchLog(value: unknown): boolean {
  if (value === undefined) return false;
  if (!isRec(value) || typeof value.why !== "string" || value.why.length > SEARCH_LOG_MAX_TEXT) return true;
  const bad = (list: unknown): boolean =>
    !Array.isArray(list) ||
    list.length > SEARCH_LOG_MAX_ITEMS ||
    list.some(entry => typeof entry !== "string" || entry.length > SEARCH_LOG_MAX_TEXT);
  return bad(value.queries) || bad(value.opened);
}

/** Facets, assumptions and causal questions (all optional, all or nothing for the facets); their ids join `ids`. */
function readFacets(situation: Rec, ids: Set<string>): string | null {
  const { facets, assumptions, causalQuestions } = situation;
  if (causalQuestions !== undefined && !strList(causalQuestions)) return "situation malformed";
  if (situation.question !== undefined && !isStr(situation.question)) return "situation malformed";
  if (assumptions !== undefined) {
    if (!isRec(assumptions) || !isStr(assumptions.id) || !Array.isArray(assumptions.items))
      return "assumptions malformed";
    for (const item of assumptions.items as unknown[])
      if (!isRec(item) || !isStr(item.label) || !isStr(item.value) || !isStr(item.reason))
        return "assumptions malformed";
    if (badInsights(assumptions.insights)) return "assumptions malformed";
    if (assumptions.definitionNeeds !== undefined && !strList(assumptions.definitionNeeds))
      return "assumptions malformed";
    ids.add(assumptions.id);
  }
  if (facets === undefined) return null;
  if (!Array.isArray(facets) || facets.length < MIN_FACETS || facets.length > MAX_FACETS) return "facets malformed";
  for (const facet of facets as unknown[]) {
    if (!isRec(facet) || !isStr(facet.id) || ids.has(facet.id) || !isStr(facet.title)) return "facets malformed";
    ids.add(facet.id);
    if (!oneOf(FACET_VERDICTS, facet.verdict)) return "unknown facet enum";
    if (typeof facet.reason !== "string" || typeof facet.summary !== "string" || !strList(facet.citedData))
      return "facets malformed";
    if (!optStr(facet.criterion) || !optStr(facet.baseline)) return "facets malformed";
  }
  return null;
}

/** Why the key cannot be used, or null when it is a well-formed version 1 value. Never mutates `raw`. */
function problem(raw: unknown, nodeIds: ReadonlySet<string>): string | null {
  if (!isRec(raw)) return "not an object";
  if (raw.v !== ARGUMENT_MAP_VERSION) return "unsupported version";
  if (!isRec(raw.roles)) return "roles missing";
  for (const key of REQUIRED_ROLE_KEYS) {
    const id = raw.roles[key];
    if (!isStr(id)) return `role ${key} missing`;
    if (!nodeIds.has(id)) return `role ${key} points to a missing node`;
  }
  for (const key of GROUP_ROLE_KEYS) {
    const id = raw.roles[key];
    if (id === undefined) continue;
    if (!isStr(id)) return `role ${key} malformed`;
    if (!nodeIds.has(id)) return `role ${key} points to a missing node`;
  }
  const run = raw.run;
  if (!isRec(run)) return "run missing";
  if (!isStr(run.runId) || !count(run.researchCalls)) return "run malformed";
  if (run.presetAssumptions !== undefined) {
    const preset = run.presetAssumptions;
    if (
      !Array.isArray(preset) ||
      !preset.length ||
      preset.some(item => !isRec(item) || !isStr(item.label) || !isStr(item.value) || !isStr(item.reason))
    )
      return "run malformed";
  }
  if (!optOneOf(QUESTION_TYPES, run.presetQuestionType)) return "unknown run enum";
  if (!oneOf(RUN_PHASES, run.phase) || !oneOf(RUN_STATUSES, run.status) || !optOneOf(STOP_REASONS, run.stopReason))
    return "unknown run enum";
  const situation = raw.situation;
  if (!isRec(situation) || !Array.isArray(situation.data) || !isRec(situation.gate)) return "situation malformed";
  if (!optOneOf(QUESTION_TYPES, situation.questionType)) return "unknown situation enum";
  const ids = new Set<string>();
  const facetProblem = readFacets(situation, ids);
  if (facetProblem) return facetProblem;
  const facetIds = Array.isArray(situation.facets) ? new Set((situation.facets as Rec[]).map(f => f.id)) : null;
  for (const datum of situation.data as unknown[]) {
    if (!isRec(datum) || !isStr(datum.id) || !isStr(datum.need) || !count(datum.attempts) || ids.has(datum.id))
      return "situation data malformed";
    ids.add(datum.id);
    if (!oneOf(ITEM_STATES, datum.state) || !optOneOf(DATA_STANCES, datum.stance)) return "unknown situation enum";
    if (badProof(datum.proof) || !optStr(datum.reason) || badSearchLog(datum.searchLog))
      return "situation data malformed";
    if (!optOneOf(PROP_STANCES, datum.propStance)) return "unknown situation enum";
    if (!optStr(datum.stanceReason) || (datum.facetId !== undefined && !isStr(datum.facetId)))
      return "situation data malformed";
    if (facetIds && (!isStr(datum.facetId) || !facetIds.has(datum.facetId))) return "situation data malformed";
  }
  const gate = situation.gate;
  if (!oneOf(GATE_STATES, gate.state) || !optOneOf(GATE_KINDS, gate.kind)) return "unknown gate enum";
  if (gate.round !== undefined && gate.round !== 1 && gate.round !== 2) return "gate malformed";
  if (!strList(gate.citedData) || !optStr(gate.reason)) return "gate malformed";
  if (!Array.isArray(raw.hypotheses)) return "hypotheses malformed";
  for (const hypothesis of raw.hypotheses as unknown[]) {
    if (!isRec(hypothesis) || !isStr(hypothesis.id) || ids.has(hypothesis.id)) return "hypothesis malformed";
    ids.add(hypothesis.id);
    if (!strList(hypothesis.citedData) || !count(hypothesis.round) || !Array.isArray(hypothesis.needs))
      return "hypothesis malformed";
    if (!oneOf(LOCATIONS, hypothesis.location) || !optOneOf(VERDICTS, hypothesis.aiVerdict))
      return "unknown hypothesis enum";
    if (!optOneOf(VERDICTS, hypothesis.userVerdict) || !optStr(hypothesis.eliminationReason))
      return "hypothesis malformed";
    if (
      !optStr(hypothesis.basis) ||
      !optStr(hypothesis.statement) ||
      (hypothesis.alternative !== undefined && typeof hypothesis.alternative !== "boolean")
    )
      return "hypothesis malformed";
    if (badHypothesisInsights(hypothesis.insights)) return "hypothesis malformed";
    for (const need of hypothesis.needs as unknown[]) {
      if (!isRec(need) || !isStr(need.id) || !isStr(need.text) || !count(need.addedRound) || ids.has(need.id))
        return "need malformed";
      ids.add(need.id);
      if (!oneOf(ITEM_STATES, need.state) || !optOneOf(NEED_STANCES, need.stance)) return "unknown need enum";
      if (badProof(need.proof) || !optStr(need.reason) || badSearchLog(need.searchLog)) return "need malformed";
      if (need.replaces !== undefined && !isStr(need.replaces)) return "need malformed";
      if (need.core !== undefined && need.core !== true) return "need malformed";
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
  const conclusion = raw.conclusion;
  if (!isRec(conclusion) || !oneOf(CONCLUSION_STATES, conclusion.state)) return "conclusion malformed";
  if (!strList(conclusion.basedOn) || !strList(conclusion.missing)) return "conclusion malformed";
  if (conclusion.partial !== undefined && conclusion.partial !== true) return "conclusion malformed";
  return null;
}

/** Reads `map.argumentMap`. A missing key is `absent`; anything that fails validation is `unusable` (and must be kept as saved). */
export function readArgumentMap(map: { nodes: readonly { id: string }[]; argumentMap?: unknown }): ArgumentMapRead {
  if (map.argumentMap === undefined) return { kind: "absent" };
  const found = problem(map.argumentMap, new Set(map.nodes.map(node => node.id)));
  if (found) return { kind: "unusable", reason: found, raw: map.argumentMap };
  return { kind: "usable", data: map.argumentMap as ArgumentMapData };
}

/**
 * The node ids the flow owns (the five role nodes, every situation datum card, every facet card, the assumption card, every hypothesis and every need card), read tolerantly from the raw
 * key so an unusable key still protects what it names. Empty when the map has no `argumentMap` key. The AI lock
 * treats these as locked; the runner never asks the lock.
 */
export function managedNodeIds(map: { argumentMap?: unknown } | null | undefined): Set<string> {
  const ids = new Set<string>();
  const raw = map?.argumentMap;
  if (!isRec(raw)) return ids;
  if (isRec(raw.roles)) for (const id of Object.values(raw.roles)) if (isStr(id)) ids.add(id);
  if (isRec(raw.situation) && Array.isArray(raw.situation.data))
    for (const datum of raw.situation.data) if (isRec(datum) && isStr(datum.id)) ids.add(datum.id);
  if (isRec(raw.situation)) {
    if (Array.isArray(raw.situation.facets))
      for (const facet of raw.situation.facets) if (isRec(facet) && isStr(facet.id)) ids.add(facet.id);
    if (isRec(raw.situation.assumptions) && isStr(raw.situation.assumptions.id)) ids.add(raw.situation.assumptions.id);
  }
  if (Array.isArray(raw.hypotheses))
    for (const h of raw.hypotheses) {
      if (!isRec(h)) continue;
      if (isStr(h.id)) ids.add(h.id);
      if (Array.isArray(h.needs)) for (const need of h.needs) if (isRec(need) && isStr(need.id)) ids.add(need.id);
    }
  return ids;
}

// ---- selectors ---------------------------------------------------------------------------------------------------------

/** The verdict shown and used: the user's value first, then the AI's, else undecided. */
export function effectiveVerdict(h: Hypothesis): Verdict {
  return h.userVerdict ?? h.aiVerdict ?? "undecided";
}
export function foundNeeds(h: Hypothesis): Need[] {
  return h.needs.filter(need => need.state === "found");
}
/** A miss caused by the source (the URL or the quote failed to check): the question stays open, so another source may answer it. Any other miss says the evidence is not there, and no later need may stand in for it. */
export const isSourceSideMiss = (need: { reason?: string }): boolean => (need.reason ?? "").startsWith("source_");
/** Ids of dead needs that a later need of the same hypothesis stands in for. Re-checked here (not trusted from the field alone): only a `not_found` need can be retired, only by a need of a later round, and only when the miss was source-side or the dead need was the core (decision #62: a core nobody found, for any reason, may be replaced). A "nothing found", unanswered, uncertain or failed supplementary need keeps blocking old-rule verification. */
export function retiredNeedIds(h: Hypothesis): Set<string> {
  const retired = new Set<string>();
  for (const need of h.needs) {
    if (need.replaces === undefined) continue;
    const dead = h.needs.find(other => other.id === need.replaces);
    if (
      dead &&
      dead.state === "not_found" &&
      (isSourceSideMiss(dead) || dead.core === true) &&
      need.addedRound > dead.addedRound
    )
      retired.add(dead.id);
  }
  return retired;
}
/** The core need that still counts (decision #62): the last core need not replaced by a later one. Absent on a hypothesis without a core (a map made before cores, or a V1 map). */
export function liveCore(h: Hypothesis): Need | undefined {
  const retired = retiredNeedIds(h);
  return [...h.needs].reverse().find(need => need.core === true && !retired.has(need.id));
}
export function allNeedsFound(h: Hypothesis): boolean {
  const retired = retiredNeedIds(h);
  const live = h.needs.filter(need => !retired.has(need.id));
  return live.length > 0 && live.every(need => need.state === "found");
}
/** Core rule (decision #62): the core is found and its stance supports the hypothesis, and the live found needs that support outnumber those that contradict. An uncertain stance counts for neither side. Stances are program data, checked here. */
export function coreEvidenceHolds(h: Hypothesis): boolean {
  const core = liveCore(h);
  if (!core || core.state !== "found" || core.stance !== "supports") return false;
  const retired = retiredNeedIds(h);
  const stances = foundNeeds(h)
    .filter(n => !retired.has(n.id))
    .map(n => n.stance);
  return stances.filter(s => s === "supports").length > stances.filter(s => s === "contradicts").length;
}
/** "Verified" is never stored. With a live core: the core rule above, still in the verifying group, effective verdict supported (supplementary needs that were not found do not block). Without a core: needs listed and all found, verifying, effective verdict supported (the rule of maps made before cores). */
export function isVerified(h: Hypothesis): boolean {
  if (h.location !== "verifying" || effectiveVerdict(h) !== "supported") return false;
  return liveCore(h) ? coreEvidenceHolds(h) : allNeedsFound(h);
}
/**
 * Evidence gate (decision #59, B3): a hypothesis is supported only if its found evidence leans clearly toward it. Supports must outnumber
 * twice the contradicts and be at least as many as the uncertain ones; an uncertain answer never counts as support. Stances are program
 * data, so this is checked here and not only asked of the model.
 */
export function evidenceClearlySupports(h: Hypothesis): boolean {
  const retired = retiredNeedIds(h);
  const stances = foundNeeds(h)
    .filter(n => !retired.has(n.id))
    .map(n => n.stance ?? "uncertain");
  const count = (stance: NeedStance): number => stances.filter(s => s === stance).length;
  const supports = count("supports");
  return supports > 2 * count("contradicts") && supports >= count("uncertain") && supports > 0;
}
/** A hypothesis the round or research limit cut off: not refuted by evidence (its final verdict is not "refuted"), only unfinished. Old maps store it as an elimination with a `round_limit` reason. */
export const isLimitCut = (h: Hypothesis): boolean =>
  h.location === "eliminated" &&
  (h.eliminationReason ?? "").startsWith("round_limit") &&
  !(allNeedsFound(h) && effectiveVerdict(h) === "refuted");
export function verifiedHypotheses(state: ArgumentMapData): Hypothesis[] {
  return state.hypotheses.filter(isVerified);
}
export function verifiedCount(state: ArgumentMapData): number {
  return verifiedHypotheses(state).length;
}
/** What a hypothesis card shows: any unfound need means "verifying" (with a core: until the needs are settled and the core is found), whatever the stored verdicts say. */
export function displayVerdict(h: Hypothesis): Verdict | "verifying" {
  const core = liveCore(h);
  if (core)
    return core.state === "found" && h.needs.every(n => n.state === "found" || n.state === "not_found")
      ? effectiveVerdict(h)
      : "verifying";
  return allNeedsFound(h) ? effectiveVerdict(h) : "verifying";
}
export const HYPOTHESIS_STATUSES = ["verified", "unconfirmed", "eliminated"] as const;
export type HypothesisStatus = (typeof HYPOTHESIS_STATUSES)[number];
/** Where a hypothesis stands for the conclusion (decision #63): verified; refuted and eliminated; or evidence-in-hand but not confirmed (cut by a limit, or still short when the run ended). */
export const hypothesisStatus = (h: Hypothesis): HypothesisStatus =>
  isVerified(h) ? "verified" : h.location === "eliminated" && !isLimitCut(h) ? "eliminated" : "unconfirmed";
/** A conclusion written from fewer verified hypotheses than the target (decision #59). */
export const isPartialConclusion = (state: ArgumentMapData): boolean =>
  state.run.phase === "concluded" && state.conclusion.partial === true && verifiedCount(state) < MIN_VERIFIED;
/** The situation gate ended data_insufficient and the run went on (decision #58). */
export const isSituationUnconfirmed = (state: ArgumentMapData): boolean => state.situation.gate.state === "unconfirmed";
/** A facet map made before question types (0.34.0): facets, no questionType. A finished one reads as before; an unfinished one is never resumed (decision #66). */
export const isLegacyFacetMap = (state: ArgumentMapData): boolean =>
  state.situation.facets !== undefined && state.situation.questionType === undefined;
export const isFactMap = (state: ArgumentMapData): boolean => state.situation.questionType === "fact";
export const FACET_COMPOSITES = ["holds", "fails", "partial", "insufficient"] as const;
export type FacetComposite = (typeof FACET_COMPOSITES)[number];
/** What the facets say together (decision #60). Supports and no refutation holds; refutation and no support fails; both is partial; neither (all insufficient or still pending) is insufficient. `insufficientCount` is shown next to the result. */
export function composeFacets(facets: readonly { verdict: FacetVerdict }[]): {
  outcome: FacetComposite;
  insufficientCount: number;
} {
  const supports = facets.some(f => f.verdict === "supports");
  const refutes = facets.some(f => f.verdict === "refutes");
  const insufficientCount = facets.filter(f => f.verdict === "insufficient").length;
  const outcome = supports && refutes ? "partial" : supports ? "holds" : refutes ? "fails" : "insufficient";
  return { outcome, insufficientCount };
}
export type ConclusionView = "in_progress" | "concluded" | "stopped_limit" | "stopped_mismatch";
/** The four conclusion card states, derived from the run and the verified count. A concluded map falls back to in_progress when support is lost. */
export function conclusionView(state: ArgumentMapData): ConclusionView {
  const { phase } = state.run;
  if (phase === "stopped_mismatch") return "stopped_mismatch";
  if (phase === "stopped_limit") return "stopped_limit";
  if (isFactMap(state)) return phase === "concluded" ? "concluded" : "in_progress";
  if (
    phase === "concluded" &&
    (verifiedCount(state) >= MIN_VERIFIED || (state.conclusion.partial === true && verifiedCount(state) >= 1))
  )
    return "concluded";
  return "in_progress";
}
