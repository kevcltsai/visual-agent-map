// Cross-map read-only knowledge references (P4.3): the optional `knowledgeRefs` key of a map file. Data layer only: migration
// (bytes in, bytes out), the resolver's four authorisation conditions, lifecycle, duplicateMap and the clipboard session.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture, load, obsidian, DEFAULT_SETTINGS } = require('./support.cjs');
const { loadSource } = require('./support-replay.cjs');

const kr = load('experiences/visual-map/knowledge-refs.ts', { obsidian });
const mm = load('map-model.ts', { obsidian });
const { begin } = load('experiences/visual-map/map-transaction.ts', { obsidian });
const { ClipboardSession } = load('experiences/visual-map/clipboard-session.ts');
// The serializer of 9774767f, before this feature (frozen copy, like the other legacy-*.ts.txt fixtures).
const legacy = loadSource(fs.readFileSync(path.join(__dirname, 'fixtures', 'legacy-map-model-9774767f.ts.txt'), 'utf8'));
const plain = value => JSON.parse(JSON.stringify(value));
const quiet = () => {};

const node = (id, parentId = null) => ({ id, parentId, path: `${id}.md`, x: 0, y: 0 });
const baseDoc = (extra = {}) => ({ id: 'm1', title: 'Host', version: 1, nodes: [node('r'), node('c', 'r')], viewport: { x: 0, y: 0, zoom: 1 }, ...extra });
const textOf = doc => mm.serializeMap(mm.parseMap(mm.serializeMap(doc), quiet)); // the form the plugin itself writes
const ref = (over = {}) => ({ id: 'ref-1', mapId: 'other', nodeId: 'n1', parentId: 'c', x: 300, y: 0, pathHint: 'Mind Maps/Other/Map.md', ...over });

// ---- 1, 2, 3, (e), (f), 8, 12: bytes in, bytes out ------------------------------------------------------------------------

test('1: a map without knowledgeRefs reads and writes the same bytes as the build before this feature', () => {
  const aim = fs.readFileSync(path.join(__dirname, 'fixtures/legacy-aim-map/old-aim-map/Agent Workspace/AIM/Old AIM map/Map.md'), 'utf8');
  const docs = [
    textOf(baseDoc()),
    textOf(baseDoc({ argumentMap: { v: 1, anything: [1, 2] } })),
    textOf(baseDoc({ bookPipeline: { stage: 'draft' } })),
    textOf(baseDoc({ canvasItems: [{ id: 't1', kind: 'text', text: 'hi', x: 1, y: 2 }] })),
    aim
  ];
  for (const text of docs) {
    const current = mm.serializeMap(mm.parseMap(text, quiet));
    assert.equal(current, legacy.serializeMap(legacy.parseMap(text, quiet)), 'same bytes as the old serializer');
    assert.equal(mm.parseMap(text, quiet).knowledgeRefs, undefined);
    assert.equal(Object.keys(mm.parseMap(text, quiet)).includes('knowledgeRefs'), false, 'parse adds no key');
    assert.equal(current.includes('knowledgeRefs'), false);
  }
});

test('2, 3: the first reference adds the key; removing every reference removes it again, byte for byte', () => {
  const before = textOf(baseDoc());
  const map = mm.parseMap(before, quiet);
  kr.appendKnowledgeRef(map, ref());
  const withRef = mm.serializeMap(map);
  assert.ok(withRef.includes('"knowledgeRefs"'));
  const stripped = mm.parseMap(withRef, quiet);
  delete stripped.knowledgeRefs;
  assert.equal(mm.serializeMap(stripped), before, 'deleting the key gives the text before the first reference');
  // The same through the API: two references, remove one (key stays), remove the last (key goes).
  kr.appendKnowledgeRef(map, ref({ id: 'ref-2', nodeId: 'n2' }));
  assert.equal(kr.removeKnowledgeRef(map, 'ref-1'), true);
  assert.equal(kr.readKnowledgeRefs(map).length, 1);
  assert.equal(kr.removeKnowledgeRef(map, 'nope'), false);
  assert.equal(kr.removeKnowledgeRef(map, 'ref-2'), true);
  assert.equal('knowledgeRefs' in map, false, 'the key goes with the last entry');
  assert.equal(mm.serializeMap(map), before);
});

