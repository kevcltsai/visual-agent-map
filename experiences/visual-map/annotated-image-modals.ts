// The one-line note dialog of an annotated image: "Convert to annotated image" and "Edit note" share it.
import { Modal, type App } from "obsidian";
import { t } from "../../i18n";
import { actionStatus, modalActions } from "../../ui/modals/action-bar";
import { NOTE_LIMIT } from "./canvas-items";

export class ImageNoteModal extends Modal {
  private done = false;
  constructor(
    app: App,
    private readonly mode: "convert" | "edit",
    private readonly value: string,
    /** Gets the raw text; the data layer cleans it (one line, 200 characters). */
    private readonly submit: (note: string) => void,
    private readonly cancelled: () => void = () => {}
  ) {
    super(app);
  }
  onOpen(): void {
    this.titleEl.setText(
      t(this.mode === "convert" ? "ui.annotated_image_convert_title" : "ui.annotated_image_edit_title")
    );
    const input = this.contentEl.createEl("input", {
      type: "text",
      value: this.value,
      cls: "vam-name-input vam-annotated-note-input"
    });
    input.setAttr("aria-label", t("ui.annotated_image_note_label"));
    input.setAttr("maxlength", String(NOTE_LIMIT));
    this.contentEl.createEl("p", { text: t("ui.annotated_image_note_hint"), cls: "vam-annotated-note-hint" });
    const actions = modalActions(this);
    actionStatus(actions);
    actions.createEl("button", { text: t("ui.cancel") }).addEventListener("click", () => this.close());
    const ok = actions.createEl("button", {
      text: t(this.mode === "convert" ? "ui.annotated_image_convert_button" : "ui.save"),
      cls: "mod-cta"
    });
    const send = (): void => {
      if (this.done) return;
      this.done = true;
      this.submit(input.value);
      this.close();
    };
    ok.addEventListener("click", send);
    input.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key !== "Enter" || event.isComposing) return;
      event.preventDefault();
      send();
    });
    input.focus();
  }
  onClose(): void {
    if (!this.done) {
      this.done = true;
      this.cancelled();
    }
    this.contentEl.empty();
  }
}

/** What a new anchor is linked to when the dialog closes with "Done". */
export type AnchorTarget = "new" | "pick" | "none";

/** The anchor dialog: "New anchor" (note + what to link) and "Edit anchor" (note only). */
export class AnchorModal extends Modal {
  private done = false;
  constructor(
    app: App,
    private readonly mode: "new" | "edit",
    private readonly value: string,
    /** Gets the raw note (the data layer cleans it) and, for a new anchor, what to link. */
    private readonly submit: (note: string, target: AnchorTarget) => void,
    private readonly cancelled: () => void = () => {}
  ) {
    super(app);
  }
  onOpen(): void {
    this.titleEl.setText(t(this.mode === "new" ? "ui.anchor_new_title" : "ui.anchor_edit_title"));
    const input = this.contentEl.createEl("input", {
      type: "text",
      value: this.value,
      cls: "vam-name-input vam-anchor-note-input"
    });
    input.setAttr("aria-label", t("ui.anchor_note_label"));
    input.setAttr("maxlength", String(NOTE_LIMIT));
    let target: AnchorTarget = "new";
    if (this.mode === "new") {
      const group = this.contentEl.createDiv("vam-anchor-choices");
      group.setAttr("role", "radiogroup");
      group.setAttr("aria-label", t("ui.anchor_target_label"));
      const choices: [AnchorTarget, string][] = [
        ["new", t("ui.anchor_target_new")],
        ["pick", t("ui.anchor_target_pick")],
        ["none", t("ui.anchor_target_none")]
      ];
      for (const [value, label] of choices) {
        const row = group.createEl("label", { cls: "vam-anchor-choice" });
        const radio = row.createEl("input", { type: "radio", attr: { name: "vam-anchor-target", value } });
        radio.checked = value === target;
        radio.addEventListener("change", () => {
          if (radio.checked) target = value;
        });
        row.createSpan({ text: label });
      }
    }
    const actions = modalActions(this);
    actionStatus(actions);
    actions.createEl("button", { text: t("ui.cancel") }).addEventListener("click", () => this.close());
    const ok = actions.createEl("button", {
      text: t(this.mode === "new" ? "ui.anchor_done" : "ui.save"),
      cls: "mod-cta"
    });
    const send = (): void => {
      if (this.done) return;
      this.done = true;
      this.submit(input.value, target);
      this.close();
    };
    ok.addEventListener("click", send);
    input.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key !== "Enter" || event.isComposing) return;
      event.preventDefault();
      send();
    });
    input.focus();
  }
  onClose(): void {
    if (!this.done) {
      this.done = true;
      this.cancelled();
    }
    this.contentEl.empty();
  }
}

/** One anchor the topic can be linked to: `label` is "<image note or file name> · <anchor note>" (text only). */
export interface AnchorPickEntry {
  imageId: string;
  anchorId: string;
  label: string;
  /** True when the anchor already has a relation with this topic (a pair holds one relation). */
  taken: boolean;
}

/**
 * "Point on an image…" from a topic: lists the existing anchors of every annotated image (a linked one is disabled with the
 * reason) and offers "Place a new point on an image", which the caller turns into the pick mode.
 */
export class AnchorPickModal extends Modal {
  constructor(
    app: App,
    private readonly entries: AnchorPickEntry[],
    private readonly canPlaceNew: boolean,
    private readonly choose: (entry: AnchorPickEntry) => void,
    private readonly placeNew: () => void
  ) {
    super(app);
  }
  onOpen(): void {
    this.titleEl.setText(t("ui.anchor_relation_pick_title"));
    const list = this.contentEl.createDiv("vam-anchor-pick-list");
    for (const entry of this.entries) {
      const row = list.createDiv("vam-anchor-pick-row");
      const button = row.createEl("button", { text: entry.label, attr: { type: "button" } });
      button.disabled = entry.taken;
      if (entry.taken) {
        button.setAttr("aria-disabled", "true");
        row.createSpan({ text: t("ui.anchor_relation_pick_taken"), cls: "vam-anchor-pick-taken" });
      }
      button.addEventListener("click", () => {
        if (entry.taken) return;
        this.close();
        this.choose(entry);
      });
    }
    if (!this.entries.length)
      this.contentEl.createEl("p", { text: t("ui.anchor_relation_pick_none"), cls: "vam-hint" });
    const actions = modalActions(this);
    actionStatus(actions);
    actions.createEl("button", { text: t("ui.cancel") }).addEventListener("click", () => this.close());
    const fresh = actions.createEl("button", { text: t("ui.anchor_relation_pick_new"), cls: "mod-cta" });
    fresh.disabled = !this.canPlaceNew;
    fresh.addEventListener("click", () => {
      if (!this.canPlaceNew) return;
      this.close();
      this.placeNew();
    });
  }
  onClose(): void {
    this.contentEl.empty();
  }
}
