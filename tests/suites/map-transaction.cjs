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
