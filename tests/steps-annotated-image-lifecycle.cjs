// Annotated image P2 (A3): what delete, merge, adopt and duplicate do to the anchor relations of an annotated image.
// Cross-map cut and copy are in steps-clipboard-cross-cut.cjs (they need that file's two-map harness).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, fixture, DEFAULT_SETTINGS, normalizeReasoningLevel, obsidian, plain } = require('./support.cjs');
const dom = require('./support-dom.cjs');

const rel = (kind, from, to, extra = {}) => ({ kind, from, to, ...extra });
const anchor = (id, x = 0.5, y = 0.5) => ({ id, at: { kind: 'image-2d', x, y } });

async function harness() {
  const { repo, app, contents } = fixture(), path = await repo.createMap('Anchors', []), mapDoc = await repo.readMap(path);
  const ids = {}, notes = {};
  const add = async (key, parentKey) => {
    const n = await repo.createNote(key, 'a', mapDoc, path, 'workspace', {});
    n.parentId = parentKey ? ids[parentKey] : null; n.x = 400; n.y = 100 * mapDoc.nodes.length; mapDoc.nodes.push(n); ids[key] = n.id; notes[key] = n;
  };
  await add('root'); await add('f1', 'root'); await add('f2', 'root'); await add('x', 'root'); await add('y', 'root');
  let queue = Promise.resolve();
  const plugin = { repo, settings: { ...DEFAULT_SETTINGS }, rebuildDerivedData: () => repo.rebuildDerivedData(), mutate(work) { queue = queue.then(work); return queue; }, running: new Set(), abortChartJobs: () => {}, addChartsAfterWrite: () => {}, quickExpandPending: new Set(), activeTasks: new Map(), expansionBatches: new Map(), currentModelChoice() { return { model: this.settings.cliModel, reasoning: normalizeReasoningLevel(this.settings.cliReasoning) }; } };
  const notices = [];
  const { VisualAgentMapView } = load('main.ts', { obsidian: { ...obsidian, Notice: dom.makeNotice(notices) } }, { requestAnimationFrame: run => { run(); return 1; }, cancelAnimationFrame() {} });
  const view = new VisualAgentMapView({ app }, plugin);
  view.path = path; view.map = mapDoc; view.render = () => {}; view.focusNode = () => {}; view.drawEdges = () => {}; view.updateHistoryButtons = () => {};
  const image = relations => ({ id: 'g1', kind: 'annotated-image', path: 'a/b.png', x: 1, y: 2, w: 30, h: 40, anchors: [anchor('p1'), anchor('p2')], relations });
  const seed = async (relations, topicRelations) => {
    mapDoc.canvasItems = [image(relations), { id: 'plain', kind: 'image', path: 'c.png', x: 0, y: 0, w: 5, h: 5 }];
    if (topicRelations) mapDoc.topicRelations = topicRelations;
    await repo.saveMap(path, mapDoc); view.map = await repo.readMap(path); await repo.rebuildDerivedData(); await view.hydrate();
  };
  const saved = async () => repo.readMap(path);
  const anchorRelations = async () => plain(((await saved()).canvasItems ?? []).find(i => i.id === 'g1')?.relations ?? null);
  const canvas = async () => plain((await saved()).canvasItems);
  await view.hydrate();
  return { repo, app, contents, path, mapDoc, ids, notes, view, notices, seed, saved, anchorRelations, canvas, noticeTexts: () => notices.slice() };
}

