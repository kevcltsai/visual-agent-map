import { App, Modal, Notice } from "obsidian";
import { t } from "../../i18n";
import { parseOutline, sanitizeOutlineDraft, type OutlineIssue, type OutlineNode } from "./outline-import";
import type { MapAiMode } from "./ai-mode";
import type { TaskOptions } from "./modals";
import { aiModeField, modelField, noteStyleField, type FieldLinks, type ModelChoices } from "./research-fields";
import { actionStatus, armDiscard, modalActions } from "../../ui/modals/action-bar";
import type { PromptPresetsHost } from "../../ui/modals/prompt-presets-modal";
import {
  createPreset,
  deletePreset,
  DEFAULT_OUTLINE_PRESET_ID,
  isBuiltinPreset,
  listPresets,
  updatePreset,
  type PromptPreset
} from "../../ai/prompt-presets";

/** The message of any thrown value; errors may come from another realm, so no instanceof check. */
const messageOf = (error: unknown): string => {
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === "string" ? message : String(error);
};

/** Where the imported outline goes; omitted means a new mind map. */
export type OutlinePlacement = { kind: "new" } | { kind: "tree" } | { kind: "under"; parentId: string };

/** What the open view offers as an import target, read when the window opens. */
export interface OutlineImportTarget {
  map: "none" | "aim" | "editable";
  selected?: { id: string; title: string };
}

export interface OutlineImportRequest {
  nodes: OutlineNode[];
  placement?: OutlinePlacement;
  source: string | null;
  shallowResearch: boolean;
  /** AI mode of the shallow research (Quick when omitted). */
  aiMode?: MapAiMode;
  /**
   * The research choices for the shallow research (quick explore passes its dialog's); without them it searches the
   * web with no reference groups, no images, the workspace language and tone, and no extra requirements.
   */
  researchOptions?: Pick<TaskOptions, "referenceGroups" | "outputLanguage" | "toneId" | "requirements">;
  /**
   * The outline has no root of its own (quick explore drops the topic it was generated for): every created topic is
   * researched under the "under" parent, even when the outline has a single top heading.
   */
  researchEveryTopic?: boolean;
  /** Model for the new topics and their shallow research; undefined uses the workspace default. */
  model?: string;
  /**
   * Content template: a new map's default, or recorded on each created topic when importing into an open map; also
   * used by the shallow research. Undefined uses the map/workspace default.
   */
  detailTemplateId?: string;
  /** Writing tone, handled like the template: the new map's default, or recorded on each created topic. */
  toneId?: string;
}

/** Everything the window held when AI generation started, so a reopened window shows the same choices. */
export interface OutlineDraftInputs {
  topic: string;
  presetId: string;
  /** The preset box as it was, including edits that were never saved. */
  presetText: string;
  placement: OutlinePlacement["kind"];
  target: OutlineImportTarget;
  shallow: boolean;
  mode: MapAiMode;
  model?: string;
  template?: string;
  tone?: string;
}

/** What a reopened window starts from: the inputs of the run and its result (or why there is none). */
export interface OutlineDraftPrefill {
  inputs: OutlineDraftInputs;
  /** The generated outline, put in the outline box. */
  markdown?: string;
  /** Why the run ended without an outline (failed or stopped), shown next to the button. */
  message?: string;
}

/** The AI outline generator as the import window uses it; without it the window has no AI section. */
export interface OutlineGenerator {
  presets: PromptPresetsHost;
  /**
   * Generates heading-only Markdown for the topic (asking about AI usage first); rejects with a readable reason. The
   * host calls `started` once AI actually starts (usage confirmed): the window then hides itself, `started` returns
   * the window's inputs for the host to keep, and the host carries the run on in the background, so the returned
   * promise is no longer read.
   */
  generate: (
    request: { topic: string; presetText: string },
    signal: AbortSignal,
    started: () => OutlineDraftInputs
  ) => Promise<string>;
  initialTopic?: string;
  /** Opened again from the status bar or the Notice: the window starts from this run's inputs and result. */
  prefill?: OutlineDraftPrefill;
}

