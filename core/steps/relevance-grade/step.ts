import { estimateTokens } from "../../../ai/context-builder";
import { translate, uiLocale, type ContentLanguage } from "../../../i18n";
import { providerForModel } from "../../../ai/providers/provider";
import type { ReasoningLevel } from "../../../ai/types";
import type { RelevanceLevel, RelevanceTier } from "../../../note-values";
import {
  mergeRelevanceTiers,
  relevanceMergedViolations,
  relevancePinBounds,
  TIER_RANK,
  type PinBound,
  type RelevancePin,
  type PinConflict,
  type TierViolation
} from "../../../experiences/visual-map/relevance-pins";
import { positionIds } from "../../short-ids";
import { renderTemplate, type StepDefinition } from "../../step-runner";
import type { StructureNode } from "../structure-review/step";
import template from "./prompt.md";
import pinsTemplate from "./pins.md";
import repairPinsNote from "./repair-pins.md";
import repairMissingTemplate from "./repair-missing.md";
import repairTemplate from "./repair.md";
import toolsClaude from "./tools.claude.md";
import toolsCodex from "./tools.codex.md";
import outputGradeClaude from "./output-grade.claude.md";
import outputGradeCodex from "./output-grade.codex.md";
import outputRepairClaude from "./output-repair.claude.md";
import outputRepairCodex from "./output-repair.codex.md";
import outputRepairMissingClaude from "./output-repair-missing.claude.md";
import outputRepairMissingCodex from "./output-repair-missing.codex.md";

export type { PinConflict, RelevancePin };
export const RELEVANCE_TIERS: readonly RelevanceTier[] = ["core", "support", "side"];
export const RELEVANCE_GRADE_TOKEN_BUDGET = 32_000;
export const RELEVANCE_GOAL_MAX_LENGTH = 200;

export interface RelevanceGradeRequest {
  /** What the learner wants to achieve; sent as a JSON string and treated as untrusted data. */
  goal: string;
  /** How much the learner already knows; sent as a JSON string, or `null` when not given. Untrusted data. */
  level?: RelevanceLevel;
  /** One line of the learner's conditions or what they already know; sent as a JSON string, or `null`. Untrusted data. */
  context?: string;
  /** The whole map, parent before child. Cards whose `parentId` is null are context only and are never graded. */
  nodes: StructureNode[];
  /** The interface language, used for error messages. The prompt itself has no language instruction. */
  language: ContentLanguage;
  model: string;
  reasoning: ReasoningLevel;
  /** Cards the learner set by hand. Their tier is final: the AI never grades them, but they steer the cards around them. */
  pins?: RelevancePin[];
}
export interface RelevanceGradeItem {
  id: string;
  tier: RelevanceTier;
  /** The pinned card this tier follows from, when the AI named one that really is pinned. */
  anchor?: string;
}
export interface RelevanceGradeResult {
  items: RelevanceGradeItem[];
  /** Entries for pinned cards the AI sent anyway (ignored). */
  pinnedIgnored?: number;
  /** Anchors that were not a pinned card (treated as none). */
  anchorsDropped?: number;
  /** Recalibration entries whose tier equalled the current one (ignored). */
  unchangedIgnored?: number;
  /** Pinned cards ranked above a pinned ancestor; the edges between them were exempt from the parent-child rule. */
  conflicts?: PinConflict[];
}
/** One card graded above its parent (core > support > side). */
export type RelevanceHierarchyViolation = TierViolation;
/** Set on an "invalid" error whose ONLY problem is parent-child violations; carries what a repair round needs. */
export interface RelevanceHierarchyFailure {
  violations: RelevanceHierarchyViolation[];
  /** The reply as the parser read it, otherwise valid and complete. */
  reply: RelevanceGradeResult;
  /** Set when cards are missing from the reply and every one of them is a non-pinned card with a bound. */
  missing?: string[];
}
export class RelevanceGradeError extends Error {
  constructor(
    readonly code: "empty" | "over_budget" | "stopped" | "invalid",
    message: string,
    readonly hierarchy?: RelevanceHierarchyFailure,
    /** Technical detail (may contain card ids) for logs; never shown to the user. */
    readonly detail?: string
  ) {
    super(message);
    this.name = "RelevanceGradeError";
  }
}

export const RELEVANCE_GRADE_SCHEMA = {
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
          tier: { type: "string", enum: [...RELEVANCE_TIERS] },
          anchor: { type: ["string", "null"] }
        },
        required: ["id", "tier"]
      }
    }
  },
  required: ["items"]
};

