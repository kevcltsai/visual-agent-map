import { renderTemplate, type StepDefinition } from "../../../../core/step-runner";
import { coffeeInstruction, coffeeLanguageName, coffeeText } from "../../language";
import { LABEL_ANSWER_DRAFT, LABEL_CONVERSATION_STYLE } from "../_shared/fragments";
import {
  assembleCoffeeContext,
  cleanChatStyle,
  conversationStyle,
  formatReferenceContext,
  invitationContext,
  MAX_COFFEE_CONTEXT_CHARS,
  observerFormat
} from "../../prompt-parts";
import { segmentSummaryInstruction } from "../../segments";
import type { CoffeeGuestInvitation, CoffeeSession } from "../../types";
import en from "./prompt.en.md";
import zh from "./prompt.zh.md";

export interface QuestionInput {
  session: CoffeeSession;
  question: string;
  draft?: string;
  invitedGuests?: CoffeeGuestInvitation[];
}

function variables(input: QuestionInput, context: string): Record<string, string> {
  const { session, question, draft = "", invitedGuests = [] } = input;
  const settings = session.guests;
  const style = settings?.customization
    ? cleanChatStyle(conversationStyle(session.language, settings))
    : conversationStyle(session.language, settings);
  const inviteContext = invitationContext(invitedGuests, session.language);
  return {
    language: coffeeLanguageName(session.language, "plain"),
    custom: style ? `\n${LABEL_CONVERSATION_STYLE}\n${style}` : "",
    references: formatReferenceContext(settings?.referenceFiles ?? []),
    context,
    inviteBlock: inviteContext ? `\n\n${inviteContext}` : "",
    question,
    draftBlock: draft ? `\n\n${LABEL_ANSWER_DRAFT}\n${draft}` : "",
    observerFormat: observerFormat(session.language, false, settings?.customization),
    summaryInstruction: segmentSummaryInstruction(session.language)
  };
}

/** Follow-up answer. The answer is parsed by the engine while it streams. */
export const questionStep: StepDefinition<QuestionInput, string> = {
  id: "coffee.question",
  version: 1,
  render: input => {
    const context = assembleCoffeeContext(input.session);
    return renderTemplate(coffeeInstruction(input.session.language) === "zh" ? zh : en, variables(input, context));
  },
  policy: (prompt, input) => {
    const language = input.session.language;
    // Original order: the context-plus-question limit was checked before the prompt was assembled.
    if (assembleCoffeeContext(input.session).length + input.question.length > MAX_COFFEE_CONTEXT_CHARS)
      throw new Error(coffeeText(language, "coffee.table_too_long_start_new"));
    if (prompt.length > MAX_COFFEE_CONTEXT_CHARS)
      throw new Error(coffeeText(language, "coffee.table_too_long_conversation_preserved"));
  },
  parse: raw => raw
};
