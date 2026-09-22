import { App, Modal, Notice, Setting } from "obsidian";
import { t } from "../../i18n";
import { formatDebugLogs, LogManager } from "../../log-manager";
import { AiExchangeLog, formatAiExchange } from "../../ai-exchange-log";

export class DebugLogModal extends Modal {
  private unsubscribe: (() => void) | null = null;
  private unsubscribeExchanges: (() => void) | null = null;
  constructor(app: App, private readonly logs: LogManager, private readonly exchanges: AiExchangeLog | null, private readonly exchangeEnabled: () => boolean) { super(app); }

  onOpen(): void {
    this.titleEl.setText(t("偵錯日誌"));
    this.renderLogs();
    this.unsubscribe = this.logs.subscribe(() => this.renderLogs());
    this.unsubscribeExchanges = this.exchanges?.subscribe(() => this.renderLogs()) ?? null;
  }

  private renderLogs(): void {
    this.contentEl.empty();
    this.contentEl.createEl("p", { cls: "vam-modal-intro", text: t("日誌只保存在記憶體中，重新載入外掛後會消失。複製前請先確認內容不含私人資訊。") });

    const actions = new Setting(this.contentEl);
    actions.addButton(button => button.setButtonText(t("更新日誌")).onClick(() => this.renderLogs()));
    actions.addButton(button => button.setButtonText(t("複製日誌")).setCta().onClick(async () => {
      const text = formatDebugLogs(this.logs.getLogs());
      if (!text) { new Notice(t("目前沒有偵錯日誌。")); return; }
      // 只有使用者主動按下按鈕時，才把日誌寫入系統剪貼簿。
      try { await navigator.clipboard.writeText(text); new Notice(t("偵錯日誌已複製。")); }
      catch { new Notice(t("無法複製偵錯日誌。")); }
    }));
    actions.addButton(button => button.setButtonText(t("清除日誌")).setDestructive().onClick(() => this.logs.clear()));

    const list = this.contentEl.createDiv("vam-debug-log-list");
    const entries = this.logs.getLogs();
    if (!entries.length) list.createEl("p", { cls: "vam-debug-log-empty", text: t("目前沒有偵錯日誌。") });
    for (const entry of entries) {
      const row = list.createDiv("vam-debug-log-entry");
      const metadata = row.createDiv("vam-debug-log-meta");
      metadata.createEl("time", { text: new Date(entry.timestamp).toLocaleString(), attr: { datetime: entry.timestamp } });
      metadata.createSpan({ cls: `vam-debug-log-level is-${entry.level}`, text: entry.level.toUpperCase() });
      // 使用純文字節點呈現，避免日誌內容被瀏覽器當成 HTML 執行。
      row.createEl("pre", { text: entry.message });
    }
    this.contentEl.createEl("h3", { text: t("AI 往返紀錄") });
    this.contentEl.createEl("p", { cls: "vam-modal-intro", text: this.exchangeEnabled() ? t("紀錄保存在此 Vault 的外掛資料夾，最多 20 次；可能包含私人筆記內容。") : t("AI 往返紀錄目前關閉；可在 VAM 設定中啟用。") });
    const exchangeActions = new Setting(this.contentEl);
    exchangeActions.addButton(button => button.setButtonText(t("清除 AI 往返紀錄")).setDestructive().onClick(() => this.exchanges?.clear()));
    const exchangeList = this.contentEl.createDiv("vam-debug-log-list");
    const exchanges = [...(this.exchanges?.getEntries() ?? [])].reverse();
    if (!exchanges.length) exchangeList.createEl("p", { cls: "vam-debug-log-empty", text: t("目前沒有 AI 往返紀錄。") });
    for (const exchange of exchanges) {
      const item = exchangeList.createEl("details", { cls: "vam-debug-log-entry" });
      item.createEl("summary", { text: `${new Date(exchange.startedAt).toLocaleString()} · ${exchange.topic} · ${exchange.status}` });
      item.createEl("p", { text: `${exchange.mode} · ${exchange.model} · ${exchange.effort}`, cls: "vam-debug-log-meta" });
      item.createEl("strong", { text: t("送往 AI 的請求") });
      item.createEl("pre", { text: exchange.request || t("尚未送出") });
      item.createEl("strong", { text: t("AI 原始回覆") });
      item.createEl("pre", { text: exchange.response || t("沒有回覆") });
      if (exchange.error) item.createEl("pre", { text: `${t("錯誤")}: ${exchange.error}` });
      const copy = item.createEl("button", { text: t("複製這次紀錄") });
      copy.addEventListener("click", () => { void navigator.clipboard.writeText(formatAiExchange(exchange)).then(() => new Notice(t("AI 往返紀錄已複製。"))).catch(() => new Notice(t("無法複製 AI 往返紀錄。"))); });
    }
  }

  onClose(): void { this.unsubscribe?.(); this.unsubscribeExchanges?.(); this.unsubscribe = null; this.unsubscribeExchanges = null; this.contentEl.empty(); }
}
