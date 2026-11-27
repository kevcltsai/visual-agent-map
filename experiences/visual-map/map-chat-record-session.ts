import {
  isRecordFilePath,
  pickLatest,
  recordsDir,
  restoreConversation,
  type RecordLine,
  type RecordOriginChip,
  type RecordTurnStatus
} from "../../core/map-chat-records";
import type { MapChatRequest } from "../../core/map-chat-service";
import { mapChatStep } from "../../core/steps/map-chat/step";
import type {
  MapChatImages,
  MapChatMessage,
  MapChatOrigin,
  MapChatPanel,
  MapChatPlanCard,
  MapChatTurnHandle
} from "./map-chat";
import { settledLine } from "./map-chat";
import type { MapChatRecordTarget, MapChatRecordWriter } from "./map-chat-record-writer";
import { MapChatTurnRecord, type TurnEndFields } from "./map-chat-turn-record";

/** What the session needs from the view; it never reaches for the plugin or the vault itself. */
export interface MapChatRecordSessionPorts {
  /** The settings switch "save map AI conversations" is on. */
  enabled(): boolean;
  /** The view is closed. */
  closed(): boolean;
  /** Makes the view's writer (failure notice, log and plugin version are the view's business). */
  createWriter(): MapChatRecordWriter;
  /** Registers the writer so the settings switch reaches it; returns the unregister. */
  register(writer: MapChatRecordWriter): () => void;
  /** The plugin is unloading. */
  disposed(): boolean;
  target(): MapChatRecordTarget;
  log(message: string): void;
  files: {
    exists(p: string): Promise<boolean>;
    list(d: string): Promise<{ files: string[] }>;
    read(p: string): Promise<string>;
  };
  configDir: string;
}

/**
 * The conversation record of one map chat view: its writer (made at the first use while the switch is on), the turn numbers, which
 * finished answers are in the record, the newest turn's record and the epoch that drops a restore the conversation moved past.
 * What the view keeps: the trust flags and their `markXRecorded` marks, the panel, and the order of its own steps around these calls.
 */
export class MapChatRecordSession {
  /** This view's writer; null until the first use while the switch is on. */
  writer: MapChatRecordWriter | null = null;
  /** The record of the newest turn (running or finished): plan results, picture candidates and undo / redo of it go to its conversation. */
  last: MapChatTurnRecord | null = null;
  readonly plans = new WeakMap<MapChatPlanCard, MapChatTurnRecord>();
  readonly images = new WeakMap<MapChatImages, MapChatTurnRecord>();
  private unregister: (() => void) | null = null;
  /** The highest turn number used in the conversation's record. */
  private turnSeq = 0;
  /** Finished answers that are in the record (written, restored or backfilled). */
  private logged = new WeakSet<MapChatMessage>();
  /** Counts the times the conversation left its map or began anew: a restore that read the files meanwhile is dropped. */
  private epochCount = 0;

  constructor(private readonly ports: MapChatRecordSessionPorts) {}

  get epoch(): number {
    return this.epochCount;
  }

  /** This view's writer, made at the first use while the switch is on (and registered, so the switch reaches it); null while it is off. */
  ensure(): MapChatRecordWriter | null {
    if (!this.ports.enabled() || this.ports.closed()) return null;
    if (!this.writer) {
      const writer = this.ports.createWriter();
      writer.setTarget(this.ports.target());
      this.writer = writer;
      this.unregister = this.ports.register(writer);
    }
    return this.writer;
  }

  /**
   * The request went out: writes the turn's start (and, for a conversation that began while the switch was off, its finished
   * turns first). The writer must exist (`ensure`); a write that throws is the caller's to catch.
   */
  begin(
    chat: Pick<MapChatPanel, "completedTurns" | "conversationId">,
    turn: MapChatTurnHandle,
    request: MapChatRequest,
    origin: MapChatOrigin,
    autoApply: boolean
  ): MapChatTurnRecord {
    const writer = this.writer;
    if (!writer) throw new Error("Map chat record: no writer");
    writer.setTarget(this.ports.target());
    const missing = chat.completedTurns().filter(item => !this.logged.has(item.answer));
    if (missing.length) {
      writer.backfill(
        missing.map(item => ({
          turn: ++this.turnSeq,
          message: item.question.text,
          reply: item.answer.text,
          lines: item.answer.lines.map(line => ({ status: settledLine(line).status, text: settledLine(line).text })),
          modelLabel: item.answer.modelLabel ?? "",
          steers: (item.question.steers ?? []).filter(steer => steer.state === "live").map(steer => steer.text)
        }))
      );
      for (const item of missing) this.logged.add(item.answer);
    }
    chat.conversationId = writer.conversationId;
    const number = ++this.turnSeq;
    const record = new MapChatTurnRecord(writer, writer.conversationId, number, turn.assistant, message =>
      this.ports.log(message)
    );
    const chips: RecordOriginChip[] = origin.chips.map(chip =>
      chip.kind === "topic"
        ? { kind: chip.kind, id: chip.id }
        : chip.kind === "snippet"
          ? { kind: chip.kind, path: chip.path, text: chip.text }
          : { kind: chip.kind, path: chip.path }
    );
    // The rendered prompt is not stored (step id and version rebuild it); the model is only its id.
    record.write({
      type: "turn_start",
      turn: number,
      message: origin.text,
      ...(autoApply ? { autoApply: true as const } : {}),
      ...(origin.chain
        ? {
            auto: true as const,
            round: origin.chain.state.round,
            ...(origin.chain.resumed ? { resumed: true as const } : {}),
            ...(origin.chain.continuation.remaining.trim() ? { remaining: origin.chain.continuation.remaining } : {})
          }
        : {}),
      origin: { chips, selectedIds: [...origin.selectedIds] },
      request: {
        step: { id: mapChatStep.id, version: mapChatStep.version },
        model: request.model,
        reasoning: request.reasoning,
        language: request.language,
        contentLanguage: request.contentLanguage,
        message: request.message,
        context: request.context
      }
    });
    this.last = record;
    return record;
  }

