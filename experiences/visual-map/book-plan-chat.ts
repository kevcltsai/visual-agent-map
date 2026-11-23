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
import { readerSummaryRaw } from "../../core/book-pipeline/body-integrity";
import { parseBookPlanBody, parseBookPlanDecisions, replaceBookPlanThread } from "../../core/book-pipeline/plan-text";
import {
  chatStructureOps,
  simulateStructure,
  type StructureNode,
  type StructureOp
} from "../../core/book-pipeline/structure-edit";
import { effectiveSettings } from "../../core/book-pipeline/settings";
import { placeText } from "../../core/steps/book-pipeline/card-plan";
import { planEditFits, shown, type PlanEditRequest } from "../../core/steps/book-pipeline/plan-edit";
import type { MapChatContext, MapChatContextInput } from "../../core/map-chat-context";
import type { MapChatAction } from "../../core/steps/map-chat/step";
import type { MapDocument } from "../../map-model";
import { structureRefusal } from "./book-plan-diff";
import type { ChatOutcome } from "./chat-action-writer";

export interface BookPlanCard extends PlanEditNote {
  summary: string;
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
  updateNoteRawGuarded(
    path: string,
    transform: (content: string) => string,
    options: { expectedContent: string; authorize: () => boolean }
  ): Promise<"written" | "discarded">;
  /** The runner's `editStructureAtReview` for this map (see book-pipeline-run.ts). */
  editStructure(
    ops: readonly StructureOp[],
    expect: { runId: string; phaseStartedAt: string; nodes: readonly StructureNode[] },
    opening: string | ((affected: number) => string)
  ): Promise<{ applied: string[]; refused: { id: string; code: string }[]; affected: number }>;
}

/** The run of the map when it waits for the author to confirm the plan (gate1, plan review, running); undefined otherwise. */
export function reviewRun(map: MapDocument | null): BookPipelineData | undefined {
  if (!map) return undefined;
  const read = readBookPipeline(map);
  if (read.kind !== "usable") return undefined;
  const data = read.data;
  return data.phase === "gate1" && data.status === "running" && data.planReview ? data : undefined;
}
/** The run of the map while the plan is planned again after a chat structure edit (planning, plan review, edited); undefined otherwise. */
export function replanRun(map: MapDocument | null): BookPipelineData | undefined {
  if (!map) return undefined;
  const read = readBookPipeline(map);
  if (read.kind !== "usable") return undefined;
  const data = read.data;
  return data.phase === "planning" && data.planReview && data.planEdited ? data : undefined;
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
  const reviewing = reviewRun(map);
  const data = reviewing ?? replanRun(map);
  const rootId = map ? rootOf(map) : undefined;
  if (!map || !data || !rootId) return undefined;
  const root = map.nodes.find(node => node.id === rootId);
  if (!root) return undefined;
  const rootCard = await deps.readCard(root.path);
  const thread = parseBookPlanBody(rootCard.raw).thread;
  if (!reviewing)
    return {
      runId: data.runId,
      phaseStartedAt: data.phaseStartedAt,
      title: rootCard.title,
      settings: effectiveSettings(rootCard.settings, parseBookPlanDecisions(rootCard.raw)),
      thread,
      cards: [],
      nodes: [],
      busy: true,
      prompts: {}
    };
  const order = effectiveOrder(data);
  const structure = structureOfMap(map, order, rootId);
  const cards = [];
  const nodes: StructureNode[] = [];
  const prompts: Record<string, { path: string; prompt: string; kind: string; title?: string; summary?: string }> = {};
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
    nodes.push({ id, parentId: node.parentId ?? null, title: card.title });
    prompts[id] = { path: node.path, prompt: card.prompt, kind, title: card.title, summary: card.summary };
  }
  const settings = effectiveSettings(rootCard.settings, parseBookPlanDecisions(rootCard.raw));
  const request: PlanEditRequest = {
    language: deps.language(),
    model: "",
    reasoning: "medium",
    bookTitle: rootCard.title,
    thread,
    settings,
    cards
  };
  const base = {
    runId: data.runId,
    phaseStartedAt: data.phaseStartedAt,
    title: rootCard.title,
    settings,
    thread,
    nodes,
    busy: false,
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
  const stillReview = (map: MapDocument | null): boolean => {
    const run = reviewRun(map);
    return !!run && run.runId === plan?.runId && run.phaseStartedAt === plan.phaseStartedAt;
  };
  const started = (): ChatOutcome => ({ status: "skipped", reason: t("ui.map_chat_skip_book_started") });
  // No plan in the baseline: the turn was not made while the plan waited for the author, so there is nothing to edit from here.
  if (!plan) return started();
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
    // The reader's own Summary (a kept chapter, a card the pipeline never wrote that has text, or one changed since the proposal)
    // stays when the covers change.
    if (now.summary !== (proposed.summary ?? "") || readerSummaryRaw(now.raw)) ownSummary.add(change.id);
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
  // The cards left as they are, named with the reason (a card that would not change is only counted).
  const left = action.changes.filter(change => !done.written.includes(change.id));
  const named: string[] = [];
  for (const change of left) {
    const known = seen.get(change.id);
    const path = pathOf(change.id);
    const changed = !!known && !!path && (await deps.readCard(path)).prompt !== known.prompt;
    if (locked.has(change.id) || changed)
      named.push(
        `${known?.title ?? plan.prompts[change.id]?.title ?? change.id}${t(locked.has(change.id) ? "ui.map_chat_skip_book_locked" : "ui.map_chat_skip_book_changed")}`
      );
  }
  return {
    status: "done",
    label: t("ui.map_chat_do_edit_book_plan_0", done.written.length),
    note:
      t("ui.map_chat_line_book_plan_undo") +
      (left.length
        ? t("ui.map_chat_line_book_plan_left_0", left.length) +
          (named.length ? t("ui.map_chat_line_book_plan_named_0", named.join(t("ui.map_chat_count_separator"))) : "")
        : "")
  };
}

