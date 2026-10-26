// Loads product modules together with AiCalls in ONE esbuild bundle. `load` gives every entry its own bundle, but the
// prepared-step brand (a WeakSet in core/step-runner.ts) and `instanceof Error` do not cross bundles, so a service and
// the AiCalls it uses must come from the same one.
const crypto = require('node:crypto');
const path = require('node:path');
const vm = require('node:vm');
const { buildSync } = require('./build.cjs');

const root = path.resolve(__dirname, '..');

/**
 * Bundles `entry` (a repository path such as core/step-runner.ts) with AiCalls and the runtime adapters.
 * Also exports `makeError`, an Error of the bundle's own realm (product code tests instanceof Error).
 */
function loadWithAiCalls(entry, overrides = {}, globals = {}) {
  const contents = [
    `export * from ${JSON.stringify('./' + entry.replace(/\.ts$/, ''))};`,
    'export { AiCalls } from "./core/ai-calls";',
    'export { aiRuntimeForModel, claudeCodeAiRuntime, codexAppServerAiRuntime } from "./core/ai-runtime-service";',
    'export { CLAUDE_CAPABILITIES, CODEX_CAPABILITIES } from "./core/ai-runtime";',
    'export const makeError = (message: string): Error => new Error(message);'
  ].join('\n');
  const code = buildSync({ stdin: { contents, resolveDir: root, loader: 'ts', sourcefile: 'support-ai-calls-entry.ts' }, external: ['obsidian', 'node:*'] }).outputFiles[0].text;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, require: name => overrides[name] || require(name), console: Object.assign(Object.create(console), { debug() {} }), TextDecoder, crypto: crypto.webcrypto, process, AbortController, DOMException, setTimeout, clearTimeout, ...globals });
  return module.exports;
}

/** An AiCalls over the old AiTaskServiceOptions-shaped fake (what the provider runner tests already build). */
function aiCallsFor(mod, options, activeTasks) {
  return new mod.AiCalls({
    runtimeFor: model => mod.aiRuntimeForModel(model, {
      claude: () => options.claudeRuntime(options.pluginDirectory()),
      codex: local => options.codexRuntime(options.pluginDirectory(), local)
    }),
    exchanges: () => (options.exchangeLoggingEnabled() ? options.exchanges() : null),
    activeTasks
  });
}

module.exports = { loadWithAiCalls, aiCallsFor };
