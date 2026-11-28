/**
 * Picture-book pipeline data contract. Pure: no vault, no UI. Two stores:
 *  - a card's frontmatter (`pipeline-stage`, `book-role`, `pipeline-issue`, `pipeline-seam`) and the root topic's six `book-*`
 *    settings, read here from a parsed frontmatter object and written by Repository through `setFrontmatterKeys`;
 *  - the map file's top-level `bookPipeline` (`readBookPipeline`). parseMap and serializeMap carry it through untouched, so a
 *    version this code cannot read is saved back exactly as it was; the flow refuses it.
 * A note or map without any of these keys reads and writes exactly as before.
 */

import type { AppliedOp, StructureNode } from "./structure-edit";

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
/** The extra in-place expand passes of a short chapter: writing-model calls only (no picture search, no proofread of their own). */
export const BOOK_EXPAND_PASSES = 2;
/** The most fix rounds (one fix call, then one re-check) the AI proofread may spend on one chapter, and on the whole book. */
export const MAX_AI_FIX_ROUNDS = 2;
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
export type PipelineFieldsPatch = { [K in keyof PipelineFields]?: PipelineFields[K] | null };
const FIELD_KEYS = {
  pipelineStage: "pipeline-stage",
  bookRole: "book-role",
  pipelineRole: "pipeline-role",
  bookRoleBy: "book-role-by",
  pipelineIssue: "pipeline-issue",
  pipelineSeam: "pipeline-seam"
} as const satisfies Record<keyof PipelineFields, string>;
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

export type StepAttempts = Record<PipelineStep, number>;
export interface PipelineBudget {
  used: number;
  limit: number;
}
/** What the editor changed in the book's structure: the ops that were applied, the ones refused (codes only), and the tree before, so the gate can name "chapter A, section B" and an undo can restore it. */
export interface StructureEditState {
  runId: string;
  applied: AppliedOp[];
  rejected: { id: string; code: string }[];
  /** More ops than the cap: none applied. */
  overCap?: true;
  /** Op ids the owner undid (with the ops that depend on them). */
  undone?: string[];
  /** Where each removed or merged card's note was parked (card id -> Archive path), so an undo can put it back. */
  archived?: Record<string, string>;
  /** The structure before any op: `nodes` in reading order, root included. */
  before: { rootId: string; nodes: StructureNode[] };
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
  /**
   * The runner's last closing-page decision: true when the page's only items were chapters the whole-book check skipped as locked (no new
   * page, a notice instead), false when the page was written. The bar reads it; absent on saves from before it existed.
   */
  closingSkipped?: boolean;
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
  /** Per card, the extra expand passes used in this run across all its fix rounds (at most {@link BOOK_EXPAND_PASSES}). Absent = none; a reopen keeps it. */
  expandPasses?: Record<string, number>;
  /** The trial cards (the preface, chapter 1 and its sections, see `bookStructure().trialOf`): only they run before gate 1, which shows their finished result. Absent = an older run: every card is planned before gate 1 as before. */
  trial?: string[];
  /** True while the run waits (or will wait) at the plan review: every chapter is planned, then gate 1 shows the plan before the trial. Absent = the trial runs (or an older run). */
  planReview?: boolean;
  /** True once the chief editor's pass over every card's plan is done (or given up after {@link MAX_STEP_ATTEMPTS} failures). Absent = not yet; a replan clears it. */
  planEdited?: true;
  /** How many times that pass was started (counted before the call, given back by a stop); cleared with {@link BookPipelineData.planEdited}. Absent = none. */
  planEditAttempts?: number;
  /** The chief editor's opening words to the author, written by that pass; shown once in the chat at the plan review. Cleared with {@link BookPipelineData.planEdited}. Absent = none. */
  planOpening?: string;
  /** The map's card set (ids) the run accepted: the cards of the map when it started, or when the owner chose "carry on as before". Absent = older data: `order`. */
  accepted?: string[];
  /** New cards (not in `order`) the owner chose to leave out with "carry on as before". Absent = none. */
  ignored?: string[];
  /** Cards of `order` that are no longer on the map: a terminal state (never retried, no budget, left out of every count and neighbour). Absent = none. */
  removed?: string[];
  /** The chapters at start or replan: card id -> its title and note path then. Lets a later run name and clean a card that is already gone from the map. Absent = older data (nothing known). */
  chapters?: Record<string, { title: string; path: string }>;
  /** The editor's structure changes of this run, applied once at the plan review (`runId` fences a second reply). Absent = none (or older data, or unreadable and dropped on read). */
  structureEdit?: StructureEditState;
  budget: PipelineBudget;
  /** Per chapter, the independent AI proofread and its in-place fixes. Absent = none yet (or an older run). */
  aiProof?: Record<string, AiProofState>;
  /** The whole-book AI proofread (replaces the consistency check). Absent = not started (or an older run). */
  bookProof?: AiProofState;
  /** The whole-book consistency check of the writing phase (one call). Absent: not asked yet (or older data). */
  consistency?: BookConsistency;
  /** Raised by every owner stop; a step result carries the one it started under (absent = 0). */
  stopEpoch?: number;
  /** The last gate presses and what became of them, newest last (`<time> <action> <outcome> [wait=<ms>]`; codes and times only, never owner text). Written beside the state, kept by every state write. Absent = none. */
  gateTrace?: string[];
  /** Raised on every committed transition of the whole state. */
  revision: number;
  startedAt: string;
  phaseStartedAt: string;
}

