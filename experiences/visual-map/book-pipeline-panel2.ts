import { t, type TranslationKey } from "../../i18n";
import type { PipelineStage } from "../../core/book-pipeline/model";
import { describeSlots, latestSlotsRecord } from "../../core/book-pipeline/image-slots";
import { chapterBody, latestStoredProof, type StoredProofView } from "../../core/book-pipeline/note-sections";
import { parseImageSlots } from "../../core/book-pipeline/plan-text";
import { unescapeMarkdownText } from "../../core/book-pipeline/text";
import { bookCardView, bookIssueText, bookRefusalText } from "./book-pipeline-ui";
import { bodyImageUrls } from "./book-pipeline-run";
import { unverifiedSourceUrls } from "./book-pipeline-rerun";
import {
  renderPanelTabs,
  runTrackedRerun,
  type GateCardInput,
  type GatePanelActions,
  type GatePanelState
} from "./book-pipeline-panel";

/**
 * Gate 2 side panel (04c): what needs a person (cards marked needs-review, seams to check), the proof record of every proofread
 * card, and the "review finished" button. Same rules as gate 1: every string from a note or the model goes on screen with
 * textContent only, and the panel is drawn only for a map that has a usable `bookPipeline`.
 */

export interface Gate2Card {
  id: string;
  index: number;
  title: string;
  stage: PipelineStage | "pending";
  /** The reason of a needs-review card, in words. */
  reasonText?: string;
  /** A checked card's small note ("n structure items not met"). */
  noteText?: string;
  seam: boolean;
  /** "A ↔ B" when the seam's other card is known, else the card's own title. */
  seamTitle: string;
  proof?: StoredProofView;
  /** Picture state of a written chapter (absent before it is written). */
  images?: Gate2Images;
  /** Unverified source addresses of the proof (for "use other sources"); at most five https addresses. */
  avoidSources: string[];
}
/** What the Prompt's image plan, the stored record and the text now say about one chapter's pictures. */
export interface Gate2Images {
  planned: number;
  placed: number;
  edited: number;
  unrecorded: number;
  missing: { index: number; code: string }[];
}
export interface Gate2Data {
  total: number;
  checked: number;
  needsReview: number;
  seams: number;
  /** Slots that ended without a picture, over all chapters. */
  imageGaps: number;
  /** Minutes from the start of the run to the end of writing; absent when the saved times cannot be read. */
  elapsedMinutes?: number;
  cards: Gate2Card[];
}

/** The index of the card that changed, read from the seam text the runner wrote ("… (card 5, revision 2)" / "（第 5 張，版本 2）"). */
function changedIndex(seam: string): number | undefined {
  const found = /第 (\d+) 張|card (\d+)/.exec(seam);
  const n = found ? Number(found[1] ?? found[2]) : NaN;
  return Number.isInteger(n) && n >= 1 ? n : undefined;
}

/** The reason of a needs-review card in words: the proof's own notes of the items not met, else the count, else the issue code's text. */
function reasonOf(issue: string, proof: StoredProofView | undefined): string {
  if (!/^proof unmet/.test(issue.trim()) || !proof) return bookIssueText(issue);
  const open = proof.items.filter(item => item.status !== "met");
  const notes = [...new Set(open.map(item => unescapeMarkdownText(item.note).trim()).filter(Boolean))].slice(0, 3);
  if (notes.length) return notes.join(t("ui.book_panel_lead_sep"));
  return open.length ? t("ui.book_panel_reason_unchecked_0", open.length) : bookIssueText(issue);
}

