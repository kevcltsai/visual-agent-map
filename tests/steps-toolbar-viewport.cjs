// P6: the floating toolbar must not cover the canvas origin, and keyboard navigation must not write the viewport.
// Also the map canvas chrome: connection-check button, selection bar, empty-map hint, text direction, selection prune, hover wrap.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const support = require('./support.cjs');
const { obsidian, DEFAULT_SETTINGS } = support;
const { load } = require('./support-replay.cjs');
// Sets the selection through the selection module: mode on or off, then the ticked topics; the picked topic is kept.
const setSelection = (view, mode, ids = [...view.selection.state.multiSelected]) => {
  const s = view.selection, keep = s.state.selected;
  if (s.state.multiSelectMode !== mode) s.toggleMultiSelect();
  s.setSelected(keep);
  return s.replaceMulti(ids);
};

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const css = read('styles.css');
const rule = selector => css.split('\n').find(line => line.startsWith(selector + ' {')) || '';

function fakeEl(tag = 'div', init = {}) {
  return { tag, children: [], attrs: { ...(init.attr || {}) }, classes: new Set(), text: init.text, disabled: false, handlers: new Map(),
    createDiv(v) { return this.createEl('div', typeof v === 'string' ? { cls: v } : v); },
    createSpan(v) { return this.createEl('span', typeof v === 'string' ? { cls: v } : v); },
    createEl(name, v = {}) { const c = fakeEl(name, v); this.children.push(c); return c; },
    setAttr(k, v) { this.attrs[k] = v; }, addClass(...n) { n.forEach(x => this.classes.add(x)); },
    addEventListener(name, h) { this.handlers.set(name, h); } };
}
function bareView(plugin, extra = {}) {
  const { VisualAgentMapView } = load('experiences/visual-map/view.ts', { obsidian: { ...obsidian, Component: class {}, MarkdownRenderChild: class {} } }, { window: { setTimeout, clearTimeout }, CSS: { escape: s => s } });
  return Object.assign(Object.create(VisualAgentMapView.prototype), { plugin, renderingCard: false, selection: new (load('experiences/visual-map/topic-selection.ts').TopicSelection)(), ...extra });
}

const inset = load('experiences/visual-map/viewport-inset.ts');

test('inset is the measured toolbar bottom below the canvas top plus 8px, and 0 when not laid out', () => {
  assert.equal(inset.insetFromRects(100, { top: 112, bottom: 150 }), 58);
  assert.equal(inset.insetFromRects(100, { top: 112, bottom: 190.2 }), 99, 'a wrapped toolbar is taller; fractions round up');
  assert.equal(inset.insetFromRects(100, { top: 0, bottom: 0 }), 0);
  assert.equal(inset.insetFromRects(100, undefined), 0);
});

test('initial viewport: only the untouched default is lifted; a user viewport stays', () => {
  assert.deepEqual({ ...inset.initialViewport({ x: 40, y: 40, zoom: 1 }, 58) }, { x: 40, y: 58, zoom: 1 });
  assert.deepEqual({ ...inset.initialViewport({ x: 40, y: 40, zoom: 1 }, 30) }, { x: 40, y: 40, zoom: 1 });
  const moved = { x: 40, y: 12, zoom: 1 };
  assert.equal(inset.initialViewport(moved, 99), moved);
});

test('a card at the origin sits below the toolbar after the initial viewport, focus and show all', () => {
  const tools = 58;
  for (const [width, height, toolsInset] of [[1280, 800, tools], [380, 700, 99]]) {
    const size = { width, height };
    const initial = inset.initialViewport({ x: 40, y: 40, zoom: 1 }, toolsInset);
    assert.ok(initial.y >= toolsInset, `initial ${width}`);
    const focus = inset.focusViewport({ x: 0, y: 0, zoom: 1 }, { x: 140, y: 80 }, size, toolsInset);
    assert.ok(focus.y + 80 - 80 >= 0 && focus.y + 80 > toolsInset, 'card centre is below the toolbar');
    const fit = inset.fitViewport({ minX: 0, minY: 0, maxX: 280, maxY: 180 }, size, toolsInset);
    assert.ok(fit.y >= toolsInset, `fit top ${fit.y} >= ${toolsInset} at ${width}`);
    assert.ok(fit.y + 180 * fit.zoom <= height, 'fit bottom stays in the canvas');
    const tall = inset.fitViewport({ minX: 0, minY: 0, maxX: 800, maxY: 1500 }, size, toolsInset);
    assert.ok(tall.y >= toolsInset && tall.y + 1500 * tall.zoom <= height + 1e-6);
  }
});

