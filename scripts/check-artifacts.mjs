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
const englishStart = readme.indexOf("## English");
const chineseStart = readme.indexOf("## 繁體中文");
if (englishStart < 0 || chineseStart < englishStart) throw new Error("README.md must contain English and Traditional Chinese sections.");
const english = readme.slice(englishStart, chineseStart);
const chinese = readme.slice(chineseStart);
const bilingualHeadings = [
  ["### Highlights", "### 主要功能"],
  ["### How it works", "### 使用方式"],
  ["### Requirements", "### 系統需求"],
  ["### Install", "### 安裝"],
  ["### Vault data", "### Vault 資料"],
  ["### Privacy and network access", "### 隱私與網路存取"],
  ["### Current limitations", "### 目前限制"],
  ["### Build from source", "### 從原始碼建置"]
];
const sectionItemCount = (content, heading) => {
  const start = content.indexOf(heading) + heading.length;
  const next = content.indexOf("\n### ", start);
  const body = content.slice(start, next < 0 ? content.length : next);
  return body.split("\n").filter(line => /^- |^\d+\. /.test(line)).length;
};
for (const [englishHeading, chineseHeading] of bilingualHeadings) {
  if (!english.includes(englishHeading) || !chinese.includes(chineseHeading)) throw new Error(`README.md bilingual section mismatch: ${englishHeading} / ${chineseHeading}`);
  if (sectionItemCount(english, englishHeading) !== sectionItemCount(chinese, chineseHeading)) throw new Error(`README.md bilingual item-count mismatch: ${englishHeading} / ${chineseHeading}`);
}
for (const section of [english, chinese]) {
  if (!section.includes(`Current release: \`${manifest.version}\``) && !section.includes(`目前版本：\`${manifest.version}\``)) throw new Error("README.md must state the current release in both languages.");
  if (!section.includes(`\`${manifest.minAppVersion}\``)) throw new Error("README.md must state manifest.minAppVersion in both languages.");
}

for (const path of ["visual-agent-map/main.js", "visual-agent-map/manifest.json", "visual-agent-map/styles.css"]) {
  if (existsSync(path)) throw new Error(`Stale duplicate release artifact: ${path}`);
}

if (existsSync("dist")) for (const path of required) {
  const distPath = `dist/${path}`;
  if (existsSync(distPath) && readFileSync(path).compare(readFileSync(distPath)) !== 0) throw new Error(`dist artifact differs from ${path}.`);
}
