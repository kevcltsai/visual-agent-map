// Layout direction: the "right" layout is pinned by golden coordinates taken before directions existed (G0). No UI, no AI.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./support-replay.cjs');
const layout = load('map-layout.ts');

const node = (id, parentId = null, extra = {}) => ({ id, parentId, path: `${id}.md`, x: 0, y: 0, collapsed: false, ...extra });
const snap = list => list.map(item => [item.id, item.x, item.y]);
const sample = () => JSON.parse(/```agent-map\s*\n([\s\S]*?)\n```/.exec(require('node:fs').readFileSync(require('node:path').join(__dirname, 'fixtures/taiwan-travel-regression/Map.md'), 'utf8'))[1]).nodes.map(item => ({ ...item }));
const sampleHeight = id => 60 + (id.length % 5) * 37;
const folded = () => [
  node('root'),
  node('big', 'root', { collapsed: true }),
  ...Array.from({ length: 6 }, (_, index) => node(`hidden-${index}`, 'big', { x: 999, y: index })),
  node('next', 'root')
];
const aim = (id, parentId, aimKind, converges) => node(id, parentId, { aimKind, ...(converges ? { aimConvergesFromNodeIds: converges } : {}) });
const converging = () => [
  aim('topic', null, 'topic'), aim('Q', 'topic', 'question'),
  aim('R1', 'Q', 'research'), aim('R2', 'Q', 'research'), aim('R3', 'Q', 'research'),
  aim('C', 'R3', 'conclusion', ['R1', 'R2', 'R3']), aim('Q2', 'C', 'question'),
  ...[1, 2, 3, 4].map(i => aim(`S${i}`, 'Q2', 'research')),
  aim('C2', 'S4', 'conclusion', ['S1', 'S2', 'S3', 'S4'])
];
const sized = () => [node('r'), node('a', 'r'), node('b', 'r'), node('c', 'r'), node('a1', 'a'), node('a2', 'a')];
const sizedHeight = id => ({ r: 70, a: 300, b: 60, c: 120, a1: 90 })[id];
const branchBase = () => [
  node('root', null, { x: 80, y: 80 }),
  node('old', 'root', { x: 440, y: 0 }),
  node('old2', 'root', { x: 440, y: 260 }),
  node('fresh', 'root'), node('fresh2', 'root'), node('fresh-kid', 'fresh')
];

/** Every case runs the three arrange functions on fixed inputs; `direction` is appended only when given. */
const cases = direction => {
  const extra = direction ? [direction] : [];
  return {
    sampleFull: snap(layout.arrangeMap(sample(), undefined, undefined, ...extra)),
    sampleHeights: snap(layout.arrangeMap(sample(), undefined, sampleHeight, ...extra)),
    sampleBranch: snap(layout.arrangeNewBranch(sample(), 'explore', new Set(['transport', 'rail-car']), undefined, undefined, ...extra)),
    sampleBranchHeights: snap(layout.arrangeNewBranch(sample(), 'constraints', new Set(['budget', 'companions']), sampleHeight, 100, ...extra)),
    sampleTree: snap(layout.arrangeNewTree(sample(), 'journey', new Set(['journey', 'next']), undefined, ...extra)),
    sampleTreeHeights: snap(layout.arrangeNewTree(sample(), 'journey', new Set(['journey', 'next']), sampleHeight, ...extra)),
    foldedFull: snap(layout.arrangeMap(folded(), undefined, undefined, ...extra)),
    foldedHidden: snap(layout.arrangeMap(folded(), new Set(['next']), undefined, ...extra)),
    convergingFull: snap(layout.arrangeMap(converging(), undefined, undefined, ...extra)),
    convergingFolded: snap(layout.arrangeMap(converging().map(item => ({ ...item, x: 900, y: 5, collapsed: item.id === 'R3' })), undefined, undefined, ...extra)),
    sizedFull: snap(layout.arrangeMap(sized(), undefined, sizedHeight, ...extra)),
    branchCollide: snap(layout.arrangeNewBranch(branchBase(), 'root', new Set(['fresh', 'fresh2', 'fresh-kid']), undefined, undefined, ...extra)),
    branchCollideHeights: snap(layout.arrangeNewBranch(branchBase(), 'root', new Set(['fresh', 'fresh2', 'fresh-kid']), sizedHeight, undefined, ...extra))
  };
};

