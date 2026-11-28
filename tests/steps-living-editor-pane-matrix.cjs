// D1 §23: the AI editor, the side panels and the right pane as one state machine, on one faithful world. The real plugin
// shell (its NodeDetailsSidebar), the real map view with its real AI editor popover and side-panel room, and the real
// Living reader run on a workspace stand-in whose left and right splits fold and unfold, fire `resize` and `layout-change`
// on a microtask, whose revealLeaf unfolds a folded split, whose detach / Cmd+W fire `layout-change`, and which saves and
// restores its leaves (deferred ones and `{}` too). The central pane is the window minus 300px per unfolded side panel.
// Only the AI transport is stubbed. Invariants (agents-spec d1-editor-sidebar-state.md §3):
//   I1 an AI card reads in the reader, except a native editor the user opened for that same card;
//   I2 a pane the user hid stays hidden until 「筆記」 or the user; the trial preview unfolds it and closing folds it back;
//   I3 on close every side panel is as when the editor opened, or as the user last set it; nothing unfolds after that;
//   I4 after layout-ready no `{}` reader is saved;  I5 while the editor is open the central pane keeps 320px (W1, W2);
//   I6 nothing takes the focus.
// Matrix A (side panels) folds in D1-x10d's 36-cell matrix (and its D1-x10e closing reveal); Matrix B (right pane) folds
// in D1-x11c's 5×7 state-transition table.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { load, core, fixture, DEFAULT_SETTINGS, obsidian, withExpansionCoordinator, attachTopicRuns } = require('./support.cjs');
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

// Obsidian's views, as far as the pane uses them: a view is shown only while its leaf is the right dock's front tab.
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
  { createFragment: dom.createFragment, CSS: { escape: v => v }, createSvg: dom.createSvg, createSpan: value => make('span', typeof value === 'string' ? { cls: value } : value), createEl: (tag, value) => make(tag, value), requestAnimationFrame: run => { run(); return 1; }, cancelAnimationFrame() {} });
const { default: Plugin, VisualAgentMapView, LivingReaderView, LIVING_READER_VIEW } = bundle;

const PANEL = 300;
/**
 * The workspace: a left and a right split that fold and unfold like Obsidian's (resize + layout-change on a microtask), one
 * right dock (a tab group) whose leaves really leave it on detach, and workspace.json through serialize / restore.
 */
