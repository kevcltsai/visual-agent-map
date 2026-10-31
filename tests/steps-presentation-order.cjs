// 42 P1: presentation reading order. Pure functions over MapNode[]; not wired to any UI yet.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { load } = require('./support-replay.cjs');

const { readingOrder, stepOrder } = load('experiences/visual-map/presentation-order.ts');
const node = (id, parentId, x, y, extra = {}) => ({ id, path: `${id}.md`, parentId, x, y, collapsed: false, ...extra });
const ids = list => [...list];

test('empty array gives an empty order', () => {
  assert.deepEqual(ids(readingOrder([])), []);
});

test('pre-order walk sorts siblings by y and ignores array order', () => {
  const nodes = [node('c2', 'r', 300, 200), node('r', null, 0, 0), node('c1', 'r', 300, 100), node('g', 'c1', 600, 50)];
  assert.deepEqual(ids(readingOrder(nodes)), ['r', 'c1', 'g', 'c2']);
});

test('roots are ordered by the same rule', () => {
  const nodes = [node('b', null, 0, 500), node('a', null, 0, 10), node('a1', 'a', 100, 10)];
  assert.deepEqual(ids(readingOrder(nodes)), ['a', 'a1', 'b']);
});

test('equal y falls back to x, then to original index (stable)', () => {
  const byX = [node('r', null, 0, 0), node('right', 'r', 300, 100), node('left', 'r', 200, 100)];
  assert.deepEqual(ids(readingOrder(byX)), ['r', 'left', 'right']);
  const same = [node('r', null, 0, 0), node('s1', 'r', 300, 100), node('s2', 'r', 300, 100), node('s3', 'r', 300, 100)];
  assert.deepEqual(ids(readingOrder(same)), ['r', 's1', 's2', 's3']);
  const swapped = [node('r', null, 0, 0), node('s3', 'r', 300, 100), node('s1', 'r', 300, 100), node('s2', 'r', 300, 100)];
  assert.deepEqual(ids(readingOrder(swapped)), ['r', 's3', 's1', 's2']);
});

test('siblingAxis x sorts by x first, then y', () => {
  const nodes = [node('r', null, 0, 0), node('b', 'r', 500, 10), node('a', 'r', 100, 900)];
  assert.deepEqual(ids(readingOrder(nodes, { siblingAxis: 'x' })), ['r', 'a', 'b']);
  assert.deepEqual(ids(readingOrder(nodes)), ['r', 'b', 'a']);
});

test('collapsed node is listed, its descendants only with includeHidden', () => {
  const nodes = [node('r', null, 0, 0), node('c', 'r', 1, 1, { collapsed: true }), node('g', 'c', 2, 2), node('gg', 'g', 3, 3), node('d', 'r', 1, 9)];
  assert.deepEqual(ids(readingOrder(nodes)), ['r', 'c', 'd']);
  assert.deepEqual(ids(readingOrder(nodes, { includeHidden: false })), ['r', 'c', 'd']);
  assert.deepEqual(ids(readingOrder(nodes, { includeHidden: true })), ['r', 'c', 'g', 'gg', 'd']);
});

test('missing parent makes the node a root', () => {
  const nodes = [node('r', null, 0, 100), node('orphan', 'gone', 0, 50), node('k', 'orphan', 9, 9)];
  assert.deepEqual(ids(readingOrder(nodes)), ['orphan', 'k', 'r']);
});

test('parent cycle: no infinite loop, every id exactly once, cut-off nodes appended last', () => {
  const nodes = [node('a', 'b', 0, 0), node('b', 'a', 0, 10), node('r', null, 0, 99), node('tail', 'a', 0, 20)];
  const order = readingOrder(nodes);
  assert.deepEqual(ids(order), ['r', 'a', 'b', 'tail']);
  assert.equal(new Set(order).size, nodes.length);
  assert.deepEqual(ids(readingOrder(nodes, { includeHidden: true })), ['r', 'a', 'b', 'tail']);
  assert.deepEqual(ids(readingOrder([node('self', 'self', 0, 0)])), ['self']);
});

test('cut-off nodes are not hidden-descendant leaks: a collapsed branch stays hidden next to a cycle', () => {
  const nodes = [node('r', null, 0, 0), node('c', 'r', 1, 1, { collapsed: true }), node('g', 'c', 2, 2), node('x', 'y', 0, 5), node('y', 'x', 0, 6)];
  assert.deepEqual(ids(readingOrder(nodes)), ['r', 'c', 'x', 'y']);
});

test('aimConvergesFromNodeIds is ignored', () => {
  const nodes = [node('r', null, 0, 0), node('a', 'r', 1, 1), node('m', 'r', 1, 2, { aimConvergesFromNodeIds: ['a', 'r'] })];
  assert.deepEqual(ids(readingOrder(nodes)), ['r', 'a', 'm']);
});

test('5000-level chain does not overflow the stack', () => {
  const nodes = [];
  for (let i = 0; i < 5000; i++) nodes.push(node(`n${i}`, i ? `n${i - 1}` : null, i, i));
  const order = readingOrder(nodes);
  assert.equal(order.length, 5000);
  assert.equal(order[0], 'n0');
  assert.equal(order[4999], 'n4999');
  assert.equal(readingOrder(nodes, { includeHidden: true }).length, 5000);
});

test('stepOrder moves without wrapping and returns null at the ends', () => {
  const order = ['a', 'b', 'c'];
  assert.deepEqual({ ...stepOrder(order, 'a', 1) }, { id: 'b', index: 1, total: 3 });
  assert.deepEqual({ ...stepOrder(order, 'c', -1) }, { id: 'b', index: 1, total: 3 });
  assert.equal(stepOrder(order, 'c', 1), null);
  assert.equal(stepOrder(order, 'a', -1), null);
});

test('stepOrder with unknown or null id: first for +1, last for -1', () => {
  const order = ['a', 'b', 'c'];
  assert.deepEqual({ ...stepOrder(order, 'zzz', 1) }, { id: 'a', index: 0, total: 3 });
  assert.deepEqual({ ...stepOrder(order, 'zzz', -1) }, { id: 'c', index: 2, total: 3 });
  assert.deepEqual({ ...stepOrder(order, null, 1) }, { id: 'a', index: 0, total: 3 });
  assert.deepEqual({ ...stepOrder(order, null, -1) }, { id: 'c', index: 2, total: 3 });
});

test('stepOrder on an empty list is null', () => {
  assert.equal(stepOrder([], null, 1), null);
  assert.equal(stepOrder([], 'a', -1), null);
});

test('sample map taiwan-travel (12 nodes, 2 roots) lists every node once', () => {
  const file = path.join(__dirname, '..', 'samples', 'taiwan-travel', 'zh-TW', 'Map.md');
  const { core } = require('./support.cjs');
  const doc = core.parseMap(fs.readFileSync(file, 'utf8'));
  assert.equal(doc.nodes.length, 12);
  const order = readingOrder(doc.nodes);
  assert.equal(order.length, doc.nodes.length);
  assert.equal(new Set(order).size, doc.nodes.length);
});
