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

// The text double: width is the inline width, else the text fitted (7px a character plus padding, 32..300); height is 7px plus 20px a line.
// The real text width is fractional (Chromium: 'hello~~' is 59.188 wide and offsetWidth says 59), so a block measured at its own
// rounded offsetWidth wraps to a second line; the double has the same 0.4px so that trap is in every probe.
const textBox = (text, width) => {
  const w = width ?? Math.min(300, Math.max(32, Math.round(text.length * 7 + 14.4)));
  // Automatic width fits the text on one line unless it hit the 300 cap; an inline width wraps at w - 14.
  const lines = width === undefined && w < 300 ? 1 : Math.ceil((text.length * 7 + 0.4) / Math.max(1, w - 14));
  return { w, h: 7 + 20 * Math.max(1, lines) };
};
// Root (P) with a text block t1 and a direct child "Child"; followers are added by the tests.
async function harness(build, opts = {}) {
  const { repo, app, contents } = fixture('en', { linkIndex: true });
  const settings = { ...DEFAULT_SETTINGS, language: 'en', cliModel: 'gpt-6-luna' };
  repo.settings = settings;
  const doc = { id: 'map-t', title: 'T', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 }, ...(opts.direction ? { layout: { direction: opts.direction } } : {}) };
  await repo.ensureTopicFolders(`${TOPICS}/map-t`);
  await app.vault.create(MAP, core.serializeMap(doc));
  const root = await repo.createNote('Root', 'gpt-6-luna', doc, MAP, 'workspace');
  const child = await repo.createNote('Child', 'gpt-6-luna', doc, MAP, 'workspace');
  child.parentId = root.id;
  Object.assign(root, { x: 80, y: 80 });
  Object.assign(child, { x: 420, y: 80 });
  doc.nodes.push(root, child);
  let other;
  if (opts.other) {
    other = await repo.createNote('Other', 'gpt-6-luna', doc, MAP, 'workspace');
    other.parentId = root.id;
    Object.assign(other, { x: 420, y: 700 });
    doc.nodes.push(other);
  }
  doc.canvasItems = build ? build({ root, child, other }) : [txt({ parentId: root.id, x: 420, y: 300 })];
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
  // Cards are 300 x 180. A text block's size is computed from its body text and inline width AT READ TIME (also for the hidden
  // measuring blocks the view builds and removes), the way the browser would; nothing here stubs cardHeightOf or textWidthOf.
  const bodyOf = el => find(el, i => dom.hasCls(i, 'vam-text-node-body'));
  const dimsOf = el => textBox(bodyOf(el)?.text ?? '', el.style.width ? parseFloat(el.style.width) : undefined);
  const withDims = el => {
    // A test may pin a size for the geometry checks (Object.assign(el, { offsetWidth })); otherwise the size is computed on every read.
    Object.defineProperty(el, 'offsetWidth', { configurable: true, get() { return this.pinnedW ?? dimsOf(this).w; }, set(v) { this.pinnedW = v; } });
    Object.defineProperty(el, 'offsetHeight', { configurable: true, get() { return this.pinnedH ?? dimsOf(this).h; }, set(v) { this.pinnedH = v; } });
  };
  view.render = () => {
    view.stageEl.children = []; view.cardEls.clear(); view.textEls.clear();
    for (const n of view.map.nodes) { const c = view.stageEl.child('div', 'vam-node'); c.offsetHeight = 180; c.offsetWidth = 300; view.cardEls.set(n.id, c); }
    view.renderCanvasItems();
    const layer = find(view.stageEl, i => dom.hasCls(i, 'vam-text-nodes'));
    if (!layer) return;
    for (const el of layer.children) withDims(el);
    const child = layer.child;
    layer.child = function (name, value) { const c = child.call(this, name, value); if (dom.hasCls(c, 'vam-text-node')) withDims(c); return c; };
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
// Boxes of every card (300 x 180) and every text block (the double's size for its data) that overlap.
function boxesOf(h) {
  const title = n => h.view.notes.get(n.id)?.title ?? n.id;
  const boxes = h.view.map.nodes.map(n => ({ id: title(n), x: n.x, y: n.y, w: 300, ht: 180 }));
  for (const t of h.view.map.canvasItems ?? []) if (t.kind === 'text') { const b = textBox(t.text, t.width); boxes.push({ id: t.id, x: t.x, y: t.y, w: b.w, ht: b.h }); }
  return boxes;
}
function overlaps(h, keep = () => true) {
  const boxes = boxesOf(h), hits = [];
  boxes.forEach((a, i) => boxes.slice(i + 1).forEach(b => { if (keep(a.id, b.id) && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.ht && b.y < a.y + a.ht) hits.push(`${a.id}/${b.id}`); }));
  return hits;
}

test('add: a topic added after a text block follows it, sits clear and to the right, makes no note for the text, is one undo step and reopens', async () => {
  const h = await harness();
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
  // Exact (replaces a loose distance threshold): the offsets are those of the branch laid out alone by Auto layout, within 1px.
  await h.view.hydrate();
  const now = snap(h), alone = reference(h, ['Child', 'C1', 'C2', 't1']);
  near(rel(now, 't1', 'Child'), rel(alone, 't1', 'Child'), 'block against its topic');
  for (const k of ['C1', 'C2']) near(rel(now, k, 't1'), rel(alone, k, 't1'), `${k} against the block`);
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
    const widened = at(), heightBefore = textBox('short', 560).h;
    await h.view.saveTextItem('t1', 'a much longer text '.repeat(10));
    await h.settle();
    // CONTRACT CHANGE (advisor.md rule table): in an up map the edge facing the topic is the bottom, so a taller block grows upward.
    const grown = textBox('a much longer text '.repeat(10).trim(), 560).h;
    assert.deepEqual(at(), direction === 'up' ? [widened[0], widened[1] + heightBefore - grown] : widened, 'the edge facing the topic did not move when its text changed');
    assert.deepEqual(overlaps(h).filter(s => s.includes('t1')), [], 'followers clear of the wider block');
    assertSaved(h.raw(), direction);
  });
}

