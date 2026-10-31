/** What the vertical engine needs to know about the tree; the caller decides what is collapsed or joined. */
export interface VerticalInput<T extends { id: string }> {
  roots: T[];
  /** Children shown directly below (or above) a card. */
  kidsOf: (node: T) => T[];
  /** Converging conclusions that join after the deepest of their siblings. */
  joinsOf: (node: T) => T[];
  heightFor: (node: T) => number;
  /** Horizontal distance between neighbouring leaf cards (a card plus the space around it). */
  column: number;
  /** Space between one level's tallest card and the next level. */
  rowGap: number;
  /** False grows downward from the root, true grows upward (the mirror image). */
  flip: boolean;
  left: number;
  top: number;
}

/**
 * Places a tree level by level: depth decides y, siblings spread along x, a parent is centred over its children.
 * Every card of one level shares the top edge (downward) or the bottom edge (upward); a level is as tall as its tallest
 * card. Roots sit side by side. Returns each card's top-left corner.
 */
export function verticalPositions<T extends { id: string }>(
  input: VerticalInput<T>
): Map<string, { x: number; y: number }> {
  const { roots, kidsOf, joinsOf, heightFor, column, rowGap, flip, left, top } = input;
  const widths = new Map<string, number>();
  const spans = new Map<string, number>();
  const rowWidth = (list: T[]) => list.reduce((total, item) => total + widths.get(item.id)!, 0);
  const measure = (node: T): void => {
    const kids = kidsOf(node);
    const extra = joinsOf(node);
    for (const child of [...kids, ...extra]) measure(child);
    widths.set(node.id, Math.max(column, rowWidth(kids), rowWidth(extra)));
    spans.set(node.id, 1 + Math.max(0, ...kids.map(kid => spans.get(kid.id)!)));
  };
  const xs = new Map<string, number>();
  const depths = new Map<string, number>();
  const place = (node: T, depth: number, start: number): void => {
    const kids = kidsOf(node);
    const extra = joinsOf(node);
    const width = widths.get(node.id)!;
    const row = (list: T[], level: number): number[] => {
      let next = start + (width - rowWidth(list)) / 2;
      return list.map(item => {
        place(item, level, next);
        const x = xs.get(item.id)!;
        next += widths.get(item.id)!;
        return x;
      });
    };
    const kidXs = row(kids, depth + 1);
    const joinXs = row(extra, depth + spans.get(node.id)!);
    const own = kidXs.length ? kidXs : joinXs;
    depths.set(node.id, depth);
    xs.set(node.id, own.length ? (own[0] + own[own.length - 1]) / 2 : start);
  };
  let cursor = left;
  const order: T[] = [];
  const collect = (node: T): void => {
    order.push(node);
    for (const child of [...kidsOf(node), ...joinsOf(node)]) collect(child);
  };
  for (const root of roots) {
    measure(root);
    place(root, 0, cursor);
    cursor += widths.get(root.id)!;
    collect(root);
  }
  const deepest = Math.max(0, ...depths.values());
  const heights: number[] = Array.from({ length: deepest + 1 }, () => 0);
  for (const node of order) heights[depths.get(node.id)!] = Math.max(heights[depths.get(node.id)!], heightFor(node));
  // Row tops run from the first row, which is the root row for downward and the deepest row for upward.
  const tops: number[] = [];
  let next = top;
  for (let step = 0; step <= deepest; step++) {
    const level = flip ? deepest - step : step;
    tops[level] = next;
    next += heights[level] + rowGap;
  }
  const result = new Map<string, { x: number; y: number }>();
  for (const node of order) {
    const level = depths.get(node.id)!;
    const y = flip ? tops[level] + heights[level] - heightFor(node) : tops[level];
    result.set(node.id, { x: xs.get(node.id)!, y });
  }
  return result;
}
