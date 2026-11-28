// A10: "Tidy map" / "Tidy branch" show the result first. The pure part: the preview is a position diff of a copy,
// equal to what arrangeMap / arrangeNewBranch would write; the input map is never touched.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./support-replay.cjs');
const layout = load('map-layout.ts');
const preview = load('experiences/visual-map/layout-preview.ts');

const DIRECTIONS = ['right', 'left', 'down', 'up', 'balanced', 'radial', 'timeline', 'fishbone'];
const node = (id, parentId = null, extra = {}) => ({ id, parentId, path: `${id}.md`, x: 7, y: 9, collapsed: false, ...extra });
const tree = () => [
  node('root', null, { x: 80, y: 80 }),
  node('a', 'root'), node('b', 'root'), node('c', 'root'),
  node('a1', 'a'), node('a2', 'a'), node('b1', 'b'), node('folded', 'c', { collapsed: true }), node('hid', 'folded')
];
const mapOf = (direction, nodes = tree()) => ({ id: 'm', title: 'M', version: 1, nodes, viewport: { x: 0, y: 0, zoom: 1 }, ...(direction === 'right' ? {} : { layout: { direction } }) });
const snap = list => list.map(item => [item.id, item.x, item.y]);
const arrangeAll = map => { map.nodes = layout.arrangeMap(map.nodes, undefined, undefined, layout.layoutOf(map)); };

for (const direction of DIRECTIONS) {
  test(`A10: ${direction}: tidy-map preview equals arrangeMap and leaves the input alone`, () => {
    const map = mapOf(direction);
    const before = JSON.stringify(map);
    const result = preview.computeTidy(map, arrangeAll);
    assert.equal(JSON.stringify(map), before);
    const expected = mapOf(direction);
    arrangeAll(expected);
    const applied = JSON.parse(before).nodes;
    for (const [id, position] of result.positions) Object.assign(applied.find(item => item.id === id), position);
    assert.deepEqual(snap(applied), snap(expected.nodes));
    for (const [id, position] of result.positions) {
      const was = map.nodes.find(item => item.id === id);
      assert.ok(was.x !== position.x || was.y !== position.y, 'only moved cards are listed');
    }
    // N counts shown cards only (the folded branch's hidden card is not a card on the canvas).
    assert.equal(result.count, [...result.positions.keys()].filter(id => id !== 'hid').length);
  });
  test(`A10: ${direction}: applying the same arrange to the map writes exactly the preview`, () => {
    const map = mapOf(direction);
    const result = preview.computeTidy(map, arrangeAll);
    arrangeAll(map);
    for (const [id, position] of result.positions) {
      const now = map.nodes.find(item => item.id === id);
      assert.deepEqual([now.x, now.y], [position.x, position.y]);
    }
  });
}

test('A10: a tidy branch preview only lists the branch cards (none outside move)', () => {
  const nodes = [node('root', null, { x: 80, y: 80 }), node('a', 'root', { x: 440, y: 0 }), node('b', 'root', { x: 440, y: 400 }),
    node('a1', 'a', { x: 800, y: 3 }), node('a2', 'a', { x: 800, y: 4 })];
  const map = mapOf('right', nodes);
  const branch = m => { m.nodes = layout.arrangeNewBranch(m.nodes, 'a', new Set(['a1', 'a2']), undefined, undefined, layout.layoutOf(m)); };
  const before = JSON.stringify(map);
  const result = preview.computeTidy(map, branch);
  assert.equal(JSON.stringify(map), before);
  assert.ok(result.positions.size > 0);
  for (const id of result.positions.keys()) assert.ok(['a1', 'a2'].includes(id), `${id} moved outside the branch`);
});

test('A10: nothing to move -> empty preview; a signature changes with any edit (cancel/stale detection)', () => {
  const map = mapOf('right');
  arrangeAll(map);
  const result = preview.computeTidy(map, arrangeAll);
  assert.equal(result.count, 0);
  const sig = preview.mapSignature(map);
  assert.equal(preview.mapSignature(JSON.parse(JSON.stringify(map))), sig);
  map.nodes[1].x += 1;
  assert.notEqual(preview.mapSignature(map), sig);
});

