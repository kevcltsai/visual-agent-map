import { existsSync, readFileSync } from "node:fs";

const required = ["main.js", "manifest.json", "styles.css"];
for (const path of required) if (!existsSync(path)) throw new Error(`Missing release artifact: ${path}`);
if (!existsSync("response-schema.json")) throw new Error("Missing response-schema.json source.");
if (!readFileSync("main.js", "utf8").includes("https://json-schema.org/draft/2020-12/schema")) throw new Error("main.js does not contain the embedded response schema.");

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const packageLock = JSON.parse(readFileSync("package-lock.json", "utf8"));
const versions = JSON.parse(readFileSync("versions.json", "utf8"));
if (manifest.version !== packageJson.version) throw new Error("package.json and manifest.json versions must match.");
if (packageLock.version !== manifest.version || packageLock.packages?.[""]?.version !== manifest.version) throw new Error("package-lock.json and manifest.json versions must match.");
if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error("manifest.json version must use x.y.z SemVer.");
if (versions[manifest.version] !== manifest.minAppVersion) throw new Error("versions.json must map the current release to manifest.minAppVersion.");

const readme = readFileSync("README.md", "utf8");
if (existsSync("README.zh-TW.md")) throw new Error("Keep both languages in README.md, not a separate README.zh-TW.md.");
const englishStart = readme.search(/^## English\s*$/m);
const chineseStart = readme.search(/^## 繁體中文\s*$/m);
if (englishStart < 0 || chineseStart < englishStart) throw new Error("README.md must contain English followed by Traditional Chinese.");
const english = readme.slice(englishStart, chineseStart);
const chinese = readme.slice(chineseStart);
for (const [section, language, terms] of [
  [english, "English", [/install/i, /privacy/i, /limitations/i, /license/i]],
  [chinese, "Traditional Chinese", [/安裝/, /隱私/, /限制/, /授權/]]
]) {
  if (!section.includes(manifest.version)) throw new Error(`README.md ${language} section must state the current version.`);
  if (!section.includes(manifest.minAppVersion)) throw new Error(`README.md ${language} section must state manifest.minAppVersion.`);
  if (!section.includes("[INSTALL.md](INSTALL.md)")) throw new Error(`README.md ${language} section must link to INSTALL.md.`);
  if (!/\[[^\]]+\]\(LICENSE\)/.test(section)) throw new Error(`README.md ${language} section must link to LICENSE.`);
  for (const term of terms) if (!term.test(section)) throw new Error(`README.md ${language} section is missing ${term}.`);
}

for (const path of ["visual-agent-map/main.js", "visual-agent-map/manifest.json", "visual-agent-map/styles.css"]) {
  if (existsSync(path)) throw new Error(`Stale duplicate release artifact: ${path}`);
}

if (existsSync("dist")) for (const path of required) {
  const distPath = `dist/${path}`;
  if (existsSync(distPath) && readFileSync(path).compare(readFileSync(distPath)) !== 0) throw new Error(`dist artifact differs from ${path}.`);
}
