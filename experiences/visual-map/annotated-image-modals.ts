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
