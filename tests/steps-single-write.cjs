// V3.3 B30 (P1.3 寫入不重複): adding a card writes Map.md once (camera move included) and is one undo step;
// moving a card on the canvas writes Map.md once and no topic note (a sibling re-order writes only the parent's child list). A real view and Repository over a fake vault
// (harness as in tests/steps-layout-history.cjs), with focusNode and the debounced viewport save left real.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, fixture, DEFAULT_SETTINGS, obsidian, withExpansionCoordinator, core } = require('./support.cjs');
const dom = require('./support-dom.cjs');
const { element } = dom;
const MAP = 'Agent Workspace/Topics/map-w/Map.md';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function harness(spec) {
  const { repo, app, contents } = fixture('en', { linkIndex: true });
  const settings = { ...DEFAULT_SETTINGS, language: 'en', cliModel: 'gpt-6-luna' };
  repo.settings = settings;
  const mapDoc = { id: 'map-w', title: 'Writes', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  await repo.ensureTopicFolders('Agent Workspace/Topics/map-w');
  const byTitle = new Map();
  for (const [title, parentTitle, x, y] of spec) {
    const node = await repo.createNote(title, 'gpt-6-luna', mapDoc, MAP, 'workspace');
    Object.assign(node, { parentId: parentTitle ? byTitle.get(parentTitle).id : null, x, y });
    byTitle.set(title, node);
    mapDoc.nodes.push(node);
  }
  await app.vault.create(MAP, core.serializeMap(mapDoc));
  await repo.rebuildDerivedData();
  // Every write, in order: [path, content after].
  const writes = [];
  const process = app.vault.process;
  app.vault.process = async (file, change) => {
    await process(file, change);
    writes.push([file.path, contents.get(file.path)]);
  };
  const Base = dom.makeModal();
  class Modal extends Base { open() { super.open(); this.close(); } }
  const { VisualAgentMapView } = load('main.ts', { obsidian: { ...obsidian, AbstractInputSuggest: class { constructor(app, input) { this.inputEl = input; } close() {} }, Modal, Notice: dom.makeNotice([]) } }, { createFragment: dom.createFragment, createSvg: tag => ({ tag, attrs: {}, classes: [], children: [], setAttribute(n, v) { this.attrs[n] = v; }, addClass(n) { this.classes.push(n); }, appendChild(c) { this.children.push(c); } }) });
  const plugin = withExpansionCoordinator({
    repo, settings, running: new Set(), logs: { appendLog() {} }, rebuildDerivedData: () => repo.rebuildDerivedData(), expansionBatches: new Map(), pendingSuggestions: new Map(), releaseOutline() {}, setOutlineActive() {}, detailsShown: () => false,
    mutate: async fn => fn()
  });
  const view = new VisualAgentMapView({ app }, plugin);
  view.path = MAP; view.map = await repo.readMap(MAP); view.contentEl = element('div'); view.stageEl = element('div');
  // A shown canvas of a fixed size: focusNode moves the camera for real and saves it like a pan.
  view.viewportEl = { clientWidth: 1200, clientHeight: 800 };
  view.transform = () => {}; view.openDetails = () => {}; view.render = () => {};
  view.notes = new Map(await Promise.all(view.map.nodes.map(async n => [n.id, await repo.readNote(n.path)])));
  view.cardHeightOf = () => 180;
  const node = title => view.map.nodes.find(n => view.notes.get(n.id)?.title === title);
  const mapWrites = () => writes.filter(([p]) => p === MAP);
  const noteWrites = () => writes.filter(([p]) => p !== MAP && p.includes('/Notes/'));
  return { repo, app, contents, view, node, writes, mapWrites, noteWrites };
}

test('B30: a new card (child or sibling) writes Map.md once (the camera follows in memory) and one undo removes it', async () => {
  for (const sibling of [false, true]) {
    const h = await harness([['Root', null, 80, 80], ['Kid', 'Root', 420, 80]]);
    const before = h.contents.get(MAP);
    h.writes.length = 0;
    const parent = sibling ? h.node('Root') : h.node('Kid');
    await h.view.addNode(parent);
    // The pan/zoom save is debounced (250 ms): wait past it so a second write would be seen.
    await wait(400);
    const label = sibling ? 'sibling' : 'child';
    assert.equal(h.mapWrites().length, 1, `${label}: Map.md written ${h.mapWrites().length} times`);
    const disk = core.parseMap(h.contents.get(MAP));
    assert.notEqual(JSON.stringify(h.view.map.viewport), JSON.stringify({ x: 0, y: 0, zoom: 1 }), `${label}: the camera moved to the new card`);
    assert.equal(JSON.stringify(disk.viewport), JSON.stringify({ x: 0, y: 0, zoom: 1 }), `${label}: the camera is not written by the add`);
    assert.equal(disk.nodes.length, 3);
    h.writes.length = 0;
    await h.view.travel(false);
    await wait(400);
    assert.equal(h.view.history.canUndo, false, `${label}: one undo step`);
    assert.equal(h.view.map.nodes.length, 2, `${label}: undo removed the card`);
    assert.deepEqual(core.parseMap(h.contents.get(MAP)).nodes, core.parseMap(before).nodes, `${label}: undo restored the map`);
  }
});

test('B28 fix: a new card at 41% keeps the zoom (the camera only pans) and the new card is on screen', async () => {
  for (const sibling of [false, true]) {
    const h = await harness([['Root', null, 80, 80], ['Kid', 'Root', 420, 80]]);
    h.view.map.viewport = { x: 0, y: 0, zoom: 0.41 };
    const ids = new Set(h.view.map.nodes.map(n => n.id));
    await h.view.addNode(sibling ? h.node('Root') : h.node('Kid'));
    const placed = h.view.map.nodes.find(n => !ids.has(n.id));
    const label = sibling ? 'sibling' : 'child';
    const v = h.view.map.viewport;
    assert.equal(v.zoom, 0.41, `${label}: zoom stays at 41%`);
    const left = placed.x * v.zoom + v.x, top = placed.y * v.zoom + v.y;
    assert.ok(left >= 0 && left + 280 * v.zoom <= 1200 && top >= 0 && top + 180 * v.zoom <= 800, `${label}: the new card is inside the 1200x800 canvas`);
    await wait(400);
  }
});

test('B30: moving a card without crossing a sibling writes Map.md once and no topic note', async () => {
  const h = await harness([['Root', null, 80, 80], ['A', 'Root', 420, 80], ['B', 'Root', 420, 300], ['C', 'Root', 420, 520]]);
  h.writes.length = 0;
  const b = h.node('B');
  const edit = h.view.cardDropEdit(b.id, { x: 460, y: 320 }, 460 + 150);
  await h.view.mapChange(edit);
  await wait(400);
  assert.equal(h.mapWrites().length, 1, 'one Map.md write');
  assert.deepEqual(h.noteWrites().map(([p]) => p), [], 'no topic note written by a plain move');
});

test('B30: a drop that passes a sibling re-orders the siblings, so only their parent note is written: its child list order', async () => {
  // Reference metadata is derived from Map.md (storage-data: save the Map, then rebuild the references); the parent's
  // "Child topics" line follows the sibling order, so a re-order rewrites that one line in that one note, nothing else.
  const h = await harness([['Root', null, 80, 80], ['A', 'Root', 420, 80], ['B', 'Root', 420, 300], ['C', 'Root', 420, 520]]);
  const root = h.node('Root');
  const before = h.contents.get(root.path);
  h.writes.length = 0;
  await h.view.mapChange(h.view.cardDropEdit(h.node('B').id, { x: 440, y: 700 }, 590));
  await wait(400);
  assert.equal(h.mapWrites().length, 1, 'one Map.md write');
  assert.deepEqual(h.noteWrites().map(([p]) => p), [root.path], 'only the parent note');
  const changed = (a, b) => a.split('\n').filter((line, i) => line !== b.split('\n')[i]);
  const lines = changed(before, h.contents.get(root.path));
  assert.equal(lines.length, 2, 'the frontmatter reference and the body reference line');
  for (const line of lines) assert.match(line, /Child topics: \[\[.*\/A\]\], \[\[.*\/B\]\], \[\[.*\/C\]\]/);
  assert.match(h.contents.get(root.path), /Child topics: \[\[.*\/A\]\], \[\[.*\/C\]\], \[\[.*\/B\]\]/);
});

// B31: pasting branches and importing an outline into the open map write Map.md once too (camera follows in memory).
const clip = (...titles) => ({ format: 'vam-branch', version: 1, clipId: 'clip-b31', relations: [], nodes: titles.map((title, i) => ({ id: `c${i}`, parent: i === 0 ? null : 'c0', title, kind: 'topic', body: '' })) });
const outlineOf = (...titles) => titles.map((title, index) => ({ index, title, level: index ? 2 : 1, parent: index ? 0 : null, line: index }));

test('B31: pasting a branch of 3 cards writes Map.md once and one undo removes it', async () => {
  const h = await harness([['Root', null, 80, 80], ['Kid', 'Root', 420, 80]]);
  const before = h.contents.get(MAP);
  h.view.plugin.currentModelChoice = () => ({ model: 'gpt-6-luna' });
  h.view.selection.setSelected(h.node('Root').id);
  h.writes.length = 0;
  await h.view.pasteBranches(clip('P', 'P1', 'P2'), JSON.stringify(clip('P', 'P1', 'P2')));
  await wait(400);
  assert.equal(h.view.map.nodes.length, 5, 'three cards pasted');
  assert.equal(h.mapWrites().length, 1, `Map.md written ${h.mapWrites().length} times`);
  h.writes.length = 0;
  await h.view.travel(false);
  await wait(400);
  assert.equal(h.view.history.canUndo, false, 'one undo step');
  assert.deepEqual(core.parseMap(h.contents.get(MAP)).nodes, core.parseMap(before).nodes, 'undo restored the map');
});

test('B31: importing an outline of 3 cards into the open map writes Map.md once and one undo removes it', async () => {
  const h = await harness([['Root', null, 80, 80], ['Kid', 'Root', 420, 80]]);
  const before = h.contents.get(MAP);
  h.view.plugin.currentModelChoice = () => ({ model: 'gpt-6-luna' });
  h.view.outlineImportTarget = () => ({ map: 'editable' });
  h.writes.length = 0;
  await h.view.importOutlineIntoMap({ nodes: outlineOf('O', 'O1', 'O2'), source: null, shallowResearch: false }, { kind: 'tree' });
  await wait(400);
  assert.equal(h.view.map.nodes.length, 5, 'three cards imported');
  assert.equal(h.mapWrites().length, 1, `Map.md written ${h.mapWrites().length} times`);
  h.writes.length = 0;
  await h.view.travel(false);
  await wait(400);
  assert.equal(h.view.history.canUndo, false, 'one undo step');
  assert.deepEqual(core.parseMap(h.contents.get(MAP)).nodes, core.parseMap(before).nodes, 'undo restored the map');
});
