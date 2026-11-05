// Bug bash B (focus and keyboard): where keyboard focus lives after Esc, a repaint, a closed dialog, a restored map and an undo.
// A small DOM with a real focus model (document.activeElement, removal sends focus to the body) stands in for the page.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, fixture, DEFAULT_SETTINGS, obsidian, core, withExpansionCoordinator } = require('./support.cjs');
const dom = require('./support-dom.cjs');

class Doc {
  constructor() { this.body = new El(this, 'body'); this.activeElement = this.body; }
  querySelector(selector) { return this.body.querySelector(selector); }
}
class El {
  constructor(doc, tag, init = {}) {
    this.doc = doc; this.tagName = tag.toUpperCase(); this.children = []; this.parent = null; this.attrs = {}; this.dataset = {}; this.listeners = {};
    this.classes = new Set(String(init.cls ?? '').split(' ').filter(Boolean)); this.textContent = init.text ?? ''; this.tabIndex = init.tabIndex ?? -1;
    if (init.label) this.attrs['aria-label'] = init.label;
    if (init.tabindex !== undefined) this.attrs.tabindex = String(init.tabindex);
    this.ownerDocument = doc;
  }
  get classList() { const set = this.classes; return { item: i => [...set][i] ?? null, contains: name => set.has(name) }; }
  get isConnected() { let e = this; while (e.parent) e = e.parent; return e === this.doc.body; }
  get id() { return this.dataset.nodeId; }
  getAttribute(name) { return this.attrs[name] ?? null; }
  setAttr(name, value) { this.attrs[name] = String(value); }
  add(tag, init) { const child = new El(this.doc, tag, init); child.parent = this; this.children.push(child); return child; }
  contains(other) { for (let e = other; e; e = e.parent) if (e === this) return true; return false; }
  matches(selector) {
    return selector.split(',').map(part => part.trim()).some(part => (part.startsWith('.') ? this.classes.has(part.slice(1)) : part === '[tabindex]' ? 'tabindex' in this.attrs : part.toUpperCase() === this.tagName));
  }
  closest(selector) { for (let e = this; e; e = e.parent) if (e.matches(selector)) return e; return null; }
  all() { return this.children.flatMap(c => [c, ...c.all()]); }
  querySelectorAll(selector) { return this.all().filter(e => e.matches(selector)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  addEventListener(name, fn) { (this.listeners[name] ??= []).push(fn); }
  removeEventListener() {}
  focus() {
    if (!this.isConnected) return;
    this.doc.activeElement = this;
    for (let e = this; e; e = e.parent) for (const fn of e.listeners.focusin ?? []) fn({ target: this });
  }
  // Enough of Obsidian's element helpers for the render functions that build right-click targets.
  createEl(tag, init = {}) { const o = typeof init === 'string' ? { cls: init } : init; return this.add(tag, o); }
  createDiv(init) { return this.createEl('div', init); }
  createSpan(init) { return this.createEl('span', init); }
  addClass(name) { this.classes.add(name); }
  removeClass(name) { this.classes.delete(name); }
  setText(text) { this.textContent = text; }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  appendChild(child) { child.parent = this; this.children.push(child); return child; }
  fire(name, event) { for (const fn of this.listeners[name] ?? []) fn(event); }
  get style() { return (this._style ??= {}); }
  getBoundingClientRect() { return { left: 0, top: 0, right: 100, bottom: 50, width: 100, height: 50 }; }
  get offsetLeft() { return 0; } get offsetTop() { return 0; } get offsetWidth() { return 100; } get offsetHeight() { return 50; }
  detach() { if (this.contains(this.doc.activeElement)) this.doc.activeElement = this.doc.body; if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); this.parent = null; }
  empty() { for (const c of [...this.children]) c.detach(); }
  remove() { this.detach(); }
}

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
  for (const [key, title, parent] of [['root', 'Root'], ['leaf', 'Leaf', 'root']]) {
    const created = await repo.createNote(title, 'gpt-6-luna', mapDoc, MAP, parent ? 'inherited' : 'workspace');
    Object.assign(created, { parentId: parent ? ids[parent] : null, x: 80, y: 80 + mapDoc.nodes.length * 200 });
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
    repo, settings, running: new Set(), logs: { appendLog() {} }, rebuildDerivedData: () => repo.rebuildDerivedData(), relevanceGrades: new Map(), expansionBatches: new Map(), pendingSuggestions: new Map(), releaseOutline() {}, setOutlineActive() {}, detailsShown: () => false,
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

const keydown = (_h, target, key = 'Escape', over = {}) => ({ key, target, defaultPrevented: false, isComposing: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...over });

test('02: Escape on a card clears the selection, is claimed so Obsidian keeps the leaf active, and focus stays in the map', async () => {
  const h = await harness();
  h.view.selection.setSelected(h.ids.leaf);
  h.card('leaf').focus();
  const event = keydown(h, h.card('leaf'));
  h.view.onMapKeydown(event);
  assert.equal(h.view.selection.state.selected, null, 'the selection is cleared (plan-42-p2 unchanged)');
  assert.equal(event.defaultPrevented, true, 'Esc is claimed, so Obsidian does not move the active leaf');
  assert.equal(h.inMap(), true, 'focus is still inside the map');
  // The selection clearing blurred the card: the map takes focus back instead of leaving it on the body.
  h.doc.activeElement = h.doc.body;
  h.view.onMapKeydown(keydown(h, h.card('leaf')));
  assert.equal(h.inMap(), true, 'a lost focus returns to the map');
});

test('#11: Escape does not clear the selection while a menu is open or when something already handled the key; fields keep their own Escape', async () => {
  const h = await harness();
  h.view.selection.setSelected(h.ids.leaf);
  h.card('leaf').focus();
  const menu = h.doc.body.add('div', { cls: 'menu' });
  let event = keydown(h, h.card('leaf'));
  h.view.onMapKeydown(event);
  assert.equal(h.view.selection.state.selected, h.ids.leaf, 'the menu closes, the selection stays');
  assert.equal(event.defaultPrevented, false);
  menu.detach();
  event = keydown(h, h.card('leaf'), 'Escape', { defaultPrevented: true });
  h.view.onMapKeydown(event);
  assert.equal(h.view.selection.state.selected, h.ids.leaf, 'already handled: not cleared');
  const field = h.card('leaf').add('textarea'); field.matchesField = true;
  const typing = keydown(h, field); const closest = field.closest.bind(field);
  field.closest = selector => (/input|textarea/.test(selector) ? field : closest(selector));
  h.view.onMapKeydown(typing);
  assert.equal(h.view.selection.state.selected, h.ids.leaf, 'a field keeps its own Escape');
  assert.equal(typing.defaultPrevented, false);
});

test('08: a repaint keeps focus on the same toolbar control even when the controls before it changed', async () => {
  const h = await harness();
  h.contentEl.querySelector('.vam-layout-button').focus();
  h.state.extraToolbarControl = true; // a control appears before it, as Undo does once there is history
  h.view.renderPreservingFocus();
  assert.equal(h.inMap(), true);
  assert.ok(h.active().classes.has('vam-layout-button'), 'the new Layout button, not whatever sits at the old index');
});

// Other windows are expressed only through Obsidian's activeWindow; the main document's activeElement stays a map element or the body.
function inactive(h, { mapIsPopout = false } = {}) {
  const mapWin = { name: mapIsPopout ? 'popout' : 'main' }, other = { name: mapIsPopout ? 'main' : 'popout' };
  h.doc.defaultView = mapWin;
  const focused = [];
  const track = el => { const orig = el.focus; el.focus = function (...a) { focused.push(this.tagName + '.' + [...this.classes].join('.')); return orig.apply(this, a); }; };
  const origBuild = h.build;
  h.view.render = () => { const keep = h.view.holdMapFocus?.() ?? (() => {}); origBuild(); for (const e of h.contentEl.all()) track(e); track(h.contentEl); keep(); };
  return { mapWin, other, focused, track };
}

test('#18: a repaint while another window is active (Settings pop-out) moves no focus in the map; the active map window keeps the old behaviour', async () => {
  for (const mapIsPopout of [false, true]) {
    const h = await harness();
    const w = inactive(h, { mapIsPopout });
    try {
      h.contentEl.querySelector('.vam-layout-button').focus(); // the map had focus when the user went to the other window
      globalWin.activeWindow = w.other;
      w.focused.length = 0;
      await h.view.refreshFromPlugin();
      assert.deepEqual(w.focused, [], `renderPreservingFocus does not refocus (map in ${mapIsPopout ? 'a pop-out' : 'main'})`);
      assert.equal(h.view.focusRestorePending, true, 'the skipped restore is remembered');
      assert.equal(h.view.externalRefresh, false, 'the gate closes again after the refresh');
      globalWin.activeWindow = w.mapWin;
      h.contentEl.querySelector('.vam-layout-button').focus();
      await h.view.refreshFromPlugin();
      assert.ok(h.active().classes.has('vam-layout-button'), 'active map window: focus is restored as before');
    } finally { delete globalWin.activeWindow; }
  }
});

test('#18: the focus that was skipped comes back when the map window is focused again', async () => {
  const h = await harness();
  const w = inactive(h);
  try {
    h.contentEl.querySelector('.vam-layout-button').focus();
    globalWin.activeWindow = w.other;
    await h.view.refreshFromPlugin();
    assert.equal(h.inMap(), false, 'nothing was focused while the other window was active');
    globalWin.activeWindow = w.mapWin;
    h.view.onMapWindowFocus();
    assert.ok(h.active().classes.has('vam-layout-button'), 'the same control (new element) has focus again');
    h.doc.activeElement = h.doc.body;
    h.view.onMapWindowFocus();
    assert.equal(h.inMap(), false, 'nothing pending: a plain window focus takes no focus');
  } finally { delete globalWin.activeWindow; }
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'experiences/visual-map/view.ts'), 'utf8');
  assert.match(source, /registerDomEvent\([^\n]*"focus", \(\) => this\.onMapWindowFocus\(\)\)/, 'onOpen wires the window focus event');
});