function workspaceOf(app, host, width, log) {
  const listeners = new Map();
  const trigger = (name, ...args) => { for (const fn of [...(listeners.get(name) ?? [])]) fn(...args); };
  const soon = (...names) => queueMicrotask(() => names.forEach(name => trigger(name)));
  const split = (name, collapsed) => ({
    name, collapsed, children: [], active: null,
    collapse() { if (this.collapsed) return; this.collapsed = true; log.changes.push(`${name}:fold`); soon('resize', 'layout-change'); },
    expand() { if (!this.collapsed) return; this.collapsed = false; log.changes.push(`${name}:unfold`); soon('resize', 'layout-change'); }
  });
  const leftSplit = split('left', false), rightSplit = split('right', false);
  // The reader as the plugin registers it (main.ts registerView); markdown and empty views as Obsidian makes them.
  const types = { markdown: leaf => new MarkdownView(leaf), [LIVING_READER_VIEW]: leaf => host.nodeDetailsSidebar.createReader?.(leaf) ?? new LivingReaderView(leaf), empty: leaf => new EmptyView(leaf) };
  class Leaf {
    constructor() { this.app = app; this.parent = rightSplit; this.view = new EmptyView(this); }
    // A detached leaf keeps its old parent pointer and view object in this stand-in: only the dock's children say it is gone.
    getRoot() { return this.parent; }
    shown() { return !rightSplit.collapsed && rightSplit.active === this && rightSplit.children.includes(this); }
    async setViewState({ type, state = {}, active }) {
      if (active) log.focus.push(`setViewState active ${type}`);
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
      if (!rightSplit.children.includes(this)) return;
      rightSplit.children = rightSplit.children.filter(leaf => leaf !== this);
      if (rightSplit.active === this) rightSplit.active = rightSplit.children.at(-1) ?? null;
      void this.view.onClose?.();
      soon('layout-change');
    }
  }
  const newLeaf = () => { const leaf = new Leaf(); rightSplit.children.push(leaf); rightSplit.active ??= leaf; soon('layout-change'); return leaf; };
  return {
    leftSplit, rightSplit, rootSplit: {}, width,
    /** The central pane: the window minus each unfolded side panel. */
    central() { return Math.max(0, this.width - (leftSplit.collapsed ? 0 : PANEL) - (rightSplit.collapsed ? 0 : PANEL)); },
    getLeavesOfType: type => rightSplit.children.filter(leaf => leaf.view.getViewType() === type),
    iterateAllLeaves: callback => rightSplit.children.forEach(callback),
    getRightLeaf: () => newLeaf(),
    // Obsidian's revealLeaf: unfolds the folded split the leaf is in, brings its tab to the front, then the layout resizes.
    async revealLeaf(leaf) {
      if (!rightSplit.children.includes(leaf)) return;
      if (rightSplit.collapsed) rightSplit.expand();
      rightSplit.active = leaf;
      soon('resize');
    },
    setActiveLeaf(_leaf, options) { log.focus.push(`setActiveLeaf ${JSON.stringify(options ?? {})}`); },
    on(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); return { name, fn }; },
    offref() {}, trigger, getActiveViewOfType: () => null, onLayoutReady: run => run(), requestSaveLayout() {},
    // workspace:close (Cmd+W) closes the focused tab: here the pane's front tab.
    closeActive() { rightSplit.active?.detach(); },
    /** workspace.json: what each leaf of the dock saves, which tab was in front, and which splits were folded. */
    serialize() { return JSON.parse(JSON.stringify({ leaves: rightSplit.children.map(leaf => leaf.getViewState()), active: rightSplit.children.indexOf(rightSplit.active), left: leftSplit.collapsed, right: rightSplit.collapsed })); },
    /** A restored leaf of a background tab stays deferred (an empty view) until it is shown, as Obsidian 1.7 does. */
    async restore(saved) {
      leftSplit.collapsed = saved.left; rightSplit.collapsed = saved.right;
      rightSplit.children = []; rightSplit.active = null;
      for (const [index, state] of saved.leaves.entries()) {
        const leaf = new Leaf(); rightSplit.children.push(leaf);
        if (index === saved.active) await leaf.setViewState(state);
        else leaf.deferred = state;
      }
      rightSplit.active = rightSplit.children[saved.active] ?? null;
    }
  };
}