const notices = [];
function makeView() {
  const { VisualAgentMapView } = load('experiences/visual-map/view.ts', { obsidian: { ...obsidian, Component: class {}, MarkdownRenderChild: class {}, Notice: class { constructor(message) { notices.push(message); } } } }, { window: { setTimeout, clearTimeout }, CSS: { escape: s => s } });
  const writes = [];
  const view = Object.create(VisualAgentMapView.prototype);
  view.selection = new (load('experiences/visual-map/topic-selection.ts').TopicSelection)();
  const nodes = [
    { id: 'a', path: 'a.md', parentId: null, x: 0, y: 0 },
    { id: 'b', path: 'b.md', parentId: 'a', x: 400, y: 2000 }
  ];
  Object.assign(view, {
    map: { nodes, viewport: { x: 40, y: 40, zoom: 1 } },
    cardEls: new Map(), summaryEls: new Map(),
    plugin: { repo: { updateMap: async (...args) => { writes.push(args); } }, mutate: async fn => { await fn(); } },
    viewportEl: { clientWidth: 1000, clientHeight: 600, getBoundingClientRect: () => ({ left: 0, top: 0, right: 1000, bottom: 600 }) },
    stageEl: { style: {}, querySelector: () => null },
    contentEl: { querySelector: selector => (selector === '.vam-map-tools' ? { getBoundingClientRect: () => ({ top: 12, bottom: 50 }) } : null) },
    path: 'Map.md', viewportTimer: null, viewportQueued: false, history: {}
  });
  view.selection.setSelected('a');
  view.cardEls.set('b', { getBoundingClientRect: () => ({ left: 400, right: 680, top: 2000, bottom: 2180 }), focus() {} });
  view.relevanceSortOn = () => false;
  view.canvasNodes = () => nodes;
  view.transform = () => {};
  view.selectMapNode = node => { view.selection.setSelected(node.id); };
  return { view, writes, nodes };
}

const flush = () => new Promise(resolve => setTimeout(resolve, 400));

test('arrow-key navigation moves the camera in memory and writes nothing to Map.md', async () => {
  const { view, writes, nodes } = makeView();
  const before = view.map.viewport.y;
  view.moveKeyboardFocus(nodes[1]); // off screen: the camera follows
  assert.notEqual(view.map.viewport.y, before, 'camera followed the card');
  assert.equal(view.viewportTimer, null, 'no save was scheduled');
  await flush();
  assert.equal(writes.length, 0, 'zero Map.md writes');
});

test('mouse-driven focus and Show all still persist the viewport', async () => {
  const { view, writes, nodes } = makeView();
  view.focusNode(nodes[1]);
  await flush();
  assert.equal(writes.length, 1, 'focusNode persists');
  const second = makeView();
  second.nodes[1].y = 300;
  second.view.fit();
  await flush();
  assert.equal(second.writes.length, 1, 'Show all persists');
  assert.ok(second.view.map.viewport.y >= 58, 'Show all leaves the toolbar inset');
});

test('Bug bash E #23: Show all and the branch frame use the width a card was resized to, not 280, so a wide rightmost card is not clipped', () => {
  const { view, nodes } = makeView();
  nodes[1].x = 400; nodes[1].y = 300; nodes[1].width = 560;
  view.fit();
  const wide = view.map.viewport;
  assert.ok((nodes[1].x + 560) * wide.zoom + wide.x <= 1000 + 1e-6, `right edge ${(nodes[1].x + 560) * wide.zoom + wide.x} stays inside the 1000px canvas`);
  // a card with no custom width: the same camera as with an explicit 280
  const plain = makeView(), explicit = makeView();
  for (const each of [plain, explicit]) { each.nodes[1].x = 400; each.nodes[1].y = 300; }
  explicit.nodes[1].width = 280;
  plain.view.fit(); explicit.view.fit();
  assert.equal(JSON.stringify(plain.view.map.viewport), JSON.stringify(explicit.view.map.viewport));
  // branch frame
  const branch = makeView();
  branch.nodes[1].x = 400; branch.nodes[1].y = 300; branch.nodes[1].width = 560;
  branch.view.cardHeightOf = () => 180;
  branch.view.frameBranch(['a', 'b']);
  const framed = branch.view.map.viewport;
  assert.ok((400 + 560) * framed.zoom + framed.x <= 1000 + 1e-6, 'branch frame holds the wide card');
  // focus centres on the middle of the wide card
  const focus = makeView();
  focus.nodes[1].x = 400; focus.nodes[1].y = 300; focus.nodes[1].width = 560;
  focus.view.focusNode(focus.nodes[1]);
  const vp = focus.view.map.viewport;
  assert.equal(Math.round((400 + 280) * vp.zoom + vp.x), 500, 'the card centre (x + width / 2) lands mid-canvas');
});

test('Bug bash E #24: Show all says so when the 25% floor keeps cards off screen, and stays quiet when everything fits', () => {
  const { translate } = load('i18n.ts');
  for (const language of ['en', 'zh-TW', 'zh-CN']) assert.notEqual(translate(language, 'ui.fit_clamped'), 'ui.fit_clamped', `${language} has the hint`);
  assert.equal(translate('zh-TW', 'ui.fit_clamped'), '有些卡片在畫面外，拖曳畫布可以看到其餘部分。');
  const big = makeView();
  notices.length = 0;
  const said = [];
  big.view.announcer = { setText: text => said.push(text) };
  big.nodes[1].x = 6000; big.nodes[1].y = 3000;
  big.view.fit();
  assert.equal(big.view.map.viewport.zoom, 0.25, 'the floor is kept');
  assert.deepEqual(notices, [translate('en', 'ui.fit_clamped')]);
  assert.deepEqual(said, [translate('en', 'ui.fit_clamped')], 'announced in the live region too');
  const small = makeView();
  notices.length = 0;
  small.view.announcer = { setText: text => said.push(text) };
  said.length = 0;
  small.nodes[1].x = 400; small.nodes[1].y = 300;
  small.view.fit();
  assert.deepEqual(notices, []);
  assert.deepEqual(said, []);
  // the shared fit helper keeps its signature and floor (the sharing viewer uses it)
  const inset = load('experiences/visual-map/viewport-inset.ts');
  assert.equal(inset.fitViewport({ minX: 0, minY: 0, maxX: 9000, maxY: 9000 }, { width: 1000, height: 600 }, 0).zoom, 0.25);
});

