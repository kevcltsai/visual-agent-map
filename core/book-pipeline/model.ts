/**
 * Picture-book pipeline data contract. Pure: no vault, no UI. Two stores:
 *  - a card's frontmatter (`pipeline-stage`, `book-role`, `pipeline-issue`, `pipeline-seam`) and the root topic's six `book-*`
 *    settings, read here from a parsed frontmatter object and written by Repository through `setFrontmatterKeys`;
 *  - the map file's top-level `bookPipeline` (`readBookPipeline`). parseMap and serializeMap carry it through untouched, so a
 *    version this code cannot read is saved back exactly as it was; the flow refuses it.
 * A note or map without any of these keys reads and writes exactly as before.
 */

export const PIPELINE_STAGES = ["planned", "written", "checked", "needs-review"] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];
export const BOOK_ROLES = ["intro", "body", "gallery", "closing"] as const;
export type BookRole = (typeof BOOK_ROLES)[number];
export const PIPELINE_ISSUE_MAX = 200;
export const PIPELINE_PHASES = ["planning", "gate1", "writing", "gate2", "done"] as const;
export type PipelinePhase = (typeof PIPELINE_PHASES)[number];
export const PIPELINE_STATUSES = ["running", "stopped"] as const;
export type PipelineStatus = (typeof PIPELINE_STATUSES)[number];
export const DEFAULT_BUDGET_LIMIT = 300;
export const MAX_STEP_ATTEMPTS = 3;
/** The automatic redo one card may get (the program's own retry of the author step after a proofread named unmet points). */
export const MAX_AUTO_FIXES = 1;
/** How many cards (the first in reading order) the trial run before gate 1 covers. */
export const TRIAL_SIZE = 3;
export const STEPS = ["plan", "write", "proof"] as const;
export type PipelineStep = (typeof STEPS)[number];

export function readPipelineStage(value: unknown): PipelineStage | undefined {
  return PIPELINE_STAGES.find(stage => stage === value);
}
export function readBookRole(value: unknown): BookRole | undefined {
  return BOOK_ROLES.find(role => role === value);
}
/** One line of plain text, at most {@link PIPELINE_ISSUE_MAX} characters; empty or non-string reads as absent. */
export function plainPipelineLine(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const line = value.replace(/\s+/g, " ").trim();
  if (!line) return undefined;
  return Array.from(line).slice(0, PIPELINE_ISSUE_MAX).join("");
}

export interface PipelineFields {
  pipelineStage?: PipelineStage;
  bookRole?: BookRole;
  /** The role the pipeline itself wrote; a `book-role` that differs from it was changed by hand. Absent = older data. */
  pipelineRole?: BookRole;
  /** Frontmatter `book-role-by`: who decided `book-role` (`owner` is kept across runs; `ai` the plan may change). Absent = unrecorded. */
  bookRoleBy?: BookRoleBy;
  pipelineIssue?: string;
  pipelineSeam?: string;
}
export type BookRoleBy = "owner" | "ai";
export function readBookRoleBy(value: unknown): BookRoleBy | undefined {
  return value === "owner" || value === "ai" ? value : undefined;
}
/** Only the keys the note has: a note without any of them gets `{}`. */
export function readPipelineFields(fm: Record<string, unknown>): PipelineFields {
  const stage = readPipelineStage(fm["pipeline-stage"]);
  const role = readBookRole(fm["book-role"]);
  const pipelineRole = readBookRole(fm["pipeline-role"]);
  const roleBy = readBookRoleBy(fm["book-role-by"]);
  const issue = plainPipelineLine(fm["pipeline-issue"]);
  const seam = plainPipelineLine(fm["pipeline-seam"]);
  return {
    ...(stage ? { pipelineStage: stage } : {}),
    ...(role ? { bookRole: role } : {}),
    ...(pipelineRole ? { pipelineRole } : {}),
    ...(roleBy ? { bookRoleBy: roleBy } : {}),
    ...(issue ? { pipelineIssue: issue } : {}),
    ...(seam ? { pipelineSeam: seam } : {})
  };
}
/** `undefined` leaves a key alone; `null` removes it. */
export interface PipelineFieldsPatch {
  pipelineStage?: PipelineStage | null;
  bookRole?: BookRole | null;
  pipelineRole?: BookRole | null;
  bookRoleBy?: BookRoleBy | null;
  pipelineIssue?: string | null;
  pipelineSeam?: string | null;
}
const FIELD_KEYS = {
  pipelineStage: "pipeline-stage",
  bookRole: "book-role",
  pipelineRole: "pipeline-role",
  bookRoleBy: "book-role-by",
  pipelineIssue: "pipeline-issue",
  pipelineSeam: "pipeline-seam"
} as const;
/** The `setFrontmatterKeys` values for a patch; an invalid value removes the key (nothing unreadable is written). */
export function pipelineFrontmatter(patch: PipelineFieldsPatch): Record<string, string | null> {
  const values: Record<string, string | null> = {};
  for (const field of Object.keys(FIELD_KEYS) as (keyof typeof FIELD_KEYS)[]) {
    const value = patch[field];
    if (value === undefined) continue;
    const clean =
      value === null
        ? null
        : field === "pipelineStage"
          ? (readPipelineStage(value) ?? null)
          : field === "bookRole" || field === "pipelineRole"
            ? (readBookRole(value) ?? null)
            : field === "bookRoleBy"
              ? (readBookRoleBy(value) ?? null)
              : (plainPipelineLine(value) ?? null);
    values[FIELD_KEYS[field]] = clean;
  }
  return values;
}