const MAP = 'Agent Workspace/Topics/map-r/Map.md';
/** One running Obsidian: the vault (kept across a reopen), the plugin with its real pane, the map view with A, B (AI cards) and P. */
async function world({ vault, width = 1024 } = {}) {
  if (!vault) {
    const { repo, app, contents } = fixture('en');
    app.vault.on = () => ({}); app.vault.offref = () => {};
    const settings = { ...DEFAULT_SETTINGS, language: 'en', cliModel: 'gpt-6-luna', cliReasoning: 'low' };
    repo.settings = settings; app.scope = { appScope: true };
    const mapDoc = { id: 'map-r', title: 'Pane', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
    await repo.ensureTopicFolders('Agent Workspace/Topics/map-r');
    const ids = {};
    for (const [key, title] of [['A', 'Alpha'], ['B', 'Beta'], ['P', 'Plain']]) {
      const created = await repo.createNote(title, 'gpt-6-luna', mapDoc, MAP, 'workspace');
      Object.assign(created, { parentId: null, x: 80, y: 80 + mapDoc.nodes.length * 200 });
      mapDoc.nodes.push(created); ids[key] = created.id;
      if (key !== 'P') { await repo.updateNote(created.path, { prompt: `Why ${title}?` }); await repo.writeAiCard(created.path, true); }
    }
    await app.vault.create(MAP, core.serializeMap(mapDoc));
    await repo.rebuildDerivedData();
    vault = { repo, app, contents, settings, ids };
  }
  const { repo, app, settings, ids } = vault;
  const log = { changes: [], focus: [] };
  const host = new Plugin(); host.app = app; host.repo = repo; host.settings = settings;
  app.workspace = workspaceOf(app, host, width, log);
  const ws = app.workspace;
  // main.ts onload: the pane notices a tab the user closed on layout-change.
  ws.on('layout-change', () => host.nodeDetailsSidebar.layoutChanged?.());
  const plugin = attachTopicRuns(withExpansionCoordinator({
    repo, settings, running: new Set(), logs: { appendLog() {} }, rebuildDerivedData: () => repo.rebuildDerivedData(), expansionBatches: new Map(), pendingSuggestions: new Map(), pendingResearchOptions: new Map(), releaseOutline() {}, setOutlineActive() {}, views: () => [],
    recordFailure: (_l, e) => String(e?.message ?? e),
    mutate: async work => { await work(); },
    confirmAiUsage: async (_model, run) => { await run(); return true; }
  }));
  // The plugin shell's own pane entries, unchanged: they forward to its NodeDetailsSidebar.
  for (const name of ['detailsShown', 'openDetails', 'showLivingTrial', 'invalidateLivingTrial', 'restoreLivingOfficial', 'closeStaleDetails', 'useSidePanelRoom', 'onDetailsReveal', 'detailsRevealing'])
    if (typeof host[name] === 'function') plugin[name] = (...args) => host[name](...args);
  // Only the AI transport is stubbed: a trial of a card answers "Result: <title>".
  plugin.aiCalls = { run: async (prepared, options, finish) => {
    const input = prepared.input;
    const title = JSON.parse(input.context).documents[0].title;
    if (options.signal.aborted) throw new Error('stopped');
    return finish(JSON.stringify({ baseRevision: input.base.revision, requiresWeb: false, operations: [{ kind: 'output', text: `Result: ${title}`, evidence: [] }] }), { signal: options.signal, parsed() {} });
  } };
  const view = new VisualAgentMapView({ app }, plugin);
  view.armHighlightFade = () => {};
  view.registerEvent = () => {};
  const stage = make('div');
  view.path = MAP; view.map = await repo.readMap(MAP); view.stageEl = stage; view.contentEl = element('div');
  view.viewportEl = element('div');
  view.viewportEl.getBoundingClientRect = () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 });
  view.readMapSourceGroups = async () => [];
  view.readLivingMapSourceReport = async () => ({ groups: [], unavailable: 0 });
  const overlay = element('div', { cls: 'vam-canvas-overlay' });
  overlay.ownerDocument = element('div');
  Object.defineProperty(overlay, 'clientWidth', { get: () => ws.central() });
  view.contentEl.appendChild(overlay);
  view.focusNode = () => {}; view.render = () => {}; view.restoreMapFocusSoon = () => {};
  const hydrate = async () => { view.notes = new Map(await Promise.all(view.map.nodes.map(async n => [n.id, await repo.readNote(n.path, view.map)]))); };
  await hydrate();
  view.hydrate = hydrate;
  view.refreshAfterSavedChange = hydrate;
  view.selection.resetTabStop(view.map.nodes.map(n => ({ id: n.id, parentId: null })));
  for (const n of view.map.nodes) view.renderNode(n);
  // The view's own workspace listeners (resize → room for the editor; layout-change), as onOpen registers them.
  view.registerWorkspaceEvents();
  const node = key => view.map.nodes.find(n => n.id === ids[key]);
  const file = key => repo.file(node(key).path);
  const sidebar = host.nodeDetailsSidebar;
  const settle = async () => { for (let i = 0; i < 8; i++) { await sidebar.pending; await tick(); } await new Promise(resolve => setTimeout(resolve, 0)); for (let i = 0; i < 4; i++) { await sidebar.pending; await tick(); } };
  const click = async key => {
    view.onCardClick({ target: { closest: () => null }, metaKey: false, ctrlKey: false }, stage.children.find(c => c.dataset.nodeId === ids[key]), node(key));
    await settle();
  };
  const popover = () => view.aiCardOpen?.win.el;
  const button = text => findAll(popover(), i => i.tag === 'button' && i.text === text)[0];
  return { vault, app, host, view, node, file, settle, click, popover, button, ws, log };
}