test('Bug bash E #13: in a narrow pane the toolbar actions wrap inside the pane and the zoom controls stay inside its left edge', () => {
  const actions = rule('.vam-toolbar-actions');
  assert.match(actions, /flex-wrap: wrap/, 'actions wrap instead of running past the pane');
  assert.match(actions, /max-width: 100%/, 'actions never grow wider than the toolbar');
  assert.match(actions, /margin-left: auto/, 'still pushed to the end when there is room');
  const zoom = css.split('\n').filter(line => line.startsWith('.vam-zoom-controls {')).join('\n');
  assert.match(zoom, /max-width: calc\(100% - 24px\)/, 'zoom controls leave the 12px gap on both sides');
  assert.match(zoom, /flex-wrap: wrap/);
  assert.match(zoom, /right: 12px/);
  assert.match(css, /\.vam-workspace\.has-inspector \.vam-zoom-controls \{ right: auto; left: 12px; \}/, 'the inspector shift rule stays');
});

test('Bug bash E #35: opening another map in the same tab asks the workspace to refresh the window title; the same map or no file does not', async () => {
  const { view } = makeView();
  const opened = [];
  view.openMap = async file => { opened.push(file); view.path = file; };
  const swap = { history: true };
  await view.setState({ file: 'Other/Map.md' }, swap);
  assert.deepEqual(opened, ['Other/Map.md']);
  assert.equal(swap.layout, true, 'result.layout makes Obsidian redraw the tab and the OS window title');
  const same = { history: true };
  await view.setState({ file: 'Other/Map.md' }, same);
  assert.equal(same.layout, undefined, 'the title refresh itself sets the same state again: no layout loop');
  const none = { history: true };
  await view.setState({}, none);
  assert.equal(none.layout, undefined);
});

test('Bug bash E #35 (round 2): the header title refresh (same file, map switched through openMap) also asks for the layout refresh, once', async () => {
  const { view } = makeView();
  view.openMap = async () => { throw new Error('same file: no openMap'); };
  view.path = 'Map.md';
  view.titleRefresh = true; // what paint() sets right before it calls leaf.setViewState after the title changed
  const refresh = { history: true };
  await view.setState({ file: 'Map.md' }, refresh);
  assert.equal(refresh.layout, true);
  const again = { history: true };
  await view.setState({ file: 'Map.md' }, again);
  assert.equal(again.layout, undefined, 'only the refresh asked for, so no loop');
  const src = fs.readFileSync(path.join(root, 'experiences/visual-map/view.ts'), 'utf8');
  assert.match(src, /this\.titleRefresh = true;\s*void this\.leaf\.setViewState/, 'paint() raises the flag right before the refresh');
});

test('Bug bash E #35 (follow-up): through the real paint() and a leaf that behaves like Obsidian (setViewState -> view.setState(state, result) -> updateTitle when result.layout), a map switch and a rename each refresh the window title once, with no loop', async () => {
  // paint() is run for real up to the title refresh; the first thing after it reads activeDocument, which ends the run on purpose.
  const stop = new Error('paint stops here: the title refresh is the part under test');
  const { VisualAgentMapView } = load('experiences/visual-map/view.ts', { obsidian: { ...obsidian, Component: class {}, MarkdownRenderChild: class {}, Notice: class {} } }, {
    window: { setTimeout, clearTimeout, clearInterval }, CSS: { escape: s => s },
    get activeDocument() { return { get activeElement() { throw stop; } }; }
  });
  const view = Object.create(VisualAgentMapView.prototype);
  const titles = [];
  const workspace = { updateTitle() { titles.push(view.getDisplayText()); } };
  // what Obsidian does for leaf.setViewState: hand the state to the view with a result object, then redraw the title when the view asked for a layout refresh
  const leaf = { setViewState: async viewState => { const result = { history: true }; await view.setState(viewState.state, result); if (result.layout) workspace.updateTitle(); } };
  const maps = { 'A.md': { title: 'Map A', nodes: [] }, 'B.md': { title: 'Map B', nodes: [] } };
  Object.assign(view, { leaf, path: 'A.md', map: maps['A.md'], headerTitle: 'Map A', closed: false, aimProgressEls: new Map(), paintCount: 0, plugin: { syncOutline() {} }, notes: new Map() });
  // the switcher / openMap path: the other map is read, then painted
  view.openMap = async file => { view.path = file; view.map = maps[file]; try { view.paint(); } catch (error) { if (error !== stop) throw error; } };
  const settle = () => new Promise(resolve => setTimeout(resolve, 60));
  await leaf.setViewState({ type: 'visual-agent-map', state: { file: 'B.md' } });
  assert.deepEqual(titles, ['Map B'], 'the switch itself refreshes the window title, after the new map is the display text');
  await settle();
  assert.deepEqual(titles, ['Map B', 'Map B'], 'paint() then asks once more for the changed header title, which is the end of it');
  await settle();
  assert.equal(titles.length, 2, 'no refresh loop');
  // a rename in place (same file): only paint()'s refresh runs
  view.map = { ...view.map, title: 'Renamed' };
  try { view.paint(); } catch (error) { if (error !== stop) throw error; }
  await settle();
  assert.deepEqual(titles.slice(2), ['Renamed']);
  // painting again with the same title asks for nothing
  try { view.paint(); } catch (error) { if (error !== stop) throw error; }
  await settle();
  assert.equal(titles.length, 3);
});

