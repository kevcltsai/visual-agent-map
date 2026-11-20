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

/**
 * Characters of chapter text one check sends at most (a small or mid-size book goes whole; CJK is about a token a character, so
 * this stays well inside the step's token budget).
 */
export const CONSISTENCY_CHAR_BUDGET = 100_000;

const SENTENCE = /(?<=[。！？!?])/u;
const HEADING = /^#{1,6}\s/;
const TABLE_ROW = /^\|/;
const TABLE_RULE = /^\|[\s:|-]+$/;
/** A sentence that carries a number or an amount: the claims two chapters can contradict (days, sizes, how often). */
const FACT =
  /[0-9０-９]|[一二兩两三四五六七八九十百千半幾几][到至~～\-－]?[一二兩两三四五六七八九十百千]?\s*(?:天|日|週|周|星期|個月|个月|年|小時|小时|分鐘|分钟|公分|厘米|釐米|公釐|毫米|公尺|米|吋|公升|升|毫升|公斤|公克|克|度|次|倍|片|顆|颗|株|杯|匙|節|节|成|%)/u;

export interface ConsistencyChapter {
  title: string;
  text: string;
}

/**
 * A chapter's claims with what they are about: every sentence with a number or an amount together with the sentence before it
 * (where the subject usually stands), the heading it sits under, and a table's header row with each of its rows that holds a number.
 */
export function factExtract(text: string): string {
  const out: string[] = [];
  let heading = "";
  let headingOut = true;
  let tableHead = "";
  let tableHeadOut = false;
  const lead = (): void => {
    if (!headingOut) out.push(heading);
    headingOut = true;
  };
  for (const raw of text.split("\n")) {
    const line = raw.replace(/^>\s?/, "").trim();
    if (!line) {
      tableHead = "";
      continue;
    }
    if (HEADING.test(line)) {
      heading = line;
      headingOut = false;
      tableHead = "";
      continue;
    }
    if (TABLE_ROW.test(line)) {
      if (TABLE_RULE.test(line)) continue;
      if (!tableHead) {
        tableHead = line;
        tableHeadOut = false;
      } else if (FACT.test(line)) {
        lead();
        if (!tableHeadOut) out.push(tableHead);
        tableHeadOut = true;
        out.push(line);
      }
      continue;
    }
    tableHead = "";
    const sentences = line
      .split(SENTENCE)
      .map(sentence => sentence.trim())
      .filter(Boolean);
    const kept = new Set<number>();
    sentences.forEach((sentence, at) => {
      if (!FACT.test(sentence)) return;
      if (at > 0) kept.add(at - 1);
      kept.add(at);
    });
    if (!kept.size) continue;
    lead();
    out.push(sentences.filter((_, at) => kept.has(at)).join(""));
  }
  return out.join("\n");
}

/**
 * The chapters as the check gets them: whole when they fit {@link CONSISTENCY_CHAR_BUDGET} together; otherwise each one only its
 * claims ({@link factExtract}), the budget shared out so a chapter with fewer claims leaves its unused part to the others.
 */
export function compactChapters(
  chapters: readonly ConsistencyChapter[],
  budget = CONSISTENCY_CHAR_BUDGET
): ConsistencyChapter[] {
  const total = chapters.reduce((sum, chapter) => sum + chapter.text.length, 0);
  if (total <= budget) return chapters.map(chapter => ({ ...chapter }));
  const facts = chapters.map(chapter => Array.from(factExtract(chapter.text)));
  const shares: number[] = [];
  let left = budget;
  let open = facts.length;
  for (const at of facts.map((_, i) => i).sort((x, y) => facts[x].length - facts[y].length)) {
    shares[at] = Math.min(facts[at].length, Math.floor(left / open));
    left -= shares[at];
    open--;
  }
  return chapters.map((chapter, at) => ({ title: chapter.title, text: facts[at].slice(0, shares[at]).join("") }));
}

/**
 * One finding as one chapter sees it: the other chapter, what this one says, what the other says, the suggested fix (may be empty).
 * With `reference`: this chapter's sentence `own` names `other` by the wrong words `theirs`; `suggestion` is the right ones.
 */
export interface ChapterInconsistency {
  /** `removed`: this chapter still names a removed chapter (`theirs` is its title, `own` the sentence that names it). */
  kind?: "removed";
  other: string;
  own: string;
  theirs: string;
  suggestion: string;
  reference?: true;
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
    finding.kind === "reference"
      ? finding.a === nodeId
        ? [
            {
              other: finding.b,
              own: finding.claimA,
              theirs: finding.claimB,
              suggestion: finding.suggestion,
              reference: true
            }
          ]
        : []
      : finding.kind === "removed"
        ? finding.a === nodeId
          ? [
              {
                kind: "removed",
                other: finding.b,
                own: finding.claimA,
                theirs: finding.claimB,
                suggestion: finding.suggestion
              }
            ]
          : []
        : finding.a === nodeId
          ? [{ other: finding.b, own: finding.claimA, theirs: finding.claimB, suggestion: finding.suggestion }]
          : finding.b === nodeId
            ? [{ other: finding.a, own: finding.claimB, theirs: finding.claimA, suggestion: finding.suggestion }]
            : []
  );
}

/** The longest sentence a removed-chapter finding quotes (characters). */
const REMOVED_QUOTE_MAX = 80;
/** A quoted sentence ends at its stop mark or at the line's end (the quote is one line in the review box). */
const QUOTE_SPLIT = /(?<=[。！？!?])|\n+/u;
/**
 * The program's own check beside the model's: a chapter text that still names a removed chapter by its title (a literal match). A title
 * shorter than two characters, or one a present chapter also has, is not looked for. One finding per chapter and removed title; the
 * quoted sentence is the first one that names it.
 */
export function removedChapterRefs(
  data: Pick<BookPipelineData, "order" | "removed" | "chapters">,
  chapters: readonly { id: string; title: string; text: string }[]
): ConsistencyFinding[] {
  const present = new Set(
    [
      ...chapters.map(chapter => chapter.title),
      ...effectiveOrder(data).map(id => data.chapters?.[id]?.title ?? "")
    ].map(title => title.trim())
  );
  const out: ConsistencyFinding[] = [];
  for (const id of data.removed ?? []) {
    const title = data.chapters?.[id]?.title?.trim() ?? "";
    if (Array.from(title).length < 2 || present.has(title)) continue;
    for (const chapter of chapters) {
      if (!chapter.text.includes(title)) continue;
      const sentence =
        chapter.text
          .split(QUOTE_SPLIT)
          .find(part => part.includes(title))
          ?.trim() ?? title;
      out.push({
        kind: "removed",
        a: chapter.id,
        b: id,
        claimA: Array.from(sentence).slice(0, REMOVED_QUOTE_MAX).join(""),
        claimB: title,
        suggestion: ""
      });
    }
  }
  return out;
}
