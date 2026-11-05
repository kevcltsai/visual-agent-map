// Summary brackets P2: geometry for the five supported arrangements, and the View (draw, create, edit, remove, undo, clean-up
// when members go, AI wiring). The DOM here is a stand-in: pixel positions, real focus and real clicks are for the UI tester.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, fixture, DEFAULT_SETTINGS, obsidian, core, withExpansionCoordinator } = require('./support.cjs');
const dom = require('./support-dom.cjs');
const { element, find, findAll } = dom;
const plain = value => JSON.parse(JSON.stringify(value));
const TOPICS = 'Agent Workspace/Topics';
const MAP = `${TOPICS}/map-s/Map.md`;
const BOX = { w: 280, h: 100 };
const createSvg = tag => ({ tag, attrs: {}, classes: [], children: [], setAttribute(n, v) { this.attrs[n] = v; }, getAttribute(n) { return this.attrs[n]; }, addClass(...n) { this.classes.push(...n); }, appendChild(c) { this.children.push(c); } });
const geometry = load('experiences/visual-map/summary-bracket-geometry.ts');

const rect = (x, y) => ({ x, y, w: BOX.w, h: BOX.h });
const RUN = [rect(500, 150), rect(900, 150), rect(500, 300)];
const PARENT = rect(100, 200);

test('A4 geometry: one snapshot per arrangement, text on the outside', () => {
  const at = direction => geometry.bracketGeometry(direction, RUN, PARENT);
  assert.deepEqual(plain(at('right')), { ok: true, side: 'right', path: 'M 1194 150 Q 1206 150 1206 162 L 1206 263 Q 1206 275 1218 275 Q 1206 275 1206 287 L 1206 388 Q 1206 400 1194 400', label: { x: 1226, y: 275 }, extent: { x: 500, y: 150, w: 680, h: 250 } });
  assert.deepEqual(plain(at('left')), { ok: true, side: 'left', path: 'M 486 150 Q 474 150 474 162 L 474 263 Q 474 275 462 275 Q 474 275 474 287 L 474 388 Q 474 400 486 400', label: { x: 454, y: 275 }, extent: { x: 500, y: 150, w: 680, h: 250 } });
  assert.deepEqual(plain(at('down')), { ok: true, side: 'down', path: 'M 500 414 Q 500 426 512 426 L 828 426 Q 840 426 840 438 Q 840 426 852 426 L 1168 426 Q 1180 426 1180 414', label: { x: 840, y: 446 }, extent: { x: 500, y: 150, w: 680, h: 250 } });
  assert.deepEqual(plain(at('up')), { ok: true, side: 'up', path: 'M 500 136 Q 500 124 512 124 L 828 124 Q 840 124 840 112 Q 840 124 852 124 L 1168 124 Q 1180 124 1180 136', label: { x: 840, y: 104 }, extent: { x: 500, y: 150, w: 680, h: 250 } });
  // Balanced: the half comes from where the run sits against its parent.
  assert.equal(at('balanced').side, 'right');
  const left = geometry.bracketGeometry('balanced', [rect(-400, 0), rect(-400, 150)], PARENT);
  assert.equal(left.side, 'left');
});

test('A4 geometry: a balanced run over both halves is refused; radial, timeline and fishbone are not drawn; nothing usable is empty', () => {
  assert.deepEqual(plain(geometry.bracketGeometry('balanced', [rect(500, 0), rect(-400, 150)], PARENT)), { ok: false, reason: 'cross-side' });
  for (const direction of ['radial', 'timeline', 'fishbone']) assert.deepEqual(plain(geometry.bracketGeometry(direction, RUN, PARENT)), { ok: false, reason: 'unsupported' });
  assert.deepEqual(plain(geometry.bracketGeometry('right', [], PARENT)), { ok: false, reason: 'empty' });
  assert.deepEqual(plain(geometry.bracketGeometry('right', [{ x: NaN, y: 0, w: 1, h: 1 }], PARENT)), { ok: false, reason: 'empty' });
});

