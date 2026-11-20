import type { TranslationKey } from "../../i18n";
import { t } from "../../i18n";
import { isBookStepError } from "../../core/steps/book-pipeline/base";
import { splitLengthIssue, type LengthReason } from "../../core/book-pipeline/settings";
import { splitPictureIssue } from "../../core/book-pipeline/image-slots";
import { joinReasons } from "./book-pipeline-reasons";
import {
  effectiveOrder,
  mapDifference,
  readBookRole,
  readPipelineStage,
  type BookPipelineData,
  type BookRole,
  type PipelineStage
} from "../../core/book-pipeline/model";
import {
  BookPipelineRunError,
  type BookPipelineProgress,
  type BookRunRefusal,
  type BookSubStep
} from "./book-pipeline-run";

/**
 * Picture-book pipeline screen parts (03b): the map's top progress bar, the card badges and the refusal messages.
 * Everything here is drawn only for a map that has `bookPipeline`; a map without it never reaches these functions, so it
 * gets no new element. Text never relies on color alone (every state and role has a word).
 */

export type BookBarMode = "planning" | "gate1" | "writing" | "gate2" | "done" | "stopped" | "budget" | "changed";

export interface BookBarState {
  mode: BookBarMode;
  /** The phase the run is in (the stopped line names it). */
  phase: BookPipelineData["phase"];
  total: number;
  counts: Record<PipelineStage | "pending", number>;
  budget: { used: number; limit: number };
  /** The run paused because the map's cards changed: how many chapters were added and removed (counts only, never ids). */
  /** `reordered`: a finished book whose map has the same chapters in another order (no count to show). */
  mapChange?: { added: number; missing: number; reordered?: true };
  /** The neutral code of why the run stopped by itself; the bar shows it in words and offers "retry". */
  failure?: string;
  /** Seconds left, as the runner estimated them (only after at least five cards of the phase finished); absent means no number is shown. */
  etaSeconds?: number;
  /** The whole-book plan is saved. */
  globalDone: boolean;
  /** What the run is doing right now (memory only; absent after a reload or while nothing runs). */
  current?: BookCurrent;
  /** The whole-book consistency check is running (no chapter step is): the sentence says so instead of "writing". */
  checking?: true;
  /** The run has a trial (the first chapters before gate 1): while it is planning, the bar says which trial chapter is written. */
  trialSize?: number;
  /** A single-card rerun is in progress (memory only): the bar keeps its stop button; the card itself says "working". */
  rerun?: true;
  /** Gate 1: how many chapters the trial has ("the 3 trial chapters are written"); absent for a run without a trial. */
  trialCount?: number;
  /** Gate 1 before the trial: every chapter is planned and the owner looks at the plan (try the trial, or skip it). */
  planReview?: true;
  /** Gate 1: how many of the trial chapters need a look (shown after the trial sentence; nothing when 0). */
  trialAttention?: number;
  /** Gate 2: the chapters written and how many still need a look; the view fills it from the notes (see its `bookReviewCount`). */
  review?: { total: number; attention: number; seam?: number };
}
export interface BookCurrent {
  /** The whole-book plan, or a chapter step. */
  step: "global" | "plan" | "write" | "images" | "proof";
  /** 1-based position in the reading order; absent for the whole-book plan. */
  chapter?: number;
  /** Every chapter in work is in its one automatic fix round: the sentence keeps the whole-book count instead of going back to an early chapter. */
  fix?: true;
}

const FAILURE_KEY: Record<string, TranslationKey> = {
  invalid_reply: "ui.book_fail_invalid_reply",
  backup_failed: "ui.book_fail_backup",
  discarded: "ui.book_fail_discarded",
  card_removed: "ui.book_fail_card_removed",
  missing: "ui.book_fail_card_removed"
};
/** A failure code in words (the code itself is never shown; an unknown one reads as an unexpected error). */
export const bookFailureText = (code: string): string => t(FAILURE_KEY[code] ?? "ui.book_fail_other");

const PHASE_KEY: Record<BookPipelineData["phase"], TranslationKey> = {
  planning: "ui.book_phase_planning",
  gate1: "ui.book_phase_gate1",
  writing: "ui.book_phase_writing",
  gate2: "ui.book_phase_gate2",
  done: "ui.book_phase_done"
};

/**
 * What the bar shows. The live numbers come from the runner (`getBookPipelineProgress`); after a reload the runner has none,
 * so the saved state and the cards' stages stand in, and a run that was "running" with nothing driving it reads as stopped.
 * `mapIds` (the map's cards in reading order, as the runner reads them): a run paused for a map change counts what differs now, so a
 * card added or removed after the pause is counted at once (the runner's numbers are from the moment it paused).
 */
