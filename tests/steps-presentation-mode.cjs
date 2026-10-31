// 0.28 ticket 42 P2: presentation mode. Real view + repository; the DOM is the stand-in from tests/support-dom.cjs.
// Covers the key table, read-only keys, the edges, folded branches, render survival, exit restore and the stale-state fences.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { load, core, fixture, DEFAULT_SETTINGS, obsidian, withExpansionCoordinator } = require('./support.cjs');
const dom = require('./support-dom.cjs');
const { element } = dom;

const make = (tag, init = {}) => ({ tag, children: [], dataset: {}, style: {}, attrs: {}, handlers: new Map(), classes: new Set(String(init.cls ?? '').split(' ').filter(Boolean)), text: init.text, tabIndex: init.tabIndex, checked: false, isConnected: true,
  createDiv(value) { return this.createEl('div', typeof value === 'string' ? { cls: value } : value); },
  createSpan(value) { return this.createEl('span', typeof value === 'string' ? { cls: value } : value); },
  createEl(name, value = {}) { const child = make(name, value); child.parent = this; this.children.push(child); return child; },
  setAttr(name, value) { this.attrs[name] = value; }, addClass(...names) { names.forEach(name => this.classes.add(name)); }, removeClass(name) { this.classes.delete(name); },
  setText(value) { this.text = String(value); }, removeAttribute() {}, setAttribute() {},
  toggleClass(name, on) { if (on) this.classes.add(name); else this.classes.delete(name); }, addEventListener(name, handler) { this.handlers.set(name, handler); }, removeEventListener() {},
  setPointerCapture() {}, focus() {}, remove() { this.removed = true; this.isConnected = false; }, getBoundingClientRect() { return { left: 0, right: 10, top: 0, bottom: 10 }; },
  contains(other) { return other === this; }, closest() { return null; },
  querySelector() { return null; }, querySelectorAll() { return []; }, replaceWith() {} });
const MAP = 'Agent Workspace/Topics/map-p/Map.md';
const TITLES = { root: 'Root', alpha: 'Alpha plan', beta: '市場分析', branch: 'Branch', inner: 'Inner' };
const plain = value => JSON.parse(JSON.stringify(value));
const pm = () => load('experiences/visual-map/presentation-mode.ts');