/** The cards that get a tier: everything except top-level cards, which are only context. */
export const gradableNodes = (nodes: ReadonlyArray<StructureNode>): StructureNode[] =>
  nodes.filter(node => node.parentId !== null);

export const invalid = (locale: ContentLanguage, detail: string): RelevanceGradeError =>
  new RelevanceGradeError("invalid", translate(locale, "error.relevance_grade_invalid", detail));

/** The pins that name a gradable card of this map, in map order, one per card (the last entry for a card wins). */
export function effectivePins(
  tree: ReadonlyArray<StructureNode>,
  pins: ReadonlyArray<RelevancePin> | undefined
): RelevancePin[] {
  if (!pins?.length) return [];
  const tier = new Map<string, RelevanceTier>();
  const gradable = new Set(gradableNodes(tree).map(node => node.id));
  for (const pin of pins) if (gradable.has(pin.id)) tier.set(pin.id, pin.tier);
  return tree
    .filter(node => tier.has(node.id))
    .map(node => ({ id: node.id, tier: tier.get(node.id) as RelevanceTier }));
}

/** The failure for a reply whose only problem is parent-child order (or a pin's bounds); a repair round can fix it. */
export function hierarchyError(
  locale: ContentLanguage,
  violations: TierViolation[],
  reply: RelevanceGradeResult
): RelevanceGradeError {
  const first = violations[0];
  const more = violations.length > 1 ? ` (+${violations.length - 1} more)` : "";
  return new RelevanceGradeError(
    "invalid",
    translate(
      locale,
      "error.relevance_grade_invalid",
      `hierarchy ${first.childId}: ${first.childTier} under ${first.parentTier} ${first.parentId}${more}`
    ),
    { violations, reply }
  );
}

/**
 * Strict parser. The WHOLE reply is refused (with `RelevanceGradeError`, nothing written, no partial result) when it is
 * not JSON; is not exactly `{"items": [...]}`; has an item that is not an object with `id` and `tier` (and
 * optionally `anchor`, a string or null; any other key, a `reason` included, refuses it); has a tier other than core,
 * support or side; repeats an id; names an id that is not on the map or belongs to a top-level card; leaves any gradable card
 * that is not pinned out; or, once the pins are merged in, ranks a card above its parent (core > support > side; a
 * top-level parent is context and not compared) or outside the bounds the pins give it.
 * Pinned cards are the learner's and are not graded: an entry for one is ignored and counted. An `anchor` that is not
 * a pinned card is treated as none and counted.
 * The reply uses the short position ids of {@link gradePrompt} (c1..cN, in map order); each is turned back into the real
 * id here, so everything returned or reported (items, violations, error details) carries real ids. A real id (UUID) in
 * the reply is not a position id and is refused like any unknown id.
 * Nothing is coerced, dropped or truncated.
 */
export function parseRelevanceGrade(
  raw: string,
  tree: ReadonlyArray<StructureNode>,
  language: ContentLanguage = "en",
  pinList: ReadonlyArray<RelevancePin> = []
): RelevanceGradeResult {
  const locale = uiLocale(language);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw invalid(locale, "JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid(locale, "object");
  const body = value as Record<string, unknown>;
  if (Object.keys(body).length !== 1 || !Array.isArray(body.items)) throw invalid(locale, "items");
  const ids = positionIds(tree.map(node => node.id));
  const gradable = new Map(gradableNodes(tree).map(node => [node.id, node]));
  const pins = effectivePins(tree, pinList);
  const pinned = new Set(pins.map(pin => pin.id));
  const seen = new Set<string>();
  const items: RelevanceGradeItem[] = [];
  let pinnedIgnored = 0;
  let anchorsDropped = 0;
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
    if (typeof tier !== "string" || !(RELEVANCE_TIERS as readonly string[]).includes(tier))
      throw invalid(locale, `${where} tier`);
    if (withAnchor && anchor !== null && typeof anchor !== "string") throw invalid(locale, `${where} anchor`);
    const id = ids.real(label);
    if (id === undefined) throw invalid(locale, `${where} id ${label}`);
    if (!gradable.has(id)) throw invalid(locale, `${where} top-level ${id}`);
    if (seen.has(id)) throw invalid(locale, `${where} duplicate ${id}`);
    seen.add(id);
    if (pinned.has(id)) {
      pinnedIgnored++;
      return;
    }
    const anchorId = typeof anchor === "string" ? ids.real(anchor) : undefined;
    const anchored = anchorId !== undefined && pinned.has(anchorId);
    if (typeof anchor === "string" && !anchored) anchorsDropped++;
    items.push({
      id,
      tier: tier as RelevanceTier,
      ...(anchored ? { anchor: anchorId } : {})
    });
  });
  const missing = [...gradable.keys()].filter(id => !seen.has(id) && !pinned.has(id));
  const pinBounds = relevancePinBounds(tree, pins);
  const violations = relevanceMergedViolations(tree, mergeRelevanceTiers({ items, pins }), pinBounds);
  const result: RelevanceGradeResult = {
    items,
    ...(pinnedIgnored ? { pinnedIgnored } : {}),
    ...(anchorsDropped ? { anchorsDropped } : {}),
    ...(pinBounds.conflicts.length ? { conflicts: pinBounds.conflicts } : {})
  };
  if (missing.length) {
    const detail = `missing ${missing.length}: ${missing.slice(0, 3).join(", ")}${pinnedIgnored ? ` (pinnedIgnored ${pinnedIgnored})` : ""}`;
    // Only cards that carry a bound (and are not pinned) may be sent back for one more try; any other gap is final.
    if (missing.every(id => pinBounds.bounds.has(id)))
      throw new RelevanceGradeError(
        "invalid",
        translate(locale, "error.relevance_grade_invalid", detail),
        { violations, reply: result, missing },
        detail
      );
    throw invalid(locale, detail);
  }
  if (violations.length) throw hierarchyError(locale, violations, result);
  return result;
}

