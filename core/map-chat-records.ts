/**
 * Map chat records (schema v1): pure functions only. One conversation is one JSONL file,
 * `<topicRoot>/Chats/records/<id>.jsonl`, one JSON object per line and every line carries `v:1`.
 * The writer lives in experiences/visual-map/map-chat-record-writer.ts; this file has the format, the path whitelist and the reading.
 */

import { parseVersionedJsonLines, serializeVersionedJsonLine } from "./versioned-json-lines";
import { parseChatBasis, type MapChatBasis } from "./map-chat-basis";
import { MAP_CHAT_CHAIN_END_REASONS, resumeRound, type MapChatChainEndReason } from "./map-chat-chain";
import { normalizeVaultPath } from "./map-chat-guard";
import { mergeProgress, normalizeProgress, type MapChatProgress } from "./map-chat-progress";
import { normalizeRemaining } from "./steps/map-chat/step";
import { markChatBatchTopic, type ChatBatch, type ChatBatchRequest, type ChatBatchTopic } from "./map-chat-batch";

export const RECORD_VERSION = 1;
export const RECORDS_SUBPATH = "Chats/records";

export type RecordTurnStatus = "done" | "plan" | "failed" | "stopped" | "aborted";
export interface RecordLineItem {
  status: string;
  text: string;
  /** What a new or expanded card was built from (read back through `parseChatBasis`; added fields only, the schema stays v1). */
  basis?: MapChatBasis;
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
  /** An automatic round of a continuation (its `message` is the user's original message, not something said again). */
  auto?: true;
  /** The round of the continuation, from 1 (present on an automatic round). */
  round?: number;
  /** What the previous round said was still to do (an automatic round; shown on its separator when the conversation is opened again). */
  remaining?: string;
  /** The first automatic round of a continuation the user picked up again after it was interrupted. */
  resumed?: true;
  /** The conversation applied automatically when the turn started (so the segment limits come back on a resume). */
  autoApply?: true;
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
  /** The follow-up messages that went into the running turn (live), in order; left out when there were none. */
  steers?: string[];
  error?: { text: string; technical: string };
}
export interface RecordPlanLine extends RecordLineBase {
  type: "plan";
  turn: number;
  state: "applied" | "cancelled" | "stopped";
  lines: RecordLineItem[];
}
/** The result lines of the turn as they are now: later work changed them (an expansion that failed replaces its start line). The last one wins over `turn_end.lines`. */
export interface RecordLinesLine extends RecordLineBase {
  type: "lines";
  turn: number;
  lines: RecordLineItem[];
}
export interface RecordImagesLine extends RecordLineBase {
  type: "images";
  turn: number;
  state: string;
  items: { title: string; sourceUrl: string }[];
  inserted: number[];
}
/** `file_written` notes a Markdown file this conversation created or edited: its path and the hash of the text it wrote (the chat sends the file back while it still holds that text). */
/** `file_attached` notes a Markdown file the user dragged into the chat: its path and the hash of the text the chat was sent (it stays readable while the file holds that text). */
/** `cards_found` notes the cards of other maps VAM found by itself and sent with the turn (`topics`: id = map title, title = card title; `reason: "cut"` when long ones were shortened); a restore ignores it. */
/** `file_read` notes an own file the chat asked to read with `read_md_file` (accepted; its text goes in the next turn): path and characters. */
/** `sources_read` marks that a turn sent the map's data sources (a restored conversation keeps its writes behind the plan). */
/** `editor_opening` notes the chief editor's opening words of a book plan (`key` says which plan, `text` what was shown); `turn` is the last turn before it. */
/** `research_started` marks that the conversation started web research (it keeps the plan allow-list on after a restore). */
export type RecordEventKind =
  | "resend"
  | "undo"
  | "redo"
  | "undo_refused"
  | "chain_end"
  | "research_started"
  | "sources_read"
  | "editor_opening"
  | "file_written"
  | "file_attached"
  | "file_read"
  | "cards_found"
  | "research_batch"
  | "research_batch_topic"
  | "research_batch_end";
