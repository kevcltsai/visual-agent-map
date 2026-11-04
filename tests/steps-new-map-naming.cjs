// Ticket 21: "New map" asks no name (an untitled map opens at once), the first chat reply names it, the title renames in place.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, DEFAULT_SETTINGS, obsidian } = require('./support.cjs');
const dom = require('./support-dom.cjs');

const names = load('core/default-names.ts');

test('21 names: first "Untitled mind map", then " 1", " 2" (gaps are reused, other names ignored)', () => {
  assert.equal(names.uniqueDefaultName('Untitled mind map', []), 'Untitled mind map');
  assert.equal(names.uniqueDefaultName('Untitled mind map', ['Untitled mind map']), 'Untitled mind map 1');
  assert.equal(names.uniqueDefaultName('未命名心智圖', ['未命名心智圖', '未命名心智圖 1', 'Other']), '未命名心智圖 2');
  assert.equal(names.uniqueDefaultName('New topic', ['New topic', 'New topic 2']), 'New topic 1');
});

test('21 names: only a placeholder name (any interface language, optional number) counts as "never named"', () => {
  const is = title => names.isPlaceholderMapTitle(title, names.PLACEHOLDER_MAP_NAMES);
  for (const title of ['Untitled mind map', 'Untitled mind map 3', '未命名心智圖', '未命名心智圖 1', '未命名心智图 2']) assert.equal(is(title), true, title);
  for (const title of ['Phone design', 'Untitled mind map x', 'Untitled mind map 1 2', '未命名心智圖X', '']) assert.equal(is(title), false, title);
});

test('21 names: the placeholder list matches ui.untitled_mind_map in every language', () => {
  const { en } = load('i18n/en.ts'), tw = load('i18n/zh-TW.ts')['zhTW'] ?? Object.values(load('i18n/zh-TW.ts'))[0], cn = Object.values(load('i18n/zh-CN.ts'))[0];
  assert.deepEqual([...names.PLACEHOLDER_MAP_NAMES].sort(), [en['ui.untitled_mind_map'], tw['ui.untitled_mind_map'], cn['ui.untitled_mind_map']].sort());
});

function makeView({ existing = [], title = 'Untitled mind map' } = {}) {
  const created = [], opened = [], modals = [];
  class Modal { constructor() { modals.push(this); } open() {} close() {} }
  const { VisualAgentMapView } = load('main.ts', { obsidian: { ...obsidian, Modal } }, { createFragment: dom.createFragment });
  const plugin = { settings: { ...DEFAULT_SETTINGS, language: 'en' }, repo: { topics: async () => existing.map(t => ({ title: t })), createMap: async t => { created.push(t); return `${t}/Map.md`; } }, mutate: async work => work() };
  const view = new VisualAgentMapView({ app: {} }, plugin);
  view.openMapInMutation = async path => { opened.push(path); };
  view.map = { id: 'm', title, nodes: [] }; view.path = 'Maps/Untitled mind map/Map.md';
  return { view, created, opened, modals };
}

test('21 New map: no name dialog; an untitled map is created and opened; the second is "Untitled mind map 1"', async () => {
  const first = makeView();
  first.view.openNewMindMapModal(); await dom.tick(); await dom.tick();
  assert.deepEqual(first.created, ['Untitled mind map']); assert.equal(first.opened.length, 1); assert.equal(first.modals.length, 0, 'no NameModal');
  const second = makeView({ existing: ['Untitled mind map'] });
  second.view.openNewMindMapModal(); await dom.tick(); await dom.tick();
  assert.deepEqual(second.created, ['Untitled mind map 1']);
});

test('21 chat rename_map: a placeholder-named map is renamed, the reply anchor follows the new folder; a name the user chose stays', async () => {
  for (const [title, expected] of [['Untitled mind map', 'done'], ['未命名心智圖 2', 'done'], ['My own name', 'skipped']]) {
    const { view } = makeView({ title });
    const renamed = [];
    view.renameMapTo = async name => { renamed.push(name); view.path = `Maps/${name}/Map.md`; };
    const anchor = { path: view.path, id: 'm' };
    const outcome = await view.chatRenameMap('Phone design', anchor, () => true);
    assert.equal(outcome.status, expected, title);
    if (expected === 'done') { assert.deepEqual(renamed, ['Phone design']); assert.equal(anchor.path, 'Maps/Phone design/Map.md', 'the anchor moved'); }
    else assert.deepEqual(renamed, [], 'no rename of a name the user chose');
  }
});
