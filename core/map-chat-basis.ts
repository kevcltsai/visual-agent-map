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

const BASIS_TEXT_LIMIT = 200;
const BASIS_LIST_LIMIT = 50;
const text = (value: unknown): string | null =>
  typeof value === "string" ? [...value].slice(0, BASIS_TEXT_LIMIT).join("") : null;
const count = (value: unknown): { existingChildren?: number } =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? { existingChildren: value } : {};

/** A basis read back from a saved conversation (a file somebody may have edited): only the known shape comes through, else undefined. */
export function parseChatBasis(value: unknown): MapChatBasis | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.kind === "research" || raw.kind === "note") {
    if (!Array.isArray(raw.sources)) return undefined;
    const sources = raw.sources.slice(0, BASIS_LIST_LIMIT).flatMap(item => {
      const entry = (item ?? {}) as Record<string, unknown>;
      const id = text(entry.id);
      const title = text(entry.title);
      return id !== null && title !== null ? [{ id, title }] : [];
    });
    return { kind: raw.kind, sources, ...count(raw.existingChildren) };
  }
  if (raw.kind === "outline_only") {
    const alsoRead = (Array.isArray(raw.alsoRead) ? raw.alsoRead : []).slice(0, BASIS_LIST_LIMIT).flatMap(item => {
      const entry = (item ?? {}) as Record<string, unknown>;
      const path = text(entry.path);
      const title = text(entry.title);
      return path !== null && title !== null ? [{ path, title }] : [];
    });
    return { kind: "outline_only", alsoRead, ...count(raw.existingChildren) };
  }
  return undefined;
}

/** Fixed words of {@link basisSummary} (`{0}` is the titles); the view hands over the interface language's. */
export interface BasisLabels {
  research: string;
  note: string;
  outline: string;
}
/**
 * One plain line for the basis of a result (the saved note's version): "read", never "checked". The titles are untrusted text and
 * are left unescaped here; the caller escapes the whole line.
 */
export function basisSummary(basis: MapChatBasis, labels: BasisLabels, titleLimit = 5): string {
  if (basis.kind === "outline_only") return labels.outline;
  const titles = basis.sources.map(source => source.title.replace(/\s+/g, " ").trim()).filter(Boolean);
  const shown = titles.slice(0, titleLimit).join(", ") + (titles.length > titleLimit ? ", …" : "");
  return (basis.kind === "research" ? labels.research : labels.note).replace(/\{0\}/g, () => shown);
}

const SUMMARY_TITLE_LIMIT = 60;
const oneLine = (value: string): string => {
  const flat = value.replace(/\s+/g, " ").trim();
  const chars = [...flat];
  return chars.length > SUMMARY_TITLE_LIMIT ? `${chars.slice(0, SUMMARY_TITLE_LIMIT - 1).join("")}…` : flat;
};

/**
 * One line of the basis block shown under a reply's results (decided by the program; "read", never "checked").
 * - `cards`: the new cards (add_child) that were built from the same notes, counted: a research note, another note, or the titles only
 *   (no whole note of the parent chain was read; `alsoRead` is not a basis and is not listed here).
 * - `expand`: one expanded card, with the notes it was read from (its own, or none = only the title) and how many subtopics it had.
 */
export type BasisSummaryEntry =
  | { type: "cards"; kind: "research" | "note"; titles: string[]; count: number }
  | { type: "cards"; kind: "outline_only"; titles: []; count: number }
  | { type: "expand"; kind: "note"; titles: string[]; existingChildren: number }
  | { type: "expand"; kind: "outline_only"; titles: []; existingChildren: number };

/**
 * The basis block of one reply: the bases of its result lines gathered into the fewest lines. Cards of the same kind and the same
 * sources are one entry with a count (first appearance first); every expansion is its own entry (it names its card). Pure: the same
 * lines always give the same entries, with no mention of anything that was not read. Titles are untrusted text, cut to one line.
 */
export function summarizeBasis(bases: readonly MapChatBasis[]): BasisSummaryEntry[] {
  const entries: BasisSummaryEntry[] = [];
  const cardIndex = new Map<string, number>();
  for (const basis of bases) {
    const titles =
      basis.kind === "outline_only"
        ? []
        : basis.sources
            .map(source => oneLine(source.title))
            .filter((title, at, all) => title && all.indexOf(title) === at);
    // A note basis that names no readable title (a hand-edited file) says nothing about what was read: it counts as titles only.
    const kind = basis.kind === "outline_only" || !titles.length ? "outline_only" : basis.kind;
    if (basis.existingChildren !== undefined) {
      entries.push(
        kind === "outline_only"
          ? { type: "expand", kind, titles: [], existingChildren: basis.existingChildren }
          : { type: "expand", kind: "note", titles, existingChildren: basis.existingChildren }
      );
      continue;
    }
    const key = kind === "outline_only" ? kind : `${kind}\u0001${titles.join("\u0001")}`;
    const at = cardIndex.get(key);
    if (at !== undefined) {
      (entries[at] as { count: number }).count++;
      continue;
    }
    cardIndex.set(key, entries.length);
    entries.push(
      kind === "outline_only"
        ? { type: "cards", kind, titles: [], count: 1 }
        : { type: "cards", kind, titles, count: 1 }
    );
  }
  return entries;
}