async function harness({ direction, build, boxes } = {}) {
  const { repo, app } = fixture('en', { linkIndex: true });
  const settings = { ...DEFAULT_SETTINGS, language: 'en', cliModel: 'gpt-6-luna' };
  repo.settings = settings;
  const doc = { id: 'map-s', title: 'S', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  await repo.ensureTopicFolders(`${TOPICS}/map-s`);
  await app.vault.create(MAP, core.serializeMap(doc));
  const make = async title => repo.createNote(title, 'gpt-6-luna', doc, MAP, 'workspace');
  const root = await make('Root'), a = await make('Alpha'), b = await make('Beta'), c = await make('Gamma'), b1 = await make('Beta child'), d = await make('Delta');
  for (const n of [a, b, c, d]) n.parentId = root.id;
  b1.parentId = b.id;
  doc.nodes.push(root, a, b, c, d, b1);
  const ids = { root: root.id, a: a.id, b: b.id, c: c.id, d: d.id, b1: b1.id };
  if (build) doc.canvasItems = build(ids);
  await repo.saveMap(MAP, doc);
  await repo.rebuildDerivedData();
  const layout = (typeof boxes === 'function' ? boxes(ids) : boxes) ?? { [ids.root]: [100, 200], [ids.a]: [500, 0], [ids.b]: [500, 150], [ids.c]: [500, 300], [ids.d]: [500, 450], [ids.b1]: [900, 150] };
  let pending = Promise.resolve();
  const notices = [], menus = [];
  const Menu = class { constructor() { this.items = []; this.separators = []; menus.push(this); } addItem(cb) { const item = { setTitle(v) { this.title = v; return this; }, setIcon() { return this; }, setWarning(v) { this.warning = v; return this; }, onClick(fn) { this.click = fn; return this; } }; cb(item); this.items.push(item); return this; } addSeparator() { this.separators.push(this.items.length); return this; } showAtPosition(at) { this.at = at; return this; } showAtMouseEvent() { this.mouse = true; return this; } };
  const { VisualAgentMapView } = load('main.ts', { obsidian: { ...obsidian, Notice: dom.makeNotice(notices), Menu } }, { createFragment: dom.createFragment, CSS: { escape: v => v }, createSvg, requestAnimationFrame: () => 1, cancelAnimationFrame() {} });
  const plugin = withExpansionCoordinator({
    repo, settings, running: new Set(), logs: { appendLog() {} }, rebuildDerivedData: () => repo.rebuildDerivedData(), relevanceGrades: new Map(), expansionBatches: new Map(), pendingSuggestions: new Map(), releaseOutline() {}, setOutlineActive() {}, detailsShown: () => false,
    mutate: work => (pending = Promise.resolve().then(work))
  });
  const view = new VisualAgentMapView({ app }, plugin);
  view.path = MAP; view.map = await repo.readMap(MAP);
  if (direction) view.map.layout = { direction }; view.contentEl = element('div'); view.stageEl = element('div');
  view.focusNode = () => {}; view.openDetails = () => {};
  view.hydrate = async () => { view.notes = new Map(await Promise.all(view.map.nodes.map(async n => [n.id, await repo.readNote(n.path)]))); };
  await view.hydrate();
  view.announcer = element('div');
  const hidden = id => { for (let n = view.map.nodes.find(x => x.id === id); n?.parentId; n = view.map.nodes.find(x => x.id === n.parentId)) if (view.map.nodes.find(x => x.id === n.parentId)?.collapsed) return true; return false; };
  view.render = () => {
    view.stageEl.children = []; view.cardEls = new Map(); view.textEls.clear(); view.summaryEls.clear();
    for (const n of view.map.nodes) {
      if (hidden(n.id)) continue;
      const [x, y] = layout[n.id] ?? [0, 0];
      const card = view.stageEl.child('div', 'vam-node');
      Object.assign(card, { offsetLeft: x, offsetTop: y, offsetWidth: BOX.w, offsetHeight: BOX.h });
      view.cardEls.set(n.id, card);
    }
    view.renderCanvasItems();
  };
  view.render();
  const settle = async () => { await pending; await dom.tick(); await pending; };
  const onDisk = async () => plain((await repo.readMap(MAP)).canvasItems ?? []);
  const el = id => find(view.stageEl, i => i.dataset?.itemId === id);
  const area = () => find(view.stageEl, i => i.tag === 'textarea');
  const sum = (members, over = {}) => ({ id: 's1', kind: 'summary', parentId: ids.root, members, text: 'Both too costly', ...over });
  return { repo, view, ids, settle, onDisk, el, area, notices, menus, sum, layout };
}

test('render: the brace and its text are drawn at the outer edge of the framed subtrees, as a labelled group; text stays text', async () => {
  const h = await harness({ build: ids => [h0(ids)] });
  function h0(ids) { return { id: 's1', kind: 'summary', parentId: ids.root, members: [ids.b, ids.c], text: '<img src=x onerror=alert(1)>' }; }
  const layer = find(h.view.stageEl, i => dom.hasCls(i, 'vam-summaries'));
  assert.equal(layer.attrs.role, 'group');
  assert.equal(layer.attrs['aria-label'], 'Summary brackets');
  const s = h.el('s1');
  assert.ok(s.hasClass('is-side-right'));
  assert.equal(s.attrs.role, 'group');
  assert.equal(s.tabIndex, 0);
  assert.equal(s.attrs['aria-label'], 'Summary bracket: <img src=x onerror=alert(1)>');
  const svg = s.children.find(c => c.tag === 'svg');
  assert.equal(svg.attrs['aria-hidden'], 'true');
  assert.equal(svg.children[0].attrs.d, 'M 1194 150 Q 1206 150 1206 162 L 1206 263 Q 1206 275 1218 275 Q 1206 275 1206 287 L 1206 388 Q 1206 400 1194 400');
  const text = find(s, i => dom.hasCls(i, 'vam-summary-text'));
  assert.equal(text.text, '<img src=x onerror=alert(1)>');
  assert.equal(find(s, i => i.tag === 'img'), undefined);
  assert.deepEqual([text.style.left, text.style.top], ['1226px', '275px']);
  // The framed run is the effective range: Gamma and the card between are inside, Delta is not.
});

test('render: the range covers the cards between the first and last member; no bracket without a layer when none exists', async () => {
  const none = await harness();
  assert.equal(find(none.view.stageEl, i => dom.hasCls(i, 'vam-summaries')), undefined, 'a map without brackets draws nothing new');
  const h = await harness({ build: ids => [{ id: 's1', kind: 'summary', parentId: ids.root, members: [ids.a, ids.c], text: 'x' }] });
  const path = find(h.el('s1'), i => i.tag === 'path').attrs.d;
  assert.match(path, /^M 1194 0 /, 'starts at Alpha (top 0)');
  assert.match(path, / 1194 400$/, 'ends at Gamma (bottom 400): Beta, in between, is framed with its child');
});

test('render: a folded parent hides the bracket and keeps the data; each arrangement puts it on its side; later arrangements are not drawn but kept', async () => {
  const h = await harness({ build: ids => [{ id: 's1', kind: 'summary', parentId: ids.root, members: [ids.b, ids.c], text: 'x' }] });
  h.view.map.nodes[0].collapsed = true;
  h.view.render();
  assert.equal(h.el('s1'), undefined);
  assert.equal(plain(h.view.map.canvasItems).length, 1);
  h.view.map.nodes[0].collapsed = false;
  for (const [direction, side] of [['left', 'left'], ['down', 'down'], ['up', 'up'], ['right', 'right']]) {
    h.view.map.layout = { direction };
    h.view.render();
    assert.ok(h.el('s1').hasClass(`is-side-${side}`), direction);
  }
  for (const direction of ['radial', 'timeline', 'fishbone']) {
    h.view.map.layout = { direction };
    h.view.render();
    assert.equal(h.el('s1'), undefined, `${direction} is not drawn`);
    assert.equal(plain(h.view.map.canvasItems).length, 1, `${direction} keeps the data`);
  }
});

test('A3 create: three topics under one parent open an editor; Cmd/Ctrl+Enter writes one undo step, undo and redo round-trip', async () => {
  const h = await harness();
  h.view.selection.replaceMulti([h.ids.c, h.ids.b]);
  const past = h.view.history.past.length;
  h.view.addSummaryOver();
  assert.ok(h.area(), 'the editor opens at once');
  assert.deepEqual(await h.onDisk(), [], 'nothing is written before there is text');
  assert.equal(h.view.history.past.length, past);
  h.area().value = '  Both too costly  ';
  h.area().fire('keydown', { key: 'Enter', ctrlKey: true });
  await h.settle();
  const items = await h.onDisk();
  assert.equal(items.length, 1);
  assert.deepEqual([items[0].kind, items[0].parentId, items[0].members, items[0].text], ['summary', h.ids.root, [h.ids.b, h.ids.c], 'Both too costly']);
  assert.equal(h.view.history.past.length, past + 1);
  assert.ok(h.el(items[0].id), 'drawn after the write');
  await h.view.travel(false);
  assert.deepEqual(await h.onDisk(), []);
  await h.view.travel(true);
  assert.equal((await h.onDisk())[0].text, 'Both too costly');
});

test('Critical Path: Esc, empty text and a view that closes leave no bracket and no editor state', async () => {
  const h = await harness();
  const past = h.view.history.past.length;
  h.view.selection.replaceMulti([h.ids.b]);
  h.view.addSummaryOver();
  h.area().value = 'draft';
  h.area().fire('keydown', { key: 'Escape' });
  await h.settle();
  assert.equal(h.area(), undefined);
  assert.equal(h.view.pendingSummary, null);
  assert.deepEqual(await h.onDisk(), []);
  h.view.addSummaryOver();
  h.area().value = '   ';
  h.area().fire('keydown', { key: 'Enter', metaKey: true });
  await h.settle();
  assert.deepEqual(await h.onDisk(), [], 'an empty summary is a cancelled creation');
  assert.equal(h.view.pendingSummary, null);
  assert.equal(h.view.history.past.length, past);
  h.view.addSummaryOver();
  await h.view.onClose();
  assert.equal(h.view.pendingSummary, null, 'closing the view drops the unfinished bracket');
  assert.equal(h.view.editingSummaryId, null);
});

test('Critical Path: a repaint while typing keeps the draft; members that vanish drop the unfinished bracket', async () => {
  const h = await harness();
  h.view.selection.replaceMulti([h.ids.b, h.ids.c]);
  h.view.addSummaryOver();
  h.area().value = 'half written';
  h.view.render();
  assert.equal(h.area().value, 'half written', 'the draft survives a repaint');
  h.view.map.nodes = h.view.map.nodes.filter(n => n.id !== h.ids.b && n.id !== h.ids.c);
  h.view.render();
  assert.equal(h.area(), undefined);
  assert.equal(h.view.pendingSummary, null);
  assert.deepEqual(await h.onDisk(), []);
});

test('A3 refusals: not adjacent, across parents, the root, a balanced run over both halves, and a later arrangement are explained and write nothing', async () => {
  const h = await harness();
  const refuse = async (ids, text) => {
    h.notices.length = 0;
    h.view.selection.replaceMulti(ids);
    h.view.addSummaryOver();
    assert.equal(h.view.pendingSummary, null, text);
    assert.equal(h.area(), undefined, text);
    assert.equal(h.notices.length, 1, text);
    assert.equal(h.notices[0], text);
    assert.equal(h.view.announcer.text, text, 'the live region says it too');
  };
  await refuse([h.ids.a, h.ids.c], 'Select topics that sit next to each other, with none left out in between.');
  await refuse([h.ids.b1, h.ids.c], 'Select topics under the same parent topic.');
  await refuse([h.ids.root], 'The root topic cannot be bracketed; select its subtopics.');
  await refuse([], 'Select the topics to bracket first.');
  h.view.map.layout = { direction: 'radial' };
  await refuse([h.ids.b], 'This arrangement does not support summary brackets yet.');
  const moved = await harness({ direction: 'balanced' });
  Object.assign(moved.layout, { [moved.ids.c]: [-400, 300], [moved.ids.d]: [-400, 450] });
  moved.view.render();
  moved.view.selection.replaceMulti([moved.ids.b, moved.ids.c]);
  moved.view.addSummaryOver();
  assert.equal(moved.view.pendingSummary, null);
  assert.equal(moved.notices[0], 'Select topics on one side only; a bracket cannot span both halves of a balanced map.');
  moved.view.selection.replaceMulti([moved.ids.c, moved.ids.d]);
  moved.view.addSummaryOver();
  assert.ok(moved.view.pendingSummary, 'one half is fine');
  assert.deepEqual(await h.onDisk(), []);
});

test('A3 edit: double-click edits, Esc keeps the old text, an empty text or Delete removes; each write is one undo step', async () => {
  const h = await harness({ build: ids => [{ id: 's1', kind: 'summary', parentId: ids.root, members: [ids.b, ids.c], text: 'Old' }] });
  const past = h.view.history.past.length;
  const label = () => find(h.el('s1'), i => dom.hasCls(i, 'vam-summary-text'));
  label().fire('dblclick', {});
  h.area().value = 'changed';
  h.area().fire('keydown', { key: 'Escape' });
  await h.settle();
  assert.equal((await h.onDisk())[0].text, 'Old');
  assert.equal(h.view.history.past.length, past);
  label().fire('dblclick', {});
  h.area().value = 'New words';
  h.area().fire('keydown', { key: 'Enter', ctrlKey: true });
  await h.settle();
  assert.equal((await h.onDisk())[0].text, 'New words');
  assert.equal(h.view.history.past.length, past + 1);
  h.el('s1').fire('keydown', { key: 'Enter' });
  assert.ok(h.area(), 'Enter on the focused bracket opens the editor');
  h.area().value = '';
  h.area().fire('keydown', { key: 'Enter', metaKey: true });
  await h.settle();
  assert.deepEqual(await h.onDisk(), []);
  assert.equal(h.view.history.past.length, past + 2);
  await h.view.travel(false);
  assert.equal((await h.onDisk())[0].text, 'New words');
  h.el('s1').fire('keydown', { key: 'Delete' });
  await h.settle();
  assert.deepEqual(await h.onDisk(), []);
  assert.equal(h.view.history.past.length, past + 2);
  await h.view.travel(false);
  assert.equal((await h.onDisk()).length, 1);
});

test('A3 range: the menu replaces the range with the selected topics in one step; a refused range changes nothing', async () => {
  const h = await harness({ build: ids => [{ id: 's1', kind: 'summary', parentId: ids.root, members: [ids.b, ids.c], text: 'x' }] });
  const label = find(h.el('s1'), i => dom.hasCls(i, 'vam-summary-text'));
  label.fire('contextmenu', { clientX: 1, clientY: 1 });
  const titles = h.menus.at(-1).items.map(i => i.title);
  assert.deepEqual(titles, ['Edit summary…', 'Use the selected topics as the range', 'Remove summary bracket']);
  const past = h.view.history.past.length;
  h.view.selection.replaceMulti([h.ids.a, h.ids.c]);
  h.menus.at(-1).items[1].click();
  await h.settle();
  assert.deepEqual((await h.onDisk())[0].members, [h.ids.b, h.ids.c], 'not adjacent: unchanged');
  assert.equal(h.view.history.past.length, past);
  h.view.selection.replaceMulti([h.ids.c, h.ids.d]);
  h.menus.at(-1).items[1].click();
  await h.settle();
  assert.deepEqual((await h.onDisk())[0].members, [h.ids.c, h.ids.d]);
  assert.equal(h.view.history.past.length, past + 1);
  await h.view.travel(false);
  assert.deepEqual((await h.onDisk())[0].members, [h.ids.b, h.ids.c]);
});

test('A3 clean-up: a member moved to another parent or removed shrinks or removes the bracket in the same step; undo restores both', async () => {
  const h = await harness({ build: ids => [{ id: 's1', kind: 'summary', parentId: ids.root, members: [ids.b, ids.c], text: 'x' }] });
  const past = h.view.history.past.length;
  await h.view.mapChange(map => { map.nodes.find(n => n.id === h.ids.c).parentId = h.ids.a; }, false);
  assert.deepEqual((await h.onDisk())[0].members, [h.ids.b], 'a moved member leaves the bracket');
  await h.view.mapChange(map => { map.nodes.find(n => n.id === h.ids.b).parentId = h.ids.a; }, false);
  assert.deepEqual(await h.onDisk(), [], 'no member left: the bracket goes');
  assert.equal(h.view.history.past.length, past + 2);
  await h.view.travel(false);
  assert.deepEqual((await h.onDisk())[0].members, [h.ids.b]);
  await h.view.travel(false);
  assert.deepEqual((await h.onDisk())[0].members, [h.ids.b, h.ids.c], 'undo restores the original range');
  // Removing cards runs through dropTextLinks inside the same edit.
  await h.view.mapChange(map => {
    const gone = new Set([h.ids.c]);
    map.nodes = map.nodes.filter(n => !gone.has(n.id));
    h.view.dropTextLinks(map, gone);
  }, false);
  assert.deepEqual((await h.onDisk())[0].members, [h.ids.b]);
  await h.view.mapChange(map => {
    const gone = new Set([h.ids.root, h.ids.a, h.ids.b, h.ids.d, h.ids.b1]);
    map.nodes = map.nodes.filter(n => !gone.has(n.id));
    h.view.dropTextLinks(map, gone);
  }, false);
  assert.deepEqual(await h.onDisk(), [], 'removing the parent removes the bracket and leaves no empty canvasItems');
  assert.equal((await h.repo.readMap(MAP)).canvasItems, undefined);
});

test('T6 P3 entries (counterexample 15, D4/D10): Note style… only for one regular topic; a multi-selection, an AIM conclusion card, an AIM map and presentation get none; Menu key / Shift+F10 (client 0,0) opens the menu beside the card', async () => {
  const h = await harness();
  const card = h.view.cardEls.get(h.ids.b);
  card.getBoundingClientRect = () => ({ left: 500, bottom: 190, top: 150, right: 700 });
  const event = (x = 1, y = 1) => ({ clientX: x, clientY: y, preventDefault() {}, target: { closest: selector => (selector === '.vam-node' ? card : null) } });
  const titles = () => h.menus.at(-1).items.map(i => i.title);
  const opened = [];
  h.view.chooseTopicStyle = node => opened.push(node.id);
  h.view.onCanvasContextMenu(event());
  h.menus.at(-1).items.find(i => i.title === 'Note style…').click();
  assert.deepEqual(opened, [h.ids.b], 'the entry opens the chooser for the right-clicked topic');
  h.view.selection.replaceMulti([h.ids.b, h.ids.c]);
  h.view.onCanvasContextMenu(event());
  assert.deepEqual(titles(), ['Add summary bracket'], 'two or more selected topics: no per-topic style');
  h.view.selection.replaceMulti([]);
  h.view.map.nodes.find(n => n.id === h.ids.b).aimKind = 'conclusion';
  h.view.onCanvasContextMenu(event());
  assert.deepEqual(titles(), ['Add summary bracket'], 'an AIM conclusion card has its own style row in the settings');
  delete h.view.map.nodes.find(n => n.id === h.ids.b).aimKind;
  h.view.onCanvasContextMenu(event(0, 0));
  assert.deepEqual(plain(h.menus.at(-1).at), { x: 500, y: 190 }, 'keyboard: the menu sits at the bottom-left of the card');
  assert.equal(h.menus.at(-1).mouse, undefined);
  for (const mode of ['aim', 'presentation']) {
    const g = await harness();
    if (mode === 'aim') g.view.map.aim = { branches: [] };
    if (mode === 'presentation') g.view.presentation = { order: [], currentId: 'x' };
    const gcard = g.view.cardEls.get(g.ids.b);
    const before = g.menus.length;
    g.view.onCanvasContextMenu({ clientX: 1, clientY: 1, preventDefault() {}, target: { closest: selector => (selector === '.vam-node' ? gcard : null) } });
    assert.equal(g.menus.length, before, `${mode}: no menu, so no Note style…`);
  }
});

test('A5 wiring: the integration context gets the brackets of that parent only; the chat gets every bracket as the effective range', async () => {
  const h = await harness({ build: ids => [{ id: 's1', kind: 'summary', parentId: ids.root, members: [ids.a, ids.c], text: 'Conclude: postpone' }] });
  assert.deepEqual(plain(h.view.summaryDirections(h.ids.root)), { summaryDirections: '- Alpha; Beta; Gamma\n  Conclude: postpone' });
  assert.deepEqual(plain(h.view.summaryDirections(h.ids.b)), {}, 'another parent gets none');
  assert.deepEqual(plain(h.view.chatSummaries()), [{ id: 's1', parentId: h.ids.root, members: [h.ids.a, h.ids.b, h.ids.c], text: 'Conclude: postpone' }]);
  const plainMap = await harness();
  assert.deepEqual(plain(plainMap.view.summaryDirections(plainMap.ids.root)), {}, 'no key at all, so prompts stay byte for byte');
  assert.equal(plainMap.view.chatSummaries(), undefined);
});

test('entries: right-click on a card offers the bracket for the multi-selection (or that card); AIM and presentation get none', async () => {
  const h = await harness();
  const card = h.view.cardEls.get(h.ids.b);
  const event = () => ({ clientX: 1, clientY: 1, preventDefault() {}, target: { closest: selector => (selector === '.vam-node' ? card : null) } });
  h.view.onCanvasContextMenu(event());
  const entryTitles = h.menus.at(-1).items.map(i => i.title);
  assert.deepEqual(entryTitles.slice(entryTitles.indexOf('Add summary bracket'), entryTitles.indexOf('Add summary bracket') + 2), ['Add summary bracket', 'Note style…'], 'T6 P3 added the topic note style entry after the bracket (D4)');
  assert.equal(h.menus.at(-1).mouse, true, 'a mouse right-click opens the menu at the pointer');
  h.menus.at(-1).items.find(i => i.title === 'Add summary bracket').click();
  assert.ok(h.area(), 'one card is enough; the editor opens');
  assert.deepEqual(plain(h.view.pendingSummary.members), [h.ids.b]);
  for (const mode of ['aim', 'presentation']) {
    const g = await harness({ build: ids => [{ id: 's1', kind: 'summary', parentId: ids.root, members: [ids.b], text: 'x' }] });
    if (mode === 'aim') g.view.map.aim = { branches: [] };
    if (mode === 'presentation') g.view.presentation = { order: [], currentId: 'x' };
    g.view.render();
    g.view.selection.replaceMulti([g.ids.c]);
    g.view.addSummaryOver();
    assert.equal(g.view.pendingSummary, null, mode);
    find(g.el('s1'), i => dom.hasCls(i, 'vam-summary-text')).fire('dblclick', {});
    g.el('s1').fire('keydown', { key: 'Delete' });
    assert.equal(g.area(), undefined, mode);
    await g.settle();
    assert.equal((await g.onDisk()).length, 1, mode);
  }
});

test('F1 pan: a pointerdown on the bracket or its text never starts a pan, so a real double-click reaches the text', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(require('node:path').join(__dirname, '..', 'experiences/visual-map/view.ts'), 'utf8');
  const start = src.indexOf('viewport.addEventListener("pointerdown"');
  assert.ok(start > 0);
  const guard = src.slice(start, src.indexOf('canvasPointerIntent({', start));
  for (const cls of ['.vam-summary', '.vam-summary-text', '.vam-boundary-label']) assert.ok(guard.includes(`target.closest("${cls}")`), cls);
  // The text itself still opens the editor on dblclick (covered by the A3 edit test above).
  assert.ok(src.includes('label.addEventListener("dblclick"'));
});