const GOLDEN = {
  sampleFull: [['explore', 80, 641], ['constraints', 440, 182], ['budget', 800, 80], ['companions', 800, 284], ['transport', 440, 488], ['rail-car', 800, 488], ['food', 440, 692], ['nature', 440, 896], ['weather', 800, 896], ['lodging', 440, 1100], ['journey', 80, 1304], ['next', 440, 1304]],
  sampleHeights: [['explore', 80, 509.875], ['constraints', 440, 131.25], ['budget', 800, 80], ['companions', 800, 201], ['transport', 440, 285], ['rail-car', 800, 303.5], ['food', 440, 517], ['nature', 440, 767.5], ['weather', 800, 749], ['lodging', 440, 907], ['journey', 80, 1102], ['next', 440, 1065]],
  // A9：P1.4 新規則，中段插入推開後續兄弟（sampleBranch: transport/rail-car 1204→374，food 500→670，nature/weather 750→920，lodging 1000→1170）
  sampleBranch: [['explore', 20, 300], ['constraints', 350, 0], ['budget', 690, 0], ['companions', 690, 170], ['transport', 380, 374], ['rail-car', 740, 374], ['food', 350, 670], ['nature', 350, 920], ['weather', 690, 920], ['lodging', 350, 1170], ['journey', 1050, 350], ['next', 1390, 500]],
  sampleBranchHeights: [['explore', 20, 300], ['constraints', 350, 0], ['budget', 710, 100], ['companions', 710, 221], ['transport', 350, 250], ['rail-car', 690, 340], ['food', 350, 500], ['nature', 350, 750], ['weather', 690, 750], ['lodging', 350, 1000], ['journey', 1050, 350], ['next', 1390, 500]],
  sampleTree: [['explore', 20, 300], ['constraints', 350, 0], ['budget', 690, 0], ['companions', 690, 170], ['transport', 350, 250], ['rail-car', 690, 340], ['food', 350, 500], ['nature', 350, 750], ['weather', 690, 750], ['lodging', 350, 1000], ['journey', 20, 1204], ['next', 380, 1204]],
  sampleTreeHeights: [['explore', 20, 300], ['constraints', 350, 0], ['budget', 690, 0], ['companions', 690, 170], ['transport', 350, 250], ['rail-car', 690, 340], ['food', 350, 500], ['nature', 350, 750], ['weather', 690, 750], ['lodging', 350, 1000], ['journey', 20, 1195], ['next', 380, 1158]],
  foldedFull: [['root', 80, 182], ['big', 440, 80], ['hidden-0', 999, 0], ['hidden-1', 999, 1], ['hidden-2', 999, 2], ['hidden-3', 999, 3], ['hidden-4', 999, 4], ['hidden-5', 999, 5], ['next', 440, 284]],
  foldedHidden: [['root', 80, 80], ['big', 440, 80], ['hidden-0', 999, 0], ['hidden-1', 999, 1], ['hidden-2', 999, 2], ['hidden-3', 999, 3], ['hidden-4', 999, 4], ['hidden-5', 999, 5], ['next', 0, 0]],
  convergingFull: [['topic', 80, 386], ['Q', 440, 386], ['R1', 800, 182], ['R2', 800, 386], ['R3', 800, 590], ['C', 1160, 386], ['Q2', 1520, 386], ['S1', 1880, 80], ['S2', 1880, 284], ['S3', 1880, 488], ['S4', 1880, 692], ['C2', 2240, 386]],
  convergingFolded: [['topic', 80, 284], ['Q', 440, 284], ['R1', 800, 80], ['R2', 800, 284], ['R3', 800, 488], ['C', 900, 5], ['Q2', 900, 5], ['S1', 900, 5], ['S2', 900, 5], ['S3', 900, 5], ['S4', 900, 5], ['C2', 900, 5]],
  sizedFull: [['r', 80, 342.75], ['a', 440, 57.5], ['b', 440, 404], ['c', 440, 488], ['a1', 800, 83], ['a2', 800, 197]],
  branchCollide: [['root', 80, 80], ['old', 440, 0], ['old2', 440, 260], ['fresh', 440, 464], ['fresh2', 440, 668], ['fresh-kid', 800, 464]],
  branchCollideHeights: [['root', 80, 80], ['old', 440, 0], ['old2', 440, 260], ['fresh', 440, 464], ['fresh2', 440, 668], ['fresh-kid', 800, 464]]
};

test('G0: the right layout keeps the exact coordinates it had before directions existed', () => {
  assert.deepEqual(cases(), GOLDEN);
});

test('G0: passing "right" gives the same coordinates as passing no direction', () => {
  assert.deepEqual(cases('right'), cases());
});

const L = 'left';
const at = (list, id) => list.find(item => item.id === id);
const depthOf = (list, id) => { let depth = 0; for (let item = at(list, id); item.parentId; item = at(list, item.parentId)) depth++; return depth; };
const rootOf = (list, id) => { let item = at(list, id); while (item.parentId) item = at(list, item.parentId); return item; };

test('L1: the left layout keeps each root column and puts every depth one column further left, with the right layout\'s y', () => {
  for (const [nodes, heightOf] of [[sample(), undefined], [sample(), sampleHeight], [sized(), sizedHeight]]) {
    const right = layout.arrangeMap(nodes, undefined, heightOf);
    const left = layout.arrangeMap(nodes, undefined, heightOf, L);
    for (const item of left) {
      const root = rootOf(right, item.id);
      assert.equal(item.x, root.x - depthOf(nodes, item.id) * 360, `${item.id} x`);
      assert.equal(item.y, at(right, item.id).y, `${item.id} y`);
    }
  }
});

test('L1: a convergence node sits one column left of its sources in the left layout', () => {
  const left = layout.arrangeMap(converging(), undefined, undefined, L);
  const right = layout.arrangeMap(converging());
  for (const item of left) {
    assert.equal(item.y, at(right, item.id).y, `${item.id} y`);
    assert.equal(item.x, 2 * 80 - at(right, item.id).x, `${item.id} mirrors around the root column`);
  }
  assert.equal(at(left, 'C').x, at(left, 'R1').x - 360);
});

const overlaps = (list, heightOf = () => undefined) => {
  const h = id => heightOf(id) ?? layout.DEFAULT_CARD_HEIGHT;
  const found = [];
  for (const a of list) for (const b of list)
    if (a.id < b.id && Math.abs(a.x - b.x) < 300 && a.y < b.y + h(b.id) && b.y < a.y + h(a.id)) found.push(`${a.id}/${b.id}`);
  return found;
};

test('L2: no two cards overlap in the left layout', () => {
  const placed = layout.arrangeMap(sample(), undefined, undefined, L);
  assert.ok(at(placed, 'budget').x < at(placed, 'constraints').x && at(placed, 'constraints').x < at(placed, 'explore').x, 'laid out to the left');
  assert.deepEqual(overlaps(layout.arrangeMap(sample(), undefined, undefined, L)), []);
  assert.deepEqual(overlaps(layout.arrangeMap(sample(), undefined, sampleHeight, L), sampleHeight), []);
  assert.deepEqual(overlaps(layout.arrangeMap(converging(), undefined, undefined, L)), []);
  assert.deepEqual(overlaps(layout.arrangeMap(sized(), undefined, sizedHeight, L), sizedHeight), []);
});

