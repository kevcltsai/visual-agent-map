import { spawn as nodeSpawn } from "node:child_process";
import { t } from "../../i18n";

interface ClaudeProcess {
  stdin: { write(data: string, callback?: (error?: Error | null) => void): boolean; end(data?: string, callback?: (error?: Error | null) => void): void };
  stdout: { on(event: "data", listener: (chunk: { toString(encoding?: string): string }) => void): void };
  stderr: { on(event: "data", listener: (chunk: { toString(encoding?: string): string }) => void): void };
  on(event: "error", listener: (error: Error) => void): void;
  on(event: "close", listener: (code: number | null, signal?: string | null) => void): void;
  kill(signal?: NodeJS.Signals): boolean;
}
export type ClaudeSpawn = (executable: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; stdio: ["pipe", "pipe", "pipe"]; windowsHide: true }) => ClaudeProcess;
export interface ClaudeCodeCliOptions {
  executable: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  onLog?: (level: "info" | "warn" | "error", message: string) => void;
  spawn?: ClaudeSpawn;
  timeoutMs?: number;
}
export interface ClaudeTaskControls {
  signal?: AbortSignal;
  searchBudget?: number;
  onRequest?: (request: unknown) => void;
  onAccepted?: () => void;
  onProgress?: (message: string) => void;
  onText?: (text: string) => void;
  onSteer?: (steer: (text: string) => Promise<void>) => void;
  timeoutMs?: number;
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
    "--print", "--output-format", "json", "--verbose",
    ...(schema ? ["--json-schema", JSON.stringify(claudeOutputSchema(schema))] : []),
    "--model", model,
    "--effort", ["low", "medium", "high"].includes(effort) ? effort : "low",
    "--permission-mode", "dontAsk", "--permission-prompts", "none",
    "--safe-mode", "--strict-mcp-config", "--mcp-config", JSON.stringify({ mcpServers: {} }), "--no-session-persistence",
    "--tools", webSearch ? "WebSearch,WebFetch" : ""
  ];
}

export function claudeStructuredOutput(stdout: string, plainText = false): string {
  const value: unknown = JSON.parse(stdout);
  const events: unknown[] = Array.isArray(value) ? value as unknown[] : [];
  const final: unknown = events.length ? events.reverse().find(item => item && typeof item === "object" && "type" in item && item.type === "result") : value;
  if (!final || typeof final !== "object") throw new Error(t("ui.claude_returned_an_invalid_response"));
  const record = final as { type?: unknown; structured_output?: unknown; result?: unknown; is_error?: unknown; subtype?: unknown; errors?: unknown };
  if (record.is_error === true || (typeof record.subtype === "string" && record.subtype.startsWith("error_"))) {
    const details = Array.isArray(record.errors) ? record.errors.filter(item => typeof item === "string").join("\n") : "";
    throw new Error(details || (typeof record.result === "string" ? record.result : t("ui.claude_task_failed")));
  }
  if (plainText && typeof record.result === "string") return record.result;
  if (record.structured_output === undefined || record.structured_output === null) throw new Error(t("ui.claude_did_not_return_structured_output"));
  return JSON.stringify(record.structured_output);
}

function abortError(): Error {
  const error = new Error(t("ui.ai_task_cancelled"));
  error.name = "AbortError";
  return error;
}

export class ClaudeCodeCliRuntime {
  private readonly spawn: ClaudeSpawn;
  constructor(private readonly options: ClaudeCodeCliOptions) {
    this.spawn = options.spawn ?? nodeSpawn;
  }

