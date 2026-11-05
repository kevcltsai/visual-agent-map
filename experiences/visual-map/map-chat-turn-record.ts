import type { RecordEventKind, RecordLineInput, RecordTurnStatus } from "../../core/map-chat-records";
import type { MapChatImages, MapChatLine, MapChatMessage } from "./map-chat";
import { settledLine } from "./map-chat";
import type { MapChatRecordWriter } from "./map-chat-record-writer";

/** What a turn's end line carries besides its status. Anything left out is read from the turn's answer message. */
export interface TurnEndFields {
  reason?: string;
  reply?: string;
  lines?: MapChatLine[];
  rejected?: unknown[];
  error?: { text: string; technical: string };
}

const plainLines = (lines: MapChatLine[]): { status: string; text: string }[] =>
  lines.map(line => {
    const settled = settledLine(line);
    return { status: settled.status, text: settled.text };
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
  event(kind: RecordEventKind): void {
    this.write({ type: "event", turn: this.turn, kind });
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
  /** The state of a picture search of this turn (`extraInserted`: the candidate being inserted right now). */
  images(block: MapChatImages, extraInserted?: unknown): void {
    this.write({
      type: "images",
      turn: this.turn,
      state: block.state,
      items: block.items.map(item => ({ title: item.candidate.title, sourceUrl: item.candidate.source ?? "" })),
      inserted: block.items.flatMap((item, index) => (item.inserted || item === extraInserted ? [index] : []))
    });
  }
}