test('A10: a card the preview does not know keeps its own position; shown() overlays only listed ids', () => {
  const nodes = [node('r', null, { x: 1, y: 2 }), node('k', 'r', { x: 3, y: 4 })];
  const out = preview.overlayPositions(nodes, new Map([['k', { x: 30, y: 40 }]]));
  assert.deepEqual(snap(out), [['r', 1, 2], ['k', 30, 40]]);
  assert.deepEqual(snap(nodes), [['r', 1, 2], ['k', 3, 4]]);
});

// A10 review: the view clears the preview on any map change, leaves Esc inside inputs alone, and ignores Enter with nothing to move.
const S = require('./support.cjs');
const dom = require('./support-dom.cjs');
const doc = { activeElement: null };
const { VisualAgentMapView } = load(
  'experiences/visual-map/view.ts',
  { obsidian: { ...S.obsidian, Component: class {}, MarkdownRenderChild: class {} } },
  { activeDocument: doc, window: { setTimeout, clearTimeout }, CSS: { escape: s => s }, createDiv: o => dom.element('div', o), createEl: (tag, o) => dom.element(tag, o) }
);
function tidyView(moves) {
  const view = Object.create(VisualAgentMapView.prototype);
  const listeners = [];
  view.contentEl = { contains: () => true, addEventListener: (_t, fn) => listeners.push(fn), removeEventListener: (_t, fn) => listeners.splice(listeners.indexOf(fn), 1) };
  view.contentEl.querySelector = () => null;
  view.selection = { state: { selected: null } };
  view.map = mapOf('right');
  view.presentation = false;
  view.notesLoading = () => false;
  view.render = () => {};
  view.closed = false;
  view.tidyArrange = copy => { if (moves) copy.nodes[1].x += 50; };
  view.applied = 0;
  view.applyTidy = () => { view.applied++; };
  view.openTidyPreview();
  return { view, listeners };
}
const key = (k, target) => { const ev = { key: k, target, isComposing: false, stopped: false, prevented: false }; ev.stopPropagation = () => { ev.stopped = true; }; ev.preventDefault = () => { ev.prevented = true; }; return ev; };
const inInput = tag => ({ closest: sel => (sel.includes(tag) ? {} : null) });
const plain = { closest: () => null };

test('A10 review: any mapChange (title, summary, cover) clears the preview, not only moves', async () => {
  const { view } = tidyView(true);
  assert.ok(view.tidy);
  view.beginMapTransaction = () => { throw new Error('stop'); };
  await view.mapChange(map => { map.title = 'renamed'; }).catch(() => {});
  assert.equal(view.tidy, null);
});

test('A10 review: Esc inside an input is not intercepted; Esc elsewhere cancels the preview', () => {
  const { view, listeners } = tidyView(true);
  const inside = key('Escape', inInput('input'));
  listeners[0](inside);
  assert.equal(inside.stopped, false);
  assert.equal(inside.prevented, false);
  assert.ok(view.tidy);
  const composing = key('Escape', plain);
  composing.isComposing = true;
  listeners[0](composing);
  assert.ok(view.tidy);
  const outside = key('Escape', plain);
  listeners[0](outside);
  assert.equal(outside.stopped, true);
  assert.equal(view.tidy, null);
});

test('A10 batch UI: Esc on the focused Apply button cancels the preview (a button is not a text field)', () => {
  const { view, listeners } = tidyView(true);
  const onButton = key('Escape', inInput('button'));
  listeners[0](onButton);
  assert.equal(onButton.stopped, true);
  assert.equal(view.tidy, null);
});

test('A10 review: Enter with an empty preview does not apply', () => {
  const { view, listeners } = tidyView(false);
  assert.equal(view.tidy.positions.size, 0);
  listeners[0](key('Enter', plain));
  assert.equal(view.applied, 0);
  const moving = tidyView(true);
  moving.listeners[0](key('Enter', plain));
  assert.equal(moving.view.applied, 1);
});