/** Every graded card ranked above its graded parent, in map order. A top-level parent is context and is not compared. */
export function relevanceHierarchyViolations(
  items: ReadonlyArray<RelevanceGradeItem>,
  tree: ReadonlyArray<StructureNode>
): RelevanceHierarchyViolation[] {
  const tierOf = new Map(items.map(item => [item.id, item.tier]));
  const violations: RelevanceHierarchyViolation[] = [];
  for (const node of gradableNodes(tree)) {
    const parentTier = node.parentId ? tierOf.get(node.parentId) : undefined;
    const tier = tierOf.get(node.id);
    if (node.parentId && parentTier && tier && TIER_RANK[tier] > TIER_RANK[parentTier])
      violations.push({ childId: node.id, childTier: tier, parentId: node.parentId, parentTier });
  }
  return violations;
}

/** The wording that differs per provider: the tools sentence and the sentence that introduces the reply's shape. */
export type RelevanceProviderText = { tools: string; output: string };
const trimmed = (text: string): string => text.replace(/\n$/, "");
export const relevanceProviderText = (
  model: string,
  output: { claude: string; codex: string }
): RelevanceProviderText =>
  providerForModel(model) === "claude"
    ? { tools: trimmed(toolsClaude), output: trimmed(output.claude) }
    : { tools: trimmed(toolsCodex), output: trimmed(output.codex) };
export const gradeProviderText = (model: string): RelevanceProviderText =>
  relevanceProviderText(model, { claude: outputGradeClaude, codex: outputGradeCodex });

/**
 * The pins and bounds as the model sees them (position ids), or undefined when nothing is pinned.
 * `bounds` lists only cards whose range the pins narrowed.
 */
export const promptPinParts = (
  nodes: ReadonlyArray<StructureNode>,
  pinList: ReadonlyArray<RelevancePin> | undefined
): { pins: string; bounds: string; mustInclude: string; pinned: Map<string, RelevanceTier> } | undefined => {
  const pins = effectivePins(nodes, pinList);
  if (!pins.length) return undefined;
  const ids = positionIds(nodes.map(node => node.id));
  const label = (id: string): string => ids.short(id) ?? id;
  const bounds = relevancePinBounds(nodes, pins).bounds;
  const boundOf = (bound: PinBound) => ({
    ...(bound.min ? { min: bound.min } : {}),
    ...(bound.max ? { max: bound.max } : {})
  });
  return {
    pins: JSON.stringify(pins.map(pin => ({ id: label(pin.id), tier: pin.tier }))),
    bounds: JSON.stringify([...bounds].map(([id, bound]) => ({ id: label(id), ...boundOf(bound) }))),
    mustInclude: bounds.size ? [...bounds.keys()].map(label).join(", ") : "none",
    pinned: new Map(pins.map(pin => [pin.id, pin.tier]))
  };
};

