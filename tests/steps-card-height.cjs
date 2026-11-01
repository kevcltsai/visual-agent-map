// Card height (ticket card-height): the height data contract, share payload and viewer, view handles and export.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { load } = require('./support-replay.cjs');
const core = load('map-model.ts');
const graph = load('map-graph.ts');

const root = path.join(__dirname, '..');
const node = (id, parentId = null, extra = {}) => ({ id, parentId, path: `${id}.md`, x: 0, y: 0, collapsed: false, ...extra });
const doc = nodes => ({ version: 1, id: 'm', title: 'M', nodes, viewport: { x: 0, y: 0, zoom: 1 } });
const roundTrip = nodes => core.parseMap(core.serializeMap(doc(nodes))).nodes;
const heights = nodes => JSON.stringify(nodes.map(item => item.height ?? null));

test('card height constants and clamp', () => {
  assert.deepEqual([graph.CARD_HEIGHT_MIN, graph.CARD_HEIGHT_MAX, graph.CARD_HEIGHT_STEP], [80, 720, 40]);
  assert.equal(graph.clampCardHeight(50), 80);
  assert.equal(graph.clampCardHeight(9999), 720);
  assert.equal(graph.clampCardHeight(320.4), 320);
  assert.equal(graph.clampCardHeight('320'), undefined);
  assert.equal(graph.clampCardHeight(NaN), undefined);
  assert.equal(graph.clampCardHeight(Infinity), undefined);
  assert.equal(graph.clampCardHeight(null), undefined);
});

test('A1 height survives a round trip and parse cleans it; there is no default to drop', () => {
  const back = roundTrip([
    node('a', null, { height: 320 }), node('b', 'a', { height: 'tall' }), node('c', 'a', { height: 50 }), node('d', 'a', { height: 9999 }),
    node('e', 'a', { height: 333.6 }), node('f', 'a', { height: NaN }), node('g', 'a', { height: Infinity }), node('h', 'a', { height: 280 }), node('i', 'a')
  ]);
  assert.equal(heights(back), JSON.stringify([320, null, 80, 720, 334, null, null, 280, null]));
  for (const i of [1, 5, 6, 8]) assert.equal('height' in back[i], false);
  const both = roundTrip([node('a', null, { width: 400, height: 240 })])[0];
  assert.deepEqual([both.width, both.height], [400, 240]);
});

test('A1 a map without height is byte-identical after parse and serialize', () => {
  const text = core.serializeMap(doc([node('a'), node('b', 'a', { x: 360, y: 10, width: 400 })]));
  assert.equal(core.serializeMap(core.parseMap(text)), text);
  assert.equal(text.includes('height'), false);
});

test('A2 an older plugin (plain JSON read and write, no field whitelist) keeps height', () => {
  const text = core.serializeMap(doc([node('a', null, { height: 320 })]));
  const block = text.match(/```agent-map\n([\s\S]*?)\n```/)[1];
  const again = JSON.stringify(JSON.parse(block), null, 2);
  assert.equal(again, block);
  assert.equal(JSON.parse(again).nodes[0].height, 320);
});

test('A1 map-graph.ts still has no import and the viewer shares the height helpers', () => {
  const source = fs.readFileSync(path.join(root, 'map-graph.ts'), 'utf8');
  assert.equal((source.match(/^import/gm) || []).length, 0);
});

const viewerSource = () => fs.readFileSync(path.join(root, 'experiences', 'sharing', 'viewer', 'main.ts'), 'utf8');
const styles = () => fs.readFileSync(path.join(root, 'styles.css'), 'utf8');

test('A4 the viewer cleans the height, applies it in place() and marks clipped cards after layout', () => {
  const source = viewerSource();
  assert.match(source, /clampCardHeight\(item\.height\)/);
  assert.match(source, /card\.style\.height = `\$\{node\.height\}px`/);
  assert.match(source, /scrollHeight > card\.clientHeight/);
  assert.match(source, /vam-card-fade/);
  assert.match(source, /vam-card-more/);
});

