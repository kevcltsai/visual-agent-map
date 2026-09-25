import type { ReasoningLevel } from "../repository";
import type { TaskContext } from "./types";
import { translate, type UiLanguage } from "../i18n";

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

export function researchGuidance(context: TaskContext, language: UiLanguage = "zh-TW"): string {
  const depth = translate(language, context.researchDepth === "fast" ? "research.fast" : context.researchDepth === "deep" ? "research.deep" : "research.normal");
  if (context.researchMode === "local") return `${depth} ${translate(language, "research.local")}`;
  const { searches, sources } = researchLimits(context.researchDepth);
  return `${depth} ${translate(language, "research.web", searches, sources)}`;
}
