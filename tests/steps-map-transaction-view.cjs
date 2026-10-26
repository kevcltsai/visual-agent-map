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
  for (const name of ['setLifecycle', 'saveMap', 'moveExact', 'moveUnique', 'duplicateNote']) {
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

// removeToUnassigned (MapTransaction 02): a root with a child and a grandchild, plus a sibling to adopt the children.
async function branchHarness() {
  const h = await harness();
  const doc = await h.repo.readMap(MAP);
  const make = async (title, parentId, x, y) => {
    const note = await h.repo.createNote(title, 'gpt-6-luna', doc, MAP, 'workspace');
    return { ...note, parentId, x, y, collapsed: true };
  };
  const child = await make('Child', h.rootNode.id, 300, 0), grand = await make('Grand', child.id, 600, 0), sibling = await make('Sibling', null, 80, 400);
  doc.nodes = [doc.nodes.find(n => n.id === h.rootNode.id), child, grand, sibling];
  await h.repo.saveMap(MAP, doc);
  await h.repo.rebuildDerivedData();
  h.view.map = await h.repo.readMap(MAP);
  await h.view.hydrate();
  h.doc = h.view.map;
  h.node = id => h.view.map.nodes.find(n => n.id === id);
  h.ids = { root: h.rootNode.id, child: child.id, grand: grand.id, sibling: sibling.id };
  return h;
}

test('removeToUnassigned R1: a second setLifecycle that fails puts every note, lifecycle and Map.md back and leaves no entry', async () => {
  const h = await branchHarness();
  const before = h.snapshot(), paths = h.view.map.nodes.map(n => n.path);
  const lifecycles = await Promise.all(paths.map(h.lifecycleOf));
  const root = h.node(h.ids.root);
  h.fail.setLifecycle = n => n === 2;
  const error = await h.rejected(h.view.removeToUnassigned(root, true));
  assert.match(error.message, /injected setLifecycle/);
  assert.deepEqual(h.snapshot(), before, 'Vault equals the state before');
  for (const [i, p] of paths.entries()) assert.deepEqual(await h.lifecycleOf(p), lifecycles[i]);
  assert.equal(h.view.history.canUndo, false);
});

test('removeToUnassigned R2: a rebuild that fails after Map.md is saved restores files, lifecycle and Map.md, with no entry', async () => {
  const h = await branchHarness();
  const before = h.snapshot(), paths = h.view.map.nodes.map(n => n.path);
  const lifecycles = await Promise.all(paths.map(h.lifecycleOf));
  let failed = false;
  h.view.plugin.rebuildDerivedData = async () => { if (!failed) { failed = true; throw new Error('injected rebuild'); } return h.repo.rebuildDerivedData(); };
  const error = await h.rejected(h.view.removeToUnassigned(h.node(h.ids.root), true));
  assert.match(error.message, /injected rebuild/);
  assert.deepEqual(h.snapshot(), before);
  for (const [i, p] of paths.entries()) assert.deepEqual(await h.lifecycleOf(p), lifecycles[i]);
  assert.equal(h.view.history.canUndo, false);
  assert.equal(h.view.map.nodes.length, 4, 'view map is back too');
});

test('removeToUnassigned R3: undo after a parked note was moved away outside refuses with stale and changes nothing', async () => {
  const h = await branchHarness();
  const grandPath = h.node(h.ids.grand).path;
  await h.view.removeToUnassigned(h.node(h.ids.root), true);
  const parked = [...h.contents.keys()].filter(p => p.startsWith(`${TOPICS}/map-u/Unassigned/`));
  assert.equal(parked.length, 3);
  await h.app.vault.rename(h.file(parked[1]), `${TOPICS}/map-u/Moved by hand.md`);
  const before = h.snapshot();
  const error = await h.rejected(h.view.travel(false));
  assert.equal(error.kind, 'stale');
  assert.equal(h.view.history.canUndo, true, 'pointer restored');
  assert.deepEqual(h.snapshot(), before);
  assert.equal(h.exists(grandPath), false);
});

test('removeToUnassigned R4: undo after an unrecorded structural write to Map.md refuses and keeps that write', async () => {
  const h = await branchHarness();
  await h.view.removeToUnassigned(h.node(h.ids.child), false);
  const outside = await h.repo.readMap(MAP);
  outside.title = 'Written by AIM';
  await h.repo.saveMap(MAP, outside);
  h.view.map = await h.repo.readMap(MAP);
  const before = h.snapshot();
  const error = await h.rejected(h.view.travel(false));
  assert.equal(error.kind, 'stale');
  assert.deepEqual(h.snapshot(), before);
  assert.equal((await h.repo.readMap(MAP)).title, 'Written by AIM');
});

test('removeToUnassigned V1: adopter takes the children and expands; undo restores everything and redo returns the removed state', async () => {
  const h = await branchHarness();
  const before = h.snapshot(), original = JSON.stringify(h.view.map);
  const { child, grand, sibling } = h.ids;
  await h.view.removeToUnassigned(h.node(h.ids.root), false, sibling);
  const after = h.snapshot(), afterMap = JSON.stringify(h.view.map);
  assert.equal(h.node(child).parentId, sibling);
  assert.equal(h.node(grand).parentId, child);
  assert.equal(h.node(sibling).collapsed, false);
  assert.equal(h.node(h.ids.root), undefined);
  assert.equal(h.view.selected, null);
  await h.view.travel(false);
  assert.deepEqual(h.snapshot(), before);
  assert.equal(JSON.stringify(h.view.map), original);
  await h.view.travel(true);
  assert.deepEqual(h.snapshot(), after);
  assert.equal(JSON.stringify(h.view.map), afterMap);
});

test('removeToUnassigned V2: undo keeps the viewport the user has panned to', async () => {
  const h = await branchHarness();
  await h.view.removeToUnassigned(h.node(h.ids.sibling), false);
  h.view.map.viewport = { x: 123, y: -45, zoom: 1.5 };
  await h.view.travel(false);
  assert.equal(JSON.stringify(h.view.map.viewport), JSON.stringify({ x: 123, y: -45, zoom: 1.5 }));
  assert.equal(h.view.map.nodes.length, 4);
  await h.view.travel(true);
  assert.equal(JSON.stringify(h.view.map.viewport), JSON.stringify({ x: 123, y: -45, zoom: 1.5 }));
});

// removeSelected and copySelected (MapTransaction 05): one history step through the transaction, no private rollback code.
const UNASSIGNED = `${TOPICS}/map-u/Unassigned/`;
const REFRESH_NOTICE = 'The change was saved, but the view could not refresh. Reopen the map to see it.';
const parkedPaths = h => [...h.contents.keys()].filter(p => p.startsWith(UNASSIGNED));
const removeBranch = async (h, id) => { h.view.multiSelected.clear(); h.view.multiSelected.add(id); await h.view.removeSelected(); };
const copyBranch = async (h, id, targetId) => { h.view.multiSelected.clear(); h.view.multiSelected.add(id); await h.view.copySelected(h.node(targetId)); };

test('X1: removeSelected then a parked note moved away: undo is stale, nothing is written, the pointer is back', async () => {
  const h = await branchHarness();
  await removeBranch(h, h.ids.child);
  const parked = parkedPaths(h);
  assert.equal(parked.length, 2);
  await h.app.vault.rename(h.file(parked[1]), `${TOPICS}/map-u/Moved by hand.md`);
  const before = h.snapshot();
  const error = await h.rejected(h.view.travel(false));
  assert.equal(error.kind, 'stale');
  assert.equal(h.view.history.canUndo, true);
  assert.deepEqual(h.snapshot(), before);
});

test('X2: removeSelected then an unrecorded structural write to Map.md: undo is stale and keeps that write', async () => {
  const h = await branchHarness();
  await removeBranch(h, h.ids.sibling);
  const outside = await h.repo.readMap(MAP);
  outside.title = 'Written elsewhere';
  await h.repo.saveMap(MAP, outside);
  h.view.map = await h.repo.readMap(MAP);
  const before = h.snapshot();
  const error = await h.rejected(h.view.travel(false));
  assert.equal(error.kind, 'stale');
  assert.deepEqual(h.snapshot(), before);
  assert.equal((await h.repo.readMap(MAP)).title, 'Written elsewhere');
});

test('X3: removeSelected, pan, undo, redo: the viewport stays where the user panned', async () => {
  const h = await branchHarness();
  await removeBranch(h, h.ids.sibling);
  const panned = { x: 123, y: -45, zoom: 1.5 };
  h.view.map.viewport = { ...panned };
  await h.view.travel(false);
  assert.deepEqual(JSON.parse(JSON.stringify(h.view.map.viewport)), panned);
  assert.equal(h.view.map.nodes.length, 4);
  await h.view.travel(true);
  assert.deepEqual(JSON.parse(JSON.stringify(h.view.map.viewport)), panned);
  assert.equal(h.view.map.nodes.length, 3);
});

test('X4: removeSelected checks Map.md for outside edits once before writing', async () => {
  const h = await branchHarness();
  const outside = await h.repo.readMap(MAP);
  outside.title = 'Edited elsewhere';
  await h.repo.saveMap(MAP, outside);
  let asked = 0;
  h.view.resolveMapConflict = async () => { asked++; return false; };
  await removeBranch(h, h.ids.sibling);
  assert.equal(asked, 1);
  assert.equal((await h.repo.readMap(MAP)).title, 'Edited elsewhere');
});

test('X5: removeSelected whose reload fails keeps the change and its entry and tells the user', async () => {
  const h = await branchHarness();
  h.view.hydrate = async () => { throw new Error('reload failed'); };
  await removeBranch(h, h.ids.sibling);
  assert.deepEqual(h.notices, [REFRESH_NOTICE]);
  assert.equal((await h.repo.readMap(MAP)).nodes.some(n => n.id === h.ids.sibling), false);
  assert.equal(h.view.history.canUndo, true);
});

test('X6: removeSelected whose second setLifecycle and whose restore both fail reports rollback-failed and leaves no entry', async () => {
  const h = await branchHarness();
  const entries = h.view.history.past.length;
  h.fail.setLifecycle = n => n === 2;
  h.fail.moveExact = () => true;
  const error = await h.rejected(removeBranch(h, h.ids.child));
  assert.ok(Array.isArray(error.errors), 'an AggregateError');
  assert.equal(error.message, 'Batch removal failed and could not be fully undone');
  assert.equal(error.kind, 'rollback-failed');
  assert.equal(h.view.history.past.length, entries);
});

test('X7: copySelected, undo, a parked copy moved away, redo: stale and nothing is written', async () => {
  const h = await branchHarness();
  await copyBranch(h, h.ids.child, h.ids.sibling);
  assert.equal(h.view.map.nodes.length, 6);
  await h.view.travel(false);
  const parked = parkedPaths(h);
  assert.equal(parked.length, 2);
  await h.app.vault.rename(h.file(parked[0]), `${TOPICS}/map-u/Moved by hand.md`);
  const before = h.snapshot();
  const error = await h.rejected(h.view.travel(true));
  assert.equal(error.kind, 'stale');
  assert.deepEqual(h.snapshot(), before);
});

test('X8: copySelected, undo, redo, the fixed parking path taken by another file: undo is stale', async () => {
  const h = await branchHarness();
  await copyBranch(h, h.ids.child, h.ids.sibling);
  await h.view.travel(false);
  const parked = parkedPaths(h);
  await h.view.travel(true);
  assert.equal(parkedPaths(h).length, 0);
  await h.app.vault.create(parked[0], 'taken');
  const before = h.snapshot();
  const error = await h.rejected(h.view.travel(false));
  assert.equal(error.kind, 'stale');
  assert.deepEqual(h.snapshot(), before);
});

test('X9: copySelected whose reload fails keeps the change and its entry and tells the user', async () => {
  const h = await branchHarness();
  h.view.hydrate = async () => { throw new Error('reload failed'); };
  await copyBranch(h, h.ids.child, h.ids.sibling);
  assert.deepEqual(h.notices, [REFRESH_NOTICE]);
  assert.equal((await h.repo.readMap(MAP)).nodes.length, 6);
  assert.equal(h.view.history.canUndo, true);
});

test('X10: copySelected whose saveMap and parking both fail reports rollback-failed and keeps the copies', async () => {
  const h = await branchHarness();
  const entries = h.view.history.past.length;
  let armed = false;
  h.fail.saveMap = (n, [path]) => path === MAP && (armed = true);
  h.fail.moveUnique = () => armed;
  const error = await h.rejected(copyBranch(h, h.ids.child, h.ids.sibling));
  assert.ok(Array.isArray(error.errors), 'an AggregateError');
  assert.equal(error.message, 'Batch copy failed and could not be fully undone');
  assert.equal(error.kind, 'rollback-failed');
  assert.equal(h.view.history.past.length, entries);
  assert.equal([...h.contents.keys()].filter(p => /copy/i.test(p)).length, 2, 'the copies are still there');
});

test('X11: undo of a copy whose Map.md write and restore both fail reports rollback-failed; a write failure alone puts the copies back', async () => {
  const both = await branchHarness();
  await copyBranch(both, both.ids.child, both.ids.sibling);
  let armed = false;
  both.fail.saveMap = (n, [path]) => path === MAP && (armed = true);
  both.fail.moveExact = () => armed;
  const error = await both.rejected(both.view.travel(false));
  assert.ok(Array.isArray(error.errors), 'an AggregateError');
  assert.equal(error.message, 'Undoing the copy failed and could not be fully restored');
  assert.equal(error.kind, 'rollback-failed');

  const h = await branchHarness();
  await copyBranch(h, h.ids.child, h.ids.sibling);
  const copyNodes = h.view.map.nodes.filter(n => ![h.ids.root, h.ids.child, h.ids.grand, h.ids.sibling].includes(n.id));
  assert.equal(copyNodes.length, 2);
  const after = h.contents.get(MAP);
  h.fail.saveMap = (n, [path]) => path === MAP;
  const failure = await h.rejected(h.view.travel(false));
  assert.match(failure.message, /injected saveMap/);
  for (const node of copyNodes) {
    assert.equal(h.exists(node.path), true, 'the copy is back at its path');
    assert.deepEqual((await h.lifecycleOf(node.path)).slice(2), ['active']);
  }
  assert.equal(h.contents.get(MAP), after, 'Map.md is the state after the copy');
  assert.equal(h.view.history.canUndo, true, 'pointer restored');
});

test('X12: AIM removeSelected of a removable question branch: undo brings the branch back', async () => {
  const h = await branchHarness();
  const doc = await h.repo.readMap(MAP);
  doc.nodes.find(n => n.id === h.ids.child).aimKind = 'question';
  doc.aim = {
    version: 1,
    branches: [{ id: 'b1', questionNodeId: h.ids.child, parentBranchId: null, answerSnapshot: { selections: [], freeText: '' }, inputSnapshot: { topic: 't', conditions: {}, upstreamResults: [] }, createdAt: '2026-01-01T00:00:00.000Z', results: [] }],
    runs: [],
    pendingCommits: []
  };
  await h.repo.saveMap(MAP, doc);
  h.view.map = await h.repo.readMap(MAP);
  await h.view.hydrate();
  const original = JSON.stringify(h.view.map.aim);
  await removeBranch(h, h.ids.child);
  assert.equal(h.view.map.aim.branches.length, 0);
  await h.view.travel(false);
  assert.equal(JSON.stringify(h.view.map.aim), original);
  assert.equal(h.view.map.nodes.length, 4);
});
