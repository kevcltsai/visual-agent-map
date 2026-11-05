import { Modal, Notice, normalizePath, TFile, type App } from "obsidian";
import type VisualAgentMapPlugin from "../../main";
import { emptyNoteStyleStore, type NoteStyleStore } from "../../ai/note-style-store";
import type { TopicKind } from "../../note-values";
import { builtinRef } from "../../core/blocks/block-files";
import { t, type TranslationKey } from "../../i18n";
import type { NoteStyleIssue } from "../../ai/note-style-file";
import { backgroundResultNotice } from "../../ui/background-run";
import { modalActions } from "../../ui/modals/action-bar";
import { openInWindowOf } from "../../ui/modals/open-in-window";
import { BUILTIN_BLOCKS, BUILTIN_FORMATS } from "../../core/blocks/builtin";
import { AIM_DELIVERY_STRUCTURE, BUILTIN_RECIPES, UPDATE_MODE_KEYS, type UpdateMode } from "../../ai/note-style-recipe";

/**
 * One style (recipe) in a one-line choice. A structural subset of the store's `RecipeListItem`,
 * so that list can be handed over as it is.
 */
export interface PickerRecipe {
  /** `builtin:<id>` or `file:<name>`. */
  ref: string;
  kind: "builtin" | "file";
  name: string;
  /** The file (with ".md") of a user's style. */
  fileName?: string;
  /** The AIM report: only for the AIM kind, never offered for a topic. */
  aimOnly?: true;
  structure: { name: string };
  voice: { name: string };
  format: { name: string };
  update: UpdateMode;
  issues: NoteStyleIssue[];
}

/** The built-in styles by name, without reading any file (a test double, or a store with no style list yet). */
export function builtinRecipeItems(): PickerRecipe[] {
  const nameOf = (list: readonly { id: string; nameKey: TranslationKey }[], id: string): string => {
    const found = list.find(item => item.id === id);
    return found ? t(found.nameKey) : id;
  };
  const templates = BUILTIN_BLOCKS.filter(block => block.category === "template");
  const tones = BUILTIN_BLOCKS.filter(block => block.category === "tone");
  return BUILTIN_RECIPES.map(recipe => {
    const aim = recipe.structure === AIM_DELIVERY_STRUCTURE;
    return {
      ref: builtinRef(recipe.id),
      kind: "builtin" as const,
      name: t(recipe.nameKey),
      ...(aim ? { aimOnly: true as const } : {}),
      structure: { name: aim ? t(recipe.nameKey) : nameOf(templates, recipe.structure) },
      voice: { name: nameOf(tones, recipe.voice) },
      format: { name: nameOf(BUILTIN_FORMATS, recipe.format) },
      update: recipe.update,
      issues: []
    };
  });
}

/** The four small labels of a style: structure, voice, format and (not for the AIM report) the update mode. */
export function recipeTags(item: PickerRecipe): string {
  const tags = [item.structure.name, item.voice.name, item.format.name];
  if (!item.aimOnly) tags.push(t(UPDATE_MODE_KEYS[item.update]));
  return tags.join(" · ");
}

/** What the four note-style entries need from the block folders (absent in a test double: only the built-ins are listed). */
export interface StylePicker {
  /** Re-reads the block folders; call `recipes()` afterwards. */
  refresh(): Promise<void>;
  /** Every style, built-ins (the AIM report marked `aimOnly`) first, then the user's style files. */
  recipes(): PickerRecipe[];
  /** Opens the style file `file:<name>` in a new tab (a Notice when it is not there). */
  openRecipe(ref: string): Promise<void>;
}

/** A style file that does not parse stops the run; the Notice offers to open the file. */
export class NoteStyleFileError extends Error {
  constructor(
    message: string,
    readonly open: () => void
  ) {
    super(message);
  }
}

/** A Notice with one action button (open the file, switch style). */
export function actionNotice(message: string, label: string, run: () => void, timeout = 12000): Notice {
  return backgroundResultNotice(message, { label, open: run }, timeout);
}