export class OutlineImportModal extends Modal {
  private textarea!: HTMLTextAreaElement;
  private preview!: HTMLElement;
  private createButton!: HTMLButtonElement;
  private status!: HTMLElement;
  private shallow!: HTMLInputElement;
  private nodes: OutlineNode[] = [];
  private submitting = false;
  private mode: () => MapAiMode = () => "quick";
  private model: () => string | undefined = () => undefined;
  private template: () => string | undefined = () => undefined;
  private tone: () => string | undefined = () => undefined;
  private setModel: (id: string | undefined) => void = () => {};
  private setStyle: (template: string | undefined, tone: string | undefined) => void = () => {};
  private setMode: (mode: MapAiMode) => void = () => {};
  private syncResearchOptions: () => void = () => {};
  private restoreResult: () => void = () => {};
  /** AI generation started and this window hid itself; closing no longer stops it (the status bar has Stop). */
  private detached = false;
  private unwatch?: () => void;
  private placement: OutlinePlacement["kind"] = "tree";
  private generation?: AbortController;
  private disarm?: () => void;

  constructor(
    app: App,
    private create: (request: OutlineImportRequest) => Promise<void>,
    private models: ModelChoices = { list: () => [], watch: () => () => {} },
    private templates: { id: string; name: string }[] = [],
    private target: OutlineImportTarget = { map: "none" },
    initialPlacement: OutlinePlacement["kind"] = "tree",
    private generator?: OutlineGenerator,
    private links: FieldLinks = {},
    private tones: { id: string; name: string }[] = [],
    private defaultStyleLabel = ""
  ) {
    super(app);
    // The outline always joins the open map (a new map starts from + New mind map); without a selection it becomes a new tree.
    this.placement = initialPlacement === "under" && target.selected ? "under" : "tree";
  }

  onOpen(): void {
    this.titleEl.setText(t("ui.outline_import"));
    this.modalEl.addClass("vam-outline-import-modal");
    this.contentEl.createEl("p", { text: t("ui.outline_import_hint"), cls: "vam-hint vam-outline-intro" });
    if (this.generator) this.aiSection(this.contentEl.createDiv("vam-outline-section"), this.generator);
    const source = this.contentEl.createDiv("vam-outline-section");
    const sourceHeader = source.createDiv("vam-outline-section-header");
    sourceHeader.createSpan({ text: t("ui.outline_import_text_label"), cls: "vam-outline-label" });
    const actions = sourceHeader.createDiv("vam-outline-actions");
    actions
      .createEl("button", { text: t("ui.outline_import_copy_format"), cls: "vam-outline-link" })
      .addEventListener("click", () => {
        void navigator.clipboard
          .writeText(t("ui.outline_import_format"))
          .then(() => new Notice(t("ui.outline_import_format_copied")))
          .catch(() => new Notice(t("ui.outline_import_copy_failed")));
      });
    this.textarea = source.createEl("textarea", { cls: "vam-task-input vam-outline-text" });
    this.textarea.rows = 8;
    this.textarea.setAttr("aria-label", t("ui.outline_import_text_label"));
    this.textarea.addEventListener("input", () => this.refresh());
    this.preview = source.createDiv("vam-outline-preview");
    this.placementField();
    const research = this.contentEl.createDiv("vam-outline-section");
    const shallowLabel = research.createEl("label", { cls: "vam-outline-check" });
    this.shallow = shallowLabel.createEl("input", { type: "checkbox" });
    shallowLabel.createSpan({ text: t("ui.outline_import_shallow") });
    const researchOptions = research.createDiv("vam-outline-research-options");
    // The mode is a per-import choice (Quick first); unlike the research dialogs it is not remembered on the map.
    const mode = aiModeField(researchOptions, { initial: "quick" });
    this.mode = mode.value;
    this.setMode = mode.set;
    const model = modelField(researchOptions, this.models, t("ui.workspace_default"), this.links.repair);
    this.model = model.value;
    this.setModel = model.set;
    this.unwatch = model.dispose;
    const style = noteStyleField(researchOptions, {
      templates: this.templates,
      tones: this.tones,
      keepLabel: t("ui.note_style_use_default_0", this.defaultStyleLabel),
      templateDefault: t("ui.detail_template_use_workspace"),
      toneDefault: t("ui.tone_use_default"),
      manageTemplates: this.links.manageTemplates,
      manageTones: this.links.manageTones
    });
    this.template = style.templateId;
    this.tone = style.toneId;
    this.setStyle = style.set;
    const showOptions = (): void => researchOptions.toggleClass("is-hidden", !this.shallow.checked);
    this.shallow.addEventListener("change", showOptions);
    this.syncResearchOptions = showOptions;
    showOptions();
    const footer = modalActions(this);
    this.status = actionStatus(footer);
    footer.createEl("button", { text: t("ui.cancel") }).addEventListener("click", () => this.close());
    this.createButton = footer.createEl("button", { text: t("ui.outline_import_add"), cls: "mod-cta" });
    this.createButton.addEventListener("click", () => void this.submit());
    this.refresh();
    const prefill = this.generator?.prefill;
    if (prefill) this.restoreChoices(prefill.inputs);
    this.restoreResult();
  }