// ---- Placement rule (advisor.md): one table-driven matrix, rule rows x 8 layouts, every case from a real Auto layout. ----------
// Sizes come from the text double above (computed at read time), never from a stub of cardHeightOf / textWidthOf.
const crypto = require('node:crypto');
const layoutLib = load('map-layout.ts');
const layoutText = load('map-layout-text.ts');
const balancedLib = load('layouts/balanced.ts');
const DIRS = ['right', 'left', 'balanced', 'down', 'up', 'radial', 'timeline', 'fishbone'];
const WHOLE = ['radial', 'timeline', 'fishbone']; // these lay the whole map out again (the first root stays), see the rule table
const LONG = 'x'.repeat(200);
const isFollower = k => /^C\d/.test(k);
const keyOf = (h, n) => h.view.notes.get(n.id)?.title ?? n.id;
const snap = h => {
  const out = {};
  for (const n of h.view.map.nodes) out[keyOf(h, n)] = { x: n.x, y: n.y };
  for (const t of h.view.map.canvasItems ?? []) if (t.kind === 'text') out[t.id] = { x: t.x, y: t.y };
  return out;
};
const boxOf = (h, id = 't1') => { const t = h.view.map.canvasItems.find(i => i.id === id); return textBox(t.text, t.width); };
const rel = (s, a, b) => [s[a].x - s[b].x, s[a].y - s[b].y];
const near = (actual, expected, label, tolerance = 1) => {
  assert.ok(actual.every((v, i) => Math.abs(v - expected[i]) <= tolerance), `${label}: ${JSON.stringify(actual)} vs ${JSON.stringify(expected)}`);
};
const sizeFns = items => {
  const item = id => items.find(i => i.id === id);
  return { heightOf: id => (item(id) ? textBox(item(id).text, item(id).width).h : 180), widthOf: id => (item(id) ? textBox(item(id).text, item(id).width).w : undefined) };
};
const snapOf = (h, nodes, items) => {
  const s = {};
  for (const n of nodes) s[keyOf(h, n)] = { x: n.x, y: n.y };
  for (const t of items) if (t.kind === 'text') s[t.id] = { x: t.x, y: t.y };
  return s;
};
// What Auto layout would give for the map as it stands now, or for one branch of it alone (`only`: node keys, the first one the root);
// sizes come from the data, not from the view's measurers.
function reference(h, only) {
  let items = plain(h.view.map.canvasItems ?? []), nodes = plain(h.view.map.nodes);
  if (only) {
    nodes = nodes.filter(n => only.includes(keyOf(h, n)));
    nodes.find(n => keyOf(h, n) === only[0]).parentId = null;
    items = items.filter(i => nodes.some(n => n.id === i.parentId));
  }
  const { heightOf, widthOf } = sizeFns(items);
  const out = layoutText.arrangeMapWithText(nodes, items, undefined, heightOf, h.view.map.layout ?? { direction: 'right' }, { widthOf });
  return snapOf(h, out.nodes, out.items);
}
// What the engine gives for the topics that follow the block when it is told the block's true size (and nothing else): the oracle for
// "the followers sit against the block as it is drawn now". Only `only` keys are laid out (default: every follower).
function againstBlock(h, only) {
  const items = plain(h.view.map.canvasItems), nodes = plain(h.view.map.nodes);
  const ids = new Set(nodes.filter(n => n.afterTextId === 't1' && (!only || only.includes(keyOf(h, n)))).map(n => n.id));
  const { heightOf, widthOf } = sizeFns(items);
  const out = layoutText.arrangeNewBranchWithText(nodes, items, 't1', ids, heightOf, undefined, h.view.map.layout ?? { direction: 'right' }, widthOf);
  return snapOf(h, out.nodes, out.items);
}
async function auto(h) {
  await h.view.mapChange(m => h.view.arrangeAll(m));
  await h.settle();
  await h.view.hydrate();
  h.view.render();
}
async function begin(direction, { text = 'hello', width, followers = ['C1'], on = 'root', other = false, wide = false } = {}) {
  const h = await harness(({ root, child }) => [
    txt({ parentId: (on === 'child' ? child : root).id, x: 420, y: 300, text, ...(width ? { width } : {}) }),
    ...(wide ? [txt({ id: 't2', parentId: (wide === 'child' ? child : root).id, x: 420, y: 520, text: 'wide sibling', width: 700 })] : [])
  ], { direction, other });
  h.view.render();
  const owner = () => h.view.map.nodes.find(n => n.id === (on === 'child' ? h.child.id : h.root.id));
  for (const title of followers) { await h.view.addNode(owner(), title, true, false, 'topic', false, {}, 't1'); await h.view.hydrate(); }
  await auto(h);
  return Object.assign(h, { owner });
}
const done = async h => { await h.settle(); await h.view.hydrate(); h.view.render(); };
// Only the pairs the feature promises: any pair with a follower, and the block against its own topic.
const relevant = (a, b) => isFollower(a) || isFollower(b) || [a, b].sort().join() === ['Root', 't1'].join();
const assertNoOverlap = (h, label) => assert.deepEqual(overlaps(h, relevant), [], `${label}: overlaps ${JSON.stringify(boxesOf(h))}`);
const oneUndo = async (h, before, past, label) => {
  assert.equal(h.view.history.past.length, past + 1, `${label}: one undo step`);
  await h.view.travel(false);
  await done(h);
  assert.deepEqual(snap(h), before, `${label}: undo restores every position`);
};

