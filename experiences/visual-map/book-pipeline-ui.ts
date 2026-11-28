import type { TranslationKey } from "../../i18n";
import { t } from "../../i18n";
import { isBookStepError } from "../../core/steps/book-pipeline/base";
import { splitLengthIssue, type LengthReason } from "../../core/book-pipeline/settings";
import { parseCardPoints } from "../../core/book-pipeline/plan-text";
import {
  bookStructure as bookStructureOf,
  type BookStructure,
  type CardPlace
} from "../../core/book-pipeline/structure";
import {
  simulateStructure,
  undoClosure,
  type AppliedOp,
  type StructureNode
} from "../../core/book-pipeline/structure-edit";
import { splitPictureIssue } from "../../core/book-pipeline/image-slots";
import { fixAgainPlan } from "../../core/book-pipeline/machine";
import { joinReasons, splitCarriedIssue } from "./book-pipeline-reasons";
import {
  bookProofUnfinished,
  closingPageSkipped,
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
  /** A gate button press is waiting for the drive that reached the gate to finish ending (memory only): the bar says so. */
  gateWaiting?: true;
  /** A single-card rerun is in progress (memory only): the bar keeps its stop button; the card itself says "working". */
  rerun?: true;
  /** Gate 1: every chapter is planned and the owner looks at the plan's direction (the one stop of the automatic run). */
  planReview?: true;
  /** The trial is the book structure's (preface, chapter 1 and its sections): the bar counts cards and names the preface; absent for an older run. */
  structure?: { chapters: number; sections: number };
  /**
   * The AI proofread in numbers: chapters in their fix round now, places fixed so far, and the open issues (the same items as the
   * closing page: open findings, unfinished proofreads, chapters that still need a look).
   */
  ai: { fixing: number; open: number; fixed: number };
  /** A "fix again" round is running (memory only): slots finished and slots to work on; the bar shows them with a stop button. */
  again?: { done: number; total: number };
  /** A finished book with AI proofread problems a round could fix: what the "fix again" button and its card say (absent: no button). */
  fixAgain?: { chapters: number; items: number; calls: number; stubborn: number; statusItems: number; book: boolean };
  /** A finished book that has no closing page (every chapter AI-locked, nothing checked): the bar shows no button to it. */
  noClosingPage?: true;
  /** Gate 1 only: what the editor changed in the book's structure (absent when it changed nothing and refused nothing). */
  structureEdit?: BookStructureEditView;
}
/** One structure change as the gate lists it. Every text here is the editor's own (untrusted): it is drawn as plain text only. */
export interface BookStructureItem {
  id: string;
  kind: "add" | "remove" | "merge" | "move" | "rename";
  /** The change in one sentence (card names and where it went). */
  text: string;
  reason: string;
  undone: boolean;
  /** Later changes that lean on this one: undoing this one undoes them too. */
  dependents: { id: string; kind: BookStructureItem["kind"]; title: string }[];
  /** Where a removed or merged card's note was parked. */
  archivedPath?: string;
}
export interface BookStructureEditView {
  /** Names this set of changes (run, applied and refused ops): an "accept" given to it is dropped when the editor changes something new. */
  key: string;
  items: BookStructureItem[];
  /** Changes that stand (not undone). */
  active: number;
  /** Proposals not applied: over the cap, or counted by why. */
  notApplied?: { overCap: boolean; locked: number; other: number };
}
export interface BookCurrent {
  /** The whole-book plan, or a chapter step. */
  step: "global" | "plan" | "write" | "images" | "proof";
  /** 1-based position in the reading order; absent for the whole-book plan. */
  chapter?: number;
  /** Every chapter in work is in its one automatic fix round: the sentence keeps the whole-book count instead of going back to an early chapter. */
  fix?: true;
  /** The card's place in the book (preface / chapter n / section by name); absent for a run whose structure cannot be derived. */
  place?: { kind: "preface" | "chapter" | "section"; chapter?: number; title?: string };
}

