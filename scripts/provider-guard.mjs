import { accessSync, chmodSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

// Stub-mode fail-closed guard (harness side only). A provider call that no stub caught runs one of these shims instead of the
// real claude / codex: it appends "<provider>\t<args>\t<cwd>" to calls.log, prints which provider and arguments were called, and
// exits 97. The Codex runtime and the Claude runtime both show a failing child's stderr as the error, so the call fails loudly.
export const guardExitCode = 97;

// `--live=<model>` or `--live=claude:<model>`: the one provider and model a harness vault may really call. Only claude can be let through; codex never.
export function parseLive(value) {
  const [provider, model] = value.includes(":") ? value.split(/:(.*)/s) : ["claude", value];
  if (provider !== "claude") throw new Error(`--live=${value}: only claude can be let through (provider "${provider}" stays blocked).`);
  if (!/^[A-Za-z0-9._-]+$/.test(model ?? "")) throw new Error(`--live=${value}: give a model such as sonnet (letters, digits, . _ - only).`);
  return { provider, model: model.toLowerCase() };
}

const guardFolder = join(".ob" + "sidian", "vam-provider-guard");

function findRealClaude(env = process.env) {
  const home = homedir();
  const dirs = [...(env.PATH || "").split(delimiter), join(home, ".local/bin"), join(home, ".npm-global/bin"), join(home, ".volta/bin"), "/opt/homebrew/bin", "/usr/local/bin"].filter(Boolean);
  for (const dir of dirs) { const file = join(dir, "claude"); try { accessSync(file, constants.X_OK); if (!dir.endsWith(guardFolder)) return file; } catch { /* next */ } }
  throw new Error("--live: no real claude executable found on PATH or in the usual install folders.");
}

const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

// Which product path a call came from, read off the arguments the runtime passes (ai/runtime/codex-app-server.ts, claude-code-cli.ts).
const pathHint = {
  codex: `case " $* " in
  *web_search*) path="local Codex runtime (AiRuntimeService.codex(dir, true): web search disabled)" ;;
  *) path="Codex app-server runtime (AiRuntimeService.codex(dir, false): listModels or runTask)" ;;
esac`,
  claude: `path="Claude Code CLI runtime (AiRuntimeService.claude(dir): runTask or prewarm)"`
};

export function installProviderGuard(configDir, { live = null, env = process.env } = {}) {
  const real = live ? findRealClaude(env) : null;
  const directory = join(configDir, "vam-provider-guard");
  mkdirSync(directory, { recursive: true });
  const log = join(directory, "calls.log");
  const paths = {};
  for (const provider of ["claude", "codex"]) {
    const shim = join(directory, provider);
    const allow = provider === "claude" && live ? `model=""; prev=""
for a in "$@"; do [ "$prev" = "--model" ] && model="$a"; prev="$a"; done
lower=$(printf '%s' "$model" | tr 'A-Z' 'a-z')
case "$lower" in *${live.model}*) printf 'claude\\t%s\\t%s\\n' "$*" "$PWD" >> ${quote(join(directory, "live.log"))}; exec ${quote(real)} "$@" ;; esac
` : "";
    writeFileSync(shim, `#!/bin/sh
${allow}${pathHint[provider]}
printf '%s\\t%s\\t%s\\n' ${quote(provider)} "$*" "$PWD" >> ${quote(log)}
echo "VAM stub mode (fail closed): provider=${provider} was called without a stub${live && provider === "claude" ? ` (only claude model ${live.model} is let through by --live)` : ""}; blocked, nothing was spawned. path: $path. args: $*. cwd: $PWD" >&2
exit ${guardExitCode}
`);
    chmodSync(shim, 0o755);
    paths[`${provider}Path`] = shim;
  }
  return { ...paths, log };
}

// Puts the guard into an existing harness vault (a session vault updated in place): shims rewritten, data.json paths pointed at them.
export function applyProviderGuard(vault, live = null, env = process.env) {
  const config = join(vault, ".ob" + "sidian");
  const guard = installProviderGuard(config, { live, env });
  const file = join(config, "plugins/visual-agent-map/data.json");
  const saved = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  writeFileSync(file, JSON.stringify({ ...saved, codexPath: guard.codexPath, claudePath: guard.claudePath }, null, 2));
  return guard;
}
