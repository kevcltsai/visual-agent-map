// text-then-topic P2: the View adds, deletes, promotes, moves and lays out topics that follow a text block (`afterTextId`),
// draws the line from the block, and feeds the block to the AI context. Every write is one undo step and Map.md reopens.
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

// Root (P) with a text block t1 and a direct child "Child"; followers are added by the tests.
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
  Object.assign(root, { x: 80, y: 80 });
  Object.assign(child, { x: 420, y: 80 });
  doc.nodes.push(root, child);
  doc.canvasItems = build ? build({ root, child }) : [txt({ parentId: root.id, x: 420, y: 300 })];
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
  view.focusNode = () => {}; view.openDetails = () => {}; view.mergeUnlocked = () => true;
  view.hydrate = async () => { view.notes = new Map(await Promise.all(view.map.nodes.map(async n => [n.id, await repo.readNote(n.path)]))); };
  await view.hydrate();
  view.render = () => {
    view.stageEl.children = []; view.cardEls.clear(); view.textEls.clear();
    for (const n of view.map.nodes) view.cardEls.set(n.id, view.stageEl.child('div', 'vam-node'));
    view.renderCanvasItems();
    for (const el of view.textEls.values()) {
      let fitted;
      Object.defineProperty(el, 'offsetWidth', { configurable: true, get() { return this.style.width ? parseFloat(this.style.width) : fitted; }, set(v) { fitted = v; } });
    }
  };
  view.render();
  const settle = async () => { await pending; await dom.tick(); await pending; };
  const disk = async () => plain(await repo.readMap(MAP));
  const raw = () => core.parseMap(contents.get(MAP));
  const noteFiles = () => [...contents.keys()].filter(k => k.endsWith('.md') && !k.endsWith('Map.md'));
  const textEl = id => find(view.stageEl, i => i.dataset.itemId === id);
  view.announcer = element('div');
  const node = title => view.map.nodes.find(n => view.notes.get(n.id)?.title === title);
  const addFollower = async title => { await view.addNode(view.map.nodes[0], title, true, false, 'topic', false, {}, 't1'); await view.hydrate(); };
  const state = () => JSON.stringify([view.map.nodes.map(n => [n.id, n.parentId, n.afterTextId, n.x, n.y]), view.map.canvasItems]);
  return { repo, view, contents, root, child, settle, disk, raw, noteFiles, textEl, notices, menus, node, addFollower, state };
}
const W = 300;
function assertSaved(map, label = '') {
  const ids = new Set(map.nodes.map(n => n.id));
  for (const n of map.nodes) assert.ok(n.parentId === null || ids.has(n.parentId), `${label}: parentId ${n.parentId} of ${n.id} is a node id`);
}
// Boxes of every card (default 300x180) and every text block (width as drawn) that overlap.
function overlaps(h) {
  const boxes = h.view.map.nodes.map(n => ({ id: n.id, x: n.x, y: n.y, w: W, ht: 180 }));
  for (const t of h.view.map.canvasItems ?? []) if (t.kind === 'text') boxes.push({ id: t.id, x: t.x, y: t.y, w: h.view.textWidthOf(t.id) ?? 60, ht: 28 });
  const hits = [];
  boxes.forEach((a, i) => boxes.slice(i + 1).forEach(b => { if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.ht && b.y < a.y + a.ht) hits.push(`${a.id}/${b.id}`); }));
  return hits;
}

test('add: a topic added after a text block follows it, sits clear and to the right, makes no note for the text, is one undo step and reopens', async () => {
  const h = await harness();
  h.view.cardHeightOf = id => (id === 't1' ? 28 : 180);
  const files = h.noteFiles().length, past = h.view.history.past.length;
  await h.view.addNode(h.view.map.nodes[0], 'C1', true, false, 'topic', false, {}, 't1');
  await h.settle();
  const c1 = h.node('C1');
  assert.equal(c1.afterTextId, 't1');
  assert.equal(c1.parentId, h.root.id, 'parentId stays the real topic');
  assert.equal(h.view.history.past.length, past + 1);
  assert.equal(h.noteFiles().length, files + 1, 'one note for the topic, none for the text');
  const t = h.view.map.canvasItems[0];
  assert.ok(c1.x > t.x, 'after the text block');
  const saved = await h.disk();
  assert.equal(saved.nodes.find(n => n.id === c1.id).afterTextId, 't1', 'the field survives reopening');
  assertSaved(h.raw(), 'add');
  await h.view.hydrate();
  await h.view.addNode(h.view.map.nodes[0], 'C2', true, false, 'topic', false, {}, 't1');
  const c2 = h.node('C2');
  assert.equal(c2.afterTextId, 't1', 'several topics can follow one text');
  assert.deepEqual(overlaps(h), []);
  await h.view.travel(false);
  assert.equal(h.view.map.nodes.some(n => n.afterTextId === 't1' && n.id === c2.id), false);
  assert.ok(h.view.map.nodes.some(n => n.id === c1.id));
});

