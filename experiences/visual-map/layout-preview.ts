import { visibleNodes, type MapNode } from "../../map-graph";
import type { MapDocument } from "../../map-model";

/** What "Tidy map" / "Tidy branch" would change: the cards that move and where they would stand. Never written. */
export interface TidyPreview {
  /** Only cards whose x or y differs, with the position they would take. */
  positions: Map<string, { x: number; y: number }>;
  /** Shown cards that move (a card hidden inside a folded branch moves too, but is not counted). */
  count: number;
}

/** Runs `arrange` on a copy of the map and lists the position differences; the map itself is not touched. */
export function computeTidy(map: MapDocument, arrange: (copy: MapDocument) => void): TidyPreview {
  const copy = JSON.parse(JSON.stringify(map)) as MapDocument;
  arrange(copy);
  const before = new Map(map.nodes.map(node => [node.id, node]));
  const positions = new Map<string, { x: number; y: number }>();
  for (const node of copy.nodes) {
    const was = before.get(node.id);
    if (was && (was.x !== node.x || was.y !== node.y)) positions.set(node.id, { x: node.x, y: node.y });
  }
  const shown = new Set(visibleNodes(map.nodes).map(node => node.id));
  return { positions, count: [...positions.keys()].filter(id => shown.has(id)).length };
}

/** Changes whenever the map's cards or canvas items change, so a preview made on an older map can be told apart. */
export function mapSignature(map: MapDocument): string {
  return JSON.stringify([
    map.nodes.map(node => [node.id, node.parentId, node.x, node.y, node.collapsed, node.width, node.height]),
    map.canvasItems ?? null,
    map.layout ?? null
  ]);
}

/** Display copies of `nodes` with the preview's positions; the inputs are not changed. */
export function overlayPositions(
  nodes: MapNode[],
  positions: ReadonlyMap<string, { x: number; y: number }>
): MapNode[] {
  return nodes.map(node => {
    const at = positions.get(node.id);
    return at ? { ...node, x: at.x, y: at.y } : node;
  });
}