  /** The answer is in the record. */
  markLogged(answer: MapChatMessage): void {
    this.logged.add(answer);
  }
  isLogged(answer: MapChatMessage): boolean {
    return this.logged.has(answer);
  }

  /** Ends the running turn's record (a no-op when there is none or it already ended). */
  end(status: RecordTurnStatus, fields?: TurnEndFields): void {
    const record = this.last;
    // Whatever the status, the turn's answer is in the record now: a stopped turn that left text must not be written again
    // as a backfilled one by the next send, and closing the view loses nothing of it.
    if (record?.isOpen && record.end(status, fields)) this.logged.add(record.answer);
  }

  /** Closing the view loses nothing: the switch is on, no write failed, and the record has every finished turn (no chat: nothing to lose). */
  saved(turns: readonly { answer: MapChatMessage }[] | undefined): boolean {
    const writer = this.writer;
    if (!writer || !this.ports.enabled() || writer.unsaved) return false;
    return turns?.every(turn => this.logged.has(turn.answer)) ?? true;
  }

  /** The view closes: the writer takes no new line (what is queued still runs), or none at all once the plugin is unloading. */
  close(): void {
    const writer = this.writer;
    if (!writer) return;
    this.unregister?.();
    this.unregister = null;
    if (this.ports.disposed()) writer.dispose();
    else writer.close();
  }

  /** The conversation left its map, or began anew: a new record conversation (the epoch drops a restore still reading). */
  restart(): void {
    this.epochCount++;
    this.turnSeq = 0;
    this.last = null;
    const writer = this.writer;
    if (!writer) return;
    writer.newConversation();
    writer.setTarget(this.ports.target());
  }

  /** Every record file of the map's folder, read through the adapter (the Vault index may not list a .jsonl). Read only. */
  async readAll(root: string): Promise<{ id: string; path: string; text: string }[]> {
    const adapter = this.ports.files;
    const dir = recordsDir(root, this.ports.configDir);
    if (!(await adapter.exists(dir))) return [];
    const files: { id: string; path: string; text: string }[] = [];
    for (const path of (await adapter.list(dir)).files) {
      if (!isRecordFilePath(path) || path.slice(0, path.lastIndexOf("/")) !== dir) continue;
      files.push({
        id: path.slice(path.lastIndexOf("/") + 1, -".jsonl".length),
        path,
        text: await adapter.read(path)
      });
    }
    return files;
  }

  /** The latest record file of the map's folder, read through the adapter (the Vault index may not list a .jsonl). */
  async readLatest(root: string): Promise<ReturnType<typeof pickLatest>> {
    return pickLatest(await this.readAll(root));
  }

  /**
   * The writer's part of a restore: later lines go on in the restored file, and every turn number of it is taken (a late result of
   * one of them can never be written again). `file` is the vault file when the index lists it, else its path.
   */
  /** The chief editor said the opening of a plan (`key` names the plan): kept after the turns there were, so a restore puts it back there. */
  openingSaid(key: string, text: string): void {
    const writer = this.ensure();
    if (!writer) return;
    writer.setTarget(this.ports.target());
    writer.write({ type: "event", turn: this.turnSeq, kind: "editor_opening", key, text });
  }
  resume(
    latest: NonNullable<ReturnType<typeof pickLatest>>,
    restored: ReturnType<typeof restoreConversation>,
    file: Parameters<MapChatRecordWriter["resume"]>[1]
  ): void {
    const writer = this.writer;
    if (!writer) return;
    writer.resume(
      latest.id,
      file,
      this.ports.target(),
      latest.parsed.cleanEnd,
      restored.startedResearch,
      restored.readsSources
    );
    const numbers = latest.parsed.lines.flatMap((line: RecordLine) =>
      "turn" in line && typeof line.turn === "number" ? [line.turn] : []
    );
    writer.markEnded(numbers);
    this.turnSeq = Math.max(0, ...numbers);
  }
}
