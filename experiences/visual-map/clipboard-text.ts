import { titleProblem } from "../../core/title-safety";
import {
  OUTLINE_NODE_LIMIT,
  OUTLINE_TITLE_LIMIT,
  outlineTitle,
  parseOutline,
  type OutlineNode
} from "./outline-import";

/** Longest pasted text accepted, in UTF-16 code units; checked before any parsing (decision D6). */
export const PASTE_TEXT_MAX_CHARS = 100_000;
/** Columns one tab counts for when the indentation is measured. */
const TAB_COLUMNS = 4;

export type IndentedTextRejection =
  | "too-long"
  | "too-many-nodes"
  | "empty-title"
  | "title-too-long"
  | "title-fence"
  | "title-brackets"
  | "bad-title"
  | "vam-note"
  | "outline";
export type IndentedTextParse =
  { ok: true; nodes: OutlineNode[] } | { ok: false; reason: IndentedTextRejection; line?: number };

const MARKDOWN_HEADING = /^ {0,3}#{1,6}[ \t]+\S/m;
const LIST_MARKER = /^(?:[-*+]|\d{1,9}[.)])(?:[ \t]+|$)/;
const CHECKBOX = /^\[[ xX]\](?:[ \t]+|$)/;
// C0, DEL, C1, and the Unicode line and paragraph separators: nothing that can break a title across lines.
// eslint-disable-next-line no-control-regex -- the control characters are exactly what is being refused
const TITLE_FORBIDDEN = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

const reject = (reason: IndentedTextRejection, line?: number): IndentedTextParse =>
  line === undefined ? { ok: false, reason } : { ok: false, reason, line };

/** Leading width in columns (space = 1, tab = 4) and the rest of the line. */
function splitIndent(line: string): { indent: number; rest: string } {
  let indent = 0;
  let index = 0;
  for (; index < line.length; index++) {
    if (line[index] === " ") indent++;
    else if (line[index] === "\t") indent += TAB_COLUMNS;
    else break;
  }
  return { indent, rest: line.slice(index) };
}

/**
 * Turns pasted plain text into outline nodes. The text is untrusted: it is refused whole, with a reason and the line
 * number, rather than truncated or rewritten (D-2026-10-95). Never throws.
 */
export function parseIndentedText(text: string): IndentedTextParse {
  try {
    if (typeof text !== "string") return reject("bad-title");
    if (text.length > PASTE_TEXT_MAX_CHARS) return reject("too-long");
    const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    if (!source.trim()) return { ok: true, nodes: [] };
    if (source.includes("<!-- visual-agent-map:")) return reject("vam-note");
    if (MARKDOWN_HEADING.test(source)) {
      const parsed = parseOutline(source);
      if (parsed.errors.length) {
        const first = parsed.errors[0];
        const reason = first.key === "ui.outline_error_vam_note" ? "vam-note" : "outline";
        return reject(reason, first.line > 0 ? first.line : undefined);
      }
      return { ok: true, nodes: parsed.nodes };
    }
    const nodes: OutlineNode[] = [];
    const stack: { indent: number; node: OutlineNode }[] = [];
    const lines = source.split(/\r\n?|\n/);
    for (let position = 0; position < lines.length; position++) {
      const lineNumber = position + 1;
      const { indent, rest } = splitIndent(lines[position]);
      if (!rest.trim()) continue;
      const marker = LIST_MARKER.exec(rest);
      let body = marker ? rest.slice(marker[0].length) : rest;
      const box = marker ? CHECKBOX.exec(body) : null;
      if (box) body = body.slice(box[0].length);
      const title = outlineTitle(body);
      if (!title) return reject("empty-title", lineNumber);
      if (TITLE_FORBIDDEN.test(title)) return reject("bad-title", lineNumber);
      if ([...title].length > OUTLINE_TITLE_LIMIT) return reject("title-too-long", lineNumber);
      const problem = titleProblem(title);
      if (problem) return reject(`title-${problem}`, lineNumber);
      if (nodes.length >= OUTLINE_NODE_LIMIT) return reject("too-many-nodes", lineNumber);
      while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
      const parent = stack.length ? stack[stack.length - 1].node : null;
      const node: OutlineNode = {
        index: nodes.length,
        title,
        level: parent ? parent.level + 1 : 0,
        parent: parent ? parent.index : null,
        line: lineNumber
      };
      nodes.push(node);
      stack.push({ indent, node });
    }
    return { ok: true, nodes };
  } catch {
    return reject("bad-title");
  }
}
