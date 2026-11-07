import { sectionLookup, type DetailTemplate } from "../../../ai/detail-templates";
import { fencedLines } from "../../../ai/markdown-blocks";
import { translateNote, type ContentLanguage } from "../../../i18n";
import { noteNumbers } from "../chart/insert";
import { carryForwardSources } from "./carry-sources";

/**
 * Deterministic preservation check of an AI merge. The merge prompt says to keep every number, link and embed and to
 * add no conclusion; this checks the part of that which a program can: the numbers, URLs, [[wikilinks]] and image or
 * link targets of the sources are all in the merged text, and the merged text has no number that no source has.
 * "No new conclusions" in words stays a prompt rule.
 */
export interface MergeCheckInput {
  /** Summary, Detail and older findings of each source: checked for numbers and links. */
  sourceTexts: string[];
  /** Further source text that only carries links (visual references). */
  sourceLinkTexts?: string[];
  /** Merged summary and Detail: checked for numbers and links. */
  mergedTexts: string[];
  /** Further merged text that only carries links (the reference list the model returned). */
  mergedLinkTexts?: string[];
  /** Text whose numbers a merge may legitimately repeat (the source note paths). */
  allowedTexts?: string[];
  /** Names and aliases of the template's log section, besides the built-in 更新紀錄 / Update log. */
  logHeadings?: string[];
}

export interface MergeCheckResult {
  /** True when nothing is missing and nothing was added. */
  ok: boolean;
  /** Source numbers, URLs, wikilinks and link targets the merged text lacks. */
  missing: string[];
  /** Numbers in the merged text that no source has. */
  added: string[];
}

