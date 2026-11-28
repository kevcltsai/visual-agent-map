import { errorMessage } from "../../core/error-message";
import { runAttempts } from "../../core/attempt-runner";
import {
  isResumeKeyword,
  MAP_CHAT_AUTO_MAX_CALLS,
  pauseForPlan,
  syncAutoApply,
  type MapChatChainInterrupt
} from "../../core/map-chat-chain";
import { replyBasisOf } from "../../core/map-chat-basis";
import type { MapChatContext } from "../../core/map-chat-context";
import { CHAT_PLAN_GROUP_ORDER, chatPlanGroupOf } from "../../core/map-chat-layout";
import {
  estimateChatCalls,
  planFor,
  researchTargetsOf,
  keepPastedVideoUrls,
  resolveSelectionTargets,
  type MapChatPlan,
  type MapChatPlanReason
} from "../../core/map-chat-plan";
import type { RecordTurnStatus } from "../../core/map-chat-records";
import type { MapChatRequest, MapChatResult, MapChatService } from "../../core/map-chat-service";
import type { MapChatAction } from "../../core/steps/map-chat/step";
import { t } from "../../i18n";
import type { MapDocument } from "../../map-model";
import type {
  MapChatLine,
  MapChatMessage,
  MapChatOrigin,
  MapChatPanel,
  MapChatPlanCard,
  MapChatSteer,
  MapChatSuggestionRow,
  MapChatTurnHandle
} from "./map-chat";
import { newChatWork, type ChatChainRun, type ChatRoundWork, type MapChatChainRunner } from "./map-chat-chain-run";
import { bookPlanDiff, bookStructureCard, bookThreadDiff } from "./book-plan-diff";
import { planGhostRelations, planGhostSpecs, type PlanGhostRelation, type PlanGhostSpec } from "./chat-plan-preview";
import type { TransactionEntry } from "./map-transaction";
import type { MapChatTurnRecord, TurnEndFields } from "./map-chat-turn-record";
import { TopicChatSteers, type TopicSteerEntry } from "./topic-chat-steer";

/** The part of the chat window the plan flow uses. */
export type ChatPlanPanel = Pick<
  MapChatPanel,
  "isBusy" | "pendingPlan" | "settlePlan" | "showPlan" | "setApplying" | "hasQueuedSteers" | "refreshPlan"
>;
/** The part of the chat window the turn driver uses (the plan flow's part included). */
export type ChatTurnPanel = ChatPlanPanel &
  Pick<
    MapChatPanel,
    | "draft"
    | "transcript"
    | "clearDraft"
    | "attachments"
    | "begin"
    | "beginAutoRound"
    | "retract"
    | "hasTurn"
    | "setStage"
    | "streamReply"
    | "showSlow"
    | "clearSlow"
    | "restartWaiting"
    | "takeSteerTexts"
    | "finish"
    | "attachComparison"
    | "fail"
    | "setUnreadNotes"
    | "setReplyBasis"
    | "addSteer"
    | "setSteerState"
    | "takeQueued"
    | "restoreDraft"
    | "markStopped"
    | "focusInput"
  >;
/** One anchor a pending plan would place (drawn as a dashed dot). */
export interface ChatPreviewAnchor {
  imageId: string;
  x: number;
  y: number;
  note: string;
}
/** One anchor a pending plan would move: the dashed dot is drawn at `x`, `y`, a light link to where the anchor is now. */
export interface ChatPreviewMove {
  imageId: string;
  anchorId: string;
  x: number;
  y: number;
  /** The picture file the position was meant for; a picture replaced by another file is no longer drawn on. */
  imageRef?: string;
}
/** What applying a plan is given beyond the reply: the context the basis is judged by and where the started work is collected. */
export interface ChatPlanApplyOptions {
  context: Pick<MapChatContext, "basis" | "parents">;
  work: ChatRoundWork;
  continuation: boolean;
  chain: ChatChainRun | null;
}
/** What the map chat needs of the view; every port is read at call time. */
export interface MapChatConversationPorts {
  panel(): ChatTurnPanel | null;
  closed(): boolean;
  path(): string;
  map(): Pick<MapDocument, "id"> | null;
  notesLoading(): boolean;
  selectionIds(): string[];
  imageId(): string | null;
  chain(): Pick<
    MapChatChainRunner,
    | "current"
    | "chainForRound"
    | "resumeChatChain"
    | "retryAutoRound"
    | "finishChatRound"
    | "interruptChain"
    | "chainShows"
    | "stopChainWork"
    | "advanceChain"
  >;
  plans(): WeakMap<MapChatPlanCard, MapChatTurnRecord>;
  /**
   * Draws the plan's anchors as dashed dots, the cards it would make as dashed cards and the relations it would add as dashed lines
   * and the anchors it would move as a dashed dot with a link to where they are now (empty lists clear them), only while `token` is the plan's current one. Drawn only: never a node or a relation of the map.
   */
  showPreview(
    token: number,
    anchors: ChatPreviewAnchor[],
    cards: PlanGhostSpec[],
    relations: PlanGhostRelation[],
    moves: ChatPreviewMove[]
  ): void;
  clearPreview(): void;
  /** Why the plan made for `anchor` cannot be applied now (its map is not the open one, or the map is read-only here); null = it can. */
  applyBlock(anchor: { path: string; id: string | undefined }): string | null;
  /** Why a change to these cards cannot be made now (one of them is merging); null = it can. */
  mergeBlock(ids: readonly string[]): string | null;
  refTitles(actions: readonly MapChatAction[]): Map<string, string>;
  /** `selection`: the cards selected when the message was sent (what an action that names no card works on). */
  actionLabel(action: MapChatAction, refTitles?: ReadonlyMap<string, string>, selection?: readonly string[]): string;
  applyActions(
    result: MapChatResult & { message?: string },
    baseline: PlanBaseline,
    alive: () => boolean,
    anchor: { path: string; id: string | undefined },
    options: ChatPlanApplyOptions
  ): Promise<MapChatLine[]>;
  buildRequest(message: string, origin: MapChatOrigin, signal: AbortSignal): Promise<MapChatRequest>;
  confirmAiUsage(model: string, run: () => Promise<void>, hooks: { noticeOpening?: () => void }): Promise<boolean>;
  beginRecord(turn: MapChatTurnHandle, request: MapChatRequest, origin: MapChatOrigin): MapChatTurnRecord | null;
  endRecord(status: RecordTurnStatus, fields?: TurnEndFields): void;
  markLogged(answer: MapChatMessage): void;
  taskKey(): string;
  registerTask(key: string, controller: AbortController): void;
  unregisterTask(key: string): void;
  relocate(): void;
  modelLabel(model: string): string;
  requestChat(...args: Parameters<MapChatService["chat"]>): ReturnType<MapChatService["chat"]>;
  researchSent(): Set<string>;
  autoApply(): boolean;
  planOptions(run: ChatChainRun, request: MapChatRequest): Parameters<typeof planFor>[2];
  replyEntry(): TransactionEntry | undefined;
  markTurn(
    origin: MapChatOrigin,
    request: { imageDataUrl?: string; context?: object },
    written?: TransactionEntry
  ): void;
  errorText(error: unknown): { text: string; wrapped: boolean; technical?: string };
  notice(text: string): void;
  /**
   * The picture-book pipeline of this map waits at gate 1: confirms it and resolves with the sentence to show (the confirmation, or
   * the refusal's reason). null when the map is not waiting there. Absent in fixtures of other flows.
   */
  bookGate1Confirm?(): Promise<string> | null;
  send(again?: MapChatOrigin, restore?: string, retryOf?: ChatChainRun): Promise<void>;
}
type PlanBaseline = Pick<
  MapChatContext,
  | "mdHashes"
  | "topicHashes"
  | "selectedCount"
  | "selectedIds"
  | "basis"
  | "parents"
  | "research"
  | "mapSourcePaths"
  | "bookPlan"
