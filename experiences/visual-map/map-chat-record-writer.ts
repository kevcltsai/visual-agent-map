import type { App, TAbstractFile, TFile } from "obsidian";
import {
  assertRecordRoot,
  newRecordId,
  recordPath,
  recordsDir,
  serializeLine,
  type RecordLineInput
} from "../../core/map-chat-records";

/** Where a conversation is written: a managed topic root (`null` for a map that cannot be edited) and the map's identity. */
export interface MapChatRecordTarget {
  root: string | null;
  mapPath: string;
  mapId: string;
}
export interface MapChatRecordWriterDeps {
  app: Pick<App, "vault" | "fileManager">;
  /** `plugin.logs.appendLog`. */
  log: (level: "error" | "info", message: string) => void;
  /** The plugin or repository is gone: nothing may be written, queued work included. */
  disposed: () => boolean;
  /** Called at most once per conversation, when a write failed twice (the view shows the Notice `ui.map_chat_record_failed`). */
  onFailure: () => void;
  pluginVersion: string;
  /** The Vault's config folder name (a root with a part named like it is refused (any dot-folder is refused anyway). */
  configDir?: string;
  now?: () => Date;
  random?: () => number;
}

interface Conversation {
  id: string;
  startedAt: string;
  file: TFile | null;
  /** The record's path when the Vault does not list it (a file type Obsidian is not set to detect): it is written through the adapter. */
  adapterPath: string | null;
  /** The root the file lives in (set once it has landed). */
  root: string | null;
  mapPath: string;
  mapId: string;
  /** Serialized lines not yet in the file (an unmanaged map, or a write that failed). */
  pending: string[];
  /** Lines were taken while no managed folder existed: the conversation is not on disk yet. */
  held: boolean;
  failed: boolean;
  notified: boolean;
  /** Turns whose `turn_end` is queued: later turn_start / turn_end of that turn are dropped. */
  ended: Set<number>;
  /** The serialized `research_started` line of this conversation (null before research): a file made again starts with it. */
  researchLine: string | null;
}

const isFile = (item: TAbstractFile | null | undefined): item is TFile => !!item && !("children" in item);

/**
 * One writer per map view. It writes the conversation record with the Vault API only (never the plugin's map transaction: it synchronizes
 * every view, and `chatSwitchTo` already runs inside it). Fire-and-forget: every method returns at once, the work runs on the
 * writer's own chain, and a failure never throws into the chat.
 *
 * - `write` takes a line. Nothing is created until the first line; an unmanaged map keeps its lines in memory until `moveTo`.
 * - `close()` (view closed): no new lines, the queued ones still run. `dispose()` (plugin unload): nothing more is written, queued work included.
 * - `setEnabled(false)`: no new lines, the queued ones still run; `idle()` resolves when the chain is empty (to delete after it).
 */
