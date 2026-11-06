/**
 * What a new card or an expanded card was built from (the "basis" shown under a chat result). Pure and decided by the program, never
 * by the model: "read" means what the model was shown in this round, not that anything was checked.
 */

/**
 * `research`: a card on the new card's parent chain had its whole Detail sent and the conversation researched it. `note`: the same
 * with a note nobody researched here. `outline_only`: no card on the chain had a whole note sent; `alsoRead` lists the other notes
 * this round did show (a note of another card is not the basis of a card that is not under it).
 */
export type MapChatBasis =
  | { kind: "research" | "note"; sources: { id: string; title: string }[]; existingChildren?: number }
  | { kind: "outline_only"; alsoRead: { path: string; title: string }[]; existingChildren?: number };

/** What the context builder records of one round, for {@link chatBasisFor}. Not serialized into the prompt. */
export interface MapChatBasisIndex {
  /** Cards whose whole, non-empty Detail was sent in this round; `research` when this conversation researched the card. */
  cards: Record<string, { title: string; research: boolean }>;
  /** Every note shown whole in this round: cards with their Detail, snippets, files and the active file. */
  read: { id?: string; path: string; title: string }[];
}

/** The card ids above a card, nearest first: its parent, the parent's parent, and so on (a `new:<ref>` parent is looked up in `created`). */
function ancestors(
  parentId: string | null,
  parents: Readonly<Record<string, string | null | undefined>>,
  created: Readonly<Record<string, string | null | undefined>>
): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  let id: string | null | undefined = parentId;
  while (id && !seen.has(id)) {
    seen.add(id);
    chain.push(id);
    id = id.startsWith("new:") ? created[id] : parents[id];
  }
  return chain;
}

/**
 * The basis of a card added under `parentId`. The parent chain (including cards the same reply creates, `created`: `new:<ref>` ->
 * its parent id, see {@link createdParentsOf}) decides: a card with a research note whose whole text was sent gives `research`, one
 * with another sent note gives `note`; with none the card has only the outline (`outline_only`) and the other notes read are listed.
 */
export function chatBasisFor(
  index: MapChatBasisIndex,
  parentId: string | null,
  parents: Readonly<Record<string, string | null | undefined>>,
  created: Readonly<Record<string, string | null | undefined>> = {},
  existingChildren?: number
): MapChatBasis {
  const chain = ancestors(parentId, parents, created).filter(id =>
    Object.prototype.hasOwnProperty.call(index.cards, id)
  );
  const source = (id: string): { id: string; title: string } => ({ id, title: index.cards[id].title });
  const research = chain.filter(id => index.cards[id].research);
  const extra = existingChildren === undefined ? {} : { existingChildren };
  if (research.length) return { kind: "research", sources: research.map(source), ...extra };
  if (chain.length) return { kind: "note", sources: chain.map(source), ...extra };
  return { kind: "outline_only", alsoRead: index.read.map(({ path, title }) => ({ path, title })), ...extra };
}

/** `new:<ref>` -> the parent id (null for a root) of every add_child in a reply, for {@link chatBasisFor}. */
export function createdParentsOf(
  actions: readonly { kind: string; ref?: string; parentId?: string }[]
): Record<string, string | null> {
  const created: Record<string, string | null> = {};
  for (const action of actions)
    if (action.kind === "add_child" && action.ref) created[`new:${action.ref}`] = action.parentId || null;
  return created;
}

/**
 * The basis of an expand line (the card's own note, not a parent chain): `note` when the card's note was read, else `outline_only`;
 * both say how many subtopics the card already had.
 */
export function expandBasis(card: {
  id: string;
  title: string;
  hasNote: boolean;
  existingChildren: number;
}): MapChatBasis {
  return card.hasNote
    ? { kind: "note", sources: [{ id: card.id, title: card.title }], existingChildren: card.existingChildren }
    : { kind: "outline_only", alsoRead: [], existingChildren: card.existingChildren };
}
