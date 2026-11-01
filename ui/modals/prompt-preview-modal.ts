import { App, Modal } from "obsidian";
import type { AiProviderId } from "../../ai/providers/provider";
import type { NoteStyleStore } from "../../ai/note-style-store";
import { PREVIEW_STEPS, previewPrompt, type PreviewGroup, type PreviewStep } from "../../core/blocks/prompt-preview";
import { styleIssueText } from "../../experiences/visual-map/note-style-picker";
import { t, type ContentLanguage, type TranslationKey } from "../../i18n";

const GROUP_KEYS: Record<PreviewGroup, TranslationKey> = {
  role: "ui.preview_group_role",
  template: "ui.preview_group_template",
  tone: "ui.preview_group_tone",
  fixed: "ui.preview_group_fixed",
  input: "ui.preview_group_input"
};

/**
 * Read-only view of the full prompt of one step, as a run with the workspace default style would send it (sample task
 * input). Every text goes in with `setText`, never as HTML or Markdown, so a block's own markup is shown as written.
 */
export class PromptPreviewModal extends Modal {
  private step: PreviewStep = PREVIEW_STEPS[0].id;
  private bodyEl: HTMLElement | undefined;

  constructor(
    app: App,
    private readonly store: NoteStyleStore,
    private readonly language: ContentLanguage,
    private readonly provider: AiProviderId,
    private readonly trigger?: HTMLElement
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(t("ui.preview_prompt_title"));
    const { contentEl } = this;
    contentEl.addClass("vam-prompt-preview");
    contentEl.createEl("p", { text: t("ui.preview_prompt_hint"), cls: "setting-item-description" });
    const label = contentEl.createEl("label", {
      text: t("ui.preview_prompt_step_label"),
      cls: "vam-prompt-preview-label"
    });
    const select = contentEl.createEl("select", { cls: "dropdown" });
    select.id = "vam-prompt-preview-step";
    label.setAttr("for", select.id);
    for (const item of PREVIEW_STEPS) select.createEl("option", { text: t(item.nameKey), value: item.id });
    select.value = this.step;
    select.addEventListener("change", () => {
      this.step = select.value as PreviewStep;
      this.renderBody();
    });
    this.bodyEl = contentEl.createDiv({ cls: "vam-prompt-preview-body" });
    this.renderBody();
    select.focus();
  }

  onClose(): void {
    this.contentEl.empty();
    this.bodyEl = undefined;
    const trigger = this.trigger;
    if (trigger?.isConnected) trigger.focus();
  }

  private renderBody(): void {
    const body = this.bodyEl;
    if (!body) return;
    body.empty();
    const fields = this.store.workspaceStyleFields(this.language);
    if (fields.invalid) {
      const first = fields.invalid.issues[0];
      const reason = first ? styleIssueText(first) : "";
      body.createEl("p", {
        text: t("ui.preview_style_invalid_0_1_2", fields.invalid.fileName, first?.line ?? 1, reason),
        cls: "vam-prompt-preview-problem",
        attr: { role: "alert" }
      });
      return;
    }
    const preview = previewPrompt(this.step, this.language, this.provider, fields);
    for (const issue of preview.issues) {
      body.createEl("p", {
        text: t("ui.preview_issue_0_1_2", issue.fileName ?? issue.id, issue.line, styleIssueText(issue)),
        cls: "vam-prompt-preview-problem",
        attr: { role: "alert" }
      });
    }
    for (const section of preview.sections) {
      const title = t(GROUP_KEYS[section.group]);
      body.createEl("h4", { text: title });
      const pre = body.createEl("pre", { cls: "vam-prompt-preview-text" });
      pre.setText(section.text);
      pre.setAttr("tabindex", "0");
      pre.setAttr("role", "region");
      pre.setAttr("aria-label", t("ui.preview_prompt_text_0", title));
    }
  }
}
