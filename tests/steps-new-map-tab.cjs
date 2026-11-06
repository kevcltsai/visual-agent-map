// New maps open in a new tab so the current map keeps its running work; the switcher and path entries follow "plan A" (new tab only when work is running).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, DEFAULT_SETTINGS, obsidian, fixture, plain } = require('./support.cjs');
const dom = require('./support-dom.cjs');

class FuzzySuggestModal { constructor() {} setPlaceholder() {} setInstructions() {} open() {} close() {} }
let capturedModal = null;
class CapturingModal { constructor(app, ...args) { this.app = app; this.args = args; } open() { capturedModal = this; } close() {} }

function makeWorld({ existingTitles = [], realRepo = null, setStateFails = false, notices = [] } = {}) {
  const newViews = [], leaves = [], getLeafCalls = [], revealed = [], active = [], viewStates = [], defaultOpens = [];
  const { VisualAgentMapView, default: Plugin } = load('main.ts', { obsidian: { ...obsidian, FuzzySuggestModal, Modal: CapturingModal, Notice: dom.makeNotice(notices) } }, { createFragment: dom.createFragment });
  const plugin = new Plugin();
  const created = [];
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
  plugin.app = {
    workspace: {
      getLeavesOfType: () => leaves,
      getLeaf: kind => {
        getLeafCalls.push(kind);
        const leaf = {
          view: null,
          getViewState() { return { type: 'visual-agent-map', state: this.view ? this.view.getState() : {} }; },
          // Obsidian's setViewState opens the view (awaiting onOpen) and only then hands it the state (setState), which opens the map
          // through the plugin's serial queue; a failing setState is swallowed.
          async setViewState(state) {
            viewStates.push(state);
            const view = new VisualAgentMapView(leaf, plugin);
            view.synchronize = async () => {};
            view.openMapInMutation = async path => {
              if (path === 'Maps/Default/Map.md') defaultOpens.push(path);
              if (setStateFails) throw new Error('setState failed');
              view.path = path; view.map = realRepo ? await realRepo.readMap(path) : { id: `id-${path}`, title: path, nodes: [] };
            };
            const events = view.events = [];
            view.render = () => events.push('render'); view.fit = () => events.push('fit'); view.focusNode = node => events.push(`focus:${node.id}`);
            view.startShallowResearch = async () => { events.push('research'); };
            newViews.push(view);
            // A stand-in for the pane's element and Obsidian's event helpers: onOpen itself is the real one.
            const noop = () => new Proxy(function () {}, { get: (_t, key) => (key === 'isShown' ? undefined : noop()), apply: () => noop() });
            view.leaf = leaf; view.contentEl = noop(); view.containerEl = undefined; view.registerDomEvent = () => {}; view.registerEvent = () => {};
            leaf.view = view;
            leaves.push(leaf);
            await view.onOpen();
            try { await view.setState(state.state, {}); } catch { /* swallowed like Obsidian */ }
          }
        };
        leaf.app = plugin.app;
        return leaf;
      },
      revealLeaf: async leaf => { revealed.push(leaf); },
      setActiveLeaf: (leaf, params) => { active.push([leaf, params]); },
      on: () => ({}),
      requestSaveLayout() {}
    }
  };
  const makeView = (path, { leaf = true } = {}) => {
    const l = { app: plugin.app, getViewState() { return { type: 'visual-agent-map', state: { file: path } }; } };
    const view = new VisualAgentMapView(l, plugin);
    l.view = view;
    const calls = { openInPlace: [] };
    view.synchronize = async () => {};
    view.openMapInMutation = async p => { calls.openInPlace.push(p); };
    view.map = { id: `id-${path}`, title: 'Cur', nodes: [] }; view.path = path;
    if (leaf) leaves.push(l);
    return { view, leaf: l, calls };
  };
  return { plugin, VisualAgentMapView, newViews, leaves, getLeafCalls, revealed, active, defaultOpens, viewStates, created, makeView };
}

const settle = async () => { for (let i = 0; i < 6; i++) await dom.tick(); };
const withTimeout = (promise, ms = 1000) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('deadlock: did not settle')), ms))]);

