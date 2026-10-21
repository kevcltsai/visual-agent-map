// 0.25 WP1 map UI bugs: A8b connection check, A9 selection bar, D6a hint, A11 camera after a batch, A16 re-space.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const support = require('./support.cjs');
const { obsidian, fixture, topicNote, core, withExpansionCoordinator, DEFAULT_SETTINGS } = support;
const { load } = require('./support-replay.cjs');
const layout = load('map-layout.ts');
const root = path.join(__dirname, '..');

function fakeEl(tag = 'div', init = {}) {
  const el = { tag, children: [], attrs: {}, classes: new Set(), text: init.text, disabled: false, handlers: new Map(),
    createDiv(v) { return this.createEl('div', typeof v === 'string' ? { cls: v } : v); },
    createSpan(v) { return this.createEl('span', typeof v === 'string' ? { cls: v } : v); },
    createEl(name, v = {}) { const c = fakeEl(name, v); this.children.push(c); return c; },
    setAttr(k, v) { this.attrs[k] = v; }, addClass(...n) { n.forEach(x => this.classes.add(x)); },
    addEventListener(name, h) { this.handlers.set(name, h); } };
  return el;
}

function bareView(plugin, extra = {}) {
  const { VisualAgentMapView } = load('experiences/visual-map/view.ts', { obsidian: { ...obsidian, Component: class {}, MarkdownRenderChild: class {} } }, { window: { setTimeout, clearTimeout }, CSS: { escape: s => s } });
  return Object.assign(Object.create(VisualAgentMapView.prototype), { plugin, renderingCard: false, ...extra });
}

test('A8b: the sample-start check button follows the chosen model: Claude Code repairs the Claude connection, Codex rechecks Codex', () => {
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

test('A9/D6a: the selection bar is left-anchored above the zoom cluster, names on their own line, and select mode draws no hint', () => {
  const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  const bar = css.split('\n').find(line => line.startsWith('.vam-selection-bar {'));
  assert.ok(bar && !/translateX/.test(bar) && /left: 16px/.test(bar) && /bottom: 64px/.test(bar), 'left-anchored, clear of the bottom-right zoom controls');
  const names = css.split('\n').find(line => line.startsWith('.vam-selection-bar > span'));
  assert.match(names, /flex: 0 0 100%/); assert.match(names, /text-overflow: ellipsis/);
  const source = fs.readFileSync(path.join(root, 'experiences/visual-map/view.ts'), 'utf8');
  assert.match(source, /!this\.integrationMode && !this\.plugin\.settings\.canvasHintSeen/, 'no hint while selecting topics');
});

test('A9: bar children keep the same order and fixed labels at counts 0-3 (names span first)', () => {
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

test('A11: a child batch frames the parent and every new child without Show all, and addNode(focus=false) leaves the camera alone', async () => {
  const { repo, app } = fixture(), parent = await topicNote(repo, 'Parent', 'a');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md';
  const mapDoc = { id: 'map-a', title: 'map-a', version: 1, nodes: [parent], viewport: { x: 40, y: 40, zoom: 1 } };
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const { VisualAgentMapView } = load('main.ts', { obsidian: { ...obsidian, Component: class {}, MarkdownRenderChild: class {} } });
  const view = new VisualAgentMapView({ app }, withExpansionCoordinator({ repo, settings: { ...DEFAULT_SETTINGS }, rebuildDerivedData: async () => {}, mutate: async fn => fn() }));
  let focused = 0;
  Object.assign(view, { path: mapPath, map: mapDoc, render: () => {}, hydrate: async () => {}, focusNode: () => { focused++; }, saveViewport: () => {}, canvasInset: () => 58,
    viewportEl: { clientWidth: 1000, clientHeight: 700 } });
  const items = ['One', 'Two', 'Three', 'Four', 'Five', 'Six'].map(title => ({ title, task: title, contribution: '' }));
  await view.createChildBatch(parent, items);
  assert.equal(focused, 0, 'no per-child focus on the pre-layout position');
  const { x, y, zoom } = view.map.viewport;
  for (const node of view.map.nodes) {
    const h = view.cardHeightOf(node.id) ?? 180;
    assert.ok(node.x * zoom + x >= 0 && (node.x + 280) * zoom + x <= 1000, `${node.id} horizontally visible`);
    assert.ok(node.y * zoom + y >= 58 && (node.y + h) * zoom + y <= 700, `${node.id} vertically visible below the toolbar`);
  }
  assert.ok(zoom <= 1);
});

test('A16: after quick research the untouched batch cards are re-spaced against measured heights; a dragged card and siblings stay', async () => {
  const mk = (id, parentId, x, y) => ({ id, path: `${id}.md`, parentId, x, y, collapsed: false });
  const nodes = [mk('p', null, 0, 0), mk('s', 'p', 340, 0), mk('c1', 'p', 340, 220), mk('c2', 'p', 340, 440), mk('c3', 'p', 340, 660)];
  const heights = { p: 180, s: 180, c1: 180, c2: 180, c3: 180 };
  const writes = [];
  const view = bareView({ mutate: async fn => fn(), repo: { updateMap: async (p, fn) => { const doc = { nodes: JSON.parse(JSON.stringify(view.map.nodes)) }; fn(doc); writes.push(doc.nodes); } } },
    { map: { nodes }, closed: false, builtIn: false, path: 'Map.md', cardHeightOf: id => heights[id] });
  const placed = new Map(['c1', 'c2', 'c3'].map(id => [id, { x: 340, y: nodes.find(n => n.id === id).y }]));
  Object.assign(heights, { c1: 500, c2: 500, c3: 500 }); // research filled the cards
  nodes.find(n => n.id === 'c3').y = 1234; // the user dragged c3
  await view.respaceBatch(nodes[0], placed);
  assert.equal(writes.length, 1, 'one Map.md write');
  const by = Object.fromEntries(view.map.nodes.map(n => [n.id, n]));
  assert.equal(by.c3.y, 1234, 'dragged card stays');
  assert.equal(by.s.y, 0, 'sibling stays');
  const flow = ['s', 'c1', 'c2'].map(id => by[id]).sort((a, b) => a.y - b.y);
  for (let i = 1; i < flow.length; i++) assert.ok(flow[i].y >= flow[i - 1].y + heights[flow[i - 1].id], `no overlap ${flow[i - 1].id}/${flow[i].id}`);
  await view.respaceBatch(nodes[0], placed);
  assert.equal(writes.length, 1, 'a second pass with nothing left to move writes nothing');
});
