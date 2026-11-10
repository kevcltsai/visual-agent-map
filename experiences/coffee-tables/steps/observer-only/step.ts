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

/**
 * The length of the history `render` built for this request, handed to `policy` so one request assembles the table's
 * context once. Keyed by the request's own input object, so an entry lives only as long as that request.
 */
const historyLengths = new WeakMap<ObserverOnlyInput, number>();
function rememberHistory(input: ObserverOnlyInput, text: string): string {
  historyLengths.set(input, text.length);
  return text;
}

/** Refresh the observer notes only. The notes are validated and merged by the engine. */
export const observerOnlyStep: StepDefinition<ObserverOnlyInput, string> = {
  id: "coffee.observer-only",
  version: 1,
  render: input => {
    const { session } = input;
    const key = coffeeInstruction(session.language);
    const style = session.guests?.customization
      ? cleanChatStyle(conversationStyle(session.language, session.guests))
      : conversationStyle(session.language, session.guests);
    return renderTemplate(key === "zh" ? zh : en, {
      language: coffeeLanguageName(session.language, "plain"),
      styleSection: style ? `${LABEL_CONVERSATION_STYLE_OBSERVER[key]}:\n${style}\n` : "",
      references: formatReferenceContext(session.guests?.referenceFiles ?? []),
      // Built where it always was among the template values, so a failure surfaces in the same order.
      history: rememberHistory(input, history(session)),
      observerFormat: observerFormat(session.language, true, session.guests?.customization)
    });
  },
  policy: (prompt, input) => {
    const { session } = input;
    const language = session.language;
    // Original order: the history limit was checked before the prompt was assembled.
    if ((historyLengths.get(input) ?? history(session).length) > MAX_COFFEE_CONTEXT_CHARS)
      throw new Error(coffeeText(language, "coffee.table_too_long_to_summarize"));
    if (prompt.length > MAX_COFFEE_CONTEXT_CHARS)
      throw new Error(coffeeText(language, "coffee.table_too_long_to_summarize_prompt"));
  },
  parse: raw => raw
};
