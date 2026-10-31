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

// ---- View: the width handle (A5, unit level) -------------------------------------------------------------------------
const support = require('./support.cjs');
const viewHarness = (width) => {
  const { VisualAgentMapView } = support.load('main.ts', { obsidian: support.obsidian });
  const nodes = [Object.assign(support.node('a', null), width ? { width } : {})];
  const doc = support.map(nodes);
  const view = new VisualAgentMapView({ app: {} }, { settings: { ...support.DEFAULT_SETTINGS }, pendingSuggestions: new Map(), expansionBatches: new Map(), detailsShown: () => false, setOutlineActive() {} });
  view.map = doc;
  const handlers = new Map(), attrs = {};
  const handle = { attrs, handlers, tabIndex: 0, focused: false,
    setAttr(name, value) { attrs[name] = value; }, addEventListener(name, fn) { handlers.set(name, fn); }, removeEventListener(name) { handlers.delete(name); }, setPointerCapture() {} };
  const style = { removeProperty(name) { delete style[name]; } };
  const card = { style, createDiv: opts => { Object.assign(attrs, opts.attr); return handle; } };
  const changes = [];
  view.enqueue = work => work();
  view.mapChange = async change => { changes.push(change); };
  view.clearHoverTimer = () => {};
  view.attachResizeHandle(card, nodes[0]);
  const run = () => { const copy = JSON.parse(JSON.stringify(doc)); changes.splice(0).forEach(change => change(copy)); return copy.nodes[0].width; };
  const key = k => { let prevented = false; handle.handlers.get('keydown')({ key: k, preventDefault() { prevented = true; }, stopPropagation() {} }); return prevented; };
  const pointer = (name, x) => handle.handlers.get(name)?.({ button: 0, pointerId: 1, clientX: x, preventDefault() {}, stopPropagation() {} });
  return { view, doc, nodes, handle, attrs, card, changes, run, key, pointer };
};

test('A5 the handle is a vertical separator with range and value, out of the tab order until the card is focused', () => {
  const h = viewHarness(400);
  assert.deepEqual({ ...h.attrs }, { role: 'separator', 'aria-orientation': 'vertical', 'aria-label': 'Card width', 'aria-valuemin': '200', 'aria-valuemax': '560', 'aria-valuenow': '400' });
  assert.equal(h.handle.tabIndex, -1);
});

test('A5 a drag writes once on release and not while moving', () => {
  const h = viewHarness();
  h.pointer('pointerdown', 100);
  h.pointer('pointermove', 180);
  h.pointer('pointermove', 220);
  assert.equal(h.card.style.width, '400px');
  assert.equal(h.changes.length, 0);
  h.pointer('pointerup', 220);
  assert.equal(h.changes.length, 1);
  assert.equal(h.run(), 400);
});

test('A5 a drag is clamped and respects zoom; dragging back to 280 clears the field', () => {
  const h = viewHarness();
  h.pointer('pointerdown', 0); h.pointer('pointermove', 5000); h.pointer('pointerup', 5000);
  assert.equal(h.run(), 560);
  const z = viewHarness(); z.doc.viewport.zoom = 2;
  z.pointer('pointerdown', 0); z.pointer('pointermove', 80); z.pointer('pointerup', 80);
  assert.equal(z.run(), 320);
  const back = viewHarness(400);
  back.pointer('pointerdown', 0); back.pointer('pointermove', -120); back.pointer('pointerup', -120);
  assert.equal(back.run(), undefined);
});

test('A5 a cancelled or zero-length drag writes nothing and restores the width', () => {
  const h = viewHarness(400);
  h.pointer('pointerdown', 0); h.pointer('pointermove', 100); h.pointer('pointercancel', 100);
  assert.equal(h.card.style.width, '400px');
  h.pointer('pointerdown', 0); h.pointer('pointerup', 0);
  assert.equal(h.changes.length, 0);
});

test('A5 keyboard: each press is one change; Home/End; Enter and double click reset; limits do nothing', () => {
  const h = viewHarness();
  assert.equal(h.key('ArrowRight'), true);
  assert.equal(h.run(), 320);
  assert.equal(h.changes.length, 0);
  const l = viewHarness(); l.key('ArrowLeft'); assert.equal(l.run(), 240);
  const lo = viewHarness(200); lo.key('ArrowLeft'); assert.equal(lo.changes.length, 0);
  const hi = viewHarness(560); hi.key('ArrowRight'); assert.equal(hi.changes.length, 0);
  const home = viewHarness(); home.key('Home'); assert.equal(home.run(), 200);
  const end = viewHarness(); end.key('End'); assert.equal(end.run(), 560);
  const enter = viewHarness(400); enter.key('Enter'); assert.equal(enter.run(), undefined);
  const plain = viewHarness(); plain.key('Enter'); assert.equal(plain.changes.length, 0);
  const dbl = viewHarness(400); dbl.handle.handlers.get('dblclick')({ preventDefault() {}, stopPropagation() {} }); assert.equal(dbl.run(), undefined);
  assert.equal(h.key('a'), false);
});
