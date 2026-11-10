// Perf 04: the end of a write reads back only the open maps a changed file belongs to. The mock vault reports writes
// the way Obsidian does (before the vault promise resolves), so the plugin collects them while it writes.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, fixture, DEFAULT_SETTINGS, obsidian } = require('./support.cjs');

const { default: Plugin, VisualAgentMapView } = load('main.ts', { obsidian });
const scope = load('core/sync-scope.ts');

function harness() {
  const { app, repo, contents, files } = fixture('en', { linkIndex: true });
  repo.settings = { ...DEFAULT_SETTINGS, language: 'en', cliModel: 'cur-model' };
  const handlers = {};
  app.vault.on = (name, handler) => { handlers[name] = handler; return {}; };
  const emit = (name, ...args) => handlers[name]?.(...args);
  const process = app.vault.process, create = app.vault.create;
  app.vault.process = async (file, change) => { await process(file, change); emit('modify', files.get(file.path)); };
  app.vault.create = async (path, content) => { const file = await create(path, content); emit('create', file); return file; };
  const reads = new Map();
  const realRead = app.vault.read;
  // A hook may replace a read (return a promise) or act after it; `null` falls through to the disk.
  let hook = null;
  app.vault.read = async file => {
    reads.set(file.path, (reads.get(file.path) ?? 0) + 1);
    const hooked = hook?.(file);
    if (hooked) return hooked;
    return realRead(file);
  };
  app.workspace = { getLeavesOfType: () => [] };
  const plugin = new Plugin();
  Object.assign(plugin, { app, repo, settings: repo.settings, registerEvent: () => {}, logs: { appendLog() {} } });
  plugin.scheduleExternalReconciliation = () => {};
  const views = [];
  plugin.views = () => views.filter(view => !view.closed);
  plugin.registerVaultEvents();
  const h = {
    app, repo, contents, files, plugin, views, reads, emit,
    setHook: fn => { hook = fn; },
    readsUnder: folder => [...reads].filter(([path]) => path.startsWith(`${folder}/`)).reduce((sum, [, n]) => sum + n, 0),
    /** A change made outside VAM: the card's summary is rewritten and Obsidian reports it. */
    editOutside: (path, summary) => { contents.set(path, contents.get(path).replace(/(## Current Summary\n\n)[^\n]*/, `$1${summary}`)); emit('modify', files.get(path)); },
    /** A map whose first card is the root of the others. */
    async map(name, titles = ['One', 'Two'], source = 'workspace') {
      const mapPath = await repo.createMap(name);
      const doc = await repo.readMap(mapPath);
      const nodes = [];
      for (const title of titles) {
        const node = await repo.createNote(title, 'model-a', doc, mapPath, source);
        if (nodes.length) node.parentId = nodes[0].id;
        doc.nodes.push(node);
        nodes.push(node);
      }
      await repo.saveMap(mapPath, doc);
      return { mapPath, folder: mapPath.replace(/\/Map\.md$/, ''), nodes };
    },
    async open(mapPath) {
      const view = new VisualAgentMapView({ app: {} }, plugin);
      Object.assign(view, { app, path: mapPath, map: await repo.readMap(mapPath), closed: false, dragging: false });
      Object.assign(view, {
        render() {}, typingInField: () => false, refreshCard() {}, drawEdges() {}, restoreCrossProxies() {}, focusArgumentRootOnce() {},
        updateHistoryButtons() {}, hydrateFailedReportTargets: async () => {}
      });
      await view.hydrate();
      views.push(view);
      return view;
    }
  };
  return h;
}
const noteOf = (view, node) => view.notes.get(node.id);
/** A promise and the function that settles it, for pausing a write at a chosen point. */
const gate = () => { let open; const promise = new Promise(resolve => { open = resolve; }); return { promise, open }; };
const settleQueue = async plugin => { for (let i = 0; i < 5; i++) await plugin.queue; };

test('three open maps: a card change in A reads A whole and nothing of B or C', async () => {
  const h = harness();
  const a = await h.map('Alpha'), b = await h.map('Beta'), c = await h.map('Gamma');
  const [va] = [await h.open(a.mapPath), await h.open(b.mapPath), await h.open(c.mapPath)];
  h.reads.clear();
  await h.plugin.mutate(() => h.repo.updateNote(a.nodes[0].path, { summary: 'changed in A' }));
  assert.equal(h.readsUnder(b.folder), 0, 'B is not read');
  assert.equal(h.readsUnder(c.folder), 0, 'C is not read');
  assert.equal(h.reads.get(a.mapPath), 1, "A's Map.md is read once");
  for (const node of a.nodes) assert.equal(h.reads.get(node.path), 1, 'every note of A is read');
  assert.equal(noteOf(va, a.nodes[0]).summary, 'changed in A');
  for (const view of h.views) assert.ok(view.unsynced.isEmpty());
});

test('an outside change to B while a write of A is paused is read back when the write ends', async () => {
  const h = harness();
  const a = await h.map('Alpha'), b = await h.map('Beta');
  const va = await h.open(a.mapPath), vb = await h.open(b.mapPath);
  const paused = gate(), reached = gate();
  const write = h.plugin.mutate(async () => {
    await h.repo.updateNote(a.nodes[0].path, { summary: 'A write' });
    reached.open();
    await paused.promise;
  });
  await reached.promise;
  h.editOutside(b.nodes[1].path, 'outside B');
  paused.open();
  await write;
  assert.equal(noteOf(va, a.nodes[0]).summary, 'A write');
  assert.equal(noteOf(vb, b.nodes[1]).summary, 'outside B');
});

test("changing an ancestor's model updates the inherited child's note.model and the model a run uses", async () => {
  const h = harness();
  const mapPath = await h.repo.createMap('Tree');
  const doc = await h.repo.readMap(mapPath);
  const root = await h.repo.createNote('Root', 'm1', doc, mapPath, 'manual');
  doc.nodes.push(root);
  const kid = await h.repo.createNote('Kid', 'x', doc, mapPath, 'inherited');
  kid.parentId = root.id;
  doc.nodes.push(kid);
  await h.repo.saveMap(mapPath, doc);
  const other = await h.map('Other');
  const view = await h.open(mapPath);
  await h.open(other.mapPath);
  assert.equal(noteOf(view, kid).model, 'm1');
  h.reads.clear();
  await h.plugin.mutate(() => h.repo.updateNote(root.path, { model: 'm2', reasoning: 'high' }));
  assert.equal(noteOf(view, kid).model, 'm2');
  assert.equal(noteOf(view, kid).reasoning, 'high');
  assert.deepEqual({ ...(await view.modelFor(noteOf(view, kid), kid.path)) }, { model: 'm2', reasoning: 'high' });
  assert.equal(h.readsUnder(other.folder), 0);
});

test('chat batch: writes while held are read back once at release, other maps not at all', async () => {
  const h = harness();
  const a = await h.map('Alpha'), b = await h.map('Beta'), c = await h.map('Gamma');
  const va = await h.open(a.mapPath);
  await h.open(b.mapPath);
  await h.open(c.mapPath);
  va.holdChatBatch();
  h.reads.clear();
  for (const [i, node] of a.nodes.entries()) await h.plugin.mutate(() => h.repo.updateNote(node.path, { summary: `batch ${i}` }));
  assert.equal([...h.reads.values()].reduce((x, y) => x + y, 0), 0, 'nothing is read while held');
  await va.releaseChatBatch();
  assert.deepEqual(a.nodes.map(node => noteOf(va, node).summary), ['batch 0', 'batch 1']);
  assert.equal(h.reads.get(a.mapPath), 1);
  assert.equal(h.readsUnder(b.folder) + h.readsUnder(c.folder), 0);
});

test('chat batch: with two overlapping holds the map is read back when the last one ends', async () => {
  const h = harness();
  const a = await h.map('Alpha'), b = await h.map('Beta');
  const va = await h.open(a.mapPath), vb = await h.open(b.mapPath);
  va.holdChatBatch();
  vb.holdChatBatch();
  h.reads.clear();
  await h.plugin.mutate(() => h.repo.updateNote(a.nodes[0].path, { summary: 'overlap' }));
  await va.releaseChatBatch();
  assert.notEqual(noteOf(va, a.nodes[0]).summary, 'overlap', 'still held by the second batch');
  assert.equal(h.reads.get(a.nodes[0].path) ?? 0, 0);
  await vb.releaseChatBatch();
  assert.equal(noteOf(va, a.nodes[0]).summary, 'overlap');
  assert.equal(h.readsUnder(b.folder), 0);
});

test('chat batch: a write already queued before the release reads back what the batch collected', async () => {
  const h = harness();
  const a = await h.map('Alpha'), b = await h.map('Beta');
  const va = await h.open(a.mapPath);
  await h.open(b.mapPath);
  va.holdChatBatch();
  h.reads.clear();
  await h.plugin.mutate(() => h.repo.updateNote(a.nodes[0].path, { summary: 'held write' }));
  const paused = gate();
  const other = h.plugin.mutate(async () => {
    await paused.promise;
    await h.repo.updateNote(a.nodes[1].path, { summary: 'queued write' });
  });
  const release = va.releaseChatBatch();
  paused.open();
  await Promise.all([other, release]);
  assert.equal(noteOf(va, a.nodes[0]).summary, 'held write');
  assert.equal(noteOf(va, a.nodes[1]).summary, 'queued write');
  assert.equal(h.readsUnder(b.folder), 0);
  assert.ok(va.unsynced.isEmpty());
});

test('chat batch: a file changed while the release reads back is read by one more write', async () => {
  const h = harness();
  const a = await h.map('Alpha'), b = await h.map('Beta');
  const va = await h.open(a.mapPath), vb = await h.open(b.mapPath);
  va.holdChatBatch();
  await h.plugin.mutate(() => h.repo.updateNote(a.nodes[0].path, { summary: 'held write' }));
  let fired = false;
  h.setHook(file => {
    if (fired || file.path !== a.nodes[0].path) return null;
    fired = true;
    h.editOutside(b.nodes[0].path, 'during release');
    return null;
  });
  h.reads.clear();
  await va.releaseChatBatch();
  await settleQueue(h.plugin);
  assert.ok(fired);
  assert.equal(noteOf(va, a.nodes[0]).summary, 'held write');
  assert.equal(noteOf(vb, b.nodes[0]).summary, 'during release');
  assert.equal(h.reads.get(b.mapPath), 1, 'B is read once, by the follow-up');
});

test('unpin all: the first note written before the second throws is read back by the next unrelated write', async () => {
  const h = harness();
  const a = await h.map('Alpha', ['Root', 'One', 'Two']), b = await h.map('Beta');
  const [, first, second] = a.nodes;
  for (const node of [first, second]) await h.repo.writeRelevance(node.path, { tier: 'core', manual: true });
  const va = await h.open(a.mapPath);
  await h.open(b.mapPath);
  assert.equal(noteOf(va, first).relevance?.manual, true);
  const process = h.app.vault.process;
  h.app.vault.process = async (file, change) => {
    if (file.path === second.path) throw new Error('disk full');
    return process(file, change);
  };
  va.unpinAllRelevance();
  await h.plugin.queue;
  h.app.vault.process = process;
  assert.equal(noteOf(va, first).relevance?.manual, true, 'a failed write does not read back');
  assert.ok(va.unsynced.snapshot().paths.has(first.path), 'the written note stays collected');
  h.reads.clear();
  await h.plugin.mutate(async () => {});
  assert.equal(noteOf(va, first).relevance, undefined);
  assert.equal(noteOf(va, second).relevance?.manual, true);
  assert.equal(h.readsUnder(b.folder), 0);
});

test('a read that fails stays collected and the next write reads it again', async () => {
  const h = harness();
  const a = await h.map('Alpha');
  const va = await h.open(a.mapPath);
  let fail = true;
  h.setHook(file => (fail && file.path === a.nodes[0].path ? Promise.reject(new Error('busy')) : null));
  await h.plugin.mutate(() => h.repo.updateNote(a.nodes[0].path, { summary: 'retry me' }));
  assert.ok(va.unsynced.snapshot().paths.has(a.nodes[0].path));
  fail = false;
  await h.plugin.mutate(async () => {});
  assert.equal(noteOf(va, a.nodes[0]).summary, 'retry me');
  assert.ok(va.unsynced.isEmpty());
});

test('an ancestor whose read fails while a child is read back is collected and its manual model comes back', async () => {
  const h = harness();
  const mapPath = await h.repo.createMap('Tree');
  const doc = await h.repo.readMap(mapPath);
  const root = await h.repo.createNote('Root', 'm1', doc, mapPath, 'manual');
  doc.nodes.push(root);
  const kid = await h.repo.createNote('Kid', 'x', doc, mapPath, 'inherited');
  kid.parentId = root.id;
  doc.nodes.push(kid);
  await h.repo.saveMap(mapPath, doc);
  const view = await h.open(mapPath);
  let fail = true;
  h.setHook(file => (fail && file.path === root.path ? Promise.reject(new Error('busy')) : null));
  await h.plugin.mutate(() => h.repo.updateNote(kid.path, { summary: 'kid changed' }));
  assert.equal(noteOf(view, kid).summary, 'kid changed');
  assert.equal(noteOf(view, kid).model, 'cur-model', 'the unreadable ancestor is skipped');
  assert.ok(view.unsynced.snapshot().paths.has(root.path), 'the ancestor was not collected, now it is');
  fail = false;
  await h.plugin.mutate(async () => {});
  assert.equal(noteOf(view, kid).model, 'm1');
  assert.ok(view.unsynced.isEmpty());
});

test('a note changed v1 → v2 while it is read back stays collected and v2 is read after', async () => {
  const h = harness();
  const a = await h.map('Alpha');
  const va = await h.open(a.mapPath);
  const path = a.nodes[0].path;
  let fired = false;
  h.setHook(file => {
    if (fired || file.path !== path) return null;
    fired = true;
    const v1 = h.contents.get(path);
    h.editOutside(path, 'v2');
    return Promise.resolve(v1);
  });
  await h.plugin.mutate(() => h.repo.updateNote(path, { summary: 'v1' }));
  assert.equal(noteOf(va, a.nodes[0]).summary, 'v1');
  assert.ok(va.unsynced.snapshot().paths.has(path), 'v2 arrived after the snapshot');
  await settleQueue(h.plugin);
  assert.equal(noteOf(va, a.nodes[0]).summary, 'v2');
  assert.ok(va.unsynced.isEmpty());
});

test('past 500 collected files the view reads its whole map; a change during that read gets one follow-up', async () => {
  const h = harness();
  const a = await h.map('Alpha');
  const va = await h.open(a.mapPath);
  await h.plugin.mutate(async () => {
    for (let i = 0; i <= scope.UNSYNCED_LIMIT; i++) h.emit('modify', new obsidian.TFile(`Elsewhere/n${i}.md`));
  }, { sync: false });
  assert.notEqual(va.unsynced.snapshot().full, null, 'folded into a full mark');
  let fired = false;
  h.setHook(file => {
    if (fired || file.path !== a.nodes[1].path) return null;
    fired = true;
    h.editOutside(a.nodes[1].path, 'newer');
    return null;
  });
  h.reads.clear();
  await h.plugin.mutate(async () => {});
  assert.notEqual(va.unsynced.snapshot().full, null, 'the change during the read keeps a newer full mark');
  await settleQueue(h.plugin);
  assert.equal(noteOf(va, a.nodes[1]).summary, 'newer');
  assert.ok(va.unsynced.isEmpty());
  assert.equal(h.reads.get(a.mapPath), 2, 'one read-back and one follow-up');
});

test('a note deleted during a write still shows as missing on the map', async () => {
  const h = harness();
  const a = await h.map('Alpha');
  const va = await h.open(a.mapPath);
  const gone = a.nodes[1];
  await h.plugin.mutate(async () => {
    const file = h.files.get(gone.path);
    h.files.delete(gone.path);
    h.contents.delete(gone.path);
    h.emit('delete', file);
  });
  assert.ok(va.map.nodes.some(node => node.id === gone.id), 'the card stays on the map');
  assert.equal(va.notes.has(gone.id), false, 'its note is missing');
  assert.ok(va.unsynced.isEmpty(), 'a missing file is not a failed read');
});

test('changing the current model makes the next write read every open map back', async () => {
  const h = harness();
  const a = await h.map('Alpha'), b = await h.map('Beta');
  const va = await h.open(a.mapPath), vb = await h.open(b.mapPath);
  h.plugin.saveData = async () => {};
  await h.plugin.setCurrentModel('next-model');
  await h.plugin.mutate(async () => {});
  assert.equal(noteOf(va, a.nodes[0]).model, 'next-model');
  assert.equal(noteOf(vb, b.nodes[0]).model, 'next-model');
});

test('changing the current reasoning level in Settings makes the next write read every open map back', async () => {
  const h = harness();
  const a = await h.map('Alpha'), b = await h.map('Beta');
  const va = await h.open(a.mapPath), vb = await h.open(b.mapPath);
  h.plugin.saveData = async () => {};
  assert.notEqual(noteOf(va, a.nodes[0]).reasoning, 'high');
  const { VisualAgentMapSettingTab } = load('main.ts', { obsidian });
  await VisualAgentMapSettingTab.prototype.setControlValue.call({ plugin: h.plugin }, 'cliReasoning', 'high');
  await h.plugin.mutate(async () => {});
  assert.equal(noteOf(va, a.nodes[0]).reasoning, 'high');
  assert.equal(noteOf(vb, b.nodes[0]).reasoning, 'high');
});

test('a model change while a read-back runs is not consumed by it: one follow-up reads the new model', async () => {
  const h = harness();
  const a = await h.map('Alpha');
  const va = await h.open(a.mapPath);
  h.plugin.saveData = async () => {};
  await h.plugin.setCurrentModel('first-model');
  let changed = false;
  h.setHook(file => {
    if (changed || file.path !== a.nodes[1].path) return null;
    changed = true;
    const text = h.contents.get(file.path);
    // The model changes once the first note of this read-back is already parsed with the old one.
    return new Promise(resolve => setTimeout(() => { void h.plugin.setCurrentModel('second-model'); resolve(text); }, 0));
  });
  await h.plugin.mutate(async () => {});
  await settleQueue(h.plugin);
  assert.ok(changed);
  assert.equal(noteOf(va, a.nodes[0]).model, 'second-model');
  assert.ok(va.unsynced.isEmpty());
});

test('a closed view drops what it collected', async () => {
  const h = harness();
  const a = await h.map('Alpha');
  const va = await h.open(a.mapPath);
  va.holdChatBatch();
  await h.plugin.mutate(() => h.repo.updateNote(a.nodes[0].path, { summary: 'x' }));
  assert.equal(va.unsynced.isEmpty(), false);
  await va.onClose();
  assert.ok(va.unsynced.isEmpty());
});

// The pure bookkeeping.
test('sync scope: settle forgets only what the snapshot covered, keeps newer numbers and failed reads', () => {
  const u = new scope.UnsyncedPaths();
  u.add('a', 1); u.add('b', 2);
  const snap = u.snapshot();
  u.add('a', 3);
  u.settle(snap, ['c'], 2);
  assert.equal(JSON.stringify([...u.snapshot().paths]), JSON.stringify([['a', 3], ['c', 2]]));
  // a failed path that already has a newer number keeps it
  const s2 = u.snapshot();
  u.add('c', 4);
  u.settle(s2, ['c'], 4);
  assert.equal(JSON.stringify([...u.snapshot().paths]), JSON.stringify([['c', 4]]));
});

test('sync scope: the full mark is consumed only for the generation it was taken at', () => {
  const u = new scope.UnsyncedPaths();
  for (let i = 0; i <= scope.UNSYNCED_LIMIT; i++) u.add(`p${i}`, i + 1);
  const snap = u.snapshot();
  assert.equal(snap.full, scope.UNSYNCED_LIMIT + 1);
  assert.equal(snap.paths.size, 0);
  u.add('later', 900);
  u.settle(snap, [], 901);
  assert.equal(u.snapshot().full, 900);
  u.settle(u.snapshot(), ['broken'], 902);
  assert.equal(u.snapshot().full, null);
  assert.equal(JSON.stringify([...u.snapshot().paths]), JSON.stringify([['broken', 902]]));
});

test('sync scope: a read-back is needed only for the map file, its notes or a full mark', () => {
  const snap = paths => ({ paths: new Map(paths.map((p, i) => [p, i])), full: null });
  assert.equal(scope.needsReadBack(snap([]), 'M/Map.md', ['M/a.md']), false);
  assert.equal(scope.needsReadBack(snap(['N/x.md']), 'M/Map.md', ['M/a.md']), false);
  assert.equal(scope.needsReadBack(snap(['M/Map.md']), 'M/Map.md', []), true);
  assert.equal(scope.needsReadBack(snap(['M/a.md']), 'M/Map.md', ['M/a.md']), true);
  assert.equal(scope.needsReadBack({ paths: new Map(), full: 3 }, 'M/Map.md', []), true);
});
