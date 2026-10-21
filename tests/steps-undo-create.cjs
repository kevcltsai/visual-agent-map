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
  const { VisualAgentMapView } = load('main.ts', { obsidian: { ...obsidian, Modal: Base, Notice: dom.makeNotice([]) } }, { createFragment: dom.createFragment });
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

test('D11a: every child created in one go undoes to Unassigned, none left in Notes', async () => {
  const h = await harness();
  await h.view.addNode(h.root, 'One', false);
  await h.view.addNode(h.root, 'Two', false);
  assert.equal(h.view.map.nodes.length, 3);
  await h.view.travel(false); await h.view.travel(false);
  assert.equal(h.view.map.nodes.length, 1);
  assert.deepEqual(h.orphans(), []);
  assert.equal(h.notesIn('Unassigned').length, 2);
  assert.equal(h.calls.file.length, 0);
  await h.view.travel(true); await h.view.travel(true);
  assert.equal(h.view.map.nodes.length, 3); assert.equal(h.notesIn('Unassigned').length, 0);
});
