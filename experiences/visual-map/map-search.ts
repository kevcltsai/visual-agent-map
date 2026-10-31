import { toSimplifiedFold } from "../../i18n/han-fold";
import type { MapNode } from "../../map-graph";

/** Same algorithm as `foldOutlineSearch` in ui/outline-view.ts (a test pins the two together): lower-case, drop U+0307 (Turkish İ), fold Traditional to Simplified. */
export const foldSearchText = (text: string): string => toSimplifiedFold(text.toLocaleLowerCase().replace(/̇/g, ""));

/** Ids whose title contains the query (literal substring, titles only), in `order`. A blank query matches nothing. */
export function findMatches(order: string[], titleOf: (id: string) => string, query: string): string[] {
  const needle = foldSearchText(query.trim());
  if (!needle) return [];
  return order.filter(id => foldSearchText(titleOf(id)).includes(needle));
}

export interface MapMatchStep {
  id: string;
  /** 0-based position within `matches`. */
  index: number;
  total: number;
}

/** Cycles through `matches`. When `currentId` is not a match, moves from its place in `order` in the `delta` direction. */
export function nextMatch(
  order: string[],
  matches: string[],
  currentId: string | null,
  delta: 1 | -1
): MapMatchStep | null {
  const total = matches.length;
  if (total === 0) return null;
  const at = (index: number): MapMatchStep => ({ id: matches[index], index, total });
  const inMatches = currentId === null ? -1 : matches.indexOf(currentId);
  if (inMatches >= 0) return at((inMatches + delta + total) % total);
  const position = currentId === null ? -1 : order.indexOf(currentId);
  if (position < 0) return at(delta === 1 ? 0 : total - 1);
  const rank = new Map(order.map((id, i) => [id, i] as const));
  const ranks = matches.map(id => rank.get(id) ?? -1);
  if (delta === 1) {
    const found = ranks.findIndex(r => r > position);
    return at(found >= 0 ? found : 0);
  }
  for (let i = total - 1; i >= 0; i--) if (ranks[i] < position) return at(i);
  return at(total - 1);
}

/** Collapsed ancestors of `id`, root first. Stops at a missing parent or a cycle; an unknown `id` gives []. */
export function collapsedAncestors(nodes: readonly MapNode[], id: string): string[] {
  const byId = new Map(nodes.map(node => [node.id, node] as const));
  const start = byId.get(id);
  if (!start) return [];
  const seen = new Set<string>([id]);
  const result: string[] = [];
  let parentId = start.parentId;
  while (parentId !== null && !seen.has(parentId)) {
    const parent = byId.get(parentId);
    if (!parent) break;
    seen.add(parentId);
    if (parent.collapsed === true) result.unshift(parent.id);
    parentId = parent.parentId;
  }
  return result;
}
