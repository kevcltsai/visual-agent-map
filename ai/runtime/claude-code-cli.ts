import { spawn as nodeSpawn } from "node:child_process";
import { t } from "../../i18n";
import { searchNotPerformedError } from "../search-not-performed";
import { createUtf8StreamDecoder } from "./utf8-stream";
import type { AiMilestones } from "../../ai-exchange-log";
import type { PartialFields } from "../partial-structured";
import type { ResearchStageName } from "../research-observer";
import type { WebSearchEvent } from "../types";
import { ClaudeStreamObserver, ClaudeTranscriptFacts } from "./claude-stream";
import type { ClaudeWarmPool } from "./claude-warm-pool";

export interface ClaudeProcess {
  stdin: {
    write(data: string, callback?: (error?: Error | null) => void): boolean;
    end(data?: string, callback?: (error?: Error | null) => void): void;
    on?(event: "error", listener: (error: Error) => void): void;
  };
  stdout: { on(event: "data", listener: (chunk: { toString(encoding?: string): string }) => void): void };
  stderr: { on(event: "data", listener: (chunk: { toString(encoding?: string): string }) => void): void };
  on(event: "error", listener: (error: Error) => void): void;
  on(event: "close", listener: (code: number | null, signal?: string | null) => void): void;
  kill(signal?: NodeJS.Signals): boolean;
}
export type ClaudeSpawn = (
  executable: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; stdio: ["pipe", "pipe", "pipe"]; windowsHide: true }
) => ClaudeProcess;
export interface ClaudeCodeCliOptions {
  executable: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  onLog?: (level: "info" | "warn" | "error", message: string) => void;
  spawn?: ClaudeSpawn;
  timeoutMs?: number;
  timeoutMessage?: string;
  /** Shared idle-process pool (see {@link ClaudeCodeCliRuntime.prewarm}); without it every call starts its own process. */
  warmPool?: ClaudeWarmPool<ClaudeProcess>;
}
export interface ClaudeTaskControls {
  signal?: AbortSignal;
  searchBudget?: number;
  webSearch?: boolean;
  onRequest?: (request: unknown) => void;
  onAccepted?: () => void;
  onProgress?: (message: string) => void;
  onText?: (text: string) => void;
  onSteer?: (steer: (text: string) => Promise<void>) => void;
  timeoutMs?: number;
  timeoutMessage?: string;
  /** Isolated research, and standard research of normal or deep depth: fail the task unless at least one web search or page fetch actually returned. */
  webSearchOnly?: boolean;
  /** Receives WebSearch/WebFetch activity in the same shape as Codex App Server web-search items. */
  onWebSearchEvent?: (event: WebSearchEvent) => void;
  /** A base64 PNG, JPEG, GIF or WebP data URL sent with the prompt as an image block. */
  imageDataUrl?: string;
  /** Receives call facts (usage, text before the StructuredOutput call, an enforce retry) once the transcript is read. */
  onMilestones?: (data: AiMilestones) => void;
  /**
   * Observed research: with a response schema, read the CLI's `stream-json --include-partial-messages` output to report
   * stages, the first model event and the StructuredOutput preview. The result still comes from the `result` record.
   */
  stream?: boolean;
  /** Reports which output mode this call really uses, before the prompt is written. */
  onStreamMode?: (mode: "stream-json" | "json" | "json-fallback") => void;
  /** The first record that shows the model is working (stream mode only). */
  onFirstEvent?: () => void;
  onStage?: (stage: ResearchStageName, query?: string) => void;
  /** The StructuredOutput text so far; `null` clears it (stream mode only). */
  onStructuredDelta?: (fields: PartialFields | null) => void;
  /** The raw StructuredOutput JSON so far; "" for a new call, `null` when rejected (stream mode only). */
  onStructuredJson?: (buffer: string | null) => void;
}

/** Splits an image data URL into the Messages API image source; anything else is rejected. */
export function claudeImageSource(dataUrl: string): { type: "base64"; media_type: string; data: string } {
  const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) throw new Error(t("ui.context_ai_image_unavailable"));
  return { type: "base64", media_type: match[1], data: match[2] };
}
export const CLAUDE_TASK_TIMEOUT_MS = 3 * 60 * 1000;

// Claude accepts the schema body but its CLI validator does not resolve a draft URI.
// Keep the validation keywords intact for both the CLI and our result parser.
export function claudeOutputSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;
  const { $schema: _draft, ...body } = schema as Record<string, unknown>;
  return body;
}

