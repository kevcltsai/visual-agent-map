// canvas-text-node P1: free text blocks with `links` (A1 sanitize, A2 0.28.0 compatibility, pure helpers).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { load, loadSource } = require('./support-replay.cjs');
const ci = load('experiences/visual-map/canvas-items.ts');
const plain = value => JSON.parse(JSON.stringify(value));
const sanitize = raw => plain(ci.sanitizeCanvasItems(raw));
const free = (over = {}) => ({ id: 'f1', kind: 'text', text: 'free', x: 10, y: 20, ...over });
const img = { id: 'i1', kind: 'image', path: 'a.png', x: 1, y: 2, w: 3, h: 4 };

test('A1: links keep valid distinct ids; bad single ids are dropped, the rest stay', () => {
  const out = sanitize([free({ links: ['a', 'b', 'a', 'bad id', 7, null, '', 'f1', 'x'.repeat(65), 'c'] })]);
  assert.deepEqual(out[0].links, ['a', 'b', 'c']);
});

test('A1: more than 20 links keep the first 20 valid ones', () => {
  const many = Array.from({ length: 30 }, (_, i) => `n${i}`);
  assert.deepEqual(sanitize([free({ links: many })])[0].links, many.slice(0, 20));
});

test('A1: empty, non-array or all-bad links omit the field', () => {
  for (const links of [[], 'a', 5, null, {}, ['bad id'], ['f1']]) assert.ok(!('links' in sanitize([free({ links })])[0]), JSON.stringify(links));
});

test('A1: a map with no links serialises the same bytes as before; links round-trip', () => {
  const items = [free(), free({ id: 'f2', parentId: 'r' }), img];
  assert.equal(JSON.stringify(sanitize(items)), JSON.stringify(items));
  const linked = [free({ links: ['a', 'b'] })];
  assert.deepEqual(sanitize(linked), linked);
  assert.deepEqual(sanitize(sanitize(linked)), linked);
});

test('A2: the 0.28.0 plugin reads and writes a free text block with links unchanged', () => {
  let source;
  try {
    source = execFileSync('git', ['show', '0.28.0:experiences/visual-map/canvas-items.ts'], { cwd: path.join(__dirname, '..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    source = fs.readFileSync(path.join(__dirname, 'fixtures', 'legacy-canvas-items-47c406a.ts.txt'), 'utf8');
  }
  const old = loadSource(source);
  const items = [free({ links: ['a', 'b'] }), free({ id: 'f2' }), img];
  let out;
  assert.doesNotThrow(() => (out = plain(old.sanitizeCanvasItems(items))));
  assert.deepEqual(out, items);
  assert.deepEqual(sanitize(out), items);
  // topicRelations is a separate field: nothing here touches it.
  assert.ok(items.every(i => !('topicRelations' in i)));
});

test('A2: dangling links are kept on read and removed by removeLinksTo on the next write', () => {
  const items = sanitize([free({ links: ['alive', 'gone'] })]);
  assert.deepEqual(items[0].links, ['alive', 'gone']);
  assert.deepEqual(plain(ci.removeLinksTo(items, ['gone']))[0].links, ['alive']);
});

test('addFreeTextNode adds without parent or links; bad or duplicate id changes nothing', () => {
  const out = plain(ci.addFreeTextNode([img], { id: 'f1', text: '  hi ', x: 1, y: 2 }));
  assert.deepEqual(out, [img, { id: 'f1', kind: 'text', text: 'hi', x: 1, y: 2 }]);
  assert.deepEqual(plain(ci.addFreeTextNode(out, { id: 'f1', text: 'again', x: 0, y: 0 })), out);
  assert.deepEqual(plain(ci.addFreeTextNode(out, { id: 'f2', text: '   ', x: 0, y: 0 })), out);
  assert.deepEqual(plain(ci.addFreeTextNode(out, { id: 'i1', text: 'clash', x: 0, y: 0 })), out);
});

test('moveTextNode moves only that text node and ignores non-finite deltas', () => {
  const items = [free(), free({ id: 'f2' }), img];
  const out = plain(ci.moveTextNode(items, 'f1', 5, -5));
  assert.deepEqual([out[0].x, out[0].y, out[1].x, out[1].y], [15, 15, 10, 20]);
  assert.deepEqual(out[2], img);
  assert.deepEqual(plain(ci.moveTextNode(items, 'f1', NaN, 1)), items);
  assert.deepEqual(plain(ci.moveTextNode(items, 'i1', 1, 1)), items, 'images are not text nodes');
});

test('linkTextNode / unlinkTextNode: dedupe, limit, own id, unknown node; last unlink drops the field', () => {
  let items = [free(), img];
  items = plain(ci.linkTextNode(items, 'f1', 'a'));
  assert.deepEqual(items[0].links, ['a']);
  assert.deepEqual(plain(ci.linkTextNode(items, 'f1', 'a')), items, 'repeat');
  assert.deepEqual(plain(ci.linkTextNode(items, 'f1', 'f1')), items, 'own id');
  assert.deepEqual(plain(ci.linkTextNode(items, 'f1', 'bad id')), items);
  assert.deepEqual(plain(ci.linkTextNode(items, 'nope', 'b')), items);
  assert.deepEqual(plain(ci.linkTextNode(items, 'i1', 'b')), items, 'image');
  for (let i = 0; i < 25; i++) items = plain(ci.linkTextNode(items, 'f1', `n${i}`));
  assert.equal(items[0].links.length, 20);
  const one = plain(ci.linkTextNode([free()], 'f1', 'a'));
  assert.ok(!('links' in plain(ci.unlinkTextNode(one, 'f1', 'a'))[0]));
  assert.deepEqual(plain(ci.unlinkTextNode(one, 'f1', 'zzz')), one);
});

test('removeLinksTo strips ids from every text node and leaves other items and objects alone', () => {
  const a = free({ links: ['x', 'y'] }), b = free({ id: 'f2', links: ['x'] }), c = free({ id: 'f3' });
  const items = [a, b, c, img];
  const out = plain(ci.removeLinksTo(items, new Set(['x'])));
  assert.deepEqual(out[0].links, ['y']);
  assert.ok(!('links' in out[1]));
  assert.deepEqual(out.slice(2), [c, img]);
  assert.deepEqual(plain(ci.removeLinksTo(items, [])), items);
  assert.deepEqual(a.links, ['x', 'y'], 'input not mutated');
});
