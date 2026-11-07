import { toSimplifiedFold } from "../i18n/han-fold";
import type { MapAiMode, ResearchDepth, ResearchMode } from "../ai/types";
import type { MapChatContext } from "./map-chat-context";
import { MAP_CHAT_NEW_PREFIX, type MapChatAction } from "./steps/map-chat/step";

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

/** One expand card is at most this many outline calls: the outline call, and one more when the model leaves a summary out and is asked again. */
export const MAP_CHAT_EXPAND_CALLS_PER_CARD = 2;

/**
 * `auto_round_other_actions`: a round of an automatic continuation (second round on) asked for something outside {@link CHAIN_SAFE}.
 * Its context carries web research text, which is untrusted, so deleting, rewriting, moving, writing files, opening maps and
 * the like are always shown as a plan.
 *
 * `research_text_other_actions`: the same rule for a first round or an ordinary message of a conversation that has started research
 * (decisions #14, #16): the text can reach the model by any card or earlier reply and is untrusted wherever it is read.
 *
 * `image_preview`: the reply places or links anchors and the user chose to see image changes first. `image_other_actions`: a turn
 * that sent an image also asked for something besides the image-safe actions; the picture is untrusted input, so this is
 * a plan in either mode.
 */
export type MapChatPlanReason =
  | "many_actions"
  | "many_research"
  | "new_map"
  | "image_preview"
  | "image_other_actions"
  | "auto_round_other_actions"
  | "research_text_other_actions";

/** "AI changes to an image: show me first" or "apply at once"; the setting `mapChatImageMode`. */
export type MapChatImageMode = "preview" | "direct";

/** The only actions a turn that sent an image may do without a plan (in "direct" mode). */
const IMAGE_SAFE_KINDS: ReadonlySet<MapChatAction["kind"]> = new Set<MapChatAction["kind"]>([
  "add_anchor",
  "link_anchor",
  "add_child",
  "add_relation",
  "focus_topic",
  "auto_layout",
  "collapse_topic",
  "expand_topic"
]);

/**
 * What an automatic round (second round on) may do without a plan: add cards and links, write summaries, types and looks, change the
 * selection and the view, and start research or an expand. `run_map_action` is judged by its action: only `research_standard` and
 * `expand` are safe (an integration, a merge, a rating or an image search is not).
 */
export const CHAIN_SAFE: ReadonlySet<MapChatAction["kind"]> = new Set<MapChatAction["kind"]>([
  "add_child",
  "add_relation",
  "update_summary",
  "set_topic_kind",
  "set_appearance",
  "select_topics",
  "focus_topic",
  "collapse_topic",
  "expand_topic",
  "auto_layout"
]);
const CHAIN_SAFE_RUN: ReadonlySet<string> = new Set(["research_standard", "expand"]);
/** True when the kind of action may be part of an automatic round without a plan (its targets are judged by {@link isChainSafeFor}). */
export const isChainSafe = (action: MapChatAction): boolean =>
  action.kind === "run_map_action" ? CHAIN_SAFE_RUN.has(action.action) : CHAIN_SAFE.has(action.kind);

/** The cards a reply that read web research text may rewrite or research without a plan (decision #14). */
export interface MapChatTrusted {
  /** Cards this chain created (real ids). A `new:<ref>` card of the reply itself counts too. */
  createdIds?: ReadonlySet<string>;
  /** Cards this conversation researched successfully (real ids). */
  researchedIds?: ReadonlySet<string>;
}
/**
 * {@link isChainSafe}, and for the three actions that change what a card says or runs the web on it (`update_summary`,
 * `set_topic_kind`, `research_standard`) only on a card this chain made, or (not for research) one this conversation already
 * researched. Injected text could otherwise rewrite any existing card. No target (the selection) is not known here: not safe.
 */
export function isChainSafeFor(action: MapChatAction, trusted: MapChatTrusted = {}): boolean {
  if (!isChainSafe(action)) return false;
  const made = (id: string): boolean => id.startsWith(MAP_CHAT_NEW_PREFIX) || (trusted.createdIds?.has(id) ?? false);
  const every = (ids: readonly string[], ok: (id: string) => boolean): boolean => ids.length > 0 && ids.every(ok);
  switch (action.kind) {
    case "update_summary":
      return made(action.nodeId) || (trusted.researchedIds?.has(action.nodeId) ?? false);
    case "set_topic_kind":
      return every(action.nodeIds, id => made(id) || (trusted.researchedIds?.has(id) ?? false));
    case "run_map_action":
      // Research: a card researched before is not repeated without asking (Medium 4).
      return (
        action.action !== "research_standard" ||
        every(action.nodeIds, id => made(id) && !trusted.researchedIds?.has(id))
      );
    default:
      return true;
  }
}

/** Where the reply sits in an automatic continuation. Absent = an ordinary message (or the first round). */
export interface MapChatPlanChain {
  /** The round this reply belongs to, from 1; only 2 and up use the chain rules. */
  round: number;
  /** Research targets the earlier rounds of this chain already started: splitting the work over rounds does not get around `many_research`. */
  researchSoFar: number;
}