test('L3: a hidden or folded branch keeps its coordinates in the left layout', () => {
  const left = layout.arrangeMap(folded(), undefined, undefined, L);
  for (let index = 0; index < 6; index++) assert.deepEqual([at(left, `hidden-${index}`).x, at(left, `hidden-${index}`).y], [999, index]);
  assert.equal(at(left, 'big').x, at(left, 'root').x - 360);
  const hidden = layout.arrangeMap(sample().map(item => (item.id === 'food' ? { ...item, x: 777, y: 999 } : item)), new Set(['food']), undefined, L);
  assert.deepEqual([at(hidden, 'food').x, at(hidden, 'food').y], [777, 999]);
});

test('L4: a new branch in the left layout starts one column left of its parent and moves down past a collision', () => {
  const base = [
    node('root', null, { x: 800, y: 80 }),
    node('old', 'root', { x: 440, y: 0 }),
    node('old2', 'root', { x: 440, y: 260 }),
    node('fresh', 'root'), node('fresh2', 'root'), node('fresh-kid', 'fresh')
  ];
  const placed = layout.arrangeNewBranch(base, 'root', new Set(['fresh', 'fresh2', 'fresh-kid']), undefined, undefined, L);
  assert.equal(at(placed, 'fresh').x, 800 - 360);
  assert.equal(at(placed, 'fresh2').x, 800 - 360);
  assert.equal(at(placed, 'fresh-kid').x, 800 - 720);
  assert.deepEqual(snap(placed.slice(0, 3)), snap(base.slice(0, 3)), 'existing cards never move');
  assert.ok(at(placed, 'fresh').y >= 260 + layout.DEFAULT_CARD_HEIGHT + layout.LAYOUT_GAP, 'the new branch clears the old cards');
  assert.deepEqual(overlaps(placed), []);
});

test('L5: a new tree in the left layout goes below every card, its children to the left', () => {
  const existing = [node('root', null, { x: 900, y: 80 }), node('a', 'root', { x: 540, y: -100 }), node('b', 'root', { x: 540, y: 520 })];
  const fresh = [node('n'), node('n1', 'n'), node('n2', 'n'), node('n11', 'n1')];
  const placed = layout.arrangeNewTree([...existing, ...fresh], 'n', new Set(fresh.map(item => item.id)), undefined, L);
  assert.deepEqual(snap(placed.slice(0, 3)), snap(existing));
  for (const item of placed.slice(3)) assert.ok(item.y >= 520 + layout.DEFAULT_CARD_HEIGHT + layout.LAYOUT_GAP, `${item.id} below`);
  assert.equal(at(placed, 'n').x, 900, 'the root column stays the leftmost root column');
  assert.equal(at(placed, 'n1').x, 900 - 360);
  assert.equal(at(placed, 'n11').x, 900 - 720);
});

const core = load('map-model.ts');
const doc = extra => ({ version: 1, id: 'm', title: 'M', nodes: [node('a')], viewport: { x: 0, y: 0, zoom: 1 }, ...extra });

test('L6: parseMap keeps a valid layout through a round trip and drops an invalid one', () => {
  const kept = core.parseMap(core.serializeMap(doc({ layout: { direction: 'left' } })));
  assert.deepEqual(JSON.parse(JSON.stringify(kept.layout)), { direction: 'left' });
  for (const value of ['left', { direction: 'sideways' }, {}, 3, null, [], { direction: 5 }]) {
    const parsed = core.parseMap(core.serializeMap(doc({ layout: value })));
    assert.equal('layout' in parsed, false, JSON.stringify(value));
  }
  const plainDoc = doc();
  const text = core.serializeMap(plainDoc);
  assert.equal(core.serializeMap(core.parseMap(text)), text, 'a map without layout serializes to the same text');
  assert.equal('layout' in core.parseMap(text), false);
});

test('L7: layoutOf reads the map, and AIM maps or missing fields are always right', () => {
  for (const value of [{}, null, undefined, { layout: { direction: 'left' }, aim: { version: 1 } }])
    assert.equal(layout.layoutOf(value).direction, 'right');
  for (const direction of ['left', 'right', 'down', 'up'])
    assert.equal(layout.layoutOf({ layout: { direction } }).direction, direction);
});

const geometry = load('experiences/visual-map/relation-geometry.ts');
const viewerEdge = load('experiences/sharing/viewer/edge-path.ts');
const boxes = [
  [{ x: 80, y: 80, width: 300, height: 180 }, { x: 440, y: 0, width: 300, height: 180 }],
  [{ x: 0, y: 500, width: 300, height: 92 }, { x: 360, y: 20, width: 300, height: 260 }],
  [{ x: 100, y: 100, width: 280, height: 60 }, { x: 140, y: 400, width: 300, height: 100 }],
  [{ x: -720, y: 33.5, width: 300, height: 121 }, { x: -1080, y: 57.25, width: 300, height: 77 }]
];

test('L8: treeEdgePathData right is exactly the plugin edge curve; left goes from the parent\'s left edge to the child\'s right edge', () => {
  for (const [parent, child] of boxes)
    assert.equal(
      geometry.treeEdgePathData(parent, child, 'right'),
      viewerEdge.edgePathData(parent.x + parent.width, parent.y + parent.height / 2, child.x, child.y + child.height / 2)
    );
  const parent = { x: 800, y: 100, width: 300, height: 180 }, child = { x: 440, y: 0, width: 300, height: 100 };
  assert.equal(geometry.treeEdgePathData(parent, child, 'left'), 'M 800 190 C 770 190, 770 50, 740 50');
  const far = { x: 0, y: 0, width: 300, height: 100 };
  assert.equal(geometry.treeEdgePathData(parent, far, 'left'), 'M 800 190 C 550 190, 550 50, 300 50', 'arms are half the distance when it is wide');
});