function imagesOf(note: (GateCardInput & { pipelineSeam?: unknown }) | undefined): Gate2Images | undefined {
  // An older card has no image plan: it reads as "no pictures planned" and nothing breaks.
  const slots = parseImageSlots(note?.prompt ?? "") ?? [];
  const detail = note?.detail ?? "";
  const states = describeSlots(slots, latestSlotsRecord(detail), bodyImageUrls(chapterBody(detail)));
  return {
    planned: slots.length,
    placed: states.filter(slot => slot.state === "placed").length,
    edited: states.filter(slot => slot.state === "edited").length,
    unrecorded: states.filter(slot => slot.state === "unrecorded").length,
    missing: states
      .filter(slot => slot.state === "missing")
      .map(slot => ({ index: slot.index, code: slot.reasonCode ?? "not_found" }))
  };
}

export function buildGate2Panel(input: {
  order: readonly string[];
  titleOf: (id: string) => string;
  noteOf: (id: string) => (GateCardInput & { pipelineSeam?: unknown }) | undefined;
  startedAt?: string;
  writingEndedAt?: string;
}): Gate2Data {
  const cards = input.order.map((id, at): Gate2Card => {
    const note = input.noteOf(id);
    const view = bookCardView(note ?? {});
    const title = input.titleOf(id);
    const seamText = typeof note?.pipelineSeam === "string" ? note.pipelineSeam : "";
    const other = changedIndex(seamText);
    const partner = other !== undefined && Math.abs(other - 1 - at) === 1 ? input.order[other - 1] : undefined;
    const issue = typeof note?.pipelineIssue === "string" ? note.pipelineIssue : "";
    const proof =
      view.stage === "checked" || view.stage === "needs-review" ? latestStoredProof(note?.detail ?? "") : undefined;
    const images = view.stage === "pending" || view.stage === "planned" ? undefined : imagesOf(note);
    return {
      id,
      index: at + 1,
      title,
      stage: view.stage,
      ...(view.stage === "needs-review" && issue ? { reasonText: reasonOf(issue, proof) } : {}),
      ...(view.stage === "checked" && view.issueText ? { noteText: view.issueText } : {}),
      seam: view.seam,
      seamTitle: partner
        ? other! - 1 > at
          ? `${title} ↔ ${input.titleOf(partner)}`
          : `${input.titleOf(partner)} ↔ ${title}`
        : title,
      ...(proof ? { proof } : {}),
      ...(images ? { images } : {}),
      avoidSources: unverifiedSourceUrls(proof)
    };
  });
  const from = Date.parse(input.startedAt ?? "");
  const to = Date.parse(input.writingEndedAt ?? "");
  return {
    total: cards.length,
    checked: cards.filter(card => card.stage === "checked").length,
    needsReview: cards.filter(card => card.stage === "needs-review").length,
    seams: cards.filter(card => card.seam).length,
    imageGaps: cards.reduce((sum, card) => sum + (card.images?.missing.length ?? 0), 0),
    ...(Number.isFinite(from) && Number.isFinite(to) && to >= from
      ? { elapsedMinutes: Math.round((to - from) / 60000) }
      : {}),
    cards
  };
}

export interface Gate2Actions extends Pick<GatePanelActions, "showChat" | "close" | "refresh"> {
  /** Opens the card's note in a tab. */
  open: (nodeId: string) => void;
  /** `avoidSources` = "use other sources"; the answer says whether the rerun left the same result that still needs a person. */
  rerun: (nodeId: string, options?: { avoidSources?: string[] }) => Promise<{ unchanged: boolean } | void>;
  confirmSeam: (nodeId: string) => Promise<void>;
  finish: () => Promise<void>;
  /** The one question before finishing with things left over; true = finish anyway. */
  confirmFinish: (info: { review: number; reviewTitles: string[]; seams: number }) => Promise<boolean>;
  /** Keeps a "Rerunning m:ss" clock ticking in `el` (the view owns the timer). */
  track?: (el: HTMLElement, startedAt: number) => void;
}