/** Shows a failure; a bad style file gets an "Open this file" button. */
export function errorNotice(error: unknown): Notice {
  const message = (error as { message?: unknown } | null)?.message;
  const text = typeof message === "string" ? message : String(error);
  if (error instanceof NoteStyleFileError) return actionNotice(text, t("ui.note_style_open_file"), error.open);
  return new Notice(text);
}

export function stylePickerFor(app: App, plugin: VisualAgentMapPlugin): StylePicker | undefined {
  const store = (plugin as { noteStyles?: NoteStyleStore }).noteStyles;
  if (!store) return undefined;
  return {
    refresh: () => store.refresh(),
    recipes: () => store.listRecipes(),
    openRecipe: ref => openRecipeFile(app, store, ref)
  };
}

/** Opens a file of the vault in a new tab; false when it is not there. */
export async function openVaultFile(app: App, path: string): Promise<boolean> {
  const file = app.vault.getAbstractFileByPath(normalizePath(path));
  if (!(file instanceof TFile)) return false;
  await app.workspace.getLeaf("tab").openFile(file);
  return true;
}

/** Opens a user's style file (`<style folder>/<Styles>/<name>.md`) in a new tab; a Notice when it is not there. */
export async function openRecipeFile(app: App, store: NoteStyleStore, ref: string): Promise<void> {
  const path = store.recipeFilePath(ref);
  if (path === undefined || !(await openVaultFile(app, path))) {
    new Notice(t("ui.note_style_edit_missing_0", ref.startsWith("file:") ? `${ref.slice("file:".length)}.md` : ref));
  }
}

const ISSUE_KEYS = new Set([
  "file_long",
  "tone_long",
  "frontmatter_unclosed",
  "key_duplicate",
  "no_sections",
  "count_invalid",
  "comment_unclosed",
  "format_heading_repeated",
  // The codes only a style file (a recipe) raises.
  "format_zone_moved",
  "update_invalid",
  "part_name_invalid",
  "part_missing",
  "builtin_name"
]);

/** The translated reason of one parse problem: a file-format code or a template error key. */
export function styleIssueText(issue: NoteStyleIssue): string {
  if (ISSUE_KEYS.has(issue.code)) return t(`ui.note_style_issue_${issue.code}` as TranslationKey, ...issue.values);
  return t(issue.code as TranslationKey, ...issue.values);
}

export interface TopicStyleChooserOptions {
  /** The topic's own frontmatter values: what is "Current setting". */
  note: { noteStyle?: string; detailTemplateId?: string; toneId?: string };
  /** The topic type, which decides what "Follow the topic type" means. */
  kind: TopicKind;
  /** A ref sets `note-style`; null follows the topic type (and removes the old 0.28.0 keys). Called by Apply only, never for the current row. */
  write: (ref: string | null) => void | Promise<void>;
  /** The dialog was closed without applying (Cancel, Esc). */
  dismissed?: () => void;
  /** The element that asked (the topic card): the dialog opens in its window. */
  anchor?: HTMLElement | null;
}

/** One row of the picker. `value` is what Apply writes; a row with `issue` is a style file that cannot be chosen. */
interface PickerRow {
  label: string;
  tags: string;
  current: boolean;
  /** `undefined`: the row cannot be applied (the old setting, a style file with a problem). */
  value?: string | null;
  issue?: { fileName: string; ref: string; reason: string };
}

/** How many styles show before the rest are folded under "Other N styles". */
const PICKER_SHOWN = 4;

/**
 * The picker window: a radio list with the one in force first and marked, four rows on show and the rest under "Other N
 * styles", Cancel and Apply at the bottom. Choosing writes nothing; only Apply calls `write`.
 */
