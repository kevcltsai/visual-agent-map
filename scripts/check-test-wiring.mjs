// Fails when a test file directly under tests/ is run by no script that `npm run verify` calls.
// A file counts as run when an argument in the `parts` that scripts/test-unit.mjs or scripts/test-integration.mjs exports names it, directly or through a glob such as tests/steps-*.cjs.
// Suites under tests/suites are run by tests/run.cjs, which already asserts it lists every one. Helpers are the explicit allowlist below.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const defaultRoot = fileURLToPath(new URL("..", import.meta.url));
// Not tests: shared helpers and the entry point itself.
export const helpers = new Set(["run.cjs", "build.cjs", "aim-literal-scan.cjs"]);
const isHelper = name => helpers.has(name) || name.startsWith("support");

const toRegExp = pattern => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`);

export async function findUnwired(root = defaultRoot) {
  // The paths are the repository root plus fixed file names (tests pass a temporary root), never input.
  const load = async file => {
    // eslint-disable-next-line no-unsanitized/method -- fixed repository path, not user input
    const { parts } = await import(pathToFileURL(join(root, file)).href);
    return parts.flatMap(part => part.args);
  };
  const words = [...(await load("scripts/test-unit.mjs")), ...(await load("scripts/test-integration.mjs"))];
  const named = words.filter(word => /^tests\/[\w*.-]+\.(?:cjs|mjs)$/.test(word)).map(word => toRegExp(word.slice("tests/".length)));
  return readdirSync(join(root, "tests"))
    .filter(name => /\.(cjs|mjs)$/.test(name) && !isHelper(name))
    .filter(name => !named.some(pattern => pattern.test(name)))
    .sort();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const unwired = await findUnwired();
  if (unwired.length) {
    console.error(`Test files run by no verify script (wire them into scripts/test-unit.mjs or scripts/test-integration.mjs, or list a helper in scripts/check-test-wiring.mjs):\n${unwired.map(name => `  tests/${name}`).join("\n")}`);
    process.exit(1);
  }
  process.stdout.write("check-test-wiring: every test file under tests/ is run by verify.\n");
}
