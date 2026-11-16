import type { BookRole, BookSettings } from "../../book-pipeline/model";
import type { ChecklistItem, ChecklistType } from "../../book-pipeline/plan-text";
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
import template from "./card-plan.md";

export interface CardNeighbour {
  position: number;
  title: string;
  summary: string;
}
export interface CardPlanRequest extends BookStepBase {
  thread: string;
  /** The effective settings (owner's current values first, then the saved editorial decisions). */
  settings: BookSettings;
  materials: readonly { name: string; use: string }[];
  card: { id: string; position: number; total: number; role: BookRole; title: string; summary: string };
  previous?: CardNeighbour;
  next?: CardNeighbour;
}
export interface CardPlanResult {
  covers: string;
  entry: string;
  handoff: string;
  previous: string;
  next: string;
  /** Ids `C1..Cn` assigned here, in order. */
  checklist: ChecklistItem[];
}

export const MAX_CHECKLIST = 8;
export const CARD_PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    covers: { type: "string", minLength: 1 },
    entry: { type: "string", minLength: 1 },
    handoff: { type: "string", minLength: 1 },
    previous: { type: "string" },
    next: { type: "string" },
    checklist: {
      type: "array",
      minItems: 1,
      maxItems: MAX_CHECKLIST,
      items: {
        type: "object",
        additionalProperties: false,
        properties: { type: { type: "string", enum: ["structure", "fact"] }, text: { type: "string", minLength: 1 } },
        required: ["type", "text"]
      }
    }
  },
  required: ["covers", "entry", "handoff", "previous", "next", "checklist"]
};

const PICTURE =
  /以圖為主|圖文並茂|圖片|圖像|插圖|配圖|附圖|有圖|\b(?:images?|pictures?|illustrations?|photos?|diagrams?)\b/i;
const CONDITION = /無圖|沒有圖|没有图|找不到|若|如果|如有|有找到|\b(?:if|when|unless|no (?:image|picture)|without)\b/i;
/** A picture item that is not conditional: the first author version has no image step, so it could never be met. */
const unconditionalPicture = (text: string): boolean => PICTURE.test(text) && !CONDITION.test(text);

export function parseCardPlan(raw: string, request: CardPlanRequest): CardPlanResult {
  const item = parseJson(raw);
  exactKeys(item, ["covers", "entry", "handoff", "previous", "next", "checklist"]);
  const entries = arrayOf(item.checklist, "checklist");
  if (entries.length < 1 || entries.length > MAX_CHECKLIST) fail(`checklist must have 1 to ${MAX_CHECKLIST} items`);
  const parsed = entries.map((entry): { type: ChecklistType; text: string } => {
    const one = recordOf(entry, "checklist item");
    exactKeys(one, ["type", "text"]);
    if (one.type !== "structure" && one.type !== "fact") return fail("unknown checklist type");
    return { type: one.type, text: singleLine(textOf(one.text, "checklist text")) };
  });
  // Unconditional picture requirements are dropped by program (never rewritten); a plan with nothing left is a failure (retried).
  const kept = parsed.filter(item => !unconditionalPicture(item.text));
  if (!kept.length) fail("checklist has no usable item");
  const checklist = kept.map((item, index): ChecklistItem => ({ id: `C${index + 1}`, ...item }));
  const side = (value: unknown, present: boolean, what: string): string =>
    present ? singleLine(textOf(value, what), 240) : "";
  return {
    covers: singleLine(textOf(item.covers, "covers")),
    entry: singleLine(textOf(item.entry, "entry")),
    handoff: singleLine(textOf(item.handoff, "handoff")),
    previous: side(item.previous, !!request.previous, "previous"),
    next: side(item.next, !!request.next, "next"),
    checklist
  };
}

const cap = (value: string, max: number): string => singleLine(value, max);
const neighbour = (n: CardNeighbour | undefined): string =>
  JSON.stringify(n ? { position: n.position, title: cap(n.title, 200), summary: cap(n.summary, 500) } : null);

/** One card's brief and acceptance checklist. Text-only. */
export const cardPlanStep: StepDefinition<CardPlanRequest, CardPlanResult> = {
  id: "book-pipeline.card-plan",
  version: 1,
  render: request =>
    renderTemplate(template, {
      languageInstruction: languageInstruction(request.language, request.card.title),
      thread: JSON.stringify(cap(request.thread, 1200)),
      settings: JSON.stringify(request.settings),
      card: JSON.stringify({
        position: request.card.position,
        total: request.card.total,
        role: request.card.role,
        title: cap(request.card.title, 200),
        summary: cap(request.card.summary, 500)
      }),
      previous: neighbour(request.previous),
      next: neighbour(request.next),
      materials: JSON.stringify(request.materials.map(m => ({ name: cap(m.name, 120), use: cap(m.use, 240) })))
    }),
  schema: CARD_PLAN_SCHEMA,
  policy: (prompt, request) => {
    if (!request.card.title.trim()) fail("A card plan needs a card title");
    overBudget(prompt, CARD_PLAN_SCHEMA);
  },
  parse: parseCardPlan
};
