import type { AiMilestones } from "../../ai-exchange-log";
import { claudeReportedUsage } from "../../core/ai-usage-measurement";
import { StructuredPreview, type PartialFields } from "../partial-structured";
import type { ResearchStageName } from "../research-observer";

type Block = {
  type?: unknown;
  id?: unknown;
  name?: unknown;
  text?: unknown;
  input?: unknown;
  tool_use_id?: unknown;
  is_error?: unknown;
  content?: unknown;
};
export interface ClaudeRecord {
  type?: unknown;
  subtype?: unknown;
  error_status?: unknown;
  trigger?: unknown;
  parent_tool_use_id?: unknown;
  usage?: {
    input_tokens?: unknown;
    output_tokens?: unknown;
    cache_creation_input_tokens?: unknown;
    cache_read_input_tokens?: unknown;
  };
  message?: { content?: Block[] };
  event?: {
    type?: unknown;
    index?: unknown;
    content_block?: Block;
    delta?: { type?: unknown; text?: unknown; partial_json?: unknown };
  };
}

/** Text that is the answer itself (JSON, or a `"summary"` field), not a short remark such as "Let me search". */
function looksLikeAnswer(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith("{") || trimmed.includes('"summary"') || /^#{1,6} /m.test(trimmed);
}
/** Main-agent text before the tool call longer than this is an answer even when it is plain prose. */
const ANSWER_TEXT_CHARS = 300;
const TEXT_KEEP_CHARS = 20_000;

/**
 * Facts read from the main agent's records, in the order they arrive: the token usage of the result record, how much
 * text the agent wrote before its StructuredOutput call and whether that text is an answer (JSON, a "summary" field,
 * a Markdown heading, or more than ~300 characters; short search narration is not), and whether the CLI sent a
 * "structured-output-enforce" reminder. With `fromStream` the text comes from the stream events instead of the
 * complete assistant records (the observer feeds `textStart` / `textDelta`).
 */
export class ClaudeTranscriptFacts {
  private structured = false;
  private enforce = false;
  private usage: AiMilestones["usage"];
  private texts: string[] = [];
  private kept = 0;
  private incomplete = false;

  constructor(private readonly fromStream = false) {}

  textStart(): void {
    if (!this.structured) this.texts.push("");
  }

  textDelta(text: string): void {
    if (this.structured || !this.texts.length || this.kept > TEXT_KEEP_CHARS) return;
    this.texts[this.texts.length - 1] += text;
    this.kept += text.length;
  }

  structuredStart(): void {
    this.structured = true;
  }

  read(item: unknown): void {
    if (!item || typeof item !== "object") return;
    const record = item as ClaudeRecord;
    if (record.type === "result") {
      // Claude reports cached prompt tokens separately from `input_tokens`; all three are input the call sent.
      this.usage = claudeReportedUsage(record.usage) ?? this.usage;
      return;
    }
    if (record.parent_tool_use_id) return;
    if (record.type === "assistant") {
      for (const block of record.message?.content ?? []) {
        if (block.type === "tool_use" && block.name === "StructuredOutput") this.structured = true;
        else if (!this.fromStream && block.type === "text" && !this.structured && typeof block.text === "string") {
          this.texts.push(block.text.slice(0, TEXT_KEEP_CHARS));
        }
      }
    } else if (record.type === "user" && JSON.stringify(record.message ?? "").includes("structured-output-enforce"))
      this.enforce = true;
  }

  /** A record was lost (an unreadable line): what came before a tool call can no longer be claimed either way. */
  markIncomplete(): void {
    this.incomplete = true;
  }

  milestones(): AiMilestones {
    const chars = this.texts.reduce((sum, text) => sum + text.trim().length, 0);
    return {
      ...(this.usage ? { usage: this.usage } : {}),
      ...(this.structured && !this.incomplete
        ? {
            textBeforeTool: this.texts.some(looksLikeAnswer) || chars > ANSWER_TEXT_CHARS,
            textBeforeToolChars: chars,
            enforceRetry: this.enforce
          }
        : {})
    };
  }
}

