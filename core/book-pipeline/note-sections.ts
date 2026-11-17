/**
 * Pure edits of the two note sections the picture-book pipeline owns: the Research notes section of a card's Detail (the
 * folded callout that holds the proof records) and the `## 全書企劃` section of the root note. Nothing else in the text is touched.
 */
import {
  isNewSourcesHeading,
  isOpenQuestionsHeading,
  isResearchNotesHeading,
  SECTION_NAME
} from "../../ai/section-aliases";
import { NOTE_LANGUAGES, translate } from "../../i18n";
import { demoteHeadings } from "./text";
import { findProofRecord, PROOF_STATUSES, type ProofItemResult, type ProofResult } from "./proof";

export const BOOK_PLAN_HEADING = "全書企劃";
const DEFAULT_RESEARCH_HEADING = "研究備註";
const HEADING = /^[ \t]{0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;
const FENCE = /^[ \t]{0,3}(`{3,}|~{3,})/;
const CALLOUT_HEAD = /^>[ \t]?\[![A-Za-z][\w-]*\][+-]?(?:[ \t].*)?$/;
const RECORD_KEY = /^<!-- book-proof:v1 (\{.*\}) -->$/;

/** Per line: true inside a fenced code block (the fence lines included). */
function fencedLines(lines: string[]): boolean[] {
  const flags: boolean[] = [];
  let open: string | undefined;
  for (const line of lines) {
    const m = FENCE.exec(line);
    if (open) {
      flags.push(true);
      if (m && m[1][0] === open[0] && m[1].length >= open.length && !line.replace(FENCE, "").trim()) open = undefined;
    } else if (m) {
      open = m[1];
      flags.push(true);
    } else flags.push(false);
  }
  return flags;
}

/** The first heading line (outside code) whose text matches, and the index where its section ends (next heading of the same or a higher level). */
function findSection(
  lines: string[],
  fenced: boolean[],
  matches: (text: string, level: number) => boolean,
  from = 0
): { at: number; end: number; text: string } | undefined {
  for (let i = from; i < lines.length; i++) {
    const m = fenced[i] ? null : HEADING.exec(lines[i].replace(/\r$/, ""));
    if (!m || !matches(m[2], m[1].length)) continue;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      const n = fenced[j] ? null : HEADING.exec(lines[j].replace(/\r$/, ""));
      if (n && n[1].length <= m[1].length) {
        end = j;
        break;
      }
    }
    return { at: i, end, text: m[2] };
  }
  return undefined;
}

/** A text with the `> ` quote prefix removed from each line, so a record inside a callout is read as the plain record line. */
const unquoted = (text: string): string => text.replace(/^[ \t]{0,3}>[ \t]?/gm, "");

/** The dedupe key of a composed proof record (its `book-proof` line), or undefined. */
function recordKey(record: string): string | undefined {
  for (const line of record.split(/\r?\n/)) {
    const m = RECORD_KEY.exec(line.trim());
    if (!m) continue;
    try {
      const key = (JSON.parse(m[1]) as { key?: unknown }).key;
      if (typeof key === "string") return key;
    } catch {
      // not a record
    }
  }
  return undefined;
}

/**
 * Appends one composed proof record (`composeProofRecord`) to the Research notes section of a Detail, every line as a `> `
 * quote line of the folded callout (inside the existing callout when there is one, else a new `> [!note]- <name>` callout
 * after the section's text; no such section: a new `### 研究備註` section at the end). The callout title is the section's own name.
 * The same record key already stored (read with the `> ` prefix removed) leaves the text exactly as it is. A record carries
 * no raw model text (composeProofRecord escapes it), and every line gets the quote prefix, so no heading, image, link, `%%`,
 * HTML or fence can form.
 */
export function appendResearchNote(detail: string, record: string): { text: string; appended: boolean } {
  const key = recordKey(record);
  if (key && findProofRecord(unquoted(detail), key)) return { text: detail, appended: false };
  const quoted = record
    .split(/\r?\n/)
    .map(line => (line.trim() ? `> ${line}` : ">"))
    .join("\n");
  const lines = detail.split("\n");
  const section = findSection(lines, fencedLines(lines), text => isResearchNotesHeading(text));
  if (!section) {
    const base = detail.replace(/\s+$/, "");
    const callout = `> [!note]- ${DEFAULT_RESEARCH_HEADING}\n${quoted}`;
    return { text: `${base ? `${base}\n\n` : ""}### ${DEFAULT_RESEARCH_HEADING}\n\n${callout}\n`, appended: true };
  }
  const body = lines.slice(section.at + 1, section.end);
  let last = body.length - 1;
  while (last >= 0 && !body[last].trim()) last--;
  const hasCallout = body.some(line => CALLOUT_HEAD.test(line.replace(/\r$/, "")));
  const quoteTail = last >= 0 && /^>/.test(body[last]);
  // A callout that holds nothing but its own title line (every record was taken out of it): the record follows the title directly.
  const titleOnly = last >= 0 && CALLOUT_HEAD.test(body[last].replace(/\r$/, ""));
  const addition =
    hasCallout && quoteTail
      ? `${titleOnly ? "" : ">\n"}${quoted}`
      : `${last >= 0 ? "\n" : ""}> [!note]- ${section.text}\n${quoted}`;
  const head = lines.slice(0, section.at + 1 + last + 1).join("\n");
  const tail = lines.slice(section.at + 1 + last + 1);
  while (tail.length && !tail[0].trim()) tail.shift();
  const rest = tail.length ? `\n\n${tail.join("\n")}` : "\n";
  // A heading with an empty body: `last` is -1, so the callout opens right after one blank line.
  const glue = last >= 0 ? "\n" : "\n\n";
  return { text: `${head}${glue}${addition}${rest}`, appended: true };
}

const PIPELINE_RECORD = /^<!-- (book-(?:proof|slots)):v1 (\{.*\}) -->$/;
const PROOF_ITEM_LINE = /^- .+ (?:達成|未達成|待查)：/;
const QUOTE_BLANK = /^[ \t]{0,3}>[ \t]*\r?$/;
const validJson = (text: string): boolean => {
  try {
    return typeof JSON.parse(text) === "object";
  } catch {
    return false;
  }
};

/**
 * Puts `record` (a composed `book-proof:v1` or `book-slots:v1` record) into the Research notes section as the only record of its
 * kind: every earlier record of that kind (its readable lines, its machine line and the blank quote line before it) is taken out
 * first. Only the pipeline's own valid records go; any other text of the section (the author's research, the owner's notes, other
 * callouts), a damaged record and anything inside a code block stay as they are. No Research notes section: it is added, as
 * {@link appendResearchNote} does.
 */
export function replaceResearchRecord(detail: string, record: string): string {
  const tag = (record
    .split(/\r?\n/)
    .map(line => PIPELINE_RECORD.exec(line.trim()))
    .find(Boolean) ?? [])[1];
  const lines = detail.split("\n");
  const section = tag ? findSection(lines, fencedLines(lines), text => isResearchNotesHeading(text)) : undefined;
  if (!tag || !section) return appendResearchNote(detail, record).text;
  const start = section.at + 1;
  const plain = lines.slice(start, section.end).map(line => unquoted(line).replace(/\r$/, ""));
  const fenced = fencedLines(plain);
  const drop = new Set<number>();
  for (let k = 0; k < plain.length; k++) {
    const m = fenced[k] ? null : PIPELINE_RECORD.exec(plain[k].trim());
    if (!m || m[1] !== tag || !validJson(m[2])) continue;
    drop.add(k);
    let j = k - 1;
    if (tag === "book-proof") {
      while (j >= 0 && !fenced[j] && !drop.has(j) && PROOF_ITEM_LINE.test(plain[j])) drop.add(j--);
      if (j >= 0 && !fenced[j] && !drop.has(j) && PROOF_HEADER.test(plain[j].trim())) drop.add(j--);
    }
    if (j >= 0 && !drop.has(j) && QUOTE_BLANK.test(lines[start + j])) drop.add(j);
  }
  const kept = lines.filter((_, i) => i < start || i >= section.end || !drop.has(i - start));
  return appendResearchNote(kept.join("\n"), record).text;
}

const OLD_MARK = "（舊版）";
const PROOF_HEADER = /^(?:（舊版）)?校對(?:失敗)?（/;
/**
 * Marks every stored proof record whose key is not `currentKey` (or its `:failed` partial) as an old version: its readable first
 * line gets a "（舊版）" prefix; the records themselves stay (nothing is deleted, the machine line is untouched). A text with
 * nothing to mark is returned as it is, so a first run (every record current) changes no byte.
 */
export function markOldProofRecords(detail: string, currentKey: string): string {
  const lines = detail.split("\n");
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    const m = RECORD_KEY.exec(unquoted(lines[i]).trim());
    if (!m) continue;
    let key: unknown;
    try {
      key = (JSON.parse(m[1]) as { key?: unknown }).key;
    } catch {
      continue;
    }
    if (typeof key !== "string" || key === currentKey || key === `${currentKey}:failed`) continue;
    for (let j = i - 1; j >= 0; j--) {
      const plain = unquoted(lines[j]);
      if (RECORD_KEY.test(plain.trim())) break;
      if (!PROOF_HEADER.test(plain.trim())) continue;
      if (!plain.trim().startsWith(OLD_MARK)) {
        lines[j] = lines[j].replace(/^([ \t]{0,3}>[ \t]?)?/, prefix => `${prefix}${OLD_MARK}`);
        changed = true;
      }
      break;
    }
  }
  return changed ? lines.join("\n") : detail;
}

/**
 * The stored proof records of a Detail's Research notes, each as its plain record text (the `> ` prefix removed; the readable
 * first line, the item lines and the `book-proof` machine line), oldest first. A rewrite that replaces the whole Detail uses
 * this to carry the earlier records over (`appendResearchNote` takes each back in); other callout text is not returned.
 */
export function extractProofRecords(detail: string): string[] {
  const lines = detail.split("\n");
  const section = findSection(lines, fencedLines(lines), text => isResearchNotesHeading(text));
  if (!section) return [];
  const records: string[] = [];
  let current: string[] = [];
  for (const line of lines.slice(section.at + 1, section.end)) {
    if (CALLOUT_HEAD.test(line.replace(/\r$/, ""))) continue;
    const plain = unquoted(line).replace(/\r$/, "");
    if (RECORD_KEY.test(plain.trim())) {
      records.push([...current, plain.trim()].join("\n"));
      current = [];
    } else if (plain.trim() || current.length) current.push(plain);
  }
  return records;
}

/** The stored proof result for `key` in a Detail's Research notes (read through the `> ` quote prefix), or undefined. */
export function findStoredProof(detail: string, key: string): ReturnType<typeof findProofRecord> {
  return findProofRecord(unquoted(detail), key);
}

/** What the panel shows of the newest proof record: every field is re-read and cut to plain values (the note may have been edited by hand). */
export interface StoredProofView {
  aggregate: "checked" | "needs-review";
  factsUnverified: boolean;
  failed?: string;
  counts?: { openedPages: number; searches: number };
  items: Pick<ProofItemResult, "id" | "type" | "status" | "note" | "sources">[];
}
const shortText = (value: unknown, max: number): string =>
  typeof value === "string" ? Array.from(value).slice(0, max).join("") : "";
const count = (value: unknown): number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;

/**
 * The newest proof record inside the Research notes section (the last one stored is the latest; an older run's records stay above it).
 * Only that section is read, so a record-looking line elsewhere in the chapter is ignored. A damaged record is skipped.
 */
export function latestStoredProof(detail: string): StoredProofView | undefined {
  const lines = detail.split("\n");
  const section = findSection(lines, fencedLines(lines), text => isResearchNotesHeading(text));
  if (!section) return undefined;
  let found: StoredProofView | undefined;
  for (const line of lines.slice(section.at + 1, section.end)) {
    const m = RECORD_KEY.exec(unquoted(line).trim());
    if (!m) continue;
    try {
      const data = JSON.parse(m[1]) as { result?: Partial<ProofResult>; failed?: unknown };
      const result = data.result;
      if (!result || !Array.isArray(result.items)) continue;
      const items: StoredProofView["items"] = [];
      for (const raw of result.items.slice(0, 100) as unknown as Record<string, unknown>[]) {
        if (!raw || typeof raw !== "object") continue;
        const status = PROOF_STATUSES.find(item => item === raw.status);
        if (!status || typeof raw.id !== "string") continue;
        items.push({
          id: shortText(raw.id, 20),
          type: raw.type === "structure" ? "structure" : "fact",
          status,
          note: shortText(raw.note, 300),
          sources: Array.isArray(raw.sources)
            ? raw.sources
                .filter((src): src is string => typeof src === "string")
                .slice(0, 10)
                .map(src => shortText(src, 300))
            : []
        });
      }
      const counts = result.counts;
      found = {
        aggregate: result.aggregate === "checked" ? "checked" : "needs-review",
        factsUnverified: result.factsUnverified === true,
        ...(typeof data.failed === "string" ? { failed: shortText(data.failed, 40) } : {}),
        ...(counts && typeof counts === "object"
          ? { counts: { openedPages: count(counts.openedPages), searches: count(counts.searches) } }
          : {}),
        items
      };
    } catch {
      // a damaged record is just not shown
    }
  }
  return found;
}

/** The Detail without its Research notes section: the chapter text a proof is judged and keyed on (the records it adds do not change it). */
export function withoutResearchNotes(detail: string): string {
  const lines = detail.split("\n");
  const section = findSection(lines, fencedLines(lines), text => isResearchNotesHeading(text));
  if (!section) return detail.replace(/\s+$/, "");
  return [...lines.slice(0, section.at), ...lines.slice(section.end)].join("\n").replace(/\s+$/, "");
}

/**
 * Replaces the body of the root note's `## 全書企劃` section with `markdown` (or adds the section at the end); every other
 * section, the frontmatter and the text around it stay byte for byte. `markdown` is the body only: its `#`/`##` heading lines
 * are demoted so it can never open or close a section.
 */
export function replaceBookPlanSection(content: string, markdown: string): string {
  const body = demoteHeadings(markdown.replace(/\r\n?/g, "\n")).trim();
  const lines = content.split("\n");
  const fenced = fencedLines(lines);
  // The frontmatter block is not a place for a section heading.
  if (lines[0]?.trim() === "---") {
    for (let i = 1; i < lines.length; i++) {
      for (let k = 0; k <= i; k++) fenced[k] = true;
      if (lines[i].trim() === "---") break;
    }
  }
  const section = findSection(lines, fenced, (text, level) => level === 2 && text === BOOK_PLAN_HEADING);
  const entry = `## ${BOOK_PLAN_HEADING}\n\n${body}`;
  if (!section) {
    const base = content.replace(/\s+$/, "");
    return `${base ? `${base}\n\n` : ""}${entry}\n`;
  }
  const before = lines.slice(0, section.at).join("\n");
  const after = lines.slice(section.end).join("\n");
  return `${before ? `${before}\n` : ""}${entry}${after ? `\n\n${after}` : "\n"}`;
}

const isUpdateLogHeading = (text: string): boolean =>
  [SECTION_NAME.log.zh, SECTION_NAME.log.en].some(name => name.toLowerCase() === text.trim().toLowerCase());
/** The "### 圖像" section the system writes after the picture search (its captions are not chapter facts). */
export const IMAGES_HEADING = { zh: "圖像", en: "Images" };
const isImagesHeading = (text: string): boolean =>
  [IMAGES_HEADING.zh, IMAGES_HEADING.en, "图像"].some(name => name.toLowerCase() === text.trim().toLowerCase());
const isSystemSection = (text: string): boolean =>
  isResearchNotesHeading(text) || isUpdateLogHeading(text) || isNewSourcesHeading(text) || isOpenQuestionsHeading(text);

/**
 * The first "### 圖像" section in the exact form the system writes (level 3; its body is only pairs of an `![..](https://..)` line and one
 * plain caption line, blank lines between). A same-named heading with anything else under it is the author's text and is not found.
 */
function findImageSection(lines: string[]): { at: number; end: number } | undefined {
  const fenced = fencedLines(lines);
  for (let from = 0; ;) {
    const s = findSection(lines, fenced, (text, level) => level === 3 && isImagesHeading(text), from);
    if (!s) return undefined;
    const body = lines
      .slice(s.at + 1, s.end)
      .map(l => l.replace(/\r$/, ""))
      .filter(l => l.trim());
    const ok =
      body.length > 0 &&
      body.length % 2 === 0 &&
      body.every((l, i) =>
        i % 2 === 0 ? /^!\[[^\]]*\]\(https:\/\/\S+\)$/.test(l) : !/!\[|^\s*(#|[-*+>]|\d+[.)])|<!--/.test(l)
      );
    if (ok) return s;
    from = s.at + 1;
  }
}

/** Where a picture block goes in a Detail: between the chapter text and its first Sources section (else the first Open questions, Research notes or Update log section, else the end). */
function withImageBlock(lines: string[], block: string): string {
  const fenced = fencedLines(lines);
  const sources = findSection(lines, fenced, text => isNewSourcesHeading(text));
  const other = findSection(
    lines,
    fenced,
    text => isOpenQuestionsHeading(text) || isResearchNotesHeading(text) || isUpdateLogHeading(text)
  );
  const at = Math.min(sources?.at ?? lines.length, other?.at ?? lines.length);
  const head = lines.slice(0, at).join("\n").replace(/\s+$/, "");
  const tail = lines.slice(at).join("\n");
  return `${head ? `${head}\n\n` : ""}${block}\n${tail ? `\n${tail}` : ""}`;
}

/**
 * A Detail with its picture section replaced by `section` (the lines after a `### 圖像` / `### Images` heading; null: removed).
 * The section sits between the chapter text and its first Sources section (else the first Open questions, Research notes or
 * Update log section, else the end). Every other line stays as it is.
 */
export function setImageSection(detail: string, section: string | null, language: string): string {
  let lines = detail.split("\n");
  for (;;) {
    const old = findImageSection(lines);
    if (!old) break;
    lines = [...lines.slice(0, old.at), ...lines.slice(old.end)];
  }
  if (section === null) return lines.join("\n");
  const heading = /^zh/i.test(language) ? IMAGES_HEADING.zh : IMAGES_HEADING.en;
  return withImageBlock(lines, `### ${heading}\n\n${section.trim()}`);
}

/**
 * A rewritten Detail that lost the picture section the card had: the old section (heading and lines exactly as they were) is put
 * back where {@link setImageSection} would put it. A rewrite that has a picture section of its own, or an old Detail without one
 * in the system's form, is returned as it is.
 */
export function carryImageSection(oldDetail: string, newDetail: string): string {
  const oldLines = oldDetail.split("\n");
  const old = findImageSection(oldLines);
  if (!old || findImageSection(newDetail.split("\n"))) return newDetail;
  const block = oldLines.slice(old.at, old.end).join("\n").replace(/\s+$/, "");
  return withImageBlock(newDetail.split("\n"), block);
}

/**
 * The chapter text alone: the Detail without the sections the system adds or keeps (Research notes, Update log, Sources, Open questions).
 * The proofread sees and keys on this, so a system line is never taken for the chapter's ending.
 */
export function chapterBody(detail: string): string {
  let lines = detail.split("\n");
  for (;;) {
    const section = findSection(lines, fencedLines(lines), text => isSystemSection(text)) ?? findImageSection(lines);
    if (!section) break;
    lines = [...lines.slice(0, section.at), ...lines.slice(section.end)];
  }
  return lines.join("\n").replace(/\s+$/, "");
}

const REFERENCE_START = "<!-- visual-agent-map:references:start -->";
const DETAIL_START = "<!-- visual-agent-map:detail:start -->";
const DETAIL_END = "<!-- visual-agent-map:detail:end -->";

/** Per line: true where a heading must not be read: the frontmatter, the Detail block and code fences. */
function protectedLines(lines: string[]): boolean[] {
  const flags = fencedLines(lines);
  if (lines[0]?.trim() === "---") {
    for (let i = 1; i < lines.length; i++) {
      for (let k = 0; k <= i; k++) flags[k] = true;
      if (lines[i].trim() === "---") break;
    }
  }
  let inDetail = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === DETAIL_START) inDetail = true;
    if (inDetail) flags[i] = true;
    if (lines[i].trim() === DETAIL_END) inDetail = false;
  }
  return flags;
}

