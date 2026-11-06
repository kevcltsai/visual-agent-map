import type { MapChatAction } from "./steps/map-chat/step";

/**
 * Rules of the map chat's first-window layout that have no DOM in them: how wide the side window may be, when it folds to a
 * narrow edge, how result lines are counted and how a plan's actions are grouped.
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
 * now (folding widens it, and judging by that would unfold the window again at once). `inspector` is the width of the
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

export interface ChatLineCounts {
  done: number;
  skipped: number;
  failed: number;
}
type ChatLineLike = { status: "done" | "skipped" | "failed"; text: string };
const noteSet = (notes?: string | readonly string[]): readonly string[] =>
  notes === undefined ? [] : typeof notes === "string" ? [notes] : notes;
/** Splits result lines from notes (the "cannot be undone" line, the auto-layout line): notes show but are not results. */
export function splitChatLines<T extends ChatLineLike>(
  lines: readonly T[],
  notes?: string | readonly string[]
): { results: T[]; notes: T[] } {
  const texts = noteSet(notes);
  return {
    results: lines.filter(line => !texts.includes(line.text)),
    notes: lines.filter(line => texts.includes(line.text))
  };
}
/** Counts result lines by status. `ignore` lines (the closing "cannot be undone" note, the auto-layout note) are not results. */
export function countChatLines(lines: readonly ChatLineLike[], ignore?: string | readonly string[]): ChatLineCounts {
  const counts: ChatLineCounts = { done: 0, skipped: 0, failed: 0 };
  for (const line of splitChatLines(lines, ignore).results) counts[line.status]++;
  return counts;
}

export type ChatPlanGroup = "create" | "change" | "delete" | "research" | "view";
export const CHAT_PLAN_GROUP_ORDER: readonly ChatPlanGroup[] = ["create", "change", "delete", "research", "view"];

/** The kind of work an action is, for the plan card's folded lists. */
export function chatPlanGroupOf(kind: MapChatAction["kind"]): ChatPlanGroup {
  switch (kind) {
    case "add_child":
    case "add_anchor":
    case "link_anchor":
    case "create_md_file":
    case "create_map":
      return "create";
    case "rename_topic":
    case "update_summary":
    case "edit_topic_note":
    case "move_topic":
    case "reorder_topics":
    case "edit_md_file":
    case "set_topic_kind":
    case "ask_topic_kind":
    case "add_relation":
    case "set_appearance":
    case "rename_map":
      return "change";
    case "delete_topic":
    case "remove_relation":
      return "delete";
    case "select_topics":
    case "run_map_action":
      return "research";
    default:
      return "view";
  }
}