test('F2 fit: the text box of a bracket follows the side transform, and fit counts it (plugin and viewer)', () => {
  const fs = require('node:fs');
  const read = f => fs.readFileSync(require('node:path').join(__dirname, '..', f), 'utf8');
  const at = { x: 100, y: 200 };
  assert.deepEqual(plain(geometry.summaryTextBox('right', at, 200, 40)), { x: 100, y: 180, w: 200, h: 40 });
  assert.deepEqual(plain(geometry.summaryTextBox('left', at, 200, 40)), { x: -100, y: 180, w: 200, h: 40 });
  assert.deepEqual(plain(geometry.summaryTextBox('down', at, 200, 40)), { x: 0, y: 200, w: 200, h: 40 });
  assert.deepEqual(plain(geometry.summaryTextBox('up', at, 200, 40)), { x: 0, y: 160, w: 200, h: 40 });
  const view = read('experiences/visual-map/view.ts');
  const fit = view.slice(view.indexOf('private fit(): void'), view.indexOf('private setupPan'));
  assert.ok(fit.includes('summaryTextBox(') && fit.includes('this.summaryEls'));
  const viewer = read('experiences/sharing/viewer/main.ts');
  const viewerFit = viewer.slice(viewer.indexOf('function fit(): void'), viewer.indexOf('function center('));
  assert.ok(viewerFit.includes('.vam-summary-text') && viewerFit.includes('is-side-left'));
  assert.ok(!/import .*summary-bracket-geometry/.test(viewer));
});