// Row "change T's width / T's text": T moves by its facing edge, its followers and their subtrees are laid out against it, nothing else moves.
function checkEdit(h, before, D, label) {
  const after = snap(h), a = boxOf(h), b = before.box, at = after.t1, t0 = before.pos.t1;
  if (WHOLE.includes(D)) assert.deepEqual(after.Root, before.pos.Root, `${label}: the first root stays`);
  else {
    for (const k of Object.keys(before.pos)) if (k !== 't1' && !isFollower(k)) assert.deepEqual(after[k], before.pos[k], `${label}: ${k} stays`);
    const facing = D === 'balanced' ? (balancedLib.sideFromTextBox(t0.x, b.w, before.pos.Root.x)) : D;
    if (facing === 'right') assert.deepEqual(at, t0, `${label}: right keeps x and y`);
    if (facing === 'left') { assert.equal(at.x + a.w, t0.x + b.w, `${label}: left keeps the right edge`); assert.equal(at.y, t0.y); }
    if (facing === 'down') { near([at.x + a.w / 2], [t0.x + b.w / 2], `${label}: down keeps the centre`, 0.5); assert.equal(at.y, t0.y, `${label}: down keeps the top`); }
    if (facing === 'up') { near([at.x + a.w / 2], [t0.x + b.w / 2], `${label}: up keeps the centre`, 0.5); assert.equal(at.y + a.h, t0.y + b.h, `${label}: up keeps the bottom`); }
  }
  const kids = Object.keys(after).filter(isFollower);
  assert.ok(kids.length >= 1);
  if (D === 'down' || D === 'up') {
    for (const k of kids) assert.equal(D === 'down' ? after[k].y : after[k].y + 180, D === 'down' ? at.y + a.h + 60 : at.y - 60, `${label}: ${k} one row ${D} of the block`);
    near([(Math.min(...kids.map(k => after[k].x)) + Math.max(...kids.map(k => after[k].x)) + 280) / 2], [at.x + a.w / 2], `${label}: followers (280 wide cards) centred on the block`);
  } else {
    const expected = againstBlock(h);
    for (const k of kids) near([after[k].x, after[k].y], [expected[k].x, expected[k].y], `${label}: ${k} against the block at its drawn size`);
    if (WHOLE.includes(D)) near([at.x, at.y], [expected.t1.x, expected.t1.y], `${label}: the block as the whole layout puts it`);
  }
  if (D === 'right') for (const k of kids) assert.equal(after[k].x, at.x + 360 + Math.max(0, a.w - 280), `${label}: ${k} one column right of the block`);
  // Left: the followers of one block share one column (never T.x - 360: a block narrower than a card keeps its right edge, so its
  // left edge is not where the column is measured from), and the column does not move when only the block's width changes.
  if (D === 'left') for (const k of kids) assert.equal(after[k].x, after[kids[0]].x, `${label}: ${k} shares the column of ${kids[0]}`);
  assertNoOverlap(h, label);
}
async function editCase(D, how) {
  const opts = { long: {}, keyboard: { text: LONG, width: 500 }, drag: { text: LONG, width: 500 }, auto: { text: LONG, width: 80 }, widen: {} }[how];
  const h = await begin(D, { ...opts, followers: ['C1', 'C2'] });
  const before = { pos: snap(h), box: boxOf(h) }, past = h.view.history.past.length;
  const fitted = textBox('hello').w;
  if (how === 'long') await h.view.saveTextItem('t1', LONG);
  if (how === 'keyboard') await h.view.resizeText('t1', 80, 500);
  if (how === 'drag') {
    // A pointer drag has already put the new width on the element when it commits; `from` is what was read before.
    const el = h.view.textEls.get('t1');
    el.style.width = '80px'; el.addClass('has-width');
    await h.view.resizeText('t1', 80, 500);
  }
  if (how === 'auto') await h.view.resizeText('t1', undefined, 80);
  if (how === 'widen') await h.view.resizeText('t1', 560, fitted);
  await done(h);
  checkEdit(h, before, D, `${D} ${how}`);
  await oneUndo(h, before.pos, past, `${D} ${how}`);
}
for (const D of DIRS) for (const how of ['long', 'keyboard', 'drag', 'auto', 'widen'])
  test(`placement: ${D}: change the block (${how}): the facing edge stays, the followers sit against it, nothing else moves, one undo`, () => editCase(D, how));

