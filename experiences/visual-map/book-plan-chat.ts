/**
 * The chief editor in the chat: what a map chat turn is told of a book plan that waits for the author (`bookPlanChatInput`), and the
 * write of an `edit_book_plan` reply (`applyBookPlanEdit`). The card rules are the runner's own (`writePlanEdits`).
 */
import { t, type ContentLanguage } from "../../i18n";
import {
  effectiveOrder,
  readBookPipeline,
  type BookPipelineData,
  type BookRole,
  type BookSettings
} from "../../core/book-pipeline/model";
import { bookStructure, type BookStructure, type CardKind } from "../../core/book-pipeline/structure";
import {
  cardPlanPlaceOf,
  planEditCardOf,
  planLockedRaw,
  writePlanEdits,
  type PlanEditNote
} from "../../core/book-pipeline/plan-edit";
import { bodyStateRaw, isKeptRaw, pipelineWroteRaw } from "../../core/book-pipeline/body-integrity";
import { parseBookPlanBody, parseBookPlanDecisions } from "../../core/book-pipeline/plan-text";
import { effectiveSettings } from "../../core/book-pipeline/settings";
import { placeText } from "../../core/steps/book-pipeline/card-plan";
import { planEditFits, shown, type PlanEditRequest } from "../../core/steps/book-pipeline/plan-edit";
import type { MapChatContext, MapChatContextInput } from "../../core/map-chat-context";
import type { MapChatAction } from "../../core/steps/map-chat/step";
import type { MapDocument } from "../../map-model";
import type { ChatOutcome } from "./chat-action-writer";

export interface BookPlanCard extends PlanEditNote {
  fields: { bookRole?: BookRole };
  settings: BookSettings;
}
export interface BookPlanChatDeps {
  /** The map as the view holds it now (read again at each use, never kept). */
  map(): MapDocument | null;
  /** The map as the file holds it now. */
  readMap(): Promise<MapDocument>;
  readCard(path: string): Promise<BookPlanCard>;
  updateNoteGuarded(
    path: string,
    patch: { prompt: string; summary?: string },
    options: { expectedContent: string; authorize: () => boolean }
  ): Promise<"written" | "discarded">;
  language(): ContentLanguage;
}

/** The run of the map when it waits for the author to confirm the plan (gate1, plan review, running); undefined otherwise. */
function reviewRun(map: MapDocument | null): BookPipelineData | undefined {
  if (!map) return undefined;
  const read = readBookPipeline(map);
  if (read.kind !== "usable") return undefined;
  const data = read.data;
  return data.phase === "gate1" && data.status === "running" && data.planReview ? data : undefined;
}
const structureOfMap = (map: MapDocument, order: readonly string[], rootId: string): BookStructure =>
  bookStructure(order, id => map.nodes.find(node => node.id === id)?.parentId, rootId);
const rootOf = (map: MapDocument): string | undefined => {
  const roots = map.nodes.filter(node => !node.parentId);
  return roots.length === 1 ? roots[0].id : undefined;
};

/**
 * The `bookPlan` a chat turn is sent while the plan waits for the author; undefined when it does not (the chat then runs as always).
 * A plan too long for the plan editor's request is not sent whole: `tooLarge` says so and nothing in it can be changed.
 */
