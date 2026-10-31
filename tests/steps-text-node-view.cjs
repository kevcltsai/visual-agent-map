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

test('a render after add (file event, derived data) keeps the new text node in edit with focus on the textarea', async () => {
  const h = await harness();
  h.view.addTextNodeUnder(h.root);
  await h.settle();
  const area = () => find(h.textEl(h.view.map.canvasItems[0].id), i => i.tag === 'textarea');
  assert.ok(area(), 'editor open after add');
  assert.ok(h.view.editingTextId, 'editing');
  area().value = 'draft kept';
  h.view.render(); // the later render that used to remove the textarea
  h.view.render();
  assert.ok(area(), 'editor still open after later renders');
  assert.equal(area().value, 'draft kept');
  assert.equal(h.view.editingTextId, h.view.map.canvasItems[0].id);
  assert.equal((await h.onDisk())[0].text, 'Text', 'no blur commit wrote the draft early');
});

// Root cause (diagnosis 2026-11-01): paint opens the editor, then hands focus back to the parent card, which blurs the textarea and commits/closes it.
function paintLikeHarness(h) {
  const doc = {
    _active: null,
    get activeElement() { return this._active; },
    set activeElement(next) { const old = this._active; this._active = next; if (old && old !== next) old.fire('blur', {}); }
  };
  h.view.stageEl.root = doc;
  h.view.render = () => {
    const stage = h.view.stageEl;
    const hadFocusedCard = doc.activeElement && doc.activeElement.hasClass?.('vam-node') ? doc.activeElement.dataset.nodeId : null;
    if (hadFocusedCard) h.view.focusNodeId ??= hadFocusedCard; // paint head: remember the focused card
    stage.children = []; h.view.cardEls.clear(); h.view.textEls.clear();
    for (const n of h.view.map.nodes) { const c = stage.child('div', 'vam-node'); c.dataset.nodeId = n.id; h.view.cardEls.set(n.id, c); }
    h.view.renderCanvasItems();
    if (h.view.focusNodeId) { // paint tail: give focus back to that card
      h.view.cardEls.get(h.view.focusNodeId)?.focus({ preventScroll: true });
      h.view.focusNodeId = null;
    }
  };
  return doc;
}

test('adding a text node while its parent card has focus keeps the editor open (paint must not hand focus back to the card)', async () => {
  const h = await harness();
  const doc = paintLikeHarness(h);
  h.view.render();
  doc.activeElement = h.view.cardEls.get(h.root.id);
  h.view.addTextNodeUnder(h.root);
  await h.settle();
  const id = h.view.map.canvasItems[0].id;
  const area = find(h.textEl(id), i => i.tag === 'textarea');
  assert.ok(area, 'textarea still present');
  assert.equal(h.view.editingTextId, id);
  assert.equal(doc.activeElement, area, 'focus is on the textarea');
  assert.equal((await h.onDisk())[0].text, 'Text', 'nothing committed early');
});

test('control: with an existing text node already in edit, a repaint keeps the editor and focus', async () => {
  const h = await harness(({ root }) => [txt({ parentId: root.id })]);
  const doc = paintLikeHarness(h);
  h.view.render();
  h.textEl('t1').fire('dblclick', {});
  const area = () => find(h.textEl('t1'), i => i.tag === 'textarea');
  assert.ok(area());
  doc.activeElement = area();
  h.view.render();
  assert.ok(area(), 'editor kept');
  assert.equal(h.view.editingTextId, 't1');
  assert.equal(doc.activeElement, area());
});
