import { MAP_CHAT_AUTO_MAX_CALLS, type MapChatChainInterrupt } from "../../core/map-chat-chain";
import type { MapChatContext } from "../../core/map-chat-context";
import { CHAT_PLAN_GROUP_ORDER, chatPlanGroupOf } from "../../core/map-chat-layout";
import { researchTargetsOf, type MapChatPlan, type MapChatPlanReason } from "../../core/map-chat-plan";
import type { MapChatResult } from "../../core/map-chat-service";
import type { MapChatAction } from "../../core/steps/map-chat/step";
import { t } from "../../i18n";
import type { MapDocument } from "../../map-model";
import type { MapChatLine, MapChatPanel, MapChatPlanCard } from "./map-chat";
import { newChatWork, type ChatChainRun, type ChatRoundEnd, type ChatRoundWork } from "./map-chat-chain-run";
import type { MapChatTurnRecord } from "./map-chat-turn-record";

function errorMessage(error: unknown): string {
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === "string" ? message : String(error);
}

/** The part of the chat window the plan flow uses. */
export type ChatPlanPanel = Pick<
  MapChatPanel,
  "isBusy" | "pendingPlan" | "settlePlan" | "showPlan" | "setApplying" | "hasQueuedSteers"
>;
/** One anchor a pending plan would place (drawn as a dashed dot). */
export interface ChatPreviewAnchor {
  imageId: string;
  x: number;
  y: number;
  note: string;
}
/** What applying a plan is given beyond the reply: the context the basis is judged by and where the started work is collected. */
export interface ChatPlanApplyOptions {
  context: Pick<MapChatContext, "basis" | "parents">;
  work: ChatRoundWork;
  continuation: boolean;
  chain: ChatChainRun | null;
}
/** What the plan flow needs of the view; every port is read at call time. */
export interface MapChatConversationPorts {
  panel(): ChatPlanPanel | null;
  closed(): boolean;
  path(): string;
  map(): Pick<MapDocument, "id"> | null;
  chain(): {
    interruptChain(run: ChatChainRun | null, reason: MapChatChainInterrupt): void;
    chainShows(run: ChatChainRun): boolean;
    stopChainWork(run: ChatChainRun): void;
    advanceChain(run: ChatChainRun, round: ChatRoundEnd): void;
  };
  plans(): WeakMap<MapChatPlanCard, MapChatTurnRecord>;
  /** Draws the plan's anchors as dashed dots (an empty list clears them), only while `token` is the plan's current one. */
  showPreview(token: number, anchors: ChatPreviewAnchor[]): void;
  clearPreview(): void;
  refTitles(actions: readonly MapChatAction[]): Map<string, string>;
  actionLabel(action: MapChatAction, refTitles?: ReadonlyMap<string, string>): string;
  applyActions(
    result: MapChatResult & { message?: string },
    baseline: PlanBaseline,
    alive: () => boolean,
    anchor: { path: string; id: string | undefined },
    options: ChatPlanApplyOptions
  ): Promise<MapChatLine[]>;
  flushSteers(send: boolean): void;
}
type PlanBaseline = Pick<
  MapChatContext,
  "mdHashes" | "topicHashes" | "selectedCount" | "basis" | "parents" | "research" | "mapSourcePaths"
>;

/** The plan flow of the map chat: the plan card under an answer, what Apply and Cancel do, and the state they share with Stop. */
export class MapChatConversation {
  /** True while a confirmed plan is being applied; no new message is sent meanwhile. */
  applying = false;
  /** Stop was pressed while a plan was applying: the plan line says so. */
  planStopped = false;
  /** Counts plans: a plan card only works while its number is the current one (a new message, another map or closing ends it). */
  planToken = 0;

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
    this.ports.showPreview(token, anchorsToPlace);
    const refTitles = this.ports.refTitles(result.actions);
    // A read_md_file is never shown (decision 2026-11-15-map-chat-file-bugs#2), on the plan card as in the result lines.
    const shown = result.actions.flatMap((action, index) => (action.kind === "read_md_file" ? [] : [index]));
    const items = shown.map(index => this.ports.actionLabel(result.actions[index], refTitles));
    // The same lines by kind of work, so a 100-action plan reads as five folded lists.
    const groups = CHAT_PLAN_GROUP_ORDER.flatMap(group => {
      const own = items.filter((_, at) => chatPlanGroupOf(result.actions[shown[at]].kind) === group);
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
    const card: MapChatPlanCard = {
      // A plan about a picture shows its lists open: the user checks the anchors before they apply them.
      ...(plan.reasons.some(reason => reason === "image_preview" || reason === "image_other_actions")
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
  async applyChatPlan(
    card: MapChatPlanCard,
    token: number,
    result: MapChatResult & { message?: string },
    baseline: PlanBaseline,
    anchor: { path: string; id: string | undefined },
    run: ChatChainRun | null = null
  ): Promise<void> {
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
    this.applying = true;
    this.planStopped = false;
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
      this.ports.flushSteers(!stopped());
    }
  }
}