test('add: a text block of another topic, a missing block or none gives an ordinary child (no field)', async () => {
  const h = await harness();
  await h.view.addNode(h.view.map.nodes[1], 'Wrong', true, false, 'topic', false, {}, 't1');
  await h.view.addNode(h.view.map.nodes[0], 'Gone', true, false, 'topic', false, {}, 'nope');
  await h.view.addNode(h.view.map.nodes[0], 'Plain', true, false);
  for (const title of ['Wrong', 'Gone', 'Plain']) assert.equal('afterTextId' in h.node(title), false, title);
});

test('plus: an attached text block has a + like a card; its menu lists topic kinds, no Add text; a pick adds a follower', async () => {
  const h = await harness();
  const add = find(h.textEl('t1'), i => i.hasClass('vam-text-add'));
  assert.ok(add, 'the + is drawn');
  assert.equal(add.attrs['aria-label'], 'Add a topic after this text');
  add.fire('click', { stopPropagation() {} });
  const menu = h.menus.at(-1);
  assert.ok(menu.items.length >= 1);
  assert.equal(menu.items.some(i => /Add text/i.test(i.title)), false, 'no text row');
  const past = h.view.history.past.length;
  menu.items[0].click();
  await h.settle();
  const added = h.view.map.nodes.find(n => n.afterTextId === 't1');
  assert.ok(added, 'the pick added a follower');
  assert.equal(added.parentId, h.root.id);
  assert.equal(h.view.history.past.length, past + 1);
});

test('plus: not on a free block, not in selection mode, AIM or presentation', async () => {
  const free = await harness(({ root }) => [txt({ id: 'f1', x: 5, y: 6 }), txt({ parentId: root.id })]);
  assert.equal(find(free.textEl('f1'), i => i.hasClass('vam-text-add')), undefined, 'free block');
  assert.ok(find(free.textEl('t1'), i => i.hasClass('vam-text-add')));
  const multi = await harness();
  multi.view.selection.toggleMultiSelect();
  assert.equal(multi.view.selection.state.multiSelectMode, true);
  multi.view.render();
  assert.equal(find(multi.textEl('t1'), i => i.hasClass('vam-text-add')), undefined, 'selection mode');
  const aim = await harness();
  aim.view.map.aim = { branches: [] };
  aim.view.render();
  assert.equal(find(aim.textEl('t1'), i => i.hasClass('vam-text-add')), undefined, 'AIM');
  const present = await harness();
  present.view.presentation = { order: [], currentId: 'x' };
  present.view.render();
  assert.equal(find(present.textEl('t1'), i => i.hasClass('vam-text-add')), undefined, 'presenting');
});

test('delete: the followers stay and reconnect to the topic, notes are untouched, one undo restores everything, Map.md reopens', async () => {
  const h = await harness();
  await h.addFollower('C1');
  await h.addFollower('C2');
  await h.settle();
  const before = h.state();
  const notes = new Map(h.noteFiles().map(p => [p, h.contents.get(p)]));
  const past = h.view.history.past.length;
  h.textEl('t1').fire('keydown', { key: 'Delete' });
  await h.settle();
  assert.equal(h.view.history.past.length, past + 1, 'one undo step');
  for (const title of ['C1', 'C2']) {
    const n = h.node(title);
    assert.ok(n, `${title} stays`);
    assert.equal(n.parentId, h.root.id);
    assert.equal('afterTextId' in n, false);
  }
  assert.equal(h.node('C1').x, h.root.x + 360, 'laid out as direct children of the topic again (the first column after the topic)');
  assert.equal(h.node('C2').x, h.root.x + 360);
  assert.equal((h.view.map.canvasItems ?? []).length, 0);
  assert.deepEqual(h.noteFiles().sort(), [...notes.keys()].sort(), 'no note file removed or added');
  for (const [p, text] of notes) assert.equal(h.contents.get(p), text, `${p} unchanged`);
  assertSaved(h.raw(), 'delete');
  assert.deepEqual(overlaps(h), []);
  await h.view.travel(false);
  assert.equal(h.state(), before, 'undo restores text, fields and places');
  assertSaved(h.raw(), 'undo');
  assert.equal((await h.disk()).nodes.filter(n => n.afterTextId === 't1').length, 2);
  await h.view.travel(true);
  assert.equal(h.node('C1').afterTextId, undefined, 'redo deletes again');
  assertSaved(h.raw(), 'redo');
});

