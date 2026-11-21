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
  BOOK_EXPAND_PASSES,
  MAX_AUTO_FIXES,
  MAX_STEP_ATTEMPTS,
  attemptsOf,
  effectiveOrder,
  emptyAttempts,
  mapDifference,
  type BookPipelineData,
  type ConsistencyFinding,
  type PipelineStage,
  type PipelineStep
} from "./model";
import { consistencyKey } from "./consistency";

export type PipelineStepKind = "global" | PipelineStep;

export type PipelineAction =
  | { type: "reset_stage"; nodeId: string }
  | { type: "global_plan" }
  | { type: "card_plan" | "card_write" | "card_proof"; nodeId: string }
  /** The step's attempts are used up: write `needs-review` on the card, then keep going. */
  | { type: "mark_needs_review"; nodeId: string; step: PipelineStep }
  /** Every chapter is written and proofread: the one whole-book consistency check runs before the phase moves on. */
  | { type: "book_consistency" }
  | { type: "advance_phase" };

/** The busy key of the consistency check (never a card id: card ids are map node ids). */
export const CONSISTENCY_BUSY = "#consistency";

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

/** The trial of a book without a known structure: the preface and chapter 1. */
const FLAT_TRIAL = 2;
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
  /** The id -> title and note path of every chapter now (see `BookPipelineData.chapters`). */
  chapters?: Readonly<Record<string, { title: string; path: string }>>;
  /** The trial cards (`bookStructure().trialOf()`). Absent: the first two cards (a book of chapters only: the preface and chapter 1). */
  trial?: readonly string[];
}): BookPipelineData {
  if (!input.order.length) throw new Error("empty order");
  if (input.order.includes("global")) throw new Error("reserved node id");
  return {
    v: 1,
    runId: input.runId,
    phase: "planning",
    status: "running",
    order: [...input.order],
    accepted: [...input.order],
    ...(input.chapters && Object.keys(input.chapters).length ? { chapters: { ...input.chapters } } : {}),
    globalPlanned: false,
    attempts: { global: 0 },
    revisions: {},
    ...(input.staleStages?.length ? { pendingReset: [...input.staleStages] } : {}),
    ...(input.autoRoles?.length ? { autoRoles: [...input.autoRoles] } : {}),
    trial: input.trial ? input.trial.slice() : input.order.slice(0, FLAT_TRIAL),
    planReview: true,
    budget: { used: 0, limit: input.budgetLimit ?? DEFAULT_BUDGET_LIMIT },
    revision: 0,
    startedAt: input.now,
    phaseStartedAt: input.now
  };
}

export function cardRevision(data: BookPipelineData, nodeId: string): number {
  return data.revisions[nodeId] ?? 0;
}

/** The three gates of a run: the plan review, the trial's result, and the one before the book counts as done. */
export type PipelineGate = "plan" | "trial" | "final";
/**
 * Whether the run stops at a gate until the owner confirms. The one place that decides it: today every gate waits for a person
 * (a switch to let a gate pass by itself is a later change, and belongs here, not at the gates).
 */
export function gateWaitsForPerson(_data: BookPipelineData, _gate: PipelineGate): boolean {
  return true;
}

/**
 * What may start now, from the saved state and the cards' stages (a card that is already in flight is the caller's business:
 * pass its node id in `busy` and it is skipped). Idempotent: running it twice without a reducer in between gives the same plan.
 */