const name = (w, p) => (p === w.node('A').path ? 'A' : p === w.node('B').path ? 'B' : p === w.node('P').path ? 'P' : p);
/** What the right pane holds (whether or not its side panel is folded), read off the workspace. */
function content(w) {
  const ours = w.ws.rightSplit.children.filter(leaf => leaf.view instanceof LivingReaderView || leaf.view instanceof MarkdownView || leaf.deferred);
  if (!ours.length) return 'none';
  const front = w.ws.rightSplit.active;
  if (!ours.includes(front)) return 'background';
  if (front.view instanceof LivingReaderView) return front.view.file ? `${front.view.tab === 'trial' ? 'trial' : 'reader'}:${name(w, front.view.file.path)}` : 'blank';
  if (front.view instanceof MarkdownView && front.view.file) return `${name(w, front.view.file.path) === 'P' ? 'native' : 'editor'}:${name(w, front.view.file.path)}`;
  return 'blank';
}
/** The pane as the user sees it: what it holds, `hidden` behind a folded side panel. */
const pane = w => { const c = content(w); return c !== 'none' && w.ws.rightSplit.collapsed ? `hidden ${c}` : c; };
const paneLeaves = w => w.ws.rightSplit.children.filter(leaf => leaf.view instanceof LivingReaderView || leaf.view instanceof MarkdownView).length;
const emptyReaders = w => w.ws.serialize().leaves.filter(leaf => leaf.type === LIVING_READER_VIEW && typeof leaf.state.file !== 'string').length;

const pressOpenInEditor = async w => {
  const reader = w.ws.rightSplit.active.view;
  const button = findAll(reader.contentEl, i => i.tag === 'button' && i.text === 'Open in editor')[0];
  assert.ok(button, 'the reader has its "Open in editor" button');
  button.click();
  await w.settle();
};
const openAiEditor = async (w, key = 'A') => { if (!w.popover()) { w.view.openAiCardPopover(w.node(key)); await w.settle(); } };
const closeAiEditor = async w => { if (w.popover()) { w.popover().keydown({ key: 'Escape' }); await w.settle(); } };
const runTrial = async w => {
  await openAiEditor(w);
  w.button('Try prompt').click();
  for (let i = 0; i < 200 && !(w.view.aiCardOpen?.trial.state === 'ready' && content(w).startsWith('trial:')); i++) await w.settle();
  assert.equal(w.view.aiCardOpen?.trial.state, 'ready', 'the trial is ready');
};
const adoptTrial = async w => {
  await runTrial(w);
  w.button('Adopt trial').click();
  for (let i = 0; i < 200 && !w.vault.contents.get(w.node('A').path).includes('Result: Alpha'); i++) await w.settle();
  await w.settle();
  assert.ok(w.vault.contents.get(w.node('A').path).includes('Result: Alpha'), 'the trial was written to the card');
};
const reopen = async w => {
  const saved = w.ws.serialize();
  const next = await world({ vault: w.vault, width: w.ws.width });
  await next.ws.restore(saved);
  // The plugin's layout-ready step; main.ts runs the same call from onLayoutReady.
  next.host.nodeDetailsSidebar.closeEmptyReaders();
  await next.settle();
  return next;
};