test('#18: a text editor reopened while another window was active gets the focus in its field when the map window is focused again', async () => {
  const h = await harness();
  const block = h.contentEl.querySelector('.vam-stage').add('div', { cls: 'vam-text-node', tabindex: 0 });
  block.dataset.itemId = 'tx';
  const field = block.add('textarea', { cls: 'vam-text-node-input' });
  h.view.textEls.set('tx', block);
  h.view.editingTextId = 'tx';
  h.view.lastMapFocus = { itemId: 'tx' };
  h.view.focusRestorePending = true;
  h.doc.activeElement = h.doc.body;
  h.view.onMapWindowFocus();
  assert.equal(h.active(), field, 'the editing field, not the block around it, has focus');
  h.view.focusRestorePending = true;
  const elsewhere = h.contentEl.querySelector('.vam-layout-button');
  elsewhere.focus();
  h.view.onMapWindowFocus();
  assert.equal(h.active(), elsewhere, 'focus that is not lost is not taken');
});

test('#18: the repaint restorers for the chat field, the search field and the relevance bar keep still during an external refresh while another window is active', async () => {
  const h = await harness();
  const w = inactive(h);
  try {
    const input = h.contentEl.add('textarea', { cls: 'vam-map-chat-input' });
    h.view.chat = { isInput: e => e === input, captureFocus: () => () => input.focus(), detach() {}, relabel() {} };
    const search = h.contentEl.add('input', { cls: 'vam-map-search-input' }); search.setSelectionRange = () => {}; search.selectionStart = 0; search.selectionEnd = 0;
    h.view.mapSearch = { query: '' }; h.view.mapSearchBar = { input: search };
    h.view.mountMapSearch = () => { h.view.mapSearchBar = { input: search }; }; h.view.applySearchMarks = () => {};
    const bar = h.contentEl.add('div', { cls: 'vam-relevance-statusbar' }); const barButton = bar.add('button'); const goal = h.contentEl.add('div', { cls: 'vam-goal-text' });
    for (const [name, element, hold] of [['chat', input, () => h.view.detachMapChat()], ['search', search, () => h.view.holdMapSearch()], ['relevance bar', barButton, () => h.view.keepRelevanceBarFocus()]]) {
      // The repaint: hold, the page is rebuilt (focus drops to the body), then the restorer runs.
      h.view.render = () => { const restore = hold(); h.doc.activeElement = h.doc.body; restore(); };
      element.focus();
      globalWin.activeWindow = w.other;
      await h.view.refreshFromPlugin();
      assert.equal(h.doc.activeElement, h.doc.body, `${name}: an external refresh does not refocus while another window is active`);
      element.focus();
      h.view.renderPreservingFocus();
      assert.ok(h.doc.activeElement !== h.doc.body, `${name}: the map's own repaint refocuses even though activeWindow is still the other window`);
      globalWin.activeWindow = w.mapWin;
      element.focus();
      await h.view.refreshFromPlugin();
      assert.ok(h.doc.activeElement !== h.doc.body, `${name}: refocused when the map window is active`);
    }
  } finally { delete globalWin.activeWindow; }
});

