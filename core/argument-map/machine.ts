/**
 * Argument map state machine. Pure: `nextActions(state)` says what may happen next, and the `apply*`/`begin*` reducers are the
 * only functions that change a state. A reducer that would break a gate throws `GateError` and returns nothing, so the input
 * state is never half written; a successful call returns a new state and leaves the input alone. The AI only fills content
 * (texts, stances, verdicts, citations); every gate below is decided here. Spec: docs/history/tasks/2026-11-09-argument-map-layout.
 */
import {
  MAX_HYPOTHESES,
  MAX_NEEDS,
  MAX_RESEARCH_CALLS,
  MAX_ROUND,
  MAX_ROUND_NEEDS,
  MAX_SITUATION_ATTEMPTS,
  MAX_SITUATION_DATA,
  MIN_VERIFIED,
  DATA_STANCES,
  NEED_STANCES,
  PROOF_CHECKS,
  VERDICTS,
  allNeedsFound,
  effectiveVerdict,
  foundNeeds,
  isVerified,
  verifiedHypotheses,
  type ArgumentMapData,
  type ArgumentRoles,
  type Hypothesis,
  type Need,
  type SourceProof,
  type StopReason,
  type Verdict
} from "./model";

export class GateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GateError";
  }
}

export type ArgumentAction =
  | { type: "plan_situation" }
  | { type: "research_situation"; dataId: string }
  | { type: "gate_missing" }
  | { type: "judge_gate" }
  | { type: "propose_hypotheses"; count: number }
  | { type: "add_needs"; hypothesisId: string }
  | { type: "research_need"; hypothesisId: string; needId: string }
  | { type: "verdict"; hypothesisId: string }
  | { type: "revise"; hypothesisId: string }
  | { type: "eliminate_limit"; hypothesisId: string }
  | { type: "conclude" }
  | { type: "stop_limit" };

/** What a research answer must be: a source the caller verified, or a miss with a reason. `proof` is re-checked for shape here. */
export type EvidenceResult = { found: true; stance: string; proof: SourceProof } | { found: false; reason: string };

export interface EvidenceInput {
  id: string;
  claim: string;
  quote: string;
  url: string;
  stance: string;
}
export interface VerdictInput {
  hypothesisId: string;
  round: number;
  evidence: EvidenceInput[];
}
export interface ConclusionInput {
  hypotheses: { id: string; round: number; evidence: EvidenceInput[] }[];
}

const TERMINAL = ["concluded", "stopped_mismatch", "stopped_limit"];
const clone = (state: ArgumentMapData): ArgumentMapData => JSON.parse(JSON.stringify(state)) as ArgumentMapData;
const blank = (value: unknown): boolean => typeof value !== "string" || value.trim() === "";
const isTerminal = (state: ArgumentMapData): boolean => TERMINAL.includes(state.run.phase);

function live(state: ArgumentMapData): void {
  if (isTerminal(state)) throw new GateError(`run is finished (${state.run.phase})`);
}
function running(state: ArgumentMapData): void {
  live(state);
  if (state.run.status !== "running") throw new GateError("run is not running");
}
function inSituation(state: ArgumentMapData): void {
  live(state);
  if (state.run.phase !== "situation" || state.situation.gate.state !== "pending")
    throw new GateError("situation phase is over");
}
function inAnalysis(state: ArgumentMapData): void {
  live(state);
  if (state.run.phase !== "analysis" || state.situation.gate.state !== "matched")
    throw new GateError("the situation gate has not matched");
}
function hypothesisOf(state: ArgumentMapData, id: string): Hypothesis {
  const found = state.hypotheses.find(h => h.id === id);
  if (!found) throw new GateError(`unknown hypothesis ${id}`);
  if (found.location !== "verifying") throw new GateError(`hypothesis ${id} is eliminated`);
  return found;
}
function allIds(state: ArgumentMapData): Set<string> {
  const ids = new Set<string>(Object.values(state.roles));
  for (const datum of state.situation.data) ids.add(datum.id);
  for (const h of state.hypotheses) {
    ids.add(h.id);
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
    throw new GateError("evidence needs a verified source");
  if (!(PROOF_CHECKS as readonly string[]).includes(p.check as string)) throw new GateError("unknown source check");
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
    check: p.check as SourceProof["check"],
    checkedAt: p.checkedAt as string
  };
}
function stanceOf<T extends string>(list: readonly T[], value: unknown): T {
  if (!(list as readonly string[]).includes(value as string)) throw new GateError("unknown stance");
  return value as T;
}
const settled = (h: Hypothesis): boolean => h.needs.every(n => n.state === "found" || n.state === "not_found");
const hasSearching = (state: ArgumentMapData): boolean =>
  state.situation.data.some(d => d.state === "searching") ||
  state.hypotheses.some(h => h.needs.some(n => n.state === "searching"));