async function harness() {
  const { repo, app, contents } = fixture('en');
  const settings = { ...DEFAULT_SETTINGS, language: 'en', cliModel: 'gpt-6-luna' };
  repo.settings = settings; app.scope = { appScope: true }; app.workspace ??= {}; app.workspace.requestSaveLayout ??= () => {};
  const mapDoc = { id: 'map-p', title: 'Present', version: 1, nodes: [], viewport: { x: 5, y: 7, zoom: 1 } };
  await repo.ensureTopicFolders('Agent Workspace/Topics/map-p');
  const ids = {};
  const add = async (key, parent, x, y) => {
    const created = await repo.createNote(TITLES[key], 'gpt-6-luna', mapDoc, MAP, parent ? 'inherited' : 'workspace');
    Object.assign(created, { parentId: parent ? ids[parent] : null, x, y });
    mapDoc.nodes.push(created); ids[key] = created.id;
  };
  await add('root', null, 80, 80); await add('alpha', 'root', 400, 80); await add('beta', 'root', 400, 280); await add('branch', 'root', 400, 480); await add('inner', 'branch', 720, 480);
  mapDoc.nodes.find(n => n.id === ids.branch).collapsed = true;
  await app.vault.create(MAP, core.serializeMap(mapDoc));
  await repo.rebuildDerivedData();
  const notices = [];
  const { VisualAgentMapView } = load('main.ts', { obsidian: { ...obsidian, Modal: dom.makeModal(), Notice: dom.makeNotice(notices), setTooltip() {} } }, { createFragment: dom.createFragment });
  const plugin = withExpansionCoordinator({
    repo, settings, running: new Set(), logs: { appendLog() {} }, rebuildDerivedData: () => repo.rebuildDerivedData(), relevanceGrades: new Map(), expansionBatches: new Map(), pendingSuggestions: new Map(), releaseOutline() {}, closeStaleDetails() {}, setOutlineActive() {}, detailsShown: () => false,
    mutate: async work => { await work(); await view.hydrate(); }
  });
  const view = new VisualAgentMapView({ app }, plugin);
  const doc = { activeElement: null };
  const stage = make('div');
  view.path = MAP; view.map = await repo.readMap(MAP); view.stageEl = stage; view.contentEl = element('div');
  view.contentEl.root = doc; view.contentEl.ownerDocument = doc; view.contentEl.focus = () => { doc.activeElement = view.contentEl; };
  const contains = view.contentEl.contains; view.contentEl.contains = other => contains.call(view.contentEl, other) || other?.nodeId !== undefined;
  view.viewportEl = { clientWidth: 800, clientHeight: 600, getBoundingClientRect: () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 }) };
  view.announcer = element('div');
  view.openDetails = () => {};
  const centred = [];
  view.focusNode = (node, persist) => { centred.push({ id: node.id, persist }); view.map.viewport = { x: view.map.viewport.x + 100, y: view.map.viewport.y, zoom: 2 }; };
  const reload = async () => { view.notes = new Map(await Promise.all(view.map.nodes.map(async n => [n.id, await repo.readNote(n.path)]))); };
  view.hydrate = reload;
  const visible = () => view.map.nodes.filter(n => { for (let p = n.parentId; p;) { const a = view.map.nodes.find(x => x.id === p); if (!a) break; if (a.collapsed) return false; p = a.parentId; } return true; });
  const build = () => {
    view.contentEl.empty(); view.contentEl.createDiv('vam-canvas-overlay');
    view.cardEls.clear(); stage.children = []; view.tabStopId = view.defaultTabStop(view.map.nodes);
    for (const n of visible()) view.renderNode(n);
    for (const [id, card] of view.cardEls) { card.focus = () => { doc.activeElement = card; }; card.contains = other => other === card; card.nodeId = id; }
  };
  let renders = 0;
  view.render = () => { renders++; const restore = view.holdMapSearch(); build(); view.applyPresentationMarks(); restore(); };
  await reload(); build();
  const card = key => view.cardEls.get(ids[key]);
  const spied = [];
  const spyKeys = () => { for (const [id, c] of view.cardEls) { const original = c.handlers.get('keydown'); c.handlers.set('keydown', e => { spied.push({ id, key: e.key }); return original?.(e); }); } };
  spyKeys();
  const press = (key, init = {}, target) => {
    const t = target ?? doc.activeElement ?? view.contentEl;
    const e = { key, target: t, isComposing: false, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...init, defaultPrevented: false, stopped: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; } };
    view.presentationKey(e);
    if (!e.stopped && t.handlers?.get('keydown')) t.handlers.get('keydown')(e);
    return e;
  };
  const settle = async () => { for (let i = 0; i < 20; i++) await dom.tick(); };
  const current = () => view.presentation?.currentId ?? null;
  const spoken = () => view.announcer.text;
  const barText = () => { const bar = view.contentEl.children.flatMap(c => c.children).find(c => c.hasClass('vam-presentation-bar')); return bar; };
  return { repo, app, contents, view, plugin, ids, doc, stage, card, press, settle, centred, build, notices, current, spoken, barText, spied, spyKeys, renders: () => renders, saved: () => repo.readMap(MAP) };
}

test('42: pure helpers: key table, start position, no-wrap stepping and the neighbour that takes a vanished current', () => {
  const m = pm();
  const k = (key, init = {}) => m.classifyPresentationKey({ key, isComposing: false, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...init });
  for (const key of ['ArrowRight', 'ArrowDown', ' ', 'PageDown']) assert.equal(k(key), 'next', key);
  for (const key of ['ArrowLeft', 'ArrowUp', 'PageUp']) assert.equal(k(key), 'prev', key);
  assert.equal(k(' ', { shiftKey: true }), 'prev');
  assert.equal(k('Home'), 'first'); assert.equal(k('End'), 'last'); assert.equal(k('Escape'), 'exit');
  for (const key of ['Delete', 'Backspace', 'Enter', 'F2']) assert.equal(k(key), 'block', key);
  assert.equal(k('Enter', { metaKey: true }), 'block'); assert.equal(k('Enter', { shiftKey: true }), 'block'); assert.equal(k('Enter', { ctrlKey: true }), 'block');
  assert.equal(k('ArrowLeft', { shiftKey: true }), 'block', 'a modified arrow must not fall through to tree navigation');
  assert.equal(k('ArrowRight', { isComposing: true }), null, 'composition is never handled');
  assert.equal(k('a'), null); assert.equal(k('Tab'), null);
  assert.equal(m.startingId(['a', 'b', 'c'], 'b'), 'b'); assert.equal(m.startingId(['a', 'b', 'c'], 'x'), 'a'); assert.equal(m.startingId(['a'], null), 'a'); assert.equal(m.startingId([], null), null);
  assert.deepEqual(plain(m.moveInOrder(['a', 'b'], 'a', 'next')), { kind: 'move', id: 'b', index: 1, total: 2 });
  assert.deepEqual(plain(m.moveInOrder(['a', 'b'], 'b', 'next')), { kind: 'edge', edge: 'last' });
  assert.deepEqual(plain(m.moveInOrder(['a', 'b'], 'a', 'prev')), { kind: 'edge', edge: 'first' });
  assert.deepEqual(plain(m.moveInOrder(['a', 'b', 'c'], 'b', 'first')), { kind: 'move', id: 'a', index: 0, total: 3 });
  assert.deepEqual(plain(m.moveInOrder(['a', 'b', 'c'], 'b', 'last')), { kind: 'move', id: 'c', index: 2, total: 3 });
  assert.equal(m.moveInOrder([], 'a', 'next'), null);
  assert.equal(m.reconcileCurrent(['a', 'b', 'c'], ['a', 'b', 'c'], 'b'), 'b');
  assert.equal(m.reconcileCurrent(['a', 'b', 'c'], ['a', 'c'], 'b'), 'c', 'the following one');
  assert.equal(m.reconcileCurrent(['a', 'b', 'c'], ['a', 'b'], 'c'), 'b', 'else the previous one');
  assert.equal(m.reconcileCurrent(['a', 'b', 'c'], ['x'], 'b'), 'x', 'nothing of the old order left: the first of the new');
  assert.equal(m.reconcileCurrent(['a'], [], 'a'), null);
});

