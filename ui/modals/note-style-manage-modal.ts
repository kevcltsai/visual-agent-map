import { App, Modal, Notice, Setting } from "obsidian";
import type VisualAgentMapPlugin from "../../main";
import { t, type TranslationKey } from "../../i18n";
import type { RecipeListItem } from "../../ai/note-style-store";
import { UPDATE_MODE_KEYS, type StyleKind } from "../../ai/note-style-recipe";
import { NoteStyleEditorModal, namePartProblem, suggestRecipeName } from "./note-style-editor-modal";
import { styleIssueText } from "../../experiences/visual-map/note-style-picker";
import { aimEnabled } from "../../experiences/aim/availability";

/** The four pages of the manage window, in tab order. */
export const MANAGE_TABS = ["recipe", "structure", "voice", "format"] as const;
export type ManageTab = (typeof MANAGE_TABS)[number];

const TAB_NAME_KEYS: Record<ManageTab, TranslationKey> = {
  recipe: "ui.manage_tab_recipe",
  structure: "ui.manage_tab_structure",
  voice: "ui.manage_tab_voice",
  format: "ui.manage_tab_format"
};

export const manageTabName = (tab: ManageTab): string => t(TAB_NAME_KEYS[tab]);

type Issue = RecipeListItem["issues"][number];

/** Problem codes only style files raise; `styleIssueText` covers the codes of the part files. */
const RECIPE_ISSUE_CODES: ReadonlySet<string> = new Set([
  "format_zone_moved",
  "update_invalid",
  "part_name_invalid",
  "part_missing",
  "builtin_name"
]);

export function recipeIssueText(issue: Issue): string {
  return RECIPE_ISSUE_CODES.has(issue.code)
    ? t(`ui.note_style_issue_${issue.code}` as TranslationKey, ...issue.values)
    : styleIssueText(issue);
}

/** The four small labels of a style: structure, voice, format, update mode (the AIM report has no update mode). */
export function styleTags(item: RecipeListItem): string {
  const tags = [item.structure.name, item.voice.name, item.format.name];
  if (!item.aimOnly) tags.push(t(UPDATE_MODE_KEYS[item.update]));
  return tags.join(" · ");
}

/** A topic type's name: the type, or the AIM conclusion note. */
export function styleKindName(kind: StyleKind): string {
  return kind === "aim" ? t("ui.note_style_kind_aim") : t(`ui.topic_kind_${kind}`);
}

/** One row of the list, whatever the tab. */
interface Entry {
  ref: string;
  builtin: boolean;
  name: string;
  issues: Issue[];
  /** Who uses it: style names for a part, topic type names for a style. */
  used: string[];
  /** A style's four small labels. */
  tags?: string;
  /** The AIM report: listed, but neither editable nor a copy source. */
  aimOnly: boolean;
}

const lower = (value: string): string => value.toLocaleLowerCase();

/**
 * The window "Custom note styles": four tabs (styles, structures, voices, format rules), each a list of what exists with
 * "Used in: ...", an Edit button, and a small "New..." form. Opening it only reads; files are written by Edit on a
 * built-in part, by Create, and nowhere else.
 */
export class NoteStyleManageModal extends Modal {
  private tab: ManageTab;
  private closed = false;
  private busy = false;
  private tabEls = new Map<ManageTab, HTMLElement>();
  private panelEls = new Map<ManageTab, HTMLElement>();
  private listEl?: HTMLElement;
  private editButtons = new Map<string, HTMLElement>();
  /** Rebuilds the source choices of the open "New..." form after the list changed. */
  private refreshForm?: () => void;
  /** The style editor while it is open (one at a time). */
  private editor?: NoteStyleEditorModal;
  /** The files are being read before the editor opens. */
  private opening = false;

  constructor(
    app: App,
    private plugin: VisualAgentMapPlugin,
    initialTab: ManageTab = "recipe",
    private trigger?: HTMLElement,
    private onClosed?: () => void
  ) {
    super(app);
    this.tab = initialTab;
  }

