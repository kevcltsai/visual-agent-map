import type { VisualReference } from "../repository";

const KNOWLEDGE_HEADINGS = ["核心結論", "關鍵知識", "證據與來源", "取捨與限制", "待確認事項", "更新紀錄"] as const;
const ENGLISH_HEADINGS = ["Core conclusions", "Key knowledge", "Evidence and sources", "Tradeoffs and limitations", "Open questions", "Update log"] as const;

export function canonicalDetail(value: string, language: "zh-TW" | "en" = "zh-TW"): string {
  const detail = value.trim();
  const headings = language === "en" ? ENGLISH_HEADINGS : KNOWLEDGE_HEADINGS;
  if (headings.every(heading => new RegExp(`^### ${heading}\\s*$`, "m").test(detail))) return detail;
  const stamp = new Date().toLocaleDateString(language);
  if (language === "en") return [
    `### Core conclusions\n\n${detail || "To be organized."}`,
    "### Key knowledge\n\nTo be added.",
    "### Evidence and sources\n\nTo be added.",
    "### Tradeoffs and limitations\n\nTo be added.",
    "### Open questions\n\nTo be added.",
    `### Update log\n\n- ${stamp}: Organized into structured knowledge.`
  ].join("\n\n");
  return [
    `### 核心結論\n\n${detail || "尚待整理。"}`,
    "### 關鍵知識\n\n尚待補充。",
    "### 證據與來源\n\n尚待補充。",
    "### 取捨與限制\n\n尚待補充。",
    "### 待確認事項\n\n尚待補充。",
    `### 更新紀錄\n\n- ${stamp}：整理為結構化知識。`
  ].join("\n\n");
}

export function visualReferencesMarkdown(references: VisualReference[] = [], language: "zh-TW" | "en" = "zh-TW"): string {
  return references.map(item => {
    const title = item.title.trim() || (language === "en" ? "Visual reference" : "視覺參考");
    const imageUrl = item.imageUrl.trim();
    const sourceUrl = item.sourceUrl.trim();
    if (!imageUrl || !sourceUrl) return "";
    const palette = item.palette.map(color => color.trim()).filter(Boolean).join(" / ");
    return [
      `**${title}**`, "", `![${title}](${imageUrl})`, "", `${language === "en" ? "Source: " : "來源："}${sourceUrl}`,
      item.description.trim() ? `${language === "en" ? "Purpose: " : "用途："}${item.description.trim()}` : "",
      palette ? `${language === "en" ? "Palette: " : "配色："}${palette}` : "",
      item.formula.trim() ? `${language === "en" ? "Reusable formula: " : "可套用公式："}${item.formula.trim()}` : ""
    ].filter(Boolean).join("\n");
  }).filter(Boolean).join("\n\n");
}
