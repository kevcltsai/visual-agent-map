// Argument map recovery and wiring (P5b, rewritten for V2 packet V1): a legacy (`"v": 1`) map is read-only, so a reload that leaves its run
// `running` does NOT pause it when the map opens (opening never writes); maps without the key are untouched. Real main.ts plugin wiring is checked for
// the test entry and for dispose. Unit level: the view is a harness over the real repository, not a live Obsidian.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, fixture, DEFAULT_SETTINGS, obsidian, core, withExpansionCoordinator } = require('./support.cjs');
const dom = require('./support-dom.cjs');

const MODULES = load('main.ts', { obsidian: { ...obsidian, Notice: dom.makeNotice([]) } }, { createFragment: dom.createFragment });
const { VisualAgentMapView } = MODULES;
const Plugin = MODULES.default;
const machine = load('core/argument-map/machine.ts');
const layout = load('core/argument-map/layout.ts');

async function harness({ withKey = true, running = true, phase, stacked = false } = {}) {
  const { repo, app } = fixture('en', { linkIndex: true });
  const settings = { ...DEFAULT_SETTINGS, language: 'en', cliModel: 'gpt-6-luna' };
  repo.settings = settings;
  const mapPath = await repo.createMap('Argument');
  const doc = await repo.readMap(mapPath);
  const ids = {};
  for (const role of ['proposition', 'situation', 'conclusion', 'verified', 'eliminated']) {
    const node = await repo.createNote(role, 'gpt-6-luna', doc, mapPath, 'workspace');
    doc.nodes.push(node);
    ids[role] = node.id;
  }
  if (withKey) {
    let state = machine.newArgumentMap(ids, 'run-1');
    state = machine.applySituationData(state, [{ id: 'd1', need: 'rate' }]);
    state = machine.beginSituationResearch(state, 'd1');
    if (!running) state = machine.applyPause(state, 'user');
    if (phase) state.run.phase = phase;
    doc.argumentMap = state;
    // The flow leaves its map arranged; `stacked` is a map whose cards were never arranged.
    if (!stacked) doc.nodes = layout.arrangeArgumentMap(doc.nodes, state);
  }
  if (stacked) doc.nodes.forEach(n => { n.x = 80; n.y = 80; });
  await repo.saveMap(mapPath, doc);
  let owners = new Set();
  const calls = { provider: 0 };
  const plugin = withExpansionCoordinator({
    repo, settings, running: new Set(), logs: { appendLog() {} }, rebuildDerivedData: () => repo.rebuildDerivedData(), relevanceGrades: new Map(), pendingSuggestions: new Map(),
    releaseOutline() {}, setOutlineActive() {}, detailsShown: () => false, closeStaleDetails() {}, releaseWarmClaude() {},
    askModel: async () => { calls.provider++; throw new Error('no provider call expected'); },
    argumentRuns: { isRunning: p => owners.has(p) },
    mutate: work => Promise.resolve().then(work)
  });
  plugin.isNoteTaskBusy = p => Plugin.prototype.isNoteTaskBusy.call(plugin, p);
  const view = new VisualAgentMapView({ app }, plugin);
  Object.assign(view, { contentEl: dom.element('div'), stageEl: dom.element('div') });
  view.app.workspace = { requestSaveLayout() {} };
  view.render = () => {};
  const text = () => app.vault.read(app.vault.getAbstractFileByPath(mapPath));
  return { repo, view, mapPath, text, owners, calls, open: () => view.openMapInMutation(mapPath) };
}

test('legacy v1 map: a run left running by a reload is NOT paused on open; the map is not written, no provider call', async () => {
  const h = await harness();
  const before = await h.text();
  const stored = (await h.repo.readMap(h.mapPath)).argumentMap;
  assert.equal(stored.v, 1);
  assert.equal(stored.run.status, 'running');
  await h.open();
  assert.equal(await h.text(), before, 'opening wrote nothing');
  assert.equal(h.view.map.argumentMap.run.status, 'running');
  assert.equal(h.calls.provider, 0);
});

test('a map without the argumentMap key is not rewritten', async () => {
  const h = await harness({ withKey: false });
  const before = await h.text();
  await h.open();
  assert.equal(await h.text(), before);
  assert.equal(h.view.map.argumentMap, undefined);
});

test('open: a stacked legacy map is not arranged and not written (read-only); no provider call', async () => {
  const h = await harness({ stacked: true, running: false });
  const before = await h.text();
  await h.open();
  assert.equal(await h.text(), before);
  assert.equal(h.calls.provider, 0);
});

test('open: an ordinary map with stacked cards is not arranged', async () => {
  const h = await harness({ withKey: false, stacked: true });
  const before = await h.text();
  await h.open();
  assert.equal(await h.text(), before);
});

