// Plugin lifecycle regressions: unload cancels pending external reconciliation.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('./support.cjs');

const { default: Plugin } = S.load('main.ts', { obsidian: S.obsidian });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function newPlugin() {
  const plugin = new Plugin();
  plugin.app = { vault: {}, fileManager: {} };
  plugin.logs = { appendLog() {} };
  return plugin;
}

test('unload clears the pending external reconciliation so no repo work runs after dispose', async () => {
  const plugin = newPlugin();
  let disposed = false, mutated = 0;
  plugin.repo = { dispose() { disposed = true; } };
  plugin.mutate = async () => { mutated++; };
  plugin.scheduleExternalReconciliation('Maps/A/deleted.md');
  assert.equal(plugin.externalReconcilePaths.size, 1);
  plugin.onunload();
  assert.ok(disposed);
  assert.equal(plugin.externalReconcileTimer, null);
  assert.equal(plugin.externalReconcilePaths.size, 0);
  await delay(700);
  assert.equal(mutated, 0, 'the 500 ms reconcile timer never fired after unload');
});

test('one external delete batch scans the maps once, however many notes were deleted', async () => {
  const plugin = newPlugin();
  const checked = [];
  let reconciled = 0;
  plugin.repo = {
    async anyMapNodePath(paths) { checked.push([...paths]); return false; },
    async reconcileMissingNodePaths() { reconciled++; return 0; },
    dispose() {}
  };
  plugin.mutate = work => work();
  for (let i = 0; i < 50; i++) plugin.scheduleExternalReconciliation(`Personal/gone-${i}.md`);
  await delay(700);
  assert.equal(checked.length, 1, 'one map scan for the whole batch');
  assert.equal(checked[0].length, 50);
  assert.equal(reconciled, 0, 'no node deleted, nothing reconciled');
  plugin.onunload();
});

test('W2c plugin: prewarmClaude for a synthesis resolves auto to medium like the run itself; other modes and explicit levels are unchanged', () => {
  const plugin = newPlugin();
  const calls = [];
  plugin.pluginDirectory = () => '/plugin';
  plugin.aiRuntime.claude = () => ({ prewarm: (...args) => { calls.push([args[0], args[1], args[3]]); return true; } });
  plugin.settings.cliReasoning = 'auto';
  plugin.prewarmClaude('claude:sonnet', undefined, false, 'synthesize');
  plugin.prewarmClaude('claude:sonnet', 'auto', true, 'merge');
  plugin.prewarmClaude('claude:sonnet', 'auto', true, 'task');
  plugin.prewarmClaude('claude:sonnet', 'auto', true);
  plugin.prewarmClaude('claude:sonnet', 'high', true, 'synthesize');
  plugin.prewarmClaude('claude:sonnet', 'low', true, 'synthesize');
  assert.deepEqual(calls.map(call => call[1]), ['medium', 'medium', 'low', 'low', 'high', 'low']);
  assert.equal(calls[0][2], false, 'the web setting follows the dialog');
  // The same level the service resolves for the real synthesis request (so the warm command line matches it).
  const { effectiveReasoningLevel } = S.load('ai/task-policy.ts');
  assert.equal(effectiveReasoningLevel({ mode: 'synthesize' }, 'auto'), calls[0][1]);
});

test('app quit (window beforeunload, no onunload) stops every running AI call so its child process cannot outlive Obsidian', () => {
  const plugin = newPlugin();
  const registered = [];
  plugin.registerDomEvent = (target, type, callback) => registered.push({ target, type, callback });
  plugin.registerAppExitStop();
  assert.equal(registered.length, 1);
  assert.equal(registered[0].type, 'beforeunload');
  assert.equal(typeof registered[0].target.setTimeout, 'function', 'registered on the plugin window');
  const running = new AbortController();
  plugin.activeTasks.set('Maps/A/Map.md', running);
  let reset = 0;
  plugin.aiRuntime.reset = () => { reset++; };
  registered[0].callback();
  assert.ok(running.signal.aborted, 'the running call was aborted');
  assert.equal(reset, 1, 'runtime processes (warm Claude, Codex) were stopped');
});
