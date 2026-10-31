// Tree text nodes P2: the View draws, edits, removes and lays out text canvas items; every write is one undo step.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, fixture, DEFAULT_SETTINGS, obsidian, core, withExpansionCoordinator } = require('./support.cjs');
const dom = require('./support-dom.cjs');
const { element, find, findAll } = dom;
const plain = value => JSON.parse(JSON.stringify(value));
const TOPICS = 'Agent Workspace/Topics';
const MAP = `${TOPICS}/map-t/Map.md`;
const txt = (over = {}) => ({ id: 't1', kind: 'text', text: 'Hello', parentId: undefined, x: 400, y: 80, ...over });

async function harness(build) {
  const { repo, app, contents } = fixture('en', { linkIndex: true });
  const settings = { ...DEFAULT_SETTINGS, language: 'en', cliModel: 'gpt-6-luna' };
  repo.settings = settings;
  const doc = { id: 'map-t', title: 'T', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  await repo.ensureTopicFolders(`${TOPICS}/map-t`);
  await app.vault.create(MAP, core.serializeMap(doc));
  const root = await repo.createNote('Root', 'gpt-6-luna', doc, MAP, 'workspace');
  const child = await repo.createNote('Child', 'gpt-6-luna', doc, MAP, 'workspace');
  child.parentId = root.id;
  doc.nodes.push(root, child);
  const items = build ? build({ root, child }) : undefined;
  if (items) doc.canvasItems = items;
  await repo.saveMap(MAP, doc);
  await repo.rebuildDerivedData();
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
  view.render = () => {
    view.stageEl.children = []; view.cardEls.clear(); view.textEls.clear();
    for (const n of view.map.nodes) view.cardEls.set(n.id, view.stageEl.child('div', 'vam-node'));
    view.renderCanvasItems();
  };
  view.render();
  const settle = async () => { await pending; await dom.tick(); await pending; };
  const onDisk = async () => plain((await repo.readMap(MAP)).canvasItems ?? []);
  const noteFiles = () => [...contents.keys()].filter(k => k.endsWith('.md') && !k.endsWith('Map.md')).length;
  const textEl = id => find(view.stageEl, i => i.dataset.itemId === id);
  return { repo, view, root: view.map.nodes[0], child: view.map.nodes[1], settle, onDisk, noteFiles, textEl, notices };
}

test('render: attached text under a shown topic, free text for an orphan, folded parent hides it, text stays text', async () => {
  const h = await harness(({ root }) => [txt({ parentId: root.id, text: '<img src=x onerror=alert(1)>' }), txt({ id: 't2', parentId: 'gone', text: 'Orphan', x: 5, y: 6 })]);
  const a = h.textEl('t1'), o = h.textEl('t2');
  assert.equal(a.attrs.role, 'note');
  assert.equal(a.attrs['aria-label'], 'Text node: <img src=x onerror=alert(1)>');
  assert.equal(a.tabIndex, 0);
  assert.equal(find(a, i => i.tag === 'img'), undefined);
  assert.equal(find(a, i => i.hasClass('vam-text-node-body')).text, '<img src=x onerror=alert(1)>');
  assert.ok(o.hasClass('is-free'));
  assert.equal(o.style.left, '5px');
  h.view.map.nodes[0].collapsed = true;
  h.view.render();
  assert.equal(h.textEl('t1'), undefined, 'folded parent hides its text');
  assert.ok(h.textEl('t2'), 'an orphan stays');
});

test('A4: add, edit, remove are one undo step each, make no note file, and undo/redo round-trip', async () => {
  const h = await harness();
  const files = h.noteFiles(), past = h.view.history.past.length;
  h.view.addTextNodeUnder(h.root);
  await h.settle();
  let items = await h.onDisk();
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'text');
  assert.equal(items[0].parentId, h.root.id);
  assert.equal(h.view.history.past.length, past + 1);
  assert.equal(h.noteFiles(), files, 'no .md was created');
  const id = items[0].id;
  assert.ok(find(h.textEl(id), i => i.tag === 'textarea'), 'the editor opens at once');
  // Esc cancels: nothing written.
  const area = () => find(h.textEl(id), i => i.tag === 'textarea');
  area().value = 'changed';
  area().fire('keydown', { key: 'Escape' });
  await h.settle();
  assert.equal((await h.onDisk())[0].text, 'Text');
  assert.equal(h.view.history.past.length, past + 1);
  // Ctrl+Enter saves.
  h.textEl(id).fire('dblclick', {});
  area().value = '  New words  ';
  area().fire('keydown', { key: 'Enter', ctrlKey: true });
  await h.settle();
  assert.equal((await h.onDisk())[0].text, 'New words');
  assert.equal(h.view.history.past.length, past + 2);
  // Empty text removes the node, still one step.
  h.textEl(id).fire('dblclick', {});
  area().value = '   ';
  area().fire('keydown', { key: 'Enter', metaKey: true });
  await h.settle();
  assert.deepEqual(await h.onDisk(), []);
  assert.equal(h.view.history.past.length, past + 3);
  await h.view.travel(false);
  assert.equal((await h.onDisk())[0].text, 'New words', 'undo brings the node back');
  await h.view.travel(false);
  assert.equal((await h.onDisk())[0].text, 'Text');
  assert.equal(h.noteFiles(), files);
});

