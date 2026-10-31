// Runs the unit layer: tests/run.cjs --layer=unit as parallel shards, plus one `node --test` process for the standalone test files, all at the same time.
// Output of each part is printed whole when it ends, so logs do not interleave; the failed parts are listed at the end. VAM_TEST_SHARDS sets the shard count (default 4).
// scripts/check-test-wiring.mjs reads `nodeTestFiles` and `parts`, so a test file under tests/ must be listed here (or be run by run.cjs, or by test-integration.mjs).
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const shards = Math.max(1, Number(process.env.VAM_TEST_SHARDS) || 4);
// Files run by one `node --test` process; `*` in the file name is a glob (expanded below, since no shell runs it).
export const nodeTestFiles = [
  "tests/compliance-gates.mjs",
  "tests/css-support.mjs",
  "tests/changelog-section.mjs",
  "tests/prompt-snapshots.cjs",
  "tests/replay.cjs",
  "tests/markdown-selection-auto-open.cjs",
  "tests/step-runner.cjs",
  "tests/relevance-offline.cjs",
  "tests/steps-*.cjs",
  "tests/aim-*.cjs",
  "tests/codex-parallel-runtime.cjs",
  "tests/prompt-monitor-timing.cjs",
  "tests/coffee-customization-storage.cjs",
];
export const parts = [
  ...Array.from({ length: shards }, (_, i) => ({ name: `run.cjs shard ${i + 1}/${shards}`, args: ["tests/run.cjs", "--layer=unit", `--shard=${i + 1}/${shards}`] })),
  { name: "node --test files", args: ["--test", ...nodeTestFiles] },
];

// Replaces a glob word such as tests/steps-*.cjs with the sorted matching files; a glob that matches nothing is an error, as a typo must not drop tests.
const expand = word => {
  if (!word.includes("*")) return [word];
  const slash = word.lastIndexOf("/");
  const dir = word.slice(0, slash);
  const pattern = new RegExp(`^${word.slice(slash + 1).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`);
  const found = readdirSync(`${root}${dir}`).filter(name => pattern.test(name)).sort().map(name => `${dir}/${name}`);
  if (!found.length) throw new Error(`test-unit: ${word} matches no file`);
  return found;
};
const runnable = list => list.map(part => (part.args[0] === "--test" ? { ...part, args: ["--test", ...part.args.slice(1).flatMap(expand)] } : part));

async function main() {
  // Imported here so that importing this file (the wiring check does) does not load the runner.
  const { runParts } = await import("./test-integration.mjs");
  const failed = await runParts(runnable(parts));
  if (failed.length) {
    process.stdout.write(`\ntest:unit FAILED in: ${failed.join(", ")}\n`);
    process.exit(1);
  }
  process.stdout.write("\ntest:unit: every part passed.\n");
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