export function bookBarState(
  data: BookPipelineData,
  progress: BookPipelineProgress | undefined,
  stageOf: (nodeId: string) => PipelineStage | undefined,
  mapIds?: readonly string[]
): BookBarState {
  // The saved "done" of the same run is final: a runner record that still says gate2 is older than the owner's acceptance.
  const savedDone = data.phase === "done" && (!progress || progress.runId === data.runId);
  const phase = savedDone ? "done" : (progress?.phase ?? data.phase);
  const status = savedDone ? data.status : (progress?.status ?? data.status);
  const pauseReason = progress ? progress.pauseReason : data.pauseReason;
  const active = progress?.active ?? false;
  const order = effectiveOrder(data);
  const counts = progress?.counts ?? countStages(order.map(stageOf));
  const total = progress?.total ?? order.length;
  const budget = progress?.budget ?? data.budget;
  const failure = progress ? progress.failureCode : data.failureCode;
  const interrupted = (phase === "planning" || phase === "writing") && !active;
  const mapChange =
    status === "stopped" && pauseReason === "map" && !active
      ? mapIds
        ? countChange(mapDifference(data, mapIds))
        : (progress?.mapChange ?? {
            added: data.changed?.added.length ?? 0,
            missing: data.changed?.missing.length ?? 0
          })
      : undefined;
  // Waiting at a gate, or a finished book: the same wording shows a map that differs from the book's chapters (a line only; nothing
  // is planned again on its own).
  // A finished book is final whatever its saved status or the runner's last record say.
  const gateChange =
    !mapChange &&
    mapIds &&
    (phase === "done" || (!active && status !== "stopped" && (phase === "gate1" || phase === "gate2")))
      ? countChange(mapDifference(data, mapIds))
      : undefined;
  // A finished book whose chapters only moved (a topic moved, nothing added or removed): the same line, without counts.
  const reordered =
    phase === "done" && gateChange && !gateChange.added && !gateChange.missing && mapIds
      ? sameOrder(order, mapIds)
        ? undefined
        : { added: 0, missing: 0, reordered: true as const }
      : undefined;
  const mode: BookBarMode = mapChange
    ? "changed"
    : status === "stopped" && pauseReason === "budget"
      ? "budget"
      : status === "stopped" || interrupted
        ? "stopped"
        : phase;
  const current = mode === "planning" || mode === "writing" ? currentOf(data, progress, stageOf) : undefined;
  const rerunning = !!progress?.active && !!progress.rerun && order.includes(progress.rerun.nodeId);
  return {
    mode,
    phase,
    total,
    counts,
    budget,
    globalDone: data.globalPlanned === true,
    ...(current ? { current } : {}),
    ...(!current && mode === "writing" && active && data.consistency?.done === false
      ? { checking: true as const }
      : {}),
    ...(data.trial?.length && !data.planReview && mode === "planning" && data.globalPlanned
      ? { trialSize: data.trial.length }
      : {}),
    ...(rerunning ? { rerun: true as const } : {}),
    ...(mapChange ? { mapChange } : {}),
    ...(gateChange && (gateChange.added || gateChange.missing) ? { mapChange: gateChange } : {}),
    ...(reordered ? { mapChange: reordered } : {}),
    ...(mode === "gate1" && data.trial?.length
      ? data.planReview
        ? { planReview: true as const, trialCount: data.trial.length }
        : { trialCount: data.trial.length }
      : {}),
    ...(mode === "stopped" && pauseReason === "failed" && failure ? { failure } : {}),
    ...(progress?.etaSeconds !== undefined && Number.isFinite(progress.etaSeconds) && progress.etaSeconds >= 0
      ? { etaSeconds: progress.etaSeconds }
      : {})
  };
}

/** Whether the map lists the book's chapters in the book's order (cards that are not chapters are skipped). */
const sameOrder = (order: readonly string[], mapIds: readonly string[]): boolean => {
  const chapters = new Set(order);
  return mapIds.filter(id => chapters.has(id)).join("\n") === order.join("\n");
};
const mapChangeText = (change: NonNullable<BookBarState["mapChange"]>): string =>
  change.reordered ? t("ui.book_map_reordered") : t("ui.book_map_changed_0_1", change.added, change.missing);

const countChange = (change: { added: string[]; missing: string[] }): { added: number; missing: number } => ({
  added: change.added.length,
  missing: change.missing.length
});

/**
 * The run's busiest-first card for the progress sentence: the whole-book plan first, then the earliest chapter in the reading order.
 * A chapter whose run is over (proofread, or stopped for a person) is no longer named, and a chapter in its fix round keeps the fix
 * line until it is done, also between two of its steps (no step in work then).
 */
function currentOf(
  data: BookPipelineData,
  progress: BookPipelineProgress | undefined,
  stageOf: (nodeId: string) => PipelineStage | undefined
): BookCurrent | undefined {
  if (!progress?.active) return undefined;
  const order = effectiveOrder(data);
  const position = (nodeId: string): number => (nodeId === "global" ? -1 : order.indexOf(nodeId));
  const settled = (nodeId: string): boolean => {
    const stage = stageOf(nodeId);
    return stage === "checked" || stage === "needs-review";
  };
  // A chapter in its automatic fix round is not "the chapter being written": a first-time chapter in work is named instead.
  const fixing = (nodeId: string): boolean =>
    nodeId !== "global" && (data.autoFixes?.[nodeId] ?? 0) > 0 && !settled(nodeId);
  const entries = (progress.current ?? []).filter(
    item => item.nodeId === "global" || (position(item.nodeId) >= 0 && !settled(item.nodeId))
  );
  if (!entries.length) {
    const waiting = order.find(fixing);
    return waiting ? { step: "write", chapter: position(waiting) + 1, fix: true } : undefined;
  }
  entries.sort((a, b) => position(a.nodeId) - position(b.nodeId));
  const first = entries.find(item => !fixing(item.nodeId)) ?? entries[0];
  if (first.nodeId === "global") return { step: "global" };
  return {
    step: first.step,
    chapter: position(first.nodeId) + 1,
    ...(fixing(first.nodeId) ? { fix: true as const } : {})
  };
}

