// New maps open in a new tab so the current map keeps its running work; the switcher and path entries follow "plan A" (new tab only when work is running).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, DEFAULT_SETTINGS, obsidian, fixture, plain } = require('./support.cjs');
const dom = require('./support-dom.cjs');

class FuzzySuggestModal { constructor() {} setPlaceholder() {} setInstructions() {} open() {} close() {} }
let capturedModal = null;
class CapturingModal { constructor(app, ...args) { this.app = app; this.args = args; } open() { capturedModal = this; } close() {} }

// A leaf and workspace that follow Obsidian 1.15.0's order (checked in the extracted app.js: Leaf.setViewState, Workspace.getLeaf / createLeafInTabGroup / setActiveLeaf, TabGroup.selectTabIndex, the Leaf constructor's ResizeObserver):
//   getLeaf("tab") reuses the most recently active tab when it is still empty (and then does not activate it); otherwise it makes an empty leaf and,
//     with the focusNewTab setting, activates it at once;
//   setViewState has a `working` reentry guard (a call made while one runs returns at once); it creates the view, awaits onOpen, THEN setState
//     (a failure is swallowed), THEN setActiveLeaf if `active`, THEN a layout change (layout-change event, debounced 10 ms);
//   setActiveLeaf on the already-active leaf only focuses and returns; otherwise it makes the leaf active, selects its tab and schedules
//     active-leaf-change (debounced 0 ms);
//   selectTabIndex is a no-op on the current tab; otherwise it only calls requestSaveLayout and requestResize (no layout-change; the workspace
//     "resize" event it ends in does not reach a view's onResize);
//   view.onResize comes from the leaf's own ResizeObserver, debounced 20 ms, when the pane's size changes (0 to real when its tab is shown).
// So a tab that is shown is told by exactly two paths: the ResizeObserver ('resize-observer') and active-leaf-change. `events` picks which of them
// arrive. 'layout-change' is not a real show path: it only exercises the handler (HANDLER_ONLY), and is off by default.
// A hidden tab's pane is not shown (isShown() false) until it is selected.
// paint() runs for real up to where it reads activeDocument (that read ends it on purpose, like steps-toolbar-viewport.cjs); what the rest of
// paint builds is modelled by `viewportEl`, which measures 0 while the tab is hidden.
const STOP = new Error('paint stops here: the part after it is not under test');
const SHOW_EVENTS = ['resize-observer', 'active-leaf-change'];
const HANDLER_ONLY = ['layout-change'];

