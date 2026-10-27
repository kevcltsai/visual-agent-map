/**
 * Phase-1 skeleton filter of the seamless research flow. Pure and deterministic: it removes every sentence that carries a
 * number, date, price, quote, title mark, proper noun (capitalised Latin word), URL, footnote or image, so that content written
 * before any web search states nothing that needs a source. Headings are kept; a section that loses all its text gets a short placeholder.
 */

export interface SkeletonFilterOptions {
  /** Strings that may stay: the topic's own title and any proper noun the owner chose to keep. Removed from a sentence before it is tested. */
  allow?: readonly string[];
  /** Text put under a heading whose body was removed completely. */
  placeholder?: string;
}

export const DEFAULT_SKELETON_PLACEHOLDER = "（這一節等查證後補上。）";

// Chinese numerals: 一 alone is not a number in 一般 / 一些 / 一種; it counts only in 一百, 十二 and before a measure such as 年 or 公斤.
const NUMERAL = "(?:[〇零二兩三四五六七八九十百千萬億]|一(?=[〇零一二兩三四五六七八九十百千萬億]))";
const UNIT = "(?:個|種|次|位|項|條|張|名|人|年|月|日|號|天|週|周|小時|分鐘|秒|度|倍|成|元|塊|公斤|公里|公分|公尺|毫米|公克|克|歲|世紀|季|間|家|筆|件|萬|億)";
const ONE_UNIT = "一(?:年|月|日|天|週|周|小時|分鐘|秒|度|倍|成|元|塊|公斤|公里|公分|公尺|毫米|公克|世紀|百|千|萬|億)";

const PATTERNS: readonly RegExp[] = [
  /[0-9０-９]/u,
  new RegExp(`${NUMERAL}+${UNIT}`, "u"),
  new RegExp(ONE_UNIT, "u"),
  /[$€£¥￥₩]/u,
  /[「」『』“”"＂]/u,
  /[《》〈〉]/u,
  /\b[A-Z][A-Za-z]*/u,
  /\b[a-z]{1,2}[A-Z][a-z]+/u,
  /https?:\/\/|www\./iu,
  /\[\^[^\]]+\]/u,
  /!\[[^\]]*\]\(|!\[\[/u
];

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True when the sentence states something the filter must not let through before a web search. */
export function sentenceHasSourceNeed(sentence: string, allow: readonly string[] = []): boolean {
  let text = sentence;
  for (const word of [...allow].filter(item => item.trim()).sort((a, b) => b.length - a.length)) text = text.replace(new RegExp(escapeRegExp(word.trim()), "gi"), " ");
  return PATTERNS.some(pattern => pattern.test(text));
}

const LINE_PREFIX = /^(\s*(?:>\s*)*(?:[-*+]\s+|\d+[.)]\s+)?(?:\[[ xX]\]\s+)?)/u;
const CALLOUT_MARKER = /^\s*(?:>\s*)+\[![^\]]+\][+-]?.*$/u;
const FENCE = /^\s*(?:>\s*)*(```|~~~)/u;
const HEADING = /^\s{0,3}#{1,6}\s/u;
const COMMENT = /^\s*<!--.*-->\s*$/u;
const FOOTNOTE_DEFINITION = /^\s*\[\^[^\]]+\]:/u;

function splitSentences(text: string): string[] {
  return text.split(/(?<=[。！？；])|(?<=[.!?;])(?=\s)/u).filter(part => part.length > 0);
}

function filterLine(line: string, allow: readonly string[]): string | undefined {
  const prefix = LINE_PREFIX.exec(line)?.[1] ?? "";
  const body = line.slice(prefix.length);
  if (!body.trim()) return line;
  const kept = splitSentences(body).filter(sentence => !sentenceHasSourceNeed(sentence, allow));
  const text = kept.join("").trim();
  return text ? prefix + text : undefined;
}

function filterTable(block: string[], allow: readonly string[]): string[] {
  if (block.length < 2 || sentenceHasSourceNeed(block[0], allow)) return [];
  const rows = block.slice(2).filter(row => !sentenceHasSourceNeed(row, allow));
  return rows.length ? [block[0], block[1], ...rows] : [];
}

/** A callout marker whose body was filtered away is removed together with it. */
function dropOrphanMarkers(lines: readonly string[]): string[] {
  return lines.filter((line, index) => {
    if (!CALLOUT_MARKER.test(line)) return true;
    for (let next = index + 1; next < lines.length && /^\s*>/.test(lines[next]); next++) {
      if (!CALLOUT_MARKER.test(lines[next]) && lines[next].replace(/^[\s>]+/, "")) return true;
    }
    return false;
  });
}

/** The text of a section counts only when it is more than blank lines, callout markers and comments. */
function hasText(lines: readonly string[]): boolean {
  return lines.some(line => line.trim() && !CALLOUT_MARKER.test(line) && !COMMENT.test(line) && !/^\s*(?:>\s*)*$/.test(line));
}

export function skeletonFilter(markdown: string, options: SkeletonFilterOptions = {}): string {
  const allow = options.allow ?? [];
  const placeholder = options.placeholder ?? DEFAULT_SKELETON_PLACEHOLDER;
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  // Sections: each has an optional heading line, its original body lines and its filtered body lines.
  const sections: { heading?: string; original: string[]; kept: string[] }[] = [{ original: [], kept: [] }];
  let fence: string | undefined;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const section = sections[sections.length - 1];
    if (fence) {
      section.original.push(line);
      if (line.trimStart().startsWith(fence)) fence = undefined;
      continue;
    }
    const open = FENCE.exec(line);
    if (open) { fence = open[1]; section.original.push(line); continue; }
    if (HEADING.test(line)) { sections.push({ heading: line, original: [], kept: [] }); continue; }
    section.original.push(line);
    if (FOOTNOTE_DEFINITION.test(line)) continue;
    if (/^\s*\|/.test(line)) {
      const block = [line];
      while (index + 1 < lines.length && /^\s*\|/.test(lines[index + 1])) block.push(lines[++index]);
      section.original.push(...block.slice(1));
      section.kept.push(...filterTable(block, allow));
      continue;
    }
    if (COMMENT.test(line) || CALLOUT_MARKER.test(line)) { section.kept.push(line); continue; }
    const filtered = filterLine(line, allow);
    if (filtered !== undefined) section.kept.push(filtered);
  }
  const out: string[] = [];
  for (const section of sections) {
    if (section.heading !== undefined) out.push(section.heading);
    const cleaned = dropOrphanMarkers(section.kept);
    const kept = hasText(cleaned) ? cleaned : section.kept.filter(line => COMMENT.test(line));
    out.push(...kept);
    if (section.heading !== undefined && hasText(section.original) && !hasText(kept)) out.push("", placeholder);
    out.push("");
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "").trimEnd() + (out.some(line => line.trim()) ? "\n" : "");
}
