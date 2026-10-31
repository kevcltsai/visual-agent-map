/** What the fishbone engine needs to know about the tree; the caller decides what is collapsed or joined. */
export interface FishboneInput<T extends { id: string }> {
  roots: T[];
  kidsOf: (node: T) => T[];
  /** Converging conclusions; the root's join topics follow its topics along the spine. */
  joinsOf: (node: T) => T[];
  heightFor: (node: T) => number;
  /** Card width, the same for every card. */
  width: number;
  /** Horizontal distance between neighbouring cards (a card plus the space around it). */
  column: number;
  /** Space between stacked cards. */
  gap: number;
  left: number;
  top: number;
}

/** Horizontal run of a 60 degree bone for each unit of height it climbs. */
export const BONE_RUN = 1 / Math.tan(Math.PI / 3);

interface Placed {
  id: string;
  /** Left edge, relative to the topic card's centre. */
  x: number;
  /** Centre height, measured from the card's bone attach point towards the spine. */
  centre: number;
  height: number;
}

interface Card {
  id: string;
  x: number;
  y: number;
  height: number;
}

/**
 * Places each tree as a fishbone: the root is the head at the right end and the spine runs left from its middle. The
 * first-level topics sit on 60 degree bones that lean towards the head, the first one above the spine, the second below,
 * and so on. A topic card stands at the outer end of its bone with the bone leaving the card's edge midpoint that faces the
 * spine. The details of a topic hang on the bone as horizontal ribs, each rib ending at the right edge midpoint of its card;
 * the details of a detail grow to the left like a left-hand tree. A bone is as long as its details need, so a topic with
 * many details reaches further from the spine. Several roots are stacked from top to bottom with their heads aligned.
 * Returns each card's top-left corner.
 */
export function fishbonePositions<T extends { id: string }>(
  input: FishboneInput<T>
): Map<string, { x: number; y: number }> {
  const { roots, kidsOf, joinsOf, heightFor, width, column, gap, left, top } = input;
  const rib = column - width;
  const childrenOf = (node: T): T[] => [...kidsOf(node), ...joinsOf(node)];
  const fishes = roots.map(root => {
    // Sizes of the left-growing subtrees of details.
    const sizes = new Map<string, number>();
    const stack = (list: T[]) =>
      list.reduce((total, item) => total + sizes.get(item.id)!, 0) + Math.max(0, list.length - 1) * gap;
    const measure = (node: T): void => {
      const kids = childrenOf(node);
      for (const kid of kids) measure(kid);
      sizes.set(node.id, Math.max(heightFor(node), stack(kids)));
    };
    /** Lays out a detail subtree in the band starting at `bandTop`; x is relative to the detail's own left edge. */
    const place = (node: T, depth: number, bandTop: number, out: Placed[]): number => {
      const kids = childrenOf(node);
      let next = bandTop + (sizes.get(node.id)! - stack(kids)) / 2;
      const centres = kids.map(kid => {
        const centre = place(kid, depth + 1, next, out);
        next += sizes.get(kid.id)! + gap;
        return centre;
      });
      const own = heightFor(node);
      const centre = centres.length
        ? (centres[0] + centres[centres.length - 1]) / 2
        : bandTop + sizes.get(node.id)! / 2;
      out.push({ id: node.id, x: -depth * column, centre, height: own });
      return centre;
    };
    const topics = childrenOf(root).map((topic, index) => {
      const side = index % 2 === 0 ? 1 : -1;
      const details = childrenOf(topic);
      for (const detail of details) measure(detail);
      const cards: Placed[] = [];
      let cursor = gap;
      for (const detail of details) {
        const at = cards.length;
        const centre = place(detail, 0, cursor, cards);
        // The rib is horizontal at the detail card's centre and ends rib units before the bone.
        const edge = centre * BONE_RUN - rib;
        for (let i = at; i < cards.length; i++) cards[i].x += edge - width;
        cursor += sizes.get(detail.id)! + gap;
      }
      // The last band ends a gap before the spine.
      const length = Math.max(column, cursor);
      const run = length * BONE_RUN;
      const height = heightFor(topic);
      // Relative to the topic card's centre: its own extent, then the details, then the joint on the spine.
      const lefts = [-width / 2, ...cards.map(card => card.x)];
      const rights = [width / 2, run, ...cards.map(card => card.x + width)];
      return {
        topic,
        side,
        length,
        height,
        cards,
        minX: Math.min(...lefts),
        maxX: Math.max(...rights)
      };
    });
    const rootHeight = heightFor(root);
    const out: Card[] = [{ id: root.id, x: 0, y: -rootHeight / 2, height: rootHeight }];
    // Each side is filled from the head outwards: the next bone starts clear of everything of the previous one.
    const edge = { above: -rib, below: -rib };
    for (const fish of topics) {
      const key = fish.side === 1 ? "above" : "below";
      const at = edge[key] - fish.maxX;
      const attachY = -fish.side * fish.length;
      out.push({
        id: fish.topic.id,
        x: at - width / 2,
        y: attachY - fish.side * (fish.height / 2) - fish.height / 2,
        height: fish.height
      });
      for (const card of fish.cards)
        out.push({
          id: card.id,
          x: at + card.x,
          y: attachY + fish.side * card.centre - card.height / 2,
          height: card.height
        });
      edge[key] = at + fish.minX - rib;
    }
    const minX = Math.min(...out.map(card => card.x));
    const minY = Math.min(...out.map(card => card.y));
    const maxY = Math.max(...out.map(card => card.y + card.height));
    return { out, minX, minY, maxY };
  });
  // The heads share one x and the fishes are stacked from top to bottom.
  const result = new Map<string, { x: number; y: number }>();
  const headX = left + Math.max(0, ...fishes.map(fish => -fish.minX));
  let offset = top;
  for (const fish of fishes) {
    for (const card of fish.out) result.set(card.id, { x: headX + card.x, y: offset + card.y - fish.minY });
    offset += fish.maxY - fish.minY + gap;
  }
  return result;
}
