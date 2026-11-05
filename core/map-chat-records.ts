/**
 * Map chat records (schema v1): pure functions only. One conversation is one JSONL file,
 * `<topicRoot>/Chats/records/<id>.jsonl`, one JSON object per line and every line carries `v:1`.
 * The writer lives in experiences/visual-map/map-chat-record-writer.ts; this file has the format, the path whitelist and the reading.
 */

export const RECORD_VERSION = 1;
export const RECORDS_SUBPATH = "Chats/records";

export type RecordTurnStatus = "done" | "plan" | "failed" | "stopped" | "aborted";
export interface RecordLineItem {
  status: string;
  text: string;
}
export interface RecordOriginChip {
  kind: string;
  path?: string;
  id?: string;
  text?: string;
}
interface RecordLineBase {
  v: 1;
  at: string;
}
export interface RecordConversationLine {
  v: 1;
  type: "conversation";
  id: string;
  startedAt: string;
  mapPath: string;
  mapId: string;
  pluginVersion: string;
}
export interface RecordTurnStartLine extends RecordLineBase {
  type: "turn_start";
  turn: number;
  message: string;
  origin?: { chips: RecordOriginChip[]; selectedIds: string[] };
  /** The request as sent: step id/version, model, reasoning, language, message and the MapChatContext. Absent on a backfilled turn. */
  request?: {
    step: { id: string; version: number };
    model: string;
    reasoning?: string;
    language?: string;
    contentLanguage?: string;
    message: string;
    context?: unknown;
  };
  backfilled?: true;
}
export interface RecordTurnEndLine extends RecordLineBase {
  type: "turn_end";
  turn: number;
  status: RecordTurnStatus;
  reason?: string;
  raw: string | null;
  reply: string;
  lines: RecordLineItem[];
  modelLabel: string;
  rejected?: unknown[];
  error?: { text: string; technical: string };
}
export interface RecordPlanLine extends RecordLineBase {
  type: "plan";
  turn: number;
  state: "applied" | "cancelled" | "stopped";
  lines: RecordLineItem[];
}
export interface RecordImagesLine extends RecordLineBase {
  type: "images";
  turn: number;
  state: string;
  items: { title: string; sourceUrl: string }[];
  inserted: number[];
}
export type RecordEventKind = "resend" | "undo" | "redo" | "undo_refused";
export interface RecordEventLine extends RecordLineBase {
  type: "event";
  turn: number;
  kind: RecordEventKind;
}
export interface RecordMovedLine extends RecordLineBase {
  type: "moved";
  from: string;
  to: string;
}
export type RecordLine =
  | RecordConversationLine
  | RecordTurnStartLine
  | RecordTurnEndLine
  | RecordPlanLine
  | RecordImagesLine
  | RecordEventLine
  | RecordMovedLine;
/** A line as the caller hands it over: no `v`, and `at` is filled in by the writer. */
export type RecordLineInput = RecordLine extends infer L
  ? L extends RecordLine
    ? Omit<L, "v" | "at"> & { at?: string }
    : never
  : never;

export class RecordPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecordPathError";
  }
}

// ---- ids and paths ----

const ID_PATTERN = /^\d{8}-\d{6}-[0-9a-z]{6}$/;
const BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz";
const pad = (value: number, width = 2): string => String(value).padStart(width, "0");

export const isRecordId = (id: unknown): id is string => typeof id === "string" && ID_PATTERN.test(id);

/** `YYYYMMDD-HHMMSS-xxxxxx` in UTC: time, then 6 base36 characters. Safe as a file name; plain string order is time order. */
export function newRecordId(now: Date = new Date(), random: () => number = Math.random): string {
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  let suffix = "";
  for (let i = 0; i < 6; i++) suffix += BASE36[Math.min(35, Math.floor(random() * 36))];
  return `${stamp}-${suffix}`;
}

/** The time inside an id, as an ISO string (null when the id is not one). */
export function recordIdTime(id: string): string | null {
  const match = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-/.exec(id);
  return match ? `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.000Z` : null;
}

/**
 * Checks a managed topic root before anything is written under it: a Vault-relative path with no `..` or `.` part, no empty
 * part, no backslash, no drive or leading slash, and no part that starts with a dot (so never the config folder), and none named like `configDir` when given. Throws {@link RecordPathError}.
 */