const FAILURE_KEY: Record<string, TranslationKey> = {
  invalid_reply: "ui.book_fail_invalid_reply",
  backup_failed: "ui.book_fail_backup",
  discarded: "ui.book_fail_discarded",
  ai_locked: "ui.ai_locked_notice",
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
  mapIds?: readonly string[],
  structure?: BookStructure,
  titleOf?: (nodeId: string) => string | undefined
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
  // The trial and the final gate pass by themselves now: a run in one of them reads as writing (and as stopped when nothing drives it).
  const writingLike = phase === "writing" || phase === "gate2" || (phase === "gate1" && !data.planReview);
  const interrupted = (phase === "planning" || writingLike) && !active;
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
        : writingLike
          ? "writing"
          : phase;
  const baseCurrent = mode === "planning" || mode === "writing" ? currentOf(data, progress, stageOf) : undefined;
  // A run whose saved trial is not the structure's (an older run) keeps the old chapter wording.
  const trialIds = structure?.trialOf() ?? [];
  const placed =
    !!structure &&
    (!data.trial?.length || (data.trial.length === trialIds.length && data.trial.every((id, i) => id === trialIds[i])));
  const ai = aiNumbers(data, order, counts["needs-review"]);
  // The card in work is named by its place in the book ("preface", "chapter 1", a section by name), not by its position in the order.
  const nowPlace =
    placed && structure && baseCurrent?.chapter ? structure.placeOf(order[baseCurrent.chapter - 1] ?? "") : undefined;
  const current =
    baseCurrent && nowPlace
      ? {
          ...baseCurrent,
          place: {
            kind: nowPlace.kind,
            ...(nowPlace.chapter ? { chapter: nowPlace.chapter } : {}),
            title: titleOf?.(order[(baseCurrent.chapter as number) - 1]) ?? ""
          }
        }
      : baseCurrent;
  const rerunning = !!progress?.active && !!progress.rerun && order.includes(progress.rerun.nodeId);
  const again = mode === "done" && progress?.active && progress.again ? progress.again : undefined;
  const fixAgain = mode === "done" && !again && !rerunning ? fixAgainPlan(data, counts["needs-review"]) : undefined;
  return {
    mode,
    phase,
    total,
    counts,
    budget,
    globalDone: data.globalPlanned === true,
    ai,
    ...(placed && structure
      ? {
          structure: {
            chapters: structure.chapters.length,
            sections: structure.chapters.reduce((sum, id) => sum + structure.sectionsOf(id).length, 0)
          }
        }
      : {}),
    ...(current ? { current } : {}),
    ...(rerunning ? { rerun: true as const } : {}),
    ...(again ? { again: { ...again } } : {}),
    ...(fixAgain?.items ? { fixAgain } : {}),
    ...(mode === "done" && closingPageSkipped(data) ? { noClosingPage: true as const } : {}),
    ...(progress?.gateWaiting ? { gateWaiting: true as const } : {}),
    ...(mapChange ? { mapChange } : {}),
    ...(gateChange && (gateChange.added || gateChange.missing) ? { mapChange: gateChange } : {}),
    ...(reordered ? { mapChange: reordered } : {}),
    ...(mode === "gate1" && data.planReview ? { planReview: true as const } : {}),
    ...(mode === "gate1" && data.planReview ? structureEditField(data, titleOf) : {}),
    ...(mode === "stopped" && pauseReason === "failed" && failure ? { failure } : {}),
    ...(progress?.etaSeconds !== undefined && Number.isFinite(progress.etaSeconds) && progress.etaSeconds >= 0
      ? { etaSeconds: progress.etaSeconds }
      : {})
  };
}

/** The gate's structure list: one item per applied change (reading the saved ops and the tree before), or nothing when the editor changed and refused nothing. */
function structureEditField(
  data: BookPipelineData,
  titleOf?: (nodeId: string) => string | undefined
): { structureEdit?: BookStructureEditView } {
  const edit = data.structureEdit;
  if (!edit || (!edit.applied.length && !edit.rejected.length && !edit.overCap)) return {};
  const undone = new Set(edit.undone ?? []);
  const names = new Map<string, string>(edit.before.nodes.map(n => [n.id, n.title]));
  for (const a of edit.applied) if (a.op.kind === "add") names.set(a.op.ref, a.op.title);
  const nameOf = (id: string): string => titleOf?.(id) ?? names.get(id) ?? "";
  const before = placer(edit.before.rootId, edit.before.nodes, nameOf);
  const placeAfter = (ops: readonly AppliedOp[]): ReturnType<typeof placer> =>
    placer(
      edit.before.rootId,
      simulateStructure(
        edit.before,
        ops.map(a => a.op),
        new Set()
      ).result,
      nameOf
    );
  // An undone change is not in the tree any more: a later change is shown against the tree without it, and an undone one against the changes up to it.
  const afterActive = placeAfter(edit.applied.filter(a => !undone.has(a.id)));
  const items: BookStructureItem[] = edit.applied.map((a, index) => {
    const { op } = a;
    const after = undone.has(a.id)
      ? placeAfter(edit.applied.slice(0, index + 1).filter(x => x.id === a.id || !undone.has(x.id)))
      : afterActive;
    const id = op.kind === "add" ? op.ref : op.card;
    const archivedPath =
      (op.kind === "merge" || op.kind === "remove") && edit.archived ? edit.archived[op.card] : undefined;
    const dependents = [...undoClosure(edit.applied, [a.id], edit.before.rootId)]
      .filter(other => other !== a.id && !undone.has(other))
      .map(other => edit.applied.find(x => x.id === other) as AppliedOp)
      .map(x => ({ id: x.id, kind: x.op.kind, title: x.op.kind === "add" ? x.op.title : nameOf(x.op.card) }));
    return {
      id: a.id,
      kind: op.kind,
      text: itemText(a, nameOf(id), edit.before.rootId, before, after, nameOf),
      reason: op.reason,
      undone: undone.has(a.id),
      dependents,
      ...(archivedPath ? { archivedPath } : {})
    };
  });
  const active = items.filter(i => !i.undone);
  const rejected = edit.rejected;
  const locked = rejected.filter(r => r.code === "locked").length;
  const notApplied =
    edit.overCap || rejected.length
      ? { overCap: edit.overCap === true, locked, other: rejected.length - locked }
      : undefined;
  return {
    structureEdit: {
      key: [edit.runId, ...edit.applied.map(a => a.id), ...rejected.map(r => r.id)].join("|"),
      items,
      active: active.length,
      ...(notApplied ? { notApplied } : {})
    }
  };
}

