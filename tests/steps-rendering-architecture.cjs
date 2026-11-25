// Rendering snapshots: compare the indexed computations to their existing behavior, not a second layout engine.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./support-replay.cjs');
const { childIndex, branchSize, branchSizeResolver } = load('map-graph.ts');
const { depthOf, treeDepthResolver, edgeBoxReader } = load('experiences/visual-map/tree-edge-rules.ts');

test('branch counts and edge depths keep the legacy rules for trees, missing parents, weighted edges and malformed graphs', () => {
  const fixtures = [
    [
      { id: 'root', parentId: null },
      { id: 'a', parentId: 'root' },
      { id: 'b', parentId: 'root', afterTextId: 'text' },
      { id: 'a1', parentId: 'a' },
      { id: 'orphan', parentId: 'missing' }
    ],
    [
      { id: 'a', parentId: 'b' },
      { id: 'b', parentId: 'a', afterTextId: 'text' },
      { id: 'leaf', parentId: 'a' },
      { id: 'root', parentId: null }
    ],
    [
      { id: 'root', parentId: null },
      { id: 'duplicate', parentId: 'root' },
      { id: 'duplicate', parentId: 'other' },
      { id: '', parentId: null }
    ],
    Array.from({ length: 30 }, (_, at) => ({
      id: String(at), parentId: at ? String(at - 1) : null, afterTextId: 'text'
    }))
  ];
  for (const nodes of fixtures) {
    const index = childIndex(nodes);
    const counts = branchSizeResolver(index);
    const depths = treeDepthResolver(nodes);
    const ids = [...nodes.map(node => node.id), '', 'missing'].reverse();
    for (const id of ids) {
      assert.equal(counts(id), branchSize(index, id), 'branch: ' + id);
      assert.equal(depths(id), depthOf(nodes, id), 'depth: ' + id);
    }
  }
});

test('deep tree branch counts and depths reuse one snapshot instead of walking every ancestor or descendant', () => {
  const size = 1000;
  const nodes = Array.from({ length: size }, (_, at) => ({
    id: String(at), parentId: at ? String(at - 1) : null
  }));
  const children = childIndex(nodes);
  const byId = new Map(nodes.map(node => [node.id, node]));
  let childReads = 0, parentReads = 0;
  const childGet = children.get.bind(children), parentGet = byId.get.bind(byId);
  children.get = id => { childReads++; return childGet(id); };
  byId.get = id => { parentReads++; return parentGet(id); };
  const count = branchSizeResolver(children);
  const depth = treeDepthResolver(nodes, byId);
  for (let at = size - 1; at >= 0; at--) {
    assert.equal(count(String(at)), size - at - 1);
    assert.equal(depth(String(at)), at);
  }
  assert.ok(childReads <= 2 * size, 'child reads: ' + childReads);
  assert.ok(parentReads <= 2 * size, 'parent reads: ' + parentReads);
});

test('each geometry pass measures shared endpoints once, but a later pass sees changed card sizes', () => {
  const root = { width: 300 }, leaf = { width: 200 };
  let reads = 0;
  const measure = el => ({ width: el.width, read: ++reads });
  const first = edgeBoxReader(measure);
  const old = first(root);
  assert.equal(first(root), old);
  assert.equal(first(leaf).width, 200);
  root.width = 480;
  assert.equal(first(root).width, 300);
  assert.equal(reads, 2);
  const next = edgeBoxReader(measure);
  assert.equal(next(root).width, 480);
  assert.equal(reads, 3);
});
