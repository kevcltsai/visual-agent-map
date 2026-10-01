import { existsSync, readdirSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { CodexAppServerRuntime } from "../ai/runtime/codex-app-server";
import { ClaudeCodeCliRuntime } from "../ai/runtime/claude-code-cli";
import type { LogLevel } from "../log-manager";

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

export interface AiRuntimeServiceOptions {
  codexPath: () => string;
  claudePath: () => string;
  clientVersion: () => string;
  onLog: (level: LogLevel, message: string) => void;
}

export class AiRuntimeService {
  private codexRuntime: CodexAppServerRuntime | null = null;
  private localCodexRuntime: CodexAppServerRuntime | null = null;

  constructor(private readonly options: AiRuntimeServiceOptions) {}

  reset(): void {
    this.codexRuntime?.stop();
    this.localCodexRuntime?.stop();
    this.codexRuntime = null;
    this.localCodexRuntime = null;
  }

  diagnostic(configured: string): { executable: string; installed: boolean } {
    const executable = this.resolveExecutable(configured);
    return { executable, installed: existsSync(executable) };
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
      onLog: (level, message) => this.options.onLog(level, message)
    });
    if (local) this.localCodexRuntime = runtime;
    else this.codexRuntime = runtime;
    return runtime;
  }

  claude(pluginDirectory: string): ClaudeCodeCliRuntime {
    const executable = this.resolveExecutable(this.options.claudePath());
    return new ClaudeCodeCliRuntime({
      executable,
      cwd: pluginDirectory,
      env: this.cliEnvironment(executable),
      onLog: (level, message) => this.options.onLog(level, message)
    });
  }

  resolveExecutable(configured: string): string {
    const environment = currentProcessEnvironment();
    const home = environment.HOME || "";
    let nvmVersions: string[] = [];
    if (home) {
      try { nvmVersions = readdirSync(join(home, ".nvm/versions/node")); }
      catch { /* nvm is optional. */ }
    }
    return executableCandidates(configured, home, environment.PATH || "", nvmVersions)
      .find(candidate => existsSync(candidate)) || configured;
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