const structureOfNodes = (input: { rootId: string; nodes: readonly StructureNode[] }): BookStructure => {
  const parents = new Map(input.nodes.map(n => [n.id, n.parentId]));
  return bookStructureOf(
    input.nodes.map(n => n.id),
    id => parents.get(id),
    input.rootId
  );
};

/** Where a card sits in a tree, in words: "preface", "chapter 3", or "the sections of <chapter>". */
export function placer(rootId: string, nodes: readonly StructureNode[], nameOf: (id: string) => string) {
  const structure = structureOfNodes({ rootId, nodes });
  return (id: string): string => {
    const place: CardPlace | undefined = structure.placeOf(id);
    if (!place) return "";
    if (place.kind === "preface") return t("ui.book_struct_place_preface");
    if (place.kind === "chapter") return t("ui.book_struct_place_chapter_0", place.chapter ?? 0);
    return t("ui.book_struct_place_section_0", nameOf(place.chapterId as string));
  };
}

export function itemText(
  a: AppliedOp,
  title: string,
  rootId: string,
  before: (id: string) => string,
  after: (id: string) => string,
  nameOf: (id: string) => string
): string {
  const { op } = a;
  if (op.kind === "add")
    return op.parent === rootId
      ? t("ui.book_struct_add_chapter_0_1", after(op.ref), op.title)
      : t("ui.book_struct_add_section_0_1", nameOf(op.parent), op.title);
  if (op.kind === "rename") return t("ui.book_struct_rename_0_1", a.before.title, op.title);
  if (op.kind === "merge") return t("ui.book_struct_merge_0_1_2", title, before(op.card), nameOf(op.into));
  if (op.kind === "remove") return t("ui.book_struct_remove_0_1", title, before(op.card));
  const from = before(op.card);
  const to = after(op.card);
  return from === to ? t("ui.book_struct_move_same_0", title) : t("ui.book_struct_move_0_1_2", title, from, to);
}

/** A count in its singular form for 1 (`…_one`) and plural otherwise (`…_0`); en needs it, zh reads the same either way. */
const counted = (k: number, one: TranslationKey, many: TranslationKey): string => (k === 1 ? t(one) : t(many, k));

