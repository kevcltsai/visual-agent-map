import type { ReasoningLevel } from "./types";
import type { TaskContext } from "./types";
import { translate, type UiLanguage } from "../i18n";

export function normalizeReasoningLevel(value: unknown): ReasoningLevel {
  return value === "auto" || value === "medium" || value === "high" ? value : "low";
}
export function effectiveReasoningLevel(context: TaskContext, selected: ReasoningLevel): Exclude<ReasoningLevel, "auto"> {
  if (selected !== "auto") return selected;
  if (context.mode === "synthesize") return "medium";
  return context.sourceContext && context.sourceContext.length > 6_000 ? "medium" : "low";
}

export function researchGuidance(context: TaskContext, language: UiLanguage = "zh-TW"): string {
  const depth = translate(language, context.researchDepth === "fast" ? "research.fast" : context.researchDepth === "deep" ? "research.deep" : "research.normal");
  if (context.researchMode === "local") return `${depth} ${translate(language, "research.local")}`;
  return `${depth} ${translate(language, "research.web")}`;
}
