import { estimateTokens } from "../../../ai/context-builder";
import { translate, uiLocale, type ContentLanguage } from "../../../i18n";
import type { ReasoningLevel } from "../../../ai/types";
import { positionIds } from "../../short-ids";
import { renderTemplate, type StepDefinition } from "../../step-runner";
import { inLanguageNaming } from "../_shared/fragments";
import type { StructureNode } from "../structure-review/step";
import languageEn from "./language.en.md";
import languageZh from "./language.zh.md";
import template from "./prompt.md";

export const GOAL_TOPIC_SUGGEST_MAX_SUGGESTIONS = 8;
export const GOAL_TOPIC_SUGGEST_TOKEN_BUDGET = 32_000;
export const GOAL_TOPIC_TITLE_LIMIT = 200;

export interface GoalTopicSuggestRequest {
  /** Trusted: the map file this request belongs to, for token-usage accounting only; never serialized into a prompt. */
  usageMapPath?: string;
  /** What the learner wants to achieve; sent as a JSON string and treated as untrusted data. */
  goal: string;
  /** The learner's 補充 (conditions or what they already know); sent as a JSON string or `null`. Untrusted data. */
  context?: string;
  /** The whole map, parent before child (see `buildStructureReviewNodes`). */
  nodes: StructureNode[];
  /** The interface language, used for error messages. */
  language: ContentLanguage;
  /** Language of the prompt and model output (`outputLanguageForMap`); defaults to `language`. */
  contentLanguage?: ContentLanguage;
  model: string;
  reasoning: ReasoningLevel;
}
/** One new card proposed for the map; `parentId` is the REAL id of an existing card. */
export interface GoalTopicSuggestion {
  parentId: string;
  title: string;
}
export type GoalTopicDropCode = "unknown_parent" | "empty_title" | "title_too_long" | "duplicate_title";
export interface GoalTopicDrop {
  index: number;
  code: GoalTopicDropCode;
}
export interface GoalTopicSuggestResult {
  suggestions: GoalTopicSuggestion[];
  /** Well-formed entries that could not be used (unknown parent, bad or repeated title); never applied, only counted. */
  dropped: GoalTopicDrop[];
}
export class GoalTopicSuggestError extends Error {
  constructor(
    readonly code: "empty" | "over_budget" | "stopped" | "invalid" | "too_many",
    message: string
  ) {
    super(message);
    this.name = "GoalTopicSuggestError";
  }
}

export const GOAL_TOPIC_SUGGEST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    suggestions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          parentId: { type: "string", minLength: 1 },
          title: { type: "string", minLength: 1 }
        },
        required: ["parentId", "title"]
      }
    }
  },
  required: ["suggestions"]
};

const invalid = (locale: ContentLanguage, detail: string): GoalTopicSuggestError =>
  new GoalTopicSuggestError("invalid", translate(locale, "error.goal_topic_suggest_invalid", detail));

/** Titles compare equal when they differ only in case or whitespace. */
export const goalTopicTitleKey = (title: string): string => title.replace(/\s+/g, " ").trim().toLowerCase();

/** The cards as the model sees them: position ids (c1..cN in map order) for `id` and `parentId`, no UUIDs. */
const promptCards = (nodes: ReadonlyArray<StructureNode>) => {
  const ids = positionIds(nodes.map(node => node.id));
  const label = (id: string): string => ids.short(id) ?? id;
  return nodes.map(node => ({
    id: label(node.id),
    title: node.title,
    summary: node.summary,
    parentId: node.parentId === null ? null : label(node.parentId),
    depth: node.depth
  }));
};

/**
 * Strict parser. Contract:
 * - A malformed reply rejects the WHOLE response with `GoalTopicSuggestError`: not JSON, not an object with only a
 *   `suggestions` array, an item that is not an object with exactly string `parentId` and `title`, or more than
 *   {@link GOAL_TOPIC_SUGGEST_MAX_SUGGESTIONS} suggestions. Nothing is coerced or truncated.
 * - A well-formed suggestion that cannot be used is dropped individually and reported in `dropped`: a `parentId` that is
 *   not a short id of the supplied cards (a real id included), an empty title, a title longer than
 *   {@link GOAL_TOPIC_TITLE_LIMIT}, or a title equal (case and whitespace insensitive) to any existing card or to an
 *   earlier suggestion.
 * Short ids are turned back into real ids here.
 */