/** The cards as the model sees them: position ids (c1..cN in map order) for both `id` and `parentId`, no UUIDs. */
const promptCards = (nodes: ReadonlyArray<StructureNode>, pinned: ReadonlyMap<string, RelevanceTier>) => {
  const ids = positionIds(nodes.map(node => node.id));
  const label = (id: string): string => ids.short(id) ?? id;
  return nodes.map(node => ({
    id: label(node.id),
    title: node.title,
    summary: node.summary,
    parentId: node.parentId === null ? null : label(node.parentId),
    depth: node.depth,
    ...(pinned.has(node.id) ? { pinned: pinned.get(node.id) } : {})
  }));
};

const gradePrompt = (request: RelevanceGradeRequest): string => {
  const parts = promptPinParts(request.nodes, request.pins);
  const text = gradeProviderText(request.model);
  return renderTemplate(template, {
    toolLine: text.tools,
    outputLine: text.output,
    pinsSection: parts
      ? `${renderTemplate(pinsTemplate, { pins: parts.pins, bounds: parts.bounds, mustInclude: parts.mustInclude })}\n\n`
      : "",
    goal: JSON.stringify(request.goal),
    level: JSON.stringify(request.level ?? null),
    context: JSON.stringify(request.context ?? null),
    nodes: JSON.stringify(promptCards(request.nodes, parts?.pinned ?? new Map()))
  });
};

/** The error for a map with nothing to grade or too much to send. */
export const refuseIfTooBig = (prompt: string, request: RelevanceGradeRequest, schema: unknown): void => {
  const locale = uiLocale(request.language);
  if (!gradableNodes(request.nodes).length)
    throw new RelevanceGradeError("empty", translate(locale, "error.relevance_grade_empty"));
  if (estimateTokens(prompt + JSON.stringify(schema)) > RELEVANCE_GRADE_TOKEN_BUDGET)
    throw new RelevanceGradeError("over_budget", translate(locale, "error.relevance_grade_over_budget"));
};

/** Pinned cards ranked above a pinned ancestor in this request (the learner's own disagreement). */
export const pinConflicts = (request: RelevanceGradeRequest): PinConflict[] =>
  relevancePinBounds(request.nodes, effectivePins(request.nodes, request.pins)).conflicts;

/** Cards the model must grade: every gradable card that is not pinned. Empty means there is nothing to ask. */
export const cardsToGrade = (request: RelevanceGradeRequest): StructureNode[] => {
  const pinned = new Set(effectivePins(request.nodes, request.pins).map(pin => pin.id));
  return gradableNodes(request.nodes).filter(node => !pinned.has(node.id));
};

/** Grade every card of a map against the learner's goal. Input is titles, summaries and structure; the reply is strict JSON. */
export const relevanceGradeStep: StepDefinition<RelevanceGradeRequest, RelevanceGradeResult> = {
  id: "relevance-grade",
  version: 11,
  render: gradePrompt,
  schema: RELEVANCE_GRADE_SCHEMA,
  policy: (prompt, request) => refuseIfTooBig(prompt, request, RELEVANCE_GRADE_SCHEMA),
  parse: (raw, request) => parseRelevanceGrade(raw, request.nodes, request.language, request.pins)
};

/** The most repair rounds one grade may use; each round fixes only parent-child violations of the latest reply. */
export const RELEVANCE_REPAIR_MAX_ROUNDS = 2;
/** A repair round: the latest reply was complete and valid except for the listed parent-child violations. */
export interface RelevanceRepairRequest extends RelevanceGradeRequest {
  previousReply: RelevanceGradeResult;
  violations: RelevanceHierarchyViolation[];
  /** Set for a missing-bounded repair: the cards the reply left out. */
  missing?: string[];
}
/** Ancestors of a violating parent up to the top-level card, each with its tier in the merged result (null: no tier). */
export const ancestorChain = (
  nodes: ReadonlyArray<StructureNode>,
  tiers: ReadonlyMap<string, RelevanceTier>,
  parentId: string
): Array<{ id: string; tier: RelevanceTier | null }> => {
  const ids = positionIds(nodes.map(node => node.id));
  const label = (id: string): string => ids.short(id) ?? id;
  const parentOf = new Map(nodes.map(node => [node.id, node.parentId]));
  const result: Array<{ id: string; tier: RelevanceTier | null }> = [];
  const seen = new Set<string>();
  for (let id: string | null | undefined = parentId; id && !seen.has(id); id = parentOf.get(id)) {
    seen.add(id);
    result.push({ id: label(id), tier: tiers.get(id) ?? null });
  }
  return result;
};
/** The violations as the repair prompt shows them: position ids and the ancestor chain with merged tiers. */
export const promptViolations = (
  nodes: ReadonlyArray<StructureNode>,
  tiers: ReadonlyMap<string, RelevanceTier>,
  violations: ReadonlyArray<RelevanceHierarchyViolation>
) => {
  const ids = positionIds(nodes.map(node => node.id));
  const label = (id: string): string => ids.short(id) ?? id;
  return violations.map(violation => ({
    ...violation,
    childId: label(violation.childId),
    parentId: label(violation.parentId),
    ancestors: ancestorChain(nodes, tiers, violation.parentId)
  }));
};
/** An item as the model reads it back: position ids (its anchor too). */
export const promptItem = (nodes: ReadonlyArray<StructureNode>, item: RelevanceGradeItem) => {
  const ids = positionIds(nodes.map(node => node.id));
  const label = (id: string): string => ids.short(id) ?? id;
  const { anchor, ...rest } = item;
  return { ...rest, id: label(item.id), ...(anchor ? { anchor: label(anchor) } : {}) };
};

