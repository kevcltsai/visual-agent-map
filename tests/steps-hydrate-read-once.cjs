// Perf 02: one hydrate reads each ancestor note once, one synchronize reads Map.md once, failedPaths separates a
// read that threw from a file that is missing, and model results are the same as before.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, fixture, DEFAULT_SETTINGS, obsidian, core } = require('./support.cjs');

const MAP = 'Agent Workspace/Topics/map-ro1/Map.md';

async function build(children = 10, childSource = 'inherited') {
  const { repo, app } = fixture('en', { linkIndex: true });
  repo.settings = { ...DEFAULT_SETTINGS, language: 'en', cliModel: 'cur-model' };
  const doc = { id: 'map-ro1', title: 'RO1', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  await repo.ensureTopicFolders('Agent Workspace/Topics/map-ro1');
  const root = await repo.createNote('Root', 'manual-m', doc, MAP, 'manual');
  doc.nodes.push(root);
  const kids = [];
  for (let i = 0; i < children; i++) {
    const kid = await repo.createNote(`Kid ${i}`, 'x', doc, MAP, childSource);
    kid.parentId = root.id;
    doc.nodes.push(kid);
    kids.push(kid);
  }
  await app.vault.create(MAP, core.serializeMap(doc));
  const reads = new Map();
  const realRead = app.vault.read.bind(app.vault);
  app.vault.read = async file => { reads.set(file.path, (reads.get(file.path) ?? 0) + 1); return realRead(file); };
  return { repo, app, doc, root, kids, reads, realRead };
}
const viewOf = repo => {
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app: {} }, { repo, settings: repo.settings, pendingSuggestions: new Map(), expansionBatches: new Map(), detailsShown: () => false });
  view.hydrateFailedReportTargets = async () => {};
  return view;
};

test('hydrate reads a shared manual ancestor once and keeps the inherited model', async () => {
  const h = await build();
  const view = viewOf(h.repo);
  view.path = MAP; view.map = await h.repo.readMap(MAP);
  h.reads.clear();
  const out = await view.hydrate();
  assert.equal(h.reads.get(h.root.path), 1);
  for (const kid of h.kids) assert.equal(h.reads.get(kid.path), 1);
  assert.equal(out.failedPaths.length, 0);
  for (const kid of h.kids) {
    const note = view.notes.get(kid.id);
    assert.equal(note.model, 'manual-m');
    assert.equal(note.modelOverride, true);
  }
});

test('without a context readNote still walks the ancestor per call (old API unchanged)', async () => {
  const h = await build(3);
  h.reads.clear();
  const map = await h.repo.readMap(MAP);
  for (const kid of h.kids) assert.equal((await h.repo.readNote(kid.path, map)).model, 'manual-m');
  assert.equal(h.reads.get(h.root.path), 3);
});

test('model results: workspace, missing ancestor and legacy source', async () => {
  const h = await build(2, 'workspace');
  const view = viewOf(h.repo);
  view.path = MAP; view.map = await h.repo.readMap(MAP);
  await view.hydrate();
  assert.equal(view.notes.get(h.kids[0].id).model, 'cur-model');
  // an inherited child whose ancestor note is gone falls back to the current model, and nothing is a failure
  const g = await build(2);
  const v2 = viewOf(g.repo);
  v2.path = MAP; v2.map = await g.repo.readMap(MAP);
  const realGet = g.app.vault.getAbstractFileByPath.bind(g.app.vault);
  g.app.vault.getAbstractFileByPath = p => (p === g.root.path ? null : realGet(p));
  const out = await v2.hydrate();
  assert.equal(v2.notes.get(g.kids[0].id).model, 'cur-model');
  assert.equal(v2.notes.get(g.kids[0].id).modelOverride, undefined);
  assert.equal(out.failedPaths.length, 0);
});

test('failedPaths lists a read that threw (note and ancestor) and not a missing file', async () => {
  const h = await build(3);
  const view = viewOf(h.repo);
  view.path = MAP; view.map = await h.repo.readMap(MAP);
  const ancestorBroken = h.root.path, noteBroken = h.kids[1].path;
  h.app.vault.read = async file => {
    if (file.path === ancestorBroken || file.path === noteBroken) throw new Error('disk');
    return h.realRead(file);
  };
  const out = await view.hydrate();
  assert.deepEqual(Array.from(out.failedPaths).sort(), [ancestorBroken, noteBroken].sort());
  assert.equal(view.notes.get(h.kids[0].id).model, 'cur-model');
  assert.equal(view.notes.has(h.kids[1].id), false);
});

test('synchronize reads Map.md once', async () => {
  const h = await build(3);
  const view = viewOf(h.repo);
  view.path = MAP; view.map = await h.repo.readMap(MAP); view.closed = false;
  view.render = () => {}; view.syncHold = 0; view.typingInField = () => false; view.refreshCard = () => {}; view.drawEdges = () => {};
  view.app = { vault: h.app.vault };
  h.reads.clear();
  await view.synchronize();
  assert.equal(h.reads.get(MAP), 1);
});
