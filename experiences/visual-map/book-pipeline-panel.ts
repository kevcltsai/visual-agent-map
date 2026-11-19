import { t } from "../../i18n";
import { type BookSettings, type BookSettingsPatch, type PipelineStage } from "../../core/book-pipeline/model";
import { parseBookPlanBody } from "../../core/book-pipeline/plan-text";
import { visibleDetail } from "../../core/book-pipeline/note-sections";
import { firstSentence } from "../../core/book-pipeline/text";
import { bookCardView, bookRefusalText, type BookCardInput } from "./book-pipeline-ui";
import {
  bookSettingsPatch,
  renderBookModelChoice,
  renderBookSettingsFields,
  type BookModelChoiceInput,
  type BookSettingsFields,
  type BookStartModels
} from "./book-pipeline-start-modal";

/**
 * Gate 1 side panel: the trial screen. The book's one-sentence thread, the finished chapters of the trial run (their text and pictures,
 * drawn by the Markdown renderer the view hands in), the whole-book settings and models folded away, and two buttons: run the whole
 * book, or run the trial chapters again with the changed settings. A run without a trial (older data) shows the thread and the first
 * button only. Every string from a note or the model is put on screen with textContent (createEl `text`, setText), never as markup;
 * the chapter text goes through the renderer only.
 * The panel is drawn only for a map that has a usable `bookPipeline`; the view decides that before it calls anything here.
 */

export interface GateCardInput extends BookCardInput {
  prompt: string;
  summary: string;
  pipelineStage?: unknown;
  /** The card's Detail (gate 2 reads its research notes for the proof record). */
  detail?: string;
}

export interface GatePanelTrialCard {
  id: string;
  index: number;
  title: string;
  stage: PipelineStage | "pending";
  issueText?: string;
  /** The chapter as the reader sees it (without the hidden work records): text, pictures, sources. */
  text: string;
}

export interface GatePanelData {
  /** The first sentence of the book thread ('' when the plan has none). */
  thread: string;
  /** The trial chapters in reading order; empty for a run without a trial. */
  trial: GatePanelTrialCard[];
}

/** What the panel shows, from the real notes: `rootRaw` is the root note's whole file text, `order` the run's reading order. */
export function buildGatePanel(input: {
  order: readonly string[];
  /** The run's trial cards (absent for an older run). */
  trial?: readonly string[];
  titleOf: (id: string) => string;
  noteOf: (id: string) => GateCardInput | undefined;
  rootRaw: string;
}): GatePanelData {
  const plan = parseBookPlanBody(input.rootRaw);
  const trial = input.order
    .filter(id => input.trial?.includes(id))
    .map((id): GatePanelTrialCard => {
      const note = input.noteOf(id);
      const view = bookCardView(note ?? {});
      return {
        id,
        index: input.order.indexOf(id) + 1,
        title: input.titleOf(id),
        stage: view.stage,
        ...(view.issueText ? { issueText: view.issueText } : {}),
        text: visibleDetail(note?.detail ?? "")
      };
    });
  return { thread: firstSentence(plan.thread), trial };
}

/** What the panel remembers across the map's repaints (the repaint rebuilds the DOM; this is on the view). */
export class GatePanelState {
  open = false;
  /** The map's root note text, read when the panel is drawn (for the thread), and the root topic's whole-book settings. */
  rootRaw = "";
  settings: BookSettings = {};
  /** Gate 1: the settings and models fold is open; what the owner typed in the fields (kept across repaints until a retry applies it). */
  settingsOpen = false;
  readonly settingDrafts = new Map<string, string>();
  confirming = false;
  retrying = false;
  confirmError = "";
  /** Gate 2: which cards are working, and the line under each (see panel2). */
  readonly busy = new Set<string>();
  readonly notes = new Map<string, { text: string; error: boolean }>();
  /** Gate 2: cards whose proof record is unfolded, cards whose seam confirmation is running, and the "review finished" button. */
  readonly proofOpen = new Set<string>();
  readonly seaming = new Set<string>();
  finishing = false;
  /** The "still have things to do" question is open: the button waits for its answer. */
  finishAsking = false;
  finishError = "";
  /** Cards whose latest rerun gave the same result and still need a person (memory only; dies with the view). */
  readonly unchanged = new Set<string>();
  /** Where the keyboard goes after the next paint: the panel's title (it just opened) or the toolbar button (it just closed). */
  pendingFocus: "title" | "opener" | null = null;
  reset(): void {
    this.open = false;
    this.rootRaw = "";
    this.settings = {};
    this.settingsOpen = false;
    this.settingDrafts.clear();
    this.busy.clear();
    this.notes.clear();
    this.confirming = false;
    this.retrying = false;
    this.confirmError = "";
    this.proofOpen.clear();
    this.seaming.clear();
    this.finishing = false;
    this.finishAsking = false;
    this.finishError = "";
    this.unchanged.clear();
    this.pendingFocus = null;
  }
}