// Row "add C": only the new topic moves.
for (const D of DIRS)
  test(`placement: ${D}: add a topic after the block: only the new topic moves, against the block as drawn`, async () => {
    const h = await begin(D, { followers: [] });
    const pos0 = snap(h), box = boxOf(h);
    const past = h.view.history.past.length;
    await h.view.addNode(h.owner(), 'C1', true, false, 'topic', false, {}, 't1');
    await done(h);
    const s1 = snap(h);
    if (WHOLE.includes(D)) assert.deepEqual(s1.Root, pos0.Root);
    else for (const k of Object.keys(pos0)) assert.deepEqual(s1[k], pos0[k], `${k} stays`);
    if (D === 'down' || D === 'up') {
      assert.equal(D === 'down' ? s1.C1.y : s1.C1.y + 180, D === 'down' ? s1.t1.y + box.h + 60 : s1.t1.y - 60, 'one row from the block');
      // Cards are 280 wide; Auto layout's convention is the same, so the offset to the block's centre is what Auto gives (about 0).
      const ref = reference(h);
      near([s1.C1.x + 140 - (s1.t1.x + box.w / 2)], [0], 'card centre on the block centre', 1);
      near([s1.C1.x + 140 - (s1.t1.x + box.w / 2)], [ref.C1.x + 140 - (ref.t1.x + box.w / 2)], 'same offset as Auto layout', 1);
    } else {
      const expected = againstBlock(h, ['C1']);
      near([s1.C1.x, s1.C1.y], [expected.C1.x, expected.C1.y], 'against the block at its drawn size');
      if (D === 'right') assert.equal(s1.C1.x, s1.t1.x + 360 + Math.max(0, box.w - 280));
      if (D === 'left') assert.equal(s1.C1.x, reference(h).C1.x, 'the column Auto layout uses');
    }
    assert.equal(h.view.history.past.length, past + 1);
    await h.view.addNode(h.owner(), 'C2', true, false, 'topic', false, {}, 't1');
    await done(h);
    const s2 = snap(h);
    if (!WHOLE.includes(D)) for (const k of Object.keys(s1)) assert.deepEqual(s2[k], s1[k], `${k} stays when the second topic is added`);
    assertNoOverlap(h, `${D} second`);
    assertSaved(h.raw(), D);
  });

