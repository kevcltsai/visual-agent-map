/**
 * The program's own checks beside the whole-book consistency call (no model): numbers the book gives for the same thing that cannot
 * both be true, a 「留到後面的章節」/「前面講過」 that points the wrong way, and the quotes a model finding shows checked against the
 * chapter text. Pure; run by `experiences/visual-map/book-pipeline-run.ts` with the call's findings.
 */
import type { ConsistencyFinding } from "./model";
import { singleLine } from "./text";

export interface CheckChapter {
  id: string;
  title: string;
  text: string;
}

// ---- numbers ----

const HAN_DIGIT: Record<string, number> = {
  〇: 0,
  零: 0,
  一: 1,
  二: 2,
  兩: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9
};

/** A number as written (Arabic, full-width or Han up to the hundreds; 「兩三」 is the range 2–3). */
function numberRange(value: string): [number, number] | undefined {
  const ascii = value.replace(/[０-９]/g, d => String(d.charCodeAt(0) - 0xff10));
  if (/^[0-9]+(?:\.[0-9]+)?$/.test(ascii)) return [Number(ascii), Number(ascii)];
  if (value === "半") return [0.5, 0.5];
  const chars = Array.from(value);
  if (
    chars.length === 2 &&
    chars.every(c => HAN_DIGIT[c] !== undefined) &&
    HAN_DIGIT[chars[1]] === HAN_DIGIT[chars[0]] + 1
  )
    return [HAN_DIGIT[chars[0]], HAN_DIGIT[chars[1]]];
  let total = 0;
  let digit: number | undefined;
  for (const c of chars) {
    if (HAN_DIGIT[c] !== undefined) {
      if (digit !== undefined) return undefined;
      digit = HAN_DIGIT[c];
    } else if (c === "十" || c === "百") {
      total += (digit ?? 1) * (c === "十" ? 10 : 100);
      digit = undefined;
    } else return undefined;
  }
  const n = total + (digit ?? 0);
  return [n, n];
}

const UNIT_CLASS: Record<string, string> = {
  小時: "h",
  小时: "h",
  鐘頭: "h",
  钟头: "h",
  公分: "cm",
  厘米: "cm",
  釐米: "cm",
  cm: "cm",
  公釐: "mm",
  毫米: "mm",
  mm: "mm",
  公尺: "m",
  公升: "l",
  升: "l",
  毫升: "ml",
  ml: "ml",
  公斤: "kg",
  kg: "kg",
  公克: "g",
  克: "g",
  月: "month",
  週: "week",
  周: "week",
  星期: "week",
  天: "day",
  年: "year",
  度: "deg"
};
const NUM = String.raw`[0-9０-９]+(?:\.[0-9]+)?|[〇零一二兩两三四五六七八九十百半]+`;
const QUANTITY = new RegExp(
  String.raw`(第)?(至少|最少|起碼|起码|超過|超过|不到|最多|頂多|顶多)?\s*(${NUM})(?:\s*(?:到|至|~|～|-|–|—|－)\s*(${NUM}))?\s*(?:(個多|个多|個|个|多)\s*)?(小時|小时|鐘頭|钟头|公分|厘米|釐米|公釐|毫米|公尺|毫升|公升|升|公斤|公克|克|月|週|周|星期|天|年|度|cm|mm|ml|kg)(以上|以下|以內|以内|之內|之内)?`,
  "giu"
);

/** One amount a sentence states: its unit, the values it allows, the words as written. */
export interface Quantity {
  unit: string;
  low: number;
  high: number;
  said: string;
}

/** Every amount in a sentence. A bare 「一天」「一年」「一度」 (a way of speaking, not a measure), an ordinal and a month name are left out. */
export function quantitiesIn(sentence: string): Quantity[] {
  const out: Quantity[] = [];
  for (const match of sentence.matchAll(QUANTITY)) {
    const [said, ordinal, before, first, second, counter, unitWord, after] = match;
    if (ordinal) continue;
    const unit = UNIT_CLASS[unitWord.toLowerCase()];
    if (!unit) continue;
    // 「3月」 is March; a month is counted 「三個月」.
    if (unit === "month" && !counter) continue;
    const a = numberRange(first);
    const b = second === undefined ? a : numberRange(second);
    if (!a || !b) continue;
    let low = Math.min(a[0], b[0]);
    let high = Math.max(a[1], b[1]);
    const more = !!counter && counter.endsWith("多");
    if (more) high = low + 0.99;
    if (first === "一" && second === undefined && !more && !before && !after) continue;
    if (/至少|最少|起碼|起码|超過|超过/.test(before ?? "") || after === "以上") high = Infinity;
    if (/不到|最多|頂多|顶多/.test(before ?? "") || /以下|以內|以内|之內|之内/.test(after ?? "")) low = 0;
    out.push({ unit, low, high, said: said.trim() });
  }
  return out;
}

