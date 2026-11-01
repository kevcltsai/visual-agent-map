import { App, Modal, Setting } from "obsidian";
import { t } from "../../i18n";
import { modalActions } from "./action-bar";

export interface Choice {
  label: string;
  description?: string;
  buttonLabel?: string;
  /** Destructive: styled as a warning so it never looks like the safe default. */
  warning?: boolean;
  /** Shows the label in the name column even without a description (the button then reads buttonLabel or Select). */
  named?: boolean;
  action: () => void;
}

export class ChoiceModal extends Modal {
  private chosen = false;
  constructor(
    app: App,
    private titleText: string,
    private description: string,
    private choices: Choice[],
    /** Called when the dialog closes without a choice (Cancel, Escape). */
    private dismissed?: () => void
  ) {
    super(app);
  }
  onClose(): void {
    if (!this.chosen) this.dismissed?.();
    this.chosen = true;
  }
  onOpen(): void {
    this.titleEl.setText(this.titleText);
    this.contentEl.createEl("p", { text: this.description, cls: "vam-modal-intro" });
    for (const choice of this.choices) {
      const setting = new Setting(this.contentEl);
      const run = (): void => {
        this.chosen = true;
        this.close();
        choice.action();
      };
      if (choice.description || choice.named)
        setting
          .setName(choice.label)
          .setDesc(choice.description ?? "")
          .addButton(b => {
            b.setButtonText(choice.buttonLabel ?? t("ui.select")).onClick(run);
            if (choice.warning) b.setDestructive();
          });
      else
        setting.addButton(b => {
          b.setButtonText(choice.label).onClick(run);
          if (choice.warning) b.setDestructive();
        });
    }
    const cancel = modalActions(this).createEl("button", { text: t("ui.cancel") });
    cancel.addEventListener("click", () => this.close());
    // Start on Cancel, so a stray Enter never runs a choice, least of all a destructive one.
    cancel.focus();
    // Obsidian may move focus to the first button after onOpen; take it back so Enter never runs a choice.
    window.setTimeout(() => cancel.focus(), 0);
  }
}
