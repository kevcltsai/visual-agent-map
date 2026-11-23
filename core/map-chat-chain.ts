import type { MapChatAction } from "./steps/map-chat/step";
import type { MapChatPlanChain } from "./map-chat-plan";
import { hasOpenSteps, mergeProgress, type MapChatProgress } from "./map-chat-progress";

/**
 * Automatic continuation of a map chat message ("chain"): a reply that says something is still to do (`remaining`) gets its next
 * round started by the program, after the research it started has finished. Pure state machine, no Obsidian: the view feeds it what
 * a round did and does what the decision says. Progress is judged here from facts, never asked of the model.
 */

/** Rounds in a chain, the first one included. A reply is at most 100 actions; a 38 + 29 card tree plus research takes about 4 rounds, so twice that. */
export const MAP_CHAT_CHAIN_MAX_ROUNDS = 8;
/** Rounds in one segment of a chain with "apply this whole conversation automatically" on; a resume starts a new segment. */
export const MAP_CHAT_AUTO_MAX_ROUNDS = 60;
/** AI calls (research, expand, ...) in one segment of an auto-apply chain; `planFor` plans a reply that would pass it, and the chain ends as `call_limit` at it. */
export const MAP_CHAT_AUTO_MAX_CALLS = 300;
/** How long a chain waits for the research and expands it started; on expiry only the chain ends, the work goes on. */
export const MAP_CHAT_CHAIN_WAIT_MS = 30 * 60 * 1000;

export const MAP_CHAT_CHAIN_END_REASONS = [
  "done",
  "no_progress",
  "max_rounds",
  "call_limit",
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
  "run_map_action",
  "read_md_file"
]);
export interface MapChatRoundAction {
  kind: MapChatAction["kind"];
  /** Applied (not skipped, refused or failed). */
  done: boolean;
}
/** True when a `select_topics` was applied: the next round's context carries the selected cards' notes. */
export const selectedCards = (actions: readonly MapChatRoundAction[]): boolean =>
  actions.some(action => action.done && action.kind === "select_topics");
/** True when a `read_md_file` was applied: the next round's context carries that file. */
export const readFile = (actions: readonly MapChatRoundAction[]): boolean =>
  actions.some(action => action.done && action.kind === "read_md_file");
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
  /** AI calls the finished rounds of this segment started (counted for the auto-apply limit). */
  calls: number;
  /** This chain applies the whole conversation automatically: it also ends at {@link MAP_CHAT_AUTO_MAX_CALLS} calls. */
  autoApply?: boolean;
  /** The steps of the whole instruction and where it stands (kept across rounds and a resume). */
  progress?: MapChatProgress;
  /** The round being waited on wrote something. */
  wrote: boolean;
  /**
   * The round in flight checks whether the work is really done: the round before left nothing to do, but the flow still had steps
   * not done (or its reply was resent with fewer actions). It ends as `done` once such a round writes and starts nothing.
   */
  checkingDone?: boolean;
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
  calls: 0,
  wrote: false
});
/** A chain with auto-apply on: segments of {@link MAP_CHAT_AUTO_MAX_ROUNDS} rounds and {@link MAP_CHAT_AUTO_MAX_CALLS} calls. */
export const startAutoChain = (): MapChatChainState => ({ ...startChain(MAP_CHAT_AUTO_MAX_ROUNDS), autoApply: true });
/**
 * The chain of a resume (`resume` from {@link resumeRound}): a fresh segment, so the call and research counters start at 0 and the
 * round keeps counting.
 */
export const resumedChain = (
  resume: { round: number; maxRounds: number; remaining: string; progress?: MapChatProgress },
  autoApply = false
): MapChatChainState => ({
  ...startChain(resume.maxRounds),
  round: resume.round,
  remaining: resume.remaining,
  ...(autoApply ? { autoApply: true } : {}),
  ...(resume.progress ? { progress: resume.progress } : {})
});
/**
 * The toggle of the moment decides the segment limits of a running chain: on gives the auto-apply limits, off the plain ones.
 * Returns `state` itself when it already matches.
 */
