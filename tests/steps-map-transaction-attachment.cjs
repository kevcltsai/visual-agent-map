// MapTransaction 29: createAttachment puts a binary attachment into the same undoable step as the note and Map.md writes.
// Real Repository (link index on); the fake vault gets readBinary, getAvailablePathForAttachment and a recording trashFile
// here (tests/support.cjs stays as it is). vault.delete, vault.trash and adapter.remove throw and must never be called.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, load, obsidian, core, DEFAULT_SETTINGS, TFile, deferred, until } = require('./support.cjs');

const { begin } = load('experiences/visual-map/map-transaction.ts', { obsidian });
const TOPICS = 'Agent Workspace/Topics';
const MAP = `${TOPICS}/map-u/Map.md`;
const UNASSIGNED = `${TOPICS}/map-u/Unassigned`;
const MEDIA = 'Media';
// Calls to the permanent-delete APIs across every harness in this file; the last test asserts they stay 0.
const forbidden = { 'vault.delete': 0, 'vault.trash': 0, 'adapter.remove': 0 };

const bytes = (...values) => new Uint8Array(values).buffer;
const PNG = () => bytes(137, 80, 78, 71, 1, 2, 3, 4);
const folderOf = path => path.slice(0, path.lastIndexOf('/'));

async function harness({ attachmentFolder = 'fixed' } = {}) {
  const { repo, app, contents, files } = fixture('en', { linkIndex: true });
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
  await repo.updateNote(parent, { summary: 'Parent summary', detail: 'Parent detail.' });
  await repo.rebuildDerivedData();

  const counts = { createBinary: 0, trashFile: 0, rebuild: 0 };
  const trashed = [], placed = [], fail = {}, hooks = {};
  // Fake Obsidian APIs this ticket needs, wrapped around the support fixture.
  const createBinary = app.vault.createBinary;
  app.vault.createBinary = async (path, data) => {
    counts.createBinary++;
    if (fail.createBinary?.(counts.createBinary)) throw new Error(`injected createBinary ${counts.createBinary}`);
    const file = await createBinary(path, data);
    file.stat.size = data.byteLength;
    return file;
  };
  app.vault.readBinary = async file => contents.get(file.path);
  const remove = path => {
    const file = files.get(path);
    files.delete(path);
    contents.delete(path);
    if (file?.parent) file.parent.children = file.parent.children.filter(child => child !== file);
  };
  app.fileManager.trashFile = async file => {
    counts.trashFile++;
    trashed.push(file.path);
    if (fail.trashFile?.(counts.trashFile)) throw new Error(`injected trashFile ${counts.trashFile}`);
    remove(file.path);
  };
  app.fileManager.getAvailablePathForAttachment = async (name, sourcePath) => {
    placed.push([name, sourcePath]);
    const folder = attachmentFolder === 'fixed' ? MEDIA : attachmentFolder === 'same' ? folderOf(sourcePath) : `${folderOf(sourcePath)}/assets`;
    if (!files.has(folder)) await app.vault.createFolder(folder);
    const dot = name.lastIndexOf('.');
    const base = name.slice(0, dot), extension = name.slice(dot);
    let path = `${folder}/${name}`;
    for (let n = 1; files.has(path); n++) path = `${folder}/${base} ${n}${extension}`;
    return path;
  };
  app.vault.delete = async () => { forbidden['vault.delete']++; throw new Error('vault.delete must not be called'); };
  app.vault.trash = async () => { forbidden['vault.trash']++; throw new Error('vault.trash must not be called'); };
  app.vault.adapter.remove = async () => { forbidden['adapter.remove']++; throw new Error('adapter.remove must not be called'); };

  const spy = Object.create(repo);
  for (const name of ['moveUnique', 'moveExact', 'setLifecycle', 'saveMap']) {
    let n = 0;
    spy[name] = async (...args) => {
      n++;
      if (hooks[name]) await hooks[name](n, args);
      if (fail[name]?.(n, args)) throw new Error(`injected ${name} ${n}`);
      return repo[name](...args);
    };
  }
  const deps = {
    repo: spy,
    rebuildDerivedData: async () => { counts.rebuild++; if (fail.rebuild?.(counts.rebuild)) throw new Error(`injected rebuild ${counts.rebuild}`); return repo.rebuildDerivedData(); },
    onApplied: () => {},
    checkConflict: async () => {}
  };
  const seen = [];
  /** Writes an embed of attachment `key` into the note; `fail.write` makes it throw after writing. */
  const embed = (key = 'img') => async (path, attachment) => {
    const target = attachment(key);
    seen.push(target);
    await repo.updateNote(path, { detail: `Picture: ![[${target}]]` });
    if (fail.write?.()) throw new Error('injected write');
  };
  /** Attachment + note embed + a parked child + a Map.md edit that records the attachment path. */
  const step = (data = PNG(), { name = 'pic.png', note = parent, park = true } = {}) => {
    const transaction = begin(deps).createAttachment('img', { name, data, sourcePath: note }).rewriteNote(note, embed());
    if (park) transaction.park(b, UNASSIGNED, 'map-u', 'unassigned');
    return transaction.editMap(MAP, (map, _resolve, attachment) => {
      map.title = `map-u ${attachment('img')}`;
      for (const node of map.nodes) if (park && node.path === b) node.path = _resolve(node.path);
    });
  };
  /** A file already in the vault (not part of any step), created like an attachment. */
  const seed = async (path, data) => {
    if (!files.has(folderOf(path))) await app.vault.createFolder(folderOf(path));
    await createBinary(path, data);
    files.get(path).stat.size = data.byteLength;
  };
  const snapshot = () => new Map(contents);
  const rejected = async promise => { try { await promise; } catch (error) { return error; } return assert.fail('expected a rejection'); };
  const exists = path => files.get(path) instanceof TFile;
  const inFolder = folder => [...files.values()].filter(file => file instanceof TFile && file.parent?.path === folder).map(file => file.path).sort();
  const mapTitle = async () => (await repo.readMap(MAP)).title;
  /** The rewritten note and Map.md equal `before` byte for byte; the parked note is back where it was. */
  const restored = before => {
    assert.equal(contents.get(parent), before.get(parent), 'note text as before commit');
    assert.equal(contents.get(MAP), before.get(MAP), 'Map.md as before commit');
    assert.equal(exists(b), true, 'the parked note is back');
    assert.deepEqual(inFolder(UNASSIGNED), []);
  };
  return { restored, repo, app, contents, files, parent, a, b, deps, fail, hooks, counts, trashed, placed, seen, embed, step, seed, snapshot, rejected, exists, inFolder, remove, mapTitle };
}

