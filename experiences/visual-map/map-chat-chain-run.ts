import {
  MAP_CHAT_AUTO_MAX_CALLS,
  MAP_CHAT_AUTO_MAX_ROUNDS,
  MAP_CHAT_CHAIN_MAX_ROUNDS,
  MAP_CHAT_CHAIN_WAIT_MS,
  chainEndNeedsNotice,
  finishRound,
  finishWait,
  resumeRound,
  interrupt as interruptChainState,
  resumedChain,
  startAutoChain,
  startChain,
  syncAutoApply,
  type MapChatChainDecision,
  type MapChatChainEndReason,
  type MapChatChainInterrupt,
  type MapChatChainState,
  type MapChatWaitEnd
} from "../../core/map-chat-chain";
import { pendingResearchCount, type MapChatContext, type MapChatContinuationInput } from "../../core/map-chat-context";
import type { MapChatResult } from "../../core/map-chat-service";
import type { MapChatAction } from "../../core/steps/map-chat/step";
import { estimateChatCalls, researchTargetsOf } from "../../core/map-chat-plan";
import { t } from "../../i18n";
import type { MapDocument } from "../../map-model";
import {
  chatResultLines,
  type MapChatChainOrigin,
  type MapChatChip,
  type MapChatLine,
  type MapChatMessage,
  type MapChatOrigin,
  type MapChatPanel,
  type MapChatTurnHandle
} from "./map-chat";
import type { MapChatTurnRecord } from "./map-chat-turn-record";

/** One card of research or expansion work a continuation waited for, and how it came out. */
export interface ChatWorkTopic {
  id: string;
  title: string;
  status: "succeeded" | "failed" | "stopped";
  error?: string;
}
/** How a research batch that the chat started came out. Told exactly once, whichever way the batch ends (or never starts). */
export type ChatResearchOutcome =
  | { kind: "not_started" }
  | { kind: "settled"; succeeded: number; failed: number; stopped: number; topics: ChatWorkTopic[] };
/** How one expansion the chat started came out. */
export type ChatExpandOutcome =
  { status: "succeeded"; titles: string[] } | { status: "failed"; reason: string } | { status: "stopped" };