test('A4 the clip rules are in the viewer stylesheet and keep the handles, scan line and shapes visible', () => {
  const bundle = load('experiences/sharing/viewer-bundle.generated.ts');
  const css = bundle.SHARE_VIEWER_CSS;
  assert.ok(css.includes('.vam-node.is-clipped { overflow: hidden; }'));
  assert.ok(css.includes('.vam-node.is-clipped > .vam-card-resize { right: 0; }'), 'the width handle moves inside the border while clipped');
  assert.ok(css.includes('.vam-node.is-clipped > .vam-card-fade'));
  assert.ok(css.includes('.vam-node.is-clipped > .vam-card-more'));
  const own = styles();
  // Obsidian's review rejects clip-path (scripts/check-css.mjs): the clip is overflow: hidden, so what sits on or past the border must move inside it while clipped.
  assert.doesNotMatch(own, /clip-path\s*:/);
  assert.ok(own.includes('.vam-node.is-clipped:not([data-aim-kind])[data-status="running"]::after { top: 0; }'), 'the scan line stays visible');
  assert.ok(own.includes('[data-topic-kind="hypothesis"].vam-node.is-clipped > .vam-kind-shape'), 'the shape outline stays visible');
  assert.equal(css.includes('.vam-kind-shape'), false, 'the viewer stylesheet carries no shape rule');
  assert.match(own, /\.vam-card-resize \{[^}]*right: -5px/, 'the unclipped width handle is unchanged');
});

// ---- View: heights of cards not drawn yet (A3) ---------------------------------------------------------------------------
const support = require('./support.cjs');
const layout = load('map-layout.ts');
const { VisualAgentMapView } = support.load('main.ts', { obsidian: support.obsidian });
const newView = nodes => {
  const view = new VisualAgentMapView({ app: {} }, { settings: { ...support.DEFAULT_SETTINGS }, pendingSuggestions: new Map(), expansionBatches: new Map(), detailsShown: () => false, setOutlineActive() {} });
  view.map = support.map(nodes);
  view.enqueue = work => work();
  view.clearHoverTimer = () => {};
  return view;
};

test('A3 cardHeightOf: a drawn card reports its height, an undrawn one with a height reports it, otherwise the median', () => {
  const nodes = [Object.assign(support.node('a', null), { height: 320 }), support.node('b', 'a'), support.node('c', 'a')];
  const view = newView(nodes);
  assert.equal(view.cardHeightOf('a'), 320, 'undrawn with height');
  assert.equal(view.cardHeightOf('b'), undefined, 'nothing drawn and no height: undefined');
  view.cardEls = new Map([['b', { offsetHeight: 140 }], ['c', { offsetHeight: 100 }]]);
  assert.equal(view.cardHeightOf('b'), 140, 'drawn');
  assert.equal(view.cardHeightOf('a'), 320, 'undrawn with height beats the median');
  view.cardEls.set('a', { offsetHeight: 200 });
  assert.equal(view.cardHeightOf('a'), 200, 'drawn wins over the field');
  view.cardEls.delete('a');
  nodes.push(support.node('d', 'a'));
  assert.ok(view.cardHeightOf('d') > 0, 'neither: the median of the drawn cards');
});

test('A3 arrangeMap and arrangeNewBranch leave room for a set height', () => {
  const mk = height => [support.node('r', null), Object.assign(support.node('a', 'r'), height ? { height } : {}), support.node('b', 'r')];
  const gapOf = height => { const view = newView(mk(height)); const placed = Object.fromEntries(layout.arrangeMap(view.map.nodes, undefined, view.cardHeightOf, 'right').map(n => [n.id, n])); return Math.abs(placed.b.y - placed.a.y); };
  assert.ok(gapOf(640) > gapOf(undefined), 'a tall card pushes its sibling away');
  const base = height => { const view = newView(mk(height)); view.cardEls = new Map([['r', { offsetHeight: 100 }], ['b', { offsetHeight: 100 }]]); return Object.fromEntries(layout.arrangeNewBranch(view.map.nodes, 'r', new Set(['a', 'b']), view.cardHeightOf, undefined, 'right').map(n => [n.id, n])); };
  const tall = base(640), plain = base(undefined);
  assert.ok(Math.abs(tall.b.y - tall.a.y) > Math.abs(plain.b.y - plain.a.y));
});

