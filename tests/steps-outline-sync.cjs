// B15 (P1.6c): canvas selection and the outline follow each other without writing the map or rebuilding the outline.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { load, obsidian, fixture, node, map } = require('./support.cjs');
const dom = require('./support-dom.cjs');

const loadOutline = () => load('ui/outline-view.ts', { obsidian: { ...obsidian, ItemView: class { constructor() { this.contentEl = dom.element('div'); } }, Notice: class {} } }, { document: { activeElement: null } }).OutlineView;
// root > child > leaf, plus an unrelated sibling of root; root and child are collapsed.
function outline() {
  const OutlineView = loadOutline();
  const view = new OutlineView({ app: {} }, async () => {});
  // As in a real document: an element taken out of the tree no longer has the focus (activeElement falls back to null/body).
  let focused = null;
  const attached = el => { if (!el.parent) return true; for (let at = el; at; at = at.parent) { if (at === view.contentEl) return true; if (!at.parent?.children.includes(at)) return false; } return false; };
  const doc = { get activeElement() { return focused && attached(focused) ? focused : null; }, set activeElement(el) { focused = el; } };
  view.contentEl.root = doc; view.contentEl.ownerDocument = doc;
  view.collapsed = new Set(['root', 'child']);
  view.setMap({ title: 'M', nodes: [
    { id: 'root', parentId: null, path: 'root.md' }, { id: 'child', parentId: 'root', path: 'child.md' },
    { id: 'leaf', parentId: 'child', path: 'leaf.md' }, { id: 'other', parentId: null, path: 'other.md' }
  ] }, new Map([['root', 'Root'], ['child', 'Child'], ['leaf', 'Leaf'], ['other', 'Other']]));
  const rows = () => dom.findAll(view.contentEl, i => dom.hasCls(i, 'vam-outline-row'));
  // The paths of the rows a reader can see: rows inside a folded container do not count.
  const visible = () => {
    const out = [];
    const walk = el => { if (dom.hasCls(el, 'is-folded')) return; if (dom.hasCls(el, 'vam-outline-note')) out.push(el.attrs['data-path']); el.children.forEach(walk); };
    walk(dom.findAll(view.contentEl, i => dom.hasCls(i, 'vam-outline-tree'))[0]);
    return out;
  };
  return { view, doc, rows, visible };
}

test('B15: canvas selection opens the collapsed ancestor rows in the outline DOM only, and the next selection folds them back', () => {
  const { view, rows, visible } = outline();
  assert.deepEqual(visible(), ['root.md', 'other.md'], 'collapsed branches start folded');
  assert.equal(rows().length, 2, 'rows of a collapsed branch are not created until it opens');
  view.setActive('leaf.md');
  assert.deepEqual(visible(), ['root.md', 'child.md', 'leaf.md', 'other.md'], 'ancestors of the active row are open');
  assert.deepEqual([...view.collapsed].sort(), ['child', 'root'], 'the collapse state itself is untouched');
  const active = dom.findAll(view.contentEl, i => dom.hasCls(i, 'is-active'));
  assert.equal(active.length, 1); assert.equal(active[0].attrs['data-path'], 'leaf.md');
  view.setActive('other.md');
  assert.deepEqual(visible(), ['root.md', 'other.md'], 'the temporary opening ends with the selection');
  assert.equal(rows().length, 4, 'the opened branch is hidden, its rows kept for reuse');
});

