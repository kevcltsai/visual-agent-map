import { existsSync, readFileSync } from "node:fs";

const required = ["main.js", "manifest.json", "styles.css", "response-schema.json"];
for (const path of required) if (!existsSync(path)) throw new Error(`Missing release artifact: ${path}`);

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
if (manifest.version !== packageJson.version) throw new Error("package.json and manifest.json versions must match.");
if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error("manifest.json version must use x.y.z SemVer.");

for (const path of ["visual-agent-map/main.js", "visual-agent-map/manifest.json", "visual-agent-map/styles.css", "visual-agent-map/response-schema.json"]) {
  if (existsSync(path)) throw new Error(`Stale duplicate release artifact: ${path}`);
}

if (existsSync("dist")) for (const path of required) {
  const distPath = `dist/${path}`;
  if (existsSync(distPath) && readFileSync(path).compare(readFileSync(distPath)) !== 0) throw new Error(`dist artifact differs from ${path}.`);
}
