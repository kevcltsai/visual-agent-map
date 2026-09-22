import { spawn as nodeSpawn } from "node:child_process";
import { t } from "../../i18n";

type ProcessEnvironment = Record<string, string | undefined>;
interface NodeChunk { toString(encoding?: string): string }
interface ReadableProcessStream { on(event: "data", listener: (chunk: NodeChunk) => void): this }
interface WritableProcessStream { write(data: string): boolean }
interface ChildProcessHandle {
  stdin: WritableProcessStream;
  stdout: ReadableProcessStream;
  stderr: ReadableProcessStream;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "close", listener: (code: number | null) => void): this;
  kill(): boolean;
}
type SpawnProcess = (executable: string, args: string[], options: {
  cwd: string;
  env: ProcessEnvironment;
  stdio: ["pipe", "pipe", "pipe"];
}) => ChildProcessHandle;
const spawnProcess = nodeSpawn as unknown as SpawnProcess;

export interface CodexModel {
  id: string;
  model: string;
  displayName: string;
  hidden: boolean;
  supportedReasoningEfforts: Array<{ reasoningEffort: string; description?: string }>;
  defaultReasoningEffort: string;
  isDefault: boolean;
}

export interface CodexAppServerOptions {
  executable: string;
  cwd: string;
  env: ProcessEnvironment;
  clientVersion: string;
  webSearchDisabled?: boolean;
  onLog?: (level: "info" | "warn" | "error", message: string) => void;
}

interface RpcResponse { id: number; result?: unknown; error?: { message?: string } }
interface RpcNotification { method: string; params?: unknown }
interface RpcServerRequest { id: number | string; method: string; params?: unknown }
interface PendingRequest { resolve: (value: unknown) => void; reject: (error: Error) => void; timeout: number }
interface TurnState { messages: string[]; resolve: (text: string) => void; reject: (error: Error) => void; timeout: number; turnId: string; searches: number; searchBudget: number; steered: boolean }

const CONTROL_TIMEOUT_MS = 30_000;
const TURN_TIMEOUT_MS = 3 * 60 * 1000;
function cancelledError(): Error { const error = new Error("AI 任務已取消"); error.name = "AbortError"; return error; }

export class CodexAppServerRuntime {
  private child: ChildProcessHandle | null = null;
  private buffer = "";
  private stderr = "";
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private turns = new Map<string, TurnState>();
  private initializing: Promise<void> | null = null;

  constructor(private readonly options: CodexAppServerOptions) {}

