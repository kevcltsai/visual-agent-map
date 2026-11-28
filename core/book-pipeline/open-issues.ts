/**
 * The book's closing "still open" page: what the pipeline could not settle, in one generic list. Pure. An item is
 * `{source, chapterId?, chapterTitle, problem, reason}`; a source (the AI proofreader, the chapter's own status, later a cover picture)
 * is one row of {@link OPEN_ISSUE_SOURCES}, which holds its label and the plain sentence of each of its reason codes, so the page and
 * the screen never name a particular source. The page is a program-owned note in the book's folder: it carries a marker, is rewritten
 * only when it has that marker, and a file of the same name without it is never overwritten (another name is chosen). Everything a model
 * wrote is escaped text (`escapeMarkdownText`) before it reaches the note.
 */
import { instructionLanguageOf, type ContentLanguage } from "../../i18n";
import { escapeMarkdownText } from "./text";

type Words = { zh: string; en: string };
const pick = (words: Words, language: ContentLanguage): string =>
  instructionLanguageOf(language) === "zh" ? words.zh : words.en;

export interface BookOpenIssue {
  /** A key of {@link OPEN_ISSUE_SOURCES}. */
  source: string;
  chapterId?: string;
  chapterTitle: string;
  /** What is wrong, one line (model or program text; escaped when written). */
  problem: string;
  /** A reason code of the source (why it is not solved), neutral; the sentence comes from the registry. */
  reason: string;
}

interface IssueSource {
  label: Words;
  reasons: Record<string, Words>;
  /** The sentence for a reason code the row does not list. */
  fallback: Words;
}
const COVER_SOURCE: IssueSource = {
  label: { zh: "封面圖", en: "Cover picture" },
  reasons: {
    mismatch: {
      zh: "封面圖可能對不上這一章，請看一下",
      en: "The cover picture may not fit this chapter; please check it"
    }
  },
  fallback: { zh: "封面圖還有問題沒解決", en: "The cover picture has an unresolved problem" }
};
export const OPEN_ISSUE_SOURCES: Record<string, IssueSource> = {
  cover: COVER_SOURCE,
  "ai-proof": {
    label: { zh: "AI 校對", en: "AI proofread" },
    reasons: {
      still_present: {
        zh: "AI 修改後再查，問題仍在，修正次數已用完",
        en: "The problem was still there after the AI fixed it and checked again; no fix rounds are left"
      },
      sources_conflict: { zh: "來源之間說法不同，沒辦法靠改字解決", en: "The sources disagree; no edit can settle it" },
      source_unreachable: {
        zh: "來源打不開或沒寫到這件事，查不到依據",
        en: "The source cannot be opened or does not cover it"
      },
      unfixable: { zh: "AI 判斷這處不能靠改字解決", en: "The AI judged that an edit cannot fix it" },
      fix_refused_picture: {
        zh: "修正會動到圖片，所以沒套用",
        en: "The fix would have changed a picture, so it was not applied"
      },
      fix_refused_length: {
        zh: "修正會讓章節變得太短，所以沒套用",
        en: "The fix would have made the chapter too short, so it was not applied"
      },
      fix_quote_missing: {
        zh: "AI 引的句子在原文找不到或不只一處，沒套用",
        en: "The sentence the AI quoted was not found once in the text, so nothing was applied"
      },
      fix_forbidden_syntax: {
        zh: "修正含有不能寫進正文的語法，沒套用",
        en: "The fix held syntax that cannot go into the text, so it was not applied"
      },
      hand_edited: {
        zh: "這處是你手改或加註的內容，程式不動",
        en: "This is text you edited or annotated, so it was left alone"
      },
      not_fixed: { zh: "AI 沒有修到這處", en: "The AI did not fix this one" },
      not_fixed_in_time: {
        zh: "最後一輪才查到這處，來不及修",
        en: "It was first found in the last check, so there was no round left to fix it"
      },
      fix_failed: { zh: "修正這步一直失敗", en: "The fix step kept failing" },
      ai_locked: {
        zh: "這章已鎖定，AI 沒有再查也沒有修改",
        en: "This chapter is locked, so the AI did not check it again or change it"
      },
      proof_locked_skipped: {
        zh: "略過（已鎖定），AI 校對沒有查這章",
        en: "Skipped (locked); the AI proofread did not check this chapter"
      },
      proof_incomplete: {
        zh: "AI 校對沒有跑完，這章沒有完整查過",
        en: "The AI proofread did not finish, so this chapter was not fully checked"
      }
    },
    fallback: { zh: "AI 沒能解決這處", en: "The AI could not settle this" }
  },
  chapter: {
    label: { zh: "章節狀態", en: "Chapter status" },
    reasons: {
      too_short: { zh: "字數低於設定的下限", en: "The chapter is below the asked length" },
      too_long: { zh: "字數高於設定的上限", en: "The chapter is above the asked length" },
      few_images: { zh: "圖片少於設定的張數", en: "The chapter has fewer pictures than asked" },
      step_failed: { zh: "有一個步驟失敗了", en: "A step failed" },
      no_text: { zh: "這章沒有正文", en: "The chapter has no text" },
      hand_edited: {
        zh: "這章是你手改過的，程式不動",
        en: "You edited this chapter by hand, so it was left alone"
      },
      fix_interrupted: { zh: "修正做到一半被中斷", en: "A fix was interrupted halfway" },
      image_mismatch: {
        zh: "圖片可能對不上這一節，請看一下",
        en: "A picture may not fit this section; please check it"
      },
      proof_unmet: { zh: "寫完後的校對有幾處沒過", en: "Some checks after writing did not pass" },
      structure_unmet: { zh: "章節結構還沒符合企劃", en: "The chapter structure does not match the plan yet" }
    },
    fallback: { zh: "這章還有狀態沒解決", en: "The chapter still has an unresolved state" }
  }
};
const GENERIC_SOURCE: IssueSource = {
  label: { zh: "其他", en: "Other" },
  reasons: {},
  fallback: { zh: "還沒解決", en: "Not solved" }
};
const sourceOf = (key: string): IssueSource => OPEN_ISSUE_SOURCES[key] ?? GENERIC_SOURCE;