/** A fixable problem the proofreader found, waiting for a fix call (`chapter`: whole-book only, 1-based). */
export interface AiProofPending {
  id: string;
  quote: string;
  problem: string;
  suggestion: string;
  chapter?: number;
  /** A whole-book fix: the card whose text it changed (`chapter` is only the position in the book's text). */
  chapterId?: string;
  /** A fix that was written: the sentence the fix put in the text (absent in an older save; the box then shows the problem). */
  replacement?: string;
}
/** A problem still open once the proofread is over, with a neutral reason code (the screen turns it into a plain sentence). */
export interface AiProofOpen {
  id: string;
  chapter?: number;
  quote: string;
  problem: string;
  reason: string;
}
/** One AI proofread (a chapter's or the book's): which step is next, the calls used for it, and what it found. */
export interface AiProofState {
  /** The text it was asked about (revision and body hash); a result for another key is dropped. */
  key: string;
  /** Calls started for the current `step` of the current `round` (counted before the call, given back on a stop or budget pause). */
  attempts: number;
  /** Fix rounds finished so far (0..{@link MAX_AI_FIX_ROUNDS}). */
  round: number;
  step: "proof" | "fix";
  done?: boolean;
  /** The proofread could not finish (every attempt failed): never shown as all solved. */
  incomplete?: boolean;
  /** Items the proofreader checked whose quote stood in the text (N). */
  checked: number;
  /** Places the fix calls changed. */
  fixed: number;
  open: AiProofOpen[];
  /** With step "fix": what the fix call must repair. */
  pending?: AiProofPending[];
  /** The places a fix call changed, as the proofreader described them (the chapter's box tells each in one sentence). */
  fixes?: AiProofPending[];
  /** Reason codes of fixes that were blocked in the last fix round, by item id. */
  refused?: Record<string, string>;
  /** The replacement texts the fix rounds wrote: a later check that still quotes one of them found the problem still present. */
  applied?: string[];
  /** One more fix-and-check round over a finished proofread is in progress (`reopenAiRound`); an older save has none. */
  again?: true;
  /**
   * The whole book only: the chapters (card ids) the last check left out because they were AI-locked. With it the proofread is
   * `incomplete` (never shown as all solved) yet may still take one more round ("fix again") once a chapter is unlocked.
   */
  locked?: string[];
}

/**
 * Two chapters (card ids) that state the same fact differently: what each says (model text, one line) and a suggested fix. With
 * `kind: "reference"` (found without a model): chapter `a` names chapter `b` by a wrong number or "next/previous"; `claimA` is the
 * sentence, `claimB` the words used, `suggestion` the right ones. It concerns `a` only.
 */
export interface ConsistencyFinding {
  /**
   * Absent: two chapters disagree (the model's finding, or the program's number check; `a` and `b` may be one chapter). `removed`:
   * chapter `a` still names the removed chapter `b` (title in `claimB`, found by the program). `direction`: chapter `a` says
   * chapter `b`'s subject comes later or came earlier (pointer words in `claimB`) and it is the other way (`suggestion`).
   */
  kind?: "reference" | "removed" | "direction";
  a: string;
  b: string;
  claimA: string;
  claimB: string;
  suggestion: string;
  /** The claim is the model's paraphrase (no sentence of the chapter matched it): shown without quotes. */
  looseA?: true;
  looseB?: true;
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
  | { kind: "absent" }
  /** `structureUnreadable`: `structureEdit` was malformed and is left out of `data` (the saved map is untouched); the caller logs `structure_unreadable`. */
  | { kind: "usable"; data: BookPipelineData; structureUnreadable?: true }
  | { kind: "unusable"; reason: string; raw: unknown };

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
          (item.kind === undefined ||
            item.kind === "reference" ||
            item.kind === "removed" ||
            item.kind === "direction") &&
          (item.looseA === undefined || item.looseA === true) &&
          (item.looseB === undefined || item.looseB === true) &&
          isText(item.a) &&
          isText(item.b) &&
          isText(item.claimA) &&
          isText(item.claimB) &&
          isText(item.suggestion)
      ))
  );
}

