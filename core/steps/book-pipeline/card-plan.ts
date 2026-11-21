import type { BookRole, BookSettings } from "../../book-pipeline/model";
import type { CardKind } from "../../book-pipeline/structure";
import type { ChecklistItem, ChecklistType } from "../../book-pipeline/plan-text";
import {
  cleanSearchTerms,
  cleanSlotText,
  imageSlotCap,
  MAX_IMAGE_SLOTS,
  MAX_SEARCH_TERMS,
  type ImageSlot
} from "../../book-pipeline/image-slots";
import type { CoverPlan } from "../../book-pipeline/cover";
import { imageCountRange } from "../../book-pipeline/settings";
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
import roleImagesTemplate from "./card-plan-images-role.md";
import ownerImagesTemplate from "./card-plan-images-owner.md";

export interface CardNeighbour {
  /** The chapter number, or "preface"; absent for a section beside a section (sections have no number). */
  position?: number | "preface";
  title: string;
  summary: string;
}
/** One card of the book as it is on the map now; `place` is {@link placeText}. */
export interface CardPlanChapter {
  place: string;
  title: string;
}
/** Where a card is in the book (see core/book-pipeline/structure.ts). */
export interface CardPlanPlace {
  kind: CardKind;
  chapter?: number;
  sectionIndex?: number;
  sectionCount?: number;
}
/** How a card's place is written in the request: `preface`, `chapter 2`, `section 1 of 3 in chapter 2`. */
export const placeText = (p: CardPlanPlace): string =>
  p.kind === "preface"
    ? "preface"
    : p.kind === "chapter"
      ? `chapter ${p.chapter}`
      : `section ${p.sectionIndex} of ${p.sectionCount} in chapter ${p.chapter}`;
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
  card: CardPlanPlace & { id: string; role: BookRole; title: string; summary: string };
  /** The complete current chapter list, in reading order: the authority for which chapters exist. Never shortened; a list that does not fit refuses the step. */
  chapters: readonly CardPlanChapter[];
  /** The chapter's child cards on the map, in reading order (supplementary owner data; trimmed to fit, never the chapter list). */
  children?: readonly CardChild[];
  /** The previous / next chapter of a chapter (the previous of chapter 1 is the preface), the previous / next section of a section. */
  previous?: CardNeighbour;
  next?: CardNeighbour;
  /** A section's chapter. */
  parent?: { position: number; title: string };
  /** The next chapter: only the last section of a chapter carries it (its handoff leads there). */
  nextChapter?: CardNeighbour;
  /** The owner's one-line extra request for this card (single-card replan); absent on a normal plan. */
  instruction?: string;
}
export interface CardPlanResult {
  covers: string;
  /** 3 to 6 content headings, one line each. */
  points: string[];
  entry: string;
  handoff: string;
  previous: string;
  next: string;
  /** Ids `C1..Cn` assigned here, in order. */
  checklist: ChecklistItem[];
  /** The image plan: 0 to 8 slots, indexes `1..n` assigned here in order. */
  images: ImageSlot[];
  /** The card's cover picture ask; absent when an older answer has none (the card then gets no cover line). */
  cover?: CoverPlan;
  /** How many items the subjective-word filter dropped (absent when none); the runner logs the count. */
  droppedSubjective?: number;
  /** How many items the unconditional-picture filter dropped (absent when none). */
  droppedPicture?: number;
}

