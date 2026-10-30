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

/** Gap between neighbouring lines that join the same two topics. */
export const RELATION_OFFSET_STEP = 12;

function curveOf(a: RelationBox, b: RelationBox, offset = 0): Curve {
  const { from, to, gap } = nearestSides(a, b),
    length = gap > 0 ? controlLength(gap) : 0;
  let sx = 0,
    sy = 0;
  if (offset) {
    // Slide the whole curve sideways along the edge (the normal of the `a` side turned a quarter); cards that overlap
    // have no normal, so the centre-to-centre chord is turned instead.
    let nx = from.nx,
      ny = from.ny;
    if (!nx && !ny) {
      nx = to.x - from.x;
      ny = to.y - from.y;
      const size = Math.hypot(nx, ny) || 1;
      nx /= size;
      ny /= size;
    }
    sx = -ny * offset;
    sy = nx * offset;
  }
  return {
    p1: { x: from.x + sx, y: from.y + sy },
    c1: { x: from.x + from.nx * length + sx, y: from.y + from.ny * length + sy },
    c2: { x: to.x + to.nx * length + sx, y: to.y + to.ny * length + sy },
    p2: { x: to.x + sx, y: to.y + sy }
  };
}

/**
 * Cubic Bezier from the nearest edge of `a` to the nearest edge of `b`; the arms follow the edges' normals, so it never takes a wide arc.
 * `offset` slides the line sideways (px) so parallel relations do not lie on top of each other.
 */
export function relationPathData(a: RelationBox, b: RelationBox, offset = 0): string {
  const { p1, c1, c2, p2 } = curveOf(a, b, offset);
  return `M ${p1.x} ${p1.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${p2.x} ${p2.y}`;
}

/** Midpoint of the same curve (t = 0.5), where the label sits. */
export function relationMidpoint(a: RelationBox, b: RelationBox, offset = 0): { x: number; y: number } {
  const { p1, c1, c2, p2 } = curveOf(a, b, offset);
  return { x: (p1.x + 3 * c1.x + 3 * c2.x + p2.x) / 8, y: (p1.y + 3 * c1.y + 3 * c2.y + p2.y) / 8 };
}

/**
 * One sideways offset (px) per relation, in list order. Relations on the same pair of topics (either direction) fan out:
 * 0, +12, -12, +24, -24 ... A single relation stays at 0. The offset is in a frame fixed by the pair (smaller id to
 * larger id), so a reversed relation still lands on its own side instead of crossing back onto the first line.
 */
export function relationOffsets(relations: readonly { from: string; to: string }[]): number[] {
  const seen = new Map<string, number>();
  return relations.map(({ from, to }) => {
    const forward = from <= to,
      key = forward ? `${from}\u0000${to}` : `${to}\u0000${from}`,
      index = seen.get(key) ?? 0;
    seen.set(key, index + 1);
    const step = Math.ceil(index / 2) * RELATION_OFFSET_STEP,
      signed = index % 2 === 1 ? step : -step;
    return signed * (forward ? 1 : -1) || 0;
  });
}