export function nextActions(
  data: BookPipelineData,
  stages: CardStages,
  busy: ReadonlySet<string> = new Set(),
  /** `consistency`: the runner can run the whole-book check (absent: the writing phase moves on without it, as before). */
  options: { consistency?: boolean } = {}
): PipelinePlan {
  if (data.status === "stopped") return { actions: [], hold: data.pauseReason === "budget" ? "budget" : "stopped" };
  if (data.phase === "done") return { actions: [], hold: "done" };
  const order = effectiveOrder(data);
  if (!order.length) return { actions: [], hold: "empty" };
  const resets = (data.pendingReset ?? []).filter(id => order.includes(id) && stages[id] !== undefined);
  if (data.pendingReset?.length) {
    // Stale stages go first; a stage that is already clear needs no action, only the (idempotent) bookkeeping.
    return resets.length
      ? { actions: resets.map(nodeId => ({ type: "reset_stage", nodeId })) }
      : { actions: [{ type: "advance_phase" }] };
  }
  if (data.phase === "gate1" && gateWaitsForPerson(data, data.planReview ? "plan" : "trial"))
    return { actions: [], hold: "gate1" };
  if (data.phase === "gate2" && gateWaitsForPerson(data, "final")) return { actions: [], hold: "gate2" };
  const actions: PipelineAction[] = [];
  if (data.phase === "planning") {
    if (!data.globalPlanned) {
      if (data.attempts.global >= MAX_STEP_ATTEMPTS) return { actions: [], hold: "global_failed" };
      return { actions: busy.has("global") ? [] : [{ type: "global_plan" }] };
    }
  }
  // Every chapter is planned before any chapter is written (a trial too): a brief written later cannot change a chapter already written.
  const allPlanned = order.every(id => ranked(stages[id]) >= 1);
  for (const nodeId of order) {
    if (busy.has(nodeId)) continue;
    const stage = stages[nodeId];
    if (stage === "needs-review" || stage === "checked") continue;
    const attempts = attemptsOf(data, nodeId);
    // The stage a card needs a step for: every card is planned first; then the planning phase writes and proofs its trial cards only
    // (a run without a trial: none), and the writing phase writes and proofs the rest.
    const trialCard = !!data.trial?.includes(nodeId);
    const step: PipelineStep | null =
      stage === undefined
        ? "plan"
        : !allPlanned || (data.phase === "planning" && (!trialCard || data.planReview))
          ? null
          : stage === "planned"
            ? "write"
            : "proof";
    if (!step) continue;
    if (attempts[step] >= MAX_STEP_ATTEMPTS) actions.push({ type: "mark_needs_review", nodeId, step });
    else actions.push({ type: step === "plan" ? "card_plan" : step === "write" ? "card_write" : "card_proof", nodeId });
  }
  if (actions.length) return { actions };
  // Nothing left to start. Busy cards are still working; otherwise the phase is complete.
  if (busy.size) return { actions: [] };
  if (data.phase === "writing" && options.consistency && consistencyDue(data))
    return { actions: [{ type: "book_consistency" }] };
  return { actions: [{ type: "advance_phase" }] };
}

/**
 * Whether the whole-book check still has to run: never asked, asked for other chapter revisions (a chapter was written again), or
 * unfinished with attempts left. A check that failed {@link MAX_STEP_ATTEMPTS} times for the same chapters does not hold the run.
 */
export function consistencyDue(data: BookPipelineData): boolean {
  const check = data.consistency;
  if (!check || check.key !== consistencyKey(data)) return true;
  return !check.done && check.attempts < MAX_STEP_ATTEMPTS;
}

/** A dispatched consistency check: the run, stop generation and chapter revisions it started under. */
export interface ConsistencyToken {
  runId: string;
  stopEpoch: number;
  key: string;
}
/**
 * Starts the check: counts one attempt for the current chapters (saved before the call). An earlier result stays until a new one
 * commits (its findings count only for chapters that did not change). Null when it may not start.
 */
export function beginConsistency(data: BookPipelineData): { state: BookPipelineData; token: ConsistencyToken } | null {
  if (data.status !== "running" || data.phase !== "writing" || !consistencyDue(data)) return null;
  const key = consistencyKey(data);
  const next = clone(data);
  const same = next.consistency?.key === key ? next.consistency.attempts : 0;
  next.consistency = { ...(next.consistency ?? {}), key, attempts: same + 1, done: false };
  next.revision++;
  return { state: next, token: { runId: next.runId, stopEpoch: next.stopEpoch ?? 0, key } };
}
const consistencyCurrent = (data: BookPipelineData, token: ConsistencyToken): boolean =>
  data.runId === token.runId &&
  data.status === "running" &&
  data.phase === "writing" &&
  (data.stopEpoch ?? 0) === token.stopEpoch &&
  consistencyKey(data) === token.key;
/** The check finished: its findings and the revisions it read are kept; a result for chapters that changed meanwhile is dropped. */
export function applyConsistency(
  data: BookPipelineData,
  token: ConsistencyToken,
  findings: readonly ConsistencyFinding[]
): Committed {
  if (!consistencyCurrent(data, token)) return { state: data, accepted: false };
  const next = clone(data);
  const revisions = Object.fromEntries(effectiveOrder(next).map(id => [id, cardRevision(next, id)]));
  next.consistency = {
    key: token.key,
    attempts: next.consistency?.key === token.key ? next.consistency.attempts : 1,
    done: true,
    revisions,
    findings: findings.map(finding => ({ ...finding }))
  };
  next.revision++;
  return { state: next, accepted: true };
}
/** The check was stopped or hit the budget (not a failure): its attempt is given back; with `budget` the run pauses for it. */
export function applyConsistencyStopped(data: BookPipelineData, token: ConsistencyToken, budget: boolean): Committed {
  if (data.runId !== token.runId) return { state: data, accepted: false };
  const next = clone(data);
  if (next.consistency?.key === token.key) next.consistency.attempts = Math.max(0, next.consistency.attempts - 1);
  if (budget) {
    next.status = "stopped";
    next.pauseReason = "budget";
    delete next.failureCode;
  }
  next.revision++;
  return { state: next, accepted: true };
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
  const order = effectiveOrder(next);
  const all = (min: number): boolean => order.every(id => ranked(stages[id]) >= min);
  // A plan review (the owner has not chosen yet whether to run the trial) is reached once every chapter is planned.
  const trialDone =
    next.trial && !next.planReview ? next.trial.every(id => !order.includes(id) || ranked(stages[id]) >= 3) : all(1);
  if (next.phase === "planning" && next.globalPlanned && trialDone) next.phase = "gate1";
  else if (next.phase === "writing" && all(3)) next.phase = "gate2";
  else return data;
  next.phaseStartedAt = now;
  next.revision++;
  return next;
}