export function assertRecordRoot(root: unknown, configDir?: string): string {
  if (typeof root !== "string" || !root) throw new RecordPathError("Record root is empty");
  if (root.startsWith("/") || /^[a-zA-Z]:/.test(root) || root.includes("\\") || root.includes("\0"))
    throw new RecordPathError(`Record root is not a Vault-relative path: ${root}`);
  const banned = configDir ? configDir.toLowerCase() : null;
  for (const part of root.split("/")) {
    if (!part || part === "." || part === "..") throw new RecordPathError(`Record root has an unsafe part: ${root}`);
    // Any dot-folder is refused (the config folder, .git, .trash), and the Vault's configured config folder by name.
    if (part.startsWith(".") || part.toLowerCase() === banned)
      throw new RecordPathError(`Record root is inside a hidden or config folder: ${root}`);
  }
  return root;
}

export function recordsDir(root: string, configDir?: string): string {
  return `${assertRecordRoot(root, configDir)}/${RECORDS_SUBPATH}`;
}

/** `<root>/Chats/records/<id>.jsonl`, or throws {@link RecordPathError} for an unsafe root or an id that is not an id. */
export function recordPath(root: string, id: string, configDir?: string): string {
  if (!isRecordId(id)) throw new RecordPathError(`Bad record id: ${String(id)}`);
  return `${recordsDir(root, configDir)}/${id}.jsonl`;
}

/** True for a path this module could have made (a file directly in some `Chats/records` folder with an id as its name). */
export function isRecordFilePath(path: string): boolean {
  const match = /^(.+)\/Chats\/records\/([^/]+)\.jsonl$/.exec(path);
  if (!match) return false;
  try {
    assertRecordRoot(match[1]);
  } catch {
    return false;
  }
  return isRecordId(match[2]);
}

/** The record files among some vault files: only paths {@link isRecordFilePath} accepts (a `.md` or any other `.jsonl` beside them is never one). */
export function recordFilesIn<T extends { path: string }>(files: readonly T[]): T[] {
  return files.filter(file => isRecordFilePath(file.path));
}

// ---- writing ----

/** One line of the file, newline included, with `v:1` first. */
export function serializeLine(line: RecordLineInput | RecordLine): string {
  const { v: _ignored, ...rest } = line as { v?: unknown } & Record<string, unknown>;
  void _ignored;
  return `${JSON.stringify({ v: RECORD_VERSION, ...rest })}\n`;
}

// ---- reading ----

export interface ParsedRecord {
  lines: RecordLine[];
  /** Lines skipped as broken (a cut last line, bad JSON, no `type`). */
  skipped: number;
  /** A line has a `v` this code does not know: the file is not restored and not written to. */
  unrecoverable: boolean;
  /** The text is empty or ends with a line break (false: the last line was cut, so the next line needs a break first). */
  cleanEnd: boolean;
}

/** Reads a file's text. A cut or broken line is skipped; a line with another `v` makes the file unrecoverable. */
export function parseRecord(text: string): ParsedRecord {
  const lines: RecordLine[] = [];
  let skipped = 0;
  let unrecoverable = false;
  for (const part of text.split("\n")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      skipped++;
      continue;
    }
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      typeof (value as { type?: unknown }).type !== "string"
    ) {
      skipped++;
      continue;
    }
    const version = (value as { v?: unknown }).v;
    if (version === RECORD_VERSION) lines.push(value as RecordLine);
    else if (version === undefined) skipped++;
    else unrecoverable = true;
  }
  return { lines, skipped, unrecoverable, cleanEnd: text === "" || text.endsWith("\n") };
}

const lineTime = (line: RecordLine): string | null => {
  const value = line.type === "conversation" ? line.startedAt : line.at;
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
};

/** `at` of the last line that has a time (null when none). */
export function lastLineAt(lines: RecordLine[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const at = lineTime(lines[i]);
    if (at) return at;
  }
  return null;
}

export interface RecordFileInput {
  id: string;
  path?: string;
  text: string;
}
export interface RecordCandidate {
  id: string;
  path?: string;
  parsed: ParsedRecord;
  /** Last line's `at` (the id's time when the file has none, as for an unreadable version). */
  lastAt: string;
}

const timeOf = (iso: string): number => {
  const time = Date.parse(iso);
  return Number.isFinite(time) ? time : 0;
};

