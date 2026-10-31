// P1 (23/24): the paste plan from a validated payload, and the cut-into-own-branch check.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, obsidian } = require('./support.cjs');
const paste = load('experiences/visual-map/clipboard-paste.ts', { obsidian });
// The module runs in its own vm realm, so results are copied into this realm before deepEqual compares them.
const plain = value => JSON.parse(JSON.stringify(value));
const planPaste = payload => plain(paste.planPaste(payload));
const canPasteCut = (nodes, roots, target) => plain(paste.canPasteCut(nodes, roots, target));

const node = (id, parent = null, extra = {}) => ({ id, parent, title: `T ${id}`, kind: 'topic', body: `body ${id}`, ...extra });
const payload = (nodes, relations = []) => ({ format: 'vam-branch', version: 1, clipId: 'clip-0001', nodes, relations });
const rel = (from, to, extra = {}) => ({ kind: 'related', from, to, ...extra });

test('plan keeps title, kind, body and strength, and maps parents to item indexes', () => {
  const p = planPaste(payload([node('a'), node('b', 'a', { kind: 'hypothesis', strength: 'strong' }), node('c', 'b')]));
  assert.equal(p.ok, true);
  assert.deepEqual(p.items.map(i => [i.index, i.parent, i.title, i.kind, i.body]), [[0, null, 'T a', 'topic', 'body a'], [1, 0, 'T b', 'hypothesis', 'body b'], [2, 1, 'T c', 'topic', 'body c']]);
  assert.equal(p.items[1].strength, 'strong');
  assert.equal(Object.hasOwn(p.items[0], 'strength'), false);
});
test('every parent comes before its children even when the payload lists them out of order', () => {
  const p = planPaste(payload([node('c', 'b'), node('b', 'a'), node('a')]));
  assert.equal(p.ok, true);
  assert.deepEqual(p.items.map(i => i.title), ['T a', 'T b', 'T c']);
  for (const item of p.items) assert.ok(item.parent === null || item.parent < item.index);
});
test('siblings and roots keep payload order; a second root is a root', () => {
  const p = planPaste(payload([node('r1'), node('x', 'r1'), node('r2'), node('y', 'r1')]));
  assert.deepEqual(p.items.map(i => [i.title, i.parent]), [['T r1', null], ['T x', 0], ['T y', 0], ['T r2', null]]);
});
test('relations are translated to item indexes, descriptions kept, self and dangling ends dropped and counted', () => {
  const p = planPaste(payload([node('a'), node('b', 'a')], [rel('b', 'a', { description: 'why' }), rel('a', 'a'), rel('a', 'zzz'), rel('zzz', 'a')]));
  assert.deepEqual(p.relations, [{ kind: 'related', from: 1, to: 0, description: 'why' }]);
  assert.equal(p.droppedRelations, 3);
});
test('relations to nodes outside the branch never make it into the plan', () => {
  const p = planPaste(payload([node('a')], [rel('a', 'outside-1'), rel('outside-2', 'outside-3')]));
  assert.deepEqual(p.relations, []);
  assert.equal(p.droppedRelations, 2);
});
test('duplicate id, unknown parent and a parent cycle give bad-tree and no partial plan', () => {
  assert.deepEqual(planPaste(payload([node('a'), node('a')])), { ok: false, reason: 'bad-tree' });
  assert.deepEqual(planPaste(payload([node('a', 'nope')])), { ok: false, reason: 'bad-tree' });
  assert.deepEqual(planPaste(payload([node('a', 'b'), node('b', 'a')])), { ok: false, reason: 'bad-tree' });
  assert.deepEqual(planPaste(payload([node('a', 'a')])), { ok: false, reason: 'bad-tree' });
});
test('a 500-deep chain plans without exhausting the stack; hostile input never throws', () => {
  const chain = Array.from({ length: 500 }, (_, i) => node(`n${i}`, i ? `n${i - 1}` : null));
  const p = planPaste(payload(chain));
  assert.equal(p.ok, true); assert.equal(p.items.length, 500); assert.equal(p.items[499].parent, 498);
  assert.deepEqual(plain(paste.planPaste(null)), { ok: false, reason: 'bad-tree' });
  assert.deepEqual(plain(paste.planPaste({})), { ok: false, reason: 'bad-tree' });
});
test('the plan is built from fixed fields: extra keys on a node are not carried over', () => {
  const raw = paste.planPaste(payload([node('a', null, { path: '../../x.md', mapId: 'evil', __proto__: { polluted: 1 } })]));
  assert.deepEqual(Object.keys(raw.items[0]).sort(), ['body', 'index', 'kind', 'parent', 'title']);
  assert.equal(Object.getPrototypeOf(raw.items[0]).polluted, undefined);
});

const map = [{ id: 'r', parentId: null }, { id: 'a', parentId: 'r' }, { id: 'b', parentId: 'a' }, { id: 'c', parentId: 'b' }, { id: 'o', parentId: 'r' }, { id: 'r2', parentId: null }];
test('cut: pasting under itself, a child or a grandchild is refused', () => {
  for (const target of ['a', 'b', 'c']) assert.deepEqual(canPasteCut(map, ['a'], target), { ok: false, reason: 'into-own-branch' }, target);
});
test('cut: another branch, the parent, a sibling and the top level are fine', () => {
  for (const target of ['o', 'r', 'r2', null]) assert.deepEqual(canPasteCut(map, ['a'], target), { ok: true }, String(target));
  assert.deepEqual(canPasteCut(map, ['c'], 'a'), { ok: true });
});
test('cut: with several roots, the target may not be inside any of them', () => {
  assert.deepEqual(canPasteCut(map, ['o', 'a'], 'c'), { ok: false, reason: 'into-own-branch' });
  assert.deepEqual(canPasteCut(map, ['o', 'a'], 'o'), { ok: false, reason: 'into-own-branch' });
  assert.deepEqual(canPasteCut(map, ['o', 'a'], 'r2'), { ok: true });
});
test('cut: unknown target, nothing selected, and a parent loop in the map do not hang or throw', () => {
  assert.deepEqual(canPasteCut(map, ['a'], 'ghost'), { ok: false, reason: 'unknown-target' });
  assert.deepEqual(canPasteCut(map, [], 'o'), { ok: false, reason: 'nothing-selected' });
  const loop = [{ id: 'x', parentId: 'y' }, { id: 'y', parentId: 'x' }, { id: 'z', parentId: null }];
  assert.deepEqual(canPasteCut(loop, ['z'], 'x'), { ok: true });
});