function makeWorld({ existingTitles = [], realRepo = null, setStateFails = false, notices = [], focusNewTab = true, events = SHOW_EVENTS } = {}) {
  const newViews = [], leaves = [], allLeaves = [], getLeafCalls = [], revealed = [], active = [], viewStates = [], defaultOpens = [], detached = [], handlers = {}, writes = [];
  const counts = { transform: 0, layouts: 0 };
  const { VisualAgentMapView, default: Plugin } = load('main.ts', { obsidian: { ...obsidian, MarkdownView: class {}, FuzzySuggestModal, Modal: CapturingModal, Notice: dom.makeNotice(notices) } }, {
    createFragment: dom.createFragment, CSS: { escape: x => x },
    setTimeout: fn => setTimeout(fn, 0), clearInterval, // the 250 ms viewport save timer and the title refresh run at once
    activeDocument: { get activeElement() { throw STOP; } }
  }, { define: { activeDocument: 'window.activeDocument' } });
  const plugin = new Plugin();
  const created = [];
  let clock = 0;
  plugin.settings = { ...DEFAULT_SETTINGS, language: 'en' };
  plugin.repo = realRepo ?? {
    topics: async () => existingTitles.map(title => ({ title })),
    createMap: async title => { created.push(title); return `Maps/${title}/Map.md`; },
    duplicateMap: async (_source, title) => { created.push(title); return `Maps/${title}/Map.md`; },
    mapSwitcherItems: async () => [],
    workspaceExists: () => true,
    mapFiles: async () => [{ path: 'Maps/Default/Map.md' }],
    readMap: async () => ({ nodes: [] })
  };
  plugin.ready = Promise.resolve();
  if (realRepo) plugin.rebuildDerivedData = async () => {};
  const emit = (name, delay) => setTimeout(() => (handlers[name] ?? []).forEach(cb => cb(workspace.activeLeaf)), delay);
  let activeEventPending = false;
  const requestActiveLeafEvents = () => { if (activeEventPending) return; activeEventPending = true; setTimeout(() => { activeEventPending = false; if (events.includes('active-leaf-change')) emit('active-leaf-change', 0); }, 0); };
  const workspace = {
    activeLeaf: null, selected: null,
    getLeavesOfType: () => leaves,
    getLeaf: kind => {
      getLeafCalls.push(kind);
      // createLeafInTabGroup: the most recently active tab is reused when it is empty (no activation then).
      const tabs = allLeaves.filter(l => l.attached);
      let recent = tabs[tabs.length - 1];
      for (const l of tabs) if (l.activeTime > recent.activeTime) recent = l;
      if (recent && !recent.view) return recent;
      const leaf = makeLeaf();
      if (focusNewTab) workspace.setActiveLeaf(leaf);
      return leaf;
    },
    // TabGroup.selectTabIndex: nothing on the current tab; otherwise the pane gets a size again (the leaf's ResizeObserver tells the view, debounced 20 ms).
    selectTab(leaf) {
      if (workspace.selected === leaf) return;
      workspace.selected = leaf;
      emit('resize', 0); // the workspace "resize" event (requestResize): not a view.onResize
      if (events.includes('layout-change')) emit('layout-change', 10); // handler-only, see the header
      if (leaf.view && events.includes('resize-observer')) setTimeout(() => leaf.view?.onResize?.(), 20);
    },
    revealLeaf: async leaf => { revealed.push(leaf); workspace.selectTab(leaf); },
    setActiveLeaf: (leaf, params) => {
      if (!leaf.attached) return;
      active.push([leaf, params]);
      if (workspace.activeLeaf === leaf) return; // already active: only focuses
      workspace.activeLeaf = leaf; leaf.activeTime = ++clock;
      workspace.selectTab(leaf); requestActiveLeafEvents();
    },
    on: (name, cb) => { (handlers[name] ??= []).push(cb); return {}; },
    requestSaveLayout() {}
  };
  plugin.app = { workspace };
  const newView = leaf => {
    const view = new VisualAgentMapView(leaf, plugin);
    view.synchronize = async () => {};
    view.openMapInMutation = async path => {
      if (path === 'Maps/Default/Map.md') defaultOpens.push(path);
      if (setStateFails) throw new Error('setState failed');
      view.path = path; view.map = realRepo ? await realRepo.readMap(path) : { id: `id-${path}`, title: path, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
      view.render();
    };
    const proto = VisualAgentMapView.prototype, log = view.events = [];
    view.render = () => { log.push('render'); proto.render.call(view); };
    view.paint = () => {
      try { proto.paint.call(view); } catch (error) { if (error !== STOP) throw error; }
      view.viewportEl ??= { get clientWidth() { return leaf.shown ? 800 : 0; }, get clientHeight() { return leaf.shown ? 600 : 0; } };
    };
    view.fit = () => { log.push('fit'); proto.fit.call(view); };
    view.focusNode = (node, persist) => { log.push(`focus:${node.id}`); proto.focusNode.call(view, node, persist); };
    view.startShallowResearch = async () => { log.push('research'); };
    // Not under test: widths, shapes, status bar, the stage transform and the write queue (writes records what would have been saved).
    view.syncChatNarrow = view.fitKindShapes = view.syncStatusBarClearance = () => {};
    view.transform = () => { counts.transform++; };
    view.queueViewportWrite = () => { writes.push({ ...view.map.viewport, width: view.viewportEl.clientWidth }); };
    // A stand-in for the pane's element and Obsidian's event helpers: onOpen itself is the real one.
    const noop = () => new Proxy(function () {}, { get: (_t, key) => (key === 'isShown' ? undefined : noop()), apply: () => noop() });
    const pane = { isShown: () => leaf.shown, ownerDocument: undefined, clientWidth: 0, contains: () => false };
    view.contentEl = new Proxy(noop(), { get: (target, key) => (key in pane ? pane[key] : target[key]) });
    view.containerEl = undefined; view.registerDomEvent = () => {}; view.registerEvent = event => event;
    view.leaf = leaf;
    return view;
  };
  function makeLeaf() {
    const leaf = {
      app: plugin.app, view: null, attached: true, activeTime: 0, working: false,
      get shown() { return workspace.selected === leaf; },
      getViewState() { return { type: 'visual-agent-map', state: this.view ? this.view.getState() : {} }; },
      detach() { detached.push(leaf); leaf.attached = false; const i = leaves.indexOf(leaf); if (i >= 0) leaves.splice(i, 1); leaf.view = null; },
      async setViewState(state) {
        if (leaf.working) return;
        leaf.working = true;
        try { await setViewStateInner(state); } finally { leaf.working = false; }
      }
    };
    const setViewStateInner = async state => {
        viewStates.push(state);
        const result = { history: false, layout: false };
        if (!leaf.view) {
          leaf.view = newView(leaf); newViews.push(leaf.view); leaves.push(leaf);
          await leaf.view.onOpen();
          result.layout = true;
        }
        try { await leaf.view.setState(state.state ?? {}, result); } catch { /* swallowed like Obsidian */ }
        if (state.active) workspace.setActiveLeaf(leaf, { focus: true });
        if (result.layout) { counts.layouts++; emit('layout-change', 10); }
    };
    allLeaves.push(leaf);
    return leaf;
  }
  const makeView = (path, { leaf = true } = {}) => {
    const l = { app: plugin.app, attached: true, getViewState() { return { type: 'visual-agent-map', state: { file: path } }; } };
    const view = new VisualAgentMapView(l, plugin);
    l.view = view;
    const calls = { openInPlace: [] };
    view.synchronize = async () => {};
    view.openMapInMutation = async p => { calls.openInPlace.push(p); };
    view.syncChatNarrow = view.fitKindShapes = view.syncStatusBarClearance = () => {};
    view.map = { id: `id-${path}`, title: 'Cur', nodes: [] }; view.path = path;
    if (leaf) leaves.push(l);
    return { view, leaf: l, calls };
  };
  const flush = () => new Promise(resolve => setTimeout(resolve, 40));
  // A tab opened in the background (focusNewTab off): hidden until something selects it.
  const hiddenTab = async (file = 'Maps/B/Map.md') => {
    const leaf = workspace.getLeaf('tab');
    await leaf.setViewState({ type: 'visual-agent-map', state: { file } });
    await flush();
    return { leaf, view: leaf.view };
  };
  return { plugin, workspace, VisualAgentMapView, newViews, leaves, getLeafCalls, revealed, active, defaultOpens, viewStates, detached, writes, counts, created, makeView, flush, hiddenTab, activeLeaf: () => workspace.activeLeaf };
}

// Every new-tab case runs with Obsidian's "focus new tabs" setting on and off.
const each = (name, fn) => { for (const focusNewTab of [true, false]) test(`${name} [focusNewTab ${focusNewTab ? 'on' : 'off'}]`, () => fn({ focusNewTab })); };

const settle = async () => { for (let i = 0; i < 6; i++) await dom.tick(); };
const withTimeout = (promise, ms = 1000) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('deadlock: did not settle')), ms))]);

