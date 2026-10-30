/**
 * Pure text helper for "Copy to…": the links of a copied note are read from the source note's place and written again
 * for the copy's place. Links to notes copied in the same run follow the copies; links to anything else keep naming
 * the original file, and are only spelled out when the copy's place would read them as another file. Obsidian is not
 * involved here; the caller supplies how a link text resolves from a given note.
 */
import { codeRanges, findWikilinks, linkPathOf } from "./link-rewrite";

/** The vault path a link path names when read from the note at `fromPath`, undefined when it names none. */
export type ResolveLink = (linkPath: string, fromPath: string) => string | undefined;

export interface CopiedLinkResult {
  /** The body with every link that needed it rewritten. */
  text: string;
  /** How many links were rewritten. */
  rewritten: number;
  /** Links that would resolve to another file from the copy, but whose every rewrite failed to resolve back; kept as written. */
  unverified: string[];
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

function baseOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}
function folderOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

/** `target` relative to `folder`, with `../` for each folder to climb. */
function relativeTo(folder: string, target: string): string {
  const from = folder ? folder.split("/") : [],
    to = target.split("/");
  let common = 0;
  while (common < from.length && common < to.length - 1 && from[common] === to[common]) common++;
  return [...from.slice(common).map(() => ".."), ...to.slice(common)].join("/");
}

/**
 * The spellings of `target` to try, in order: the bare file name when the link was a bare name, the vault path, and
 * the path relative to the copy's folder. A note keeps or drops `.md` like the original link; an attachment keeps its
 * extension.
 */
function candidatesFor(linkPath: string, target: string, newPath: string): string[] {
  const isNote = /\.md$/i.test(target),
    dropMd = isNote && !/\.md$/i.test(linkPath),
    spell = (path: string): string => (dropMd ? path.replace(/\.md$/i, "") : path);
  const out: string[] = [];
  if (!linkPath.includes("/")) out.push(spell(baseOf(target)));
  out.push(spell(target), spell(relativeTo(folderOf(newPath), target)));
  return [...new Set(out)];
}

/** Whether a link path has a scheme (`https:`, `obsidian:`, `mailto:` …) and so names no vault file. */
function isExternal(path: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(path);
}

/** Only what Obsidian needs encoded in a bare Markdown link destination. */
function encodeMarkdownPath(path: string): string {
  return path.replace(/ /g, "%20").replace(/\(/g, "%28").replace(/\)/g, "%29");
}

/**
 * Rewrites the links of a copied note's `body` (frontmatter excluded). `copies` maps each note copied in this run
 * (this one included) to its copy. Links in code, external links, heading-only links and unresolved links are kept
 * as written; so is a link whose rewrite does not resolve back to its target, which is then listed in `unverified`.
 */
export function rewriteCopiedLinks(
  body: string,
  options: { sourcePath: string; newPath: string; copies: ReadonlyMap<string, string>; resolve: ResolveLink }
): CopiedLinkResult {
  const { sourcePath, newPath, copies, resolve } = options,
    unverified: string[] = [],
    edits: Edit[] = [];
  /** The new spelling of `linkPath`, the same text when it needs none, or undefined when no rewrite resolves back. */
  const retarget = (linkPath: string): string | undefined => {
    const source = resolve(linkPath, sourcePath);
    if (source === undefined) return linkPath;
    const target = copies.get(source) ?? source;
    if (resolve(linkPath, newPath) === target) return linkPath;
    return candidatesFor(linkPath, target, newPath).find(candidate => resolve(candidate, newPath) === target);
  };

  const wikilinks = findWikilinks(body);
  for (const link of wikilinks) {
    const parts = /^(!?)\[\[([^[\]\n]+)\]\]$/.exec(link.original);
    if (!parts) continue;
    const inner = parts[2],
      hash = link.target.indexOf("#"),
      pathPart = hash < 0 ? link.target : link.target.slice(0, hash),
      linkPath = linkPathOf(link.target);
    if (!linkPath || isExternal(linkPath)) continue;
    const next = retarget(linkPath);
    if (next === undefined) unverified.push(link.original);
    else if (next !== linkPath)
      edits.push({
        start: link.start,
        end: link.end,
        text: `${parts[1]}[[${next}${inner.slice(pathPart.length)}]]`
      });
  }

  const code = codeRanges(body),
    skipped = (at: number): boolean =>
      code.some(([from, to]) => at >= from && at < to) || wikilinks.some(link => at >= link.start && at < link.end);
  for (const match of body.matchAll(/(!?\[[^\]\n]*\]\(\s*)(?:<([^>\n]+)>|([^)\s<>]+))((?:\s+"[^"\n]*")?\s*\))/g)) {
    if (skipped(match.index)) continue;
    const angled = match[2] !== undefined,
      raw = angled ? match[2] : match[3];
    if (isExternal(raw) || raw.startsWith("#")) continue;
    const hash = raw.indexOf("#"),
      rawPath = hash < 0 ? raw : raw.slice(0, hash),
      subPart = hash < 0 ? "" : raw.slice(hash);
    let linkPath = rawPath;
    try {
      linkPath = decodeURIComponent(rawPath);
    } catch {
      /* keep the raw text */
    }
    linkPath = linkPath.trim();
    if (!linkPath) continue;
    const next = retarget(linkPath);
    if (next === undefined) unverified.push(match[0]);
    else if (next !== linkPath) {
      const destination = angled ? `<${next}${subPart}>` : `${encodeMarkdownPath(next)}${subPart}`;
      edits.push({ start: match.index, end: match.index + match[0].length, text: match[1] + destination + match[4] });
    }
  }

  edits.sort((a, b) => a.start - b.start);
  let text = "",
    cursor = 0;
  for (const edit of edits) {
    text += body.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
  }
  return { text: text + body.slice(cursor), rewritten: edits.length, unverified };
}