test('the empty-map hint ignores pointer events but its Topic button receives them', () => {
  assert.match(rule('.vam-empty'), /pointer-events: none/);
  assert.match(rule('.vam-empty button'), /pointer-events: auto/);
});


test('the selection bar joins names with the localized list separator and reads each name direction-aware', () => {
  const titles = new Map([['a', { title: 'Alpha' }], ['b', { title: 'שלום' }], ['c', { title: 'C' }]]);
  const view = bareView({ expansionBatches: new Map(), settings: { ...DEFAULT_SETTINGS, language: 'en' } }, { notes: titles, map: { nodes: [] } });
  view.selection.replaceMulti(['a', 'b', 'c']);
  view.mergeCheck = () => ({ ok: true }); view.multiResearchKey = () => 'k';
  const bar = view.renderSelectionBar(fakeEl());
  const names = bar.children[0];
  assert.ok(names.text.includes('Alpha, שלום'), names.text);
  assert.ok(!names.text.includes('、'));
  const { translate } = load('i18n.ts');
  assert.equal(translate('en', 'ui.list_separator'), ', ');
  assert.equal(translate('zh-TW', 'ui.list_separator'), '、');
});


test('card title, map title, outline rows and parent-picker rows carry dir="auto"; rows align to the start edge', () => {
  const view = read('experiences/visual-map/view.ts');
  assert.match(view, /title\.setAttr\("dir", "auto"\)/);
  assert.match(view, /cls: "vam-map-title", attr: \{ dir: "auto" \}/);
  assert.match(read('ui/outline-view.ts'), /button\.setAttr\("dir", "auto"\)/);
  assert.match(read('ui/topic-tree.ts'), /button\.setAttr\("dir", "auto"\)/);
  for (const sel of ['.vam-outline-note', '.vam-topic-tree-row']) {
    assert.match(rule(sel), /text-align: start/); assert.doesNotMatch(rule(sel), /text-align: left/);
  }
});


test('the topic tree rows get dir="auto" when built', () => {
  const { renderTopicTree } = load('ui/topic-tree.ts');
  const rows = [];
  const tree = fakeEl();
  tree.createEl = (name, v) => { const c = fakeEl(name, v); c.style = {}; c.dataset = {}; rows.push(c); return c; };
  const host = fakeEl(); host.createDiv = () => tree;
  renderTopicTree(host, { nodes: [{ id: 'a', parentId: null, path: 'a.md' }], title: () => 'שלום', label: 'l', selectable: () => true, onChoose() {}, rootChoice: 'None' });
  assert.equal(rows.length, 2);
  for (const row of rows) assert.equal(row.attrs.dir, 'auto');
});


test('render prunes multiSelected to existing nodes and leaves selecting mode on an empty map before the toolbar is built', () => {
  const view = read('experiences/visual-map/view.ts');
  assert.match(view, /this\.selection\.prune\(new Set\(shown\.map\(node => node\.id\)\)\)/);
  const reset = view.indexOf('if (!this.map.nodes.length) {\n      this.selection.exitMultiSelect("emptyMap");');
  const toolbar = view.indexOf('const tools = createDiv("vam-map-tools");');
  assert.ok(reset > 0 && reset < toolbar, 'reset must precede the toolbar that reads the selection mode');
  assert.match(view.slice(reset, toolbar), /this\.selection\.exitMultiSelect\("emptyMap"\)/);
});


test('a very long word in the hover preview title wraps instead of clipping', () => {
  assert.match(rule('.vam-hover-card strong'), /overflow-wrap: anywhere/);
});

test('the selection bar is left-anchored above the zoom cluster, names on their own line, and select mode draws no hint', () => {
  const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  const bar = css.split('\n').find(line => line.startsWith('.vam-selection-bar {'));
  assert.ok(bar && !/translateX/.test(bar) && /left: 16px/.test(bar) && /bottom: 64px/.test(bar), 'left-anchored, clear of the bottom-right zoom controls');
  const names = css.split('\n').find(line => line.startsWith('.vam-selection-bar > span'));
  assert.match(names, /flex: 0 0 100%/); assert.match(names, /text-overflow: ellipsis/);
  const source = fs.readFileSync(path.join(root, 'experiences/visual-map/view.ts'), 'utf8');
  assert.match(source, /!this\.selection\.state\.multiSelectMode && !this\.plugin\.settings\.canvasHintSeen/, 'no hint while selecting topics');
});


