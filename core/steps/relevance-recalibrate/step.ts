import { uiLocale } from "../../../i18n";
import type { RelevanceTier } from "../../../note-values";
import {
  mergeRelevanceTiers,
  relevanceMergedViolations,
  relevancePinBounds,
  type RelevancePin
} from "../../../experiences/visual-map/relevance-pins";
import { positionIds } from "../../short-ids";
import { renderTemplate, type StepDefinition } from "../../step-runner";
import {
  cardsToGrade,
  effectivePins,
  gradableNodes,
  hierarchyError,
  invalid,
  relevanceProviderText,
  promptItem,
  promptPinParts,
  promptViolations,
  refuseIfTooBig,
  RELEVANCE_TIERS,
  type RelevanceGradeItem,
  type RelevanceGradeRequest,
  type RelevanceGradeResult,
  type RelevanceRepairRequest
} from "../relevance-grade/step";
import type { StructureNode } from "../structure-review/step";
import template from "./prompt.md";
import repairTemplate from "./repair.md";
import outputClaude from "./output-recalibrate.claude.md";
import outputCodex from "./output-recalibrate.codex.md";
import outputRepairClaude from "./output-repair.claude.md";
import outputRepairCodex from "./output-repair.codex.md";

/**
 * Recalibrate a map that is already graded: the model sees every card with its current tier and the learner's pins, and
 * answers only with the cards that should move (plus the cards that have no tier yet). The result is a
 * {@link RelevanceGradeResult} whose `items` are the changes to write.
 */
export interface RelevanceRecalibrateRequest extends RelevanceGradeRequest {
  /** The current AI tier of each graded card that is not pinned. A gradable card missing here has no tier yet. */
  previous: RelevancePin[];
}
export interface RelevanceRecalibrateResult extends RelevanceGradeResult {
  /** Entries whose tier equals the card's current tier (ignored). */
  unchangedIgnored?: number;
}

export const RELEVANCE_RECALIBRATE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    changes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", minLength: 1 },
          tier: { type: "string", enum: [...RELEVANCE_TIERS] },
          anchor: { type: ["string", "null"] }
        },
        required: ["id", "tier", "anchor"]
      }
    }
  },
  required: ["changes"]
};

/** The current tiers that count: only gradable cards that are not pinned. */
const currentTiers = (request: RelevanceRecalibrateRequest): RelevancePin[] => {
  const pinned = new Set(effectivePins(request.nodes, request.pins).map(pin => pin.id));
  const gradable = new Set(gradableNodes(request.nodes).map(node => node.id));
  return request.previous.filter(entry => gradable.has(entry.id) && !pinned.has(entry.id));
};

/**
 * Strict parser. The WHOLE reply is refused when it is not JSON; is not exactly `{"changes": [...]}`; has an entry that
 * is not an object with exactly `id`, `tier` and `anchor` (a string or null; a `reason` key refuses it); has a tier other
 * than core, support or side; repeats an id; names an id that is not on the map or belongs to a top-level
 * card; leaves a card without a tier unrated; or, with the changes and the pins merged into the current tiers, ranks a
 * card above its parent or outside its bounds (these go to a repair round).
 * Allowed but not used: an entry for a pinned card (counted), an entry whose tier equals the current one (counted), an
 * `anchor` that is not a pinned card (treated as none and counted). `items` are the accepted changes, real ids.
 */
export function parseRelevanceRecalibrate(
  raw: string,
  request: RelevanceRecalibrateRequest
): RelevanceRecalibrateResult {
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
  if (Object.keys(body).length !== 1 || !Array.isArray(body.changes)) throw invalid(locale, "changes");
  const ids = positionIds(tree.map(node => node.id));
  const gradable = new Map(gradableNodes(tree).map(node => [node.id, node]));
  const pins = effectivePins(tree, request.pins);
  const pinned = new Set(pins.map(pin => pin.id));
  const previous = currentTiers(request);
  const previousTier = new Map(previous.map(entry => [entry.id, entry.tier]));
  const seen = new Set<string>();
  const items: RelevanceGradeItem[] = [];
  let pinnedIgnored = 0;
  let anchorsDropped = 0;
  let unchangedIgnored = 0;
  body.changes.forEach((entry: unknown, index: number) => {
    const where = `#${index + 1}`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw invalid(locale, where);
    const change = entry as Record<string, unknown>;
    const keys = Object.keys(change);
    if (keys.length !== 3 || !["id", "tier", "anchor"].every(key => keys.includes(key)))
      throw invalid(locale, `${where} keys`);
    const { id: label, tier, anchor } = change;
    if (typeof label !== "string" || !label) throw invalid(locale, `${where} id`);
    if (typeof tier !== "string" || !(RELEVANCE_TIERS as readonly string[]).includes(tier))
      throw invalid(locale, `${where} tier`);
    if (anchor !== null && typeof anchor !== "string") throw invalid(locale, `${where} anchor`);
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
    if (previousTier.get(id) === tier) {
      unchangedIgnored++;
      return;
    }
    items.push({
      id,
      tier: tier as RelevanceTier,
      ...(anchored ? { anchor: anchorId } : {})
    });
  });
  const missing = [...gradable.keys()].filter(id => !pinned.has(id) && !previousTier.has(id) && !seen.has(id));
  if (missing.length) throw invalid(locale, `missing ${missing.length}: ${missing.slice(0, 3).join(", ")}`);
  const pinBounds = relevancePinBounds(tree, pins);
  const violations = relevanceMergedViolations(tree, mergeRelevanceTiers({ previous, items, pins }), pinBounds);
  const result: RelevanceRecalibrateResult = {
    items,
    ...(pinnedIgnored ? { pinnedIgnored } : {}),
    ...(anchorsDropped ? { anchorsDropped } : {}),
    ...(unchangedIgnored ? { unchangedIgnored } : {}),
    ...(pinBounds.conflicts.length ? { conflicts: pinBounds.conflicts } : {})
  };
  if (violations.length) throw hierarchyError(locale, violations, result);
  return result;
}

