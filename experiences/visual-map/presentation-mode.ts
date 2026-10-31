/**
 * Presentation mode, the parts that need no DOM: what a key means, where to start, how to step through the reading
 * order without wrapping, and which topic takes over when the current one disappears during a repaint.
 */
import { stepOrder } from "./presentation-order";

export type PresentationAction = "next" | "prev" | "first" | "last" | "exit" | "block";

export interface PresentationKeyEvent {
  key: string;
  code?: string;
  isComposing?: boolean;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}

/** What survives in memory while presenting: the way back is the viewport, the selection and the focus origin from before. */
export interface PresentationState {
  order: string[];
  currentId: string;
  viewport: { x: number; y: number; zoom: number };
  selected: string | null;
  multiSelected: string[];
  returnNodeId: string | null;
  returnEl: HTMLElement | null;
}

export type PresentationMove =
  { kind: "move"; id: string; index: number; total: number } | { kind: "edge"; edge: "first" | "last" } | null;

const NEXT_KEYS = new Set(["ArrowRight", "ArrowDown", "PageDown"]);
const PREV_KEYS = new Set(["ArrowLeft", "ArrowUp", "PageUp"]);
const READ_ONLY_KEYS = new Set(["Delete", "Backspace", "Enter", "F2"]);

/** Null means the key is not ours (composition, letters, Tab); "block" swallows a key that would edit or walk the tree. */
export function classifyPresentationKey(event: PresentationKeyEvent): PresentationAction | null {
  if (event.isComposing) return null;
  const mod = !!(event.ctrlKey || event.metaKey);
  const plain = !mod && !event.altKey && !event.shiftKey;
  const key = event.key;
  if (key === "Escape") return "exit";
  if (READ_ONLY_KEYS.has(key)) return "block";
  if (mod && (key === "z" || key === "Z")) return "block";
  if (key === " " || event.code === "Space") {
    if (mod || event.altKey) return "block";
    return event.shiftKey ? "prev" : "next";
  }
  if (NEXT_KEYS.has(key) || PREV_KEYS.has(key) || key === "Home" || key === "End") {
    if (!plain) return "block";
    if (key === "Home") return "first";
    if (key === "End") return "last";
    return NEXT_KEYS.has(key) ? "next" : "prev";
  }
  return null;
}

/** The selected topic when it is in the order, else the first one. */
export function startingId(order: readonly string[], selectedId: string | null): string | null {
  if (selectedId !== null && order.includes(selectedId)) return selectedId;
  return order.length ? order[0] : null;
}

/** next / prev stop at the ends (an "edge"); first / last always land. */
export function moveInOrder(
  order: string[],
  currentId: string,
  action: "next" | "prev" | "first" | "last"
): PresentationMove {
  const total = order.length;
  if (!total) return null;
  if (action === "first") return { kind: "move", id: order[0], index: 0, total };
  if (action === "last") return { kind: "move", id: order[total - 1], index: total - 1, total };
  const step = stepOrder(order, currentId, action === "next" ? 1 : -1);
  if (step) return { kind: "move", id: step.id, index: step.index, total: step.total };
  return { kind: "edge", edge: action === "next" ? "last" : "first" };
}

/** The topic to show after the order changed: the same one, else the nearest following in the old order, else the nearest before, else the first. */
export function reconcileCurrent(
  oldOrder: readonly string[],
  newOrder: readonly string[],
  currentId: string
): string | null {
  if (newOrder.includes(currentId)) return currentId;
  const keep = new Set(newOrder);
  const at = oldOrder.indexOf(currentId);
  if (at >= 0) {
    for (let i = at + 1; i < oldOrder.length; i++) if (keep.has(oldOrder[i])) return oldOrder[i];
    for (let i = at - 1; i >= 0; i--) if (keep.has(oldOrder[i])) return oldOrder[i];
  }
  return newOrder.length ? newOrder[0] : null;
}
