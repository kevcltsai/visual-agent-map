import { BOOK_ROLES, BOOK_SETTING_FIELDS, type BookRole, type BookSettings } from "../../book-pipeline/model";
import type { StructureOp } from "../../book-pipeline/structure-edit";
import { singleLine } from "../../book-pipeline/text";
import { estimateTokens } from "../../../ai/context-builder";
import { renderTemplate, type StepDefinition } from "../../step-runner";
import {
  BOOK_STEP_TOKEN_BUDGET,
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
import childrenTemplate from "./global-plan-children.md";

export interface GlobalPlanCard {
  id: string;
  /** Where the card is in the book: `preface`, `chapter 2`, `section 1 of 3 in chapter 2`. */
  place: string;
  title: string;
  summary: string;
  /** True when the owner's hand is in this card (or the root): the editor may not remove, merge, move or rename it. */
  locked?: true;
  /** Titles of the card's child cards on the map, in reading order (titles only). */
  children?: readonly string[];
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
  /** `home`: the id of the card that owns the material (one scene or example belongs to one card); an empty string when unsure. */
  materials: { name: string; use: string; home: string }[];
  /** Only fields the owner left empty. */
  decisions: BookSettings;
  /** Structure changes the editor proposes (shape checked here; whether each one may apply is `simulateStructure`'s call). Default `[]`. */
  structure: StructureOp[];
}

export const MAX_MATERIALS = 40;
/** More proposals than this in a reply are not read (the structure cap itself is enforced by `simulateStructure`). */
const MAX_STRUCTURE_READ = 30;
const STRUCTURE_KINDS = ["add", "remove", "merge", "move", "rename"] as const;
const STRUCTURE_FIELDS = [
  "id",
  "kind",
  "reason",
  "card",
  "into",
  "title",
  "summary",
  "parent",
  "after",
  "ref"
] as const;
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
        properties: {
          name: { type: "string", minLength: 1 },
          use: { type: "string", minLength: 1 },
          home: { type: "string" }
        },
        required: ["name", "use", "home"]
      }
    },
    decisions: {
      type: "object",
      additionalProperties: false,
      properties: Object.fromEntries(BOOK_SETTING_FIELDS.map(field => [field, { type: "string" }])),
      required: [...BOOK_SETTING_FIELDS]
    },
    structure: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", minLength: 1 },
          kind: { type: "string", enum: [...STRUCTURE_KINDS] },
          reason: { type: "string" },
          card: { type: "string" },
          into: { type: "string" },
          title: { type: "string" },
          summary: { type: "string" },
          parent: { type: "string" },
          after: { type: "string" },
          ref: { type: "string" }
        },
        required: ["id", "kind", "reason"]
      }
    }
  },
  required: ["thread", "cards", "materials", "decisions"]
};

