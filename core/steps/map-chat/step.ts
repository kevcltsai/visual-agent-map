import { estimateTokens } from "../../../ai/context-builder";
import { instructionLanguageOf, type ContentLanguage } from "../../../i18n";
import type { ReasoningLevel } from "../../../ai/types";
import { languageVariables } from "../_shared/fragments";
import { renderTemplate, type StepDefinition } from "../../step-runner";
import type { MapChatContext } from "../../map-chat-context";
import languageEn from "./language.en.md";
import languageZh from "./language.zh.md";
import templateEn from "./prompt.en.md";
import templateZh from "./prompt.zh.md";
import conciseEn from "./style.concise.en.md";
import conciseZh from "./style.concise.zh.md";
import detailedEn from "./style.detailed.en.md";
import detailedZh from "./style.detailed.zh.md";
import redoEn from "./redo.en.md";
import redoZh from "./redo.zh.md";

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
  "focus_topic"
] as const;
export type MapChatActionKind = (typeof MAP_CHAT_ACTION_KINDS)[number];
export const MAP_RUN_ACTIONS = [
  "research_standard",
  "expand",
  "synthesize",
  "rate_by_goal",
  "merge",
  "find_images"
] as const;
export type MapRunAction = (typeof MAP_RUN_ACTIONS)[number];
/** Research depths a reply may name; "" (not named) is read as the default by the view. */
export const MAP_CHAT_RESEARCH_DEPTHS = ["fast", "normal", "deep"] as const;
export type MapChatResearchDepth = (typeof MAP_CHAT_RESEARCH_DEPTHS)[number];
export const MAP_CHAT_MAX_ACTIONS = 100;
/** Prefix of a temporary id a reply gives to a card it creates itself; `ref: "n1"` is named `new:n1` by later actions. */
export const MAP_CHAT_NEW_PREFIX = "new:";
const REF_FORMAT = /^[A-Za-z0-9_-]{1,40}$/;
export const MAP_CHAT_TOKEN_BUDGET = 150_000;

export type MapChatAction =
  /** `parentId` "" = a new root card; `new:<ref>` = a card created earlier in this reply. `ref` names this card for later actions (absent = none). */
  | { kind: "add_child"; parentId: string; title: string; summary: string; ref?: string }
  | { kind: "rename_topic"; nodeId: string; title: string }
  | { kind: "update_summary"; nodeId: string; summary: string }
  | { kind: "edit_topic_note"; nodeId: string; detail: string }
  | { kind: "move_topic"; nodeId: string; newParentId: string }
  | { kind: "delete_topic"; nodeId: string; branch: boolean }
  | { kind: "edit_md_file"; path: string; find: string; replace: string }
  | { kind: "create_md_file"; path: string; content: string }
  /** `all` is true when the reply asked for every card; `nodeIds` then lists them all. */
  | { kind: "select_topics"; nodeIds: string[]; all: boolean }
  | {
      kind: "run_map_action";
      action: MapRunAction;
      /** Targets; empty = the current selection. */
      nodeIds: string[];
      /** merge: title of the merged card. */
      title: string;
      /** rate_by_goal: the learner goal. */
      goal: string;
      /** expand: optional direction. research_standard: extra requirements for the research. find_images: the search words ("" = the target card's title, decided by the view). */
      direction: string;
      /** research_standard: the depth the user asked for; "" = not named (the view decides). Ignored by every other action. */
      depth: MapChatResearchDepth | "";
      /** research_standard: true = also search for images. Ignored by every other action. */
      images: boolean;
    }
  /** Always the first action: a new map, opened for the rest of the reply. */
  | { kind: "create_map"; title: string }
  /** Always the last action: switch to the map the title names (matched by the view, not the model). */
  | { kind: "open_map"; title: string }
  | { kind: "collapse_topic"; nodeId: string }
  | { kind: "expand_topic"; nodeId: string }
  | { kind: "auto_layout" }
  | { kind: "focus_topic"; nodeId: string };

export type MapChatRejectCode =
  | "bad_item"
  | "unknown_kind"
  | "unknown_node"
  | "missing_field"
  | "bad_value"
  | "cycle"
  | "too_many"
  /** A `ref` that is malformed or repeated, or a `new:` id that no earlier kept action defines (or one used where it cannot be). */
  | "bad_ref";
export interface MapChatRejection {
  index: number;
  code: MapChatRejectCode;
}
export interface MapChatResult {
  reply: string;
  actions: MapChatAction[];
  /** Items that were dropped; never applied, shown only as a count. */
  rejected: MapChatRejection[];
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

export type MapChatStyle = "concise" | "detailed";
export const MAP_CHAT_STYLES: readonly MapChatStyle[] = ["concise", "detailed"];

export interface MapChatRequest {
  message: string;
  /** Answer length; absent means "concise". */
  style?: MapChatStyle;
  /** True when this re-sends a question already answered (the "say it in more detail" button): its actions were already applied. */
  redo?: boolean;
  context: MapChatContext;
  language: ContentLanguage;
  /** Language of the prompt and model output; defaults to `language`. */
  contentLanguage?: ContentLanguage;
  model: string;
  reasoning: ReasoningLevel;
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
        properties: {
          kind: { type: "string", enum: [...MAP_CHAT_ACTION_KINDS] },
          nodeId: STRING,
          ref: STRING,
          parentId: STRING,
          newParentId: STRING,
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
          goal: STRING,
          direction: STRING,
          depth: { type: "string", enum: [...MAP_CHAT_RESEARCH_DEPTHS, ""] },
          images: { type: "boolean" }
        },
        required: [
          "kind",
          "nodeId",
          "ref",
          "parentId",
          "newParentId",
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
          "goal",
          "direction",
          "depth",
          "images"
        ]
      }
    }
  },
  required: ["reply", "actions"]
};