test('delete by clearing the text: same result as Delete, one undo step', async () => {
  const h = await harness();
  await h.addFollower('C1');
  const before = h.state(), past = h.view.history.past.length;
  await h.view.saveTextItem('t1', '   ');
  await h.settle();
  assert.equal(h.node('C1').parentId, h.root.id);
  assert.equal(h.node('C1').x, h.root.x + 360, 'laid out again as a direct child');
  assert.equal('afterTextId' in h.node('C1'), false);
  assert.equal(h.view.history.past.length, past + 1);
  assertSaved(h.raw(), 'clear');
  await h.view.travel(false);
  assert.equal(h.state(), before);
});

test('promote: the followers become children of the new card, one undo step restores them, Map.md reopens', async () => {
  const h = await harness();
  await h.addFollower('C1');
  await h.addFollower('C2');
  await h.settle();
  const before = h.state();
  const past = h.view.history.past.length;
  await h.view.promoteTextNode('t1');
  await h.settle();
  await h.view.hydrate();
  const promoted = h.view.map.nodes.find(n => h.view.notes.get(n.id)?.title === 'Hello');
  assert.ok(promoted, 'a card for the text exists');
  for (const title of ['C1', 'C2']) {
    assert.equal(h.node(title).parentId, promoted.id, `${title} hangs under the new card`);
    assert.equal('afterTextId' in h.node(title), false);
  }
  assert.equal((h.view.map.canvasItems ?? []).some(i => i.id === 't1'), false);
  assert.equal(h.view.history.past.length, past + 1, 'the whole conversion is one history entry');
  assertSaved(h.raw(), 'promote');
  assert.deepEqual(overlaps(h), []);
  await h.view.travel(false);
  const restored = JSON.parse(h.state());
  assert.deepEqual(restored[0].map(r => r.slice(0, 3)), JSON.parse(before)[0].map(r => r.slice(0, 3)), 'one undo: the same nodes, parents and fields');
  assert.equal(h.view.map.canvasItems[0].id, 't1');
  assertSaved(h.raw(), 'undo promote');
});

test('move: dragging a follower elsewhere, Move to..., or onto its own topic clears the field; the map reopens', async () => {
  const h = await harness();
  await h.addFollower('C1');
  await h.addFollower('C2');
  await h.addFollower('C3');
  const [c1, c2, c3] = ['C1', 'C2', 'C3'].map(h.node);
  await h.view.moveTopic(c1, h.child);
  assert.equal(h.node('C1').parentId, h.child.id);
  assert.equal('afterTextId' in h.node('C1'), false, 'moved to another topic');
  assertSaved(h.raw(), 'moveTopic');
  await h.view.moveBranches([c2], h.view.map.nodes[0]);
  assert.equal(h.node('C2').parentId, h.root.id);
  assert.equal('afterTextId' in h.node('C2'), false, 'dropped on its own topic: a direct child');
  assert.equal(h.node('C3').afterTextId, 't1', 'a sibling follower is untouched');
  assertSaved(h.raw(), 'moveBranches');
  await h.view.travel(false);
  assert.equal(h.node('C2').afterTextId, 't1', 'undo brings the link back');
  // The drag target test: a follower can be dropped on its own topic, a direct child cannot.
  h.view.cardEls = new Map([[h.root.id, { offsetLeft: 0, offsetTop: 0, offsetWidth: 100, offsetHeight: 100 }]]);
  assert.ok(h.view.reparentTargetAt(10, 10, [h.node('C2')], h.node('C2').id), 'follower on its own topic');
  assert.equal(h.view.reparentTargetAt(10, 10, [h.child], 'x'), null, 'a direct child is already there');
});

test('R2: coordinate-only writes (updateMap) keep the text block and the field; the saved map reopens', async () => {
  const h = await harness();
  await h.addFollower('C1');
  const c1 = h.node('C1');
  await h.repo.updateMap(MAP, map => { for (const n of map.nodes) if (n.id === c1.id) Object.assign(n, { x: 999, y: 111 }); });
  await h.repo.updateMap(MAP, map => { map.viewport = { x: 1, y: 2, zoom: 1.5 }; });
  const saved = await h.disk();
  assert.equal(saved.canvasItems.some(i => i.id === 't1'), true);
  assert.equal(saved.nodes.find(n => n.id === c1.id).afterTextId, 't1');
  assertSaved(h.raw(), 'updateMap');
});

