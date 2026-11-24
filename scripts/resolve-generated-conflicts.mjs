import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildProduct } from "./build-product.mjs";
import { timedSync } from "./dev-metrics.mjs";
const root = fileURLToPath(new URL("..", import.meta.url));
const generated = new Set(["main.js", "experiences/sharing/viewer-bundle.generated.ts"]);
export function generatedConflictPlan(unmerged, unstaged, untracked) {
  const conflicts = [...new Set(unmerged)];
  if (!conflicts.length || conflicts.some(path => !generated.has(path))) throw new Error("Resolve every source conflict first; only generated conflicts may remain.");
  if ([...unstaged, ...untracked].some(path => !generated.has(path))) throw new Error("Stage the intended source resolutions and remove unrelated unstaged/untracked source changes first.");
  return conflicts;
}
export function resolveGenerated(directory = root) {
  const git = (...args) => execFileSync("git", args, { cwd: directory, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\0").filter(Boolean);
  generatedConflictPlan(git("diff", "--name-only", "--diff-filter=U", "-z"), git("diff", "--name-only", "-z"), git("ls-files", "--others", "--exclude-standard", "-z"));
  timedSync("generated-rebuild", () => buildProduct({ ...process.env, VAM_CLEAN_BUILD: "1" }));
  process.stdout.write("Generated outputs rebuilt from resolved sources. Review the diff, then explicitly stage the two generated files and continue the existing merge/rebase. No Git index entries were changed.\n");
}
if (process.argv[1] === fileURLToPath(import.meta.url)) resolveGenerated();
