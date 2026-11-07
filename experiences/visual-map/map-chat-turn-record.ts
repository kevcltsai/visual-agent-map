import type { RecordEventKind, RecordLineInput, RecordLineItem, RecordTurnStatus } from "../../core/map-chat-records";
import type { MapChatImages, MapChatLine, MapChatMessage } from "./map-chat";
import { onceImageLines, placedImage, settledLine } from "./map-chat";
import { t } from "../../i18n";
import type { MapChatRecordWriter } from "./map-chat-record-writer";

/** What a turn's end line carries besides its status. Anything left out is read from the turn's answer message. */
export interface TurnEndFields {
  reason?: string;
  reply?: string;
  lines?: MapChatLine[];
  rejected?: unknown[];
  error?: { text: string; technical: string };
}

/** One row per card that got no picture: "topic: reason" (the group line says only how many). */
const missedImageRows = (blocks: MapChatImages[]): RecordLineItem[] =>
  blocks.flatMap(block => {
    if (block.state === "searching" || placedImage(block)) return [];
    const why =
      block.state === "stopped"
        ? t("ui.map_chat_images_stopped")
        : block.state === "failed"
          ? t("ui.map_chat_images_failed_0", block.reason ?? "")
          : (block.reason ?? t("ui.map_chat_images_none"));
    return [{ status: block.state === "failed" ? "failed" : "skipped", text: `${block.nodeTitle}: ${why}` }];
  });

const plainLines = (lines: MapChatLine[]): RecordLineItem[] =>
  onceImageLines(lines).flatMap(line => {
    const settled = settledLine(line);
    return [
      { status: settled.status, text: settled.text, ...(settled.basis ? { basis: settled.basis } : {}) },
      ...(line.imageGroup ? missedImageRows(line.imageGroup) : [])
    ];
  });

/**
 * One chat turn's part of the conversation record: remembers the model's raw output, writes the turn's end once (the turn fence),
 * and writes the lines that come later (plan results, picture candidates, undo / redo) into the conversation the turn belongs to.
 * Nothing is written once the writer has moved on to another conversation (new conversation, map switch), so a late result of
 * an old turn can never land in a newer file.
 */
export class MapChatTurnRecord {
  /** The model's raw output of the attempt that is current (set by `onRaw`). */
  raw: string | null = null;
  /** The follow-ups that went into the turn (the view sets it; read when the turn ends, so only the delivered ones count). */
  steerTexts: () => string[] = () => [];
  private ended = false;
  constructor(
    private readonly writer: MapChatRecordWriter,
    readonly conversationId: string,
    readonly turn: number,
    readonly answer: MapChatMessage,
    private readonly log: (message: string) => void
  ) {}

  /** The turn has not written its end yet. */
  get isOpen(): boolean {
    return !this.ended;
  }
  private live(): boolean {
    return this.writer.conversationId === this.conversationId;
  }
  /** Writes a line of this turn into its own conversation; a failure to build the line is logged, never thrown into the chat. */
  write(line: RecordLineInput): void {
    if (!this.live()) return;
    try {
      this.writer.write(line);
    } catch (error) {
      this.log(error instanceof Error ? error.message : String(error));
    }
  }
  event(kind: RecordEventKind, extra: { reason?: string; round?: number; remaining?: string } = {}): void {
    this.write({ type: "event", turn: this.turn, kind, ...extra });
  }
  /** The turn ended. Only the first call writes (a late result of a stopped, replaced or closed attempt finds it ended). */
  end(status: RecordTurnStatus, fields: TurnEndFields = {}): boolean {
    if (this.ended) return false;
    this.ended = true;
    const partial = this.answer.streaming ? this.answer.text : "";
    const steers = this.steerTexts();
    this.write({
      type: "turn_end",
      turn: this.turn,
      status,
      ...(fields.reason ? { reason: fields.reason } : {}),
      raw: this.raw,
      reply: fields.reply ?? partial,
      lines: plainLines(fields.lines ?? this.answer.lines),
      modelLabel: this.answer.modelLabel ?? "",
      ...(fields.rejected?.length ? { rejected: fields.rejected } : {}),
      ...(steers.length ? { steers } : {}),
      ...(fields.error ? { error: fields.error } : {})
    });
    return true;
  }
  /** What became of the plan card of this turn. */
  plan(state: "applied" | "cancelled" | "stopped", lines: MapChatLine[] = []): void {
    this.write({ type: "plan", turn: this.turn, state, lines: plainLines(lines) });
  }
  /**
   * The result lines of the turn changed after its end (an expansion that failed): the answer's lines as they are now. Before the
   * end nothing is written: a `lines` line ahead of `turn_end` would make a restore show those partial lines for the whole turn.
   */
  relines(): void {
    if (!this.ended) return;
    this.write({ type: "lines", turn: this.turn, lines: plainLines(this.answer.lines) });
  }
  /**
   * The pictures this turn put into its cards (the failure reasons are in the result lines). One line for the whole turn, the
   * newest wins: each item is "card: picture title", and every item was inserted. The state is `ready` when any picture was
   * put in, else `stopped` when every search was stopped, else `failed` / `empty`.
   */
  images(block: MapChatImages): void {
    const blocks = this.answer.images?.includes(block) ? this.answer.images : [block];
    const placed = blocks.flatMap(entry => {
      const item = placedImage(entry);
      return item
        ? [{ title: `${entry.nodeTitle}: ${item.candidate.title}`, sourceUrl: item.candidate.source ?? "" }]
        : [];
    });
    const ended = blocks.filter(entry => entry.state !== "searching");
    const state = placed.length
      ? "ready"
      : ended.every(entry => entry.state === "stopped")
        ? "stopped"
        : ended.some(entry => entry.state === "failed")
          ? "failed"
          : "empty";
    this.write({
      type: "images",
      turn: this.turn,
      state,
      items: placed,
      inserted: placed.map((_, index) => index)
    });
  }
}
