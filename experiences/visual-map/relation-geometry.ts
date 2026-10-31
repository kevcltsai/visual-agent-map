import type { LayoutKind } from "../../map-layout";

/** A card's rectangle on the stage. */
export interface RelationBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Where a line meets a card: the point, and the unit vector pointing away from the card there. */
export interface RelationAnchor {
  x: number;
  y: number;
  nx: number;
  ny: number;
}

export const MIN_CONTROL = 16;
export const MAX_CONTROL = 60;

/** Distance between two cards along one axis; negative when they overlap on that axis. */
function axisGap(aStart: number, aSize: number, bStart: number, bSize: number): number {
  return Math.max(bStart - (aStart + aSize), aStart - (bStart + bSize));
}

const centreOf = (box: RelationBox): { x: number; y: number } => ({
  x: box.x + box.width / 2,
  y: box.y + box.height / 2
});

/**
 * The two edge midpoints a semantic line joins. When the horizontal gap is at least the vertical gap the cards face each
 * other left and right; otherwise top and bottom. Cards that overlap on both axes join centre to centre (no normal).
 * `gap` is the distance the line crosses, which sets the length of the curve's control arms.
 */
export function nearestSides(
  a: RelationBox,
  b: RelationBox
): { from: RelationAnchor; to: RelationAnchor; gap: number } {
  const horizontal = axisGap(a.x, a.width, b.x, b.width),
    vertical = axisGap(a.y, a.height, b.y, b.height);
  if (horizontal < 0 && vertical < 0) {
    const from = centreOf(a),
      to = centreOf(b);
    return { from: { ...from, nx: 0, ny: 0 }, to: { ...to, nx: 0, ny: 0 }, gap: 0 };
  }
  if (horizontal >= vertical) {
    const rightward = centreOf(b).x >= centreOf(a).x,
      sign = rightward ? 1 : -1;
    return {
      from: { x: rightward ? a.x + a.width : a.x, y: a.y + a.height / 2, nx: sign, ny: 0 },
      to: { x: rightward ? b.x : b.x + b.width, y: b.y + b.height / 2, nx: -sign, ny: 0 },
      gap: horizontal
    };
  }
  const downward = centreOf(b).y >= centreOf(a).y,
    sign = downward ? 1 : -1;
  return {
    from: { x: a.x + a.width / 2, y: downward ? a.y + a.height : a.y, nx: 0, ny: sign },
    to: { x: b.x + b.width / 2, y: downward ? b.y : b.y + b.height, nx: 0, ny: -sign },
    gap: vertical
  };
}

const controlLength = (gap: number): number => Math.min(MAX_CONTROL, Math.max(MIN_CONTROL, gap / 2));

interface Curve {
  p1: { x: number; y: number };
  c1: { x: number; y: number };
  c2: { x: number; y: number };
  p2: { x: number; y: number };
}

function curveOf(a: RelationBox, b: RelationBox): Curve {
  const { from, to, gap } = nearestSides(a, b),
    length = gap > 0 ? controlLength(gap) : 0;
  return {
    p1: { x: from.x, y: from.y },
    c1: { x: from.x + from.nx * length, y: from.y + from.ny * length },
    c2: { x: to.x + to.nx * length, y: to.y + to.ny * length },
    p2: { x: to.x, y: to.y }
  };
}

/** Cubic Bezier from the nearest edge of `a` to the nearest edge of `b`; the arms follow the edges' normals, so it never takes a wide arc. */
export function relationPathData(a: RelationBox, b: RelationBox): string {
  const { p1, c1, c2, p2 } = curveOf(a, b);
  return `M ${p1.x} ${p1.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${p2.x} ${p2.y}`;
}

/** Where the label sits: the midpoint of the line (t = 0.5). */
export function relationLabelPoint(a: RelationBox, b: RelationBox): { x: number; y: number } {
  const { p1, c1, c2, p2 } = curveOf(a, b);
  return { x: (p1.x + 3 * c1.x + 3 * c2.x + p2.x) / 8, y: (p1.y + 3 * c1.y + 3 * c2.y + p2.y) / 8 };
}