/** The root topic's six whole-book settings, all optional. */
export const BOOK_SETTING_FIELDS = ["reader", "goal", "angle", "tone", "length", "style"] as const;
export type BookSettingField = (typeof BOOK_SETTING_FIELDS)[number];
export type BookSettings = Partial<Record<BookSettingField, string>>;
export type BookSettingsPatch = Partial<Record<BookSettingField, string | null>>;
export function readBookSettings(fm: Record<string, unknown>): BookSettings {
  const settings: BookSettings = {};
  for (const field of BOOK_SETTING_FIELDS) {
    const value = fm[`book-${field}`];
    if (typeof value === "string" && value.trim()) settings[field] = value.replace(/\s+/g, " ").trim();
    else if (typeof value === "number" && Number.isFinite(value)) settings[field] = String(value);
  }
  return settings;
}
export function bookSettingsFrontmatter(patch: BookSettingsPatch): Record<string, string | null> {
  const values: Record<string, string | null> = {};
  for (const field of BOOK_SETTING_FIELDS) {
    const value = patch[field];
    if (value === undefined) continue;
    const line = value === null ? null : value.replace(/\s+/g, " ").trim() || null;
    values[`book-${field}`] = line;
  }
  return values;
}

export interface StepAttempts {
  plan: number;
  write: number;
  proof: number;
}
export interface PipelineBudget {
  used: number;
  limit: number;
}
/** Map.md `bookPipeline`. `attempts.global` is the whole-book plan's count; every other key is a node id. */
export interface BookPipelineData {
  v: 1;
  runId: string;
  phase: PipelinePhase;
  status: PipelineStatus;
  /** Why a stopped run stopped when it was not the owner: the call budget ran out (not a failure of any card). */
  pauseReason?: "budget" | "failed" | "map";
  /** With pauseReason "map": what differed when the run paused (card ids; the bar shows counts, never ids). */
  changed?: { added: string[]; missing: string[] };
  /** With pauseReason "failed": a neutral code (letters, digits, `_.:-`) of what stopped the run. Never owner text. */
  failureCode?: string;
  order: string[];
  globalPlanned: boolean;
  attempts: Record<"global", number> & Record<string, StepAttempts | number>;
  /** Per card, raised by every successful plan or write; a result carries the one it started under. */
  revisions: Record<string, number>;
  /** Cards whose stage is stale from an earlier run and must be cleared before anything else (idempotent). */
  pendingReset?: string[];
  /** Cards whose `book-role` the pipeline itself wrote (its default or the global plan's choice), never the owner's; the plan may overwrite these. Absent = none (older data). */
  autoRoles?: string[];
  /** Per card, how many automatic redos it has used (at most {@link MAX_AUTO_FIXES}). Absent = none (older data); an owner stop or reopen never resets it. */
  autoFixes?: Record<string, number>;
  /** The trial cards (the first in reading order): only they run before gate 1, which shows their finished result. Absent = an older run: every card is planned before gate 1 as before. */
  trial?: string[];
  /** The map's card set (ids) the run accepted: the cards of the map when it started, or when the owner chose "carry on as before". Absent = older data: `order`. */
  accepted?: string[];
  /** New cards (not in `order`) the owner chose to leave out with "carry on as before". Absent = none. */
  ignored?: string[];
  /** Cards of `order` that are no longer on the map: a terminal state (never retried, no budget, left out of every count and neighbour). Absent = none. */
  removed?: string[];
  /** The chapters at start or replan: card id -> its title and note path then. Lets a later run name and clean a card that is already gone from the map. Absent = older data (nothing known). */
  chapters?: Record<string, { title: string; path: string }>;
  budget: PipelineBudget;
  /** The whole-book consistency check of the writing phase (one call). Absent: not asked yet (or older data). */
  consistency?: BookConsistency;
  /** Raised by every owner stop; a step result carries the one it started under (absent = 0). */
  stopEpoch?: number;
  /** Raised on every committed transition of the whole state. */
  revision: number;
  startedAt: string;
  phaseStartedAt: string;
}

