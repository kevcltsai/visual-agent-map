import { neutralizeUnsafeMermaid } from "../../../ai/mermaid-safety";

export const CHART_SHAPES = [
  "stages",
  "hierarchy",
  "comparison",
  "proportion",
  "interaction",
  "states",
  "process"
] as const;
export type ChartShape = (typeof CHART_SHAPES)[number];
export interface ChartDraft {
  anchor: string;
  shape: ChartShape;
  mermaid: string;
}

/** The reason the whole reply was refused; none of them carries note content. */
export type ChartCode =
  | "invalid_reply"
  | "over_cap"
  | "bad_body"
  | "unsafe_or_header"
  | "unparsable"
  | "number_not_in_note"
  | "anchor_missing"
  | "anchor_not_unique"
  | "anchor_bad_block"
  | "anchor_shared"
  | "counts_changed"
  | "runtime_error";

export type ApplyChartsResult = { ok: true; detail: string } | { ok: false; code: ChartCode; index: number };

/** Digits that belong to an identifier (A1, v2, C4, H2O, quadrant-1) are not quantities. */
export function numberTokens(text: string): string[] {
  const s = text.normalize("NFKC"),
    out: string[] = [];
  const re = /\d{1,3}(?:,\d{3})+(?!\d)(?:\.\d+)?|\d+(?:\.\d+)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const p = m.index > 0 ? s[m.index - 1] : "",
      pp = m.index > 1 ? s[m.index - 2] : "";
    if (/[A-Za-z_]/.test(p)) continue;
    if (p === "-" && /[A-Za-z]/.test(pp)) continue;
    out.push(m[0].replace(/,/g, ""));
  }
  return out;
}

/** Numbers a chart may use: those in the note body, never in diagrams, link targets, URLs, footnote markers or comments. */
export function noteNumbers(detail: string): Set<string> {
  let t = detail.replace(/\r\n/g, "\n");
  t = t.replace(/^[ \t]*(`{3,}|~{3,})[ \t]*mermaid[^\n]*\n[\s\S]*?\n[ \t]*\1[ \t]*$/gm, "");
  t = t
    .replace(/\]\([^)]*\)/g, "]")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\[\^[^\]]*\]/g, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  return new Set(numberTokens(t));
}

export function existingDiagrams(detail: string): { count: number; types: string[] } {
  const lines = detail.replace(/\r\n/g, "\n").split("\n"),
    types: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(`{3,}|~{3,})\s*mermaid\b/.test(lines[i])) {
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      types.push((lines[j] ?? "").trim().split(/\s+/)[0] || "?");
    }
  }
  return { count: types.length, types };
}

/** Marks every line inside a code or mermaid fence, including the fence lines. */
function fenceMask(lines: string[]): boolean[] {
  const mask = new Array<boolean>(lines.length).fill(false);
  let open: string | null = null;
  lines.forEach((l, i) => {
    const m = /^\s*(`{3,}|~{3,})/.exec(l);
    if (open) {
      mask[i] = true;
      if (m && m[1][0] === open[0] && m[1].length >= open.length && l.trim() === m[1]) open = null;
    } else if (m) {
      mask[i] = true;
      open = m[1];
    }
  });
  return mask;
}

function blockOf(lines: string[], mask: boolean[], idx: number): [number, number] {
  let a = idx,
    b = idx;
  while (a > 0 && lines[a - 1].trim() && !mask[a - 1]) a--;
  while (b < lines.length - 1 && lines[b + 1].trim() && !mask[b + 1]) b++;
  return [a, b];
}

const BAD_LINE = /^\s*(>|#{1,6}\s|[-*+]\s|\d+[.)]\s|\$\$|<|\[\^|```|~~~)/;

function anchorCheck(
  lines: string[],
  mask: boolean[],
  anchor: string
): { code: ChartCode | null; block?: [number, number] } {
  const hits: number[] = [],
    a = anchor.trim();
  lines.forEach((l, i) => {
    if (!mask[i] && l.trim() === a) hits.push(i);
  });
  if (hits.length === 0) return { code: "anchor_missing" };
  if (hits.length > 1) return { code: "anchor_not_unique" };
  const block = blockOf(lines, mask, hits[0]);
  const blk = lines.slice(block[0], block[1] + 1);
  if (blk.some(l => BAD_LINE.test(l))) return { code: "anchor_bad_block", block };
  const tableLines = blk.filter(l => /^\s*\|/.test(l)).length;
  if (tableLines !== 0 && tableLines !== blk.length) return { code: "anchor_bad_block", block };
  return { code: null, block };
}

const SEQ_ALIAS = /^(\s*(?:participant|actor)\s+\S+\s+as\s+)"([^"]+)"(\s*)$/;
const SEQ_MESSAGE = /^(\s*[^:\n]*?(?:-->>|->>|--x|-x|--\)|-\)|-->|->)[^:\n]*:\s*)"([^"]+)"(\s*)$/;
const SEQ_NOTE = /^(\s*note\s+(?:left of|right of|over)\s+[^:]+:\s*)"([^"]+)"(\s*)$/i;

