// Fails when a .github/workflows/*.yml file does not parse as YAML (for example an unquoted `run-name: a: b`), which GitHub reports only after the push.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const defaultRoot = fileURLToPath(new URL("..", import.meta.url));

// Returns { checked, missing, errors }; errors is a list of "<file>: <message>". A missing .github/workflows directory is not an error.
export function checkWorkflows(root = defaultRoot) {
  const dir = join(root, ".github", "workflows");
  if (!existsSync(dir)) return { checked: 0, missing: true, errors: [] };
  const errors = [];
  const files = readdirSync(dir).filter(name => /\.ya?ml$/.test(name)).sort();
  for (const name of files) {
    try {
      const parsed = parse(readFileSync(join(dir, name), "utf8"));
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) errors.push(`${name}: not a YAML mapping`);
    } catch (error) {
      errors.push(`${name}: ${error.message}`);
    }
  }
  return { checked: files.length, missing: false, errors };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { checked, missing, errors } = checkWorkflows();
  if (errors.length) {
    console.error(`Workflow files that do not parse as YAML (quote values that contain ": "):\n${errors.map(line => `  ${line}`).join("\n")}`);
    process.exit(1);
  }
  process.stdout.write(missing ? "check-workflows: no .github/workflows directory, nothing to check.\n" : `check-workflows: ${checked} workflow file(s) parse as YAML.\n`);
}