// ---- Matrix A: the side panels --------------------------------------------------------------------------------------
// window {600 (W0), 650, 700 (W1), 1024 (W2)} × left {open, folded} × right {open, folded, pane closed (Cmd+W)} ×
// the user while the editor is open {nothing, toggles left, toggles right} × pane path {none, trial, trial + adopt,
// 「在編輯器開啟」 before the editor}.
const WIDTHS = [600, 650, 700, 1024];
const PATHS = ['none', 'trial', 'trial+adopt', 'open in editor first'];
for (const width of WIDTHS)
  for (const leftStart of ['open', 'folded'])
    for (const rightStart of ['open', 'folded', 'pane closed'])
      for (const user of ['none', 'left', 'right'])
        for (const route of PATHS)
          test(`D1 §23 matrix A: ${width}px, left ${leftStart}, right ${rightStart}, user toggles ${user}, ${route}`, async () => {
            const w = await world({ width });
            const { leftSplit: left, rightSplit: right } = w.ws;
            const failures = [];
            await w.host.openDetails(w.file('A')); // the 「筆記」 button: the pane is open and follows the selection
            await w.click('A');
            if (route === 'open in editor first') await pressOpenInEditor(w);
            if (rightStart === 'folded') right.collapse();
            if (rightStart === 'pane closed') w.ws.closeActive();
            if (leftStart === 'folded') left.collapse();
            await w.settle();
            const before = { left: left.collapsed, right: right.collapsed };
            const held = content(w);
            w.log.changes.length = 0;

            await openAiEditor(w);
            // I5: the editor keeps 320px in a window that can give it (W1, W2).
            if (width >= 650 && w.ws.central() < 320) failures.push(`open: central pane ${w.ws.central()}px`);
            // I2: opening the editor never unfolds a panel; a pane the user hid or closed stays so.
            if (w.log.changes.some(change => change.endsWith(':unfold'))) failures.push(`open unfolded: ${w.log.changes}`);
            if (rightStart === 'pane closed' && content(w) !== 'none') failures.push(`open: the closed pane became ${pane(w)}`);
            if (rightStart === 'folded' && content(w) !== held) failures.push(`open: the hidden pane changed from ${held} to ${content(w)}`);
            if (rightStart === 'open' && content(w) !== 'reader:A') failures.push(`open: the pane shows ${pane(w)}, expected reader:A`);

            if (route.startsWith('trial')) {
              await runTrial(w);
              // living-node.md L180: the preview shows itself, also in a pane the user hid or closed.
              if (pane(w) !== 'trial:A') failures.push(`trial: the pane shows ${pane(w)}, expected trial:A`);
              if (width >= 650 && w.ws.central() < 320) failures.push(`trial: central pane ${w.ws.central()}px`);
            }
            if (route === 'trial+adopt') {
              await adoptTrial(w);
              if (pane(w) !== 'reader:A') failures.push(`adopt: the pane shows ${pane(w)}, expected reader:A`);
              const rendered = findAll(w.ws.rightSplit.active.view.contentEl, i => typeof i.rendered === 'string')[0]?.rendered ?? '';
              if (!rendered.includes('Result: Alpha')) failures.push('adopt: the reader does not show the adopted text');
            }

            const userSet = {};
            if (user !== 'none') {
              const split = user === 'left' ? left : right;
              if (split.collapsed) split.expand(); else split.collapse();
              userSet[user] = split.collapsed;
              await w.settle();
              await w.view.makeRoomForAiCard();
            }

            await closeAiEditor(w);
            if (w.view.aiCardOpen !== null) failures.push('the editor did not close');
            // I3: each panel as when the editor opened, or as the user last set it.
            const expected = { left: userSet.left ?? before.left, right: userSet.right ?? before.right };
            const after = { left: left.collapsed, right: right.collapsed };
            if (JSON.stringify(after) !== JSON.stringify(expected)) failures.push(`close: panels ${JSON.stringify(after)}, expected ${JSON.stringify(expected)}`);
            // I3: nothing unfolds once the panels were given back.
            const settled = w.log.changes.length;
            await w.settle(); await w.settle();
            if (w.log.changes.length !== settled) failures.push(`after close: ${w.log.changes.slice(settled)}`);
            // I2 / I1: a closed pane is closed again; an open one reads its AI card (or keeps the native editor the user opened).
            const keptNative = route === 'open in editor first' && rightStart === 'folded';
            const want = rightStart === 'pane closed' ? 'none' : keptNative ? 'editor:A' : 'reader:A';
            if (content(w) !== want) failures.push(`close: the pane holds ${content(w)}, expected ${want}`);
            if (paneLeaves(w) > 1) failures.push(`${paneLeaves(w)} pane leaves`);
            if (emptyReaders(w)) failures.push('an empty reader would be saved');
            // I6
            if (w.log.focus.length) failures.push(`focus taken: ${w.log.focus}`);
            assert.deepEqual(failures, []);
          });

