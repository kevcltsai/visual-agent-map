import { toSimplifiedFold } from "../i18n/han-fold";
import type { MapAiMode, ResearchDepth, ResearchMode } from "../ai/types";
import type { MapChatContext } from "./map-chat-context";
import type { MapChatAction } from "./steps/map-chat/step";

/**
 * Plan confirmation. Most replies are applied at once; a reply that can do a lot of damage or cost a lot is shown as a plan
 * first and nothing is touched until the user applies it. Pure: the view reads the map, this only judges the actions.
 */

/** More actions than this need a plan (so exactly this many do not). */
export const MAP_CHAT_PLAN_ACTION_LIMIT = 15;
/** This many research targets or more need a plan. */
export const MAP_CHAT_PLAN_RESEARCH_LIMIT = 10;

/** A reply that adds this many cards or more is followed by one automatic layout and a move of the view to the new cards. */
export const MAP_CHAT_AUTO_LAYOUT_MIN_NEW = 5;

export type MapChatPlanReason = "many_actions" | "delete_branch" | "many_research" | "new_map";

export interface MapChatPlan {
  /** Every condition that holds, in a fixed order. */
  reasons: MapChatPlanReason[];
  /**
   * AI calls the actions start, counted at least (B2): each Standard research target is its main call plus the diagram call that
   * follows the write (`options.diagrams`, on by default); a Quick research target is one call (it adds no diagram). The mode is the
   * one the action names, then `options.mapAiMode`, then Quick (a standard research that found nothing on the web is sent once
   * more, which is a retry and is not counted). Each synthesize is one integration call plus the
   * same diagram call: B2 starts it without a dialog and without the directions step. An expand is one outline call per
   * card it is asked for (its subtopics are added without further AI calls), one for rating by a goal, one for a merge. Writes to cards and notes, create_map, open_map and the view operations are 0.
   * The chat reply itself is not counted.
   */
  estimatedCalls: number;
}

type PlanContext = Pick<MapChatContext, "parents" | "selectedCount">;

/** Number of cards a research or expand action works on: its own targets, or the selection at that point of the reply. */
function targetCount(nodeIds: string[], selection: number): number {
  return nodeIds.length ? nodeIds.length : selection;
}

/**
 * Cards a reply starts research on, counted the way a plan is judged: the targets of each research action, or the selection at
 * that point of the reply (an earlier `select_topics` or run action changes it).
 */
export function researchTargetsOf(actions: readonly MapChatAction[], selectedCount: number): number {
  let research = 0;
  let selection = selectedCount;
  for (const action of actions) {
    if (action.kind === "select_topics") selection = action.nodeIds.length;
    else if (action.kind === "run_map_action") {
      if (action.nodeIds.length) selection = action.nodeIds.length;
      if (action.action === "research_standard") research += targetCount(action.nodeIds, selection);
    }
  }
  return research;
}

/** Calls one research or synthesis makes on its own: the main call, then (when diagrams are on) the diagram call. */
export const mapChatCallsPerTask = (diagrams: boolean): number => (diagrams ? 2 : 1);

/** The plan a reply needs, or null when it can be applied at once. `diagrams` is the "Add diagrams after research" setting. */
export function planFor(
  actions: readonly MapChatAction[],
  context: PlanContext,
  options: { diagrams?: boolean; mapAiMode?: MapAiMode } = {}
): MapChatPlan | null {
  const perTask = mapChatCallsPerTask(options.diagrams !== false);
  const reasons: MapChatPlanReason[] = [];
  if (actions.length > MAP_CHAT_PLAN_ACTION_LIMIT) reasons.push("many_actions");
  // Cards that have a child: in the map as it was sent, or created by this very reply.
  const parentsWithChildren = new Set<string>();
  for (const parent of Object.values(context.parents)) if (parent) parentsWithChildren.add(parent);
  for (const action of actions)
    if (action.kind === "add_child" && action.parentId) parentsWithChildren.add(action.parentId);
  let research = 0;
  let calls = 0;
  let selection = context.selectedCount;
  let deletesBranch = false;
  let createsMap = false;
  for (const action of actions) {
    switch (action.kind) {
      case "delete_topic":
        if (action.branch && parentsWithChildren.has(action.nodeId)) deletesBranch = true;
        break;
      case "create_map":
        createsMap = true;
        break;
      case "select_topics":
        selection = action.nodeIds.length;
        break;
      case "run_map_action":
        if (action.nodeIds.length) selection = action.nodeIds.length;
        switch (action.action) {
          case "research_standard": {
            const targets = targetCount(action.nodeIds, selection);
            research += targets;
            // Quick: the research call alone (no images or charts). Standard: the research call plus the diagram call.
            calls += targets * (chatResearchMode(action, options.mapAiMode) === "quick" ? 1 : perTask);
            break;
          }
          case "expand":
            calls += targetCount(action.nodeIds, selection);
            break;
          case "rate_by_goal":
          case "merge":
            calls += 1;
            break;
          case "synthesize":
            calls += perTask;
            break;
        }
        break;
      default:
        break;
    }
  }
  if (deletesBranch) reasons.push("delete_branch");
  if (research >= MAP_CHAT_PLAN_RESEARCH_LIMIT) reasons.push("many_research");
  if (createsMap) reasons.push("new_map");
  return reasons.length ? { reasons, estimatedCalls: calls } : null;
}

