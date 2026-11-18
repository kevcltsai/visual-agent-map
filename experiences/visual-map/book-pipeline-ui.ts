import type { TranslationKey } from "../../i18n";
import { t } from "../../i18n";
import {
  AUTO_QUOTA_SUFFIX,
  readBookRole,
  readPipelineStage,
  type BookPipelineData,
  type BookRole,
  type PipelineStage
} from "../../core/book-pipeline/model";
import {
  BookPipelineRunError,
  stepCounts,
  type BookPipelineProgress,
  type BookRunRefusal,
  type BookStepCounts,
  type BookSubStep
} from "./book-pipeline-run";

/**
 * Picture-book pipeline screen parts (03b): the map's top progress bar, the card badges and the refusal messages.
 * Everything here is drawn only for a map that has `bookPipeline`; a map without it never reaches these functions, so it
 * gets no new element. Text never relies on color alone (every state and role has a word).
 */

export type BookBarMode = "planning" | "gate1" | "writing" | "gate2" | "done" | "stopped" | "budget";

export interface BookBarState {
  mode: BookBarMode;
  /** The phase the run is in (the stopped line names it). */
  phase: BookPipelineData["phase"];
  total: number;
  counts: Record<PipelineStage | "pending", number>;
  budget: { used: number; limit: number };
  /** The neutral code of why the run stopped by itself; the bar shows it in words and offers "retry". */
  failure?: string;
  /** Seconds left, as the runner estimated them (only after at least five cards of the phase finished); absent means no number is shown. */
  etaSeconds?: number;
  /** Cards done per listed step (memory only; after a reload they are derived from the cards' stages). */
  steps: BookStepCounts;
  /** The whole-book plan is saved. */
  globalDone: boolean;
  /** What the run is doing right now (memory only; absent after a reload or while nothing runs). */
  current?: BookCurrent;
  /** A single-card rerun is in progress (memory only): the bar keeps its stop button; the card itself says "working". */
  rerun?: true;
}
export type BookCurrentStep = BookSubStep | "global";
export interface BookCurrent {
  step: BookCurrentStep;
  /** 1-based position in the reading order; absent for the whole-book plan. */
  chapter?: number;
  title?: string;
  /** How many other cards work at the same time. */
  more: number;
  /** Every step some card is in right now (the stage list marks them). */
  steps: BookCurrentStep[];
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
 */
export function bookBarState(
  data: BookPipelineData,
  progress: BookPipelineProgress | undefined,
  stageOf: (nodeId: string) => PipelineStage | undefined,
  titleOf?: (nodeId: string) => string | undefined
): BookBarState {
  // The saved "done" of the same run is final: a runner record that still says gate2 is older than the owner's acceptance.
  const savedDone = data.phase === "done" && (!progress || progress.runId === data.runId);
  const phase = savedDone ? "done" : (progress?.phase ?? data.phase);
  const status = savedDone ? data.status : (progress?.status ?? data.status);
  const pauseReason = progress ? progress.pauseReason : data.pauseReason;
  const active = progress?.active ?? false;
  const counts = progress?.counts ?? countStages(data.order.map(stageOf));
  const total = progress?.total ?? data.order.length;
  const budget = progress?.budget ?? data.budget;
  const failure = progress ? progress.failureCode : data.failureCode;
  const interrupted = (phase === "planning" || phase === "writing") && !active;
  const mode: BookBarMode =
    status === "stopped" && pauseReason === "budget"
      ? "budget"
      : status === "stopped" || interrupted
        ? "stopped"
        : phase;
  const steps = progress?.steps ?? stepCounts(counts, 0, { settled: phase === "gate2" || phase === "done" });
  const current = mode === "planning" || mode === "writing" ? currentOf(data, progress, titleOf) : undefined;
  const rerunning = !!progress?.active && !!progress.rerun && data.order.includes(progress.rerun.nodeId);
  return {
    mode,
    phase,
    total,
    counts,
    budget,
    steps,
    globalDone: data.globalPlanned === true,
    ...(current ? { current } : {}),
    ...(rerunning ? { rerun: true as const } : {}),
    ...(mode === "stopped" && pauseReason === "failed" && failure ? { failure } : {}),
    ...(progress?.etaSeconds !== undefined && Number.isFinite(progress.etaSeconds) && progress.etaSeconds >= 0
      ? { etaSeconds: progress.etaSeconds }
      : {})
  };
}

/** The run's busiest-first card for the "now" line: the whole-book plan first, then the earliest chapter in the reading order. */
function currentOf(
  data: BookPipelineData,
  progress: BookPipelineProgress | undefined,
  titleOf?: (nodeId: string) => string | undefined
): BookCurrent | undefined {
  if (!progress?.active || !progress.current?.length) return undefined;
  const position = (nodeId: string): number => (nodeId === "global" ? -1 : data.order.indexOf(nodeId));
  const entries = progress.current.filter(item => item.nodeId === "global" || position(item.nodeId) >= 0);
  if (!entries.length) return undefined;
  entries.sort((a, b) => position(a.nodeId) - position(b.nodeId));
  const first = entries[0];
  const title = first.nodeId === "global" ? undefined : titleOf?.(first.nodeId);
  return {
    step: first.nodeId === "global" ? "global" : first.step,
    ...(first.nodeId === "global" ? {} : { chapter: position(first.nodeId) + 1 }),
    ...(title ? { title } : {}),
    more: entries.length - 1,
    steps: entries.map(item => (item.nodeId === "global" ? "global" : item.step))
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
  addBudget: () => void;
  confirmGate1: () => void;
  /** The gate panel's opener (04b); a bar drawn without it (older callers) shows no such button. */
  panel?: { open: boolean; toggle: () => void };
}

export function bookTitleText(state: BookBarState): string {
  const word =
    state.mode === "stopped"
      ? t("ui.book_phase_stopped")
      : state.mode === "budget"
        ? t("ui.book_phase_budget")
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
  if (actions.panel && (state.phase === "gate1" || state.phase === "gate2" || state.phase === "done")) {
    const open = actions.panel.open;
    const opener = makeButton(
      buttons,
      t(open ? "ui.book_panel_close" : "ui.book_panel_open"),
      "vam-book-panel-toggle",
      actions.panel.toggle
    );
    opener.setAttr("aria-expanded", String(open));
  }
  if (state.phase === "gate1" && state.mode !== "done") {
    makeButton(buttons, t("ui.book_confirm_gate1"), "mod-cta vam-book-confirm", actions.confirmGate1);
  }
  if (state.mode === "budget") {
    makeButton(buttons, t("ui.book_add_budget"), "mod-cta vam-book-add-budget", actions.addBudget);
    makeButton(buttons, t("ui.book_stop"), "vam-book-stop", actions.stop);
  } else if (state.mode === "stopped")
    makeButton(
      buttons,
      t(state.failure ? "ui.book_retry" : "ui.book_resume"),
      "mod-cta vam-book-resume",
      actions.resume
    );
  else if (state.mode === "planning" || state.mode === "writing")
    makeButton(buttons, t("ui.book_stop"), "mod-warning vam-book-stop", actions.stop);
  if (state.rerun) makeButton(buttons, t("ui.book_stop"), "mod-warning vam-book-stop", actions.stop);
  const items = bookStepItems(state);
  renderStepList(bar, items);
  renderNowLine(bar, state);
  // The cards carry "rerun this card" at gate 2 and when done: say so once, under the steps.
  if (state.phase === "gate2" || state.phase === "done")
    bar.createDiv({ cls: "vam-book-rerun-hint", text: t("ui.book_progress_rerun_hint") });
  const valueText = items.map(item => item.text).join(t("ui.book_progress_sep"));
  const track = bar.createDiv("vam-book-track");
  track.setAttr("role", "progressbar");
  track.setAttr("aria-label", t("ui.book_bar_label"));
  track.setAttr("aria-valuemin", "0");
  track.setAttr("aria-valuemax", String(total));
  track.setAttr("aria-valuenow", String(counts.checked));
  track.setAttr("aria-valuetext", valueText);
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

export interface BookStepItem {
  key: BookCurrentStep;
  text: string;
  done: boolean;
  current: boolean;
}
const STEP_LABEL: Record<BookCurrentStep, TranslationKey> = {
  global: "ui.book_progress_step_global",
  plan: "ui.book_progress_step_plan",
  write: "ui.book_progress_step_write",
  images: "ui.book_progress_step_images",
  proof: "ui.book_progress_step_proof"
};
/** The five stages the owner knows, in order, each with its own words ("Writing 3/5"); a finished one carries a check mark. */
export function bookStepItems(state: BookBarState): BookStepItem[] {
  const marked = new Set(state.current?.steps ?? []);
  const items: BookStepItem[] = [];
  for (const key of ["global", "plan", "write", "images", "proof"] as const) {
    const done = key === "global" ? state.globalDone : state.total > 0 && state.steps[key] >= state.total;
    const label = t(STEP_LABEL[key]);
    items.push({
      key,
      done,
      current: marked.has(key),
      text: done
        ? t("ui.book_progress_done_0", label)
        : key === "global"
          ? label
          : t("ui.book_progress_count_0_1_2", label, state.steps[key], state.total)
    });
  }
  return items;
}
function renderStepList(bar: HTMLElement, items: BookStepItem[]): void {
  const list = bar.createEl("ol", { cls: "vam-book-steps" });
  list.setAttr("aria-label", t("ui.book_progress_steps_label"));
  for (const item of items) {
    const li = list.createEl("li", { cls: "vam-book-step", text: item.text });
    li.dataset.step = item.key;
    li.toggleClass("is-done", item.done);
    li.toggleClass("is-current", item.current);
    if (item.current) li.setAttr("aria-current", "step");
  }
}
const NOW_KEY: Record<Exclude<BookCurrentStep, "global">, TranslationKey> = {
  plan: "ui.book_progress_now_plan_0_1",
  write: "ui.book_progress_now_write_0_1",
  images: "ui.book_progress_now_images_0_1",
  proof: "ui.book_progress_now_proof_0_1"
};
const NOW_KEY_UNTITLED: Record<Exclude<BookCurrentStep, "global">, TranslationKey> = {
  plan: "ui.book_progress_now_plan_0",
  write: "ui.book_progress_now_write_0",
  images: "ui.book_progress_now_images_0",
  proof: "ui.book_progress_now_proof_0"
};
/** "Now writing chapter 3 'Title'". Titles come from notes: the caller sets them as text only. */
export function bookNowText(current: BookCurrent): string {
  if (current.step === "global") return t("ui.book_progress_now_global");
  // A title that has not loaded yet reads as a sentence without one (never an empty pair of quotes).
  const base = current.title
    ? t(NOW_KEY[current.step], current.chapter ?? 0, current.title)
    : t(NOW_KEY_UNTITLED[current.step], current.chapter ?? 0);
  return current.more > 0 ? `${base}${t("ui.book_progress_more_0", current.more)}` : base;
}
function renderNowLine(bar: HTMLElement, state: BookBarState): void {
  const showEta = state.etaSeconds !== undefined && (state.mode === "planning" || state.mode === "writing");
  if (!state.current && !showEta) return;
  const now = bar.createDiv("vam-book-now");
  if (state.current) now.createSpan({ cls: "vam-book-now-text", text: bookNowText(state.current) });
  // "About N minutes left" only when the runner has a real estimate (at least five finished cards); no number is made up.
  if (showEta && state.etaSeconds !== undefined)
    now.createSpan({ cls: "vam-book-bar-eta", text: bookEtaText(state.etaSeconds) });
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
  instruction: "ui.book_refused_instruction"
};

/** The message for a rejected entry call: the refusal's own sentence, or the generic one with a short cause. Never throws. */
export function bookRefusalText(error: unknown): string {
  if (error instanceof BookPipelineRunError && error.code in REFUSAL_KEY) return t(REFUSAL_KEY[error.code]);
  const message = (error as { message?: unknown } | null)?.message;
  const cause = typeof message === "string" ? message : String(error);
  return t("ui.book_failed_0", cause.slice(0, 120));
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
  no_view: "ui.book_reason_no_view"
};

/** A step failure with a plain sentence (cause and next step) instead of "step failed: reason"; keyed `step:code`. */
const PLAIN_KEY: Record<string, TranslationKey> = {
  "write:no_body": "ui.book_plain_write_no_body",
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
  // A card the automatic redo could not retry (rounds or budget reserve used up) carries the plain note after its usual reason.
  if (issue.endsWith(AUTO_QUOTA_SUFFIX))
    return t("ui.book_issue_auto_quota_0", bookIssueText(issue.slice(0, -AUTO_QUOTA_SUFFIX.length)));
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
  const found = /^structure unmet: (\S+(?: \S+)*)$/.exec(issue.trim());
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
  /** Screen prefix of the summary (never written to the note); none while the card has no plan yet. */
  summaryPrefix?: string;
}

export function bookCardView(note: BookCardInput): BookCardView {
  const stage = readPipelineStage(note.pipelineStage) ?? "pending";
  const role = readBookRole(note.bookRole);
  const issue = typeof note.pipelineIssue === "string" && note.pipelineIssue ? note.pipelineIssue : undefined;
  return {
    stage,
    stageText: t(STAGE_KEY[stage]),
    seam: typeof note.pipelineSeam === "string" && note.pipelineSeam.trim() !== "",
    ...(role ? { roleText: t(ROLE_KEY[role]) } : {}),
    ...(stage === "needs-review" && issue ? { issueText: t("ui.book_issue_0", bookIssueText(issue)) } : {}),
    ...(stage === "checked" && issue ? structureNote(issue) : {}),
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
  } else header.createSpan({ cls: `vam-status vam-book-state is-${view.stage}`, text: view.stageText });
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
