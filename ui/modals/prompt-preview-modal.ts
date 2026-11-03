import { App, Modal } from "obsidian";
import type { AiProviderId } from "../../ai/providers/provider";
import type { NoteStyleStore, RunStyle } from "../../ai/note-style-store";
import {
  PREVIEW_STEPS,
  previewPrompt,
  type PreviewGroup,
  type PreviewStep,
  type PreviewStyleFields
} from "../../core/blocks/prompt-preview";
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
  private problemsEl: HTMLElement | undefined;
  private problemText = "";

  constructor(
    app: App,
    private readonly store: NoteStyleStore,
    private readonly language: ContentLanguage,
    private readonly provider: AiProviderId,
    private readonly trigger?: HTMLElement,
    /** The style to show instead of the workspace default (the style editor's draft). Read each time the body is drawn. */
    private readonly styleOf?: () => RunStyle
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
    // One polite live region for the problems: it is written only when their text changes, so changing the step does not
    // make a screen reader repeat the same problem.
    this.problemText = "";
    this.problemsEl = contentEl.createDiv({ cls: "vam-prompt-preview-problems", attr: { "aria-live": "polite" } });
    this.bodyEl = contentEl.createDiv({ cls: "vam-prompt-preview-body" });
    this.renderBody();
    select.focus();
    // The block files may have been edited since the store last read them (the settings page stays open while they are
    // edited in a tab): read them again and show what is there now. An unchanged problem leaves the live region alone.
    void this.store
      .refresh()
      .catch(() => undefined)
      .then(() => this.renderBody());
  }

  onClose(): void {
    this.contentEl.empty();
    this.bodyEl = undefined;
    this.problemsEl = undefined;
    const trigger = this.trigger;
    if (trigger?.isConnected) trigger.focus();
  }

  /** Shows the problems when their text differs from what is shown; the live region is left alone otherwise. */
  private showProblems(lines: string[]): void {
    const region = this.problemsEl;
    if (!region) return;
    const text = lines.join("\n");
    if (text === this.problemText) return;
    this.problemText = text;
    region.empty();
    for (const line of lines) region.createEl("p", { text: line, cls: "vam-prompt-preview-problem" });
  }

  private renderBody(): void {
    const body = this.bodyEl;
    if (!body) return;
    body.empty();
    // A run with no choice of its own: the workspace default style (or the editor's draft when one is given).
    const style = this.styleOf?.() ?? this.store.runStyle({ kind: "topic", outputLanguage: this.language });
    const fields: PreviewStyleFields = {
      detailTemplate: style.template,
      ...(style.toneText ? { toneText: style.toneText } : {}),
      ...style.contextFields
    };
    const preview = previewPrompt(this.step, this.language, this.provider, fields);
    this.showProblems(
      preview.issues.map(issue =>
        t("ui.preview_issue_0_1_2", issue.fileName ?? issue.id, issue.line, styleIssueText(issue))
      )
    );
    // The modal title is not a heading element, so the section titles start at h2 and never skip a level.
    // The default voice (academic rigor) adds no text, so the prompt has no voice part: say so instead of leaving a gap.
    const hasTone = preview.sections.some(section => section.group === "tone");
    const lastTemplate = preview.sections.map(section => section.group).lastIndexOf("template");
    const emptyToneAt = hasTone ? -1 : lastTemplate + 1;
    const showEmptyTone = (): void => {
      body.createEl("h2", { text: t(GROUP_KEYS.tone) });
      body.createEl("p", {
        text: t("ui.preview_tone_empty"),
        cls: "vam-prompt-preview-empty setting-item-description"
      });
    };
    for (const [index, section] of preview.sections.entries()) {
      if (index === emptyToneAt) showEmptyTone();
      const title = t(GROUP_KEYS[section.group]);
      body.createEl("h2", { text: title });
      const pre = body.createEl("pre", { cls: "vam-prompt-preview-text" });
      pre.setText(section.text);
      pre.setAttr("tabindex", "0");
      pre.setAttr("role", "region");
      pre.setAttr("aria-label", t("ui.preview_prompt_text_0", title));
    }
    if (emptyToneAt === preview.sections.length) showEmptyTone();
  }
}
