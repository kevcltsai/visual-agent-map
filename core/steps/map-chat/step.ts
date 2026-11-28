import { escapeRegExp } from "../../escape-regexp";
import { normalizeProgress, type MapChatProgress } from "../../map-chat-progress";
import { estimateMapChatTokens } from "../../map-chat-tokens";
import { IGNORE_EXTRA_FIELDS } from "../../../ai/runtime/output-schema";
import { instructionLanguageOf, type ContentLanguage } from "../../../i18n";
import type { ReasoningLevel } from "../../../ai/types";
import { languageVariables } from "../_shared/fragments";
import { renderTemplate, type StepDefinition } from "../../step-runner";
import { ANCHOR_LIMIT, ANCHOR_RELATION_LIMIT, NOTE_LIMIT } from "../../../experiences/visual-map/canvas-items";
import type { MapChatContext, MapChatImageScope, MapChatRelation } from "../../map-chat-context";
import { changesBrief, parseChange, type PlanEditChange } from "../book-pipeline/plan-edit";
import type { ChatStructureItem } from "../../book-pipeline/structure-edit";
import {
  RELATION_DESCRIPTION_MAX_LENGTH,
  TOPIC_RELATION_KINDS,
  relationAllowed,
  type TopicRelation,
  type TopicRelationKind
} from "../../../map-model";
import { TOPIC_COLORS, TOPIC_STYLES, type TopicColor, type TopicStyle } from "../../../topic-colors";
import { TOPIC_MARKERS, type TopicMarker } from "../../../topic-markers";
import {
  HYPOTHESIS_LEANINGS,
  HYPOTHESIS_STRENGTHS,
  TOPIC_KINDS,
  type HypothesisLeaning,
  type HypothesisStrength,
  type TopicKind
} from "../../../note-values";
import languageEn from "./language.en.md";
import languageZh from "./language.zh.md";
import steerTemplate from "./steer.en.md";
import templateEn from "./prompt.en.md";
import templateZh from "./prompt.zh.md";
import conciseEn from "./style.concise.en.md";
import conciseZh from "./style.concise.zh.md";

export const MAP_CHAT_ACTION_KINDS = [
  "add_child",
  "rename_topic",
  "update_summary",
  "edit_topic_note",
  "move_topic",
  "delete_topic",
  "edit_md_file",
  "create_md_file",
  "select_topics",
  "run_map_action",
  "create_map",
  "open_map",
  "collapse_topic",
  "expand_topic",
  "auto_layout",
  "focus_topic",
  "set_topic_kind",
  "ask_topic_kind",
  "add_relation",
  "remove_relation",
  "set_appearance",
  "rename_map",
  "reorder_topics",
  "add_anchor",
  "link_anchor",
  "read_md_file",
  "edit_book_plan",
  "edit_book_thread",
  "place_image",
  "configure_ai_card",
  "move_anchor"
] as const;
export type MapChatActionKind = (typeof MAP_CHAT_ACTION_KINDS)[number];
/** The kinds that change a book plan's structure or text: grouped into `edit_book_structure` (the first four) or dropped while the plan is being re-planned. */
const BOOK_PLAN_STRUCTURE_KINDS: ReadonlySet<string> = new Set([
  "add_child",
  "delete_topic",
  "move_topic",
  "rename_topic"
]);
const BOOK_PLAN_BUSY_KINDS: ReadonlySet<string> = new Set([
  ...BOOK_PLAN_STRUCTURE_KINDS,
  "reorder_topics",
  "edit_book_plan",
  "edit_book_thread"
]);
/** At most this many structure items in one reply (the whole-book plan's own cap). */
const BOOK_STRUCTURE_ITEM_LIMIT = 6;
export const MAP_RUN_ACTIONS = [
  "research_standard",
  "expand",
  "synthesize",
  "merge",
  "find_images",
  "run_living_card",
  "run_living_all"
] as const;
export type MapRunAction = (typeof MAP_RUN_ACTIONS)[number];
/** Research modes a reply may name; "" (not named) is read as the map's remembered mode by the view. */
export const MAP_CHAT_RESEARCH_MODES = ["quick", "standard"] as const;
export type MapChatResearchMode = (typeof MAP_CHAT_RESEARCH_MODES)[number];
/** The depths of reply version 5 and earlier: still accepted, and read as Standard (D-2026-10-231). */
const LEGACY_RESEARCH_DEPTHS = ["fast", "normal", "deep"] as const;
export const MAP_CHAT_MAX_ACTIONS = 100;
/** Prefix of a temporary id a reply gives to an anchor it places itself; `ref: "p1"` on `add_anchor` is named `anchor:p1` by later `link_anchor`s. */
export const MAP_CHAT_ANCHOR_PREFIX = "anchor:";
/** Prefix of a temporary id a reply gives to a card it creates itself; `ref: "n1"` is named `new:n1` by later actions. */
export const MAP_CHAT_NEW_PREFIX = "new:";
const REF_FORMAT = /^[A-Za-z0-9_-]{1,40}$/;
/**
 * Most tokens a map chat prompt (with its schema) may be estimated at; a larger one is refused before sending (`over_budget`).
 * The model reads 200k tokens ({@link MAP_CHAT_MODEL_WINDOW}); the other 50k are left for the CLI's own system prompt and the
 * reply. Measured with {@link estimateMapChatTokens}, which counts Chinese as Chinese.
 */
export const MAP_CHAT_TOKEN_BUDGET = 150_000;
/** The context window of the models map chat runs on, in tokens. */
export const MAP_CHAT_MODEL_WINDOW = 200_000;
export { estimateMapChatTokens, MAP_CHAT_CJK_TOKENS_PER_CHAR } from "../../map-chat-tokens";

