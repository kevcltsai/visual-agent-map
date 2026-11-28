// D1-x11c: the right pane for AI cards as one state machine. States {reader, native editor, AI editor open, blank} ×
// events {select same / other AI / ordinary card, Cmd+W, leaf.detach(), close AI editor, reopen Obsidian}. Real path:
// the map view's card click → plugin.detailsShown/openDetails → NodeDetailsSidebar → LivingReaderView, on a workspace
// stand-in whose leaves attach, detach, show one tab at a time and serialize/restore through getViewState/setViewState.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, core, fixture, DEFAULT_SETTINGS, obsidian, withExpansionCoordinator } = require('./support.cjs');
const dom = require('./support-dom.cjs');
const { element, tick } = dom;

const make = (tag, init = {}) => ({ tag, children: [], dataset: {}, style: {}, attrs: { ...(init.attr ?? {}) }, handlers: new Map(), classes: new Set(String(init.cls ?? '').split(' ').filter(Boolean)), text: init.text, isConnected: true, closest() { return null; }, setCssProps(props) { Object.assign(this.style, props); }, classList: { add() {}, remove() {}, contains() { return false; } }, offsetLeft: 1e9, offsetTop: 1e9, offsetWidth: 1, offsetHeight: 1,
  createDiv(value) { return this.createEl('div', typeof value === 'string' ? { cls: value } : value); },
  createSpan(value) { return this.createEl('span', typeof value === 'string' ? { cls: value } : value); },
  createEl(name, value = {}) { const child = make(name, value); child.parent = this; this.children.push(child); return child; },
  setAttr(name, value) { this.attrs[name] = value; }, addClass(...names) { names.forEach(name => this.classes.add(name)); }, removeClass(name) { this.classes.delete(name); },
  toggleClass(name, on) { if (on) this.classes.add(name); else this.classes.delete(name); }, addEventListener(name, handler) { this.handlers.set(name, handler); }, removeEventListener() {},
  setPointerCapture() {}, focus() {}, select() {}, setSelectionRange() {}, remove() { this.removed = true; }, getBoundingClientRect() { return { left: 0, right: 10, top: 0, bottom: 10 }; },
  querySelector() { return null; }, querySelectorAll() { return []; }, replaceWith() {}, after() {}, prepend(el) { this.children.unshift(el); }, appendChild(el) { this.children.push(el); } });
const findAll = (root, predicate) => [...(predicate(root) ? [root] : []), ...(root.children ?? []).flatMap(c => findAll(c, predicate))];
class Setting { setName() { return this; } setDesc() { return this; } addButton() { return this; } }

// Obsidian's views, as far as the pane uses them: a view is shown only while its leaf is the right dock's active tab.
class ItemView {
  constructor(leaf) { this.leaf = leaf; this.app = leaf.app; this.containerEl = { isShown: () => leaf.shown(), toggleClass() {}, getBoundingClientRect: () => ({ top: 0 }) }; this.contentEl = element('div'); }
  registerEvent() {}
  getState() { return {}; }
  async setState() {}
}
class MarkdownView {
  constructor(leaf) { this.leaf = leaf; this.app = leaf.app; this.file = null; this.containerEl = { isShown: () => leaf.shown(), toggleClass() {}, getBoundingClientRect: () => ({ top: 0 }) }; }
  getViewType() { return 'markdown'; }
  getState() { return this.file ? { file: this.file.path } : {}; }
  async setState(state) { this.file = (state?.file && this.app.vault.getAbstractFileByPath(state.file)) || null; }
}
class EmptyView { constructor(leaf) { this.leaf = leaf; this.containerEl = { isShown: () => leaf.shown(), getBoundingClientRect: () => ({ top: 0 }) }; } getViewType() { return 'empty'; } getState() { return {}; } async setState() {} }
const Component = class { load() {} unload() {} };
const MarkdownRenderer = { render: async (_app, markdown, el) => { el.rendered = markdown; } };

