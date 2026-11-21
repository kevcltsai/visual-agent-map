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
  MAX_AI_FIX_ROUNDS,
  MAX_AUTO_FIXES,
  MAX_STEP_ATTEMPTS,
  attemptsOf,
  effectiveOrder,
  emptyAttempts,
  mapDifference,
  type AiProofOpen,
  type AiProofPending,
  type AiProofState,
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
  /** A written and checked chapter: the independent AI proofread (`ai_proof`) or the in-place fix it asked for (`ai_fix`). */
  | { type: "ai_proof"; nodeId: string }
  | { type: "ai_fix"; nodeId: string }
  /** Every chapter is done: the whole-book AI proofread, or the fix across chapters it asked for. */
  | { type: "book_ai_proof" }
  | { type: "book_ai_fix" }
  | { type: "advance_phase" };

/** The busy key of the whole-book AI proofread and its fix (never a card id). */
export const BOOK_PROOF_BUSY = "#book-proof";

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
 * Whether the run stops at a gate until the owner confirms. The one place that decides it: only the plan review waits (the direction is
 * the owner's); the trial's result and the final gate pass by themselves, the AI proofread being the check that follows.
 */
export function gateWaitsForPerson(_data: BookPipelineData, gate: PipelineGate): boolean {
  return gate === "plan";
}

/**
 * What may start now, from the saved state and the cards' stages (a card that is already in flight is the caller's business:
 * pass its node id in `busy` and it is skipped). Idempotent: running it twice without a reducer in between gives the same plan.
 */
export function nextActions(
  data: BookPipelineData,
  stages: CardStages,
  busy: ReadonlySet<string> = new Set(),
  options: {
    /** The runner can run the AI proofread (chapter and book). */ aiProof?: boolean;
    /** Chapters whose author side is not settled: an automatic redo (and its expansion) is queued, so their text will still change. */
    authorPending?: ReadonlySet<string>;
  } = {}
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
  if (data.phase === "gate1") {
    if (gateWaitsForPerson(data, data.planReview ? "plan" : "trial")) return { actions: [], hold: "gate1" };
    return { actions: [{ type: "advance_phase" }] };
  }
  if (data.phase === "gate2") {
    if (gateWaitsForPerson(data, "final")) return { actions: [], hold: "gate2" };
    // An older run parked at gate 2: the whole-book AI proofread still runs, then the run is done.
    if (options.aiProof && bookProofDue(data))
      return busy.size ? { actions: [] } : { actions: [bookProofAction(data)] };
    return busy.size ? { actions: [] } : { actions: [{ type: "advance_phase" }] };
  }
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
    // A chapter that needs a person's look needs the AI's check most: it is proofread too (a chapter with no text is closed without a call).
    if (
      (stage === "checked" || stage === "needs-review") &&
      options.aiProof &&
      !options.authorPending?.has(nodeId) &&
      aiChapterDue(data, nodeId)
    ) {
      actions.push({ type: data.aiProof?.[nodeId]?.step === "fix" ? "ai_fix" : "ai_proof", nodeId });
      continue;
    }
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
  if (data.phase === "writing" && options.aiProof && bookProofDue(data)) return { actions: [bookProofAction(data)] };
  return { actions: [{ type: "advance_phase" }] };
}

/* ---- The independent AI proofread (a chapter's, then the book's) and its in-place fixes ---- */

/** Whether a chapter still needs its AI proofread: not done, and the whole-book one has not begun (that begin is the fence against a loop). */
export function aiChapterDue(data: BookPipelineData, nodeId: string): boolean {
  if (data.bookProof || data.aiProof?.[nodeId]?.done) return false;
  return data.phase === "writing" || (data.phase === "planning" && !!data.trial?.includes(nodeId) && !data.planReview);
}
/**
 * A chapter's AI proofread was made for a text that a later (non-AI) write changed, and the whole-book proofread has not begun: the stale
 * slot is dropped so the chapter is proofread again on its final text (an AI fix keeps its slot current by rising the key with the revision).
 */
export function invalidateStaleAiChapters(data: BookPipelineData): Committed {
  if (data.bookProof || data.status !== "running" || (data.phase !== "writing" && data.phase !== "planning"))
    return { state: data, accepted: false };
  const stale = effectiveOrder(data).filter(id => {
    const slot = data.aiProof?.[id];
    const seen = slot?.done ? /^(\d+):/.exec(slot.key) : null;
    return !!seen && Number(seen[1]) !== cardRevision(data, id);
  });
  if (!stale.length) return { state: data, accepted: false };
  const next = clone(data);
  for (const id of stale) delete next.aiProof?.[id];
  next.revision++;
  return { state: next, accepted: true };
}
/** Whether the whole-book AI proofread still has to run (it is the last step before the book counts as done). */
export function bookProofDue(data: BookPipelineData): boolean {
  return !data.bookProof?.done;
}
const bookProofAction = (data: BookPipelineData): PipelineAction => ({
  type: data.bookProof?.step === "fix" ? "book_ai_fix" : "book_ai_proof"
});

/** A dispatched AI step: the run, stop generation, text (card revision and `key`), fix round and step it started under. `nodeId` absent = the whole book. */
export interface AiToken {
  runId: string;
  stopEpoch: number;
  nodeId?: string;
  revision: number;
  key: string;
  round: number;
  step: "proof" | "fix";
}
/** The shortest replacement that counts as "still there" when a later check quotes a longer stretch that contains it. */
export const STILL_PRESENT_MIN_CHARS = 8;
const aiSlot = (data: BookPipelineData, nodeId?: string): AiProofState | undefined =>
  nodeId === undefined ? data.bookProof : data.aiProof?.[nodeId];
function setAiSlot(next: BookPipelineData, nodeId: string | undefined, state: AiProofState): void {
  if (nodeId === undefined) next.bookProof = state;
  else next.aiProof = { ...(next.aiProof ?? {}), [nodeId]: state };
}
const aiCurrent = (data: BookPipelineData, token: AiToken): AiProofState | undefined => {
  if (data.runId !== token.runId || data.status !== "running" || (data.stopEpoch ?? 0) !== token.stopEpoch)
    return undefined;
  if (
    token.nodeId !== undefined &&
    (!effectiveOrder(data).includes(token.nodeId) || cardRevision(data, token.nodeId) !== token.revision)
  )
    return undefined;
  const slot = aiSlot(data, token.nodeId);
  return slot && !slot.done && slot.key === token.key && slot.round === token.round && slot.step === token.step
    ? slot
    : undefined;
};
/** Whether `token` still names the live step (the run, stop generation, text and round are unchanged): the write fence for a fix. */
export function isAiCurrent(data: BookPipelineData, token: AiToken): boolean {
  return aiCurrent(data, token) !== undefined;
}
/** Gives up a stuck AI step (it can never begin again): the slot is done and `incomplete`, never shown as all solved. */
export function abandonAi(data: BookPipelineData, nodeId?: string): BookPipelineData {
  const next = clone(data);
  const slot = aiSlot(next, nodeId);
  const base: AiProofState = slot ?? { key: "", attempts: 0, round: 0, step: "proof", checked: 0, fixed: 0, open: [] };
  const done: AiProofState = { ...base, done: true, incomplete: true };
  delete done.pending;
  setAiSlot(next, nodeId, done);
  next.revision++;
  return next;
}
/**
 * Starts an AI step: counts one attempt (saved before the call). A first begin, or one for a text that changed meanwhile (a hand edit),
 * starts the proofread over from the check. Null when it may not start: stopped, finished, the step used up its attempts, a card that is
 * gone, or a `step` that is not the next one.
 */
export function beginAiStep(
  data: BookPipelineData,
  scope: {
    nodeId?: string;
    /** One chapter written again after the book was proofread: its chapter proofread starts again in any phase. */ rerun?: boolean;
  },
  key: string,
  step: "proof" | "fix"
): { state: BookPipelineData; token: AiToken } | null {
  const nodeId = scope.nodeId;
  if (data.status !== "running") return null;
  if (!(scope.rerun && nodeId !== undefined)) {
    if (data.phase === "done") return null;
    if (nodeId === undefined ? data.phase !== "writing" && data.phase !== "gate2" : !aiChapterDue(data, nodeId))
      return null;
  }
  if (nodeId !== undefined && !effectiveOrder(data).includes(nodeId)) return null;
  const found = aiSlot(data, nodeId);
  if (found?.done) return null;
  const fresh = !found || found.key !== key;
  if (fresh && step !== "proof") return null;
  const slot: AiProofState = fresh
    ? { key, attempts: 0, round: 0, step: "proof", checked: 0, fixed: 0, open: [] }
    : { ...found };
  if (slot.step !== step || slot.attempts >= MAX_STEP_ATTEMPTS) return null;
  slot.attempts++;
  const next = clone(data);
  setAiSlot(next, nodeId, slot);
  next.revision++;
  return {
    state: next,
    token: {
      runId: next.runId,
      stopEpoch: next.stopEpoch ?? 0,
      ...(nodeId !== undefined ? { nodeId } : {}),
      revision: nodeId !== undefined ? cardRevision(next, nodeId) : 0,
      key,
      round: slot.round,
      step
    }
  };
}
const withOpen = (
  open: readonly AiProofOpen[],
  pending: readonly AiProofPending[],
  reasonOf: (id: string) => string
): AiProofOpen[] => [
  ...open,
  ...pending.map(item => ({
    id: item.id,
    ...(item.chapter ? { chapter: item.chapter } : {}),
    quote: item.quote,
    problem: item.problem,
    reason: reasonOf(item.id)
  }))
];
/**
 * A proofread call finished. `pending` are the fixable problems found, `open` the ones no edit can fix (the proofreader's own verdict).
 * Fixable problems and rounds left: the next step is a fix. Otherwise the proofread is done, and the fixable ones left are open
 * (`still_present`, or the reason a fix was blocked). A result under an old token is dropped.
 */
export function applyAiProof(
  data: BookPipelineData,
  token: AiToken,
  result: { checked: number; pending: readonly AiProofPending[]; open: readonly AiProofOpen[] }
): Committed {
  const found = token.step === "proof" ? aiCurrent(data, token) : undefined;
  if (!found) return { state: data, accepted: false };
  const next = clone(data);
  const slot: AiProofState = { ...found, checked: Math.max(found.checked, result.checked), attempts: 0 };
  delete slot.pending;
  if (result.pending.length && slot.round < MAX_AI_FIX_ROUNDS) {
    slot.step = "fix";
    // Ids are renumbered by every check: an earlier refusal follows its quote to the new id, and is dropped when no new problem has it.
    const same = (a: AiProofPending, b: AiProofPending): boolean =>
      a.quote.replace(/\s+/g, "") === b.quote.replace(/\s+/g, "") && (a.chapter ?? 1) === (b.chapter ?? 1);
    const carried: Record<string, string> = {};
    for (const [oldId, reason] of Object.entries(found.refused ?? {})) {
      const old = (found.pending ?? []).find(target => target.id === oldId);
      const now = old ? result.pending.find(item => same(item, old)) : undefined;
      if (now) carried[now.id] = reason;
    }
    if (Object.keys(carried).length) slot.refused = carried;
    else delete slot.refused;
    slot.pending = result.pending.map(item => ({ ...item }));
    slot.open = result.open.map(item => ({ ...item }));
  } else {
    slot.done = true;
    // Ids are renumbered by every check, so an item is matched to the last fix round's targets by its quote: a match keeps that
    // target's blocked reason (or is still present); one the earlier rounds never saw (first found in this last check) was not fixed in time.
    const squash = (text: string): string => text.replace(/\s+/g, "");
    const prior = found.pending ?? [];
    slot.open = withOpen(result.open, result.pending, id => {
      const item = result.pending.find(entry => entry.id === id);
      const before = item
        ? prior.find(
            target => squash(target.quote) === squash(item.quote) && (target.chapter ?? 1) === (item.chapter ?? 1)
          )
        : undefined;
      // A quote that is (part of) text a fix round wrote: the fix was applied and the problem is still there.
      const quote = item ? squash(item.quote) : "";
      // A short replacement (a year, a name) inside a longer quote of something else proves nothing: that direction needs a sentence.
      const written =
        quote &&
        (found.applied ?? []).some(text => {
          const wrote = squash(text);
          return wrote.includes(quote) || (wrote.length >= STILL_PRESENT_MIN_CHARS && quote.includes(wrote));
        });
      // The reason of the quote's last fix event (D6): blocked, or written and still there; a target no round wrote or blocked was not fixed.
      if (before) return slot.refused?.[before.id] ?? (written ? "still_present" : "not_fixed");
      return written ? "still_present" : "not_fixed_in_time";
    });
  }
  setAiSlot(next, token.nodeId, slot);
  next.revision++;
  return { state: next, accepted: true };
}
/**
 * A fix call finished. `applied` places were changed (in `changed`, the cards whose text changed: their revision rises, and `key` is the
 * new text's key), `refused` maps the ids whose edit was blocked to the reason. The fix round is spent; the next step is the re-check.
 */
export function applyAiFix(
  data: BookPipelineData,
  token: AiToken,
  result: {
    applied: number;
    refused?: Readonly<Record<string, string>>;
    /** The replacement texts that were written this round (kept so a later check can tell "fixed, still there" from "found too late"). */
    replacements?: readonly string[];
    /** The sentence written for each fixed id; recorded on the fix so the chapter's box can say what is now in the text. */
    replacementOf?: Readonly<Record<string, string>>;
    /** Whole-book fix: target id to the card it was written into (recorded on each fix, so that chapter's box can tell it). */
    cardOf?: Readonly<Record<string, string>>;
    /** The ids whose edit was written; when given, only these become fixes (a target the model skipped is neither). */
    appliedIds?: readonly string[];
    key?: string;
    changed?: readonly string[];
  }
): Committed {
  const found = token.step === "fix" ? aiCurrent(data, token) : undefined;
  if (!found) return { state: data, accepted: false };
  const next = clone(data);
  const slot: AiProofState = {
    ...found,
    key: result.key ?? found.key,
    attempts: 0,
    round: found.round + 1,
    step: "proof",
    fixed: found.fixed + result.applied,
    // `found.refused` already names this round's targets (see applyAiProof); this round's refusals are added.
    refused: { ...(found.refused ?? {}), ...(result.refused ?? {}) }
  };
  if (result.replacements?.length) slot.applied = [...(found.applied ?? []), ...result.replacements];
  for (const id of result.appliedIds ?? []) delete slot.refused?.[id];
  // `pending` stays: the next check reads it as the earlier findings (`priorOf`); the next `applyAiProof` replaces it.
  if (!Object.keys(slot.refused ?? {}).length) delete slot.refused;
  // What this call changed, as described: every target of the call that was not blocked (each is applied or refused).
  const blocked = result.refused ?? {};
  const written = result.appliedIds ? new Set(result.appliedIds) : undefined;
  const done =
    result.applied > 0
      ? (found.pending ?? []).filter(item => (written ? written.has(item.id) : !(item.id in blocked)))
      : [];
  if (done.length)
    slot.fixes = [
      ...(found.fixes ?? []),
      ...done.map(item => ({
        ...item,
        ...(result.cardOf?.[item.id] ? { chapterId: result.cardOf[item.id] } : {}),
        ...(result.replacementOf?.[item.id] ? { replacement: result.replacementOf[item.id] } : {})
      }))
    ];
  for (const id of result.changed ?? [])
    if (effectiveOrder(next).includes(id)) next.revisions[id] = cardRevision(next, id) + 1;
  setAiSlot(next, token.nodeId, slot);
  next.revision++;
  return { state: next, accepted: true };
}
/**
 * An AI call failed (the attempt was counted at its start). Its third failure ends the proofread for good: a failed check is
 * `incomplete` (never shown as all solved), a failed fix leaves its problems open as `fix_failed` and opens no further round.
 */
export function applyAiFailure(data: BookPipelineData, token: AiToken): Committed & { finished?: boolean } {
  const found = aiCurrent(data, token);
  if (!found) return { state: data, accepted: false };
  const next = clone(data);
  const slot: AiProofState = { ...found };
  if (slot.attempts >= MAX_STEP_ATTEMPTS) {
    slot.done = true;
    if (slot.step === "proof") slot.incomplete = true;
    else slot.open = withOpen(slot.open, slot.pending ?? [], () => "fix_failed");
    delete slot.pending;
  }
  setAiSlot(next, token.nodeId, slot);
  next.revision++;
  return { state: next, accepted: true, ...(slot.done ? { finished: true } : {}) };
}
/** An AI call was stopped (or the budget ran out): the attempt is given back, nothing is written; with `budget` the run pauses for it. */
export function applyAiStopped(data: BookPipelineData, token: AiToken, budget: boolean): Committed {
  if (data.runId !== token.runId) return { state: data, accepted: false };
  const next = clone(data);
  const slot = aiSlot(next, token.nodeId);
  if (slot && !slot.done && slot.key === token.key && slot.round === token.round && slot.step === token.step)
    slot.attempts = Math.max(0, slot.attempts - 1);
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
  else if (next.phase === "gate1" && !gateWaitsForPerson(next, next.planReview ? "plan" : "trial"))
    next.phase = "writing";
  else if (next.phase === "gate2" && !gateWaitsForPerson(next, "final")) next.phase = "done";
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
    if (next.aiProof) delete next.aiProof[id];
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
    if (next.aiProof) delete next.aiProof[id];
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

/** A card was reset by the owner or needs another pass (single-card rerun): its counters and its stage start over. */
export function resetCard(data: BookPipelineData, nodeId: string): BookPipelineData {
  if (!effectiveOrder(data).includes(nodeId)) return data;
  const next = clone(data);
  next.attempts[nodeId] = emptyAttempts();
  if (next.expandPasses) delete next.expandPasses[nodeId];
  if (next.aiProof) delete next.aiProof[nodeId];
  // The whole-book fixes that rewrote this chapter's old text no longer describe it: its box must not list them.
  // The bar's fixed count drops with them, so the boxes still add up to the bar.
  if (next.bookProof?.fixes) {
    const kept = next.bookProof.fixes.filter(fix => fix.chapterId !== nodeId);
    next.bookProof.fixed = Math.max(0, next.bookProof.fixed - (next.bookProof.fixes.length - kept.length));
    next.bookProof.fixes = kept;
  }
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