function countStages(stages: (PipelineStage | undefined)[]): Record<PipelineStage | "pending", number> {
  const counts = { pending: 0, planned: 0, written: 0, checked: 0, "needs-review": 0 };
  for (const stage of stages) counts[stage ?? "pending"]++;
  return counts;
}

export interface BookBarActions {
  stop: () => void;
  resume: () => void;
  /** "Reconfigure and start over" (a run stopped in any phase before done); a bar drawn without it shows no such button. */
  restart?: () => void;
  /** The map changed: "plan again" (the restart path) and "carry on as before"; the bar shows both only in that state. */
  mapChanged?: { replan: () => void; keep: () => void };
  /** "Give up this book" (stopped) and "remove the picture book" (done): the in-bar confirmation card; a bar drawn without it shows no such button. */
  abandon?: { asking: boolean; ask: () => void; cancel: () => void; confirm: () => void };
  addBudget: () => void;
  confirmGate1: () => void;
  /** Gate 1: "open chapter 1" (the first trial chapter's note); a bar drawn without it shows no such link. */
  openTrial?: () => void;
  /** The plan review: "open the whole-book plan" (the root note), "run the trial"; the trial's gate 1: "back to the plan". */
  openPlan?: () => void;
  startTrial?: () => void;
  backToPlan?: () => void;
  /** Gate 1: the first press found unapplied notes in the trial; the bar asks once. `focus`: where the keyboard goes after this paint. */
  gate1Ask?: { count: number; cancel: () => void; confirm: () => void; focus?: "go" | "opener" };
  /** Gate 2 or done: a card rerun found a hand-edited chapter; the bar asks once before it overwrites it (decision G). */
  rerunAsk?: { cancel: () => void; confirm: () => void; focus?: "go" | "opener" };
  /** Gate 2: the link that opens the next chapter that needs a look (the view cycles in reading order). */
  nextReview?: () => void;
  /** Gate 2: "review finished". With chapters left (`state.review.attention` > 0) the bar asks once in place before it calls `confirm`. */
  finish?: {
    asking: boolean;
    ask: () => void;
    cancel: () => void;
    confirm: () => void;
    /** Where the keyboard goes after this paint (the view applies it once the bar is in the document). */
    focus?: "go" | "opener";
  };
}

export function bookTitleText(state: BookBarState): string {
  const word =
    state.mode === "stopped" || state.mode === "changed"
      ? t("ui.book_phase_stopped")
      : state.mode === "budget"
        ? t("ui.book_phase_budget")
        : state.mode === "gate1" && state.planReview
          ? t("ui.book_phase_plan_review")
          : state.mode === "gate1" && state.trialCount
            ? t("ui.book_phase_trial_review")
            : t(PHASE_KEY[state.mode]);
  return t("ui.book_bar_title_0", word);
}

/** "About N minutes left" from seconds, rounded to the minute; under half a minute it says "under 1 minute". */
export function bookEtaText(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  return minutes < 1 ? t("ui.book_eta_under_minute") : t("ui.book_eta_0", minutes);
}

