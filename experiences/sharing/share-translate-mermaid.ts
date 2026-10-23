/**
 * Diagram translation helpers (D-2026-10-116). A shared diagram is an SVG without its source, so the exporter keeps
 * the Mermaid source the renderer showed, this module cuts the labels out of it, and the translated source is drawn
 * again. Only label text changes; everything the translated source could do beyond drawing (links, clicks, scripts)
 * is refused. Pure text, no DOM, no obsidian import.
 *
 * Label extraction covers flowchart/graph, sequence, mindmap, pie, gantt, journey and timeline diagrams. A diagram
 * of another kind contributes its quoted strings and `title` line; a diagram with nothing to translate is skipped
 * and keeps its original drawing.
 */

/** Lines that start with `%%` are comments or directives (`%%{init: …}%%`); a trailing `%%` comment is cut too. */
export function stripMermaidComments(source: string): string {
  const lines: string[] = [];
  for (const raw of source.replace(/\r\n?/g, "\n").split("\n")) {
    if (raw.trim().startsWith("%%")) continue;
    let inQuote = false;
    let cut = raw.length;
    for (let i = 0; i < raw.length; i++) {
      if (raw[i] === '"') inQuote = !inQuote;
      else if (!inQuote && raw[i] === "%" && raw[i + 1] === "%") {
        cut = i;
        break;
      }
    }
    lines.push(raw.slice(0, cut).replace(/\s+$/, ""));
  }
  return lines.join("\n").trim();
}

const UNSAFE_LINE = /^\s*(?:click|call|link|links|callback)\b/im;
const UNSAFE_TEXT =
  /\bhref\b|javascript:|data:text\/html|<\s*script|<\s*iframe|\bon(?:click|mouse[a-z]*|load|error|focus|key[a-z]*)\s*=/i;
/** True when a diagram source could run or open something: click/call/link statements, href, script-ish text. */
export function isUnsafeMermaid(source: string): boolean {
  return UNSAFE_LINE.test(source) || UNSAFE_TEXT.test(source);
}

export interface MermaidSpan {
  start: number;
  end: number;
  /** The label sits between double quotes in the source. */
  quoted: boolean;
}

const FLOW_OPEN = String.raw`\(\(\(|\(\(|\(\[|\[\[|\[\(|\[\/|\[\\|\[|\(|\{\{|\{|(?<=\w)>`;
const FLOW_BRACKET = new RegExp(`(?:${FLOW_OPEN})([^"\\]\\)\\}\\n|]+)`, "g");
const FLOW_SKIP_LINE = /^\s*(?:style|classDef|class|linkStyle|direction|accTitle|accDescr)\b/;
const diagramType = (source: string): string => /^\s*([A-Za-z][A-Za-z-]*)/.exec(source)?.[1].toLowerCase() ?? "";

function overlaps(a: MermaidSpan, spans: readonly MermaidSpan[]): boolean {
  return spans.some(b => a.start < b.end && b.start < a.end);
}

function lineSpans(source: string): { text: string; offset: number }[] {
  const lines: { text: string; offset: number }[] = [];
  let offset = 0;
  for (const text of source.split("\n")) {
    lines.push({ text, offset });
    offset += text.length + 1;
  }
  return lines;
}

/** Spans of text after a keyword or separator, trimmed: `title X`, `participant A as X`, `Note over A: X`. */
function tailSpan(line: string, from: number, offset: number): MermaidSpan | null {
  const rest = line.slice(from);
  const lead = rest.length - rest.trimStart().length;
  const text = rest.trim();
  if (!text) return null;
  return { start: offset + from + lead, end: offset + from + lead + text.length, quoted: false };
}

