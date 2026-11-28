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

test('B viewport debounce: unload sends every pending viewport first, then releases the vault at once', () => {
  const plugin = newPlugin();
  const order = [];
  plugin.repo = { dispose() { order.push('dispose'); } };
  plugin.viewportsPending.add({ flushViewportOnUnload() { order.push('flush A'); } });
  plugin.viewportsPending.add({ flushViewportOnUnload() { order.push('flush B'); } });
  plugin.onunload();
  assert.deepEqual(order, ['flush A', 'flush B', 'dispose'], 'dispose stays synchronous, after the flushes started');
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
  let reset = 0, terminated = 0;
  plugin.aiRuntime.reset = () => { reset++; };
  plugin.aiRuntime.terminateOwnedProcesses = () => { terminated++; };
  registered[0].callback();
  assert.ok(running.signal.aborted, 'the running call was aborted');
  assert.equal(reset, 1, 'runtime processes (warm Claude, Codex) were stopped');
  assert.equal(terminated, 1, 'quit sends the final signal before the renderer disappears');
});

// ---- P3.9 F09 (living-node §5.2, §8.3, §8.4; A32): loading never starts AI or writes; unload rejects a late result ----
// One bundle for the plugin and the Living Node runtime, so the round shares the plugin's coordinator (module WeakMap).
const lifecycle = S.load('main.ts', { obsidian: S.obsidian }, {}, { entryPoints: [], stdin: {
  contents: "export { default } from './main'; export { livingCoordinator, runLivingRound } from './experiences/visual-map/living-node-runtime';",
  resolveDir: S.root, loader: 'ts', sourcefile: 'plugin-lifecycle-entry.ts' } });
const STALE_CARD = '---\nagent-map-node: true\nagent-map-id: map\ntopic-id: map\nnode-id: card\nai-card: true\nliving-node-outcome: failed\nliving-node-reason: failed\n---\n# card\n\n## Prompt\n\nResearch card again\n\n## Detail\n\nManual card\n';
// Counts every AI entry: the AI task service, the provider runtimes it builds, and the runtime service.
function countAiCalls(plugin) {
  const calls = [];
  const spy = (target, names, label) => { for (const name of names) if (typeof target[name] === 'function') { const original = target[name]; target[name] = (...args) => { calls.push(`${label}.${name}`); return original.apply(target, args); }; } };
  const methods = target => { const names = new Set(); for (let o = target; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) for (const n of Object.getOwnPropertyNames(o)) if (n !== 'constructor') names.add(n); return [...names]; };
  spy(plugin.aiTasks, methods(plugin.aiTasks), 'aiTasks');
  // Stopping processes at unload (reset, terminate, dispose) is not an AI call.
  spy(plugin.aiRuntime, methods(plugin.aiRuntime).filter(n => !['dispose', 'reset', 'terminateOwnedProcesses'].includes(n)), 'aiRuntime');
  spy(plugin, ['askModel', 'runtime', 'claudeCli'], 'plugin');
  return calls;
}

test('P3.9 load: a vault with a stale Living card makes no AI call and writes nothing during onload and layout-ready', async () => {
  const writes = [];
  const record = name => (...args) => { writes.push([name, args[0]?.path ?? args[0]]); return Promise.resolve(); };
  const card = new S.TFile('Agent Workspace/Topics/map/Notes/card.md');
  const vault = {
    adapter: { exists: async () => false, list: async () => ({ files: [], folders: [] }), read: async () => '', write: record('adapter.write'), mkdir: record('adapter.mkdir') },
    getAbstractFileByPath: path => (path === card.path ? card : null), read: async file => (file.path === card.path ? STALE_CARD : ''), cachedRead: async file => (file.path === card.path ? STALE_CARD : ''),
    getMarkdownFiles: () => [card], getFiles: () => [card], getAllLoadedFiles: () => [card], getRoot: () => ({ children: [card] }), on: (name, handler) => ({ name, handler }),
    create: record('create'), createFolder: record('createFolder'), modify: record('modify'), process: record('process'), rename: record('rename'), trash: record('trash'), delete: record('delete')
  };
  const { default: Plugin } = lifecycle;
  const bare = new Plugin();
  const plugin = new Proxy(bare, { get: (target, key, receiver) => key in target || typeof key !== 'string' || !/^(register|add)/.test(key) ? Reflect.get(target, key, receiver) : () => ({ setAttribute() {}, addClass() {}, addEventListener() {} }) });
  plugin.manifest = { id: 'visual-agent-map', version: '0.0.0-test', dir: '' };
  plugin.app = { vault, fileManager: { trashFile: record('trashFile'), renameFile: record('renameFile') }, metadataCache: { on: () => ({}), getFileCache: () => null },
    workspace: { onLayoutReady: callback => callback(), on: () => ({}), getLeavesOfType: () => [], getActiveFile: () => null, getActiveViewOfType: () => null, layoutReady: true }, loadLocalStorage: () => null, saveLocalStorage() {} };
  plugin.loadData = async () => ({ migrated: true, structureVersion: 2, workspaceInitialized: true, noteStylesFolder: 'WS/Styles' });
  plugin.saveData = async () => {};
  plugin.addCommand = command => command;
  const calls = countAiCalls(bare);
  await plugin.onload(); await plugin.ready; await delay(20);
  assert.deepEqual(calls, [], 'no AI call at load');
  assert.deepEqual(writes, [], 'no vault write at load');
  bare.onunload();
  assert.deepEqual(calls, [], 'no AI call at unload');
  assert.deepEqual(writes, [], 'unload writes nothing');
});

