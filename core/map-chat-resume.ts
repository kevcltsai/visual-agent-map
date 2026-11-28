// Resume summary (P4.8): what this map's saved chat records say was done last, where it stopped and what is still open. Pure and
// read-only: it reads record text it is given and writes nothing; no provider, no model. Card titles come from the record (the
// view says whether the card is still on the map).
import {
  parseRecord,
  restoreConversation,
  lastLineAt,
  isRecordId,
  recordIdTime,
  type RecordFileInput
} from "./map-chat-records";

export type ResumeItemKind =
  /** Cards this conversation researched (a research batch, or a reply built on research notes). */
  | "research"
  /** A card of a batch that did not finish. */
  | "unfinished"
  /** What an interrupted continuation said was still to do. */
  | "remaining"
  /** The newest turn failed or was stopped. */
  | "stopped"
  /** A recent finished request. */
  | "recent";

export interface ResumeItem {
  kind: ResumeItemKind;
  /** Plain text taken from the record (card titles, the user's message, what was left). Shown with setText only. */
  subject: string;
  /** `research`: cards that finished, of the cards the batch ran. */
  done?: number;
  total?: number;
  /** The card to focus; the view decides whether it is still on the map. */
  nodeId?: string;
  /** The title the record knew for that card. */
  nodeTitle?: string;
  recordId: string;
  recordPath?: string;
  turn: number;
  at: string;
}

export interface ResumeSummary {
  /** `empty`: no record to resume from. */
  state: "empty" | "items";
  items: ResumeItem[];
}

export const RESUME_CONVERSATIONS = 3;
export const RESUME_TURNS_PER_CONVERSATION = 3;
export const RESUME_ITEM_LIMIT = 10;
const SUBJECT_LIMIT = 120;

const clip = (text: string): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > SUBJECT_LIMIT ? `${flat.slice(0, SUBJECT_LIMIT - 1)}…` : flat;
};

/**
 * The summary of a map's record files, newest conversation first. `mapId`: a conversation that names another map is left out.
 * Order inside a conversation: where it stopped, then its newest turns.
 */
export function buildResumeSummary(files: readonly RecordFileInput[], mapId?: string | null): ResumeSummary {
  const conversations: { file: RecordFileInput; lines: ReturnType<typeof parseRecord>["lines"]; at: string }[] = [];
  for (const file of files) {
    if (!isRecordId(file.id)) continue;
    const parsed = parseRecord(file.text);
    if (parsed.unrecoverable || !parsed.lines.length) continue;
    const head = parsed.lines.find(line => line.type === "conversation");
    if (mapId && head?.type === "conversation" && head.mapId && head.mapId !== mapId) continue;
    conversations.push({ file, lines: parsed.lines, at: lastLineAt(parsed.lines) ?? recordIdTime(file.id) ?? "" });
  }
  const time = (iso: string): number => (Number.isFinite(Date.parse(iso)) ? Date.parse(iso) : 0);
  conversations.sort((a, b) => time(b.at) - time(a.at) || (a.file.id < b.file.id ? 1 : -1));
  const items: ResumeItem[] = [];
  conversations.slice(0, RESUME_CONVERSATIONS).forEach((conversation, index) => {
    const { file, lines } = conversation;
    const base = (turn: number, at: string) => ({ recordId: file.id, recordPath: file.path, turn, at });
    const restored = restoreConversation(file.id, lines);
    if (index === 0) {
      const lastEnd = [...lines].reverse().find(line => line.type === "turn_end");
      if (lastEnd?.type === "turn_end" && lastEnd.status !== "done" && lastEnd.status !== "plan") {
        const start = lines.find(line => line.type === "turn_start" && line.turn === lastEnd.turn);
        const message = start?.type === "turn_start" ? start.message : "";
        const selected = start?.type === "turn_start" ? start.origin?.selectedIds?.[0] : undefined;
        items.push({
          kind: "stopped",
          subject: clip(message),
          ...(typeof selected === "string" ? { nodeId: selected } : {}),
          ...base(lastEnd.turn, lastEnd.at)
        });
      }
      if (restored.resume?.remaining.trim()) {
        const selected = restored.resume.selectedIds[0];
        items.push({
          kind: "remaining",
          subject: clip(restored.resume.remaining),
          ...(selected ? { nodeId: selected } : {}),
          ...base(restored.resume.turn, restored.turns.at(-1)?.at ?? conversation.at)
        });
      }
    }
    for (const turn of [...restored.turns].reverse().slice(0, RESUME_TURNS_PER_CONVERSATION)) {
      const at = base(turn.turn, turn.at);
      if (turn.batch?.topics.length) {
        const batch = turn.batch;
        const done = batch.topics.filter(topic => batch.succeeded.includes(topic.id)).length;
        items.push({
          kind: "research",
          subject: clip(
            batch.topics
              .slice(0, 3)
              .map(topic => topic.title || topic.id)
              .join(" / ")
          ),
          done,
          total: batch.topics.length,
          nodeId: batch.topics[0].id,
          nodeTitle: batch.topics[0].title,
          ...at
        });
        for (const topic of batch.topics.filter(item => !batch.succeeded.includes(item.id)).slice(0, 3))
          items.push({
            kind: "unfinished",
            subject: clip(topic.title || topic.id),
            nodeId: topic.id,
            nodeTitle: topic.title,
            ...at
          });
        continue;
      }
      let source: { id: string; title: string } | undefined;
      for (const line of turn.lines) if (!source && line.basis?.kind === "research") source = line.basis.sources[0];
      if (source) {
        items.push({
          kind: "research",
          subject: clip(source.title),
          nodeId: source.id,
          nodeTitle: source.title,
          ...at
        });
        continue;
      }
      const selected = turn.origin?.selectedIds?.[0];
      items.push({ kind: "recent", subject: clip(turn.message), ...(selected ? { nodeId: selected } : {}), ...at });
    }
  });
  const capped = items.slice(0, RESUME_ITEM_LIMIT);
  return capped.length ? { state: "items", items: capped } : { state: "empty", items: [] };
}