const mixed = () => [
  ref(),
  ref({ id: 'ref-bad-type', x: 'far' }),
  { ...ref({ id: 'ref-extra' }), color: 'red' },
  (() => { const { pathHint, ...rest } = ref({ id: 'ref-short' }); return rest; })(),
  ref({ id: 'r' }), // an id that is a card of this map
  ref({ id: 'ref-1', nodeId: 'again' }), // an id an earlier reference already holds
  ref({ id: 'ref-self', mapId: 'm1' }),
  'not an object',
  null
];

test('(e), 8: bad, unknown-field, id-colliding and duplicate entries are not shown and stay in the file', () => {
  const text = textOf(baseDoc({ knowledgeRefs: mixed() }));
  const map = mm.parseMap(text, quiet);
  assert.deepEqual(plain(kr.readKnowledgeRefs(map).map(item => item.id)), ['ref-1']);
  assert.equal(kr.rawKnowledgeRefs(map).length, 9);
  assert.equal(mm.serializeMap(map), text, 'a save writes every entry back exactly');
  assert.equal(mm.serializeMap(mm.parseMap(mm.serializeMap(map), quiet)), text);
});

test('(f), 12: the build before this feature keeps the key and every entry through a parse and serialize round trip', () => {
  const text = textOf(baseDoc({ knowledgeRefs: mixed() }));
  const out = legacy.serializeMap(legacy.parseMap(text, quiet));
  assert.equal(out, text);
  assert.deepEqual(plain(legacy.parseMap(out, quiet).knowledgeRefs), plain(mm.parseMap(text, quiet).knowledgeRefs));
});

test('9: adding a reference to this very map is refused; the same card twice on one card is refused; another card is fine', () => {
  const map = baseDoc();
  assert.equal(kr.checkAddKnowledgeRef(map, { mapId: 'm1', nodeId: 'x', parentId: 'c' }), 'self');
  assert.equal(kr.checkAddKnowledgeRef(map, { mapId: 'other', nodeId: 'n1', parentId: 'gone' }), 'no-parent');
  assert.equal(kr.checkAddKnowledgeRef(map, { mapId: 'other', nodeId: 'n1', parentId: 'c' }), 'ok');
  kr.appendKnowledgeRef(map, ref());
  assert.equal(kr.checkAddKnowledgeRef(map, { mapId: 'other', nodeId: 'n1', parentId: 'c' }), 'duplicate');
  assert.equal(kr.checkAddKnowledgeRef(map, { mapId: 'other', nodeId: 'n1', parentId: 'r' }), 'ok', 'a different card may hold it');
  assert.equal(kr.checkAddKnowledgeRef(map, { mapId: 'other', nodeId: 'n2', parentId: 'c' }), 'ok');
});

test('11: a reference whose parent card is gone is kept but not shown; the parent coming back shows it again', () => {
  const map = baseDoc({ knowledgeRefs: [ref()] });
  const kept = map.nodes;
  assert.equal(kr.visibleKnowledgeRefs(map).length, 1);
  assert.equal(kr.knowledgeRefsUnder(map, ['c']), 1);
  assert.equal(kr.knowledgeRefsUnder(map, ['r']), 0);
  map.nodes = kept.filter(item => item.id !== 'c');
  assert.equal(kr.visibleKnowledgeRefs(map).length, 0);
  assert.equal(kr.rawKnowledgeRefs(map).length, 1, 'removing the card did not touch the entry');
  map.nodes = kept;
  assert.equal(kr.visibleKnowledgeRefs(map).length, 1);
});

test('10: moving a reference sets its offset only; an offset that is not a number changes nothing', () => {
  const map = baseDoc({ knowledgeRefs: [ref(), ref({ id: 'ref-2', nodeId: 'n2' })] });
  assert.equal(kr.moveKnowledgeRef(map, 'ref-1', 320, 10), true);
  assert.equal(kr.moveKnowledgeRef(map, 'ref-1', 320, 10), false, 'no change, no step');
  assert.equal(kr.moveKnowledgeRef(map, 'ref-1', NaN, 0), false);
  assert.deepEqual(plain(kr.readKnowledgeRefs(map).map(item => [item.id, item.x, item.y])), [['ref-1', 320, 10], ['ref-2', 300, 0]]);
});