export const syncAutoApply = (state: MapChatChainState, on: boolean): MapChatChainState => {
  if (on === !!state.autoApply) return state;
  const { autoApply: _was, ...rest } = state;
  return on
    ? { ...rest, autoApply: true, maxRounds: MAP_CHAT_AUTO_MAX_ROUNDS }
    : { ...rest, maxRounds: MAP_CHAT_CHAIN_MAX_ROUNDS };
};
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
  /** AI calls the round started (from `estimateChatCalls`); added to the segment's count. Absent = 0. */
  calls?: number;
  /** The reply's `progress` (already normalized); merged into the chain's. Absent or null = the old one stays. */
  progress?: MapChatProgress | null;
  /** The reply that was taken has fewer actions than one the provider did not take (rejected or replaced): work may have been dropped. */
  droppedOnRetry?: boolean;
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
    calls: (state.calls ?? 0) + Math.max(0, end.calls ?? 0),
    wrote: wroteSomething(end.actions),
    selectedOnly: false
  };
  const read = readFile(end.actions);
  const progress = mergeProgress(state.progress, end.progress);
  if (progress) next.progress = progress;
  // The provider sent back a reply with actions (failed the format check) and the one it took has none: the work was lost, not done.
  // No check round even with auto-apply: it would send the same oversized batch again; the user is told and can resend a smaller part.
  if (end.droppedOnRetry && !end.actions.length) return ended(next, "no_progress", state.remaining || remaining);
  const nothingLeft = !remaining && end.researchDeferred <= 0 && !read;
  // An auto-apply chain does not take "nothing left" on trust while its own steps are open or its reply lost actions on a retry:
  // a check round compares them first, and the chain is done once a check round writes and starts nothing.
  const doubt = !!state.autoApply && (hasOpenSteps(progress) || !!end.droppedOnRetry);
  const idle = !next.wrote && end.started.research <= 0 && end.started.expand <= 0;
  if (nothingLeft && (!doubt || (state.checkingDone && idle))) return ended(next, "done");
  next.checkingDone = nothingLeft;
  if (end.started.otherBackground) return ended(next, "other_background_work");
  if (state.round >= state.maxRounds) return ended(next, "max_rounds");
  if (state.autoApply && next.calls >= MAP_CHAT_AUTO_MAX_CALLS) return ended(next, "call_limit");
  const waitFor: ("research" | "expand")[] = [];
  if (end.started.research > 0) waitFor.push("research");
  if (end.started.expand > 0) waitFor.push("expand");
  if (waitFor.length) return { state: { ...next, phase: "waiting" }, decision: { kind: "wait", waitFor } };
  if (!next.wrote) {
    // The file it asked to read comes in the next round: that is progress, and the round limit still ends a chain that only reads.
    if (read) return startNext(next);
    // The first check round is owed even when this round wrote nothing.
    if (next.checkingDone && !state.checkingDone) return startNext(next);
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

/** The endings a user can pick up again (the others are a finished chain, the user's own words, or a failure that rerunning would repeat). */
export const MAP_CHAT_CHAIN_RESUMABLE: ReadonlySet<MapChatChainEndReason> = new Set<MapChatChainEndReason>([
  "stopped",
  "plan_cancelled",
  "research_stopped",
  "failed",
  "wait_timeout",
  "no_progress",
  "max_rounds",
  "call_limit"
]);
export interface MapChatChainResumeEnd {
  /** Why the chain ended; null when it was cut off (the plugin reloaded: no `chain_end`, or only `map_changed`). */
  reason: MapChatChainEndReason | null;
  /** The round the chain was in when it stopped. */
  round: number;
  /** The round's work was applied (its reply or its plan); false: it must be done again. */
  applied: boolean;
  /** What the round was started with. */
  startRemaining: string;
  /** What the round's reply said was still to do. */
  replyRemaining: string;
}
/**
 * Where an interrupted chain goes on: the next round when the stopped one was applied (and its reply left something to do), the same
 * round again when it was not. Round 1 not applied is a resend, not a resume. The round limit counts in whole limits, so a chain
 * that hit it gets one more limit (rounds keep counting). `segment` is the limit: 8, or {@link MAP_CHAT_AUTO_MAX_ROUNDS} for an auto-apply chain.
 */
export function resumeRound(
  end: MapChatChainResumeEnd,
  segment = MAP_CHAT_CHAIN_MAX_ROUNDS
): { round: number; maxRounds: number; remaining: string } | null {
  if (end.reason !== null && !MAP_CHAT_CHAIN_RESUMABLE.has(end.reason)) return null;
  let round = end.round;
  let remaining = end.startRemaining;
  if (end.applied) {
    round += 1;
    remaining = end.replyRemaining;
    if (!remaining) return null;
  }
  if (!Number.isInteger(round) || round < 2) return null;
  return { round, maxRounds: segment * Math.ceil(round / segment), remaining };
}

const RESUME_KEYWORDS: ReadonlySet<string> = new Set([
  "繼續",
  "继续",
  "接著做",
  "接着做",
  "continue",
  "resume",
  "goon"
]);
/** The whole message is "continue" (any of the words, ignoring spaces, punctuation, width and case). */
export const isResumeKeyword = (text: string): boolean =>
  RESUME_KEYWORDS.has(
    text
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[\s\p{P}\p{S}]/gu, "")
  );
