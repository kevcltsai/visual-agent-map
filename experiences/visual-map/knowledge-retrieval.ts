/**
 * Finding past cards for a chat message (V3.3 P4.1, exact step): the authorised cards are read once into memory (the same corpus
 * the cross-map search reads), kept until something that could change them happens (a vault event, a change of what is
 * authorised), and a message is matched against them by its words. Nothing is written, no background watcher runs and no
 * database is used: the index is rebuilt from the vault on the next message after it was dropped. Ranking by meaning is a separate step.
 */
import { foldSearchText, loadAuthorizedCards, type CorpusCard } from "./cross-map-corpus";
import type { KnowledgeRefIO } from "./knowledge-refs";

/** Cards found for one message; the same number the chat sends at most. */
export const RETRIEVAL_RESULT_LIMIT = 5;
/** Words of one message that are looked up; a pasted page must not turn into thousands of comparisons per card. */
const MAX_TOKENS = 64;
const STOP_WORDS = new Set(
  "the and for are was were with that this from you your can not but what how who why have has had about please will would could should into than then there their they them its".split(
    " "
  )
);

/** The in-memory index: built on first use, dropped by `invalidate`. A build that was dropped while it ran is never kept. */
export class KnowledgeIndex {
  private built: Promise<CorpusCard[]> | null = null;
  private controller: AbortController | null = null;

  constructor(private readonly io: () => KnowledgeRefIO) {}

  async get(): Promise<CorpusCard[]> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const built = this.built ?? this.start();
      const cards = await built;
      if (this.built === built) return cards;
    }
    return [];
  }

  /** Drops what was read (and stops a read in flight): a rename, a delete, a change of the map marker or of what a card says. */
  invalidate(): void {
    this.controller?.abort();
    this.controller = null;
    this.built = null;
  }

  private start(): Promise<CorpusCard[]> {
    const controller = new AbortController();
    this.controller = controller;
    const built: Promise<CorpusCard[]> = Promise.resolve()
      .then(() => loadAuthorizedCards(this.io(), controller.signal))
      .catch(() => {
        if (this.built === built) this.built = null;
        return [];
      });
    this.built = built;
    return built;
  }
}

/** The words of a message that are looked up: Latin words of three letters or more, and every pair of neighbouring Han characters. Folded, no repeats. */
export function queryTokens(message: string): string[] {
  const folded = foldSearchText(message);
  const tokens = new Set<string>();
  for (const match of folded.matchAll(/\p{Script=Latin}{3,}/gu)) if (!STOP_WORDS.has(match[0])) tokens.add(match[0]);
  for (const match of folded.matchAll(/\p{Script=Han}{2,}/gu)) {
    const run = Array.from(match[0]);
    for (let i = 0; i + 1 < run.length; i++) tokens.add(run[i] + run[i + 1]);
  }
  return [...tokens].slice(0, MAX_TOKENS);
}

/**
 * The cards with the most hits: a word counts once for the title and once for the text. Cards of the map being talked to and
 * cards in `skip` (`mapId\0nodeId`) are left out. Equal hits keep the order the corpus was read in.
 */
export function findCards(
  cards: readonly CorpusCard[],
  message: string,
  skip: { mapId: string; keys: ReadonlySet<string> },
  limit = RETRIEVAL_RESULT_LIMIT
): CorpusCard[] {
  const tokens = queryTokens(message);
  if (!tokens.length) return [];
  const scored: { card: CorpusCard; score: number; order: number }[] = [];
  cards.forEach((card, order) => {
    if (card.mapId === skip.mapId || skip.keys.has(`${card.mapId}\u0000${card.nodeId}`)) return;
    let score = 0;
    for (const token of tokens) {
      if (card.foldedTitle.includes(token)) score++;
      if (card.foldedBody.includes(token)) score++;
    }
    if (score) scored.push({ card, score, order });
  });
  return scored
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, limit)
    .map(item => item.card);
}