/**
 * Two chapters (card ids) that state the same fact differently: what each says (model text, one line) and a suggested fix. With
 * `kind: "reference"` (found without a model): chapter `a` names chapter `b` by a wrong number or "next/previous"; `claimA` is the
 * sentence, `claimB` the words used, `suggestion` the right ones. It concerns `a` only.
 */
export interface ConsistencyFinding {
  /** Absent: two chapters disagree (the model's finding). `removed`: chapter `a` still names the removed chapter `b` (title in `claimB`, found by the program). */
  kind?: "reference" | "removed";
  a: string;
  b: string;
  claimA: string;
  claimB: string;
  suggestion: string;
}
export interface BookConsistency {
  /** The chapters and revisions it was asked for (`consistencyKey`). */
  key: string;
  /** Calls started for `key` (counted before the call, given back on a stop or budget pause). */
  attempts: number;
  /** The check for `key` finished (with or without findings); a failed check that used every attempt is never `done`. */
  done?: boolean;
  /** Each chapter's revision when the finished check read it: a finding counts for a chapter only while its revision is the same. */
  revisions?: Record<string, number>;
  findings?: ConsistencyFinding[];
}

export type BookPipelineRead =
  { kind: "absent" } | { kind: "usable"; data: BookPipelineData } | { kind: "unusable"; reason: string; raw: unknown };

/** A neutral failure code: short, no spaces, no owner text. */
export const FAILURE_CODE = /^[A-Za-z0-9_.:-]{1,60}$/;
const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;

const isText = (value: unknown): value is string => typeof value === "string";
function consistencyShape(value: unknown): boolean {
  if (!isObject(value) || !isText(value.key) || !isCount(value.attempts)) return false;
  if (value.done !== undefined && typeof value.done !== "boolean") return false;
  if (value.revisions !== undefined && (!isObject(value.revisions) || !Object.values(value.revisions).every(isCount)))
    return false;
  return (
    value.findings === undefined ||
    (Array.isArray(value.findings) &&
      value.findings.every(
        item =>
          isObject(item) &&
          (item.kind === undefined || item.kind === "reference" || item.kind === "removed") &&
          isText(item.a) &&
          isText(item.b) &&
          isText(item.claimA) &&
          isText(item.claimB) &&
          isText(item.suggestion)
      ))
  );
}