/** The bar's AI numbers; "open" counts the same items the closing page lists (see the runner's `openIssuesOf`). */
function aiNumbers(data: BookPipelineData, order: readonly string[], needsReview: number): BookBarState["ai"] {
  let fixing = 0;
  let open = needsReview;
  let fixed = 0;
  for (const id of order) {
    const slot = data.aiProof?.[id];
    if (!slot) continue;
    if (!slot.done && slot.step === "fix") fixing++;
    open += slot.open.length + (slot.incomplete ? 1 : 0);
    fixed += slot.fixed;
  }
  if (data.bookProof) {
    open += data.bookProof.open.length + (bookProofUnfinished(data.bookProof) ? 1 : 0);
    fixed += data.bookProof.fixed;
  }
  return { fixing, open, fixed };
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
  /** "Book settings": a read-only view of the book's six settings, drawn before the stop button (one per bar); a bar drawn without it shows none. */
  showSettings?: () => void;
  resume: () => void;
  /** "Reconfigure and start over" (a run stopped in any phase before done); a bar drawn without it shows no such button. */
  restart?: () => void;
  /** The map changed: "plan again" (the restart path) and "carry on as before"; the bar shows both only in that state. */
  mapChanged?: { replan: () => void; keep: () => void };
  /** "Give up this book" (stopped) and "remove the picture book" (done): the in-bar confirmation card; a bar drawn without it shows no such button. */
  abandon?: { asking: boolean; ask: () => void; cancel: () => void; confirm: () => void };
  addBudget: () => void;
  confirmGate1: () => void;
  /** A finished book: "see what is still open" (opens the closing page). */
  openIssues?: () => void;
  /** A finished book with fixable AI proofread problems: "fix again" and its in-bar confirmation card; a bar drawn without it shows no such button. */
  fixAgain?: { asking: boolean; ask: () => void; cancel: () => void; confirm: () => void };
  /** Gate 2 or done: a card rerun found a hand-edited chapter; the bar asks once before it overwrites it (decision G). */
  rerunAsk?: { cancel: () => void; confirm: () => void; focus?: "go" | "opener" };
  /** The plan review's structure list: undo some changes (by id); open a parked note by its path. */
  undoStructure?: (ids: string[]) => void;
  openArchived?: (path: string) => void;
  /** The structure list folds to one line ("N changes · show"); `expanded` opens its rows; once accepted the line is gone. */
  structureAccept?: { accepted: boolean; expanded: boolean; accept: () => void; toggle: () => void };
  /** An undo is running (every undo button waits) or just failed (the map is back as it was; one line says so). Kept by the view. */
  structureUndo?: "busy" | "failed";
}

