import { App, Modal, Setting } from "obsidian";

/** One optional batch of user conditions, stored on the mother topic rather than as exploration answers. */
export class MindSearchClarificationModal extends Modal {
  constructor(app: App, private questions: string[], private submit: (answers: string) => Promise<void>, private english: boolean) { super(app); }
  onOpen(): void {
    const text = (zh: string, en: string): string => this.english ? en : zh;
    this.titleEl.setText(text("開始前釐清", "Before exploring"));
    this.contentEl.createEl("p", { text: text("一起確認會影響研究方向的條件。留白表示不確定，先探索。這輪不計入探索題數。", "Confirm the conditions that affect research. Leave answers blank if unsure. This intake does not count toward exploration questions.") });
    const fields = this.questions.map(question => {
      const label = this.contentEl.createEl("label", { cls: "vam-field" });
      label.createSpan({ text: question });
      const input = label.createEl("textarea", { attr: { rows: "2" } });
      input.setAttr("aria-label", question);
      input.placeholder = text("不確定，先探索", "Unsure — explore first");
      return { question, input };
    });
    const status = this.contentEl.createEl("p", { cls: "vam-hint", attr: { "aria-live": "polite" } });
    let pending = false;
    new Setting(this.contentEl)
      .addButton(button => button.setButtonText(text("取消", "Cancel")).onClick(() => { if (!pending) this.close(); }))
      .addButton(button => button.setButtonText(text("保存並開始探索", "Save and explore")).setCta().onClick(() => {
        if (pending) return;
        pending = true; button.setDisabled(true); fields.forEach(field => { field.input.disabled = true; });
        const answers = fields.map(({ question, input }) => `- ${question}\n  ${input.value.trim() || text("不確定，先探索；請研究適用的替代情況，不要再次要求填寫。", "Unsure; research applicable alternatives without asking this again.")}`).join("\n\n");
        void this.submit(answers).then(() => this.close()).catch(error => {
          pending = false; button.setDisabled(false); fields.forEach(field => { field.input.disabled = false; });
          status.setText(error instanceof Error ? error.message : String(error));
        });
      }));
    fields[0]?.input.focus();
  }
}
