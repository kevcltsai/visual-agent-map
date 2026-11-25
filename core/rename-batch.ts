/**
 * A folder rename makes Obsidian report one rename event per file inside it (perf ticket 10). The plugin collects the
 * moves that arrive before its queued handler starts and handles them as one batch: these helpers apply such a list of
 * moves to paths, in event order; a map is moved with `rebaseMapNotePaths(map, chainRebase(pairs))`. Nothing here
 * depends on the view or on Obsidian.
 */

/** One rename event: the path before and the path after. */
export type RenamePair = readonly [oldPath: string, newPath: string];

/**
 * The path `path` ends at after the moves `pairs`, applied one after the other in event order: `A→B, B→C` takes A to C,
 * and a move rolled back (`A→B, B→A`) leaves A where it was. Pairs are never merged or sorted.
 */
export function rebasePath(pairs: readonly RenamePair[], path: string): string {
  for (const [from, to] of pairs) if (path === from) path = to;
  return path;
}

/** The rebase function for one immutable event batch. Walking backwards composes the remaining moves without sorting events. */
export function chainRebase(pairs: readonly RenamePair[]): (path: string) => string {
  const destinations = new Map<string, string>();
  for (let i = pairs.length - 1; i >= 0; i--) {
    const [from, to] = pairs[i];
    destinations.set(from, destinations.get(to) ?? to);
  }
  return path => destinations.get(path) ?? path;
}

/**
 * A path list (a note's `source-notes` or `reference-materials`) after the moves, or null when none of them names a
 * path in it. A list that names none of the old paths cannot change, so this also decides which notes are read.
 */
export function rebasePathList(list: readonly string[], pairs: readonly RenamePair[]): string[] | null {
  if (!mentionsOldPath(list, pairs)) return null;
  const next = list.map(chainRebase(pairs));
  return next.some((path, index) => path !== list[index]) ? next : null;
}

/** Whether a list from a note's frontmatter (any value) names the old path of one of the moves. */
export function mentionsOldPath(list: unknown, pairs: readonly RenamePair[]): boolean {
  if (!Array.isArray(list)) return false;
  return pairs.some(([from, to]) => from !== to && list.includes(from));
}

/** Every path a list of moves touches (old and new), for the views' scoped read-back. */
export function touchedPaths(pairs: readonly RenamePair[]): string[] {
  return [...new Set(pairs.flat())];
}
