import { t } from "../../i18n";
import { clone, type MapDocument } from "../../map-model";
import type { Note, Repository, TopicState } from "../../repository";
import { claim, findSame, fingerprintOf, isLinked, release, unchangedFile, type Fingerprint } from "./attachment-store";

/**
 * One undoable step that moves note files and edits Map.md files together.
 * Nothing is written until `commit`; a failure part-way restores every write, and undo/redo refuse (stale) instead of
 * overwriting changes made outside the step. The module touches only the vault, never the view.
 */
export interface Lifecycle {
  topicId: string;
  mapId: string;
  state: TopicState;
}
export interface TransactionDeps {
  repo: Pick<
    Repository,
    | "readNote"
    | "readMap"
    | "saveMap"
    | "coordinatesChangedOutside"
    | "moveUnique"
    | "moveExact"
    | "setLifecycle"
    | "unique"
    | "app"
    | "file"
  >;
  rebuildDerivedData: () => Promise<void>;
  /** Called once per edited map after commit, undo and redo, with the map as now stored. */
  onApplied: (mapPath: string, map: MapDocument) => void | Promise<void>;
  /** Called for each edited map before anything is written; throwing cancels the whole transaction. */
  checkConflict: (mapPath: string) => void | Promise<void>;
}
export interface TransactionEntry {
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  label?: string;
}
export interface CommitOptions {
  /** Skip the derived-data rebuild during commit; the caller rebuilds. Undo and redo still rebuild. */
  deferRebuild?: boolean;
  label?: string;
}
/** The vault path commit chose for the attachment registered under `key`; throws for an unknown key. */
export type AttachmentPath = (key: string) => string;
export interface AttachmentSource {
  /** File name handed to Obsidian (which dedupes it), e.g. `image.png`. */
  name: string;
  data: ArrayBuffer;
  /** The note the attachment belongs to; Obsidian's attachment settings place it relative to this note. */
  sourcePath: string;
}
export type TransactionErrorKind = "stale" | "rollback-failed" | "guard";
export type TransactionError = Error & { kind: TransactionErrorKind };
export interface Transaction {
  /** Moves a note into `folder` (a free name is chosen) and sets its lifecycle; returns nothing until commit. */
  move(path: string, folder: string, lifecycle: Lifecycle): Transaction;
  park(path: string, folder: string, topicId: string, state: "unassigned" | "archived"): Transaction;
  /**
   * Registers a note that already exists at `path` and is part of this step. Commit writes nothing for it; undo parks it
   * in `parkFolder` as unassigned (the path is chosen on the first undo and kept), redo puts it back with the lifecycle
   * it had at commit.
   */
  create(path: string, parkFolder: string, topicId: string): Transaction;
  unpark(path: string, folder: string, topicId: string, mapId: string): Transaction;
  transfer(path: string, topic: { id: string; root: string }, mode: "unassigned" | "add"): Transaction;
  /** `resolve(originalPath)` gives the path a moved note will have; moves run before map edits. */
  editMap(
    mapPath: string,
    edit: (map: MapDocument, resolve: (originalPath: string) => string, attachment: AttachmentPath) => void
  ): Transaction;
  /**
   * Rewrites the note at `path` through `write(path)` (which must write that file and nothing else). Commit runs it
   * before any move; undo writes the original text back after the moves; redo runs `write` again before the moves.
   * Undo and redo refuse (`guard`) when title, summary, detail or status differ from what this step left or found.
   */
  rewriteNote(path: string, write: (path: string, attachment: AttachmentPath) => Promise<void>): Transaction;
  /**
   * Stores `data` as an attachment of `sourcePath` before any note or map write; the callbacks of `editMap` and
   * `rewriteNote` get its path through `attachment(key)`. A file with the same content already in the chosen folder is
   * reused. A failed commit trashes only a file this step created (unchanged and not linked); undo and redo never touch
   * the file, and redo refuses (`stale`) when it is gone.
   */
  createAttachment(key: string, source: AttachmentSource): Transaction;
  commit(options?: CommitOptions): Promise<TransactionEntry>;
}

export const isTransactionError = (error: unknown, kind?: TransactionErrorKind): error is TransactionError => {
  const found = (error as { kind?: unknown } | null | undefined)?.kind;
  return (
    (found === "stale" || found === "rollback-failed" || found === "guard") && (kind === undefined || found === kind)
  );
};
export const isStaleError = (error: unknown): boolean => isTransactionError(error, "stale");

