import { estimateTokens } from "../../../ai/context-builder";
import { translate, uiLocale, type ContentLanguage } from "../../../i18n";
import { providerForModel } from "../../../ai/providers/provider";
import type { ReasoningLevel } from "../../../ai/types";
import type { RelevanceTier } from "../../../note-values";
import {
  relevancePinBounds,
  type PinConflict,
  type RelevancePin
} from "../../../experiences/visual-map/relevance-pins";
import { positionIds } from "../../short-ids";
import { renderTemplate, type StepDefinition } from "../../step-runner";
import { sanitizeGeneratedTitle } from "../../title-safety";
import { inLanguageNaming } from "../_shared/fragments";
import type { StructureNode } from "../structure-review/step";
import template from "./prompt.md";
import pinsTemplate from "./pins.md";
import scopeAll from "./scope-all.md";
import scopeCurrent from "./scope-current.md";
import toolsClaude from "./tools.claude.md";
import toolsCodex from "./tools.codex.md";
import outputClaude from "./output.claude.md";
import outputCodex from "./output.codex.md";
import languageEn from "./language.en.md";
import languageZh from "./language.zh.md";

export type { PinConflict, RelevancePin };
export const GOAL_RECOMMEND_TIERS: readonly RelevanceTier[] = ["core", "support", "side"];
export const GOAL_RECOMMEND_TOKEN_BUDGET = 32_000;
export const GOAL_RECOMMEND_MAX_SUGGESTIONS = 8;
export const GOAL_RECOMMEND_TITLE_LIMIT = 200;

/** `all`: rate every card from scratch (no earlier tier is sent). `current`: send the current tiers; the reply is only what changes. */
export type GoalRecommendScope = "all" | "current";

export interface GoalRecommendRequest {
  /** Trusted: the map file this request belongs to, for token-usage accounting only; never serialized into a prompt. */
  usageMapPath?: string;
  /** What the learner wants to achieve; sent as a JSON string and treated as untrusted data. */
  goal: string;
  /** One line of the learner's conditions or what they already know; sent as a JSON string, or `null`. Untrusted data. */
  context?: string;
  /** The whole map, parent before child. Cards whose `parentId` is null are context only and are never rated. */
  nodes: StructureNode[];
  /** The interface language, used for error messages. */
  language: ContentLanguage;
  /** Language of the new cards' titles and summaries (`outputLanguageForMap`); defaults to `language`. */
  contentLanguage?: ContentLanguage;
  model: string;
  reasoning: ReasoningLevel;
  /** Cards the learner set by hand. Their tier is final: never rated, but evidence for the cards around them. */
  pins?: RelevancePin[];
  /** Real ids of locked cards. Final like pins: shown to the model as `locked`, never asked for, never written. */
  lockedIds?: string[];
  scope: GoalRecommendScope;
  /** Scope `current` only: the current AI tier of each rated card (real ids). Cards without an entry must be rated. */
  current?: RelevancePin[];
}
export interface GoalRecommendItem {
  id: string;
  tier: RelevanceTier;
  /** The pinned card this tier follows from, when the AI named one that really is pinned. */
  anchor?: string;
}
/** One new card proposed for the map; `parentId` is the REAL id of an existing card. */
export interface GoalRecommendSuggestion {
  parentId: string;
  title: string;
  /** One sentence shown in the list only; never written to the card. */
  summary: string;
  suggestedTier: "core" | "support";
}
export type GoalRecommendDropCode =
  "unknown_parent" | "empty_title" | "title_too_long" | "duplicate_title" | "empty_summary" | "side_tier";
export interface GoalRecommendDrop {
  index: number;
  code: GoalRecommendDropCode;
}
export interface GoalRecommendResult {
  items: GoalRecommendItem[];
  suggestions: GoalRecommendSuggestion[];
  /** Well-formed suggestions that could not be used; never applied, only counted. */
  dropped: GoalRecommendDrop[];
  /** Entries for pinned or locked cards the AI sent anyway (ignored). */
  pinnedIgnored?: number;
  /** Anchors that were not a pinned card (treated as none). */
  anchorsDropped?: number;
  /** Scope `current`: entries whose tier equalled the current one (ignored). */
  unchangedIgnored?: number;
  /** Pinned cards ranked above a pinned ancestor, for the summary. */
  conflicts?: PinConflict[];
}
export class GoalRecommendError extends Error {
  constructor(
    readonly code: "empty" | "over_budget" | "stopped" | "invalid" | "too_many",
    message: string,
    /** Technical detail (may contain card ids) for logs; never shown to the user. */
    readonly detail?: string
  ) {
    super(message);
    this.name = "GoalRecommendError";
  }
}

