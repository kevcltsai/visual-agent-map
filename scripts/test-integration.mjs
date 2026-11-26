// Runs the integration layer as parallel shards of tests/run.cjs plus tests/test-vault.mjs, then fails if any part failed.
// A passing part prints one summary line, a failing part its whole output (VAM_TEST_VERBOSE=1: every part whole), so logs do not interleave. VAM_TEST_SHARDS sets the shard count (default 3).
import { spawn } from "node:child_process";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { recordDevEvent } from "./dev-metrics.mjs";

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

// CI only: VAM_CI_SHARD=i/n makes one runner run its share of the parts (scripts/ci-shard-gate.mjs checks the shares add up to the whole). Unset: nothing changes.
// A whole part (tests/run.cjs shard, test-vault.mjs) goes to runner ((position - 1) mod n) + 1; with splitFiles, the files of the `node --test` part are
// spread over the runners instead: biggest file first (ties by path) onto the runner with the least bytes (ties: lowest number), so the result is deterministic.
export function parseShard(value = process.env.VAM_CI_SHARD) {
  if (!value) return null;
  const match = /^(\d+)\/(\d+)$/.exec(value);
  const index = Number(match?.[1]), count = Number(match?.[2]);
  if (!match || index < 1 || index > count) throw new Error(`bad VAM_CI_SHARD=${value}`);
  return { index, count };
}
export function splitFiles(files, count, sizeOf) {
  const loads = Array.from({ length: count }, () => ({ bytes: 0, files: [] }));
  const sized = files.map(file => ({ file, size: sizeOf(file) })).sort((a, b) => b.size - a.size || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  for (const { file, size } of sized) {
    const lightest = loads.reduce((a, b) => (b.bytes < a.bytes ? b : a));
    lightest.bytes += size; lightest.files.push(file);
  }
  return loads.map(load => load.files);
}
// `reverse` deals whole parts from the last shard down: integration does this so its heaviest part (run.cjs 1/3, map-chat) does not land on shard 1, which already has the slowest unit load.
export function shardParts(list, shard, { splitNodeTest = false, reverse = false, sizeOf = file => statSync(`${root}${file}`).size } = {}) {
  if (!shard) return list;
  const { index, count } = shard;
  let position = 0;
  return list.flatMap(part => {
    if (splitNodeTest && part.args[0] === "--test") {
      const files = splitFiles(part.args.slice(1), count, sizeOf)[index - 1];
      return files.length ? [{ ...part, args: ["--test", ...files] }] : [];
    }
    position += 1;
    const target = (position - 1) % count + 1;
    return (reverse ? count + 1 - target : target) === index ? [part] : [];
  });
}
// What a part runs, as the names the gate counts: a `node --test` part lists its files, a tests/run.cjs part is one unit.
export const unitsOf = part => (part.args[0] === "--test" ? part.args.slice(1) : [part.args.map(arg => arg.replace(/^tests\//, "")).join(" ")]);
// With VAM_CI_REPORT_DIR set, every finished part leaves one JSON record there for the gate.
function writeReport(result, layer, shard) {
  const dir = process.env.VAM_CI_REPORT_DIR;
  if (!dir) return;
  const num = key => { const value = total(result.output, key); return value === "?" ? null : Number(value); };
  mkdirSync(dir, { recursive: true });
  const slug = `${layer}-${shard ? `${shard.index}of${shard.count}-` : ""}${result.name}`.replace(/[^\w.-]+/g, "_");
  writeFileSync(join(dir, `${slug}.json`), JSON.stringify({ layer, shard: shard ? `${shard.index}/${shard.count}` : null, part: result.name, units: unitsOf(result), tests: num("tests"), pass: num("pass"), fail: num("fail"), code: result.code }));
}

// With VAM_AFFECTED_TESTS (set by scripts/test-affected.mjs), a `node --test` part keeps only the listed files and is dropped when none is left.
// A tests/run.cjs part is only needed when at least one suite is selected; run.cjs filters its own shards.
export function applyAffected(list, env = process.env) {
  if (!env.VAM_AFFECTED_TESTS) return list;
  const affected = new Set(env.VAM_AFFECTED_TESTS.split(","));
  return list.flatMap(part => {
    if (part.args[0] !== "--test") {
      if (part.args[0] === "tests/run.cjs" && ![...affected].some(file => file.startsWith("tests/suites/"))) return [];
      return [part];
    }
    const files = part.args.slice(1).filter(file => affected.has(file));
    return files.length ? [{ ...part, args: ["--test", ...files] }] : [];
  });
}

// Runs every part at once and returns the names of the parts that exited non-zero.
// A passing part prints one summary line; a failing part prints its whole output; VAM_TEST_VERBOSE=1 prints every part whole.
export async function runParts(list, layer = "integration", shard = parseShard()) {
  const failed = [];
  const verbose = process.env.VAM_TEST_VERBOSE === "1";
  await Promise.all(applyAffected(list).map(part => run(part).then(result => {
    if (result.code === 0 && !verbose) {
      process.stdout.write(`${result.name}: tests ${total(result.output, "tests")}, pass ${total(result.output, "pass")}, fail ${total(result.output, "fail")}, ${(result.durationMs / 1000).toFixed(1)} s\n`);
    } else {
      process.stdout.write(`\n=== ${result.name} (exit ${result.code}) ===\n${result.output}`);
    }
    writeReport(result, layer, shard);
    if (result.code !== 0) failed.push(result.name);
  })));
  return failed;
}

async function main() {
  const { enterHeavy } = await import("./heavy-lock.mjs");
  await enterHeavy("npm run test:integration");
  const started = performance.now();
  const failed = await runParts(shardParts(parts, parseShard(), { reverse: true }));
  recordDevEvent("test-integration", performance.now() - started, failed.length ? "error" : "ok");
  process.exitCode = failed.length ? 1 : 0; // not process.exit: it can cut off piped output
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