export type MapChatAction =
  /**
   * `parentId` "" = a new root card; `new:<ref>` = a card created earlier in this reply. `ref` names this card for later actions
   * (absent = none). `topicKind` (absent = an ordinary topic), `leaning` and `strength` (only with a hypothesis) are its type.
   */
  | {
      kind: "add_child";
      parentId: string;
      title: string;
      summary: string;
      /** New AI card, configured before the card becomes visible; empty/absent means ordinary. */
      livingPrompt?: string;
      ref?: string;
      topicKind?: TopicKind;
      leaning?: HypothesisLeaning;
      strength?: HypothesisStrength;
    }
  | { kind: "configure_ai_card"; nodeId: string; content: string }
  | { kind: "rename_topic"; nodeId: string; title: string }
  | { kind: "update_summary"; nodeId: string; summary: string }
  | { kind: "edit_topic_note"; nodeId: string; detail: string }
  /**
   * `beforeId` (absent = none) puts the card in front of that child of `newParentId`, which also reorders cards that keep their
   * parent; without it the card goes under `newParentId` as before.
   */
  | { kind: "move_topic"; nodeId: string; newParentId: string; beforeId?: string }
  /** Puts the listed children of `parentId` in this order (first to last) among their siblings; the cards stay under `parentId`. */
  | { kind: "reorder_topics"; parentId: string; nodeIds: string[] }
  | { kind: "delete_topic"; nodeId: string; branch: boolean }
  | { kind: "edit_md_file"; path: string; find: string; replace: string }
  | { kind: "create_md_file"; path: string; content: string }
  | { kind: "read_md_file"; path: string }
  /** Changes to the brief fields of existing cards of a book plan under review (only when the context has `bookPlan`); a change to covers, points or previous carries its whole new checklist. Never adds, removes or moves a card. */
  | { kind: "edit_book_plan"; changes: PlanEditChange[] }
  /** The structure changes of a book plan under review (only when the context has `bookPlan`): the parser's grouping of add_child, move_topic, delete_topic and rename_topic, always last in the reply. */
  | { kind: "edit_book_structure"; items: ChatStructureItem[] }
  /** The whole new thread of the book plan under review (only when the context has `bookPlan`). */
  | { kind: "edit_book_thread"; content: string }
  /** `all` is true when the reply asked for every card; `nodeIds` then lists them all. */
  | { kind: "select_topics"; nodeIds: string[]; all: boolean }
  | {
      kind: "run_map_action";
      action: MapRunAction;
      /** Targets; empty = the current selection. */
      nodeIds: string[];
      /** merge: title of the merged card. */
      title: string;
      /** expand: optional direction. research_standard: extra requirements for the research. find_images: the search words ("" = the target card's title, decided by the view). */
      direction: string;
      /** research_standard: the mode the user asked for; "" = not named (the view uses the map's remembered mode). Ignored by every other action. */
      mode: MapChatResearchMode | "";
      /** research_standard: true = also search for images (Standard only; a Quick research never does). Ignored by every other action. */
      images: boolean;
      /** research_standard: the model says this research needs the web (unfamiliar or recent topic, or its reply says it will search). Present only when true; a missing or non-boolean-true field in the reply is false. */
      needsWeb?: true;
      /** research_standard: true = retry the targets on the other provider (this run only); the view honours it only for targets that offer `retryWith`. Present only when true. */
      otherProvider?: true;
      /** research_standard: true = the user explicitly asked for the whole note to be rewritten; the write-back replaces it ("fresh", with a backup) for this run only. Present only when true. */
      rewrite?: true;
    }
  /**
   * Looks for one picture on the web and puts it on the canvas as an annotated image (not into a card: that is `find_images`).
   * `direction` is the search words. At most one per reply; the view does the search and the placement.
   */
  | { kind: "place_image"; direction: string }
  /** Always the first action: a new map, opened for the rest of the reply. */
  | { kind: "create_map"; title: string }
  /** Always the last action: switch to the map the title names (matched by the view, not the model). */
  | { kind: "open_map"; title: string }
  /** Always the first action: names the map the user is talking in (an empty map still waiting for its name); no other map is made. */
  | { kind: "rename_map"; title: string }
  | { kind: "collapse_topic"; nodeId: string }
  | { kind: "expand_topic"; nodeId: string }
  | { kind: "auto_layout" }
  | { kind: "focus_topic"; nodeId: string }
  /**
   * Sets the topic type of one or more cards: only the note's frontmatter, never the title, the note body, the id, the parent or
   * the relations. `leaning` and `strength` (only with a hypothesis; absent = keep it, or undecided and none for a card that becomes one) are its evidence state.
   */
  | {
      kind: "set_topic_kind";
      nodeIds: string[];
      topicKind: TopicKind;
      leaning?: HypothesisLeaning;
      strength?: HypothesisStrength;
    }
  /**
   * The user's words could mean only the type, or also new content (for example "make it atomic knowledge": a new type, or one
   * single concept). Nothing is applied: the view offers the choices under the answer and acts on the one the user picks.
   */
  | { kind: "ask_topic_kind"; nodeIds: string[]; topicKind: TopicKind }
  /**
   * Adds one relation `fromId` (A) -> `toId` (B) of `relationKind` (`related` has no direction), with an optional one-line
   * `description` (absent = none). Either end may be a `new:<ref>` card of this reply. Same rules as a relation added by hand.
   */
  | {
      kind: "add_relation";
      fromId: string;
      toId: string;
      relationKind: TopicRelationKind;
      description?: string;
    }
  /** Removes the one relation between two cards (a pair holds at most one, of any kind and in either direction). */
  | { kind: "remove_relation"; fromId: string; toId: string }
  /**
   * Sets or clears the appearance of one or more cards, with the same rules as the topic panel. `color` absent keeps the
   * colour, "none" clears it. `markers` / `formats` (card styles) are turned on, `removeMarkers` / `removeFormats` off ("all" = every one).
   * The text size keeps one value. Absent lists change nothing.
   */
  | {
      kind: "set_appearance";
      nodeIds: string[];
      color?: TopicColor | "none";
      markers?: TopicMarker[];
      removeMarkers?: (TopicMarker | "all")[];
      formats?: TopicStyle[];
      removeFormats?: (TopicStyle | "all")[];
    }
  /**
   * Places one anchor on the selected annotated image `imageId` at the relative position `x`, `y` (0-1) with a one-line `note`
   * (at most {@link NOTE_LIMIT} characters, "" = none). `ref` names it for later `link_anchor`s as `anchor:<ref>`; the view
   * makes the real anchor id.
   */
  | { kind: "add_anchor"; imageId: string; ref: string; x: number; y: number; note: string }
  /**
   * Links one anchor of that image (`anchorId`: an existing anchor id or `anchor:<ref>`) to a card (`nodeId`: an existing card or
   * `new:<ref>`) with `relationKind` and an optional one-line `description`. The relation runs from the anchor to the card.
   */
  | {
      kind: "link_anchor";
      imageId: string;
      anchorId: string;
      nodeId: string;
      relationKind: TopicRelationKind;
      description?: string;
    }
  /**
   * Suggests moving one existing anchor (`anchorId`) of the selected annotated image to the relative position `x`, `y` (0-1, never
   * clamped: a value outside 0-1 is refused). Always a plan: it is written only after the user confirms.
   */
  | {
      kind: "move_anchor";
      imageId: string;
      anchorId: string;
      x: number;
      y: number;
      /** Set by the parser from the selected picture's file path, never from the reply: a picture replaced before Apply is stale. */
      imageRef?: string;
    };

