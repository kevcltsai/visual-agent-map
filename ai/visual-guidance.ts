import { translate } from "../i18n";
import type { Settings } from "../repository";
import type { TaskContext } from "./types";

export function visualGuidance(context: TaskContext, language: Settings["language"]): string[] {
  const synthesis = context.mode === "synthesize";
  const maySearch = context.researchMode !== "local" && context.mode !== "decompose" && context.visualMode !== "off";
  const mayReuse = synthesis;
  const instructions: string[] = [];
  if (!maySearch) {
    instructions.push(translate(language, "prompt.visual_none"));
    if (mayReuse) instructions.push(translate(language, "prompt.visual_preserve"));
  } else if (context.visualMode === "on") instructions.push(translate(language, "prompt.visual_on"));
  else instructions.push(translate(language, "prompt.visual_auto"));
  if (maySearch || mayReuse) instructions.push(translate(language, "prompt.visual_embed"));
  return instructions;
}
