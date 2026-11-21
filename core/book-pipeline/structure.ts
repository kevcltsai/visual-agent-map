/**
 * The book's structure, worked out from the cards' parents (never stored): the root card is the preface, a card whose parent is the
 * root is a chapter (numbered in reading order), and every card below a chapter is one of that chapter's sections (named, not numbered).
 * The one place that decides what a card is; chapter numbers, neighbours, the trial and the chapter list all come from here. Pure.
 */

export type CardKind = "preface" | "chapter" | "section";

export interface CardPlace {
  kind: CardKind;
  /** 1-based chapter number (chapters only). */
  chapter?: number;
  /** The chapter a section belongs to (sections only). */
  chapterId?: string;
  /** 1-based place of a section in its chapter, in reading order (deeper levels are flattened). */
  sectionIndex?: number;
  sectionCount?: number;
}

/** The cards around one card (ids). `previous`/`next` are the chapters of a chapter or preface, the sections of a section. */
export interface CardNeighbours {
  previous?: string;
  next?: string;
  /** A section's chapter. */
  parent?: string;
  /** The next chapter, only for the last section of a chapter (its handoff leads there). */
  nextChapter?: string;
}

export interface BookStructure {
  placeOf(id: string): CardPlace | undefined;
  neighboursOf(id: string): CardNeighbours;
  /** The chapters (ids) in reading order. */
  chapters: readonly string[];
  /** A chapter's sections (ids) in reading order. */
  sectionsOf(chapterId: string): readonly string[];
  /** The trial: the preface, chapter 1 and all of its sections (reading order). */
  trialOf(): string[];
}

/**
 * `order` is the cards the run works on (reading order, `effectiveOrder`); `parentOf` the card's parent on the map. A card's section
 * chapter is its nearest ancestor that is a chapter; ancestors that are not in `order` (removed) are skipped, so a section whose
 * chapter was removed becomes a chapter itself. A card no chain of parents leads to the root (a cut cycle) is a chapter too.
 */
export function bookStructure(
  order: readonly string[],
  parentOf: (id: string) => string | null | undefined,
  rootId: string
): BookStructure {
  const inOrder = new Set(order);
  /** The nearest ancestor that is in `order` (the root counts), or null when the parents never reach one (a cycle). */
  const upOf = (id: string): string | null => {
    const seen = new Set<string>([id]);
    let up = parentOf(id) ?? null;
    while (up !== null && up !== rootId && !inOrder.has(up)) {
      if (seen.has(up)) return null;
      seen.add(up);
      up = parentOf(up) ?? null;
    }
    return up !== null && seen.has(up) ? null : up;
  };
  /** The chapter a card belongs to: itself when it hangs on the root (or no chain of parents leads there). */
  const chapterOf = (id: string): string => {
    const seen = new Set<string>([id]);
    let at = id;
    for (;;) {
      const up = upOf(at);
      if (up === rootId) return at;
      if (up === null || seen.has(up)) return id;
      seen.add(up);
      at = up;
    }
  };
  const chapters: string[] = [];
  const sections = new Map<string, string[]>();
  const chapterIds = new Map<string, string>();
  for (const id of order) {
    if (id === rootId) continue;
    const chapter = chapterOf(id);
    chapterIds.set(id, chapter);
    if (chapter === id) {
      chapters.push(id);
      sections.set(id, []);
    }
  }
  for (const id of order) {
    const chapter = chapterIds.get(id);
    if (chapter !== undefined && chapter !== id) sections.get(chapter)?.push(id);
  }
  const hasRoot = inOrder.has(rootId);
  const places = new Map<string, CardPlace>();
  if (hasRoot) places.set(rootId, { kind: "preface" });
  chapters.forEach((id, at) => places.set(id, { kind: "chapter", chapter: at + 1 }));
  for (const [chapterId, list] of sections)
    list.forEach((id, at) =>
      places.set(id, { kind: "section", chapterId, sectionIndex: at + 1, sectionCount: list.length })
    );
  const sectionsOf = (chapterId: string): readonly string[] => sections.get(chapterId) ?? [];
  return {
    placeOf: id => places.get(id),
    chapters,
    sectionsOf,
    neighboursOf(id) {
      const place = places.get(id);
      if (!place) return {};
      if (place.kind === "preface") return chapters.length ? { next: chapters[0] } : {};
      if (place.kind === "chapter") {
        const at = (place.chapter as number) - 1;
        const previous = at > 0 ? chapters[at - 1] : hasRoot ? rootId : undefined;
        return { ...(previous ? { previous } : {}), ...(chapters[at + 1] ? { next: chapters[at + 1] } : {}) };
      }
      const chapterId = place.chapterId as string;
      const list = sectionsOf(chapterId);
      const at = (place.sectionIndex as number) - 1;
      const nextChapter = chapters[chapters.indexOf(chapterId) + 1];
      return {
        parent: chapterId,
        ...(list[at - 1] ? { previous: list[at - 1] } : {}),
        ...(list[at + 1] ? { next: list[at + 1] } : {}),
        ...(at === list.length - 1 && nextChapter ? { nextChapter } : {})
      };
    },
    trialOf() {
      const first = chapters[0];
      const keep = new Set<string>([...(hasRoot ? [rootId] : []), ...(first ? [first, ...sectionsOf(first)] : [])]);
      return order.filter(id => keep.has(id));
    }
  };
}