const UPDATE_LOG_HEADING = /^(#{1,6})[ \t]+.*(?:更新紀錄|更新记录|Update log)/i;
const HEADING = /^(#{1,6})[ \t]+\S/;

/** A section called Update log holds dated entries of its own; the merge replaces it with one new line. */
function withoutUpdateLog(text: string, logHeadings: string[]): string {
  const names = new Set(logHeadings.map(name => name.trim().toLocaleLowerCase()).filter(Boolean));
  const isLog = (line: string): RegExpExecArray | null => {
    const match = UPDATE_LOG_HEADING.exec(line);
    if (match) return match;
    const heading = /^(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/.exec(line);
    return heading && names.has(heading[2].trim().toLocaleLowerCase()) ? heading : null;
  };
  const lines = text.replace(/\r\n/g, "\n").split("\n"),
    kept: string[] = [];
  let skipping = 0;
  for (const line of lines) {
    const heading = HEADING.exec(line);
    if (skipping && heading && heading[1].length <= skipping) skipping = 0;
    if (!skipping) {
      const log = isLog(line);
      if (log) {
        skipping = log[1].length;
        continue;
      }
      kept.push(line);
    }
  }
  return kept.join("\n");
}

/** Numbering that markdown adds ("1." list items, "### 2. Title") is layout, not a quantity. */
function withoutListMarkers(text: string): string {
  return text.replace(/^([ \t]*(?:>[ \t]*)*(?:#{1,6}[ \t]+)?(?:[-*+][ \t]+)?)\d+[.)、．][ \t]+/gm, "$1");
}

/** The comparable form of a number: 2.0 and 2 are the same quantity; very long digit strings stay as written. */
function normalNumber(token: string): string {
  const value = Number(token);
  return Number.isFinite(value) && token.length < 16 ? String(value) : token;
}

function numbersOf(texts: string[], logHeadings: string[]): Set<string> {
  const out = new Set<string>();
  for (const text of texts) {
    const body = withoutListMarkers(withoutUpdateLog(text, logHeadings)).replace(/!?\[\[[^\]]*\]\]/g, "");
    for (const token of noteNumbers(body)) out.add(normalNumber(token));
  }
  return out;
}

function decoded(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** URLs, wikilink targets (alias and heading dropped) and local link or image targets, in a comparable form. */
export function linksOf(texts: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const add = (kind: string, raw: string): void => {
    const shown = raw.trim().replace(/[.,;:!?*_'"]+$/, "");
    const key = decoded(shown).toLowerCase().replace(/\/+$/, "").replace(/\.md$/, "");
    if (key) out.set(`${kind}${key}`, shown);
  };
  for (const text of texts) {
    for (const match of text.matchAll(/https?:\/\/[^\s<>"'`)\]]+/g)) add("", match[0]);
    for (const match of text.matchAll(/!?\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g)) add("wiki:", match[1]);
    for (const match of text.matchAll(/\]\(\s*<?([^)\s>]+)/g)) {
      const target = match[1];
      if (/^(?:https?:|mailto:|#)/i.test(target)) continue;
      add("link:", target);
    }
  }
  return out;
}

export function checkMergePreservation(input: MergeCheckInput): MergeCheckResult {
  const logs = input.logHeadings ?? [];
  const missing: string[] = [],
    added: string[] = [];
  const sourceNumbers = numbersOf(input.sourceTexts, logs),
    mergedNumbers = numbersOf(input.mergedTexts, logs),
    allowed = numbersOf(input.allowedTexts ?? [], logs);
  for (const token of sourceNumbers) if (!mergedNumbers.has(token)) missing.push(token);
  for (const token of mergedNumbers) if (!sourceNumbers.has(token) && !allowed.has(token)) added.push(token);
  const sourceLinks = linksOf([...input.sourceTexts, ...(input.sourceLinkTexts ?? [])]),
    mergedLinks = linksOf([...input.mergedTexts, ...(input.mergedLinkTexts ?? [])]);
  for (const [key, shown] of sourceLinks) if (!mergedLinks.has(key)) missing.push(shown);
  return { ok: !missing.length && !added.length, missing, added };
}

/** The findings as a Markdown list for the repair request (at most `limit` lines); `none` when there are no findings. */
export function findingList(items: string[], none: string, limit = 30): string {
  if (!items.length) return none;
  const lines = items.slice(0, limit).map(item => `- ${item}`);
  if (items.length > limit) lines.push(`- … (+${items.length - limit})`);
  return lines.join("\n");
}

const HEADING_ANY = /^(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;
const KEPT_LOCALES: ContentLanguage[] = ["zh-TW", "zh-CN", "en"];
const key = (value: string): string => value.trim().toLocaleLowerCase();

/**
 * A rewrite of a note keeps its old numbers and links. What the rewrite left out and the older Detail had is put back,
 * with no AI call: the links go to the sources section ({@link carryForwardSources}, only when the template has one, as it
 * adds a section otherwise), and each line of the older Detail that holds a number or link still missing is quoted
 * (`> `) at the end of the section of the same name, under a callout title. A quoted line is not a list item or a `####`
 * heading, so the template's counts do not change. Lines in code, headings and the log section are not taken. A run again
 * on a note that already has the quoted lines takes them once more as one quote, not nested.
 * `restored` is how many missing items the new detail has again.
 */
export function keepDroppedContent(input: {
  oldDetail: string;
  newDetail: string;
  summary: string;
  references: string;
  template: DetailTemplate;
  language: ContentLanguage;
}): { detail: string; restored: number } {
  const { oldDetail, template, language } = input;
  const logHeadings = template.sections
    .filter(section => section.role === "log")
    .flatMap(section => [section.name, ...section.aliases]);
  const check = (detail: string) =>
    checkMergePreservation({
      sourceTexts: [oldDetail],
      mergedTexts: [detail, input.summary],
      mergedLinkTexts: [input.references],
      logHeadings
    });
  const before = check(input.newDetail).missing;
  if (!before.length) return { detail: input.newDetail, restored: 0 };
  let detail = input.newDetail;
  if (template.sections.some(section => section.role === "sources"))
    detail = carryForwardSources(detail, [oldDetail], [input.summary, detail, input.references], language, template);
  const missing = new Set(check(detail).missing);
  if (missing.size) detail = quoteMissingLines(oldDetail, detail, missing, template, language, logHeadings);
  return { detail, restored: Math.max(0, before.length - check(detail).missing.length) };
}

/** The title lines this feature writes, in every language, so a second run takes the quoted lines and not the title. */
function keptTitles(): Set<string> {
  return new Set(KEPT_LOCALES.map(locale => key(translateNote(locale, "note.kept_from_earlier_version"))));
}

function quoteMissingLines(
  oldDetail: string,
  detail: string,
  missing: Set<string>,
  template: DetailTemplate,
  language: ContentLanguage,
  logHeadings: string[]
): string {
  const lookup = sectionLookup(template);
  const logNames = new Set(logHeadings.map(key).filter(Boolean));
  const titles = keptTitles();
  const oldLines = oldDetail.replace(/\r\n/g, "\n").split("\n");
  const oldCode = fencedLines(oldLines);
  // The lines to take, by the section index of the template they stand in (-1: before any section or in an unknown one).
  const groups = new Map<number, string[]>();
  const covered = new Set<string>();
  let section = -1;
  let logLevel = 0;
  oldLines.forEach((line, index) => {
    if (oldCode[index]) return;
    const heading = HEADING_ANY.exec(line);
    if (heading) {
      const level = heading[1].length;
      if (logLevel && level <= logLevel) logLevel = 0;
      const name = key(heading[2]);
      if (!logLevel && (logNames.has(name) || UPDATE_LOG_HEADING.test(line))) logLevel = level;
      if (level === 3) section = lookup.get(name) ?? -1;
      return;
    }
    if (logLevel) return;
    // A quote this feature wrote earlier is taken as one quote again, without its title.
    const text = line.replace(/^[ \t]*(?:>[ \t]*)+/, "").trim();
    if (!text) return;
    const callout = /^\[![\w-]+\][+-]?[ \t]*(.*)$/.exec(text);
    if (callout && titles.has(key(callout[1]))) return;
    const own = checkMergePreservation({ sourceTexts: [text], mergedTexts: [] }).missing.filter(item =>
      missing.has(item)
    );
    if (!own.some(item => !covered.has(item))) return;
    for (const item of own) covered.add(item);
    const list = groups.get(section) ?? [];
    list.push(text);
    groups.set(section, list);
  });
  let out = detail;
  const title = translateNote(language, "note.kept_from_earlier_version");
  for (const [index, lines] of groups) {
    const block = [`> [!note] ${title}`, ...lines.map(line => `> ${line}`)];
    out = insertIntoSection(out, index, block, template, lookup);
  }
  return out;
}

/** Puts the block at the end of the section with the index (the last section that is not sources or log when there is none). */
function insertIntoSection(
  detail: string,
  index: number,
  block: string[],
  template: DetailTemplate,
  lookup: Map<string, number>
): string {
  const lines = detail.split("\n");
  const code = fencedLines(lines);
  const sections: { at: number; index: number | undefined }[] = [];
  lines.forEach((line, at) => {
    const match = code[at] ? null : /^###[ \t]+(.+?)[ \t]*$/.exec(line);
    if (match) sections.push({ at, index: lookup.get(key(match[1])) });
  });
  const roleOf = (found: number | undefined): string | undefined =>
    found === undefined ? undefined : template.sections[found]?.role;
  let target = sections.findIndex(item => item.index === index && index >= 0);
  if (target < 0) {
    for (let n = sections.length - 1; n >= 0; n--)
      if (roleOf(sections[n].index) !== "sources" && roleOf(sections[n].index) !== "log") {
        target = n;
        break;
      }
  }
  if (target < 0) return `${detail.trimEnd()}\n\n${block.join("\n")}\n`;
  let end = target + 1 < sections.length ? sections[target + 1].at : lines.length;
  while (end > sections[target].at + 1 && !lines[end - 1].trim()) end--;
  return [
    ...lines.slice(0, end),
    "",
    ...block,
    ...(end < lines.length && lines[end].trim() ? [""] : []),
    ...lines.slice(end)
  ].join("\n");
}
