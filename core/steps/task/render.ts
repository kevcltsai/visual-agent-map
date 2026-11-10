import { assembleTaskPrompt, promptStepOf, selectionFromContext, type AssembledPrompt } from "./assemble";
import type { TaskContext } from "../../../ai/types";
import { translate, type ContentLanguage } from "../../../i18n";
import type { AiProviderId } from "../../../ai/providers/provider";
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

/** The task prompt with its segments and issues: the style selection today's request fields stand for, assembled step by step. */
export function assembledTaskPrompt(
  context: TaskContext,
  language: ContentLanguage,
  provider: AiProviderId = "codex"
): AssembledPrompt {
  const selection = context.styleSelection ?? selectionFromContext(context, language);
  return assembleTaskPrompt(selection, promptStepOf(context), context, language, provider);
}

/** The task prompt text. */
export function generalTaskPrompt(
  context: TaskContext,
  language: ContentLanguage,
  provider: AiProviderId = "codex"
): string {
  return assembledTaskPrompt(context, language, provider).text;
}

export function taskPrompt(context: TaskContext, language: ContentLanguage, provider: AiProviderId = "codex"): string {
  return generalTaskPrompt(context, language, provider);
}
