import { BOOK_ROLES, BOOK_SETTING_FIELDS, type BookRole, type BookSettings } from "../../book-pipeline/model";
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
import template from "./global-plan.md";

export interface GlobalPlanCard {
  id: string;
  title: string;
  summary: string;
}
export interface GlobalPlanRequest extends BookStepBase {
  bookTitle: string;
  /** The settings the owner has filled in (current values); the model decides only the empty ones. */
  settings: BookSettings;
  cards: readonly GlobalPlanCard[];
}
export interface GlobalPlanResult {
  thread: string;
  /** Every request card once, in reading order. */
  cards: { id: string; role: BookRole }[];
  materials: { name: string; use: string }[];
  /** Only fields the owner left empty. */
  decisions: BookSettings;
}

export const MAX_MATERIALS = 40;
export const GLOBAL_PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    thread: { type: "string", minLength: 1 },
    cards: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        properties: { id: { type: "string", minLength: 1 }, role: { type: "string", enum: [...BOOK_ROLES] } },
        required: ["id", "role"]
      }
    },
    materials: {
      type: "array",
      maxItems: MAX_MATERIALS,
      items: {
        type: "object",
        additionalProperties: false,
        properties: { name: { type: "string", minLength: 1 }, use: { type: "string", minLength: 1 } },
        required: ["name", "use"]
      }
    },
    decisions: {
      type: "object",
      additionalProperties: false,
      properties: Object.fromEntries(BOOK_SETTING_FIELDS.map(field => [field, { type: "string" }])),
      required: [...BOOK_SETTING_FIELDS]
    }
  },
  required: ["thread", "cards", "materials", "decisions"]
};

export function parseGlobalPlan(raw: string, request: GlobalPlanRequest): GlobalPlanResult {
  const item = parseJson(raw);
  exactKeys(item, ["thread", "cards", "materials", "decisions"]);
  const thread = singleLine(textOf(item.thread, "thread"), 1200);
  const wanted = new Set(request.cards.map(card => card.id));
  const seen = new Set<string>();
  const cards = arrayOf(item.cards, "cards").map(entry => {
    const one = recordOf(entry, "card");
    exactKeys(one, ["id", "role"]);
    const id = textOf(one.id, "card id");
    if (!wanted.has(id)) return fail("Reply names an unknown card");
    if (seen.has(id)) return fail("The reply names a card twice");
    seen.add(id);
    if (!(BOOK_ROLES as readonly unknown[]).includes(one.role)) return fail("unknown role");
    return { id, role: one.role as BookRole };
  });
  if (cards.length !== wanted.size) fail("The reply leaves a card out");
  const materials = arrayOf(item.materials, "materials")
    .slice(0, MAX_MATERIALS)
    .map(entry => {
      const one = recordOf(entry, "material");
      exactKeys(one, ["name", "use"]);
      return {
        name: singleLine(textOf(one.name, "material name"), 120),
        use: singleLine(textOf(one.use, "material use"), 240)
      };
    });
  const raws = recordOf(item.decisions, "decisions");
  exactKeys(raws, [...BOOK_SETTING_FIELDS]);
  const decisions: BookSettings = {};
  for (const field of BOOK_SETTING_FIELDS) {
    const value = raws[field];
    if (typeof value !== "string") return fail("decisions must be strings");
    const line = singleLine(value, 300);
    if (line && !request.settings[field]?.trim()) decisions[field] = line;
  }
  return { thread, cards, materials, decisions };
}

const cap = (value: string, max: number): string => singleLine(value, max);
/** The whole-book plan: one call over every card's title and summary. Text-only. */
export const globalPlanStep: StepDefinition<GlobalPlanRequest, GlobalPlanResult> = {
  id: "book-pipeline.global-plan",
  version: 1,
  render: request =>
    renderTemplate(template, {
      languageInstruction: languageInstruction(request.language, request.bookTitle),
      bookTitle: JSON.stringify(cap(request.bookTitle, 200)),
      settings: JSON.stringify(request.settings),
      cards: JSON.stringify(
        request.cards.map(card => ({ id: card.id, title: cap(card.title, 200), summary: cap(card.summary, 500) }))
      )
    }),
  schema: GLOBAL_PLAN_SCHEMA,
  policy: (prompt, request) => {
    if (!request.cards.length) fail("A book plan needs cards");
    overBudget(prompt, GLOBAL_PLAN_SCHEMA);
  },
  parse: parseGlobalPlan
};
