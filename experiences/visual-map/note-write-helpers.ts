/** Small pure helpers shared by the view and the topic run module when an AI answer is written to a note. */
import { createHash } from "node:crypto";
import { countIssueText, type CountIssue } from "../../ai/detail-templates";
import { noteLanguageOf, translateNote, type ContentLanguage } from "../../i18n";
import { isPlaceholder, type NotePatch } from "../../repository";

/** A note's stored "no conclusion yet" placeholder is written in the note's own language; in an AI prompt it is shown in the task's output language. */
export function summaryForPrompt(summary: string, language: ContentLanguage): string {
  return isPlaceholder(summary) ? translateNote(noteLanguageOf(language), "note.no_conclusion_yet") : summary;
}
/**
 * Unmet section counts to store on the topic; undefined (no count check ran) clears an earlier mark. The text is written
 * into the note's frontmatter, so it is in the note language, never a display-only interface language.
 */
export function formatIssuesPatch(
  issues: CountIssue[] | undefined,
  language: ContentLanguage
): Pick<NotePatch, "detailFormatIssues"> {
  return { detailFormatIssues: (issues ?? []).map(issue => countIssueText(issue, noteLanguageOf(language))) };
}
export const originBaseline = (origin?: string): string =>
  createHash("sha256")
    .update(origin ?? "")
    .digest("hex");
