import type { CoffeeSession, GuestSettings } from "./types";
import type { CoffeeGuestInvitation } from "./types";
import { baselineFromVersions, serializeInsightNotes } from "./insights";
import { renderTemplate } from "../../core/step-runner";
import { headingsVerbatim } from "../../core/steps/_shared/fragments";
import { observerGuidance } from "./customization";
import { languagePromptName } from "../../i18n";
import { coffeeContentLocale, coffeeInstruction } from "./language";
import {
  BUILTIN_STYLE_TEMPLATE,
  CATEGORY_LABEL,
  CONTEXT_ANSWER_PENDING,
  CONTEXT_EXISTING_INSIGHTS,
  CONTEXT_FOLLOW_UP,
  CONTEXT_FOLLOW_UP_GUESTS,
  CONTEXT_INTERVENTION,
  CONTEXT_REFERENCE_FILE,
  CONTEXT_TABLE_ANSWER,
  GUEST_ROLE,
  CONTEXT_INVITED_GUESTS,
  CONTEXT_REFERENCE,
  INSIGHT_UPDATE_FOOTER,
  OBSERVER_FORMAT_TEMPLATE,
  OBSERVER_REFRESH_ONLY,
  OBSERVER_SOURCE,
  OBSERVER_TITLES
} from "./steps/_shared/fragments";

export const MAX_COFFEE_CONTEXT_CHARS = 180_000;
export const BUILTIN_COFFEE_STYLE_NAME = "自然交流與跨域探索";
/**
 * The built-in conversation style for a session language. The language phrase is the registry's `usage` name of the
 * language the table speaks (the interface language when it shares the session's note language); everything else is the
 * template text. A style the user saved keeps whatever text it was saved with.
 */
export function builtinCoffeeStyle(language: string): string {
  const key = coffeeInstruction(language);
  return renderTemplate(BUILTIN_STYLE_TEMPLATE[key], {
    language: languagePromptName(coffeeContentLocale(language), key, "usage")
  });
}
export const BUILTIN_COFFEE_STYLE_PROMPT_EN = renderTemplate(BUILTIN_STYLE_TEMPLATE.en, {
  language: languagePromptName("en", "en", "usage")
});
export const BUILTIN_COFFEE_STYLE_PROMPT = renderTemplate(BUILTIN_STYLE_TEMPLATE.zh, {
  language: languagePromptName("zh-TW", "zh", "usage")
});
/** Assemble every persisted conversational event in timestamp order. Drafts are
 * first-class context so a retry can continue without silently losing text. */