/** The top progress bar. `parent` is the map's toolbar; the caller decides it is a book-pipeline map. */
export function renderBookBar(parent: HTMLElement, state: BookBarState, actions: BookBarActions): HTMLElement {
  const { counts, total } = state;
  const bar = parent.createDiv("vam-book-bar");
  bar.dataset.mode = state.mode;
  bar.setAttr("role", "group");
  bar.setAttr("aria-label", t("ui.book_bar_label"));
  const top = bar.createDiv("vam-book-bar-top");
  top.createEl("b", { cls: "vam-book-bar-title", text: bookTitleText(state) });
  // Stopped and budget runs keep their one sentence; every other state is told by the stage list below.
  if (state.mode === "budget" || state.mode === "stopped")
    top.createSpan({
      cls: "vam-book-bar-counts",
      text:
        state.mode === "budget"
          ? t("ui.book_budget_used_up_0_1", state.budget.used, state.budget.limit)
          : state.failure
            ? t("ui.book_failed_at_0_1", t(PHASE_KEY[state.phase]), bookFailureText(state.failure))
            : t("ui.book_stopped_at_0_1_2", t(PHASE_KEY[state.phase]), counts.checked, total)
    });
  const buttons = top.createDiv("vam-book-bar-actions");
  if (state.mode === "changed" && state.mapChange) {
    top.createSpan({
      cls: "vam-book-bar-counts vam-book-map-changed",
      text: t("ui.book_map_changed_0_1", state.mapChange.added, state.mapChange.missing)
    });
    buttons.setAttr("role", "group");
    buttons.setAttr("aria-label", t("ui.book_map_changed_0_1", state.mapChange.added, state.mapChange.missing));
    if (actions.mapChanged) {
      makeButton(buttons, t("ui.book_map_replan"), "mod-cta vam-book-map-replan", actions.mapChanged.replan);
      makeButton(buttons, t("ui.book_map_keep"), "vam-book-map-keep", actions.mapChanged.keep);
    }
    makeButton(buttons, t("ui.book_stop"), "mod-warning vam-book-stop", actions.stop);
  }
  if ((state.mode === "gate1" || state.mode === "gate2" || state.mode === "done") && state.mapChange)
    top.createSpan({ cls: "vam-book-bar-counts vam-book-map-changed", text: mapChangeText(state.mapChange) });
  if (state.mode === "gate1" && state.planReview) {
    top.createSpan({ cls: "vam-book-bar-counts", text: t("ui.book_bar_plan_ready_0", total) });
    top.createSpan({ cls: "vam-book-bar-counts vam-book-plan-hint", text: t("ui.book_bar_plan_hint") });
    if (actions.openPlan)
      makeButton(buttons, t("ui.book_bar_open_plan"), "vam-book-link vam-book-open-plan", actions.openPlan);
    if (actions.startTrial)
      makeButton(
        buttons,
        t("ui.book_bar_start_trial_0", state.trialCount ?? 0),
        "mod-cta vam-book-start-trial",
        actions.startTrial
      );
  } else if (state.mode === "gate1" && state.trialCount) {
    top.createSpan({
      cls: "vam-book-bar-counts",
      text: state.trialAttention
        ? t("ui.book_bar_trial_review_0_1", state.trialCount, state.trialAttention)
        : t("ui.book_bar_trial_ready_0", state.trialCount)
    });
    if (actions.openTrial)
      makeButton(buttons, t("ui.book_bar_open_first"), "vam-book-link vam-book-open-first", actions.openTrial);
    if (actions.backToPlan && !state.rerun)
      makeButton(buttons, t("ui.book_bar_back_to_plan"), "vam-book-back-to-plan", actions.backToPlan);
  }
  if (state.mode === "gate2" && state.review) {
    top.createSpan({
      cls: "vam-book-bar-counts",
      text: state.review.seam
        ? t(
            "ui.book_bar_review_seam_0_1_2",
            state.review.total,
            state.review.attention - state.review.seam,
            state.review.seam
          )
        : t("ui.book_bar_review_0_1", state.review.total, state.review.attention)
    });
    if (actions.nextReview && state.review.attention > 0)
      makeButton(buttons, t("ui.book_bar_next_review"), "vam-book-link vam-book-next-review", actions.nextReview);
  }
  if (state.phase === "gate1" && state.mode !== "done" && state.mode !== "stopped") {
    // At the plan review the same confirmation skips the trial (a plain button: the trial is the suggested way).
    if (state.mode === "gate1" && state.planReview)
      makeButton(buttons, t("ui.book_skip_trial"), "vam-book-confirm vam-book-skip-trial", actions.confirmGate1);
    else makeButton(buttons, t("ui.book_confirm_gate1"), "mod-cta vam-book-confirm", actions.confirmGate1);
  }
  if (state.mode === "gate2" && actions.finish && state.review) {
    // Nothing left to look at: finish at once; otherwise the first press asks in place.
    const left = (state.review?.attention ?? 0) > 0;
    const finish = makeButton(
      buttons,
      t("ui.book_bar_finish"),
      "mod-cta vam-book-finish",
      left ? actions.finish.ask : actions.finish.confirm
    );
    finish.dataset.act = "finish";
    finish.setAttr("aria-expanded", String(actions.finish.asking));
  }
  if (state.mode === "budget") {
    makeButton(buttons, t("ui.book_add_budget"), "mod-cta vam-book-add-budget", actions.addBudget);
    makeButton(buttons, t("ui.book_stop"), "vam-book-stop", actions.stop);
  } else if (state.mode === "stopped") {
    makeButton(
      buttons,
      t(state.failure ? "ui.book_retry" : "ui.book_resume"),
      "mod-cta vam-book-resume",
      actions.resume
    );
    if (actions.restart && state.phase !== "done")
      makeButton(buttons, t("ui.book_restart"), "vam-book-restart", actions.restart);
  } else if (state.mode === "planning" || state.mode === "writing")
    makeButton(buttons, t("ui.book_stop"), "mod-warning vam-book-stop", actions.stop);
  // At a gate nothing runs unless a trial retry or a card rerun does (their own stop is below); stopping only holds the run.
  else if ((state.mode === "gate1" || state.mode === "gate2") && !state.rerun)
    makeButton(buttons, t("ui.book_stop"), "mod-warning vam-book-stop", actions.stop);
  if (state.rerun) makeButton(buttons, t("ui.book_stop"), "mod-warning vam-book-stop", actions.stop);
  if (actions.abandon && (state.mode === "stopped" || state.mode === "budget" || state.mode === "done")) {
    const abandon = actions.abandon;
    const ask = makeButton(
      buttons,
      t(state.mode === "done" ? "ui.book_remove" : "ui.book_abandon"),
      "vam-book-abandon",
      abandon.ask
    );
    ask.setAttr("aria-expanded", String(abandon.asking));
  }
  if (actions.abandon?.asking && (state.mode === "stopped" || state.mode === "budget" || state.mode === "done")) {
    const abandon = actions.abandon;
    const card = bar.createDiv("vam-book-abandon-card");
    card.setAttr("role", "group");
    card.setAttr("aria-label", t("ui.book_abandon_title"));
    card.createEl("b", { text: t("ui.book_abandon_title") });
    card.createEl("p", { text: t("ui.book_abandon_body") });
    const row = card.createDiv("vam-book-abandon-actions");
    makeButton(row, t("ui.cancel"), "vam-book-abandon-cancel", abandon.cancel);
    makeButton(row, t("ui.book_abandon_confirm"), "mod-warning vam-book-abandon-confirm", abandon.confirm);
  }
  if (state.mode === "gate1" && actions.gate1Ask)
    renderAsk(
      bar,
      "vam-book-gate1-ask",
      t("ui.book_bar_notes_ask_0", actions.gate1Ask.count),
      t("ui.book_bar_go_anyway"),
      actions.gate1Ask
    );
  if (state.mode === "gate2" && actions.finish?.asking && state.review && state.review.attention > 0)
    renderAsk(
      bar,
      "vam-book-finish-ask",
      t("ui.book_bar_finish_ask_0", state.review.attention),
      t("ui.book_bar_finish_go"),
      actions.finish
    );
  if ((state.mode === "gate2" || state.mode === "done") && actions.rerunAsk)
    renderAsk(
      bar,
      "vam-book-rerun-ask",
      t("ui.book_rerun_overwrite_ask"),
      t("ui.book_rerun_overwrite_go"),
      actions.rerunAsk
    );
  const progressText = bookProgressText(state);
  renderProgressLine(bar, state, progressText);
  const track = bar.createDiv("vam-book-track");
  track.setAttr("role", "progressbar");
  track.setAttr("aria-label", t("ui.book_bar_label"));
  track.setAttr("aria-valuemin", "0");
  track.setAttr("aria-valuemax", String(total));
  track.setAttr("aria-valuenow", String(counts.checked));
  track.setAttr("aria-valuetext", progressText);
  const segments: [string, number][] = [
    ["checked", counts.checked],
    ["written", counts.written],
    ["planned", counts.planned],
    ["needs-review", counts["needs-review"]]
  ];
  for (const [name, count] of segments) {
    if (!count || !total) continue;
    track.createSpan({ cls: `vam-book-seg is-${name}` }).style.width = `${(count / total) * 100}%`;
  }
  return bar;
}

