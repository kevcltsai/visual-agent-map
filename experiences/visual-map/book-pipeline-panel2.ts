import { t } from "../../i18n";
import type { PipelineStage } from "../../core/book-pipeline/model";
import { describeSlots, latestSlotsRecord } from "../../core/book-pipeline/image-slots";
import { chapterBody, latestStoredProof, type StoredProofView } from "../../core/book-pipeline/note-sections";
import { parseImageSlots } from "../../core/book-pipeline/plan-text";
import { unescapeMarkdownText } from "../../core/book-pipeline/text";
import { bookCardView, bookIssueText, bookRefusalText } from "./book-pipeline-ui";
import { bodyImageUrls } from "./book-pipeline-run";
import {
  renderPanelTabs,
  runTrackedRerun,
  type GateCardInput,
  type GatePanelActions,
  type GatePanelState
} from "./book-pipeline-panel";

/**
 * Gate 2 side panel: two states. Nothing needs a person: "N chapters are done" and one finish button. Otherwise the same sentence
 * with the count of chapters that still need attention, only those cards (name, one plain reason, "rerun this card" / "edit myself"),
 * and the finish button, which asks once. Every string from a note or the model goes on screen with textContent only, and the panel
 * is drawn only for a map that has a usable `bookPipeline`.
 */

export interface Gate2Card {
  id: string;
  index: number;
  title: string;
  stage: PipelineStage | "pending";
  role?: string;
  /** The plain sentence of a needs-review card (never a code). */
  failureText?: string;
  /** Checked cards: structure items the proofreader found unmet (picture tokens are not counted). */
  structureUnmet: number;
  /** Checked cards: fact items that were not confirmed against a source. */
  factsOpen: number;
  /** A gallery chapter whose every picture slot ended without a picture: its content is missing. */
  galleryBare: boolean;
  /** A neighbouring card changed and the owner has not confirmed the join. */
  seam: boolean;
}
export interface Gate2Data {
  total: number;
  /** Cards for which `attentionReasons` is not empty. */
  attention: number;
  /** Minutes from the start of the run to the end of writing; absent when the saved times cannot be read. */
  elapsedMinutes?: number;
  cards: Gate2Card[];
}

/**
 * The one place that decides whether a chapter is "fine": every reason below keeps the card in the attention list and keeps the
 * panel from saying "all done". A needs-review or unfinished card, unmet structure items, facts not confirmed, a gallery chapter
 * with no picture at all, and a join not yet confirmed all count. A slot that found no picture in an ordinary chapter does not: the
 * chapter simply has fewer pictures (its text still stands).
 */
export function attentionReasons(card: Gate2Card): string[] {
  const out: string[] = [];
  if (card.stage === "needs-review") out.push(card.failureText || t("ui.book_issue_unknown"));
  else if (card.stage !== "checked") out.push(t("ui.book_panel_g2_reason_unfinished"));
  if (card.structureUnmet > 0) out.push(t("ui.book_panel_g2_reason_structure_0", card.structureUnmet));
  if (card.factsOpen > 0) out.push(t("ui.book_panel_g2_reason_facts_0", card.factsOpen));
  if (card.galleryBare) out.push(t("ui.book_panel_g2_reason_images"));
  if (card.seam) out.push(t("ui.book_panel_g2_reason_seam"));
  return out;
}
export const needsAttention = (card: Gate2Card): boolean => attentionReasons(card).length > 0;