const ctrl = path => { const n = path.match(/-?\d+(?:\.\d+)?/g).map(Number); return { c1: [n[2], n[3]], c2: [n[4], n[5]] }; };
const armOf = (x1, x2) => { const { c1, c2 } = ctrl(viewerEdge.edgePathData(x1, 0, x2, 100)); return c1[0] - x1 + 0 * c2[0]; };

test('L8b: with the standard ~72px gap the two control points do not cross, so sibling curves do not bundle', () => {
  const parent = { x: 66, y: 0, width: 400, height: 96 };
  for (const mid of [48, 167, 322, 472, 572]) {
    const child = { x: 538, y: mid - 40, width: 300, height: 80 };
    const right = ctrl(geometry.treeEdgePathData(parent, child, 'right'));
    assert.ok(right.c1[0] <= right.c2[0], `right to y=${mid}: c1x ${right.c1[0]} <= c2x ${right.c2[0]}`);
    const edge = ctrl(viewerEdge.edgePathData(466, 48, 538, mid));
    assert.ok(edge.c1[0] <= edge.c2[0], `edgePathData to y=${mid}`);
  }
  const p = { x: 1000, y: 0, width: 400, height: 96 }, c = { x: 528, y: 300, width: 400, height: 80 };
  const left = ctrl(geometry.treeEdgePathData(p, c, 'left'));
  assert.ok(left.c1[0] >= left.c2[0], `left: c1x ${left.c1[0]} >= c2x ${left.c2[0]}`);
  const dp = { x: 0, y: 0, width: 300, height: 100 };
  const down = ctrl(geometry.treeEdgePathData(dp, { x: 500, y: 172, width: 300, height: 80 }, 'down'));
  assert.ok(down.c1[1] <= down.c2[1], `down: c1y ${down.c1[1]} <= c2y ${down.c2[1]}`);
  const up = ctrl(geometry.treeEdgePathData({ ...dp, y: 300 }, { x: 500, y: 148, width: 300, height: 80 }, 'up'));
  assert.ok(up.c1[1] >= up.c2[1], `up: c1y ${up.c1[1]} >= c2y ${up.c2[1]}`);
});

test('L8c: the arm is continuous at run 40, 60 at run 0, and unchanged for a child behind its parent', () => {
  assert.ok(Math.abs(armOf(0, 39.9) - armOf(0, 40)) < 0.2);
  assert.equal(armOf(0, 0), 60);
  assert.equal(armOf(0, 40), 20);
  assert.equal(armOf(0, 120), 60);
  assert.equal(armOf(0, -300), 150);
});

// ---- P2: the view. A real view over a fake vault, as in tests/steps-layout-history.cjs. ----
const support = require('./support.cjs');
const dom = require('./support-dom.cjs');
const MAP = 'Agent Workspace/Topics/map-d/Map.md';
const RIGHT_TITLE = 'Lay out to the right', LEFT_TITLE = 'Lay out to the left';

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
// A card-sized DOM stand-in (as in tests/steps-map-keyboard.cjs): one handler per event name, writable text.
const stub = (tag, init = {}) => ({ tag, children: [], dataset: {}, style: {}, attrs: {}, handlers: new Map(), classes: new Set(String(init.cls ?? '').split(' ').filter(Boolean)), text: init.text, tabIndex: init.tabIndex, checked: false, isConnected: true,
  createDiv(value) { return this.createEl('div', typeof value === 'string' ? { cls: value } : value); },
  createSpan(value) { return this.createEl('span', typeof value === 'string' ? { cls: value } : value); },
  createEl(name, value = {}) { const child = stub(name, value); child.parent = this; this.children.push(child); return child; },
  setAttr(name, value) { this.attrs[name] = value; }, addClass(...names) { names.forEach(name => this.classes.add(name)); }, removeClass(name) { this.classes.delete(name); },
  toggleClass(name, on) { if (on) this.classes.add(name); else this.classes.delete(name); }, addEventListener(name, handler) { this.handlers.set(name, handler); }, removeEventListener() {},
  setPointerCapture() {}, focus() {}, remove() { this.removed = true; }, getBoundingClientRect() { return { left: 0, right: 10, top: 0, bottom: 10 }; },
  querySelector() { return null; }, querySelectorAll() { return []; }, replaceWith() {} });
const findAll = (root, predicate) => [...(predicate(root) ? [root] : []), ...root.children.flatMap(c => findAll(c, predicate))];
const tree4 = [['Root', null, 1000, 80], ['A', 'Root', 1360, 0], ['B', 'Root', 1360, 300], ['A1', 'A', 1720, 0]];
const LEFT_MAP = { layout: { direction: 'left' } };

test('V1: choosing Lay out to the left writes the field and the left layout in one undo step; right deletes the field', async () => {
  const h = await harness(tree4);
  const positions = () => JSON.stringify(h.view.map.nodes.map(n => [n.id, n.x, n.y]));
  const before = positions();
  h.view.openLayoutMenu({});
  const items = h.menus.at(-1).items;
  assert.equal(items.find(item => item.title === RIGHT_TITLE).checked, true, 'right is checked on an old map');
  assert.equal(items.find(item => item.title === LEFT_TITLE).checked, false);
  const writes = h.view.history.past.length;
  await h.choose(LEFT_TITLE);
  assert.equal(h.view.history.past.length, writes + 1, 'one history entry');
  assert.deepEqual(JSON.parse(JSON.stringify(h.view.map.layout)), { direction: 'left' });
  assert.deepEqual(JSON.parse(JSON.stringify((await h.saved()).layout)), { direction: 'left' }, 'stored in Map.md');
  const root = h.named('Root');
  assert.equal(h.named('A').x, root.x - 360); assert.equal(h.named('B').x, root.x - 360); assert.equal(h.named('A1').x, root.x - 720);
  assert.equal(h.fits(), 1, 'the map is fitted after the change');
  await h.view.travel(false);
  assert.equal('layout' in h.view.map, false, 'undo removes the field'); assert.equal(positions(), before, 'undo restores the coordinates');
  assert.equal('layout' in (await h.saved()), false);
  await h.view.travel(true);
  assert.deepEqual(JSON.parse(JSON.stringify(h.view.map.layout)), { direction: 'left' }, 'redo applies it again');
  h.view.openLayoutMenu({});
  assert.equal(h.menus.at(-1).items.find(item => item.title === LEFT_TITLE).checked, true, 'left is checked on a left map');
  await h.choose(RIGHT_TITLE);
  assert.equal('layout' in h.view.map, false, 'right deletes the field instead of writing it');
  assert.equal('layout' in (await h.saved()), false);
  assert.equal(h.named('A').x, h.named('Root').x + 360);
});

