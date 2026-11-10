import { App, Modal } from "obsidian";
import { t } from "../../i18n";
import { modalActions } from "./action-bar";

export interface ArgumentStartInput {
  claim: string;
  model: string;
}
type ModelChoice = { id: string; label: string };

/**
 * The start window of hypothesis research: the proposition, the model, and what the run costs and where it connects, before anything
 * starts. Nothing is called until "Start research"; Esc and Cancel hand nothing back.
 */
export class ArgumentStartModal extends Modal {
  constructor(
    app: App,
    private draft: string,
    private models: ModelChoice[],
    private defaultModel: string,
    private calls: number,
    private onStart: (input: ArgumentStartInput) => void | Promise<void>
  ) {
    super(app);
  }
  onOpen(): void {
    this.titleEl.setText(t("ui.argument_start_title"));
    const claimLabel = this.contentEl.createEl("label", { cls: "vam-field" });
    claimLabel.createSpan({ text: t("ui.argument_proposition") });
    const claim = claimLabel.createEl("textarea", { cls: "vam-argument-claim", attr: { rows: "2" } });
    claim.value = this.draft.trim();
    claim.setAttr("aria-label", t("ui.argument_proposition"));
    const modelLabel = this.contentEl.createEl("label", { cls: "vam-field" });
    modelLabel.createSpan({ text: t("ui.model") });
    const model = modelLabel.createEl("select");
    model.setAttr("aria-label", t("ui.model"));
    const choices = this.models.some(choice => choice.id === this.defaultModel)
      ? this.models
      : [...this.models, { id: this.defaultModel, label: this.defaultModel }];
    for (const choice of choices) model.createEl("option", { value: choice.id, text: choice.label });
    model.value = this.defaultModel;
    this.contentEl.createEl("p", { cls: "vam-hint", text: t("ui.argument_start_usage_0", String(this.calls)) });
    const actions = modalActions(this);
    actions.createEl("button", { text: t("ui.cancel") }).addEventListener("click", () => this.close());
    const start = actions.createEl("button", { text: t("ui.argument_start_confirm"), cls: "mod-cta" });
    const blank = (): boolean => !claim.value.trim();
    const check = (): void => {
      start.disabled = blank();
    };
    const submit = (): void => {
      if (blank()) return;
      const input = { claim: claim.value.trim(), model: model.value };
      this.close();
      void this.onStart(input);
    };
    claim.addEventListener("input", check);
    start.addEventListener("click", submit);
    check();
    claim.focus();
    const end = claim.value.length;
    claim.setSelectionRange(end, end);
  }
}