test('refreshPathHints only changes hints it was told about', () => {
  const map = baseDoc({ knowledgeRefs: [ref(), ref({ id: 'ref-2', nodeId: 'n2' }), 'junk'] });
  kr.refreshPathHints(map, new Map([['ref-1', 'New/Map.md']]));
  assert.deepEqual(plain(kr.rawKnowledgeRefs(map).map(item => item?.pathHint)), ['New/Map.md', 'Mind Maps/Other/Map.md', null]);
  assert.equal(kr.rawKnowledgeRefs(map)[2], 'junk');
});

// ---- resolver against a real Repository -----------------------------------------------------------------------------------

async function world() {
  const data = fixture('en'), { repo } = data;
  const bPath = await repo.createMap('Source');
  const b = await repo.readMap(bPath);
  const orig = await repo.createNote('Original', 'model-a', b, bPath, 'workspace');
  b.nodes.push(orig);
  await repo.saveMap(bPath, b);
  await repo.updateNote(orig.path, { summary: 'Original summary', detail: 'Original detail' });
  const aPath = await repo.createMap('Host');
  const a = await repo.readMap(aPath);
  const anchor = await repo.createNote('Anchor', 'model-a', a, aPath, 'workspace');
  a.nodes.push(anchor);
  await repo.saveMap(aPath, a);
  const target = { id: 'ref-1', mapId: b.id, nodeId: orig.id, pathHint: bPath };
  return { ...data, aPath, bPath, b: await repo.readMap(bPath), a: await repo.readMap(aPath), orig, anchor, target, io: repo.knowledgeRefIO() };
}
const resolveOne = async (w, over = {}, options) => (await kr.resolveKnowledgeRefs([{ ...w.target, ...over }], w.io, options)).get('ref-1');
const unavailable = (result, reason) => { assert.deepEqual(plain(result), { ok: false, reason }, `unavailable (${reason}) and carrying no content`); };

test('4: resolving reads the original and writes nothing, in any file', async () => {
  const w = await world();
  const before = new Map(w.contents);
  const result = await resolveOne(w, {}, { withBody: true });
  assert.equal(result.ok, true);
  assert.equal(result.title, 'Original');
  assert.equal(result.mapTitle, 'Source');
  assert.equal(result.summary, 'Original summary');
  assert.equal(result.detail, 'Original detail');
  assert.equal(kr.referenceTitle(result), 'Original');
  const light = await resolveOne(w);
  assert.equal('summary' in light, false, 'the body is only read when asked for');
  assert.deepEqual(plain([...w.contents]), plain([...before]), 'no file changed');
  assert.deepEqual(w.trashed, []);
});

test('5: the original map renamed (the hint is stale) is still found by its id', async () => {
  const w = await world();
  await w.app.vault.rename(w.app.vault.getAbstractFileByPath(w.bPath), 'Mind Maps/Source/Renamed Map.md');
  const result = await resolveOne(w);
  assert.equal(result.ok, true);
  assert.equal(result.mapPath, 'Mind Maps/Source/Renamed Map.md');
  assert.equal(result.title, 'Original');
});

test('6: a map with the same name is never taken for the original', async () => {
  const w = await world();
  const other = await w.repo.createMap('Source');
  const otherMap = await w.repo.readMap(other);
  assert.equal(otherMap.title, 'Source');
  assert.notEqual(otherMap.id, w.b.id);
  assert.equal((await resolveOne(w)).mapPath, w.bPath);
  w.files.delete(w.bPath); w.contents.delete(w.bPath);
  unavailable(await resolveOne(w), 'missing');
});

test('7: original card deleted, original map deleted, or two maps with the id: the reference says unavailable, with no old content', async () => {
  const w = await world();
  const b = await w.repo.readMap(w.bPath);
  b.nodes = [];
  await w.repo.saveMap(w.bPath, b);
  unavailable(await resolveOne(w), 'node-missing');
  const w2 = await world();
  w2.files.delete(w2.bPath); w2.contents.delete(w2.bPath);
  unavailable(await resolveOne(w2), 'missing');
  // Two files with one map id: only reachable through the scan (the hint is stale), and never resolved by picking one.
  const w3 = await world();
  await w3.app.vault.create('Elsewhere/Copy of Map.md', w3.contents.get(w3.bPath));
  assert.equal((await resolveOne(w3)).ok, true, 'a hint that names a file with the right id is used as it is (accepted limit)');
  unavailable(await resolveOne(w3, { pathHint: 'Mind Maps/Gone/Map.md' }), 'ambiguous');
});

