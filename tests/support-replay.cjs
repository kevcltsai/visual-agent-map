// Helpers shared by tests/prompt-snapshots.cjs and tests/replay.cjs.
// The single model-call seam is runtime.runTask(prompt, model, effort, schema, controls) -> Promise<string>.
// Everything here sits on that seam; no product source is touched.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { buildSync } = require('./build.cjs');

const root = path.resolve(__dirname, '..');
function load(entry, overrides = {}, globals = {}) {
  const code = buildSync({ entryPoints: [path.join(root, entry)], external: ['obsidian', 'node:*'] }).outputFiles[0].text;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, require: name => overrides[name] || require(name), console: Object.assign(Object.create(console), { debug() {} }), TextDecoder, crypto: crypto.webcrypto, process, AbortController, DOMException, setTimeout, clearTimeout, ...globals });
  return module.exports;
}

/**
 * Bundles TypeScript `contents` (imports resolve from the repository root) into one module, so several product modules
 * share a single copy of module state such as the interface language. `load` gives every entry its own copy.
 */
function loadSource(contents, overrides = {}) {
  const code = buildSync({ stdin: { contents, resolveDir: root, loader: 'ts', sourcefile: 'support-replay-entry.ts' }, external: ['obsidian', 'node:*'] }).outputFiles[0].text;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, require: name => overrides[name] || require(name), console: Object.assign(Object.create(console), { debug() {} }), TextDecoder, crypto: crypto.webcrypto, process, AbortController, DOMException, setTimeout, clearTimeout });
  return module.exports;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ISO_TIME = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;
/** Replace values that legitimately change between runs; everything else is compared byte for byte. */
function normalizeText(text) {
  return String(text).replace(/\r\n/g, '\n').replace(UUID, '<uuid>').replace(ISO_TIME, '<time>').split(root).join('<root>');
}
const sha256 = text => crypto.createHash('sha256').update(normalizeText(text)).digest('hex');

const EMPTY_RESULT = JSON.stringify({ summary: 'S', detail: 'D', suggestions: [], visualReferences: [] });
/** Records every runTask call and answers with a fixed raw string (or the next of a list). */
function capturingRuntime(responses = [EMPTY_RESULT]) {
  const calls = [];
  return {
    calls,
    runTask: async (prompt, model, effort, schema, controls) => {
      calls.push({ prompt, model, effort, schema, controls });
      return responses[Math.min(calls.length - 1, responses.length - 1)];
    }
  };
}

function makeService(runtime, { language = 'en', logging = false, exchanges = null } = {}) {
  const { AiTaskService } = load('core/ai-task-service.ts');
  return new AiTaskService({
    pluginDirectory: () => '/plugin', language: () => language, defaultReasoning: () => 'low',
    exchangeLoggingEnabled: () => logging, exchanges: () => exchanges,
    codexRuntime: () => runtime, claudeRuntime: () => runtime
  });
}

/** Run a TaskContext through the real AiTaskService; return every prompt+schema it sent to the provider. */
async function promptsFor(context, { language = 'en', model = 'gpt-6-luna', responses } = {}) {
  const runtime = capturingRuntime(responses);
  try { await makeService(runtime, { language }).askModel(context, model, 'low'); } catch { /* parsing the canned reply may fail; the sent prompt is what matters */ }
  return runtime.calls.map(call => ({ prompt: call.prompt, schema: call.schema }));
}

class ReplayMiss extends Error {}
/**
 * Replay provider. Entries are { promptSha256?, response?, error? }.
 * An entry with promptSha256 answers only a prompt whose normalized hash equals it; an entry without one answers the
 * next unmatched call in order. A call no entry answers throws ReplayMiss; there is no fallback to a live provider.
 */
function replayRuntime(entries) {
  const used = new Set();
  const runtime = {
    calls: [],
    runTask: async (prompt, _model, _effort, _schema, controls) => {
      const hash = sha256(prompt);
      runtime.calls.push({ prompt, hash, schema: _schema });
      let index = entries.findIndex((entry, i) => !used.has(i) && entry.promptSha256 === hash);
      if (index < 0) index = entries.findIndex((entry, i) => !used.has(i) && !entry.promptSha256);
      if (index < 0) throw new ReplayMiss(`Replay has no recorded response for prompt sha256 ${hash} (${entries.length} entries, ${used.size} used).`);
      used.add(index);
      controls?.onRequest?.({ replay: true });
      const entry = entries[index];
      if (entry.error !== undefined && entry.error !== null && entry.error !== '') throw new Error(entry.error);
      return entry.response;
    },
    unused: () => entries.filter((_entry, i) => !used.has(i))
  };
  return runtime;
}

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

const phaseOf = context => /<!--\s*(?:aim|mindsearch)-phase:\s*([a-z-]+)\s*-->/.exec(context.task ?? '')?.[1];
/**
 * Replay ask double for the AimManualFlow ask seam (`ask(context) -> Promise<AiResult>`).
 * `steps` are the historical parsed results in order: { phase, result }. A call whose phase equals the next unconsumed
 * historical step receives that result (a deep copy). Any other phase is answered only by `fills[phase]` (neutral,
 * non-historical stand-ins that let the flow reach the phase under test); with neither it throws ReplayMiss.
 * There is no fallback to a live provider.
 */
function replayAsk(steps, fills = {}) {
  let next = 0;
  const observed = [];
  const ask = async context => {
    const phase = phaseOf(context);
    observed.push({ phase, context });
    if (next < steps.length && steps[next].phase === phase) return JSON.parse(JSON.stringify(steps[next++].result));
    if (fills[phase] !== undefined) return JSON.parse(JSON.stringify(typeof fills[phase] === 'function' ? fills[phase](context) : fills[phase]));
    throw new ReplayMiss(`Replay ask has no historical result or fill for phase ${phase} (next historical step: ${steps[next]?.phase ?? 'none'}).`);
  };
  return { ask, observed, phases: () => observed.map(item => item.phase), consumed: () => next, unused: () => steps.slice(next) };
}

module.exports = { replayAsk, root, load, loadSource, normalizeText, sha256, capturingRuntime, makeService, promptsFor, replayRuntime, ReplayMiss, readJson, EMPTY_RESULT };
