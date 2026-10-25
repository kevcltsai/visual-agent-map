import type { ReasoningLevel } from "./types";
import type { TaskContext } from "./types";
import { translate, type ContentLanguage } from "../i18n";

export function normalizeReasoningLevel(value: unknown): ReasoningLevel {
  return value === "auto" || value === "medium" || value === "high" ? value : "low";
}
export function effectiveReasoningLevel(
  context: TaskContext,
  selected: ReasoningLevel
): Exclude<ReasoningLevel, "auto"> {
  if (selected !== "auto") return selected;
  if (context.mode === "synthesize" || context.mode === "merge") return "medium";
  return context.sourceContext && context.sourceContext.length > 6_000 ? "medium" : "low";
}

export function researchGuidance(context: TaskContext, language: ContentLanguage = "zh-TW"): string {
  const depth = translate(
    language,
    context.researchDepth === "fast"
      ? "research.fast"
      : context.researchDepth === "deep"
        ? "research.deep"
        : "research.normal"
  );
  if (context.researchMode === "local") return `${depth} ${translate(language, "research.local")}`;
  const web = `${depth} ${translate(language, "research.web")}`;
  // A standard research (Research mode, whatever its answer length) must search; the service also checks it did. AIM's isolated research and every helper request (synthesis, merge, decompose) keep the text above.
  const standard = !context.aimIsolatedResearch && (context.mode ?? "task") === "task";
  return standard ? `${web} ${translate(language, "research.web_required")}` : web;
}
