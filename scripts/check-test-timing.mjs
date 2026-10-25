// Fails when a test asserts a timing value against a fixed number or constant (absolute milliseconds).
// Machines differ in speed; compare against a baseline measured in the same run instead.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const exts = new Set([".cjs", ".js", ".mjs", ".ts"]);
// Lines that look like a timing limit but are not a measurement. Matched by file and exact text, not by line number.
const ALLOWED = [
  // A fake timer's configured delay, not an elapsed time.
  { file: "tests/suites/expansion-and-synthesis.cjs", text: "assert.equal(timers[0].ms <= 200, true);" },
];

// A timing name is `ms`, a name ending in `Ms`, `MS` or `_ms`, or a name containing elapsed or duration. `terms`, `numItems` and `msgCount` are not.
export function isTimingName(name) {
  return name === "ms" || /(?:Ms|MS|_ms)$/.test(name) || /elapsed|duration/i.test(name);
}
const lastSegment = (operand) => operand.replace(/\[[^\]]*\]/g, "").split(".").pop();
const isLimit = (operand) => /^\d[\d_]*(?:\.\d+)?$/.test(operand) || /^[A-Z][A-Z0-9_]*$/.test(lastSegment(operand));
const COMPARE = /([\w$.[\]]+)\s*(?<![=!<>-])(<=?|>=?)\s*([\w$.[\]]+)/g;

// An elapsed time written inline: a subtraction involving a clock read, compared with a number or an all-caps constant, in either order.
const CLOCK = String.raw`(?:Date\.now\(\)|performance\.now\(\)|(?:process\.)?hrtime(?:\.bigint)?\(\))`;
const LIMIT = String.raw`(?:\d[\d_]*(?:\.\d+)?|[A-Z][A-Z0-9_]*)(?![\w$.(\[])`;
const OP = String.raw`(?<![=!<>-])(?:<=?|>=?)`;
const CLOCK_LEFT = new RegExp(String.raw`(?=[^<>;]*${CLOCK})[^<>;]*-[^<>;]*${OP}\s*${LIMIT}`);
const CLOCK_RIGHT = new RegExp(String.raw`${LIMIT}\s*${OP}\s*(?=[^<>;]*${CLOCK})[^<>;]*-`);

/** True when the line is an assert call comparing a timing value with a number or an all-caps constant. */
export function isAbsoluteTimingLine(line) {
  if (!/\bassert(?:\.\w+)?\s*\(/.test(line)) return false;
  if (CLOCK_LEFT.test(line) || CLOCK_RIGHT.test(line)) return true;
  for (const match of line.matchAll(COMPARE)) {
    const [, left, , right] = match;
    if ((isTimingName(lastSegment(left)) && isLimit(right)) || (isTimingName(lastSegment(right)) && isLimit(left))) return true;
  }
  return false;
}

export function findAbsoluteTiming(text, file = "") {
  const hits = [];
  text.split("\n").forEach((line, index) => {
    if (!isAbsoluteTimingLine(line)) return;
    if (ALLOWED.some((entry) => entry.file === file && line.trim() === entry.text)) return;
    hits.push({ line: index + 1, text: line.trim() });
  });
  return hits;
}

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (exts.has(path.extname(entry.name))) yield full;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const lines = [];
  for (const file of walk(path.join(root, "tests"))) {
    const rel = path.relative(root, file).split(path.sep).join("/");
    for (const hit of findAbsoluteTiming(fs.readFileSync(file, "utf8"), rel)) lines.push(`  ${rel}:${hit.line}: ${hit.text}`);
  }
  if (lines.length) {
    process.stderr.write("Absolute timing limits in tests (compare against a baseline measured in the same run instead):\n" + lines.join("\n") + "\n");
    process.exit(1);
  }
  process.stdout.write("check-test-timing: ok\n");
}