export function assembleCoffeeContext(session: CoffeeSession): string {
  const events: Array<{ at: number; order: number; text: string }> = [];
  let order = 0;
  const add = (at: string | undefined, text: string): void => {
    if (!text.trim()) return;
    const parsed = at ? Date.parse(at) : Number.NaN;
    events.push({ at: Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER, order: order++, text: text.trim() });
  };
  const rounds = session.rounds ?? [];
  const attachedInterventions = new Set<string>();
  if (rounds.length) {
    for (const round of rounds) {
      const source = round.markdown || round.draftMarkdown || "";
      const attached = (session.interventions ?? [])
        .filter(item => item.roundId === round.id)
        .sort((a, b) => (a.afterTurn ?? 0) - (b.afterTurn ?? 0) || Date.parse(a.createdAt) - Date.parse(b.createdAt));
      for (const item of attached) attachedInterventions.add(item.id);
      if (!attached.length || !/^###\s+/m.test(source)) {
        add(
          round.createdAt,
          [source, ...attached.map(item => `${CONTEXT_INTERVENTION}${item.text}`)].filter(Boolean).join("\n\n")
        );
        continue;
      }
      const parts = source.split(/(?=^###\s+)/m),
        output: string[] = [];
      let speakerTurns = 0,
        nextIntervention = 0;
      const inject = (limit: number): void => {
        while (nextIntervention < attached.length && (attached[nextIntervention].afterTurn ?? 0) <= limit)
          output.push(`${CONTEXT_INTERVENTION}${attached[nextIntervention++].text}`);
      };
      for (const part of parts) {
        if (/^###\s+/.test(part)) {
          inject(speakerTurns);
          output.push(part);
          speakerTurns++;
          inject(speakerTurns);
        } else {
          inject(0);
          if (part.trim()) output.push(part);
        }
      }
      inject(Number.MAX_SAFE_INTEGER);
      add(round.createdAt, output.join("\n\n"));
    }
  } else add(session.createdAt, session.transcriptMarkdown);
  for (const question of session.questions) {
    if (question.status === "pending" && !question.answer && !question.draftAnswer) continue;
    const guests = question.invitedGuests?.length
      ? `\n${CONTEXT_FOLLOW_UP_GUESTS}\n${question.invitedGuests.map(guest => `- ${guest.name}｜${CATEGORY_LABEL[guest.category]}：${guest.description}`).join("\n")}`
      : "";
    add(
      question.createdAt,
      `${CONTEXT_FOLLOW_UP}${question.question}${guests}\n${CONTEXT_TABLE_ANSWER}${question.answer || question.draftAnswer || CONTEXT_ANSWER_PENDING}`
    );
  }
  for (const intervention of session.interventions ?? [])
    if (!attachedInterventions.has(intervention.id))
      add(intervention.createdAt, `${CONTEXT_INTERVENTION}${intervention.text}`);
  events.sort((a, b) => a.at - b.at || a.order - b.order);
  const existingInsights = baselineFromVersions(session.observerNotes ?? [], session.language);
  const notes = existingInsights.length
    ? `${CONTEXT_EXISTING_INSIGHTS}\n${serializeInsightNotes(existingInsights, session.language)}`
    : "";
  return [...events.map(item => item.text), notes].filter(Boolean).join("\n\n");
}
export function names(guests: GuestSettings, invited: CoffeeGuestInvitation[] = []): string[] {
  return (["experts", "cross-domain", "generalist", "affected"] as const).flatMap(category => [
    ...Array.from({ length: guests.counts[category] }, (_, index) => {
      const named = guests.guests.filter(item => item.category === category)[index];
      return named ? `${CATEGORY_LABEL[category]}：${named.description}` : CATEGORY_LABEL[category];
    }),
    ...invited
      .filter(item => item.category === category)
      .map(item => `${CATEGORY_LABEL[category]}：${item.name}（${item.description}）`)
  ]);
}
export function conversationStyle(language: string, settings?: GuestSettings): string {
  if (typeof settings?.stylePrompt === "string") return settings.stylePrompt.trim();
  const builtin = builtinCoffeeStyle(language);
  return settings?.customPrompt.trim() ? `${builtin}\n\n${settings.customPrompt.trim()}` : builtin;
}
export { OBSERVER_TITLES };
/**
 * The fixed observer headings as the prompt lists them. When the table speaks a language whose note language differs
 * (Simplified Chinese), a clause follows the list so the model copies the headings exactly and writes only the content
 * in that language; for zh-TW and English it is the list alone.
 */
export function observerTitles(language: string): string {
  const key = coffeeInstruction(language);
  const clause = headingsVerbatim(coffeeContentLocale(language), key);
  return clause ? `${OBSERVER_TITLES[key]}\n${clause}` : OBSERVER_TITLES[key];
}
export function observerFormat(
  language: string,
  refreshOnly = false,
  customization?: GuestSettings["customization"]
): string {
  const key = coffeeInstruction(language);
  const preferences = customization ? `${observerGuidance(language, customization)}\n` : "";
  return renderTemplate(OBSERVER_FORMAT_TEMPLATE, {
    operation: refreshOnly ? `${OBSERVER_REFRESH_ONLY[key]}\n` : "",
    preferences,
    source: OBSERVER_SOURCE[key],
    update: INSIGHT_UPDATE_FOOTER[key],
    titles: observerTitles(language)
  });
}
export function invitationContext(invitedGuests: CoffeeGuestInvitation[], language: string): string {
  if (!invitedGuests.length) return "";
  const key = coffeeInstruction(language);
  const role = GUEST_ROLE[key];
  return `${CONTEXT_INVITED_GUESTS[key]}\n${invitedGuests.map(guest => `- ${guest.name}｜${role[guest.category]}：${guest.description}`).join("\n")}`;
}
/** Remove the legacy internal protocol passage from editable conversation styles. */
export function readableCoffeeStyle(style: string): string {
  return style
    .replace(/既有洞見有程式維持的穩定識別碼：[\s\S]*?程式會保留未提及項目。/g, "")
    .replace(/Existing insights have stable program IDs:[\s\S]*?the program retains omitted items\./g, "");
}
/** Strip only the observer-specific text shipped in the built-in styles. */
export function cleanChatStyle(style: string): string {
  const zhObserverIntro =
    "觀察者整理整桌不斷發展的洞見：意外連結、值得繼續想的問題、核心分歧、探索方向、待查證假設，以及來賓提出疑問時對談中出現的可能回應。不添加新事實，也不替使用者下結論。";
  const enObserverIntro =
    "The observer records the table’s evolving insights: unexpected connections, questions worth pursuing, core disagreements, directions to explore, assumptions to verify, and guests’ questions with possible responses. Add no new facts and do not decide for the user.";
  const paragraphs = style
    .split(/\n\s*\n/)
    .map(value => value.trim())
    .filter(Boolean);
  const knownObserverParagraphs = new Set(
    [
      BUILTIN_COFFEE_STYLE_PROMPT.split(/\n\s*\n/)[1]?.trim(),
      BUILTIN_COFFEE_STYLE_PROMPT.split(/\n\s*\n/)[2]?.trim(),
      BUILTIN_COFFEE_STYLE_PROMPT.split(/\n\s*\n/)[3]?.trim(),
      BUILTIN_COFFEE_STYLE_PROMPT_EN.split(/\n\s*\n/)[1]?.trim(),
      BUILTIN_COFFEE_STYLE_PROMPT_EN.split(/\n\s*\n/)[2]?.trim(),
      BUILTIN_COFFEE_STYLE_PROMPT_EN.split(/\n\s*\n/)[3]?.trim()
    ].filter((value): value is string => !!value)
  );
  const chatText = readableCoffeeStyle(
    paragraphs.filter(paragraph => !knownObserverParagraphs.has(paragraph)).join("\n\n")
  );
  return chatText
    .split(/\n\s*\n/)
    .map(paragraph => paragraph.trim())
    .filter(Boolean)
    .map(paragraph =>
      paragraph
        .replace(zhObserverIntro, "")
        .replace(enObserverIntro, "")
        .replace("觀察者整理涵蓋整桌。", "")
        .replace("Observer notes cover the whole table. ", "")
        .replace(/既有洞見有程式維持的穩定識別碼：[\s\S]*?程式會保留未提及項目。/, "")
        .replace(/Existing insights have stable program IDs:[\s\S]*?the program retains omitted items\./, "")
        .replace(/對談中提出的解方只是可能回應，[\s\S]*$/, "")
        .replace(/A possible response is a discussed answer,[\s\S]*$/, "")
        .trim()
    )
    .filter(Boolean)
    .join("\n\n");
}
export function formatReferenceContext(files: Array<{ name: string; content: string }>): string {
  if (!files.length) return "";
  return `\n\n${CONTEXT_REFERENCE}\n${files.map((file, index) => `\n${renderTemplate(CONTEXT_REFERENCE_FILE, { index: String(index + 1), name: file.name })}\n${file.content}`).join("\n")}`;
}
