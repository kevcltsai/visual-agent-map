// B18 (P1.7c): outline drag and Alt+Arrow ask the map view to move a topic; the view validates and reuses moveBranches / the canvas sibling shift.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, obsidian, node, map, DEFAULT_SETTINGS } = require('./support.cjs');
const dom = require('./support-dom.cjs');
const { t } = load('i18n.ts', { obsidian });

const notices = [];
class Notice { constructor(message) { notices.push(String(message)); } }
// root > a > c, root > b; positions only matter for the layout calls, which are stubbed.
function mapView() {
  const { VisualAgentMapView } = load('experiences/visual-map/view.ts', { obsidian: { ...obsidian, Notice } });
  const root = node('root'), a = node('a', 'root'), b = node('b', 'root'), c = node('c', 'a'), d = node('d', 'root');
  const doc = map([root, a, b, c, d]);
  const plugin = { settings: { ...DEFAULT_SETTINGS }, pendingSuggestions: new Map(), expansionBatches: new Map(), detailsShown: () => false, setOutlineActive() {}, mutate: work => work() };
  const view = new VisualAgentMapView({ app: {} }, plugin);
  view.map = doc; view.notes = new Map(doc.nodes.map(item => [item.id, { title: item.id, summary: '', status: 'completed' }]));
  view.enqueue = work => { void work(); };
  const calls = { moveBranches: [], shift: [], mapChange: 0 };
  view.render = () => {}; view.arrangeBranch = () => {}; view.arrangeTree = () => {};
  view.mapChange = async change => { calls.mapChange++; change(view.map); };
  return { view, doc, calls, spy() {
    view.moveBranches = async (...args) => { calls.moveBranches.push(args); };
    view.shiftSiblingByKey = async (...args) => { calls.shift.push(args); };
  } };
}
const ids = doc => doc.nodes.map(n => `${n.id}<${n.parentId ?? ''}`).join(' ');

