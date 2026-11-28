/**
 * The book's closing "still open" page: what the pipeline could not settle, in one generic list. Pure. An item is
 * `{source, chapterId?, chapterTitle, problem, reason}`; a source (the AI proofreader, the chapter's own status, later a cover picture)
 * is one row of {@link OPEN_ISSUE_SOURCES}, which holds the dictionary keys of its label and of each reason code's plain sentence, so the page and
 * the screen never name a particular source. The page is a program-owned note in the book's folder: it carries a marker, is rewritten
 * only when it has that marker, and a file of the same name without it is never overwritten (another name is chosen). Everything a model
 * wrote is escaped text (`escapeMarkdownText`) before it reaches the note.
 */
import { instructionLanguageOf, translate, translateNote, type ContentLanguage, type TranslationKey } from "../../i18n";
import { escapeMarkdownText } from "./text";

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
  label: TranslationKey;
  reasons: Record<string, TranslationKey>;
  /** The sentence for a reason code the row does not list. */
  fallback: TranslationKey;
}
const AI_REASONS = [
  "still_present",
  "sources_conflict",
  "source_unreachable",
  "unfixable",
  "fix_refused_picture",
  "fix_refused_length",
  "fix_quote_missing",
  "fix_forbidden_syntax",
  "hand_edited",
  "not_fixed",
  "not_fixed_in_time",
  "fix_failed",
  "ai_locked",
  "proof_locked_skipped",
  "proof_incomplete"
] as const;
const CHAPTER_REASONS = [
  "too_short",
  "too_long",
  "few_images",
  "step_failed",
  "no_text",
  "hand_edited",
  "fix_interrupted",
  "image_mismatch",
  "proof_unmet",
  "structure_unmet"
] as const;
const keysOf = <C extends string>(
  codes: readonly C[],
  key: (code: C) => TranslationKey
): Record<string, TranslationKey> => Object.fromEntries(codes.map(code => [code, key(code)]));
/** The sentences live in the dictionaries (`ui.book_open_*`), so each page language, zh-CN included, reads its own script. */
export const OPEN_ISSUE_SOURCES: Record<string, IssueSource> = {
  cover: {
    label: "ui.book_open_src_cover",
    reasons: { mismatch: "ui.book_open_cover_mismatch" },
    fallback: "ui.book_open_cover_other"
  },
  "ai-proof": {
    label: "ui.book_open_src_ai_proof",
    reasons: keysOf(AI_REASONS, code => `ui.book_open_ai_${code}`),
    fallback: "ui.book_open_ai_other"
  },
  chapter: {
    label: "ui.book_open_src_chapter",
    reasons: keysOf(CHAPTER_REASONS, code => `ui.book_open_ch_${code}`),
    fallback: "ui.book_open_ch_other"
  }
};
const GENERIC_SOURCE: IssueSource = { label: "ui.book_open_src_other", reasons: {}, fallback: "ui.book_open_other" };
const sourceOf = (key: string): IssueSource => OPEN_ISSUE_SOURCES[key] ?? GENERIC_SOURCE;

/** The plain sentence of an item's reason, in `language`. */
export const reasonText = (issue: Pick<BookOpenIssue, "source" | "reason">, language: ContentLanguage): string => {
  const row = sourceOf(issue.source);
  return translate(language, row.reasons[issue.reason] ?? row.fallback);
};
export const sourceLabel = (source: string, language: ContentLanguage): string =>
  translate(language, sourceOf(source).label);

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
/** An en count sentence in its singular form for 1 (`…_one`, no number to fill in) and plural otherwise (`…_0`). */
const counted = (language: ContentLanguage, k: number, one: TranslationKey, many: TranslationKey): string =>
  k === 1 ? translate(language, one) : translate(language, many, k);

/** Which pictures of a chapter may not fit (1-based), as the item's problem line in the page language ("第 1、3 张图" for zh-CN). */
export const openIssuePictures = (language: ContentLanguage, off: readonly number[]): string =>
  translate(
    language,
    off.length > 1 ? "ui.book_open_pictures_0" : "ui.book_open_picture_0",
    off.join(instructionLanguageOf(language) === "zh" ? "、" : ", ")
  );

/**
 * The file name the page is meant to have (no folder). A name the program finds the page by, so it is spelled in the note language
 * (zh-CN keeps the Traditional name, the one older pages have and the bar looks up), while the text inside follows the page language.
 */
export const openIssuesFileName = (language: ContentLanguage, copy = 1): string =>
  `${translateNote(language, "ui.book_open_title")}${copy > 1 ? ` (${copy})` : ""}.md`;

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
    ? n === 1
      ? translate(language, "ui.book_open_some_open_one_0", aiOpen)
      : translate(language, "ui.book_open_some_open_0_1", n, aiOpen)
    : n > 0
      ? counted(language, n, "ui.book_open_all_solved_one", "ui.book_open_all_solved_0")
      : otherOpen || coverOpen || skipped
        ? ""
        : translate(language, "ui.book_open_nothing");
  const summary = [
    aiSummary,
    otherOpen ? counted(language, otherOpen, "ui.book_open_chapter_status_one", "ui.book_open_chapter_status_0") : "",
    coverOpen ? counted(language, coverOpen, "ui.book_open_cover_one", "ui.book_open_cover_0") : "",
    skipped ? counted(language, skipped, "ui.book_open_skipped_one", "ui.book_open_skipped_0") : ""
  ]
    .filter(Boolean)
    .join(" ");
  const out = [
    OPEN_ISSUES_MARKER,
    "",
    `# ${line(input.bookTitle, 120)}${instructionLanguageOf(language) === "zh" ? "\u3000" : " - "}${translate(language, "ui.book_open_title")}`,
    "",
    summary
  ];
  if (issues.length) out.push("");
  for (const issue of issues) {
    const where = issue.chapterTitle ? `${line(issue.chapterTitle, 120)}${colon}` : "";
    const problem = issue.problem ? `${line(issue.problem, 300)}${colon}` : "";
    // The reason is the program's own sentence (the dictionary), not model text: written as is, never escaped (B33-v).
    out.push(`- ${where}${problem}${reasonText(issue, language)}`);
  }
  return `${out.join("\n")}\n`;
}