/**
 * The curve from a parent card to its child in a tree laid out in `direction`. "right" runs from the parent's right edge
 * to the child's left edge, exactly as `edgePathData` in view.ts; "left" mirrors it, from the parent's left edge to the
 * child's right edge, with both arms bending outward.
 * "down" runs from the parent's bottom edge midpoint to the child's top edge midpoint; "up" runs from the parent's top
 * edge midpoint to the child's bottom edge midpoint.
 * "radial" runs between the nearest edge midpoints of the two cards (see `nearestSides`), so a ring of children fans out
 * in every direction.
 * "fishbone" draws straight lines. A first-level topic (depth 1) is joined by its bone: from the spine point on the
 * head's middle line to the midpoint of the topic card's edge that faces the spine, leaning 60 degrees towards the head. A
 * detail of a topic (depth 2) hangs on that bone by a horizontal rib that ends at the right edge midpoint of the detail
 * card; whether the topic is above or below the spine follows from where the detail stands. Deeper cards (depth 3 and more)
 * use the "left" curve. `depth` is the child's distance from its root and is only read for "fishbone".
 * "balanced" uses the "left" curve when the child's centre is left of the parent's centre and the "right" curve otherwise.
 */
export function treeEdgePathData(parent: RelationBox, child: RelationBox, direction: LayoutKind, depth = 1): string {
  if (direction === "radial") return relationPathData(parent, child);
  if (direction === "fishbone")
    return depth >= 3 ? treeEdgePathData(parent, child, "left") : fishboneEdgePathData(parent, child, depth);
  if (direction === "down" || direction === "up") {
    const x1 = parent.x + parent.width / 2,
      x2 = child.x + child.width / 2,
      down = direction === "down",
      y1 = down ? parent.y + parent.height : parent.y,
      y2 = down ? child.y : child.y + child.height,
      bend = Math.max(60, Math.abs(y2 - y1) / 2),
      sign = down ? 1 : -1;
    return `M ${x1} ${y1} C ${x1} ${y1 + sign * bend}, ${x2} ${y2 - sign * bend}, ${x2} ${y2}`;
  }
  const y1 = parent.y + parent.height / 2,
    y2 = child.y + child.height / 2;
  const leftward =
    direction === "balanced" ? child.x + child.width / 2 < parent.x + parent.width / 2 : direction === "left";
  if (leftward) {
    const x1 = parent.x,
      x2 = child.x + child.width,
      bend = Math.max(60, Math.abs(x2 - x1) / 2);
    return `M ${x1} ${y1} C ${x1 - bend} ${y1}, ${x2 + bend} ${y2}, ${x2} ${y2}`;
  }
  const x1 = parent.x + parent.width,
    x2 = child.x,
    bend = Math.max(60, Math.abs(x2 - x1) / 2);
  return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
}

/** Horizontal run of a 60 degree bone for each unit of height it climbs (the same angle the fishbone layout uses). */
const BONE_RUN = 1 / Math.tan(Math.PI / 3);

/** The straight line of a fishbone: a bone for a first-level topic, a rib for one of its details. */
function fishboneEdgePathData(parent: RelationBox, child: RelationBox, depth: number): string {
  const parentY = parent.y + parent.height / 2,
    childY = child.y + child.height / 2;
  if (depth <= 1) {
    const above = childY < parentY,
      x = child.x + child.width / 2,
      y = above ? child.y + child.height : child.y,
      jointX = x + Math.abs(parentY - y) * BONE_RUN;
    return `M ${jointX} ${parentY} L ${x} ${y}`;
  }
  // The topic is the parent: above the spine its details lie below it, and the bone leaves its bottom edge midpoint.
  const above = childY > parentY,
    x = parent.x + parent.width / 2,
    y = above ? parent.y + parent.height : parent.y,
    boneX = x + Math.abs(childY - y) * BONE_RUN;
  return `M ${boneX} ${childY} L ${child.x + child.width} ${childY}`;
}
