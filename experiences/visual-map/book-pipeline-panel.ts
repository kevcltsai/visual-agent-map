import type { TranslationKey } from "../../i18n";
import { t } from "../../i18n";
import { BOOK_SETTING_FIELDS, type BookSettingField, type PipelineStage } from "../../core/book-pipeline/model";
import { parseBookPlanBody, parseBookPlanDecisions, parseCardPrompt } from "../../core/book-pipeline/plan-text";
import { bookCardView, bookFailureText, bookRefusalText, type BookCardInput } from "./book-pipeline-ui";
import type { CardPlanSummary } from "./book-pipeline-run";

/**
 * Gate 1 side panel (04b): the book's thread and editorial decisions, one block per card with its plan, "say more about X" and the
 * confirm button. Every string from a note or the model is put on screen with textContent (createEl `text`, setText), never as markup.
 * The panel is drawn only for a map that has a usable `bookPipeline`; the view decides that before it calls anything here.
 */

export interface GateCardInput extends BookCardInput {
  prompt: string;
  summary: string;
  pipelineStage?: unknown;
}

export interface GatePanelCard {
  id: string;
  index: number;
  title: string;
  stage: PipelineStage | "pending";
  roleText?: string;
  issueText?: string;
  fields: { label: string; value: string }[];
  /** When no labelled line could be read: the first three lines of the Prompt as they are. */
  rawLines: string[];
}

export interface GatePanelData {
  total: number;
  planned: number;
  needsReview: number;
  thread: string;
  decisions: { label: string; value: string }[];
  materialCount: number;
  cards: GatePanelCard[];
}

const FIELD_KEY: Record<BookSettingField, TranslationKey> = {
  reader: "ui.book_field_reader",
  goal: "ui.book_field_goal",
  angle: "ui.book_field_angle",
  tone: "ui.book_field_tone",
  length: "ui.book_field_length",
  style: "ui.book_field_style"
};

/** What the panel shows, from the real notes: `rootRaw` is the root note's whole file text, `order` the run's reading order. */
export function buildGatePanel(input: {
  order: readonly string[];
  titleOf: (id: string) => string;
  noteOf: (id: string) => GateCardInput | undefined;
  rootRaw: string;
}): GatePanelData {
  const plan = parseBookPlanBody(input.rootRaw);
  const decided = parseBookPlanDecisions(input.rootRaw);
  const cards = input.order.map((id, at): GatePanelCard => {
    const note = input.noteOf(id);
    const view = bookCardView(note ?? {});
    const prompt = note?.prompt ?? "";
    const parsed = parseCardPrompt(prompt);
    const fields: GatePanelCard["fields"] = [];
    if (parsed.covers) fields.push({ label: t("ui.book_panel_covers"), value: parsed.covers });
    if (parsed.entry) fields.push({ label: t("ui.book_panel_entry"), value: parsed.entry });
    if (parsed.handoff) fields.push({ label: t("ui.book_panel_handoff"), value: parsed.handoff });
    const rawLines = fields.length
      ? []
      : prompt
          .split(/\r?\n/)
          .filter(line => line.trim())
          .slice(0, 3);
    return {
      id,
      index: at + 1,
      title: input.titleOf(id),
      stage: view.stage,
      ...(view.roleText ? { roleText: view.roleText } : {}),
      ...(view.issueText ? { issueText: view.issueText } : {}),
      fields,
      rawLines
    };
  });
  return {
    total: cards.length,
    planned: cards.filter(card => card.stage !== "pending").length,
    needsReview: cards.filter(card => card.stage === "needs-review").length,
    thread: plan.thread,
    decisions: BOOK_SETTING_FIELDS.filter(field => decided[field]?.trim()).map(field => ({
      label: t(FIELD_KEY[field]),
      value: decided[field] as string
    })),
    materialCount: plan.materials.length,
    cards
  };
}

/** What the panel remembers across the map's repaints (the repaint rebuilds the DOM; this is on the view). */
export class GatePanelState {
  open = false;
  expanded = false;
  /** The map's root note text, read when the panel is drawn (for the thread and the decisions). */
  rootRaw = "";
  readonly drafts = new Map<string, string>();
  readonly busy = new Set<string>();
  readonly notes = new Map<string, { text: string; error: boolean }>();
  confirming = false;
  confirmError = "";
  /** Where the keyboard goes after the next paint: the panel's title (it just opened) or the toolbar button (it just closed). */
  pendingFocus: "title" | "opener" | null = null;
  reset(): void {
    this.open = false;
    this.expanded = false;
    this.rootRaw = "";
    this.drafts.clear();
    this.busy.clear();
    this.notes.clear();
    this.confirming = false;
    this.confirmError = "";
    this.pendingFocus = null;
  }
}