// Fix 2: in a left map a block narrower than a card keeps its right edge, so its left edge is not where the column starts.
// Every follower of one block shares the column Auto layout uses, after each +, and widening the block does not move them.
for (const width of [61, 120, 280, 400])
  test(`placement: left: a block ${width} wide: followers added with + share the Auto layout column, and widening keeps them there`, async () => {
    const h = await begin('left', { followers: ['C1'], width });
    const column = snap(h).C1.x;
    await h.view.addNode(h.owner(), 'C2', true, false, 'topic', false, {}, 't1');
    await done(h);
    assert.equal(snap(h).C2.x, column, 'C2 stands in the column of C1');
    assert.equal(snap(h).C1.x, column, 'C1 did not move');
    const ref = reference(h);
    assert.equal(snap(h).C2.x, ref.C2.x, 'the column Auto layout gives');
    await h.view.resizeText('t1', width + 20, width);
    await done(h);
    const kids = ['C1', 'C2'].map(k => snap(h)[k].x);
    assert.equal(kids[0], kids[1], 'still one column after widening');
    if (width + 20 <= 280) assert.equal(kids[0], column, 'widening a narrow block does not move its followers');
  });

// In a balanced map a narrow block on the left half stands within the root's deadband by its offset alone. Its side comes from its box,
// so a follower added with + stays on the block's side and in the column of the others, and widening does not move it across the root.
for (const text of ['hi', 'hello~~'])
  test(`placement: balanced: left half, block "${text}": followers added with + share the column, and widening keeps them there`, async () => {
    const h = await begin('right', { text, followers: ['C1'] });
    await h.view.mapChange(m => { m.layout = { direction: 'balanced' }; h.view.arrangeAll(m, { reset: true }); }, false);
    await done(h);
    const start = snap(h), w = boxOf(h).w;
    assert.ok(start.C1.x < start.Root.x, 'the deal puts this block and its follower on the left half');
    await h.view.addNode(h.owner(), 'C2', true, false, 'topic', false, {}, 't1');
    await done(h);
    assert.equal(snap(h).C2.x, start.C1.x, 'C2 stands in the column of C1');
    assert.equal(snap(h).C1.x, start.C1.x, 'C1 did not move');
    await h.view.resizeText('t1', 120, w);
    await done(h);
    assert.equal(snap(h).C1.x, start.C1.x, 'widening does not move C1');
    assert.equal(snap(h).C2.x, start.C1.x, 'widening does not move C2');
  });

// A block with no followers yet keeps its facing edge when its text grows, as when it is widened, so it stays on its side of the root
// and the first topic added after it goes there too.
for (const text of ['hi', 'hello~~'])
  test(`placement: balanced: left half, block "${text}" with no followers: longer text keeps its right edge, and + stays on the left`, async () => {
    const h = await begin('right', { text, followers: [] });
    await h.view.mapChange(m => { m.layout = { direction: 'balanced' }; h.view.arrangeAll(m, { reset: true }); }, false);
    await done(h);
    const box = boxOf(h), start = snap(h);
    assert.ok(start.t1.x + box.w <= start.Root.x, 'the deal puts this block on the left half');
    await h.view.saveTextItem('t1', 'a much longer line of text here');
    await done(h);
    assert.equal(snap(h).t1.x + boxOf(h).w, start.t1.x + box.w, 'the right edge stays');
    await h.view.addNode(h.owner(), 'C1', true, false, 'topic', false, {}, 't1');
    await done(h);
    assert.ok(snap(h).C1.x < start.Root.x, 'C1 goes on the left half');
  });
test('placement: left: a block with no followers keeps its right edge when its text grows; right keeps x', async () => {
  for (const [D, edge] of [['left', (x, w) => x + w], ['right', x => x]]) {
    const h = await begin(D, { followers: [] });
    const want = edge(snap(h).t1.x, boxOf(h).w);
    await h.view.saveTextItem('t1', 'a much longer line of text here');
    await done(h);
    assert.equal(edge(snap(h).t1.x, boxOf(h).w), want, D);
  }
});

// Row "add C" beside a wide text block (under the same topic, or under the neighbouring topic): the obstacle is as wide as it is drawn.
for (const D of DIRS) for (const under of ['root', 'child'])
  test(`placement: ${D}: topics added after a block keep clear of a wide text block under the ${under === 'root' ? 'same topic' : 'neighbouring topic'}`, async () => {
    const h = await begin(D, { followers: [], wide: under });
    for (const title of ['C1', 'C2', 'C3', 'C4']) { await h.view.addNode(h.owner(), title, true, false, 'topic', false, {}, 't1'); await done(h); }
    assert.deepEqual(overlaps(h, (a, b) => isFollower(a) || isFollower(b)), [], JSON.stringify(boxesOf(h)));
  });

