// B13 (P1.6): focusing one branch is a view-only filter; leaving restores viewport/selection and nothing is written to Map.md.
// A small DOM with a real focus model (document.activeElement, removal sends focus to the body) stands in for the page.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, fixture, DEFAULT_SETTINGS, obsidian, core, withExpansionCoordinator } = require('./support.cjs');
const dom = require('./support-dom.cjs');

const { Doc, El } = require('./support-focus-dom.cjs');

// Settings rows are built by the organizer windows; a chainable stand-in that runs the callbacks is enough here.
const chain = () => new Proxy(function () {}, { get: (_t, key) => (key === 'then' ? undefined : chain()), apply: (_t, _self, args) => { for (const a of args) if (typeof a === 'function') a(chain()); return chain(); } });
class Setting { constructor() { return chain(); } }
const MAP = 'Agent Workspace/Topics/map-f/Map.md';
const timers = ms => new Promise(resolve => setTimeout(resolve, ms));

let globalWin = {};
async function harness() {
  globalWin = { createFragment: dom.createFragment, CSS: { escape: v => v }, createSvg: tag => new El(new Doc(), tag) };
  const { repo, app } = fixture('en');
  const settings = { ...DEFAULT_SETTINGS, language: 'en', cliModel: 'gpt-6-luna' };
  repo.settings = settings; app.scope = { appScope: true };
  const mapDoc = { id: 'map-f', title: 'Focus', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  await repo.ensureTopicFolders('Agent Workspace/Topics/map-f');
  const ids = {};
  for (const [key, title, parent] of [['root', 'Root'], ['branch', 'Branch', 'root'], ['deep', 'Deep', 'branch'], ['deeper', 'Deeper', 'deep'], ['other', 'Other', 'root']]) {
    const created = await repo.createNote(title, 'gpt-6-luna', mapDoc, MAP, parent ? 'inherited' : 'workspace');
    Object.assign(created, { parentId: parent ? ids[parent] : null, x: 80, y: 80 + mapDoc.nodes.length * 200, collapsed: key === 'branch' || key === 'deep' });
    mapDoc.nodes.push(created); ids[key] = created.id;
  }
  await app.vault.create(MAP, core.serializeMap(mapDoc));
  await repo.rebuildDerivedData();
  const notices = [], modals = [], menus = [];
  const Base = dom.makeModal();
  class Modal extends Base { open() { modals.push(this); super.open(); } }
  class Menu { constructor() { menus.push(this); } addItem(cb) { cb({ setTitle() { return this; }, setIcon() { return this; }, onClick() { return this; }, setChecked() { return this; }, setWarning() { return this; } }); return this; } addSeparator() { return this; } onHide(fn) { this.hide = fn; return this; } showAtMouseEvent() {} showAtPosition() {} }
  const { VisualAgentMapView } = load('main.ts', { obsidian: { ...obsidian, Modal, Menu, Notice: dom.makeNotice(notices), Setting, setTooltip() {} } }, globalWin);
  const plugin = withExpansionCoordinator({
    availableModels: () => ['gpt-6-luna'], modelLabel: model => model, subscribeModelDiscovery: () => () => {}, refreshModelDiscovery: async () => {},
    repo, settings, running: new Set(), logs: { appendLog() {} }, rebuildDerivedData: () => repo.rebuildDerivedData(), expansionBatches: new Map(), pendingSuggestions: new Map(), releaseOutline() {}, setOutlineActive() {}, detailsShown: () => false,
    mutate: async work => { await work(); await view.hydrate(); }
  });
  const view = new VisualAgentMapView({ app }, plugin);
  const doc = new Doc();
  const contentEl = doc.body.add('div', { cls: 'view-content' });
  contentEl.focus = () => { doc.activeElement = contentEl; };
  view.contentEl = contentEl; view.path = MAP; view.map = await repo.readMap(MAP);
  view.focusNode = () => {}; view.openDetails = () => {}; view.commitSelection = () => {}; view.renderInspector = () => {};
  view.hydrate = async () => { view.notes = new Map(await Promise.all(view.map.nodes.map(async n => [n.id, await repo.readNote(n.path)]))); };
  await view.hydrate();
  // The view registers focusin on its content element in onOpen; the stand-in wires the same handler.
  contentEl.addEventListener('focusin', event => view.trackMapFocus?.(event.target));
  const state = { extraToolbarControl: false, empty: false };
  const build = () => {
    contentEl.empty(); view.cardEls.clear(); view.textEls.clear();
    const toolbar = contentEl.add('div', { cls: 'vam-toolbar' });
    if (state.extraToolbarControl) toolbar.add('button', { text: 'Undo' });
    toolbar.add('button', { cls: 'vam-map-switcher', label: 'Switch mind map' });
    if (state.empty) { contentEl.add('div', { cls: 'vam-empty' }).add('button', { text: 'Restore deleted map' }); return; }
    toolbar.add('button', { cls: 'vam-layout-button', text: 'Layout' });
    const stage = contentEl.add('div', { cls: 'vam-stage' });
    for (const n of view.map.nodes) {
      const card = stage.add('div', { cls: 'vam-node', tabindex: 0 }); card.dataset.nodeId = n.id; view.cardEls.set(n.id, card);
      card.add('button', { cls: 'vam-structure-tool', text: 'Links' });
    }
    for (const item of view.map.canvasItems ?? []) {
      const el = stage.add('div', { cls: 'vam-text-node', tabindex: 0 }); el.dataset.itemId = item.id; view.textEls.set(item.id, el);
    }
  };
  // render(): paint remembers focus first and gives it back last, like holdMapSearch.
  view.render = () => { const keep = view.holdMapFocus?.() ?? (() => {}); build(); keep(); };
  build();
  const card = key => view.cardEls.get(ids[key]);
  const inMap = () => contentEl.contains(doc.activeElement);
  return { repo, app, view, doc, contentEl, ids, card, build, state, notices, modals, menus, inMap, active: () => doc.activeElement };
}


const keydown = (target, key = 'Escape') => ({ key, target, defaultPrevented: false, isComposing: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} });
const shown = h => Array.from(h.view.canvasNodes(), n => n.id).sort();
const spyWrites = h => {
  const writes = [];
  for (const [obj, names] of [[h.repo, ['saveMap', 'updateMap']], [h.app.vault, ['modify', 'process', 'create']]])
    for (const name of names) if (typeof obj[name] === 'function') { const orig = obj[name].bind(obj); obj[name] = (...a) => { writes.push(name); return orig(...a); }; }
  return writes;
};

