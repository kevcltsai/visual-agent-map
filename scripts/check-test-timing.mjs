// Fails when a test asserts a timing variable against a numeric constant (absolute milliseconds).
// Machines differ in speed; compare against a baseline measured in the same run instead.
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const testsDir = path.join(root, "tests");
const exts = new Set([".cjs", ".js", ".mjs", ".ts"]);
const timingName = "[A-Za-z_$][\\w$]*(?:ms|Ms|MS|elapsed|Elapsed|duration|Duration)[\\w$]*|(?:ms|elapsed|duration)[\\w$]*";
const bad = new RegExp(`\\bassert(?:\\.\\w+)?\\s*\\(.*(?<![.\\w$])(?:${timingName})\\s*<=?\\s*\\d`);

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (exts.has(path.extname(entry.name))) yield full;
  }
}

const hits = [];
for (const file of walk(testsDir)) {
  fs.readFileSync(file, "utf8").split("\n").forEach((line, i) => {
    if (bad.test(line)) hits.push(`${path.relative(root, file)}:${i + 1}: ${line.trim()}`);
  });
}
if (hits.length) {
  process.stderr.write("Absolute timing limits in tests (compare against a baseline measured in the same run instead):\n");
  for (const h of hits) process.stderr.write(`  ${h}\n`);
  process.exit(1);
}
process.stdout.write("check-test-timing: ok\n");