class TopicStylePickerModal extends Modal {
  private applied = false;
  private selected: PickerRow | undefined;
  private readonly radios: { row: PickerRow; el: HTMLElement; extra: boolean }[] = [];
  private expanded = false;
  private applyButton?: HTMLButtonElement;
  constructor(
    app: App,
    private readonly rows: PickerRow[],
    private readonly handlers: {
      apply: (value: string | null) => void | Promise<void>;
      dismissed?: () => void;
      openFile: (ref: string) => void;
    }
  ) {
    super(app);
    this.selected = rows.find(row => row.current);
  }
  onClose(): void {
    if (!this.applied) this.handlers.dismissed?.();
    this.applied = true;
  }
  onOpen(): void {
    this.titleEl.setText(t("ui.note_style_topic_title"));
    this.contentEl.createEl("p", { text: t("ui.note_style_topic_desc"), cls: "vam-modal-intro" });
    const choosable = this.rows.filter(row => !row.issue);
    const broken = this.rows.filter(row => row.issue);
    const shown = choosable.slice(0, PICKER_SHOWN);
    const rest = [...choosable.slice(PICKER_SHOWN), ...broken];
    const group = this.contentEl.createDiv({
      cls: "vam-picker-group",
      attr: { role: "radiogroup", "aria-label": t("ui.note_style_topic_title") }
    });
    for (const row of shown) this.addRow(group, row, false);
    let toggle: HTMLButtonElement | undefined;
    if (rest.length) {
      toggle = this.contentEl.createEl("button", {
        text: t("ui.note_style_more_0", String(rest.length)),
        cls: "vam-picker-more",
        attr: { type: "button", "aria-expanded": "false" }
      });
      const extra = this.contentEl.createDiv({ cls: "vam-picker-group vam-picker-rest", attr: { role: "group" } });
      extra.hidden = true;
      for (const row of rest) {
        if (row.issue) this.addBroken(extra, row);
        else this.addRow(extra, row, true);
      }
      toggle.addEventListener("click", () => {
        this.expanded = !this.expanded;
        extra.hidden = !this.expanded;
        toggle?.setAttr("aria-expanded", String(this.expanded));
        if (this.expanded) this.radios.find(entry => entry.extra)?.el.focus();
      });
    }
    const actions = modalActions(this);
    const cancel = actions.createEl("button", { text: t("ui.cancel") });
    cancel.addEventListener("click", () => this.close());
    this.applyButton = actions.createEl("button", { text: t("ui.apply"), cls: "mod-cta" });
    this.applyButton.addEventListener("click", () => this.apply());
    this.syncChecked();
    const start = this.radios.find(entry => entry.row === this.selected) ?? this.radios[0];
    start?.el.focus();
    // Obsidian may move focus after onOpen; take it back to the current row.
    if (typeof window !== "undefined") window.setTimeout(() => start?.el.focus(), 0);
  }
  private addRow(parent: HTMLElement, row: PickerRow, extra: boolean): void {
    const el = parent.createEl("button", {
      cls: `vam-picker-row${row.current ? " is-current" : ""}`,
      attr: { type: "button", role: "radio", "aria-checked": "false", tabindex: "-1" }
    });
    el.createSpan({
      text: row.current ? `${row.label} · ${t("ui.detail_template_current")}` : row.label,
      cls: "vam-picker-name"
    });
    el.createSpan({ text: row.tags, cls: "vam-picker-desc" });
    const entry = { row, el, extra };
    this.radios.push(entry);
    el.addEventListener("click", () => this.choose(entry));
    el.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key === "Enter") {
        event.preventDefault();
        this.apply();
        return;
      }
      const step =
        event.key === "ArrowDown" || event.key === "ArrowRight"
          ? 1
          : event.key === "ArrowUp" || event.key === "ArrowLeft"
            ? -1
            : 0;
      if (!step) return;
      event.preventDefault();
      const live = this.radios.filter(item => !item.extra || this.expanded);
      const from = live.indexOf(entry);
      this.choose(live[(from + step + live.length) % live.length], true);
    });
  }
  private addBroken(parent: HTMLElement, row: PickerRow): void {
    const issue = row.issue!;
    const el = parent.createDiv({ cls: "vam-picker-row vam-picker-broken" });
    const text = el.createDiv({ cls: "vam-picker-text" });
    text.createSpan({ text: row.label, cls: "vam-picker-name" });
    text.createSpan({ text: row.tags, cls: "vam-picker-desc" });
    el.createEl("button", { text: t("ui.note_style_open_file") }).addEventListener("click", () =>
      this.handlers.openFile(issue.ref)
    );
  }
  private choose(entry: { row: PickerRow; el: HTMLElement }, focus = false): void {
    this.selected = entry.row;
    this.syncChecked();
    if (focus) entry.el.focus();
  }
  private syncChecked(): void {
    for (const entry of this.radios) {
      const on = entry.row === this.selected;
      entry.el.setAttr("aria-checked", String(on));
      entry.el.setAttr("tabindex", on || (!this.selected && entry === this.radios[0]) ? "0" : "-1");
    }
    const changed = !!this.selected && !this.selected.current && this.selected.value !== undefined;
    if (this.applyButton) this.applyButton.disabled = !changed;
  }
  private apply(): void {
    const row = this.selected;
    if (!row || row.current || row.value === undefined) return;
    this.applied = true;
    this.close();
    void this.handlers.apply(row.value);
  }
}