// D1 §23 B1: editor A open, the user presses edit on card B. A closes first (its pane given back, a leaf its trial made
// removed, its side panels given back), then B opens on that state: B keeps its room and reads B; closing B gives the
// panels back as they were before A opened.
for (const width of [600, 700, 1024])
  for (const leftStart of ['open', 'folded'])
    for (const rightStart of ['open', 'folded', 'pane closed'])
      for (const route of ['none', 'trial', 'trial+adopt'])
        test(`D1 §23 B1: ${width}px, left ${leftStart}, right ${rightStart}, A ${route} → open B directly`, async () => {
          const w = await world({ width });
          const { leftSplit: left, rightSplit: right } = w.ws;
          const failures = [];
          await w.host.openDetails(w.file('A'));
          await w.click('A');
          if (rightStart === 'folded') right.collapse();
          if (rightStart === 'pane closed') w.ws.closeActive();
          if (leftStart === 'folded') left.collapse();
          await w.settle();
          const before = { left: left.collapsed, right: right.collapsed };
          const held = content(w);

          await openAiEditor(w);
          if (route.startsWith('trial')) await runTrial(w);
          if (route === 'trial+adopt') await adoptTrial(w);

          w.view.openAiCardPopover(w.node('B'));
          await w.settle(); await w.settle();
          if (w.view.aiCardOpen?.nodeId !== w.node('B').id) failures.push('B did not open');
          // I5 while B is open.
          if (width >= 650 && w.ws.central() < 320) failures.push(`B open: central pane ${w.ws.central()}px`);
          // B's reader (an open pane: behind a panel the room folded at most); a hidden or closed pane stays so (I2).
          if (rightStart === 'open' && (content(w) !== 'reader:B' || !w.host.detailsShown())) failures.push(`B open: the pane shows ${pane(w)}, expected reader:B`);
          if (rightStart === 'folded' && pane(w) !== `hidden ${held}`) failures.push(`B open: the pane shows ${pane(w)}, expected hidden ${held}`);
          if (rightStart === 'pane closed' && content(w) !== 'none') failures.push(`B open: the closed pane holds ${pane(w)} (A's trial leaf left)`);

          await closeAiEditor(w);
          if (w.view.aiCardOpen !== null) failures.push('B did not close');
          const after = { left: left.collapsed, right: right.collapsed };
          if (JSON.stringify(after) !== JSON.stringify(before)) failures.push(`B closed: panels ${JSON.stringify(after)}, expected ${JSON.stringify(before)}`);
          const settled = w.log.changes.length;
          await w.settle(); await w.settle();
          if (w.log.changes.length !== settled) failures.push(`after close: ${w.log.changes.slice(settled)}`);
          // As when B alone opens and closes: its official note goes back in the pane (also behind a folded panel).
          const want = rightStart === 'pane closed' ? 'none' : 'reader:B';
          if (content(w) !== want) failures.push(`B closed: the pane holds ${content(w)}, expected ${want}`);
          if (paneLeaves(w) > 1) failures.push(`${paneLeaves(w)} pane leaves`);
          if (emptyReaders(w)) failures.push('an empty reader would be saved');
          if (w.log.focus.length) failures.push(`focus taken: ${w.log.focus}`);
          assert.deepEqual(failures, []);
        });

