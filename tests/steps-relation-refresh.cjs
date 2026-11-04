// Relation references 02: a relation change rewrites the Reference Links of its two end notes at once (and only those
// notes); a description-only change writes no note. Real Repository and view; the plugin's rebuild is spied on.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, fixture, DEFAULT_SETTINGS, obsidian, withExpansionCoordinator } = require('./support.cjs');
const dom = require('./support-dom.cjs');

const { begin, relationNotePaths } = load('experiences/visual-map/map-transaction.ts', { obsidian });

// A bare SVG element: the relation editor draws a line sample.
const createSvg = tag => ({ tag, attrs: {}, classes: [], children: [], setAttribute(n, v) { this.attrs[n] = v; }, addClass(n) { this.classes.push(n); }, toggleClass() {}, addEventListener() {}, appendChild(c) { this.children.push(c); } });

async function harness() {
  const { repo, app, contents } = fixture('en');
  repo.settings = { ...DEFAULT_SETTINGS, language: 'en', cliModel: 'gpt-6-luna' };
  const mapPath = await repo.createMap('Relations');
  const doc = await repo.readMap(mapPath);
  const ids = {}, paths = {};
  for (const key of ['root', 'a', 'b', 'c']) {
    const node = await repo.createNote(key.toUpperCase(), 'gpt-6-luna', doc, mapPath, 'workspace');
    node.parentId = key === 'root' ? null : ids.root;
    doc.nodes.push(node);
    ids[key] = node.id;
    paths[key] = node.path;
  }
  await repo.saveMap(mapPath, doc);
  await repo.rebuildDerivedData();
  // Which notes each rebuild was limited to (undefined: a full rebuild), and every note write.
  const rebuilds = [], writes = [];
  const process = app.vault.process;
  app.vault.process = async (file, change) => {
    const before = contents.get(file.path);
    await process(file, change);
    if (contents.get(file.path) !== before && !file.path.endsWith('/Map.md')) writes.push(file.path);
  };
  const plugin = withExpansionCoordinator({
    repo, settings: repo.settings, running: new Set(), logs: { appendLog() {} },
    rebuildDerivedData: scope => { rebuilds.push(scope); return repo.rebuildDerivedData(scope ? { roots: [], paths: scope } : undefined); },
    relevanceGrades: new Map(), expansionBatches: new Map(), pendingSuggestions: new Map(), releaseOutline() {}, setOutlineActive() {}, detailsShown: () => false
  });
  const { VisualAgentMapView } = load('main.ts', { obsidian: { ...obsidian, Modal: dom.makeModal(), Notice: dom.makeNotice([]) } }, { createFragment: dom.createFragment, createSvg });
  const view = new VisualAgentMapView({ app }, plugin);
  view.path = mapPath; view.map = await repo.readMap(mapPath); view.contentEl = dom.element('div'); view.stageEl = dom.element('div');
  view.focusNode = () => {}; view.openDetails = () => {}; view.render = () => {}; view.drawEdges = () => {}; view.updateHistoryButtons = () => {};
  view.enqueue = work => work();
  await view.hydrate();
  const refs = key => {
    const block = /## Reference Links\n\n([\s\S]*?)\n<!-- visual-agent-map:references:end -->/.exec(contents.get(paths[key]));
    return block ? block[1].split('\n').map(line => line.replace(/^- /, '')) : [];
  };
  const link = key => `[[${paths[key].replace(/\.md$/, '')}]]`;
  const relationLines = key => refs(key).filter(line => !/^(Topic|Mind map|Parent topic|Child topics|Source topic|Status):/.test(line));
  const reset = () => { rebuilds.length = 0; writes.length = 0; };
  const snapshot = () => new Map(contents);
  return { repo, app, contents, mapPath, view, ids, paths, refs, link, relationLines, rebuilds, writes, reset, snapshot };
}
const sorted = list => [...list].sort();
const own = list => [...list];

