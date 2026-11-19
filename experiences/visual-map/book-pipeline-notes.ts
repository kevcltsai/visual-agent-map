/**
 * The reader's notes in a picture-book chapter, the pure half: where a note may be added, what the note text may hold, the text that
 * results, and the number of the next note. The wrapper itself (`==selected==%%備註#n：text%%`) is `wrapNote` of core/book-pipeline/book-notes.
 */
import { wrapNote } from "../../core/book-pipeline/book-notes";
import { chapterTextMask } from "../../core/book-pipeline/note-sections";

/** Why a selection cannot take a note: nothing selected, more than one line, `==` or `%%` in or around it, not chapter text, the text moved. */
export type NoteRefusal = "empty" | "multiline" | "marks" | "outside" | "changed";
export type SelectionCheck = { ok: true; text: string } | { ok: false; reason: NoteRefusal };

/** Highlights and comments already on a line: a selection may not touch them (a note inside a note, or half of a highlight). */
const MARKED = /==(?:(?!==)[^\r\n])+?==|%%[^\r\n]*?%%/g;

/** Whether `raw[from, to)` may take a note: one line of the visible chapter text, clear of `==`, `%%` and earlier notes. */
export function checkSelection(raw: string, from: number, to: number): SelectionCheck {
  const text = raw.slice(from, to);
  if (from < 0 || to > raw.length || !text.trim()) return { ok: false, reason: "empty" };
  if (/[\r\n]/.test(text)) return { ok: false, reason: "multiline" };
  if (/==|%%/.test(text)) return { ok: false, reason: "marks" };
  const lines = raw.split("\n");
  const lineAt = raw.slice(0, from).split("\n").length - 1;
  if (!chapterTextMask(lines)[lineAt]) return { ok: false, reason: "outside" };
  const lineStart = raw.lastIndexOf("\n", from - 1) + 1;
  for (const found of lines[lineAt].matchAll(MARKED)) {
    const a = lineStart + (found.index ?? 0);
    if (from < a + found[0].length && to > a) return { ok: false, reason: "marks" };
  }
  return { ok: true, text };
}

export type NoteTextProblem = "empty" | "marks";

/** The note text as it will be written (trimmed), or why it cannot be: empty, or a line break, `==` or `%%` in it. */
export function checkNoteText(note: string): { ok: true; note: string } | { ok: false; problem: NoteTextProblem } {
  const text = note.trim();
  if (!text) return { ok: false, problem: "empty" };
  return /[\r\n]|==|%%/.test(text) ? { ok: false, problem: "marks" } : { ok: true, note: text };
}

/** The number of the next note: one more than the highest in the text, so a deleted note's number is not used again. */
export function nextNoteNumber(raw: string): number {
  let top = 0;
  for (const found of raw.matchAll(/%%備註#(\d+)：/g)) top = Math.max(top, Number(found[1]));
  return top + 1;
}

/**
 * `raw` with the note added around `raw[from, to)`, which must still be `expected` (the text may have moved since the selection was made;
 * then nothing is written). The text is returned unchanged with a reason when the selection or the note cannot be used.
 */
export function addNote(
  raw: string,
  from: number,
  to: number,
  expected: string,
  note: string
): { ok: true; text: string } | { ok: false; reason: NoteRefusal | "note" } {
  if (raw.slice(from, to) !== expected) return { ok: false, reason: "changed" };
  const check = checkSelection(raw, from, to);
  if (!check.ok) return check;
  const noteCheck = checkNoteText(note);
  if (!noteCheck.ok) return { ok: false, reason: "note" };
  const wrapped = wrapNote(check.text, nextNoteNumber(raw), noteCheck.note);
  return wrapped ? { ok: true, text: raw.slice(0, from) + wrapped + raw.slice(to) } : { ok: false, reason: "note" };
}
