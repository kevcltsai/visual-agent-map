// The one esbuild configuration every test uses to bundle product TypeScript into a CommonJS string.
// Prompt templates are Markdown imports, so the `.md` text loader is always on (matching esbuild.config.mjs).
// Bundles are cached per process by their options: suites load the same entry (main.ts alone ~185 times) and
// re-bundling each call dominated test CPU. Callers only read the result, and every load still evaluates the code
// in a fresh vm context, so module state stays isolated. Set VAM_TEST_BUILD_CACHE=0 to bundle on every call.
// Dependency recording (scripts/test-affected.mjs): with VAM_TEST_DEPS_DIR set, every call, cache hits included, notes which source
// files the bundle holds and which test files are on the call stack; the process writes that map to the directory when it exits.
const esbuild = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');

const cache = new Map();
const cacheEnabled = process.env.VAM_TEST_BUILD_CACHE !== '0';

const depsDir = process.env.VAM_TEST_DEPS_DIR;
const repoRoot = path.resolve(__dirname, '..');
const bundleSources = new Map(); // cache key -> repo-relative source files of that bundle
const recorded = new Map(); // test or helper file under tests/ -> Set of source files
const bundles = new Map(); // entry point -> Set of source files, for helpers that cache a load in a module variable
// The test file that asked for the bundle. support.cjs's `load` (a pass-through every suite calls) is skipped. A load made by a helper under
// tests/support* is credited to the test file that called the helper, because most helpers are only called by the suites that need them;
// a load made while a helper module is being required (its top level) is credited to the helper, which every suite requiring it inherits.
// A process started on one test file (node --test) is also credited to it.
const isHelper = file => /^support[^/\\]*$/.test(path.basename(file)) && path.dirname(file) === path.join(repoRoot, 'tests');
function callerFiles() {
  const limit = Error.stackTraceLimit; Error.stackTraceLimit = Infinity;
  const frames = new Error().stack.split('\n').slice(1);
  Error.stackTraceLimit = limit;
  const testsDir = path.join(repoRoot, 'tests') + path.sep;
  const files = new Set();
  const entry = process.argv[1] && path.resolve(process.argv[1]);
  if (entry) files.add(entry);
  let helperFrame = null;
  for (const frame of frames) {
    const match = frame.match(/^\s*at (?:(.+?) \()?(.+?):\d+:\d+\)?$/);
    if (!match) continue;
    const file = match[2].startsWith('file://') ? fileURLToPath(match[2]) : match[2];
    if (file === __filename || !file.startsWith(testsDir)) continue;
    if (path.basename(file) === 'support.cjs' && match[1] === 'load') continue;
    if (isHelper(file)) {
      if (match[1] === 'Object.<anonymous>') { files.add(file); break; }
      helperFrame ??= file;
      continue;
    }
    files.add(file);
    helperFrame = null;
    break;
  }
  if (helperFrame) files.add(helperFrame);
  return [...files].filter(file => file.startsWith(testsDir) && path.basename(file) !== 'run.cjs').map(file => path.relative(repoRoot, file).split(path.sep).join('/'));
}
function record(key, result, options) {
  if (!bundleSources.has(key)) {
    const cwd = process.cwd();
    const sources = Object.keys(result.metafile?.inputs ?? {}).map(input => path.relative(repoRoot, path.resolve(cwd, input)).split(path.sep).join('/')).filter(file => !file.startsWith('..') && !file.startsWith('node_modules/'));
    bundleSources.set(key, sources);
    for (const entryPoint of [options.entryPoints].flat()) if (typeof entryPoint === 'string') { const rel = path.relative(repoRoot, path.resolve(cwd, entryPoint)).split(path.sep).join('/'); let set = bundles.get(rel); if (!set) bundles.set(rel, set = new Set()); for (const source of sources) set.add(source); }
  }
  for (const caller of callerFiles()) { let set = recorded.get(caller); if (!set) recorded.set(caller, set = new Set()); for (const source of bundleSources.get(key)) set.add(source); }
}
if (depsDir) process.on('exit', () => {
  if (!recorded.size) return;
  fs.mkdirSync(depsDir, { recursive: true });
  fs.writeFileSync(path.join(depsDir, `${process.pid}-${Date.now()}.json`), JSON.stringify({ callers: Object.fromEntries([...recorded].map(([file, set]) => [file, [...set].sort()])), bundles: Object.fromEntries([...bundles].map(([entry, set]) => [entry, [...set].sort()])) }));
});

/** Same call shape as esbuild.buildSync; callers pass `entryPoints` and, when needed, `external`. */
function buildSync(options) {
  // AIM is hidden in production (experiences/aim/availability.ts); the suites build with it on unless a caller passes define: { __VAM_AIM__: 'false' } (tests/suites/legacy-aim-map.cjs).
  const resolved = { bundle: true, write: false, platform: 'node', format: 'cjs', loader: { '.md': 'text' }, ...(depsDir ? { metafile: true } : {}), ...options, define: { __VAM_AIM__: 'true', ...options.define } };
  const key = `${process.cwd()}\0${JSON.stringify(resolved)}`;
  if (!cacheEnabled) { const built = esbuild.buildSync(resolved); if (depsDir) { bundleSources.delete(key); record(key, built, resolved); } return built; }
  let result = cache.get(key);
  if (!result) { result = esbuild.buildSync(resolved); cache.set(key, result); }
  if (depsDir) record(key, result, resolved);
  return result;
}

module.exports = { buildSync };
