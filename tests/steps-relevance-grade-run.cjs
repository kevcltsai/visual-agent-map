// RelevanceGradeRun (experiences/visual-map/relevance-grade-run.ts) on its own: fake plugin and ports, a deferred model call, no real waiting.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./support.cjs');
const { RelevanceGradeRun } = load('experiences/visual-map/relevance-grade-run.ts', { obsidian: {} });
const { t } = load('i18n.ts');

const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
const MAP = 'map.md';

function fakePlugin(options = {}) {
  const calls = { recommend: [], writeRelevance: [], readNote: [], goals: [], usage: 0, released: 0 };
  const plugin = {
    relevanceGrades: new Map(),
    settings: { language: 'en' },
    logs: { appendLog: () => {} },
    repo: {
      writeRelevanceGoal: async (...args) => { calls.goals.push(args); return options.writeGoal ? options.writeGoal(...args) : { previous: undefined, next: undefined, setupChanged: false }; },
      restoreRelevanceGoal: async () => {},
      readNote: async path => { calls.readNote.push(path); return options.readNote ? options.readNote(path) : { title: path, relevance: undefined }; },
      writeRelevance: async (path, value) => { calls.writeRelevance.push([path, value]); }
    },
    goalRecommend: { recommend: (request, signal) => new Promise((resolve, reject) => calls.recommend.push({ request, signal, resolve, reject })) },
    currentModelChoice: () => ({ model: 'claude:haiku', reasoning: 'off' }),
    usageNoticePending: () => false,
    confirmAiUsage: async (model, callback) => { calls.usage++; return options.confirmAiUsage ? options.confirmAiUsage(model, callback) : (await callback(), true); },
    mutate: options.mutate ?? (fn => fn()),
    releaseWarmClaude: () => { calls.released++; }
  };
  return { plugin, calls };
}

function fakePorts(plugin, state) {
  const log = { pushes: [], opened: [], notices: [], goals: [], refreshes: 0 };
  const map = { title: 'Map', nodes: [{ id: 'root', path: 'root.md', parentId: null }, { id: 'a', path: 'a.md', parentId: 'root' }] };
  const ports = {
    plugin: () => plugin, path: () => state.path, closed: () => !!state.closed, map: () => state.map ?? map, notes: () => new Map(),
    history: () => ({ push: entry => log.pushes.push(entry) }), paintCount: () => 0,
    gradeable: () => true, notesLoading: () => false, dropGoalSuggest: () => {}, setGoal: (...args) => log.goals.push(args),
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

const answer = () => ({ items: [{ id: 'a', tier: 'core' }], suggestions: [{ parentId: 'root', title: 'New' }], dropped: [] });

test('relevance run: Stop before the queued goal write skips the write and usage confirmation', async () => {
  let queued;
  const w = setup({ mutate: fn => new Promise(resolve => { queued = async () => { await fn(); resolve(); }; }) });
  const pending = w.run.start('Goal');
  w.run.stop();
  await queued();
  await pending;
  assert.equal(w.calls.goals.length, 0);
  assert.equal(w.calls.usage, 0);
  assert.deepEqual(w.log.goals, []);
});

test('relevance run: Stop during the goal write preserves its undo step but skips confirmation', async () => {
  let finish;
  const w = setup({ writeGoal: () => new Promise(resolve => { finish = resolve; }) });
  const pending = w.run.start('Goal');
  w.run.stop();
  finish({ previous: undefined, next: 'Goal', setupChanged: true });
  await pending;
  assert.equal(w.calls.usage, 0);
  assert.equal(w.log.pushes.length, 1);
  assert.equal(w.calls.released, 1);
});

test('relevance run: Stop before queued grading apply produces neither writes nor late UI callbacks', async () => {
  let queued, count = 0;
  const w = setup({ mutate: fn => ++count === 1 ? fn() : new Promise(resolve => { queued = async () => { await fn(); resolve(); }; }) });
  const pending = w.run.start('Goal');
  await flush();
  w.calls.recommend[0].resolve(answer());
  await flush();
  w.run.stop();
  const before = w.log.refreshes;
  await queued();
  await pending;
  assert.equal(w.calls.writeRelevance.length, 0);
  assert.equal(w.log.refreshes, before);
  assert.deepEqual(w.log.opened, []);
});

test('relevance run: closing during preparation cannot read or write the replacement map', async () => {
  let finishRead;
  const w = setup({ readNote: () => new Promise(resolve => { finishRead = resolve; }) });
  const pending = w.run.start('Goal');
  await flush();
  w.calls.recommend[0].resolve(answer());
  await flush();
  assert.deepEqual(w.calls.readNote, ['root.md']);
  w.run.abort(MAP);
  w.state.closed = true;
  w.state.path = 'other.md';
  w.state.map = { title: 'Other', nodes: [{ id: 'a', path: 'other-a.md', parentId: 'root' }] };
  const before = w.log.refreshes;
  finishRead({ title: 'root' });
  await flush();
  assert.deepEqual(w.calls.readNote, ['root.md']);
  await pending;
  assert.deepEqual(w.calls.writeRelevance, []);
  assert.deepEqual(w.log.pushes, []);
  assert.equal(w.log.refreshes, before);
  assert.deepEqual(w.log.opened, []);
});

test('relevance run: normal completion writes the tier and never releases another warm process on departure', async () => {
  const w = setup({ readNote: path => ({ title: path.replace('.md', '') }) });
  const pending = w.run.start('Goal');
  await flush();
  w.calls.recommend[0].resolve(answer());
  await pending;
  assert.deepEqual(w.calls.writeRelevance, [['a.md', { tier: 'core' }]]);
  assert.equal(w.log.pushes.length, 1);
  assert.equal(w.log.opened.length, 1);
  assert.equal(w.plugin.relevanceGrades.get(MAP).status, 'done');
  w.run.abort(MAP);
  assert.equal(w.plugin.relevanceGrades.has(MAP), false);
  assert.equal(w.calls.released, 0);
});
