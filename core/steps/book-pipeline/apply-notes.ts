import type { BookSettings } from "../../book-pipeline/model";
import { checkRewrite, type EncodedItem } from "../../book-pipeline/notes-apply";
import { singleLine } from "../../book-pipeline/text";
import { renderTemplate, type StepDefinition } from "../../step-runner";
import {
  arrayOf,
  exactKeys,
  fail,
  languageInstruction,
  overBudget,
  parseJson,
  recordOf,
  textOf,
  type BookStepBase
} from "./base";
import template from "./apply-notes.md";

export interface ApplyNotesRequest extends BookStepBase {
  /** The effective settings (owner's current values first, then the saved editorial decisions). */
  settings: BookSettings;
  /** The chapter's plan text. */
  plan: string;
  /** Only the annotated paragraphs; `links` stay on the program's side and are never rendered. */
  items: readonly EncodedItem[];
}
export interface ApplyNotesResult {
  /** One per sent id; the links are already restored. */
  paragraphs: { id: string; text: string }[];
}

export const MAX_NOTE_PARAGRAPHS = 60;
export const APPLY_NOTES_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    paragraphs: {
      type: "array",
      minItems: 1,
      maxItems: MAX_NOTE_PARAGRAPHS,
      items: {
        type: "object",
        additionalProperties: false,
        properties: { id: { type: "string", minLength: 1 }, text: { type: "string", minLength: 1 } },
        required: ["id", "text"]
      }
    }
  },
  required: ["paragraphs"]
};

export function parseApplyNotes(raw: string, request: ApplyNotesRequest): ApplyNotesResult {
  const root = parseJson(raw);
  exactKeys(root, ["paragraphs"]);
  const entries = arrayOf(root.paragraphs, "paragraphs");
  if (entries.length !== request.items.length) fail("paragraph count mismatch");
  const seen = new Set<string>();
  const paragraphs = entries.map(entry => {
    const one = recordOf(entry, "paragraph");
    exactKeys(one, ["id", "text"]);
    const id = textOf(one.id, "paragraph id");
    const item = request.items.find(i => i.id === id);
    if (!item) return fail("unknown paragraph id");
    if (seen.has(id)) fail("repeated paragraph id");
    seen.add(id);
    const check = checkRewrite(item, textOf(one.text, "paragraph text"));
    if (!check.ok) return fail(`Paragraph rewrite refused: ${check.reason}`);
    return { id, text: check.text };
  });
  return { paragraphs };
}

/** The rewrite of the paragraphs that carry the reader's notes. Text-only; the program, not the model, finds the paragraphs and writes. */
export const applyNotesStep: StepDefinition<ApplyNotesRequest, ApplyNotesResult> = {
  id: "book-pipeline.apply-notes",
  version: 1,
  render: request =>
    renderTemplate(template, {
      languageInstruction: languageInstruction(request.language, request.items[0]?.text ?? ""),
      settings: JSON.stringify(request.settings),
      plan: JSON.stringify(singleLine(request.plan, 3000)),
      paragraphs: JSON.stringify(request.items.map(i => ({ id: i.id, text: i.text, notes: i.notes })))
    }),
  schema: APPLY_NOTES_SCHEMA,
  policy: (prompt, request) => {
    if (!request.items.length) fail("no paragraph to rewrite");
    if (request.items.length > MAX_NOTE_PARAGRAPHS) fail("too many paragraphs");
    overBudget(prompt, APPLY_NOTES_SCHEMA);
  },
  parse: parseApplyNotes
};