export function claudeTaskArgs(model: string, effort: string, schema: unknown, webSearch: boolean): string[] {
  return [
    "--print",
    "--output-format",
    "json",
    "--verbose",
    ...(schema ? ["--json-schema", JSON.stringify(claudeOutputSchema(schema))] : []),
    "--model",
    model,
    "--effort",
    ["low", "medium", "high"].includes(effort) ? effort : "low",
    "--permission-mode",
    "dontAsk",
    "--permission-prompts",
    "none",
    "--safe-mode",
    "--strict-mcp-config",
    "--mcp-config",
    JSON.stringify({ mcpServers: {} }),
    "--no-session-persistence",
    // dontAsk denies every tool that is not pre-approved; --tools alone only makes them available.
    ...(webSearch ? ["--allowedTools", "WebSearch,WebFetch"] : []),
    "--tools",
    webSearch ? "WebSearch,WebFetch" : ""
  ];
}

/**
 * The command of an observed research call whose prompt arrives as a stream-json user message, so the process can be
 * started before the prompt exists. The pre-start and the call build it with this one function, so equal inputs give
 * an equal command.
 */
export function claudeWarmArgs(model: string, effort: string, schema: unknown, webSearch: boolean): string[] {
  const args = claudeTaskArgs(model, effort, schema, webSearch);
  args[args.indexOf("json")] = "stream-json";
  args.push("--include-partial-messages", "--input-format", "stream-json");
  return args;
}

export function claudeStructuredOutput(stdout: string, plainText = false): string {
  const value: unknown = JSON.parse(stdout);
  const events: unknown[] = Array.isArray(value) ? (value as unknown[]) : [];
  const final: unknown = events.length
    ? events.reverse().find(item => item && typeof item === "object" && "type" in item && item.type === "result")
    : value;
  if (!final || typeof final !== "object") throw new Error(t("ui.claude_returned_an_invalid_response"));
  const record = final as {
    type?: unknown;
    structured_output?: unknown;
    result?: unknown;
    is_error?: unknown;
    subtype?: unknown;
    errors?: unknown;
  };
  if (record.is_error === true || (typeof record.subtype === "string" && record.subtype.startsWith("error_"))) {
    const details = Array.isArray(record.errors)
      ? record.errors.filter(item => typeof item === "string").join("\n")
      : "";
    throw new Error(details || (typeof record.result === "string" ? record.result : t("ui.claude_task_failed")));
  }
  if (plainText && typeof record.result === "string") return record.result;
  if (record.structured_output === undefined || record.structured_output === null)
    throw new Error(t("ui.claude_did_not_return_structured_output"));
  return JSON.stringify(record.structured_output);
}

/** Facts of the `--verbose` transcript array (see {@link ClaudeTranscriptFacts}); anything it does not show is left out. */
export function claudeTranscriptMilestones(transcript: unknown): AiMilestones {
  if (!Array.isArray(transcript)) return {};
  const facts = new ClaudeTranscriptFacts();
  for (const item of transcript as unknown[]) facts.read(item);
  return facts.milestones();
}

/** Above this the verbose transcript is not kept; a truncated JSON array could not be parsed anyway. */
const CLAUDE_STDOUT_LIMIT = 64 * 1024 * 1024;

type ClaudeRecord = {
  type?: unknown;
  parent_tool_use_id?: unknown;
  message?: {
    content?: Array<{
      type?: unknown;
      id?: unknown;
      name?: unknown;
      text?: unknown;
      tool_use_id?: unknown;
      is_error?: unknown;
    }>;
  };
};

/** Translates the main agent's WebSearch/WebFetch calls into provider-neutral web events and counts successful retrievals. */
export class ClaudeWebActivity {
  private readonly pending = new Map<string, "search" | "openPage">();
  retrievals = 0;
  constructor(private readonly emit?: (event: WebSearchEvent) => void) {}

  read(value: unknown): void {
    const record = value as ClaudeRecord | null;
    if (!record || typeof record !== "object" || record.parent_tool_use_id) return;
    for (const item of record.message?.content ?? []) {
      if (
        record.type === "assistant" &&
        item.type === "tool_use" &&
        typeof item.id === "string" &&
        (item.name === "WebSearch" || item.name === "WebFetch")
      ) {
        this.pending.set(item.id, item.name === "WebSearch" ? "search" : "openPage");
        this.send({ method: "item/started", params: { item: { id: item.id, type: "webSearch", action: null } } });
      } else if (
        record.type === "user" &&
        item.type === "tool_result" &&
        typeof item.tool_use_id === "string" &&
        this.pending.has(item.tool_use_id)
      ) {
        const action = this.pending.get(item.tool_use_id)!;
        this.pending.delete(item.tool_use_id);
        if (item.is_error === true) continue;
        this.retrievals++;
        this.send({
          method: "item/completed",
          params: { item: { id: item.tool_use_id, type: "webSearch", action: { type: action } } }
        });
      }
    }
  }

