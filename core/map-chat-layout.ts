import type { TranslationKey } from "../i18n/en";
import type { MapChatAction } from "./steps/map-chat/step";

/**
 * Rules of the map chat's first-window layout that have no DOM in them: how wide the side window may be, when it folds to a
 * narrow edge, which messages it suggests, how result lines are counted and how a plan's actions are grouped.
 */

export const MAP_CHAT_WIDTH_DEFAULT = 340;
export const MAP_CHAT_WIDTH_MIN = 280;
export const MAP_CHAT_WIDTH_MAX = 560;
/** One arrow-key press on the width handle. */
export const MAP_CHAT_WIDTH_STEP = 16;
/** The canvas keeps at least this much width beside the docked window. */
export const MAP_CHAT_MIN_CANVAS = 360;
/** A folded window docks again only when the pane is this much wider than the fold limit, so a pane on the limit does not flicker. */
export const MAP_CHAT_NARROW_HYSTERESIS = 24;
/** The laid-over window leaves at least this much of the pane visible beside it. */
export const MAP_CHAT_OVERLAY_MARGIN = 160;
/** More result lines than this fold into a count. */
export const MAP_CHAT_LINES_FOLD_ABOVE = 5;

/** A saved or dragged width as a usable one: a whole number from the minimum to the maximum; anything else is the default. */
export function clampMapChatWidth(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return MAP_CHAT_WIDTH_DEFAULT;
  return Math.min(MAP_CHAT_WIDTH_MAX, Math.max(MAP_CHAT_WIDTH_MIN, Math.round(value)));
}

/**
 * Whether the side window folds to a narrow edge: only when even the narrowest window (280px) would leave the canvas less than
 * 360px. The set width does not matter (a docked window gives way down to 280), and neither does the width the canvas has right
 * now (folding widens it, and judging by that would unfold the window again at once). `inspector` is the width of the sample's
 * inspector beside the canvas. A window that is folded stays folded until the pane is a little wider than the limit.
 */
export function isChatNarrow(paneWidth: number, inspector = 0, wasNarrow = false): boolean {
  const limit = MAP_CHAT_WIDTH_MIN + MAP_CHAT_MIN_CANVAS + (wasNarrow ? MAP_CHAT_NARROW_HYSTERESIS : 0);
  return paneWidth - inspector < limit;
}

/** The width of the docked window: the set width, but never so wide that the canvas gets under 360px (280px at the least). */
export function chatDockedWidth(paneWidth: number, setWidth: number, inspector = 0): number {
  return Math.max(MAP_CHAT_WIDTH_MIN, Math.min(setWidth, paneWidth - inspector - MAP_CHAT_MIN_CANVAS));
}

/** The width of the window laid over a narrow pane: the set width, leaving 160px of the pane visible (280px at the least). */
export function chatOverlayWidth(paneWidth: number, setWidth: number): number {
  return Math.max(MAP_CHAT_WIDTH_MIN, Math.min(setWidth, paneWidth - MAP_CHAT_OVERLAY_MARGIN));
}

export interface ChatSuggestionContext {
  /** Cards selected on the map. */
  selected: number;
  /** A note is open beside the map. */
  hasNote: boolean;
  /** The map has at least one card. */
  hasTopics: boolean;
}

/** Two to four messages worth sending now. Choosing one only fills the message field. */
export function chatSuggestionKeys(context: ChatSuggestionContext): TranslationKey[] {
  const keys: TranslationKey[] = !context.hasTopics
    ? ["ui.map_chat_suggest_empty_build", "ui.map_chat_suggest_empty_new_map"]
    : context.selected > 1
      ? ["ui.map_chat_suggest_many_compare", "ui.map_chat_suggest_many_integrate", "ui.map_chat_suggest_many_group"]
      : context.selected === 1
        ? ["ui.map_chat_suggest_one_expand", "ui.map_chat_suggest_one_research", "ui.map_chat_suggest_one_summary"]
        : ["ui.map_chat_suggest_all_missing", "ui.map_chat_suggest_all_layout", "ui.map_chat_suggest_all_collapse"];
  if (context.hasNote)
    keys.push(context.hasTopics ? "ui.map_chat_suggest_note_add" : "ui.map_chat_suggest_empty_from_note");
  return keys;
}

/** The three starting sentences on the opening screen. */
export const MAP_CHAT_EXAMPLE_KEYS: readonly TranslationKey[] = [
  "ui.map_chat_example_research",
  "ui.map_chat_example_learn",
  "ui.map_chat_example_decide"
];

export interface ChatLineCounts {
  done: number;
  skipped: number;
  failed: number;
}
/** Counts result lines by status. `ignore` lines (the closing "cannot be undone" note) are not results. */
export function countChatLines(
  lines: readonly { status: "done" | "skipped" | "failed"; text: string }[],
  ignore?: string
): ChatLineCounts {
  const counts: ChatLineCounts = { done: 0, skipped: 0, failed: 0 };
  for (const line of lines) if (line.text !== ignore) counts[line.status]++;
  return counts;
}

export type ChatPlanGroup = "create" | "change" | "delete" | "research" | "view";
export const CHAT_PLAN_GROUP_ORDER: readonly ChatPlanGroup[] = ["create", "change", "delete", "research", "view"];

/** The kind of work an action is, for the plan card's folded lists. */
export function chatPlanGroupOf(kind: MapChatAction["kind"]): ChatPlanGroup {
  switch (kind) {
    case "add_child":
    case "create_md_file":
    case "create_map":
      return "create";
    case "rename_topic":
    case "update_summary":
    case "edit_topic_note":
    case "move_topic":
    case "edit_md_file":
      return "change";
    case "delete_topic":
      return "delete";
    case "select_topics":
    case "run_map_action":
      return "research";
    default:
      return "view";
  }
}
