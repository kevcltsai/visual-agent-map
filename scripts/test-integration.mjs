// Runs the integration layer as parallel shards of tests/run.cjs plus tests/test-vault.mjs, then fails if any part failed.
// A passing part prints one summary line, a failing part its whole output (VAM_TEST_VERBOSE=1: every part whole), so logs do not interleave. VAM_TEST_SHARDS sets the shard count (default 3).
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const shards = Math.max(1, Number(process.env.VAM_TEST_SHARDS) || 3);
export const parts = [
  ...Array.from({ length: shards }, (_, i) => ({ name: `run.cjs shard ${i + 1}/${shards}`, args: ["tests/run.cjs", "--layer=integration", `--shard=${i + 1}/${shards}`] })),
  { name: "test-vault.mjs", args: ["--test", "tests/test-vault.mjs"] },
];

const run = part => new Promise(resolve => {
  const startedAt = Date.now();
  const child = spawn(process.execPath, part.args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  const chunks = [];
  child.stdout.on("data", chunk => chunks.push(chunk));
  child.stderr.on("data", chunk => chunks.push(chunk));
  child.on("close", code => resolve({ ...part, code, durationMs: Date.now() - startedAt, output: Buffer.concat(chunks).toString("utf8") }));
  child.on("error", error => resolve({ ...part, code: 1, durationMs: Date.now() - startedAt, output: String(error) }));
});

// Reads the totals node:test prints at the end of a part ("# tests 12", "# pass 12", "# fail 0").
const total = (output, key) => output.match(new RegExp(`^(?:# |ℹ )${key} (\\d+)`, "m"))?.[1] ?? "?";

// Runs every part at once and returns the names of the parts that exited non-zero.
// A passing part prints one summary line; a failing part prints its whole output; VAM_TEST_VERBOSE=1 prints every part whole.
export async function runParts(list) {
  const failed = [];
  const verbose = process.env.VAM_TEST_VERBOSE === "1";
  await Promise.all(list.map(part => run(part).then(result => {
    if (result.code === 0 && !verbose) {
      process.stdout.write(`${result.name}: tests ${total(result.output, "tests")}, pass ${total(result.output, "pass")}, fail ${total(result.output, "fail")}, ${(result.durationMs / 1000).toFixed(1)} s\n`);
    } else {
      process.stdout.write(`\n=== ${result.name} (exit ${result.code}) ===\n${result.output}`);
    }
    if (result.code !== 0) failed.push(result.name);
  })));
  return failed;
}

async function main() {
  process.exitCode = (await runParts(parts)).length ? 1 : 0; // not process.exit: it can cut off piped output
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