/** The in-bar question (no modal): a sentence, Cancel and the answer button; Escape cancels. Same card as the abandon one. */
function renderAsk(
  bar: HTMLElement,
  cls: string,
  question: string,
  goText: string,
  ask: { cancel: () => void; confirm: () => void; focus?: "go" | "opener" }
): void {
  const card = bar.createDiv(`vam-book-abandon-card ${cls}`);
  card.setAttr("role", "group");
  card.setAttr("aria-label", question);
  card.createEl("p", { text: question });
  const row = card.createDiv("vam-book-abandon-actions");
  makeButton(row, t("ui.cancel"), "vam-book-ask-cancel", ask.cancel);
  makeButton(row, goText, "mod-warning vam-book-ask-go", ask.confirm);
  card.addEventListener("keydown", event => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    event.preventDefault();
    ask.cancel();
  });
}

/** Chapters whose run is over (proofread, or stopped for a person): the "done" count of the one progress sentence. */
const settledCount = (state: BookBarState): number => state.counts.checked + state.counts["needs-review"];

/** The one sentence of the bar: "Writing chapter 3/31 · 2/31 done"; the whole-book plan and the chapter plans have their own words. */
export function bookProgressText(state: BookBarState): string {
  const { total } = state;
  if (state.mode === "planning" && state.trialSize && state.current?.step !== "global") {
    // The trial chapters go all the way to the proofread before gate 1; the first chapters of the reading order are the trial's.
    // Only fix rounds in work: a named fix line with the trial's done count, never "chapter 1/3" again.
    if (state.current?.fix)
      return t(
        "ui.book_progress_line_fix_0_1_2",
        state.current.chapter ?? 1,
        Math.min(settledCount(state), state.trialSize),
        state.trialSize
      );
    const settled = Math.min(state.counts.checked + state.counts["needs-review"], state.trialSize - 1);
    return t(
      "ui.book_progress_line_trial_0_1",
      Math.min(state.current?.chapter ?? settled + 1, state.trialSize),
      state.trialSize
    );
  }
  const at = Math.min(state.current?.chapter ?? settledCount(state) + 1, Math.max(total, 1));
  // Writing the whole book is one plain line ("Writing chapter 3/31"): the bar below shows how many are done.
  if (state.mode === "writing" && state.checking)
    return t("ui.book_progress_line_check_0_1", settledCount(state), total);
  if (state.mode === "writing")
    // Only fix rounds in work: a named fix line with the whole-book done count, never a restarted counter.
    return state.current?.fix
      ? t("ui.book_progress_line_fix_0_1_2", state.current.chapter ?? 1, settledCount(state), total)
      : t("ui.book_progress_line_write_0_1", at, total);
  const sentence =
    state.mode === "planning"
      ? !state.globalDone || state.current?.step === "global"
        ? t("ui.book_progress_line_global")
        : t("ui.book_progress_line_plan_0_1", at, total)
      : t("ui.book_progress_line_write_0_1", at, total);
  return `${sentence}${t("ui.book_progress_line_sep")}${t("ui.book_progress_line_done_0_1", settledCount(state), total)}`;
}
function renderProgressLine(bar: HTMLElement, state: BookBarState, text: string): void {
  const running = state.mode === "planning" || state.mode === "writing";
  if (!running) return;
  const now = bar.createDiv("vam-book-now");
  now.createSpan({ cls: "vam-book-now-text", text });
  // "About N minutes left" only when the runner has a real estimate (at least five finished cards); no number is made up.
  if (state.etaSeconds !== undefined) now.createSpan({ cls: "vam-book-bar-eta", text: bookEtaText(state.etaSeconds) });
}

