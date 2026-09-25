import { App, Modal, Setting } from "obsidian";
import { t } from "../../i18n";

export class NameModal extends Modal {
  constructor(app: App, private titleText: string, private value: string, private submit: (value: string) => void) { super(app); }
  onOpen(): void {
    this.titleEl.setText(this.titleText);
    const input = this.contentEl.createEl("input", { type: "text", value: this.value, cls: "vam-name-input" });
    input.setAttr("aria-label", this.titleText);
    const save = (): void => { const value = input.value.trim(); if (value) { this.close(); this.submit(value); } };
    input.addEventListener("keydown", event => { if (event.key === "Enter") save(); });
    new Setting(this.contentEl).addButton(b => b.setButtonText(t("ui.cancel")).onClick(() => this.close())).addButton(b => b.setButtonText(t("ui.save")).setCta().onClick(save));
    input.focus(); input.select();
  }
}
