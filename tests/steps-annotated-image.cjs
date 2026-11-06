// Annotated image P1 (A1, A2, A3 data part): sanitize, relation helpers, legacy readers, parseMap prune.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { load } = require('./support.cjs');
const { loadSource } = require('./support-replay.cjs');
const ci = load('experiences/visual-map/canvas-items.ts');
const mm = load('map-model.ts');
const { buildMapChatContext } = load('core/map-chat-context.ts');
const plain = value => JSON.parse(JSON.stringify(value));
const sanitize = raw => plain(ci.sanitizeCanvasItems(raw));
const anchor = (id, x = 0.5, y = 0.5, extra = {}) => ({ id, at: { kind: 'image-2d', x, y }, ...extra });
const img = (over = {}) => ({ id: 'g1', kind: 'annotated-image', path: 'a/b.png', x: 1, y: 2, w: 30, h: 40, anchors: [anchor('p1'), anchor('p2')], ...over });
const rel = (from, to, kind = 'supports', extra = {}) => ({ kind, from, to, ...extra });
const quietWarn = fn => {
  const original = console.warn;
  const calls = [];
  console.warn = (...args) => calls.push(args.join(' '));
  try { return { value: fn(), warns: calls }; } finally { console.warn = original; }
};
const root = path.join(__dirname, '..');
const legacy = (tag, file, fixture) => {
  // CI checks out without tags, so fall back to the committed copy of the same file.
  let source;
  try {
    source = execFileSync('git', ['show', `${tag}:${file}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    source = fs.readFileSync(path.join(__dirname, 'fixtures', fixture), 'utf8');
  }
  return source;
};
const node = (id, parentId = null) => ({ id, parentId, path: `${id}.md`, x: 0, y: 0 });
const mapText = doc => '```agent-map\n' + JSON.stringify(doc, null, 2) + '\n```';
const doc = (items, extra = {}) => ({ id: 'm', title: 't', version: 1, nodes: [node('r'), node('t1', 'r'), node('t2', 'r')], viewport: { x: 0, y: 0, zoom: 1 }, ...(items ? { canvasItems: items } : {}), ...extra });
const parse = d => plain(mm.parseMap(mapText(d), () => {}));

test('A1: a valid annotated image round-trips field by field', () => {
  const full = img({ note: 'Floor plan', anchors: [anchor('p1', 0.25, 0.75, { note: 'door' }), anchor('p2')], relations: [rel('p1', 't1', 'verifies', { description: 'why' }), rel('t2', 'p2', 'related')] });
  assert.deepEqual(sanitize([full]), [full]);
  assert.equal(JSON.stringify(sanitize([full])), JSON.stringify([full]), 'same key order');
  assert.deepEqual(sanitize([img({ anchors: [] })]), [img({ anchors: [] })]);
  assert.deepEqual(sanitize([{ ...img(), anchors: undefined }]), [img({ anchors: [] })], 'missing anchors become none');
});

test('A1: path, size and id rules match plain images; a bad one drops only itself', () => {
  const good = img({ id: 'ok' });
  const bad = [
    img({ id: 'b1', path: 'javascript:alert(1).png' }), img({ id: 'b2', path: '../x.png' }), img({ id: 'b3', path: '/abs/x.png' }),
    img({ id: 'b4', path: 'x.svg' }), img({ id: 'b5', w: 0 }), img({ id: 'b6', x: NaN }), img({ id: 'b7', h: '4' }), img({ id: 'bad id' }), 7, null, { kind: 'annotated-image' }
  ];
  assert.deepEqual(sanitize([...bad, good]), [good]);
  assert.deepEqual(sanitize([img(), img({ x: 99 })]).map(i => i.x), [1], 'duplicate id keeps the first');
  assert.deepEqual(sanitize([{ id: 'g1', kind: 'image', path: 'a.png', x: 1, y: 2, w: 3, h: 4 }, img()]).map(i => i.kind), ['image'], 'ids are unique across kinds');
});

test('A1: note is one plain line of at most 200 characters', () => {
  assert.equal(sanitize([img({ note: 'a\nb' })])[0].note, 'a b');
  assert.ok(!/[\r\n\t]/.test(sanitize([img({ note: 'a\nb\r\nc\td' })])[0].note));
  assert.equal(sanitize([img({ note: 'x'.repeat(500) })])[0].note.length, 200);
  assert.equal(sanitize([img({ note: '<img src=x onerror=alert(1)>' })])[0].note, '<img src=x onerror=alert(1)>', 'kept as a plain string; the DOM layer only uses textContent');
  for (const note of ['', '  \n ', 5, null, {}]) assert.equal('note' in sanitize([img({ note })])[0], false);
  assert.equal(sanitize([img({ anchors: [anchor('p1', 0, 0, { note: 'q'.repeat(300) })] })])[0].anchors[0].note.length, 200);
  assert.equal('note' in sanitize([img({ anchors: [anchor('p1', 0, 0, { note: ' \n ' })] })])[0].anchors[0], false);
});

test('A1: anchors - id rules, unique per image, 0-1 clamp, finite numbers, 200 limit', () => {
  const out = sanitize([img({ anchors: [anchor('p1'), anchor('p1', 0.9, 0.9), anchor('bad id'), anchor(''), { id: 5, at: { kind: 'image-2d', x: 0, y: 0 } }, anchor('p2', -0.5, 1.5), anchor('p3', NaN, 0), anchor('p4', 0, Infinity), anchor('p5', '0.5', 0), { id: 'p6' }, { id: 'p7', at: 'x' }, { id: 'p8', at: {} }, 'x', null] })])[0];
  assert.deepEqual(out.anchors.map(a => a.id), ['p1', 'p2']);
  assert.deepEqual(out.anchors[0].at, { kind: 'image-2d', x: 0.5, y: 0.5 }, 'first duplicate stays');
  assert.deepEqual(out.anchors[1].at, { kind: 'image-2d', x: 0, y: 1 });
  const many = Array.from({ length: 201 }, (_, i) => anchor(`a${i}`));
  const limited = sanitize([img({ anchors: many })])[0].anchors;
  assert.equal(limited.length, ci.ANCHOR_LIMIT);
  assert.equal(limited[199].id, 'a199');
  assert.equal(sanitize([img({ anchors: 'nope' })])[0].anchors.length, 0);
});

test('A1: an anchor with an unknown position kind is kept as written, but is not selectable', () => {
  const future = { id: 'f1', at: { kind: 'model-3d', x: 1, y: 2, z: 3, mesh: 'm' }, note: 'later' };
  const out = sanitize([img({ anchors: [future, anchor('p1')], relations: [rel('f1', 't1')] })])[0];
  assert.deepEqual(out.anchors[0], future);
  assert.deepEqual(out.relations, [rel('f1', 't1')]);
  assert.equal(ci.isImage2dAnchor(out.anchors[0]), false);
  assert.equal(ci.isImage2dAnchor(out.anchors[1]), true);
  assert.deepEqual(plain(ci.updateAnchor([out], 'g1', 'f1', { at: { x: 0.1, y: 0.1 } })[0].anchors[0].at), future.at, 'position of an unknown kind is never rewritten');
});

test('A1: relations - kind whitelist, exactly one anchor end, one per pair, 2000 limit, description', () => {
  const out = sanitize([img({ relations: [
    rel('p1', 't1', 'supports', { description: 'ok' }),
    rel('p1', 't1', 'related'), rel('t1', 'p1', 'verifies'), // same pair: first stays
    rel('p1', 'p2'), // both anchors
    rel('t1', 't2'), // both topics
    rel('p2', 't1', 'evidence'), rel('p2', 't1', 5), rel('p2', 'bad id'), rel('bad id', 'p2'), rel('p2', 5), 'x', null, { kind: 'supports' },
    rel('p2', 't2', 'prerequisite', { description: 7 }),
    rel('t2', 'p1', 'derives_from', { description: 'multi\nline' })
  ] })])[0];
  assert.deepEqual(out.relations, [rel('p1', 't1', 'supports', { description: 'ok' }), rel('p2', 't2', 'prerequisite'), rel('t2', 'p1', 'derives_from', { description: 'multi\nline' })]);
  const anchors = Array.from({ length: 200 }, (_, i) => anchor(`a${i}`));
  const relations = [];
  for (let a = 0; a < 200 && relations.length < 2001; a++) for (let t = 0; t < 11 && relations.length < 2001; t++) relations.push(rel(`a${a}`, `t${t}`));
  assert.equal(relations.length, 2001);
  const limited = sanitize([img({ anchors, relations })])[0].relations;
  assert.equal(limited.length, ci.ANCHOR_RELATION_LIMIT);
  assert.equal('relations' in sanitize([img({ relations: [] })])[0], false);
  assert.equal('relations' in sanitize([img({ relations: 'x' })])[0], false);
});

test('A1: warnings carry only counts', () => {
  const { warns } = quietWarn(() => sanitize([img({ note: 'secret', anchors: [anchor('p1'), anchor('p1'), anchor('bad id', 0, 0, { note: 'secret2' })], relations: [rel('p1', 'p1')] })]));
  assert.equal(warns.length, 1);
  assert.match(warns[0], /Dropped 3 /);
  assert.ok(!/secret|p1/.test(warns[0]));
  assert.equal(quietWarn(() => sanitize([img()])).warns.length, 0, 'nothing dropped, no warning');
});

test('A1: existing kinds and maps without annotated images are unchanged byte for byte', () => {
  const items = [{ id: 'i1', kind: 'image', path: 'a.png', x: 1, y: 2, w: 3, h: 4 }, { id: 'b1', kind: 'boundary', members: ['n1'] }, { id: 't1', kind: 'text', text: 'hi', x: 1, y: 2 }, { id: 'u1', kind: 'future', z: 1 }];
  assert.equal(JSON.stringify(sanitize(items)), JSON.stringify(items));
  const d = doc(items);
  assert.equal(JSON.stringify(parse(d).canvasItems), JSON.stringify(items), 'parseMap does not touch it');
  assert.equal('topicRelations' in parse(d), false);
  assert.equal(parse(d).version, 1);
  const ser = mm.serializeMap(mm.parseMap(mapText(d), () => {}));
  assert.equal(ser, mm.serializeMap(mm.parseMap(ser, () => {})), 'parse then serialize is stable');
});

test('A1: ANCHOR_RELATION_KINDS stays equal to TOPIC_RELATION_KINDS', () => {
  assert.deepEqual([...ci.ANCHOR_RELATION_KINDS], [...mm.TOPIC_RELATION_KINDS]);
});

test('A1: parseMap drops dangling anchor relations and anchors named like a topic; clean maps keep everything', () => {
  const clean = img({ anchors: [anchor('p1'), anchor('p2')], relations: [rel('p1', 't1'), rel('t2', 'p2')] });
  assert.deepEqual(parse(doc([clean])).canvasItems, [clean]);
  const dangling = img({ relations: [rel('p1', 't1'), rel('p2', 'gone')] });
  assert.deepEqual(parse(doc([dangling])).canvasItems[0].relations, [rel('p1', 't1')]);
  const onlyDangling = parse(doc([img({ relations: [rel('p1', 'gone')] })])).canvasItems[0];
  assert.equal('relations' in onlyDangling, false);
  const clash = img({ anchors: [anchor('t1'), anchor('p2')], relations: [rel('t1', 't2'), rel('p2', 't2')] });
  const afterClash = parse(doc([clash])).canvasItems[0];
  assert.deepEqual(afterClash.anchors.map(a => a.id), ['p2']);
  assert.deepEqual(afterClash.relations, [rel('p2', 't2')]);
  const logs = [];
  mm.parseMap(mapText(doc([dangling])), (level, message) => logs.push(`${level}:${message}`));
  assert.ok(logs.some(l => /^warn:Dropped 1 dangling/.test(l)));
  assert.equal(mm.parseMap(mapText(doc([clean])), (l, m) => logs.push(m)) && logs.length, 1, 'a clean map logs nothing');
});

test('A2: 0.28.0 and 0.30.0 canvas-items read a map with annotated images and write every field back', () => {
  const items = [img({ note: 'n', anchors: [anchor('p1', 0.1, 0.2, { note: 'a' }), { id: 'f1', at: { kind: 'model-3d', z: 1 } }], relations: [rel('p1', 't1', 'verifies', { description: 'd' })] }), { id: 'i1', kind: 'image', path: 'a.png', x: 1, y: 2, w: 3, h: 4 }];
  for (const [tag, fixture] of [['0.28.0', 'legacy-canvas-items-47c406a.ts.txt'], ['0.30.0', 'legacy-canvas-items-0.30.0.ts.txt']]) {
    const old = loadSource(legacy(tag, 'experiences/visual-map/canvas-items.ts', fixture));
    const out = plain(old.sanitizeCanvasItems(items));
    assert.deepEqual(out, items, `${tag} keeps the annotated image as an unknown kind`);
    assert.deepEqual(sanitize(out), items, `${tag} output reads back the same in the new code`);
    const moved = plain(old.moveItem(items, 'g1', 5, 5));
    assert.deepEqual(moved[0], items[0], `${tag} does not move an annotated image (only plain images)`);
  }
});

test('A1: ring is kept only as true; any other value drops the key and keeps the relation', () => {
  const ringed = img({ relations: [rel('p1', 't1', 'supports', { description: 'd', ring: true })] });
  assert.deepEqual(sanitize([ringed]), [ringed]);
  assert.equal(JSON.stringify(sanitize([ringed])), JSON.stringify([ringed]), 'ring comes after description');
  for (const bad of ['true', 'yes', false, 1, 0, null, {}, [], undefined]) {
    const out = sanitize([img({ relations: [rel('p1', 't1', 'related', { description: 'd', ring: bad })] })])[0].relations;
    assert.deepEqual(out, [rel('p1', 't1', 'related', { description: 'd' })], `ring ${JSON.stringify(bad)}`);
    assert.equal('ring' in out[0], false);
  }
});

test('A1: updateAnchorRelation, merge and addAnchorRelation keep ring; a relation without ring stays without', () => {
  const items = [img({ relations: [rel('p1', 't1', 'supports', { ring: true }), rel('p2', 't2')] })];
  const edited = plain(ci.updateAnchorRelation(items, 'g1', 'p1', 't1', rel('t1', 'p1', 'related', { description: 'x' })));
  assert.deepEqual(edited[0].relations[0], rel('t1', 'p1', 'related', { description: 'x', ring: true }), 'kind, direction, description change');
  const second = plain(ci.updateAnchorRelation(items, 'g1', 'p2', 't2', rel('p2', 't2', 'related')));
  assert.equal('ring' in second[0].relations[1], false);
  const forced = plain(ci.updateAnchorRelation(items, 'g1', 'p2', 't2', rel('p2', 't2', 'related', { ring: true })));
  assert.equal(forced[0].relations[1].ring, true, 'the caller can mark a relation');
  const stripped = plain(ci.updateAnchorRelation(items, 'g1', 'p1', 't1', rel('p1', 't1', 'supports', { ring: false })));
  assert.equal(stripped[0].relations[0].ring, true, 'an edit cannot take a topic out of the ring');
  const merged = ci.retargetAnchorRelations(items, new Set(['t1']), 't3').items;
  assert.deepEqual(plain(merged)[0].relations[0], rel('p1', 't3', 'supports', { ring: true }));
  const added = plain(ci.addAnchorRelation([img()], 'g1', rel('p1', 't9', 'related', { ring: true })));
  assert.equal(added[0].relations[0].ring, true);
  assert.equal('ring' in plain(ci.addAnchorRelation([img()], 'g1', rel('p1', 't9', 'related', { ring: 'x' })))[0].relations[0], false);
});

test('A1: parseMap and serializeMap keep ring, version stays 1, and the chat context never carries it', () => {
  const ringed = img({ relations: [rel('p1', 't1', 'supports', { ring: true }), rel('t2', 'p2', 'related')] });
  const parsed = parse(doc([ringed]));
  assert.deepEqual(parsed.canvasItems, [ringed]);
  assert.equal(parsed.version, 1);
  const ser = mm.serializeMap(mm.parseMap(mapText(doc([ringed])), () => {}));
  assert.equal(ser, mm.serializeMap(mm.parseMap(ser, () => {})), 'stable');
  assert.ok(ser.includes('"ring": true'));
  const context = buildMapChatContext({
    mapTitle: 'M', outline: [{ id: 't1', title: 'T', summary: '', parentId: null, depth: 0 }], selected: [], references: [], snippets: [], files: [], activeFile: null, history: [],
    selectedImage: { id: 'g1', kind: 'annotated', note: '', anchors: [{ id: 'p1', x: 0.1, y: 0.2 }], relations: [{ kind: 'supports', from: 'p1', to: 't1', ring: true }], imageAttached: true }
  });
  assert.deepEqual(JSON.parse(context.json).selectedImage.relations, [{ kind: 'supports', from: 'p1', to: 't1' }], 'the relation is in the context, without ring');
  assert.ok(!/"ring"/.test(context.json) && !/"ring"/.test(JSON.stringify(plain(context))), 'ring is not in the context');
});

test('A2: 0.28.0 and 0.30.0 canvas-items read a map whose relations carry ring without throwing and write every field back', () => {
  const items = [img({ anchors: [anchor('p1', 0.1, 0.2), anchor('p2')], relations: [rel('p1', 't1', 'verifies', { description: 'd', ring: true }), rel('t2', 'p2', 'related', { ring: true })] })];
  for (const [tag, fixture] of [['0.28.0', 'legacy-canvas-items-47c406a.ts.txt'], ['0.30.0', 'legacy-canvas-items-0.30.0.ts.txt']]) {
    const old = loadSource(legacy(tag, 'experiences/visual-map/canvas-items.ts', fixture));
    const out = plain(old.sanitizeCanvasItems(items));
    assert.deepEqual(out, items, `${tag} keeps ring`);
    assert.equal(JSON.stringify(out), JSON.stringify(items), `${tag} same bytes`);
    assert.deepEqual(sanitize(out), items, `${tag} output reads back the same in the new code`);
  }
});

test('A2: the 0.28.0 sanitizeTopicRelations drops nothing from a new map', () => {
  const old = loadSource(fs.readFileSync(path.join(__dirname, 'fixtures', 'legacy-sanitize-topic-relations-0.28.0.ts.txt'), 'utf8'));
  const topicRelations = [{ kind: 'supports', from: 't1', to: 't2' }, { kind: 'related', from: 'r', to: 't1', description: 'x' }];
  const target = plain(doc([img({ relations: [rel('p1', 't1')] })], { topicRelations }));
  const logs = [];
  old.sanitizeTopicRelations(target, (l, m) => logs.push(m));
  assert.deepEqual(plain(target.topicRelations), topicRelations);
  assert.equal(logs.length, 0, 'no relation dropped, no warning');
  assert.deepEqual(plain(target.canvasItems), plain(doc([img({ relations: [rel('p1', 't1')] })]).canvasItems));
});

const plainImage = (over = {}) => ({ id: 'g1', kind: 'image', path: 'a/b.png', x: 1, y: 2, w: 30, h: 40, ...over });
const byId = (items, id) => plain(items).find(i => i.id === id);

test('A3: convert image to annotated image and back; back only with no anchors', () => {
  const items = [plainImage(), plainImage({ id: 'g2' })];
  const conv = ci.convertToAnnotatedImage(items, 'g1', ' Floor\nplan ');
  assert.deepEqual(byId(conv, 'g1'), { id: 'g1', kind: 'annotated-image', path: 'a/b.png', x: 1, y: 2, w: 30, h: 40, note: 'Floor plan', anchors: [] });
  assert.deepEqual(byId(conv, 'g2'), plainImage({ id: 'g2' }));
  assert.equal('note' in byId(ci.convertToAnnotatedImage(items, 'g1'), 'g1'), false, 'note may be blank');
  assert.deepEqual(plain(ci.convertToAnnotatedImage(conv, 'g1')), plain(conv), 'already annotated: unchanged');
  assert.deepEqual(plain(ci.convertToAnnotatedImage(items, 'nope')), plain(items));
  assert.deepEqual(byId(ci.convertToPlainImage(conv, 'g1'), 'g1'), plainImage(), 'back drops the note and anchors list');
  const withAnchor = ci.addAnchor(conv, 'g1', anchor('p1'));
  assert.equal(ci.convertToPlainImage(withAnchor, 'g1'), null, 'refused while an anchor exists');
  assert.equal(ci.convertToPlainImage(items, 'g1'), null, 'not an annotated image');
  assert.notEqual(ci.convertToPlainImage(ci.removeAnchor(withAnchor, 'g1', 'p1'), 'g1'), null, 'allowed again after the last anchor goes');
});

test('A3: add, edit and remove anchors; removing an anchor removes its relations, removing a relation keeps the anchor', () => {
  const start = [img({ anchors: [], note: 'n' })];
  let items = ci.addAnchor(start, 'g1', anchor('p1', 0.2, 0.3, { note: ' door \n' }));
  items = ci.addAnchor(items, 'g1', anchor('p2', 2, -1));
  assert.deepEqual(byId(items, 'g1').anchors, [anchor('p1', 0.2, 0.3, { note: 'door' }), anchor('p2', 1, 0)]);
  assert.deepEqual(plain(ci.addAnchor(items, 'g1', anchor('p1'))), plain(items), 'duplicate id refused');
  assert.deepEqual(plain(ci.addAnchor(items, 'g1', { id: 'bad id', at: { kind: 'image-2d', x: 0, y: 0 } })), plain(items));
  assert.deepEqual(plain(ci.addAnchor(items, 'zz', anchor('p9'))), plain(items), 'unknown image');
  items = ci.updateAnchor(items, 'g1', 'p1', { note: 'gate', at: { x: 5, y: 0.5 } });
  assert.deepEqual(byId(items, 'g1').anchors[0], anchor('p1', 1, 0.5, { note: 'gate' }));
  items = ci.updateAnchor(items, 'g1', 'p1', { note: '' });
  assert.equal('note' in byId(items, 'g1').anchors[0], false);
  assert.deepEqual(plain(ci.updateAnchor(items, 'g1', 'p1', { at: { x: NaN, y: 0 } })), plain(items));
  items = ci.addAnchorRelation(items, 'g1', rel('p1', 't1'));
  items = ci.addAnchorRelation(items, 'g1', rel('t2', 'p2', 'related'));
  assert.equal(byId(items, 'g1').relations.length, 2);
  assert.deepEqual(byId(ci.removeAnchorRelation(items, 'g1', 'p1', 't1'), 'g1').anchors.length, 2, 'anchor stays when its relation goes');
  assert.deepEqual(byId(ci.removeAnchorRelation(items, 'g1', 'p1', 't1'), 'g1').relations, [rel('t2', 'p2', 'related')]);
  const last = ci.removeAnchorRelation(ci.removeAnchorRelation(items, 'g1', 'p1', 't1'), 'g1', 'p2', 't2');
  assert.equal('relations' in byId(last, 'g1'), false, 'empty relations key is removed');
  const gone = byId(ci.removeAnchor(items, 'g1', 'p1'), 'g1');
  assert.deepEqual(gone.anchors.map(a => a.id), ['p2']);
  assert.deepEqual(gone.relations, [rel('t2', 'p2', 'related')], 'only the removed anchor relations go');
  assert.equal('relations' in byId(ci.removeAnchor(ci.removeAnchor(items, 'g1', 'p1'), 'g1', 'p2'), 'g1'), false);
  assert.deepEqual(plain(ci.removeItem(items, 'g1')), [], 'deleting the image takes anchors and relations with it');
});

test('A3: anchor relation rules - one per pair, one anchor end, kind whitelist, update/reverse', () => {
  let items = [img()];
  items = ci.addAnchorRelation(items, 'g1', rel('p1', 't1', 'supports', { description: 'a' }));
  const before = plain(items);
  assert.deepEqual(plain(ci.addAnchorRelation(items, 'g1', rel('t1', 'p1', 'related'))), before, 'same pair in the other direction');
  assert.deepEqual(plain(ci.addAnchorRelation(items, 'g1', rel('p1', 't1', 'verifies'))), before, 'same pair other kind');
  assert.deepEqual(plain(ci.addAnchorRelation(items, 'g1', rel('p1', 'p2'))), before, 'two anchors');
  assert.deepEqual(plain(ci.addAnchorRelation(items, 'g1', rel('t1', 't2'))), before, 'two topics');
  assert.deepEqual(plain(ci.addAnchorRelation(items, 'g1', rel('p1', 't2', 'evidence'))), before, 'unknown kind');
  items = ci.addAnchorRelation(items, 'g1', rel('p1', 't2'));
  assert.equal(byId(items, 'g1').relations.length, 2, 'one anchor may link to several topics');
  items = ci.addAnchorRelation(items, 'g1', rel('p2', 't2'));
  assert.equal(byId(items, 'g1').relations.length, 3, 'one topic may link to several anchors');
  const edited = ci.updateAnchorRelation(items, 'g1', 'p1', 't1', rel('t1', 'p1', 'contradicts', { description: 'b' }));
  assert.deepEqual(byId(edited, 'g1').relations[0], rel('t1', 'p1', 'contradicts', { description: 'b' }), 'kind, direction and description change in place');
  assert.deepEqual(plain(ci.updateAnchorRelation(items, 'g1', 'p1', 't1', rel('p1', 't2'))), plain(items), 'cannot move to another pair');
  assert.deepEqual(plain(ci.updateAnchorRelation(items, 'g1', 'p1', 'zz', rel('p1', 'zz'))), plain(items), 'no such relation');
  const img2 = [img({ id: 'g2', anchors: [anchor('p1')] }), ...items];
  const list = ci.anchorRelationsForTopic(img2, 't2');
  assert.deepEqual(plain(list).map(e => [e.imageId, e.anchorId]), [['g1', 'p1'], ['g1', 'p2']]);
  assert.deepEqual(plain(ci.anchorRelationsForTopic(img2, 'none')), []);
  assert.deepEqual([...ci.anchorIdsOf(byId(items, 'g1'))].sort(), ['p1', 'p2']);
});

test('A3: moving and resizing an annotated image keeps the anchors (relative coordinates) as they are', () => {
  const g = img({ anchors: [anchor('p1', 0.25, 0.75)], relations: [rel('p1', 't1')] });
  const items = [g, plainImage({ id: 'g2' })];
  const moved = byId(ci.moveItem(items, 'g1', 10, -5), 'g1');
  assert.equal(moved.x, 11); assert.equal(moved.y, -3);
  assert.deepEqual(moved.anchors, g.anchors);
  assert.deepEqual(moved.relations, g.relations);
  const resized = byId(ci.resizeKeepRatio(items, 'g1', 60), 'g1');
  assert.equal(resized.w, 60); assert.equal(resized.h, 80);
  assert.equal(resized.kind, 'annotated-image');
  assert.deepEqual(resized.anchors, g.anchors);
  assert.deepEqual(byId(ci.moveItem(items, 'g1', 10, -5), 'g2'), plainImage({ id: 'g2' }));
});

const mdoc = (topicRelations, items) => ({ ...doc(items), nodes: [node('r'), node('t1', 'r'), node('t2', 'r'), node('t3', 'r'), node('t4', 'r')], ...(topicRelations ? { topicRelations } : {}) });

test('A3: removeRelationsForTopics drops topic and anchor relations of the removed topics, counts anchor ones', () => {
  const m = plain(mdoc([rel('t1', 't2'), rel('t3', 't4')], [img({ anchors: [anchor('p1'), anchor('p2')], relations: [rel('p1', 't1'), rel('t2', 'p2'), rel('p2', 't3')] })]));
  const result = mm.removeRelationsForTopics(m, ['t1', 't2']);
  assert.deepEqual(plain(result), { droppedAnchorRelations: 2 });
  assert.deepEqual(plain(m.topicRelations), [rel('t3', 't4')]);
  assert.deepEqual(m.canvasItems[0].relations, [rel('p2', 't3')]);
  assert.deepEqual(m.canvasItems[0].anchors.length, 2, 'anchors stay');
  const none = plain(mdoc(null, [plainImage()]));
  const copy = plain(none);
  assert.deepEqual(plain(mm.removeRelationsForTopics(none, ['t1'])), { droppedAnchorRelations: 0 });
  assert.deepEqual(none, copy, 'no annotated image: nothing changes');
  const all = plain(mdoc(null, [img({ relations: [rel('p1', 't1')] })]));
  mm.removeRelationsForTopics(all, ['t1']);
  assert.equal('relations' in all.canvasItems[0], false);
});

test('A3: retargetRelationsToTopic moves anchor relations to the keeper and dedupes the same pair', () => {
  const m = plain(mdoc([rel('t1', 't3'), rel('t2', 't3')], [img({ relations: [rel('p1', 't1', 'supports'), rel('t2', 'p1', 'related'), rel('p2', 't2', 'verifies', { description: 'keep' }), rel('p2', 't4')] })]));
  const drops = mm.retargetRelationsToTopic(m, ['t1', 't2'], 'keep');
  assert.deepEqual(plain(m.canvasItems[0].relations), [rel('p1', 'keep', 'supports'), rel('p2', 'keep', 'verifies', { description: 'keep' }), rel('p2', 't4')]);
  assert.deepEqual(plain(m.topicRelations), [rel('keep', 't3')], 'topic relations: same pair deduped by the wrapped function');
  assert.deepEqual(plain(drops), { droppedCycles: 0, droppedSamePair: 2 }, 'one topic pair plus one anchor pair');
  const plainMap = plain(mdoc([rel('t1', 't3')], null));
  assert.deepEqual(plain(mm.retargetRelationsToTopic(plainMap, ['t1'], 't2')), { droppedCycles: 0, droppedSamePair: 0 });
  assert.deepEqual(plain(plainMap.topicRelations), [rel('t2', 't3')]);
  const untouched = plain(mdoc(null, [img({ relations: [rel('p1', 't4')] })]));
  const snapshot = plain(untouched);
  mm.retargetRelationsToTopic(untouched, ['t1'], 't2');
  assert.deepEqual(untouched, snapshot, 'relations that do not touch the merged topics are not rewritten');
});