test('A4: a failing trashFile leaves the file and throws rollback-failed; the retry reuses that path and adds no copy', async () => {
  const h = await harness();
  const before = h.snapshot();
  h.fail.saveMap = () => true;
  h.fail.trashFile = () => true;
  const error = await h.rejected(h.step().commit());
  assert.equal(error.kind, 'rollback-failed');
  assert.equal(h.exists(`${MEDIA}/pic.png`), true, 'the file stays for the retry');
  h.restored(before);
  delete h.fail.saveMap;
  delete h.fail.trashFile;
  await h.step().commit();
  assert.equal(h.counts.createBinary, 1, 'the retry created nothing');
  assert.deepEqual(h.inFolder(MEDIA), [`${MEDIA}/pic.png`], 'one file with that content, no "pic 1.png"');
  assert.match(h.contents.get(h.parent), /!\[\[Media\/pic\.png\]\]/);
  assert.equal(await h.mapTitle(), `map-u ${MEDIA}/pic.png`);
});

test('A7: a reused attachment that another note embeds is never trashed by a failed commit, undo or redo', async () => {
  const h = await harness();
  await h.seed(`${MEDIA}/shared.png`, PNG());
  await h.repo.updateNote(h.a, { detail: 'Uses ![[Media/shared.png]]' });
  h.fail.saveMap = n => n === 1;
  assert.equal((await h.rejected(h.step().commit())).message, 'injected saveMap 1');
  assert.equal(h.exists(`${MEDIA}/shared.png`), true);
  const entry = await h.step().commit();
  assert.equal(h.seen.at(-1), `${MEDIA}/shared.png`, 'the step reused the shared file');
  await entry.undo();
  await entry.redo();
  await entry.undo();
  assert.equal(h.counts.trashFile, 0);
  assert.equal(h.counts.createBinary, 0);
  assert.equal(h.exists(`${MEDIA}/shared.png`), true);
  assert.match(h.contents.get(h.a), /shared\.png/);
});

test('A8: a step still committing owns its file; a parallel step with the same data does not reuse it, and only that file is trashed', async () => {
  const h = await harness();
  const gate = deferred(), reached = { saveMap: false };
  h.hooks.saveMap = async n => { if (n === 1) { reached.saveMap = true; await gate.promise; throw new Error('injected saveMap A'); } };
  const first = h.rejected(h.step().commit());
  await until(() => reached.saveMap);
  assert.equal(h.exists(`${MEDIA}/pic.png`), true, 'A created its file');
  const second = begin(h.deps).createAttachment('img', { name: 'pic.png', data: PNG(), sourcePath: h.a }).rewriteNote(h.a, h.embed());
  await second.commit();
  assert.equal(h.counts.createBinary, 2, 'B did not reuse the file of the unfinished step A');
  assert.match(h.contents.get(h.a), /!\[\[Media\/pic 1\.png\]\]/);
  gate.resolve();
  assert.equal((await first).message, 'injected saveMap A');
  assert.deepEqual(h.trashed, [`${MEDIA}/pic.png`], 'only the file of A is trashed');
  assert.equal(h.exists(`${MEDIA}/pic 1.png`), true, 'the embed of B still points at a file');
});