export interface RecordEventLine extends RecordLineBase {
  type: "event";
  turn: number;
  kind: RecordEventKind;
  /** `chain_end`: why the continuation ended, the round it ended in and what was still to do. */
  reason?: string;
  round?: number;
  remaining?: string;
  /** `chain_end`: AI calls the segment started. */
  calls?: number;
  /** `research_batch`: the cards the chat's research batch runs, and what it was asked to do (read back through a whitelist). */
  topics?: { id: string; title: string }[];
  request?: Record<string, unknown>;
  /** `research_batch_topic`: one card of the batch and how it came out. `research_batch_end`: `not_started` when nothing ran. */
  id?: string;
  status?: string;
  /** `file_written` / `file_attached`: the file and the content hash of what was written / attached. */
  path?: string;
  hash?: string;
  /** `editor_opening`: which plan the opening belongs to and the words shown. */
  key?: string;
  text?: string;
  /** `file_read`: the characters of the own file whose read the chat asked for (path above); a trace only, a restore ignores it. */
  chars?: number;
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
  | RecordLinesLine
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
  return serializeVersionedJsonLine(RECORD_VERSION, line);
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

/** A `turn_end` whose `steers` is not a list of strings keeps the line and loses that field. */
function withValidSteers(line: RecordLine): RecordLine {
  if (line.type !== "turn_end" || !("steers" in line)) return line;
  const steers = (line as { steers?: unknown }).steers;
  if (Array.isArray(steers) && steers.every(item => typeof item === "string")) return line;
  const { steers: _dropped, ...rest } = line;
  void _dropped;
  return rest;
}

/** Reads a file's text. A cut or broken line is skipped; a line with another `v` makes the file unrecoverable. */
export function parseRecord(text: string): ParsedRecord {
  return parseVersionedJsonLines(text, RECORD_VERSION, value =>
    typeof value.type === "string" ? withValidSteers(value as unknown as RecordLine) : null
  );
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
  /** The result lines of the applied plan. */
  planLines?: RecordLineItem[];
  rejected?: unknown[];
  /** The follow-ups that went into the turn, in order (empty when there were none). */
  steers: string[];
  images?: RestoredImages;
  /** The reply was undone and not redone (it still shows, like it does in memory). */
  undone: boolean;
  backfilled: boolean;
  /** An automatic round: shown as one, not as something the user said. */
  auto: boolean;
  /** The round of an automatic round, when the record says it (2 and up). */
  round?: number;
  /** What the automatic round's separator said was left (plain text; capped). */
  remaining?: string;
  /** How the continuation that ended with this turn ended (known reasons only; its words are the panel's). */
  chainEnd?: { reason: MapChatChainEndReason; round: number; remaining: string };
  /** The research batch this turn started, as far as the file knows (no end: the plugin was reloaded while it ran). */
  batch?: ChatBatch;
}
export interface RestoredConversation {
  id: string;
  mapPath: string | null;
  mapId: string | null;
  turns: RestoredTurn[];
  /** The time of the last finished turn, for "restored <M/D HH:mm>" (the UI formats it); null with no turn. */
  restoredAt: string | null;
  /** The file says this conversation started web research (an older file has no mark: false). */
  startedResearch: boolean;
  /** A turn of the file sent the map's data sources (an older file has no mark: false). */
  readsSources: boolean;
  /** The chief editor's openings shown in this conversation, each after the turn it followed (0 = before any turn), oldest first. */
  openings: { afterTurn: number; key: string; text: string }[];
  /** Files this conversation wrote (path and hash of each version), oldest first; only a safe vault path and a hex hash are kept. */
  ownFiles: { path: string; hash: string }[];
  /** Files the user attached (dragged in) with the hash each held then; same safety rules as `ownFiles` (an older file has none). */
  attachedFiles: { path: string; hash: string }[];
  /** The last chain was interrupted and the user can pick it up again (derived from the lines; nothing of it is written). */
  resume?: RestoredChainResume;
}
/** Where an interrupted chain goes on, as far as the file knows. */
export interface RestoredChainResume {
  /** The restored turn the resume hangs under (the last one that comes back). */
  turn: number;
  round: number;
  maxRounds: number;
  remaining: string;
  /** The round the chain stopped in. */
  stoppedRound: number;
  /** Why it ended; null: it was cut off (reload). */
  reason: MapChatChainEndReason | null;
  /** The user's original message of the chain. */
  message: string;
  /** The cards the last round was started with (the AI's selection, when it made one). */
  selectedIds: string[];
  /** The result lines of the last applied round. */
  lastResults: { text: string; status: "done" | "skipped" | "failed" }[];
  /** The steps of the whole instruction as the replies in the file left them (worked out from the stored replies; nothing extra is written). */
  progress?: MapChatProgress;
  /** The last turn started with auto-apply on. */
  autoApply?: true;
}

const BATCH_TOPIC_LIMIT = 1000;
const BATCH_TITLE_LIMIT = 200;
/** A hand-edited file cannot put anything but known, typed values into a batch: every field is checked, unknown ones are dropped. */
function restoredBatchRequest(raw: unknown): ChatBatchRequest {
  const value = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const pick = <T extends string>(item: unknown, allowed: readonly T[], fallback: T): T =>
    allowed.find(name => name === item) ?? fallback;
  return {
    mapAiMode: pick(value.mapAiMode, ["quick", "standard"] as const, "standard"),
    researchMode: pick(value.researchMode, ["local", "research"] as const, "research"),
    researchDepth: pick(value.researchDepth, ["fast", "normal", "deep"] as const, "normal"),
    requirements: typeof value.requirements === "string" ? value.requirements.slice(0, 4000) : "",
    imageSearch: value.imageSearch === true,
    ...(value.rewrite === true ? { rewrite: true as const } : {}),
    ...(typeof value.model === "string" && value.model.length <= 200 ? { model: value.model } : {}),
    ...(typeof value.batchModel === "string" && value.batchModel && value.batchModel.length <= 200
      ? { batchModel: value.batchModel }
      : {})
  };
}
function restoredBatchTopics(raw: unknown): ChatBatchTopic[] {
  if (!Array.isArray(raw)) return [];
  const topics: ChatBatchTopic[] = [];
  for (const entry of raw as unknown[]) {
    if (topics.length >= BATCH_TOPIC_LIMIT) break;
    const item = entry as { id?: unknown; title?: unknown } | null;
    if (!item || typeof item !== "object" || typeof item.id !== "string" || !item.id) continue;
    topics.push({
      id: item.id.slice(0, 200),
      title: typeof item.title === "string" ? item.title.slice(0, BATCH_TITLE_LIMIT) : ""
    });
  }
  return topics;
}

/** Result lines read back from a file: the basis keeps its known shape only (a hand-edited file cannot put anything else on screen). */
function restoredItems(items: unknown): RecordLineItem[] {
  if (!Array.isArray(items)) return [];
  return items.map((item: RecordLineItem) => {
    const basis = parseChatBasis(item?.basis);
    const copy = { ...item };
    delete copy.basis;
    return basis ? { ...copy, basis } : copy;
  });
}

/** The turns a conversation can show again: only `turn_end` with status done or plan. Failed, stopped and aborted turns stay in the file only. */
export function restoreConversation(id: string, lines: RecordLine[]): RestoredConversation {
  let mapPath: string | null = null;
  let mapId: string | null = null;
  const starts = new Map<number, RecordTurnStartLine>();
  const order: number[] = [];
  const ends = new Map<number, RecordTurnEndLine>();
  const plans = new Map<number, { state: RecordPlanLine["state"]; lines: RecordLineItem[] }>();
  const images = new Map<number, RestoredImages>();
  const current = new Map<number, RecordLineItem[]>();
  const undone = new Map<number, boolean>();
  const chainEnds = new Map<number, { reason: MapChatChainEndReason; round: number; remaining: string }>();
  const batches = new Map<number, ChatBatch>();
  let startedResearch = false;
  let readsSources = false;
  const openings: { afterTurn: number; key: string; text: string }[] = [];
  const ownFiles: { path: string; hash: string }[] = [];
  const attachedFiles: { path: string; hash: string }[] = [];
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
      plans.set(line.turn, { state: line.state, lines: Array.isArray(line.lines) ? line.lines : [] });
    } else if (line.type === "lines") {
      // Read in file order: a `lines` row after the turn's `plan` row is the complete result (a failure after the plan was applied),
      // so it replaces the plan's lines; one written before it (during the apply) stays the turn's own lines.
      if (Array.isArray(line.lines)) {
        const plan = plans.get(line.turn);
        if (plan) plan.lines = line.lines;
        else current.set(line.turn, line.lines);
      }
    } else if (line.type === "images") {
      images.set(line.turn, { state: line.state, items: line.items ?? [], inserted: line.inserted ?? [] });
    } else if (line.type === "event") {
      if (line.kind === "undo") undone.set(line.turn, true);
      else if (line.kind === "redo") undone.set(line.turn, false);
      else if (line.kind === "research_started") startedResearch = true;
      else if (line.kind === "sources_read") readsSources = true;
      else if (line.kind === "editor_opening") {
        // Plain text only, capped; one opening per key.
        if (
          typeof line.key === "string" &&
          typeof line.text === "string" &&
          line.key.length <= 200 &&
          line.text.length <= 2000 &&
          Number.isInteger(line.turn) &&
          line.turn >= 0 &&
          !openings.some(item => item.key === line.key)
        )
          openings.push({ afterTurn: line.turn, key: line.key, text: line.text });
      } else if (line.kind === "file_written" || line.kind === "file_attached") {
        // A hand-edited file cannot make the chat read a path it was never allowed to write: only a normal vault path counts.
        const path = typeof line.path === "string" ? normalizeVaultPath(line.path) : null;
        if (
          path !== null &&
          !path.split("/").some(part => part.startsWith(".")) &&
          typeof line.hash === "string" &&
          /^[0-9a-f]{1,32}$/.test(line.hash)
        )
          (line.kind === "file_written" ? ownFiles : attachedFiles).push({ path, hash: line.hash });
      } else if (line.kind === "research_batch") {
        // A second one in the same turn is a rerun: the batch is open again and its cards join the first one's.
        const topics = restoredBatchTopics(line.topics);
        const batch = batches.get(line.turn);
        if (!batch)
          batches.set(line.turn, {
            turn: line.turn,
            topics,
            succeeded: [],
            failed: [],
            ended: false,
            request: restoredBatchRequest(line.request)
          });
        else {
          for (const topic of topics)
            if (!batch.topics.some(item => item.id === topic.id) && batch.topics.length < BATCH_TOPIC_LIMIT)
              batch.topics.push(topic);
          batch.ended = false;
          batch.request = restoredBatchRequest(line.request);
        }
      } else if (line.kind === "research_batch_topic") {
        const batch = batches.get(line.turn);
        if (batch && typeof line.id === "string" && batch.topics.some(topic => topic.id === line.id))
          markChatBatchTopic(
            batch,
            line.id,
            line.status === "succeeded" ? "succeeded" : line.status === "failed" ? "failed" : "stopped"
          );
      } else if (line.kind === "research_batch_end") {
        if (line.status === "not_started") batches.delete(line.turn);
        else {
          const batch = batches.get(line.turn);
          if (batch) batch.ended = true;
        }
      } else if (line.kind === "chain_end") {
        // A hand-edited file cannot put anything but a known reason on screen; the words are the panel's, the rest is plain text.
        const reason = (MAP_CHAT_CHAIN_END_REASONS as readonly unknown[]).find(item => item === line.reason);
        if (reason && reason !== "map_changed")
          chainEnds.set(line.turn, {
            reason: reason as MapChatChainEndReason,
            round: Number.isInteger(line.round) && line.round! >= 1 ? Math.min(line.round!, 99) : 1,
            remaining: typeof line.remaining === "string" ? line.remaining.slice(0, 1000) : ""
          });
      }
    }
  }
  const turns: RestoredTurn[] = [];
  // A chain ends on the turn the record was on, which may be a failed or stopped one (not restored): its sentence goes to the
  // closest earlier turn that comes back (never over one that has its own), or is dropped with no such turn (decision #19).
  const carried = new Map<number, { reason: MapChatChainEndReason; round: number; remaining: string }>();
  {
    let previous: number | null = null;
    for (const number of order) {
      const end = ends.get(number);
      const comes = !!starts.get(number) && !!end && (end.status === "done" || end.status === "plan");
      if (comes) previous = number;
      else if (chainEnds.has(number)) {
        // Decision #19: with no earlier turn that comes back, the sentence is dropped (a lone one has no context).
        if (previous !== null && !chainEnds.has(previous) && !carried.has(previous))
          carried.set(previous, chainEnds.get(number)!);
      }
    }
  }
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
      lines: restoredItems(current.get(number) ?? end.lines),
      modelLabel: typeof end.modelLabel === "string" ? end.modelLabel : "",
      status: end.status,
      stalePlan: end.status === "plan",
      planState: plans.get(number)?.state,
      planLines: plans.get(number) ? restoredItems(plans.get(number)?.lines) : undefined,
      rejected: end.rejected,
      steers: Array.isArray(end.steers) ? end.steers.filter((item): item is string => typeof item === "string") : [],
      images: images.get(number),
      undone: undone.get(number) === true,
      backfilled: start.backfilled === true,
      auto: start.auto === true,
      ...(start.auto === true && typeof start.round === "number" && Number.isInteger(start.round) && start.round >= 2
        ? { round: start.round }
        : {}),
      ...(start.auto === true && typeof start.remaining === "string" && start.remaining.trim()
        ? { remaining: start.remaining.slice(0, 1000) }
        : {}),
      ...(chainEnds.has(number) || carried.has(number)
        ? { chainEnd: chainEnds.get(number) ?? carried.get(number) }
        : {}),
      ...(batches.has(number) ? { batch: batches.get(number) } : {})
    });
  }
  const resume = chainResumeOf(lines, turns);
  return {
    id,
    mapPath,
    mapId,
    turns,
    restoredAt: turns.length ? turns[turns.length - 1].at : null,
    startedResearch,
    readsSources,
    openings,
    ownFiles,
    attachedFiles,
    ...(resume ? { resume } : {})
  };
}

