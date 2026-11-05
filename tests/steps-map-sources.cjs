// Map-level data sources (P1): tolerant read, serialize, the archive rule, the resolver and the Map.md round trip.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fixture, obsidian } = require('./support.cjs');
const { load } = require('./support-replay.cjs');
const src = load('experiences/visual-map/map-sources.ts', { obsidian });
const plain = value => JSON.parse(JSON.stringify(value));
const signal = () => new AbortController().signal;

async function mapWith(data, title, id, nodePaths) {
  const mapPath = await data.repo.createMap(title);
  const document = await data.repo.readMap(mapPath);
  document.id = id;
  document.nodes = nodePaths.map((p, i) => ({ id: `n${i}`, parentId: null, path: p, x: 0, y: 0, collapsed: false }));
  await data.repo.saveMap(mapPath, document);
  return mapPath;
}
const addNote = async (data, p, text) => { const file = await data.app.vault.create(p, text); return file; };
const deps = data => ({ app: data.app, readMap: p => data.repo.readMap(p) });
const managed = (extra = '') => `---\nagent-map-node: true\n${extra}---\nbody\n`;

// ---- data-migration -------------------------------------------------------------------------------------------

test('old maps: every real fixture Map.md reads [] and a missing key is []', () => {
  const root = path.join(__dirname, 'fixtures');
  const found = [];
  const walk = dir => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, entry.name); if (entry.isDirectory()) walk(full); else if (entry.name === 'Map.md') found.push(full); } };
  walk(root);
  assert.ok(found.length >= 7, `found ${found.length} fixture maps`);
  for (const file of found) assert.equal(/map-sources/.test(fs.readFileSync(file, 'utf8')), false);
  assert.deepEqual(plain(src.readMapSources({})), []);
  assert.deepEqual(plain(src.readMapSources(undefined)), []);
});

test('malformed values keep only the valid subset, in order, without duplicates', () => {
  for (const bad of ['x', 7, null, {}, [1], ['bogus:a'], ['file:/abs.md'], ['file:../x.md'], ['file:a/../x.md'], ['folder:'], ['file:C:\\x.md'], ['nocolon']])
    assert.deepEqual(plain(src.readMapSources({ 'map-sources': bad })), [], JSON.stringify(bad));
  const mixed = ['folder:Notes', 7, 'file:a.md', 'folder:Notes', 'map:T/Map.md', 'bogus:z', 'file:/abs.md'];
  assert.deepEqual(plain(src.readMapSources({ 'map-sources': mixed })), [
    { kind: 'folder', path: 'Notes' }, { kind: 'file', path: 'a.md' }, { kind: 'map', path: 'T/Map.md' }
  ]);
  assert.deepEqual(plain(src.serializeMapSources([{ kind: 'file', path: 'a.md' }, { kind: 'file', path: 'a.md' }, { kind: 'file', path: '../x' }, { kind: 'zzz', path: 'q' }])), ['file:a.md']);
});

test('opening never rewrites: a map with no key or a malformed key keeps its bytes; writing the same list is a no-op', async () => {
  const data = fixture(); const mapPath = await data.repo.createMap('Old');
  const original = data.contents.get(mapPath);
  assert.deepEqual(plain(await data.repo.readMapSources(mapPath)), []);
  await data.repo.writeMapSources(mapPath, []);
  assert.equal(data.contents.get(mapPath), original, 'empty list on a map without the key changes nothing');
  data.contents.set(mapPath, original.replace('---\n', '---\nmap-sources: "x"\n'));
  const malformed = data.contents.get(mapPath);
  assert.deepEqual(plain(await data.repo.readMapSources(mapPath)), []);
  assert.equal(data.contents.get(mapPath), malformed, 'reading does not rewrite a malformed value');
  await data.repo.writeMapSources(mapPath, [{ kind: 'file', path: 'a.md' }]);
  await data.repo.writeMapSources(mapPath, [{ kind: 'file', path: 'a.md' }]);
  const once = data.contents.get(mapPath);
  await data.repo.writeMapSources(mapPath, [{ kind: 'file', path: 'a.md' }]);
  assert.equal(data.contents.get(mapPath), once, 'same list again writes nothing new');
});

