import type VisualAgentMapPlugin from "../main";
import { SUPPORTED_LANGUAGES, t, type TranslationKey } from "../i18n";
import { normalizeReasoningLevel } from "../repository";
import { modelDiscoverySummary, syncModelSelect } from "../core/model-discovery";
import { NOTE_STYLE_PRESETS } from "../experiences/visual-map/note-style";
import { clampPreviewScale } from "./preview-utils";
import { App, Menu, Modal, normalizePath, PluginSettingTab, Setting } from "obsidian";
import type { SettingDefinition, SettingDefinitionGroup, SettingDefinitionItem, SettingDefinitionPage } from "obsidian";
import type { ButtonComponent, DropdownComponent, ExtraButtonComponent } from "obsidian";
import { NameModal } from "./modals/name-modal";
import type { BlockListItem } from "../ai/note-style-store";
import {
  builtinBlockNames,
  builtinRef,
  cleanBlockName,
  copyBlockName,
  parseBlockRef
} from "../core/blocks/block-files";
import type { BlockCategory } from "../core/blocks/builtin";
import { styleIssueText } from "../experiences/visual-map/note-style-picker";
import type { TopicKind } from "../note-values";

/**
 * A sub-page's opening sentence as a grey description-only row. Obsidian puts the definition `name` into the row
 * before calling render, so the name is cleared here and the sentence shows once, in the description style.
 */
export function renderSettingsIntro(setting: Setting, text: string): void {
  setting.setName("");
  setting.setDesc(text);
}

/**
 * The first row of the "Note style" page: the one-line help and the "Preview AI instructions" button on its right.
 */
export function renderNoteStyleIntro(setting: Setting, plugin: VisualAgentMapPlugin): void {
  renderSettingsIntro(setting, t("ui.settings_note_style_intro"));
  setting.addButton(button => {
    button.setButtonText(t("ui.preview_prompt_open")).onClick(() => plugin.openPromptPreview(button.buttonEl));
    button.buttonEl.addClass("mod-muted");
  });
}

/**
 * "File location" row: where the files you edited or created are, with "Show in file explorer". A folder that is gone
 * (renamed while the plugin was off) shows "File location not found" and lets the user pick it again; a folder that was
 * never made says there are no files yet.
 */
export function renderNoteLocationSetting(
  setting: Setting,
  plugin: VisualAgentMapPlugin,
  refresh: () => void
): () => void {
  const store = plugin.noteStyles;
  const settings = plugin.settings;
  const missing = !store.folderExists() && !!settings.noteStylesFolder;
  let loaded = false;
  const hasFiles = (): boolean =>
    (["template", "tone"] as const).some(category =>
      store.listBlocks(category).some(item => item.fileName !== undefined)
    );
  const describe = (): void => {
    if (missing) return;
    setting.setDesc(t(loaded && !hasFiles() ? "ui.note_style_location_empty" : "ui.note_style_location_desc"));
  };
  if (missing) {
    setting
      .setName(t("ui.note_style_folder_missing"))
      .setDesc(t("ui.note_style_folder_missing_desc_0", store.folder()));
    let input = "";
    setting.addText(text => {
      input = store.folder();
      text.setPlaceholder(t("ui.note_style_folder_choose_prompt")).setValue(input);
      text.inputEl.setAttr("aria-label", t("ui.note_style_folder_choose_prompt"));
      text.onChange(value => {
        input = value;
      });
    });
    setting.addButton(button =>
      button.setButtonText(t("ui.note_style_folder_choose")).onClick(async () => {
        const value = normalizePath(input.trim());
        if (!input.trim() || value === ".") return;
        settings.noteStylesFolder = value;
        await plugin.saveSettings();
        refresh();
      })
    );
  } else {
    setting.setName(t("ui.note_style_folder_path"));
    describe();
    setting.addText(text => {
      text.setValue(store.folder()).setDisabled(true);
      text.inputEl.setAttr("aria-label", t("ui.note_style_folder_path"));
    });
  }
  setting.addButton(button =>
    button.setButtonText(t("ui.note_style_open_folder")).onClick(async () => {
      await plugin.openNoteStylesFolder();
      refresh();
    })
  );
  /** Reads the files again and rewrites the description (after a row made or saved a file). */
  const update = (): void => {
    void store.refresh().then(
      () => {
        loaded = true;
        describe();
      },
      () => undefined
    );
  };
  update();
  return update;
}

/** What the two pickers show: a block ref for each. */
export interface ShownBlocks {
  template: string;
  tone: string;
}

/**
 * The choice the pickers show, in the terms the run uses: the new settings when set (a block that is gone shows as the
 * standard template or the academic tone, as the run falls back), else what the old `defaultNoteStyleId` stands for (the
 * upgrade has moved an old style file or template to a block and written the new key, so only a built-in id is read here).
 */
export function shownBlocks(plugin: VisualAgentMapPlugin): ShownBlocks {
  const { settings, noteStyles: store } = plugin;
  const chosen = settings.defaultNoteStyleId ?? settings.defaultDetailTemplateId ?? "standard";
  const preset = NOTE_STYLE_PRESETS.find(item => item.id === chosen);
  const standard = NOTE_STYLE_PRESETS[0];
  const has = (category: BlockCategory, ref: string | undefined): ref is string =>
    ref !== undefined && store.listBlocks(category).some(item => item.ref === ref);
  const effective = store.effectiveBlockKeys();
  const keyed = effective.template;
  const template = keyed
    ? has("template", keyed)
      ? keyed
      : builtinRef(standard.templateId)
    : preset
      ? builtinRef(preset.templateId)
      : builtinRef(standard.templateId);
  const toneKey = effective.tone;
  const tone = toneKey
    ? has("tone", toneKey)
      ? toneKey
      : builtinRef(standard.toneId)
    : builtinRef((preset ?? standard).toneId);
  return { template, tone };
}