test('A3 delete: removing a topic drops only the anchor relations that touch it; anchors, the image and other relations stay; undo restores everything', async () => {
  const h = await harness();
  const keep = rel('related', 'p1', h.ids.x);
  await h.seed([rel('supports', 'p1', h.ids.f1), rel('related', h.ids.f1, 'p2'), keep, rel('derives_from', 'p2', h.ids.y)], [rel('supports', h.ids.f1, h.ids.x)]);
  const before = await h.canvas();
  await h.view.removeToUnassigned(h.notes.f1, false);
  assert.deepEqual(await h.anchorRelations(), [keep, rel('derives_from', 'p2', h.ids.y)]);
  const after = await h.canvas();
  assert.deepEqual(after.find(i => i.id === 'g1').anchors, before.find(i => i.id === 'g1').anchors, 'both anchors stay');
  assert.deepEqual(after.find(i => i.id === 'plain'), before.find(i => i.id === 'plain'));
  assert.equal((await h.saved()).topicRelations, undefined, 'the topic relation of f1 went too');
  await h.view.travel(false);
  assert.deepEqual(await h.canvas(), before, 'undo brings back every field');
  await h.view.travel(true);
  assert.deepEqual(await h.anchorRelations(), [keep, rel('derives_from', 'p2', h.ids.y)], 'redo');
});

test('A3 delete: removing a branch (removeSelected) drops the anchor relations of every removed topic, keeps the rest', async () => {
  const h = await harness();
  await h.seed([rel('supports', 'p1', h.ids.f1), rel('related', 'p1', h.ids.f2), rel('related', 'p2', h.ids.x)]);
  const before = await h.canvas();
  h.view.selection.setSelected(h.ids.f1); h.view.selection.replaceMulti([h.ids.f1, h.ids.f2]);
  await h.view.removeSelected();
  assert.deepEqual(await h.anchorRelations(), [rel('related', 'p2', h.ids.x)]);
  assert.equal((await h.canvas()).find(i => i.id === 'g1').anchors.length, 2);
  await h.view.travel(false);
  assert.deepEqual(await h.canvas(), before);
});

test('A3 delete: deleting the image takes its anchors and relations with it, the topics stay', async () => {
  const h = await harness();
  await h.seed([rel('supports', 'p1', h.ids.f1)], [rel('supports', h.ids.f2, h.ids.x)]);
  const before = await h.canvas();
  await h.view.removeCanvasItem('g1');
  assert.deepEqual((await h.canvas()).map(i => i.id), ['plain']);
  assert.equal((await h.saved()).nodes.length, 5);
  assert.deepEqual(plain((await h.saved()).topicRelations), [rel('supports', h.ids.f2, h.ids.x)]);
  await h.view.travel(false);
  assert.deepEqual(await h.canvas(), before);
});

test('A3 merge: one anchor linked to two merged topics keeps one relation, the drop is counted in the notice; undo restores both', async () => {
  const h = await harness();
  await h.seed([rel('supports', 'p1', h.ids.f1), rel('contradicts', h.ids.f2, 'p1'), rel('related', 'p2', h.ids.f2), rel('related', 'p2', h.ids.y)]);
  const original = await h.anchorRelations();
  await h.view.selection.replaceMulti([h.ids.f1, h.ids.f2]);
  const check = h.view.mergeCheck(); assert.equal(check.ok, true, JSON.stringify(check));
  await h.view.mergeSelected('Merged', { path: h.path, mapId: h.mapDoc.id, targetId: check.targetId, sources: check.sources.map(n => ({ id: n.id, path: n.path })) });
  const merged = (await h.saved()).nodes.find(n => !Object.values(h.ids).includes(n.id)).id;
  assert.deepEqual(await h.anchorRelations(), [rel('supports', 'p1', merged), rel('related', 'p2', merged), rel('related', 'p2', h.ids.y)], 'first of each (anchor, topic) pair stays, other ends untouched');
  assert.equal(h.view.lastDroppedSamePair, 1, 'the same-pair drop of the anchor relation is counted');
  assert.equal(h.notices.length >= 1, true, 'the merge notice appeared');
  await h.view.travel(false);
  assert.deepEqual(await h.anchorRelations(), original, 'undo restores both');
});