export interface GatePanelActions {
  /** Opens the card's note at its `## Prompt`. */
  editPlan: (nodeId: string) => void;
  replan: (nodeId: string, instruction: string) => Promise<{ plan?: CardPlanSummary; reason?: string }>;
  rerunPlan: (nodeId: string) => Promise<void>;
  confirm: () => Promise<void>;
  /** The "Chat" tab: closes this panel and opens the chat window. */
  showChat: () => void;
  close: () => void;
  /** Repaint the panel (its own DOM) from the current state. */
  refresh: () => void;
}

const REASON_CODES = new Set(["invalid_reply", "backup_failed", "discarded", "card_removed", "missing"]);
function reasonText(reason: string): string {
  if (reason === "budget") return t("ui.book_refused_budget");
  if (reason === "cancelled") return t("ui.book_panel_cancelled");
  return REASON_CODES.has(reason) ? bookFailureText(reason) : t("ui.book_fail_other");
}

/** Draws the panel into `parent` (the view's right-hand column). `gate1` is false once the run has left gate 1. */
export function renderGatePanel(
  parent: HTMLElement,
  data: GatePanelData,
  gate1: boolean,
  state: GatePanelState,
  actions: GatePanelActions,
  /** Cards the runner is working on right now (from its progress), shown busy like the ones this panel started. */
  externalBusy: ReadonlySet<string> = new Set()
): HTMLElement {
  const panel = parent.createDiv("vam-book-panel");
  panel.setAttr("role", "region");
  panel.setAttr("aria-label", t("ui.book_panel_label"));
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

  const head = panel.createDiv("vam-book-panel-head");
  const title = head.createEl("h3", { cls: "vam-book-panel-title", text: t("ui.book_panel_gate1_title") });
  title.setAttr("tabindex", "-1");
  if (!gate1) {
    panel.createDiv({ cls: "vam-book-panel-note", text: t("ui.book_panel_not_gate1") });
    return panel;
  }
  head.createSpan({
    cls: "vam-book-panel-tag",
    text:
      data.needsReview || data.planned < data.total
        ? t("ui.book_panel_some_planned_0_1_2", data.planned, data.total, data.needsReview)
        : t("ui.book_panel_all_planned_0", data.total)
  });

  const plan = panel.createDiv("vam-book-panel-plan");
  const toggle = plan.createEl("button", { cls: "vam-book-panel-plan-toggle", text: t("ui.book_panel_plan_heading") });
  toggle.setAttr("aria-expanded", String(state.expanded));
  const body = plan.createDiv("vam-book-panel-plan-body");
  body.hidden = !state.expanded;
  toggle.addEventListener("click", event => {
    event.stopPropagation();
    state.expanded = !state.expanded;
    toggle.setAttr("aria-expanded", String(state.expanded));
    body.hidden = !state.expanded;
  });
  if (!data.thread && !data.decisions.length && !data.materialCount)
    body.createDiv({ cls: "vam-book-panel-muted", text: t("ui.book_panel_plan_empty") });
  if (data.thread) body.createDiv({ cls: "vam-book-panel-thread", text: t("ui.book_panel_thread_0", data.thread) });
  if (data.decisions.length)
    body.createDiv({
      cls: "vam-book-panel-decisions",
      text: t("ui.book_panel_decisions_0", data.decisions.map(item => `${item.label}：${item.value}`).join("；"))
    });
  if (data.materialCount)
    body.createDiv({ cls: "vam-book-panel-materials", text: t("ui.book_panel_materials_0", data.materialCount) });

  const list = panel.createEl("ul", { cls: "vam-book-panel-cards" });
  list.setAttr("aria-label", t("ui.book_panel_cards_label"));
  for (const card of data.cards) renderCard(list, card, state, actions, externalBusy.has(card.id));

  const foot = panel.createDiv("vam-book-panel-foot");
  foot.createSpan({ cls: "vam-book-panel-muted", text: t("ui.book_panel_hint") });
  const confirm = foot.createEl("button", {
    cls: "mod-cta vam-book-panel-confirm",
    text: state.confirming ? t("ui.book_panel_confirming") : t("ui.book_confirm_gate1")
  });
  confirm.disabled = state.confirming;
  if (state.confirming) confirm.setAttr("aria-busy", "true");
  confirm.addEventListener("click", event => {
    event.stopPropagation();
    if (state.confirming) return;
    state.confirming = true;
    state.confirmError = "";
    actions.refresh();
    void actions.confirm().then(
      () => {
        state.confirming = false;
        actions.refresh();
      },
      error => {
        state.confirming = false;
        state.confirmError = bookRefusalText(error);
        actions.refresh();
      }
    );
  });
  const status = panel.createDiv({ cls: "vam-book-panel-status", text: state.confirmError });
  status.setAttr("role", "status");
  return panel;
}