const invalid = (detail: string): MapChatError => new MapChatError("invalid", `Map chat reply is not valid: ${detail}`);

class Dropped extends Error {
  constructor(readonly code: MapChatRejectCode) {
    super(code);
  }
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
  context: Pick<MapChatContext, "nodeIds" | "parents"> & { noEditableMap?: boolean }
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
  // Parent links of the supplied cards, plus those of the cards this reply creates (for the cycle check).
  const parents: Record<string, string | null | undefined> = { ...context.parents };
  const refs = new Set<string>();
  let created = false;
  const underOrSame = (id: string, ancestor: string): boolean => {
    for (let at: string | null | undefined = id, hops = 0; at && hops < 10_000; at = parents[at], hops++)
      if (at === ancestor) return true;
    return false;
  };
  const total = body.actions.length;
  const actions: MapChatAction[] = [];
  const rejected: MapChatRejection[] = [];
  body.actions.forEach((entry: unknown, index: number) => {
    try {
      if (index >= MAP_CHAT_MAX_ACTIONS) throw new Dropped("too_many");
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Dropped("bad_item");
      const item = entry as Record<string, unknown>;
      const text = (key: string, required = true): string => {
        const field = item[key];
        if (field === undefined || field === null) {
          if (required) throw new Dropped("missing_field");
          return "";
        }
        if (typeof field !== "string") throw new Dropped("bad_value");
        const trimmed = field.trim();
        if (required && !trimmed) throw new Dropped("missing_field");
        return trimmed;
      };
      const rawText = (key: string): string => {
        const field = item[key];
        if (field === undefined || field === null) return "";
        if (typeof field !== "string") throw new Dropped("bad_value");
        return field;
      };
      const flag = (key: string): boolean => item[key] === true;
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
      switch (kind as MapChatActionKind) {
        case "add_child": {
          const given = text("parentId", false);
          const parentId = given ? resolve(given, true) : "";
          const title = text("title");
          const ref = text("ref", false);
          if (ref && (!REF_FORMAT.test(ref) || refs.has(ref))) throw new Dropped("bad_ref");
          actions.push({
            kind: "add_child",
            parentId,
            title,
            summary: text("summary", false),
            ...(ref ? { ref } : {})
          });
          if (ref) {
            refs.add(ref);
            parents[`${MAP_CHAT_NEW_PREFIX}${ref}`] = parentId || null;
          }
          break;
        }
        case "rename_topic":
          actions.push({ kind: "rename_topic", nodeId: node("nodeId"), title: text("title") });
          break;
        case "update_summary":
          actions.push({ kind: "update_summary", nodeId: node("nodeId"), summary: text("summary") });
          break;
        case "edit_topic_note":
          actions.push({ kind: "edit_topic_note", nodeId: node("nodeId"), detail: text("detail") });
          break;
        case "move_topic": {
          const nodeId = node("nodeId"),
            newParentId = node("newParentId", true);
          if (underOrSame(newParentId, nodeId)) throw new Dropped("cycle");
          actions.push({ kind: "move_topic", nodeId, newParentId });
          break;
        }
        case "delete_topic":
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
          const title = text("title", false),
            goal = text("goal", false);
          if (action === "merge" && !title) throw new Dropped("missing_field");
          if (action === "rate_by_goal" && !goal) throw new Dropped("missing_field");
          // find_images puts pictures on exactly one card: an existing card or a `new:<ref>`; empty means the single selected card (the view checks).
          if (action === "find_images" && nodeIds.length > 1) throw new Dropped("bad_value");
          // depth and images only mean something to a research; every other action ignores them (an old v3 reply has neither).
          const research = action === "research_standard";
          const given = research ? text("depth", false) : "";
          if (given && !(MAP_CHAT_RESEARCH_DEPTHS as readonly string[]).includes(given)) throw new Dropped("bad_value");
          actions.push({
            kind: "run_map_action",
            action: action as MapRunAction,
            nodeIds,
            title,
            goal,
            direction: text("direction", false),
            depth: given as MapChatResearchDepth | "",
            images: research && flag("images")
          });
          break;
        }
        case "create_map": {
          if (index !== 0) throw new Dropped("bad_value");
          actions.push({ kind: "create_map", title: text("title") });
          created = true;
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
      }
    } catch (error) {
      if (!(error instanceof Dropped)) throw error;
      rejected.push({ index, code: error.code });
    }
  });
  return { reply: body.reply, actions, rejected };
}

/** One conversation turn: the user's message plus the context the panel gathered. The reply is JSON; actions are applied by the view. */
export const mapChatStep: StepDefinition<MapChatRequest, MapChatResult> = {
  id: "map-chat",
  version: 5,
  render: request => {
    const language = request.contentLanguage ?? request.language;
    const zh = instructionLanguageOf(language) === "zh";
    const detailed = request.style === "detailed";
    const styleText = detailed ? (zh ? detailedZh : detailedEn) : zh ? conciseZh : conciseEn;
    return renderTemplate(zh ? templateZh : templateEn, {
      styleInstruction: request.redo ? `${styleText}\n${zh ? redoZh : redoEn}` : styleText,
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
    if (estimateTokens(prompt + JSON.stringify(MAP_CHAT_SCHEMA)) > MAP_CHAT_TOKEN_BUDGET)
      throw new MapChatError("over_budget", "Map chat context is too large");
  },
  parse: (raw, request) => parseMapChat(raw, request.context)
};