interface FileOp {
  /** `create`: the note is at `original` after commit; `target` is its parking path, chosen on the first undo. */
  kind: "move" | "create";
  original: string;
  folder: string;
  lifecycle: Lifecycle;
  previous: Lifecycle;
  target: string;
}
interface MapRecord {
  mapPath: string;
  before: MapDocument;
  after: MapDocument;
}
/** One file step with the lifecycle to put back if it has to be reverted. */
interface FileStep {
  from: string;
  to: string;
  lifecycle: Lifecycle;
  restore: Lifecycle;
}
interface Journal {
  /** `lost`: the file left `from` but its new path is unknown, so it cannot be put back. */
  files: Array<FileStep & { moved: boolean; lifecycleSet: boolean; lost?: boolean }>;
  maps: Array<{ mapPath: string; restore: MapDocument; written: boolean }>;
  /** `restore`: the whole note text read before the write in that direction. */
  notes: Array<{ path: string; restore: string; written: boolean }>;
  /** Files this step stored (created or reused); the created ones are trashed last when the step fails. */
  attachments?: AttachmentRecord[];
}
/** Where an attachment of this step is; `created`: this step wrote the file (a reused one is never trashed). */
interface AttachmentRecord {
  key: string;
  path: string;
  created: boolean;
  print: Fingerprint;
}

// Viewport and node positions are layout, not content: undo writes the stored positions back and does not treat a change as stale.
const structure = (map: MapDocument): string =>
  JSON.stringify({ ...map, viewport: null, nodes: map.nodes.map(node => ({ ...node, x: null, y: null })) });
const written = (map: MapDocument): string => JSON.stringify({ ...map, viewport: null });
const ownership = (map: MapDocument): string =>
  JSON.stringify(map.nodes.map(node => [node.id, node.path, node.parentId]));
const baseNameOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, "");
const tagged = (error: Error, kind: TransactionErrorKind): TransactionError => Object.assign(error, { kind });

// Note rewrite (ticket 04)
const GUARD_FIELDS = ["title", "summary", "detail", "status"] as const;
type NoteGuard = Pick<Note, (typeof GUARD_FIELDS)[number]>;
interface NoteOp {
  path: string;
  write: (path: string, attachment: AttachmentPath) => Promise<void>;
}
interface NoteRecord extends NoteOp {
  guardBefore: NoteGuard;
  guardAfter: NoteGuard;
  beforeText: string;
}
/** One note write inside `run`: `apply` does it, `restore` is the text to put back if the step fails. */
interface NoteStep {
  path: string;
  restore: string;
  apply: () => Promise<void>;
}
const guardOf = (note: Note): NoteGuard => ({
  title: note.title,
  summary: note.summary,
  detail: note.detail,
  status: note.status
});
const sameGuard = (a: NoteGuard, b: NoteGuard): boolean =>
  GUARD_FIELDS.every(field => JSON.stringify(a[field]) === JSON.stringify(b[field]));
const readText = (repo: Pick<Repository, "app" | "file">, path: string): Promise<string> =>
  repo.app.vault.read(repo.file(path));
const writeText = async (repo: Pick<Repository, "app" | "file">, path: string, text: string): Promise<void> => {
  await repo.app.vault.process(repo.file(path), () => text);
};

