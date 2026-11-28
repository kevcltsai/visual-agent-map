import { t } from "../../i18n";
import { livingRestoreSnapshot, livingWithoutFence } from "./living-node-markdown";
import { clone, type MapDocument } from "../../map-model";
import { pruneAfterText } from "./canvas-items";
import { sameApartFromStamps } from "./cross-map-history";
import type { NoteWriteGuard, Repository, TopicState } from "../../repository";
import type { TFile } from "obsidian";
import { findWikilinks, linkPathOf } from "../../core/link-rewrite";
import {
  attachmentPath,
  claim,
  findSame,
  fingerprintOf,
  isLinked,
  release,
  unchangedFile,
  type Fingerprint
} from "./attachment-store";

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
    | "exactFreePath"
    | "app"
    | "file"
    | "withNoteWriteGuard"
    | "acceptsNoteHistory"
  >;
  rebuildDerivedData: () => Promise<void>;
  /**
   * Rewrites the derived references of just these notes (the ends of relations this step changed), when no full
   * rebuild runs. A note whose derived text is already current is not written.
   */
  refreshNotes?: (paths: string[]) => Promise<void>;
  /**
   * Called with the path of every note a step moves, renames or rewrites, when the step is queued (before anything is written);
   * throwing refuses the step with nothing written. The one place a caller can keep a set of notes read-only.
   */
  guardPath?: (path: string) => void;
  /** Validate the final dependency graph before the first publication of an edit. A refusal uses normal transaction rollback. */
  validateStructure?: (before: MapDocument, after: MapDocument) => Promise<void>;
  /** Called once per edited map after commit, undo and redo, with the map as now stored. */
  onApplied: (mapPath: string, map: MapDocument) => void | Promise<void>;
  /** Called for each edited map before anything is written; throwing cancels the whole transaction. */
  checkConflict: (mapPath: string) => void | Promise<void>;
}
export interface TransactionEntry {
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  label?: string;
  /** Where the notes this step moved are now (parked or moved targets); read after commit. */
  parkedPaths?: () => string[];
  /** Where the notes this step created are parked (set by the first undo); empty before it. */
  createdParkPaths?: () => string[];
}
export interface CommitOptions {
  /** Skip the derived-data rebuild during commit; the caller rebuilds. Undo and redo still rebuild. */
  deferRebuild?: boolean;
  label?: string;
  /** First publication only: an invalidated editor must not publish its pending change. */
  authorize?: () => boolean;
  /**
   * First publication only: awaited inside the commit, after its own reads and right before the first write; throwing
   * abandons the step with nothing written (a caller's last look at what it read, e.g. an AI merge's sources).
   */
  beforeWrite?: () => Promise<void>;
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
  create(path: string, parkFolder: string, topicId: string, title?: string): Transaction;
  /**
   * After the moves of this step, renames the note at `path` to `<title>.md` in its folder when that exact name is free
   * (otherwise it keeps its name). Links follow (the move machinery); undo and redo rename it back and forth. The note
   * can also be rewritten in the same step.
   */
  rename(path: string, title: string): Transaction;
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
   * Undo and redo refuse (`guard`) when the note differs from what this step left or found, including user-owned fields.
   * `settle` runs on the note once the moves are done (their link rewrites are in it): at commit before what this step left
   * is recorded, and again at redo, so a redone note is the text undo expects.
   */
  rewriteNote(
    path: string,
    write: (path: string, attachment: AttachmentPath) => Promise<void>,
    settle?: (path: string) => Promise<void>
  ): Transaction;
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
  kind: "move" | "create" | "rename";
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
  /** Absent for a plain rename: the lifecycle is left alone. */
  lifecycle?: Lifecycle;
  restore?: Lifecycle;
}
interface Journal {
  /** `lost`: the file left `from` but its new path is unknown, so it cannot be put back. */
  files: Array<FileStep & { moved: boolean; lifecycleSet: boolean; lost?: boolean }>;
  maps: Array<{ mapPath: string; restore: MapDocument; after: MapDocument }>;
  notes: NoteWriteJournal;
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
/** Per topic id, the relation ends its note lists, in map order (kind, direction, other end); descriptions do not count. */
const relationEnds = (map: MapDocument): Map<string, string[]> => {
  const ends = new Map<string, string[]>();
  const add = (id: string, end: string): void => {
    ends.set(id, [...(ends.get(id) ?? []), end]);
  };
  const cards = new Set(map.nodes.map(node => node.id));
  for (const r of map.topicRelations ?? []) {
    // A relation whose end is a knowledge reference writes no line in any note (F07b-y), so it changes no note.
    if (!cards.has(r.from) || !cards.has(r.to)) continue;
    add(r.from, `${r.kind}>${r.to}`);
    add(r.to, `${r.kind}<${r.from}`);
  }
  return ends;
};
/**
 * The notes whose relation lines differ between `before` and `after`: both ends of every relation added, removed,
 * reversed or changed in kind. Only a description change gives none.
 */
export function relationNotePaths(before: MapDocument, after: MapDocument): string[] {
  const was = relationEnds(before),
    now = relationEnds(after),
    paths = new Set<string>();
  for (const id of new Set([...was.keys(), ...now.keys()])) {
    if (JSON.stringify(was.get(id) ?? []) === JSON.stringify(now.get(id) ?? [])) continue;
    for (const map of [before, after]) {
      const node = map.nodes.find(item => item.id === id);
      if (node) paths.add(node.path);
    }
  }
  return [...paths];
}
/** Where a rewritten note is while `direction` runs its guard: a renamed note is at its new name only before an undo. */
const noteAt = (ops: FileOp[], path: string, direction: "undo" | "redo"): string => {
  const renamed = ops.find(op => op.kind === "rename" && op.original === path);
  return renamed && direction === "undo" ? renamed.target : path;
};
const baseNameOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, "");
const tagged = (error: Error, kind: TransactionErrorKind): TransactionError => Object.assign(error, { kind });

