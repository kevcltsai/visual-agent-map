/**
 * The whole-book consistency check (one call per run, after every chapter is written and proofread): what it is asked about, how
 * long the chapter texts it sends may be, and what a finding means for one chapter. Pure. The call itself is the step
 * `core/steps/book-pipeline/consistency.ts`; the state it keeps (`BookPipelineData.consistency`) is gated by the machine.
 */
import { effectiveOrder, type BookPipelineData, type ConsistencyFinding } from "./model";

const revisionOf = (data: BookPipelineData, id: string): number => data.revisions[id] ?? 0;

/**
 * What the check was asked for: every chapter of the run with its revision. A chapter written again (a redo, a rerun) changes it,
 * so a resume asks again only when a chapter changed.
 */
export function consistencyKey(data: BookPipelineData): string {
  return effectiveOrder(data)
    .map(id => `${id}:${revisionOf(data, id)}`)
    .join(",");
}

/** Characters of chapter text one check sends at most (about one long book's worth of facts; CJK is about a token a character). */
export const CONSISTENCY_CHAR_BUDGET = 60_000;

const SENTENCE = /(?<=[。！？!?])|\n+/u;
/** A sentence that carries a number or an amount: the claims two chapters can contradict (days, sizes, how often). */
const FACT =
  /[0-9０-９]|[一二兩两三四五六七八九十百千半幾几][到至~～\-－]?[一二兩两三四五六七八九十百千]?\s*(?:天|日|週|周|星期|個月|个月|年|小時|小时|分鐘|分钟|公分|厘米|釐米|公尺|米|公升|升|毫升|度|次|倍|片|顆|颗|株|杯|匙|成|%)/u;

export interface ConsistencyChapter {
  title: string;
  text: string;
}
/**
 * The chapters as the check gets them: whole when they fit {@link CONSISTENCY_CHAR_BUDGET} together; otherwise each one only its
 * sentences with a number or an amount (the claims that can contradict), and every chapter cut to an equal share of the budget.
 */
export function compactChapters(
  chapters: readonly ConsistencyChapter[],
  budget = CONSISTENCY_CHAR_BUDGET
): ConsistencyChapter[] {
  const total = chapters.reduce((sum, chapter) => sum + chapter.text.length, 0);
  if (total <= budget) return chapters.map(chapter => ({ ...chapter }));
  const share = Math.max(200, Math.floor(budget / Math.max(1, chapters.length)));
  return chapters.map(chapter => {
    const facts = chapter.text
      .split(SENTENCE)
      .map(sentence => sentence.trim())
      .filter(sentence => sentence && FACT.test(sentence))
      .join(" ");
    return { title: chapter.title, text: Array.from(facts).slice(0, share).join("") };
  });
}

/** One finding as one chapter sees it: the other chapter, what this one says, what the other says, the suggested fix (may be empty). */
export interface ChapterInconsistency {
  other: string;
  own: string;
  theirs: string;
  suggestion: string;
}
/**
 * The findings of the last check that name this chapter, as long as the chapter is the text that was checked (a chapter written again
 * since then has none; the other chapter may have changed, the reader still sees what was said).
 */
export function chapterInconsistencies(data: BookPipelineData, nodeId: string): ChapterInconsistency[] {
  const check = data.consistency;
  if (!check?.findings?.length || !check.revisions) return [];
  if (check.revisions[nodeId] === undefined || check.revisions[nodeId] !== revisionOf(data, nodeId)) return [];
  return check.findings.flatMap((finding: ConsistencyFinding): ChapterInconsistency[] =>
    finding.a === nodeId
      ? [{ other: finding.b, own: finding.claimA, theirs: finding.claimB, suggestion: finding.suggestion }]
      : finding.b === nodeId
        ? [{ other: finding.a, own: finding.claimB, theirs: finding.claimA, suggestion: finding.suggestion }]
        : []
  );
}