export interface ClaudeStreamHooks {
  /** The first record that shows the model is working (not the CLI's own init line). */
  onFirstEvent?: () => void;
  onStage?: (stage: ResearchStageName, query?: string) => void;
  /** The StructuredOutput text so far; `null` when the call was retracted or replaced. */
  onStructuredDelta?: (fields: PartialFields | null) => void;
  /**
   * The raw StructuredOutput JSON received so far: "" when a new call starts (it replaces the earlier one), `null` when the
   * CLI rejected the call. For progress counting only; the result still comes from the `result` record.
   */
  onStructuredJson?: (buffer: string | null) => void;
}

const LIST_LIMIT = 20;
const QUERY_LIMIT = 200;
/** Characters kept of the CLI's reason for rejecting a StructuredOutput call (a schema message, not the reply). */
const REJECT_REASON_LIMIT = 200;
type StructuredAttempt = NonNullable<AiMilestones["structuredAttempts"]>[number];

/** The text of a tool_result's content (a string or text blocks). */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map(item =>
      item && typeof item === "object" && typeof (item as Block).text === "string" ? (item as Block).text : ""
    )
    .join(" ");
}
/** The number of actions in a StructuredOutput input, when it has an `actions` list. */
const actionCount = (input: unknown): number | null =>
  input && typeof input === "object" && Array.isArray((input as { actions?: unknown }).actions)
    ? (input as { actions: unknown[] }).actions.length
    : null;
const MODEL_RECORDS = new Set(["stream_event", "assistant", "user", "result"]);

/**
 * Reads the CLI's `stream-json --include-partial-messages` records of one call and turns them into stages, the
 * StructuredOutput preview and the call's milestones. It never throws; the runtime stops feeding it after a line that
 * does not parse (D-2026-10-26) and still takes the result from the `result` record.
 */
export class ClaudeStreamObserver {
  private readonly facts = new ClaudeTranscriptFacts(true);
  private readonly preview = new StructuredPreview();
  private readonly blocks = new Map<number, { id: string; name: string; json: string }>();
  private readonly tools = new Map<string, { name: string; search?: number }>();
  private readonly milestoneData: AiMilestones = { stream: "stream-json" };
  private stage: ResearchStageName | "" = "";
  private structuredId = "";
  private structuredJson = "";
  /** One entry per StructuredOutput call, by tool id: what became of it and how big it was (never its content). */
  private readonly attempts = new Map<string, StructuredAttempt>();
  private stopped = false;

  constructor(
    private readonly hooks: ClaudeStreamHooks,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  /** Records the moment the prompt was written. */
  accepted(): void {
    if (this.milestoneData.acceptedAt) return;
    const at = (this.milestoneData.acceptedAt = this.now());
    // The card shows "waiting for the model" from this moment, so the stage list starts here (KPI T1 = stages[0] - acceptedAt).
    (this.milestoneData.stages ??= []).push({ stage: "waiting", at });
  }

  /** Whether any record showed the model working. */
  sawModel(): boolean {
    return !!this.milestoneData.firstEventAt;
  }

  /** After a line that cannot be read: no more stage or preview updates, and the preview is cleared. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    // The lost line may have held the text or tool call: report neither textBeforeTool nor enforceRetry as false.
    this.facts.markIncomplete();
    this.call(() => this.hooks.onStructuredDelta?.(null));
    this.call(() => this.hooks.onStructuredJson?.(null));
  }

  /** The records already read stay; the milestones of the finished call. */
  milestones(): AiMilestones {
    const attempts = [...this.attempts.values()].slice(0, LIST_LIMIT).map(attempt => ({ ...attempt }));
    return {
      ...this.milestoneData,
      ...(attempts.length ? { structuredAttempts: attempts } : {}),
      ...this.facts.milestones()
    };
  }

  read(value: unknown): void {
    if (!value || typeof value !== "object") return;
    const record = value as ClaudeRecord;
    if (record.parent_tool_use_id) return;
    this.facts.read(record);
    if (this.stopped) return;
    if (typeof record.type === "string" && MODEL_RECORDS.has(record.type) && !this.milestoneData.firstEventAt) {
      this.milestoneData.firstEventAt = this.now();
      this.call(() => this.hooks.onFirstEvent?.());
    }
    if (record.type === "system") this.system(record);
    else if (record.type === "stream_event") this.event(record.event);
    else if (record.type === "assistant") {
      for (const block of record.message?.content ?? [])
        if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
          this.toolStart(block.id, block.name);
          this.toolInput(block.id, block.input);
          if (block.name === "StructuredOutput") this.structuredInput(block.id, block.input);
        }
    } else if (record.type === "user") {
      for (const block of record.message?.content ?? [])
        if (block.type === "tool_result" && typeof block.tool_use_id === "string")
          this.toolResult(block.tool_use_id, block.is_error === true, block.content);
    }
  }