function makeButton(parent: HTMLElement, text: string, cls: string, action: () => void): HTMLButtonElement {
  const button = parent.createEl("button", { cls, text });
  button.addEventListener("click", event => {
    event.stopPropagation();
    action();
  });
  return button;
}

const REFUSAL_KEY: Record<BookRunRefusal, TranslationKey> = {
  busy: "ui.book_refused_busy",
  blocked: "ui.book_refused_blocked",
  root: "ui.book_refused_root",
  exists: "ui.book_refused_exists",
  unusable: "ui.book_refused_unusable",
  missing: "ui.book_refused_missing",
  finished: "ui.book_refused_finished",
  budget: "ui.book_refused_budget",
  disposed: "ui.book_refused_disposed",
  unreadable: "ui.book_refused_unreadable",
  not_gate1: "ui.book_refused_not_gate1",
  not_gate: "ui.book_refused_not_gate",
  empty: "ui.book_refused_empty",
  not_stopped: "ui.book_refused_not_stopped",
  instruction: "ui.book_refused_instruction",
  notes_busy: "ui.book_refused_notes_busy",
  drive_running: "ui.book_refused_drive_running",
  cancelled: "ui.book_refused_cancelled",
  stale: "ui.book_refused_stale",
  backup_failed: "ui.book_refused_backup_failed",
  text_changed: "ui.book_refused_text_changed",
  nothing: "ui.book_refused_nothing"
};

/** A plain localized reason for an error that is not a runner refusal; the raw message (English, internal) is never shown. */
export function bookErrorReason(error: unknown): string {
  return t(isBookStepError(error) ? "ui.book_reason_invalid_reply" : "ui.book_reason_failed");
}

/** The message for a rejected entry call: the refusal's own sentence, or the generic one with a plain reason. Never throws. */
export function bookRefusalText(error: unknown): string {
  if (error instanceof BookPipelineRunError && error.code in REFUSAL_KEY) return t(REFUSAL_KEY[error.code]);
  return t("ui.book_failed_0", bookErrorReason(error));
}

/** Runs one runner entry; a refusal (or any error) is shown through `notify` instead of being thrown. */
export async function runBookEntry(entry: () => Promise<void>, notify: (message: string) => void): Promise<void> {
  try {
    await entry();
  } catch (error) {
    notify(bookRefusalText(error));
  }
}

const STAGE_KEY: Record<PipelineStage | "pending", TranslationKey> = {
  pending: "ui.book_stage_pending",
  planned: "ui.book_stage_planned",
  written: "ui.book_stage_written",
  checked: "ui.book_stage_checked",
  "needs-review": "ui.book_stage_needs_review"
};
const ROLE_KEY: Record<BookRole, TranslationKey> = {
  intro: "ui.book_role_intro",
  body: "ui.book_role_body",
  gallery: "ui.book_role_gallery",
  closing: "ui.book_role_closing"
};
const STEP_KEY = { plan: "ui.book_step_plan", write: "ui.book_step_write", proof: "ui.book_step_proof" } as const;
const REASON_KEY: Record<string, TranslationKey> = {
  missing: "ui.book_reason_missing",
  card_removed: "ui.book_reason_card_removed",
  backup_failed: "ui.book_reason_backup_failed",
  discarded: "ui.book_reason_discarded",
  empty_list: "ui.book_reason_empty_list",
  no_body: "ui.book_reason_no_body",
  invalid_reply: "ui.book_reason_invalid_reply",
  failed: "ui.book_reason_failed",
  author_failed: "ui.book_reason_author_failed",
  unparsable: "ui.book_reason_unparsable",
  missing_item: "ui.book_reason_checklist_mismatch",
  duplicate_item: "ui.book_reason_checklist_mismatch",
  unknown_item: "ui.book_reason_checklist_mismatch",
  no_open_page: "ui.book_reason_no_open_page",
  all_facts_unverified: "ui.book_reason_all_facts_unverified",
  invalid_step: "ui.book_reason_invalid_reply",
  unsafe_body: "ui.book_reason_unsafe_body",
  fix_no_edits: "ui.book_reason_fix_no_edits",
  fix_lost_text: "ui.book_reason_fix_lost_text",
  no_view: "ui.book_reason_no_view",
  chapters_too_long: "ui.book_reason_chapters_too_long"
};