/**
 * Runs one card's rerun and keeps the "same result, still needs a person" mark (memory only) honest: the old mark goes before the
 * run starts and comes back only when this run left the result the same. Both the panel button and the card's right-click menu use it.
 */
export async function runTrackedRerun(
  state: GatePanelState,
  nodeId: string,
  rerun: () => Promise<{ unchanged: boolean } | void>
): Promise<void> {
  state.unchanged.delete(nodeId);
  const result = await rerun();
  if (result && result.unchanged) state.unchanged.add(nodeId);
}

export interface GatePanelActions {
  /** Writes what the owner changed in the settings (possibly nothing), then confirms the plan: the whole book runs with them. */
  confirm: (patch: BookSettingsPatch) => Promise<void>;
  /** Writes what the owner changed in the settings (possibly nothing), then runs the trial chapters again. */
  retry: (patch: BookSettingsPatch) => Promise<void>;
  /** Draws `markdown` into `el` (the view's Markdown renderer, whose component is unloaded when the panel is drawn again or closed). */
  renderMarkdown: (el: HTMLElement, markdown: string) => void;
  /** The root topic's whole-book settings and the model of each step, with the lists and where a pick is saved. */
  settings: BookSettings;
  models: BookStartModels;
  modelChoice: Omit<BookModelChoiceInput, "models">;
  /** The "Chat" tab: closes this panel and opens the chat window. */
  showChat: () => void;
  close: () => void;
  /** Repaint the panel (its own DOM) from the current state. */
  refresh: () => void;
}

/** The tab row (book panel / chat / close) and the Escape key, shared by both gate panels. */
export function renderPanelTabs(panel: HTMLElement, actions: Pick<GatePanelActions, "showChat" | "close">): void {
  const tabs = panel.createDiv("vam-book-panel-tabs");
  tabs.setAttr("role", "group");
  tabs.setAttr("aria-label", t("ui.book_panel_tabs_label"));
  const bookTab = tabs.createEl("button", { cls: "vam-book-panel-tab is-active", text: t("ui.book_panel_tab_book") });
  bookTab.setAttr("aria-pressed", "true");
  const chatTab = tabs.createEl("button", { cls: "vam-book-panel-tab", text: t("ui.book_panel_tab_chat") });
  chatTab.setAttr("aria-pressed", "false");
  chatTab.addEventListener("click", event => {
    event.stopPropagation();
    actions.showChat();
  });
  const closeButton = tabs.createEl("button", { cls: "vam-book-panel-close", text: "×" });
  closeButton.setAttr("aria-label", t("ui.book_panel_close"));
  closeButton.addEventListener("click", event => {
    event.stopPropagation();
    actions.close();
  });
  panel.addEventListener("keydown", event => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    actions.close();
  });
}

/** What the owner typed in the settings fold, as the patch both buttons write (only the changed fields). */
function typedPatch(state: GatePanelState, actions: GatePanelActions): BookSettingsPatch {
  const typed: Record<string, string> = {};
  for (const [field, value] of state.settingDrafts) typed[field] = value;
  return bookSettingsPatch(actions.settings, typed);
}