  /** The research choices of a run that started from this window, put back on a reopened one. */
  private restoreChoices(inputs: OutlineDraftInputs): void {
    this.shallow.checked = inputs.shallow;
    this.syncResearchOptions();
    this.setMode(inputs.mode);
    this.setModel(inputs.model);
    this.setStyle(inputs.template, inputs.tone);
  }

  /** "Put it in": a new map (default), this map as a new tree, or under the selected topic. */
  private placementField(): void {
    const section = this.contentEl.createDiv("vam-outline-section");
    section.createSpan({ text: t("ui.outline_import_placement"), cls: "vam-outline-label" });
    const group = section.createDiv("vam-outline-placement");
    group.setAttr("role", "radiogroup");
    group.setAttr("aria-label", t("ui.outline_import_placement"));
    const mapReason =
      this.target.map === "aim"
        ? t("ui.outline_import_placement_aim")
        : this.target.map === "none"
          ? t("ui.outline_import_placement_no_map")
          : null;
    const selected = this.target.selected;
    const options: { kind: OutlinePlacement["kind"]; text: string; reason: string | null }[] = [
      { kind: "tree", text: t("ui.outline_import_placement_tree"), reason: mapReason },
      {
        kind: "under",
        text: selected
          ? t("ui.outline_import_placement_under_named", selected.title)
          : t("ui.outline_import_placement_under"),
        reason: mapReason ?? (selected ? null : t("ui.outline_import_placement_no_selection"))
      }
    ];
    // The chosen option is marked with a class (no :has() selector needed).
    const marks: { label: HTMLElement; kind: OutlinePlacement["kind"] }[] = [];
    for (const option of options) {
      const label = group.createEl("label", {
        cls: `vam-outline-option${option.reason ? " is-disabled" : ""}${option.kind === this.placement ? " is-checked" : ""}`
      });
      marks.push({ label, kind: option.kind });
      const input = label.createEl("input", { type: "radio", value: option.kind });
      input.name = "vam-outline-placement";
      input.checked = option.kind === this.placement;
      input.disabled = option.reason !== null;
      input.addEventListener("change", () => {
        if (!input.checked) return;
        this.placement = option.kind;
        for (const mark of marks) mark.label.toggleClass("is-checked", mark.kind === this.placement);
      });
      const text = label.createDiv("vam-outline-option-text");
      text.createSpan({ text: option.text });
      if (option.reason) text.createSpan({ text: option.reason, cls: "vam-outline-placement-reason" });
    }
  }

  private placementRequest(): OutlinePlacement {
    if (this.placement === "under" && this.target.selected) return { kind: "under", parentId: this.target.selected.id };
    return { kind: "tree" };
  }

  onClose(): void {
    this.unwatch?.();
    this.unwatch = undefined;
    if (!this.detached) this.generation?.abort();
    this.generation = undefined;
    this.disarm?.();
  }

