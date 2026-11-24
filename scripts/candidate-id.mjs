// One exact source identity for local verification evidence and the existing vault harness.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("..", import.meta.url));
const hash = data => createHash("sha256").update(data).digest("hex");
export function sourceFingerprint(directory = root) {
  const git = (...args) => execFileSync("git", args, { cwd: directory, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const generated = new Set(["main.js", "experiences/sharing/viewer-bundle.generated.ts"]);
  const files = [...new Set(git("ls-files", "--cached", "--others", "--exclude-standard", "-z").split("\0").filter(name => name && !generated.has(name)))].sort();
  return hash(JSON.stringify({ commit: git("rev-parse", "HEAD").trim(), branch: git("branch", "--show-current").trim(), files: files.map(name => [name, existsSync(join(directory, name)) ? hash(readFileSync(join(directory, name))) : null]) }));
}


export function candidateEvidence(directory = root, env = process.env) {
  try {
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: directory, encoding: "utf8" }).trim();
    const deps = env.VAM_TEST_DEPS_FILE || join(directory, "test-deps.json");
    const outputs = ["main.js", "experiences/sharing/viewer-bundle.generated.ts", "manifest.json", "styles.css"];
    const identity = {
      commit, source: sourceFingerprint(directory),
      artifacts: outputs.map(name => hash(readFileSync(join(directory, name)))),
      deps: existsSync(deps) ? hash(readFileSync(deps)) : null,
      platform: process.platform, arch: process.arch, node: process.version
    };
    return { commit, fingerprint: hash(JSON.stringify(identity)) };
  } catch { return null; }
}