test('C-#14: the map\'s own repaint (chat reply) restores the chat input although activeWindow is still the Settings pop-out', async () => {
  for (const mapIsPopout of [false, true]) {
    const h = await harness();
    const w = inactive(h, { mapIsPopout });
    try {
      const input = h.contentEl.add('textarea', { cls: 'vam-map-chat-input' });
      h.view.chat = { isInput: e => e === input, captureFocus: () => () => input.focus(), detach() {}, relabel() {} };
      h.view.render = () => { const restore = h.view.detachMapChat(); h.doc.activeElement = h.doc.body; restore(); };
      input.focus();
      globalWin.activeWindow = w.other; // the pop-out stays the active window even after clicks in the map window
      h.view.renderPreservingFocus();
      assert.equal(h.doc.activeElement, input, 'the chat input has focus after the reply repaint');
      h.doc.activeElement = h.doc.body;
      h.view.restoreMapFocus(null);
      assert.equal(h.inMap(), true, 'restoreMapFocus is not gated outside an external refresh');
    } finally { delete globalWin.activeWindow; }
  }
});

test('08: a dialog that changed the map closes and the opener is gone: focus comes back to the map; cancel keeps the opener; another leaf is left alone', async () => {
  const opener = h => h.card('leaf').querySelector('.vam-structure-tool');
  // Changed data: the map repaints while the dialog has focus, then the dialog closes and Obsidian restores focus to the removed opener.
  let h = await harness();
  opener(h).focus();
  h.view.openNodePanel(h.view.map.nodes[1], 'structure');
  const panel = h.modals.at(-1), field = h.doc.body.add('div', { cls: 'modal' }).add('button', { text: 'Star' });
  field.focus();
  h.view.render();
  assert.equal(h.active(), field, 'the open dialog keeps its focus through the repaint');
  panel.close(); h.doc.activeElement = h.doc.body; // Obsidian puts focus back on the opener that no longer exists
  await timers(180);
  assert.equal(h.inMap(), true, 'focus is inside the map, not on the body');
  assert.equal(h.active().parent, h.card('leaf'), 'on the rebuilt opener (same card tool)');
  // Cancel: nothing repainted, Obsidian focuses the opener, which is still there.
  h = await harness();
  const old = opener(h); old.focus();
  h.view.openNodePanel(h.view.map.nodes[1], 'structure');
  h.modals.at(-1).close(); old.focus();
  await timers(180);
  assert.equal(h.active(), old, 'cancel: focus stays on the opener');
  // Focus that moved to another leaf is not taken back.
  h = await harness();
  opener(h).focus();
  h.view.openNodePanel(h.view.map.nodes[1], 'structure');
  const sidebar = new El(h.doc, 'div', { tabindex: 0 }); sidebar.parent = h.doc.body; h.doc.body.children.push(sidebar);
  h.modals.at(-1).close(); sidebar.focus();
  await timers(180);
  assert.equal(h.active(), sidebar, 'a focus in another leaf is not stolen');
});