// ---- Matrix B: the right pane ---------------------------------------------------------------------------------------
// Each state starts from a pane the user opened once (the 「筆記」 button), then card A selected.
const states = {
  reader: async () => {},
  'native editor': async w => { await pressOpenInEditor(w); },
  'AI editor open': async w => { await openAiEditor(w); },
  'AI editor over native editor': async w => { await pressOpenInEditor(w); await openAiEditor(w); },
  blank: async w => { await pressOpenInEditor(w); w.ws.closeActive(); await w.settle(); },
  'hidden by the user': async w => { w.ws.rightSplit.collapse(); await w.settle(); },
  // 600px with both panels open: the editor folds the left, then the right, to keep its room.
  'hidden by the room': async w => { await openAiEditor(w); await w.view.makeRoomForAiCard(); await w.settle(); }
};
const entered = { reader: 'reader:A', 'native editor': 'editor:A', 'AI editor open': 'reader:A', 'AI editor over native editor': 'reader:A', blank: 'none', 'hidden by the user': 'hidden reader:A', 'hidden by the room': 'hidden reader:A' };
const events = {
  'select same card': async w => { await w.click('A'); return w; },
  'select other AI card': async w => { await w.click('B'); return w; },
  'select ordinary card': async w => { await w.click('P'); return w; },
  'Cmd+W': async w => { w.ws.closeActive(); await w.settle(); return w; },
  'leaf.detach()': async w => { w.ws.rightSplit.children.at(0)?.detach(); await w.settle(); return w; },
  'close AI editor': async w => { await closeAiEditor(w); return w; },
  'reopen Obsidian': reopen,
  'open AI editor': async w => { await openAiEditor(w); return w; },
  trial: async w => { await runTrial(w); return w; },
  adopt: async w => { await adoptTrial(w); return w; },
  '「筆記」': async w => { w.view.selection.setSelected(w.node('A').id); assert.equal(w.view.mapCommand('open-details', false), true); await w.settle(); return w; }
};
// Expected pane after each event, in the order of `events`. An AI card reads in the reader, an ordinary card natively; the
// native editor stays only when the user opened it for that card and selects it again (D1-x11b). A pane the user closed or
// hid stays so on selection (D1-x11d) and when the editor opens or closes; the trial preview shows itself (L180).
const table = {
  reader: ['reader:A', 'reader:B', 'native:P', 'none', 'none', 'reader:A', 'reader:A', 'reader:A', 'trial:A', 'reader:A', 'reader:A'],
  'native editor': ['editor:A', 'reader:B', 'native:P', 'none', 'none', 'editor:A', 'editor:A', 'reader:A', 'trial:A', 'reader:A', 'editor:A'],
  'AI editor open': ['reader:A', 'reader:B', 'native:P', 'none', 'none', 'reader:A', 'reader:A', 'reader:A', 'trial:A', 'reader:A', 'reader:A'],
  'AI editor over native editor': ['reader:A', 'reader:B', 'native:P', 'none', 'none', 'reader:A', 'reader:A', 'reader:A', 'trial:A', 'reader:A', 'reader:A'],
  blank: ['none', 'none', 'none', 'none', 'none', 'none', 'none', 'none', 'trial:A', 'reader:A', 'reader:A'],
  'hidden by the user': ['hidden reader:A', 'hidden reader:A', 'hidden reader:A', 'none', 'none', 'hidden reader:A', 'hidden reader:A', 'hidden reader:A', 'trial:A', 'reader:A', 'reader:A'],
  'hidden by the room': ['hidden reader:A', 'hidden reader:B', 'hidden native:P', 'none', 'none', 'reader:A', 'hidden reader:A', 'hidden reader:A', 'trial:A', 'reader:A', 'reader:A']
};

for (const [state, expected] of Object.entries(table))
  for (const [index, [event, run]] of Object.entries(events).entries())
    test(`D1 §23 matrix B: ${state} × ${event}`, async () => {
      const failures = [];
      let w = await world({ width: state === 'hidden by the room' ? 600 : 1024 });
      await w.host.openDetails(w.file('A')); // the 「筆記」 button: the pane is open and follows the selection
      await w.click('A');
      await states[state](w);
      assert.equal(pane(w), entered[state], `${state}: entered`);
      w = await run(w);
      if (pane(w) !== expected[index]) failures.push(`${pane(w)}, expected ${expected[index]}`);
      if (emptyReaders(w)) failures.push(`${emptyReaders(w)} empty reader leaf would be saved`);
      if (paneLeaves(w) > 1) failures.push(`${paneLeaves(w)} pane leaves`);
      // Recovery: once the editor is closed, a pane that follows the selection reads the next cards normally; one the user
      // closed or hid stays as it is.
      await closeAiEditor(w);
      const follows = w.host.detailsShown();
      await w.click('B');
      if (follows && pane(w) !== 'reader:B') failures.push(`→ select B: ${pane(w)}, expected reader:B`);
      if (!follows && content(w) === 'reader:B') failures.push(`→ select B: the pane the user closed or hid followed the selection`);
      await w.click('A');
      if (follows && pane(w) !== 'reader:A') failures.push(`→ select A again: ${pane(w)}, expected reader:A`);
      if (emptyReaders(w)) failures.push('workspace.json would save an empty reader leaf');
      if (w.log.focus.length) failures.push(`focus taken: ${w.log.focus}`);
      assert.deepEqual(failures, []);
    });