const canRevise = (h: Hypothesis): boolean => h.round < MAX_ROUND && h.needs.length < MAX_NEEDS;
const verifyingCount = (state: ArgumentMapData): number =>
  state.hypotheses.filter(h => h.location === "verifying").length;

// ---- creation ------------------------------------------------------------------------------------------------------------------
export function newArgumentMap(roles: ArgumentRoles, runId: string): ArgumentMapData {
  return {
    v: 1,
    roles: { ...roles },
    run: { runId, phase: "situation", status: "running", researchCalls: 0 },
    situation: { data: [], gate: { state: "pending", citedData: [] } },
    hypotheses: [],
    conclusion: { state: "pending", basedOn: [], missing: [] }
  };
}

// ---- next actions --------------------------------------------------------------------------------------------------------------
function limitStop(state: ArgumentMapData, actions: ArgumentAction[]): boolean {
  if (state.run.phase !== "analysis" || verifiedHypotheses(state).length >= MIN_VERIFIED) return false;
  if (state.hypotheses.length >= MAX_HYPOTHESES && verifyingCount(state) < MIN_VERIFIED) return true;
  return actions.length === 0 && !hasSearching(state);
}

function analysisActions(state: ArgumentMapData): ArgumentAction[] {
  if (verifiedHypotheses(state).length >= MIN_VERIFIED) return [{ type: "conclude" }];
  const actions: ArgumentAction[] = [];
  let budget = MAX_RESEARCH_CALLS - state.run.researchCalls;
  const want = Math.min(MIN_VERIFIED - verifyingCount(state), MAX_HYPOTHESES - state.hypotheses.length);
  if (want > 0) actions.push({ type: "propose_hypotheses", count: want });
  for (const h of state.hypotheses) {
    if (h.location !== "verifying") continue;
    if (h.needs.length === 0) {
      actions.push({ type: "add_needs", hypothesisId: h.id });
      continue;
    }
    for (const need of h.needs)
      if (need.state === "pending" && budget > 0) {
        actions.push({ type: "research_need", hypothesisId: h.id, needId: need.id });
        budget -= 1;
      }
    if (!settled(h)) continue;
    if (allNeedsFound(h)) {
      if (h.aiVerdict === undefined) actions.push({ type: "verdict", hypothesisId: h.id });
      else if (effectiveVerdict(h) !== "supported")
        actions.push({ type: canRevise(h) ? "revise" : "eliminate_limit", hypothesisId: h.id });
    } else actions.push({ type: canRevise(h) ? "revise" : "eliminate_limit", hypothesisId: h.id });
  }
  return actions;
}

function situationActions(state: ArgumentMapData): ArgumentAction[] {
  const { data } = state.situation;
  if (data.length === 0) return [{ type: "plan_situation" }];
  const actions: ArgumentAction[] = [];
  let budget = MAX_RESEARCH_CALLS - state.run.researchCalls;
  for (const datum of data)
    if (datum.state === "pending" && datum.attempts < MAX_SITUATION_ATTEMPTS && budget > 0) {
      actions.push({ type: "research_situation", dataId: datum.id });
      budget -= 1;
    }
  if (actions.length || data.some(d => d.state === "pending" || d.state === "searching")) return actions;
  return [{ type: data.some(d => d.state === "not_found") ? "gate_missing" : "judge_gate" }];
}

/** Everything the runner may do next. Paused, finished and unmatched runs have none. */
export function nextActions(state: ArgumentMapData): ArgumentAction[] {
  if (isTerminal(state) || state.run.status !== "running") return [];
  if (state.run.phase === "situation") return situationActions(state);
  const actions = analysisActions(state);
  return limitStop(state, actions) ? [{ type: "stop_limit" }] : actions;
}