/** The label spans of a cleaned (comment-free) diagram source, in text order, never overlapping. */
export function mermaidLabelSpans(source: string): MermaidSpan[] {
  const type = diagramType(source);
  const spans: MermaidSpan[] = [];
  const add = (span: MermaidSpan | null): void => {
    if (span && span.end > span.start && !overlaps(span, spans)) spans.push(span);
  };
  const lines = lineSpans(source);
  // Quoted strings first: they win over any bracket that happens to sit inside them.
  for (const { text, offset } of lines) {
    if (FLOW_SKIP_LINE.test(text)) continue;
    for (const match of text.matchAll(/"([^"\n]+)"/g))
      add({
        start: offset + (match.index ?? 0) + 1,
        end: offset + (match.index ?? 0) + 1 + match[1].length,
        quoted: true
      });
  }
  const flow = type === "flowchart" || type === "graph";
  for (const { text, offset } of lines) {
    const trimmed = text.trim();
    if (!trimmed || FLOW_SKIP_LINE.test(text)) continue;
    if (flow) {
      for (const match of text.matchAll(/\|([^|"\n]+)\|/g))
        add({
          start: offset + (match.index ?? 0) + 1,
          end: offset + (match.index ?? 0) + 1 + match[1].length,
          quoted: false
        });
      for (const match of text.matchAll(/(?:--|==|-\.)\s+([^\n>|"=-][^\n|"]*?)\s+(?:-->|==>|\.->|---|===|-\.-)/g)) {
        const at = (match.index ?? 0) + match[0].indexOf(match[1]);
        add({ start: offset + at, end: offset + at + match[1].length, quoted: false });
      }
    }
    if (flow || type === "mindmap" || type === "statediagram" || type === "statediagram-v2") {
      for (const match of text.matchAll(FLOW_BRACKET)) {
        const open = match[0].length - match[1].length;
        const inner = match[1].replace(/[\\/]\s*$/, "");
        add({
          start: offset + (match.index ?? 0) + open,
          end: offset + (match.index ?? 0) + open + inner.length,
          quoted: false
        });
      }
    }
    if (
      type === "mindmap" &&
      !trimmed.startsWith("::") &&
      !spans.some(span => span.start >= offset && span.end <= offset + text.length)
    ) {
      if (trimmed !== "mindmap") add(tailSpan(text, 0, offset));
    }
    if (type === "sequencediagram") {
      const aliased = /^\s*(?:participant|actor)\s+\S+\s+as\s+/i.exec(text);
      if (aliased) add(tailSpan(text, aliased[0].length, offset));
      const note = /^\s*note\s+(?:over|left of|right of)\s+[^:\n]+:/i.exec(text);
      if (note) add(tailSpan(text, note[0].length, offset));
      const message = /^\s*[^\s:]+\s*(?:-->>|->>|--x|-x|--\)|-\)|-->|->)[+-]?\s*[^\s:]+\s*:/.exec(text);
      if (message) add(tailSpan(text, message[0].length, offset));
      const block = /^\s*(?:loop|alt|else|opt|par|and|critical|option|break|rect)\b/i.exec(text);
      if (block && !/^\s*rect\b/i.test(text)) add(tailSpan(text, block[0].length, offset));
    }
    const titled = /^\s*(?:pie\s+(?:showData\s+)?)?(?:title|accTitle)\s/i.exec(text);
    if (type !== "flowchart" && type !== "graph" && titled) add(tailSpan(text, titled[0].length, offset));
    if (["gantt", "journey", "timeline"].includes(type)) {
      const section = /^\s*(?:section|title)\s+/i.exec(text);
      if (section) add(tailSpan(text, section[0].length, offset));
      else if (trimmed !== type && !/^\s*(?:dateFormat|axisFormat|excludes|tickInterval|todayMarker)\b/i.test(text)) {
        const colon = text.indexOf(":");
        if (type === "timeline") {
          // `2002 : LinkedIn` — the period stays, each event after a colon is a label.
          let from = colon;
          while (from >= 0) {
            const next = text.indexOf(":", from + 1);
            add(tailSpan(text.slice(0, next < 0 ? text.length : next), from + 1, offset));
            from = next;
          }
        } else if (colon > 0) add(tailSpan(text.slice(0, colon), 0, offset));
      }
    }
  }
  return spans.sort((a, b) => a.start - b.start);
}

const BR_TAG = /<br\s*\/?>/gi;
/** A translated label may not carry anything that could change the diagram's structure or script it. */
export function isSafeMermaidLabel(translated: string, quoted: boolean): boolean {
  const text = translated.replace(BR_TAG, " ");
  if (!text.trim() || /[\r\n]/.test(text)) return false;
  if (text.includes("%%") || UNSAFE_TEXT.test(text)) return false;
  return quoted ? !/["<>`]/.test(text) : !/[[\]{}()|"`;<>#%]/.test(text);
}

export interface MermaidTranslationPlan {
  /** The comment-free source the labels were cut from. */
  cleaned: string;
  /** Labels to translate, in source order. */
  labels: string[];
  /** The source with `translated[i]` in place of label i; a missing or unsafe translation leaves that label as it was. */
  rebuild(translated: ReadonlyArray<string | undefined>): { source: string; applied: number };
}
export type MermaidPrepared = { ok: false; reason: "unsafe" | "no-labels" } | ({ ok: true } & MermaidTranslationPlan);

/**
 * Strips `%%` lines, refuses sources that click, call or link, and cuts out the labels that contain letters.
 * The returned `rebuild` re-checks the finished source: if anything unsafe appeared it returns the cleaned original.
 */
export function prepareMermaidTranslation(source: string): MermaidPrepared {
  const cleaned = stripMermaidComments(source);
  if (!cleaned || isUnsafeMermaid(cleaned)) return { ok: false, reason: "unsafe" };
  const spans = mermaidLabelSpans(cleaned).filter(span => /\p{L}/u.test(cleaned.slice(span.start, span.end)));
  if (!spans.length) return { ok: false, reason: "no-labels" };
  return {
    ok: true,
    cleaned,
    labels: spans.map(span => cleaned.slice(span.start, span.end)),
    rebuild: translated => {
      let out = cleaned;
      let applied = 0;
      for (let i = spans.length - 1; i >= 0; i--) {
        const text = translated[i]?.trim();
        if (text === undefined || !isSafeMermaidLabel(text, spans[i].quoted)) continue;
        out = out.slice(0, spans[i].start) + text + out.slice(spans[i].end);
        applied++;
      }
      return isUnsafeMermaid(out) ? { source: cleaned, applied: 0 } : { source: out, applied };
    }
  };
}