test('B18: dropping onto a row reparents through moveBranches (spy), and between rows passes the row it goes before', async () => {
  const f = mapView(); f.spy();
  assert.equal(await f.view.outlineMove('b', { target: 'a', place: 'into' }), null);
  assert.equal(f.calls.moveBranches.length, 1);
  const [roots, target, clear, before] = f.calls.moveBranches[0];
  assert.equal(JSON.stringify([roots.map(n => n.id), target.id, clear, before ?? null]), JSON.stringify([['b'], 'a', false, null]));
  f.calls.moveBranches.length = 0;
  assert.equal(await f.view.outlineMove('b', { target: 'c', place: 'before' }), null);
  assert.deepEqual([f.calls.moveBranches[0][0][0].id, f.calls.moveBranches[0][1].id, f.calls.moveBranches[0][3].id], ['b', 'a', 'c'], 'under the row\'s parent, before it');
  f.calls.moveBranches.length = 0;
  assert.equal(await f.view.outlineMove('a', { target: 'b', place: 'after' }), null);
  assert.deepEqual([f.calls.moveBranches[0][1].id, f.calls.moveBranches[0][3].id], ['root', 'd'], 'after a row = before its next sibling');
  f.calls.moveBranches.length = 0;
  assert.equal(await f.view.outlineMove('a', { target: 'd', place: 'after' }), null);
  assert.deepEqual([f.calls.moveBranches[0][1].id, f.calls.moveBranches[0][3]], ['root', undefined], 'after the last row = last');
  assert.equal(f.calls.shift.length, 0);
});
test('B18: a drop that leaves the order as it is writes nothing', async () => {
  const f = mapView(); f.spy();
  assert.equal(await f.view.outlineMove('a', { target: 'b', place: 'before' }), null);
  assert.equal(await f.view.outlineMove('d', { target: 'b', place: 'after' }), null);
  assert.equal(await f.view.outlineMove('a', { target: 'root', place: 'before' }), null, 'a first-level row has no sibling slot');
  assert.equal(f.calls.moveBranches.length, 0);
});
test('B18: Alt+Arrow goes through the canvas sibling shift', async () => {
  const f = mapView(); f.spy();
  assert.equal(await f.view.outlineMove('b', { shift: -1 }), null);
  assert.equal(await f.view.outlineMove('b', { shift: 1 }), null);
  assert.deepEqual(f.calls.shift.map(([n, o]) => [n.id, o]), [['b', -1], ['b', 1]]);
  assert.equal(f.calls.moveBranches.length, 0);
});
test('B18: self, descendant, read-only and merging drops give the reason and write nothing', async () => {
  const f = mapView(); f.spy();
  const circular = t('ui.circular_links_are_not_allowed');
  assert.equal(await f.view.outlineMove('a', { target: 'a', place: 'into' }), circular);
  assert.equal(await f.view.outlineMove('a', { target: 'c', place: 'into' }), circular, 'a descendant');
  assert.equal(await f.view.outlineMove('a', { target: 'c', place: 'before' }), circular, 'between the rows of a descendant');
  f.view.presentation = {};
  const readOnly = t('ui.outline_move_readonly');
  assert.equal(await f.view.outlineMove('b', { target: 'a', place: 'into' }), readOnly);
  assert.equal(await f.view.outlineMove('b', { shift: 1 }), readOnly);
  f.view.presentation = null;
  f.view.map.aim = {};
  assert.equal(await f.view.outlineMove('b', { target: 'a', place: 'into' }), readOnly, 'an AIM map');
  delete f.view.map.aim;
  f.view.mergeDrafts = { isMerging: id => id === 'a', has: () => false };
  assert.equal(await f.view.outlineMove('b', { target: 'a', place: 'into' }), t('ui.merge_locked'));
  assert.equal(await f.view.outlineMove('a', { shift: 1 }), t('ui.merge_locked'));
  assert.equal(f.calls.moveBranches.length + f.calls.shift.length + f.calls.mapChange, 0);
  assert.deepEqual(notices, [], 'the reason is returned to the outline, not shown twice');
});
test('B18: one drop is one map change; the real moveBranches puts the topic before the row, under its parent', async () => {
  const f = mapView();
  assert.equal(await f.view.outlineMove('b', { target: 'c', place: 'before' }), null);
  assert.equal(f.calls.mapChange, 1, 'one history entry');
  assert.equal(ids(f.doc), 'root< a<root b<a c<a d<root');
  assert.equal(await f.view.outlineMove('d', { target: 'a', place: 'into' }), null);
  assert.equal(f.calls.mapChange, 2);
  assert.equal(ids(f.doc), 'root< a<root b<a c<a d<a');
});