each('N1 new map: opens in one new tab; the current view is not re-pointed and its work is not aborted', async ({ focusNewTab }) => {
  const w = makeWorld({ focusNewTab });
  const { view, calls } = w.makeView('Maps/A/Map.md');
  const chat = new AbortController(), suggest = new AbortController();
  view.chatController = chat; view.goalSuggestTask = { controller: suggest, state: 'running' };
  view.openNewMindMapModal(); await settle();
  assert.deepEqual(w.getLeafCalls, ['tab']);
  assert.deepEqual(calls.openInPlace, [], 'the current view did not open the new map');
  assert.equal(chat.signal.aborted, false); assert.equal(suggest.signal.aborted, false);
  assert.equal(view.chatController, chat); assert.ok(view.goalSuggestTask);
  assert.equal(w.viewStates[0].state.file, 'Maps/Untitled mind map/Map.md');
  assert.equal(w.viewStates[0].active, true);
  assert.equal(w.revealed.length, 1);
  // B1: the new tab is also the active leaf, so active-view commands act on the map that is on screen.
  assert.equal(w.activeLeaf(), w.leaves[w.leaves.length - 1]); assert.equal(w.active.at(-1)[1].focus, true);
  assert.equal(w.leaves[w.leaves.length - 1].shown, true);
  // F1: onOpen ran before setState (as in Obsidian) and did not open the default map first.
  assert.deepEqual(w.defaultOpens, []);
});

test('N1 new map from the blank screen (no map) stays in the same tab', async () => {
  const w = makeWorld();
  const { view, calls } = w.makeView('Maps/A/Map.md');
  view.map = null;
  view.openNewMindMapModal(); await settle();
  assert.deepEqual(w.getLeafCalls, []);
  assert.deepEqual(calls.openInPlace, ['Maps/Untitled mind map/Map.md']);
});

each('N2 deadlock regression: new map and duplicate settle with the real serial mutate queue', async ({ focusNewTab }) => {
  for (const act of [view => view.openNewMindMapModal(), view => view.duplicateCurrentMap()]) {
    const w = makeWorld({ focusNewTab });
    const { view } = w.makeView('Maps/A/Map.md');
    // The tab's setViewState -> setState -> openMap goes through plugin.mutate, like Obsidian's.
    const openMap = w.plugin.app.workspace.getLeaf;
    w.plugin.app.workspace.getLeaf = kind => {
      const leaf = openMap(kind), set = leaf.setViewState.bind(leaf);
      leaf.setViewState = async state => { await set(state); await w.plugin.mutate(async () => {}); w.settled = true; };
      return leaf;
    };
    act(view);
    await withTimeout((async () => { for (let i = 0; i < 50 && !w.settled; i++) await dom.tick(); if (!w.settled) throw new Error('deadlock: new tab never finished opening'); })());
    await withTimeout(w.plugin.mutate(async () => {}));
    assert.equal(w.getLeafCalls.length, 1);
  }
});

each('N2 duplicate: the copy opens in a new tab and the source view is untouched', async ({ focusNewTab }) => {
  const w = makeWorld({ focusNewTab });
  const { view, calls } = w.makeView('Maps/A/Map.md');
  view.duplicateCurrentMap(); await settle();
  assert.deepEqual(w.getLeafCalls, ['tab']); assert.deepEqual(calls.openInPlace, []);
  assert.equal(w.viewStates[0].state.file, 'Maps/Cur copy/Map.md');
});

async function pickInSwitcher(view, mapPath) {
  let modal;
  view.openMapModal = m => { modal = m; return m; };
  view.openMapSwitcher(); await settle();
  modal.onChooseItem({ mapPath, title: 't', folder: 'f', modified: 0 });
  await settle();
}