export function bookTitleText(state: BookBarState): string {
  const word =
    state.mode === "stopped" || state.mode === "changed"
      ? t("ui.book_phase_stopped")
      : state.mode === "budget"
        ? t("ui.book_phase_budget")
        : state.mode === "gate1" && state.planReview
          ? t("ui.book_phase_plan_review")
          : state.again
            ? t("ui.book_phase_fix_again")
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
            : t(
                state.structure ? "ui.book_stopped_done_cards_0_1" : "ui.book_stopped_done_0_1",
                settledCount(state),
                total
              )
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
    makeButton(buttons, t("ui.book_stop"), "vam-book-stop", actions.stop);
  }
  if ((state.mode === "gate1" || state.mode === "done") && state.mapChange)
    top.createSpan({ cls: "vam-book-bar-counts vam-book-map-changed", text: mapChangeText(state.mapChange) });
  // The plan review: one way on (start writing) and one sentence on how to change the plan.
  if (state.mode === "gate1" && state.planReview)
    makeButton(buttons, t("ui.book_bar_plan_go"), "mod-cta vam-book-confirm", actions.confirmGate1);
  if (state.mode === "done") {
    top.createSpan({
      cls: "vam-book-bar-counts vam-book-done-counts",
      text: state.again
        ? t("ui.book_bar_fix_again_0_1_2", state.again.done, state.again.total, state.ai.open)
        : t(
            "ui.book_bar_done_0_1_2",
            counted(state.structure?.chapters ?? total, "ui.book_bar_chapters_one", "ui.book_bar_chapters_0"),
            counted(state.ai.fixed, "ui.book_bar_places_one", "ui.book_bar_places_0"),
            state.ai.open
          )
    });
    if (state.again) makeButton(buttons, t("ui.book_stop"), "vam-book-stop", actions.stop);
    else {
      if (actions.openIssues && !state.noClosingPage)
        makeButton(buttons, t("ui.book_bar_open_issues"), "vam-book-link vam-book-open-issues", actions.openIssues);
      if (actions.fixAgain && state.fixAgain) {
        const again = makeButton(buttons, t("ui.book_fix_again"), "vam-book-fix-again", actions.fixAgain.ask);
        again.setAttr("aria-expanded", String(actions.fixAgain.asking));
      }
    }
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
    makeButton(buttons, t("ui.book_stop"), "vam-book-stop", actions.stop);
  // At a gate nothing runs unless a trial retry or a card rerun does (their own stop is below); stopping only holds the run.
  else if (state.mode === "gate1" && !state.rerun)
    makeButton(buttons, t("ui.book_stop"), "vam-book-stop", actions.stop);
  if (state.rerun && state.mode !== "planning" && state.mode !== "writing")
    makeButton(buttons, t("ui.book_stop"), "vam-book-stop", actions.stop);
  // Wherever a stop button is drawn, "book settings" sits right before the first one.
  const firstStop = buttons.querySelector(".vam-book-stop");
  if (actions.showSettings && firstStop) {
    const settings = makeButton(buttons, t("ui.book_settings_view"), "vam-book-settings-view", actions.showSettings);
    buttons.insertBefore(settings, firstStop);
  }
  if (
    actions.abandon &&
    !state.again &&
    (state.mode === "stopped" || state.mode === "budget" || state.mode === "done")
  ) {
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
    // A finished book is not given up: its own words, and the confirm is not a warning.
    const done = state.mode === "done";
    const title = t(done ? "ui.book_remove_title" : "ui.book_abandon_title");
    const card = bar.createDiv("vam-book-abandon-card");
    card.setAttr("role", "group");
    card.setAttr("aria-label", title);
    card.createEl("b", { text: title });
    card.createEl("p", { text: t(done ? "ui.book_remove_body" : "ui.book_abandon_body") });
    const row = card.createDiv("vam-book-abandon-actions");
    makeButton(row, t("ui.cancel"), "vam-book-abandon-cancel", abandon.cancel);
    makeButton(
      row,
      t(done ? "ui.book_remove" : "ui.book_abandon_confirm"),
      `${done ? "mod-cta" : "mod-warning"} vam-book-abandon-confirm`,
      abandon.confirm
    );
  }
  if (actions.fixAgain?.asking && !actions.abandon?.asking && state.fixAgain && !state.again)
    renderFixAgainCard(bar, state.fixAgain, actions.fixAgain);
  if (state.mode === "gate1" && state.planReview)
    bar.createDiv("vam-book-plan-hint").createEl("b", { text: t("ui.book_bar_plan_hint") });
  if (state.mode === "gate1" && state.planReview && state.structureEdit && !actions.structureAccept?.accepted)
    renderStructureEdit(bar, state.structureEdit, actions);
  if ((state.mode === "writing" || state.mode === "done" || state.mode === "stopped") && actions.rerunAsk)
    renderAsk(
      bar,
      "vam-book-rerun-ask",
      t("ui.book_rerun_overwrite_ask"),
      t("ui.book_rerun_overwrite_go"),
      actions.rerunAsk
    );
  const progressText = bookProgressText(state);
  renderProgressLine(bar, state);
  if (state.gateWaiting)
    bar.createDiv("vam-book-now vam-book-gate-waiting").createSpan({
      cls: "vam-book-now-text",
      text: t("ui.book_gate_waiting")
    });
  // The plan review has nothing finished to show: no track, so the map starts right under the bar.
  if (state.mode === "gate1" && state.planReview) return bar;
  // The fill is finished chapters only (proofread, or stopped for a person): planned or written ones do not count yet.
  const track = bar.createDiv("vam-book-track");
  track.setAttr("role", "progressbar");
  track.setAttr("aria-label", t("ui.book_bar_label"));
  track.setAttr("aria-valuemin", "0");
  track.setAttr("aria-valuemax", String(total));
  track.setAttr("aria-valuenow", String(settledCount(state)));
  track.setAttr("aria-valuetext", progressText);
  const segments: [string, number][] = [
    ["checked", counts.checked],
    ["needs-review", counts["needs-review"]]
  ];
  for (const [name, count] of segments) {
    if (!count || !total) continue;
    track.createSpan({ cls: `vam-book-seg is-${name}` }).style.width = `${(count / total) * 100}%`;
  }
  return bar;
}

const STRUCTURE_KIND_KEY: Record<BookStructureItem["kind"], TranslationKey> = {
  add: "ui.book_struct_kind_add",
  remove: "ui.book_struct_kind_remove",
  merge: "ui.book_struct_kind_merge",
  move: "ui.book_struct_kind_move",
  rename: "ui.book_struct_kind_rename"
};

/**
 * The plan review's structure changes, folded to one line ("N changes · show ▸" and "accept"); opened, each change with its reason
 * and an undo. Accepting removes the line. Plain text only: nothing here is rendered as Markdown or HTML.
 */