test('bar children keep the same order and fixed labels at counts 0-3 (names span first)', () => {
  const view = bareView({ expansionBatches: new Map(), settings: { ...DEFAULT_SETTINGS, language: 'en' } }, { notes: new Map([['a', { title: 'A very long title '.repeat(8) }], ['b', { title: 'B' }], ['c', { title: 'C' }]]), map: { nodes: [] } });
  view.mergeCheck = () => ({ ok: true }); view.multiResearchKey = () => 'k';
  const shapes = [];
  for (const ids of [[], ['a'], ['a', 'b'], ['a', 'b', 'c']]) {
    setSelection(view, false, ids);
    const bar = view.renderSelectionBar(fakeEl());
    assert.equal(bar.children[0].tag, 'span');
    shapes.push(bar.children.slice(1).map(c => c.text).join('|'));
  }
  assert.equal(new Set(shapes).size, 1, shapes.join(' / '));
});


// ---- UX review A theme 2: floating controls over cards ----
test('clearToolbar: a saved viewport that puts a card under the toolbar moves down by the overlap, at most the inset; otherwise it is untouched', () => {
  const v = { x: 0, y: 0, zoom: 1 };
  assert.equal(inset.clearToolbar(v, 58, []), v, 'no card under the toolbar: the very same viewport');
  assert.equal(inset.clearToolbar(v, 0, [10]), v, 'no inset measured: untouched');
  assert.deepEqual({ ...inset.clearToolbar(v, 58, [20]) }, { x: 0, y: 38, zoom: 1 }, 'the highest card ends at the inset');
  assert.deepEqual({ ...inset.clearToolbar(v, 58, [30, 20, 40]) }, { x: 0, y: 38, zoom: 1 });
  assert.equal(inset.clearToolbar(v, 58, [-5000]).y, 58, 'a card far above moves the map by at most the inset');
  assert.equal(inset.clearToolbar(v, 58, [80]), v, 'a card already below the inset needs no move');
  assert.equal(inset.clearToolbar({ x: 5, y: 12, zoom: 0.5 }, 58, [12]).zoom, 0.5);
});

test('isObscured: outside the canvas or under any floating control counts, a clear card does not, touching edges do not', () => {
  const view = { left: 0, top: 0, right: 1000, bottom: 600 };
  const covers = [{ left: 12, top: 12, right: 400, bottom: 50 }, { left: 700, top: 540, right: 988, bottom: 588 }];
  assert.equal(inset.isObscured({ left: 100, top: 100, right: 380, bottom: 280 }, view, covers), false);
  assert.equal(inset.isObscured({ left: 100, top: 30, right: 380, bottom: 210 }, view, covers), true, 'under the toolbar');
  assert.equal(inset.isObscured({ left: 100, top: 30, right: 380, bottom: 210 }, view, []), false, 'no covers');
  assert.equal(inset.isObscured({ left: 750, top: 400, right: 900, bottom: 560 }, view, covers), true, 'under the zoom controls');
  assert.equal(inset.isObscured({ left: 100, top: 50, right: 380, bottom: 230 }, view, covers), false, 'touching the toolbar edge');
  assert.equal(inset.isObscured({ left: 900, top: 100, right: 1180, bottom: 280 }, view, covers), true, 'past the canvas edge');
});

test('moveKeyboardFocus brings a card hidden under the toolbar into view, and leaves a clear card alone', () => {
  for (const [top, follows] of [[20, true], [200, false]]) {
    const { view, nodes } = makeView();
    view.contentEl = { querySelector: selector => (selector === '.vam-map-tools' ? { getBoundingClientRect: () => ({ left: 12, top: 12, right: 400, bottom: 50 }) } : null) };
    view.cardEls.set('b', { getBoundingClientRect: () => ({ left: 100, right: 380, top, bottom: top + 180 }), focus() {} });
    const before = view.map.viewport.y;
    view.moveKeyboardFocus(nodes[1]);
    assert.equal(view.map.viewport.y !== before, follows, `top ${top}`);
  }
});

test('applyInitialViewport moves a saved viewport that draws a card under the toolbar, in memory only; a clear one stays', () => {
  for (const [saved, moves] of [[{ x: 0, y: 0, zoom: 1 }, true], [{ x: 0, y: 300, zoom: 1 }, false]]) {
    const { view, writes } = makeView();
    view.map.viewport = { ...saved };
    view.canvasNodes = () => view.map.nodes;
    view.map.nodes[0].x = 684; view.map.nodes[0].y = 0;
    view.map.nodes[1].x = 5000; view.map.nodes[1].y = 5000;
    view.viewportEl.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1440, bottom: 700 });
    view.contentEl = { querySelector: selector => (selector === '.vam-map-tools' ? { getBoundingClientRect: () => ({ left: 12, top: 12, right: 720, bottom: 50 }) } : null) };
    view.applyInitialViewport();
    assert.equal(view.map.viewport.y, moves ? 58 : 300, `saved y ${saved.y}`);
    assert.equal(view.viewportTimer, null);
    assert.equal(writes.length, 0, 'nothing written');
  }
});

