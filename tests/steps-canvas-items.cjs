// Canvas items (map-images P1): Map.md is untrusted, so each counter-example must drop only the bad item and never throw.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./support.cjs');
const ci = load('experiences/visual-map/canvas-items.ts');
// The module runs in its own vm realm, so results are copied into this realm before deepEqual compares them.
const plain = value => JSON.parse(JSON.stringify(value));
const sanitize = raw => plain(ci.sanitizeCanvasItems(raw));
const img = (over = {}) => ({ id: 'i1', kind: 'image', path: 'attachments/a.png', x: 10, y: 20, w: 100, h: 50, ...over });
const boundary = (over = {}) => ({ id: 'b1', kind: 'boundary', members: ['n1', 'n2'], ...over });

test('valid image and boundary round-trip', () => {
  assert.deepEqual(sanitize([img(), boundary({ label: 'Group' })]), [img(), boundary({ label: 'Group' })]);
});

test('counter-example 5: https and parent-path image paths drop that item only', () => {
  const kept = img({ id: 'ok' });
  const out = sanitize([
    img({ id: 'u', path: 'https://example.com/x.png' }),
    img({ id: 'p', path: '../x.png' }),
    img({ id: 'a', path: '/etc/x.png' }),
    img({ id: 'f', path: 'file:///x.png' }),
    img({ id: 's', path: 'a/b.svg' }),
    kept,
  ]);
  assert.deepEqual(out, [kept]);
});

test('counter-example 6: an unknown kind is kept as is', () => {
  const future = { kind: 'sticky', id: 'z', text: 'hi', extra: { n: 1 } };
  assert.deepEqual(sanitize([future, img()]), [future, img()]);
});

test('counter-example 7: NaN, Infinity, zero or negative size drops only that item', () => {
  const out = sanitize([img({ id: 'n', x: NaN }), img({ id: 'f', w: Infinity }), img({ id: 'z', h: 0 }), img({ id: 'g', w: -1 }), img({ id: 'good' })]);
  assert.deepEqual(out.map(i => i.id), ['good']);
  // NaN does not survive JSON, so also check the raw value reaches the module as NaN.
  assert.equal(ci.sanitizeCanvasItems([{ ...img(), y: NaN }]).length, 0);
});

test('non-array input and junk entries never throw', () => {
  for (const raw of [null, undefined, 3, 'x', {}]) assert.deepEqual(sanitize(raw), []);
  assert.deepEqual(sanitize([null, 1, 'x', [], { kind: 3 }, { id: 'x' }]), []);
});

test('duplicate ids keep the first; malformed boundary members drop the boundary', () => {
  assert.deepEqual(sanitize([img(), img({ x: 99 })]).length, 1);
  assert.deepEqual(sanitize([boundary({ members: ['ok', 3] }), boundary({ id: 'b2', members: 'n1' })]), []);
});

test('addImage, moveItem, removeItem', () => {
  const added = plain(ci.addImage([], { id: 'i1', path: 'a.png', x: 0, y: 0, w: 10, h: 10 }));
  assert.equal(added.length, 1);
  assert.deepEqual(plain(ci.addImage(added, { id: 'i2', path: 'https://x/a.png', x: 0, y: 0, w: 10, h: 10 })), added);
  assert.deepEqual(plain(ci.moveItem(added, 'i1', 5, -3))[0], { ...added[0], x: 5, y: -3 });
  assert.deepEqual(plain(ci.moveItem(added, 'i1', NaN, 1)), added);
  assert.deepEqual(plain(ci.removeItem(added, 'i1')), []);
  assert.deepEqual(plain(ci.removeItem(added, 'nope')), added);
});

test('resizeKeepRatio derives height from width and keeps both sides at least 24', () => {
  const items = [img({ w: 100, h: 50 })];
  assert.deepEqual(plain(ci.resizeKeepRatio(items, 'i1', 200))[0], img({ w: 200, h: 100 }));
  const small = plain(ci.resizeKeepRatio(items, 'i1', 5))[0];
  assert.equal(small.h, 24);
  assert.equal(small.w, 48);
  assert.deepEqual(plain(ci.resizeKeepRatio(items, 'i1', NaN)), items);
});

const rects = { n1: { x: 0, y: 0, w: 100, h: 40 }, n2: { x: 200, y: 100, w: 100, h: 40 } };
const rectOf = id => rects[id];

test('counter-example 9: bounds only count members that exist', () => {
  assert.deepEqual(plain(ci.boundaryBounds(['n1', 'n2'], rectOf, 10)), { x: -10, y: -10, w: 320, h: 160 });
  assert.deepEqual(plain(ci.boundaryBounds(['n1', 'gone'], rectOf, 10)), { x: -10, y: -10, w: 120, h: 60 });
  assert.equal(ci.boundaryBounds(['gone'], rectOf, 10), null);
});

test('counter-example 8: pruneBoundaries removes a boundary whose members all vanished, keeps partial ones and other items', () => {
  const items = [img(), boundary({ id: 'all-gone', members: ['x', 'y'] }), boundary({ id: 'partial', members: ['n1', 'y'] }), { kind: 'sticky' }];
  const out = plain(ci.pruneBoundaries(items, new Set(['n1'])));
  assert.deepEqual(out.map(i => i.id ?? i.kind), ['i1', 'partial', 'sticky']);
  assert.deepEqual(plain(ci.pruneBoundaries(items, ['n1'])).length, 3);
});
