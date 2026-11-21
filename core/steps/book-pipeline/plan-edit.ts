import type { BookRole, BookSettings } from "../../book-pipeline/model";
import type { ChecklistType } from "../../book-pipeline/plan-text";
import { singleLine } from "../../book-pipeline/text";
import { estimateTokens } from "../../../ai/context-builder";
import { renderTemplate, type StepDefinition } from "../../step-runner";
import {
  BOOK_STEP_TOKEN_BUDGET,
  arrayOf,
  fail,
  languageInstruction,
  overBudget,
  parseJson,
  type BookStepBase,
  type Rec
} from "./base";
import { MAX_CHECKLIST, MAX_POINTS, MIN_POINTS, POINT_MAX, SUBJECTIVE, unconditionalPicture } from "./card-plan";
import template from "./plan-edit.md";

/** One card as the chief editor reads it: its place and the brief fields as stored in its Prompt (empty when the Prompt has none). */
export interface PlanEditCard {
  id: string;
  /** {@link placeText} of the card. */
  place: string;
  role: BookRole;
  title: string;
  covers: string;
  points: readonly string[];
  entry: string;
  handoff: string;
  previous: string;
  next: string;
  checklist: readonly string[];
}
export interface PlanEditRequest extends BookStepBase {
  bookTitle: string;
  thread: string;
  settings: BookSettings;
  /** Every card of the book, in reading order. */
  cards: readonly PlanEditCard[];
}
/** The fields of one card the editor changed; an absent field is kept. */
export interface PlanEditChange {
  id: string;
  covers?: string;
  points?: string[];
  entry?: string;
  handoff?: string;
  previous?: string;
  checklist?: { type: ChecklistType; text: string }[];
}

/** Longest each field is shown (and accepted back); a field over its cap is cut. */
export const PLAN_EDIT_TEXT_CHARS = 400;
export const PLAN_EDIT_CHECK_CHARS = 200;
const FIELDS = ["id", "covers", "points", "entry", "handoff", "previous", "checklist"] as const;

export const PLAN_EDIT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    changes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", minLength: 1 },
          covers: { type: "string" },
          points: { type: "array", items: { type: "string", minLength: 1 } },
          entry: { type: "string" },
          handoff: { type: "string" },
          previous: { type: "string" },
          checklist: {
            type: "array",
            maxItems: MAX_CHECKLIST,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                type: { type: "string", enum: ["structure", "fact"] },
                text: { type: "string", minLength: 1 }
              },
              required: ["type", "text"]
            }
          }
        },
        required: ["id"]
      }
    }
  },
  required: ["changes"]
};

const cap = (value: string, max: number): string => singleLine(value, max);
const shown = (card: PlanEditCard): Rec => ({
  id: card.id,
  place: card.place,
  role: card.role,
  title: cap(card.title, 200),
  covers: cap(card.covers, PLAN_EDIT_TEXT_CHARS),
  points: card.points.slice(0, MAX_POINTS).map(point => cap(point, POINT_MAX)),
  entry: cap(card.entry, PLAN_EDIT_TEXT_CHARS),
  handoff: cap(card.handoff, PLAN_EDIT_TEXT_CHARS),
  previous: cap(card.previous, PLAN_EDIT_TEXT_CHARS),
  next: cap(card.next, PLAN_EDIT_TEXT_CHARS),
  checklist: card.checklist.slice(0, MAX_CHECKLIST).map(item => cap(item, PLAN_EDIT_CHECK_CHARS))
});
const render = (request: PlanEditRequest): string =>
  renderTemplate(template, {
    pointsMin: String(MIN_POINTS),
    pointsMax: String(MAX_POINTS),
    pointMax: String(POINT_MAX),
    languageInstruction: languageInstruction(request.language, request.cards[0]?.title ?? request.bookTitle),
    title: JSON.stringify(cap(request.bookTitle, 200)),
    thread: JSON.stringify(cap(request.thread, 1200)),
    settings: JSON.stringify(request.settings),
    cards: JSON.stringify(request.cards.map(shown))
  });
