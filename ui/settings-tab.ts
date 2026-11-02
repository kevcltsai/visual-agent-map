import type VisualAgentMapPlugin from "../main";
import { SUPPORTED_LANGUAGES, t } from "../i18n";
import { normalizeReasoningLevel } from "../repository";
import { modelDiscoverySummary, syncModelSelect } from "../core/model-discovery";
import { NOTE_STYLE_PRESETS } from "../experiences/visual-map/note-style";
import { clampPreviewScale } from "./preview-utils";
import { App, Modal, normalizePath, PluginSettingTab, Setting, type SettingDefinitionItem } from "obsidian";
import type { ButtonComponent, DropdownComponent } from "obsidian";
import { builtinRef } from "../core/blocks/block-files";
import type { BlockCategory } from "../core/blocks/builtin";
import { styleIssueText } from "../experiences/visual-map/note-style-picker";

/**
 * "Note style" row: the style folder (the Template and Tone rows below it pick the workspace default). A folder that
 * is gone (renamed while the plugin was off) shows "Style folder not found" and lets the user pick it again.
 */
export function renderNoteStyleSetting(setting: Setting, plugin: VisualAgentMapPlugin, refresh: () => void): void {
  const store = plugin.noteStyles;
  const settings = plugin.settings;
  const missing = !store.folderExists();
  setting
    .setName(t("ui.note_style"))
    .setDesc(missing ? t("ui.note_style_folder_missing_desc_0", store.folder()) : t("ui.note_style_setting_desc"));
  if (missing) {
    setting.nameEl.setText(`${t("ui.note_style")} · ${t("ui.note_style_folder_missing")}`);
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
  setting.addButton(button =>
    button.setButtonText(t("ui.preview_prompt_open")).onClick(() => plugin.openPromptPreview(button.buttonEl))
  );
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
    else if (!saved[category] && held[category]) next[category] = undefined;
  }
  if (next.template !== undefined) settings.noteTemplateBlock = next.template;
  if (next.tone !== undefined) settings.noteToneBlock = next.tone;
}

/**
 * The "Template" or "Tone" row of the note style setting: a picker over the built-in and the user's own blocks, and the
 * buttons Open, Copy and Restore default. The first action writes both shown values into the settings, so what the rows
 * show is what runs use. Buttons are off while an action runs; focus stays on the button used, or on the picker when the
 * choice changed.
 */
