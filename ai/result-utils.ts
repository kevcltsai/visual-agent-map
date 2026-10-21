import type { VisualReference } from "../repository";
import { translate, type UiLanguage } from "../i18n";
import type { AiResult } from "./types";
import { fencedLines } from "./markdown-blocks";
import { sectionLookup, standardTemplate, TEXTBOOK_TEMPLATE_ID, type DetailTemplate } from "./detail-templates";

export { fencedLines } from "./markdown-blocks";

const SENTENCE_END = /[。！？；!?;]/;

/**
 * Shortens a map summary to `limit` code points without leaving trailing whitespace.
 * Prefers a sentence end, then a word gap, in the second half of the window; otherwise
 * cuts hard. Shortened text that does not end a sentence gets an ellipsis within the limit.
 */
export function truncateSummary(value: string, limit = 80): string {
  const characters = Array.from(value.trim());
  if (characters.length <= limit) return characters.join("");
  const floor = Math.floor(limit / 2);
  for (let index = limit - 1; index >= floor; index--) {
    const character = characters[index];
    if (SENTENCE_END.test(character) || (character === "." && /\s/.test(characters[index + 1] ?? "")))
      return characters.slice(0, index + 1).join("");
  }
  const window = characters.slice(0, limit - 1);
  let gap = -1;
  for (let index = window.length - 1; index >= floor && gap < 0; index--) if (/\s/.test(window[index])) gap = index;
  return `${(gap >= 0 ? window.slice(0, gap) : window).join("").trimEnd()}…`;
}

const LEGACY_SEARCH_FAILURE = /\bresearch status\s*:\s*(?:not searched|search failed|unavailable)\b/i;

/** A searched report is unusable when its structured status says no search succeeded; legacy wording is consulted only without one. */
export function reportedSearchFailure(result: Pick<AiResult, "summary" | "detail" | "searchStatus">): boolean {
  // A completed report may still mention one unavailable source or subtask in its narrative.
  if (result.searchStatus !== undefined) return result.searchStatus !== "completed";
  return LEGACY_SEARCH_FAILURE.test(`${result.summary}\n${result.detail}`);
}

/**
 * A footnote definition VAM writes for a note source: an old `src-` label, a single wikilink, or an external-source
 * note. Other footnotes belong to the writer and are left alone.
 */
export function sourceFootnoteDefinition(line: string): { label: string; target: string } | null {
  const match = /^\[\^([^\]\s]+)\]:[ \t]*(.*)$/.exec(line);
  if (!match) return null;
  const target = match[2].trim();
  const external = (["zh-TW", "en"] as const).some(locale =>
    target.startsWith(translate(locale, "note.external_source_0", "").trim())
  );
  return match[1].startsWith("src-") || /^\[\[[^\]]+\]\]$/.test(target) || external
    ? { label: match[1], target }
    : null;
}

/**
 * Textbook layout: the text before the first heading stays on top as the intro, and a section that is empty (or only says
 * there is nothing new, in either language) is left out with its heading. Source footnotes still join the sources section.
 */
function textbookDetail(
  template: DetailTemplate,
  leading: string[],
  sections: Map<number, string[]>,
  footnotes: string[],
  sourcesIndex: number
): string {
  // The note placeholder in both languages, plus the "No new content this time" wording the prompts ask the model to write.
  const placeholders = new Set([
    ...(["zh-TW", "en"] as const).map(locale => translate(locale, "note.no_new_information").replace(/[.。]$/, "")),
    "No new content this time",
    "本次無新增內容"
  ]);
  if (footnotes.length && sourcesIndex >= 0) {
    const raw = (sections.get(sourcesIndex) ?? []).join("\n").trim();
    // A placeholder-only evidence section keeps its heading for the footnotes but drops the placeholder sentence.
    const evidence = placeholders.has(raw.replace(/[.。]$/, "")) ? "" : raw;
    sections.set(sourcesIndex, [[evidence, footnotes.join("\n")].filter(Boolean).join("\n\n")]);
  }
  const blocks = [leading.join("\n").trim()];
  template.sections.forEach((section, index) => {
    const body = sections.get(index)?.join("\n").trim() ?? "";
    if (body && !placeholders.has(body.replace(/[.。]$/, ""))) blocks.push(`### ${section.name}\n\n${body}`);
  });
  if (footnotes.length && sourcesIndex < 0) blocks.push(footnotes.join("\n"));
  return blocks.filter(Boolean).join("\n\n");
}

export function canonicalDetail(
  value: string,
  language: UiLanguage = "zh-TW",
  template: DetailTemplate = standardTemplate(language)
): string {
  const detail = value.trim();
  const headings = template.sections.map(section => section.name);
  const aliases = sectionLookup(template);
  const sourcesIndex = template.sections.findIndex(section => section.role === "sources");
  const sections = new Map<number, string[]>();
  const leading: string[] = [];
  // Source footnote definitions all belong to the sources section (or the end), wherever the reply put them.
  const footnotes: string[] = [];
  let current: number | null = null;
  const detailLines = detail.split("\n");
  const code = fencedLines(detailLines);
  for (const [index, line] of detailLines.entries()) {
    if (!code[index] && sourceFootnoteDefinition(line)) {
      footnotes.push(line);
      continue;
    }
    const heading = /^###\s+(.+?)\s*$/.exec(line);
    const match = heading ? aliases.get(heading[1].toLocaleLowerCase()) : undefined;
    if (match !== undefined) {
      current = match;
      if (!sections.has(match)) sections.set(match, []);
      continue;
    }
    (current === null ? leading : sections.get(current)!).push(line);
  }
  if (template.id === TEXTBOOK_TEMPLATE_ID) return textbookDetail(template, leading, sections, footnotes, sourcesIndex);
  if (sections.size === 0) sections.set(0, [leading.join("\n").trim()]);
  else if (leading.join("\n").trim()) sections.set(0, [leading.join("\n").trim(), ...(sections.get(0) ?? [])]);
  if (footnotes.length && sourcesIndex >= 0) {
    const evidence = (sections.get(sourcesIndex) ?? []).join("\n").trim();
    sections.set(sourcesIndex, [[evidence, footnotes.join("\n")].filter(Boolean).join("\n\n")]);
  }
  const empty = translate(language, "note.no_new_information");
  const body = headings
    .map((heading, index) => `### ${heading}\n\n${sections.get(index)?.join("\n").trim() || empty}`)
    .join("\n\n");
  return footnotes.length && sourcesIndex < 0 ? `${body}\n\n${footnotes.join("\n")}` : body;
}

export function visualReferencesMarkdown(references: VisualReference[] = [], language: UiLanguage = "zh-TW"): string {
  return references
    .map(item => {
      const title = item.title.trim() || translate(language, "detail.visual_reference");
      const imageUrl = item.imageUrl.trim();
      const sourceUrl = item.sourceUrl.trim();
      if (!imageUrl || !sourceUrl) return "";
      const palette = item.palette
        .map(color => color.trim())
        .filter(Boolean)
        .join(" / ");
      return [
        `**${title}**`,
        "",
        `![${title}](${imageUrl})`,
        "",
        translate(language, "detail.source", sourceUrl),
        item.description.trim() ? translate(language, "detail.purpose", item.description.trim()) : "",
        palette ? translate(language, "detail.palette", palette) : "",
        item.formula.trim() ? translate(language, "detail.reusable_formula", item.formula.trim()) : ""
      ]
        .filter(Boolean)
        .join("\n");
    })
    .filter(Boolean)
    .join("\n\n");
}
