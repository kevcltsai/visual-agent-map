import type { MapDocument } from "../../map-model";
import type { SharePayload } from "./share-format";

/** Last gate before writing a share file: any forbidden string in the final HTML blocks the export (fail closed). */
export type LeakCategory =
  | "vault-path"
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
  /** Informational only: a vault name alone is not a path and is no longer scanned (D-2026-10-107). */
  vaultName?: string;
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

/** A fence line: up to 3 spaces, then 3+ backticks or tildes. */
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Removes only well-formed Markdown code: fenced blocks that are closed by a matching fence, and inline code whose
 * backtick runs pair up on one paragraph. Anything unclosed or unpaired stays in the text (treated as not code),
 * so it can never hide a `[[` that follows it.
 */
export function stripMarkdownCode(markdown: string): string {
  const lines = markdown.split("\n");
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = FENCE_LINE.exec(lines[i]);
    if (open) {
      const mark = open[1];
      let close = -1;
      for (let j = i + 1; j < lines.length && close < 0; j++) {
        const run = FENCE_LINE.exec(lines[j]);
        if (run && run[1][0] === mark[0] && run[1].length >= mark.length && lines[j].slice(run[0].length).trim() === "")
          close = j;
      }
      if (close >= 0) {
        kept.push(" ");
        i = close;
        continue;
      }
    }
    kept.push(lines[i]);
  }
  return kept
    .join("\n")
    .replace(/(?<!`)(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g, match => (/\n[ \t]*\n/.test(match) ? match : " "));
}

/** Removes `<pre>…</pre>` and `<code>…</code>` contents (any case, any attributes). Unclosed or mismatched tags stay as text. */
export function stripHtmlCode(html: string): string {
  return html.replace(/<(pre|code)(?=[\s>/])[^>]*>[\s\S]*?<\/\1\s*>/gi, " ");
}

/**
 * Scans the payload field by field. Only the wikilink category ignores code (detail Markdown and detailHtml code
 * and pre contents); every other category looks at the full text of every string field, code included.
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
      const codeFree =
        key === "detail" ? stripMarkdownCode(value) : key === "detailHtml" ? stripHtmlCode(value) : value;
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
