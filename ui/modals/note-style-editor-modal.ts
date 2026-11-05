import { Component, MarkdownRenderer, Modal, Notice, Setting, type App } from "obsidian";
import type VisualAgentMapPlugin from "../../main";
import { t, type TranslationKey } from "../../i18n";
import type { RecipeListItem } from "../../ai/note-style-store";
import {
  KIND_DEFAULT_RECIPE,
  STYLE_KINDS,
  UPDATE_MODES,
  UPDATE_MODE_KEYS,
  validatePartName,
  type NameCategory,
  type StyleKind,
  type UpdateMode
} from "../../ai/note-style-recipe";
import { CARD_VOICES } from "../../ai/note-style-card-voices";
import {
  composeStructure,
  rowsOf,
  sameRows,
  splitStructure,
  type SectionRow,
  type StructureChunks
} from "../../ai/note-style-structure-edit";
import { parseTemplateBlock } from "../../core/blocks/template-block";
import { cleanBlockName } from "../../core/blocks/block-files";
import { renderRadioGroup } from "../radio-group";
import { ChoiceModal } from "./choice-modal";
import { openInWindowOf } from "./open-in-window";
import { modalActions } from "./action-bar";

const lower = (value: string): string => value.toLocaleLowerCase();

/** Why `value` cannot be the name of a new file of `category`; "" when it can. `taken` holds the names in use, lower case. */
export function namePartProblem(value: string, category: NameCategory, taken: ReadonlySet<string>): string {
  if (!value) return t("ui.name_required");
  const check = validatePartName(value, category);
  if (!check.ok) {
    const keys: Record<string, TranslationKey> = {
      empty: "ui.name_required",
      padded: "ui.manage_name_padded",
      separator: "ui.manage_name_separator",
      dots: "ui.manage_name_dots",
      builtin: "ui.manage_name_builtin"
    };
    return t(keys[check.reason] ?? "ui.manage_name_unsafe");
  }
  if (cleanBlockName(value) !== value) return t("ui.manage_name_unsafe");
  if (taken.has(lower(value))) return t("ui.manage_name_taken");
  return "";
}

/** The name a copy of a style gets by default: "My <name>" (or "New style" for a blank one), " (2)", " (3)" ... until it is free. */
export function suggestRecipeName(plugin: VisualAgentMapPlugin, from: string | null): string {
  const base = cleanBlockName(
    from === null ? t("ui.recipe_new_name") : t("ui.block_copy_name_0", cleanBlockName(from))
  );
  const taken = takenRecipeNames(plugin);
  let name = base || "copy";
  for (let n = 2; taken.has(lower(name)) || !validatePartName(name, "recipe").ok; n++) {
    if (n > 999) break;
    name = `${base || "copy"} (${n})`;
  }
  return name;
}

function takenRecipeNames(plugin: VisualAgentMapPlugin): Set<string> {
  return new Set(
    plugin.noteStyles
      .listRecipes()
      .filter(item => item.kind === "file")
      .map(item => lower(item.name))
  );
}

const UPDATE_DESC_KEYS: Record<UpdateMode, TranslationKey> = {
  merge: "ui.editor_update_desc_merge",
  top: "ui.editor_update_desc_top",
  fresh: "ui.editor_update_desc_fresh"
};

export interface NoteStyleEditorOptions {
  /** The style to edit (`file:<name>` changes that file, `builtin:<id>` is saved as a new file), or null for a new style. */
  source: string | null;
  /** A new style starts as a copy of this style's four values; without it, as the general research style. */
  from?: string | null;
  /** The name to start with (a new style, or a copy of a built-in one). */
  name?: string;
  /** Gets the focus back when the window closes. */
  trigger?: HTMLElement;
  /** Called after a successful save, once the window is closed. */
  onSaved?: (ref: string) => void;
  /** Called when the window closes, saved or not. */
  onClosed?: () => void;
}

interface Draft {
  name: string;
  rows: SectionRow[];
  voice: string;
  update: UpdateMode;
  /** Also make the chosen voice the global one (the other topic types follow it, except those that set their own). */
  applyAll: boolean;
}

/**
 * Text made plain in Markdown: every ASCII punctuation character is escaped, so the words of a part file (section
 * names, descriptions) or a style cannot become a link, a tag, a wiki link, a highlight or any other markup in the sample.
 */