/**
 * The owner wants the trial cards again with the settings and models as they are now (gate 1 of a run with a trial): the run goes back
 * to planning, the trial cards' counters (attempts, automatic redo) start over and their stages are cleared first. The whole-book plan
 * stays. A no-op (same state) outside gate 1 or for a run without a trial.
 */
export function retryTrial(data: BookPipelineData, now: string): BookPipelineData {
  if (data.phase !== "gate1" || data.status !== "running" || !data.trial?.length) return data;
  const next = clone(data);
  const live = effectiveOrder(data);
  const trial = data.trial.filter(id => live.includes(id));
  next.phase = "planning";
  next.phaseStartedAt = now;
  next.pendingReset = [...new Set([...(next.pendingReset ?? []), ...trial])];
  for (const id of trial) {
    next.attempts[id] = emptyAttempts();
    next.revisions[id] = cardRevision(next, id) + 1;
    if (next.autoFixes) delete next.autoFixes[id];
    if (next.expandPasses) delete next.expandPasses[id];
  }
  next.revision++;
  return next;
}

/** At the plan review (gate 1 before the trial ran): the owner chose to run the trial. A no-op elsewhere. */
export function startTrial(data: BookPipelineData, now: string): BookPipelineData {
  if (data.phase !== "gate1" || data.status !== "running" || !data.planReview || !data.trial?.length) return data;
  const next = clone(data);
  delete next.planReview;
  next.phase = "planning";
  next.phaseStartedAt = now;
  next.revision++;
  return next;
}

/**
 * At the trial's gate 1: the owner wants to change the plan first. The run goes back to the plan review; the trial chapters keep their
 * plans (the owner edits them in the notes) and go back to planned, so the next trial writes them again from the edited plans. Their
 * counters start over. A no-op elsewhere. The caller writes the planned stage onto the trial cards.
 */
export function backToPlan(data: BookPipelineData, now: string): BookPipelineData {
  if (data.phase !== "gate1" || data.status !== "running" || data.planReview || !data.trial?.length) return data;
  const next = clone(data);
  next.planReview = true;
  next.phaseStartedAt = now;
  for (const id of data.trial) {
    next.attempts[id] = emptyAttempts();
    next.revisions[id] = cardRevision(next, id) + 1;
    if (next.autoFixes) delete next.autoFixes[id];
    if (next.expandPasses) delete next.expandPasses[id];
  }
  next.revision++;
  return next;
}