/**
 * sequenceDiagram only: Mermaid renders wrapping double quotes in participant aliases and message/note text
 * literally, so one wrapping pair is removed there. Other diagram types keep their quotes.
 */
function stripSequenceQuotes(body: string): string {
  const lines = body.split("\n");
  const first = lines.find(l => l.trim() !== "");
  if (first === undefined || !/^\s*sequenceDiagram\b/.test(first)) return body;
  return lines
    .map(line => {
      for (const re of [SEQ_ALIAS, SEQ_NOTE, SEQ_MESSAGE]) {
        const m = re.exec(line);
        if (m) return m[1] + m[2] + m[3];
      }
      return line;
    })
    .join("\n");
}

function normBody(body: string): string {
  return stripSequenceQuotes(body.replace(/\r\n/g, "\n").trim());
}

export interface ApplyChartsOptions {
  /** How many diagrams may still be added (3 minus the diagrams already in the note). */
  remaining: number;
  /** The mermaid parser; absent means the parse check is skipped. */
  parses?: (code: string) => Promise<boolean>;
}

/**
 * All or nothing. Validates every chart (V1-V8) and inserts them below their anchors' blocks; the first failure
 * voids the whole reply and returns its code. The model never rewrites body text: the result is the input plus the
 * inserted mermaid segments, so removing them gives the input back exactly.
 */
export async function applyCharts(
  detail: string,
  charts: readonly ChartDraft[],
  options: ApplyChartsOptions
): Promise<ApplyChartsResult> {
  if (charts.length > options.remaining) return { ok: false, code: "over_cap", index: 0 };
  const lines = detail.split("\n"),
    mask = fenceMask(lines),
    noteNums = noteNumbers(detail);
  const used = new Set<string>(),
    items: { body: string; block: [number, number] }[] = [];
  for (let index = 0; index < charts.length; index++) {
    const chart = charts[index],
      body = normBody(chart.mermaid);
    const fail = (code: ChartCode): ApplyChartsResult => ({ ok: false, code, index });
    const nonBlank = body.split("\n").filter(l => l.trim()).length;
    if (body.includes("```") || body.includes("~~~") || nonBlank > 30 || body.length > 1500) return fail("bad_body");
    const fence = "```mermaid\n" + body + "\n```";
    if (neutralizeUnsafeMermaid(fence) !== fence) return fail("unsafe_or_header");
    if (options.parses) {
      let ok = true;
      try {
        ok = await options.parses(body);
      } catch {
        ok = false;
      }
      if (!ok) return fail("unparsable");
    }
    const tokens = numberTokens(body.replace(/^\s*\S+/, ""));
    if (tokens.some(n => !noteNums.has(n))) return fail("number_not_in_note");
    const anchor = anchorCheck(lines, mask, chart.anchor);
    if (anchor.code) return fail(anchor.code);
    const block = anchor.block as [number, number];
    const key = block.join("-");
    if (used.has(key)) return fail("anchor_shared");
    used.add(key);
    items.push({ body, block });
  }
  const out = [...lines];
  for (const item of [...items].sort((a, b) => b.block[1] - a.block[1])) {
    const end = item.block[1];
    const cr = lines[end].endsWith("\r") ? "\r" : "";
    const segment = ["", "```mermaid", ...item.body.split("\n"), "```"];
    const next = lines[end + 1];
    if (next !== undefined && next.trim() !== "") segment.push("");
    out.splice(end + 1, 0, ...segment.map(line => line + cr));
  }
  const final = out.join("\n");
  if (neutralizeUnsafeMermaid(detail) === detail && neutralizeUnsafeMermaid(final) !== final)
    return { ok: false, code: "unsafe_or_header", index: 0 };
  return { ok: true, detail: final };
}