/**
 * The note's `## <proof result heading>` section set to `body` (any language's heading of it is found; the new heading is `heading`);
 * the section is added before the reference-links block, else at the end. The section ends at the next `##` heading, the app's own
 * marker comment or a callout, so what follows it stays. The Detail block, the frontmatter and everything else stay byte for byte.
 */
export function replaceProofSection(content: string, heading: string, body: string): string {
  const lines = content.split("\n");
  const flags = protectedLines(lines);
  const names = new Set(NOTE_LANGUAGES.map(locale => translate(locale, "detail.book_proof_heading").trim()));
  const found = findSection(lines, flags, (text, level) => level === 2 && names.has(text.trim()));
  const entry = `## ${heading}\n\n${body.trim()}`;
  if (found) {
    let end = found.end;
    for (let i = found.at + 1; i < found.end; i++) {
      if (lines[i].trim().startsWith("<!-- visual-agent-map:") || /^>[ \t]?\[!/.test(lines[i])) {
        end = i;
        break;
      }
    }
    const before = lines.slice(0, found.at).join("\n");
    const after = lines.slice(end).join("\n");
    return `${before ? `${before}\n` : ""}${entry}${after ? `\n\n${after}` : "\n"}`;
  }
  const marker = lines.findIndex((line, i) => !flags[i] && line.trim() === REFERENCE_START);
  if (marker >= 0) {
    const before = lines.slice(0, marker).join("\n").replace(/\s+$/, "");
    return `${before ? `${before}\n\n` : ""}${entry}\n\n${lines.slice(marker).join("\n")}`;
  }
  const base = content.replace(/\s+$/, "");
  return `${base ? `${base}\n\n` : ""}${entry}\n`;
}

/** "Nothing new" sentences the app and its prompts write into an empty section, in every language (without the final full stop). */
const PLACEHOLDERS = (): Set<string> =>
  new Set([
    ...NOTE_LANGUAGES.map(locale => translate(locale, "note.no_new_information").replace(/[.。]$/, "")),
    "No new content this time",
    "本次無新增內容"
  ]);

/**
 * A text without its `###`-or-deeper sections that hold nothing but the "no new information" sentence (heading and sentence both
 * go). A section with any other text or a sub-section, a title, the frontmatter and code are never touched.
 */
export function dropPlaceholderSections(content: string): string {
  const placeholders = PLACEHOLDERS();
  let lines = content.split("\n");
  for (let from = 0; ;) {
    const flags = protectedLines(lines);
    const hit = findSection(lines, flags, (_, level) => level >= 3, from);
    if (!hit) break;
    const body = lines
      .slice(hit.at + 1, hit.end)
      .join("\n")
      .trim();
    if (!placeholders.has(body.replace(/[.。]$/, ""))) {
      from = hit.at + 1;
      continue;
    }
    lines = [...lines.slice(0, hit.at), ...lines.slice(hit.end)];
    if (hit.at > 0 && !lines[hit.at - 1]?.trim() && !lines[hit.at]?.trim()) lines.splice(hit.at, 1);
    from = Math.max(0, hit.at - 1);
  }
  return lines.join("\n");
}