/** Draws the gate 2 panel into `parent`. `done` is true once the owner finished the review (the rows stay; the finish button goes). */
export function renderGate2Panel(
  parent: HTMLElement,
  data: Gate2Data,
  done: boolean,
  state: GatePanelState,
  actions: Gate2Actions,
  /** Cards the runner is working on right now (from its progress). */
  externalBusy: ReadonlySet<string> = new Set(),
  /** The runner still has a drive on this map (a rerun winding down): finish would be refused as busy, so the button waits. */
  driveActive = false,
  /** The card being rerun right now (memory only). */
  rerun?: { nodeId: string; startedAt: number }
): HTMLElement {
  const panel = parent.createDiv("vam-book-panel vam-book-panel-gate2");
  panel.setAttr("role", "region");
  panel.setAttr("aria-label", t("ui.book_panel_label"));
  renderPanelTabs(panel, actions);
  const head = panel.createDiv("vam-book-panel-head");
  const title = head.createEl("h3", { cls: "vam-book-panel-title", text: t("ui.book_panel_gate2_title") });
  title.setAttr("tabindex", "-1");
  if (done) head.createSpan({ cls: "vam-book-panel-tag", text: t("ui.book_panel_gate2_done_tag") });
  else if (data.elapsedMinutes !== undefined) {
    const took = head.createSpan({
      cls: "vam-book-panel-tag",
      text:
        data.elapsedMinutes < 1
          ? t("ui.book_panel_elapsed_under_minute")
          : t("ui.book_panel_elapsed_0", data.elapsedMinutes)
    });
    took.setAttr("title", t("ui.book_panel_elapsed_hint"));
  }
  const lead = [
    data.checked ? t("ui.book_panel_lead_passed_0", data.checked) : "",
    data.needsReview ? t("ui.book_panel_lead_review_0", data.needsReview) : "",
    data.seams ? t("ui.book_panel_lead_seams_0", data.seams) : "",
    data.imageGaps ? t("ui.book_panel_lead_images_0", data.imageGaps) : ""
  ].filter(Boolean);
  if (lead.length) panel.createEl("p", { cls: "vam-book-panel-summary", text: lead.join(t("ui.book_panel_lead_sep")) });

  const anyBusy =
    externalBusy.size > 0 ||
    state.busy.size > 0 ||
    state.seaming.size > 0 ||
    state.finishing ||
    state.finishAsking ||
    driveActive;
  const busyNow = (id: string): boolean => externalBusy.has(id) || state.busy.has(id);
  const attention = data.cards.filter(
    card => card.stage === "needs-review" || (busyNow(card.id) && card.stage !== "checked")
  );
  const seams = data.cards.filter(card => card.seam);
  const checked = data.cards.filter(card => card.stage === "checked");

  const list = panel.createEl("ul", { cls: "vam-book-panel-cards vam-book-panel-gate2-list" });
  list.setAttr("aria-label", t("ui.book_panel_gate2_list_label"));
  if (!attention.length && !seams.length && !checked.length)
    list.createEl("li", { cls: "vam-book-panel-muted", text: t("ui.book_panel_gate2_nothing") });
  for (const card of attention) renderAttention(list, card, state, actions, busyNow(card.id), anyBusy, rerun);
  for (const card of seams) renderSeam(list, card, state, actions, anyBusy);
  for (const card of checked) renderChecked(list, card, state, actions, busyNow(card.id), anyBusy, rerun);
  renderImages(panel, data, actions);

  const foot = panel.createDiv("vam-book-panel-foot");
  foot.createSpan({ cls: "vam-book-panel-muted", text: t("ui.book_panel_gate2_hint") });
  if (!done) {
    const finish = foot.createEl("button", {
      cls: "mod-cta vam-book-panel-finish",
      text: state.finishing ? t("ui.book_panel_finishing") : t("ui.book_panel_finish")
    });
    finish.dataset.act = "finish";
    finish.disabled = anyBusy;
    if (state.finishing) finish.setAttr("aria-busy", "true");
    finish.addEventListener("click", event => {
      event.stopPropagation();
      // A card still working comes first: wait for it (1ea4cfa3), then ask about what is left over.
      if (anyBusy) return;
      const go = (): void => {
        state.finishing = true;
        state.finishError = "";
        actions.refresh();
        void actions.finish().then(
          () => {
            state.finishing = false;
            actions.refresh();
          },
          error => {
            state.finishing = false;
            state.finishError = bookRefusalText(error);
            actions.refresh();
          }
        );
      };
      if (data.needsReview + data.seams === 0) return go();
      state.finishAsking = true;
      actions.refresh();
      const info = {
        review: data.needsReview,
        reviewTitles: data.cards
          .filter(card => card.stage === "needs-review")
          .map(card => `${card.index} ${card.title}`),
        seams: data.seams
      };
      void actions.confirmFinish(info).then(
        ok => {
          state.finishAsking = false;
          if (ok) go();
          else actions.refresh();
        },
        () => {
          state.finishAsking = false;
          actions.refresh();
        }
      );
    });
  }
  // A disabled finish button always says why (a silent disable looked like a dead button); a refusal stays here too.
  const waiting = !done && !state.finishing && !state.finishAsking && anyBusy ? t("ui.book_panel_finish_waiting") : "";
  const status = panel.createDiv({ cls: "vam-book-panel-status", text: state.finishError || waiting });
  status.setAttr("role", "status");
  status.setAttr("aria-live", "polite");
  return panel;
}