export async function bookPlanChatInput(deps: BookPlanChatDeps): Promise<MapChatContextInput["bookPlan"] | undefined> {
  const map = deps.map();
  const data = reviewRun(map);
  const rootId = map ? rootOf(map) : undefined;
  if (!map || !data || !rootId) return undefined;
  const root = map.nodes.find(node => node.id === rootId);
  if (!root) return undefined;
  const rootCard = await deps.readCard(root.path);
  const order = effectiveOrder(data);
  const structure = structureOfMap(map, order, rootId);
  const cards = [];
  const prompts: Record<string, { path: string; prompt: string; kind: string }> = {};
  for (const id of order) {
    const node = map.nodes.find(item => item.id === id);
    if (!node) return undefined;
    const card = await deps.readCard(node.path);
    const kind: CardKind = structure.placeOf(id)?.kind ?? "chapter";
    cards.push(
      planEditCardOf(
        id,
        placeText(cardPlanPlaceOf(structure, id)),
        card.fields.bookRole ?? "body",
        card.title,
        card.prompt,
        planLockedRaw(card.raw, card.prompt)
      )
    );
    prompts[id] = { path: node.path, prompt: card.prompt, kind };
  }
  const settings = effectiveSettings(rootCard.settings, parseBookPlanDecisions(rootCard.raw));
  const request: PlanEditRequest = {
    language: deps.language(),
    model: "",
    reasoning: "medium",
    bookTitle: rootCard.title,
    thread: parseBookPlanBody(rootCard.raw).thread,
    settings,
    cards
  };
  const base = {
    runId: data.runId,
    title: rootCard.title,
    settings,
    ...(data.planOpening ? { opening: data.planOpening } : {})
  };
  return planEditFits(request)
    ? { ...base, cards: cards.map(shown), prompts }
    : { ...base, cards: [], tooLarge: true, prompts: {} };
}

/**
 * Writes the changes of an `edit_book_plan` reply. Nothing is written once the run has left the plan review; a card that is locked now,
 * whose Prompt is not the one the proposal was made on, or that would not change, is left alone (and counted).
 */
export async function applyBookPlanEdit(
  deps: BookPlanChatDeps,
  action: Extract<MapChatAction, { kind: "edit_book_plan" }>,
  baseline: Pick<MapChatContext, "bookPlan">
): Promise<ChatOutcome> {
  const plan = baseline.bookPlan;
  const stillReview = (map: MapDocument | null): boolean => reviewRun(map)?.runId === plan?.runId;
  const started = (): ChatOutcome => ({ status: "skipped", reason: t("ui.map_chat_skip_book_started") });
  if (!plan) return { status: "skipped", reason: t("ui.map_chat_skip_map_changed") };
  const map = await deps.readMap();
  const rootId = rootOf(map);
  const data = reviewRun(map);
  if (!rootId || !data || !stillReview(deps.map())) return started();
  const structure = structureOfMap(map, effectiveOrder(data), rootId);
  const authorize = (): boolean => stillReview(deps.map());
  const pathOf = (id: string): string | undefined => map.nodes.find(node => node.id === id)?.path;
  const seen = new Map<string, { prompt: string; kind: CardKind; title: string }>();
  const locked = new Set<string>();
  const ownSummary = new Set<string>();
  for (const change of action.changes) {
    const proposed = plan.prompts[change.id];
    const path = pathOf(change.id);
    if (!proposed || !path) {
      locked.add(change.id);
      continue;
    }
    const now = await deps.readCard(path);
    seen.set(change.id, { prompt: proposed.prompt, kind: proposed.kind as CardKind, title: now.title });
    if (!plan.unlocked.includes(change.id) || planLockedRaw(now.raw, now.prompt)) locked.add(change.id);
    // The reader's own Summary (a kept chapter, or a card the pipeline never wrote that has text) stays when the covers change.
    if (
      (isKeptRaw(now.raw) && bodyStateRaw(now.raw) !== "clean") ||
      (bodyStateRaw(now.raw) === "unknown" && !pipelineWroteRaw(now.raw))
    )
      ownSummary.add(change.id);
  }
  const done = await writePlanEdits(
    {
      mapPathOf: async id => pathOf(id),
      cardPathOf: pathOf,
      readCard: path => deps.readCard(path),
      updateNoteGuarded: (path, patch, options) => deps.updateNoteGuarded(path, patch, options)
    },
    { changes: action.changes, seen, locked, structure, ownSummary, language: deps.language(), authorize }
  );
  if (!done.written.length) {
    return {
      status: "skipped",
      reason: t(authorize() ? "ui.map_chat_skip_book_cards" : "ui.map_chat_skip_book_started")
    };
  }
  const left = action.changes.length - done.written.length;
  return {
    status: "done",
    note: t("ui.map_chat_line_book_plan_undo") + (left ? t("ui.map_chat_line_book_plan_left_0", left) : "")
  };
}