const bundle = load('tests/support-right-pane-entry.ts',
  { obsidian: { ...obsidian, ItemView, MarkdownView, View: class {}, Component, MarkdownRenderer, Notice: dom.makeNotice([]), Modal: dom.makeModal(), Setting, setTooltip() {} } },
  { createFragment: dom.createFragment, createSpan: value => make('span', typeof value === 'string' ? { cls: value } : value), createEl: (tag, value) => make(tag, value), requestAnimationFrame: run => { run(); return 1; }, cancelAnimationFrame() {} });
const { default: Plugin, VisualAgentMapView, LivingReaderView, LIVING_READER_VIEW } = bundle;

/** The workspace the pane lives in: one right dock (a tab group), leaves that really leave it on detach. */
function workspaceOf(app) {
  const types = { markdown: leaf => new MarkdownView(leaf), [LIVING_READER_VIEW]: leaf => new LivingReaderView(leaf), empty: leaf => new EmptyView(leaf) };
  const rightSplit = { collapsed: false, children: [], active: null, collapse() { this.collapsed = true; }, expand() { this.collapsed = false; } };
  class Leaf {
    constructor() { this.app = app; this.parent = rightSplit; this.view = new EmptyView(this); }
    // A detached leaf keeps its old parent pointer and view object in this stand-in: only the dock's children say it is gone.
    getRoot() { return this.parent; }
    shown() { return !rightSplit.collapsed && rightSplit.active === this && rightSplit.children.includes(this); }
    async setViewState({ type, state = {} }) {
      if (this.view.getViewType() !== type) {
        await this.view.onClose?.();
        this.view = types[type](this);
        await this.view.onOpen?.();
      }
      await this.view.setState(state, { history: false });
    }
    async openFile(file) { await this.setViewState({ type: 'markdown', state: { file: file.path } }); }
    getViewState() { return { type: this.view.getViewType(), state: this.view.getState() }; }
    detach() {
      rightSplit.children = rightSplit.children.filter(leaf => leaf !== this);
      if (rightSplit.active === this) rightSplit.active = rightSplit.children.at(-1) ?? null;
      void this.view.onClose?.();
    }
  }
  const newLeaf = () => { const leaf = new Leaf(); rightSplit.children.push(leaf); return leaf; };
  return {
    rightSplit, leftSplit: { collapsed: true, collapse() {}, expand() {} },
    getLeavesOfType: type => rightSplit.children.filter(leaf => leaf.view.getViewType() === type),
    iterateAllLeaves: callback => rightSplit.children.forEach(callback),
    getRightLeaf: () => newLeaf(),
    async revealLeaf(leaf) { rightSplit.collapsed = false; if (rightSplit.children.includes(leaf)) rightSplit.active = leaf; },
    trigger() {}, on: () => ({}), getActiveViewOfType: () => null, onLayoutReady: run => run(),
    // workspace:close (Cmd+W) closes the focused tab: here the pane's visible tab.
    closeActive() { rightSplit.active?.detach(); },
    /** workspace.json: what each leaf of the dock saves, and which tab was in front. */
    serialize() { return JSON.parse(JSON.stringify({ leaves: rightSplit.children.map(leaf => leaf.getViewState()), active: rightSplit.children.indexOf(rightSplit.active) })); },
    async restore(saved) {
      for (const state of saved.leaves) await newLeaf().setViewState(state);
      rightSplit.active = rightSplit.children[saved.active] ?? null;
    }
  };
}

