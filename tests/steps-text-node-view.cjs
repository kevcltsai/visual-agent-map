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

const createSvg = tag => ({ tag, attrs: {}, classes: [], children: [], setAttribute(n, v) { this.attrs[n] = v; }, getAttribute(n) { return this.attrs[n]; }, addClass(...n) { this.classes.push(...n); }, appendChild(c) { this.children.push(c); } });

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
  const notices = [], menus = [];
  const Menu = class { constructor() { this.items = []; menus.push(this); } addItem(cb) { const item = { setTitle(v) { this.title = v; return this; }, setIcon() { return this; }, onClick(fn) { this.click = fn; return this; } }; cb(item); this.items.push(item); return this; } showAtPosition() { return this; } showAtMouseEvent() { return this; } };
  const { VisualAgentMapView } = load('main.ts', { obsidian: { ...obsidian, Notice: dom.makeNotice(notices), Menu } }, { createFragment: dom.createFragment, CSS: { escape: v => v }, createSvg, requestAnimationFrame: () => 1, cancelAnimationFrame() {} });
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
  view.announcer = element('div');
  return { repo, view, root: view.map.nodes[0], child: view.map.nodes[1], settle, onDisk, noteFiles, textEl, notices, menus };
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

test('counter-example: AIM and presentation cannot edit text', async () => {
  for (const mode of ['aim', 'presentation']) {
    const h = await harness(({ root }) => [txt({ parentId: root.id })]);
    if (mode === 'aim') h.view.map.aim = { branches: [] };
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

test('canvas-text-node: add without a selection makes a free text block in the view center (one undo step, editor opens)', async () => {
  const h = await harness();
  h.view.viewportEl = { clientWidth: 800, clientHeight: 600, getBoundingClientRect: () => ({ left: 0, right: 800, top: 0, bottom: 600 }) };
  h.view.selection.setSelected(null);
  const past = h.view.history.past.length;
  h.view.addTextNodeUnder();
  await h.settle();
  const items = await h.onDisk();
  assert.equal(items.length, 1);
  assert.equal(items[0].parentId, undefined, 'a free block has no parent');
  assert.equal(items[0].links, undefined);
  // The block shows the short placeholder ("Text", about 42 wide), so it is centred on that, not on the 300 limit (old x was 250).
  assert.deepEqual([items[0].x, items[0].y], [379, 300]);
  assert.equal(h.view.history.past.length, past + 1);
  assert.ok(h.textEl(items[0].id).hasClass('is-free'));
  assert.ok(find(h.textEl(items[0].id), i => i.tag === 'textarea'), 'the editor opens at once');
  assert.deepEqual(h.notices, [], 'no "select a topic" notice any more');
  await h.view.travel(false);
  assert.deepEqual(await h.onDisk(), []);
});

test('canvas-text-node: with a selected topic the command still hangs the block on the tree', async () => {
  const h = await harness();
  h.view.selection.setSelected(h.root.id);
  h.view.addTextNodeUnder();
  await h.settle();
  assert.equal((await h.onDisk())[0].parentId, h.root.id);
});

test('canvas-text-node: the empty-canvas menu offers Add text node here; AIM and presentation do not', async () => {
  const h = await harness();
  h.view.viewportEl = { clientWidth: 800, clientHeight: 600, getBoundingClientRect: () => ({ left: 0, right: 800, top: 0, bottom: 600 }) };
  h.view.onCanvasContextMenu({ clientX: 110, clientY: 45, preventDefault() {}, target: { closest: () => null } });
  const titles = h.menus[0].items.map(i => i.title);
  assert.ok(titles.includes('Add text node here'));
  h.menus[0].items[titles.indexOf('Add text node here')].click();
  await h.settle();
  const items = await h.onDisk();
  assert.deepEqual([items[0].x, items[0].y, items[0].parentId], [110, 45, undefined]);
  for (const mode of ['aim', 'presentation']) {
    const g = await harness();
    g.view.viewportEl = h.view.viewportEl;
    if (mode === 'aim') g.view.map.aim = { branches: [] };
    else g.view.presentation = { order: [], currentId: 'x' };
    g.view.onCanvasContextMenu({ clientX: 1, clientY: 1, preventDefault() {}, target: { closest: () => null } });
    assert.ok(!(g.menus[0]?.items ?? []).some(i => i.title === 'Add text node here'), mode);
  }
});

test('layout: text nodes follow auto layout, a map without text keeps no canvasItems, heightOf gives an undrawn text one line (28)', async () => {
  const h = await harness(({ root }) => [txt({ parentId: root.id, x: 9999, y: 9999 })]);
  assert.equal(h.view.cardHeightOf('t1'), 28);
  assert.equal(h.view.cardHeightOf('txt-new'), 28);
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

// ---- canvas-text-node P2: drag, keys, link mode, unlink, delete, layout ------------------------------------------------
const free = (over = {}) => txt({ id: 'f1', text: 'Budget', x: 600, y: 40, ...over });
const clickCard = (h, id) => h.view.stageEl.fire('click', { target: h.view.cardEls.get(id) });

test('canvas-text-node: a pointer drag of a free block is one undo step; a click moves nothing; attached blocks do not drag', async () => {
  const h = await harness(({ root }) => [free(), txt({ parentId: root.id })]);
  const past = h.view.history.past.length;
  const el = h.textEl('f1');
  el.fire('pointerdown', { button: 0, clientX: 10, clientY: 10, pointerId: 1 });
  el.fire('pointerup', {});
  await h.settle();
  assert.equal(h.view.history.past.length, past, 'a click writes nothing');
  el.fire('pointerdown', { button: 0, clientX: 10, clientY: 10, pointerId: 1 });
  el.fire('pointermove', { clientX: 60, clientY: 35 });
  el.fire('pointerup', {});
  await h.settle();
  assert.deepEqual((await h.onDisk()).find(i => i.id === 'f1'), { id: 'f1', kind: 'text', text: 'Budget', x: 650, y: 65 });
  assert.equal(h.view.history.past.length, past + 1);
  await h.view.travel(false);
  assert.equal((await h.onDisk()).find(i => i.id === 'f1').x, 600);
  assert.equal(h.textEl('t1').listeners.pointerdown, undefined, 'a tree-attached block is placed by the layout, not by hand');
});

test('canvas-text-node: arrow keys move a free block 10px, Shift 50px, one undo step each; attached blocks and the editor ignore them', async () => {
  const h = await harness(({ root }) => [free(), txt({ parentId: root.id })]);
  const past = h.view.history.past.length;
  h.textEl('f1').fire('keydown', { key: 'ArrowRight' });
  await h.settle();
  h.textEl('f1').fire('keydown', { key: 'ArrowDown', shiftKey: true });
  await h.settle();
  const item = (await h.onDisk()).find(i => i.id === 'f1');
  assert.deepEqual([item.x, item.y], [610, 90]);
  assert.equal(h.view.history.past.length, past + 2);
  h.textEl('t1').fire('keydown', { key: 'ArrowRight' });
  await h.settle();
  assert.equal((await h.onDisk()).find(i => i.id === 't1').x, 400);
  h.textEl('f1').fire('dblclick', {});
  find(h.textEl('f1'), i => i.tag === 'textarea').fire('keydown', { key: 'ArrowLeft' });
  await h.settle();
  assert.equal((await h.onDisk()).find(i => i.id === 'f1').x, 610);
});

test('canvas-text-node: link mode (button or L) connects the clicked card as one undo step, announces, then ends', async () => {
  const h = await harness(() => [free()]);
  const past = h.view.history.past.length;
  find(h.textEl('f1'), i => i.hasClass('vam-text-node-connect')).click();
  assert.equal(h.view.linkingTextId, 'f1');
  assert.match(h.view.announcer.text, /Choose a card/);
  assert.ok(h.view.stageEl.hasClass('is-linking'));
  clickCard(h, h.child.id);
  await h.settle();
  assert.deepEqual((await h.onDisk())[0].links, [h.child.id]);
  assert.equal(h.view.history.past.length, past + 1);
  assert.equal(h.view.linkingTextId, null);
  assert.ok(!h.view.stageEl.hasClass('is-linking'));
  assert.equal(h.textEl('f1').attrs['aria-label'], 'Text node: Budget, linked to 1 cards');
  // Again: L, same card -> announced, not written twice.
  h.textEl('f1').fire('keydown', { key: 'l' });
  assert.equal(h.view.linkingTextId, 'f1');
  clickCard(h, h.child.id);
  await h.settle();
  assert.equal(h.view.announcer.text, 'Already connected.');
  assert.equal(h.view.history.past.length, past + 1);
  await h.view.travel(false);
  assert.equal((await h.onDisk())[0].links, undefined, 'one undo removes the connection');
  await h.view.travel(true);
  assert.deepEqual((await h.onDisk())[0].links, [h.child.id]);
});

test('canvas-text-node: link mode with the keyboard (Enter on a focused card) and cancel paths leave nothing half written', async () => {
  const h = await harness(() => [free()]);
  const past = h.view.history.past.length;
  const stage = h.view.stageEl;
  h.view.startLinking('f1');
  stage.fire('keydown', { key: 'Enter', target: h.view.cardEls.get(h.root.id) });
  await h.settle();
  assert.deepEqual((await h.onDisk())[0].links, [h.root.id]);
  for (const cancel of [
    () => stage.fire('keydown', { key: 'Escape', target: h.textEl('f1') }),
    () => stage.fire('click', { target: stage }),
    () => h.view.onClose()
  ]) {
    h.view.startLinking('f1');
    cancel();
    await h.settle();
    assert.equal(h.view.linkingTextId, null);
    assert.ok(!stage.hasClass('is-linking'));
  }
  assert.equal(h.view.history.past.length, past + 1, 'only the accepted link wrote');
  // The block disappears while linking (deleted elsewhere): the next paint ends the mode.
  h.view.startLinking('f1');
  await h.view.changeCanvasItems('f1', items => items.filter(i => i.id !== 'f1'));
  h.view.render();
  assert.equal(h.view.linkingTextId, null);
});

test('canvas-text-node: clicking the empty viewport (not the 1px stage) cancels link mode; a card click still links', async () => {
  const h = await harness(() => [free()]);
  const past = h.view.history.past.length;
  const viewport = element('div');
  h.view.viewportEl = viewport;
  h.view.startLinking('f1');
  viewport.fire('click', { target: viewport });
  await h.settle();
  assert.equal(h.view.linkingTextId, null);
  assert.ok(!h.view.stageEl.hasClass('is-linking'));
  assert.match(h.view.announcer.text, /cancel/i);
  assert.deepEqual(viewport.listeners.click, [], 'the viewport listener is removed with the mode');
  h.view.startLinking('f1');
  clickCard(h, h.child.id);
  await h.settle();
  assert.deepEqual((await h.onDisk())[0].links, [h.child.id]);
  assert.equal(h.view.history.past.length, past + 1);
});

test('canvas-text-node: fit (Show all) includes free text blocks, not folded or attached ones', async () => {
  const h = await harness(() => [free({ x: 1500, y: 40 })]);
  h.view.viewportEl = { clientWidth: 1000, clientHeight: 600 };
  h.view.canvasNodes = () => h.view.map.nodes;
  h.view.transform = () => {}; h.view.saveViewport = () => {}; h.view.canvasInset = () => 0;
  h.view.fit();
  const withFree = h.view.map.viewport.zoom;
  assert.ok(withFree < 1000 / 1800 + 1e-9, `zoom ${withFree} leaves room for the block at x=1500..1800`);
  await h.view.changeCanvasItems('f1', items => items.filter(i => i.id !== 'f1'));
  h.view.render();
  h.view.fit();
  assert.ok(h.view.map.viewport.zoom > withFree, 'without the block the fit is closer');
});

test('canvas-text-node: unlink menu lists linked cards, removing one is one undo step; a dangling link is not counted', async () => {
  const h = await harness(({ root, child }) => [free({ links: [root.id, child.id, 'gone'] })]);
  assert.equal(h.textEl('f1').attrs['aria-label'], 'Text node: Budget, linked to 2 cards');
  const button = find(h.textEl('f1'), i => i.hasClass('vam-text-node-unlink'));
  button.getBoundingClientRect = () => ({ left: 5, bottom: 9 });
  button.click();
  assert.deepEqual(h.menus.at(-1).items.map(i => i.title), ['Disconnect from Root', 'Disconnect from Child']);
  const past = h.view.history.past.length;
  h.menus.at(-1).items[0].click();
  await h.settle();
  assert.deepEqual((await h.onDisk())[0].links, [h.child.id], 'the dangling id is cleaned by the write');
  assert.equal(h.view.history.past.length, past + 1);
  await h.view.travel(false);
  assert.deepEqual((await h.onDisk())[0].links, [h.root.id, h.child.id, 'gone'], 'undo restores the file as it was');
});

test('canvas-text-node: links are drawn as dashed path lines (no marker, no label) to shown cards only', async () => {
  const h = await harness(({ root }) => [free({ links: [root.id, 'gone'] }), txt({ parentId: root.id })]);
  const place = (el, x) => Object.assign(el, { offsetLeft: x, offsetTop: 0, offsetWidth: 100, offsetHeight: 50 });
  place(h.view.cardEls.get(h.root.id), 0); place(h.view.cardEls.get(h.child.id), 200); place(h.textEl('f1'), 600); place(h.textEl('t1'), 400);
  h.view.edgesEl = { children: [], replaceChildren() { this.children = []; }, appendChild(c) { this.children.push(c); } };
  h.view.relationsLayerEl = { children: [], replaceChildren() {}, appendChild() {} };
  h.view.drawEdges();
  const links = h.view.edgesEl.children.filter(p => p.classes.includes('vam-text-link'));
  assert.equal(links.length, 1, 'one live link; the dangling id draws nothing');
  const attr = k => links[0].attrs[k];
  assert.equal(attr('data-text-id'), 'f1');
  assert.equal(attr('data-card-id'), h.root.id);
  assert.match(String(attr('d')), /^M /);
  assert.equal(attr('marker-end'), undefined);
});

test('canvas-text-node: deleting a card removes its links in the same step, one undo brings card and link back', async () => {
  const h = await harness(({ root, child }) => [free({ links: [root.id, child.id] })]);
  const past = h.view.history.past.length;
  await h.view.removeToUnassigned(h.child, false);
  assert.deepEqual((await h.onDisk())[0].links, [h.root.id]);
  assert.equal(h.view.history.past.length, past + 1);
  await h.view.travel(false);
  assert.deepEqual((await h.onDisk())[0].links, [h.root.id, h.child.id]);
});

test('canvas-text-node: no free block, no links, no canvasItems written by delete', async () => {
  const h = await harness();
  await h.view.removeToUnassigned(h.child, false);
  assert.equal('canvasItems' in (await h.repo.readMap(MAP)), false);
});

test('canvas-text-node: no layout direction moves a free block', async () => {
  for (const direction of ['right', 'left', 'down', 'up', 'balanced', 'radial', 'timeline', 'fishbone']) {
    const h = await harness(({ root }) => [free({ links: [root.id] })]);
    h.view.setLayout({ direction });
    await h.settle();
    h.view.autoLayout();
    await h.settle();
    const item = (await h.onDisk()).find(i => i.id === 'f1');
    assert.deepEqual([item.x, item.y, item.links], [600, 40, [h.root.id]], direction);
  }
});

test('canvas-text-node: chatUserTexts carries links for the map chat context', async () => {
  const h = await harness(({ root }) => [free({ links: [root.id] }), txt({ parentId: root.id })]);
  const out = plain(h.view.chatUserTexts());
  assert.deepEqual(out.find(t => t.id === 'f1').links, [h.root.id]);
  assert.equal('links' in out.find(t => t.id === 't1'), false);
});

test('canvas-text-node: AIM and presentation cannot start link mode or move a block', async () => {
  for (const mode of ['aim', 'presentation']) {
    const h = await harness(() => [free()]);
    if (mode === 'aim') h.view.map.aim = { branches: [] };
    if (mode === 'presentation') h.view.presentation = { order: [], currentId: 'x' };
    h.view.render();
    h.view.startLinking('f1');
    assert.equal(h.view.linkingTextId, null, mode);
    h.textEl('f1').fire('keydown', { key: 'ArrowRight' });
    await h.settle();
    assert.equal((await h.onDisk())[0].x, 600, mode);
  }
});

// text-node-width: automatic width fits the text, a stored width is fixed and set with a right-edge handle.
const handleOf = h => id => find(h.textEl(id), i => i.classes.includes('vam-text-resize'));
const widthOnDisk = async h => (await h.onDisk())[0].width;
const pointer = (handle, name, x) => handle.fire(name, { button: 0, pointerId: 1, clientX: x });
const cssRule = (selector) => require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'styles.css'), 'utf8').split('\n').find(line => line.startsWith(selector + ' {'));

test('text-node-width: no stored width means no fixed 300 (CSS fits the text, capped at 300); a stored width is fixed', async () => {
  const h = await harness(() => [txt({ text: 'hello~~' }), free({ width: 180 })]);
  assert.equal(h.textEl('t1').style.width, undefined, 'automatic: no inline width');
  assert.equal(h.textEl('t1').hasClass('has-width'), false);
  assert.equal(h.textEl('f1').style.width, '180px');
  assert.equal(h.textEl('f1').hasClass('has-width'), true);
  const rule = cssRule('.vam-view .vam-text-node');
  assert.match(rule, /width: max-content/);
  assert.match(rule, /max-width: 300px/);
  assert.match(rule, /min-width: 32px/);
  assert.match(cssRule('.vam-view .vam-text-node.has-width'), /max-width: none/);
});

test('text-node-width: the handle is a separator with range; not drawn when the map cannot be edited', async () => {
  const h = await harness(() => [txt()]);
  const handle = handleOf(h)('t1');
  assert.deepEqual({ role: handle.attrs.role, min: handle.attrs['aria-valuemin'], max: handle.attrs['aria-valuemax'] }, { role: 'separator', min: '32', max: '560' });
  h.view.presentation = {};
  h.view.render();
  assert.equal(handleOf(h)('t1'), undefined, 'no handle while presenting');
});

test('text-node-width: no handle in an AIM map or in selection mode (the map cannot edit canvas items); it is there again afterwards', async () => {
  const h = await harness(({ root }) => [txt({ parentId: root.id }), free()]);
  assert.ok(handleOf(h)('t1') && handleOf(h)('f1'), 'editable map has handles');
  h.view.map.aim = { branches: [] };
  h.view.render();
  assert.equal(handleOf(h)('t1'), undefined, 'AIM attached');
  assert.equal(handleOf(h)('f1'), undefined, 'AIM free');
  delete h.view.map.aim;
  h.view.selection.toggleMultiSelect();
  assert.equal(h.view.selection.state.multiSelectMode, true);
  h.view.render();
  assert.equal(handleOf(h)('t1'), undefined, 'selection mode attached');
  assert.equal(handleOf(h)('f1'), undefined, 'selection mode free');
  h.view.selection.toggleMultiSelect();
  h.view.render();
  assert.ok(handleOf(h)('t1'), 'handle back');
});

test('text-node-width: a drag writes once on release (clamped), one undo step; undo restores automatic width', async () => {
  const h = await harness(() => [txt()]);
  const past = h.view.history.past.length;
  let handle = handleOf(h)('t1');
  h.textEl('t1').offsetWidth = 100;
  pointer(handle, 'pointerdown', 0); pointer(handle, 'pointermove', 60); pointer(handle, 'pointermove', 90);
  assert.equal(h.textEl('t1').style.width, '190px', 'live while dragging');
  await h.settle();
  assert.equal(h.view.history.past.length, past, 'nothing written while moving');
  pointer(handle, 'pointerup', 90);
  await h.settle();
  assert.equal(await widthOnDisk(h), 190);
  assert.equal(h.view.history.past.length, past + 1);
  h.view.render();
  handle = handleOf(h)('t1');
  pointer(handle, 'pointerdown', 0); pointer(handle, 'pointermove', 5000); pointer(handle, 'pointerup', 5000);
  await h.settle();
  assert.equal(await widthOnDisk(h), 560);
  await h.view.travel(false);
  assert.equal(await widthOnDisk(h), 190, 'undo is one step');
  await h.view.travel(false);
  assert.equal((await h.onDisk())[0].width, undefined);
});

test('text-node-width: a cancelled or zero-length drag writes nothing', async () => {
  const h = await harness(() => [txt()]);
  const past = h.view.history.past.length;
  const handle = handleOf(h)('t1');
  h.textEl('t1').offsetWidth = 100;
  pointer(handle, 'pointerdown', 0); pointer(handle, 'pointermove', 50); pointer(handle, 'pointercancel', 50);
  assert.equal(h.textEl('t1').style.width, undefined, 'back to automatic');
  pointer(handle, 'pointerdown', 0); pointer(handle, 'pointerup', 0);
  await h.settle();
  assert.equal(h.view.history.past.length, past);
});

test('text-node-width: arrows step 40, Home/End jump, Enter and double click go back to automatic; each is one undo step', async () => {
  const h = await harness(() => [txt({ width: 200 })]);
  const key = async k => { handleOf(h)('t1').fire('keydown', { key: k }); await h.settle(); h.view.render(); };
  const past = h.view.history.past.length;
  await key('ArrowRight'); assert.equal(await widthOnDisk(h), 240);
  await key('ArrowLeft'); await key('ArrowLeft'); assert.equal(await widthOnDisk(h), 160);
  await key('Home'); assert.equal(await widthOnDisk(h), 32);
  await key('End'); assert.equal(await widthOnDisk(h), 560);
  assert.equal(h.view.history.past.length, past + 5);
  await key('End'); assert.equal(h.view.history.past.length, past + 5, 'at the limit nothing is written');
  await key('Enter'); assert.equal(await widthOnDisk(h), undefined);
  await key('Enter'); assert.equal(h.view.history.past.length, past + 6, 'already automatic: nothing written');
  await key('ArrowRight'); handleOf(h)('t1').fire('dblclick', {}); await h.settle();
  assert.equal(await widthOnDisk(h), undefined, 'double click removes the width');
  assert.equal(h.view.history.past.length, past + 8);
  await h.view.travel(false);
  assert.ok((await widthOnDisk(h)) > 0, 'undo of the reset brings the width back in one step');
});

test('text-node-width: editing an automatic block grows its width with the text (32..300) and gives it back on close; a set width stays', async () => {
  const h = await harness(() => [txt({ text: 'hi' }), free({ width: 180 })]);
  h.view.startTextEdit('t1');
  const el = h.textEl('t1'), area = find(el, i => i.tag === 'textarea'), measure = find(el, i => i.classes.includes('vam-text-node-measure'));
  measure.offsetWidth = 120; area.fire('input');
  assert.equal(el.style.width, '136px');
  measure.offsetWidth = 5000; area.fire('input');
  assert.equal(el.style.width, '300px');
  measure.offsetWidth = 0; area.fire('input');
  assert.equal(el.style.width, '32px');
  area.fire('keydown', { key: 'Escape' });
  assert.equal(el.style.width, undefined, 'automatic again after closing');
  h.view.startTextEdit('f1');
  const fixed = h.textEl('f1');
  assert.equal(find(fixed, i => i.classes.includes('vam-text-node-measure')), undefined);
  find(fixed, i => i.tag === 'textarea').fire('input');
  assert.equal(fixed.style.width, '180px');
});

test('text-node-width: a left layout line ends on the real (fitted) right edge of the block', async () => {
  const h = await harness(({ root }) => [txt({ parentId: root.id, text: 'hello~~' })]);
  const root = h.view.cardEls.get(h.root.id), el = h.textEl('t1');
  Object.assign(root, { offsetLeft: 500, offsetTop: 0, offsetWidth: 100, offsetHeight: 50 });
  Object.assign(el, { offsetLeft: 300, offsetTop: 10, offsetWidth: 60, offsetHeight: 28 });
  h.view.map.layout = { direction: 'left' };
  h.view.edgesEl = { children: [], replaceChildren() { this.children = []; }, appendChild(c) { this.children.push(c); } };
  h.view.relationsLayerEl = { children: [], replaceChildren() {}, appendChild() {} };
  h.view.drawEdges();
  const path = h.view.edgesEl.children.find(p => p.classes.includes('vam-text-edge'));
  assert.ok(String(path.attrs.d).endsWith('360 24'), path.attrs.d);
});

// text-node-width: a committed width re-places the block the way the layout would (same undo step); a left drag keeps the right edge.
async function withLayout(h, direction) {
  h.view.map.layout = { direction };
  Object.assign(h.view.map.nodes[0], { x: 800, y: 100 });
  Object.assign(h.view.map.nodes[1], { x: 800, y: 400 });
  await h.repo.saveMap(MAP, h.view.map);
  h.view.map = await h.repo.readMap(MAP);
  await h.view.hydrate();
  h.view.render();
  h.view.arrangeAll(h.view.map);
  await h.repo.saveMap(MAP, h.view.map);
  h.view.render();
}
const textOnDisk = async (h, id = 't1') => (await h.onDisk()).find(i => i.id === id);
const WIDE = 'wide text that is longer than a card width '.repeat(3);

test('text-node-width: left layout, End key at 560 grows leftward and leaves the topic card clear; one undo restores width and x', async () => {
  const h = await harness(({ root }) => [txt({ parentId: root.id, text: WIDE, width: 100, x: 0, y: 0 })]);
  await withLayout(h, 'left');
  const topic = h.view.map.nodes[0];
  const before = await textOnDisk(h);
  const past = h.view.history.past.length;
  handleOf(h)('t1').fire('keydown', { key: 'End' });
  await h.settle();
  const after = await textOnDisk(h);
  assert.equal(after.width, 560);
  assert.ok(after.x + 560 <= topic.x, `box ${after.x}+560 must end left of the topic at ${topic.x}`);
  assert.ok(after.x < before.x, 'moved left');
  assert.equal(h.view.history.past.length, past + 1);
  await h.view.travel(false);
  const undone = await textOnDisk(h);
  assert.equal(undone.width, 100);
  assert.equal(undone.x, before.x, 'one undo restores the position too');
  assert.equal(undone.y, before.y);
});

test('text-node-width: left layout drag keeps the right edge live, then settles clear of the topic card', async () => {
  const h = await harness(({ root }) => [txt({ parentId: root.id, text: WIDE, width: 100, x: 0, y: 0 })]);
  await withLayout(h, 'left');
  const topic = h.view.map.nodes[0];
  const start = await textOnDisk(h);
  const el = h.textEl('t1');
  el.offsetWidth = 100;
  const handle = handleOf(h)('t1');
  pointer(handle, 'pointerdown', 0); pointer(handle, 'pointermove', 200);
  assert.equal(el.style.width, '300px');
  assert.equal(parseFloat(el.style.left) + 300, start.x + 100, 'right edge anchored while dragging');
  pointer(handle, 'pointermove', 5000); pointer(handle, 'pointerup', 5000);
  await h.settle();
  const after = await textOnDisk(h);
  assert.equal(after.width, 560);
  assert.ok(after.x + 560 <= topic.x, `box ${after.x}+560 must end left of the topic at ${topic.x}`);
});

test('text-node-width: right layout keeps the box x when the width changes', async () => {
  const h = await harness(({ root }) => [txt({ parentId: root.id, text: WIDE, width: 100, x: 0, y: 0 })]);
  await withLayout(h, 'right');
  const before = await textOnDisk(h);
  handleOf(h)('t1').fire('keydown', { key: 'End' });
  await h.settle();
  const after = await textOnDisk(h);
  assert.equal(after.width, 560);
  assert.equal(after.x, before.x);
});

test('text-node-width: down layout at 560 does not overlap its sibling text block', async () => {
  const h = await harness(({ root }) => [
    txt({ parentId: root.id, text: WIDE, width: 100, x: 0, y: 0 }),
    txt({ id: 't2', parentId: root.id, text: 'sibling', width: 100, x: 0, y: 0 })
  ]);
  await withLayout(h, 'down');
  const a = await textOnDisk(h), b = await textOnDisk(h, 't2');
  assert.ok(Math.abs(a.x - b.x) >= 100 || Math.abs(a.y - b.y) >= 20, 'precondition: placed apart');
  handleOf(h)('t1').fire('keydown', { key: 'End' });
  await h.settle();
  const w = await textOnDisk(h), s = await textOnDisk(h, 't2');
  assert.equal(w.width, 560);
  const clearX = w.x + 560 <= s.x || s.x + 100 <= w.x;
  const clearY = w.y + 30 <= s.y || s.y + 30 <= w.y;
  assert.ok(clearX || clearY, `wide box (${w.x},${w.y}) overlaps sibling (${s.x},${s.y})`);
});