const need = (one: Record<string, unknown>, key: string): string | undefined => {
  const value = one[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
};
/** One proposed change, or undefined when it is not the shape of its kind (a bad item is dropped, never fails the reply). */
function structureOpOf(entry: unknown): StructureOp | undefined {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
  const one = entry as Record<string, unknown>;
  if (Object.keys(one).some(key => !(STRUCTURE_FIELDS as readonly string[]).includes(key))) return undefined;
  const id = need(one, "id");
  const reason = typeof one.reason === "string" ? one.reason : undefined;
  if (!id || reason === undefined) return undefined;
  const base = { id, reason };
  const after = need(one, "after");
  if (one.after !== undefined && one.after !== "" && !after) return undefined;
  switch (one.kind) {
    case "add": {
      const [title, summary, parent, ref] = ["title", "summary", "parent", "ref"].map(key => need(one, key));
      return title && summary && parent && ref
        ? { ...base, kind: "add", title, summary, parent, ref, ...(after ? { after } : {}) }
        : undefined;
    }
    case "remove": {
      const card = need(one, "card");
      return card ? { ...base, kind: "remove", card } : undefined;
    }
    case "merge": {
      const [card, into] = [need(one, "card"), need(one, "into")];
      return card && into ? { ...base, kind: "merge", card, into } : undefined;
    }
    case "move": {
      const [card, parent] = [need(one, "card"), need(one, "parent")];
      return card && parent ? { ...base, kind: "move", card, parent, ...(after ? { after } : {}) } : undefined;
    }
    case "rename": {
      const [card, title] = [need(one, "card"), need(one, "title")];
      return card && title ? { ...base, kind: "rename", card, title } : undefined;
    }
    default:
      return undefined;
  }
}
function structureOf(value: unknown): StructureOp[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  const ops: StructureOp[] = [];
  for (const entry of value.slice(0, MAX_STRUCTURE_READ)) {
    const op = structureOpOf(entry);
    if (!op || ids.has(op.id)) continue;
    ids.add(op.id);
    ops.push(op);
  }
  return ops;
}

export function parseGlobalPlan(raw: string, request: GlobalPlanRequest): GlobalPlanResult {
  const item = parseJson(raw);
  exactKeys(Object.fromEntries(Object.entries(item).filter(([key]) => key !== "structure")), [
    "thread",
    "cards",
    "materials",
    "decisions"
  ]);
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
      // `home` is new: an older reply or saved result without it still reads (an empty home).
      exactKeys(one, "home" in one ? ["name", "use", "home"] : ["name", "use"]);
      const home =
        one.home === undefined || one.home === null
          ? ""
          : typeof one.home === "string"
            ? one.home.trim()
            : fail("material home must be a string");
      return {
        name: singleLine(textOf(one.name, "material name"), 120),
        use: singleLine(textOf(one.use, "material use"), 240),
        // A home that is not a card of this book (an invented id) is not kept.
        home: wanted.has(home) ? home : ""
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
  return { thread, cards, materials, decisions, structure: structureOf(item.structure) };
}

const cap = (value: string, max: number): string => singleLine(value, max);
/** A child title in the request is at most this long. */
export const GLOBAL_CHILD_TITLE_MAX = 80;
/** All child titles together are cut to about this many tokens (the existing estimate), in reading order. */
export const GLOBAL_CHILD_TOKENS = 3000;
type CardEntry = {
  id: string;
  place: string;
  title: string;
  summary: string;
  locked?: true;
  children?: string[];
  moreChildren?: number;
};
const entriesOf = (request: GlobalPlanRequest, shown: ReadonlyMap<number, number>): CardEntry[] =>
  request.cards.map((card, at) => {
    const entry: CardEntry = {
      id: card.id,
      place: card.place,
      title: cap(card.title, 200),
      summary: cap(card.summary, 500),
      ...(card.locked ? { locked: true as const } : {})
    };
    const all = (card.children ?? []).map(title => cap(title, GLOBAL_CHILD_TITLE_MAX));
    if (!all.length) return entry;
    const k = shown.get(at) ?? 0;
    if (k) entry.children = all.slice(0, k);
    if (k < all.length) entry.moreChildren = all.length - k;
    return entry;
  });
const render = (request: GlobalPlanRequest, shown: ReadonlyMap<number, number>, rule: boolean): string =>
  renderTemplate(template, {
    languageInstruction: languageInstruction(request.language, request.bookTitle),
    bookTitle: JSON.stringify(cap(request.bookTitle, 200)),
    settings: JSON.stringify(request.settings),
    cards: JSON.stringify(entriesOf(request, shown))
  }) + (rule ? `\n\n${childrenTemplate}` : "");
/** The request as it will be sent: child titles in reading order up to the token cap and the room the step's budget leaves. */
function fitGlobalPlan(request: GlobalPlanRequest): string {
  const none = new Map<number, number>();
  const withChildren = request.cards.some(card => card.children?.length);
  if (!withChildren) return render(request, none, false);
  const room = Math.min(
    GLOBAL_CHILD_TOKENS,
    BOOK_STEP_TOKEN_BUDGET - estimateTokens(render(request, none, true) + JSON.stringify(GLOBAL_PLAN_SCHEMA))
  );
  const shown = new Map<number, number>();
  let spent = 0;
  let full = true;
  request.cards.forEach((card, at) => {
    let k = 0;
    for (const title of card.children ?? []) {
      const cost = estimateTokens(JSON.stringify(cap(title, GLOBAL_CHILD_TITLE_MAX))) + 1;
      if (!full || spent + cost > room) {
        full = false;
        break;
      }
      spent += cost;
      k++;
    }
    shown.set(at, k);
  });
  return render(request, shown, true);
}
/** The whole-book plan: one call over every card's title and summary. Text-only. */
export const globalPlanStep: StepDefinition<GlobalPlanRequest, GlobalPlanResult> = {
  id: "book-pipeline.global-plan",
  version: 2,
  render: request => fitGlobalPlan(request),
  schema: GLOBAL_PLAN_SCHEMA,
  policy: (prompt, request) => {
    if (!request.cards.length) fail("A book plan needs cards");
    overBudget(prompt, GLOBAL_PLAN_SCHEMA);
  },
  parse: parseGlobalPlan
};
