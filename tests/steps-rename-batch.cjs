// Perf ticket 10: the rename events of one folder rename are handled as one batch. The first event queues the batch at
// once; events that arrive before it starts join it; the batch rewrites source paths in one pass, scans the maps once,
// rebuilds derived data at most once and leaves the read-back to the views' scoped synchronize.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, fixture, DEFAULT_SETTINGS, obsidian } = require('./support.cjs');

const quiet = { ...obsidian, Notice: class { setMessage() {} hide() {} } };
const { default: Plugin, VisualAgentMapView } = load('main.ts', { obsidian: quiet });
const batch = load('core/rename-batch.ts');
const { rebaseMapNotePaths } = load('repository.ts', { obsidian: quiet });

function harness() {
  const { app, repo, contents, files } = fixture('en', { linkIndex: true });
  repo.settings = { ...DEFAULT_SETTINGS, language: 'en', cliModel: 'cur-model' };
  const handlers = {};
  app.vault.on = (name, handler) => { handlers[name] = handler; return {}; };
  const emit = (name, ...args) => handlers[name]?.(...args);
  const process = app.vault.process;
  // A hook may make a write throw before it reaches the disk.
  let failWrite = null;
  app.vault.process = async (file, change) => {
    if (failWrite?.(file)) throw new Error(`injected write failure ${file.path}`);
    await process(file, change);
    emit('modify', files.get(file.path));
  };
  // Obsidian reports each moved file of a renamed folder, one event per file, before the rename resolves.
  const reportingRename = rename => async (item, target) => {
    const from = item.path;
    const moved = [...files.entries()].filter(([path, file]) => file instanceof obsidian.TFile && (path === from || path.startsWith(`${from}/`)));
    await rename(item, target);
    for (const [old, file] of moved) emit('rename', file, old);
  };
  // Moves without reporting (the body of the fixture's rename runs synchronously), for tests that emit events themselves.
  const silentRename = app.vault.rename;
  app.vault.rename = reportingRename(app.vault.rename);
  app.fileManager.renameFile = reportingRename(app.fileManager.renameFile);
  app.workspace = { getLeavesOfType: () => [], requestSaveLayout() {} };
  const plugin = new Plugin();
  const logged = [];
  Object.assign(plugin, { app, repo, settings: repo.settings, registerEvent: () => {}, logs: { appendLog: (level, text) => logged.push([level, text]) }, saveData: async () => {} });
  plugin.scheduleExternalReconciliation = () => {};
  const counts = { traversals: 0, scans: 0, syncs: 0, hydrates: 0, rebuilds: 0, batches: 0 };
  plugin.rebuildDerivedData = async () => { counts.rebuilds++; };
  const markedFiles = repo.markedFiles.bind(repo);
  repo.markedFiles = async key => { if (key === 'agent-map-node') counts.traversals++; return markedFiles(key); };
  const readableMaps = repo.readableMaps.bind(repo);
  repo.readableMaps = async () => { counts.scans++; return readableMaps(); };
  const mutate = plugin.mutate.bind(plugin);
  plugin.mutate = (work, options) => { counts.batches++; return mutate(work, options); };
  const views = [];
  plugin.views = () => views.filter(view => !view.closed);
  repo.onUnreadableMaps = failures => plugin.reportUnreadableMaps(failures);
  plugin.registerVaultEvents();
  return {
    app, repo, files, contents, plugin, counts, logged, emit,
    failWrites: fn => { failWrite = fn; },
    moveSilently: (from, to) => { const file = files.get(from); void silentRename(file, to); return file; },
    reset() { for (const key of Object.keys(counts)) counts[key] = 0; },
    async map(name, cards = 1) {
      const mapPath = await repo.createMap(name);
      const doc = await repo.readMap(mapPath);
      for (let i = 0; i < cards; i++) doc.nodes.push(await repo.createNote(`Card ${i + 1}`, 'model-a', doc, mapPath, 'workspace'));
      await repo.saveMap(mapPath, doc);
      return mapPath;
    },
    async open(mapPath) {
      const view = new VisualAgentMapView({ app: {} }, plugin);
      Object.assign(view, { app, path: mapPath, map: await repo.readMap(mapPath), closed: false, dragging: false });
      Object.assign(view, {
        render() {}, typingInField: () => false, refreshCard() {}, drawEdges() {}, restoreCrossProxies() {}, focusArgumentRootOnce() {},
        updateHistoryButtons() {}, hydrateFailedReportTargets: async () => {}, aimActiveForPath: () => false, resolveMapConflict: async () => false
      });
      await view.hydrate();
      const hydrate = view.hydrate.bind(view), synchronize = view.synchronize.bind(view);
      view.hydrate = (...args) => { counts.hydrates++; return hydrate(...args); };
      view.synchronize = (...args) => { counts.syncs++; return synchronize(...args); };
      views.push(view);
      return view;
    }
  };
}
const plain = value => JSON.parse(JSON.stringify(value));
const settle = async plugin => { for (let i = 0; i < 8; i++) await plugin.queue; };
const folderOf = mapPath => mapPath.replace(/\/Map\.md$/, '');
const allUnder = (map, folder) => map.nodes.every(node => node.path.startsWith(`${folder}/`));

