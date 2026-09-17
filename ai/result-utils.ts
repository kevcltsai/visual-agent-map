import type { VisualReference } from "../repository";

const KNOWLEDGE_HEADINGS = ["核心結論", "關鍵知識", "證據與來源", "取捨與限制", "待確認事項", "更新紀錄"] as const;

export function canonicalDetail(value: string): string {
  const detail = value.trim();
  if (KNOWLEDGE_HEADINGS.every(heading => new RegExp(`^### ${heading}\\s*$`, "m").test(detail))) return detail;
  const stamp = new Date().toLocaleDateString("zh-TW");
  return [
    `### 核心結論\n\n${detail || "尚待整理。"}`,
    "### 關鍵知識\n\n尚待補充。",
    "### 證據與來源\n\n尚待補充。",
    "### 取捨與限制\n\n尚待補充。",
    "### 待確認事項\n\n尚待補充。",
    `### 更新紀錄\n\n- ${stamp}：整理為結構化知識。`
  ].join("\n\n");
}

export function visualReferencesMarkdown(references: VisualReference[] = []): string {
  return references.map(item => {
    const title = item.title.trim() || "視覺參考";
    const imageUrl = item.imageUrl.trim();
    const sourceUrl = item.sourceUrl.trim();
    if (!imageUrl || !sourceUrl) return "";
    const palette = item.palette.map(color => color.trim()).filter(Boolean).join(" / ");
    return [
      `**${title}**`, "", `![${title}](${imageUrl})`, "", `來源：${sourceUrl}`,
      item.description.trim() ? `用途：${item.description.trim()}` : "",
      palette ? `配色：${palette}` : "",
      item.formula.trim() ? `可套用公式：${item.formula.trim()}` : ""
    ].filter(Boolean).join("\n");
  }).filter(Boolean).join("\n\n");
}