test('B15 batch UI: selecting a card inside a not-yet-opened branch clears the previous active row (one active row)', () => {
  const { view } = outline();
  view.setActive('other.md');
  view.setActive('leaf.md');
  const active = dom.findAll(view.contentEl, i => dom.hasCls(i, 'is-active')).map(i => i.attrs['data-path']);
  const current = dom.findAll(view.contentEl, i => i.attrs?.['aria-current'] === 'true').map(i => i.attrs['data-path']);
  assert.deepEqual(active, ['leaf.md']);
  assert.deepEqual(current, ['leaf.md']);
});
test('B15 batch UI: a map repaint that hands the outline the same content keeps every row; a changed title still redraws', () => {
  const { view, rows } = outline();
  const content = () => [{ title: 'M', nodes: [
    { id: 'root', parentId: null, path: 'root.md' }, { id: 'child', parentId: 'root', path: 'child.md' },
    { id: 'leaf', parentId: 'child', path: 'leaf.md' }, { id: 'other', parentId: null, path: 'other.md' }
  ] }, new Map([['root', 'Root'], ['child', 'Child'], ['leaf', 'Leaf'], ['other', 'Other']])];
  const before = rows();
  view.setMap(...content());
  assert.ok(rows().every((row, i) => row === before[i]) && rows().length === before.length, 'same content: no rebuild');
  const [map, titles] = content(); titles.set('other', 'Renamed');
  view.setMap(map, titles);
  assert.notEqual(rows()[rows().length - 1], before[before.length - 1], 'changed title: redrawn');
});
test('B18 batch UI: a row that has the keyboard focus keeps it through two outline rebuilds in a row', () => {
  const { view, doc } = outline();
  const note = path => dom.findAll(view.contentEl, i => dom.hasCls(i, 'vam-outline-note') && i.attrs['data-path'] === path)[0];
  note('other.md').focus();
  assert.equal(doc.activeElement, note('other.md'));
  const nodes = () => [
    { id: 'root', parentId: null, path: 'root.md' }, { id: 'child', parentId: 'root', path: 'child.md' },
    { id: 'leaf', parentId: 'child', path: 'leaf.md' }, { id: 'other', parentId: null, path: 'other.md' }
  ];
  view.setMap({ title: 'M', nodes: nodes() }, new Map([['root', 'Root 2'], ['child', 'Child'], ['leaf', 'Leaf'], ['other', 'Other']]));
  view.setMap({ title: 'M', nodes: nodes() }, new Map([['root', 'Root 3'], ['child', 'Child'], ['leaf', 'Leaf'], ['other', 'Other']]));
  assert.equal(doc.activeElement?.attrs?.['data-path'], 'other.md', 'focus is on the same row after both rebuilds');
  assert.equal(doc.activeElement, note('other.md'), 'and it is the row now in the tree');
});
test('B15: syncing the active row keeps the outline rows and the search box as the same objects', () => {
  const { view, rows } = outline();
  const before = rows(), tree = dom.findAll(view.contentEl, i => dom.hasCls(i, 'vam-outline-tree'))[0];
  const search = dom.findAll(view.contentEl, i => dom.hasCls(i, 'vam-outline-search'))[0];
  for (const path of ['leaf.md', 'other.md', 'child.md', 'root.md', 'leaf.md']) view.setActive(path);
  const opened = rows();
  before.forEach(row => assert.ok(opened.includes(row), 'a row that was drawn is still the same object'));
  view.setActive('other.md'); view.setActive('leaf.md');
  assert.deepEqual(rows(), opened, 'closing and reopening a branch reuses its rows');
  assert.equal(dom.findAll(view.contentEl, i => dom.hasCls(i, 'vam-outline-search'))[0], search);
  assert.equal(dom.findAll(view.contentEl, i => dom.hasCls(i, 'vam-outline-tree'))[0], tree);
});

test('B15: a canvas selection while focus is in a reader editor leaves document.activeElement unchanged', () => {
  const { view, doc } = outline();
  const editor = dom.element('div'); editor.root = doc; editor.focus();
  assert.equal(doc.activeElement, editor);
  let scrolled = 0;
  for (const row of dom.findAll(view.contentEl, i => dom.hasCls(i, 'vam-outline-note'))) row.scrollIntoView = () => { scrolled++; };
  view.setActive('leaf.md'); view.setActive('other.md');
  assert.equal(doc.activeElement, editor, 'focus stayed where it was');
  assert.ok(scrolled > 0, 'the active row is scrolled into view');
});

