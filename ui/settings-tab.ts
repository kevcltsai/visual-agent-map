import type VisualAgentMapPlugin from "../main";
import { SUPPORTED_LANGUAGES, t, type TranslationKey } from "../i18n";
import { normalizeReasoningLevel } from "../repository";
import { modelDiscoverySummary, syncModelSelect } from "../core/model-discovery";
import { clampPreviewScale } from "./preview-utils";
import { App, Modal, normalizePath, PluginSettingTab, Setting } from "obsidian";
import type { SettingDefinition, SettingDefinitionGroup, SettingDefinitionItem, SettingDefinitionPage } from "obsidian";
import type { DropdownComponent } from "obsidian";
import type { RecipeListItem } from "../ai/note-style-store";
import {
  globalPartRef,
  KIND_DEFAULT_RECIPE,
  parseRecipeRef,
  STYLE_KINDS,
  UPDATE_MODE_KEYS,
  type StyleKind
} from "../ai/note-style-recipe";
import { CARD_VOICES } from "../ai/note-style-card-voices";
import { renderRadioGroup } from "./radio-group";
import { BUILTIN_BLOCKS } from "../core/blocks/builtin";
import { openInWindowOf } from "./modals/open-in-window";
import { aimEnabled } from "../experiences/aim/availability";
import { parseBlockRef } from "../core/blocks/block-files";
import { NoteStyleManageModal, recipeIssueText, styleKindName } from "./modals/note-style-manage-modal";

/**
 * A sub-page's opening sentence as a grey description-only row. Obsidian puts the definition `name` into the row
 * before calling render, so the name is cleared here and the sentence shows once, in the description style.
 */
export function renderSettingsIntro(setting: Setting, text: string): void {
  setting.setName("");
  setting.setDesc(text);
}

/** The formats the card offers, each with its one-line explanation. */
const CARD_FORMATS = [
  { id: "standard", name: "ui.note_style_chip_format_standard", desc: "ui.note_style_format_desc_standard" },
  { id: "lean", name: "ui.note_style_chip_format_lean", desc: "ui.note_style_format_desc_lean" },
  { id: "rich", name: "ui.note_style_chip_format_rich", desc: "ui.note_style_format_desc_rich" },
  { id: "skim", name: "ui.note_style_chip_format_skim", desc: "ui.note_style_format_desc_skim" }
] as const satisfies readonly { id: string; name: TranslationKey; desc: TranslationKey }[];

/**
 * The "How notes are written" card at the top of the Note style page: the global voice (chips plus a sample sentence that
 * follows the choice), the global length and layout (chips plus a one-line explanation) and "Preview AI instructions".
 * A chip writes `noteStyleDefaults` (choosing the default again deletes the key); a voice or format that is a file has
 * no chip and no sample, and the card says which one is in use. Opening the page writes nothing.
 */
