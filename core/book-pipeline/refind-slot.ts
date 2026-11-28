/**
 * "Find another picture" for one picture slot of a chapter (V3.3 P5.1b): the pure parts. Which picture the cursor is on, the picture's
 * block as the fill wrote it (image line, caption, source line) and its Sources entry, and the one swap that changes only those lines and
 * the slot's line of the `book-slots:v1` record. Every change is an exact line replacement, so the reverse swap puts the bytes back.
 * No I/O; no model text is trusted here (the new lines come from `figureOf`, already escaped).
 */

import { translateNote, type ContentLanguage } from "../../i18n";
import { isKeptRaw, keepRaw, programStampRaw } from "./body-integrity";
import { protectedLines, type SlotFigure, type SlotsRecord } from "./image-slots";
import { addPictureSources, detailBlockOf, fencedLines } from "./note-sections";

const IMAGE_LINE = /^!\[([^\]\n]*)\]\((https:\/\/[^)\s]+)\)$/;
const SOURCE_LINE = /^(?:來源|来源|Source)[:：][ \t]*(?=\S)/;
const RECORD_LINE = /^((?:[ \t]{0,3}>[ \t]?)*)<!-- book-slots:v1 (\{.*\}) -->$/;
const DETAIL_START = "<!-- visual-agent-map:detail:start -->";
const DETAIL_END = "<!-- visual-agent-map:detail:end -->";

const bare = (line: string): string => line.replace(/\r$/, "");
const isBlank = (line: string | undefined): boolean => line === undefined || !line.trim();

/** The lines of a note's Detail block and where the block starts in the whole text; undefined without one. */
function detailOf(raw: string): { detail: string; at: number } | undefined {
  const detail = detailBlockOf(raw);
  return detail === undefined ? undefined : { detail, at: raw.indexOf(DETAIL_START) + DETAIL_START.length };
}

/**
 * The address of the picture the cursor is on in a whole note text (`line` 0-based): the image line itself, its caption, or the source
 * line under the caption. Only a picture of the Detail block, outside code and quotes; undefined elsewhere.
 */
export function figureUrlAt(raw: string, line: number): string | undefined {
  const found = detailOf(raw);
  if (!found) return undefined;
  const first = raw.slice(0, found.at).split("\n").length - 1;
  const lines = found.detail.split("\n");
  const guarded = protectedLines(lines);
  const at = line - first;
  for (let up = 0; up <= 2; up++) {
    const i = at - up;
    if (i < 0 || i >= lines.length || guarded[i]) continue;
    const m = IMAGE_LINE.exec(bare(lines[i]));
    if (!m) continue;
    if (up === 0) return m[2];
    if (up === 1 && !isBlank(lines[i + 1])) return m[2];
    if (up === 2 && !isBlank(lines[i + 1]) && SOURCE_LINE.test(bare(lines[at]))) return m[2];
    return undefined;
  }
  return undefined;
}

/** A picture as it stands in the note: its exact lines (line ends kept) and the exact text of its Sources entry, when there is one. */
export interface FigureBlock {
  lines: string[];
  /** The entry text after `- `, as the fill built it from the source line (absent: the picture has no source line, or no such entry). */
  entry?: string;
}

/**
 * The block of the picture at `url` in the Detail: the image line alone on its line, the caption line under it and the source line under
 * that (each when present). Undefined when the address is not exactly one such image line outside code and quotes (a repeated or
 * hand-moved picture is not guessed at).
 */
export function readFigure(raw: string, url: string, language: string): FigureBlock | undefined {
  const found = detailOf(raw);
  if (!found) return undefined;
  const lines = found.detail.split("\n");
  const guarded = protectedLines(lines);
  const hits = lines.flatMap((line, i) => (!guarded[i] && IMAGE_LINE.exec(bare(line))?.[2] === url ? [i] : []));
  if (hits.length !== 1 || found.detail.split(`](${url})`).length !== 2) return undefined;
  const at = hits[0];
  const alt = (IMAGE_LINE.exec(bare(lines[at])) as RegExpExecArray)[1];
  const block = [lines[at]];
  const plain = (i: number): boolean =>
    i < lines.length && !isBlank(lines[i]) && !guarded[i] && !/^\s*#/.test(lines[i]);
  if (plain(at + 1) && !IMAGE_LINE.test(bare(lines[at + 1]))) {
    block.push(lines[at + 1]);
    if (plain(at + 2) && SOURCE_LINE.test(bare(lines[at + 2]))) block.push(lines[at + 2]);
  }
  if (block.length < 3) return { lines: block };
  const detail = bare(block[2]).replace(SOURCE_LINE, "");
  const entry = translateNote(language as ContentLanguage, "note.image_source_entry_0_1", alt, detail);
  return { lines: block, ...(entryLines(lines, entry).length === 1 ? { entry } : {}) };
}

/** Where `- entry` stands as a whole line outside code (line ends ignored). */
const entryLines = (lines: readonly string[], entry: string): number[] => {
  const fenced = fencedLines([...lines]);
  return lines.flatMap((line, i) => (!fenced[i] && bare(line) === `- ${entry}` ? [i] : []));
};