// A wide text block lying in the row the new topics go to (down / up): they slide past it as wide as it is drawn, not as a card.
for (const D of ['down', 'up'])
  test(`placement: ${D}: a topic added after a block slides past a wide text block lying in its row`, async () => {
    const h = await begin(D, { followers: [], wide: 'root' });
    const t = snap(h).t1, y = D === 'down' ? t.y + boxOf(h).h + 60 + 20 : t.y - 60 - 180 + 20;
    h.view.map.canvasItems = h.view.map.canvasItems.map(i => (i.id === 't2' ? { ...i, x: t.x - 200, y } : i));
    await h.repo.saveMap(h.view.path, h.view.map);
    h.view.render();
    await h.view.addNode(h.owner(), 'C1', true, false, 'topic', false, {}, 't1');
    await done(h);
    assert.deepEqual(overlaps(h, (a, b) => isFollower(a) || isFollower(b)), [], JSON.stringify(boxesOf(h)));
  });

// Rows "move under a parent" and "move to the top level": the branch with its block and followers lands as Auto layout would place it.
async function branchCase(D, target) {
  const h = await begin(D, { on: 'child', other: true, followers: ['C1', 'C2'] });
  const before = snap(h), past = h.view.history.past.length;
  const child = h.view.map.nodes.find(n => n.id === h.child.id), dest = target ? h.view.map.nodes.find(n => keyOf(h, n) === 'Other') : null;
  await h.view.moveBranches([child], dest);
  await done(h);
  const after = snap(h);
  if (!target || !WHOLE.includes(D)) for (const k of ['Root', 'Other']) assert.deepEqual(after[k], before[k], `${k} stays`);
  else assert.deepEqual(after.Root, before.Root);
  // Under a parent the radial, timeline and fishbone layouts lay the whole map out again, so Auto layout of the whole map is the reference there.
  const ref = target && WHOLE.includes(D) ? reference(h) : reference(h, target ? ['Other', 'Child', 'C1', 'C2', 't1'] : ['Child', 'C1', 'C2', 't1']);
  near(rel(after, 't1', 'Child'), rel(ref, 't1', 'Child'), `${D}: block against its topic`);
  for (const k of ['C1', 'C2']) near(rel(after, k, 't1'), rel(ref, k, 't1'), `${D}: ${k} against the block`);
  if (target) near(rel(after, 'Child', 'Other'), rel(ref, 'Child', 'Other'), `${D}: branch against the new parent`);
  assertNoOverlap(h, D);
  assertSaved(h.raw(), D);
  await oneUndo(h, before, past, D);
}
for (const D of DIRS) {
  test(`placement: ${D}: move a branch with a block to the top level: only the branch moves, as Auto layout lays it`, () => branchCase(D, false));
  test(`placement: ${D}: move a branch with a block under another topic: the branch, block and followers sit against it`, () => branchCase(D, true));
}

// Row "fold / unfold, Auto layout": the block may not be drawn while it is laid out; its measured size is used.
for (const D of DIRS) {
  test(`placement: ${D}: fold and unfold lay the block (not drawn meanwhile) out as Auto layout does`, async () => {
    const h = await begin(D, { text: LONG, followers: ['C1'] });
    const before = snap(h);
    h.view.toggleCollapsed(h.view.map.nodes[0]);
    await done(h);
    assert.equal(h.view.textEls.has('t1'), false, 'the block is not drawn while folded');
    const folded = snap(h);
    for (const k of ['t1', 'C1', 'Child']) assert.deepEqual(folded[k], before[k], `${k} (hidden) keeps its place`);
    h.view.toggleCollapsed(h.view.map.nodes[0]);
    await done(h);
    const after = snap(h);
    for (const k of Object.keys(before)) near([after[k].x, after[k].y], [before[k].x, before[k].y], `${D}: ${k} back where Auto layout put it`);
    assertNoOverlap(h, D);
  });
  test(`placement: ${D}: Auto layout after a long edit equals the reference layout`, async () => {
    const h = await begin(D, { followers: ['C1'] });
    await h.view.saveTextItem('t1', LONG);
    await done(h);
    await auto(h);
    const s = snap(h), ref = reference(h);
    for (const k of Object.keys(ref)) near([s[k].x, s[k].y], [ref[k].x, ref[k].y], `${D}: ${k}`);
    assertNoOverlap(h, D);
  });
}

