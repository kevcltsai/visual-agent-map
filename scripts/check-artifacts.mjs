import { existsSync, readFileSync } from "node:fs";

const required = ["main.js", "manifest.json", "styles.css"];
for (const path of ["README.md", "LICENSE"]) if (!existsSync(path)) throw new Error(`Missing distribution document: ${path}`);
for (const path of required) if (!existsSync(path)) throw new Error(`Missing release artifact: ${path}`);
if (!existsSync("response-schema.json")) throw new Error("Missing response-schema.json source.");
const productionBundle = readFileSync("main.js", "utf8");
for (const smokeMarker of ["VAM_SMOKE_PROFILE_ACTIVE", "Test overrides active", "flow-limits.smoke"]) if (productionBundle.includes(smokeMarker)) throw new Error(`Production main.js contains the smoke test marker "${smokeMarker}".`);
if (!readFileSync("main.js", "utf8").includes("https://json-schema.org/draft/2020-12/schema")) throw new Error("main.js does not contain the embedded response schema.");

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
for (const field of ["id", "name", "version", "minAppVersion", "author", "description"]) {
  if (typeof manifest[field] !== "string" || !manifest[field].trim()) throw new Error(`Invalid manifest field: ${field}`);
}
if (manifest.isDesktopOnly !== true) throw new Error("VAM uses Node APIs and must be desktop-only.");
if (!/^\d+\.\d+\.\d+$/.test(manifest.minAppVersion)) throw new Error("Invalid manifest minAppVersion.");
const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const packageLock = JSON.parse(readFileSync("package-lock.json", "utf8"));
const versions = JSON.parse(readFileSync("versions.json", "utf8"));
if (manifest.version !== packageJson.version) throw new Error("package.json and manifest.json versions must match.");
if (packageLock.version !== manifest.version || packageLock.packages?.[""]?.version !== manifest.version) throw new Error("package-lock.json and manifest.json versions must match.");
if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error("manifest.json version must use x.y.z SemVer.");
if (versions[manifest.version] !== manifest.minAppVersion) throw new Error("versions.json must map the current release to manifest.minAppVersion.");

