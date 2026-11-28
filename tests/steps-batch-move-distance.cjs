// V3.3 P1.9 (ticket B19d): a batch move keeps the moved branches' distances to each other (and inside each branch). A real view over a fake vault (as tests/steps-layout-direction.cjs); no AI.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const support = require('./support.cjs');
const dom = require('./support-dom.cjs');
const MAP = 'Agent Workspace/Topics/map-b/Map.md';

/** `spec` is [title, parentTitle|null, x, y, branch layout?] per node. */
async function harness(spec, language = 'en') {
  const { repo, app, contents } = support.fixture(language, { linkIndex: true });
  const settings = { ...support.DEFAULT_SETTINGS, language, cliModel: 'gpt-6-luna' };
  repo.settings = settings;
  const mapDoc = { id: 'map-b', title: 'Batch', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  await repo.ensureTopicFolders('Agent Workspace/Topics/map-b');
  const byTitle = new Map();
  for (const [title, parentTitle, x, y, layout] of spec) {
    const created = await repo.createNote(title, 'gpt-6-luna', mapDoc, MAP, 'workspace');
    Object.assign(created, { parentId: parentTitle ? byTitle.get(parentTitle).id : null, x, y }, layout ? { layout } : {});
    byTitle.set(title, created);
    mapDoc.nodes.push(created);
  }
  await app.vault.create(MAP, support.core.serializeMap(mapDoc));
  await repo.rebuildDerivedData();
  const notices = [];
  const Base = dom.makeModal();
  class Modal extends Base { open() { super.open(); this.close(); } }
  const { VisualAgentMapView } = support.load('main.ts', { obsidian: { ...support.obsidian, Modal, Notice: dom.makeNotice(notices) } }, { createFragment: dom.createFragment, createSvg: dom.createSvg });
  let pending = Promise.resolve();
  const plugin = support.withExpansionCoordinator({
    repo, settings, running: new Set(), logs: { appendLog() {} }, rebuildDerivedData: () => repo.rebuildDerivedData(), expansionBatches: new Map(), pendingSuggestions: new Map(), releaseOutline() {}, setOutlineActive() {}, detailsShown: () => false,
    mutate: work => (pending = Promise.resolve().then(work))
  });
  const view = new VisualAgentMapView({ app }, plugin);
  view.path = MAP; view.map = await repo.readMap(MAP); view.contentEl = dom.element('div'); view.stageEl = dom.element('div');
  view.focusNode = () => {}; view.openDetails = () => {}; view.render = () => {}; view.fit = () => {};
  view.hydrate = async () => { view.notes = new Map(await Promise.all(view.map.nodes.map(async n => [n.id, await repo.readNote(n.path)]))); };
  await view.hydrate();
  view.cardHeightOf = () => 80;
  const named = title => view.map.nodes.find(n => view.notes.get(n.id)?.title === title);
  const select = titles => { if (!view.selection.state.multiSelectMode) view.selection.toggleMultiSelect(); view.selection.replaceMulti(titles.map(title => named(title).id)); };
  const bar = () => view.renderSelectionBar(dom.element('div'));
  const files = () => new Map([...contents].filter(([path]) => path.startsWith('Agent Workspace/Topics/map-b/')));
  return { app, repo, view, named, select, bar, notices, files, settled: () => pending };
}

const SPEC = [['Root', null, 1000, 80], ['A', 'Root', 1360, 0], ['A1', 'A', 1720, 0], ['B', 'Root', 1360, 300], ['B1', 'B', 1720, 300], ['Target', 'Root', 1360, 700], ['T1', 'Target', 1720, 700]];
const MOVED = ['A', 'A1', 'B', 'B1'];

test('B19d: a batch move keeps every pair of moved cards at the same distance', async () => {
  const h = await harness(SPEC);
  h.select(['A', 'B']);
  const pairs = () => MOVED.flatMap((one, i) => MOVED.slice(i + 1).map(two => [`${one}-${two}`, h.named(two).x - h.named(one).x, h.named(two).y - h.named(one).y]));
  const before = pairs();
  await h.view.moveBranches(h.view.selectedRoots(), h.named('Target'));
  assert.equal(h.named('A').parentId, h.named('Target').id);
  assert.deepEqual(pairs(), before);
});

test('B19d: the moved branches do not overlap the target\'s existing children', async () => {
  const h = await harness(SPEC);
  h.select(['A', 'B']);
  await h.view.moveBranches(h.view.selectedRoots(), h.named('Target'));
  const others = ['T1'].map(h.named);
  for (const title of MOVED) {
    const node = h.named(title);
    for (const other of others) {
      const apart = Math.abs(node.y - other.y) >= 80 || Math.abs(node.x - other.x) >= 200;
      assert.ok(apart, `${title} overlaps ${other.id}`);
    }
  }
});

test('B19d: a single branch move is laid out as before (under the target, distance inside kept)', async () => {
  const h = await harness(SPEC);
  const dist = h.named('A1').y - h.named('A').y;
  await h.view.moveBranches([h.named('A')], h.named('Target'));
  assert.equal(h.named('A').parentId, h.named('Target').id);
  assert.equal(h.named('A1').y - h.named('A').y, dist);
  assert.ok(h.named('A').x > h.named('Target').x);
});

// B19d-x: a batch move to a parent that grows the same way carries every branch as a whole block; hand-placed offsets inside a branch stay.
const HAND = [['Root', null, 1000, 80], ['A', 'Root', 1360, 0], ['A1', 'A', 1720, -50], ['A2', 'A', 1790, 130], ['A3', 'A2', 2150, 260], ['B', 'Root', 1360, 300], ['B1', 'B', 1720, 300], ['C', 'Root', 1360, 500], ['Target', 'Root', 1360, 900], ['T1', 'Target', 1720, 900]];
const ALL_MOVED = ['A', 'A1', 'A2', 'A3', 'B', 'B1', 'C'];
const overlaps = h => {
  const nodes = h.view.map.nodes, bad = [];
  nodes.forEach((a, i) => nodes.slice(i + 1).forEach(b => { if (Math.abs(a.y - b.y) < 80 && Math.abs(a.x - b.x) < 200) bad.push(`${a.id}/${b.id}`); }));
  return bad;
};
const mapWrites = h => {
  const writes = [];
  for (const name of ['process', 'modify']) {
    const was = h.app.vault[name];
    if (typeof was === 'function') h.app.vault[name] = function (file, ...rest) { if ((file.path ?? file) === MAP) writes.push(name); return was.call(this, file, ...rest); };
  }
  return writes;
};

test('B19d-x: a hand-arranged branch keeps every inner offset when three branches move under a parent growing the same way; 0 overlaps, one write, one undo', async () => {
  const h = await harness(HAND);
  h.select(['A', 'B', 'C']);
  const rel = () => ALL_MOVED.flatMap((one, i) => ALL_MOVED.slice(i + 1).map(two => [`${one}-${two}`, h.named(two).x - h.named(one).x, h.named(two).y - h.named(one).y]));
  const before = rel(), coords = new Map(h.view.map.nodes.map(n => [n.id, [n.x, n.y]])), files = h.files(), past = h.view.history.past.length;
  const writes = mapWrites(h);
  await h.view.moveBranches(h.view.selectedRoots(), h.named('Target'));
  assert.equal(h.named('A').parentId, h.named('Target').id);
  assert.deepEqual(rel(), before, 'every pair of moved cards keeps its offset');
  assert.deepEqual(overlaps(h), [], 'nothing overlaps');
  assert.equal(writes.length, 1, 'Map.md is written once');
  assert.equal(h.view.history.past.length, past + 1, 'one history step');
  await h.view.history.undo().undo();
  assert.deepEqual(h.files(), files, 'one undo restores Map.md byte for byte');
  for (const n of h.view.map.nodes) assert.deepEqual([n.x, n.y], coords.get(n.id), `${n.id} back at its place`);
});

test('B19d-x: moving the hand-arranged branches under a parent that grows the other way may re-arrange them, still 0 overlaps', async () => {
  const h = await harness(HAND.map(row => (row[0] === 'Target' ? [...row, { direction: 'down' }] : row)));
  h.select(['A', 'B', 'C']);
  await h.view.moveBranches(h.view.selectedRoots(), h.named('Target'));
  assert.equal(h.named('A').parentId, h.named('Target').id);
  assert.deepEqual(overlaps(h), []);
});

test('B19d-x: a card outside the moved branches that nothing covers keeps its exact place (no gap left by the layout)', async () => {
  const h = await harness([...HAND.filter(row => row[0] !== 'T1'), ['Y', 'Root', 1360, 700], ['O', 'Y', 2440, 1030]]);
  h.select(['A', 'B', 'C']);
  const was = new Map(h.view.map.nodes.map(n => [n.id, [n.x, n.y]]));
  await h.view.moveBranches(h.view.selectedRoots(), h.named('Target'));
  const movedIds = new Set(ALL_MOVED.map(title => h.named(title).id));
  const moved = [...movedIds].map(id => h.view.map.nodes.find(n => n.id === id));
  for (const n of h.view.map.nodes) {
    if (movedIds.has(n.id)) continue;
    const [x, y] = was.get(n.id);
    const covered = moved.some(m => Math.abs(m.y - y) < 80 && Math.abs(m.x - x) < 200);
    if (!covered) assert.deepEqual([n.x, n.y], [x, y], `${h.view.notes.get(n.id)?.title} was not covered, so it stays`);
  }
  assert.deepEqual(overlaps(h), []);
});

test('B19d-x: branches from different old parents are judged one by one: the same-way ones are carried whole, the other way may be re-arranged, 0 overlaps', async () => {
  const spec = [...HAND, ['Pd', 'Root', 1360, 1100, { direction: 'down' }], ['D', 'Pd', 1360, 1250], ['D1', 'D', 1360, 1400]];
  const h = await harness(spec);
  h.select(['A', 'B', 'C', 'D']);
  const keep = ['A', 'A1', 'A2', 'A3', 'B', 'B1', 'C'];
  const rel = () => keep.flatMap((one, i) => keep.slice(i + 1).map(two => [h.named(two).x - h.named(one).x, h.named(two).y - h.named(one).y]));
  const before = rel();
    await h.view.moveBranches(h.view.selectedRoots(), h.named('Target'));
  assert.equal(h.named('D').parentId, h.named('Target').id);
  assert.deepEqual(rel(), before, 'the same-way branches keep every offset');
  assert.deepEqual(overlaps(h), []);
});