/** Draws the panel into `parent` (the view's right-hand column). `gate1` is false once the run has left gate 1. */
export function renderGatePanel(
  parent: HTMLElement,
  data: GatePanelData,
  gate1: boolean,
  state: GatePanelState,
  actions: GatePanelActions
): HTMLElement {
  const panel = parent.createDiv("vam-book-panel");
  panel.setAttr("role", "region");
  panel.setAttr("aria-label", t("ui.book_panel_label"));
  renderPanelTabs(panel, actions);

  const hasTrial = data.trial.length > 0;
  const head = panel.createDiv("vam-book-panel-head");
  const title = head.createEl("h3", {
    cls: "vam-book-panel-title",
    text: t(hasTrial ? "ui.book_trial_title" : "ui.book_panel_gate1_title")
  });
  title.setAttr("tabindex", "-1");
  if (!gate1) {
    panel.createDiv({ cls: "vam-book-panel-note", text: t("ui.book_panel_not_gate1") });
    return panel;
  }

  const plan = panel.createDiv("vam-book-panel-plan");
  if (data.thread) {
    plan.createDiv({ cls: "vam-book-panel-thread-label", text: t("ui.book_gate1_thread_label") });
    plan.createDiv({ cls: "vam-book-panel-thread", text: data.thread });
  } else plan.createDiv({ cls: "vam-book-panel-muted", text: t("ui.book_panel_plan_empty") });

  if (hasTrial) {
    const list = panel.createEl("ul", { cls: "vam-book-trial-cards" });
    list.setAttr("aria-label", t("ui.book_trial_cards_label"));
    for (const card of data.trial) renderTrialCard(list, card, actions);
    renderSettingsFold(panel, state, actions);
  }

  const foot = panel.createDiv("vam-book-panel-foot");
  const working = state.confirming || state.retrying;
  const confirm = foot.createEl("button", {
    cls: "mod-cta vam-book-panel-confirm",
    text: state.confirming ? t("ui.book_panel_confirming") : t("ui.book_confirm_gate1")
  });
  confirm.disabled = working;
  if (state.confirming) confirm.setAttr("aria-busy", "true");
  confirm.addEventListener("click", event => {
    event.stopPropagation();
    if (working) return;
    const patch = typedPatch(state, actions);
    state.confirming = true;
    state.confirmError = "";
    actions.refresh();
    void actions.confirm(patch).then(
      () => {
        state.confirming = false;
        state.settingDrafts.clear();
        actions.refresh();
      },
      error => {
        state.confirming = false;
        state.confirmError = bookRefusalText(error);
        actions.refresh();
      }
    );
  });
  if (hasTrial) {
    const retry = foot.createEl("button", {
      cls: "vam-book-panel-retry",
      text: state.retrying ? t("ui.book_panel_confirming") : t("ui.book_trial_retry")
    });
    retry.disabled = working;
    if (state.retrying) retry.setAttr("aria-busy", "true");
    retry.addEventListener("click", event => {
      event.stopPropagation();
      if (working) return;
      const patch = typedPatch(state, actions);
      state.retrying = true;
      state.confirmError = "";
      actions.refresh();
      void actions.retry(patch).then(
        () => {
          state.retrying = false;
          state.settingDrafts.clear();
          actions.refresh();
        },
        error => {
          state.retrying = false;
          state.confirmError = bookRefusalText(error);
          actions.refresh();
        }
      );
    });
  }
  const status = panel.createDiv({ cls: "vam-book-panel-status", text: state.confirmError });
  status.setAttr("role", "status");
  return panel;
}

function renderTrialCard(list: HTMLElement, card: GatePanelTrialCard, actions: GatePanelActions): void {
  const item = list.createEl("li", { cls: "vam-book-trial-card" });
  item.dataset.stage = card.stage;
  const head = item.createDiv("vam-book-trial-card-head");
  head.createEl("b", { cls: "vam-book-trial-card-title", text: t("ui.book_trial_card_0_1", card.index, card.title) });
  const done = card.stage === "checked" || card.stage === "written";
  head.createSpan({
    cls: `vam-book-trial-pill ${done ? "is-ok" : "is-look"}`,
    text: done ? t("ui.book_trial_done") : t("ui.book_trial_look")
  });
  if (card.issueText && !done) item.createDiv({ cls: "vam-book-panel-issue", text: card.issueText });
  const body = item.createDiv("vam-book-trial-text");
  body.tabIndex = 0;
  body.setAttr("role", "region");
  body.setAttr("aria-label", t("ui.book_trial_text_label_0", card.title));
  if (card.text) actions.renderMarkdown(body, card.text);
  else body.createDiv({ cls: "vam-book-panel-muted", text: t("ui.book_trial_no_text") });
}

/** "Want to change something?" opens the six settings and the four models; a retry applies what was changed. */
function renderSettingsFold(panel: HTMLElement, state: GatePanelState, actions: GatePanelActions): void {
  const toggle = panel.createEl("button", { cls: "vam-book-trial-fold", text: t("ui.book_trial_fold") });
  toggle.setAttr("aria-expanded", String(state.settingsOpen));
  const body = panel.createDiv("vam-book-trial-settings vam-book-start-settings");
  body.setAttr("id", "vam-book-trial-settings");
  toggle.setAttr("aria-controls", "vam-book-trial-settings");
  body.hidden = !state.settingsOpen;
  toggle.addEventListener("click", event => {
    event.stopPropagation();
    state.settingsOpen = !state.settingsOpen;
    toggle.setAttr("aria-expanded", String(state.settingsOpen));
    body.hidden = !state.settingsOpen;
  });
  const fields: BookSettingsFields = renderBookSettingsFields(body, actions.settings);
  for (const [field, area] of fields.areas) {
    const draft = state.settingDrafts.get(field);
    if (draft !== undefined) area.value = draft;
    area.addEventListener("input", () => state.settingDrafts.set(field, area.value));
  }
  const choice = body.createDiv("vam-book-start-model-choice");
  renderBookModelChoice(choice, { ...actions.modelChoice, models: actions.models });
}
