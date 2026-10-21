import { readFile, rename, writeFile } from "node:fs/promises";
import { t } from "./i18n";
import { upgradeLegacyAimText } from "./experiences/aim/legacy-names";

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

/**
 * Optional timing and shape facts of one model call, written once when the call ends. Every field is optional so an
 * older entry (or a provider that cannot report a fact) simply lacks it. Times are ISO strings; no prompt or secret text.
 */
export interface AiMilestones {
  stream?: "stream-json" | "json" | "json-fallback";
  prespawned?: boolean;
  acceptedAt?: string;
  firstEventAt?: string;
  firstTextAt?: string;
  /** Claude wrote answer text before calling the StructuredOutput tool (the duplicated-output pattern). */
  textBeforeTool?: boolean;
  /** The CLI asked the model to call StructuredOutput again (a structured-output-enforce reminder). */
  enforceRetry?: boolean;
  structuredStartAt?: string;
  structuredCalls?: number;
  previewSummaryAt?: string;
  receivedAt?: string;
  searches?: Array<{
    kind: "search" | "openPage";
    startedAt: string;
    completedAt?: string;
    query?: string;
    failed?: boolean;
  }>;
  stages?: Array<{ stage: string; at: string }>;
  slowShownAt?: string;
  resendOf?: string;
  resentAs?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
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
  /** Step Runner `stepId@version` that produced the prompt, when the call went through a step. */
  step?: string;
  sentAt?: string;
  completedAt?: string;
  durationMs?: number;
  response: string;
  status: "preparing" | "sent" | "received" | "parsed" | "completed" | "failed";
  error: string;
  /** Written once per call by the provider; older entries have none. */
  milestones?: AiMilestones;
}

export function promptMetrics(entry: AiExchange): {
  prompt: string;
  phase: string;
  repairReason?: string;
  characters: number;
  estimatedTokens: number;
} {
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
          .map(item => (isRecord(item) && item.type === "text" && typeof item.text === "string" ? item.text : ""))
          .filter(Boolean)
          .join("\n");
      }
    } catch {
      /* Older requests may be plain text. */
    }
  }
  const characters = Array.from(prompt).length;
  const nonAscii = Array.from(prompt).filter(character => character.charCodeAt(0) > 127).length;
  const phase = upgradeLegacyAimText(prompt).match(/<!--\s*aim-phase:\s*([a-z-]+)\s*-->/)?.[1] ?? entry.mode;
  const repairReason = /repair/i.test(phase)
    ? prompt.match(/(?:Format validation error|Repair reason):\s*([^\r\n]+)/i)?.[1]?.trim()
    : undefined;
  return {
    prompt,
    phase,
    ...(repairReason ? { repairReason } : {}),
    characters,
    estimatedTokens: Math.ceil((characters - nonAscii) / 4 + nonAscii)
  };
}

export function formatAiExchange(entry: AiExchange): string {
  const metrics = promptMetrics(entry);
  const step = entry.step ? ` · step: ${entry.step}` : "";
  const timing = `Request ID: ${entry.id}${step} · phase: ${metrics.phase} · prompt: ${metrics.characters} characters · approximately ${metrics.estimatedTokens} tokens (estimate, not billed usage) · sent: ${entry.sentAt ?? "unavailable"} · completed: ${entry.completedAt ?? "unavailable"} · elapsed: ${entry.durationMs === undefined ? "unavailable" : formatElapsed(entry.durationMs)}`;
  const milestones = entry.milestones ? `milestones: ${JSON.stringify(entry.milestones)}` : "";
  return [
    `[${entry.startedAt}] ${entry.topic} · ${entry.mode} · ${entry.model}/${entry.effort} · ${entry.status}`,
    ...(milestones ? [timing, milestones] : [timing]),
    `\n${t("log.exchange_full_prompt")}\n`,
    metrics.prompt || t("log.exchange_legacy_prompt_missing"),
    `\n${t("log.exchange_request")}\n`,
    entry.request || t("log.exchange_not_sent"),
    `\n${t("log.exchange_raw_reply")}\n`,
    entry.response || t("log.exchange_none"),
    `\n${t("log.exchange_error")}\n`,
    entry.error || t("log.exchange_none")
  ].join("\n");
}

