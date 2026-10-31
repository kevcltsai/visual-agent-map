import type { LayoutKind } from "../map-layout";

/** Where an arrow key moves the selection: to the parent, the first child, or the previous or next sibling. */
export type NeighborMove = "parent" | "child" | "sibling-" | "sibling+" | "child-left" | "child-right";

/** Where the selected card stands in a balanced map: on the root, or on its right or left half. */
export type NavigationSide = "root" | "left" | "right";

const ARROWS = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"];

/**
 * Maps an arrow key to a move in a map laid out in `direction`. Right and left map branches sideways (left mirrors
 * right); down maps Up to the parent and Down to the first child with Left and Right moving between siblings by x;
 * up swaps Up and Down again. In a balanced map the card's `side` picks the rule: cards on the left half follow left,
 * cards on the right half follow right, and on the root Left and Right go to the first child on that side. Arrangements
 * without their own mapping follow the right layout. Other keys give null.
 */
export function neighborKey(direction: LayoutKind, key: string, side?: NavigationSide): NeighborMove | null {
  if (!ARROWS.includes(key)) return null;
  if (direction === "balanced" && side === "root") {
    if (key === "ArrowLeft") return "child-left";
    if (key === "ArrowRight") return "child-right";
    return key === "ArrowUp" ? "sibling-" : "sibling+";
  }
  if (direction === "balanced") direction = side === "left" ? "left" : "right";
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
