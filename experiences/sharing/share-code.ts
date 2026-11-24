/**
 * What the cleaner treats as "Markdown code" (it leaves code untouched and rewrites everything else). This is only
 * a presentation heuristic: the privacy decision is made on the rendered DOM (share-dom.ts countLocalReferences),
 * not on this guess. It still errs toward "not code": a guess that is too wide would leave a `[[link]]` in place that
 * Obsidian renders as a link (the gate then blocks the export), so every doubt resolves to prose.
 *
 * Input must already use `\n` line endings (cleanShareMarkdown normalizes them first).
 *  - Fenced block: opened and closed by matching fences; a backtick fence's info string has no backtick; a fence
 *    opener inside an HTML block is not a fence; unclosed means prose.
 *  - Inline code: one line only. Lines that contain `|`, `<`, `$` or `\`, fence-looking lines and 4-space indented
 *    lines never hold inline code (tables, raw HTML, math and escapes are where the guess is most likely wrong).
 */
export interface CodeRange {
  start: number;
  end: number;
}

/** A fence line: up to 3 spaces, then 3+ backticks or tildes. */
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})/;

const VOID_TAGS = new Set([
  "br",
  "hr",
  "img",
  "input",
  "meta",
  "link",
  "area",
  "base",
  "col",
  "embed",
  "source",
  "wbr"
]);

/** Line ranges (as [firstLine, lastLine]) that belong to an HTML block, in which Markdown fences do not apply. */
function htmlBlockLines(lines: string[]): [number, number][] {
  const blocks: [number, number][] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const open = /^ {0,3}<(!--|\/?([A-Za-z][A-Za-z0-9-]*)(?=[\s/>]|$))/.exec(line);
    if (!open) {
      i++;
      continue;
    }
    let last = i;
    if (open[1] === "!--") {
      while (last < lines.length && !lines[last].includes("-->")) last++;
    } else {
      const name = (open[2] ?? "").toLowerCase();
      const closes = (text: string): boolean => text.toLowerCase().includes(`</${name}`);
      if (open[1].startsWith("/") || VOID_TAGS.has(name) || closes(line)) {
        while (last + 1 < lines.length && lines[last + 1].trim() !== "") last++;
      } else {
        // An opened element: it lasts until its closing tag, or to the end of the text when it never closes.
        while (last < lines.length && !closes(lines[last])) last++;
      }
    }
    last = Math.min(last, lines.length - 1);
    blocks.push([i, last]);
    i = last + 1;
  }
  return blocks;
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;

function fenceRanges(lines: string[], offsets: number[], html: [number, number][]): CodeRange[] {
  const ranges: CodeRange[] = [];
  const inHtml = (line: number): boolean => html.some(([first, last]) => line >= first && line <= last);
  for (let i = 0; i < lines.length; i++) {
    const open = FENCE_OPEN.exec(lines[i]);
    if (!open || inHtml(i)) continue;
    const mark = open[1];
    if (mark[0] === "`" && open[2].includes("`")) continue;
    for (let j = i + 1; j < lines.length; j++) {
      const run = FENCE_LINE.exec(lines[j]);
      if (run && run[1][0] === mark[0] && run[1].length >= mark.length && lines[j].slice(run[0].length).trim() === "") {
        ranges.push({ start: offsets[i], end: offsets[j] + lines[j].length });
        i = j;
        break;
      }
    }
  }
  return ranges;
}

function inlineRangesOfLine(line: string, base: number): CodeRange[] {
  if (/[|<$\\]/.test(line) || FENCE_LINE.test(line) || /^ {4}|^\t/.test(line)) return [];
  const runs: { start: number; length: number }[] = [];
  for (const match of line.matchAll(/`+/g)) runs.push({ start: match.index ?? 0, length: match[0].length });
  const ranges: CodeRange[] = [];
  for (let i = 0; i < runs.length; i++) {
    for (let j = i + 1; j < runs.length; j++) {
      if (runs[j].length === runs[i].length) {
        ranges.push({ start: base + runs[i].start, end: base + runs[j].start + runs[j].length });
        i = j;
        break;
      }
    }
  }
  return ranges;
}

const inside = (ranges: CodeRange[], at: number): boolean => ranges.some(range => at >= range.start && at < range.end);

/** Sorted, non-overlapping code ranges of the text (fenced blocks and single-line inline spans). Needs `\n` line endings. */
export function markdownCodeRanges(markdown: string): CodeRange[] {
  const lines = markdown.split("\n");
  const offsets: number[] = [];
  let at = 0;
  for (const line of lines) {
    offsets.push(at);
    at += line.length + 1;
  }
  const fences = fenceRanges(lines, offsets, htmlBlockLines(lines));
  const ranges: CodeRange[] = [...fences];
  lines.forEach((line, index) => {
    if (inside(fences, offsets[index])) return;
    ranges.push(...inlineRangesOfLine(line, offsets[index]));
  });
  return ranges.sort((a, b) => a.start - b.start);
}

export const normalizeNewlines = (text: string): string => text.replace(/\r\n?/g, "\n");

/** Ranges of Obsidian comments (`%%…%%`, `<!--…-->`, possibly multi-line) outside code; an unclosed one runs to the end. Needs `\n` line endings. */
export function commentRanges(markdown: string, code: CodeRange[] = markdownCodeRanges(markdown)): CodeRange[] {
  const ranges: CodeRange[] = [];
  const open = /%%|<!--/g;
  let at = 0;
  while (at < markdown.length) {
    open.lastIndex = at;
    const found = open.exec(markdown);
    if (!found) break;
    if (inside(code, found.index)) {
      at = found.index + 1;
      continue;
    }
    const closer = found[0] === "%%" ? "%%" : "-->";
    const close = markdown.indexOf(closer, found.index + found[0].length);
    const end = close < 0 ? markdown.length : close + closer.length;
    ranges.push({ start: found.index, end });
    at = end;
  }
  return ranges;
}

/** Code and comment ranges together, sorted and merged: text the cleaner and exporter must leave exactly as written. */
export function markdownProtectedRanges(markdown: string): CodeRange[] {
  const code = markdownCodeRanges(markdown);
  const all = [...code, ...commentRanges(markdown, code)].sort((a, b) => a.start - b.start);
  const merged: CodeRange[] = [];
  for (const range of all) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

/** Removes comments (outside code) the way Obsidian's embeds do not show them. */
export function stripComments(markdown: string): string {
  let result = "";
  let from = 0;
  for (const range of commentRanges(markdown)) {
    result += markdown.slice(from, range.start);
    from = range.end;
  }
  return result + markdown.slice(from);
}

const SHARE_IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;
/**
 * What an embed target is, from its path alone. One rule for `![[…]]` and `![](…)` (Diagnostic Reset, share-export-complete):
 * a note (`.md` or no extension) is never shipped as a file, an image becomes an asset, anything else is an attachment.
 */
export function classifyShareTarget(path: string): "note" | "image" | "attachment" {
  const clean = path.split(/[?#]/)[0].trim();
  if (SHARE_IMAGE_EXT.test(clean)) return "image";
  // Short extensions are files; a longer word after a dot is a note title (`Q3.Planning`) unless it is a known file type.
  const ext = /\.([a-z0-9]{1,5}|canvas|keynote|numbers|sketch|excalidraw)$/i.exec(clean);
  return !ext || ext[1].toLowerCase() === "md" ? "note" : "attachment";
}