test('08e: restoring a deleted map leaves focus in the map; focus in another leaf is not taken', async () => {
  for (const elsewhere of [false, true]) {
    const h = await harness();
    h.state.empty = true; h.view.render();
    h.contentEl.querySelector('button').focus(); // "Restore deleted map" in the empty state
    h.view.deletedMap = { path: MAP, content: 'x', map: h.view.map, deleted: true };
    const lookup = h.app.vault.getAbstractFileByPath.bind(h.app.vault); h.app.vault.getAbstractFileByPath = path => (path === MAP ? null : lookup(path)); h.app.vault.create = async () => {};
    h.view.plugin.rebuildDerivedData = async () => {};
    h.state.empty = false;
    let sidebar = null;
    if (elsewhere) { sidebar = new El(h.doc, 'div', { tabindex: 0 }); sidebar.parent = h.doc.body; h.doc.body.children.push(sidebar); sidebar.focus(); }
    await h.view.restoreDeletedMap();
    if (elsewhere) assert.equal(h.active(), sidebar, 'not stolen from another leaf');
    else { assert.equal(h.inMap(), true, 'the restore button is gone, focus is in the map'); assert.notEqual(h.active(), h.doc.body); }
  }
});

test('#16: undo that removes the focused text block puts focus on its parent card, else on the canvas', async () => {
  for (const parent of [true, false]) {
    const h = await harness();
    h.view.map.canvasItems = [{ id: 't1', kind: 'text', text: 'Hi', x: 0, y: 0, ...(parent ? { parentId: h.ids.leaf } : {}) }];
    h.build();
    h.view.textEls.get('t1').focus();
    h.view.map.canvasItems = []; // the undo removed the block
    h.view.render();
    assert.equal(h.inMap(), true);
    if (parent) assert.equal(h.active(), h.card('leaf'), 'the parent card');
    else assert.equal(h.active(), h.contentEl, 'the canvas');
  }
});

