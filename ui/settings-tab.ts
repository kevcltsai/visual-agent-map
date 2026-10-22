import type VisualAgentMapPlugin from "../main";
import { SUPPORTED_LANGUAGES, t } from "../i18n";
import { normalizeReasoningLevel } from "../repository";
import { modelDiscoverySummary, syncModelSelect } from "../core/model-discovery";
import { renderDetailTemplatesSetting } from "./modals/detail-templates-modal";
import { renderTonePresetsSetting } from "./modals/prompt-presets-modal";
import { clampPreviewScale } from "./preview-utils";
import { App, Modal, PluginSettingTab, Setting, type SettingDefinitionItem } from "obsidian";

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
        name: t("ui.workspace_default_model"),
        desc: t("ui.models_are_loaded_from_each_installed_ai_service_changes_apply_only_to_new_root_topics"),
        render: setting => {
          setting
            .setName(t("ui.workspace_default_model"))
            .setDesc("")
            .addDropdown(dropdown => {
              const select = (dropdown as unknown as { selectEl: HTMLSelectElement }).selectEl;
              this.modelSelects.add(select);
              const selected = this.plugin.settings.cliModel;
              syncModelSelect(
                select,
                this.plugin.availableModels(),
                id => this.plugin.modelLabel(id),
                t("ui.current_model_is_unavailable")
              );
              if (!Array.from(select.options).some(option => option.value === selected)) {
                const unavailable = new Option(`${selected} (${t("ui.current_model_is_unavailable")})`, selected);
                unavailable.disabled = true;
                select.add(unavailable);
              }
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
          this.modelStatusEls.add(setting.descEl);
          setting.descEl.setText(
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
        name: t("ui.detail_templates"),
        render: setting => renderDetailTemplatesSetting(setting, this.app, this.plugin, () => this.update())
      },
      {
        name: t("ui.tone_presets"),
        render: setting => renderTonePresetsSetting(setting, this.app, this.plugin, () => this.update())
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
    } else if (typeof value === "string" && (key === "codexPath" || key === "claudePath" || key === "cliModel"))
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