function row(list: HTMLElement, kind: string, card: Gate2Card, busy: boolean): HTMLElement {
  const item = list.createEl("li", { cls: "vam-book-panel-card vam-book-panel-row" });
  item.dataset.kind = kind;
  item.dataset.stage = card.stage;
  item.dataset.row = card.id;
  item.setAttr("tabindex", "-1");
  if (busy) item.setAttr("aria-busy", "true");
  return item;
}

function button(
  parent: HTMLElement,
  cls: string,
  text: string,
  label: string,
  card: Gate2Card,
  act: string,
  disabled: boolean,
  onClick: () => void
): HTMLButtonElement {
  const el = parent.createEl("button", { cls, text });
  el.setAttr("aria-label", label);
  el.dataset.card = card.id;
  el.dataset.act = act;
  el.disabled = disabled;
  el.addEventListener("click", event => {
    event.stopPropagation();
    if (!el.disabled) onClick();
  });
  return el;
}

function stateTag(head: HTMLElement, stage: string, text: string): void {
  head.createSpan({ cls: `vam-book-panel-state vam-book-state is-${stage}`, text });
}

function noteLine(item: HTMLElement, state: GatePanelState, key: string, busy: boolean): void {
  const note = state.notes.get(key);
  const line = item.createDiv({
    cls: "vam-book-panel-card-status",
    text: busy ? t("ui.book_panel_busy") : (note?.text ?? "")
  });
  line.setAttr("role", note?.error ? "alert" : "status");
  if (note?.error) line.addClass("is-error");
}

/** Starts one row's action: its card is marked busy in `set` until the call ends; a refusal is kept as that row's error line. */
function run(
  noteKey: string,
  id: string,
  state: GatePanelState,
  set: Set<string>,
  actions: Gate2Actions,
  work: () => Promise<void>
): void {
  if (set.has(id)) return;
  set.add(id);
  state.notes.delete(noteKey);
  actions.refresh();
  void work().then(
    () => {
      set.delete(id);
      actions.refresh();
    },
    error => {
      set.delete(id);
      state.notes.set(noteKey, { text: bookRefusalText(error), error: true });
      actions.refresh();
    }
  );
}

type RerunNow = { nodeId: string; startedAt: number } | undefined;

/** Starts the card's rerun; a result the same as before that still needs a person is remembered (memory only) to say so. */
function startRerun(card: Gate2Card, state: GatePanelState, actions: Gate2Actions, avoidSources?: string[]): void {
  run(card.id, card.id, state, state.busy, actions, async () => {
    await runTrackedRerun(state, card.id, () => actions.rerun(card.id, avoidSources ? { avoidSources } : undefined));
  });
}