  private send(event: WebSearchEvent): void {
    // Telemetry consumers must not be able to fail the provider task.
    try {
      this.emit?.(event);
    } catch {
      /* Diagnostics are best effort. */
    }
  }
}

function abortError(): Error {
  const error = new Error(t("ui.ai_task_cancelled"));
  error.name = "AbortError";
  return error;
}

/** The CLI refused the stream flags while starting up (an older CLI), as opposed to a failure of the model call. */
export function streamFlagsRejected(stderr: string): boolean {
  return /unknown option|unrecognized (option|argument)|argument '[^']*' is invalid|--include-partial-messages|--output-format/i.test(
    stderr
  );
}

export class ClaudeCodeCliRuntime {
  private readonly spawn: ClaudeSpawn;
  /** Set when this CLI rejected the stream flags at start-up; later observed calls use json mode straight away. */
  private streamUnsupported = false;
  constructor(private readonly options: ClaudeCodeCliOptions) {
    this.spawn = options.spawn ?? nodeSpawn;
  }

  private warmKey(args: string[]): string {
    return [this.options.executable, this.options.cwd, ...args].join("\0");
  }

  /**
   * Starts an idle process for an observed research call with these settings (a dialog just opened). It makes no model
   * call: the CLI waits for a user message on stdin. `runTask` takes it only when its own command is identical.
   */
  prewarm(model: string, effort: string, outputSchema: unknown, webSearch: boolean): boolean {
    const pool = this.options.warmPool;
    if (!pool || !outputSchema || this.streamUnsupported) return false;
    const args = claudeWarmArgs(model, effort, outputSchema, webSearch);
    return pool.prewarm(this.warmKey(args), () =>
      this.spawn(this.options.executable, args, {
        cwd: this.options.cwd,
        env: this.options.env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true
      })
    );
  }

  runTask(
    prompt: string,
    model: string,
    effort: string,
    outputSchema: unknown,
    controls: ClaudeTaskControls = {}
  ): Promise<string> {
    return this.run(prompt, model, effort, outputSchema, controls, false);
  }