test('applyInitialViewport lifts a saved viewport only on the first paint of a map; a later render leaves a view the user panned to', () => {
  const { view } = makeView();
  view.path = 'Maps/A/Map.md';
  view.map.viewport = { x: 0, y: 0, zoom: 1 };
  view.canvasNodes = () => view.map.nodes;
  view.map.nodes[0].x = 684; view.map.nodes[0].y = 0;
  view.map.nodes[1].x = 5000; view.map.nodes[1].y = 5000;
  view.viewportEl.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1440, bottom: 700 });
  view.contentEl = { querySelector: selector => (selector === '.vam-map-tools' ? { getBoundingClientRect: () => ({ left: 12, top: 12, right: 720, bottom: 50 }) } : null) };
  view.applyInitialViewport();
  assert.equal(view.map.viewport.y, 58, 'first paint lifts the card clear');
  view.map.viewport = { x: 0, y: 0, zoom: 1 }; // the user pans the card back under the toolbar
  view.applyInitialViewport();
  assert.equal(view.map.viewport.y, 0, 'a re-render keeps the panned view');
  view.path = 'Maps/B/Map.md';
  view.applyInitialViewport();
  assert.equal(view.map.viewport.y, 58, 'another map is cleared on its first paint');
});

test('render order: toolbar overlay before the viewport, zoom controls in a second overlay after it', () => {
  const source = read('experiences/visual-map/view.ts');
  const render = source.slice(source.indexOf('  private render(): void {'));
  const at = text => render.indexOf(text);
  assert.ok(at('const overlay = canvas.createDiv("vam-canvas-overlay");') > at('this.viewportEl = canvas.createDiv("vam-viewport");'));
  assert.ok(at('canvas.insertBefore(overlay, this.viewportEl);') > at('const overlay = canvas.createDiv("vam-canvas-overlay");'));
  const controls = at('const controls = canvas.createDiv("vam-canvas-overlay vam-canvas-controls");');
  assert.ok(controls > at('canvas.insertBefore(overlay, this.viewportEl);'), 'the controls overlay is appended after the viewport');
  assert.ok(at('const zoom = controls.createDiv("vam-zoom-controls");') > controls);
  assert.equal(render.includes('overlay.createDiv("vam-zoom-controls")'), false);
});

// ---- Map trial bug 5: Show all and focus keep the card area clear of the zoom bar and an overlay chat panel ----
test('four-sided inset: a number is the top only; Show all keeps the lowest card above a bottom inset and the leftmost right of a left inset', () => {
  const bounds = { minX: 0, minY: 0, maxX: 900, maxY: 1200 }, size = { width: 1000, height: 600 };
  const old = inset.fitViewport(bounds, size, 58);
  assert.deepEqual({ ...inset.fitViewport(bounds, size, { top: 58, right: 0, bottom: 0, left: 0 }) }, { ...old }, 'a number equals a top-only object');
  const bottom = inset.fitViewport(bounds, size, { top: 58, right: 0, bottom: 68, left: 0 });
  assert.ok(bottom.y >= 58 - 1e-6, 'top kept');
  assert.ok(bottom.y + 1200 * bottom.zoom <= 600 - 68 + 1e-6, `lowest card bottom ${bottom.y + 1200 * bottom.zoom} stays above the zoom bar at 532`);
  assert.ok(old.y + 1200 * old.zoom > 600 - 68, 'without the bottom inset the card would sit under the bar');
  const left = inset.fitViewport({ minX: 0, minY: 0, maxX: 900, maxY: 300 }, size, { top: 58, right: 0, bottom: 0, left: 300 });
  assert.ok(left.x >= 300 - 1e-6, `leftmost card ${left.x} is right of the panel edge 300`);
  assert.ok(inset.fitViewport({ minX: 0, minY: 0, maxX: 900, maxY: 300 }, size, 58).x < 300, 'contrast: the old number inset puts the leftmost card under a 300px left panel');
  assert.ok(left.x + 900 * left.zoom <= 1000 + 1e-6, 'the right edge stays in the canvas');
  const focus = inset.focusViewport({ x: 0, y: 0, zoom: 1 }, { x: 140, y: 80 }, size, { top: 58, right: 0, bottom: 68, left: 300 });
  assert.equal(focus.x, 300 + (1000 - 300) / 2 - 140);
  assert.equal(focus.y, 58 + (600 - 58 - 68) / 2 - 80);
  assert.deepEqual({ ...inset.focusViewport({ x: 0, y: 0, zoom: 1 }, { x: 140, y: 80 }, size, 58) }, { zoom: 1, x: 500 - 140, y: 58 + (600 - 58) / 2 - 80 }, 'a number keeps the old centring');
  const wide = { minX: 0, minY: 0, maxX: 9000, maxY: 300 };
  assert.equal(inset.fitIsClamped(wide, size, 58), inset.fitIsClamped(wide, size, { top: 58, right: 0, bottom: 0, left: 0 }));
  assert.equal(inset.fitIsClamped({ minX: 0, minY: 0, maxX: 2500, maxY: 300 }, size, { top: 0, right: 0, bottom: 0, left: 300 }), true, 'a left panel narrows the fit width');
  assert.equal(inset.fitIsClamped({ minX: 0, minY: 0, maxX: 2500, maxY: 300 }, size, 0), false);
});