// ---- View: the height handle and the corner handle (A5, A6) --------------------------------------------------------------
const harness = (initial = {}) => {
  const nodes = [Object.assign(support.node('a', null), initial.width ? { width: initial.width } : {}, initial.height ? { height: initial.height } : {})];
  const view = newView(nodes);
  const doc = view.map;
  const makeHandle = () => { const attrs = {}, handlers = new Map(); return { attrs, handlers, tabIndex: 0, setAttr(name, value) { attrs[name] = value; }, setAttribute(name, value) { attrs[name] = value; }, addEventListener(name, fn) { handlers.set(name, fn); }, removeEventListener(name) { handlers.delete(name); }, setPointerCapture() {} }; };
  const handles = {};
  const classes = new Set();
  const style = { removeProperty(name) { delete style[name]; } };
  if (initial.width) style.width = `${initial.width}px`;
  if (initial.height) style.height = `${initial.height}px`;
  const card = { style, offsetHeight: initial.offset ?? 150, scrollHeight: initial.scroll ?? 150, clientHeight: initial.client ?? 150, dataset: { nodeId: 'a' }, toggleClass(name, on) { on ? classes.add(name) : classes.delete(name); },
    querySelector: () => null, createSpan(opts) { const handle = makeHandle(); Object.assign(handle.attrs, opts.attr ?? {}); handle.cls = opts.cls; handles[opts.cls] = handle; return handle; } };
  const changes = [];
  view.mapChange = async change => { changes.push(change); };
  view.attachHeightHandle(card, nodes[0]);
  view.attachCornerHandle(card, nodes[0]);
  const run = () => { const copy = JSON.parse(JSON.stringify(doc)); changes.splice(0).forEach(change => change(copy)); return copy.nodes[0]; };
  const y = handles['vam-card-resize-y'], corner = handles['vam-card-resize-corner'];
  const key = k => { let prevented = false; y.handlers.get('keydown')({ key: k, preventDefault() { prevented = true; }, stopPropagation() {} }); return prevented; };
  const pointer = (handle, name, x, yy) => handle.handlers.get(name)?.({ button: 0, pointerId: 1, clientX: x, clientY: yy, preventDefault() {}, stopPropagation() {} });
  return { view, doc, nodes, card, classes, y, corner, changes, run, key, pointer, handles };
};

test('A5 the bottom handle is a horizontal separator with range and value; an unset height reads the real height when used', () => {
  const h = harness({ height: 320 });
  assert.deepEqual({ ...h.y.attrs }, { role: 'separator', 'aria-orientation': 'horizontal', 'aria-label': 'Card height', 'aria-valuemin': '80', 'aria-valuemax': '720', 'aria-valuenow': '320' });
  assert.equal(h.y.tabIndex, -1);
  const plain = harness({ offset: 0 });
  assert.equal('aria-valuenow' in plain.y.attrs, false, 'a card that is not laid out has no value yet');
  plain.card.offsetHeight = 123.4;
  plain.y.handlers.get('focus')();
  assert.equal(plain.y.attrs['aria-valuenow'], '123');
  const small = harness({ offset: 40 });
  assert.equal(small.y.attrs['aria-valuenow'], '80', 'clamped into the range');
  const tall = harness({ offset: 2000 });
  assert.equal(tall.y.attrs['aria-valuenow'], '720');
});

test('A5 a vertical drag writes once on release, respects zoom, and one change carries only the height', () => {
  const h = harness({ height: 200 });
  h.pointer(h.y, 'pointerdown', 0, 100);
  h.pointer(h.y, 'pointermove', 0, 180);
  h.pointer(h.y, 'pointermove', 0, 220);
  assert.equal(h.card.style.height, '320px');
  assert.equal(h.changes.length, 0);
  h.pointer(h.y, 'pointerup', 0, 220);
  assert.equal(h.changes.length, 1);
  const node = h.run();
  assert.deepEqual([node.height, 'width' in node], [320, false]);
  const z = harness({ height: 200 }); z.doc.viewport.zoom = 2;
  z.pointer(z.y, 'pointerdown', 0, 0); z.pointer(z.y, 'pointermove', 0, 80); z.pointer(z.y, 'pointerup', 0, 80);
  assert.equal(z.run().height, 240);
  const hi = harness({ height: 200 });
  hi.pointer(hi.y, 'pointerdown', 0, 0); hi.pointer(hi.y, 'pointermove', 0, 9000); hi.pointer(hi.y, 'pointerup', 0, 9000);
  assert.equal(hi.run().height, 720);
  const lo = harness({ height: 200 });
  lo.pointer(lo.y, 'pointerdown', 0, 0); lo.pointer(lo.y, 'pointermove', 0, -9000); lo.pointer(lo.y, 'pointerup', 0, -9000);
  assert.equal(lo.run().height, 80);
});

