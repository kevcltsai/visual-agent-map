import { readFile, rename, writeFile } from "node:fs/promises";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function formatElapsed(durationMs: number): string {
  if (durationMs < 1000) return `${durationMs} ms`;
  if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(1)} s`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.floor((durationMs % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

export interface AiExchange {
  id: string;
  startedAt: string;
  topic: string;
  mode: string;
  model: string;
  effort: string;
  request: string;
  prompt?: string;
  sentAt?: string;
  completedAt?: string;
  durationMs?: number;
  response: string;
  status: "preparing" | "sent" | "received" | "parsed" | "completed" | "failed";
  error: string;
}

export function promptMetrics(entry: AiExchange): { prompt: string; phase: string; repairReason?: string; characters: number; estimatedTokens: number } {
  let prompt = typeof entry.prompt === "string" ? entry.prompt : "";
  if (!prompt && entry.request) {
    try {
      const parsed: unknown = JSON.parse(entry.request);
      const parsedRecord = isRecord(parsed) ? parsed : undefined;
      const requestValue = parsedRecord?.request ?? parsed;
      const request = isRecord(requestValue) ? requestValue : undefined;
      if (typeof request?.prompt === "string") prompt = request.prompt;
      else if (request && isUnknownArray(request.input)) {
        prompt = request.input
          .map(item => isRecord(item) && item.type === "text" && typeof item.text === "string" ? item.text : "")
          .filter(Boolean)
          .join("\n");
      }
    } catch { /* Older requests may be plain text. */ }
  }
  const characters = Array.from(prompt).length;
  const nonAscii = Array.from(prompt).filter(character => character.charCodeAt(0) > 127).length;
  const phase = prompt.match(/<!--\s*mindsearch-phase:\s*([a-z-]+)\s*-->/)?.[1] ?? entry.mode;
  const repairReason = /repair/i.test(phase)
    ? prompt.match(/(?:Format validation error|Repair reason):\s*([^\r\n]+)/i)?.[1]?.trim()
    : undefined;
  return { prompt, phase, ...(repairReason ? { repairReason } : {}), characters, estimatedTokens: Math.ceil((characters - nonAscii) / 4 + nonAscii) };
}

export function formatAiExchange(entry: AiExchange): string {
  const metrics = promptMetrics(entry);
  const timing = `Request ID: ${entry.id} · phase: ${metrics.phase} · prompt: ${metrics.characters} characters · approximately ${metrics.estimatedTokens} tokens (estimate, not billed usage) · sent: ${entry.sentAt ?? "unavailable"} · completed: ${entry.completedAt ?? "unavailable"} · elapsed: ${entry.durationMs === undefined ? "unavailable" : formatElapsed(entry.durationMs)}`;
  return [`[${entry.startedAt}] ${entry.topic} · ${entry.mode} · ${entry.model}/${entry.effort} · ${entry.status}`, timing, "\n完整 Prompt：\n", metrics.prompt || "（舊紀錄未保存完整 prompt）", "\n送往 AI 的請求：\n", entry.request || "（尚未送出）", "\nAI 原始回覆：\n", entry.response || "（無）", "\n錯誤：\n", entry.error || "（無）"].join("\n");
}

export class AiExchangeLog {
  private entries: AiExchange[] = [];
  private loadError: unknown = null;
  private listeners = new Set<() => void>();
  private writes: Promise<void> = Promise.resolve();
  constructor(private readonly path: string, private readonly onError: (error: unknown) => void, private readonly limit = 1000) {}

  async load(): Promise<void> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, "utf8"));
      if (!Array.isArray(parsed)) throw new Error("AI 往返紀錄格式錯誤");
      const entries = (parsed as unknown[]).filter((item): item is AiExchange => {
        if (!item || typeof item !== "object") return false;
        const entry = item as Record<string, unknown>;
        return ["id", "startedAt", "topic", "mode", "model", "effort", "request", "response", "error"].every(key => typeof entry[key] === "string")
          && (entry.prompt === undefined || typeof entry.prompt === "string")
          && (entry.sentAt === undefined || typeof entry.sentAt === "string")
          && (entry.completedAt === undefined || typeof entry.completedAt === "string")
          && (entry.durationMs === undefined || typeof entry.durationMs === "number" && Number.isFinite(entry.durationMs) && entry.durationMs >= 0)
          && typeof entry.status === "string" && ["preparing", "sent", "received", "parsed", "completed", "failed"].includes(entry.status);
      });
      if (entries.length !== parsed.length) throw new Error("AI 往返紀錄欄位格式錯誤；保留原檔並停止寫入");
      this.entries = entries.slice(-this.limit);
      this.loadError = null;
      this.emit();
    } catch (error: unknown) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) { this.loadError = error; this.onError(error); }
    }
  }

  getEntries(): readonly AiExchange[] { return this.entries.map(entry => ({ ...entry })); }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  begin(entry: Omit<AiExchange, "status" | "request" | "response" | "error" | "prompt">): void {
    this.entries.push({ ...entry, request: "", response: "", status: "preparing", error: "" });
    this.entries = this.entries.slice(-this.limit);
    this.changed();
  }
  sent(id: string, request: string, prompt?: string): void {
    const entry = this.entries.find(item => item.id === id);
    if (entry?.request) {
      const sentAt = new Date().toISOString();
      const followupId = `${id}-${Date.now()}-${this.entries.length}`;
      this.entries.push({ id: followupId, startedAt: sentAt, topic: entry.topic, mode: "steer", model: entry.model, effort: entry.effort, request, sentAt, response: "", status: "sent", error: "" });
      this.entries = this.entries.slice(-this.limit);
      this.changed();
      return;
    }
    this.update(id, { request, ...(prompt !== undefined ? { prompt } : {}), sentAt: new Date().toISOString(), status: "sent" });
  }
  received(id: string, response: string): void { this.update(id, { response, status: "received" }); }
  parsed(id: string): void { this.finish(id, { status: "parsed" }); }
  completed(id: string): void { this.finish(id, { status: "completed" }); }
  failed(id: string, error: string): void { this.finish(id, { error, status: "failed" }); }
  clear(): void { this.entries = []; this.changed(); }
  async flush(): Promise<void> { await this.writes; }

  private update(id: string, patch: Partial<AiExchange>): void {
    const entry = this.entries.find(item => item.id === id);
    if (!entry) return;
    Object.assign(entry, patch);
    this.changed();
  }
  private finish(id: string, patch: Pick<AiExchange, "status"> & Partial<AiExchange>): void {
    const entry = this.entries.find(item => item.id === id);
    if (!entry) return;
    const completedAt = new Date().toISOString();
    const start = entry.sentAt ?? entry.startedAt;
    const durationMs = Math.max(0, Date.parse(completedAt) - Date.parse(start));
    this.update(id, { ...patch, completedAt, durationMs });
  }
  private emit(): void { for (const listener of this.listeners) listener(); }
  private changed(): void {
    this.emit();
    if (this.loadError) { this.onError(this.loadError); return; }
    const snapshot = JSON.stringify(this.entries);
    this.writes = this.writes.then(async () => {
      const temporary = `${this.path}.tmp`;
      await writeFile(temporary, snapshot, { mode: 0o600 });
      await rename(temporary, this.path);
    }).catch(this.onError);
  }
}