/** The owner confirmed gate 1: writing may start. At the plan review this skips the trial (every chapter is written like the rest). A no-op outside gate 1. */
export function confirmGate1(data: BookPipelineData, now: string): BookPipelineData {
  if (data.phase !== "gate1" || data.status !== "running") return data;
  const next = clone(data);
  if (next.planReview) {
    delete next.planReview;
    delete next.trial;
  }
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
  if (!token.nodeId || !effectiveOrder(data).includes(token.nodeId)) return false;
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
  if (!nodeId || !effectiveOrder(next).includes(nodeId)) return null;
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
  else if (token.nodeId && effectiveOrder(next).includes(token.nodeId)) {
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
  delete next.changed;
  next.stopEpoch = (next.stopEpoch ?? 0) + 1;
  next.revision++;
  return next;
}

/**
 * The map's cards differ from what the run accepted (a card added or removed meanwhile): the run pauses with its own reason and
 * remembers what differed. The stop generation rises, so every result still in flight is dropped and its attempt given back.
 * Idempotent while paused for the same reason.
 */
export function pauseForMap(data: BookPipelineData, change: { added: string[]; missing: string[] }): BookPipelineData {
  const next = clone(data);
  next.status = "stopped";
  next.pauseReason = "map";
  next.changed = { added: [...change.added], missing: [...change.missing] };
  delete next.failureCode;
  next.stopEpoch = (next.stopEpoch ?? 0) + 1;
  next.revision++;
  return next;
}

/**
 * "Carry on as before": the new cards are recorded as ignored, the missing ones become removed (terminal), the map's card set becomes
 * the accepted one and the run goes on (or waits for budget). A trial left with no card gets the first chapters that remain.
 */
export function acceptMapChange(
  data: BookPipelineData,
  mapIds: readonly string[],
  now: string,
  /** The trial of the cards that remain (`bookStructure().trialOf()`); absent: the first two. */
  trialOf?: (order: readonly string[]) => string[]
): BookPipelineData {
  const { added, missing } = mapDifference(data, mapIds);
  const next = clone(data);
  next.accepted = [...mapIds];
  if (added.length) next.ignored = [...new Set([...(next.ignored ?? []), ...added])];
  if (missing.length) next.removed = [...new Set([...(next.removed ?? []), ...missing])];
  const order = effectiveOrder(next);
  if (next.pendingReset) {
    next.pendingReset = next.pendingReset.filter(id => order.includes(id));
    if (!next.pendingReset.length) delete next.pendingReset;
  }
  if (next.trial && !next.trial.some(id => order.includes(id))) {
    next.trial = trialOf ? trialOf(order) : order.slice(0, FLAT_TRIAL);
    if (next.phase === "gate1") {
      next.phase = "planning";
      next.phaseStartedAt = now;
    }
  }
  next.status = "running";
  delete next.pauseReason;
  delete next.changed;
  delete next.failureCode;
  if (next.budget.used >= next.budget.limit) {
    next.status = "stopped";
    next.pauseReason = "budget";
  }
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
  delete next.changed;
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

/** Whether the card has used its one automatic redo (kept in the saved run, so reopening never gives another). */
export function autoFixesOf(data: BookPipelineData, nodeId: string): number {
  return data.autoFixes?.[nodeId] ?? 0;
}
/**
 * The one automatic redo of a card's text (author step only: the plan and the checklist stay): allowed while the run is writing (or the card is in the trial before gate 1) and the
 * card has not used it. The use is counted and the card's revision rises, so a proofread still in flight can no longer commit.
 * Not allowed: `accepted` is false and nothing changes. Attempts are not reset.
 */
export function requestAutoFix(data: BookPipelineData, nodeId: string): Committed {
  const inTrial = data.phase === "planning" && !!data.trial?.includes(nodeId);
  if (!effectiveOrder(data).includes(nodeId) || data.status !== "running" || (data.phase !== "writing" && !inTrial))
    return { state: data, accepted: false };
  if (autoFixesOf(data, nodeId) >= MAX_AUTO_FIXES) return { state: data, accepted: false };
  // A card whose write or proof already used every attempt would only be marked needs-review ("write failed") without running.
  const used = attemptsOf(data, nodeId);
  if (used.write >= MAX_STEP_ATTEMPTS || used.proof >= MAX_STEP_ATTEMPTS) return { state: data, accepted: false };
  const next = clone(data);
  next.autoFixes = { ...(next.autoFixes ?? {}), [nodeId]: autoFixesOf(data, nodeId) + 1 };
  next.revisions[nodeId] = cardRevision(next, nodeId) + 1;
  next.revision++;
  return { state: next, accepted: true };
}

/** The extra expand passes a card has used in this run (all fix rounds together). */
export function expandPassesOf(data: BookPipelineData, nodeId: string): number {
  return data.expandPasses?.[nodeId] ?? 0;
}
/** Counts one extra expand pass before it runs (saved with the run, so a resume keeps it). Not accepted once {@link BOOK_EXPAND_PASSES} are used. */
export function useExpandPass(data: BookPipelineData, nodeId: string): Committed {
  if (expandPassesOf(data, nodeId) >= BOOK_EXPAND_PASSES) return { state: data, accepted: false };
  const next = clone(data);
  next.expandPasses = { ...(next.expandPasses ?? {}), [nodeId]: expandPassesOf(data, nodeId) + 1 };
  next.revision++;
  return { state: next, accepted: true };
}

/**
 * After gate 1 a trial chapter that still needs a person gets the full book's fix round like every other chapter (live v5: two short
 * trial chapters were never fixed again): its automatic-redo count starts over once. Only in the writing phase, only for a trial card.
 */
export function reopenTrialFix(data: BookPipelineData, nodeId: string): Committed {
  if (
    data.phase !== "writing" ||
    data.status !== "running" ||
    !data.trial?.includes(nodeId) ||
    !autoFixesOf(data, nodeId)
  )
    return { state: data, accepted: false };
  const next = clone(data);
  if (next.autoFixes) delete next.autoFixes[nodeId];
  next.revision++;
  return { state: next, accepted: true };
}

/** A card was reset by the owner or needs another pass (single-card rerun): its counters and its stage start over. */
export function resetCard(data: BookPipelineData, nodeId: string): BookPipelineData {
  if (!effectiveOrder(data).includes(nodeId)) return data;
  const next = clone(data);
  next.attempts[nodeId] = emptyAttempts();
  if (next.expandPasses) delete next.expandPasses[nodeId];
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