test('42: starting takes the reading order without the folded descendants, begins at the selected topic and speaks it', async () => {
  const h = await harness();
  h.view.selected = h.ids.beta;
  h.view.startPresentation();
  assert.deepEqual(plain(h.view.presentation.order), [h.ids.root, h.ids.alpha, h.ids.beta, h.ids.branch], 'folded branch listed, its descendant not');
  assert.equal(h.current(), h.ids.beta);
  assert.equal(h.spoken(), 'Presentation 3/4: 市場分析');
  assert.equal(h.view.contentEl.dataset.presenting, 'true');
  assert.ok(h.card('beta').classes.has('is-presenting'));
  assert.ok(!h.card('alpha').classes.has('is-presenting'));
  assert.equal(h.doc.activeElement, h.card('beta'), 'the current card has DOM focus');
  assert.deepEqual(h.centred.at(-1), { id: h.ids.beta, persist: false });
  const bar = h.barText();
  assert.ok(bar, 'a visible bar');
  assert.equal(bar.children.find(c => c.hasClass('vam-presentation-count')).text, '3/4');
  const exit = bar.children.find(c => c.tag === 'button');
  assert.ok(exit.text.includes('Esc'), 'the visible exit button names its key');
});

test('42: without a selection it starts at the first topic; selection mode and an empty map refuse', async () => {
  const h = await harness();
  h.view.selected = null; h.view.startPresentation();
  assert.equal(h.current(), h.ids.root);
  h.view.exitPresentation(); assert.equal(h.view.presentation, null);
  h.view.integrationMode = true;
  assert.equal(h.view.canPresent(), false); h.view.startPresentation();
  assert.equal(h.view.presentation, null, 'not while selecting topics');
  h.view.integrationMode = false;
  assert.equal(h.view.canPresent(), true);
  h.view.map.nodes = []; assert.equal(h.view.canPresent(), false); h.view.startPresentation();
  assert.equal(h.view.presentation, null, 'not on an empty map');
});

test('42: next / previous keys move one topic, are taken from the cards and speak the position', async () => {
  const h = await harness();
  h.view.selected = null; h.view.startPresentation();
  for (const [key, init, expect] of [['ArrowRight', {}, 'alpha'], ['ArrowDown', {}, 'beta'], [' ', {}, 'branch'], ['ArrowLeft', {}, 'beta'], ['ArrowUp', {}, 'alpha'], [' ', { shiftKey: true }, 'root'], ['PageDown', {}, 'alpha'], ['PageUp', {}, 'root']]) {
    const e = h.press(key, init);
    assert.equal(h.current(), h.ids[expect], `${key}`);
    assert.equal(e.defaultPrevented && e.stopped, true, `${key} is taken`);
    assert.equal(h.doc.activeElement, h.card(expect));
  }
  h.press('End'); assert.equal(h.current(), h.ids.branch); assert.equal(h.spoken(), 'Presentation 4/4: Branch');
  h.press('Home'); assert.equal(h.current(), h.ids.root);
  assert.deepEqual(h.spied, [], 'no card key handler ran: ArrowLeft never walked to a parent card');
  assert.equal(h.view.selected, null, 'the selection is untouched');
});