each('N3 switcher: running work opens a new tab; idle swaps in place; a target already open is revealed', async ({ focusNewTab }) => {
  let w = makeWorld({ focusNewTab }), a = w.makeView('Maps/A/Map.md');
  a.view.chatController = new AbortController();
  await pickInSwitcher(a.view, 'Maps/B/Map.md');
  assert.deepEqual(w.getLeafCalls, ['tab']); assert.deepEqual(a.calls.openInPlace, []);

  w = makeWorld({ focusNewTab }); a = w.makeView('Maps/A/Map.md');
  await pickInSwitcher(a.view, 'Maps/B/Map.md');
  assert.deepEqual(w.getLeafCalls, []); assert.deepEqual(a.calls.openInPlace, ['Maps/B/Map.md']);

  for (const busy of [false, true]) {
    w = makeWorld({ focusNewTab }); a = w.makeView('Maps/A/Map.md'); const b = w.makeView('Maps/B/Map.md');
    if (busy) a.view.chatController = new AbortController();
    await pickInSwitcher(a.view, 'Maps/B/Map.md');
    // The reveal of an open pane is deferred with setTimeout(0) (P2: the switcher closes first); let that timer run.
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.deepEqual(w.getLeafCalls, [], 'no new tab'); assert.deepEqual(a.calls.openInPlace, []);
    assert.deepEqual(w.revealed, [b.leaf]);
    assert.equal(w.activeLeaf(), b.leaf, 'B1: the tab jumped to is the active leaf'); assert.deepEqual(plain(w.active.at(-1)[1]), { focus: true });
  }
});

each('N4 activateView(path): the first tab with running work keeps its map; an already open target is not opened twice', async ({ focusNewTab }) => {
  let w = makeWorld({ focusNewTab }), a = w.makeView('Maps/A/Map.md');
  a.view.startingExpand.add('n1');
  await w.plugin.activateView('Maps/B/Map.md');
  assert.deepEqual(w.getLeafCalls, ['tab']); assert.equal(w.viewStates[0].state.file, 'Maps/B/Map.md');
  assert.equal(a.view.path, 'Maps/A/Map.md');
  assert.equal(w.activeLeaf(), w.leaves[w.leaves.length - 1], 'B1: the new tab is the active leaf'); assert.deepEqual(w.defaultOpens, []);

  w = makeWorld({ focusNewTab }); a = w.makeView('Maps/A/Map.md'); const b = w.makeView('Maps/B/Map.md');
  a.view.startingExpand.add('n1');
  await w.plugin.activateView('Maps/B/Map.md');
  assert.deepEqual(w.getLeafCalls, []); assert.deepEqual(w.viewStates, []); assert.deepEqual(w.revealed, [b.leaf]);
  assert.equal(w.activeLeaf(), b.leaf, 'B1: the tab jumped to is the active leaf'); assert.deepEqual(plain(w.active.at(-1)[1]), { focus: true });
});

test('N4 activateView(path): an idle first tab is reused as before; without a path nothing changes', async () => {
  const w = makeWorld(); const a = w.makeView('Maps/A/Map.md');
  let state;
  a.leaf.setViewState = async s => { state = s; };
  await w.plugin.activateView('Maps/B/Map.md');
  assert.deepEqual(w.getLeafCalls, []); assert.equal(state.state.file, 'Maps/B/Map.md');
  await w.plugin.activateView();
  assert.equal(state.state.file, 'Maps/A/Map.md');
});

test('N5 hasRunningWork: false when idle, true for each kind of work', () => {
  const idle = () => makeWorld().makeView('Maps/A/Map.md');
  assert.equal(idle().view.hasRunningWork(), false);
  const cases = {
    chatController: v => { v.chatController = new AbortController(); },
    chatApplying: v => { v.chatApplying = true; },
    chatPreparing: v => { v.chat = { isBusy: true }; },
    chatPrepAbandon: v => { v.chatPrepAbandon = () => {}; },
    chatImageSearches: v => { v.chatImageSearches.set(1, new AbortController()); },
    synthesisRunning: v => { v.synthesisTasks.set('k', { state: 'running', controller: new AbortController() }); },
    startingTasks: v => { v.startingTasks.set('k', new AbortController()); },
    startingExpand: v => { v.startingExpand.add('k'); },
    mergeTasks: v => { v.mergeTasks.set('k', { controller: new AbortController() }); },
    aimBusy: v => { v.aimBusy = true; },
    aimController: v => { v.aimController = new AbortController(); },
    goalSuggestTask: v => { v.goalSuggestTask = { controller: new AbortController(), state: 'running' }; },
    structureReviewTask: v => { v.structureReviewTask = { controller: new AbortController() }; },
    outlineDraftTask: v => { v.outlineDraftTask = { controller: new AbortController() }; },
    relevanceGrade: v => { v.startedRelevance = true; v.plugin.relevanceGrades.set(v.path, { owner: v, status: 'running', controller: new AbortController() }); },
    topicRunsBusy: v => { v.map.nodes.push({ id: 'n', path: 'Maps/A/Notes/n.md' }); v.plugin.topicRuns.isBusy = p => p === 'Maps/A/Notes/n.md'; },
    expansionRunning: v => { v.map.nodes.push({ id: 'n', path: 'Maps/A/Notes/n.md' }); v.plugin.expansionCoordinator.isRunning = p => p === 'Maps/A/Notes/n.md'; },
    expansionQueued: v => { v.map.nodes.push({ id: 'n', path: 'Maps/A/Notes/n.md' }); v.plugin.expansionCoordinator.isQueued = p => p === 'Maps/A/Notes/n.md'; },
    quickExpandPending: v => { v.map.nodes.push({ id: 'n', path: 'Maps/A/Notes/n.md' }); v.plugin.quickExpandPending.add('Maps/A/Notes/n.md'); }
  };
  for (const [name, arm] of Object.entries(cases)) { const { view } = idle(); arm(view); assert.equal(view.hasRunningWork(), true, name); }
  const finished = idle().view;
  finished.synthesisTasks.set('k', { state: 'failed', controller: new AbortController() });
  assert.equal(finished.hasRunningWork(), false, 'a finished synthesis task is not work');
});

