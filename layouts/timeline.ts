import { verticalPositions } from "./vertical";

/** What the timeline engine needs to know about the tree; the caller decides what is collapsed or joined. */
export interface TimelineInput<T extends { id: string }> {
  roots: T[];
  kidsOf: (node: T) => T[];
  /** Converging conclusions; the root's join topics follow its topics on the axis. */
  joinsOf: (node: T) => T[];
  heightFor: (node: T) => number;
  /** Card width, the same for every card. */
  width: number;
  /** Horizontal distance between neighbouring cards (a card plus the space around it). */
  column: number;
  /** Space between a card and the first row of its details. */
  gap: number;
  left: number;
  top: number;
}

/**
 * Places each tree along a horizontal axis: the root stands at the left end and its first-level topics follow from left
 * to right in the order `kidsOf` gives them, all sharing one top edge. The details of every other topic grow away from
 * the axis, below it for the first, third, ... topic and above it for the second, fourth, ... topic, laid out level by
 * level like the down and up arrangements. Several roots are stacked from top to bottom. Returns each card's top-left
 * corner.
 */
export function timelinePositions<T extends { id: string }>(
  input: TimelineInput<T>
): Map<string, { x: number; y: number }> {
  const { roots, kidsOf, joinsOf, heightFor, width, column, gap, left, top } = input;
  const result = new Map<string, { x: number; y: number }>();
  let offset = top;
  for (const root of roots) {
    const heights = new Map<string, number>();
    const measure = (node: T): void => {
      heights.set(node.id, heightFor(node));
      for (const child of [...kidsOf(node), ...joinsOf(node)]) measure(child);
    };
    measure(root);
    const cards: { id: string; x: number; y: number }[] = [{ id: root.id, x: left, y: 0 }];
    let cursor = left + column;
    [...kidsOf(root), ...joinsOf(root)].forEach((topic, index) => {
      const placed = verticalPositions({
        roots: [topic],
        kidsOf,
        joinsOf,
        heightFor,
        column,
        rowGap: column - width,
        flip: index % 2 === 1,
        left: cursor,
        top: 0
      });
      // The topic itself stands on the axis; its details hang on one side of it.
      const axis = placed.get(topic.id)!.y;
      let reach = cursor;
      for (const [id, point] of placed) {
        cards.push({ id, x: point.x, y: point.y - axis });
        reach = Math.max(reach, point.x);
      }
      cursor = reach + column;
    });
    const minY = Math.min(...cards.map(card => card.y));
    const maxY = Math.max(...cards.map(card => card.y + heights.get(card.id)!));
    for (const card of cards) result.set(card.id, { x: card.x, y: offset + card.y - minY });
    offset += maxY - minY + gap;
  }
  return result;
}
