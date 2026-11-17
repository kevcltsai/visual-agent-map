/**
 * Picture slots of the picture-book pipeline (plan R1-2, R1-8, R2-1). The planner decides a card's slots (`## Prompt` image plan),
 * the author leaves one marker line `〔圖位 n：要說明的事〕` after the paragraph each slot belongs to, and a later step swaps the markers
 * for verified pictures. This file holds the pure parts: the slot type, the marker grammar and its scan, the residual check and the
 * `pickForSlot` seam (the picture-quality work replaces only that function). No I/O, no model text is trusted here.
 */

/** One planned picture position. `index` is assigned by the program in order (1..n); the model never writes it. */
export interface ImageSlot {
  index: number;
  /** The kind of picture (painting, map, diagram, ...): one short line. */
  kind: string;
  /** What the picture must show or explain: one line, never contains the marker brackets. */
  explains: string;
  /** Where in the chapter it sits (for example "after the paragraph on perspective"). */
  anchor: string;
}

/** The planner may arrange at most this many slots for one card. */
export const MAX_IMAGE_SLOTS = 8;

/** Why a slot ended without a picture. Only `author_omitted` and `bad_marker` come from the marker scan. */
export type SlotReasonCode = "author_omitted" | "bad_marker" | "not_found" | "load_failed" | "unsafe_url";

/** Text of a slot field: one line, with the marker brackets and the Prompt field separator taken out. */
export function cleanSlotText(value: string, max: number): string {
  const text = value
    .replace(/[〔〕｜]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(text).slice(0, max).join("").trim();
}

/** The marker the author is asked to write for a slot. */
export function composeSlotMarker(slot: Pick<ImageSlot, "index" | "explains">): string {
  return `〔圖位 ${slot.index}：${slot.explains}〕`;
}

const STANDALONE_MARKER = /^\s*〔圖位 ([1-9]\d*)：([^〔〕]+?)〕\s*$/;
const MARKER_OPEN = "〔圖位";
const OPEN_FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const QUOTE_LINE = /^ {0,3}>/;

/** Per line: true when the line is inside a code fence (fence lines included) or is a quote line. Markers there are kept as they are. */
export function protectedLines(lines: readonly string[]): boolean[] {
  const out: boolean[] = [];
  let fence: { char: string; size: number } | undefined;
  for (const line of lines) {
    if (fence) {
      out.push(true);
      const close = OPEN_FENCE.exec(line);
      if (close && close[1][0] === fence.char && close[1].length >= fence.size && !close[2].trim()) fence = undefined;
      continue;
    }
    const open = OPEN_FENCE.exec(line);
    if (open && !(open[1][0] === "`" && open[2].includes("`"))) {
      fence = { char: open[1][0], size: open[1].length };
      out.push(true);
      continue;
    }
    out.push(QUOTE_LINE.test(line));
  }
  return out;
}

export interface SlotScan {
  /** Slot index -> 0-based line of its first valid marker. */
  found: Map<number, number>;
  /** Whole lines to delete: a valid marker repeated for an index already found. */
  duplicateLines: number[];
  /** Whole lines to delete: a marker line with an index the plan does not have, or a reworded marker (`reason=bad_marker`). */
  badLines: number[];
  /** Lines whose marker is part of other text: delete only the marker text, keep the rest of the line. */
  inlineLines: number[];
  /** Plan indexes with no valid marker (`reason=author_omitted`). */
  omitted: number[];
}

/**
 * Classifies every `〔圖位` marker of a chapter body against the planned slots. Markers in code fences and quotes are not counted
 * and not listed (they stay as written). Pure; line numbers are 0-based over `content.split(/\r?\n/)`.
 */
export function scanSlotMarkers(content: string, slots: readonly Pick<ImageSlot, "index">[]): SlotScan {
  const lines = content.split(/\r?\n/);
  const guarded = protectedLines(lines);
  const planned = new Set(slots.map(slot => slot.index));
  const scan: SlotScan = { found: new Map(), duplicateLines: [], badLines: [], inlineLines: [], omitted: [] };
  lines.forEach((line, at) => {
    if (guarded[at] || !line.includes(MARKER_OPEN)) return;
    const own = STANDALONE_MARKER.exec(line);
    if (own) {
      const index = Number(own[1]);
      if (!planned.has(index)) scan.badLines.push(at);
      else if (scan.found.has(index)) scan.duplicateLines.push(at);
      else scan.found.set(index, at);
      return;
    }
    const trimmed = line.trim();
    if (trimmed.startsWith(MARKER_OPEN) && trimmed.endsWith("〕") && (trimmed.match(/〔/g) ?? []).length === 1) {
      scan.badLines.push(at);
      return;
    }
    scan.inlineLines.push(at);
  });
  scan.omitted = slots.map(slot => slot.index).filter(index => !scan.found.has(index));
  return scan;
}

/** Marker text inside a line that is not a marker line of its own (a closed marker, or a bare opener without its closing bracket). */
export const INLINE_MARKER = /〔圖位[^〔〕\n]*〕|〔圖位/g;

/** Lines (0-based) outside fences and quotes that still hold `〔圖位`: the commit check "no residual marker" needs this to be empty. */
export function residualMarkerLines(content: string): number[] {
  const lines = content.split(/\r?\n/);
  const guarded = protectedLines(lines);
  const out: number[] = [];
  lines.forEach((line, at) => {
    if (!guarded[at] && line.includes(MARKER_OPEN)) out.push(at);
  });
  return out;
}

/** One picture the finder offered for a slot. The fields are the finder's response, not yet trusted beyond what `pickForSlot` checks. */
export interface SlotCandidate {
  imageUrl: string;
  sourceUrl: string;
  title: string;
  caption: string;
}
export interface PickContext {
  chapter: { id: string; title: string };
  slot: ImageSlot;
  allSlots: readonly ImageSlot[];
  /** Picture addresses already placed in this chapter: one address is never placed twice (same chapter). */
  alreadyPicked: ReadonlySet<string>;
}
export type SlotPick = { candidate: SlotCandidate } | { none: true; reasonCode: SlotReasonCode; reasonText?: string };

const isHttps = (url: string): boolean => {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
};

/**
 * The seam where the picture-quality work plugs in: synchronous and deterministic. Candidates are already loadable (the caller
 * probes them); this decides which one a slot takes. The default takes the first https candidate not placed yet in the chapter.
 */
export function pickForSlot(ctx: PickContext, candidates: readonly SlotCandidate[]): SlotPick {
  const secure = candidates.filter(item => isHttps(item.imageUrl));
  const hit = secure.find(item => !ctx.alreadyPicked.has(item.imageUrl));
  if (hit) return { candidate: hit };
  if (candidates.length && !secure.length) return { none: true, reasonCode: "unsafe_url" };
  return { none: true, reasonCode: "not_found" };
}