test('A10 focus: closing the preview gives focus back to what had it; a removed element falls back to the viewport', () => {
  const focusable = () => { const el = { isConnected: true, calls: 0, focus() { this.calls++; } }; return el; };
  const card = focusable();
  doc.activeElement = card;
  const a = tidyView(true);
  a.view.viewportEl = focusable();
  a.listeners[0](key('Escape', plain));
  assert.equal(card.calls, 1);
  assert.equal(a.view.viewportEl.calls, 0);
  const gone = focusable();
  doc.activeElement = gone;
  const b = tidyView(true);
  b.view.viewportEl = focusable();
  gone.isConnected = false;
  b.listeners[0](key('Escape', plain));
  assert.equal(gone.calls, 0);
  assert.equal(b.view.viewportEl.calls, 1);
  doc.activeElement = null;
});

// A10 batch UI (2): a repaint replaces the elements, and a removed element loses the focus (as in a real document).
function focusWorld() {
  const world = { live: new Map(), focused: null, log: [] };
  world.make = (key, extra = {}) => {
    const el = { key, isConnected: true, ...extra, focus() { if (!this.isConnected) return; world.focused = this; world.log.push(key); } };
    world.live.set(key, el);
    return el;
  };
  world.repaint = () => { for (const el of world.live.values()) el.isConnected = false; world.live = new Map(); for (const k of world.keys) world.make(k); if (world.focused && !world.focused.isConnected) world.focused = null; };
  world.keys = [];
  world.active = () => (world.focused && world.focused.isConnected ? world.focused : null);
  return world;
}
function focusView(world, selected) {
  const sel = k => world.live.get(k) ?? null;
  const out = tidyView(true);
  const view = out.view;
  view.contentEl.querySelector = selector => sel(selector);
  view.selection = { state: { selected } };
  view.viewportEl = { focus() { world.log.push('viewport'); } };
  view.render = () => world.repaint();
  return out;
}

test('A10 batch UI: Esc after a repaint focuses the new element with the same key (card more button, toolbar more button)', () => {
  for (const key of ['[data-node-id="a"] .vam-card-tool-more', '.vam-map-actions-button']) {
    const world = focusWorld();
    world.keys = [key];
    const old = world.make(key);
    world.focused = old;
    doc.activeElement = old;
    const { view, listeners } = focusView(world, 'a');
    view.tidyReturnFocus = { el: old, key };
    listeners[0](key_('Escape'));
    assert.equal(world.active()?.key, key);
    assert.notEqual(world.active(), old);
  }
  doc.activeElement = null;
});

function key_(k) { const ev = { key: k, target: { closest: () => null }, isComposing: false }; ev.stopPropagation = () => {}; ev.preventDefault = () => {}; return ev; }

test('A10 batch UI: Apply gives focus back only after the queued mapChange (and its repaint) finished', async () => {
  const world = focusWorld();
  const k = '.vam-map-actions-button';
  world.keys = [k];
  const old = world.make(k);
  world.focused = old;
  const { view } = focusView(world, null);
  view.tidyReturnFocus = { el: old, key: k };
  view.tidy = { positions: new Map([['a', { x: 1, y: 1 }]]), count: 1, branchId: undefined, mapId: view.map.id, signature: require('./support-replay.cjs').load('experiences/visual-map/layout-preview.ts').mapSignature(view.map) };
  delete view.applyTidy;
  view.applyTidy = VisualAgentMapView.prototype.applyTidy;
  let release;
  view.mapChange = () => new Promise(res => { release = () => { world.repaint(); res(); }; });
  let queued;
  view.enqueue = work => { queued = work(); };
  view.applyTidy();
  assert.equal(world.log.length, 0, 'no focus before the mapChange finished');
  release();
  await queued;
  assert.equal(world.active()?.key, k);
  assert.equal(world.log.at(-1), k);
});

test('A10 batch UI: a key that cannot be found falls back to the selected card, then the viewport', () => {
  const world = focusWorld();
  world.keys = ['[data-node-id="s"]'];
  world.make('[data-node-id="s"]');
  const gone = world.make('x'); gone.isConnected = false;
  const a = focusView(world, 's');
  a.view.restoreTidyFocus({ el: gone, key: '.nothing' });
  assert.equal(world.log.at(-1), '[data-node-id="s"]');
  world.live = new Map();
  a.view.restoreTidyFocus({ el: gone, key: '.nothing' });
  assert.equal(world.log.at(-1), 'viewport');
});
