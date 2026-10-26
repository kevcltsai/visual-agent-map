// MapTransaction 04, Packet 1: rewriteNote in the transaction module (parent note rewritten together with moves and Map.md).
// Real Repository (link index on); failures are injected through a spy repo. Undo writes the original text AFTER the moves, redo
// writes BEFORE them, and an edited note refuses with kind "guard" before the stale checks run.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, load, obsidian, core, DEFAULT_SETTINGS } = require('./support.cjs');

const { begin, isTransactionError } = load('experiences/visual-map/map-transaction.ts', { obsidian });
const TOPICS = 'Agent Workspace/Topics';
const MAP = `${TOPICS}/map-u/Map.md`;
const UNASSIGNED = `${TOPICS}/map-u/Unassigned`;
const stale = 'This change can no longer be undone or redone because the notes or the map were changed elsewhere.';

async function harness() {
  const { repo, app, contents } = fixture('en', { linkIndex: true });
  repo.settings = { ...DEFAULT_SETTINGS, language: 'en' };
  const doc = { id: 'map-u', title: 'map-u', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  await repo.ensureTopicFolders(`${TOPICS}/map-u`);
  await app.vault.create(MAP, core.serializeMap(doc));
  const nodes = [];
  for (const title of ['Parent', 'Child A', 'Child B']) {
    const node = await repo.createNote(title, 'gpt-6-luna', doc, MAP, 'workspace');
    node.parentId = nodes.length ? nodes[0].id : null;
    doc.nodes.push(node);
    nodes.push(node);
  }
  await repo.saveMap(MAP, doc);
  const [parent, a, b] = nodes.map(n => n.path);
  await repo.updateNote(parent, { summary: 'Parent summary', detail: `Parent detail\n\nSee [[Child A]] and [[Child B]].` });
  await repo.rebuildDerivedData();
  const calls = [], fail = {}, state = { rebuild: 0 };
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
    rebuildDerivedData: async () => { state.rebuild++; if (fail.rebuild?.(state.rebuild)) throw new Error(`injected rebuild ${state.rebuild}`); return repo.rebuildDerivedData(); },
    onApplied: () => {},
    checkConflict: async () => {}
  };
  const writes = [];
  const write = async path => { writes.push(path); await repo.updateNote(path, { summary: 'Merged summary', detail: 'Merged detail\n\nSee [[Child A]].' }); };
  const merge = () => begin(deps).rewriteNote(parent, write).park(a, UNASSIGNED, 'map-u', 'unassigned').park(b, UNASSIGNED, 'map-u', 'unassigned')
    .editMap(MAP, (map, resolve) => { for (const node of map.nodes) if (node.path === a || node.path === b) node.path = resolve(node.path); });
  const snapshot = () => new Map(contents);
  const rejected = async promise => { try { await promise; } catch (error) { return error; } return assert.fail('expected a rejection'); };
  const exists = path => !!app.vault.getAbstractFileByPath(path);
  const unassigned = () => [...contents.keys()].filter(p => p.startsWith(`${UNASSIGNED}/`));
  return { repo, app, contents, parent, a, b, deps, fail, calls, writes, merge, snapshot, rejected, exists, unassigned };
}

test('N1: commit, undo, redo, undo restores the parent text byte for byte and redo passes the guard', async () => {
  const h = await harness();
  const original = h.contents.get(h.parent);
  const entry = await h.merge().commit({ label: 'Merge' });
  const merged = h.contents.get(h.parent);
  assert.notEqual(merged, original);
  assert.match(merged, /Merged summary/);
  assert.equal(entry.label, 'Merge');
  await entry.undo();
  assert.equal(h.contents.get(h.parent), original, 'undo restores the original text');
  assert.equal(h.unassigned().length, 0);
  await entry.redo();
  assert.equal(h.writes.length, 2, 'redo ran write again');
  assert.match(h.contents.get(h.parent), /Merged summary/);
  assert.equal(h.unassigned().length, 2);
  await entry.undo();
  assert.equal(h.contents.get(h.parent), original);
});

