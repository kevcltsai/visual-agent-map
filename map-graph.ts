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
  /** Custom card height in canvas units; absent means "as tall as the content". Any value in 80-720 is stored (there is no default to compare against). */
  height?: number;
  /** This branch's own arrangement, instead of the map's; only right, left, down and up are stored (decision D9). */
  layout?: { direction: "right" | "left" | "down" | "up" };
  /**
   * This topic hangs after the attached text block with this id: it is drawn and laid out as the block's follower, but
   * `parentId` is still the real topic the block hangs on (never a text id; a text is not a node). Dropped on read when it
   * does not match an attached text of the same parent.
   */
  afterTextId?: string;
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

/** The range a user can resize a card's height to, in canvas units. There is no standard height: absent means fit the content. */
export const CARD_HEIGHT_MIN = 80;
export const CARD_HEIGHT_MAX = 720;
export const CARD_HEIGHT_STEP = 40;

/** Rounds and clamps a height into the allowed range; undefined for anything that is not a finite number. */
export function clampCardHeight(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(CARD_HEIGHT_MAX, Math.max(CARD_HEIGHT_MIN, Math.round(value)));
}

/**
 * The virtual tree for layout and reading order: a node whose `afterTextId` names a text in `texts` (text id -> the topic it
 * hangs on) with the same parent as the node gets that text as its parent. Everything else, and the whole list when nothing
 * qualifies, is returned as it is. The result is for reading only; its `parentId` must never be saved.
 */
export function withTextParents(nodes: MapNode[], texts: ReadonlyMap<string, string>): MapNode[] {
  if (!texts.size) return nodes;
  let changed = false;
  const out = nodes.map(node => {
    const textId = node.afterTextId;
    if (textId === undefined || texts.get(textId) !== node.parentId) return node;
    changed = true;
    return { ...node, parentId: textId };
  });
  return changed ? out : nodes;
}

export function parentIdsForNode(node: MapNode): string[] {
  const convergenceParents = node.aimKind === "question" ? [] : (node.aimConvergesFromNodeIds ?? []);
  return [...(node.parentId ? [node.parentId] : []), ...convergenceParents.filter(id => id !== node.parentId)];
}

/** Children of each parent id, in `nodes` order. One pass, so walking a branch never rescans the whole map. */
export function childIndex(nodes: readonly MapNode[]): Map<string, MapNode[]> {
  const index = new Map<string, MapNode[]>();
  for (const node of nodes) {
    const key = node.parentId ?? "";
    const list = index.get(key);
    if (list) list.push(node);
    else index.set(key, [node]);
  }
  return index;
}
export function walkDescendants(index: Map<string, MapNode[]>, id: string, found: Set<string>): void {
  const pending = [id];
  while (pending.length) {
    const parent = pending.pop()!;
    for (const node of index.get(parent) ?? []) {
      if (node.id !== id && !found.has(node.id)) {
        found.add(node.id);
        pending.push(node.id);
      }
    }
  }
}
/** How many topics sit under `id`, from a prebuilt child index. */
export function branchSize(index: Map<string, MapNode[]>, id: string): number {
  const found = new Set<string>();
  walkDescendants(index, id, found);
  return found.size;
}
export function descendants(nodes: MapNode[], id: string): Set<string> {
  const found = new Set<string>();
  walkDescendants(childIndex(nodes), id, found);
  return found;
}
export function visibleNodes(nodes: MapNode[]): MapNode[] {
  const index = childIndex(nodes);
  const hidden = new Set<string>();
  for (const node of nodes) if (node.collapsed && !hidden.has(node.id)) walkDescendants(index, node.id, hidden);
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