/**
 * Writes the shown blocks into the settings, so what the rows show is what runs use. `changed` is the one the user just
 * picked. A key an unfinished upgrade holds in memory (not saved yet) is left alone, so a retry still brings in its
 * result: the other row's shown value is not written over it.
 */
function writeShown(plugin: VisualAgentMapPlugin, changed?: { category: BlockCategory; value: string }): void {
  const { settings, noteStyles: store } = plugin;
  const shown = shownBlocks(plugin);
  const held = store.effectiveBlockKeys();
  const saved: Record<BlockCategory, string | undefined> = {
    template: settings.noteTemplateBlock,
    tone: settings.noteToneBlock
  };
  const next: Record<BlockCategory, string | undefined> = { template: shown.template, tone: shown.tone };
  for (const category of ["template", "tone"] as const) {
    if (changed?.category === category) next[category] = changed.value;
    else if ((!saved[category] && held[category]) || missingBlockRef(plugin, category)) next[category] = undefined;
  }
  if (next.template !== undefined) settings.noteTemplateBlock = next.template;
  if (next.tone !== undefined) settings.noteToneBlock = next.tone;
}

/** The effect line of a built-in block (what it does to the notes), by category and id. */
const BLOCK_HINTS: Record<BlockCategory, Record<string, TranslationKey>> = {
  template: {
    standard: "ui.note_style_standard_hint",
    textbook: "ui.note_style_textbook_hint",
    hypothesis: "ui.note_style_hypothesis_hint",
    evidence: "ui.note_style_evidence_hint",
    action: "ui.note_style_action_hint",
    atomic: "ui.note_style_atomic_hint"
  },
  tone: {
    academic: "ui.tone_hint_academic",
    plain: "ui.tone_hint_plain",
    magazine: "ui.tone_hint_magazine",
    summary: "ui.tone_hint_summary",
    guide: "ui.tone_hint_guide",
    auto: "ui.tone_hint_auto"
  }
};

/** The saved choice of `category` when no block of that ref exists any more (renamed or deleted file); else undefined. */
export function missingBlockRef(plugin: VisualAgentMapPlugin, category: BlockCategory): string | undefined {
  const { noteStyles: store } = plugin;
  const key = store.effectiveBlockKeys()[category];
  if (!key) return undefined;
  return store.listBlocks(category).some(item => item.ref === key) ? undefined : key;
}

/**
 * The "Structure" or "Voice" row of the note style setting: a picker over the built-in and the user's own blocks (two
 * groups), one "Edit" button, and a "More actions" button that opens a menu with only the actions that apply (Save as my
 * own, Restore built-in, Show in file explorer). The first action writes both shown values into the settings, so what
 * the rows show is what runs use. Controls are off while an action runs; focus stays on the control used, or on the
 * picker when the choice changed.
 *
 * The first line of the description says what the block does; a second line appears only when the block needs a word
 * (edited, has a problem, not found). A saved choice whose block is gone shows "Not found: <name>" and offers no Edit;
 * the saved value is not rewritten.
 */