  /** The CLI's own retries: a request retried after an API error, a turn switched to the fallback model. */
  private system(record: ClaudeRecord): void {
    if (record.subtype === "api_retry") {
      const list = (this.milestoneData.apiRetries ??= []);
      if (list.length < LIST_LIMIT) list.push(typeof record.error_status === "number" ? record.error_status : null);
    } else if (record.subtype === "model_fallback") {
      const list = (this.milestoneData.modelFallbacks ??= []);
      if (list.length < LIST_LIMIT) list.push(typeof record.trigger === "string" ? record.trigger.slice(0, 40) : "");
    }
  }

  /** The complete input of a StructuredOutput call: its action count, and its size when no stream events gave one. */
  private structuredInput(id: string, input: unknown): void {
    const attempt = this.attempts.get(id);
    if (!attempt) return;
    attempt.actions = actionCount(input);
    if (!attempt.chars) {
      try {
        attempt.chars = JSON.stringify(input ?? null).length;
      } catch {
        /* Size is best effort. */
      }
    }
  }

  private event(event: ClaudeRecord["event"]): void {
    if (!event) return;
    if (event.type === "message_start") this.blocks.clear();
    else if (event.type === "content_block_start" && typeof event.index === "number") {
      const block = event.content_block;
      if (block?.type === "text") this.facts.textStart();
      if (block?.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
        this.blocks.set(event.index, { id: block.id, name: block.name, json: "" });
        this.toolStart(block.id, block.name);
      }
    } else if (event.type === "content_block_delta" && event.delta) {
      if (event.delta.type === "text_delta") {
        this.milestoneData.firstTextAt ??= this.now();
        if (typeof event.delta.text === "string") this.facts.textDelta(event.delta.text);
      } else if (
        event.delta.type === "input_json_delta" &&
        typeof event.delta.partial_json === "string" &&
        typeof event.index === "number"
      ) {
        const block = this.blocks.get(event.index);
        if (!block) return;
        block.json += event.delta.partial_json;
        if (block.id !== this.structuredId) return;
        this.preview.append(event.delta.partial_json);
        this.structuredJson += event.delta.partial_json;
        const attempt = this.attempts.get(block.id);
        if (attempt) attempt.chars = this.structuredJson.length;
        const json = this.structuredJson;
        this.call(() => this.hooks.onStructuredJson?.(json));
        const fields = this.preview.snapshot();
        if (fields.summary && !this.milestoneData.previewSummaryAt) this.milestoneData.previewSummaryAt = this.now();
        this.call(() => this.hooks.onStructuredDelta?.(fields));
      }
    } else if (event.type === "content_block_stop" && typeof event.index === "number") {
      const block = this.blocks.get(event.index);
      if (block && block.name !== "StructuredOutput" && block.json) {
        try {
          this.toolInput(block.id, JSON.parse(block.json));
        } catch {
          /* The assistant record carries the complete input too. */
        }
      }
    }
  }