test('08: the Layout menu hands focus back to its button after it closes onto the body', async () => {
  const h = await harness();
  const button = h.contentEl.querySelector('.vam-layout-button'); button.focus();
  h.view.openLayoutMenu({});
  h.doc.activeElement = h.doc.body; // the menu took focus and left it nowhere
  h.menus.at(-1).hide?.();
  await timers(180);
  assert.equal(h.active(), button);
});

test('#21: the add-text command says why nothing happened in selection mode, and stays silent for other reasons', async () => {
  const h = await harness();
  h.view.selection.toggleMultiSelect();
  h.view.addTextNodeUnder();
  await timers(20);
  assert.equal(h.notices.length, 1, 'one Notice in multi-select mode');
  assert.match(h.notices[0], /selecting topics/);
  const quiet = await harness();
  quiet.view.presentation = {};
  quiet.view.addTextNodeUnder();
  await timers(20);
  assert.deepEqual(quiet.notices, [], 'a viewer or presentation reason keeps the old silence');
});

test('#15: toggling an outline row keeps focus on that row\'s toggle, and a second Space toggles again', () => {
  const { OutlineView } = load('ui/outline-view.ts', { obsidian: { ...obsidian, ItemView: class { constructor() { this.contentEl = dom.element('div'); } }, Notice: class {} } });
  const view = new OutlineView({ app: {} }, async () => {});
  const doc = { activeElement: null };
  view.contentEl.root = doc; view.contentEl.ownerDocument = doc;
  view.setMap({ title: 'M', nodes: [{ id: 'a', parentId: null, path: 'a.md' }, { id: 'b', parentId: 'a', path: 'b.md' }] }, new Map([['a', 'Alpha'], ['b', 'Beta']]));
  const toggles = () => dom.findAll(view.contentEl, i => dom.hasCls(i, 'vam-outline-toggle'));
  const first = toggles()[0]; first.focus();
  first.click();
  const second = toggles()[0];
  assert.notEqual(second, first, 'the tree was rebuilt');
  assert.equal(doc.activeElement, second, 'focus is on the new toggle of the same row');
  second.click();
  assert.equal(doc.activeElement, toggles()[0], 'the second Space still has a focused toggle to act on');
  // Focus elsewhere (a mouse click on the title) is not moved by a toggle.
  const title = dom.findAll(view.contentEl, i => dom.hasCls(i, 'vam-outline-note'))[0]; title.focus();
  toggles()[0].click();
  assert.equal(doc.activeElement, title);
});

test('#17: the outline import window puts the cursor in its text box when it opens', () => {
  const { OutlineImportModal } = load('experiences/visual-map/outline-import-modal.ts', { obsidian: { ...obsidian, Modal: dom.makeModal(), Notice: class {} } }, { createFragment: dom.createFragment });
  const doc = { activeElement: null };
  const modal = new OutlineImportModal({}, async () => {});
  modal.contentEl.root = doc; modal.modalEl.root = doc;
  modal.contentEl.ownerDocument = doc;
  modal.open();
  const textarea = dom.findAll(modal.contentEl, i => i.tag === 'textarea')[0];
  assert.ok(textarea, 'the text box exists');
  assert.equal(doc.activeElement, textarea, 'and has focus');
});

test('wiring: paint holds and restores the map focus, onOpen tracks focusin, and every dialog opened from the map goes through openMapModal', () => {
  const fs = require('node:fs'), path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'experiences/visual-map/view.ts'), 'utf8');
  const paint = source.slice(source.indexOf('private paint(): void'), source.indexOf('/** What the empty canvas says'));
  assert.match(paint, /const keepMapFocus = this\.holdMapFocus\(\);/);
  assert.ok(paint.indexOf('keepMapFocus();') > paint.indexOf('this.contentEl.empty();'), 'restored after the rebuild');
  assert.match(source, /registerDomEvent\(this\.contentEl, "focusin", event => this\.trackMapFocus\(event\.target\)\)/);
  for (const dialog of ['OutlineImportModal(', 'ui.organize_notes', 'ui.unassigned_notes', 'ui.archived_notes'])
    assert.match(source, new RegExp(`openMapModal\\(\\s*new [A-Za-z]*\\([^)]*${dialog.replace(/[().]/g, '\\$&')}|openMapModal\\(\\s*new ${dialog.replace(/[().]/g, '\\$&')}`), `${dialog} opens through openMapModal`);
  assert.equal((source.match(/selection\.escape\(\)/g) ?? []).length, 1, 'plan-42-p2: one Esc branch clears the selection');
});

