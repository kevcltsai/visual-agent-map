// Fails when a test file directly under tests/ is run by no script that `npm run verify` calls.
// A file counts as run when `test:unit` (package.json) or scripts/test-integration.mjs names it, directly or through a glob such as tests/steps-*.cjs.
// Suites under tests/suites are run by tests/run.cjs, which already asserts it lists every one. Helpers are the explicit allowlist below.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const defaultRoot = fileURLToPath(new URL("..", import.meta.url));
// Not tests: shared helpers and the entry point itself.
export const helpers = new Set(["run.cjs", "build.cjs", "aim-literal-scan.cjs"]);
const isHelper = name => helpers.has(name) || name.startsWith("support");

const toRegExp = pattern => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`);

export function findUnwired(root = defaultRoot) {
  const sources = [JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts["test:unit"], readFileSync(join(root, "scripts/test-integration.mjs"), "utf8")];
  const named = sources.flatMap(text => text.match(/tests\/[\w*.-]+\.(?:cjs|mjs)/g) ?? []).map(entry => toRegExp(entry.slice("tests/".length)));
  return readdirSync(join(root, "tests"))
    .filter(name => /\.(cjs|mjs)$/.test(name) && !isHelper(name))
    .filter(name => !named.some(pattern => pattern.test(name)))
    .sort();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const unwired = findUnwired();
  if (unwired.length) {
    console.error(`Test files run by no verify script (wire them into test:unit or scripts/test-integration.mjs, or list a helper in scripts/check-test-wiring.mjs):\n${unwired.map(name => `  tests/${name}`).join("\n")}`);
    process.exit(1);
  }
  console.log("check-test-wiring: every test file under tests/ is run by verify.");
}