test('resize and edit: a text block with followers lays them out again in the same step, so they stay clear of it', async () => {
  const h = await harness(({ root }) => [txt({ parentId: root.id, x: 420, y: 300, text: 'short' })]);
  h.view.cardHeightOf = id => (id === 't1' ? 28 : 180);
  await h.addFollower('C1');
  const t = () => h.view.map.canvasItems[0];
  const gap = () => h.node('C1').x - (t().x + (h.view.textWidthOf('t1') ?? 60));
  assert.ok(gap() >= 0, 'clear before');
  const past = h.view.history.past.length;
  await h.view.resizeText('t1', 560, 60);
  await h.settle();
  assert.equal(h.view.history.past.length, past + 1, 'one undo step for the width and the layout');
  assert.equal(t().width, 560);
  assert.ok(h.node('C1').x >= t().x + 560, `C1 moved clear of the wider block (x=${h.node('C1').x})`);
  await h.view.saveTextItem('t1', 'a much longer text '.repeat(10));
  await h.settle();
  assert.deepEqual(overlaps(h).filter(s => s.includes('t1')), [], 'no overlap with the block after its text changed');
  assertSaved(h.raw(), 'resize');
  await h.view.travel(false);
  await h.view.travel(false);
  assert.equal(h.view.map.canvasItems[0].width, undefined, 'undo restores the width');
});

test('edges: a follower line starts at the text block (key T,C); without the block drawn it falls back to the topic', async () => {
  const h = await harness();
  await h.addFollower('C1');
  const c1 = h.node('C1');
  const place = (el, x) => Object.assign(el, { offsetLeft: x, offsetTop: 0, offsetWidth: 100, offsetHeight: 50 });
  place(h.view.cardEls.get(h.root.id), 0); place(h.view.cardEls.get(c1.id), 400); place(h.textEl('t1'), 200);
  h.view.edgesEl = { children: [], replaceChildren() { this.children = []; }, appendChild(c) { this.children.push(c); } };
  h.view.relationsLayerEl = { children: [], replaceChildren() {}, appendChild() {} };
  h.view.drawEdges();
  assert.ok(h.view.edgeEls.has(`t1\u0000${c1.id}`), 'line from the text');
  assert.equal(h.view.edgeEls.has(`${h.root.id}\u0000${c1.id}`), false);
  h.view.textEls.delete('t1');
  h.view.drawEdges();
  assert.ok(h.view.edgeEls.has(`${h.root.id}\u0000${c1.id}`), 'block not drawn: from the topic');
});

test('AI context: a follower reads the block first; the block lists what follows it; a map without followers is unchanged', async () => {
  const h = await harness(({ root }) => [txt({ parentId: root.id, text: 'lead in' }), txt({ id: 't2', parentId: root.id, text: 'second', x: 1, y: 2 })]);
  const beforeContext = h.view.userTextContext(h.root.id);
  const beforeChat = JSON.stringify(h.view.chatUserTexts());
  assert.equal(beforeContext, '- lead in\n- second');
  assert.equal(beforeChat.includes('followedBy'), false);
  await h.view.addNode(h.view.map.nodes[0], 'C1', true, false, 'topic', false, {}, 't2');
  await h.view.hydrate();
  const c1 = h.node('C1');
  assert.equal(h.view.userTextContext(c1.id), '- second', 'the block it follows, read-only text');
  const child = h.view.userTextContext(h.child.id);
  assert.equal(child, '', 'other topics are unchanged');
  assert.equal(h.view.userTextContext(h.root.id), beforeContext, 'the topic itself reads its blocks as before');
  const texts = h.view.chatUserTexts();
  assert.deepEqual(plain(texts.find(t => t.id === 't2').followedBy), [c1.id]);
  assert.equal('followedBy' in texts.find(t => t.id === 't1'), false);
});

test('copy: copying a branch gives direct children (the copy of a follower follows no block); the text is not copied', async () => {
  const h = await harness();
  await h.addFollower('C1');
  const target = h.child;
  h.view.selection.replaceMulti([h.root.id]);
  await h.view.copyBranches([h.view.map.nodes[0]], target, {});
  const copies = h.view.map.nodes.filter(n => n.parentId === target.id);
  assert.ok(copies.length >= 1);
  assert.equal(h.view.map.nodes.filter(n => n.afterTextId).length, 1, 'only the original follower has the field');
  assertSaved(h.raw(), 'copy');
});

test('duplicate map: the copy keeps the follower relation (text ids are unchanged)', async () => {
  const h = await harness();
  await h.addFollower('C1');
  const path = await h.repo.duplicateMap(MAP, 'Copy');
  const copy = await h.repo.readMap(path);
  const follower = copy.nodes.find(n => n.afterTextId);
  assert.ok(follower, 'the field is kept');
  assert.equal(follower.afterTextId, 't1');
  assert.ok(copy.canvasItems.some(i => i.id === 't1' && i.parentId === follower.parentId), 'the text hangs on the copied parent');
  assertSaved(core.parseMap(h.contents.get(path)), 'duplicate');
});