  async start(): Promise<void> {
    if (this.initializing) return this.initializing;
    const initializing = this.startProcess();
    this.initializing = initializing;
    try { await initializing; }
    catch (error) {
      if (this.initializing === initializing) this.initializing = null;
      const child = this.child;
      if (child) this.failProcess(child, error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  stop(): void {
    const error = new Error("Codex App Server 已停止");
    for (const entry of this.pending.values()) { window.clearTimeout(entry.timeout); entry.reject(error); }
    for (const entry of this.turns.values()) { window.clearTimeout(entry.timeout); entry.reject(error); }
    this.pending.clear();
    this.turns.clear();
    this.child?.kill();
    this.child = null;
    this.initializing = null;
  }

  async listModels(): Promise<CodexModel[]> {
    await this.start();
    const models: CodexModel[] = [];
    let cursor: string | null = null;
    do {
      const response = await this.request("model/list", { cursor, limit: 100, includeHidden: false }) as { data?: unknown[]; nextCursor?: unknown };
      for (const value of response.data ?? []) {
        if (!value || typeof value !== "object") continue;
        const item = value as Partial<CodexModel>;
        const model = typeof item.model === "string" ? item.model.trim() : "";
        const id = typeof item.id === "string" ? item.id.trim() : "";
        const displayName = typeof item.displayName === "string" ? item.displayName.trim() : "";
        const efforts = Array.isArray(item.supportedReasoningEfforts) ? item.supportedReasoningEfforts : [];
        if (item.hidden !== false || !model || !id || !displayName || !efforts.length) continue;
        models.push({
          id, model, displayName, hidden: false,
          supportedReasoningEfforts: efforts,
          defaultReasoningEffort: typeof item.defaultReasoningEffort === "string" ? item.defaultReasoningEffort : "low",
          isDefault: item.isDefault === true
        });
      }
      cursor = typeof response.nextCursor === "string" && response.nextCursor ? response.nextCursor : null;
    } while (cursor);
    return [...new Map(models.map(model => [model.model, model])).values()];
  }

  async runTask(prompt: string, model: string, effort: string, outputSchema: unknown, controls?: { signal?: AbortSignal; searchBudget?: number; onRequest?: (request: unknown) => void }): Promise<string> {
    if (controls?.signal?.aborted) throw cancelledError();
    await this.start();
    if (controls?.signal?.aborted) throw cancelledError();
    const started = await this.request("thread/start", {
      model: model || null,
      cwd: this.options.cwd,
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: true
    }) as { thread?: { id?: unknown } };
    const threadId = typeof started.thread?.id === "string" ? started.thread.id : "";
    if (!threadId) throw new Error("Codex App Server 沒有建立 thread");

    let timedOut = false, interruptRequested = false;
    const completed = new Promise<string>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.turns.delete(threadId);
        timedOut = true;
        interrupt(5_000, "逾時後無法停止 AI 任務");
        reject(new Error(t("AI 任務超過 3 分鐘，為避免長時間佔用資源，VAM 會嘗試中斷。未完成的結果不會套用；請縮小任務範圍後重試。")));
      }, TURN_TIMEOUT_MS);
      this.turns.set(threadId, { messages: [], resolve, reject, timeout, turnId: "", searches: 0, searchBudget: controls?.searchBudget ?? 0, steered: false });
    });
    const state = this.turns.get(threadId)!;
    const interrupt = (timeoutMs = CONTROL_TIMEOUT_MS, failure = "取消 AI 任務失敗"): void => {
      if (!state.turnId || interruptRequested) return;
      interruptRequested = true;
      void this.request("turn/interrupt", { threadId, turnId: state.turnId }, timeoutMs).catch(error => this.options.onLog?.("warn", `${failure}：${error instanceof Error ? error.message : String(error)}`));
    };
    const onAbort = (): void => interrupt();
    controls?.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      if (controls?.signal?.aborted) throw cancelledError();
      const turnRequest = {
        threadId,
        input: [{ type: "text", text: prompt, text_elements: [] }],
        model: model || null,
        effort: effort || "low",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
        outputSchema
      };
      controls?.onRequest?.(turnRequest);
      const startedTurn = await this.request("turn/start", turnRequest) as { turn?: { id?: unknown } };
      state.turnId = typeof startedTurn.turn?.id === "string" ? startedTurn.turn.id : "";
      if (timedOut) interrupt(5_000, "逾時後無法停止 AI 任務");
      else if (controls?.signal?.aborted) interrupt();
      this.steerIfNeeded(threadId, state);
      const answer = await completed;
      if (controls?.signal?.aborted) throw cancelledError();
      return answer;
    } catch (error) {
      const state = this.turns.get(threadId);
      if (state) { window.clearTimeout(state.timeout); this.turns.delete(threadId); state.reject(error instanceof Error ? error : new Error(String(error))); await completed.catch(() => undefined); }
      else await completed.catch(() => undefined);
      if (controls?.signal?.aborted) throw cancelledError();
      throw error;
    } finally {
      controls?.signal?.removeEventListener("abort", onAbort);
      try { await this.request("thread/unsubscribe", { threadId }, 5_000); }
      catch (error) { this.options.onLog?.("warn", `Codex App Server 無法取消 thread 訂閱：${error instanceof Error ? error.message : String(error)}`); }
    }
  }

  private async startProcess(): Promise<void> {
    this.options.onLog?.("info", `啟動 Codex App Server：${this.options.executable} app-server`);
    this.buffer = "";
    this.stderr = "";
    const child = spawnProcess(this.options.executable, this.options.webSearchDisabled ? ["--config", "web_search=\"disabled\"", "app-server"] : ["app-server"], {
      cwd: this.options.cwd,
      env: this.options.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.child = child;
    child.stdout.on("data", chunk => this.consume(child, chunk.toString("utf8")));
    child.stderr.on("data", chunk => { if (this.child === child) this.stderr = `${this.stderr}${chunk.toString("utf8")}`.slice(-16_384); });
    child.on("error", error => this.failProcess(child, new Error(`無法啟動 Codex App Server（${this.options.executable}）：${error.message}`)));
    child.on("close", code => this.failProcess(child, new Error(this.stderr.trim() || `Codex App Server 結束碼：${code ?? "未知"}`)));
    await this.request("initialize", {
      clientInfo: { name: "visual-agent-map", title: "Visual Agent Map", version: this.options.clientVersion },
      capabilities: { experimentalApi: false, requestAttestation: false }
    });
    this.send({ method: "initialized" });
    this.options.onLog?.("info", "Codex App Server 已就緒");
  }

  private consume(child: ChildProcessHandle, chunk: string): void {
    if (this.child !== child) return;
    this.buffer += chunk;
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      try { this.handle(JSON.parse(line) as RpcResponse | RpcNotification | RpcServerRequest); }
      catch (error) { this.failProcess(child, new Error(`Codex App Server 回應無法解析：${error instanceof Error ? error.message : String(error)}`)); }
    }
  }

  private handle(message: RpcResponse | RpcNotification | RpcServerRequest): void {
    if ("id" in message && "method" in message) {
      this.respondToServerRequest(message);
      return;
    }
    if ("id" in message) {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      window.clearTimeout(entry.timeout);
      if (message.error) entry.reject(new Error(message.error.message || "Codex App Server 回傳錯誤"));
      else entry.resolve(message.result);
      return;
    }
    if (!("method" in message)) return;
    const params = message.params as { threadId?: unknown; item?: unknown; turn?: unknown } | undefined;
    const threadId = typeof params?.threadId === "string" ? params.threadId : "";
    const state = this.turns.get(threadId);
    if (!state) return;
    if (message.method === "item/started") {
      const item = params?.item as { type?: unknown; action?: { type?: unknown } } | undefined;
      if (item?.type === "webSearch" && (!item.action || item.action.type === "search")) { state.searches++; this.steerIfNeeded(threadId, state); }
      return;
    }
    if (message.method === "item/completed") {
      const item = params?.item as { type?: unknown; text?: unknown } | undefined;
      if (item?.type === "agentMessage" && typeof item.text === "string") state.messages.push(item.text);
      return;
    }
    if (message.method === "turn/completed") {
      const turn = params?.turn as { status?: unknown; error?: { message?: unknown } | null } | undefined;
      window.clearTimeout(state.timeout);
      this.turns.delete(threadId);
      if (turn?.status === "completed") state.resolve(state.messages.at(-1)?.trim() || "");
      else state.reject(new Error(typeof turn?.error?.message === "string" ? turn.error.message : `Codex turn ${typeof turn?.status === "string" ? turn.status : "失敗"}`));
    }
  }

  private steerIfNeeded(threadId: string, state: TurnState): void {
    if (this.turns.get(threadId) !== state || state.steered || !state.searchBudget || state.searches < state.searchBudget || !state.turnId) return;
    state.steered = true;
    void this.request("turn/steer", { threadId, expectedTurnId: state.turnId, input: [{ type: "text", text: "網路搜尋預算已用完。請停止搜尋，根據已取得的資料完成答案；不足之處明確列為待確認。" }] }).catch(error => this.options.onLog?.("warn", `搜尋停止提醒未送達：${error instanceof Error ? error.message : String(error)}`));
  }

  private respondToServerRequest(message: RpcServerRequest): void {
    const result = message.method === "item/commandExecution/requestApproval" || message.method === "item/fileChange/requestApproval"
      ? { decision: "decline" }
      : message.method === "item/permissions/requestApproval"
        ? { permissions: {} }
        : message.method === "item/tool/requestUserInput"
          ? { answers: {} }
          : message.method === "mcpServer/elicitation/request"
            ? { action: "decline", content: null }
            : null;
    if (result) this.send({ id: message.id, result });
    else this.send({ id: message.id, error: { code: -32601, message: `Unsupported server request: ${message.method}` } });
  }

  private request(method: string, params?: unknown, timeoutMs = CONTROL_TIMEOUT_MS): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex App Server ${method} 在 ${Math.ceil(timeoutMs / 1000)} 秒內沒有回應`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      try { this.send({ id, method, params }); }
      catch (error) { window.clearTimeout(timeout); this.pending.delete(id); reject(error instanceof Error ? error : new Error(String(error))); }
    });
  }

  private send(message: object): void {
    if (!this.child) throw new Error("Codex App Server 尚未啟動");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private failProcess(child: ChildProcessHandle, error: Error): void {
    if (this.child !== child) return;
    this.options.onLog?.("error", error.message);
    for (const entry of this.pending.values()) { window.clearTimeout(entry.timeout); entry.reject(error); }
    for (const entry of this.turns.values()) { window.clearTimeout(entry.timeout); entry.reject(error); }
    this.pending.clear();
    this.turns.clear();
    this.child = null;
    this.initializing = null;
    child.kill();
  }
}
