const assert = require('node:assert/strict');
const { nodeFsAdapter } = require('../support-fs-adapter.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, integrationTest, load, core, node, map, plain, withExpansionCoordinator, obsidian, DEFAULT_SETTINGS, fixture, topicNote, deferred, until } = require('../support.cjs');
test('a running expansion batch cannot be overwritten for the same parent', async () => {
  const { ShallowExpansionCoordinator } = load('experiences/visual-map/expansion-batch.ts');
  const active = new Map(), states = new Map(), coordinator = new ShallowExpansionCoordinator(active, states);
  let finishFirst, dispatched = [];
  const accepted = coordinator.start('parent.md', [node('first'), node('second')], async (child, _signal, markAccepted) => {
    dispatched.push(child.path); markAccepted(); if (child.id === 'first') await new Promise(resolve => { finishFirst = resolve; });
  }, () => {});
  await accepted;
  const originalController = active.get('parent.md');
  await assert.rejects(coordinator.start('parent.md', [node('duplicate')], async child => { dispatched.push(child.path); }, () => {}), /already running/);
  assert.equal(active.get('parent.md'), originalController);
  coordinator.stop('parent.md'); finishFirst();
  await until(() => states.get('parent.md').status !== 'running');
  assert.deepEqual(dispatched, ['first.md', 'second.md']);
  assert.equal(states.get('parent.md').status, 'stopped');
  assert.equal(active.has('parent.md'), false);
});
test('a batch reports topics waiting for a slot as queued until they start, and none after stop', async () => {
  const { ShallowExpansionCoordinator } = load('experiences/visual-map/expansion-batch.ts');
  const active = new Map(), states = new Map(), coordinator = new ShallowExpansionCoordinator(active, states);
  const release = new Map();
  const children = ['a', 'b', 'c', 'd', 'e'].map(id => node(id));
  await coordinator.start('batch', children, async (child, _signal, accepted) => {
    accepted(); await new Promise(resolve => release.set(child.id, resolve));
  }, () => {});
  await until(() => release.size === 3);
  assert.deepEqual(['a', 'b', 'c', 'd', 'e'].map(id => coordinator.isQueued(`${id}.md`)), [false, false, false, true, true]);
  release.get('a')();
  await until(() => release.has('d'));
  assert.equal(coordinator.isQueued('d.md'), false); assert.equal(coordinator.isQueued('e.md'), true);
  coordinator.stop('batch');
  assert.equal(coordinator.isQueued('e.md'), false);
  for (const resolve of release.values()) resolve();
  await until(() => states.get('batch').status === 'stopped');
});
test('a shallow batch with no accepted child rejects after all failures and releases ownership', async () => {
  const { ShallowExpansionCoordinator } = load('experiences/visual-map/expansion-batch.ts');
  const active = new Map(), states = new Map(), coordinator = new ShallowExpansionCoordinator(active, states), calls = [];
  await assert.rejects(coordinator.start('parent.md', [node('first'), node('second')], async child => { calls.push(child.path); throw new Error('not accepted'); }, () => {}), /stopped before launch/);
  assert.deepEqual(calls, ['first.md', 'second.md']);
  assert.equal(states.get('parent.md').completed, 2);
  assert.equal(states.get('parent.md').failures.length, 2);
  assert.equal(active.has('parent.md'), false);
});
integrationTest('pending child suggestions persist across reload and disappear after dismissal', async () => {
  const { PendingSuggestions } = load('pending-suggestions.ts');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vam-proposals-'));
  const file = path.join(directory, 'pending-suggestions.json');
  const errors = [];
  try {
    const first = new PendingSuggestions(nodeFsAdapter, file, error => errors.push(error));
    first.set('topic.md', [{ title: 'A', task: 'Research A', contribution: 'Scope A', parentTitle: '' }]);
    await first.flush();
    const second = new PendingSuggestions(nodeFsAdapter, file, error => errors.push(error));
    await second.load();
    assert.equal(second.get('topic.md')[0].title, 'A');
    second.delete('topic.md'); await second.flush();
    const third = new PendingSuggestions(nodeFsAdapter, file, error => errors.push(error)); await third.load();
    assert.equal(third.has('topic.md'), false);
    assert.deepEqual(errors, []);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
integrationTest('proposal persistence reports disk write failure to the caller', async () => {
  const { PendingSuggestions } = load('pending-suggestions.ts');
  const errors = [];
  const store = new PendingSuggestions(nodeFsAdapter, path.join(os.tmpdir(), `vam-missing-${Date.now()}`, 'pending.json'), error => errors.push(error));
  store.set('topic.md', [{ title: 'A', task: 'Research A', contribution: '' }]);
  await assert.rejects(store.flush());
  assert.equal(errors.length, 1);
});
integrationTest('selected subtopics move together and copied notes keep their content with new identities', async () => {
  const { repo, app } = fixture(), root = await topicNote(repo, 'Root', 'a');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md';
  const mapDoc = { id: 'map-a', title: 'map-a', version: 1, nodes: [root], viewport: { x: 0, y: 0, zoom: 1 } };
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const first = await repo.createNote('First', 'a', mapDoc, mapPath, 'inherited');
  const second = await repo.createNote('Second', 'a', mapDoc, mapPath, 'inherited');
  first.parentId = root.id; second.parentId = root.id; mapDoc.nodes.push(first, second); await repo.saveMap(mapPath, mapDoc);
  await repo.updateNote(first.path, { detail: 'Original knowledge', preview: 'My handwritten preview' });
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const plugin = { repo, settings: { ...DEFAULT_SETTINGS }, rebuildDerivedData: async () => {} };
  const view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.contentEl = { querySelector: () => null }; view.render = () => {}; view.hydrate = async () => {};
  view.multiSelected = new Set([first.id]);
  await view.moveSelected(second);
  assert.equal((await repo.readMap(mapPath)).nodes.find(node => node.id === first.id).parentId, second.id);
  view.multiSelected = new Set([first.id]);
  await view.copySelected(root);
  const saved = await repo.readMap(mapPath), copied = saved.nodes.find(node => node.id !== first.id && node.id !== second.id && node.id !== root.id);
  assert.equal(saved.nodes.length, 4);
  assert.equal(copied.parentId, root.id);
  assert.notEqual(copied.path, first.path);
  const note = await repo.readNote(copied.path);
  assert.equal(note.detail, 'Original knowledge'); assert.equal(note.preview, 'My handwritten preview');
  await view.history.undo().undo();
  assert.equal((await repo.readMap(mapPath)).nodes.length, 3);
  assert.equal((await repo.readNote('Agent Workspace/Topics/map-a/Unassigned/First 副本.md')).topicState, 'unassigned');
  await view.history.redo().redo();
  assert.equal((await repo.readMap(mapPath)).nodes.length, 4);
  assert.equal((await repo.readNote(copied.path)).topicState, 'active');
});
integrationTest('copying a legacy note without a title field keeps its filename as the copy title', async () => {
  const { repo, app } = fixture();
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md';
  const mapDoc = { id: 'map-a', title: 'map-a', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  await app.vault.create('Agent Workspace/Topics/map-a/Notes/budget.md', '---\nagent-map-node: true\nnode-id: original\ntopic-id: map-a\n---\n# budget\n\nOriginal content\n');
  const copy = await repo.duplicateNote('Agent Workspace/Topics/map-a/Notes/budget.md', mapDoc, mapPath);
  assert.equal((await repo.readNote(copy.path)).title, 'budget 副本');
  assert.match(await app.vault.read(app.vault.getAbstractFileByPath(copy.path)), /^---[\s\S]*# budget 副本/m);
});
integrationTest('failed batch copy parks created notes and leaves the map unchanged', async () => {
  const { repo, app } = fixture(), root = await topicNote(repo, 'Root', 'a');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md';
  const mapDoc = { id: 'map-a', title: 'map-a', version: 1, nodes: [root], viewport: { x: 0, y: 0, zoom: 1 } };
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const first = await repo.createNote('First', 'a', mapDoc, mapPath, 'inherited');
  const second = await repo.createNote('Second', 'a', mapDoc, mapPath, 'inherited');
  first.parentId = root.id; second.parentId = root.id; mapDoc.nodes.push(first, second); await repo.saveMap(mapPath, mapDoc);
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const plugin = { repo, settings: { ...DEFAULT_SETTINGS }, rebuildDerivedData: async () => {} };
  const view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.render = () => {}; view.hydrate = async () => {};
  view.multiSelected = new Set([first.id, second.id]);
  const duplicate = repo.duplicateNote.bind(repo); let count = 0;
  repo.duplicateNote = async (...args) => { if (++count === 2) throw new Error('injected duplicate failure'); return duplicate(...args); };
  await assert.rejects(view.copySelected(root), /injected duplicate failure/);
  assert.equal((await repo.readMap(mapPath)).nodes.length, 3);
  assert.equal((await repo.readNote('Agent Workspace/Topics/map-a/Unassigned/First 副本.md')).topicState, 'unassigned');
  assert.equal(view.history.canUndo, false);
});
integrationTest('failed map save during copy parks the duplicate without changing the map', async () => {
  const { repo, app } = fixture(), root = await topicNote(repo, 'Root', 'a');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md';
  const mapDoc = { id: 'map-a', title: 'map-a', version: 1, nodes: [root], viewport: { x: 0, y: 0, zoom: 1 } };
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const plugin = { repo, settings: { ...DEFAULT_SETTINGS }, rebuildDerivedData: async () => {} };
  const view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.render = () => {}; view.hydrate = async () => {};
  view.multiSelected = new Set([root.id]);
  const save = repo.saveMap.bind(repo); let fail = true;
  repo.saveMap = async (...args) => { if (fail) { fail = false; throw new Error('injected map save failure'); } return save(...args); };
  await assert.rejects(view.copySelected(root), /injected map save failure/);
  assert.equal((await repo.readMap(mapPath)).nodes.length, 1);
  assert.equal((await repo.readNote('Agent Workspace/Topics/map-a/Unassigned/Root 副本.md')).topicState, 'unassigned');
  assert.equal(view.history.canUndo, false);
});
integrationTest('removing selected subtopic branches parks notes and can be undone', async () => {
  const { repo, app } = fixture(), root = await topicNote(repo, 'Root', 'a');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md';
  const mapDoc = { id: 'map-a', title: 'map-a', version: 1, nodes: [root], viewport: { x: 0, y: 0, zoom: 1 } };
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const child = await repo.createNote('Child', 'a', mapDoc, mapPath, 'inherited'); child.parentId = root.id;
  const grandchild = await repo.createNote('Grandchild', 'a', mapDoc, mapPath, 'inherited'); grandchild.parentId = child.id;
  mapDoc.nodes.push(child, grandchild); await repo.saveMap(mapPath, mapDoc);
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const plugin = { repo, settings: { ...DEFAULT_SETTINGS }, rebuildDerivedData: async () => {} };
  const view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.render = () => {}; view.hydrate = async () => {};
  view.multiSelected = new Set([child.id]); await view.removeSelected();
  assert.equal((await repo.readMap(mapPath)).nodes.length, 1);
  assert.equal((await repo.readNote(`Agent Workspace/Topics/map-a/Unassigned/Child.md`)).topicState, 'unassigned');
  await view.history.undo().undo();
  assert.equal((await repo.readMap(mapPath)).nodes.length, 3);
  assert.ok(app.vault.getAbstractFileByPath(child.path));
});
integrationTest('failed batch removal restores map and active note ownership', async () => {
  const { repo, app } = fixture(), root = await topicNote(repo, 'Root', 'a');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md';
  const mapDoc = { id: 'map-a', title: 'map-a', version: 1, nodes: [root], viewport: { x: 0, y: 0, zoom: 1 } };
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const child = await repo.createNote('Child', 'a', mapDoc, mapPath, 'inherited'); child.parentId = root.id;
  mapDoc.nodes.push(child); await repo.saveMap(mapPath, mapDoc);
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const plugin = { repo, settings: { ...DEFAULT_SETTINGS }, rebuildDerivedData: async () => {} };
  const view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.render = () => {}; view.hydrate = async () => {};
  view.multiSelected = new Set([child.id]);
  const save = repo.saveMap.bind(repo); let fail = true;
  repo.saveMap = async (...args) => { if (fail) { fail = false; throw new Error('injected map save failure'); } return save(...args); };
  await assert.rejects(view.removeSelected(), /injected map save failure/);
  assert.equal((await repo.readMap(mapPath)).nodes.length, 2);
  assert.equal((await repo.readNote(child.path)).topicState, 'active');
  assert.equal((await repo.readNote(child.path)).mapId, mapDoc.id);
  assert.equal(view.history.canUndo, false);
});
integrationTest('failed rebuild after batch removal also restores map and notes', async () => {
  const { repo, app } = fixture(), root = await topicNote(repo, 'Root', 'a');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md';
  const mapDoc = { id: 'map-a', title: 'map-a', version: 1, nodes: [root], viewport: { x: 0, y: 0, zoom: 1 } };
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const child = await repo.createNote('Child', 'a', mapDoc, mapPath, 'inherited'); child.parentId = root.id;
  mapDoc.nodes.push(child); await repo.saveMap(mapPath, mapDoc);
  const { VisualAgentMapView } = load('main.ts', { obsidian }); let fail = true;
  const plugin = { repo, settings: { ...DEFAULT_SETTINGS }, rebuildDerivedData: async () => { if (fail) { fail = false; throw new Error('injected rebuild failure'); } } };
  const view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.render = () => {}; view.hydrate = async () => {};
  view.multiSelected = new Set([child.id]);
  await assert.rejects(view.removeSelected(), /injected rebuild failure/);
  assert.equal((await repo.readMap(mapPath)).nodes.length, 2);
  assert.equal((await repo.readNote(child.path)).topicState, 'active');
  assert.equal(view.history.canUndo, false);
});
integrationTest('confirmed child batches rebuild derived data only once', async () => {
  const { repo, app } = fixture(), parent = await topicNote(repo, 'Parent', 'a'); let rebuilds = 0;
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md';
  const mapDoc = { id: 'map-a', title: 'map-a', version: 1, nodes: [parent], viewport: { x: 0, y: 0, zoom: 1 } };
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app }, withExpansionCoordinator({ repo, settings: { ...DEFAULT_SETTINGS }, rebuildDerivedData: async () => { rebuilds++; } }));
  view.path = mapPath; view.map = mapDoc; view.contentEl = { querySelector: () => null }; view.render = () => {}; view.hydrate = async () => {}; view.focusNode = () => {};
  await view.createChildBatch(parent, [
    { title: 'One', task: 'Task one', contribution: 'First' },
    { title: 'Two', task: 'Task two', contribution: 'Second' },
    { title: 'Three', task: 'Task three', contribution: 'Third' }
  ]);
  const saved = await repo.readMap(mapPath);
  assert.equal(saved.nodes.length, 4);
  assert.equal(rebuilds, 1);
  assert.equal((await repo.readNote(saved.nodes[1].path)).prompt, 'Task one');
});
integrationTest('two-level child batches attach grandchildren and still rebuild once', async () => {
  const { repo, app } = fixture(), parent = await topicNote(repo, 'Parent', 'a'); let rebuilds = 0;
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md';
  const mapDoc = { id: 'map-a', title: 'map-a', version: 1, nodes: [parent], viewport: { x: 0, y: 0, zoom: 1 } };
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app }, withExpansionCoordinator({ repo, settings: { ...DEFAULT_SETTINGS }, rebuildDerivedData: async () => { rebuilds++; } }));
  view.path = mapPath; view.map = mapDoc; view.contentEl = { querySelector: () => null }; view.render = () => {}; view.hydrate = async () => {}; view.focusNode = () => {};
  await view.createChildBatch(parent, [
    { title: 'A', task: 'Explore A', contribution: '' },
    { title: 'B', task: 'Explore B', contribution: '' },
    { title: 'A1', task: 'Explore A1', contribution: '', parentTitle: 'A' }
  ]);
  const saved = await repo.readMap(mapPath);
  assert.equal(saved.nodes.length, 4);
  assert.equal(saved.nodes[3].parentId, saved.nodes[1].id);
  assert.equal(rebuilds, 1);
});
integrationTest('orphan grandchild proposals fail instead of silently disappearing', async () => {
  const { repo, app } = fixture(), parent = await topicNote(repo, 'Parent', 'a');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md';
  const mapDoc = { id: 'map-a', title: 'map-a', version: 1, nodes: [parent], viewport: { x: 0, y: 0, zoom: 1 } };
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app }, withExpansionCoordinator({ repo, settings: { ...DEFAULT_SETTINGS }, rebuildDerivedData: async () => {} }));
  view.path = mapPath; view.map = mapDoc; view.render = () => {}; view.hydrate = async () => {};
  await assert.rejects(view.createChildBatch(parent, [{ title: 'Orphan', task: '', contribution: '', parentTitle: 'Missing' }]), /Select the parent topic before its child/);
  assert.equal((await repo.readMap(mapPath)).nodes.length, 1);
});
integrationTest('duplicate first-level proposal names cannot misplace grandchildren', async () => {
  const { repo, app } = fixture(), parent = await topicNote(repo, 'Parent', 'a');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md';
  const mapDoc = { id: 'map-a', title: 'map-a', version: 1, nodes: [parent], viewport: { x: 0, y: 0, zoom: 1 } };
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app }, withExpansionCoordinator({ repo, settings: { ...DEFAULT_SETTINGS }, rebuildDerivedData: async () => {} }));
  view.path = mapPath; view.map = mapDoc; view.render = () => {}; view.hydrate = async () => {};
  await assert.rejects(view.createChildBatch(parent, [
    { title: 'Same', task: '', contribution: '' },
    { title: 'Same', task: '', contribution: '' },
    { title: 'Child', task: '', contribution: '', parentTitle: 'Same' }
  ]), /First-level topic names must be unique/);
  assert.equal((await repo.readMap(mapPath)).nodes.length, 1);
});
test('ambiguous original AI proposal names are rejected before editing', () => {
  const notices = []; let opened = 0;
  const { VisualAgentMapView } = load('main.ts', { obsidian: { ...obsidian, Notice: class { constructor(message) { notices.push(message); } }, Modal: class { open() { opened++; } } } });
  const suggestions = [
    { title: 'Same', task: '', contribution: '', parentTitle: '' },
    { title: 'Same', task: '', contribution: '', parentTitle: '' },
    { title: 'Child', task: '', contribution: '', parentTitle: 'Same' }
  ];
  const plugin = { repo: { readNote: async () => ({}) }, pendingSuggestions: new Map([['parent.md', suggestions]]), pendingResearchOptions: new Map([['parent.md', { researchDepth: 'fast' }]]) };
  const view = new VisualAgentMapView({ app: {} }, plugin);
  view.openChildSuggestions({ id: 'parent', path: 'parent.md' }, suggestions);
  assert.equal(opened, 0);
  assert.match(notices[0], /duplicate first-level names/);
  assert.equal(plugin.pendingSuggestions.has('parent.md'), false);
  assert.equal(plugin.pendingResearchOptions.has('parent.md'), false);
});
integrationTest('structural two-level child creation stores shallow-research settings without dispatching', async () => {
  const { repo, app } = fixture(), parent = await topicNote(repo, 'Parent', 'a');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md';
  const mapDoc = { id: 'map-a', title: 'map-a', version: 1, nodes: [parent], viewport: { x: 0, y: 0, zoom: 1 } };
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const plugin = withExpansionCoordinator({ repo, settings: { ...DEFAULT_SETTINGS }, rebuildDerivedData: async () => {} });
  const view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.contentEl = { querySelector: () => null }; view.render = () => {}; view.hydrate = async () => {}; view.focusNode = () => {};
  const researched = []; view.runAgent = async node => { researched.push(node.id); await repo.updateNote(node.path, { status: 'running' }); };
  await view.createChildBatch(parent, [
    { title: 'A', task: 'Research A', contribution: '' },
    { title: 'A1', task: 'Research A1', contribution: '', parentTitle: 'A' }
  ], { researchMode: 'research', researchDepth: 'normal', visualMode: 'auto', referenceGroups: [] });
  const saved = await repo.readMap(mapPath);
  assert.deepEqual(researched, []);
  for (const node of saved.nodes.slice(1)) {
    const note = await repo.readNote(node.path);
    assert.equal(note.researchDepth, 'fast'); assert.equal(note.researchMode, 'research'); assert.equal(note.visualMode, 'auto');
  }
});
integrationTest('guided child creation stores shallow-research settings without dispatching', async () => {
  const { repo, app } = fixture(), parent = await topicNote(repo, 'Parent', 'model-a');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md';
  const mapDoc = map([parent]); mapDoc.id = 'map-a';
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const plugin = withExpansionCoordinator({ repo, settings: { ...DEFAULT_SETTINGS }, rebuildDerivedData: async () => {} });
  const view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.contentEl = { querySelector: () => null }; view.render = () => {}; view.hydrate = async () => {}; view.focusNode = () => {};
  const researched = []; view.runAgent = async child => { researched.push(child.id); await repo.updateNote(child.path, { status: 'running' }); };
  await view.createChildBatch(parent, [{ title: 'Research me', task: 'Find evidence', contribution: '', parentTitle: '' }], { researchMode: 'local', researchDepth: 'fast', visualMode: 'off', referenceGroups: [], shallowResearch: true });
  assert.deepEqual(researched, []);
  assert.equal((await repo.readNote(view.map.nodes.at(-1).path)).researchMode, 'research');
});
integrationTest('one shallow-research startup failure marks that child and does not strand later children', async () => {
  const { repo, app } = fixture(), parent = await topicNote(repo, 'Parent', 'model-a');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md', mapDoc = map([parent]); mapDoc.id = 'map-a';
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const failures = [], started = [];
  const plugin = withExpansionCoordinator({ repo, settings: { ...DEFAULT_SETTINGS }, running: new Set(), abortChartJobs: () => {}, addChartsAfterWrite: () => {}, pendingSuggestions: new Map(), pendingResearchOptions: new Map(), rebuildDerivedData: async () => {}, mutate: async work => work(), recordFailure: (context, error) => { failures.push(`${context}: ${error.message}`); return error.message; } });
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.contentEl = { querySelector: () => null }; view.render = () => {}; view.hydrate = async () => {};
  view.runAgent = async (child, _done, failed, _options, accepted) => {
    const note = await repo.readNote(child.path); started.push(note.title);
    if (note.title === 'First') { await repo.updateNote(child.path, { status: 'error' }); const message = plugin.recordFailure('AI task failed', new Error('startup failed')); failed?.(message); return null; }
    await repo.updateNote(child.path, { status: 'running' }); accepted?.(); return { finished: Promise.resolve() };
  };
  const children = await view.createChildBatch(parent, [
    { title: 'First', task: 'Research first', contribution: '' },
    { title: 'Second', task: 'Research second', contribution: '' }
  ], { researchMode: 'research', researchDepth: 'fast', visualMode: 'off', referenceGroups: [] });
  await view.startShallowResearch(parent, children, { researchMode: 'research', researchDepth: 'fast', visualMode: 'off', referenceGroups: [] });
  await until(() => plugin.expansionBatches.get(parent.path).status !== 'running');
  const saved = await repo.readMap(mapPath);
  assert.deepEqual(started, ['First', 'Second']);
  assert.equal((await repo.readNote(saved.nodes[1].path)).status, 'error');
  assert.equal((await repo.readNote(saved.nodes[2].path)).status, 'running');
  assert.match(failures[0], /startup failed/);
  assert.deepEqual(plugin.expansionBatches.get(parent.path).failures.length, 1);
});
integrationTest('shallow research uses the research-topic task when a child has no research question', async () => {
  const { repo, app } = fixture('en'), parent = await topicNote(repo, 'Parent', 'model-a');
  const mapPath = 'Agent Workspace/Topics/map-s/Map.md', mapDoc = map([parent]); mapDoc.id = 'map-s';
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const tasks = [];
  const plugin = withExpansionCoordinator({ repo, settings: { ...DEFAULT_SETTINGS, language: 'en' }, running: new Set(), abortChartJobs: () => {}, addChartsAfterWrite: () => {}, pendingSuggestions: new Map(), pendingResearchOptions: new Map(), rebuildDerivedData: async () => {}, mutate: async work => work(), recordFailure: (_context, error) => error.message });
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.contentEl = { querySelector: () => null }; view.render = () => {}; view.hydrate = async () => {};
  view.runAgent = async (_child, _done, _failed, options, accepted) => { tasks.push(options.task); accepted?.(); return { finished: Promise.resolve() }; };
  const options = { researchMode: 'research', researchDepth: 'fast', visualMode: 'off', referenceGroups: [], outputLanguage: 'en', requirements: '' };
  const children = await view.createChildBatch(parent, [{ title: 'Night markets', task: '', contribution: '' }, { title: 'Asked', task: 'Why do they exist?', contribution: '' }], options);
  await view.startShallowResearch(parent, children, options);
  await until(() => plugin.expansionBatches.get(parent.path).status !== 'running');
  const { researchTopicTask } = load('experiences/visual-map/steps/fragments.ts');
  assert.deepEqual(Array.from(tasks), [researchTopicTask('en', 'Night markets'), 'Why do they exist?']);
});
integrationTest('cancelling shallow research stops the batch without marking unstarted children as errors', async () => {
  const { repo, app } = fixture(), parent = await topicNote(repo, 'Parent', 'model-a');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md', mapDoc = map([parent]); mapDoc.id = 'map-a';
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const failures = [], started = [], controller = new AbortController(); let finishFirst;
  const plugin = withExpansionCoordinator({ repo, settings: { ...DEFAULT_SETTINGS }, running: new Set(), abortChartJobs: () => {}, addChartsAfterWrite: () => {}, pendingSuggestions: new Map(), pendingResearchOptions: new Map(), rebuildDerivedData: async () => {}, mutate: async work => work(), recordFailure: (context, error) => { failures.push(`${context}: ${error.message}`); return error.message; } });
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.contentEl = { querySelector: () => null }; view.render = () => {}; view.hydrate = async () => {};
  view.runAgent = async (child, _done, failed, options, accepted) => {
    const note = await repo.readNote(child.path); started.push(note.title); await repo.updateNote(child.path, { status: 'running' }); accepted?.();
    const finished = new Promise(resolve => { finishFirst = resolve; options.signal.addEventListener('abort', async () => { await repo.updateNote(child.path, { status: note.status }); resolve(); }, { once: true }); });
    return { finished };
  };
  const children = await view.createChildBatch(parent, [
    { title: 'First', task: 'Research first', contribution: '' },
    { title: 'Second', task: 'Research second', contribution: '' },
    { title: 'Third', task: 'Research third', contribution: '' },
    { title: 'Fourth', task: 'Research fourth', contribution: '' }
  ], { researchMode: 'research', researchDepth: 'fast', visualMode: 'off', referenceGroups: [] });
  await view.startShallowResearch(parent, children, { researchMode: 'research', researchDepth: 'fast', visualMode: 'off', referenceGroups: [], signal: controller.signal });
  await until(() => started.length === 3);
  plugin.expansionCoordinator.stop(parent.path);
  await until(() => plugin.expansionBatches.get(parent.path).status !== 'running');
  finishFirst?.();
  const saved = await repo.readMap(mapPath);
  assert.deepEqual(started, ['First', 'Second', 'Third']);
  assert.equal(saved.nodes.slice(1).map(child => child.path).join('|'), Array.from(children, child => child.path).join('|'));
  assert.equal((await repo.readNote(saved.nodes[1].path)).status, 'idea');
  assert.equal((await repo.readNote(saved.nodes[2].path)).status, 'idea');
  assert.equal((await repo.readNote(saved.nodes[3].path)).status, 'idea');
  assert.equal((await repo.readNote(saved.nodes[4].path)).status, 'idea');
  assert.deepEqual(failures, []);
});
integrationTest('shallow research without chosen sources gives each child no reference groups', async () => {
  const { repo, app } = fixture(), parent = await topicNote(repo, 'Parent', 'model-a');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md', mapDoc = map([parent]); mapDoc.id = 'map-a';
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const plugin = withExpansionCoordinator({ repo, settings: { ...DEFAULT_SETTINGS }, rebuildDerivedData: async () => {}, recordFailure: (_context, error) => error.message, mutate: async work => work(), views: () => [view] });
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.contentEl = { querySelector: () => null }; view.render = () => {}; view.hydrate = async () => {};
  const received = [];
  view.runAgent = async (_child, _done, _failed, options, accepted) => { received.push(options.referenceGroups); accepted(); return { finished: Promise.resolve() }; };
  const children = await view.createChildBatch(parent, [
    { title: 'First', task: 'Research first', contribution: '' },
    { title: 'Second', task: 'Research second', contribution: '' }
  ], { researchMode: 'research', researchDepth: 'fast', visualMode: 'off' });
  await view.startShallowResearch(parent, children, { researchMode: 'research', researchDepth: 'fast', visualMode: 'off', shallowResearch: true });
  await until(() => plugin.expansionBatches.get(parent.path)?.status !== 'running');
  assert.deepEqual(plain(received), [[], []]);
});
integrationTest('accepted shallow research is parallel, detached from modal close, and stopped by the parent', async () => {
  const { repo, app } = fixture(), parent = await topicNote(repo, 'Parent', 'model-a');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md', mapDoc = map([parent]); mapDoc.id = 'map-a';
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const controller = new AbortController(), started = [], finish = new Map(), signals = [];
  const plugin = withExpansionCoordinator({ repo, settings: { ...DEFAULT_SETTINGS }, rebuildDerivedData: async () => {}, recordFailure: (_context, error) => error.message, mutate: async work => work(), views: () => [view] });
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.contentEl = { querySelector: () => null }; view.render = () => {}; view.hydrate = async () => {};
  const received = new Map();
  view.runAgent = async (child, _done, _failed, options, accepted) => {
    started.push((await repo.readNote(child.path)).title);
    received.set(child.path, options.referenceGroups); assert.equal(options.onProgress, undefined);
    signals.push(options.signal); accepted();
    return { finished: new Promise(resolve => finish.set(child.path, resolve)) };
  };
  const children = await view.createChildBatch(parent, [
    { title: 'First', task: 'Research first', contribution: '' },
    { title: 'Second', task: 'Research second', contribution: '' }
  ], { researchMode: 'research', researchDepth: 'fast', visualMode: 'off', referenceGroups: [{ id: 'parent-source', documents: [{ path: 'External.md' }] }] });
  const pending = view.startShallowResearch(parent, children, { researchMode: 'research', researchDepth: 'fast', visualMode: 'off', referenceGroups: [{ id: 'parent-source', documents: [{ path: 'External.md' }] }], shallowResearch: true, signal: controller.signal, onProgress: () => assert.fail('modal progress callback retained') });
  await pending;
  await until(() => started.length === 2);
  assert.deepEqual(started, ['First', 'Second']);
  for (const child of children) assert.deepEqual(plain(received.get(child.path)), [{ id: 'parent-source', documents: [{ path: 'External.md' }] }], 'each child researches with the sources chosen in the dialog');
  controller.abort();
  assert.equal(signals[0].aborted, false);
  finish.get(children[0].path)();
  await until(() => started.length === 2);
  assert.deepEqual(started, ['First', 'Second']);
  plugin.expansionCoordinator.stop(parent.path);
  assert.equal(signals[1].aborted, true);
  finish.get(children[1].path)();
  await until(() => plugin.expansionBatches.get(parent.path).status !== 'running');
  assert.equal(plugin.expansionBatches.get(parent.path).status, 'stopped');
  assert.equal(plugin.activeTasks.has(parent.path), false);
});
integrationTest('guided AI wait leaves map mutations free and creates the reviewed subtopics at the latest parent position', async () => {
  const { repo, app } = fixture(), parent = await topicNote(repo, 'Parent', 'model-a');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md', mapDoc = map([parent]); mapDoc.id = 'map-a';
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  let resolveModel, tail = Promise.resolve();
  const plugin = withExpansionCoordinator({ repo, settings: { ...DEFAULT_SETTINGS }, running: new Set(), abortChartJobs: () => {}, addChartsAfterWrite: () => {}, pendingSuggestions: new Map(), pendingResearchOptions: new Map(), rebuildDerivedData: async () => {}, recordFailure: (_context, error) => error.message,
    askModel: () => new Promise(resolve => { resolveModel = resolve; }), mutate(work) { const job = tail.then(work); tail = job.catch(() => {}); return job; } });
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.contentEl = { querySelector: () => null }; view.render = () => {}; view.hydrate = async () => {}; view.focusNode = () => {};
  const options = { researchMode: 'local', researchDepth: 'fast', visualMode: 'off', referenceGroups: [], shallowResearch: false };
  let create;
  const job = view.proposeChildren(parent, options, '', (items, run) => { create = () => run(items); }, message => assert.fail(message));
  await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(plugin.quickExpandPending.has(parent.path), true);
  let moved = false;
  const change = plugin.mutate(async () => { await view.mapChange(map => { map.nodes[0].x = 500; }, false); moved = true; });
  const progressed = await Promise.race([change.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 100))]);
  resolveModel({ summary: '', detail: '', visualReferences: [], suggestions: [{ title: 'Child', task: 'Explore', contribution: '', parentTitle: '' }] });
  await job;
  assert.equal(progressed, true); assert.equal(moved, true);
  assert.equal(plugin.quickExpandPending.size, 0);
  await create();
  const saved = await repo.readMap(mapPath); assert.equal(saved.nodes.length, 2); assert.equal(saved.nodes[1].x, 860);
});
integrationTest('accepted guided expansion closes its modal but still offers a deferred provider result', async () => {
  const { repo, app } = fixture(), parent = await topicNote(repo, 'Parent', 'model-a');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md', mapDoc = map([parent]); mapDoc.id = 'map-a';
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const pending = deferred(), modalController = new AbortController(); let accepted = false, offered;
  const plugin = withExpansionCoordinator({
    repo, settings: { ...DEFAULT_SETTINGS, language: 'en' }, running: new Set(), abortChartJobs: () => {}, addChartsAfterWrite: () => {}, pendingSuggestions: new Map(), pendingResearchOptions: new Map(),
    rebuildDerivedData: async () => {}, mutate: async work => work(), recordFailure: (_context, error) => error.message,
    askModel: (_context, _model, _reasoning, _signal, _exchange, onAccepted) => { onAccepted?.(); return pending.promise; }
  });
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.contentEl = { querySelector: () => null }; view.render = () => {}; view.hydrate = async () => {}; view.focusNode = () => {};
  const options = { researchMode: 'local', researchDepth: 'fast', visualMode: 'off', referenceGroups: [], shallowResearch: false, signal: modalController.signal };
  const job = view.proposeChildren(parent, options, '', items => { offered = items; }, message => assert.fail(message), () => { accepted = true; modalController.abort(); });
  await until(() => accepted);
  assert.equal(modalController.signal.aborted, true);
  assert.ok(plugin.running.has(parent.path));
  assert.ok(plugin.activeTasks.has(parent.path));
  assert.equal(plugin.activeTasks.get(parent.path).signal.aborted, false);
  pending.resolve({ summary: '', detail: '', visualReferences: [], suggestions: [{ title: 'Accepted child', task: 'Explore this', contribution: '', parentTitle: '' }] });
  await job;
  assert.equal(JSON.stringify(offered.map(item => item.title)), JSON.stringify(['Accepted child']));
  assert.equal(plugin.pendingSuggestions.get(parent.path).length, 1, 'kept as pending proposals');
  assert.equal(plugin.activeTasks.has(parent.path), false);
  assert.equal(plugin.quickExpandPending.has(parent.path), false);
});
integrationTest('stopping shallow research on reviewed subtopics before child acceptance keeps the created topics without a failure', async () => {
  const { repo, app } = fixture(), parent = await topicNote(repo, 'Parent', 'model-a');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md', mapDoc = map([parent]); mapDoc.id = 'map-a';
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const failures = [], plugin = withExpansionCoordinator({
    repo, settings: { ...DEFAULT_SETTINGS }, running: new Set(), abortChartJobs: () => {}, addChartsAfterWrite: () => {}, pendingSuggestions: new Map(), pendingResearchOptions: new Map(),
    rebuildDerivedData: async () => {}, mutate: async work => work(), recordFailure: (context, error) => { failures.push(`${context}: ${error.message}`); return error.message; },
    askModel: async (_context, _model, _reasoning, _signal, _exchange, accepted) => {
      accepted?.();
      return { summary: '', detail: '', visualReferences: [], suggestions: [{ title: 'Accepted child', task: 'Explore this', contribution: '', parentTitle: '' }] };
    }
  });
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.contentEl = { querySelector: () => null }; view.render = () => {}; view.hydrate = async () => {}; view.focusNode = () => {};
  let childSignal, failure = '', create;
  view.runAgent = async (_child, _done, failed, options) => {
    childSignal = options.signal;
    return new Promise(resolve => childSignal.addEventListener('abort', () => resolve(null), { once: true }));
  };
  await view.proposeChildren(parent, { researchMode: 'research', researchDepth: 'fast', visualMode: 'off', referenceGroups: [], shallowResearch: true }, '', (items, run) => { create = () => run(items); }, message => { failure = message; });
  const job = create();
  await until(() => childSignal);
  plugin.expansionCoordinator.stop(parent.path);
  // The review's Create reports the stop; it is not recorded as an expansion or research failure.
  await assert.rejects(job, /stopped before launch/);
  const saved = await repo.readMap(mapPath);
  assert.equal(saved.nodes.length, 2);
  assert.equal((await repo.readNote(saved.nodes[1].path)).title, 'Accepted child');
  assert.equal(childSignal.aborted, true);
  assert.equal(plugin.expansionBatches.get(parent.path).status, 'stopped');
  assert.equal(plugin.expansionBatches.get(parent.path).failures.length, 0);
  assert.equal(plugin.quickExpandPending.has(parent.path), false);
  assert.deepEqual(failures, []);
  assert.equal(failure, '');
});
integrationTest('guided expansion keeps a genuine provider failure visible after a stopped shallow research batch', async () => {
  const { repo, app } = fixture(), parent = await topicNote(repo, 'Parent', 'model-a');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md', mapDoc = map([parent]); mapDoc.id = 'map-a';
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  let attempts = 0;
  const plugin = withExpansionCoordinator({ repo, settings: { ...DEFAULT_SETTINGS }, running: new Set(), abortChartJobs: () => {}, addChartsAfterWrite: () => {}, pendingSuggestions: new Map(), pendingResearchOptions: new Map(), rebuildDerivedData: async () => {}, mutate: async work => work(), recordFailure: (_context, error) => error.message,
    askModel: async (_context, _model, _reasoning, _signal, _exchange, accepted) => {
      attempts++;
      if (attempts === 1) {
        accepted?.();
        return { summary: '', detail: '', visualReferences: [], suggestions: [{ title: 'Stopped child', task: 'Explore this', contribution: '', parentTitle: '' }] };
      }
      throw new Error('provider unavailable');
    } });
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.contentEl = { querySelector: () => null }; view.render = () => {}; view.hydrate = async () => {}; view.focusNode = () => {};
  let childSignal, create;
  view.runAgent = async (_child, _done, _failed, options) => { childSignal = options.signal; return new Promise(resolve => childSignal.addEventListener('abort', () => resolve(null), { once: true })); };
  await view.proposeChildren(parent, { researchMode: 'research', researchDepth: 'fast', visualMode: 'off', referenceGroups: [], shallowResearch: true }, '', (items, run) => { create = () => run(items); }, message => assert.fail(message));
  const research = create();
  await until(() => childSignal);
  plugin.expansionCoordinator.stop(parent.path);
  await assert.rejects(research, /stopped before launch/);
  assert.equal(plugin.expansionBatches.get(parent.path).status, 'stopped');
  let failure = '';
  await view.proposeChildren(parent, { researchMode: 'research', researchDepth: 'fast', visualMode: 'off', referenceGroups: [], shallowResearch: false }, '', () => assert.fail('nothing to offer'), message => { failure = message; });
  assert.equal(failure, 'provider unavailable', 'the earlier stopped batch does not hide a new failure');
});
integrationTest('Map Stop before accepted decomposition ignores a late answer without offering or creating children', async () => {
  const { repo, app } = fixture(), parent = await topicNote(repo, 'Parent', 'model-a');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md', mapDoc = map([parent]); mapDoc.id = 'map-a';
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  let resolveModel, accepted = false, recorded = [];
  const plugin = withExpansionCoordinator({ repo, settings: { ...DEFAULT_SETTINGS }, running: new Set(), abortChartJobs: () => {}, addChartsAfterWrite: () => {}, pendingSuggestions: new Map(), pendingResearchOptions: new Map(), rebuildDerivedData: async () => {}, mutate: async work => work(), recordFailure: (context, error) => { recorded.push(`${context}: ${error.message}`); return error.message; },
    askModel: (_context, _model, _reasoning, _signal, _exchange, onAccepted) => { onAccepted?.(); accepted = true; return new Promise(resolve => { resolveModel = resolve; }); } });
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.contentEl = { querySelector: () => null }; view.render = () => {}; view.hydrate = async () => {}; view.focusNode = () => {};
  const job = view.proposeChildren(parent, { researchMode: 'research', researchDepth: 'fast', visualMode: 'off', referenceGroups: [], shallowResearch: true }, '', () => assert.fail('late answer offered'), message => assert.fail(message));
  await until(() => accepted && plugin.activeTasks.has(parent.path));
  plugin.activeTasks.get(parent.path).abort();
  resolveModel({ summary: '', detail: '', visualReferences: [], suggestions: [{ title: 'Late child', task: 'Explore this', contribution: '', parentTitle: '' }] });
  await job;
  assert.equal((await repo.readMap(mapPath)).nodes.length, 1);
  assert.equal(plugin.pendingSuggestions.has(parent.path), false);
  assert.equal(plugin.quickExpandPending.has(parent.path), false);
  assert.equal(plugin.activeTasks.has(parent.path), false);
  assert.deepEqual(recorded, []);
});
integrationTest('Map Stop during accepted decomposition treats provider AbortError and cancellation rejection as cancellation', async () => {
  for (const makeError of [
    () => { const error = new Error('aborted'); error.name = 'AbortError'; return error; },
    () => new Error('AI task cancelled')
  ]) {
    const { repo, app } = fixture(), parent = await topicNote(repo, 'Parent', 'model-a');
    const mapPath = 'Agent Workspace/Topics/map-a/Map.md', mapDoc = map([parent]); mapDoc.id = 'map-a';
    await app.vault.create(mapPath, core.serializeMap(mapDoc));
    let accepted = false, failed = [], providerSignal;
    const plugin = withExpansionCoordinator({ repo, settings: { ...DEFAULT_SETTINGS }, running: new Set(), abortChartJobs: () => {}, addChartsAfterWrite: () => {}, pendingSuggestions: new Map(), pendingResearchOptions: new Map(), rebuildDerivedData: async () => {}, mutate: async work => work(), recordFailure: (context, error) => { failed.push(`${context}: ${error.message}`); return error.message; },
      askModel: (_context, _model, _reasoning, signal, _exchange, onAccepted) => {
        providerSignal = signal;
        onAccepted?.(); accepted = true;
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(makeError()), { once: true }));
      } });
    const { VisualAgentMapView } = load('main.ts', { obsidian });
    const view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.contentEl = { querySelector: () => null }; view.render = () => {}; view.hydrate = async () => {}; view.focusNode = () => {};
    let failedCallback = '';
    const job = view.proposeChildren(parent, { researchMode: 'research', researchDepth: 'fast', visualMode: 'off', referenceGroups: [], shallowResearch: true }, '', () => assert.fail('cancelled answer offered'), message => { failedCallback = message; });
    await until(() => accepted && plugin.activeTasks.has(parent.path));
    assert.equal(plugin.activeTasks.get(parent.path).signal.aborted, false);
    plugin.activeTasks.get(parent.path).abort();
    await job;
    assert.equal(providerSignal.aborted, true);
    assert.equal((await repo.readMap(mapPath)).nodes.length, 1);
    assert.equal(plugin.pendingSuggestions.has(parent.path), false);
    assert.equal(failedCallback, '');
    assert.deepEqual(failed, []);
    assert.equal(plugin.activeTasks.has(parent.path), false);
    assert.equal(plugin.running.has(parent.path), false);
    assert.equal(plugin.quickExpandPending.has(parent.path), false);
  }
});
integrationTest('guided expansion lets a terminal render exception after Stop reach its caller', async () => {
  const { repo, app } = fixture(), parent = await topicNote(repo, 'Parent', 'model-a');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md', mapDoc = map([parent]); mapDoc.id = 'map-a';
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  let accepted = false, providerSignal, terminalRenderFailed = false;
  const plugin = withExpansionCoordinator({ repo, settings: { ...DEFAULT_SETTINGS }, running: new Set(), abortChartJobs: () => {}, addChartsAfterWrite: () => {}, pendingSuggestions: new Map(), pendingResearchOptions: new Map(), rebuildDerivedData: async () => {}, mutate: async work => work(), recordFailure: (_context, error) => error.message,
    askModel: (_context, _model, _reasoning, signal, _exchange, onAccepted) => {
      providerSignal = signal;
      onAccepted?.(); accepted = true;
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => { const error = new Error('cancelled'); error.name = 'AbortError'; reject(error); }, { once: true }));
    } });
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.contentEl = { querySelector: () => null }; view.hydrate = async () => {}; view.focusNode = () => {};
  view.render = () => { if (providerSignal?.aborted && !terminalRenderFailed) { terminalRenderFailed = true; throw new Error('terminal render failure'); } };
  let failure = '';
  const job = view.proposeChildren(parent, { researchMode: 'research', researchDepth: 'fast', visualMode: 'off', referenceGroups: [], shallowResearch: false }, '', () => assert.fail('cancelled answer offered'), message => { failure = message; });
  await until(() => accepted && plugin.activeTasks.has(parent.path));
  plugin.activeTasks.get(parent.path).abort();
  await assert.rejects(job, /terminal render failure/);
  assert.equal(terminalRenderFailed, true);
  assert.equal(failure, '', 'a cancellation is not reported as a failure');
  assert.equal(plugin.activeTasks.has(parent.path), false);
  assert.equal(plugin.running.has(parent.path), false);
});
integrationTest('reviewed subtopics are refused when their parent was removed while AI was running', async () => {
  const { repo, app } = fixture(), parent = await topicNote(repo, 'Parent', 'model-a');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md', mapDoc = map([parent]); mapDoc.id = 'map-a';
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  let resolveModel, tail = Promise.resolve();
  const plugin = withExpansionCoordinator({ repo, settings: { ...DEFAULT_SETTINGS }, running: new Set(), abortChartJobs: () => {}, addChartsAfterWrite: () => {}, pendingSuggestions: new Map(), pendingResearchOptions: new Map(), rebuildDerivedData: async () => {}, recordFailure: (_context, failure) => failure.message,
    askModel: () => new Promise(resolve => { resolveModel = resolve; }), mutate(work) { const job = tail.then(work); tail = job.catch(() => {}); return job; } });
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.contentEl = { querySelector: () => null }; view.render = () => {}; view.hydrate = async () => {}; view.focusNode = () => {};
  const options = { researchMode: 'local', researchDepth: 'fast', visualMode: 'off', referenceGroups: [], shallowResearch: false };
  let create;
  const job = view.proposeChildren(parent, options, '', (items, run) => { create = () => run(items); }, message => assert.fail(message));
  await new Promise(resolve => setTimeout(resolve, 0));
  await plugin.mutate(() => view.mapChange(map => { map.nodes = []; }));
  resolveModel({ summary: '', detail: '', visualReferences: [], suggestions: [{ title: 'Stale child', task: 'Explore', contribution: '', parentTitle: '' }] });
  await job;
  await assert.rejects(create(), /map or parent topic changed/);
  assert.equal((await repo.readMap(mapPath)).nodes.length, 0);
  assert.equal(plugin.quickExpandPending.size, 0);
});
integrationTest('pending proposals use this run\'s shallow research choice and serialize creation', async () => {
  const suggestions = [{ title: 'Existing', task: 'Research', contribution: '', parentTitle: '' }];
  let queued = 0, insideMutation = false, create, used;
  const plugin = withExpansionCoordinator({ repo: { readNote: async () => ({}) }, pendingSuggestions: new Map([['parent.md', suggestions]]), pendingResearchOptions: new Map(), mutate: async work => { queued++; insideMutation = true; try { return await work(); } finally { insideMutation = false; } } });
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app: {} }, plugin);
  view.render = () => {};
  let startedResearch;
  view.createChildBatch = async (_parent, _items, options) => { used = options; return [node('created')]; };
  view.startShallowResearch = async (_parent, children, options) => { assert.equal(insideMutation, false); startedResearch = { children, options, queued }; };
  const options = { researchMode: 'local', researchDepth: 'fast', visualMode: 'off', referenceGroups: [{ name: 'Reference map', documents: [{ path: 'map/topic.md', content: 'private source' }] }], shallowResearch: true };
  await view.proposeChildren({ id: 'parent', path: 'parent.md' }, options, '', (_items, confirm) => { create = confirm; }, message => assert.fail(message));
  const storedChoices = plugin.pendingResearchOptions.get('parent.md');
  assert.equal(storedChoices.researchMode, 'local'); assert.equal(storedChoices.researchDepth, 'fast'); assert.equal(storedChoices.visualMode, 'off');
  assert.deepEqual(storedChoices.referenceGroups, options.referenceGroups, 'the sources chosen in the dialog are kept for the children'); assert.equal(storedChoices.signal, undefined); assert.equal(storedChoices.onProgress, undefined);
  await create(suggestions);
  assert.equal(queued, 1); assert.equal(used.researchMode, 'local'); assert.equal(used.researchDepth, 'fast'); assert.equal(used.visualMode, 'off'); assert.deepEqual(used.referenceGroups, options.referenceGroups); assert.notEqual(used, options); assert.equal(plugin.pendingSuggestions.has('parent.md'), false);
  assert.equal(startedResearch.queued, 1); assert.equal(startedResearch.children.length, 1); assert.deepEqual(startedResearch.options.referenceGroups, options.referenceGroups);
  plugin.pendingSuggestions.set('parent.md', suggestions); plugin.pendingResearchOptions.set('parent.md', options);
  await view.proposeChildren({ id: 'parent', path: 'parent.md' }, { ...options, shallowResearch: false }, '', () => {}, message => assert.fail(message));
  assert.equal(plugin.pendingResearchOptions.has('parent.md'), false);
});
integrationTest('two views cannot create the same pending proposals twice', async () => {
  const suggestions = [{ title: 'Child', task: 'Research', contribution: '', parentTitle: '' }];
  let tail = Promise.resolve(), created = 0;
  const plugin = withExpansionCoordinator({ repo: { readNote: async () => ({}) }, pendingSuggestions: new Map([['parent.md', suggestions]]), pendingResearchOptions: new Map(), mutate(work) { const job = tail.then(work); tail = job.catch(() => {}); return job; } });
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const first = new VisualAgentMapView({ app: {} }, plugin), second = new VisualAgentMapView({ app: {} }, plugin);
  for (const view of [first, second]) { view.render = () => {}; view.createChildBatch = async () => { created++; return []; }; }
  let acceptFirst, acceptSecond;
  await first.proposeChildren({ id: 'parent', path: 'parent.md' }, undefined, '', (_items, accept) => { acceptFirst = accept; });
  await second.proposeChildren({ id: 'parent', path: 'parent.md' }, undefined, '', (_items, accept) => { acceptSecond = accept; });
  const outcomes = await Promise.allSettled([acceptFirst(suggestions), acceptSecond(suggestions)]);
  assert.equal(created, 1);
  assert.deepEqual(outcomes.map(outcome => outcome.status), ['fulfilled', 'rejected']);
  assert.match(outcomes[1].reason.message, /Expansion suggestions changed/);
});
integrationTest('partial child creation invalidates the proposal so retry cannot duplicate nodes', async () => {
  const { repo, app } = fixture(), parent = await topicNote(repo, 'Parent', 'model-a');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md';
  const mapDoc = { id: 'map-a', title: 'map-a', version: 1, nodes: [parent], viewport: { x: 0, y: 0, zoom: 1 } };
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const suggestions = [{ title: 'First', task: 'A', contribution: '', parentTitle: '' }, { title: 'Second', task: 'B', contribution: '', parentTitle: '' }];
  let queued = 0, changes = 0, create, persisted = [];
  const pendingSuggestions = new Map([[parent.path, suggestions]]);
  pendingSuggestions.flush = async () => { persisted = JSON.parse(JSON.stringify([...pendingSuggestions])); };
  const plugin = withExpansionCoordinator({ repo, settings: { ...DEFAULT_SETTINGS }, pendingSuggestions, pendingResearchOptions: new Map(), rebuildDerivedData: async () => {}, mutate: async work => { queued++; return work(); } });
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.contentEl = { querySelector: () => null }; view.render = () => {}; view.hydrate = async () => {}; view.focusNode = () => {};
  view.noteChange = async () => { if (++changes === 2) throw new Error('injected note write failure'); };
  await view.proposeChildren(parent, undefined, '', (_items, confirm) => { create = confirm; }, message => assert.fail(message));
  await assert.rejects(create(suggestions), /Some subtopics were created/);
  assert.equal(queued, 1); assert.equal(plugin.pendingSuggestions.has(parent.path), false);
  assert.deepEqual(persisted, []);
  assert.equal((await repo.readMap(mapPath)).nodes.length, 3);
});
integrationTest('synthesis directions and draft are separate steps; only confirmed draft updates the parent', async () => {
  const { repo, app } = fixture(), parent = await topicNote(repo, 'Parent', 'model-a');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md';
  const mapDoc = { id: 'map-a', title: 'map-a', version: 1, nodes: [parent], viewport: { x: 0, y: 0, zoom: 1 } };
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const child = await repo.createNote('Child', 'model-a', mapDoc, mapPath, 'workspace'); child.parentId = parent.id; mapDoc.nodes.push(child); await repo.saveMap(mapPath, mapDoc);
  await repo.updateNote(parent.path, { rules: 'Legacy sentinel' });
  const contexts = [];
  const plugin = { repo, settings: { ...DEFAULT_SETTINGS }, running: new Set(), abortChartJobs: () => {}, addChartsAfterWrite: () => {}, mutate: async work => work(), askModel: async context => { contexts.push(context); return contexts.length === 1 ? { summary: '', detail: '', visualReferences: [], suggestions: [{ title: 'Common ground', task: 'Find shared constraints', contribution: 'A shared view', parentTitle: '' }] } : { summary: 'Draft summary', detail: 'Draft detail', visualReferences: [], suggestions: [] }; } };
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.render = () => {}; view.hydrate = async () => {}; view.ancestorContext = async () => '';
  let choose, save;
  const options = { requirements: 'Only compare cost', researchMode: 'local', researchDepth: 'normal', visualMode: 'off', referenceGroups: [{ id: 'picked', name: 'Picked', location: '/refs', documents: [{ path: '/refs/selected.md', content: 'Selected note content', external: true }] }] };
  choose = direction => view.integrateChildren(parent, options, direction, (_result, commit) => { save = commit; }, message => assert.fail(message));
  await view.proposeIntegrationDirections(parent, options, items => { assert.equal(items[0].title, 'Common ground'); }, message => assert.fail(message));
  assert.equal(contexts.length, 1); assert.equal(contexts[0].referenceGroups.flatMap(group => group.documents).some(document => document.path === '/refs/selected.md'), true); assert.notEqual((await repo.readNote(parent.path)).summary, 'Draft summary');
  await choose('Find shared constraints');
  assert.equal(contexts[1].task, 'Find shared constraints\n\nOnly compare cost');
  for (const context of contexts) { assert.equal(context.rules, ''); assert.match(context.task, /Only compare cost/); assert.ok(context.referenceGroups.flatMap(group => group.documents).some(document => document.path === '/refs/selected.md')); assert.doesNotMatch(JSON.stringify(context), /Legacy sentinel/); } assert.notEqual((await repo.readNote(parent.path)).summary, 'Draft summary');
  await save('Edited summary', 'Edited detail');
  const saved = await repo.readNote(parent.path);
  assert.equal(saved.rules, 'Legacy sentinel');
  assert.equal(saved.summary, 'Edited summary'); assert.match(saved.detail, /Edited detail/);
});
integrationTest('synthesis content is explicit for one, three and four children, with full default and no descendants', async () => {
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const { referenceBatches } = load('ai/reference-materials.ts', { obsidian });
  for (const count of [1, 3, 4]) for (const choice of [undefined, 'full', 'summary']) {
    const { repo, app, contents } = fixture(), parent = await topicNote(repo, 'Parent', 'model-a');
    await repo.updateNote(parent.path, { rules: 'LEGACY_PARENT_RULES' });
    const children = [];
    for (let index = 0; index < count; index++) {
      const child = await topicNote(repo, `Child ${index}`, 'model-a'); child.parentId = parent.id;
      await repo.updateNote(child.path, { summary: `Summary ${index}`, detail: `DETAIL_START_${index}\n${'body '.repeat(3500)}\nBODY_ONLY_CONDITION_${index}\n${'rest '.repeat(3500)}\nDETAIL_END_${index}`, newFindings: `Finding ${index}`, rules: `LEGACY_CHILD_${index}` });
      children.push(child);
    }
    const grandchild = await topicNote(repo, 'Grandchild', 'model-a'); grandchild.parentId = children[0].id;
    await repo.updateNote(grandchild.path, { detail: 'EXCLUDED_GRANDCHILD' });
    const unrelated = await topicNote(repo, 'Unrelated', 'model-a');
    await repo.updateNote(unrelated.path, { detail: 'EXCLUDED_UNRELATED' });
    const selected = { id: 'extra', name: 'Extra', location: '/refs', documents: [{ path: '/refs/extra.md', content: 'EXTRA_FULL_BODY', external: true }] };
    const before = new Map(contents);
    const contexts = [];
    const plugin = { repo, settings: { ...DEFAULT_SETTINGS }, running: new Set(), abortChartJobs: () => {}, addChartsAfterWrite: () => {}, mutate: async work => work(), recordFailure: (_label, error) => error.message,
      askModel: async context => { contexts.push(context); return contexts.length === 1 ? { suggestions: [{ title: 'Direction', task: 'Compare evidence', contribution: '' }] } : { summary: 'Draft', detail: 'Draft', visualReferences: [], suggestions: [] }; } };
    const view = new VisualAgentMapView({ app }, plugin); view.map = map([parent, ...children, grandchild, unrelated]); view.render = () => {}; view.hydrate = async () => {}; view.ancestorContext = async () => '';
    let draft, save;
    const options = { researchMode: 'local', researchDepth: 'normal', visualMode: 'off', requirements: 'Respect the budget', referenceGroups: [selected], ...(choice ? { synthesisContent: choice } : {}) };
    draft = direction => view.integrateChildren(parent, options, direction, (_result, commit) => { save = commit; }, message => assert.fail(message));
    await view.proposeIntegrationDirections(parent, options, () => {}, message => assert.fail(message));
    await draft('Compare evidence');
    assert.equal(typeof save, 'function'); assert.equal(contexts.length, 2);
    for (const context of contexts) {
      assert.equal(context.rules, ''); assert.match(context.task, /Respect the budget/);
      const docs = context.referenceGroups.flatMap(group => group.documents);
      const automatic = docs.filter(doc => !doc.external);
      assert.deepEqual(Array.from(docs, doc => doc.path), ['/refs/extra.md', ...children.map(child => child.path)]);
      assert.equal(docs[0].content, 'EXTRA_FULL_BODY');
      const batches = referenceBatches(context.referenceGroups).join('\n');
      assert.doesNotMatch(batches, /EXCLUDED_GRANDCHILD|EXCLUDED_UNRELATED|LEGACY_CHILD/);
      for (let index = 0; index < count; index++) {
        assert.ok(automatic[index].content.includes(`Summary ${index}`)); assert.ok(automatic[index].content.includes(`Finding ${index}`));
        if (choice === 'summary') assert.ok(!automatic[index].content.includes(`BODY_ONLY_CONDITION_${index}`));
        else {
          const detail = (await repo.readNote(children[index].path)).detail;
          assert.ok(automatic[index].content.includes(detail), `full source lost Detail for ${count}/${choice}/${index}`);
          for (const marker of [`DETAIL_START_${index}`, `BODY_ONLY_CONDITION_${index}`, `DETAIL_END_${index}`]) assert.ok(batches.includes(marker));
          assert.ok(batches.includes(children[index].path));
        }
      }
    }
    assert.doesNotMatch(JSON.stringify(contexts), /LEGACY_PARENT_RULES/);
    assert.equal((await repo.readNote(parent.path)).rules, 'LEGACY_PARENT_RULES');
    for (const child of [...children, grandchild, unrelated]) assert.equal(contents.get(child.path), before.get(child.path));
    assert.notEqual((await repo.readNote(parent.path)).summary, 'Draft');
  }
});
integrationTest('multi-select synthesis honors content choice and leaves unselected topics and extra Markdown unchanged', async () => {
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  for (const choice of [undefined, 'full', 'summary']) {
    const { repo, app, contents } = fixture(), a = await topicNote(repo, 'Selected A', 'model-a'), b = await topicNote(repo, 'Selected B', 'model-a'), excluded = await topicNote(repo, 'Not selected', 'model-a');
    await repo.updateNote(a.path, { summary: 'A summary', detail: 'A_BODY_ONLY', rules: 'OLD_RULE_A' });
    await repo.updateNote(b.path, { summary: 'B summary', detail: 'B_BODY_ONLY' });
    const before = new Map(contents);
    const extra = { id: 'extra', name: 'Extra', location: '/refs', documents: [{ path: '/refs/source.md', content: 'EXTRA_BODY_UNCHANGED', external: true }] };
    const plugin = { repo, settings: { ...DEFAULT_SETTINGS }, askModel: async context => {
      const docs = context.referenceGroups.flatMap(group => group.documents);
      const automatic = docs.filter(doc => !doc.external);
      assert.deepEqual(Array.from(docs, doc => doc.path), ['/refs/source.md', a.path, b.path]);
      assert.equal(automatic[0].content.includes('A_BODY_ONLY'), choice !== 'summary');
      assert.equal(automatic[1].content.includes('B_BODY_ONLY'), choice !== 'summary');
      assert.equal(docs[0].content, 'EXTRA_BODY_UNCHANGED');
      assert.match(context.task, /This run only/); assert.equal(context.rules, '');
      throw new Error('Stop before any write');
    } };
    const view = new VisualAgentMapView({ app }, plugin); view.map = map([a, b, excluded]); view.render = () => {};
    await assert.rejects(view.createIntegratedNode('Draft', [a, b], 'Compare', '', { synthesisContent: choice, requirements: 'This run only', referenceGroups: [extra] }), /Stop before any write/);
    assert.deepEqual(new Map(contents), before);
  }
});
integrationTest('explicit full Markdown wins over overlapping automatic summaries in both synthesis paths', async () => {
  const { repo, app } = fixture(), parent = await topicNote(repo, 'Parent'), a = await topicNote(repo, 'A'), b = await topicNote(repo, 'B');
  a.parentId = parent.id; b.parentId = parent.id;
  await repo.updateNote(a.path, { summary: 'A summary', detail: 'FULL_OVERLAP_CONDITION' });
  const { referenceBatches } = load('ai/reference-materials.ts', { obsidian });
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const full = await app.vault.read(repo.file(a.path));
  const extra = { id: 'shared-map', name: 'Other map', location: 'Other/Map.md', documents: [{ path: a.path, content: full }] };
  let calls = 0;
  const plugin = { repo, settings: { ...DEFAULT_SETTINGS }, running: new Set(), abortChartJobs: () => {}, addChartsAfterWrite: () => {}, mutate: async work => work(), recordFailure: (_label, error) => error.message, askModel: async context => {
    const batches = referenceBatches(context.referenceGroups).join('\n');
    assert.match(batches, /FULL_OVERLAP_CONDITION/);
    assert.equal(batches.split('FULL_OVERLAP_CONDITION').length - 1, 1);
    calls++;
    return { summary: 'Draft', detail: 'Draft', visualReferences: [], suggestions: [{ title: 'Angle', task: 'Compare', contribution: '' }] };
  } };
  const view = new VisualAgentMapView({ app }, plugin); view.map = map([parent, a, b]); view.render = () => {}; view.hydrate = async () => {}; view.ancestorContext = async () => '';
  const options = { synthesisContent: 'summary', referenceGroups: [extra], researchMode: 'local', researchDepth: 'normal', visualMode: 'off' };
  let draft;
  draft = direction => view.integrateChildren(parent, options, direction, () => {}, message => assert.fail(message));
  await view.proposeIntegrationDirections(parent, options, () => {}, message => assert.fail(message));
  await draft('Compare');
  view.saveIntegratedNode = async () => {};
  await view.createIntegratedNode('Combined', [a, b], 'Compare', '', options);
  assert.equal(calls, 3);
  assert.equal(await app.vault.read(repo.file(a.path)), full);
});
integrationTest('synthesis can use selected notes when a topic has no children', async () => {
  const { repo, app } = fixture(), parent = await topicNote(repo, 'Parent', 'model-a');
  const contexts = [];
  const plugin = { repo, settings: { ...DEFAULT_SETTINGS }, running: new Set(), abortChartJobs: () => {}, addChartsAfterWrite: () => {}, mutate: async work => work(), recordFailure: (_context, error) => error.message, askModel: async context => { contexts.push(context); return contexts.length === 1 ? { summary: '', detail: '', suggestions: [{ title: 'Shared view', task: 'Combine notes', contribution: '' }] } : { summary: 'Combined', detail: 'Combined detail', suggestions: [] }; } };
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app }, plugin); view.map = map([parent]); view.render = () => {}; view.hydrate = async () => {}; view.ancestorContext = async () => '';
  const empty = { researchMode: 'local', researchDepth: 'normal', visualMode: 'off', referenceGroups: [] };
  let failure = '';
  await view.proposeIntegrationDirections(parent, empty, () => assert.fail('missing sources'), message => { failure = message; });
  assert.match(failure, /Choose another note source first/);
  assert.equal(contexts.length, 0);
  await view.proposeIntegrationDirections(parent, { ...empty, referenceGroups: [{ id: 'empty', name: 'Empty', location: '', documents: [] }] }, () => assert.fail('empty source'), message => { failure = message; });
  assert.match(failure, /Choose another note source first/);
  assert.equal(contexts.length, 0);
  let draft, save;
  const selectedGroup = { id: 'selected', name: 'Selected', location: '/refs', documents: [{ path: '/refs/selected.md', content: 'Selected note content', external: true }] };
  const groupOptions = { ...empty, referenceGroups: [selectedGroup] };
  draft = direction => view.integrateChildren(parent, groupOptions, direction, (_result, commit) => { save = commit; }, message => assert.fail(message));
  await view.proposeIntegrationDirections(parent, groupOptions, () => {}, message => assert.fail(message));
  assert.ok(contexts[0].referenceGroups.flatMap(group => group.documents).some(document => document.path === '/refs/selected.md'));
  await draft('Combine notes');
  assert.ok(contexts[1].referenceGroups.flatMap(group => group.documents).some(document => document.path === '/refs/selected.md'));
  await save('Combined', 'Combined detail');
  assert.equal((await repo.readNote(parent.path)).summary, 'Combined');
});
integrationTest('decomposition accepts 1 to 7 proposals and does not write nodes before confirmation', async () => {
  const { repo, app } = fixture(), parent = await topicNote(repo, 'Parent', 'model-a');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md';
  const mapDoc = { id: 'map-a', title: 'map-a', version: 1, nodes: [parent], viewport: { x: 0, y: 0, zoom: 1 } };
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const plugin = withExpansionCoordinator({ repo, settings: { ...DEFAULT_SETTINGS }, running: new Set(), abortChartJobs: () => {}, addChartsAfterWrite: () => {}, pendingSuggestions: new Map(), askModel: async () => ({ summary: '', detail: '', visualReferences: [], suggestions: [{ title: 'Only one', task: '', contribution: '' }, { title: 'Only two', task: '', contribution: '' }] }) });
  const view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.render = () => {}; view.hydrate = async () => {}; view.openChildSuggestions = () => {};
  await view.proposeChildren(parent);
  assert.equal(plugin.pendingSuggestions.get(parent.path).length, 2);
  plugin.pendingSuggestions.clear();
  assert.equal((await repo.readMap(mapPath)).nodes.length, 1);
  plugin.askModel = async () => ({ summary: '', detail: '', visualReferences: [], suggestions: [{ title: 'Only one', task: '', contribution: '' }] });
  await view.proposeChildren(parent);
  assert.equal(plugin.pendingSuggestions.get(parent.path).length, 1);
  plugin.pendingSuggestions.clear();
  plugin.askModel = async () => ({ summary: '', detail: '', visualReferences: [], suggestions: Array.from({ length: 8 }, (_, index) => ({ title: `Suggestion ${index + 1}`, task: '', contribution: '' })) });
  await view.proposeChildren(parent);
  assert.equal(plugin.pendingSuggestions.get(parent.path).length, 7);
  assert.equal((await repo.readMap(mapPath)).nodes.length, 1);
});
integrationTest('English expansion uses English-generated task instructions', async () => {
  const { repo, app } = fixture('en'), parent = await topicNote(repo, 'Parent', 'model-a');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md';
  const mapDoc = { id: 'map-a', title: 'Map', version: 1, nodes: [parent], viewport: { x: 0, y: 0, zoom: 1 } };
  await app.vault.create(mapPath, core.serializeMap(mapDoc, 'en'));
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  let task = '';
  const plugin = withExpansionCoordinator({ recordFailure: (_label, error) => String(error), repo, settings: { ...DEFAULT_SETTINGS, language: 'en' }, running: new Set(), abortChartJobs: () => {}, addChartsAfterWrite: () => {}, pendingSuggestions: new Map(), askModel: async context => { task = context.task; return { summary: '', detail: '', visualReferences: [], suggestions: Array.from({ length: 3 }, (_, index) => ({ title: `Idea ${index}`, task: 'Research', contribution: '' })) }; } });
  const view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.render = () => {}; view.hydrate = async () => {}; view.openChildSuggestions = () => {}; view.ancestorContext = async () => '';
  await view.proposeChildren(parent);
  assert.match(task, /Existing direct subtopics/);
  assert.doesNotMatch(task, /[一-龥]/);
});
integrationTest('decomposition receives existing child topics to avoid duplicate proposals', async () => {
  const { repo, app } = fixture(), parent = await topicNote(repo, 'Travel', 'model-a');
  await repo.updateNote(parent.path, { researchMode: 'local' });
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md';
  const mapDoc = { id: 'map-a', title: 'map-a', version: 1, nodes: [parent], viewport: { x: 0, y: 0, zoom: 1 } };
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const child = await repo.createNote('交通', 'model-a', mapDoc, mapPath, 'workspace');
  child.parentId = parent.id; mapDoc.nodes.push(child); await repo.saveMap(mapPath, mapDoc);
  let captured;
  const plugin = withExpansionCoordinator({ repo, settings: { ...DEFAULT_SETTINGS }, running: new Set(), abortChartJobs: () => {}, addChartsAfterWrite: () => {}, pendingSuggestions: new Map(), askModel: async context => { captured = context; return { summary: 'No split', detail: '', visualReferences: [], suggestions: [] }; } });
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.notes.set(child.id, await repo.readNote(child.path)); view.render = () => {}; view.hydrate = async () => {};
  await view.proposeChildren(parent);
  assert.match(captured.task, /Existing direct subtopics/);
  assert.match(captured.task, /交通/);
  assert.match(captured.task, /do not pad the count/);
  assert.equal(captured.researchMode, 'research');
  assert.equal(captured.referenceGroups, undefined);
  assert.equal(plugin.pendingSuggestions.size, 0);
});
integrationTest('guided proposals support zero, one, two and seven, saving selected edits and rejecting a switched map', async () => {
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  for (const count of [0, 1, 2, 7]) {
    const { repo, app } = fixture('en');
    const path = await repo.createMap('Guided'), doc = await repo.readMap(path);
    const parent = await repo.createNote('Parent', 'model-a', doc, path, 'workspace'); doc.nodes.push(parent); await repo.saveMap(path, doc);
    const plugin = withExpansionCoordinator({ repo, settings: { ...DEFAULT_SETTINGS }, running: new Set(), abortChartJobs: () => {}, addChartsAfterWrite: () => {}, pendingSuggestions: new Map(), pendingResearchOptions: new Map(), mutate: async work => work(), rebuildDerivedData: async () => {}, askModel: async () => ({ summary: '', detail: 'No useful split', suggestions: Array.from({length: count}, (_, i) => ({title: 'Child ' + i, task: 'Explore', contribution: ''})) }) });
    const view = new VisualAgentMapView({app}, plugin); Object.assign(view, {path, map: doc, contentEl: {querySelector: () => null}, render() {}, async hydrate() {}, focusNode() {}});
    let offered, confirm, failure, renderedPending;
    view.render = () => { renderedPending = plugin.pendingSuggestions.size; };
    await view.proposeChildren(parent, {}, '', (items, create) => { offered = items; confirm = create; }, message => { failure = message; });
    assert.equal((await repo.readMap(path)).nodes.length, 1);
    if (!count) { assert.equal(failure, 'No useful split'); continue; }
    assert.equal(offered.length, count);
    view.map = { ...doc, id: 'other', nodes: [] }; view.path = 'Other/Map.md';
    await assert.rejects(confirm(offered), /changed/);
    assert.equal((await repo.readMap(path)).nodes.length, 1);
    view.map = doc; view.path = path;
    await confirm([{...offered[0], title: 'Edited choice'}]);
    const reopened = await repo.readMap(path); assert.equal(reopened.nodes.length, 2);
    assert.equal((await repo.readNote(reopened.nodes[1].path)).title, 'Edited choice');
    assert.equal(plugin.pendingSuggestions.size, 0); assert.equal(renderedPending, 0);
  }
});
async function backgroundSynthesisFixture(askModel) {
  const { repo, app } = fixture(), parent = await topicNote(repo, 'Parent', 'model-a');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md';
  const mapDoc = { id: 'map-a', title: 'map-a', version: 1, nodes: [parent], viewport: { x: 0, y: 0, zoom: 1 } };
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const child = await repo.createNote('Child', 'model-a', mapDoc, mapPath, 'workspace'); child.parentId = parent.id; mapDoc.nodes.push(child); await repo.saveMap(mapPath, mapDoc);
  await repo.updateNote(parent.path, { status: 'completed', summary: 'Existing conclusion', detail: 'Existing knowledge' });
  const contexts = [];
  const plugin = { repo, settings: { ...DEFAULT_SETTINGS }, running: new Set(), abortChartJobs: () => {}, addChartsAfterWrite: () => {}, activeTasks: new Map(), mutate: async work => work(), recordFailure: (_context, error) => error.message, askModel: (context, model, reasoning, signal, onExchange, onAccepted) => { contexts.push(context); context.onWorkingFindingsSent?.(context.workingFindings ?? ''); return askModel(contexts.length, signal, onAccepted); } };
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.render = () => {}; view.hydrate = async () => {}; view.ancestorContext = async () => '';
  const options = () => ({ researchMode: 'local', researchDepth: 'normal', visualMode: 'off', referenceGroups: [] });
  const directionsResult = { summary: '', detail: '', visualReferences: [], suggestions: [{ title: 'Common ground', task: 'Find shared constraints', contribution: 'A shared view', parentTitle: '' }] };
  const draftResult = { summary: 'Draft summary', detail: 'Draft detail', visualReferences: [], suggestions: [] };
  return { repo, parent, plugin, view, contexts, options, directionsResult, draftResult };
}
integrationTest('closing the modal after dispatch does not abort background synthesis; directions then draft then save', async () => {
  const gate = deferred(); let seenSignal;
  const f = await backgroundSynthesisFixture(async (call, signal, onAccepted) => { seenSignal = signal; onAccepted(); await gate.promise; return call === 1 ? f.directionsResult : f.draftResult; });
  const modalController = new AbortController(); let acceptedCalls = 0, failures = [];
  const started = f.view.startSynthesis(f.parent, { ...f.options(), signal: modalController.signal }, null, message => failures.push(message), () => { acceptedCalls++; modalController.abort(); });
  await until(() => acceptedCalls === 1);
  assert.equal(f.view.synthesisTasks.get(f.parent.path).state, 'running'); assert.equal(f.plugin.activeTasks.has(f.parent.path), true);
  assert.equal(seenSignal.aborted, false, 'closing the modal must not abort the background task');
  gate.resolve(); await started;
  const task = f.view.synthesisTasks.get(f.parent.path);
  assert.equal(task.state, 'directions'); assert.equal(task.directions[0].title, 'Common ground'); assert.equal(f.plugin.activeTasks.size, 0); assert.equal(f.plugin.running.size, 0); assert.deepEqual(failures, []);
  assert.equal((await f.repo.readNote(f.parent.path)).summary, 'Existing conclusion');
  await f.view.startSynthesis(f.parent, f.options(), 'Find shared constraints', message => failures.push(message), () => {});
  // No draft review step: the AI result is written as soon as it passes the fences.
  assert.equal(f.contexts[1].task, 'Find shared constraints'); assert.equal(f.view.synthesisTasks.has(f.parent.path), false);
  const saved = await f.repo.readNote(f.parent.path);
  assert.equal(saved.summary, 'Draft summary'); assert.match(saved.detail, /Draft detail/); assert.equal(saved.status, 'completed'); assert.deepEqual(failures, []);
});
integrationTest('direct synthesis write: Undo restores the parent note verbatim, Redo rewrites it, and a later edit blocks Undo', async () => {
  const f = await backgroundSynthesisFixture(async call => call === 1 ? f.directionsResult : f.draftResult);
  const before = await f.repo.readNote(f.parent.path);
  await f.view.startSynthesis(f.parent, f.options(), null, message => assert.fail(message), () => {});
  await f.view.startSynthesis(f.parent, f.options(), 'Find shared constraints', message => assert.fail(message), () => {});
  assert.equal(f.view.synthesisTasks.has(f.parent.path), false);
  assert.equal((await f.repo.readNote(f.parent.path)).summary, 'Draft summary');
  await f.view.history.undo().undo();
  const restored = await f.repo.readNote(f.parent.path);
  assert.deepEqual(plain(restored), plain(before));
  await f.view.history.redo().redo();
  assert.equal((await f.repo.readNote(f.parent.path)).summary, 'Draft summary');
  await f.repo.updateNote(f.parent.path, { summary: 'Edited after the write' });
  await assert.rejects(f.view.history.undo().undo(), /the synthesis draft was not saved/i);
  assert.equal((await f.repo.readNote(f.parent.path)).summary, 'Edited after the write');
});
integrationTest('direct synthesis write: Undo is verbatim when the parent already carried format issues', async () => {
  const f = await backgroundSynthesisFixture(async call => call === 1 ? f.directionsResult : { ...f.draftResult, formatIssues: [{ section: 'Examples', mode: 'exact', n: 3, actual: 1 }] });
  await f.repo.updateNote(f.parent.path, { detailFormatIssues: ['Old: needs exactly 2, has 0'] });
  const before = await f.repo.readNote(f.parent.path);
  assert.deepEqual(plain(before.detailFormatIssues), ['Old: needs exactly 2, has 0']);
  await f.view.startSynthesis(f.parent, f.options(), null, message => assert.fail(message), () => {});
  await f.view.startSynthesis(f.parent, f.options(), 'Find shared constraints', message => assert.fail(message), () => {});
  assert.notDeepEqual(plain((await f.repo.readNote(f.parent.path)).detailFormatIssues), plain(before.detailFormatIssues));
  await f.view.history.undo().undo();
  assert.deepEqual(plain(await f.repo.readNote(f.parent.path)), plain(before));
});
integrationTest('a note without title/summary keys is normalized when synthesis starts (status write), not by the content write; Undo restores every recorded field', async () => {
  const gate = deferred();
  const f = await backgroundSynthesisFixture(async (call, _signal, onAccepted) => { onAccepted(); if (call === 2) await gate.promise; return call === 1 ? f.directionsResult : f.draftResult; });
  const vault = f.repo.app.vault, file = f.repo.file(f.parent.path);
  // A note whose frontmatter has no title or summary key (hand-made or imported).
  await vault.process(file, text => text.replace(/^title: .*\n/m, '').replace(/^summary: .*\n/m, ''));
  const head = text => text.split('\n---')[0];
  assert.doesNotMatch(head(await vault.read(file)), /^title:|^summary:/m);
  await f.view.startSynthesis(f.parent, f.options(), null, message => assert.fail(message), () => {});
  assert.doesNotMatch(head(await vault.read(file)), /^title:/m, 'the directions step does not write the note');
  let accepted = 0;
  const drafting = f.view.startSynthesis(f.parent, f.options(), 'Find shared constraints', message => assert.fail(message), () => accepted++);
  await until(() => accepted === 1);
  // Evidence: the normalization comes from the "running" status write at the start of the draft step, before any content is written.
  assert.match(head(await vault.read(file)), /^title:/m);
  const before = await f.repo.readNote(f.parent.path);
  gate.resolve(); await drafting;
  assert.equal((await f.repo.readNote(f.parent.path)).summary, 'Draft summary');
  await f.view.history.undo().undo();
  const restored = await f.repo.readNote(f.parent.path);
  assert.deepEqual(plain({ ...restored, status: 0 }), plain({ ...before, status: 0 }));
  assert.equal(restored.status, 'completed');
});
integrationTest('multi-select synthesis: Stop while the sources are re-read after the AI result writes nothing', async () => {
  const { repo, app } = fixture(), a = await topicNote(repo, 'Selected A', 'model-a'), b = await topicNote(repo, 'Selected B', 'model-a');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md';
  const mapDoc = { id: 'map-a', title: 'map-a', version: 1, nodes: [a, b], viewport: { x: 0, y: 0, zoom: 1 } };
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const plugin = { repo, settings: { ...DEFAULT_SETTINGS }, running: new Set(), abortChartJobs: () => {}, addChartsAfterWrite: () => {}, mutate: async work => work(), recordFailure: (_l, error) => error.message, rebuildDerivedData: async () => {}, askModel: async () => ({ summary: 'S', detail: 'D', visualReferences: [], suggestions: [] }) };
  const view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.render = () => {}; view.hydrate = async () => {}; view.focusNode = () => {};
  const controller = new AbortController();
  const original = view.topicReferenceGroup.bind(view); let reads = 0;
  view.topicReferenceGroup = async (...args) => { const group = await original(...args); if (++reads === 2) controller.abort(); return group; };
  await view.createIntegratedNode('Combined', [a, b], 'Compare', '', { researchMode: 'local', researchDepth: 'normal', visualMode: 'off', referenceGroups: [] }, { controller });
  assert.equal(reads, 2);
  assert.equal((await repo.readMap(mapPath)).nodes.length, 2, 'no topic was created');
  assert.equal(view.history.undoEntry, undefined);
  assert.equal(view.integrationTask.state, 'cancelled');
});
integrationTest('Stop on the node cancels background synthesis and preserves the topic', async () => {
  const f = await backgroundSynthesisFixture((_call, signal, onAccepted) => new Promise((_resolve, reject) => { onAccepted(); signal.addEventListener('abort', () => { const error = new Error('cancelled'); error.name = 'AbortError'; reject(error); }, { once: true }); }));
  let accepted = 0; const failures = [];
  const started = f.view.startSynthesis(f.parent, f.options(), null, message => failures.push(message), () => accepted++);
  await until(() => accepted === 1);
  f.view.synthesisTasks.get(f.parent.path).controller.abort(); await started;
  const task = f.view.synthesisTasks.get(f.parent.path);
  assert.equal(task.state, 'cancelled'); assert.equal(f.plugin.activeTasks.size, 0); assert.equal(f.plugin.running.size, 0);
  assert.match(failures[0], /stopped|preserved/i);
  const after = await f.repo.readNote(f.parent.path); assert.equal(after.status, 'completed'); assert.equal(after.summary, 'Existing conclusion');
});
integrationTest('a second synthesis start on a busy topic is refused without a second AI call', async () => {
  const gate = deferred();
  const f = await backgroundSynthesisFixture(async (call, _signal, onAccepted) => { onAccepted(); await gate.promise; return call === 1 ? f.directionsResult : f.draftResult; });
  let accepted = 0; const failures = [];
  const first = f.view.startSynthesis(f.parent, f.options(), null, message => failures.push(message), () => accepted++);
  await until(() => accepted === 1);
  await f.view.startSynthesis(f.parent, f.options(), null, message => failures.push(message), () => assert.fail('second start must not be accepted'));
  assert.equal(failures.length, 1); assert.equal(f.contexts.length, 1);
  gate.resolve(); await first;
  assert.equal(f.view.synthesisTasks.get(f.parent.path).state, 'directions');
  await f.view.startSynthesis(f.parent, f.options(), null, message => failures.push(message), () => assert.fail('pending directions must be handled first'));
  assert.equal(failures.length, 2); assert.equal(f.contexts.length, 1);
});
integrationTest('a parent topic edited while the draft AI call is pending refuses the save and keeps the content', async () => {
  const gate = deferred();
  const f = await backgroundSynthesisFixture(async (call, _signal, onAccepted) => { onAccepted(); if (call === 2) await gate.promise; return call === 1 ? f.directionsResult : f.draftResult; });
  await f.view.startSynthesis(f.parent, f.options(), null, message => assert.fail(message), () => {});
  let accepted = 0;
  const drafting = f.view.startSynthesis(f.parent, f.options(), 'Find shared constraints', () => {}, () => accepted++);
  await until(() => accepted === 1);
  await f.repo.updateNote(f.parent.path, { summary: 'Edited while drafting' });
  gate.resolve(); await drafting;
  const task = f.view.synthesisTasks.get(f.parent.path); assert.equal(task.state, 'failed'); assert.match(task.progress, /the synthesis draft was not saved/i);
  assert.equal(f.view.history.undoEntry, undefined, 'a refused write records no history step');
  const after = await f.repo.readNote(f.parent.path); assert.equal(after.summary, 'Edited while drafting'); assert.equal(after.detail, 'Existing knowledge');
});
integrationTest('aborting before dispatch acceptance leaves a cancelled synthesis on the node and no running state', async () => {
  const f = await backgroundSynthesisFixture((_call, signal) => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => { const error = new Error('cancelled'); error.name = 'AbortError'; reject(error); }, { once: true }); }));
  const modalController = new AbortController(); const failures = [];
  const started = f.view.startSynthesis(f.parent, { ...f.options(), signal: modalController.signal }, null, message => failures.push(message), () => assert.fail('must not be accepted'));
  await until(() => f.contexts.length === 1);
  modalController.abort(); await started;
  assert.equal(f.view.synthesisTasks.get(f.parent.path).state, 'cancelled'); assert.equal(f.plugin.activeTasks.size, 0); assert.equal(f.plugin.running.size, 0); assert.equal(failures.length, 1);
  assert.equal((await f.repo.readNote(f.parent.path)).status, 'completed');
});