test('B15: toggling a temporarily opened row folds it, and a fold click on a real collapse still expands for good', () => {
  const { view, visible } = outline();
  view.setActive('leaf.md');
  const toggles = () => dom.findAll(view.contentEl, i => dom.hasCls(i, 'vam-outline-toggle'));
  toggles()[0].click(); // root is open only temporarily: the click closes it
  assert.deepEqual(visible(), ['root.md', 'other.md']);
  toggles()[0].click(); // now an ordinary expand
  assert.ok(!view.collapsed.has('root'));
});

// ---- the map view side: neither direction writes Map.md ----
const MAP = 'Agent Workspace/Topics/map-b15/Map.md';
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
async function viewWithMap() {
  const { VisualAgentMapView } = load('experiences/visual-map/view.ts', { obsidian });
  const root = node('root'), child = node('child'), leaf = node('leaf');
  child.parentId = root.id; leaf.parentId = child.id; root.collapsed = true; child.collapsed = true;
  const doc = map([root, child, leaf]); doc.viewport = { x: 0, y: 0, zoom: 1 };
  const { app } = fixture('en');
  const text = JSON.stringify(doc);
  await app.vault.create(MAP, text);
  const calls = { mutate: 0, mapChange: 0, saved: 0, active: [] };
  const plugin = { mutate: () => { calls.mutate++; return Promise.resolve(); }, expansionBatches: new Map(), setOutlineActive: path => calls.active.push(path) };
  const view = new VisualAgentMapView({ app: {} }, plugin);
  view.map = doc; view.viewportEl = { clientWidth: 800, clientHeight: 600, toggleClass() {} };
  view.contentEl = { focus() {} };
  view.render = () => {}; view.transform = () => {}; view.saveViewport = () => { calls.saved++; };
  view.mapChange = async () => { calls.mapChange++; };
  return { view, app, calls, text, ids: { root: root.id, child: child.id, leaf: leaf.id } };
}
const fakeCard = (offsetWidth, offsetHeight) => ({ offsetWidth, offsetHeight, toggleClass() {}, addClass() {}, removeClass() {}, setAttr() {}, setAttribute() {}, querySelector: () => null, querySelectorAll: () => [], getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }), style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false } });
const read = async app => app.vault.adapter ? app.vault.adapter.read(MAP) : app.vault.read(app.vault.getAbstractFileByPath(MAP));

test('B15: outline click and canvas selection, five times each, leave Map.md unchanged and write nothing', async () => {
  const { view, app, calls, text, ids } = await viewWithMap();
  const before = sha(text);
  for (let i = 0; i < 5; i++) {
    assert.equal(await view.revealPath('leaf.md'), true); // outline -> canvas, leaf sits in a collapsed branch
    view.applySelectionChange(view.selection.click(ids.root)); // canvas -> outline
    view.applySelectionChange(view.selection.click(ids.leaf));
  }
  assert.equal(view.selection.state.selected, ids.leaf);
  assert.equal(sha(await read(app)), before, 'Map.md hash unchanged');
  assert.deepEqual([calls.mutate, calls.mapChange, calls.saved], [0, 0, 0], 'no map write, no collapse write, no viewport save');
  assert.deepEqual(view.map.nodes.map(n => !!n.collapsed), [true, true, false], 'collapse flags untouched');
  assert.ok(calls.active.includes('leaf.md') && calls.active.includes('root.md'), 'the outline is told which topic is active');
});

test('B15: an outline click on a card inside a collapsed branch selects it and centers on the topic, opened for the view only', async () => {
  const { view, ids } = await viewWithMap();
  const [root, , leaf] = view.map.nodes; leaf.x = 1000; leaf.y = 400; root.x = 200; root.y = 100;
  view.cardEls = new Map([[leaf.id, fakeCard(280, 79)]]);
  await view.revealPath('leaf.md');
  assert.equal(view.selection.state.selected, ids.leaf);
  // B15-x: the centre is the card's measured box (280 x 79), not a fixed +80 down from its top.
  assert.deepEqual({ ...view.map.viewport }, { x: 400 - (1000 + 140), y: 300 - (400 + 39.5), zoom: 1 }, 'camera is on the topic itself'); // B14: P1.6 reveal only temporarily opens the branch for the view
});