/**
 * The latest conversation of many files: the one whose last line has the greatest `at`; the same time compares the id. A file with
 * no readable line and no recoverable version is ignored. When the latest is unrecoverable it is returned as such (not skipped
 * for an older one), so the caller opens a new file instead of restoring.
 */
export function pickLatest(files: RecordFileInput[]): RecordCandidate | null {
  let best: RecordCandidate | null = null;
  for (const file of files) {
    if (!isRecordId(file.id)) continue;
    const parsed = parseRecord(file.text);
    if (!parsed.lines.length && !parsed.unrecoverable) continue;
    const lastAt = lastLineAt(parsed.lines) ?? recordIdTime(file.id) ?? "";
    const candidate: RecordCandidate = { id: file.id, path: file.path, parsed, lastAt };
    if (!best) {
      best = candidate;
      continue;
    }
    const a = timeOf(candidate.lastAt);
    const b = timeOf(best.lastAt);
    if (a > b || (a === b && candidate.id > best.id)) best = candidate;
  }
  return best;
}

export interface RestoredImages {
  state: string;
  items: { title: string; sourceUrl: string }[];
  inserted: number[];
}
export interface RestoredTurn {
  turn: number;
  at: string;
  message: string;
  origin?: RecordTurnStartLine["origin"];
  reply: string;
  lines: RecordLineItem[];
  modelLabel: string;
  status: "done" | "plan";
  /** A plan card is shown as no longer usable (always true for `plan`). */
  stalePlan: boolean;
  planState?: RecordPlanLine["state"];
  rejected?: unknown[];
  images?: RestoredImages;
  /** The reply was undone and not redone (it still shows, like it does in memory). */
  undone: boolean;
  backfilled: boolean;
}
export interface RestoredConversation {
  id: string;
  mapPath: string | null;
  mapId: string | null;
  turns: RestoredTurn[];
  /** The time of the last finished turn, for "restored <M/D HH:mm>" (the UI formats it); null with no turn. */
  restoredAt: string | null;
}

/** The turns a conversation can show again: only `turn_end` with status done or plan. Failed, stopped and aborted turns stay in the file only. */
export function restoreConversation(id: string, lines: RecordLine[]): RestoredConversation {
  let mapPath: string | null = null;
  let mapId: string | null = null;
  const starts = new Map<number, RecordTurnStartLine>();
  const order: number[] = [];
  const ends = new Map<number, RecordTurnEndLine>();
  const plans = new Map<number, RecordPlanLine["state"]>();
  const images = new Map<number, RestoredImages>();
  const undone = new Map<number, boolean>();
  for (const line of lines) {
    if (line.type === "conversation") {
      mapPath = typeof line.mapPath === "string" ? line.mapPath : mapPath;
      mapId = typeof line.mapId === "string" ? line.mapId : mapId;
    } else if (line.type === "moved") {
      if (typeof line.to === "string") mapPath = line.to;
    } else if (line.type === "turn_start") {
      if (!starts.has(line.turn)) order.push(line.turn);
      starts.set(line.turn, line);
    } else if (line.type === "turn_end") {
      ends.set(line.turn, line);
    } else if (line.type === "plan") {
      plans.set(line.turn, line.state);
    } else if (line.type === "images") {
      images.set(line.turn, { state: line.state, items: line.items ?? [], inserted: line.inserted ?? [] });
    } else if (line.type === "event") {
      if (line.kind === "undo") undone.set(line.turn, true);
      else if (line.kind === "redo") undone.set(line.turn, false);
    }
  }
  const turns: RestoredTurn[] = [];
  for (const number of order) {
    const start = starts.get(number);
    const end = ends.get(number);
    if (!start || !end || (end.status !== "done" && end.status !== "plan")) continue;
    turns.push({
      turn: number,
      at: end.at,
      message: start.message,
      origin: start.origin,
      reply: typeof end.reply === "string" ? end.reply : "",
      lines: Array.isArray(end.lines) ? end.lines : [],
      modelLabel: typeof end.modelLabel === "string" ? end.modelLabel : "",
      status: end.status,
      stalePlan: end.status === "plan",
      planState: plans.get(number),
      rejected: end.rejected,
      images: images.get(number),
      undone: undone.get(number) === true,
      backfilled: start.backfilled === true
    });
  }
  return { id, mapPath, mapId, turns, restoredAt: turns.length ? turns[turns.length - 1].at : null };
}
