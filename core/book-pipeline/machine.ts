/**
 * Picture-book pipeline state machine. Pure: `nextActions` says what may happen next from the persisted state and the cards'
 * stages; the reducers are the only functions that change a state, each returns a new one and leaves its input alone.
 * The AI only fills content; every gate (retries, needs-review, budget pause, stale results) is decided here.
 *
 * Contract (plan revisions 1-3): a step is dispatched by `beginStep` (counts one attempt, saved before the call), and its
 * result is committed with a token that carries the run and the card revision it started under. A result whose run, stop state
 * or revision no longer matches is dropped. The promise is at least once, never lost: a card's stage in its note is the truth
 * of what is done, so after any crash `nextActions` re-derives the next step from the stages and the saved counters.
 */
import {
  DEFAULT_BUDGET_LIMIT,
  FAILURE_CODE,
  MAX_AUTO_FIXES,
  MAX_STEP_ATTEMPTS,
  attemptsOf,
  emptyAttempts,
  type BookPipelineData,
  type PipelineStage,
  type PipelineStep
} from "./model";

export type PipelineStepKind = "global" | PipelineStep;

export type PipelineAction =
  | { type: "reset_stage"; nodeId: string }
  | { type: "global_plan" }
  | { type: "card_plan" | "card_write" | "card_proof"; nodeId: string }
  /** The step's attempts are used up: write `needs-review` on the card, then keep going. */
  | { type: "mark_needs_review"; nodeId: string; step: PipelineStep }
  | { type: "advance_phase" };

/** Why nothing (more) runs. `gate1`/`gate2` wait for the owner; `done` is final. */
export type PipelineHold = "stopped" | "budget" | "global_failed" | "gate1" | "gate2" | "done" | "empty";

export interface PipelinePlan {
  actions: PipelineAction[];
  /** Set when no action may be started because of a gate, a stop or a failed whole-book plan. */
  hold?: PipelineHold;
}

/** What `nextActions` needs of a card: its stored stage (undefined = not planned yet). */
export type CardStages = Readonly<Record<string, PipelineStage | undefined>>;

/** A dispatched step's identity; a result commits only while it is still current. */
export interface StepToken {
  runId: string;
  kind: PipelineStepKind;
  nodeId?: string;
  /** The card's revision when the step started (0 for the whole-book plan). */
  revision: number;
  /** The run's stop generation when the step started; a stop raises it, so a result from before a stop can never commit after a resume. */
  stopEpoch: number;
}

const clone = (data: BookPipelineData): BookPipelineData => JSON.parse(JSON.stringify(data)) as BookPipelineData;
const ranked = (stage: PipelineStage | undefined): number =>
  stage === undefined ? 0 : stage === "planned" ? 1 : stage === "written" ? 2 : 3;

export function newBookPipeline(input: {
  runId: string;
  order: readonly string[];
  now: string;
  budgetLimit?: number;
  /** Cards that carry a stage from before this run: it is stale (never trusted across runs) and gets cleared first. */
  staleStages?: readonly string[];
  /** Cards whose role the pipeline wrote itself (see `BookPipelineData.autoRoles`). */
  autoRoles?: readonly string[];
}): BookPipelineData {
  if (!input.order.length) throw new Error("empty order");
  if (input.order.includes("global")) throw new Error("reserved node id");
  return {
    v: 1,
    runId: input.runId,
    phase: "planning",
    status: "running",
    order: [...input.order],
    globalPlanned: false,
    attempts: { global: 0 },
    revisions: {},
    ...(input.staleStages?.length ? { pendingReset: [...input.staleStages] } : {}),
    ...(input.autoRoles?.length ? { autoRoles: [...input.autoRoles] } : {}),
    budget: { used: 0, limit: input.budgetLimit ?? DEFAULT_BUDGET_LIMIT },
    revision: 0,
    startedAt: input.now,
    phaseStartedAt: input.now
  };
}

export function cardRevision(data: BookPipelineData, nodeId: string): number {
  return data.revisions[nodeId] ?? 0;
}

/**
 * What may start now, from the saved state and the cards' stages (a card that is already in flight is the caller's business:
 * pass its node id in `busy` and it is skipped). Idempotent: running it twice without a reducer in between gives the same plan.
 */
