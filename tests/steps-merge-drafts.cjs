// MergeDrafts (experiences/visual-map/merge-drafts.ts) on its own: fake ports, deferred model calls, no real waiting.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, plain } = require('./support.cjs');
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
  const asks = [], changes = [], notices = [], writes = [], checks = [], progress = [], events = [], failed = [];
  const ports = {
    path: () => state.path,
    closed: () => state.closed,
    changed: () => { changes.push(1); },
    language: () => 'en',
    detailTemplate: () => ({}),
    progress: task => ({ observer: { onAttempt: id => events.push([task, id]) }, end: () => progress.push(task) }),
    snapshot: async () => ({ group: { documents: [] }, mapGroups: options.mapGroups ?? [], content: options.contents ? options.contents.shift() : state.content }),
    ask: (context, model, reasoning, signal, observer) => new Promise((resolve, reject) => asks.push({ context, signal, observer, resolve, reject })),
    check: async (task, result) => { checks.push(result); return options.check ? options.check(task, result) : { ok: true, missing: [], added: [] }; },
    recordFailure: (label, error) => `${label}: ${error}`,
    notice: message => { notices.push(message); },
    write: async (...args) => { writes.push(args); if (options.write) await options.write(...args); },
    failed: task => { failed.push(task); }
  };
  const drafts = new MergeDrafts(ports);
  return { drafts, state, asks, changes, notices, writes, checks, progress, events, failed };
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

test('merge drafts: after a written AI merge the view is told to repaint once more (the book bar counts follow the merged map)', async () => {
  let atWrite = -1;
  const w = world({ write: async () => { atWrite = w.changes.length; w.drafts.forget('map.md', task); } });
  const task = newTask('map.md');
  w.drafts.start(task, () => {});
  await flush();
  w.asks[0].resolve(RESULT);
  await task.run;
  assert.equal(w.writes.length, 1);
  assert.equal(w.changes.length, atWrite + 1, 'a repaint after the write returned, with the task already gone');
  assert.equal(w.drafts.has('map.md'), false);
});

test('merge drafts: Stop during a preservation check prevents both repair and write', async () => {
  for (const ok of [true, false]) {
    let finishCheck;
    const w = world({ check: () => new Promise(resolve => { finishCheck = resolve; }) });
    const task = newTask('map.md');
    w.drafts.start(task, () => {});
    await flush();
    w.asks[0].resolve(RESULT);
    await flush();
    assert.equal(w.checks.length, 1);
    w.drafts.stop(task);
    assert.deepEqual(w.progress, [task], 'progress is released before the check returns');
    finishCheck({ ok, missing: [], added: [] });
    await flush();
    assert.equal(w.asks.length, 1, 'no repair request after Stop');
    await task.run;
    assert.equal(w.writes.length, 0);
    assert.deepEqual(w.progress, [task], 'progress ended exactly once');
    assert.deepEqual(w.notices, []);
  }
});

test('merge drafts: replacing a running task cancels its progress and suppresses obsolete observer and error events', async () => {
  const w = world();
  const old = w.drafts.start(newTask('map.md'), () => {});
  await flush();
  const next = w.drafts.start(newTask('map.md'), () => {});
  await flush();
  assert.equal(old.controller.signal.aborted, true);
  assert.deepEqual(w.progress, [old]);
  assert.equal(w.drafts.tasks.get('map.md'), next);
  w.asks[0].observer.onAttempt('obsolete', 1);
  w.asks[1].observer.onAttempt('current', 1);
  assert.deepEqual(w.events, [[next, 'current']]);
  const before = w.changes.length;
  w.asks[0].reject(new Error('late'));
  await old.run;
  assert.equal(w.changes.length, before);
  assert.deepEqual(w.notices, []);
  w.asks[1].resolve(RESULT);
  await next.run;
  assert.equal(w.writes.length, 1);
  assert.deepEqual(w.progress, [old, next]);
  assert.equal(w.drafts.has('map.md'), false);
});

test('merge drafts: stopping during registration never starts a snapshot or progress', async () => {
  const w = world();
  const task = newTask('map.md');
  w.drafts.start(task, () => w.drafts.stop(task));
  await task.run;
  assert.deepEqual(w.asks, []);
  assert.deepEqual(w.progress, []);
  assert.equal(w.drafts.has('map.md'), false);
});

