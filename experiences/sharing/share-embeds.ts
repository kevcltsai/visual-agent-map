/**
 * What `![[note]]`, `![[note#Heading]]` and `![[note#^block]]` show inside a shared note (pure text work, no Obsidian).
 * One level only: a note embed inside embedded content becomes a plain `[[link]]` (the cleaner then turns it into its
 * title), so embeds never nest or loop. Images and other file embeds inside the content stay as they are.
 */
import { markdownCodeRanges, normalizeNewlines } from "./share-code";

const FRONTMATTER = /^---[ \t]*\n[\s\S]*?\n(?:---|\.\.\.)[ \t]*(?:\n|$)/;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const BLOCK_ID = /(?:^|[ \t])\^([A-Za-z0-9-]+)[ \t]*$/;
const sameHeading = (a: string, b: string): boolean =>
  a.replace(/\s+/g, " ").trim().toLowerCase() === b.replace(/\s+/g, " ").trim().toLowerCase();

export function stripFrontmatter(text: string): string {
  return normalizeNewlines(text).replace(FRONTMATTER, "");
}

/** Lines that are outside fenced code (a `#` line inside a fence is not a heading). */
function proseLineFlags(text: string): boolean[] {
  const ranges = markdownCodeRanges(text);
  const flags: boolean[] = [];
  let at = 0;
  for (const line of text.split("\n")) {
    flags.push(!ranges.some(range => at >= range.start && at < range.end));
    at += line.length + 1;
  }
  return flags;
}

function headingSection(lines: string[], prose: boolean[], name: string): string | undefined {
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const match = prose[i] ? HEADING.exec(lines[i]) : null;
    if (!match) continue;
    if (start < 0) {
      if (sameHeading(match[2], name)) {
        start = i;
        level = match[1].length;
      }
    } else if (match[1].length <= level) {
      return lines.slice(start, i).join("\n").trim();
    }
  }
  return start < 0 ? undefined : lines.slice(start).join("\n").trim();
}

const indentOf = (line: string): number => /^[ \t]*/.exec(line)?.[0].replace(/\t/g, "    ").length ?? 0;
const isListItem = (line: string): boolean => /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/.test(line);

function blockById(lines: string[], id: string): string | undefined {
  const at = lines.findIndex(line => BLOCK_ID.exec(line)?.[1] === id);
  if (at < 0) return undefined;
  const marker = (line: string): string => line.replace(BLOCK_ID, "").trimEnd();
  if (isListItem(lines[at])) {
    const base = indentOf(lines[at]);
    let end = at + 1;
    while (end < lines.length && lines[end].trim() && indentOf(lines[end]) > base) end++;
    return [marker(lines[at]), ...lines.slice(at + 1, end)].join("\n").trim();
  }
  // The id alone on its line names the block above it; otherwise the paragraph the id ends.
  const own = marker(lines[at]).trim() === "";
  let last = own ? at - 1 : at;
  while (own && last >= 0 && !lines[last].trim()) last--;
  if (last < 0) return undefined;
  let first = last;
  while (first > 0 && lines[first - 1].trim()) first--;
  const block = lines.slice(first, last + 1);
  if (!own) block[block.length - 1] = marker(lines[at]);
  return block.join("\n").trim();
}

/** Note embeds in the content become `[[links]]`; image and other file embeds are kept. */
export function flattenNoteEmbeds(md: string): string {
  const ranges = markdownCodeRanges(md);
  return md.replace(/!\[\[([^\]\n]+)\]\]/g, (all: string, inner: string, at: number) => {
    if (ranges.some(range => at >= range.start && at < range.end)) return all;
    const path = inner.split("|")[0].split("#")[0].trim();
    return /\.[a-z0-9]{1,5}$/i.test(path) && !/\.md$/i.test(path) ? all : `[[${inner}]]`;
  });
}

/** The Markdown an embed shows, or undefined when the heading or block is not in the note (or nothing is left). */
export function extractEmbedContent(noteText: string, subpath: string): string | undefined {
  const text = stripFrontmatter(noteText);
  const lines = text.split("\n");
  const prose = proseLineFlags(text);
  const sub = subpath.trim();
  let picked: string | undefined;
  if (!sub) picked = text.trim();
  else if (sub.startsWith("^")) picked = blockById(lines, sub.slice(1));
  else picked = headingSection(lines, prose, sub.split("#").pop() ?? sub);
  return picked ? flattenNoteEmbeds(picked) : undefined;
}

const WEB_OR_DATA = /^(?:[a-z][a-z0-9+.-]*:)/i;
const plainLabel = (text: string): string => text.replace(/[\\`*_{}[\]<>#|!()~=$%^&-]/g, "\\$&");

/**
 * Makes every file reference of embedded content (the Markdown of another note) point at its vault path, resolved from the
 * embedded note's own folder: the cleaner and the exporter resolve references from the note that embeds, which would be the
 * wrong folder. `resolve(ref)` gives the vault path, or null for a file that is missing, internal or outside the vault;
 * such a reference (and anything unresolvable) becomes its plain file name, so it can never be found from the other folder.
 * Notes (`.md` or no extension) and web or data addresses stay as written. Code is left alone.
 */
export function anchorEmbeddedFiles(content: string, resolve: (ref: string) => string | null): string {
  const ranges = markdownCodeRanges(content);
  const decode = (value: string): string => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };
  return content.replace(
    /!\[\[([^\]\n]+)\]\]|!\[([^\]\n]*)\]\(([^)\n]+)\)/g,
    (all: string, wiki: string | undefined, alt: string | undefined, src: string | undefined, at: number) => {
      if (ranges.some(range => at >= range.start && at < range.end)) return all;
      let ref: string;
      let label: string;
      if (wiki !== undefined) {
        const bar = wiki.search(/\\?\|/);
        ref = (bar < 0 ? wiki : wiki.slice(0, bar)).split("#")[0].trim();
        label =
          bar < 0
            ? ""
            : wiki
                .slice(bar)
                .replace(/^\\?\|/, "")
                .trim();
      } else {
        ref = decode(
          (src ?? "")
            .trim()
            .replace(/^<|>$/g, "")
            .replace(/\s+"[^"]*"$/, "")
        );
        label = (alt ?? "").trim();
        if (WEB_OR_DATA.test(ref) || ref.startsWith("//")) return all;
      }
      if (!ref || !/\.[a-z0-9]{1,5}$/i.test(ref) || /\.md$/i.test(ref)) return all;
      const path = resolve(ref);
      if (!path || /[\]|\n]/.test(path)) return plainLabel(ref.split("/").pop() ?? ref);
      const shown = label.replace(/[[\]|\n]/g, " ").trim();
      return `![[${path}${shown ? `|${shown}` : ""}]]`;
    }
  );
}