export function parseGoalTopicSuggest(
  raw: string,
  tree: ReadonlyArray<StructureNode>,
  language: ContentLanguage = "en"
): GoalTopicSuggestResult {
  const locale = uiLocale(language);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw invalid(locale, "JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid(locale, "object");
  const body = value as Record<string, unknown>;
  if (Object.keys(body).length !== 1 || !Array.isArray(body.suggestions)) throw invalid(locale, "suggestions");
  if (body.suggestions.length > GOAL_TOPIC_SUGGEST_MAX_SUGGESTIONS)
    throw new GoalTopicSuggestError(
      "too_many",
      translate(
        locale,
        "error.goal_topic_suggest_too_many",
        body.suggestions.length,
        GOAL_TOPIC_SUGGEST_MAX_SUGGESTIONS
      )
    );
  const ids = positionIds(tree.map(node => node.id));
  const taken = new Set(tree.map(node => goalTopicTitleKey(node.title)));
  const suggestions: GoalTopicSuggestion[] = [];
  const dropped: GoalTopicDrop[] = [];
  body.suggestions.forEach((entry: unknown, index: number) => {
    const where = `#${index + 1}`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw invalid(locale, where);
    const item = entry as Record<string, unknown>;
    const keys = Object.keys(item);
    if (keys.length !== 2 || !["parentId", "title"].every(key => keys.includes(key)))
      throw invalid(locale, `${where} keys`);
    if (typeof item.parentId !== "string") throw invalid(locale, `${where} parentId`);
    if (typeof item.title !== "string") throw invalid(locale, `${where} title`);
    const drop = (code: GoalTopicDropCode): void => {
      dropped.push({ index, code });
    };
    const parentId = ids.real(item.parentId.trim());
    if (parentId === undefined) return drop("unknown_parent");
    const title = item.title.trim();
    if (!title) return drop("empty_title");
    if ([...title].length > GOAL_TOPIC_TITLE_LIMIT || /[\r\n]/.test(title)) return drop("title_too_long");
    const key = goalTopicTitleKey(title);
    if (taken.has(key)) return drop("duplicate_title");
    taken.add(key);
    suggestions.push({ parentId, title });
  });
  return { suggestions, dropped };
}

/** Suggest missing topics for a learner goal. Input is titles, summaries and structure only; the reply is strict JSON. */
export const goalTopicSuggestStep: StepDefinition<GoalTopicSuggestRequest, GoalTopicSuggestResult> = {
  id: "goal-topic-suggest",
  version: 1,
  render: request =>
    renderTemplate(template, {
      languageInstruction: inLanguageNaming(
        { zh: languageZh, en: languageEn },
        request.contentLanguage ?? request.language,
        { language: "region" },
        "en",
        { kind: "topic", text: request.goal }
      ),
      limit: String(GOAL_TOPIC_SUGGEST_MAX_SUGGESTIONS),
      goal: JSON.stringify(request.goal),
      context: JSON.stringify(request.context?.trim() ? request.context : null),
      nodes: JSON.stringify(promptCards(request.nodes))
    }),
  schema: GOAL_TOPIC_SUGGEST_SCHEMA,
  policy: (prompt, request) => {
    const locale = uiLocale(request.language);
    if (!request.nodes.length || !request.goal.trim())
      throw new GoalTopicSuggestError("empty", translate(locale, "error.goal_topic_suggest_empty"));
    if (estimateTokens(prompt + JSON.stringify(GOAL_TOPIC_SUGGEST_SCHEMA)) > GOAL_TOPIC_SUGGEST_TOKEN_BUDGET)
      throw new GoalTopicSuggestError("over_budget", translate(locale, "error.goal_topic_suggest_over_budget"));
  },
  parse: (raw, request) => parseGoalTopicSuggest(raw, request.nodes, request.language)
};
