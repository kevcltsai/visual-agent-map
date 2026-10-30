// Layout direction: the "right" layout is pinned by golden coordinates taken before directions existed (G0). No UI, no AI.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./support-replay.cjs');
const layout = load('map-layout.ts');

const node = (id, parentId = null, extra = {}) => ({ id, parentId, path: `${id}.md`, x: 0, y: 0, collapsed: false, ...extra });
const snap = list => list.map(item => [item.id, item.x, item.y]);
const sample = () => require('../samples/taiwan-travel/compiled.json').locales['zh-TW'].nodes.map(item => ({ ...item }));
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
  sampleBranch: [['explore', 20, 300], ['constraints', 350, 0], ['budget', 690, 0], ['companions', 690, 170], ['transport', 380, 1204], ['rail-car', 740, 1204], ['food', 350, 500], ['nature', 350, 750], ['weather', 690, 750], ['lodging', 350, 1000], ['journey', 1050, 350], ['next', 1390, 500]],
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
  for (const value of ['left', { direction: 'down' }, {}, 3, null, [], { direction: 5 }]) {
    const parsed = core.parseMap(core.serializeMap(doc({ layout: value })));
    assert.equal('layout' in parsed, false, JSON.stringify(value));
  }
  const plainDoc = doc();
  const text = core.serializeMap(plainDoc);
  assert.equal(core.serializeMap(core.parseMap(text)), text, 'a map without layout serializes to the same text');
  assert.equal('layout' in core.parseMap(text), false);
});

test('L7: layoutDirectionOf reads the map, and AIM maps or missing fields are always right', () => {
  assert.equal(layout.layoutDirectionOf({ layout: { direction: 'left' } }), 'left');
  assert.equal(layout.layoutDirectionOf({ layout: { direction: 'right' } }), 'right');
  assert.equal(layout.layoutDirectionOf({ layout: { direction: 'left' }, aim: { version: 1 } }), 'right');
  assert.equal(layout.layoutDirectionOf({}), 'right');
  assert.equal(layout.layoutDirectionOf(null), 'right');
  assert.equal(layout.layoutDirectionOf(undefined), 'right');
  assert.equal(layout.layoutDirectionOf({ layout: { direction: 'down' } }), 'right');
  assert.equal(layout.isLayoutDirection('left'), true);
  assert.equal(layout.isLayoutDirection('right'), true);
  for (const value of ['down', '', null, undefined, 1, {}]) assert.equal(layout.isLayoutDirection(value), false);
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
  assert.equal(geometry.treeEdgePathData(parent, child, 'left'), 'M 800 190 C 740 190, 800 50, 740 50');
  const far = { x: 0, y: 0, width: 300, height: 100 };
  assert.equal(geometry.treeEdgePathData(parent, far, 'left'), 'M 800 190 C 550 190, 550 50, 300 50', 'arms are half the distance when it is wide');
});

const relevance = load('experiences/visual-map/relevance-order.ts');

test('L9: the relevance display layout follows the left direction', () => {
  const nodes = [node('r'), node('a', 'r', { y: 100 }), node('b', 'r', { y: 0 }), node('b1', 'b')];
  const tiers = { a: 'core', b: 'side' };
  const right = relevance.relevanceDisplayNodes(nodes, id => tiers[id]);
  const left = relevance.relevanceDisplayNodes(nodes, id => tiers[id], undefined, L);
  assert.deepEqual(snap(relevance.relevanceDisplayNodes(nodes, id => tiers[id], undefined, 'right')), snap(right));
  for (const item of left) {
    assert.equal(item.y, at(right, item.id).y);
    assert.equal(item.x, at(left, 'r').x - depthOf(nodes, item.id) * 360);
  }
  assert.ok(at(left, 'a').y < at(left, 'b').y, 'still sorted by relevance');
});

module.exports = { layout, node, snap, sample, sampleHeight, folded, converging, sized, sizedHeight, branchBase };