test('2c (i): a hint that names a file that is not a map is never read; no map has the id, so nothing is shown', async () => {
  const w = await world();
  const reads = [];
  const io = { ...w.io, readMap: async p => { reads.push(p); return w.io.readMap(p); } };
  const noMarker = 'Plain/Not a map.md';
  await w.app.vault.create(noMarker, '```agent-map\n' + JSON.stringify({ ...w.b, id: 'ghost' }) + '\n```\n');
  const result = (await kr.resolveKnowledgeRefs([{ id: 'x', mapId: 'ghost', nodeId: w.orig.id, pathHint: noMarker }], io)).get('x');
  unavailable(result, 'missing');
  assert.equal(reads.includes(noMarker), false, 'the unmarked file was not read');
  const note = (await kr.resolveKnowledgeRefs([{ id: 'x', mapId: w.b.id, nodeId: w.orig.id, pathHint: w.orig.path }], io)).get('x');
  assert.equal(note.mapPath, w.bPath, 'a note path as the hint is skipped; the map is found by its id');
  assert.equal(reads.includes(w.orig.path), false);
});

test('2c (ii): the file the hint names has another map id: its content is not used', async () => {
  const w = await world();
  const other = await w.repo.createMap('Decoy');
  const decoy = await w.repo.readMap(other);
  const note = await w.repo.createNote('Decoy card', 'model-a', decoy, other, 'workspace');
  decoy.nodes.push(note);
  await w.repo.saveMap(other, decoy);
  const result = await resolveOne(w, { pathHint: other, nodeId: note.id });
  unavailable(result, 'node-missing'); // the real map is read (found by id); it has no such card
  const fine = await resolveOne(w, { pathHint: other });
  assert.equal(fine.mapPath, w.bPath);
  assert.equal(fine.title, 'Original');
});

test('2c (iii): a card that is not in the map as just read is unavailable', async () => {
  const w = await world();
  unavailable(await resolveOne(w, { nodeId: 'no-such-card' }), 'node-missing');
});

test('2c (iv): a card whose note is an archived VAM note is unavailable, with no content', async () => {
  const w = await world();
  const text = w.contents.get(w.orig.path);
  assert.match(text, /agent-map-node: true/);
  assert.match(text, /topic-state: \w+/);
  w.contents.set(w.orig.path, text.replace(/topic-state: \w+/, 'topic-state: archived'));
  unavailable(await resolveOne(w, {}, { withBody: true }), 'archived');
  w.contents.set(w.orig.path, text);
  assert.equal((await resolveOne(w)).ok, true, 'readable again once it is not archived');
});

test('a note that cannot be read is unavailable', async () => {
  const w = await world();
  w.files.delete(w.orig.path); w.contents.delete(w.orig.path);
  unavailable(await resolveOne(w), 'note-unreadable');
});

// ---- 2b, 11: undo and redo through the map transaction ---------------------------------------------------------------------

test('2b, 11: undo of the first reference works after the original map was renamed and the host reopened and saved; redo adds it once', async () => {
  const w = await world();
  const deps = { repo: w.repo, rebuildDerivedData: async () => {}, onApplied: () => {}, checkConflict: async () => {} };
  const original = w.contents.get(w.aPath);
  const added = ref({ mapId: w.b.id, nodeId: w.orig.id, parentId: w.anchor.id, pathHint: w.bPath });
  const entry = await begin(deps).editMap(w.aPath, map => { kr.appendKnowledgeRef(map, added); }).commit();
  assert.equal(kr.readKnowledgeRefs(await w.repo.readMap(w.aPath)).length, 1);
  await w.app.vault.rename(w.app.vault.getAbstractFileByPath(w.bPath), 'Mind Maps/Source/Renamed Map.md');
  // Reopen and save: an ordinary save does not rewrite the hint.
  await w.repo.saveMap(w.aPath, await w.repo.readMap(w.aPath));
  assert.equal(kr.readKnowledgeRefs(await w.repo.readMap(w.aPath))[0].pathHint, w.bPath, 'the old hint stays until a reference transaction');
  await entry.undo();
  assert.equal(w.contents.get(w.aPath), original, 'undo restored the map text');
  await entry.redo();
  assert.deepEqual(plain(kr.readKnowledgeRefs(await w.repo.readMap(w.aPath)).map(item => item.id)), ['ref-1'], 'redo adds it once');
  await entry.undo();
  assert.equal(w.contents.get(w.aPath), original);
});

