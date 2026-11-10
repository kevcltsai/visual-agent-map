// Ticket 09: a rename event that arrives while VAM writes moves the open map's path only (followPath); the read-back at
// the end of the write then finds the map instead of closing it. relocate() still clears the undo steps after a
// folder-setting move, and a VAM rename (renameMapTo) keeps them.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, fixture, DEFAULT_SETTINGS, obsidian } = require('./support.cjs');

const quiet = { ...obsidian, Notice: class { setMessage() {} hide() {} } };
const { default: Plugin, VisualAgentMapView } = load('main.ts', { obsidian: quiet });

function harness() {
  const { app, repo, contents, files } = fixture('en', { linkIndex: true });
  repo.settings = { ...DEFAULT_SETTINGS, language: 'en', cliModel: 'cur-model' };
  const handlers = {};
  app.vault.on = (name, handler) => { handlers[name] = handler; return {}; };
  const emit = (name, ...args) => handlers[name]?.(...args);
  const process = app.vault.process;
  app.vault.process = async (file, change) => { await process(file, change); emit('modify', files.get(file.path)); };
  // Obsidian reports each moved file of a renamed folder before the rename resolves.
  const reportingRename = rename => async (item, target) => {
    const from = item.path;
    const moved = [...files.entries()].filter(([path, file]) => file instanceof obsidian.TFile && (path === from || path.startsWith(`${from}/`)));
    await rename(item, target);
    for (const [old, file] of moved) emit('rename', file, old);
  };
  app.vault.rename = reportingRename(app.vault.rename);
  app.fileManager.renameFile = reportingRename(app.fileManager.renameFile);
  const reads = [];
  const realRead = app.vault.read;
  app.vault.read = async file => { reads.push(file.path); return realRead(file); };
  app.workspace = { getLeavesOfType: () => [], requestSaveLayout() {} };
  const plugin = new Plugin();
  Object.assign(plugin, { app, repo, settings: repo.settings, registerEvent: () => {}, logs: { appendLog() {} }, saveData: async () => {} });
  plugin.scheduleExternalReconciliation = () => {};
  plugin.rebuildDerivedData = async () => {};
  const views = [];
  plugin.views = () => views;
  plugin.registerVaultEvents();
  return {
    app, repo, files, contents, plugin, reads,
    async map(name) {
      const mapPath = await repo.createMap(name);
      const doc = await repo.readMap(mapPath);
      const node = await repo.createNote('Card', 'model-a', doc, mapPath, 'workspace');
      doc.nodes.push(node);
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
      views.push(view);
      return view;
    }
  };
}
const settle = async plugin => { for (let i = 0; i < 5; i++) await plugin.queue; };

test('an open map renamed outside while VAM writes stays open at its new path', async () => {
  const h = harness();
  const a = await h.map('Alpha'), b = await h.map('Beta');
  await h.open(a);
  const vb = await h.open(b);
  const folder = b.replace(/\/Map\.md$/, ''), moved = `${folder} renamed`;
  await h.plugin.mutate(async () => {
    await h.repo.updateNote((await h.repo.readMap(a)).nodes[0].path, { summary: 'A write' });
    // Outside VAM: the folder is renamed in the file explorer while the write runs.
    await h.app.fileManager.renameFile(h.files.get(folder), moved);
  });
  await settle(h.plugin);
  assert.equal(vb.path, `${moved}/Map.md`);
  assert.ok(vb.map, 'the map is still shown');
  assert.equal(vb.notes.size, 1, 'its card is read back from the new folder');
  assert.ok(vb.map.nodes.every(node => node.path.startsWith(`${moved}/`)));
});

test('a map moved by the folder setting clears the undo steps, so Undo never reads the old path', async () => {
  const h = harness();
  const mapPath = await h.map('Alpha');
  // The last card was removed: no card path moves with the folder, so the read-back sees no change of structure.
  await h.repo.updateMap(mapPath, doc => { doc.nodes = []; });
  const view = await h.open(mapPath);
  // The step "remove the last card" would write the map back at the path it was taken at.
  const takenAt = view.path;
  view.history.push({ label: 'remove card', undo: async () => { await h.repo.readMap(takenAt); }, redo: async () => {} });
  assert.equal(view.history.canUndo, true);
  await h.plugin.mutate(() => h.plugin.changeMapFolder('mindMapsFolder', 'Agent Workspace/Ideas'));
  await settle(h.plugin);
  assert.notEqual(view.path, mapPath);
  assert.ok(view.path.startsWith('Agent Workspace/Ideas/'), view.path);
  assert.ok(view.map, 'the map stays open');
  assert.equal(view.history.canUndo, false, 'the steps of the old path are gone');
  h.reads.length = 0;
  await h.plugin.mutate(() => view.travel(false));
  assert.equal(h.reads.includes(mapPath), false, 'Undo does not read the old path');
});

test('a VAM rename keeps the undo steps and Undo moves the map back', async () => {
  const h = harness();
  const mapPath = await h.map('Alpha');
  const view = await h.open(mapPath);
  view.history.push({ label: 'earlier', undo: async () => {}, redo: async () => {} });
  await h.plugin.mutate(() => view.renameMapTo('Omega'));
  await settle(h.plugin);
  assert.match(view.path, /Omega\/Map\.md$/);
  assert.ok(view.map);
  assert.equal(view.history.canUndo, true);
  await h.plugin.mutate(() => view.travel(false));
  await settle(h.plugin);
  assert.equal(view.path, mapPath, 'Undo renames it back');
  assert.ok(view.map);
  assert.equal(view.history.canUndo, true, 'the earlier step is still there');
});

test('relocate and followPath: a path already followed still clears; an unrelated mapping changes nothing', () => {
  const view = Object.create(VisualAgentMapView.prototype);
  let cleared = 0;
  Object.assign(view, { path: 'M/Map.md', history: { clear() { cleared++; } } });
  view.followPath('X/Map.md', 'Y/Map.md');
  assert.equal(view.path, 'M/Map.md');
  view.followPath('M/Map.md', 'N/Map.md');
  assert.equal(view.path, 'N/Map.md');
  assert.equal(cleared, 0, 'following keeps the steps');
  view.relocate(new Map([['M/Map.md', 'N/Map.md']]));
  assert.equal(view.path, 'N/Map.md');
  assert.equal(cleared, 1, 'the move already followed still clears the steps');
  view.relocate(new Map([['P/Map.md', 'Q/Map.md']]));
  assert.equal(cleared, 1);
  view.relocate(new Map([['N/Map.md', 'R/Map.md']]));
  assert.equal(view.path, 'R/Map.md');
  assert.equal(cleared, 2);
});
