// B12: the three zoom tiers (overview / normal / detail) are a view-only state: a pure rule, one class toggle per real change, no repaint, no tidy-up.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const support = require('./support.cjs');
const { obsidian } = support;
const { load } = require('./support-replay.cjs');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const { nextZoomTier } = load('experiences/visual-map/zoom-tier.ts');

test('nextZoomTier: enters overview below 60% and detail above 125%, leaves at 65% / 130% going up and 55% / 120% going down', () => {
  const table = [
    ['normal', 1, 'normal'], ['normal', 0.6, 'normal'], ['normal', 0.59, 'overview'], ['normal', 1.25, 'normal'], ['normal', 1.26, 'detail'],
    ['overview', 0.64, 'overview'], ['overview', 0.65, 'normal'], ['overview', 1, 'normal'], ['overview', 1.3, 'detail'], ['overview', 0.25, 'overview'],
    ['detail', 1.3, 'detail'], ['detail', 1.2, 'detail'], ['detail', 1.19, 'normal'], ['detail', 0.55, 'normal'], ['detail', 0.54, 'overview'], ['detail', 2, 'detail']
  ];
  for (const [prev, zoom, want] of table) assert.equal(nextZoomTier(prev, zoom), want, `${prev} at ${zoom}`);
});

test('nextZoomTier: five round trips over each threshold switch exactly twice per trip; a wobble inside the 5 point band never switches', () => {
  const walk = (start, path) => {
    let tier = 'normal', switches = 0;
    for (const zoom of [start, ...path]) {
      const next = nextZoomTier(tier, zoom);
      if (next !== tier) switches++;
      tier = next;
    }
    return switches;
  };
  const steps = (from, to, n = 20) => Array.from({ length: n + 1 }, (_, i) => from + ((to - from) * i) / n);
  let down = [], up = [];
  for (let i = 0; i < 5; i++) {
    down = down.concat(steps(1, 0.4), steps(0.4, 1));
    up = up.concat(steps(1, 1.6), steps(1.6, 1));
  }
  assert.equal(walk(1, down), 10, 'overview: 5 trips, in and out');
  assert.equal(walk(1, up), 10, 'detail: 5 trips, in and out');
  const wobble = Array.from({ length: 40 }, (_, i) => (i % 2 ? 0.62 : 0.58));
  assert.equal(walk(1, [0.5, ...wobble]), 1, 'inside 55–65% the tier holds');
  const wobbleUp = Array.from({ length: 40 }, (_, i) => (i % 2 ? 1.22 : 1.28));
  assert.equal(walk(1, [1.4, ...wobbleUp]), 1, 'inside 120–130% the tier holds');
});

function makeView(zoom = 1) {
  const { VisualAgentMapView } = load('experiences/visual-map/view.ts', { obsidian: { ...obsidian, Component: class {}, MarkdownRenderChild: class {} } }, { window: { setTimeout, clearTimeout }, CSS: { escape: s => s } });
  const view = Object.create(VisualAgentMapView.prototype);
  const toggles = [];
  const classes = new Set();
  const calls = { render: 0, arrange: 0, edges: 0, mutate: 0 };
  Object.assign(view, {
    map: { nodes: [{ id: 'a', path: 'a.md', parentId: null, x: 0, y: 0 }], viewport: { x: 40, y: 40, zoom } },
    viewportEl: {
      clientWidth: 1000, clientHeight: 600,
      toggleClass(name, on) { toggles.push([name, on]); on ? classes.add(name) : classes.delete(name); }
    },
    stageEl: { style: { setProperty() {} }, setAttribute() {}, removeAttribute() {} },
    zoomLabel: { setText(text) { this.text = text; }, setAttr(k, v) { this[k] = v; } },
    zoomTier: 'normal', zoomTierEl: null, cardEls: new Map(), selection: { state: { selected: null } },
    plugin: { mutate: async () => { calls.mutate++; } },
    render() { calls.render++; }, paint() { calls.render++; }, drawEdges() { calls.edges++; },
    saveViewport() {}, topicChatOpen: null
  });
  view.arrangeAll = () => { calls.arrange++; };
  return { view, toggles, classes, calls };
}
const tierToggles = toggles => toggles.filter(([name]) => name === 'is-zoom-overview' || name === 'is-zoom-detail');