  onOpen(): void {
    this.modalEl.addClass("vam-manage-modal");
    this.titleEl.setText(t("ui.manage_title"));
    const tablist = this.contentEl.createDiv({
      cls: "vam-manage-tabs",
      attr: { role: "tablist", "aria-label": t("ui.manage_title") }
    });
    for (const [index, tab] of MANAGE_TABS.entries()) {
      const button = tablist.createEl("button", {
        text: manageTabName(tab),
        cls: "vam-manage-tab",
        attr: { role: "tab", id: `vam-manage-tab-${tab}`, "aria-controls": `vam-manage-panel-${tab}` }
      });
      button.addEventListener("click", () => this.selectTab(tab, false));
      button.addEventListener("keydown", event => {
        let next: number;
        if (event.key === "ArrowRight") next = (index + 1) % MANAGE_TABS.length;
        else if (event.key === "ArrowLeft") next = (index + MANAGE_TABS.length - 1) % MANAGE_TABS.length;
        else if (event.key === "Home") next = 0;
        else if (event.key === "End") next = MANAGE_TABS.length - 1;
        else return;
        event.preventDefault();
        this.selectTab(MANAGE_TABS[next], true);
      });
      this.tabEls.set(tab, button);
      this.panelEls.set(
        tab,
        this.contentEl.createDiv({
          cls: "vam-manage-panel",
          attr: { role: "tabpanel", id: `vam-manage-panel-${tab}`, "aria-labelledby": `vam-manage-tab-${tab}` }
        })
      );
    }
    this.selectTab(this.tab, true);
    // The first picture comes from what was read last; the files are read again right away.
    void this.plugin.noteStyles.refresh().then(
      () => {
        if (this.closed) return;
        this.renderList();
        this.refreshForm?.();
      },
      () => undefined
    );
  }

  onClose(): void {
    this.closed = true;
    this.contentEl.empty();
    this.trigger?.focus();
    this.onClosed?.();
  }

  private selectTab(tab: ManageTab, focus: boolean): void {
    this.tab = tab;
    for (const name of MANAGE_TABS) {
      const el = this.tabEls.get(name)!;
      const selected = name === tab;
      el.setAttr("aria-selected", String(selected));
      el.setAttr("tabindex", selected ? "0" : "-1");
      el.toggleClass("is-active", selected);
      const panel = this.panelEls.get(name)!;
      panel.hidden = !selected;
      if (!selected) panel.empty();
    }
    this.buildPanel(this.panelEls.get(tab)!);
    if (focus) this.tabEls.get(tab)!.focus();
  }

  // ---- the lists ----

  private entries(): Entry[] {
    const store = this.plugin.noteStyles;
    if (this.tab === "recipe")
      return store
        .listRecipes()
        .filter(item => aimEnabled() || !item.aimOnly)
        .map(item => ({
          ref: item.ref,
          builtin: item.kind === "builtin",
          name: item.name,
          issues: item.issues,
          used: item.usedByKinds.filter(kind => kind !== "aim" || aimEnabled()).map(styleKindName),
          tags: styleTags(item),
          aimOnly: item.aimOnly === true
        }));
    return store.listParts(this.tab).map(item => ({
      ref: item.ref,
      builtin: item.kind === "builtin",
      name: item.name,
      issues: item.issues,
      used: item.usedBy,
      aimOnly: false
    }));
  }

  private buildPanel(panel: HTMLElement): void {
    panel.empty();
    this.editButtons.clear();
    this.listEl = panel.createDiv({ cls: "vam-manage-list" });
    this.renderList();
    this.buildAddForm(panel);
  }

  renderList(): void {
    const list = this.listEl;
    if (!list) return;
    list.empty();
    this.editButtons.clear();
    for (const entry of this.entries()) {
      const setting = new Setting(list);
      setting.settingEl.addClass("vam-manage-row");
      setting.setName(entry.name);
      if (entry.builtin) setting.nameEl.createSpan({ text: t("ui.block_group_builtin"), cls: "vam-manage-badge" });
      const used = entry.used.length
        ? t("ui.manage_used_by_0", entry.used.join(t("ui.manage_list_separator")))
        : t(this.tab === "recipe" ? "ui.manage_unused_recipe" : "ui.manage_unused_part");
      setting.descEl.createDiv({ text: used, cls: "vam-manage-used" });
      if (entry.tags) setting.descEl.createDiv({ text: entry.tags, cls: "vam-manage-tags" });
      for (const issue of entry.issues)
        setting.descEl.createDiv({
          text: t("ui.note_style_recipe_issue_0_1", issue.line, recipeIssueText(issue)),
          cls: "vam-block-status-error"
        });
      if (entry.aimOnly) continue;
      setting.addButton(button => {
        button.setButtonText(t("ui.manage_edit")).onClick(() => void this.edit(entry));
        button.buttonEl.setAttr("aria-label", t("ui.manage_edit_aria_0", entry.name));
        this.editButtons.set(entry.ref, button.buttonEl);
      });
    }
  }