// B15-x: after an outline reveal the card's DOM centre sits at the centre of the canvas minus its insets, at any zoom.
for (const zoom of [1, 0.25]) for (const [w, h] of [[280, 79], [280, 99], [360, 180]]) {
  test(`B15-x: outline reveal centres the card's DOM box within 4px of the inset-free canvas centre (zoom ${zoom}, card ${w}x${h})`, async () => {
    const { view } = await viewWithMap();
    const [, , leaf] = view.map.nodes; leaf.x = 1000; leaf.y = 400; leaf.width = w;
    const canvas = { left: 10, top: 20, right: 810, bottom: 620, width: 800, height: 600 };
    view.viewportEl = { clientWidth: 800, clientHeight: 600, toggleClass() {}, getBoundingClientRect: () => canvas };
    const rects = { '.vam-map-tools': { left: 100, right: 700, top: 20, bottom: 64 }, '.vam-zoom-controls': { left: 300, right: 500, top: 560, bottom: 610 }, '.vam-map-chat.is-overlay': { left: 10, right: 130, top: 20, bottom: 620 } };
    view.contentEl = { focus() {}, querySelector: selector => rects[selector] && { getBoundingClientRect: () => rects[selector] } };
    view.cardEls = new Map([[leaf.id, fakeCard(w, h)]]);
    view.map.viewport = { x: 0, y: 0, zoom };
    await view.revealPath('leaf.md');
    const vp = view.map.viewport, ins = view.canvasInsets();
    const cx = canvas.left + vp.x + (leaf.x + w / 2) * zoom, cy = canvas.top + vp.y + (leaf.y + h / 2) * zoom;
    const tx = canvas.left + ins.left + (canvas.width - ins.left - ins.right) / 2, ty = canvas.top + ins.top + (canvas.height - ins.top - ins.bottom) / 2;
    assert.ok(Math.abs(cx - tx) <= 4, `dx ${cx - tx}`);
    assert.ok(Math.abs(cy - ty) <= 4, `dy ${cy - ty}`);
  });
}

test('C08: outline search also reads summaries and Details; a row matched only by its body says so, a title match does not', () => {
  const OutlineView = loadOutline();
  const view = new OutlineView({ app: {} }, async () => {});
  view.contentEl.root = { activeElement: null }; view.contentEl.ownerDocument = view.contentEl.root;
  const nodes = [{ id: 'a', parentId: null, path: 'a.md' }, { id: 'b', parentId: 'a', path: 'b.md' }, { id: 'c', parentId: 'a', path: 'c.md' }];
  const titles = new Map([['a', 'Alpha'], ['b', 'Beta'], ['c', 'Gamma']]);
  const bodies = new Map([['b', 'Summary line\nA 價格 table'], ['c', 'beta again']]);
  view.setMap({ title: 'M', nodes }, titles, new Map(), new Map(), bodies);
  const input = dom.findAll(view.contentEl, i => dom.hasCls(i, 'vam-outline-search'))[0];
  const rows = () => dom.findAll(view.contentEl, i => dom.hasCls(i, 'vam-outline-note')).map(n => [n.attrs['data-path'], dom.findAll(n, i => dom.hasCls(i, 'vam-outline-body-hit')).length]);
  input.value = '价格'; input.fire('input', {}); // Simplified query, Traditional Detail
  assert.deepEqual(rows(), [['a.md', 0], ['b.md', 1]], 'parent shown as a path to the hit; only the body-only row is labelled');
  input.value = 'beta'; input.fire('input', {});
  assert.deepEqual(rows(), [['a.md', 0], ['b.md', 0], ['c.md', 1]], 'a title match is not labelled, a body-only one is');
  const hit = dom.findAll(view.contentEl, i => dom.hasCls(i, 'vam-outline-body-hit'))[0];
  assert.equal(hit.text, 'In text');
});