test('A1: Map.md save fails after the attachment exists: only that file is trashed, once; note and Map.md are as before', async () => {
  const h = await harness();
  const before = h.snapshot();
  h.fail.saveMap = () => true;
  assert.equal((await h.rejected(h.step().commit())).message, 'injected saveMap 1');
  assert.deepEqual(h.trashed, [`${MEDIA}/pic.png`]);
  assert.equal(h.exists(`${MEDIA}/pic.png`), false, 'the file left the vault');
  h.restored(before);
});

for (const [name, inject, message] of [
  ['the note write', h => { h.fail.write = () => true; }, 'injected write'],
  ['moveUnique', h => { h.fail.moveUnique = () => true; }, 'injected moveUnique 1'],
  ['the rebuild', h => { h.fail.rebuild = n => n === 1; }, 'injected rebuild 1']
])
  test(`A2: ${name} fails after the attachment exists: the file is trashed once and note and Map.md are as before`, async () => {
    const h = await harness();
    const before = h.snapshot();
    inject(h);
    assert.equal((await h.rejected(h.step().commit())).message, message);
    assert.deepEqual(h.trashed, [`${MEDIA}/pic.png`]);
    assert.equal(h.exists(`${MEDIA}/pic.png`), false);
    h.restored(before);
  });

test('A3: a conflict cancels before any attachment is created or trashed', async () => {
  const h = await harness();
  const before = h.snapshot();
  h.deps.checkConflict = async () => { throw new Error('conflict'); };
  assert.equal((await h.rejected(h.step().commit())).message, 'conflict');
  assert.equal(h.counts.createBinary, 0);
  assert.equal(h.counts.trashFile, 0);
  assert.deepEqual(h.placed, []);
  assert.deepEqual(h.snapshot(), before);
});

test('A5: the same content under another name is reused; the same name with other content gets a new path and the old file stays', async () => {
  const h = await harness();
  await h.seed(`${MEDIA}/other.png`, PNG());
  await h.step().commit();
  assert.equal(h.seen.at(-1), `${MEDIA}/other.png`);
  assert.equal(h.counts.createBinary, 0);
  const g = await harness();
  const old = bytes(9, 9, 9, 9, 9, 9, 9, 9);
  await g.seed(`${MEDIA}/pic.png`, old);
  await g.step().commit();
  assert.equal(g.seen.at(-1), `${MEDIA}/pic 1.png`);
  assert.deepEqual(new Uint8Array(g.contents.get(`${MEDIA}/pic.png`)), new Uint8Array(old), 'the existing file is not overwritten');
  assert.deepEqual(new Uint8Array(g.contents.get(`${MEDIA}/pic 1.png`)), new Uint8Array(PNG()));
});

test('A6: two keys with the same data in one step create one file and a failure trashes it once', async () => {
  const h = await harness();
  const before = h.snapshot();
  h.fail.saveMap = () => true;
  const transaction = begin(h.deps)
    .createAttachment('img', { name: 'pic.png', data: PNG(), sourcePath: h.parent })
    .createAttachment('copy', { name: 'copy.png', data: PNG(), sourcePath: h.parent })
    .rewriteNote(h.parent, async (path, attachment) => { h.seen.push(attachment('img'), attachment('copy')); await h.repo.updateNote(path, { detail: `![[${attachment('img')}]] ![[${attachment('copy')}]]` }); })
    .editMap(MAP, map => { map.title = 'edited'; });
  await h.rejected(transaction.commit());
  assert.deepEqual(h.seen, [`${MEDIA}/pic.png`, `${MEDIA}/pic.png`]);
  assert.equal(h.counts.createBinary, 1);
  assert.deepEqual(h.trashed, [`${MEDIA}/pic.png`]);
  assert.deepEqual(h.inFolder(MEDIA), []);
  assert.equal(h.contents.get(h.parent), before.get(h.parent));
});

test('A9: undo drops the references and keeps the file; redo links the same path without creating a file', async () => {
  const h = await harness();
  const before = h.snapshot();
  const entry = await h.step().commit();
  const path = `${MEDIA}/pic.png`;
  assert.match(h.contents.get(h.parent), /!\[\[Media\/pic\.png\]\]/);
  await entry.undo();
  assert.equal(h.contents.get(h.parent), before.get(h.parent), 'the note no longer embeds it');
  assert.equal(await h.mapTitle(), 'map-u', 'the map no longer refers to it');
  assert.equal(h.exists(path), true);
  assert.equal(h.counts.trashFile, 0);
  await entry.redo();
  assert.equal(h.seen.at(-1), path, 'redo hands the same path to the write');
  assert.match(h.contents.get(h.parent), /!\[\[Media\/pic\.png\]\]/);
  assert.equal(await h.mapTitle(), `map-u ${path}`);
  assert.equal(h.counts.createBinary, 1);
  assert.equal(h.counts.trashFile, 0);
});