function renderStructureEdit(bar: HTMLElement, view: BookStructureEditView, actions: BookBarActions): void {
  const box = bar.createDiv("vam-book-structure");
  box.setAttr("role", "group");
  box.setAttr("aria-label", t("ui.book_struct_label"));
  const accept = actions.structureAccept;
  const busy = actions.structureUndo === "busy";
  // Without a fold state (no view memory) the list shows open, so nothing is hidden behind a button that cannot work.
  const expanded = !accept || accept.expanded || !view.items.length;
  if (view.items.length) {
    const head = box.createDiv("vam-book-structure-head");
    head.createSpan({
      cls: "vam-book-structure-sum",
      text: view.active ? t("ui.book_struct_head_0", view.active) : t("ui.book_struct_head_all_undone")
    });
    if (accept) {
      const toggle = makeButton(
        head,
        t(accept.expanded ? "ui.book_struct_hide" : "ui.book_struct_show"),
        "vam-book-link vam-book-structure-toggle",
        accept.toggle
      );
      toggle.setAttr("aria-expanded", String(accept.expanded));
      toggle.setAttr("aria-controls", "vam-book-structure-list");
      const button = makeButton(head, t("ui.book_struct_accept"), "vam-book-structure-accept", accept.accept);
      if (busy) button.setAttr("disabled", "true");
    }
  }
  if (!expanded) return;
  const list = box.createDiv("vam-book-structure-list");
  list.id = "vam-book-structure-list";
  const mayUndo = !!actions.undoStructure;
  for (const item of view.items) {
    const row = list.createDiv(`vam-book-structure-row${item.undone ? " is-undone" : ""}`);
    row.dataset.op = item.id;
    row.createSpan({ cls: `vam-book-structure-kind is-${item.kind}`, text: t(STRUCTURE_KIND_KEY[item.kind]) });
    const what = row.createDiv("vam-book-structure-what");
    what.createSpan({ cls: "vam-book-structure-text", text: item.text });
    if (item.undone) what.createSpan({ cls: "vam-book-structure-undone", text: ` ${t("ui.book_struct_undone")}` });
    const why = what.createDiv("vam-book-structure-why");
    if (item.reason) why.createSpan({ text: item.reason });
    if (item.archivedPath && actions.openArchived) {
      const path = item.archivedPath;
      const open = actions.openArchived;
      makeButton(why, t("ui.book_struct_open_archived"), "vam-book-link vam-book-structure-archived", () => open(path));
    }
    const dependents = item.undone ? [] : item.dependents;
    if (dependents.length) {
      const note = what.createDiv("vam-book-structure-dep");
      note.id = `vam-book-structure-dep-${item.id}`;
      note.setText(
        t(
          "ui.book_struct_dep_0",
          dependents.map(d => `${t(STRUCTURE_KIND_KEY[d.kind])}「${d.title}」`).join(t("ui.book_struct_join"))
        )
      );
    }
    if (!item.undone && mayUndo) {
      const undo = makeButton(row, t("ui.book_struct_undo"), "vam-book-structure-undo", () =>
        actions.undoStructure?.([item.id])
      );
      undo.setAttr("aria-label", t("ui.book_struct_undo_0", item.text));
      if (dependents.length) undo.setAttr("aria-describedby", `vam-book-structure-dep-${item.id}`);
      if (busy) undo.setAttr("disabled", "true");
    }
  }
  const na = view.notApplied;
  if (na) {
    const lines: string[] = [];
    if (na.overCap) lines.push(t("ui.book_struct_over_cap"));
    const reasons = [
      ...(na.locked ? [t("ui.book_struct_why_locked")] : []),
      ...(na.other ? [t("ui.book_struct_why_rules")] : [])
    ];
    if (reasons.length)
      lines.push(t("ui.book_struct_skipped_0_1", na.locked + na.other, reasons.join(t("ui.book_struct_join"))));
    for (const line of lines) list.createDiv("vam-book-structure-skipped").setText(line);
  }
  if (actions.structureUndo === "busy") {
    const line = list.createDiv("vam-book-structure-status");
    line.setAttr("role", "status");
    line.setText(t("ui.book_struct_busy"));
  } else if (actions.structureUndo === "failed") {
    const line = list.createDiv("vam-book-structure-status is-failed");
    line.setAttr("role", "status");
    line.setText(t("ui.book_struct_failed"));
  }
}

