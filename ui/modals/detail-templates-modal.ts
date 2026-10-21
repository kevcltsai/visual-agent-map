import { App, Modal, setIcon, type Setting } from "obsidian";
import { LANGUAGES, noteLanguageOf, t, type TranslationKey } from "../../i18n";
import { modalActions } from "./action-bar";
import type { Settings } from "../../repository";
import {
  STANDARD_TEMPLATE_ID,
  builtinTemplates,
  copyTemplate,
  detailStructurePrompt,
  isBuiltinTemplateId,
  standardTemplate,
  validateTemplate,
  withoutConflictingAliases,
  type DetailSection,
  type DetailSectionRole,
  type DetailTemplate,
  type TemplateIssue
} from "../../ai/detail-templates";
import { detailStructure } from "../../core/steps/task/fragments";
import { ChoiceModal } from "./choice-modal";

export interface DetailTemplatesHost {
  settings: Settings;
  saveSettings(): Promise<void>;
}

const same = (a: string, b: string): boolean => a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();
const PURPOSES: [DetailSectionRole, TranslationKey][] = [
  ["none", "ui.detail_section_kind_none"],
  ["sources", "ui.detail_section_purpose_sources"],
  ["log", "ui.detail_section_purpose_log"]
];
const PURPOSE_HELP: Record<DetailSectionRole, TranslationKey> = {
  none: "ui.detail_section_purpose_help_none",
  sources: "ui.detail_section_purpose_help_sources",
  log: "ui.detail_section_purpose_help_log"
};
const KINDS: Record<DetailSectionRole, TranslationKey> = {
  none: "ui.detail_section_kind_none",
  sources: "ui.detail_section_kind_sources",
  log: "ui.detail_section_kind_log"
};

function countSummary(section: DetailSection): string {
  if (!section.count) return t("ui.detail_section_count_none");
  return t(
    section.count.mode === "exact" ? "ui.detail_section_count_exact_0" : "ui.detail_section_count_min_0",
    section.count.n
  );
}

/** The default the workspace really resolves to: a missing or stale id means Standard; Textbook is built in. */
function workspaceDefaultId(settings: Settings): string {
  const id = settings.defaultDetailTemplateId;
  return id && (isBuiltinTemplateId(id) || settings.detailTemplates.some(template => template.id === id))
    ? id
    : STANDARD_TEMPLATE_ID;
}

function option(select: HTMLSelectElement, value: string, text: string): void {
  select.createEl("option", { value, text });
}

/** Settings row: workspace-default dropdown plus the button that opens the library. */
export function renderDetailTemplatesSetting(
  setting: Setting,
  app: App,
  plugin: DetailTemplatesHost,
  refresh: () => void = () => {}
): void {
  setting
    .setName(t("ui.detail_templates"))
    .setDesc(t("ui.detail_templates_setting_desc"))
    .addDropdown(dropdown => {
      for (const builtin of builtinTemplates(noteLanguageOf(plugin.settings.language), plugin.settings.language))
        dropdown.addOption(builtin.id, builtin.name);
      for (const template of plugin.settings.detailTemplates) dropdown.addOption(template.id, template.name);
      dropdown.setValue(workspaceDefaultId(plugin.settings));
      dropdown.onChange(value => {
        plugin.settings.defaultDetailTemplateId = value === STANDARD_TEMPLATE_ID ? undefined : value;
        void plugin.saveSettings();
      });
    })
    .addButton(button =>
      button
        .setButtonText(t("ui.manage_detail_templates"))
        .onClick(() => new DetailTemplatesModal(app, plugin, refresh).open())
    );
}

export class DetailTemplatesModal extends Modal {
  constructor(
    app: App,
    private plugin: DetailTemplatesHost,
    private onChanged: () => void = () => {},
    /** Opens straight into this template (edit, or view for a built-in one), as from a dialog's template picker. */
    private initialId?: string
  ) {
    super(app);
  }

  /** The fixed action bar of the current view; replaced when the dialog switches between list and editor. */
  private bar?: HTMLDivElement;
  private actionBar(): HTMLDivElement {
    this.bar?.remove();
    this.bar = modalActions(this);
    return this.bar;
  }

  onClose(): void {
    this.onChanged();
  }

  onOpen(): void {
    this.titleEl.setText(t("ui.detail_templates"));
    const initial = this.initialId
      ? [
          ...builtinTemplates(noteLanguageOf(this.settings.language), this.settings.language),
          ...this.settings.detailTemplates
        ].find(template => template.id === this.initialId)
      : undefined;
    if (initial) this.showEditor(initial, false, isBuiltinTemplateId(initial.id));
    else this.showList();
  }

  private get settings(): Settings {
    return this.plugin.settings;
  }

  private async persist(): Promise<void> {
    await this.plugin.saveSettings();
  }

