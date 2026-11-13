import type { MapChatAction } from "./steps/map-chat/step";
import type { MapChatPlanChain } from "./map-chat-plan";

/**
 * Automatic continuation of a map chat message ("chain"): a reply that says something is still to do (`remaining`) gets its next
 * round started by the program, after the research it started has finished. Pure state machine, no Obsidian: the view feeds it what
 * a round did and does what the decision says. Progress is judged here from facts, never asked of the model.
 */

/** Rounds in a chain, the first one included. A reply is at most 100 actions; a 38 + 29 card tree plus research takes about 4 rounds, so twice that. */
export const MAP_CHAT_CHAIN_MAX_ROUNDS = 8;
/** How long a chain waits for the research and expands it started; on expiry only the chain ends, the work goes on. */
export const MAP_CHAT_CHAIN_WAIT_MS = 30 * 60 * 1000;

export const MAP_CHAT_CHAIN_END_REASONS = [
  "done",
  "no_progress",
  "max_rounds",
  "stopped",
  "user_took_over",
  "plan_cancelled",
  "research_failed",
  "research_stopped",
  "research_not_started",
  "wait_timeout",
  "other_background_work",
  "failed",
  "not_ready",
  "map_changed"
] as const;
/** Why a chain ended. Every reason but `done` is told to the user with what was still to do. */
export type MapChatChainEndReason = (typeof MAP_CHAT_CHAIN_END_REASONS)[number];
/** The reasons only the outside can cause (a button, the user typing, a failure, a map change); the machine never picks them. */
export type MapChatChainInterrupt = Extract<
  MapChatChainEndReason,
  "stopped" | "user_took_over" | "plan_cancelled" | "failed" | "not_ready" | "map_changed"
>;
export const chainEndNeedsNotice = (reason: MapChatChainEndReason): boolean => reason !== "done";

/** What the chat panel shows of a chain (the view uses it; P4 implements it). `Origin` and `Turn` are the panel's own types. */
export interface MapChatChainWaiting {
  kinds: ("research" | "expand")[];
  total: number;
  settled: number;
}
export interface MapChatChainPanel<Origin = unknown, Turn = unknown> {
  beginAutoRound(round: number, maxRounds: number, remaining: string, origin: Origin): Turn;
  setChainWaiting(state: MapChatChainWaiting | null): void;
  endChain(reason: MapChatChainEndReason, remaining: string, details?: string[]): void;
}

/** Actions that change nothing on the map, so applying them is not progress. `run_map_action` counts through the work it was waited for. */
const NOT_A_WRITE: ReadonlySet<MapChatAction["kind"]> = new Set<MapChatAction["kind"]>([
  "focus_topic",
  "select_topics",
  "collapse_topic",
  "expand_topic",
  "auto_layout",
  "ask_topic_kind",
  "run_map_action"
]);
export interface MapChatRoundAction {
  kind: MapChatAction["kind"];
  /** Applied (not skipped, refused or failed). */
  done: boolean;
}
/** True when a `select_topics` was applied: the next round's context carries the selected cards' notes. */
export const selectedCards = (actions: readonly MapChatRoundAction[]): boolean =>
  actions.some(action => action.done && action.kind === "select_topics");
/** True when at least one action that writes (cards, notes, links, looks, maps) was applied in the round. */
export const wroteSomething = (actions: readonly MapChatRoundAction[]): boolean =>
  actions.some(action => action.done && !NOT_A_WRITE.has(action.kind));

export type MapChatChainPhase = "round" | "plan" | "waiting" | "ended";
export interface MapChatChainState {
  phase: MapChatChainPhase;
  /** The round in flight or just finished, from 1. */
  round: number;
  maxRounds: number;
  /** What the latest reply said was still to do. */
  remaining: string;
  /** Research targets the finished rounds started (the plan's `many_research` counts them). */
  researchTargets: number;
  /** The round being waited on wrote something. */
  wrote: boolean;
  /** The last finished round went on only because it selected cards (so the next one could read their notes); a second one in a row does not. */
  selectedOnly?: boolean;
  ended?: { reason: MapChatChainEndReason; remaining: string };
}
export const startChain = (maxRounds = MAP_CHAT_CHAIN_MAX_ROUNDS): MapChatChainState => ({
  phase: "round",
  round: 1,
  maxRounds,
  remaining: "",
  researchTargets: 0,
  wrote: false
});
/** The chain facts `planFor` needs for the reply of the round in flight. */
export const planChainOf = (state: MapChatChainState): MapChatPlanChain => ({
  round: state.round,
  researchSoFar: state.researchTargets
});

export type MapChatChainDecision =
  /** Start round `round` now. */
  | { kind: "next"; round: number; remaining: string }
  /** Wait for this work, then call {@link finishWait}. */
  | { kind: "wait"; waitFor: ("research" | "expand")[] }
  | { kind: "end"; reason: MapChatChainEndReason; remaining: string }
  /** A late or repeated event for a chain that has moved on: do nothing. */
  | { kind: "ignored" };
