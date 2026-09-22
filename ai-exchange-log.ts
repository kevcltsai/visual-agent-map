import { readFile, rename, writeFile } from "node:fs/promises";

export interface AiExchange {
  id: string;
  startedAt: string;
  topic: string;
  mode: string;
  model: string;
  effort: string;
  request: string;
  response: string;
  status: "preparing" | "sent" | "received" | "parsed" | "completed" | "failed";
  error: string;
}

export function formatAiExchange(entry: AiExchange): string {
  return [`[${entry.startedAt}] ${entry.topic} · ${entry.mode} · ${entry.model}/${entry.effort} · ${entry.status}`, "\n送往 AI 的請求：\n", entry.request || "（尚未送出）", "\nAI 原始回覆：\n", entry.response || "（無）", "\n錯誤：\n", entry.error || "（無）"].join("\n");
}

export class AiExchangeLog {
  private entries: AiExchange[] = [];
  private listeners = new Set<() => void>();
  private writes: Promise<void> = Promise.resolve();
  constructor(private readonly path: string, private readonly onError: (error: unknown) => void, private readonly limit = 20) {}

  async load(): Promise<void> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, "utf8"));
      if (!Array.isArray(parsed)) throw new Error("AI 往返紀錄格式錯誤");
      this.entries = (parsed as unknown[]).filter((item): item is AiExchange => {
        if (!item || typeof item !== "object") return false;
        const entry = item as Record<string, unknown>;
        return typeof entry.id === "string" && typeof entry.request === "string" && typeof entry.response === "string" && typeof entry.status === "string";
      }).slice(-this.limit);
      this.emit();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.onError(error);
    }
  }

  getEntries(): readonly AiExchange[] { return this.entries.map(entry => ({ ...entry })); }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  begin(entry: Omit<AiExchange, "status" | "request" | "response" | "error">): void {
    this.entries.push({ ...entry, request: "", response: "", status: "preparing", error: "" });
    this.entries = this.entries.slice(-this.limit);
    this.changed();
  }
  sent(id: string, request: string): void { this.update(id, { request, status: "sent" }); }
  received(id: string, response: string): void { this.update(id, { response, status: "received" }); }
  parsed(id: string): void { this.update(id, { status: "parsed" }); }
  completed(id: string): void { this.update(id, { status: "completed" }); }
  failed(id: string, error: string): void { this.update(id, { error, status: "failed" }); }
  clear(): void { this.entries = []; this.changed(); }
  async flush(): Promise<void> { await this.writes; }

  private update(id: string, patch: Partial<AiExchange>): void {
    const entry = this.entries.find(item => item.id === id);
    if (!entry) return;
    Object.assign(entry, patch);
    this.changed();
  }
  private emit(): void { for (const listener of this.listeners) listener(); }
  private changed(): void {
    this.emit();
    const snapshot = JSON.stringify(this.entries);
    this.writes = this.writes.then(async () => {
      const temporary = `${this.path}.tmp`;
      await writeFile(temporary, snapshot, { mode: 0o600 });
      await rename(temporary, this.path);
    }).catch(this.onError);
  }
}
