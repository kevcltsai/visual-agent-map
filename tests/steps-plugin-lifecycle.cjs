// Plugin lifecycle regressions: Coffee Tables follows a workspace reconnect; unload cancels pending external reconciliation.
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

test('reconnecting to another workspace rebuilds Coffee Tables storage and manager and re-points open views', async () => {
  const plugin = newPlugin();
  plugin.settings.workspaceFolder = 'Old Workspace';
  plugin.buildCoffee();
  const oldManager = plugin.coffeeManager;
  assert.equal(plugin.coffeeStorage.folder, 'Old Workspace/Coffee Tables');
  let stopped = 0;
  const gate = S.deferred();
  let duringStop;
  oldManager.stop = async () => {
    stopped++;
    duringStop = { manager: plugin.coffeeManager, folder: plugin.coffeeStorage.folder };
    await gate.promise;
  };
  const rebound = [];
  plugin.coffeeViews = () => [{ rebindStorage: () => rebound.push(plugin.coffeeStorage.folder) }];
  plugin.settings.workspaceFolder = 'New Workspace';
  const rebuilding = plugin.rebuildCoffee();
  await delay(10);
  assert.ok(duringStop, 'the old manager is being stopped');
  assert.ok(duringStop.manager && duringStop.manager !== oldManager, 'while the old manager stops, coffeeManager is the new one, never null');
  assert.equal(duringStop.folder, 'New Workspace/Coffee Tables');
  assert.deepEqual(rebound, ['New Workspace/Coffee Tables'], 'views are re-pointed before the old stop finishes');
  gate.resolve();
  await rebuilding;
  assert.equal(stopped, 1, 'the old manager was stopped (in-flight work awaited) before replacement');
  assert.notEqual(plugin.coffeeManager, oldManager);
  assert.equal(plugin.coffeeStorage.folder, 'New Workspace/Coffee Tables');
  assert.deepEqual(rebound, ['New Workspace/Coffee Tables'], 'open views re-read the new storage');
});

test('a manager still flushing after a reconnect saves through its own storage, not the new folder', async () => {
  const plugin = newPlugin();
  plugin.settings.workspaceFolder = 'Old Workspace';
  plugin.buildCoffee();
  const oldStorage = plugin.coffeeStorage;
  const saved = [];
  oldStorage.save = async () => { saved.push('old'); };
  const oldManager = plugin.coffeeManager;
  plugin.settings.workspaceFolder = 'New Workspace';
  plugin.coffeeViews = () => [];
  await plugin.rebuildCoffee();
  plugin.coffeeStorage.save = async () => { saved.push('new'); };
  await oldManager.saveSession({ id: 's' });
  assert.deepEqual(saved, ['old']);
});

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

test('Reconnect existing workspace (offerWorkspaceReconnect) rebuilds Coffee Tables for the chosen folder', async () => {
  const modals = [];
  const obsidian = { ...S.obsidian, Modal: class { constructor(app) { this.app = app; } open() { modals.push(this); } close() {} } };
  const { default: ReconnectPlugin } = S.load('main.ts', { obsidian });
  const plugin = new ReconnectPlugin();
  plugin.app = { vault: {}, fileManager: {} };
  plugin.logs = { appendLog() {} };
  plugin.settings.workspaceFolder = 'Old Workspace';
  plugin.buildCoffee();
  const oldManager = plugin.coffeeManager;
  const rebound = [];
  plugin.coffeeViews = () => [{ rebindStorage: () => rebound.push(plugin.coffeeStorage.folder) }];
  plugin.views = () => [];
  plugin.saveSettings = async () => {};
  plugin.mutate = work => work();
  plugin.repo = { rebuildDerivedData: async () => {} };
  await plugin.offerWorkspaceReconnect(['New Workspace']);
  assert.equal(modals.length, 1);
  await modals[0].choices[0].action();
  assert.equal(plugin.settings.workspaceFolder, 'New Workspace');
  assert.equal(plugin.coffeeStorage.folder, 'New Workspace/Coffee Tables');
  assert.notEqual(plugin.coffeeManager, oldManager);
  assert.deepEqual(rebound, ['New Workspace/Coffee Tables']);
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

test('S6 plugin: prewarmClaude pre-starts a Claude command (model id, effort, response schema, web tools), a Codex model releases it, and unload resets the runtime service (which disposes the pool)', () => {
  const plugin = newPlugin();
  const calls = [];
  plugin.pluginDirectory = () => '/plugin';
  plugin.aiRuntime.claude = directory => ({ prewarm: (...args) => { calls.push([directory, args[0], args[1], args[2] && args[2].type, args[3]]); return true; } });
  plugin.settings.cliReasoning = 'auto';
  plugin.prewarmClaude('claude:sonnet', undefined);
  plugin.prewarmClaude('claude:opus', 'high');
  assert.deepEqual(calls, [['/plugin', 'sonnet', 'low', 'object', true], ['/plugin', 'opus', 'high', 'object', true]], 'auto resolves to low like a short-source task');
  plugin.prewarmClaude('claude:sonnet', 'low', false);
  assert.equal(calls.at(-1)[4], false, 'a local run pre-starts the command without web tools');
  calls.pop();
  let released = 0;
  Object.assign(plugin.aiRuntime, { releaseWarm: () => { released++; }, reset: () => { released += 10; }, dispose: () => { released += 100; } });
  plugin.prewarmClaude('gpt-test');
  assert.equal(released, 1, 'a Codex model has nothing to pre-start and drops a waiting process');
  plugin.releaseWarmClaude();
  assert.equal(released, 2);
  plugin.pluginDirectory = () => { throw new Error('no folder'); };
  assert.doesNotThrow(() => plugin.prewarmClaude('claude:sonnet'), 'pre-starting never fails the dialog');
  plugin.repo = { dispose() {} };
  plugin.expansionCoordinator = { stopAll() {} };
  plugin.modelDiscovery = { invalidate() {} };
  released = 0;
  plugin.onunload();
  assert.equal(released, 110, 'onunload resets the runtime service and disposes it (no later pre-start)');
  const before = calls.length;
  plugin.pluginDirectory = () => '/plugin';
  plugin.prewarmClaude('claude:sonnet', 'low');
  assert.equal(calls.length, before, 'a dialog event after unload starts nothing');
});
