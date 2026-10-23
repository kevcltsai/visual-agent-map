// CSS lint for the stylesheets Obsidian's scan reads and the share viewer ships: no `!important`.
// (Obsidian's review rejects it; use higher specificity or a different source order instead.)
// Usage: node scripts/check-css.mjs   (run from `npm run lint`)
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FILES = ["styles.css", "experiences/sharing/viewer/viewer.css"];
let failures = 0;
for (const file of FILES) {
  const lines = readFileSync(path.join(root, file), "utf8").split("\n");
  let inComment = false;
  lines.forEach((line, index) => {
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
    if (/!\s*important/i.test(code)) {
      process.stderr.write(`${file}:${index + 1}: !important is not allowed (raise specificity or change order instead).` + "\n");
      failures++;
    }
  });
}
if (failures) process.exit(1);
process.stdout.write(`CSS lint: no !important in ${FILES.join(", ")}.` + "\n");