/** "Rerunning m:ss" while this card is the one being rerun; the clock is the view's. */
function rerunTag(head: HTMLElement, card: Gate2Card, rerun: RerunNow, actions: Gate2Actions): boolean {
  if (!rerun || rerun.nodeId !== card.id) return false;
  const tag = head.createSpan({
    cls: "vam-book-panel-state vam-book-state is-rerun",
    text: t("ui.book_rerun_elapsed_0", "0:00")
  });
  actions.track?.(tag, rerun.startedAt);
  return true;
}

function renderAttention(
  list: HTMLElement,
  card: Gate2Card,
  state: GatePanelState,
  actions: Gate2Actions,
  busy: boolean,
  anyBusy: boolean,
  rerun: RerunNow
): void {
  const item = row(list, "attention", card, busy);
  const head = item.createDiv("vam-book-panel-card-head");
  const rerunning = rerunTag(head, card, rerun, actions);
  const unchanged = !busy && state.unchanged.has(card.id);
  if (!rerunning)
    stateTag(head, "needs-review", unchanged ? t("ui.book_panel_still_review") : t("ui.book_stage_needs_review"));
  head.createEl("b", { cls: "vam-book-panel-card-title", text: `${card.index} ${card.title}` });
  button(
    head,
    "vam-book-panel-open",
    t("ui.book_panel_open_card"),
    t("ui.book_panel_open_0", card.title),
    card,
    "open",
    false,
    () => actions.open(card.id)
  );
  button(
    head,
    "vam-book-panel-rerun-card",
    busy ? t("ui.book_panel_busy") : t("ui.book_panel_rerun_card"),
    t("ui.book_panel_rerun_card_0", card.title),
    card,
    "rerun",
    anyBusy,
    () => startRerun(card, state, actions)
  );
  if (unchanged) {
    const block = item.createDiv({ cls: "vam-book-panel-unchanged", text: t("ui.book_panel_unchanged") });
    block.setAttr("role", "status");
    block.dataset.kind = "unchanged";
  }
  if (card.reasonText)
    item.createDiv({ cls: "vam-book-panel-field", text: t("ui.book_panel_reason_0", card.reasonText) });
  if (unchanged) {
    const actionsRow = item.createDiv("vam-book-panel-unchanged-actions");
    if (card.avoidSources.length)
      button(
        actionsRow,
        "vam-book-panel-swap-source",
        t("ui.book_panel_swap_source"),
        t("ui.book_panel_swap_source_0", card.title),
        card,
        "swap-source",
        anyBusy,
        () => startRerun(card, state, actions, card.avoidSources)
      );
    button(
      actionsRow,
      "vam-book-panel-look-myself",
      t("ui.book_panel_look_myself"),
      t("ui.book_panel_open_0", card.title),
      card,
      "look-myself",
      false,
      () => actions.open(card.id)
    );
  }
  noteLine(item, state, card.id, false);
}

function renderSeam(
  list: HTMLElement,
  card: Gate2Card,
  state: GatePanelState,
  actions: Gate2Actions,
  anyBusy: boolean
): void {
  const key = `seam:${card.id}`;
  const busy = state.seaming.has(card.id);
  const item = row(list, "seam", card, busy);
  const head = item.createDiv("vam-book-panel-card-head");
  stateTag(head, "seam", t("ui.book_seam_label"));
  head.createEl("b", { cls: "vam-book-panel-card-title", text: card.seamTitle });
  button(
    head,
    "vam-book-panel-open",
    t("ui.book_panel_open_card"),
    t("ui.book_panel_open_0", card.title),
    card,
    "open-seam",
    false,
    () => actions.open(card.id)
  );
  item.createDiv({ cls: "vam-book-panel-field", text: t("ui.book_seam_reason") });
  button(
    item,
    "vam-book-panel-confirm-seam",
    t("ui.book_panel_confirm_seam"),
    t("ui.book_panel_confirm_seam_0", card.seamTitle),
    card,
    "seam",
    anyBusy,
    () => run(key, card.id, state, state.seaming, actions, () => actions.confirmSeam(card.id))
  );
  const note = state.notes.get(key);
  if (note) {
    const line = item.createDiv({ cls: "vam-book-panel-card-status is-error", text: note.text });
    line.setAttr("role", "alert");
  }
}

