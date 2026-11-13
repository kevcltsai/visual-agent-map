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
  const { template, language } = input;
  // A mermaid fence is a chart: the chart step may draw it again and its numbers are not facts (the merge check ignores them
  // too), so it is neither compared nor put back.
  const oldDetail = withoutMermaid(input.oldDetail);
  const logHeadings = template.sections
    .filter(section => section.role === "log")
    .flatMap(section => [section.name, ...section.aliases]);
  // Decision #16. A line of the older Detail that the new one has word for word is not compared on either side (its numbers
  // are still there; this is also why a second run restores nothing). The new side and the summary lose every source number
  // (it can only hide a number, never add one: more is reported); the older side keeps them all.
  // Order: the log section goes first (it ends at the next heading, so a heading must not be dropped before it is found),
  // then the kept lines, then the comparison. Headings are never kept lines.
  const kept = keptLineSet(withoutUpdateLog(oldDetail, logHeadings), withoutUpdateLog(input.newDetail, logHeadings));
  const oldSide = withoutLines(withoutUpdateLog(oldDetail, logHeadings), kept);
  // `added` is what this function put back: it is read as it stands.
  const check = (detail: string, added = "") =>
    checkMergePreservation({
      sourceTexts: [oldSide],
      mergedTexts: [withoutSourceNumbers(withoutLines(detail, kept, true)), withoutSourceNumbers(input.summary), added],
      mergedLinkTexts: [input.references],
      logHeadings
    });
  const before = check(input.newDetail).missing;
  if (!before.length) return { detail: input.newDetail, restored: 0 };
  let detail = input.newDetail;
  if (template.sections.some(section => section.role === "sources"))
    detail = carryForwardSources(detail, [oldDetail], [input.summary, detail, input.references], language, template);
  const missing = new Set(check(detail).missing);
  if (missing.size) detail = quoteMissingLines(oldDetail, detail, missing, template, language, logHeadings, kept);
  const added = addedLines(input.newDetail, detail);
  const rest = check(detail, added.join("\n")).missing.length;
  return { detail, restored: Math.max(0, before.length - rest) };
}

const SOURCE_NUMBER =
  /(?:來源|来源|出處|出处|(?<![A-Za-z])(?:sources?|references?))[ \t]*\d{1,2}(?:[ \t]*(?:[,，、和及&]|and)[ \t]*\d{1,2})*(?!\d)|\[\^[^\]\s]+\]/gi;

function withoutSourceNumbers(text: string): string {
  return text.replace(SOURCE_NUMBER, "");
}

/** The non-blank lines (trimmed) the older Detail has that the new one has word for word. */
function keptLineSet(oldDetail: string, newDetail: string): Set<string> {
  const now = new Set(
    newDetail
      .split("\n")
      .map(line => line.trim())
      .filter(line => line && !line.startsWith("#"))
  );
  return new Set(
    oldDetail
      .split("\n")
      .map(line => line.trim())
      .filter(line => line && !line.startsWith("#") && now.has(line))
  );
}

/** The text without the kept lines (a closed mermaid fence is left as it is when `keepCharts`). */
function withoutLines(text: string, kept: Set<string>, keepCharts = false): string {
  const lines = text.split("\n");
  const chart = keepCharts ? mermaidLines(lines) : [];
  return lines.filter((line, index) => chart[index] || !kept.has(line.trim())).join("\n");
}

/** The lines of `now` that `base` does not have (by count), in order. */
function addedLines(base: string, now: string): string[] {
  const left = new Map<string, number>();
  for (const line of base.split("\n")) left.set(line, (left.get(line) ?? 0) + 1);
  return now.split("\n").filter(line => {
    const n = left.get(line) ?? 0;
    if (n) left.set(line, n - 1);
    return !n;
  });
}

/** The title lines this feature writes, in every language, so a second run takes the quoted lines and not the title. */
function keptTitles(): Set<string> {
  return new Set(KEPT_LOCALES.map(locale => key(translateNote(locale, "note.kept_from_earlier_version"))));
}

/**
 * The fenced lines of a mermaid fence that is closed, fence lines included. Same reading as `noteNumbers` (info string
 * `mermaid` in lower case); a fence that never closes is not a chart and is left in, so the text after it is still compared.
 */
function mermaidLines(lines: string[]): boolean[] {
  const out = lines.map(() => false);
  let start = -1;
  let fence = "";
  let mermaid = false;
  lines.forEach((line, index) => {
    if (fence) {
      const close = /^\s*(`{3,}|~{3,})\s*$/.exec(line);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) {
        if (mermaid) for (let at = start; at <= index; at++) out[at] = true;
        fence = "";
      }
      return;
    }
    const open = /^\s*(`{3,}|~{3,})\s*(\S*)/.exec(line);
    if (open) {
      fence = open[1];
      start = index;
      mermaid = open[2].startsWith("mermaid");
    }
  });
  return out;
}

function withoutMermaid(text: string): string {
  const lines = text.split("\n");
  const chart = mermaidLines(lines);
  return chart.some(Boolean) ? lines.filter((_, index) => !chart[index]).join("\n") : text;
}

/** A line of code as inline code, with a delimiter longer than any backtick run inside it. */
function inlineCode(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map(run => run.length));
  const fence = "`".repeat(longest + 1);
  return longest ? `${fence} ${text} ${fence}` : `${fence}${text}${fence}`;
}

