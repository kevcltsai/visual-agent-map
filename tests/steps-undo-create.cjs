// 0.25 D11a: undoing a created topic (addNode: "+", strengthen, each child of a batch) takes its note out of Notes
// the way remove does (Unassigned, no Update links dialog); redo puts it back at the exact path, byte for byte.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, fixture, DEFAULT_SETTINGS, obsidian, withExpansionCoordinator } = require('./support.cjs');
const dom = require('./support-dom.cjs');
const { element } = dom;
// setLifecycle rewrites `updated:` and moves the `agent-map-id:` line (known quirk, same as remove -> undo); everything else must match.
const stable = text => text.split('\n').filter(line => !/^(updated|agent-map-id):/.test(line)).join('\n');
const MAP = 'Agent Workspace/Topics/map-u/Map.md';

async function harness() {
  const { repo, app, contents } = fixture('en', { linkIndex: true });
  const calls = { vault: [], file: [] };
  const vaultRename = app.vault.rename, fileRename = app.fileManager.renameFile;
  app.vault.rename = async (item, target) => { calls.vault.push([item.path, target]); return vaultRename(item, target); };
  app.fileManager.renameFile = async (item, target) => { calls.file.push([item.path, target]); return fileRename(item, target); };
  const settings = { ...DEFAULT_SETTINGS, language: 'en', cliModel: 'gpt-6-luna' };
  repo.settings = settings;
  const mapDoc = { id: 'map-u', title: 'Undo', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  await repo.ensureTopicFolders('Agent Workspace/Topics/map-u');
  const root = await repo.createNote('Root', 'gpt-6-luna', mapDoc, MAP, 'workspace');
  mapDoc.nodes.push(root);
  await app.vault.create(MAP, require('./support.cjs').core.serializeMap(mapDoc));
  await repo.rebuildDerivedData();
  const Base = dom.makeModal();
  // The map conflict window answers at once with the file's version (closing it does that).
  class Modal extends Base { open() { super.open(); this.close(); } }
  const { VisualAgentMapView } = load('main.ts', { obsidian: { ...obsidian, Modal, Notice: dom.makeNotice([]) } }, { createFragment: dom.createFragment });
  const plugin = withExpansionCoordinator({
    repo, settings, running: new Set(), logs: { appendLog() {} }, rebuildDerivedData: () => repo.rebuildDerivedData(), relevanceGrades: new Map(), expansionBatches: new Map(), pendingSuggestions: new Map(), releaseOutline() {}, setOutlineActive() {}, detailsShown: () => false
  });
  const view = new VisualAgentMapView({ app }, plugin);
  view.path = MAP; view.map = await repo.readMap(MAP); view.contentEl = element('div'); view.stageEl = element('div');
  view.focusNode = () => {}; view.openDetails = () => {}; view.render = () => {};
  view.hydrate = async () => { view.notes = new Map(await Promise.all(view.map.nodes.map(async n => [n.id, await repo.readNote(n.path)]))); };
  await view.hydrate();
  const notesIn = folder => [...contents.keys()].filter(p => p.startsWith(`Agent Workspace/Topics/map-u/${folder}/`) && p.endsWith('.md'));
  const orphans = () => notesIn('Notes').filter(p => /agent-map-node/.test(contents.get(p)) && /agent-map-id: map-u/.test(contents.get(p)) && !view.map.nodes.some(n => n.path === p));
  return { repo, app, contents, view, calls, root: view.map.nodes[0], notesIn, orphans };
}

test('D11a: undo of a created topic parks its note in Unassigned; redo restores the exact path and bytes', async () => {
  const h = await harness();
  await h.view.addNode(h.root, 'Child');
  const created = h.view.map.nodes.find(n => n.id !== h.root.id);
  const path = created.path, text = h.contents.get(path);
  assert.deepEqual(h.notesIn('Notes').sort(), [h.root.path, path].sort());
  h.calls.vault.length = 0; h.calls.file.length = 0;
  await h.view.travel(false);
  assert.equal(h.view.map.nodes.length, 1, 'the card left the map');
  assert.deepEqual(h.orphans(), [], 'no unowned node note remains in Notes');
  assert.equal(h.notesIn('Unassigned').length, 1);
  assert.match(h.contents.get(h.notesIn('Unassigned')[0]), /topic-state: unassigned/);
  assert.equal(h.contents.has(path), false);
  assert.equal(h.calls.vault.length, 1, 'moved with vault.rename'); assert.equal(h.calls.file.length, 0, 'no Update links dialog');
  await h.view.travel(true);
  assert.equal(h.view.map.nodes.some(n => n.id === created.id && n.path === path), true);
  assert.equal(h.notesIn('Unassigned').length, 0);
  assert.equal(stable(h.contents.get(path)), stable(text), 'identical after redo except the updated and agent-map-id lines');
  assert.match(h.contents.get(path), /^agent-map-id: map-u$/m);
  assert.equal(h.calls.file.length, 0);
  await h.view.travel(false);
  assert.equal(h.notesIn('Unassigned').length, 1, 'a second undo parks it again');
  assert.deepEqual(h.orphans(), []);
});

test('D11a: every child of a createChildBatch undoes to Unassigned, none left in Notes', async () => {
  const h = await harness();
  const children = await h.view.createChildBatch(h.root, [{ title: 'One', task: 'a' }, { title: 'Two', task: 'b' }, { title: 'Under one', task: 'c', parentTitle: 'One' }]);
  assert.equal(children.length, 3); assert.equal(h.view.map.nodes.length, 4);
  while (h.view.history.canUndo) await h.view.travel(false);
  assert.equal(h.view.map.nodes.length, 1);
  assert.deepEqual(h.orphans(), []);
  assert.equal(h.notesIn('Unassigned').length, 3);
  assert.equal(h.calls.file.length, 0);
  while (h.view.history.canRedo) await h.view.travel(true);
  assert.equal(h.view.map.nodes.length, 4); assert.equal(h.notesIn('Unassigned').length, 0);
});

test('D11a: after a map conflict resolved to the file, undo keeps the node added outside and parks only the new one', async () => {
  const h = await harness();
  const disk = await h.repo.readMap(MAP);
  const outside = await h.repo.createNote('Outside', 'gpt-6-luna', disk, MAP, 'workspace');
  Object.assign(outside, { parentId: h.root.id, x: 400, y: 80 });
  disk.nodes.push(outside);
  await h.repo.saveMap(MAP, disk);
  assert.equal(h.view.map.nodes.length, 1, 'the view has not seen it yet');
  await h.view.addNode(h.root, 'Mine');
  assert.deepEqual(h.view.map.nodes.map(n => n.id).includes(outside.id), true);
  await h.view.travel(false);
  assert.equal(JSON.stringify(h.view.map.nodes.map(n => n.id).sort()), JSON.stringify([h.root.id, outside.id].sort()), 'the outside node stays');
  assert.deepEqual(h.orphans(), [], 'it is not orphaned and the new note is parked');
  assert.equal(h.notesIn('Unassigned').length, 1);
  assert.equal(h.contents.has(outside.path), true);
  await h.view.travel(true);
  assert.equal(h.view.map.nodes.length, 3);
});

const outline = (...titles) => titles.map((title, index) => ({ index, title, level: 1, parent: null, line: index }));
const importRequest = nodes => ({ nodes, source: null, shallowResearch: false });

test('0.25 retest: undo and redo run the Map.md conflict check; an outside edit is not overwritten and history is cleared', async () => {
  const h = await harness();
  await h.view.addNode(h.root, 'Mine');
  assert.equal(h.view.history.canUndo, true);
  // Someone edits Map.md outside the view.
  const disk = await h.repo.readMap(MAP);
  const outside = await h.repo.createNote('Outside', 'gpt-6-luna', disk, MAP, 'workspace');
  Object.assign(outside, { parentId: h.root.id, x: 400, y: 300 });
  disk.nodes.push(outside);
  await h.repo.saveMap(MAP, disk);
  await h.view.travel(false);
  assert.equal(h.view.map.nodes.some(n => n.id === outside.id), true, 'the outside node survives the undo');
  assert.equal((await h.repo.readMap(MAP)).nodes.some(n => n.id === outside.id), true, 'and so does it on disk');
  assert.deepEqual(h.orphans(), [], 'its note is not orphaned');
  assert.equal(h.view.history.canUndo, false, 'history is cleared like after a forward-change conflict');
  assert.equal(h.view.history.canRedo, false);
  // Redo side: undo cleanly, edit outside, redo.
  await h.view.addNode(h.root, 'Second');
  await h.view.travel(false);
  assert.equal(h.view.history.canRedo, true);
  const disk2 = await h.repo.readMap(MAP);
  const outside2 = await h.repo.createNote('Outside two', 'gpt-6-luna', disk2, MAP, 'workspace');
  Object.assign(outside2, { parentId: h.root.id, x: 400, y: 600 });
  disk2.nodes.push(outside2);
  await h.repo.saveMap(MAP, disk2);
  await h.view.travel(true);
  assert.equal(h.view.map.nodes.some(n => n.id === outside2.id), true, 'redo keeps the outside node');
  assert.equal(h.view.history.canRedo, false);
  assert.deepEqual(h.orphans(), []);
});

test('0.25 final review F1: undo parks under a free name when Unassigned holds the same name in another case (APFS)', async () => {
  const h = await harness();
  const { TFolder } = require('./support.cjs');
  const vault = h.app.vault, rename = vault.rename;
  const fold = name => name.normalize('NFC').toLowerCase().replace(/ς/g, 'σ');
  // Like a case-insensitive file system: renaming onto a name that differs only by case fails.
  vault.rename = async (item, target) => {
    const folder = vault.getAbstractFileByPath(target.split('/').slice(0, -1).join('/'));
    if (folder instanceof TFolder && folder.children.some(c => c.path !== item.path && fold(c.name) === fold(target.split('/').at(-1)))) throw new Error('Destination file already exists!');
    return rename(item, target);
  };
  const unassigned = h.repo.topicFolder(MAP, 'Unassigned');
  await h.repo.ensureTopicFolders('Agent Workspace/Topics/map-u');
  await vault.create(`${unassigned}/Topic.md`, 'existing parked note');
  await h.view.addNode(h.root, 'topic');
  const created = h.view.map.nodes.find(n => n.id !== h.root.id);
  assert.equal(created.path.endsWith('/topic.md'), true);
  await h.view.travel(false);
  assert.equal(h.view.map.nodes.length, 1, 'the undo went through');
  assert.equal(h.contents.get(`${unassigned}/Topic.md`), 'existing parked note', 'the existing note is untouched');
  assert.equal(h.contents.has(`${unassigned}/topic 2.md`), true, 'parked under the next free name');
  assert.deepEqual(h.orphans(), []);
  await h.view.travel(true);
  assert.equal(h.view.map.nodes.some(n => n.id === created.id && n.path === created.path), true, 'redo restores the exact path');
  assert.equal(h.contents.has(`${unassigned}/topic 2.md`), false);
});
