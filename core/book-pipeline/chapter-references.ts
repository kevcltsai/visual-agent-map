/**
 * The chapter references of a book, checked without a model: a 「第N章」/"Chapter N" or 「下一章／上一章」/"next/previous chapter" in a
 * chapter's prose must point at the chapter it talks about, in the book's current order (1 is the first chapter, the intro included).
 * What the reference talks about comes from a title in quotes right after it (「第五章「採收與保存」」); for a numbered reference without
 * one, from the one other chapter title its paragraph names, and a number the chapter already used wrongly that way is wrong elsewhere
 * in the same chapter too. Pure; part of the
 * whole-book consistency check (`experiences/visual-map/book-pipeline-run.ts`), its findings have `kind: "reference"`.
 */
import type { ConsistencyFinding } from "./model";
import { singleLine } from "./text";

export interface ReferenceChapter {
  id: string;
  title: string;
  text: string;
}

const CJK_DIGIT: Record<string, number> = {
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
const EN_NUMBER = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve"
];

function numberOf(value: string): number | undefined {
  const lower = value.toLowerCase();
  if (/^[0-9０-９]+$/.test(lower)) return Number(lower.replace(/[０-９]/g, d => String(d.charCodeAt(0) - 0xff10)));
  if (EN_NUMBER.includes(lower)) return EN_NUMBER.indexOf(lower);
  const ten = lower.indexOf("十");
  if (ten < 0) return lower.length === 1 ? CJK_DIGIT[lower] : undefined;
  const tens = ten === 0 ? 1 : CJK_DIGIT[lower.slice(0, ten)];
  const ones = ten === lower.length - 1 ? 0 : CJK_DIGIT[lower.slice(ten + 1)];
  return tens === undefined || ones === undefined ? undefined : tens * 10 + ones;
}
function cjkNumeral(n: number): string {
  const digit = "零一二三四五六七八九";
  if (n < 10) return digit[n];
  const tens = Math.floor(n / 10);
  return `${tens === 1 ? "" : digit[tens]}十${n % 10 ? digit[n % 10] : ""}`;
}

type Style = "cjk" | "digit" | "latin";
interface Reference {
  /** Offset in the paragraph. */
  at: number;
  end: number;
  said: string;
  /** 0-based chapter the words point at (may be outside the book). */
  target: number;
  style: Style;
  /** A numbered reference (`第N章`, "Chapter N"): the number keys the chapter's own wrong uses. */
  numbered: boolean;
}

