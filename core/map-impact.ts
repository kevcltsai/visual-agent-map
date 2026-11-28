// Impact analysis (P4.7): what a card touches in THIS map. Pure and read-only: it reads the lists it is given and writes
// nothing; no provider, no model, no other map. "Direct" is what is wired to the card (relations, subtree, Living Node source
// references, reference cards hung on it); "speculative" is only a text match (another card's title or summary names this card).
export type ImpactDirectKind = "relation" | "descendant" | "living" | "reference";

export interface ImpactCard {
  id: string;
  parentId: string | null;
  title: string;
  summary?: string;
}
export interface ImpactRelation {
  kind?: string;
  from: string;
  to: string;
}
export interface ImpactRef {
  id: string;
  /** The card of this map the reference card hangs on. */
  parentId: string;
  /** The title already read for the reference card, when the view has it. Never read here. */
  title?: string;
}
export interface ImpactInput {
  targetId: string;
  cards: readonly ImpactCard[];
  relations: readonly ImpactRelation[];
  /** Cards of this map whose Living Node sources point at the target (decided by the view, from this map's own notes). */
  livingConsumerIds: readonly string[];
  refs: readonly ImpactRef[];
}

export interface ImpactItem {
  section: "direct" | "speculative";
  /** What links it (direct), in a fixed order. */
  kinds: ImpactDirectKind[];
  /** The card to locate: the card itself, or for a reference card the card it hangs on. */
  nodeId: string;
  title: string;
  /** A reference card: its own title is shown when known, otherwise the view says "reference card". */
  refId?: string;
  /** Speculative only: the target title that the text mentions. */
  matched?: string;
}
export interface ImpactResult {
  /** `missing`: the card is no longer on the map. `empty`: it touches nothing. */
  state: "missing" | "empty" | "items";
  targetId: string;
  targetTitle: string;
  direct: ImpactItem[];
  speculative: ImpactItem[];
  /** Items left out of each list by the cap. */
  hidden: { direct: number; speculative: number };
}

export const IMPACT_LIST_LIMIT = 30;
const MATCH_MIN = 2;
const KIND_ORDER: readonly ImpactDirectKind[] = ["relation", "descendant", "living", "reference"];

export function buildImpact(input: ImpactInput): ImpactResult {
  const { targetId } = input;
  const byId = new Map(input.cards.map(card => [card.id, card]));
  const target = byId.get(targetId);
  const result: ImpactResult = {
    state: "missing",
    targetId,
    targetTitle: target?.title ?? "",
    direct: [],
    speculative: [],
    hidden: { direct: 0, speculative: 0 }
  };
  if (!target) return result;

  // Direct cards: id -> the kinds that make it direct. Insertion order is the display order.
  const direct = new Map<string, Set<ImpactDirectKind>>();
  const add = (id: string, kind: ImpactDirectKind): void => {
    if (id === targetId || !byId.has(id)) return;
    const kinds = direct.get(id) ?? new Set<ImpactDirectKind>();
    kinds.add(kind);
    direct.set(id, kinds);
  };
  for (const relation of input.relations) {
    if (relation.from === targetId) add(relation.to, "relation");
    else if (relation.to === targetId) add(relation.from, "relation");
  }
  // The subtree, breadth first; a visited set stops a loop in damaged parent data.
  const children = new Map<string, string[]>();
  for (const card of input.cards)
    if (card.parentId) children.set(card.parentId, [...(children.get(card.parentId) ?? []), card.id]);
  const seen = new Set<string>([targetId]);
  const queue = [targetId];
  while (queue.length) {
    for (const child of children.get(queue.shift() as string) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      add(child, "descendant");
      queue.push(child);
    }
  }
  for (const id of input.livingConsumerIds) add(id, "living");

  const items: ImpactItem[] = [...direct].map(([id, kinds]) => ({
    section: "direct",
    kinds: KIND_ORDER.filter(kind => kinds.has(kind)),
    nodeId: id,
    title: byId.get(id)?.title ?? ""
  }));
  const refSeen = new Set<string>();
  for (const ref of input.refs) {
    if (ref.parentId !== targetId || refSeen.has(ref.id)) continue;
    refSeen.add(ref.id);
    items.push({
      section: "direct",
      kinds: ["reference"],
      nodeId: targetId,
      title: ref.title ?? "",
      refId: ref.id
    });
  }

  // Speculative: not already direct, not the card itself, and its title or summary names the target's title.
  const needle = target.title.trim().toLowerCase();
  const guesses: ImpactItem[] = [];
  if (needle.length >= MATCH_MIN)
    for (const card of input.cards) {
      if (card.id === targetId || direct.has(card.id)) continue;
      const text = `${card.title}\n${card.summary ?? ""}`.toLowerCase();
      if (text.includes(needle))
        guesses.push({
          section: "speculative",
          kinds: [],
          nodeId: card.id,
          title: card.title,
          matched: target.title.trim()
        });
    }

  result.direct = items.slice(0, IMPACT_LIST_LIMIT);
  result.speculative = guesses.slice(0, IMPACT_LIST_LIMIT);
  result.hidden = {
    direct: Math.max(0, items.length - IMPACT_LIST_LIMIT),
    speculative: Math.max(0, guesses.length - IMPACT_LIST_LIMIT)
  };
  result.state = items.length || guesses.length ? "items" : "empty";
  return result;
}
