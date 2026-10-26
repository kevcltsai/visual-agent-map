// The one esbuild configuration every test uses to bundle product TypeScript into a CommonJS string.
// Prompt templates are Markdown imports, so the `.md` text loader is always on (matching esbuild.config.mjs).
// Bundles are cached per process by their options: suites load the same entry (main.ts alone ~185 times) and
// re-bundling each call dominated test CPU. Callers only read the result, and every load still evaluates the code
// in a fresh vm context, so module state stays isolated. Set VAM_TEST_BUILD_CACHE=0 to bundle on every call.
const esbuild = require('esbuild');

const cache = new Map();
const cacheEnabled = process.env.VAM_TEST_BUILD_CACHE !== '0';

/** Same call shape as esbuild.buildSync; callers pass `entryPoints` and, when needed, `external`. */
function buildSync(options) {
  const resolved = { bundle: true, write: false, platform: 'node', format: 'cjs', loader: { '.md': 'text' }, ...options };
  if (!cacheEnabled) return esbuild.buildSync(resolved);
  const key = `${process.cwd()}\0${JSON.stringify(resolved)}`;
  let result = cache.get(key);
  if (!result) { result = esbuild.buildSync(resolved); cache.set(key, result); }
  return result;
}

module.exports = { buildSync };
