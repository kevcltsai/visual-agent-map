import { App, Modal } from "obsidian";
import { t } from "../../i18n";
import type { ResearchDepth, ResearchMode } from "../../ai/types";
import type { MapAiMode } from "./ai-mode";
import { modelField, noteStyleField, type FieldLinks, type ManageTones, type ModelChoices } from "./research-fields";
import { modalActions } from "../../ui/modals/action-bar";

export interface MultiResearchRequest {
  /**
   * Overrides for every started topic; only the map AI chat sets them. The dialog leaves them out, so each topic runs in the
   * mode its own note stores (Quick or Standard) with the matching depth and image setting.
   */
  researchMode?: ResearchMode;
  researchDepth?: ResearchDepth;
  /** Search for image references (an override; only meaningful with web search). */
  imageSearch?: boolean;
  /** Seamless research only: the chat asked for images, so "none found" is a problem. */
  imagesRequested?: boolean;
  requirements: string;
  /** Model for every started topic (saved on the topic, as single-topic research does); undefined keeps each topic's model. */
  model?: string;
  /** Content template for every started topic (saved on the topic); undefined keeps each topic's template. */
  detailTemplateId?: string;
  /** Writing tone for every started topic (saved on the topic); undefined keeps each topic's tone. */
  toneId?: string;
}

export class MultiResearchModal extends Modal {
  private submitted = false;
  private unwatch?: () => void;

  constructor(
    app: App,
    private names: string[],
    private models: ModelChoices,
    private templates: { id: string; name: string }[],
    private submit: (request: MultiResearchRequest) => void,
    private tones: { id: string; name: string }[] = [],
    private manageTones?: ManageTones,
    private links: FieldLinks = {},
    /** The mode each listed topic will run in (parallel to `names`), shown beside its name. */
    private modes: MapAiMode[] = []
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(t("ui.multi_research_title"));
    this.contentEl.createEl("p", { text: t("ui.multi_research_intro", this.names.length), cls: "vam-modal-intro" });
    const topics = this.contentEl.createDiv("vam-integration-sources");
    topics.createEl("strong", { text: t("ui.multi_research_topics") });
    this.names.forEach((name, index) => {
      const row = topics.createDiv({ cls: "vam-multi-research-topic" });
      row.createSpan({ text: name });
      const mode = this.modes[index];
      if (mode)
        row.createSpan({
          cls: "vam-multi-research-mode",
          text: t(mode === "quick" ? "ui.quick" : "ui.standard")
        });
    });
    const model = modelField(this.contentEl, this.models, t("ui.multi_research_keep_topic_models"), this.links.repair);
    this.unwatch = model.dispose;
    const style = noteStyleField(this.contentEl, {
      templates: this.templates,
      tones: this.tones,
      keepLabel: t("ui.note_style_keep_each"),
      templateDefault: t("ui.detail_template_keep_each"),
      toneDefault: t("ui.tone_keep_each"),
      manageTemplates: this.links.manageTemplates,
      manageTones: this.manageTones
    });
    const requirementsLabel = this.contentEl.createEl("label", { cls: "vam-field" });
    requirementsLabel.createSpan({ text: t("ui.additional_requirements") });
    const requirements = requirementsLabel.createEl("textarea");
    requirements.rows = 3;
    requirements.setAttr("aria-label", t("ui.additional_requirements"));
    const actions = modalActions(this);
    const cancel = actions.createEl("button", { text: t("ui.cancel") });
    cancel.addEventListener("click", () => this.close());
    const start = actions.createEl("button", {
      text: t("ui.multi_research_start_0", this.names.length),
      cls: "mod-cta"
    });
    start.addEventListener("click", () => {
      if (this.submitted) return;
      this.submitted = true;
      const request: MultiResearchRequest = {
        requirements: requirements.value.trim(),
        ...(model.value() ? { model: model.value() } : {}),
        ...(style.templateId() ? { detailTemplateId: style.templateId() } : {}),
        ...(style.toneId() ? { toneId: style.toneId() } : {})
      };
      this.close();
      this.submit(request);
    });
  }

  onClose(): void {
    this.unwatch?.();
    this.unwatch = undefined;
  }
}