type PlanBaseline = NonNullable<MapChatContext["bookPlan"]>;
const skip = (key: Parameters<typeof t>[0], ...args: (string | number)[]): ChatOutcome => ({
  status: "skipped",
  reason: t(key, ...args)
});
/** True while the run is still at the plan review the proposal was made on. */
const sameReview = (map: MapDocument | null, plan: PlanBaseline): boolean => {
  const run = reviewRun(map);
  return !!run && run.runId === plan.runId && run.phaseStartedAt === plan.phaseStartedAt;
};
const refusalKey = (code: string): Parameters<typeof t>[0] | undefined =>
  code === "not_gate1"
    ? "ui.map_chat_skip_book_started"
    : code === "stale"
      ? "ui.map_chat_skip_book_stale"
      : ["busy", "blocked", "drive_running", "notes_busy"].includes(code)
        ? "ui.map_chat_skip_book_busy"
        : undefined;

/**
 * Writes the book's thread of an `edit_book_thread` reply: only the thread lines of the plan callout on the root note. Skipped (nothing
 * written) when the run left the plan review, the thread is not the one the proposal was made on, or the note has no thread to replace.
 */
export async function applyBookThreadEdit(
  deps: BookPlanChatDeps,
  action: Extract<MapChatAction, { kind: "edit_book_thread" }>,
  baseline: Pick<MapChatContext, "bookPlan">
): Promise<ChatOutcome> {
  const plan = baseline.bookPlan;
  if (!plan || plan.busy || !sameReview(deps.map(), plan)) return skip("ui.map_chat_skip_book_started");
  const map = await deps.readMap();
  const rootId = rootOf(map);
  const root = rootId ? map.nodes.find(node => node.id === rootId) : undefined;
  if (!root || !reviewRun(map)) return skip("ui.map_chat_skip_book_started");
  const card = await deps.readCard(root.path);
  if (parseBookPlanBody(card.raw).thread !== plan.thread) return skip("ui.map_chat_skip_book_thread_changed");
  const next = replaceBookPlanThread(card.raw, action.content);
  if (next === undefined) return skip("ui.map_chat_skip_book_thread_none");
  if (next === card.raw) return skip("ui.map_chat_skip_book_cards");
  const written = await deps.updateNoteRawGuarded(root.path, () => next, {
    expectedContent: card.raw,
    authorize: () => sameReview(deps.map(), plan)
  });
  if (written === "discarded")
    return skip(
      sameReview(deps.map(), plan) ? "ui.map_chat_skip_book_thread_changed" : "ui.map_chat_skip_book_started"
    );
  return { status: "done", note: t("ui.map_chat_line_book_thread") };
}