/** A step failure with a plain sentence (cause and next step) instead of "step failed: reason"; keyed `step:code`. */
const PLAIN_KEY: Record<string, TranslationKey> = {
  "write:no_body": "ui.book_plain_write_no_body",
  "write:hand_edited": "ui.book_plain_write_hand_edited",
  "proof:no_body": "ui.book_plain_proof_no_body",
  "proof:empty_list": "ui.book_plain_proof_empty_list",
  "proof:unparsable": "ui.book_plain_proof_unparsable",
  "proof:missing_item": "ui.book_plain_proof_mismatch",
  "proof:duplicate_item": "ui.book_plain_proof_mismatch",
  "proof:unknown_item": "ui.book_plain_proof_mismatch",
  "proof:no_open_page": "ui.book_plain_proof_no_open_page",
  "proof:invalid_reply": "ui.book_plain_proof_invalid_reply",
  "proof:failed": "ui.book_plain_proof_failed"
};

/** Turns the neutral issue code (`write failed: invalid_reply`, `proof unmet: C1 C3`) into the sentence shown on the card. */
export function bookIssueText(issue: string): string {
  const pictures = splitPictureIssue(issue);
  const sentences = pictureSentences(pictures);
  if (sentences.length) return joinReasons(pictures.rest ? [bookIssueText(pictures.rest), ...sentences] : sentences);
  const { rest, length } = splitLengthIssue(issue);
  if (!length) return plainIssueText(issue);
  const sentence = lengthText(length);
  return rest ? joinReasons([plainIssueText(rest), sentence]) : sentence;
}
/** The sentence for a chapter with fewer pictures than the owner's minimum (numbers only). */
export function shortfallText(shortfall: { placed: number; minimum: number }): string {
  return t("ui.book_reason_images_under_0_1", String(shortfall.placed), String(shortfall.minimum));
}
/** The picture sentences of an issue: shortfall, Commons' request limit, the pictures off their text, then English left in a Chinese caption. */
export function pictureSentences(pictures: ReturnType<typeof splitPictureIssue>): string[] {
  return [
    ...(pictures.shortfall ? [shortfallText(pictures.shortfall)] : []),
    ...(pictures.limited ? [t("ui.book_reason_images_limited")] : []),
    ...(pictures.off?.length
      ? [t("ui.book_reason_images_off_0", pictures.off.map(String).join(t("ui.argument_list_sep")))]
      : []),
    ...(pictures.captionLatin ? [t("ui.book_reason_caption_latin")] : [])
  ];
}
/** The sentence for a chapter outside the asked length: what was measured and the range (numbers and the unit only). */
export function lengthText(length: LengthReason): string {
  const unit = length.unit === "字" ? t("ui.book_length_unit_chars") : t("ui.book_length_unit_words");
  return t(
    length.kind === "over" ? "ui.book_reason_length_over_0_1_2_3" : "ui.book_reason_length_under_0_1_2_3",
    String(length.measured),
    unit,
    String(length.min),
    String(length.max)
  );
}
function plainIssueText(issue: string): string {
  if (issue.trim() === "consistency") return t("ui.book_issue_consistency");
  const failed = /^(plan|write|proof) failed: (\S+)$/.exec(issue.trim());
  if (failed) {
    const step = failed[1] as keyof typeof STEP_KEY;
    const plain = Object.prototype.hasOwnProperty.call(PLAIN_KEY, `${step}:${failed[2]}`)
      ? PLAIN_KEY[`${step}:${failed[2]}`]
      : undefined;
    if (plain) return t(plain);
    const reason = Object.prototype.hasOwnProperty.call(REASON_KEY, failed[2]) ? REASON_KEY[failed[2]] : undefined;
    if (reason) return t("ui.book_issue_step_0_1", t(STEP_KEY[step]), t(reason));
  }
  const unmet = /^proof unmet: (\S+(?: \S+)*)$/.exec(issue.trim());
  if (unmet && unmet[1] === "facts_unverified") return t("ui.book_reason_all_facts_unverified");
  if (unmet) return t("ui.book_issue_unmet_0", unmet[1]);
  return t("ui.book_issue_unknown");
}

/**
 * A checked card's `structure unmet: C2 C3 image_1` issue as a small note (counts only). Picture tokens (`image_*`) are "worth a look",
 * not unmet structure items: they are counted apart; anything else shows nothing.
 */