// Note rewrite (ticket 04)
const noteConflict = (): TransactionError => tagged(new Error(t("error.map_transaction_stale")), "guard");
// Vault.read may omit a leading BOM, whereas Vault.process may supply it.
const withoutBom = (text: string): string => text.replace(/^\uFEFF/, "");
const sameText = (a: string, b: string): boolean => withoutBom(a) === withoutBom(b);
// History tolerates only the existing documented stamp/key-order equivalence. In-flight writes still compare exact text.
const sameHistoryText = (a: string, b: string): boolean =>
  sameText(a, b) || sameApartFromStamps(withoutBom(a), withoutBom(b));
interface NoteOp {
  path: string;
  write: (path: string, attachment: AttachmentPath) => Promise<void>;
  settle?: (path: string) => Promise<void>;
}
interface NoteRecord extends NoteOp {
  beforeText: string;
  beforeExpected: string;
  afterExpected: string;
}
/** One note write inside `run`: `apply` does it, `restore` is the text to put back if the step fails. */
interface NoteStep {
  path: string;
  restore: string;
  apply: () => Promise<void>;
}
const readText = (repo: Pick<Repository, "app" | "file">, path: string): Promise<string> =>
  repo.app.vault.read(repo.file(path));
const writeText = async (
  repo: Pick<Repository, "app" | "file">,
  path: string,
  text: string,
  carryFence?: (current: string, target: string) => string
): Promise<void> => {
  await repo.app.vault.process(repo.file(path), current => {
    const next = carryFence && livingWithoutFence(current) !== current ? carryFence(current, text) : text;
    return current.startsWith("\uFEFF") && !next.startsWith("\uFEFF") ? "\uFEFF" + next : next;
  });
};

/**
 * A delegated Obsidian rename may expand a short wikilink to a vault-relative path.
 * Accept only changes to the specific moved target; all other bytes must match.
 * Unsupported host rewrites fail closed rather than being treated as our own edit.
 */
