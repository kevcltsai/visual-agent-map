import { App, Modal } from "obsidian";
import { t } from "../../i18n";
import { titleProblemText } from "./title-check";
import { actionStatus, modalActions } from "./action-bar";

export class NameModal extends Modal {
  constructor(
    app: App,
    private titleText: string,
    private value: string,
    private submit: (value: string) => void
  ) {
    super(app);
  }
  onOpen(): void {
    this.titleEl.setText(this.titleText);
    const input = this.contentEl.createEl("input", { type: "text", value: this.value, cls: "vam-name-input" });
    input.setAttr("aria-label", this.titleText);
    const actions = modalActions(this);
    const status = actionStatus(actions);
    actions.createEl("button", { text: t("ui.cancel") }).addEventListener("click", () => this.close());
    const saveButton = actions.createEl("button", { text: t("ui.save"), cls: "mod-cta" });
    const save = (): void => {
      const value = input.value.trim();
      if (!value || titleProblemText(value)) return;
      this.close();
      this.submit(value);
    };
    // An empty name cannot be saved; say so instead of ignoring the press.
    const check = (): void => {
      const empty = !input.value.trim();
      const problem = empty ? "" : titleProblemText(input.value);
      saveButton.disabled = empty || !!problem;
      status.setText(empty ? t("ui.name_required") : problem);
    };
    input.addEventListener("input", check);
    input.addEventListener("keydown", event => {
      // Enter while an input method is composing (e.g. picking Chinese characters) only confirms the characters.
      if (event.key === "Enter" && !event.isComposing) {
        // Without this the Enter that confirmed the name goes on to click the button that opened the dialog.
        event.preventDefault();
        event.stopPropagation();
        save();
      }
    });
    saveButton.addEventListener("click", save);
    check();
    input.focus();
    input.select();
  }
}
