import { App, Modal, Setting } from "obsidian";
import { randomUUID } from "node:crypto";
import { t } from "../../i18n";
import type { MindSearchOutcomeExpectation, MindSearchOutcomeFormat, MindSearchOutcomeGoal } from "../../experiences/mind-search/outcome-expectations";

export interface MindSearchStartInput { topic: string; context: string; outcomeExpectation: MindSearchOutcomeExpectation; requestId: string; model: string; reasoning: "low" | "medium" | "high"; minimumAnswersBeforeConclusion: number }
type ModelChoice = { id: string; label: string };
type ModelRefreshResult = ModelChoice[] | { models: ModelChoice[]; message?: string; preserveSelection?: boolean };

export class MindSearchStartModal extends Modal {
  private requestId = randomUUID();
  constructor(app: App, private submit: (input: MindSearchStartInput) => Promise<void>, private models: ModelChoice[] = [], private defaultModel = "gpt-6-luna", private defaultReasoning: "low" | "medium" | "high" = "low", private refreshModels?: () => Promise<ModelRefreshResult>) { super(app); }
  onOpen(): void {
    this.titleEl.setText(t("ui.mindsearch_start_title"));
    const intro = this.contentEl.createEl("p", { text: t("ui.mindsearch_start_description"), cls: "vam-modal-intro" });
    intro.setAttr("aria-live", "polite");
    const topicLabel = this.contentEl.createEl("label", { cls: "vam-field" });
    topicLabel.createSpan({ text: t("ui.mindsearch_topic_label") });
    const topic = topicLabel.createEl("textarea", { cls: "vam-mindsearch-topic", attr: { rows: "2" } });
    topic.setAttr("aria-label", t("ui.mindsearch_topic_label"));
    const contextLabel = this.contentEl.createEl("label", { cls: "vam-field" });
    contextLabel.createSpan({ text: t("ui.mindsearch_context_label") });
    const context = contextLabel.createEl("textarea", { cls: "vam-mindsearch-context", attr: { rows: "4" } });
    context.setAttr("aria-label", t("ui.mindsearch_context_label"));
    const outcomeLabel = this.contentEl.createEl("label", { cls: "vam-field" });
    outcomeLabel.createSpan({ text: t("ui.mindsearch_outcome_goal") });
    const outcome = outcomeLabel.createEl("select"); outcome.setAttr("aria-label", t("ui.mindsearch_outcome_goal"));
    const goalChoices: [MindSearchOutcomeGoal, string][] = [
      ["auto", t("ui.mindsearch_outcome_auto")], ["execute", t("ui.mindsearch_outcome_execute")],
      ["understand", t("ui.mindsearch_outcome_understand")], ["explore", t("ui.mindsearch_outcome_explore")],
      ["custom", t("ui.mindsearch_outcome_custom")]
    ];
    for (const [value, label] of goalChoices) outcome.createEl("option", { value, text: label });
    outcome.value = "auto";
    outcomeLabel.createEl("p", { cls: "vam-hint", text: t("ui.mindsearch_outcome_hint") });
    const customLabel = this.contentEl.createEl("label", { cls: "vam-field" });
    customLabel.createSpan({ text: t("ui.mindsearch_outcome_description") });
    const customDescription = customLabel.createEl("textarea", { attr: { rows: "2" } });
    customDescription.setAttr("aria-label", t("ui.mindsearch_outcome_description"));
    customLabel.hidden = true;
    this.contentEl.createEl("p", { cls: "vam-field-label", text: t("ui.mindsearch_outcome_formats") });
    this.contentEl.createEl("p", { cls: "vam-hint", text: t("ui.mindsearch_format_system_hint") });
    const formatChoices: [MindSearchOutcomeFormat, string][] = [
      ["steps", t("ui.mindsearch_format_steps")], ["table", t("ui.mindsearch_format_table")],
      ["images", t("ui.mindsearch_format_images")], ["longform", t("ui.mindsearch_format_longform")]
    ];
    const formatInputs = formatChoices.map(([value, label]) => {
      const row = this.contentEl.createEl("label", { cls: "vam-field vam-next-toggle" });
      const checkbox = row.createEl("input", { attr: { type: "checkbox" } });
      checkbox.setAttr("aria-label", label);
      row.createSpan({ text: label });
      return { value, checkbox };
    });
    const modelLabel = this.contentEl.createEl("label", { cls: "vam-field" });
    modelLabel.createSpan({ text: t("ui.model") });
    const model = modelLabel.createEl("select"); model.setAttr("aria-label", t("ui.model"));
    let modelChoices = this.models.length ? [...this.models] : [{ id: this.defaultModel, label: this.defaultModel }];
    const selectedModel = (): string => model.value;
    const renderModels = (preferred = selectedModel()): string => {
      model.replaceChildren();
      for (const choice of modelChoices) model.createEl("option", { value: choice.id, text: choice.label });
      model.value = modelChoices.some(choice => choice.id === preferred) ? preferred : modelChoices[0]?.id ?? this.defaultModel;
      return model.value;
    };
    renderModels(this.defaultModel);
    let refreshingModels = false;
    const modelRefreshStatus = modelLabel.createEl("p", { cls: "vam-hint", attr: { "aria-live": "polite" } });
    const refreshButton = modelLabel.createEl("button", { text: t("ui.mindsearch_refresh_models") });
    refreshButton.type = "button";
    refreshButton.disabled = !this.refreshModels;
    refreshButton.addEventListener("click", () => { void (async () => {
      if (!this.refreshModels || refreshButton.disabled) return;
      refreshingModels = true;
      const previousSelection = selectedModel();
      refreshButton.disabled = true;
      model.disabled = true;
      createButton.disabled = true;
      modelRefreshStatus.setText(t("ui.mindsearch_refreshing_models"));
      try {
        const result = await this.refreshModels();
        if (!this.contentEl.isConnected) return;
        const refreshed = Array.isArray(result) ? result : [...result.models];
        if (!refreshed.length) { modelRefreshStatus.setText(t("ui.mindsearch_no_models_found")); return; }
        if (!Array.isArray(result) && result.preserveSelection && !refreshed.some(choice => choice.id === previousSelection)) {
          const previousChoice = modelChoices.find(choice => choice.id === previousSelection);
          if (previousChoice) refreshed.push(previousChoice);
        }
        modelChoices = refreshed;
        const currentSelection = renderModels(previousSelection);
        if (currentSelection !== previousSelection) newRequest();
        modelRefreshStatus.setText(Array.isArray(result) ? t("ui.mindsearch_models_refreshed") : result.message ?? t("ui.mindsearch_models_refreshed"));
      } catch (error) {
        if (!this.contentEl.isConnected) return;
        modelRefreshStatus.setText(t("ui.mindsearch_model_refresh_failed_0", error instanceof Error ? error.message : String(error)));
      } finally {
        refreshingModels = false;
        if (this.contentEl.isConnected) { refreshButton.disabled = false; model.disabled = false; createButton.disabled = false; }
      }
    })(); });
    const reasoningLabel = this.contentEl.createEl("label", { cls: "vam-field" });
    reasoningLabel.createSpan({ text: t("ui.reasoning_level") });
    const reasoning = reasoningLabel.createEl("select"); reasoning.setAttr("aria-label", t("ui.reasoning_level"));
    for (const [value, label] of [["low", t("ui.low")], ["medium", t("ui.medium")], ["high", t("ui.high")]] as const) reasoning.createEl("option", { value, text: label });
    reasoning.value = this.defaultReasoning;
    const answerCountLabel = this.contentEl.createEl("label", { cls: "vam-field" });
    answerCountLabel.createSpan({ text: t("ui.mindsearch_minimum_answers") });
    const answerCount = answerCountLabel.createEl("input", { attr: { type: "number", min: "3", max: "10", step: "1" } });
    answerCount.value = "3";
    answerCount.setAttr("aria-label", t("ui.mindsearch_minimum_answers"));
    answerCountLabel.createEl("p", { cls: "vam-hint", text: t("ui.mindsearch_answer_target_hint") });
    const newRequest = (): void => { this.requestId = randomUUID(); };
    topic.addEventListener("input", newRequest); context.addEventListener("input", newRequest);
    model.addEventListener("change", newRequest); reasoning.addEventListener("change", newRequest);
    answerCount.addEventListener("input", newRequest);
    outcome.addEventListener("change", () => {
      customLabel.hidden = outcome.value !== "custom";
      if (outcome.value !== "custom") customDescription.value = "";
      newRequest();
    });
    customDescription.addEventListener("input", newRequest);
    for (const { checkbox } of formatInputs) checkbox.addEventListener("change", newRequest);
    const status = this.contentEl.createEl("p", { cls: "vam-hint", attr: { "aria-live": "polite" } });
    let pending = false;
    let cancelButton: { disabled: boolean } | undefined;
    const create = new Setting(this.contentEl).addButton(button => { cancelButton = button; button.setButtonText(t("ui.cancel")).onClick(() => this.close()); })
      .addButton(button => button.setButtonText(t("ui.mindsearch_create")).setCta().onClick(() => { void (async () => {
        if (pending || refreshingModels) return;
        if (!topic.value.trim()) { status.setText(t("ui.mindsearch_topic_required")); topic.focus(); return; }
        if (outcome.value === "custom" && !customDescription.value.trim()) { status.setText(t("ui.mindsearch_outcome_custom_required")); customDescription.focus(); return; }
        const minimumAnswersBeforeConclusion = Number(answerCount.value);
        if (!Number.isInteger(minimumAnswersBeforeConclusion) || minimumAnswersBeforeConclusion < 3 || minimumAnswersBeforeConclusion > 10) {
          status.setText(t("ui.mindsearch_minimum_answers_invalid")); answerCount.focus(); return;
        }
        pending = true;
        refreshButton.disabled = true;
        if (cancelButton) cancelButton.disabled = true;
        const controls = [topic, context, outcome, customDescription, ...formatInputs.map(item => item.checkbox), model, reasoning, answerCount];
        controls.forEach(control => { control.disabled = true; });
        createButton.disabled = true;
        status.setText(t("ui.mindsearch_creating"));
        const outcomeExpectation: MindSearchOutcomeExpectation = {
          goal: outcome.value as MindSearchOutcomeGoal,
          description: outcome.value === "custom" ? customDescription.value.trim() : "",
          formats: formatInputs.filter(item => item.checkbox.checked).map(item => item.value)
        };
        try { await this.submit({ topic: topic.value.trim(), context: context.value.trim(), outcomeExpectation, requestId: this.requestId, model: model.value, reasoning: reasoning.value as "low" | "medium" | "high", minimumAnswersBeforeConclusion }); this.close(); }
        catch (error) {
          status.setText(error instanceof Error ? error.message : String(error)); pending = false;
          if (cancelButton) cancelButton.disabled = false;
          refreshButton.disabled = false;
          createButton.disabled = false;
          controls.forEach(control => { control.disabled = false; });
        }
      })(); }));
    const createButton = create.controlEl.querySelector("button:last-child") as HTMLButtonElement;
    topic.focus();
  }
}