// V3.3 #03: a merge whose content check still fails after the one repair writes nothing and keeps the draft in memory.
const FAILING = { ok: false, missing: ['42'], added: ['99'] };
const failedRun = async (ids = ['a', 'b']) => {
  const w = world({ check: () => FAILING });
  const task = newTask('map.md', ids);
  w.drafts.start(task, () => {});
  await flush();
  w.asks[0].resolve(RESULT);
  await flush();
  w.asks[1].resolve({ ...RESULT, detail: 'repaired detail' });
  await task.run;
  return { w, task };
};

test('merge drafts: a check that still fails after the one repair writes nothing, releases the lock and keeps the draft', async () => {
  const { w, task } = await failedRun();
  assert.equal(w.asks.length, 2, 'the merge and exactly one repair request, never a second one');
  assert.equal(w.writes.length, 0, 'the write port is never called');
  assert.equal(task.state, 'draft-failed');
  assert.deepEqual(task.check, FAILING);
  assert.equal(task.draft.summary, RESULT.summary);
  assert.equal(w.drafts.has('map.md'), false, 'the merge lock is released');
  assert.equal(w.drafts.isMerging('a'), false);
  assert.equal(w.drafts.failedDraft, task, 'the draft stays in memory');
  assert.deepEqual(w.failed, [task], 'the view is told once');
  assert.deepEqual(w.progress, [task], 'progress ended exactly once');
  assert.deepEqual(w.notices, [], 'the failure Notice is the view\'s, not the stale or error one');
  await flush();
  assert.equal(w.asks.length, 2, 'nothing is retried by itself');
});

test('merge drafts: the kept draft is dropped by a new merge of the same cards or by closing; another group keeps it', async () => {
  const { w, task } = await failedRun();
  const other = w.drafts.start(newTask('map.md', ['c', 'd']), () => {});
  assert.equal(w.drafts.failedDraft, task, 'a merge of other cards keeps it');
  w.drafts.stop(other);
  const again = w.drafts.start(newTask('map.md', ['b', 'a']), () => {});
  assert.equal(w.drafts.failedDraft, undefined, 'merging the same cards again drops it');
  w.drafts.stop(again);
  const second = await failedRun();
  second.w.drafts.stopAll();
  assert.equal(second.w.drafts.failedDraft, undefined, 'closing the view drops it');
  const third = await failedRun();
  third.w.drafts.dropFailed();
  assert.equal(third.w.drafts.failedDraft, undefined, 'switching maps drops it');
});

test('merge drafts: a failed repair request keeps the first draft and still writes nothing', async () => {
  const w = world({ check: () => FAILING });
  const task = newTask('map.md');
  w.drafts.start(task, () => {});
  await flush();
  w.asks[0].resolve(RESULT);
  await flush();
  w.asks[1].reject(new Error('provider down'));
  await task.run;
  assert.equal(w.asks.length, 2);
  assert.equal(w.writes.length, 0);
  assert.equal(task.state, 'draft-failed');
  assert.equal(task.draft, RESULT, 'the first draft is kept');
  assert.deepEqual(w.failed, [task]);
});

test('merge drafts (V3.3 #04): the chat turn\'s attachments join the map sources in the supplement request only; none of either asks once', async () => {
  const mapGroup = { id: 'map-source', name: 'Map sources', location: '', documents: [{ path: 'S.md', content: 's' }] };
  const turnGroup = { id: 'chat-references', name: 'Chat references', location: '', documents: [{ path: 'N.md', content: 'n' }] };
  for (const [mapGroups, referenceGroups, expected] of [[[mapGroup], [turnGroup], [mapGroup, turnGroup]], [[], [turnGroup], [turnGroup]], [[mapGroup], undefined, [mapGroup]], [[], [], null]]) {
    const w = world({ mapGroups });
    const task = { ...newTask('map.md'), ...(referenceGroups ? { referenceGroups } : {}) };
    w.drafts.start(task, () => {});
    await flush();
    w.asks[0].resolve(RESULT);
    await flush();
    assert.deepEqual(plain(w.asks[0].context.referenceGroups), [{ documents: [] }], 'the merged text is written from the cards only');
    if (expected) {
      assert.equal(w.asks.length, 2);
      assert.deepEqual(plain(w.asks[1].context.referenceGroups), expected);
      w.asks[1].resolve({ ...RESULT, detail: 'supplement' });
    } else assert.equal(w.asks.length, 1, 'no sources and no attachments: no supplement request');
    await task.run;
    assert.equal(w.writes.length, 1);
  }
});