// ---- the outline itself ----
const loadOutline = () => load('ui/outline-view.ts', { obsidian: { ...obsidian, ItemView: class { constructor() { this.contentEl = dom.element('div'); } }, Notice: class {} } }).OutlineView;
function outline({ aim } = {}) {
  const moves = []; let answer = null;
  const OutlineView = loadOutline();
  const view = new OutlineView({ app: {} }, async () => {}, async (id, to) => { moves.push([id, to]); return answer; });
  const doc = { activeElement: null };
  view.contentEl.root = doc; view.contentEl.ownerDocument = doc;
  view.setMap({ title: 'M', ...(aim ? { aim: {} } : {}), nodes: [
    { id: 'root', parentId: null, path: 'root.md' }, { id: 'a', parentId: 'root', path: 'a.md' }, { id: 'b', parentId: 'root', path: 'b.md' }
  ] }, new Map([['root', 'Root'], ['a', 'A'], ['b', 'B']]));
  const row = id => dom.findAll(view.contentEl, i => dom.hasCls(i, 'vam-outline-row'))[['root', 'a', 'b'].indexOf(id)];
  const note = id => dom.findAll(view.contentEl, i => dom.hasCls(i, 'vam-outline-note'))[['root', 'a', 'b'].indexOf(id)];
  const handle = id => dom.find(row(id), i => dom.hasCls(i, 'vam-outline-handle'));
  for (const id of ['root', 'a', 'b']) row(id).getBoundingClientRect = () => ({ top: 100, height: 40 });
  return { view, moves, row, note, handle, answer: v => { answer = v; }, reason: () => dom.find(view.contentEl, i => dom.hasCls(i, 'vam-outline-reason')) };
}
const drag = (o, from, to, clientY) => {
  const data = {}; const dataTransfer = { setData: (k, v) => { data[k] = v; }, effectAllowed: '', dropEffect: '' };
  o.handle(from).fire('dragstart', { dataTransfer });
  o.row(to).fire('dragover', { dataTransfer, clientY });
  const hint = o.row(to).cls;
  o.row(to).fire('drop', { dataTransfer, clientY });
  return hint;
};
test('B18: every row has a drag handle; none on an AIM map or without a mover', () => {
  const o = outline();
  assert.deepEqual(['root', 'a', 'b'].map(id => o.handle(id)?.text), ['⋮⋮', '⋮⋮', '⋮⋮']);
  assert.equal(outline({ aim: true }).handle('a'), undefined);
  const OutlineView = loadOutline();
  const bare = new OutlineView({ app: {} }, async () => {});
  bare.setMap({ title: 'M', nodes: [{ id: 'a', parentId: null, path: 'a.md' }] }, new Map());
  assert.equal(dom.find(bare.contentEl, i => dom.hasCls(i, 'vam-outline-handle')), undefined);
});
test('B18: a drop in the top or bottom quarter orders, the middle reparents, and the insertion line shows while over', async () => {
  const o = outline();
  assert.ok(drag(o, 'b', 'a', 102).includes('is-drop-before'));
  assert.ok(drag(o, 'a', 'b', 138).includes('is-drop-after'));
  assert.ok(drag(o, 'b', 'a', 120).includes('is-drop-into'));
  assert.deepEqual(JSON.parse(JSON.stringify(o.moves)), [['b', { target: 'a', place: 'before' }], ['a', { target: 'b', place: 'after' }], ['b', { target: 'a', place: 'into' }]]);
  assert.ok(!o.row('a').cls.includes('is-drop'), 'the line is gone after the drop');
  drag(o, 'b', 'root', 102);
  assert.deepEqual(JSON.parse(JSON.stringify(o.moves.at(-1))), ['b', { target: 'root', place: 'into' }], 'a first-level row can only take a drop under it');
});
test('B18: a refused move shows the reason in red text; an accepted one shows nothing', async () => {
  const o = outline();
  o.answer('Circular links are not allowed.');
  drag(o, 'a', 'a', 120); await dom.tick();
  assert.equal(o.reason().text, 'Circular links are not allowed.');
  assert.equal(o.reason().attrs.role, 'alert');
  o.answer(null);
  drag(o, 'b', 'a', 120); await dom.tick();
  assert.equal(o.reason(), undefined);
});
test('B18: Alt+Up/Down on a row asks for a one-step shift; other keys and modifiers do not', async () => {
  const o = outline();
  const press = (id, event) => { let prevented = false; o.note(id).fire('keydown', { preventDefault() { prevented = true; }, ...event }); return prevented; };
  assert.equal(press('b', { key: 'ArrowUp', altKey: true }), true);
  assert.equal(press('b', { key: 'ArrowDown', altKey: true }), true);
  assert.equal(press('b', { key: 'ArrowUp' }), false);
  assert.equal(press('b', { key: 'ArrowUp', altKey: true, shiftKey: true }), false);
  assert.equal(press('b', { key: 'a', altKey: true }), false);
  assert.deepEqual(JSON.parse(JSON.stringify(o.moves)), [['b', { shift: -1 }], ['b', { shift: 1 }]]);
});