test('#11 real order: the menu is already closed (onHide fired, .menu gone) when the same Escape reaches the map: selection stays; the next Escape clears it', async () => {
  for (const open of ['layout', 'card']) {
    const h = await harness();
    h.view.selection.setSelected(h.ids.leaf);
    h.card('leaf').focus();
    let menu;
    if (open === 'layout') { h.view.openLayoutMenu({}); menu = h.menus.at(-1); }
    else { menu = { onHide(fn) { this.hide = fn; } }; h.view.restoreFocusOnMenuHide(menu, h.ids.leaf); }
    // Obsidian closes the menu on keydown, before the event bubbles to the view.
    h.doc.body.add('div', { cls: 'menu' }).detach();
    menu.hide();
    const event = keydown(h, h.card('leaf'));
    h.view.onMapKeydown(event);
    assert.equal(h.view.selection.state.selected, h.ids.leaf, `${open}: selection stays`);
    await timers(20);
    h.view.onMapKeydown(keydown(h, h.card('leaf')));
    assert.equal(h.view.selection.state.selected, null, `${open}: a later Escape clears it`);
  }
});

test('#11 real order for other menus: the new-map menu counts as closed by the Escape that hid it; every menu goes through newMenu', () => {
  const fs = require('node:fs'), path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'experiences/visual-map/view.ts'), 'utf8');
  assert.equal((source.match(/new Menu\(\)/g) ?? []).length, 1, 'only newMenu itself builds a Menu');
  assert.equal((source.match(/= this\.newMenu\(/g) ?? []).length, 14, 'the other fourteen menus use it (goal banner P3 removed the toolbar topic menu; ticket 21 added the add-type list; ticket 39 added the card More and selection More menus) (C2 made More mind map actions one; ticket 41 removed openRelationKindMenu, the relation kind is now a select in the card window)');
  const card = source.slice(source.indexOf('private onCanvasContextMenu'), source.indexOf('private openCanvasImagePicker'));
  assert.match(card, /this\.newMenu\(cardId\)/, 'the card right-click menu keeps its card as the focus fallback');
});

test('#11 real order for other menus (behavior): the new-map menu hides before the Escape reaches the map', async () => {
  const h = await harness();
  h.view.selection.setSelected(h.ids.leaf);
  h.view.openNewMapMenu({ stopPropagation() {} });
  h.menus.at(-1).hide();
  h.view.onMapKeydown(keydown(h, h.card('leaf')));
  assert.equal(h.view.selection.state.selected, h.ids.leaf);
});

// ---- Behavioral coverage for the dialog and menu paths (the regex wiring checks above stay) ----

test('08c: the paste-outline window imports, closes onto its removed opener, and focus lands in the map; cancel keeps the opener', async () => {
  const opener = h => h.card('root').querySelector('.vam-structure-tool');
  let h = await harness();
  h.view.selection.setSelected(h.ids.root);
  opener(h).focus();
  h.view.openOutlineImport();
  const modal = h.modals.at(-1);
  assert.ok(modal, 'the outline window opened through the view');
  modal.textarea.value = '# Pasted A\n## Pasted B';
  modal.refresh();
  const before = h.view.map.nodes.length;
  const old = opener(h);
  // The import window holds focus while the map repaints behind it, then closes; Obsidian puts focus back on the opener that the repaint removed.
  h.doc.body.add('div', { cls: 'modal' }).add('button', { text: 'Create' }).focus();
  await modal.submit();
  assert.ok(h.view.map.nodes.length > before, 'importOutline committed new topics');
  assert.equal(modal.closeCount, 1, 'the window closed after the import');
  assert.notEqual(opener(h), old, 'the repaint replaced the opener');
  h.doc.activeElement = h.doc.body;
  await timers(180);
  assert.equal(h.inMap(), true, 'focus is inside the map, not on the body');
  // Cancel: the opener survives and keeps focus.
  h = await harness();
  h.view.selection.setSelected(h.ids.root);
  const kept = opener(h); kept.focus();
  h.view.openOutlineImport();
  h.modals.at(-1).close(); kept.focus();
  await timers(180);
  assert.equal(h.active(), kept, 'cancel: focus stays on the opener');
});