const REFERENCE =
  /第\s*([0-9０-９]{1,2}|[一二兩两三四五六七八九十]{1,3})\s*章|(下一章|後一章|后一章|上一章|前一章)|\bchapter\s+([0-9]{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b|\b(next|previous|preceding)\s+chapter\b/giu;

function referencesIn(paragraph: string, self: number): Reference[] {
  const found: Reference[] = [];
  for (const match of paragraph.matchAll(REFERENCE)) {
    const at = match.index ?? 0;
    const said = match[0];
    const end = at + said.length;
    if (match[1] !== undefined || match[3] !== undefined) {
      const n = numberOf(match[1] ?? match[3]);
      if (!n) continue;
      const style: Style = match[3] !== undefined ? "latin" : /^[0-9０-９]+$/.test(match[1]) ? "digit" : "cjk";
      found.push({ at, end, said, target: n - 1, style, numbered: true });
    } else {
      const next = /^(下一章|後一章|后一章|next)$/i.test(match[2] ?? match[4]);
      found.push({ at, end, said, target: self + (next ? 1 : -1), style: match[4] ? "latin" : "cjk", numbered: false });
    }
  }
  return found;
}

const normal = (value: string): string => value.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
const QUOTED_TITLE = /^\s*[,，:：]?\s*[「『“"〈《]([^」』”"〉》\n]{1,80})[」』”"〉》]/u;

/** The sentence around `at` in a paragraph, one line. */
function sentenceAt(paragraph: string, at: number, end: number): string {
  const stop = /[。！？!?\n]|\.(?=\s|$)/gu;
  let start = 0;
  let finish = paragraph.length;
  for (const match of paragraph.matchAll(stop)) {
    const i = match.index ?? 0;
    if (i < at) start = i + 1;
    else if (i >= end) {
      finish = i + 1;
      break;
    }
  }
  return singleLine(paragraph.slice(start, finish).replace(/^[\s>*-]*(?:\[[ xX]\]\s*)?/, ""), 160);
}

/**
 * Every chapter reference that points at a chapter other than the one it talks about: one finding per wrong reference, `a` the
 * chapter that says it, `b` the chapter it should name, `claimA` the sentence, `claimB` the words used, `suggestion` the right ones.
 */
export function chapterReferenceFindings(chapters: readonly ReferenceChapter[]): ConsistencyFinding[] {
  const titles = chapters.map(chapter => normal(chapter.title));
  const titleAt = (quoted: string): number | undefined => {
    const want = normal(quoted);
    if (want.length < 2) return undefined;
    const hits = titles.flatMap((title, i) =>
      title.length >= 2 && (title.includes(want) || want.includes(title)) ? [i] : []
    );
    return hits.length === 1 ? hits[0] : undefined;
  };
  const right = (reference: Reference, n: number): string =>
    reference.style === "latin"
      ? `Chapter ${n + 1}`
      : reference.style === "digit"
        ? `第${n + 1}章`
        : `第${cjkNumeral(n + 1)}章`;
  const findings: ConsistencyFinding[] = [];
  chapters.forEach((chapter, self) => {
    const wrong: { reference: Reference; paragraph: string; meant: number }[] = [];
    const open: { reference: Reference; paragraph: string }[] = [];
    for (const paragraph of chapter.text.split(/\n\s*\n/)) {
      const found = referencesIn(paragraph, self).map(reference => {
        const quoted = QUOTED_TITLE.exec(paragraph.slice(reference.end));
        return { reference, meant: quoted ? titleAt(quoted[1]) : undefined };
      });
      // A title in quotes after a reference belongs to that reference, not to the paragraph.
      const bound = new Set(found.flatMap(item => (item.meant === undefined ? [] : [item.meant])));
      const flat = normal(paragraph);
      const named = titles.flatMap((title, i) =>
        i !== self && !bound.has(i) && title.length >= 2 && flat.includes(title) ? [i] : []
      );
      for (const { reference, meant } of found) {
        if (meant !== undefined) {
          if (meant !== reference.target) wrong.push({ reference, paragraph, meant });
          continue;
        }
        // "Next/previous chapter" is checked only against a title in quotes after it.
        if (!reference.numbered || named.includes(reference.target)) continue;
        if (named.length === 1) wrong.push({ reference, paragraph, meant: named[0] });
        else open.push({ reference, paragraph });
      }
    }
    // A number this chapter used for another chapter means that chapter wherever else it stands here (one meaning per number).
    const meaning = new Map<string, number | null>();
    for (const { reference, meant } of wrong) {
      if (!reference.numbered) continue;
      const key = `${reference.style === "latin" ? "latin" : "han"}:${reference.target}`;
      meaning.set(key, meaning.has(key) && meaning.get(key) !== meant ? null : meant);
    }
    for (const { reference, paragraph } of open) {
      const meant = reference.numbered
        ? meaning.get(`${reference.style === "latin" ? "latin" : "han"}:${reference.target}`)
        : undefined;
      if (meant !== undefined && meant !== null) wrong.push({ reference, paragraph, meant });
    }
    wrong.sort(
      (x, y) => chapter.text.indexOf(x.paragraph) - chapter.text.indexOf(y.paragraph) || x.reference.at - y.reference.at
    );
    const seen = new Set<string>();
    for (const { reference, paragraph, meant } of wrong) {
      const claimA = sentenceAt(paragraph, reference.at, reference.end);
      const key = `${meant}\u0000${reference.said}\u0000${claimA}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({
        kind: "reference",
        a: chapter.id,
        b: chapters[meant].id,
        claimA,
        claimB: reference.said,
        suggestion: right(reference, meant)
      });
    }
  });
  return findings;
}