  private uniqueName(base: string): string {
    const taken = (name: string) =>
      builtinTemplates(noteLanguageOf(this.settings.language), this.settings.language).some(builtin =>
        same(name, builtin.name)
      ) || this.settings.detailTemplates.some(template => same(template.name, name));
    let name = base;
    for (let n = 2; taken(name); n++) name = `${base} ${n}`;
    return name;
  }

  private showList(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("p", { text: t("ui.detail_templates_hint"), cls: "vam-modal-intro" });
    const defaultId = workspaceDefaultId(this.settings);
    for (const template of [
      ...builtinTemplates(noteLanguageOf(this.settings.language), this.settings.language),
      ...this.settings.detailTemplates
    ]) {
      const isStandard = isBuiltinTemplateId(template.id);
      const row = contentEl.createDiv("vam-template-row");
      const info = row.createDiv("vam-template-info");
      info.createEl("strong", { text: template.name });
      info.createSpan({ text: t("ui.detail_template_sections_0", template.sections.length), cls: "vam-template-meta" });
      const isDefault = template.id === defaultId;
      if (isDefault) info.createSpan({ text: t("ui.detail_template_default_tag"), cls: "vam-template-tag" });
      const actions = row.createDiv("vam-template-actions");
      const button = (label: string, run: () => void | Promise<void>, disabled = false): HTMLButtonElement => {
        const element = actions.createEl("button", { text: label });
        element.disabled = disabled;
        element.addEventListener("click", () => void run());
        return element;
      };
      if (isStandard) button(t("ui.detail_template_view"), () => this.showEditor(template, false, true));
      else button(t("ui.detail_template_edit"), () => this.showEditor(template, false));
      button(t("ui.detail_template_copy"), () => this.duplicate(template));
      if (!isStandard)
        button(t("ui.detail_template_delete"), () => this.confirmDelete(template)).addClass("vam-danger-text");
      button(t("ui.detail_template_set_default"), () => this.setDefault(template.id), isDefault);
    }
    const footer = this.actionBar();
    footer.createEl("button", { text: t("ui.close") }).addEventListener("click", () => this.close());
    footer.createEl("button", { text: t("ui.detail_template_new"), cls: "mod-cta" }).addEventListener("click", () => {
      const fresh = copyTemplate(
        standardTemplate(noteLanguageOf(this.settings.language)),
        this.uniqueName(t("ui.detail_template_new_name")),
        crypto.randomUUID()
      );
      this.showEditor(fresh, true);
    });
  }

  private async duplicate(source: DetailTemplate): Promise<void> {
    const name = this.uniqueName(t("ui.detail_template_copy_name_0", source.name));
    this.settings.detailTemplates.push(copyTemplate(source, name, crypto.randomUUID()));
    await this.persist();
    this.showList();
  }

  private async setDefault(id: string): Promise<void> {
    this.settings.defaultDetailTemplateId = id === STANDARD_TEMPLATE_ID ? undefined : id;
    await this.persist();
    this.showList();
  }

  private confirmDelete(template: DetailTemplate): void {
    new ChoiceModal(this.app, t("ui.detail_template_delete"), t("ui.detail_template_delete_confirm_0", template.name), [
      {
        label: t("ui.detail_template_delete"),
        warning: true,
        action: () => {
          void this.remove(template.id);
        }
      }
    ]).open();
  }

  private async remove(id: string): Promise<void> {
    this.settings.detailTemplates = this.settings.detailTemplates.filter(template => template.id !== id);
    if (this.settings.defaultDetailTemplateId === id) this.settings.defaultDetailTemplateId = undefined;
    await this.persist();
    this.showList();
  }