// bug bash A #26: the bracket text steps outward past cards that are not part of the run; layout and braces stay as they were.
test('bug bash #26 geometry: avoidBracketObstacles pushes the label out past every non-member card, never when nothing collides', () => {
  const box = { w: 200, h: 22 };
  const label = { x: 1226, y: 275 };
  const none = geometry.avoidBracketObstacles('right', label, box, [rect(500, 0), rect(100, 200)]);
  assert.deepEqual(plain(none), label, 'no collision: the very same position');
  const hit = rect(1230, 250);
  for (const [side, from] of [['right', label], ['left', { x: 454, y: 275 }], ['down', { x: 840, y: 440 }], ['up', { x: 840, y: 104 }]]) {
    const obstacle = side === 'right' ? hit : side === 'left' ? rect(100, 250) : side === 'down' ? rect(700, 440) : rect(700, 20);
    const pushed = geometry.avoidBracketObstacles(side, from, box, [obstacle]);
    const text = geometry.summaryTextBox(side, pushed, box.w, box.h);
    assert.equal(text.x < obstacle.x + obstacle.w && obstacle.x < text.x + text.w && text.y < obstacle.y + obstacle.h && obstacle.y < text.y + text.h, false, `${side}: the text box clears the card`);
  }
  const wall = Array.from({ length: 8 }, (_, i) => rect(1230 + i * 280, 250));
  const capped = geometry.avoidBracketObstacles('right', label, box, wall);
  assert.ok(capped.x - label.x <= 3 * 280 && capped.x > label.x, 'bounded push: stops at the cap and stays there');
});
test('bug bash #26 view: bracket text beside a card that is not a member is pushed clear of it; the brace and the other cards stay', async () => {
  const build = ids => [{ id: 's1', kind: 'summary', parentId: ids.root, members: [ids.b, ids.c], text: 'Both too costly' }];
  const plainRun = await harness({ build });
  const [baseLeft, baseTop] = [find(plainRun.el('s1'), i => dom.hasCls(i, 'vam-summary-text')).style.left, find(plainRun.el('s1'), i => dom.hasCls(i, 'vam-summary-text')).style.top];
  const h = await harness({ build, boxes: ids => ({ [ids.root]: [100, 200], [ids.a]: [500, 0], [ids.b]: [500, 150], [ids.c]: [500, 300], [ids.d]: [1230, 250], [ids.b1]: [900, 150] }) });
  const text = find(h.el('s1'), i => dom.hasCls(i, 'vam-summary-text'));
  const x = parseFloat(text.style.left), y = parseFloat(text.style.top);
  assert.equal(baseLeft, '1226px'); assert.equal(baseTop, '275px');
  assert.ok(x >= 1230 + 280, 'the text starts beyond the neighbouring card (right edge 1510)');
  assert.equal(y, 275, 'only moved along the outward axis');
  assert.equal(find(h.el('s1'), i => i.tag === 'path').attrs.d, find(plainRun.el('s1'), i => i.tag === 'path').attrs.d, 'the brace is unchanged');
});

