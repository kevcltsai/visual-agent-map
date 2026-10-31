/** What the radial engine needs to know about the tree; the caller decides what is collapsed or joined. */
export interface RadialInput<T extends { id: string }> {
  roots: T[];
  /** Children shown around a card. */
  kidsOf: (node: T) => T[];
  /** Converging conclusions; they are placed like children in this arrangement. */
  joinsOf: (node: T) => T[];
  heightFor: (node: T) => number;
  /** Card width, the same for every card. */
  width: number;
  /** Distance between two neighbouring rings at the least. */
  column: number;
  /** Space kept between two cards that stand close above one another. */
  gap: number;
  left: number;
  top: number;
}

const TAU = Math.PI * 2;
/** How much a ring grows each time cards on it (or on the ring below) still touch, as a share of the column. */
const GROW = 6;
/** Upper bound on growth rounds, so a degenerate input can never loop forever. */
const MAX_ROUNDS = 4000;

interface Spot {
  id: string;
  depth: number;
  /** Clockwise from straight up, in radians. */
  angle: number;
  height: number;
}

/**
 * Places each tree on rings around its root: depth decides the ring, the angle of a branch is proportional to its
 * number of leaves (clockwise, starting straight up), and a card's centre sits at its branch's middle angle. A ring's
 * radius is the larger of depth times column and what it takes for its cards not to touch; rings are at least a column
 * apart. Several roots are stacked from top to bottom. Returns each card's top-left corner.
 */
export function radialPositions<T extends { id: string }>(
  input: RadialInput<T>
): Map<string, { x: number; y: number }> {
  const { roots, kidsOf, joinsOf, heightFor, width, column, gap, left, top } = input;
  const result = new Map<string, { x: number; y: number }>();
  let offset = top;
  for (const root of roots) {
    const spots: Spot[] = [];
    const leaves = new Map<string, number>();
    const childrenOf = (node: T): T[] => [...kidsOf(node), ...joinsOf(node)];
    const count = (node: T): number => {
      const kids = childrenOf(node);
      const total = kids.length ? kids.reduce((sum, kid) => sum + count(kid), 0) : 1;
      leaves.set(node.id, total);
      return total;
    };
    count(root);
    const spread = (node: T, depth: number, start: number, end: number): void => {
      spots.push({ id: node.id, depth, angle: (start + end) / 2, height: heightFor(node) });
      let next = start;
      const share = (end - start) / leaves.get(node.id)!;
      for (const kid of childrenOf(node)) {
        const slice = share * leaves.get(kid.id)!;
        spread(kid, depth + 1, next, next + slice);
        next += slice;
      }
    };
    spread(root, 0, 0, TAU);
    const deepest = Math.max(...spots.map(spot => spot.depth));
    const base = Array.from({ length: deepest + 1 }, (_, depth) => depth * column);
    const place = (): Map<string, { x: number; y: number; depth: number; height: number }> => {
      const radii: number[] = [];
      base.forEach((value, depth) => radii.push(depth ? Math.max(value, radii[depth - 1] + column) : 0));
      return new Map(
        spots.map(spot => {
          const radius = radii[spot.depth];
          return [
            spot.id,
            {
              x: Math.round(radius * Math.sin(spot.angle) - width / 2),
              y: Math.round(-radius * Math.cos(spot.angle) - spot.height / 2),
              depth: spot.depth,
              height: spot.height
            }
          ];
        })
      );
    };
    let placed = place();
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const list = [...placed.values()];
      const grow = new Set<number>();
      for (let i = 0; i < list.length; i++)
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i],
            b = list[j];
          if (Math.abs(a.x - b.x) < width && a.y < b.y + b.height + gap && b.y < a.y + a.height + gap)
            grow.add(Math.max(a.depth, b.depth));
        }
      if (!grow.size) break;
      for (const depth of grow) base[depth] += column / GROW;
      placed = place();
    }
    const minX = Math.min(...[...placed.values()].map(point => point.x));
    const minY = Math.min(...[...placed.values()].map(point => point.y));
    const maxY = Math.max(...[...placed.values()].map(point => point.y + point.height));
    for (const [id, point] of placed)
      result.set(id, { x: Math.round(left) + point.x - minX, y: offset + point.y - minY });
    offset += maxY - minY + gap;
  }
  return result;
}