test('A5 a cancelled or zero-length drag writes nothing and restores the card', () => {
  const set = harness({ height: 320 });
  set.pointer(set.y, 'pointerdown', 0, 0); set.pointer(set.y, 'pointermove', 0, 100); set.pointer(set.y, 'pointercancel', 0, 100);
  assert.equal(set.card.style.height, '320px');
  set.pointer(set.y, 'pointerdown', 0, 0); set.pointer(set.y, 'pointerup', 0, 0);
  assert.equal(set.changes.length, 0);
  const unset = harness();
  unset.pointer(unset.y, 'pointerdown', 0, 0); unset.pointer(unset.y, 'pointermove', 0, 100); unset.pointer(unset.y, 'pointercancel', 0, 100);
  assert.equal('height' in unset.card.style, false, 'an unset card goes back to its content height');
  unset.pointer(unset.y, 'pointerdown', 0, 0); unset.pointer(unset.y, 'pointerup', 0, 0);
  assert.equal(unset.changes.length, 0);
  assert.equal('height' in unset.card.style, false);
});

test('A5 dragging an unset card starts from its real height and marks it clipped when the text does not fit', () => {
  const h = harness({ offset: 150, scroll: 150, client: 150 });
  h.pointer(h.y, 'pointerdown', 0, 0);
  h.card.scrollHeight = 150; h.card.clientHeight = 100;
  h.pointer(h.y, 'pointermove', 0, -50);
  assert.equal(h.card.style.height, '100px');
  assert.equal(h.classes.has('is-clipped'), true);
  h.pointer(h.y, 'pointerup', 0, -50);
  assert.equal(h.run().height, 100);
});

test('A5 keyboard: Up/Down are one change per press from the real height; Home/End; Enter and double click reset; limits write nothing', () => {
  const h = harness({ height: 320 });
  assert.equal(h.key('ArrowDown'), true);
  assert.equal(h.run().height, 360);
  assert.equal(h.changes.length, 0);
  h.key('ArrowUp'); assert.equal(h.run().height, 280);
  const unset = harness({ offset: 150 });
  unset.key('ArrowDown'); assert.equal(unset.run().height, 190, 'an unset card starts from its real height');
  const lo = harness({ height: 80 }); lo.key('ArrowUp'); assert.equal(lo.changes.length, 0);
  lo.key('Home'); assert.equal(lo.changes.length, 0);
  const hi = harness({ height: 720 }); hi.key('ArrowDown'); assert.equal(hi.changes.length, 0);
  hi.key('End'); assert.equal(hi.changes.length, 0);
  const home = harness({ height: 300 }); home.key('Home'); assert.equal(home.run().height, 80);
  const end = harness({ height: 300 }); end.key('End'); assert.equal(end.run().height, 720);
  const enter = harness({ height: 300 }); enter.key('Enter'); assert.equal('height' in enter.run(), false);
  const plain = harness(); plain.key('Enter'); assert.equal(plain.changes.length, 0);
  const dbl = harness({ height: 300 }); dbl.y.handlers.get('dblclick')({ preventDefault() {}, stopPropagation() {} }); assert.equal('height' in dbl.run(), false);
  const none = harness(); none.y.handlers.get('dblclick')({ preventDefault() {}, stopPropagation() {} }); assert.equal(none.changes.length, 0);
  assert.equal(h.key('a'), false);
});

