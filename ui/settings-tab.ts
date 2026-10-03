import type VisualAgentMapPlugin from "../main";
import { t } from "../i18n";
import { normalizeReasoningLevel } from "../repository";
import { syncModelSelect } from "../core/model-discovery";
import { App, Modal, PluginSettingTab, Setting, type SettingDefinitionItem } from "obsidian";

export const CODEX_INSTALL_URL = "https://developers.openai.com/codex/cli/";
export const CLAUDE_INSTALL_URL = "https://code.claude.com/docs/en/setup";

export class CodexSetupModal extends Modal {
  constructor(app: App, private executable: string, private recheck: () => void) { super(app); }
  onOpen(): void {
    this.titleEl.setText(t("ui.install_and_connect_codex"));
    this.contentEl.createEl("p", { text: t("ui.codex_setup_for_ai_only"), cls: "vam-modal-intro" });
    const steps = this.contentEl.createEl("ol", { cls: "vam-setup-steps" });
    const install = steps.createEl("li");
    install.appendText(t("ui.open_the_official_codex_cli_installation_guide_and_complete"));
    install.createEl("a", { text: t("ui.official_codex_cli_installation_guide"), href: CODEX_INSTALL_URL, attr: { target: "_blank", rel: "noopener noreferrer" } });
    steps.createEl("li", { text: t("ui.run_codex_in_terminal_and_sign_in_with_your_chatgpt_account") });
    steps.createEl("li", { text: t("ui.return_to_vam_and_select_i_ve_finished_check_again") });
    this.contentEl.createEl("p", { text: t("ui.no_api_key_is_required_the_standalone_codex_cli_does_not_req"), cls: "vam-setup-note" });
    this.contentEl.createEl("p", { text: t("ui.path_currently_checked_0", this.executable), cls: "vam-setup-path" });
    new Setting(this.contentEl)
      .addButton(button => button.setButtonText(t("ui.do_this_later")).onClick(() => this.close()))
      .addButton(button => button.setButtonText(t("ui.i_ve_finished_check_again")).setCta().onClick(() => { this.close(); this.recheck(); }));
  }
}
export class AiUsageModal extends Modal {
  private settled = false;
  constructor(app: App, private provider: "codex" | "claude", private resolve: (confirmed: boolean) => void) { super(app); }
  onOpen(): void {
    const claude = this.provider === "claude";
    this.titleEl.setText(claude ? t("ui.claude_usage_notice") : t("ui.codex_allowance_notice"));
    this.contentEl.createEl("p", { text: t(claude ? "ui.vam_runs_ai_tasks_through_your_claude_code_account_and_uses" : "ui.vam_runs_ai_tasks_through_your_signed_in_codex_account_and_u"), cls: "vam-modal-intro" });
    const finish = (confirmed: boolean): void => { this.settled = true; this.close(); this.resolve(confirmed); };
    new Setting(this.contentEl)
      .addButton(button => button.setButtonText(t("ui.cancel")).onClick(() => finish(false)))
      .addButton(button => button.setButtonText(t("ui.understand_and_run")).setCta().onClick(() => finish(true)));
  }
  onClose(): void { if (!this.settled) this.resolve(false); }
}
export class ClaudeSetupModal extends Modal {
  constructor(app: App, private executable: string, private url: string, private recheck: () => void) { super(app); }
  onOpen(): void {
    this.titleEl.setText(t("ui.install_and_connect_claude_code"));
    this.contentEl.createEl("p", { text: t("ui.claude_code_is_only_needed_for_ai_tasks"), cls: "vam-modal-intro" });
    const steps = this.contentEl.createEl("ol", { cls: "vam-setup-steps" });
    const install = steps.createEl("li"); install.appendText(t("ui.install_claude_code_and_sign_in_with_your_claude_account"));
    install.createEl("a", { text: t("ui.official_claude_code_installation_guide"), href: this.url, attr: { target: "_blank", rel: "noopener noreferrer" } });
    steps.createEl("li", { text: t("ui.return_to_vam_and_check_the_cli_path_again") });
    this.contentEl.createEl("p", { text: t("ui.path_currently_checked_0", this.executable), cls: "vam-setup-path" });
    new Setting(this.contentEl)
      .addButton(button => button.setButtonText(t("ui.do_this_later")).onClick(() => this.close()))
      .addButton(button => button.setButtonText(t("ui.check_again")).setCta().onClick(() => { this.close(); this.recheck(); }));
  }
}
export class VisualAgentMapSettingTab extends PluginSettingTab {
  private readonly modelSelects = new Set<HTMLSelectElement>();
  private readonly modelStatusEls = new Set<HTMLElement>();
  constructor(app: App, private plugin: VisualAgentMapPlugin) {
    super(app, plugin);
    plugin.subscribeModelDiscovery(() => {
      for (const select of [...this.modelSelects]) {
        if (!select.isConnected) { this.modelSelects.delete(select); continue; }
        syncModelSelect(select, plugin.availableModels(), id => plugin.modelLabel(id), t("ui.current_model_is_unavailable"));
      }
      const codex = plugin.modelDiscoveryState("codex"), claude = plugin.modelDiscoveryState("claude");
      const status = `Codex ${codex.status}${codex.error ? `: ${codex.error}` : ""}; Claude CLI candidates ${claude.status}`;
      for (const element of [...this.modelStatusEls]) { if (!element.isConnected) this.modelStatusEls.delete(element); else element.setText(status); }
    });
  }
  refreshAfterLanguageChange(): void {
    const focused = typeof document !== "undefined" && document.activeElement && this.containerEl.contains(document.activeElement)
      && document.activeElement.instanceOf(HTMLSelectElement)
      && Array.from(document.activeElement.options).some(option => option.value === "zh-TW")
      && Array.from(document.activeElement.options).some(option => option.value === "en");
    this.update();
    if (!focused) return;
    const selector = Array.from(this.containerEl.querySelectorAll<HTMLSelectElement>("select")).find(select => {
      const values = Array.from(select.options).map(option => option.value);
      return values.includes("en") && values.includes("zh-TW");
    });
    selector?.focus();
  }
  getSettingDefinitions(): SettingDefinitionItem[] {
    const text = (name: string, key: "codexPath" | "claudePath", desc: string): SettingDefinitionItem => ({ name, desc, control: { type: "text", key } });
    const diagnostic = this.plugin.codexDiagnostic();
    const claudeDiagnostic = this.plugin.claudeDiagnostic();
    return [
      { name: t("ui.interface_language"), render: setting => {
        setting.setName(t("ui.interface_language")).setDesc(t("ui.interface_language_description")).addDropdown(dropdown => {
          dropdown.addOption("en", "English").addOption("zh-TW", "繁體中文").setValue(this.plugin.settings.language).setDisabled(this.plugin.languageSwitchPending);
          dropdown.onChange(value => { void this.plugin.changeLanguage(value); });
        });
      } },
      text(t("ui.codex_cli_path"), "codexPath", t("ui.vam_uses_this_executable_to_start_codex_app_server")),
      text(t("ui.claude_cli_path"), "claudePath", t("ui.vam_uses_the_claude_code_cli_installed_on_this_computer")),
      { name: t("ui.workspace_default_model"), desc: t("ui.models_are_loaded_from_each_installed_ai_service_changes_apply_only_to_new_root_topics"), render: setting => {
        setting.setName(t("ui.workspace_default_model")).setDesc("").addDropdown(dropdown => {
          const select = (dropdown as unknown as { selectEl: HTMLSelectElement }).selectEl;
          this.modelSelects.add(select);
          const selected = this.plugin.settings.cliModel;
          syncModelSelect(select, this.plugin.availableModels(), id => this.plugin.modelLabel(id), t("ui.current_model_is_unavailable"));
          if (!Array.from(select.options).some(option => option.value === selected)) { const unavailable = new Option(`${selected} (${t("ui.current_model_is_unavailable")})`, selected); unavailable.disabled = true; select.add(unavailable); }
          dropdown.setValue(selected);
          dropdown.onChange(value => { void this.setControlValue("cliModel", value); });
        }).addButton(button => button.setButtonText(t("ui.check_again")).onClick(() => { void this.plugin.refreshModelDiscovery("codex"); void this.plugin.refreshModelDiscovery("claude"); }));
        this.modelStatusEls.add(setting.descEl);
        setting.descEl.setText(`Codex ${this.plugin.modelDiscoveryState("codex").status}; Claude CLI candidates ${this.plugin.modelDiscoveryState("claude").status}`);
        if (this.plugin.modelDiscoveryState("codex").status === "idle") void this.plugin.refreshModelDiscovery("codex");
        if (this.plugin.modelDiscoveryState("claude").status === "idle") void this.plugin.refreshModelDiscovery("claude");
      } },
      { name: t("ui.ai_reasoning_level"), desc: t("ui.auto_uses_low_for_simple_tasks_and_medium_for_complex_synthe"), control: { type: "dropdown", key: "cliReasoning", options: { auto: t("ui.auto"), low: t("ui.low"), medium: t("ui.medium"), high: t("ui.high") } } },
      { name: t("ui.record_ai_exchanges"), render: setting => { setting.setName(t("ui.record_ai_exchanges")).setDesc(t("ui.when_enabled_the_20_most_recent_full_requests_and_raw_replie" )).addToggle(toggle => toggle.setValue(this.plugin.settings.aiExchangeLoggingEnabled).onChange(async value => { this.plugin.settings.aiExchangeLoggingEnabled = value; await this.plugin.saveSettings(); })); } },
      { name: t("ui.workspace_location"), render: setting => { setting.setName(t("ui.workspace_location")).setDesc(t("ui.topics_folder_0_inbox_1", this.plugin.settings.topicsFolder, this.plugin.settings.inboxFolder)); } },
      { name: t("ui.repair_agent_workspace"), render: setting => { setting.setName(t("ui.repair_agent_workspace")).setDesc(t("ui.creates_only_missing_base_folders_it_never_restores_moves_or")).addButton(button => button.setButtonText(t("ui.repair")).onClick(() => { void this.plugin.mutate(() => this.plugin.repairWorkspace()); })); } },
      { name: t("ui.refresh_vam_data"), render: setting => { setting.setName(t("ui.refresh_vam_data")).setDesc(t("ui.rescan_maps_and_topic_notes_then_rebuild_references_and_deri")).addButton(button => button.setButtonText(t("ui.full_rebuild")).onClick(() => { void this.plugin.mutate(() => this.plugin.fullRebuild()); })); } },
      { name: t("ui.reconnect_existing_workspace"), render: setting => { setting.setName(t("ui.reconnect_existing_workspace")).setDesc(t("ui.scan_for_recognizable_vam_workspaces_and_reconnect_only_afte")).addButton(button => button.setButtonText(t("ui.scan")).onClick(() => { void this.plugin.offerWorkspaceReconnect(); })); } },
      { name: t("ui.codex_app_server_status"), render: setting => {
        setting.setName(t("ui.codex_app_server_status")).setDesc(diagnostic.installed ? t("ui.codex_cli_found_0", diagnostic.executable) : t("ui.codex_cli_was_not_found_follow_the_installation_guide_to_ins"));
        if (!diagnostic.installed) setting.addButton(button => button.setButtonText(t("ui.installation_guide")).onClick(() => this.plugin.openCodexSetupGuide()));
        setting.addButton(button => button.setButtonText(t("ui.check_again")).onClick(() => { void this.plugin.recheckCodex(); }));
      } },
      { name: t("ui.claude_code_status"), render: setting => {
        setting.setName(t("ui.claude_code_status")).setDesc(claudeDiagnostic.installed ? t("ui.claude_cli_found_0", claudeDiagnostic.executable) : t("ui.claude_cli_was_not_found_follow_the_installation_guide_to_install_it"));
        setting.addButton(button => button.setButtonText(t("ui.check_again")).onClick(() => { void this.plugin.recheckClaude(); }));
      } }
    ];
  }
  async setControlValue(key: string, value: unknown): Promise<void> {
    if (key === "language") { await this.plugin.changeLanguage(value); return; }
    else if (typeof value === "string" && (key === "codexPath" || key === "claudePath" || key === "cliModel")) this.plugin.settings[key] = value.trim();
    else if (key === "cliReasoning") this.plugin.settings.cliReasoning = normalizeReasoningLevel(value);
    else return;
    if (key === "codexPath") this.plugin.resetCodexRuntime();
    if (key === "claudePath") this.plugin.modelDiscovery.invalidate("claude");
    await this.plugin.saveSettings();
    if (key === "codexPath") void this.plugin.refreshModelDiscovery("codex");
    if (key === "claudePath") void this.plugin.refreshModelDiscovery("claude");
  }
}
