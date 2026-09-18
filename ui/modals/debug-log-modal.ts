import { App, Modal, Notice, Setting } from "obsidian";
import { t } from "../../i18n";
import { formatDebugLogs, LogManager } from "../../log-manager";

export class DebugLogModal extends Modal {
  private unsubscribe: (() => void) | null = null;
  constructor(app: App, private readonly logs: LogManager) { super(app); }

  onOpen(): void {
    this.titleEl.setText(t("偵錯日誌"));
    this.renderLogs();
    this.unsubscribe = this.logs.subscribe(() => this.renderLogs());
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
    actions.addButton(button => button.setButtonText(t("清除日誌")).setWarning().onClick(() => this.logs.clear()));

    const list = this.contentEl.createDiv("vam-debug-log-list");
    const entries = this.logs.getLogs();
    if (!entries.length) { list.createEl("p", { cls: "vam-debug-log-empty", text: t("目前沒有偵錯日誌。") }); return; }
    for (const entry of entries) {
      const row = list.createDiv("vam-debug-log-entry");
      const metadata = row.createDiv("vam-debug-log-meta");
      metadata.createEl("time", { text: new Date(entry.timestamp).toLocaleString(), attr: { datetime: entry.timestamp } });
      metadata.createSpan({ cls: `vam-debug-log-level is-${entry.level}`, text: entry.level.toUpperCase() });
      // 使用純文字節點呈現，避免日誌內容被瀏覽器當成 HTML 執行。
      row.createEl("pre", { text: entry.message });
    }
  }

  onClose(): void { this.unsubscribe?.(); this.unsubscribe = null; this.contentEl.empty(); }
}
