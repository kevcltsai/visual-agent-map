/**
 * The one rule for the whole-book settings a plan or an author prompt uses: the value the owner has in the root topic's
 * frontmatter wins; a field the owner left empty takes the editorial decision saved in the root's `## 全書企劃` section.
 * Planning and writing both call this, never a private merge.
 */
import { BOOK_SETTING_FIELDS, type BookSettings } from "./model";
import { hashText } from "./text";

export function effectiveSettings(current: BookSettings, decided: BookSettings): BookSettings {
  const out: BookSettings = {};
  for (const field of BOOK_SETTING_FIELDS) {
    const value = current[field]?.trim() ? current[field] : decided[field]?.trim() ? decided[field] : undefined;
    if (value) out[field] = value;
  }
  return out;
}

/** A card records this with its plan; it changes exactly when an effective value does. */
export function settingsVersion(settings: BookSettings): string {
  return hashText(JSON.stringify(BOOK_SETTING_FIELDS.map(field => settings[field] ?? "")));
}

/** What every chapter's author is told besides the card's own brief: the role, the opening, the ending, and no log-style ending. */
export const BOOK_AUTHOR_RULES = [
  "Chapter writing rules (follow them):",
  "- Write the chapter as the role named in the brief says.",
  "- Open by picking up the brief's entry point (how this chapter continues from the previous card).",
  "- End with one sentence that leads into the next card, taking up the question the brief leaves for it.",
  '- Do not end the chapter with an update log, a change note or a "this version" remark; those are added by the system.'
].join("\n");

/** The author's extra requirements: the fixed chapter rules, then the effective whole-book settings (when the owner set any). */
export function bookAuthorRequirements(settings: BookSettings): string {
  const lines = BOOK_SETTING_FIELDS.filter(field => settings[field]).map(field => `- ${field}: ${settings[field]}`);
  return lines.length
    ? `${BOOK_AUTHOR_RULES}\n\nWhole-book settings (follow them):\n${lines.join("\n")}`
    : BOOK_AUTHOR_RULES;
}
