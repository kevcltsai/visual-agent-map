/**
 * Picture slots of the picture-book pipeline (plan R1-2, R1-8, R2-1). The planner decides a card's slots (`## Prompt` image plan),
 * the author leaves one marker line `〔圖位 n：要說明的事〕` after the paragraph each slot belongs to, and a later step swaps the markers
 * for verified pictures. This file holds the pure parts: the slot type, the marker grammar and its scan, the residual check and the
 * `pickForSlot` seam (the picture-quality work replaces only that function). No I/O, no model text is trusted here.
 */

import { noteLanguageOf, translate, translateNote, type ContentLanguage } from "../../i18n";
import { imageKey } from "./image-dedupe";
import { isDocumentFile, workKey } from "./image-quality";
import { fencedLines, stripSearchTerms } from "./note-sections";
import { escapeMarkdownText } from "./text";
import { hasLatinWord, toTraditional } from "./caption-script";

/** One planned picture position. `index` is assigned by the program in order (1..n); the model never writes it. */
export interface ImageSlot {
  index: number;
  /** The kind of picture (painting, map, diagram, ...): one short line. */
  kind: string;
  /** What the picture must show or explain: one line, never contains the marker brackets. */
  explains: string;
  /** Where in the chapter it sits (for example "after the paragraph on perspective"). */
  anchor: string;
  /** The planner's English search terms for a Commons file search (2 to 4). Absent on a slot planned before they existed. */
  search?: string[];
}

/** At most this many English search terms a slot, each at most {@link SEARCH_TERM_MAX} characters. */
export const MAX_SEARCH_TERMS = 4;
export const SEARCH_TERM_MAX = 60;
/** Search terms as stored: one line each, no list separator, Latin letters only kept (a term without one is dropped), no duplicates. */
export function cleanSearchTerms(values: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const term = cleanSlotText(value.replace(/[,;]/g, " "), SEARCH_TERM_MAX);
    if (!/[A-Za-z]/.test(term) || out.some(have => have.toLowerCase() === term.toLowerCase())) continue;
    out.push(term);
    if (out.length >= MAX_SEARCH_TERMS) break;
  }
  return out;
}

/** The planner may arrange this many slots for one card when the owner gave no picture count. */
export const DEFAULT_IMAGE_SLOTS = 8;
/** The hard ceiling for one card's slots (an owner's picture count raises the limit up to here, never past it). */
export const MAX_IMAGE_SLOTS = 12;
/** The slot limit for a card: the owner's range maximum when it is above the default, never above {@link MAX_IMAGE_SLOTS}. */
export const imageSlotCap = (range?: { max: number }): number =>
  Math.min(MAX_IMAGE_SLOTS, Math.max(DEFAULT_IMAGE_SLOTS, range?.max ?? 0));

/**
 * Why a slot ended without a picture (`probe_capped`: its candidates were left unprobed by the per-chapter limit; `rate_limited`:
 * Wikimedia Commons kept answering "too many requests" before the slot was searched). Only `author_omitted` and `bad_marker` come
 * from the marker scan.
 */