const edgeHost = () => ({ children: [], replaceChildren() { this.children = []; }, appendChild(child) { this.children.push(child); } });
const card = (x, y, width = 300, height = 180) => ({ offsetLeft: x, offsetTop: y, offsetWidth: width, offsetHeight: height });

test('V2: in a left map the parent line leaves the parent\'s left edge for the child\'s right edge; right maps keep the old curve', async () => {
  for (const [extra, expected] of [[LEFT_MAP, 'M 1000 170 C 820 170, 820 90, 640 90'], [{}, 'M 1300 170 C 1330 170, 1330 90, 1360 90']]) {
    const h = await harness(tree4.slice(0, 2), extra);
    const root = h.named('Root'), a = h.named('A');
    h.view.edgesEl = edgeHost(); h.view.relationsLayerEl = edgeHost();
    h.view.cardEls.set(root.id, card(1000, 80)); h.view.cardEls.set(a.id, card(extra.layout ? 340 : 1360, 0));
    h.view.drawEdges();
    const path = h.view.edgesEl.children[0];
    assert.equal(path.attrs.d, expected);
    if (extra.layout) {
      assert.ok(path.attrs.d.startsWith(`M ${h.view.cardEls.get(root.id).offsetLeft} `), 'starts at the parent\'s offsetLeft');
      const drag = h.view.dragEdges(root.id, { offsetWidth: 300, offsetHeight: 180 });
      drag.update(1100, 80);
      assert.equal(h.view.edgeEls.get(`${root.id}\u0000${a.id}`).attrs.d, 'M 1100 170 C 870 170, 870 90, 640 90', 'dragging the parent keeps the left geometry');
    }
  }
});

test('V3: in a left map ArrowLeft goes to the first child and ArrowRight to the parent', async () => {
  const h = await harness(tree4, LEFT_MAP);
  const root = h.named('Root'), a = h.named('A');
  assert.equal(h.view.keyboardNeighbor(root, 'ArrowLeft').id, a.id);
  assert.equal(h.view.keyboardNeighbor(a, 'ArrowRight').id, root.id);
  assert.equal(h.view.keyboardNeighbor(root, 'ArrowRight'), undefined);
  const right = await harness(tree4);
  assert.equal(right.view.keyboardNeighbor(right.named('Root'), 'ArrowRight').id, right.named('A').id, 'right maps keep their keys');
  assert.equal(right.view.keyboardNeighbor(right.named('A'), 'ArrowLeft').id, right.named('Root').id);
});

test('V4: in a left map new, moved and copied topics and a fold re-layout go to the left of their parent', async () => {
  const spec = [['Root', null, 1000, 80], ['Target', 'Root', 640, 0], ['Src', 'Root', 640, 400], ['Leaf', 'Src', 280, 400]];
  const h = await harness(spec, LEFT_MAP);
  await h.view.addNode(h.named('Root'), 'Added');
  assert.ok(h.named('Added').x < h.named('Root').x, 'addNode');
  h.view.mergeUnlocked = () => true;
  h.view.selection.replaceMulti([h.named('Src').id]);
  await h.view.copySelected(h.named('Target'));
  const copies = h.view.map.nodes.filter(n => n.parentId === h.named('Target').id);
  assert.equal(copies.length, 1);
  assert.ok(copies[0].x < h.named('Target').x, 'copySelected');
  h.view.selection.replaceMulti([h.named('Src').id]);
  await h.view.moveBranches(h.view.selectedRoots(), h.named('Target'));
  assert.ok(h.named('Src').x < h.named('Target').x && h.named('Leaf').x < h.named('Src').x, 'moveBranches');
  // The fold action is the card right-click menu's "Collapse subtopics" row (the card has no fold tool any more).
  const rows = [];
  const menu = { addItem(build) { const row = {}; const chain = { setTitle(v) { row.title = v; return chain; }, setIcon() { return chain; }, setDisabled() { return chain; }, setWarning() { return chain; }, setSubmenu: undefined, onClick(fn) { row.fn = fn; return chain; } }; build(chain); rows.push(row); return menu; }, addSeparator() { return menu; } };
  h.view.addCardMenuActions(menu, h.named('Target'));
  const fold = rows.find(row => row.title === 'Collapse subtopics');
  assert.ok(fold, 'the card menu has a Collapse subtopics row');
  fold.fn({ metaKey: false, ctrlKey: false }); await h.settled(); await h.settled();
  assert.equal(h.named('Target').collapsed, true);
  for (const child of h.view.map.nodes.filter(n => n.parentId === h.named('Root').id)) assert.ok(child.x < h.named('Root').x, `${child.id} after the fold`);
});

const DOWN_MAP = { layout: { direction: 'down' } };