export function renderNoteBlockSetting(
  setting: Setting,
  plugin: VisualAgentMapPlugin,
  category: BlockCategory,
  onFilesChanged?: () => void
): void {
  const { noteStyles: store } = plugin;
  const isTemplate = category === "template";
  const label = t(isTemplate ? "ui.block_picker_template" : "ui.block_picker_tone");
  setting.setName(label);
  setting.descEl.setAttr("aria-live", "polite");
  setting.settingEl.addClass("vam-block-row");
  // The description is a live region: it is written only when its text changes, so a screen reader does not repeat it.
  let shownDesc: string | undefined;
  let busy = false;
  // Until the first read of the block files is done, a saved file choice is not called "not found".
  let loaded = false;
  let picker: DropdownComponent | undefined;
  let editButton: ButtonComponent | undefined;
  let moreButton: ExtraButtonComponent | undefined;
  let current: BlockListItem | undefined;
  let missing: string | undefined;
  const lock = (button: ButtonComponent | undefined, disabled: boolean): void => {
    button?.setDisabled(disabled);
    button?.buttonEl.setAttr("aria-disabled", String(disabled));
  };
  const writeDesc = (lines: { text: string; error?: boolean }[]): void => {
    const key = lines.map(line => `${line.error ? "!" : ""}${line.text}`).join("\n");
    if (key === shownDesc) return;
    shownDesc = key;
    setting.descEl.empty();
    for (const line of lines)
      setting.descEl.createDiv({ text: line.text, cls: line.error ? "vam-block-status-error" : undefined });
  };
  const render = (): void => {
    if (!picker) return;
    const items = store.listBlocks(category);
    picker.selectEl.replaceChildren();
    missing = loaded ? missingBlockRef(plugin, category) : undefined;
    const optionText = (item: BlockListItem): string =>
      item.issues.length
        ? t("ui.note_style_unusable_option_0", item.name)
        : item.modified
          ? t("ui.block_modified_0", item.name)
          : item.name;
    const addGroup = (title: string, group: BlockListItem[]): void => {
      if (!group.length) return;
      const groupEl = picker!.selectEl.createEl("optgroup", { attr: { label: title } });
      for (const item of group) groupEl.createEl("option", { value: item.ref, text: optionText(item) });
    };
    const missingName = (): string => {
      const parsed = parseBlockRef(missing);
      return parsed?.kind === "file" ? parsed.base : parsed?.kind === "builtin" ? parsed.id : (missing ?? "");
    };
    if (missing) picker.addOption(missing, t("ui.block_missing_option_0", missingName()));
    addGroup(
      t("ui.block_group_builtin"),
      items.filter(item => item.kind === "builtin")
    );
    addGroup(
      t("ui.note_style_group_folder"),
      items.filter(item => item.kind === "file")
    );
    const value = missing ?? shownBlocks(plugin)[category];
    picker.setValue(value);
    current = missing ? undefined : items.find(entry => entry.ref === value);
    picker.setDisabled(busy);
    lock(editButton, busy);
    if (missing) editButton?.buttonEl.hide();
    else editButton?.buttonEl.show();
    moreButton?.setDisabled(busy);
    const fallback = isTemplate ? "template" : "tone";
    const lines: { text: string; error?: boolean }[] = [];
    if (missing) lines.push({ text: t(`ui.block_status_missing_${fallback}_0`, missingName()), error: true });
    else if (current) {
      const builtinId = parseBlockRef(current.ref);
      if (current.kind === "file") lines.push({ text: t(`ui.block_status_own_${fallback}`) });
      else if (builtinId?.kind === "builtin" && BLOCK_HINTS[category][builtinId.id])
        lines.push({ text: t(BLOCK_HINTS[category][builtinId.id]) });
      const issue = current.issues[0];
      if (issue)
        lines.push({
          text: t(`ui.block_status_issue_${fallback}_0_1`, issue.line, styleIssueText(issue)),
          error: true
        });
      else if (current.modified) lines.push({ text: t(`ui.block_status_modified_${fallback}`) });
    }
    writeDesc(lines);
  };
  /** Writes the two shown values into the settings, then runs `action`. */
  const act = async (action: (ref: string) => Promise<void>, target: () => HTMLElement | undefined): Promise<void> => {
    if (busy) return;
    busy = true;
    render();
    try {
      const shown = shownBlocks(plugin);
      writeShown(plugin);
      await plugin.saveSettings();
      await action(shown[category]);
    } catch {
      /* The plugin methods report their failures in a Notice. */
    } finally {
      busy = false;
      render();
      target()?.focus();
      onFilesChanged?.();
    }
  };
  /** Asks for a name (the default is "<name> (my version)"; a taken name is refused as it is typed), then saves, selects and opens. */
  const saveAs = (): void => {
    const item = current;
    if (busy || !item) return;
    const items = store.listBlocks(category);
    const reserved = new Set<string>();
    for (const entry of items) {
      reserved.add(entry.name.toLocaleLowerCase());
      const parsed = parseBlockRef(entry.ref);
      if (parsed?.kind === "builtin")
        for (const name of builtinBlockNames(category, parsed.id)) reserved.add(name.toLocaleLowerCase());
    }
    const suggested = copyBlockName(category, item.name, plugin.settings.language, reserved);
    new NameModal(
      plugin.app,
      t("ui.block_save_as_title"),
      suggested,
      name =>
        void act(
          async ref => {
            const created = await plugin.copyBlock(category, ref, name);
            if (created) await plugin.openBlock(category, created);
          },
          () => picker?.selectEl
        ),
      {
        problem: value => {
          const cleaned = cleanBlockName(value).toLocaleLowerCase();
          return !cleaned || reserved.has(cleaned) ? t("ui.block_name_taken") : "";
        }
      }
    ).open();
  };
  const showMenu = (): void => {
    if (busy || !moreButton) return;
    const menu = new Menu();
    const item = current;
    if (item)
      menu.addItem(entry =>
        entry
          .setTitle(t("ui.block_copy"))
          .setIcon("copy")
          .onClick(() => saveAs())
      );
    if (item?.kind === "builtin" && item.modified)
      menu.addItem(entry =>
        entry
          .setTitle(t("ui.block_restore"))
          .setIcon("rotate-ccw")
          .onClick(() =>
            act(
              ref => plugin.restoreBlock(category, ref).then(() => undefined),
              () => moreButton?.extraSettingsEl
            )
          )
      );
    menu.addItem(entry =>
      entry
        .setTitle(t("ui.note_style_open_folder"))
        .setIcon("folder-open")
        .onClick(() => {
          void plugin.openNoteStylesFolder().then(() => moreButton?.extraSettingsEl.focus());
        })
    );
    const rect = moreButton.extraSettingsEl.getBoundingClientRect();
    menu.showAtPosition({ x: rect.left, y: rect.bottom });
  };
  setting.addDropdown(dropdown => {
    picker = dropdown;
    dropdown.selectEl.setAttr(
      "aria-label",
      t(isTemplate ? "ui.block_picker_template_aria" : "ui.block_picker_tone_aria")
    );
    dropdown.onChange(async value => {
      writeShown(plugin, { category, value });
      await plugin.saveSettings();
      render();
    });
  });
  setting.addButton(button => {
    editButton = button;
    button.setButtonText(t("ui.block_open"));
    button.buttonEl.setAttr("aria-label", t(isTemplate ? "ui.block_edit_aria_template" : "ui.block_edit_aria_tone"));
    button.onClick(() =>
      act(
        ref => plugin.openBlock(category, ref).then(() => undefined),
        () => editButton?.buttonEl
      )
    );
  });
  setting.addExtraButton(button => {
    moreButton = button;
    const moreLabel = t(isTemplate ? "ui.block_more_template" : "ui.block_more_tone");
    button.setIcon("more-horizontal").setTooltip(moreLabel).onClick(showMenu);
    button.extraSettingsEl.setAttr("aria-label", moreLabel);
  });
  render();
  void store.refresh().then(
    () => {
      loaded = true;
      render();
    },
    () => undefined
  );
}

/** The "By topic type" sub-heading and its one-line help. */
export function renderNoteKindHeading(setting: Setting): void {
  setting.setName(t("ui.note_style_by_kind")).setDesc(t("ui.note_style_by_kind_desc")).setHeading();
}

/** The rows, in the order the page shows them. */
const KIND_ROWS: readonly TopicKind[] = ["topic", "atomic", "hypothesis", "evidence", "conclusion", "action"];

/** Topic types that have a built-in structure of their own, offered first in that type's picker. */
const KIND_SUGGESTED: ReadonlySet<TopicKind> = new Set<TopicKind>(["atomic", "hypothesis", "evidence", "action"]);

