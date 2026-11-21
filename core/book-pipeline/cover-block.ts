/**
 * The cover block of a picture-book note (plan 2026-11-21-book-cover-image, A2): it sits directly under `# Title`,
 *
 *   <!-- book-cover:v1 {"file":"…","key":"…","hash":"…"} -->
 *   ![[file]] / caption / 這張圖可能對不上 / 來源：[Wikimedia Commons](…)      (or the "no cover found" line)
 *   <!-- book-cover:end -->
 *
 * The marker records which file the program placed, the picture's key (other cards read it, so one picture is used once per book) and
 * a hash of the block's text; a block the owner edited no longer matches its hash and is then theirs. Pure: no I/O.
 */

import { imageKey } from "./image-dedupe";
import { fencedLines } from "./note-sections";
import { safeHref } from "./proof";
import { escapeMarkdownText, hashText } from "./text";

export type CoverLevel = "chapter" | "section" | "book";
export type CoverLanguage = "zh" | "en";

/** A cover the finder chose and the program saved: the vault file, the picture's address, its caption and its Commons file page. */
export interface CoverFound {
  file: string;
  url: string;
  caption: string;
  sourceUrl: string;
  /** The picture may not fit the card (the same off rule as a body picture): the block says so. */
  off?: boolean;
}

const START = /^<!-- book-cover:v1 (\{.*\}) -->$/;
const END_LINE = "<!-- book-cover:end -->";
const MISSING_TEXT: Record<CoverLanguage, Record<CoverLevel, string>> = {
  zh: {
    chapter: "這一章沒找到合適的封面圖。",
    section: "這一節沒找到合適的封面圖。",
    book: "這本書沒找到合適的封面圖。"
  },
  en: {
    chapter: "No suitable cover picture was found for this chapter.",
    section: "No suitable cover picture was found for this section.",
    book: "No suitable cover picture was found for this book."
  }
};
const OFF_TEXT: Record<CoverLanguage, string> = { zh: "這張圖可能對不上", en: "This picture may not match." };
const SOURCE_LABEL: Record<CoverLanguage, string> = { zh: "來源：", en: "Source: " };

/** A link path safe inside `[[...]]` and a YAML scalar (the same rule `withCover` applies, so the block and `topic-cover` agree). */
export const coverLinkOf = (file: string): string => file.replace(/[[\]|\r\n]/g, " ").trim();

const json = (value: object): string => JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
const wrap = (record: object, inner: string): string => `<!-- book-cover:v1 ${json(record)} -->\n${inner}\n${END_LINE}`;

/** A Commons file description page (`https://commons.wikimedia.org/wiki/File:…`) as a safe link, or undefined. */
function commonsFilePage(value: string): string | undefined {
  const href = safeHref(value);
  if (!href) return undefined;
  const url = new URL(href);
  return url.hostname === "commons.wikimedia.org" && url.pathname.startsWith("/wiki/File:") ? href : undefined;
}

/**
 * The block text (markers included, no trailing line break). Found: the embed, the caption, the "may not match" line when `off`,
 * and the Commons file page as the source; undefined when the file or the source page is not usable (the caller then treats the cover as not found).
 * Not found (`found` omitted): only the line of the card's level.
 */
export function composeCoverBlock(level: CoverLevel, language: CoverLanguage, found?: CoverFound): string | undefined {
  if (!found) {
    const inner = MISSING_TEXT[language][level];
    return wrap({ missing: 1, hash: hashText(inner) }, inner);
  }
  const file = coverLinkOf(found.file);
  const href = commonsFilePage(found.sourceUrl);
  if (!file || !href) return undefined;
  const caption = escapeMarkdownText(found.caption, 200);
  const inner = [
    `![[${file}]]`,
    caption,
    found.off ? OFF_TEXT[language] : "",
    `${SOURCE_LABEL[language]}[Wikimedia Commons](${href})`
  ]
    .filter(Boolean)
    .join("\n");
  return wrap({ file, key: imageKey(found.url), hash: hashText(inner) }, inner);
}

export interface CoverBlock {
  /** The vault file the program placed (absent on a "not found" block). */
  file?: string;
  /** The placed picture's key (absent on a "not found" block). */
  key?: string;
  missing: boolean;
  /** The block's text still hashes to the recorded hash: nobody edited it. */
  intact: boolean;
  /** Offsets of the block (start marker to end marker) in the raw text, end exclusive and without the line break after it. */
  from: number;
  to: number;
}

function lineStarts(raw: string): number[] {
  const starts = [0];
  for (let at = raw.indexOf("\n"); at >= 0; at = raw.indexOf("\n", at + 1)) starts.push(at + 1);
  return starts;
}