export type MapTitleMatch<T> = { kind: "none" } | { kind: "one"; map: T } | { kind: "many"; maps: T[] };

const fold = (value: string): string =>
  toSimplifiedFold(value.normalize("NFKC")).replace(/\s+/g, " ").trim().toLowerCase();

/**
 * The map a title names. Titles are compared after trimming, ignoring case and with Traditional and Simplified Chinese
 * folded together: an exact match wins (several exact matches stay several); with none, titles that contain the query count. The model never picks the map itself: it only names it, and this decides.
 */
export function matchMapTitle<T extends { title: string }>(query: string, maps: readonly T[]): MapTitleMatch<T> {
  const wanted = fold(query);
  if (!wanted) return { kind: "none" };
  const keyed = maps.map(map => ({ map, key: fold(map.title) })).filter(entry => entry.key);
  let hits = keyed.filter(entry => entry.key === wanted);
  if (!hits.length) hits = keyed.filter(entry => entry.key.includes(wanted));
  if (!hits.length) return { kind: "none" };
  return hits.length === 1 ? { kind: "one", map: hits[0].map } : { kind: "many", maps: hits.map(entry => entry.map) };
}

/** What tells apart the maps of a list that share a title: their folder, and a number when even the folder is the same. */
export interface MapChoicePart {
  title: string;
  folder?: string;
  seq?: number;
}
/**
 * The parts of the labels for a list of maps to pick from. A title that is alone in the list stays as it is; maps that share
 * one (compared as shown, after trimming) also get the folder their Map.md is in, and a number when the folder is shared too.
 */
export function mapChoiceParts(maps: readonly { title: string; mapPath: string }[]): MapChoicePart[] {
  const shown = (map: { title: string }): string => map.title.trim();
  const folder = (map: { mapPath: string }): string => map.mapPath.split("/").slice(0, -1).join("/");
  const same = (a: { title: string }, b: { title: string }): boolean => shown(a) === shown(b);
  const seen = new Map<string, number>();
  return maps.map(map => {
    if (maps.filter(other => same(other, map)).length < 2) return { title: map.title };
    const key = `${shown(map)}\u0000${folder(map)}`;
    const alike = maps.filter(other => same(other, map) && folder(other) === folder(map));
    if (alike.length < 2) return { title: map.title, folder: folder(map) };
    const seq = (seen.get(key) ?? 0) + 1;
    seen.set(key, seq);
    return { title: map.title, folder: folder(map), seq };
  });
}

/** What the chat hands to the multi-research for a research_standard action (the shape `startMultiResearch` takes). */
export interface ChatResearchRequest {
  /** The mode this research runs in (Quick or Standard); it also tells the task which prompt to use. */
  mapAiMode: MapAiMode;
  researchMode: ResearchMode;
  researchDepth: ResearchDepth;
  requirements: string;
  imageSearch: boolean;
}
/**
 * The mode a research runs in: the mode the user named, then the mode the map remembers, then Quick (D-2026-10-228, 231).
 * Whether the targets are all new cards no longer matters. Decided here, not by the model.
 */
export function chatResearchMode(
  action: Extract<MapChatAction, { kind: "run_map_action" }>,
  mapAiMode: MapAiMode | undefined
): MapAiMode {
  return action.mode || mapAiMode || "quick";
}
/** The research options of a mode (the view hands in `aiModeOptions(mode, "research")`; core does not import an experience). */
export type ChatModeOptions = (mode: MapAiMode) => { researchMode: ResearchMode; researchDepth: ResearchDepth };
/**
 * The research a reply asks for: the options of its mode (`optionsOf`). Quick never looks for images; Standard does only when
 * the user asked for them. `direction` is the extra requirement. A reply of the earlier step version reads as "not named" (no
 * depth) or Standard (a named depth) and "images off".
 */
export function chatResearchRequest(
  action: Extract<MapChatAction, { kind: "run_map_action" }>,
  mapAiMode: MapAiMode | undefined,
  optionsOf: ChatModeOptions
): ChatResearchRequest {
  const mode = chatResearchMode(action, mapAiMode);
  const options = optionsOf(mode);
  return {
    mapAiMode: mode,
    researchMode: options.researchMode,
    researchDepth: options.researchDepth,
    requirements: action.direction,
    imageSearch: mode === "standard" && action.images === true
  };
}