function aiProofShape(value: unknown): boolean {
  if (!isObject(value) || !isText(value.key) || !isCount(value.attempts) || !isCount(value.round)) return false;
  if (value.round > MAX_AI_FIX_ROUNDS || (value.step !== "proof" && value.step !== "fix")) return false;
  if (value.done !== undefined && typeof value.done !== "boolean") return false;
  if (value.incomplete !== undefined && typeof value.incomplete !== "boolean") return false;
  if (value.again !== undefined && value.again !== true) return false;
  if (value.locked !== undefined && !isTextList(value.locked)) return false;
  if (!isCount(value.checked) || !isCount(value.fixed)) return false;
  const items = (list: unknown, extra: readonly string[]): boolean =>
    Array.isArray(list) &&
    list.every(
      item =>
        isObject(item) &&
        isText(item.id) &&
        isText(item.quote) &&
        isText(item.problem) &&
        extra.every(key => isText(item[key])) &&
        (item.chapter === undefined || isCount(item.chapter)) &&
        (item.chapterId === undefined || isText(item.chapterId))
    );
  if (!items(value.open, ["reason"])) return false;
  if (value.pending !== undefined && !items(value.pending, ["suggestion"])) return false;
  if (value.fixes !== undefined && !items(value.fixes, ["suggestion"])) return false;
  if (value.applied !== undefined && !(Array.isArray(value.applied) && value.applied.every(isText))) return false;
  return value.refused === undefined || (isObject(value.refused) && Object.values(value.refused).every(isText));
}

const isTextList = (value: unknown): boolean => Array.isArray(value) && value.every(isText);
const OP_TEXT_FIELDS: Record<string, readonly string[]> = {
  add: ["title", "summary", "parent", "ref"],
  remove: ["card"],
  merge: ["card", "into"],
  move: ["card", "parent"],
  rename: ["card", "title"]
};
function structureOpShape(op: unknown): boolean {
  if (!isObject(op) || !isText(op.id) || !isText(op.reason) || !isText(op.kind)) return false;
  const fields = Object.hasOwn(OP_TEXT_FIELDS, op.kind) ? OP_TEXT_FIELDS[op.kind] : undefined;
  if (!fields || !fields.every(key => isText(op[key]))) return false;
  return op.after === undefined || isText(op.after);
}
const structureNodeShape = (node: unknown): boolean =>
  isObject(node) && isText(node.id) && (node.parentId === null || isText(node.parentId)) && isText(node.title);
/** True when `value` is a well-formed {@link StructureEditState}. */
function structureEditShape(value: unknown): boolean {
  if (!isObject(value) || !isText(value.runId) || !value.runId) return false;
  if (!Array.isArray(value.applied)) return false;
  for (const item of value.applied) {
    if (!isObject(item) || !isText(item.id) || !structureOpShape(item.op) || !isObject(item.before)) return false;
    const before = item.before;
    if (!(before.parent === null || isText(before.parent)) || !isText(before.title)) return false;
    if (before.after !== undefined && !isText(before.after)) return false;
    if (before.summary !== undefined && !isText(before.summary)) return false;
    if (before.homes !== undefined && !isTextList(before.homes)) return false;
  }
  if (!Array.isArray(value.rejected) || !value.rejected.every(r => isObject(r) && isText(r.id) && isText(r.code)))
    return false;
  if (value.overCap !== undefined && value.overCap !== true) return false;
  if (value.undone !== undefined && !isTextList(value.undone)) return false;
  if (value.archived !== undefined && !(isObject(value.archived) && Object.values(value.archived).every(isText)))
    return false;
  const before = value.before;
  return (
    isObject(before) && isText(before.rootId) && Array.isArray(before.nodes) && before.nodes.every(structureNodeShape)
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
    raw.expandPasses !== undefined &&
    (!isObject(raw.expandPasses) || Object.values(raw.expandPasses).some(value => !isCount(value)))
  )
    return "expandPasses";
  if (
    raw.trial !== undefined &&
    (!Array.isArray(raw.trial) || raw.trial.some(id => typeof id !== "string" || !(raw.order as string[]).includes(id)))
  )
    return "trial";
  if (raw.planReview !== undefined && raw.planReview !== true) return "planReview";
  if (raw.planEdited !== undefined && raw.planEdited !== true) return "planEdited";
  if (raw.planEditAttempts !== undefined && !isCount(raw.planEditAttempts)) return "planEditAttempts";
  if (!isObject(raw.budget) || !isCount(raw.budget.used) || !isCount(raw.budget.limit) || raw.budget.limit < 1)
    return "budget";
  if (raw.consistency !== undefined && !consistencyShape(raw.consistency)) return "consistency";
  if (raw.aiProof !== undefined && (!isObject(raw.aiProof) || !Object.values(raw.aiProof).every(aiProofShape)))
    return "aiProof";
  if (raw.bookProof !== undefined && !aiProofShape(raw.bookProof)) return "bookProof";
  if (raw.stopEpoch !== undefined && !isCount(raw.stopEpoch)) return "stopEpoch";
  if (
    raw.gateTrace !== undefined &&
    (!Array.isArray(raw.gateTrace) || raw.gateTrace.some(line => typeof line !== "string"))
  )
    return "gateTrace";
  if (!isCount(raw.revision)) return "revision";
  if (typeof raw.startedAt !== "string" || typeof raw.phaseStartedAt !== "string") return "timestamps";
  return undefined;
}