  /**
   * Edits a deep copy; nothing reaches settings until Save, so Cancel discards everything. Read-only shows the same
   * editor with every field disabled and only Close (used to look at Standard).
   */
  private showEditor(original: DetailTemplate, isNew: boolean, readOnly = false): void {
    const { contentEl } = this;
    const language = this.settings.language;
    const draft = copyTemplate(original, original.name, original.id);
    const baseline = new Map(draft.sections.map(section => [section.id, section.name]));
    const others = this.settings.detailTemplates;
    contentEl.empty();
    contentEl.createEl("p", { text: t("ui.detail_template_editor_intro"), cls: "vam-modal-intro" });
    const topIssues = contentEl.createDiv("vam-template-issues");
    const nameLabel = contentEl.createEl("label", { cls: "vam-field" });
    nameLabel.createSpan({ text: t("ui.detail_template_name") });
    const name = nameLabel.createEl("input", { type: "text" });
    name.value = draft.name;
    name.disabled = readOnly;
    name.setAttr("aria-label", t("ui.detail_template_name"));
    const list = contentEl.createDiv("vam-template-sections");
    const addButton = readOnly
      ? null
      : contentEl.createEl("button", { text: t("ui.detail_section_add"), cls: "vam-template-add" });
    const preview = contentEl.createEl("details", { cls: "vam-template-preview" });
    preview.createEl("summary", { text: t("ui.detail_template_preview") });
    const previewText = preview.createEl("pre");
    const footer = this.actionBar();
    footer
      .createEl("button", { text: t(readOnly ? "ui.close" : "ui.cancel") })
      .addEventListener("click", () => this.showList());
    const save = readOnly ? null : footer.createEl("button", { text: t("ui.save"), cls: "mod-cta" });

    // A name is taken when it matches a built-in name shown in any registered interface language.
    const builtInNames = LANGUAGES.flatMap(({ id }) =>
      builtinTemplates(noteLanguageOf(id), id).map(builtin => builtin.name)
    );
    const check = (): TemplateIssue[] => {
      if (readOnly) return [];
      const issues = validateTemplate(draft, others);
      const trimmed = draft.name.trim();
      if (trimmed && builtInNames.some(builtIn => same(builtIn, trimmed)))
        issues.push({ key: "ui.detail_template_error_name_taken", values: [trimmed] });
      return issues;
    };
    const rows: ((issues: string[]) => void)[] = [];
    let openId: string | undefined = draft.sections[0]?.id;
    let saving = false;
    const refresh = () => {
      const issues = check();
      topIssues.empty();
      const bySection: string[][] = draft.sections.map(() => []);
      for (const issue of issues) {
        const values = issue.values.map(value =>
          issue.key === "ui.detail_template_error_role_taken" && typeof value === "string"
            ? t(value as Parameters<typeof t>[0])
            : value
        );
        const text = t(issue.key, ...values);
        const target = issue.section ? bySection[issue.section - 1] : undefined;
        if (target) target.push(text);
        else topIssues.createDiv({ text, cls: "vam-template-issue" });
      }
      rows.forEach((update, index) => update(bySection[index] ?? []));
      previewText.setText(detailStructurePrompt(draft, language, headings => detailStructure(language, headings)));
      if (save) save.disabled = issues.length > 0;
    };
    name.addEventListener("input", () => {
      draft.name = name.value;
      refresh();
    });

    const renderSections = () => {
      list.empty();
      rows.length = 0;
      draft.sections.forEach((section, index) => {
        const open = (id: string | undefined) => {
          openId = id;
          renderSections();
        };
        rows.push(
          section.id === openId
            ? this.openSection(list, draft, section, index, readOnly, open, refresh)
            : this.closedSection(list, section, index, () => open(section.id))
        );
      });
      refresh();
    };
    addButton?.addEventListener("click", () => {
      const fresh: DetailSection = { id: crypto.randomUUID(), name: "", description: "", role: "none", aliases: [] };
      draft.sections.push(fresh);
      openId = fresh.id;
      renderSections();
    });
    save?.addEventListener("click", () => {
      if (saving || check().length) return;
      saving = true;
      save.disabled = true;
      const finished = this.finalize(draft, baseline);
      if (isNew) this.settings.detailTemplates.push(finished);
      else
        this.settings.detailTemplates = this.settings.detailTemplates.map(item =>
          item.id === finished.id ? finished : item
        );
      void this.persist().then(() => this.showList());
    });
    renderSections();
  }

  /** A collapsed accordion row: number, name, purpose · count summary and, when invalid, the issue count. */
  private closedSection(
    parent: HTMLElement,
    section: DetailSection,
    index: number,
    expand: () => void
  ): (issues: string[]) => void {
    const row = parent.createDiv("vam-template-section");
    const header = row.createEl("button", { cls: "vam-template-section-header" });
    header.setAttr("aria-expanded", "false");
    header.addEventListener("click", expand);
    return issues => {
      header.empty();
      header.createSpan({ text: String(index + 1), cls: "vam-template-section-number" });
      const named = section.name.trim();
      header.createSpan({
        text: named || t("ui.detail_section_unnamed"),
        cls: named ? "vam-template-section-title" : "vam-template-section-title is-untitled"
      });
      if (issues.length) header.createSpan({ text: String(issues.length), cls: "vam-template-section-badge" });
      const summary = header.createSpan({ cls: "vam-template-section-summary" });
      summary.createSpan({
        text: t(KINDS[section.role]),
        cls: section.role === "none" ? "vam-template-section-purpose" : "vam-template-section-purpose is-accent"
      });
      summary.createSpan({ text: "·", cls: "vam-template-section-separator" });
      summary.createSpan({ text: countSummary(section) });
    };
  }

