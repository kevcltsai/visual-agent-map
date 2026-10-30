// Runs the integration layer as parallel shards of tests/run.cjs plus tests/test-vault.mjs, then fails if any part failed.
// Output of each part is printed whole when it ends, so logs do not interleave. VAM_TEST_SHARDS sets the shard count (default 3).
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const shards = Math.max(1, Number(process.env.VAM_TEST_SHARDS) || 3);
export const parts = [
  ...Array.from({ length: shards }, (_, i) => ({ name: `run.cjs shard ${i + 1}/${shards}`, args: ["tests/run.cjs", "--layer=integration", `--shard=${i + 1}/${shards}`] })),
  { name: "test-vault.mjs", args: ["--test", "tests/test-vault.mjs"] },
];

const run = part => new Promise(resolve => {
  const child = spawn(process.execPath, part.args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  const chunks = [];
  child.stdout.on("data", chunk => chunks.push(chunk));
  child.stderr.on("data", chunk => chunks.push(chunk));
  child.on("close", code => resolve({ ...part, code, output: Buffer.concat(chunks).toString("utf8") }));
  child.on("error", error => resolve({ ...part, code: 1, output: String(error) }));
});

// Runs every part at once, prints each part's whole output when it ends, and returns the names of the parts that exited non-zero.
export async function runParts(list) {
  const failed = [];
  await Promise.all(list.map(part => run(part).then(result => {
    process.stdout.write(`\n=== ${result.name} (exit ${result.code}) ===\n${result.output}`);
    if (result.code !== 0) failed.push(result.name);
  })));
  return failed;
}

async function main() {
  process.exit((await runParts(parts)).length ? 1 : 0);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
