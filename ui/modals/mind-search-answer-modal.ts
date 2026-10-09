import { App, Modal, Setting } from "obsidian";
import { randomUUID } from "node:crypto";
import { t } from "../../i18n";

export interface MindSearchAnswerInput { requestId: string; selections: string[]; freeText: string }
export class MindSearchAnswerModal extends Modal {
  private requestId: string;
  constructor(app: App, private question: string, private options: { id: string; label: string }[], private submit: (input: MindSearchAnswerInput) => Promise<void>, requestId: string = randomUUID()) { super(app); this.requestId = requestId; }
  onOpen(): void {
    this.titleEl.setText(t("ui.mindsearch_answer_title"));
    this.contentEl.createEl("p", { text: this.question, cls: "vam-modal-intro" });
    const choices = this.contentEl.createDiv({ cls: "vam-mindsearch-answer-options", attr: { role: "group", "aria-label": this.question } });
    const boxes = new Map<string, HTMLInputElement>();
    for (const option of this.options) {
      const label = choices.createEl("label", { cls: "vam-mindsearch-answer-option" });
      const input = label.createEl("input", { type: "checkbox", value: option.id });
      input.setAttr("aria-label", option.label); label.createSpan({ text: option.label }); boxes.set(option.id, input);
      input.addEventListener("change", () => {
        this.requestId = randomUUID();
        if (input.checked && option.id === "__mindsearch_unknown__") {
          for (const [id, peer] of boxes) if (id !== option.id) peer.checked = false;
        } else if (input.checked) {
          const unknown = boxes.get("__mindsearch_unknown__"); if (unknown) unknown.checked = false;
        }
      });
    }
    const freeTextLabel = this.contentEl.createEl("label", { cls: "vam-field" });
    freeTextLabel.createSpan({ text: t("ui.mindsearch_free_text") });
    const freeText = freeTextLabel.createEl("textarea", { attr: { rows: "3" } }); freeText.setAttr("aria-label", t("ui.mindsearch_free_text"));
    freeText.addEventListener("input", () => { this.requestId = randomUUID(); });
    const status = this.contentEl.createEl("p", { cls: "vam-hint", attr: { "aria-live": "polite" } });
    let pending = false, submitButton: HTMLButtonElement;
    const setting = new Setting(this.contentEl).addButton(button => button.setButtonText(t("ui.cancel")).onClick(() => { if (!pending) this.close(); }))
      .addButton(button => { button.setButtonText(t("ui.mindsearch_submit_answer")).setCta().onClick(() => { void (async () => {
        if (pending) return;
        const selections = [...boxes].filter(([, checkbox]) => checkbox.checked).map(([id]) => id);
        if (!selections.length && !freeText.value.trim()) { status.setText(t("ui.mindsearch_answer_required")); freeText.focus(); return; }
        pending = true; submitButton.disabled = true; status.setText(t("ui.mindsearch_submitting_answer"));
        this.close();
        void this.submit({ requestId: this.requestId, selections, freeText: freeText.value }).catch(() => { /* The owner reports background failures through Obsidian notices. */ });
      })(); }); });
    submitButton = setting.controlEl.querySelector("button:last-child") as HTMLButtonElement;
    freeText.focus();
  }
}
