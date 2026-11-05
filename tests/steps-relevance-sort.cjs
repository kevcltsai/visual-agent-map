// Relevance display sort: pure ordering, stability, nesting, top level, and "view only" (no writes). No UI, no AI.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { load } = require('./support-replay.cjs');
const { orderSiblingsByRelevance, relevanceDisplayNodes } = load('experiences/visual-map/relevance-order.ts');

const node = (id, parentId, y, extra = {}) => ({ id, path: `n/${id}.md`, parentId, x: 0, y, ...extra });
const freeze = nodes => { nodes.forEach(n => Object.freeze(n)); return Object.freeze(nodes); };
const ids = list => list.map(n => n.id);

test('siblings order core, support, side, ungraded and keep on-screen order inside a tier', () => {
  const tiers = { a: 'side', b: 'core', c: undefined, d: 'support', e: 'core', f: 'side' };
  const siblings = freeze([node('a', null, 0), node('b', null, 100), node('c', null, 200), node('d', null, 300), node('e', null, 400), node('f', null, 500)]);
  assert.deepEqual(ids(orderSiblingsByRelevance(siblings, id => tiers[id])), ['b', 'e', 'd', 'a', 'f', 'c']);
});

test('all ungraded or all one tier keeps the current on-screen order', () => {
  const siblings = freeze([node('c', 'p', 300), node('a', 'p', 100), node('b', 'p', 200)]);
  assert.deepEqual(ids(orderSiblingsByRelevance(siblings, () => undefined)), ['a', 'b', 'c']);
  assert.deepEqual(ids(orderSiblingsByRelevance(siblings, () => 'support')), ['a', 'b', 'c']);
});

test('display layout sorts every group, never changes a parent, and keeps subtrees with their card', () => {
  const tiers = { r1: 'side', r2: 'core', a: 'side', b: 'core', c: 'support', b1: 'side', b2: 'core' };
  const nodes = freeze([
    node('r1', null, 0), node('r2', null, 400),
    node('a', 'r2', 0), node('b', 'r2', 100), node('c', 'r2', 200),
    node('b1', 'b', 100), node('b2', 'b', 200)
  ]);
  const before = JSON.stringify(nodes);
  const shown = relevanceDisplayNodes(nodes, id => tiers[id]);
  assert.equal(JSON.stringify(nodes), before, 'input is not changed');
  assert.deepEqual(ids(shown), ids(nodes), 'same cards in the same array order');
  assert.deepEqual(shown.map(n => n.parentId), nodes.map(n => n.parentId));
  const y = id => shown.find(n => n.id === id).y;
  const x = id => shown.find(n => n.id === id).x;
  assert.ok(y('r2') < y('r1'), 'top level: core root above side root');
  assert.ok(y('b') < y('c') && y('c') < y('a'), 'core, support, side among r2 children');
  assert.ok(y('b2') < y('b1'), 'nested group sorted too');
  assert.ok(x('b1') > x('b'), 'children stay in the next column');
});

test('display layout with nothing graded matches the map auto layout order of the current positions', () => {
  const nodes = freeze([node('r', null, 0), node('x', 'r', 200), node('y', 'r', 100)]);
  const shown = relevanceDisplayNodes(nodes, () => undefined);
  const y = id => shown.find(n => n.id === id).y;
  assert.ok(y('y') < y('x'));
});

test('the toggle is display only: no repository, map or file write in its code path', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../experiences/visual-map/view.ts'), 'utf8');
  const start = src.indexOf('// The sort icon: display only');
  const body = src.slice(start, src.indexOf('sort.setAttr("aria-pressed"', start));
  assert.ok(start > 0 && body.length > 0);
  for (const forbidden of ['repo.', 'mapChange', 'enqueue', 'vault.', 'saveMap', 'updateNote', 'writeFile', 'process(', 'fit()', 'saveViewport']) assert.ok(!body.includes(forbidden), forbidden);
  const order = fs.readFileSync(path.resolve(__dirname, '../experiences/visual-map/relevance-order.ts'), 'utf8');
  assert.ok(!/repo|vault|writeFile/.test(order));
  assert.ok(/relevanceSortedMaps = new Set/.test(src), 'toggle state is memory only');
});