test('the view toggles the tier classes only when the tier changes, and never repaints or arranges', () => {
  const { view, toggles, classes, calls } = makeView(1);
  view.transform();
  const first = tierToggles(toggles).length;
  const applied = () => ({ overview: classes.has('is-zoom-overview'), detail: classes.has('is-zoom-detail') });
  assert.deepEqual(applied(), { overview: false, detail: false }, 'normal has neither class');
  const setZoom = zoom => { view.map.viewport.zoom = zoom; view.transform(); };
  // Moves inside one tier: no toggle at all.
  for (const zoom of [0.9, 1.1, 1.2, 0.7, 1]) setZoom(zoom);
  assert.equal(tierToggles(toggles).length, first, 'zoom moves inside the normal tier toggle nothing');
  let changes = 0;
  const seen = () => JSON.stringify(applied());
  for (let trip = 0; trip < 5; trip++) {
    for (const zoom of [0.8, 0.62, 0.58, 0.5, 0.4, 0.58, 0.62, 0.66, 1, 1.2, 1.28, 1.31, 1.6, 1.28, 1.21, 1.19, 1]) {
      const before = seen(), count = tierToggles(toggles).length;
      setZoom(zoom);
      const after = seen();
      if (before !== after) changes++;
      else assert.equal(tierToggles(toggles).length, count, `no toggle at ${zoom} when the tier stays`);
    }
  }
  assert.equal(changes, 5 * 4, 'normal<->overview and normal<->detail, in and out, five times');
  assert.equal(view.zoomTier, 'normal');
  assert.deepEqual(applied(), { overview: false, detail: false });
  assert.deepEqual([calls.render, calls.arrange, calls.mutate], [0, 0, 0], 'no repaint, no arrange, no write');
});

test('the zoom label names the tier next to the percentage (nothing extra at normal)', () => {
  const { view } = makeView(1);
  view.transform();
  assert.equal(view.zoomLabel.text, '100%');
  view.map.viewport.zoom = 0.5; view.transform();
  assert.match(view.zoomLabel.text, /^50% \S+/);
  view.map.viewport.zoom = 1.5; view.transform();
  assert.match(view.zoomLabel.text, /^150% \S+/);
  view.map.viewport.zoom = 1; view.transform();
  assert.equal(view.zoomLabel.text, '100%');
});

test('the wheel keeps the point under the cursor fixed across both tier changes', () => {
  const { view } = makeView(1);
  const cursor = { x: 333, y: 217 };
  const worldAt = () => ({ x: (cursor.x - view.map.viewport.x) / view.map.viewport.zoom, y: (cursor.y - view.map.viewport.y) / view.map.viewport.zoom });
  const before = worldAt();
  for (const factor of [0.8, 0.8, 0.8, 0.8, 0.8, 1.25, 1.25, 1.25, 1.25, 1.25, 1.25, 1.25, 1.25]) {
    view.zoomBy(factor, cursor);
    const now = worldAt();
    assert.ok(Math.abs(now.x - before.x) < 1e-6 && Math.abs(now.y - before.y) < 1e-6, `anchor holds at zoom ${view.map.viewport.zoom}`);
  }
  assert.ok(view.zoomTier === 'detail' || view.zoomTier === 'normal');
});

test('a tier change redraws the edges once but a height change it causes is never tidied: no push in overview or detail', async () => {
  const { view, calls } = makeView(1);
  view.transform();
  assert.equal(calls.edges, 0, 'the first transform draws no edges');
  view.map.viewport.zoom = 1.5; view.transform();
  assert.equal(calls.edges, 1, 'entering detail redraws the edges for the taller cards');
  view.map.viewport.zoom = 1.6; view.transform();
  assert.equal(calls.edges, 1, 'a move inside the tier does not');
  // settleCardHeights: the same growth that is tidied at normal zoom is left alone in a tier.
  const settle = tier => {
    const state = makeView(1);
    const v = state.view;
    const nodes = [
      { id: 'a', path: 'a.md', parentId: null, x: 0, y: 0, width: 280 },
      { id: 'b', path: 'b.md', parentId: 'a', x: 0, y: 200, width: 280 }
    ];
    const heights = { a: 150, b: 150 };
    v.map.nodes = nodes;
    v.map.id = 'm';
    v.zoomTier = tier;
    v.cardHeightOf = id => heights[id];
    v.cardEls = new Map(Object.keys(heights).map(id => [id, { get offsetHeight() { return heights[id]; }, dataset: {}, style: { height: '' } }]));
    v.hiddenTab = () => false; v.noteLoad = null; v.renderHold = 0; v.history = {}; v.dragging = false;
    v.ringTidyNeeded = () => false;
    v.heightsSeen = new Map(); v.heightsSeenMap = null; v.settling = false;
    v.settleCardHeights();
    heights.a = 300;
    v.settleCardHeights();
    return state.calls.mutate;
  };
  assert.equal(settle('normal'), 1, 'control: at normal zoom a card that grew over its neighbour is tidied');
  assert.equal(settle('detail'), 0, 'detail: nothing moves');
  assert.equal(settle('overview'), 0, 'overview: nothing moves');
});