test('Delete and Backspace on a focused text node remove it as one undo step; keys inside the editor do not', async () => {
  const h = await harness(({ root }) => [txt({ parentId: root.id })]);
  const past = h.view.history.past.length;
  h.textEl('t1').fire('dblclick', {});
  const area = find(h.textEl('t1'), i => i.tag === 'textarea');
  let bubbled = false;
  h.textEl('t1').addEventListener('keydown', () => { bubbled = true; });
  area.fire('keydown', { key: 'Delete' });
  assert.equal(bubbled, false, 'the field owns Delete');
  area.fire('keydown', { key: 'Escape' });
  await h.settle();
  assert.equal((await h.onDisk()).length, 1);
  h.textEl('t1').fire('keydown', { key: 'Delete' });
  await h.settle();
  assert.deepEqual(await h.onDisk(), []);
  assert.equal(h.view.history.past.length, past + 1);
  await h.view.travel(false);
  assert.equal((await h.onDisk()).length, 1);
});

test('Enter on a focused text node opens the editor', async () => {
  const h = await harness(({ root }) => [txt({ parentId: root.id })]);
  h.textEl('t1').fire('keydown', { key: 'Enter' });
  assert.ok(find(h.textEl('t1'), i => i.tag === 'textarea'));
});

test('counter-example: AIM, built-in sample and presentation cannot edit text', async () => {
  for (const mode of ['aim', 'builtIn', 'presentation']) {
    const h = await harness(({ root }) => [txt({ parentId: root.id })]);
    if (mode === 'aim') h.view.map.aim = { branches: [] };
    if (mode === 'builtIn') h.view.builtIn = true;
    if (mode === 'presentation') h.view.presentation = { order: [], currentId: 'x' };
    h.view.render();
    h.textEl('t1').fire('dblclick', {});
    h.textEl('t1').fire('keydown', { key: 'Delete' });
    assert.equal(find(h.textEl('t1'), i => i.tag === 'textarea'), undefined, mode);
    h.view.addTextNodeUnder(h.root);
    await h.settle();
    assert.equal((await h.onDisk()).length, 1, mode);
  }
});

test('add without a selection tells the user and writes nothing', async () => {
  const h = await harness();
  h.view.selected = null;
  h.view.addTextNodeUnder();
  await h.settle();
  assert.deepEqual(await h.onDisk(), []);
  assert.ok(h.notices.some(n => String(n).includes('Select a topic')));
});

test('layout: text nodes follow auto layout, a map without text keeps no canvasItems, heightOf gives text 180', async () => {
  const h = await harness(({ root }) => [txt({ parentId: root.id, x: 9999, y: 9999 })]);
  assert.equal(h.view.cardHeightOf('t1'), 180);
  assert.equal(h.view.cardHeightOf('txt-new'), 180);
  h.view.autoLayout();
  await h.settle();
  const [item] = await h.onDisk();
  assert.notEqual(item.x, 9999);
  assert.ok(item.x > h.view.map.nodes[0].x, 'the text sits to the right of its parent');
  const plainMap = await harness();
  plainMap.view.autoLayout();
  await plainMap.settle();
  assert.equal('canvasItems' in plainMap.view.map, false);
});

test('presentation order lists a text node among its parent children', async () => {
  const h = await harness(({ root }) => [txt({ parentId: root.id, y: 1000 })]);
  h.view.canvasNodes = () => h.view.map.nodes;
  const order = plain(h.view.presentationOrder());
  assert.deepEqual(order, [h.root.id, h.child.id, 't1']);
});