const plainMd = (value: string): string =>
  value
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[!-/:-@[-`{-~]/g, "\\$&");

const EXAMPLE_DELAY_MS = 200;

/**
 * The window "Edit note style": a name, the sections (added, removed, moved and renamed here, no file is opened), the
 * voice (chips with a sample sentence), the update mode, a sample note that follows the choices (no AI), and a preview of
 * the AI instructions. Opening it reads; the only write is Save, which writes the style (and the sections when they
 * changed) and, when asked, the global voice. Cancel leaves nothing behind.
 */
export class NoteStyleEditorModal extends Modal {
  private draft: Draft;
  private readonly initial: { name: string; rows: SectionRow[]; voice: string; update: UpdateMode };
  private readonly existing: { ref: string; text: string } | undefined;
  /** The built-in style this window was opened on: the topic types that use it switch to the saved file (decision #41). */
  private readonly builtinSource: string | undefined;
  /** The structure the style uses (as opened), the text the sections were read from, and its sections cut apart. */
  private readonly structureRef: string;
  private baseText: string;
  private chunks: StructureChunks;
  /** The voice the style had when the window opened, and whether the source wrote its own voice and format keys. */
  private readonly voiceKey: boolean;
  private readonly formatRef: string | null;
  private readonly component = new Component();
  /** The child that owns the sample on screen now; the next picture replaces it, so the children do not pile up. */
  private exampleChild?: Component;
  private closed = false;
  private forceClose = false;
  private asking = false;
  private saving = false;
  private timer: number | undefined;
  private renderToken = 0;
  private nameInput?: HTMLInputElement;
  private errorEl?: HTMLElement;
  private exampleEl?: HTMLElement;
  private listEl?: HTMLElement;
  private voiceEl?: HTMLElement;
  private saveButton?: HTMLButtonElement;
  private updateRadios = new Map<UpdateMode, HTMLInputElement>();
  private focusWindow?: Window;
  private readonly onFocus = (): void => void this.reload();

  constructor(
    app: App,
    private plugin: VisualAgentMapPlugin,
    private options: NoteStyleEditorOptions
  ) {
    super(app);
    const store = plugin.noteStyles;
    const source = options.source;
    const recipes = store.listRecipes();
    const byRef = (ref: string | null | undefined): RecipeListItem | undefined =>
      recipes.find(item => item.ref === ref);
    const base: RecipeListItem | undefined =
      byRef(source ?? options.from ?? undefined) ?? byRef(KIND_DEFAULT_RECIPE.topic) ?? recipes[0];
    const sourceItem = byRef(source);
    const isFile = sourceItem?.kind === "file";
    this.existing = isFile ? { ref: sourceItem.ref, text: store.recipeText(sourceItem.ref) ?? "" } : undefined;
    this.builtinSource = sourceItem?.kind === "builtin" ? sourceItem.ref : undefined;
    const name = isFile
      ? sourceItem.name
      : (options.name ??
        suggestRecipeName(plugin, sourceItem ? sourceItem.name : base && options.from ? base.name : null));
    this.structureRef = base?.structure.ref ?? "builtin:standard";
    // A structure that cannot be read (a file that is gone) shows the Standard sections; saving without a change keeps the ref.
    const language = plugin.settings.language;
    try {
      this.baseText = store.partSourceText("structure", this.structureRef, language);
    } catch {
      this.baseText = store.partSourceText("structure", "builtin:standard", language);
    }
    this.chunks = splitStructure(this.baseText);
    this.voiceKey = base?.voiceSource === "style";
    this.formatRef = base?.formatSource === "style" ? base.format.ref : null;
    const voice = base?.voice.ref ?? store.globalPartRef("voice");
    this.draft = { name, rows: rowsOf(this.chunks), voice, update: base?.update ?? "merge", applyAll: false };
    this.initial = { name, rows: rowsOf(this.chunks), voice, update: this.draft.update };
  }

  onOpen(): void {
    this.component.load();
    const { contentEl } = this;
    this.modalEl.addClass("vam-editor-modal");
    this.titleEl.setText(t(this.options.source ? "ui.editor_title_edit" : "ui.editor_title_new"));

    const nameRow = new Setting(contentEl).setName(t("ui.editor_name"));
    nameRow.settingEl.addClass("vam-editor-row");
    nameRow.addText(text => {
      const input = text.inputEl;
      this.nameInput = input;
      input.value = this.draft.name;
      input.setAttr("aria-label", t("ui.editor_name"));
      input.setAttr("aria-describedby", "vam-editor-error");
      if (this.existing) {
        input.readOnly = true;
        input.setAttr("readonly", "readonly");
        nameRow.setDesc(t("ui.editor_name_fixed"));
      }
      text.onChange(value => {
        this.draft.name = value;
        this.changed();
      });
    });
    this.errorEl = contentEl.createDiv({
      cls: "vam-block-status-error vam-editor-error",
      attr: { id: "vam-editor-error", "aria-live": "polite" }
    });

    const sections = contentEl.createDiv({ cls: "vam-editor-sections" });
    sections.createEl("p", {
      text: t("ui.editor_sections_label"),
      cls: "vam-style-card-label",
      attr: { id: "vam-editor-sections-label" }
    });
    this.listEl = sections.createDiv({
      cls: "vam-editor-section-list",
      attr: { role: "group", "aria-labelledby": "vam-editor-sections-label" }
    });
    this.drawRows();
    const add = sections.createEl("button", { text: `＋ ${t("ui.editor_section_add")}`, attr: { type: "button" } });
    add.addEventListener("click", () => this.addRow());
    sections.createEl("p", { text: t("ui.editor_sections_hint"), cls: "setting-item-description" });

    this.voiceEl = contentEl.createDiv({ cls: "vam-editor-voice" });
    this.drawVoice();

    const fieldset = contentEl.createEl("fieldset", { cls: "vam-editor-update" });
    fieldset.createEl("legend", { text: t("ui.editor_update_legend") });
    for (const mode of UPDATE_MODES) {
      const id = `vam-editor-update-${mode}`;
      const line = fieldset.createDiv({ cls: "vam-editor-mode" });
      const radio = line.createEl("input", {
        type: "radio",
        attr: { name: "vam-editor-update", id, "aria-describedby": `${id}-desc` }
      });
      radio.checked = this.draft.update === mode;
      radio.addEventListener("change", () => {
        if (!radio.checked) return;
        this.draft.update = mode;
        this.changed();
      });
      this.updateRadios.set(mode, radio);
      const text = line.createDiv({ cls: "vam-editor-mode-text" });
      text.createEl("label", { text: t(UPDATE_MODE_KEYS[mode]), attr: { for: id } });
      text.createDiv({ text: t(UPDATE_DESC_KEYS[mode]), cls: "setting-item-description", attr: { id: `${id}-desc` } });
    }

    contentEl.createEl("p", { text: t("ui.editor_example_caption"), cls: "setting-item-description" });
    this.exampleEl = contentEl.createDiv({
      cls: "vam-editor-example markdown-rendered",
      attr: { role: "region", "aria-label": t("ui.editor_example_label") }
    });

    const actions = modalActions(this);
    const applyLine = actions.createEl("label", { cls: "vam-editor-apply" });
    const apply = applyLine.createEl("input", { type: "checkbox", attr: { id: "vam-editor-apply-all" } });
    apply.addEventListener("change", () => {
      this.draft.applyAll = apply.checked;
      this.changed();
    });
    applyLine.createSpan({ text: t("ui.editor_apply_all") });
    const preview = actions.createEl("button", { text: t("ui.preview_prompt_open") });
    preview.addEventListener("click", () => void this.previewPrompt(preview));
    const cancel = actions.createEl("button", { text: t("ui.cancel") });
    cancel.addEventListener("click", () => this.close());
    this.saveButton = actions.createEl("button", { text: t("ui.save"), cls: "mod-cta" });
    this.saveButton.addEventListener("click", () => void this.save());

    this.syncState();
    void this.drawExample();
    // Another window (a file tab) may have changed the part files: read them again when this one is back in front.
    const win = (contentEl as { win?: Window }).win ?? contentEl.ownerDocument?.defaultView ?? undefined;
    if (win && typeof win.addEventListener === "function") {
      this.focusWindow = win;
      win.addEventListener("focus", this.onFocus);
    }
    (this.existing ? this.listEl.querySelector("input") : this.nameInput)?.focus();
  }

  onClose(): void {
    this.closed = true;
    if (this.timer !== undefined) window.clearTimeout(this.timer);
    this.timer = undefined;
    this.focusWindow?.removeEventListener("focus", this.onFocus);
    this.component.unload();
    this.contentEl.empty();
    const trigger = this.options.trigger;
    if (trigger?.isConnected !== false) trigger?.focus();
    this.options.onClosed?.();
  }

  /** A window with unsaved changes asks before it closes (Escape and the close button come here too). */
  close(): void {
    if (this.forceClose || this.closed || !this.isDirty()) {
      super.close();
      return;
    }
    if (this.asking) return;
    this.asking = true;
    const ask = new ChoiceModal(
      this.app,
      t("ui.editor_discard_title"),
      t("ui.editor_discard_desc"),
      [
        {
          label: t("ui.editor_discard"),
          warning: true,
          action: () => {
            this.asking = false;
            this.forceClose = true;
            super.close();
          }
        }
      ],
      () => {
        this.asking = false;
      }
    );
    openInWindowOf(ask, this.modalEl);
  }

  private isDirty(): boolean {
    const a = this.draft;
    const b = this.initial;
    const rows = this.cleanRows();
    return (
      a.name !== b.name ||
      a.voice !== b.voice ||
      a.update !== b.update ||
      a.applyAll ||
      rows.length !== b.rows.length ||
      rows.some((row, index) => row.origin !== b.rows[index].origin || row.name !== b.rows[index].name)
    );
  }

  // ---- the sections ----

  /** The rows with their names trimmed, which is how the parser reads them back. */
  private cleanRows(): SectionRow[] {
    return this.draft.rows.map(row => ({ origin: row.origin, name: row.name.trim() }));
  }

  /** Whether the sections are not what the text had (a new file or a change in place is needed). */
  private sectionsEdited(): boolean {
    return !sameRows(this.chunks, this.cleanRows());
  }

  /** The reason the sections cannot be saved, or "" (an empty list, a name used twice, a name with # ...). */
  private sectionProblem(): string {
    if (!this.sectionsEdited()) return "";
    const rows = this.cleanRows();
    const parsed = parseTemplateBlock(composeStructure(this.chunks, rows), { id: "file:draft", name: "draft" });
    const say = (text: string): string => t("ui.editor_sections_problem_0", text);
    if (!parsed.ok) {
      const first = parsed.issues[0];
      if (!first.code.startsWith("ui.")) return say(first.message);
      const values = first.values.map(value =>
        String(value).startsWith("ui.") ? t(String(value) as TranslationKey) : String(value)
      );
      return say(t(first.code as TranslationKey, ...values));
    }
    const names = parsed.template.sections.map(section => section.name);
    const wrong = rows.findIndex((row, index) => names[index] !== row.name);
    if (wrong >= 0 || names.length !== rows.length)
      return say(t("ui.detail_template_error_section_name_invalid", String(Math.max(wrong, 0) + 1)));
    return "";
  }

  private freshSectionName(): string {
    const taken = new Set(this.draft.rows.map(row => lower(row.name.trim())));
    for (let n = 1; ; n++) {
      const name = t("ui.editor_section_new_name_0", String(n));
      if (!taken.has(lower(name)) || n > 999) return name;
    }
  }

  private addRow(): void {
    this.draft.rows.push({ origin: null, name: this.freshSectionName() });
    this.drawRows({ index: this.draft.rows.length - 1, control: "name" });
    this.changed();
  }

  private moveRow(index: number, step: -1 | 1): void {
    const rows = this.draft.rows;
    const to = index + step;
    if (to < 0 || to >= rows.length) return;
    [rows[index], rows[to]] = [rows[to], rows[index]];
    this.drawRows({ index: to, control: step < 0 ? "up" : "down" });
    this.changed();
  }

  private removeRow(index: number): void {
    this.draft.rows.splice(index, 1);
    this.drawRows({ index: Math.min(index, this.draft.rows.length - 1), control: "remove" });
    this.changed();
  }

  /** Draws the section list again; the focus goes to `focus` (a row's control), or to the nearest one that still works. */
  private drawRows(focus?: { index: number; control: "name" | "up" | "down" | "remove" }): void {
    const list = this.listEl;
    if (!list) return;
    list.empty();
    const rows = this.draft.rows;
    const controls: Record<"name" | "up" | "down" | "remove", HTMLElement>[] = [];
    rows.forEach((row, index) => {
      const line = list.createDiv({ cls: "vam-editor-section" });
      const input = line.createEl("input", { type: "text", cls: "vam-editor-section-name" });
      input.value = row.name;
      const button = (text: string, key: "up" | "down" | "remove", cls: string, run: () => void): HTMLButtonElement => {
        const el = line.createEl("button", { text, cls, attr: { type: "button" } });
        el.addEventListener("click", run);
        return el;
      };
      const up = button("↑", "up", "vam-editor-section-up", () => this.moveRow(index, -1));
      const down = button("↓", "down", "vam-editor-section-down", () => this.moveRow(index, 1));
      const remove = button("−", "remove", "vam-editor-section-remove", () => this.removeRow(index));
      up.disabled = index === 0;
      down.disabled = index === rows.length - 1;
      const label = (): void => {
        const name = row.name.trim() || String(index + 1);
        input.setAttr("aria-label", t("ui.editor_section_name_aria_0", String(index + 1)));
        up.setAttr("aria-label", t("ui.editor_section_up_aria_0", name));
        down.setAttr("aria-label", t("ui.editor_section_down_aria_0", name));
        remove.setAttr("aria-label", t("ui.editor_section_remove_aria_0", name));
      };
      label();
      input.addEventListener("input", () => {
        row.name = input.value;
        label();
        this.changed();
      });
      controls.push({ name: input, up, down, remove });
    });
    if (!focus) return;
    const row = controls[focus.index];
    if (!row) return;
    const usable = (el: HTMLElement): boolean => !(el as HTMLButtonElement).disabled;
    // A button that has become unavailable (the first row's "up") hands the focus to its opposite, else to the name.
    const order: ("name" | "up" | "down" | "remove")[] =
      focus.control === "up"
        ? ["up", "down", "name"]
        : focus.control === "down"
          ? ["down", "up", "name"]
          : [focus.control, "name"];
    const target = order.map(key => row[key]).find(usable) ?? row.name;
    target.focus();
  }

  // ---- the voice ----

  /** Draws the voice chips and the sample sentence under them; `focus` puts the focus back on the chip just picked. */
  private drawVoice(focus?: string): void {
    const box = this.voiceEl;
    if (!box) return;
    box.empty();
    const choices = CARD_VOICES.map(item => ({ value: `builtin:${item.id}`, label: t(item.name) }));
    const buttons = renderRadioGroup(
      box,
      t("ui.note_style_voice_label"),
      choices,
      this.draft.voice,
      value => {
        this.draft.voice = value;
        this.drawVoice(value);
        this.changed();
      },
      "vam-editor-radio"
    );
    if (focus) buttons[choices.findIndex(choice => choice.value === focus)]?.focus();
    const sample = box.createDiv({ cls: "vam-style-sample", attr: { "aria-live": "polite" } });
    const chosen = CARD_VOICES.find(item => `builtin:${item.id}` === this.draft.voice);
    if (chosen) {
      sample.createSpan({ text: t("ui.note_style_sample_caption"), cls: "vam-style-sample-caption" });
      sample.createSpan({ text: t(chosen.sample) });
    } else sample.createSpan({ text: t("ui.note_style_voice_other_0", this.voiceName()) });
  }

  private voiceName(): string {
    const ref = this.draft.voice;
    return this.plugin.noteStyles.listParts("voice").find(part => part.ref === ref)?.name ?? ref;
  }

  /**
   * The voice key to write: none when the style follows the global voice. A voice that was not touched is written as the
   * source had it (its own key or none); a chosen voice is written only when it differs from the global one; "also use it
   * for the other types" makes it the global voice, so no key is needed.
   */
  private voiceToWrite(): string | null {
    if (this.draft.applyAll) return null;
    if (this.draft.voice === this.initial.voice) return this.voiceKey ? this.draft.voice : null;
    return this.draft.voice === this.plugin.noteStyles.globalPartRef("voice") ? null : this.draft.voice;
  }

  private takenNames(): Set<string> {
    return takenRecipeNames(this.plugin);
  }

  private nameProblem(): string {
    return this.existing ? "" : namePartProblem(this.draft.name, "recipe", this.takenNames());
  }

  /** Writes the error (only when its text changes) and enables or disables Save. */
  private syncState(): void {
    const problem = this.nameProblem() || this.sectionProblem();
    const error = this.errorEl;
    if (error && error.textContent !== problem) error.setText(problem);
    if (this.saveButton) this.saveButton.disabled = !!problem || this.saving;
  }

  private changed(): void {
    this.syncState();
    this.scheduleExample();
  }

  /** The style the draft stands for, for the sample and the preview (the edited sections stand in for the structure). */
  private draftStyle(): ReturnType<VisualAgentMapPlugin["noteStyles"]["draftStyle"]> {
    return this.plugin.noteStyles.draftStyle(
      {
        name: this.draft.name || t("ui.recipe_new_name"),
        structure: this.structureRef,
        voice: this.draft.voice,
        ...(this.formatRef !== null ? { format: this.formatRef } : {}),
        update: this.draft.update,
        ...(this.sectionsEdited() ? { structureText: composeStructure(this.chunks, this.cleanRows()) } : {})
      },
      "topic",
      this.plugin.settings.language
    );
  }

  /** The window is in front again: read the files again and redraw what depends on them. */
  private async reload(): Promise<void> {
    await this.plugin.noteStyles.refresh().catch(() => undefined);
    if (this.closed) return;
    // Sections that were not touched follow the file; edited ones stay, and Save checks the file still holds the old text.
    if (!this.sectionsEdited()) {
      try {
        const text = this.plugin.noteStyles.partSourceText(
          "structure",
          this.structureRef,
          this.plugin.settings.language
        );
        if (text !== this.baseText) {
          this.baseText = text;
          this.chunks = splitStructure(text);
          this.draft.rows = rowsOf(this.chunks);
          this.initial.rows = rowsOf(this.chunks);
          this.drawRows();
        }
      } catch {
        // the structure is gone: the sections already shown stay
      }
    }
    this.drawVoice();
    this.syncState();
    this.scheduleExample();
  }

  // ---- the sample note ----

  private scheduleExample(): void {
    if (this.closed) return;
    if (this.timer !== undefined) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = undefined;
      void this.drawExample();
    }, EXAMPLE_DELAY_MS);
  }

  /** The sample as Markdown: the structure's section names and descriptions with fixed sample text, shaped by the format rules. */
  exampleMarkdown(): string {
    const style = this.draftStyle();
    const formatRef = this.formatRef ?? this.plugin.noteStyles.globalPartRef("format");
    const formatId = formatRef.startsWith("builtin:") ? formatRef.slice("builtin:".length) : undefined;
    const formatName =
      this.plugin.noteStyles.listParts("format").find(part => part.ref === formatRef)?.name ?? formatRef;
    const lines: string[] = [
      `*${plainMd(t("ui.editor_example_voice_0", this.voiceName()))}* · *${plainMd(t("ui.editor_example_format_0", formatName))}*`,
      ""
    ];
    const callout = (title: string): string[] => [
      `> [!note] ${plainMd(title)}`,
      `> ${plainMd(t("ui.editor_example_callout"))}`,
      ""
    ];
    const table = [
      `| ${plainMd(t("ui.editor_example_col_a"))} | ${plainMd(t("ui.editor_example_col_b"))} |`,
      "| --- | --- |",
      `| ${plainMd(t("ui.editor_example_cell_a"))} | ${plainMd(t("ui.editor_example_cell_b"))} |`,
      ""
    ];
    for (const [index, section] of style.template.sections.entries()) {
      const heading = plainMd(section.name);
      lines.push(`## ${heading}`, "");
      const hint = plainMd(section.description);
      if (formatId === "lean") {
        if (hint) lines.push(`- ${hint}`);
        lines.push(
          `- ${plainMd(t("ui.editor_example_bullet_a"))}`,
          `- ${plainMd(t("ui.editor_example_bullet_b"))}`,
          ""
        );
        continue;
      }
      if (hint) lines.push(hint, "");
      lines.push(plainMd(t("ui.editor_example_body")), "");
      if (formatId === "rich") lines.push(...(index % 2 === 0 ? callout(section.name) : table));
      else if (index === 0) lines.push(...callout(section.name));
    }
    return lines.join("\n");
  }

  private async drawExample(): Promise<void> {
    const host = this.exampleEl;
    if (!host || this.closed) return;
    const token = ++this.renderToken;
    const markdown = this.exampleMarkdown();
    // The new picture is drawn beside the old one and replaces it when it is ready, so the sample never flashes empty.
    const next = host.createDiv({ cls: "vam-editor-example-body" });
    const child = new Component();
    this.component.addChild(child);
    try {
      await MarkdownRenderer.render(this.app, markdown, next, "", child);
    } catch {
      next.remove();
      this.component.removeChild(child);
      return;
    }
    if (this.closed || token !== this.renderToken) {
      next.remove();
      this.component.removeChild(child);
      return;
    }
    for (const old of Array.from(host.children)) if (old !== next) old.remove();
    if (this.exampleChild) this.component.removeChild(this.exampleChild);
    this.exampleChild = child;
  }

  // ---- preview and save ----

  private async previewPrompt(button: HTMLElement): Promise<void> {
    // The part files may have been edited in a tab since they were read: read them again before the draft is built.
    await this.plugin.noteStyles.refresh().catch(() => undefined);
    if (this.closed) return;
    this.plugin.openPromptPreview(button, () => this.draftStyle());
  }

  /** The topic types (not AIM, not the ones that use `ref`) whose style sets its own voice: "also use it" does not change them. */
  private kindsWithOwnVoice(ref: string): StyleKind[] {
    const recipes = this.plugin.noteStyles.listRecipes();
    return STYLE_KINDS.filter(kind => kind !== "aim").filter(kind => {
      const item = recipes.find(candidate => candidate.usedByKinds.includes(kind));
      return item !== undefined && item.ref !== ref && item.voiceSource === "style";
    });
  }

  private async save(): Promise<void> {
    if (this.saving || this.closed) return;
    if (this.nameProblem() || this.sectionProblem()) {
      this.syncState();
      return;
    }
    this.saving = true;
    this.syncState();
    try {
      const switched: StyleKind[] = this.builtinSource
        ? [
            ...(this.plugin.noteStyles.listRecipes().find(item => item.ref === this.builtinSource)?.usedByKinds ?? [])
          ].filter(kind => kind !== "aim")
        : [];
      const result = await this.plugin.saveNoteRecipe({
        name: this.draft.name,
        structure: this.structureRef,
        voice: this.voiceToWrite(),
        format: this.formatRef,
        update: this.draft.update,
        ...(this.sectionsEdited()
          ? { structureEdit: { text: composeStructure(this.chunks, this.cleanRows()), base: this.baseText } }
          : {}),
        ...(this.existing ? { original: this.existing } : {})
      });
      if (this.closed) return;
      if (!result.ok) {
        // "changed" leaves the window open: nothing was written, and the notice says to reopen the file.
        if (result.reason === "name") this.errorEl?.setText(t("ui.recipe_notice_name_unavailable"));
        return;
      }
      const kindName = (kind: StyleKind): string =>
        t(kind === "aim" ? "ui.note_style_kind_aim" : `ui.topic_kind_${kind}`);
      if (switched.length) {
        for (const kind of switched) await this.plugin.setKindStyle(kind, result.ref);
        new Notice(
          t(
            "ui.recipe_notice_switched_0_1",
            result.ref.slice("file:".length),
            switched.map(kindName).join(t("ui.manage_list_separator"))
          )
        );
      }
      if (this.draft.applyAll) {
        const kept = this.kindsWithOwnVoice(result.ref);
        await this.plugin.setGlobalPart("voice", this.draft.voice);
        new Notice(t("ui.editor_apply_notice_0", this.voiceName()));
        if (kept.length)
          new Notice(t("ui.editor_apply_kept_0", kept.map(kindName).join(t("ui.manage_list_separator"))));
      }
      this.forceClose = true;
      super.close();
      this.options.onSaved?.(result.ref);
    } finally {
      this.saving = false;
      if (!this.closed) this.syncState();
    }
  }
}