// ---- situation ----------------------------------------------------------------------------------------------------------------
export function applySituationData(state: ArgumentMapData, items: { id: string; need: string }[]): ArgumentMapData {
  inSituation(state);
  if (!items.length) throw new GateError("no situation data");
  if (state.situation.data.length + items.length > MAX_SITUATION_DATA) throw new GateError("too many situation data");
  const next = clone(state);
  const ids = allIds(next);
  for (const item of items) {
    if (blank(item.need)) throw new GateError("empty situation need");
    next.situation.data.push({ id: newId(ids, item.id), need: item.need, attempts: 0, state: "pending" });
  }
  return next;
}

export function beginSituationResearch(state: ArgumentMapData, dataId: string): ArgumentMapData {
  inSituation(state);
  running(state);
  const next = clone(state);
  const datum = next.situation.data.find(d => d.id === dataId);
  if (!datum || datum.state !== "pending") throw new GateError("situation datum is not waiting for research");
  if (datum.attempts >= MAX_SITUATION_ATTEMPTS) throw new GateError("situation datum is out of attempts");
  if (next.run.researchCalls >= MAX_RESEARCH_CALLS) throw new GateError("research call limit reached");
  datum.attempts += 1;
  datum.state = "searching";
  next.run.researchCalls += 1;
  return next;
}

export function applySituationEvidence(
  state: ArgumentMapData,
  dataId: string,
  result: EvidenceResult
): ArgumentMapData {
  inSituation(state);
  const next = clone(state);
  const datum = next.situation.data.find(d => d.id === dataId);
  if (!datum || datum.state !== "searching") throw new GateError("situation datum is not being researched");
  if (result.found === true) {
    datum.stance = stanceOf(DATA_STANCES, result.stance);
    datum.proof = checkedProof(result.proof);
    datum.state = "found";
    return next;
  }
  if (blank(result.reason)) throw new GateError("a miss needs a reason");
  datum.reason = result.reason;
  datum.state = datum.attempts >= MAX_SITUATION_ATTEMPTS ? "not_found" : "pending";
  return next;
}

/** Unfound data end the run without asking the AI. */
export function applyGateMissing(state: ArgumentMapData): ArgumentMapData {
  inSituation(state);
  const { data } = state.situation;
  if (!data.length || data.some(d => d.state === "pending" || d.state === "searching"))
    throw new GateError("situation data are not settled");
  const missing = data.filter(d => d.state === "not_found");
  if (!missing.length) throw new GateError("no situation data are missing");
  const next = clone(state);
  next.situation.gate = {
    state: "unmatched",
    kind: "data_missing",
    reason: missing.map(d => `${d.need}: ${d.reason ?? ""}`).join("; "),
    citedData: []
  };
  return stopMismatch(next, "data_missing");
}

function stopMismatch(next: ArgumentMapData, reason: StopReason): ArgumentMapData {
  next.run.phase = "stopped_mismatch";
  next.run.status = "finished";
  next.run.stopReason = reason;
  next.conclusion = { state: "stopped", basedOn: [], missing: [] };
  return next;
}

export function applySituationGate(
  state: ArgumentMapData,
  verdict: { matches: unknown; reason: string; citedData: string[] }
): ArgumentMapData {
  inSituation(state);
  const { data } = state.situation;
  if (!data.length || data.some(d => d.state !== "found" || !d.proof))
    throw new GateError("every situation datum must be found with a source first");
  if (typeof verdict.matches !== "boolean") throw new GateError("matches must be a boolean");
  if (blank(verdict.reason)) throw new GateError("the gate needs a reason");
  const cited = Array.isArray(verdict.citedData) ? verdict.citedData : [];
  const known = new Set(data.map(d => d.id));
  if (cited.some(id => !known.has(id))) throw new GateError("the gate cites data outside the situation");
  if (verdict.matches && cited.length === 0) throw new GateError("a matching gate must cite situation data");
  const next = clone(state);
  if (verdict.matches) {
    next.situation.gate = { state: "matched", reason: verdict.reason, citedData: [...cited] };
    next.run.phase = "analysis";
    return next;
  }
  next.situation.gate = { state: "unmatched", kind: "not_matching", reason: verdict.reason, citedData: [...cited] };
  return stopMismatch(next, "mismatch");
}