test('P3.9 unload: a Living result that arrives after unload, and unload itself, make no vault create, modify or delete', async () => {
  const f = S.fixture();
  const mapDoc = S.map([S.node('card')]);
  await f.app.vault.create('card.md', STALE_CARD.replace('Research card again', 'Research card'));
  f.repo.readMap = async () => mapDoc;
  // The plugin and the round come from the same bundle, so `plugin.onunload()` closes the round's own coordinator.
  const plugin = new lifecycle.default();
  plugin.app = f.app;
  plugin.logs = { appendLog() {} };
  plugin.repo = f.repo;
  const coordinator = lifecycle.livingCoordinator(plugin);
  const run = coordinator.beginRun('Map.md');
  const writes = [];
  let recording = false;
  for (const name of ['create', 'createFolder', 'createBinary', 'modify', 'modifyBinary', 'append', 'process', 'rename', 'delete', 'trash']) {
    const original = f.app.vault[name];
    f.app.vault[name] = async (...args) => { if (recording) writes.push([name, args[0]?.path ?? args[0]]); return original?.apply(f.app.vault, args); };
  }
  const trashFile = f.app.fileManager?.trashFile;
  f.app.fileManager = { ...f.app.fileManager, trashFile: async (...args) => { if (recording) writes.push(['trashFile', args[0]?.path]); return trashFile?.apply(f.app.fileManager, args); } };
  const before = f.contents.get('card.md');
  const reply = S.deferred(), dispatched = S.deferred();
  let late;
  const port = {
    // The view's shape (view.ts runPrompts) minus its repo-disposed check: only the coordinator can stop this round.
    app: f.app, repo: f.repo, mapPath: 'Map.md', viewSession: 'view', signal: run.signal,
    coordinator, current: () => !run.signal.aborted, busy: () => false, language: () => 'English',
    mapSources: async () => [], confirm: async (_model, run) => { await run(); return true; },
    onStart() {}, onRunning() {}, onSettled() {}, onFailure() {},
    calls: { run: async (prepared, options, finish) => {
      dispatched.resolve();
      await reply.promise;
      late = finish(JSON.stringify({ baseRevision: prepared.input.base.revision, requiresWeb: false, operations: [{ kind: 'output', text: 'Late result', evidence: [] }] }), { signal: options.signal, parsed() {} });
      return late;
    } }
  };
  const round = lifecycle.runLivingRound(port).catch(error => error);
  await dispatched.promise;
  recording = true;
  plugin.onunload();
  assert.deepEqual(writes, [], 'unload itself writes nothing');
  assert.ok(run.signal.aborted, 'unload cancels the formal run');
  assert.equal(coordinator.beginRun('Other.md'), undefined, 'the coordinator is closed');
  assert.equal(coordinator.acquire('other', 'view', ['Other.md'], false), undefined, 'no lease after unload');
  reply.resolve();
  const results = await round;
  assert.equal(typeof results?.get, 'function', `the round settles: ${results}`);
  assert.equal(results.get('card'), 'cancelled', 'a round stopped by unload reports cancelled (§5.2), not a failure');
  await late?.catch?.(() => {});
  await delay(20);
  assert.deepEqual(writes, [], 'the late result writes nothing');
  assert.equal(f.contents.get('card.md'), before, 'the card keeps its bytes');
});