test('rename-batch: moves apply in event order; a chain follows and a rollback ends where it started', () => {
  assert.equal(batch.rebasePath([['A', 'B'], ['B', 'C']], 'A'), 'C');
  assert.equal(batch.rebasePath([['B', 'C'], ['A', 'B']], 'A'), 'B', 'pairs are not sorted');
  assert.equal(batch.rebasePath([['A', 'B'], ['B', 'A']], 'A'), 'A', 'a rolled-back move is not merged away');
  assert.equal(batch.rebasePath([], 'A'), 'A');
  const map = { nodes: [{ path: 'A' }, { path: 'X' }, { path: 'B' }] };
  assert.equal(rebaseMapNotePaths(map, batch.chainRebase([['A', 'B'], ['B', 'C']])), true);
  assert.deepEqual(map.nodes.map(node => node.path), ['C', 'X', 'C']);
  assert.equal(rebaseMapNotePaths(map, batch.chainRebase([['A', 'B']])), false, 'nothing named A any more');
  assert.equal(rebaseMapNotePaths(map, batch.chainRebase([])), false);
});

test('rename-batch: path lists change only where an old path is named', () => {
  assert.deepEqual(plain(batch.rebasePathList(['n/a.md', 'other.md'], [['n/a.md', 'm/a.md'], ['m/a.md', 'z/a.md']])), ['z/a.md', 'other.md']);
  assert.equal(batch.rebasePathList(['other.md'], [['n/a.md', 'm/a.md']]), null);
  assert.equal(batch.rebasePathList(['n/a.md'], [['n/a.md', 'm/a.md'], ['m/a.md', 'n/a.md']]), null, 'moved and moved back');
  assert.equal(batch.mentionsOldPath(undefined, [['a', 'b']]), false);
  assert.equal(batch.mentionsOldPath(['a'], [['a', 'a']]), false, 'a move to the same path names nothing');
  assert.deepEqual(plain(batch.touchedPaths([['a', 'b'], ['b', 'c']])), ['a', 'b', 'c']);
});

test('a folder rename of 50 files runs one batch: one traversal, one scan, one rebuild, one read-back per view', async () => {
  const h = harness();
  const mapPath = await h.map('Alpha', 49);
  const view = await h.open(mapPath);
  view.history.push({ label: 'earlier', undo: async () => {}, redo: async () => {} });
  const folder = folderOf(mapPath), moved = `${folder} renamed`;
  const events = [...h.files.keys()].filter(path => path.startsWith(`${folder}/`) && path.endsWith('.md')).length;
  assert.equal(events, 50);
  h.reset();
  await h.app.fileManager.renameFile(h.files.get(folder), moved);
  await settle(h.plugin);
  console.log(`rename-batch counts for ${events} events: ${JSON.stringify(h.counts)}`);
  assert.deepEqual(h.counts, { traversals: 1, scans: 1, syncs: 1, hydrates: 1, rebuilds: 1, batches: 1 });
  assert.equal(view.path, `${moved}/Map.md`);
  assert.ok(allUnder(view.map, moved), 'the open map points at the moved cards');
  assert.equal(view.notes.size, 49, 'every card is read back from the new folder');
  assert.ok(allUnder(await h.repo.readMap(`${moved}/Map.md`), moved), 'Map.md on disk points at the moved cards');
  assert.equal(view.history.canUndo, false, 'an outside rename clears the steps, as before');
});