test('V4d: in a down map moved and copied topics go below their parent, not to its right (layout-clipboard-final-merge-layoutOf)', async () => {
  const spec = [['Root', null, 1000, 80], ['Target', 'Root', 640, 0], ['Src', 'Root', 640, 400], ['Leaf', 'Src', 280, 400]];
  const h = await harness(spec, DOWN_MAP);
  h.view.mergeUnlocked = () => true;
  h.view.selection.replaceMulti([h.named('Src').id]);
  await h.view.copySelected(h.named('Target'));
  const copies = h.view.map.nodes.filter(n => n.parentId === h.named('Target').id);
  assert.equal(copies.length, 1);
  assert.ok(copies[0].y > h.named('Target').y, 'copySelected goes down');
  h.view.selection.replaceMulti([h.named('Src').id]);
  await h.view.moveBranches(h.view.selectedRoots(), h.named('Target'));
  assert.ok(h.named('Src').y > h.named('Target').y && h.named('Leaf').y > h.named('Src').y, 'moveBranches goes down');
});

test('V5: an AIM map offers no direction in the Layout menu', async () => {
  // A10: P1.4 "Tidy map" replaces the "Auto layout" menu item (same action), so the last title changed.
  const original = ['Collapse all', 'Expand all', 'Expand to level 1', 'Expand to level 2', 'Expand to level 3', '---', 'Tidy map'];
  const h = await harness(tree4);
  h.view.map.aim = { version: 1, branches: [], runs: [], pendingCommits: [] };
  h.view.openLayoutMenu({});
  assert.deepEqual(h.menuTitles(), original);
  h.view.map.aim = undefined;
  h.view.openLayoutMenu({});
  assert.deepEqual(h.menuTitles(), ['Collapse all', 'Expand all', 'Expand to level 1', 'Expand to level 2', 'Expand to level 3', '---', RIGHT_TITLE, LEFT_TITLE, 'Lay out downward', 'Lay out upward', 'Lay out balanced left and right', 'Lay out radially', 'Lay out as a timeline', 'Lay out as a fishbone', '---', 'Compact spacing', 'Standard spacing', 'Spacious spacing', 'Tidy map']);
});

// ---- P3: the map chat's new cards follow the map's direction. ----
const chatApply = (h, actions) => {
  h.view.plugin.views ??= () => [h.view];
  return h.view.applyMapChatActions({ actions, rejected: [] }, { mdHashes: {}, topicHashes: {} }, () => true);
};
const chatChildren = (h, parentId) => h.view.map.nodes.filter(n => n.parentId === parentId);

test('V6: in a left map the cards a map chat reply adds (and its auto_layout) go to the left of their parent; right maps are unchanged', async () => {
  for (const [extra, side] of [[LEFT_MAP, -1], [{}, 1]]) {
    const h = await harness(tree4.slice(0, 1), extra);
    const root = h.named('Root');
    // Five new cards at once get one layout for the lot.
    await chatApply(h, ['C1', 'C2', 'C3', 'C4', 'C5'].map(title => ({ kind: 'add_child', parentId: root.id, title })));
    const added = chatChildren(h, root.id);
    assert.equal(added.length, 5);
    for (const child of added) assert.equal(Math.sign(child.x - h.named('Root').x), side, `${child.id} after the batch layout`);
    // An auto_layout action of a reply lays the map out in its direction too.
    await chatApply(h, [{ kind: 'auto_layout' }]);
    for (const child of chatChildren(h, root.id)) assert.equal(child.x, h.named('Root').x + side * 360, `${child.id} after auto_layout`);
  }
});

// ---- Map trial bug 2: after a reply that made cards, the new branch's root is selected (a presentation starts at 1/N) ----
test('V7: a reply that made cards ends with the new branch root selected, also below the auto-layout threshold; the view keeps its frame (no Show all)', async () => {
  for (const count of [7, 2]) {
    const h = await harness(tree4.slice(0, 1));
    const kids = Array.from({ length: count - 1 }, (_, i) => ({ kind: 'add_child', ref: `k${i}`, parentId: 'new:r', title: `Kid${i}` }));
    await chatApply(h, [{ kind: 'add_child', ref: 'r', parentId: '', title: 'Branch' }, ...kids]);
    h.view.notes = new Map(await Promise.all(h.view.map.nodes.map(async n => [n.id, await h.repo.readNote(n.path)])));
    assert.equal(h.view.map.nodes.length, count + 1);
    assert.equal(h.view.selection.state.selected, h.named('Branch').id, `${count} new cards: the branch root, not the last card`);
    assert.equal(h.fits(), 0, `${count} new cards: the view is not re-framed (P2.4)`);
  }
});

test('V7: a reply with focus_topic still selects the branch root and does not move the view; a reply that made nothing keeps the selection', async () => {
  const h = await harness(tree4);
  h.view.selection.setSelected(h.named('B').id);
  await chatApply(h, [{ kind: 'focus_topic', nodeId: h.named('A').id }]);
  assert.equal(h.view.selection.state.selected, h.named('B').id, 'no created cards: selection untouched');
  const kids = Array.from({ length: 6 }, (_, i) => ({ kind: 'add_child', ref: `k${i}`, parentId: i ? 'new:k0' : h.named('Root').id, title: `Kid${i}` }));
  await chatApply(h, [...kids, { kind: 'focus_topic', nodeId: h.named('A').id }]);
  assert.equal(h.fits(), 0, 'focus_topic keeps the view where the reply put it');
  h.view.notes = new Map(await Promise.all(h.view.map.nodes.map(async n => [n.id, await h.repo.readNote(n.path)])));
  assert.equal(h.view.selection.state.selected, h.named('Kid0').id, 'the reply made cards, so its branch root (first card made) is selected');
});

