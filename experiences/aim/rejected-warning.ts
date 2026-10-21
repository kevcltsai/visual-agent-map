import { type UiLanguage, translateNote } from "../../i18n";

/** Node, evidence and source IDs (UUIDs, often shortened as `9a7207f4-…-v3`) belong to the app, never to the reader. */
const INTERNAL_ID = /[0-9a-f]{8}-[^\s、，,;；）)\]]*/gi;

function readerText(value: string): string {
  return value
    .replace(INTERNAL_ID, "")
    .replace(/\s*[、，,;；]\s*(?=[、，,;；]|$)/g, "")
    .replace(/(^|\s)[、，,;；]\s*/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function itemLines(items: readonly string[]): string[] {
  return [...new Set(items.map(readerText).filter(Boolean))];
}

/**
 * The warning that opens a document the final review rejected but that is still given as the answer: what the reader
 * must fill in or confirm, in reader words. The reviewer's own reasoning stays in the run records, not in the note.
 */
export function rejectedDeliveryWarning(items: readonly string[], language: UiLanguage): string {
  const lines = itemLines(items);
  if (!lines.length) return "";
  return [
    `> [!warning] ${translateNote(language, "note.aim_rejected_warning_title")}`,
    `> ${translateNote(language, "note.aim_rejected_warning_intro")}`,
    ...lines.map(line => `> - ${line}`)
  ].join("\n");
}

/** The warning that opens an interim result whose research stopped with evidence still missing. */
export function incompleteResearchWarning(items: readonly string[], language: UiLanguage): string {
  const lines = itemLines(items);
  return [
    `> [!warning] ${translateNote(language, "note.aim_incomplete_warning_title")}`,
    `> ${translateNote(language, lines.length ? "note.aim_incomplete_warning_intro" : "note.aim_incomplete_warning_no_items")}`,
    ...lines.map(line => `> - ${line}`)
  ].join("\n");
}

/** The callout that opens an interim result waiting for the user's answer. */
export function awaitingAnswerCallout(question: string, language: UiLanguage): string {
  const text = readerText(question.replace(/\s*\n\s*/g, " "));
  return text ? `> [!question] ${translateNote(language, "note.aim_awaiting_answer_title")}\n> ${text}` : "";
}
