/**
 * Topic chat records (schema v1): pure functions only. One topic is one JSONL file,
 * `<topicRoot>/Chats/topics/<node-id>.jsonl`, one JSON object per line and every line carries `v:1`.
 * It is separate from the sidebar's `Chats/records/` (its switch, count and delete never touch these files).
 * The writer lives in experiences/visual-map/topic-chat-record-writer.ts. No raw reply, request context, prompt or secret is stored.
 */

import { assertRecordRoot, RecordPathError } from "./map-chat-records";

export const TOPIC_CHAT_RECORD_VERSION = 1;
export const TOPIC_CHAT_SUBPATH = "Chats/topics";

export type TopicRecordKind = "research" | "expand" | "synthesize" | "ask";
export type TopicRecordMode = "quick" | "standard";
export type TopicRecordStatus = "done" | "failed" | "stopped";

export interface TopicChatTurnLine {
  v: 1;
  type: "turn";
  id: string;
  at: string;
  kind: TopicRecordKind;
  mode: TopicRecordMode;
  message: string;
}
export interface TopicChatResultLine {
  v: 1;
  type: "result";
  id: string;
  at: string;
  status: TopicRecordStatus;
  text: string;
}
/** An addition the running task took in; `id` is the turn it belongs to. Only taken-in ones are written. */
export interface TopicChatSteerLine {
  v: 1;
  type: "steer";
  id: string;
  at: string;
  text: string;
}
export type TopicChatLine = TopicChatTurnLine | TopicChatResultLine | TopicChatSteerLine;
/** A line as the caller hands it over: no `v`. */
export type TopicChatLineInput =
  | Omit<TopicChatTurnLine, "v">
  | Omit<TopicChatResultLine, "v">
  | Omit<TopicChatSteerLine, "v">;

const KINDS: readonly string[] = ["research", "expand", "synthesize", "ask"];
const MODES: readonly string[] = ["quick", "standard"];
const STATUSES: readonly string[] = ["done", "failed", "stopped"];
const NODE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** A node id that is safe as a file name; any other id keeps its conversation in memory only. */
export const isSafeTopicNodeId = (id: unknown): id is string => typeof id === "string" && NODE_ID_PATTERN.test(id);

/** `<root>/Chats/topics`; throws {@link RecordPathError} for an unsafe root. */
export function topicChatDir(root: string, configDir?: string): string {
  return `${assertRecordRoot(root, configDir)}/${TOPIC_CHAT_SUBPATH}`;
}

/** `<root>/Chats/topics/<node-id>.jsonl`, or throws {@link RecordPathError} for an unsafe root or node id. */
export function topicChatPath(root: string, nodeId: string, configDir?: string): string {
  if (!isSafeTopicNodeId(nodeId)) throw new RecordPathError(`Bad topic id: ${String(nodeId)}`);
  return `${topicChatDir(root, configDir)}/${nodeId}.jsonl`;
}

/** True for a path {@link topicChatPath} could have made. */
export function isTopicChatFilePath(path: string): boolean {
  const match = /^(.+)\/Chats\/topics\/([^/]+)\.jsonl$/.exec(path);
  if (!match) return false;
  try {
    assertRecordRoot(match[1]);
  } catch {
    return false;
  }
  return isSafeTopicNodeId(match[2]);
}

/** One line of the file, newline included, with `v:1` first. */
export function serializeTopicChatLine(line: TopicChatLineInput | TopicChatLine): string {
  const { v: _ignored, ...rest } = line as { v?: unknown } & Record<string, unknown>;
  void _ignored;
  return `${JSON.stringify({ v: TOPIC_CHAT_RECORD_VERSION, ...rest })}\n`;
}

export interface ParsedTopicChat {
  lines: TopicChatLine[];
  /** Lines skipped as broken (a cut last line, bad JSON, wrong shape). */
  skipped: number;
  /** A line has a `v` this code does not know: the file is not read and not written to. */
  unrecoverable: boolean;
  /** The text is empty or ends with a line break (false: the next line needs a break first). */
  cleanEnd: boolean;
}

const isText = (value: unknown): value is string => typeof value === "string";

function validLine(value: Record<string, unknown>): TopicChatLine | null {
  if (!isText(value.id) || !value.id || !isText(value.at)) return null;
  if (value.type === "turn") {
    if (!isText(value.kind) || !KINDS.includes(value.kind) || !isText(value.mode) || !MODES.includes(value.mode))
      return null;
    if (!isText(value.message)) return null;
    return value as unknown as TopicChatTurnLine;
  }
  if (value.type === "result") {
    if (!isText(value.status) || !STATUSES.includes(value.status) || !isText(value.text)) return null;
    return value as unknown as TopicChatResultLine;
  }
  if (value.type === "steer") {
    if (!isText(value.text)) return null;
    return value as unknown as TopicChatSteerLine;
  }
  return null;
}

/** Reads a file's text. A cut or broken line is skipped; a line with another `v` makes the file unrecoverable. */
export function parseTopicChat(text: string): ParsedTopicChat {
  const lines: TopicChatLine[] = [];
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
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      skipped++;
      continue;
    }
    const version = (value as { v?: unknown }).v;
    if (version !== undefined && version !== TOPIC_CHAT_RECORD_VERSION) {
      unrecoverable = true;
      continue;
    }
    const line = version === TOPIC_CHAT_RECORD_VERSION ? validLine(value as Record<string, unknown>) : null;
    if (line) lines.push(line);
    else skipped++;
  }
  return { lines, skipped, unrecoverable, cleanEnd: text === "" || text.endsWith("\n") };
}

export interface RestoredTopicTurn {
  id: string;
  kind: TopicRecordKind;
  mode: TopicRecordMode;
  message: string;
  /** Null when the file has the turn but no result (the view closed before it ended). */
  result: { status: TopicRecordStatus; text: string } | null;
  /** The additions the task took in, in file order (a steer line without its turn is dropped). */
  steers: string[];
}

/** Pairs each turn with its result (the first result of an id wins; a result without a turn is dropped). */
export function restoreTopicChat(lines: readonly TopicChatLine[]): RestoredTopicTurn[] {
  const turns: RestoredTopicTurn[] = [];
  const byId = new Map<string, RestoredTopicTurn>();
  for (const line of lines) {
    if (line.type === "turn") {
      if (byId.has(line.id)) continue;
      const turn: RestoredTopicTurn = {
        id: line.id,
        kind: line.kind,
        mode: line.mode,
        message: line.message,
        result: null,
        steers: []
      };
      byId.set(line.id, turn);
      turns.push(turn);
    } else if (line.type === "steer") {
      byId.get(line.id)?.steers.push(line.text);
    } else {
      const turn = byId.get(line.id);
      if (turn && !turn.result) turn.result = { status: line.status, text: line.text };
    }
  }
  return turns;
}
