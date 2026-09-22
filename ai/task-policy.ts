import type { ReasoningLevel } from "../repository";
import type { TaskContext } from "./types";

export const RESEARCH_SEARCH_BUDGET = 3;
export function researchLimits(depth: TaskContext["researchDepth"]): { searches: number; sources: number } {
  if (depth === "fast") return { searches: 1, sources: 2 };
  if (depth === "deep") return { searches: 6, sources: 10 };
  return { searches: 3, sources: 5 };
}

export function effectiveReasoningLevel(context: TaskContext, selected: ReasoningLevel): Exclude<ReasoningLevel, "auto"> {
  if (selected !== "auto") return selected;
  if (context.mode === "synthesize") return "medium";
  return context.sourceContext && context.sourceContext.length > 6_000 ? "medium" : "low";
}

export function researchGuidance(context: TaskContext): string {
  const depth = context.researchDepth === "fast" ? "快速概覽：先回答核心問題，簡短列出關鍵依據與缺口；不要做完整調查。"
    : context.researchDepth === "deep" ? "深入研究：檢查來源間的一致與分歧，詳列重要證據、限制與待查問題。"
      : "一般研究：提供足以支持結論的主要證據、限制與待確認事項。";
  if (context.researchMode === "local") return `${depth}只使用本次提供的議題與來源背景，不要搜尋網路或讀取其他檔案。若現有資料無法支持答案，明確寫出「現有資料不足」及缺少什麼，不得用模型記憶補成確定事實或編造來源。`;
  const { searches, sources } = researchLimits(context.researchDepth);
  return `${depth}只有需要外部事實時才搜尋；以最多 ${searches} 次網路搜尋、${sources} 個主要來源為目標。資訊足夠就停止；若證據不足，明確列為待確認事項。`;
}