test('Show all measures the zoom bar and the overlay chat panel; a docked panel and a missing bar add nothing', () => {
  const rects = { tools: { left: 12, top: 12, right: 400, bottom: 50 }, zoom: { left: 900, top: 540, right: 990, bottom: 590 }, chat: { left: 0, top: 0, right: 300, bottom: 600 } };
  const fixture = parts => {
    const { view, nodes } = makeView();
    nodes[0].x = 0; nodes[0].y = 0; nodes[1].x = 600; nodes[1].y = 1020;
    view.cardEls.set('a', { getBoundingClientRect: () => ({}) });
    view.contentEl = { querySelector: selector => ({ '.vam-map-tools': parts.tools, '.vam-zoom-controls': parts.zoom, '.vam-map-chat.is-overlay': parts.chat })[selector] ? { getBoundingClientRect: () => ({ '.vam-map-tools': parts.tools, '.vam-zoom-controls': parts.zoom, '.vam-map-chat.is-overlay': parts.chat })[selector] } : null };
    view.stageEl = { style: {}, querySelector: () => null };
    return { view, nodes };
  };
  const bare = fixture({ tools: rects.tools });
  bare.view.fit();
  assert.deepEqual({ ...bare.view.canvasInsets() }, { top: 58, right: 0, bottom: 0, left: 0 }, 'no bar, no overlay: top only');
  const withBar = fixture({ tools: rects.tools, zoom: rects.zoom });
  withBar.view.fit();
  assert.deepEqual({ ...withBar.view.canvasInsets() }, { top: 58, right: 0, bottom: 68, left: 0 });
  const v = withBar.view.map.viewport;
  assert.ok(withBar.nodes[1].y * v.zoom + v.y + 180 * v.zoom <= 600 - 68 + 1e-6, `lowest card bottom stays above the zoom bar (zoom ${v.zoom})`);
  const overlay = fixture({ tools: rects.tools, zoom: rects.zoom, chat: rects.chat });
  overlay.nodes[0].y = 400; overlay.nodes[1].x = 400; overlay.nodes[1].y = 400;
  overlay.view.fit();
  const o = overlay.view.map.viewport;
  assert.ok(overlay.nodes[0].x * o.zoom + o.x >= 300 - 1e-6, `leftmost card ${overlay.nodes[0].x * o.zoom + o.x} is right of the panel edge`);
  assert.equal(overlay.view.canvasInsets().left, 300);
});

// ---- UX review A theme 3: zoom keeps the selected card ----
function zoomFixture({ selected = 'a', viewport = { x: 100, y: 200, zoom: 0.4 }, tools = { left: 12, top: 12, right: 700, bottom: 50 } } = {}) {
  const { view, nodes } = makeView();
  Object.assign(view.map, { viewport: { ...viewport } });
  nodes[0].x = 300; nodes[0].y = 150; nodes[1].x = 5000; nodes[1].y = 5000;
  view.selection.setSelected(selected);
  // Cards are drawn where the current viewport puts them (280 x 180 card units).
  const rectOf = node => { const v = view.map.viewport; const left = 0 + node.x * v.zoom + v.x, top = node.y * v.zoom + v.y; return { left, top, right: left + 280 * v.zoom, bottom: top + 180 * v.zoom }; };
  for (const node of nodes) view.cardEls.set(node.id, { getBoundingClientRect: () => rectOf(node), focus() {} });
  view.contentEl = { querySelector: selector => (selector === '.vam-map-tools' ? { getBoundingClientRect: () => tools } : null) };
  return { view, nodes, rectOf };
}
const centre = rect => ({ x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 });

test('zoom −/+ keeps the selected card centre where it is on screen; without a selection it zooms around the canvas centre', () => {
  const { view, nodes, rectOf } = zoomFixture();
  const before = centre(rectOf(nodes[0]));
  view.zoomBy(1.2, view.selectionAnchor() ?? undefined);
  const after = centre(rectOf(nodes[0]));
  assert.ok(Math.abs(before.x - after.x) < 1e-6 && Math.abs(before.y - after.y) < 1e-6, 'card centre did not move');
  assert.ok(view.map.viewport.zoom > 0.4);
  const none = zoomFixture({ selected: null });
  assert.equal(none.view.selectionAnchor(), null, 'no selection: no anchor');
  const v = { ...none.view.map.viewport };
  none.view.zoomBy(2, none.view.selectionAnchor() ?? undefined);
  assert.ok(Math.abs((500 - (500 - v.x) * (none.view.map.viewport.zoom / v.zoom)) - none.view.map.viewport.x) < 1e-6, 'centred on the 1000px canvas middle');
});

test('a selected card outside the canvas is not used as the zoom anchor', () => {
  const { view } = zoomFixture({ viewport: { x: 5000, y: 5000, zoom: 1 } });
  assert.equal(view.selectionAnchor(), null);
});