interface Step {
  state: MapChatChainState;
  decision: MapChatChainDecision;
}
const ignored = (state: MapChatChainState): Step => ({ state, decision: { kind: "ignored" } });
const ended = (state: MapChatChainState, reason: MapChatChainEndReason, remaining = state.remaining): Step => ({
  state: { ...state, phase: "ended", remaining, ended: { reason, remaining } },
  decision: { kind: "end", reason, remaining }
});

/** The round's reply is on screen as a plan card: the chain stops where it is until the user applies or cancels it. */
export const pauseForPlan = (state: MapChatChainState): MapChatChainState =>
  state.phase === "round" ? { ...state, phase: "plan" } : state;
/** The user cancelled the plan card, or a new message replaced it. */
export const cancelPlan = (state: MapChatChainState): Step => interrupt(state, "plan_cancelled");

/** The first ending wins: a stop, a new message or a failure after the chain ended changes nothing. */
export function interrupt(state: MapChatChainState, reason: MapChatChainInterrupt): Step {
  if (state.phase === "ended") return ignored(state);
  return ended(state, reason);
}

/** What a round did (its reply applied, or its plan applied). */
export interface MapChatRoundEnd {
  /** The reply's `remaining` ("" for none). */
  remaining: string;
  /** Research notes this round's context left out that a later round can still send (not the oversize ones). */
  researchDeferred: number;
  actions: readonly MapChatRoundAction[];
  started: {
    /** Research targets started. */
    research: number;
    /** Expand cards started. */
    expand: number;
    /** An integration, a merge or a rating started: these are not waited for. */
    otherBackground: boolean;
  };
}
/**
 * A round is over. Continues when the reply left something to do or research notes were left out; then, in this order: another
 * background feature, the round limit, work to wait for, no progress. Nothing left to do ends the chain as `done` (so a pure
 * research request is not followed up). A round that wrote nothing but selected cards goes on once, so the next round reads the
 * notes of the cards it selected; a second such round in a row is no progress.
 */
export function finishRound(state: MapChatChainState, end: MapChatRoundEnd): Step {
  if (state.phase !== "round" && state.phase !== "plan") return ignored(state);
  const remaining = typeof end.remaining === "string" ? end.remaining.trim() : "";
  const next: MapChatChainState = {
    ...state,
    remaining,
    researchTargets: state.researchTargets + Math.max(0, end.started.research),
    wrote: wroteSomething(end.actions),
    selectedOnly: false
  };
  if (!remaining && end.researchDeferred <= 0) return ended(next, "done");
  if (end.started.otherBackground) return ended(next, "other_background_work");
  if (state.round >= state.maxRounds) return ended(next, "max_rounds");
  const waitFor: ("research" | "expand")[] = [];
  if (end.started.research > 0) waitFor.push("research");
  if (end.started.expand > 0) waitFor.push("expand");
  if (waitFor.length) return { state: { ...next, phase: "waiting" }, decision: { kind: "wait", waitFor } };
  if (!next.wrote) {
    if (state.selectedOnly || !selectedCards(end.actions)) return ended(next, "no_progress");
    return startNext({ ...next, selectedOnly: true });
  }
  return startNext(next);
}

const startNext = (state: MapChatChainState): Step => ({
  state: { ...state, phase: "round", round: state.round + 1, wrote: false },
  decision: { kind: "next", round: state.round + 1, remaining: state.remaining }
});

/** What the waited-for work came to. A part that was not waited for is left out. */
export interface MapChatWaitEnd {
  /** The 30 minutes ran out ({@link MAP_CHAT_CHAIN_WAIT_MS}). */
  timedOut?: boolean;
  research?: { kind: "not_started" } | { kind: "settled"; succeeded: number; failed: number; stopped: number };
  expand?: { succeeded: number; failed: number };
}
/**
 * The waited-for work is over. Research that all failed or was all stopped ends the chain (building on no research is the problem
 * this chain exists to avoid); research that never started ends it, written cards or not, unless an expand of the round succeeded; some success carries on,
 * the failed ones are told to the next round. A round with no success and no write is no progress.
 */
export function finishWait(state: MapChatChainState, end: MapChatWaitEnd): Step {
  if (state.phase !== "waiting") return ignored(state);
  if (end.timedOut) return ended(state, "wait_timeout");
  const research = end.research;
  const researchSucceeded = research?.kind === "settled" ? research.succeeded : 0;
  const expandSucceeded = end.expand?.succeeded ?? 0;
  if (research) {
    if (research.kind === "settled" && researchSucceeded === 0) {
      if (research.stopped > 0) return ended(state, "research_stopped");
      if (research.failed > 0) return ended(state, "research_failed");
    }
    // Research that never started ends the chain whatever the round wrote (the cards it wrote were to be built on that research,
    // decision #15), unless an expand of the same round succeeded.
    if (
      (research.kind === "not_started" || researchSucceeded + research.failed + research.stopped === 0) &&
      expandSucceeded === 0
    )
      return ended(state, "research_not_started");
  }
  if (!state.wrote && researchSucceeded === 0 && expandSucceeded === 0) return ended(state, "no_progress");
  return startNext(state);
}
