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

// A number after a source keyword is a pointer only when what follows shows it: the end of the line, punctuation (also
// full-width), a closing bracket, or one of these verbs. Anything else (a unit, a noun, a glued character) makes it a
// quantity. 1-2 digits only: "來源 300" is a count.
// Verbs that cannot start a noun ("來源 3 指出成長" is a pointer) and verbs that can ("顯示器", "表示法", "說明書", "稱號").
const SOURCE_REF_VERB_ZH = ["指出", "提到", "表明", "認為", "认为", "指稱"];
const SOURCE_REF_VERB_ZH_NOUN = ["顯示", "显示", "表示", "說明", "说明", "稱", "称"];
const SOURCE_REF_VERB_EN = ["says?", "said", "states?", "shows?", "indicates?", "suggests?"];
// The loose (new draft) side also keeps these, which can be nouns; the strict (older draft) side drops them.
const SOURCE_REF_VERB_EN_LOOSE = ["reports?", "notes?", "mentions?", "claims?"];
const SOURCE_REF_KEYWORD = [
  ["來源", "来源"],
  ["出處", "出处"]
]
  .map(group => group.join("|"))
  .join("|");
const SOURCE_REF_JOINER = ["及", "和"].join("|");
function sourceRefPattern(strict: boolean): RegExp {
  const zh = SOURCE_REF_VERB_ZH.join("|");
  const zhNoun = SOURCE_REF_VERB_ZH_NOUN.join("|");
  const en = [...SOURCE_REF_VERB_EN, ...(strict ? [] : SOURCE_REF_VERB_EN_LOOSE)].map(verb => `${verb}\\b`).join("|");
  // On the strict side a verb that can start a noun may not run into another Han character ("來源 12 表示法" is a quantity).
  const verbs = strict ? `${zh}|(?:${zhNoun})(?!\\p{Script=Han})|${en}` : `${zh}|${zhNoun}|${en}`;
  return new RegExp(
    `(${SOURCE_REF_KEYWORD}|(?<![A-Za-z])(?:sources?|references?))[ \\t]*(\\d{1,2}` +
      `(?:[ \\t]*(?:[,，、]|${SOURCE_REF_JOINER}|and|&)[ \\t]*\\d{1,2})*)` +
      `(?!\\d|\\.\\d)(?=[ \\t]*(?:$|[。，、；：！？.,;:!?)）\\]】」』”’…]|${verbs}))` +
      `(?![ \\t]*[,，、][ \\t]*\\d)`,
    "gium"
  );
}
const SOURCE_REF_STRICT = sourceRefPattern(true);
// What may stand just before the keyword: a lead-in word (see, per, 見 ...) or nothing. A modifier ("資料來源", "open
// source", "Data sources") makes the number a count of something.
const SOURCE_LEAD_HAN = /[見见據据依參参如另自從从於于與与及和或至]$/;
const SOURCE_LEAD_EN = /^(?:see|cf|per|from|in|and|to|by|also)$/i;
// Words that end in a lead-in character but are not lead-ins ("參與來源 3": take part in, not "參 + 與").
const SOURCE_LEAD_NOT = /(?:參與|参与|關於|关于|屬於|属于|給與|给与)$/;
const SOURCE_SECTION_FIXED = new Set(
  ["來源", "来源", "出處", "出处", "參考資料", "参考资料", "Sources", "References"].map(name =>
    name.toLocaleLowerCase()
  )
);

function leadsKeyword(before: string): boolean {
  const head = before.replace(/[ \t]+$/, "");
  if (/\p{Script=Han}$/u.test(head)) return SOURCE_LEAD_HAN.test(head) && !SOURCE_LEAD_NOT.test(head);
  const word = /([A-Za-z]+)$/.exec(head);
  return word ? SOURCE_LEAD_EN.test(word[1]) : true;
}

/** How many items the sources section of an older draft lists (ordered, unordered or footnote definitions); 0 without one. */
function sourceCount(text: string, extraNames: string[]): number {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const code = fencedLines(lines);
  const names = new Set(extraNames.map(key));
  let level = 0;
  let count = 0;
  lines.forEach((line, index) => {
    if (code[index]) return;
    const heading = HEADING_ANY.exec(line);
    if (heading) {
      // Any heading ends the sources section (a sub-heading too); only the template's names and a fixed list start one.
      const name = key(heading[2]);
      level = names.has(name) || SOURCE_SECTION_FIXED.has(name) ? heading[1].length : 0;
      return;
    }
    // Only the items at indent 0: the sub-items of a source are not sources.
    if (level && /^(?:(?:[-*+]|\d+[.)])[ \t]+|\[\^[^\]\s]+\]:)/.test(line)) count++;
  });
  return count;
}

/**
 * Both drafts and the summary are read the same strict way: a number is a pointer only when it is not more than the items of its sources section
 * (none: never), no modifier stands before the keyword, and the character after it fits the whitelist.
 */
function withoutOldSourceRefs(text: string, max: number): string {
  if (!max) return text;
  return text.replace(
    SOURCE_REF_STRICT,
    (match: string, _keyword: string, nums: string, offset: number, whole: string) => {
      if (!leadsKeyword(whole.slice(0, offset))) return match;
      return (nums.match(/\d+/g) ?? []).every(value => Number(value) >= 1 && Number(value) <= max) ? "" : match;
    }
  );
}

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
  const sourceNames = template.sections
    .filter(section => section.role === "sources")
    .flatMap(section => [section.name, ...section.aliases]);
  const sourceMax = sourceCount(oldDetail, sourceNames);
  const logHeadings = template.sections
    .filter(section => section.role === "log")
    .flatMap(section => [section.name, ...section.aliases]);
  const newMax = Math.max(sourceCount(input.newDetail, sourceNames), sourceMax);
  // `added` is what this function put back: it is read as it stands.
  const check = (detail: string, added = "") =>
    checkMergePreservation({
      sourceTexts: [withoutOldSourceRefs(oldDetail, sourceMax)],
      mergedTexts: [withoutOldSourceRefs(detail, newMax), withoutOldSourceRefs(input.summary, newMax), added],
      mergedLinkTexts: [input.references],
      logHeadings
    });
  const before = check(input.newDetail).missing;
  if (!before.length) return { detail: input.newDetail, restored: 0 };
  let detail = input.newDetail;
  if (template.sections.some(section => section.role === "sources"))
    detail = carryForwardSources(detail, [oldDetail], [input.summary, detail, input.references], language, template);
  const missing = new Set(check(detail).missing);
  if (missing.size) detail = quoteMissingLines(oldDetail, detail, missing, template, language, logHeadings, sourceMax);
  const added = addedLines(input.newDetail, detail);
  const rest = check(detail, added.join("\n")).missing.length;
  return { detail, restored: Math.max(0, before.length - rest) };
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
  sourceMax: number
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
    if (!text) return;
    const own = checkMergePreservation({
      sourceTexts: [withoutOldSourceRefs(text, sourceMax)],
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
