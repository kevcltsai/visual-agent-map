import type { ContentLanguage } from "../i18n";
import { inLanguage } from "../core/steps/_shared/fragments";
import { VISUAL_AUTO, VISUAL_EMBED, VISUAL_NONE, VISUAL_ON, VISUAL_PRESERVE } from "../core/steps/task/fragments";
import type { TaskContext } from "./types";

export function visualGuidance(context: TaskContext, language: ContentLanguage): string[] {
  const synthesis = context.mode === "synthesize";
  const maySearch = context.researchMode !== "local" && context.mode !== "decompose" && context.visualMode !== "off";
  const mayReuse = synthesis || context.mode === "merge";
  const instructions: string[] = [];
  if (!maySearch) {
    instructions.push(inLanguage(VISUAL_NONE, language));
    if (mayReuse) instructions.push(inLanguage(VISUAL_PRESERVE, language));
  } else if (context.visualMode === "on") instructions.push(inLanguage(VISUAL_ON, language));
  else instructions.push(inLanguage(VISUAL_AUTO, language));
  if (maySearch || mayReuse) instructions.push(inLanguage(VISUAL_EMBED, language));
  return instructions;
}