test('08d: the Organizer, Unassigned and Archive windows (openMapModal) hand focus back to the map after a map change', async () => {
  const stubs = h => { h.view.plugin.repo.collectionFiles = async () => []; };
  for (const open of ['organizer', 'unassigned', 'archive']) {
    const h = await harness(); stubs(h);
    const old = h.card('leaf').querySelector('.vam-structure-tool'); old.focus();
    if (open === 'organizer') await h.view.openOrganizer();
    else if (open === 'unassigned') h.view.openUnassigned([]);
    else h.view.openArchive([]);
    const modal = h.modals.at(-1);
    assert.ok(modal, `${open}: the window opened through the view`);
    h.doc.body.add('div', { cls: 'modal' }).add('button', { text: 'Add to mind map' }).focus();
    h.view.render(); // the action changed the map and repainted behind the window
    assert.equal(old.isConnected, false, `${open}: the opener is gone`);
    modal.close(); h.doc.activeElement = h.doc.body;
    await timers(180);
    assert.equal(h.inMap(), true, `${open}: focus is in the map`);
    assert.notEqual(h.active(), h.doc.body);
  }
  // Cancel and another leaf, once through the organizer.
  const h = await harness(); stubs(h);
  const sidebar = new El(h.doc, 'div', { tabindex: 0 }); sidebar.parent = h.doc.body; h.doc.body.children.push(sidebar);
  await h.view.openOrganizer(); h.modals.at(-1).close(); sidebar.focus();
  await timers(180);
  assert.equal(h.active(), sidebar, 'a focus in another leaf is not stolen');
});

// Every menu opener, driven for real: the menu hides before the same Escape reaches the map, the selection stays, and a later Escape clears it.
const MENU_OPENERS = {
  openKindMenu: h => h.view.openKindMenu({}, () => {}),
  openRelevanceMenu: h => h.view.openRelevanceMenu(h.view.map.nodes[1], 'core', h.card('leaf')),
  openUnlinkMenu: h => {
    h.view.map.canvasItems = [{ id: 't1', kind: 'text', text: 'Hi', x: 0, y: 0, links: [h.ids.leaf] }];
    h.view.openUnlinkMenu('t1', h.card('leaf'));
  },
  openExportMenu: h => h.view.openExportMenu({}),
  openNewMapMenu: h => h.view.openNewMapMenu({ stopPropagation() {} }),
  openMapActions: h => h.view.openMapActions({}),
  openLayoutMenu: h => h.view.openLayoutMenu({}),
  onCanvasContextMenu_card: h => h.view.onCanvasContextMenu({ target: h.card('leaf'), clientX: 5, clientY: 5, preventDefault() {} }),
  onCanvasContextMenu_canvas: h => {
    h.view.stagePoint = () => ({ x: 1, y: 1 });
    h.view.onCanvasContextMenu({ target: h.contentEl.querySelector('.vam-stage'), clientX: 5, clientY: 5, preventDefault() {} });
  },
  boundary_label_contextmenu: h => {
    h.view.map.canvasItems = [{ id: 'b1', kind: 'boundary', members: [h.ids.leaf], label: 'Group' }];
    const stage = h.contentEl.querySelector('.vam-stage');
    h.view.renderBoundaries(stage, h.view.map.canvasItems, true);
    const chip = stage.querySelector('.vam-boundary-label');
    chip.fire('contextmenu', { preventDefault() {}, stopPropagation() {}, ...{} });
  },
  summary_label_contextmenu: h => {
    h.view.map.canvasItems = [{ id: 's1', kind: 'summary', parentId: h.ids.root, members: [h.ids.leaf], text: 'Sum' }];
    const stage = h.contentEl.querySelector('.vam-stage');
    h.view.renderSummaries(stage, h.view.map.canvasItems);
    stage.querySelector('.vam-summary-text').fire('contextmenu', { preventDefault() {}, stopPropagation() {} });
  }
};
for (const [name, open] of Object.entries(MENU_OPENERS)) {
  test(`#11 behavior: ${name} - hidden before the Escape reaches the map: selection stays, the next Escape clears it`, async () => {
    const h = await harness();
    h.view.selection.setSelected(h.ids.leaf);
    h.card('leaf').focus();
    const count = h.menus.length;
    open(h);
    assert.equal(h.menus.length, count + 1, 'the opener built one menu');
    h.doc.body.add('div', { cls: 'menu' }).detach(); // Obsidian removes the menu on keydown, before the event bubbles to the view
    h.menus.at(-1).hide?.(); // a menu with no onHide hook is the bug: nothing tells the view this Escape closed it
    let stopped = false;
    const closing = keydown(h, h.card('leaf'), 'Escape', { stopPropagation() { stopped = true; } });
    h.view.onMapKeydown(closing);
    assert.equal(h.view.selection.state.selected, h.ids.leaf, 'the Escape that closed the menu keeps the selection');
    // Unclaimed, Obsidian answers the same Esc by activating the sidebar note, and focus lands in its editor (parent UI smoke on aaefff0).
    assert.equal(closing.defaultPrevented && stopped, true, 'the Escape that closed the menu is claimed by the map');
    await timers(20);
    h.view.onMapKeydown(keydown(h, h.card('leaf')));
    assert.equal(h.view.selection.state.selected, null, 'a later Escape clears it');
  });
}

