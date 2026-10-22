import { sourcesHeadingKeys, type DetailTemplate } from "../../../ai/detail-templates";
import { fencedLines } from "../../../ai/markdown-blocks";
import { type ContentLanguage, translateNote } from "../../../i18n";
import { linksOf } from "./merge-check";

/**
 * Deterministic carry-forward for the child synthesis write. The model rewrites the parent's Detail from the child
 * notes and may drop the links the parent's earlier research had. Every link (same identity as the merge check) that the
 * earlier text had and the new text lacks is appended once, in the earlier order, to a "Sources from earlier research"
 * block at the end of the sources section. Nothing is carried when nothing is missing.
 */
const HEADING_KEY = "note.earlier_research_sources" as const;
const ANY_HEADING = /^#{3,4}[ \t]+(?:先前研究的來源|Sources from earlier research)[ \t]*$/i;
const TOKEN = /!?\[\[[^\]]+\]\]|!?\[[^\]]*\]\(\s*<?[^)\s>]+[^)]*\)|<?https?:\/\/[^\s<>"'`)\]]+>?/g;

function outsideCode(text: string): string[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const code = fencedLines(lines);
  return lines.filter((_, index) => !code[index]);
}

function keysOf(text: string): string[] {
  return [...linksOf([text]).keys()];
}

/** The line to carry for a plain paragraph, list item or callout line. */
function plainLine(line: string): string {
  const stripped = line
    .replace(/^[ \t]*(?:>[ \t]*)*/, "")
    .replace(/^(?:[-*+]|\d+[.)])[ \t]+/, "")
    .replace(/\[\^[^\]\s]+\](?!\()/g, "")
    .replace(/!(\[[^\]]*\]\()/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  return `- ${stripped}`;
}

/** The link tokens of a line (table row, heading, ...) that are still wanted, as written; images become links. */
function linkTokens(line: string, wanted: (keys: string[]) => boolean): string[] {
  const out: string[] = [];
  for (const match of line.matchAll(TOKEN)) {
    const token = match[0];
    if (!wanted(keysOf(token))) continue;
    if (/^<?https?:/.test(token)) out.push(`<${token.replace(/^<|>$/g, "")}>`);
    else out.push(token.replace(/^!/, ""));
  }
  return out;
}

export function carriedSourceLines(previousTexts: string[], nextTexts: string[]): string[] {
  const have = new Set(linksOf(nextTexts.flatMap(outsideCode)).keys());
  const missing = new Set([...linksOf(previousTexts.flatMap(outsideCode)).keys()].filter(key => !have.has(key)));
  if (!missing.size) return [];
  const covered = new Set<string>();
  const lines: string[] = [];
  const add = (line: string): void => {
    if (line.trim() && !lines.includes(line)) lines.push(line);
  };
  const open = (keys: string[]): boolean => keys.some(key => missing.has(key) && !covered.has(key));
  for (const line of previousTexts.flatMap(outsideCode)) {
    const keys = keysOf(line);
    if (!open(keys)) continue;
    const definition = /^[ \t]*\[\^[^\]\s]+\]:[ \t]*(.*)$/.exec(line);
    if (definition) add(`- ${definition[1].trim()}`);
    else if (/^[ \t]*(?:\||#{1,6}[ \t])/.test(line)) for (const token of linkTokens(line, open)) add(`- ${token}`);
    else add(plainLine(line));
    for (const key of keys) covered.add(key);
  }
  return lines;
}

export function carryForwardSources(
  detail: string,
  previousTexts: string[],
  nextTexts: string[],
  language: ContentLanguage,
  template: DetailTemplate
): string {
  const carried = carriedSourceLines(previousTexts, nextTexts);
  if (!carried.length) return detail;
  const heading = translateNote(language, HEADING_KEY);
  const lines = detail.split("\n");
  const code = fencedLines(lines);
  const existing = lines.findIndex((line, index) => !code[index] && ANY_HEADING.test(line));
  if (existing >= 0) return insertAfterBlock(lines, code, existing, carried, /^#{1,4}[ \t]/);
  const keys = sourcesHeadingKeys(template);
  const start = lines.findIndex((line, index) => {
    const match = code[index] ? null : /^###\s+(.+?)\s*$/.exec(line);
    return !!match && keys.has(match[1].toLocaleLowerCase());
  });
  if (start < 0) return `${detail.trimEnd()}\n\n### ${heading}\n\n${carried.join("\n")}\n`;
  return insertAfterBlock(lines, code, start, [`#### ${heading}`, "", ...carried], /^###[ \t]/, true);
}

function insertAfterBlock(
  lines: string[],
  code: boolean[],
  start: number,
  add: string[],
  stop: RegExp,
  separate = false
): string {
  let end = lines.findIndex((line, index) => index > start && !code[index] && stop.test(line));
  if (end < 0) end = lines.length;
  while (end > start + 1 && !lines[end - 1].trim()) end--;
  return [
    ...lines.slice(0, end),
    ...(separate ? [""] : []),
    ...add,
    ...(end < lines.length && lines[end].trim() ? [""] : []),
    ...lines.slice(end)
  ].join("\n");
}