test('A5 after a height change the focus goes back to the height handle, after a width change to the width handle', () => {
  const h = harness({ height: 320 });
  h.key('ArrowDown');
  assert.deepEqual([h.view.focusResizeNodeId, h.view.focusResizeAxis], ['a', 'height']);
  const source = require('node:fs').readFileSync(path.join(root, 'experiences', 'visual-map', 'view.ts'), 'utf8');
  assert.match(source, /vam-card-resize-y" : "vam-card-resize"/);
  assert.match(source, /button, \.vam-card-resize, \.vam-card-resize-y/);
  assert.equal(/vam-card-resize-corner"[^;]*toolButtons/.test(source), false);
});

test('A6 the corner drag changes width and height together and writes once; a horizontal-only drag never writes a height', () => {
  const h = harness();
  h.pointer(h.corner, 'pointerdown', 0, 0);
  h.pointer(h.corner, 'pointermove', 120, 90);
  assert.equal(h.card.style.width, '400px');
  assert.equal(h.card.style.height, '240px');
  assert.equal(h.changes.length, 0);
  h.pointer(h.corner, 'pointerup', 120, 90);
  assert.equal(h.changes.length, 1);
  const both = h.run();
  assert.deepEqual([both.width, both.height], [400, 240]);
  const side = harness();
  side.pointer(side.corner, 'pointerdown', 0, 0); side.pointer(side.corner, 'pointermove', 120, 0); side.pointer(side.corner, 'pointerup', 120, 0);
  const sideNode = side.run();
  assert.deepEqual([sideNode.width, 'height' in sideNode], [400, false]);
  assert.equal('height' in side.card.style, false, 'the card did not jump to a set height during the drag');
  const down = harness();
  down.pointer(down.corner, 'pointerdown', 0, 0); down.pointer(down.corner, 'pointermove', 0, 50); down.pointer(down.corner, 'pointerup', 0, 50);
  const downNode = down.run();
  assert.deepEqual(['width' in downNode, downNode.height], [false, 200]);
});

test('A6 corner: back to 280 removes the width; cancel and zero drag write nothing; one undo step covers both', () => {
  const back = harness({ width: 400, height: 240 });
  back.pointer(back.corner, 'pointerdown', 0, 0); back.pointer(back.corner, 'pointermove', -120, 0); back.pointer(back.corner, 'pointerup', -120, 0);
  assert.equal(back.changes.length, 1, 'one mapChange');
  const node = back.run();
  assert.deepEqual(['width' in node, node.height], [false, 240]);
  const cancel = harness({ width: 400, height: 240 });
  cancel.pointer(cancel.corner, 'pointerdown', 0, 0); cancel.pointer(cancel.corner, 'pointermove', 50, 50); cancel.pointer(cancel.corner, 'pointercancel', 50, 50);
  assert.deepEqual([cancel.card.style.width, cancel.card.style.height], ['400px', '240px']);
  cancel.pointer(cancel.corner, 'pointerdown', 0, 0); cancel.pointer(cancel.corner, 'pointerup', 0, 0);
  assert.equal(cancel.changes.length, 0);
});

test('A6 corner double click clears both fields in one change, and writes nothing when neither is set', () => {
  const h = harness({ width: 400, height: 240 });
  h.corner.handlers.get('dblclick')({ preventDefault() {}, stopPropagation() {} });
  assert.equal(h.changes.length, 1);
  const node = h.run();
  assert.deepEqual(['width' in node, 'height' in node], [false, false]);
  const none = harness();
  none.corner.handlers.get('dblclick')({ preventDefault() {}, stopPropagation() {} });
  assert.equal(none.changes.length, 0);
});

test('A6 the corner handle is hidden from assistive tech and not a tab stop; the three handles are built only for plain cards', () => {
  const h = harness();
  assert.equal(h.corner.attrs['aria-hidden'], 'true');
  assert.equal(h.corner.attrs.role, undefined);
  const source = require('node:fs').readFileSync(path.join(root, 'experiences', 'visual-map', 'view.ts'), 'utf8');
  assert.match(source, /!this\.integrationMode && !this\.presentation && !this\.map\?\.aim && !node\.aimKind\) \{\s*this\.attachResizeHandle\(card, node\);\s*this\.attachHeightHandle\(card, node\);\s*this\.attachCornerHandle\(card, node\);/);
});