export const MAX_CHECKLIST = 8;
export const MIN_POINTS = 3;
export const MAX_POINTS = 6;
export const POINT_MAX = 40;
export const CARD_PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    covers: { type: "string", minLength: 1 },
    points: { type: "array", minItems: MIN_POINTS, items: { type: "string", minLength: 1 } },
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
          anchor: { type: "string", minLength: 1 },
          search: {
            type: "array",
            minItems: 2,
            maxItems: MAX_SEARCH_TERMS,
            items: { type: "string", minLength: 1 }
          }
        },
        required: ["kind", "explains", "anchor", "search"]
      }
    },
    cover: {
      type: "object",
      additionalProperties: false,
      properties: {
        explains: { type: "string", minLength: 1 },
        search: { type: "array", minItems: 2, maxItems: MAX_SEARCH_TERMS, items: { type: "string", minLength: 1 } }
      },
      required: ["explains", "search"]
    }
  },
  required: ["covers", "points", "entry", "handoff", "previous", "next", "checklist", "images", "cover"]
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
  // `cover` is asked for but optional here: an answer without it (an older one) is kept and its card gets no cover line.
  exactKeys(
    item,
    "cover" in item
      ? ["covers", "points", "entry", "handoff", "previous", "next", "checklist", "images", "cover"]
      : ["covers", "points", "entry", "handoff", "previous", "next", "checklist", "images"]
  );
  // Content headings: one line each, at most 40 characters, `·` (the Prompt line's separator) written as `・`; fewer than three is a failure (retried), more than six are cut.
  const points = arrayOf(item.points, "points")
    .map(value => singleLine(textOf(value, "points item"), POINT_MAX).replace(/·/g, "・"))
    .filter(Boolean);
  if (points.length < MIN_POINTS) fail(`points must have ${MIN_POINTS} to ${MAX_POINTS} items`);
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
  const all = arrayOf(item.images, "images");
  if (all.length > MAX_IMAGE_SLOTS) fail(`images must have 0 to ${MAX_IMAGE_SLOTS} items`);
  // Over the owner's maximum (or the default eight without a setting): the first ones are kept; under the minimum: kept as planned, never padded.
  const slots = all.slice(0, imageSlotCap(imageCountRange(request.settings)));
  const images = slots.map((entry, at): ImageSlot => {
    const one = recordOf(entry, "image slot");
    // `search` is asked for but optional here: a slot without usable English terms is kept (the Commons search then falls back).
    exactKeys(one, "search" in one ? ["kind", "explains", "anchor", "search"] : ["kind", "explains", "anchor"]);
    const field = (value: unknown, what: string, max: number): string => {
      const text = cleanSlotText(singleLine(textOf(value, what), 400), max);
      return text || fail(`${what} must be a non-empty string`);
    };
    const terms = Array.isArray(one.search) ? cleanSearchTerms(one.search) : [];
    return {
      index: at + 1,
      kind: field(one.kind, "image kind", 40),
      explains: field(one.explains, "image explains", 200),
      anchor: field(one.anchor, "image anchor", 120),
      ...(terms.length ? { search: terms } : {})
    };
  });
  let cover: CoverPlan | undefined;
  if ("cover" in item) {
    // Present but unusable (no description) is a failure (retried); search terms are optional like a slot's.
    const one = recordOf(item.cover, "cover");
    exactKeys(one, "search" in one ? ["explains", "search"] : ["explains"]);
    const explains = cleanSlotText(singleLine(textOf(one.explains, "cover explains"), 400), 200);
    if (!explains) fail("cover explains must be a non-empty string");
    cover = { explains, search: Array.isArray(one.search) ? cleanSearchTerms(one.search) : [] };
  }
  const side = (value: unknown, present: boolean, what: string): string =>
    present ? singleLine(textOf(value, what), 240) : "";
  return {
    covers: singleLine(textOf(item.covers, "covers")),
    points: points.slice(0, MAX_POINTS),
    entry: singleLine(textOf(item.entry, "entry")),
    handoff: singleLine(textOf(item.handoff, "handoff")),
    previous: side(item.previous, !!request.previous, "previous"),
    next: side(item.next, !!request.next, "next"),
    checklist,
    images,
    ...(cover ? { cover } : {}),
    ...(dropped ? { droppedSubjective: dropped } : {}),
    ...(droppedPicture ? { droppedPicture } : {})
  };
}