export const GOAL_RECOMMEND_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", minLength: 1 },
          tier: { type: "string", enum: [...GOAL_RECOMMEND_TIERS] },
          anchor: { type: ["string", "null"] }
        },
        // Codex runs the schema in strict mode: every property must be listed, so `anchor` is required and nullable.
        // The parser still accepts an item that leaves it out (Claude does not enforce strictness).
        required: ["id", "tier", "anchor"]
      }
    },
    suggestions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          parentId: { type: "string", minLength: 1 },
          title: { type: "string", minLength: 1 },
          summary: { type: "string", minLength: 1 },
          // Named `suggestedTier`, not `tier`, so a stream counter that counts `"tier"` never counts a new card.
          suggestedTier: { type: "string", enum: ["core", "support"] }
        },
        required: ["parentId", "title", "summary", "suggestedTier"]
      }
    }
  },
  required: ["items", "suggestions"]
};

const invalid = (locale: ContentLanguage, detail: string): GoalRecommendError =>
  new GoalRecommendError("invalid", translate(locale, "error.goal_recommend_invalid", detail), detail);

/** Titles compare equal when they differ only in case or whitespace. */
export const goalRecommendTitleKey = (title: string): string => title.replace(/\s+/g, " ").trim().toLowerCase();

/** The cards that get a tier: everything except top-level cards, which are only context. */
export const recommendGradableNodes = (nodes: ReadonlyArray<StructureNode>): StructureNode[] =>
  nodes.filter(node => node.parentId !== null);

/** The pins that name a gradable card of this map, in map order, one per card (the last entry for a card wins). */
export function recommendPins(
  tree: ReadonlyArray<StructureNode>,
  pins: ReadonlyArray<RelevancePin> | undefined
): RelevancePin[] {
  if (!pins?.length) return [];
  const tier = new Map<string, RelevanceTier>();
  const gradable = new Set(recommendGradableNodes(tree).map(node => node.id));
  for (const pin of pins) if (gradable.has(pin.id)) tier.set(pin.id, pin.tier);
  return tree
    .filter(node => tier.has(node.id))
    .map(node => ({ id: node.id, tier: tier.get(node.id) as RelevanceTier }));
}

/** The locked gradable cards of this map. */
const lockedSet = (request: GoalRecommendRequest): Set<string> => {
  const gradable = new Set(recommendGradableNodes(request.nodes).map(node => node.id));
  return new Set((request.lockedIds ?? []).filter(id => gradable.has(id)));
};
/** Cards whose tier the AI must not decide: hand-set pins and locked cards. */
const frozenSet = (request: GoalRecommendRequest): Set<string> =>
  new Set([...recommendPins(request.nodes, request.pins).map(pin => pin.id), ...lockedSet(request)]);

/** The current AI tiers that count: gradable cards that are not frozen (scope `current` only). */
const currentTiers = (request: GoalRecommendRequest): Map<string, RelevanceTier> => {
  if (request.scope !== "current") return new Map();
  const frozen = frozenSet(request);
  const gradable = new Set(recommendGradableNodes(request.nodes).map(node => node.id));
  return new Map(
    (request.current ?? [])
      .filter(entry => gradable.has(entry.id) && !frozen.has(entry.id))
      .map(entry => [entry.id, entry.tier])
  );
};

/** Cards the reply must contain: every gradable card that is not frozen (scope `current`: only those without a tier). */
export const goalRecommendRequired = (request: GoalRecommendRequest): StructureNode[] => {
  const frozen = frozenSet(request);
  const current = currentTiers(request);
  return recommendGradableNodes(request.nodes).filter(
    node => !frozen.has(node.id) && (request.scope === "all" || !current.has(node.id))
  );
};

/**
 * Strict parser. The WHOLE reply is refused (`GoalRecommendError`, nothing written, no retry) when it is not JSON; is not
 * exactly `{"items": [...], "suggestions": [...]}`; has an item that is not an object with `id` and `tier` (and
 * optionally `anchor`, a string or null); has a tier other than core, support or side; repeats an id; names an id that
 * is not on the map or belongs to a top-level card; leaves out a card it must contain (scope `all`: every card that is
 * not pinned or locked; scope `current`: every such card without a current tier); has a suggestion that is not an
 * object with exactly string `parentId`, `title`, `summary` and `suggestedTier` (core, support or side); or has more
 * than {@link GOAL_RECOMMEND_MAX_SUGGESTIONS} suggestions.
 * Allowed but not used, and counted: an item for a pinned or locked card (`pinnedIgnored`), an item whose tier equals
 * the current one in scope `current` (`unchangedIgnored`), an `anchor` that is not a pinned card (`anchorsDropped`).
 * A suggestion that cannot be used is dropped alone and listed in `dropped`: unknown parent, empty or long title, a
 * repeated title, an empty summary, or `suggestedTier` side.
 * An empty `items` is valid. Nothing is coerced or truncated. Short ids are turned back into real ids here.
 */