// Rows "delete T" and "turn into a topic card": the followers and their subtrees move, nothing else.
for (const D of DIRS) {
  test(`placement: ${D}: delete the block: only the followers move, no overlap, one undo`, async () => {
    const h = await begin(D, { text: LONG, followers: ['C1', 'C2'] });
    const before = snap(h), past = h.view.history.past.length;
    await h.view.removeTextItem('t1');
    await done(h);
    const s = snap(h);
    if (WHOLE.includes(D)) assert.deepEqual(s.Root, before.Root);
    else for (const k of ['Root', 'Child']) assert.deepEqual(s[k], before[k], `${k} stays`);
    assert.deepEqual(overlaps(h), [], D);
    await oneUndo(h, before, past, D);
  });
  test(`placement: ${D}: turn the block into a card: only the followers move, no overlap, one undo`, async () => {
    const h = await begin(D, { text: LONG, followers: ['C1', 'C2'] });
    const before = snap(h), past = h.view.history.past.length;
    await h.view.promoteTextNode('t1');
    await done(h);
    const s = snap(h);
    if (WHOLE.includes(D)) assert.deepEqual(s.Root, before.Root);
    else for (const k of ['Root', 'Child']) assert.deepEqual(s[k], before[k], `${k} stays`);
    assert.deepEqual(overlaps(h, (a, b) => a !== 't1' && b !== 't1').filter(p => !/Child/.test(p)), [], D);
    assert.equal(h.view.history.past.length, past + 1);
  });
}

// A block without followers keeps main's behaviour: only its own x follows textAnchoredX, nothing else is laid out.
for (const D of ['right', 'left', 'down', 'up', 'balanced'])
  test(`placement: ${D}: a block without followers changes only its own x (textAnchoredX), nothing else`, async () => {
    const h = await begin(D, { followers: [] });
    const before = snap(h), from = boxOf(h).w;
    const x = h.view.textAnchoredX('t1', from, 560);
    await h.view.resizeText('t1', 560, from);
    await done(h);
    const s = snap(h);
    for (const k of Object.keys(before)) assert.deepEqual(s[k], k === 't1' ? { x, y: before.t1.y } : before[k], k);
    await h.view.saveTextItem('t1', LONG);
    await done(h);
    assert.deepEqual(snap(h), s, 'editing the text moves nothing');
  });

// Fix 1: an auto-width block's rounded offsetWidth is narrower than its text, so a probe at that width wraps. The facing edge must
// not drift: up keeps the bottom edge exactly, on the first widen and on every reset-then-widen cycle.
for (const how of ['keyboard', 'drag'])
  test(`placement: up: from automatic width, widening by ${how} keeps the bottom edge exactly, also over reset-and-widen cycles`, async () => {
    const h = await begin('up', { text: 'hello~~', followers: ['C1', 'C2'] });
    const auto0 = textBox('hello~~');
    assert.equal(textBox('hello~~', auto0.w).h, auto0.h + 20, 'the double: a probe at the rounded width wraps');
    const t0 = snap(h).t1, bottom = t0.y + auto0.h;
    const bottomNow = () => { const t = h.view.map.canvasItems.find(i => i.id === 't1'); return t.y + textBox(t.text, t.width).h; };
    for (let cycle = 0; cycle < 3; cycle++) {
      const from = h.view.textBoxOf('t1').width;
      assert.equal(from, auto0.w, `cycle ${cycle}: starts from automatic`);
      if (how === 'drag') { const el = h.view.textEls.get('t1'); el.style.width = '120px'; el.addClass('has-width'); }
      await h.view.resizeText('t1', 120, from);
      await done(h);
      assert.equal(bottomNow(), bottom, `cycle ${cycle}: bottom edge after widening`);
      assertNoOverlap(h, `cycle ${cycle} widened`);
      await h.view.resizeText('t1', undefined, 120);
      await done(h);
      assert.equal(bottomNow(), bottom, `cycle ${cycle}: bottom edge after reset`);
      assertNoOverlap(h, `cycle ${cycle} reset`);
    }
    for (const k of ['C1', 'C2']) assert.equal(snap(h)[k].y + 180, snap(h).t1.y - 60, `${k} stays one row above`);
  });