>;

/** The map chat's turn and plan flow: sending a message, its answer, the plan card under it, what Apply, Cancel and Stop do, and the state they share. */
export class MapChatConversation {
  /** True while a confirmed plan is being applied; no new message is sent meanwhile. */
  applying = false;
  /** Stop was pressed while a plan was applying: the plan line says so. */
  planStopped = false;
  /** Counts plans: a plan card only works while its number is the current one (a new message, another map or closing ends it). */
  planToken = 0;
  /** The running turn's request (Stop and closing abort it); null while none runs. */
  controller: AbortController | null = null;
  /** Takes back the send that is still preparing (no request yet): what Stop does before there is a request to abort. */
  prepAbandon: (() => void) | null = null;
  /** The activity key of the running request. */
  taskKey: string | null = null;
  /** The follow-ups of the running turn: their state machine and the panel row each one has. */
  steer: {
    turn: MapChatTurnHandle;
    steers: TopicChatSteers;
    rows: Map<TopicSteerEntry, MapChatSteer>;
  } | null = null;

  constructor(private readonly ports: MapChatConversationPorts) {}

  /** Ends the plan waiting for an answer, if any: its buttons stop working and it reads as cancelled. */
  supersedeChatPlan(): void {
    const pending = this.ports.panel()?.pendingPlan() ?? null;
    this.planToken++;
    this.ports.clearPreview();
    if (pending) {
      this.ports.panel()?.settlePlan(pending, "cancelled");
      this.ports.plans().get(pending)?.plan("cancelled");
    }
  }
  private planReasonText(
    reason: MapChatPlanReason,
    result: Pick<MapChatResult, "actions">,
    selectedCount: number,
    /** Research targets the earlier rounds of the continuation started (the plan counts the whole chain). */
    researchSoFar = 0
  ): string {
    switch (reason) {
      case "not_requested":
        return t("ui.map_chat_plan_reason_not_requested");
      case "many_actions":
        return t(
          "ui.map_chat_plan_reason_many_actions_0",
          result.actions.filter(action => action.kind !== "read_md_file").length
        );
      case "many_research":
        // The same count the plan was judged by: the whole continuation (earlier rounds too), and a selection made earlier in the reply.
        return t(
          "ui.map_chat_plan_reason_many_research_0",
          researchTargetsOf(result.actions, selectedCount) + researchSoFar
        );
      case "new_map":
        return t("ui.map_chat_plan_reason_new_map");
      case "image_preview":
        return t("ui.map_chat_plan_reason_image_preview");
      case "image_other_actions":
        return t("ui.map_chat_plan_reason_image_other_actions");
      case "auto_round_other_actions":
        // Reachable from round 2 of a continuation.
        return t("ui.map_chat_plan_reason_auto_round_other_actions");
      case "research_text_other_actions":
        return t("ui.map_chat_plan_reason_research_text_other_actions");
      case "source_text_other_actions":
        return t("ui.map_chat_plan_reason_source_text_other_actions");
      case "call_budget":
        return t("ui.map_chat_plan_reason_call_budget_0", MAP_CHAT_AUTO_MAX_CALLS);
      case "auto_apply_confirm":
        return t("ui.map_chat_plan_reason_auto_apply_confirm");
      case "book_plan_edit":
        return t("ui.map_chat_plan_reason_book_plan_edit");
      case "move_anchor_confirm":
        return t("ui.map_chat_plan_reason_move_anchor_confirm");
      case "living_node_confirm":
        return t("ui.living_node_chat_plan_confirm");
    }
  }
  /** Shows the plan card under the answer; only its Apply button ever writes anything. */
  offerChatPlan(
    result: MapChatResult,
    plan: MapChatPlan,
    baseline: PlanBaseline,
    anchor: { path: string; id: string | undefined },
    /** The user's message: an integration in the plan takes it as its direction when the plan is applied, as it would have at once. */
    message: string,
    /** The turn's conversation record (switch on): what becomes of the card is written to it. */
    record: MapChatTurnRecord | null = null,
    /** The continuation the round belongs to: it goes on after Apply and ends when the card is cancelled. */
    run: ChatChainRun | null = null
  ): void {
    const chat = this.ports.panel();
    if (!chat) return;
    const token = ++this.planToken;
    const anchorsToPlace = result.actions.flatMap(action =>
      action.kind === "add_anchor" ? [{ imageId: action.imageId, x: action.x, y: action.y, note: action.note }] : []
    );
    // The cards and relations the plan would make are drawn as a dashed preview (V3.3 E3); the text list below stays the full account.
    // A suggested relation is a dashed line too, until it is adopted.
    const ghosts = planGhostSpecs(result.actions);
    const movesToShow = result.actions.flatMap(action =>
      action.kind === "move_anchor"
        ? [
            {
              imageId: action.imageId,
              anchorId: action.anchorId,
              x: action.x,
              y: action.y,
              ...(action.imageRef !== undefined ? { imageRef: action.imageRef } : {})
            }
          ]
        : []
    );
    const suggested = (result.suggestions ?? []).map((suggestion): MapChatAction => ({
      kind: "add_relation",
      fromId: suggestion.fromId,
      toId: suggestion.toId,
      relationKind: suggestion.relationKind
    }));
    const rows: MapChatSuggestionRow[] = [];
    const drawPreview = (): void =>
      this.ports.showPreview(
        token,
        anchorsToPlace,
        ghosts,
        [
          ...planGhostRelations(result.actions),
          ...planGhostRelations(suggested.filter((_, at) => rows[at]?.state !== "adopted"))
        ],
        movesToShow
      );
    drawPreview();
    const refTitles = this.ports.refTitles(result.actions);
    // A read_md_file is never shown (decision 2026-11-15-map-chat-file-bugs#2), on the plan card as in the result lines.
    const shown = result.actions.flatMap((action, index) => (action.kind === "read_md_file" ? [] : [index]));
    const items = shown.map(index =>
      this.ports.actionLabel(result.actions[index], refTitles, baseline.selectedIds ?? [])
    );
    // A change to the book plan shows each card as before and after, with its own two buttons.
    const bookDiffs = result.actions.flatMap(action =>
      action.kind === "edit_book_plan" ? (bookPlanDiff(action, baseline) ?? []) : []
    );
    const threadCard = result.actions.flatMap(action =>
      action.kind === "edit_book_thread" ? (bookThreadDiff(action, baseline) ?? []) : []
    );
    const structureCards = result.actions.flatMap(action =>
      action.kind === "edit_book_structure" ? (bookStructureCard(action, baseline) ?? []) : []
    );
    // In the order the reply is applied: the thread, the cards' plans, the structure.
    const diffs = [...threadCard.slice(0, 1), ...bookDiffs, ...structureCards];
    const diff = diffs.length ? diffs : undefined;
    // A kind whose card is shown is not listed again as a group line; a kind without a card (nothing to show) still is.
    const carded = new Set<string>([
      ...(bookDiffs.length ? ["edit_book_plan"] : []),
      ...(threadCard.length ? ["edit_book_thread"] : []),
      ...(structureCards.length ? ["edit_book_structure"] : [])
    ]);
    // The same lines by kind of work, so a 100-action plan reads as five folded lists. Next to a diff the groups are the other actions
    // of the reply: the buttons apply all of them, so none may be left unseen.
    const groups = CHAT_PLAN_GROUP_ORDER.flatMap(group => {
      const own = items.filter(
        (_, at) =>
          chatPlanGroupOf(result.actions[shown[at]].kind) === group && !carded.has(result.actions[shown[at]].kind)
      );
      return own.length
        ? [
            {
              label: t(`ui.map_chat_plan_group_${group}_0`, own.length),
              items: own,
              // Removing cards is said in words as well as in the warning colour.
              ...(group === "delete" ? { danger: { mark: t("ui.map_chat_plan_mark_delete") } } : {})
            }
          ]
        : [];
    });
    // Nothing in the reply can be applied: the structure cards only say what was refused (no cost note then) and no other action is left.
    const noApply =
      !!diff &&
      !groups.length &&
      !bookDiffs.length &&
      !threadCard.length &&
      structureCards.every(card => card.note === undefined);
    rows.push(
      ...(result.suggestions ?? []).map((suggestion, at): MapChatSuggestionRow => {
        const row: MapChatSuggestionRow = {
          text: this.ports.actionLabel(suggested[at]),
          reason: suggestion.reason,
          source: suggestion.source,
          state: "pending",
          blocked: () => this.ports.applyBlock(anchor) ?? this.ports.mergeBlock([suggestion.fromId, suggestion.toId]),
          adopt: () =>
            void this.adoptSuggestion(card, row, token, suggested[at], baseline, anchor, message, drawPreview)
        };
        return row;
      })
    );
    const card: MapChatPlanCard = {
      ...(noApply || !result.actions.length ? { noApply: true } : {}),
      ...(rows.length ? { suggestions: rows } : {}),
      ...(rows.length && !result.actions.length ? { summary: t("ui.map_chat_relation_suggest_summary") } : {}),
      ...(diff ? { diff, applyLabel: t("ui.map_chat_book_apply"), cancelLabel: t("ui.map_chat_book_cancel") } : {}),
      // A plan about a picture shows its lists open: the user checks the anchors before they apply them.
      ...(plan.reasons.some(
        reason => reason === "image_preview" || reason === "image_other_actions" || reason === "living_node_confirm"
      )
        ? { openGroups: true }
        : {}),
      reasons: plan.reasons.map(reason =>
        this.planReasonText(reason, result, baseline.selectedCount, run?.state.researchTargets ?? 0)
      ),
      items,
      groups,
      estimate: plan.estimatedCalls
        ? t("ui.map_chat_plan_calls_0", plan.estimatedCalls)
        : t("ui.map_chat_plan_calls_none"),
      // Undo takes the plan's changes back; only the AI work it starts is said to stay.
      aiWork: result.actions.some(action => action.kind === "run_map_action"),
      state: "pending",
      ...(ghosts.length ? { previewNote: t("ui.map_chat_plan_preview_note") } : {}),
      blocked: () => this.ports.applyBlock(anchor),
      apply: () => void this.applyChatPlan(card, token, { ...result, message }, baseline, anchor, run),
      cancel: () => {
        if (token !== this.planToken) return;
        this.planToken++;
        this.ports.clearPreview();
        this.ports.panel()?.settlePlan(card, "cancelled");
        this.ports.plans().get(card)?.plan("cancelled");
        this.ports.chain().interruptChain(run, "plan_cancelled");
      }
    };
    if (record) this.ports.plans().set(card, record);
    chat.showPlan(card);
  }
  /**
   * Adopts one suggested relation (P4.4): the same add_relation write as any reply, alone, so it is one undo step. Only while its
   * card waits and is the current plan; the map is checked first (not the open one, read-only here, a merging card): nothing is
   * written then and the card is drawn again with the reason.
   */
  private async adoptSuggestion(
    card: MapChatPlanCard,
    row: MapChatSuggestionRow,
    token: number,
    action: MapChatAction,
    baseline: PlanBaseline,
    anchor: { path: string; id: string | undefined },
    message: string,
    redraw: () => void
  ): Promise<void> {
    const chat = this.ports.panel();
    if (row.state !== "pending" || card.state !== "pending" || token !== this.planToken) return;
    if (!chat || this.ports.closed() || chat.isBusy || this.applying) return;
    if (row.blocked() !== null) {
      chat.refreshPlan();
      return;
    }
    this.applying = true;
    row.state = "adopting";
    let lines: MapChatLine[];
    try {
      lines = await this.ports.applyActions(
        { reply: "", actions: [action], rejected: [], remaining: "", message },
        baseline,
        () => token === this.planToken,
        { path: anchor.path, id: anchor.id },
        { context: baseline, work: newChatWork(), continuation: false, chain: null }
      );
    } catch (error) {
      lines = [{ status: "failed", text: errorMessage(error) }];
    } finally {
      this.applying = false;
    }
    row.state = lines.length && lines.every(line => line.status === "done") ? "adopted" : "failed";
    if (row.state === "failed") row.note = lines.find(line => line.status !== "done")?.text;
    if (this.ports.closed()) return;
    if (token === this.planToken) redraw();
    chat.refreshPlan();
  }
  async applyChatPlan(
    card: MapChatPlanCard,
    token: number,
    result: MapChatResult & { message?: string },
    baseline: PlanBaseline,
    anchor: { path: string; id: string | undefined },
    run: ChatChainRun | null = null
  ): Promise<void> {
    // A card already applied or cancelled is never applied again, also with its own token (a retry after a partial failure).
    if (card.state !== "pending") return;
    const chat = this.ports.panel();
    if (!chat || this.ports.closed() || token !== this.planToken || chat.isBusy || this.applying) return;
    // The map the plan was made for is not the one open any more: nothing is written.
    const map = this.ports.map();
    if (!map || this.ports.path() !== anchor.path || map.id !== anchor.id) {
      this.planToken++;
      this.ports.clearPreview();
      this.ports.chain().interruptChain(run, "map_changed");
      const skip: MapChatLine[] = [{ status: "skipped", text: t("ui.map_chat_skip_map_changed") }];
      chat.settlePlan(card, "cancelled", skip);
      this.ports.plans().get(card)?.plan("cancelled", skip);
      return;
    }
    // The map is checked again just before the write: read-only here now (a presentation, notes still loading) writes nothing and
    // the card keeps waiting and is drawn again, with the reason under its greyed Apply.
    if (this.ports.applyBlock(anchor) !== null) {
      chat.refreshPlan();
      return;
    }
    this.applying = true;
    this.planStopped = false;
    // The user's yes: the chain's later rounds are asked for.
    if (run) run.changeRequested = true;
    // The dashed dots give way to the real anchors the writes make.
    this.ports.clearPreview();
    chat.settlePlan(card, "applied");
    // Expansions that fail while the plan is still being applied wait in the panel and join the result lines below.
    // The window shows that it is working, and Stop ends the rest of the plan.
    chat.setApplying(true);
    const stopped = (): boolean => token !== this.planToken;
    let lines: MapChatLine[];
    const work = newChatWork();
    if (run) run.work = work;
    const live = { path: anchor.path, id: anchor.id };
    try {
      lines = await this.ports.applyActions(result, baseline, () => token === this.planToken, live, {
        context: baseline,
        work,
        continuation: (run?.state.round ?? 1) > 1,
        chain: run
      });
    } catch (error) {
      lines = [{ status: "failed", text: errorMessage(error) }];
    } finally {
      this.applying = false;
      chat.setApplying(false);
    }
    if (!this.ports.closed()) {
      // The lines as shown (failures that came in meanwhile merged): the screen, the record and the chain's next round agree.
      lines = chat.settlePlan(card, "applied", lines) ?? lines;
      this.ports
        .plans()
        .get(card)
        ?.plan(this.planStopped ? "stopped" : "applied", lines);
      if (run) {
        // Stop ends the continuation (and the work it started); otherwise the round is over like any other.
        if (stopped()) {
          if (this.ports.chain().chainShows(run)) this.ports.chain().stopChainWork(run);
          this.ports.chain().interruptChain(run, "stopped");
        } else if (chat.hasQueuedSteers()) this.ports.chain().interruptChain(run, "user_took_over");
        else this.ports.chain().advanceChain(run, { result, context: baseline, lines, work, anchor: live });
      }
      // Follow-ups typed while the plan was applied: sent once, unless Stop ended it.
      this.flushSteers(!stopped());
    }
  }
  /** Sends the draft: usage notice, one request, a streamed answer, then every action it asked for, once (or a plan to confirm first). */
  async sendMapChat(again?: MapChatOrigin, restore?: string, retryOf?: ChatChainRun): Promise<void> {
    const chat = this.ports.panel();
    // A message typed while a plan or a choice is being applied waits for it like a follow-up (it is sent when that ends).
    if (chat && !again && this.applying && !chat.isBusy && !this.ports.closed() && chat.draft.trim()) {
      this.steerMapChat();
      return;
    }
    if (!chat || chat.isBusy || this.applying || this.ports.closed() || !this.ports.map() || this.ports.notesLoading())
      return;
    // A retry sends the same question with the same references again, after a failure; a normal send reads the draft.
    const message = again ? again.text : chat.draft.trim();
    if (!message) return;
    // Only the word "continue" goes on with an interrupted chain; any other text below is the user taking over.
    if (!again && isResumeKeyword(message)) {
      const last = chat.transcript().at(-1);
      if (last?.resume && this.ports.chain().resumeChatChain(last)) {
        chat.clearDraft();
        return;
      }
      // No chain to go on with, and the pipeline waits at gate 1: "continue" confirms the plan (no AI call).
      const gate1 = this.ports.bookGate1Confirm?.();
      if (gate1) {
        const turn = chat.begin(message, undefined, false, "preparing");
        chat.clearDraft();
        const reply = await gate1;
        if (!this.ports.closed() && chat.hasTurn(turn)) chat.finish(reply, []);
        return;
      }
    }
    // The user speaking ends the continuation that is running, waiting for work or waiting for a plan: the text is a new message.
    const autoOrigin = again?.chain;
    if (!autoOrigin && !retryOf) this.ports.chain().interruptChain(this.ports.chain().current, "user_took_over");
    // The turn has its own copy: follow-ups that go in are added to it, and a copy keeps the earlier turn's retry as it was.
    const imageId = this.ports.imageId();
    const origin: MapChatOrigin = again
      ? { ...again }
      : {
          text: message,
          chips: chat.attachments(),
          selectedIds: this.ports.selectionIds(),
          // Only the id: the picture is read again (a retry too) when the request is built, and never kept.
          ...(imageId ? { imageId } : {})
        };
    // Where this turn is anchored. A create_map / open_map of the turn itself moves it (see applyMapChatActions).
    const anchor = { path: this.ports.path(), id: this.ports.map()?.id };
    // The continuation this round belongs to: a message of the user's starts a new one; an automatic round (or the retry of one)
    // goes on with the chain it came from, at the round it was.
    // The automatic retry of round 1 of an auto-apply chain goes on with that chain (it has no chain origin to find it by).
    const run = retryOf && !autoOrigin ? retryOf : this.ports.chain().chainForRound(autoOrigin, anchor, message);
    if (run === retryOf) run.message = message;
    run.chips = [...origin.chips];
    // The press is answered at once: the messages and a "Preparing" bubble appear before the AI is checked, the request is built
    // or the usage notice is asked. Until the request really goes out, every early end takes the messages back (see `abandon`).
    const draft = chat.draft;
    const turn = autoOrigin
      ? chat.beginAutoRound(
          run.state.round,
          run.state.maxRounds,
          run.state.remaining,
          origin,
          run.partial ?? undefined,
          ...(run.state.autoApply ? [{ calls: run.state.calls, applied: run.appliedText }] : [])
        )
      : chat.begin(message, origin, Boolean(again), "preparing");
    run.turn = turn;
    let sent = false;
    let abandoned = false;
    // Takes the turn back and puts the draft into the field again (a retry has no draft to put back). `reason`
    // is the Notice; closing the view or switching maps needs none, and then the panel has already dropped the turn.
    // `ends` is why the continuation (if one was running) ends with it.
    const abandon = (reason?: string, ends: MapChatChainInterrupt = "map_changed"): void => {
      if (abandoned) return;
      abandoned = true;
      if (this.prepAbandon === stopPreparing) this.prepAbandon = null;
      // Take the turn back first: the end sentence goes under the last reply, which must be the one before this round, not the
      // round that is being taken back (its sentence would go with it).
      const retracted = chat.retract(turn, again ? restore : draft);
      this.ports.chain().interruptChain(run, ends);
      if (!retracted) return;
      if (reason !== undefined && (!autoOrigin || ends === "failed")) this.ports.notice(reason);
    };
    // Stop while preparing is the user's own act: the send is taken back like any early end, without a Notice.
    const preparing = new AbortController();
    const stopPreparing = (): void => {
      preparing.abort();
      abandon(undefined, "stopped");
    };
    this.prepAbandon = stopPreparing;
    const preparingCurrent = (): boolean =>
      !abandoned &&
      !preparing.signal.aborted &&
      !this.ports.closed() &&
      !this.applying &&
      this.ports.panel() === chat &&
      chat.hasTurn(turn) &&
      this.ports.path() === anchor.path &&
      this.ports.map()?.id === anchor.id;
    // The follow-ups of this turn. Rows that wait are told to the panel as the machine queues them (once each, the panel
    // ignores a state it already shows); a retry asks the question with the follow-ups that went in, and only those.
    const steerRows = new Map<TopicSteerEntry, MapChatSteer>();
    const steerState: NonNullable<typeof this.steer> = {
      turn,
      rows: steerRows,
      steers: new TopicChatSteers({
        alive: () => !this.ports.closed() && this.steer === steerState && !!this.ports.panel()?.hasTurn(turn),
        onChange: reason => {
          for (const [entry, row] of steerRows)
            if (entry.state === "queued") this.ports.panel()?.setSteerState(row, "queued");
          if (reason) origin.text = [message, ...steerState.steers.delivered()].join("\n\n");
        }
      })
    };
    this.steer = steerState;
    const notSent = (): string => t(again ? "ui.map_chat_not_sent_kept" : "ui.map_chat_not_sent_draft");
    let request: MapChatRequest;
    try {
      request = await this.ports.buildRequest(message, origin, preparing.signal);
    } catch (error) {
      abandon(this.ports.closed() ? undefined : errorMessage(error), "failed");
      return;
    }
    // Stop, closing the view or a map switch while the request was being built: no usage notice, no setup guide.
    if (!preparingCurrent()) {
      abandon();
      return;
    }
    let went = false;
    try {
      went = await this.ports.confirmAiUsage(
        request.model,
        async () => {
          // The view closed, the map changed or a plan began applying while the notice was open: nothing is sent.
          if (!preparingCurrent()) {
            abandon();
            return;
          }
          sent = true;
          if (this.prepAbandon === stopPreparing) this.prepAbandon = null;
          // Conversation record (switch on): the turn is written from here, not before (a send taken back leaves no trace).
          const record = this.ports.beginRecord(turn, request, origin);
          run.record = record;
          // The follow-ups that went into this turn are written with its end (queued ones become the next turn).
          if (record) record.steerTexts = () => steerState.steers.delivered();
          // One attempt is one request to the model; runAttempts runs them. "Resend" (the slow notice) replaces the attempt with
          // another of the same question: a reply that arrives from a replaced attempt changes nothing, like one that arrives after Stop.
          // The whole turn shares one controller (Stop, closing the view or a map switch abort it), so Stop between a resend and its
          // next request takes the normal Stopped path.
          const turnController = new AbortController();
          const key = this.ports.taskKey();
          this.controller = turnController;
          this.taskKey = key;
          this.ports.registerTask(key, turnController);
          // A reply that arrives after Stop, closing the view or switching maps changes nothing.
          const alive = (): boolean =>
            !this.ports.closed() &&
            !turnController.signal.aborted &&
            this.controller === turnController &&
            this.ports.path() === anchor.path;
          // A plan still waiting for its yes belongs to the question before this one.
          this.supersedeChatPlan();
          // The first message of a conversation moves the opening screen's panel into the side window.
          this.ports.relocate();
          // From here the request goes out: the bubble leaves "Preparing".
          chat.setStage("waiting");
          const modelName = this.ports.modelLabel(request.model);
          try {
            const outcome = await runAttempts<MapChatResult>({
              signal: turnController.signal,
              streamModeEndsResend: true,
              stopped: () => new Error(t("ui.ai_task_cancelled")),
              start: async attempt => {
                // Stop, a closed view or a map switch came between a resend and its request: nothing more is sent.
                if (!alive()) throw new Error(t("ui.ai_task_cancelled"));
                const live = (): boolean => alive() && attempt.live();
                // The slow notice counts from the start of the wait (the send, and each resend).
                attempt.arm();
                return this.ports.requestChat(
                  request,
                  attempt.signal,
                  text => {
                    if (!live()) return;
                    attempt.seen();
                    chat.streamReply(text);
                  },
                  event => {
                    if (!live()) return;
                    if (event.kind === "stream-mode") {
                      attempt.streamMode(event.mode);
                      steerState.steers.setLive(event.mode === "stream-json");
                      return;
                    }
                    // Claude's first event, and Codex's searching / reading / writing, are model events. Codex's `started` is not: the
                    // runtime sends it for any `item/*`, including the echo of our own prompt (`userMessage`, about 3 s in), so it
                    // proves nothing about the model. Codex text arrives through the reply callback above.
                    if (!(event.kind === "activity" && event.activity === "started")) attempt.seen();
                    // Codex says it is writing before its text can be shown; Claude's first event proves nothing about the stage.
                    if (event.kind === "activity" && event.activity === "writing") chat.setStage("writing");
                  },
                  handler => {
                    // A handler from a replaced or stopped attempt is not taken.
                    if (live()) steerState.steers.bind(handler);
                  },
                  // The model's raw output, kept for the record (only while the switch is on, and never from a stopped or replaced attempt).
                  record
                    ? raw => {
                        if (live()) record.raw = raw;
                      }
                    : undefined
                );
              },
              onSlow: (_attempt, resend) => {
                if (alive())
                  chat.showSlow(t("ui.map_chat_slow_0", modelName), () => {
                    if (alive()) resend();
                  });
              },
              onCleared: () => {
                if (alive()) chat.clearSlow();
              },
              onResend: () => {
                record?.event("resend");
                // Follow-ups typed before the new attempt hands out its handler wait for it; they are not for the old one.
                steerState.steers.drop();
                chat.restartWaiting();
              }
            });
            if (!alive()) return;
            // The provider sent back the reply's actions (format check) and took one with none: the reply's own words about why
            // (a model may claim a filter blocked it) are replaced by the real cause, on screen and in the history the next round reads.
            // The empty targets are resolved once, here: the plan gate judges these actions and the same ones are applied, so
            // research never runs on a live selection the gate did not check (a select_topics that partly fails changes nothing).
            // A video url in a research direction passes only when the user wrote it (this message, its follow-ups, earlier ones);
            // an automatic round's question is the plugin's text, not the user's.
            const userWords = [
              autoOrigin ? "" : origin.text,
              ...chat
                .transcript()
                .filter(item => item.role === "user" && !item.auto)
                .flatMap(item => [item.text, ...(item.steers ?? []).map(steer => steer.text)])
            ].join("\n");
            const result =
              outcome.droppedOnRetry && !outcome.actions.length
                ? { ...outcome, reply: t("ui.map_chat_reply_format_rejected") }
                : { ...outcome, actions: keepPastedVideoUrls(resolveSelectionTargets(outcome.actions), userWords) };
            // The research notes this request carried are "sent before" for the next round (they go last when the budget is short).
            // Only a reply that came back counts: a request that failed read nothing, so a retry still owes them.
            for (const id of request.context.research?.sent ?? []) this.ports.researchSent().add(id);
            // Follow-ups still being handed over settle first; later ones wait for the next message. The ones that went in are
            // part of the message the plan and the actions are applied for.
            await steerState.steers.close();
            if (!alive()) return;
            const fullMessage = [request.message, ...chat.takeSteerTexts()].join("\n\n");
            // The follow-ups that went into this round are part of the message every later round asks.
            run.message = fullMessage;
            run.replyRemaining = result.remaining;
            // The switch of the moment decides this round's plan (and the limits of the chain from here on).
            run.state = syncAutoApply(run.state, this.ports.autoApply());
            // Only a reply the user asked for writes at once (decision 2026-11-28-vam-v3-3#33). The user's round gives the verdict; an
            // automatic round reads the chain's (its question is the plugin's text, not the user's): a question's chain never writes.
            if (!autoOrigin) run.changeRequested = result.changeRequested === true;
            // Suggested relations (P4.4) always wait on a card: nothing is written until the user adopts one of them (the reply's
            // other actions then wait for Apply with them).
            const planOptions = { ...this.ports.planOptions(run, request), changeRequested: run.changeRequested };
            const plan =
              (result.actions.length ? planFor(result.actions, request.context, planOptions) : null) ??
              (result.suggestions?.length
                ? { reasons: [], estimatedCalls: estimateChatCalls(result.actions, request.context, planOptions) }
                : null);
            if (plan) {
              // Nothing is touched until the user applies the plan.
              if (chat.isBusy) {
                chat.finish(result.reply, []);
                if (result.comparison) chat.attachComparison(result.comparison, anchor);
                chat.setReplyBasis(turn, replyBasisOf(request.context.basis));
                this.showUnreadResearch(chat, turn, request.context);
                this.ports.markTurn(origin, request);
                // The continuation stops where it is until the plan is applied (it goes on) or cancelled (it ends).
                run.state = pauseForPlan(run.state);
                this.offerChatPlan(
                  result,
                  plan,
                  request.context,
                  { path: anchor.path, id: anchor.id },
                  fullMessage,
                  record,
                  run
                );
                if (record?.end("plan", { reply: result.reply, lines: [], rejected: result.rejected }))
                  this.ports.markLogged(turn.assistant);
                // The plan waits for the user's yes: a message sent now would cancel it, so waiting follow-ups go back to the field.
                this.flushSteers(false);
              }
              return;
            }
            // A pure answer has nothing to apply: the reader is not told "applying" for it.
            if (result.actions.length) chat.setStage("applying");
            const work = newChatWork();
            run.work = work;
            const lines = await this.ports.applyActions(
              { ...result, message: fullMessage },
              request.context,
              alive,
              anchor,
              {
                context: request.context,
                work,
                continuation: Boolean(autoOrigin),
                chain: run
              }
            );
            if (alive() && chat.isBusy) {
              // Read at once: the next reply's step replaces `chatReplyEntry`.
              const entry = this.ports.replyEntry();
              const shown = chat.finish(result.reply, lines);
              if (result.comparison) chat.attachComparison(result.comparison, anchor);
              chat.setReplyBasis(turn, replyBasisOf(request.context.basis));
              this.showUnreadResearch(chat, turn, request.context);
              this.ports.markTurn(origin, request, entry);
              if (record?.end("done", { reply: result.reply, lines: shown, rejected: result.rejected }))
                this.ports.markLogged(turn.assistant);
              // The round is over: the continuation goes on, waits or ends; follow-ups that waited are the next message instead.
              this.ports.chain().finishChatRound(run, { result, context: request.context, lines, work, anchor });
            }
            return;
          } catch (error) {
            if (alive()) {
              const failure = this.ports.errorText(error);
              chat.fail(failure.text, failure.wrapped ? failure.text : undefined, failure.technical);
              record?.end("failed", {
                reason: /time(d)?[\s-]?out/i.test(errorMessage(error)) ? "timeout" : "error",
                reply: failure.text,
                lines: [],
                error: { text: failure.text, technical: failure.technical ?? "" }
              });
              this.returnSteers(steerState);
              if (!this.ports.chain().retryAutoRound(run, origin)) this.ports.chain().interruptChain(run, "failed");
            }
            return;
          } finally {
            if (this.controller === turnController) this.releaseChatTask();
          }
        },
        // The usage notice opens: the bubble and an empty canvas say the send waits for the user, not that a map is being built.
        {
          noticeOpening: () => {
            if (preparingCurrent()) chat.setStage("consent");
          }
        }
      );
    } catch (error) {
      // Only a failure before the request went out is taken back; once sent, the turn reports its own failures.
      if (sent) throw error;
      abandon(this.ports.closed() ? undefined : errorMessage(error), "failed");
      return;
    }
    // The AI is not ready (it said why itself) or the usage notice was declined.
    if (!went && !sent) abandon(this.ports.closed() ? undefined : notSent(), "not_ready");
  }
  /** Research notes of the conversation that this round did not read (no room, or too long) are told under its results. */
  private showUnreadResearch(
    chat: ChatTurnPanel,
    turn: MapChatTurnHandle,
    context: Pick<MapChatContext, "research">
  ): void {
    // A note read in an earlier round only did not fit again: it is not unread, so the screen does not say "next round".
    const deferred = (context.research?.deferred ?? []).filter(note => !note.sentBefore);
    if (deferred.length)
      chat.setUnreadNotes(
        turn,
        deferred.map(note => ({ title: note.title, oversize: note.oversize === true }))
      );
  }
  /** Enter with text while the AI works: the text goes into the running turn, or waits for the turn to end. */
  steerMapChat(): void {
    const chat = this.ports.panel();
    if (!chat || this.ports.closed()) return;
    const text = chat.draft.trim();
    if (!text) return;
    const state = this.steer;
    if (state && chat.isBusy && chat.hasTurn(state.turn)) {
      const steer = chat.addSteer(text, state.steers.waits ? "queued" : "live");
      if (!steer) return;
      state.rows.set(state.steers.add(text), steer);
      return;
    }
    // The reply is in and its actions (or a plan, a choice) are being applied: the follow-up is the next message.
    if (chat.isBusy || this.applying) chat.addSteer(text, "queued");
  }
  /** The turn stopped or failed: follow-ups that did not go in are not sent; they are in the field again. */
  private returnSteers(state: NonNullable<typeof this.steer>): void {
    const chat = this.ports.panel();
    if (chat)
      for (const [entry, row] of state.rows) if (entry.state !== "delivered") chat.setSteerState(row, "queued", false);
    state.steers.abandon();
    chat?.restoreDraft(chat.takeQueued());
  }
  /** Follow-ups that waited become one new message (sent once), or, when it cannot be sent now, go back into the field. */
  flushSteers(send: boolean): void {
    const chat = this.ports.panel();
    if (!chat) return;
    const texts = chat.takeQueued();
    if (!texts.length) return;
    if (!send || this.ports.closed() || chat.isBusy || this.applying || !this.ports.map()) {
      chat.restoreDraft(texts);
      return;
    }
    const imageId = this.ports.imageId();
    void this.ports.send(
      {
        text: texts.join("\n\n"),
        chips: [],
        selectedIds: this.ports.selectionIds(),
        ...(imageId ? { imageId } : {})
      },
      texts.join("\n")
    );
  }
  releaseChatTask(): void {
    if (this.taskKey) this.ports.unregisterTask(this.taskKey);
    this.taskKey = null;
    this.controller = null;
  }
  /** Stop button: the request is aborted and whatever came back is dropped. */
  stopMapChat(): void {
    const run = this.ports.chain().current;
    // Waiting for the research or expansions of a continuation: no request runs. Stop ends the wait and the work the chain started;
    // what was written stays.
    if (run?.state.phase === "waiting") {
      this.ports.chain().stopChainWork(run);
      this.ports.chain().interruptChain(run, "stopped");
      this.ports.panel()?.focusInput();
      return;
    }
    // A plan being applied has no request to abort: the plan's number moves on, what is done stays and the rest is skipped.
    if (this.applying && !this.controller) {
      this.planToken++;
      this.planStopped = true;
      if (run && this.ports.chain().chainShows(run)) this.ports.chain().stopChainWork(run);
      this.ports.panel()?.focusInput();
      return;
    }
    const controller = this.controller;
    if (!controller) {
      this.prepAbandon?.();
      this.ports.panel()?.focusInput();
      return;
    }
    // A reply of a continuation that already started research or expansions: Stop stops those too.
    if (run && this.ports.chain().chainShows(run)) this.ports.chain().stopChainWork(run);
    this.releaseChatTask();
    controller.abort();
    // Before the panel marks the answer stopped: the record keeps the text that had streamed in.
    this.ports.endRecord("stopped");
    this.ports.panel()?.markStopped();
    this.ports.chain().interruptChain(run, "stopped");
    // Follow-ups that did not go in are not sent after a stop: they are in the field again.
    if (this.steer) this.returnSteers(this.steer);
    this.ports.panel()?.focusInput();
  }
}