test('rename events that arrive before the batch starts join it; a later one opens a new batch', async () => {
  const h = harness();
  const a = await h.map('Alpha', 2);
  const view = await h.open(a);
  const cards = view.map.nodes.map(node => node.path);
  const moved = cards.map(path => path.replace(/\.md$/, ' 1.md'));
  const move = (from, to) => h.emit('rename', h.moveSilently(from, to), from);
  h.reset();
  // Two outside renames in one turn: the second arrives while the first batch is only queued.
  move(cards[0], moved[0]);
  move(cards[1], moved[1]);
  await settle(h.plugin);
  assert.equal(h.counts.batches, 1, 'one batch for both');
  assert.equal(h.counts.scans, 1);
  assert.equal(h.counts.traversals, 1);
  assert.deepEqual(view.map.nodes.map(node => node.path), moved);
  // A rename while the batch already runs starts the next batch, and a chain A→B→A within it ends where it started.
  h.reset();
  let during = false;
  const save = h.repo.saveMap.bind(h.repo);
  h.repo.saveMap = async (...args) => {
    await save(...args);
    if (!during) { during = true; move(moved[0], cards[0]); }
  };
  move(moved[1], cards[1]);
  await settle(h.plugin);
  assert.equal(during, true);
  assert.equal(h.counts.batches, 2, 'the event during the batch opens a new one');
  assert.deepEqual(view.map.nodes.map(node => node.path), cards);
  assert.deepEqual((await h.repo.readMap(a)).nodes.map(node => node.path), cards);
  // Moved there and back before the batch starts: the batch applies both, in order.
  h.reset();
  move(cards[0], moved[0]);
  move(moved[0], cards[0]);
  await settle(h.plugin);
  assert.equal(h.counts.batches, 1);
  assert.deepEqual((await h.repo.readMap(a)).nodes.map(node => node.path), cards, 'a rolled-back move leaves the map as it was');
  assert.deepEqual(view.map.nodes.map(node => node.path), cards);
});

test('a map operation queued after the rename callback, before the batch runs, sees the moved paths', async () => {
  const h = harness();
  const a = await h.map('Alpha', 2);
  const view = await h.open(a);
  const cards = view.map.nodes.map(node => node.path);
  const moved = cards.map(path => path.replace(/\.md$/, ' moved.md'));
  // Obsidian has moved both files. The first event queues the batch, another operation is queued behind it, and the
  // second event arrives before either has started: all in one turn of the event loop.
  const fileA = h.moveSilently(cards[0], moved[0]), fileB = h.moveSilently(cards[1], moved[1]);
  h.emit('rename', fileA, cards[0]);
  let seen = null;
  const op = h.plugin.mutate(async () => { seen = (await h.repo.readMap(a)).nodes.map(node => node.path); });
  h.emit('rename', fileB, cards[1]);
  await op;
  await settle(h.plugin);
  assert.deepEqual(seen, moved, 'the queued operation reads the map with both moves applied');
  assert.deepEqual(view.map.nodes.map(node => node.path), moved);
});

