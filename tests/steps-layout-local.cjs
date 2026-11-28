// A9 fix: adding cards, folding and AI batches leave every other branch where it is (A1 40-card fixture, view level, no UI).
// Root cause pinned here: a batch of 5+ new cards, a fold/unfold and a height tidy each laid the WHOLE map out again.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const support = require('./support.cjs');
const dom = require('./support-dom.cjs');
const MAP = 'Agent Workspace/Topics/map-d/Map.md';

/** `spec` is [title, parentTitle|null, x, y] per node; `extra` is merged into the map before it is saved. */
async function harness(spec, extra = {}) {
  const { repo, app } = support.fixture('en', { linkIndex: true });
  const settings = { ...support.DEFAULT_SETTINGS, language: 'en', cliModel: 'gpt-6-luna' };
  repo.settings = settings;
  const mapDoc = { id: 'map-d', title: 'Direction', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  await repo.ensureTopicFolders('Agent Workspace/Topics/map-d');
  const byTitle = new Map();
  for (const [title, parentTitle, x, y] of spec) {
    const created = await repo.createNote(title, 'gpt-6-luna', mapDoc, MAP, 'workspace');
    Object.assign(created, { parentId: parentTitle ? byTitle.get(parentTitle).id : null, x, y });
    byTitle.set(title, created);
    mapDoc.nodes.push(created);
  }
  Object.assign(mapDoc, extra);
  await app.vault.create(MAP, support.core.serializeMap(mapDoc));
  await repo.rebuildDerivedData();
  const menus = [];
  class Menu {
    constructor() { this.items = []; menus.push(this); }
    addItem(callback) { const item = { checked: undefined, setTitle(value) { this.title = value; return this; }, setIcon(value) { this.icon = value; return this; }, setChecked(value) { this.checked = value; return this; }, onClick(handler) { this.click = handler; return this; } }; callback(item); this.items.push(item); return this; }
    addSeparator() { this.items.push({ separator: true }); return this; }
    showAtMouseEvent() { return this; }
  }
  const Base = dom.makeModal();
  class Modal extends Base { open() { super.open(); this.close(); } }
  const createSvg = tag => ({ tag, attrs: {}, classes: [], children: [], setAttribute(n, v) { this.attrs[n] = v; }, getAttribute(n) { return this.attrs[n]; }, addClass(n) { this.classes.push(n); }, appendChild(c) { this.children.push(c); } });
  const { VisualAgentMapView } = support.load('main.ts', { obsidian: { ...support.obsidian, Modal, Menu, Notice: dom.makeNotice([]) } }, { createFragment: dom.createFragment, createSvg });
  let pending = Promise.resolve();
  const plugin = support.withExpansionCoordinator({
    repo, settings, running: new Set(), logs: { appendLog() {} }, rebuildDerivedData: () => repo.rebuildDerivedData(), expansionBatches: new Map(), pendingSuggestions: new Map(), releaseOutline() {}, setOutlineActive() {}, detailsShown: () => false,
    mutate: work => (pending = Promise.resolve().then(work))
  });
  const view = new VisualAgentMapView({ app }, plugin);
  view.path = MAP; view.map = await repo.readMap(MAP); view.contentEl = dom.element('div'); view.stageEl = dom.element('div');
  let fits = 0;
  view.focusNode = () => {}; view.openDetails = () => {}; view.render = () => {}; view.fit = () => { fits++; };
  view.hydrate = async () => { view.notes = new Map(await Promise.all(view.map.nodes.map(async n => [n.id, await repo.readNote(n.path)]))); };
  await view.hydrate();
  view.cardHeightOf = () => 180;
  const named = title => view.map.nodes.find(n => view.notes.get(n.id)?.title === title);
  const menuTitles = () => menus.at(-1).items.map(item => (item.separator ? '---' : item.title));
  const choose = async title => { view.openLayoutMenu({}); menus.at(-1).items.find(item => item.title === title).click(); await pending; await pending; };
  return { repo, view, named, menus, menuTitles, choose, settled: () => pending, fits: () => fits, saved: () => repo.readMap(MAP), createSvg };
}

// The A1 fixture of scripts/perf-baseline.mjs (perfFixtureCards): root + 5 branches + 34 leaves, hand-placed. `turn` mirrors it for other directions.
const cards = (turn = ([x, y]) => [x, y]) => {
  const out = [['perf-root', null, ...turn([0, 0])]];
  [7, 7, 7, 7, 6].forEach((count, b) => {
    const branchY = (b - 2) * 680;
    out.push([`perf-b${b}`, 'perf-root', ...turn([380, branchY])]);
    for (let j = 0; j < count; j++) out.push([`perf-b${b}-l${j}`, `perf-b${b}`, ...turn([760, branchY + (j - 3) * 96])]);
  });
  return out;
};
const TURNS = {
  right: [{}, p => p],
  left: [{ layout: { direction: 'left' } }, ([x, y]) => [-x, y]],
  balanced: [{ layout: { direction: 'balanced' } }, ([x, y], i) => (i % 2 ? [-x, y] : [x, y])],
  down: [{ layout: { direction: 'down' } }, ([x, y]) => [Math.round(y * 3.4), x]]
};
async function fixtureHarness(dir) {
  const [extra, turn] = TURNS[dir];
  let n = 0;
  const spec = cards(([x, y]) => turn([x, y], 0));
  // Balanced: branches b1, b3 on the left; their leaves follow.
  const side = id => (/^perf-b[13]/.test(id) ? 1 : 0);
  const placed = dir === 'balanced' ? cards(p => p).map(([id, parent, x, y]) => [id, parent, side(id) ? -x : x, y]) : spec;
  const h = await harness(placed.map(([id, parent, x, y]) => [id, parent, x, y]), extra);
  void n;
  h.id = id => h.named(id).id;
  return h;
}
const chatApply = (h, actions) => {
  h.view.plugin.views ??= () => [h.view];
  return h.view.applyMapChatActions({ actions, rejected: [] }, { mdHashes: {}, topicHashes: {} }, () => true);
};
const snapshot = h => new Map(h.view.map.nodes.map(n => [n.id, [n.x, n.y]]));
const descendants = (nodes, id) => {
  const out = new Set([id]);
  for (let grew = true; grew;) { grew = false; for (const n of nodes) if (n.parentId && out.has(n.parentId) && !out.has(n.id)) { out.add(n.id); grew = true; } }
  return out;
};
// The cards that may legitimately move: the parent's subtree and the subtrees of its later siblings.
const affectedBy = (h, titleOfParent) => {
  const nodes = h.view.map.nodes, parent = h.named(titleOfParent);
  const at = nodes.findIndex(n => n.id === parent.id);
  const out = new Set();
  for (const id of [parent.id, ...nodes.filter((n, i) => n.parentId === parent.parentId && i > at).map(n => n.id)]) for (const d of descendants(nodes, id)) out.add(d);
  return out;
};
const assertStill = (before, h, allowed, label) => {
  for (const [id, point] of before) if (!allowed.has(id)) assert.deepEqual([h.view.map.nodes.find(n => n.id === id).x, h.view.map.nodes.find(n => n.id === id).y], point, `${label}: ${id} must not move`);
};
const DIRS = ['right', 'left', 'balanced', 'down'];
const overlapPairs = h => {
  const shown = h.view.map.nodes.filter(n => !n.collapsed), out = [];
  const box = n => ({ l: n.x, r: n.x + (n.width ?? 280), t: n.y, b: n.y + h.view.cardHeightOf(n.id) });
  for (let i = 0; i < shown.length; i++) for (let j = i + 1; j < shown.length; j++) {
    const a = box(shown[i]), b = box(shown[j]);
    if (a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b) out.push([shown[i].id, shown[j].id]);
  }
  return out;
};
const countWholeMap = h => { const count = { n: 0 }; const original = h.view.arrangeAll.bind(h.view); h.view.arrangeAll = (...args) => { count.n++; return original(...args); }; return count; };
const movedAtMost = (h, id, before, limit, label) => { const n = h.view.map.nodes.find(m => m.id === id), p = before.get(id); assert.ok(Math.max(Math.abs(n.x - p[0]), Math.abs(n.y - p[1])) <= limit, label); };

for (const dir of DIRS) {
  test(`A9 fix (${dir}): five new cards under a middle branch move only that branch and its later siblings, never the root`, async () => {
    const h = await fixtureHarness(dir);
    assert.equal(h.view.map.nodes.length, 40);
    const before = snapshot(h);
    const allowed = affectedBy(h, 'perf-b2');
    await chatApply(h, [0, 1, 2, 3, 4].map(i => ({ kind: 'add_child', parentId: h.id('perf-b2'), title: `child ${i}` })));
    assert.equal(h.view.map.nodes.length, 45);
    assert.deepEqual([h.named('perf-root').x, h.named('perf-root').y], before.get(h.id('perf-root')), 'root stays');
    assertStill(before, h, allowed, 'add 5');
    movedAtMost(h, h.id('perf-b2'), before, 180, 'the selected card moves at most one card height');
  });

  test(`A9 fix (${dir}): a batch of ten under another branch leaves the rest in place`, async () => {
    const h = await fixtureHarness(dir);
    const before = snapshot(h);
    const allowed = affectedBy(h, 'perf-b1');
    await chatApply(h, Array.from({ length: 10 }, (_, i) => ({ kind: 'add_child', parentId: h.id('perf-b1'), title: `batch ${i}` })));
    assert.equal(h.view.map.nodes.length, 50);
    assertStill(before, h, allowed, 'batch 10');
    movedAtMost(h, h.id('perf-b1'), before, 180, 'the selected card moves at most one card height');
  });

  test(`A9 fix (${dir}): folding moves nothing; unfolding moves only the unfolded branch's later siblings; the folded card stays within a card height`, async () => {
    const h = await fixtureHarness(dir);
    const before = snapshot(h);
    const card = h.named('perf-b2');
    const at = [card.x, card.y];
    h.view.toggleCollapsed(card);
    await h.settled(); await h.settled();
    assert.equal(h.named('perf-b2').collapsed, true);
    assertStill(before, h, new Set(), 'fold');
    h.view.toggleCollapsed(h.named('perf-b2'));
    await h.settled(); await h.settled();
    assert.equal(h.named('perf-b2').collapsed, false);
    assertStill(before, h, affectedBy(h, 'perf-b2'), 'unfold');
    const now = h.named('perf-b2');
    assert.ok(Math.max(Math.abs(now.x - at[0]), Math.abs(now.y - at[1])) <= 180, 'the selected card moves at most one card height');
  });

  test(`A9 fix (${dir}): a card that grew pushes only what it covers and its later siblings, not the whole map`, async () => {
    const h = await fixtureHarness(dir);
    const grown = h.id('perf-b2-l3');
    h.view.cardHeightOf = id => (id === grown ? 400 : 60);
    h.view.cardHeightOf = h.view.cardHeightOf.bind(h.view);
    const before = snapshot(h);
    const nodes = h.view.map.nodes;
    const allowed = new Set();
    const leaf = nodes.find(n => n.id === grown);
    nodes.filter((n, i) => n.parentId === leaf.parentId && i >= nodes.indexOf(leaf)).forEach(n => descendants(nodes, n.id).forEach(d => allowed.add(d)));
    for (const n of nodes) if (n.parentId === 'perf-root' || n.id === h.id('perf-root')) { /* later top-level branches may be pushed on */ }
    for (const n of nodes.filter((m, i) => m.parentId === h.id('perf-root') && i > nodes.findIndex(k => k.id === h.id('perf-b2')))) descendants(nodes, n.id).forEach(d => allowed.add(d));
    h.view.tidyAfterResize(h.view.map, new Set([grown]));
    assert.deepEqual([h.named('perf-root').x, h.named('perf-root').y], before.get(h.id('perf-root')), 'root stays');
    assertStill(before, h, allowed, 'grown card');
  });
}

const growLater = (h, grownIds) => {
  const nodes = h.view.map.nodes, allowed = new Set();
  const top = h.id('perf-root');
  for (const id of grownIds) {
    const leaf = nodes.find(n => n.id === id);
    nodes.filter((n, i) => n.parentId === leaf.parentId && i >= nodes.indexOf(leaf)).forEach(n => descendants(nodes, n.id).forEach(d => allowed.add(d)));
  }
  const b2 = nodes.findIndex(k => k.id === h.id('perf-b2'));
  for (const n of nodes.filter((m, i) => m.parentId === top && i > b2)) descendants(nodes, n.id).forEach(d => allowed.add(d));
  return allowed;
};
for (const dir of DIRS) {
  test(`A9 fix (${dir}): two neighbouring cards that grow together push the later ones apart, no whole-map layout, no overlap`, async () => {
    const h = await fixtureHarness(dir);
    const grown = [h.id('perf-b2-l2'), h.id('perf-b2-l3')];
    h.view.cardHeightOf = id => (grown.includes(id) ? 400 : 60);
    const before = snapshot(h), whole = countWholeMap(h);
    const allowed = growLater(h, grown);
    h.view.tidyAfterResize(h.view.map, new Set(grown));
    assert.equal(whole.n, 0, 'no whole-map layout');
    assertStill(before, h, allowed, 'two grown');
    assert.deepEqual(overlapPairs(h), [], 'no two cards overlap');
  });
  test(`A9 fix (${dir}): five new cards all measured taller than estimated stay local and do not overlap`, async () => {
    const h = await fixtureHarness(dir);
    const before = snapshot(h), allowed = affectedBy(h, 'perf-b2');
    await chatApply(h, [0, 1, 2, 3, 4].map(i => ({ kind: 'add_child', parentId: h.id('perf-b2'), title: `tall ${i}` })));
    const fresh = new Set(h.view.map.nodes.filter(n => !before.has(n.id)).map(n => n.id));
    assert.equal(fresh.size, 5);
    h.view.cardHeightOf = id => (fresh.has(id) ? 300 : 60);
    const whole = countWholeMap(h);
    h.view.tidyAfterResize(h.view.map, fresh);
    assert.equal(whole.n, 0, 'no whole-map layout');
    assertStill(before, h, allowed, 'taller batch');
    assert.deepEqual(overlapPairs(h), [], 'no two cards overlap');
    movedAtMost(h, h.id('perf-b2'), before, 180, 'the selected card moves at most one card height');
  });
}

test('A9 fix (up): five new cards under a middle branch move only that branch and its later siblings, never the root', async () => {
  const [extra] = [{ layout: { direction: 'up' } }];
  const spec = cards(([x, y]) => [Math.round(y * 3.4), -x]);
  const h = await harness(spec, extra); h.id = id => h.named(id).id;
  const before = snapshot(h), allowed = affectedBy(h, 'perf-b2');
  await chatApply(h, [0, 1, 2, 3, 4].map(i => ({ kind: 'add_child', parentId: h.id('perf-b2'), title: `child ${i}` })));
  assert.equal(h.view.map.nodes.length, 45);
  assert.deepEqual([h.named('perf-root').x, h.named('perf-root').y], before.get(h.id('perf-root')), 'root stays');
  assertStill(before, h, allowed, 'up add 5');
  movedAtMost(h, h.id('perf-b2'), before, 180, 'the selected card moves at most one card height');
});

test('A9 fix (down): a parent that grew over its own children pushes their row on instead of laying the whole map out', async () => {
  const h = await harness([['r', null, 0, 0], ['p1', 'r', 0, 300], ['c1', 'p1', 0, 600], ['c2', 'p1', 400, 600], ['q', 'r', 800, 300], ['d', 'q', 800, 600]], { layout: { direction: 'down' } });
  h.id = id => h.named(id).id;
  h.view.cardHeightOf = id => (id === h.id('p1') ? 400 : 60);
  const before = snapshot(h), whole = countWholeMap(h);
  h.view.tidyAfterResize(h.view.map, new Set([h.id('p1')]));
  assert.equal(whole.n, 0, 'no whole-map layout');
  assertStill(before, h, new Set([h.id('c1'), h.id('c2')]), 'grown parent');
  assert.ok(h.named('c1').y >= 700, 'the children are below the grown parent');
  assert.deepEqual(overlapPairs(h), [], 'no two cards overlap');
});

test('A9 fix: the push keeps the spacing of the map (compact 12, spacious 48)', async () => {
  for (const [spacing, gap] of [['compact', 12], ['spacious', 48]]) {
    const h = await harness([['r', null, 0, 0], ['a', 'r', 380, 0], ['b', 'r', 380, 70]], { layout: { direction: 'right', spacing } });
    h.id = id => h.named(id).id;
    h.view.cardHeightOf = id => (id === h.id('a') ? 200 : 60);
    h.view.tidyAfterResize(h.view.map, new Set([h.id('a')]));
    assert.equal(h.named('b').y, 200 + gap, `${spacing}: the later card sits one gap below`);
  }
});
