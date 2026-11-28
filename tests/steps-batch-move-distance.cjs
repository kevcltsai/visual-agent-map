// V3.3 P1.9 (ticket B19d): a batch move keeps the moved branches' distances to each other (and inside each branch). A real view over a fake vault (as tests/steps-layout-direction.cjs); no AI.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const support = require('./support.cjs');
const dom = require('./support-dom.cjs');
const MAP = 'Agent Workspace/Topics/map-b/Map.md';

/** `spec` is [title, parentTitle|null, x, y] per node. */
async function harness(spec, language = 'en') {
  const { repo, app, contents } = support.fixture(language, { linkIndex: true });
  const settings = { ...support.DEFAULT_SETTINGS, language, cliModel: 'gpt-6-luna' };
  repo.settings = settings;
  const mapDoc = { id: 'map-b', title: 'Batch', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  await repo.ensureTopicFolders('Agent Workspace/Topics/map-b');
  const byTitle = new Map();
  for (const [title, parentTitle, x, y] of spec) {
    const created = await repo.createNote(title, 'gpt-6-luna', mapDoc, MAP, 'workspace');
    Object.assign(created, { parentId: parentTitle ? byTitle.get(parentTitle).id : null, x, y });
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
  return { repo, view, named, select, bar, notices, files, settled: () => pending };
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