test('N2: an edit of the summary after commit makes undo refuse with kind guard and writes nothing', async () => {
  const h = await harness();
  const entry = await h.merge().commit();
  await h.repo.updateNote(h.parent, { summary: 'Edited by hand' });
  const before = h.snapshot(), calls = h.calls.length;
  const error = await h.rejected(entry.undo());
  assert.equal(error.kind, 'guard');
  assert.equal(isTransactionError(error, 'guard'), true);
  assert.equal(error.message, stale);
  assert.deepEqual(h.snapshot(), before, 'note, files and Map.md are unchanged');
  assert.equal(h.calls.length, calls, 'no write attempted');
});

test('N3: an edit of the detail after undo makes redo refuse with kind guard and writes nothing', async () => {
  const h = await harness();
  const entry = await h.merge().commit();
  await entry.undo();
  await h.repo.updateNote(h.parent, { detail: 'Edited detail' });
  const before = h.snapshot(), writes = h.writes.length, calls = h.calls.length;
  const error = await h.rejected(entry.redo());
  assert.equal(error.kind, 'guard');
  assert.deepEqual(h.snapshot(), before);
  assert.equal(h.writes.length, writes, 'write was not run');
  assert.equal(h.calls.length, calls);
});

test('N4: guard beats stale when both apply; with only a moved file the error is stale', async () => {
  const both = await harness();
  const entry = await both.merge().commit();
  const parked = both.unassigned()[0];
  await both.app.vault.rename(both.app.vault.getAbstractFileByPath(parked), `${TOPICS}/elsewhere.md`);
  await both.repo.updateNote(both.parent, { summary: 'Edited by hand' });
  assert.equal((await both.rejected(entry.undo())).kind, 'guard');
  const only = await harness();
  const second = await only.merge().commit();
  await only.app.vault.rename(only.app.vault.getAbstractFileByPath(only.unassigned()[0]), `${TOPICS}/elsewhere.md`);
  const before = only.snapshot();
  assert.equal((await only.rejected(second.undo())).kind, 'stale');
  assert.deepEqual(only.snapshot(), before);
});

test('N5: a failing 2nd setLifecycle restores note, files and Map.md; a failing restore throws rollback-failed with the original first', async () => {
  const h = await harness();
  const before = h.snapshot();
  h.fail.setLifecycle = n => n === 2;
  const error = await h.rejected(h.merge().commit());
  assert.equal(error.message, 'injected setLifecycle 2');
  assert.equal(error.kind, undefined);
  assert.equal(h.contents.get(h.parent), before.get(h.parent), 'parent text restored byte for byte');
  assert.equal(h.exists(h.a) && h.exists(h.b), true, 'files back');
  assert.equal(h.contents.get(MAP), before.get(MAP), 'Map.md untouched');
  const h2 = await harness();
  const original = h2.contents.get(h2.parent);
  h2.fail.setLifecycle = n => n === 2;
  h2.fail.moveExact = n => n === 1; // the restore of the 2nd move is the first moveExact
  const failed = await h2.rejected(h2.merge().commit());
  assert.equal(failed.name, 'AggregateError');
  assert.equal(failed.kind, 'rollback-failed');
  assert.equal(failed.errors[0].message, 'injected setLifecycle 2');
  assert.equal(h2.contents.get(h2.parent), original, 'the note is restored even though a file restore failed');
});

test('N6: undo that fails writing Map.md puts back the merged note, the parked files and Map.md, and can be retried', async () => {
  const h = await harness();
  const entry = await h.merge().commit();
  const merged = h.snapshot();
  let armed = true;
  h.fail.saveMap = () => armed;
  const error = await h.rejected(entry.undo());
  assert.equal(error.message.startsWith('injected saveMap'), true);
  armed = false;
  assert.equal(h.contents.get(h.parent), merged.get(h.parent), 'note back to the merged text');
  assert.equal(h.unassigned().length, 2, 'files back at the parking paths');
  assert.equal(h.contents.get(MAP), merged.get(MAP), 'Map.md unchanged');
  await entry.undo();
  assert.equal(h.unassigned().length, 0, 'a later undo works');
});

test('N7: a rebuild failing during commit restores everything, including the note text', async () => {
  const h = await harness();
  const before = h.snapshot();
  h.fail.rebuild = n => n === 1;
  const error = await h.rejected(h.merge().commit());
  assert.equal(error.message, 'injected rebuild 1');
  assert.equal(h.contents.get(h.parent), before.get(h.parent));
  assert.equal(h.contents.get(MAP), before.get(MAP));
  assert.equal(h.exists(h.a) && h.exists(h.b), true);
  assert.equal(h.unassigned().length, 0);
});

