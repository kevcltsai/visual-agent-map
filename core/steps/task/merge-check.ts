import { noteNumbers } from "../chart/insert";

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
