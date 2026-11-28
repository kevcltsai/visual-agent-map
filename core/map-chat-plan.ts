import { toSimplifiedFold } from "../i18n/han-fold";
import type { MapAiMode, ResearchDepth, ResearchMode } from "../ai/types";
import type { MapChatContext } from "./map-chat-context";
import { MAP_CHAT_AUTO_MAX_CALLS } from "./map-chat-chain";
import { MAP_CHAT_NEW_PREFIX, type MapChatAction } from "./steps/map-chat/step";
import { videoUrlsInText, youtubeVideoId } from "./video-embeds";

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

/** One expand card is at most this many outline calls: the outline call, and one more when the model leaves a summary out or writes a non-heading line and is asked again. */
export const MAP_CHAT_EXPAND_CALLS_PER_CARD = 2;

/**
 * `auto_round_other_actions`: a round of an automatic continuation (second round on) asked for something outside {@link CHAIN_SAFE}.
 * Its context carries web research text, which is untrusted, so deleting, rewriting, moving, writing files, opening maps and
 * the like are always shown as a plan.
 *
 * `research_text_other_actions`: the same rule for a first round or an ordinary message of a conversation that has started research
 * (decisions #14, #16): the text can reach the model by any card or earlier reply and is untrusted wherever it is read.
 *
 * `source_text_other_actions`: the same rule when the conversation read the map's data sources (this turn or an earlier one):
 * the sources, their condensed text and the turns after them are untrusted input.
 *
 * `call_budget` (auto-apply only): the segment's AI calls so far plus this reply's estimate pass {@link MAP_CHAT_AUTO_MAX_CALLS}.
 * `auto_apply_confirm` (auto-apply only): an action outside the allow-list (delete, maps, a file outside the map folder)
 * that no other reason already holds back.
 *
 * `not_requested` (decision 2026-11-28-vam-v3-3#33): the user did not ask for a change (the reply's `changeRequested` is not true), yet the
 * reply would write: every write waits as a plan, auto-apply or not. Replies of only {@link READ_ONLY_KINDS} go on at once.
 *
 * `book_plan_edit`: the reply changes a book plan under review (cards, structure or thread); it writes the author's cards, so it is always a plan, auto-apply or not.
 *
 * `move_anchor_confirm`: the reply suggests moving an existing anchor; it is always a plan (never in {@link IMAGE_SAFE_KINDS}), auto-apply or not.
 *
 * `image_preview`: the reply places or links anchors and the user chose to see image changes first. `image_other_actions`: a turn
 * that sent an image also asked for something besides the image-safe actions; the picture is untrusted input, so this is
 * a plan in either mode.
 */
export type MapChatPlanReason =
  | "not_requested"
  | "many_actions"
  | "many_research"
  | "new_map"
  | "image_preview"
  | "image_other_actions"
  | "auto_round_other_actions"
  | "research_text_other_actions"
  | "source_text_other_actions"
  | "call_budget"
  | "auto_apply_confirm"
  | "book_plan_edit"
  | "living_node_confirm"
  | "move_anchor_confirm";

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
  "read_md_file",
  "collapse_topic",
  "expand_topic",
  "auto_layout"
]);
const CHAIN_SAFE_RUN: ReadonlySet<string> = new Set(["research_standard", "expand"]);
/** True when the kind of action may be part of an automatic round without a plan (its targets are judged by {@link isChainSafeFor}). */
export const isChainSafe = (action: MapChatAction): boolean =>
  action.kind === "run_map_action"
    ? CHAIN_SAFE_RUN.has(action.action)
    : action.kind === "add_child" && action.livingPrompt
      ? false
      : CHAIN_SAFE.has(action.kind);

/** Actions that write nothing (selection, focus, the kind question, reading a file): a reply the user did not ask to change the map may still do them at once. Collapse, expand and layout write Map.md, so they are writes. */
const READ_ONLY_KINDS: ReadonlySet<MapChatAction["kind"]> = new Set<MapChatAction["kind"]>([
  "select_topics",
  "focus_topic",
  "ask_topic_kind",
  "read_md_file"
]);

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

