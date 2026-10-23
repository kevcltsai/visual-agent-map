// CSS lint for the stylesheets Obsidian's scan reads and the share viewer ships:
//  1. no `!important` (Obsidian's review rejects it; use higher specificity or a different source order instead).
//  2. no browser feature the review's CSS LINT flags: 'Unexpected browser feature "X" is only partially
//     supported by Obsidian 1.11.4'. That message is doiuse's (the engine behind
//     stylelint-no-unsupported-browser-features); the feature ids and line numbers of the 0.22.0
//     (`text-decoration`, styles.css:1069) and 0.23.0 (`css-clip-path`, styles.css:146) scan warnings reproduce
//     exactly with doiuse + caniuse-lite at Chrome 142 (Electron 39, Obsidian 1.11.x). Partial support counts.
// Usage: node scripts/check-css.mjs   (run from `npm run lint`)
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import doiuse from "doiuse";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const FILES = ["styles.css", "experiences/sharing/viewer/viewer.css"];
export const BROWSERS = ["chrome 142"];

export function findImportant(css) {
  const found = [];
  let inComment = false;
  css.split("\n").forEach((line, index) => {
    let code = "";
    for (let i = 0; i < line.length; i++) {
      if (inComment) {
        if (line.startsWith("*/", i)) {
          inComment = false;
          i++;
        }
      } else if (line.startsWith("/*", i)) {
        inComment = true;
        i++;
      } else code += line[i];
    }
    if (/!\s*important/i.test(code)) found.push({ line: index + 1, message: "!important is not allowed (raise specificity or change order instead)." });
  });
  return found;
}

export async function findUnsupported(css, file = "input.css") {
  const found = [];
  await postcss([
    doiuse({
      browsers: BROWSERS,
      onFeatureUsage(usage) {
        found.push({
          line: usage.usage.source.start.line,
          message: `Unexpected browser feature "${usage.feature}" is not fully supported by Obsidian's scan target (${BROWSERS.join(", ")}): ${usage.featureData.title}.`,
        });
      },
    }),
  ]).process(css, { from: file });
  return found;
}

export async function checkCss(css, file) {
  return [...findImportant(css), ...(await findUnsupported(css, file))].sort((a, b) => a.line - b.line);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let failures = 0;
  for (const file of FILES) {
    for (const f of await checkCss(readFileSync(path.join(root, file), "utf8"), file)) {
      process.stderr.write(`${file}:${f.line}: ${f.message}\n`);
      failures++;
    }
  }
  if (failures) process.exit(1);
  process.stdout.write(`CSS lint: no !important or partially supported browser feature (${BROWSERS.join(", ")}) in ${FILES.join(", ")}.\n`);
}