  private toolStart(id: string, name: string): void {
    if (this.tools.has(id)) return;
    const at = this.now();
    if (name === "WebSearch" || name === "WebFetch") {
      const searches = (this.milestoneData.searches ??= []);
      const entry = { name } as { name: string; search?: number };
      if (searches.length < LIST_LIMIT) {
        searches.push({ kind: name === "WebSearch" ? "search" : "openPage", startedAt: at });
        entry.search = searches.length - 1;
      }
      this.tools.set(id, entry);
      this.setStage(name === "WebSearch" ? "searching" : "reading");
    } else if (name === "StructuredOutput") {
      this.tools.set(id, { name });
      this.facts.structuredStart();
      // A new call replaces the earlier one: only the last is ever shown. One the CLI never answered was cut off (a retried stream).
      const earlier = this.attempts.get(this.structuredId);
      if (earlier && earlier.outcome === "pending") earlier.outcome = "replaced";
      this.attempts.set(id, { outcome: "pending", chars: 0, actions: null });
      this.structuredId = id;
      this.milestoneData.structuredCalls = (this.milestoneData.structuredCalls ?? 0) + 1;
      this.milestoneData.structuredStartAt ??= at;
      this.preview.start();
      this.structuredJson = "";
      this.call(() => this.hooks.onStructuredJson?.(""));
      this.call(() => this.hooks.onStructuredDelta?.(this.preview.snapshot()));
      this.setStage("writing");
    } else this.tools.set(id, { name });
  }

  private toolInput(id: string, input: unknown): void {
    const tool = this.tools.get(id);
    if (!tool || tool.name !== "WebSearch" || !input || typeof input !== "object") return;
    const query = (input as { query?: unknown }).query;
    if (typeof query !== "string" || !query.trim()) return;
    const entry = tool.search === undefined ? undefined : this.milestoneData.searches?.[tool.search];
    const text = query.trim().slice(0, QUERY_LIMIT);
    if (entry?.query === text) return;
    if (entry) entry.query = text;
    if (this.stage === "searching") this.call(() => this.hooks.onStage?.("searching", text));
  }

  private toolResult(id: string, failed: boolean, content?: unknown): void {
    const tool = this.tools.get(id);
    if (!tool) return;
    const attempt = this.attempts.get(id);
    if (attempt && attempt.outcome === "pending") {
      attempt.outcome = failed ? "rejected" : "accepted";
      const reason = failed ? resultText(content).replace(/\s+/g, " ").trim().slice(0, REJECT_REASON_LIMIT) : "";
      if (reason) attempt.error = reason;
    }
    const entry = tool.search === undefined ? undefined : this.milestoneData.searches?.[tool.search];
    if (entry) {
      entry.completedAt = this.now();
      if (failed) entry.failed = true;
    }
    if (tool.name === "WebSearch") this.setStage("reading");
    else if (tool.name === "StructuredOutput" && failed && id === this.structuredId) {
      // The CLI rejected the call (validation): the model will call the tool again, so show nothing meanwhile.
      this.preview.reject();
      this.structuredJson = "";
      this.call(() => this.hooks.onStructuredJson?.(null));
      this.call(() => this.hooks.onStructuredDelta?.(null));
    }
  }

  private setStage(stage: ResearchStageName): void {
    if (this.stage === stage && stage !== "searching") return;
    this.stage = stage;
    const stages = (this.milestoneData.stages ??= []);
    if (stages.length < LIST_LIMIT) stages.push({ stage, at: this.now() });
    this.call(() => this.hooks.onStage?.(stage));
  }

  private call(callback: () => void): void {
    // Telemetry consumers must not be able to fail the provider task.
    try {
      callback();
    } catch {
      /* Diagnostics are best effort. */
    }
  }
}
