// Characterization matrix for the floating controls (toolbar, sources panel, zoom bar, canvas hint, status bar, overlay
// chat). It drives the real view members (placeMapTools -> layoutTopStack / sourcesRoom / bottomLimit, and
// syncStatusBarClearance) over fake measured rects and locks the written
// positions, limits and clearances. Product code is not changed by this file: the expected tables record today's results.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const support = require('./support.cjs');
const { obsidian } = support;
const { load } = require('./support-replay.cjs');

const rect = (left, top, right, bottom) => ({ left, top, right, bottom, width: right - left, height: bottom - top });
function el(name, r, extra = {}) {
  const props = {}; const classes = new Set(extra.classes || []);
  return Object.assign({
    name, isConnected: true, style: {
      setProperty(k, v) { props[k] = v; }, removeProperty(k) { delete props[k]; }
    }, props, classes,
    getBoundingClientRect: () => r, toggleClass(c, on) { on ? classes.add(c) : classes.delete(c); },
    hasClass: c => classes.has(c), addClass: c => classes.add(c), removeClass: c => classes.delete(c),
    insertBefore() {}, contains: () => false, querySelectorAll: () => [], clientTop: 0, clientLeft: 0
  }, extra);
}

const { VisualAgentMapView } = load('experiences/visual-map/view.ts', { obsidian: { ...obsidian, Component: class {}, MarkdownRenderChild: class {} } }, { window: { setTimeout, clearTimeout }, CSS: { escape: s => s } });

// Geometry is synthetic but internally consistent (all rects in screen coordinates). One scenario = the measured world. `w` x `h` is the pane; the canvas starts 100px under the pane top (the view header row).
function run(s, passes = 1) {
  // The toolbar row is above the canvas (the canvas starts at its bottom, 48px).
  const w = s.w, h = s.h, top = 48, cl = s.statusBar ? 22 : 0;
  const canvas = rect(s.chat === 'overlay' || !s.chat ? 0 : (s.chat === 'docked' ? 320 : 0), top, w, top + h);
  const nodes = {};
  const view = Object.create(VisualAgentMapView.prototype);
  const narrow = w < 700;
  const toolsH = narrow ? 88 : 38;
  const toolsLeft = (s.chat === 'overlay' ? 320 - 44 + 12 : 0) + 12;
  const toolbar = el('toolbar', rect(0, 0, w, top));
  const toolsRect = rect(canvas.left + toolsLeft, top + 12, canvas.left + toolsLeft + (narrow ? 150 : 300), top + 12 + toolsH);
  nodes['.vam-map-tools'] = el('tools', toolsRect);
  const overlay = el('overlay', canvas, { clientHeight: h, parentElement: null });
  nodes['.vam-canvas-overlay'] = overlay;
  nodes['.vam-map-tools'].parentElement = overlay;
  nodes['.vam-toolbar'] = toolbar;
  nodes['.vam-zoom-controls'] = el('zoom', rect(w - 150, top + h - 44 - cl, w - 12, top + h - 12 - cl));
  nodes['.vam-canvas-hint'] = el('hint', rect(12, top + h - 32 - cl, 260, top + h - 12 - cl));
  if (s.chat === 'overlay') nodes['.vam-map-chat.is-overlay'] = el('chat-overlay', rect(0, top, 320, top + h));
  let sources = null;
  if (s.sources) { sources = el('sources', rect(canvas.left + toolsLeft, top + 12 + toolsH, canvas.left + toolsLeft + 260, top + h - 60)); }
  const statusBar = s.statusBar ? el('status-bar', rect(w - 140, top + h - 22, w, top + h)) : null;
  const chatEl = el('chat', rect(0, top, 320, top + h));
  const canvasEl = el('canvas', canvas);
  const contentEl = {
    ownerDocument: { querySelector: sel => (sel === '.status-bar' ? statusBar : null), defaultView: {} },
    querySelector: sel => {
      if (sel === '.vam-canvas') return canvasEl;
      if (sel === '.vam-map-chat') return s.chat ? chatEl : null;
      return nodes[sel] ?? null;
    }
  };
  Object.assign(view, {
    contentEl, containerEl: null, viewportEl: el('viewport', canvas), closed: false, toolPlacementObserved: [], toolPlacementObserver: null,
    statusBarObserved: null, statusBarObserver: null,
    chat: s.chat === 'overlay' ? { isOverlay: true, overlayWidth: 320 } : (s.chat ? { isOverlay: false } : null),
    mapSourcesControl: { mapSourcesPanelEl: sources, placeMapSourcesPanel: () => { view.__placed = (view.__placed || 0) + 1; } }
  });
  for (let i = 0; i < passes; i++) view.syncStatusBarClearance();
  const out = {
    toolsLeft: nodes['.vam-map-tools']?.style.left ?? null,
    hasPanel: nodes['.vam-map-tools']?.classes.has('has-panel') ?? null,
    sourcesMax: sources?.props['--vam-sources-max'] ?? null,
    sourcesPlaced: sources ? view.__placed ?? 0 : null,
    canvasClear: canvasEl.props['--vam-status-clearance'] ?? null,
    chatClear: s.chat ? chatEl.props['--vam-status-clearance'] ?? null : null
  };
  return out;
}
module.exports = { run };

const WIDE = { w: 1280, h: 700 }, NARROW = { w: 360, h: 700 };
const SCENARIOS = {
  'wide': { ...WIDE },
  'wide, status bar over canvas': { ...WIDE, statusBar: true },
  'wide, sources panel open': { ...WIDE, sources: true },
  'wide, sources panel + status bar': { ...WIDE, sources: true, statusBar: true },
  'wide, overlay chat': { ...WIDE, chat: 'overlay' },
  'wide, docked chat + status bar': { ...WIDE, chat: 'docked', statusBar: true },
  'narrow': { ...NARROW },
  'narrow, sources panel open': { ...NARROW, sources: true, statusBar: true },
  'narrow, overlay chat + sources': { ...NARROW, chat: 'overlay', sources: true },
  'short pane, status bar': { w: 360, h: 260, statusBar: true }
};
const EXPECTED = process.env.GEN ? {} : require('./steps-floating-layout-matrix.expected.json');
for (const [name, scenario] of Object.entries(SCENARIOS)) {
  test(`floating layout matrix: ${name}`, () => {
    assert.deepEqual(run(scenario), EXPECTED[name]);
  });
}
test('floating layout matrix: a second layout pass over the same view writes the same values (idempotent)', () => {
  for (const scenario of Object.values(SCENARIOS)) { const twice = run(scenario, 2), once = run(scenario, 1); assert.equal(twice.sourcesPlaced, once.sourcesPlaced === null ? null : 2, 'placeMapSourcesPanel runs once per pass'); twice.sourcesPlaced = once.sourcesPlaced; assert.deepEqual(twice, once); }
});
if (process.env.GEN) require('node:fs').writeFileSync(process.env.GEN, JSON.stringify(Object.fromEntries(Object.entries(SCENARIOS).map(([k, v]) => [k, run(v)])), null, 2) + '\n');
