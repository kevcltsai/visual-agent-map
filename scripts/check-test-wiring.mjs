// Fails when a test file directly under tests/ is run by no script that `npm run verify` calls.
// A file counts as run when a word of the `test:unit` command (package.json, comments ignored) or an argument in the `parts` that scripts/test-integration.mjs exports names it, directly or through a glob such as tests/steps-*.cjs.
// Suites under tests/suites are run by tests/run.cjs, which already asserts it lists every one. Helpers are the explicit allowlist below.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const defaultRoot = fileURLToPath(new URL("..", import.meta.url));
// Not tests: shared helpers and the entry point itself.
export const helpers = new Set(["run.cjs", "build.cjs", "aim-literal-scan.cjs"]);
const isHelper = name => helpers.has(name) || name.startsWith("support");

const toRegExp = pattern => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`);

// Words of a shell command up to the first comment; a word that starts with # begins a comment, so a commented-out file does not count as run.
const commandWords = command => {
  const words = command.split(/\s+/);
  const comment = words.findIndex(word => word.startsWith("#"));
  return comment === -1 ? words : words.slice(0, comment);
};

export async function findUnwired(root = defaultRoot) {
  const unit = commandWords(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts["test:unit"]);
  // The path is the repository root plus a fixed file name (tests pass a temporary root), never input.
  // eslint-disable-next-line no-unsanitized/method -- fixed repository path, not user input
  const { parts } = await import(pathToFileURL(join(root, "scripts/test-integration.mjs")).href);
  const words = [...unit, ...parts.flatMap(part => part.args)];
  const named = words.filter(word => /^tests\/[\w*.-]+\.(?:cjs|mjs)$/.test(word)).map(word => toRegExp(word.slice("tests/".length)));
  return readdirSync(join(root, "tests"))
    .filter(name => /\.(cjs|mjs)$/.test(name) && !isHelper(name))
    .filter(name => !named.some(pattern => pattern.test(name)))
    .sort();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const unwired = await findUnwired();
  if (unwired.length) {
    console.error(`Test files run by no verify script (wire them into test:unit or scripts/test-integration.mjs, or list a helper in scripts/check-test-wiring.mjs):\n${unwired.map(name => `  tests/${name}`).join("\n")}`);
    process.exit(1);
  }
  process.stdout.write("check-test-wiring: every test file under tests/ is run by verify.\n");
}