/** The "fix again" confirmation card: how many chapters and problems, the calls it costs, what will probably stay and what is not touched. Escape cancels. */
function renderFixAgainCard(
  bar: HTMLElement,
  plan: NonNullable<BookBarState["fixAgain"]>,
  ask: { cancel: () => void; confirm: () => void }
): void {
  const title = t("ui.book_fix_again_title");
  const card = bar.createDiv("vam-book-abandon-card vam-book-fix-again-card");
  card.setAttr("role", "group");
  card.setAttr("aria-label", title);
  card.createEl("b", { text: title });
  card.createEl("p", {
    text: plan.chapters
      ? t("ui.book_fix_again_body_0_1_2", plan.chapters, plan.items, plan.calls)
      : t("ui.book_fix_again_body_book_0_1", plan.items, plan.calls)
  });
  const note = plan.stubborn
    ? plan.statusItems
      ? t("ui.book_fix_again_note_0_1", plan.stubborn, plan.statusItems)
      : t("ui.book_fix_again_note_stubborn_0", plan.stubborn)
    : plan.statusItems
      ? t("ui.book_fix_again_note_status_0", plan.statusItems)
      : "";
  if (note) card.createEl("p", { cls: "vam-book-fix-again-note", text: note });
  const row = card.createDiv("vam-book-abandon-actions");
  makeButton(row, t("ui.cancel"), "vam-book-fix-again-cancel", ask.cancel);
  makeButton(row, t("ui.book_fix_again_go"), "mod-cta vam-book-fix-again-go", ask.confirm);
  card.addEventListener("keydown", event => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    event.preventDefault();
    ask.cancel();
  });
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

/** The fix line of a run with a structure: the card is named by its place, the done count is in cards. */
function fixLine(state: BookBarState, done: number, total: number): string {
  const place = state.current?.place;
  if (!state.structure || !place) return t("ui.book_progress_line_fix_0_1_2", state.current?.chapter ?? 1, done, total);
  if (place.kind === "preface") return t("ui.book_progress_line_fix_preface_0_1", done, total);
  if (place.kind === "chapter") return t("ui.book_progress_line_fix_card_0_1_2", place.chapter ?? 1, done, total);
  return t("ui.book_progress_line_fix_section_0_1_2", place.title ?? "", done, total);
}

