/** Marks each line that belongs to a fenced code block (fence lines included). */
export function fencedLines(lines: string[]): boolean[] {
  let fence: string | null = null;
  return lines.map(line => {
    const open = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      // A closing fence carries no info string.
      const close = /^\s*(`{3,}|~{3,})\s*$/.exec(line);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
      return true;
    }
    if (open) {
      fence = open[1];
      return true;
    }
    return false;
  });
}

/**
 * Detail sits under the note's `## Detail`, so its own headings start at `###` and each one is at most one level
 * deeper than its parent; the original nesting is kept. Headings in code blocks are text and stay as written.
 */
export function normalizeDetailHeadings(markdown: string): string {
  const lines = markdown.split("\n");
  const code = fencedLines(lines);
  const parents: { original: number; level: number }[] = [];
  return lines
    .map((line, index) => {
      const heading = code[index] ? null : /^(#{1,6})([ \t]+.*|[ \t]*)$/.exec(line);
      if (!heading) return line;
      const original = heading[1].length;
      while (parents.length && parents[parents.length - 1].original >= original) parents.pop();
      const level = Math.min(6, (parents[parents.length - 1]?.level ?? 2) + 1);
      parents.push({ original, level });
      return `${"#".repeat(level)}${heading[2]}`;
    })
    .join("\n");
}

const MATH_LOOKAHEAD_LINES = 20;

interface MathToken {
  line: number;
  start: number;
  kind: "[" | "]" | "(" | ")";
}

/** Same-length copy of a line with inline code spans blanked out, so delimiters inside them are never seen. */
function maskInlineCode(line: string): string {
  let out = "";
  let i = 0;
  while (i < line.length) {
    if (line[i] !== "`") {
      out += line[i++];
      continue;
    }
    let run = 0;
    while (line[i + run] === "`") run++;
    const ticks = "`".repeat(run);
    const close = line.indexOf(ticks, i + run);
    // Only a run of exactly the same length closes the span.
    let end = close;
    while (end !== -1 && (line[end + run] === "`" || line[end - 1] === "`")) {
      end = line.indexOf(ticks, end + 1);
    }
    if (end === -1) {
      out += line.slice(i, i + run);
      i += run;
    } else {
      out += "\u0000".repeat(end + run - i);
      i = end + run;
    }
  }
  return out;
}

/**
 * Obsidian renders math only as `$…$` and `$$…$$`. Models often write LaTeX's `\(…\)` and `\[…\]`, which markdown reads
 * as escaped brackets, so they are converted. Fenced code, inline code, escaped `\\[` and a delimiter without its
 * partner are left as written, and so is `\[text\](url)`. Known ambiguity: a prose `\[a-z\]` regex outside code is
 * indistinguishable from LaTeX and is converted; regexes belong in code spans, which stay untouched. A display block may span lines but never a blank line or a fence.
 */
export function normalizeMathDelimiters(markdown: string): string {
  if (!/\\[[\]()]/.test(markdown)) return markdown;
  const lines = markdown.split("\n");
  const code = fencedLines(lines);
  const masked = lines.map((line, index) => (code[index] ? line : maskInlineCode(line)));
  const tokens: MathToken[] = [];
  masked.forEach((line, index) => {
    if (code[index]) return;
    const pattern = /(\\+)([[\]()])/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(line))) {
      // An even run of backslashes is an escaped backslash followed by a plain bracket.
      if (match[1].length % 2 === 1)
        tokens.push({ line: index, start: match.index + match[1].length - 1, kind: match[2] as MathToken["kind"] });
    }
  });

  const edits: { line: number; start: number; end: number; text: string }[] = [];
  let display: MathToken | null = null;
  let inline: MathToken | null = null;
  let current = -1;
  const blankBetween = (from: number, to: number) => {
    for (let n = from + 1; n <= to; n++) if (code[n] || !lines[n].trim()) return true;
    return false;
  };
  for (const token of tokens) {
    if (token.line !== current) {
      current = token.line;
      inline = null;
    }
    if (display && (token.line - display.line > MATH_LOOKAHEAD_LINES || blankBetween(display.line, token.line - 1)))
      display = null;
    if (token.kind === "[") {
      display = token;
    } else if (token.kind === "]") {
      if (!display) continue;
      if (lines[token.line][token.start + 2] === "(") {
        // `\[text\](url)` is escaped markdown link text, not math.
        display = null;
        continue;
      }
      if (display.line === token.line) {
        const inner = lines[token.line].slice(display.start + 2, token.start).trim();
        if (inner) edits.push({ line: token.line, start: display.start, end: token.start + 2, text: `$$${inner}$$` });
      } else {
        edits.push({ line: display.line, start: display.start, end: display.start + 2, text: "$$" });
        edits.push({ line: token.line, start: token.start, end: token.start + 2, text: "$$" });
      }
      display = null;
    } else if (!display) {
      if (token.kind === "(") inline = token;
      else if (inline) {
        const inner = lines[token.line].slice(inline.start + 2, token.start).trim();
        if (inner && !inner.includes("$"))
          edits.push({ line: token.line, start: inline.start, end: token.start + 2, text: `$${inner}$` });
        inline = null;
      }
    }
  }
  edits.sort((a, b) => (a.line === b.line ? b.start - a.start : a.line - b.line));
  for (const edit of edits) {
    const line = lines[edit.line];
    lines[edit.line] = line.slice(0, edit.start) + edit.text + line.slice(edit.end);
  }
  return lines.join("\n");
}

/** Inline tags whose line-leading use makes Obsidian's editor read the line (and the rest of the note) as an HTML block. */
const INLINE_LINE_START = /^( {0,3})(<\/?(?:sup|sub|kbd|mark|span|small|u|br)(?=[\s/>]))/i;
/** A line that is one complete tag and nothing else (`<br>`, `<span class="x">`, `</span>`): a deliberate HTML line, kept. */
const LONE_TAG = /^ {0,3}<\/?[a-z][a-z0-9-]*(?:\s[^<>]*)?\/?>\s*$/i;
/**
 * The leading character a line-leading inline tag gets: the HTML entity of a zero-width space. Obsidian's editor (like
 * CommonMark) starts an HTML block only when a line's first non-space character is `<`; a line that starts with `&` is an
 * ordinary paragraph line, so the following headings, callouts and fences parse again. The entity renders as nothing, so
 * reading view and live preview show the same text; it is visible in source mode, which says why it is there.
 */
export const INLINE_HTML_LEAD = "&#8203;";

/** Lines of the note's YAML frontmatter (the opening and closing `---` included), when the text starts with one. */
function frontmatterLines(lines: string[]): boolean[] {
  const marks = lines.map(() => false);
  if (!/^---\s*$/.test(lines[0] ?? "")) return marks;
  const end = lines.findIndex((line, index) => index > 0 && /^(?:---|\.\.\.)\s*$/.test(line));
  if (end < 0) return marks;
  for (let index = 0; index <= end; index++) marks[index] = true;
  return marks;
}

/**
 * New AI-written Markdown only: a line that starts with an inline tag (`<sup>`, `<sub>`, `<kbd>`, `<mark>`, `<span>`,
 * `<small>`, `<u>`, `<br>`) and is not a lone tag line gets INLINE_HTML_LEAD before the tag, so it no longer starts with `<`.
 * Fence content is never touched, nor frontmatter when `frontmatter` is set (a whole file). With `range`, fence and
 * frontmatter state come from the whole text but only lines that start inside [start, end) are changed (an inserted
 * replacement). Idempotent: a changed line starts with `&`.
 */
export function guardInlineHtmlLineStarts(
  text: string,
  options: { frontmatter?: boolean; range?: { start: number; end: number } } = {}
): string {
  if (!/<\/?(?:sup|sub|kbd|mark|span|small|u|br)\b/i.test(text)) return text;
  const lines = text.split("\n");
  const code = fencedLines(lines);
  const front = options.frontmatter ? frontmatterLines(lines) : lines.map(() => false);
  let offset = 0;
  return lines
    .map((line, index) => {
      const start = offset;
      offset += line.length + 1;
      if (code[index] || front[index]) return line;
      if (options.range && (start < options.range.start || start >= options.range.end)) return line;
      const match = INLINE_LINE_START.exec(line);
      if (!match || LONE_TAG.test(line)) return line;
      return `${match[1]}${INLINE_HTML_LEAD}${line.slice(match[1].length)}`;
    })
    .join("\n");
}
