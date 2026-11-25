import { BOOK_SETTING_FIELDS, type BookSettings } from "../../book-pipeline/model";
import { singleLine } from "../../book-pipeline/text";
import type { AdmissionContext } from "../../admission";
import type { AiCalls } from "../../ai-calls";
import { renderTemplate, type StepDefinition } from "../../step-runner";
import { exactKeys, fail, languageInstruction, overBudget, parseJson, type BookStepBase } from "./base";
import { plainSuggestion } from "./suggest-settings";
import { runPlanStep } from "./run";
import template from "./edit-settings.md";

/** One earlier exchange of the start card's talk with the chief editor. */
export interface EditSettingsTurn {
  owner: string;
  editor: string;
}
/** What the start card sends: the owner's message, the six settings as the card shows them, and the earlier turns. Nothing else. */
export interface EditSettingsRequest extends BookStepBase {
  message: string;
  settings: BookSettings;
  turns: readonly EditSettingsTurn[];
}
export interface EditSettingsResult {
  /** One line, at most {@link EDIT_REPLY_CHARS} characters. */
  reply: string;
  /** Only the settings that really change: an unchanged or empty one is absent. */
  changes: BookSettings;
}

export const EDIT_MESSAGE_CHARS = 500;
export const EDIT_MAX_TURNS = 6;
export const EDIT_VALUE_CHARS = 200;
export const EDIT_REPLY_CHARS = 300;

export const EDIT_SETTINGS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    reply: { type: "string" },
    changes: {
      type: "object",
      additionalProperties: false,
      properties: Object.fromEntries(BOOK_SETTING_FIELDS.map(field => [field, { type: "string" }])),
      required: [...BOOK_SETTING_FIELDS]
    }
  },
  required: ["reply", "changes"]
};

/** The reply as one plain line (at most 300 characters) and the changes that differ from the current values; any other shape is refused. */
export function parseEditSettings(raw: string, request?: { settings: BookSettings }): EditSettingsResult {
  const item = parseJson(raw);
  exactKeys(item, ["reply", "changes"]);
  if (typeof item.reply !== "string") return fail("reply must be a string");
  const reply = singleLine(item.reply, EDIT_REPLY_CHARS);
  if (!reply) return fail("reply must not be empty");
  const raws = item.changes;
  if (!raws || typeof raws !== "object" || Array.isArray(raws)) return fail("changes must be an object");
  const record = raws as Record<string, unknown>;
  exactKeys(record, [...BOOK_SETTING_FIELDS]);
  const changes: BookSettings = {};
  for (const field of BOOK_SETTING_FIELDS) {
    const value = record[field];
    if (typeof value !== "string") return fail("changes must be strings");
    const line = plainSuggestion(value);
    if (line && line !== singleLine(request?.settings[field] ?? "", EDIT_VALUE_CHARS)) changes[field] = line;
  }
  return { reply, changes };
}

const cap = (value: string, max: number): string => singleLine(value, max);
/** The start card's talk with the chief editor: one text-only call per owner message. */
export const editSettingsStep: StepDefinition<EditSettingsRequest, EditSettingsResult> = {
  id: "book-pipeline.edit-settings",
  version: 1,
  render: request =>
    renderTemplate(template, {
      languageInstruction: languageInstruction(request.language, ""),
      message: JSON.stringify(cap(request.message, EDIT_MESSAGE_CHARS)),
      settings: JSON.stringify(
        Object.fromEntries(
          BOOK_SETTING_FIELDS.map(field => [field, cap(request.settings[field] ?? "", EDIT_VALUE_CHARS)])
        )
      ),
      turns: JSON.stringify(
        request.turns.slice(-EDIT_MAX_TURNS).map(turn => ({
          owner: cap(turn.owner, EDIT_MESSAGE_CHARS),
          editor: cap(turn.editor, EDIT_REPLY_CHARS)
        }))
      )
    }),
  schema: EDIT_SETTINGS_SCHEMA,
  policy: prompt => overBudget(prompt, EDIT_SETTINGS_SCHEMA),
  parse: (raw, request) => parseEditSettings(raw, request)
};

export function runEditSettings(
  aiCalls: AiCalls,
  request: EditSettingsRequest,
  run: { signal: AbortSignal; admission?: AdmissionContext }
): Promise<EditSettingsResult> {
  return runPlanStep(aiCalls, editSettingsStep, request, run);
}
