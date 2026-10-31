/** Which side of the root a first-level topic (and everything under it) is drawn on in a balanced map. */
export type BalancedSide = "left" | "right";

/** How far a card must sit from the root's x, in canvas units, before its side counts as known (half a card width). */
export const SIDE_DEADBAND = 150;

/** The side a card's x puts it on relative to its root's x; undefined when it is too close to the root to tell. */
export function sideFromOffset(dx: number): BalancedSide | undefined {
  if (dx > SIDE_DEADBAND) return "right";
  if (dx < -SIDE_DEADBAND) return "left";
  return undefined;
}

/** Adds each topic, in order, to the side with the smaller total height so far (the right side wins a tie). */
export function greedySides<T extends { id: string }>(
  topics: T[],
  sizeOf: (topic: T) => number,
  gap: number,
  loads: { left: number; right: number } = { left: 0, right: 0 }
): Map<string, BalancedSide> {
  const load = { ...loads };
  const result = new Map<string, BalancedSide>();
  for (const topic of topics) {
    const side: BalancedSide = load.left < load.right ? "left" : "right";
    result.set(topic.id, side);
    load[side] += sizeOf(topic) + gap;
  }
  return result;
}

/**
 * Decides the side of every first-level topic of one root. Topics that already stand on a side keep it, and the rest go
 * to the shorter side, so adding or removing a topic never moves the others across. When the known sides do not use
 * both sides (a map that was not balanced before), every topic is dealt out again from the start.
 */
export function assignSides<T extends { id: string }>(
  topics: T[],
  sizeOf: (topic: T) => number,
  gap: number,
  known: (topic: T) => BalancedSide | undefined
): Map<string, BalancedSide> {
  const sides = topics.map(known);
  if (!(sides.includes("left") && sides.includes("right"))) return greedySides(topics, sizeOf, gap);
  const loads = { left: 0, right: 0 };
  topics.forEach((topic, index) => {
    const side = sides[index];
    if (side) loads[side] += sizeOf(topic) + gap;
  });
  const rest = greedySides(
    topics.filter((_, index) => !sides[index]),
    sizeOf,
    gap,
    loads
  );
  return new Map(topics.map((topic, index) => [topic.id, sides[index] ?? rest.get(topic.id)!]));
}