/** The one sentence of the bar, as screen readers get it: while writing, the done count and then the chapter in work. */
export function bookProgressText(state: BookBarState): string {
  const at = writingAtText(state);
  return at ? `${progressMain(state)}${t("ui.book_progress_line_sep")}${at}` : progressMain(state);
}
/** The bar's sentence without the chapter in work: "Writing · 2/31 chapters done"; the whole-book plan and the chapter plans have their own words. */
function progressMain(state: BookBarState): string {
  const { total } = state;
  const at = Math.min(state.current?.chapter ?? settledCount(state) + 1, Math.max(total, 1));
  // Writing: how many are done (the fill below shows the same); the chapter in work is its own muted part.
  if (state.mode === "writing")
    // Only fix rounds in work: a named fix line with the whole-book done count, never a restarted counter.
    return state.current?.fix
      ? fixLine(state, settledCount(state), total)
      : t(
          state.structure ? "ui.book_progress_writing_cards_0_1" : "ui.book_progress_writing_0_1",
          settledCount(state),
          total
        );
  const sentence =
    state.mode === "planning"
      ? !state.globalDone || state.current?.step === "global"
        ? t("ui.book_progress_line_global")
        : t(state.structure ? "ui.book_progress_line_plan_cards_0_1" : "ui.book_progress_line_plan_0_1", at, total)
      : t(state.structure ? "ui.book_progress_line_write_cards_0_1" : "ui.book_progress_line_write_0_1", at, total);
  return `${sentence}${t("ui.book_progress_line_sep")}${t(state.structure ? "ui.book_progress_line_done_cards_0_1" : "ui.book_progress_line_done_0_1", settledCount(state), total)}`;
}
/** While writing (not in a fix round): which card is in work, the muted half of the line ("now writing chapter 2"). */
function writingAtText(state: BookBarState): string | undefined {
  if (state.mode !== "writing" || state.current?.fix) return undefined;
  const at = Math.min(state.current?.chapter ?? settledCount(state) + 1, Math.max(state.total, 1));
  return t(state.structure ? "ui.book_progress_at_card_0" : "ui.book_progress_at_chapter_0", at);
}
function renderProgressLine(bar: HTMLElement, state: BookBarState): void {
  const running = state.mode === "planning" || state.mode === "writing";
  if (!running) return;
  const now = bar.createDiv("vam-book-now");
  now.createSpan({ cls: "vam-book-now-text", text: progressMain(state) });
  const at = writingAtText(state);
  if (at) now.createSpan({ cls: "vam-book-now-at", text: at });
  // "About N minutes left" only when the runner has a real estimate (at least five finished cards); no number is made up.
  if (state.etaSeconds !== undefined) now.createSpan({ cls: "vam-book-bar-eta", text: bookEtaText(state.etaSeconds) });
  if (state.mode === "writing")
    now.createSpan({ cls: "vam-book-ai-counts", text: t("ui.book_bar_ai_0_1", state.ai.fixing, state.ai.open) });
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
  ai_locked: "ui.ai_locked_notice",
  notes_busy: "ui.book_refused_notes_busy",
  drive_running: "ui.book_refused_drive_running",
  cancelled: "ui.book_refused_cancelled",
  gate_cancelled: "ui.book_refused_gate_cancelled",
  stale: "ui.book_refused_stale",
  backup_failed: "ui.book_refused_backup_failed",
  text_changed: "ui.book_refused_text_changed",
  nothing: "ui.book_refused_nothing",
  unsafe: "ui.book_refused_unsafe",
  not_slot: "ui.book_refused_not_slot"
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

/** The notice for a book whose closing page was not written because its only gap is chapters the AI proofread skipped as locked. */
export function lockedSkippedNotice(titles: readonly string[]): string {
  return t("ui.book_locked_skipped_0", titles.join(t("ui.list_separator")));
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
const STEP_KEY = { plan: "ui.book_step_plan", write: "ui.book_step_write", proof: "ui.book_step_self_check" } as const;
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
  "plan:ai_locked": "ui.ai_locked_notice",
  "write:ai_locked": "ui.ai_locked_notice",
  "proof:ai_locked": "ui.ai_locked_notice",
  "write:no_body": "ui.book_plain_write_no_body",
  "write:author_failed": "ui.book_plain_write_author_failed",
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
  const carried = splitCarriedIssue(issue);
  if (carried) return joinReasons([bookIssueText(carried.failure), bookIssueText(carried.carried)]);
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
    ...(pictures.captionLatin ? [t("ui.book_reason_caption_latin")] : []),
    ...(pictures.coverOff ? [t("ui.book_reason_cover_off")] : [])
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
  prompt?: unknown;
}
export interface BookCardView {
  stage: PipelineStage | "pending";
  stageText: string;
  roleText?: string;
  /** Preface / chapter n / section, from the book structure; replaces the role chip when the card has a place. */
  placeText?: string;
  /** A planned card's content headings (a short list instead of the summary); absent when the Prompt has none. */
  points?: string[];
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
 * `rerunning`: a single-chapter rerun passes through "planned"; the card keeps its written look (summary, not plan headings).
 */
export function bookCardView(
  note: BookCardInput,
  accepted = false,
  stale = false,
  resolved = false,
  place?: CardPlace,
  rerunning = false
): BookCardView {
  accepted = accepted || resolved;
  const stage = readPipelineStage(note.pipelineStage) ?? "pending";
  const role = readBookRole(note.bookRole);
  const issue = typeof note.pipelineIssue === "string" && note.pipelineIssue ? note.pipelineIssue : undefined;
  const planLook = stage === "planned" && !rerunning;
  const points = planLook && typeof note.prompt === "string" ? parseCardPoints(note.prompt) : undefined;
  return {
    stage,
    stageText: t(STAGE_KEY[stage]),
    ...(place ? { placeText: placeLabel(place) } : {}),
    ...(points ? { points } : {}),
    ...(!accepted && stale && stage === "checked" ? { edited: true } : {}),
    seam: !accepted && typeof note.pipelineSeam === "string" && note.pipelineSeam.trim() !== "",
    ...(accepted && stage === "needs-review" ? { hideStage: true } : {}),
    ...(role ? { roleText: t(ROLE_KEY[role]) } : {}),
    ...(!accepted && stage === "needs-review" && issue
      ? { issueText: t("ui.book_issue_0", bookIssueText(issue)) }
      : {}),
    ...(!accepted && stage === "checked" && issue ? structureNote(issue) : {}),
    ...(stage === "pending" ? {} : { summaryPrefix: t(planLook ? "ui.book_summary_plan" : "ui.book_summary_done") })
  };
}

function placeLabel(place: CardPlace): string {
  return place.kind === "preface"
    ? t("ui.book_place_preface")
    : place.kind === "chapter"
      ? t("ui.book_place_chapter_0", place.chapter ?? 0)
      : t("ui.book_place_section");
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
  const label = view.placeText ?? view.roleText;
  if (label) header.createSpan({ cls: "vam-book-role", text: label });
}

/** The run waits at gate 1 for the owner (not driving): the only state in which a chat "continue" confirms the plan. */
export function isBookGate1Waiting(
  progress: Pick<BookPipelineProgress, "phase" | "active"> | undefined,
  data: Pick<BookPipelineData, "phase">
): boolean {
  return (progress?.phase ?? data.phase) === "gate1" && !progress?.active;
}