// ---- sentences ----

interface Sentence {
  chapter: number;
  paragraph: number;
  text: string;
  /** The words that say what it is about: this sentence and the two before it in the paragraph, amounts taken out. */
  about: Set<string>;
  quantities: { quantity: Quantity; near: Set<string>; measure?: string }[];
  units: Set<string>;
}

/** Function words and generic phrases a topic is never told by. */
const FUNCTION_CHARS = new Set(
  Array.from(
    "的了是在和與与及也都就要有你我他她它這这那會会能很更還还一個个不得著着把被讓让對对從从向以為为而且或則则之其些再才只每多少大小約约"
  )
);
const STOP_BIGRAMS = new Set([
  "可以",
  "需要",
  "建議",
  "建议",
  "如果",
  "所以",
  "因為",
  "因为",
  "但是",
  "比較",
  "比较",
  "通常",
  "最好",
  "左右",
  "以上",
  "時間",
  "时间",
  "時候",
  "时候",
  "方式",
  "情況",
  "情况",
  "部分",
  "地方"
]);
const HAN = /\p{Script=Han}/u;

function topicWords(text: string): Set<string> {
  const plain = text.replace(QUANTITY, " ");
  const words = new Set<string>();
  const chars = Array.from(plain);
  for (let i = 0; i + 1 < chars.length; i++) {
    const [x, y] = [chars[i], chars[i + 1]];
    if (!HAN.test(x) || !HAN.test(y) || FUNCTION_CHARS.has(x) || FUNCTION_CHARS.has(y)) continue;
    if (/[〇零二兩两三四五六七八九十百半]/u.test(x + y)) continue;
    const word = x + y;
    if (!STOP_BIGRAMS.has(word)) words.add(word);
  }
  return words;
}

/** What a length measures, by the word before it in its clause (「直徑約二十公分」) or right after the unit (「三十公分深」). */
const MEASURE =
  /(深度|深|高度|高|長度|长度|長|长|寬度|宽度|寬|宽|直徑|直径|口徑|口径|厚度|厚|間隔|间隔|間距|间距|距離|距离|離|离)/gu;
const MEASURE_KEY: Record<string, string> = {
  深度: "深",
  高度: "高",
  長度: "長",
  长度: "長",
  长: "長",
  寬度: "寬",
  宽度: "寬",
  宽: "寬",
  直径: "直徑",
  口徑: "直徑",
  口径: "直徑",
  厚度: "厚",
  间隔: "間隔",
  間距: "間隔",
  间距: "間隔",
  距離: "離",
  距离: "離",
  离: "離"
};
const LENGTH = new Set(["cm", "mm", "m"]);

function measureOf(clause: string, quantity: Quantity): string | undefined {
  const at = clause.indexOf(quantity.said);
  const after = /^\s*(深|高|長|长|寬|宽|厚)/u.exec(clause.slice(at + quantity.said.length))?.[1];
  const before = [...clause.slice(0, at).matchAll(MEASURE)].pop()?.[1];
  const word = before ?? after;
  return word && (MEASURE_KEY[word] ?? word);
}

/**
 * The things a book treats one by one, from its headings: the words before a colon (「### 小白菜：最容易成功的第一選擇」, a bold
 * 「**小番茄：…**」). A sentence about one of them is not compared with a sentence about another.
 */