test('N6 chatSwitchTo stays in the same tab', async () => {
  const w = makeWorld(); const a = w.makeView('Maps/A/Map.md');
  a.view.chatRecords = null;
  await a.view.chatSwitchTo('Maps/B/Map.md', { path: 'Maps/A/Map.md', id: 'id-A' }).catch(() => {});
  assert.deepEqual(w.getLeafCalls, []); assert.deepEqual(a.calls.openInPlace, ['Maps/B/Map.md']);
});

each('B1 openMapInNewTab on a map that is already open makes that tab the active leaf and opens no second tab', async ({ focusNewTab }) => {
  const w = makeWorld({ focusNewTab }); const b = w.makeView('Maps/B/Map.md');
  const view = await w.plugin.openMapInNewTab('Maps/B/Map.md');
  assert.equal(view, b.view); assert.deepEqual(w.getLeafCalls, []);
  assert.deepEqual(w.revealed, [b.leaf]); assert.equal(w.activeLeaf(), b.leaf); assert.deepEqual(plain(w.active.at(-1)[1]), { focus: true });
});

each('F1 the default map is opened by a new tab that is not told its map (it is the control), and skipped when it is', async ({ focusNewTab }) => {
  const w = makeWorld({ focusNewTab }); const leaf = w.plugin.app.workspace.getLeaf('tab');
  await leaf.setViewState({ type: 'visual-agent-map', state: {}, active: true });
  assert.deepEqual(w.defaultOpens, ['Maps/Default/Map.md'], 'without a pending map the tab opens the default one (so the guard under test is what skips it)');
});

each('F4/M4 a setState that fails (Obsidian swallows it) is not a success: openMapInNewTab returns null, closes the new tab and keeps the Notice', async ({ focusNewTab }) => {
  const notices = [];
  const w = makeWorld({ setStateFails: true, focusNewTab, notices });
  assert.equal(await w.plugin.openMapInNewTab('Maps/B/Map.md'), null);
  assert.equal(w.detached.length, 1, 'the blank tab is detached'); assert.deepEqual(w.leaves, []);
  assert.deepEqual(w.revealed, [], 'a tab that failed is not brought forward');
  assert.ok(notices.some(text => String(text).includes('setState failed')), JSON.stringify(notices));
});

each('M4 activateView(path): a new tab whose map failed to open is closed, not left blank, and the Notice stays', async ({ focusNewTab }) => {
  const notices = [];
  const w = makeWorld({ setStateFails: true, focusNewTab, notices }); const a = w.makeView('Maps/A/Map.md');
  a.view.startingExpand.add('n1');
  await w.plugin.activateView('Maps/B/Map.md');
  assert.deepEqual(w.getLeafCalls, ['tab']); assert.equal(w.detached.length, 1); assert.deepEqual(w.leaves, [a.leaf]);
  assert.deepEqual(w.revealed, []);
  assert.ok(notices.some(text => String(text).includes('setState failed')), JSON.stringify(notices));
});

test('M4 activateView(path): a reused first tab that fails to open is not detached (it is the user\'s tab)', async () => {
  const notices = [];
  const w = makeWorld({ notices }); const a = w.makeView('Maps/A/Map.md');
  a.leaf.setViewState = async () => {};
  await w.plugin.activateView('Maps/B/Map.md');
  assert.deepEqual(w.detached, []);
});

each('L1 an error from opening the new tab is shown, not swallowed', async ({ focusNewTab }) => {
  const notices = [];
  const w = makeWorld({ notices, focusNewTab }); const { view } = w.makeView('Maps/A/Map.md');
  w.plugin.openMapInNewTab = async () => { throw new Error('tab boom'); };
  view.openNewMindMapModal(); await settle();
  assert.ok(notices.some(text => String(text).includes('tab boom')), JSON.stringify(notices));
});

