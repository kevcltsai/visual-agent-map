// The file ledger of one map-chat conversation: which Markdown files it wrote, which the user dragged in, which of them it may read back,
// and which the record already marks. In-process; it reads only through one port and writes nothing (the caller writes the record marks).
import { contentHash, MAP_CHAT_FILE_CHAR_LIMIT } from "./map-chat-context";
import { normalizeVaultPath } from "./map-chat-guard";

export interface MapChatFilesPorts {
  /** A vault note's text as it is right now (an open note is read from its editor, which may hold unsaved typing); null when it does not exist. */
  read(key: string): Promise<{ path: string; text: string } | null>;
  /** This map's folder, normalized (read again each time: the map may move). */
  mapFolder(): string | null;
}
export type MapChatFileMark = { kind: "file_written" | "file_attached"; path: string; hash: string };

export class MapChatFiles {
  /** Markdown files this conversation created or edited -> the content hash of each version it wrote. Only the program writes it. */
  private ownFiles = new Map<string, Set<string>>();
  /** Markdown files the user dragged into this conversation -> the content hash each held then. Readable (and, inside the map folder, editable) only while the file still holds one of these or a version the chat wrote after. */
  private attached = new Map<string, Set<string>>();
  /** Order of the writes to {@link ownFiles}: a counter per write and the reply (apply call) it belonged to; restored paths are round 0. */
  private ownOrder = new Map<string, { seq: number; round: number }>();
  private writeSeq = 0;
  private applyRound = 0;
  /** Own files the chat asked to read with `read_md_file`; the next context carries them first and empties this. */
  private readQueue: string[] = [];
  /** `path\0hash` of the reads the last context carried: the same version asked again right after is refused (no read loop). */
  private lastReads = new Set<string>();
  /** The record conversation whose file already holds a `file_written` line for each of these "path\0hash" pairs. */
  private recorded: { id: string | null; keys: Set<string> } = { id: null, keys: new Set() };

  constructor(private readonly ports: MapChatFilesPorts) {}

  /**
   * A write of this conversation's own: a created file always counts; an edit counts only for a file already its own (an attached
   * or open note the chat edits does not become the chat's). Only the program calls this, with what it just wrote. True when the write was taken (the caller then writes the record marks).
   */
  noteWrite(path: string, text: string, created: boolean): boolean {
    const key = normalizeVaultPath(path);
    if (key === null) return false;
    // An attached file the chat edits inside the map folder becomes one of its own versions (carried like the rest).
    if (!created && !this.ownFiles.has(key) && !(this.attached.has(key) && this.insideMapFolder(key))) return false;
    const hashes = this.ownFiles.get(key) ?? new Set<string>();
    hashes.add(contentHash(text));
    this.ownFiles.set(key, hashes);
    this.ownOrder.set(key, { seq: ++this.writeSeq, round: this.applyRound });
    return true;
  }

  /** A Markdown file the user dragged in: this version becomes the baseline the chat may read (and edit inside the map folder) while the file holds it. Only the program calls this, with text it just read. */
  noteAttached(path: string, text: string): boolean {
    const key = normalizeVaultPath(path);
    if (key === null || !key.toLowerCase().endsWith(".md") || key.split("/").some(part => part.startsWith(".")))
      return false;
    const hashes = this.attached.get(key) ?? new Set<string>();
    hashes.add(contentHash(text));
    this.attached.set(key, hashes);
    return true;
  }

  /** A reply (apply call) of the chat begins: the files it writes belong to this round. */
  startRound(): void {
    this.applyRound += 1;
  }

  isAttached(key: string): boolean {
    return this.attached.has(key);
  }

  /** The paths the chat may name in `read_md_file` (own and attached). */
  readablePaths(): string[] {
    return [...this.ownFiles.keys(), ...this.attached.keys()];
  }

  /** True when the file holds a version the chat wrote or the user attached (the test a read uses). */
  async readableNow(key: string): Promise<boolean> {
    const hashes = this.readableHashes(key);
    const source = hashes ? await this.ports.read(key) : null;
    return !!source && !!hashes && hashes.has(contentHash(source.text));
  }

  /**
   * A `read_md_file` of the chat: accepted only for a file this conversation wrote that is in this map's folder (or one the user
   * attached) and still holds one of the versions known (the same rule as {@link carry}). The next context carries it; nothing is shown for it.
   */
  async acceptRead(path: string): Promise<{ path: string; chars: number } | null> {
    const key = normalizeVaultPath(path);
    const hashes = key === null ? undefined : this.readableHashes(key);
    if (key === null || !hashes) return null;
    const source = await this.ports.read(key);
    if (!source || !hashes.has(contentHash(source.text))) return null;
    // A file that can never be sent whole, or the version the last context already carried, is not a read: the chain must not
    // go round asking for it again.
    if (source.text.length > MAP_CHAT_FILE_CHAR_LIMIT || this.lastReads.has(`${key}\0${contentHash(source.text)}`))
      return null;
    if (!this.readQueue.includes(key)) this.readQueue.push(key);
    return { path: key, chars: source.text.length };
  }