/**
 * The note style of one topic: the one in force first (when the topic has no style of its own that is "Follow the topic type
 * (X)"), the topic's old template/tone pair when it has one, then every built-in (not the AIM report) and the user's styles,
 * each with its four small labels. Choosing writes nothing; Apply writes `note-style`. A style file with a problem shows its
 * reason and opens instead of being chosen.
 */
export async function openTopicStyleChooser(
  app: App,
  plugin: VisualAgentMapPlugin,
  options: TopicStyleChooserOptions
): Promise<void> {
  const picker = stylePickerFor(app, plugin);
  const store = (plugin as { noteStyles?: NoteStyleStore }).noteStyles ?? emptyNoteStyleStore(() => plugin.settings);
  try {
    await picker?.refresh();
  } catch {
    /* an unreadable folder keeps the styles read last */
  }
  const recipes = (picker ? picker.recipes() : builtinRecipeItems()).filter(item => !item.aimOnly);
  const language = plugin.settings?.language ?? "en";
  const { note } = options;
  const legacy = !note.noteStyle && (!!note.detailTemplateId || !!note.toneId);
  const followed = store.runStyle({ kind: options.kind, outputLanguage: language });
  const followedItem = recipes.find(item => item.ref === followed.recipe.ref);
  const rows: PickerRow[] = [];
  rows.push({
    label: t("ui.note_style_follow_kind_0", followed.recipe.name),
    tags: followedItem ? recipeTags(followedItem) : `${followed.label.templateName} · ${followed.label.toneName}`,
    current: !note.noteStyle && !legacy,
    value: null
  });
  if (legacy) {
    const old = store.runStyle({
      kind: options.kind,
      topic: { template: note.detailTemplateId, tone: note.toneId },
      outputLanguage: language
    });
    rows.push({ label: old.recipe.name, tags: `${old.label.templateName} · ${old.label.toneName}`, current: true });
  }
  for (const item of recipes) {
    if (item.issues.length) {
      const first = item.issues[0];
      rows.push({
        label: item.name,
        tags: t("ui.note_style_unusable_0_1_2", item.fileName ?? item.name, first.line, styleIssueText(first)),
        current: false,
        issue: { fileName: item.fileName ?? item.name, ref: item.ref, reason: styleIssueText(first) }
      });
      continue;
    }
    rows.push({ label: item.name, tags: recipeTags(item), current: note.noteStyle === item.ref, value: item.ref });
  }
  // The one in force goes first.
  const at = rows.findIndex(row => row.current);
  if (at > 0) rows.unshift(...rows.splice(at, 1));
  const modal = new TopicStylePickerModal(app, rows, {
    apply: options.write,
    dismissed: options.dismissed,
    openFile: ref => void picker?.openRecipe(ref)
  });
  openInWindowOf(modal, options.anchor);
}
