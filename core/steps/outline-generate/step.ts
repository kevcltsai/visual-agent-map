import { estimateTokens } from "../../../ai/context-builder";
import { translate, uiLocale, type ContentLanguage } from "../../../i18n";
import { inLanguage, inLanguageNaming } from "../_shared/fragments";
import type { ReasoningLevel } from "../../../ai/types";
import {
  OUTLINE_NODE_LIMIT,
  parseOutline,
  sanitizeOutlineDraft,
  type OutlineLimits,
  type OutlineNode
} from "../../../experiences/visual-map/outline-import";
import { renderTemplate, type StepDefinition } from "../../step-runner";
import languageEn from "./language.en.md";
import languageZh from "./language.zh.md";
import limitsEn from "./limits.en.md";
import limitsZh from "./limits.zh.md";
import template from "./prompt.md";
import topicLineEn from "./topic-line.en.md";
import topicLineZh from "./topic-line.zh.md";

export interface OutlineGenerateRequest {
  topic: string;
  /** The preset's instruction text; may contain a topic placeholder. */
  presetText: string;
  language: ContentLanguage;
  /** Language of the prompt and model output; defaults to `language`, which stays the interface language for errors. */
  contentLanguage?: ContentLanguage;
  model: string;
  reasoning: ReasoningLevel;
  /** Quick explore's chosen levels and size; they override the preset's own and are enforced after parsing. */
  limits?: OutlineLimits;
}
export interface OutlineGenerateResult {
  /** Heading-only Markdown (fence removed), ready for the outline textarea and `parseOutline`. */
  markdown: string;
  nodes: OutlineNode[];
}
export type OutlineGenerateErrorCode =
  "empty_topic" | "over_budget" | "stopped" | "invalid" | "no_headings" | "non_heading" | "too_many";
/** Typed failure of outline generation; `message` is already localized. */
export class OutlineGenerateError extends Error {
  constructor(
    readonly code: OutlineGenerateErrorCode,
    message: string
  ) {
    super(message);
    this.name = "OutlineGenerateError";
  }
}

/** The topic placeholders a preset may contain (Traditional Chinese and English); the English one is case-insensitive. */
export const OUTLINE_TOPIC_PLACEHOLDERS: readonly string[] = ["{填入研究主題}", "{research topic}"];
export const OUTLINE_GENERATE_TOKEN_BUDGET = 32_000;
const PLACEHOLDER_PATTERN = new RegExp(
  OUTLINE_TOPIC_PLACEHOLDERS.map(item => item.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
  "gi"
);

/**
 * Put the topic into the preset. Every placeholder is replaced by the topic as a JSON string, so the model sees it
 * as quoted data; a preset without a placeholder gets a labelled topic line appended.
 */
export function applyTopicToPreset(presetText: string, topic: string, language: ContentLanguage): string {
  const quoted = JSON.stringify(topic.trim());
  PLACEHOLDER_PATTERN.lastIndex = 0;
  if (PLACEHOLDER_PATTERN.test(presetText)) return presetText.replace(PLACEHOLDER_PATTERN, () => quoted);
  const line = renderTemplate(inLanguage({ zh: topicLineZh, en: topicLineEn }, language), { topic: quoted });
  return `${presetText.trimEnd()}\n\n${line}`;
}

const WRAPPING_FENCE = /^(`{3,}|~{3,})[ \t]*[\w-]*[ \t]*\n([\s\S]*?)\n[ \t]*\1[`~]*[ \t]*$/;
/** Remove one fence that wraps the whole reply; anything else is left for the parser to judge. */
export function stripWrappingFence(raw: string): string {
  const text = (raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw).replace(/\r\n?/g, "\n").trim();
  const match = WRAPPING_FENCE.exec(text);
  return match ? match[2] : text;
}

/**
 * Accept only heading-only Markdown: wrapping fence removed, headings cleaned with `sanitizeOutlineDraft`, then `parseOutline` (not relaxed). Anything the
 * parser reports as an error, any non-heading line, comment, fenced block or front matter, no heading at all, or
 * more than the 100-heading limit rejects the whole reply.
 */
export function parseOutlineReply(raw: string, language: ContentLanguage): OutlineGenerateResult {
  const locale = uiLocale(language);
  // A heading title that would break a note (unpaired [[ ]], an escaped fence) is cleaned here, as the outline box does,
  // so one such heading does not fail the whole AI reply; the user's own pasted outline still goes through the strict parser.
  const text = sanitizeOutlineDraft(stripWrappingFence(raw));
  const parsed = parseOutline(text);
  if (parsed.nodes.length > OUTLINE_NODE_LIMIT)
    throw new OutlineGenerateError(
      "too_many",
      translate(locale, "error.outline_generate_too_many", parsed.nodes.length, OUTLINE_NODE_LIMIT)
    );
  if (!parsed.nodes.length && parsed.headingLines === 0)
    throw new OutlineGenerateError("no_headings", translate(locale, "error.outline_generate_no_headings"));
  const first = parsed.errors[0];
  if (first)
    throw new OutlineGenerateError(
      "invalid",
      translate(locale, "error.outline_generate_invalid", translate(locale, first.key, ...first.values))
    );
  if (parsed.ignoredLines || parsed.skippedLines)
    throw new OutlineGenerateError(
      "non_heading",
      translate(locale, "error.outline_generate_non_heading", parsed.ignoredLines + parsed.skippedLines)
    );
  return { markdown: `${text}\n`, nodes: parsed.nodes };
}

/**
 * Generate a heading-only outline from a topic and a preset. The whole request must fit the token budget; nothing is
 * truncated. Plain text reply (no response schema).
 */
export const outlineGenerateStep: StepDefinition<OutlineGenerateRequest, OutlineGenerateResult> = {
  id: "outline-generate",
  version: 1,
  render: request => {
    const content = request.contentLanguage ?? request.language;
    return renderTemplate(template, {
      languageInstruction: inLanguageNaming({ zh: languageZh, en: languageEn }, content, { language: "region" }, "en", {
        kind: "topic",
        text: request.topic
      }),
      preset: request.limits
        ? `${applyTopicToPreset(request.presetText, request.topic, content)}\n\n${renderTemplate(
            inLanguage({ zh: limitsZh, en: limitsEn }, content),
            { levels: String(request.limits.levels), maxTopics: String(request.limits.maxTopics) }
          )}`
        : applyTopicToPreset(request.presetText, request.topic, content)
    });
  },
  policy: (prompt, request) => {
    const locale = uiLocale(request.language);
    if (!request.topic.trim())
      throw new OutlineGenerateError("empty_topic", translate(locale, "error.outline_generate_empty_topic"));
    if (estimateTokens(prompt) > OUTLINE_GENERATE_TOKEN_BUDGET)
      throw new OutlineGenerateError("over_budget", translate(locale, "error.outline_generate_over_budget"));
  },
  parse: (raw, request) => parseOutlineReply(raw, request.language)
};