/** Cards the model has to look at: the gradable cards that are not pinned (nothing to ask when this is empty). */
export const cardsToRecalibrate = (request: RelevanceRecalibrateRequest): StructureNode[] => cardsToGrade(request);

/** The cards as the model sees them: position ids, the current tier (null when not graded), `pinned: true` on a pin. */
const promptCards = (request: RelevanceRecalibrateRequest) => {
  const ids = positionIds(request.nodes.map(node => node.id));
  const label = (id: string): string => ids.short(id) ?? id;
  const pins = new Map(effectivePins(request.nodes, request.pins).map(pin => [pin.id, pin.tier]));
  const tiers = new Map(currentTiers(request).map(entry => [entry.id, entry.tier]));
  return request.nodes.map(node => ({
    id: label(node.id),
    title: node.title,
    summary: node.summary,
    parentId: node.parentId === null ? null : label(node.parentId),
    depth: node.depth,
    ...(node.parentId === null ? {} : { tier: pins.get(node.id) ?? tiers.get(node.id) ?? null }),
    ...(pins.has(node.id) ? { pinned: true } : {})
  }));
};

const recalibratePrompt = (request: RelevanceRecalibrateRequest): string => {
  const parts = promptPinParts(request.nodes, request.pins);
  const text = relevanceProviderText(request.model, { claude: outputClaude, codex: outputCodex });
  return renderTemplate(template, {
    toolLine: text.tools,
    outputLine: text.output,
    goal: JSON.stringify(request.goal),
    level: JSON.stringify(request.level ?? null),
    context: JSON.stringify(request.context ?? null),
    pins: parts?.pins ?? "[]",
    bounds: parts?.bounds ?? "[]",
    nodes: JSON.stringify(promptCards(request))
  });
};

export const relevanceRecalibrateStep: StepDefinition<RelevanceRecalibrateRequest, RelevanceRecalibrateResult> = {
  id: "relevance-recalibrate",
  version: 2,
  render: recalibratePrompt,
  schema: RELEVANCE_RECALIBRATE_SCHEMA,
  policy: (prompt, request) => refuseIfTooBig(prompt, request, RELEVANCE_RECALIBRATE_SCHEMA),
  parse: (raw, request) => parseRelevanceRecalibrate(raw, request)
};

/** A repair round: the changes parsed fine except for the listed parent-child or bounds violations. */
export interface RelevanceRecalibrateRepairRequest
  extends RelevanceRecalibrateRequest, Pick<RelevanceRepairRequest, "previousReply" | "violations"> {}

const repairPrompt = (request: RelevanceRecalibrateRepairRequest): string => {
  const pins = effectivePins(request.nodes, request.pins);
  const tiers = mergeRelevanceTiers({ previous: currentTiers(request), items: request.previousReply.items, pins });
  const text = relevanceProviderText(request.model, { claude: outputRepairClaude, codex: outputRepairCodex });
  return renderTemplate(repairTemplate, {
    originalPrompt: recalibratePrompt(request),
    previousReply: JSON.stringify({
      changes: request.previousReply.items.map(item => {
        const { anchor, ...rest } = promptItem(request.nodes, item);
        return { ...rest, anchor: anchor ?? null };
      })
    }),
    violations: JSON.stringify(promptViolations(request.nodes, tiers, request.violations)),
    toolLine: text.tools,
    outputLine: text.output
  });
};
export const relevanceRecalibrateRepairStep: StepDefinition<
  RelevanceRecalibrateRepairRequest,
  RelevanceRecalibrateResult
> = {
  id: "relevance-recalibrate-repair",
  version: 2,
  render: repairPrompt,
  schema: RELEVANCE_RECALIBRATE_SCHEMA,
  policy: (prompt, request) => refuseIfTooBig(prompt, request, RELEVANCE_RECALIBRATE_SCHEMA),
  parse: (raw, request) => parseRelevanceRecalibrate(raw, request)
};
