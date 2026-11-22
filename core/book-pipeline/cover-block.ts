/**
 * The cover of a picture-book card (plan 2026-11-21-book-cover-image; moved out of the text by 2026-11-22-book-cover-placement). The
 * picture is shown by the card and the export through `topic-cover`; the note's text has no cover in it. What the program needs to know
 * about the cover it placed is one frontmatter key,
 *
 *   book-cover: "{\"file\":\"…\",\"key\":\"…\"}"        (or {"missing":1} when no cover was found; "off":1 when it may not fit)
 *
 * and the picture's credit is one line of the card's Sources list (`- 圖「…」（封面）：…`).
 *
 * Older notes have a cover block directly under `# Title` instead:
 *
 *   <!-- book-cover:v1 {"file":"…","key":"…","hash":"…"} -->
 *   ![[file]] / caption / 這張圖可能對不上 / 來源：[Wikimedia Commons](…)      (or the "no cover found" line)
 *   <!-- book-cover:end -->
 *
 * It is still read (a block the owner edited no longer matches its hash and is then theirs), and {@link migrateLegacyCover} turns the
 * program's own intact block into the key and the credit line. Pure: no I/O.
 */

import { imageKey } from "./image-dedupe";
import { fencedLines } from "./note-sections";
import { safeHref } from "./proof";
import { escapeMarkdownText, hashText } from "./text";
import { translateNote, type ContentLanguage } from "../../i18n";

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
export function commonsFilePage(value: string): string | undefined {
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
  return wrap({ file, key: imageKey(found.url), hash: hashText(inner), ...(found.off ? { off: 1 } : {}) }, inner);
}