test('sibling order: shifting or reordering direct children does not move followers, and the reverse', async () => {
  const layout = load('map-layout.ts');
  const order = load('experiences/visual-map/presentation-order.ts');
  const n = (id, extra = {}) => ({ id, path: `${id}.md`, parentId: 'p', x: 0, y: 0, collapsed: false, ...extra });
  const nodes = [n('a'), n('f1', { afterTextId: 't' }), n('b'), n('f2', { afterTextId: 't' })];
  assert.deepEqual(plain(layout.reorderSiblings(nodes, 'p', 'b', 'a')).map(x => x.id), ['b', 'f1', 'a', 'f2'], 'direct children trade places only with each other');
  assert.deepEqual(plain(layout.reorderSiblings(nodes, 'p', 'f2', 'f1')).map(x => x.id), ['a', 'f2', 'b', 'f1']);
  assert.equal(layout.reorderSiblings(nodes, 'p', 'f1', 'a'), nodes, 'a follower is not placed before a direct child');
  assert.deepEqual(plain(layout.orderSiblings(nodes, 'p', ['b', 'a'])).map(x => x.id), ['b', 'f1', 'a', 'f2']);
  assert.equal(layout.orderSiblings(nodes, 'p', ['a', 'f1']), nodes, 'a mixed list changes nothing');
  const screen = [n('a', { y: 300 }), n('f1', { afterTextId: 't', y: 0 }), n('b', { y: 100 }), n('f2', { afterTextId: 't', y: 200 })];
  const aligned = order.alignSiblingsToScreen(screen, () => 'y');
  assert.deepEqual(aligned.map(x => x.id), ['b', 'f1', 'a', 'f2'], 'each group is sorted among itself');
});

test('share: the payload keeps the link only for a block in the payload on the same parent; brackets skip followers', async () => {
  const share = load('experiences/sharing/share-format.ts');
  const node = (id, parentId, extra = {}) => ({ id, path: `${id}.md`, parentId, x: 0, y: 0, collapsed: false, ...extra });
  const map = (nodes, canvasItems) => ({ version: 1, id: 'm', title: 'M', nodes, viewport: { x: 0, y: 0, zoom: 1 }, canvasItems });
  const opts = { includeDetail: false, includeImages: false, language: 'en', vamVersion: '1', exportedAt: 'x' };
  const t = { id: 't', kind: 'text', text: 'hi', parentId: 'p', x: 1, y: 2 };
  const ok = share.buildSharePayload(map([node('p', null), node('c', 'p', { afterTextId: 't' }), node('d', 'p')], [t]), {}, opts);
  assert.equal(ok.nodes.find(n => n.id === 'c').afterTextId, 't');
  assert.equal('afterTextId' in ok.nodes.find(n => n.id === 'd'), false);
  const noText = share.buildSharePayload(map([node('p', null), node('c', 'p', { afterTextId: 't' })], []), {}, opts);
  assert.equal('afterTextId' in noText.nodes.find(n => n.id === 'c'), false, 'no block in the payload');
  const other = share.buildSharePayload(map([node('p', null), node('q', null), node('c', 'p', { afterTextId: 't' })], [{ ...t, parentId: 'q' }]), {}, opts);
  assert.equal('afterTextId' in other.nodes.find(n => n.id === 'c'), false, 'block on another parent');
  const bare = share.buildSharePayload(map([node('p', null), node('c', 'p')], []), {}, opts);
  assert.equal(JSON.stringify(bare).includes('afterTextId'), false, 'a map without followers carries no field');
  const bracket = { id: 's', kind: 'summary', parentId: 'p', members: ['d', 'e'], text: 'sum' };
  const withBracket = share.buildSharePayload(map([node('p', null), node('d', 'p'), node('c', 'p', { afterTextId: 't' }), node('e', 'p')], [t, bracket]), {}, opts);
  assert.deepEqual(withBracket.summaries[0].members, ['d', 'e'], 'the follower is not in the row the bracket frames');
});

