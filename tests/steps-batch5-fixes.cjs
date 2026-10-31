// UI batch 5 fixes: G-2 (ticket 43) a pointerdown on a frame's label chip must not start a canvas pan, or the
// chip's double-click never fires (the pan captures the pointer and retargets the click to the viewport).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, DEFAULT_SETTINGS, obsidian } = require('./support.cjs');

const panView = () => {
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const plugin = { settings: { ...DEFAULT_SETTINGS }, pendingSuggestions: new Map(), expansionBatches: new Map(), detailsShown: () => false };
  const view = new VisualAgentMapView({ app: {} }, plugin);
  const handlers = new Map();
  const captured = [];
  const classes = new Set();
  view.viewportEl = {
    handlers, clientWidth: 800, clientHeight: 600,
    addEventListener(name, fn) { handlers.set(name, fn); }, removeEventListener(name) { handlers.delete(name); },
    setPointerCapture(id) { captured.push(id); }, releasePointerCapture() {},
    addClass(c) { classes.add(c); }, removeClass(c) { classes.delete(c); }, hasClass: c => classes.has(c),
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 800, bottom: 600 })
  };
  view.map = { id: 'm', nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  view.transform = () => {}; view.saveViewport = () => {};
  view.setupPan();
  const down = target => handlers.get('pointerdown')({ target, button: 0, clientX: 10, clientY: 10, pointerId: 7, altKey: false, shiftKey: false, preventDefault() {} });
  return { captured, classes, down };
};
const on = selector => ({ closest: s => (s === selector ? {} : null) });

test('G-2: a pointerdown on a frame label chip does not start a pan; bare canvas still pans', () => {
  const { captured, classes, down } = panView();
  down(on('.vam-boundary-label'));
  assert.deepEqual(captured, [], 'no pointer capture from the label chip');
  assert.equal(classes.has('is-panning'), false);
  down({ closest: () => null });
  assert.deepEqual(captured, [7], 'a pointerdown elsewhere on the canvas still pans');
});