export function subjectsOf(chapters: readonly CheckChapter[]): string[] {
  const found = new Set<string>();
  for (const chapter of chapters)
    for (const match of chapter.text.matchAll(/^\s*(?:#{1,6}\s+|\*\*)([^：:\n*]{2,6})[：:]/gmu)) {
      const name = match[1].trim();
      if (Array.from(name).every(c => HAN.test(c)) && !/[0-9一二三四五六七八九十]/u.test(name)) found.add(name);
    }
  return [...found];
}

/** A line that is not prose (heading, table, callout, list marker kept): tables and headings carry no comparable sentence. */
const SKIP_LINE = /^\s*(?:#{1,6}\s|\||>|<!--)/;

function sentencesOf(chapter: number, text: string): Sentence[] {
  const out: Sentence[] = [];
  text.split(/\n\s*\n/).forEach((block, paragraph) => {
    const lines = block.split("\n").filter(line => line.trim() && !SKIP_LINE.test(line));
    const parts = lines
      .join("\n")
      .split(/(?<=[。！？!?；;])|\n/u)
      .map(part => part.replace(/^[\s>*-]*(?:\[[ xX]\]\s*)?/, "").trim())
      .filter(Boolean);
    parts.forEach((part, at) => {
      if (!quantitiesIn(part).length) return;
      const lead = parts.slice(Math.max(0, at - 2), at).join("");
      const about = topicWords(lead + part);
      // What an amount is about up close: its clause and the clause before it (the whole lead when they name nothing).
      const clauses = part.split(/(?<=[，,、：:（）()])/u);
      const quantities = clauses.flatMap((clause, i) =>
        quantitiesIn(clause).map(quantity => {
          const near = topicWords((clauses[i - 1] ?? "") + clause);
          const measure = LENGTH.has(quantity.unit) ? measureOf(clause, quantity) : undefined;
          return { quantity, near: near.size ? near : about, measure };
        })
      );
      if (quantities.length)
        out.push({
          chapter,
          paragraph,
          text: part,
          about,
          quantities,
          units: new Set(quantities.map(q => q.quantity.unit))
        });
    });
  });
  return out;
}

/** Topic words two sentences share at least for the program to say they talk about the same thing: around both, and next to both amounts. */
const SAME_TOPIC_WORDS = 3;
const SAME_NEAR_WORDS = 2;
/** The most number findings one check adds (the model's call stays the main check). */
export const NUMERIC_MAX_FINDINGS = 8;
const QUOTE_MAX = 160;

const shared = (x: Set<string>, y: Set<string>): number => [...x].filter(word => y.has(word)).length;
const disjoint = (x: Quantity, y: Quantity): boolean => x.high < y.low || y.high < x.low;
const normal = (value: string): string => value.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");

/**
 * Numbers that cannot both hold: two sentences (other chapters, or other paragraphs of one chapter) that share at least
 * {@link SAME_TOPIC_WORDS} topic words and give amounts of the same unit whose ranges do not meet (「八小時」 and 「四到六小時」;
 * 「至少十公分」 and 「十五到二十公分」 do meet). One finding per pair of chapters and unit, the pair sharing the most words; a pair the
 * model already reported (same chapters, one of the amounts in its claims) is left out. `claimA`/`claimB` are the sentences as written.
 */
export function numericFindings(
  chapters: readonly CheckChapter[],
  known: readonly ConsistencyFinding[] = []
): ConsistencyFinding[] {
  const sentences = chapters.flatMap((chapter, at) => sentencesOf(at, chapter.text));
  const subjects = subjectsOf(chapters);
  const named = new Map(sentences.map(sentence => [sentence, subjects.filter(name => sentence.text.includes(name))]));
  const otherThings = (x: Sentence, y: Sentence): boolean => {
    const [sx, sy] = [named.get(x) ?? [], named.get(y) ?? []];
    return sx.length > 0 && sy.length > 0 && !sx.some(name => sy.includes(name));
  };
  const best = new Map<string, { score: number; x: Sentence; y: Sentence; qx: Quantity; qy: Quantity }>();
  for (let i = 0; i < sentences.length; i++) {
    for (let j = i + 1; j < sentences.length; j++) {
      const x = sentences[i];
      const y = sentences[j];
      if ((x.chapter === y.chapter && x.paragraph === y.paragraph) || ![...x.units].some(unit => y.units.has(unit)))
        continue;
      const score = shared(x.about, y.about);
      if (score < SAME_TOPIC_WORDS || otherThings(x, y)) continue;
      for (const { quantity: qx, near: nx, measure: mx } of x.quantities) {
        // A sentence that itself gives two different values of this unit compares alternatives; it is not a claim to hold.
        if (x.quantities.some(({ quantity: o }) => o !== qx && o.unit === qx.unit && disjoint(o, qx))) continue;
        for (const { quantity: qy, near: ny, measure: my } of y.quantities) {
          if (qx.unit !== qy.unit || !disjoint(qx, qy) || shared(nx, ny) < SAME_NEAR_WORDS) continue;
          if (mx && my && mx !== my) continue;
          if (y.quantities.some(({ quantity: o }) => o !== qy && o.unit === qy.unit && !disjoint(o, qx))) continue;
          const key = `${x.chapter}:${y.chapter}:${qx.unit}`;
          const held = best.get(key);
          if (!held || score > held.score) best.set(key, { score, x, y, qx, qy });
        }
      }
    }
  }
  const reported = (a: string, b: string, said: string[]): boolean =>
    known.some(
      finding =>
        ((finding.a === a && finding.b === b) || (finding.a === b && finding.b === a)) &&
        said.some(text => normal(finding.claimA + finding.claimB).includes(normal(text)))
    );
  return [...best.values()]
    .sort((p, q) => q.score - p.score)
    .filter(({ x, y, qx, qy }) => !reported(chapters[x.chapter].id, chapters[y.chapter].id, [qx.said, qy.said]))
    .slice(0, NUMERIC_MAX_FINDINGS)
    .sort((p, q) => p.x.chapter - q.x.chapter || p.y.chapter - q.y.chapter)
    .map(({ x, y }) => ({
      a: chapters[x.chapter].id,
      b: chapters[y.chapter].id,
      claimA: singleLine(x.text, QUOTE_MAX),
      claimB: singleLine(y.text, QUOTE_MAX),
      suggestion: ""
    }));
}

// ---- 「後面的章節」/「前面講過」 ----

/** Words that send the reader to a later or an earlier chapter without a number (「下一章」「第N章」 are `chapter-references.ts`). */
const POINTER =
  /(留到後面|留到后面|留到之後|留到之后|後面的章節|后面的章节|之後的章節|之后的章节|後面幾章|后面几章|後續章節|后续章节|後面會講|后面会讲|後面會談|后面会谈|後面再講|后面再讲)|(前面講過|前面讲过|前面提過|前面提过|前面說過|前面说过|前面的章節|前面的章节|前幾章|前几章|之前的章節|之前的章节|前一章提過|前一章提过)/gu;

/** A chapter title's own words (「播種與育苗」 → 播種, 育苗): split at 與/和/及/、 and spaces; words shorter than two characters are dropped. */
function titleWords(title: string): string[] {
  return title
    .split(/[與与和及、,，\s:：/]+/u)
    .map(word => word.trim())
    .filter(word => Array.from(word).length >= 2);
}

/**
 * A pointer that goes the wrong way: a sentence says a subject comes later (「播種、育苗留到後面的章節再講」) or was told earlier
 * (「前面講過」) and the subject is the title of a chapter on the other side. The chapter is the one other chapter whose title words the
 * sentence names most (a tie is not judged). `claimA` is the sentence, `claimB` the pointer words, `suggestion` where the chapter
 * really is (「前面的第3章」).
 */
export function directionFindings(chapters: readonly CheckChapter[]): ConsistencyFinding[] {
  const words = chapters.map(chapter => titleWords(chapter.title));
  const out: ConsistencyFinding[] = [];
  chapters.forEach((chapter, self) => {
    for (const paragraph of chapter.text.split(/\n\s*\n/)) {
      if (SKIP_LINE.test(paragraph)) continue;
      for (const sentence of paragraph.split(/(?<=[。！？!?])|\n/u)) {
        const pointer = POINTER.exec(sentence);
        POINTER.lastIndex = 0;
        if (!pointer) continue;
        const later = pointer[1] !== undefined;
        const hits = words.map((list, at) => (at === self ? 0 : list.filter(word => sentence.includes(word)).length));
        const most = Math.max(...hits);
        if (!most || hits.filter(n => n === most).length > 1) continue;
        const target = hits.indexOf(most);
        if (later === target > self) continue;
        const simplified = /[后们几说讲]/u.test(pointer[0]);
        const side = target < self ? "前面" : simplified ? "后面" : "後面";
        out.push({
          kind: "direction",
          a: chapter.id,
          b: chapters[target].id,
          claimA: singleLine(sentence.replace(/^[\s>*-]*(?:\[[ xX]\]\s*)?/, ""), QUOTE_MAX),
          claimB: pointer[0],
          suggestion: `${side}的第${target + 1}章`
        });
      }
    }
  });
  return out;
}

// ---- quotes ----

/**
 * A model's quote of a chapter, checked against the chapter: kept when the chapter has it (spacing and punctuation aside); otherwise
 * the chapter's sentence that gives the same amount and shares the most topic words with the quote; `undefined` when there is none
 * (the claim is then shown as a paraphrase, not in quotes).
 */
export function verbatimQuote(claim: string, text: string): string | undefined {
  const want = normal(claim);
  if (want && normal(text).includes(want)) return claim;
  const amounts = quantitiesIn(claim);
  if (!amounts.length) return undefined;
  const words = topicWords(claim);
  let best: { sentence: string; score: number } | undefined;
  for (const line of text.split("\n")) {
    if (SKIP_LINE.test(line)) continue;
    for (const part of line.split(/(?<=[。！？!?])/u)) {
      const sentence = part.replace(/^[\s>*-]*(?:\[[ xX]\]\s*)?/, "").trim();
      const own = quantitiesIn(sentence);
      if (!amounts.some(x => own.some(y => x.unit === y.unit && x.low === y.low && x.high === y.high))) continue;
      const score = shared(words, topicWords(sentence));
      if (!best || score > best.score) best = { sentence, score };
    }
  }
  return best && singleLine(best.sentence, QUOTE_MAX);
}