// CONTRACT CHANGE (Acceptance: the line to a follower starts on the block): the old assertions locked the P->T bone rib
// (treeEdgePathData(..., 'fishbone', 2)), which never touches the block. A fishbone follower line is now the straight line T -> C.
const onBox = (d, b, end = false) => {
  const [x, y] = (end ? d.match(/([\d.-]+) ([\d.-]+)$/) : d.match(/^M ([\d.-]+) ([\d.-]+)/)).slice(1).map(Number);
  const inX = x >= b.x - 0.01 && x <= b.x + b.width + 0.01, inY = y >= b.y - 0.01 && y <= b.y + b.height + 0.01;
  return (inX && (Math.abs(y - b.y) < 0.01 || Math.abs(y - b.y - b.height) < 0.01)) || (inY && (Math.abs(x - b.x) < 0.01 || Math.abs(x - b.x - b.width) < 0.01));
};
async function fishboneHarness() {
  const h = await harness();
  await h.addFollower('C1');
  const c1 = h.node('C1');
  h.view.map.layout = { direction: 'fishbone' };
  const boxes = { [h.root.id]: [0, 0], [h.child.id]: [400, 200], [c1.id]: [700, 0], t1: [400, 100] };
  for (const [id, [x, y]] of Object.entries(boxes)) Object.assign(h.view.cardEls.get(id) ?? h.textEl(id), { offsetLeft: x, offsetTop: y, offsetWidth: 100, offsetHeight: 50 });
  h.view.edgesEl = { children: [], replaceChildren() { this.children = []; }, appendChild(c) { this.children.push(c); } };
  h.view.relationsLayerEl = { children: [], replaceChildren() {}, appendChild() {} };
  h.view.drawEdges();
  const box = id => { const e = h.view.cardEls.get(id) ?? h.textEl(id); return { x: e.offsetLeft, y: e.offsetTop, width: e.offsetWidth, height: e.offsetHeight }; };
  return { h, c1, box };
}

test('fishbone: the follower line is the straight line from the block to the follower, and the spine joins only first-level topics', async () => {
  const geometry = load('experiences/visual-map/relation-geometry.ts');
  const { h, c1, box } = await fishboneHarness();
  const drawn = h.view.edgeEls.get(`t1\u0000${c1.id}`).attrs.d;
  assert.equal(drawn, geometry.relationPathData(box('t1'), box(c1.id)), 'a straight line T -> C, as radial draws it');
  assert.ok(onBox(drawn, box('t1')), `the line starts on the block's box: ${drawn}`);
  assert.notEqual(drawn, geometry.treeEdgePathData(box('t1'), box(c1.id), 'fishbone', 2), 'not the rib that never touches the block');
  h.view.canvasNodes = () => h.view.map.nodes;
  const spine = h.view.spineBoxes(h.root.id);
  assert.deepEqual(plain(spine.topics.map(topic => topic.id)), [h.child.id], 'the follower is not a bone of the spine');
});

test('fishbone: while dragging the follower, its block or the group, the line keeps starting on the block', async () => {
  const { h, c1, box } = await fishboneHarness();
  const key = `t1\u0000${c1.id}`;
  const size = { offsetWidth: 100, offsetHeight: 50 };
  h.view.dragEdges(c1.id, size).update(900, 300);
  assert.ok(onBox(h.view.edgeEls.get(key).attrs.d, box('t1')), `drag C: ${h.view.edgeEls.get(key).attrs.d}`);
  assert.ok(onBox(h.view.edgeEls.get(key).attrs.d, { x: 900, y: 300, width: 100, height: 50 }, true), 'and ends on the dragged C');
  h.view.drawEdges();
  h.view.dragEdges('t1', size).update(300, 20);
  assert.ok(onBox(h.view.edgeEls.get(key).attrs.d, { x: 300, y: 20, width: 100, height: 50 }), `drag T: ${h.view.edgeEls.get(key).attrs.d}`);
  h.view.drawEdges();
  h.view.groupDragEdges(new Map([[c1.id, h.view.cardEls.get(c1.id)]])).update(50, 80);
  assert.ok(onBox(h.view.edgeEls.get(key).attrs.d, box('t1')), `group drag C: ${h.view.edgeEls.get(key).attrs.d}`);
  h.view.drawEdges();
  h.view.groupDragEdges(new Map([['t1', h.textEl('t1')], [c1.id, h.view.cardEls.get(c1.id)]])).update(50, 80);
  assert.ok(onBox(h.view.edgeEls.get(key).attrs.d, { ...box('t1'), x: 450, y: 180 }), `group drag T and C: ${h.view.edgeEls.get(key).attrs.d}`);
});

test('chat context: a text block lists the topics that follow it; the field and its note appear only then', () => {
  const { buildMapChatContext } = load('core/map-chat-context.ts');
  const outline = [{ id: 'r', title: 'Root', summary: '', parentId: null, depth: 0 }, { id: 'a', title: 'A', summary: '', parentId: 'r', depth: 1 }];
  const input = extra => ({ mapTitle: 'M', outline, selected: [], references: [], snippets: [], files: [], activeFile: null, history: [], ...extra });
  const bare = buildMapChatContext(input({ userTexts: [{ id: 'txt-1', parentId: 'r', text: 'lead' }] })).json;
  assert.equal(bare.includes('followedBy'), false, 'no followers: the same bytes as before');
  assert.equal(buildMapChatContext(input({ userTexts: [{ id: 'txt-1', parentId: 'r', text: 'lead', followedBy: [] }] })).json, bare, 'an empty list adds nothing');
  const parsed = JSON.parse(buildMapChatContext(input({ userTexts: [{ id: 'txt-1', parentId: 'r', text: 'lead', followedBy: ['a'] }] })).json);
  assert.deepEqual(parsed.userTexts[0], { id: 'txt-1', parentId: 'r', readOnly: true, text: 'lead', followedBy: ['a'] });
  assert.match(parsed.userTextsNote, /must not be rewritten or deleted/);
  assert.match(parsed.userTextsNote, /followedBy/);
});

