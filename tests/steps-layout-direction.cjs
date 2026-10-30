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

module.exports = { layout, node, snap, sample, sampleHeight, folded, converging, sized, sizedHeight, branchBase };
