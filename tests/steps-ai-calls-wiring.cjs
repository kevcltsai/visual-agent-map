// main.ts wiring of AiCalls: one registry shared by activeTasks, ThinkingCore and the expansion coordinator, and
// resetCodexRuntime stopping every call that is in flight (outline and reframe, through the real services).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('./support.cjs');
const { load } = require('./support-replay.cjs');

const { translate } = load('i18n.ts');

const { default: Plugin } = S.load('main.ts', { obsidian: S.obsidian });

const newPlugin = () => {
  const plugin = new Plugin();
  plugin.app = { vault: {}, fileManager: {} };
  plugin.logs = { appendLog() {} };
  plugin.pluginDirectory = () => '/plugin';
  return plugin;
};

const deferredRuntime = () => {
  const pending = S.deferred();
  const seen = [];
  const runtime = { capabilities: { id: 'codex', imageGeneration: true, webSearch: true, prewarm: false }, run: async request => { seen.push(request); return pending.promise; } };
  return { pending, seen, runtimeFor: () => runtime };
};
const keys = plugin => [...plugin.activeTasks.keys()];
const tick = () => new Promise(resolve => setImmediate(resolve));

test('wiring: activeTasks, core.calls and the expansion coordinator share the one AiCalls registry', () => {
  const plugin = newPlugin();
  assert.equal(plugin.activeTasks, plugin.aiCalls.activeTasks);
  assert.equal(plugin.core.calls, plugin.aiCalls);
  assert.equal(plugin.expansionCoordinator.activeTasks, plugin.activeTasks);
});

test('wiring: an outline call is registered under outline-generate: and resetCodexRuntime stops it', async () => {
  const plugin = newPlugin();
  const fake = deferredRuntime();
  plugin.aiRuntime.runtimeFor = fake.runtimeFor;
  const request = { topic: 'Sleep and memory', presetText: 'Make a tree for {research topic}.', language: 'en', model: 'gpt-6-luna', reasoning: 'low' };
  const settled = plugin.outlineGeneration.generate(request, new AbortController().signal).then(value => ({ value }), error => ({ error }));
  await tick();
  assert.equal(fake.seen.length, 1);
  assert.equal(keys(plugin).length, 1);
  assert.match(keys(plugin)[0], /^outline-generate:/);
  plugin.resetCodexRuntime();
  assert.equal(fake.seen[0].controls.signal.aborted, true);
  fake.pending.resolve('# Root\n## A');
  const result = await settled;
  assert.ok(result.error, 'a reply that arrives after the stop is refused');
  assert.equal(result.error.message, translate('en', 'error.outline_generate_stopped'));
  assert.equal(plugin.activeTasks.size, 0);
});

test('wiring: a reframe call through core.reframing is registered under reframe: and resetCodexRuntime stops it', async () => {
  const plugin = newPlugin();
  const fake = deferredRuntime();
  plugin.aiRuntime.runtimeFor = fake.runtimeFor;
  const request = { targetCore: 'understand', source: 'Candidate insight', question: 'Explore this', context: '', language: 'en', model: 'gpt-6-luna', reasoning: 'low' };
  const settled = plugin.core.reframing.reframe(request, new AbortController().signal).then(value => ({ value }), error => ({ error }));
  await tick();
  assert.equal(fake.seen.length, 1);
  assert.equal(keys(plugin).length, 1);
  assert.match(keys(plugin)[0], /^reframe:/);
  plugin.resetCodexRuntime();
  assert.equal(fake.seen[0].controls.signal.aborted, true);
  fake.pending.resolve(JSON.stringify({ question: 'What distinguishes these?', context: 'Open tensions remain.', rationale: 'Test it.' }));
  const result = await settled;
  assert.ok(result.error, 'a reply that arrives after the stop is refused');
  assert.equal(result.error.message, 'Reframing stopped');
  assert.equal(plugin.activeTasks.size, 0);
});