test('A3 merge into parent: anchor relations of the subtopics move to the parent; a duplicate pair is dropped; undo restores', async () => {
  const h = await harness();
  await h.seed([rel('supports', 'p1', h.ids.root), rel('supports', 'p1', h.ids.f1), rel('related', 'p2', h.ids.f1)]);
  const original = await h.anchorRelations();
  await h.view.selection.replaceMulti([h.ids.root, h.ids.f1]);
  const check = h.view.mergeCheck(); assert.equal(check.ok, true, JSON.stringify(check));
  assert.equal(check.targetId, h.ids.root, 'parent mode');
  await h.view.mergeSelected('Merged', { path: h.path, mapId: h.mapDoc.id, targetId: check.targetId, sources: check.sources.map(n => ({ id: n.id, path: n.path })) });
  const rels = await h.anchorRelations();
  assert.equal(rels.length, 2, JSON.stringify(rels));
  assert.deepEqual(rels.map(r => [r.kind, r.from]), [['supports', 'p1'], ['related', 'p2']]);
  assert.equal(rels[0].to, rels[1].to);
  assert.equal(h.view.lastDroppedSamePair, 1);
  await h.view.travel(false);
  assert.deepEqual(await h.anchorRelations(), original);
});

test('A3 adopt (structure review): the removed topic\'s anchor relations move to the adopter; a pair the adopter already has is dropped and counted; undo restores', async () => {
  const h = await harness();
  await h.seed([rel('supports', 'p1', h.ids.f1), rel('related', 'p1', h.ids.x), rel('related', 'p2', h.ids.f1)]);
  const original = await h.anchorRelations();
  await h.view.removeToUnassigned(h.notes.f1, false, h.ids.x);
  assert.deepEqual(await h.anchorRelations(), [rel('supports', 'p1', h.ids.x), rel('related', 'p2', h.ids.x)]);
  assert.equal(h.view.lastDroppedSamePair, 1);
  await h.view.travel(false);
  assert.deepEqual(await h.anchorRelations(), original);
});

test('A3 map without an annotated image: delete, merge and adopt leave canvasItems and notices as before', async () => {
  const h = await harness();
  h.mapDoc.canvasItems = [{ id: 'plain', kind: 'image', path: 'c.png', x: 0, y: 0, w: 5, h: 5 }];
  await h.repo.saveMap(h.path, h.mapDoc); h.view.map = await h.repo.readMap(h.path); await h.view.hydrate();
  const before = await h.canvas();
  await h.view.removeToUnassigned(h.notes.f1, false, h.ids.x);
  await h.view.removeToUnassigned(h.notes.f2, false);
  assert.deepEqual(await h.canvas(), before);
  assert.equal(h.view.lastDroppedSamePair, 0);
});

test('A3 duplicate map: anchor relations point at the copied topics, anchor ids and everything else stay; the source is not changed', async () => {
  const data = fixture('en'), { repo } = data;
  const mapPath = await repo.createMap('Trip');
  const map = await repo.readMap(mapPath);
  const a = await repo.createNote('A', 'm', map, mapPath, 'workspace'), b = await repo.createNote('B', 'm', map, mapPath, 'workspace');
  b.parentId = a.id; map.nodes.push(a, b);
  map.canvasItems = [{ id: 'g1', kind: 'annotated-image', path: 'a/b.png', x: 1, y: 2, w: 30, h: 40, note: 'plan', anchors: [anchor('p1'), anchor('p2')], relations: [rel('supports', 'p1', a.id, { description: 'why' }), rel('related', b.id, 'p2')] }];
  await repo.saveMap(mapPath, map);
  const source = plain(await repo.readMap(mapPath));
  const copy = await repo.readMap(await repo.duplicateMap(mapPath, 'Trip copy'));
  const [ca, cb] = ['A', 'B'].map(title => copy.nodes.find(n => n.path.includes(`/${title}`)));
  assert.ok(ca && cb && ca.id !== a.id);
  const image = plain(copy.canvasItems[0]);
  assert.deepEqual(image.relations, [rel('supports', 'p1', ca.id, { description: 'why' }), rel('related', cb.id, 'p2')]);
  assert.deepEqual(image.anchors, [anchor('p1'), anchor('p2')], 'anchor ids and positions do not change');
  assert.equal(image.note, 'plan');
  assert.deepEqual(plain(await repo.readMap(mapPath)), source, 'the source map is not changed');
});