function structureNote(issue: string): { issueText?: string } {
  const found = /^(?:structure unmet|image notice): (\S+(?: \S+)*)$/.exec(issue.trim());
  if (!found) return {};
  const tokens = found[1].split(" ");
  const notices = tokens.filter(token => token.startsWith("image_")).length;
  const structure = tokens.length - notices;
  if (!notices) return { issueText: t("ui.book_structure_unmet_0", String(structure)) };
  if (!structure) return { issueText: t("ui.book_checked_notice_0", String(notices)) };
  return { issueText: t("ui.book_structure_notice_0_1", String(structure), String(notices)) };
}

export interface BookCardInput {
  pipelineStage?: unknown;
  bookRole?: unknown;
  pipelineIssue?: unknown;
  pipelineSeam?: unknown;
}
export interface BookCardView {
  stage: PipelineStage | "pending";
  stageText: string;
  roleText?: string;
  issueText?: string;
  /** True when a neighbouring card changed and the owner has not confirmed the join yet. */
  seam: boolean;
  /** The chapter text changed after its stored proof: the pill says so instead of a passed wording. */
  edited?: boolean;
  /** Book accepted (done): the stage pill of a needs-review card is not drawn. */
  hideStage?: boolean;
  /** Screen prefix of the summary (never written to the note); none while the card has no plan yet. */
  summaryPrefix?: string;
}

/**
 * `accepted`: the book's phase is done; the proof marks (needs-review pill, issue line, seam pill) are hidden, the data is untouched.
 * `resolved`: the reader ticked this chapter's box for the attention it has now; its marks go the same way (review-a B3).
 */
export function bookCardView(note: BookCardInput, accepted = false, stale = false, resolved = false): BookCardView {
  accepted = accepted || resolved;
  const stage = readPipelineStage(note.pipelineStage) ?? "pending";
  const role = readBookRole(note.bookRole);
  const issue = typeof note.pipelineIssue === "string" && note.pipelineIssue ? note.pipelineIssue : undefined;
  return {
    stage,
    stageText: t(STAGE_KEY[stage]),
    ...(!accepted && stale && stage === "checked" ? { edited: true } : {}),
    seam: !accepted && typeof note.pipelineSeam === "string" && note.pipelineSeam.trim() !== "",
    ...(accepted && stage === "needs-review" ? { hideStage: true } : {}),
    ...(role ? { roleText: t(ROLE_KEY[role]) } : {}),
    ...(!accepted && stage === "needs-review" && issue
      ? { issueText: t("ui.book_issue_0", bookIssueText(issue)) }
      : {}),
    ...(!accepted && stage === "checked" && issue ? structureNote(issue) : {}),
    ...(stage === "pending"
      ? {}
      : { summaryPrefix: t(stage === "planned" ? "ui.book_summary_plan" : "ui.book_summary_done") })
  };
}

const WORKING_KEY: Record<BookSubStep, TranslationKey> = {
  plan: "ui.book_stage_planning",
  write: "ui.book_stage_writing",
  images: "ui.book_stage_images",
  proof: "ui.book_stage_proof"
};
/**
 * The two small labels beside the existing status chip: the pipeline state (dot plus word, like `.vam-status`) and the role.
 * While a step works on this card, `writing` replaces the state with what it does (planning, writing, finding pictures, proofreading) and the elapsed clock.
 */
export function renderBookCardLabels(
  header: HTMLElement,
  view: BookCardView,
  writing?: { track: (element: HTMLElement) => void; step?: BookSubStep; rerun?: boolean }
): void {
  if (writing) {
    const step = writing.step ?? "write";
    const chip = header.createSpan({ cls: "vam-status vam-status-running vam-book-state is-writing" });
    chip.addClass(`is-${step}`);
    // A rerun just says "working" (no clock); the step it is in stays in the tooltip.
    if (writing.rerun) {
      chip.addClass("is-rerun");
      chip.setAttr("title", t(WORKING_KEY[step]));
      chip.createSpan({ text: t("ui.book_rerun_tag") });
    } else {
      chip.createSpan({ text: t(WORKING_KEY[step]) });
      const elapsed = chip.createSpan({ cls: "vam-book-elapsed" });
      elapsed.setAttr("aria-hidden", "true");
      writing.track(elapsed);
    }
  } else if (!view.hideStage)
    header.createSpan({ cls: `vam-status vam-book-state is-${view.stage}`, text: view.stageText });
  if (view.edited) header.createSpan({ cls: "vam-status vam-book-state is-edited", text: t("ui.book_stale_proof") });
  if (view.seam) {
    const seam = header.createSpan({ cls: "vam-status vam-book-state is-seam", text: t("ui.book_seam_label") });
    seam.setAttr("title", t("ui.book_seam_reason"));
  }
  if (view.roleText) header.createSpan({ cls: "vam-book-role", text: view.roleText });
}

/** The run waits at gate 1 for the owner (not driving): the only state in which a chat "continue" confirms the plan. */
export function isBookGate1Waiting(
  progress: Pick<BookPipelineProgress, "phase" | "active"> | undefined,
  data: Pick<BookPipelineData, "phase">
): boolean {
  return (progress?.phase ?? data.phase) === "gate1" && !progress?.active;
}
