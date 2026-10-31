// Ticket 40: the fishbone spine. A horizontal main line from the head to the leftmost bone joint, drawn in the edges SVG.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./support-replay.cjs');
const geometry = load('experiences/visual-map/relation-geometry.ts');
const support = require('./support.cjs');
const dom = require('./support-dom.cjs');
const MAP = 'Agent Workspace/Topics/map-pv1/Map.md';

const box = (x, y, width = 300, height = 180) => ({ x, y, width, height });
const RUN = 1 / Math.tan(Math.PI / 3);
const jointOf = (head, topic) => {
  const m = /^M (\S+) (\S+) L/.exec(geometry.treeEdgePathData(head, topic, 'fishbone', 1));
  return [Number(m[1]), Number(m[2])];
};

test('S-1: the spine runs from the head left edge to the leftmost bone joint, for one, two and three topics', () => {
  const head = box(1000, 400);
  const topics = [box(600, 0), box(300, 700), box(0, 0)];
  for (const n of [1, 2, 3]) {
    const used = topics.slice(0, n);
    const joints = used.map(t => jointOf(head, t));
    const left = Math.min(...joints.map(j => j[0]));
    const y = 400 + 90;
    assert.equal(geometry.fishboneSpinePathData(head, used), `M 1000 ${y} L ${left} ${y}`, `${n} topics`);
    assert.ok(joints.every(j => j[1] === y), 'every bone leaves the spine line');
  }
  // The topic 600/0 is above: its card bottom is 180, the joint is 450 + 90 * ... computed by the same function as the bone.
  const [jx] = jointOf(head, topics[0]);
  assert.ok(Math.abs(jx - (750 + (490 - 180) * RUN)) < 1e-9);
});

test('S-2: no topics, no spine', () => {
  assert.equal(geometry.fishboneSpinePathData(box(1000, 400), []), '');
});