test('42: at either end the position stays and the end is spoken; nothing wraps', async () => {
  const h = await harness();
  h.view.selected = null; h.view.startPresentation();
  h.press('ArrowLeft'); assert.equal(h.current(), h.ids.root); assert.equal(h.spoken(), 'Already the first topic');
  h.press('End'); h.press(' '); assert.equal(h.current(), h.ids.branch); assert.equal(h.spoken(), 'Already the last topic');
  h.press('ArrowRight'); assert.equal(h.current(), h.ids.branch);
});

test('42: a folded branch is presented as itself, never its descendants', async () => {
  const h = await harness();
  h.view.selected = null; h.view.startPresentation();
  assert.ok(!h.view.presentation.order.includes(h.ids.inner));
  h.press('End'); h.press(' ');
  assert.equal(h.current(), h.ids.branch);
  assert.equal(h.view.map.nodes.find(n => n.id === h.ids.branch).collapsed, true, 'the fold is not opened');
});

test('42: Delete, Backspace, Enter, F2, Mod+Enter and Shift+Enter do nothing during a presentation; they work again afterwards', async () => {
  const h = await harness();
  h.view.selected = null; h.view.startPresentation();
  const notes = h.view.map.nodes.length, history = h.view.history.past.length, files = [...h.contents.keys()].join('|');
  for (const [key, init] of [['Delete', {}], ['Backspace', {}], ['Enter', {}], ['F2', {}], ['Enter', { metaKey: true }], ['Enter', { ctrlKey: true }], ['Enter', { shiftKey: true }]]) {
    const e = h.press(key, init, h.card('alpha'));
    assert.equal(e.defaultPrevented && e.stopped, true, `${key} swallowed`);
  }
  await h.settle();
  assert.deepEqual(h.spied, [], 'the card never saw them');
  assert.equal(h.view.map.nodes.length, notes); assert.equal(h.view.history.past.length, history); assert.equal([...h.contents.keys()].join('|'), files);
  h.press('Escape');
  h.press('Enter', {}, h.card('alpha'));
  assert.deepEqual(h.spied.map(s => s.key), ['Enter'], 'outside the presentation the card handler runs again');
});

test('42: keys in a text field or the chat are left alone; composition is ignored', async () => {
  const h = await harness();
  h.view.selected = null; h.view.startPresentation();
  const input = element('input'); input.closest = selector => (selector.includes('input') ? input : null);
  const e = h.press('ArrowRight', {}, input); assert.equal(e.stopped, false); assert.equal(h.current(), h.ids.root);
  const chat = element('div'); chat.closest = selector => (selector.includes('.vam-map-chat') ? chat : null);
  assert.equal(h.press(' ', {}, chat).stopped, false);
  assert.equal(h.press('ArrowRight', { isComposing: true }).stopped, false);
  assert.equal(h.current(), h.ids.root);
  const exitButton = element('button'); exitButton.closest = selector => (selector.includes('vam-presentation-bar') ? exitButton : null);
  assert.equal(h.press('Enter', {}, exitButton).stopped, false, 'Enter on the exit button still clicks it');
  assert.equal(h.press('Escape', {}, exitButton).defaultPrevented, true, 'Esc exits from the bar too');
  assert.equal(h.view.presentation, null);
});

test('42: Mod+Z, Mod+Shift+Z, F2, Mod+Enter, Shift+Enter and Mod+F on the view scope are swallowed while presenting', async () => {
  const h = await harness();
  let travelled = 0, renamed = 0;
  h.view.travel = async () => { travelled++; }; h.view.renameNode = () => { renamed++; };
  const scopeKey = (key, mods) => h.view.scope.keys.find(k => k.key === key && k.modifiers.length === mods.length && mods.every(m => k.modifiers.includes(m)));
  const fire = (key, mods) => scopeKey(key, mods).func({ key, isComposing: false, defaultPrevented: false, target: element('div') }, {});
  h.view.selected = null; h.doc.activeElement = h.card('alpha');
  assert.equal(fire('z', ['Mod']), false); await h.settle(); assert.equal(travelled, 1, 'outside a presentation undo runs');
  h.view.startPresentation();
  assert.equal(fire('z', ['Mod']), false); assert.equal(fire('z', ['Mod', 'Shift']), false); assert.equal(fire('Z', ['Mod', 'Shift']), false); await h.settle();
  assert.equal(travelled, 1, 'no undo or redo while presenting, yet the key is swallowed');
  for (const [key, mods] of [['F2', []], ['Enter', ['Mod']], ['Enter', ['Shift']], ['f', ['Mod']]]) assert.equal(fire(key, mods), false, `${key} swallowed`);
  assert.equal(renamed, 0); assert.equal(h.view.mapSearch, null, 'Mod+F opens no search box');
  h.view.exitPresentation();
  h.doc.activeElement = h.card('alpha');
  assert.equal(fire('F2', []), false); assert.equal(renamed, 1, 'after leaving F2 renames again');
});