/**
 * An empty-target `research_standard` or `expand` runs on the selection; when an earlier `select_topics` of the same reply named
 * its cards explicitly (not `all`), the selection is those cards, so its targets resolve to them. Any other empty target stays empty
 * (the selection is not known here, see {@link isChainSafeFor}).
 */
export function resolveSelectionTargets(actions: readonly MapChatAction[]): MapChatAction[] {
  let selected: string[] | null = null;
  return actions.map(action => {
    if (action.kind === "select_topics") {
      selected = !action.all && action.nodeIds.length ? [...action.nodeIds] : null;
    } else if (action.kind === "run_map_action") {
      if (action.nodeIds.length) selected = [...action.nodeIds];
      else if (selected && CHAIN_SAFE_RUN.has(action.action)) return { ...action, nodeIds: [...selected] };
    }
    return action;
  });
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
   * card it is asked for (the second is the ask-again when a summary is missing; its subtopics are added without further AI calls), one for a merge, one for each card a find_images targets and one for a place_image (the loadable-image check is not an AI call). Writes to cards and notes, create_map, open_map and the view operations are 0.
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

/**
 * A web picture put on the canvas. Kept apart from {@link isFindImages}: it must not inherit that action's exemptions (the search
 * words come from the model, so a turn that may read web text or sent a picture gets a plan).
 */
const isPlaceImage = (action: MapChatAction): boolean => action.kind === "place_image";

/**
 * AI calls the actions start, counted at least (see {@link MapChatPlan.estimatedCalls}). `diagrams` is the "Add diagrams after
 * research" setting (on unless false); `mapAiMode` is the mode a research action falls back to.
 */
export function estimateChatCalls(
  actions: readonly MapChatAction[],
  context: Pick<PlanContext, "selectedCount"> & Partial<Pick<PlanContext, "parents">>,
  options: { diagrams?: boolean; mapAiMode?: MapAiMode } = {}
): number {
  const perTask = mapChatCallsPerTask(options.diagrams !== false);
  let calls = 0;
  let selection = context.selectedCount;
  for (const action of actions) {
    if (action.kind === "select_topics") selection = action.nodeIds.length;
    else if (action.kind === "place_image") calls += 1;
    else if (action.kind === "run_map_action") {
      if (action.nodeIds.length) selection = action.nodeIds.length;
      switch (action.action) {
        case "run_living_card":
        case "run_living_all":
          // Dependency planning happens at execution. The whole map is an upper
          // bound, including new cards created by this reply.
          calls += Math.max(
            action.nodeIds.length,
            Object.keys(context.parents ?? {}).length + actions.filter(item => item.kind === "add_child").length
          );
          break;
        case "research_standard":
          // Quick: the research call alone (no images or charts). Standard: the research call plus the diagram call.
          calls +=
            targetCount(action.nodeIds, selection) *
            (chatResearchMode(action, options.mapAiMode) === "quick" ? 1 : perTask);
          break;
        case "expand":
          calls += targetCount(action.nodeIds, selection) * MAP_CHAT_EXPAND_CALLS_PER_CARD;
          break;
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
    }
  }
  return calls;
}

const AUTO_ALLOWED_KINDS: ReadonlySet<MapChatAction["kind"]> = new Set<MapChatAction["kind"]>([
  "add_child",
  "rename_topic",
  "update_summary",
  "edit_topic_note",
  "set_topic_kind",
  "move_topic",
  "reorder_topics",
  "add_relation",
  "remove_relation",
  "set_appearance",
  "select_topics",
  "focus_topic",
  "collapse_topic",
  "expand_topic",
  "auto_layout",
  "ask_topic_kind"
]);
const AUTO_ALLOWED_RUN: ReadonlySet<string> = new Set(["research_standard", "expand", "find_images", "synthesize"]);

/** A vault path as a list of segments, or null when it is absolute, empty or climbs out with `..`. */
function pathSegments(path: string): string[] | null {
  const raw = path.replace(/\\/g, "/");
  if (raw.startsWith("/")) return null;
  const parts = raw.split("/").filter(part => part !== "" && part !== ".");
  return parts.length && !parts.includes("..") ? parts : null;
}
/** True when `path` is one of `paths` (same segments). */
function isReadablePath(path: string, paths: readonly string[] | undefined): boolean {
  const own = pathSegments(path)?.join("/");
  return !!own && !!paths?.some(item => pathSegments(item)?.join("/") === own);
}
/** True when `path` is a file inside `folder` (whole segments, so "Foo" does not hold "Foobar/x.md"; no `..` escape). */
export function isInsideMapFolder(path: string, folder: string | undefined): boolean {
  if (!folder) return false;
  const inner = pathSegments(path);
  const base = pathSegments(folder);
  if (!inner || !base || inner.length <= base.length) return false;
  return base.every((part, index) => inner[index] === part);
}

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
    /** This conversation sent the map's data sources in this turn or an earlier one: the same allow-list applies. */
    chatReadSources?: boolean;
    /** "Apply this whole conversation automatically": skips the size and other-actions rules for the allow-listed actions; deleting, maps and files outside `mapFolder` still get a plan. */
    autoApply?: boolean;
    /** Folder of the current Map.md: md files inside it are allowed under `autoApply`. */
    mapFolder?: string;
    /** Attached or own files the chat may read (read_md_file only, never edits): allowed under `autoApply` even outside `mapFolder`. */
    readablePaths?: readonly string[];
    /** AI calls this segment of the chain already made (the call budget under `autoApply`). */
    callsSoFar?: number;
    /**
     * The user explicitly asked for a change (the reply's `changeRequested`, decision 2026-11-28-vam-v3-3#33). `false`: every write is a
     * plan and `autoApply` does not apply. Absent: not judged (callers that apply a model reply always pass it).
     */
    changeRequested?: boolean;
  } = {}
): MapChatPlan | null {
  const reasons: MapChatPlanReason[] = [];
  const notRequested = options.changeRequested === false;
  // Auto-apply is only for what the user asked to change: a question does not turn into writes with the switch on.
  const auto = options.autoApply === true && !notRequested;
  if (notRequested && actions.some(action => !READ_ONLY_KINDS.has(action.kind))) reasons.push("not_requested");
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
  const readsSources = options.chatReadSources === true;
  const readsResearch = autoRound || options.chatStartedResearch === true || readsSources;
  const onlySafe =
    readsResearch &&
    resolveSelectionTargets(actions).every(action => isFindImages(action) || isChainSafeFor(action, options.trusted));
  const autoOnlySafe = autoRound && onlySafe;
  // find_images never needs a plan (owner: pictures are put in without asking), so it does not count toward the action limit or the other-actions rules.
  // read_md_file writes nothing and is never shown (decision 2026-11-15-map-chat-file-bugs#2): it does not count either.
  const planned = actions.filter(action => !isFindImages(action) && action.kind !== "read_md_file");
  if (planned.length > MAP_CHAT_PLAN_ACTION_LIMIT && !imageAddsOnly && !autoOnlySafe && !auto)
    reasons.push("many_actions");
  const research = researchTargetsOf(actions, context.selectedCount);
  const calls = estimateChatCalls(actions, context, options);
  const createsMap = actions.some(action => action.kind === "create_map");
  if (!auto && research > 0 && research + (options.chain?.researchSoFar ?? 0) >= MAP_CHAT_PLAN_RESEARCH_LIMIT)
    reasons.push("many_research");
  if (createsMap) reasons.push("new_map");
  if (
    actions.some(
      action =>
        action.kind === "configure_ai_card" ||
        (action.kind === "add_child" && !!action.livingPrompt) ||
        (action.kind === "run_map_action" &&
          (action.action === "run_living_card" || action.action === "run_living_all"))
    )
  )
    reasons.push("living_node_confirm");
  if (
    actions.some(
      action =>
        action.kind === "edit_book_plan" || action.kind === "edit_book_structure" || action.kind === "edit_book_thread"
    )
  )
    reasons.push("book_plan_edit");
  // Moving an anchor changes what the user placed: always a plan, whatever the image mode or auto-apply say (G06a).
  if (actions.some(action => action.kind === "move_anchor")) reasons.push("move_anchor_confirm");
  if (
    options.imageMode === "preview" &&
    actions.some(action => action.kind === "add_anchor" || action.kind === "link_anchor")
  )
    reasons.push("image_preview");
  if (
    options.imageAttached &&
    actions.some(action => !isFindImages(action) && action.kind !== "move_anchor" && !IMAGE_SAFE_KINDS.has(action.kind))
  )
    reasons.push("image_other_actions");
  // Under autoApply the allow-listed actions are not held back by the other-actions rules; anything else is.
  const autoAllowed = (action: MapChatAction): boolean =>
    isFindImages(action) ||
    (action.kind === "run_map_action" ? AUTO_ALLOWED_RUN.has(action.action) : AUTO_ALLOWED_KINDS.has(action.kind)) ||
    ((action.kind === "edit_md_file" || action.kind === "create_md_file" || action.kind === "read_md_file") &&
      isInsideMapFolder(action.path, options.mapFolder)) ||
    (action.kind === "read_md_file" && isReadablePath(action.path, options.readablePaths)) ||
    (isPlaceImage(action) && !readsResearch && options.imageAttached !== true) ||
    (imageAddsOnly && IMAGE_SAFE_KINDS.has(action.kind));
  const allAllowed = auto && actions.every(autoAllowed);
  if (readsResearch && !onlySafe && !allAllowed)
    reasons.push(
      autoRound
        ? "auto_round_other_actions"
        : options.chatStartedResearch === true
          ? "research_text_other_actions"
          : "source_text_other_actions"
    );
  if (auto && calls + (options.callsSoFar ?? 0) > MAP_CHAT_AUTO_MAX_CALLS) reasons.push("call_budget");
  // Nothing above caught an action that auto-apply does not allow (e.g. a delete with no research read): it is still a plan.
  if (auto && !allAllowed && !reasons.length) reasons.push("auto_apply_confirm");
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
  /** The user explicitly asked for the whole note to be rewritten: this research replaces it ("fresh"). Present only when true. */
  rewrite?: true;
}
/**
 * The mode a research runs in: the mode the user named, then Standard when the model says the research needs the web
 * (`needsWeb`) or the user asked for images (`images`; the reply text is not scanned), then the mode the map remembers,
 * then Quick (D-2026-10-228, 231; the web rule replaces 228's "no guess at how unfamiliar the topic is", map chat only).
 * Whether the targets are all new cards no longer matters. Decided here, not by the model: it only states the fact.
 */