function problem(raw: unknown): string | undefined {
  if (!isObject(raw)) return "not an object";
  if (raw.v !== 1) return "unsupported version";
  if (typeof raw.runId !== "string" || !raw.runId) return "runId";
  if (!PIPELINE_PHASES.includes(raw.phase as PipelinePhase)) return "phase";
  if (!PIPELINE_STATUSES.includes(raw.status as PipelineStatus)) return "status";
  if (
    raw.pauseReason !== undefined &&
    raw.pauseReason !== "budget" &&
    raw.pauseReason !== "failed" &&
    raw.pauseReason !== "map"
  )
    return "pauseReason";
  for (const key of ["accepted", "ignored", "removed"] as const) {
    const list = raw[key];
    if (list !== undefined && (!Array.isArray(list) || list.some(id => typeof id !== "string" || !id))) return key;
  }
  if (
    raw.chapters !== undefined &&
    (!isObject(raw.chapters) ||
      Object.values(raw.chapters).some(
        entry => !isObject(entry) || typeof entry.title !== "string" || typeof entry.path !== "string"
      ))
  )
    return "chapters";
  if (raw.changed !== undefined) {
    const changed = raw.changed;
    if (
      !isObject(changed) ||
      !Array.isArray(changed.added) ||
      !Array.isArray(changed.missing) ||
      (changed.added as unknown[]).concat(changed.missing as unknown[]).some(id => typeof id !== "string")
    )
      return "changed";
  }
  if (raw.failureCode !== undefined && (typeof raw.failureCode !== "string" || !FAILURE_CODE.test(raw.failureCode)))
    return "failureCode";
  if (!Array.isArray(raw.order) || raw.order.some(id => typeof id !== "string" || !id)) return "order";
  if (new Set(raw.order).size !== raw.order.length) return "order has duplicates";
  if (typeof raw.globalPlanned !== "boolean") return "globalPlanned";
  if (!isObject(raw.attempts) || !isCount(raw.attempts.global)) return "attempts";
  for (const [key, value] of Object.entries(raw.attempts)) {
    if (key === "global") continue;
    if (!isObject(value) || STEPS.some(step => !isCount(value[step]))) return "attempts entry";
  }
  if (!isObject(raw.revisions) || Object.values(raw.revisions).some(value => !isCount(value))) return "revisions";
  if (
    raw.pendingReset !== undefined &&
    (!Array.isArray(raw.pendingReset) || raw.pendingReset.some(id => typeof id !== "string"))
  )
    return "pendingReset";
  if (
    raw.autoRoles !== undefined &&
    (!Array.isArray(raw.autoRoles) || raw.autoRoles.some(id => typeof id !== "string"))
  )
    return "autoRoles";
  if (
    raw.autoFixes !== undefined &&
    (!isObject(raw.autoFixes) || Object.values(raw.autoFixes).some(value => !isCount(value)))
  )
    return "autoFixes";
  if (
    raw.trial !== undefined &&
    (!Array.isArray(raw.trial) || raw.trial.some(id => typeof id !== "string" || !(raw.order as string[]).includes(id)))
  )
    return "trial";
  if (!isObject(raw.budget) || !isCount(raw.budget.used) || !isCount(raw.budget.limit) || raw.budget.limit < 1)
    return "budget";
  if (raw.consistency !== undefined && !consistencyShape(raw.consistency)) return "consistency";
  if (raw.stopEpoch !== undefined && !isCount(raw.stopEpoch)) return "stopEpoch";
  if (!isCount(raw.revision)) return "revision";
  if (typeof raw.startedAt !== "string" || typeof raw.phaseStartedAt !== "string") return "timestamps";
  return undefined;
}

/** Reads `map.bookPipeline`. A missing key is `absent`; anything that fails validation is `unusable` (and must be kept as saved). */
export function readBookPipeline(map: { bookPipeline?: unknown }): BookPipelineRead {
  if (map.bookPipeline === undefined) return { kind: "absent" };
  const found = problem(map.bookPipeline);
  if (found) return { kind: "unusable", reason: found, raw: map.bookPipeline };
  return { kind: "usable", data: map.bookPipeline as BookPipelineData };
}

/** The cards the run works on: `order` without the cards the map lost. The one list scheduling, completion, counts, neighbours and the chapter list share. */
export function effectiveOrder(data: Pick<BookPipelineData, "order" | "removed">): string[] {
  const gone = data.removed;
  return gone?.length ? data.order.filter(id => !gone.includes(id)) : data.order;
}
/** How the map's cards (`mapIds`) differ from what the run accepted: new cards, and cards of the run that are gone. */
export function mapDifference(
  data: BookPipelineData,
  mapIds: readonly string[]
): { added: string[]; missing: string[] } {
  const accepted = new Set(data.accepted ?? data.order);
  const onMap = new Set(mapIds);
  return {
    added: mapIds.filter(id => !accepted.has(id)),
    missing: effectiveOrder(data).filter(id => !onMap.has(id))
  };
}

export function emptyAttempts(): StepAttempts {
  return { plan: 0, write: 0, proof: 0 };
}
/** A card's attempt counts; zeros when it has none yet. */
export function attemptsOf(data: BookPipelineData, nodeId: string): StepAttempts {
  const entry = nodeId === "global" ? undefined : data.attempts[nodeId];
  return isObject(entry) ? { ...emptyAttempts(), ...(entry as unknown as StepAttempts) } : emptyAttempts();
}

/** Takes one call from the budget, or null when none is left. */
export function reserveBudget(budget: PipelineBudget): PipelineBudget | null {
  return budget.used >= budget.limit ? null : { used: budget.used + 1, limit: budget.limit };
}