test('S1: adding a relation from the panel writes both ends at once, and only them', async () => {
  const h = await harness();
  h.reset();
  await h.view.addRelation(h.ids.a, h.ids.b, 'supports');
  assert.deepEqual(h.relationLines('a'), [`Supports: ${h.link('b')}`]);
  assert.deepEqual(h.relationLines('b'), [`Supported by: ${h.link('a')}`]);
  assert.deepEqual(h.rebuilds.map(sorted), [sorted([h.paths.a, h.paths.b])], 'one rebuild, limited to the two ends');
  assert.deepEqual(sorted(h.writes), sorted([h.paths.a, h.paths.b]), 'no other note is written');
});

test('S2: removing a relation removes the lines at both ends; undo brings them back, redo removes them again', async () => {
  const h = await harness();
  await h.view.addRelation(h.ids.a, h.ids.b, 'contradicts');
  await h.view.addRelation(h.ids.c, h.ids.a, 'verifies');
  assert.deepEqual(h.relationLines('a'), [`Contradicts: ${h.link('b')}`, `Verified by: ${h.link('c')}`]);
  h.reset();
  await h.view.removeRelation(h.view.map.topicRelations[0]);
  assert.deepEqual(h.relationLines('a'), [`Verified by: ${h.link('c')}`]);
  assert.deepEqual(h.relationLines('b'), []);
  assert.deepEqual(sorted(h.writes), sorted([h.paths.a, h.paths.b]), 'C is untouched');
  h.reset();
  await h.view.travel(false);
  assert.deepEqual(h.relationLines('a'), [`Contradicts: ${h.link('b')}`, `Verified by: ${h.link('c')}`], 'undo');
  assert.deepEqual(h.relationLines('b'), [`Contradicted by: ${h.link('a')}`]);
  assert.deepEqual(sorted(h.writes), sorted([h.paths.a, h.paths.b]));
  await h.view.travel(true);
  assert.deepEqual(h.relationLines('b'), [], 'redo');
  await h.view.travel(false);
  await h.view.travel(false);
  assert.deepEqual(h.relationLines('c'), [], 'undoing the add removes the line again');
  assert.deepEqual(h.relationLines('a'), [`Contradicts: ${h.link('b')}`]);
});

test('S3: the relation editor: reverse swaps the wording at both ends at once; a kind change rewrites it; a description writes no note', async () => {
  const h = await harness();
  await h.view.addRelation(h.ids.a, h.ids.b, 'derives_from');
  const host = dom.element('editor');
  h.view.renderRelationEditor(host, h.view.map.topicRelations[0], () => {}, () => {});
  h.reset();
  dom.button(host, 'Reverse direction').click();
  await dom.tick(); await dom.tick();
  assert.deepEqual(h.relationLines('a'), [`Derives: ${h.link('b')}`]);
  assert.deepEqual(h.relationLines('b'), [`Derived from: ${h.link('a')}`]);
  assert.deepEqual(sorted(h.writes), sorted([h.paths.a, h.paths.b]));
  const select = dom.find(host, c => c.tag === 'select');
  select.value = 'prerequisite'; select.fire('change');
  await dom.tick(); await dom.tick();
  assert.deepEqual(h.relationLines('b'), [`Prerequisite for: ${h.link('a')}`]);
  assert.deepEqual(h.relationLines('a'), [`Prerequisites: ${h.link('b')}`]);
  const notes = [h.contents.get(h.paths.a), h.contents.get(h.paths.b)];
  h.reset();
  await h.view.mapChange(map => { map.topicRelations[0].description = 'Only the note changes'; }, false);
  assert.equal(h.view.map.topicRelations[0].description, 'Only the note changes');
  assert.deepEqual([h.contents.get(h.paths.a), h.contents.get(h.paths.b)], notes, 'both notes are byte for byte the same');
  assert.deepEqual(h.rebuilds, [], 'no rebuild for a description');
  assert.deepEqual(h.writes, []);
});

