// Card resize (ticket card-resize): the width data contract, layout room for wide cards, share payload and viewer.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./support-replay.cjs');
const layout = load('map-layout.ts');
const core = load('map-model.ts');
const graph = load('map-graph.ts');

const node = (id, parentId = null, extra = {}) => ({ id, parentId, path: `${id}.md`, x: 0, y: 0, collapsed: false, ...extra });
const doc = nodes => ({ version: 1, id: 'm', title: 'M', nodes, viewport: { x: 0, y: 0, zoom: 1 } });
const roundTrip = nodes => core.parseMap(core.serializeMap(doc(nodes))).nodes;
const widths = nodes => JSON.stringify(nodes.map(item => item.width ?? null));
const COLUMN = 360;
const heightOf = () => 100;

test('card width constants and clamp', () => {
  assert.deepEqual([graph.CARD_WIDTH, graph.CARD_WIDTH_MIN, graph.CARD_WIDTH_MAX, graph.CARD_WIDTH_STEP], [280, 200, 560, 40]);
  assert.equal(graph.clampCardWidth(100), 200);
  assert.equal(graph.clampCardWidth(900), 560);
  assert.equal(graph.clampCardWidth(320.4), 320);
  assert.equal(graph.clampCardWidth('320'), undefined);
  assert.equal(graph.clampCardWidth(NaN), undefined);
});

test('A1 width survives a round trip and parse cleans it', () => {
  const back = roundTrip([node('a', null, { width: 400 }), node('b', 'a', { width: 280 }), node('c', 'a', { width: 'wide' }), node('d', 'a', { width: 120 }), node('e', 'a', { width: 999 }), node('f', 'a', { width: 333.6 }), node('g', 'a')]);
  assert.equal(widths(back), JSON.stringify([400, null, null, 200, 560, 334, null]));
  assert.equal('width' in back[1], false);
  assert.equal('width' in back[2], false);
});

test('A1 a map without width is byte-identical after parse and serialize', () => {
  const text = core.serializeMap(doc([node('a'), node('b', 'a', { x: 360, y: 10 })]));
  assert.equal(core.serializeMap(core.parseMap(text)), text);
  assert.equal(text.includes('width'), false);
});

test('A2 an older plugin (plain JSON read and write, no field whitelist) keeps width', () => {
  const text = core.serializeMap(doc([node('a', null, { width: 400 })]));
  const block = text.match(/```agent-map\n([\s\S]*?)\n```/)[1];
  const again = JSON.stringify(JSON.parse(block), null, 2);
  assert.equal(again, block);
  assert.equal(JSON.parse(again).nodes[0].width, 400);
});

const tree = extra => [node('r', null, extra.r), node('a', 'r', extra.a), node('b', 'r', extra.b), node('a1', 'a', extra.a1)];
const arranged = (extra, dir = 'right') => layout.arrangeMap(tree(extra), undefined, heightOf, dir);
const byId = list => Object.fromEntries(list.map(item => [item.id, item]));

test('A3 without width the coordinates are unchanged', () => {
  const plain = byId(arranged({}));
  assert.equal(plain.a.x - plain.r.x, COLUMN);
  assert.equal(plain.a1.x - plain.a.x, COLUMN);
  assert.equal(JSON.stringify(arranged({})), JSON.stringify(arranged({ r: {}, a: {} })));
});

test('A3 right layout makes room after a wide card and takes the widest per level', () => {
  const m = byId(arranged({ r: { width: 400 }, a: { width: 560 }, b: { width: 320 } }));
  assert.equal(m.a.x - m.r.x, COLUMN + 120);
  assert.equal(m.b.x, m.a.x);
  assert.equal(m.a1.x - m.a.x, COLUMN + 280);
  const wide = [m.r, m.a, m.b, m.a1];
  for (const x of wide) for (const y of wide) if (x !== y && x.id < y.id) assert.ok(x.x + (x.width ?? 280) <= y.x || y.x + (y.width ?? 280) <= x.x || x.y + 100 <= y.y || y.y + 100 <= x.y);
});

test('A3 left layout pushes a wide card left by its own excess', () => {
  const m = byId(arranged({ a: { width: 560 }, b: { width: 400 } }, 'left'));
  assert.equal(m.r.x - m.a.x, COLUMN + 280);
  assert.equal(m.a.x, m.b.x);
  assert.equal(m.a.x - m.a1.x, COLUMN);
  assert.ok(m.a.x + 560 + 80 <= m.r.x);
});

test('A3 arrangeNewBranch makes room for a wide parent and wide new children', () => {
  const base = [node('p', null, { x: 100, y: 0, width: 480 }), node('c', 'p')];
  const right = byId(layout.arrangeNewBranch(base, 'p', new Set(['c']), heightOf, undefined, 'right'));
  assert.equal(right.c.x, 100 + COLUMN + 200);
  const plain = byId(layout.arrangeNewBranch([node('p', null, { x: 100 }), node('c', 'p')], 'p', new Set(['c']), heightOf, undefined, 'right'));
  assert.equal(plain.c.x, 100 + COLUMN);
  const left = byId(layout.arrangeNewBranch([node('p', null, { x: 800 }), node('c', 'p', { width: 520 })], 'p', new Set(['c']), heightOf, undefined, 'left'));
  assert.equal(left.c.x, 800 - COLUMN - 240);
});