test('42: a render that removes the current topic moves to the neighbour instead of throwing; an emptied map ends the presentation', async () => {
  const h = await harness();
  h.view.selected = h.ids.beta; h.view.startPresentation();
  h.view.map.nodes = h.view.map.nodes.filter(n => n.id !== h.ids.beta);
  assert.doesNotThrow(() => h.view.render());
  assert.equal(h.current(), h.ids.branch, 'the following topic');
  assert.deepEqual(plain(h.view.presentation.order), [h.ids.root, h.ids.alpha, h.ids.branch]);
  assert.ok(h.card('branch').classes.has('is-presenting'));
  assert.equal(h.spoken(), 'Presentation 3/3: Branch');
  h.view.render();
  assert.equal(h.current(), h.ids.branch, 'a plain render keeps the place');
  assert.equal(h.view.contentEl.dataset.presenting, 'true');
  h.view.map.nodes = [];
  assert.doesNotThrow(() => h.view.render());
  assert.equal(h.view.presentation, null);
  assert.equal(h.view.contentEl.dataset.presenting, undefined);
});

test('42: leaving restores viewport, selection and focus in memory only; Map.md is byte-identical', async () => {
  const h = await harness();
  const diskBefore = h.contents.get(MAP);
  const before = JSON.parse(JSON.stringify(h.view.map.viewport));
  h.view.selected = h.ids.alpha; h.view.multiSelected = new Set([h.ids.beta]);
  h.doc.activeElement = h.card('alpha');
  h.view.startPresentation();
  h.press('End');
  assert.notDeepEqual(h.view.map.viewport, before, 'the camera moved during the presentation');
  h.view.selected = h.ids.root; h.view.multiSelected = new Set(); // a click during the presentation
  const e = h.press('Escape');
  assert.equal(e.defaultPrevented && e.stopped, true);
  assert.deepEqual(plain(h.view.map.viewport), before, 'same viewport as on entry');
  assert.equal(h.view.selected, h.ids.alpha); assert.deepEqual(plain([...h.view.multiSelected]), [h.ids.beta]);
  assert.equal(h.doc.activeElement, h.card('alpha'), 'focus back on the original card');
  assert.equal(h.spoken(), 'Left the presentation');
  assert.equal(h.view.presentation, null);
  assert.equal(h.view.contentEl.dataset.presenting, undefined); assert.equal(h.stage.dataset.presenting, undefined);
  assert.ok(!h.card('beta').classes.has('is-presenting') && !h.card('alpha').classes.has('is-presenting'));
  await h.settle(); h.view.viewportTimer = h.view.viewportTimer;
  assert.equal(h.contents.get(MAP), diskBefore, 'Map.md untouched');
  assert.equal(h.centred.every(c => c.persist === false), true, 'every centring was in memory');
});

test('42: leaving after the original focus target is gone puts focus on the map pane; a selected card removed meanwhile is dropped', async () => {
  const h = await harness();
  h.view.selected = h.ids.beta; h.doc.activeElement = h.card('beta');
  h.view.startPresentation();
  h.view.map.nodes = h.view.map.nodes.filter(n => n.id !== h.ids.beta);
  h.view.render();
  h.press('Escape');
  assert.equal(h.view.selected, null, 'a topic that no longer exists is not reselected');
  assert.equal(h.doc.activeElement, h.view.contentEl);
});

test('42: a focus origin outside the cards comes back if it still exists', async () => {
  const h = await harness();
  const outside = element('button'); outside.isConnected = true; outside.focus = () => { h.doc.activeElement = outside; };
  h.view.contentEl.contains = other => other === outside || other?.nodeId !== undefined;
  h.doc.activeElement = outside;
  h.view.startPresentation();
  h.press('Escape');
  assert.equal(h.doc.activeElement, outside);
});

