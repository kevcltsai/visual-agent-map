// MapTransaction 02, Packet 3: mapChangeSnapshots (every mapChange, addNode, batch children) runs as a transaction.
// Undo/redo of a created topic reuse one parking path; unrecorded structural writes make undo refuse (stale).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, fixture, DEFAULT_SETTINGS, obsidian, core, withExpansionCoordinator } = require('./support.cjs');
const dom = require('./support-dom.cjs');
const { element } = dom;
const stable = text => text.split('\n').filter(line => !/^(updated|agent-map-id):/.test(line)).join('\n');
const MAP = 'Agent Workspace/Topics/map-u/Map.md';

async function harness() {
  const { repo, app, contents } = fixture('en', { linkIndex: true });
  const settings = { ...DEFAULT_SETTINGS, language: 'en', cliModel: 'gpt-6-luna' };
  repo.settings = settings;
  const mapDoc = { id: 'map-u', title: 'Undo', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  await repo.ensureTopicFolders('Agent Workspace/Topics/map-u');
  const root = await repo.createNote('Root', 'gpt-6-luna', mapDoc, MAP, 'workspace');
  mapDoc.nodes.push(root);
  await app.vault.create(MAP, core.serializeMap(mapDoc));
  await repo.rebuildDerivedData();
  const saves = [];
  const spy = Object.create(repo);
  spy.saveMap = async (...args) => { saves.push(args[0]); return repo.saveMap(...args); };
  class Modal extends dom.makeModal() { open() { super.open(); this.close(); } }
  const { VisualAgentMapView } = load('main.ts', { obsidian: { ...obsidian, Modal, Notice: dom.makeNotice([]) } }, { createFragment: dom.createFragment });
  const plugin = withExpansionCoordinator({
    repo: spy, settings, running: new Set(), logs: { appendLog() {} }, rebuildDerivedData: () => repo.rebuildDerivedData(), relevanceGrades: new Map(), expansionBatches: new Map(), pendingSuggestions: new Map(), releaseOutline() {}, setOutlineActive() {}, detailsShown: () => false
  });
  const view = new VisualAgentMapView({ app }, plugin);
  view.path = MAP; view.map = await repo.readMap(MAP); view.contentEl = element('div'); view.stageEl = element('div');
  view.focusNode = () => {}; view.openDetails = () => {}; view.render = () => {};
  view.hydrate = async () => { view.notes = new Map((await Promise.all(view.map.nodes.map(async n => [n.id, await repo.readNote(n.path).catch(() => null)]))).filter(e => e[1])); };
  await view.hydrate();
  const notesIn = folder => [...contents.keys()].filter(p => p.startsWith(`Agent Workspace/Topics/map-u/${folder}/`) && p.endsWith('.md'));
  const snapshot = () => new Map([...contents].map(([p, text]) => [p, p.endsWith('Map.md') ? text : stable(text)]));
  const rejected = async promise => { try { await promise; } catch (error) { return error; } return assert.fail('expected a rejection'); };
  return { repo, app, contents, view, saves, root: view.map.nodes[0], notesIn, snapshot, rejected };
}

test('C1: addNode undo, redo, undo parks in the same Unassigned path both times and redo returns to the original path', async () => {
  const h = await harness();
  await h.view.addNode(h.root, 'Child');
  const created = h.view.map.nodes.find(n => n.id !== h.root.id);
  const text = h.contents.get(created.path);
  await h.view.travel(false);
  const first = h.notesIn('Unassigned');
  assert.equal(first.length, 1);
  await h.view.travel(true);
  assert.equal(h.contents.has(created.path), true, 'back at the original path');
  assert.equal(stable(h.contents.get(created.path)), stable(text));
  assert.equal(h.notesIn('Unassigned').length, 0);
  await h.view.travel(false);
  assert.deepEqual(h.notesIn('Unassigned'), first, 'the second undo parks at the same path');
});

test('C2: undo of a collapse after an unrecorded structural write refuses and keeps that write', async () => {
  const h = await harness();
  await h.view.mapChange(map => { map.nodes[0].collapsed = true; });
  const outside = await h.repo.readMap(MAP);
  outside.title = 'Written by AIM';
  await h.repo.saveMap(MAP, outside);
  h.view.map = await h.repo.readMap(MAP);
  const before = h.snapshot();
  const error = await h.rejected(h.view.travel(false));
  assert.equal(error.kind, 'stale');
  assert.deepEqual(h.snapshot(), before);
  assert.equal((await h.repo.readMap(MAP)).title, 'Written by AIM');
  assert.equal(h.view.history.canUndo, true);
});

test('C3: a batch followed by a coordinates-only write still undoes and redoes as one step, parking at the same paths', async () => {
  const h = await harness();
  const items = [{ title: 'One', task: 'a' }, { title: 'Two', task: 'b' }, { title: 'Under one', task: 'c', parentTitle: 'One' }];
  await h.view.createChildBatch(h.root, items);
  assert.equal(h.view.map.nodes.length, 4);
  const respaced = await h.repo.readMap(MAP);
  for (const node of respaced.nodes) { node.x += 7; node.y += 11; }
  await h.repo.saveMap(MAP, respaced);
  h.view.map = await h.repo.readMap(MAP);
  await h.view.travel(false);
  assert.equal(h.view.map.nodes.length, 1, 'one undo removes the whole batch');
  const parked = h.notesIn('Unassigned').sort();
  assert.equal(parked.length, 3);
  assert.equal(h.view.history.canUndo, false);
  await h.view.travel(true);
  assert.equal(h.view.map.nodes.length, 4, 'one redo brings it all back');
  assert.equal(h.notesIn('Unassigned').length, 0);
  assert.equal(h.view.history.canRedo, false);
  await h.view.travel(false);
  assert.deepEqual(h.notesIn('Unassigned').sort(), parked, 'the same parking paths as the first undo');
});

test('C4: batch undo after one new note was moved away outside is refused as a whole and the pointer is restored', async () => {
  const h = await harness();
  await h.view.createChildBatch(h.root, [{ title: 'One', task: '' }, { title: 'Two', task: '' }, { title: 'Three', task: '' }]); // empty tasks: no note-patch entries, so every step is a transaction
  const victim = h.view.map.nodes[2];
  await h.app.vault.rename(h.app.vault.getAbstractFileByPath(victim.path), 'Agent Workspace/Topics/map-u/Moved by hand.md');
  // The stray note is outside the map: a derived-data rebuild may rewrite its Reference Links, so it is left out of the comparison.
  const MOVED = 'Agent Workspace/Topics/map-u/Moved by hand.md';
  const comparable = () => { const all = h.snapshot(); all.delete(MOVED); return all; };
  const before = comparable(), map = JSON.stringify(h.view.map);
  const error = await h.rejected(h.view.travel(false));
  assert.equal(error.kind, 'stale');
  assert.deepEqual(comparable(), before, 'Map.md and the other notes are as before the undo');
  assert.equal(h.contents.has(MOVED), true);
  assert.equal(h.view.map.nodes.length, 4);
  assert.equal(JSON.stringify(h.view.map), map);
  assert.equal(h.view.history.canUndo, true, 'pointer restored');
  assert.equal(h.notesIn('Unassigned').length, 0);
});

test('C6: one conflict-free mapChange makes this many saveMap calls (recorded, no threshold)', async () => {
  const h = await harness();
  h.saves.length = 0;
  await h.view.mapChange(map => { map.nodes[0].collapsed = true; });
  console.log(`C6 saveMap calls for one mapChange: ${h.saves.length}`);
  assert.ok(h.saves.length >= 1);
  assert.equal(h.view.map.nodes[0].collapsed, true);
});

test('R1-F1: an outline import whose rebuild fails still leaves an entry that parks the notes on undo', async () => {
  const h = await harness();
  h.view.plugin.mutate = async work => { await work(); };
  h.view.outlineImportTarget = () => ({ map: 'editable' });
  h.view.plugin.rebuildDerivedData = async () => { throw new Error('injected rebuild'); };
  const nodes = ['Topic', 'Two', 'Three'].map((title, index) => ({ index, title, level: 1, parent: null, line: index }));
  await h.view.importOutlineIntoMap({ nodes, source: null, shallowResearch: false }, { kind: 'tree' }).catch(() => {});
  assert.equal(h.view.map.nodes.length, 4, 'the import is saved and in memory');
  assert.equal(h.view.history.canUndo, true, 'the entry is in history');
  const created = h.view.map.nodes.filter(n => n.id !== h.root.id).map(n => n.path);
  h.view.plugin.rebuildDerivedData = () => h.repo.rebuildDerivedData();
  await h.view.travel(false);
  assert.equal(h.view.map.nodes.length, 1, 'the nodes are gone from the map');
  assert.equal(h.notesIn('Unassigned').length, 3, 'the notes are parked in Unassigned');
  for (const path of created) assert.equal(h.contents.has(path), false, `${path} is no longer in Notes`);
});

test('R1-F4: a viewport panned while the commit is running is kept', async () => {
  const h = await harness();
  const pan = { x: 77, y: 88, zoom: 1.5 };
  const save = h.view.plugin.repo.saveMap;
  h.view.plugin.repo.saveMap = async (...args) => { h.view.map.viewport = pan; return save(...args); };
  await h.view.mapChange(map => { map.nodes[0].collapsed = true; });
  assert.equal(JSON.stringify(h.view.map.viewport), JSON.stringify(pan));
});

test('R2-N3: after the conflict window keeps the file version, the viewport on screen is applied, not the older one from disk', async () => {
  const h = await harness();
  const screen = { x: 50, y: 60, zoom: 2 };
  const outside = await h.repo.readMap(MAP);
  outside.title = 'Written by AIM';
  outside.viewport = { x: 1, y: 2, zoom: 1 };
  await h.repo.saveMap(MAP, outside);
  h.view.map.viewport = screen;
  // The same outcome as choosing "use file contents": this.map becomes a clone of the map on disk.
  h.view.resolveMapConflict = async function () {
    this.map = await h.repo.readMap(MAP);
    this.history.clear();
    return true;
  };
  await h.view.mapChange(map => { map.nodes[0].collapsed = true; });
  assert.equal(h.view.map.title, 'Written by AIM', 'the file version was kept');
  assert.equal(JSON.stringify(h.view.map.viewport), JSON.stringify(screen), 'the viewport on screen survives');
});

test('R2-N4: a synthesis topic whose rebuild fails keeps the synthesis label on its history entry', async () => {
  const h = await harness();
  const view = h.view;
  view.plugin.rebuildDerivedData = async () => { throw new Error('injected rebuild'); };
  const sources = [h.root];
  const task = {
    state: 'applying', controller: new AbortController(), mapPath: MAP, mapId: view.map.id,
    options: { synthesisContent: 'strong' }, directions: [], sourceContent: ''
  };
  view.integrationTask = task;
  task.sourceContent = JSON.stringify((await view.topicReferenceGroup(sources, 'strong', {})).documents);
  const result = { summary: 's', detail: 'd', visualReferences: [], formatIssues: [] };
  // The note is saved and on disk, so a failing rebuild is reported but does not fail the save.
  await view.saveIntegratedNode('Synth', sources, 'goal', '', 'gpt-6-luna', result, 'en', task, {});
  assert.equal(view.map.nodes.length, 2, 'the synthesis topic is saved');
  const entry = view.history.undoEntry;
  assert.ok(entry, 'the entry is in history');
  assert.equal(entry.label, 'Create synthesis topic');
});
