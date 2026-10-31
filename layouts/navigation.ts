import type { LayoutKind } from "../map-layout";

/** Where an arrow key moves the selection: to the parent, the first child, or the previous or next sibling. */
export type NeighborMove = "parent" | "child" | "sibling-" | "sibling+";

const ARROWS = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"];

/**
 * Maps an arrow key to a move in a map laid out in `direction`. Right and left map branches sideways (left mirrors
 * right); down maps Up to the parent and Down to the first child with Left and Right moving between siblings by x;
 * up swaps Up and Down again. Arrangements without their own mapping follow the right layout. Other keys give null.
 */
export function neighborKey(direction: LayoutKind, key: string): NeighborMove | null {
  if (!ARROWS.includes(key)) return null;
  if (direction === "down" || direction === "up") {
    if (key === "ArrowLeft") return "sibling-";
    if (key === "ArrowRight") return "sibling+";
    const towardsChild = direction === "down" ? "ArrowDown" : "ArrowUp";
    return key === towardsChild ? "child" : "parent";
  }
  const left = direction === "left";
  if (key === (left ? "ArrowRight" : "ArrowLeft")) return "parent";
  if (key === (left ? "ArrowLeft" : "ArrowRight")) return "child";
  return key === "ArrowUp" ? "sibling-" : "sibling+";
}