// ledger R1: each + on a block drifted the block and every follower down (minTop was applied to the whole block).
for (const direction of ['right', 'left', 'balanced']) {
  test(`add: ${direction}: after 3 or more followers the block and the first follower stay put and the followers are evenly stacked`, async () => {
    const h = await harness(({ root }) => [txt({ parentId: root.id, x: 420, y: 80, text: 'hello' })]);
    h.view.map.layout = { direction };
    await h.repo.saveMap(h.view.path, h.view.map);
    h.view.map = await h.repo.readMap(h.view.path);
    h.view.cardHeightOf = id => (id === 't1' ? 28 : 180);
    const placed = [];
    for (const title of ['C1', 'C2', 'C3', 'C4']) {
      await h.addFollower(title);
      await h.settle();
      const t = h.view.map.canvasItems.find(i => i.id === 't1');
      const followers = h.view.map.nodes.filter(n => n.afterTextId === 't1').sort((a, b) => a.y - b.y);
      placed.push({ ty: t.y, tx: t.x, first: followers[0]?.y, firstX: followers[0]?.x, ys: followers.map(n => n.y) });
    }
    for (const p of placed.slice(1)) {
      assert.equal(p.ty, placed[0].ty, 'the block does not move');
      assert.equal(p.tx, placed[0].tx);
      assert.equal(p.first, placed[0].first, 'the first follower does not move');
    }
    const ys = placed[3].ys;
    assert.equal(ys.length, 4);
    const steps = ys.slice(1).map((y, i) => y - ys[i]);
    assert.ok(steps.every(s => s === steps[0] && s >= 180), `evenly stacked: ${steps}`);
    // The fixture's direct child sits on the block's spot; only the followers must be clear of everything.
    const follower = new Set(h.view.map.nodes.filter(n => n.afterTextId).map(n => n.id));
    assert.deepEqual(overlaps(h).filter(pair => pair.split('/').some(id => follower.has(id))), []);
    assertSaved(h.raw(), direction);
  });
}

// ledger R1: the chat said "done" for reorders and moves that changed nothing.
test('chat: reorder_topics with a follower and a direct child, or a move_topic before a follower, is skipped and changes nothing', async () => {
  const h = await harness();
  await h.addFollower('C1');
  await h.addFollower('C2');
  const [c1, c2] = [h.node('C1'), h.node('C2')];
  const apply = action => h.view.applyChatWrite(action, { mdHashes: {}, topicHashes: {} }, () => true);
  const before = h.state();
  const mixed = await apply({ kind: 'reorder_topics', parentId: h.root.id, nodeIds: [c1.id, h.child.id] });
  assert.equal(mixed.status, 'skipped', 'a follower and a direct child are not siblings');
  const moved = await apply({ kind: 'move_topic', nodeId: h.child.id, newParentId: h.root.id, beforeId: c1.id });
  assert.equal(moved.status, 'skipped', 'a follower is not a place among the direct children');
  assert.equal(h.state(), before, 'nothing changed');
  // Two followers of the same block still reorder, and the moved card stays a follower.
  const ok = await apply({ kind: 'reorder_topics', parentId: h.root.id, nodeIds: [c2.id, c1.id] });
  assert.equal(ok.status, 'done');
  assert.deepEqual(plain(h.view.map.nodes.filter(n => n.afterTextId).map(n => n.id)), [c2.id, c1.id]);
});

// ledger R1: a block's followers lay out against the block; moving the topic to the top level must take the block along.
test('move to top level: the block hanging on the moved topic and its followers land next to it, not left behind', async () => {
  const h = await harness(({ child }) => [txt({ parentId: child.id, x: 760, y: 80, text: 'hello' })]);
  h.view.cardHeightOf = id => (id === 't1' ? 28 : 180);
  await h.view.addNode(h.child, 'C1', true, false, 'topic', false, {}, 't1');
  await h.view.addNode(h.child, 'C2', true, false, 'topic', false, {}, 't1');
  await h.view.hydrate();
  // Park the branch far away first, so a left-behind block would be obvious.
  await h.view.moveBranches([h.view.map.nodes.find(n => n.id === h.child.id)], null);
  await h.settle();
  const child = h.view.map.nodes.find(n => n.id === h.child.id);
  const t = h.view.map.canvasItems.find(i => i.id === 't1');
  const followers = h.view.map.nodes.filter(n => n.afterTextId === 't1');
  assert.equal(followers.length, 2);
  assert.ok(Math.abs(t.x - child.x) <= 700 && Math.abs(t.y - child.y) <= 400, `block ${t.x},${t.y} near its topic ${child.x},${child.y}`);
  for (const f of followers) assert.ok(f.x > t.x && Math.abs(f.y - t.y) < 600, `follower ${f.x},${f.y} right of the block ${t.x},${t.y}`);
  assert.deepEqual(overlaps(h).filter(pair => pair.includes('t1')), []);
  assertSaved(h.raw(), 'top level');
});