test('B13-1: a card inside a collapsed branch can be focused and is drawn by its own collapsed state; leaving shows the old canvas', async () => {
  const h = await harness();
  const { root, branch, deep, other } = h.ids;
  const before = shown(h);
  assert.deepEqual(before, [root, branch, other].sort(), 'collapsed branch hides its descendants before focus');
  assert.equal(h.view.enterBranchFocus(deep), true);
  assert.deepEqual(shown(h), [deep], 'deep is collapsed itself: only it is drawn, though its ancestor is collapsed too');
  assert.equal(h.view.exitBranchFocus(), true);
  assert.deepEqual(shown(h), before);
  assert.equal(h.view.enterBranchFocus(branch), true);
  h.view.map.nodes.find(n => n.id === branch).collapsed = false;
  assert.deepEqual(shown(h), [branch, deep].sort(), 'focus follows the live collapsed flags inside the branch; outside nodes are never drawn');
  assert.equal(h.view.exitBranchFocus(), true);
  assert.equal(h.view.exitBranchFocus(), false, 'leaving twice is a no-op');
  assert.equal(h.view.enterBranchFocus('nope'), false, 'unknown id');
});

test('B13-2: leaving restores viewport and selection deep-equal to before focus', async () => {
  const h = await harness();
  h.view.map.viewport = { x: 41, y: -7, zoom: 0.8 };
  h.view.selection.setSelected(h.ids.other);
  const vp = JSON.parse(JSON.stringify(h.view.map.viewport)), sel = JSON.parse(JSON.stringify(h.view.selection.stash()));
  h.view.enterBranchFocus(h.ids.branch);
  assert.equal(h.view.selection.state.selected, null, 'a selection outside the branch does not linger');
  h.view.map.viewport = { x: 500, y: 500, zoom: 2 };
  h.view.exitBranchFocus();
  assert.deepEqual(JSON.parse(JSON.stringify(h.view.map.viewport)), vp);
  const after = h.view.selection.stash();
  assert.deepEqual(JSON.parse(JSON.stringify(after)), JSON.parse(JSON.stringify(sel)));
});

test('B13-3: Esc order is menu, branch focus, focus mode, selection', async () => {
  const h = await harness();
  h.view.selection.setSelected(h.ids.root);
  h.view.setFocusMode(true);
  h.view.enterBranchFocus(h.ids.branch);
  const menu = h.doc.body.add('div', { cls: 'menu' });
  h.view.onMapKeydown(keydown(h.contentEl));
  assert.ok(h.view.branchFocus, 'a menu open: it closes alone');
  menu.detach();
  h.view.onMapKeydown(keydown(h.contentEl));
  assert.equal(h.view.branchFocus, null, 'branch focus ends first');
  assert.equal(h.view.focusMode, true, 'focus mode stays');
  h.view.onMapKeydown(keydown(h.contentEl));
  assert.equal(h.view.focusMode, false, 'then focus mode');
  h.view.onMapKeydown(keydown(h.contentEl));
  assert.equal(h.view.selection.state.selected, null, 'then the selection');
});

test('B13-4: another map or closing the view ends the focus', async () => {
  const h = await harness();
  h.view.enterBranchFocus(h.ids.branch);
  await h.view.openMapInMutation('Agent Workspace/Topics/map-f/Other.md').catch(() => {});
  assert.equal(h.view.branchFocus, null, 'switching map ends focus');
  h.view.enterBranchFocus(h.ids.branch);
  await h.view.onClose().catch(() => {});
  assert.equal(h.view.branchFocus, null, 'closing the view ends focus');
});

