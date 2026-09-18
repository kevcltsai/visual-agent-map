export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
}

/**
 * 僅在記憶體中保存 VAM 自己產生的診斷資訊。
 * 不應傳入 prompt、筆記內容、token 或其他敏感資料。
 */
export class LogManager {
  private entries: LogEntry[] = [];
  private listeners = new Set<() => void>();
  constructor(private readonly limit = 500) {}

  appendLog(level: LogLevel, message: string): void {
    const normalized = message.trim();
    if (!normalized) return;
    this.entries.push({ timestamp: new Date().toISOString(), level, message: normalized });
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit);
    for (const listener of this.listeners) listener();
  }

  getLogs(): readonly LogEntry[] { return this.entries.map(entry => ({ ...entry })); }
  clear(): void { this.entries = []; for (const listener of this.listeners) listener(); }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export function formatDebugLogs(entries: readonly LogEntry[]): string {
  return entries.map(entry => `[${entry.timestamp}] [${entry.level.toUpperCase()}] ${entry.message}`).join("\n");
}

export const debugLog = new LogManager();