/** "Passed" or "Passed, n to note" (n = proof items that are not met), as the approved panel draws it; not the map chip's "checked". */
function checkedTagText(card: Gate2Card): string {
  const notes = (card.proof?.items ?? []).filter(item => item.status !== "met").length;
  return notes > 0 ? t("ui.book_panel_checked_tag_notes_0", String(notes)) : t("ui.book_panel_checked_tag");
}

function renderChecked(
  list: HTMLElement,
  card: Gate2Card,
  state: GatePanelState,
  actions: Gate2Actions,
  busy: boolean,
  anyBusy: boolean,
  rerun: RerunNow
): void {
  const item = row(list, "checked", card, busy);
  const head = item.createDiv("vam-book-panel-card-head");
  if (!rerunTag(head, card, rerun, actions)) stateTag(head, "checked", checkedTagText(card));
  head.createEl("b", { cls: "vam-book-panel-card-title", text: `${card.index} ${card.title}` });
  const open = state.proofOpen.has(card.id);
  const toggle = button(
    head,
    "vam-book-panel-proof-toggle",
    open ? t("ui.book_panel_proof_hide") : t("ui.book_panel_proof_show"),
    t("ui.book_panel_proof_0", card.title),
    card,
    "proof",
    false,
    () => undefined
  );
  toggle.setAttr("aria-expanded", String(open));
  button(
    head,
    "vam-book-panel-rerun-card",
    busy ? t("ui.book_panel_busy") : t("ui.book_panel_rerun_card"),
    t("ui.book_panel_rerun_card_0", card.title),
    card,
    "rerun",
    anyBusy,
    () => startRerun(card, state, actions)
  );
  const proof = card.proof;
  if (card.noteText) item.createDiv({ cls: "vam-book-panel-field", text: card.noteText });
  const body = item.createDiv("vam-book-panel-proof");
  body.hidden = !open;
  if (proof) body.createDiv({ cls: "vam-book-panel-field", text: proofSummary(proof) });
  renderProof(body, proof);
  toggle.addEventListener("click", () => {
    const now = !state.proofOpen.has(card.id);
    if (now) state.proofOpen.add(card.id);
    else state.proofOpen.delete(card.id);
    body.hidden = !now;
    toggle.setAttr("aria-expanded", String(now));
    toggle.setText(now ? t("ui.book_panel_proof_hide") : t("ui.book_panel_proof_show"));
  });
  noteLine(item, state, card.id, false);
}

function proofSummary(proof: StoredProofView): string {
  const met = proof.items.filter(item => item.status === "met").length;
  const unverified = proof.items.filter(item => item.status === "unverified").length;
  const unmet = proof.items.filter(item => item.status === "unmet").length;
  return t("ui.book_panel_proof_summary_0_1_2", met, unverified, unmet);
}

const STATUS_KEY = {
  met: "ui.book_proof_met",
  unmet: "ui.book_proof_unmet",
  unverified: "ui.book_proof_unverified"
} as const;

