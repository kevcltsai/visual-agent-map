import { App, Modal, Notice } from "obsidian";
import { t } from "../../i18n";

/** The draft of an AI merge whose content check failed: read only and copyable; nothing is applied from here. */
export class MergeDraftModal extends Modal {
  constructor(
    app: App,
    private readonly draft: { title: string; findings: string; text: string },
    private readonly returnFocus: () => void
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(t("ui.merge_draft_title_0", this.draft.title));
    this.contentEl.createEl("p", { cls: "vam-modal-intro", text: this.draft.findings });
    const area = this.contentEl.createEl("textarea", {
      cls: "vam-merge-draft-text",
      attr: { readonly: "", rows: "14", "aria-label": t("ui.merge_view_draft") }
    });
    area.value = this.draft.text;
    const buttons = this.contentEl.createDiv("modal-button-container");
    buttons.createEl("button", { text: t("ui.merge_draft_copy"), cls: "mod-cta" }).addEventListener("click", () => {
      // Only on the user's press does the draft go to the system clipboard.
      navigator.clipboard.writeText(this.draft.text).then(
        () => new Notice(t("ui.merge_draft_copied")),
        () => new Notice(t("ui.merge_draft_copy_failed"))
      );
    });
    buttons.createEl("button", { text: t("ui.close") }).addEventListener("click", () => this.close());
  }

  onClose(): void {
    this.contentEl.empty();
    this.returnFocus();
  }
}
