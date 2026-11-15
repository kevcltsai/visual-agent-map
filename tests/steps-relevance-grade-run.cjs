// RelevanceGradeRun (experiences/visual-map/relevance-grade-run.ts) on its own: fake plugin and ports, a deferred model call, no real waiting.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./support.cjs');
const { RelevanceGradeRun } = load('experiences/visual-map/relevance-grade-run.ts', { obsidian: {} });
const { t } = load('i18n.ts');

const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
const MAP = 'map.md';

function fakePlugin(options = {}) {
  const calls = { recommend: [], writeRelevance: [], readNote: [], released: 0 };
  const plugin = {
    relevanceGrades: new Map(),
    settings: { language: 'en' },
    logs: { appendLog: () => {} },
    repo: {
      writeRelevanceGoal: async () => ({ previous: undefined, next: undefined, setupChanged: false }),
      restoreRelevanceGoal: async () => {},
      readNote: async path => { calls.readNote.push(path); return options.readNote ? options.readNote(path) : { title: path, relevance: undefined }; },
      writeRelevance: async (path, value) => { calls.writeRelevance.push([path, value]); }
    },
    goalRecommend: { recommend: (request, signal) => new Promise((resolve, reject) => calls.recommend.push({ request, signal, resolve, reject })) },
    currentModelChoice: () => ({ model: 'claude:haiku', reasoning: 'off' }),
    usageNoticePending: () => false,
    confirmAiUsage: options.confirmAiUsage ?? (async (model, callback) => { await callback(); return true; }),
    mutate: fn => fn(),
    releaseWarmClaude: () => { calls.released++; }
  };
  return { plugin, calls };
}

function fakePorts(plugin, state) {
  const log = { pushes: [], opened: [], notices: [], refreshes: 0 };
  const map = { title: 'Map', nodes: [{ id: 'root', path: 'root.md', parentId: null }, { id: 'a', path: 'a.md', parentId: 'root' }] };
  const ports = {
    plugin: () => plugin, path: () => state.path, closed: () => false, map: () => map, notes: () => new Map(),
    history: () => ({ push: entry => log.pushes.push(entry) }), paintCount: () => 0,
    gradeable: () => true, notesLoading: () => false, dropGoalSuggest: () => {}, setGoal: () => {},
    aiGrades: () => [], pins: () => [], describe: id => ({ title: id, summary: '', status: '' }),
    usageMapField: () => ({}), contentLanguage: language => language, lockedParent: () => false,
    refresh: () => { log.refreshes++; }, paintReceived: () => {}, updateHistoryButtons: () => {},
    openRecommendations: (...args) => log.opened.push(args), notice: message => log.notices.push(message)
  };
  return { ports, log };
}

function setup(options = {}) {
  const state = { path: MAP };
  const { plugin, calls } = fakePlugin(options);
  const { ports, log } = fakePorts(plugin, state);
  const owner = {};
  const run = new RelevanceGradeRun(owner, ports);
  return { run, owner, plugin, calls, log, state, ports };
}

test('relevance run: the map is claimed before the first await, so a second start adds no run and no request', async () => {
  const { run, plugin, calls } = setup();
  const first = run.start('Goal');
  const second = run.start('Goal');
  const registered = plugin.relevanceGrades.get(MAP);
  assert.ok(registered);
  assert.equal(run.started, true);
  await second;
  assert.equal(plugin.relevanceGrades.get(MAP), registered);
  await flush();
  assert.equal(calls.recommend.length, 1);
  calls.recommend[0].reject(new Error('end'));
  await first;
});

test('relevance run: Stop while the model works, then the late result writes nothing', async () => {
  const { run, plugin, calls, log } = setup();
  const started = run.start('Goal');
  await flush();
  assert.equal(calls.recommend.length, 1);
  const registered = plugin.relevanceGrades.get(MAP);
  run.stop();
  assert.equal(registered.status, 'stopped');
  assert.equal(registered.message, t('ui.relevance_stopped'));
  assert.equal(registered.controller.signal.aborted, true);
  calls.recommend[0].resolve({ items: [{ id: 'a', tier: 'core' }], suggestions: [{ parentId: 'root', title: 'x' }], dropped: [] });
  await started;
  assert.equal(calls.writeRelevance.length, 0);
  assert.equal(log.pushes.length, 0);
  assert.equal(log.opened.length, 0);
});

test('relevance run: a declined usage notice sends no request and writes no tier', async () => {
  const { run, plugin, calls } = setup({ confirmAiUsage: async () => false });
  await run.start('Goal');
  const registered = plugin.relevanceGrades.get(MAP);
  assert.equal(registered.status, 'declined');
  assert.equal(registered.message, t('ui.relevance_not_started'));
  assert.equal(calls.recommend.length, 0);
  assert.equal(calls.writeRelevance.length, 0);
});

test('relevance run: undo puts back only the note that still holds what the run wrote', async () => {
  const notes = { 'a.md': { relevance: { tier: 'core' } }, 'b.md': { relevance: { tier: 'support' } } };
  const { run, calls, log } = setup({ readNote: path => notes[path] });
  const changes = [
    { id: 'a', path: 'a.md', title: 'A', before: { tier: 'side' }, after: { tier: 'core' } },
    { id: 'b', path: 'b.md', title: 'B', before: { tier: 'side' }, after: { tier: 'core' } }
  ];
  await run.restore(changes, 'undo');
  assert.deepEqual(calls.writeRelevance, [['a.md', { tier: 'side' }]]);
  assert.deepEqual(log.notices, [t('ui.relevance_undo_skipped_0', 1)]);
});

test('relevance run: a view that does not own the run cannot abort it; the owner can', async () => {
  const { plugin, calls, ports } = setup();
  const state = { path: MAP };
  const other = fakePorts(plugin, state).ports;
  const a = new RelevanceGradeRun({}, ports);
  const b = new RelevanceGradeRun({}, other);
  const started = a.start('Goal');
  await flush();
  const registered = plugin.relevanceGrades.get(MAP);
  b.abort(MAP);
  assert.equal(plugin.relevanceGrades.get(MAP), registered);
  assert.equal(registered.controller.signal.aborted, false);
  b.started = true;
  b.abort(MAP);
  assert.equal(plugin.relevanceGrades.get(MAP), registered);
  assert.equal(registered.controller.signal.aborted, false);
  a.abort(MAP);
  assert.equal(plugin.relevanceGrades.has(MAP), false);
  assert.equal(registered.controller.signal.aborted, true);
  calls.recommend[0].reject(new Error('end'));
  await started;
});