function renderProof(body: HTMLElement, proof: StoredProofView | undefined): void {
  if (!proof) {
    body.createDiv({ cls: "vam-book-panel-muted", text: t("ui.book_panel_proof_none") });
    return;
  }
  if (proof.failed) body.createDiv({ cls: "vam-book-panel-muted", text: t("ui.book_panel_proof_failed") });
  if (proof.factsUnverified)
    body.createDiv({ cls: "vam-book-panel-muted", text: t("ui.book_panel_proof_facts_unverified") });
  if (proof.counts)
    body.createDiv({
      cls: "vam-book-panel-field",
      text: t("ui.book_panel_proof_opened_0_1", proof.counts.openedPages, proof.counts.searches)
    });
  const structure = proof.items.filter(item => item.type === "structure" && item.status === "unmet");
  if (structure.length)
    body.createDiv({
      cls: "vam-book-panel-field",
      text: t("ui.book_panel_structure_unmet_0", structure.length)
    });
  const items = body.createEl("ul", { cls: "vam-book-panel-proof-items" });
  for (const item of proof.items) {
    const li = items.createEl("li", { cls: `vam-book-panel-proof-item is-${item.status}` });
    const kind = item.type === "structure" ? t("ui.book_proof_structure") : t("ui.book_proof_fact");
    li.createSpan({
      text: `${kind}・${t(STATUS_KEY[item.status])}${item.note ? `：${unescapeMarkdownText(item.note)}` : ""}`
    });
    if (item.sources.length)
      li.createDiv({ cls: "vam-book-panel-muted", text: t("ui.book_panel_proof_sources_0", item.sources.join("  ")) });
  }
}

const SLOT_REASON_KEY: Record<string, TranslationKey> = {
  author_omitted: "ui.book_slot_reason_author_omitted",
  bad_marker: "ui.book_slot_reason_bad_marker",
  not_found: "ui.book_slot_reason_not_found",
  load_failed: "ui.book_slot_reason_load_failed",
  unsafe_url: "ui.book_slot_reason_unsafe_url",
  probe_capped: "ui.book_slot_reason_probe_capped"
};

/** One line per written chapter: how many pictures, or why there is no fitting one (the reason words come from the stored codes). */
function renderImages(panel: HTMLElement, data: Gate2Data, actions: Gate2Actions): void {
  const cards = data.cards.filter(card => card.images);
  if (!cards.length) return;
  const box = panel.createDiv("vam-book-panel-images");
  box.createEl("h4", { cls: "vam-book-panel-images-title", text: t("ui.book_panel_images_title") });
  const list = box.createEl("ul", { cls: "vam-book-panel-images-list" });
  list.setAttr("aria-label", t("ui.book_panel_images_label"));
  for (const card of cards) {
    const images = card.images!;
    const gaps = images.missing.length;
    const shown = images.placed + images.edited;
    const allUnrecorded = images.planned > 0 && images.unrecorded === images.planned;
    const text = !images.planned
      ? t("ui.book_panel_g2_images_none")
      : allUnrecorded
        ? t("ui.book_panel_g2_images_unrecorded")
        : shown === 0 && gaps > 0
          ? t("ui.book_panel_g2_images_none_fit")
          : gaps > 0
            ? t("ui.book_panel_g2_images_n_gap_0_1", shown, gaps)
            : t("ui.book_panel_g2_images_n_0", shown);
    const li = list.createEl("li", { cls: "vam-book-panel-image-row" });
    li.dataset.row = card.id;
    li.dataset.kind = "images";
    const warn = gaps > 0;
    li.createSpan({ cls: `vam-book-panel-state vam-book-state ${warn ? "is-needs-review" : "is-checked"}`, text });
    li.createEl("b", { cls: "vam-book-panel-card-title", text: `${card.index} ${card.title}` });
    const why = images.missing
      .map(slot =>
        t("ui.book_panel_g2_slot_0_1", slot.index, t(SLOT_REASON_KEY[slot.code] ?? SLOT_REASON_KEY.not_found))
      )
      .concat(images.edited ? [t("ui.book_panel_g2_images_edited_0", images.edited)] : []);
    if (why.length) li.createSpan({ cls: "vam-book-panel-muted", text: why.join(t("ui.book_panel_lead_sep")) });
    if (warn)
      button(
        li,
        "vam-book-panel-add-images",
        t("ui.book_panel_add_images"),
        t("ui.book_panel_add_images_0", card.title),
        card,
        "add-images",
        false,
        () => actions.open(card.id)
      );
  }
}
