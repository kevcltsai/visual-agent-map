import type { MapDocument } from "../../map-model";
import type { SharePayload } from "./share-format";

/** Last gate before writing a share file: any forbidden string in the final HTML blocks the export (fail closed). */
export type LeakCategory =
  | "vault-path"
  | "vault-folder"
  | "external-path"
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
/** Category and offset only, never the matched text. (leakExcerpt shows the text around a hit in the share dialog, on request; it never goes into the file or a log.) */
export interface LeakHit {
  category: LeakCategory;
  index: number;
}
export interface ShareVaultInfo {
  /** Absolute filesystem path of the vault, when the adapter exposes one. */
  vaultPath?: string;
  /** Informational only: a vault name alone is not a path and is no longer scanned (D-2026-10-107). */
  vaultName?: string;
  /** Vault-relative folder that holds the map. */
  mapFolder: string;
  /** Root paths (as typed and real) of this map's external data folders; they live only on this device. */
  externalPaths?: readonly string[];
  /** Vault-relative folders VAM keeps its own files in (workspace, mind maps, note styles and their backups): a path under one names vault internals. */
  internalFolders?: readonly string[];
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
  "map-sources",
  "content-language",
  "living-node-refs",
  "living-node-region-hash",
  "living-node-ownership",
  "living-node-last-execution",
  "living-node-generation",
  "living-node-receipts",
  "living-node-input-revision",
  "living-node-success-knowledge",
  "living-node-last-attempt",
  "living-node-last-successful-check",
  "living-node-last-content-change",
  "living-node-last-change",
  "living-node-outcome",
  "living-node-reason"
] as const;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
  lsqb: "[",
  lbrack: "[",
  rsqb: "]",
  rbrack: "]",
  sol: "/",
  colon: ":"
};

/**
 * Text as a reader sees it: named (the common ones and the brackets), decimal and hex character references turned into
 * characters. A numeric reference without its `;` counts too, as a browser reads `&#91` as `[`.
 */
export function decodeHtmlEntities(text: string): string {
  return text.replace(
    /&(?:#(\d+);?|#[xX]([0-9a-fA-F]+);?|([A-Za-z]+);)/g,
    (original, dec?: string, hex?: string, name?: string) => {
      if (name) return NAMED_ENTITIES[name] ?? original;
      const code = dec ? Number(dec) : parseInt(hex ?? "", 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : original;
    }
  );
}

/**
 * Whether the `[[` at `index` can be link text. Obsidian link targets cannot hold `[` or `]`, so only a matrix row
 * is let through: a single `]` that, after spaces, is followed by `,`, `;` or `[`, as in `[[2,0],[0,1]]` or
 * `[[1, 2]; [3, 4]]`. Everything else counts: `]]`, a cut-off `[[` (tag, line end, end of text), any other `[` or
 * `]`. A `[[[` is decided by the `[[` one place on.
 */
export function isWikilinkStart(text: string, index: number): boolean {
  if (text[index + 2] === "[") return false;
  for (let i = index + 2; i < text.length; i++) {
    const char = text[i];
    if (char === "[" || char === "<" || char === "\n" || char === "\r") return true;
    if (char === "]") {
      let next = i + 1;
      while (text[next] === " ") next++;
      return !(text[next] === "," || text[next] === ";" || text[next] === "[");
    }
  }
  return true;
}

function occurrences(text: string, category: LeakCategory, value: string, hits: LeakHit[]): void {
  // Link text is looked for at every position, so `[[[x]]]` still finds the `[[x]]` inside.
  const wikilink = category === "wikilink" && value === "[[";
  let from = 0;
  for (;;) {
    const index = text.indexOf(value, from);
    if (index < 0) break;
    if (!wikilink || isWikilinkStart(text, index)) hits.push({ category, index });
    from = index + (wikilink ? 1 : value.length);
  }
}

export function scanForLeaks(html: string, forbidden: readonly ForbiddenString[]): LeakHit[] {
  const hits: LeakHit[] = [];
  // Every value is also looked for in the text as a reader sees it: a path with `&` is `&amp;` in HTML, and `&#91;&#91;x]]` shows as `[[x]]`.
  const decoded = html.includes("&") ? decodeHtmlEntities(html) : html;
  for (const { category, value } of forbidden) {
    if (!value) continue;
    occurrences(html, category, value, hits);
    if (decoded !== html) occurrences(decoded, category, value, hits);
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
  // As a folder (`Agent Workspace/`): the bare name alone is ordinary text; a path under it is not.
  for (const folder of vault.internalFolders ?? []) {
    const name = folder.trim().replace(/^\/+|\/+$/g, "");
    if (name) add("vault-folder", `${name}/`);
  }
  for (const external of vault.externalPaths ?? []) add("external-path", external);
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

/** Removes `<pre>…</pre>` and `<code>…</code>` contents (any case, any attributes). Unclosed or mismatched tags stay as text. */
export function stripHtmlCode(html: string): string {
  return html.replace(/<(pre|code)(?=[\s>/])[^>]*>[\s\S]*?<\/\1\s*>/gi, " ");
}

/**
 * Scans the payload field by field. Only the wikilink category ignores code (`detailHtml` code and pre contents);
 * every other category looks at the full text of every string field, code included. The payload carries no Markdown
 * (D-2026-10-110), so no Markdown code heuristic is involved here; the real link check is the DOM gate in the exporter.
 */
export function scanPayloadForLeaks(payload: SharePayload, forbidden: readonly ForbiddenString[]): LeakHit[] {
  const hits: LeakHit[] = [];
  const scanText = (text: string, codeFree: string): void => {
    for (const item of forbidden) {
      const found = scanForLeaks(item.category === "wikilink" ? codeFree : text, [item]);
      hits.push(...found);
    }
  };
  const visit = (value: unknown, key: string): void => {
    if (typeof value === "string") {
      const codeFree = key === "detailHtml" ? stripHtmlCode(value) : value;
      scanText(value, codeFree);
    } else if (Array.isArray(value)) for (const item of value) visit(item, key);
    else if (value && typeof value === "object")
      for (const [name, item] of Object.entries(value)) {
        scanText(name, name);
        visit(item, name);
      }
  };
  visit(payload, "");
  return hits;
}

/**
 * Where a hit is, for the user only (shown in the dialog, never written to the file): the visible text of one payload
 * node around the first forbidden value it holds, or undefined when the value sits only in markup (an attribute).
 */
export function leakExcerpt(node: unknown, forbidden: readonly ForbiddenString[], radius = 20): string | undefined {
  const texts: string[] = [];
  const visit = (value: unknown, key: string): void => {
    if (typeof value === "string")
      texts.push(
        decodeHtmlEntities((key === "detailHtml" ? stripHtmlCode(value) : value).replace(/<[^>]*>/g, " "))
          .replace(/\s+/g, " ")
          .trim()
      );
    else if (Array.isArray(value)) for (const item of value) visit(item, key);
    else if (value && typeof value === "object") for (const [name, item] of Object.entries(value)) visit(item, name);
  };
  visit(node, "");
  for (const text of texts)
    for (const item of forbidden) {
      const hits: LeakHit[] = [];
      occurrences(text, item.category, item.value, hits);
      if (!hits.length) continue;
      const index = hits[0].index;
      const start = Math.max(0, index - radius);
      const end = Math.min(text.length, index + item.value.length + radius);
      return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
    }
  return undefined;
}
