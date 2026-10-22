/**
 * One definition of "Markdown code" for both the cleaner (which leaves code untouched) and the leak scanner (which
 * lets `[[` inside code pass). Sharing it keeps the two from disagreeing, which would be a privacy bypass.
 *
 * Only well-formed code counts: a fenced block closed by a matching fence, and an inline span whose backtick runs
 * pair up inside one paragraph. A backtick run preceded by an odd number of backslashes is escaped (CommonMark: the
 * first backtick of the run is a literal), so it cannot open a span. Anything unclosed, unpaired or escaped stays
 * prose, so it can never hide a `[[` that follows it. Doubt always resolves to "not code".
 */
export interface CodeRange {
  start: number;
  end: number;
}

/** A fence line: up to 3 spaces, then 3+ backticks or tildes. */
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})/;
const BLANK_LINE = /\n[ \t]*\n/;

function fenceRanges(markdown: string): CodeRange[] {
  const ranges: CodeRange[] = [];
  const lines = markdown.split("\n");
  const offsets: number[] = [];
  let at = 0;
  for (const line of lines) {
    offsets.push(at);
    at += line.length + 1;
  }
  for (let i = 0; i < lines.length; i++) {
    const open = FENCE_LINE.exec(lines[i]);
    if (!open) continue;
    const mark = open[1];
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

function inlineRanges(text: string, base: number): CodeRange[] {
  const runs: { start: number; length: number }[] = [];
  for (const match of text.matchAll(/`+/g)) runs.push({ start: match.index ?? 0, length: match[0].length });
  const ranges: CodeRange[] = [];
  for (let i = 0; i < runs.length; i++) {
    let { start, length } = runs[i];
    let slashes = 0;
    while (start - slashes > 0 && text[start - slashes - 1] === "\\") slashes++;
    if (slashes % 2 === 1) {
      // Escaped: the first backtick is a literal; whatever is left of the run may still open a span.
      start += 1;
      length -= 1;
      if (length === 0) continue;
    }
    for (let j = i + 1; j < runs.length; j++) {
      if (BLANK_LINE.test(text.slice(runs[i].start + runs[i].length, runs[j].start))) break;
      if (runs[j].length === length) {
        ranges.push({ start: base + start, end: base + runs[j].start + runs[j].length });
        i = j;
        break;
      }
    }
  }
  return ranges;
}

/** Sorted, non-overlapping code ranges of the text (fenced blocks and inline spans). */
export function markdownCodeRanges(markdown: string): CodeRange[] {
  const fences = fenceRanges(markdown);
  const ranges: CodeRange[] = [...fences];
  let from = 0;
  for (const fence of [...fences, { start: markdown.length, end: markdown.length }]) {
    ranges.push(...inlineRanges(markdown.slice(from, fence.start), from));
    from = fence.end;
  }
  return ranges.sort((a, b) => a.start - b.start);
}

/** Replaces each code range with `replacement`. */
export function replaceMarkdownCode(markdown: string, replacement: string): string {
  let out = "";
  let from = 0;
  for (const range of markdownCodeRanges(markdown)) {
    out += markdown.slice(from, range.start) + replacement;
    from = range.end;
  }
  return out + markdown.slice(from);
}

/**
 * Removes `<!-- … -->` comments that start outside code. The comment ends at the first `-->` after it, even when
 * code sits inside the comment (the whole comment is hidden from readers, so it goes). An unclosed `<!--` stays.
 */
export function stripHtmlComments(markdown: string): string {
  let text = markdown;
  let searchFrom = 0;
  for (;;) {
    const ranges = markdownCodeRanges(text);
    let start = text.indexOf("<!--", searchFrom);
    while (start >= 0 && ranges.some(range => start >= range.start && start < range.end))
      start = text.indexOf("<!--", start + 1);
    if (start < 0) return text;
    const close = text.indexOf("-->", start + 4);
    if (close < 0) return text;
    text = text.slice(0, start) + text.slice(close + 3);
    searchFrom = start;
  }
}