/**
 * One "By topic type" row: a single picker (no Edit, no more-actions menu) for the structure topics of `kind` use when
 * neither the run nor the topic picked one. "Not set" removes the kind from `noteTemplateByKind` (and the whole key when
 * it is empty). A saved structure that is gone shows "Not found: X" selected; one with a problem is marked, with its
 * first problem on the description line. The saved value is never rewritten except by the user's pick.
 */
export function renderNoteKindSetting(setting: Setting, plugin: VisualAgentMapPlugin, kind: TopicKind): void {
  const { noteStyles: store, settings } = plugin;
  const kindName = t(`ui.topic_kind_${kind}`);
  setting.setName(kindName);
  setting.descEl.setAttr("aria-live", "polite");
  setting.settingEl.addClass("vam-block-row");
  let loaded = false;
  let picker: DropdownComponent | undefined;
  let shownDesc: string | undefined;
  const writeDesc = (line: { text: string; error?: boolean } | undefined): void => {
    const key = line ? `${line.error ? "!" : ""}${line.text}` : "";
    if (key === shownDesc) return;
    shownDesc = key;
    setting.descEl.empty();
    if (line) setting.descEl.createDiv({ text: line.text, cls: line.error ? "vam-block-status-error" : undefined });
  };
  const render = (): void => {
    if (!picker) return;
    const items = store.listBlocks("template");
    const saved = settings.noteTemplateByKind?.[kind];
    const missing = loaded && saved && !items.some(item => item.ref === saved) ? saved : undefined;
    picker.selectEl.replaceChildren();
    picker.addOption("", t("ui.note_style_kind_none"));
    const optionText = (item: BlockListItem): string =>
      item.issues.length
        ? t("ui.note_style_unusable_option_0", item.name)
        : item.modified
          ? t("ui.block_modified_0", item.name)
          : item.name;
    const addGroup = (title: string, group: BlockListItem[]): void => {
      if (!group.length) return;
      const groupEl = picker!.selectEl.createEl("optgroup", { attr: { label: title } });
      for (const item of group) groupEl.createEl("option", { value: item.ref, text: optionText(item) });
    };
    if (missing) {
      const parsed = parseBlockRef(missing);
      const name = parsed?.kind === "file" ? parsed.base : parsed?.kind === "builtin" ? parsed.id : missing;
      picker.addOption(missing, t("ui.block_missing_option_0", name));
    }
    const suggestedRef = KIND_SUGGESTED.has(kind) ? builtinRef(kind) : undefined;
    const builtins = items.filter(item => item.kind === "builtin");
    addGroup(
      t("ui.suggested"),
      builtins.filter(item => item.ref === suggestedRef)
    );
    addGroup(
      t("ui.block_group_builtin"),
      builtins.filter(item => item.ref !== suggestedRef)
    );
    addGroup(
      t("ui.note_style_group_folder"),
      items.filter(item => item.kind === "file")
    );
    picker.setValue(saved && (missing || items.some(item => item.ref === saved)) ? saved : "");
    const current = saved ? items.find(item => item.ref === saved) : undefined;
    const issue = current?.issues[0];
    if (missing) {
      const parsed = parseBlockRef(missing);
      const name = parsed?.kind === "file" ? parsed.base : parsed?.kind === "builtin" ? parsed.id : missing;
      writeDesc({ text: `⚠ ${t("ui.note_style_kind_missing_0_1", kindName, name)}`, error: true });
    } else if (issue) {
      const stand = current?.kind === "file" ? t("ui.note_style_standard_short") : (current?.name ?? "");
      writeDesc({ text: t("ui.note_style_kind_issue_0_1_2", issue.line, styleIssueText(issue), stand), error: true });
    } else writeDesc(undefined);
  };
  setting.addDropdown(dropdown => {
    picker = dropdown;
    dropdown.selectEl.setAttr("aria-label", t("ui.note_style_kind_row_aria_0", kindName));
    dropdown.onChange(async value => {
      if (value === "") {
        if (settings.noteTemplateByKind) {
          delete settings.noteTemplateByKind[kind];
          if (!Object.keys(settings.noteTemplateByKind).length) delete settings.noteTemplateByKind;
        }
      } else settings.noteTemplateByKind = { ...settings.noteTemplateByKind, [kind]: value };
      await plugin.saveSettings();
      render();
    });
  });
  render();
  void store.refresh().then(
    () => {
      loaded = true;
      render();
    },
    () => undefined
  );
}

export const CODEX_INSTALL_URL = "https://developers.openai.com/codex/cli/";
export const CLAUDE_INSTALL_URL = "https://code.claude.com/docs/en/setup";

/** The parts of an Obsidian text field the folder binding uses (also what tests fake). */
export interface MapFolderInput {
  inputEl: HTMLInputElement;
  getValue(): string;
  setValue(value: string): unknown;
}

/**
 * A folder-name field changes the folder on disk, so it submits once: on blur or Enter, never per keystroke, never twice
 * for the same value (Enter blurs the field, which would otherwise submit again), and the field is locked while it runs.
 * The settings window is closed first: in Obsidian 1.14 it is a separate window, and the "update links" prompts and the
 * progress notice belong in the main window (closing Settings mid-move would count as "Do not update").
 */
