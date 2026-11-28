/**
 * The cards the cross-map search reads (P4.2), on demand only: nothing is indexed in the background and nothing is written. A card
 * is in the corpus under the same four conditions as a knowledge reference (P4.3): its map carries the marker, the map's own
 * `map.id` is usable (present and held by no other marked map: an id two maps share cannot tell them apart), the card exists in
 * that map as just read, and its note is not an archived VAM note. Titles and text are folded once, here, when they are read; a
 * search then only compares strings. Pure: the vault is reached only through the `KnowledgeRefIO` the caller passes.
 */
import { foldSearchText } from "../../i18n/han-fold";
import { readAiLocked } from "../../note-values";
import { isArchivedVamNote } from "./archived-note";
import type { KnowledgeRefIO } from "./knowledge-refs";

export { foldSearchText } from "../../i18n/han-fold";

export interface CorpusCard {
  mapId: string;
  mapPath: string;
  mapTitle: string;
  nodeId: string;
  notePath: string;
  title: string;
  foldedTitle: string;
  foldedBody: string;
  /** The note carries `ai-locked`: the cross-map search still lists it, an automatic find does not bring it to the AI. */
  aiLocked: boolean;
}

/** Hits shown at once; the total is still counted and said. */
export const CROSS_MAP_RESULT_LIMIT = 50;

type MapRead = Awaited<ReturnType<KnowledgeRefIO["readMap"]>>;

/**
 * Every authorised card of every marked map, read once. An abort stops the reading before the next read and gives `[]`: the caller
 * drops whatever it was waiting for.
 */
export async function loadAuthorizedCards(io: KnowledgeRefIO, signal: AbortSignal): Promise<CorpusCard[]> {
  if (signal.aborted) return [];
  const paths = [...new Set(await io.mapPaths())];
  if (signal.aborted) return [];
  const maps: { path: string; map: NonNullable<MapRead> }[] = [];
  const holders = new Map<string, number>();
  for (const path of paths) {
    if (signal.aborted) return [];
    const map = await io.readMap(path).catch(() => null);
    if (!map || typeof map.id !== "string" || !map.id) continue;
    maps.push({ path, map });
    holders.set(map.id, (holders.get(map.id) ?? 0) + 1);
  }
  const cards: CorpusCard[] = [];
  for (const { path, map } of maps) {
    if ((holders.get(map.id) ?? 0) !== 1) continue;
    for (const node of map.nodes) {
      if (signal.aborted) return [];
      const fm = await io.noteFrontmatter(node.path).catch(() => null);
      if (isArchivedVamNote(node.path, fm)) continue;
      if (signal.aborted) return [];
      const note = await io.readNote(node.path).catch(() => null);
      if (!note) continue;
      cards.push({
        mapId: map.id,
        mapPath: path,
        mapTitle: map.title,
        nodeId: node.id,
        notePath: node.path,
        title: note.title,
        foldedTitle: foldSearchText(note.title),
        foldedBody: foldSearchText(`${note.summary}\n${note.detail}`),
        aiLocked: fm ? readAiLocked(fm) : false
      });
    }
  }
  return signal.aborted ? [] : cards;
}

export interface CorpusHits {
  hits: CorpusCard[];
  /** Every match, also those past the shown limit. */
  total: number;
}

/** Cards whose title or text contains the query (folded literal substring): title hits first, then text-only hits. */
export function searchCorpus(cards: readonly CorpusCard[], query: string, limit = CROSS_MAP_RESULT_LIMIT): CorpusHits {
  const needle = foldSearchText(query.trim());
  if (!needle) return { hits: [], total: 0 };
  const inTitle: CorpusCard[] = [];
  const inBody: CorpusCard[] = [];
  for (const card of cards) {
    if (card.foldedTitle.includes(needle)) inTitle.push(card);
    else if (card.foldedBody.includes(needle)) inBody.push(card);
  }
  const all = [...inTitle, ...inBody];
  return { hits: all.slice(0, limit), total: all.length };
}
