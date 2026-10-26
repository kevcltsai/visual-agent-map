// MapTransaction module: file moves and Map.md edits commit together, revert together, and undo/redo refuse when stale.
const assert = require('node:assert/strict');
const { integrationTest, fixture, load, obsidian, core, plain, DEFAULT_SETTINGS } = require('../support.cjs');

const { begin, isStaleError, isTransactionError } = load('experiences/visual-map/map-transaction.ts', { obsidian });
const TOPICS = 'Agent Workspace/Topics';
const MAP = `${TOPICS}/map-u/Map.md`, MAP_V = `${TOPICS}/map-v/Map.md`, ARCHIVE = `${TOPICS}/map-u/Archive`;
// setLifecycle rewrites `updated:` and moves the `agent-map-id:` line (same quirk as steps-undo-create); everything else must match.
const stable = text => text.split('\n').filter(line => !/^(updated|agent-map-id):/.test(line)).join('\n');

async function harness() {
  const { repo, app, contents } = fixture('en', { linkIndex: true });
  repo.settings = { ...DEFAULT_SETTINGS, language: 'en' };
  const docs = {};
  for (const [id, path] of [['map-u', MAP], ['map-v', MAP_V]]) {
    docs[id] = { id, title: id, version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
    await repo.ensureTopicFolders(`${TOPICS}/${id}`);
    await app.vault.create(path, core.serializeMap(docs[id]));
  }
  const notes = [];
  for (const title of ['One', 'Two', 'Three']) {
    const node = await repo.createNote(title, 'gpt-6-luna', docs['map-u'], MAP, 'workspace');
    docs['map-u'].nodes.push(node);
    notes.push(node.path);
  }
  await repo.saveMap(MAP, docs['map-u']);
  await repo.rebuildDerivedData();
  const calls = [], fail = {}, counts = { rebuild: 0, applied: [] };
  // A repo whose writes are logged and can be made to fail on the Nth call of a method.
  const spy = Object.create(repo);
  for (const name of ['moveUnique', 'moveExact', 'setLifecycle', 'saveMap']) {
    let n = 0;
    spy[name] = async (...args) => {
      n++;
      calls.push(name);
      if (fail[name]?.(n, args)) throw new Error(`injected ${name} ${n}`);
      return repo[name](...args);
    };
  }
  const deps = {
    repo: spy,
    rebuildDerivedData: async () => {
      counts.rebuild++;
      if (fail.rebuild?.(counts.rebuild)) throw new Error(`injected rebuild ${counts.rebuild}`);
      return repo.rebuildDerivedData();
    },
    onApplied: (mapPath, map) => { counts.applied.push([mapPath, map.nodes.map(n => n.path)]); },
    checkConflict: async mapPath => { if (fail.conflict) throw new Error(`conflict ${mapPath}`); }
  };
  const snapshot = () => new Map([...contents].map(([p, text]) => [p, p.endsWith('Map.md') ? text : stable(text)]));
  const lifecycleOf = async path => { const n = await repo.readNote(path); return [n.topicId, n.mapId, n.topicState]; };
  const archived = () => [...contents.keys()].filter(p => p.startsWith(`${ARCHIVE}/`));
  const exists = path => !!app.vault.getAbstractFileByPath(path);
  return { repo, app, contents, notes, deps, fail, calls, counts, snapshot, lifecycleOf, archived, exists };
}
const park = (h, paths) => paths.reduce((tx, path) => tx.park(path, ARCHIVE, 'map-u', 'archived'), begin(h.deps));
const rejected = async promise => { try { await promise; } catch (error) { return error; } return assert.fail('expected a rejection'); };

integrationTest('map transaction: a failure on the 2nd or the 3rd of three moves restores every file and lifecycle', async () => {
  for (const nth of [2, 3]) {
    const h = await harness();
    const before = h.snapshot();
    h.fail.setLifecycle = n => n === nth;
    const error = await rejected(park(h, h.notes).commit());
    assert.equal(error.message, `injected setLifecycle ${nth}`);
    assert.deepEqual(h.snapshot(), before, `vault equals the state before commit (fail at ${nth})`);
    for (const path of h.notes) assert.deepEqual(await h.lifecycleOf(path), ['map-u', 'map-u', 'active']);
    assert.equal(h.counts.applied.length, 0);
  }
  const h = await harness();
  const before = h.snapshot();
  h.fail.moveUnique = n => n === 2;
  assert.equal((await rejected(park(h, h.notes).commit())).message, 'injected moveUnique 2');
  assert.deepEqual(h.snapshot(), before, 'a failing move restores the one before it');
});

integrationTest('map transaction: a failing restore still restores the rest and throws an AggregateError with the original error first', async () => {
  const h = await harness();
  h.fail.setLifecycle = n => n === 3;
  h.fail.moveExact = n => n === 1; // the restore of the 3rd note's move is its first moveExact
  const error = await rejected(park(h, h.notes).commit());
  assert.equal(error.name, 'AggregateError');
  assert.equal(error.errors[0].message, 'injected setLifecycle 3');
  assert.equal(error.errors[1].message, 'injected moveExact 1');
  assert.equal(error.message, 'Changing the topic state failed and could not be fully undone');
  assert.equal(isTransactionError(error, 'rollback-failed'), true);
  assert.equal(isStaleError(error), false);
  assert.equal(h.counts.applied.length, 0, 'no entry and no onApplied');
  assert.equal(h.exists(h.notes[0]) && h.exists(h.notes[1]), true, 'the notes whose restore worked are back');
  assert.equal(h.exists(h.notes[2]), false, 'only the note whose restore failed stays parked');
  assert.equal(h.archived().length, 1);
});

integrationTest('map transaction: undo with the target moved away or the original taken, and redo likewise, is stale and writes nothing', async () => {
  const rename = (h, from, to) => h.app.vault.rename(h.app.vault.getAbstractFileByPath(from), to);
  const cases = [
    ['undo, target moved away', false, async (h, target) => rename(h, target, `${TOPICS}/elsewhere.md`)],
    ['undo, original taken', false, async h => h.app.vault.create(h.notes[0], 'taken')],
    ['redo, original moved away', true, async h => rename(h, h.notes[0], `${TOPICS}/elsewhere.md`)],
    ['redo, target taken', true, async (h, target) => h.app.vault.create(target, 'taken')]
  ];
  for (const [label, afterUndo, disturb] of cases) {
    const h = await harness();
    const entry = await park(h, [h.notes[0]]).commit();
    const target = h.archived()[0];
    if (afterUndo) await entry.undo();
    await disturb(h, target);
    const before = h.snapshot(), calls = h.calls.length;
    const error = await rejected(afterUndo ? entry.redo() : entry.undo());
    assert.equal(error.kind, 'stale', label);
    assert.equal(isStaleError(error), true);
    assert.equal(error.message, 'This change can no longer be undone or redone because the notes or the map were changed elsewhere.');
    assert.deepEqual(h.snapshot(), before, `${label}: vault unchanged`);
    assert.equal(h.calls.length, calls, `${label}: no write attempted`);
  }
});

integrationTest('map transaction: an outside change to Map.md structure rejects undo; a viewport-only change does not and is kept', async () => {
  const h = await harness();
  const entry = await begin(h.deps).transfer(h.notes[0], { id: 'map-v', root: `${TOPICS}/map-v` }, 'add')
    .editMap(MAP_V, (map, resolve) => map.nodes.push({ id: 'moved', path: resolve(h.notes[0]), parentId: null, x: 1, y: 2, collapsed: false })).commit();
  const afterCommit = await h.repo.readMap(MAP_V);
  const moved = { ...afterCommit, viewport: { x: 50, y: 60, zoom: 2 } };
  await h.repo.saveMap(MAP_V, moved);
  const changed = { ...afterCommit, nodes: [...afterCommit.nodes, { id: 'extra', path: 'x.md', parentId: null, x: 0, y: 0, collapsed: false }] };
  await h.repo.saveMap(MAP_V, changed);
  const before = h.snapshot(), calls = h.calls.length;
  const error = await rejected(entry.undo());
  assert.equal(error.kind, 'stale');
  assert.deepEqual(h.snapshot(), before, 'files and both Map.md files unchanged');
  assert.equal(h.calls.length, calls);
  await h.repo.saveMap(MAP_V, moved); // external edits reverted, only the viewport differs
  await entry.undo();
  const restored = await h.repo.readMap(MAP_V);
  assert.equal(restored.nodes.length, 0);
  assert.deepEqual(plain(restored.viewport), { x: 50, y: 60, zoom: 2 }, 'the viewport on disk survives undo');
  assert.equal(h.exists(h.notes[0]), true);
});

integrationTest('map transaction: rebuild runs 0 times for an edit that keeps ownership, once when ownership changes, never with deferRebuild', async () => {
  let h = await harness();
  await begin(h.deps).editMap(MAP, map => { map.nodes[0].x += 10; }).commit();
  assert.equal(h.counts.rebuild, 0, 'position change only');
  h = await harness();
  await begin(h.deps).editMap(MAP, map => { map.nodes.pop(); }).commit();
  assert.equal(h.counts.rebuild, 1, 'ownership changed');
  h = await harness();
  await begin(h.deps).editMap(MAP, map => { map.nodes.pop(); }).commit({ deferRebuild: true });
  assert.equal(h.counts.rebuild, 0, 'deferred');
  h = await harness();
  const entry = await park(h, [h.notes[0]]).commit();
  assert.equal(h.counts.rebuild, 1, 'a move rebuilds');
  await entry.undo(); await entry.redo();
  assert.equal(h.counts.rebuild, 3, 'undo and redo rebuild once each');
  h = await harness();
  await park(h, [h.notes[0]]).commit({ deferRebuild: true });
  assert.equal(h.counts.rebuild, 0, 'a deferred move leaves the rebuild to the caller');
});

integrationTest('map transaction: across two maps, a failing second saveMap restores both Map.md files and the moved note', async () => {
  const h = await harness();
  const before = h.snapshot();
  let first = true;
  h.fail.saveMap = (n, args) => { if (args[0] !== MAP_V || !first) return false; first = false; return true; };
  const error = await rejected(begin(h.deps)
    .transfer(h.notes[0], { id: 'map-v', root: `${TOPICS}/map-v` }, 'add')
    .editMap(MAP, map => { map.nodes.shift(); })
    .editMap(MAP_V, (map, resolve) => map.nodes.push({ id: 'n', path: resolve(h.notes[0]), parentId: null, x: 0, y: 0, collapsed: false }))
    .commit());
  assert.match(error.message, /^injected saveMap/);
  assert.deepEqual(h.snapshot(), before, 'both maps, the note and its lifecycle are as before');
  assert.deepEqual(await h.lifecycleOf(h.notes[0]), ['map-u', 'map-u', 'active']);
  assert.equal(h.counts.applied.length, 0);
});

integrationTest('map transaction: a checkConflict that throws stops everything before any write', async () => {
  const h = await harness();
  h.fail.conflict = true;
  const before = h.snapshot();
  const error = await rejected(park(h, [h.notes[0]]).editMap(MAP, map => { map.nodes.pop(); }).commit());
  assert.equal(error.message, `conflict ${MAP}`);
  assert.equal(h.calls.length, 0, 'no write call at all');
  assert.deepEqual(h.snapshot(), before);
  assert.equal(h.counts.rebuild, 0);
});

integrationTest('map transaction: undo then redo ends like the commit, apart from the updated and agent-map-id lines', async () => {
  const h = await harness();
  const entry = await begin(h.deps).unpark(h.notes[0], `${TOPICS}/map-v/Notes`, 'map-v', 'map-v')
    .editMap(MAP, (map, resolve) => { map.nodes[0].path = resolve(h.notes[0]); }).commit();
  const committed = new Map([...h.contents]);
  await entry.undo();
  assert.equal(h.exists(h.notes[0]), true);
  assert.deepEqual(await h.lifecycleOf(h.notes[0]), ['map-u', 'map-u', 'active']);
  await entry.redo();
  assert.deepEqual([...h.contents.keys()].sort(), [...committed.keys()].sort());
  for (const [path, text] of committed) {
    assert.equal(stable(h.contents.get(path)), stable(text), path);
    if (path.endsWith('Map.md')) assert.equal(h.contents.get(path), text, 'Map.md is identical');
  }
});

integrationTest('map transaction: a failing rebuild reverts the commit and rebuilds again; a failing rebuild in the revert is an AggregateError', async () => {
  let h = await harness();
  const before = h.snapshot();
  h.fail.rebuild = n => n === 1;
  const error = await rejected(park(h, [h.notes[0]]).commit());
  assert.equal(error.message, 'injected rebuild 1');
  assert.equal(h.counts.rebuild, 2, 'rebuilt once more after the restore');
  assert.deepEqual(h.snapshot(), before);
  assert.equal(h.counts.applied.length, 0);
  h = await harness();
  h.fail.rebuild = () => true;
  const both = await rejected(park(h, [h.notes[0]]).commit());
  assert.equal(both.name, 'AggregateError');
  assert.equal(both.errors[0].message, 'injected rebuild 1');
  assert.equal(both.errors[1].message, 'injected rebuild 2');
  assert.equal(both.kind, 'rollback-failed');
  assert.equal(h.exists(h.notes[0]), true, 'files were restored even though the rebuild could not be');
});

integrationTest('map transaction: onApplied runs once per edited map on commit, undo and redo, with the stored map', async () => {
  const h = await harness();
  const entry = await begin(h.deps)
    .transfer(h.notes[0], { id: 'map-v', root: `${TOPICS}/map-v` }, 'add')
    .editMap(MAP, map => { map.nodes.shift(); })
    .editMap(MAP_V, (map, resolve) => map.nodes.push({ id: 'n', path: resolve(h.notes[0]), parentId: null, x: 0, y: 0, collapsed: false }))
    .commit();
  assert.deepEqual(h.counts.applied.map(([p, paths]) => [p, paths.length]), [[MAP, 2], [MAP_V, 1]]);
  h.counts.applied.length = 0;
  await entry.undo();
  assert.deepEqual(h.counts.applied.map(([p, paths]) => [p, paths.length]), [[MAP, 3], [MAP_V, 0]]);
  h.counts.applied.length = 0;
  await entry.redo();
  assert.deepEqual(h.counts.applied.map(([p, paths]) => [p, paths.length]), [[MAP, 2], [MAP_V, 1]]);
});

integrationTest('map transaction: an edit that throws after the move (relink target missing) leaves the vault untouched', async () => {
  const h = await harness();
  const before = h.snapshot();
  const error = await rejected(begin(h.deps).unpark(h.notes[0], `${TOPICS}/map-u/Notes/sub`, 'map-u', 'map-u')
    .editMap(MAP, () => { throw new Error('node not found'); }).commit());
  assert.equal(error.message, 'node not found');
  assert.deepEqual(h.snapshot(), before);
  assert.equal(h.exists(h.notes[0]), true);
  assert.equal(h.counts.applied.length, 0);
});

integrationTest('map transaction: a taken name gets a unique target, resolve reports it, and a failed undo restores the done part', async () => {
  const h = await harness();
  await h.app.vault.create(`${ARCHIVE}/${h.notes[0].split('/').at(-1)}`, 'occupied');
  let resolved;
  const entry = await begin(h.deps).park(h.notes[0], ARCHIVE, 'map-u', 'archived').park(h.notes[1], ARCHIVE, 'map-u', 'archived')
    .editMap(MAP, (map, resolve) => { resolved = resolve(h.notes[0]); }).commit();
  assert.notEqual(resolved, `${ARCHIVE}/${h.notes[0].split('/').at(-1)}`);
  assert.equal(h.exists(resolved), true);
  const before = h.snapshot();
  h.fail.setLifecycle = n => n === 4; // the second step of the undo (the commit used calls 1 and 2, the first undo step call 3)
  const error = await rejected(entry.undo());
  assert.equal(error.message, 'injected setLifecycle 4');
  assert.deepEqual(h.snapshot(), before, 'a half-applied undo is put back');
  h.fail.setLifecycle = null;
  await entry.undo();
  assert.equal(h.exists(h.notes[0]) && h.exists(h.notes[1]), true);
});

// repository.moveExact/moveUnique relocate the file first and then rewrite source paths; make that second step throw once.
const failAfterRelocate = (h, times = 1) => {
  const original = h.repo.replaceSourcePath;
  let left = times;
  h.repo.replaceSourcePath = async (...args) => {
    if (left-- > 0) throw new Error('injected after relocate');
    return original.apply(h.repo, args);
  };
  return () => { h.repo.replaceSourcePath = original; };
};

integrationTest('map transaction: undo/redo whose moveExact relocates and then throws moves the file back and keeps the plain error', async () => {
  for (const redo of [false, true]) {
    const h = await harness();
    const entry = await park(h, [h.notes[0]]).commit();
    if (redo) await entry.undo();
    const before = h.snapshot();
    const restore = failAfterRelocate(h);
    const error = await rejected(redo ? entry.redo() : entry.undo());
    restore();
    assert.equal(error.message, 'injected after relocate', `redo=${redo}`);
    assert.equal(isTransactionError(error, 'rollback-failed'), false, 'rollback succeeded, so the original error is thrown');
    assert.deepEqual(h.snapshot(), before, `redo=${redo}: the file is back where it was before the step`);
  }
});

integrationTest('map transaction: commit whose moveUnique relocates and then throws reports rollback-failed with the original error first', async () => {
  const h = await harness();
  const restore = failAfterRelocate(h);
  const error = await rejected(park(h, [h.notes[0]]).commit());
  restore();
  assert.equal(isTransactionError(error, 'rollback-failed'), true);
  assert.equal(error.name, 'AggregateError');
  assert.equal(error.errors[0].message, 'injected after relocate');
  assert.equal(h.exists(h.notes[0]), false, 'the new path is unknown, so the file is not guessed back');
  assert.equal(h.counts.applied.length, 0);
});

// ---- ticket 02: node positions are layout; create(path, parkFolder, topicId) ----
const UNASSIGNED = `${TOPICS}/map-u/Unassigned`;
const create = (h, paths) => paths.reduce((tx, path) => tx.create(path, UNASSIGNED, 'map-u'), begin(h.deps));
const unassignedFiles = h => [...h.contents.keys()].filter(p => p.startsWith(`${UNASSIGNED}/`));

integrationTest('map transaction: M1 a position-only change on a node (x/y) does not make undo stale, and undo writes the stored positions back', async () => {
  const h = await harness();
  const positions = plain((await h.repo.readMap(MAP)).nodes.map(n => [n.x, n.y]));
  const entry = await begin(h.deps).editMap(MAP, map => { map.nodes[0].collapsed = true; map.nodes[0].x += 100; }).commit();
  const committed = await h.repo.readMap(MAP);
  committed.nodes[0].x = 777; committed.nodes[1].y = -5; // e.g. respaceBatch
  await h.repo.saveMap(MAP, committed);
  await entry.undo();
  const restored = await h.repo.readMap(MAP);
  assert.equal(restored.nodes[0].collapsed, false);
  assert.deepEqual(plain(restored.nodes.map(n => [n.x, n.y])), positions, 'the positions stored before the step are written back');
});

integrationTest('map transaction: M2 every non-position change to Map.md still makes undo stale and writes nothing', async () => {
  const outside = {
    parentId: map => { map.nodes[1].parentId = map.nodes[0].id; },
    path: map => { map.nodes[0].path = `${TOPICS}/map-u/Notes/other.md`; },
    collapsed: map => { map.nodes[0].collapsed = true; },
    'node added': map => { map.nodes.push({ id: 'extra', path: 'x.md', parentId: null, x: 0, y: 0, collapsed: false }); },
    'node removed': map => { map.nodes.pop(); },
    'node order': map => { map.nodes.reverse(); },
    title: map => { map.title = 'changed outside'; },
    'map setting': map => { map.toneId = 'outside-tone'; },
    aim: map => { map.aim = { version: 1, branches: [], runs: [], pendingCommits: [], minimumAnswersBeforeConclusion: 3 }; }
  };
  for (const [label, change] of Object.entries(outside)) {
    const h = await harness();
    const entry = await begin(h.deps).editMap(MAP, map => { map.nodes[0].x += 10; }).commit();
    const map = await h.repo.readMap(MAP);
    change(map);
    await h.repo.saveMap(MAP, map);
    const before = h.snapshot(), calls = h.calls.length;
    const error = await rejected(entry.undo());
    assert.equal(error.kind, 'stale', `${label}: ${error.message}`);
    assert.deepEqual(h.snapshot(), before, `${label}: vault unchanged`);
    assert.equal(h.calls.length, calls, `${label}: nothing written`);
  }
});

integrationTest('map transaction: M3 create undo, redo, undo parks at the same path both times and the lifecycle follows', async () => {
  const h = await harness();
  const note = h.notes[0];
  const entry = await create(h, [note]).editMap(MAP, map => { map.title = 'renamed'; }).commit();
  assert.deepEqual(await h.lifecycleOf(note), ['map-u', 'map-u', 'active'], 'commit writes no file');
  assert.equal(h.calls.filter(c => c !== 'saveMap').length, 0);
  await entry.undo();
  const parked = unassignedFiles(h);
  assert.equal(parked.length, 1);
  assert.equal(h.exists(note), false);
  assert.deepEqual(await h.lifecycleOf(parked[0]), ['map-u', '', 'unassigned']);
  assert.equal((await h.repo.readMap(MAP)).title, 'map-u');
  await entry.redo();
  assert.equal(h.exists(note), true);
  assert.deepEqual(await h.lifecycleOf(note), ['map-u', 'map-u', 'active']);
  assert.equal((await h.repo.readMap(MAP)).title, 'renamed');
  await entry.undo();
  assert.deepEqual(unassignedFiles(h), parked, 'the second undo parks at the path chosen by the first');
  assert.deepEqual(await h.lifecycleOf(parked[0]), ['map-u', '', 'unassigned']);
});

integrationTest('map transaction: M4 create parks under a free name, and two creates with the same name in one undo get different names', async () => {
  let h = await harness();
  const name = h.notes[0].split('/').at(-1);
  await h.repo.folder(UNASSIGNED);
  await h.app.vault.create(`${UNASSIGNED}/${name}`, 'occupied');
  const entry = await create(h, [h.notes[0]]).commit();
  await entry.undo();
  const parked = unassignedFiles(h).filter(p => p !== `${UNASSIGNED}/${name}`);
  assert.equal(parked.length, 1);
  assert.notEqual(parked[0], `${UNASSIGNED}/${name}`);
  assert.equal(h.contents.get(`${UNASSIGNED}/${name}`), 'occupied', 'the existing file is untouched');

  h = await harness();
  const twin = `${TOPICS}/map-u/Notes/sub/${h.notes[0].split('/').at(-1)}`;
  await h.repo.folder(`${TOPICS}/map-u/Notes/sub`);
  await h.app.vault.rename(h.app.vault.getAbstractFileByPath(h.notes[1]), twin);
  const both = await create(h, [h.notes[0], twin]).commit();
  await both.undo();
  const names = unassignedFiles(h);
  assert.equal(names.length, 2);
  assert.equal(new Set(names).size, 2, 'distinct parking paths');
  assert.equal(h.exists(h.notes[0]) || h.exists(twin), false);
});

integrationTest('map transaction: M5 a file placed on the fixed parking path makes undo stale; no new name is chosen', async () => {
  const h = await harness();
  const entry = await create(h, [h.notes[0]]).commit();
  await entry.undo();
  const parked = unassignedFiles(h)[0];
  await entry.redo();
  await h.app.vault.create(parked, 'external');
  const before = h.snapshot(), calls = h.calls.length;
  const error = await rejected(entry.undo());
  assert.equal(error.kind, 'stale');
  assert.deepEqual(h.snapshot(), before);
  assert.equal(h.calls.length, calls, 'nothing written');
  assert.deepEqual(unassignedFiles(h), [parked], 'no second parking path appeared');
});

integrationTest('map transaction: M6 create redo is stale when the active path is taken or the parked note is gone', async () => {
  const cases = [
    ['active path taken', async (h, parked) => h.app.vault.create(h.notes[0], 'taken')],
    ['parked note moved away', async (h, parked) => h.app.vault.rename(h.app.vault.getAbstractFileByPath(parked), `${TOPICS}/elsewhere.md`)]
  ];
  for (const [label, disturb] of cases) {
    const h = await harness();
    const entry = await create(h, [h.notes[0]]).editMap(MAP, map => { map.title = 'renamed'; }).commit();
    await entry.undo();
    await disturb(h, unassignedFiles(h)[0]);
    const before = h.snapshot(), calls = h.calls.length;
    const error = await rejected(entry.redo());
    assert.equal(error.kind, 'stale', label);
    assert.deepEqual(h.snapshot(), before, label);
    assert.equal(h.calls.length, calls, label);
  }
});

integrationTest('map transaction: M7 a create undo whose Map.md write fails puts the note and lifecycle back; a failing restore is rollback-failed', async () => {
  let h = await harness();
  const entry = await create(h, [h.notes[0]]).editMap(MAP, map => { map.title = 'renamed'; }).commit();
  let before = h.snapshot();
  h.fail.saveMap = (n, args) => args[0] === MAP && !h.fail.done && (h.fail.done = true);
  const error = await rejected(entry.undo());
  assert.match(error.message, /^injected saveMap/);
  assert.equal(isTransactionError(error), false, 'the rollback worked, so the original error is thrown');
  assert.deepEqual(h.snapshot(), before, 'Map.md and the note are as before the undo');
  assert.deepEqual(await h.lifecycleOf(h.notes[0]), ['map-u', 'map-u', 'active']);
  h.fail.saveMap = null;
  await entry.undo(); // the parking path chosen by the rejected attempt is reused
  assert.equal(unassignedFiles(h).length, 1);

  h = await harness();
  const second = await create(h, [h.notes[0]]).editMap(MAP, map => { map.title = 'renamed'; }).commit();
  h.fail.saveMap = (n, args) => args[0] === MAP && !h.fail.done && (h.fail.done = true);
  h.fail.moveExact = n => n === 2; // call 1 is the undo's move, call 2 its restore
  const both = await rejected(second.undo());
  assert.equal(both.name, 'AggregateError');
  assert.equal(both.kind, 'rollback-failed');
  assert.match(both.errors[0].message, /^injected saveMap/);
  assert.match(both.errors[1].message, /^injected moveExact 2/);
});

integrationTest('map transaction: M8 History keeps working with transaction entries: discardSince drops them, collapseSince runs newest first then oldest first', async () => {
  const { History } = load('map-model.ts');
  let h = await harness();
  const history = new History();
  history.push(await park(h, [h.notes[2]]).commit());
  const mark = history.mark();
  history.push(await park(h, [h.notes[0]]).commit());
  history.push(await create(h, [h.notes[1]]).commit());
  const committed = h.snapshot();
  history.discardSince(mark);
  assert.deepEqual(h.snapshot(), committed, 'discarding leaves the vault alone');
  assert.equal(history.canUndo, true);
  await history.undo().undo();
  assert.equal(h.exists(h.notes[2]), true, 'the entry from before the mark still undoes');
  assert.equal(history.canUndo, false);

  h = await harness();
  const batch = new History(), order = [];
  const wrap = (name, entry) => ({ undo: () => { order.push(`undo ${name}`); return entry.undo(); }, redo: () => { order.push(`redo ${name}`); return entry.redo(); } });
  const bMark = batch.mark();
  batch.push(wrap('one', await park(h, [h.notes[0]]).commit()));
  batch.push(wrap('two', await create(h, [h.notes[1]]).commit()));
  batch.collapseSince(bMark);
  await batch.undo().undo();
  assert.deepEqual(order, ['undo two', 'undo one']);
  assert.equal(h.exists(h.notes[0]), true);
  assert.equal(h.exists(h.notes[1]), false, 'the created note is parked');
  await batch.redo().redo();
  assert.deepEqual(order.slice(2), ['redo one', 'redo two']);
  assert.equal(h.exists(h.notes[0]), false);
  assert.equal(h.exists(h.notes[1]), true);
});