// The one measurer: from the DOM when drawn, from a hidden block (built and removed in one go) for `as` or an undrawn block.
test('measure: textBoxOf reads the drawn block, a hypothetical text or width, and a block that is not drawn, and leaves nothing behind', async () => {
  const h = await begin('right', { text: 'hello', followers: [] });
  const layer = find(h.view.stageEl, i => dom.hasCls(i, 'vam-text-nodes'));
  const count = layer.children.length;
  assert.deepEqual(plain(h.view.textBoxOf('t1')), { width: 49, height: 27 }, 'drawn');
  assert.deepEqual(plain(h.view.textBoxOf('t1', { text: LONG })), { width: 300, height: textBox(LONG).h }, 'as: new text');
  assert.deepEqual(plain(h.view.textBoxOf('t1', { width: 80 })), { width: 80, height: textBox('hello', 80).h }, 'as: new width');
  assert.deepEqual(plain(h.view.textBoxOf('t1', { text: LONG, width: 80 })), { width: 80, height: textBox(LONG, 80).h }, 'as: both');
  h.view.textEls.get('t1').style.width = '300px'; // a drag in progress: as.width still wins, and so does as: width null (automatic)
  assert.equal(h.view.textBoxOf('t1', { width: 80 }).width, 80);
  assert.equal(h.view.textBoxOf('t1', { width: null }).width, 49, 'as: automatic');
  h.view.textEls.delete('t1');
  assert.deepEqual(plain(h.view.textBoxOf('t1')), { width: 49, height: 27 }, 'not drawn: measured hidden');
  assert.equal(h.view.cardHeightOf('t1'), 27);
  assert.equal(h.view.textWidthOf('t1'), 49);
  assert.equal(layer.children.length, count, 'no measuring block is left in the layer');
});

// Maps without text blocks lay out exactly as before this feature (hashes of the engine's output on the parent commit).
test('card-only maps: arrangeMap, arrangeNewBranch and arrangeNewTree give the same positions as before in all 8 layouts', () => {
  const n = (id, parentId, extra = {}) => ({ id, path: `${id}.md`, parentId, x: 0, y: 0, collapsed: false, ...extra });
  const base = () => [n('r', null), n('a', 'r'), n('b', 'r', { width: 420 }), n('c', 'r'), n('a1', 'a'), n('a2', 'a'), n('b1', 'b'), n('n', 'b', { x: 5, y: 5 }), n('n1', 'n'), n('z', null), n('z1', 'z')];
  const heights = { a: 260, b1: 300, n: 240, z1: 200 };
  const heightOf = id => heights[id] ?? 180;
  const pinned = { right: '05641e0d08cf', left: 'cacba427a829', balanced: '9571ccd07082', down: 'cd990e33db6f', up: '4ce910c49c0f', radial: '3d187e581d8e', timeline: '4439ca151d87', fishbone: '6bd43e5a0a98' };
  for (const d of DIRS) {
    const spec = { direction: d };
    const all = layoutLib.arrangeMap(base(), undefined, heightOf, spec);
    const branch = layoutLib.arrangeNewBranch(all, 'b', new Set(['n', 'n1']), heightOf, undefined, spec);
    const tree = layoutLib.arrangeNewTree(all, 'z', new Set(['z', 'z1']), heightOf, spec);
    const view = list => list.map(x => [x.id, x.x, x.y]);
    assert.equal(crypto.createHash('sha1').update(JSON.stringify([view(all), view(branch), view(tree)])).digest('hex').slice(0, 12), pinned[d], d);
    // The text-aware entry points are the same function when no text block is involved.
    assert.deepEqual(plain(layoutText.arrangeMapWithText(base(), [], undefined, heightOf, spec).nodes), plain(all), `${d} arrangeMapWithText`);
    assert.deepEqual(plain(layoutText.arrangeNewTreeWithText(all, [], 'z', new Set(['z', 'z1']), heightOf, spec).nodes), plain(tree), `${d} arrangeNewTreeWithText`);
  }
});

// The pin above always has neighbours in the new branch's row, which hide a change of where a lone new branch is centred or started.
// Here the new cards have the row to themselves, under cards of three widths (hashes of the engine's output on the parent commit).
test('card-only maps: a new branch with no other card in its row lands exactly as before in all 8 layouts, under cards 280, 100 and 420 wide', () => {
  const n = (id, parentId, extra = {}) => ({ id, path: `${id}.md`, parentId, x: 0, y: 0, collapsed: false, ...extra });
  const pinned = { right: '0377d3604a68', left: 'f5df296bcc94', balanced: '0377d3604a68', down: '9d50970b24eb', up: '6025deb1f08b', radial: '7bd364a7b214', timeline: 'ab2f5092a145', fishbone: 'a9483cd53f9a' };
  for (const d of DIRS) {
    const spec = { direction: d }, res = [];
    for (const width of [undefined, 100, 420]) {
      const all = layoutLib.arrangeMap([n('r', null), n('e', 'r', { width })], undefined, undefined, spec);
      const branch = layoutLib.arrangeNewBranch([...all, n('f', 'e'), n('g', 'e')], 'e', new Set(['f', 'g']), undefined, undefined, spec);
      res.push(branch.map(x => [x.id, x.x, x.y]));
    }
    assert.equal(crypto.createHash('sha1').update(JSON.stringify(res)).digest('hex').slice(0, 12), pinned[d], d);
  }
});