test('N8: a parent whose body links to the moved children is back to its exact text after commit and undo', async () => {
  const h = await harness();
  // A full-path link to where a child will be parked: when undo writes the note before the moves, the move back
  // (parked -> original) finds that link in the note and rewrites it, so the text no longer equals the original.
  await h.repo.updateNote(h.parent, { detail: `Parent detail\n\nSee [[Child A]], [[Child B]] and [[${UNASSIGNED}/Child A]].` });
  await h.repo.rebuildDerivedData();
  const original = h.contents.get(h.parent);
  assert.match(original, /\[\[Child A\]\]/);
  assert.equal(original.includes(`[[${UNASSIGNED}/Child A]]`), true);
  const entry = await h.merge().commit();
  await entry.undo();
  assert.equal(h.contents.get(h.parent), original);
  // The original text is written after the moves: the last write to the parent in undo comes after the last move.
  const order = [];
  const writeSpy = h.app.vault.process;
  h.app.vault.process = async (file, change) => { if (file.path === h.parent) order.push('note'); return writeSpy(file, change); };
  const moveSpy = h.deps.repo.moveExact;
  h.deps.repo.moveExact = async (...args) => { order.push('move'); return moveSpy(...args); };
  await entry.redo();
  assert.equal(order[0], 'note', 'redo writes the note before the moves');
  order.length = 0;
  await entry.undo();
  assert.equal(order.at(-1), 'note', 'undo writes the note after the moves');
  assert.equal(order.lastIndexOf('note') > order.lastIndexOf('move'), true);
  assert.equal(h.contents.get(h.parent), original);
});

test('N9: undo after the parent was deleted or moved away is stale and writes nothing', async () => {
  const h = await harness();
  const entry = await h.merge().commit();
  await h.app.vault.rename(h.app.vault.getAbstractFileByPath(h.parent), `${TOPICS}/gone.md`);
  const before = h.snapshot(), calls = h.calls.length;
  const error = await h.rejected(entry.undo());
  assert.equal(error.kind, 'stale');
  assert.deepEqual(h.snapshot(), before);
  assert.equal(h.calls.length, calls);
});

test('N10: rewriting a note that is also moved is rejected before anything is written', async () => {
  const h = await harness();
  const before = h.snapshot();
  const tx = begin(h.deps).rewriteNote(h.parent, async () => {}).park(h.parent, UNASSIGNED, 'map-u', 'unassigned');
  const error = await h.rejected(tx.commit());
  assert.match(error.message, /cannot be rewritten and moved/);
  assert.deepEqual(h.snapshot(), before);
  assert.equal(h.calls.length, 0);
});

test('N11: rewriteNote alone (no moves, no map edit) commits, undoes and guards like a merge', async () => {
  const h = await harness();
  const original = h.contents.get(h.parent);
  const entry = await begin(h.deps).rewriteNote(h.parent, h.writes.push.bind(h.writes) && (async path => { await h.repo.updateNote(path, { summary: 'Only note' }); })).commit();
  assert.match(h.contents.get(h.parent), /Only note/);
  assert.equal(h.calls.length, 0, 'no file or map writes');
  await entry.undo();
  assert.equal(h.contents.get(h.parent), original);
  await entry.redo();
  await h.repo.updateNote(h.parent, { detail: 'Edited' });
  assert.equal((await h.rejected(entry.undo())).kind, 'guard');
});

test('N12: a failing write callback restores the note text and nothing else moved', async () => {
  const h = await harness();
  const original = h.contents.get(h.parent);
  const tx = begin(h.deps).rewriteNote(h.parent, async path => { await h.repo.updateNote(path, { summary: 'Half written' }); throw new Error('injected write'); })
    .park(h.a, UNASSIGNED, 'map-u', 'unassigned');
  const error = await h.rejected(tx.commit());
  assert.equal(error.message, 'injected write');
  assert.equal(h.contents.get(h.parent), original);
  assert.equal(h.exists(h.a), true);
  assert.equal(h.calls.length, 0, 'the file was never touched');
});