test('S4: a change that leaves every relation as it was writes no note', async () => {
  const h = await harness();
  await h.view.addRelation(h.ids.a, h.ids.b, 'related');
  const before = h.snapshot();
  h.reset();
  await h.view.addRelation(h.ids.b, h.ids.a, 'supports'); // refused: the pair already holds one
  await h.view.mapChange(map => { map.viewport = { x: 9, y: 9, zoom: 1 }; }, false);
  assert.deepEqual(h.rebuilds, []);
  for (const key of ['root', 'a', 'b', 'c']) assert.equal(h.contents.get(h.paths[key]), before.get(h.paths[key]));
});

test('S5: relationNotePaths lists the ends of added, removed, reversed and re-kinded relations, not of a description change', () => {
  const nodes = ['a', 'b', 'c', 'd'].map(id => ({ id, path: `${id}.md` }));
  const map = relations => ({ nodes, topicRelations: relations });
  const r = (kind, from, to, description) => ({ kind, from, to, ...(description ? { description } : {}) });
  assert.deepEqual(own(relationNotePaths(map([r('supports', 'a', 'b')]), map([r('supports', 'a', 'b', 'why')]))), []);
  assert.deepEqual(sorted(relationNotePaths(map([]), map([r('supports', 'a', 'b')]))), ['a.md', 'b.md']);
  assert.deepEqual(sorted(relationNotePaths(map([r('supports', 'a', 'b'), r('related', 'c', 'd')]), map([r('related', 'c', 'd')]))), ['a.md', 'b.md']);
  assert.deepEqual(sorted(relationNotePaths(map([r('supports', 'a', 'b')]), map([r('supports', 'b', 'a')]))), ['a.md', 'b.md']);
  assert.deepEqual(sorted(relationNotePaths(map([r('supports', 'a', 'b')]), map([r('verifies', 'a', 'b')]))), ['a.md', 'b.md']);
});

test('S6: without refreshNotes (an older caller) the transaction still commits; a failed save puts the notes back', async () => {
  const h = await harness();
  const refreshed = [];
  const deps = { repo: h.repo, rebuildDerivedData: () => h.repo.rebuildDerivedData(), onApplied: () => {}, checkConflict: async () => {} };
  await begin(deps).editMap(h.mapPath, map => { map.topicRelations = [{ kind: 'supports', from: h.ids.a, to: h.ids.b }]; }).commit({ deferRebuild: true });
  assert.deepEqual(h.relationLines('a'), [], 'no refresh without the dependency');
  const withRefresh = { ...deps, refreshNotes: async paths => { refreshed.push(sorted(paths)); await h.repo.rebuildDerivedData({ roots: [], paths }); } };
  const entry = await begin(withRefresh).editMap(h.mapPath, map => { map.topicRelations = [{ kind: 'supports', from: h.ids.a, to: h.ids.c }]; }).commit({ deferRebuild: true });
  assert.deepEqual(h.relationLines('a'), [`Supports: ${h.link('c')}`]);
  assert.deepEqual(h.relationLines('b'), [], 'B lost its relation in this step and is refreshed too');
  assert.deepEqual(refreshed, [sorted([h.paths.a, h.paths.b, h.paths.c])]);
  await entry.undo();
  assert.deepEqual(h.relationLines('a'), [`Supports: ${h.link('b')}`]);
  assert.deepEqual(h.relationLines('c'), []);
  const before = h.snapshot();
  const failing = Object.create(h.repo);
  let saves = 0;
  failing.saveMap = async (...args) => { if (++saves === 1) { await h.repo.saveMap(...args); throw new Error('injected saveMap'); } return h.repo.saveMap(...args); };
  await assert.rejects(begin({ ...withRefresh, repo: failing }).editMap(h.mapPath, map => { delete map.topicRelations; }).commit({ deferRebuild: true }), /injected saveMap/);
  for (const key of ['a', 'b', 'c']) assert.equal(h.contents.get(h.paths[key]), before.get(h.paths[key]), `${key} is as before the failed step`);
});