export function nextActions(
  data: BookPipelineData,
  stages: CardStages,
  busy: ReadonlySet<string> = new Set()
): PipelinePlan {
  if (data.status === "stopped") return { actions: [], hold: data.pauseReason === "budget" ? "budget" : "stopped" };
  if (data.phase === "done") return { actions: [], hold: "done" };
  if (!data.order.length) return { actions: [], hold: "empty" };
  const resets = (data.pendingReset ?? []).filter(id => data.order.includes(id) && stages[id] !== undefined);
  if (data.pendingReset?.length) {
    // Stale stages go first; a stage that is already clear needs no action, only the (idempotent) bookkeeping.
    return resets.length
      ? { actions: resets.map(nodeId => ({ type: "reset_stage", nodeId })) }
      : { actions: [{ type: "advance_phase" }] };
  }
  if (data.phase === "gate1") return { actions: [], hold: "gate1" };
  if (data.phase === "gate2") return { actions: [], hold: "gate2" };
  const actions: PipelineAction[] = [];
  if (data.phase === "planning") {
    if (!data.globalPlanned) {
      if (data.attempts.global >= MAX_STEP_ATTEMPTS) return { actions: [], hold: "global_failed" };
      return { actions: busy.has("global") ? [] : [{ type: "global_plan" }] };
    }
  }
  for (const nodeId of data.order) {
    if (busy.has(nodeId)) continue;
    const stage = stages[nodeId];
    if (stage === "needs-review" || stage === "checked") continue;
    const attempts = attemptsOf(data, nodeId);
    // The stage a card needs a step for: planning phase only plans; writing phase plans leftovers, writes, proofs.
    const step: PipelineStep | null =
      stage === undefined ? "plan" : data.phase === "planning" ? null : stage === "planned" ? "write" : "proof";
    if (!step) continue;
    if (attempts[step] >= MAX_STEP_ATTEMPTS) actions.push({ type: "mark_needs_review", nodeId, step });
    else actions.push({ type: step === "plan" ? "card_plan" : step === "write" ? "card_write" : "card_proof", nodeId });
  }
  if (actions.length) return { actions };
  // Nothing left to start. Busy cards are still working; otherwise the phase is complete.
  if (busy.size) return { actions: [] };
  return { actions: [{ type: "advance_phase" }] };
}

/** Moves the phase on when it is complete (planning to gate1, writing to gate2); a no-op elsewhere. */
export function advancePhase(data: BookPipelineData, stages: CardStages, now: string): BookPipelineData {
  if (data.status !== "running") return data;
  const next = clone(data);
  if (next.pendingReset?.length) {
    next.pendingReset = next.pendingReset.filter(id => stages[id] !== undefined);
    if (!next.pendingReset.length) delete next.pendingReset;
    next.revision++;
    return next;
  }
  const all = (min: number): boolean => next.order.every(id => ranked(stages[id]) >= min);
  if (next.phase === "planning" && next.globalPlanned && all(1)) next.phase = "gate1";
  else if (next.phase === "writing" && all(3)) next.phase = "gate2";
  else return data;
  next.phaseStartedAt = now;
  next.revision++;
  return next;
}

/** The owner confirmed gate 1: writing may start. A no-op outside gate 1. */
export function confirmGate1(data: BookPipelineData, now: string): BookPipelineData {
  if (data.phase !== "gate1" || data.status !== "running") return data;
  const next = clone(data);
  next.phase = "writing";
  next.phaseStartedAt = now;
  next.revision++;
  return next;
}

/** The owner confirmed gate 2: the run is finished. A no-op outside gate 2. */
export function finishRun(data: BookPipelineData, now: string): BookPipelineData {
  if (data.phase !== "gate2" || data.status !== "running") return data;
  const next = clone(data);
  next.phase = "done";
  next.phaseStartedAt = now;
  next.revision++;
  return next;
}

/** True while a result under `token` may still be committed. */
export function isCurrent(data: BookPipelineData, token: StepToken): boolean {
  if (data.runId !== token.runId || data.status !== "running") return false;
  if ((data.stopEpoch ?? 0) !== token.stopEpoch) return false;
  if (token.kind === "global") return !data.globalPlanned;
  if (!token.nodeId || !data.order.includes(token.nodeId)) return false;
  return cardRevision(data, token.nodeId) === token.revision;
}

export interface Dispatched {
  state: BookPipelineData;
  token: StepToken;
}
/**
 * Dispatches a step: counts one attempt (saved before the call, so a crash with an unknown result still counts) and returns
 * its token. Null when the step may not start (stopped, wrong card, attempts used up, global already planned).
 */
export function beginStep(data: BookPipelineData, kind: PipelineStepKind, nodeId?: string): Dispatched | null {
  if (data.status !== "running") return null;
  const next = clone(data);
  if (kind === "global") {
    if (next.globalPlanned || next.attempts.global >= MAX_STEP_ATTEMPTS) return null;
    next.attempts.global++;
    next.revision++;
    return { state: next, token: { runId: next.runId, kind, revision: 0, stopEpoch: next.stopEpoch ?? 0 } };
  }
  if (!nodeId || !next.order.includes(nodeId)) return null;
  const attempts = attemptsOf(next, nodeId);
  if (attempts[kind] >= MAX_STEP_ATTEMPTS) return null;
  attempts[kind]++;
  next.attempts[nodeId] = attempts;
  next.revision++;
  return {
    state: next,
    token: { runId: next.runId, kind, nodeId, revision: cardRevision(next, nodeId), stopEpoch: next.stopEpoch ?? 0 }
  };
}