test('V7: a reply that makes cards and also selects existing cards ends with those cards selected, not the branch root', async () => {
  const h = await harness(tree4);
  const picked = [h.named('A').id, h.named('B').id];
  await chatApply(h, [{ kind: 'add_child', ref: 'r', parentId: '', title: 'Branch' }, { kind: 'add_child', ref: 'k', parentId: 'new:r', title: 'Kid' }, { kind: 'select_topics', nodeIds: picked }]);
  assert.equal(h.view.map.nodes.some(n => n.path && /Branch/.test(n.path)), true, 'the cards were made');
  assert.equal(h.view.selection.state.selected, null, 'the requested selection wins over the branch root');
  assert.deepEqual([...h.view.selection.state.multiSelected].sort(), [...picked].sort());
});

test('V7: a manual add still selects the new card', async () => {
  const h = await harness(tree4);
  await h.view.addNode(h.named('Root'), 'Added');
  assert.equal(h.view.selection.state.selected, h.named('Added').id);
});

test('E2-x: a batch of AI cards neither pans the view nor changes the selection while it is made; a single manual add still selects the new card', async () => {
  const h = await harness(tree4);
  const picked = h.named('B').id;
  h.view.selection.setSelected(picked);
  h.view.map.viewport = { x: 194, y: 40, zoom: 1 };
  const seen = [];
  const select = h.view.selection.setSelected.bind(h.view.selection);
  h.view.selection.setSelected = id => { seen.push(id); return select(id); };
  const panFlags = [];
  const applySel = h.view.applySelectionChange.bind(h.view);
  h.view.applySelectionChange = change => { panFlags.push(h.view.keepCanvasOnSelect); return applySel(change); };
  const kids = Array.from({ length: 12 }, (_, i) => ({ kind: 'add_child', ref: `k${i}`, parentId: h.named('Root').id, title: `Kid${i}` }));
  await chatApply(h, kids);
  assert.equal(h.view.map.nodes.length, tree4.length + 12);
  assert.deepEqual({ ...h.view.map.viewport }, { x: 194, y: 40, zoom: 1 }, 'the view stays where it was');
  const created = new Set(h.view.map.nodes.filter(n => /^Kid/.test(h.view.notes.get(n.id)?.title ?? '')).map(n => n.id));
  assert.ok(panFlags.length && panFlags.every(Boolean), 'the reply selects its branch root with the tool-row pan switched off');
  assert.equal(seen.filter(id => created.has(id) && id !== seen.at(-1)).length, 0, 'no per-card selection of the new cards');
  const h2 = await harness(tree4);
  h2.view.selection.setSelected(h2.named('B').id);
  await h2.view.addNode(h2.named('Root'), 'Added');
  assert.equal(h2.view.selection.state.selected, h2.named('Added').id);
});


// ---- E2-y: a reply's batch of cards is one Map.md write ----
// Counts every write of Map.md (vault.process / modify / create over it) on the harness's fake vault.
const countMapWrites = h => {
  const vault = h.view.app.vault;
  const counter = { n: 0 };
  for (const name of ['process', 'modify', 'create']) {
    const original = vault[name]?.bind(vault);
    if (!original) continue;
    vault[name] = async (target, ...rest) => {
      if ((target?.path ?? target) === MAP && counter.refuse) throw new Error('disk refused the write');
      const result = await original(target, ...rest);
      if ((target?.path ?? target) === MAP) counter.n++;
      return result;
    };
  }
  return counter;
};
const kidsOf = (h, count) => Array.from({ length: count }, (_, i) => ({ kind: 'add_child', ref: `k${i}`, parentId: h.named('Root').id, title: `Kid${i}` }));
const mapJson = h => JSON.stringify({ ...h.view.map, viewport: null });

test('E2-y: a reply that adds 12 cards writes Map.md once, and Undo takes all 12 back in one step', async () => {
  const h = await harness(tree4);
  const writes = countMapWrites(h);
  const before = await h.saved();
  const steps = h.view.history.past.length;
  await chatApply(h, kidsOf(h, 12));
  assert.equal(h.view.map.nodes.length, tree4.length + 12);
  assert.equal((await h.saved()).nodes.length, tree4.length + 12, 'the cards are on disk');
  assert.equal(writes.n, 1, 'one write of Map.md for the whole batch');
  assert.equal(h.view.history.past.length, steps + 1, 'one undo step');
  await h.view.travel(false);
  assert.equal((await h.saved()).nodes.length, before.nodes.length, 'one undo removes the whole batch');
});

test('E2-y: a batch whose write is refused writes nothing: Map.md and the open map stay as they were', async () => {
  const h = await harness(tree4);
  const writes = countMapWrites(h);
  const before = mapJson(h);
  const diskBefore = JSON.stringify(await h.saved());
  // The write of the batch fails (the cards were laid out in memory): nothing is written and the map goes back.
  writes.refuse = true;
  const lines = await chatApply(h, kidsOf(h, 12));
  assert.equal(writes.n, 0);
  assert.equal(mapJson(h), before, 'the open map is as before');
  assert.equal(JSON.stringify(await h.saved()), diskBefore);
  assert.equal(lines.filter(line => line.status === 'failed').length, 12, 'every card of the batch is reported as not written');
});

test('E2-y: a card skipped by validation keeps its own line; the others are still written once', async () => {
  const h = await harness(tree4);
  const writes = countMapWrites(h);
  const actions = [...kidsOf(h, 6), { kind: 'add_child', ref: 'x', parentId: 'no-such-card', title: 'Orphan' }];
  const lines = await chatApply(h, actions);
  assert.equal(lines[6].status, 'skipped');
  assert.equal(h.view.map.nodes.length, tree4.length + 6);
  assert.equal(writes.n, 1);
});

test('E2-y: one card still writes Map.md once', async () => {
  const h = await harness(tree4);
  const writes = countMapWrites(h);
  await chatApply(h, kidsOf(h, 1));
  assert.equal(writes.n, 1);
  assert.equal(h.view.map.nodes.length, tree4.length + 1);
});