  /**
   * 「AI 生成大綱」: a topic, an outline preset (edit, save as, delete) and Generate. The result fills the outline
   * box below, where it is previewed and can be edited before anything is added.
   */
  private aiSection(parent: HTMLElement, generator: OutlineGenerator): void {
    const host = generator.presets;
    const language = host.settings.language;
    const custom = (): PromptPreset[] => host.settings.promptPresets ?? [];
    const presets = (): PromptPreset[] => listPresets(custom(), "outline", language);
    const section = parent.createEl("details", { cls: "vam-outline-ai" });
    section.createEl("summary", { text: t("ui.outline_ai_generate") });
    const topicLabel = section.createEl("label", { cls: "vam-field" });
    topicLabel.createSpan({ text: t("ui.outline_ai_topic") });
    const topic = topicLabel.createEl("input", { type: "text", value: generator.initialTopic ?? "" });
    topic.value = generator.initialTopic ?? "";
    topic.setAttr("aria-label", t("ui.outline_ai_topic"));
    const presetRow = section.createDiv("vam-outline-ai-preset");
    const presetLabel = presetRow.createEl("label", { cls: "vam-field" });
    presetLabel.createSpan({ text: t("ui.outline_ai_preset") });
    const select = presetLabel.createEl("select");
    select.setAttr("aria-label", t("ui.outline_ai_preset"));
    const edit = presetRow.createEl("button", { text: t("ui.preset_edit") });
    edit.setAttr("aria-expanded", "false");
    const remove = presetRow.createEl("button", { text: t("ui.preset_delete"), cls: "vam-danger-text" });
    const editor = section.createDiv("vam-outline-ai-editor");
    editor.hidden = true;
    const text = editor.createEl("textarea", { cls: "vam-outline-ai-text" });
    text.rows = 8;
    text.setAttr("aria-label", t("ui.outline_ai_preset_text"));
    editor.createEl("p", { cls: "vam-hint", text: t("ui.outline_ai_preset_text_hint") });
    const nameLabel = editor.createEl("label", { cls: "vam-field" });
    nameLabel.createSpan({ text: t("ui.outline_ai_preset_name") });
    const name = nameLabel.createEl("input", { type: "text" });
    name.setAttr("aria-label", t("ui.outline_ai_preset_name"));
    const editorActions = editor.createDiv("vam-outline-actions");
    const save = editorActions.createEl("button", { text: t("ui.save") });
    const saveAs = editorActions.createEl("button", { text: t("ui.outline_ai_save_as") });
    const generateRow = section.createDiv("vam-outline-ai-run");
    const generate = generateRow.createEl("button", { text: t("ui.outline_ai_run"), cls: "mod-cta" });
    const status = generateRow.createSpan({ cls: "vam-hint vam-outline-ai-status", attr: { "aria-live": "polite" } });
    const current = (): PromptPreset | undefined => presets().find(item => item.id === select.value);
    const prefill = generator.prefill;
    const fill = (selectedId: string): void => {
      select.empty();
      for (const preset of presets()) select.createEl("option", { value: preset.id, text: preset.name });
      select.value = presets().some(item => item.id === selectedId) ? selectedId : DEFAULT_OUTLINE_PRESET_ID;
      load();
    };
    const load = (): void => {
      const preset = current();
      text.value = preset?.text ?? "";
      name.value = preset ? (isBuiltinPreset(preset.id) ? t("ui.outline_ai_copy_name", preset.name) : preset.name) : "";
      const builtin = !preset || isBuiltinPreset(preset.id);
      remove.disabled = builtin;
      save.disabled = builtin;
    };
    const persist = async (next: PromptPreset[], selectedId: string, message: string): Promise<void> => {
      host.settings.promptPresets = next;
      await host.saveSettings();
      fill(selectedId);
      status.setText(message);
    };
    select.addEventListener("change", () => {
      load();
      status.setText("");
    });
    edit.addEventListener("click", () => {
      editor.hidden = !editor.hidden;
      edit.setAttr("aria-expanded", String(!editor.hidden));
    });
    save.addEventListener("click", () => {
      const preset = current();
      if (!preset || isBuiltinPreset(preset.id)) return;
      if (!name.value.trim()) return void status.setText(t("ui.preset_name_required"));
      void persist(
        updatePreset(custom(), preset.id, { name: name.value, text: text.value }),
        preset.id,
        t("ui.outline_ai_preset_saved")
      );
    });
    saveAs.addEventListener("click", () => {
      const { presets: next, created } = createPreset(custom(), {
        kind: "outline",
        name: name.value,
        text: text.value
      });
      if (!created) return void status.setText(t("ui.preset_name_required"));
      void persist(next, created.id, t("ui.outline_ai_preset_saved"));
    });
    this.disarm = armDiscard(
      remove,
      status,
      () => {
        const preset = current();
        if (!preset || isBuiltinPreset(preset.id)) return;
        void persist(deletePreset(custom(), preset.id), DEFAULT_OUTLINE_PRESET_ID, t("ui.outline_ai_preset_deleted"));
      },
      () => remove.disabled,
      { confirm: t("ui.outline_ai_delete_confirm"), hint: t("ui.outline_ai_delete_hint") }
    );
    generate.addEventListener("click", () => {
      if (this.generation) {
        this.generation.abort();
        return;
      }
      if (!topic.value.trim()) return void status.setText(t("error.outline_generate_empty_topic"));
      const controller = new AbortController();
      this.generation = controller;
      generate.setText(t("ui.outline_ai_stop"));
      status.setText(t("ui.outline_ai_running"));
      // Everything the window holds right now, kept by the host when AI starts so a reopened window matches it.
      const inputs = (): OutlineDraftInputs => {
        const model = this.model();
        const template = this.template();
        const tone = this.tone();
        return {
          topic: topic.value.trim(),
          presetId: select.value,
          presetText: text.value,
          placement: this.placement,
          target: this.target,
          shallow: this.shallow.checked,
          mode: this.mode(),
          ...(model ? { model } : {}),
          ...(template ? { template } : {}),
          ...(tone ? { tone } : {})
        };
      };
      // Unsaved edits in the preset box are used for this run only.
      void generator
        .generate({ topic: topic.value.trim(), presetText: text.value }, controller.signal, () => {
          // AI started: hide this window; the host owns the run from here (Stop is on its status bar).
          const snapshot = inputs();
          this.detached = true;
          this.close();
          return snapshot;
        })
        .then(markdown => {
          if (this.detached) return;
          if (controller.signal.aborted) throw new Error(t("ui.outline_ai_stopped"));
          this.textarea.value = sanitizeOutlineDraft(markdown).trimEnd();
          this.refresh();
          status.setText(t("ui.outline_ai_filled", this.nodes.length));
        })
        .catch(error => {
          if (this.detached || this.generation !== controller) return;
          status.setText(controller.signal.aborted ? t("ui.outline_ai_stopped") : messageOf(error));
        })
        .finally(() => {
          if (this.detached || this.generation !== controller) return;
          this.generation = undefined;
          generate.setText(t("ui.outline_ai_run"));
        });
    });
    fill(prefill?.inputs.presetId ?? DEFAULT_OUTLINE_PRESET_ID);
    if (prefill) {
      section.open = true;
      topic.value = prefill.inputs.topic;
      // Preset edits that were never saved come back as they were typed.
      text.value = prefill.inputs.presetText;
      // The outline box is built after this section, so the result is put in once the window is complete.
      this.restoreResult = () => {
        if (prefill.markdown !== undefined) {
          this.textarea.value = sanitizeOutlineDraft(prefill.markdown).trimEnd();
          this.refresh();
          status.setText(t("ui.outline_ai_filled", this.nodes.length));
        } else if (prefill.message) status.setText(prefill.message);
      };
    }
  }

