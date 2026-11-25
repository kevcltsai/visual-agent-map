import { TFile, TFolder, type App } from "obsidian";
import type { TranslationKey } from "../i18n";
import type { MapDocument } from "../map-model";
import type { Note, NotePatch } from "./repository-note-types";
import { rebaseMapNotePaths } from "./repository-map-content";
import { parentPath } from "./repository-paths";

export interface OrganizeMove {
  mapPath: string;
  title: string;
  kind: "mind" | "aim";
  fromRoot: string;
  toRoot: string;
}
interface PriorContent {
  path: string;
  content: string;
}
/** Reports "moving topic `title`, step `done` of `total`" before each topic move starts. */
export type MoveProgress = (done: number, total: number, title: string) => void;
export interface OrganizePlan {
  moves: OrganizeMove[];
  /** Maps that could not be read: left exactly where they are. */
  skipped: { mapPath: string; error: string }[];
}

interface WorkspaceMovePorts {
  app: App;
  isDisposed(): boolean;
  message(key: TranslationKey): string;
  folder(path: string): Promise<void>;
  file(path: string): TFile;
  renameTopic(mapPath: string, title: string, targetRoot?: string, options?: { rebuild?: boolean }): Promise<string>;
  rebuildDerivedData(scope: { roots: string[]; paths: string[] }): Promise<void>;
  noteRestoredMap(path: string, text: string): void;
  markedFiles(key: "agent-map-node"): Promise<TFile[]>;
  readNoteIfManaged(file: TFile): Promise<Note | null>;
  updateNote(path: string, patch: NotePatch): Promise<void>;
  readableMaps(): Promise<{ file: TFile; map: MapDocument }[]>;
  saveMap(path: string, map: MapDocument): Promise<void>;
}

export async function moveTopicsWithRollback(
  ports: WorkspaceMovePorts,
  moves: OrganizeMove[],
  onProgress?: MoveProgress
): Promise<Map<string, string>> {
  const done: { move: OrganizeMove; newMapPath: string; originalMap: string; journal: PriorContent[] }[] = [],
    mapping = new Map<string, string>();
  // Only the moved topics and the notes that cite them can change: rebuild just those, once.
  const scope = (): { roots: string[]; paths: string[] } => ({
    roots: moves.flatMap(move => [move.fromRoot, move.toRoot]),
    paths: done.flatMap(item => item.journal.map(prior => prior.path))
  });
  try {
    for (const [index, move] of moves.entries()) {
      if (ports.isDisposed()) throw new Error(ports.message("error.plugin_unloaded"));
      onProgress?.(index + 1, moves.length, move.title);
      await ports.folder(parentPath(move.toRoot));
      const originalMap = await ports.app.vault.read(ports.file(move.mapPath));
      const newMapPath = await ports.renameTopic(move.mapPath, move.title, move.toRoot, { rebuild: false });
      const journal: PriorContent[] = [];
      // Trust the disk, not the order of awaits: the topic must really be at its new place before going on.
      if (
        !(ports.app.vault.getAbstractFileByPath(move.toRoot) instanceof TFolder) ||
        !(ports.app.vault.getAbstractFileByPath(newMapPath) instanceof TFile)
      )
        throw new Error(ports.message("error.move_not_applied"));
      done.push({ move, newMapPath, originalMap, journal });
      mapping.set(move.mapPath, newMapPath);
      await rebasePathPrefix(ports, move.fromRoot, move.toRoot, journal);
    }
    await ports.rebuildDerivedData(scope());
    return mapping;
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const { move, newMapPath, originalMap, journal } of [...done].reverse()) {
      try {
        // Put back the exact text of every note and map the path rebase rewrote, then undo the folder move.
        for (const prior of [...journal].reverse()) {
          const file = ports.app.vault.getAbstractFileByPath(prior.path);
          if (file instanceof TFile) await ports.app.vault.modify(file, prior.content);
        }
        await ports.renameTopic(newMapPath, move.title, move.fromRoot, { rebuild: false });
        await ports.app.vault.modify(ports.file(`${move.fromRoot}/Map.md`), originalMap);
        ports.noteRestoredMap(`${move.fromRoot}/Map.md`, originalMap);
      } catch (rollbackError) {
        rollbackErrors.push(
          `${move.fromRoot}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
        );
      }
    }
    try {
      await ports.rebuildDerivedData(scope());
    } catch (rebuildError) {
      rollbackErrors.push(rebuildError instanceof Error ? rebuildError.message : String(rebuildError));
    }
    if (rollbackErrors.length)
      throw new Error(
        `Organize failed (${error instanceof Error ? error.message : String(error)}); rollback also failed (${rollbackErrors.join("; ")}).`
      );
    throw error;
  }
}

/** After a folder move: point note `source-notes`/`reference-materials` and other maps' references at the new prefix. */
async function rebasePathPrefix(
  ports: WorkspaceMovePorts,
  from: string,
  to: string,
  journal: PriorContent[]
): Promise<void> {
  const rebase = (path: string): string =>
    path.startsWith(`${from}/`) ? `${to}/${path.slice(from.length + 1)}` : path;
  for (const file of await ports.markedFiles("agent-map-node")) {
    // MetadataCache can lag behind a note edit or the preceding move in this batch.
    // A negative cached match is not proof that the current note has no reference to the old prefix.
    const note = await ports.readNoteIfManaged(file);
    if (!note) continue;
    const patch: NotePatch = {};
    const references = note.referencePaths ?? [];
    if (references.some(path => rebase(path) !== path)) patch.referencePaths = references.map(rebase);
    if (note.sourcePaths.some(path => rebase(path) !== path)) patch.sourcePaths = note.sourcePaths.map(rebase);
    if (!Object.keys(patch).length) continue;
    journal.push({ path: file.path, content: await ports.app.vault.read(file) });
    await ports.updateNote(file.path, patch);
  }
  for (const { file, map } of await ports.readableMaps()) {
    if (!rebaseMapNotePaths(map, rebase)) continue;
    journal.push({ path: file.path, content: await ports.app.vault.read(file) });
    await ports.saveMap(file.path, map);
  }
}