export type SlotReasonCode =
  "author_omitted" | "bad_marker" | "not_found" | "load_failed" | "unsafe_url" | "probe_capped" | "rate_limited";

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
const OPEN_FENCE = /^[ \t]*(`{3,}|~{3,})(.*)$/;
const QUOTE_LINE = /^ {0,3}>/;
const INDENTED_CODE = /^(?: {4}|\t)/;
/** A line that ends a quote's lazy continuation: a fence, heading, list item or rule. */
const BLOCK_START = /^ {0,3}(?:#{1,6}(?:\s|$)|[-*+]\s|\d+[.)]\s|(?:[-*_][ \t]*){3,}$)/;

/**
 * Per line: true when the line is inside a code fence (fence lines included, at any indent), is indented code (4 spaces or a tab after a
 * blank line or other code), is a quote line or a lazy continuation of one. Markers there are kept as they are.
 */
export function protectedLines(lines: readonly string[]): boolean[] {
  const out: boolean[] = [];
  let fence: { char: string; size: number } | undefined;
  let quote = false;
  let code = false;
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
      quote = false;
      code = false;
      continue;
    }
    const blank = !line.trim();
    const prevBlank = out.length === 0 || !lines[out.length - 1].trim();
    if (QUOTE_LINE.test(line)) {
      quote = true;
      code = false;
      out.push(true);
    } else if (quote && !blank && !BLOCK_START.test(line)) {
      out.push(true);
    } else if (INDENTED_CODE.test(line) && !blank && (prevBlank || code)) {
      quote = false;
      code = true;
      out.push(true);
    } else {
      if (!blank) code = false;
      quote = false;
      out.push(false);
    }
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
/** A marker line's text without its list symbol and the emphasis symbols around it (`- **〔圖位 1：x〕**` -> `〔圖位 1：x〕`). */
function markerCore(line: string): string {
  return stripSearchTerms(line)
    .trim()
    .replace(/^(?:[-+*]|\d+[.)])\s+/, "")
    .replace(/^[*_~]+/, "")
    .replace(/[*_~]+$/, "")
    .trim();
}
/** `own`: a whole line that is one well-formed marker; `bad`: a whole line that is one closed marker but reworded; else not a marker line (an unclosed marker or one followed by text is inline: only the marker text goes). */
function markerLineKind(line: string): "own" | "bad" | undefined {
  const core = markerCore(line);
  if (STANDALONE_MARKER.test(core)) return "own";
  return /^〔圖位[^〔〕]*〕$/.test(core) ? "bad" : undefined;
}
/** What is left of a line once the markers are taken out is only list or emphasis symbols and blanks (the line held nothing else). */
function isShell(rest: string): boolean {
  return /^(?:[-+]|\d+[.)])?$/.test(rest.replace(/[\s*_~]+/g, ""));
}

export function scanSlotMarkers(content: string, slots: readonly Pick<ImageSlot, "index">[]): SlotScan {
  const lines = content.split(/\r?\n/);
  const guarded = protectedLines(lines);
  const planned = new Set(slots.map(slot => slot.index));
  const scan: SlotScan = { found: new Map(), duplicateLines: [], badLines: [], inlineLines: [], omitted: [] };
  lines.forEach((line, at) => {
    if (guarded[at] || !line.includes(MARKER_OPEN)) return;
    const kind = markerLineKind(line);
    if (kind === "own") {
      const index = Number(STANDALONE_MARKER.exec(markerCore(line))?.[1]);
      if (!planned.has(index)) scan.badLines.push(at);
      else if (scan.found.has(index)) scan.duplicateLines.push(at);
      else scan.found.set(index, at);
      return;
    }
    if (kind === "bad") {
      scan.badLines.push(at);
      return;
    }
    scan.inlineLines.push(at);
  });
  scan.omitted = slots.map(slot => slot.index).filter(index => !scan.found.has(index));
  return scan;
}

/** Marker text inside a line that is not a marker line of its own: a closed marker, or an unclosed opener (`〔圖位 n：`; only the prefix, the text after it stays). */
export const INLINE_MARKER = /〔圖位[^〔〕\n]*〕|〔圖位\s*\d+\s*[：:]|〔圖位/g;

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
  /** What the file page says about the file (the program's Commons search); absent for the finder's pictures, whose caption is its own description. */
  description?: string;
  /** Creator and license as the finder reported them from the source page; never invented here. */
  author?: string;
  license?: string;
}
export interface PickContext {
  chapter: { id: string; title: string };
  slot: ImageSlot;
  allSlots: readonly ImageSlot[];
  /** Picture addresses (and work keys, see workKey) already placed in this chapter: one picture or work is never placed twice (same chapter). */
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
  // One picture is one file: a thumbnail and the original of the same file count as the same address.
  const picked = new Set([...ctx.alreadyPicked].map(imageKey));
  const hit = secure.find(item => {
    const work = workKey(item.imageUrl, item.author);
    return !picked.has(imageKey(item.imageUrl)) && !(work && picked.has(work));
  });
  if (hit) return { candidate: hit };
  if (candidates.length && !secure.length) return { none: true, reasonCode: "unsafe_url" };
  return { none: true, reasonCode: "not_found" };
}

// ---- finding and placing pictures (P2b) ----------------------------------------------------------------------------------------------

/** One candidate after the program looked at it: `href` is the https address that passed the address check (undefined: refused), `loaded` the probe result. */
export interface ProbedCandidate {
  candidate: SlotCandidate;
  href: string | undefined;
  loaded: boolean;
  /** The address passed the check but was not probed (the per-chapter probe limit). */
  skipped?: boolean;
}
/** What a slot got: a picture ready to be written (every text already escaped), or the reason it ends without one. */
export interface SlotFigure {
  href: string;
  alt: string;
  caption: string;
  /** Where the picture came from; absent when the source page is not a usable https address. */
  source?: { href: string; line: string; entry: string };
  /** The work key (see workKey) when the author is known: the run claims it so no other chapter shows the same work under another file. */
  work?: string;
}
export type SlotOutcome = { figure: SlotFigure } | { reasonCode: SlotReasonCode; reasonText?: string };

/** A line of only symbols and blanks (`---`, `===`, `- - -`) can turn the line above into a heading or a rule: a backslash keeps it text (only when it starts with an ASCII punctuation character; `…`, `→`, `★★★` cannot). */
function plainLine(text: string): string {
  return text &&
    /^[\s\p{P}\p{S}]+$/u.test(text) &&
    /^[\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]/.test(text) &&
    !text.startsWith("\\")
    ? `\\${text}`
    : text;
}

const SOURCE_URL_MAX = 1000;
const CREDIT_TEXT_MAX = 80;

/**
 * The source of a picture: one line under the caption and the matching entry of the card's sources list. The page address must be https
 * without credentials; the site name is its host (never model text); author and license are untrusted text, escaped and capped, and
 * left out when the finder did not report them.
 */
export function sourceOf(
  candidate: SlotCandidate,
  alt: string,
  language: string
): { href: string; line: string; entry: string } | undefined {
  let page: URL;
  try {
    page = new URL(candidate.sourceUrl.trim());
  } catch {
    return undefined;
  }
  if (page.protocol !== "https:" || page.username || page.password || page.href.length > SOURCE_URL_MAX)
    return undefined;
  const href = page.href.replace(/\(/g, "%28").replace(/\)/g, "%29");
  const lang = language as ContentLanguage;
  const credit = (value: string | undefined, max: number): string =>
    plainLine(escapeMarkdownText((value ?? "").replace(/[〔〕]/g, " "), max));
  const author = credit(candidate.author, CREDIT_TEXT_MAX);
  const license = credit(candidate.license, CREDIT_TEXT_MAX);
  const site = escapeMarkdownText(page.hostname.replace(/^www\./i, ""), 100);
  const parts = [
    site,
    ...(author ? [translateNote(lang, "note.image_author_0", author)] : []),
    ...(license ? [license] : [])
  ];
  const detail = translateNote(
    lang,
    "note.image_source_0_1",
    parts.join(" · "),
    `[${translateNote(lang, "note.image_link")}](${href})`
  );
  return {
    href: page.href,
    line: translateNote(lang, "note.image_source_label_0", detail),
    entry: translateNote(lang, "note.image_source_entry_0_1", alt, detail)
  };
}

/** A Traditional Chinese book's caption in Traditional characters (see `toTraditional`); other languages unchanged. */
const traditionalIf = (language: string, text: string): string =>
  /^zh-(?:TW|Hant)/i.test(language) ? toTraditional(text) : text;

/** A finder caption is one plain line (what it is, where to look); an empty one falls back to the title. */
export function figureOf(candidate: SlotCandidate, href: string, language: string): SlotFigure {
  // The marker brackets are taken out first: a caption must never read as a slot marker.
  const plain = (value: string): string => value.replace(/[〔〕]/g, " ");
  const alt = escapeMarkdownText(plain(candidate.title), 80) || (/^zh/i.test(language) ? "圖" : "image");
  const source = sourceOf(candidate, alt, language);
  return {
    href,
    alt,
    caption: traditionalIf(language, plainLine(escapeMarkdownText(plain(candidate.caption), 160))) || alt,
    ...(source ? { source } : {})
  };
}

/**
 * Decides every slot in order: the candidates that loaded, passed the address check and are not `taken` (the address key, or the work
 * key, of a picture another chapter shows or claimed) go to {@link pickForSlot}; the first slot of the chapter takes first, and one
 * picture or work is never placed twice.
 * A slot without a pick gets the most telling reason. Pure and synchronous, so the caller can claim the picks in the same turn.
 */
export function choosePictures(
  chapter: PickContext["chapter"],
  slots: readonly ImageSlot[],
  perSlot: ReadonlyMap<number, readonly ProbedCandidate[]>,
  taken: (key: string) => boolean,
  language: string
): Map<number, SlotOutcome> {
  const outcomes = new Map<number, SlotOutcome>();
  const alreadyPicked = new Set<string>();
  for (const slot of slots) {
    const all = perSlot.get(slot.index) ?? [];
    const usable = all.filter(item => {
      if (!item.href || !item.loaded || taken(imageKey(item.href))) return false;
      const work = workKey(item.href, item.candidate.author);
      return !(work && taken(work));
    });
    const pick = pickForSlot(
      { chapter, slot, allSlots: slots, alreadyPicked },
      usable.map(item => ({ ...item.candidate, imageUrl: item.href as string }))
    );
    if ("candidate" in pick) {
      alreadyPicked.add(pick.candidate.imageUrl);
      const work = workKey(pick.candidate.imageUrl, pick.candidate.author);
      if (work) alreadyPicked.add(work);
      const figure = figureOf(pick.candidate, pick.candidate.imageUrl, language);
      outcomes.set(slot.index, { figure: work ? { ...figure, work } : figure });
      continue;
    }
    let reasonCode = pick.reasonCode;
    if (!usable.length) {
      if (!all.length) reasonCode = "not_found";
      else if (all.every(item => !item.href)) reasonCode = "unsafe_url";
      else if (all.some(item => item.href && !item.loaded && !item.skipped)) reasonCode = "load_failed";
      else if (all.some(item => item.skipped)) reasonCode = "probe_capped";
      else reasonCode = "not_found";
    }
    outcomes.set(slot.index, { reasonCode, ...(pick.reasonText ? { reasonText: pick.reasonText } : {}) });
  }
  return outcomes;
}

export interface FillResult {
  text: string;
  placed: { index: number; href: string }[];
  missing: { index: number; reasonCode: SlotReasonCode }[];
  /** Marker lines refused whole (reworded, or an index the plan does not have). */
  bad: number;
  /** The sources of the pictures placed (page address, and the entry for the card's sources list), in slot order. */
  sources: { href: string; entry: string }[];
  /** The figure lines this call wrote, so the independent check can tell them from the author's text. */
  added: string[];
}

const BAD_INDEX = /〔圖位\s*(\d+)/;
const isBlank = (line: string | undefined): boolean => line === undefined || !line.trim();

/**
 * R1-2: swaps every valid marker line for its figure (an image line and one caption line, a blank line kept around), and deletes
 * the others: a marker whose slot got no picture, a repeated marker, a refused marker (whole line), and the marker text alone of a
 * marker inside other text (the rest of the line stays; a line that becomes empty goes). Blank lines the deletions would double are
 * dropped. Markers in code fences and quotes are never touched. The slot of a refused marker with a planned index ends as
 * `bad_marker`; a slot with no marker at all ends as `author_omitted`.
 */
export function fillSlotMarkers(
  content: string,
  slots: readonly Pick<ImageSlot, "index">[],
  outcomes: ReadonlyMap<number, SlotOutcome>
): FillResult {
  const lines = content.split("\n");
  const scan = scanSlotMarkers(content, slots);
  const cr = content.includes("\r\n") ? "\r" : "";
  const figureAt = new Map<number, SlotFigure>();
  const missing: FillResult["missing"] = [];
  const placed: FillResult["placed"] = [];
  const sources: FillResult["sources"] = [];
  const planned = new Set(slots.map(slot => slot.index));
  const badIndexes = new Set<number>();
  for (const at of scan.badLines) {
    const m = BAD_INDEX.exec(lines[at]);
    if (m && planned.has(Number(m[1]))) badIndexes.add(Number(m[1]));
  }
  // A marker the author left inside other text (or next to another one) is a wrong marker, not an omitted one.
  for (const at of scan.inlineLines)
    for (const m of lines[at].matchAll(/〔圖位\s*(\d+)/g)) if (planned.has(Number(m[1]))) badIndexes.add(Number(m[1]));
  for (const slot of slots) {
    const at = scan.found.get(slot.index);
    const outcome = outcomes.get(slot.index);
    if (at === undefined) {
      missing.push({ index: slot.index, reasonCode: badIndexes.has(slot.index) ? "bad_marker" : "author_omitted" });
    } else if (outcome && "figure" in outcome) {
      figureAt.set(at, outcome.figure);
      placed.push({ index: slot.index, href: outcome.figure.href });
      if (outcome.figure.source) sources.push({ href: outcome.figure.source.href, entry: outcome.figure.source.entry });
    } else {
      missing.push({ index: slot.index, reasonCode: outcome?.reasonCode ?? "not_found" });
    }
  }
  const dropped = new Set(
    [...scan.badLines, ...scan.duplicateLines, ...scan.found.values()].filter(at => !figureAt.has(at))
  );
  const inline = new Set(scan.inlineLines);
  const added: string[] = [];
  const out: string[] = [];
  let removed = false;
  const push = (line: string): void => {
    // A deletion must not leave two blank lines (or one at the very start) where the text had one.
    if (removed && isBlank(line) && (!out.length || isBlank(out[out.length - 1]))) {
      removed = false;
      return;
    }
    removed = false;
    out.push(line);
  };
  lines.forEach((line, at) => {
    const figure = figureAt.get(at);
    if (figure) {
      if (out.length && !isBlank(out[out.length - 1])) out.push("");
      const image = `![${figure.alt}](${figure.href})${cr}`;
      const caption = `${figure.caption}${cr}`;
      added.push(image, caption);
      out.push(image, caption);
      if (figure.source) {
        const source = `${figure.source.line}${cr}`;
        added.push(source);
        out.push(source);
      }
      if (!isBlank(lines[at + 1])) out.push(cr ? "\r" : "");
      return;
    }
    if (dropped.has(at)) {
      removed = true;
      return;
    }
    if (inline.has(at)) {
      const rest = line.replace(INLINE_MARKER, "");
      if (isShell(rest)) {
        removed = true;
        return;
      }
      push(rest);
      return;
    }
    push(line);
  });
  return { text: out.join("\n"), placed, missing, bad: scan.badLines.length, sources, added };
}

/** Lines as the independent check compares them: markers out, blank lines out. Lines in fences and quotes are compared as they are. */
function withoutMarkers(text: string): string[] {
  const lines = text.split("\n");
  const guarded = protectedLines(lines);
  const out: string[] = [];
  lines.forEach((line, at) => {
    if (guarded[at] || !line.includes(MARKER_OPEN)) {
      out.push(line);
      return;
    }
    // A marker line goes whole; a line that is only list or emphasis symbols once its markers are out goes too (what a fill must not leave).
    if (markerLineKind(line)) return;
    const rest = line.replace(INLINE_MARKER, "");
    if (!isShell(rest)) out.push(rest);
  });
  return out.map(line => line.replace(/\s+$/, "")).filter(line => line.trim());
}

/**
 * R1-2 / R2-1: the three checks before a fill is committed. Returns the first that fails, or undefined: (1) replaced plus missing
 * is the planned count, each index once; (2) no `〔圖位` is left outside fences and quotes; (3) what was taken out of the text is marker
 * text only (the text without markers, blank lines and the figure lines written is the same before and after).
 */
export function verifyFill(
  original: string,
  result: FillResult,
  slots: readonly Pick<ImageSlot, "index">[]
): "count" | "residual" | "deleted_text" | undefined {
  const seen = [...result.placed, ...result.missing].map(item => item.index).sort((a, b) => a - b);
  const want = slots.map(slot => slot.index).sort((a, b) => a - b);
  if (seen.length !== want.length || seen.some((index, i) => index !== want[i])) return "count";
  if (residualMarkerLines(result.text).length) return "residual";
  const rest = withoutMarkers(result.text);
  for (const line of result.added) {
    const at = rest.indexOf(line.replace(/\s+$/, ""));
    if (at < 0) return "deleted_text";
    rest.splice(at, 1);
  }
  const before = withoutMarkers(original);
  return before.length === rest.length && before.every((line, i) => line === rest[i]) ? undefined : "deleted_text";
}

// ---- the stored result (book-slots:v1) and what gate 2 and the proof read of it --------------------------------------------------------

export interface SlotRecordItem {
  index: number;
  state: "placed" | "missing";
  reasonCode?: SlotReasonCode;
  /** A short hash of the placed picture's key: enough to see that the picture is still there, no address. */
  hash?: string;
  /** The placed file names none of the words its slot asks for (decided when it was placed: see the run's fill). */
  off?: true;
}
export interface SlotsRecord {
  slots: SlotRecordItem[];
  /** Refused marker lines of the last fill. */
  bad: number;
}
const REASONS: readonly SlotReasonCode[] = [
  "author_omitted",
  "bad_marker",
  "not_found",
  "load_failed",
  "unsafe_url",
  "probe_capped",
  "rate_limited"
];

/** FNV-1a over the picture key: 8 hex characters. */
export function shortHash(url: string): string {
  let hash = 0x811c9dc5;
  for (const char of imageKey(url)) {
    hash ^= char.codePointAt(0) as number;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** The one machine line the guarded write puts into the research notes (`replaceResearchRecord` keeps only the latest). It holds numbers, codes and hashes only. */
export function composeSlotsRecord(
  result: Pick<FillResult, "placed" | "missing" | "bad">,
  off: ReadonlySet<number> = new Set()
): string {
  const slots: SlotRecordItem[] = [
    ...result.placed.map(item => ({
      index: item.index,
      state: "placed" as const,
      hash: shortHash(item.href),
      ...(off.has(item.index) ? { off: true as const } : {})
    })),
    ...result.missing.map(item => ({ index: item.index, state: "missing" as const, reasonCode: item.reasonCode }))
  ].sort((a, b) => a.index - b.index);
  return `<!-- book-slots:v1 ${JSON.stringify({ slots, bad: result.bad })} -->`;
}

const RECORD_LINE = /^(?:[ \t]{0,3}>[ \t]?)*<!-- book-slots:v1 (\{.*\}) -->$/;
/** The latest valid `book-slots:v1` record of a Detail (a hand-edited or damaged one is read as far as it is valid; none: undefined). */
export function latestSlotsRecord(detail: string): SlotsRecord | undefined {
  const lines = detail.split("\n");
  const fenced = fencedLines(lines);
  let found: SlotsRecord | undefined;
  lines.forEach((line, at) => {
    const m = fenced[at] ? null : RECORD_LINE.exec(line.replace(/\r$/, "").trim());
    if (!m) return;
    try {
      const data = JSON.parse(m[1]) as { slots?: unknown; bad?: unknown };
      if (!Array.isArray(data.slots)) return;
      const items: SlotRecordItem[] = [];
      for (const raw of data.slots.slice(0, MAX_IMAGE_SLOTS) as Array<Record<string, unknown> | null>) {
        if (!raw || !Number.isInteger(raw.index) || (raw.index as number) < 1) continue;
        const state = raw.state === "placed" ? "placed" : raw.state === "missing" ? "missing" : undefined;
        if (!state) continue;
        const reasonCode = REASONS.find(code => code === raw.reasonCode);
        items.push({
          index: raw.index as number,
          state,
          ...(reasonCode ? { reasonCode } : {}),
          ...(typeof raw.hash === "string" && /^[0-9a-f]{8}$/.test(raw.hash) ? { hash: raw.hash } : {}),
          ...(state === "placed" && raw.off === true ? { off: true as const } : {})
        });
      }
      found = { slots: items, bad: Number.isInteger(data.bad) && (data.bad as number) > 0 ? (data.bad as number) : 0 };
    } catch {
      // a damaged record is read as no record
    }
  });
  return found;
}

const IMAGE_IN_LINE = /!\[[^\]\n]*\]\((https:\/\/[^)\s]+)\)/g;
/** The source line the fill writes under a caption (its label in the three note languages). */
const SOURCE_LINE = /^(?:來源|来源|Source)[:：][ \t]*\S/;
const IMAGE_ONLY_LINE = /^[ \t]*!\[[^\]\n]*\]\(https:\/\/[^)\s]+\)[ \t]*\r?$/;

/**
 * The text the proofread reads: the image lines (and the one caption line right after an image line of its own) are taken out, so a
 * picture or its caption is never a claim to check. Lines in fences and quotes stay.
 */
export function stripImageLines(text: string): string {
  return splitImageLines(text).text;
}
/** The caption lines of the pictures in a text (the line right after an image line, as {@link stripImageLines} takes them out). */
export function captionLines(text: string): string[] {
  return splitImageLines(text).captions;
}
/**
 * The issue token of a Chinese chapter with a lowercase English word left in a picture caption (no spaces): needs-review, no rewrite of
 * the text (see `hasLatinWord`).
 */
export const CAPTION_LATIN_TOKEN = "captions:latin";
/** A Chinese chapter's captions that mix in a lowercase English word: the issue token, else "". */
export function captionLatinIssue(text: string, language: string): string {
  return /^zh/i.test(language) && captionLines(text).some(hasLatinWord) ? CAPTION_LATIN_TOKEN : "";
}
function splitImageLines(text: string): { text: string; captions: string[] } {
  const lines = text.split("\n");
  const guarded = protectedLines(lines);
  const out: string[] = [];
  const captions: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!guarded[i] && IMAGE_ONLY_LINE.test(lines[i])) {
      const plainAt = (at: number): boolean =>
        at < lines.length && !isBlank(lines[at]) && !guarded[at] && !/^\s*(#|[-*+]\s|\d+[.)]\s)/.test(lines[at]);
      const endsAt = (at: number): boolean => isBlank(lines[at]) || /^\s*#/.test(lines[at]);
      // The caption line, and the source line right after it, go with the picture.
      if (plainAt(i + 1) && plainAt(i + 2) && SOURCE_LINE.test(lines[i + 2]) && endsAt(i + 3)) {
        captions.push(lines[i + 1]);
        i += 2;
      } else if (plainAt(i + 1) && endsAt(i + 2)) captions.push(lines[++i]);
      continue;
    }
    out.push(lines[i]);
  }
  return { text: out.join("\n").replace(/\n{3,}/g, "\n\n"), captions };
}

/** What the slot looks like now, read from the record, the plan and the body: `edited` = the recorded picture is no longer in the text (replaced or deleted by hand). */
export type SlotState = "placed" | "edited" | "missing" | "unrecorded";
export interface SlotStatus {
  index: number;
  state: SlotState;
  reasonCode?: SlotReasonCode;
}
/** Gate 2's picture state, rebuilt from the Detail's record and the picture addresses now in the text (no map field). No record: every slot is `unrecorded`. */
export function describeSlots(
  slots: readonly Pick<ImageSlot, "index">[],
  record: SlotsRecord | undefined,
  imageUrls: readonly string[]
): SlotStatus[] {
  const now = new Set(imageUrls.map(shortHash));
  return slots.map(slot => {
    const item = record?.slots.find(entry => entry.index === slot.index);
    if (!item) return { index: slot.index, state: "unrecorded" as const };
    if (item.state === "missing")
      return {
        index: slot.index,
        state: "missing" as const,
        ...(item.reasonCode ? { reasonCode: item.reasonCode } : {})
      };
    return { index: slot.index, state: item.hash && now.has(item.hash) ? ("placed" as const) : ("edited" as const) };
  });
}

// ---- the picture-and-text check (program, no AI) ---------------------------------------------------------------------------------------

const STOP_CJK = new Set([..."的了是在和與与及或對对把被為为以之於于並并中上下這这那一個个也都就而但"]);
const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "into",
  "over",
  "about",
  "how",
  "what"
]);
/** Words of an explanation worth looking for in the text: Latin words of 3+ letters, and every two characters in a run of Han characters (cut at common function characters). */
export function slotKeywords(explains: string): string[] {
  const out = new Set<string>();
  for (const word of explains.toLowerCase().match(/[a-z0-9][a-z0-9'-]{2,}/g) ?? [])
    if (!STOP_WORDS.has(word)) out.add(word);
  for (const run of explains.match(/\p{Script=Han}+/gu) ?? []) {
    let part = "";
    const flush = (): void => {
      const chars = Array.from(part);
      for (let i = 0; i + 1 < chars.length; i++) out.add(chars[i] + chars[i + 1]);
      part = "";
    };
    for (const char of run) {
      if (STOP_CJK.has(char)) flush();
      else part += char;
    }
    flush();
  }
  return [...out];
}
/** At least this many of a slot's keywords (all of them when it has fewer) must be in the text around the picture. */
const KEYWORD_HITS = 2;

export interface ImageTextCheck {
  /** `none`: the plan arranged no picture (or the Prompt has no image plan); `unrecorded`: slots planned but no record; else `checked`. */
  kind: "none" | "unrecorded" | "checked";
  planned: number;
  placed: number;
  /** Standard images in the chapter text (outside the old picture section). */
  imageCount: number;
  bad: number;
  /** One entry per thing worth a look: a slot that ended without a picture, a picture its neighbours do not talk about, a picture count that is not the placed count. */
  issues: { index?: number; code: SlotReasonCode | "mismatch" | "count" }[];
}

/**
 * R1-3: every proof recomputes this (it is not in the proof's key): the number of pictures equals the placed slots, and for each
 * placed slot the keywords of what it explains appear in the paragraph before or after its picture (the picture block itself,
 * caption included, is not the text around it). A picture that is a document page (PDF, DjVu, TIFF scan) or that the record marks
 * as naming nothing its slot asks for is a mismatch whatever the text says. `body` is the chapter text (see chapterBody).
 */
export function checkImageText(
  body: string,
  slots: readonly ImageSlot[] | undefined,
  record: SlotsRecord | undefined
): ImageTextCheck {
  const empty = { planned: 0, placed: 0, imageCount: 0, bad: 0, issues: [] };
  if (!slots?.length) return { kind: "none", ...empty };
  if (!record) return { kind: "unrecorded", ...empty, planned: slots.length };
  const lines = body.split("\n");
  const guarded = protectedLines(lines);
  // Paragraph blocks: runs of non-blank lines outside fences and quotes; a block with an image is a figure block.
  const blocks: { text: string; hashes: string[]; docs: string[] }[] = [];
  let current: string[] = [];
  let hashes: string[] = [];
  let docs: string[] = [];
  const close = (): void => {
    if (current.length) blocks.push({ text: current.join("\n"), hashes, docs });
    current = [];
    hashes = [];
    docs = [];
  };
  lines.forEach((line, at) => {
    if (guarded[at] || isBlank(line)) {
      close();
      return;
    }
    current.push(line);
    for (const m of line.matchAll(IMAGE_IN_LINE)) {
      hashes.push(shortHash(m[1]));
      if (isDocumentFile(m[1])) docs.push(shortHash(m[1]));
    }
  });
  close();
  const imageCount = blocks.reduce((sum, block) => sum + block.hashes.length, 0);
  const placedItems = record.slots.filter(item => item.state === "placed");
  const issues: ImageTextCheck["issues"] = [];
  for (const item of record.slots)
    if (item.state === "missing") issues.push({ index: item.index, code: item.reasonCode ?? "not_found" });
  if (imageCount !== placedItems.length) issues.push({ code: "count" });
  for (const item of placedItems) {
    const at = blocks.findIndex(block => item.hash !== undefined && block.hashes.includes(item.hash));
    const slot = slots.find(entry => entry.index === item.index);
    if (at < 0 || !slot) continue;
    // A page of a PDF or scan, or a file that names nothing the slot asks for, never matches its text, whatever the caption says.
    if (item.off || blocks[at].docs.includes(item.hash as string)) {
      issues.push({ index: item.index, code: "mismatch" });
      continue;
    }
    const around = [at - 1, at + 1]
      .map(i => blocks[i])
      .filter(block => block && !block.hashes.length)
      .map(block => block.text.toLowerCase())
      .join("\n");
    const words = slotKeywords(slot.explains);
    const hits = words.filter(word => around.includes(word)).length;
    if (words.length && hits < Math.min(KEYWORD_HITS, words.length))
      issues.push({ index: item.index, code: "mismatch" });
  }
  return { kind: "checked", planned: slots.length, placed: placedItems.length, imageCount, bad: record.bad, issues };
}

/** The one `圖文` line of the proof result section. */
export function composeImageTextLine(language: ContentLanguage, check: ImageTextCheck): string {
  const note = noteLanguageOf(language);
  if (check.kind === "none") return translate(note, "detail.book_slots_none");
  if (check.kind === "unrecorded") return translate(note, "detail.book_slots_unrecorded");
  const joiner = /^zh/i.test(language) ? "；" : "; ";
  const parts = check.issues.map(issue =>
    issue.code === "count"
      ? translate(note, "detail.book_slots_count_0_1", String(check.imageCount), String(check.placed))
      : translate(
          note,
          "detail.book_slots_slot_0_1",
          String(issue.index),
          translate(note, `detail.book_slots_reason_${issue.code}`)
        )
  );
  if (check.bad) parts.push(translate(note, "detail.book_slots_bad_0", String(check.bad)));
  return parts.length
    ? translate(note, "detail.book_slots_issues_0", parts.join(joiner))
    : translate(note, "detail.book_slots_ok_0", String(check.placed));
}

/** The pipeline issue tokens of a check (they count as "worth a look", never as needs-review): one per issue; `image_N` is a slot with no picture, `image_N_mismatch` a placed picture that does not match its text. */
export function imageIssueTokens(check: ImageTextCheck): string[] {
  const tokens = check.issues.map(issue =>
    issue.code === "count"
      ? "image_count"
      : issue.code === "mismatch"
        ? `image_${issue.index}_mismatch`
        : `image_${issue.index}`
  );
  return check.bad ? [...tokens, "image_marker"] : tokens;
}

/**
 * The issue token of a chapter that ended with fewer placed pictures than the owner's minimum pictures per chapter (no spaces):
 * `images:under:<placed>:<minimum>`. It makes the chapter needs-review without asking for a rewrite of its text.
 */
export const pictureShortfallToken = (placed: number, minimum: number): string => `images:under:${placed}:${minimum}`;
/**
 * The issue token of a chapter where Wikimedia Commons' request limit left a slot unsearched (`rate_limited`), with or without a
 * shortfall: the chapter is needs-review (run it again later), without a rewrite of its text.
 */
export const PICTURE_LIMITED_TOKEN = "images:limited";
/**
 * The issue token of the placed pictures the program's check found off their text (`images:off:2,3,8`). Every such picture is a
 * reason to look (Primary decision after the v5 run): the chapter is needs-review without a rewrite of its text.
 */
export const pictureMismatchToken = (indexes: readonly number[]): string => `images:off:${indexes.join(",")}`;
const SHORTFALL = /(?:^|\s)images:under:(\d+):(\d+)(?=\s|$)/;
const CAPTION_LATIN = /(?:^|\s)captions:latin(?=\s|$)/;
const LIMITED = /(?:^|\s)images:limited(?=\s|$)/;
const OFF = /(?:^|\s)images:off:(\d+(?:,\d+)*)(?=\s|$)/;
/** An issue field split into its picture shortfall, Commons limit, mismatches and English left in captions (when it carries them) and the rest (`images unmet:` with only notice tokens left leaves nothing). */
export function splitPictureIssue(issue: string): {
  rest: string;
  shortfall?: { placed: number; minimum: number };
  limited?: true;
  off?: number[];
  captionLatin?: true;
} {
  const m = SHORTFALL.exec(issue);
  const o = OFF.exec(issue);
  const limited = LIMITED.test(issue);
  const latin = CAPTION_LATIN.test(issue);
  if (!m && !o && !limited && !latin) return { rest: issue };
  const rest = issue
    .replace(SHORTFALL, "")
    .replace(LIMITED, "")
    .replace(OFF, "")
    .replace(CAPTION_LATIN, "")
    .trim()
    .replace(/^images unmet:(?:\s+\S+)*$|^images unmet$/, "");
  return {
    rest,
    ...(m ? { shortfall: { placed: Number(m[1]), minimum: Number(m[2]) } } : {}),
    ...(limited ? { limited: true as const } : {}),
    ...(o ? { off: o[1].split(",").map(Number) } : {}),
    ...(latin ? { captionLatin: true as const } : {})
  };
}

/**
 * The Haiku merge gate of T2 from the stored records (what the tester computes after the live run): of the chapters whose plan has
 * slots, the share with at least one picture placed (must be at least 60%), and the share of slots the author left a valid marker for
 * (the Sonnet sample must be 100%).
 */
export function slotGate(chapters: readonly { planned: number; record?: SlotsRecord }[]): {
  chapters: number;
  withPicture: number;
  pictureShare: number;
  slots: number;
  marked: number;
  markerShare: number;
} {
  const withSlots = chapters.filter(chapter => chapter.planned > 0);
  const withPicture = withSlots.filter(chapter => chapter.record?.slots.some(item => item.state === "placed")).length;
  const slotCount = withSlots.reduce((sum, chapter) => sum + chapter.planned, 0);
  const marked = withSlots.reduce(
    (sum, chapter) =>
      sum +
      (chapter.record?.slots.filter(item => item.reasonCode !== "author_omitted" && item.reasonCode !== "bad_marker")
        .length ?? 0),
    0
  );
  return {
    chapters: withSlots.length,
    withPicture,
    pictureShare: withSlots.length ? withPicture / withSlots.length : 1,
    slots: slotCount,
    marked,
    markerShare: slotCount ? marked / slotCount : 1
  };
}
