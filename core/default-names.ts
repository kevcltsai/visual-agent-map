/**
 * Default names for things the user did not name yet. The first one is the plain name, the next ones get " 1", " 2", ...
 * (the same rule as Obsidian's "Untitled", "Untitled 1").
 */
export function uniqueDefaultName(base: string, taken: Iterable<string>): string {
  const used = new Set<string>();
  for (const name of taken) used.add(name.trim());
  if (!used.has(base)) return base;
  for (let index = 1; ; index++) {
    const candidate = `${base} ${index}`;
    if (!used.has(candidate)) return candidate;
  }
}

/** True when `title` is one of the placeholder map names ("Untitled mind map", "Untitled mind map 2", in any interface language). */
export function isPlaceholderMapTitle(title: string, placeholders: readonly string[]): boolean {
  const clean = title.trim();
  return placeholders.some(base => {
    if (clean === base) return true;
    if (!clean.startsWith(`${base} `)) return false;
    return /^\d+$/.test(clean.slice(base.length + 1));
  });
}

/** The placeholder map name in every interface language (the values of `ui.untitled_mind_map`): a map that still has one was never named by the user. */
export const PLACEHOLDER_MAP_NAMES: readonly string[] = ["Untitled mind map", "未命名心智圖", "未命名心智图"];
