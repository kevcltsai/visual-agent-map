import { isAnnotatedImage, type CanvasItem } from "./canvas-items";

/** The key of one anchor in the view's hidden set: `imageId NUL anchorId` (the same key the view uses for its anchor dots). */
export const anchorRef = (imageId: string, anchorId: string): string => `${imageId}\u0000${anchorId}`;

/** The topics one anchor links to (either direction of its relations). */
export function anchorTopicIds(items: readonly CanvasItem[], imageId: string, anchorId: string): string[] {
  const image = items.find(item => item.id === imageId);
  if (!image || !isAnnotatedImage(image)) return [];
  const ids = new Set<string>();
  for (const relation of image.relations ?? []) {
    if (relation.from === anchorId) ids.add(relation.to);
    else if (relation.to === anchorId) ids.add(relation.from);
  }
  return [...ids];
}

/**
 * The topics hidden by the anchors in `hidden` (keys from `anchorRef`): every topic a hidden anchor links to and all of its
 * descendants. A view state only; nothing here is written to the map.
 */
export function anchorHiddenTopicIds(
  items: readonly CanvasItem[],
  nodes: readonly { id: string; parentId?: string | null }[],
  hidden: ReadonlySet<string>,
  imageId?: string
): Set<string> {
  const out = new Set<string>();
  if (!hidden.size) return out;
  const stack: string[] = [];
  for (const item of items) {
    if (!isAnnotatedImage(item) || (imageId !== undefined && item.id !== imageId)) continue;
    for (const anchor of item.anchors)
      if (hidden.has(anchorRef(item.id, anchor.id))) stack.push(...anchorTopicIds(items, item.id, anchor.id));
  }
  if (!stack.length) return out;
  const known = new Set(nodes.map(node => node.id));
  const kids = new Map<string, string[]>();
  for (const node of nodes) {
    if (!node.parentId) continue;
    const list = kids.get(node.parentId);
    if (list) list.push(node.id);
    else kids.set(node.parentId, [node.id]);
  }
  while (stack.length) {
    const id = stack.pop()!;
    if (out.has(id) || !known.has(id)) continue;
    out.add(id);
    stack.push(...(kids.get(id) ?? []));
  }
  return out;
}