  private async run(
    prompt: string,
    model: string,
    effort: string,
    outputSchema: unknown,
    controls: ClaudeTaskControls,
    fallback: boolean
  ): Promise<string> {
    if (controls.signal?.aborted) {
      // A stopped run that never got to use its pre-started process must not leave it waiting.
      this.options.warmPool?.release();
      throw abortError();
    }
    const webSearch = controls.webSearch ?? (controls.searchBudget ?? 0) > 0;
    let args = claudeTaskArgs(model, effort, outputSchema, webSearch);
    // An image travels as a content block, which only the stream-json input format can carry.
    const image = controls.imageDataUrl ? claudeImageSource(controls.imageDataUrl) : null;
    const observed = !!outputSchema && controls.stream === true && !image && !fallback && !this.streamUnsupported;
    if (controls.onText && !outputSchema) {
      args[args.indexOf("json")] = "stream-json";
      args.push("--include-partial-messages");
      if (controls.onSteer || image) args.push("--input-format", "stream-json");
    } else if (image) {
      args[args.indexOf("json")] = "stream-json";
      args.push("--input-format", "stream-json");
    } else if (observed) {
      args[args.indexOf("json")] = "stream-json";
      args.push("--include-partial-messages");
    }
    // A process pre-started for exactly this command only needs the prompt; a different pre-started process stays for its own run.
    const pool = this.options.warmPool;
    const warmArgs =
      pool && observed && !controls.onSteer ? claudeWarmArgs(model, effort, outputSchema, webSearch) : null;
    const warm = warmArgs ? pool!.take(this.warmKey(warmArgs)) : null;
    if (warmArgs && warm) args = warmArgs;
    if (outputSchema && controls.stream === true) {
      try {
        controls.onStreamMode?.(observed ? "stream-json" : fallback ? "json-fallback" : "json");
      } catch {
        /* Diagnostics are best effort. */
      }
    }
    controls.onRequest?.({
      provider: "claude",
      executable: this.options.executable,
      args: args.map((arg, index) =>
        index === args.indexOf(JSON.stringify(claudeOutputSchema(outputSchema))) ? "<response-schema>" : arg
      ),
      input: image ? `<VAM prompt and ${image.media_type} image via stdin>` : "<VAM prompt via stdin>"
    });
    this.options.onLog?.(
      "info",
      t(
        "log.claude_starting_0_1",
        this.options.executable,
        t(webSearch ? "log.claude_web_search_available" : "log.claude_vam_context_only")
      )
    );

    if (warmArgs) {
      try {
        controls.onMilestones?.({ prespawned: !!warm });
      } catch {
        /* Diagnostics are best effort. */
      }
    }

    return new Promise<string>((resolve, reject) => {
      let child: ClaudeProcess;
      try {
        child =
          warm ??
          this.spawn(this.options.executable, args, {
            cwd: this.options.cwd,
            env: this.options.env,
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true
          });
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      let stdout = "",
        stderr = "",
        settled = false,
        accepted = false,
        inputOpen = Boolean(controls.onSteer || image || warm);
      let streamBuffer = "",
        streamText = "",
        currentText = "",
        finalResult = "";
      // Image input forces stream-json output, read line by line like a streamed reply.
      const streaming = (!!controls.onText && !outputSchema) || !!image || observed;
      const activity = new ClaudeWebActivity(controls.onWebSearchEvent);
      const observer = observed
        ? new ClaudeStreamObserver({
            onFirstEvent: controls.onFirstEvent,
            onStage: controls.onStage,
            onStructuredDelta: controls.onStructuredDelta,
            onStructuredJson: controls.onStructuredJson
          })
        : null;
      const readStreamLine = (line: string): void => {
        // The CLI can print plain-text warnings between JSON records; only records carry task state.
        if (!line.trim().startsWith("{")) return;
        let parsedLine: unknown;
        try {
          parsedLine = JSON.parse(line);
        } catch (error) {
          // A line that cannot be read ends the stage and preview updates only; the result is still taken from `result`.
          if (!observer) throw error;
          observer.stop();
          return;
        }
        activity.read(parsedLine);
        observer?.read(parsedLine);
        const record = parsedLine as {
          type?: string;
          parent_tool_use_id?: string | null;
          event?: { type?: string; delta?: { type?: string; text?: string } };
          message?: { content?: Array<{ type?: string; text?: string }> };
        };
        if (record.parent_tool_use_id) return;
        if (record.type === "result") {
          finalResult = line;
          if (inputOpen) {
            inputOpen = false;
            child.stdin.end();
          }
          return;
        }
        if (record.type === "stream_event" && record.event?.type === "message_start") currentText = "";
        if (
          record.type === "stream_event" &&
          record.event?.delta?.type === "text_delta" &&
          typeof record.event.delta.text === "string"
        ) {
          currentText += record.event.delta.text;
          controls.onText?.([streamText, currentText].filter(Boolean).join("\n\n"));
        }
        if (record.type === "stream_event" && record.event?.type === "message_stop") {
          if (currentText.trim()) streamText = [streamText, currentText].filter(Boolean).join("\n\n");
          currentText = "";
          controls.onText?.(streamText);
        }
        if (record.type === "assistant" && record.message?.content) {
          const complete = record.message.content
            .filter(item => item.type === "text")
            .map(item => item.text ?? "")
            .join("\n");
          if (complete && !streamText.endsWith(complete)) {
            currentText = complete;
            controls.onText?.([streamText, currentText].filter(Boolean).join("\n\n"));
          }
        }
      };
      const cleanup = (): void => {
        window.clearTimeout(timeout);
        controls.signal?.removeEventListener("abort", onAbort);
      };
      // Best effort: call facts never fail the task.
      const reportMilestones = (data: AiMilestones): void => {
        try {
          if (Object.keys(data).length) controls.onMilestones?.(data);
        } catch {
          /* Diagnostics are best effort. */
        }
      };
      const finish = (error?: Error, result?: string): void => {
        if (settled) return;
        settled = true;
        cleanup();
        if (observer) reportMilestones(observer.milestones());
        if (error) reject(error);
        else resolve(result ?? "");
      };
      const markAccepted = (): void => {
        if (accepted || settled || controls.signal?.aborted) return;
        accepted = true;
        observer?.accepted();
        controls.onAccepted?.();
      };
      let killTimer: number | undefined;
      const stop = (): void => {
        try {
          child.kill("SIGTERM");
        } catch {
          /* Process may already have exited. */
        }
        killTimer = window.setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            /* Process may already have exited. */
          }
        }, 1_500);
      };
      const onAbort = (): void => {
        stop();
        finish(abortError());
      };
      const timeout = window.setTimeout(
        () => {
          stop();
          finish(
            new Error(
              controls.timeoutMessage ??
                (controls.timeoutMs
                  ? t("ui.ai_task_exceeded_0_minutes", Math.ceil(controls.timeoutMs / 60_000))
                  : t("ui.the_ai_task_exceeded_3_minutes_vam_attempts_to_interrupt_it"))
            )
          );
        },
        controls.timeoutMs ?? this.options.timeoutMs ?? CLAUDE_TASK_TIMEOUT_MS
      );
      controls.signal?.addEventListener("abort", onAbort, { once: true });
      const stdoutDecoder = createUtf8StreamDecoder();
      const stderrDecoder = createUtf8StreamDecoder();
      child.stdout.on("data", chunk => {
        if (settled) return;
        if (!streaming) {
          stdout += stdoutDecoder.write(chunk);
          if (stdout.length > CLAUDE_STDOUT_LIMIT) {
            stop();
            finish(new Error(t("ui.claude_returned_an_invalid_response")));
          }
          return;
        }
        streamBuffer += stdoutDecoder.write(chunk);
        try {
          let newline: number;
          while ((newline = streamBuffer.indexOf("\n")) >= 0) {
            const line = streamBuffer.slice(0, newline);
            streamBuffer = streamBuffer.slice(newline + 1);
            readStreamLine(line);
          }
        } catch (error) {
          stop();
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      });
      child.stderr.on("data", chunk => {
        if (!settled) stderr = `${stderr}${stderrDecoder.write(chunk)}`.slice(-16_384);
      });
      child.on("error", error => {
        if (killTimer) window.clearTimeout(killTimer);
        finish(new Error(t("ui.could_not_start_claude_code_0_1", this.options.executable, error.message)));
      });
      child.on("close", code => {
        if (killTimer) window.clearTimeout(killTimer);
        if (settled) return;
        if (observer && code !== 0 && !finalResult && !observer.sawModel() && streamFlagsRejected(stderr)) {
          // This CLI does not know the stream flags (it stopped before any model call): run once more in json mode and
          // remember it, so later calls do not pay for the failed start.
          settled = true;
          cleanup();
          this.streamUnsupported = true;
          this.options.onLog?.("warn", t("log.claude_stream_fallback"));
          this.run(prompt, model, effort, outputSchema, controls, true).then(resolve, reject);
          return;
        }
        if (!streaming && controls.onMilestones) {
          try {
            reportMilestones({
              ...(outputSchema && controls.stream === true ? { stream: fallback ? "json-fallback" : "json" } : {}),
              ...claudeTranscriptMilestones(JSON.parse(stdout))
            });
          } catch {
            /* A broken transcript is reported by the result parsing below. */
          }
        }
        if (code !== 0) {
          let message = stderr.trim();
          if (!message) {
            try {
              claudeStructuredOutput(streaming ? finalResult : stdout, !outputSchema);
            } catch (error) {
              if (error instanceof Error && !(error instanceof SyntaxError)) message = error.message;
            }
          }
          message ||= t("ui.claude_exited_with_code_0", code ?? t("ui.unknown"));
          finish(new Error(message.slice(-4_000)));
          return;
        }
        try {
          if (streaming) readStreamLine(streamBuffer);
          else {
            const transcript: unknown = JSON.parse(stdout);
            if (Array.isArray(transcript)) for (const record of transcript) activity.read(record);
          }
          const result = claudeStructuredOutput(streaming ? finalResult : stdout, !outputSchema);
          if (controls.webSearchOnly && !activity.retrievals) throw searchNotPerformedError();
          const streamed = [streamText, currentText].filter(Boolean).join("\n\n");
          finish(undefined, !outputSchema && streaming && result.length < streamed.length ? streamed : result);
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      });
      // A failed spawn closes stdin; the process error/close events report the cause.
      child.stdin.on?.("error", () => {
        /* Surfaced through the process events. */
      });
      try {
        if (controls.onSteer || image || warm) {
          const sendInput = (text: string, accepted?: () => void, withImage = false): void => {
            if (!inputOpen || settled) throw new Error("This Coffee Tables response has already ended.");
            const content = [...(withImage && image ? [{ type: "image", source: image }] : []), { type: "text", text }];
            child.stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content } })}\n`, error => {
              if (error) {
                stop();
                finish(error);
                return;
              }
              if (!settled && !controls.signal?.aborted) accepted?.();
            });
          };
          sendInput(prompt, markAccepted, true);
          controls.onSteer?.(async text => {
            sendInput(text);
          });
        } else if (controls.onAccepted || observer) {
          child.stdin.end(prompt, error => {
            if (error) {
              stop();
              finish(error);
            } else markAccepted();
          });
        } else child.stdin.end(prompt);
      } catch (error) {
        stop();
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
}
