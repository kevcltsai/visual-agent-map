// P6: the floating toolbar must not cover the canvas origin, and keyboard navigation must not write the viewport.
// Also the map canvas chrome: connection-check button, selection bar, empty-map hint, text direction, selection prune, hover wrap.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const support = require('./support.cjs');
const { obsidian, DEFAULT_SETTINGS } = support;
const { load } = require('./support-replay.cjs');

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
  return Object.assign(Object.create(VisualAgentMapView.prototype), { plugin, renderingCard: false, ...extra });
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

function makeView() {
  const { VisualAgentMapView } = load('experiences/visual-map/view.ts', { obsidian: { ...obsidian, Component: class {}, MarkdownRenderChild: class {} } }, { window: { setTimeout, clearTimeout }, CSS: { escape: s => s } });
  const writes = [];
  const view = Object.create(VisualAgentMapView.prototype);
  const nodes = [
    { id: 'a', path: 'a.md', parentId: null, x: 0, y: 0 },
    { id: 'b', path: 'b.md', parentId: 'a', x: 400, y: 2000 }
  ];
  Object.assign(view, {
    map: { nodes, viewport: { x: 40, y: 40, zoom: 1 } },
    builtIn: false, integrationMode: false, multiSelected: new Set(), selected: 'a', cardEls: new Map(),
    plugin: { repo: { updateMap: async (...args) => { writes.push(args); } }, mutate: async fn => { await fn(); } },
    viewportEl: { clientWidth: 1000, clientHeight: 600, getBoundingClientRect: () => ({ left: 0, top: 0, right: 1000, bottom: 600 }) },
    stageEl: { style: {}, querySelector: () => null },
    contentEl: { querySelector: () => ({ getBoundingClientRect: () => ({ top: 12, bottom: 50 }) }) },
    path: 'Map.md', viewportTimer: null, viewportQueued: false, history: {}
  });
  view.cardEls.set('b', { getBoundingClientRect: () => ({ left: 400, right: 680, top: 2000, bottom: 2180 }), focus() {} });
  view.relevanceSortOn = () => false;
  view.canvasNodes = () => nodes;
  view.transform = () => {};
  view.selectMapNode = node => { view.selected = node.id; };
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

test('the empty-map hint ignores pointer events but its Topic button receives them', () => {
  assert.match(rule('.vam-empty'), /pointer-events: none/);
  assert.match(rule('.vam-empty button'), /pointer-events: auto/);
});


test('the selection bar joins names with the localized list separator and reads each name direction-aware', () => {
  const titles = new Map([['a', { title: 'Alpha' }], ['b', { title: 'שלום' }], ['c', { title: 'C' }]]);
  const view = bareView({ expansionBatches: new Map(), settings: { ...DEFAULT_SETTINGS, language: 'en' } }, { builtIn: false, notes: titles, map: { nodes: [] }, multiSelected: new Set(['a', 'b', 'c']) });
  view.mergeCheck = () => ({ ok: true }); view.multiResearchKey = () => 'k';
  const bar = view.renderSelectionBar(fakeEl());
  const names = bar.children[0];
  assert.ok(names.text.includes('Alpha, שלום'), names.text);
  assert.ok(!names.text.includes('、'));
  const { translate } = load('i18n.ts');
  assert.equal(translate('en', 'ui.list_separator'), ', ');
  assert.equal(translate('zh-TW', 'ui.list_separator'), '、');
});


test('card title, map title, inspector title, outline rows and parent-picker rows carry dir="auto"; rows align to the start edge', () => {
  const view = read('experiences/visual-map/view.ts');
  assert.match(view, /title\.setAttr\("dir", "auto"\)/);
  assert.match(view, /cls: "vam-map-title", attr: \{ dir: "auto" \}/);
  assert.match(view, /panel\.createEl\("h3", \{ text: note\.title, attr: \{ dir: "auto" \} \}\)/);
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
  assert.match(view, /this\.multiSelected = new Set\(\[\.\.\.this\.multiSelected\]\.filter\(id => shown\.some/);
  const reset = view.indexOf('if (!this.map.nodes.length && !this.builtIn) {\n      this.integrationMode = false;');
  const toolbar = view.indexOf('const tools = createDiv("vam-map-tools");');
  assert.ok(reset > 0 && reset < toolbar, 'reset must precede the toolbar that reads integrationMode');
  assert.match(view.slice(reset, toolbar), /this\.multiSelected\.clear\(\)/);
});


test('a very long word in the hover preview title wraps instead of clipping', () => {
  assert.match(rule('.vam-hover-card strong'), /overflow-wrap: anywhere/);
});

test('the sample-start check button follows the chosen model: Claude Code repairs the Claude connection, Codex rechecks Codex', () => {
  for (const [cliModel, label, call] of [['claude:sonnet', 'Check Claude Code', 'repair'], ['gpt-test', 'Check Codex', 'recheckCodex']]) {
    const calls = [];
    const plugin = { settings: { ...DEFAULT_SETTINGS, language: 'en', cliModel, models: '' }, repairConnection: () => calls.push('repair'), recheckCodex: () => { calls.push('recheckCodex'); return Promise.resolve(); } };
    const view = bareView(plugin, { enqueue: work => work() });
    const button = view.renderConnectionCheck(fakeEl());
    assert.equal(button.text, label);
    button.handlers.get('click')({ stopPropagation() {} });
    assert.deepEqual(calls, [call]);
  }
  const { translate } = load('i18n.ts');
  assert.equal(translate('zh-TW', 'ui.check_claude_code'), '檢查 Claude Code');
});


test('the selection bar is left-anchored above the zoom cluster, names on their own line, and select mode draws no hint', () => {
  const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  const bar = css.split('\n').find(line => line.startsWith('.vam-selection-bar {'));
  assert.ok(bar && !/translateX/.test(bar) && /left: 16px/.test(bar) && /bottom: 64px/.test(bar), 'left-anchored, clear of the bottom-right zoom controls');
  const names = css.split('\n').find(line => line.startsWith('.vam-selection-bar > span'));
  assert.match(names, /flex: 0 0 100%/); assert.match(names, /text-overflow: ellipsis/);
  const source = fs.readFileSync(path.join(root, 'experiences/visual-map/view.ts'), 'utf8');
  assert.match(source, /!this\.integrationMode && !this\.plugin\.settings\.canvasHintSeen/, 'no hint while selecting topics');
});


test('bar children keep the same order and fixed labels at counts 0-3 (names span first)', () => {
  const view = bareView({ expansionBatches: new Map(), settings: { ...DEFAULT_SETTINGS, language: 'en' } }, { builtIn: false, multiSelected: new Set(), notes: new Map([['a', { title: 'A very long title '.repeat(8) }], ['b', { title: 'B' }], ['c', { title: 'C' }]]), map: { nodes: [] } });
  view.mergeCheck = () => ({ ok: true }); view.multiResearchKey = () => 'k';
  const shapes = [];
  for (const ids of [[], ['a'], ['a', 'b'], ['a', 'b', 'c']]) {
    view.multiSelected = new Set(ids);
    const bar = view.renderSelectionBar(fakeEl());
    assert.equal(bar.children[0].tag, 'span');
    shapes.push(bar.children.slice(1).map(c => c.text).join('|'));
  }
  assert.equal(new Set(shapes).size, 1, shapes.join(' / '));
});

