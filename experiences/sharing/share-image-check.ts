/**
 * Before a picture book is shared: finds the book's pictures in a note's Markdown, tells from each picture's own source line how
 * it is licensed (see licenceStatus), and can cut chosen pictures (image line, caption, source line and the card's Sources entry)
 * out of a copy of the text. Pure: the note itself is never written. Only the card's body pictures count; a cover lives in the
 * front matter and is always a Wikimedia Commons file.
 */

import { licenceStatus, restrictedKind, type LicenceStatus } from "../../core/book-pipeline/image-licence";
import { fencedLines } from "../../core/book-pipeline/note-sections";

export type FigureProblem = "unknown" | "nc" | "nd" | "restricted";

export interface ShareFigure {
  /** Place of the picture among the note's pictures (the same text always numbers them the same way). */
  index: number;
  alt: string;
  /** The source page's host (no `www.`), empty when the picture has no source line. */
  host: string;
  status: LicenceStatus;
  /** The chip: absent for an open picture. */
  problem?: FigureProblem;
  /** 0-based line range of the picture, its caption and its source line (end exclusive). */
  from: number;
  to: number;
}

const IMAGE_LINE = /^[ \t]*(?:!\[([^\]\n]*)\]\(([^)\n]+)\)|!\[\[([^\]\n]+)\]\])[ \t]*\r?$/;
const SOURCE_LINE = /^(?:來源|来源|Source)[:：][ \t]*(\S.*?)\r?$/;
const SOURCES_ENTRY = /^[ \t]*[-*+][ \t]+(?:圖「(.*?)」|图“(.*?)”|Picture “(.*?)”)([^:：]{0,12})[:：][ \t]*(.*?)\r?$/;
const BOOK_RECORD = "<!-- book-slots:v1";
const CAPTION_MAX = 200;
const AUTHOR_PART = /^(?:作者|by)[ \t]/i;
const LINK = /\[[^\]\n]*\]\((https:\/\/[^)\s]+)\)/g;

/** The source page and the licence text of a source line's detail (`site · by X · licence (link)`). */
function parseDetail(detail: string): { href: string; license: string; host: string } {
  let href = "";
  for (const match of detail.matchAll(LINK)) href = match[1];
  const parts = detail
    .replace(LINK, "")
    .replace(/[（(][ \t]*[）)]/g, "")
    .split(" · ")
    .map(part => part.trim())
    .filter(Boolean);
  const license = parts
    .slice(1)
    .filter(part => !AUTHOR_PART.test(part))
    .join(" ");
  let host = "";
  try {
    host = new URL(href).hostname.replace(/^www\./i, "");
  } catch {
    host = "";
  }
  return { href, license, host };
}

const altOf = (match: RegExpExecArray): string => {
  if (match[1] !== undefined) return match[1];
  return (match[3].split("|")[1] ?? "").trim();
};

/** The note's pictures with their licence state. Empty for a note that is not a picture book (no source line, no slot record). */
export function figuresOf(markdown: string): ShareFigure[] {
  const lines = markdown.split("\n");
  const fenced = fencedLines(lines);
  const entries = new Map<string, string>();
  lines.forEach((line, at) => {
    const match = fenced[at] ? null : SOURCES_ENTRY.exec(line);
    if (match && !/封面|cover/i.test(match[4])) entries.set(match[1] ?? match[2] ?? match[3], match[5]);
  });
  const found: { from: number; to: number; alt: string; detail?: string }[] = [];
  for (let at = 0; at < lines.length; at++) {
    const image = fenced[at] ? null : IMAGE_LINE.exec(lines[at]);
    if (!image) continue;
    let to = at + 1;
    let detail: string | undefined;
    const next = lines[to];
    const nextSource = next === undefined ? null : SOURCE_LINE.exec(next);
    if (nextSource) detail = nextSource[1];
    else if (next !== undefined && next.trim() && !IMAGE_LINE.test(next) && next.length <= CAPTION_MAX) {
      // A caption only counts when a source line, a blank line or the end of the file follows it; otherwise it is the user's own paragraph.
      const after = lines[to + 1] === undefined ? null : SOURCE_LINE.exec(lines[to + 1]);
      if (after) {
        detail = after[1];
        to++;
      } else if (lines[to + 1] === undefined || !lines[to + 1].trim()) to++;
    }
    if (detail !== undefined) to++;
    const alt = altOf(image);
    found.push({ from: at, to, alt, detail: detail ?? (alt ? entries.get(alt) : undefined) });
    at = to - 1;
  }
  if (!found.some(item => item.detail !== undefined) && !markdown.includes(BOOK_RECORD)) return [];
  return found.map((item, index) => {
    const parsed = item.detail === undefined ? null : parseDetail(item.detail);
    const status = parsed ? licenceStatus({ source: parsed.href, license: parsed.license }) : "unknown";
    const kind = status === "restricted" ? restrictedKind(parsed?.license) : undefined;
    return {
      index,
      alt: item.alt,
      host: parsed?.host ?? "",
      status,
      ...(status === "unknown"
        ? { problem: "unknown" as const }
        : kind
          ? { problem: kind === "other" ? ("restricted" as const) : kind }
          : {}),
      from: item.from,
      to: item.to
    };
  });
}

/** The text without the chosen pictures (by {@link ShareFigure.index}): image, caption and source lines, and the picture's Sources entry. */
export function withoutFigures(markdown: string, indexes: ReadonlySet<number>): string {
  if (!indexes.size) return markdown;
  const figures = figuresOf(markdown).filter(figure => indexes.has(figure.index));
  if (!figures.length) return markdown;
  const lines = markdown.split("\n");
  const drop = new Set<number>();
  for (const figure of figures) {
    for (let at = figure.from; at < figure.to; at++) drop.add(at);
    if (!figure.alt) continue;
    const entry = lines.findIndex((line, at) => {
      const match = drop.has(at) ? null : SOURCES_ENTRY.exec(line);
      return !!match && (match[1] ?? match[2] ?? match[3]) === figure.alt && !/封面|cover/i.test(match[4]);
    });
    if (entry >= 0) drop.add(entry);
  }
  return lines.filter((_, at) => !drop.has(at)).join("\n");
}
