import { renderTemplate, type StepDefinition } from "../../../../core/step-runner";
import { coffeeInstruction, coffeeLanguageName, coffeeText } from "../../language";
import { LABEL_CONVERSATION_STYLE_OBSERVER, LABEL_DIALOGUE_DRAFT, LABEL_NOTES_DRAFT } from "../_shared/fragments";
import {
  assembleCoffeeContext,
  cleanChatStyle,
  conversationStyle,
  formatReferenceContext,
  MAX_COFFEE_CONTEXT_CHARS,
  observerFormat
} from "../../prompt-parts";
import type { CoffeeSession } from "../../types";
import en from "./prompt.en.md";
import zh from "./prompt.zh.md";

export interface ObserverOnlyInput {
  session: CoffeeSession;
}

function history(session: CoffeeSession): string {
  return [
    assembleCoffeeContext(session),
    session.draftMarkdown ? `${LABEL_DIALOGUE_DRAFT}\n${session.draftMarkdown}` : "",
    session.observerDraftMarkdown ? `${LABEL_NOTES_DRAFT}\n${session.observerDraftMarkdown}` : ""
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Refresh the observer notes only. The notes are validated and merged by the engine. */
export const observerOnlyStep: StepDefinition<ObserverOnlyInput, string> = {
  id: "coffee.observer-only",
  version: 1,
  render: ({ session }) => {
    const key = coffeeInstruction(session.language);
    const style = session.guests?.customization
      ? cleanChatStyle(conversationStyle(session.language, session.guests))
      : conversationStyle(session.language, session.guests);
    return renderTemplate(key === "zh" ? zh : en, {
      language: coffeeLanguageName(session.language, "plain"),
      styleSection: style ? `${LABEL_CONVERSATION_STYLE_OBSERVER[key]}:\n${style}\n` : "",
      references: formatReferenceContext(session.guests?.referenceFiles ?? []),
      history: history(session),
      observerFormat: observerFormat(session.language, true, session.guests?.customization)
    });
  },
  policy: (prompt, { session }) => {
    const language = session.language;
    // Original order: the history limit was checked before the prompt was assembled.
    if (history(session).length > MAX_COFFEE_CONTEXT_CHARS)
      throw new Error(coffeeText(language, "coffee.table_too_long_to_summarize"));
    if (prompt.length > MAX_COFFEE_CONTEXT_CHARS)
      throw new Error(coffeeText(language, "coffee.table_too_long_to_summarize_prompt"));
  },
  parse: raw => raw
};
