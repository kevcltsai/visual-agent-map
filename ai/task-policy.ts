import type { ReasoningLevel } from "../repository";
import type { TaskContext } from "./types";

export const RESEARCH_SEARCH_BUDGET = 3;

export function effectiveReasoningLevel(context: TaskContext, selected: ReasoningLevel): Exclude<ReasoningLevel, "auto"> {
  if (selected !== "auto") return selected;
  if (context.mode === "synthesize") return "medium";
  return context.sourceContext && context.sourceContext.length > 6_000 ? "medium" : "low";
}

export function researchGuidance(context: TaskContext): string {
  if (context.researchMode === "local") return "這是整理既有內容的任務：只使用本次提供的議題與來源背景，不要搜尋網路、讀取其他檔案或提出未經提供資料支持的新事實。";
  return `只有需要外部事實時才搜尋；最多進行 ${RESEARCH_SEARCH_BUDGET} 次網路搜尋、閱讀最多 5 個主要來源。資訊足夠就停止，不做窮盡式研究；若證據不足，明確列為待確認事項。`;
}