// ---- hypotheses and needs ----------------------------------------------------------------------------------------------------
export function applyHypotheses(state: ArgumentMapData, items: { id: string; citedData: string[] }[]): ArgumentMapData {
  inAnalysis(state);
  if (!items.length) throw new GateError("no hypotheses");
  if (state.hypotheses.length + items.length > MAX_HYPOTHESES) throw new GateError("hypothesis limit reached");
  const next = clone(state);
  const ids = allIds(next);
  const foundData = new Set(next.situation.data.filter(d => d.state === "found").map(d => d.id));
  for (const item of items) {
    const cited = Array.isArray(item.citedData) ? item.citedData : [];
    if (!cited.length || cited.some(id => !foundData.has(id)))
      throw new GateError("a hypothesis must cite found situation data");
    next.hypotheses.push({
      id: newId(ids, item.id),
      citedData: [...cited],
      round: 1,
      location: "verifying",
      needs: []
    });
  }
  return next;
}

function pushNeeds(next: ArgumentMapData, h: Hypothesis, items: { id: string; text: string }[]): void {
  if (!items.length) throw new GateError("no needs");
  const inRound = h.needs.filter(n => n.addedRound === h.round).length;
  if (inRound + items.length > MAX_ROUND_NEEDS) throw new GateError("too many needs in this round");
  if (h.needs.length + items.length > MAX_NEEDS) throw new GateError("too many needs for this hypothesis");
  const ids = allIds(next);
  for (const item of items) {
    if (blank(item.text)) throw new GateError("empty need");
    h.needs.push({ id: newId(ids, item.id), text: item.text, addedRound: h.round, state: "pending" });
  }
  delete h.aiVerdict;
}

/** The only way to list needs. Add-only: there is no reducer that removes or rewrites one. */
export function addNeeds(
  state: ArgumentMapData,
  hypothesisId: string,
  items: { id: string; text: string }[]
): ArgumentMapData {
  inAnalysis(state);
  const next = clone(state);
  pushNeeds(next, hypothesisOf(next, hypothesisId), items);
  return next;
}

export function startNextRound(
  state: ArgumentMapData,
  hypothesisId: string,
  items: { id: string; text: string }[]
): ArgumentMapData {
  inAnalysis(state);
  const next = clone(state);
  const h = hypothesisOf(next, hypothesisId);
  if (!h.needs.length || !settled(h)) throw new GateError("the round is not finished");
  if (isVerified(h)) throw new GateError("the hypothesis is already verified");
  if (h.round >= MAX_ROUND) throw new GateError("round limit reached");
  h.round += 1;
  pushNeeds(next, h, items);
  return next;
}

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
    need.stance = stanceOf(NEED_STANCES, result.stance);
    need.proof = checkedProof(result.proof);
    need.state = "found";
    return next;
  }
  if (blank(result.reason)) throw new GateError("a miss needs a reason");
  need.reason = result.reason;
  need.state = "not_found";
  return next;
}

// ---- verdicts -------------------------------------------------------------------------------------------------------------------
const evidenceOf = (needs: Need[]): EvidenceInput[] =>
  needs.map(n => ({
    id: n.id,
    claim: n.proof?.claim ?? "",
    quote: n.proof?.quote ?? "",
    url: n.proof?.url ?? "",
    stance: n.stance ?? ""
  }));

/** The whole input of a verdict step: that hypothesis' found needs and nothing else. Refused until every need is found. */
export function prepareVerdict(state: ArgumentMapData, hypothesisId: string): VerdictInput {
  inAnalysis(state);
  const h = hypothesisOf(state, hypothesisId);
  if (!allNeedsFound(h)) throw new GateError("not every evidence need is found");
  return { hypothesisId: h.id, round: h.round, evidence: evidenceOf(foundNeeds(h)) };
}

export function applyVerdict(
  state: ArgumentMapData,
  hypothesisId: string,
  verdict: { verdict: unknown; citedNeeds: string[]; reason: string }
): ArgumentMapData {
  prepareVerdict(state, hypothesisId);
  const next = clone(state);
  const h = hypothesisOf(next, hypothesisId);
  if (h.aiVerdict !== undefined) throw new GateError("the hypothesis already has a verdict");
  if (!(VERDICTS as readonly string[]).includes(verdict.verdict as string)) throw new GateError("unknown verdict");
  if (blank(verdict.reason)) throw new GateError("a verdict needs a reason");
  const inside = new Set(foundNeeds(h).map(n => n.id));
  const cited = Array.isArray(verdict.citedNeeds) ? verdict.citedNeeds : [];
  if (!cited.length || cited.some(id => !inside.has(id)))
    throw new GateError("a verdict must cite evidence of this hypothesis");
  h.aiVerdict = verdict.verdict as Verdict;
  return next;
}