export class MapChatRecordWriter {
  private conv: Conversation;
  private target: MapChatRecordTarget | null = null;
  private enabled = true;
  private closed = false;
  private killed = false;
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly deps: MapChatRecordWriterDeps) {
    this.conv = this.freshConversation();
  }

  /** The current conversation's id (its file name). */
  get conversationId(): string {
    return this.conv.id;
  }
  /** The conversation's file exists. */
  get landed(): boolean {
    return !!this.conv.file || !!this.conv.adapterPath;
  }
  /** A write of this conversation failed (and was reported): the chat counts as not saved. */
  get failed(): boolean {
    return this.conv.failed;
  }
  /** The conversation holds lines that only exist in memory, or its writes failed: closing the view should still warn. */
  get unsaved(): boolean {
    return this.conv.failed || this.conv.held;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
  }
  /** Where new lines go. A landed conversation keeps its file; use {@link moveTo} to move it. */
  setTarget(target: MapChatRecordTarget | null): void {
    this.target = target;
  }
  /** Starts a new conversation (new id, new file at the next line). Work queued for the previous one still goes to the previous file. */
  newConversation(): void {
    this.conv = this.freshConversation();
  }
  /**
   * Continues an existing record (restored on open): later lines are appended to `file`, or, given its path, through the adapter
   * (a record the Vault index does not list). `cleanEnd` is `parseRecord(text).cleanEnd`. `startedResearch` is the restored
   * conversation's `startedResearch`: the file already has the mark, and a file made again must keep it.
   */
  resume(
    id: string,
    file: TFile | string,
    target: MapChatRecordTarget,
    cleanEnd = true,
    startedResearch = false
  ): void {
    this.conv = {
      ...this.freshConversation(id),
      file: typeof file === "string" ? null : file,
      adapterPath: typeof file === "string" ? file : null,
      root: target.root,
      mapPath: target.mapPath,
      mapId: target.mapId,
      // A cut last line gets a line break first, so the next line is not glued to it.
      pending: cleanEnd ? [] : ["\n"],
      ended: new Set(),
      researchLine: startedResearch
        ? serializeLine({ type: "event", turn: 0, kind: "research_started", at: this.stamp() })
        : null
    };
    this.target = target;
  }
  /** Marks turns as already in the record, so a late line for them is dropped (restored turns). */
  markEnded(turns: number[]): void {
    for (const turn of turns) this.conv.ended.add(turn);
  }

  /** Takes one line. Dropped when closed, disposed or off, or when its turn already ended (the turn fence). */
  write(line: RecordLineInput): void {
    if (this.dead() || this.closed || !this.enabled) return;
    const conv = this.conv;
    if (line.type === "turn_start" || line.type === "turn_end") {
      if (conv.ended.has(line.turn)) return;
      if (line.type === "turn_end") conv.ended.add(line.turn);
    }
    const text = serializeLine({ ...line, at: line.at ?? this.stamp() });
    // The target is read now, not when the task runs: a moveTo queued behind this line must not pull it into the new root.
    const target = this.target;
    if (!conv.file && !target?.root) conv.held = true;
    void this.enqueue(async () => {
      conv.pending.push(text);
      // Remembered when it is queued, not when it is taken: an earlier line's file creation must not write it ahead of its turn.
      if (line.type === "event" && line.kind === "research_started") conv.researchLine = text;
      await this.flush(conv, target);
    });
  }

  /**
   * The conversation was started with the switch off: writes its finished turns as `turn_start` (`backfilled:true`) plus
   * `turn_end`, with the visible text only. Turn numbers must not repeat.
   */
  backfill(
    turns: {
      turn: number;
      at?: string;
      message: string;
      reply: string;
      lines: { status: string; text: string }[];
      modelLabel: string;
      /** The follow-up messages that went into this turn (live ones only). */
      steers?: string[];
    }[]
  ): void {
    for (const item of turns) {
      this.write({ type: "turn_start", turn: item.turn, at: item.at, message: item.message, backfilled: true });
      this.write({
        type: "turn_end",
        turn: item.turn,
        at: item.at,
        status: "done",
        raw: null,
        reply: item.reply,
        lines: item.lines,
        modelLabel: item.modelLabel,
        ...(item.steers?.length ? { steers: item.steers } : {})
      });
    }
  }

  /**
   * The conversation's map changed (create_map / open_map). Waits for the lines queued before it, then moves the file to
   * `<newRoot>/Chats/records` (`vault.rename`) and writes a `moved` line; a conversation with no file yet lands in the new
   * root. A failure leaves the file where it was and takes the failure path. Resolves true when the file is in the new place.
   */
  moveTo(target: MapChatRecordTarget): Promise<boolean> {
    const conv = this.conv;
    this.target = target;
    return this.enqueue(async () => {
      if (!target.root) return false;
      if (!conv.file && !conv.adapterPath) {
        conv.mapPath = target.mapPath;
        conv.mapId = target.mapId;
        await this.flush(conv, target);
        return !!conv.file;
      }
      if (conv.root === target.root) return true;
      const from = conv.mapPath;
      if (!(await this.relocate(conv, target.root))) return false;
      conv.mapPath = target.mapPath;
      conv.mapId = target.mapId;
      if (this.dead()) return true;
      conv.pending.push(serializeLine({ type: "moved", at: this.stamp(), from, to: target.mapPath }));
      await this.flush(conv, target);
      return true;
    }, false);
  }

  /** Resolves when everything queued so far has run (also when more was queued meanwhile). */
  async idle(): Promise<void> {
    let seen: Promise<void>;
    do {
      seen = this.chain;
      await seen;
    } while (seen !== this.chain);
  }
  /** The view closed: no new lines; queued ones still run. */
  close(): void {
    this.closed = true;
  }
  /** Plugin unload: nothing more is written, queued work included. */
  dispose(): void {
    this.killed = true;
    this.closed = true;
  }

  // ---- internals ----

  private freshConversation(id?: string): Conversation {
    const now = this.deps.now?.() ?? new Date();
    return {
      id: id ?? newRecordId(now, this.deps.random),
      startedAt: now.toISOString(),
      file: null,
      adapterPath: null,
      root: null,
      mapPath: this.target?.mapPath ?? "",
      mapId: this.target?.mapId ?? "",
      pending: [],
      held: false,
      failed: false,
      notified: false,
      ended: new Set(),
      researchLine: null
    };
  }
  private dead(): boolean {
    return this.killed || this.deps.disposed();
  }
  private stamp(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }
  private enqueue<T>(task: () => Promise<T>, fallback?: T): Promise<T> {
    const run = this.chain.then(() => (this.dead() ? (fallback as T) : task()));
    const safe = run.catch((error: unknown) => {
      this.deps.log("error", `Map chat record: ${errorText(error)}`);
      return fallback as T;
    });
    this.chain = safe.then(() => undefined);
    return safe;
  }

  /** Writes the pending lines (creating the file, with its `conversation` line, when there is none). Retries once; then reports. */
  private async flush(conv: Conversation, target: MapChatRecordTarget | null): Promise<void> {
    if (this.dead() || !conv.pending.length) return;
    const root = conv.root ?? target?.root ?? null;
    if (!root) return;
    let failure: unknown = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.writePending(conv, root, target, attempt > 0);
        failure = null;
        break;
      } catch (error) {
        failure = error;
      }
    }
    if (failure) this.fail(conv, failure);
    else if (!this.dead() && !conv.pending.length) conv.failed = false;
  }

  private async writePending(
    conv: Conversation,
    root: string,
    target: MapChatRecordTarget | null,
    retry: boolean
  ): Promise<void> {
    const configDir = this.deps.configDir;
    const vault = this.deps.app.vault;
    if (!conv.file && conv.adapterPath) {
      if (this.dead()) return;
      const count = conv.pending.length;
      await vault.adapter.append(conv.adapterPath, conv.pending.slice(0, count).join(""));
      conv.pending.splice(0, count);
      conv.held = false;
      return;
    }
    // The file was deleted or moved away while this writer held its handle: Vault.append would write the path again as a new
    // file with no header, so the file is looked up again and, when it is gone, made again with the conversation header.
    if (conv.file && (retry || !isFile(vault.getAbstractFileByPath(conv.file.path))))
      conv.file = this.resolve(conv, configDir);
    if (!conv.file) {
      const path = recordPath(root, conv.id, configDir);
      const existing = vault.getAbstractFileByPath(path);
      if (isFile(existing)) conv.file = existing;
      else {
        await this.ensureFolders(root);
        if (this.dead()) return;
        const header = serializeLine({
          type: "conversation",
          id: conv.id,
          startedAt: conv.startedAt,
          mapPath: target?.mapPath ?? conv.mapPath,
          mapId: target?.mapId ?? conv.mapId,
          pluginVersion: this.deps.pluginVersion
        });
        conv.mapPath = target?.mapPath ?? conv.mapPath;
        conv.mapId = target?.mapId ?? conv.mapId;
        // The mark is the writer's to keep: a file made again (deleted while open) must still say the conversation started research.
        const lines = conv.researchLine && !conv.pending.includes(conv.researchLine) ? [conv.researchLine] : [];
        conv.file = await vault.create(path, header + lines.join("") + conv.pending.join(""));
        conv.root = root;
        conv.pending = [];
        conv.held = false;
        return;
      }
      conv.root = root;
    }
    if (this.dead()) return;
    const count = conv.pending.length;
    await vault.append(conv.file, conv.pending.slice(0, count).join(""));
    conv.pending.splice(0, count);
    conv.held = false;
  }

  /** The conversation's file as the Vault knows it now: by the handle's own path, then by the path this writer made. */
  private resolve(conv: Conversation, configDir?: string): TFile | null {
    const vault = this.deps.app.vault;
    if (conv.file) {
      const byHandle = vault.getAbstractFileByPath(conv.file.path);
      if (isFile(byHandle)) return byHandle;
    }
    if (conv.root) {
      const byPath = vault.getAbstractFileByPath(recordPath(conv.root, conv.id, configDir));
      if (isFile(byPath)) return byPath;
    }
    return null;
  }

  private async ensureFolders(root: string): Promise<void> {
    const configDir = this.deps.configDir;
    const vault = this.deps.app.vault;
    const dir = recordsDir(root, configDir);
    for (const folder of [`${assertRecordRoot(root, configDir)}/Chats`, dir]) {
      if (vault.getAbstractFileByPath(folder)) continue;
      try {
        await vault.createFolder(folder);
      } catch (error) {
        if (!vault.getAbstractFileByPath(folder)) throw error;
      }
    }
  }

  private async relocate(conv: Conversation, root: string): Promise<boolean> {
    const configDir = this.deps.configDir;
    const vault = this.deps.app.vault;
    let failure: unknown = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (attempt > 0) conv.file = this.resolve(conv, configDir) ?? conv.file;
        const dest = recordPath(root, conv.id, configDir);
        const here = conv.file?.path ?? conv.adapterPath;
        if (here === dest) {
          conv.root = root;
          return true;
        }
        await this.ensureFolders(root);
        if (this.dead() || !here) return false;
        if (vault.getAbstractFileByPath(dest) || (!conv.file && (await vault.adapter.exists(dest))))
          throw new Error(`Record already exists: ${dest}`);
        if (conv.file) await vault.rename(conv.file, dest);
        else {
          await vault.adapter.rename(here, dest);
          conv.adapterPath = dest;
        }
        conv.root = root;
        return true;
      } catch (error) {
        failure = error;
      }
    }
    this.fail(conv, failure);
    return false;
  }

  private fail(conv: Conversation, error: unknown): void {
    conv.failed = true;
    if (conv.notified) return;
    conv.notified = true;
    this.deps.log("error", `Map chat record write failed: ${errorText(error)}`);
    try {
      this.deps.onFailure();
    } catch (callbackError) {
      this.deps.log("error", `Map chat record notice failed: ${errorText(callbackError)}`);
    }
  }
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));
