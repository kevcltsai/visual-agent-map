/** Graph basics shared by the plugin and the share viewer. No imports: the viewer bundle must stay small and browser-only. */
export interface MapNode {
  id: string;
  path: string;
  parentId: string | null;
  x: number;
  y: number;
  collapsed: boolean;
  /** Custom card width in canvas units; absent means the standard CARD_WIDTH. Only 200-560 values other than 280 are stored. */
  width?: number;
  /** This branch's own arrangement, instead of the map's; only right, left, down and up are stored (decision D9). */
  layout?: { direction: "right" | "left" | "down" | "up" };
  aimKind?: AimNodeKind;
  aimQuestion?: {
    requestId: string;
    parentBranchId?: string | null;
    options: { id: string; label: string }[];
    allowMultiple: boolean;
    allowFreeText: boolean;
  };
  aimConvergesFromNodeIds?: string[];
  /** Explicitly removed follow-ups must not be recreated by crash recovery. */
  aimDismissedQuestionRequestIds?: string[];
}
export type AimNodeKind = "topic" | "question" | "answer" | "research" | "synthesis" | "conclusion";

/** Standard card width and the range a user can resize it to, in canvas units. */
export const CARD_WIDTH = 280;
export const CARD_WIDTH_MIN = 200;
export const CARD_WIDTH_MAX = 560;
export const CARD_WIDTH_STEP = 40;

/** Rounds and clamps a width into the allowed range; undefined for anything that is not a finite number. */
export function clampCardWidth(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(CARD_WIDTH_MAX, Math.max(CARD_WIDTH_MIN, Math.round(value)));
}

export function parentIdsForNode(node: MapNode): string[] {
  const convergenceParents = node.aimKind === "question" ? [] : (node.aimConvergesFromNodeIds ?? []);
  return [...(node.parentId ? [node.parentId] : []), ...convergenceParents.filter(id => id !== node.parentId)];
}

export function descendants(nodes: MapNode[], id: string): Set<string> {
  const found = new Set<string>();
  const pending = [id];
  while (pending.length) {
    const parent = pending.pop();
    for (const node of nodes) {
      if (node.parentId === parent && node.id !== id && !found.has(node.id)) {
        found.add(node.id);
        pending.push(node.id);
      }
    }
  }
  return found;
}
export function visibleNodes(nodes: MapNode[]): MapNode[] {
  const hidden = new Set<string>();
  for (const node of nodes) if (node.collapsed) for (const id of descendants(nodes, node.id)) hidden.add(id);
  return nodes.filter(node => !hidden.has(node.id));
}
/**
 * Sets every branch's collapsed flag at once. `shownLevels` is how many levels below the roots stay visible:
 * 0 shows only the roots, 2 shows children and grandchildren, and `null` expands everything. Leaves are left alone.
 */
export function applyCollapseLevel(nodes: MapNode[], shownLevels: number | null): void {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const depthOf = (node: MapNode): number => {
    let depth = 0;
    const seen = new Set([node.id]);
    for (
      let parent = node.parentId;
      parent && byId.has(parent) && !seen.has(parent);
      parent = byId.get(parent)!.parentId
    ) {
      seen.add(parent);
      depth++;
    }
    return depth;
  };
  const parents = new Set(nodes.map(node => node.parentId).filter((id): id is string => !!id && byId.has(id)));
  for (const node of nodes) {
    if (!parents.has(node.id)) continue;
    node.collapsed = shownLevels === null ? false : depthOf(node) >= shownLevels;
  }
}
