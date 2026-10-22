import { estimateTokens } from "../../../ai/context-builder";
import { translate, uiLocale, type ContentLanguage } from "../../../i18n";
import { inLanguageNaming } from "../_shared/fragments";
import type { ReasoningLevel } from "../../../ai/types";
import { renderTemplate, type StepDefinition } from "../../step-runner";
import languageEn from "./language.en.md";
import languageZh from "./language.zh.md";
import template from "./prompt.md";

export type StructureSuggestionKind = "strengthen" | "reduce" | "move" | "merge";
export const STRUCTURE_SUGGESTION_KINDS: readonly StructureSuggestionKind[] = ["strengthen", "reduce", "move", "merge"];
export const STRUCTURE_REVIEW_MAX_SUGGESTIONS = 12;
export const STRUCTURE_REVIEW_TOKEN_BUDGET = 32_000;
const SUMMARY_LIMIT = 240;
const TITLE_LIMIT = 200;

/** One card as the model sees it: no note body, only identity, title, a short summary, status and position. */
export interface StructureNode {
  id: string;
  title: string;
  summary: string;
  status: string;
  parentId: string | null;
  depth: number;
}
export interface StructureReviewRequest {
  rootQuestion: string;
  nodes: StructureNode[];
  language: ContentLanguage;
  /** Language of the prompt and model output; defaults to `language`, which stays the interface language for errors. */
  contentLanguage?: ContentLanguage;
  model: string;
  reasoning: ReasoningLevel;
}
/** What the target looked like when the review ran; `isSuggestionStale` compares it with the current map. */
export interface StructureSuggestionBasis {
  targetTitle: string;
  targetParentId: string | null;
}
export interface StructureSuggestion {
  kind: StructureSuggestionKind;
  targetId: string;
  reason: string;
  /** strengthen: title of the new child card under `targetId`. */
  title?: string;
  /** move: the new parent of `targetId`. */
  newParentId?: string;
  /** merge: the card that absorbs `targetId`. */
  mergeIntoId?: string;
  basis: StructureSuggestionBasis;
}
export type StructureRejectCode =
  | "unknown_target"
  | "unknown_parent"
  | "unknown_merge_target"
  | "root_target"
  | "cycle"
  | "noop"
  | "duplicate"
  | "stray_field";
export interface StructureRejection {
  index: number;
  code: StructureRejectCode;
}
export interface StructureReviewResult {
  suggestions: StructureSuggestion[];
  /** Suggestions that were well formed but referred to nothing valid; never applied, shown only as a count. */
  rejected: StructureRejection[];
}
export class StructureReviewError extends Error {
  constructor(
    readonly code: "empty" | "over_budget" | "stopped" | "invalid" | "too_many",
    message: string
  ) {
    super(message);
    this.name = "StructureReviewError";
  }
}

export const STRUCTURE_REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    suggestions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          kind: { type: "string", enum: [...STRUCTURE_SUGGESTION_KINDS] },
          targetId: { type: "string", minLength: 1 },
          reason: { type: "string", minLength: 1 },
          title: { type: "string" },
          newParentId: { type: "string" },
          mergeIntoId: { type: "string" }
        },
        required: ["kind", "targetId", "reason", "title", "newParentId", "mergeIntoId"]
      }
    }
  },
  required: ["suggestions"]
};

const clip = (value: string, limit: number): string => {
  const text = value.replace(/\s+/g, " ").trim();
  const characters = [...text];
  return characters.length > limit ? `${characters.slice(0, limit - 1).join("")}…` : text;
};

/**
 * Build the model input from the map tree (ids and parent links) and what is known about each card. Only the listed
 * fields are copied, so a caller cannot leak a note body by passing a richer object. `scopeRootId` limits the review
 * to that card's branch (depth 0); without it every card reachable from a top-level card is included. Order is
 * parent before child, siblings in `nodes` order.
 */
