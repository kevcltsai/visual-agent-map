// Annotated image P6 (A6): OPML, FreeMind and the private clipboard format never carry an annotated image, its anchors, anchor notes
// or anchor relations. The share payload does since share-match-map (owner-approved): picture position, anchors, their notes and links, never the path, relation kind or description. PNG / SVG export is covered in steps-canvas-items-view and steps-anchor-relations-view.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, core, fixture, obsidian } = require('./support.cjs');

const SECRET = 'ANCHOR-SECRET-123';
const io = load('experiences/visual-map/outline-exchange-io.ts', { obsidian });
const exchange = load('experiences/visual-map/outline-exchange.ts', { obsidian });
const share = load('experiences/sharing/share-format.ts', { obsidian });
const clip = load('experiences/visual-map/clipboard.ts', { obsidian });
const plain = value => JSON.parse(JSON.stringify(value));

const node = (id, parentId, y) => ({ id, parentId, path: `Agent Workspace/Topics/map-x/${id}.md`, x: 0, y, collapsed: false });
const nodes = [node('r', null, 0), node('c', 'r', 100), node('d', 'r', 200)];
const annotated = () => ({
  id: 'img1', kind: 'annotated-image', path: `Pics/${SECRET}.png`, x: 500, y: 0, w: 200, h: 100, note: SECRET,
  anchors: [{ id: 'a1', at: { kind: 'image-2d', x: 0.5, y: 0.5 }, note: SECRET }],
  relations: [{ kind: 'supports', from: 'a1', to: 'c', description: SECRET }]
});
const topicRelations = [{ kind: 'related', from: 'c', to: 'd', description: 'plain' }];
const mapWith = withImage => ({
  id: 'map-x', title: 'Plan', version: 1, nodes, viewport: { x: 0, y: 0, zoom: 1 }, topicRelations,
  ...(withImage ? { canvasItems: [annotated()] } : {})
});
const notes = new Map([['r', { title: 'Root', detail: 'root text' }], ['c', { title: 'Kid', detail: 'kid text' }], ['d', { title: 'Kid 2', detail: '' }]]);

async function exported(map, format) {
  const { app, contents } = fixture('en');
  await app.vault.createFolder('Agent Workspace'); await app.vault.createFolder('Agent Workspace/Topics'); await app.vault.createFolder('Agent Workspace/Topics/map-x');
  const path = await io.exportMapExchange(app.vault, { mapPath: 'Agent Workspace/Topics/map-x/Map.md', map, notes, format });
  return contents.get(path);
}

for (const format of ['opml', 'freemind']) {
  test(`${format} export: a map with an annotated image is byte-identical to the same map without it, and holds no anchor text`, async () => {
    const without = await exported(mapWith(false), format);
    const withImage = await exported(mapWith(true), format);
    assert.ok(without.length > 100);
    assert.equal(withImage, without);
    assert.equal(withImage.includes(SECRET), false);
    for (const word of ['img1', 'Pics/', 'anchor', 'supports']) assert.equal(withImage.includes(word), false, word);
  });
}

test('share payload: the annotated image travels as images (anchors, notes, links) and the path, relation kind and description stay out', () => {
  const options = { includeDetail: true, includeImages: true, language: 'en', vamVersion: '0.31.0', exportedAt: '2026-11-05T00:00:00.000Z', assets: {} };
  const notesById = { r: { title: 'Root' }, c: { title: 'Kid' }, d: { title: 'Kid 2' } };
  const { images, ...withImage } = plain(share.buildSharePayload(mapWith(true), notesById, options));
  assert.deepEqual(withImage, plain(share.buildSharePayload(mapWith(false), notesById, options)), 'everything but images is unchanged');
  assert.deepEqual(images, [{ id: 'img1', x: 500, y: 0, w: 200, h: 100, anchors: [{ id: 'a1', x: 0.5, y: 0.5, note: SECRET }], note: SECRET, links: [{ anchor: 'a1', topic: 'c' }] }]);
  const text = share.serializeShareJson(share.buildSharePayload(mapWith(true), notesById, options));
  for (const word of ['canvasItems', 'annotated-image', 'Pics/', '"path"', 'supports', 'description', 'relations']) assert.equal(text.includes(word), false, word);
  assert.equal(text.split(SECRET).length - 1, 2, 'the image note and the anchor note, nothing else');
  assert.equal('textNodes' in withImage, false);
  assert.equal('summaries' in withImage, false);
});