// B2: AIM start and outline import with a real repository, the real serial mutate and a target view that is not the source view.
const outlineApi = load('experiences/visual-map/outline-import.ts', { obsidian });
async function realWorld({ blank = false, focusNewTab = true } = {}) {
  const { repo } = fixture('en');
  await repo.ensureWorkspace();
  const w = makeWorld({ realRepo: repo, focusNewTab });
  w.plugin.settings = { ...DEFAULT_SETTINGS, language: 'en', cliModel: 'gpt-6-luna' };
  repo.settings = w.plugin.settings;
  w.plugin.confirmAiUsage = async (_model, run) => { await run(); return true; };
  const sourcePath = await repo.createMap('Source');
  const source = w.makeView(sourcePath);
  source.view.map = blank ? null : await repo.readMap(sourcePath);
  source.view.render = () => source.view.events.push('render');
  source.view.events = []; source.view.fit = () => source.view.events.push('fit'); source.view.focusNode = n => source.view.events.push(`focus:${n.id}`);
  source.view.startShallowResearch = async () => { source.view.events.push('research'); };
  return { w, repo, source };
}

each('B2 AIM start with a map open: the new map opens in a new tab and focus lands there, not on the source view', async ({ focusNewTab }) => {
  const { w, source } = await realWorld({ focusNewTab });
  source.view.openAimStart();
  await capturedModal.submit({ requestId: 'r1', topic: 'New goal', context: '', model: 'gpt-6-luna', reasoning: 'low' });
  await settle();
  assert.deepEqual(w.getLeafCalls, ['tab']); assert.deepEqual(source.calls.openInPlace, [], 'the source view did not open the new map');
  const target = w.newViews[0];
  assert.notEqual(target, source.view); assert.equal(target.path, w.viewStates[0].state.file);
  assert.deepEqual(source.view.events, []);
  assert.ok(target.events.includes('render') && target.events.some(e => e.startsWith('focus:')), JSON.stringify(target.events));
});

test('B2 AIM start from the blank screen stays in the same tab', async () => {
  const { w, source } = await realWorld({ blank: true });
  source.view.openAimStart();
  await capturedModal.submit({ requestId: 'r2', topic: 'New goal', context: '', model: 'gpt-6-luna', reasoning: 'low' });
  await settle();
  assert.deepEqual(w.getLeafCalls, []); assert.equal(source.calls.openInPlace.length, 1);
});

each('B2 outline import with a map open: the new map opens in a new tab; fit and the shallow research land on it', async ({ focusNewTab }) => {
  const { w, source } = await realWorld({ focusNewTab });
  const nodes = outlineApi.parseOutline('# Root\n## A\n### B').nodes;
  await source.view.importOutline({ nodes, source: null, shallowResearch: true });
  await settle();
  assert.deepEqual(w.getLeafCalls, ['tab']); assert.deepEqual(source.calls.openInPlace, []);
  const target = w.newViews[0];
  assert.notEqual(target, source.view);
  assert.ok(target.events.includes('fit'), JSON.stringify(target.events)); assert.ok(target.events.includes('research'), JSON.stringify(target.events));
  assert.deepEqual(source.view.events, []);
});

test('B2 outline import from the blank screen stays in the same tab', async () => {
  const { w, source } = await realWorld({ blank: true });
  const nodes = outlineApi.parseOutline('# Root\n## A\n### B').nodes;
  await source.view.importOutline({ nodes, source: null, shallowResearch: true });
  await settle();
  assert.deepEqual(w.getLeafCalls, []); assert.equal(source.calls.openInPlace.length, 1);
  assert.ok(source.view.events.includes('research'));
});

each('F4 outline import: a new tab whose map did not open starts no research', async ({ focusNewTab }) => {
  const { w, source } = await realWorld({ focusNewTab });
  const ran = [];
  w.plugin.openMapInNewTab = async () => ({ path: 'Maps/Other/Map.md', closed: false, fit() { ran.push('fit'); }, startShallowResearch: async () => { ran.push('research'); } });
  const nodes = outlineApi.parseOutline('# Root\n## A\n### B').nodes;
  await source.view.importOutline({ nodes, source: null, shallowResearch: true });
  await settle();
  assert.deepEqual(ran, [], 'nothing runs on a view that is not showing the new map'); assert.ok(!source.view.events.includes('research'));
});

// ---- A tab that is not shown (a background tab, or a new tab with focusNewTab off): it paints like any other, measures and saves nothing, and finishes when shown.
each('B3 import into a new tab: fit takes effect on the new map (the shown canvas is measured), also when the tab started hidden', async ({ focusNewTab }) => {
  const { w, source } = await realWorld({ focusNewTab });
  const nodes = outlineApi.parseOutline('# Root\n## A\n### B').nodes;
  await source.view.importOutline({ nodes, source: null, shallowResearch: false });
  await w.flush();
  const target = w.newViews[0];
  assert.ok(target.viewportEl, 'the tab drew its canvas even though it was not shown while its map opened');
  assert.ok(w.writes.length >= 1 && w.writes.every(item => item.width > 0), `a viewport computed from a measured pane was saved: ${JSON.stringify(w.writes)}`);
  assert.ok(target.map.viewport.zoom > 0 && target.map.viewport.zoom !== 1 || target.map.viewport.x !== 0 || target.map.viewport.y !== 0, JSON.stringify(target.map.viewport));
});

