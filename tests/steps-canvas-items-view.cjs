// Map images P3a (ticket 30): the data layer and canvas layer for free images. The view draws `map.canvasItems`, moves,
// resizes and removes them as one undo step each, and a map that never had images must read and save byte for byte.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, fixture, DEFAULT_SETTINGS, obsidian, core, withExpansionCoordinator } = require('./support.cjs');
const dom = require('./support-dom.cjs');
const { element, find, findAll } = dom;
const plain = value => JSON.parse(JSON.stringify(value));
const TOPICS = 'Agent Workspace/Topics';
const MAP = `${TOPICS}/map-i/Map.md`;
const KINDS = ['right', 'left', 'down', 'up', 'balanced', 'radial', 'timeline', 'fishbone'];
const image = (over = {}) => ({ id: 'img1', kind: 'image', path: 'attachments/a.png', x: 100, y: 50, w: 200, h: 100, ...over });

async function harness(items) {
  const { repo, app, contents } = fixture('en', { linkIndex: true });
  const settings = { ...DEFAULT_SETTINGS, language: 'en', cliModel: 'gpt-6-luna' };
  repo.settings = settings;
  const doc = { id: 'map-i', title: 'I', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  await repo.ensureTopicFolders(`${TOPICS}/map-i`);
  await app.vault.create(MAP, core.serializeMap(doc));
  const root = await repo.createNote('Root', 'gpt-6-luna', doc, MAP, 'workspace');
  const child = await repo.createNote('Child', 'gpt-6-luna', doc, MAP, 'workspace');
  child.parentId = root.id;
  doc.nodes.push(root, child);
  if (items) doc.canvasItems = items;
  await repo.saveMap(MAP, doc);
  await repo.rebuildDerivedData();
  await app.vault.create('attachments/a.png', 'png-bytes');
  app.vault.getResourcePath = file => `app://vault/${file.path}`;
  const trashed = [];
  app.fileManager.trashFile = async file => { trashed.push(file.path); };
  let pending = Promise.resolve();
  const notices = [];
  const { VisualAgentMapView } = load('main.ts', { obsidian: { ...obsidian, Notice: dom.makeNotice(notices) } }, { createFragment: dom.createFragment });
  const plugin = withExpansionCoordinator({
    repo, settings, running: new Set(), logs: { appendLog() {} }, rebuildDerivedData: () => repo.rebuildDerivedData(), relevanceGrades: new Map(), expansionBatches: new Map(), pendingSuggestions: new Map(), releaseOutline() {}, setOutlineActive() {}, detailsShown: () => false,
    mutate: work => (pending = Promise.resolve().then(work))
  });
  const view = new VisualAgentMapView({ app }, plugin);
  view.path = MAP; view.map = await repo.readMap(MAP); view.contentEl = element('div'); view.stageEl = element('div');
  view.focusNode = () => {}; view.openDetails = () => {};
  view.hydrate = async () => { view.notes = new Map(await Promise.all(view.map.nodes.map(async n => [n.id, await repo.readNote(n.path)]))); };
  await view.hydrate();
  // The real render rebuilds the whole canvas; the stand-in repaints only the image layer.
  view.render = () => { view.stageEl.children = []; view.stageEl.child('div', 'vam-node'); view.renderCanvasItems(); };
  const settle = async () => { await pending; await dom.tick(); await pending; };
  const fileText = () => contents.get(MAP);
  const onDisk = async () => { const items = (await repo.readMap(MAP)).canvasItems; return items === undefined ? undefined : plain(items); };
  return { repo, app, view, doc, trashed, settle, fileText, onDisk, notices };
}

test('counter-example 1: a map that never had images opens and saves byte for byte', async () => {
  const h = await harness();
  const before = h.fileText();
  assert.ok(!before.includes('canvasItems'));
  await h.repo.saveMap(MAP, await h.repo.readMap(MAP));
  assert.equal(h.fileText(), before);
  const text = core.serializeMap({ id: 'm', title: 'M', version: 1, nodes: [], viewport: { x: 1, y: 2, zoom: 1 } });
  assert.equal(core.serializeMap(core.parseMap(text)), text);
  // An empty list is not written either.
  const empty = core.parseMap(core.serializeMap({ id: 'm', title: 'M', version: 1, nodes: [], viewport: { x: 1, y: 2, zoom: 1 }, canvasItems: [] }));
  assert.equal('canvasItems' in empty, false);
});

test('parseMap drops a malformed image, keeps an unknown kind, and leaves the rest of the map alone', () => {
  const items = [image(), image({ id: 'bad', path: 'https://x.test/a.png' }), { kind: 'sticky', id: 's', note: 'future' }];
  const map = core.parseMap(core.serializeMap({ id: 'm', title: 'M', version: 1, nodes: [], viewport: { x: 1, y: 2, zoom: 1 }, canvasItems: items }));
  assert.deepEqual(plain(map.canvasItems), [image(), { kind: 'sticky', id: 's', note: 'future' }]);
});

test('counter-example 2: every arrangement direction leaves canvasItems deep-equal', async () => {
  const items = [image(), image({ id: 'img2', path: 'attachments/b.png', x: -40, y: 900, w: 64, h: 48 }), { kind: 'sticky', id: 's', n: { a: 1 } }];
  for (const direction of KINDS) {
    const h = await harness(items);
    h.view.setLayout({ direction });
    await h.settle();
    assert.equal(h.view.map.layout?.direction ?? 'right', direction, direction);
    assert.deepEqual(plain(h.view.map.canvasItems), items, `in memory after ${direction}`);
    assert.deepEqual(await h.onDisk(), items, `on disk after ${direction}`);
  }
});

test('renderCanvasItems: accessible name, tab stop, placed after the cards, missing file keeps a named placeholder', async () => {
  const h = await harness([image(), image({ id: 'gone', path: 'attachments/lost.png', x: 5, y: 6, w: 80, h: 40 })]);
  h.view.render();
  const stage = h.view.stageEl;
  const layer = find(stage, i => i.hasClass('vam-canvas-items'));
  assert.ok(stage.children.indexOf(layer) > stage.children.findIndex(c => c.hasClass('vam-node')), 'layer comes after the cards');
  const [found, lost] = findAll(stage, i => i.hasClass('vam-canvas-image'));
  assert.equal(found.attrs.role, 'img');
  assert.equal(found.attrs['aria-label'], 'Image: a.png');
  assert.equal(found.tabIndex, 0);
  assert.equal(find(found, i => i.tag === 'img').attrs.src, 'app://vault/attachments/a.png');
  assert.equal(lost.attrs['aria-label'], 'Image: lost.png');
  assert.ok(lost.hasClass('is-missing'));
  assert.equal(find(lost, i => i.tag === 'span').text, 'lost.png');
  assert.equal(find(lost, i => i.tag === 'img'), undefined);
  assert.equal(h.view.map.canvasItems.length, 2, 'the missing file stays in the map');
  assert.equal(found.style.left, '100px');
  assert.equal(found.style.width, '200px');
});

test('moveCanvasItem writes one undo step; undo and redo restore the position', async () => {
  const h = await harness([image()]);
  const entries = h.view.history.past.length;
  await h.view.moveCanvasItem('img1', 30, -10);
  assert.equal(h.view.history.past.length, entries + 1);
  assert.deepEqual(await h.onDisk(), [image({ x: 130, y: 40 })]);
  await h.view.history.undoEntry.undo();
  assert.deepEqual(await h.onDisk(), [image()]);
  await h.view.history.redoEntry?.redo?.();
});

test('pointer gesture: one write on pointerup, none while moving; a cancel puts the image back', async () => {
  const h = await harness([image()]);
  h.view.render();
  const el = () => find(h.view.stageEl, i => i.hasClass('vam-canvas-image'));
  const entries = h.view.history.past.length;
  const down = { button: 0, clientX: 10, clientY: 10, pointerId: 1 };
  el().fire('pointerdown', down);
  el().fire('pointermove', { clientX: 60, clientY: 30 });
  el().fire('pointermove', { clientX: 70, clientY: 40 });
  assert.equal(el().style.left, '160px');
  assert.equal(h.view.history.past.length, entries, 'nothing written during the move');
  el().fire('pointerup', {});
  await h.settle();
  assert.equal(h.view.history.past.length, entries + 1, 'one history entry for the gesture');
  assert.deepEqual(await h.onDisk(), [image({ x: 160, y: 80 })]);
  h.view.render();
  el().fire('pointerdown', down);
  el().fire('pointermove', { clientX: 200, clientY: 200 });
  el().fire('pointercancel', {});
  await h.settle();
  assert.equal(h.view.history.past.length, entries + 1, 'a cancelled gesture writes nothing');
  assert.equal(el().style.left, '160px');
});

test('counter-example 4: corner resize keeps the ratio within 1% and is one undo step', async () => {
  const items = [image({ w: 333, h: 111 })];
  const h = await harness(items);
  h.view.render();
  const el = () => find(h.view.stageEl, i => i.hasClass('vam-canvas-image'));
  const handle = find(el(), i => i.hasClass('vam-canvas-image-handle'));
  const entries = h.view.history.past.length;
  handle.fire('pointerdown', { button: 0, clientX: 0, clientY: 0, pointerId: 2 });
  el().fire('pointermove', { clientX: 187, clientY: 5 });
  el().fire('pointerup', {});
  await h.settle();
  assert.equal(h.view.history.past.length, entries + 1);
  const [saved] = await h.onDisk();
  assert.ok(Math.abs(saved.w / saved.h - 333 / 111) / (333 / 111) < 0.01);
  assert.ok(saved.w > 333 && saved.x === 100 && saved.y === 50, 'anchored at the top-left corner');
  await h.view.resizeCanvasItem('img1', 1);
  const [tiny] = await h.onDisk();
  assert.ok(tiny.w >= 24 && tiny.h >= 24 && Math.abs(tiny.w / tiny.h - 3) < 0.03, 'never below 24px');
});

test('counter-example 3: Delete removes the reference only; undo brings it back and no file is trashed', async () => {
  const h = await harness([image()]);
  h.view.render();
  const el = find(h.view.stageEl, i => i.hasClass('vam-canvas-image'));
  let prevented = false;
  el.fire('keydown', { key: 'Delete', preventDefault() { prevented = true; } });
  assert.ok(prevented);
  await h.settle();
  assert.equal(await h.onDisk(), undefined, 'no canvasItems field once the last image is gone');
  assert.ok(!h.fileText().includes('canvasItems'));
  assert.ok(h.app.vault.getAbstractFileByPath('attachments/a.png'), 'the image file stays');
  await h.view.history.undoEntry.undo();
  assert.deepEqual(await h.onDisk(), [image()]);
  assert.deepEqual(h.trashed, [], 'trashFile was called 0 times');
});

test('images cannot be changed on an AIM map, the built-in sample or in selection mode', async () => {
  for (const mode of ['builtIn', 'integrationMode']) {
    const h = await harness([image()]);
    h.view[mode] = true;
    h.view.render();
    const el = find(h.view.stageEl, i => i.hasClass('vam-canvas-image'));
    assert.equal(find(el, i => i.hasClass('vam-canvas-image-handle')), undefined, mode);
    const before = h.fileText();
    await h.view.moveCanvasItem('img1', 5, 5);
    await h.view.removeCanvasItem('img1');
    assert.equal(h.fileText(), before, mode);
  }
});