test('private clipboard format: only topic relations are copied; the anchor relation of a selected topic is not', () => {
  const map = mapWith(true);
  const built = clip.buildClipboardPayload({
    nodes: map.nodes, order: ['r', 'c', 'd'], selectedIds: ['r'],
    noteOf: id => ({ title: notes.get(id).title, body: notes.get(id).detail, kind: 'topic' }),
    relations: map.topicRelations ?? [], clipId: 'clip-0001'
  });
  assert.equal(built.ok, true);
  const text = clip.serializeClipboard(built.payload);
  assert.deepEqual(plain(built.payload.relations), [{ kind: 'related', from: 'n2', to: 'n3', description: 'plain' }]);
  for (const word of [SECRET, 'anchor', 'img1', 'canvasItems', 'supports']) assert.equal(text.includes(word), false, word);
  assert.equal(clip.clipboardOutline(built.payload).includes(SECRET), false);
});

test('the file round trip keeps the image out of the exchange input shape (only id and parentId are read)', () => {
  const doc = core.parseMap(core.serializeMap(mapWith(true)));
  assert.equal(doc.canvasItems.length, 1);
  const input = { title: doc.title, nodes: doc.nodes };
  assert.equal(exchange.toOpml(input, notes).includes(SECRET), false);
  assert.equal(exchange.toFreeMind(input, notes).includes(SECRET), false);
});

// P6 (image centre layout, A15): several top-level topics and a ring relation change nothing in the exports.
const ringMap = withImage => ({
  id: 'map-x', title: 'Plan', version: 1, viewport: { x: 0, y: 0, zoom: 1 }, topicRelations: [],
  nodes: [node('r1', null, 0), node('r2', null, 100), node('r3', null, 200)],
  ...(withImage ? { canvasItems: [{
    id: 'img1', kind: 'annotated-image', path: 'Pics/a.png', x: 0, y: 0, w: 200, h: 100, note: SECRET,
    anchors: [{ id: 'a1', at: { kind: 'image-2d', x: 0.2, y: 0.2 }, note: SECRET }, { id: 'a2', at: { kind: 'image-2d', x: 0.8, y: 0.2 } }, { id: 'a3', at: { kind: 'image-2d', x: 0.5, y: 0.9 } }],
    relations: [{ kind: 'related', from: 'a1', to: 'r1', ring: true }, { kind: 'related', from: 'a2', to: 'r2', ring: true }, { kind: 'related', from: 'a3', to: 'r3', ring: true }]
  }] } : {})
});
const ringNotes = new Map([['r1', { title: 'Part 1', detail: '' }], ['r2', { title: 'Part 2', detail: '' }], ['r3', { title: 'Part 3', detail: '' }]]);
for (const format of ['opml', 'freemind']) {
  test(`P6 A15 ${format}: three top-level topics with ring relations export the same as without the picture, all three topics present`, async () => {
    const { app, contents } = fixture('en');
    await app.vault.createFolder('Agent Workspace'); await app.vault.createFolder('Agent Workspace/Topics'); await app.vault.createFolder('Agent Workspace/Topics/map-x');
    const run = async map => contents.get(await io.exportMapExchange(app.vault, { mapPath: 'Agent Workspace/Topics/map-x/Map.md', map, notes: ringNotes, format }));
    const withImage = await run(ringMap(true));
    assert.equal(withImage, await run(ringMap(false)));
    for (const title of ['Part 1', 'Part 2', 'Part 3']) assert.ok(withImage.includes(title), title);
    assert.equal(/ring/i.test(withImage.replace(/Plan/g, '')), false);
  });
}
test('P6 A15 share payload: ring relations travel as ring links on the image, and no other payload part changes', () => {
  const options = { includeDetail: true, includeImages: true, language: 'en', vamVersion: '0.31.0', exportedAt: '2026-11-05T00:00:00.000Z', assets: {} };
  const notesById = { r1: { title: 'Part 1' }, r2: { title: 'Part 2' }, r3: { title: 'Part 3' } };
  const { images, ...withImage } = plain(share.buildSharePayload(ringMap(true), notesById, options));
  assert.equal(JSON.stringify(withImage), JSON.stringify(plain(share.buildSharePayload(ringMap(false), notesById, options))));
  assert.deepEqual(images[0].links, [{ anchor: 'a1', topic: 'r1', ring: true }, { anchor: 'a2', topic: 'r2', ring: true }, { anchor: 'a3', topic: 'r3', ring: true }]);
  assert.equal('ring' in withImage.nodes[0], false);
  const text = share.serializeShareJson(share.buildSharePayload(ringMap(true), notesById, options));
  for (const word of ['canvasItems', 'Pics/', '"path"', '"kind"']) assert.equal(text.includes(word), false, word);
});
