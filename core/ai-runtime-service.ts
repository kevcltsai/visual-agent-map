import { spawnSync } from "node:child_process";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { CodexAppServerRuntime, type ReadLocalFile } from "../ai/runtime/codex-app-server";
import { ClaudeCodeCliRuntime, type ClaudeProcess, type ClaudeSpawn } from "../ai/runtime/claude-code-cli";
import { ClaudeWarmPool, type WarmClock } from "../ai/runtime/claude-warm-pool";
import type { LogLevel } from "../log-manager";
import { providerForModel, providerModelId } from "../ai/providers/provider";
import { CLAUDE_CAPABILITIES, CODEX_CAPABILITIES, type AiRuntime } from "./ai-runtime";

export type ProcessEnvironment = Record<string, string | undefined>;

function currentProcessEnvironment(): ProcessEnvironment {
  return (window as Window & { process?: { env?: ProcessEnvironment } }).process?.env ?? {};
}

export function executableCandidates(
  configured: string,
  home: string,
  pathValue: string,
  nvmVersions: string[] = []
): string[] {
  if (configured.includes("/") || configured.includes("\\")) return [configured];
  const dirs = [
    home ? join(home, ".local/bin") : "",
    home ? join(home, ".npm-global/bin") : "",
    home ? join(home, ".volta/bin") : "",
    home ? join(home, ".fnm/current/bin") : "",
    "/opt/homebrew/bin",
    "/usr/local/bin",
    ...nvmVersions.map(version => join(home, ".nvm/versions/node", version, "bin")),
    ...pathValue.split(delimiter)
  ].filter(Boolean);
  return [...new Set(dirs)].map(directory => join(directory, configured));
}

/**
 * Synchronous filesystem probe without `node:fs`: asks `/bin/sh` for the first existing path among `candidates`
 * (`[ -e ]`), or for the entry names of `listDirectory`. Any spawn failure (no sh, e.g. on Windows) reads as "nothing".
 */
export interface ExecutableProbe {
  firstExisting(candidates: string[]): string | null;
  listDirectory(directory: string): string[];
  /** False when the probe cannot run at all (no /bin/sh, e.g. Windows); absent means available. */
  available?(): boolean;
}

const FIRST_EXISTING_SCRIPT = 'for p in "$@"; do if [ -e "$p" ]; then printf %s "$p"; exit 0; fi; done; exit 1';
const LIST_DIRECTORY_SCRIPT =
  'cd "$1" 2>/dev/null || exit 1; for p in *; do [ -e "$p" ] && printf "%s\\n" "$p"; done; exit 0';

function runShell(script: string, args: string[]): string | null {
  try {
    const result = spawnSync("/bin/sh", ["-c", script, "sh", ...args], { encoding: "utf8", timeout: 5000 });
    if (result.error || result.status !== 0) return null;
    return result.stdout;
  } catch {
    return null;
  }
}

let shellAvailable: boolean | null = null;

export const shellExecutableProbe: ExecutableProbe = {
  available() {
    if (shellAvailable === null) {
      try {
        const result = spawnSync("/bin/sh", ["-c", "exit 0"], { timeout: 5000 });
        shellAvailable = !result.error && result.status === 0;
      } catch {
        shellAvailable = false;
      }
    }
    return shellAvailable;
  },
  firstExisting(candidates) {
    if (!candidates.length) return null;
    return runShell(FIRST_EXISTING_SCRIPT, candidates) || null;
  },
  listDirectory(directory) {
    return (runShell(LIST_DIRECTORY_SCRIPT, [directory]) ?? "").split("\n").filter(Boolean);
  }
};

/** The Claude Code CLI as an {@link AiRuntime}; `get` is read when a call runs, so nothing starts before then. */
export function claudeCodeAiRuntime(get: () => Pick<ClaudeCodeCliRuntime, "runTask">): AiRuntime {
  return {
    capabilities: CLAUDE_CAPABILITIES,
    run: async ({ prompt, model, effort, schema, controls }) =>
      get().runTask(prompt, providerModelId(model), effort, schema, controls)
  };
}

/** The Codex app server as an {@link AiRuntime}; `get` receives `localCodex` (the runtime without web search). */
export function codexAppServerAiRuntime(get: (local: boolean) => Pick<CodexAppServerRuntime, "runTask">): AiRuntime {
  return {
    capabilities: CODEX_CAPABILITIES,
    run: async ({ prompt, model, effort, schema, controls, localCodex }) =>
      get(localCodex).runTask(prompt, model, effort, schema, controls)
  };
}

/** The runtime that serves `model`: `claude:` ids go to Claude Code, anything else to Codex. */
export function aiRuntimeForModel(
  model: string,
  sources: {
    claude: () => Pick<ClaudeCodeCliRuntime, "runTask">;
    codex: (local: boolean) => Pick<CodexAppServerRuntime, "runTask">;
  }
): AiRuntime {
  return providerForModel(model) === "claude"
    ? claudeCodeAiRuntime(sources.claude)
    : codexAppServerAiRuntime(sources.codex);
}