export function chatResearchMode(
  action: Extract<MapChatAction, { kind: "run_map_action" }>,
  mapAiMode: MapAiMode | undefined
): MapAiMode {
  if (action.mode) return action.mode;
  // Images need a web image search, which only Standard runs: asking for them is a web signal like needsWeb.
  if (action.needsWeb === true || action.images === true) return "standard";
  return mapAiMode || "quick";
}
/** The research options of a mode (the view hands in `aiModeOptions(mode, "research")`; core does not import an experience). */
export type ChatModeOptions = (mode: MapAiMode) => { researchMode: ResearchMode; researchDepth: ResearchDepth };
/**
 * A YouTube url the chat model wrote into a research direction is passed on only when the user wrote it (`userWords`: their
 * messages of this conversation): the research keeps a pasted video, so a url the chat model made up must not reach it.
 */
export function keepPastedVideoUrls(actions: readonly MapChatAction[], userWords: string): MapChatAction[] {
  const pasted = new Set(videoUrlsInText(userWords).map(url => youtubeVideoId(url)));
  return actions.map(action => {
    if (action.kind !== "run_map_action" || !action.direction) return action;
    const urls = videoUrlsInText(action.direction).filter(url => !pasted.has(youtubeVideoId(url)));
    if (!urls.length) return action;
    let direction = action.direction;
    for (const url of urls) direction = direction.split(url).join("");
    return { ...action, direction };
  });
}

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
    imageSearch: mode === "standard" && action.images === true,
    ...(action.rewrite ? { rewrite: true as const } : {})
  };
}