// ---- Restore and the explicit entry (D1-x11c, D1-x11d) ----------------------------------------------------------------
test('D1-x11c: a restored reader shows its card; a stale, empty or deferred-empty one closes itself instead of staying blank (I4)', async () => {
  const w = await world();
  await w.host.openDetails(w.file('A'));
  const saved = w.ws.serialize();
  assert.deepEqual(saved.leaves.map(leaf => leaf.type), [LIVING_READER_VIEW]);
  assert.equal(saved.leaves[0].state.file, w.node('A').path, 'the reader saves which card it shows');
  // An old workspace.json: four empty reader leaves (state {}), the first in front, the rest deferred, and one pointing at a note that is gone.
  const broken = { leaves: [...Array(4)].map(() => ({ type: LIVING_READER_VIEW, state: {} })).concat({ type: LIVING_READER_VIEW, state: { file: 'gone.md' } }), active: 0, left: false, right: false };
  const next = await world({ vault: w.vault });
  await next.ws.restore(broken);
  for (const leaf of next.ws.rightSplit.children) if (leaf.deferred) await leaf.setViewState(leaf.deferred); // Obsidian loads them to read their type
  next.host.nodeDetailsSidebar.closeEmptyReaders();
  assert.equal(next.ws.rightSplit.children.length, 0, 'no empty reader survives the layout-ready step');
  const good = await world({ vault: w.vault });
  await good.ws.restore(saved);
  good.host.nodeDetailsSidebar.closeEmptyReaders();
  assert.equal(pane(good), 'reader:A', 'a restored reader shows its card at once');
  await good.click('B');
  assert.equal(pane(good), 'reader:B');
  assert.equal(paneLeaves(good), 1, 'the restored reader is reused, not joined by a new one');
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.ts'), 'utf8');
  assert.match(main, /onLayoutReady\(\(\) => this\.nodeDetailsSidebar\.closeEmptyReaders\(\)\)/, 'the plugin runs the step when the layout is ready');
  assert.match(main, /registerView\(LIVING_READER_VIEW, leaf => this\.nodeDetailsSidebar\.createReader\(leaf\)\)/, 'the plugin makes its readers through the pane, as this world does');
  assert.match(main, /workspace\.on\("layout-change", \(\) => this\.nodeDetailsSidebar\.layoutChanged\(\)\)/, 'the pane notices a closed tab on layout-change, as this world does');
});

test('D1-x11d: after Cmd+W an ordinary and an AI card both stay closed on select and both reopen via 「筆記」', async () => {
  for (const [key, opened] of [['P', 'native:P'], ['A', 'reader:A']]) {
    const w = await world();
    await w.click(key);
    assert.equal(pane(w), 'none', `${key}: a selection alone does not open the pane`);
    // The explicit entry: the card's Note action (toolbar 「筆記」, ⋯, context menu, command "open selected details").
    assert.equal(w.view.mapCommand('open-details', false), true, `${key}: the open-details command runs`);
    await w.settle();
    assert.equal(pane(w), opened, `${key}: the explicit entry opens the pane`);
    w.ws.closeActive(); // Cmd+W
    await w.settle();
    assert.equal(pane(w), 'none', `${key}: Cmd+W closes the pane`);
    for (const next of [key, key === 'P' ? 'A' : 'P', key]) {
      await w.click(next);
      assert.equal(pane(w), 'none', `${key} closed → select ${next}: the pane stays closed`);
    }
    w.view.mapCommand('open-details', false);
    await w.settle();
    assert.equal(pane(w), opened, `${key}: the explicit entry reopens the pane after Cmd+W`);
    assert.equal(paneLeaves(w), 1);
    await w.click(key === 'P' ? 'A' : 'P');
    assert.equal(pane(w), key === 'P' ? 'reader:A' : 'native:P', `${key}: the reopened pane follows the selection again`);
  }
});

test('D1 §23: 「筆記」 unfolds a right panel the user folded, as the user\'s own action', async () => {
  const w = await world({ width: 700 });
  await w.host.openDetails(w.file('A'));
  w.ws.rightSplit.collapse();
  await w.settle();
  w.view.selection.setSelected(w.node('B').id);
  w.view.mapCommand('open-details', false);
  await w.settle();
  assert.equal(pane(w), 'reader:B');
});
