// The book run's structure edit as one map transaction: new cards are created, removed and merged cards are parked in the map's Archive
// (never deleted), cards are renamed, and the callback rewrites Map.md (nodes, order). A failure leaves the notes and the map as they were.
import type { MapDocument } from "../../map-model";
import type { Repository } from "../../repository";
import { begin, isTransactionError, type TransactionDeps } from "./map-transaction";

export interface StructureWork {
  /** New cards: `ref` is the editor's own name for it, `tools.created(ref)` gives the real id and path inside `edit`. */
  create: { ref: string; title: string; summary: string }[];
  /** Cards to park in Archive (their notes are not changed). */
  archive: { id: string; path: string }[];
  /** Cards parked earlier to put back in Notes. */
  restore: { id: string; path: string }[];
  rename: { id: string; path: string; title: string }[];
  /** Rewrites the map: `pathOf(originalPath)` is where a moved, renamed or restored note is now. Throwing undoes everything. */
  edit(
    map: MapDocument,
    tools: { created(ref: string): { id: string; path: string }; pathOf(path: string): string }
  ): void;
}
export type StructureResult = { ok: true } | { ok: false; code: string; rollbackFailed?: true };

export interface StructurePortDeps {
  repo: TransactionDeps["repo"] & Pick<Repository, "createNote" | "resolveTopicModel" | "topicFolder" | "updateNote">;
  rebuildDerivedData: (scope?: Repository) => Promise<void>;
}

export function createBookStructurePort(
  deps: StructurePortDeps
): (mapPath: string, work: StructureWork) => Promise<StructureResult> {
  const { repo } = deps;
  return async (mapPath, work) => {
    const made: { ref: string; id: string; path: string }[] = [];
    let mapId = "";
    try {
      const map = await repo.readMap(mapPath);
      mapId = map.id;
      const root = map.nodes.find(node => !node.parentId);
      if (!root) return { ok: false, code: "no_root" };
      const resolved = await repo.resolveTopicModel(root.path, map);
      for (const item of work.create) {
        const node = await repo.createNote(item.title, resolved.model, map, mapPath, "inherited", {
          summary: item.summary
        });
        made.push({ ref: item.ref, id: node.id, path: node.path });
      }
      const tx = begin({
        repo,
        rebuildDerivedData: deps.rebuildDerivedData,
        onApplied: () => undefined,
        checkConflict: () => undefined
      });
      const unassigned = repo.topicFolder(mapPath, "Unassigned");
      for (const note of made) {
        const title = work.create.find(item => item.ref === note.ref)?.title;
        tx.create(note.path, unassigned, map.id, title);
      }
      for (const card of work.archive) tx.park(card.path, repo.topicFolder(mapPath, "Archive"), map.id, "archived");
      for (const card of work.restore) tx.unpark(card.path, repo.topicFolder(mapPath, "Notes"), map.id, map.id);
      for (const card of work.rename) {
        tx.rewriteNote(card.path, (path, _attachment, scoped) =>
          scoped.updateNote(path, { title: card.title }).then(() => undefined)
        );
        tx.rename(card.path, card.title);
      }
      tx.editMap(mapPath, (doc, resolve) => {
        work.edit(doc, {
          created: ref => {
            const found = made.find(note => note.ref === ref);
            if (!found) throw new Error("unknown ref");
            return { id: found.id, path: resolve(found.path) };
          },
          pathOf: path => resolve(path)
        });
      });
      await tx.commit({ label: "structure" });
      return { ok: true };
    } catch (error) {
      if (isTransactionError(error, "rollback-failed"))
        return { ok: false, code: "rollback_failed", rollbackFailed: true };
      // The notes created for this edit are not in the map: park them as unassigned so none is left in Notes.
      for (const note of made) {
        try {
          if (!repo.app.vault.getAbstractFileByPath(note.path)) continue;
          const to = await repo.moveUnique(note.path, repo.topicFolder(mapPath, "Unassigned"));
          await repo.setLifecycle(to, mapId, "", "unassigned");
        } catch {
          // best effort
        }
      }
      return { ok: false, code: isTransactionError(error) ? error.kind : "failed" };
    }
  };
}
