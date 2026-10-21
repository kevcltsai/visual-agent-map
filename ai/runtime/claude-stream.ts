import type { AiMilestones } from "../../ai-exchange-log";
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
};
export interface ClaudeRecord {
  type?: unknown;
  parent_tool_use_id?: unknown;
  usage?: { input_tokens?: unknown; output_tokens?: unknown };
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
      const input = record.usage?.input_tokens;
      const output = record.usage?.output_tokens;
      if (typeof input === "number" || typeof output === "number")
        this.usage = {
          ...(typeof input === "number" ? { inputTokens: input } : {}),
          ...(typeof output === "number" ? { outputTokens: output } : {})
        };
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
}

const LIST_LIMIT = 20;
const QUERY_LIMIT = 200;
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
  }

  /** The records already read stay; the milestones of the finished call. */
  milestones(): AiMilestones {
    return { ...this.milestoneData, ...this.facts.milestones() };
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
    if (record.type === "stream_event") this.event(record.event);
    else if (record.type === "assistant") {
      for (const block of record.message?.content ?? [])
        if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
          this.toolStart(block.id, block.name);
          this.toolInput(block.id, block.input);
        }
    } else if (record.type === "user") {
      for (const block of record.message?.content ?? [])
        if (block.type === "tool_result" && typeof block.tool_use_id === "string")
          this.toolResult(block.tool_use_id, block.is_error === true);
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
      // A new call replaces the earlier one: only the last is ever shown.
      this.structuredId = id;
      this.milestoneData.structuredCalls = (this.milestoneData.structuredCalls ?? 0) + 1;
      this.milestoneData.structuredStartAt ??= at;
      this.preview.start();
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

  private toolResult(id: string, failed: boolean): void {
    const tool = this.tools.get(id);
    if (!tool) return;
    const entry = tool.search === undefined ? undefined : this.milestoneData.searches?.[tool.search];
    if (entry) {
      entry.completedAt = this.now();
      if (failed) entry.failed = true;
    }
    if (tool.name === "WebSearch") this.setStage("reading");
    else if (tool.name === "StructuredOutput" && failed && id === this.structuredId) {
      // The CLI rejected the call (validation): the model will call the tool again, so show nothing meanwhile.
      this.preview.reject();
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