/** Codes the proofreader may have copied into its notes (C1, N2) are not for the reader. */
const plainNote = (text: string): string =>
  text
    .replace(/\b[CN]\d+\b\s*[:：]?/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** The reason of a needs-review card in words: the proof's own notes of the items not met, else the count, else a plain sentence; never a code. */
function reasonOf(issue: string, proof: StoredProofView | undefined): string {
  if (!/^proof unmet/.test(issue.trim())) return bookIssueText(issue);
  if (/facts_unverified/.test(issue)) return t("ui.book_reason_all_facts_unverified");
  const open = (proof?.items ?? []).filter(item => item.status !== "met");
  const notes = [...new Set(open.map(item => plainNote(unescapeMarkdownText(item.note))).filter(Boolean))].slice(0, 3);
  if (notes.length) return notes.join(t("ui.book_panel_lead_sep"));
  return open.length ? t("ui.book_panel_reason_unchecked_0", open.length) : t("ui.book_panel_reason_unmet_plain");
}

/** Whether the chapter's pictures are a hole in a gallery chapter (uses the stored slot record and the picture addresses now in the text). */
function galleryBare(
  role: string | undefined,
  note: (GateCardInput & { pipelineSeam?: unknown }) | undefined
): boolean {
  if (role !== "gallery") return false;
  const slots = parseImageSlots(note?.prompt ?? "") ?? [];
  if (!slots.length) return false;
  const detail = note?.detail ?? "";
  const states = describeSlots(slots, latestSlotsRecord(detail), bodyImageUrls(chapterBody(detail)));
  return (
    states.some(slot => slot.state === "missing") &&
    !states.some(slot => slot.state === "placed" || slot.state === "edited")
  );
}

export function buildGate2Panel(input: {
  order: readonly string[];
  titleOf: (id: string) => string;
  noteOf: (id: string) => (GateCardInput & { pipelineSeam?: unknown; bookRole?: unknown }) | undefined;
  startedAt?: string;
  writingEndedAt?: string;
}): Gate2Data {
  const cards = input.order.map((id, at): Gate2Card => {
    const note = input.noteOf(id);
    const view = bookCardView(note ?? {});
    const issue = typeof note?.pipelineIssue === "string" ? note.pipelineIssue : "";
    const checked = view.stage === "checked";
    const proof = checked || view.stage === "needs-review" ? latestStoredProof(note?.detail ?? "") : undefined;
    const structure = /^structure unmet: (\S+(?: \S+)*)$/.exec(issue.trim());
    const role = typeof note?.bookRole === "string" ? note.bookRole : undefined;
    return {
      id,
      index: at + 1,
      title: input.titleOf(id),
      stage: view.stage,
      ...(role ? { role } : {}),
      ...(view.stage === "needs-review" && issue ? { failureText: reasonOf(issue, proof) } : {}),
      structureUnmet:
        checked && structure ? structure[1].split(" ").filter(token => !token.startsWith("image_")).length : 0,
      factsOpen: checked
        ? (proof?.items ?? []).filter(item => item.type === "fact" && item.status !== "met").length
        : 0,
      galleryBare: checked && galleryBare(role, note),
      seam: view.seam
    };
  });
  const from = Date.parse(input.startedAt ?? "");
  const to = Date.parse(input.writingEndedAt ?? "");
  return {
    total: cards.length,
    attention: cards.filter(needsAttention).length,
    ...(Number.isFinite(from) && Number.isFinite(to) && to >= from
      ? { elapsedMinutes: Math.round((to - from) / 60000) }
      : {}),
    cards
  };
}

export interface Gate2Actions extends Pick<GatePanelActions, "showChat" | "close" | "refresh"> {
  /** Opens the card's note in a tab ("edit myself"). */
  open: (nodeId: string) => void;
  /** The answer says whether the rerun left the same result that still needs a person. */
  rerun: (nodeId: string) => Promise<{ unchanged: boolean } | void>;
  confirmSeam: (nodeId: string) => Promise<void>;
  finish: () => Promise<void>;
  /** The one question before finishing with chapters left over; true = finish anyway. */
  confirmFinish: (info: { count: number; titles: string[] }) => Promise<boolean>;
}

/** Draws the gate 2 panel into `parent`. `done` is true once the owner finished the review (the finish button goes). */
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
  const summary = panel.createEl("p", {
    cls: "vam-book-panel-summary vam-book-panel-g2-line",
    text: !data.total
      ? t("ui.book_panel_gate2_nothing")
      : data.attention
        ? t("ui.book_panel_g2_some_0_1", data.total, data.attention)
        : t("ui.book_panel_g2_all_done_0", data.total)
  });
  summary.dataset.state = data.attention ? "attention" : "clear";

  const anyBusy =
    externalBusy.size > 0 ||
    state.busy.size > 0 ||
    state.seaming.size > 0 ||
    state.finishing ||
    state.finishAsking ||
    driveActive;
  const busyNow = (id: string): boolean => externalBusy.has(id) || state.busy.has(id);
  const attention = data.cards.filter(needsAttention);
  if (attention.length) {
    const list = panel.createEl("ul", { cls: "vam-book-panel-cards vam-book-panel-gate2-list" });
    list.setAttr("aria-label", t("ui.book_panel_gate2_list_label"));
    for (const card of attention) renderAttention(list, card, state, actions, busyNow(card.id), anyBusy, rerun);
  }

  const foot = panel.createDiv("vam-book-panel-foot");
  if (attention.length && !done) foot.createSpan({ cls: "vam-book-panel-muted", text: t("ui.book_panel_gate2_hint") });
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
      // A card still working comes first: wait for it, then ask about what is left over.
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
      if (!attention.length) return go();
      state.finishAsking = true;
      actions.refresh();
      const info = { count: attention.length, titles: attention.map(card => `${card.index} ${card.title}`) };
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

/** One chapter that needs a person: its name, one plain sentence, and the ways forward. */
function renderAttention(
  list: HTMLElement,
  card: Gate2Card,
  state: GatePanelState,
  actions: Gate2Actions,
  busy: boolean,
  anyBusy: boolean,
  rerun: { nodeId: string; startedAt: number } | undefined
): void {
  const item = list.createEl("li", { cls: "vam-book-panel-card vam-book-panel-row" });
  item.dataset.kind = "attention";
  item.dataset.row = card.id;
  item.setAttr("tabindex", "-1");
  if (busy) item.setAttr("aria-busy", "true");
  const head = item.createDiv("vam-book-panel-card-head");
  if (rerun?.nodeId === card.id)
    head.createSpan({ cls: "vam-book-panel-state vam-book-state is-rerun", text: t("ui.book_rerun_tag") });
  else
    head.createSpan({
      cls: "vam-book-panel-state vam-book-state is-needs-review",
      text: state.unchanged.has(card.id) && !busy ? t("ui.book_panel_still_review") : t("ui.book_panel_g2_look")
    });
  head.createEl("b", { cls: "vam-book-panel-card-title", text: `${card.index} ${card.title}` });
  item.createDiv({ cls: "vam-book-panel-field", text: attentionReasons(card).join(t("ui.book_panel_lead_sep")) });
  const row = item.createDiv("vam-book-panel-actions");
  button(
    row,
    "vam-book-panel-rerun-card",
    busy ? t("ui.book_panel_busy") : t("ui.book_panel_rerun_card"),
    t("ui.book_panel_rerun_card_0", card.title),
    card,
    "rerun",
    anyBusy,
    () =>
      run(card.id, card.id, state, state.busy, actions, async () => {
        await runTrackedRerun(state, card.id, () => actions.rerun(card.id));
      })
  );
  button(
    row,
    "vam-book-panel-open",
    t("ui.book_panel_g2_edit_myself"),
    t("ui.book_panel_open_0", card.title),
    card,
    "open",
    false,
    () => actions.open(card.id)
  );
  if (card.seam) {
    const key = `seam:${card.id}`;
    button(
      row,
      "vam-book-panel-confirm-seam",
      t("ui.book_panel_g2_confirm_seam"),
      t("ui.book_panel_confirm_seam_0", card.title),
      card,
      "seam",
      anyBusy,
      () => run(key, card.id, state, state.seaming, actions, () => actions.confirmSeam(card.id))
    );
  }
  const note = state.notes.get(card.id) ?? state.notes.get(`seam:${card.id}`);
  const line = item.createDiv({
    cls: "vam-book-panel-card-status",
    text: busy ? t("ui.book_panel_busy") : (note?.text ?? "")
  });
  line.setAttr("role", note?.error ? "alert" : "status");
  if (note?.error) line.addClass("is-error");
}