export function renderNoteStyleCard(setting: Setting, plugin: VisualAgentMapPlugin): void {
  setting.setName(t("ui.note_style_card_title")).setDesc(t("ui.note_style_card_desc"));
  setting.settingEl.addClass("vam-style-card");
  setting.addButton(button => {
    button.setButtonText(t("ui.preview_prompt_open")).onClick(() => plugin.openPromptPreview(button.buttonEl));
    button.buttonEl.addClass("mod-muted");
  });
  const body = setting.settingEl.createDiv({ cls: "vam-style-card-body" });
  const partName = (category: "voice" | "format", ref: string): string => {
    const found = plugin.noteStyles.listParts(category).find(item => item.ref === ref);
    return found?.name ?? ref;
  };
  const draw = (focus?: { category: "voice" | "format"; value: string }): void => {
    body.empty();
    const defaults = plugin.settings.noteStyleDefaults;
    const voice = globalPartRef(defaults, "voice");
    const format = globalPartRef(defaults, "format");
    const voiceChoices = CARD_VOICES.map(item => ({ value: `builtin:${item.id}`, label: t(item.name) }));
    const formatChoices = CARD_FORMATS.map(item => ({ value: `builtin:${item.id}`, label: t(item.name) }));
    const pick = (category: "voice" | "format") => (value: string) => {
      void plugin
        .setGlobalPart(category, value)
        .then(() => {
          redrawKindRows(plugin);
          draw({ category, value });
        })
        .catch(() => undefined);
    };
    const refocus = (category: "voice" | "format", choices: { value: string }[], buttons: HTMLElement[]): void => {
      if (focus?.category !== category) return;
      buttons[choices.findIndex(choice => choice.value === focus.value)]?.focus();
    };
    const voiceButtons = renderRadioGroup(body, t("ui.note_style_voice_label"), voiceChoices, voice, pick("voice"));
    refocus("voice", voiceChoices, voiceButtons);
    const sampleBox = body.createDiv({ cls: "vam-style-sample", attr: { "aria-live": "polite" } });
    const chosen = CARD_VOICES.find(item => `builtin:${item.id}` === voice);
    if (chosen) {
      sampleBox.createSpan({ text: t("ui.note_style_sample_caption"), cls: "vam-style-sample-caption" });
      sampleBox.createSpan({ text: t(chosen.sample) });
    } else {
      sampleBox.createSpan({ text: t("ui.note_style_voice_other_0", partName("voice", voice)) });
    }
    const formatButtons = renderRadioGroup(
      body,
      t("ui.note_style_format_label"),
      formatChoices,
      format,
      pick("format")
    );
    refocus("format", formatChoices, formatButtons);
    const chosenFormat = CARD_FORMATS.find(item => `builtin:${item.id}` === format);
    body.createEl("p", {
      text: chosenFormat ? t(chosenFormat.desc) : t("ui.note_style_format_other_0", partName("format", format)),
      cls: "setting-item-description",
      attr: { "aria-live": "polite" }
    });
  };
  draw();
  void plugin.noteStyles.refresh().then(
    () => draw(),
    () => undefined
  );
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
    ) ||
    store.listParts("format").some(item => item.fileName !== undefined) ||
    store.listRecipes().some(item => item.fileName !== undefined);
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
  locationUpdates.set(plugin, update);
  return update;
}

/** The File location row that is on screen for a plugin: the manage window rewrites it when it closes. */
const locationUpdates = new WeakMap<VisualAgentMapPlugin, () => void>();

/** The style ref a kind uses: the saved choice, else the kind's own built-in style. */
export function shownStyleRef(plugin: VisualAgentMapPlugin, kind: StyleKind): string {
  const saved = plugin.settings.noteStyleByKind?.[kind];
  return typeof saved === "string" && saved ? saved : KIND_DEFAULT_RECIPE[kind];
}

/** The styles a kind's picker offers: everything, except that only the AIM row offers the AIM report. */
function offeredStyles(plugin: VisualAgentMapPlugin, kind: StyleKind): RecipeListItem[] {
  return plugin.noteStyles.listRecipes().filter(item => kind === "aim" || !item.aimOnly);
}

/** The style a kind saved when no style of that ref exists any more (renamed or deleted file); else undefined. */
export function missingStyleRef(plugin: VisualAgentMapPlugin, kind: StyleKind): string | undefined {
  const saved = plugin.settings.noteStyleByKind?.[kind];
  if (typeof saved !== "string" || !saved) return undefined;
  return offeredStyles(plugin, kind).some(item => item.ref === saved) ? undefined : saved;
}

/** Whether a voice ref is a retired built-in (listed nowhere in new choices, but a style may still name it). */
function isRetiredVoice(ref: string): boolean {
  const parsed = parseRecipeRef(ref, "voice");
  return (
    parsed?.kind === "builtin" &&
    BUILTIN_BLOCKS.some(block => block.category === "tone" && block.id === parsed.id && block.retired === true)
  );
}

/**
 * A topic-type row's small line "structure · voice · format · update mode". A voice or format the style fixes itself
 * says "set apart" (the ones that follow the global choice say nothing); a retired voice says "retired". The AIM report
 * has its own voice and format and no update mode, so it is not marked.
 */
export function kindStyleLine(item: RecipeListItem): string {
  const apart = (name: string, source: RecipeListItem["voiceSource"]): string =>
    !item.aimOnly && source === "style" ? t("ui.note_style_set_apart_0", name) : name;
  const voiceName = item.voice.name;
  const voice = apart(
    !item.aimOnly && isRetiredVoice(item.voice.ref) ? t("ui.note_style_voice_retired_0", voiceName) : voiceName,
    item.voiceSource
  );
  const parts = [item.structure.name, voice, apart(item.format.name, item.formatSource)];
  if (!item.aimOnly) parts.push(t(UPDATE_MODE_KEYS[item.update]));
  return parts.join(" · ");
}