/** The new block of a chosen picture, in the line ends of the block it replaces (what `fillSlotMarkers` writes for a figure). */
export function figureLines(figure: SlotFigure, cr: boolean): string[] {
  const end = cr ? "\r" : "";
  return [`![${figure.alt}](${figure.href})`, figure.caption, ...(figure.source ? [figure.source.line] : [])].map(
    line => `${line}${end}`
  );
}

/** The latest valid record line of a Detail (the one `latestSlotsRecord` reads), exactly as it stands; undefined when none. */
export function slotsRecordLine(raw: string): string | undefined {
  const lines = (detailBlockOf(raw) ?? "").split("\n");
  const fenced = fencedLines(lines);
  let found: string | undefined;
  lines.forEach((line, i) => {
    const m = fenced[i] ? null : RECORD_LINE.exec(bare(line).trim());
    if (!m) return;
    try {
      if (Array.isArray((JSON.parse(m[2]) as { slots?: unknown }).slots)) found = line;
    } catch {
      // a damaged record is no record
    }
  });
  return found;
}

/** The record line with only slot `index` changed to the new picture's hash and `off` flag; every other item and field as it was. */
export function retagRecordLine(line: string, index: number, hash: string, off: boolean): string | undefined {
  const cr = line.endsWith("\r") ? "\r" : "";
  const lead = /^\s*/.exec(line)?.[0] ?? "";
  const m = RECORD_LINE.exec(bare(line).trim());
  if (!m) return undefined;
  const data = JSON.parse(m[2]) as SlotsRecord & Record<string, unknown>;
  let hit = false;
  const slots = data.slots.map(item => {
    if (item.index !== index || item.state !== "placed") return item;
    hit = true;
    const next: Record<string, unknown> = { ...item, hash };
    delete next.off;
    return off ? { ...next, off: true } : next;
  });
  if (!hit) return undefined;
  return `${lead}${m[1]}<!-- book-slots:v1 ${JSON.stringify({ ...data, slots })} -->${cr}`;
}

/** One picture swap: the block, the Sources entry (absent on a side: none there) and the record line, each as exact text. */
export interface FigureSwap {
  block: { from: string[]; to: string[] };
  entry: { from?: string; to?: string; href?: string };
  record: { from: string; to: string };
}

/** The same swap the other way (the undo). */
export const reverseSwap = (swap: FigureSwap): FigureSwap => ({
  block: { from: swap.block.to, to: swap.block.from },
  entry: { from: swap.entry.to, to: swap.entry.from, href: swap.entry.href },
  record: { from: swap.record.to, to: swap.record.from }
});

/**
 * `raw` with one picture swapped, or undefined when the text no longer holds what the swap starts from (the block not exactly once
 * outside code and quotes, or the record line not the latest one): nothing is guessed. The Sources entry is replaced in place, removed
 * when the new picture has none, and added (as the fill adds one) when the old one is no longer there. Nothing else changes.
 */
export function swapFigure(raw: string, swap: FigureSwap, language: string): string | undefined {
  const found = detailOf(raw);
  if (!found) return undefined;
  let lines = found.detail.split("\n");
  const guarded = protectedLines(lines);
  const size = swap.block.from.length;
  const starts: number[] = [];
  for (let i = 0; i + size <= lines.length; i++)
    if (!guarded[i] && swap.block.from.every((line, k) => lines[i + k] === line)) starts.push(i);
  if (starts.length !== 1) return undefined;
  lines = [...lines.slice(0, starts[0]), ...swap.block.to, ...lines.slice(starts[0] + size)];
  const records = lines.flatMap((line, i) => (line === swap.record.from ? [i] : []));
  if (records.length !== 1 || slotsRecordLine(`${DETAIL_START}${lines.join("\n")}${DETAIL_END}`) !== swap.record.from)
    return undefined;
  lines[records[0]] = swap.record.to;
  const cr = found.detail.includes("\r\n") ? "\r" : "";
  const old = swap.entry.from === undefined ? [] : entryLines(lines, swap.entry.from);
  let detail: string;
  if (old.length === 1) {
    if (swap.entry.to === undefined) lines.splice(old[0], 1);
    else lines[old[0]] = `- ${swap.entry.to}${lines[old[0]].endsWith("\r") ? "\r" : cr}`;
    detail = lines.join("\n");
  } else if (swap.entry.to !== undefined && swap.entry.href)
    detail = addPictureSources(lines.join("\n"), [{ href: swap.entry.href, entry: swap.entry.to }], language);
  else detail = lines.join("\n");
  return `${raw.slice(0, found.at)}${detail}${raw.slice(found.at + found.detail.length)}`;
}

/**
 * The swap as the program's write of the chapter: the fingerprint follows when the chapter was as the program left it (a hand-edited
 * chapter stays hand-edited). The reader's answer "keep my version" (or "accept as it is") for the text before the swap holds for the
 * text after it: the reader asked for this one picture, so the keep is not voided and the review box is not asked again. A keep already
 * voided by an edit stays voided. Undefined: the swap does not fit the text (see {@link swapFigure}).
 */
export function swapFigureStamped(raw: string, swap: FigureSwap, language: string): string | undefined {
  const next = swapFigure(raw, swap, language);
  if (next === undefined) return undefined;
  const stamped = programStampRaw(raw, next);
  return isKeptRaw(raw) ? keepRaw(stamped) : stamped;
}