export interface Committed {
  state: BookPipelineData;
  /** False: the result was late or stale and is dropped; `state` is the input, unchanged. */
  accepted: boolean;
}

/** A plan or write succeeded: the card's revision rises (so an old proof can no longer commit); a proof leaves it. */
export function applySuccess(data: BookPipelineData, token: StepToken): Committed {
  if (!isCurrent(data, token)) return { state: data, accepted: false };
  const next = clone(data);
  if (token.kind === "global") next.globalPlanned = true;
  else if (token.nodeId && token.kind !== "proof") next.revisions[token.nodeId] = cardRevision(next, token.nodeId) + 1;
  next.revision++;
  return { state: next, accepted: true };
}

export interface Failed extends Committed {
  /** Set when this failure used up the step: the card gets `needs-review` (the whole-book plan stops the run at planning instead). */
  needsReview?: { nodeId: string; step: PipelineStep };
}
/** A step failed. The counter was taken at dispatch; the third failure marks the card (or stops at planning for the global plan). */
export function applyFailure(data: BookPipelineData, token: StepToken): Failed {
  if (!isCurrent(data, token)) return { state: data, accepted: false };
  const next = clone(data);
  next.revision++;
  if (token.kind !== "global" && token.nodeId && attemptsOf(next, token.nodeId)[token.kind] >= MAX_STEP_ATTEMPTS)
    return { state: next, accepted: true, needsReview: { nodeId: token.nodeId, step: token.kind } };
  return { state: next, accepted: true };
}

/** A call was cancelled (a stop, not a failure): the attempt it took is given back. */
export function applyCancelled(data: BookPipelineData, token: StepToken): Committed {
  if (data.runId !== token.runId) return { state: data, accepted: false };
  const next = clone(data);
  if (token.kind === "global") next.attempts.global = Math.max(0, next.attempts.global - 1);
  else if (token.nodeId && next.order.includes(token.nodeId)) {
    const attempts = attemptsOf(next, token.nodeId);
    attempts[token.kind] = Math.max(0, attempts[token.kind] - 1);
    next.attempts[token.nodeId] = attempts;
  } else return { state: data, accepted: false };
  next.revision++;
  return { state: next, accepted: true };
}

/**
 * The call budget ran out. Not a failure: the attempt is given back, the run pauses with its own reason, and no card is
 * marked. Several in-flight calls may report it; each one gives its attempt back and the pause stays.
 */
export function applyBudgetExhausted(data: BookPipelineData, token: StepToken): Committed {
  if (data.runId !== token.runId) return { state: data, accepted: false };
  const refunded = applyCancelled(data, token);
  const next = clone(refunded.accepted ? refunded.state : data);
  next.status = "stopped";
  next.pauseReason = "budget";
  delete next.failureCode;
  next.revision++;
  return { state: next, accepted: true };
}

/** The owner stopped the run. Calls in flight are aborted by the runner and come back as cancelled. */
export function stopRun(data: BookPipelineData): BookPipelineData {
  if (data.status === "stopped" && data.pauseReason === undefined) return data;
  const next = clone(data);
  next.status = "stopped";
  delete next.pauseReason;
  delete next.failureCode;
  next.stopEpoch = (next.stopEpoch ?? 0) + 1;
  next.revision++;
  return next;
}

/** The run stopped by itself (the whole-book plan failed three times, or an unexpected error): resumable, with a neutral code the bar shows. */
export function failRun(data: BookPipelineData, code: string): BookPipelineData {
  const next = clone(data);
  next.status = "stopped";
  next.pauseReason = "failed";
  next.failureCode = FAILURE_CODE.test(code) ? code : "failed";
  next.stopEpoch = (next.stopEpoch ?? 0) + 1;
  next.revision++;
  return next;
}

/**
 * Continue from where it stopped. Refused (null) while the budget is still used up. Idempotent on a running state; the next
 * steps come from the stages, so nothing finished is redone.
 */
export function resumeRun(data: BookPipelineData): BookPipelineData | null {
  if (data.status === "running") return data;
  if (data.budget.used >= data.budget.limit) return null;
  const next = clone(data);
  next.status = "running";
  delete next.pauseReason;
  delete next.failureCode;
  next.revision++;
  return next;
}