function isHostLinkRewrite(before: string, after: string, origin: string, target: string): boolean {
  if (sameText(before, after)) return true;
  const old = withoutBom(before);
  const next = withoutBom(after);
  const oldLinks = findWikilinks(old);
  const newLinks = findWikilinks(next);
  if (oldLinks.length !== newLinks.length) return false;
  const names = (path: string): string[] => {
    const stem = path.replace(/\.md$/i, "");
    const base = stem.slice(stem.lastIndexOf("/") + 1);
    return [stem, path, base, base + ".md"];
  };
  const origins = names(origin);
  const targets = names(target);
  let oldAt = 0;
  let newAt = 0;
  for (let i = 0; i < oldLinks.length; i++) {
    const a = oldLinks[i];
    const b = newLinks[i];
    if (old.slice(oldAt, a.start) !== next.slice(newAt, b.start)) return false;
    if (a.original !== b.original) {
      const from = linkPathOf(a.target);
      const to = linkPathOf(b.target);
      if (!origins.includes(from) || !targets.includes(to)) return false;
      const shape = (link: string, path: string): string => {
        const at = link.indexOf(path, link.indexOf("[[") + 2);
        return link.slice(0, at) + "<target>" + link.slice(at + path.length);
      };
      if (shape(a.original, from) !== shape(b.original, to)) return false;
    }
    oldAt = a.end;
    newAt = b.end;
  }
  return old.slice(oldAt) === next.slice(newAt);
}

interface NoteWriteEntry {
  path: string;
  file: TFile;
  before: string;
  expected: string;
  changed: boolean;
  conflict: boolean;
}

/** Track the transaction's own writes, including link rewrites caused by its moves, not a later read of their effects. */
class NoteWriteJournal {
  private readonly entries = new Map<TFile, NoteWriteEntry>();
  private reverting = false;
  private active = true;

  constructor(
    private readonly repo: TransactionDeps["repo"],
    snapshots: readonly { path: string; restore: string; file?: TFile }[],
    grouped = false
  ) {
    for (const { path, restore, file: identity } of snapshots) {
      const file = repo.file(path);
      if (identity && file !== identity) throw noteConflict();
      if (!this.entries.has(file))
        this.entries.set(file, { path, file, before: restore, expected: restore, changed: false, conflict: false });
    }
    if (grouped)
      this.guard.acceptsHistory = (file, current) => {
        const entry = this.entries.get(file);
        return this.active && !!entry && !entry.conflict && sameText(current, entry.expected);
      };
  }

  private readonly guard: NoteWriteGuard = (file, current, change) => {
    const entry = this.entries.get(file);
    if (!this.active) return change(current);
    if (!entry) {
      // A replacement at a tracked path is not the file that this transaction owns.
      if ([...this.entries.values()].some(tracked => tracked.path === file.path || tracked.file.path === file.path))
        throw noteConflict();
      return change(current);
    }
    if (!sameText(current, entry.expected)) {
      entry.conflict = true;
      if (!this.reverting) throw noteConflict();
    }
    // During rollback, independent link rewrites can still proceed. Never restore the whole note after a conflict.
    if (!entry.changed && !entry.conflict) entry.before = current;
    const next = change(current);
    entry.changed ||= next !== current;
    entry.expected = next;
    return next;
  };

  private async aroundHostMove(origin: string, target: string, move: () => Promise<void>): Promise<void> {
    if (!this.active) return move();
    for (const entry of this.entries.values()) {
      const current = await this.repo.app.vault.read(entry.file);
      if (!sameText(current, entry.expected)) {
        entry.conflict = true;
        if (!this.reverting) throw noteConflict();
      }
    }
    await move();
    for (const entry of this.entries.values()) {
      const current = await this.repo.app.vault.read(entry.file);
      if (!isHostLinkRewrite(entry.expected, current, origin, target)) {
        entry.conflict = true;
        if (!this.reverting) throw noteConflict();
        continue;
      }
      entry.changed ||= !sameText(current, entry.expected);
      entry.expected = current;
    }
  }

  async run<T>(action: () => Promise<T>): Promise<T> {
    try {
      this.guard.aroundHostMove = (origin, target, move) => this.aroundHostMove(origin, target, move);
      return this.entries.size ? await this.repo.withNoteWriteGuard(this.guard, action) : await action();
    } finally {
      this.active = false;
    }
  }

