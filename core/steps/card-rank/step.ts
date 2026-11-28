import { estimateTokens } from "../../../ai/context-builder";
import type { ReasoningLevel } from "../../../ai/types";
import type { ContentLanguage } from "../../../i18n";
import { inLanguageNaming } from "../_shared/fragments";
import { renderTemplate, type StepDefinition } from "../../step-runner";
import languageEn from "./language.en.md";
import languageZh from "./language.zh.md";
import template from "./prompt.md";

/** How many ids a ranking may return: the number of cards the chat takes. */
export const CARD_RANK_LIMIT = 5;
/** Most cards one ranking looks at, and the characters of one excerpt and of the message that go with them. */
export const CARD_RANK_MAX_CARDS = 20;
export const CARD_RANK_EXCERPT_CHARS = 300;
export const CARD_RANK_MESSAGE_CHARS = 1000;
export const CARD_RANK_TOKEN_BUDGET = 8_000;

export interface CardRankCandidate {
  id: string;
  title: string;
  excerpt: string;
}
export interface CardRankRequest {
  /** Trusted: the map file this request belongs to, for token-usage accounting only; never serialized into a prompt. */
  usageMapPath?: string;
  message: string;
  cards: CardRankCandidate[];
  language: ContentLanguage;
  contentLanguage?: ContentLanguage;
  model: string;
  reasoning: ReasoningLevel;
}

export const CARD_RANK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { ranked: { type: "array", items: { type: "string" } } },
  required: ["ranked"]
};

const clip = (value: string, limit: number): string => {
  const text = value.replace(/\s+/g, " ").trim();
  const characters = [...text];
  return characters.length > limit ? `${characters.slice(0, limit - 1).join("")}…` : text;
};

/** The ids of a reply, in its order: only ids that were offered, none twice. A reply that is not `{ranked: string[]}` or names no offered id is refused. */
export function parseCardRank(raw: string, offered: readonly string[]): string[] {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("The reply is not JSON");
  }
  const ranked = (value as { ranked?: unknown } | null)?.ranked;
  if (!Array.isArray(ranked) || ranked.some(id => typeof id !== "string")) throw new Error("The reply has no ranking");
  const known = new Set(offered);
  const ids = [...new Set(ranked as string[])].filter(id => known.has(id));
  if (!ids.length) throw new Error("The reply names no candidate");
  return ids.slice(0, CARD_RANK_LIMIT);
}

/** Rank found cards by meaning: titles and short excerpts only, read-only and untrusted; the reply is strict JSON. */
export const cardRankStep: StepDefinition<CardRankRequest, string[]> = {
  id: "card-rank",
  version: 1,
  render: request =>
    renderTemplate(template, {
      languageInstruction: inLanguageNaming(
        { zh: languageZh, en: languageEn },
        request.contentLanguage ?? request.language,
        { language: "region" },
        "en",
        { kind: "question", text: request.message }
      ),
      limit: String(CARD_RANK_LIMIT),
      message: JSON.stringify(clip(request.message, CARD_RANK_MESSAGE_CHARS)),
      cards: JSON.stringify(
        request.cards.slice(0, CARD_RANK_MAX_CARDS).map(card => ({
          id: card.id,
          title: clip(card.title, 200),
          excerpt: clip(card.excerpt, CARD_RANK_EXCERPT_CHARS)
        }))
      )
    }),
  schema: CARD_RANK_SCHEMA,
  policy: (prompt, request) => {
    if (!request.cards.length) throw new Error("No cards to rank");
    if (estimateTokens(prompt + JSON.stringify(CARD_RANK_SCHEMA)) > CARD_RANK_TOKEN_BUDGET)
      throw new Error("Card ranking request is over budget");
  },
  parse: (raw, request) =>
    parseCardRank(
      raw,
      request.cards.map(card => card.id)
    )
};
