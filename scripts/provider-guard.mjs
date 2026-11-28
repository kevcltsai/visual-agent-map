import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Stub-mode fail-closed guard (harness side only). A provider call that no stub caught runs one of these shims instead of the
// real claude / codex: it appends "<provider>\t<args>\t<cwd>" to calls.log, prints which provider and arguments were called, and
// exits 97. The Codex runtime and the Claude runtime both show a failing child's stderr as the error, so the call fails loudly.
export const guardExitCode = 97;
export const stubProvidersEnabled = () => process.env.VAM_STUB_PROVIDERS === "1";

const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

// Which product path a call came from, read off the arguments the runtime passes (ai/runtime/codex-app-server.ts, claude-code-cli.ts).
const pathHint = {
  codex: `case " $* " in
  *web_search*) path="local Codex runtime (AiRuntimeService.codex(dir, true): web search disabled)" ;;
  *) path="Codex app-server runtime (AiRuntimeService.codex(dir, false): listModels or runTask)" ;;
esac`,
  claude: `path="Claude Code CLI runtime (AiRuntimeService.claude(dir): runTask or prewarm)"`
};

export function installProviderGuard(configDir) {
  const directory = join(configDir, "vam-provider-guard");
  mkdirSync(directory, { recursive: true });
  const log = join(directory, "calls.log");
  const paths = {};
  for (const provider of ["claude", "codex"]) {
    const shim = join(directory, provider);
    writeFileSync(shim, `#!/bin/sh
${pathHint[provider]}
printf '%s\\t%s\\t%s\\n' ${quote(provider)} "$*" "$PWD" >> ${quote(log)}
echo "VAM stub mode (fail closed): provider=${provider} was called without a stub; blocked, nothing was spawned. path: $path. args: $*. cwd: $PWD" >&2
exit ${guardExitCode}
`);
    chmodSync(shim, 0o755);
    paths[`${provider}Path`] = shim;
  }
  return { ...paths, log };
}
