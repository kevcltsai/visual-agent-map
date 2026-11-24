// Local, disposable viewer cache. CI and explicit clean builds never reuse it.
// Use esbuild's actual relative dependency graph, all source path names (resolution
// may change when a file is added), config contents, and actual tool package bytes.
// Unknown/non-local imports, symlinks, custom tool config or unreadable files disable reuse.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
const hash = value => createHash("sha256").update(value).digest("hex");
const generated = "experiences/sharing/viewer-bundle.generated.ts";
const safePath = path => typeof path === "string" && path.length > 0 && !isAbsolute(path) &&
  path.split(/[\\/]/).every(part => part && part !== ".." && part !== "." && part !== ".git" && part !== "node_modules");
const fixed = ["scripts/build-viewer.mjs", "scripts/viewer-css.mjs", "scripts/viewer-cache.mjs", "styles.css", "experiences/sharing/viewer/viewer.css", "package.json", "package-lock.json", "tsconfig.json"];
const tools = ["esbuild", "@esbuild", "prettier"];
export const viewerCacheEnabled = (env = process.env) => env.CI !== "true" && env.VAM_CLEAN_BUILD !== "1" &&
  !env.ESBUILD_BINARY_PATH && !env.NODE_OPTIONS && !env.NODE_PATH;
export function viewerInputs(meta) {
  try {
    const entries = Object.entries(meta.inputs);
    if (!entries.length) return null;
    for (const [path, input] of entries) {
      if (!safePath(path) || path === generated || path === "main.js" || !Array.isArray(input.imports)) return null;
      for (const entry of input.imports) {
        if (entry.external || !safePath(entry.path) || !/^\.\.?\//.test(entry.original || "")) return null;
      }
    }
    return entries.map(([path]) => path).sort();
  } catch { return null; }
}
function scan(directory, prefix = "", { skip = new Set(), content = () => false } = {}, rows = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (skip.has(entry.name)) continue;
    const path = prefix ? prefix + "/" + entry.name : entry.name;
    const full = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error("symlink invalidates viewer cache");
    if (entry.isDirectory()) { rows.push([path, "dir"]); scan(full, path, { skip, content }, rows); }
    else if (entry.isFile()) {
      const bytes = content(path) ? readFileSync(full) : null;
      if (bytes && /(?:^|\/)(?:tsconfig|jsconfig)[^/]*\.json$/.test(path)) {
        const config = JSON.parse(bytes);
        if (config.extends || config.compilerOptions?.paths || config.compilerOptions?.plugins || config.compilerOptions?.jsxImportSource) throw new Error("custom resolution disables viewer cache");
      }
      rows.push([path, bytes ? hash(bytes) : "file"]);
    } else throw new Error("non-regular viewer input");
  }
  return rows;
}
export function viewerCacheKey(directory, inputs, options, env = process.env) {
  if (!viewerCacheEnabled(env) || !Array.isArray(inputs) || !inputs.length || options?.plugins?.length) return null;
  try {
    const root = realpathSync(directory);
    if (!existsSync(join(root, ".prettierrc.json"))) return null;
    const config = /(?:^|\/)(?:package(?:-lock)?\.json|(?:tsconfig|jsconfig)[^/]*\.json|\.prettierrc(?:\.[^/]*)?|prettier\.config\.[^/]*|\.editorconfig)$/;
    const inventory = scan(root, "", { skip: new Set([".git", "node_modules", ".DS_Store"]), content: path => config.test(path) });
    const inputsHash = [...new Set([...fixed, ...inputs])].sort().map(path => {
      if (!safePath(path)) throw new Error("unsafe path");
      const full = join(root, path);
      if (realpathSync(full) !== resolve(full) || !lstatSync(full).isFile()) throw new Error("non-local input");
      return [path, hash(readFileSync(full))];
    });
    const toolsHash = tools.map(name => {
      const folder = join(root, "node_modules", name);
      if (realpathSync(folder) !== resolve(folder)) throw new Error("tool symlink");
      return [name, scan(folder, "", { content: () => true })];
    });
    return hash(JSON.stringify({ version: 1, node: process.version, platform: process.platform, arch: process.arch, inventory, inputsHash, toolsHash, options }));
  } catch { return null; }
}
export const viewerCachePath = directory => join(directory, "node_modules/.cache/vam/viewer-build.json");
export function readViewerCache(directory) {
  try {
    const row = JSON.parse(readFileSync(viewerCachePath(directory), "utf8"));
    if (row.version !== 1 || !Array.isArray(row.inputs) || !row.inputs.length || !row.inputs.every(safePath)) return null;
    return row;
  } catch { return null; }
}
export function viewerCacheHit(directory, row, key) {
  try {
    return !!row && !!key && row.key === key && /^[0-9a-f]{64}$/.test(row.outputHash) &&
      hash(readFileSync(join(directory, generated))) === row.outputHash;
  } catch { return false; }
}
export function saveViewerCache(directory, inputs, key, output) {
  if (!inputs) return;
  const path = viewerCachePath(directory);
  const staging = path + "." + process.pid + ".tmp";
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(staging, JSON.stringify({ version: 1, inputs, key, outputHash: hash(output) }));
    renameSync(staging, path);
  } catch { /* cache is optional */ } finally { try { rmSync(staging, { force: true }); } catch { /* best effort */ } }
}