test('N1 new map: opens in one new tab; the current view is not re-pointed and its work is not aborted', async () => {
  const w = makeWorld();
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
  assert.equal(w.active.length, 1); assert.equal(w.active[0][0], w.leaves[w.leaves.length - 1]); assert.equal(w.active[0][1].focus, true);
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

test('N2 deadlock regression: new map and duplicate settle with the real serial mutate queue', async () => {
  for (const act of [view => view.openNewMindMapModal(), view => view.duplicateCurrentMap()]) {
    const w = makeWorld();
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

test('N2 duplicate: the copy opens in a new tab and the source view is untouched', async () => {
  const w = makeWorld();
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

test('N3 switcher: running work opens a new tab; idle swaps in place; a target already open is revealed', async () => {
  let w = makeWorld(), a = w.makeView('Maps/A/Map.md');
  a.view.chatController = new AbortController();
  await pickInSwitcher(a.view, 'Maps/B/Map.md');
  assert.deepEqual(w.getLeafCalls, ['tab']); assert.deepEqual(a.calls.openInPlace, []);

  w = makeWorld(); a = w.makeView('Maps/A/Map.md');
  await pickInSwitcher(a.view, 'Maps/B/Map.md');
  assert.deepEqual(w.getLeafCalls, []); assert.deepEqual(a.calls.openInPlace, ['Maps/B/Map.md']);

  for (const busy of [false, true]) {
    w = makeWorld(); a = w.makeView('Maps/A/Map.md'); const b = w.makeView('Maps/B/Map.md');
    if (busy) a.view.chatController = new AbortController();
    await pickInSwitcher(a.view, 'Maps/B/Map.md');
    assert.deepEqual(w.getLeafCalls, [], 'no new tab'); assert.deepEqual(a.calls.openInPlace, []);
    assert.deepEqual(w.revealed, [b.leaf]);
    assert.equal(w.active.length, 1, 'B1'); assert.equal(w.active[0][0], b.leaf, 'B1: the tab jumped to is the active leaf'); assert.deepEqual(plain(w.active[0][1]), { focus: true });
  }
});

test('N4 activateView(path): the first tab with running work keeps its map; an already open target is not opened twice', async () => {
  let w = makeWorld(), a = w.makeView('Maps/A/Map.md');
  a.view.startingExpand.add('n1');
  await w.plugin.activateView('Maps/B/Map.md');
  assert.deepEqual(w.getLeafCalls, ['tab']); assert.equal(w.viewStates[0].state.file, 'Maps/B/Map.md');
  assert.equal(a.view.path, 'Maps/A/Map.md');
  assert.equal(w.active.length, 1, 'B1: the new tab is the active leaf'); assert.deepEqual(w.defaultOpens, []);

  w = makeWorld(); a = w.makeView('Maps/A/Map.md'); const b = w.makeView('Maps/B/Map.md');
  a.view.startingExpand.add('n1');
  await w.plugin.activateView('Maps/B/Map.md');
  assert.deepEqual(w.getLeafCalls, []); assert.deepEqual(w.viewStates, []); assert.deepEqual(w.revealed, [b.leaf]);
  assert.equal(w.active.length, 1, 'B1'); assert.equal(w.active[0][0], b.leaf, 'B1: the tab jumped to is the active leaf'); assert.deepEqual(plain(w.active[0][1]), { focus: true });
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

test('B1 openMapInNewTab on a map that is already open makes that tab the active leaf and opens no second tab', async () => {
  const w = makeWorld(); const b = w.makeView('Maps/B/Map.md');
  const view = await w.plugin.openMapInNewTab('Maps/B/Map.md');
  assert.equal(view, b.view); assert.deepEqual(w.getLeafCalls, []);
  assert.deepEqual(w.revealed, [b.leaf]); assert.equal(w.active.length, 1); assert.equal(w.active[0][0], b.leaf); assert.deepEqual(plain(w.active[0][1]), { focus: true });
});

test('F1 the default map is opened by a new tab that is not told its map (it is the control), and skipped when it is', async () => {
  const w = makeWorld(); const leaf = w.plugin.app.workspace.getLeaf('tab');
  await leaf.setViewState({ type: 'visual-agent-map', state: {}, active: true });
  assert.deepEqual(w.defaultOpens, ['Maps/Default/Map.md'], 'without a pending map the tab opens the default one (so the guard under test is what skips it)');
});

test('F3 a hidden tab draws, measures and saves nothing, and draws once it is shown again', () => {
  const w = makeWorld(); const { view } = w.makeView('Maps/A/Map.md');
  let shown = false, painted = 0, settled = 0;
  view.contentEl = { isShown: () => shown };
  view.syncChatNarrow = view.fitKindShapes = view.syncStatusBarClearance = () => {};
  view.paint = () => { painted++; }; view.settleCardHeights = () => { settled++; };
  view.render();
  assert.equal(painted, 0); assert.equal(settled, 0);
  view.onResize(); assert.equal(painted, 0, 'still hidden');
  shown = true; view.onResize();
  assert.equal(painted, 1); assert.equal(settled, 1);
  view.onResize(); assert.equal(painted, 1, 'drawn once, not on every resize');
});

test('F3 a hidden tab does not move or save its viewport and records no card heights', () => {
  const w = makeWorld(); const { view } = w.makeView('Maps/A/Map.md');
  view.contentEl = { isShown: () => false };
  view.viewportEl = { clientWidth: 0, clientHeight: 0 }; view.map.nodes.push({ id: 'n', x: 0, y: 0 });
  view.map.viewport = { x: 5, y: 6, zoom: 1 };
  let saved = 0; view.saveViewport = () => { saved++; };
  view.focusNode(view.map.nodes[0]); view.fit();
  assert.deepEqual(plain(view.map.viewport), { x: 5, y: 6, zoom: 1 }); assert.equal(saved, 0);
  view.cardEls = new Map([['n', { offsetHeight: 0 }]]); view.heightsSeen = new Map();
  view.settleCardHeights();
  assert.equal(view.heightsSeen.size, 0, 'no height 0 recorded');
});

test('UI-focus the opening screen keeps its once while the tab is hidden, and takes the keyboard when it is shown', () => {
  const w = makeWorld(); const { view } = w.makeView('Maps/A/Map.md');
  let shown = false, focused = 0;
  view.contentEl = { isShown: () => shown, ownerDocument: { activeElement: null, body: {} }, contains: () => false };
  view.chat = { isHero: true, focusInput: () => { focused++; } };
  view.focusChatHero();
  assert.equal(focused, 0); assert.notEqual(view.chatHeroFocusedFor, view.map.id);
  shown = true; view.focusChatHero();
  assert.equal(focused, 1);
});

test('F4 a setState that fails (Obsidian swallows it) is not a success: openMapInNewTab returns null', async () => {
  const w = makeWorld({ setStateFails: true });
  assert.equal(await w.plugin.openMapInNewTab('Maps/B/Map.md'), null);
});

test('L1 an error from opening the new tab is shown, not swallowed', async () => {
  const notices = [];
  const w = makeWorld({ notices }); const { view } = w.makeView('Maps/A/Map.md');
  w.plugin.openMapInNewTab = async () => { throw new Error('tab boom'); };
  view.openNewMindMapModal(); await settle();
  assert.ok(notices.some(text => String(text).includes('tab boom')), JSON.stringify(notices));
});

// B2: AIM start and outline import with a real repository, the real serial mutate and a target view that is not the source view.
const outlineApi = load('experiences/visual-map/outline-import.ts', { obsidian });
async function realWorld({ blank = false } = {}) {
  const { repo } = fixture('en');
  await repo.ensureWorkspace();
  const w = makeWorld({ realRepo: repo });
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

test('B2 AIM start with a map open: the new map opens in a new tab and focus lands there, not on the source view', async () => {
  const { w, source } = await realWorld();
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

test('B2 outline import with a map open: the new map opens in a new tab; fit and the shallow research land on it', async () => {
  const { w, source } = await realWorld();
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

test('F4 outline import: a new tab whose map did not open starts no research', async () => {
  const { w, source } = await realWorld();
  const ran = [];
  w.plugin.openMapInNewTab = async () => ({ path: 'Maps/Other/Map.md', closed: false, fit() { ran.push('fit'); }, startShallowResearch: async () => { ran.push('research'); } });
  const nodes = outlineApi.parseOutline('# Root\n## A\n### B').nodes;
  await source.view.importOutline({ nodes, source: null, shallowResearch: true });
  await settle();
  assert.deepEqual(ran, [], 'nothing runs on a view that is not showing the new map'); assert.ok(!source.view.events.includes('research'));
});
