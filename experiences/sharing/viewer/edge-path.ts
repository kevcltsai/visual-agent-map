/**
 * Path data for the curve from a parent card's right edge to a child card's left edge. A copy of `edgePathData` in
 * experiences/visual-map/view.ts (that file binds to Obsidian and cannot be bundled); a test keeps the two identical.
 */
export function edgePathData(x1: number, y1: number, x2: number, y2: number): string {
  const run = x2 - x1;
  const bend = run >= 40 ? run / 2 : run >= 0 ? 60 - run : Math.max(60, -run / 2);
  return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
}
