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
export const MAX_RESEARCH_CALLS = 66;
export const MAX_SITUATION_DATA = 6;
export const MAX_SITUATION_ATTEMPTS = 2;
export const MIN_VERIFIED = 3;

export const ROLE_KEYS = ["proposition", "situation", "conclusion", "verified", "eliminated"] as const;
export type RoleKey = (typeof ROLE_KEYS)[number];
export type ArgumentRoles = Record<RoleKey, string>;

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
export const GATE_STATES = ["pending", "matched", "unmatched"] as const;
export type GateState = (typeof GATE_STATES)[number];
export const GATE_KINDS = ["not_matching", "data_missing"] as const;
export type GateKind = (typeof GATE_KINDS)[number];
export const VERDICTS = ["supported", "refuted", "undecided"] as const;
export type Verdict = (typeof VERDICTS)[number];
export const LOCATIONS = ["verifying", "eliminated"] as const;
export type Location = (typeof LOCATIONS)[number];
export const CONCLUSION_STATES = ["pending", "concluded", "stopped"] as const;
export type ConclusionState = (typeof CONCLUSION_STATES)[number];

export interface SourceProof {
  url: string;
  quote: string;
  claim: string;
  check: ProofCheck;
  checkedAt: string;
}
export interface SituationDatum {
  id: string;
  need: string;
  attempts: number;
  state: ItemState;
  stance?: DataStance;
  proof?: SourceProof;
  reason?: string;
}
export interface SituationGate {
  state: GateState;
  kind?: GateKind;
  reason?: string;
  citedData: string[];
}
export interface Need {
  id: string;
  text: string;
  addedRound: number;
  state: ItemState;
  stance?: NeedStance;
  proof?: SourceProof;
  reason?: string;
}
export interface Hypothesis {
  id: string;
  citedData: string[];
  round: number;
  location: Location;
  needs: Need[];
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
}
export interface ArgumentConclusion {
  state: ConclusionState;
  basedOn: string[];
  missing: string[];
}
export interface ArgumentMapData {
  v: 1;
  roles: ArgumentRoles;
  run: ArgumentRun;
  situation: { data: SituationDatum[]; gate: SituationGate };
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

/** Why the key cannot be used, or null when it is a well-formed version 1 value. Never mutates `raw`. */
function problem(raw: unknown, nodeIds: ReadonlySet<string>): string | null {
  if (!isRec(raw)) return "not an object";
  if (raw.v !== ARGUMENT_MAP_VERSION) return "unsupported version";
  if (!isRec(raw.roles)) return "roles missing";
  for (const key of ROLE_KEYS) {
    const id = raw.roles[key];
    if (!isStr(id)) return `role ${key} missing`;
    if (!nodeIds.has(id)) return `role ${key} points to a missing node`;
  }
  const run = raw.run;
  if (!isRec(run)) return "run missing";
  if (!isStr(run.runId) || !count(run.researchCalls)) return "run malformed";
  if (!oneOf(RUN_PHASES, run.phase) || !oneOf(RUN_STATUSES, run.status) || !optOneOf(STOP_REASONS, run.stopReason))
    return "unknown run enum";
  const situation = raw.situation;
  if (!isRec(situation) || !Array.isArray(situation.data) || !isRec(situation.gate)) return "situation malformed";
  const ids = new Set<string>();
  for (const datum of situation.data as unknown[]) {
    if (!isRec(datum) || !isStr(datum.id) || !isStr(datum.need) || !count(datum.attempts) || ids.has(datum.id))
      return "situation data malformed";
    ids.add(datum.id);
    if (!oneOf(ITEM_STATES, datum.state) || !optOneOf(DATA_STANCES, datum.stance)) return "unknown situation enum";
    if (badProof(datum.proof) || !optStr(datum.reason)) return "situation data malformed";
  }
  const gate = situation.gate;
  if (!oneOf(GATE_STATES, gate.state) || !optOneOf(GATE_KINDS, gate.kind)) return "unknown gate enum";
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
    for (const need of hypothesis.needs as unknown[]) {
      if (!isRec(need) || !isStr(need.id) || !isStr(need.text) || !count(need.addedRound) || ids.has(need.id))
        return "need malformed";
      ids.add(need.id);
      if (!oneOf(ITEM_STATES, need.state) || !optOneOf(NEED_STANCES, need.stance)) return "unknown need enum";
      if (badProof(need.proof) || !optStr(need.reason)) return "need malformed";
    }
  }
  const conclusion = raw.conclusion;
  if (!isRec(conclusion) || !oneOf(CONCLUSION_STATES, conclusion.state)) return "conclusion malformed";
  if (!strList(conclusion.basedOn) || !strList(conclusion.missing)) return "conclusion malformed";
  return null;
}

/** Reads `map.argumentMap`. A missing key is `absent`; anything that fails validation is `unusable` (and must be kept as saved). */
export function readArgumentMap(map: { nodes: readonly { id: string }[]; argumentMap?: unknown }): ArgumentMapRead {
  if (map.argumentMap === undefined) return { kind: "absent" };
  const found = problem(map.argumentMap, new Set(map.nodes.map(node => node.id)));
  if (found) return { kind: "unusable", reason: found, raw: map.argumentMap };
  return { kind: "usable", data: map.argumentMap as ArgumentMapData };
}

// ---- selectors ---------------------------------------------------------------------------------------------------------

/** The verdict shown and used: the user's value first, then the AI's, else undecided. */
export function effectiveVerdict(h: Hypothesis): Verdict {
  return h.userVerdict ?? h.aiVerdict ?? "undecided";
}
export function foundNeeds(h: Hypothesis): Need[] {
  return h.needs.filter(need => need.state === "found");
}
export function allNeedsFound(h: Hypothesis): boolean {
  return h.needs.length > 0 && h.needs.every(need => need.state === "found");
}
/** "Verified" is never stored: needs listed and all found, still in the verifying group, and the effective verdict is supported. */
export function isVerified(h: Hypothesis): boolean {
  return allNeedsFound(h) && h.location === "verifying" && effectiveVerdict(h) === "supported";
}
export function verifiedHypotheses(state: ArgumentMapData): Hypothesis[] {
  return state.hypotheses.filter(isVerified);
}
export function verifiedCount(state: ArgumentMapData): number {
  return verifiedHypotheses(state).length;
}
/** What a hypothesis card shows: any unfound need means "verifying", whatever the stored verdicts say. */
export function displayVerdict(h: Hypothesis): Verdict | "verifying" {
  return allNeedsFound(h) ? effectiveVerdict(h) : "verifying";
}
export type ConclusionView = "in_progress" | "concluded" | "stopped_limit" | "stopped_mismatch";
/** The four conclusion card states, derived from the run and the verified count. A concluded map falls back to in_progress when support is lost. */
export function conclusionView(state: ArgumentMapData): ConclusionView {
  const { phase } = state.run;
  if (phase === "stopped_mismatch") return "stopped_mismatch";
  if (phase === "stopped_limit") return "stopped_limit";
  if (phase === "concluded" && verifiedCount(state) >= MIN_VERIFIED) return "concluded";
  return "in_progress";
}