  /** The expanded accordion row with every field of one section. */
  private openSection(
    parent: HTMLElement,
    draft: DetailTemplate,
    section: DetailSection,
    index: number,
    readOnly: boolean,
    open: (id: string | undefined) => void,
    refresh: () => void
  ): (issues: string[]) => void {
    const row = parent.createDiv("vam-template-section is-open");
    const header = row.createDiv("vam-template-section-header is-open");
    header.createSpan({ text: String(index + 1), cls: "vam-template-section-number" });
    const name = header.createEl("input", { type: "text" });
    name.value = section.name;
    name.disabled = readOnly;
    name.setAttr("aria-label", t("ui.detail_section_name"));
    name.setAttr("placeholder", t("ui.detail_section_unnamed"));
    name.addEventListener("input", () => {
      section.name = name.value;
      refresh();
    });
    const icon = (glyph: string, label: string, run: () => void, disabled: boolean) => {
      const button = header.createEl("button", { cls: "clickable-icon" });
      setIcon(button, glyph);
      button.setAttr("aria-label", label);
      button.setAttr("title", label);
      button.disabled = readOnly || disabled;
      button.addEventListener("click", run);
    };
    const move = (by: number) => {
      const target = index + by;
      [draft.sections[index], draft.sections[target]] = [draft.sections[target], draft.sections[index]];
      open(section.id);
    };
    icon("arrow-up", t("ui.detail_section_up"), () => move(-1), index === 0);
    icon("arrow-down", t("ui.detail_section_down"), () => move(1), index === draft.sections.length - 1);
    icon(
      "trash-2",
      t("ui.detail_section_remove"),
      () => {
        draft.sections.splice(index, 1);
        open(draft.sections[Math.min(index, draft.sections.length - 1)]?.id);
      },
      false
    );

    const descriptionField = row.createEl("label", { cls: "vam-field" });
    descriptionField.createSpan({ text: t("ui.detail_section_description") });
    const description = descriptionField.createEl("textarea");
    description.rows = 3;
    description.value = section.description;
    description.disabled = readOnly;
    description.setAttr("aria-label", t("ui.detail_section_description"));
    description.setAttr("placeholder", t("ui.detail_section_description_placeholder"));
    description.addEventListener("input", () => {
      section.description = description.value;
      refresh();
    });

    const columns = row.createDiv("vam-template-section-columns");
    const purposeField = columns.createDiv("vam-field");
    purposeField.createSpan({ text: t("ui.detail_section_role") });
    const role = purposeField.createEl("select");
    role.disabled = readOnly;
    role.setAttr("aria-label", t("ui.detail_section_role"));
    for (const [value, key] of PURPOSES) option(role, value, t(key));
    role.value = section.role;
    const purposeHelp = purposeField.createDiv({ text: t(PURPOSE_HELP[section.role]), cls: "vam-template-help" });
    role.addEventListener("change", () => {
      section.role = role.value as DetailSectionRole;
      purposeHelp.setText(t(PURPOSE_HELP[section.role]));
      refresh();
    });

    const countField = columns.createDiv("vam-field");
    countField.createSpan({ text: t("ui.detail_section_count") });
    const countRow = countField.createDiv("vam-template-count");
    const mode = countRow.createEl("select");
    mode.disabled = readOnly;
    mode.setAttr("aria-label", t("ui.detail_section_count"));
    option(mode, "none", t("ui.detail_section_count_none"));
    option(mode, "exact", t("ui.detail_section_count_exact"));
    option(mode, "min", t("ui.detail_section_count_min"));
    mode.value = section.count?.mode ?? "none";
    mode.addEventListener("change", () => {
      if (mode.value === "none") delete section.count;
      else section.count = { mode: mode.value as "exact" | "min", n: section.count?.n ?? 1 };
      open(section.id);
    });
    if (section.count) {
      const count = countRow.createEl("input", { type: "number" });
      count.value = String(section.count.n);
      count.disabled = readOnly;
      count.setAttr("min", "1");
      count.setAttr("max", "20");
      count.setAttr("aria-label", t("ui.detail_section_count_n"));
      count.addEventListener("input", () => {
        if (section.count) section.count.n = Number(count.value);
        refresh();
      });
    }
    countField.createDiv({ text: t("ui.detail_section_count_help"), cls: "vam-template-help" });
    const issuesEl = row.createDiv("vam-template-issues");
    return issues => {
      issuesEl.empty();
      for (const text of issues) issuesEl.createDiv({ text, cls: "vam-template-issue" });
    };
  }

  /**
   * Trims names and remembers earlier section names as aliases so old notes still map to the renamed section; an alias
   * equal to any section's current name is dropped so the name always wins.
   */
  private finalize(draft: DetailTemplate, baseline: Map<string, string>): DetailTemplate {
    return {
      id: draft.id,
      name: draft.name.trim(),
      sections: withoutConflictingAliases(
        draft.sections.map(section => {
          const before = baseline.get(section.id);
          return { ...section, name: section.name.trim(), aliases: [...section.aliases, ...(before ? [before] : [])] };
        })
      )
    };
  }
}