export function renderNoteBlockSetting(setting: Setting, plugin: VisualAgentMapPlugin, category: BlockCategory): void {
  const { noteStyles: store } = plugin;
  const isTemplate = category === "template";
  const label = t(isTemplate ? "ui.block_picker_template" : "ui.block_picker_tone");
  setting.setName(label);
  setting.descEl.setAttr("aria-live", "polite");
  setting.settingEl.addClass("vam-block-row");
  // The description is a live region: it is written only when its text changes, so a screen reader does not repeat it.
  let shownDesc: string | undefined;
  let busy = false;
  let picker: DropdownComponent | undefined;
  let openButton: ButtonComponent | undefined;
  let copyButton: ButtonComponent | undefined;
  let restoreButton: ButtonComponent | undefined;
  const lock = (button: ButtonComponent | undefined, disabled: boolean): void => {
    button?.setDisabled(disabled);
    button?.buttonEl.setAttr("aria-disabled", String(disabled));
  };
  const render = (): void => {
    if (!picker) return;
    const shown = shownBlocks(plugin);
    const items = store.listBlocks(category);
    picker.selectEl.replaceChildren();
    for (const item of items)
      picker.addOption(item.ref, item.modified ? t("ui.block_modified_0", item.name) : item.name);
    const value = shown[category];
    picker.setValue(value);
    const item = items.find(entry => entry.ref === value);
    const restorable = item?.kind === "builtin" && item.fileName !== undefined;
    picker.setDisabled(busy);
    lock(openButton, busy);
    lock(copyButton, busy);
    lock(restoreButton, busy || !restorable);
    const parts: string[] = [];
    if (item) {
      const issue = item.issues[0];
      if (issue)
        parts.push(t("ui.block_status_issue_0_1_2", item.fileName ?? item.name, issue.line, styleIssueText(issue)));
      if (item.kind === "file") parts.push(t("ui.block_status_own"));
      else if (item.modified) parts.push(t("ui.block_status_modified"));
      else parts.push(t(item.fileName === undefined ? "ui.block_status_builtin_none" : "ui.block_status_builtin_file"));
    }
    const desc = parts.join(" ");
    if (desc === shownDesc) return;
    shownDesc = desc;
    setting.setDesc(desc);
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
    }
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
    openButton = button;
    button.setButtonText(t("ui.block_open")).onClick(() =>
      act(
        ref => plugin.openBlock(category, ref).then(() => undefined),
        () => openButton?.buttonEl
      )
    );
  });
  setting.addButton(button => {
    copyButton = button;
    button.setButtonText(t("ui.block_copy")).onClick(() =>
      act(
        ref => plugin.copyBlock(category, ref).then(() => undefined),
        () => picker?.selectEl
      )
    );
  });
  setting.addButton(button => {
    restoreButton = button;
    button.setButtonText(t("ui.block_restore")).onClick(() =>
      act(
        ref => plugin.restoreBlock(category, ref).then(() => undefined),
        () =>
          restoreButton?.buttonEl.getAttribute("aria-disabled") === "true" ? picker?.selectEl : restoreButton?.buttonEl
      )
    );
  });
  render();
  void store.refresh().then(render, () => undefined);
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
      .setDesc(t("ui.map_folder_name_desc", workspace))
      .addText(input => {
        input.setPlaceholder(fallback).setValue(shown);
        bindMapFolderInput(this.plugin, key, input);
      });
  }
  getSettingDefinitions(): SettingDefinitionItem[] {
    const text = (name: string, key: "codexPath" | "claudePath", desc: string): SettingDefinitionItem => ({
      name,
      desc,
      control: { type: "text", key }
    });
    const diagnostic = this.plugin.codexDiagnostic();
    const claudeDiagnostic = this.plugin.claudeDiagnostic();
    return [
      {
        name: t("ui.interface_language"),
        render: setting => {
          setting
            .setName(t("ui.interface_language"))
            .setDesc(t("ui.interface_language_description"))
            .addDropdown(dropdown => {
              for (const option of SUPPORTED_LANGUAGES) dropdown.addOption(option.id, option.label);
              dropdown.setValue(this.plugin.settings.language).setDisabled(this.plugin.languageSwitchPending);
              dropdown.onChange(value => {
                void this.plugin.changeLanguage(value);
              });
            });
        }
      },
      text(t("ui.codex_cli_path"), "codexPath", t("ui.vam_uses_this_executable_to_start_codex_app_server")),
      text(t("ui.claude_cli_path"), "claudePath", t("ui.vam_uses_the_claude_code_cli_installed_on_this_computer")),
      {
        name: t("ui.current_model"),
        desc: t("ui.current_model_description"),
        render: setting => {
          this.followCurrentModel();
          setting
            .setName(t("ui.current_model"))
            .setDesc(t("ui.current_model_description"))
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
            modelDiscoverySummary(this.plugin.modelDiscoveryState("codex"), this.plugin.modelDiscoveryState("claude"))
          );
          if (this.plugin.modelDiscoveryState("codex").status === "idle")
            void this.plugin.refreshModelDiscovery("codex");
          if (this.plugin.modelDiscoveryState("claude").status === "idle")
            void this.plugin.refreshModelDiscovery("claude");
        }
      },
      {
        name: t("ui.ai_reasoning_level"),
        desc: t("ui.auto_uses_low_for_simple_tasks_and_medium_for_complex_synthe"),
        control: {
          type: "dropdown",
          key: "cliReasoning",
          options: { auto: t("ui.auto"), low: t("ui.low"), medium: t("ui.medium"), high: t("ui.high") }
        }
      },
      {
        name: t("ui.note_style"),
        render: setting => renderNoteStyleSetting(setting, this.plugin, () => this.update())
      },
      {
        name: t("ui.block_picker_template"),
        render: setting => renderNoteBlockSetting(setting, this.plugin, "template")
      },
      {
        name: t("ui.block_picker_tone"),
        render: setting => renderNoteBlockSetting(setting, this.plugin, "tone")
      },
      {
        name: t("ui.markdown_selection_ai_auto_open"),
        render: setting => {
          setting
            .setName(t("ui.markdown_selection_ai_auto_open"))
            .setDesc(t("ui.markdown_selection_ai_auto_open_desc"))
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
            .setDesc(t("ui.add_diagrams_after_research_desc"))
            .addToggle(toggle =>
              toggle.setValue(this.plugin.settings.addDiagramsAfterResearch).onChange(async value => {
                this.plugin.settings.addDiagramsAfterResearch = value;
                await this.plugin.saveSettings();
              })
            );
        }
      },
      {
        name: t("ui.preview_card_size"),
        render: setting => {
          setting
            .setName(t("ui.preview_card_size"))
            .setDesc(t("ui.preview_card_size_desc"))
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
        name: t("ui.record_ai_exchanges"),
        render: setting => {
          setting
            .setName(t("ui.record_ai_exchanges"))
            .setDesc(t("ui.when_enabled_the_20_most_recent_full_requests_and_raw_replie"))
            .addToggle(toggle =>
              toggle.setValue(this.plugin.settings.aiExchangeLoggingEnabled).onChange(async value => {
                this.plugin.settings.aiExchangeLoggingEnabled = value;
                await this.plugin.saveSettings();
              })
            );
        }
      },
      {
        name: t("ui.workspace_location"),
        render: setting => {
          setting
            .setName(t("ui.workspace_location"))
            .setDesc(
              t(
                "ui.workspace_location_0_legacy_topics_1",
                this.plugin.settings.workspaceFolder,
                this.plugin.settings.topicsFolder
              )
            );
        }
      },
      {
        name: t("ui.mind_maps_folder"),
        render: setting => this.renderMapFolderSetting(setting, "mindMapsFolder", "ui.mind_maps_folder", "Mind Maps")
      },
      {
        name: t("ui.aim_maps_folder"),
        render: setting => this.renderMapFolderSetting(setting, "aimFolder", "ui.aim_maps_folder", "AIM")
      },
      {
        name: t("ui.repair_agent_workspace"),
        render: setting => {
          setting
            .setName(t("ui.repair_agent_workspace"))
            .setDesc(t("ui.creates_only_missing_base_folders_it_never_restores_moves_or"))
            .addButton(button =>
              button.setButtonText(t("ui.repair")).onClick(() => {
                void this.plugin.mutate(() => this.plugin.repairWorkspace());
              })
            );
        }
      },
      {
        name: t("ui.refresh_vam_data"),
        render: setting => {
          setting
            .setName(t("ui.refresh_vam_data"))
            .setDesc(t("ui.rescan_maps_and_topic_notes_then_rebuild_references_and_deri"))
            .addButton(button =>
              button.setButtonText(t("ui.full_rebuild")).onClick(() => {
                void this.plugin.mutate(() => this.plugin.fullRebuild());
              })
            );
        }
      },
      {
        name: t("ui.reconnect_existing_workspace"),
        render: setting => {
          setting
            .setName(t("ui.reconnect_existing_workspace"))
            .setDesc(t("ui.scan_for_recognizable_vam_workspaces_and_reconnect_only_afte"))
            .addButton(button =>
              button.setButtonText(t("ui.scan")).onClick(() => {
                void this.plugin.offerWorkspaceReconnect();
              })
            );
        }
      },
      {
        name: t("ui.codex_app_server_status"),
        render: setting => {
          setting
            .setName(t("ui.codex_app_server_status"))
            .setDesc(
              diagnostic.installed
                ? t("ui.codex_cli_found_0", diagnostic.executable)
                : t("ui.codex_cli_was_not_found_follow_the_installation_guide_to_ins")
            );
          if (!diagnostic.installed)
            setting.addButton(button =>
              button.setButtonText(t("ui.installation_guide")).onClick(() => this.plugin.openCodexSetupGuide())
            );
          setting.addButton(button =>
            button.setButtonText(t("ui.check_again")).onClick(() => {
              void this.plugin.recheckCodex();
            })
          );
        }
      },
      {
        name: t("ui.claude_code_status"),
        render: setting => {
          setting
            .setName(t("ui.claude_code_status"))
            .setDesc(
              claudeDiagnostic.installed
                ? t("ui.claude_cli_found_0", claudeDiagnostic.executable)
                : t("ui.claude_cli_was_not_found_follow_the_installation_guide_to_install_it")
            );
          setting.addButton(button =>
            button.setButtonText(t("ui.check_again")).onClick(() => {
              void this.plugin.recheckClaude();
            })
          );
        }
      }
    ];
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