/** The small tags beside a topic-type row's name: "voice retired" and "only new content". */
export function kindStyleTags(item: RecipeListItem): { text: string; cls: string }[] {
  if (item.aimOnly) return [];
  const tags: { text: string; cls: string }[] = [];
  if (isRetiredVoice(item.voice.ref)) tags.push({ text: t("ui.note_style_tag_voice_retired"), cls: "is-warn" });
  if (item.update === "fresh") tags.push({ text: t(UPDATE_MODE_KEYS.fresh), cls: "is-info" });
  return tags;
}

/** The topic-type rows that are on screen, by plugin; each draws itself again from the store. */
const kindRows = new WeakMap<VisualAgentMapPlugin, Set<{ el: HTMLElement; redraw: () => void }>>();

/** Draws every topic-type row that is still on screen again (after the manage window saved or deleted a style). */
export function redrawKindRows(plugin: VisualAgentMapPlugin): void {
  const rows = kindRows.get(plugin);
  if (!rows) return;
  for (const row of [...rows]) {
    if (row.el.isConnected === false) rows.delete(row);
    else row.redraw();
  }
}

/**
 * One topic-type row: a single picker over the built-in and the user's own styles (two groups; the AIM row also offers
 * the AIM report, first). There is no "not set": a kind with no saved choice shows its own built-in style, and choosing
 * that style again removes the saved choice. The description says the style's four parts; a saved style that is gone
 * shows "Not found: X" selected with an error line, and one with a problem shows its first problem. The saved value is
 * never rewritten except by the user's pick.
 */
export function renderNoteKindSetting(setting: Setting, plugin: VisualAgentMapPlugin, kind: StyleKind): void {
  const { noteStyles: store } = plugin;
  const kindName = styleKindName(kind);
  setting.setName(kindName);
  setting.descEl.setAttr("aria-live", "polite");
  setting.settingEl.addClass("vam-block-row");
  // The description is a live region: it is written only when its text changes, so a screen reader does not repeat it.
  let shownDesc: string | undefined;
  // Until the first read of the style files is done, a saved file choice is not called "not found".
  let loaded = false;
  let picker: DropdownComponent | undefined;
  let tagEls: HTMLElement[] = [];
  const writeTags = (item: RecipeListItem | undefined): void => {
    for (const el of tagEls) el.remove();
    tagEls = item
      ? kindStyleTags(item).map(tag => setting.nameEl.createSpan({ text: tag.text, cls: `vam-style-tag ${tag.cls}` }))
      : [];
  };
  const writeDesc = (line: { text: string; error?: boolean } | undefined): void => {
    const key = line ? `${line.error ? "!" : ""}${line.text}` : "";
    if (key === shownDesc) return;
    shownDesc = key;
    setting.descEl.empty();
    if (line) setting.descEl.createDiv({ text: line.text, cls: line.error ? "vam-block-status-error" : undefined });
  };
  const render = (): void => {
    if (!picker) return;
    const items = offeredStyles(plugin, kind);
    const missing = loaded ? missingStyleRef(plugin, kind) : undefined;
    picker.selectEl.replaceChildren();
    const optionText = (item: RecipeListItem): string =>
      item.issues.length ? t("ui.note_style_unusable_option_0", item.name) : item.name;
    const addOptions = (parent: HTMLElement, group: RecipeListItem[]): void => {
      for (const item of group) parent.createEl("option", { value: item.ref, text: optionText(item) });
    };
    const addGroup = (title: string, group: RecipeListItem[]): void => {
      if (!group.length) return;
      addOptions(picker!.selectEl.createEl("optgroup", { attr: { label: title } }), group);
    };
    const missingName = (): string => {
      const parsed = parseBlockRef(missing);
      return parsed?.kind === "file" ? parsed.base : parsed?.kind === "builtin" ? parsed.id : (missing ?? "");
    };
    if (missing) picker.addOption(missing, t("ui.block_missing_option_0", missingName()));
    // The AIM report comes first, ahead of the groups.
    addOptions(
      picker.selectEl,
      items.filter(item => item.aimOnly)
    );
    addGroup(
      t("ui.block_group_builtin"),
      items.filter(item => item.kind === "builtin" && !item.aimOnly)
    );
    addGroup(
      t("ui.note_style_group_folder"),
      items.filter(item => item.kind === "file")
    );
    const value = missing ?? shownStyleRef(plugin, kind);
    picker.setValue(value);
    const current = missing ? undefined : items.find(item => item.ref === value);
    const issue = current?.issues[0];
    if (missing) writeDesc({ text: `⚠ ${t("ui.note_style_row_missing_0_1", kindName, missingName())}`, error: true });
    else if (issue)
      writeDesc({ text: t("ui.note_style_recipe_issue_0_1", issue.line, recipeIssueText(issue)), error: true });
    else writeDesc(current ? { text: kindStyleLine(current) } : undefined);
    writeTags(missing || issue ? undefined : current);
  };
  setting.addDropdown(dropdown => {
    picker = dropdown;
    dropdown.selectEl.setAttr("aria-label", t("ui.note_style_kind_row_aria_0", kindName));
    dropdown.onChange(async value => {
      await plugin.setKindStyle(kind, value);
      render();
    });
  });
  render();
  const readAgain = (): void =>
    void store.refresh().then(
      () => {
        loaded = true;
        render();
      },
      () => undefined
    );
  readAgain();
  const rows = kindRows.get(plugin) ?? new Set();
  rows.add({ el: setting.settingEl, redraw: readAgain });
  kindRows.set(plugin, rows);
}

