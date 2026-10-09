import { App, Modal, Notice, Setting } from "obsidian";
import { t } from "../../i18n";
import { formatDebugLogs, LogManager } from "../../log-manager";
import { AiExchangeLog, formatAiExchange, promptMetrics } from "../../ai-exchange-log";

export class DebugLogModal extends Modal {
  private unsubscribe: (() => void) | null = null;
  private unsubscribeExchanges: (() => void) | null = null;
  constructor(app: App, private readonly logs: LogManager, private readonly exchanges: AiExchangeLog | null, private readonly exchangeEnabled: () => boolean, private readonly setExchangeEnabled?: (enabled: boolean) => Promise<void>) { super(app); }

  onOpen(): void {
    this.titleEl.setText(t("ui.debug_log"));
    this.renderLogs();
    this.unsubscribe = this.logs.subscribe(() => this.renderLogs());
    this.unsubscribeExchanges = this.exchanges?.subscribe(() => this.renderLogs()) ?? null;
  }

  private renderLogs(): void {
    this.contentEl.empty();
    this.contentEl.createEl("p", { cls: "vam-modal-intro", text: t("ui.logs_are_kept_in_memory_only_and_disappear_when_the_plugin_r") });

    const actions = new Setting(this.contentEl);
    actions.addButton(button => button.setButtonText(t("ui.refresh_logs")).onClick(() => this.renderLogs()));
    actions.addButton(button => button.setButtonText(t("ui.copy_logs")).setCta().onClick(async () => {
      const text = formatDebugLogs(this.logs.getLogs());
      if (!text) { new Notice(t("ui.there_are_no_debug_logs_yet")); return; }
      // 只有使用者主動按下按鈕時，才把日誌寫入系統剪貼簿。
      try { await navigator.clipboard.writeText(text); new Notice(t("ui.debug_log_copied")); }
      catch { new Notice(t("ui.unable_to_copy_the_debug_log")); }
    }));
    actions.addButton(button => button.setButtonText(t("ui.clear_logs")).setDestructive().onClick(() => this.logs.clear()));

    const list = this.contentEl.createDiv("vam-debug-log-list");
    const entries = this.logs.getLogs();
    if (!entries.length) list.createEl("p", { cls: "vam-debug-log-empty", text: t("ui.there_are_no_debug_logs_yet") });
    for (const entry of entries) {
      const row = list.createDiv("vam-debug-log-entry");
      const metadata = row.createDiv("vam-debug-log-meta");
      metadata.createEl("time", { text: new Date(entry.timestamp).toLocaleString(), attr: { datetime: entry.timestamp } });
      metadata.createSpan({ cls: `vam-debug-log-level is-${entry.level}`, text: entry.level.toUpperCase() });
      // 使用純文字節點呈現，避免日誌內容被瀏覽器當成 HTML 執行。
      row.createEl("pre", { text: entry.message });
    }
    this.contentEl.createEl("h3", { text: t("ui.ai_exchanges") });
    this.contentEl.createEl("p", { cls: "vam-modal-intro", text: this.exchangeEnabled() ? t("ui.up_to_20_exchanges_are_stored_in_this_vault_s_plugin_folder") : t("ui.ai_exchange_recording_is_off_enable_it_in_vam_settings") });
    const exchangeActions = new Setting(this.contentEl);
    if (this.setExchangeEnabled) exchangeActions.setName(t("ui.record_ai_exchanges")).addToggle(toggle => toggle.setValue(this.exchangeEnabled()).onChange(async value => { await this.setExchangeEnabled?.(value); this.renderLogs(); }));
    exchangeActions.addButton(button => button.setButtonText(t("ui.prompt_monitor_copy_all")).onClick(async () => {
      try { await navigator.clipboard.writeText((this.exchanges?.getEntries() ?? []).map(formatAiExchange).join("\n\n---\n\n")); new Notice(t("ui.ai_exchange_copied")); }
      catch { new Notice(t("ui.unable_to_copy_the_ai_exchange")); }
    }));
    exchangeActions.addButton(button => button.setButtonText(t("ui.clear_ai_exchanges")).setDestructive().onClick(() => this.exchanges?.clear()));
    const exchangeList = this.contentEl.createDiv("vam-debug-log-list");
    const exchanges = [...(this.exchanges?.getEntries() ?? [])].reverse();
    const sent = exchanges.filter(entry => !!entry.request);
    const metrics = sent.map(promptMetrics);
    this.contentEl.createEl("p", { text: t("ui.prompt_monitor_totals", sent.length, metrics.reduce((sum, entry) => sum + entry.characters, 0), metrics.reduce((sum, entry) => sum + entry.estimatedTokens, 0)) });
    if (!exchanges.length) exchangeList.createEl("p", { cls: "vam-debug-log-empty", text: t("ui.there_are_no_ai_exchanges_yet") });
    for (const exchange of exchanges) {
      const metric = promptMetrics(exchange);
      const item = exchangeList.createEl("details", { cls: "vam-debug-log-entry" });
      item.createEl("summary", { text: `${new Date(exchange.startedAt).toLocaleString()} · ${exchange.topic} · ${metric.phase} · ${exchange.status}` });
      item.createEl("p", { text: `${exchange.mode} · ${exchange.model} · ${exchange.effort}`, cls: "vam-debug-log-meta" });
      item.createEl("p", { text: t("ui.prompt_monitor_size", metric.characters, metric.estimatedTokens) });
      if (exchange.durationMs !== undefined) item.createEl("p", { text: t("ui.prompt_monitor_elapsed", this.formatElapsed(exchange.durationMs)) });
      if (metric.repairReason) item.createEl("p", { text: t("ui.prompt_monitor_repair_reason", metric.repairReason) });
      item.createEl("strong", { text: t("ui.prompt_monitor_full_prompt") });
      item.createEl("pre", { text: metric.prompt || t("ui.not_sent_yet") });
      item.createEl("strong", { text: t("ui.request_sent_to_ai") });
      item.createEl("pre", { text: exchange.request || t("ui.not_sent_yet") });
      item.createEl("strong", { text: t("ui.raw_ai_reply") });
      item.createEl("pre", { text: exchange.response || t("ui.no_reply") });
      if (exchange.error) item.createEl("pre", { text: `${t("ui.error")}: ${exchange.error}` });
      const copy = item.createEl("button", { text: t("ui.copy_this_exchange") });
      copy.addEventListener("click", () => { void navigator.clipboard.writeText(formatAiExchange(exchange)).then(() => new Notice(t("ui.ai_exchange_copied"))).catch(() => new Notice(t("ui.unable_to_copy_the_ai_exchange"))); });
    }
  }

  private formatElapsed(durationMs: number): string {
    if (durationMs < 1000) return `${durationMs} ms`;
    if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(1)} s`;
    const minutes = Math.floor(durationMs / 60_000);
    const seconds = Math.floor((durationMs % 60_000) / 1000);
    return `${minutes}m ${seconds}s`;
  }

  onClose(): void { this.unsubscribe?.(); this.unsubscribeExchanges?.(); this.unsubscribe = null; this.unsubscribeExchanges = null; this.contentEl.empty(); }
}
