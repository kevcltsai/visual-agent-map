import { Notice, TFile, TFolder, type App } from "obsidian";
import { translate, type TranslationKey, type UiLanguage } from "../i18n";
import { frontmatter, marker } from "./repository-frontmatter";
import { findWikilinks, linkPathOf, rewriteLinkTargets, splitFrontmatter } from "./link-rewrite";

interface RelocationPorts {
  app: App;
  language(): UiLanguage;
  message(key: TranslationKey): string;
  markedNotes(): Promise<TFile[]>;
}

/**
 * Moves or renames a note or folder. When every note that links to it is a VAM note, the move is made with
 * `vault.rename` (no "Update links" dialog) and the links in those VAM notes are rewritten here. When any other
 * note links to it, Obsidian's own `renameFile` runs so the user's link preference is honoured, after one Notice.
 * The link rewrite reads the notes' current text, not the metadata cache, so a note rewritten a moment ago by the
 * previous move of the same operation is handled correctly. If a rewrite cannot be applied (the note changed in the
 * meantime) this undoes its own writes and the move, then throws, so the caller's rollback sees an unmoved note.
 */
export async function relocateFile(ports: RelocationPorts, item: TFile | TFolder, target: string): Promise<void> {
  const origin = item.path;
  const verifyMove = (): void => {
    if (!ports.app.vault.getAbstractFileByPath(target)) throw new Error(ports.message("error.move_not_applied"));
  };
  const move = async (delegated: boolean): Promise<void> => {
    const rename = (file: TFile | TFolder, path: string): Promise<void> =>
      delegated ? ports.app.fileManager.renameFile(file, path) : ports.app.vault.rename(file, path);
    try {
      await rename(item, target);
      verifyMove();
    } catch (error) {
      // A rejected rename may already have moved the file. Reverse only the very same file, never a replacement.
      if (
        target !== origin &&
        ports.app.vault.getAbstractFileByPath(target) === item &&
        !ports.app.vault.getAbstractFileByPath(origin)
      ) {
        try {
          await rename(item, origin);
          if (ports.app.vault.getAbstractFileByPath(origin) !== item)
            throw new Error(ports.message("error.move_not_applied"));
        } catch (rollbackError) {
          const describe = (failure: unknown): string => (failure instanceof Error ? failure.message : String(failure));
          throw new Error(
            translate(ports.language(), "error.move_undo_failed_0", describe(error), describe(rollbackError))
          );
        }
      }
      throw error;
    }
  };
  const resolvedLinks = ports.app.metadataCache.resolvedLinks as Record<string, Record<string, number>> | undefined;
  if (!resolvedLinks) {
    await move(true);
    return;
  }
  const moves = new Map<string, string>();
  const collect = (entry: TFile | TFolder): void => {
    if (entry instanceof TFile) moves.set(entry.path, `${target}${entry.path.slice(item.path.length)}`);
    else for (const child of entry.children) if (child instanceof TFile || child instanceof TFolder) collect(child);
  };
  collect(item);
  const plan = await planLinkRewrites(ports, item, moves, resolvedLinks);
  if (plan.foreign > 0) {
    new Notice(translate(ports.language(), "ui.move_links_dialog_notice_0", plan.foreign));
    await move(true);
    return;
  }
  await move(false);
  const written: Array<{ path: string; before: string; after: string }> = [];
  try {
    for (const edit of plan.edits) {
      const path = moves.get(edit.path) ?? edit.path,
        file = ports.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) throw new Error(`${ports.message("error.file_not_found")}: ${path}`);
      await ports.app.vault.process(file, current => {
        if (current !== edit.before)
          throw new Error(translate(ports.language(), "error.move_links_note_changed_0", path));
        // Record before publishing: an adapter can reject after applying the callback's result.
        written.push({ path, before: edit.before, after: edit.after });
        return edit.after;
      });
    }
  } catch (error) {
    const rollbackErrors: string[] = [];
    const describe = (failure: unknown): string => (failure instanceof Error ? failure.message : String(failure));
    for (const entry of written.reverse()) {
      try {
        const file = ports.app.vault.getAbstractFileByPath(entry.path);
        if (!(file instanceof TFile)) throw new Error(`${ports.message("error.file_not_found")}: ${entry.path}`);
        await ports.app.vault.process(file, current => {
          if (current === entry.before) return current;
          if (current !== entry.after)
            throw new Error(translate(ports.language(), "error.move_links_note_changed_0", entry.path));
          return entry.before;
        });
      } catch (rollbackError) {
        rollbackErrors.push(describe(rollbackError));
      }
    }
    // A single failed restore must not strand the moved file or skip other independent restores.
    try {
      const moved = ports.app.vault.getAbstractFileByPath(target);
      if (!moved || ports.app.vault.getAbstractFileByPath(origin))
        throw new Error(ports.message("error.move_not_applied"));
      await ports.app.vault.rename(moved, origin);
      if (!ports.app.vault.getAbstractFileByPath(origin) || ports.app.vault.getAbstractFileByPath(target))
        throw new Error(ports.message("error.move_not_applied"));
    } catch (rollbackError) {
      rollbackErrors.push(describe(rollbackError));
    }
    if (rollbackErrors.length)
      throw new Error(
        translate(ports.language(), "error.move_undo_failed_0", describe(error), rollbackErrors.join("; "))
      );
    throw error;
  }
}