test('C1 card context menu: one topic gets its card actions in groups (AI and new topics, editing, opening), then the bracket and style, then Remove; each entry runs the same action as the card tool', async () => {
  const h = await harness();
  const card = h.view.cardEls.get(h.ids.b);
  const event = () => ({ clientX: 1, clientY: 1, preventDefault() {}, target: { closest: selector => (selector === '.vam-node' ? card : null) } });
  const calls = [];
  h.view.openNextStep = node => calls.push(['ai', node.id]);
  h.view.addNode = async parent => { calls.push(['add', parent?.id ?? null]); };
  h.view.renameNode = (node, title) => calls.push(['rename', node.id, title]);
  h.view.openNodePanel = (node, mode) => calls.push(['panel', node.id, mode]);
  h.view.selectSubtopics = node => calls.push(['select', node.id]);
  h.view.toggleCollapsed = node => calls.push(['fold', node.id]);
  h.view.addTextNodeUnder = node => calls.push(['text', node.id]);
  h.view.openDetails = node => calls.push(['details', node.id]);
  h.view.openNoteInTab = node => calls.push(['tab', node.id]);
  h.view.removeByKey = node => calls.push(['remove', node.id]);
  h.view.onCanvasContextMenu(event());
  const menu = h.menus.at(-1);
  const titles = menu.items.map(i => i.title);
  assert.deepEqual(titles, ['AI explore', 'Add subtopic manually', 'Add sibling topic', 'Rename', 'This card', 'Select subtopics', 'Collapse', 'Add text', 'Open details in right sidebar', 'Open note in new tab', 'Add summary bracket', 'Note style…', 'Remove from map']);
  assert.deepEqual(menu.separators, [3, 8, 10, 12], 'separators between the groups');
  assert.equal(menu.items.at(-1).warning, true, 'Remove is marked as a warning');
  for (const item of menu.items) if (!['Add summary bracket', 'Note style…'].includes(item.title)) item.click();
  await h.settle();
  const b = h.view.map.nodes.find(n => n.id === h.ids.b);
  // The two add entries go through the map's work queue, so they land after the direct ones; the order is not the point.
  const sorted = list => plain(list).map(item => JSON.stringify(item)).sort();
  assert.deepEqual(sorted(calls), sorted([['ai', h.ids.b], ['add', h.ids.b], ['add', b.parentId], ['rename', h.ids.b, h.view.notes.get(h.ids.b).title], ['panel', h.ids.b, 'structure'], ['select', h.ids.b], ['fold', h.ids.b], ['text', h.ids.b], ['details', h.ids.b], ['tab', h.ids.b], ['remove', h.ids.b]]));
  h.view.selection.replaceMulti([h.ids.b, h.ids.c]);
  h.view.onCanvasContextMenu(event());
  assert.deepEqual(h.menus.at(-1).items.map(i => i.title), ['Add summary bracket'], 'several topics: only the bracket');
});