  focusRow(ref: string | null): void {
    if (ref) this.editButtons.get(ref)?.focus();
  }

  private async edit(entry: Entry): Promise<void> {
    if (this.busy || entry.aimOnly) return;
    if (this.tab === "recipe") {
      // A built-in style opens as "My <name>" (saved only when the editor saves); a user's style opens as it is.
      void this.openEditor(() => ({
        source: entry.ref,
        ...(entry.builtin ? { name: this.suggestRecipeName(entry.name) } : {}),
        trigger: this.editButtons.get(entry.ref),
        onSaved: ref => this.afterSaved(ref)
      }));
      return;
    }
    this.busy = true;
    try {
      const target = await this.plugin.editNotePart(this.tab, entry.ref);
      await this.plugin.noteStyles.refresh();
      if (this.closed) return;
      this.renderList();
      this.refreshForm?.();
      this.focusRow(target);
    } finally {
      this.busy = false;
    }
  }

  /**
   * Opens the style editor on top of this window; a second one is not opened while it is there. The files are read
   * first, so the editor compares against the file as it is now and not against a copy from before an outside edit.
   */
  private async openEditor(make: () => ConstructorParameters<typeof NoteStyleEditorModal>[2]): Promise<void> {
    if (this.editor || this.opening || this.closed) return;
    this.opening = true;
    try {
      await this.plugin.noteStyles.refresh().catch(() => undefined);
      if (this.closed) return;
      const editor = new NoteStyleEditorModal(this.app, this.plugin, {
        ...make(),
        onClosed: () => {
          this.editor = undefined;
        }
      });
      this.editor = editor;
      editor.open();
    } finally {
      this.opening = false;
    }
  }

  /** The editor saved a style: draw the list again and put the focus on its row. */
  private afterSaved(ref: string): void {
    if (this.closed) return;
    this.renderList();
    this.refreshForm?.();
    this.focusRow(ref);
  }

  // ---- "New..." ----

  /** The names taken in this tab, lower case (the vault is case-insensitive on some systems). */
  private takenNames(): Set<string> {
    const store = this.plugin.noteStyles;
    const items = this.tab === "recipe" ? store.listRecipes() : store.listParts(this.tab);
    return new Set(items.filter(item => item.kind === "file").map(item => lower(item.name)));
  }

  /** "My <name>" for a copy of a style, "New style" for a blank one; " (2)", " (3)" ... until it is free and allowed. */
  private suggestRecipeName(from: string | null): string {
    return suggestRecipeName(this.plugin, from);
  }

  private suggestName(from: string | null): string {
    if (this.tab !== "recipe") return this.plugin.noteStyles.suggestPartName(this.tab, from);
    const name = from === null ? null : this.entries().find(entry => entry.ref === from)?.name;
    return this.suggestRecipeName(name ?? null);
  }

  /** Why `value` cannot be the name of a new file in this tab; "" when it can. */
  private nameProblem(value: string): string {
    return namePartProblem(value, this.tab, this.takenNames());
  }

