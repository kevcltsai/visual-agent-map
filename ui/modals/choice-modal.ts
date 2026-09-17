import { App, Modal, Setting } from "obsidian";
import { t } from "../../i18n";

export class ChoiceModal extends Modal {
  constructor(app: App, private titleText: string, private description: string, private choices: { label: string; description?: string; buttonLabel?: string; action: () => void }[]) { super(app); }
  onOpen(): void {
    this.titleEl.setText(this.titleText);
    this.contentEl.createEl("p", { text: this.description, cls: "vam-modal-intro" });
    for (const choice of this.choices) {
      const setting = new Setting(this.contentEl);
      if (choice.description) setting.setName(choice.label).setDesc(choice.description).addButton(b => b.setButtonText(choice.buttonLabel ?? t("選擇")).onClick(() => { this.close(); choice.action(); }));
      else setting.addButton(b => b.setButtonText(choice.label).onClick(() => { this.close(); choice.action(); }));
    }
    new Setting(this.contentEl).addButton(b => b.setButtonText(t("取消")).onClick(() => this.close()));
  }
}
