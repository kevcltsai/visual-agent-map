/**
 * The reader's notes inside a picture-book chapter: `==annotated text==%%備註#n：note%%`. Only this exact wrapper is the program's own.
 * The proofread works on the chapter as it was written, so a note never changes the proof body: {@link projectProofBody} removes the
 * wrapper and keeps the annotated text. A text without a wrapper projects to itself, byte for byte, so older proof keys stay valid.
 */
import { fencedLines, withoutHiddenCallouts } from "./note-sections";

/** `==text==%%備註#n：note%%`: the annotated text has no `==` or line break, the note has no `%%` or line break. */
const NOTE_WRAPPER = /==((?:(?!==)[^\r\n])+?)==%%備註#\d+：(?:(?!%%)[^\r\n])*%%/g;

/** One note found in a text: `[from, to)` is the whole wrapper, `n` its number, `selected` the annotated text, `note` the note text. */
export interface FoundNote {
  from: number;
  to: number;
  n: number;
  selected: string;
  note: string;
}
const NOTE_PARTS = /==((?:(?!==)[^\r\n])+?)==%%備註#(\d+)：((?:(?!%%)[^\r\n])*)%%/g;
/** Every program note wrapper in `text`, in order (no mask: the caller restricts them to the lines it cares about). */
export function findNotes(text: string): FoundNote[] {
  return [...text.matchAll(NOTE_PARTS)].map(m => ({
    from: m.index ?? 0,
    to: (m.index ?? 0) + m[0].length,
    n: Number(m[2]),
    selected: m[1],
    note: m[3]
  }));
}

/** The proof body of a chapter: the program's note wrappers removed, the annotated text kept. */
export const projectProofBody = (body: string): string => body.replace(NOTE_WRAPPER, "$1");

/** The wrapper of one note, or null when the text or the note could not be told from other syntax (`==`, `%%`, a line break, empty). */
export function wrapNote(text: string, n: number, note: string): string | null {
  const bad = (value: string): boolean => !value.trim() || /[\r\n]/.test(value) || /==|%%/.test(value);
  if (bad(text) || bad(note) || !Number.isInteger(n) || n < 1) return null;
  return `==${text}==%%備註#${n}：${note}%%`;
}

/** How many notes a note's raw text carries in its chapter text: not in code, the hidden work records or the program's own callouts. */
export function countNotes(text: string): number {
  const lines = text.split("\n");
  const fenced = fencedLines(lines);
  const kept = withoutHiddenCallouts(lines.filter((_, i) => !fenced[i]));
  return (kept.join("\n").match(NOTE_WRAPPER) ?? []).length;
}