test('the percentage reset keeps the selected card and brings it into view when it ends up hidden', () => {
  // Zoomed out 0.4: the card sits at the top (under the toolbar) after the reset around its centre would push it out.
  const hidden = zoomFixture({ viewport: { x: 100, y: 20, zoom: 0.4 }, tools: { left: 12, top: 12, right: 700, bottom: 50 } });
  hidden.nodes[0].y = 0;
  hidden.view.resetZoom();
  assert.equal(hidden.view.map.viewport.zoom, 1);
  const rect = hidden.rectOf(hidden.nodes[0]);
  assert.ok(!inset.isObscured(rect, { left: 0, top: 0, right: 1000, bottom: 600 }, [{ left: 12, top: 12, right: 700, bottom: 50 }]), `card is visible after the reset (top ${rect.top})`);
  // A card that stays in view is left where the anchor put it (no extra camera move).
  const fine = zoomFixture({ viewport: { x: 100, y: 200, zoom: 0.5 } });
  const c0 = centre(fine.rectOf(fine.nodes[0]));
  fine.view.resetZoom();
  const c1 = centre(fine.rectOf(fine.nodes[0]));
  assert.ok(Math.abs(c0.x - c1.x) < 1e-6 && Math.abs(c0.y - c1.y) < 1e-6);
});

test('the zoom buttons anchor on the selection and the reset is wired to resetZoom', () => {
  const render = read('experiences/visual-map/view.ts');
  assert.match(render, /this\.zoomBy\(1 \/ 1\.2, this\.selectionAnchor\(\) \?\? undefined\)/);
  assert.match(render, /this\.zoomBy\(1\.2, this\.selectionAnchor\(\) \?\? undefined\)/);
  assert.match(render, /if \(this\.map\) this\.resetZoom\(\);/);
});

// ---- UX review A theme 4: status bar clearance ----
test('statusBarClearance: how far the floating status bar reaches into a target, 0 when it does not', () => {
  const target = { left: 0, right: 1000, bottom: 760 };
  assert.equal(inset.statusBarClearance(target, { left: 604, right: 1000, top: 733, bottom: 760 }), 27);
  assert.equal(inset.statusBarClearance(target, { left: 604, right: 1000, top: 732.4, bottom: 760 }), 28, 'rounds up');
  assert.equal(inset.statusBarClearance(target, null), 0, 'no status bar');
  assert.equal(inset.statusBarClearance(target, { left: 604, right: 604, top: 733, bottom: 760 }), 0, 'zero width');
  assert.equal(inset.statusBarClearance(target, { left: 604, right: 1000, top: 760, bottom: 760 }), 0, 'zero height');
  assert.equal(inset.statusBarClearance({ left: 0, right: 500, bottom: 760 }, { left: 604, right: 1000, top: 733, bottom: 760 }), 0, 'no horizontal overlap');
  assert.equal(inset.statusBarClearance({ left: 0, right: 604, bottom: 760 }, { left: 604, right: 1000, top: 733, bottom: 760 }), 0, 'touching edges');
  assert.equal(inset.statusBarClearance({ left: 0, right: 1000, bottom: 700 }, { left: 604, right: 1000, top: 733, bottom: 760 }), 0, 'status bar starts below the target');
});

test('the zoom controls, canvas hint, selection bar add the status bar clearance; the viewer defines the variable', () => {
  // The base rules keep their plain pixels (map-chat.cjs and the selection bar test read them); a following rule adds the clearance.
  assert.match(css, /^\.vam-zoom-controls \{ bottom: calc\(12px \+ var\(--vam-status-clearance, 0px\)\); \}$/m);
  assert.match(css, /^\.vam-canvas-overlay > \.vam-canvas-hint \{ bottom: calc\(12px \+ var\(--vam-status-clearance, 0px\)\); \}$/m);
  assert.match(css, /^\.vam-selection-bar \{ bottom: calc\(64px \+ var\(--vam-status-clearance, 0px\)\); \}$/m);
  assert.match(read('experiences/sharing/viewer/viewer.css'), /--vam-status-clearance: 0px;/);
  const view = read('experiences/visual-map/view.ts');
  assert.match(view, /private syncStatusBarClearance\(\): void/);
  assert.match(view, /onResize\(\): void \{[^}]*this\.syncStatusBarClearance\(\);/);
  assert.match(view, /this\.statusBarObserver\?\.disconnect\(\);/);
});

test('theme 5: the chat body adds the status bar clearance to its bottom padding, after the base rule', () => {
  assert.match(css, /^\.vam-map-chat > \.vam-map-chat-body \{ padding-bottom: calc\(12px \+ var\(--vam-status-clearance, 0px\)\); \}$/m);
  assert.ok(css.indexOf('.vam-map-chat > .vam-map-chat-body {') > css.indexOf('.vam-map-chat-body { display: flex'), 'after the base rule');
});

test('theme 7: the outline row buttons keep a transparent background under Obsidian\'s button rule, hover and active still tint', () => {
  assert.match(css, /^\.vam-outline-tree \.vam-outline-toggle, \.vam-outline-tree \.vam-outline-note \{ border: 0; box-shadow: none; background: transparent;/m);
  assert.match(css, /^\.vam-outline-tree \.vam-outline-note:hover, \.vam-outline-tree \.vam-outline-note\.is-active \{ background: var\(--background-modifier-hover\); \}$/m);
  assert.doesNotMatch(css, /^\.vam-outline-(toggle|note)(, |:hover|\.is-active)[^{]*\{[^}]*background/m, 'no unscoped (0,1,0) outline background rule is left');
});
