import { estimateTokens } from "../../../ai/context-builder";
import type { ReasoningLevel } from "../../../ai/types";
import { languagePromptName, type ContentLanguage } from "../../../i18n";
import { renderTemplate, type StepDefinition } from "../../step-runner";
import mermaidTemplate from "./mermaid-prompt.md";
import template from "./prompt.md";

export const SHARE_TRANSLATE_TOKEN_BUDGET = 32_000;

/** One piece of text to translate; the model echoes `id`. */
export interface ShareTranslateItem {
  id: string;
  text: string;
}
export interface ShareTranslateRequest {
  items: ShareTranslateItem[];
  /** Language of the original text; named in the prompt through its registry `region` form. */
  sourceLanguage: ContentLanguage;
  /** Language to write; one of the six share languages. */
  targetLanguage: ContentLanguage;
  model: string;
  reasoning: ReasoningLevel;
}
export interface ShareTranslateOutput {
  /** Only ids that were asked for, each once; an id the model left out is simply absent. */
  segments: ShareTranslateItem[];
}

export const SHARE_TRANSLATE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    segments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { id: { type: "string", minLength: 1 }, text: { type: "string" } },
        required: ["id", "text"]
      }
    }
  },
  required: ["segments"]
};

/** A reply that cannot be used at all; `code` tells a missing JSON object from a wrong shape. */
export class ShareTranslateParseError extends Error {
  constructor(
    readonly code: "not-json" | "bad-shape",
    message: string
  ) {
    super(message);
    this.name = "ShareTranslateParseError";
  }
}

/** Removes a Markdown code fence some replies wrap around the JSON. */
const unfence = (raw: string): string => {
  const match = /^\s*```(?:json)?\s*\n([\s\S]*?)\n```\s*$/i.exec(raw);
  return match ? match[1] : raw;
};

/**
 * Strict about shape, forgiving about coverage: not JSON or not `{segments:[{id,text}]}` throws a
 * {@link ShareTranslateParseError}; ids that were not asked for and repeated ids are dropped (the first wins);
 * an asked id that is absent stays absent, and the caller retries or keeps the original for it.
 */
export function parseShareTranslation(
  raw: string,
  request: Pick<ShareTranslateRequest, "items">
): ShareTranslateOutput {
  let value: unknown;
  try {
    value = JSON.parse(unfence(raw));
  } catch {
    throw new ShareTranslateParseError("not-json", "The translation reply is not JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ShareTranslateParseError("bad-shape", "The translation reply is not an object");
  const body = value as Record<string, unknown>;
  if (!Array.isArray(body.segments))
    throw new ShareTranslateParseError("bad-shape", "The translation reply has no segments list");
  const asked = new Set(request.items.map(item => item.id));
  const seen = new Set<string>();
  const segments: ShareTranslateItem[] = [];
  for (const entry of body.segments as unknown[]) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw new ShareTranslateParseError("bad-shape", "A translated segment is not an object");
    const item = entry as Record<string, unknown>;
    if (typeof item.id !== "string" || typeof item.text !== "string")
      throw new ShareTranslateParseError("bad-shape", "A translated segment needs a string id and text");
    if (!asked.has(item.id) || seen.has(item.id)) continue;
    seen.add(item.id);
    segments.push({ id: item.id, text: item.text });
  }
  return { segments };
}

const variables = (request: ShareTranslateRequest): Record<string, string> => ({
  sourceLanguage: languagePromptName(request.sourceLanguage, "en", "region"),
  targetLanguage: languagePromptName(request.targetLanguage, "en", "region"),
  segments: JSON.stringify(request.items.map(item => ({ id: item.id, text: item.text })))
});
const policy = (prompt: string): void => {
  if (estimateTokens(prompt + JSON.stringify(SHARE_TRANSLATE_SCHEMA)) > SHARE_TRANSLATE_TOKEN_BUDGET)
    throw new Error("The translation batch is over the token budget");
};

/** Translate note text (with placeholders) and short map fields. */
export const shareTranslateStep: StepDefinition<ShareTranslateRequest, ShareTranslateOutput> = {
  id: "share-translate",
  version: 1,
  render: request => renderTemplate(template, variables(request)),
  schema: SHARE_TRANSLATE_SCHEMA,
  policy,
  parse: (raw, request) => parseShareTranslation(raw, request)
};

/** Translate diagram labels (short, one line, no structural characters). */
export const shareTranslateLabelsStep: StepDefinition<ShareTranslateRequest, ShareTranslateOutput> = {
  id: "share-translate.labels",
  version: 1,
  render: request => renderTemplate(mermaidTemplate, variables(request)),
  schema: SHARE_TRANSLATE_SCHEMA,
  policy,
  parse: (raw, request) => parseShareTranslation(raw, request)
};