function renderCard(
  list: HTMLElement,
  card: GatePanelCard,
  state: GatePanelState,
  actions: GatePanelActions,
  external: boolean
): void {
  const busy = external || state.busy.has(card.id);
  const item = list.createEl("li", { cls: "vam-book-panel-card" });
  item.dataset.stage = card.stage;
  if (busy) item.setAttr("aria-busy", "true");
  const head = item.createDiv("vam-book-panel-card-head");
  if (card.roleText) head.createSpan({ cls: "vam-book-role", text: card.roleText });
  head.createEl("b", { cls: "vam-book-panel-card-title", text: `${card.index} ${card.title}` });
  const edit = head.createEl("button", { cls: "vam-book-panel-edit", text: t("ui.book_panel_edit_plan") });
  edit.setAttr("aria-label", t("ui.book_panel_edit_plan_0", card.title));
  edit.addEventListener("click", event => {
    event.stopPropagation();
    actions.editPlan(card.id);
  });
  if (card.fields.length)
    for (const field of card.fields)
      item.createDiv({ cls: "vam-book-panel-field", text: `${field.label}：${field.value}` });
  else if (card.rawLines.length)
    for (const line of card.rawLines) item.createDiv({ cls: "vam-book-panel-field is-raw", text: line });
  else item.createDiv({ cls: "vam-book-panel-muted", text: t("ui.book_panel_no_plan") });
  if (card.issueText) {
    const issue = item.createDiv("vam-book-panel-issue");
    issue.createSpan({ text: card.issueText });
    const rerun = issue.createEl("button", { cls: "vam-book-panel-rerun", text: t("ui.book_panel_rerun_plan") });
    rerun.setAttr("aria-label", t("ui.book_panel_rerun_plan_0", card.title));
    rerun.disabled = busy;
    rerun.addEventListener("click", event => {
      event.stopPropagation();
      if (state.busy.has(card.id)) return;
      state.busy.add(card.id);
      state.notes.delete(card.id);
      actions.refresh();
      void actions.rerunPlan(card.id).then(
        () => finish(card.id, state, actions, undefined),
        error => finish(card.id, state, actions, { text: bookRefusalText(error), error: true })
      );
    });
  }
  const form = item.createDiv("vam-book-panel-more");
  const input = form.createEl("input", { cls: "vam-book-panel-more-input", type: "text" });
  input.dataset.card = card.id;
  input.setAttr("aria-label", t("ui.book_panel_more_label_0", card.title));
  input.setAttr("placeholder", t("ui.book_panel_more_placeholder"));
  input.value = state.drafts.get(card.id) ?? "";
  input.disabled = busy;
  input.addEventListener("input", () => state.drafts.set(card.id, input.value));
  const send = form.createEl("button", {
    cls: "vam-book-panel-replan",
    text: busy ? t("ui.book_panel_busy") : t("ui.book_panel_replan")
  });
  send.disabled = busy;
  const submit = (): void => {
    const instruction = (input.value ?? "").trim();
    if (!instruction || state.busy.has(card.id)) return;
    state.drafts.set(card.id, input.value);
    state.busy.add(card.id);
    state.notes.delete(card.id);
    actions.refresh();
    void actions.replan(card.id, instruction).then(
      result =>
        finish(
          card.id,
          state,
          actions,
          result.plan
            ? { text: t("ui.book_panel_replanned"), error: false }
            : { text: t("ui.book_panel_replan_failed_0", reasonText(result.reason ?? "cancelled")), error: true },
          !!result.plan
        ),
      error => finish(card.id, state, actions, { text: bookRefusalText(error), error: true })
    );
  };
  send.addEventListener("click", event => {
    event.stopPropagation();
    submit();
  });
  input.addEventListener("keydown", event => {
    if (event.key !== "Enter" || event.isComposing) return;
    event.preventDefault();
    submit();
  });
  const note = state.notes.get(card.id);
  const line = item.createDiv({
    cls: "vam-book-panel-card-status",
    text: busy ? t("ui.book_panel_busy") : (note?.text ?? "")
  });
  line.setAttr("role", note?.error ? "alert" : "status");
  if (note?.error) line.addClass("is-error");
}

function finish(
  id: string,
  state: GatePanelState,
  actions: GatePanelActions,
  note: { text: string; error: boolean } | undefined,
  clearDraft = false
): void {
  state.busy.delete(id);
  if (note) state.notes.set(id, note);
  if (clearDraft) state.drafts.delete(id);
  actions.refresh();
}