const MAP = 'Agent Workspace/Topics/map-r/Map.md';
/** One running Obsidian: the vault (kept across a reopen), a plugin with its real sidebar, a map view with A, B (AI cards) and P. */
async function world(vault) {
  if (!vault) {
    const { repo, app, contents } = fixture('en');
    app.vault.on = () => ({});
    const settings = { ...DEFAULT_SETTINGS, language: 'en', cliModel: 'gpt-6-luna' };
    repo.settings = settings; app.scope = { appScope: true };
    const mapDoc = { id: 'map-r', title: 'Pane', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
    await repo.ensureTopicFolders('Agent Workspace/Topics/map-r');
    const ids = {};
    for (const [key, title] of [['A', 'Alpha'], ['B', 'Beta'], ['P', 'Plain']]) {
      const created = await repo.createNote(title, 'gpt-6-luna', mapDoc, MAP, 'workspace');
      Object.assign(created, { parentId: null, x: 80, y: 80 + mapDoc.nodes.length * 200 });
      mapDoc.nodes.push(created); ids[key] = created.id;
      if (key !== 'P') await repo.writeAiCard(created.path, true);
    }
    await app.vault.create(MAP, core.serializeMap(mapDoc));
    await repo.rebuildDerivedData();
    vault = { repo, app, contents, settings, ids };
  }
  const { repo, app, settings, ids } = vault;
  app.workspace = workspaceOf(app);
  const host = new Plugin(); host.app = app; host.repo = repo; host.settings = settings;
  const plugin = withExpansionCoordinator({
    repo, settings, running: new Set(), logs: { appendLog() {} }, rebuildDerivedData: () => repo.rebuildDerivedData(), expansionBatches: new Map(), pendingSuggestions: new Map(), releaseOutline() {}, setOutlineActive() {},
    recordFailure: (_l, e) => String(e?.message ?? e),
    // The plugin shell's own pane entries, unchanged: they forward to its NodeDetailsSidebar.
    detailsShown: () => host.detailsShown(), openDetails: (file, owner) => host.openDetails(file, owner),
    showLivingTrial: (...args) => host.showLivingTrial(...args), invalidateLivingTrial: owner => host.invalidateLivingTrial(owner),
    restoreLivingOfficial: (...args) => host.restoreLivingOfficial(...args), closeStaleDetails: () => host.closeStaleDetails(),
    mutate: async work => { await work(); }
  });
  const view = new VisualAgentMapView({ app }, plugin);
  const stage = make('div');
  view.path = MAP; view.map = await repo.readMap(MAP); view.stageEl = stage; view.contentEl = element('div');
  const overlay = element('div', { cls: 'vam-canvas-overlay' });
  overlay.ownerDocument = element('div'); overlay.clientWidth = 900;
  view.contentEl.appendChild(overlay);
  view.focusNode = () => {}; view.render = () => {};
  view.notes = new Map(await Promise.all(view.map.nodes.map(async n => [n.id, await repo.readNote(n.path)])));
  view.selection.resetTabStop(view.map.nodes.map(n => ({ id: n.id, parentId: null })));
  for (const n of view.map.nodes) view.renderNode(n);
  const node = key => view.map.nodes.find(n => n.id === ids[key]);
  const file = key => repo.file(node(key).path);
  const sidebar = host.nodeDetailsSidebar;
  const settle = async () => { for (let i = 0; i < 6; i++) { await sidebar.pending; await tick(); } };
  const click = async key => {
    view.onCardClick({ target: { closest: () => null }, metaKey: false, ctrlKey: false }, stage.children.find(c => c.dataset.nodeId === ids[key]), node(key));
    await settle();
  };
  const popover = () => view.aiCardOpen?.win.el;
  return { vault, app, host, view, node, file, settle, click, popover, ws: app.workspace };
}

/** What the right pane shows, read off the workspace. */
function pane(w) {
  const front = w.ws.rightSplit.active;
  const ours = w.ws.rightSplit.children.filter(leaf => leaf.view instanceof LivingReaderView || leaf.view instanceof MarkdownView);
  const empty = w.ws.rightSplit.children.filter(leaf => leaf.view instanceof LivingReaderView && !leaf.view.file);
  const name = path => (path === w.node('A').path ? 'A' : path === w.node('B').path ? 'B' : path === w.node('P').path ? 'P' : path);
  let shown = 'closed';
  if (front && w.ws.rightSplit.children.includes(front) && !w.ws.rightSplit.collapsed) {
    if (front.view instanceof LivingReaderView && front.view.file) shown = `reader:${name(front.view.file.path)}`;
    else if (front.view instanceof MarkdownView && front.view.file) shown = `${name(front.view.file.path) === 'P' ? 'native' : 'editor'}:${name(front.view.file.path)}`;
    else shown = 'blank';
  }
  return { shown, leaves: ours.length, empty: empty.length };
}

const pressOpenInEditor = async w => {
  const reader = w.ws.rightSplit.active.view;
  const button = findAll(reader.contentEl, i => i.tag === 'button' && i.text === 'Open in editor')[0];
  assert.ok(button, 'the reader has its "Open in editor" button');
  button.click();
  await w.settle();
};
const openAiEditor = async w => { w.view.openAiCardPopover(w.node('A')); await w.settle(); };
const closeAiEditor = async w => { if (w.popover()) { w.popover().keydown({ key: 'Escape' }); await w.settle(); } };

/** The starting states. Each starts from a pane the user opened once (the 「筆記」 button), then card A selected. */
const states = {
  reader: async w => {},
  'native editor': async w => { await pressOpenInEditor(w); },
  'AI editor open': async w => { await openAiEditor(w); },
  'AI editor over native editor': async w => { await pressOpenInEditor(w); await openAiEditor(w); },
  blank: async w => { await pressOpenInEditor(w); w.ws.closeActive(); await w.settle(); }
};
const entered = { reader: 'reader:A', 'native editor': 'editor:A', 'AI editor open': 'reader:A', 'AI editor over native editor': 'reader:A', blank: 'closed' };

const reopen = async w => {
  const saved = w.ws.serialize();
  const next = await world(w.vault);
  await next.ws.restore(saved);
  // The plugin's layout-ready step; main.ts runs the same call from onLayoutReady.
  next.host.nodeDetailsSidebar.closeEmptyReaders();
  await next.settle();
  return next;
};
const events = {
  'select same card': async w => { await w.click('A'); return w; },
  'select other AI card': async w => { await w.click('B'); return w; },
  'select ordinary card': async w => { await w.click('P'); return w; },
  'Cmd+W': async w => { w.ws.closeActive(); await w.settle(); return w; },
  'leaf.detach()': async w => { w.ws.rightSplit.children.at(0)?.detach(); await w.settle(); return w; },
  'close AI editor': async w => { await closeAiEditor(w); return w; },
  'reopen Obsidian': reopen
};

// Expected pane after each transition. An AI card reads in the reader; an ordinary card natively; the native editor stays
// only when the user opened it for that card and selects that same card again (D1-x11b). A closed pane leaves no leaf,
// and a pane the user closed (Cmd+W, detach; the blank state) stays closed when a card is selected (D1-x11d).
const table = {
  reader: ['reader:A', 'reader:B', 'native:P', 'closed', 'closed', 'reader:A', 'reader:A'],
  'native editor': ['editor:A', 'reader:B', 'native:P', 'closed', 'closed', 'editor:A', 'editor:A'],
  'AI editor open': ['reader:A', 'reader:B', 'native:P', 'closed', 'closed', 'reader:A', 'reader:A'],
  'AI editor over native editor': ['reader:A', 'reader:B', 'native:P', 'closed', 'closed', 'reader:A', 'reader:A'],
  blank: ['closed', 'closed', 'closed', 'closed', 'closed', 'closed', 'closed']
};

test('D1-x11c: every pane state × event lands on the reader for an AI card (state-transition table)', async () => {
  const failures = [];
  for (const [state, expected] of Object.entries(table)) {
    for (const [index, [event, run]] of Object.entries(events).entries()) {
      const label = `${state} × ${event}`;
      let w = await world();
      await w.host.openDetails(w.file('A')); // the 「筆記」 button: the pane is open and follows the selection
      await w.click('A');
      await states[state](w);
      const start = pane(w).shown;
      if (start !== entered[state]) { failures.push(`${label}: state entered as ${start}, expected ${entered[state]}`); continue; }
      w = await run(w);
      const after = pane(w);
      if (after.shown !== expected[index]) failures.push(`${label}: ${after.shown}, expected ${expected[index]}`);
      if (after.empty) failures.push(`${label}: ${after.empty} empty reader leaf left in the dock`);
      if (after.leaves > 1) failures.push(`${label}: ${after.leaves} pane leaves`);
      // Recovery: from wherever the pane landed, the next selections read normally again. A pane the user closed stays
      // closed (D1-x11d), unless the AI editor was still open: closing it returns to its card's reader.
      const aiEditorOpen = !!w.popover();
      await closeAiEditor(w);
      const userClosed = state === 'blank' || event === 'Cmd+W' || event === 'leaf.detach()';
      const followsSelection = !userClosed || aiEditorOpen;
      if (pane(w).shown === 'closed' && followsSelection) failures.push(`${label} → close AI editor: closed, expected the reader`);
      if (followsSelection) {
        await w.click('B');
        if (pane(w).shown !== 'reader:B') failures.push(`${label} → select other AI card: ${pane(w).shown}, expected reader:B`);
        await w.click('A');
        if (pane(w).shown !== 'reader:A') failures.push(`${label} → select A again: ${pane(w).shown}, expected reader:A`);
      } else {
        await w.click('B');
        if (pane(w).shown !== 'closed') failures.push(`${label} → select: ${pane(w).shown}, expected the closed pane to stay closed`);
      }
      const saved = w.ws.serialize();
      for (const leaf of saved.leaves)
        if (leaf.type === LIVING_READER_VIEW && typeof leaf.state.file !== 'string') failures.push(`${label}: workspace.json would save an empty reader leaf`);
    }
  }
  assert.deepEqual(failures, []);
});

test('D1-x11c: a restored reader shows its card; a stale or empty one closes itself instead of staying blank', async () => {
  const w = await world();
  await w.host.openDetails(w.file('A'));
  const saved = w.ws.serialize();
  assert.deepEqual(saved.leaves.map(leaf => leaf.type), [LIVING_READER_VIEW]);
  assert.equal(saved.leaves[0].state.file, w.node('A').path, 'the reader saves which card it shows');
  // An old workspace.json: four empty reader leaves (state {}) and one pointing at a note that is gone.
  const broken = { leaves: [...Array(4)].map(() => ({ type: LIVING_READER_VIEW, state: {} })).concat({ type: LIVING_READER_VIEW, state: { file: 'gone.md' } }), active: 0 };
  const next = await world(w.vault);
  await next.ws.restore(broken);
  next.host.nodeDetailsSidebar.closeEmptyReaders();
  assert.equal(next.ws.rightSplit.children.length, 0, 'no empty reader survives the layout-ready step');
  const good = await world(w.vault);
  await good.ws.restore(saved);
  good.host.nodeDetailsSidebar.closeEmptyReaders();
  assert.equal(pane(good).shown, 'reader:A', 'a restored reader shows its card at once');
  await good.click('B');
  assert.deepEqual(pane(good), { shown: 'reader:B', leaves: 1, empty: 0 }, 'the restored reader is reused, not joined by a new one');
  const main = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'main.ts'), 'utf8');
  assert.match(main, /onLayoutReady\(\(\) => this\.nodeDetailsSidebar\.closeEmptyReaders\(\)\)/, 'the plugin runs the step when the layout is ready');
});

