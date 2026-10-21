/**
 * Pure text helpers for moving notes without Obsidian's "Update links" dialog: find the wikilinks of a note, and
 * retarget the ones that point at a moved file. Obsidian is not involved here; the caller decides which notes may be
 * rewritten and supplies how a link text resolves to a vault path.
 */

export interface WikilinkMatch {
  /** The link exactly as written, including `!` for an embed. */
  original: string;
  start: number;
  end: number;
  /** The link target without alias, e.g. `Map/Notes/X#Heading`. */
  target: string;
}

/** The target of a link without its heading or block part: `Map/Notes/X#h` becomes `Map/Notes/X`. */
export function linkPathOf(target: string): string {
  const hash = target.indexOf("#");
  return (hash < 0 ? target : target.slice(0, hash)).trim();
}

function stripMd(path: string): string {
  return path.replace(/\.md$/i, "");
}
function baseOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** The leading frontmatter block (with its closing line) and the rest of the note. */
export function splitFrontmatter(text: string): { head: string; body: string } {
  const head = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)?.[0] ?? "";
  return { head, body: text.slice(head.length) };
}

/** Offsets of fenced code blocks and inline code spans, where Obsidian does not read links. */
function codeRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let offset = 0,
    fence: { marker: string; start: number } | null = null;
  for (const line of text.split(/(?<=\n)/)) {
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (open) {
      const marker = open[1];
      if (!fence) fence = { marker, start: offset };
      else if (
        marker[0] === fence.marker[0] &&
        marker.length >= fence.marker.length &&
        !/\S/.test(line.slice(open[0].length))
      ) {
        ranges.push([fence.start, offset + line.length]);
        fence = null;
      }
    } else if (!fence) {
      for (const span of line.matchAll(/(`+)(?!`)[\s\S]*?[^`]\1(?!`)/g))
        ranges.push([offset + span.index, offset + span.index + span[0].length]);
    }
    offset += line.length;
  }
  if (fence) ranges.push([fence.start, text.length]);
  return ranges;
}

/** Every `[[wikilink]]` and `![[embed]]` that Obsidian would read as a link (not inside code). */
export function findWikilinks(text: string): WikilinkMatch[] {
  const code = codeRanges(text),
    matches: WikilinkMatch[] = [];
  for (const match of text.matchAll(/!?\[\[([^[\]\n]+)\]\]/g)) {
    const start = match.index,
      end = start + match[0].length;
    if (code.some(([from, to]) => start >= from && start < to)) continue;
    const inner = match[1],
      alias = inner.search(/\\?\|/);
    matches.push({ original: match[0], start, end, target: alias < 0 ? inner : inner.slice(0, alias) });
  }
  return matches;
}

/**
 * The same wikilink pointing at `newPath` instead of `oldPath`, keeping the embed mark, `.md` extension, heading and
 * alias. A bare-name link is kept as it is while the file name is unchanged, and follows a rename otherwise. Returns
 * null for a form this cannot rewrite safely (a relative or partial path).
 */
export function retargetWikilink(original: string, oldPath: string, newPath: string): string | null {
  const parts = /^(!?)\[\[([^[\]\n]+)\]\]$/.exec(original);
  if (!parts) return null;
  const inner = parts[2],
    alias = inner.search(/\\?\|/),
    target = alias < 0 ? inner : inner.slice(0, alias),
    aliasPart = alias < 0 ? "" : inner.slice(alias),
    hash = target.indexOf("#"),
    pathPart = hash < 0 ? target : target.slice(0, hash),
    subPart = hash < 0 ? "" : target.slice(hash);
  const trimmed = pathPart.trim(),
    hasExt = /\.md$/i.test(trimmed),
    stem = hasExt ? stripMd(trimmed) : trimmed,
    oldStem = stripMd(oldPath),
    newStem = stripMd(newPath);
  let next: string;
  if (stem === oldStem || trimmed === oldPath) next = hasExt ? newPath : newStem;
  else if (!stem.includes("/") && stem === baseOf(oldStem)) {
    if (baseOf(newStem) === baseOf(oldStem)) return original;
    next = hasExt ? `${baseOf(newStem)}.md` : baseOf(newStem);
  } else return null;
  return `${parts[1]}[[${next}${subPart}${alias < 0 ? "" : aliasPart}]]`;
}

export interface LinkRewrite {
  /** The text with every rewritable link retargeted. */
  text: string;
  /** Links in the text that point at a moved file (rewritten or deliberately kept). */
  hits: number;
  /** Links to a moved file in a form that cannot be rewritten safely (relative or partial path, Markdown link). */
  unsupported: string[];
}

/**
 * Retargets the links of `text` that resolve to a moved file. `resolve` maps a link path to the vault path of the file
 * it names (undefined when it names none); `moves` maps each moved file's old path to its new path. Links in code are
 * ignored, like Obsidian does. Markdown-style links `[x](path.md)` to a moved file are reported as unsupported.
 */
export function rewriteLinkTargets(
  text: string,
  resolve: (linkPath: string) => string | undefined,
  moves: ReadonlyMap<string, string>
): LinkRewrite {
  const unsupported: string[] = [];
  let hits = 0,
    out = "",
    cursor = 0;
  for (const link of findWikilinks(text)) {
    const path = resolve(linkPathOf(link.target));
    const to = path === undefined ? undefined : moves.get(path);
    if (path === undefined || to === undefined) continue;
    hits++;
    const next = retargetWikilink(link.original, path, to);
    if (next === null) {
      unsupported.push(link.original);
      continue;
    }
    out += text.slice(cursor, link.start) + next;
    cursor = link.end;
  }
  const code = codeRanges(text);
  for (const match of text.matchAll(/\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)/g)) {
    if (code.some(([from, to]) => match.index >= from && match.index < to)) continue;
    let decoded = match[1];
    try {
      decoded = decodeURIComponent(match[1]);
    } catch {
      /* keep the raw text */
    }
    const path = resolve(linkPathOf(decoded));
    if (path !== undefined && moves.has(path)) {
      hits++;
      unsupported.push(match[0]);
    }
  }
  return { text: out + text.slice(cursor), hits, unsupported };
}