// ledger R2: the reduced-motion rule sits before the "Map search" comment (scope tests read from there to the end), so it loses
// to the base rule by source order unless its selector is more specific. A real browser showed transition: opacity 120ms.
test('css: the + reduced-motion rule beats the base rule it sits above, and the hover bridge overlaps the width handle without covering it', () => {
  const css = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'styles.css'), 'utf8');
  const scopeStart = css.indexOf('/* Map search (Mod+F)');
  const media = /@media \(prefers-reduced-motion: reduce\) \{\s*([^{]*\.vam-text-add[^{]*)\{\s*transition:\s*none;?\s*\}\s*\}/.exec(css);
  assert.ok(media, 'reduced-motion rule for .vam-text-add exists');
  assert.ok(media.index < scopeStart, 'it stays above the first scoped block');
  const weight = selector => (selector.match(/\.[\w-]+|\[[^\]]+\]|:[\w-]+/g) ?? []).length;
  const bases = [...css.matchAll(/^([^@/{}\n][^{\n]*\.vam-text-add[^{\n]*)\{([^}]*)\}/gm)].filter(m => /transition:/.test(m[2]) && !m[1].includes('::'));
  assert.ok(bases.length >= 1, 'the base rule that sets the transition');
  for (const base of bases) {
    const baseWeight = weight(base[1].trim()), reducedWeight = weight(media[1].trim());
    assert.ok(reducedWeight > baseWeight || (reducedWeight === baseWeight && media.index > base.index), `reduced-motion (${reducedWeight}) beats the base rule (${baseWeight}) ${base[1].trim()}`);
  }
  const bridge = /\.vam-text-add::before \{[^}]*width:\s*(\d+(?:\.\d+)?)px/.exec(css);
  assert.ok(bridge && Number(bridge[1]) >= 4, `the bridge is wider than the 3px that left a hole: ${bridge?.[1]}`);
  const z = rule => Number(new RegExp(`${rule}[^{]*\\{[^}]*z-index:\\s*(\\d+)`).exec(css)?.[1] ?? 0);
  assert.ok(z('\\.vam-view \\.vam-text-resize ') > z('\\.vam-text-node > \\.vam-text-add '), 'the width handle stays above the + bridge where they overlap');
});

// ledger R2: widening or editing a block re-arranged from its topic, so the block itself moved (the + keeps it still).
for (const direction of ['right', 'left', 'balanced', 'down', 'up']) {
  test(`resize and edit: ${direction}: the block stays where it is and its followers move clear of it`, async () => {
    const h = await harness(({ root }) => [txt({ parentId: root.id, x: 420, y: 300, text: 'short' })]);
    h.view.map.layout = { direction };
    await h.repo.saveMap(h.view.path, h.view.map);
    h.view.map = await h.repo.readMap(h.view.path);
    h.view.cardHeightOf = id => (id === 't1' ? 28 : 180);
    await h.addFollower('C1');
    await h.addFollower('C2');
    await h.settle();
    const at = () => { const t = h.view.map.canvasItems.find(i => i.id === 't1'); return [t.x, t.y]; };
    const before = at();
    const from = h.view.textWidthOf('t1') ?? 60;
    // Widening itself may anchor the block's far edge (textAnchoredX, existing behaviour); the layout adds no move of its own.
    const anchored = [h.view.textAnchoredX('t1', from, 560), before[1]];
    await h.view.resizeText('t1', 560, from);
    await h.settle();
    assert.deepEqual(at(), anchored, `the block did not move when it was widened ${JSON.stringify(h.view.map.nodes.map(n => [n.x, n.y, n.afterTextId]))}`);
    const widened = at();
    await h.view.saveTextItem('t1', 'a much longer text '.repeat(10));
    await h.settle();
    assert.deepEqual(at(), widened, 'the block did not move when its text changed');
    assert.deepEqual(overlaps(h).filter(s => s.includes('t1')), [], 'followers clear of the wider block');
    assertSaved(h.raw(), direction);
  });
}
