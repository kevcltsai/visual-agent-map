import { estimateTokens } from "../../../ai/context-builder";
import { translate, uiLocale, type ContentLanguage } from "../../../i18n";
import { inLanguageNaming } from "../_shared/fragments";
import type { ReasoningLevel } from "../../../ai/types";
import { renderTemplate, type StepDefinition } from "../../step-runner";
import languageEn from "./language.en.md";
import languageZh from "./language.zh.md";
import template from "./prompt.md";

export interface ReframeRequest {
  targetCore: "understand";
  source: string;
  question: string;
  context: string;
  language: ContentLanguage;
  model: string;
  reasoning: ReasoningLevel;
}
export interface ReframeDraft {
  question: string;
  context: string;
  rationale: string;
}
export const REFRAME_TOKEN_BUDGET = 32_000;
export const REFRAME_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    question: { type: "string", minLength: 1 },
    context: { type: "string", minLength: 1 },
    rationale: { type: "string" }
  },
  required: ["question", "context", "rationale"]
};

export function parseReframeDraft(raw: string): ReframeDraft {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid reframing response");
  const item = value as Record<string, unknown>;
  if (
    Object.keys(item).length !== 3 ||
    typeof item.question !== "string" ||
    !item.question.trim() ||
    /[\r\n]/.test(item.question.trim()) ||
    typeof item.context !== "string" ||
    !item.context.trim() ||
    typeof item.rationale !== "string"
  )
    throw new Error("Invalid reframing response");
  return { question: item.question.trim(), context: item.context.trim(), rationale: item.rationale.trim() };
}

/**
 * Reframe a source into one researchable question. The whole request (prompt plus schema) must fit the token budget;
 * nothing is truncated, so an oversized request is refused before any provider work.
 */
export const reframeStep: StepDefinition<ReframeRequest, ReframeDraft> = {
  id: "reframe",
  version: 1,
  render: request =>
    renderTemplate(template, {
      languageInstruction: inLanguageNaming(
        { zh: languageZh, en: languageEn },
        request.language,
        { language: "region" },
        "en",
        { kind: "question", text: request.question }
      ),
      direction: JSON.stringify({ question: request.question, context: request.context }),
      source: JSON.stringify(request.source)
    }),
  schema: REFRAME_SCHEMA,
  policy: (prompt, request) => {
    if (estimateTokens(prompt + JSON.stringify(REFRAME_SCHEMA)) > REFRAME_TOKEN_BUDGET)
      throw new Error(translate(uiLocale(request.language), "error.reframing_over_budget"));
  },
  parse: raw => parseReframeDraft(raw)
};
