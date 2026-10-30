// MapTransaction 03: importing an outline into the open map runs as one transaction (created notes, Map.md edit and
// derived-data rebuild). Any failure rolls the whole import back: Map.md as before, the new notes in the trash.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, fixture, DEFAULT_SETTINGS, obsidian, core, withExpansionCoordinator } = require('./support.cjs');
const dom = require('./support-dom.cjs');
const { element } = dom;
// setLifecycle rewrites `updated:` and moves the `agent-map-id:` line (known quirk); only `updated:` is ignored here.
const stable = text => text.split('\n').filter(line => !/^updated:/.test(line)).join('\n');
const stableUndo = text => text.split('\n').filter(line => !/^(updated|agent-map-id):/.test(line)).join('\n');
const MAP = 'Agent Workspace/Topics/map-u/Map.md';
const TRASH = '.trash/';

async function harness() {
  const { repo, app, contents } = fixture('en', { linkIndex: true });
  // renameFile is what opens the Update links dialog; undo and redo must never go through it.
  const calls = { file: [] };
  const fileRename = app.fileManager.renameFile;
  app.fileManager.renameFile = async (item, target) => { calls.file.push([item.path, target]); return fileRename(item, target); };
  const settings = { ...DEFAULT_SETTINGS, language: 'en', cliModel: 'gpt-6-luna' };
  repo.settings = settings;
  const mapDoc = { id: 'map-u', title: 'Undo', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  await repo.ensureTopicFolders('Agent Workspace/Topics/map-u');
  const root = await repo.createNote('Root', 'gpt-6-luna', mapDoc, MAP, 'workspace');
  mapDoc.nodes.push(root);
  await app.vault.create(MAP, core.serializeMap(mapDoc));
  await repo.rebuildDerivedData();
  // The fixture's trashFile is a no-op; here it moves the file to .trash/ like Obsidian's "Deleted files" setting.
  const trashFailures = new Set();
  app.fileManager.trashFile = async file => {
    if (trashFailures.has(file.path)) throw new Error(`trash failed: ${file.path}`);
    await app.vault.rename(file, `${TRASH}${file.path}`);
  };
  const spy = Object.create(repo);
  const notices = [], researched = [];
  class Modal extends dom.makeModal() { open() { super.open(); this.close(); } }
  const { VisualAgentMapView } = load('main.ts', { obsidian: { ...obsidian, Modal, Notice: dom.makeNotice(notices) } }, { createFragment: dom.createFragment });
  const plugin = withExpansionCoordinator({
    repo: spy, settings, running: new Set(), logs: { appendLog() {} }, rebuildDerivedData: () => repo.rebuildDerivedData(), relevanceGrades: new Map(), expansionBatches: new Map(), pendingSuggestions: new Map(), releaseOutline() {}, setOutlineActive() {}, detailsShown: () => false,
    mutate: async work => { await work(); }, confirmAiUsage: async (model, run) => { await run(); return true; }
  });
  const view = new VisualAgentMapView({ app }, plugin);
  view.path = MAP; view.map = await repo.readMap(MAP); view.contentEl = element('div'); view.stageEl = element('div');
  view.focusNode = () => {}; view.openDetails = () => {}; view.render = () => {};
  view.outlineImportTarget = () => ({ map: 'editable' });
  view.startShallowResearch = async (parent, children) => { researched.push({ parent: parent.id, children: children.map(child => child.id) }); };
  view.hydrate = async () => { view.notes = new Map((await Promise.all(view.map.nodes.map(async n => [n.id, await repo.readNote(n.path).catch(() => null)]))).filter(e => e[1])); };
  await view.hydrate();
  const notesIn = folder => [...contents.keys()].filter(p => p.startsWith(`Agent Workspace/Topics/map-u/${folder}/`) && p.endsWith('.md'));
  const trashed = () => [...contents.keys()].filter(p => p.startsWith(TRASH));
  const orphans = () => notesIn('Notes').filter(p => /agent-map-node/.test(contents.get(p)) && /agent-map-id: map-u/.test(contents.get(p)) && !view.map.nodes.some(n => n.path === p));
  // The whole fake vault except the trash: path -> content (Map.md byte for byte, notes without the `updated:` line).
  const snapshot = () => new Map([...contents].filter(([p]) => !p.startsWith(TRASH)).map(([p, text]) => [p, p === MAP ? text : stable(text)]));
  const rejected = async promise => { try { await promise; } catch (error) { return error; } return assert.fail('expected a rejection'); };
  return { repo, spy, app, contents, view, plugin, calls, notices, researched, trashFailures, root: view.map.nodes[0], notesIn, trashed, orphans, snapshot, rejected };
}

const outline = (...titles) => titles.map((title, index) => ({ index, title, level: 1, parent: null, line: index }));
// One top heading with three children: the third createNote call is the second child.
const tree4 = [{ index: 0, title: 'R', level: 1, parent: null, line: 0 }, ...['A', 'B', 'C'].map((title, i) => ({ index: i + 1, title, level: 2, parent: 0, line: i + 1 }))];
const request = (nodes, extra = {}) => ({ nodes, source: null, shallowResearch: false, ...extra });
const placementOf = (h, kind) => (kind === 'tree' ? { kind } : { kind, parentId: h.root.id });
const imported = h => h.view.map.nodes.filter(n => n.id !== h.root.id);
const failOnce = (target, name, error, at = 1) => { const original = target[name].bind(target); let calls = 0; target[name] = async (...args) => { calls++; if (calls === at) throw error; return original(...args); }; };

// Shared expectations of a rolled-back import: Vault and Map.md as before, nothing in history or Notes, no research.
function assertRolledBack(h, before, entries, label) {
  assert.deepEqual(h.snapshot(), before, `${label}: Vault and Map.md are as before the import`);
  assert.equal(h.view.history.past.length, entries, `${label}: history unchanged`);
  assert.equal(h.view.map.nodes.length, 1, `${label}: the map is unchanged`);
  assert.deepEqual([...h.view.notes.keys()], [h.root.id], `${label}: view.notes has no new id`);
  assert.deepEqual(h.researched, [], `${label}: no research`);
  assert.deepEqual(h.orphans(), [], `${label}: no orphan note`);
}

test('I1: an outline import into a new tree is one undo step; undo parks all five, redo returns to the exact paths, the second undo parks at the same paths', async () => {
  const h = await harness();
  const entries = h.view.history.past.length;
  await h.view.importOutlineIntoMap(request(outline('Topic', 'Topic', 'Three', 'Four', 'Five')), { kind: 'tree' });
  assert.equal(h.view.map.nodes.length, 6);
  assert.equal(h.view.history.past.length, entries + 1, 'one history step');
  const paths = imported(h).map(n => n.path).sort();
  const texts = new Map(paths.map(p => [p, h.contents.get(p)]));
  await h.view.travel(false);
  assert.equal(h.view.map.nodes.length, 1);
  assert.deepEqual(h.orphans(), []);
  const parked = h.notesIn('Unassigned').sort();
  assert.equal(parked.length, 5, 'all five incl. the two with the same title');
  assert.equal(h.calls.file.length, 0, 'no Update links dialog');
  for (const p of parked) assert.match(h.contents.get(p), /topic-state: unassigned/);
  const structure = JSON.stringify(h.view.map.nodes.map(n => [n.id, n.parentId]));
  assert.equal(structure, JSON.stringify([[h.root.id, null]]), 'Map.md structure equals the one before the import');
  await h.view.travel(true);
  assert.deepEqual(imported(h).map(n => n.path).sort(), paths, 'redo restores the exact paths');
  for (const p of paths) { assert.match(h.contents.get(p), /topic-state: active/); assert.equal(stableUndo(h.contents.get(p)), stableUndo(texts.get(p))); }
  assert.equal(h.notesIn('Unassigned').length, 0);
  await h.view.travel(false);
  assert.deepEqual(h.notesIn('Unassigned').sort(), parked, 'the second undo parks at the same paths');
  assert.deepEqual(h.orphans(), [], 'the second undo leaves no note in Notes');
  assert.equal(h.calls.file.length, 0, 'no Update links dialog after redo and the second undo');
});

for (const kind of ['tree', 'under']) {
  test(`I2 (${kind}): the third createNote fails; the import rejects with the reason and the Vault and Map.md are as before`, async () => {
    const h = await harness();
    const before = h.snapshot(), entries = h.view.history.past.length;
    failOnce(h.spy, 'createNote', new Error('disk full'), 3);
    const error = await h.rejected(h.view.importOutlineIntoMap(request(tree4, { shallowResearch: true }), placementOf(h, kind)));
    assert.match(error.message, /disk full/);
    assertRolledBack(h, before, entries, kind);
    assert.equal(h.trashed().length, 2, 'the two notes made so far went to the trash');
    assert.deepEqual(h.notices, [], 'no Notice');
  });

  test(`I3 (${kind}): the second updateNote fails (template and tone chosen); same rollback`, async () => {
    const h = await harness();
    const before = h.snapshot(), entries = h.view.history.past.length;
    failOnce(h.spy, 'updateNote', new Error('update failed'), 2);
    const error = await h.rejected(h.view.importOutlineIntoMap(request(tree4, { shallowResearch: true, detailTemplateId: 'standard', toneId: 'neutral' }), placementOf(h, kind)));
    assert.match(error.message, /update failed/);
    assertRolledBack(h, before, entries, kind);
    assert.deepEqual(h.notices, []);
  });
}

test('I4: saveMap fails (locked); the import rejects with locked, the selection stays, the Vault is as before', async () => {
  const h = await harness();
  h.view.selected = h.root.id;
  const before = h.snapshot(), entries = h.view.history.past.length;
  failOnce(h.spy, 'saveMap', new Error('locked'));
  const error = await h.rejected(h.view.importOutlineIntoMap(request(tree4, { shallowResearch: true }), { kind: 'under', parentId: h.root.id }));
  assert.match(error.message, /locked/);
  assertRolledBack(h, before, entries, 'saveMap');
  assert.equal(h.view.selected, h.root.id, 'selection unchanged');
  assert.equal(h.trashed().length, 4);
  assert.deepEqual(h.notices, []);
});

test('I5: the rebuild fails after Map.md was saved (the one on rollback works); no entry, Map.md as before byte for byte, the notes are in the trash', async () => {
  const h = await harness();
  const before = h.snapshot(), entries = h.view.history.past.length;
  failOnce(h.plugin, 'rebuildDerivedData', new Error('injected rebuild'));
  const error = await h.rejected(h.view.importOutlineIntoMap(request(outline('Topic', 'Two', 'Three')), { kind: 'tree' }));
  assert.match(error.message, /injected rebuild/);
  assertRolledBack(h, before, entries, 'rebuild');
  assert.equal(h.contents.get(MAP), before.get(MAP), 'Map.md byte for byte');
  assert.equal(h.trashed().length, 3);
  assert.equal(h.view.history.canUndo, false);
});

test('I6: saveMap fails and one note cannot be trashed; the import ends without rejecting, one Notice lists only that path, the rest are trashed', async () => {
  const h = await harness();
  const before = h.snapshot(), entries = h.view.history.past.length;
  // The paths are only known after creation: fail the trash of the second created note.
  const create = h.spy.createNote.bind(h.spy); let made = 0, stuck = '';
  h.spy.createNote = async (...args) => { const note = await create(...args); if (++made === 2) stuck = note.path; return note; };
  const trash = h.app.fileManager.trashFile;
  h.app.fileManager.trashFile = async file => { if (file.path === stuck) throw new Error('cannot trash'); return trash(file); };
  failOnce(h.spy, 'saveMap', new Error('locked'));
  await h.view.importOutlineIntoMap(request(outline('One', 'Two', 'Three'), { shallowResearch: true }), { kind: 'tree' });
  assert.equal(h.notices.length, 1, h.notices.join(' | '));
  assert.match(h.notices[0], /could not be saved: .*locked \(/);
  assert.ok(h.notices[0].includes(stuck), 'the stuck path is listed');
  assert.equal((h.notices[0].match(/\.md/g) ?? []).length, 1, 'only the stuck path');
  assert.equal(h.trashed().length, 2, 'the others are in the trash');
  assert.equal(h.contents.has(stuck), true);
  assert.equal(h.contents.get(MAP), before.get(MAP), 'Map.md as before');
  assert.equal(h.view.history.past.length, entries, 'no entry');
  assert.deepEqual(h.researched, [], 'no research');
});

test('I7: Map.md was saved and cannot be put back (rollback-failed); the notes it references stay, one Notice lists them, no entry, no dangling reference', async () => {
  const h = await harness();
  const entries = h.view.history.past.length;
  h.plugin.rebuildDerivedData = async () => { throw new Error('injected rebuild'); };
  failOnce(h.spy, 'saveMap', new Error('cannot restore'), 2);
  await h.view.importOutlineIntoMap(request(outline('One', 'Two', 'Three'), { shallowResearch: true }), { kind: 'tree' });
  assert.equal(h.notices.length, 1, h.notices.join(' | '));
  assert.match(h.notices[0], /could not be saved: /);
  const disk = await h.repo.readMap(MAP);
  assert.equal(disk.nodes.length, 4, 'the saved Map.md still holds the import');
  for (const node of disk.nodes) {
    assert.equal(h.contents.has(node.path), true, `${node.path} exists`);
    if (node.id !== h.root.id) assert.ok(h.notices[0].includes(node.path), `${node.path} is listed`);
  }
  assert.deepEqual(h.trashed(), [], 'nothing was trashed');
  assert.equal(h.view.history.past.length, entries, 'no entry');
  assert.deepEqual(h.researched, []);
});

test('I8: an outside edit of Map.md after an import - undo and (on another round) redo keep the outside node, clear history and leave no orphan', async () => {
  for (const side of ['undo', 'redo']) {
    const h = await harness();
    await h.view.importOutlineIntoMap(request(outline('Topic', 'Two')), { kind: 'tree' });
    if (side === 'redo') await h.view.travel(false);
    const disk = await h.repo.readMap(MAP);
    const outside = await h.repo.createNote('Outside', 'gpt-6-luna', disk, MAP, 'workspace');
    Object.assign(outside, { parentId: h.root.id, x: 400, y: 600 });
    disk.nodes.push(outside);
    await h.repo.saveMap(MAP, disk);
    await h.view.travel(side === 'redo');
    assert.equal(h.view.map.nodes.some(n => n.id === outside.id), true, `${side}: kept in the view`);
    assert.equal((await h.repo.readMap(MAP)).nodes.some(n => n.id === outside.id), true, `${side}: kept on disk`);
    assert.equal(h.view.history.canUndo, false, side); assert.equal(h.view.history.canRedo, false, side);
    assert.deepEqual(h.orphans(), [], side);
    assert.equal(h.contents.has(outside.path), true, side);
  }
});

test('I9: an unrecorded structural write after an import makes undo refuse (stale), writes nothing and restores the pointer', async () => {
  const h = await harness();
  await h.view.importOutlineIntoMap(request(outline('Topic', 'Two')), { kind: 'tree' });
  const disk = await h.repo.readMap(MAP);
  disk.nodes[0].collapsed = true;
  await h.repo.saveMap(MAP, disk);
  h.view.map = await h.repo.readMap(MAP);
  const before = h.snapshot();
  const error = await h.rejected(h.view.travel(false));
  assert.equal(error.kind, 'stale');
  assert.deepEqual(h.snapshot(), before);
  assert.equal(h.view.history.canUndo, true, 'pointer restored');
  assert.equal(h.view.map.nodes.length, 3);
  assert.equal(imported(h).every(n => h.view.notes.has(n.id)), true, 'the new notes stay in view.notes');
});

test('I10: a new note moved away outside makes undo stale; a parked note moved away makes redo stale; nothing is written and the pointer is restored', async () => {
  const MOVED = 'Agent Workspace/Topics/map-u/Moved by hand.md';
  const comparable = h => { const all = h.snapshot(); all.delete(MOVED); return all; };
  const h = await harness();
  await h.view.importOutlineIntoMap(request(outline('Topic', 'Two', 'Three')), { kind: 'tree' });
  await h.app.vault.rename(h.app.vault.getAbstractFileByPath(imported(h)[1].path), MOVED);
  let before = comparable(h);
  let error = await h.rejected(h.view.travel(false));
  assert.equal(error.kind, 'stale');
  assert.deepEqual(comparable(h), before);
  assert.equal(h.view.history.canUndo, true);
  assert.equal(h.view.map.nodes.length, 4);
  const g = await harness();
  await g.view.importOutlineIntoMap(request(outline('Topic', 'Two', 'Three')), { kind: 'tree' });
  await g.view.travel(false);
  const parked = g.notesIn('Unassigned').sort();
  await g.app.vault.rename(g.app.vault.getAbstractFileByPath(parked[1]), MOVED);
  before = comparable(g);
  error = await g.rejected(g.view.travel(true));
  assert.equal(error.kind, 'stale');
  assert.deepEqual(comparable(g), before);
  assert.equal(g.view.history.canRedo, true, 'Redo is still available');
  assert.equal(g.view.map.nodes.length, 1);
});

test('I11: a coordinates-only write after an import does not block undo (D-2026-10-297); Map.md returns to the structure before the import', async () => {
  const h = await harness();
  await h.view.importOutlineIntoMap(request(outline('Topic', 'Two', 'Three')), { kind: 'tree' });
  const respaced = await h.repo.readMap(MAP);
  for (const node of respaced.nodes) { node.x += 7; node.y += 11; }
  await h.repo.saveMap(MAP, respaced);
  h.view.map = await h.repo.readMap(MAP);
  await h.view.travel(false);
  assert.equal(h.view.map.nodes.length, 1);
  assert.equal((await h.repo.readMap(MAP)).nodes.length, 1);
  assert.equal(h.notesIn('Unassigned').length, 3, 'the notes are parked');
  assert.deepEqual(h.orphans(), []);
});