  /**
   * The files this conversation wrote that still hold exactly one of the versions it wrote, in the order the context spends its budget
   * on them: the ones the chat asked to read (`requested`, taken from the queue, which this empties), then a 進度 file and the files of
   * the latest reply, then the rest, each group newest write first. `skip` are sent another way.
   */
  async carry(skip: Set<string>): Promise<{ path: string; content: string; requested?: true }[]> {
    const found: { path: string; content: string; seq: number; round: number }[] = [];
    // Only this map's own folder: a file the conversation wrote elsewhere (another folder it was allowed to write to) is not read back.
    const queue = this.readQueue.splice(0);
    // Attached files are carried the same way, from any folder (the hash rule is the same).
    for (const path of new Set([...this.ownFiles.keys(), ...this.attached.keys()])) {
      const hashes = this.readableHashes(path);
      if (skip.has(path) || !hashes) continue;
      const source = await this.ports.read(path);
      if (source && hashes.has(contentHash(source.text)))
        found.push({
          path: source.path,
          content: source.text,
          ...(this.ownOrder.get(path) ?? { seq: 0, round: 0 })
        });
    }
    const latest = Math.max(0, ...[...this.ownOrder.values()].map(item => item.round));
    const first = (file: { path: string; round: number }): boolean =>
      (file.path.split("/").at(-1) ?? "").includes("進度") || (latest > 0 && file.round === latest);
    const requested = queue.flatMap(path => found.filter(file => normalizeVaultPath(file.path) === path));
    this.lastReads = new Set(
      requested.map(file => `${normalizeVaultPath(file.path) ?? file.path}\0${contentHash(file.content)}`)
    );
    return [
      ...requested.map(({ path, content }) => ({ path, content, requested: true as const })),
      ...found
        .filter(file => !requested.includes(file))
        .sort((a, b) => Number(first(b)) - Number(first(a)) || b.seq - a.seq)
        .map(({ path, content }) => ({ path, content }))
    ];
  }

  /** The `file_written` / `file_attached` marks the record of this conversation does not hold yet (own files first, then attached); each is returned once. */
  marksFor(conversationId: string): MapChatFileMark[] {
    if (this.recorded.id !== conversationId) this.recorded = { id: conversationId, keys: new Set() };
    const marks: MapChatFileMark[] = [];
    for (const [path, hashes] of this.ownFiles)
      for (const hash of hashes) {
        const key = `${path}\0${hash}`;
        if (this.recorded.keys.has(key)) continue;
        this.recorded.keys.add(key);
        marks.push({ kind: "file_written", path, hash });
      }
    for (const [path, hashes] of this.attached)
      for (const hash of hashes) {
        const key = `A\0${path}\0${hash}`;
        if (this.recorded.keys.has(key)) continue;
        this.recorded.keys.add(key);
        marks.push({ kind: "file_attached", path, hash });
      }
    return marks;
  }

  /** The files of a conversation read back from its record (round 0, already marked there). Adds to what is held; clears nothing. */
  restore(
    conversationId: string,
    own: { path: string; hash: string }[],
    attached: { path: string; hash: string }[]
  ): void {
    for (const item of own) {
      const hashes = this.ownFiles.get(item.path) ?? new Set<string>();
      hashes.add(item.hash);
      this.ownFiles.set(item.path, hashes);
      this.ownOrder.set(item.path, { seq: ++this.writeSeq, round: 0 });
      this.recorded.keys.add(`${item.path}\0${item.hash}`);
    }
    for (const item of attached) {
      const hashes = this.attached.get(item.path) ?? new Set<string>();
      hashes.add(item.hash);
      this.attached.set(item.path, hashes);
      this.recorded.keys.add(`A\0${item.path}\0${item.hash}`);
    }
    this.recorded.id = conversationId;
  }

  /** A new conversation: everything is forgotten except the counters (they only ever go up). */
  reset(): void {
    this.ownFiles.clear();
    this.attached.clear();
    this.ownOrder.clear();
    this.readQueue = [];
    this.lastReads.clear();
    this.recorded = { id: null, keys: new Set() };
  }

  private insideMapFolder(key: string): boolean {
    const root = this.ports.mapFolder();
    return root !== null && key.startsWith(`${root}/`);
  }

  /** The versions of a file the chat may read now: what it wrote (inside this map's folder only) and what the user attached (anywhere). */
  private readableHashes(key: string): Set<string> | undefined {
    const own = this.insideMapFolder(key) ? this.ownFiles.get(key) : undefined;
    const attached = this.attached.get(key);
    return own || attached ? new Set([...(own ?? []), ...(attached ?? [])]) : undefined;
  }
}