test('A10: redo after the attachment was deleted outside refuses with stale and writes nothing', async () => {
  const h = await harness();
  const entry = await h.step().commit();
  await entry.undo();
  h.remove(`${MEDIA}/pic.png`);
  const before = h.snapshot(), writes = h.seen.length;
  const error = await h.rejected(entry.redo());
  assert.equal(error.kind, 'stale');
  assert.deepEqual(h.snapshot(), before, 'note and Map.md are not written');
  assert.equal(h.seen.length, writes, 'the note write was not run');
  assert.equal(h.counts.createBinary, 1);
});

test('A11: a file changed before the rollback (other size, or same size other bytes) is kept', async () => {
  for (const change of [bytes(1, 2, 3), bytes(7, 7, 7, 7, 7, 7, 7, 7)]) {
    const h = await harness();
    h.hooks.saveMap = async () => { h.contents.set(`${MEDIA}/pic.png`, change); h.files.get(`${MEDIA}/pic.png`).stat.size = change.byteLength; };
    h.fail.saveMap = () => true;
    assert.equal((await h.rejected(h.step().commit())).message, 'injected saveMap 1');
    assert.equal(h.counts.trashFile, 0);
    assert.equal(h.exists(`${MEDIA}/pic.png`), true);
  }
});

test('A13: the file lands where getAvailablePathForAttachment says, called with (name, sourcePath), for three folder settings', async () => {
  const notes = `${TOPICS}/map-u/Notes`;
  for (const [mode, folder] of [['fixed', MEDIA], ['same', notes], ['sub', `${notes}/assets`]]) {
    const h = await harness({ attachmentFolder: mode });
    await h.step().commit();
    assert.deepEqual(h.placed, [['pic.png', h.parent]], mode);
    assert.equal(h.seen.at(-1), `${folder}/pic.png`, mode);
    assert.equal(h.exists(`${folder}/pic.png`), true, mode);
  }
});

test('A14: a step without createAttachment creates, reads and trashes no attachment', async () => {
  const h = await harness();
  const entry = await begin(h.deps).park(h.b, UNASSIGNED, 'map-u', 'unassigned')
    .editMap(MAP, (map, resolve) => { for (const node of map.nodes) if (node.path === h.b) node.path = resolve(node.path); }).commit();
  await entry.undo();
  await entry.redo();
  assert.equal(h.counts.createBinary, 0);
  assert.equal(h.counts.trashFile, 0);
  assert.deepEqual(h.placed, []);
});

test('A15: attachment(key) for an unknown key throws and the step rolls back; a key used twice is refused', async () => {
  const h = await harness();
  const before = h.snapshot();
  const error = await h.rejected(begin(h.deps).createAttachment('img', { name: 'pic.png', data: PNG(), sourcePath: h.parent }).rewriteNote(h.parent, h.embed('missing')).commit());
  assert.match(error.message, /missing/);
  assert.deepEqual(h.trashed, [`${MEDIA}/pic.png`]);
  assert.equal(h.contents.get(h.parent), before.get(h.parent));
  assert.throws(() => begin(h.deps).createAttachment('img', { name: 'a.png', data: PNG(), sourcePath: h.parent }).createAttachment('img', { name: 'b.png', data: PNG(), sourcePath: h.parent }), /twice/);
});

test('A16: unload during commit makes trashFile reject: rollback-failed, the file stays, and the next commit reuses it', async () => {
  const h = await harness();
  h.hooks.saveMap = async () => { h.repo.dispose(); };
  const error = await h.rejected(h.step({ park: false }).commit());
  assert.equal(error.kind, 'rollback-failed');
  assert.equal(h.counts.trashFile, 0, 'the guarded trashFile never reached the vault');
  assert.equal(h.exists(`${MEDIA}/pic.png`), true);
  const fresh = await harness();
  // Same vault after a reload: a new Repository, the file left behind is reused.
  await fresh.seed(`${MEDIA}/pic.png`, PNG());
  await fresh.step().commit();
  assert.equal(fresh.counts.createBinary, 0);
  assert.equal(fresh.seen.at(-1), `${MEDIA}/pic.png`);
});

test('A12: no test called vault.delete, vault.trash or adapter.remove', () => {
  assert.deepEqual(forbidden, { 'vault.delete': 0, 'vault.trash': 0, 'adapter.remove': 0 });
});