test('B13-5: focus, pan and leave write Map.md zero times', async () => {
  const h = await harness();
  const writes = spyWrites(h);
  h.view.enterBranchFocus(h.ids.branch);
  h.view.map.viewport = { x: 9, y: 9, zoom: 1.3 };
  h.view.saveViewport();
  await timers(400);
  h.view.exitBranchFocus();
  await timers(400);
  assert.deepEqual(writes, []);
});

test('B13-6: an edit written while focused (persist) keeps the pre-focus viewport in Map.md', async () => {
  const h = await harness();
  h.view.map.viewport = { x: 12, y: 34, zoom: 0.9 };
  h.view.enterBranchFocus(h.ids.branch);
  h.view.map.viewport = { x: 700, y: 700, zoom: 2.5 };
  h.view.map.nodes.find(n => n.id === h.ids.other).x += 10;
  await h.view.persist();
  const onDisk = await h.repo.readMap(MAP);
  assert.deepEqual(JSON.parse(JSON.stringify(onDisk.viewport)), { x: 12, y: 34, zoom: 0.9 });
  assert.deepEqual(JSON.parse(JSON.stringify(h.view.map.viewport)), { x: 700, y: 700, zoom: 2.5 }, 'the screen keeps the focused camera');
  h.view.exitBranchFocus();
  assert.deepEqual(JSON.parse(JSON.stringify(h.view.map.viewport)), { x: 12, y: 34, zoom: 0.9 });
});


test('B13-7: undoing a map rename while focused writes the pre-focus viewport', async () => {
  const h = await harness();
  h.view.map.viewport = { x: 12, y: 34, zoom: 0.9 };
  await h.repo.saveMap(MAP, h.view.map);
  h.view.enterBranchFocus(h.ids.branch);
  h.view.map.viewport = { x: 700, y: 700, zoom: 2.5 };
  h.view.app.workspace = { requestSaveLayout() {} };
  await h.view.renameMapTo('Renamed');
  await h.view.travel(false);
  const onDisk = await h.repo.readMap(h.view.path);
  assert.deepEqual(JSON.parse(JSON.stringify(onDisk.viewport)), { x: 12, y: 34, zoom: 0.9 });
  assert.equal(onDisk.title, 'Focus', 'the undo did restore the title');
});

// B13 blocker: real edit entries (mapChange) while focused must not store the focused camera in Map.md.
const focusedEdit = async (edit) => {
  const h = await harness();
  h.view.map.viewport = { x: 12, y: 34, zoom: 0.9 };
  await h.repo.saveMap(MAP, h.view.map);
  h.view.enterBranchFocus(h.ids.branch);
  h.view.map.viewport = { x: 700, y: 700, zoom: 2.5 };
  await edit(h);
  await timers(30);
  const onDisk = await h.repo.readMap(MAP);
  return { h, onDisk };
};
const vp = v => JSON.parse(JSON.stringify(v));

test('B13-8: collapsing a card while focused keeps the pre-focus viewport in Map.md', async () => {
  const { h, onDisk } = await focusedEdit(async h => {
    const node = h.view.map.nodes.find(n => n.id === h.ids.deep);
    h.view.toggleCollapsed(node);
  });
  assert.equal(onDisk.nodes.find(n => n.id === h.ids.deep).collapsed, false, 'the edit really reached disk');
  assert.deepEqual(vp(onDisk.viewport), { x: 12, y: 34, zoom: 0.9 });
  assert.deepEqual(vp(h.view.map.viewport), { x: 700, y: 700, zoom: 2.5 }, 'the screen keeps the focused camera');
});

test('B13-9: adding a child while focused keeps the pre-focus viewport in Map.md', async () => {
  const { h, onDisk } = await focusedEdit(async h => {
    await h.view.addNode(h.view.map.nodes.find(n => n.id === h.ids.branch), 'Fresh');
  });
  assert.equal(onDisk.nodes.length, 6, 'the edit really reached disk (5 cards + the new child)');
  assert.deepEqual(vp(onDisk.viewport), { x: 12, y: 34, zoom: 0.9 });
});

test('B13-10: focusing from the command palette (keyboard left on the body) puts focus on the focused card, so Esc leaves', async () => {
  const h = await harness();
  h.view.selection.setSelected(h.ids.branch);
  h.doc.activeElement = h.doc.body; // the palette closed: Obsidian leaves the keyboard on the body
  assert.equal(h.view.mapCommand('focus-branch', false), true);
  await timers(10);
  assert.equal(h.active(), h.card('branch'), 'the focused card holds the keyboard');
  h.view.onMapKeydown(keydown(h.active()));
  assert.equal(h.view.branchFocus, null, 'Esc on it leaves the focus');
});