// Runs `during` right after the nth card note of a reply is made (the reply is mid-batch then).
const afterNthCard = (h, nth, during) => {
  const original = h.repo.createNote.bind(h.repo);
  let count = 0;
  h.repo.createNote = async (...args) => {
    const made = await original(...args);
    if (++count === nth) await during();
    return made;
  };
};

test('E2-y: 6 cards with summaries: one Undo takes all back (notes still there while summaries are undone), Redo brings them back in order', async () => {
  const h = await harness(tree4);
  const before = await h.saved();
  const acts = kidsOf(h, 6).map((a, i) => ({ ...a, summary: `S${i}` }));
  const lines = await chatApply(h, acts);
  assert.equal(lines.filter(line => line.status === 'failed').length, 0);
  assert.equal((await h.saved()).nodes.length, before.nodes.length + 6);
  await h.view.travel(false);
  assert.equal((await h.saved()).nodes.length, before.nodes.length, 'undo returns the map');
  await h.view.travel(true);
  const after = await h.saved();
  assert.equal(after.nodes.length, before.nodes.length + 6, 'redo brings the cards back');
  const kid = after.nodes.find(n => n.id === h.view.map.nodes.find(m => m.path === after.nodes.at(-1).path).id);
  assert.equal((await h.repo.readNote(kid.path)).summary.length > 0, true, 'and their summaries');
});

test('E2-y: the map changes under the reply (another map opens): the open map and its Map.md are not written, the batch is reported failed', async () => {
  const h = await harness(tree4);
  const writes = countMapWrites(h);
  const disk = JSON.stringify(await h.saved());
  const other = { id: 'map-other', title: 'Other', version: 1, nodes: [{ id: 'o1', parentId: null, path: 'o1.md', x: 0, y: 0 }], viewport: { x: 0, y: 0, zoom: 1 } };
  const otherJson = JSON.stringify(other);
  afterNthCard(h, 3, async () => { h.view.path = 'Agent Workspace/Topics/map-other/Map.md'; h.view.map = other; });
  const lines = await chatApply(h, kidsOf(h, 8));
  assert.equal(writes.n, 0, 'no write of the old map');
  assert.equal(JSON.stringify(await h.saved()), disk, 'the old map is as it was');
  assert.equal(JSON.stringify(h.view.map), otherJson, 'the open map keeps its own content');
  assert.ok(lines.some(line => line.status === 'failed'), 'the batch is reported');
});

test('E2-y: another write of Map.md during the batch is kept: the staged cards are put on it, one write, no conflict window', async () => {
  const h = await harness(tree4);
  const root = h.named('Root');
  const extra = await h.repo.createNote('Elsewhere', 'gpt-6-luna', { id: 'map-d', title: 'Direction', version: 1, nodes: [] }, MAP, 'workspace');
  Object.assign(extra, { parentId: root.id, x: 1360, y: 600 });
  afterNthCard(h, 3, async () => {
    const doc = await h.repo.readMap(MAP);
    doc.nodes.push(extra);
    await h.view.app.vault.process(h.view.app.vault.getAbstractFileByPath(MAP), () => support.core.serializeMap(doc));
  });
  const lines = await chatApply(h, kidsOf(h, 6));
  assert.equal(lines.filter(line => line.status === 'failed').map(line => line.text).join('|'), '');
  const saved = await h.saved();
  assert.equal(saved.nodes.length, tree4.length + 1 + 6, 'their card and the six');
  assert.ok(saved.nodes.some(n => n.id === extra.id));
  assert.ok(h.view.map.nodes.some(n => n.id === extra.id), 'the screen shows their card too');
  assert.equal(h.view.map.nodes.length, saved.nodes.length);
});

const outsideEdit = (h, change) => async () => {
  const doc = await h.repo.readMap(MAP);
  change(doc);
  await h.view.app.vault.process(h.view.app.vault.getAbstractFileByPath(MAP), () => support.core.serializeMap(doc));
};

test('E2-y: the parent card of the batch is deleted by another write during it: nothing of the batch is written and the lines say why', async () => {
  const h = await harness(tree4);
  const parent = h.named('B').id;
  afterNthCard(h, 3, outsideEdit(h, doc => { doc.nodes = doc.nodes.filter(n => n.id !== parent); }));
  const actions = kidsOf(h, 6).map(a => ({ ...a, parentId: parent }));
  const lines = await chatApply(h, actions);
  const saved = await h.saved();
  assert.equal(saved.nodes.length, tree4.length - 1, 'only their change is on disk: no card of the batch');
  assert.equal(saved.nodes.some(n => n.parentId === parent), false);
  assert.equal(lines.filter(line => line.status === 'failed').length, 6, 'every card of the batch says it was not written');
  // E2-y: the reason is in plain words (ui.map_chat_fail_changed), never the internal code.
  assert.ok(lines.every(line => !line.text || line.status !== 'failed' || (/the card was changed after you sent the message/.test(line.text) && !/changed-target/.test(line.text))), 'with the reason in plain words');
});

test('E2-y: another write changes a card field the batch also changes: theirs is not overwritten, the batch is not written', async () => {
  const h = await harness(tree4);
  const root = h.named('Root');
  root.collapsed = true;
  await h.repo.saveMap(MAP, h.view.map);
  afterNthCard(h, 3, outsideEdit(h, doc => { doc.nodes.find(n => n.id === root.id).collapsed = false; doc.nodes.find(n => n.id === root.id).x += 7; }));
  const lines = await chatApply(h, kidsOf(h, 6));
  const saved = await h.saved();
  assert.equal(saved.nodes.length, tree4.length, 'no card of the batch is on disk');
  assert.equal(saved.nodes.find(n => n.id === root.id).x, 1007, 'their edit is still there');
  assert.equal(lines.filter(line => line.status === 'failed').length, 6);
});

module.exports = { layout, node, snap, sample, sampleHeight, folded, converging, sized, sizedHeight, branchBase };