export function begin(deps: TransactionDeps): Transaction {
  const { repo } = deps;
  const moves: Array<{ kind: "move" | "create"; path: string; folder: string; lifecycle: Lifecycle }> = [];
  const edits: Array<{
    mapPath: string;
    edit: (map: MapDocument, resolve: (originalPath: string) => string, attachment: AttachmentPath) => void;
  }> = [];
  const noteOps: NoteOp[] = [];
  const sources: Array<{ key: string } & AttachmentSource> = [];
  const placed: AttachmentRecord[] = [];
  const attachment: AttachmentPath = key => {
    const found = placed.find(item => item.key === key);
    if (!found) throw new Error(`Not an attachment of this step: ${key}`);
    return found.path;
  };
  let committed = false;
  const exists = (path: string): boolean => !!repo.app.vault.getAbstractFileByPath(path);

  /** Writes `files` then `maps`; on failure reverts everything written and throws (AggregateError when reverting also failed). */
  async function run(
    files: FileStep[],
    maps: Array<{ mapPath: string; write: MapDocument; restore: MapDocument; preserveViewport: boolean }>,
    rebuild: boolean,
    notes: { before: NoteStep[]; after: NoteStep[] } = { before: [], after: [] }
  ): Promise<void> {
    const journal: Journal = { files: [], maps: [], notes: [] };
    const rewrite = async (step: NoteStep): Promise<void> => {
      journal.notes.push({ path: step.path, restore: step.restore, written: true });
      await step.apply();
    };
    try {
      for (const step of notes.before) await rewrite(step);
      for (const step of files) {
        const entry = { ...step, moved: false, lifecycleSet: false };
        journal.files.push(entry);
        try {
          await repo.moveExact(step.from, step.to);
        } catch (problem) {
          // The move relocates first and rewrites links after; a throw in between leaves the file at `to` (known empty before).
          if (!exists(step.from) && exists(step.to)) entry.moved = true;
          throw problem;
        }
        entry.moved = true;
        entry.lifecycleSet = true;
        await repo.setLifecycle(step.to, step.lifecycle.topicId, step.lifecycle.mapId, step.lifecycle.state);
      }
      for (const step of notes.after) await rewrite(step);
      for (const item of maps) {
        const next = clone(item.write);
        if (item.preserveViewport) next.viewport = clone((await repo.readMap(item.mapPath)).viewport);
        const entry = { mapPath: item.mapPath, restore: item.restore, written: false };
        journal.maps.push(entry);
        entry.written = true;
        await repo.saveMap(item.mapPath, next);
      }
      if (rebuild) await deps.rebuildDerivedData();
      for (const item of maps) await deps.onApplied(item.mapPath, clone(item.write));
    } catch (error) {
      await revert(journal, rebuild, error);
    }
  }

  async function revert(journal: Journal, rebuild: boolean, error: unknown): Promise<never> {
    const problems: unknown[] = [];
    for (const item of [...journal.maps].reverse()) {
      if (!item.written) continue;
      try {
        const current = await repo.readMap(item.mapPath);
        // The write may never have happened (the save itself threw before changing the file): nothing to put back.
        // Compared with positions: a coordinate-only write that did land must still be put back.
        if (written(current) === written(item.restore)) continue;
        const next = clone(item.restore);
        next.viewport = current.viewport;
        await repo.saveMap(item.mapPath, next);
      } catch (problem) {
        problems.push(problem);
      }
    }
    for (const step of [...journal.files].reverse()) {
      let at = step.from;
      if (step.lost) problems.push(new Error(`Moved note could not be located to restore: ${step.from}`));
      if (step.moved) {
        at = step.to;
        try {
          await repo.moveExact(step.to, step.from);
          at = step.from;
        } catch (problem) {
          problems.push(problem);
        }
      }
      if (step.lifecycleSet) {
        try {
          await repo.setLifecycle(at, step.restore.topicId, step.restore.mapId, step.restore.state);
        } catch (problem) {
          problems.push(problem);
        }
      }
    }
    for (const item of [...journal.notes].reverse()) {
      if (!item.written) continue;
      try {
        if ((await readText(repo, item.path)) !== item.restore) await writeText(repo, item.path, item.restore);
      } catch (problem) {
        problems.push(problem);
      }
    }
    if (rebuild && (journal.files.length > 0 || journal.maps.length > 0)) {
      try {
        await deps.rebuildDerivedData();
      } catch (problem) {
        problems.push(problem);
      }
    }
    // Last, once nothing of this step links to them: a file changed since it was written or linked from any note stays.
    // Any earlier rollback problem means a note or Map.md may still link to them, so every file is kept for the retry.
    const trashed = new Set<string>();
    for (const item of [...(journal.attachments ?? [])].reverse()) {
      if (problems.length > 0) break;
      if (!item.created || trashed.has(item.path)) continue;
      trashed.add(item.path);
      try {
        const file = await unchangedFile(repo.app, item.path, item.print);
        if (file && !isLinked(repo.app, item.path)) await repo.app.fileManager.trashFile(file);
      } catch (problem) {
        problems.push(problem);
      }
    }
    if (problems.length === 0) throw error;
    const rollbackError =
      problems.length === 1 ? problems[0] : new AggregateError(problems, t("error.topic_state_change_rollback_failed"));
    throw tagged(
      new AggregateError([error, rollbackError], t("error.topic_state_change_rollback_failed")),
      "rollback-failed"
    );
  }

  function entryFor(
    ops: FileOp[],
    records: MapRecord[],
    rebuild: boolean,
    label?: string,
    noteRecords: NoteRecord[] = [],
    attachments: AttachmentRecord[] = []
  ): TransactionEntry {
    // `toward`: the step moves the note from its original path to its target path.
    const toward = (op: FileOp, direction: "undo" | "redo"): boolean =>
      (op.kind === "create") === (direction === "undo");
    const sequence = (direction: "undo" | "redo"): FileOp[] => {
      const moved = ops.filter(op => op.kind === "move"),
        created = ops.filter(op => op.kind === "create");
      return direction === "undo" ? [...moved.reverse(), ...created.reverse()] : [...created, ...moved];
    };
    /** Picks (once) the parking path of every create that has none; later undo and redo reuse it. */
    const choosePark = (): void => {
      const taken = new Set<string>();
      for (const op of ops) {
        if (op.kind !== "create") continue;
        if (!op.target) op.target = repo.unique(op.folder, baseNameOf(op.original), taken);
        taken.add(op.target);
      }
    };
    // Checked before `stale`: a note edited outside is a `guard` refusal even when files also moved.
    const guarded = async (direction: "undo" | "redo"): Promise<void> => {
      for (const note of noteRecords) {
        if (!exists(note.path)) throw tagged(new Error(t("error.map_transaction_stale")), "stale");
        const expected = direction === "undo" ? note.guardAfter : note.guardBefore;
        if (!sameGuard(guardOf(await repo.readNote(note.path)), expected))
          throw tagged(new Error(t("error.map_transaction_stale")), "guard");
      }
    };
    const stale = async (direction: "undo" | "redo"): Promise<void> => {
      const fail = (): never => {
        throw tagged(new Error(t("error.map_transaction_stale")), "stale");
      };
      for (const op of ops) {
        if (!op.target) fail();
        const here = toward(op, direction) ? op.original : op.target,
          there = toward(op, direction) ? op.target : op.original;
        if (!exists(here) || exists(there)) fail();
      }
      for (const record of records) {
        const expected = direction === "undo" ? record.after : record.before;
        if (structure(await repo.readMap(record.mapPath)) !== structure(expected)) fail();
        // Positions are not content, but a node moved by something other than this plugin must not be overwritten.
        if (await repo.coordinatesChangedOutside?.(record.mapPath)) fail();
      }
      // Redo links the same files again; it never recreates one.
      if (direction === "redo") for (const item of attachments) if (!exists(item.path)) fail();
    };
    const apply = async (direction: "undo" | "redo"): Promise<void> => {
      if (direction === "undo") choosePark();
      await guarded(direction);
      await stale(direction);
      const files: FileStep[] = sequence(direction).map(op =>
        toward(op, direction)
          ? { from: op.original, to: op.target, lifecycle: op.lifecycle, restore: op.previous }
          : { from: op.target, to: op.original, lifecycle: op.previous, restore: op.lifecycle }
      );
      const undoing = direction === "undo";
      const maps = records.map(record => ({
        mapPath: record.mapPath,
        write: undoing ? record.before : record.after,
        restore: undoing ? record.after : record.before,
        preserveViewport: true
      }));
      const notes: { before: NoteStep[]; after: NoteStep[] } = { before: [], after: [] };
      for (const note of noteRecords) {
        const restore = await readText(repo, note.path);
        // Undo writes the original text after the moves (a move rewrites links in other notes); redo writes before them.
        if (undoing)
          notes.after.push({ path: note.path, restore, apply: () => writeText(repo, note.path, note.beforeText) });
        else notes.before.push({ path: note.path, restore, apply: () => note.write(note.path, attachment) });
      }
      await run(files, maps, rebuild, notes);
    };
    return { undo: () => apply("undo"), redo: () => apply("redo"), ...(label === undefined ? {} : { label }) };
  }

  /**
   * Stores every registered attachment where Obsidian's settings put it, reusing a file with the same content in that
   * folder (also one this step already wrote). Each record is pushed as soon as its file exists, so a later failure
   * trashes it.
   */
  async function place(owner: object): Promise<void> {
    for (const source of sources) {
      const print = fingerprintOf(source.data);
      const path = await repo.app.fileManager.getAvailablePathForAttachment(source.name, source.sourcePath);
      const same = await findSame(repo.app, path, print, owner);
      if (same) {
        placed.push({ key: source.key, path: same, created: false, print });
        continue;
      }
      claim(path, owner);
      await repo.app.vault.createBinary(path, source.data);
      placed.push({ key: source.key, path, created: true, print });
    }
  }

  const transaction: Transaction = {
    move(path, folder, lifecycle) {
      moves.push({ kind: "move", path, folder, lifecycle });
      return transaction;
    },
    create(path, parkFolder, topicId) {
      moves.push({ kind: "create", path, folder: parkFolder, lifecycle: { topicId, mapId: "", state: "unassigned" } });
      return transaction;
    },
    park(path, folder, topicId, state) {
      return transaction.move(path, folder, { topicId, mapId: "", state });
    },
    unpark(path, folder, topicId, mapId) {
      return transaction.move(path, folder, { topicId, mapId, state: "active" });
    },
    transfer(path, topic, mode) {
      return mode === "add"
        ? transaction.move(path, `${topic.root}/Notes`, { topicId: topic.id, mapId: topic.id, state: "active" })
        : transaction.move(path, `${topic.root}/Unassigned`, { topicId: topic.id, mapId: "", state: "unassigned" });
    },
    editMap(mapPath, edit) {
      edits.push({ mapPath, edit });
      return transaction;
    },
    rewriteNote(path, write) {
      noteOps.push({ path, write });
      return transaction;
    },
    createAttachment(key, source) {
      if (sources.some(item => item.key === key)) throw new Error(`Attachment key used twice: ${key}`);
      sources.push({ key, ...source });
      return transaction;
    },
    async commit(options = {}) {
      if (committed) throw new Error("A transaction can only be committed once.");
      committed = true;
      for (const note of noteOps)
        if (moves.some(move => move.path === note.path))
          throw new Error(`A note cannot be rewritten and moved in one step: ${note.path}`);
      const mapPaths = [...new Set(edits.map(item => item.mapPath))];
      for (const mapPath of mapPaths) await deps.checkConflict(mapPath);
      const ops: FileOp[] = [];
      for (const move of moves) {
        const note = await repo.readNote(move.path);
        ops.push({
          kind: move.kind,
          original: move.path,
          folder: move.folder,
          lifecycle: move.lifecycle,
          previous: { topicId: note.topicId, mapId: note.mapId, state: note.topicState },
          target: ""
        });
      }
      const befores = new Map<string, MapDocument>();
      for (const mapPath of mapPaths) befores.set(mapPath, await repo.readMap(mapPath));
      const rebuildRequested = !options.deferRebuild;
      const noteRecords: NoteRecord[] = [];
      for (const note of noteOps) {
        const before = guardOf(await repo.readNote(note.path));
        noteRecords.push({
          ...note,
          guardBefore: before,
          guardAfter: before,
          beforeText: await readText(repo, note.path)
        });
      }
      const journal: Journal = { files: [], maps: [], notes: [], attachments: placed };
      let rebuildNeeded = ops.length > 0;
      const records: MapRecord[] = [];
      // Marks the files this step creates until commit settles, so a parallel step does not reuse one it may trash.
      const owner = {};
      try {
        await place(owner);
        for (const note of noteRecords) {
          journal.notes.push({ path: note.path, restore: note.beforeText, written: true });
          await note.write(note.path, attachment);
        }
        for (const op of ops) {
          if (op.kind === "create") continue;
          const entry = {
            from: op.original,
            to: "",
            lifecycle: op.lifecycle,
            restore: op.previous,
            moved: false,
            lifecycleSet: false,
            lost: false
          };
          journal.files.push(entry);
          try {
            op.target = await repo.moveUnique(op.original, op.folder);
          } catch (problem) {
            // The new path is unknown (not guessed), so a file that already left its origin is a rollback problem.
            if (!exists(op.original)) entry.lost = true;
            throw problem;
          }
          entry.to = op.target;
          entry.moved = true;
          entry.lifecycleSet = true;
          await repo.setLifecycle(op.target, op.lifecycle.topicId, op.lifecycle.mapId, op.lifecycle.state);
        }
        for (const note of noteRecords) note.guardAfter = guardOf(await repo.readNote(note.path));
        const resolve = (originalPath: string): string => {
          const found = ops.find(op => op.kind === "move" && op.original === originalPath);
          if (!found) throw new Error(`Not a moved note: ${originalPath}`);
          return found.target;
        };
        for (const mapPath of mapPaths) {
          const before = befores.get(mapPath)!;
          const after = clone(before);
          for (const item of edits) if (item.mapPath === mapPath) item.edit(after, resolve, attachment);
          records.push({ mapPath, before, after });
          if (ownership(before) !== ownership(after)) rebuildNeeded = true;
          journal.maps.push({ mapPath, restore: before, written: true });
          await repo.saveMap(mapPath, after);
        }
        if (rebuildRequested && rebuildNeeded) await deps.rebuildDerivedData();
        for (const record of records) await deps.onApplied(record.mapPath, clone(record.after));
      } catch (error) {
        return revert(journal, rebuildRequested && rebuildNeeded, error).finally(() => release(owner));
      }
      release(owner);
      return entryFor(ops, records, rebuildNeeded, options.label, noteRecords, placed);
    }
  };
  return transaction;
}
