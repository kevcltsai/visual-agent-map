export interface CoffeeOutlineItem {
  id: string;
  text: string;
  sourceText?: string;
  context?: string;
  depth: number;
}

export interface CoffeeOutlineSection {
  id: string;
  title: string;
  depth: number;
  items: CoffeeOutlineItem[];
}

export interface CoffeeSpeechTarget {
  id: string;
  text: string;
  order: number;
}

export interface CoffeeOutlineSnapshot {
  sessionId: string;
  topic: string;
  notesRevision: string;
  dirty: boolean;
  sections: CoffeeOutlineSection[];
}

const ROOT_HEADING = /^(?:觀察者整理|observer(?:[’']s)? notes)$/i;
const LIST_ITEM = /^(\s*)(?:[-+*]|\d+[.)])\s+(.+?)\s*$/;
const CJK_EDGE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const SOURCE_REFERENCE = /\s*<!--\s*source:\s*([\s\S]*?)\s*-->\s*$/i;
interface OutlineListEntry { indent: number; item: CoffeeOutlineItem }

function splitSourceReference(value: string): { text: string; sourceText?: string } {
  const marker = SOURCE_REFERENCE.exec(value);
  return marker
    ? { text: value.slice(0, marker.index).trimEnd(), sourceText: plainMarkdown(marker[1]) }
    : { text: value };
}

function joinSoftLine(left: string, right: string): string {
  const before = [...left.trimEnd()].at(-1) ?? "";
  const after = [...right.trimStart()][0] ?? "";
  const cjkBefore = CJK_EDGE.test(before) || (/[，。！？；：、]/u.test(before) && CJK_EDGE.test([...left.trimEnd()].at(-2) ?? ""));
  return `${left.trimEnd()}${cjkBefore && CJK_EDGE.test(after) ? "" : " "}${right.trimStart()}`;
}

function plainMarkdown(value: string): string {
  return value
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`+([^`]+)`+/g, "$1")
    .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseCoffeeOutline(markdown: string): CoffeeOutlineSection[] {
  const sections: CoffeeOutlineSection[] = [];
  let current: CoffeeOutlineSection | null = null;
  let listStack: OutlineListEntry[] = [];
  let activeItem: OutlineListEntry | null = null;
  let paragraph: string[] = [];
  let fence: { marker: string; length: number } | null = null;

  const ensureSection = (): CoffeeOutlineSection => {
    if (!current) {
      current = { id: `section-${sections.length}`, title: "觀察者整理", depth: 2, items: [] };
      sections.push(current);
    }
    return current;
  };
  const flushParagraph = (): void => {
    const source = splitSourceReference(paragraph.reduce(joinSoftLine, ""));
    const text = plainMarkdown(source.text);
    paragraph = [];
    if (!text) return;
    const section = ensureSection();
    section.items.push({ id: `${section.id}-item-${section.items.length}`, text, ...(source.sourceText ? { sourceText: source.sourceText } : {}), depth: 0 });
    activeItem = null;
    listStack = [];
  };
  const getActiveItem = (): OutlineListEntry | null => activeItem;
  const addListItem = (indent: number, rawText: string): void => {
    const section = ensureSection();
    while (listStack.length && listStack.at(-1)!.indent >= indent) listStack.pop();
    const parent = listStack.at(-1)?.item;
    const source = splitSourceReference(rawText);
    if (parent) {
      const value = plainMarkdown(source.text).replace(/^(?:脈絡|來賓的理由|脈絡與分歧|context|reasoning|原疑問|疑問|question|可能解方|possible solution|條件與限制|限制|conditions and limits)：?\s*/i, "");
      parent.context = [parent.context, value].filter(Boolean).join(" ");
      if (source.sourceText) parent.sourceText = source.sourceText;
      activeItem = { indent, item: parent };
      listStack.push({ indent, item: parent });
      return;
    }
    const item: CoffeeOutlineItem = { id: `${section.id}-item-${section.items.length}`, text: plainMarkdown(source.text), ...(source.sourceText ? { sourceText: source.sourceText } : {}), depth: 0 };
    section.items.push(item);
    listStack.push({ indent, item });
    activeItem = { indent, item };
  };

  for (const line of markdown.split(/\r?\n/)) {
    if (fence) {
      const close = new RegExp(`^\\s*${fence.marker}{${fence.length},}\\s*$`);
      if (close.test(line)) fence = null;
      continue;
    }
    const fenceStart = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fenceStart) {
      flushParagraph();
      fence = { marker: fenceStart[1][0], length: fenceStart[1].length };
      activeItem = null;
      continue;
    }

    const heading = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      flushParagraph();
      const title = plainMarkdown(heading[2]);
      if (ROOT_HEADING.test(title)) {
        current = null;
        listStack = [];
        activeItem = null;
        continue;
      }
      current = { id: `section-${sections.length}`, title, depth: heading[1].length, items: [] };
      sections.push(current);
      listStack = [];
      activeItem = null;
      continue;
    }

    const bullet = LIST_ITEM.exec(line);
    if (bullet) {
      flushParagraph();
      addListItem(bullet[1].replace(/\t/g, "    ").length, bullet[2]);
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      activeItem = null;
      continue;
    }

    const indentation = line.match(/^\s*/)?.[0].replace(/\t/g, "    ").length ?? 0;
    const previousListItem = getActiveItem();
    if (previousListItem && indentation > previousListItem.indent) {
      const parentItem = previousListItem.item;
      const source = splitSourceReference(line.trim());
      parentItem.text = plainMarkdown(joinSoftLine(parentItem.text, source.text));
      if (source.sourceText) parentItem.sourceText = source.sourceText;
    } else {
      paragraph.push(line.trim());
    }
  }
  flushParagraph();
  return sections;
}

function normalizeText(value: string): string {
  return plainMarkdown(value).normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

const STOPWORDS = new Set(["以及", "是否", "如何", "可以", "這個", "這些", "因此", "所以", "但是", "不過", "還是", "如果", "因為", "以及", "問題", "觀察", "整理", "對話", "來賓", "作品"]);
const MIN_RELATED_SPEECH_SCORE = 0.08;
const STRONG_RELATED_SPEECH_SCORE = 0.28;
const AMBIGUOUS_SCORE_GAP = 0.18;
const NEAR_DUPLICATE_SPEECH_SIMILARITY = 0.45;
function tokens(value: string): Set<string> {
  const result = new Set<string>();
  const normalized = plainMarkdown(value).normalize("NFKC").toLocaleLowerCase();
  for (const segment of normalized.matchAll(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|[\p{L}\p{N}]+/gu)) {
    const part = segment[0];
    if (/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+$/u.test(part)) {
      for (let index = 0; index < part.length - 1; index++) {
        const pair = part.slice(index, index + 2);
        if (!STOPWORDS.has(pair)) result.add(pair);
      }
    } else if (part.length > 1 && !STOPWORDS.has(part)) result.add(part);
  }
  return result;
}

function paragraphTexts(value: string): string[] {
  return value.split(/\n\s*\n/).flatMap(part => part.split(/(?<=[。！？!?；;])\s*/u)).map(part => part.trim()).filter(Boolean);
}

export function findRelatedSpeech(text: string, targets: CoffeeSpeechTarget[]): string | null {
  const query = normalizeText(text);
  if ([...query].length < 8) return null;
  const usable = targets.map(target => ({ ...target, normalized: normalizeText(target.text) })).filter(target => target.id && [...target.normalized].length >= 8);
  const direct = usable.filter(target => [...target.normalized].length >= 8 && (target.normalized.includes(query) || query.includes(target.normalized)));
  if (direct.length) {
    const distinct = new Set(direct.map(target => target.normalized));
    if (distinct.size === 1) return direct.sort((a, b) => a.order - b.order)[0].id;
  }

  const queryTokens = tokens(text);
  if (queryTokens.size < 3) return null;
  const documents = usable.map(target => new Set(tokens(target.text)));
  const frequencies = new Map<string, number>();
  for (const document of documents) for (const token of document) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
  const weight = (token: string): number => Math.log(1 + (documents.length + 1) / ((frequencies.get(token) ?? 0) + 1));
  const queryWeight = [...queryTokens].reduce((total, token) => total + weight(token), 0);
  const scored = usable.map((target, index) => {
    const paragraphs = paragraphTexts(target.text);
    const score = Math.max(0, ...paragraphs.map(paragraph => {
      const candidateTokens = tokens(paragraph);
      const shared = [...queryTokens].filter(token => candidateTokens.has(token));
      if (shared.length < 3) return 0;
      const sharedWeight = shared.reduce((total, token) => total + weight(token), 0);
      const candidateWeight = [...candidateTokens].reduce((total, token) => total + weight(token), 0);
      return 2 * sharedWeight / (queryWeight + candidateWeight);
    }));
    return { target, score, index };
  }).filter(item => item.score >= MIN_RELATED_SPEECH_SCORE).sort((a, b) => b.score - a.score || a.target.order - b.target.order);
  if (!scored.length) return null;
  const [best, second] = scored;
  // Observer summaries often describe several adjacent replies; reject close scores only when both replies are strong and near-duplicates.
  if (second && best.target.normalized !== second.target.normalized && best.score >= STRONG_RELATED_SPEECH_SCORE && second.score >= STRONG_RELATED_SPEECH_SCORE && best.score - second.score < AMBIGUOUS_SCORE_GAP) {
    const bestTokens = tokens(best.target.text), secondTokens = tokens(second.target.text);
    const shared = [...bestTokens].filter(token => secondTokens.has(token)).length;
    const similarity = shared / Math.max(1, new Set([...bestTokens, ...secondTokens]).size);
    if (similarity >= NEAR_DUPLICATE_SPEECH_SIMILARITY) return null;
  }
  return best.target.id;
}
