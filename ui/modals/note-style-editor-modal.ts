import { Component, MarkdownRenderer, Modal, Notice, Setting, type App } from "obsidian";
import type VisualAgentMapPlugin from "../../main";
import { t, type TranslationKey } from "../../i18n";
import type { PartListItem, RecipeListItem } from "../../ai/note-style-store";
import {
  KIND_DEFAULT_RECIPE,
  UPDATE_MODES,
  UPDATE_MODE_KEYS,
  validatePartName,
  type NameCategory,
  type PartCategory,
  type StyleKind,
  type UpdateMode
} from "../../ai/note-style-recipe";
import { cleanBlockName } from "../../core/blocks/block-files";
import { ChoiceModal } from "./choice-modal";
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

const PART_CATEGORIES: readonly PartCategory[] = ["structure", "voice", "format"];
const PART_LABEL_KEYS: Record<PartCategory, TranslationKey> = {
  structure: "ui.editor_part_structure",
  voice: "ui.editor_part_voice",
  format: "ui.editor_part_format"
};
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
  structure: string;
  voice: string;
  format: string;
  update: UpdateMode;
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
 * The window "Edit note style": a name, the structure, voice and format rules (each a list with an Edit button), the
 * update mode, a sample note that follows the choices (no AI), and a preview of the AI instructions. Opening it reads;
 * the only write is Save (and Edit on a built-in part, which saves it as the user's own file first).
 */
export class NoteStyleEditorModal extends Modal {
  private draft: Draft;
  private readonly initial: Draft;
  private readonly existing: { ref: string; text: string } | undefined;
  /** The built-in style this window was opened on: the topic types that use it switch to the saved file (decision #41). */
  private readonly builtinSource: string | undefined;
  private readonly component = new Component();
  /** The child that owns the sample on screen now; the next picture replaces it, so the children do not pile up. */
  private exampleChild?: Component;
  private closed = false;
  private forceClose = false;
  private asking = false;
  private busy = false;
  private saving = false;
  private timer: number | undefined;
  private renderToken = 0;
  private selects = new Map<PartCategory, HTMLSelectElement>();
  private nameInput?: HTMLInputElement;
  private errorEl?: HTMLElement;
  private exampleEl?: HTMLElement;
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
    const parts = {
      structure: base?.structure.ref ?? "builtin:standard",
      voice: base?.voice.ref ?? "builtin:academic",
      format: base?.format.ref ?? "builtin:standard",
      update: base?.update ?? "merge"
    };
    const sourceItem = byRef(source);
    const isFile = sourceItem?.kind === "file";
    this.existing = isFile ? { ref: sourceItem.ref, text: store.recipeText(sourceItem.ref) ?? "" } : undefined;
    this.builtinSource = sourceItem?.kind === "builtin" ? sourceItem.ref : undefined;
    const name = isFile
      ? sourceItem.name
      : (options.name ??
        suggestRecipeName(plugin, sourceItem ? sourceItem.name : base && options.from ? base.name : null));
    this.draft = { name, ...parts };
    this.initial = { ...this.draft };
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

    for (const category of PART_CATEGORIES) {
      const label = t(PART_LABEL_KEYS[category]);
      const row = new Setting(contentEl).setName(label);
      row.settingEl.addClass("vam-editor-row");
      row.addDropdown(dropdown => {
        this.selects.set(category, dropdown.selectEl);
        dropdown.selectEl.setAttr("aria-label", label);
        dropdown.onChange(value => {
          this.draft[category] = value;
          this.changed();
        });
      });
      row.addButton(button => {
        button.setButtonText(t("ui.manage_edit")).onClick(() => void this.editPart(category, button.buttonEl));
        button.buttonEl.setAttr("aria-label", t("ui.manage_edit_aria_0", label));
      });
    }
    this.fillSelects();

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
    (this.existing ? this.selects.get("structure") : this.nameInput)?.focus();
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
    new ChoiceModal(
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
    ).open();
  }

  private isDirty(): boolean {
    const a = this.draft;
    const b = this.initial;
    return (
      a.name !== b.name ||
      a.structure !== b.structure ||
      a.voice !== b.voice ||
      a.format !== b.format ||
      a.update !== b.update
    );
  }

  // ---- the choices ----

  /** Fills the three lists from the parts that exist now, keeping each choice (one that is gone stays as "Not found"). */
  private fillSelects(): void {
    const store = this.plugin.noteStyles;
    for (const category of PART_CATEGORIES) {
      const select = this.selects.get(category);
      if (!select) continue;
      const items = store.listParts(category).filter(item => !item.issues.some(issue => issue.code === "builtin_name"));
      select.replaceChildren();
      const current = this.draft[category];
      if (!items.some(item => item.ref === current)) {
        const bare = current.replace(/^(?:file|builtin):/, "");
        select.createEl("option", { value: current, text: t("ui.block_missing_option_0", bare) });
      }
      const optionText = (item: PartListItem): string =>
        item.issues.length ? t("ui.note_style_unusable_option_0", item.name) : item.name;
      const addGroup = (title: string, group: PartListItem[]): void => {
        if (!group.length) return;
        const parent = select.createEl("optgroup", { attr: { label: title } });
        for (const item of group) parent.createEl("option", { value: item.ref, text: optionText(item) });
      };
      addGroup(
        t("ui.block_group_builtin"),
        items.filter(item => item.kind === "builtin")
      );
      addGroup(
        t("ui.note_style_group_folder"),
        items.filter(item => item.kind === "file")
      );
      select.value = current;
    }
  }

  private partName(category: PartCategory): string {
    const select = this.selects.get(category);
    const ref = this.draft[category];
    const item = this.plugin.noteStyles.listParts(category).find(part => part.ref === ref);
    return item?.name ?? select?.value ?? ref;
  }

  private takenNames(): Set<string> {
    return takenRecipeNames(this.plugin);
  }

  private nameProblem(): string {
    return this.existing ? "" : namePartProblem(this.draft.name, "recipe", this.takenNames());
  }

  /** Writes the name error (only when its text changes) and enables or disables Save. */
  private syncState(): void {
    const problem = this.nameProblem();
    const error = this.errorEl;
    if (error && error.textContent !== problem) error.setText(problem);
    if (this.saveButton) this.saveButton.disabled = !!problem || this.saving;
  }

  private changed(): void {
    this.syncState();
    this.scheduleExample();
  }

  /** The parts the draft holds, with a name the store can use for a style that is not saved. */
  private draftParts(): Draft {
    return { ...this.draft, name: this.draft.name || t("ui.recipe_new_name") };
  }

  // ---- Edit on a part ----

  private async editPart(category: PartCategory, button: HTMLElement): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const target = await this.plugin.editNotePart(category, this.draft[category]);
      if (!target || this.closed) return;
      this.draft[category] = target;
      await this.plugin.noteStyles.refresh().catch(() => undefined);
      if (this.closed) return;
      this.fillSelects();
      this.syncState();
      this.scheduleExample();
      button.focus();
    } finally {
      this.busy = false;
    }
  }

  /** The window is in front again: read the files again and redraw what depends on them. */
  private async reload(): Promise<void> {
    await this.plugin.noteStyles.refresh().catch(() => undefined);
    if (this.closed) return;
    this.fillSelects();
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
    const language = this.plugin.settings.language;
    const style = this.plugin.noteStyles.draftStyle(this.draftParts(), "topic", language);
    const formatId = this.draft.format.startsWith("builtin:") ? this.draft.format.slice("builtin:".length) : undefined;
    const lines: string[] = [
      `*${plainMd(t("ui.editor_example_voice_0", this.partName("voice")))}* · *${plainMd(t("ui.editor_example_format_0", this.partName("format")))}*`,
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
    this.plugin.openPromptPreview(button, () =>
      this.plugin.noteStyles.draftStyle(this.draftParts(), "topic", this.plugin.settings.language)
    );
  }

  private async save(): Promise<void> {
    if (this.saving || this.closed) return;
    const problem = this.nameProblem();
    if (problem) {
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
        structure: this.draft.structure,
        voice: this.draft.voice,
        format: this.draft.format,
        update: this.draft.update,
        ...(this.existing ? { original: this.existing } : {})
      });
      if (this.closed) return;
      if (!result.ok) {
        // "changed" leaves the window open: nothing was written, and the notice says to reopen the file.
        if (result.reason === "name") this.errorEl?.setText(t("ui.recipe_notice_name_unavailable"));
        return;
      }
      if (switched.length) {
        for (const kind of switched) await this.plugin.setKindStyle(kind, result.ref);
        new Notice(
          t(
            "ui.recipe_notice_switched_0_1",
            result.ref.slice("file:".length),
            switched
              .map(kind => t(kind === "aim" ? "ui.note_style_kind_aim" : `ui.topic_kind_${kind}`))
              .join(t("ui.manage_list_separator"))
          )
        );
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