test('42: switching maps or closing the view ends the presentation without restoring anything', async () => {
  const h = await harness();
  h.view.startPresentation(); h.press('End');
  const moved = JSON.parse(JSON.stringify(h.view.map.viewport));
  await h.view.openMap('Agent Workspace/Topics/other/Map.md').catch(() => {});
  assert.equal(h.view.presentation, null, 'another map: ended');
  assert.equal(h.view.contentEl.dataset.presenting, undefined);
  assert.notDeepEqual(h.view.map?.viewport, undefined);
  void moved;
  const g = await harness();
  g.view.startPresentation();
  const viewport = JSON.parse(JSON.stringify(g.view.map.viewport));
  await g.view.onClose();
  assert.equal(g.view.presentation, null, 'closing: ended');
  assert.deepEqual(plain(g.view.map.viewport), viewport, 'no restore on close');
  g.view.applyPresentationMarks();
  assert.equal(g.view.contentEl.dataset.presenting, undefined, 'a late render does not revive it');
});

test('42: the same map reopened (refresh) keeps the presentation; the sample map is a different map', async () => {
  const h = await harness();
  h.view.startPresentation();
  await h.view.openMap(MAP).catch(() => {});
  assert.notEqual(h.view.presentation, null, 'same path: kept');
  h.view.openBuiltInSample?.call(h.view);
  await h.settle();
  assert.equal(h.view.presentation, null, 'the sample replaces the map: ended');
});

test('42: the order follows the layout direction: vertical layouts sort siblings by x', async () => {
  const h = await harness();
  const nodes = h.view.map.nodes;
  Object.assign(nodes.find(n => n.id === h.ids.alpha), { x: 600, y: 300 }); Object.assign(nodes.find(n => n.id === h.ids.beta), { x: 200, y: 400 });
  h.view.selected = null; h.view.startPresentation();
  const order = () => plain(h.view.presentation.order);
  assert.ok(order().indexOf(h.ids.alpha) < order().indexOf(h.ids.beta), 'right layout: by y');
  h.view.exitPresentation();
  h.view.map.layout = { ...(h.view.map.layout ?? {}), direction: 'down' };
  h.view.startPresentation();
  assert.ok(order().indexOf(h.ids.beta) < order().indexOf(h.ids.alpha), 'down layout: by x');
});

test('42: wiring in view.ts: capture keydown, toolbar button, hover guard, paint order, stale fences; renderNode is untouched', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'experiences', 'visual-map', 'view.ts'), 'utf8');
  const open = source.slice(source.indexOf('async onOpen()'), source.indexOf('private installUndoScope'));
  assert.match(open, /registerDomEvent\(\s*this\.contentEl,\s*"keydown",\s*event => this\.presentationKey\(event\),\s*\{\s*capture: true\s*\}/);
  const paint = source.slice(source.indexOf('private paint(): void'), source.indexOf('/** What the empty canvas says'));
  assert.match(paint, /this\.applyPresentationMarks\(\);\s*restoreSearch\(\);/);
  assert.match(paint, /disabled = !this\.canPresent\(\)/);
  assert.match(paint, /"presentation", t\("ui\.presentation_start"\)/);
  const hover = source.slice(source.indexOf('private showHoverCard('), source.indexOf('private showHoverCard(') + 300);
  assert.match(hover, /if \(this\.presentation\) return;/);
  assert.match(source.slice(source.indexOf('async onClose()'), source.indexOf('async onClose()') + 200), /exitPresentation\(false\)/);
  assert.match(source.slice(source.indexOf('private async openMapInMutation'), source.indexOf('private async openMapInMutation') + 800), /exitPresentation\(false\)/);
  const renderNode = source.slice(source.indexOf('private renderNode('), source.indexOf('private renderNode(') + 4000);
  assert.equal(/presenting|presentation/i.test(renderNode), false, 'renderNode knows nothing about the presentation');
});

test('42: the new CSS stays out of the share viewer (every rule starts with .vam-view) and dims the other cards to 0.35', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
  const block = css.slice(css.indexOf('/* Presentation mode'));
  assert.ok(block.length > 20, 'the block exists');
  const rules = block.split('\n').filter(l => l.trim() && !l.startsWith('/*'));
  assert.ok(rules.length >= 4);
  for (const rule of rules) assert.ok(rule.startsWith('.vam-view '), rule);
  assert.match(block, /\[data-presenting\] \.vam-node \{[^}]*opacity: 0\.35/);
  assert.match(block, /\.vam-node\.is-presenting \{[^}]*opacity: 1/);
});