  /** Verify the tracked postimage rather than adopting any external changes that happened after the last write. */
  async snapshots(): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    for (const entry of this.entries.values()) {
      const current = await this.repo.app.vault.read(entry.file);
      if (
        this.repo.app.vault.getAbstractFileByPath(entry.file.path) !== entry.file ||
        !sameText(current, entry.expected)
      )
        throw noteConflict();
      result.set(entry.path, entry.expected);
    }
    return result;
  }

  startRollback(): void {
    this.reverting = true;
  }

  async restore(problems: unknown[]): Promise<void> {
    for (const entry of [...this.entries.values()].reverse()) {
      if (!entry.changed) continue;
      try {
        if (this.repo.app.vault.getAbstractFileByPath(entry.path) !== entry.file) throw noteConflict();
        await this.repo.app.vault.process(entry.file, current => {
          if (sameText(current, entry.before)) return current;
          if (entry.conflict || !sameText(current, entry.expected)) throw noteConflict();
          return entry.before;
        });
      } catch (problem) {
        problems.push(problem);
      }
    }
  }
}

/**
 * A grouped history entry has already compared these exact texts against its own saved fingerprint.
 * Child entries may use that preimage, but every repository write still checks the group's current expected text.
 */
export function withVerifiedNoteHistory<T>(
  repo: TransactionDeps["repo"],
  notes: ReadonlyMap<TFile, string>,
  action: () => Promise<T>
): Promise<T> {
  const snapshots = [...notes].map(([file, restore]) => ({ path: file.path, file, restore }));
  return new NoteWriteJournal(repo, snapshots, true).run(action);
}