/** The work one reply started that a continuation may wait for, and the handle that stops it. */
export interface ChatRoundWork {
  /** Aborted by Stop: work not started yet is not started, and a running expansion stops. */
  controller: AbortController;
  /** One promise per research action, each settling once. */
  research: Promise<ChatResearchOutcome>[];
  researchTargets: number;
  /** The batch keys (one per map) of the research, to stop what is running. */
  researchKeys: Set<string>;
  /** Ids of the cards the round created (the chain keeps them: its later rounds may rewrite and research those without a plan). */
  created: string[];
  expand: { id: string; title: string; path: string; done: Promise<ChatExpandOutcome> }[];
  /**
   * The picture a `place_image` of the round is fetching and putting on the canvas: the id of the new item, or null when it did not
   * work out (it never rejects in the view's hands; a rejection is read as null). The chain waits for it and sends it with the next round.
   */
  canvasImage?: Promise<string | null> | null;
  /** An integration, a merge or a rating started: a continuation does not wait for these and ends. */
  otherBackground: boolean;
  /** The cards a select_topics of the round selected (the chain keeps them for its later rounds). */
  selected?: string[];
  /** Positions of the `read_md_file` actions of the round that were accepted (they have no result line; the chain goes on for them). */
  reads: Set<number>;
}
export const newChatWork = (): ChatRoundWork => ({
  controller: new AbortController(),
  research: [],
  researchTargets: 0,
  researchKeys: new Set(),
  created: [],
  expand: [],
  canvasImage: null,
  otherBackground: false,
  reads: new Set()
});
/** What a finished round hands to its chain: the reply, what was applied, and the work it started. */
export interface ChatRoundEnd {
  result: MapChatResult;
  context: Pick<MapChatContext, "research" | "selectedCount">;
  lines: MapChatLine[];
  work: ChatRoundWork;
  anchor: { path: string; id: string | undefined };
}
/** One automatic continuation of a chat message, owned by the view (at most one). Lives in memory only. */
export interface ChatChainRun {
  /** Tells this chain from an earlier one in a late event or a retry. */
  seq: number;
  state: MapChatChainState;
  /** The map the chain belongs to; a create or open the chain performs moves it. */
  anchor: { path: string; id: string | undefined };
  /** The message every round asks: the user's words plus the follow-ups that went into earlier rounds. */
  message: string;
  /** The turn of the round in flight, or of the last one. */
  turn: MapChatTurnHandle | null;
  record: MapChatTurnRecord | null;
  /** What the latest reply said was still to do (known before the round has ended). */
  replyRemaining: string;
  lastResults: MapChatContinuationInput["lastResults"];
  /** Cards the chain's rounds created so far (real ids). */
  createdIds: Set<string>;
  /** The chips of the user's message (not the follow-ups'): every round of the chain is built with them. */
  chips: MapChatChip[];
  /** What the work waited for came to, for the next round. */
  waited: MapChatContinuationInput["research"];
  /** Lines about failed work, for the notice at the end. */
  details: string[];
  /** Research that went on after some of it failed (the next round says so on its separator). */
  partial: { failed: number; succeeded: number } | null;
  work: ChatRoundWork | null;
  /**
   * The picture this chain's own `place_image` put on the canvas, set when the wait for it ends. The next round sends it once (it is
   * deleted as that round is built): never the user's selection, and never a later round.
   */
  attachImageId?: string;
  timer: number | null;
  /** The panel was told that the chain waits (and must be told that it does not). */
  waitShown: boolean;
  /** The cards the AI selected in a round of this chain (null: it never selected); later rounds read these. */
  aiSelection: string[] | null;
  /** What was still to do when the current round began (a resume that redoes the round starts from it). */
  roundRemaining: string;
  /** Auto-apply chain: vault paths already backed up in this chain (once per file per chain). */
  backedUp: Set<string>;
  /** Auto-apply chain: vault paths (md files, Map.md of a new map) the chain created itself; they have nothing to back up. */
  createdFiles: Set<string>;
  /** Auto-apply chain: the round that was already retried once after a failure (a second failure ends the chain). */
  retriedRound: number | null;
  /** Auto-apply chain: what the last applied round did directly ("research 12, ..."), shown on the next round's separator. */
  appliedText: string;
  /**
   * The user asked for changes (decision 2026-11-28-vam-v3-3#33): the verdict of the user's own round, or true once the user applied a
   * plan card. Automatic rounds read it; a question's chain never writes on its own.
   */
  changeRequested: boolean;
}
/** The lines of research and expansions that did not work out, one line each, for the end notice of a chain. */
export const chainWorkDetail = (item: { title: string; status: string; error?: string }): string =>
  item.error ? `${item.title}: ${item.error}` : item.title;

/** What the chain needs from the panel (the window's side of the continuation). */
export type ChatChainPanel = Pick<
  MapChatPanel,
  | "isBusy"
  | "resumePoint"
  | "dropResume"
  | "conversationId"
  | "setChainWaiting"
  | "endChain"
  | "offerResume"
  | "hasTurn"
  | "hasQueuedSteers"
  | "setFlowProgress"
>;
/** What the chain needs from the view; it never reaches for the plugin, the vault or the view's other state itself. */
export interface MapChatChainPorts {
  /** The chat panel; null when it is not built. */
  panel(): ChatChainPanel | null;
  /** The view is closed. */
  closed(): boolean;
  /** A confirmed plan is being applied. */
  applying(): boolean;
  /** The notes of the map are loading. */
  notesLoading(): boolean;
  /** The path of the map the view shows. */
  path(): string;
  map(): Pick<MapDocument, "id" | "aiMode" | "nodes"> | null;
  /** The cards selected on the canvas of the moment. */
  selectionIds(): string[];
  /** The canvas picture `id` is still an annotated image of the map (a deleted or replaced one is not sent). Absent = the next round's own check decides. */
  imageExists?(id: string): boolean;
  /** "Apply this whole conversation automatically" is on (read live). */
  autoApply(): boolean;
  /** The setting that adds diagrams after research. */
  diagrams(): boolean;
  /** The record of the newest turn. */
  lastRecord(): MapChatTurnRecord | null;
  /** Stops the research batch `key`. */
  stopResearch(key: string): void;
  flushSteers(send: boolean): void;
  /** Sends a round; read at call time from the view's own send, whose failure notice is the view's. */
  send(again: MapChatOrigin, restore?: string, retryOf?: ChatChainRun): void;
}

