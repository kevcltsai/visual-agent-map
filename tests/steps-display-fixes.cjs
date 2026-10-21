// 0.25 WP-F3 display fixes: FG20-05 empty-map button, FG20-11 text direction + list separator, FG20-16 Turkish I fold, FG20-23 selection prune, FG20-26 hover wrap.
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

test('FG20-05: the empty-map hint ignores pointer events but its Topic button receives them', () => {
  assert.match(rule('.vam-empty'), /pointer-events: none/);
  assert.match(rule('.vam-empty button'), /pointer-events: auto/);
});

test('FG20-11: the selection bar joins names with the localized list separator and reads each name direction-aware', () => {
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

test('FG20-11: card title, map title, inspector title, outline rows and parent-picker rows carry dir="auto"; rows align to the start edge', () => {
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

test('FG20-11: the topic tree rows get dir="auto" when built', () => {
  const { renderTopicTree } = load('ui/topic-tree.ts');
  const rows = [];
  const tree = fakeEl();
  tree.createEl = (name, v) => { const c = fakeEl(name, v); c.style = {}; c.dataset = {}; rows.push(c); return c; };
  const host = fakeEl(); host.createDiv = () => tree;
  renderTopicTree(host, { nodes: [{ id: 'a', parentId: null, path: 'a.md' }], title: () => 'שלום', label: 'l', selectable: () => true, onChoose() {}, rootChoice: 'None' });
  assert.equal(rows.length, 2);
  for (const row of rows) assert.equal(row.attrs.dir, 'auto');
});

test('FG20-16: outline search folds Turkish İ to i and keeps ordinary case folding', () => {
  const { foldOutlineSearch } = load('ui/outline-view.ts', { obsidian: { ...obsidian, ItemView: class {}, Notice: class {} } });
  assert.ok(foldOutlineSearch('İstanbul').includes(foldOutlineSearch('istanbul')));
  assert.ok(foldOutlineSearch('İSTANBUL').includes('istanbul'));
  assert.equal(foldOutlineSearch('Alpha'), 'alpha');
  assert.ok(foldOutlineSearch('Zürich').includes('zü'));
  assert.ok(!foldOutlineSearch('Berlin').includes('istanbul'));
});

test('FG20-23: render prunes multiSelected to existing nodes and leaves selecting mode on an empty map before the toolbar is built', () => {
  const view = read('experiences/visual-map/view.ts');
  assert.match(view, /this\.multiSelected = new Set\(\[\.\.\.this\.multiSelected\]\.filter\(id => shown\.some/);
  const reset = view.indexOf('if (!this.map.nodes.length && !this.builtIn) {\n      this.integrationMode = false;');
  const toolbar = view.indexOf('const tools = createDiv("vam-map-tools");');
  assert.ok(reset > 0 && reset < toolbar, 'reset must precede the toolbar that reads integrationMode');
  assert.match(view.slice(reset, toolbar), /this\.multiSelected\.clear\(\)/);
});

test('FG20-26: a very long word in the hover preview title wraps instead of clipping', () => {
  assert.match(rule('.vam-hover-card strong'), /overflow-wrap: anywhere/);
});