/** AI-decided elimination of a refuted hypothesis. The elimination reason and the searched needs stay on the hypothesis. */
export function eliminate(state: ArgumentMapData, hypothesisId: string, reason: string): ArgumentMapData {
  inAnalysis(state);
  const next = clone(state);
  const h = hypothesisOf(next, hypothesisId);
  if (!allNeedsFound(h) || effectiveVerdict(h) !== "refuted")
    throw new GateError("only a refuted hypothesis can be eliminated early");
  if (blank(reason)) throw new GateError("an elimination needs a reason");
  h.location = "eliminated";
  h.eliminationReason = reason;
  return next;
}

/** Program elimination: no round or need left to add and the hypothesis is still not verified. */
export function eliminateAtLimit(state: ArgumentMapData, hypothesisId: string): ArgumentMapData {
  inAnalysis(state);
  const next = clone(state);
  const h = hypothesisOf(next, hypothesisId);
  if (!h.needs.length || !settled(h) || canRevise(h) || isVerified(h))
    throw new GateError("the hypothesis is not at its limit");
  if (allNeedsFound(h) && h.aiVerdict === undefined) throw new GateError("the verdict is still due");
  h.location = "eliminated";
  h.eliminationReason = `round_limit: not verified after round ${h.round}`;
  return next;
}

// ---- conclusion -----------------------------------------------------------------------------------------------------------------
/** The whole input of the conclusion step: verified hypotheses and their evidence. Refused below 3. */
export function prepareConclusion(state: ArgumentMapData): ConclusionInput {
  inAnalysis(state);
  const verified = verifiedHypotheses(state);
  if (verified.length < MIN_VERIFIED) throw new GateError("fewer than 3 verified hypotheses");
  return { hypotheses: verified.map(h => ({ id: h.id, round: h.round, evidence: evidenceOf(foundNeeds(h)) })) };
}

export function applyConclusion(state: ArgumentMapData, conclusion: { basedOn: string[] }): ArgumentMapData {
  prepareConclusion(state);
  const verified = new Set(verifiedHypotheses(state).map(h => h.id));
  const basedOn = Array.isArray(conclusion.basedOn) ? conclusion.basedOn : [];
  if (!basedOn.length || basedOn.some(id => !verified.has(id)))
    throw new GateError("the conclusion may rest on verified hypotheses only");
  const next = clone(state);
  next.run.phase = "concluded";
  next.run.status = "finished";
  delete next.run.stopReason;
  next.conclusion = { state: "concluded", basedOn: [...new Set(basedOn)], missing: [] };
  return next;
}

export function applyLimitStop(state: ArgumentMapData): ArgumentMapData {
  live(state);
  if (state.run.status !== "running" || !limitStop(state, analysisActionsSafe(state)))
    throw new GateError("the run is not at a limit");
  const next = clone(state);
  const missing = [`verified ${verifiedHypotheses(state).length}/${MIN_VERIFIED}`];
  for (const h of next.hypotheses)
    missing.push(
      `${h.id}: ${h.location === "eliminated" ? "eliminated" : isVerified(h) ? "verified" : "not verified"}`
    );
  next.run.phase = "stopped_limit";
  next.run.status = "finished";
  next.run.stopReason = "limit";
  next.conclusion = { state: "stopped", basedOn: [], missing };
  return next;
}
const analysisActionsSafe = (state: ArgumentMapData): ArgumentAction[] =>
  state.run.phase === "analysis" ? analysisActions(state) : [];

// ---- pause and resume -------------------------------------------------------------------------------------------------------------
export function applyPause(
  state: ArgumentMapData,
  reason: Extract<StopReason, "user" | "interrupted" | "error">
): ArgumentMapData {
  live(state);
  if (!["user", "interrupted", "error"].includes(reason)) throw new GateError("unknown pause reason");
  const next = clone(state);
  for (const datum of next.situation.data) if (datum.state === "searching") datum.state = "pending";
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