/**
 * The automatic continuation of a chat message (the chain): its run and sequence number, how a round is taken up, retried, resumed,
 * waited for (research, expansions, the 30 minutes), ended and shown. Lives and dies with the view that owns it; at most one chain.
 */
export class MapChatChainRunner {
  /** The automatic continuation of the latest message (running, waiting for work or for a plan); null when there is none. */
  current: ChatChainRun | null = null;
  seq = 0;

  constructor(private readonly ports: MapChatChainPorts) {}

  /**
   * The chain a round belongs to. A message of the user's starts a new one (round 1); an automatic round goes on with the chain it
   * came from. A retry of a failed automatic round finds no live chain (it ended as `failed`) and takes the round again from the
   * state saved in its origin, without counting it twice.
   */
  chainForRound(
    origin: MapChatChainOrigin | undefined,
    anchor: { path: string; id: string | undefined },
    message: string
  ): ChatChainRun {
    const live = this.current;
    if (origin && live && live.seq === origin.seq && live.state.phase === "round") {
      live.anchor = anchor;
      live.message = message;
      live.replyRemaining = origin.continuation.remaining;
      live.roundRemaining = origin.continuation.remaining;
      return live;
    }
    // A retry of an old failed round while another chain is still alive (waiting, with its timer): that chain ends first.
    if (live) this.interruptChain(live, "user_took_over");
    const run: ChatChainRun = {
      seq: ++this.seq,
      state: origin ? { ...origin.state, phase: "round" } : this.ports.autoApply() ? startAutoChain() : startChain(),
      anchor,
      message,
      turn: null,
      record: null,
      replyRemaining: origin?.continuation.remaining ?? "",
      lastResults: origin?.continuation.lastResults ?? [],
      createdIds: new Set(origin?.createdIds ?? []),
      chips: [],
      waited: origin?.continuation.research ?? [],
      details: [],
      partial: null,
      work: null,
      timer: null,
      waitShown: false,
      aiSelection: origin?.aiSelection ? [...origin.aiSelection] : null,
      roundRemaining: origin?.continuation.remaining ?? "",
      backedUp: new Set(),
      createdFiles: new Set(),
      retriedRound: null,
      appliedText: "",
      changeRequested: origin?.changeRequested === true
    };
    this.current = run;
    return run;
  }
  /**
   * A round of an auto-apply chain failed (provider timeout, transient or format failure): the same round is sent once more, at once,
   * counting as one more call of the chain. Only the live, un-stopped chain of this round is retried (a Stop or a new message has
   * already ended it); a second failure of the round ends the chain as `failed` as usual. Returns whether a retry was started.
   */
  retryAutoRound(run: ChatChainRun, origin: MapChatOrigin): boolean {
    // The switch is read live (run.state.autoApply lags it); the retry is only started when sendMapChat would really send it.
    if (
      !this.ports.autoApply() ||
      run.retriedRound === run.state.round ||
      this.current !== run ||
      run.state.phase !== "round" ||
      this.ports.closed() ||
      this.ports.applying() ||
      !this.ports.map() ||
      this.ports.notesLoading() ||
      !origin.text
    )
      return false;
    run.retriedRound = run.state.round;
    run.state = { ...run.state, calls: run.state.calls + 1 };
    this.ports.send({ ...origin }, undefined, run);
    return true;
  }
  /** The cards of an earlier AI selection that are still on the map. */
  private chainSelection(ids: string[]): string[] {
    const map = this.ports.map();
    return map ? ids.filter(id => map.nodes.some(node => node.id === id)) : [];
  }
  /**
   * Sends the round after an interrupted chain (the button under the last reply, or the word "continue"). Every guard that fails
   * leaves the resume point where it is; once it passes the point is used up before anything is sent, so a second press sends nothing.
   */
  resumeChatChain(message: MapChatMessage): boolean {
    const chat = this.ports.panel();
    const point = message.resume;
    if (
      !chat ||
      !point ||
      chat.isBusy ||
      this.ports.applying() ||
      this.ports.closed() ||
      !this.ports.map() ||
      this.ports.notesLoading() ||
      this.current ||
      point !== chat.resumePoint() ||
      point.conversationId !== chat.conversationId
    )
      return false;
    chat.dropResume(point);
    const selected = this.chainSelection(point.selectedIds);
    const origin: MapChatOrigin = {
      text: point.message,
      chips: [],
      selectedIds: selected.length ? selected : this.ports.selectionIds(),
      chain: {
        seq: 0,
        resumed: true,
        // A point restored from the file has no verdict: its writes wait as a plan.
        ...(point.changeRequested ? { changeRequested: true as const } : {}),
        ...(selected.length ? { aiSelection: selected } : {}),
        // The toggle of the moment (never the saved one) decides the segment: a reload leaves it off.
        state: resumedChain({ ...point, maxRounds: this.resumeSegmentEnd(point.round) }, this.ports.autoApply()),
        createdIds: [],
        continuation: {
          round: point.round,
          maxRounds: point.maxRounds,
          remaining: point.remaining,
          lastResults: point.lastResults,
          research: [],
          ...(point.progress ? { progress: point.progress } : {})
        }
      }
    };
    this.ports.send(origin);
    return true;
  }
  /** The last round of the segment a resumed chain starts at `round`, by the toggle of the moment (60-round segments when on, 8 when off). */
  private resumeSegmentEnd(round: number): number {
    const segment = this.ports.autoApply() ? MAP_CHAT_AUTO_MAX_ROUNDS : MAP_CHAT_CHAIN_MAX_ROUNDS;
    return segment * Math.ceil(round / segment);
  }
  /** The continuation is more than a single answer (a later round, or one that said something was left): its end is told and recorded. */
  chainShows(run: ChatChainRun): boolean {
    return run.state.round >= 2 || !!run.replyRemaining || !!run.state.remaining;
  }
  /** Ends the chain from the outside (Stop, a new message, a failure, a map change): the first ending wins, a later one changes nothing. */
  interruptChain(run: ChatChainRun | null, reason: MapChatChainInterrupt): void {
    if (!run) return;
    const step = interruptChainState(run.state, reason);
    if (step.decision.kind !== "end") return;
    // Waiting for the work means the round's reply was applied; any earlier phase means it was not.
    const applied = run.state.phase === "waiting";
    run.state = step.state;
    this.endChatChain(run, reason, run.replyRemaining || step.decision.remaining, applied);
  }
  /** The chain is over: its timer and wait go, the end is recorded, and (unless it simply finished) the panel says why. */
  endChatChain(run: ChatChainRun, reason: MapChatChainEndReason, remaining: string, applied = true): void {
    if (this.current === run) this.current = null;
    if (run.timer !== null) window.clearTimeout(run.timer);
    run.timer = null;
    run.state = { ...run.state, phase: "ended" };
    if (this.ports.closed()) return;
    const chat = this.ports.panel();
    if (run.waitShown) chat?.setChainWaiting(null);
    run.waitShown = false;
    if (!this.chainShows(run)) return;
    // The AI calls of the segment are counted and told only for an auto-apply chain.
    const calls = run.state.autoApply ? run.state.calls : undefined;
    this.ports.lastRecord()?.event("chain_end", {
      reason,
      round: run.state.round,
      remaining,
      ...(calls === undefined ? {} : { calls })
    });
    // "Done" is told only to a chain that went on by itself (round 2 on): a single round that finished adds nothing.
    if (chat && (chainEndNeedsNotice(reason) || (reason === "done" && run.state.round >= 2))) {
      // A failed round has its Retry button; the rest of the ends that can go on offer the next round.
      const next =
        reason === "failed"
          ? null
          : resumeRound(
              {
                reason,
                round: run.state.round,
                applied,
                startRemaining: run.roundRemaining,
                replyRemaining: remaining
              },
              run.state.autoApply ? MAP_CHAT_AUTO_MAX_ROUNDS : MAP_CHAT_CHAIN_MAX_ROUNDS
            );
      const details = run.details.length ? run.details : undefined;
      if (calls === undefined) chat.endChain(reason, remaining, details);
      else chat.endChain(reason, remaining, details, calls);
      if (next)
        chat.offerResume({
          ...next,
          ...(run.state.progress ? { progress: run.state.progress } : {}),
          stoppedRound: run.state.round,
          reason,
          message: run.message,
          ...(run.changeRequested ? { changeRequested: true as const } : {}),
          selectedIds: run.aiSelection ? [...run.aiSelection] : [],
          lastResults: run.lastResults.map(line => ({ text: line.text, status: line.status }))
        });
    }
  }
  /** Stop on a continuation: what the chain started and still runs (research, expansions) stops; what was written stays. */
  stopChainWork(run: ChatChainRun): void {
    const work = run.work;
    if (!work) return;
    // The controller reaches the expansions (chatExpand listens to it) and the research that has not started.
    work.controller.abort();
    for (const key of work.researchKeys) this.ports.stopResearch(key);
  }
  /** A round ended with its reply applied (or its plan): the chain goes on, waits or ends, unless the user spoke meanwhile. */
  finishChatRound(run: ChatChainRun, round: ChatRoundEnd): void {
    // Follow-ups that waited are the user speaking: the chain ends and they are sent once as the next message.
    if (this.ports.panel()?.hasQueuedSteers()) this.interruptChain(run, "user_took_over");
    else this.advanceChain(run, round);
    this.ports.flushSteers(true);
  }
  advanceChain(run: ChatChainRun, round: ChatRoundEnd): void {
    if (this.current !== run || run.state.phase === "ended") return;
    run.partial = null;
    for (const id of round.work.created) run.createdIds.add(id);
    if (round.work.selected) run.aiSelection = [...round.work.selected];
    run.lastResults = chatResultLines(round.lines).map(line => ({ text: line.text, status: line.status }));
    run.anchor = { path: round.anchor.path, id: round.anchor.id };
    // The switch of the moment decides the limits of the segment from here on.
    run.state = syncAutoApply(run.state, this.ports.autoApply());
    const appliedActions = round.result.actions.filter((_, index) => round.lines[index]?.status === "done");
    run.appliedText = run.state.autoApply ? this.appliedDirectlyText(appliedActions, round.context.selectedCount) : "";
    const step = finishRound(run.state, {
      // The round's own request plus the AI calls its applied actions started (counted for the auto-apply limit).
      calls:
        1 +
        estimateChatCalls(appliedActions, round.context, {
          diagrams: this.ports.diagrams(),
          mapAiMode: this.ports.map()?.aiMode
        }),
      progress: round.result.progress ?? null,
      ...(round.result.droppedOnRetry ? { droppedOnRetry: true } : {}),
      remaining: round.result.remaining,
      researchDeferred: pendingResearchCount(round.context),
      // A read has no line of its own: the lines are the other actions', in order.
      actions: round.result.actions.map((action, index) => ({
        kind: action.kind,
        done:
          action.kind === "read_md_file"
            ? round.work.reads.has(index)
            : round.lines[round.result.actions.slice(0, index).filter(other => other.kind !== "read_md_file").length]
                ?.status === "done"
      })),
      started: {
        research: round.work.researchTargets,
        expand: round.work.expand.length,
        image: round.work.canvasImage ? 1 : 0,
        otherBackground: round.work.otherBackground
      }
    });
    run.state = step.state;
    this.showChainFlow(
      run,
      step.decision.kind === "end" && step.decision.reason === "done" && !step.decision.remaining.trim()
    );
    this.followChainDecision(run, step.decision, round.work);
  }
  /**
   * The whole-flow block follows the chain: only an auto-apply chain shows it (the panel hides it for fewer than two steps). A chain
   * that ended done with nothing left shows every step done, even when the last reply did not move the statuses.
   */
  private showChainFlow(run: ChatChainRun, finished = false): void {
    const progress = run.state.progress;
    if (!run.state.autoApply || !progress) return;
    this.ports.panel()?.setFlowProgress({
      steps: progress.steps.map(step => ({ ...step, ...(finished ? { status: "done" as const } : {}) })),
      round: run.state.round,
      calls: run.state.calls,
      maxCalls: MAP_CHAT_AUTO_MAX_CALLS
    });
  }
  /** "research 12, rewritten summaries 12, updated notes 3": what an auto-apply round did without asking (empty: nothing of these). */
  private appliedDirectlyText(actions: readonly MapChatAction[], selectedCount: number): string {
    const research = researchTargetsOf(actions, selectedCount);
    const summaries = actions.filter(action => action.kind === "update_summary").length;
    const notes = actions.filter(
      action => action.kind === "edit_topic_note" || action.kind === "edit_md_file" || action.kind === "create_md_file"
    ).length;
    const parts = [
      research ? t("ui.map_chat_auto_applied_research_0", research) : "",
      summaries ? t("ui.map_chat_auto_applied_summary_0", summaries) : "",
      notes ? t("ui.map_chat_auto_applied_notes_0", notes) : ""
    ].filter(Boolean);
    return parts.join(t("ui.map_chat_chain_detail_separator"));
  }
  private followChainDecision(run: ChatChainRun, decision: MapChatChainDecision, work: ChatRoundWork | null): void {
    if (decision.kind === "end") this.endChatChain(run, decision.reason, decision.remaining);
    else if (decision.kind === "wait" && work) this.waitForChain(run, decision.waitFor, work);
    else if (decision.kind === "next") this.startNextRound(run, decision.round, decision.remaining);
  }
  /** Waits for the research and expansions the round started; the 30 minutes only end the chain, never the work (auto-apply: 30 minutes with none finishing). */
  private waitForChain(run: ChatChainRun, waitFor: ("research" | "expand" | "image")[], work: ChatRoundWork): void {
    const chat = this.ports.panel();
    const research = waitFor.includes("research") ? work.research : [];
    const expand = waitFor.includes("expand") ? work.expand : [];
    const image = waitFor.includes("image") ? (work.canvasImage ?? null) : null;
    const waiting = {
      kinds: waitFor,
      total: (research.length ? work.researchTargets : 0) + expand.length + (image ? 1 : 0),
      settled: 0
    };
    chat?.setChainWaiting(waiting, run.state.remaining);
    run.waitShown = true;
    const progress = (by: number): void => {
      if (this.current !== run || run.state.phase !== "waiting") return;
      waiting.settled = Math.min(waiting.total, waiting.settled + by);
      this.ports.panel()?.setChainWaiting(waiting, run.state.remaining);
      // Auto-apply: the 30 minutes count from the last research or expansion that finished, not from the start of the wait.
      if (this.ports.autoApply()) {
        if (run.timer !== null) window.clearTimeout(run.timer);
        arm();
      }
    };
    const arm = (): void => {
      run.timer = window.setTimeout(() => {
        run.timer = null;
        this.settleChainWait(run, { timedOut: true }, []);
      }, MAP_CHAT_CHAIN_WAIT_MS);
    };
    arm();
    let researched: ChatResearchOutcome | undefined;
    const waited: ChatWorkTopic[] = [];
    let expandSucceeded = 0;
    let expandFailed = 0;
    const pending: Promise<void>[] = [];
    if (research.length)
      pending.push(
        Promise.all(research).then(outcomes => {
          const settled = outcomes.flatMap(outcome => (outcome.kind === "settled" ? [outcome] : []));
          researched = settled.length
            ? {
                kind: "settled",
                succeeded: settled.reduce((sum, outcome) => sum + outcome.succeeded, 0),
                failed: settled.reduce((sum, outcome) => sum + outcome.failed, 0),
                stopped: settled.reduce((sum, outcome) => sum + outcome.stopped, 0),
                topics: settled.flatMap(outcome => outcome.topics)
              }
            : { kind: "not_started" };
          if (researched.kind === "settled") waited.push(...researched.topics);
          progress(work.researchTargets);
        })
      );
    for (const item of expand)
      pending.push(
        item.done.then(outcome => {
          if (outcome.status === "succeeded") expandSucceeded++;
          else if (outcome.status === "failed") expandFailed++;
          waited.push({
            id: item.id,
            title: item.title,
            status: outcome.status,
            ...(outcome.status === "failed" ? { error: outcome.reason } : {})
          });
          progress(1);
        })
      );
    // A placement that failed (null) or threw goes on without a picture.
    let placed: string | null = null;
    if (image)
      pending.push(
        image
          .then(
            id => id,
            () => null
          )
          .then(id => {
            placed = id;
            progress(1);
          })
      );
    void Promise.all(pending).then(() =>
      this.settleChainWait(
        run,
        {
          ...(researched ? { research: researched } : {}),
          ...(expand.length ? { expand: { succeeded: expandSucceeded, failed: expandFailed } } : {})
        },
        waited,
        placed
      )
    );
  }
  /** What the chain waited for is over (or the 30 minutes are). A late or repeated call, for a chain that has moved on, changes nothing. */
  private settleChainWait(
    run: ChatChainRun,
    end: MapChatWaitEnd,
    waited: ChatWorkTopic[],
    placedImageId: string | null = null
  ): void {
    if (this.current !== run || run.state.phase !== "waiting") return;
    if (run.timer !== null) window.clearTimeout(run.timer);
    run.timer = null;
    const chat = this.ports.panel();
    if (
      this.ports.closed() ||
      !chat ||
      this.ports.path() !== run.anchor.path ||
      this.ports.map()?.id !== run.anchor.id ||
      (run.turn !== null && !chat.hasTurn(run.turn))
    ) {
      this.interruptChain(run, "map_changed");
      return;
    }
    chat.setChainWaiting(null);
    run.waitShown = false;
    // Only an id this chain's own wait handed over, and only for the round that follows at once.
    if (placedImageId) run.attachImageId = placedImageId;
    run.waited = waited.map(item => ({
      id: item.id,
      title: item.title,
      status: item.status,
      ...(item.error ? { error: item.error } : {})
    }));
    run.details = waited.filter(item => item.status !== "succeeded").map(chainWorkDetail);
    const step = finishWait(run.state, end);
    run.state = step.state;
    // Research that partly failed and goes on is told on the separator of the next round (it is not an ending).
    run.partial =
      step.decision.kind === "next" &&
      end.research?.kind === "settled" &&
      end.research.failed > 0 &&
      end.research.succeeded > 0
        ? { failed: end.research.failed, succeeded: end.research.succeeded }
        : null;
    this.followChainDecision(run, step.decision, null);
  }
  /** Round `round` of the chain begins now, as a message of its own: the same preparation, request, plan rules and apply as any send. */
  private startNextRound(run: ChatChainRun, round: number, remaining: string): void {
    // Used up whatever happens below: a round that is not sent never leaves the picture for a later one.
    const placed = run.attachImageId;
    run.attachImageId = undefined;
    const chat = this.ports.panel();
    if (
      this.ports.closed() ||
      !chat ||
      this.ports.path() !== run.anchor.path ||
      this.ports.map()?.id !== run.anchor.id ||
      (run.turn !== null && !chat.hasTurn(run.turn))
    ) {
      this.interruptChain(run, "map_changed");
      return;
    }
    if (chat.isBusy || this.ports.applying()) {
      this.interruptChain(run, "user_took_over");
      return;
    }
    const origin: MapChatOrigin = {
      text: run.message,
      // The chips of the user's message go with every round (the source of an attached file is what "each one" is checked against);
      // the user's picture is sent with the first round only, and a follow-up adds no chip. The picture this chain placed itself
      // goes with the next round once (a deleted one is left out).
      chips: [...run.chips],
      ...(placed && this.ports.imageExists?.(placed) !== false ? { imageId: placed } : {}),
      selectedIds: run.aiSelection ? this.chainSelection(run.aiSelection) : this.ports.selectionIds(),
      chain: {
        seq: run.seq,
        ...(run.changeRequested ? { changeRequested: true as const } : {}),
        ...(run.aiSelection ? { aiSelection: [...run.aiSelection] } : {}),
        state: run.state,
        createdIds: [...run.createdIds],
        continuation: {
          round,
          maxRounds: run.state.maxRounds,
          remaining,
          lastResults: run.lastResults,
          research: run.waited,
          ...(run.state.progress ? { progress: run.state.progress } : {}),
          ...(run.state.checkingDone ? { checkDone: true } : {})
        }
      }
    };
    run.work = null;
    this.ports.send(origin);
  }
}