/** The plain sentence of an item's reason, in `language`. */
export const reasonText = (issue: Pick<BookOpenIssue, "source" | "reason">, language: ContentLanguage): string => {
  const row = sourceOf(issue.source);
  return pick(row.reasons[issue.reason] ?? row.fallback, language);
};
export const sourceLabel = (source: string, language: ContentLanguage): string =>
  pick(sourceOf(source).label, language);

/** The one marker line that makes a note this page. */
export const OPEN_ISSUES_MARKER = "<!-- vam-book-open-issues:v1 -->";
export const isOpenIssuesNote = (content: string): boolean => {
  const first = content
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .find(line => line.trim());
  return first?.trim() === OPEN_ISSUES_MARKER;
};

export interface OpenIssuesInput {
  bookTitle: string;
  language: ContentLanguage;
  /** Verified AI checks (quote found in the text): the N of "checked N items, all solved". */
  checked: number;
  issues: readonly BookOpenIssue[];
}
const TITLE: Words = { zh: "仍有問題", en: "Still open" };
const ALL_SOLVED = (n: number): Words => ({
  zh: `AI 校對查了 ${n} 項，全部解決。`,
  en: `The AI proofread checked ${n} items; all solved.`
});
const SOME_OPEN = (n: number, open: number): Words => ({
  zh: `AI 校對查了 ${n} 項，仍有 ${open} 項沒解決。`,
  en: `The AI proofread checked ${n} items; ${open} still open.`
});
const OTHER_OPEN = (k: number): Words => ({
  zh: `另有 ${k} 項章節狀態問題。`,
  en: `${k} more chapter status issues.`
});
const COVER_OPEN = (k: number): Words => ({
  zh: `另有 ${k} 張封面圖可能對不上。`,
  en: `${k} cover pictures may not fit.`
});
const SKIPPED_LOCKED = (k: number): Words => ({
  zh: `另有 ${k} 章略過（已鎖定）。`,
  en: `${k} more chapters skipped (locked).`
});
const NONE_CHECKED: Words = { zh: "沒有可列的項目。", en: "Nothing to list." };

