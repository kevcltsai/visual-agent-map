// UI batch 4 fixes (F-1 timeline details, F-2 branch layout buttons, F-4 cut marks in other windows).
// Each case was run against the unfixed code first and failed there; the handoff records how.
// F-3 (a cross-map undo after an outside change of coordinates) is not here: see handoff-batch4-fixes.md section 2.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, core, fixture, DEFAULT_SETTINGS, obsidian, withExpansionCoordinator, until } = require('./support.cjs');
const support = require('./support.cjs');
const dom = require('./support-dom.cjs');
const nodePath = require('node:path');
const vm = require('node:vm');
const { buildSync } = require('./build.cjs');
const { element, tick } = dom;
const plainJson = value => JSON.parse(JSON.stringify(value));

// ---- helpers: a view over a fake vault (layout) and a view with a cut session (clipboard) ----
const LMAP = 'Agent Workspace/Topics/map-pv1/Map.md';

/** `spec` is [title, parentTitle|null, x, y] per node; `extra` is merged into the map before it is saved. */
async function layoutHarness(spec, extra = {}, layouts = {}) {
  const { repo, app } = support.fixture('en', { linkIndex: true });
  const settings = { ...support.DEFAULT_SETTINGS, language: 'en', cliModel: 'gpt-6-luna' };
  repo.settings = settings;
  const mapDoc = { id: 'map-pv1', title: 'PV1', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  await repo.ensureTopicFolders('Agent Workspace/Topics/map-pv1');
  const byTitle = new Map();
  for (const [title, parentTitle, x, y] of spec) {
    const created = await repo.createNote(title, 'gpt-6-luna', mapDoc, LMAP, 'workspace');
    Object.assign(created, { parentId: parentTitle ? byTitle.get(parentTitle).id : null, x, y });
    if (layouts[title]) created.layout = layouts[title];
    byTitle.set(title, created);
    mapDoc.nodes.push(created);
  }
  Object.assign(mapDoc, extra);
  await app.vault.create(LMAP, support.core.serializeMap(mapDoc));
  await repo.rebuildDerivedData();
  const menus = [];
  class Menu {
    constructor() { this.items = []; menus.push(this); }
    addItem(callback) { const item = { checked: undefined, setTitle(value) { this.title = value; return this; }, setIcon(value) { this.icon = value; return this; }, setChecked(value) { this.checked = value; return this; }, onClick(handler) { this.click = handler; return this; } }; callback(item); this.items.push(item); return this; }
    addSeparator() { this.items.push({ separator: true }); return this; }
    showAtMouseEvent() { return this; }
  }
  const Base = dom.makeModal();
  class Modal extends Base { open() { super.open(); this.close(); } }
  const createSvg = tag => ({ tag, attrs: {}, classes: [], children: [], setAttribute(n, v) { this.attrs[n] = v; }, getAttribute(n) { return this.attrs[n]; }, addClass(n) { this.classes.push(n); }, appendChild(c) { this.children.push(c); } });
  const { VisualAgentMapView } = support.load('main.ts', { obsidian: { ...support.obsidian, Modal, Menu, Notice: dom.makeNotice([]) } }, { createFragment: dom.createFragment, createSvg, requestAnimationFrame: () => 1, cancelAnimationFrame() {} });
  let pending = Promise.resolve();
  const plugin = support.withExpansionCoordinator({
    repo, settings, running: new Set(), logs: { appendLog() {} }, rebuildDerivedData: () => repo.rebuildDerivedData(), relevanceGrades: new Map(), expansionBatches: new Map(), pendingSuggestions: new Map(), releaseOutline() {}, setOutlineActive() {}, detailsShown: () => false,
    mutate: work => (pending = Promise.resolve().then(work))
  });
  const view = new VisualAgentMapView({ app }, plugin);
  view.path = LMAP; view.map = await repo.readMap(LMAP); view.contentEl = dom.element('div'); view.stageEl = dom.element('div');
  let fits = 0;
  view.focusNode = () => {}; view.openDetails = () => {}; view.render = () => {}; view.fit = () => { fits++; };
  view.hydrate = async () => { view.notes = new Map(await Promise.all(view.map.nodes.map(async n => [n.id, await repo.readNote(n.path)]))); };
  await view.hydrate();
  view.cardHeightOf = () => 180;
  const named = title => view.map.nodes.find(n => view.notes.get(n.id)?.title === title);
  const menuTitles = () => menus.at(-1).items.map(item => (item.separator ? '---' : item.title));
  const choose = async title => { view.openLayoutMenu({}); menus.at(-1).items.find(item => item.title === title).click(); await pending; await pending; };
  return { repo, view, named, menus, menuTitles, choose, settled: () => pending, fits: () => fits, saved: () => repo.readMap(LMAP), createSvg };
}
const edgeHost = () => ({ children: [], replaceChildren() { this.children = []; }, appendChild(child) { this.children.push(child); } });
const box = (x, y, width = 300, height = 180) => ({ offsetLeft: x, offsetTop: y, offsetWidth: width, offsetHeight: height });

// One bundle that holds the view, the session and the ledger, so the test reads the same module state the view uses
// (a separate load of that module would get its own, empty WeakMap: a check on it would always see "no cut"). Same sandbox as support.cjs's load().
function loadWithState(overrides, windowValues) {
  const root = nodePath.resolve(__dirname, '..');
  const contents = "export * from './main'; export { sessionFor } from './experiences/visual-map/clipboard-session';";
  const code = buildSync({ stdin: { contents, resolveDir: root, loader: 'ts', sourcefile: 'cut-entry.ts' }, external: ['obsidian', 'node:*'] }).outputFiles[0].text;
  const module = { exports: {} };
  const ob = { Component: class {}, MarkdownRenderChild: class {}, ...overrides.obsidian };
  vm.runInNewContext(code, { module, exports: module.exports, require: name => (name === 'obsidian' ? ob : require(name)), console, TextDecoder, TextEncoder, Blob, crypto: require('node:crypto').webcrypto, process, AbortController, document: windowValues.document, createSvg: windowValues.createSvg,
    Option: class { constructor(text, value) { this.tag = 'option'; this.text = text; this.value = value; this.cls = ''; this.children = []; this.attrs = {}; } }, HTMLInputElement: class {}, HTMLTextAreaElement: class {}, HTMLSelectElement: class {}, window: { setTimeout, clearTimeout, ...windowValues } });
  return module.exports;
}

const MAP = 'Agent Workspace/Topics/map-p/Map.md';
const MIME = 'application/x-vam-branch';

// A DOM stand-in just big enough for the view: cards are plain objects, the content element knows its own.
const make = (tag, init = {}) => ({ tag, children: [], dataset: {}, style: {}, attrs: {}, handlers: new Map(), classes: new Set(String(init.cls ?? '').split(' ').filter(Boolean)), text: init.text, tabIndex: init.tabIndex, checked: false, focused: 0, isConnected: true,
  createDiv(value) { return this.createEl('div', typeof value === 'string' ? { cls: value } : value); },
  createSpan(value) { return this.createEl('span', typeof value === 'string' ? { cls: value } : value); },
  createEl(name, value = {}) { const child = make(name, value); child.parent = this; this.children.push(child); return child; },
  setAttr(name, value) { this.attrs[name] = value; }, addClass(...names) { names.forEach(name => this.classes.add(name)); }, removeClass(name) { this.classes.delete(name); },
  toggleClass(name, on) { if (on) this.classes.add(name); else this.classes.delete(name); }, addEventListener(name, handler) { this.handlers.set(name, handler); }, removeEventListener() {},
  setPointerCapture() {}, focus() { this.focused++; }, remove() { this.removed = true; }, getBoundingClientRect() { return { left: 0, right: 10, top: 0, bottom: 10 }; },
  querySelector() { return null; }, querySelectorAll() { return []; }, replaceWith() {} });

async function clipHarness({ aim = false } = {}) {
  const { repo, app, contents } = fixture('en');
  const settings = { ...DEFAULT_SETTINGS, language: 'en', cliModel: 'gpt-6-luna' };
  repo.settings = settings; app.scope = { appScope: true };
  const mapDoc = { id: 'map-p', title: 'Paste', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  await repo.ensureTopicFolders('Agent Workspace/Topics/map-p');
  const ids = {};
  const add = async (key, title, parent, initial = {}) => {
    const created = await repo.createNote(title, 'gpt-6-luna', mapDoc, MAP, parent ? 'inherited' : 'workspace', initial);
    Object.assign(created, { parentId: parent ? ids[parent] : null, x: parent ? 400 : 80, y: 80 + mapDoc.nodes.length * 200 });
    mapDoc.nodes.push(created); ids[key] = created.id;
  };
  await add('root', 'Root'); await add('leaf', 'Leaf', 'root', { detail: 'Leaf detail text' }); await add('branch', 'Branch', 'root'); await add('kid', 'Kid', 'branch');
  await add('other', 'Other');
  if (aim) mapDoc.aim = { version: 1 };
  await app.vault.create(MAP, core.serializeMap(mapDoc));
  await repo.rebuildDerivedData();
  const notices = [];
  const Notice = dom.makeNotice(notices);
  const bundle = loadWithState({ obsidian: { ...obsidian, Notice, Modal: dom.makeModal(), setTooltip() {} } }, { createFragment: dom.createFragment });
  const { VisualAgentMapView } = bundle;
  const plugin = withExpansionCoordinator({
    repo, settings, running: new Set(), logs: { appendLog() {} }, rebuildDerivedData: () => repo.rebuildDerivedData(), relevanceGrades: new Map(), expansionBatches: new Map(), pendingSuggestions: new Map(), releaseOutline() {}, setOutlineActive() {}, detailsShown: () => false,
    mutate: async work => { await work(); await view.hydrate(); }
  });
  const view = new VisualAgentMapView({ app }, plugin);
  const stage = make('div');
  // The "inside" flag stands for Element.contains: a card, the content element itself, or a control inside the view.
  const content = element('div');
  content.contains = node => !!node?.inside;
  view.path = MAP; view.map = await repo.readMap(MAP); view.stageEl = stage; view.contentEl = content;
  view.focusNode = () => {}; view.openDetails = () => {};
  view.hydrate = async () => { view.notes = new Map(await Promise.all(view.map.nodes.map(async n => [n.id, await repo.readNote(n.path)]))); };
  view.render = () => { view.cardEls.clear(); stage.children = []; view.tabStopId = view.defaultTabStop(view.map.nodes); for (const n of view.map.nodes) view.renderNode(n); };
  await view.hydrate(); view.render();
  return { repo, app, contents, view, plugin, sessionFor: bundle.sessionFor, ids, notices, map: () => view.map, saved: () => repo.readMap(MAP), notes: () => view.notes, history: () => view.history.past.length };
}

const card = { inside: true, closest: () => null };
const textControl = { inside: true, closest: selector => (selector.includes('textarea') ? textControl : null) };
const chatPanel = { inside: true, closest: selector => (selector.includes('.vam-map-chat') ? chatPanel : null) };
const body = { inside: false, closest: () => null };
const clipboardEvent = (target, data = {}) => {
  const store = new Map(Object.entries(data));
  const event = { target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; },
    clipboardData: { getData: type => store.get(type) ?? '', setData: (type, value) => store.set(type, value), store } };
  return event;
};
const copyOf = (h, ids, target = card) => {
  h.view.selected = null; h.view.multiSelected.clear();
  if (ids.length === 1) h.view.selected = h.ids[ids[0]]; else for (const key of ids) h.view.multiSelected.add(h.ids[key]);
  const event = clipboardEvent(target);
  h.view.onClipboardEvent('copy', event);
  h.lastRaw = event.clipboardData.store.get(MIME);
  return event;
};
const pasteOf = (h, data, target = card) => { const event = clipboardEvent(target, data); h.view.onClipboardEvent('paste', event); return event; };
const clipboardModule = load('experiences/visual-map/clipboard.ts', { obsidian });
const parse = text => JSON.parse(JSON.stringify(clipboardModule.parseClipboard(text)));
const files = h => [...h.contents.keys()].filter(p => p.endsWith('.md')).sort();
const cutOf = (h, ids, target = card) => {
  h.view.selected = null; h.view.multiSelected.clear();
  if (ids.length === 1) h.view.selected = h.ids[ids[0]]; else for (const key of ids) h.view.multiSelected.add(h.ids[key]);
  const event = clipboardEvent(target);
  h.view.onClipboardEvent('cut', event);
  h.lastRaw = event.clipboardData.store.get(MIME);
  return event;
};

// ---- F-1: the edges of a timeline map ----
const geometry = load('experiences/visual-map/relation-geometry.ts');
const rect = (x, y, width = 300, height = 180) => ({ x, y, width, height });

test('F-1 timeline: a detail below its topic leaves the topic\'s bottom edge midpoint and enters the detail\'s top edge midpoint, as "down" does', () => {
  const topic = rect(1000, 0), detail = rect(1040, 300);
  assert.equal(geometry.treeEdgePathData(topic, detail, 'timeline', 2), geometry.treeEdgePathData(topic, detail, 'down'));
  assert.equal(geometry.treeEdgePathData(topic, detail, 'timeline', 2), 'M 1150 180 C 1150 240, 1190 240, 1190 300');
  assert.equal(geometry.treeEdgePathData(detail, rect(1080, 600), 'timeline', 3), geometry.treeEdgePathData(detail, rect(1080, 600), 'down'), 'deeper levels too');
});

test('F-1 timeline: a detail above its topic leaves the top edge midpoint and enters the detail\'s bottom edge midpoint, as "up" does', () => {
  const topic = rect(1000, 0), detail = rect(1040, -300);
  assert.equal(geometry.treeEdgePathData(topic, detail, 'timeline', 2), geometry.treeEdgePathData(topic, detail, 'up'));
  assert.equal(geometry.treeEdgePathData(topic, detail, 'timeline', 2), 'M 1150 0 C 1150 -60, 1190 -60, 1190 -120');
});

test('F-1 counter-example: the first level of a timeline stays on the axis (right-edge curve), and no other arrangement changed', () => {
  const root = rect(80, 0), topic = rect(440, 0), far = rect(800, 40);
  for (const child of [topic, far]) {
    assert.equal(geometry.treeEdgePathData(root, child, 'timeline', 1), geometry.treeEdgePathData(root, child, 'right'));
    assert.equal(geometry.treeEdgePathData(root, child, 'timeline'), geometry.treeEdgePathData(root, child, 'right'), 'the default depth is the first level');
  }
  const a = rect(1000, 0), below = rect(1040, 300);
  assert.equal(geometry.treeEdgePathData(a, below, 'right', 2), 'M 1300 90 C 1430 90, 910 390, 1040 390', 'right still draws side to side at depth 2');
  assert.equal(geometry.treeEdgePathData(a, below, 'left', 2), 'M 1000 90 C 830 90, 1510 390, 1340 390', 'and so does left');
});

test('F-1 timeline in the view: the drawn edges and the edges re-drawn while dragging a detail follow the same geometry', async () => {
  const h = await layoutHarness([['Root', null, 80, 0], ['T1', 'Root', 440, 0], ['T1a', 'T1', 440, 300], ['T2', 'Root', 800, 0], ['T2a', 'T2', 800, -300]], { layout: { direction: 'timeline' } });
  h.view.edgesEl = edgeHost(); h.view.relationsLayerEl = edgeHost();
  const place = { Root: box(80, 0), T1: box(440, 0), T1a: box(440, 300), T2: box(800, 0), T2a: box(800, -300) };
  for (const [title, el] of Object.entries(place)) h.view.cardEls.set(h.named(title).id, el);
  h.view.drawEdges();
  const d = (p, c) => h.view.edgeEls.get(`${h.named(p).id}\u0000${h.named(c).id}`).attrs.d;
  const r = el => ({ x: el.offsetLeft, y: el.offsetTop, width: el.offsetWidth, height: el.offsetHeight });
  assert.equal(d('Root', 'T1'), geometry.treeEdgePathData(r(place.Root), r(place.T1), 'right'), 'first level: along the axis');
  assert.equal(d('T1', 'T1a'), geometry.treeEdgePathData(r(place.T1), r(place.T1a), 'down'), 'detail below');
  assert.equal(d('T2', 'T2a'), geometry.treeEdgePathData(r(place.T2), r(place.T2a), 'up'), 'detail above');
  const drag = h.view.dragEdges(h.named('T1a').id, { offsetWidth: 300, offsetHeight: 180 });
  drag.update(500, 340);
  assert.equal(d('T1', 'T1a'), geometry.treeEdgePathData(r(place.T1), rect(500, 340), 'down'), 'dragging keeps the down geometry');
});

// ---- F-2: the branch layout buttons repaint at once ----
const FOLLOW = 'Follow the map';
const tree4 = [['Root', null, 1000, 80], ['A', 'Root', 1360, 0], ['B', 'Root', 1360, 300], ['A1', 'A', 1720, 0]];
const branchPanel = (h, title) => {
  const panel = dom.element('panel');
  h.view.renderBranchLayoutSection(panel, h.named(title));
  const group = dom.find(panel, item => (item.cls ?? '').includes('vam-branch-layout'));
  const read = () => dom.findAll(group, item => item.tag === 'button');
  return { read, state: () => read().map(b => [b.text, b.attrs['aria-pressed'], b.classes.includes('is-pressed')]), press: async label => { read().find(b => b.text === label).click(); await h.settled(); await h.settled(); } };
};

test('F-2 pressing an option updates aria-pressed, the selected class and the option list on the same panel, without reopening it', async () => {
  const h = await layoutHarness(tree4);
  const panel = branchPanel(h, 'A');
  assert.deepEqual(panel.state().filter(s => s[1] === 'true').map(s => s[0]), [FOLLOW]);
  await panel.press('Lay out downward');
  assert.deepEqual(panel.state().filter(s => s[1] === 'true').map(s => s[0]), ['Lay out downward'], 'only the new value is pressed');
  assert.deepEqual(panel.state().filter(s => s[2]).map(s => s[0]), ['Lay out downward'], 'and carries the selected class');
  assert.deepEqual(panel.state().map(s => s[0]), [FOLLOW, 'Lay out to the right', 'Lay out downward', 'Lay out upward'], 'the list is re-read: the parent is a right map, so the choices stay');
  await panel.press(FOLLOW);
  assert.deepEqual(panel.state().filter(s => s[1] === 'true').map(s => s[0]), [FOLLOW]);
  assert.deepEqual(panel.state().map(s => s[0]), [FOLLOW, 'Lay out to the right', 'Lay out downward', 'Lay out upward']);
});

test('F-2 counter-example: pressing the option that is already selected adds no history step', async () => {
  const h = await layoutHarness(tree4);
  const panel = branchPanel(h, 'A');
  await panel.press('Lay out downward');
  const writes = h.view.history.past.length;
  await panel.press('Lay out downward');
  assert.equal(h.view.history.past.length, writes);
  assert.deepEqual(panel.state().filter(s => s[1] === 'true').map(s => s[0]), ['Lay out downward']);
  await panel.press(FOLLOW); await panel.press(FOLLOW);
  assert.equal(h.view.history.past.length, writes + 1, 'only the real change counted');
});

// ---- F-4: a cut mark clears in every window ----

const asCut = (el) => el.classes.has('is-cut');
const cutMarked = view => [...view.cardEls.entries()].filter(([, el]) => asCut(el)).map(([id]) => id).sort();
const labelsOf = view => [...view.cardEls.values()].filter(el => String(el.attrs['aria-labelledby'] ?? '').includes(' ')).length;
/** A second view of the same map, as a popout window would show it, listed by the workspace like any other leaf. */
async function popoutOf(h) {
  const other = new h.view.constructor({ app: h.app }, h.plugin);
  const stage = make('div'), content = element('div');
  content.contains = node => !!node?.inside;
  other.path = MAP; other.map = await h.repo.readMap(MAP); other.stageEl = stage; other.contentEl = content;
  other.focusNode = () => {}; other.openDetails = () => {};
  other.hydrate = async () => { other.notes = new Map(await Promise.all(other.map.nodes.map(async n => [n.id, await h.repo.readNote(n.path)]))); };
  other.render = () => { other.cardEls.clear(); stage.children = []; other.tabStopId = other.defaultTabStop(other.map.nodes); for (const n of other.map.nodes) other.renderNode(n); };
  await other.hydrate(); other.render();
  h.app.workspace = { getLeavesOfType: () => [{ view: h.view }, { view: other }] };
  return other;
}
const cutIn = (h, view, key) => {
  view.selected = h.ids[key]; view.multiSelected.clear();
  const event = clipboardEvent(card);
  view.onClipboardEvent('cut', event);
  return event.clipboardData.store.get(MIME);
};

test('F-4 a cut made in a popout window is cleared there when another view copies', async () => {
  const h = await clipHarness();
  const pop = await popoutOf(h);
  cutIn(h, pop, 'branch');
  assert.deepEqual(cutMarked(pop), [h.ids.branch, h.ids.kid].sort(), 'the popout shows the cut');
  assert.equal(h.sessionFor(h.plugin).get()?.mode, 'cut');
  h.view.selected = h.ids.leaf; h.view.multiSelected.clear();
  h.view.onClipboardEvent('copy', clipboardEvent(card));
  assert.equal(h.sessionFor(h.plugin).get()?.mode, 'copy', 'the copy replaced the cut');
  assert.deepEqual(cutMarked(pop), [], 'no is-cut left in the popout');
  assert.equal(labelsOf(pop), 0, 'and no "Cut" part in the accessible name');
  assert.deepEqual(cutMarked(h.view), []);
  assert.deepEqual(pop.cardEls.get(h.ids.branch).attrs['aria-labelledby'].split(' ').length, 1);
});

test('F-4 a cut shows in every window that shows the map, and goes away everywhere when the paste mismatches', async () => {
  const h = await clipHarness();
  const pop = await popoutOf(h);
  cutIn(h, h.view, 'branch');
  assert.deepEqual(cutMarked(h.view), [h.ids.branch, h.ids.kid].sort());
  assert.deepEqual(cutMarked(pop), [h.ids.branch, h.ids.kid].sort(), 'the other window shows it too');
  pop.selected = h.ids.other; pop.multiSelected.clear();
  const foreign = clipboardEvent(card, { 'text/plain': 'something else' });
  pop.onClipboardEvent('paste', foreign);
  await tick(); await tick();
  assert.deepEqual(cutMarked(h.view), []); assert.deepEqual(cutMarked(pop), []);
});

test('F-4 counter-example: with no cut pending a copy leaves the other windows alone, and a valid cut keeps its mark through a matching paste check', async () => {
  const h = await clipHarness();
  const pop = await popoutOf(h);
  h.view.selected = h.ids.leaf; h.view.multiSelected.clear();
  assert.doesNotThrow(() => h.view.onClipboardEvent('copy', clipboardEvent(card)));
  assert.deepEqual(cutMarked(pop), []);
  const raw = cutIn(h, h.view, 'branch');
  assert.deepEqual(cutMarked(pop), [h.ids.branch, h.ids.kid].sort());
  // A paste of the exact string into a topic of this very branch is refused, but the cut itself is still valid.
  pop.selected = h.ids.kid; pop.multiSelected.clear();
  pop.onClipboardEvent('paste', clipboardEvent(card, { [MIME]: raw }));
  await tick(); await tick();
  assert.equal(h.sessionFor(h.plugin).get()?.mode, 'cut', 'the cut is still pending');
  assert.deepEqual(cutMarked(pop), [h.ids.branch, h.ids.kid].sort(), 'its mark stays in the popout');
  assert.deepEqual(cutMarked(h.view), [h.ids.branch, h.ids.kid].sort(), 'and in the first window');
});
