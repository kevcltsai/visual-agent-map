// Prints the CHANGELOG.md body for one version (between `## [version]` and the next `## [` heading, heading excluded, leading blank lines trimmed).
// Used by .github/workflows/release.yml as the GitHub Release notes. Exits non-zero when the section is missing or empty.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function changelogSection(text, version) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex(line => line.startsWith(`## [${version}]`));
  if (start < 0) throw new Error(`CHANGELOG.md has no section for ${version}`);
  let end = lines.findIndex((line, i) => i > start && line.startsWith("## ["));
  if (end < 0) end = lines.length;
  const body = lines.slice(start + 1, end).join("\n").replace(/^\s*\n/, "").trimEnd();
  if (!body.trim()) throw new Error(`CHANGELOG.md section for ${version} is empty`);
  return body;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const version = process.argv[2];
  if (!version) { console.error("usage: changelog-section.mjs <version> [CHANGELOG.md]"); process.exit(2); }
  try {
    const file = process.argv[3] ?? fileURLToPath(new URL("../CHANGELOG.md", import.meta.url));
    process.stdout.write(`${changelogSection(readFileSync(file, "utf8"), version)}\n`);
  } catch (error) {
    console.error(`changelog-section: ${error.message}`);
    process.exit(1);
  }
}