/** The file name the page is meant to have (no folder). */
export const openIssuesFileName = (language: ContentLanguage, copy = 1): string =>
  `${pick(TITLE, language)}${copy > 1 ? ` (${copy})` : ""}.md`;

/**
 * Where the page goes: the usual name when no such file exists or the file there is this page (marker); a file of the same name without
 * the marker is somebody's note, never overwritten, so the next free name is used. `read` gives a file's text or undefined when none.
 * Undefined when twenty names are all taken by other notes (the caller reports a failed write).
 */
export function chooseOpenIssuesFile(
  language: ContentLanguage,
  read: (name: string) => string | undefined
): string | undefined {
  for (let copy = 1; copy <= 20; copy++) {
    const name = openIssuesFileName(language, copy);
    const existing = read(name);
    if (existing === undefined || isOpenIssuesNote(existing)) return name;
  }
  return undefined;
}

/** `escapeMarkdownText` plus no `==` (a highlight) and no `://` (a bare address Obsidian would link): both become full-width. */
const line = (text: string, max: number): string =>
  escapeMarkdownText(text, max)
    .replace(/={2,}/g, run => "＝".repeat(run.length))
    .replace(/:\/\//g, ":／／");

/**
 * The page text: marker, title, one summary line, then one bullet per open item (chapter, problem, why not solved). "All solved" only
 * when nothing is open; an unfinished proofread is an open item itself (`proof_incomplete`), so it can never read as solved.
 */
export function composeOpenIssuesNote(input: OpenIssuesInput): string {
  const { language, issues } = input;
  const n = Math.max(0, Math.trunc(input.checked));
  const colon = instructionLanguageOf(language) === "zh" ? "：" : ": ";
  // A chapter skipped as locked is not an unsolved AI item: it has its own sentence.
  const skipped = issues.filter(issue => issue.source === "ai-proof" && issue.reason === "proof_locked_skipped").length;
  const aiOpen = issues.filter(issue => issue.source === "ai-proof").length - skipped;
  const coverOpen = issues.filter(issue => issue.source === "cover").length;
  const otherOpen = issues.length - aiOpen - skipped - coverOpen;
  const aiSummary = aiOpen
    ? pick(SOME_OPEN(n, aiOpen), language)
    : n > 0
      ? pick(ALL_SOLVED(n), language)
      : otherOpen || coverOpen || skipped
        ? ""
        : pick(NONE_CHECKED, language);
  const summary = [
    aiSummary,
    otherOpen ? pick(OTHER_OPEN(otherOpen), language) : "",
    coverOpen ? pick(COVER_OPEN(coverOpen), language) : "",
    skipped ? pick(SKIPPED_LOCKED(skipped), language) : ""
  ]
    .filter(Boolean)
    .join(" ");
  const out = [
    OPEN_ISSUES_MARKER,
    "",
    `# ${line(input.bookTitle, 120)}${instructionLanguageOf(language) === "zh" ? "\u3000" : " - "}${pick(TITLE, language)}`,
    "",
    summary
  ];
  if (issues.length) out.push("");
  for (const issue of issues) {
    const where = issue.chapterTitle ? `${line(issue.chapterTitle, 120)}${colon}` : "";
    const problem = issue.problem ? `${line(issue.problem, 300)}${colon}` : "";
    out.push(`- ${where}${problem}${line(reasonText(issue, language), 200)}`);
  }
  return `${out.join("\n")}\n`;
}
