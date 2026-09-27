import type { VisualReference } from "../repository";
import { translate, type UiLanguage } from "../i18n";

export function canonicalDetail(value: string, language: UiLanguage = "zh-TW"): string {
  const detail = value.trim();
  const keys = ["detail.core_conclusions", "detail.key_knowledge", "detail.evidence_and_sources", "detail.tradeoffs_and_limitations", "detail.open_questions", "detail.update_log"] as const;
  const headings = keys.map(key => translate(language, key));
  const aliases = new Map<string, number>();
  for (let index = 0; index < keys.length; index++) for (const locale of ["zh-TW", "en"] as const) aliases.set(translate(locale, keys[index]).toLocaleLowerCase(), index);
  const sections = new Map<number, string[]>();
  const leading: string[] = [];
  let current: number | null = null;
  for (const line of detail.split("\n")) {
    const heading = /^###\s+(.+?)\s*$/.exec(line);
    const match = heading ? aliases.get(heading[1].toLocaleLowerCase()) : undefined;
    if (match !== undefined) { current = match; if (!sections.has(match)) sections.set(match, []); continue; }
    (current === null ? leading : sections.get(current)!).push(line);
  }
  if (sections.size === 0) sections.set(0, [detail]);
  else if (leading.join("\n").trim()) sections.set(0, [leading.join("\n").trim(), ...(sections.get(0) ?? [])]);
  const empty = language === "en" ? "No new information in this task." : "本次無新增內容。";
  return headings.map((heading, index) => `### ${heading}\n\n${sections.get(index)?.join("\n").trim() || empty}`).join("\n\n");
}

export function visualReferencesMarkdown(references: VisualReference[] = [], language: UiLanguage = "zh-TW"): string {
  return references.map(item => {
    const title = item.title.trim() || translate(language, "detail.visual_reference");
    const imageUrl = item.imageUrl.trim();
    const sourceUrl = item.sourceUrl.trim();
    if (!imageUrl || !sourceUrl) return "";
    const palette = item.palette.map(color => color.trim()).filter(Boolean).join(" / ");
    return [
      `**${title}**`, "", `![${title}](${imageUrl})`, "", translate(language, "detail.source", sourceUrl),
      item.description.trim() ? translate(language, "detail.purpose", item.description.trim()) : "",
      palette ? translate(language, "detail.palette", palette) : "",
      item.formula.trim() ? translate(language, "detail.reusable_formula", item.formula.trim()) : ""
    ].filter(Boolean).join("\n");
  }).filter(Boolean).join("\n\n");
}