test('stylesheet: tiers show only what the ticket says, the old 60% rules stay', () => {
  const css = read('styles.css');
  const view = read('experiences/visual-map/view.ts');
  assert.match(css, /\.vam-viewport\.is-zoom-overview[^{]*\{[^}]*visibility:\s*hidden/, 'overview hides the card body without changing its size');
  assert.match(css, /\.vam-viewport\.is-zoom-overview[^{]*\.vam-card-title[^{]*\{[^}]*visibility:\s*visible/, 'the title stays');
  assert.match(css, /\.vam-viewport\.is-zoom-overview[^{]*\.vam-status-error/, 'anomaly labels stay');
  assert.match(css, /\.vam-viewport\.is-zoom-overview[^{]*\.vam-node-stop[^{]*\{[^}]*scale\(calc\([^)]*var\(--vam-zoom/, 'the stop button is counter-scaled');
  assert.match(css, /\.vam-card-detail-line\s*\{[^}]*display:\s*none/, 'the detail line is built but hidden by default');
  assert.match(css, /\.vam-viewport\.is-zoom-detail \.vam-card-detail-line\s*\{[^}]*display:\s*block/);
  assert.match(css, /\.vam-viewport\.is-zoom-detail[^{]*\.vam-card-summary[^{]*\{[^}]*-webkit-line-clamp:\s*8/);
  assert.ok(css.includes('.vam-viewport.is-zoomed-out .vam-node-header > .vam-node-rerun'), 'is-zoomed-out rule kept');
  assert.match(view, /const TOOLS_MIN_ZOOM = 0\.6;/);
  assert.match(view, /const RELATION_LABEL_MIN_ZOOM = 0\.6;/);
  assert.match(view, /toggleClass\("is-zoomed-out", zoom < TOOLS_MIN_ZOOM\)/);
  assert.ok(view.includes('vam-card-detail-line'), 'renderNode builds the detail line');
  assert.ok(view.includes('"vam-node-stop"') || view.includes('vam-node-stop'), 'the stop buttons carry vam-node-stop');
});

// ---- Layout and share ignore the tier's taller cards ----
const layoutMod = load('map-layout.ts');
const { VisualAgentMapView: RealView } = support.load('main.ts', { obsidian: support.obsidian });
function tierView(tier) {
  const nodes = [support.node('r', null), support.node('a', 'r'), support.node('b', 'r')];
  const view = new RealView({ app: {} }, { settings: { ...support.DEFAULT_SETTINGS }, pendingSuggestions: new Map(), expansionBatches: new Map(), detailsShown: () => false, setOutlineActive() {} });
  view.map = support.map(nodes);
  view.map.id = 'm';
  const normal = { r: 100, a: 120, b: 100 };
  const tall = { r: 220, a: 260, b: 220 };
  view.heightsSeen = new Map(Object.entries(normal));
  view.heightsSeenMap = 'm';
  view.zoomTier = tier;
  const heights = tier === 'normal' ? normal : tall;
  view.cardEls = new Map(Object.entries(heights).map(([id, h]) => [id, { offsetHeight: h }]));
  return view;
}

test('B12 layout: cardHeightOf and the arranged y are the same in detail and overview as at normal zoom', () => {
  const place = tier => {
    const view = tierView(tier);
    const placed = layoutMod.arrangeMap(view.map.nodes, undefined, view.cardHeightOf, 'right');
    return { h: ['r', 'a', 'b'].map(id => view.cardHeightOf(id)), y: placed.map(n => [n.id, n.x, n.y]) };
  };
  const normal = place('normal');
  assert.deepEqual(normal.h, [100, 120, 100], 'control: normal reads the drawn heights');
  assert.deepEqual(place('detail'), normal, 'detail');
  assert.deepEqual(place('overview'), normal, 'overview');
  const fresh = tierView('detail');
  fresh.heightsSeen = new Map();
  assert.equal(fresh.cardHeightOf('a'), undefined, 'no record in a tier and no set height: never the enlarged offsetHeight');
});

test('B12 share: ringHeights in detail equal the normal ones, and none are written without a record', () => {
  const ringOf = tier => {
    const view = tierView(tier);
    view.path = 'Map.md';
    view.notesLoading = () => false;
    view.notes = new Map();
    const ids = ['a', 'b'];
    view.map.nodes.forEach(n => { n.parentId = null; });
    view.map.canvasItems = [{ id: 'img', kind: 'annotated-image', path: 'img.png', x: 0, y: 300, w: 400, h: 300,
      anchors: ids.map((id, i) => ({ id: `an${id}`, at: { kind: 'image-2d', x: 0.2 + i * 0.4, y: 0.5 } })),
      relations: ids.map(id => ({ kind: 'related', from: `an${id}`, to: id, ring: true })) }];
    const snap = view.shareSnapshot();
    return snap === 'none' || snap === 'empty' ? snap : snap.ringHeights;
  };
  const normal = ringOf('normal');
  assert.equal(JSON.stringify([...normal]), JSON.stringify([['a', 120], ['b', 100]]), 'control: normal reads the drawn heights');
  assert.equal(JSON.stringify([...ringOf('detail')]), JSON.stringify([['a', 120], ['b', 100]]));
  assert.equal(JSON.stringify([...ringOf('overview')]), JSON.stringify([['a', 120], ['b', 100]]));
});

// ---- B12-x: the detail tier keeps each card's own frame ----
function fakeCard(height) {
  const card = {
    natural: height, tall: false, style: { height: '', removeProperty(k) { this[k] = ''; } }, dataset: {}, classes: new Set(),
    get offsetHeight() { return this.style.height !== '' ? parseFloat(this.style.height) : (this.tall ? this.natural * 2 : this.natural); },
    get scrollHeight() { return this.tall ? this.natural * 2 : this.natural; },
    get clientHeight() { return this.offsetHeight; },
    toggleClass(name, on) { on ? this.classes.add(name) : this.classes.delete(name); },
    querySelector() { return {}; }
  };
  return card;
}
function detailView(heights) {
  const { view } = makeView(1);
  const cards = Object.fromEntries(Object.entries(heights).map(([id, h]) => [id, fakeCard(h)]));
  view.cardEls = new Map(Object.entries(cards));
  view.ensureClipParts = () => {};
  view.mapNodeById = () => ({});
  view.viewportEl.toggleClass = (name, on) => { if (name === 'is-zoom-detail') for (const c of Object.values(cards)) c.tall = on; };
  return { view, cards };
}

test('B12-x: at 150% each card keeps its normal frame height (nothing grows, so nothing overlaps); back at normal it is released', () => {
  const { view, cards } = detailView({ a: 119, b: 140 });
  view.map.viewport.zoom = 1.5; view.transform();
  assert.equal(view.zoomTier, 'detail');
  assert.deepEqual([cards.a.offsetHeight, cards.b.offsetHeight], [119, 140], 'frames are the normal heights');
  assert.ok(cards.a.classes.has('is-clipped'), 'the extra lines are cut inside the frame, with the fade');
  view.map.viewport.zoom = 1; view.transform();
  assert.equal(view.zoomTier, 'normal');
  assert.equal(cards.a.style.height, '', 'normal zoom: the hold is gone');
  assert.ok(!cards.a.classes.has('is-clipped'));
});

test('B12-x: a card painted inside the detail tier is held at its last normal height', () => {
  const { view, cards } = detailView({ a: 119 });
  view.map.id = 'm'; view.heightsSeen = new Map([['a', 119]]); view.heightsSeenMap = 'm';
  view.zoomTier = 'detail'; cards.a.tall = true;
  view.hiddenTab = () => false; view.noteLoad = null;
  view.settleCardHeights();
  assert.equal(cards.a.offsetHeight, 119);
});

test('B28-x: the overview rule lets the new-card name field show (same rule as the title), and no tier rule hides it again', () => {
  const css = read('styles.css');
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => ({ sel: m[1].trim(), body: m[2] }));
  const overview = rules.filter(r => r.sel.includes('is-zoom-overview'));
  const hide = overview.find(r => /\.vam-node > :not\(svg\)\s*$/.test(r.sel) && /visibility:\s*hidden/.test(r.body));
  assert.ok(hide, 'the overview hide rule exists (this test is about what it spares)');
  const spare = overview.find(r => /visibility:\s*visible/.test(r.body) && r.sel.split(',').some(s => /\.vam-node > \.vam-card-title-input$/.test(s.trim())));
  assert.ok(spare, 'a visible rule names .vam-node > .vam-card-title-input under is-zoom-overview');
  assert.ok(css.indexOf(spare.sel) > css.indexOf(hide.sel), 'the spare rule comes after the hide rule (same specificity, later wins)');
  assert.doesNotMatch(spare.body, /!important/); assert.doesNotMatch(spare.sel, /:has\(/);
  // No other zoom tier rule hides direct children of a node.
  const others = rules.filter(r => /is-zoom-|is-zoomed-out/.test(r.sel) && /visibility:\s*hidden/.test(r.body) && r !== hide);
  assert.deepEqual(others.map(r => r.sel).filter(s => /card-title-input/.test(s)), []);
});