export type MapChatRejectCode =
  | "bad_item"
  | "unknown_kind"
  | "unknown_node"
  | "missing_field"
  | "bad_value"
  | "cycle"
  | "too_many"
  /** A `ref` that is malformed or repeated, or a `new:` id that no earlier kept action defines (or one used where it cannot be). */
  | "bad_ref"
  /** Book plan only: the plan is being re-planned, so no book or structure action is taken. */
  | "book_busy"
  /** Book plan only: reorder_topics is not done (move_topic is). */
  | "book_reorder"
  /** Book plan only: a card changed by an earlier edit_book_plan of the reply, or a second thread. */
  | "book_duplicate"
  /** A topic type on a map that has none (AIM). An `add_child` that carries one is kept as an ordinary topic and counted here too. */
  | "no_topic_kinds"
  /** A relation action on a map that has no relations (AIM). */
  | "no_relations"
  /** A relation the map does not allow (a self link, a second link on a pair, a derivation or prerequisite cycle). */
  | "relation_not_allowed"
  /** A remove_relation for two cards that hold no relation. */
  | "unknown_relation"
  /** A move_topic whose `beforeId`, or a reorder_topics card, is not a child of the target parent (at that point of the reply). */
  | "not_sibling"
  /** An appearance change on a map whose cards have none to edit (AIM). */
  | "no_appearance"
  /** An anchor action whose `imageId` is not the annotated image selected in this turn (none selected, an ordinary image, or another image). */
  | "no_image";
export interface MapChatRejection {
  index: number;
  code: MapChatRejectCode;
}
export interface MapChatResult {
  reply: string;
  actions: MapChatAction[];
  /** What is still to do after this reply, one line of at most {@link MAP_CHAT_REMAINING_LIMIT} characters; "" = everything asked is done (or a reply that has no such field). The program continues on its own when it is not empty. */
  remaining: string;
  /** The steps of a whole multi-step instruction and where it stands; absent or malformed = none (never fails the reply). */
  progress?: MapChatProgress;
  /** Items that were dropped (never applied) or, for `no_topic_kinds`, applied without their type; shown only as a count. */
  rejected: MapChatRejection[];
  /** Set by the service: a StructuredOutput call the provider did not take had more actions than this reply (work may be lost). */
  droppedOnRetry?: boolean;
  /** Relations the model suggests (V3.3 P4.4): never applied with the reply, only one by one when the user adopts it; absent = none. */
  suggestions?: MapChatRelationSuggestion[];
}
/** At most this many relation suggestions are kept from one reply (the first valid ones). */
export const MAP_CHAT_SUGGESTION_LIMIT = 5;
/** One suggested relation between two existing cards of this map, with why (`reason`) and where that comes from (`source`). */
export interface MapChatRelationSuggestion {
  fromId: string;
  toId: string;
  relationKind: TopicRelationKind;
  reason: string;
  source: string;
}
export class MapChatError extends Error {
  constructor(
    readonly code: "empty" | "over_budget" | "stopped" | "invalid",
    message: string
  ) {
    super(message);
    this.name = "MapChatError";
  }
}

export interface MapChatRequest {
  /** Trusted: the map file this request belongs to, for token-usage accounting only; never serialized into a prompt. */
  usageMapPath?: string;
  message: string;
  context: MapChatContext;
  language: ContentLanguage;
  /** Language of the prompt and model output; defaults to `language`. */
  contentLanguage?: ContentLanguage;
  model: string;
  reasoning: ReasoningLevel;
  /** Trusted: the selected image as a data URL, for the runtime's image input only; never serialized into a prompt, never stored. */
  imageDataUrl?: string;
}

/** Characters of `remaining` kept: it is read by the next round, it is not knowledge content. */
export const MAP_CHAT_REMAINING_LIMIT = 500;
/**
 * The `remaining` of a reply: a missing field or a value that is not a string (an older reply, version 17 and before) is "" (nothing
 * left, no continuation); a string is trimmed, squeezed to one line and cut to {@link MAP_CHAT_REMAINING_LIMIT} characters.
 */
export function normalizeRemaining(value: unknown): string {
  if (typeof value !== "string") return "";
  const text = value.replace(/\s+/g, " ").trim();
  const characters = [...text];
  return characters.length > MAP_CHAT_REMAINING_LIMIT ? characters.slice(0, MAP_CHAT_REMAINING_LIMIT).join("") : text;
}

const STRING = { type: "string" };
export const MAP_CHAT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    reply: STRING,
    actions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        // parseMapChat reads only the named fields, so a stray one (a context key copied over) must not fail the whole reply.
        [IGNORE_EXTRA_FIELDS]: true,
        properties: {
          kind: { type: "string", enum: [...MAP_CHAT_ACTION_KINDS] },
          nodeId: STRING,
          ref: STRING,
          parentId: STRING,
          newParentId: STRING,
          beforeId: STRING,
          title: STRING,
          summary: STRING,
          detail: STRING,
          path: STRING,
          find: STRING,
          replace: STRING,
          content: STRING,
          nodeIds: { type: "array", items: STRING },
          all: { type: "boolean" },
          branch: { type: "boolean" },
          action: { type: "string", enum: [...MAP_RUN_ACTIONS, ""] },
          direction: STRING,
          mode: { type: "string", enum: [...MAP_CHAT_RESEARCH_MODES, ""] },
          images: { type: "boolean" },
          needsWeb: { type: "boolean" },
          otherProvider: { type: "boolean" },
          rewrite: { type: "boolean" },
          topicKind: { type: "string", enum: [...TOPIC_KINDS, ""] },
          leaning: { type: "string", enum: [...HYPOTHESIS_LEANINGS, ""] },
          strength: { type: "string", enum: [...HYPOTHESIS_STRENGTHS, ""] },
          fromId: STRING,
          toId: STRING,
          relationKind: { type: "string", enum: [...TOPIC_RELATION_KINDS, ""] },
          description: STRING,
          color: { type: "string", enum: [...TOPIC_COLORS, "none", ""] },
          markers: { type: "array", items: { type: "string", enum: [...TOPIC_MARKERS] } },
          removeMarkers: { type: "array", items: { type: "string", enum: [...TOPIC_MARKERS, "all"] } },
          formats: { type: "array", items: { type: "string", enum: [...TOPIC_STYLES] } },
          removeFormats: { type: "array", items: { type: "string", enum: [...TOPIC_STYLES, "all"] } },
          imageId: STRING,
          anchorId: STRING,
          x: { type: "number" },
          y: { type: "number" },
          note: STRING,
          // edit_book_plan only: one entry per card to change; an empty string or list keeps that field (strict mode wants every field present).
          changes: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                id: STRING,
                covers: STRING,
                points: { type: "array", items: STRING },
                entry: STRING,
                handoff: STRING,
                previous: STRING,
                checklist: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: { type: { type: "string", enum: ["structure", "fact"] }, text: STRING },
                    required: ["type", "text"]
                  }
                }
              },
              required: ["id", "covers", "points", "entry", "handoff", "previous", "checklist"]
            }
          }
        },
        required: [
          "kind",
          "nodeId",
          "ref",
          "parentId",
          "newParentId",
          "beforeId",
          "title",
          "summary",
          "detail",
          "path",
          "find",
          "replace",
          "content",
          "nodeIds",
          "all",
          "branch",
          "action",
          "direction",
          "mode",
          "images",
          "needsWeb",
          "otherProvider",
          // Left out on purpose: a missing "rewrite" reads as false, so one action that forgets it does not send the whole reply back.
          "topicKind",
          "leaning",
          "strength",
          "fromId",
          "toId",
          "relationKind",
          "description",
          "color",
          "markers",
          "removeMarkers",
          "formats",
          "removeFormats",
          "imageId",
          "anchorId",
          "x",
          "y",
          "note",
          "changes"
        ]
      }
    },
    remaining: STRING,
    progress: {
      type: "object",
      additionalProperties: false,
      properties: {
        steps: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: { name: STRING, status: { type: "string", enum: ["done", "current", "todo"] } },
            required: ["name", "status"]
          }
        },
        current: { type: "integer" }
      },
      required: ["steps"]
    },
    suggestions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          fromId: STRING,
          toId: STRING,
          relationKind: { type: "string", enum: [...TOPIC_RELATION_KINDS] },
          reason: STRING,
          source: STRING
        },
        required: ["fromId", "toId", "relationKind", "reason", "source"]
      }
    }
  },
  required: ["reply", "actions", "remaining"]
};

