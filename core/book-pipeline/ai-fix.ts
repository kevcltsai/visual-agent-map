/**
 * Applying the author model's in-place fixes to a chapter. Pure. A fix only replaces one quoted sentence by another; every edit is
 * judged on its own and refused (the text stays exactly as it was) when
 *  - the quote is not in the text exactly once, or sits on a reader's note (`hand_edited`: the reader's own words are never touched),
 *  - the new sentence holds program syntax (callout, link, `%%`, `==`, heading, a line break),
 *  - a picture would go or change, or a link would go,
 *  - the chapter would end below the asked minimum length, or shorter than it was while already below it.
 * The same picture and length rules the author's own length fix uses (`chapterLength`, `lengthBody`). The write itself (authorize, the
 * hand-edit fence, the body-integrity record) is the caller's single guarded write; this module only decides the new text.
 */
import type { AiFixTarget, AiOpenReason } from "./ai-proof";
import { findNotes } from "./book-notes";
import { chapterLength, lengthBody, type LengthUnit } from "./settings";
import { forbiddenSyntax } from "./notes-apply";

/** One edit as the step parser read it. */
export interface RawAiEdit {
  id: string;
  /** Whole-book fixes: the 1-based chapter; absent for a single chapter. */
  chapter?: number;
  quote: string;
  replacement: string;
}
export type AiFixRefusal = Extract<
  AiOpenReason,
  "fix_refused_picture" | "fix_refused_length" | "fix_quote_missing" | "fix_forbidden_syntax" | "hand_edited"
>;
export interface AiEditOutcome {
  id: string;
  applied: boolean;
  reason?: AiFixRefusal;
}
export interface AiFixApplied {
  text: string;
  outcomes: AiEditOutcome[];
  /** Edits applied; 0 means `text` is the original, byte for byte (the round is still used up). */
  applied: number;
}
export interface AiFixGuard {
  /** The asked chapter length (see `lengthRange`); absent: no length rule. */
  length?: { unit: LengthUnit; min: number };
  /** The text the model was shown: a quote that is not in it exactly once is refused, so no hidden callout, system section or picture line is ever edited. */
  shown?: string;
}

const PICTURE = /!\[\[[^\]\n]*\]\]|!\[[^\]\n]*\]\([^)\n]*\)/g;
const LINKS = /\[\[[^\]\n]*\]\]|\[[^\]\n]*\]\([^)\n]*\)|https?:\/\/[^\s<>)\]]+/g;
const tokens = (text: string, pattern: RegExp): string => JSON.stringify(text.match(pattern) ?? []);
const withoutPictures = (text: string): string => text.replace(PICTURE, "");

const measure = (text: string, guard: AiFixGuard): number | undefined =>
  guard.length ? chapterLength(lengthBody(text), guard.length.unit) : undefined;

/** The refusal for putting `replacement` over `[at, at + quote.length)` of `text`, or the new text. */
function tryEdit(text: string, edit: RawAiEdit, guard: AiFixGuard): { text: string } | { reason: AiFixRefusal } {
  const quote = edit.quote;
  if (!quote.trim()) return { reason: "fix_quote_missing" };
  if (guard.shown !== undefined) {
    const seen = guard.shown.indexOf(quote);
    if (seen < 0 || guard.shown.indexOf(quote, seen + 1) >= 0) return { reason: "fix_quote_missing" };
  }
  const at = text.indexOf(quote);
  if (at < 0 || text.indexOf(quote, at + 1) >= 0) return { reason: "fix_quote_missing" };
  const end = at + quote.length;
  if (findNotes(text).some(note => at < note.to && end > note.from)) return { reason: "hand_edited" };
  if (!edit.replacement.trim() || /[\r\n]/.test(edit.replacement)) return { reason: "fix_forbidden_syntax" };
  if (forbiddenSyntax(edit.replacement)) return { reason: "fix_forbidden_syntax" };
  const next = text.slice(0, at) + edit.replacement + text.slice(end);
  if (tokens(next, PICTURE) !== tokens(text, PICTURE)) return { reason: "fix_refused_picture" };
  if (tokens(withoutPictures(next), LINKS) !== tokens(withoutPictures(text), LINKS))
    return { reason: "fix_forbidden_syntax" };
  const before = measure(text, guard);
  const after = measure(next, guard);
  if (before !== undefined && after !== undefined && guard.length && after < guard.length.min && after < before)
    return { reason: "fix_refused_length" };
  return { text: next };
}

/**
 * Applies `edits` one after the other to `text` (a chapter as stored, pictures and notes in). An edit for an id that is not in `targets`
 * is ignored, a second edit for one id is ignored; a target the model gave no edit for has no outcome (the next check reports it).
 */
export function applyAiEdits(
  text: string,
  targets: readonly Pick<AiFixTarget, "id">[],
  edits: readonly RawAiEdit[],
  guard: AiFixGuard = {}
): AiFixApplied {
  const wanted = new Set(targets.map(target => target.id));
  const done = new Set<string>();
  const outcomes: AiEditOutcome[] = [];
  let current = text;
  let applied = 0;
  for (const edit of edits) {
    if (!wanted.has(edit.id) || done.has(edit.id)) continue;
    done.add(edit.id);
    const result = tryEdit(current, edit, guard);
    if ("text" in result) {
      current = result.text;
      applied++;
      outcomes.push({ id: edit.id, applied: true });
    } else outcomes.push({ id: edit.id, applied: false, reason: result.reason });
  }
  return { text: current, outcomes, applied };
}

/** The reasons of the edits that were refused, by id: what `unresolvedItems` takes as `refused`. */
export const refusedReasons = (outcomes: readonly AiEditOutcome[]): Record<string, AiFixRefusal> => {
  const out: Record<string, AiFixRefusal> = {};
  for (const outcome of outcomes) if (!outcome.applied && outcome.reason) out[outcome.id] = outcome.reason;
  return out;
};