  private issueText(issue: OutlineIssue): string {
    return t(issue.key, ...issue.values);
  }

  private refresh(): void {
    this.preview.empty();
    const text = this.textarea.value;
    if (!text.trim()) {
      this.nodes = [];
      this.preview.createEl("p", { text: t("ui.outline_import_preview_empty"), cls: "vam-hint" });
      this.createButton.disabled = true;
      this.status.setText("");
      return;
    }
    const parse = parseOutline(text);
    this.nodes = parse.errors.length ? [] : parse.nodes;
    for (const issue of parse.errors)
      this.preview.createEl("p", { text: this.issueText(issue), cls: "vam-outline-error" });
    for (const issue of parse.warnings) this.preview.createEl("p", { text: this.issueText(issue), cls: "vam-hint" });
    if (!parse.errors.length) {
      const depth = new Map<number, number>();
      for (const node of parse.nodes) depth.set(node.index, node.parent === null ? 1 : depth.get(node.parent)! + 1);
      this.preview.createEl("p", {
        text: t("ui.outline_import_preview_count", parse.nodes.length, Math.max(...depth.values()))
      });
      const list = this.preview.createDiv("vam-outline-tree");
      for (const node of parse.nodes)
        list
          .createDiv({ cls: `vam-outline-row vam-outline-depth-${Math.min(depth.get(node.index)!, 6)}` })
          .setText(node.title);
    }
    this.createButton.disabled = this.submitting || !!parse.errors.length;
    this.status.setText("");
  }

  private async submit(): Promise<void> {
    if (this.submitting || !this.nodes.length) return;
    this.submitting = true;
    this.createButton.disabled = true;
    try {
      const shallowResearch = this.shallow.checked;
      const model = shallowResearch ? this.model() : undefined;
      const detailTemplateId = shallowResearch ? this.template() : undefined;
      const toneId = shallowResearch ? this.tone() : undefined;
      await this.create({
        nodes: this.nodes,
        placement: this.placementRequest(),
        source: null,
        shallowResearch,
        ...(shallowResearch ? { aiMode: this.mode() } : {}),
        ...(model ? { model } : {}),
        ...(detailTemplateId ? { detailTemplateId } : {}),
        ...(toneId ? { toneId } : {})
      });
      this.close();
    } catch (error) {
      // The dialog stays open with the outline; the reason sits next to the button.
      this.submitting = false;
      this.refresh();
      this.status.setText(messageOf(error));
    }
  }
}
