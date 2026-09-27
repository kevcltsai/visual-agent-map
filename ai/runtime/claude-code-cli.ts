import { spawn as nodeSpawn } from "node:child_process";
import { t } from "../../i18n";

interface ClaudeProcess {
  stdin: { end(data?: string): void };
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
  onProgress?: (message: string) => void;
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
    "--json-schema", JSON.stringify(claudeOutputSchema(schema)),
    "--model", model,
    "--effort", ["low", "medium", "high"].includes(effort) ? effort : "low",
    "--permission-mode", "dontAsk", "--permission-prompts", "none",
    "--safe-mode", "--strict-mcp-config", "--mcp-config", JSON.stringify({ mcpServers: {} }), "--no-session-persistence",
    "--tools", webSearch ? "WebSearch,WebFetch" : ""
  ];
}

export function claudeStructuredOutput(stdout: string): string {
  const value: unknown = JSON.parse(stdout);
  const events: unknown[] = Array.isArray(value) ? value as unknown[] : [];
  const final: unknown = events.length ? events.reverse().find(item => item && typeof item === "object" && "type" in item && item.type === "result") : value;
  if (!final || typeof final !== "object") throw new Error(t("ui.claude_returned_an_invalid_response"));
  const record = final as { type?: unknown; structured_output?: unknown; result?: unknown; is_error?: unknown; subtype?: unknown; errors?: unknown };
  if (record.is_error === true || (typeof record.subtype === "string" && record.subtype.startsWith("error_"))) {
    const details = Array.isArray(record.errors) ? record.errors.filter(item => typeof item === "string").join("\n") : "";
    throw new Error(details || (typeof record.result === "string" ? record.result : t("ui.claude_task_failed")));
  }
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
      let stdout = "", stderr = "", settled = false;
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
      let killTimer: number | undefined;
      const stop = (): void => {
        try { child.kill("SIGTERM"); } catch { /* Process may already have exited. */ }
        killTimer = window.setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* Process may already have exited. */ } }, 1_500);
      };
      const onAbort = (): void => { stop(); finish(abortError()); };
      const timeout = window.setTimeout(() => {
        stop();
        finish(new Error(t("ui.the_ai_task_exceeded_3_minutes_vam_attempts_to_interrupt_it")));
      }, this.options.timeoutMs ?? CLAUDE_TASK_TIMEOUT_MS);
      controls.signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout.on("data", chunk => { if (!settled) stdout = `${stdout}${chunk.toString("utf8")}`.slice(-4_000_000); });
      child.stderr.on("data", chunk => { if (!settled) stderr = `${stderr}${chunk.toString("utf8")}`.slice(-16_384); });
      child.on("error", error => {
        if (killTimer) window.clearTimeout(killTimer);
        finish(new Error(t("ui.could_not_start_claude_code_0_1", this.options.executable, error.message)));
      });
      child.on("close", code => {
        if (killTimer) window.clearTimeout(killTimer);
        if (settled) return;
        if (code !== 0) {
          const message = stderr.trim() || t("ui.claude_exited_with_code_0", code ?? t("ui.unknown"));
          finish(new Error(message.slice(-4_000)));
          return;
        }
        try { finish(undefined, claudeStructuredOutput(stdout)); }
        catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
      });
      try { child.stdin.end(prompt); }
      catch (error) { stop(); finish(error instanceof Error ? error : new Error(String(error))); }
    });
  }
}
