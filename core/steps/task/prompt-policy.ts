import type { TaskContext } from "../../../ai/types";
import { translate, type ContentLanguage } from "../../../i18n";
import { quickKnowledge } from "../_shared/fragments";

/** Whether the request's detail is written for the reader, so it gets the Obsidian syntax rules and heading levels. */
export function readerFacingDetail(context: TaskContext): boolean {
  return context.mode !== "decompose" && !context.intermediateDetail;
}

/**
 * A Quick map research or expansion (not a helper request, not a count repair, not an intermediate extraction):
 * the model may answer from its own knowledge, so the source-safety and local-research texts are swapped for the Quick ones.
 */
export function isQuickTask(context: TaskContext): boolean {
  return (
    context.mapAiMode === "quick" &&
    context.researchMode === "local" &&
    (context.mode ?? "task") === "task" &&
    !context.countRepair &&
    !context.intermediateDetail
  );
}

/** `researchGuidance` for a Quick task: the depth sentence as usual, then the Quick knowledge rule instead of `research.local`. */
export function quickGuidance(context: TaskContext, language: ContentLanguage): string {
  const depth = translate(
    language,
    context.researchDepth === "fast"
      ? "research.fast"
      : context.researchDepth === "deep"
        ? "research.deep"
        : "research.normal"
  );
  return `${depth} ${quickKnowledge(language)}`;
}
