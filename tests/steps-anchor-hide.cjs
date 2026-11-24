// Click an anchor to hide its topics: which topics a set of hidden anchors hides (linked topics plus their branches).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./support.cjs');
const hide = load('experiences/visual-map/anchor-hide.ts');

const anchor = id => ({ id, at: { kind: 'image-2d', x: 0.5, y: 0.5 } });
const items = [
  { id: 'img', kind: 'annotated-image', path: 'a.png', x: 0, y: 0, w: 10, h: 10, anchors: [anchor('p1'), anchor('p2'), anchor('p3')],
    relations: [{ kind: 'related', from: 'p1', to: 'a' }, { kind: 'supports', from: 'c', to: 'p2' }, { kind: 'related', from: 'p1', to: 'gone' }] },
  { id: 'img2', kind: 'annotated-image', path: 'b.png', x: 0, y: 0, w: 10, h: 10, anchors: [anchor('q1')],
    relations: [{ kind: 'related', from: 'q1', to: 'b' }] }
];
const nodes = [
  { id: 'root', parentId: null }, { id: 'a', parentId: 'root' }, { id: 'a1', parentId: 'a' }, { id: 'a11', parentId: 'a1' },
  { id: 'b', parentId: 'root' }, { id: 'c', parentId: 'root' }
];
const ids = set => [...set].sort();

test('nothing hidden hides nothing', () => {
  assert.deepEqual(ids(hide.anchorHiddenTopicIds(items, nodes, new Set())), []);
});

test('a hidden anchor hides its linked topics and their whole branch, not unknown ids', () => {
  assert.deepEqual(ids(hide.anchorHiddenTopicIds(items, nodes, new Set([hide.anchorRef('img', 'p1')]))), ['a', 'a1', 'a11']);
});

test('a relation pointing at the anchor counts too; several anchors add up', () => {
  const hidden = new Set([hide.anchorRef('img', 'p2'), hide.anchorRef('img2', 'q1')]);
  assert.deepEqual(ids(hide.anchorHiddenTopicIds(items, nodes, hidden)), ['b', 'c']);
  assert.deepEqual(ids(hide.anchorHiddenTopicIds(items, nodes, hidden, 'img')), ['c']);
});

test('an unlinked anchor or a stale key hides nothing', () => {
  assert.deepEqual(ids(hide.anchorHiddenTopicIds(items, nodes, new Set([hide.anchorRef('img', 'p3'), hide.anchorRef('x', 'y')]))), []);
  assert.deepEqual([...hide.anchorTopicIds(items, 'img', 'p1')].sort(), ['a', 'gone']);
});
