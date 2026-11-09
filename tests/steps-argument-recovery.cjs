// Argument map recovery and wiring (P5b): a reload that leaves a run `running` without an owner pauses it when the map opens, with no
// provider call; maps without the key are untouched; a run this instance owns is left alone. Real main.ts plugin wiring is checked for
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

test('reload with a running run and no owner: paused as interrupted, items pending, no provider call', async () => {
  const h = await harness();
  const before = (await h.repo.readMap(h.mapPath)).argumentMap;
  assert.equal(before.situation.data[0].state, 'searching');
  await h.open();
  const after = (await h.repo.readMap(h.mapPath)).argumentMap;
  assert.equal(after.run.status, 'paused');
  assert.equal(after.run.stopReason, 'interrupted');
  assert.equal(after.situation.data[0].state, 'pending');
  assert.equal(after.run.researchCalls, before.run.researchCalls);
  assert.equal(h.view.map.argumentMap.run.status, 'paused');
  assert.equal(h.calls.provider, 0);
});

test('a map without the argumentMap key is not rewritten', async () => {
  const h = await harness({ withKey: false });
  const before = await h.text();
  await h.open();
  assert.equal(await h.text(), before);
  assert.equal(h.view.map.argumentMap, undefined);
});

test('open: a stacked argument map is arranged once (no overlap, no provider call); opening again writes nothing', async () => {
  const h = await harness({ stacked: true, running: false });
  const before = (await h.repo.readMap(h.mapPath)).nodes;
  assert.equal(new Set(before.map(n => `${n.x},${n.y}`)).size, 1);
  await h.open();
  const after = (await h.repo.readMap(h.mapPath)).nodes;
  assert.ok(new Set(after.map(n => `${n.x},${n.y}`)).size > 1);
  assert.deepEqual(after.map(n => n.id), before.map(n => n.id));
  assert.equal(h.calls.provider, 0);
  const once = await h.text();
  await h.open();
  assert.equal(await h.text(), once);
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

test('an unusable argumentMap key is kept as it is and not paused', async () => {
  const h = await harness();
  await h.repo.updateMap(h.mapPath, doc => { doc.argumentMap = { ...doc.argumentMap, v: 2 }; });
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