export interface CoverBlock {
  /** The vault file the program placed (absent on a "not found" block). */
  file?: string;
  /** The placed picture's key (absent on a "not found" block). */
  key?: string;
  missing: boolean;
  /** The placed picture may not fit the card (the block says so; the card is flagged for a look). */
  off: boolean;
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

/** The index of the first `# Title` line outside the frontmatter and code fences, or -1. */
function titleIndex(lines: readonly string[], fenced: readonly boolean[]): number {
  let at = 0;
  if (/^---\r?$/.test(lines[0] ?? "")) {
    const close = lines.findIndex((value, i) => i > 0 && /^---\r?$/.test(value));
    at = close < 0 ? 0 : close + 1;
  }
  for (let i = at; i < lines.length; i++) if (!fenced[i] && /^# /.test(lines[i])) return i;
  return -1;
}

/**
 * The cover block directly under the `# Title` line (only blank lines between), or undefined. A block anywhere else in the note (in
 * Detail, below it, inside a fence) is just text and is never a cover block: map chat or an author could write one there. A damaged
 * marker (not JSON, no hash, no end marker) is not a block.
 */
export function readCoverBlock(raw: string): CoverBlock | undefined {
  const lines = raw.split("\n");
  const fenced = fencedLines(lines);
  const title = titleIndex(lines, fenced);
  if (title < 0) return undefined;
  let i = title + 1;
  while (i < lines.length && lines[i].trim() === "") i++;
  const m = i < lines.length && !fenced[i] ? START.exec(lines[i].replace(/\r$/, "")) : null;
  if (!m) return undefined;
  const starts = lineStarts(raw);
  let record: { file?: unknown; key?: unknown; hash?: unknown; missing?: unknown; off?: unknown };
  try {
    record = JSON.parse(m[1]) as typeof record;
  } catch {
    return undefined;
  }
  if (typeof record.hash !== "string") return undefined;
  const end = lines.findIndex((value, at) => at > i && !fenced[at] && value.replace(/\r$/, "") === END_LINE);
  if (end < 0) return undefined;
  const inner = lines
    .slice(i + 1, end)
    .map(value => value.replace(/\r$/, ""))
    .join("\n");
  return {
    ...(typeof record.file === "string" ? { file: record.file } : {}),
    ...(typeof record.key === "string" ? { key: record.key } : {}),
    missing: record.missing === 1,
    off: record.off === 1,
    intact: hashText(inner) === record.hash,
    from: starts[i],
    to: starts[end] + lines[end].replace(/\r$/, "").length
  };
}

/** What the program recorded about a card's cover: the frontmatter `book-cover` key, or (older notes) the block under the title. */
export interface CoverRecord {
  file?: string;
  key?: string;
  caption?: string;
  /** The Commons file page the credit line in the Sources list names (see {@link removeCoverCredit}). */
  source?: string;
  missing: boolean;
  /** The placed picture may not fit the card (the card is flagged for a look). */
  off: boolean;
  /** Set when read from an old in-text block. */
  block?: CoverBlock;
}

/** What {@link setCoverRecord} writes: a placed cover, or `{ missing: 1 }`. */
export type CoverRecordValue =
  { file: string; key: string; caption?: string; source?: string; off?: 1 } | { missing: 1 };

const RECORD_KEY = "book-cover";

/** The `book-cover` frontmatter line's value as a record, or undefined (no key, not JSON, neither a placed nor a missing record). */
function frontmatterRecord(raw: string): CoverRecord | undefined {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  const line = frontmatter ? new RegExp(`^${RECORD_KEY}:[ \\t]*(.*?)[ \\t]*$`, "m").exec(frontmatter[1]) : null;
  if (!line) return undefined;
  let value: unknown;
  try {
    // The key is written as a double-quoted YAML string; a tidy of the frontmatter may have turned it into a single-quoted or plain one.
    const text = line[1].startsWith("'") && line[1].endsWith("'") ? line[1].slice(1, -1).replace(/''/g, "'") : line[1];
    value = JSON.parse(text);
    if (typeof value === "string") value = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as {
    file?: unknown;
    key?: unknown;
    caption?: unknown;
    source?: unknown;
    missing?: unknown;
    off?: unknown;
  };
  if (record.missing === 1) return { missing: true, off: false };
  if (typeof record.file !== "string" || !record.file || typeof record.key !== "string") return undefined;
  return {
    file: record.file,
    key: record.key,
    ...(typeof record.caption === "string" ? { caption: record.caption } : {}),
    ...(typeof record.source === "string" ? { source: record.source } : {}),
    missing: false,
    off: record.off === 1
  };
}

/** The cover the note records: the frontmatter key first, else an old block under the title (see {@link readCoverBlock}). */
export function readCoverRecord(raw: string): CoverRecord | undefined {
  const own = frontmatterRecord(raw);
  if (own) return own;
  const block = readCoverBlock(raw);
  return block
    ? {
        ...(block.file ? { file: block.file } : {}),
        ...(block.key ? { key: block.key } : {}),
        missing: block.missing,
        off: block.off,
        block
      }
    : undefined;
}

/** The picture key a card's cover records (other cards read it, so the same picture is not used twice in a book). */
export function coverSourceKey(raw: string): string | undefined {
  return readCoverRecord(raw)?.key;
}

/**
 * The exact text of the cover block the note already has directly under its `# Title` (the program's, or one the owner edited: both are
 * the note's own text, put back as they were). Call it on the note as it stands in the vault (the text a write is about to replace, or
 * the note the program itself just wrote), never on text an author produced: a block inside an author's text is only text.
 */
export function trustedCoverBlock(raw: string): string | undefined {
  const block = readCoverBlock(raw);
  return block ? raw.slice(block.from, block.to).replace(/\r$/, "") : undefined;
}

/** Removes the block under the title and the blank lines after it (repeatedly, in case another follows); used on text that is not the program's. */
export function stripAllCoverBlocks(raw: string): string {
  let text = raw;
  for (let i = 0; i < 20 && readCoverBlock(text); i++) text = stripCoverBlock(text);
  return text;
}

/** The note's placed cover is the program's own and its record says the picture may not fit its ask. */
export function coverIsOff(raw: string): boolean {
  const record = readCoverRecord(raw);
  return !!record && record.off && coverOwnership(raw) === "program";
}

/**
 * Who owns a note's cover. `none`: no record, no `topic-cover`, no block: the program may write one. `program`: the record agrees with
 * `topic-cover` (a placed record whose file `topic-cover` names or that has no `topic-cover`; a not-found record with no `topic-cover`).
 * An old block counts only while intact (unedited), by the same rule. `owner`: everything else (`topic-cover: none`, a `topic-cover`
 * with no record or another file, an edited old block): the program must not find, write or replace anything.
 */
export function coverOwnership(raw: string): "none" | "program" | "owner" {
  const declared = declaredCover(raw);
  const record = readCoverRecord(raw);
  if (!record) return declared === undefined ? "none" : "owner";
  if (record.block && !record.block.intact) return "owner";
  if (declared === undefined) return "program";
  if (record.missing || !record.file) return "owner";
  return coverDeclaredTarget(raw) === record.file ? "program" : "owner";
}

/** The file `topic-cover` already links (`[[path]]` or `[[path|alias]]`), or undefined when there is none or it is not a link. */
export function coverDeclaredTarget(raw: string): string | undefined {
  const declared = declaredCover(raw);
  return declared === undefined ? undefined : /^\[\[([^\]|]*)(?:\|[^\]]*)?\]\]$/.exec(declared)?.[1].trim();
}

/** The raw `topic-cover` value of the frontmatter (quotes removed), or undefined when the key is absent. */
function declaredCover(raw: string): string | undefined {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  const line = frontmatter ? /^topic-cover:[ \t]*(.*?)[ \t]*$/m.exec(frontmatter[1]) : null;
  return line ? line[1].replace(/^["']|["']$/g, "") : undefined;
}

/**
 * Sets the `book-cover` frontmatter line (a YAML double-quoted string holding the record's JSON); everything else stays as written. The
 * JSON has no space in it (`\u0020`), so a YAML writer that folds long lines at spaces can never split it.
 */
export function setCoverRecord(raw: string, record: CoverRecordValue): string {
  const eol = eolOf(raw);
  const line = `${RECORD_KEY}: ${JSON.stringify(JSON.stringify(record).replace(/ /g, "\\u0020"))}`;
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?=\r?\n|$)/.exec(raw);
  if (!match) return `---${eol}${line}${eol}---${eol}${raw}`;
  const lines = match[1].split(/\r?\n/);
  const at = lines.findIndex(value => value.startsWith(`${RECORD_KEY}:`));
  if (at >= 0) lines[at] = line;
  else lines.push(line);
  return `---${eol}${lines.join(eol)}${eol}---${raw.slice(match[0].length)}`;
}

/** Takes the program's own intact old block out of the text (one the owner edited or pasted stays as it is) and records the cover in the frontmatter. */
export function placeCover(raw: string, record: CoverRecordValue): string {
  return setCoverRecord(readCoverBlock(raw)?.intact ? stripCoverBlock(raw) : raw, record);
}

/**
 * The Sources-list line the program wrote for the cover whose Commons page is `href` (the cover entry's shape and that link), taken out
 * so a new cover replaces it. Any other line, body-picture credits included, stays.
 */
export function removeCoverCredit(detail: string, href: string, language: string): string {
  const [before, middle, after] = translateNote(
    language as ContentLanguage,
    "note.cover_source_entry_0_1",
    "\uE000",
    "\uE001"
  ).split(/[\uE000\uE001]/);
  const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const shape = new RegExp(`^- ${escape(before)}.*${escape(middle)}.*\\]\\(${escape(href)}\\).*${escape(after)}\\r?$`);
  return detail
    .split("\n")
    .filter(line => !shape.test(line))
    .join("\n");
}

/**
 * The program's own intact old block as what replaces it: the record and, for a placed cover, its credit (the Commons file page and the
 * Sources-list entry). Undefined when the note has no such block, it was edited, it has another cover record already, or its source
 * link cannot be read (it is then left as it is: still read as before).
 */
export function migrateLegacyCover(
  raw: string,
  language: string,
  title: string
): { record: CoverRecordValue; credit?: { href: string; entry: string } } | undefined {
  const block = readCoverBlock(raw);
  if (!block || !block.intact || frontmatterRecord(raw)) return undefined;
  if (block.missing) return { record: { missing: 1 } };
  if (!block.file || !block.key) return undefined;
  const inner = raw.slice(block.from, block.to).replace(/\r/g, "").split("\n").slice(1, -1);
  const href = commonsFilePage(/\]\((https:[^)\s]+)\)$/.exec(inner[inner.length - 1] ?? "")?.[1] ?? "");
  if (!href) return undefined;
  const caption = inner.slice(1, -1).filter(value => value !== OFF_TEXT.zh && value !== OFF_TEXT.en)[0] ?? "";
  const lang = language as ContentLanguage;
  const link = `[${translateNote(lang, "note.image_link")}](${href.replace(/\(/g, "%28").replace(/\)/g, "%29")})`;
  return {
    record: {
      file: block.file,
      key: block.key,
      ...(caption ? { caption } : {}),
      source: href,
      ...(block.off ? { off: 1 } : {})
    },
    credit: {
      href,
      entry: translateNote(
        lang,
        "note.cover_source_entry_0_1",
        caption || escapeMarkdownText(title, 200),
        translateNote(lang, "note.image_source_0_1", "commons.wikimedia.org", link)
      )
    }
  };
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
