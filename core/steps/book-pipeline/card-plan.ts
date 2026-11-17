import type { BookRole, BookSettings } from "../../book-pipeline/model";
import type { ChecklistItem, ChecklistType } from "../../book-pipeline/plan-text";
import { cleanSlotText, MAX_IMAGE_SLOTS, type ImageSlot } from "../../book-pipeline/image-slots";
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
import requestTemplate from "./card-plan-request.md";

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
  /** The owner's one-line extra request for this card (single-card replan); absent on a normal plan. */
  instruction?: string;
}
export interface CardPlanResult {
  covers: string;
  entry: string;
  handoff: string;
  previous: string;
  next: string;
  /** Ids `C1..Cn` assigned here, in order. */
  checklist: ChecklistItem[];
  /** The image plan: 0 to 8 slots, indexes `1..n` assigned here in order. */
  images: ImageSlot[];
  /** How many items the subjective-word filter dropped (absent when none); the runner logs the count. */
  droppedSubjective?: number;
  /** How many items the unconditional-picture filter dropped (absent when none). */
  droppedPicture?: number;
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
    },
    images: {
      type: "array",
      minItems: 0,
      maxItems: MAX_IMAGE_SLOTS,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          kind: { type: "string", minLength: 1 },
          explains: { type: "string", minLength: 1 },
          anchor: { type: "string", minLength: 1 }
        },
        required: ["kind", "explains", "anchor"]
      }
    }
  },
  required: ["covers", "entry", "handoff", "previous", "next", "checklist", "images"]
};

/** Picture words that are a requirement by themselves, and picture nouns that count only beside a requirement verb (so "圖像學" is not a picture item). */
const PICTURE_ALONE =
  /以圖為主|以图为主|圖文並茂|图文并茂|插圖|插图|配圖|配图|附圖|附图|有圖|有图|\b(?:images?|pictures?|illustrations?|photos?|diagrams?)\b/i;
const PICTURE_NOUN = /圖片|图片|圖像|图像/;
const PICTURE_VERB = /[附放配含]|嵌入|插入|每段|需有|要有|需要有|必須有|必须有/;
const CONDITION =
  /無圖|无图|沒有圖|没有图|找不到|若找得到|若有|若無|若无|如果|如有|有找到|\b(?:if|unless|when (?:available|found|possible)|no (?:image|picture)|without)\b/i;
/** A picture item that is not conditional: the first author version has no image step, so it could never be met. */
const unconditionalPicture = (text: string): boolean =>
  (PICTURE_ALONE.test(text) || (PICTURE_NOUN.test(text) && PICTURE_VERB.test(text))) && !CONDITION.test(text);

/** Adjective or value-judgement wording (Traditional and Simplified): an item with one cannot be checked from the text, so the program drops it. */
const SUBJECTIVE =
  /值得(?:注意|關注|关注|一提|留意)|精彩|精采|生動|生动|重要|引人入勝|引人入胜|有趣|吸引人|動人|动人|優美|优美|流暢|流畅|深刻|震撼|\b(?:noteworthy|worth noting|brilliant|vivid|engaging|compelling|interesting|important)\b/i;

export function parseCardPlan(raw: string, request: CardPlanRequest): CardPlanResult {
  const item = parseJson(raw);
  exactKeys(item, ["covers", "entry", "handoff", "previous", "next", "checklist", "images"]);
  const entries = arrayOf(item.checklist, "checklist");
  if (entries.length < 1 || entries.length > MAX_CHECKLIST) fail(`checklist must have 1 to ${MAX_CHECKLIST} items`);
  const parsed = entries.map((entry): { type: ChecklistType; text: string } => {
    const one = recordOf(entry, "checklist item");
    exactKeys(one, ["type", "text"]);
    if (one.type !== "structure" && one.type !== "fact") return fail("unknown checklist type");
    return { type: one.type, text: singleLine(textOf(one.text, "checklist text")) };
  });
  // Unconditional picture requirements are dropped by program (never rewritten); a plan with nothing left is a failure (retried).
  // Subjective items are dropped the same way and counted; the plan fails (and is retried) only when none is left.
  const objective = parsed.filter(item => !SUBJECTIVE.test(item.text));
  const dropped = parsed.length - objective.length;
  const kept = objective.filter(item => !unconditionalPicture(item.text));
  const droppedPicture = objective.length - kept.length;
  if (!kept.length) fail("checklist has no usable item");
  const checklist = kept.map((item, index): ChecklistItem => ({ id: `C${index + 1}`, ...item }));
  const slots = arrayOf(item.images, "images");
  if (slots.length > MAX_IMAGE_SLOTS) fail(`images must have 0 to ${MAX_IMAGE_SLOTS} items`);
  const images = slots.map((entry, at): ImageSlot => {
    const one = recordOf(entry, "image slot");
    exactKeys(one, ["kind", "explains", "anchor"]);
    const field = (value: unknown, what: string, max: number): string => {
      const text = cleanSlotText(singleLine(textOf(value, what), 400), max);
      return text || fail(`${what} must be a non-empty string`);
    };
    return {
      index: at + 1,
      kind: field(one.kind, "image kind", 40),
      explains: field(one.explains, "image explains", 200),
      anchor: field(one.anchor, "image anchor", 120)
    };
  });
  const side = (value: unknown, present: boolean, what: string): string =>
    present ? singleLine(textOf(value, what), 240) : "";
  return {
    covers: singleLine(textOf(item.covers, "covers")),
    entry: singleLine(textOf(item.entry, "entry")),
    handoff: singleLine(textOf(item.handoff, "handoff")),
    previous: side(item.previous, !!request.previous, "previous"),
    next: side(item.next, !!request.next, "next"),
    checklist,
    images,
    ...(dropped ? { droppedSubjective: dropped } : {}),
    ...(droppedPicture ? { droppedPicture } : {})
  };
}

const cap = (value: string, max: number): string => singleLine(value, max);
const neighbour = (n: CardNeighbour | undefined): string =>
  JSON.stringify(n ? { position: n.position, title: cap(n.title, 200), summary: cap(n.summary, 500) } : null);

/** The longest instruction line (the owner's own line is cut to 300 by the runner; the program's "use other sources" line may list five addresses). */
const INSTRUCTION_MAX = 1300;
/** Appended only when the owner gave one (so every normal plan's prompt stays exactly as it was). */
const extraRequest = (instruction: string | undefined): string => {
  const line = instruction ? cap(instruction, INSTRUCTION_MAX) : "";
  return line ? `\n\n${renderTemplate(requestTemplate, { instruction: JSON.stringify(line) })}` : "";
};

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
    }) + extraRequest(request.instruction),
  schema: CARD_PLAN_SCHEMA,
  policy: (prompt, request) => {
    if (!request.card.title.trim()) fail("A card plan needs a card title");
    overBudget(prompt, CARD_PLAN_SCHEMA);
  },
  parse: parseCardPlan
};
