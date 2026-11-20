import type { BookRole, BookSettings } from "../../book-pipeline/model";
import type { ChecklistItem, ChecklistType } from "../../book-pipeline/plan-text";
import { cleanSlotText, imageSlotCap, MAX_IMAGE_SLOTS, type ImageSlot } from "../../book-pipeline/image-slots";
import { imageRangeOf } from "../../book-pipeline/settings";
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
import template from "./card-plan.md";
import requestTemplate from "./card-plan-request.md";
import childrenTemplate from "./card-plan-children.md";

export interface CardNeighbour {
  position: number;
  title: string;
  summary: string;
}
/** One chapter of the book as it is on the map now. */
export interface CardPlanChapter {
  position: number;
  title: string;
}
/** A child card of the chapter on the map (reading order). */
export interface CardChild {
  title: string;
  summary: string;
}
export interface CardPlanRequest extends BookStepBase {
  thread: string;
  /** The effective settings (owner's current values first, then the saved editorial decisions). */
  settings: BookSettings;
  materials: readonly { name: string; use: string }[];
  card: { id: string; position: number; total: number; role: BookRole; title: string; summary: string };
  /** The complete current chapter list, in reading order: the authority for which chapters exist. Never shortened; a list that does not fit refuses the step. */
  chapters: readonly CardPlanChapter[];
  /** The chapter's child cards on the map, in reading order (supplementary owner data; trimmed to fit, never the chapter list). */
  children?: readonly CardChild[];
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
  const limit = imageSlotCap(imageRangeOf(request.settings));
  if (slots.length > limit) fail(`images must have 0 to ${limit} items`);
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

/** The longest a child card's title and summary are in the request. */
export const CHILD_TITLE_MAX = 80;
export const CHILD_SUMMARY_MAX = 200;
/** The child-card block is cut to about this many tokens (the existing estimate); the rest is only counted. */
export const CHILD_CARDS_TOKENS = 6000;
/** The chapter list is the authority: titles are put in whole (only whitespace is collapsed). */
const wholeLine = (value: string): string => singleLine(value, Number.MAX_SAFE_INTEGER);

/** The images rule of the brief: nothing added by default, or (when the owner's settings give a picture count) the owner's range for every role. */
const imagesRule = (request: CardPlanRequest): string => {
  const range = imageRangeOf(request.settings);
  if (!range) return "";
  const max = imageSlotCap(range);
  const min = Math.min(range.min, max);
  return `\n\nOwner's picture count (the whole-book settings ask for ${range.min} to ${range.max} pictures per chapter; this beats the images defaults above): plan between ${min} and ${max} image slots for every chapter role, an introduction and a closing included, each beside something the chapter's text talks about. Plan fewer than ${min} only when the chapter truly has nothing to picture; where any picture can help, plan at least ${min}.`;
};

const baseRender = (request: CardPlanRequest): string =>
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
    materials: JSON.stringify(request.materials.map(m => ({ name: cap(m.name, 120), use: cap(m.use, 240) }))),
    chapters: JSON.stringify(request.chapters.map(c => ({ position: c.position, title: wholeLine(c.title) })))
  }) + imagesRule(request);
const childSection = (items: readonly CardChild[], shown: number): string =>
  items.length
    ? `\n\n${renderTemplate(childrenTemplate, {
        children: JSON.stringify(items.slice(0, shown)),
        unlisted:
          shown < items.length
            ? `${items.length - shown} more child cards are not listed here (the list is cut to fit); cover the listed ones, say in covers that others exist, and do not claim to cover every child card.`
            : "All of this chapter's child cards are listed."
      })}`
    : "";
/**
 * The request as it will be sent, or undefined when the chapter list itself does not fit the step's budget (then the step is refused).
 * Child cards are trimmed first: to {@link CHILD_CARDS_TOKENS} and to whatever room the rest of the request leaves.
 */
export function fitCardPlan(request: CardPlanRequest): { prompt: string; shown: number; total: number } | undefined {
  const items = (request.children ?? []).map(c => ({
    title: cap(c.title, CHILD_TITLE_MAX),
    summary: cap(c.summary, CHILD_SUMMARY_MAX)
  }));
  const base = baseRender(request);
  const extra = extraRequest(request.instruction);
  const used = estimateTokens(base + extra + JSON.stringify(CARD_PLAN_SCHEMA));
  if (used > BOOK_STEP_TOKEN_BUDGET) return undefined;
  const room = Math.min(CHILD_CARDS_TOKENS, BOOK_STEP_TOKEN_BUDGET - used);
  const tokens = (k: number): number => estimateTokens(childSection(items, k));
  let low = 0;
  let high = items.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (tokens(mid) <= room) low = mid;
    else high = mid - 1;
  }
  let shown = low;
  while (shown > 0 && tokens(shown) > room) shown--;
  // Not even the "n not listed" note fits: the child cards are left out whole.
  const section = tokens(shown) <= room ? childSection(items, shown) : "";
  return { prompt: base + section + extra, shown: section ? shown : 0, total: items.length };
}
/** Whether the chapter list fits (the runner asks before the call, and logs a refusal). */
export const cardPlanFits = (request: CardPlanRequest): boolean => !!fitCardPlan(request);

/** One card's brief and acceptance checklist. Text-only. */
export const cardPlanStep: StepDefinition<CardPlanRequest, CardPlanResult> = {
  id: "book-pipeline.card-plan",
  version: 1,
  render: request => {
    const fitted = fitCardPlan(request);
    // A request that does not fit is refused by `policy` before it is sent; this only keeps `render` total.
    return fitted ? fitted.prompt : baseRender(request) + extraRequest(request.instruction);
  },
  schema: CARD_PLAN_SCHEMA,
  policy: (prompt, request) => {
    if (!request.card.title.trim()) fail("A card plan needs a card title");
    if (!cardPlanFits(request)) fail("The chapter list is too long for one request");
    overBudget(prompt, CARD_PLAN_SCHEMA);
  },
  parse: parseCardPlan
};
