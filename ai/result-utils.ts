import type { VisualReference } from "../repository";
import { translate, type UiLanguage } from "../i18n";

export function canonicalDetail(value: string, language: UiLanguage = "zh-TW"): string {
  const detail = value.trim();
  const keys = ["detail.core_conclusions", "detail.key_knowledge", "detail.evidence_and_sources", "detail.tradeoffs_and_limitations", "detail.open_questions", "detail.update_log"] as const;
  const headings = keys.map(key => translate(language, key));
  if (headings.every(heading => new RegExp(`^### ${heading}\\s*$`, "m").test(detail))) return detail;
  const stamp = new Date().toLocaleDateString(language);
  if (language === "en") return [
    `### ${headings[0]}\n\n${detail || translate(language, "detail.to_be_organized")}`,
    ...headings.slice(1, 5).map(heading => `### ${heading}\n\n${translate(language, "detail.to_be_added")}`),
    `### ${headings[5]}\n\n- ${stamp}: ${translate(language, "detail.organized_update")}`
  ].join("\n\n");
  return [
    `### ${headings[0]}\n\n${detail || translate(language, "detail.to_be_organized")}`,
    ...headings.slice(1, 5).map(heading => `### ${heading}\n\n${translate(language, "detail.to_be_added")}`),
    `### ${headings[5]}\n\n- ${stamp}：${translate(language, "detail.organized_update")}`
  ].join("\n\n");
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
