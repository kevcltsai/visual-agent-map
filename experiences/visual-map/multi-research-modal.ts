import { App, Modal } from "obsidian";
import { t } from "../../i18n";
import type { ResearchDepth, ResearchMode } from "../../ai/types";
import { aiModeOptions, DEFAULT_MAP_AI_MODE, type MapAiMode } from "./ai-mode";
import { aiModeField, modelField, styleChoiceField, type FieldLinks, type ModelChoices } from "./research-fields";
import { modalActions } from "../../ui/modals/action-bar";

export interface MultiResearchRequest {
  /**
   * Overrides for every started topic; the dialog (its Quick/Standard switch) and the map AI chat set them. Only the
   * "retry with another provider" start leaves them out, so each topic then runs in the mode its own note stores (Quick or
   * Standard) with the matching depth and image setting.
   */
  researchMode?: ResearchMode;
  researchDepth?: ResearchDepth;
  /** Search for image references (an override; only meaningful with web search). */
  imageSearch?: boolean;
  requirements: string;
  /** Model for every started topic, for this batch only (never saved on a topic); undefined keeps each topic's model. */
  model?: string;
  /**
   * A note style (`builtin:<id>` or `file:<name>`) for every started topic, for this batch only (never written to a
   * topic); undefined keeps each topic's own style.
   */
  noteStyle?: string;
  /** Map chat only: the user asked for a whole rewrite, so every started topic is written back "fresh" (backup, then replace) this batch only. */
  rewrite?: boolean;
}

export class MultiResearchModal extends Modal {
  private submitted = false;
  private unwatch?: () => void;

  constructor(
    app: App,
    private names: string[],
    private models: ModelChoices,
    private submit: (request: MultiResearchRequest) => void,
    private links: FieldLinks = {},
    /** The mode each listed topic last used (parallel to `names`); only counted for the "will use Quick" reminder. */
    private modes: MapAiMode[] = [],
    /** The mode the switch opens on (the map's remembered mode). */
    private initialMode: MapAiMode = DEFAULT_MAP_AI_MODE
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(t("ui.multi_research_title"));
    this.contentEl.createEl("p", { text: t("ui.multi_research_intro", this.names.length), cls: "vam-modal-intro" });
    let mode: MapAiMode = this.initialMode;
    const standardTopics = this.modes.filter(item => item === "standard").length;
    let paintNote = (): void => {};
    aiModeField(this.contentEl, {
      initial: mode,
      onChange: next => {
        mode = next;
        paintNote();
      }
    });
    // The reminder sits right under the switch, before the topic list.
    const note = this.contentEl.createEl("p", { cls: "vam-multi-research-mode-note" });
    paintNote = (): void => {
      note.setText(t("ui.multi_research_mode_downgrade_0", standardTopics));
      note.hidden = !(mode === "quick" && standardTopics > 0);
    };
    paintNote();
    const topics = this.contentEl.createDiv("vam-integration-sources");
    topics.createEl("strong", { text: t("ui.multi_research_topics") });
    for (const name of this.names) topics.createDiv({ cls: "vam-multi-research-topic" }).createSpan({ text: name });
    const model = modelField(this.contentEl, this.models, t("ui.multi_research_current_model"), this.links.repair);
    this.unwatch = model.dispose;
    const style = styleChoiceField(this.contentEl, {
      styles: this.links.styles,
      current: t("ui.note_style_each_topic")
    });
    void style.reload();
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
      const options = aiModeOptions(mode, "research");
      const request: MultiResearchRequest = {
        researchMode: options.researchMode,
        researchDepth: options.researchDepth,
        imageSearch: mode === "standard",
        requirements: requirements.value.trim(),
        ...(model.value() ? { model: model.value() } : {}),
        ...(style.style() ? { noteStyle: style.style() } : {})
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