for (const path of ["README.zh-TW.md", "INSTALL.md"]) if (!existsSync(path)) throw new Error(`Missing distribution document: ${path}`);
for (const path of ["LICENSES/Apache-2.0.txt", "LICENSES/AGPL-3.0-only.txt", "LICENSES/ASSET-ATTRIBUTIONS.md", "NOTICE", "scripts/prepare-release-source.mjs"]) {
  if (!existsSync(path)) throw new Error(`Missing license/distribution support file: ${path}`);
}
if (packageJson.license !== "AGPL-3.0-only" || packageLock.packages?.["" ]?.license !== "AGPL-3.0-only") {
  throw new Error("package.json and package-lock.json root license must be AGPL-3.0-only.");
}
const agpl = readFileSync("LICENSE", "utf8");
const apache = readFileSync("LICENSES/Apache-2.0.txt", "utf8");
if (!agpl.startsWith("                    GNU AFFERO GENERAL PUBLIC LICENSE") || !apache.startsWith("Apache License\nVersion 2.0")) {
  throw new Error("The full AGPL-3.0-only or retained Apache-2.0 license text is missing.");
}
if (readFileSync("LICENSES/AGPL-3.0-only.txt", "utf8") !== agpl) throw new Error("The copied AGPL-3.0-only text must match LICENSE byte for byte.");
for (const [label, contents] of [["AGPL", agpl], ["Apache", apache]]) {
  const bannerText = contents.trimEnd().split(/\r?\n/).map(line => line ? `// ${label}: ${line}` : "//").join("\n");
  if (!productionBundle.includes(bannerText)) throw new Error(`main.js is missing the complete ${label} license text.`);
}
if (!productionBundle.includes("// Copyright © 2026 Kevin Tsai")) throw new Error("main.js is missing the copyright notice.");
const expectedChannelMarker = process.env.VAM_RELEASE_BUILD === "1" ? `Visual Agent Map release ${manifest.version}` : `UNRELEASED CANDIDATE ${manifest.version}`;
if (!productionBundle.includes(`${expectedChannelMarker} — AGPL-3.0-only. Corresponding Source: https://github.com/kevcltsai/visual-agent-map/releases/download/${manifest.version}/visual-agent-map-${manifest.version}-source.tar.gz`)) {
  throw new Error("main.js must contain the exact Corresponding Source offer for its build channel.");
}
const releaseWorkflow = readFileSync(".github/workflows/release.yml", "utf8");
for (const marker of ["npm run release:source", "LICENSE NOTICE", "source.tar.gz.sha256"]) {
  if (!releaseWorkflow.includes(marker)) throw new Error(`Release workflow is missing ${marker}.`);
}
const releaseBuilder = readFileSync("scripts/prepare-release-source.mjs", "utf8");
for (const marker of ['"archive"', 'createHash("sha256")', "manifest.version !== version", "writeFileSync(`${output}.sha256`"]) {
  if (!releaseBuilder.includes(marker)) throw new Error(`Corresponding Source builder is missing ${marker}.`);
}
if (/agents-spec|product-intelligence|exchange-snapshot/.test(releaseBuilder)) throw new Error("The public source archive builder must not reference private corpus paths.");
const buildStep = releaseWorkflow.indexOf("Build the release distribution files");
const testStep = releaseWorkflow.indexOf("Test release notice and product behavior");
const artifactStep = releaseWorkflow.indexOf("Verify release artifacts");
if (!(buildStep >= 0 && buildStep < testStep && testStep < artifactStep)) throw new Error("Release mode must build before release tests and artifact validation.");
const attribution = readFileSync("LICENSES/ASSET-ATTRIBUTIONS.md", "utf8");
for (const asset of ["assets/screenshots/image-anchors.png", "assets/screenshots/map-overview.png", "assets/screenshots/picture-book.png", "tests/fixtures/color/mermaid/architecture.svg", "tests/fixtures/color/mermaid/gantt.svg", "tests/fixtures/color/mermaid/gitGraph.svg", "tests/fixtures/color/mermaid/mindmap.svg", "tests/fixtures/color/mermaid/xychart.svg", "tests/fixtures/sharing/Attachments/diagram.svg", "tests/fixtures/sharing/Attachments/photo.png", "tests/fixtures/taiwan-travel-regression/Attachments/east-coast-landscape.webp", "tests/fixtures/taiwan-travel-regression/Attachments/nine-day-timeline.webp", "tests/fixtures/taiwan-travel-regression/Attachments/rail-and-car-options.webp", "tests/fixtures/taiwan-travel-regression/Attachments/regional-food.webp", "tests/fixtures/taiwan-travel-regression/Attachments/taiwan-route-overview.webp"]) {
  if (!attribution.includes(`\`${asset}\``)) throw new Error(`Asset attribution inventory is missing ${asset}.`);
}
const english = readFileSync("README.md", "utf8");
const chinese = readFileSync("README.zh-TW.md", "utf8");
if (!english.includes("[繁體中文](README.zh-TW.md)") || !chinese.includes("[English](README.md)")) throw new Error("README.md and README.zh-TW.md must link to each other.");
for (const [section, language, terms] of [
  [english, "English", [/install/i, /privacy/i, /limitations/i, /license/i]],
  [chinese, "Traditional Chinese", [/安裝/, /隱私/, /限制/, /授權/]]
]) {
  if (!section.includes(manifest.version)) throw new Error(`README ${language} page must state the current version.`);
  if (!section.includes(manifest.minAppVersion)) throw new Error(`README ${language} page must state manifest.minAppVersion.`);
  if (!section.includes("[INSTALL.md](INSTALL.md)")) throw new Error(`README ${language} page must link to INSTALL.md.`);
  if (!/\[[^\]]+\]\(LICENSE\)/.test(section)) throw new Error(`README ${language} page must link to LICENSE.`);
  for (const term of terms) if (!term.test(section)) throw new Error(`README ${language} page is missing ${term}.`);
}
const install = readFileSync("INSTALL.md", "utf8");
for (const heading of [/^## Known limitations\s*$/m, /^## 已知限制\s*$/m]) if (!heading.test(install)) throw new Error(`INSTALL.md is missing ${heading}.`);

for (const path of ["visual-agent-map/main.js", "visual-agent-map/manifest.json", "visual-agent-map/styles.css"]) {
  if (existsSync(path)) throw new Error(`Stale duplicate release artifact: ${path}`);
}

if (existsSync("dist")) for (const path of required) {
  const distPath = `dist/${path}`;
  if (existsSync(distPath) && readFileSync(path).compare(readFileSync(distPath)) !== 0) throw new Error(`dist artifact differs from ${path}.`);
}
