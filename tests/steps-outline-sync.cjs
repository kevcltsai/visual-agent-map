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
  view.map = doc; view.viewportEl = { clientWidth: 800, clientHeight: 600 };
  view.render = () => {}; view.transform = () => {}; view.saveViewport = () => { calls.saved++; };
  view.mapChange = async () => { calls.mapChange++; };
  return { view, app, calls, text, ids: { root: root.id, child: child.id, leaf: leaf.id } };
}
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

test('B15: an outline click on a card inside a collapsed branch selects it and centers on its nearest visible ancestor', async () => {
  const { view, ids } = await viewWithMap();
  const [root, , leaf] = view.map.nodes; leaf.x = 1000; leaf.y = 400; root.x = 200; root.y = 100;
  await view.revealPath('leaf.md');
  assert.equal(view.selection.state.selected, ids.leaf);
  assert.deepEqual({ ...view.map.viewport }, { x: 400 - (200 + 140), y: 300 - 180, zoom: 1 }, 'camera is on the collapsed root, the topmost visible ancestor');
});