/** The first cover block outside a code fence, or undefined. A damaged marker (not JSON, no hash) is not a block. */
export function readCoverBlock(raw: string): CoverBlock | undefined {
  const lines = raw.split("\n");
  const fenced = fencedLines(lines);
  const starts = lineStarts(raw);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, "");
    const m = !fenced[i] ? START.exec(line) : null;
    if (!m) continue;
    let record: { file?: unknown; key?: unknown; hash?: unknown; missing?: unknown };
    try {
      record = JSON.parse(m[1]) as typeof record;
    } catch {
      continue;
    }
    if (typeof record.hash !== "string") continue;
    const end = lines.findIndex((value, at) => at > i && !fenced[at] && value.replace(/\r$/, "") === END_LINE);
    if (end < 0) continue;
    const inner = lines
      .slice(i + 1, end)
      .map(value => value.replace(/\r$/, ""))
      .join("\n");
    return {
      ...(typeof record.file === "string" ? { file: record.file } : {}),
      ...(typeof record.key === "string" ? { key: record.key } : {}),
      missing: record.missing === 1,
      intact: hashText(inner) === record.hash,
      from: starts[i],
      to: starts[end] + lines[end].replace(/\r$/, "").length
    };
  }
  return undefined;
}

/** The picture key a card's cover block records (other cards read it, so the same picture is not used twice in a book). */
export function coverSourceKey(raw: string): string | undefined {
  return readCoverBlock(raw)?.key;
}

/**
 * Who owns a note's cover. `none`: no `topic-cover` and no block, the program may write one. `program`: the block is intact and agrees with
 * `topic-cover` (a placed block whose file `topic-cover` names, or a not-found block with no `topic-cover`; an intact placed block whose
 * `topic-cover` was only removed counts too, it is still the program's text). `owner`: everything else (`topic-cover: none`, a `topic-cover`
 * with no block or another file, a block whose text changed): the program must not find, write or replace anything.
 */
export function coverOwnership(raw: string): "none" | "program" | "owner" {
  const declared = declaredCover(raw);
  const block = readCoverBlock(raw);
  if (!block) return declared === undefined ? "none" : "owner";
  if (!block.intact) return "owner";
  if (declared === undefined) return "program";
  if (block.missing || !block.file) return "owner";
  const target = /^\[\[([^\]|]*)(?:\|[^\]]*)?\]\]$/.exec(declared)?.[1].trim();
  return target === block.file ? "program" : "owner";
}

/** The raw `topic-cover` value of the frontmatter (quotes removed), or undefined when the key is absent. */
function declaredCover(raw: string): string | undefined {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  const line = frontmatter ? /^topic-cover:[ \t]*(.*?)[ \t]*$/m.exec(frontmatter[1]) : null;
  return line ? line[1].replace(/^["']|["']$/g, "") : undefined;
}

/** The first `# Title` line outside the frontmatter and code fences: where it starts and where the line break after it ends. */
function titleLine(raw: string): { end: number } | undefined {
  const lines = raw.split("\n");
  const fenced = fencedLines(lines);
  const starts = lineStarts(raw);
  let at = 0;
  if (/^---\r?$/.test(lines[0] ?? "")) {
    const close = lines.findIndex((value, i) => i > 0 && /^---\r?$/.test(value));
    at = close < 0 ? 0 : close + 1;
  }
  for (let i = at; i < lines.length; i++) {
    if (!fenced[i] && /^# /.test(lines[i])) return { end: i + 1 < lines.length ? starts[i + 1] : raw.length };
  }
  return undefined;
}

/** `block` with the note's own line ending. */
const eolOf = (raw: string): string => (raw.includes("\r\n") ? "\r\n" : "\n");

/** Removes the block and the blank lines after it; everything else stays as written. */
export function stripCoverBlock(raw: string): string {
  const block = readCoverBlock(raw);
  if (!block) return raw;
  let to = block.to;
  const tail = /^(?:\r?\n)+/.exec(raw.slice(to));
  to += tail ? tail[0].length : 0;
  return raw.slice(0, block.from) + raw.slice(to);
}

/**
 * Puts the block directly under the `# Title` line (one blank line between them and one before what follows), replacing an earlier block.
 * A note with no `# Title` is returned as it is.
 */
export function putCoverBlock(raw: string, block: string): string {
  const eol = eolOf(raw);
  const text = block.replace(/\n/g, eol);
  const bare = stripCoverBlock(raw);
  const title = titleLine(bare);
  if (!title) return raw;
  const head = bare.slice(0, title.end);
  const rest = bare.slice(title.end).replace(/^(?:[ \t]*\r?\n)+/, "");
  const lead = head.endsWith("\n") ? "" : eol;
  return `${head}${lead}${eol}${text}${rest ? `${eol}${eol}${rest}` : eol}`;
}