export function buildStructureReviewNodes(
  nodes: ReadonlyArray<{ id: string; parentId: string | null }>,
  describe: (id: string) => { title: string; summary: string; status: string } | undefined,
  scopeRootId?: string | null
): StructureNode[] {
  const children = new Map<string | null, string[]>();
  const ids = new Set(nodes.map(node => node.id));
  for (const node of nodes) {
    const key = node.parentId !== null && ids.has(node.parentId) ? node.parentId : null;
    children.set(key, [...(children.get(key) ?? []), node.id]);
  }
  const result: StructureNode[] = [];
  const seen = new Set<string>();
  const visit = (id: string, parentId: string | null, depth: number): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const info = describe(id);
    result.push({
      id,
      title: clip(info?.title ?? "", TITLE_LIMIT),
      summary: clip(info?.summary ?? "", SUMMARY_LIMIT),
      status: info?.status ?? "",
      parentId,
      depth
    });
    for (const child of children.get(id) ?? []) visit(child, id, depth + 1);
  };
  if (scopeRootId) {
    if (ids.has(scopeRootId)) visit(scopeRootId, null, 0);
  } else for (const id of children.get(null) ?? []) visit(id, null, 0);
  return result;
}

function descendantIds(tree: ReadonlyArray<{ id: string; parentId: string | null }>, id: string): Set<string> {
  const found = new Set<string>();
  const pending = [id];
  while (pending.length) {
    const parent = pending.pop();
    for (const node of tree)
      if (node.parentId === parent && node.id !== id && !found.has(node.id)) {
        found.add(node.id);
        pending.push(node.id);
      }
  }
  return found;
}

const invalid = (locale: ContentLanguage, detail: string): StructureReviewError =>
  new StructureReviewError("invalid", translate(locale, "error.structure_review_invalid", detail));

/**
 * Strict parser. Contract:
 * - A malformed reply rejects the WHOLE response with `StructureReviewError`: not JSON, not an object with only a
 *   `suggestions` array, an item that is not an object with string fields, an unknown kind, a missing reason, a
 *   missing field required by the kind (strengthen needs title, move needs newParentId, merge needs mergeIntoId), or
 *   more than {@link STRUCTURE_REVIEW_MAX_SUGGESTIONS} suggestions. Nothing is coerced or truncated.
 * - A well-formed suggestion that points at nothing usable is dropped individually and reported in `rejected`: an id
 *   that is not in the supplied tree, the root as a reduce/move/merge target, a move/merge into the card itself or
 *   its own descendant, a move to the current parent, a repeated (kind, target), or a field that does not belong to
 *   the kind. Dropped suggestions are never applied.
 */
export function parseStructureReview(
  raw: string,
  tree: ReadonlyArray<StructureNode>,
  language: ContentLanguage = "en"
): StructureReviewResult {
  const locale = uiLocale(language);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw invalid(locale, "JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid(locale, "object");
  const body = value as Record<string, unknown>;
  if (Object.keys(body).length !== 1 || !Array.isArray(body.suggestions)) throw invalid(locale, "suggestions");
  if (body.suggestions.length > STRUCTURE_REVIEW_MAX_SUGGESTIONS)
    throw new StructureReviewError(
      "too_many",
      translate(locale, "error.structure_review_too_many", body.suggestions.length, STRUCTURE_REVIEW_MAX_SUGGESTIONS)
    );
  const byId = new Map(tree.map(node => [node.id, node]));
  const suggestions: StructureSuggestion[] = [];
  const rejected: StructureRejection[] = [];
  const seen = new Set<string>();
  body.suggestions.forEach((entry: unknown, index: number) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw invalid(locale, `#${index + 1}`);
    const item = entry as Record<string, unknown>;
    const text = (key: string): string => {
      const field = item[key];
      if (field === undefined) return "";
      if (typeof field !== "string") throw invalid(locale, `#${index + 1} ${key}`);
      return field.trim();
    };
    for (const key of Object.keys(item))
      if (!["kind", "targetId", "reason", "title", "newParentId", "mergeIntoId"].includes(key))
        throw invalid(locale, `#${index + 1} ${key}`);
    const kind = item.kind;
    if (typeof kind !== "string" || !(STRUCTURE_SUGGESTION_KINDS as readonly string[]).includes(kind))
      throw invalid(locale, `#${index + 1} kind`);
    const targetId = text("targetId"),
      reason = text("reason"),
      title = text("title"),
      newParentId = text("newParentId"),
      mergeIntoId = text("mergeIntoId");
    if (!targetId || !reason) throw invalid(locale, `#${index + 1} ${targetId ? "reason" : "targetId"}`);
    if (kind === "strengthen" && !title) throw invalid(locale, `#${index + 1} title`);
    if (kind === "move" && !newParentId) throw invalid(locale, `#${index + 1} newParentId`);
    if (kind === "merge" && !mergeIntoId) throw invalid(locale, `#${index + 1} mergeIntoId`);
    const reject = (code: StructureRejectCode): void => {
      rejected.push({ index, code });
    };
    if ((kind !== "strengthen" && title) || (kind !== "move" && newParentId) || (kind !== "merge" && mergeIntoId))
      return reject("stray_field");
    const target = byId.get(targetId);
    if (!target) return reject("unknown_target");
    if (kind !== "strengthen" && target.parentId === null) return reject("root_target");
    if (kind === "move" || kind === "merge") {
      const destinationId = kind === "move" ? newParentId : mergeIntoId;
      const destination = byId.get(destinationId);
      if (!destination) return reject(kind === "move" ? "unknown_parent" : "unknown_merge_target");
      if (destinationId === targetId || descendantIds(tree, targetId).has(destinationId)) return reject("cycle");
      if (kind === "move" && target.parentId === destinationId) return reject("noop");
    }
    const key = `${kind}:${targetId}`;
    if (seen.has(key)) return reject("duplicate");
    seen.add(key);
    suggestions.push({
      kind,
      targetId,
      reason,
      ...(kind === "strengthen" ? { title } : {}),
      ...(kind === "move" ? { newParentId } : {}),
      ...(kind === "merge" ? { mergeIntoId } : {}),
      basis: { targetTitle: target.title, targetParentId: target.parentId }
    } as StructureSuggestion);
  });
  return { suggestions, rejected };
}

