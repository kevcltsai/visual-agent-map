/**
 * The one rule for the whole-book settings a plan or an author prompt uses: the value the owner has in the root topic's
 * frontmatter wins; a field the owner left empty takes the editorial decision saved in the root's `## 全書企劃` section.
 * Planning and writing both call this, never a private merge.
 */
import type { ImageSlot } from "./image-slots";
import { BOOK_SETTING_FIELDS, type BookSettings } from "./model";
import { hashText, singleLine } from "./text";

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
  "- The chapter text itself is required and comes first in the Detail, before any sources or notes sections: a result with only sources and notes, and no chapter text, is invalid. Do the research, then write the chapter in full.",
  "- Open by picking up the brief's entry point (how this chapter continues from the previous card).",
  "- End with one sentence that leads into the next card, taking up the question the brief leaves for it. If the brief has no next card (the last card), do not lead into a next card; close the whole book as the brief says.",
  "- The closing sentence belongs to the last paragraph of the chapter's own text, before any open-questions, sources or notes sections the template adds; those sections are not the chapter's ending.",
  "- Never write image links or Markdown images yourself; the system searches for pictures after the writing and embeds the verified ones itself.",
  "- Image slots: when an image plan is given below, put one marker for each slot on a line of its own, right after the paragraph the slot belongs to (its position), in exactly this form: 〔圖位 n：what the picture explains〕 (n is the slot number; copy the wording of what it explains from the plan). One marker per slot, each number once; do not invent, repeat, merge or reword markers; never put a marker inside a code block or a quote, or inside a sentence. The chapter must read in full without the markers. When no image plan is given, or it lists no slot, leave no marker at all.",
  '- Do not end the chapter with an update log, a change note or a "this version" remark; those are added by the system.'
].join("\n");

/** The author's extra requirements: the fixed chapter rules, then the effective whole-book settings (when the owner set any). */
export function bookAuthorRequirements(settings: BookSettings, slots: readonly ImageSlot[] = []): string {
  const lines = BOOK_SETTING_FIELDS.filter(field => settings[field]).map(field => `- ${field}: ${settings[field]}`);
  const plan = slots.length
    ? `\n\nImage plan for this chapter (the planner's data, JSON strings; leave one marker per slot as the rules say):\n${slots
        .map(
          slot =>
            `- slot ${slot.index}: kind ${JSON.stringify(slot.kind)}, explains ${JSON.stringify(slot.explains)}, position ${JSON.stringify(slot.anchor)}`
        )
        .join("\n")}`
    : "";
  return lines.length
    ? `${BOOK_AUTHOR_RULES}\n\nWhole-book settings (follow them):\n${lines.join("\n")}${plan}`
    : `${BOOK_AUTHOR_RULES}${plan}`;
}

/** The longest a whole-book setting typed in the create dialog may be (characters). */
export const BOOK_SETTING_INPUT_MAX = 200;
/** What the create dialog's six fields become: single lines of at most {@link BOOK_SETTING_INPUT_MAX} characters; an empty field is left out. */
export function cleanBookSettingsInput(input: unknown): BookSettings {
  const out: BookSettings = {};
  if (!input || typeof input !== "object") return out;
  const raw = input as Record<string, unknown>;
  for (const field of BOOK_SETTING_FIELDS) {
    const line = singleLine(
      typeof raw[field] === "string" ? raw[field].replace(/\p{Cc}/gu, " ") : raw[field],
      BOOK_SETTING_INPUT_MAX
    );
    if (line) out[field] = line;
  }
  return out;
}