export class AiExchangeLog {
  private entries: AiExchange[] = [];
  private loadError: unknown = null;
  private listeners = new Set<() => void>();
  private writes: Promise<void> = Promise.resolve();
  constructor(
    private readonly path: string,
    private readonly onError: (error: unknown) => void,
    private readonly limit = 1000
  ) {}

  async load(): Promise<void> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, "utf8"));
      if (!Array.isArray(parsed)) throw new Error(t("error.exchange_log_invalid"));
      const entries = (parsed as unknown[]).filter((item): item is AiExchange => {
        if (!item || typeof item !== "object") return false;
        const entry = item as Record<string, unknown>;
        return (
          ["id", "startedAt", "topic", "mode", "model", "effort", "request", "response", "error"].every(
            key => typeof entry[key] === "string"
          ) &&
          (entry.prompt === undefined || typeof entry.prompt === "string") &&
          (entry.step === undefined || typeof entry.step === "string") &&
          (entry.milestones === undefined || isRecord(entry.milestones)) &&
          (entry.sentAt === undefined || typeof entry.sentAt === "string") &&
          (entry.completedAt === undefined || typeof entry.completedAt === "string") &&
          (entry.durationMs === undefined ||
            (typeof entry.durationMs === "number" && Number.isFinite(entry.durationMs) && entry.durationMs >= 0)) &&
          typeof entry.status === "string" &&
          ["preparing", "sent", "received", "parsed", "completed", "failed"].includes(entry.status)
        );
      });
      if (entries.length !== parsed.length) throw new Error(t("error.exchange_log_fields_invalid"));
      this.entries = entries.slice(-this.limit);
      this.loadError = null;
      this.emit();
    } catch (error: unknown) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
        this.loadError = error;
        this.onError(error);
      }
    }
  }

  getEntries(): readonly AiExchange[] {
    return this.entries.map(entry => ({ ...entry }));
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
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
      this.entries.push({
        id: followupId,
        startedAt: sentAt,
        topic: entry.topic,
        mode: "steer",
        model: entry.model,
        effort: entry.effort,
        request,
        sentAt,
        response: "",
        status: "sent",
        error: ""
      });
      this.entries = this.entries.slice(-this.limit);
      this.changed();
      return;
    }
    this.update(id, {
      request,
      ...(prompt !== undefined ? { prompt } : {}),
      sentAt: new Date().toISOString(),
      status: "sent"
    });
  }
  received(id: string, response: string): void {
    this.update(id, { response, status: "received" });
  }
  /** Stores the call's milestones; the provider writes them once, when the call ends. */
  milestones(id: string, data: AiMilestones): void {
    this.update(id, { milestones: data });
  }
  parsed(id: string): void {
    this.finish(id, { status: "parsed" });
  }
  completed(id: string): void {
    this.finish(id, { status: "completed" });
  }
  failed(id: string, error: string): void {
    this.finish(id, { error, status: "failed" });
  }
  clear(): void {
    this.entries = [];
    this.changed();
  }
  async flush(): Promise<void> {
    await this.writes;
  }

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
  private emit(): void {
    for (const listener of this.listeners) listener();
  }
  private changed(): void {
    this.emit();
    if (this.loadError) {
      this.onError(this.loadError);
      return;
    }
    const snapshot = JSON.stringify(this.entries);
    this.writes = this.writes
      .then(async () => {
        const temporary = `${this.path}.tmp`;
        await writeFile(temporary, snapshot, { mode: 0o600 });
        await rename(temporary, this.path);
      })
      .catch(this.onError);
  }
}