// ---- the view: copied harness shape from tests/steps-layout-group.cjs ----
async function harness(spec, extra = {}) {
  const { repo, app } = support.fixture('en', { linkIndex: true });
  const settings = { ...support.DEFAULT_SETTINGS, language: 'en', cliModel: 'gpt-6-luna' };
  repo.settings = settings;
  const mapDoc = { id: 'map-pv1', title: 'PV1', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  await repo.ensureTopicFolders('Agent Workspace/Topics/map-pv1');
  const byTitle = new Map();
  for (const [title, parentTitle, x, y, collapsed] of spec) {
    const created = await repo.createNote(title, 'gpt-6-luna', mapDoc, MAP, 'workspace');
    Object.assign(created, { parentId: parentTitle ? byTitle.get(parentTitle).id : null, x, y });
    if (collapsed) created.collapsed = true;
    byTitle.set(title, created);
    mapDoc.nodes.push(created);
  }
  Object.assign(mapDoc, extra);
  await app.vault.create(MAP, support.core.serializeMap(mapDoc));
  await repo.rebuildDerivedData();
  const createSvg = tag => ({ tag, attrs: {}, classes: [], children: [], setAttribute(n, v) { this.attrs[n] = v; }, getAttribute(n) { return this.attrs[n]; }, addClass(n) { this.classes.push(n); }, appendChild(c) { this.children.push(c); } });
  const { VisualAgentMapView } = support.load('main.ts', { obsidian: { ...support.obsidian, Modal: dom.makeModal(), Notice: dom.makeNotice([]) } }, { createFragment: dom.createFragment, createSvg, requestAnimationFrame: () => 1, cancelAnimationFrame() {} });
  const plugin = support.withExpansionCoordinator({
    repo, settings, running: new Set(), logs: { appendLog() {} }, rebuildDerivedData: () => repo.rebuildDerivedData(), relevanceGrades: new Map(), expansionBatches: new Map(), pendingSuggestions: new Map(), releaseOutline() {}, setOutlineActive() {}, detailsShown: () => false,
    mutate: work => Promise.resolve().then(work)
  });
  const view = new VisualAgentMapView({ app }, plugin);
  view.path = MAP; view.map = await repo.readMap(MAP); view.contentEl = dom.element('div'); view.stageEl = dom.element('div');
  view.focusNode = () => {}; view.openDetails = () => {}; view.render = () => {};
  view.hydrate = async () => { view.notes = new Map(await Promise.all(view.map.nodes.map(async n => [n.id, await repo.readNote(n.path)]))); };
  await view.hydrate();
  const named = title => view.map.nodes.find(n => view.notes.get(n.id)?.title === title);
  const host = { children: [], replaceChildren() { this.children = []; }, appendChild(child) { this.children.push(child); } };
  view.edgesEl = host; view.relationsLayerEl = { children: [], replaceChildren() {}, appendChild() {} };
  const place = (title, x, y) => view.cardEls.set(named(title).id, { offsetLeft: x, offsetTop: y, offsetWidth: 300, offsetHeight: 180 });
  const spines = () => host.children.filter(c => c.tag === 'path' && c.attrs['data-spine'] !== undefined);
  const paths = () => host.children.filter(c => c.tag === 'path');
  return { view, named, place, host, spines, paths };
}

const FISH = { layout: { direction: 'fishbone' } };

test('S-3: a fishbone map draws a spine in the edges SVG, with the same class as the other lines, ending at the leftmost joint', async () => {
  const h = await harness([['Root', null, 1000, 400], ['A', 'Root', 600, 0], ['B', 'Root', 300, 700], ['A1', 'A', 300, 0]], FISH);
  h.place('Root', 1000, 400); h.place('A', 600, 0); h.place('B', 300, 700); h.place('A1', 300, 0);
  h.view.drawEdges();
  assert.equal(h.spines().length, 1);
  assert.ok(h.spines()[0].classes.includes('vam-edge'));
  assert.equal(h.spines()[0].attrs.d, geometry.fishboneSpinePathData(box(1000, 400), [box(600, 0), box(300, 700)]));
  assert.equal(h.paths().length, 4, 'spine + 3 parent lines');
});

test('S-4: a root with no topics draws no spine', async () => {
  const h = await harness([['Root', null, 1000, 400]], FISH);
  h.place('Root', 1000, 400);
  h.view.drawEdges();
  assert.equal(h.spines().length, 0);
  assert.equal(h.paths().length, 0);
});

test('S-5: a collapsed root draws no spine', async () => {
  const h = await harness([['Root', null, 1000, 400, true], ['A', 'Root', 600, 0]], FISH);
  h.place('Root', 1000, 400);
  h.view.drawEdges();
  assert.equal(h.spines().length, 0);
});

test('S-6: a map laid out to the right keeps its path count (no spine)', async () => {
  const h = await harness([['Root', null, 1000, 400], ['A', 'Root', 1360, 0], ['A1', 'A', 1720, 0]]);
  h.place('Root', 1000, 400); h.place('A', 1360, 0); h.place('A1', 1720, 0);
  h.view.drawEdges();
  assert.equal(h.spines().length, 0);
  assert.equal(h.paths().length, 2);
});

test('S-7: two roots each get their own spine, not joined', async () => {
  const h = await harness([['R1', null, 1000, 400], ['A', 'R1', 600, 0], ['R2', null, 1000, 1400], ['B', 'R2', 500, 1000]], FISH);
  h.place('R1', 1000, 400); h.place('A', 600, 0); h.place('R2', 1000, 1400); h.place('B', 500, 1000);
  h.view.drawEdges();
  assert.equal(h.spines().length, 2);
  const [one, two] = h.spines().map(s => s.attrs.d);
  assert.equal(one, geometry.fishboneSpinePathData(box(1000, 400), [box(600, 0)]));
  assert.equal(two, geometry.fishboneSpinePathData(box(1000, 1400), [box(500, 1000)]));
  assert.notEqual(one, two);
});

test('S-8: dragging a first-level topic or the head recomputes the spine', async () => {
  const h = await harness([['Root', null, 1000, 400], ['A', 'Root', 600, 0], ['B', 'Root', 300, 700]], FISH);
  h.place('Root', 1000, 400); h.place('A', 600, 0); h.place('B', 300, 700);
  h.view.drawEdges();
  const key = () => h.view.spineEls.get(h.named('Root').id);
  h.view.dragEdges(h.named('B').id, { offsetWidth: 300, offsetHeight: 180 }).update(100, 700);
  assert.equal(key().attrs.d, geometry.fishboneSpinePathData(box(1000, 400), [box(600, 0), box(100, 700)]), 'topic dragged left');
  h.view.dragEdges(h.named('Root').id, { offsetWidth: 300, offsetHeight: 180 }).update(1100, 500);
  assert.equal(key().attrs.d, geometry.fishboneSpinePathData(box(1100, 500), [box(600, 0), box(300, 700)]), 'head dragged (cards still at start positions)');
});