test('D1-x11d: after Cmd+W an ordinary and an AI card both stay closed on select and both reopen via 「筆記」', async () => {
  for (const [key, opened] of [['P', 'native:P'], ['A', 'reader:A']]) {
    const w = await world();
    await w.click(key);
    assert.equal(pane(w).shown, 'closed', `${key}: a selection alone does not open the pane`);
    // The explicit entry: the card's Note action (toolbar 「筆記」, ⋯, context menu, command "open selected details").
    assert.equal(w.view.mapCommand('open-details', false), true, `${key}: the open-details command runs`);
    await w.settle();
    assert.equal(pane(w).shown, opened, `${key}: the explicit entry opens the pane`);
    w.ws.closeActive(); // Cmd+W
    await w.settle();
    assert.equal(pane(w).shown, 'closed', `${key}: Cmd+W closes the pane`);
    for (const next of [key, key === 'P' ? 'A' : 'P', key]) {
      await w.click(next);
      assert.deepEqual(pane(w), { shown: 'closed', leaves: 0, empty: 0 }, `${key} closed → select ${next}: the pane stays closed`);
    }
    w.view.mapCommand('open-details', false);
    await w.settle();
    assert.deepEqual(pane(w), { shown: opened, leaves: 1, empty: 0 }, `${key}: the explicit entry reopens the pane after Cmd+W`);
    await w.click(key === 'P' ? 'A' : 'P');
    assert.equal(pane(w).shown, key === 'P' ? 'reader:A' : 'native:P', `${key}: the reopened pane follows the selection again`);
  }
});