test('M1 flushChatRender while the tab is hidden still draws again once it is shown', async () => {
  const w = makeWorld({ focusNewTab: false }); const { view, leaf } = await w.hiddenTab();
  const before = view.paintCount;
  view.renderPending = true; view.flushChatRender();
  assert.equal(view.paintCount, before + 1, 'it painted while hidden'); assert.equal(view.renderWhenShown, true, 'and remembers to paint again');
  await w.workspace.revealLeaf(leaf); await w.flush();
  assert.equal(view.paintCount, before + 2, 'one more paint when shown'); assert.equal(view.renderWhenShown, false);
  await w.flush(); assert.equal(view.paintCount, before + 2, 'no redraw loop');
});

test('M2 a hidden tab keeps the outline and the tab title in step with its map', async () => {
  const w = makeWorld({ focusNewTab: false }); const { view } = await w.hiddenTab();
  w.plugin.outlineSourceView = undefined; w.plugin.outlineMap = null;
  const layouts = w.counts.layouts;
  view.map = { id: 'id-new', title: 'Renamed', nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  view.render(); await w.flush();
  assert.equal(w.plugin.outlineMap, view.map, 'the outline shows this tab\'s map');
  assert.equal(view.headerTitle, 'Renamed'); assert.ok(w.counts.layouts > layouts, 'the tab title was asked to refresh');
});

test('M3 a camera request made while hidden is not saved then, and runs once when the tab is shown (the last request wins)', async () => {
  const w = makeWorld({ focusNewTab: false }); const { view, leaf } = await w.hiddenTab();
  view.map.nodes.push({ id: 'n1', x: 100, y: 100 }, { id: 'n2', x: 900, y: 700 });
  view.map.viewport = { x: 5, y: 6, zoom: 1 };
  w.writes.length = 0; const transforms = w.counts.transform;
  view.fit(); view.focusNode(view.map.nodes[1]);
  await w.flush();
  assert.deepEqual(plain(view.map.viewport), { x: 5, y: 6, zoom: 1 }, 'nothing is computed from the 0-size pane');
  assert.deepEqual(w.writes, [], 'nothing is saved while hidden'); assert.equal(w.counts.transform, transforms);
  await w.workspace.revealLeaf(leaf); await w.flush();
  assert.equal(w.counts.transform, transforms + 1, 'only the last request ran, once');
  assert.notDeepEqual(plain(view.map.viewport), { x: 5, y: 6, zoom: 1 }); assert.equal(w.writes.length, 1);
  assert.equal(w.writes[0].width, 800, 'it was computed and saved from the shown pane');
  await w.flush(); assert.equal(w.counts.transform, transforms + 1, 'not replayed again');
});

test('a ring fit asked while the tab is hidden still frames only the ring when the tab is shown', async () => {
  const w = makeWorld({ focusNewTab: false }); const { view } = await w.hiddenTab();
  view.map.nodes.push({ id: 'n1', x: 100, y: 100 }, { id: 'n2', x: 900, y: 700 });
  const ring = new Set(['n1']);
  view.fitCards(ring);
  assert.equal(view.fitOnly, undefined, 'the limit is not left on the view while waiting');
  const framed = []; view.fitCards = ids => framed.push(ids);
  view.cameraWhenShown();
  assert.deepEqual(framed, [ring]);
});

test('M3 a camera request for a map the tab has since left is dropped', async () => {
  const w = makeWorld({ focusNewTab: false }); const { view, leaf } = await w.hiddenTab();
  // The real openMapInMutation (the stub on the view is bypassed): it is the code that drops the request when the path changes.
  const realOpen = w.VisualAgentMapView.prototype.openMapInMutation;
  w.plugin.repo.readMap = async path => ({ id: `id-${path}`, title: path, nodes: [{ id: 'n1', x: 100, y: 100 }, { id: 'n2', x: 900, y: 700 }], viewport: { x: 0, y: 0, zoom: 1 } });
  view.map.nodes.push({ id: 'n1', x: 100, y: 100 }, { id: 'n2', x: 900, y: 700 });
  view.fit(); // asked while hidden: kept for when the tab is shown
  assert.equal(typeof view.cameraWhenShown, 'function', 'the request is waiting');
  await realOpen.call(view, 'Maps/C/Map.md');
  assert.equal(view.path, 'Maps/C/Map.md');
  assert.equal(view.cameraWhenShown, null, 'leaving the map dropped the waiting request');
  w.writes.length = 0; const transforms = w.counts.transform;
  await w.workspace.revealLeaf(leaf); await w.flush();
  assert.equal(w.writes.length, 0, 'the old map\'s request did not move or save the new one');
  assert.equal(w.counts.transform, transforms, 'no camera move ran for the new map');
});

test('a hidden tab records no card heights', async () => {
  const w = makeWorld({ focusNewTab: false }); const { view } = await w.hiddenTab();
  view.cardEls = new Map([['n', { offsetHeight: 0 }]]); view.heightsSeen = new Map();
  view.settleCardHeights();
  assert.equal(view.heightsSeen.size, 0, 'no height 0 recorded');
});

for (const event of [...SHOW_EVENTS, ...HANDLER_ONLY]) {
  test(`a hidden tab draws again when shown: the ${event} event alone is enough${HANDLER_ONLY.includes(event) ? ' (handler only, not a real show path)' : ''}`, async () => {
    const w = makeWorld({ focusNewTab: false, events: [event] }); const { view, leaf } = await w.hiddenTab();
    assert.equal(view.renderWhenShown, true); const before = view.paintCount;
    w.workspace.setActiveLeaf(leaf, { focus: true }); await w.flush();
    assert.equal(view.paintCount, before + 1, event); assert.equal(view.renderWhenShown, false);
  });
}

test('a tab that is still hidden does not draw again on an event', async () => {
  const w = makeWorld({ focusNewTab: false }); const { view } = await w.hiddenTab();
  const before = view.paintCount; view.onResize(); view.drawWhenShown();
  assert.equal(view.paintCount, before); assert.equal(view.renderWhenShown, true);
});

// M5: the opening screen takes the keyboard once, and only when the keyboard really moves into the pane.
function heroView({ shown = true, active = null, moves = true } = {}) {
  const w = makeWorld(); const { view } = w.makeView('Maps/A/Map.md');
  const doc = { activeElement: active, body: { inside: false } };
  const stats = { focused: 0 };
  view.contentEl = { isShown: () => shown, ownerDocument: doc, contains: el => Boolean(el?.inside) };
  view.chat = { isHero: true, focusInput: () => { stats.focused++; if (moves) doc.activeElement = { inside: true }; } };
  return { view, doc, stats, setShown: value => { shown = value; } };
}

test('M5 the opening screen keeps its once while the tab is hidden, and takes the keyboard when it is shown', () => {
  const h = heroView({ shown: false });
  h.view.focusChatHero(); assert.equal(h.stats.focused, 0); assert.notEqual(h.view.chatHeroFocusedFor, h.view.map.id);
  h.setShown(true); h.view.focusChatHero(); assert.equal(h.stats.focused, 1);
});

test('M5 focus left in a hidden pane (the tab just switched away from) does not block it, and the once is used up', () => {
  const h = heroView({ active: { inside: false, isShown: () => false } });
  h.view.focusChatHero(); assert.equal(h.stats.focused, 1);
  h.view.focusChatHero(); assert.equal(h.stats.focused, 1, 'used up once the keyboard moved');
});

test('M5 focus held in a visible pane is not stolen, now or by a later repaint when the focus falls to BODY', () => {
  const h = heroView({ active: { inside: false, isShown: () => true } });
  h.view.focusChatHero(); assert.equal(h.stats.focused, 0); assert.equal(h.view.chatHeroFocusedFor, h.view.map.id, 'the once is used up');
  h.doc.activeElement = h.doc.body; h.view.focusChatHero(); assert.equal(h.stats.focused, 0, 'the delayed repaint does not steal the focus');
});

test('M5 the once is not used up when focusInput did not move the keyboard', () => {
  const h = heroView({ moves: false });
  h.view.focusChatHero(); h.view.focusChatHero();
  assert.equal(h.stats.focused, 2); assert.notEqual(h.view.chatHeroFocusedFor, h.view.map.id);
});

test('a hidden first paint does not use up the toolbar clearing of the map; the paint that can see the pane does it', async () => {
  const w = makeWorld({ focusNewTab: false }); const { view, leaf } = await w.hiddenTab();
  view.toolbarClearedFor = null; view.path = 'Maps/B/Map.md';
  view.applyInitialViewport();
  assert.equal(view.toolbarClearedFor, null, 'hidden: nothing to measure, the clearing is still to do');
  await w.workspace.revealLeaf(leaf);
  view.applyInitialViewport();
  assert.equal(view.toolbarClearedFor, 'Maps/B/Map.md');
});

test('M3 a viewport save scheduled while shown is written even if the tab hides meanwhile; one requested while hidden is not', async () => {
  const w = makeWorld({ focusNewTab: true }); const { view, leaf } = await w.hiddenTab();
  w.writes.length = 0;
  view.saveViewport(); // asked while the pane is shown (it was computed from a sized pane)
  w.workspace.selectTab({}); // another tab is selected: this one is hidden before the waiting save runs
  await w.flush();
  assert.equal(w.writes.length, 1, 'the waiting save is written');
  w.writes.length = 0;
  view.saveViewport(); await w.flush();
  assert.deepEqual(w.writes, [], 'a save asked for while hidden is not scheduled');
  await w.workspace.revealLeaf(leaf); view.saveViewport(); await w.flush();
  assert.equal(w.writes.length, 1); assert.equal(w.writes[0].width, 800);
});
