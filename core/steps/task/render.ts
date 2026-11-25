import { assembleTaskPrompt, promptStepOf, selectionFromContext, type AssembledPrompt } from "./assemble";
import type { TaskContext } from "../../../ai/types";
import type { ContentLanguage } from "../../../i18n";
import type { AiProviderId } from "../../../ai/providers/provider";

export { isQuickTask, quickGuidance, readerFacingDetail } from "./prompt-policy";

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
