import { App, Modal, Setting } from "obsidian";
import { translate, type TranslationKey, type ContentLanguage, translateNote } from "../../i18n";

/** One optional batch of user conditions, stored on the mother topic rather than as exploration answers. */
export class AimClarificationModal extends Modal {
  constructor(
    app: App,
    private questions: string[],
    private submit: (answers: string) => Promise<void>,
    /** Interface language of the modal itself. */
    private language: ContentLanguage,
    /** Language of the note text this modal writes (blank-answer placeholder); the modal UI stays in the interface language. */
    private contentLanguage: ContentLanguage
  ) {
    super(app);
  }
  onOpen(): void {
    const text = (key: TranslationKey): string => translate(this.language, key);
    this.titleEl.setText(text("ui.aim_clarify_title"));
    this.contentEl.createEl("p", {
      text: text("ui.aim_clarify_intro")
    });
    const fields = this.questions.map(question => {
      const label = this.contentEl.createEl("label", { cls: "vam-field" });
      label.createSpan({ text: question });
      const input = label.createEl("textarea", { attr: { rows: "2" } });
      input.setAttr("aria-label", question);
      input.placeholder = text("ui.aim_clarify_placeholder");
      return { question, input };
    });
    const status = this.contentEl.createEl("p", { cls: "vam-hint", attr: { "aria-live": "polite" } });
    let pending = false;
    new Setting(this.contentEl)
      .addButton(button =>
        button.setButtonText(text("ui.cancel")).onClick(() => {
          if (!pending) this.close();
        })
      )
      .addButton(button =>
        button
          .setButtonText(text("ui.aim_clarify_save"))
          .setCta()
          .onClick(() => {
            if (pending) return;
            pending = true;
            button.setDisabled(true);
            fields.forEach(field => {
              field.input.disabled = true;
            });
            const answers = fields
              .map(
                ({ question, input }) =>
                  `- ${question}\n  ${input.value.trim() || translateNote(this.contentLanguage, "note.aim_clarify_blank_answer")}`
              )
              .join("\n\n");
            void this.submit(answers)
              .then(() => this.close())
              .catch(error => {
                pending = false;
                button.setDisabled(false);
                fields.forEach(field => {
                  field.input.disabled = false;
                });
                status.setText(error instanceof Error ? error.message : String(error));
              });
          })
      );
    fields[0]?.input.focus();
  }
}
