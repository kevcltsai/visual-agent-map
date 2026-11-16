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
  pipelineIssue?: string;
  pipelineSeam?: string;
}
/** Only the keys the note has: a note without any of them gets `{}`. */
export function readPipelineFields(fm: Record<string, unknown>): PipelineFields {
  const stage = readPipelineStage(fm["pipeline-stage"]);
  const role = readBookRole(fm["book-role"]);
  const issue = plainPipelineLine(fm["pipeline-issue"]);
  const seam = plainPipelineLine(fm["pipeline-seam"]);
  return {
    ...(stage ? { pipelineStage: stage } : {}),
    ...(role ? { bookRole: role } : {}),
    ...(issue ? { pipelineIssue: issue } : {}),
    ...(seam ? { pipelineSeam: seam } : {})
  };
}
/** `undefined` leaves a key alone; `null` removes it. */
export interface PipelineFieldsPatch {
  pipelineStage?: PipelineStage | null;
  bookRole?: BookRole | null;
  pipelineIssue?: string | null;
  pipelineSeam?: string | null;
}
const FIELD_KEYS = {
  pipelineStage: "pipeline-stage",
  bookRole: "book-role",
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
          : field === "bookRole"
            ? (readBookRole(value) ?? null)
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
    const line = value === null ? null : (value.replace(/\s+/g, " ").trim() || null);
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
  pauseReason?: "budget";
  order: string[];
  globalPlanned: boolean;
  attempts: { "global": number } & Record<string, StepAttempts | number>;
  /** Per card, raised by every successful plan or write; a result carries the one it started under. */
  revisions: Record<string, number>;
  /** Cards whose stage is stale from an earlier run and must be cleared before anything else (idempotent). */
  pendingReset?: string[];
  budget: PipelineBudget;
  /** Raised on every committed transition of the whole state. */
  revision: number;
  startedAt: string;
  phaseStartedAt: string;
}

export type BookPipelineRead =
  | { kind: "absent" }
  | { kind: "usable"; data: BookPipelineData }
  | { kind: "unusable"; reason: string; raw: unknown };

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;

function problem(raw: unknown): string | undefined {
  if (!isObject(raw)) return "not an object";
  if (raw.v !== 1) return "unsupported version";
  if (typeof raw.runId !== "string" || !raw.runId) return "runId";
  if (!PIPELINE_PHASES.includes(raw.phase as PipelinePhase)) return "phase";
  if (!PIPELINE_STATUSES.includes(raw.status as PipelineStatus)) return "status";
  if (raw.pauseReason !== undefined && raw.pauseReason !== "budget") return "pauseReason";
  if (!Array.isArray(raw.order) || raw.order.some(id => typeof id !== "string" || !id)) return "order";
  if (new Set(raw.order).size !== raw.order.length) return "order has duplicates";
  if (typeof raw.globalPlanned !== "boolean") return "globalPlanned";
  if (!isObject(raw.attempts) || !isCount(raw.attempts.global)) return "attempts";
  for (const [key, value] of Object.entries(raw.attempts)) {
    if (key === "global") continue;
    if (!isObject(value) || STEPS.some(step => !isCount(value[step]))) return "attempts entry";
  }
  if (!isObject(raw.revisions) || Object.values(raw.revisions).some(value => !isCount(value))) return "revisions";
  if (raw.pendingReset !== undefined && (!Array.isArray(raw.pendingReset) || raw.pendingReset.some(id => typeof id !== "string")))
    return "pendingReset";
  if (!isObject(raw.budget) || !isCount(raw.budget.used) || !isCount(raw.budget.limit) || raw.budget.limit < 1)
    return "budget";
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