  private buildAddForm(panel: HTMLElement): void {
    const tab = this.tab;
    const wrap = panel.createDiv({ cls: "vam-manage-add" });
    const toggle = wrap.createEl("button", {
      text: t("ui.manage_add"),
      attr: { "aria-expanded": "false", "aria-controls": `vam-manage-form-${tab}` }
    });
    const form = wrap.createEl("fieldset", { cls: "vam-manage-form", attr: { id: `vam-manage-form-${tab}` } });
    form.hidden = true;
    form.createEl("legend", { text: t("ui.manage_add_legend") });
    let mode: "from" | "blank" = "from";
    let source = "";
    let name = "";
    let touched = false;

    const radios = form.createDiv({ cls: "vam-manage-modes" });
    const radio = (value: "from" | "blank", label: string): HTMLInputElement => {
      const id = `vam-manage-mode-${tab}-${value}`;
      const line = radios.createDiv({ cls: "vam-manage-mode" });
      const input = line.createEl("input", { type: "radio", attr: { name: `vam-manage-mode-${tab}`, id } });
      input.checked = value === mode;
      line.createEl("label", { text: label, attr: { for: id } });
      return input;
    };
    const fromRadio = radio("from", t("ui.manage_add_from"));
    const blankRadio = radio("blank", t("ui.manage_add_blank"));

    let sourceSelect: HTMLSelectElement | undefined;
    new Setting(form).setName(t("ui.manage_add_source")).addDropdown(dropdown => {
      sourceSelect = dropdown.selectEl;
      dropdown.selectEl.setAttr("aria-label", t("ui.manage_add_source"));
      dropdown.onChange(value => {
        source = value;
        if (!touched) setName(this.suggestName(source));
        check();
      });
    });
    let nameInput: HTMLInputElement | undefined;
    const errorId = `vam-manage-error-${tab}`;
    new Setting(form).setName(t("ui.manage_add_name")).addText(text => {
      nameInput = text.inputEl;
      text.inputEl.setAttr("aria-label", t("ui.manage_add_name"));
      text.inputEl.setAttr("aria-describedby", errorId);
      text.onChange(value => {
        touched = true;
        name = value;
        check();
      });
      text.inputEl.addEventListener("keydown", event => {
        if (event.key !== "Enter" || event.isComposing) return;
        event.preventDefault();
        event.stopPropagation();
        void create();
      });
    });
    const error = form.createDiv({
      cls: "vam-block-status-error vam-manage-error",
      attr: { id: errorId, "aria-live": "polite" }
    });
    let createButton: { setDisabled(disabled: boolean): unknown; buttonEl: HTMLElement } | undefined;
    new Setting(form).addButton(button => {
      createButton = button;
      button
        .setButtonText(t("ui.manage_add_create"))
        .setCta()
        .onClick(() => void create());
    });

    const setName = (value: string): void => {
      name = value;
      if (nameInput) nameInput.value = value;
    };
    const check = (): void => {
      const problem = this.nameProblem(name);
      error.setText(problem);
      createButton?.setDisabled(!!problem);
    };
    /** Fills the source choices from the current list (the AIM report is no source) and keeps the choice when it is still there. */
    const fillSources = (): void => {
      if (!sourceSelect) return;
      const sources = this.entries().filter(entry => !entry.aimOnly);
      sourceSelect.replaceChildren();
      for (const entry of sources) sourceSelect.createEl("option", { value: entry.ref, text: entry.name });
      if (!sources.some(entry => entry.ref === source)) source = sources[0]?.ref ?? "";
      sourceSelect.value = source;
      sourceSelect.disabled = mode === "blank";
    };
    const setMode = (next: "from" | "blank"): void => {
      mode = next;
      fromRadio.checked = next === "from";
      blankRadio.checked = next === "blank";
      if (sourceSelect) sourceSelect.disabled = next === "blank";
      if (!touched) setName(this.suggestName(next === "from" ? source : null));
      check();
    };
    fromRadio.addEventListener("change", () => setMode("from"));
    blankRadio.addEventListener("change", () => setMode("blank"));

    const reset = (): void => {
      touched = false;
      mode = "from";
      fromRadio.checked = true;
      blankRadio.checked = false;
      fillSources();
      setName(this.suggestName(source));
      check();
    };
    this.refreshForm = (): void => {
      fillSources();
      if (!touched) setName(this.suggestName(mode === "from" ? source : null));
      check();
    };

    /** The new file is made: close the form, draw the list again and put the focus on its row. */
    const finish = (target: string): void => {
      if (this.closed) return;
      form.hidden = true;
      toggle.setAttr("aria-expanded", "false");
      this.renderList();
      reset();
      this.focusRow(target);
    };
    const create = async (): Promise<void> => {
      if (this.busy || this.editor || this.opening || this.nameProblem(name)) return;
      if (tab === "recipe") {
        // A new style is not written here: the editor opens on it and the file appears when it saves.
        void this.openEditor(() => ({
          source: null,
          from: mode === "from" ? source : null,
          name,
          trigger: createButton?.buttonEl,
          onSaved: ref => finish(ref)
        }));
        return;
      }
      this.busy = true;
      try {
        const from = mode === "from" ? source : null;
        let target: string | null = null;
        try {
          target = await this.plugin.noteStyles.createPart(tab, from, name);
        } catch {
          new Notice(t("ui.manage_create_failed"));
        }
        // The new file opens for editing; "edit" of a file opens it as it is.
        if (target) target = (await this.plugin.editNotePart(tab, target)) ?? target;
        if (!target) return;
        await this.plugin.noteStyles.refresh();
        finish(target);
      } finally {
        this.busy = false;
      }
    };

    toggle.addEventListener("click", () => {
      const open = form.hidden;
      form.hidden = !open;
      toggle.setAttr("aria-expanded", String(open));
      if (open) {
        reset();
        fromRadio.focus();
      }
    });
    fillSources();
    setName(this.suggestName(source || null));
    check();
  }
}