test('a run this instance owns, a paused run and a finished run are left as they are', async () => {
  const owned = await harness();
  owned.owners.add(owned.mapPath);
  const ownedBefore = await owned.text();
  await owned.open();
  assert.equal(await owned.text(), ownedBefore);
  const paused = await harness({ running: false });
  const pausedBefore = await paused.text();
  await paused.open();
  assert.equal(await paused.text(), pausedBefore);
  const finished = await harness({ phase: 'concluded' });
  const finishedBefore = await finished.text();
  await finished.open();
  assert.equal(await finished.text(), finishedBefore);
});

test('an unusable argumentMap key (v:3) is kept as it is and not paused', async () => {
  const h = await harness();
  await h.repo.updateMap(h.mapPath, doc => { doc.argumentMap = { ...doc.argumentMap, v: 3 }; });
  const before = await h.text();
  await h.open();
  assert.equal(await h.text(), before);
});

test('wiring: the plugin owns an ArgumentRuns test entry, and dispose refuses further starts', async () => {
  const entry = new Plugin({}, { id: 'vam', version: '0.0.0' }).argumentRuns;
  assert.ok(entry, 'plugin.argumentRuns exists');
  for (const method of ['start', 'stop', 'resume', 'isRunning', 'dispose']) assert.equal(typeof entry[method], 'function');
  assert.equal(entry.isRunning('Nothing.md'), false);
  entry.dispose();
  await assert.rejects(entry.start('Nothing.md', 'claim'), error => error.code === 'disposed');
});

test('counterexample: opening a legacy map never starts, resumes or writes (start, resume, stop, provider all 0)', async () => {
  const h = await harness();
  const runs = [];
  h.view.plugin.argumentRuns = { isRunning: p => h.owners.has(p), start: (...a) => { runs.push(['start', ...a]); return Promise.resolve(); }, resume: (...a) => { runs.push(['resume', ...a]); return Promise.resolve(); }, stop: (...a) => { runs.push(['stop', ...a]); } };
  const before = await h.text();
  await h.open();
  assert.equal(await h.text(), before);
  assert.deepEqual(runs, [], 'nothing was started or resumed by opening');
  assert.equal(h.calls.provider, 0);
});

// ---- version 2: open-map recovery goes through the runner (packet V7) --------------------------------------------------------------
const { v2State } = require('./fixtures/argument-map-v2-state.cjs');
async function harnessV2() {
  const h = await harness({ withKey: false });
  const doc = await h.repo.readMap(h.mapPath);
  const ids = ['p', 'pr', 'c', 'q1', 'd1', 'q2', 'cmp', 'h1', 'n1'];
  const created = {};
  for (const name of ids) {
    const node = await h.repo.createNote(name, 'gpt-6-luna', doc, h.mapPath, 'workspace');
    doc.nodes.push(node);
    created[name.toUpperCase()] = node.id;
  }
  doc.argumentMap = v2State(created);
  await h.repo.saveMap(h.mapPath, doc);
  return { ...h, created };
}

test('version 2 map: opening asks the runner to recover once with the map path; no provider call', async () => {
  const h = await harnessV2();
  const recovered = [];
  h.view.plugin.argumentRuns = { recover: async path => { recovered.push(path); return false; } };
  await h.open();
  assert.deepEqual(recovered, [h.mapPath]);
  assert.equal(h.calls.provider, 0);
  assert.equal(h.view.map.argumentMap.v, 2);
});

test('version 2 map: when recovery changed the map, the view shows the saved result', async () => {
  const h = await harnessV2();
  h.view.plugin.argumentRuns = {
    recover: async path => {
      await h.repo.updateMap(path, doc => { doc.argumentMap.run.stopReason = 'interrupted'; });
      return true;
    }
  };
  await h.open();
  assert.equal(h.view.map.argumentMap.run.stopReason, 'interrupted');
});

test('counterexample: a legacy map and an ordinary map never reach the version 2 runner', async () => {
  for (const withKey of [true, false]) {
    const h = await harness({ withKey });
    let calls = 0;
    h.view.plugin.argumentRuns = { recover: async () => { calls++; return true; } };
    const before = await h.text();
    await h.open();
    assert.equal(calls, 0, withKey ? 'legacy' : 'no key');
    assert.equal(await h.text(), before);
  }
});

test('counterexample: a recovery that fails still opens the version 2 map as saved', async () => {
  const failing = await harnessV2();
  failing.view.plugin.argumentRuns = { recover: () => Promise.reject(new Error('boom')) };
  await failing.open();
  assert.equal(failing.view.map.argumentMap.v, 2);
});

test('wiring: the real plugin router has recover (open-map recovery) and the v2 runner has frame/start/isRunning (no TODO body)', async () => {
  const plugin = new Plugin({}, { id: 'vam', version: '0.0.0' });
  for (const method of ['start', 'stop', 'resume', 'isRunning', 'recover', 'dispose']) assert.equal(typeof plugin.argumentRuns[method], 'function', `router.${method}`);
  for (const method of ['frame', 'start', 'isRunning']) assert.equal(typeof plugin.argumentRunsV2[method], 'function', `argumentRunsV2.${method}`);
  assert.equal(plugin.argumentRunsV2.isRunning('Nothing.vam'), false);
  plugin.argumentRuns.dispose();
});