test('#18-keyboard: the research dialog (next step) closing after a repaint sends focus back to the map, not the body', async () => {
  const h = await harness();
  const card = h.card('leaf'); card.focus();
  h.view.openNextStep(h.view.map.nodes[1]);
  await timers(50);
  const dialog = h.modals.at(-1);
  assert.ok(dialog, 'the next-step dialog opened');
  const field = h.doc.body.add('div', { cls: 'modal' }).add('button', { text: 'Start' });
  field.focus();
  h.view.render(); // research progress / completion repaints the map while the dialog has focus
  dialog.close(); h.doc.activeElement = h.doc.body; // Obsidian restores focus to the opener card, which the repaint removed
  await timers(180);
  assert.equal(h.inMap(), true, 'focus is inside the map so the arrow keys and Esc reach it');
  assert.notEqual(h.active(), h.doc.body);
});

test('#18-keyboard: the outline search box jumps to the first topic whose own title matches on Enter', () => {
  const { OutlineView } = load('ui/outline-view.ts', { obsidian: { ...obsidian, ItemView: class { constructor() { this.contentEl = dom.element('div'); } }, Notice: class {} } });
  const opened = [];
  const view = new OutlineView({ app: {} }, async path => { opened.push(path); });
  view.setActive = () => {}; // the DOM stand-in has no getAttribute; the in-place row marker is covered elsewhere
  const doc = { activeElement: null };
  view.contentEl.root = doc; view.contentEl.ownerDocument = doc;
  view.setMap({ title: 'M', nodes: [{ id: 'a', parentId: null, path: 'a.md' }, { id: 'b', parentId: 'a', path: 'b.md' }, { id: 'c', parentId: 'a', path: 'c.md' }] }, new Map([['a', 'Alpha'], ['b', 'Beta'], ['c', 'Gamma beta']]));
  const input = dom.findAll(view.contentEl, i => dom.hasCls(i, 'vam-outline-search'))[0];
  const enter = (extra = {}) => { const e = { prevented: false }; input.fire('keydown', { key: 'Enter', isComposing: false, preventDefault() { e.prevented = true; }, ...extra }); return e; };
  enter();
  assert.deepEqual(opened, [], 'no search text: Enter does nothing');
  input.value = 'beta'; input.fire('input', {});
  enter({ isComposing: true });
  assert.deepEqual(opened, [], 'an IME confirmation is not a jump');
  const e = enter();
  assert.deepEqual(opened, ['b.md'], 'the first title match in outline order (not the parent that only has a matching child)');
  assert.equal(e.prevented, true);
  input.value = 'zzz'; input.fire('input', {});
  enter();
  assert.deepEqual(opened, ['b.md'], 'no match: nothing opens');
});

test('#18-keyboard: the shortcuts window lists copy, cut and paste in every language', () => {
  const { MAP_KEYBOARD_SHORTCUTS } = load('ui/modals/keyboard-shortcuts-modal.ts', { obsidian: { ...obsidian, Platform: { isMacOS: false } } });
  const { translate } = load('i18n.ts');
  for (const key of ['Mod+C', 'Mod+X', 'Mod+V']) {
    const entry = MAP_KEYBOARD_SHORTCUTS.find(item => item.keys.includes(key));
    assert.ok(entry, key);
    for (const language of ['en', 'zh-TW', 'zh-CN']) assert.notEqual(translate(language, entry.action), entry.action);
  }
});
