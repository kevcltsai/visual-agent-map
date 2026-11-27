// A10: "Tidy map" / "Tidy branch" show the result first. The pure part: the preview is a position diff of a copy,
// equal to what arrangeMap / arrangeNewBranch would write; the input map is never touched.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./support-replay.cjs');
const layout = load('map-layout.ts');
const preview = load('experiences/visual-map/layout-preview.ts');

const DIRECTIONS = ['right', 'left', 'down', 'up', 'balanced', 'radial', 'timeline', 'fishbone'];
const node = (id, parentId = null, extra = {}) => ({ id, parentId, path: `${id}.md`, x: 7, y: 9, collapsed: false, ...extra });
const tree = () => [
  node('root', null, { x: 80, y: 80 }),
  node('a', 'root'), node('b', 'root'), node('c', 'root'),
  node('a1', 'a'), node('a2', 'a'), node('b1', 'b'), node('folded', 'c', { collapsed: true }), node('hid', 'folded')
];
const mapOf = (direction, nodes = tree()) => ({ id: 'm', title: 'M', version: 1, nodes, viewport: { x: 0, y: 0, zoom: 1 }, ...(direction === 'right' ? {} : { layout: { direction } }) });
const snap = list => list.map(item => [item.id, item.x, item.y]);
const arrangeAll = map => { map.nodes = layout.arrangeMap(map.nodes, undefined, undefined, layout.layoutOf(map)); };

for (const direction of DIRECTIONS) {
  test(`A10: ${direction}: tidy-map preview equals arrangeMap and leaves the input alone`, () => {
    const map = mapOf(direction);
    const before = JSON.stringify(map);
    const result = preview.computeTidy(map, arrangeAll);
    assert.equal(JSON.stringify(map), before);
    const expected = mapOf(direction);
    arrangeAll(expected);
    const applied = JSON.parse(before).nodes;
    for (const [id, position] of result.positions) Object.assign(applied.find(item => item.id === id), position);
    assert.deepEqual(snap(applied), snap(expected.nodes));
    for (const [id, position] of result.positions) {
      const was = map.nodes.find(item => item.id === id);
      assert.ok(was.x !== position.x || was.y !== position.y, 'only moved cards are listed');
    }
    // N counts shown cards only (the folded branch's hidden card is not a card on the canvas).
    assert.equal(result.count, [...result.positions.keys()].filter(id => id !== 'hid').length);
  });
  test(`A10: ${direction}: applying the same arrange to the map writes exactly the preview`, () => {
    const map = mapOf(direction);
    const result = preview.computeTidy(map, arrangeAll);
    arrangeAll(map);
    for (const [id, position] of result.positions) {
      const now = map.nodes.find(item => item.id === id);
      assert.deepEqual([now.x, now.y], [position.x, position.y]);
    }
  });
}

test('A10: a tidy branch preview only lists the branch cards (none outside move)', () => {
  const nodes = [node('root', null, { x: 80, y: 80 }), node('a', 'root', { x: 440, y: 0 }), node('b', 'root', { x: 440, y: 400 }),
    node('a1', 'a', { x: 800, y: 3 }), node('a2', 'a', { x: 800, y: 4 })];
  const map = mapOf('right', nodes);
  const branch = m => { m.nodes = layout.arrangeNewBranch(m.nodes, 'a', new Set(['a1', 'a2']), undefined, undefined, layout.layoutOf(m)); };
  const before = JSON.stringify(map);
  const result = preview.computeTidy(map, branch);
  assert.equal(JSON.stringify(map), before);
  assert.ok(result.positions.size > 0);
  for (const id of result.positions.keys()) assert.ok(['a1', 'a2'].includes(id), `${id} moved outside the branch`);
});

test('A10: nothing to move -> empty preview; a signature changes with any edit (cancel/stale detection)', () => {
  const map = mapOf('right');
  arrangeAll(map);
  const result = preview.computeTidy(map, arrangeAll);
  assert.equal(result.count, 0);
  const sig = preview.mapSignature(map);
  assert.equal(preview.mapSignature(JSON.parse(JSON.stringify(map))), sig);
  map.nodes[1].x += 1;
  assert.notEqual(preview.mapSignature(map), sig);
});

test('A10: a card the preview does not know keeps its own position; shown() overlays only listed ids', () => {
  const nodes = [node('r', null, { x: 1, y: 2 }), node('k', 'r', { x: 3, y: 4 })];
  const out = preview.overlayPositions(nodes, new Map([['k', { x: 30, y: 40 }]]));
  assert.deepEqual(snap(out), [['r', 1, 2], ['k', 30, 40]]);
  assert.deepEqual(snap(nodes), [['r', 1, 2], ['k', 3, 4]]);
});