const cap = (value: string, max: number): string => singleLine(value, max);
const neighbour = (n: CardNeighbour | undefined): string =>
  JSON.stringify(
    n
      ? {
          ...(n.position === undefined
            ? {}
            : {
                place: placeText(
                  n.position === "preface" ? { kind: "preface" } : { kind: "chapter", chapter: n.position }
                )
              }),
          title: cap(n.title, 200),
          summary: cap(n.summary, 500)
        }
      : null
  );
/** The card's relatives beyond the previous and next card: a section's chapter and (last section) the next chapter. */
const relations = (request: CardPlanRequest): string => {
  const parts: string[] = [];
  if (request.parent)
    parts.push(
      `Chapter this section belongs to (JSON object):\n${JSON.stringify({ place: placeText({ kind: "chapter", chapter: request.parent.position }), title: cap(request.parent.title, 200) })}`
    );
  if (request.nextChapter)
    parts.push(`Next chapter, which this section's handoff leads to (JSON object):\n${neighbour(request.nextChapter)}`);
  return parts.length ? `\n\n${parts.join("\n\n")}` : "";
};
/** How this card joins its neighbours, by what it is (chapter, section) and whether it has sections. */
const continuity = (request: CardPlanRequest, hasChildren: boolean): string => {
  const kind = request.card.kind;
  if (kind === "section")
    return [
      request.card.sectionIndex === 1
        ? "Continuity: this is the first section of its chapter, so its entry takes up the chapter's own text (what the chapter has just said) and does not repeat it."
        : "Continuity: its entry takes up where the previous section ended and does not repeat it.",
      request.nextChapter
        ? "As the last section of the chapter, its handoff leads out to the next chapter (the one given below), not to a section."
        : request.next
          ? "Its handoff leads into the next section."
          : "It is the last section of the last chapter, so its handoff closes the book."
    ].join(" ");
  if (kind === "preface")
    return "Continuity: this is the preface; its entry opens the book, and its handoff leads into chapter 1.";
  return [
    request.previous
      ? "Continuity: the entry takes up the end of the previous chapter (or the preface) and does not retell it."
      : "Continuity: the entry opens the book's first chapter.",
    hasChildren
      ? "This chapter has sections, so its handoff leads into its own first section, not into the next chapter."
      : request.next
        ? "This chapter has no sections, so its handoff leads into the next chapter."
        : "This chapter has no sections and is the last, so its handoff closes the book."
  ].join(" ");
};

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

/** The planner decides the count by role (no pictures-per-chapter setting); with a setting the owner's count holds for every role and beats the defaults. */
const imagesRule = (request: CardPlanRequest): string => {
  const range = imageCountRange(request.settings);
  if (!range) return roleImagesTemplate.trimEnd();
  const max = imageSlotCap(range);
  const min = Math.min(range.min, max);
  return renderTemplate(ownerImagesTemplate, {
    count: min === max ? `exactly ${max} slots` : `between ${min} and ${max} slots`,
    min: String(min)
  }).trimEnd();
};

const baseRender = (request: CardPlanRequest): string =>
  renderTemplate(template, {
    imagesRule: imagesRule(request),
    languageInstruction: languageInstruction(request.language, request.card.title),
    thread: JSON.stringify(cap(request.thread, 1200)),
    settings: JSON.stringify(request.settings),
    card: JSON.stringify({
      place: placeText(request.card),
      role: request.card.role,
      title: cap(request.card.title, 200),
      summary: cap(request.card.summary, 500)
    }),
    previous: neighbour(request.previous),
    next: neighbour(request.next),
    relations: relations(request),
    continuity: continuity(request, !!request.children?.length),
    materials: JSON.stringify(request.materials.map(m => ({ name: cap(m.name, 120), use: cap(m.use, 240) }))),
    chapters: JSON.stringify(request.chapters.map(c => ({ place: c.place, title: wholeLine(c.title) })))
  });
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
  version: 2,
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
