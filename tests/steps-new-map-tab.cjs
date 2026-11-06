// New maps open in a new tab so the current map keeps its running work; the switcher and path entries follow "plan A" (new tab only when work is running).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, DEFAULT_SETTINGS, obsidian } = require('./support.cjs');
const dom = require('./support-dom.cjs');

class FuzzySuggestModal { constructor() {} setPlaceholder() {} setInstructions() {} open() {} close() {} }

function makeWorld({ existingTitles = [] } = {}) {
  const leaves = [], getLeafCalls = [], revealed = [], viewStates = [];
  const { VisualAgentMapView, default: Plugin } = load('main.ts', { obsidian: { ...obsidian, FuzzySuggestModal } }, { createFragment: dom.createFragment });
  const plugin = new Plugin();
  const created = [];
  plugin.settings = { ...DEFAULT_SETTINGS, language: 'en' };
  plugin.repo = {
    topics: async () => existingTitles.map(title => ({ title })),
    createMap: async title => { created.push(title); return `Maps/${title}/Map.md`; },
    duplicateMap: async (_source, title) => { created.push(title); return `Maps/${title}/Map.md`; },
    mapSwitcherItems: async () => []
  };
  plugin.app = {
    workspace: {
      getLeavesOfType: () => leaves,
      getLeaf: kind => {
        getLeafCalls.push(kind);
        const leaf = {
          view: null,
          getViewState() { return { type: 'visual-agent-map', state: this.view ? this.view.getState() : {} }; },
          // Obsidian's setViewState ends in the view's setState, which opens the map through the plugin's serial queue.
          async setViewState(state) {
            viewStates.push(state);
            const view = new VisualAgentMapView(leaf, plugin);
            view.synchronize = async () => {};
            view.openMapInMutation = async path => { view.path = path; view.map = { id: `id-${path}`, title: path, nodes: [] }; };
            leaf.view = view;
            leaves.push(leaf);
            await view.setState(state.state, {});
          }
        };
        leaf.app = plugin.app;
        return leaf;
      },
      revealLeaf: async leaf => { revealed.push(leaf); },
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
  return { plugin, VisualAgentMapView, leaves, getLeafCalls, revealed, viewStates, created, makeView };
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
  }
});

test('N4 activateView(path): the first tab with running work keeps its map; an already open target is not opened twice', async () => {
  let w = makeWorld(), a = w.makeView('Maps/A/Map.md');
  a.view.startingExpand.add('n1');
  await w.plugin.activateView('Maps/B/Map.md');
  assert.deepEqual(w.getLeafCalls, ['tab']); assert.equal(w.viewStates[0].state.file, 'Maps/B/Map.md');
  assert.equal(a.view.path, 'Maps/A/Map.md');

  w = makeWorld(); a = w.makeView('Maps/A/Map.md'); const b = w.makeView('Maps/B/Map.md');
  a.view.startingExpand.add('n1');
  await w.plugin.activateView('Maps/B/Map.md');
  assert.deepEqual(w.getLeafCalls, []); assert.deepEqual(w.viewStates, []); assert.deepEqual(w.revealed, [b.leaf]);
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