export function begin(deps: TransactionDeps): Transaction {
  const { repo } = deps;
  const moves: Array<{
    kind: "move" | "create" | "rename";
    path: string;
    folder: string;
    lifecycle: Lifecycle;
    /** `create`: the note is renamed to this title once the other moves are done; `rename`: the new title. */
    title?: string;
  }> = [];
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
  const requireMapSnapshot = (current: MapDocument, expected: MapDocument): void => {
    if (written(current) !== written(expected)) throw tagged(new Error(t("error.map_transaction_stale")), "stale");
  };

  /** Writes `files` then `maps`; on failure reverts everything written and throws (AggregateError when reverting also failed). */
  async function run(
    files: FileStep[],
    maps: Array<{ mapPath: string; write: MapDocument; restore: MapDocument; preserveViewport: boolean }>,
    rebuild: boolean,
    notes: { before: NoteStep[]; after: NoteStep[] } = { before: [], after: [] },
    refresh: string[] = []
  ): Promise<Map<string, string>> {
    const journal: Journal = {
      files: [],
      maps: [],
      notes: new NoteWriteJournal(repo, [...notes.before, ...notes.after])
    };
    return journal.notes.run(async () => {
      try {
        for (const step of notes.before) await step.apply();
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
          if (step.lifecycle) {
            entry.lifecycleSet = true;
            await repo.setLifecycle(step.to, step.lifecycle.topicId, step.lifecycle.mapId, step.lifecycle.state);
          }
        }
        for (const step of notes.after) await step.apply();
        for (const item of maps) {
          // The dependencies may have changed since this history entry was
          // recorded. A replay must not publish a newly cyclic structure.
          await deps.validateStructure?.(item.restore, item.write);
          await repo.saveMap(item.mapPath, clone(item.write), {
            authorize: current => requireMapSnapshot(current, item.restore),
            preserveViewport: item.preserveViewport,
            recordWrite: (before, after) => journal.maps.push({ mapPath: item.mapPath, restore: before, after })
          });
        }
        await derive(rebuild, refresh);
        const snapshots = await journal.notes.snapshots();
        for (const item of journal.maps) await deps.onApplied(item.mapPath, clone(item.after));
        return snapshots;
      } catch (error) {
        return revert(journal, rebuild, error, refresh);
      }
    });
  }

  /** The full rebuild when the step needs one, else a refresh of just the notes whose relation lines changed. */
  async function derive(rebuild: boolean, refresh: string[]): Promise<void> {
    if (rebuild) await deps.rebuildDerivedData();
    else if (refresh.length && deps.refreshNotes) await deps.refreshNotes(refresh);
  }

  async function revert(journal: Journal, rebuild: boolean, error: unknown, refresh: string[] = []): Promise<never> {
    const problems: unknown[] = [];
    journal.notes.startRollback();
    for (const item of [...journal.maps].reverse()) {
      try {
        const current = await repo.readMap(item.mapPath);
        // The write may have failed before publication. Never restore over a later external edit.
        if (written(current) === written(item.restore)) continue;
        await repo.saveMap(item.mapPath, clone(item.restore), {
          authorize: latest => requireMapSnapshot(latest, item.after),
          preserveViewport: true
        });
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
      if (step.lifecycleSet && step.restore) {
        try {
          await repo.setLifecycle(at, step.restore.topicId, step.restore.mapId, step.restore.state);
        } catch (problem) {
          problems.push(problem);
        }
      }
    }
    await journal.notes.restore(problems);
    if (rebuild && (journal.files.length > 0 || journal.maps.length > 0)) {
      try {
        await deps.rebuildDerivedData();
      } catch (problem) {
        problems.push(problem);
      }
    } else if (refresh.length && journal.maps.length > 0) {
      try {
        await derive(false, refresh);
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
        created = ops.filter(op => op.kind === "create"),
        renamed = ops.filter(op => op.kind === "rename");
      // A merged note may hold the name a source had: undo parks it before the sources come back, redo the reverse.
      return direction === "undo"
        ? [...renamed.reverse(), ...created.reverse(), ...moved.reverse()]
        : [...moved, ...created, ...renamed];
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
    const guarded = async (direction: "undo" | "redo"): Promise<Map<string, string>> => {
      const snapshots = new Map<string, string>();
      for (const note of noteRecords) {
        const at = noteAt(ops, note.path, direction);
        if (!exists(at)) throw tagged(new Error(t("error.map_transaction_stale")), "stale");
        const expected = direction === "undo" ? note.afterExpected : note.beforeExpected;
        const current = await readText(repo, at);
        // A Living run or its undo moves the note's replay-fence keys; any other difference still refuses.
        if (
          !sameHistoryText(current, expected) &&
          !sameHistoryText(livingWithoutFence(current), livingWithoutFence(expected)) &&
          !repo.acceptsNoteHistory(repo.file(at), current)
        )
          throw noteConflict();
        snapshots.set(at, current);
      }
      return snapshots;
    };
    const stale = async (direction: "undo" | "redo"): Promise<Map<string, MapDocument>> => {
      const snapshots = new Map<string, MapDocument>();
      const fail = (): never => {
        throw tagged(new Error(t("error.map_transaction_stale")), "stale");
      };
      for (const op of ops) {
        if (!op.target) fail();
        const here = toward(op, direction) ? op.original : op.target,
          there = toward(op, direction) ? op.target : op.original;
        // A path another note of this step leaves first (a merged note parked before the sources return) is free.
        const vacated = ops.some(
          other => other !== op && (toward(other, direction) ? other.original : other.target) === there
        );
        if (!exists(here) || (exists(there) && !vacated)) fail();
      }
      for (const record of records) {
        const expected = direction === "undo" ? record.after : record.before;
        const current = await repo.readMap(record.mapPath);
        if (structure(current) !== structure(expected)) fail();
        // Positions are not content, but a node moved by something other than this plugin must not be overwritten.
        if (await repo.coordinatesChangedOutside(record.mapPath)) fail();
        snapshots.set(record.mapPath, current);
      }
      // Redo links the same files again; it never recreates one.
      if (direction === "redo") for (const item of attachments) if (!exists(item.path)) fail();
      return snapshots;
    };
    // The same notes both ways: undo and redo swap before and after.
    const refresh = [...new Set(records.flatMap(record => relationNotePaths(record.before, record.after)))];
    const apply = async (direction: "undo" | "redo"): Promise<void> => {
      if (direction === "undo") choosePark();
      const noteSnapshots = await guarded(direction);
      const snapshots = await stale(direction);
      const files: FileStep[] = sequence(direction).map(op =>
        toward(op, direction)
          ? op.kind === "rename"
            ? { from: op.original, to: op.target }
            : { from: op.original, to: op.target, lifecycle: op.lifecycle, restore: op.previous }
          : op.kind === "rename"
            ? { from: op.target, to: op.original }
            : { from: op.target, to: op.original, lifecycle: op.previous, restore: op.lifecycle }
      );
      const undoing = direction === "undo";
      const maps = records.map(record => ({
        mapPath: record.mapPath,
        write: undoing ? record.before : record.after,
        restore: snapshots.get(record.mapPath)!,
        preserveViewport: true
      }));
      const notes: { before: NoteStep[]; after: NoteStep[] } = { before: [], after: [] };
      for (const note of noteRecords) {
        const at = noteAt(ops, note.path, direction),
          restore = noteSnapshots.get(at)!;
        // Undo writes the original text after the moves (a move rewrites links in other notes); redo writes before them.
        // A rename-back puts the note at `note.path` first, but a failed step finds it at `at` again.
        // The replay fence only moves forward: undo keeps the current fence, never the older one in the saved text.
        if (undoing)
          notes.after.push({
            path: at,
            restore,
            apply: () => writeText(repo, note.path, note.beforeText, livingRestoreSnapshot)
          });
        else {
          notes.before.push({ path: note.path, restore, apply: () => note.write(note.path, attachment) });
          // The same text as the commit left: settle again once the moves rewrote their links (else undo would refuse it).
          const settle = note.settle;
          if (settle)
            notes.after.push({ path: note.path, restore, apply: () => settle(noteAt(ops, note.path, "undo")) });
        }
      }
      const after = await run(files, maps, rebuild, notes, refresh);
      for (const note of noteRecords) {
        const text = after.get(noteAt(ops, note.path, direction))!;
        if (undoing) note.beforeExpected = text;
        else note.afterExpected = text;
      }
    };
    return {
      undo: () => apply("undo"),
      redo: () => apply("redo"),
      parkedPaths: () => ops.filter(op => op.kind === "move" && op.target).map(op => op.target),
      createdParkPaths: () => ops.filter(op => op.kind === "create" && op.target).map(op => op.target),
      ...(label === undefined ? {} : { label })
    };
  }

  /**
   * Stores every registered attachment where `attachmentPath` puts it, reusing a file with the same content in that
   * folder (also one this step already wrote). Each record is pushed as soon as its file exists, so a later failure
   * trashes it.
   */
  async function place(owner: object): Promise<void> {
    for (const source of sources) {
      const print = fingerprintOf(source.data);
      const path = await attachmentPath(repo.app, source.name, source.sourcePath);
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
      deps.guardPath?.(path);
      moves.push({ kind: "move", path, folder, lifecycle });
      return transaction;
    },
    create(path, parkFolder, topicId, title) {
      deps.guardPath?.(path);
      moves.push({
        kind: "create",
        path,
        folder: parkFolder,
        lifecycle: { topicId, mapId: "", state: "unassigned" },
        ...(title === undefined ? {} : { title })
      });
      return transaction;
    },
    rename(path, title) {
      deps.guardPath?.(path);
      moves.push({
        kind: "rename",
        path,
        folder: "",
        lifecycle: { topicId: "", mapId: "", state: "unassigned" },
        title
      });
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
    rewriteNote(path, write, settle) {
      deps.guardPath?.(path);
      noteOps.push({ path, write, ...(settle ? { settle } : {}) });
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
      const authorize = (): void => {
        if (options.authorize && !options.authorize())
          throw tagged(new Error(t("error.map_transaction_stale")), "stale");
      };
      authorize();
      for (const note of noteOps)
        if (moves.some(move => move.path === note.path && move.kind !== "rename"))
          throw new Error(`A note cannot be rewritten and moved in one step: ${note.path}`);
      const mapPaths = [...new Set(edits.map(item => item.mapPath))];
      for (const mapPath of mapPaths) await deps.checkConflict(mapPath);
      const ops: FileOp[] = [];
      const wanted = new Map<FileOp, string>();
      for (const move of moves) {
        const note = await repo.readNote(move.path);
        const op: FileOp = {
          kind: move.kind,
          original: move.path,
          folder: move.folder,
          lifecycle: move.lifecycle,
          previous: { topicId: note.topicId, mapId: note.mapId, state: note.topicState },
          target: ""
        };
        if (move.title !== undefined) wanted.set(op, move.title);
        ops.push(op);
      }
      const started = new Map(ops.map(op => [op.original, op]));
      const befores = new Map<string, MapDocument>();
      for (const mapPath of mapPaths) befores.set(mapPath, await repo.readMap(mapPath));
      const rebuildRequested = !options.deferRebuild;
      const noteRecords: NoteRecord[] = [];
      for (const note of noteOps) {
        const before = await readText(repo, note.path);
        noteRecords.push({ ...note, beforeText: before, beforeExpected: before, afterExpected: before });
      }
      const journal: Journal = {
        files: [],
        maps: [],
        notes: new NoteWriteJournal(
          repo,
          noteRecords.map(note => ({ path: note.path, restore: note.beforeText }))
        ),
        attachments: placed
      };
      let rebuildNeeded = ops.length > 0;
      const records: MapRecord[] = [];
      // Ends of relations this step changed; refreshed even when the caller defers the full rebuild.
      const refresh: string[] = [];
      // Marks the files this step creates until commit settles, so a parallel step does not reuse one it may trash.
      const owner = {};
      return journal.notes.run(async () => {
        try {
          authorize();
          if (options.beforeWrite) {
            await options.beforeWrite();
            authorize();
          }
          await place(owner);
          for (const note of noteRecords) await note.write(note.path, attachment);
          for (const op of ops) {
            if (op.kind !== "move") continue;
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
          // Names are settled last: a name another note of this step just left is free now. A taken name keeps the note's own.
          for (const op of [...ops]) {
            const title = wanted.get(op);
            if (title === undefined) continue;
            const to = repo.exactFreePath(op.original.slice(0, op.original.lastIndexOf("/")), title);
            if (!to || to === op.original) {
              if (op.kind === "rename") ops.splice(ops.indexOf(op), 1);
              continue;
            }
            const entry = { from: op.original, to, moved: false, lifecycleSet: false };
            journal.files.push(entry);
            try {
              await repo.moveExact(op.original, to);
            } catch (problem) {
              // The move relocates first and rewrites links after; a throw in between leaves the file at `to`.
              if (!exists(op.original) && exists(to)) entry.moved = true;
              throw problem;
            }
            entry.moved = true;
            if (op.kind === "create") op.original = to;
            else op.target = to;
          }
          for (const note of noteRecords) await note.settle?.(noteAt(ops, note.path, "undo"));
          const resolve = (originalPath: string): string => {
            const found = started.get(originalPath);
            if (!found) throw new Error(`Not a moved note: ${originalPath}`);
            // A created or renamed note is at its settled name; a rename that found its name taken left the note where it was.
            if (found.kind === "create") return found.original;
            return found.kind === "rename" && !ops.includes(found) ? originalPath : found.target;
          };
          for (const mapPath of mapPaths) {
            const before = befores.get(mapPath)!;
            const after = clone(before);
            for (const item of edits) if (item.mapPath === mapPath) item.edit(after, resolve, attachment);
            // The same cleanup a read does, so the saved map is what a read would give back and the undo check does not go stale.
            pruneAfterText(after);
            await deps.validateStructure?.(before, after);
            authorize();
            records.push({ mapPath, before, after });
            for (const path of relationNotePaths(before, after)) if (!refresh.includes(path)) refresh.push(path);
            if (ownership(before) !== ownership(after)) rebuildNeeded = true;
            await repo.saveMap(mapPath, after, {
              authorize: current => {
                authorize();
                requireMapSnapshot(current, before);
              },
              preserveViewport: true,
              recordWrite: (current, next) => {
                journal.maps.push({ mapPath, restore: current, after: next });
                records[records.length - 1] = { mapPath, before: current, after: next };
              }
            });
          }
          await derive(rebuildRequested && rebuildNeeded, refresh);
          const after = await journal.notes.snapshots();
          for (const note of noteRecords) note.afterExpected = after.get(note.path)!;
          for (const record of records) await deps.onApplied(record.mapPath, clone(record.after));
        } catch (error) {
          return revert(journal, rebuildRequested && rebuildNeeded, error, refresh).finally(() => release(owner));
        }
        release(owner);
        return entryFor(ops, records, rebuildNeeded, options.label, noteRecords, placed);
      });
    }
  };
  return transaction;
}