test('a rename whose first map save fails still leaves Map.md and the view at the moved paths', async () => {
  const h = harness();
  const mapPath = await h.map('Alpha', 3);
  const view = await h.open(mapPath);
  const folder = folderOf(mapPath), moved = `${folder} renamed`;
  let failures = 0;
  h.failWrites(file => file.path.endsWith('/Map.md') && failures++ === 0);
  await h.app.fileManager.renameFile(h.files.get(folder), moved);
  await settle(h.plugin);
  assert.equal(failures > 1, true, 'the first save failed and another was tried');
  assert.ok(allUnder(await h.repo.readMap(`${moved}/Map.md`), moved), 'Map.md on disk follows the move');
  assert.equal(view.path, `${moved}/Map.md`);
  assert.ok(allUnder(view.map, moved));
  assert.equal(view.notes.size, 3);
});

test('an open Map.md renamed outside while the batch runs stays open at its new path', async () => {
  const h = harness();
  const a = await h.map('Alpha', 2), b = await h.map('Beta', 2);
  const va = await h.open(a), vb = await h.open(b);
  const folderA = folderOf(a), movedA = `${folderA} renamed`;
  const folderB = folderOf(b), movedB = `${folderB} renamed`;
  let during = false;
  const save = h.repo.saveMap.bind(h.repo);
  h.repo.saveMap = async (...args) => {
    await save(...args);
    if (!during) { during = true; await h.app.fileManager.renameFile(h.files.get(folderB), movedB); }
  };
  await h.app.fileManager.renameFile(h.files.get(folderA), movedA);
  await settle(h.plugin);
  assert.equal(during, true);
  assert.equal(va.path, `${movedA}/Map.md`);
  assert.equal(vb.path, `${movedB}/Map.md`, 'the other view follows its Map.md');
  assert.ok(vb.map, 'and keeps it open');
  assert.ok(allUnder(vb.map, movedB));
  assert.equal(vb.notes.size, 2);
  assert.ok(allUnder(await h.repo.readMap(`${movedB}/Map.md`), movedB));
});

test('a folder rename while a chat batch holds the views is read back correctly on release', async () => {
  const h = harness();
  const a = await h.map('Alpha', 3);
  const view = await h.open(a);
  const folder = folderOf(a), moved = `${folder} renamed`;
  view.holdChatBatch();
  h.reset();
  await h.app.fileManager.renameFile(h.files.get(folder), moved);
  await settle(h.plugin);
  assert.equal(h.counts.hydrates, 0, 'nothing is read back while the views are held');
  assert.equal(view.path, `${moved}/Map.md`);
  assert.ok(allUnder(view.map, moved), 'the held map already points at the moved cards');
  // A card changed outside meanwhile: the read-back on release must see it.
  const card = view.map.nodes[0];
  await h.repo.updateNote(card.path, { summary: 'changed during the hold' });
  await view.releaseChatBatch();
  await settle(h.plugin);
  assert.ok(h.counts.hydrates >= 1, 'released: the map is read back');
  assert.equal(view.notes.size, 3);
  for (const node of view.map.nodes) assert.ok(view.notes.get(node.id), node.path);
  assert.equal(view.notes.get(card.id).summary, 'changed during the hold');
  assert.ok(allUnder(await h.repo.readMap(`${moved}/Map.md`), moved));
});

test('a damaged Map.md is still skipped and reported during a batch; the other maps follow', async () => {
  const h = harness();
  const a = await h.map('Alpha', 2), broken = await h.map('Broken', 1);
  const view = await h.open(a);
  h.contents.set(broken, h.contents.get(broken).replace(/```agent-map\s*\n[\s\S]*?\n```/, '```agent-map\n{ not json\n```'));
  const brokenBefore = h.contents.get(broken);
  const folder = folderOf(a), moved = `${folder} renamed`;
  await h.app.fileManager.renameFile(h.files.get(folder), moved);
  await settle(h.plugin);
  assert.equal(h.contents.get(broken), brokenBefore, 'the damaged map is never written');
  assert.ok(h.logged.some(([level, text]) => level === 'warn' && text.includes(broken)), 'and it is reported');
  assert.ok(allUnder(await h.repo.readMap(`${moved}/Map.md`), moved));
  assert.ok(allUnder(view.map, moved));
});