const invalid = (detail: string): MapChatError => new MapChatError("invalid", `Map chat reply is not valid: ${detail}`);

/** Marker ids older versions offered (priority, progress, flag, face): a model that still names one has it left out, nothing else. */
const RETIRED_MARKER =
  /^(?:priority-[1-5]|progress-(?:0|25|50|75|100)|flag-(?:red|yellow|green|blue)|smile|neutral|sad|question)$/;

class Dropped extends Error {
  constructor(readonly code: MapChatRejectCode) {
    super(code);
  }
}

/**
 * A new card's summary that names a note the user showed the chat by its path ("source: Reading/Notes.md") gets a wikilink
 * ("[[Reading/Notes]]") instead, so the source can be clicked and the note lists the card as a backlink. Text already inside
 * a wikilink is left alone.
 */
export function linkSources(summary: string, paths: readonly string[] | undefined): string {
  if (!summary || !paths?.length) return summary;
  let out = summary;
  for (const path of paths) {
    if (!/\.md$/i.test(path)) continue;
    const target = path.replace(/\.md$/i, "");
    const escaped = escapeRegExp(path);
    const pattern = new RegExp("`?" + escaped + "`?", "g");
    out = out
      .split(/(\[\[[^\]]*\]\])/)
      .map(part => (part.startsWith("[[") ? part : part.replace(pattern, `[[${target}]]`)))
      .join("");
  }
  return out;
}

/**
 * Parser. A reply that is not a JSON object with a string `reply` and an `actions` array rejects the whole reply with
 * {@link MapChatError}. Inside `actions` each item is judged alone: one that is not an object, has an unknown kind, names a
 * card that is not in the supplied context, misses a field its kind needs, or would put a card under itself is dropped and
 * counted in `rejected`. Nothing dropped is applied; strings are trimmed, and unused fields are ignored.
 *
 * A reply may build a tree in one go: an `add_child` with `ref: "n1"` can be named `new:n1` by `parentId`, `newParentId`,
 * `nodeIds` and the view operations that follow it. Only a ref defined by an earlier item that was kept counts; a repeated,
 * malformed, forward or undefined ref (also one whose defining item was dropped) drops the item as `bad_ref`. A `new:` id has no
 * baseline, so rename, summary, note and delete actions refuse it. `parentId: ""` on `add_child` is a new root card.
 * `create_map` is only valid as the first item and `open_map` only as the last; after `create_map` the cards of the old map are
 * out of reach. With `noEditableMap` the reply must start with `create_map` (a lone `open_map` is also fine): any other first item (and everything before the
 * create) is dropped.
 */
