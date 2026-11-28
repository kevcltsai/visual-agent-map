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
  /** Map files, their folders and the notes of the cards that were read; null while the read is running. */
  private known: { files: Set<string>; folders: string[] } | null = null;

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
    this.known = null;
  }

  /**
   * A vault file was changed, created, deleted or renamed (`paths` holds the old and the new path). The index is dropped only when the
   * file is one a card comes from (a map file, a note in a map's folder, a card note) or a map file (`isMap`: a note that just got the
   * marker); any other note cannot change what is in it. Says whether it was dropped.
   */
  changed(paths: readonly string[], isMap: boolean): boolean {
    if (!this.built) return false;
    const known = this.known;
    if (
      !isMap &&
      known &&
      !paths.some(path => known.files.has(path) || known.folders.some(folder => path.startsWith(folder)))
    )
      return false;
    this.invalidate();
    return true;
  }

  private start(): Promise<CorpusCard[]> {
    const controller = new AbortController();
    this.controller = controller;
    const built: Promise<CorpusCard[]> = Promise.resolve()
      .then(() => loadAuthorizedCards(this.io(), controller.signal))
      .then(cards => {
        if (this.built === built && !controller.signal.aborted) this.known = knownPaths(cards);
        return cards;
      })
      .catch(() => {
        if (this.built === built) this.built = null;
        return [];
      });
    this.built = built;
    return built;
  }
}

function knownPaths(cards: readonly CorpusCard[]): { files: Set<string>; folders: string[] } {
  const files = new Set<string>();
  const folders = new Set<string>();
  for (const card of cards) {
    files.add(card.mapPath).add(card.notePath);
    folders.add(`${card.mapPath.slice(0, Math.max(0, card.mapPath.lastIndexOf("/")))}/`);
  }
  return { files, folders: [...folders] };
}

/** Gives `promise`'s result, or `fallback` at once when `signal` aborts first. */
export function raceAbort<T>(promise: Promise<T>, signal: AbortSignal, fallback: T): Promise<T> {
  if (signal.aborted) return Promise.resolve(fallback);
  return new Promise<T>((resolve, reject) => {
    const stop = (): void => resolve(fallback);
    signal.addEventListener("abort", stop, { once: true });
    promise.then(
      value => {
        signal.removeEventListener("abort", stop);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", stop);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });
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

/** A card is found only when at least this many different words of the message hit it. */
export const RETRIEVAL_MIN_WORDS = 2;

/**
 * The cards with the most hits: a word counts once for the title and once for the text. A card needs at least two different words
 * (a single common word is no evidence), and a word that is in more than half of all cards says nothing and is not used. Cards of the
 * map being talked to, cards in `skip` (`mapId\0nodeId`) and AI-locked cards are left out. Equal hits keep the order the corpus was read in.
 */
export function findCards(
  cards: readonly CorpusCard[],
  message: string,
  skip: { mapId: string; keys: ReadonlySet<string> },
  limit = RETRIEVAL_RESULT_LIMIT
): CorpusCard[] {
  const tokens = usefulTokens(cards, queryTokens(message));
  if (tokens.length < RETRIEVAL_MIN_WORDS) return [];
  const scored: { card: CorpusCard; score: number; order: number }[] = [];
  cards.forEach((card, order) => {
    if (card.aiLocked || card.mapId === skip.mapId || skip.keys.has(`${card.mapId}\u0000${card.nodeId}`)) return;
    let score = 0;
    let words = 0;
    for (const token of tokens) {
      const inTitle = card.foldedTitle.includes(token);
      const inBody = card.foldedBody.includes(token);
      if (inTitle) score++;
      if (inBody) score++;
      if (inTitle || inBody) words++;
    }
    if (words >= RETRIEVAL_MIN_WORDS) scored.push({ card, score, order });
  });
  return scored
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, limit)
    .map(item => item.card);
}

/** The words that are in at most half of the cards (all cards count, also the ones that will be skipped). */
function usefulTokens(cards: readonly CorpusCard[], tokens: readonly string[]): string[] {
  return tokens.filter(token => {
    let inCards = 0;
    for (const card of cards) if (card.foldedTitle.includes(token) || card.foldedBody.includes(token)) inCards++;
    return inCards * 2 <= cards.length;
  });
}

/** Characters of one found card that go to the AI (summary and the parts of the text that matched); the whole text is never sent. */
export const FOUND_CARD_CHAR_LIMIT = 800;
const EXCERPT_AROUND = 120;
const EXCERPT_PARTS = 3;

/**
 * What of a found card is sent: its summary and the places in its text where the message's words are, a little before and after
 * each, together within {@link FOUND_CARD_CHAR_LIMIT}. `cut` is true when any of the text was left out.
 */
export function excerptOf(
  summary: string,
  detail: string,
  message: string
): { summary: string; detail: string; cut: boolean } {
  const head = summary.length > 200 ? `${summary.slice(0, 200)}…` : summary;
  const room = Math.max(0, FOUND_CARD_CHAR_LIMIT - head.length);
  if (detail.length <= room) return { summary: head, detail, cut: head !== summary };
  const folded = foldSearchText(detail);
  const spots: number[] = [];
  for (const token of queryTokens(message)) {
    const at = folded.indexOf(token);
    if (at >= 0) spots.push(at);
  }
  spots.sort((a, b) => a - b);
  const windows: [number, number][] = [];
  for (const at of spots.slice(0, EXCERPT_PARTS * 3)) {
    const from = Math.max(0, at - EXCERPT_AROUND);
    const to = Math.min(detail.length, at + EXCERPT_AROUND);
    const last = windows[windows.length - 1];
    if (last && from <= last[1]) last[1] = Math.max(last[1], to);
    else if (windows.length < EXCERPT_PARTS) windows.push([from, to]);
  }
  if (!windows.length) windows.push([0, Math.min(detail.length, 240)]);
  let text = windows
    .map(([from, to]) => `${from > 0 ? "…" : ""}${detail.slice(from, to)}${to < detail.length ? "…" : ""}`)
    .join("\n");
  if (text.length > room) text = `${text.slice(0, Math.max(0, room - 1))}…`;
  return { summary: head, detail: text, cut: true };
}