export interface AiRuntimeServiceOptions {
  codexPath: () => string;
  claudePath: () => string;
  clientVersion: () => string;
  onLog: (level: LogLevel, message: string) => void;
  /** Tests inject a fake clock for the warm pool's idle timeout. */
  warmClock?: WarmClock;
  /** Tests replace the process starter. */
  claudeSpawn?: ClaudeSpawn;
  /** Tests replace the shell probe that finds the CLI executables. */
  probe?: ExecutableProbe;
  /** Obsidian's FileSystemAdapter.readLocalFile, for Codex images saved to disk. */
  readLocalFile?: ReadLocalFile;
  /** The plugin folder the runtimes start in; read when a call runs. Needed only by `runtimeFor`. */
  pluginDirectory?: () => string;
}

export class AiRuntimeService {
  private codexRuntime: CodexAppServerRuntime | null = null;
  private localCodexRuntime: CodexAppServerRuntime | null = null;
  /** One Claude runtime per executable and folder, so what it learns about the CLI (stream options) is remembered. */
  private claudeRuntime: { key: string; runtime: ClaudeCodeCliRuntime } | null = null;

  /** One idle Claude process at most, started when the research dialog opens (see ClaudeWarmPool). */
  private readonly warmPool: ClaudeWarmPool<ClaudeProcess>;

  private get probe(): ExecutableProbe {
    return this.options.probe ?? shellExecutableProbe;
  }

  constructor(private readonly options: AiRuntimeServiceOptions) {
    this.warmPool = new ClaudeWarmPool({ clock: options.warmClock });
  }

  /** Kills the pre-started Claude process, if any (unused dialog, Stop). */
  releaseWarm(): void {
    this.warmPool.release();
  }

  /** True while a pre-started Claude process is waiting. */
  hasWarm(): boolean {
    return this.warmPool.size > 0;
  }

  /** Plugin unload: kills the pre-started process and refuses any later pre-start. */
  dispose(): void {
    this.warmPool.dispose();
    this.reset();
  }

  reset(): void {
    this.warmPool.release();
    this.codexRuntime?.stop();
    this.localCodexRuntime?.stop();
    this.codexRuntime = null;
    this.localCodexRuntime = null;
    this.claudeRuntime = null;
  }

  diagnostic(configured: string): { executable: string; installed: boolean } {
    const executable = this.resolveExecutable(configured);
    // Without a working probe nothing can be judged missing: report installed and let the spawn report its own error.
    if (this.probe.available && !this.probe.available()) return { executable, installed: true };
    return { executable, installed: this.probe.firstExisting([executable]) !== null };
  }

  codex(pluginDirectory: string, local = false): CodexAppServerRuntime {
    if (local && this.localCodexRuntime) return this.localCodexRuntime;
    if (!local && this.codexRuntime) return this.codexRuntime;
    const executable = this.resolveExecutable(this.options.codexPath());
    const runtime = new CodexAppServerRuntime({
      executable,
      cwd: pluginDirectory,
      env: this.cliEnvironment(executable),
      clientVersion: this.options.clientVersion(),
      webSearchDisabled: local,
      ...(this.options.readLocalFile ? { readLocalFile: this.options.readLocalFile } : {}),
      onLog: (level, message) => this.options.onLog(level, message)
    });
    if (local) this.localCodexRuntime = runtime;
    else this.codexRuntime = runtime;
    return runtime;
  }

  claude(pluginDirectory: string): ClaudeCodeCliRuntime {
    const executable = this.resolveExecutable(this.options.claudePath());
    const key = `${executable}\0${pluginDirectory}`;
    if (this.claudeRuntime?.key === key) return this.claudeRuntime.runtime;
    const runtime = new ClaudeCodeCliRuntime({
      executable,
      cwd: pluginDirectory,
      env: this.cliEnvironment(executable),
      warmPool: this.warmPool,
      ...(this.options.claudeSpawn ? { spawn: this.options.claudeSpawn } : {}),
      onLog: (level, message) => this.options.onLog(level, message)
    });
    this.claudeRuntime = { key, runtime };
    return runtime;
  }

  /** The runtime that serves `model`, started lazily in the plugin folder when a call runs. */
  runtimeFor(model: string): AiRuntime {
    const directory = (): string => {
      const read = this.options.pluginDirectory;
      if (!read) throw new Error("AiRuntimeService needs a pluginDirectory option for runtimeFor");
      return read();
    };
    return aiRuntimeForModel(model, {
      claude: () => this.claude(directory()),
      codex: local => this.codex(directory(), local)
    });
  }

  resolveExecutable(configured: string): string {
    const environment = currentProcessEnvironment();
    const home = environment.HOME || "";
    // nvm is optional: a missing directory lists as nothing.
    const nvmVersions =
      home && !/[/\\]/.test(configured) ? this.probe.listDirectory(join(home, ".nvm/versions/node")) : [];
    return (
      this.probe.firstExisting(executableCandidates(configured, home, environment.PATH || "", nvmVersions)) ||
      configured
    );
  }

  cliEnvironment(executable: string): ProcessEnvironment {
    const environment = currentProcessEnvironment();
    const home = environment.HOME || "";
    const paths = [
      isAbsolute(executable) ? dirname(executable) : "",
      home ? join(home, ".local/bin") : "",
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      ...(environment.PATH || "").split(delimiter)
    ].filter(Boolean);
    return { ...environment, PATH: [...new Set(paths)].join(delimiter) };
  }
}