/**
 * Which notes would have to change for `moves` (old path to new path): `foreign` counts notes Obsidian must update
 * (any non-VAM note, or a VAM note whose link cannot be rewritten here); `edits` holds the complete new text of each
 * VAM note whose links change. Computed before anything is moved, so a failure writes nothing.
 */
async function planLinkRewrites(
  ports: RelocationPorts,
  item: TFile | TFolder,
  moves: ReadonlyMap<string, string>,
  resolvedLinks: Record<string, Record<string, number>>
): Promise<{ foreign: number; edits: Array<{ path: string; before: string; after: string }> }> {
  // The metadata cache drops or lags a note's frontmatter right after VAM created or rewrote it (an earlier move of
  // the same operation), so a miss there is not proof of a foreign note: the note's own text decides.
  const owned = async (file: TFile): Promise<boolean> => {
    const cached = ports.app.metadataCache.getFileCache(file)?.frontmatter;
    if (marker(cached?.["agent-map-node"]) || marker(cached?.["visual-agent-map"])) return true;
    const fm = frontmatter(await ports.app.vault.read(file));
    return marker(fm["agent-map-node"]) || marker(fm["visual-agent-map"]);
  };
  const foreign = new Set<string>(),
    candidates = new Map<string, TFile>();
  for (const [linkerPath, targets] of Object.entries(resolvedLinks)) {
    if (!Object.keys(targets).some(path => moves.has(path))) continue;
    const linker = ports.app.vault.getAbstractFileByPath(linkerPath);
    // A path that no longer exists is a cache entry that lags behind a move VAM just made; the note is found at its new path below.
    if (!linker) continue;
    if (linker instanceof TFile && linker.extension === "md" && (await owned(linker)))
      candidates.set(linkerPath, linker);
    else foreign.add(linkerPath);
  }
  // The cache can lag behind VAM's own recent writes, so VAM notes are also found by their current text.
  // Moving a folder keeps every file name, so only full-path links (which contain the folder path) can change.
  const needles = item instanceof TFolder ? [`${item.path}/`] : [item.path.replace(/\.md$/i, ""), item.basename];
  for (const file of await ports.markedNotes()) {
    if (candidates.has(file.path) || foreign.has(file.path)) continue;
    const text = await ports.app.vault.cachedRead(file);
    if (needles.some(needle => text.includes(needle))) candidates.set(file.path, file);
  }
  const edits: Array<{ path: string; before: string; after: string }> = [];
  for (const [path, file] of candidates) {
    const before = await ports.app.vault.read(file),
      resolve = (linkPath: string): string | undefined =>
        linkPath ? ports.app.metadataCache.getFirstLinkpathDest(linkPath, path)?.path : undefined;
    const { head, body } = splitFrontmatter(before);
    // Frontmatter links are VAM's own `agent-map-references`, regenerated by rebuildDerivedData; any other key is the user's.
    // `source-notes` and `reference-materials` hold plain vault paths, not wikilinks, and are repaired by replaceSourcePath.
    const fm = frontmatter(before);
    const userKeyLink = Object.entries(fm).some(
      ([key, value]) =>
        key !== "agent-map-references" &&
        findWikilinks(JSON.stringify(value)).some(link => moves.has(resolve(linkPathOf(link.target)) ?? ""))
    );
    const result = rewriteLinkTargets(body, resolve, moves, path);
    if (userKeyLink || result.unsupported.length) {
      foreign.add(path);
      continue;
    }
    if (result.text !== body) edits.push({ path, before, after: head + result.text });
  }
  return { foreign: foreign.size, edits };
}