/**
 * Applies the structure changes of an `edit_book_structure` reply through the runner (never the generic map writer: nothing goes to
 * Unassigned; removed notes are parked in Archive by the runner). The run and tree are the ones of the proposal; the runner refuses a
 * different run (not_gate1) or tree (stale) and writes nothing then.
 */
export async function applyBookStructureEdit(
  deps: BookPlanChatDeps,
  action: Extract<MapChatAction, { kind: "edit_book_structure" }>,
  baseline: Pick<MapChatContext, "bookPlan">
): Promise<ChatOutcome> {
  const plan = baseline.bookPlan;
  if (!plan || plan.busy || !plan.nodes.length || !sameReview(deps.map(), plan))
    return skip("ui.map_chat_skip_book_started");
  const input = { rootId: plan.nodes[0].id, nodes: plan.nodes };
  const ops = chatStructureOps(action.items, input, Date.now().toString(36));
  // Only what the card showed as applicable goes to the runner (the card's lock rule and the runner's can differ).
  const locked = new Set(plan.nodes.map(node => node.id).filter(id => !plan.unlocked.includes(id)));
  const sim = simulateStructure(input, ops, locked);
  const titleOf = (id: string): string => plan.nodes.find(node => node.id === id)?.title || id;
  const reasonOf = (code: string, id: string): string => {
    const op = ops.find(item => item.id === id);
    return structureRefusal(code, op && op.kind !== "add" ? titleOf(op.card) : op?.kind === "add" ? op.title : "");
  };
  const reasons = sim.rejected.map(refused => reasonOf(refused.code, refused.op.id));
  const shown = new Set(sim.applied.map(op => op.id));
  const sent = ops.filter(op => shown.has(op.id));
  if (!sent.length) return { status: "skipped", reason: reasons[0] ?? t("ui.book_struct_over_cap") };
  let result: Awaited<ReturnType<BookPlanChatDeps["editStructure"]>>;
  try {
    result = await deps.editStructure(
      sent,
      { runId: plan.runId, phaseStartedAt: plan.phaseStartedAt ?? "", nodes: plan.nodes },
      affected =>
        affected ? t("ui.map_chat_opening_book_struct_0", affected) : t("ui.map_chat_opening_book_struct_none")
    );
  } catch (error) {
    const code =
      (error as { name?: string; code?: string } | null)?.name === "BookPipelineRunError"
        ? (error as { code: string }).code
        : "";
    const key = refusalKey(code);
    if (key) return skip(key);
    throw error;
  }
  reasons.push(...result.refused.map(refused => reasonOf(refused.code, refused.id)));
  if (!result.applied.length) return { status: "skipped", reason: reasons[0] ?? t("ui.book_struct_over_cap") };
  return {
    status: "done",
    // The line counts what the runner applied, and says the re-plan wait where it is seen without "View details".
    label: t("ui.map_chat_do_edit_book_structure_0", result.applied.length),
    loud: true,
    note:
      (result.affected
        ? t("ui.map_chat_line_book_struct_0_1", result.affected, result.affected)
        : t("ui.map_chat_line_book_struct_none")) +
      (reasons.length
        ? t("ui.map_chat_line_book_struct_left_0", [...new Set(reasons)].join(t("ui.map_chat_count_separator")))
        : "")
  };
}
