// Ticket 19: "Duplicate current mind map" in the ⋯ menu copies a map with its notes; the copy is independent.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, load, DEFAULT_SETTINGS, obsidian } = require('./support.cjs');
const dom = require('./support-dom.cjs');

async function sourceMap() {
  const data = fixture('en'), { repo, contents } = data;
  const mapPath = await repo.createMap('Trip');
  let map = await repo.readMap(mapPath);
  const root = await repo.createNote('Root', 'model-a', map, mapPath, 'workspace');
  const child = await repo.createNote('Child', 'model-a', map, mapPath, 'workspace');
  child.parentId = root.id; child.x = 400;
  map.nodes.push(root, child);
  map.topicRelations = [{ kind: 'supports', from: child.id, to: root.id }];
  map.canvasItems = [{ id: 'b1', kind: 'boundary', members: [root.id, child.id] }];
  await repo.saveMap(mapPath, map);
  await repo.updateNote(child.path, { detail: 'Original detail' });
  return { ...data, mapPath, map: await repo.readMap(mapPath), root, child };
}

test('19 duplicateMap: copies the map and every note under new ids; the source is untouched', async () => {
  const { repo, contents, mapPath, map } = await sourceMap();
  const before = new Map([...contents].filter(([p]) => p.startsWith('Mind Maps/Trip/') || p.includes('/Trip/')));
  const copyPath = await repo.duplicateMap(mapPath, 'Trip copy');
  assert.notEqual(copyPath, mapPath);
  const copy = await repo.readMap(copyPath);
  assert.equal(copy.title, 'Trip copy'); assert.notEqual(copy.id, map.id);
  assert.equal(copy.nodes.length, 2);
  const oldIds = new Set(map.nodes.map(n => n.id)), oldPaths = new Set(map.nodes.map(n => n.path));
  for (const node of copy.nodes) { assert.equal(oldIds.has(node.id), false); assert.equal(oldPaths.has(node.path), false); assert.ok(contents.has(node.path)); assert.ok(node.path.startsWith(copyPath.replace('/Map.md', '/Notes/'))); }
  const [root, child] = copy.nodes;
  assert.equal(root.parentId, null); assert.equal(child.parentId, root.id); assert.equal(child.x, 400);
  assert.deepEqual(JSON.parse(JSON.stringify(copy.topicRelations)), [{ kind: 'supports', from: child.id, to: root.id }]);
  assert.deepEqual(JSON.parse(JSON.stringify(copy.canvasItems[0].members)), [root.id, child.id]);
  assert.match(contents.get(child.path), /Original detail/);
  assert.match(contents.get(child.path), new RegExp(`topic-id: ${copy.id}`));
  for (const [path, text] of before) assert.equal(contents.get(path), text, `${path} unchanged`);
});

test('19 duplicateMap: editing the copy never changes the original', async () => {
  const { repo, mapPath, map, child } = await sourceMap();
  const copy = await repo.readMap(await repo.duplicateMap(mapPath, 'Trip copy'));
  await repo.updateNote(copy.nodes[1].path, { detail: 'Changed in copy' });
  await repo.updateMap(`${copy.nodes[1].path.split('/Notes/')[0]}/Map.md`, m => { m.nodes.pop(); });
  assert.match((await repo.readNote(child.path)).detail, /Original detail/);
  assert.equal((await repo.readMap(mapPath)).nodes.length, map.nodes.length);
});

test('19 duplicateMap: an AIM map is refused', async () => {
  const { repo, mapPath } = await sourceMap();
  await repo.updateMap(mapPath, m => { m.aim = { runs: [], branches: [] }; });
  await assert.rejects(() => repo.duplicateMap(mapPath, 'x'));
});

function makeView(existing, mapOverrides = {}) {
  const calls = [], opened = [], items = [];
  class Menu { addItem(fn) { const item = { title: '', setTitle(t) { this.title = t; return this; }, setIcon() { return this; }, onClick(f) { this.fn = f; return this; }, setWarning() { return this; } }; fn(item); items.push(item); } addSeparator() {} showAtPosition() {} showAtMouseEvent() {} }
  const { VisualAgentMapView } = load('main.ts', { obsidian: { ...obsidian, Menu } }, { createFragment: dom.createFragment });
  const plugin = { settings: { ...DEFAULT_SETTINGS, language: 'en' }, repo: { topics: async () => existing.map(t => ({ title: t })), duplicateMap: async (p, t) => { calls.push([p, t]); return `${t}/Map.md`; } }, mutate: async w => w() };
  const view = new VisualAgentMapView({ app: {} }, plugin);
  view.openMapInMutation = async p => { opened.push(p); };
  view.map = { id: 'm', title: 'Trip', nodes: [], ...mapOverrides }; view.path = 'Agent Workspace/Mind Maps/Trip/Map.md';
  return { view, calls, opened, items };
}

test('19 ⋯ menu: "Duplicate current mind map" copies as "<title> copy", then " 1" when taken, and opens the copy', async () => {
  for (const [existing, expected] of [[['Trip'], 'Trip copy'], [['Trip', 'Trip copy'], 'Trip copy 1']]) {
    const { view, calls, opened, items } = makeView(existing);
    view.openMapActions();
    const item = items.find(i => i.title === 'Duplicate current mind map');
    assert.ok(item, 'menu entry exists');
    item.fn(); await dom.tick(); await dom.tick();
    assert.deepEqual(calls, [['Agent Workspace/Mind Maps/Trip/Map.md', expected]]);
    assert.deepEqual(opened, [`${expected}/Map.md`]);
  }
});

test('19 ⋯ menu: no duplicate entry for an AIM map', () => {
  const { view, items } = makeView([], { aim: { runs: [], branches: [] } });
  view.openMapActions();
  assert.equal(items.some(i => /Duplicate/.test(i.title)), false);
});

test('19 i18n: the new text exists in en, zh-TW and zh-CN', () => {
  for (const file of ['en', 'zh-TW', 'zh-CN']) {
    const table = Object.values(load(`i18n/${file}.ts`)).find(v => v && typeof v === 'object' && 'ui.rename_current_mind_map' in v);
    for (const key of ['ui.duplicate_current_mind_map', 'ui.duplicate_map_title', 'error.duplicate_map_unsupported']) assert.ok(table[key], `${file} ${key}`);
  }
});

test('P6 A15 duplicateMap: the ring flag and the top-level topics of an annotated image survive, anchor relations follow the new topic ids', async () => {
  const { repo, mapPath, map, root, child } = await sourceMap();
  map.canvasItems = [{
    id: 'img1', kind: 'annotated-image', path: 'Pics/a.png', x: 0, y: 0, w: 200, h: 100, note: '',
    anchors: [{ id: 'a1', at: { kind: 'image-2d', x: 0.2, y: 0.2 } }, { id: 'a2', at: { kind: 'image-2d', x: 0.8, y: 0.2 } }],
    relations: [{ kind: 'related', from: 'a1', to: root.id, ring: true }, { kind: 'related', from: 'a2', to: child.id }]
  }];
  for (const n of map.nodes) n.parentId = null;
  await repo.saveMap(mapPath, map);
  const copy = await repo.readMap(await repo.duplicateMap(mapPath, 'Trip copy'));
  const [r1, r2] = copy.nodes;
  assert.equal(r1.parentId, null); assert.equal(r2.parentId, null);
  const rels = JSON.parse(JSON.stringify(copy.canvasItems.find(i => i.kind === 'annotated-image').relations));
  assert.deepEqual(rels, [{ kind: 'related', from: 'a1', to: r1.id, ring: true }, { kind: 'related', from: 'a2', to: r2.id }]);
});