/** Reads `map.bookPipeline`. A missing key is `absent`; anything that fails validation is `unusable` (and must be kept as saved). */
export function readBookPipeline(map: { bookPipeline?: unknown }): BookPipelineRead {
  if (map.bookPipeline === undefined) return { kind: "absent" };
  const found = problem(map.bookPipeline);
  if (found) return { kind: "unusable", reason: found, raw: map.bookPipeline };
  let data = map.bookPipeline as BookPipelineData;
  // The opening is only words for the chat: a malformed or over-long one is dropped, never a reason to refuse the run.
  if (data.planOpening !== undefined && (typeof data.planOpening !== "string" || data.planOpening.length > 2000)) {
    const { planOpening: _opening, ...rest } = data;
    data = rest;
  }
  if (data.structureEdit !== undefined && !structureEditShape(data.structureEdit)) {
    const { structureEdit: _dropped, ...rest } = data;
    return { kind: "usable", data: rest, structureUnreadable: true };
  }
  return { kind: "usable", data };
}

/**
 * What a picture-book run takes away from the map's cards while it owns the map (any phase before "done", running or stopped; abandon
 * deletes `bookPipeline`): card AI until the book is done, and structure edits while the program plans, writes or checks. Gate 1 keeps
 * structure edits: the plan review detects hand-made changes and asks to replan or keep.
 */
export function bookCardLock(phase: PipelinePhase | undefined): { ai: boolean; structure: boolean } {
  if (phase === undefined || phase === "done") return { ai: false, structure: false };
  return { ai: true, structure: phase !== "gate1" };
}

/** The cards the run works on: `order` without the cards the map lost. The one list scheduling, completion, counts, neighbours and the chapter list share. */
export function effectiveOrder(data: Pick<BookPipelineData, "order" | "removed">): string[] {
  const gone = data.removed;
  return gone?.length ? data.order.filter(id => !gone.includes(id)) : data.order;
}
/**
 * Whether the whole-book proofread counts as one unfinished item. Chapters it left out as locked are named one by one instead (each
 * "skipped (locked)", not open), so with any of them the unfinished flag adds no item. The bar's count and the closing page both use it.
 */
export function bookProofUnfinished(proof: Pick<AiProofState, "incomplete" | "locked">): boolean {
  return !!proof.incomplete && !proof.locked?.length;
}
/**
 * ai-flows AI lock: whether the book has no closing page (and the bar no button to it). The runner decides it from the page's own items
 * and saves it (`closingSkipped`); a save from before that field falls back to the older rule: every card left out as locked and
 * nothing checked or open.
 */
export function closingPageSkipped(data: BookPipelineData): boolean {
  if (typeof data.closingSkipped === "boolean") return data.closingSkipped;
  const order = effectiveOrder(data);
  const locked = data.bookProof?.locked;
  if (!order.length || !locked || !order.every(id => locked.includes(id))) return false;
  const slots = [data.bookProof, ...order.map(id => data.aiProof?.[id])];
  return slots.every(slot => !slot || (!slot.checked && !slot.open.length));
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
  return isObject(entry) ? { ...emptyAttempts(), ...entry } : emptyAttempts();
}

/** Takes one call from the budget, or null when none is left. */
export function reserveBudget(budget: PipelineBudget): PipelineBudget | null {
  return budget.used >= budget.limit ? null : { used: budget.used + 1, limit: budget.limit };
}
