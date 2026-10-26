// Runs the integration layer as parallel shards of tests/run.cjs plus tests/test-vault.mjs, then fails if any part failed.
// Output of each part is printed whole when it ends, so logs do not interleave. VAM_TEST_SHARDS sets the shard count (default 3).
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const shards = Math.max(1, Number(process.env.VAM_TEST_SHARDS) || 3);
const parts = [
  ...Array.from({ length: shards }, (_, i) => ({ name: `run.cjs shard ${i + 1}/${shards}`, args: ["tests/run.cjs", "--layer=integration", `--shard=${i + 1}/${shards}`] })),
  { name: "test-vault.mjs", args: ["--test", "tests/test-vault.mjs"] },
];

const run = part => new Promise(resolve => {
  const child = spawn(process.execPath, part.args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  child.on("close", code => resolve({ ...part, code, output }));
  child.on("error", error => resolve({ ...part, code: 1, output: String(error) }));
});

let failed = false;
await Promise.all(parts.map(part => run(part).then(result => {
  process.stdout.write(`\n=== ${result.name} (exit ${result.code}) ===\n${result.output}`);
  if (result.code !== 0) failed = true;
})));
process.exit(failed ? 1 : 0);
