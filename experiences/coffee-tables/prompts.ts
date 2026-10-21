import { prepareStep, renderTemplate } from "../../core/step-runner";
import { coffeeInstruction } from "./language";
import { PREVIEW_OBSERVER_NOTES_TEMPLATE } from "./steps/_shared/fragments";
import { observerGuidance } from "./customization";
import { cleanChatStyle, conversationStyle, observerFormat, OBSERVER_TITLES } from "./prompt-parts";
import { segmentSummaryInstruction } from "./segments";
import { observerOnlyStep } from "./steps/observer-only/step";
import { questionStep } from "./steps/question/step";
import { tableStep } from "./steps/table/step";
import type { CoffeeGuestInvitation, CoffeeSession, GuestSettings } from "./types";

export * from "./prompt-parts";

/** The prompt text of each step is defined by its Step Runner step; these helpers render it without sending it. */
export function tablePrompt(
  topic: string,
  language: string,
  guests?: GuestSettings,
  draft = "",
  priorContext = "",
  invitedGuests: CoffeeGuestInvitation[] = []
): string {
  return prepareStep(tableStep, { topic, language, guests, draft, priorContext, invitedGuests }).prompt;
}
export function questionPrompt(
  session: CoffeeSession,
  question: string,
  draft = "",
  invitedGuests: CoffeeGuestInvitation[] = []
): string {
  return prepareStep(questionStep, { session, question, draft, invitedGuests }).prompt;
}
export function observerOnlyPrompt(session: CoffeeSession): string {
  return prepareStep(observerOnlyStep, { session }).prompt;
}
/** Display-only opening preview; provider protocol remains in the table step. */
export function openingPromptPreview(topic: string, language: string, guests: GuestSettings): string {
  const key = coffeeInstruction(language);
  const style = cleanChatStyle(conversationStyle(language, guests));
  const prompt = tablePrompt(topic, language, { ...guests, stylePrompt: style });
  const guidance = guests.customization ? `${observerGuidance(language, guests.customization)}\n` : "";
  const readableNotes = `\n\n${renderTemplate(PREVIEW_OBSERVER_NOTES_TEMPLATE[key], { guidance, titles: OBSERVER_TITLES[key] })}`;
  const protocol = observerFormat(language, false, guests.customization) + segmentSummaryInstruction(language);
  return prompt.slice(0, -protocol.length) + readableNotes;
}