const resultStatus = (status: unknown): "done" | "skipped" | "failed" =>
  status === "done" ? "done" : status === "skipped" ? "skipped" : "failed";

/**
 * Whether the last chain of a file was interrupted and where it goes on (null: nothing to pick up). Only the last turn counts: a
 * later user message covers an older chain. Old files (an automatic round with no round, a reply that cannot be read) give null.
 */
export function chainResumeOf(lines: RecordLine[], turns: RestoredTurn[]): RestoredChainResume | null {
  if (!turns.length) return null;
  let last: RecordTurnStartLine | null = null;
  for (const line of lines) if (line.type === "turn_start") last = line;
  if (!last) return null;
  const number = last.turn;
  let round = 1;
  if (last.auto === true) {
    if (typeof last.round !== "number" || !Number.isInteger(last.round) || last.round < 2) return null;
    round = last.round;
  }
  let reason: MapChatChainEndReason | null = null;
  let endRemaining: string | null = null;
  let turnEnd: RecordTurnEndLine | null = null;
  let plan: RecordPlanLine | null = null;
  for (const line of lines) {
    if (line.type === "turn_end" && line.turn === number) turnEnd = line;
    else if (line.type === "plan" && line.turn === number) plan = line;
    else if (line.type === "event" && line.kind === "chain_end" && line.turn === number) {
      const known = (MAP_CHAT_CHAIN_END_REASONS as readonly unknown[]).find(item => item === line.reason);
      if (!known) return null;
      if (known === "map_changed") continue;
      reason = known as MapChatChainEndReason;
      endRemaining = typeof line.remaining === "string" ? line.remaining.slice(0, 1000) : null;
    }
  }
  const applied = !!turnEnd && (turnEnd.status === "done" || (turnEnd.status === "plan" && plan?.state === "applied"));
  let replyRemaining = endRemaining;
  if (replyRemaining === null) {
    replyRemaining = "";
    if (turnEnd && typeof turnEnd.raw === "string") {
      try {
        replyRemaining = normalizeRemaining((JSON.parse(turnEnd.raw) as { remaining?: unknown } | null)?.remaining);
      } catch {
        replyRemaining = "";
      }
    }
  }
  const startRemaining = typeof last.remaining === "string" ? last.remaining.slice(0, 1000) : "";
  const next = resumeRound({ reason, round, applied, startRemaining, replyRemaining });
  if (!next) return null;
  let lastApplied: RestoredTurn | null = null;
  for (let i = turns.length - 1; i >= 0 && !lastApplied; i--) {
    const turn = turns[i];
    if (turn.status === "done" || turn.planState === "applied") lastApplied = turn;
  }
  let progress: MapChatProgress | null = null;
  for (const line of lines) {
    if (line.type !== "turn_end" || typeof line.raw !== "string") continue;
    try {
      progress = mergeProgress(
        progress,
        normalizeProgress((JSON.parse(line.raw) as { progress?: unknown } | null)?.progress)
      );
    } catch {
      // an unreadable reply carries no progress
    }
  }
  const results = lastApplied ? (lastApplied.planLines ?? lastApplied.lines) : [];
  return {
    turn: turns[turns.length - 1].turn,
    round: next.round,
    maxRounds: next.maxRounds,
    remaining: next.remaining,
    stoppedRound: round,
    reason,
    message: typeof last.message === "string" ? last.message : "",
    selectedIds: Array.isArray(last.origin?.selectedIds)
      ? last.origin.selectedIds.filter((id): id is string => typeof id === "string")
      : [],
    lastResults: results.map(item => ({ text: String(item?.text ?? ""), status: resultStatus(item?.status) })),
    ...(progress ? { progress } : {}),
    ...(last.autoApply === true ? { autoApply: true as const } : {})
  };
}