export function bindMapFolderInput(
  plugin: VisualAgentMapPlugin,
  key: "mindMapsFolder" | "aimFolder",
  input: MapFolderInput
): void {
  const workspace = plugin.settings.workspaceFolder;
  const relative = (path: string): string =>
    path.startsWith(`${workspace}/`) ? path.slice(workspace.length + 1) : path;
  let running = false;
  const apply = (): void => {
    if (running) return;
    const name = input
      .getValue()
      .trim()
      .replace(/[\\/]+/g, "/")
      .replace(/^\/+|\/+$/g, "");
    const target = `${workspace}/${name}`;
    if (target === plugin.settings[key]) return;
    running = true;
    input.inputEl.disabled = true;
    const settingsWindow = (plugin.app as unknown as { setting?: { close?: () => void } }).setting;
    try {
      settingsWindow?.close?.();
    } catch {
      /* Closing is a convenience; the change still runs. */
    }
    void plugin
      .mutate(() => plugin.changeMapFolder(key, target))
      .catch(() => {
        /* mutate() already reported the failure in a Notice. */
      })
      .finally(() => {
        running = false;
        input.inputEl.disabled = false;
        input.setValue(relative(plugin.settings[key]));
      });
  };
  input.inputEl.addEventListener("blur", apply);
  input.inputEl.addEventListener("keydown", event => {
    if (event.key === "Enter") input.inputEl.blur();
  });
}

/** True when `values` list every supported interface language, which identifies the language dropdown. */
const offersEveryLanguage = (values: readonly string[]): boolean =>
  SUPPORTED_LANGUAGES.every(item => values.includes(item.id));