integrationTest('a provider failure before acceptance keeps a failed synthesis with its message on the node', async () => {
  const f = await backgroundSynthesisFixture(async () => { throw new Error('Codex is not signed in'); });
  const failures = [];
  await f.view.startSynthesis(f.parent, f.options(), null, message => failures.push(message), () => assert.fail('must not be accepted'));
  const task = f.view.synthesisTasks.get(f.parent.path);
  assert.equal(task.state, 'failed'); assert.match(task.progress, /Codex is not signed in/); assert.equal(failures.length, 1);
  assert.equal(f.plugin.activeTasks.size, 0); assert.equal(f.plugin.running.size, 0);
  assert.equal((await f.repo.readNote(f.parent.path)).status, 'completed');
});
async function multiResearchHarness(titles, overrides = {}) {
  const { repo, app } = fixture(overrides.language ?? 'en'), notices = [], runs = [], finish = new Map(), opened = [];
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md', mapDoc = { id: 'map-a', title: 'map-a', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  await repo.ensureTopicFolders('Agent Workspace/Topics/map-a'); await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const nodes = [];
  for (const title of titles) { const created = await repo.createNote(title, 'model-a', mapDoc, mapPath, 'workspace'); mapDoc.nodes.push(created); nodes.push(created); }
  await repo.saveMap(mapPath, mapDoc);
  const confirms = [];
  const plugin = withExpansionCoordinator({ repo, settings: { ...DEFAULT_SETTINGS, language: overrides.language ?? 'en', cliModel: 'gpt-6-luna' }, running: new Set(), abortChartJobs: () => {}, addChartsAfterWrite: () => {}, pendingSuggestions: new Map(), pendingResearchOptions: new Map(), rebuildDerivedData: async () => {}, mutate: async work => work(), confirmAiUsage: async (model, run) => { confirms.push(model); await run(); return true; }, ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== 'language')) });
  const { VisualAgentMapView } = load('main.ts', { obsidian: { ...obsidian, Notice: class { constructor(message) { notices.push(message); } }, Modal: class { constructor(app) { this.app = app; } open() { opened.push(this); } } } });
  const view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.contentEl = { querySelector: () => null }; view.render = () => {}; view.hydrate = async () => {};
  view.runAgent = async (child, _done, failed, options, accepted) => {
    const note = await repo.readNote(child.path);
    runs.push({ title: note.title, options }); plugin.running.add(child.path); accepted();
    const finished = new Promise(resolve => { finish.set(note.title, (message) => { plugin.running.delete(child.path); if (message) failed(message); resolve(); }); options.signal.addEventListener('abort', () => { plugin.running.delete(child.path); resolve(); }, { once: true }); });
    return { finished };
  };
  const request = { researchMode: 'research', researchDepth: 'fast', requirements: '', imageSearch: false };
  return { repo, view, plugin, nodes, notices, runs, finish, confirms, opened, request, key: `multi-research:${mapPath}` };
}
integrationTest('multi research runs selected topics in the background with the chosen options and a map-level key', async () => {
  const h = await multiResearchHarness(['A', 'B']);
  await h.repo.updateNote(h.nodes[1].path, { prompt: 'Custom prompt for B' });
  h.view.multiSelected = new Set(h.nodes.map(n => n.id));
  await h.view.startMultiResearch({ researchMode: 'local', researchDepth: 'deep', requirements: 'Focus on 2025', imageSearch: false });
  await until(() => h.runs.length === 2);
  assert.deepEqual(plain(h.confirms), ['gpt-6-luna']);
  const [a, b] = h.runs;
  assert.match(a.options.task, /A/); assert.match(a.options.task, /Focus on 2025$/);
  assert.match(b.options.task, /^Custom prompt for B\n\nFocus on 2025$/);
  for (const run of h.runs) { assert.equal(run.options.researchMode, 'local'); assert.equal(run.options.researchDepth, 'deep'); assert.equal(run.options.visualMode, 'off'); assert.deepEqual(plain(run.options.referenceGroups), []); }
  assert.equal(h.plugin.expansionBatches.get(h.key).total, 2);
  assert.ok(!h.nodes.some(n => h.plugin.expansionBatches.has(n.path)), 'no per-node batch badge');
  h.finish.get('A')(); h.finish.get('B')();
  await until(() => h.plugin.expansionBatches.get(h.key).status === 'completed');
  assert.equal(h.plugin.activeTasks.has(h.key), false);
});
integrationTest('multi research without an explicit language answers each topic in its own title language', async () => {
  const h = await multiResearchHarness(['要如何在陽台養香草', 'Balcony herbs']);
  h.view.multiSelected = new Set(h.nodes.map(n => n.id));
  await h.view.startMultiResearch(h.request); await until(() => h.runs.length === 2);
  assert.equal(h.runs.find(r => r.title === '要如何在陽台養香草').options.outputLanguage, 'zh-TW');
  assert.equal(h.runs.find(r => r.title === 'Balcony herbs').options.outputLanguage, 'same-as-input');
  assert.match(h.runs.find(r => r.title === '要如何在陽台養香草').options.task, /[\u4e00-\u9fff]/);
  h.finish.get('要如何在陽台養香草')(); h.finish.get('Balcony herbs')();
});
integrationTest('multi research with image search runs each topic with auto visual mode', async () => {
  const h = await multiResearchHarness(['Img']);
  h.view.multiSelected = new Set([h.nodes[0].id]);
  await h.view.startMultiResearch({ ...h.request, imageSearch: true });
  await until(() => h.runs.length === 1);
  assert.equal(h.runs[0].options.visualMode, 'auto');
  h.finish.get('Img')(); await until(() => h.plugin.expansionBatches.get(h.key).status === 'completed');
});
integrationTest('multi research without requirements uses the topic prompt alone and web search maps to research', async () => {
  const h = await multiResearchHarness(['Solo']);
  h.view.multiSelected = new Set([h.nodes[0].id]);
  await h.view.startMultiResearch(h.request);
  await until(() => h.runs.length === 1);
  assert.doesNotMatch(h.runs[0].options.task, /\n\n$/); assert.equal(h.runs[0].options.researchMode, 'research');
  h.finish.get('Solo')(); await until(() => h.plugin.expansionBatches.get(h.key).status === 'completed');
});
integrationTest('multi research runs at most three topics at once and stop aborts every running one', async () => {
  const h = await multiResearchHarness(['A', 'B', 'C', 'D', 'E']);
  h.view.multiSelected = new Set(h.nodes.map(n => n.id));
  await h.view.startMultiResearch(h.request);
  await until(() => h.runs.length === 3); await new Promise(r => setTimeout(r, 20));
  assert.equal(h.runs.length, 3);
  h.finish.get('A')(); await until(() => h.runs.length === 4);
  assert.equal(h.plugin.expansionBatches.get(h.key).completed, 1);
  h.view.stopMultiResearch();
  await until(() => h.plugin.expansionBatches.get(h.key).status === 'stopped');
  assert.equal(h.runs.length, 4); assert.equal(h.plugin.running.size, 0);
  assert.ok(h.runs.every(run => run.options.signal.aborted));
});
integrationTest('multi research skips topics already running AI and tells the owner how many', async () => {
  const h = await multiResearchHarness(['A', 'B', 'C', 'D']);
  h.plugin.running.add(h.nodes[0].path); h.plugin.quickExpandPending.add(h.nodes[1].path); h.plugin.activeTasks.set(h.nodes[2].path, new AbortController());
  h.view.multiSelected = new Set(h.nodes.map(n => n.id));
  await h.view.startMultiResearch(h.request);
  await until(() => h.runs.length === 1);
  assert.deepEqual(plain(h.runs.map(r => r.title)), ['D']);
  assert.equal(h.plugin.expansionBatches.get(h.key).total, 1);
  assert.ok(h.notices.some(m => /Skipped 3 /.test(m)), h.notices.join('|'));
  h.finish.get('D')(); await until(() => h.plugin.expansionBatches.get(h.key).status === 'completed');
});
integrationTest('multi research starts no batch when every selected topic is already running', async () => {
  const h = await multiResearchHarness(['A', 'B']);
  for (const n of h.nodes) h.plugin.running.add(n.path);
  h.view.multiSelected = new Set(h.nodes.map(n => n.id));
  await h.view.startMultiResearch(h.request);
  assert.equal(h.plugin.expansionBatches.has(h.key), false); assert.equal(h.runs.length, 0);
  assert.equal(h.notices.length, 1); assert.match(h.notices[0], /already running/);
});
integrationTest('a second multi research batch on the same map is refused while one is running', async () => {
  const h = await multiResearchHarness(['A', 'B', 'C']);
  h.view.multiSelected = new Set([h.nodes[0].id]);
  await h.view.startMultiResearch(h.request); await until(() => h.runs.length === 1);
  h.view.multiSelected = new Set([h.nodes[1].id, h.nodes[2].id]);
  h.confirms.length = 0;
  await h.view.startMultiResearch(h.request);
  assert.equal(h.runs.length, 1); assert.equal(h.confirms.length, 0);
  assert.ok(h.notices.some(m => /already running on this map/.test(m)));
  assert.equal(h.plugin.expansionBatches.get(h.key).total, 1);
  h.finish.get('A')(); await until(() => h.plugin.expansionBatches.get(h.key).status === 'completed');
});
integrationTest('a failing topic is recorded and does not stop the others', async () => {
  const h = await multiResearchHarness(['A', 'B', 'C']);
  h.view.multiSelected = new Set(h.nodes.map(n => n.id));
  await h.view.startMultiResearch(h.request);
  await until(() => h.runs.length === 3);
  h.finish.get('B')('model exploded'); h.finish.get('A')(); h.finish.get('C')();
  await until(() => h.plugin.expansionBatches.get(h.key).status === 'completed');
  const state = h.plugin.expansionBatches.get(h.key);
  assert.equal(state.completed, 3); assert.equal(state.failures.length, 1); assert.match(state.failures[0], /model exploded/);
  assert.ok(h.notices.some(m => /1 failed/.test(m)), h.notices.join('|'));
});
integrationTest('multi research is not offered on AIM maps and needs at least one topic', async () => {
  const h = await multiResearchHarness(['A']);
  h.view.multiSelected = new Set(); await h.view.startMultiResearch(h.request);
  assert.equal(h.plugin.expansionBatches.size, 0);
  h.view.map.aim = { version: 1, branches: [], runs: [], pendingCommits: [] }; h.view.multiSelected = new Set([h.nodes[0].id]);
  await h.view.startMultiResearch(h.request);
  assert.equal(h.plugin.expansionBatches.size, 0); assert.equal(h.runs.length, 0);
});
integrationTest('selection bar shows Research; starting leaves selection mode and the top status bar shows progress and Stop', async () => {
  const h = await multiResearchHarness(['A', 'B']);
  const element = (tag, o = {}) => ({ tag, text: o.text ?? '', cls: o.cls ?? '', disabled: false, children: [], listeners: {}, attrs: {},
    createDiv(v) { const c = element('div', { cls: typeof v === 'string' ? v : v?.cls }); this.children.push(c); return c; },
    createEl(n, v = {}) { const c = element(n, v); this.children.push(c); return c; }, createSpan(v = {}) { const c = element('span', v); this.children.push(c); return c; },
    addEventListener(n, fn) { this.listeners[n] = fn; }, addClass(n) { this.cls = `${this.cls} ${n}`.trim(); }, setAttr(k, v) { this.attrs[k] = v; } });
  const all = root => [root, ...root.children.flatMap(all)];
  const bar = (view = h.view) => { const root = element('workspace'); view.renderSelectionBar(root); return all(root); };
  const toolbar = () => { const root = element('content'); h.view.renderMultiResearchStatus(root); return all(root); };
  h.view.notes = new Map(h.nodes.map(n => [n.id, { title: n.id }]));
  let items = bar(); const research = () => items.find(i => i.tag === 'button' && /^Research( 1 topic)?$/.test(i.text));
  items = bar(); assert.ok(research()); assert.equal(research().disabled, true);
  h.view.multiSelected = new Set([h.nodes[0].id]); items = bar(); assert.equal(research().disabled, false); assert.equal(research().text, 'Research'); assert.equal(research().attrs['aria-label'], 'Research 1 topic');
  h.view.map.aim = {}; items = bar(); assert.equal(research(), undefined); delete h.view.map.aim;
  assert.equal(toolbar().length, 1);
  h.view.integrationMode = true;
  await h.view.startMultiResearch(h.request); await until(() => h.runs.length === 1);
  assert.equal(h.view.integrationMode, false); assert.equal(h.view.multiSelected.size, 0);
  h.view.multiSelected = new Set([h.nodes[1].id]); items = bar(); assert.equal(research().disabled, true);
  assert.equal(items.find(i => i.text === 'Researching: 0 of 1 done'), undefined);
  items = toolbar();
  assert.ok(items.find(i => i.tag === 'span' && i.text === `Researching: 0 of 1 done · ${h.nodes[0].id}`), items.map(i => i.text).join('|'));
  assert.ok(items.find(i => i.tag === 'div' && /vam-aim-statusbar/.test(i.cls)));
  const stop = items.find(i => i.tag === 'button' && i.text === 'Stop research'); assert.ok(stop);
  stop.listeners.click({ stopPropagation() {} });
  await until(() => h.plugin.expansionBatches.get(h.key).status === 'stopped');
  assert.equal(toolbar().length, 1);
});
integrationTest('multi research with a chosen model saves it on each started topic and confirms usage for it', async () => {
  const h = await multiResearchHarness(['A', 'B', 'C']);
  h.plugin.running.add(h.nodes[2].path);
  h.view.multiSelected = new Set(h.nodes.map(n => n.id));
  await h.view.startMultiResearch({ ...h.request, model: 'model-b' });
  await until(() => h.runs.length === 2);
  assert.deepEqual(plain(h.confirms), ['model-b']);
  for (const node of h.nodes.slice(0, 2)) {
    const note = await h.repo.readNote(node.path);
    assert.equal(note.model, 'model-b'); assert.equal(note.modelSource, 'manual');
  }
  assert.equal((await h.repo.readNote(h.nodes[2].path)).model, h.repo.settings.cliModel, 'a workspace topic follows the current workspace model, not its creation snapshot');
  h.finish.get('A')(); h.finish.get('B')();
});
integrationTest('multi research without a chosen model runs a workspace topic on the current workspace model', async () => {
  const h = await multiResearchHarness(['A']);
  h.view.multiSelected = new Set([h.nodes[0].id]);
  await h.view.startMultiResearch(h.request); await until(() => h.runs.length === 1);
  const note = await h.repo.readNote(h.nodes[0].path);
  assert.equal(note.model, h.repo.settings.cliModel); assert.equal(note.modelSource, 'workspace');
  h.finish.get('A')();
});
integrationTest('multi research keeps selection mode when nothing starts', async () => {
  const h = await multiResearchHarness(['A']);
  h.plugin.running.add(h.nodes[0].path);
  h.view.integrationMode = true; h.view.multiSelected = new Set([h.nodes[0].id]);
  await h.view.startMultiResearch(h.request);
  assert.equal(h.view.integrationMode, true); assert.equal(h.view.multiSelected.size, 1);
});
integrationTest('multi research: stop before any topic is accepted gives exactly one summary Notice and no launch error', async () => {
  const h = await multiResearchHarness(['A']);
  h.view.runAgent = async () => { h.view.stopMultiResearch(); return undefined; };
  h.view.multiSelected = new Set([h.nodes[0].id]);
  await h.view.startMultiResearch(h.request);
  await until(() => h.plugin.expansionBatches.get(h.key).status !== 'running');
  assert.equal(h.notices.length, 1, h.notices.join('|'));
  assert.equal(h.notices[0], 'Research stopped: 0 of 1 succeeded, 0 failed, 0 skipped.');
});
integrationTest('multi research: a topic that became busy before dispatch is skipped, not failed', async () => {
  const h = await multiResearchHarness(['A', 'B', 'C', 'D']);
  h.view.multiSelected = new Set(h.nodes.map(n => n.id));
  await h.view.startMultiResearch(h.request);
  await until(() => h.runs.length === 3);
  h.plugin.running.add(h.nodes[3].path);
  h.finish.get('A')(); h.finish.get('B')(); h.finish.get('C')();
  await until(() => h.plugin.expansionBatches.get(h.key).status === 'completed');
  assert.equal(h.runs.length, 3);
  const state = h.plugin.expansionBatches.get(h.key);
  assert.equal(state.failures.length, 0);
  assert.equal(h.notices.at(-1), 'Research finished: 3 of 4 succeeded, 0 failed, 1 skipped.');
});
integrationTest('multi research summary counts only successful topics as succeeded', async () => {
  const h = await multiResearchHarness(['A', 'B']);
  h.view.multiSelected = new Set(h.nodes.map(n => n.id));
  await h.view.startMultiResearch(h.request);
  await until(() => h.runs.length === 2);
  h.finish.get('A')('boom'); h.finish.get('B')();
  await until(() => h.plugin.expansionBatches.get(h.key).status === 'completed');
  assert.equal(h.notices.at(-1), 'Research finished: 1 of 2 succeeded, 1 failed, 0 skipped.');
});
const templateSection = (id, name, extra = {}) => ({ id, name, description: '', role: 'none', aliases: [], ...extra });
const testTemplate = (id, names) => ({ id, name: `Template ${id}`, sections: names.map((name, index) => templateSection(`${id}-${index}`, name)) });
const sampleTemplates = () => [testTemplate('A', ['Alpha']), testTemplate('B', ['Beta']), testTemplate('C', ['Gamma'])];
// Runs the real runAgent / synthesis save paths; only plugin.askModel is a double (L-001).
async function templateHarness({ language = 'zh-TW', settings = {}, mapTemplate, reply } = {}) {
  const { repo, app } = fixture(language), notices = [], contexts = [], chartJobs = [], chartAborts = [];
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md', doc = { id: 'map-a', title: 'map-a', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  if (mapTemplate) doc.detailTemplateId = mapTemplate;
  await repo.ensureTopicFolders('Agent Workspace/Topics/map-a'); await app.vault.create(mapPath, core.serializeMap(doc));
  const topic = await repo.createNote('Topic', 'model-a', doc, mapPath, 'workspace'); doc.nodes.push(topic); await repo.saveMap(mapPath, doc);
  await repo.updateNote(topic.path, { prompt: 'Research the topic' });
  let view;
  const plugin = withExpansionCoordinator({ repo, settings: { ...DEFAULT_SETTINGS, language, ...settings }, running: new Set(), abortChartJobs: path => chartAborts.push(path), addChartsAfterWrite: job => chartJobs.push(job), activeTasks: new Map(), pendingSuggestions: new Map(), pendingResearchOptions: new Map(), rebuildDerivedData: async () => {}, mutate: async work => work(), views: () => [view], recordFailure: (_label, error) => error.message,
    askModel: async (context, _model, _reasoning, _signal, _exchange, onAccepted) => { contexts.push(context); onAccepted?.(); return (reply ?? (() => ({ summary: 'Saved summary', detail: 'Saved detail', visualReferences: [], suggestions: [] })))(context, contexts.length); } });
  const { VisualAgentMapView } = load('main.ts', { obsidian: { ...obsidian, Notice: class { constructor(message) { notices.push(message); } } } });
  view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = doc; view.contentEl = { querySelector: () => null }; view.render = () => {}; view.hydrate = async () => {}; view.ancestorContext = async () => '';
  const run = async (target = topic) => { const handle = await view.runAgent(target); await handle?.finished; await until(() => !plugin.running.size); };
  return { repo, app, view, plugin, doc, mapPath, topic, notices, contexts, run, chartJobs, chartAborts };
}
integrationTest('runAgent: context carries the resolved template (topic > map > workspace > Standard)', async () => {
  const h = await templateHarness({ settings: { detailTemplates: sampleTemplates(), defaultDetailTemplateId: 'C' } });
  await h.run(); assert.equal(h.contexts.at(-1).detailTemplate.id, 'C');
  h.doc.detailTemplateId = 'B'; await h.run(); assert.equal(h.contexts.at(-1).detailTemplate.id, 'B');
  await h.repo.updateNote(h.topic.path, { detailTemplateId: 'A' }); await h.run(); assert.equal(h.contexts.at(-1).detailTemplate.id, 'A');
  assert.deepEqual(h.notices, []);
  assert.equal((await h.repo.readNote(h.topic.path)).detailTemplateId, 'A');
  const bare = await templateHarness({ language: 'en' });
  await bare.run();
  assert.equal(bare.contexts[0].detailTemplate.id, 'standard');
  assert.equal(bare.contexts[0].detailTemplate.sections[0].name, 'Core conclusions');
  assert.equal((await bare.repo.readNote(bare.topic.path)).detailTemplateId, undefined, 'resolution never writes the topic');
});
integrationTest('runAgent saves detail with the template order and stores formatIssues text; clears it when met', async () => {
  const template = { id: 'T', name: 'Counted', sections: [templateSection('t0', '結論'), templateSection('t1', '範例', { count: { mode: 'exact', n: 3 } }), templateSection('t2', '來源', { role: 'sources' })] };
  const picture = { title: 'Pic', imageUrl: 'https://example.com/a.png', sourceUrl: 'https://example.com/page', description: '', palette: [], formula: '' };
  const h = await templateHarness({ settings: { detailTemplates: [template], defaultDetailTemplateId: 'T' }, reply: (_context, call) => call === 1
    ? { summary: 'S1', detail: '### 範例\n\n- one\n\n### 結論\n\nConclusion text', suggestions: [], visualReferences: [picture], formatIssues: [{ section: '範例', mode: 'exact', n: 3, actual: 1 }] }
    : { summary: 'S2', detail: '### 結論\n\nDone\n\n### 範例\n\n- a\n- b\n- c', suggestions: [], visualReferences: [], formatIssues: [] } });
  await h.run();
  let note = await h.repo.readNote(h.topic.path);
  assert.equal(note.status, 'completed');
  const order = ['### 結論', '### 範例', '### 來源'].map(heading => note.detail.indexOf(heading));
  assert.ok(order.every(index => index >= 0) && order[0] < order[1] && order[1] < order[2], note.detail);
  const image = note.detail.indexOf('![Pic](https://example.com/a.png)');
  assert.ok(image > order[1] && image < order[2], `image is placed at the template's sources heading, not appended: ${note.detail}`);
  assert.deepEqual(plain(note.detailFormatIssues), ['範例：要求剛好 3 個，實際 1 個']);
  await h.run();
  note = await h.repo.readNote(h.topic.path);
  assert.deepEqual(plain(note.detailFormatIssues), []);
  assert.match(note.detail, /- c/);
});
integrationTest('runAgent clears stored format issues when the result has no count check', async () => {
  const h = await templateHarness({ language: 'en' });
  await h.repo.updateNote(h.topic.path, { detailFormatIssues: ['Old: needs exactly 2, has 0'] });
  await h.run();
  const note = await h.repo.readNote(h.topic.path);
  assert.equal(note.summary, 'Saved summary');
  assert.deepEqual(plain(note.detailFormatIssues), []);
});
integrationTest('a deleted topic template notifies once, clears the field and falls back', async () => {
  const h = await templateHarness({ language: 'en', settings: { detailTemplates: sampleTemplates() }, mapTemplate: 'B' });
  await h.repo.updateNote(h.topic.path, { detailTemplateId: 'gone' });
  await h.run();
  assert.equal(h.contexts[0].detailTemplate.id, 'B');
  assert.equal(h.notices.length, 1, h.notices.join('|'));
  assert.match(h.notices[0], /"gone" no longer exists/);
  let note = await h.repo.readNote(h.topic.path);
  assert.equal(note.detailTemplateId, undefined);
  assert.equal(note.summary, 'Saved summary', 'clearing the field does not make the result stale');
  await h.run();
  assert.equal(h.contexts[1].detailTemplate.id, 'B');
  assert.equal(h.notices.length, 1, h.notices.join('|'));
});
integrationTest('an explicit choice is recorded on the topic and its reply still saves', async () => {
  const h = await templateHarness({ language: 'en', settings: { detailTemplates: sampleTemplates(), defaultDetailTemplateId: 'C' }, reply: () => ({ summary: 'Chosen summary', detail: '### Alpha\n\nBody', visualReferences: [], suggestions: [] }) });
  await h.view.researchChild(h.topic, new AbortController().signal, () => {}, { researchMode: 'local', researchDepth: 'fast', visualMode: 'off', referenceGroups: [], detailTemplateId: 'A' });
  await until(() => !h.plugin.running.size);
  assert.equal(h.contexts[0].detailTemplate.id, 'A');
  const note = await h.repo.readNote(h.topic.path);
  assert.equal(note.detailTemplateId, 'A');
  assert.equal(note.summary, 'Chosen summary');
  assert.ok(!h.notices.some(message => /outdated/.test(message)), h.notices.join('|'));
  assert.match(note.detail, /^### Alpha/);
});
integrationTest('synthesis and integrated topics save with the template', async () => {
  const custom = { id: 'X', name: 'Custom', sections: [templateSection('x0', 'First part'), templateSection('x1', 'Second part'), templateSection('x2', 'Refs', { role: 'sources' })] };
  const reply = (_context, call) => call === 1
    ? { summary: '', detail: '', visualReferences: [], suggestions: [{ title: 'Angle', task: 'Compare them', contribution: '', parentTitle: '' }] }
    : { summary: 'Synth', detail: '### Second part\n\nTwo\n\n### First part\n\nOne', visualReferences: [], suggestions: [] };
  const h = await templateHarness({ language: 'en', settings: { detailTemplates: [custom] }, mapTemplate: 'X', reply });
  const child = await h.repo.createNote('Child', 'model-a', h.doc, h.mapPath, 'workspace'); child.parentId = h.topic.id; h.doc.nodes.push(child); await h.repo.saveMap(h.mapPath, h.doc);
  await h.repo.updateNote(h.topic.path, { status: 'completed' });
  const options = () => ({ researchMode: 'local', researchDepth: 'normal', visualMode: 'off', referenceGroups: [] });
  await h.view.startSynthesis(h.topic, options(), null, message => assert.fail(message), () => {});
  await h.view.startSynthesis(h.topic, options(), 'Compare them', message => assert.fail(message), () => {});
  assert.equal(h.contexts.at(-1).detailTemplate.id, 'X');
  assert.equal(h.view.synthesisTasks.has(h.topic.path), false, 'written directly');
  const parent = await h.repo.readNote(h.topic.path);
  assert.ok(parent.detail.indexOf('### First part') < parent.detail.indexOf('### Second part'), parent.detail);
  assert.ok(!/### Core conclusions/.test(parent.detail), parent.detail);
  const other = await h.repo.createNote('Other', 'model-a', h.doc, h.mapPath, 'workspace'); h.doc.nodes.push(other); await h.repo.saveMap(h.mapPath, h.doc);
  await h.view.createIntegratedNode('Combined', [h.topic, other], 'Compare', '');
  assert.equal(h.contexts.at(-1).detailTemplate.id, 'X');
  const saved = await h.repo.readMap(h.mapPath);
  const integrated = await h.repo.readNote(saved.nodes.at(-1).path);
  assert.equal(integrated.title, 'Combined');
  assert.ok(integrated.detail.indexOf('### First part') < integrated.detail.indexOf('### Second part'), integrated.detail);
  const created = await h.view.createChildBatch(h.topic, [{ title: 'Contributed', task: 'Look', contribution: '### Second part\n\nB\n\n### First part\n\nA' }]);
  const contributed = await h.repo.readNote(created[0].path);
  assert.ok(contributed.detail.indexOf('### First part') < contributed.detail.indexOf('### Second part'), contributed.detail);
});
// Writing tone (B1): every TaskContext builder resolves chosen > topic override > map default > academic.
const toneTexts = language => Object.fromEntries(load('ai/prompt-presets.ts').builtinPresets(language, 'tone').map(item => [item.id, item.text]));
const { taskPrompt: renderTaskPrompt } = load('core/steps/task/render.ts');
integrationTest('tone: runAgent resolves topic override > map default > academic and the prompt carries the tone block', async () => {
  const tones = toneTexts('en');
  const h = await templateHarness({ language: 'en', settings: { promptPresets: [{ id: 'mine', kind: 'tone', name: 'Mine', text: 'Write like a friendly neighbour.' }] } });
  await h.run();
  assert.equal('toneText' in h.contexts.at(-1), false, 'no tone: prompts unchanged');
  h.doc.toneId = 'plain'; await h.run();
  assert.equal(h.contexts.at(-1).toneText, tones.plain);
  assert.ok(renderTaskPrompt(h.contexts.at(-1), 'en').includes(tones.plain), 'the rendered prompt contains the tone text');
  await h.repo.updateNote(h.topic.path, { toneId: 'mine' }); await h.run();
  assert.equal(h.contexts.at(-1).toneText, 'Write like a friendly neighbour.');
  await h.repo.updateNote(h.topic.path, { toneId: 'academic' }); await h.run();
  assert.equal('toneText' in h.contexts.at(-1), false, 'an explicit academic topic override beats the map default');
  assert.ok(!renderTaskPrompt(h.contexts.at(-1), 'en').includes(tones.plain) && !renderTaskPrompt(h.contexts.at(-1), 'en').includes(tones.academic), 'academic adds no tone block');
  await h.repo.updateNote(h.topic.path, { toneId: 'gone' }); await h.run();
  assert.equal(h.contexts.at(-1).toneText, tones.plain, 'a deleted topic tone falls through to the map default');
});
integrationTest('tone: a dialog choice is recorded on the topic and used by that run (single and batch research)', async () => {
  const tones = toneTexts('en');
  const h = await templateHarness({ language: 'en' });
  await h.view.researchChild(h.topic, new AbortController().signal, () => {}, { researchMode: 'local', researchDepth: 'fast', visualMode: 'off', referenceGroups: [], toneId: 'magazine' });
  await until(() => !h.plugin.running.size);
  assert.equal(h.contexts.at(-1).toneText, tones.magazine);
  assert.equal((await h.repo.readNote(h.topic.path)).toneId, 'magazine');
  await h.view.researchChild(h.topic, new AbortController().signal, () => {}, { researchMode: 'local', researchDepth: 'fast', visualMode: 'off', referenceGroups: [] });
  await until(() => !h.plugin.running.size);
  assert.equal(h.contexts.at(-1).toneText, tones.magazine, 'no choice keeps the topic tone');
});
integrationTest('tone: expansion, synthesis directions, draft and integrated topics all pass toneText', async () => {
  const tones = toneTexts('en');
  const reply = (_context, call) => call === 1
    ? { summary: '', detail: '', visualReferences: [], suggestions: [{ title: 'Angle', task: 'Compare them', contribution: '', parentTitle: '' }] }
    : { summary: 'Synth', detail: '### Core conclusions\n\nTwo', visualReferences: [], suggestions: [] };
  const h = await templateHarness({ language: 'en', reply });
  h.doc.toneId = 'summary';
  const child = await h.repo.createNote('Child', 'model-a', h.doc, h.mapPath, 'workspace'); child.parentId = h.topic.id; h.doc.nodes.push(child); await h.repo.saveMap(h.mapPath, h.doc);
  await h.repo.updateNote(h.topic.path, { status: 'completed' });
  const options = () => ({ researchMode: 'local', researchDepth: 'normal', visualMode: 'off', referenceGroups: [] });
  await h.view.startSynthesis(h.topic, options(), null, message => assert.fail(message), () => {});
  assert.equal(h.contexts.at(-1).mode, 'synthesize');
  assert.equal(h.contexts.at(-1).toneText, tones.summary, 'synthesis directions');
  await h.view.startSynthesis(h.topic, options(), 'Compare them', message => assert.fail(message), () => {});
  assert.equal(h.contexts.at(-1).toneText, tones.summary, 'synthesis draft');
  await h.view.proposeChildren(h.topic, options(), '', () => {}, () => {}, () => {});
  assert.equal(h.contexts.at(-1).mode, 'decompose');
  assert.equal(h.contexts.at(-1).toneText, tones.summary, 'expand');
  const other = await h.repo.createNote('Other', 'model-a', h.doc, h.mapPath, 'workspace'); h.doc.nodes.push(other); await h.repo.saveMap(h.mapPath, h.doc);
  await h.view.createIntegratedNode('Combined', [h.topic, other], 'Compare', '');
  assert.equal(h.contexts.at(-1).toneText, tones.summary, 'multi-select integration uses the map tone');
  delete h.doc.toneId; await h.repo.saveMap(h.mapPath, h.doc);
  await h.view.createIntegratedNode('Plain', [h.topic, other], 'Compare', '');
  assert.equal('toneText' in h.contexts.at(-1), false);
});
integrationTest('W1: all four synthesize call sites ask for direct reference delivery; plain research does not', async () => {
  const reply = (_context, call) => call === 1 || call === 3
    ? { summary: '', detail: '', visualReferences: [], suggestions: [{ title: 'Angle', task: 'Compare them', contribution: '', parentTitle: '' }] }
    : { summary: 'Synth', detail: '### Core conclusions\n\nTwo', visualReferences: [], suggestions: [] };
  const h = await templateHarness({ language: 'en', reply });
  const child = await h.repo.createNote('Child', 'model-a', h.doc, h.mapPath, 'workspace'); child.parentId = h.topic.id; h.doc.nodes.push(child); await h.repo.saveMap(h.mapPath, h.doc);
  const other = await h.repo.createNote('Other', 'model-a', h.doc, h.mapPath, 'workspace'); h.doc.nodes.push(other); await h.repo.saveMap(h.mapPath, h.doc);
  await h.repo.updateNote(h.topic.path, { status: 'completed' });
  const options = () => ({ researchMode: 'local', researchDepth: 'normal', visualMode: 'off', referenceGroups: [] });
  await h.view.startSynthesis(h.topic, options(), null, message => assert.fail(message), () => {});
  assert.equal(h.contexts.at(-1).mode, 'synthesize'); assert.equal(h.contexts.at(-1).referenceDelivery, 'direct', 'child synthesis directions');
  await h.view.startSynthesis(h.topic, options(), 'Compare them', message => assert.fail(message), () => {});
  assert.equal(h.contexts.at(-1).referenceDelivery, 'direct', 'child synthesis draft');
  await h.view.startSelectionSynthesis([h.topic, other], options(), null, message => assert.fail(message), () => {});
  assert.equal(h.contexts.at(-1).mode, 'synthesize'); assert.equal(h.contexts.at(-1).referenceDelivery, 'direct', 'multi-select directions');
  h.view.integrationTask = null;
  await h.view.createIntegratedNode('Combined', [h.topic, other], 'Compare', '');
  assert.equal(h.contexts.at(-1).referenceDelivery, 'direct', 'multi-select draft');
  await h.view.researchChild(h.topic, new AbortController().signal, () => {}, options());
  await until(() => !h.plugin.running.size);
  assert.equal(h.contexts.at(-1).referenceDelivery, undefined, 'research keeps its extraction behaviour');
});
const countedTemplate = () => ({ id: 'K', name: 'Counted', sections: [templateSection('k0', 'Main'), templateSection('k1', 'Examples', { count: { mode: 'exact', n: 3 } })] });
// Synthesis: call 1 proposes an angle, call 2 drafts; the draft is then saved (optionally edited) through the real save path.
async function synthesisWithIssues({ settings, mapTemplate, draft }) {
  const reply = (_context, call) => call === 1
    ? { summary: '', detail: '', visualReferences: [], suggestions: [{ title: 'Angle', task: 'Compare them', contribution: '', parentTitle: '' }] }
    : draft;
  const h = await templateHarness({ language: 'en', settings, mapTemplate, reply });
  const child = await h.repo.createNote('Child', 'model-a', h.doc, h.mapPath, 'workspace'); child.parentId = h.topic.id; h.doc.nodes.push(child); await h.repo.saveMap(h.mapPath, h.doc);
  await h.repo.updateNote(h.topic.path, { status: 'completed', detailFormatIssues: ['Old: needs exactly 2, has 0'] });
  const options = () => ({ researchMode: 'local', researchDepth: 'normal', visualMode: 'off', referenceGroups: [] });
  await h.view.startSynthesis(h.topic, options(), null, message => assert.fail(message), () => {});
  await h.view.startSynthesis(h.topic, options(), 'Compare them', message => assert.fail(message), () => {});
  return h;
}
const unmetDraft = { summary: 'Synth', detail: '### Main\n\nM\n\n### Examples\n\n- one', visualReferences: [], suggestions: [], formatIssues: [{ section: 'Examples', mode: 'exact', n: 3, actual: 1 }] };
integrationTest('synthesis stores the result format issues and clears the old mark without a count check', async () => {
  const unedited = await synthesisWithIssues({ settings: { detailTemplates: [countedTemplate()] }, mapTemplate: 'K', draft: unmetDraft });
  assert.deepEqual(plain((await unedited.repo.readNote(unedited.topic.path)).detailFormatIssues), ['Examples: needs exactly 3, has 1']);
  const uncounted = await synthesisWithIssues({ settings: {}, draft: { summary: 'Synth', detail: '### Core conclusions\n\nC', visualReferences: [], suggestions: [] } });
  const note = await uncounted.repo.readNote(uncounted.topic.path);
  assert.equal(note.summary, 'Synth');
  assert.deepEqual(plain(note.detailFormatIssues), [], 'no count check ran: the old mark is cleared');
});
integrationTest('integrated topic stores the result format issues', async () => {
  const h = await templateHarness({ language: 'en', settings: { detailTemplates: [countedTemplate()] }, mapTemplate: 'K', reply: () => unmetDraft });
  const other = await h.repo.createNote('Other', 'model-a', h.doc, h.mapPath, 'workspace'); h.doc.nodes.push(other); await h.repo.saveMap(h.mapPath, h.doc);
  await h.view.createIntegratedNode('Combined', [h.topic, other], 'Compare', '');
  const saved = await h.repo.readMap(h.mapPath);
  const integrated = await h.repo.readNote(saved.nodes.at(-1).path);
  assert.equal(integrated.title, 'Combined');
  assert.deepEqual(plain(integrated.detailFormatIssues), ['Examples: needs exactly 3, has 1']);
});
const partsTemplate = () => ({ id: 'X', name: 'Parts', sections: [templateSection('x0', 'First part'), templateSection('x1', 'Second part')] });
const contributedSuggestion = title => ({ title, task: `Look at ${title}`, contribution: '### Second part\n\nB\n\n### First part\n\nA', parentTitle: '' });
integrationTest('expand without shallow research: the chosen template shapes contributions and is recorded on the new children', async () => {
  const reply = () => ({ summary: '', detail: '', visualReferences: [], suggestions: [contributedSuggestion('One'), contributedSuggestion('Two'), contributedSuggestion('Three')] });
  const h = await templateHarness({ language: 'en', settings: { detailTemplates: [partsTemplate()] }, reply });
  const options = { researchMode: 'local', researchDepth: 'fast', visualMode: 'off', referenceGroups: [], shallowResearch: false, detailTemplateId: 'X' };
  let create;
  await h.view.proposeChildren(h.topic, options, '', (items, run) => { create = () => run(items.slice(0, 1)); }, message => assert.fail(message));
  assert.ok(create, 'suggestions were presented');
  await create();
  const saved = await h.repo.readMap(h.mapPath);
  const child = await h.repo.readNote(saved.nodes.find(node => node.parentId === h.topic.id).path);
  assert.equal(child.detailTemplateId, 'X');
  assert.match(child.detail, /^### First part\n\nA\n\n### Second part\n\nB$/);
  assert.equal(h.contexts.length, 1, 'no research ran');
});
integrationTest('opening the AI dialog for a topic with a deleted template neither notifies nor rewrites the note', async () => {
  const opened = [], notices = [];
  const h = await templateHarness({ language: 'en', settings: { detailTemplates: sampleTemplates() }, mapTemplate: 'B' });
  await h.repo.updateNote(h.topic.path, { detailTemplateId: 'gone' });
  const before = await h.app.vault.read(h.app.vault.getAbstractFileByPath(h.topic.path));
  const { VisualAgentMapView } = load('main.ts', { obsidian: { ...obsidian, Modal: class { constructor() {} open() { opened.push(this); } close() {} }, Notice: class { constructor(message) { notices.push(message); } } } });
  const view = new VisualAgentMapView({ app: h.app }, h.plugin); view.path = h.mapPath; view.map = h.doc; view.render = () => {};
  view.openNextStep(h.topic);
  await until(() => opened.length === 1);
  assert.equal(opened[0].modelSettings.currentTemplate, 'Template B', 'label shows the fallback template');
  opened[0].close();
  assert.deepEqual(notices, []);
  assert.equal(await h.app.vault.read(h.app.vault.getAbstractFileByPath(h.topic.path)), before, 'note file unchanged');
  assert.equal((await h.repo.readNote(h.topic.path)).detailTemplateId, 'gone');
});
integrationTest('no templates, zh-TW interface, English output: Standard follows the output language in the request and the saved note', async () => {
  const h = await templateHarness({ language: 'zh-TW', reply: () => ({ summary: 'English summary', detail: '### Core conclusions\n\nC\n\n### Key knowledge\n\nK', visualReferences: [], suggestions: [] }) });
  const handle = await h.view.runAgent(h.topic, undefined, message => assert.fail(message), { outputLanguage: 'en' });
  await handle?.finished; await until(() => !h.plugin.running.size);
  assert.equal(h.contexts[0].detailTemplate.id, 'standard');
  assert.equal(h.contexts[0].detailTemplate.sections[0].name, 'Core conclusions');
  const note = await h.repo.readNote(h.topic.path);
  assert.equal(note.summary, 'English summary');
  assert.deepEqual(note.detail.split('\n').filter(line => line.startsWith('### ')), ['### Core conclusions', '### Key knowledge', '### Evidence and sources', '### Tradeoffs and limitations', '### Open questions', '### Update log']);
  assert.match(note.detail, /### Core conclusions\n\nC\n\n### Key knowledge\n\nK/);
});
integrationTest('multi research with a chosen template records it on each started topic and the AI request uses it (skipped topics untouched)', async () => {
  const h = await templateHarness({ language: 'en', settings: { detailTemplates: sampleTemplates(), defaultDetailTemplateId: 'C' } });
  const second = await h.repo.createNote('Second', 'model-a', h.doc, h.mapPath, 'workspace'); h.doc.nodes.push(second); await h.repo.saveMap(h.mapPath, h.doc);
  const third = await h.repo.createNote('Third', 'model-a', h.doc, h.mapPath, 'workspace'); h.doc.nodes.push(third); await h.repo.saveMap(h.mapPath, h.doc);
  await h.repo.updateNote(second.path, { prompt: 'Research second' }); await h.repo.updateNote(third.path, { prompt: 'Research third' });
  h.plugin.confirmAiUsage = async (_model, run) => { await run(); return true; };
  h.plugin.running.add(third.path); // busy: skipped before any write
  h.view.multiSelected = new Set([h.topic.id, second.id, third.id]);
  await h.view.startMultiResearch({ researchMode: 'local', researchDepth: 'fast', requirements: '', detailTemplateId: 'A' });
  await until(() => h.contexts.length === 2 && !h.plugin.running.has(h.topic.path) && !h.plugin.running.has(second.path));
  assert.deepEqual(h.contexts.map(context => context.detailTemplate.id), ['A', 'A']);
  assert.equal((await h.repo.readNote(h.topic.path)).detailTemplateId, 'A');
  assert.equal((await h.repo.readNote(second.path)).detailTemplateId, 'A');
  assert.equal((await h.repo.readNote(third.path)).detailTemplateId, undefined);
});
integrationTest('map action: the default content template for this map is set and cleared through mapChange', async () => {
  const opened = [];
  const h = await templateHarness({ language: 'en', settings: { detailTemplates: sampleTemplates() } });
  const { VisualAgentMapView } = load('main.ts', { obsidian: { ...obsidian, Modal: class { constructor() {} open() { opened.push(this); } close() {} }, Notice: class {} } });
  const view = new VisualAgentMapView({ app: h.app }, h.plugin); view.path = h.mapPath; view.map = h.doc; view.render = () => {}; view.enqueue = work => work();
  view.chooseMapTemplate();
  const choices = opened.at(-1).choices;
  assert.deepEqual(plain(choices.map(choice => choice.label)), ['Use the workspace default', 'Standard', 'Textbook', 'Template A', 'Template B', 'Template C']);
  assert.deepEqual(plain(choices.map(choice => choice.description ?? '')), ['Current setting', '', '', '', '', '']);
  await choices[4].action();
  await until(async () => (await h.repo.readMap(h.mapPath)).detailTemplateId === 'B');
  assert.equal(view.map.detailTemplateId, 'B');
  view.chooseMapTemplate();
  assert.deepEqual(plain(opened.at(-1).choices.map(choice => choice.description ?? '')), ['', '', '', '', 'Current setting', ''], 'the current map value is marked');
  await choices[0].action();
  await until(async () => (await h.repo.readMap(h.mapPath)).detailTemplateId === undefined);
  assert.equal(view.map.detailTemplateId, undefined);
});
integrationTest('map actions offer the default content template only on non-AIM maps', async () => {
  const opened = [];
  const h = await templateHarness({ language: 'en', settings: { detailTemplates: sampleTemplates() } });
  const { VisualAgentMapView } = load('main.ts', { obsidian: { ...obsidian, Modal: class { constructor() {} open() { opened.push(this); } close() {} }, Notice: class {} } });
  const view = new VisualAgentMapView({ app: h.app }, h.plugin); view.path = h.mapPath; view.map = h.doc; view.render = () => {};
  const labels = () => { view.openMapActions(); return opened.at(-1).choices.map(choice => choice.label); };
  const regular = labels();
  assert.ok(regular.includes('Default note style for this map'), 'one note style entry replaces the template and tone entries');
  assert.ok(!regular.includes('Default content template for this map') && !regular.includes('Default writing tone for this map'));
  view.map = { ...h.doc, aim: { runs: [] } };
  const aim = labels();
  assert.ok(!aim.includes('Default note style for this map') && !aim.includes('Default content template for this map'), 'templates do not apply to AIM maps');
  assert.ok(aim.includes('Default writing tone for this map'), 'AIM maps keep their tone-only entry');
});

test('coordinator counts succeeded and failed children with failed paths; aborted children count as neither', async () => {
  const { ShallowExpansionCoordinator } = load('experiences/visual-map/expansion-batch.ts');
  const states = new Map(), coordinator = new ShallowExpansionCoordinator(new Map(), states);
  await coordinator.start('parent.md', [node('a'), node('b'), node('c'), node('skip')], async (child, _signal, accepted) => {
    accepted(); if (child.id === 'b') throw new Error('Selected model is at capacity'); if (child.id === 'skip') return 'skipped';
  }, () => {});
  await until(() => states.get('parent.md').status !== 'running');
  const done = states.get('parent.md');
  assert.equal(done.completed, 4); assert.equal(done.succeeded, 2);
  assert.deepEqual(plain(done.failedPaths), ['b.md']); assert.equal(done.failures.length, 1); assert.match(done.failures[0], /at capacity/);
  const aborting = new Map(), second = new ShallowExpansionCoordinator(new Map(), aborting);
  const releases = []; await second.start('p.md', [node('x'), node('y')], async (child, signal, accepted) => {
    accepted(); await new Promise(resolve => releases.push(resolve)); if (child.id === 'y') throw new Error('late'); if (signal.aborted) return;
  }, () => {});
  await until(() => releases.length === 2); second.stop('p.md'); releases.forEach(r => r());
  await until(() => aborting.get('p.md').status !== 'running');
  const stopped = aborting.get('p.md'); assert.equal(stopped.status, 'stopped'); assert.equal(stopped.succeeded, 0); assert.deepEqual(plain(stopped.failedPaths), []);
});
function badgeElement(spans = [], buttons = []) {
  const make = (tag, options = {}) => { const el = { tag, text: options.text ?? '', cls: options.cls ?? '', attrs: {}, listeners: {}, children: [], style: {}, dataset: {},
    createDiv(v) { const c = make('div', typeof v === 'string' ? { cls: v } : v); this.children.push(c); return c; }, createSpan(v = {}) { const c = make('span', v); this.children.push(c); spans.push(c); return c; },
    createEl(name, v = {}) { const c = make(name, v); this.children.push(c); if (name === 'button') buttons.push(c); return c; }, appendChild(c) { this.children.push(c); return c; },
    setAttr(name, value) { this.attrs[name] = value; }, setAttribute(name, value) { this.attrs[name] = value; }, addClass(n) { this.cls = `${this.cls} ${n}`.trim(); }, removeClass() {}, toggleClass() {}, addEventListener(n, fn) { this.listeners[n] = fn; }, removeEventListener() {}, setPointerCapture() {}, empty() {}, setText(v) { this.text = v; } }; return el; };
  return make('stage');
}
async function nodeBadgeHarness(language, outcome) {
  const h = await multiResearchHarness(['Parent', 'A', 'B', 'C'], { language });
  const [parent, a, b, c] = h.nodes; const spans = [], buttons = [];
  h.view.stageEl = badgeElement(spans, buttons); h.view.notes = new Map(h.nodes.map(n => [n.id, { title: n.id === parent.id ? 'Parent' : n.id === a.id ? 'A' : n.id === b.id ? 'B' : 'C', status: 'completed', summary: '' }]));
  const release = new Map(); const children = [a, b, c];
  await h.plugin.expansionCoordinator.start(parent.path, children, async (child, _signal, accepted) => { accepted(); await new Promise(resolve => release.set(child.id, resolve)); if (child.id === b.id && outcome !== 'ok') throw new Error('Selected model is at capacity'); }, () => {});
  const paint = () => { spans.length = 0; buttons.length = 0; h.view.stageEl = badgeElement(spans, buttons); h.view.renderNode(parent); };
  const text = () => spans.map(s => s.text).join(' | ');
  return { h, parent, a, b, c, spans, buttons, release, paint, text };
}
integrationTest('shallow research badge: failure badge, stopped marker and retry after stop; zh-TW strings', async () => {
  const { translate } = load('i18n.ts'); const z = (key, ...v) => translate('zh-TW', key, ...v);
  assert.equal([z('ui.shallow_research_counts', 0, 3), z('ui.batch_failed_count', 1), z('ui.shallow_research_current', 'B')].join(' · '), '快速研究：完成 0／3 · 失敗 1 · 研究中：B');
  assert.equal([z('ui.shallow_research_counts', 2, 3), z('ui.batch_failed_count', 1), z('ui.shallow_research_stopped')].join(' · '), '快速研究：完成 2／3 · 失敗 1 · 已停止');
  assert.equal(z('ui.multi_research_progress', 1, 5), '研究中：完成 1／5'); assert.equal(z('ui.retry_failed_topics', 2), '重試失敗的議題（2）'); assert.equal(z('ui.dismiss'), '關閉');
  const x = await nodeBadgeHarness('en', 'fail');
  x.release.get(x.b.id)(); await until(() => x.h.plugin.expansionBatches.get(x.parent.path).failedPaths.length === 1);
  x.paint(); assert.ok(x.spans.some(s => s.text === '1 failed'), x.text());
  x.h.plugin.expansionCoordinator.stop(x.parent.path); x.release.get(x.a.id)(); x.release.get(x.c.id)();
  await until(() => x.h.plugin.expansionBatches.get(x.parent.path).status === 'stopped');
  x.paint(); assert.ok(x.spans.some(s => s.text === 'Quick research: 0 of 3 done · 1 failed · stopped'), x.text());
  assert.ok(x.buttons.some(b => b.text === 'Retry failed topics (1)'));
});
integrationTest('shallow research badge in English: running, finished with a failure, and retry only when not running', async () => {
  const x = await nodeBadgeHarness('en', 'fail');
  x.paint(); assert.ok(x.spans.some(s => s.text === 'Quick research: 0 of 3 done · researching: A'), x.text());
  assert.equal(x.buttons.some(b => /^Retry failed topics/.test(b.text)), false);
  x.release.get(x.b.id)(); await until(() => x.h.plugin.expansionBatches.get(x.parent.path).failedPaths.length === 1);
  x.paint(); assert.ok(x.spans.some(s => s.text === 'Quick research: 0 of 3 done · 1 failed · researching: A'), x.text());
  assert.equal(x.buttons.some(b => /^Retry failed topics/.test(b.text)), false, 'no retry while running');
  x.release.get(x.a.id)(); x.release.get(x.c.id)(); await until(() => x.h.plugin.expansionBatches.get(x.parent.path).status === 'completed');
  x.paint(); assert.ok(x.spans.some(s => s.text === 'Quick research: 2 of 3 done · 1 failed'), x.text());
  assert.ok(x.buttons.some(b => b.text === 'Retry failed topics (1)'));
  x.h.view.map.nodes = x.h.view.map.nodes.filter(n => n.id !== x.b.id); x.paint();
  assert.equal(x.buttons.some(b => /^Retry failed topics/.test(b.text)), false, 'failed topic removed from the map');
});
integrationTest('retry failed topics selects exactly them, opens the modal and starts only them with the chosen model', async () => {
  const x = await nodeBadgeHarness('en', 'fail'); const h = x.h;
  x.release.get(x.a.id)(); x.release.get(x.b.id)(); x.release.get(x.c.id)(); await until(() => h.plugin.expansionBatches.get(x.parent.path).status === 'completed');
  h.view.notes.set(x.b.id, { title: 'B', status: 'error', summary: '' });
  x.paint(); x.buttons.find(b => /^Retry failed topics/.test(b.text)).listeners.click({ stopPropagation() {} });
  assert.deepEqual(plain([...h.view.multiSelected]), [x.b.id]); assert.equal(h.opened.length, 1); assert.deepEqual(plain(h.opened[0].names), ['B']);
  assert.ok(h.plugin.expansionBatches.has(x.parent.path), 'old state kept until the retry starts');
  h.opened[0].submit({ ...h.request, model: 'model-b' });
  await until(() => h.runs.length === 1); assert.equal(h.runs[0].title, 'B'); assert.deepEqual(plain(h.confirms), ['model-b']);
  assert.equal((await h.repo.readNote(x.b.path)).model, 'model-b');
  assert.equal(h.plugin.expansionBatches.has(x.parent.path), false, 'old failure state cleared');
  h.finish.get('B')(); await until(() => h.plugin.expansionBatches.get(h.key).status === 'completed');
});
integrationTest('multi research status bar stays after failures with retry and dismiss, and hides without failures', async () => {
  const h = await multiResearchHarness(['A', 'B', 'C']);
  h.view.notes = new Map(h.nodes.map((n, i) => [n.id, { title: 'ABC'[i], status: 'completed', summary: '' }]));
  const spans = [], buttons = []; const bar = () => { spans.length = 0; buttons.length = 0; const root = badgeElement(spans, buttons); h.view.renderMultiResearchStatus(root); return root; };
  h.view.multiSelected = new Set(h.nodes.map(n => n.id)); await h.view.startMultiResearch(h.request); await until(() => h.runs.length === 3);
  h.finish.get('A')(); h.finish.get('B')('Selected model is at capacity'); h.finish.get('C')();
  await until(() => h.plugin.expansionBatches.get(h.key).status === 'completed');
  bar(); assert.ok(spans.some(s => /Research finished: 2 of 3 done · 1 failed/.test(s.text)), spans.map(s => s.text).join('|'));
  const retry = buttons.find(b => b.text === 'Retry failed topics (1)'); assert.ok(retry); const dismiss = buttons.find(b => b.attrs['aria-label'] === 'Dismiss'); assert.ok(dismiss);
  retry.listeners.click({ stopPropagation() {} }); assert.deepEqual(plain([...h.view.multiSelected]), [h.nodes[1].id]); assert.deepEqual(plain(h.opened[0].names), ['B']);
  dismiss.listeners.click({ stopPropagation() {} }); assert.equal(h.plugin.expansionBatches.has(h.key), false);
  const clean = await multiResearchHarness(['A']); clean.view.notes = new Map(clean.nodes.map(n => [n.id, { title: n.id, status: 'completed', summary: '' }]));
  clean.view.multiSelected = new Set([clean.nodes[0].id]); await clean.view.startMultiResearch(clean.request); await until(() => clean.runs.length === 1);
  clean.finish.get('A')(); await until(() => clean.plugin.expansionBatches.get(clean.key).status === 'completed');
  const root = badgeElement(); clean.view.renderMultiResearchStatus(root); assert.equal(root.children.length, 0);
});
async function staleModelView(sources, askModel) {
  const { repo, app } = fixture(); repo.settings.cliModel = 'claude:sonnet';
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md', mapDoc = { id: 'map-a', title: 'map-a', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  await repo.ensureTopicFolders('Agent Workspace/Topics/map-a'); await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const nodes = [];
  for (const [index, [source, model]] of sources.entries()) { const created = await repo.createNote(`T${index}`, model ?? 'gpt-5.6-luna', mapDoc, mapPath, source); created.parentId = index ? nodes[index - 1].id : null; mapDoc.nodes.push(created); nodes.push(created); }
  await repo.saveMap(mapPath, mapDoc);
  const plugin = withExpansionCoordinator({ repo, settings: { ...DEFAULT_SETTINGS, cliModel: 'claude:sonnet' }, running: new Set(), abortChartJobs: () => {}, addChartsAfterWrite: () => {}, pendingSuggestions: new Map(), pendingResearchOptions: new Map(), rebuildDerivedData: async () => {}, mutate: async work => work(), askModel });
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.contentEl = { querySelector: () => null }; view.render = () => {}; view.hydrate = async () => {}; view.focusNode = () => {}; view.ancestorContext = async () => '';
  return { repo, view, nodes, mapDoc };
}
integrationTest('expand and integrate call the runtime with the resolved model, not the stale stored snapshot', async () => {
  const models = [];
  const f = await staleModelView([['workspace'], ['workspace']], async (_context, model) => { models.push(model); return { summary: '', detail: '', visualReferences: [], suggestions: [{ title: 'S', task: 'Explore', contribution: '', parentTitle: '' }] }; });
  const options = { researchMode: 'local', researchDepth: 'fast', visualMode: 'off', referenceGroups: [] };
  await f.view.proposeChildren(f.nodes[0], options, '', () => {}, message => assert.fail(message));
  await f.view.proposeIntegrationDirections(f.nodes[0], options, () => {}, message => assert.fail(message));
  assert.deepEqual(plain(models), ['claude:sonnet', 'claude:sonnet']);
});
integrationTest('expand under a manual ancestor runs on the manual model; a new subtopic of a manual topic inherits it', async () => {
  const models = [];
  const f = await staleModelView([['manual', 'claude:haiku'], ['inherited']], async (_context, model) => { models.push(model); return { summary: '', detail: '', visualReferences: [], suggestions: [{ title: 'S', task: 'Explore', contribution: '', parentTitle: '' }] }; });
  await f.view.proposeChildren(f.nodes[1], { researchMode: 'local', researchDepth: 'fast', visualMode: 'off', referenceGroups: [] }, '', () => {}, message => assert.fail(message));
  assert.deepEqual(plain(models), ['claude:haiku']);
  await f.view.addNode(f.mapDoc.nodes[1], 'Fresh child');
  const added = f.view.map.nodes.at(-1), note = await f.repo.readNote(added.path);
  assert.equal(note.modelSource, 'inherited'); assert.equal(note.model, 'claude:haiku');
  const workspaceParent = await staleModelView([['workspace']], async () => ({}));
  await workspaceParent.view.addNode(workspaceParent.mapDoc.nodes[0], 'Fresh child');
  assert.equal((await workspaceParent.repo.readNote(workspaceParent.view.map.nodes.at(-1).path)).model, 'claude:sonnet');
});
integrationTest('hydrate resolves inherited models from the loaded map without scanning maps per node', async () => {
  const f = await staleModelView([['workspace'], ['manual', 'claude:haiku'], ['inherited'], ['inherited']], async () => ({}));
  let mapReads = 0, scans = 0;
  const readMap = f.repo.readMap.bind(f.repo), mapFiles = f.repo.mapFiles.bind(f.repo);
  f.repo.readMap = async path => { mapReads++; return readMap(path); };
  f.repo.mapFiles = async () => { scans++; return mapFiles(); };
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  f.view.builtIn = false; f.view.hydrateFailedReportTargets = async () => {};
  await VisualAgentMapView.prototype.hydrate.call(f.view);
  assert.equal(mapReads, 0); assert.equal(scans, 0);
  assert.deepEqual(plain(f.mapDoc.nodes.map(n => f.view.notes.get(n.id).model)), ['claude:sonnet', 'claude:haiku', 'claude:haiku', 'claude:haiku']);
});
integrationTest('map action: one default note style sets or clears the template and tone together; AIM keeps its tone-only entry', async () => {
  const opened = [];
  const h = await templateHarness({ language: 'en', settings: { detailTemplates: sampleTemplates() } });
  const { VisualAgentMapView } = load('main.ts', { obsidian: { ...obsidian, Modal: class { constructor() {} open() { opened.push(this); } close() {} }, Notice: class {} } });
  const view = new VisualAgentMapView({ app: h.app }, h.plugin); view.path = h.mapPath; view.map = h.doc; view.render = () => {}; view.enqueue = work => work();
  view.chooseMapStyle();
  let modal = opened.at(-1);
  assert.equal(modal.titleText, 'Default note style for this map'); assert.equal(modal.description, 'New topics, and topics without their own style, use it.');
  assert.deepEqual(plain(modal.choices.map(choice => choice.label)), ['Use the default (Standard)', 'Standard (academic)', 'Textbook (intro, then sections)', 'Key points', 'Plain language', 'Practical guide', 'Custom…']);
  assert.deepEqual(plain(modal.choices.map(choice => choice.description ?? '')), ['Current setting', '', '', '', '', '', 'Pick the template and tone separately'], 'no value stored: the default is current');
  await modal.choices[2].action();
  await until(async () => (await h.repo.readMap(h.mapPath)).detailTemplateId === 'textbook');
  let saved = await h.repo.readMap(h.mapPath);
  assert.equal(saved.detailTemplateId, 'textbook'); assert.equal(saved.toneId, 'academic', 'a preset always stores both values');
  view.chooseMapStyle(); modal = opened.at(-1);
  assert.deepEqual(plain(modal.choices.map(choice => choice.description ?? '')), ['', '', 'Current setting', '', '', '', 'Pick the template and tone separately'], 'the matching preset is marked');
  await modal.choices[3].action();
  await until(async () => (await h.repo.readMap(h.mapPath)).toneId === 'summary');
  saved = await h.repo.readMap(h.mapPath);
  assert.equal(saved.detailTemplateId, 'standard'); assert.equal(saved.toneId, 'summary');
  // A pair that is not a preset is marked on Custom….
  await h.repo.updateMap(h.mapPath, map => { map.detailTemplateId = 'A'; map.toneId = 'magazine'; }); view.map = await h.repo.readMap(h.mapPath);
  view.chooseMapStyle(); modal = opened.at(-1);
  assert.deepEqual(plain(modal.choices.map(choice => choice.description ?? '')), ['', '', '', '', '', '', 'Current setting']);
  // Custom… opens a small dialog with the two original pickers.
  const before = opened.length; modal.choices[6].action();
  const custom = opened.at(-1); assert.equal(opened.length, before + 1);
  assert.deepEqual(plain(custom.choices.map(choice => choice.label)), ['Default content template for this map', 'Default writing tone for this map']);
  custom.choices[0].action(); assert.equal(opened.at(-1).titleText, 'Default content template for this map');
  custom.choices[1].action(); assert.equal(opened.at(-1).titleText, 'Default writing tone for this map');
  // Default clears both.
  view.chooseMapStyle(); await opened.at(-1).choices[0].action();
  await until(async () => (await h.repo.readMap(h.mapPath)).toneId === undefined);
  saved = await h.repo.readMap(h.mapPath);
  assert.equal(saved.detailTemplateId, undefined); assert.equal(saved.toneId, undefined);
});
integrationTest('Keep current (…) names the effective style: topic, then map, then default for the tone; a preset or "Custom: template · tone"', async () => {
  const h = await templateHarness({ language: 'en', settings: { detailTemplates: sampleTemplates() } });
  const { VisualAgentMapView } = load('main.ts', { obsidian: { ...obsidian, Notice: class {} } });
  const view = new VisualAgentMapView({ app: h.app }, h.plugin); view.path = h.mapPath; view.map = { ...h.doc };
  assert.equal(view.effectiveToneId({}), 'academic');
  view.map.toneId = 'plain'; assert.equal(view.effectiveToneId({}), 'plain');
  assert.equal(view.effectiveToneId({ toneId: 'guide' }), 'guide', 'the topic wins over the map');
  assert.equal(view.effectiveToneId({ toneId: 'gone' }), 'plain', 'an unknown topic tone falls through like toneLabelFor');
  assert.equal(view.currentStyleLabel('standard', 'academic'), 'Standard');
  assert.equal(view.currentStyleLabel('textbook', 'academic'), 'Textbook');
  assert.equal(view.currentStyleLabel('standard', 'plain'), 'Plain language');
  assert.equal(view.currentStyleLabel('A', 'magazine'), 'Custom: Template A · Magazine column');
  assert.equal(view.currentStyleLabel('textbook', 'plain'), 'Custom: Textbook · Plain explanation');
});

// ---- S2: the chart step runs after the write, in the background, on all three write paths.
const CHART_BLOCK = '\n\n```mermaid\nflowchart TD\nA["x"] --> B["y"]\n```';
integrationTest('S2: runAgent queues the chart step after the write (aborting that path first); applying it is its own undo entry', async () => {
  const h = await templateHarness({ language: 'en', reply: () => ({ summary: 'Sum', detail: 'Body paragraph.', visualReferences: [], suggestions: [] }) });
  await h.run();
  assert.deepEqual(plain(h.chartAborts), [h.topic.path], 'a new run aborts that path\'s earlier chart job first');
  assert.equal(h.chartJobs.length, 1);
  const [job] = h.chartJobs;
  assert.equal(job.path, h.topic.path); assert.equal(job.context.addCharts, true); assert.equal(job.context.mode, 'task'); assert.equal(job.model, (await h.repo.readNote(h.topic.path)).model, 'the chart step uses the topic\'s own model');
  const written = (await h.repo.readNote(h.topic.path)).detail;
  assert.match(written, /Body paragraph/); assert.doesNotMatch(written, /mermaid/);
  assert.equal(job.detail, written, 'the chart step sees the detail exactly as written');
  const runEntry = h.view.history.undoEntry;
  assert.equal(await job.apply(written + CHART_BLOCK), true);
  assert.match((await h.repo.readNote(h.topic.path)).detail, /```mermaid/);
  assert.notEqual(h.view.history.undoEntry, runEntry, 'the diagrams are a separate history entry');
  await h.view.history.undo().undo();
  const afterUndo = await h.repo.readNote(h.topic.path);
  assert.equal(afterUndo.detail, written, 'undo removes only the diagrams'); assert.equal(afterUndo.status, 'completed');
});
integrationTest('S2: diagrams are dropped when the note changed after the write or a run is active on it', async () => {
  const h = await templateHarness({ language: 'en', reply: () => ({ summary: 'Sum', detail: 'Body paragraph.', visualReferences: [], suggestions: [] }) });
  await h.run();
  const [job] = h.chartJobs, written = (await h.repo.readNote(h.topic.path)).detail;
  await h.repo.updateNote(h.topic.path, { summary: 'Edited by the user' });
  assert.equal(await job.apply(written + CHART_BLOCK), false, 'stale: the note no longer equals its snapshot at write time');
  assert.equal((await h.repo.readNote(h.topic.path)).detail, written);
  const again = await templateHarness({ language: 'en', reply: () => ({ summary: 'Sum', detail: 'Body paragraph.', visualReferences: [], suggestions: [] }) });
  await again.run();
  again.plugin.running.add(again.topic.path);
  assert.equal(await again.chartJobs[0].apply((await again.repo.readNote(again.topic.path)).detail + CHART_BLOCK), false, 'a path that is running again is not touched');
  assert.doesNotMatch((await again.repo.readNote(again.topic.path)).detail, /mermaid/);
});
integrationTest('S2: a stopped or failed research run queues no chart job', async () => {
  const h = await templateHarness({ language: 'en', reply: () => { throw new Error('provider down'); } });
  await h.run();
  assert.equal(h.chartJobs.length, 0);
});
integrationTest('S2: child synthesis and multi-topic synthesis queue the chart step after their write', async () => {
  const h = await templateHarness({ language: 'en', reply: () => ({ summary: 'Synth', detail: 'Merged paragraph.', visualReferences: [], suggestions: [] }) });
  const child = await h.repo.createNote('Child', 'model-a', h.doc, h.mapPath, 'workspace'); child.parentId = h.topic.id; h.doc.nodes.push(child); await h.repo.saveMap(h.mapPath, h.doc);
  await h.repo.updateNote(h.topic.path, { status: 'completed' });
  const options = () => ({ researchMode: 'local', researchDepth: 'normal', visualMode: 'off', referenceGroups: [] });
  await h.view.startSynthesis(h.topic, options(), null, message => assert.fail(message), () => {});
  await h.view.startSynthesis(h.topic, options(), 'Compare them', message => assert.fail(message), () => {});
  assert.deepEqual(plain(h.chartAborts), [h.topic.path], 'the synthesis start aborts that path\'s chart job');
  assert.equal(h.chartJobs.length, 1);
  assert.equal(h.chartJobs[0].path, h.topic.path); assert.equal(h.chartJobs[0].context.mode, 'synthesize');
  const parentDetail = (await h.repo.readNote(h.topic.path)).detail;
  assert.equal(h.chartJobs[0].detail, parentDetail);
  assert.equal(await h.chartJobs[0].apply(parentDetail + CHART_BLOCK), true);
  assert.match((await h.repo.readNote(h.topic.path)).detail, /```mermaid/);
  const other = await h.repo.createNote('Other', 'model-a', h.doc, h.mapPath, 'workspace'); h.doc.nodes.push(other); await h.repo.saveMap(h.mapPath, h.doc);
  await h.view.createIntegratedNode('Combined', [h.topic, other], 'Compare', '');
  assert.equal(h.chartJobs.length, 2);
  const saved = await h.repo.readMap(h.mapPath), integrated = saved.nodes.at(-1);
  assert.equal(h.chartJobs[1].path, integrated.path); assert.equal(h.chartJobs[1].context.mode, 'synthesize');
  const written = (await h.repo.readNote(integrated.path)).detail;
  assert.equal(h.chartJobs[1].detail, written);
  assert.equal(await h.chartJobs[1].apply(written + CHART_BLOCK), true);
  assert.match((await h.repo.readNote(integrated.path)).detail, /```mermaid/);
});

// ---- S7: quick research of AI-expanded subtopics reads local context only unless the dialog's checkbox is on.
integrationTest('S7: expansion shallow research defaults to local and no images; the checkbox restores the dialog choices; stored mode stays research', async () => {
  const { repo, app } = fixture('en'), parent = await topicNote(repo, 'Parent', 'model-a');
  const mapPath = 'Agent Workspace/Topics/map-s7/Map.md', mapDoc = map([parent]); mapDoc.id = 'map-s7';
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const runs = [];
  const plugin = withExpansionCoordinator({ repo, settings: { ...DEFAULT_SETTINGS, language: 'en' }, running: new Set(), abortChartJobs: () => {}, addChartsAfterWrite: () => {}, pendingSuggestions: new Map(), pendingResearchOptions: new Map(), rebuildDerivedData: async () => {}, mutate: async work => work(), recordFailure: (_context, error) => error.message });
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.contentEl = { querySelector: () => null }; view.render = () => {}; view.hydrate = async () => {};
  view.runAgent = async (_child, _done, _failed, overrides, accepted) => { runs.push({ researchMode: overrides.researchMode, visualMode: overrides.visualMode }); accepted?.(); return { finished: Promise.resolve() }; };
  const dialog = { researchMode: 'research', researchDepth: 'fast', visualMode: 'auto', referenceGroups: [], shallowResearch: true, outputLanguage: 'en' };
  const children = await view.createChildBatch(parent, [{ title: 'One', task: 'Why one?', contribution: '' }], dialog);
  const stored = await repo.readNote(children[0].path);
  assert.equal(stored.researchMode, 'research', 'the child note keeps research as its own mode'); assert.equal(stored.visualMode, 'auto');
  await view.startShallowResearch(parent, children, view.shallowChildOptions(dialog));
  await until(() => plugin.expansionBatches.get(parent.path).status !== 'running');
  assert.deepEqual(plain(runs), [{ researchMode: 'local', visualMode: 'off' }]);
  assert.equal(view.shallowChildOptions({ ...dialog, shallowWebSearch: true }).researchMode, 'research');
  assert.equal(view.shallowChildOptions({ ...dialog, shallowWebSearch: true }).visualMode, 'auto');
  // Outline import (not AI expansion) keeps passing the options through startShallowResearch unchanged.
  runs.length = 0;
  const second = await view.createChildBatch(parent, [{ title: 'Two', task: 'Why two?', contribution: '' }], dialog);
  await view.startShallowResearch(parent, second, dialog);
  await until(() => plugin.expansionBatches.get(parent.path).status !== 'running');
  assert.deepEqual(plain(runs), [{ researchMode: 'research', visualMode: 'auto' }]);
});

// ---- Segment B: research progress on the card, the unsaved preview and its clearing ----
async function progressHarness(askModel) {
  const h = await templateHarness({ language: 'en' });
  const { ResearchProgressStore } = load('experiences/visual-map/research-progress.ts');
  const store = new ResearchProgressStore();
  h.plugin.researchProgress = store;
  h.plugin.askModel = async (context, model, reasoning, signal, onExchange, onAccepted, onWeb, observer) => { onAccepted?.(); return askModel({ context, signal, observer, store, h }); };
  return { ...h, store, noteNow: () => h.repo.readNote(h.topic.path) };
}
const FINAL = { summary: 'Final summary', detail: 'Final detail', visualReferences: [], suggestions: [] };
integrationTest('S5: stage, preview and slow notice reach the store while the run is open; nothing is written before success, and the preview ends with the run', async () => {
  const seen = [];
  const h = await progressHarness(async ({ observer, store, h: harness }) => {
    observer.onAttempt('a1', 1); observer.onStage('a1', 'searching', 'synthetic query'); observer.onSlow('a1', true, () => seen.push('resend'));
    observer.onPreview('a1', { summary: 'Unsaved summary', detail: 'x'.repeat(900) + 'TAIL' });
    const entry = JSON.parse(JSON.stringify(store.get(harness.topic.path)));
    seen.push(entry, (await harness.repo.readNote(harness.topic.path)).detail, (await harness.repo.readNote(harness.topic.path)).summary);
    store.get(harness.topic.path).resend();
    return FINAL;
  });
  const before = await h.noteNow();
  await h.run();
  const [entry, detailDuring, summaryDuring] = seen;
  assert.equal(entry.stage, 'searching'); assert.equal(entry.query, 'synthetic query'); assert.equal(entry.slow, true); assert.equal(entry.preview.summary, 'Unsaved summary');
  assert.equal(entry.preview.detailTail.length, 600); assert.ok(entry.preview.detailTail.endsWith('TAIL'));
  assert.equal(detailDuring, before.detail, 'the note is not written before the final result'); assert.equal(summaryDuring, before.summary);
  assert.equal(seen[3], 'resend');
  assert.equal(h.store.get(h.topic.path), undefined, 'the entry (and its preview) is gone when the run ends');
  const after = await h.noteNow(); assert.match(after.detail, /Final detail/); assert.equal(after.summary, 'Final summary');
});
integrationTest('S5: Stop, a stale note and a parse failure all clear the preview and write nothing', async () => {
  for (const scenario of ['stop', 'stale', 'parse']) {
    const h = await progressHarness(async ({ observer, signal, store, h: harness }) => {
      observer.onAttempt('a1', 1); observer.onPreview('a1', { summary: 'Unsaved', detail: 'Unsaved detail' });
      assert.equal(store.get(harness.topic.path).preview.summary, 'Unsaved');
      if (scenario === 'stop') { harness.plugin.activeTasks.get(harness.topic.path).abort(); throw Object.assign(new Error('cancelled'), { name: 'AbortError' }); }
      if (scenario === 'stale') { await harness.repo.updateNote(harness.topic.path, { prompt: 'The user edited the question' }); return FINAL; }
      throw new Error('The reply could not be parsed');
    });
    const before = await h.noteNow();
    const warn = console.error; console.error = () => {};
    try { await h.run(); } finally { console.error = warn; }
    assert.equal(h.store.get(h.topic.path), undefined, `${scenario}: preview cleared`);
    const after = await h.noteNow();
    assert.equal(after.detail, before.detail, `${scenario}: nothing written`); assert.equal(after.summary, before.summary);
    assert.notEqual(after.summary, 'Unsaved');
  }
});
integrationTest('S5: a closed view does not stop the run from clearing its progress, and a chart step that took over the entry keeps it', async () => {
  const h = await progressHarness(async ({ observer, h: harness }) => { observer.onAttempt('a1', 1); harness.view.closed = true; return FINAL; });
  await h.run();
  assert.equal(h.store.get(h.topic.path), undefined);
  const charts = await progressHarness(async () => FINAL);
  charts.plugin.addChartsAfterWrite = job => { charts.store.begin(job.path, 'charts-1', Date.now()); charts.store.stage(job.path, 'charts-1', 'charts', Date.now()); };
  await charts.run();
  assert.equal(charts.store.get(charts.topic.path).stage, 'charts', 'ending the research run does not remove the chart stage');
});
test('S4: card helpers show the stage text, tick the seconds as text only and the hover preview is plain text', () => {
  let interval = null; const cleared = [];
  const { VisualAgentMapView } = load('main.ts', { obsidian }, { setInterval: fn => { interval = fn; return 7; }, clearInterval: id => cleared.push(id) });
  const view = new VisualAgentMapView({ app: {} }, { settings: { ...DEFAULT_SETTINGS, language: 'en' } });
  assert.equal(view.researchStageText({ stage: 'searching', query: 'synthetic query' }), 'Searching: synthetic query');
  assert.equal(view.researchStageText({ stage: 'searching' }), 'Searching');
  assert.deepEqual(['waiting', 'reading', 'writing', 'charts'].map(stage => view.researchStageText({ stage })), ['Waiting for the model', 'Reading sources', 'Writing', 'Adding diagrams']);
  const el = { isConnected: true, text: '', setText(value) { this.text = value; } };
  view.trackResearchElapsed(el, Date.now() - 65_000);
  interval(); assert.match(el.text, /1:0[4-6]/);
  el.isConnected = false; interval();
  assert.deepEqual(cleared, [7], 'the tick stops when no seconds are left on screen');
  const block = { hidden: true }, summary = { setText(v) { this.text = v; } }, detail = { setText(v) { this.text = v; } };
  view.hoverCard = {}; view.hoverResearch = { path: 'a.md', block, summary, detail };
  view.plugin = { researchProgress: { get: () => ({ preview: { summary: '**raw** markdown stays literal', detailTail: 'tail' } }) } };
  view.paintHoverResearch();
  assert.equal(block.hidden, false); assert.equal(summary.text, '**raw** markdown stays literal'); assert.equal(detail.text, 'tail');
  view.plugin = { researchProgress: { get: () => ({}) } }; view.paintHoverResearch();
  assert.equal(block.hidden, true, 'no preview, no block');
});

function fakeCardDom() {
  class El {
    constructor(cls) { this.cls = new Set(cls ? cls.split(' ') : []); this.kids = []; this.text = ''; this.parent = null; this.renders = 0; }
    addClass(c) { this.cls.add(c); } removeClass(c) { this.cls.delete(c); } hasClass(c) { return this.cls.has(c); }
    empty() { this.kids = []; this.text = ''; }
    setText(v) { this.kids = []; this.text = v; }
    createEl(_tag, o = {}) { const e = new El(o.cls); e.text = o.text ?? ''; e.parent = this; this.kids.push(e); return e; }
    createSpan(o = {}) { return this.createEl('span', o); }
    after(e) { this.parent.kids = this.parent.kids.filter(k => k !== e); this.parent.kids.splice(this.parent.kids.indexOf(this) + 1, 0, e); e.parent = this.parent; }
    remove() { this.parent.kids = this.parent.kids.filter(k => k !== this); }
    querySelector(sel) { const c = sel.slice(1); for (const k of this.kids) { if (k.cls.has(c)) return k; const d = k.querySelector(sel); if (d) return d; } return null; }
    get all() { return this.kids.length ? this.kids.map(k => k.all).join('|') : this.text; }
  }
  return El;
}
test('S5: the card itself shows the unsaved summary preview as plain text, never renders, and returns to the stored summary', () => {
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const { ResearchProgressStore } = load('experiences/visual-map/research-progress.ts');
  const El = fakeCardDom();
  const view = new VisualAgentMapView({ app: {} }, { settings: { ...DEFAULT_SETTINGS, language: 'en' } });
  const store = new ResearchProgressStore();
  view.plugin = { researchProgress: store, settings: { ...DEFAULT_SETTINGS, language: 'en' } };
  const card = new El('vam-node'); const title = card.createEl('h3', { cls: 'vam-card-title', text: 'T' });
  const stored = card.createEl('p', { cls: 'vam-card-summary', text: 'Stored summary' });
  view.map = { nodes: [{ id: 'n1', path: 'a.md' }] }; view.cardEls = new Map([['n1', card]]); view.notes = new Map([['n1', { summary: 'Stored summary' }]]);
  let renders = 0; view.render = () => { renders++; }; view.renderPreservingFocus = () => { renders++; };
  store.begin('a.md', 'x1', 1);
  store.preview('a.md', 'x1', { summary: '**raw** streaming' });
  view.paintCardPreview('a.md');
  const shown = card.querySelector('.vam-card-summary');
  assert.equal(shown, stored, 'same element is reused: text only, no re-render');
  assert.ok(shown.hasClass('is-preview'));
  assert.equal(shown.querySelector('.vam-card-preview-label').text, 'Preview (not saved yet)');
  assert.equal(shown.querySelector('.vam-card-preview-text').text, '**raw** streaming');
  assert.equal(shown.querySelector('.vam-card-preview-text').text.includes('Stored'), false);
  // a longer preview only changes the text
  store.preview('a.md', 'x1', { summary: '**raw** streaming more' }); view.paintCardPreview('a.md');
  assert.equal(shown.querySelector('.vam-card-preview-text').text, '**raw** streaming more');
  assert.equal(renders, 0, 'no render() for preview text');
  // retraction / failure: preview gone, the stored summary is back
  store.preview('a.md', 'x1', {}); view.paintCardPreview('a.md');
  assert.equal(shown.hasClass('is-preview'), false); assert.equal(shown.text, 'Stored summary');
  // a card without a stored summary (placeholder) gets one only while previewing
  view.notes = new Map([['n1', { summary: 'No conclusion yet' }]]);
  const bare = new El('vam-node'); bare.createEl('h3', { cls: 'vam-card-title', text: 'T' }); view.cardEls = new Map([['n1', bare]]);
  store.preview('a.md', 'x1', { summary: 'Live' }); view.paintCardPreview('a.md');
  assert.equal(bare.querySelector('.vam-card-preview-text').text, 'Live');
  store.end('a.md'); view.paintCardPreview('a.md');
  assert.equal(bare.querySelector('.vam-card-summary'), null, 'Stop or failure removes the preview and leaves no stored summary to show');
  assert.equal(renders, 0);
});
test('S5: the card preview is not a live region and the throttle keeps updates to one per 200 ms', () => {
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const { ResearchProgressStore } = load('experiences/visual-map/research-progress.ts');
  const El = fakeCardDom();
  const view = new VisualAgentMapView({ app: {} }, { settings: { ...DEFAULT_SETTINGS, language: 'en' } });
  let now = 0; const timers = [];
  const store = new ResearchProgressStore({ now: () => now, setTimeout: (f, ms) => { timers.push({ f, ms }); return timers.length; }, clearTimeout: () => {} });
  view.plugin = { researchProgress: store, settings: { ...DEFAULT_SETTINGS, language: 'en' } };
  const card = new El('vam-node'); card.createEl('h3', { cls: 'vam-card-title', text: 'T' }); card.createEl('p', { cls: 'vam-card-summary', text: 'S' });
  view.map = { nodes: [{ id: 'n1', path: 'a.md' }] }; view.cardEls = new Map([['n1', card]]); view.notes = new Map([['n1', { summary: 'S' }]]);
  let notified = 0; store.subscribe(() => notified++);
  store.begin('a.md', 'x1', 0); notified = 0;
  for (let i = 0; i < 20; i++) { now += 10; store.preview('a.md', 'x1', { summary: 'word '.repeat(i + 1) }); }
  assert.equal(notified, 0, 'twenty deltas inside the 200 ms window are held back');
  assert.equal(timers.length, 1, 'one pending timer, not one per delta');
  assert.equal(timers[0].ms <= 200, true);
  now = 200; timers[0].f();
  assert.equal(notified, 1, 'one notification carries the latest text');
  assert.equal(store.get('a.md').preview.summary, 'word '.repeat(20));
  view.paintCardPreview('a.md');
  const walk = e => [e, ...e.kids.flatMap(walk)];
  assert.equal(walk(card).some(e => e.live || e.role), false, 'the preview adds no aria-live or role attributes');
});

integrationTest('L4: startShallowResearch wires the chart decision: a local shallow child gets no chart job, a web-enabled one does', async () => {
  for (const [shallowWebSearch, expected] of [[false, false], [true, true]]) {
    const h = await templateHarness({ language: 'en', reply: () => ({ summary: 'Sum', detail: 'Body paragraph.', visualReferences: [], suggestions: [] }) });
    const child = await h.repo.createNote('Child', 'model-a', h.doc, h.mapPath, 'workspace', h.topic.id);
    await h.repo.updateNote(child.path, { prompt: 'Research the child' });
    h.doc.nodes.push(child);
    const dialog = { researchMode: 'research', researchDepth: 'fast', visualMode: 'auto', referenceGroups: [], shallowResearch: true, outputLanguage: 'en', shallowWebSearch };
    await h.view.startShallowResearch(h.topic, [child], h.view.shallowChildOptions(dialog));
    await until(() => h.plugin.expansionBatches.get(h.topic.path).status !== 'running');
    assert.equal(h.contexts.at(-1).researchMode, shallowWebSearch ? 'research' : 'local');
    assert.equal(h.contexts.at(-1).addCharts === true, expected, `web search ${shallowWebSearch}`);
    // The plugin starts a chart step only for a context that asked for charts (chartEligible), so the job's context decides.
    assert.ok(h.chartJobs.length >= 1 && h.chartJobs.every(job => (job.context.addCharts === true) === expected), `chart request carries addCharts=${expected}`);
    const { AiTaskService } = load('core/ai-task-service.ts');
    const service = new AiTaskService({ pluginDirectory: () => '', language: () => 'en', defaultReasoning: () => 'low', exchangeLoggingEnabled: () => false, exchanges: () => null, codexRuntime: () => null, claudeRuntime: () => null });
    assert.equal(service.chartEligible(h.contexts.at(-1)), expected, 'chartEligible follows the context');
  }
});
// ---- Plan E W2: stage, seconds and unsaved preview for child synthesis, multi-select synthesis and AI merge ----
async function synthesisProgressHarness(askModel) {
  const h = await templateHarness({ language: 'en' });
  const { ResearchProgressStore } = load('experiences/visual-map/research-progress.ts');
  const store = new ResearchProgressStore();
  h.plugin.researchProgress = store;
  const child = await h.repo.createNote('Child', 'model-a', h.doc, h.mapPath, 'workspace'); child.parentId = h.topic.id; h.doc.nodes.push(child); await h.repo.saveMap(h.mapPath, h.doc);
  const other = await h.repo.createNote('Other', 'model-a', h.doc, h.mapPath, 'workspace'); h.doc.nodes.push(other); await h.repo.saveMap(h.mapPath, h.doc);
  await h.repo.updateNote(h.topic.path, { status: 'completed' });
  const atWrite = [], realMutate = h.plugin.mutate;
  h.plugin.mutate = async work => { atWrite.push({ topic: store.get(h.topic.path), integration: store.get(`vam-task:integration:${h.mapPath}`) }); return realMutate(work); };
  let full;
  h.plugin.askModel = async (context, model, reasoning, signal, onExchange, onAccepted, onWeb, observer) => { h.contexts.push(context); onAccepted?.(); return askModel({ context, signal, observer, store, h: full, calls: h.contexts.length }); };
  const options = () => ({ researchMode: 'local', researchDepth: 'normal', visualMode: 'off', referenceGroups: [] });
  const topicState = async () => { const note = await h.repo.readNote(h.topic.path); return JSON.stringify([note.summary, note.detail, note.status]); };
  const mapShape = async () => JSON.stringify((await h.repo.readMap(h.mapPath)).nodes.map(n => n.path));
  full = { ...h, store, atWrite, options, topicState, mapShape, child, other, key: `vam-task:integration:${h.mapPath}` };
  return full;
}
const SYNTH = { summary: 'Synth summary', detail: '### Core conclusions\n\nTwo', visualReferences: [], suggestions: [] };
const DIRECTIONS = { summary: '', detail: '', visualReferences: [], suggestions: [{ title: 'Angle', task: 'Compare them', contribution: '', parentTitle: '' }] };
integrationTest('W2a: child synthesis shows stage and preview on the topic, writes nothing before success and ends the entry before the write', async () => {
  const seen = [];
  const h = await synthesisProgressHarness(async ({ observer, store, h: harness, calls }) => {
    assert.ok(observer, 'the synthesis request is observed');
    observer.onAttempt('a1', 1); observer.onStage('a1', 'writing'); observer.onPreview('a1', { summary: 'Unsaved synthesis', detail: 'partial detail' });
    seen.push({ calls, entry: JSON.parse(JSON.stringify(store.get(harness.topic.path))), note: await harness.repo.readNote(harness.topic.path) });
    return calls === 1 ? DIRECTIONS : SYNTH;
  });
  const before = await h.topicState();
  await h.view.startSynthesis(h.topic, h.options(), null, message => assert.fail(message), () => {});
  assert.equal(seen[0].entry.stage, 'writing'); assert.equal(seen[0].entry.preview.summary, 'Unsaved synthesis');
  assert.equal(h.store.get(h.topic.path), undefined, 'directions: entry gone');
  await h.view.startSynthesis(h.topic, h.options(), 'Compare them', message => assert.fail(message), () => {});
  assert.equal(seen[1].entry.preview.summary, 'Unsaved synthesis'); assert.equal(seen[1].note.summary, (JSON.parse(before))[0], 'the note is not written before the result');
  assert.equal(seen[1].note.detail, (JSON.parse(before))[1]);
  assert.equal(h.store.get(h.topic.path), undefined, 'draft: entry gone');
  assert.equal(h.atWrite.every(write => write.topic === undefined), true, 'the preview ended before every write started');
  assert.match((await h.repo.readNote(h.topic.path)).summary, /Synth summary/);
});
integrationTest('W2a: Stop, a stale topic and a failed request all clear the synthesis preview and write nothing', async () => {
  for (const scenario of ['stop', 'stale', 'parse']) {
    const h = await synthesisProgressHarness(async ({ observer, h: harness }) => {
      observer.onAttempt('a1', 1); observer.onPreview('a1', { summary: 'Unsaved', detail: 'Unsaved detail' });
      if (scenario === 'stop') { harness.view.synthesisTasks.get(harness.topic.path).controller.abort(); throw Object.assign(new Error('cancelled'), { name: 'AbortError' }); }
      if (scenario === 'stale') { await harness.repo.updateNote(harness.topic.path, { prompt: 'The user edited the question' }); return SYNTH; }
      throw new Error('The reply could not be parsed');
    });
    const before = await h.topicState();
    const warn = console.error; console.error = () => {};
    try { await h.view.startSynthesis(h.topic, h.options(), 'Compare them', () => {}, () => {}); } finally { console.error = warn; }
    assert.equal(h.store.get(h.topic.path), undefined, `${scenario}: preview cleared`);
    const after = JSON.parse(await h.topicState());
    assert.notEqual(after[0], 'Unsaved'); assert.doesNotMatch(after[1], /Unsaved/);
    if (scenario !== 'stale') assert.equal(after[1], JSON.parse(before)[1], `${scenario}: detail untouched`);
  }
});
integrationTest('W2a: a chart step that takes over the topic entry after the write keeps it, and a closed view still ends the synthesis entry', async () => {
  const charts = await synthesisProgressHarness(async ({ calls }) => (calls === 1 ? DIRECTIONS : SYNTH));
  charts.plugin.addChartsAfterWrite = job => { charts.store.begin(job.path, 'charts-1', Date.now()); charts.store.stage(job.path, 'charts-1', 'charts', Date.now()); };
  await charts.view.startSynthesis(charts.topic, charts.options(), 'Compare them', message => assert.fail(message), () => {});
  assert.equal(charts.store.get(charts.topic.path).stage, 'charts', 'ending the synthesis entry does not remove the chart stage');
  const closed = await synthesisProgressHarness(async ({ observer, h: harness }) => { observer.onAttempt('a1', 1); harness.view.closed = true; return SYNTH; });
  await closed.view.startSynthesis(closed.topic, closed.options(), 'Compare them', () => {}, () => {});
  assert.equal(closed.store.get(closed.topic.path), undefined);
});
integrationTest('W2a: an existing entry on the topic (a chart step still running) is left alone and the request still runs unobserved', async () => {
  const h = await synthesisProgressHarness(async ({ observer, calls }) => { assert.equal(observer, undefined); return calls === 1 ? DIRECTIONS : SYNTH; });
  h.store.begin(h.topic.path, 'charts-9', Date.now()); h.store.stage(h.topic.path, 'charts-9', 'charts', Date.now());
  await h.view.startSynthesis(h.topic, h.options(), null, message => assert.fail(message), () => {});
  assert.equal(h.store.get(h.topic.path).stage, 'charts');
});
integrationTest('W2b: multi-select synthesis (directions and draft) uses a task key, writes nothing before success and ends the entry before the write', async () => {
  const seen = [];
  const h = await synthesisProgressHarness(async ({ observer, store, h: harness, calls }) => {
    assert.ok(observer);
    observer.onAttempt('b1', 1); observer.onStage('b1', 'writing'); observer.onPreview('b1', { summary: `Unsaved ${calls}` });
    seen.push({ calls, entry: JSON.parse(JSON.stringify(store.get(`vam-task:integration:${harness.mapPath}`))), nodes: await harness.mapShape() });
    return calls === 1 ? DIRECTIONS : SYNTH;
  });
  const nodesBefore = await h.mapShape();
  await h.view.startSelectionSynthesis([h.topic, h.other], h.options(), null, message => assert.fail(message), () => {});
  assert.equal(seen[0].entry.stage, 'writing'); assert.equal(seen[0].entry.preview.summary, 'Unsaved 1'); assert.equal(seen[0].nodes, nodesBefore);
  assert.equal(h.store.get(h.key), undefined, 'directions: entry gone');
  h.view.integrationTask = null;
  await h.view.startSelectionSynthesis([h.topic, h.other], { ...h.options(), synthesisTitle: 'Combined' }, 'Compare', message => assert.fail(message), () => {});
  assert.equal(seen[1].entry.preview.summary, 'Unsaved 2'); assert.equal(seen[1].nodes, nodesBefore, 'no node before the result');
  assert.equal(h.store.get(h.key), undefined);
  assert.equal(h.atWrite.length > 0 && h.atWrite.every(write => write.integration === undefined), true, 'ended before the write');
  assert.notEqual(await h.mapShape(), nodesBefore);
});
integrationTest('W2b: multi-select synthesis Stop and a failed request clear the preview and add no topic', async () => {
  for (const scenario of ['stop', 'fail']) {
    const h = await synthesisProgressHarness(async ({ observer, h: harness }) => {
      observer.onAttempt('b1', 1); observer.onPreview('b1', { summary: 'Unsaved' });
      if (scenario === 'stop') { harness.view.integrationTask.controller.abort(); throw Object.assign(new Error('cancelled'), { name: 'AbortError' }); }
      throw new Error('provider down');
    });
    const nodesBefore = await h.mapShape();
    const warn = console.error; console.error = () => {};
    try { await h.view.createIntegratedNode('Combined', [h.topic, h.other], 'Compare', '').catch(() => {}); } finally { console.error = warn; }
    assert.equal(h.store.get(h.key), undefined, `${scenario}: cleared`);
    assert.equal(await h.mapShape(), nodesBefore, `${scenario}: no topic added`);
  }
});
test('W2b: the synthesis and merge status bars show stage and seconds in hidden spans and the unsaved summary in a line outside every live region', () => {
  let interval = null;
  const { VisualAgentMapView } = load('main.ts', { obsidian }, { setInterval: fn => { interval = fn; return 7; }, clearInterval: () => {} });
  const { ResearchProgressStore } = load('experiences/visual-map/research-progress.ts');
  class El {
    constructor(cls) { this.cls = new Set(cls ? cls.split(' ') : []); this.kids = []; this.text = ''; this.attrs = {}; this.parent = null; this.hidden = false; this.isConnected = true; }
    addClass(c) { this.cls.add(c); } removeClass(c) { this.cls.delete(c); } hasClass(c) { return this.cls.has(c); }
    empty() { this.kids = []; this.text = ''; } setText(v) { this.kids = []; this.text = v; } setAttr(k, v) { this.attrs[k] = v; }
    createEl(_tag, o = {}) { const e = new El(o.cls); e.text = o.text ?? ''; Object.assign(e.attrs, o.attr ?? {}); e.parent = this; this.kids.push(e); return e; }
    createSpan(o = {}) { return this.createEl('span', o); } createDiv(o = {}) { return this.createEl('div', typeof o === 'string' ? { cls: o } : o); }
    addEventListener() {}
    querySelector(sel) { const c = sel.slice(1); for (const k of this.kids) { if (k.cls.has(c)) return k; const d = k.querySelector(sel); if (d) return d; } return null; }
  }
  const walk = e => [e, ...e.kids.flatMap(walk)];
  const view = new VisualAgentMapView({ app: {} }, { settings: { ...DEFAULT_SETTINGS, language: 'en' } });
  const store = new ResearchProgressStore();
  const spoken = []; view.announcer = { setText: text => spoken.push(text) }; view.announcedStages = new Map();
  view.plugin = { researchProgress: store, settings: { ...DEFAULT_SETTINGS, language: 'en' } };
  view.path = 'Map.md'; view.map = { nodes: [] }; view.notes = new Map(); view.closed = false; view.stageEl = {};
  let renders = 0; view.scheduleResearchRender = () => { renders++; };
  const key = view.taskProgressKey('merge'); assert.equal(key, 'vam-task:merge:Map.md'); assert.ok(key.includes(':'), 'cannot collide with a Vault path');
  store.begin(key, 'x', Date.now()); view.onResearchProgress(key);
  assert.equal(renders, 1, 'a new entry redraws the bar once');
  const parent = new El('root'); const bar = parent.createDiv({ cls: 'vam-aim-statusbar', attr: { 'aria-live': 'polite' } });
  view.renderTaskProgress(bar, parent, key);
  const stage = bar.querySelector('.vam-research-stage'), elapsed = bar.querySelector('.vam-research-elapsed');
  assert.equal(stage.text, 'Waiting for the model'); assert.equal(stage.attrs['aria-hidden'], 'true'); assert.equal(elapsed.attrs['aria-hidden'], 'true');
  const preview = parent.querySelector('.vam-task-preview');
  assert.equal(preview.parent, parent, 'a sibling of the live bar'); assert.equal(walk(bar).includes(preview), false, 'not inside the live region');
  assert.equal(walk(preview).some(e => e.attrs['aria-live'] || e.attrs.role), false); assert.equal(preview.hidden, true);
  store.stage(key, 'x', 'writing', Date.now()); view.onResearchProgress(key);
  assert.deepEqual(spoken, ['Merging: Waiting for the model', 'Merging: Writing'], 'the announcer speaks the stage');
  view.renderTaskProgress(new El('bar'), new El('root'), key); // the redraw the stage change asked for
  const rendersBefore = renders;
  for (let i = 1; i <= 5; i++) { store.preview(key, 'x', { summary: 'word '.repeat(i) }); view.onResearchProgress(key); }
  assert.equal(spoken.length, 2, 'the streaming text is never announced'); assert.equal(renders, rendersBefore, 'the streaming preview redraws nothing');
  store.end(key); store.begin(key, 'y', Date.now()); store.preview(key, 'y', { summary: '**raw** summary' }); view.renderTaskProgress(bar, parent, key);
  const second = parent.kids.filter(k => k.cls.has('vam-task-preview')).at(-1);
  assert.equal(second.hidden, false); assert.equal(second.querySelector('.vam-card-preview-text').text, '**raw** summary', 'plain text, not rendered');
  store.preview(key, 'y', { summary: 'longer **raw** summary' }); view.paintTaskPreview(key);
  assert.equal(second.querySelector('.vam-card-preview-text').text, 'longer **raw** summary'); assert.equal(second.hidden, false);
  store.end(key); view.paintTaskPreview(key);
  assert.equal(second.hidden, true, 'the preview disappears with the entry');
  const settled = renders;
  store.begin('vam-task:merge:Other.md', 'z', Date.now()); view.onResearchProgress('vam-task:merge:Other.md'); view.onResearchProgress('vam-task:integration:Other.md');
  assert.equal(renders, settled, 'another map\'s task key is ignored');
});
test('R2 M2: one persistent announcer speaks a stage only when it changes; the streaming preview and card renders never touch it', () => {
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const { ResearchProgressStore } = load('experiences/visual-map/research-progress.ts');
  const view = new VisualAgentMapView({ app: {} }, { settings: { ...DEFAULT_SETTINGS, language: 'en' } });
  const store = new ResearchProgressStore();
  view.plugin = { researchProgress: store, settings: { ...DEFAULT_SETTINGS, language: 'en' } };
  view.map = { nodes: [{ id: 'n1', path: 'a.md' }] }; view.notes = new Map([['n1', { title: 'Topic A', summary: 'S' }]]); view.cardEls = new Map();
  const spoken = []; const announcer = { setText: text => spoken.push(text) };
  view.announcer = announcer; view.announcedStages = new Map();
  view.closed = false; view.stageEl = {}; view.paintHoverResearch = () => {}; view.scheduleResearchRender = () => {};
  store.begin('a.md', 'x', 1);
  view.onResearchProgress('a.md'); view.onResearchProgress('a.md');
  assert.deepEqual(spoken, ['Topic A: Waiting for the model'], 'repeated notifications of the same stage speak once');
  for (let i = 1; i <= 10; i++) { store.preview('a.md', 'x', { summary: 'word '.repeat(i) }); view.onResearchProgress('a.md'); }
  assert.equal(spoken.length, 1, 'the streaming preview is never announced');
  store.stage('a.md', 'x', 'searching', 2, 'synthetic query'); view.onResearchProgress('a.md');
  store.stage('a.md', 'x', 'searching', 3, 'another query'); view.onResearchProgress('a.md');
  assert.deepEqual(spoken.slice(1), ['Topic A: Searching: synthetic query'], 'a new query inside the same stage is not another announcement');
  store.markSlow('a.md', 'x', true, () => {}); view.onResearchProgress('a.md');
  assert.equal(spoken.at(-1), 'Topic A: Responding slowly, still waiting');
  store.end('a.md'); view.onResearchProgress('a.md');
  assert.equal(view.announcedStages.size, 0); assert.equal(view.announcer, announcer, 'the same node is kept');
  // The node lives outside contentEl, which render() empties, and the card chip is not a live region.
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', '..', 'experiences/visual-map/view.ts'), 'utf8');
  assert.match(source, /this\.announcer =\s*\(this\.containerEl as HTMLElement \| undefined\)\?\.createDiv/);
  const chip = source.slice(source.indexOf('const stageEl = chip.createSpan'), source.indexOf('const elapsedEl'));
  assert.doesNotMatch(chip, /aria-live|"role"/);
});
integrationTest('R1: local shallow child research gets no chart job; web shallow research and ordinary runs keep theirs', async () => {
  for (const [researchMode, expected] of [['local', 0], ['research', 1]]) {
    const h = await templateHarness({ language: 'en', reply: () => ({ summary: 'Sum', detail: 'Body paragraph.', visualReferences: [], suggestions: [] }) });
    await h.view.researchChild(h.doc.nodes[0], new AbortController().signal, () => {}, { researchMode, researchDepth: 'fast', visualMode: 'off', referenceGroups: [] }, researchMode !== 'local');
    await until(() => !h.plugin.running.size);
    assert.equal(h.contexts.at(-1).addCharts, expected === 1);
    // The plugin decides eligibility from the context, so a context without addCharts means no chart call.
    assert.equal(h.chartJobs.every(job => job.context.addCharts === (expected === 1)), true, `researchMode ${researchMode}`);
    const { AiTaskService } = load('core/ai-task-service.ts');
    const service = new AiTaskService({ pluginDirectory: () => '', language: () => 'en', defaultReasoning: () => 'low', exchangeLoggingEnabled: () => false, exchanges: () => null, codexRuntime: () => null, claudeRuntime: () => null });
    assert.equal(service.chartEligible(h.contexts.at(-1)), expected === 1);
  }
});
// ---- Synthesis keeps the parent's earlier source links (carry-forward block), no extra AI call, Undo exact.
const earlierSources = ['https://one.example/a', 'https://two.example/b?x=1', 'https://three.example/c', 'https://four.example/d', 'https://five.example/e', 'https://six.example/f'];
const earlierDetail = `Earlier finding [one](${earlierSources[0]}) and [two](${earlierSources[1]})[^1].\n\n### Evidence and sources\n\n${earlierSources.slice(2).map((url, i) => `- [Source ${i + 3}](${url})`).join('\n')}\n\n[^1]: [[Child Note]]`;
async function keepSourcesFixture(childText = 'Child finding.') {
  const f = await backgroundSynthesisFixture(async call => call === 1 ? f.directionsResult : f.draftResult);
  f.draftResult = { summary: 'Draft summary', detail: 'Draft detail citing only [the child](https://child.example/z).', visualReferences: [], suggestions: [] };
  await f.repo.updateNote(f.parent.path, { detail: earlierDetail, summary: 'Old summary https://summary.example/s', newFindings: 'Working [finding](https://finding.example/w)' });
  const child = f.view.map.nodes.find(item => item.parentId === f.parent.id);
  await f.repo.updateNote(child.path, { status: 'completed', summary: 'Child summary', detail: childText });
  return f;
}
const synthesize = async f => { await f.view.startSynthesis(f.parent, f.options(), null, m => assert.fail(m), () => {}); await f.view.startSynthesis(f.parent, f.options(), 'Find shared constraints', m => assert.fail(m), () => {}); };
const fileUrls = text => new Set([...text.matchAll(/https?:\/\/[^\s<>"'`)\]]+/g)].map(match => match[0]));
integrationTest('synthesis keeps every earlier source link in the parent note file, with no extra AI call', async () => {
  const f = await keepSourcesFixture();
  const before = await f.repo.readNote(f.parent.path);
  const beforeUrls = fileUrls(JSON.stringify([before.summary, before.detail, before.newFindings]));
  await synthesize(f);
  assert.equal(f.contexts.length, 2, 'directions + synthesis only');
  const saved = await f.repo.readNote(f.parent.path);
  const file = await f.repo.app.vault.adapter.read(f.parent.path);
  for (const url of beforeUrls) assert.ok(file.includes(url), `lost ${url}`);
  assert.equal(saved.newFindings, '', 'the findings were sent, so they are cleared');
  assert.match(saved.detail, /Sources from earlier research[\s\S]*https:\/\/finding\.example\/w/, 'the cleared findings link is carried into the block');
  assert.match(saved.detail, /#### Sources from earlier research/);
  assert.match(saved.detail, /Draft detail citing only \[the child\]\(https:\/\/child\.example\/z\)/);
  // Every footnote reference has exactly one definition.
  const refs = [...new Set([...saved.detail.matchAll(/\[\^([^\]]+)\](?!:)/g)].map(match => match[1]))];
  for (const label of refs) assert.equal(saved.detail.split('\n').filter(line => line.startsWith(`[^${label}]:`)).length, 1, label);
});
integrationTest('synthesis carry-forward: the child citations equal what the result gives, Undo restores the recorded fields, Redo rewrites the carried version', async () => {
  const f = await keepSourcesFixture();
  const before = await f.repo.readNote(f.parent.path);
  await synthesize(f);
  const carried = await f.repo.readNote(f.parent.path);
  const block = carried.detail.indexOf('#### Sources from earlier research');
  assert.ok(block > 0);
  await f.view.history.undo().undo();
  assert.deepEqual(plain(await f.repo.readNote(f.parent.path)), plain(before));
  await f.view.history.redo().redo();
  assert.equal((await f.repo.readNote(f.parent.path)).detail, carried.detail);
});
integrationTest('synthesis carry-forward: nothing missing leaves the detail as today; a second synthesis does not duplicate the block', async () => {
  const f = await keepSourcesFixture();
  f.draftResult = { ...f.draftResult, detail: `Draft ${earlierSources.map(url => `[s](${url})`).join(' ')} https://summary.example/s https://finding.example/w [[Child Note]]` };
  await synthesize(f);
  assert.doesNotMatch((await f.repo.readNote(f.parent.path)).detail, /Sources from earlier research/);
  const g = await keepSourcesFixture();
  await synthesize(g);
  const first = (await g.repo.readNote(g.parent.path)).detail;
  await synthesize(g);
  const second = await g.repo.readNote(g.parent.path);
  assert.equal((second.detail.match(/Sources from earlier research/g) || []).length, 1);
  for (const url of earlierSources) assert.ok(second.detail.includes(url), url);
  assert.ok(first.includes('Sources from earlier research'));
});
integrationTest('synthesis carry-forward with a large (over one batch) child note keeps the earlier links', async () => {
  const f = await keepSourcesFixture(Array.from({ length: 700 }, (_, i) => `Line ${i} of a long child note with enough words to pass the batch size.`).join('\n'));
  await synthesize(f);
  const file = await f.repo.app.vault.adapter.read(f.parent.path);
  for (const url of earlierSources) assert.ok(file.includes(url), url);
  // The mock model bypasses AiTaskService, so extraction itself does not run here; the request carries the over-budget source that sends it down that path, and the write path is the same.
  const sent = f.contexts.at(-1).referenceGroups.flatMap(group => group.documents).map(doc => JSON.stringify(doc)).join('').length;
  assert.ok(sent > 18000, 'the synthesis request holds more than one 18k batch');
  assert.match(file, /Sources from earlier research/);
});
integrationTest('synthesis carry-forward on the drafted-callback path: an edited detail keeps the earlier links and Undo is exact', async () => {
  const f = await keepSourcesFixture();
  const before = await f.repo.readNote(f.parent.path);
  const calls = [];
  await f.view.integrateChildren(f.parent, f.options(), 'Find shared constraints', async (_result, write) => { calls.push(1); await write('Edited summary', 'Edited detail with no links.'); }, m => assert.fail(m), () => {});
  assert.equal(calls.length, 1);
  const saved = await f.repo.readNote(f.parent.path);
  assert.match(saved.detail, /Edited detail with no links\./);
  const file = await f.repo.app.vault.adapter.read(f.parent.path);
  for (const url of earlierSources) assert.ok(file.includes(url), url);
  await f.view.history.undo().undo();
  assert.deepEqual(plain(await f.repo.readNote(f.parent.path)), plain(before));
});

const withoutCarried = detail => detail.replace(/\n*#### Sources from earlier research\n\n(?:- .*\n?)+/, '\n');
integrationTest('synthesis carry-forward: the saved detail minus the carried block equals what main saves for the same result', async () => {
  const f = await keepSourcesFixture();
  await synthesize(f);
  const carried = (await f.repo.readNote(f.parent.path)).detail;
  assert.match(carried, /#### Sources from earlier research/);
  const g = await backgroundSynthesisFixture(async call => call === 1 ? g.directionsResult : g.draftResult);
  g.draftResult = f.draftResult;
  await synthesize(g);
  const baseline = (await g.repo.readNote(g.parent.path)).detail;
  assert.doesNotMatch(baseline, /Sources from earlier research/);
  assert.equal(withoutCarried(carried).trim(), baseline.trim());
});
integrationTest('synthesis carry-forward: URLs in a legacy separate Visual References section are carried', async () => {
  const f = await keepSourcesFixture();
  await f.repo.app.vault.process(f.repo.file(f.parent.path), text => `${text.trimEnd()}\n\n## Visual References\n\n**Pic**\n\n![Pic](https://legacy-img.example/p.png)\n\nSource: https://legacy-src.example/page\n`);
  assert.match((await f.repo.readNote(f.parent.path)).visualReferences, /legacy-src\.example/);
  // The first status write of a synthesis folds a legacy section into Detail (so the stale fence compares like with like); the carry also reads latest.visualReferences as a guard.
  await f.repo.updateNote(f.parent.path, { status: 'completed' });
  assert.match((await f.repo.readNote(f.parent.path)).detail, /legacy-src\.example/);
  await synthesize(f);
  const file = await f.repo.app.vault.adapter.read(f.parent.path);
  assert.ok(file.includes('https://legacy-img.example/p.png'));
  assert.ok(file.includes('https://legacy-src.example/page'));
  assert.match((await f.repo.readNote(f.parent.path)).detail, /Sources from earlier research[\s\S]*legacy-src\.example/);
});

// ---- B8: child synthesis sends the parent's Working Findings; they are cleared on save only if they were sent.
const { capturingRuntime, makeService } = require('../support-replay.cjs');
async function findingsFixture(findings, language = 'en') {
  const f = await backgroundSynthesisFixture(async () => assert.fail('replaced below'));
  const directions = JSON.stringify({ summary: '', detail: '', visualReferences: [], suggestions: [{ title: 'Common ground', task: 'Find shared constraints', contribution: 'A shared view', parentTitle: '' }] });
  const draft = JSON.stringify({ summary: 'Draft summary', detail: 'Draft detail', visualReferences: [], suggestions: [] });
  f.runtime = capturingRuntime([directions, draft]);
  const service = makeService(f.runtime, { language });
  f.plugin.askModel = (context, _model, _reasoning, signal, _exchange, onAccepted) => service.askModel(context, 'gpt-6-luna', 'low', signal, undefined, onAccepted);
  await f.repo.updateNote(f.parent.path, { newFindings: findings });
  const child = f.view.map.nodes.find(item => item.parentId === f.parent.id);
  await f.repo.updateNote(child.path, { status: 'completed', summary: 'Child summary', detail: 'Child finding.' });
  return f;
}
integrationTest('B8: directions and synthesis prompts carry the parent Working Findings under their label', async () => {
  const f = await findingsFixture('PARENT_WORKING_FINDING_TEXT');
  await synthesize(f);
  assert.equal(f.runtime.calls.length, 2);
  for (const call of f.runtime.calls) assert.match(call.prompt, /Older findings to consolidate:\nPARENT_WORKING_FINDING_TEXT/);
  assert.equal((await f.repo.readNote(f.parent.path)).newFindings, '', 'the findings the model saw are folded into the rewrite and cleared');
});
integrationTest('B8: empty Working Findings add no label to the prompt and the save is as before', async () => {
  const f = await findingsFixture('');
  await synthesize(f);
  for (const call of f.runtime.calls) assert.doesNotMatch(call.prompt, /Older findings to consolidate/);
  assert.equal((await f.repo.readNote(f.parent.path)).newFindings, '');
});
integrationTest('B8: Working Findings the context budget cut off are kept on save', async () => {
  const f = await findingsFixture('KEPT_FINDING_START ' + 'x'.repeat(140000));
  await synthesize(f);
  assert.equal(f.runtime.calls.length, 2);
  assert.ok(!f.runtime.calls[1].prompt.includes('x'.repeat(140000)), 'the findings were cut');
  const saved = await f.repo.readNote(f.parent.path);
  assert.equal(saved.summary, 'Draft summary');
  assert.match(saved.newFindings, /^KEPT_FINDING_START x+$/);
});
integrationTest('B8: Working Findings edited while the synthesis runs make the save refuse and are not cleared', async () => {
  const f = await findingsFixture('Original finding');
  await f.view.startSynthesis(f.parent, f.options(), null, m => assert.fail(m), () => {});
  const failures = []; let save;
  await f.view.integrateChildren(f.parent, f.options(), 'Find shared constraints', (_result, commit) => { save = commit; }, m => failures.push(m));
  await f.repo.updateNote(f.parent.path, { newFindings: 'Edited by the user meanwhile' });
  await assert.rejects(save('S', 'D'), /changed/i);
  const saved = await f.repo.readNote(f.parent.path);
  assert.equal(saved.newFindings, 'Edited by the user meanwhile');
  assert.notEqual(saved.summary, 'S');
});
