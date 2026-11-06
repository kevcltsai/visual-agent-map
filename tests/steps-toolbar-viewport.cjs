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
const shown = [];
function makeView() {
  const { VisualAgentMapView } = load('experiences/visual-map/view.ts', { obsidian: { ...obsidian, Component: class {}, MarkdownRenderChild: class {}, Notice: class { constructor(message) { notices.push(message); shown.push(this); } hide() { this.hidden = true; } } } }, { window: { setTimeout, clearTimeout }, CSS: { escape: s => s } });
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


// Show all frames annotated images too, anchors or not: right-clicking the picture is the only way to place the first anchor.
const annotatedImage = (id, x, y, w = 320, h = 237) => ({ kind: 'annotated-image', id, path: 'p.png', x, y, w, h, anchors: [], relations: [] });
const inCanvas = (box, vp, size = { width: 1000, height: 600 }) =>
  box.x * vp.zoom + vp.x >= 0 && (box.x + box.w) * vp.zoom + vp.x <= size.width &&
  box.y * vp.zoom + vp.y >= 0 && (box.y + box.h) * vp.zoom + vp.y <= size.height;

test('Show all takes in an annotated image with no anchors, far to the left of the cards', () => {
  const { view, nodes } = makeView();
  nodes[0].x = 500; nodes[0].y = 0;
  nodes[1].x = 500; nodes[1].y = 200;
  const image = annotatedImage('i', -200, 0);
  view.map.canvasItems = [image];
  view.fit();
  assert.ok(inCanvas(image, view.map.viewport), `image inside the canvas at ${JSON.stringify(view.map.viewport)}`);
  assert.ok(view.map.viewport.y + image.y * view.map.viewport.zoom >= 50, 'its top stays below the toolbar');
});

test('Show all frames a map that has only an annotated image, and leaves a map with neither alone', () => {
  const only = makeView();
  only.nodes.length = 0;
  const image = annotatedImage('i', 900, 700);
  only.view.map.canvasItems = [image];
  only.view.fit();
  assert.ok(inCanvas(image, only.view.map.viewport), `image inside the canvas at ${JSON.stringify(only.view.map.viewport)}`);
  const empty = makeView();
  empty.nodes.length = 0;
  empty.view.map.canvasItems = [];
  const before = { ...empty.view.map.viewport };
  empty.view.fit();
  assert.deepEqual({ ...empty.view.map.viewport }, before, 'nothing to frame: the camera stays');
});

test('framing a ring leaves out annotated images that are not part of it', () => {
  const plain = makeView(), withImage = makeView();
  for (const each of [plain, withImage]) {
    each.nodes[1].y = 300;
    each.view.fitOnly = new Set(['a', 'b']);
  }
  withImage.view.map.canvasItems = [annotatedImage('other', -3000, -3000)];
  plain.view.fit(); withImage.view.fit();
  assert.deepEqual({ ...withImage.view.map.viewport }, { ...plain.view.map.viewport });
  const lone = makeView();
  lone.nodes.length = 0;
  lone.view.fitOnly = new Set(['a']);
  lone.view.map.canvasItems = [annotatedImage('other', 900, 700)];
  const before = { ...lone.view.map.viewport };
  lone.view.fit();
  assert.deepEqual({ ...lone.view.map.viewport }, before, 'a ring with no cards frames nothing');
});

test('an annotated image too far from the cards for the zoom floor gets the off-screen notice', () => {
  const { translate } = load('i18n.ts');
  const { view, nodes } = makeView();
  nodes[1].y = 300;
  view.map.canvasItems = [annotatedImage('far', -6000, 0)];
  notices.length = 0;
  view.fit();
  assert.equal(view.map.viewport.zoom, 0.25);
  assert.deepEqual(notices, [translate('en', 'ui.fit_clamped')]);
});

// Show all frames plain images too: a picture the user placed must not be left off screen.
const plainImage = (id, x, y, w = 320, h = 237) => ({ kind: 'image', id, path: 'p.png', x, y, w, h });

test('Show all takes in a plain image far to the left of the cards', () => {
  const { view, nodes } = makeView();
  nodes[0].x = 500; nodes[0].y = 0;
  nodes[1].x = 500; nodes[1].y = 200;
  const image = plainImage('i', -200, 0);
  view.map.canvasItems = [image];
  view.fit();
  assert.ok(inCanvas(image, view.map.viewport), `image inside the canvas at ${JSON.stringify(view.map.viewport)}`);
});

test('Show all frames a map that has only a plain image', () => {
  const { view, nodes } = makeView();
  nodes.length = 0;
  const image = plainImage('i', 900, 700);
  view.map.canvasItems = [image];
  view.fit();
  assert.ok(inCanvas(image, view.map.viewport), `image inside the canvas at ${JSON.stringify(view.map.viewport)}`);
});

test('framing a ring leaves out plain images', () => {
  const plain = makeView(), withImage = makeView();
  for (const each of [plain, withImage]) {
    each.nodes[1].y = 300;
    each.view.fitOnly = new Set(['a', 'b']);
  }
  withImage.view.map.canvasItems = [plainImage('other', -3000, -3000)];
  plain.view.fit(); withImage.view.fit();
  assert.deepEqual({ ...withImage.view.map.viewport }, { ...plain.view.map.viewport });
  const lone = makeView();
  lone.nodes.length = 0;
  lone.view.fitOnly = new Set(['a']);
  lone.view.map.canvasItems = [plainImage('other', 900, 700)];
  const before = { ...lone.view.map.viewport };
  lone.view.fit();
  assert.deepEqual({ ...lone.view.map.viewport }, before, 'a ring with no cards frames nothing');
});

test('a plain image too far from the cards for the zoom floor gets the off-screen notice', () => {
  const { translate } = load('i18n.ts');
  const { view, nodes } = makeView();
  nodes[1].y = 300;
  view.map.canvasItems = [plainImage('far', -6000, 0)];
  notices.length = 0;
  view.fit();
  assert.equal(view.map.viewport.zoom, 0.25);
  assert.deepEqual(notices, [translate('en', 'ui.fit_clamped')]);
});
test('Persona 13: the off-screen notice judges the real canvas, so cards only the toolbar insets squeeze do not trigger it', () => {
  const { view, nodes } = makeView(); nodes[1].y = 1900; // 2080px tall: the inset-reduced fit area needs < 25%, but the whole canvas holds it at 25%
  notices.length = 0;
  view.fit();
  const vp = view.map.viewport;
  assert.equal(vp.zoom, 0.25);
  assert.ok(vp.y >= 0 && (nodes[1].y + 180) * vp.zoom + vp.y <= 600 + 1e-6, 'every card is inside the 600px canvas');
  assert.deepEqual(notices, [], 'no notice while all cards are on screen');
  nodes[1].y = 3000; // now a card really is below the canvas
  view.fit();
  assert.equal(notices.length, 1, 'a card truly off screen still says so');
});

test('Persona 13: pressing Show all twice leaves one visible notice', () => {
  const { view, nodes } = makeView();
  nodes[1].x = 6000; nodes[1].y = 3000;
  notices.length = 0; shown.length = 0;
  view.fit();
  view.fit();
  assert.equal(shown.filter(n => !n.hidden).length, 1, 'the earlier notice is hidden before the next shows');
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

test('the selection bar is a narrow strip along the canvas bottom, names ellipsised, and select mode draws no hint', () => {
  const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  const bar = css.split('\n').find(line => line.startsWith('.vam-selection-bar {'));
  assert.ok(bar && /bottom: 0; left: 0; right: 0/.test(bar) && /min-height: 44px/.test(bar), 'full width along the bottom');
  const names = css.split('\n').find(line => line.startsWith('.vam-selection-bar > span'));
  assert.match(names, /text-overflow: ellipsis/);
  const source = fs.readFileSync(path.join(root, 'experiences/visual-map/view.ts'), 'utf8');
  assert.match(source, /!this\.selection\.state\.multiSelectMode && !this\.plugin\.settings\.canvasHintSeen/, 'no hint while selecting topics');
});


test('bar children keep the same order and fixed labels at counts 1-3 (names span first); no card picked draws nothing', () => {
  const view = bareView({ expansionBatches: new Map(), settings: { ...DEFAULT_SETTINGS, language: 'en' } }, { notes: new Map([['a', { title: 'A very long title '.repeat(8) }], ['b', { title: 'B' }], ['c', { title: 'C' }]]), map: { nodes: [] } });
  view.mergeCheck = () => ({ ok: true }); view.multiResearchKey = () => 'k';
  const shapes = [];
  setSelection(view, false, []);
  assert.equal(view.renderSelectionBar(fakeEl()).children.length, 0);
  for (const ids of [['a'], ['a', 'b'], ['a', 'b', 'c']]) {
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
  assert.match(css, /^\.vam-selection-bar \{ bottom: var\(--vam-status-clearance, 0px\); \}$/m);
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

// ---- persona #39: the card tool row and the multi-select bar never cover cards ----
// A 13-card map in the standard layout (column 360, gap 24, card 280 x 60..120) shown at 60%.
function thirteenCards(zoom, origin) {
  const heights = [120, 80, 100, 60, 90, 70, 110, 60, 80, 100, 60, 90, 70];
  const cards = [];
  let y = 0;
  heights.forEach((h, i) => {
    const col = i === 0 ? 0 : i <= 4 ? 1 : 2;
    if (i === 0 || i === 1 || i === 5) y = 0;
    cards.push({ id: i, x: col * 360, y, w: 280, h });
    y += h + 24;
  });
  return cards.map(c => ({ id: c.id, left: origin.x + c.x * zoom, top: origin.y + c.y * zoom, right: origin.x + (c.x + c.w) * zoom, bottom: origin.y + (c.y + c.h) * zoom }));
}
const overlapsAny = (rect, list) => list.some(o => rect.left < o.right && o.left < rect.right && rect.top < o.bottom && o.top < rect.bottom);
test('chooseCardToolsSpot: with 13 cards at 60%, the selected card\'s tool row covers no other card and no floating control, for every card', () => {
  const zoom = 0.6;
  const visible = { left: 0, right: 1400, top: 0, bottom: 900 };
  const controls = [{ left: 12, top: 12, right: 330, bottom: 52 }]; // the top-left canvas toolbar
  const cards = thirteenCards(zoom, { x: 40, y: 20 });
  const size = { width: 220, height: 32 };
  let legacyCovers = 0;
  for (const card of cards) {
    const others = cards.filter(o => o.id !== card.id);
    const row = { left: card.right - 10 * zoom - size.width, right: card.right - 10 * zoom };
    const spot = inset.chooseCardToolsSpot({ card, row, size, others, controls, visible });
    const moved = d => ({ left: d.left + spot.pan.dx, right: d.right + spot.pan.dx, top: d.top + spot.pan.dy, bottom: d.bottom + spot.pan.dy });
    // The old placement (above the card, right-aligned, 6px overlap) is what the test must catch: it covers neighbours on this map.
    const old = { left: row.left, right: row.right, top: card.top + 6 - size.height, bottom: card.top + 6 };
    if (overlapsAny(old, others)) legacyCovers++;
    assert.equal(spot.overlap, 0, `card ${card.id}: row on ${spot.side} covers a neighbour`);
    assert.equal(overlapsAny(spot.rect, others.map(moved)), false, `card ${card.id}: row rectangle meets a neighbour`);
    assert.equal(overlapsAny(spot.rect, controls), false, `card ${card.id}: row under the canvas toolbar`);
    assert.equal(overlapsAny(moved(card), controls), false, `card ${card.id}: card under the canvas toolbar`);
    assert.ok(spot.rect.left >= visible.left && spot.rect.right <= visible.right && spot.rect.top >= visible.top && spot.rect.bottom <= visible.bottom, `card ${card.id}: row inside the canvas`);
  }
  assert.ok(legacyCovers >= 3, `the old placement covers neighbours on this map (${legacyCovers} cards)`);
});
test('side tool row on the right clears the "+" button (14 card units) at low and high zoom; on the left only the plain 4px', () => {
  for (const zoom of [0.3, 0.6, 1, 2.5]) {
    assert.ok(inset.cardToolsSideGap('right', zoom) >= 14, `right gap at ${zoom}`);
    assert.equal(inset.cardToolsSideGap('right', zoom), 14 + 4 / zoom);
    assert.equal(inset.cardToolsSideGap('left', zoom), 4 / zoom);
  }
  // The spot chooser reserves that width: a row beside the card on the right starts that far from the card edge.
  const card = { left: 100, right: 300, top: 100, bottom: 200 };
  const boxed = [{ left: 0, right: 99, top: 90, bottom: 210 }, { left: 120, right: 280, top: 0, bottom: 99 }, { left: 120, right: 280, top: 201, bottom: 300 }];
  const spot = inset.chooseCardToolsSpot({ card, row: { left: 80, right: 290 }, size: { width: 200, height: 32 }, others: boxed, controls: [], visible: { left: 0, right: 1000, top: 0, bottom: 600 }, rightGap: 14 * 0.5 + 4 });
  assert.equal(spot.side, 'right');
  assert.equal(spot.rect.left, card.right + 14 * 0.5 + 4);
});
test('chooseCardToolsSpot: a card in the top-left corner pans clear of the canvas toolbar; a free card is not moved', () => {
  const visible = { left: 0, right: 1400, top: 0, bottom: 900 };
  const controls = [{ left: 12, top: 12, right: 330, bottom: 52 }];
  const size = { width: 220, height: 32 };
  const corner = { left: 20, top: 20, right: 300, bottom: 80 };
  const spot = inset.chooseCardToolsSpot({ card: corner, row: { left: 70, right: 290 }, size, others: [], controls, visible });
  assert.ok(spot.pan.dx > 0 || spot.pan.dy > 0, 'the canvas moves');
  assert.equal(overlapsAny({ left: corner.left + spot.pan.dx, right: corner.right + spot.pan.dx, top: corner.top + spot.pan.dy, bottom: corner.bottom + spot.pan.dy }, controls), false);
  const free = { left: 500, top: 400, right: 780, bottom: 460 };
  const calm = inset.chooseCardToolsSpot({ card: free, row: { left: 550, right: 770 }, size, others: [], controls, visible });
  assert.deepEqual({ ...calm.pan }, { dx: 0, dy: 0 }); assert.equal(calm.side, 'top');
  // Boxed in on every side: the side covering least wins and the row still lies in the canvas after the pan.
  const walls = [{ left: 0, top: 0, right: 1400, bottom: 395 }, { left: 0, top: 465, right: 1400, bottom: 900 }, { left: 0, top: 395, right: 495, bottom: 465 }, { left: 785, top: 395, right: 1400, bottom: 465 }];
  const boxed = inset.chooseCardToolsSpot({ card: free, row: { left: 550, right: 770 }, size, others: walls, controls, visible });
  assert.ok(boxed.overlap > 0);
});
test('chooseCardToolsSpot: a row above or below keeps touching its own card; a tight gap above sends it beside the card, not slid off', () => {
  // Measured in Obsidian at 40% (2026-11-06): 9.5px between this card and the one above, a card down-left, a 171x32 row.
  const visible = { left: -400, right: 1400, top: -200, bottom: 900 };
  const card = { left: 0, top: 100, right: 110, bottom: 145 };
  const others = [
    { left: 0, top: 50, right: 110, bottom: 90.5 },
    { left: 0, top: 155, right: 110, bottom: 200 },
    { left: -142, top: 124, right: -32, bottom: 162 }
  ];
  const size = { width: 171, height: 32 };
  const row = { left: card.right - 4 - size.width, right: card.right - 4 };
  const spot = inset.chooseCardToolsSpot({ card, row, size, others, controls: [], visible });
  assert.equal(spot.overlap, 0);
  if (spot.side === 'top' || spot.side === 'bottom') {
    const shared = Math.min(spot.rect.right, card.right) - Math.max(spot.rect.left, card.left);
    assert.ok(shared >= 32, `row on ${spot.side} shares ${shared}px with its card`);
  } else assert.equal(spot.side, 'right', 'the free side beside the card');
});
test('chooseCardToolsSpot: a card above the bottom-right zoom controls pans up, never off the bottom of the canvas', () => {
  const inset = load('experiences/visual-map/viewport-inset.ts');
  const visible = { left: 684, right: 1900, top: 127, bottom: 1200 };
  const zoom = { left: 1602, top: 1123, right: 1888, bottom: 1163 };
  const card = { left: 1484, right: 1624, top: 1100, bottom: 1141 };
  const spot = inset.chooseCardToolsSpot({ card, row: { left: 1451, right: 1624 }, size: { width: 173, height: 34 }, others: [], controls: [zoom], visible });
  const moved = { left: card.left + spot.pan.dx, right: card.right + spot.pan.dx, top: card.top + spot.pan.dy, bottom: card.bottom + spot.pan.dy };
  assert.ok(moved.bottom <= visible.bottom && moved.top >= visible.top, `card stays on the canvas: ${JSON.stringify(moved)}`);
  assert.ok(moved.right <= visible.right && moved.left >= visible.left, `card stays on the canvas: ${JSON.stringify(moved)}`);
  assert.equal(inset.rectsIntersect(moved, zoom), false, 'and clear of the controls');
  assert.equal(inset.rectsIntersect(spot.rect, zoom), false, 'with its tool row');
  // Down still wins near the top of the canvas (the toolbar case), so the old behaviour stays where it fits.
  const tools = { left: 700, top: 139, right: 1500, bottom: 201 };
  const high = { left: 1000, right: 1140, top: 150, bottom: 190 };
  const under = inset.chooseCardToolsSpot({ card: high, row: { left: 967, right: 1140 }, size: { width: 173, height: 34 }, others: [], controls: [tools], visible });
  assert.ok(under.pan.dy > 0, 'a card under the top toolbar still pans down');
});
// A full repaint hands focus back to the selected card, whose focusin measures the tool row. On a stage without its transform the
// card reads at scale 1 with no pan, so the row "needed" a pan of thousands of pixels and the whole map left the canvas (owner, 2026-11-06).
test('a repaint gives the new stage its viewport before any card is drawn or focused', () => {
  const view = read('experiences/visual-map/view.ts');
  const paint = view.slice(view.indexOf('private paint(): void {'), view.indexOf('private renderMapTools('));
  const stage = paint.indexOf('this.stageEl = this.viewportEl.createDiv("vam-stage")');
  const applied = paint.indexOf('this.applyStageTransform()');
  const firstFocus = paint.indexOf('.focus({ preventScroll: true })', stage);
  const firstCard = paint.indexOf('this.renderNode(', stage);
  assert.ok(stage >= 0 && firstFocus > stage && firstCard > stage, 'paint still has the steps this test orders');
  assert.ok(applied > stage, 'the stage gets its transform in paint');
  assert.ok(applied < firstFocus && applied < firstCard, 'before a card is drawn or focused');
  assert.match(view, /private applyStageTransform\(\): void \{[\s\S]*?style\.transform = `translate\(\$\{x\}px, \$\{y\}px\) scale\(\$\{zoom\}\)`/);
  assert.match(view, /private applyStageTransform\(\): void \{[\s\S]*?--vam-zoom/, 'the tool row counter-scale is measured right too');
});
test('card tools: only AI explore, Details and More float; More holds fold, structure, rename, select subtopics and add text', () => {
  const view = read('experiences/visual-map/view.ts');
  assert.match(view, /private openCardMoreMenu\(/);
  assert.match(view, /alignCardTools\(card: HTMLElement\)[\s\S]*placeCardTools\(card, tools/);
  const { translate } = load('i18n.ts');
  for (const lang of ['en', 'zh-TW', 'zh-CN']) for (const key of ['ui.card_more', 'ui.card_more_hint', 'ui.selection_more_hint', 'ui.selection_help_hint']) {
    assert.notEqual(translate(lang, key), key, `${lang} ${key}`);
  }
  const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  assert.match(css, /\.vam-node > \.vam-node-tools\.is-below \{[^}]*top: calc\(100% - 6px/);
  assert.match(css, /\.vam-node > \.vam-node-tools\.is-side-right \{/);
  assert.match(css, /\.vam-node > \.vam-node-tools\.is-side-left \{/);
  // A row beside the card keeps an invisible bridge over the gap, so the pointer does not leave the card on the way to it.
  assert.match(css, /\.vam-node > \.vam-node-tools\.is-side-left::after \{ left: 100%; \}/);
  // Leaving the card hides the row only after a moment, and it stays clickable meanwhile (visibility, not pointer-events, hides it).
  assert.match(css, /\.vam-node > \.vam-node-tools \{ position: absolute;[^}]*opacity: 0; visibility: hidden;[^}]*visibility 0s linear 300ms/);
  assert.doesNotMatch(css, /\.vam-node > \.vam-node-tools \{ position: absolute;[^}]*pointer-events: none/);
  assert.match(css, /\.vam-node\.is-selected > \.vam-node-tools \{ opacity: 1; visibility: visible; transform: none; transition-delay: 0s; \}/);
  assert.match(css, /\.vam-node > \.vam-node-tools\.is-side-right::after \{ right: 100%; \}/);
  assert.match(css, /is-side-right::after \{ content: ""; position: absolute;[^}]*width: calc\(var\(--vam-tools-gap, 4px\) \+ 6px\)/);
});
test('selection bar: nothing before the first card is picked; then a narrow bottom bar whose main button follows the count', () => {
  const view = bareView({ expansionBatches: new Map(), settings: { ...DEFAULT_SETTINGS, language: 'en' } }, { notes: new Map([['a', { title: 'A' }], ['b', { title: 'B' }]]), map: { nodes: [] } });
  view.mergeCheck = () => ({ ok: true }); view.multiResearchKey = () => 'k'; view.aimLive = () => false;
  const host = () => { const el = fakeEl(); el.toggleClass = (name, on) => (on ? el.classes.add(name) : el.classes.delete(name)); return el; };
  setSelection(view, true, []);
  const none = host(); const empty = view.renderSelectionBar(none);
  assert.equal(empty.children.length, 0, 'no content before a card is picked');
  assert.ok(empty.classes.has('is-empty')); assert.equal(none.classes.has('has-selection-bar'), false);
  const labels = bar => bar.children.filter(c => c.tag === 'button').map(c => c.text);
  setSelection(view, true, ['a']);
  const one = host(); const oneBar = view.renderSelectionBar(one);
  assert.deepEqual(labels(oneBar), ['Merge', 'Research', 'Move to…', '⋯ More', '?', 'Done selecting']);
  assert.ok(one.classes.has('has-selection-bar'));
  assert.ok(oneBar.children.find(c => c.text === 'Research').classes.has('mod-cta'));
  assert.equal(oneBar.children.find(c => c.text === 'Merge').classes.has('mod-cta'), false);
  setSelection(view, true, ['a', 'b']);
  const two = view.renderSelectionBar(host());
  assert.ok(two.children.find(c => c.text === 'Merge').classes.has('mod-cta'));
  assert.equal(two.children.find(c => c.text === 'Research').classes.has('mod-cta'), false);
  for (const button of two.children.filter(c => c.tag === 'button')) assert.ok(button.attrs['aria-label'] || button.text, 'every button is named');
  for (const name of ['more', 'help']) assert.ok(two.children.find(c => c.classes.has('vam-selection-' + name)).attrs['aria-label']);
  const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  assert.match(css, /^\.vam-selection-bar \{[^}]*bottom: 0; left: 0; right: 0;/m);
  assert.match(css, /^\.vam-selection-bar\.is-empty \{ display: none; \}/m);
  assert.match(css, /^\.vam-canvas\.has-selection-bar \{ padding-bottom: 44px;/m);
});

// F13b: Show all with a card selected whose tool row can only sit beside it (docked chat, canvas 640 wide at left 384).
function fitWithToolsFixture() {
  const { view } = makeView();
  const canvas = { left: 384, top: 126, right: 1024, bottom: 800 };
  const nodes = [{ id: 'c1', x: 0, y: 0 }, { id: 'c2', x: 0, y: 180 }, { id: 'c3', x: 0, y: 360 }, { id: 'c0', x: -360, y: 180 }]
    .map(n => ({ ...n, path: n.id + '.md', parentId: null }));
  view.map = { nodes, viewport: { x: 0, y: 0, zoom: 1 } };
  view.canvasNodes = () => nodes;
  delete view.transform; // the real transform: it re-aligns the open tool row, which can pan
  view.textEls = new Map(); view.summaryEls = new Map();
  view.viewportEl = { clientWidth: 640, clientHeight: 674, getBoundingClientRect: () => canvas };
  view.stageEl = { style: { setProperty() {} }, querySelector: () => null, setAttribute() {}, removeAttribute() {} };
  view.contentEl = { querySelector: () => null };
  view.canvasInsets = () => ({ top: 0, right: 0, bottom: 0, left: 0 });
  view.announcer = null;
  const style = { removeProperty() {}, setProperty() {} };
  const tools = { style, toggleClass() {}, getBoundingClientRect: () => ({ width: 173, height: 32 }) };
  const rectOf = node => { const v = view.map.viewport; const left = canvas.left + node.x * v.zoom + v.x, top = canvas.top + node.y * v.zoom + v.y; return { left, top, right: left + 280 * v.zoom, bottom: top + 180 * v.zoom, width: 280 * v.zoom, height: 180 * v.zoom }; };
  for (const node of nodes) view.cardEls.set(node.id, { isConnected: true, getBoundingClientRect: () => rectOf(node), querySelector: () => tools });
  view.selection.setSelected('c2');
  view.setupFloating = null;
  return { view, canvas, nodes, rectOf };
}
test('F13b: Show all keeps the fitted viewport when the selected card tool row would pan the canvas, and every card stays inside it', () => {
  const { view, canvas, nodes, rectOf } = fitWithToolsFixture();
  const fitted = inset.fitViewport({ minX: -360, minY: 0, maxX: 280, maxY: 540 }, { width: 640, height: 674 }, { top: 0, right: 0, bottom: 0, left: 0 });
  view.fit();
  assert.deepEqual({ ...view.map.viewport }, { ...fitted }, 'the viewport is the one fit computed');
  for (const node of nodes) {
    const r = rectOf(node);
    assert.ok(r.left >= canvas.left && r.right <= canvas.right && r.top >= canvas.top && r.bottom <= canvas.bottom, `card ${node.id} inside the canvas`);
  }
});
test('F13b: a user selection (not a framing action) still pans a card clear of the toolbar tool row', () => {
  const { view } = fitWithToolsFixture();
  view.map.viewport = { ...inset.fitViewport({ minX: -360, minY: 0, maxX: 280, maxY: 540 }, { width: 640, height: 674 }, { top: 0, right: 0, bottom: 0, left: 0 }) };
  const before = view.map.viewport.x;
  view.alignCardTools(view.cardEls.get('c2'));
  assert.notEqual(view.map.viewport.x, before, 'the canvas still pans outside a framing action');
});

// Review round 1, M3: framing a reply's ring with one to three cards must show the picture they circle too.
test('M3: fitCards on ring cards frames the picture as well, not only the cards (and plain fit-only frames are unchanged)', () => {
  const { view, nodes } = makeView();
  nodes[0].x = 0; nodes[0].y = 0; nodes[1].parentId = null; nodes[1].x = 0; nodes[1].y = 800;
  view.map.canvasItems = [{ id: 'img', kind: 'annotated-image', path: 'a.png', x: 100, y: 100, w: 720, h: 600, anchors: [{ id: 'p', at: { kind: 'image-2d', x: 0.5, y: 0.5 } }], relations: [{ kind: 'related', from: 'p', to: 'b', ring: true }] }];
  view.fitCards(new Set(['b']));
  const v = view.map.viewport;
  const inside = (x, y) => x * v.zoom + v.x >= -1e-6 && x * v.zoom + v.x <= 1000 + 1e-6 && y * v.zoom + v.y >= -1e-6 && y * v.zoom + v.y <= 600 + 1e-6;
  assert.ok(inside(100, 100) && inside(820, 700), 'both corners of the picture are on screen');
  assert.ok(inside(0, 800) && inside(280, 980), 'and so is the card');
  // A card that is no ring member frames only itself, as before.
  const other = makeView();
  other.nodes[1].x = 0; other.nodes[1].y = 800;
  other.view.map.canvasItems = [{ id: 'img', kind: 'annotated-image', path: 'a.png', x: 100, y: 100, w: 720, h: 600, anchors: [], relations: [] }];
  other.view.fitCards(new Set(['b']));
  const o = other.view.map.viewport;
  assert.ok(Math.abs(o.zoom - 1) < 1e-9 || o.zoom > v.zoom, 'the picture is not part of this frame');
});

test('F5: a tool row beside the card never covers the + button: the + sits above the row and its hover bridge', () => {
  const number = rule => Number((rule && rule[1]) || NaN);
  const row = css.match(/\.vam-node > \.vam-node-tools \{[^}]*z-index: (\d+)/);
  const plus = css.match(/\.vam-node > \.vam-node-tools\.is-side-right ~ \.vam-add-child \{[^}]*z-index: (\d+)/);
  assert.ok(row, 'the row has a stacking order');
  assert.ok(plus, 'a row on the right lifts the + button');
  assert.ok(number(plus) > number(row), 'the + is above the row');
});