export function parseGoalRecommend(raw: string, request: GoalRecommendRequest): GoalRecommendResult {
  const tree = request.nodes;
  const locale = uiLocale(request.language);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw invalid(locale, "JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid(locale, "object");
  const body = value as Record<string, unknown>;
  const bodyKeys = Object.keys(body);
  if (bodyKeys.length !== 2 || !Array.isArray(body.items) || !Array.isArray(body.suggestions))
    throw invalid(locale, "items/suggestions");
  if (body.suggestions.length > GOAL_RECOMMEND_MAX_SUGGESTIONS)
    throw new GoalRecommendError(
      "too_many",
      translate(locale, "error.goal_recommend_too_many", body.suggestions.length, GOAL_RECOMMEND_MAX_SUGGESTIONS),
      `suggestions ${body.suggestions.length}`
    );
  const ids = positionIds(tree.map(node => node.id));
  const gradable = new Map(recommendGradableNodes(tree).map(node => [node.id, node]));
  const pins = recommendPins(tree, request.pins);
  const pinned = new Set(pins.map(pin => pin.id));
  const frozen = frozenSet(request);
  const current = currentTiers(request);
  const seen = new Set<string>();
  const items: GoalRecommendItem[] = [];
  let pinnedIgnored = 0;
  let anchorsDropped = 0;
  let unchangedIgnored = 0;
  body.items.forEach((entry: unknown, index: number) => {
    const where = `#${index + 1}`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw invalid(locale, where);
    const item = entry as Record<string, unknown>;
    const keys = Object.keys(item);
    const withAnchor = keys.includes("anchor");
    if (keys.length !== (withAnchor ? 3 : 2) || !["id", "tier"].every(key => keys.includes(key)))
      throw invalid(locale, `${where} keys`);
    const { id: label, tier, anchor } = item;
    if (typeof label !== "string" || !label) throw invalid(locale, `${where} id`);
    if (typeof tier !== "string" || !(GOAL_RECOMMEND_TIERS as readonly string[]).includes(tier))
      throw invalid(locale, `${where} tier`);
    if (withAnchor && anchor !== null && typeof anchor !== "string") throw invalid(locale, `${where} anchor`);
    const id = ids.real(label);
    if (id === undefined) throw invalid(locale, `${where} id ${label}`);
    if (!gradable.has(id)) throw invalid(locale, `${where} top-level ${id}`);
    if (seen.has(id)) throw invalid(locale, `${where} duplicate ${id}`);
    seen.add(id);
    if (frozen.has(id)) {
      pinnedIgnored++;
      return;
    }
    const anchorId = typeof anchor === "string" ? ids.real(anchor) : undefined;
    const anchored = anchorId !== undefined && pinned.has(anchorId);
    if (typeof anchor === "string" && !anchored) anchorsDropped++;
    if (request.scope === "current" && current.get(id) === tier) {
      unchangedIgnored++;
      return;
    }
    items.push({ id, tier: tier as RelevanceTier, ...(anchored ? { anchor: anchorId } : {}) });
  });
  const missing = goalRecommendRequired(request)
    .map(node => node.id)
    .filter(id => !seen.has(id));
  if (missing.length)
    throw invalid(
      locale,
      `missing ${missing.length}: ${missing.slice(0, 3).join(", ")}${pinnedIgnored ? ` (pinnedIgnored ${pinnedIgnored})` : ""}`
    );
  const taken = new Set(tree.map(node => goalRecommendTitleKey(node.title)));
  const suggestions: GoalRecommendSuggestion[] = [];
  const dropped: GoalRecommendDrop[] = [];
  body.suggestions.forEach((entry: unknown, index: number) => {
    const where = `suggestion #${index + 1}`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw invalid(locale, where);
    const suggestion = entry as Record<string, unknown>;
    const keys = Object.keys(suggestion);
    if (keys.length !== 4 || !["parentId", "title", "summary", "suggestedTier"].every(key => keys.includes(key)))
      throw invalid(locale, `${where} keys`);
    if (typeof suggestion.parentId !== "string") throw invalid(locale, `${where} parentId`);
    if (typeof suggestion.title !== "string") throw invalid(locale, `${where} title`);
    if (typeof suggestion.summary !== "string") throw invalid(locale, `${where} summary`);
    const suggestedTier = suggestion.suggestedTier;
    if (typeof suggestedTier !== "string" || !(GOAL_RECOMMEND_TIERS as readonly string[]).includes(suggestedTier))
      throw invalid(locale, `${where} suggestedTier`);
    const drop = (code: GoalRecommendDropCode): void => {
      dropped.push({ index, code });
    };
    const parentId = ids.real(suggestion.parentId.trim());
    if (parentId === undefined) return drop("unknown_parent");
    const title = suggestion.title.trim();
    if (!title) return drop("empty_title");
    if ([...title].length > GOAL_RECOMMEND_TITLE_LIMIT || /[\r\n]/.test(title)) return drop("title_too_long");
    const key = goalRecommendTitleKey(title);
    if (taken.has(key)) return drop("duplicate_title");
    const summary = sanitizeGeneratedTitle(suggestion.summary.replace(/\s+/g, " ").trim()).trim();
    if (!summary) return drop("empty_summary");
    // A "side" card is not worth adding: drop only this one, keep the rest of the reply.
    if (suggestedTier === "side") return drop("side_tier");
    taken.add(key);
    suggestions.push({ parentId, title, summary, suggestedTier: suggestedTier as "core" | "support" });
  });
  const conflicts = relevancePinBounds(tree, pins).conflicts;
  return {
    items,
    suggestions,
    dropped,
    ...(pinnedIgnored ? { pinnedIgnored } : {}),
    ...(anchorsDropped ? { anchorsDropped } : {}),
    ...(unchangedIgnored ? { unchangedIgnored } : {}),
    ...(conflicts.length ? { conflicts } : {})
  };
}

const trimmed = (text: string): string => text.replace(/\n$/, "");

/**
 * The cards as the model sees them: position ids (c1..cN in map order) for `id` and `parentId`, no UUIDs. A pinned card
 * carries `pinned` (its tier), a locked card `locked: true`. Scope `current` adds `tier` (null when none yet) to every
 * card below the top level; scope `all` sends no earlier AI tier at all.
 */
const promptCards = (request: GoalRecommendRequest) => {
  const ids = positionIds(request.nodes.map(node => node.id));
  const label = (id: string): string => ids.short(id) ?? id;
  const pins = new Map(recommendPins(request.nodes, request.pins).map(pin => [pin.id, pin.tier]));
  const locked = lockedSet(request);
  const tiers = currentTiers(request);
  return request.nodes.map(node => ({
    id: label(node.id),
    title: node.title,
    summary: node.summary,
    parentId: node.parentId === null ? null : label(node.parentId),
    depth: node.depth,
    ...(request.scope === "current" && node.parentId !== null
      ? { tier: pins.get(node.id) ?? tiers.get(node.id) ?? null }
      : {}),
    ...(pins.has(node.id) ? { pinned: pins.get(node.id) } : {}),
    ...(locked.has(node.id) ? { locked: true } : {})
  }));
};

const recommendPrompt = (request: GoalRecommendRequest): string => {
  const claude = providerForModel(request.model) === "claude";
  const ids = positionIds(request.nodes.map(node => node.id));
  const pins = recommendPins(request.nodes, request.pins);
  return renderTemplate(template, {
    goal: JSON.stringify(request.goal),
    context: JSON.stringify(request.context?.trim() ? request.context : null),
    scopeSection: trimmed(request.scope === "current" ? scopeCurrent : scopeAll),
    pinsSection: pins.length
      ? `${renderTemplate(pinsTemplate, {
          pins: JSON.stringify(pins.map(pin => ({ id: ids.short(pin.id) ?? pin.id, tier: pin.tier })))
        })}\n`
      : "",
    limit: String(GOAL_RECOMMEND_MAX_SUGGESTIONS),
    languageInstruction: inLanguageNaming(
      { zh: languageZh, en: languageEn },
      request.contentLanguage ?? request.language,
      { language: "region" },
      "en",
      { kind: "topic", text: request.goal }
    ),
    toolLine: trimmed(claude ? toolsClaude : toolsCodex),
    outputLine: trimmed(claude ? outputClaude : outputCodex),
    nodes: JSON.stringify(promptCards(request))
  });
};

/**
 * Recommend for a learner goal in ONE call: a tier for the existing cards and new cards the map is missing. Input is
 * titles, summaries and structure; the reply is strict JSON. Refused before any call only when the map or goal is empty
 * or the prompt is over budget; a map with only a top-level card or only pinned cards is still asked (for new cards).
 */
export const goalRecommendStep: StepDefinition<GoalRecommendRequest, GoalRecommendResult> = {
  id: "goal-recommend",
  version: 1,
  render: recommendPrompt,
  schema: GOAL_RECOMMEND_SCHEMA,
  policy: (prompt, request) => {
    const locale = uiLocale(request.language);
    if (!request.nodes.length || !request.goal.trim())
      throw new GoalRecommendError("empty", translate(locale, "error.goal_recommend_empty"));
    if (estimateTokens(prompt + JSON.stringify(GOAL_RECOMMEND_SCHEMA)) > GOAL_RECOMMEND_TOKEN_BUDGET)
      throw new GoalRecommendError("over_budget", translate(locale, "error.goal_recommend_over_budget"));
  },
  parse: (raw, request) => parseGoalRecommend(raw, request)
};