test('round trip: add persists across saveMap, only map-sources changes, removing the last source restores the original bytes', async () => {
  const data = fixture(); const mapPath = await data.repo.createMap('Trip');
  const original = data.contents.get(mapPath);
  const list = [{ kind: 'folder', path: 'Notes' }, { kind: 'map', path: 'Other/Map.md' }, { kind: 'file', path: 'a.md' }];
  await data.repo.writeMapSources(mapPath, list);
  assert.deepEqual(plain(await data.repo.readMapSources(mapPath)), list);
  const written = data.contents.get(mapPath);
  assert.equal(written.replace(/map-sources:\n(  - "[^\n]*\n)+/, ''), original, 'only the map-sources lines were added');
  await data.repo.saveMap(mapPath, await data.repo.readMap(mapPath));
  assert.deepEqual(plain(await data.repo.readMapSources(mapPath)), list, 'the key survives saveMap');
  await data.repo.writeMapSources(mapPath, list.slice(1));
  assert.deepEqual(plain(await data.repo.readMapSources(mapPath)), list.slice(1));
  await data.repo.writeMapSources(mapPath, []);
  assert.equal(/map-sources/.test(data.contents.get(mapPath)), false, 'the key is gone');
  assert.equal(data.contents.get(mapPath).replace(/\r/g, ''), original.replace(/\r/g, ''), 'bytes equal the original');
});

test('map-sources is an internal field in share-leak scan', () => {
  const scan = load('experiences/sharing/share-leak-scan.ts', { obsidian });
  assert.ok(scan.INTERNAL_FIELD_NAMES.includes('map-sources'));
});

// ---- archive rule ---------------------------------------------------------------------------------------------

test('archive rule: archived managed excluded; ordinary Archive folder kept; active managed kept; picked file still included', async () => {
  const rule = src.isArchivedVamNote;
  assert.equal(rule('T/Notes/a.md', { 'agent-map-node': true, 'topic-state': 'archived' }), true);
  assert.equal(rule('T/Archive/a.md', { 'agent-map-node': 'true' }), true, 'no topic-state and directly in Archive');
  assert.equal(rule('T/Archive/a.md', { 'agent-map-node': true, 'topic-state': 'active' }), false, 'explicit state wins');
  assert.equal(rule('T/Archive/a.md', { title: 'ordinary' }), false, 'an ordinary note in an Archive folder is kept');
  assert.equal(rule('T/Archive/a.md', undefined), false);
  assert.equal(rule('T/Notes/a.md', { 'agent-map-node': true }), false, 'active managed note');
  assert.equal(rule('T/Archive/deep/a.md', { 'agent-map-node': true }), false, 'only the direct parent counts');
  const data = fixture();
  await data.app.vault.createFolder('Src'); await data.app.vault.createFolder('Src/Archive');
  await addNote(data, 'Src/plain.md', '# plain');
  await addNote(data, 'Src/managed.md', managed());
  await addNote(data, 'Src/gone.md', managed('topic-state: archived\n'));
  await addNote(data, 'Src/Archive/ordinary.md', '# kept');
  await addNote(data, 'Src/Archive/old.md', managed());
  const folder = await src.resolveMapSources(deps(data), [{ kind: 'folder', path: 'Src' }], 'Cur/Map.md', signal());
  assert.deepEqual(plain(folder.groups[0].documents.map(d => d.path).sort()), ['Src/Archive/ordinary.md', 'Src/managed.md', 'Src/plain.md']);
  const file = await src.resolveMapSources(deps(data), [{ kind: 'file', path: 'Src/gone.md' }], 'Cur/Map.md', signal());
  assert.deepEqual(plain(file.groups[0].documents.map(d => d.path)), ['Src/gone.md'], 'an archived note picked as a single file is included');
  assert.deepEqual(plain(src.mapSourceStatus(data.app, { kind: 'folder', path: 'Src' })), { exists: true, count: 3 });
});

// ---- contract + provenance ------------------------------------------------------------------------------------

test('resolver output has the old picker shape: group ids, vault-relative documents, external false, key', async () => {
  const data = fixture();
  await data.app.vault.createFolder('Src'); await addNote(data, 'Src/a.md', '# a'); await addNote(data, 'one.md', '# one');
  await addNote(data, 'T1.md', '# t1'); await addNote(data, 'T2.md', '# t2');
  const other = await mapWith(data, 'Other', 'other-id', ['T1.md', 'T2.md']);
  const result = await src.resolveMapSources(deps(data), [{ kind: 'file', path: 'one.md' }, { kind: 'folder', path: 'Src' }, { kind: 'map', path: other }], 'Cur/Map.md', signal());
  assert.deepEqual(plain(result.groups.map(g => g.id)), ['files:one.md', 'folder:Src', 'map:other-id']);
  assert.deepEqual(plain(result.unreadable), []);
  const documents = result.groups.flatMap(g => g.documents);
  assert.equal(documents.length, 4);
  for (const d of documents) { assert.equal(d.external, false); assert.equal(d.key, d.path); assert.ok(!d.path.startsWith('/')); }
  assert.deepEqual(plain(result.groups[2].documents.map(d => d.path)), ['T1.md', 'T2.md']);
  assert.equal(result.groups[2].name, 'Other');
});

test('the current map is excluded from the resolved sources and a note listed twice is read once', async () => {
  const data = fixture(); await addNote(data, 'T1.md', '# t1');
  const cur = await mapWith(data, 'Cur', 'cur-id', ['T1.md']);
  const result = await src.resolveMapSources(deps(data), [{ kind: 'map', path: cur }, { kind: 'file', path: 'T1.md' }], cur, signal());
  assert.deepEqual(plain(result.groups.map(g => g.id)), ['files:T1.md']);
  assert.deepEqual(plain(result.unreadable), [], 'excluding self is not an unreadable source');
  const twice = await src.resolveMapSources(deps(data), [{ kind: 'file', path: 'T1.md' }, { kind: 'map', path: cur }], 'Elsewhere/Map.md', signal());
  assert.equal(twice.groups.flatMap(g => g.documents).length, 1, 'the same note appears once');
});

// ---- failure path ---------------------------------------------------------------------------------------------

test('failure path: deleted file, missing folder or map, and a read that throws are skipped and listed; all unreadable gives no groups', async () => {
  const data = fixture(); await addNote(data, 'ok.md', '# ok'); await addNote(data, 'boom.md', '# boom');
  const fail = { app: data.app, readMap: async () => { throw new Error('bad map'); } };
  const real = data.app.vault.read;
  data.app.vault.read = async file => { if (file.path === 'boom.md') throw new Error('read failed'); return real(file); };
  const sources = [{ kind: 'file', path: 'gone.md' }, { kind: 'folder', path: 'Nope' }, { kind: 'map', path: 'Nope/Map.md' }, { kind: 'file', path: 'boom.md' }, { kind: 'file', path: 'ok.md' }];
  const result = await src.resolveMapSources(fail, sources, 'Cur/Map.md', signal());
  assert.deepEqual(plain(result.groups.map(g => g.id)), ['files:ok.md']);
  assert.deepEqual(plain(result.unreadable), sources.slice(0, 4));
  const none = await src.resolveMapSources(fail, sources.slice(0, 4), 'Cur/Map.md', signal());
  assert.deepEqual(plain(none.groups), [], 'all unreadable behaves like no sources');
  assert.deepEqual(plain(src.mapSourceStatus(data.app, sources[0])), { exists: false });
  assert.deepEqual(plain(src.mapSourceStatus(data.app, sources[1])), { exists: false });
});

test('failure path: notes missing inside an existing map are skipped quietly', async () => {
  const data = fixture(); await addNote(data, 'T1.md', '# t1');
  const other = await mapWith(data, 'Other', 'other-id', ['T1.md', 'Missing.md']);
  const result = await src.resolveMapSources(deps(data), [{ kind: 'map', path: other }], 'Cur/Map.md', signal());
  assert.deepEqual(plain(result.groups[0].documents.map(d => d.path)), ['T1.md']);
  assert.deepEqual(plain(result.unreadable), []);
});

test('failure path: aborting during the resolve rejects with AbortError', async () => {
  const data = fixture(); await addNote(data, 'a.md', '# a'); await addNote(data, 'b.md', '# b');
  const controller = new AbortController();
  const real = data.app.vault.read;
  data.app.vault.read = async file => { controller.abort(); return real(file); };
  await assert.rejects(src.resolveMapSources(deps(data), [{ kind: 'file', path: 'a.md' }, { kind: 'file', path: 'b.md' }], 'Cur/Map.md', controller.signal), error => error.name === 'AbortError');
  const already = new AbortController(); already.abort();
  await assert.rejects(src.resolveMapSources(deps(data), [{ kind: 'file', path: 'b.md' }], 'Cur/Map.md', already.signal), error => error.name === 'AbortError');
});