// B15-y: the reader opened by an outline click takes width from the map; the card is centred on the width left after it opens.
async function outlineClick(readerOpen) {
  const { default: Plugin } = load('main.ts', { obsidian });
  let width = readerOpen ? 500 : 800; // the canvas: 800px, 500px once the 300px reader is beside it
  const centred = [];
  const view = { leaf: {}, hasPath: () => true, revealPath: async () => { centred.push(width / 2); return true; } };
  const host = {
    views: () => [view], app: { workspace: { revealLeaf: async () => {} } }, repo: { file: path => ({ path }) },
    openDetails: async () => { width = 500; }
  };
  await Plugin.prototype.revealFromOutline.call(host, 'leaf.md');
  return { centred, visibleCentre: width / 2 };
}

test('B15-y: the first outline click with the reader closed centres the card on the canvas left after the reader opens (≤1px)', async () => {
  const { centred, visibleCentre } = await outlineClick(false);
  assert.ok(centred.length >= 1);
  assert.ok(Math.abs(centred.at(-1) - visibleCentre) <= 1, `centred at ${centred.at(-1)}, visible centre ${visibleCentre}`);
});

test('B15-y: with the reader already open an outline click centres once, as before', async () => {
  const { centred, visibleCentre } = await outlineClick(true);
  assert.deepEqual(centred, [visibleCentre]);
});

test('B15-y: while the reader slides in after an outline reveal, each canvas resize re-centres the card; later resizes leave the camera', async () => {
  const { view } = await viewWithMap();
  const leaf = view.map.nodes[2]; leaf.x = 1000; leaf.y = 400;
  for (const name of ['drawWhenShown', 'syncHeaderNarrow', 'syncReaderToggle', 'syncChatNarrow', 'fitKindShapes']) view[name] = () => {};
  view.contentEl = { ownerDocument: null, querySelector: () => null }; view.placeMapTools = () => {};
  await view.revealPath('leaf.md');
  view.viewportEl.clientWidth = 500; // the reader took 300px
  view.onResize();
  const after = { ...view.map.viewport };
  view.viewportEl.clientWidth = 800;
  view.map.viewport = { x: 0, y: 0, zoom: 1 };
  await view.revealPath('leaf.md');
  view.viewportEl.clientWidth = 500;
  const expected = { ...view.map.viewport, x: view.map.viewport.x - 150 };
  assert.ok(Math.abs(after.x - expected.x) <= 1 && Math.abs(after.y - expected.y) <= 1, `after resize ${JSON.stringify(after)} vs ${JSON.stringify(expected)}`);
  view.revealResize.until = Date.now() - 1; // the reveal is over
  view.map.viewport = { x: 7, y: 9, zoom: 1 };
  view.onResize();
  assert.deepEqual({ ...view.map.viewport }, { x: 7, y: 9, zoom: 1 }, 'a resize after the reveal does not move the camera');
});

test('B15-y: the status bar growing during an outline reveal (the reader made a note active) re-centres the card on the new bottom inset', async () => {
  const { view } = await viewWithMap();
  const leaf = view.map.nodes[2]; leaf.x = 1000; leaf.y = 400;
  let bottomInset = 0;
  view.canvasInsets = () => ({ top: 0, right: 0, bottom: bottomInset, left: 0 });
  view.contentEl = { ownerDocument: null, querySelector: () => null }; view.placeMapTools = () => {};
  await view.revealPath('leaf.md');
  const before = view.map.viewport.y;
  bottomInset = 26; // the zoom bar rose above the taller status bar
  view.syncStatusBarClearance();
  assert.ok(Math.abs(view.map.viewport.y - (before - 13)) <= 1, `y ${view.map.viewport.y}, expected ${before - 13}`);
});