export class CodexSetupModal extends Modal {
  constructor(
    app: App,
    private executable: string,
    private recheck: () => void
  ) {
    super(app);
  }
  onOpen(): void {
    this.titleEl.setText(t("ui.install_and_connect_codex"));
    this.contentEl.createEl("p", { text: t("ui.codex_setup_for_ai_only"), cls: "vam-modal-intro" });
    const steps = this.contentEl.createEl("ol", { cls: "vam-setup-steps" });
    const install = steps.createEl("li");
    install.appendText(t("ui.open_the_official_codex_cli_installation_guide_and_complete"));
    install.createEl("a", {
      text: t("ui.official_codex_cli_installation_guide"),
      href: CODEX_INSTALL_URL,
      attr: { target: "_blank", rel: "noopener noreferrer" }
    });
    steps.createEl("li", { text: t("ui.run_codex_in_terminal_and_sign_in_with_your_chatgpt_account") });
    steps.createEl("li", { text: t("ui.return_to_vam_and_select_i_ve_finished_check_again") });
    this.contentEl.createEl("p", {
      text: t("ui.no_api_key_is_required_the_standalone_codex_cli_does_not_req"),
      cls: "vam-setup-note"
    });
    this.contentEl.createEl("p", { text: t("ui.path_currently_checked_0", this.executable), cls: "vam-setup-path" });
    new Setting(this.contentEl)
      .addButton(button => button.setButtonText(t("ui.do_this_later")).onClick(() => this.close()))
      .addButton(button =>
        button
          .setButtonText(t("ui.i_ve_finished_check_again"))
          .setCta()
          .onClick(() => {
            this.close();
            this.recheck();
          })
      );
  }
}
export class AiUsageModal extends Modal {
  private settled = false;
  constructor(
    app: App,
    private provider: "codex" | "claude",
    private resolve: (confirmed: boolean) => void
  ) {
    super(app);
  }
  onOpen(): void {
    const claude = this.provider === "claude";
    this.titleEl.setText(claude ? t("ui.claude_usage_notice") : t("ui.codex_allowance_notice"));
    this.contentEl.createEl("p", {
      text: t(
        claude
          ? "ui.vam_runs_ai_tasks_through_your_claude_code_account_and_uses"
          : "ui.vam_runs_ai_tasks_through_your_signed_in_codex_account_and_u"
      ),
      cls: "vam-modal-intro"
    });
    const finish = (confirmed: boolean): void => {
      this.settled = true;
      this.close();
      this.resolve(confirmed);
    };
    new Setting(this.contentEl)
      .addButton(button => button.setButtonText(t("ui.cancel")).onClick(() => finish(false)))
      .addButton(button =>
        button
          .setButtonText(t("ui.understand_and_run"))
          .setCta()
          .onClick(() => finish(true))
      );
  }
  onClose(): void {
    if (!this.settled) this.resolve(false);
  }
}
export class ClaudeSetupModal extends Modal {
  constructor(
    app: App,
    private executable: string,
    private url: string,
    private recheck: () => void
  ) {
    super(app);
  }
  onOpen(): void {
    this.titleEl.setText(t("ui.install_and_connect_claude_code"));
    this.contentEl.createEl("p", { text: t("ui.claude_code_is_only_needed_for_ai_tasks"), cls: "vam-modal-intro" });
    const steps = this.contentEl.createEl("ol", { cls: "vam-setup-steps" });
    const install = steps.createEl("li");
    install.appendText(t("ui.install_claude_code_and_sign_in_with_your_claude_account"));
    install.createEl("a", {
      text: t("ui.official_claude_code_installation_guide"),
      href: this.url,
      attr: { target: "_blank", rel: "noopener noreferrer" }
    });
    steps.createEl("li", { text: t("ui.return_to_vam_and_check_the_cli_path_again") });
    this.contentEl.createEl("p", { text: t("ui.path_currently_checked_0", this.executable), cls: "vam-setup-path" });
    new Setting(this.contentEl)
      .addButton(button => button.setButtonText(t("ui.do_this_later")).onClick(() => this.close()))
      .addButton(button =>
        button
          .setButtonText(t("ui.check_again"))
          .setCta()
          .onClick(() => {
            this.close();
            this.recheck();
          })
      );
  }
}
export class VisualAgentMapSettingTab extends PluginSettingTab {
  private readonly modelSelects = new Set<HTMLSelectElement>();
  private readonly modelStatusEls = new Set<HTMLElement>();
  private unsubscribeCurrentModel: (() => void) | null = null;
  /** Rewrites the File location row's description (it follows the Structure and Voice rows making files). */
  private noteLocationChanged: (() => void) | undefined;
  constructor(
    app: App,
    private plugin: VisualAgentMapPlugin
  ) {
    super(app, plugin);
    plugin.subscribeModelDiscovery(() => {
      for (const select of [...this.modelSelects]) {
        if (!select.isConnected) {
          this.modelSelects.delete(select);
          continue;
        }
        syncModelSelect(
          select,
          plugin.availableModels(),
          id => plugin.modelLabel(id),
          t("ui.current_model_is_unavailable")
        );
      }
      const codex = plugin.modelDiscoveryState("codex"),
        claude = plugin.modelDiscoveryState("claude");
      const status = modelDiscoverySummary(codex, claude);
      for (const element of [...this.modelStatusEls]) {
        if (!element.isConnected) this.modelStatusEls.delete(element);
        else element.setText(status);
      }
    });
  }
  /** Shows the current model in one dropdown, keeping an unavailable id as a disabled entry. */
  private showCurrentModel(select: HTMLSelectElement, model: string): void {
    if (!Array.from(select.options).some(option => option.value === model)) select.add(new Option(model, model));
    select.value = model;
    syncModelSelect(
      select,
      this.plugin.availableModels(),
      id => this.plugin.modelLabel(id),
      t("ui.current_model_is_unavailable")
    );
    select.value = model;
  }
  /** The chat menu and this page edit one value: follow it while the page is open, drop it when the page closes. */
  private followCurrentModel(): void {
    this.unsubscribeCurrentModel?.();
    this.unsubscribeCurrentModel = this.plugin.subscribeCurrentModel(model => {
      for (const select of [...this.modelSelects]) {
        if (!select.isConnected) this.modelSelects.delete(select);
        else this.showCurrentModel(select, model);
      }
    });
  }
  hide(): void {
    this.unsubscribeCurrentModel?.();
    this.unsubscribeCurrentModel = null;
    super.hide();
  }
  refreshAfterLanguageChange(): void {
    const focused =
      typeof document !== "undefined" &&
      document.activeElement &&
      this.containerEl.contains(document.activeElement) &&
      document.activeElement.instanceOf(HTMLSelectElement) &&
      offersEveryLanguage(Array.from(document.activeElement.options).map(option => option.value));
    this.update();
    if (!focused) return;
    const selector = Array.from(this.containerEl.querySelectorAll<HTMLSelectElement>("select")).find(select => {
      return offersEveryLanguage(Array.from(select.options).map(option => option.value));
    });
    selector?.focus();
  }
  /** Folder name (relative to the workspace folder) for new Mind Maps / AIM maps; stored as a full path. */
  private renderMapFolderSetting(
    setting: Setting,
    key: "mindMapsFolder" | "aimFolder",
    label: "ui.mind_maps_folder" | "ui.aim_maps_folder",
    fallback: string
  ): void {
    const workspace = this.plugin.settings.workspaceFolder,
      current = this.plugin.settings[key];
    const shown = current.startsWith(`${workspace}/`) ? current.slice(workspace.length + 1) : current;
    setting
      .setName(t(label))
      .setDesc(t("ui.settings_map_folder_desc_0", workspace))
      .addText(input => {
        input.setPlaceholder(fallback).setValue(shown);
        bindMapFolderInput(this.plugin, key, input);
      });
  }
  getSettingDefinitions(): SettingDefinitionItem[] {
    const aiConnectionPage: SettingDefinitionPage = {
      type: "page",
      name: t("ui.settings_ai_connection_name"),
      desc: t("ui.settings_ai_connection_desc"),
      displayValue: () => this.aiConnectionValue(),
      status: () => this.aiConnectionStatus(),
      items: [
        {
          name: t("ui.settings_ai_connection_intro"),
          searchable: false,
          render: setting => renderSettingsIntro(setting, t("ui.settings_ai_connection_intro"))
        },
        this.cliGroup(
          "Codex",
          "codex",
          t("ui.settings_codex_path_desc"),
          "ui.codex_cli_was_not_found_follow_the_installation_guide_to_ins"
        ),
        this.cliGroup(
          "Claude Code",
          "claude",
          t("ui.settings_claude_path_desc"),
          "ui.claude_cli_was_not_found_follow_the_installation_guide_to_install_it"
        )
      ]
    };
    const noteKindPage: SettingDefinitionPage = {
      type: "page",
      name: t("ui.note_style_by_kind"),
      desc: t("ui.settings_by_kind_desc"),
      displayValue: () => this.noteKindValue(),
      status: () => this.noteKindStatus(),
      items: [
        {
          name: t("ui.settings_by_kind_intro"),
          searchable: false,
          render: setting => renderSettingsIntro(setting, t("ui.settings_by_kind_intro"))
        },
        ...KIND_ROWS.map(kind => ({
          name: t(`ui.topic_kind_${kind}`),
          render: (setting: Setting) => renderNoteKindSetting(setting, this.plugin, kind)
        }))
      ]
    };
    const noteStylePage: SettingDefinitionPage = {
      type: "page",
      name: t("ui.note_style"),
      desc: t("ui.settings_note_style_page_desc"),
      displayValue: () => this.noteStyleValue(),
      status: () => this.noteStyleStatus(),
      items: [
        {
          name: t("ui.settings_note_style_intro"),
          searchable: false,
          render: setting => renderNoteStyleIntro(setting, this.plugin)
        },
        {
          type: "group",
          heading: t("ui.settings_group_default"),
          items: [
            {
              name: t("ui.settings_structure"),
              render: setting => {
                renderNoteBlockSetting(setting, this.plugin, "template", () => this.noteLocationChanged?.());
                setting.setName(t("ui.settings_structure"));
              }
            },
            {
              name: t("ui.settings_voice"),
              render: setting => {
                renderNoteBlockSetting(setting, this.plugin, "tone", () => this.noteLocationChanged?.());
                setting.setName(t("ui.settings_voice"));
              }
            }
          ]
        },
        {
          type: "group",
          heading: t("ui.settings_group_more"),
          items: [
            noteKindPage,
            {
              name: t("ui.note_style_folder_path"),
              render: setting => {
                this.noteLocationChanged = renderNoteLocationSetting(setting, this.plugin, () => this.update());
              }
            }
          ]
        }
      ]
    };
    const advancedPage: SettingDefinitionPage = {
      type: "page",
      name: t("ui.settings_advanced_name"),
      desc: t("ui.settings_advanced_desc"),
      items: [
        {
          type: "group",
          heading: t("ui.settings_group_debug"),
          items: [
            {
              name: t("ui.record_ai_exchanges"),
              render: setting => {
                setting
                  .setName(t("ui.record_ai_exchanges"))
                  .setDesc(t("ui.settings_record_desc"))
                  .addToggle(toggle =>
                    toggle.setValue(this.plugin.settings.aiExchangeLoggingEnabled).onChange(async value => {
                      this.plugin.settings.aiExchangeLoggingEnabled = value;
                      await this.plugin.saveSettings();
                    })
                  );
              }
            }
          ]
        },
        {
          type: "group",
          heading: t("ui.settings_group_workspace"),
          items: [
            {
              name: t("ui.settings_workspace_location"),
              render: setting => {
                setting
                  .setName(t("ui.settings_workspace_location"))
                  .setDesc(
                    t(
                      "ui.settings_workspace_location_desc_0_1",
                      this.plugin.settings.workspaceFolder,
                      this.plugin.settings.topicsFolder
                    )
                  );
              }
            },
            this.actionRow(
              t("ui.settings_repair_name"),
              t("ui.settings_repair_desc"),
              t("ui.repair"),
              () => void this.plugin.mutate(() => this.plugin.repairWorkspace())
            ),
            this.actionRow(
              t("ui.settings_rebuild_name"),
              t("ui.settings_rebuild_desc"),
              t("ui.full_rebuild"),
              () => void this.plugin.mutate(() => this.plugin.fullRebuild())
            ),
            this.actionRow(
              t("ui.reconnect_existing_workspace"),
              t("ui.settings_reconnect_desc"),
              t("ui.scan"),
              () => void this.plugin.offerWorkspaceReconnect()
            )
          ]
        }
      ]
    };
    return [
      {
        type: "group",
        heading: t("ui.settings_group_general"),
        items: [
          {
            name: t("ui.interface_language"),
            render: setting => {
              setting
                .setName(t("ui.interface_language"))
                .setDesc(t("ui.settings_language_desc"))
                .addDropdown(dropdown => {
                  for (const option of SUPPORTED_LANGUAGES) dropdown.addOption(option.id, option.label);
                  dropdown.setValue(this.plugin.settings.language).setDisabled(this.plugin.languageSwitchPending);
                  dropdown.onChange(value => {
                    void this.plugin.changeLanguage(value);
                  });
                });
            }
          }
        ]
      },
      {
        type: "group",
        heading: t("ui.settings_group_ai"),
        items: [
          {
            name: t("ui.settings_model_name"),
            render: setting => {
              this.followCurrentModel();
              setting
                .setName(t("ui.settings_model_name"))
                .setDesc(t("ui.settings_model_desc"))
                .addDropdown(dropdown => {
                  const select = (dropdown as unknown as { selectEl: HTMLSelectElement }).selectEl;
                  this.modelSelects.add(select);
                  const selected = this.plugin.settings.cliModel;
                  this.showCurrentModel(select, selected);
                  dropdown.setValue(selected);
                  dropdown.onChange(value => {
                    void this.setControlValue("cliModel", value);
                  });
                })
                .addButton(button =>
                  button.setButtonText(t("ui.check_again")).onClick(() => {
                    void this.plugin.refreshModelDiscovery("codex");
                    void this.plugin.refreshModelDiscovery("claude");
                  })
                );
              const statusEl = setting.descEl.createDiv({ cls: "vam-model-discovery-status" });
              this.modelStatusEls.add(statusEl);
              statusEl.setText(
                modelDiscoverySummary(
                  this.plugin.modelDiscoveryState("codex"),
                  this.plugin.modelDiscoveryState("claude")
                )
              );
              if (this.plugin.modelDiscoveryState("codex").status === "idle")
                void this.plugin.refreshModelDiscovery("codex");
              if (this.plugin.modelDiscoveryState("claude").status === "idle")
                void this.plugin.refreshModelDiscovery("claude");
            }
          },
          {
            name: t("ui.settings_reasoning_name"),
            desc: t("ui.settings_reasoning_desc"),
            control: {
              type: "dropdown",
              key: "cliReasoning",
              options: { auto: t("ui.auto"), low: t("ui.low"), medium: t("ui.medium"), high: t("ui.high") }
            }
          },
          aiConnectionPage
        ]
      },
      {
        type: "group",
        heading: t("ui.settings_group_notes"),
        items: [
          noteStylePage,
          {
            name: t("ui.settings_selection_ai_name"),
            render: setting => {
              setting
                .setName(t("ui.settings_selection_ai_name"))
                .setDesc(t("ui.settings_selection_ai_desc"))
                .addToggle(toggle =>
                  toggle.setValue(this.plugin.settings.markdownSelectionAiAutoOpen).onChange(async value => {
                    this.plugin.settings.markdownSelectionAiAutoOpen = value;
                    await this.plugin.saveSettings();
                  })
                );
            }
          },
          {
            name: t("ui.add_diagrams_after_research"),
            render: setting => {
              setting
                .setName(t("ui.add_diagrams_after_research"))
                .setDesc(t("ui.settings_diagrams_desc"))
                .addToggle(toggle =>
                  toggle.setValue(this.plugin.settings.addDiagramsAfterResearch).onChange(async value => {
                    this.plugin.settings.addDiagramsAfterResearch = value;
                    await this.plugin.saveSettings();
                  })
                );
            }
          }
        ]
      },
      {
        type: "group",
        heading: t("ui.settings_group_map"),
        items: [
          {
            name: t("ui.preview_card_size"),
            render: setting => {
              setting
                .setName(t("ui.preview_card_size"))
                .setDesc(t("ui.settings_preview_size_desc"))
                .addSlider(slider =>
                  slider
                    .setLimits(80, 240, 5)
                    .setValue(clampPreviewScale(this.plugin.settings.previewScale))
                    .onChange(async value => {
                      this.plugin.settings.previewScale = clampPreviewScale(value);
                      await this.plugin.saveSettings();
                    })
                );
            }
          },
          {
            name: t("ui.mind_maps_folder"),
            render: setting =>
              this.renderMapFolderSetting(setting, "mindMapsFolder", "ui.mind_maps_folder", "Mind Maps")
          },
          {
            name: t("ui.aim_maps_folder"),
            render: setting => this.renderMapFolderSetting(setting, "aimFolder", "ui.aim_maps_folder", "AIM")
          }
        ]
      },
      {
        type: "group",
        heading: t("ui.settings_group_advanced"),
        items: [advancedPage]
      }
    ];
  }
  /** Entry value of the "AI connection" page: how many of the two CLIs were found. */
  private aiConnectionValue(): string {
    const found = [this.plugin.codexDiagnostic().installed, this.plugin.claudeDiagnostic().installed].filter(Boolean);
    return found.length ? t("ui.settings_connected_count_0", found.length) : t("ui.settings_not_connected");
  }
  /** Entry status of the "AI connection" page: needs attention when neither CLI was found. */
  private aiConnectionStatus(): "warning" | null {
    return this.plugin.codexDiagnostic().installed || this.plugin.claudeDiagnostic().installed ? null : "warning";
  }
  /** Entry value of the "Note style" page: "<structure> · <voice>" by name, falling back to the ref. */
  private noteStyleValue(): string {
    try {
      const shown = shownBlocks(this.plugin);
      const nameOf = (category: BlockCategory): string =>
        this.plugin.noteStyles.listBlocks(category).find(item => item.ref === shown[category])?.name ?? shown[category];
      return `${nameOf("template")} · ${nameOf("tone")}`;
    } catch {
      return "";
    }
  }
  /** Entry status of the "Note style" page: a saved structure or voice whose file is gone. */
  private noteStyleStatus(): "warning" | null {
    try {
      return missingBlockRef(this.plugin, "template") || missingBlockRef(this.plugin, "tone") ? "warning" : null;
    } catch {
      return null;
    }
  }
  /** Entry value of the "By topic type" page: how many types have their own structure. */
  private noteKindValue(): string {
    const count = Object.keys(this.plugin.settings.noteTemplateByKind ?? {}).length;
    return count ? t("ui.settings_kinds_set_count_0", count) : t("ui.settings_kinds_unset");
  }
  /** Entry status of the "By topic type" page: a saved structure that no longer exists. */
  private noteKindStatus(): "warning" | null {
    try {
      const refs = new Set(this.plugin.noteStyles.listBlocks("template").map(item => item.ref));
      const saved = Object.values(this.plugin.settings.noteTemplateByKind ?? {});
      return saved.some(ref => ref && !refs.has(ref)) ? "warning" : null;
    } catch {
      return null;
    }
  }
  /** One CLI group of the "AI connection" page: status (with install guide and re-check) and the executable path. */
  private cliGroup(
    heading: string,
    provider: "codex" | "claude",
    pathDesc: string,
    notFoundDesc: TranslationKey
  ): SettingDefinitionGroup {
    const diagnostic = () => (provider === "codex" ? this.plugin.codexDiagnostic() : this.plugin.claudeDiagnostic());
    return {
      type: "group",
      heading,
      items: [
        {
          name: t("ui.settings_status"),
          render: setting => {
            const found = diagnostic();
            setting
              .setName(t("ui.settings_status"))
              .setDesc(found.installed ? t("ui.settings_cli_found_0", found.executable) : t(notFoundDesc));
            if (!found.installed)
              setting.addButton(button =>
                button
                  .setButtonText(t("ui.installation_guide"))
                  .onClick(() =>
                    provider === "codex" ? this.plugin.openCodexSetupGuide() : this.plugin.openClaudeSetupGuide()
                  )
              );
            setting.addButton(button =>
              button.setButtonText(t("ui.check_again")).onClick(() => {
                void (provider === "codex" ? this.plugin.recheckCodex() : this.plugin.recheckClaude());
              })
            );
          }
        },
        {
          name: t("ui.settings_cli_path"),
          desc: pathDesc,
          control: { type: "text", key: provider === "codex" ? "codexPath" : "claudePath" }
        }
      ]
    };
  }
  /** A button row of the "Advanced" page: name, one-line help and one button. */
  private actionRow(name: string, desc: string, label: string, run: () => void): SettingDefinition {
    return {
      name,
      render: setting => {
        setting
          .setName(name)
          .setDesc(desc)
          .addButton(button => button.setButtonText(label).onClick(run));
      }
    };
  }
  async setControlValue(key: string, value: unknown): Promise<void> {
    if (key === "language") {
      await this.plugin.changeLanguage(value);
      return;
    } else if (key === "cliModel") {
      if (typeof value === "string") await this.plugin.setCurrentModel(value);
      return;
    } else if (typeof value === "string" && (key === "codexPath" || key === "claudePath"))
      this.plugin.settings[key] = value.trim();
    else if (key === "cliReasoning") this.plugin.settings.cliReasoning = normalizeReasoningLevel(value);
    else return;
    if (key === "codexPath") this.plugin.resetCodexRuntime();
    if (key === "claudePath") this.plugin.modelDiscovery.invalidate("claude");
    await this.plugin.saveSettings();
    if (key === "codexPath") void this.plugin.refreshModelDiscovery("codex");
    if (key === "claudePath") void this.plugin.refreshModelDiscovery("claude");
  }
}