/** The owner raised the limit (the "add 100" button); a budget pause ends at once. */
export function addBudget(data: BookPipelineData, extra: number): BookPipelineData {
  if (!Number.isInteger(extra) || extra < 1) return data;
  const next = clone(data);
  next.budget.limit += extra;
  if (next.pauseReason === "budget") {
    next.status = "running";
    delete next.pauseReason;
  }
  next.revision++;
  return next;
}

/** The owner's "retry" after the whole-book plan failed three times. */
export function retryGlobalPlan(data: BookPipelineData): BookPipelineData {
  if (data.globalPlanned || data.attempts.global === 0) return data;
  const next = clone(data);
  next.attempts.global = 0;
  next.revision++;
  return next;
}

/** The calls a card's whole chain (plan, write, images, proof) needs at most, for the reserve of the cards still to do. */
const AUTO_FIX_CARD_RESERVE = 4;
const AUTO_FIX_BASE_RESERVE = 5;
/** How many automatic redo rounds a card has used. */
export function autoFixesOf(data: BookPipelineData, nodeId: string): number {
  return data.autoFixes?.[nodeId] ?? 0;
}
/**
 * Whether a card may be redone automatically now: fewer than {@link MAX_AUTO_FIXES} rounds used, and the budget left keeps
 * {@link AUTO_FIX_CARD_RESERVE} calls for each other card that is not finished plus {@link AUTO_FIX_BASE_RESERVE}; a redo never starves the rest of the book.
 */
export function autoFixVerdict(
  data: BookPipelineData,
  nodeId: string,
  unfinishedOthers: number
): "ok" | "rounds" | "quota" {
  if (!data.order.includes(nodeId) || data.status !== "running") return "quota";
  if (autoFixesOf(data, nodeId) >= MAX_AUTO_FIXES) return "rounds";
  const left = data.budget.limit - data.budget.used;
  return left >= AUTO_FIX_CARD_RESERVE * Math.max(0, unfinishedOthers) + AUTO_FIX_BASE_RESERVE ? "ok" : "quota";
}
/**
 * One automatic redo of a card: when allowed, the round count rises and the card is reset (attempts start over, its revision rises,
 * so a proofread still in flight can no longer commit). Not allowed: `accepted` is false and nothing changes.
 */
export function requestAutoFix(data: BookPipelineData, nodeId: string, unfinishedOthers = 0): Committed {
  if (autoFixVerdict(data, nodeId, unfinishedOthers) !== "ok") return { state: data, accepted: false };
  const reset = resetCard(data, nodeId);
  const next = clone(reset);
  next.autoFixes = { ...(next.autoFixes ?? {}), [nodeId]: autoFixesOf(data, nodeId) + 1 };
  return { state: next, accepted: true };
}

/** A card was reset by the owner or needs another pass (single-card rerun): its counters and its stage start over. */
export function resetCard(data: BookPipelineData, nodeId: string): BookPipelineData {
  if (!data.order.includes(nodeId)) return data;
  const next = clone(data);
  next.attempts[nodeId] = emptyAttempts();
  next.revisions[nodeId] = cardRevision(next, nodeId) + 1;
  next.revision++;
  return next;
}

/** A reset action was carried out (the card's stage is now clear). */
export function applyReset(data: BookPipelineData, nodeId: string): BookPipelineData {
  if (!data.pendingReset?.includes(nodeId)) return data;
  const next = clone(data);
  next.pendingReset = next.pendingReset?.filter(id => id !== nodeId);
  if (!next.pendingReset?.length) delete next.pendingReset;
  next.revision++;
  return next;
}

/**
 * A map file that says "running" with no drive behind it (the app was closed) is a stopped run.
 */
export function recoverInterrupted(data: BookPipelineData): BookPipelineData {
  return data.status === "running" ? stopRun(data) : data;
}

/**
 * Commits state changes one after another and never after `dispose`: a committed reducer result is saved (`persist`) before
 * the next one starts; after dispose nothing more is written (not even the map file) and a late result reports "dropped".
 */
export class PipelineStore {
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;
  constructor(
    private current: BookPipelineData,
    private readonly persist: (state: BookPipelineData) => Promise<void>
  ) {}

  get state(): BookPipelineData {
    return this.current;
  }
  get isDisposed(): boolean {
    return this.disposed;
  }
  dispose(): void {
    this.disposed = true;
  }
  /** Applies `change` to the latest state. Its result is saved first, then becomes current; returns whether it was kept. */
  commit<T extends { state: BookPipelineData; accepted?: boolean }>(
    change: (data: BookPipelineData) => T
  ): Promise<T | null> {
    const run = this.queue.then(async () => {
      if (this.disposed) return null;
      const result = change(this.current);
      if (result.accepted === false || result.state === this.current) return result;
      await this.persist(result.state);
      this.current = result.state;
      return result;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}