/**
 * The repair prompt speaks position ids like the grade prompt: the reply and the pairs are converted before they are sent.
 * Each pair also carries the chain of ancestors from the parent up to the top-level card with each one's tier in the
 * previous reply (the top-level card is context only, so its tier is null): raising a parent may need its ancestors raised.
 * Pinned cards count with their pinned tier in those chains.
 */
const repairPrompt = (request: RelevanceRepairRequest): string => {
  const pins = effectivePins(request.nodes, request.pins);
  const tiers = mergeRelevanceTiers({ items: request.previousReply.items, pins });
  const text = relevanceProviderText(request.model, { claude: outputRepairClaude, codex: outputRepairCodex });
  return renderTemplate(repairTemplate, {
    originalPrompt: gradePrompt(request),
    previousReply: JSON.stringify({ items: request.previousReply.items.map(item => promptItem(request.nodes, item)) }),
    violations: JSON.stringify(promptViolations(request.nodes, tiers, request.violations)),
    pinsNote: pins.length ? `${renderTemplate(repairPinsNote, {})}\n` : "",
    toolLine: text.tools,
    outputLine: text.output
  });
};
export const relevanceGradeRepairStep: StepDefinition<RelevanceRepairRequest, RelevanceGradeResult> = {
  id: "relevance-grade-repair",
  version: 5,
  render: repairPrompt,
  schema: RELEVANCE_GRADE_SCHEMA,
  policy: (prompt, request) => refuseIfTooBig(prompt, request, RELEVANCE_GRADE_SCHEMA),
  // The same strict parser; a repair that breaks anything but hierarchy fails the grade, and one that still violates
  // hierarchy gets another round until RELEVANCE_REPAIR_MAX_ROUNDS is used up.
  parse: (raw, request) => parseRelevanceGrade(raw, request.nodes, request.language, request.pins)
};

/**
 * A repair for a reply that left out cards with a bound: the original task, the reply so far, and each missing card
 * with its title and bounds. The model must send the COMPLETE corrected reply; the same strict parser judges it.
 */
const repairMissingPrompt = (request: RelevanceRepairRequest): string => {
  const ids = positionIds(request.nodes.map(node => node.id));
  const label = (id: string): string => ids.short(id) ?? id;
  const bounds = relevancePinBounds(request.nodes, effectivePins(request.nodes, request.pins)).bounds;
  const titleOf = new Map(request.nodes.map(node => [node.id, node.title]));
  const text = relevanceProviderText(request.model, {
    claude: outputRepairMissingClaude,
    codex: outputRepairMissingCodex
  });
  return renderTemplate(repairMissingTemplate, {
    originalPrompt: gradePrompt(request),
    previousReply: JSON.stringify({ items: request.previousReply.items.map(item => promptItem(request.nodes, item)) }),
    missing: JSON.stringify(
      (request.missing ?? []).map(id => ({
        id: label(id),
        title: titleOf.get(id) ?? "",
        ...(bounds.get(id)?.min ? { min: bounds.get(id)?.min } : {}),
        ...(bounds.get(id)?.max ? { max: bounds.get(id)?.max } : {})
      }))
    ),
    toolLine: text.tools,
    outputLine: text.output
  });
};
export const relevanceGradeMissingRepairStep: StepDefinition<RelevanceRepairRequest, RelevanceGradeResult> = {
  id: "relevance-grade-repair-missing",
  version: 2,
  render: repairMissingPrompt,
  schema: RELEVANCE_GRADE_SCHEMA,
  policy: (prompt, request) => refuseIfTooBig(prompt, request, RELEVANCE_GRADE_SCHEMA),
  parse: (raw, request) => parseRelevanceGrade(raw, request.nodes, request.language, request.pins)
};