/**
 * Pure check that a suggestion still matches the map it was made for. Stale when the target (or the move/merge
 * destination) no longer exists, the target changed title or parent since the review, or the move/merge would now
 * create a cycle or do nothing. A stale suggestion must be blocked, not applied.
 */
export function isSuggestionStale(
  suggestion: StructureSuggestion,
  currentTree: ReadonlyArray<{ id: string; title: string; parentId: string | null }>
): boolean {
  const byId = new Map(currentTree.map(node => [node.id, node]));
  const target = byId.get(suggestion.targetId);
  if (!target) return true;
  if (target.parentId !== suggestion.basis.targetParentId) return true;
  if (clip(target.title, TITLE_LIMIT) !== suggestion.basis.targetTitle) return true;
  if (suggestion.kind === "move" || suggestion.kind === "merge") {
    const destinationId = suggestion.kind === "move" ? suggestion.newParentId : suggestion.mergeIntoId;
    if (!destinationId || !byId.has(destinationId)) return true;
    if (destinationId === target.id || descendantIds(currentTree, target.id).has(destinationId)) return true;
    if (suggestion.kind === "move" && target.parentId === destinationId) return true;
  }
  return false;
}

/** Review the structure of a branch or map. Input is titles, summaries and status only; the reply is strict JSON. */
export const structureReviewStep: StepDefinition<StructureReviewRequest, StructureReviewResult> = {
  id: "structure-review",
  version: 1,
  render: request =>
    renderTemplate(template, {
      languageInstruction: inLanguageNaming(
        { zh: languageZh, en: languageEn },
        request.contentLanguage ?? request.language,
        { language: "region" },
        "en"
      ),
      limit: String(STRUCTURE_REVIEW_MAX_SUGGESTIONS),
      question: JSON.stringify(request.rootQuestion),
      tree: JSON.stringify(
        request.nodes.map(node => ({
          id: node.id,
          title: node.title,
          summary: node.summary,
          status: node.status,
          parentId: node.parentId,
          depth: node.depth
        }))
      )
    }),
  schema: STRUCTURE_REVIEW_SCHEMA,
  policy: (prompt, request) => {
    const locale = uiLocale(request.language);
    if (!request.nodes.length)
      throw new StructureReviewError("empty", translate(locale, "error.structure_review_empty"));
    if (estimateTokens(prompt + JSON.stringify(STRUCTURE_REVIEW_SCHEMA)) > STRUCTURE_REVIEW_TOKEN_BUDGET)
      throw new StructureReviewError("over_budget", translate(locale, "error.structure_review_over_budget"));
  },
  parse: (raw, request) => parseStructureReview(raw, request.nodes, request.language)
};