export interface MapChatPlan {
  /** Every condition that holds, in a fixed order. */
  reasons: MapChatPlanReason[];
  /**
   * AI calls the actions start, counted at least (B2): each Standard research target is its main call plus the diagram call that
   * follows the write (`options.diagrams`, on by default); a Quick research target is one call (it adds no diagram). The mode is the
   * one the action names, then `options.mapAiMode`, then Quick (a standard research that found nothing on the web is sent once
   * more, which is a retry and is not counted). Each synthesize is one integration call plus the
   * same diagram call: B2 starts it without a dialog and without the directions step. An expand is {@link MAP_CHAT_EXPAND_CALLS_PER_CARD} outline calls per
   * card it is asked for (the second is the ask-again when a summary is missing; its subtopics are added without further AI calls), one for rating by a goal, one for a merge, one for each card a find_images targets (the loadable-image check is not an AI call). Writes to cards and notes, create_map, open_map and the view operations are 0.
   * The chat reply itself is not counted.
   */
  estimatedCalls: number;
}

type PlanContext = Pick<MapChatContext, "parents" | "selectedCount"> & Partial<Pick<MapChatContext, "research">>;

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

const isFindImages = (action: MapChatAction): boolean =>
  action.kind === "run_map_action" && action.action === "find_images";

/** The plan a reply needs, or null when it can be applied at once. `diagrams` is the "Add diagrams after research" setting. */
export function planFor(
  actions: readonly MapChatAction[],
  context: PlanContext,
  options: {
    diagrams?: boolean;
    mapAiMode?: MapAiMode;
    imageMode?: MapChatImageMode;
    imageAttached?: boolean;
    chain?: MapChatPlanChain;
    /** Cards that may be rewritten or researched without a plan when the reply read research text or is an automatic round. */
    trusted?: MapChatTrusted;
    /** This conversation has started research (decision #17): any turn of it may read web text, so the allow-list applies. */
    chatStartedResearch?: boolean;
  } = {}
): MapChatPlan | null {
  const perTask = mapChatCallsPerTask(options.diagrams !== false);
  const reasons: MapChatPlanReason[] = [];
  // A picture turn applied directly may place many anchors, links and topics at once (decision #14): they only add, and one undo takes them all back.
  const imageAddsOnly =
    options.imageMode === "direct" &&
    options.imageAttached === true &&
    actions.every(action => isFindImages(action) || IMAGE_SAFE_KINDS.has(action.kind));
  // A reply that may read web research text (an automatic round, or any turn of a conversation that has started research:
  // the text can reach the model through any card or earlier reply, decisions #16 and #17) does not do what
  // that text could have injected: only safe actions on safe cards go without a plan. An automatic round of only such actions is
  // also not stopped by the number of actions (the first round keeps the rule).
  const autoRound = (options.chain?.round ?? 1) >= 2;
  const readsResearch = autoRound || options.chatStartedResearch === true;
  const onlySafe =
    readsResearch && actions.every(action => isFindImages(action) || isChainSafeFor(action, options.trusted));
  const autoOnlySafe = autoRound && onlySafe;
  // find_images never needs a plan (owner: pictures are put in without asking), so it does not count toward the action limit or the other-actions rules.
  const planned = actions.filter(action => !isFindImages(action));
  if (planned.length > MAP_CHAT_PLAN_ACTION_LIMIT && !imageAddsOnly && !autoOnlySafe) reasons.push("many_actions");
  let research = 0;
  let calls = 0;
  let selection = context.selectedCount;
  let createsMap = false;
  for (const action of actions) {
    switch (action.kind) {
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
            calls += targetCount(action.nodeIds, selection) * MAP_CHAT_EXPAND_CALLS_PER_CARD;
            break;
          case "rate_by_goal":
          case "merge":
            calls += 1;
            break;
          case "synthesize":
            calls += perTask;
            break;
          case "find_images":
            calls += targetCount(action.nodeIds, selection);
            break;
        }
        break;
      default:
        break;
    }
  }
  if (research > 0 && research + (options.chain?.researchSoFar ?? 0) >= MAP_CHAT_PLAN_RESEARCH_LIMIT)
    reasons.push("many_research");
  if (createsMap) reasons.push("new_map");
  if (
    options.imageMode === "preview" &&
    actions.some(action => action.kind === "add_anchor" || action.kind === "link_anchor")
  )
    reasons.push("image_preview");
  if (options.imageAttached && actions.some(action => !isFindImages(action) && !IMAGE_SAFE_KINDS.has(action.kind)))
    reasons.push("image_other_actions");
  if (readsResearch && !onlySafe) reasons.push(autoRound ? "auto_round_other_actions" : "research_text_other_actions");
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
 * The mode a research runs in: the mode the user named, then Standard when the model says the research needs the web
 * (`needsWeb`, the only signal; the reply text is not scanned), then the mode the map remembers,
 * then Quick (D-2026-10-228, 231; the web rule replaces 228's "no guess at how unfamiliar the topic is", map chat only).
 * Whether the targets are all new cards no longer matters. Decided here, not by the model: it only states the fact.
 */
export function chatResearchMode(
  action: Extract<MapChatAction, { kind: "run_map_action" }>,
  mapAiMode: MapAiMode | undefined
): MapAiMode {
  if (action.mode) return action.mode;
  if (action.needsWeb === true) return "standard";
  return mapAiMode || "quick";
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