/**
 * The "My styles" row: how many styles and parts are the user's own, how many unused copies there are (the amber line,
 * only when there are any), the folder (a link that shows it in the file explorer) and "Manage…", which opens the manage
 * window in the window the button is in. Counts are written from what was read last, then again after the files are read
 * and after the window closes. Reading is all it does: nothing is created or written.
 */
export function renderMyStylesSetting(setting: Setting, plugin: VisualAgentMapPlugin): void {
  const { noteStyles: store } = plugin;
  const describe = (): void => {
    const own = <T extends { kind: string }>(items: T[]): number => items.filter(item => item.kind === "file").length;
    const styles = own(store.listRecipes());
    const parts = (["structure", "voice", "format"] as const).reduce(
      (sum, category) => sum + own(store.listParts(category)),
      0
    );
    setting.setName(t("ui.my_styles_count_0_1", styles, parts));
    const unused = store.listUnusedCopies().length;
    setting.descEl.empty();
    if (unused) setting.descEl.createDiv({ text: t("ui.my_styles_unused_0", unused), cls: "vam-style-unused" });
    const line = setting.descEl.createDiv({ text: `${t("ui.my_styles_path_desc")} ` });
    const link = line.createEl("a", { text: store.folder(), cls: "vam-field-link", attr: { href: "#", role: "link" } });
    link.addEventListener("click", (event: Event) => {
      event.preventDefault();
      void plugin.openNoteStylesFolder();
    });
  };
  describe();
  setting.addButton(button => {
    button.setButtonText(t("ui.my_styles_manage")).onClick(() => {
      const modal = new NoteStyleManageModal(plugin.app, plugin, "recipe", button.buttonEl, () => {
        describe();
        // The styles may have changed in the window: the topic-type rows of this page are drawn again.
        redrawKindRows(plugin);
        // ...and the File location row says "no files yet" only while there really are none.
        locationUpdates.get(plugin)?.();
      });
      openInWindowOf(modal, button.buttonEl);
    });
    button.buttonEl.setAttr("aria-label", t("ui.my_styles_manage_aria"));
  });
  void store.refresh().then(describe, () => undefined);
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
    // The Enter that picks an IME candidate only finishes the composition; it must not move the folder.
    if (event.key === "Enter" && !event.isComposing) input.inputEl.blur();
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
  /** Set when the language select fired a change; the select is focused again once the switch is done and it is enabled. */
  private refocusLanguage = false;
  refreshAfterLanguageChange(): void {
    // The Settings window can be a popout: its focus lives in its own document, not in the global `document`.
    const active = this.containerEl.doc?.activeElement ?? null;
    const focused =
      this.refocusLanguage ||
      (!!active &&
        this.containerEl.contains(active) &&
        active.instanceOf(HTMLSelectElement) &&
        offersEveryLanguage(Array.from(active.options).map(option => option.value)));
    this.update();
    if (!focused) return;
    // While the switch is pending the new select is disabled and cannot take focus: keep the request for the last refresh.
    if (this.plugin.languageSwitchPending) return;
    this.refocusLanguage = false;
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
    const noteStylePage: SettingDefinitionPage = {
      type: "page",
      name: t("ui.note_style"),
      desc: t("ui.settings_note_style_page_desc"),
      displayValue: () => this.noteStyleValue(),
      status: () => this.noteStyleStatus(),
      items: [
        {
          name: t("ui.note_style_card_title"),
          render: setting => renderNoteStyleCard(setting, this.plugin)
        },
        {
          type: "group",
          heading: t("ui.settings_group_kinds"),
          items: STYLE_KINDS.filter(kind => kind !== "aim" || aimEnabled()).map(kind => ({
            name: kind === "aim" ? t("ui.note_style_kind_aim") : t(`ui.topic_kind_${kind}`),
            render: (setting: Setting) => renderNoteKindSetting(setting, this.plugin, kind)
          }))
        },
        {
          type: "group",
          heading: t("ui.settings_group_my_styles"),
          items: [
            {
              name: t("ui.settings_group_my_styles"),
              render: (setting: Setting) => renderMyStylesSetting(setting, this.plugin)
            }
          ]
        },
        {
          type: "group",
          heading: t("ui.settings_group_more"),
          items: [
            {
              name: t("ui.note_style_folder_path"),
              render: setting => {
                renderNoteLocationSetting(setting, this.plugin, () => this.update());
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
                    // The change comes from this select: the user is on it, even if focus has moved by the time of the redraw.
                    this.refocusLanguage = true;
                    void this.plugin.changeLanguage(value).finally(() => {
                      this.refocusLanguage = false;
                    });
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
          // AIM is hidden in this release (experiences/aim/availability.ts); the aimFolder value is kept untouched.
          ...(aimEnabled()
            ? [
                {
                  name: t("ui.aim_maps_folder"),
                  render: (setting: Setting) =>
                    this.renderMapFolderSetting(setting, "aimFolder", "ui.aim_maps_folder", "AIM")
                }
              ]
            : [])
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
  /** Entry value of the "Note style" page: the style the general topic row shows, by name, falling back to the ref. */
  private noteStyleValue(): string {
    try {
      const ref = shownStyleRef(this.plugin, "topic");
      const name = this.plugin.noteStyles.listRecipes().find(item => item.ref === ref)?.name;
      if (name) return name;
      const parsed = parseBlockRef(ref);
      return parsed?.kind === "file" ? parsed.base : ref;
    } catch {
      return "";
    }
  }
  /** Entry status of the "Note style" page: a row whose saved style is gone. */
  private noteStyleStatus(): "warning" | null {
    try {
      return STYLE_KINDS.some(kind => (kind !== "aim" || aimEnabled()) && missingStyleRef(this.plugin, kind))
        ? "warning"
        : null;
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
    // Committed (change or blur), not while typing: the status rows and the entry value follow the new path.
    if (key === "codexPath" || key === "claudePath") this.updateKeepingFocus();
  }
  /**
   * Redraws the page; the control that had the keyboard (Tab just moved it) is focused again. The control is found by what
   * it is (its setting's name, which of the same-named settings, its label), not by its position: an invalid path adds an
   * "Installation guide" button, so the number of controls before it changes with the redraw.
   */
  private updateKeepingFocus(): void {
    const root = this.containerEl as HTMLElement | undefined;
    const controls = (): Element[] =>
      Array.from(root?.querySelectorAll("input, select, textarea, button, [tabindex]") ?? []);
    const identity = (control: Element): string => {
      const item = control.closest(".setting-item");
      const items = Array.from(root?.querySelectorAll(".setting-item") ?? []);
      const name = item?.querySelector(".setting-item-name")?.textContent?.trim() ?? "";
      const sameName = items.filter(other => other.querySelector(".setting-item-name")?.textContent?.trim() === name);
      const label = (element: Element): string =>
        element.getAttribute("aria-label") ?? (element.textContent?.trim() || element.tagName.toLowerCase());
      const own = controls().filter(
        other => other.closest(".setting-item") === item && label(other) === label(control)
      );
      return JSON.stringify([name, sameName.indexOf(item as Element), label(control), own.indexOf(control)]);
    };
    const active = root?.doc?.activeElement ?? null;
    const wanted = active && root?.contains(active) ? identity(active) : null;
    this.update();
    if (wanted !== null) (controls().find(control => identity(control) === wanted) as HTMLElement | undefined)?.focus();
  }
}
