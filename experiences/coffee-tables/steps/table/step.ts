import { renderTemplate, type StepDefinition } from "../../../../core/step-runner";
import { coffeeInstruction, coffeeLanguageName, coffeeText } from "../../language";
import {
  cleanChatStyle,
  conversationStyle,
  formatReferenceContext,
  MAX_COFFEE_CONTEXT_CHARS,
  names,
  observerFormat
} from "../../prompt-parts";
import {
  LABEL_BACKGROUND,
  LABEL_CONVERSATION_STYLE,
  LABEL_PRIOR,
  LABEL_TABLE_DRAFT,
  TABLE_LEAD_IN_CONTINUE,
  TABLE_LEAD_IN_NEW
} from "../_shared/fragments";
import { segmentSummaryInstruction } from "../../segments";
import type { CoffeeGuestInvitation, GuestSettings } from "../../types";
import en from "./prompt.en.md";
import zh from "./prompt.zh.md";

export interface TableInput {
  topic: string;
  language: string;
  guests?: GuestSettings;
  draft?: string;
  priorContext?: string;
  invitedGuests?: CoffeeGuestInvitation[];
}

function variables(input: TableInput): Record<string, string> {
  const { topic, language, guests, draft = "", priorContext = "", invitedGuests = [] } = input;
  const settings = guests ?? {
    counts: { experts: 4, "cross-domain": 1, generalist: 1, affected: 1 },
    guests: [],
    background: "",
    customPrompt: ""
  };
  const attendeeRoles = names(settings, invitedGuests).map(role => `- ${role}`);
  const style = settings.customization
    ? cleanChatStyle(conversationStyle(language, settings))
    : conversationStyle(language, settings);
  const continuing = !!(draft || priorContext);
  return {
    hostCount: String(settings.hostCount ?? 2),
    topic,
    attendeeRoles: attendeeRoles.join("\n"),
    background: settings.background.trim() ? `\n${LABEL_BACKGROUND}${settings.background.trim()}` : "",
    language: coffeeLanguageName(language, "usage"),
    references: formatReferenceContext(settings.referenceFiles ?? []),
    custom: style ? `\n\n${LABEL_CONVERSATION_STYLE}\n${style}` : "",
    prior: priorContext ? `\n\n${LABEL_PRIOR}\n${priorContext}` : "",
    draftText: draft ? `\n\n${LABEL_TABLE_DRAFT}\n${draft}` : "",
    opening: continuing ? `${TABLE_LEAD_IN_CONTINUE}\n\n` : TABLE_LEAD_IN_NEW,
    notes: observerFormat(language, false, settings.customization) + segmentSummaryInstruction(language)
  };
}

/** Opening and continuation of a Coffee Table. The dialogue is parsed by the engine while it streams. */
export const tableStep: StepDefinition<TableInput, string> = {
  id: "coffee.table",
  version: 1,
  render: input => renderTemplate(coffeeInstruction(input.language) === "zh" ? zh : en, variables(input)),
  policy: (prompt, input) => {
    if (prompt.length > MAX_COFFEE_CONTEXT_CHARS)
      throw new Error(coffeeText(input.language, "coffee.table_too_long_start_new"));
  },
  parse: raw => raw
};
