import { App, Modal, setIcon } from "obsidian";
import { t } from "../../i18n";
import type { NoteRelevance, RelevanceTier } from "../../note-values";
import { actionStatus, modalActions } from "../../ui/modals/action-bar";
import { RELEVANCE_LABEL, renderRelevanceTag } from "./relevance-tag";

/** One card whose grade changed in a grading run, in map order. */
export interface RelevanceChangeRow {
  id: string;
  title: string;
  before: NoteRelevance | undefined;
  after: NoteRelevance;
  /** The pinned card this move follows from, when the AI named one; the row is listed under it. */
  anchor?: string;
}
export interface RelevanceSummaryPin {
  id: string;
  title: string;
  tier: RelevanceTier;
}
/** Two pinned cards the learner set against each other: the pinned card `descendant` ranks above its pinned ancestor. */
export interface RelevanceSummaryConflict {
  ancestor: string;
  ancestorTier: RelevanceTier;
  descendant: string;
  descendantTier: RelevanceTier;
}
export interface RelevanceSummaryHost {
  rows: RelevanceChangeRow[];
  /** The pinned cards the run was given; a row's `anchor` is one of their ids. */
  pins?: RelevanceSummaryPin[];
  conflicts?: RelevanceSummaryConflict[];
  /** Marks the changed cards on the map; an empty list clears the marks. */
  highlight: (ids: string[]) => void;
}

/**
 * Read-only list of what a grading run changed: one row per card with its old tag and its new tag. Moves
 * the AI tied to a pinned card are grouped under it ("Because you set X to ..."); the rest are "Other changes" (or the
 * plain list when nothing is grouped). Pins that disagree with each other are named once at the end. The changed cards
 * are marked on the map while the window is open.
 */
export class RelevanceSummaryModal extends Modal {
  constructor(
    app: App,
    private host: RelevanceSummaryHost
  ) {
    super(app);
  }

  private renderRows(label: string, rows: RelevanceChangeRow[]): void {
    const list = this.contentEl.createEl("ul", { cls: "vam-relevance-changes" });
    list.setAttr("aria-label", label);
    for (const row of rows) {
      const item = list.createEl("li", { cls: "vam-relevance-change" });
      item.createDiv({ cls: "vam-relevance-change-title", text: row.title });
      const tags = item.createDiv({ cls: "vam-relevance-change-tags" });
      if (row.before) renderRelevanceTag(tags, row.before.tier, t(RELEVANCE_LABEL[row.before.tier]));
      else tags.createSpan({ cls: "vam-relevance-ungraded", text: t("ui.relevance_ungraded") });
      const arrow = tags.createSpan({ cls: "vam-relevance-arrow" });
      arrow.setAttr("role", "img");
      arrow.setAttr("aria-label", t("ui.relevance_changed_to"));
      setIcon(arrow, "arrow-right");
      renderRelevanceTag(tags, row.after.tier, t(RELEVANCE_LABEL[row.after.tier]));
    }
  }

  onOpen(): void {
    this.modalEl.addClass("vam-relevance-summary-modal");
    this.titleEl.setText(t("ui.relevance_changes_title"));
    const conflicts = this.host.conflicts ?? [];
    const pinOf = new Map((this.host.pins ?? []).map(pin => [pin.id, pin]));
    // Groups in the order their pin first shows up in the (map-ordered) rows.
    const groups = new Map<string, RelevanceChangeRow[]>();
    const others: RelevanceChangeRow[] = [];
    for (const row of this.host.rows) {
      if (row.anchor && pinOf.has(row.anchor)) groups.set(row.anchor, [...(groups.get(row.anchor) ?? []), row]);
      else others.push(row);
    }
    if (!this.host.rows.length && !conflicts.length)
      this.contentEl.createEl("p", { cls: "vam-hint", text: t("ui.relevance_changes_none") });
    for (const [id, rows] of groups) {
      const pin = pinOf.get(id);
      if (!pin) continue;
      const title = t("ui.relevance_anchor_group_0_1", pin.title, t(RELEVANCE_LABEL[pin.tier]));
      this.contentEl.createEl("h4", { cls: "vam-relevance-anchor-title", text: title });
      this.renderRows(title, rows);
    }
    if (others.length) {
      if (groups.size)
        this.contentEl.createEl("h4", { cls: "vam-relevance-other-title", text: t("ui.relevance_other_changes") });
      this.renderRows(groups.size ? t("ui.relevance_other_changes") : t("ui.relevance_changes_title"), others);
    }
    if (conflicts.length) {
      this.contentEl.createEl("h4", { cls: "vam-relevance-conflicts-title", text: t("ui.relevance_conflicts_title") });
      const list = this.contentEl.createEl("ul", { cls: "vam-relevance-conflicts" });
      list.setAttr("aria-label", t("ui.relevance_conflicts_title"));
      for (const conflict of conflicts)
        list.createEl("li", {
          cls: "vam-relevance-conflict",
          text: t(
            "ui.relevance_conflict_0_1_2_3",
            conflict.ancestor,
            t(RELEVANCE_LABEL[conflict.ancestorTier]),
            conflict.descendant,
            t(RELEVANCE_LABEL[conflict.descendantTier])
          )
        });
    }
    const footer = modalActions(this);
    actionStatus(footer);
    const close = footer.createEl("button", { text: t("ui.close") });
    close.addEventListener("click", () => this.close());
    this.host.highlight(this.host.rows.map(row => row.id));
    close.focus();
  }

  onClose(): void {
    this.host.highlight([]);
  }
}
