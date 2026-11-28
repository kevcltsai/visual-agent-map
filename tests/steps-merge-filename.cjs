// Persona ticket 33: a merged note's file name follows its final title (no "Budget 2.md" when the sources that held
// the name are parked by the same merge), a merge into a parent renames the parent's file with its title, and the
// rename goes through the move machinery (links follow, one undo step restores the old names).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('./support.cjs');
const { core, fixture, DEFAULT_SETTINGS, obsidian, withExpansionCoordinator, attachTopicRuns } = S;

const MAP = 'Agent Workspace/Topics/map-a/Map.md';
const NOTES = 'Agent Workspace/Topics/map-a/Notes';

async function harness(titles) {
  const { repo, app, contents, files } = fixture('en');
  const mapDoc = { id: 'map-a', title: 'map-a', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  await repo.ensureTopicFolders('Agent Workspace/Topics/map-a');
  await app.vault.create(MAP, core.serializeMap(mapDoc));
  const nodes = [];
  for (const title of titles) {
    const created = await repo.createNote(title, 'gpt-6-luna', mapDoc, MAP, 'workspace');
    await repo.updateNote(created.path, { summary: `${title} summary`, detail: 'Source detail', status: 'completed' });
    mapDoc.nodes.push(created);
    nodes.push(created);
  }
  await repo.saveMap(MAP, mapDoc);
  const host = withExpansionCoordinator({
    repo, settings: { ...DEFAULT_SETTINGS, language: 'en', cliModel: 'gpt-6-luna', cliReasoning: 'low' }, running: new Set(),
    pendingSuggestions: new Map(), pendingResearchOptions: new Map(), rebuildDerivedData: (_scope, scoped) => (scoped ?? repo).rebuildDerivedData(),
    recordFailure: (_label, error) => String(error?.message ?? error), views: () => [], mutate: async work => work()
  });
  repo.settings = host.settings;
  const { VisualAgentMapView } = S.load('main.ts', { obsidian: { ...obsidian, Notice: class {}, Modal: class { constructor(app) { this.app = app; } open() {} close() {} } } });
  const view = new VisualAgentMapView({ app }, attachTopicRuns(host));
  const hydrate = async () => { view.notes = new Map(await Promise.all(mapDoc.nodes.map(async n => [n.id, await repo.readNote(n.path, mapDoc)]))); };
  Object.assign(view, { path: MAP, map: mapDoc, contentEl: { querySelector: () => null }, render() {}, hydrate, ancestorContext: async () => '', queueCharts() {}, focusNode() {} });
  await hydrate();
  return { repo, app, contents, files, view, nodes, doc: mapDoc };
}
const snapshot = (h, nodes, targetId = null) => ({ path: MAP, mapId: h.view.map.id, parentId: null, targetId, sources: nodes.map(n => ({ id: n.id, path: n.path })) });
const names = h => [...h.files.keys()].filter(p => p.endsWith('.md') && p.includes('/map-a/') && !p.endsWith('Map.md')).map(p => p.slice(p.indexOf('/map-a/') + 7)).sort();

test('same-level merge: the merged note is named after its title, not "Budget 2.md"', async () => {
  const h = await harness(['Budget', 'Pricing']);
  await h.view.mergeSelected('Budget', snapshot(h, h.nodes));
  const merged = h.view.map.nodes.find(n => !h.nodes.some(s => s.id === n.id));
  assert.equal(merged.path, `${NOTES}/Budget.md`, 'file name equals the title');
  assert.equal((await h.repo.readNote(merged.path)).title, 'Budget');
  assert.deepEqual(names(h), ['Notes/Budget.md', 'Unassigned/Budget.md', 'Unassigned/Pricing.md']);
});

test('same-level merge: undo parks the merged note and redo puts it back under the same final name', async () => {
  const h = await harness(['Budget', 'Pricing']);
  await h.view.mergeSelected('Budget', snapshot(h, h.nodes));
  const entry = h.view.history.undoEntry;
  assert.ok(entry, 'one history step');
  await entry.undo();
  assert.ok(h.files.has(`${NOTES}/Pricing.md`) && h.files.has(`${NOTES}/Budget.md`), 'sources are back');
  await entry.redo();
  assert.ok(h.files.has(`${NOTES}/Budget.md`));
  const merged = h.view.map.nodes.find(n => !h.nodes.some(s => s.id === n.id));
  assert.equal(h.files.has(merged.path), true);
  assert.equal(merged.path, `${NOTES}/Budget.md`);
});

test('same-level merge: a name that is really taken by another note keeps the numbered name', async () => {
  const h = await harness(['A', 'B', 'Budget']);
  await h.view.mergeSelected('Budget', snapshot(h, h.nodes.slice(0, 2)));
  const merged = h.view.map.nodes.find(n => !h.nodes.some(s => s.id === n.id));
  assert.equal(merged.path, `${NOTES}/Budget 2.md`, 'the real "Budget" stays untouched');
  assert.equal(h.files.has(`${NOTES}/Budget.md`), true);
});

test('merge into a parent: a new name changes only the title; the parent keeps its path and id (existing contract)', async () => {
  const h = await harness(['Users', 'Kid1', 'Kid2']);
  const [parent, k1, k2] = h.nodes;
  k1.parentId = parent.id; k2.parentId = parent.id;
  await h.repo.saveMap(MAP, h.view.map);
  await h.view.hydrate();
  await h.view.mergeSelected('Customers', snapshot(h, [parent, k1, k2], parent.id));
  const node = h.view.map.nodes.find(n => n.id === parent.id);
  assert.equal(node.path, `${NOTES}/Users.md`);
  assert.equal((await h.repo.readNote(node.path)).title, 'Customers');
});

// Book reverify 3: in a picture-book map the commit parks the sources, and Obsidian rewrites the links to them inside the merged
// text; the program's fingerprint is taken from the text as committed, so the merged chapter is not "hand-edited" afterwards.
async function bookHarness(titles) {
  const h = await harness(titles);
  const { newBookPipeline } = S.load('core/book-pipeline/machine.ts');
  h.view.map.bookPipeline = newBookPipeline({ runId: 'r1', order: h.nodes.map(n => n.id), now: 'a' });
  await h.repo.saveMap(MAP, h.view.map);
  // Like Obsidian's FileManager.renameFile: the links to a moved note follow it.
  const rename = h.app.fileManager.renameFile;
  h.app.fileManager.renameFile = async (item, target) => {
    const base = item.basename;
    await rename(item, target);
    for (const [path, text] of h.contents) if (typeof text === 'string' && text.includes(`[[${base}]]`)) h.contents.set(path, text.split(`[[${base}]]`).join(`[[${target.replace(/\.md$/, '')}]]`));
  };
  return h;
}
const { bodyStateRaw } = S.load('core/book-pipeline/body-integrity.ts');

test('book map, merge into a parent: links rewritten at commit leave the merged chapter clean, and undo still works', async () => {
  const h = await bookHarness(['Users', 'Kid1', 'Kid2']);
  const [parent, k1, k2] = h.nodes;
  k1.parentId = parent.id; k2.parentId = parent.id;
  await h.repo.updateNote(k1.path, { detail: 'Kid1 text, see [[Kid2]] for more.' });
  await h.repo.saveMap(MAP, h.view.map);
  await h.view.hydrate();
  await h.view.mergeSelected('Users', snapshot(h, [parent, k1, k2], parent.id));
  const text = h.contents.get(`${NOTES}/Users.md`);
  assert.match(text, /\[\[[^\]]*Unassigned\/Kid2\]\]/, 'the link was rewritten by the commit');
  assert.equal(bodyStateRaw(text), 'clean');
  const entry = h.view.history.undoEntry;
  await entry.undo();
  assert.ok(h.files.has(`${NOTES}/Kid1.md`) && h.files.has(`${NOTES}/Kid2.md`), 'undo brought the children back');
  await entry.redo();
  assert.equal(bodyStateRaw(h.contents.get(`${NOTES}/Users.md`)), 'clean', 'redo stamps the committed text again');
  await entry.undo();
  assert.ok(h.files.has(`${NOTES}/Kid1.md`), 'undo after redo is not refused');
});

test('book map, same-level merge: links rewritten at commit leave the new chapter clean', async () => {
  const h = await bookHarness(['Budget', 'Pricing']);
  await h.repo.updateNote(h.nodes[0].path, { detail: 'Budget text, see [[Pricing]].' });
  await h.view.hydrate();
  await h.view.mergeSelected('Budget', snapshot(h, h.nodes));
  const merged = h.view.map.nodes.find(n => !h.nodes.some(s => s.id === n.id));
  const text = h.contents.get(merged.path);
  assert.match(text, /\[\[[^\]]*Unassigned\/Pricing\]\]/, 'the link was rewritten by the commit');
  assert.equal(bodyStateRaw(text), 'clean');
  const entry = h.view.history.undoEntry;
  await entry.undo();
  await entry.redo();
  const node = (await h.repo.readMap(MAP)).nodes.find(n => n.id === merged.id);
  assert.equal(bodyStateRaw(h.contents.get(node.path)), 'clean', 'still clean after undo and redo');
});
