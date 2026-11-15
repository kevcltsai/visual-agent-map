// MergeDrafts (experiences/visual-map/merge-drafts.ts) on its own: fake ports, deferred model calls, no real waiting.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./support.cjs');
const { MergeDrafts } = load('experiences/visual-map/merge-drafts.ts', { obsidian: {} });
const { t } = load('i18n.ts');

const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
const RESULT = { summary: 'merged summary', detail: 'merged detail', suggestions: [] };

function newTask(mapPath, ids = ['a', 'b']) {
  return {
    mapPath, mapId: 'm', mapTitle: 'Map', title: 'First', sources: ids.map(id => ({ id, path: `${id}.md` })),
    parentId: null, targetId: null, model: 'claude:haiku', reasoning: 'off', sourceContent: '',
    controller: new AbortController(), state: 'running'
  };
}

function world(options = {}) {
  const state = { closed: false, path: 'map.md', content: 'same' };
  const asks = [], changes = [], notices = [], writes = [], checks = [];
  const ports = {
    path: () => state.path,
    closed: () => state.closed,
    changed: () => { changes.push(1); },
    language: () => 'en',
    detailTemplate: () => ({}),
    progress: () => ({ observer: undefined, end: () => {} }),
    snapshot: async () => ({ group: { documents: [] }, mapGroups: [], content: options.contents ? options.contents.shift() : state.content }),
    ask: (context, model, reasoning, signal) => new Promise((resolve, reject) => asks.push({ context, signal, resolve, reject })),
    check: async (task, result) => { checks.push(result); return { ok: true, missing: [], added: [] }; },
    recordFailure: (label, error) => `${label}: ${error}`,
    notice: message => { notices.push(message); },
    write: async (...args) => { writes.push(args); if (options.write) await options.write(...args); }
  };
  const drafts = new MergeDrafts(ports);
  return { drafts, state, asks, changes, notices, writes, checks };
}

test('merge drafts: Stop while the model works forgets the task, and the late result writes and says nothing', async () => {
  const w = world();
  const task = newTask('map.md');
  w.drafts.start(task, () => {});
  await flush();
  assert.equal(w.asks.length, 1);
  assert.equal(w.drafts.has('map.md'), true);
  const before = w.changes.length;
  w.drafts.stop(task);
  assert.equal(w.drafts.tasks.size, 0);
  assert.equal(task.controller.signal.aborted, true);
  assert.equal(w.changes.length, before + 1, 'the view is told to render');
  w.asks[0].resolve(RESULT);
  await task.run;
  assert.equal(w.checks.length, 0);
  assert.equal(w.writes.length, 0);
  assert.deepEqual(w.notices, []);
});

test('merge drafts: the AI lock only fences the write - the task is forgotten, one lock Notice, nothing aborted', async () => {
  // The lock check is `instanceof Error` inside the module's own vm realm, so the error comes from that realm's Error.
  const RealmError = new MergeDrafts.constructor('return Error')();
  const locked = new RealmError('AI lock: the topic is locked');
  locked.name = 'AiLockedError';
  const w = world({ write: async () => { throw locked; } });
  const task = newTask('map.md');
  w.drafts.start(task, () => {});
  await flush();
  w.asks[0].resolve(RESULT);
  await task.run;
  assert.equal(w.writes.length, 1);
  assert.equal(task.state, 'applying');
  assert.equal(w.drafts.tasks.size, 0);
  assert.deepEqual(w.notices, [t('ui.ai_locked_notice')]);
  assert.equal(task.controller.signal.aborted, false);
});

test('merge drafts: a source that changed while the model worked is not written, the stale Notice shows', async () => {
  const w = world({ contents: ['one', 'two'] });
  const task = newTask('map.md');
  w.drafts.start(task, () => {});
  await flush();
  w.asks[0].resolve(RESULT);
  await task.run;
  assert.equal(w.writes.length, 0);
  assert.deepEqual(w.notices, [t('ui.merge_draft_stale')]);
  assert.equal(w.drafts.tasks.size, 0);
});

test('merge drafts: isMerging counts only this map and honours except; stopAll aborts every task, then clears', async () => {
  const w = world();
  const here = newTask('map.md', ['a', 'b']);
  const other = newTask('other.md', ['c']);
  w.drafts.start(here, () => {});
  w.drafts.start(other, () => {});
  await flush();
  assert.equal(w.drafts.isMerging('a'), true);
  assert.equal(w.drafts.isMerging('c'), false, 'a card of another map is not locked here');
  assert.equal(w.drafts.isMerging('a', here), false, 'except leaves the given task out');
  assert.equal(w.drafts.isRunning(), true);
  w.drafts.stopAll();
  assert.equal(here.controller.signal.aborted && other.controller.signal.aborted, true);
  assert.equal(w.drafts.isRunning(), false);
  assert.equal(w.drafts.isMerging('a'), false);
  for (const a of w.asks) a.resolve(RESULT);
  await flush();
  assert.equal(w.writes.length, 0);
});