/** Whether the whole book's briefs fit one request (the runner asks before the call; a book that does not fit gets no pass and no call). */
export const planEditFits = (request: PlanEditRequest): boolean =>
  estimateTokens(render(request) + JSON.stringify(PLAN_EDIT_SCHEMA)) <= BOOK_STEP_TOKEN_BUDGET;

const text = (value: unknown, max: number): string | undefined =>
  typeof value === "string" ? cap(value, max) : undefined;

/** One change, or undefined when its shape is wrong (the change is dropped, never the reply). */
function parseChange(entry: unknown, known: ReadonlySet<string>): PlanEditChange | undefined {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
  const item = entry as Rec;
  if (Object.keys(item).some(key => !(FIELDS as readonly string[]).includes(key))) return undefined;
  if (typeof item.id !== "string" || !known.has(item.id)) return undefined;
  const change: PlanEditChange = { id: item.id };
  for (const key of ["covers", "entry", "handoff", "previous"] as const) {
    if (item[key] === undefined) continue;
    const value = text(item[key], PLAN_EDIT_TEXT_CHARS);
    if (value === undefined) return undefined;
    if (value) change[key] = value;
  }
  if (item.points !== undefined) {
    if (!Array.isArray(item.points) || item.points.some(point => typeof point !== "string")) return undefined;
    const points = (item.points as string[])
      .map(point => cap(point, POINT_MAX).replace(/·/g, "・"))
      .filter(Boolean);
    if (points.length) {
      if (points.length < MIN_POINTS) return undefined;
      change.points = points.slice(0, MAX_POINTS);
    }
  }
  // A checklist belongs to the points it was written for: one that comes without new points is ignored.
  if (item.checklist !== undefined) {
    if (!Array.isArray(item.checklist)) return undefined;
    const list: { type: ChecklistType; text: string }[] = [];
    for (const raw of item.checklist) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
      const one = raw as Rec;
      if (Object.keys(one).length !== 2 || (one.type !== "structure" && one.type !== "fact")) return undefined;
      const body = text(one.text, PLAN_EDIT_CHECK_CHARS);
      if (!body) return undefined;
      if (!SUBJECTIVE.test(body) && !unconditionalPicture(body)) list.push({ type: one.type, text: body });
    }
    if (change.points && list.length) change.checklist = list.slice(0, MAX_CHECKLIST);
    else if (change.points) return undefined;
  }
  return Object.keys(change).length > 1 ? change : undefined;
}

/**
 * Reads `changes` and nothing else (anything else is a failure, retried). A change with an unknown id, a repeated id, an unknown field or a
 * wrong shape is dropped on its own; the valid ones are returned in the reply's order.
 */
export function parsePlanEdit(raw: string, request: PlanEditRequest): PlanEditChange[] {
  const value = parseJson(raw);
  if (Object.keys(value).length !== 1 || !("changes" in value)) fail("The reply has unexpected fields");
  const known = new Set(request.cards.map(card => card.id));
  const seen = new Set<string>();
  const out: PlanEditChange[] = [];
  for (const entry of arrayOf(value.changes, "changes")) {
    const change = parseChange(entry, known);
    if (!change || seen.has(change.id)) continue;
    seen.add(change.id);
    out.push(change);
  }
  return out;
}

/** The chief editor's one pass over every card's brief: one text-only call (no web, no tools). */
export const planEditStep: StepDefinition<PlanEditRequest, PlanEditChange[]> = {
  id: "book-pipeline.plan-edit",
  version: 1,
  render,
  schema: PLAN_EDIT_SCHEMA,
  policy: (prompt, request) => {
    if (request.cards.length < 3) fail("A plan edit needs three cards");
    if (!planEditFits(request)) fail("The plans are too long for one request");
    overBudget(prompt, PLAN_EDIT_SCHEMA);
  },
  parse: parsePlanEdit
};
