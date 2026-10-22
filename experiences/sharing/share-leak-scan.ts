import type { MapDocument } from "../../map-model";

/** Last gate before writing a share file: any forbidden string in the final HTML blocks the export (fail closed). */
export type LeakCategory =
  | "vault-path"
  | "vault-name"
  | "map-folder"
  | "note-path"
  | "wikilink"
  | "app-url"
  | "obsidian-url"
  | "file-url"
  | "internal-field"
  | "model-name";
export interface ForbiddenString {
  category: LeakCategory;
  value: string;
}
/** Category and offset only; the matched text is never returned so it cannot reach the UI or a log. */
export interface LeakHit {
  category: LeakCategory;
  index: number;
}
export interface ShareVaultInfo {
  /** Absolute filesystem path of the vault, when the adapter exposes one. */
  vaultPath?: string;
  vaultName: string;
  /** Vault-relative folder that holds the map. */
  mapFolder: string;
}

export const INTERNAL_FIELD_NAMES = [
  "agent-map-references",
  "source-notes",
  "relevance-tier",
  "relevance-reason",
  "relevance-manual",
  "relevance-goal",
  "relevance-level",
  "relevance-context",
  "content-language"
] as const;

export function scanForLeaks(html: string, forbidden: readonly ForbiddenString[]): LeakHit[] {
  const hits: LeakHit[] = [];
  for (const { category, value } of forbidden) {
    if (!value) continue;
    let from = 0;
    for (;;) {
      const index = html.indexOf(value, from);
      if (index < 0) break;
      hits.push({ category, index });
      from = index + value.length;
    }
  }
  return hits.sort((a, b) => a.index - b.index);
}

export function forbiddenStringsFor(
  vault: ShareVaultInfo,
  map: Pick<MapDocument, "nodes">,
  notes: readonly { model?: string }[] = []
): ForbiddenString[] {
  const list: ForbiddenString[] = [];
  const add = (category: LeakCategory, value: string | undefined): void => {
    const text = value?.trim();
    if (text) list.push({ category, value: text });
  };
  add("vault-path", vault.vaultPath);
  add("vault-name", vault.vaultName);
  add("map-folder", vault.mapFolder);
  for (const node of map.nodes) add("note-path", node.path);
  add("wikilink", "[[");
  add("app-url", "app://");
  add("obsidian-url", "obsidian://");
  add("file-url", "file://");
  for (const name of INTERNAL_FIELD_NAMES) add("internal-field", name);
  for (const note of notes) add("model-name", note.model);
  const seen = new Set<string>();
  return list.filter(item => {
    const key = `${item.category}\0${item.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