const FOOTNOTE_DEFINITION = /^[ \t]*(?:>[ \t]*)*\[\^([^\]\s]+)\]:[ \t]*(.*)$/;
const FOOTNOTE_REF = /\[\^([^\]\s]+)\](?!\(|:)/g;

/** The footnote definitions of a text outside code: id to the definition text. */
function footnoteDefinitions(text: string): Map<string, string> {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const code = fencedLines(lines);
  const out = new Map<string, string>();
  lines.forEach((line, index) => {
    const match = code[index] ? null : FOOTNOTE_DEFINITION.exec(line);
    if (match && !out.has(match[1])) out.set(match[1], match[2].trim());
  });
  return out;
}

/**
 * A line put back carries the old note's footnote numbers, which the new note may use for other sources. Each marker is
 * pointed at the new definition with the same source (same URL, else the same text); when the new note has none, the marker
 * is removed and the old definition's URL (or text) is added at the end of the line.
 */
function remapFootnotes(line: string, oldDefinitions: Map<string, string>, detail: string): string {
  if (!/\[\^/.test(line)) return line;
  const fresh = footnoteDefinitions(detail);
  const byKey = new Map<string, string>();
  const byText = new Map<string, string>();
  for (const [id, body] of fresh) {
    for (const link of linksOf([body]).keys()) if (!byKey.has(link)) byKey.set(link, id);
    if (!byText.has(key(body))) byText.set(key(body), id);
  }
  const appended: string[] = [];
  const text = line.replace(FOOTNOTE_REF, (_match, id: string) => {
    const body = oldDefinitions.get(id);
    if (!body) return "";
    const links = linksOf([body]);
    const found =
      [...links.keys()].map(link => byKey.get(link)).find(Boolean) ?? (links.size ? undefined : byText.get(key(body)));
    if (found) return `[^${found}]`;
    const extra = links.size ? [...links.values()].map(url => `<${url}>`) : [body];
    for (const item of extra) if (item && !appended.includes(item)) appended.push(item);
    return "";
  });
  return appended.length ? `${text.trimEnd()} ${appended.join(" ")}` : text;
}

function quoteMissingLines(
  oldDetail: string,
  detail: string,
  missing: Set<string>,
  template: DetailTemplate,
  language: ContentLanguage,
  logHeadings: string[],
  kept: Set<string>
): string {
  const lookup = sectionLookup(template);
  const logNames = new Set(logHeadings.map(key).filter(Boolean));
  const titles = keptTitles();
  const oldLines = oldDetail.replace(/\r\n/g, "\n").split("\n");
  const oldCode = fencedLines(oldLines);
  const oldDefinitions = footnoteDefinitions(oldDetail);
  // The lines to take, by the section index of the template they stand in (-1: before any section or in an unknown one).
  const groups = new Map<number, string[]>();
  const covered = new Set<string>();
  let section = -1;
  let logLevel = 0;
  oldLines.forEach((line, index) => {
    // A line of code is quoted as inline code; a heading as its text (a quote line is not a heading or a code block).
    let text: string;
    if (oldCode[index]) {
      if (logLevel) return;
      text = line.trim() ? inlineCode(line.trim()) : "";
    } else {
      const heading = HEADING_ANY.exec(line);
      if (heading) {
        const level = heading[1].length;
        if (logLevel && level <= logLevel) logLevel = 0;
        const name = key(heading[2]);
        if (!logLevel && (logNames.has(name) || UPDATE_LOG_HEADING.test(line))) logLevel = level;
        if (level === 3) section = lookup.get(name) ?? -1;
        if (logLevel) return;
        text = heading[2].trim();
      } else {
        if (logLevel) return;
        // A quote this feature wrote earlier is taken as one quote again, without its title.
        text = line.replace(/^[ \t]*(?:>[ \t]*)+/, "").trim();
        const callout = /^\[![\w-]+\][+-]?[ \t]*(.*)$/.exec(text);
        if (callout && titles.has(key(callout[1]))) return;
        // A footnote definition is quoted as its source text.
        const definition = FOOTNOTE_DEFINITION.exec(text);
        if (definition) text = definition[2].trim();
      }
    }
    if (!text || kept.has(line.trim())) return;
    const own = checkMergePreservation({
      sourceTexts: [text],
      mergedTexts: []
    }).missing.filter(item => missing.has(item));
    if (!own.some(item => !covered.has(item))) return;
    for (const item of own) covered.add(item);
    const list = groups.get(section) ?? [];
    list.push(remapFootnotes(text, oldDefinitions, detail));
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

/**
 * The block of an AI merge that comes from the map's data sources, added after the merged text by code. The model that wrote the
 * merged text never saw the sources, and this block never changes a line of it: it is a callout of its own (every line quoted, so
 * nothing in it is a heading, a list item or a section of the template), at the end of the last ordinary section.
 * `supplement` "" or undefined adds nothing; null means the request for it failed, and the block says so.
 */
export function withSourceSupplement(
  detail: string,
  supplement: string | null | undefined,
  template: DetailTemplate,
  language: ContentLanguage
): string {
  const lines =
    supplement === null
      ? [translateNote(language, "note.merge_data_sources_failed")]
      : (supplement ?? "")
          .replace(/\r\n/g, "\n")
          .split("\n")
          .map(line => line.replace(/^[ \t]*(?:>[ \t]*)+/, "").trimEnd());
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  if (!lines.length) return detail;
  const block = [`> [!note] ${translateNote(language, "note.merge_data_sources")}`, ...lines.map(line => `> ${line}`)];
  return insertIntoSection(detail, -1, block, template, sectionLookup(template));
}
