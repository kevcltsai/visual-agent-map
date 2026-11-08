import type { App, TAbstractFile, TFile } from "obsidian";
import { assertRecordRoot } from "../../core/map-chat-records";
import {
  parseTopicChat,
  isSafeTopicNodeId,
  serializeTopicChatLine,
  topicChatDir,
  topicChatPath,
  type ParsedTopicChat,
  type TopicChatLineInput
} from "../../core/topic-chat-records";

export interface TopicChatRecordWriterDeps {
  app: Pick<App, "vault">;
  log: (level: "error" | "info", message: string) => void;
  /** The plugin or repository is gone: nothing may be written, queued work included. */
  disposed: () => boolean;
  /** Called at most once per writer, when a write failed twice (the view shows the Notice `ui.topic_chat_record_failed`). */
  onFailure: () => void;
  configDir?: string;
  now?: () => Date;
}

const isFile = (item: TAbstractFile | null | undefined): item is TFile => !!item && !("children" in item);
const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * One writer per map view; writes the topic chat records with the Vault API only (never the plugin's map transaction).
 * Fire-and-forget: `write` returns at once, the work runs on the writer's own chain, a failure never throws into the chat.
 * `close()` (view closed): no new lines, queued ones still run. `dispose()` (plugin unload): nothing more is written.
 * A topic whose node id is not a safe file name, or whose map has no managed folder (`root` null), writes nothing.
 */
export class TopicChatRecordWriter {
  private closed = false;
  private killed = false;
  private notified = false;
  private chain: Promise<void> = Promise.resolve();
  /** Per file: what the first look found (`blocked`: another schema version; `cleanEnd`: no break needed before the next line). */
  private readonly known = new Map<string, { blocked: boolean; cleanEnd: boolean }>();

  constructor(private readonly deps: TopicChatRecordWriterDeps) {}

  /** A write failed and was reported. */
  get failed(): boolean {
    return this.notified;
  }

  /** Reads one topic's record (null: no file, an unsafe id or root, or the read failed). */
  async read(root: string | null, nodeId: string): Promise<ParsedTopicChat | null> {
    if (!root || !isSafeTopicNodeId(nodeId) || this.dead()) return null;
    try {
      const path = topicChatPath(root, nodeId, this.deps.configDir);
      const text = await this.readText(path);
      if (text === null) return null;
      const parsed = parseTopicChat(text);
      this.known.set(path, { blocked: parsed.unrecoverable, cleanEnd: parsed.cleanEnd });
      return parsed;
    } catch (error) {
      this.deps.log("error", `Topic chat record read: ${errorText(error)}`);
      return null;
    }
  }

  /** Takes one line. Dropped when closed or disposed, for an unsafe id, or without a managed folder. */
  write(root: string | null, nodeId: string, line: TopicChatLineInput): void {
    if (this.dead() || this.closed || !root || !isSafeTopicNodeId(nodeId)) return;
    let path: string;
    try {
      path = topicChatPath(root, nodeId, this.deps.configDir);
    } catch {
      return;
    }
    const text = serializeTopicChatLine(line);
    void this.enqueue(() => this.append(root, path, text));
  }

  /** Resolves when everything queued so far has run. */
  async idle(): Promise<void> {
    let seen: Promise<void>;
    do {
      seen = this.chain;
      await seen;
    } while (seen !== this.chain);
  }
  close(): void {
    this.closed = true;
  }
  dispose(): void {
    this.killed = true;
    this.closed = true;
  }

  private dead(): boolean {
    return this.killed || this.deps.disposed();
  }
  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.chain.then(() => (this.dead() ? undefined : task()));
    const safe = run.catch((error: unknown) => this.fail(error));
    this.chain = safe;
    return safe;
  }
  private fail(error: unknown): void {
    this.deps.log("error", `Topic chat record write failed: ${errorText(error)}`);
    if (this.notified) return;
    this.notified = true;
    try {
      this.deps.onFailure();
    } catch (callbackError) {
      this.deps.log("error", `Topic chat record notice failed: ${errorText(callbackError)}`);
    }
  }

  /** The file's text: through the Vault, then (a file type the Vault index does not list) through the adapter. */
  private async readText(path: string): Promise<string | null> {
    const vault = this.deps.app.vault;
    const file = vault.getAbstractFileByPath(path);
    if (isFile(file)) return vault.read(file);
    if (await vault.adapter.exists(path)) return vault.adapter.read(path);
    return null;
  }

  private async append(root: string, path: string, text: string): Promise<void> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.appendOnce(root, path, text);
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  private async appendOnce(root: string, path: string, text: string): Promise<void> {
    const vault = this.deps.app.vault;
    let state = this.known.get(path);
    if (!state) {
      const existing = await this.readText(path);
      if (existing !== null) {
        const parsed = parseTopicChat(existing);
        state = { blocked: parsed.unrecoverable, cleanEnd: parsed.cleanEnd };
      } else state = { blocked: false, cleanEnd: true };
      this.known.set(path, state);
    }
    // Another schema version: not read, not overwritten, not appended to.
    if (state.blocked || this.dead()) return;
    const body = state.cleanEnd ? text : `\n${text}`;
    const file = vault.getAbstractFileByPath(path);
    if (isFile(file)) await vault.append(file, body);
    else if (await vault.adapter.exists(path)) await vault.adapter.append(path, body);
    else {
      await this.ensureFolders(root);
      if (this.dead()) return;
      await vault.create(path, text);
    }
    state.cleanEnd = true;
  }

  private async ensureFolders(root: string): Promise<void> {
    const configDir = this.deps.configDir;
    const vault = this.deps.app.vault;
    for (const folder of [`${assertRecordRoot(root, configDir)}/Chats`, topicChatDir(root, configDir)]) {
      if (vault.getAbstractFileByPath(folder)) continue;
      try {
        await vault.createFolder(folder);
      } catch (error) {
        if (!vault.getAbstractFileByPath(folder)) throw error;
      }
    }
  }
}
