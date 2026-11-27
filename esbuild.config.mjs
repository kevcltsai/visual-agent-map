import esbuild from "esbuild";
import { builtinModules } from "node:module";
import process from "process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const production = process.argv[2] === "production";
const root = path.dirname(fileURLToPath(import.meta.url));
const version = JSON.parse(readFileSync(path.join(root, "manifest.json"), "utf8")).version;
const sourceUrl = `https://github.com/kevcltsai/visual-agent-map/releases/download/${version}/visual-agent-map-${version}-source.tar.gz`;
const isReleaseBuild = process.env.VAM_RELEASE_BUILD === "1";
const licenseBanner = [
  `${isReleaseBuild ? `Visual Agent Map release ${version}` : `UNRELEASED CANDIDATE ${version}`} — AGPL-3.0-only. Corresponding Source: ${sourceUrl}`,
  "Copyright © 2026 Kevin Tsai",
  "Retained Apache License 2.0 text follows.",
  ...readFileSync(path.join(root, "LICENSE"), "utf8").trimEnd().split(/\r?\n/).map(line => line ? `AGPL: ${line}` : ""),
  ...readFileSync(path.join(root, "LICENSES/Apache-2.0.txt"), "utf8").trimEnd().split(/\r?\n/).map(line => line ? `Apache: ${line}` : "")
].map(line => line ? `// ${line}` : "//").join("\n");

const context = await esbuild.context({
  entryPoints: ["main.ts"],
  bundle: true,
  external: ["obsidian", "electron", "@codemirror/state", "@codemirror/view", "node:*", ...builtinModules],
  format: "cjs",
  target: "es2018",
  banner: { js: licenseBanner },
  define: { __VAM_RELEASE_BUILD__: JSON.stringify(isReleaseBuild) },
  logLevel: "info",
  sourcemap: production ? false : "inline",
  treeShaking: true,
  ...(production ? { minify: true, keepNames: true } : {}),
  loader: { ".md": "text", ".txt": "text" },
  outfile: "main.js"
});

if (production) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}
