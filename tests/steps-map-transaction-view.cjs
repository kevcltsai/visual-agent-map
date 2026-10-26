// MapTransaction 01, view layer: the five file-moving methods (parkFile, transferAndAdd, relinkMissingNode, ...) either
// finish with a history entry or leave the Vault as it was; undo/redo refuse (stale) instead of overwriting outside changes.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, fixture, DEFAULT_SETTINGS, obsidian, core, withExpansionCoordinator } = require('./support.cjs');
const dom = require('./support-dom.cjs');
const { element } = dom;
// setLifecycle rewrites `updated:` and moves the `agent-map-id:` line; everything else must match.
const stable = text => text.split('\n').filter(line => !/^(updated|agent-map-id):/.test(line)).join('\n');
const TOPICS = 'Agent Workspace/Topics';
const MAP = `${TOPICS}/map-u/Map.md`, MAP_V = `${TOPICS}/map-v/Map.md`;
const TOPIC_V = { id: 'map-v', title: 'V', mapPath: MAP_V, root: `${TOPICS}/map-v` };

async function harness() {
  const { repo, app, contents } = fixture('en', { linkIndex: true });
  const settings = { ...DEFAULT_SETTINGS, language: 'en', cliModel: 'gpt-6-luna' };
  repo.settings = settings;
  const docs = {};
  for (const [id, path] of [['map-u', MAP], ['map-v', MAP_V]]) {
    docs[id] = { id, title: id, version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
    await repo.ensureTopicFolders(`${TOPICS}/${id}`);
    await app.vault.create(path, core.serializeMap(docs[id]));
  }
  const root = await repo.createNote('Root', 'gpt-6-luna', docs['map-u'], MAP, 'workspace');
  docs['map-u'].nodes.push(root);
  await repo.saveMap(MAP, docs['map-u']);
  // A note of the other topic that is on no map: the thing the user drags in or archives.
  const loose = await repo.createNote('Loose', 'gpt-6-luna', docs['map-v'], MAP_V, 'workspace');
  await repo.rebuildDerivedData();
  // Failures are injected on the repo the view uses; the view itself is untouched.
  const fail = {}, calls = [];
  const spy = Object.create(repo);
  for (const name of ['setLifecycle', 'saveMap', 'moveExact']) {
    let n = 0;
    spy[name] = async (...args) => {
      n++; calls.push(name);
      if (fail[name]?.(n, args)) throw new Error(`injected ${name} ${n}`);
      return repo[name](...args);
    };
  }
  const notices = [];
  class Modal extends dom.makeModal() { open() { super.open(); this.close(); } }
  const { VisualAgentMapView } = load('main.ts', { obsidian: { ...obsidian, Modal, Notice: dom.makeNotice(notices) } }, { createFragment: dom.createFragment });
  const plugin = withExpansionCoordinator({
    repo: spy, settings, running: new Set(), logs: { appendLog() {} }, rebuildDerivedData: () => repo.rebuildDerivedData(), relevanceGrades: new Map(), expansionBatches: new Map(), pendingSuggestions: new Map(), releaseOutline() {}, setOutlineActive() {}, detailsShown: () => false
  });
  const view = new VisualAgentMapView({ app }, plugin);
  view.path = MAP; view.map = await repo.readMap(MAP); view.contentEl = element('div'); view.stageEl = element('div');
  view.focusNode = () => {}; view.openDetails = () => {}; view.render = () => {};
  view.hydrate = async () => { view.notes = new Map(await Promise.all(view.map.nodes.map(async n => [n.id, await repo.readNote(n.path)]))); };
  await view.hydrate();
  const snapshot = () => new Map([...contents].map(([p, text]) => [p, p.endsWith('Map.md') ? text : stable(text)]));
  const lifecycleOf = async path => { const n = await repo.readNote(path); return [n.topicId, n.mapId, n.topicState]; };
  const exists = path => !!app.vault.getAbstractFileByPath(path);
  const file = path => app.vault.getAbstractFileByPath(path);
  const rejected = async promise => { try { await promise; } catch (error) { return error; } return assert.fail('expected a rejection'); };
  return { repo, app, contents, view, fail, calls, notices, loose: loose.path, rootNode: root, snapshot, lifecycleOf, exists, file, rejected };
}

test('R1: parkFile whose setLifecycle fails leaves the note where it was, with its lifecycle, and no history entry', async () => {
  const h = await harness();
  const before = h.snapshot(), lifecycle = await h.lifecycleOf(h.loose), entries = h.view.history.past.length;
  h.fail.setLifecycle = n => n === 1; // the forward write fails; the restore must be able to write
  const error = await h.rejected(h.view.parkFile(h.file(h.loose), 'Archive', 'archived'));
  assert.match(error.message, /injected setLifecycle/);
  assert.equal(h.exists(h.loose), true, 'back at the original path');
  assert.deepEqual(h.snapshot(), before, 'Vault equals the state before');
  assert.deepEqual(await h.lifecycleOf(h.loose), lifecycle);
  assert.equal(h.view.history.past.length, entries, 'no history entry');
});

test('R2: transferAndAdd whose save of the other map fails restores the note, its lifecycle and both Map.md files', async () => {
  const h = await harness();
  const before = h.snapshot(), lifecycle = await h.lifecycleOf(h.loose);
  let failed = false; // only the forward write fails; the restore must be able to write
  h.fail.saveMap = (n, [path]) => path === MAP_V && !failed && (failed = true);
  const error = await h.rejected(h.view.transferAndAdd(h.file(h.loose), TOPIC_V));
  assert.match(error.message, /injected saveMap/);
  assert.equal(h.exists(h.loose), true);
  assert.deepEqual(h.snapshot(), before);
  assert.equal(h.contents.get(MAP_V), before.get(MAP_V));
  assert.equal(h.contents.get(MAP), before.get(MAP));
  assert.deepEqual(await h.lifecycleOf(h.loose), lifecycle);
  assert.equal(h.view.history.canUndo, false);
});

test('R3: relinkMissingNode for a node that is no longer on the map changes nothing', async () => {
  const h = await harness();
  const before = h.snapshot(), lifecycle = await h.lifecycleOf(h.loose);
  const error = await h.rejected(h.view.relinkMissingNode({ id: 'gone', path: `${TOPICS}/map-u/Notes/Gone.md` }, h.file(h.loose)));
  assert.match(error.message, /relink was not found/);
  assert.equal(h.exists(h.loose), true, 'the note was not moved into Notes');
  assert.deepEqual(h.snapshot(), before);
  assert.deepEqual(await h.lifecycleOf(h.loose), lifecycle, 'not set to active');
  assert.equal(h.view.history.canUndo, false);
});

test('R4: undo after the other map was edited outside refuses and leaves both maps and the note unchanged', async () => {
  const h = await harness();
  await h.view.transferAndAdd(h.file(h.loose), TOPIC_V);
  const added = (await h.repo.readMap(MAP_V)).nodes[0];
  assert.ok(added, 'the other map got the node');
  const outside = await h.repo.readMap(MAP_V);
  outside.title = 'Edited elsewhere';
  await h.repo.saveMap(MAP_V, outside);
  const before = h.snapshot();
  const error = await h.rejected(h.view.travel(false));
  assert.equal(error.kind, 'stale');
  assert.equal(h.view.history.canUndo, true, 'the history pointer is back');
  assert.deepEqual(h.snapshot(), before, 'no file or map was written');
  assert.equal((await h.repo.readMap(MAP_V)).title, 'Edited elsewhere');
  assert.equal(h.exists(added.path), true);
});

test('R5: undo of parkFile after the note was moved away refuses with a stale error and keeps the pointer', async () => {
  const h = await harness();
  await h.view.parkFile(h.file(h.loose), 'Archive', 'archived');
  const parked = [...h.contents.keys()].find(p => p.startsWith(`${TOPICS}/map-u/Archive/`));
  assert.ok(parked, 'parked in Archive');
  await h.app.vault.rename(h.file(parked), `${TOPICS}/map-u/Moved by hand.md`);
  const before = h.snapshot();
  const error = await h.rejected(h.view.travel(false));
  assert.equal(error.kind, 'stale');
  assert.equal(h.view.history.canUndo, true);
  assert.deepEqual(h.snapshot(), before);
});

test('claimToCurrent adds the node at the old spot, selects it, and undo then redo returns the note to the same place', async () => {
  const h = await harness();
  const focused = [], lifecycle = await h.lifecycleOf(h.loose);
  h.view.focusNode = node => focused.push(node.id);
  await h.view.claimToCurrent(h.file(h.loose));
  const node = h.view.map.nodes.find(n => n.id !== h.rootNode.id);
  assert.equal(node.path.startsWith(`${TOPICS}/map-u/Notes/`), true);
  assert.deepEqual([node.x, node.y, node.parentId], [80, h.rootNode.y + 240, null]);
  assert.equal(h.view.selected, node.id);
  assert.deepEqual(focused, [node.id]);
  assert.deepEqual(await h.lifecycleOf(node.path), ['map-u', 'map-u', 'active']);
  await h.view.travel(false);
  assert.equal(h.view.map.nodes.length, 1);
  assert.equal(h.exists(h.loose), true);
  assert.deepEqual(await h.lifecycleOf(h.loose), lifecycle);
  await h.view.travel(true);
  assert.equal(h.view.map.nodes.some(n => n.path === node.path), true);
});

test('a failing reload after a saved change keeps the change and its history entry and tells the user', async () => {
  const h = await harness();
  h.view.hydrate = async () => { throw new Error('reload failed'); };
  await h.view.transferToTopic(h.file(h.loose), { ...TOPIC_V, id: 'map-w', root: `${TOPICS}/map-w` });
  assert.equal(h.view.history.canUndo, true);
  assert.equal(h.exists(h.loose), false, 'the note stays moved');
  assert.deepEqual(h.notices, ['The change was saved, but the view could not refresh. Reopen the map to see it.']);
});
