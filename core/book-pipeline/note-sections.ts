/**
 * Pure edits of the note parts the picture-book pipeline owns: the work records of a card's Detail (proof and picture-slot records, the
 * write-back log lines) and the card's proofread result, both kept in hidden `> [!vam-book]-` callouts, and the `## 全書企劃` section of the root note.
 * Older cards keep their `### 研究備註` section (a `[!note]-` callout) and `## 校對結果` section; they are read as before and turned into
 * the hidden callouts the first time the pipeline writes them. Nothing else in the text is touched.
 */
import {
  isNewSourcesHeading,
  isOpenQuestionsHeading,
  isResearchNotesHeading,
  SECTION_NAME
} from "../../ai/section-aliases";
import { NOTE_LANGUAGES, translate } from "../../i18n";
import { demoteHeadings } from "./text";
import { findProofModels, findProofRecord, PROOF_STATUSES, type ProofItemResult, type ProofResult } from "./proof";

export const BOOK_PLAN_HEADING = "全書企劃";
const DEFAULT_RESEARCH_HEADING = "研究備註";
const HEADING = /^[ \t]{0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;
const FENCE = /^[ \t]{0,3}(`{3,}|~{3,})/;
const CALLOUT_HEAD = /^>[ \t]?\[![A-Za-z][\w-]*\][+-]?(?:[ \t].*)?$/;
const RECORD_KEY = /^<!-- book-proof:v1 (\{.*\}) -->$/;
/** The callout type the pipeline writes its work records in: the stylesheet hides it in reading and live preview, source mode still shows it. */
export const HIDDEN_CALLOUT = "vam-book";
const HIDDEN_HEAD = /^[ \t]{0,3}>[ \t]?\[!vam-book\][+-]?(?:[ \t].*)?$/i;
const QUOTE_LINE = /^[ \t]{0,3}>/;
const LOG_LINE = /^(?:[-*+][ \t]+)?\d{4}-\d{2}-\d{2}/;
const ANY_RECORD = /<!-- book-(?:proof|slots):v1 \{.*\} -->/;
const bare = (line: string): string => line.replace(/\r$/, "");

/** Per line: true inside a fenced code block (the fence lines included). */
export function fencedLines(lines: string[]): boolean[] {
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

/** The end (exclusive) of the run of `>` lines that starts at `from`. */
function quoteRunEnd(lines: string[], fenced: boolean[], from: number): number {
  let end = from;
  while (end < lines.length && !fenced[end] && QUOTE_LINE.test(lines[end])) end++;
  return end;
}

/** The hidden callouts of a text (outside code): each from its `> [!vam-book]` line through the `>` lines that follow. */
function hiddenRanges(lines: string[], fenced: boolean[]): { start: number; end: number }[] {
  const found: { start: number; end: number }[] = [];
  for (let i = 0; i < lines.length;) {
    if (!fenced[i] && HIDDEN_HEAD.test(bare(lines[i]))) {
      const end = quoteRunEnd(lines, fenced, i + 1);
      found.push({ start: i, end });
      i = end;
    } else i++;
  }
  return found;
}

/** The hidden callout type as Obsidian may read it: spaces inside the brackets, a `|metadata` tail. */
const HIDDEN_TYPE = /\[!\s*vam-book\s*(?:\|[^\]]*)?\]/gi;

/** Author-controlled text outside the Detail span (the summary, the visual references): the same plain replace over the whole text. */
export const neutralizeText = (text: string): string => text.replace(HIDDEN_TYPE, "[!note]");

/**
 * Everything the author wrote is model text: in the span from the first Detail start marker to the last Detail end marker (a marker the
 * author forges inside the text only widens the span) every `[!vam-book]` (any case, quote depth, indent, inside a fence too) becomes a
 * visible `[!note]` by plain string replace. Outside the span is the card's own text (Preview, Prompt, plan, proof result), kept as it is.
 * A text without both markers returns null (refused: nothing is written). Only the pipeline itself writes a hidden callout, after this.
 */
export function neutralizeDetail(content: string): string | null {
  const start = content.indexOf(DETAIL_START);
  const end = content.lastIndexOf(DETAIL_END);
  if (start < 0 || end < start + DETAIL_START.length) return null;
  const from = start + DETAIL_START.length;
  return `${content.slice(0, from)}${content.slice(from, end).replace(HIDDEN_TYPE, "[!note]")}${content.slice(end)}`;
}

/** A text without its hidden callouts (the pipeline's work records are no chapter text). */
function withoutHiddenCallouts(lines: string[]): string[] {
  const ranges = hiddenRanges(lines, fencedLines(lines));
  if (!ranges.length) return lines;
  return lines.filter((_, i) => !ranges.some(range => i >= range.start && i < range.end));
}

/** Per line: true where the pipeline keeps its work records: the body of an older Research notes section and every hidden callout. */
function recordLines(lines: string[], fenced: boolean[]): boolean[] {
  const mask = lines.map(() => false);
  const section = findSection(lines, fenced, text => isResearchNotesHeading(text));
  if (section) for (let i = section.at + 1; i < section.end; i++) mask[i] = true;
  for (const range of hiddenRanges(lines, fenced)) for (let i = range.start; i < range.end; i++) mask[i] = true;
  return mask;
}

export const quoteAll = (text: string): string =>
  text
    .split(/\r?\n/)
    .map(line => (line.trim() ? `> ${line}` : ">"))
    .join("\n");

/**
 * `quoted` (lines that already carry the `> ` prefix) added to the last hidden callout of a text, at its end (or right after its title line
 * when `atTop`); no hidden callout yet: a new one at the end of the text, a blank line before it.
 */
function appendHidden(text: string, quoted: string, atTop = false): string {
  const lines = text.split("\n");
  const last = hiddenRanges(lines, fencedLines(lines)).pop();
  if (!last) {
    const base = text.replace(/\s+$/, "");
    return `${base ? `${base}\n\n` : ""}> [!${HIDDEN_CALLOUT}]- ${DEFAULT_RESEARCH_HEADING}\n${quoted}\n`;
  }
  const titleOnly = last.end === last.start + 1;
  if (atTop) lines.splice(last.start + 1, 0, ...quoted.split("\n"));
  else {
    const blankTail = !titleOnly && /^>[ \t]*\r?$/.test(lines[last.end - 1]);
    lines.splice(last.end, 0, ...`${titleOnly || blankTail ? "" : ">\n"}${quoted}`.split("\n"));
  }
  return lines.join("\n");
}

/** `lines` with [at, end) replaced by `middle`: one blank line between the parts that are not empty, the text's final newline kept. */
function spliceBlock(lines: string[], at: number, end: number, middle: string[]): string[] {
  const before = lines.slice(0, at);
  while (before.length && !before[before.length - 1].trim()) before.pop();
  const rest = lines.slice(end);
  const newline = rest.length > 0 && rest[rest.length - 1] === "";
  while (rest.length && !rest[0].trim()) rest.shift();
  while (rest.length && !rest[rest.length - 1].trim()) rest.pop();
  const parts = [before, middle, rest].filter(part => part.length);
  const out = parts.flatMap((part, i) => (i ? ["", ...part] : part));
  return newline || !rest.length ? [...out, ""] : out;
}

/** The callouts in lines [from, to) outside code: each starts at a callout title line and runs through the `>` lines after it. */
function calloutBlocks(lines: string[], fenced: boolean[], from: number, to: number): { start: number; end: number }[] {
  const found: { start: number; end: number }[] = [];
  for (let i = from; i < to;) {
    if (!fenced[i] && CALLOUT_HEAD.test(bare(lines[i]))) {
      const end = Math.min(quoteRunEnd(lines, fenced, i + 1), to);
      found.push({ start: i, end });
      i = end;
    } else i++;
  }
  return found;
}

const asHidden = (head: string): string => head.replace(/^(>[ \t]?)\[![A-Za-z][\w-]*\]/, `$1[!${HIDDEN_CALLOUT}]`);

/**
 * An older Research notes section (a `### 研究備註` heading over a `[!note]-` callout) turned into the hidden callout: a callout of the
 * pipeline (titled as the section, or holding one of its records) gets the hidden type; when nothing else is in the section its heading
 * goes too, else the section's other text and heading stay. Text without such a section is returned as it is.
 */
function hideResearchSection(text: string): string {
  let lines = text.split("\n");
  for (let from = 0; ;) {
    const fenced = fencedLines(lines);
    const section = findSection(lines, fenced, name => isResearchNotesHeading(name), from);
    if (!section) return lines.join("\n");
    const blocks = calloutBlocks(lines, fenced, section.at + 1, section.end);
    const name = section.text.trim().toLowerCase();
    const mine = blocks.filter(
      block =>
        /^>[ \t]?\[![A-Za-z][\w-]*\][+-]?[ \t]*(.*?)[ \t]*$/.exec(bare(lines[block.start]))?.[1].toLowerCase() ===
          name || lines.slice(block.start, block.end).some(line => ANY_RECORD.test(line))
    );
    if (!mine.length) {
      from = section.at + 1;
      continue;
    }
    for (const block of mine) lines[block.start] = asHidden(lines[block.start]);
    const covered = new Set(
      blocks.flatMap(block => lines.slice(block.start, block.end).map((_, k) => block.start + k))
    );
    const others = lines
      .slice(section.at + 1, section.end)
      .some((line, k) => line.trim() && !covered.has(section.at + 1 + k));
    if (mine.length < blocks.length || others) {
      from = section.at + 1;
      continue;
    }
    const body = lines.slice(section.at + 1, section.end);
    while (body.length && !body[0].trim()) body.shift();
    while (body.length && !body[body.length - 1].trim()) body.pop();
    lines = spliceBlock(lines, section.at, section.end, body);
    from = section.at;
  }
}

const updateLogNames = (): Set<string> =>
  new Set(
    [
      SECTION_NAME.log.zh,
      SECTION_NAME.log.en,
      ...NOTE_LANGUAGES.map(locale => translate(locale, "detail.update_log"))
    ].map(name => name.trim().toLowerCase())
  );

/**
 * The write-back's own "update log" section (a `###` heading over nothing but dated log lines) moved into the hidden callout as its
 * lines; a section with any other text is the author's and stays.
 */
function hideUpdateLog(text: string, own?: (line: string) => boolean): string {
  const names = updateLogNames();
  let lines = text.split("\n");
  const moved: string[] = [];
  for (let from = 0; ;) {
    const section = findSection(
      lines,
      fencedLines(lines),
      (name, level) => level >= 3 && names.has(name.trim().toLowerCase()),
      from
    );
    if (!section) break;
    const body = lines
      .slice(section.at + 1, section.end)
      .map(bare)
      .filter(line => line.trim());
    if (!body.length || (!own && !body.every(line => LOG_LINE.test(line)))) {
      from = section.at + 1;
      continue;
    }
    if (own) {
      // Only lines the pipeline wrote (the card's earlier lines, this write's own line) move; any other line stays visible in its section.
      const mine = body.filter(line => own(line.trim()));
      if (!mine.length) {
        from = section.at + 1;
        continue;
      }
      moved.push(...mine);
      const rest = lines.slice(section.at + 1, section.end).filter(line => line.trim() && !own(bare(line).trim()));
      lines = spliceBlock(lines, section.at, section.end, rest.length ? [lines[section.at], "", ...rest] : []);
      from = section.at + 1;
      continue;
    }
    moved.push(...body);
    lines = spliceBlock(lines, section.at, section.end, []);
    from = section.at;
  }
  if (!moved.length) return text;
  return appendHidden(lines.join("\n"), moved.map(line => `> ${line}`).join("\n"));
}

/** The pipeline's work records of a Detail in the hidden callout: an older Research notes section or write-back log section is turned into it; the same text again changes nothing. */
export function normalizeWorkRecords(detail: string): string {
  return hideUpdateLog(hideResearchSection(detail));
}

/**
 * A write-back result (the author's text plus the write-back's own log section) with the pipeline's own log lines moved into the hidden
 * callout: a line is the pipeline's when it is one of `known` (the card's earlier log lines) or the write-back's "replaced with new
 * research, backup at <path>.md" line. A log line the author wrote, and every other section the author wrote, stays visible.
 */
export function hidePipelineLog(detail: string, known: ReadonlySet<string>, backupPath?: string): string {
  const marker = "\u0000";
  const shapes = NOTE_LANGUAGES.map(locale =>
    translate(locale, "note.writeback_fresh_replaced_0", marker).split(marker)
  ).filter(parts => parts.length === 2);
  const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Only the exact line the write-back made for this write (this backup path); a log line the author wrote stays visible.
  const ownLine = backupPath
    ? shapes.map(
        ([head, tail]) =>
          new RegExp(`^(?:[-*+][ \\t]+)?\\d{4}-\\d{2}-\\d{2}\u3000${escape(head)}${escape(backupPath)}${escape(tail)}$`)
      )
    : [];
  return hideUpdateLog(detail, line => known.has(line) || ownLine.some(re => re.test(line)));
}

/** The dated log lines the write-back keeps in the work records (plain text, the `> ` prefix removed). */
export function workLogLines(detail: string): string[] {
  const lines = detail.split("\n");
  const fenced = fencedLines(lines);
  const mask = recordLines(lines, fenced);
  return lines.map((line, i) => (mask[i] ? unquoted(bare(line)).trim() : "")).filter(line => LOG_LINE.test(line));
}

/** A rewritten Detail that lost the earlier log lines of the card (the write-back reads only a section it can see by heading): they are put back first in the hidden callout. */
export function carryWorkLog(oldDetail: string, newDetail: string): string {
  const have = new Set(workLogLines(newDetail));
  const add = workLogLines(oldDetail).filter(line => !have.has(line));
  return add.length ? appendHidden(newDetail, add.map(line => `> ${line}`).join("\n"), true) : newDetail;
}

/**
 * Appends one composed proof record (`composeProofRecord`) to the hidden callout of a Detail (every line a `> ` quote line; no callout yet:
 * a new `> [!vam-book]- 研究備註` at the end, after a blank line). An older Research notes section is turned into the hidden callout first.
 * The same record key already stored (read with the `> ` prefix removed) leaves the text exactly as it is. A record carries
 * no raw model text (composeProofRecord escapes it), and every line gets the quote prefix, so no heading, image, link, `%%`,
 * HTML or fence can form.
 */
export function appendResearchNote(detail: string, record: string): { text: string; appended: boolean } {
  const key = recordKey(record);
  if (key && findProofRecord(unquoted(detail), key)) return { text: detail, appended: false };
  return { text: appendHidden(detail, quoteAll(record)), appended: true };
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
 * Puts `record` (a composed `book-proof:v1` or `book-slots:v1` record) into the hidden callout as the only record of its
 * kind: every earlier record of that kind (its readable lines, its machine line and the blank quote line before it) is taken out
 * first. Only the pipeline's own valid records go; any other text of the work records (the author's research, the owner's notes, other
 * callouts), a damaged record and anything inside a code block stay as they are. No work records yet: they are added, as
 * {@link appendResearchNote} does.
 */
export function replaceResearchRecord(detail: string, record: string): string {
  const tag = (record
    .split(/\r?\n/)
    .map(line => PIPELINE_RECORD.exec(line.trim()))
    .find(Boolean) ?? [])[1];
  const base = detail;
  const lines = base.split("\n");
  const mask = recordLines(lines, fencedLines(lines));
  if (!tag || !mask.some(Boolean)) return appendResearchNote(base, record).text;
  const plain = lines.map((line, i) => (mask[i] ? unquoted(line).replace(/\r$/, "") : ""));
  const fenced = fencedLines(plain);
  const drop = new Set<number>();
  for (let k = 0; k < plain.length; k++) {
    const m = !mask[k] || fenced[k] ? null : PIPELINE_RECORD.exec(plain[k].trim());
    if (!m || m[1] !== tag || !validJson(m[2])) continue;
    drop.add(k);
    let j = k - 1;
    if (tag === "book-proof") {
      while (j >= 0 && mask[j] && !fenced[j] && !drop.has(j) && PROOF_ITEM_LINE.test(plain[j])) drop.add(j--);
      if (j >= 0 && mask[j] && !fenced[j] && !drop.has(j) && PROOF_HEADER.test(plain[j].trim())) drop.add(j--);
    }
    if (j >= 0 && mask[j] && !drop.has(j) && QUOTE_BLANK.test(lines[j])) drop.add(j);
  }
  return appendResearchNote(lines.filter((_, i) => !drop.has(i)).join("\n"), record).text;
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
  const mask = recordLines(lines, fencedLines(lines));
  const records: string[] = [];
  const plain = lines.map((line, i) => (mask[i] ? unquoted(line).replace(/\r$/, "") : ""));
  for (let k = 0; k < plain.length; k++) {
    if (!mask[k] || !RECORD_KEY.test(plain[k].trim())) continue;
    // Only the record's own lines (the machine line, its item lines and its readable first line: the range `replaceResearchRecord` deletes);
    // the log lines and escaped lines before it are not part of the record.
    const own = [plain[k].trim()];
    let j = k - 1;
    while (j >= 0 && mask[j] && PROOF_ITEM_LINE.test(plain[j])) own.unshift(plain[j--]);
    if (j >= 0 && mask[j] && PROOF_HEADER.test(plain[j].trim())) own.unshift(plain[j].trim());
    records.push(own.join("\n"));
  }
  return records;
}

/** The stored proof result for `key` in a Detail's Research notes (read through the `> ` quote prefix), or undefined. */
export function findStoredProof(detail: string, key: string): ReturnType<typeof findProofRecord> {
  return findProofRecord(unquoted(detail), key);
}

/** The model ids kept in the stored record for `key` (empty fields: a record from before they were kept), or undefined when there is no such record. */
export function findStoredProofModels(detail: string, key: string): ReturnType<typeof findProofModels> {
  return findProofModels(unquoted(detail), key);
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
  const mask = recordLines(lines, fencedLines(lines));
  let found: StoredProofView | undefined;
  for (const [at, line] of lines.entries()) {
    if (!mask[at]) continue;
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

/** The Detail without its work records (the hidden callouts, an older Research notes section): the chapter text a proof is judged and keyed on (the records it adds do not change it). */
export function withoutResearchNotes(detail: string): string {
  const lines = withoutHiddenCallouts(detail.split("\n"));
  const section = findSection(lines, fencedLines(lines), text => isResearchNotesHeading(text));
  if (!section) return lines.join("\n").replace(/\s+$/, "");
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
    // A hidden work-record callout after the pictures is no part of the section.
    const hidden = hiddenRanges(lines, fenced).find(range => range.start > s.at && range.start < s.end);
    if (hidden) s.end = hidden.start;
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
  const hidden = hiddenRanges(lines, fenced)[0];
  const at = Math.min(sources?.at ?? lines.length, other?.at ?? lines.length, hidden?.start ?? lines.length);
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
 * The chapter text alone: the Detail without the hidden callouts and the sections the system adds or keeps (Research notes, Update log, Sources, Open questions).
 * The proofread sees and keys on this, so a system line is never taken for the chapter's ending.
 */
export function chapterBody(detail: string): string {
  let lines = withoutHiddenCallouts(detail.split("\n"));
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

/** The Detail block of a whole note (between the managed markers); undefined when the note has none. */
export function detailBlockOf(content: string): string | undefined {
  const start = content.indexOf(DETAIL_START);
  const end = content.indexOf(DETAIL_END, start + 1);
  return start < 0 || end < 0 ? undefined : content.slice(start + DETAIL_START.length, end);
}

/** Per line: true where a heading must not be read: the frontmatter, the Detail block (unless `withDetail` is false) and code fences. */
function protectedLines(lines: string[], withDetail = true): boolean[] {
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
    if (inDetail && withDetail) flags[i] = true;
    if (lines[i].trim() === DETAIL_END) inDetail = false;
  }
  return flags;
}

/**
 * The note's proofread result set to `body` as a hidden callout `> [!vam-book]- <heading>` (any language's heading of it is found; the new
 * title is `heading`): an existing hidden proof callout is replaced in place; an older `## <heading>` section is replaced by the callout (it is the
 * heading and the `- ` lines right after it, so any other text that follows it stays); else the callout is added before the reference-links block,
 * else at the end. A blank line stands before and after it. The Detail block, the frontmatter and everything else stay byte for byte.
 */
export function replaceProofSection(content: string, heading: string, body: string): string {
  const lines = content.split("\n");
  const flags = protectedLines(lines);
  const names = new Set(NOTE_LANGUAGES.map(locale => translate(locale, "detail.book_proof_heading").trim()));
  const entry = `> [!${HIDDEN_CALLOUT}]- ${heading}\n${quoteAll(body.trim())}`;
  const join = (before: string, after: string): string => {
    const lead = before && !before.endsWith("\n") ? `${before}\n\n` : before ? `${before}\n` : "";
    return `${lead}${entry}${after ? `\n\n${after}` : "\n"}`;
  };
  const callout = hiddenRanges(lines, flags).find(range => {
    const title = /^>[ \t]?\[![^\]]+\][+-]?[ \t]*(.*?)[ \t]*$/.exec(bare(lines[range.start]))?.[1] ?? "";
    return names.has(title);
  });
  if (callout)
    return join(lines.slice(0, callout.start).join("\n"), lines.slice(callout.end).join("\n").replace(/^\s+/, ""));
  const found = findSection(lines, flags, (text, level) => level === 2 && names.has(text.trim()));
  if (found) {
    // The old section is what this function wrote: its heading and the `- ` list lines right after it. Any other text (the owner's, another heading, a marker, a callout) ends it and stays.
    // At most one blank line after the heading, then the consecutive `- ` lines; anything after a later blank line (even a `- ` list) is the owner's and stays.
    let end = found.at + 1;
    if (end < found.end && !lines[end].trim()) end++;
    while (end < found.end && /^- /.test(lines[end])) end++;
    while (end > found.at + 1 && !lines[end - 1].trim()) end--;
    return join(lines.slice(0, found.at).join("\n"), lines.slice(end).join("\n").replace(/^\s+/, ""));
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
    // The Detail block is where these sections live, so only the frontmatter and code are protected here.
    const flags = protectedLines(lines, false);
    const hit = findSection(lines, flags, (_, level) => level >= 3, from);
    if (!hit) break;
    // The section ends at the app's own marker comment (the Detail block's end), which is never part of it.
    let end = hit.end;
    for (let i = hit.at + 1; i < hit.end; i++)
      if (lines[i].trim().startsWith("<!-- visual-agent-map:")) {
        end = i;
        break;
      }
    const body = lines
      .slice(hit.at + 1, end)
      .join("\n")
      .trim();
    if (!placeholders.has(body.replace(/[.。]$/, ""))) {
      from = hit.at + 1;
      continue;
    }
    lines = [...lines.slice(0, hit.at), ...lines.slice(end)];
    if (hit.at > 0 && !lines[hit.at - 1]?.trim() && !lines[hit.at]?.trim()) lines.splice(hit.at, 1);
    from = Math.max(0, hit.at - 1);
  }
  return lines.join("\n");
}
