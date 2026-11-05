// Ticket 29: the Stop button on a card that is expanding says "Stop expanding", not "Stop research".
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./support.cjs');
const { TopicRuns, stopLabelKey } = load('experiences/visual-map/topic-run.ts', { obsidian: {} });
const dicts = [['en', load('i18n/en.ts').en], ['zh-TW', load('i18n/zh-TW.ts').zhTW], ['zh-CN', load('i18n/zh-CN.ts').zhCN]];

test('stopLabelKey: expansion gets its own label, research keeps the old one', () => {
  assert.equal(stopLabelKey('proposeChildren', false), 'ui.stop_expand');
  assert.equal(stopLabelKey(undefined, true), 'ui.stop_expand');
  assert.equal(stopLabelKey('research', false), 'ui.stop_research');
  assert.equal(stopLabelKey(undefined, false), 'ui.stop_research');
});

test('TopicRuns.runKind follows begin and release', () => {
  const runs = new TopicRuns({ running: () => new Set(), activeTasks: () => new Map() });
  const handle = runs.begin('a.md', 'proposeChildren');
  assert.equal(runs.runKind('a.md'), 'proposeChildren');
  handle.release();
  assert.equal(runs.runKind('a.md'), undefined);
});

test('ui.stop_expand exists in all three languages and differs from stop_research', () => {
  for (const [name, d] of dicts) {
    assert.ok(d['ui.stop_expand'], name);
    assert.notEqual(d['ui.stop_expand'], d['ui.stop_research'], name);
  }
});

// The test above only covers the helper. These render the card and read the button text the owner sees.
const { node, map, obsidian, DEFAULT_SETTINGS } = require('./support.cjs');
const element = tag => ({ tag, children: [], dataset: {}, style: {},
  createDiv(o) { const c = element('div'); c.cls = o?.cls ?? o; this.children.push(c); return c; },
  createEl(name, o) { const c = element(name); c.text = o?.text; c.cls = o?.cls; this.children.push(c); return c; },
  createSpan(o) { const c = element('span'); c.text = o?.text; c.cls = o?.cls; this.children.push(c); return c; },
  setAttr(n, v) { this[n] = v; }, addClass(n) { this.cls = n; }, addEventListener() {}, removeEventListener() {}, setPointerCapture() {}
});
const all = (root, pred) => [...(pred(root) ? [root] : []), ...root.children.flatMap(c => all(c, pred))];
function stopButtons(view, topic) {
  view.stageEl = element('stage'); view.renderNode(topic);
  return all(view.stageEl, e => e.tag === 'button' && /^Stop/.test(e.text ?? '')).map(e => e.text);
}
function cardView() {
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const topic = node('goal');
  const plugin = { repo: {}, settings: { ...DEFAULT_SETTINGS, language: 'en' }, expansionBatches: new Map(), running: new Set(), abortChartJobs() {}, addChartsAfterWrite() {}, quickExpandPending: new Set(), pendingSuggestions: new Map() };
  const view = new VisualAgentMapView({ app: {} }, plugin);
  view.map = map([topic]); view.notes = new Map([[topic.id, { title: 'Goal', summary: '', status: 'idea' }]]); view.render = () => {};
  return { view, topic, plugin };
}
test('rendered card: dialog-started expansion (quick outline, run not yet accepted) shows Stop expanding', () => {
  const { view, topic } = cardView();
  const hooks = view.backgroundHooks(topic.path, topic);
  hooks.begin(new AbortController(), 'expand');
  assert.deepEqual(stopButtons(view, topic), ['Stop expanding']);
  hooks.end();
  assert.deepEqual(stopButtons(view, topic), []);
});
test('rendered card: dialog-started research keeps Stop research', () => {
  const { view, topic } = cardView();
  const hooks = view.backgroundHooks(topic.path, topic);
  hooks.begin(new AbortController(), 'research');
  assert.deepEqual(stopButtons(view, topic), ['Stop research']);
  hooks.end();
  hooks.begin(new AbortController());
  assert.deepEqual(stopButtons(view, topic), ['Stop research']);
});
test('rendered card: proposeChildren run and quick-expand pending both show Stop expanding', () => {
  const { view, topic, plugin } = cardView();
  const handle = plugin.topicRuns.begin(topic.path, 'proposeChildren');
  plugin.topicRuns.controllers?.get?.(topic.path);
  view.startingTasks.set(topic.path, new AbortController());
  assert.deepEqual(stopButtons(view, topic), ['Stop expanding']);
  handle.release(); view.startingTasks.clear();
  plugin.quickExpandPending.add(topic.path);
  assert.deepEqual(stopButtons(view, topic), ['Stop expanding']);
});