  async runTask(prompt: string, model: string, effort: string, outputSchema: unknown, controls: ClaudeTaskControls = {}): Promise<string> {
    if (controls.signal?.aborted) throw abortError();
    const webSearch = (controls.searchBudget ?? 0) > 0;
    const args = claudeTaskArgs(model, effort, outputSchema, webSearch);
    if (controls.onText && !outputSchema) { args[args.indexOf("json")] = "stream-json"; args.push("--include-partial-messages"); if (controls.onSteer) args.push("--input-format", "stream-json"); }
    controls.onRequest?.({ provider: "claude", executable: this.options.executable, args: args.map((arg, index) => index === args.indexOf(JSON.stringify(claudeOutputSchema(outputSchema))) ? "<response-schema>" : arg), input: "<VAM prompt via stdin>" });
    this.options.onLog?.("info", `啟動 Claude Code：${this.options.executable} --print (${webSearch ? "網路搜尋可用" : "僅使用 VAM 提供的內容"})`);

    return new Promise<string>((resolve, reject) => {
      let child: ClaudeProcess;
      try {
        child = this.spawn(this.options.executable, args, { cwd: this.options.cwd, env: this.options.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      let stdout = "", stderr = "", settled = false, accepted = false, inputOpen = Boolean(controls.onSteer);
      let streamBuffer = "", streamText = "", currentText = "", finalResult = "";
      const streaming = !!controls.onText && !outputSchema;
      const readStreamLine = (line: string): void => {
        if (!line.trim()) return;
        const record = JSON.parse(line) as { type?: string; parent_tool_use_id?: string | null; event?: { type?: string; delta?: { type?: string; text?: string } }; message?: { content?: Array<{ type?: string; text?: string }> } };
        if (record.parent_tool_use_id) return;
        if (record.type === "result") { finalResult = line; if (inputOpen) { inputOpen = false; child.stdin.end(); } return; }
        if (record.type === "stream_event" && record.event?.type === "message_start") currentText = "";
        if (record.type === "stream_event" && record.event?.delta?.type === "text_delta" && typeof record.event.delta.text === "string") { currentText += record.event.delta.text; controls.onText?.([streamText, currentText].filter(Boolean).join("\n\n")); }
        if (record.type === "stream_event" && record.event?.type === "message_stop") { if (currentText.trim()) streamText = [streamText, currentText].filter(Boolean).join("\n\n"); currentText = ""; controls.onText?.(streamText); }
        if (record.type === "assistant" && record.message?.content) { const complete = record.message.content.filter(item => item.type === "text").map(item => item.text ?? "").join("\n"); if (complete && !streamText.endsWith(complete)) { currentText = complete; controls.onText?.([streamText, currentText].filter(Boolean).join("\n\n")); } }
      };
      const cleanup = (): void => {
        window.clearTimeout(timeout);
        controls.signal?.removeEventListener("abort", onAbort);
      };
      const finish = (error?: Error, result?: string): void => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve(result ?? "");
      };
      const markAccepted = (): void => {
        if (accepted || settled || controls.signal?.aborted) return;
        accepted = true;
        controls.onAccepted?.();
      };
      let killTimer: number | undefined;
      const stop = (): void => {
        try { child.kill("SIGTERM"); } catch { /* Process may already have exited. */ }
        killTimer = window.setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* Process may already have exited. */ } }, 1_500);
      };
      const onAbort = (): void => { stop(); finish(abortError()); };
      const timeout = window.setTimeout(() => {
        stop();
        finish(new Error(controls.timeoutMs ? "Coffee Tables: generation timed out; received text is saved as a draft." : t("ui.the_ai_task_exceeded_3_minutes_vam_attempts_to_interrupt_it")));
      }, controls.timeoutMs ?? this.options.timeoutMs ?? CLAUDE_TASK_TIMEOUT_MS);
      controls.signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout.on("data", chunk => {
        if (settled) return;
        if (!streaming) { stdout = `${stdout}${chunk.toString("utf8")}`.slice(-4_000_000); return; }
        streamBuffer += chunk.toString("utf8");
        try { let newline: number; while ((newline = streamBuffer.indexOf("\n")) >= 0) { const line = streamBuffer.slice(0, newline); streamBuffer = streamBuffer.slice(newline + 1); readStreamLine(line); } }
        catch (error) { stop(); finish(error instanceof Error ? error : new Error(String(error))); }
      });
      child.stderr.on("data", chunk => { if (!settled) stderr = `${stderr}${chunk.toString("utf8")}`.slice(-16_384); });
      child.on("error", error => {
        if (killTimer) window.clearTimeout(killTimer);
        finish(new Error(t("ui.could_not_start_claude_code_0_1", this.options.executable, error.message)));
      });
      child.on("close", code => {
        if (killTimer) window.clearTimeout(killTimer);
        if (settled) return;
        if (code !== 0) {
          let message = stderr.trim();
          if (!message) {
            try { claudeStructuredOutput(streaming ? finalResult : stdout, !outputSchema); }
            catch (error) { if (error instanceof Error && !(error instanceof SyntaxError)) message = error.message; }
          }
          message ||= t("ui.claude_exited_with_code_0", code ?? t("ui.unknown"));
          finish(new Error(message.slice(-4_000)));
          return;
        }
        try {
          if (streaming) readStreamLine(streamBuffer);
          const result = claudeStructuredOutput(streaming ? finalResult : stdout, !outputSchema);
          const streamed = [streamText, currentText].filter(Boolean).join("\n\n");
          finish(undefined, streaming && result.length < streamed.length ? streamed : result);
        }
        catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
      });
      try {
        if (controls.onSteer) {
          const sendInput = (text: string, accepted?: () => void): void => {
            if (!inputOpen || settled) throw new Error("This Coffee Tables response has already ended.");
            child.stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } })}\n`, error => {
              if (error) { stop(); finish(error); return; }
              if (!settled && !controls.signal?.aborted) accepted?.();
            });
          };
          sendInput(prompt, markAccepted);
          controls.onSteer(async text => { sendInput(text); });
        } else if (controls.onAccepted) {
          child.stdin.end(prompt, error => { if (error) { stop(); finish(error); } else markAccepted(); });
        } else child.stdin.end(prompt);
      }
      catch (error) { stop(); finish(error instanceof Error ? error : new Error(String(error))); }
    });
  }
}