test('removing a reference through a transaction undoes cleanly and refreshes only the hint it was told about', async () => {
  const w = await world();
  const deps = { repo: w.repo, rebuildDerivedData: async () => {}, onApplied: () => {}, checkConflict: async () => {} };
  await w.repo.updateMap(w.aPath, map => { kr.appendKnowledgeRef(map, ref({ mapId: w.b.id, nodeId: w.orig.id, parentId: w.anchor.id, pathHint: 'old/Map.md' })); kr.appendKnowledgeRef(map, ref({ id: 'ref-2', mapId: w.b.id, nodeId: 'zz', parentId: w.anchor.id, pathHint: 'old2/Map.md' })); });
  const before = w.contents.get(w.aPath);
  const entry = await begin(deps).editMap(w.aPath, map => { kr.removeKnowledgeRef(map, 'ref-2'); kr.refreshPathHints(map, new Map([['ref-1', w.bPath]])); }).commit();
  const now = await w.repo.readMap(w.aPath);
  assert.deepEqual(plain(kr.readKnowledgeRefs(now).map(item => [item.id, item.pathHint])), [['ref-1', w.bPath]]);
  await entry.undo();
  assert.equal(w.contents.get(w.aPath), before);
});

// ---- duplicateMap ---------------------------------------------------------------------------------------------------------

test('duplicateMap keeps references to other maps, points the ones on copied cards at the new cards, and leaves the source alone', async () => {
  const w = await world();
  await w.repo.updateMap(w.aPath, map => {
    kr.appendKnowledgeRef(map, ref({ mapId: w.b.id, nodeId: w.orig.id, parentId: w.anchor.id, pathHint: w.bPath }));
    map.knowledgeRefs.push({ ...ref({ id: 'ref-x', parentId: 'not-a-card-here' }) }, 'junk');
  });
  const source = w.contents.get(w.aPath);
  const copyPath = await w.repo.duplicateMap(w.aPath, 'Host copy');
  const copy = await w.repo.readMap(copyPath);
  assert.equal(w.contents.get(w.aPath), source, 'source map file unchanged');
  const [first, hidden, junk] = copy.knowledgeRefs;
  assert.equal(first.mapId, w.b.id); assert.equal(first.nodeId, w.orig.id); assert.equal(first.pathHint, w.bPath);
  assert.equal(first.parentId, copy.nodes[0].id); assert.notEqual(first.parentId, w.anchor.id);
  assert.equal(hidden.parentId, 'not-a-card-here', 'an entry whose parent was not copied keeps its data');
  assert.equal(junk, 'junk');
  assert.deepEqual(plain(kr.visibleKnowledgeRefs(copy).map(item => item.id)), ['ref-1']);
  const plainMap = await w.repo.duplicateMap(w.bPath, 'Source copy');
  assert.equal('knowledgeRefs' in (await w.repo.readMap(plainMap)), false, 'no references, no key');
});

test('references are not cards: they are not in nodes, so nothing that walks the nodes sees them', async () => {
  const w = await world();
  await w.repo.updateMap(w.aPath, map => kr.appendKnowledgeRef(map, ref({ mapId: w.b.id, nodeId: w.orig.id, parentId: w.anchor.id })));
  const map = await w.repo.readMap(w.aPath);
  assert.equal(map.nodes.length, 1);
  assert.equal(map.nodes.some(item => item.id === 'ref-1'), false);
  assert.equal(JSON.stringify(map.nodes).includes('ref-1'), false);
});

// ---- clipboard session ----------------------------------------------------------------------------------------------------

test('the clipboard session remembers the card to reference by identity only, and clear() forgets it', () => {
  const session = new ClipboardSession();
  assert.equal(session.getReference(), null);
  const saved = session.recordReference({ mapId: 'm9', nodeId: 'n9', mapPath: 'Mind Maps/X/Map.md', extra: 'ignored' });
  assert.deepEqual(plain(session.getReference()), { mapId: 'm9', nodeId: 'n9', mapPath: 'Mind Maps/X/Map.md' });
  assert.ok(Object.isFrozen(saved));
  assert.equal(session.match('m9'), null, 'the reference is not a clipboard text record');
  session.clear();
  assert.equal(session.getReference(), null);
});