export function parseMapChat(
  raw: string,
  context: Pick<MapChatContext, "nodeIds" | "parents"> & {
    bookPlan?: Pick<NonNullable<MapChatContext["bookPlan"]>, "unlocked"> & { busy?: boolean };
    sourcePaths?: readonly string[];
    noEditableMap?: boolean;
    aim?: boolean;
    relations?: readonly MapChatRelation[];
    selectedImage?: MapChatImageScope;
    /** Ids of this map's knowledge references (V3.3 P4.4): one end of an add_relation or a suggestion, never both. */
    refIds?: readonly string[];
  }
): MapChatResult {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw invalid("JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("object");
  const body = value as Record<string, unknown>;
  if (typeof body.reply !== "string") throw invalid("reply");
  if (!Array.isArray(body.actions)) throw invalid("actions");
  const known = new Set(context.nodeIds);
  const referenceIds = new Set((context.refIds ?? []).filter(id => !known.has(id)));
  // Parent links of the supplied cards, plus those of the cards this reply creates, as each kept move leaves them (for the
  // cycle check and the `beforeId` of a move).
  const parents: Record<string, string | null | undefined> = { ...context.parents };
  const refs = new Set<string>();
  // The map's relations as the reply goes: an add or a remove changes it for the items after it (reversing = remove, then add).
  let relations: TopicRelation[] = (context.relations ?? []).map(link => ({
    kind: link.kind,
    from: link.from,
    to: link.to
  }));
  const samePair = (link: { from: string; to: string }, a: string, b: string): boolean =>
    (link.from === a && link.to === b) || (link.from === b && link.to === a);
  // The selected image as the reply goes: its anchors and relations, plus those earlier kept actions add (for the limits and the pair check).
  const shown = context.selectedImage;
  const anchorRefs = new Set<string>();
  let anchorCount = shown?.anchorIds.length ?? 0;
  const anchorLinks: { from: string; to: string }[] = [...(shown?.relations ?? [])];
  let created = false;
  const underOrSame = (id: string, ancestor: string): boolean => {
    for (let at: string | null | undefined = id, hops = 0; at && hops < 10_000; at = parents[at], hops++)
      if (at === ancestor) return true;
    return false;
  };
  const total = body.actions.length;
  const actions: MapChatAction[] = [];
  const rejected: MapChatRejection[] = [];
  // A book plan under review: the structure items of the reply (grouped into one action, last), the cards an edit_book_plan already
  // changed, and whether a thread was already kept.
  const items: ChatStructureItem[] = [];
  let placedImage = false;
  const planned = new Set<string>();
  let threaded = false;
  body.actions.forEach((entry: unknown, index: number) => {
    try {
      if (index >= MAP_CHAT_MAX_ACTIONS) throw new Dropped("too_many");
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Dropped("bad_item");
      const item = entry as Record<string, unknown>;
      /** `allowEmpty`: the field must be present as a string, but an empty one is a value (clearing a note body), not a missing field. */
      const text = (key: string, required = true, allowEmpty = false): string => {
        const field = item[key];
        if (field === undefined || field === null) {
          if (required) throw new Dropped("missing_field");
          return "";
        }
        if (typeof field !== "string") throw new Dropped("bad_value");
        const trimmed = field.trim();
        if (required && !allowEmpty && !trimmed) throw new Dropped("missing_field");
        return trimmed;
      };
      const rawText = (key: string): string => {
        const field = item[key];
        if (field === undefined || field === null) return "";
        if (typeof field !== "string") throw new Dropped("bad_value");
        return field;
      };
      const flag = (key: string): boolean => item[key] === true;
      /** The topic type an item names; "" when none. An unknown one drops the item. */
      const topicKind = (): TopicKind | "" => {
        const given = text("topicKind", false);
        if (given && !(TOPIC_KINDS as readonly string[]).includes(given)) throw new Dropped("bad_value");
        return given as TopicKind | "";
      };
      /** A hypothesis strength; "" when none. An unknown one drops the item; one next to another type is ignored. */
      const strength = (kind: TopicKind | ""): HypothesisStrength | "" => {
        const given = text("strength", false);
        if (given && !(HYPOTHESIS_STRENGTHS as readonly string[]).includes(given)) throw new Dropped("bad_value");
        return kind === "hypothesis" ? (given as HypothesisStrength | "") : "";
      };
      /** A hypothesis leaning; "" when none. An unknown one drops the item; one next to another type is ignored. */
      const leaning = (kind: TopicKind | ""): HypothesisLeaning | "" => {
        const given = text("leaning", false);
        if (given && !(HYPOTHESIS_LEANINGS as readonly string[]).includes(given)) throw new Dropped("bad_value");
        return kind === "hypothesis" ? (given as HypothesisLeaning | "") : "";
      };
      /** One card id: a supplied card, or (when `allowNew`) a `new:` ref an earlier kept item defined. */
      const resolve = (id: string, allowNew: boolean): string => {
        if (id.startsWith(MAP_CHAT_NEW_PREFIX)) {
          if (!allowNew || !refs.has(id.slice(MAP_CHAT_NEW_PREFIX.length))) throw new Dropped("bad_ref");
          return id;
        }
        if (created || !known.has(id)) throw new Dropped("unknown_node");
        return id;
      };
      const node = (key: string, allowNew = false): string => resolve(text(key), allowNew);
      const list = (key: string): string[] => {
        const field = item[key];
        if (field === undefined || field === null) return [];
        if (!Array.isArray(field) || field.some(id => typeof id !== "string")) throw new Dropped("bad_value");
        const ids = [...new Set((field as string[]).map(id => id.trim()).filter(Boolean))];
        return ids.map(id => resolve(id, true));
      };
      const kind = item.kind;
      if (typeof kind !== "string" || !(MAP_CHAT_ACTION_KINDS as readonly string[]).includes(kind))
        throw new Dropped("unknown_kind");
      if (context.noEditableMap && !created && kind !== "create_map" && kind !== "open_map")
        throw new Dropped("bad_value");
      // A book plan being re-planned takes nothing; one under review takes structure changes only as `items` (below), never a reorder.
      if (context.bookPlan?.busy && BOOK_PLAN_BUSY_KINDS.has(kind)) throw new Dropped("book_busy");
      if (context.bookPlan && kind === "reorder_topics") throw new Dropped("book_reorder");
      const book = !!context.bookPlan && BOOK_PLAN_STRUCTURE_KINDS.has(kind);
      if (book && items.length >= BOOK_STRUCTURE_ITEM_LIMIT) throw new Dropped("too_many");
      /** The one annotated image a reply may act on: the one selected in this turn. */
      const image = (): void => {
        if (!shown || shown.kind !== "annotated" || text("imageId") !== shown.id) throw new Dropped("no_image");
        if (context.aim) throw new Dropped("no_relations");
      };
      /** A coordinate: a finite number, clamped to 0-1 (the canvas's own rule for an anchor). */
      const unit = (key: string): number => {
        const field = item[key];
        if (typeof field !== "number" || !Number.isFinite(field)) throw new Dropped("bad_value");
        return Math.min(1, Math.max(0, field));
      };
      switch (kind as MapChatActionKind) {
        case "add_child": {
          // Plain `content` means "create an AI card" only where that can be true; anywhere else it is ignored (pre-Living-Node behaviour).
          const rawPrompt = text("content", false);
          const livingPrompt =
            rawPrompt && !context.bookPlan && !context.aim && rawPrompt.length <= 8_000 && !text("summary", false)
              ? rawPrompt
              : "";
          if (book) {
            // Under a chapter or the book (an existing card); a `new:` parent is not possible here. `note` is the reason.
            const parentId = node("parentId");
            const title = text("title");
            const given = text("beforeId", false);
            const beforeId = given ? node("beforeId") : "";
            if (beforeId && parents[beforeId] !== parentId) throw new Dropped("not_sibling");
            const reason = text("note", false);
            items.push({
              kind: "add",
              parentId,
              title,
              summary: linkSources(text("summary", false), context.sourcePaths),
              ...(beforeId ? { beforeId } : {}),
              ...(reason ? { reason } : {})
            });
            break;
          }
          const given = text("parentId", false);
          const parentId = given ? resolve(given, true) : "";
          const title = text("title");
          const ref = text("ref", false);
          if (ref && (!REF_FORMAT.test(ref) || refs.has(ref))) throw new Dropped("bad_ref");
          const typed = topicKind();
          const power = strength(typed);
          const lean = leaning(typed);
          // An AIM map has no types: the card is still added, as an ordinary topic, and its type is counted as skipped.
          const keepType = !context.aim && typed !== "" && typed !== "topic";
          if (context.aim && typed !== "" && typed !== "topic") rejected.push({ index, code: "no_topic_kinds" });
          actions.push({
            kind: "add_child",
            parentId,
            title,
            summary: linkSources(text("summary", false), context.sourcePaths),
            ...(livingPrompt ? { livingPrompt } : {}),
            ...(ref ? { ref } : {}),
            ...(keepType ? { topicKind: typed as TopicKind } : {}),
            ...(keepType && lean ? { leaning: lean } : {}),
            ...(keepType && power ? { strength: power } : {})
          });
          if (ref) {
            refs.add(ref);
            parents[`${MAP_CHAT_NEW_PREFIX}${ref}`] = parentId || null;
          }
          break;
        }
        case "configure_ai_card": {
          if (context.bookPlan || context.aim) throw new Dropped("bad_value");
          const content = text("content");
          if (content.length > 8_000) throw new Dropped("bad_value");
          const nodeId = node("nodeId", true);
          if (nodeId.startsWith(MAP_CHAT_NEW_PREFIX)) {
            // Compatibility with the previous protocol's adjacent two-action creation.
            // Fold it before confirmation, never publish an ordinary card then configure it.
            const previous = actions[actions.length - 1];
            if (
              previous?.kind !== "add_child" ||
              previous.ref !== nodeId.slice(MAP_CHAT_NEW_PREFIX.length) ||
              previous.livingPrompt ||
              previous.summary
            )
              throw new Dropped("bad_ref");
            previous.livingPrompt = content;
          } else {
            actions.push({ kind: "configure_ai_card", nodeId, content });
          }
          break;
        }
        case "rename_topic":
          if (book) {
            const nodeId = node("nodeId");
            const title = text("title");
            const reason = text("note", false);
            items.push({ kind: "rename", nodeId, title, ...(reason ? { reason } : {}) });
            break;
          }
          actions.push({ kind: "rename_topic", nodeId: node("nodeId"), title: text("title") });
          break;
        case "update_summary":
          actions.push({ kind: "update_summary", nodeId: node("nodeId"), summary: text("summary", true, true) });
          break;
        case "edit_topic_note":
          actions.push({ kind: "edit_topic_note", nodeId: node("nodeId"), detail: text("detail", true, true) });
          break;
        case "move_topic": {
          const nodeId = node("nodeId"),
            newParentId = node("newParentId", true);
          if (underOrSame(newParentId, nodeId)) throw new Dropped("cycle");
          const given = text("beforeId", false);
          const beforeId = given ? resolve(given, true) : "";
          // The card to go before must already sit under the target parent (as the earlier items of this reply left it).
          if (beforeId && (beforeId === nodeId || parents[beforeId] !== newParentId)) throw new Dropped("not_sibling");
          if (book) {
            const reason = text("note", false);
            items.push({
              kind: "move",
              nodeId,
              newParentId,
              ...(beforeId ? { beforeId } : {}),
              ...(reason ? { reason } : {})
            });
          } else actions.push({ kind: "move_topic", nodeId, newParentId, ...(beforeId ? { beforeId } : {}) });
          parents[nodeId] = newParentId;
          break;
        }
        case "reorder_topics": {
          const parentId = resolve(text("parentId"), true);
          const nodeIds = list("nodeIds");
          if (nodeIds.length < 2) throw new Dropped("missing_field");
          // Every listed card must already sit under the parent (as the earlier items of this reply left them).
          if (nodeIds.some(id => parents[id] !== parentId)) throw new Dropped("not_sibling");
          actions.push({ kind: "reorder_topics", parentId, nodeIds });
          break;
        }
        case "delete_topic":
          if (book) {
            const nodeId = node("nodeId");
            const reason = text("note", false);
            items.push({
              kind: "remove",
              nodeId,
              ...(flag("branch") ? { branch: true } : {}),
              ...(reason ? { reason } : {})
            });
            break;
          }
          actions.push({ kind: "delete_topic", nodeId: node("nodeId"), branch: flag("branch") });
          break;
        case "edit_md_file": {
          const path = text("path");
          const find = rawText("find");
          if (!find) throw new Dropped("missing_field");
          actions.push({ kind: "edit_md_file", path, find, replace: rawText("replace") });
          break;
        }
        case "create_md_file": {
          const path = text("path");
          const content = rawText("content");
          if (!content.trim()) throw new Dropped("missing_field");
          actions.push({ kind: "create_md_file", path, content });
          break;
        }
        case "edit_book_plan": {
          // Only while a book plan is under review (the context sent one): the cards it may name are the unlocked ones it listed.
          const plan = context.bookPlan;
          if (!plan) throw new Dropped("bad_value");
          if (!Array.isArray(item.changes)) throw new Dropped("missing_field");
          const known = new Set(plan.unlocked);
          const seen = new Set<string>();
          const changes: PlanEditChange[] = [];
          const codes: MapChatRejectCode[] = [];
          for (const one of item.changes) {
            const change = parseChange(one, known);
            // A card with a bad shape, an unknown or locked id, or a repeated id is dropped on its own; so is a change to covers, points or
            // previous that comes without the checklist written for it (the old checklist would describe the old ideas).
            if (!change || seen.has(change.id)) codes.push("bad_value");
            else if (planned.has(change.id)) codes.push("book_duplicate");
            else if (changesBrief(change) && !change.checklist) codes.push("missing_field");
            else {
              seen.add(change.id);
              changes.push(change);
            }
          }
          if (!changes.length) throw new Dropped(codes[0] ?? "missing_field");
          for (const code of codes) rejected.push({ index, code });
          for (const change of changes) planned.add(change.id);
          actions.push({ kind: "edit_book_plan", changes });
          break;
        }
        case "edit_book_thread": {
          if (!context.bookPlan) throw new Dropped("bad_value");
          const content = text("content");
          if (threaded) throw new Dropped("book_duplicate");
          threaded = true;
          actions.push({ kind: "edit_book_thread", content });
          break;
        }
        case "read_md_file":
          actions.push({ kind: "read_md_file", path: text("path") });
          break;
        case "select_topics": {
          const all = flag("all");
          if (all && created) throw new Dropped("bad_value");
          const nodeIds = all ? [...known] : list("nodeIds");
          if (!nodeIds.length) throw new Dropped("missing_field");
          actions.push({ kind: "select_topics", nodeIds, all });
          break;
        }
        case "run_map_action": {
          const action = text("action");
          if (!(MAP_RUN_ACTIONS as readonly string[]).includes(action)) throw new Dropped("bad_value");
          const nodeIds = list("nodeIds");
          if (action === "run_living_card" && !nodeIds.length) throw new Dropped("missing_field");
          if (action === "run_living_all" && nodeIds.length) throw new Dropped("bad_value");
          if ((action === "run_living_card" || action === "run_living_all") && (context.bookPlan || context.aim))
            throw new Dropped("bad_value");
          const title = text("title", false);
          if (action === "merge" && !title) throw new Dropped("missing_field");
          // find_images: one or more cards (an existing card or a `new:<ref>`); empty means every selected card (the view checks).
          // mode and images only mean something to a research; every other action ignores them. A reply of version 5 or earlier
          // has `depth` instead of `mode`: a named depth reads as Standard, an empty one as not named.
          const research = action === "research_standard";
          let given = research ? text("mode", false) : "";
          if (given && !(MAP_CHAT_RESEARCH_MODES as readonly string[]).includes(given)) throw new Dropped("bad_value");
          if (research && !given && item.mode === undefined) {
            const legacy = text("depth", false);
            if (legacy && !(LEGACY_RESEARCH_DEPTHS as readonly string[]).includes(legacy))
              throw new Dropped("bad_value");
            if (legacy) given = "standard";
          }
          const mode = given as MapChatResearchMode | "";
          actions.push({
            kind: "run_map_action",
            action: action as MapRunAction,
            nodeIds,
            title,
            direction: text("direction", false),
            mode,
            images: research && mode !== "quick" && flag("images"),
            // Only a boolean `true` counts: a missing field (an older reply) or a string "true" is false.
            ...(research && flag("needsWeb") ? { needsWeb: true as const } : {}),
            ...(research && flag("otherProvider") ? { otherProvider: true as const } : {}),
            ...(research && flag("rewrite") ? { rewrite: true as const } : {})
          });
          break;
        }
        case "place_image": {
          // The search words come from the model: one picture per reply, the rest is dropped.
          const direction = text("direction");
          if (placedImage) throw new Dropped("too_many");
          placedImage = true;
          actions.push({ kind: "place_image", direction });
          break;
        }
        case "create_map": {
          if (index !== 0) throw new Dropped("bad_value");
          actions.push({ kind: "create_map", title: text("title") });
          created = true;
          break;
        }
        case "rename_map": {
          if (index !== 0) throw new Dropped("bad_value");
          actions.push({ kind: "rename_map", title: text("title") });
          break;
        }
        case "open_map": {
          if (index !== total - 1 || created) throw new Dropped("bad_value");
          actions.push({ kind: "open_map", title: text("title") });
          break;
        }
        case "collapse_topic":
          actions.push({ kind: "collapse_topic", nodeId: node("nodeId", true) });
          break;
        case "expand_topic":
          actions.push({ kind: "expand_topic", nodeId: node("nodeId", true) });
          break;
        case "auto_layout":
          actions.push({ kind: "auto_layout" });
          break;
        case "focus_topic":
          actions.push({ kind: "focus_topic", nodeId: node("nodeId", true) });
          break;
        case "set_topic_kind":
        case "ask_topic_kind": {
          const typed = topicKind();
          if (!typed) throw new Dropped("missing_field");
          const nodeIds = list("nodeIds");
          if (!nodeIds.length) throw new Dropped("missing_field");
          if (context.aim) throw new Dropped("no_topic_kinds");
          if (kind === "ask_topic_kind") {
            actions.push({ kind: "ask_topic_kind", nodeIds, topicKind: typed });
            break;
          }
          const power = strength(typed);
          const lean = leaning(typed);
          actions.push({
            kind: "set_topic_kind",
            nodeIds,
            topicKind: typed,
            ...(lean ? { leaning: lean } : {}),
            ...(power ? { strength: power } : {})
          });
          break;
        }
        case "set_appearance": {
          const nodeIds = list("nodeIds");
          if (!nodeIds.length) throw new Dropped("missing_field");
          /** A list of known values; an unknown one drops the item. Values matching `retired` are left out silently. */
          const values = <T extends string>(key: string, known: readonly string[], retired?: RegExp): T[] => {
            const field = item[key];
            if (field === undefined || field === null) return [];
            if (!Array.isArray(field) || field.some(value => typeof value !== "string")) throw new Dropped("bad_value");
            const given = [
              ...new Set((field as string[]).map(value => value.trim()).filter(value => value && !retired?.test(value)))
            ];
            if (given.some(value => !known.includes(value))) throw new Dropped("bad_value");
            return given as T[];
          };
          const color = text("color", false);
          if (color && color !== "none" && !(TOPIC_COLORS as readonly string[]).includes(color))
            throw new Dropped("bad_value");
          const markers = values<TopicMarker>("markers", TOPIC_MARKERS, RETIRED_MARKER);
          const removeMarkers = values<TopicMarker | "all">("removeMarkers", [...TOPIC_MARKERS, "all"], RETIRED_MARKER);
          const formats = values<TopicStyle>("formats", TOPIC_STYLES);
          const removeFormats = values<TopicStyle | "all">("removeFormats", [...TOPIC_STYLES, "all"]);
          // One text size, as the panel allows; a value both on and off is unclear.
          if (formats.includes("text-small") && formats.includes("text-large")) throw new Dropped("bad_value");
          if (markers.some(id => removeMarkers.includes(id)) || formats.some(id => removeFormats.includes(id)))
            throw new Dropped("bad_value");
          if (!color && !markers.length && !removeMarkers.length && !formats.length && !removeFormats.length)
            throw new Dropped("missing_field");
          if (context.aim) throw new Dropped("no_appearance");
          actions.push({
            kind: "set_appearance",
            nodeIds,
            ...(color ? { color: color as TopicColor | "none" } : {}),
            ...(markers.length ? { markers } : {}),
            ...(removeMarkers.length ? { removeMarkers } : {}),
            ...(formats.length ? { formats } : {}),
            ...(removeFormats.length ? { removeFormats } : {})
          });
          break;
        }
        case "add_relation": {
          // A bare string that is no supplied card but names a ref an earlier kept add_child defined reads as `new:<ref>`.
          const end = (key: string): string => {
            const id = text(key);
            if (!id.startsWith(MAP_CHAT_NEW_PREFIX) && !created && !known.has(id) && refs.has(id))
              return `${MAP_CHAT_NEW_PREFIX}${id}`;
            if (!created && referenceIds.has(id)) return id;
            return resolve(id, true);
          };
          const fromId = end("fromId"),
            toId = end("toId");
          // A reference of this map may be one end, not both (it is read-only and the relation belongs to this map).
          if (referenceIds.has(fromId) && referenceIds.has(toId)) throw new Dropped("relation_not_allowed");
          const given = text("relationKind");
          if (!(TOPIC_RELATION_KINDS as readonly string[]).includes(given)) throw new Dropped("bad_value");
          const relationKind = given as TopicRelationKind;
          // One line, the same limit as the description field of a relation added by hand; a longer one is not cut, it is refused.
          const description = text("description", false).replace(/\s+/g, " ");
          if ([...description].length > RELATION_DESCRIPTION_MAX_LENGTH) throw new Dropped("bad_value");
          if (context.aim) throw new Dropped("no_relations");
          if (!relationAllowed(relations, { kind: relationKind, from: fromId, to: toId }))
            throw new Dropped("relation_not_allowed");
          relations = [...relations, { kind: relationKind, from: fromId, to: toId }];
          actions.push({ kind: "add_relation", fromId, toId, relationKind, ...(description ? { description } : {}) });
          break;
        }
        case "add_anchor": {
          image();
          const ref = text("ref");
          if (!REF_FORMAT.test(ref) || anchorRefs.has(ref)) throw new Dropped("bad_ref");
          const x = unit("x"),
            y = unit("y");
          // The same cleaning as the canvas's own note: control characters become spaces, one line, at most NOTE_LIMIT characters.
          const note = [...rawText("note")]
            .map(char => (char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? " " : char))
            .join("")
            .trim()
            .slice(0, NOTE_LIMIT)
            .trim();
          if (anchorCount >= ANCHOR_LIMIT) throw new Dropped("too_many");
          anchorCount++;
          anchorRefs.add(ref);
          actions.push({ kind: "add_anchor", imageId: text("imageId"), ref, x, y, note });
          break;
        }
        case "link_anchor": {
          image();
          const anchorId = text("anchorId");
          if (anchorId.startsWith(MAP_CHAT_ANCHOR_PREFIX)) {
            if (!anchorRefs.has(anchorId.slice(MAP_CHAT_ANCHOR_PREFIX.length))) throw new Dropped("bad_ref");
          } else if (!shown?.anchorIds.includes(anchorId)) throw new Dropped("unknown_node");
          const nodeId = node("nodeId", true);
          const kindGiven = text("relationKind");
          if (!(TOPIC_RELATION_KINDS as readonly string[]).includes(kindGiven)) throw new Dropped("bad_value");
          const description = text("description", false).replace(/\s+/g, " ");
          if ([...description].length > RELATION_DESCRIPTION_MAX_LENGTH) throw new Dropped("bad_value");
          if (anchorLinks.length >= ANCHOR_RELATION_LIMIT) throw new Dropped("too_many");
          // A pair holds at most one relation, of any kind and in either direction.
          if (anchorLinks.some(link => samePair(link, anchorId, nodeId))) throw new Dropped("relation_not_allowed");
          anchorLinks.push({ from: anchorId, to: nodeId });
          actions.push({
            kind: "link_anchor",
            imageId: text("imageId"),
            anchorId,
            nodeId,
            relationKind: kindGiven as TopicRelationKind,
            ...(description ? { description } : {})
          });
          break;
        }
        case "move_anchor": {
          if (!shown || shown.kind !== "annotated") throw new Dropped("no_image");
          // An empty imageId means the selected picture; a different one is refused.
          const imageId = text("imageId", false) || shown.id;
          if (imageId !== shown.id) throw new Dropped("no_image");
          if (context.aim) throw new Dropped("no_relations");
          const anchorId = text("anchorId");
          if (!shown.anchorIds.includes(anchorId)) throw new Dropped("unknown_node");
          const [x, y] = ["x", "y"].map(key => {
            const field = item[key];
            if (typeof field !== "number" || !Number.isFinite(field) || field < 0 || field > 1)
              throw new Dropped("bad_value");
            return field;
          });
          actions.push({
            kind: "move_anchor",
            imageId,
            anchorId,
            x,
            y,
            ...(shown.path ? { imageRef: shown.path } : {})
          });
          break;
        }
        case "remove_relation": {
          // An end may be a knowledge reference of this map, as in add_relation (the writer allows it).
          const end = (key: string): string => {
            const id = text(key);
            return !created && referenceIds.has(id) ? id : resolve(id, true);
          };
          const fromId = end("fromId"),
            toId = end("toId");
          if (context.aim) throw new Dropped("no_relations");
          if (!relations.some(link => samePair(link, fromId, toId))) throw new Dropped("unknown_relation");
          relations = relations.filter(link => !samePair(link, fromId, toId));
          actions.push({ kind: "remove_relation", fromId, toId });
          break;
        }
      }
    } catch (error) {
      if (!(error instanceof Dropped)) throw error;
      rejected.push({ index, code: error.code });
    }
  });
  // The thread goes in before the briefs that follow it, and the structure last (the apply order).
  const thread = actions.findIndex(action => action.kind === "edit_book_thread");
  const firstBrief = actions.findIndex(action => action.kind === "edit_book_plan");
  if (thread > firstBrief && firstBrief >= 0) actions.splice(firstBrief, 0, ...actions.splice(thread, 1));
  if (items.length) actions.push({ kind: "edit_book_structure", items });
  const progress = normalizeProgress(body.progress);
  const suggestions = Array.isArray(body.suggestions)
    ? relationSuggestions(body.suggestions, known, referenceIds, context.relations ?? [], context.aim === true)
    : undefined;
  return {
    reply: body.reply,
    actions,
    rejected,
    remaining: normalizeRemaining(body.remaining),
    ...(progress ? { progress } : {}),
    ...(suggestions ? { suggestions } : {})
  };
}

/**
 * The first {@link MAP_CHAT_SUGGESTION_LIMIT} usable suggestions, in reply order. One is left out when it lacks a reason or a source
 * (or either is longer than one relation description), when an end is not a card or a knowledge reference of this map (or both ends are references), when the map could not hold it
 * beside its present relations (`relationAllowed`), or when an earlier kept one is on the same pair. None on an AIM map.
 */
function relationSuggestions(
  raw: readonly unknown[],
  known: ReadonlySet<string>,
  referenceIds: ReadonlySet<string>,
  relations: readonly MapChatRelation[],
  aim: boolean
): MapChatRelationSuggestion[] {
  if (aim) return [];
  const present: TopicRelation[] = relations.map(link => ({ kind: link.kind, from: link.from, to: link.to }));
  const kept: MapChatRelationSuggestion[] = [];
  const line = (value: unknown): string => (typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "");
  for (const entry of raw) {
    if (kept.length >= MAP_CHAT_SUGGESTION_LIMIT) break;
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    const fromId = line(item.fromId),
      toId = line(item.toId),
      reason = line(item.reason),
      source = line(item.source);
    const kind = line(item.relationKind);
    if (
      !reason ||
      !source ||
      !(known.has(fromId) || referenceIds.has(fromId)) ||
      !(known.has(toId) || referenceIds.has(toId))
    )
      continue;
    if (referenceIds.has(fromId) && referenceIds.has(toId)) continue;
    if ([...reason].length > RELATION_DESCRIPTION_MAX_LENGTH || [...source].length > RELATION_DESCRIPTION_MAX_LENGTH)
      continue;
    if (!(TOPIC_RELATION_KINDS as readonly string[]).includes(kind)) continue;
    const relationKind = kind as TopicRelationKind;
    if (!relationAllowed(present, { kind: relationKind, from: fromId, to: toId })) continue;
    const pair = (other: MapChatRelationSuggestion): boolean =>
      (other.fromId === fromId && other.toId === toId) || (other.fromId === toId && other.toId === fromId);
    if (kept.some(pair)) continue;
    kept.push({ fromId, toId, relationKind, reason, source });
  }
  return kept;
}

/**
 * The message sent into a turn that is already running, when the user adds to the request. English in every interface
 * language; the text is embedded as a JSON string so it cannot change the instructions.
 */
export function renderMapChatSteer(text: string): string {
  return renderTemplate(steerTemplate, { text: JSON.stringify(text) });
}

/** One conversation turn: the user's message plus the context the panel gathered. The reply is JSON; actions are applied by the view. */
export const mapChatStep: StepDefinition<MapChatRequest, MapChatResult> = {
  id: "map-chat",
  version: 35,
  render: request => {
    const language = request.contentLanguage ?? request.language;
    const zh = instructionLanguageOf(language) === "zh";
    return renderTemplate(zh ? templateZh : templateEn, {
      styleInstruction: zh ? conciseZh : conciseEn,
      languageInstruction: renderTemplate(
        zh ? languageZh : languageEn,
        languageVariables(language, { language: "region" }, language, undefined, {
          kind: "question",
          text: request.message
        })
      ),
      context: request.context.json,
      message: JSON.stringify(request.message)
    });
  },
  schema: MAP_CHAT_SCHEMA,
  policy: (prompt, request) => {
    if (!request.message.trim()) throw new MapChatError("empty", "Map chat message is empty");
    if (estimateMapChatTokens(prompt + JSON.stringify(MAP_CHAT_SCHEMA)) > MAP_CHAT_TOKEN_BUDGET)
      throw new MapChatError("over_budget", "Map chat context is too large");
  },
  parse: (raw, request) => parseMapChat(raw, request.context)
};
