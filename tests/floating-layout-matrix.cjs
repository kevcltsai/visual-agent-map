// Characterization matrix for the floating controls (toolbar, goal bar + icons, suggestion panel, sources panel, zoom bar,
// canvas hint, status bar, overlay chat). It drives the real view members (placeMapTools -> layoutTopStack / layoutGoalBridge /
// attachRoom / sourcesRoom / bottomLimit, and syncStatusBarClearance) over fake measured rects and locks the written
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
    contains: () => false, querySelectorAll: () => [], clientTop: 0, clientLeft: 0
  }, extra);
}

const { VisualAgentMapView } = load('experiences/visual-map/view.ts', { obsidian: { ...obsidian, Component: class {}, MarkdownRenderChild: class {} } }, { window: { setTimeout, clearTimeout }, CSS: { escape: s => s } });

// Geometry is synthetic but internally consistent (all rects in screen coordinates). One scenario = the measured world. `w` x `h` is the pane; the canvas starts 100px under the pane top (the view header row).
function run(s) {
  const w = s.w, h = s.h, top = 100;
  const canvas = rect(s.chat === 'overlay' || !s.chat ? 0 : (s.chat === 'docked' ? 320 : 0), top, w, top + h);
  const nodes = {};
  const view = Object.create(VisualAgentMapView.prototype);
  const narrow = w < 700;
  const toolsH = narrow ? 88 : 38;
  const toolsLeft = (s.chat === 'overlay' ? 320 - 44 + 12 : 0) + 12;
  const toolbar = el('toolbar', rect(0, top, w, top + 40));
  const toolsRect = s.presentation ? rect(0, 0, 0, 0) : rect(canvas.left + toolsLeft, top + 12, canvas.left + toolsLeft + (narrow ? 150 : 300), top + 12 + toolsH);
  if (!s.presentation) nodes['.vam-map-tools'] = el('tools', toolsRect);
  const overlay = el('overlay', canvas, { clientHeight: h, parentElement: null });
  nodes['.vam-canvas-overlay'] = overlay;
  if (nodes['.vam-map-tools']) nodes['.vam-map-tools'].parentElement = overlay;
  nodes['.vam-toolbar'] = toolbar;
  if (!s.presentation) nodes['.vam-zoom-controls'] = el('zoom', rect(w - 150, top + h - 44, w - 12, top + h - 12));
  if (!s.presentation) nodes['.vam-canvas-hint'] = el('hint', rect(12, top + h - 32, 260, top + h - 12));
  if (s.chat === 'overlay') nodes['.vam-map-chat.is-overlay'] = el('chat-overlay', rect(0, top, 320, top + h));
  // The goal bar sits in the toolbar's middle; its icons are inside the bar (wide) or float below the toolbar (narrow).
  let bar = null, actions = null;
  if (s.goalBar) {
    const barRect = narrow ? rect(12, top + 4, w - 12, top + 60) : rect(320, top + 4, w - 220, top + 36);
    actions = el('actions', narrow ? rect(w - 100, top + 68, w - 12, top + 100) : rect(w - 300, top + 6, w - 230, top + 34), { offsetParent: null });
    bar = el('bar', barRect, { parentElement: toolbar });
    const box = el('box', narrow ? rect(0, top, w, top + 60) : barRect, { clientTop: 0, clientLeft: 0 });
    actions.offsetParent = box;
    bar.offsetParent = box;
    bar.querySelector = sel => (sel === '.vam-goal-actions' ? actions : null);
    nodes.__bar = bar; nodes.__box = box;
    if (s.attachment) {
      const att = el('attachment', rect(barRect.left, barRect.bottom + 6, barRect.right, barRect.bottom + 6 + 300), { offsetParent: box });
      if (s.attachment === 'suggest') att.classes.add('vam-goal-suggest');
      bar.querySelector = sel => (sel === '.vam-goal-actions' ? actions : null);
      view.relevanceBarEl = { querySelector: sel => (sel === '.vam-goal-attachment' ? att : null), remove() {} };
      nodes.__att = att;
    } else view.relevanceBarEl = { querySelector: () => null, remove() {} };
    if (s.clickableInGap) box.querySelectorAll = () => [el('info', rect(w - 100, top + 62, w - 12, top + 66))];
  }
  if (s.statusCard) nodes['.vam-relevance-statusbar'] = el('relstatus', rect(12, top + 40, w - 12, top + 64));
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
    contentEl, containerEl: null, viewportEl: el('viewport', canvas), closed: false, goalBarObserved: [], goalBarObserver: null,
    goalEditInput: null, goalEdit: false, statusBarObserved: null, statusBarObserver: null,
    chat: s.chat === 'overlay' ? { isOverlay: true, overlayWidth: 320 } : (s.chat ? { isOverlay: false } : null),
    mapSourcesControl: { mapSourcesPanelEl: sources, placeMapSourcesPanel: () => { view.__placed = (view.__placed || 0) + 1; } }
  });
  view.relevanceBarEl ??= null;
  // The bar is already in the right row, so placement moves nothing; chat/status members are the real ones.
  view.goalHostTarget = () => ({ host: toolbar, before: null });
  view.markGoalHost = () => {};
  view.goalLayerRoot = () => ({ querySelector: sel => (sel === '.vam-goal-bar' ? bar : null) });
  view.goalAttachmentEl = () => nodes.__att ?? null;
  view.syncStatusBarClearance();
  const out = {
    toolsLeft: nodes['.vam-map-tools']?.style.left ?? null,
    toolsMax: nodes['.vam-map-tools']?.props['--vam-tools-max'] ?? null,
    hasPanel: nodes['.vam-map-tools']?.classes.has('has-panel') ?? null,
    hasAttachment: bar ? bar.classes.has('has-attachment') : null,
    attachClear: nodes.__att?.props['--vam-goal-attach-clear'] ?? null,
    attachMax: nodes.__att?.props['--vam-goal-attach-max'] ?? null,
    bridge: bar ? ['top', 'left', 'width', 'height'].map(n => bar.props[`--vam-goal-bridge-${n}`] ?? null).join(',').replace(/^,,,$/, 'none') : null,
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
  'wide, no goal bar': { ...WIDE },
  'wide, goal bar': { ...WIDE, goalBar: true },
  'wide, goal bar, status bar over canvas': { ...WIDE, goalBar: true, statusBar: true },
  'wide, goal bar, suggestion list': { ...WIDE, goalBar: true, attachment: 'suggest', statusCard: true },
  'wide, goal bar, context box': { ...WIDE, goalBar: true, attachment: 'context' },
  'wide, sources panel open': { ...WIDE, sources: true },
  'wide, sources panel + goal bar + status bar': { ...WIDE, goalBar: true, sources: true, statusBar: true },
  'wide, overlay chat': { ...WIDE, chat: 'overlay', goalBar: true },
  'wide, docked chat + status bar': { ...WIDE, chat: 'docked', statusBar: true },
  'wide, presentation mode (tools, zoom and hint hidden)': { ...WIDE, presentation: true, goalBar: true },
  'narrow, no goal bar': { ...NARROW },
  'narrow, goal bar (icons float under the toolbar)': { ...NARROW, goalBar: true },
  'narrow, goal bar, clickable in the bridge gap': { ...NARROW, goalBar: true, clickableInGap: true },
  'narrow, goal bar, suggestion list, status card': { ...NARROW, goalBar: true, attachment: 'suggest', statusCard: true, statusBar: true },
  'narrow, sources panel open': { ...NARROW, sources: true, statusBar: true },
  'narrow, overlay chat + goal bar + sources': { ...NARROW, chat: 'overlay', goalBar: true, sources: true },
  'short pane, goal bar, suggestion list': { w: 360, h: 260, goalBar: true, attachment: 'suggest', statusBar: true }
};
const EXPECTED = process.env.GEN ? {} : require('./floating-layout-matrix.expected.json');
for (const [name, scenario] of Object.entries(SCENARIOS)) {
  test(`floating layout matrix: ${name}`, () => {
    assert.deepEqual(run(scenario), EXPECTED[name]);
  });
}
test('floating layout matrix: the same measured world gives the same result twice (a layout pass is idempotent)', () => {
  for (const scenario of Object.values(SCENARIOS)) assert.deepEqual(run(scenario), run(scenario));
});
if (process.env.GEN) require('node:fs').writeFileSync(process.env.GEN, JSON.stringify(Object.fromEntries(Object.entries(SCENARIOS).map(([k, v]) => [k, run(v)])), null, 2) + '\n');
