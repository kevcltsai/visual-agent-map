import { t } from "../../i18n";
import { clone, type MapDocument } from "../../map-model";
import type { Repository, TopicState } from "../../repository";

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
  repo: Pick<Repository, "readNote" | "readMap" | "saveMap" | "moveUnique" | "moveExact" | "setLifecycle" | "app">;
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
export type TransactionErrorKind = "stale" | "rollback-failed";
export type TransactionError = Error & { kind: TransactionErrorKind };
export interface Transaction {
  /** Moves a note into `folder` (a free name is chosen) and sets its lifecycle; returns nothing until commit. */
  move(path: string, folder: string, lifecycle: Lifecycle): Transaction;
  park(path: string, folder: string, topicId: string, state: "unassigned" | "archived"): Transaction;
  unpark(path: string, folder: string, topicId: string, mapId: string): Transaction;
  transfer(path: string, topic: { id: string; root: string }, mode: "unassigned" | "add"): Transaction;
  /** `resolve(originalPath)` gives the path a moved note will have; moves run before map edits. */
  editMap(mapPath: string, edit: (map: MapDocument, resolve: (originalPath: string) => string) => void): Transaction;
  commit(options?: CommitOptions): Promise<TransactionEntry>;
}

export const isTransactionError = (error: unknown, kind?: TransactionErrorKind): error is TransactionError => {
  const found = (error as { kind?: unknown } | null | undefined)?.kind;
  return (found === "stale" || found === "rollback-failed") && (kind === undefined || found === kind);
};
export const isStaleError = (error: unknown): boolean => isTransactionError(error, "stale");

interface FileOp {
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
  files: Array<FileStep & { moved: boolean; lifecycleSet: boolean }>;
  maps: Array<{ mapPath: string; restore: MapDocument; written: boolean }>;
}

const structure = (map: MapDocument): string => JSON.stringify({ ...map, viewport: null });
const ownership = (map: MapDocument): string =>
  JSON.stringify(map.nodes.map(node => [node.id, node.path, node.parentId]));
const tagged = (error: Error, kind: TransactionErrorKind): TransactionError => Object.assign(error, { kind });

export function begin(deps: TransactionDeps): Transaction {
  const { repo } = deps;
  const moves: Array<{ path: string; folder: string; lifecycle: Lifecycle }> = [];
  const edits: Array<{ mapPath: string; edit: (map: MapDocument, resolve: (originalPath: string) => string) => void }> =
    [];
  let committed = false;
  const exists = (path: string): boolean => !!repo.app.vault.getAbstractFileByPath(path);

  /** Writes `files` then `maps`; on failure reverts everything written and throws (AggregateError when reverting also failed). */
  async function run(
    files: FileStep[],
    maps: Array<{ mapPath: string; write: MapDocument; restore: MapDocument; preserveViewport: boolean }>,
    rebuild: boolean
  ): Promise<void> {
    const journal: Journal = { files: [], maps: [] };
    try {
      for (const step of files) {
        const entry = { ...step, moved: false, lifecycleSet: false };
        journal.files.push(entry);
        await repo.moveExact(step.from, step.to);
        entry.moved = true;
        entry.lifecycleSet = true;
        await repo.setLifecycle(step.to, step.lifecycle.topicId, step.lifecycle.mapId, step.lifecycle.state);
      }
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
        const next = clone(item.restore);
        next.viewport = current.viewport;
        await repo.saveMap(item.mapPath, next);
      } catch (problem) {
        problems.push(problem);
      }
    }
    for (const step of [...journal.files].reverse()) {
      let at = step.from;
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
    if (rebuild && (journal.files.length > 0 || journal.maps.length > 0)) {
      try {
        await deps.rebuildDerivedData();
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

  function entryFor(ops: FileOp[], records: MapRecord[], rebuild: boolean, label?: string): TransactionEntry {
    const stale = async (direction: "undo" | "redo"): Promise<void> => {
      const fail = (): never => {
        throw tagged(new Error(t("error.map_transaction_stale")), "stale");
      };
      for (const op of ops) {
        const here = direction === "undo" ? op.target : op.original,
          there = direction === "undo" ? op.original : op.target;
        if (!exists(here) || exists(there)) fail();
      }
      for (const record of records) {
        const expected = direction === "undo" ? record.after : record.before;
        if (structure(await repo.readMap(record.mapPath)) !== structure(expected)) fail();
      }
    };
    const apply = async (direction: "undo" | "redo"): Promise<void> => {
      await stale(direction);
      const undoing = direction === "undo";
      const files: FileStep[] = (undoing ? [...ops].reverse() : ops).map(op => ({
        from: undoing ? op.target : op.original,
        to: undoing ? op.original : op.target,
        lifecycle: undoing ? op.previous : op.lifecycle,
        restore: undoing ? op.lifecycle : op.previous
      }));
      const maps = records.map(record => ({
        mapPath: record.mapPath,
        write: undoing ? record.before : record.after,
        restore: undoing ? record.after : record.before,
        preserveViewport: true
      }));
      await run(files, maps, rebuild);
    };
    return { undo: () => apply("undo"), redo: () => apply("redo"), ...(label === undefined ? {} : { label }) };
  }

  const transaction: Transaction = {
    move(path, folder, lifecycle) {
      moves.push({ path, folder, lifecycle });
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
    async commit(options = {}) {
      if (committed) throw new Error("A transaction can only be committed once.");
      committed = true;
      const mapPaths = [...new Set(edits.map(item => item.mapPath))];
      for (const mapPath of mapPaths) await deps.checkConflict(mapPath);
      const ops: FileOp[] = [];
      for (const move of moves) {
        const note = await repo.readNote(move.path);
        ops.push({
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
      const journal: Journal = { files: [], maps: [] };
      let rebuildNeeded = ops.length > 0;
      const records: MapRecord[] = [];
      try {
        for (const op of ops) {
          const entry = {
            from: op.original,
            to: "",
            lifecycle: op.lifecycle,
            restore: op.previous,
            moved: false,
            lifecycleSet: false
          };
          journal.files.push(entry);
          op.target = await repo.moveUnique(op.original, op.folder);
          entry.to = op.target;
          entry.moved = true;
          entry.lifecycleSet = true;
          await repo.setLifecycle(op.target, op.lifecycle.topicId, op.lifecycle.mapId, op.lifecycle.state);
        }
        const resolve = (originalPath: string): string => {
          const found = ops.find(op => op.original === originalPath);
          if (!found) throw new Error(`Not a moved note: ${originalPath}`);
          return found.target;
        };
        for (const mapPath of mapPaths) {
          const before = befores.get(mapPath)!;
          const after = clone(before);
          for (const item of edits) if (item.mapPath === mapPath) item.edit(after, resolve);
          records.push({ mapPath, before, after });
          if (ownership(before) !== ownership(after)) rebuildNeeded = true;
          journal.maps.push({ mapPath, restore: before, written: true });
          await repo.saveMap(mapPath, after);
        }
        if (rebuildRequested && rebuildNeeded) await deps.rebuildDerivedData();
        for (const record of records) await deps.onApplied(record.mapPath, clone(record.after));
      } catch (error) {
        return revert(journal, rebuildRequested && rebuildNeeded, error);
      }
      return entryFor(ops, records, rebuildNeeded, options.label);
    }
  };
  return transaction;
}
