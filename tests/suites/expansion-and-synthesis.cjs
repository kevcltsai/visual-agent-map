const assert = require('node:assert/strict');
const { attachTopicRuns, researchSeam } = require('../support.cjs');
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
  const view = new VisualAgentMapView({ app }, attachTopicRuns(plugin)); view.path = mapPath; view.map = mapDoc; view.contentEl = { querySelector: () => null }; view.render = () => {}; view.hydrate = async () => {};
  view.selection.replaceMulti([first.id]);
  await view.moveBranches(view.selectedRoots(), second);
  assert.equal((await repo.readMap(mapPath)).nodes.find(node => node.id === first.id).parentId, second.id);
  view.selection.replaceMulti([first.id]);
  await view.copySelected(root);
  const saved = await repo.readMap(mapPath), copied = saved.nodes.find(node => node.id !== first.id && node.id !== second.id && node.id !== root.id);
  assert.equal(saved.nodes.length, 4);
  assert.equal(copied.parentId, root.id);
  assert.notEqual(copied.path, first.path);
  const note = await repo.readNote(copied.path);
  assert.equal(note.detail, 'Original knowledge'); assert.equal(note.preview, 'My handwritten preview');
  await view.history.undo().undo();
  assert.equal((await repo.readMap(mapPath)).nodes.length, 3);
  assert.equal((await repo.readNote('Agent Workspace/Topics/map-a/Unassigned/First copy.md')).topicState, 'unassigned');
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
  assert.equal((await repo.readNote(copy.path)).title, 'budget copy');
  assert.match(await app.vault.read(app.vault.getAbstractFileByPath(copy.path)), /^---[\s\S]*# budget copy/m);
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
  const view = new VisualAgentMapView({ app }, attachTopicRuns(plugin)); view.path = mapPath; view.map = mapDoc; view.render = () => {}; view.hydrate = async () => {};
  view.selection.replaceMulti([first.id, second.id]);
  const duplicate = repo.duplicateNote.bind(repo); let count = 0;
  repo.duplicateNote = async (...args) => { if (++count === 2) throw new Error('injected duplicate failure'); return duplicate(...args); };
  await assert.rejects(view.copySelected(root), /injected duplicate failure/);
  assert.equal((await repo.readMap(mapPath)).nodes.length, 3);
  assert.equal((await repo.readNote('Agent Workspace/Topics/map-a/Unassigned/First copy.md')).topicState, 'unassigned');
  assert.equal(view.history.canUndo, false);
});
integrationTest('failed map save during copy parks the duplicate without changing the map', async () => {
  const { repo, app } = fixture(), root = await topicNote(repo, 'Root', 'a');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md';
  const mapDoc = { id: 'map-a', title: 'map-a', version: 1, nodes: [root], viewport: { x: 0, y: 0, zoom: 1 } };
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const plugin = { repo, settings: { ...DEFAULT_SETTINGS }, rebuildDerivedData: async () => {} };
  const view = new VisualAgentMapView({ app }, attachTopicRuns(plugin)); view.path = mapPath; view.map = mapDoc; view.render = () => {}; view.hydrate = async () => {};
  view.selection.replaceMulti([root.id]);
  const save = repo.saveMap.bind(repo); let fail = true;
  repo.saveMap = async (...args) => { if (fail) { fail = false; throw new Error('injected map save failure'); } return save(...args); };
  await assert.rejects(view.copySelected(root), /injected map save failure/);
  assert.equal((await repo.readMap(mapPath)).nodes.length, 1);
  assert.equal((await repo.readNote('Agent Workspace/Topics/map-a/Unassigned/Root copy.md')).topicState, 'unassigned');
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
  const view = new VisualAgentMapView({ app }, attachTopicRuns(plugin)); view.path = mapPath; view.map = mapDoc; view.render = () => {}; view.hydrate = async () => {};
  view.selection.replaceMulti([child.id]); await view.removeSelected();
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
  const view = new VisualAgentMapView({ app }, attachTopicRuns(plugin)); view.path = mapPath; view.map = mapDoc; view.render = () => {}; view.hydrate = async () => {};
  view.selection.replaceMulti([child.id]);
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
  const view = new VisualAgentMapView({ app }, attachTopicRuns(plugin)); view.path = mapPath; view.map = mapDoc; view.render = () => {}; view.hydrate = async () => {};
  view.selection.replaceMulti([child.id]);
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
  const view = new VisualAgentMapView({ app }, attachTopicRuns(withExpansionCoordinator({ repo, settings: { ...DEFAULT_SETTINGS }, rebuildDerivedData: async () => { rebuilds++; } })));
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
integrationTest('accepted research suggestions get a summary: the contribution, else the task, else the placeholder (detail unchanged)', async () => {
  const { repo, app } = fixture('en'), parent = await topicNote(repo, 'Parent', 'a');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md';
  const mapDoc = { id: 'map-a', title: 'map-a', version: 1, nodes: [parent], viewport: { x: 0, y: 0, zoom: 1 } };
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app }, attachTopicRuns(withExpansionCoordinator({ repo, settings: { ...DEFAULT_SETTINGS }, rebuildDerivedData: async () => {} })));
  view.path = mapPath; view.map = mapDoc; view.contentEl = { querySelector: () => null }; view.render = () => {}; view.hydrate = async () => {}; view.focusNode = () => {};
  const children = await view.createChildBatch(parent, [
    { title: 'Has contribution', task: 'Ask this', contribution: 'What it adds.\nSecond line [[x]]' },
    { title: 'Task only', task: 'Why does it matter?', contribution: '' },
    { title: 'Neither', task: '', contribution: '  ' }
  ]);
  const notes = await Promise.all(children.map(child => repo.readNote(child.path)));
  assert.deepEqual(notes.map(note => note.summary), ['What it adds. Second line [x]', 'Why does it matter?', 'No conclusion yet']);
  assert.match(notes[0].detail, /What it adds\./, 'the contribution still fills the detail');
  assert.equal(notes[1].detail.includes('Why does it matter?'), false, 'the task is not copied into the detail');
});
integrationTest('two-level child batches attach grandchildren and still rebuild once', async () => {
  const { repo, app } = fixture(), parent = await topicNote(repo, 'Parent', 'a'); let rebuilds = 0;
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md';
  const mapDoc = { id: 'map-a', title: 'map-a', version: 1, nodes: [parent], viewport: { x: 0, y: 0, zoom: 1 } };
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app }, attachTopicRuns(withExpansionCoordinator({ repo, settings: { ...DEFAULT_SETTINGS }, rebuildDerivedData: async () => { rebuilds++; } })));
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
  const view = new VisualAgentMapView({ app }, attachTopicRuns(withExpansionCoordinator({ repo, settings: { ...DEFAULT_SETTINGS }, rebuildDerivedData: async () => {} })));
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
  const view = new VisualAgentMapView({ app }, attachTopicRuns(withExpansionCoordinator({ repo, settings: { ...DEFAULT_SETTINGS }, rebuildDerivedData: async () => {} })));
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
  const view = new VisualAgentMapView({ app: {} }, attachTopicRuns(plugin));
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
  const view = new VisualAgentMapView({ app }, attachTopicRuns(plugin)); view.path = mapPath; view.map = mapDoc; view.contentEl = { querySelector: () => null }; view.render = () => {}; view.hydrate = async () => {}; view.focusNode = () => {};
  const researched = []; researchSeam(view).run = async node => { researched.push(node.id); await repo.updateNote(node.path, { status: 'running' }); };
  await view.createChildBatch(parent, [
    { title: 'A', task: 'Research A', contribution: '' },
    { title: 'A1', task: 'Research A1', contribution: '', parentTitle: 'A' }
  ], { researchMode: 'research', researchDepth: 'normal', visualMode: 'auto', referenceGroups: [] });
  const saved = await repo.readMap(mapPath);
  assert.deepEqual(researched, []);
  for (const node of saved.nodes.slice(1)) {
    const note = await repo.readNote(node.path);
    assert.equal('researchDepth' in note, false); assert.equal(note.researchMode, 'local', 'a new subtopic starts as Quick (D-2026-10-244)'); assert.equal(note.visualMode, 'auto');
  }
});
integrationTest('guided child creation stores shallow-research settings without dispatching', async () => {
  const { repo, app } = fixture(), parent = await topicNote(repo, 'Parent', 'model-a');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md';
  const mapDoc = map([parent]); mapDoc.id = 'map-a';
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const plugin = withExpansionCoordinator({ repo, settings: { ...DEFAULT_SETTINGS }, rebuildDerivedData: async () => {} });
  const view = new VisualAgentMapView({ app }, attachTopicRuns(plugin)); view.path = mapPath; view.map = mapDoc; view.contentEl = { querySelector: () => null }; view.render = () => {}; view.hydrate = async () => {}; view.focusNode = () => {};
  const researched = []; researchSeam(view).run = async child => { researched.push(child.id); await repo.updateNote(child.path, { status: 'running' }); };
  await view.createChildBatch(parent, [{ title: 'Research me', task: 'Find evidence', contribution: '', parentTitle: '' }], { researchMode: 'local', researchDepth: 'fast', visualMode: 'off', referenceGroups: [], shallowResearch: true });
  assert.deepEqual(researched, []);
  assert.equal((await repo.readNote(view.map.nodes.at(-1).path)).researchMode, 'local');
});
integrationTest('one shallow-research startup failure marks that child and does not strand later children', async () => {
  const { repo, app } = fixture(), parent = await topicNote(repo, 'Parent', 'model-a');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md', mapDoc = map([parent]); mapDoc.id = 'map-a';
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const failures = [], started = [];
  const plugin = withExpansionCoordinator({ repo, settings: { ...DEFAULT_SETTINGS }, running: new Set(), abortChartJobs: () => {}, addChartsAfterWrite: () => {}, pendingSuggestions: new Map(), pendingResearchOptions: new Map(), rebuildDerivedData: async () => {}, mutate: async work => work(), recordFailure: (context, error) => { failures.push(`${context}: ${error.message}`); return error.message; } });
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app }, attachTopicRuns(plugin)); view.path = mapPath; view.map = mapDoc; view.contentEl = { querySelector: () => null }; view.render = () => {}; view.hydrate = async () => {};
  researchSeam(view).run = async (child, _done, failed, _options, accepted) => {
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
  const view = new VisualAgentMapView({ app }, attachTopicRuns(plugin)); view.path = mapPath; view.map = mapDoc; view.contentEl = { querySelector: () => null }; view.render = () => {}; view.hydrate = async () => {};
  researchSeam(view).run = async (_child, _done, _failed, options, accepted) => { tasks.push(options.task); accepted?.(); return { finished: Promise.resolve() }; };
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
  const view = new VisualAgentMapView({ app }, attachTopicRuns(plugin)); view.path = mapPath; view.map = mapDoc; view.contentEl = { querySelector: () => null }; view.render = () => {}; view.hydrate = async () => {};
  researchSeam(view).run = async (child, _done, failed, options, accepted) => {
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
  const view = new VisualAgentMapView({ app }, attachTopicRuns(plugin)); view.path = mapPath; view.map = mapDoc; view.contentEl = { querySelector: () => null }; view.render = () => {}; view.hydrate = async () => {};
  const received = [];
  researchSeam(view).run = async (_child, _done, _failed, options, accepted) => { received.push(options.referenceGroups); accepted(); return { finished: Promise.resolve() }; };
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
  const view = new VisualAgentMapView({ app }, attachTopicRuns(plugin)); view.path = mapPath; view.map = mapDoc; view.contentEl = { querySelector: () => null }; view.render = () => {}; view.hydrate = async () => {};
  const received = new Map();
  researchSeam(view).run = async (child, _done, _failed, options, accepted) => {
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
  const view = new VisualAgentMapView({ app }, attachTopicRuns(plugin)); view.path = mapPath; view.map = mapDoc; view.contentEl = { querySelector: () => null }; view.render = () => {}; view.hydrate = async () => {}; view.focusNode = () => {};
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
  const view = new VisualAgentMapView({ app }, attachTopicRuns(plugin)); view.path = mapPath; view.map = mapDoc; view.contentEl = { querySelector: () => null }; view.render = () => {}; view.hydrate = async () => {}; view.focusNode = () => {};
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
  const view = new VisualAgentMapView({ app }, attachTopicRuns(plugin)); view.path = mapPath; view.map = mapDoc; view.contentEl = { querySelector: () => null }; view.render = () => {}; view.hydrate = async () => {}; view.focusNode = () => {};
  let childSignal, failure = '', create;
  researchSeam(view).run = async (_child, _done, failed, options) => {
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
  const view = new VisualAgentMapView({ app }, attachTopicRuns(plugin)); view.path = mapPath; view.map = mapDoc; view.contentEl = { querySelector: () => null }; view.render = () => {}; view.hydrate = async () => {}; view.focusNode = () => {};
  let childSignal, create;
  researchSeam(view).run = async (_child, _done, _failed, options) => { childSignal = options.signal; return new Promise(resolve => childSignal.addEventListener('abort', () => resolve(null), { once: true })); };
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
  const view = new VisualAgentMapView({ app }, attachTopicRuns(plugin)); view.path = mapPath; view.map = mapDoc; view.contentEl = { querySelector: () => null }; view.render = () => {}; view.hydrate = async () => {}; view.focusNode = () => {};
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
    const view = new VisualAgentMapView({ app }, attachTopicRuns(plugin)); view.path = mapPath; view.map = mapDoc; view.contentEl = { querySelector: () => null }; view.render = () => {}; view.hydrate = async () => {}; view.focusNode = () => {};
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
  const view = new VisualAgentMapView({ app }, attachTopicRuns(plugin)); view.path = mapPath; view.map = mapDoc; view.contentEl = { querySelector: () => null }; view.hydrate = async () => {}; view.focusNode = () => {};
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
  const view = new VisualAgentMapView({ app }, attachTopicRuns(plugin)); view.path = mapPath; view.map = mapDoc; view.contentEl = { querySelector: () => null }; view.render = () => {}; view.hydrate = async () => {}; view.focusNode = () => {};
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
  const view = new VisualAgentMapView({ app: {} }, attachTopicRuns(plugin));
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
  const first = new VisualAgentMapView({ app: {} }, attachTopicRuns(plugin)), second = new VisualAgentMapView({ app: {} }, attachTopicRuns(plugin));
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
  const view = new VisualAgentMapView({ app }, attachTopicRuns(plugin)); view.path = mapPath; view.map = mapDoc; view.contentEl = { querySelector: () => null }; view.render = () => {}; view.hydrate = async () => {}; view.focusNode = () => {};
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
  const view = new VisualAgentMapView({ app }, attachTopicRuns(plugin)); view.path = mapPath; view.map = mapDoc; view.render = () => {}; view.hydrate = async () => {}; view.ancestorContext = async () => '';
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
async function integrationWithChild() {
  const { repo, app } = fixture(), parent = await topicNote(repo, 'Parent', 'model-a');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md';
  const mapDoc = { id: 'map-a', title: 'map-a', version: 1, nodes: [parent], viewport: { x: 0, y: 0, zoom: 1 } };
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const child = await repo.createNote('Child', 'model-a', mapDoc, mapPath, 'workspace'); child.parentId = parent.id; mapDoc.nodes.push(child); await repo.saveMap(mapPath, mapDoc);
  const plugin = { repo, settings: { ...DEFAULT_SETTINGS }, running: new Set(), abortChartJobs: () => {}, addChartsAfterWrite: () => {}, mutate: async work => work(), askModel: async () => ({ summary: 'Draft summary', detail: 'Draft detail', visualReferences: [], suggestions: [] }) };
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app }, attachTopicRuns(plugin)); view.path = mapPath; view.map = mapDoc; view.render = () => {}; view.hydrate = async () => {}; view.ancestorContext = async () => '';
  const options = { researchMode: 'local', researchDepth: 'normal', visualMode: 'off', referenceGroups: [] };
  return { repo, parent, child, plugin, view, options };
}
integrationTest('integrating a topic while a child is still being researched waits for the child and does not report a changed topic (persona 08)', async () => {
  const { repo, parent, child, plugin, view, options } = await integrationWithChild();
  const research = plugin.topicRuns.begin(child.path, 'research');
  let save; const failures = [];
  const run = view.integrateChildren(parent, options, '', (_result, commit) => { save = commit; }, message => failures.push(message));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(save, undefined, 'the integration waits while the child is being researched');
  await repo.updateNote(child.path, { summary: 'Researched summary', detail: 'Researched detail' });
  research.release();
  await run;
  assert.deepEqual(failures, []);
  await save('Merged summary', 'Merged detail');
  assert.equal((await repo.readNote(parent.path)).summary, 'Merged summary');
});
integrationTest('integration still refuses to save when the user edits a child after the draft (persona 08 guard)', async () => {
  const { repo, parent, child, view, options } = await integrationWithChild();
  let save; const failures = [];
  await view.integrateChildren(parent, options, '', (_result, commit) => { save = commit; }, message => failures.push(message));
  assert.equal(typeof save, 'function');
  await repo.updateNote(child.path, { detail: 'User edited this child' });
  await assert.rejects(save('Merged summary', 'Merged detail'), /overwrite/);
  assert.notEqual((await repo.readNote(parent.path)).summary, 'Merged summary');
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
      await repo.updateNote(child.path, { summary: `Summary ${index}`, detail: `DETAIL_START_${index}\n${'body '.repeat(1500)}\nBODY_ONLY_CONDITION_${index}\n${'rest '.repeat(1500)}\nDETAIL_END_${index}`, newFindings: `Finding ${index}`, rules: `LEGACY_CHILD_${index}` });
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
    const view = new VisualAgentMapView({ app }, attachTopicRuns(plugin)); view.map = map([parent, ...children, grandchild, unrelated]); view.render = () => {}; view.hydrate = async () => {}; view.ancestorContext = async () => '';
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
    const view = new VisualAgentMapView({ app }, attachTopicRuns(plugin)); view.map = map([a, b, excluded]); view.render = () => {};
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
  const view = new VisualAgentMapView({ app }, attachTopicRuns(plugin)); view.map = map([parent, a, b]); view.render = () => {}; view.hydrate = async () => {}; view.ancestorContext = async () => '';
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
  const view = new VisualAgentMapView({ app }, attachTopicRuns(plugin)); view.map = map([parent]); view.render = () => {}; view.hydrate = async () => {}; view.ancestorContext = async () => '';
  const empty = { researchMode: 'local', researchDepth: 'normal', visualMode: 'off', referenceGroups: [] };
  let failure = '';
  await view.proposeIntegrationDirections(parent, empty, () => assert.fail('missing sources'), message => { failure = message; });
  assert.match(failure, /Nothing to synthesize yet/);
  assert.equal(contexts.length, 0);
  await view.proposeIntegrationDirections(parent, { ...empty, referenceGroups: [{ id: 'empty', name: 'Empty', location: '', documents: [] }] }, () => assert.fail('empty source'), message => { failure = message; });
  assert.match(failure, /Nothing to synthesize yet/);
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
  const view = new VisualAgentMapView({ app }, attachTopicRuns(plugin)); view.path = mapPath; view.map = mapDoc; view.render = () => {}; view.hydrate = async () => {}; view.openChildSuggestions = () => {};
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
  const view = new VisualAgentMapView({ app }, attachTopicRuns(plugin)); view.path = mapPath; view.map = mapDoc; view.render = () => {}; view.hydrate = async () => {}; view.openChildSuggestions = () => {}; view.ancestorContext = async () => '';
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
  const view = new VisualAgentMapView({ app }, attachTopicRuns(plugin)); view.path = mapPath; view.map = mapDoc; view.notes.set(child.id, await repo.readNote(child.path)); view.render = () => {}; view.hydrate = async () => {};
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
    const view = new VisualAgentMapView({app}, attachTopicRuns(plugin)); Object.assign(view, {path, map: doc, contentEl: {querySelector: () => null}, render() {}, async hydrate() {}, focusNode() {}});
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
  const view = new VisualAgentMapView({ app }, attachTopicRuns(plugin)); view.path = mapPath; view.map = mapDoc; view.render = () => {}; view.hydrate = async () => {}; view.ancestorContext = async () => '';
  const options = () => ({ researchMode: 'local', researchDepth: 'normal', visualMode: 'off', referenceGroups: [] });
  const directionsResult = { summary: '', detail: '', visualReferences: [], suggestions: [{ title: 'Common ground', task: 'Find shared constraints', contribution: 'A shared view', parentTitle: '' }] };
  const draftResult = { summary: 'Draft summary', detail: 'Draft detail', visualReferences: [], suggestions: [] };
  return { repo, parent, plugin, view, contexts, options, directionsResult, draftResult };
}
// Integrating the whole subtree (P1): the update mode default and the outline the root's prompt carries.
async function subtreeFixture(parentStyle, ask) {
  const f = await backgroundSynthesisFixture(ask ? call => ask(call, f) : async () => f.draftResult);
  const map = f.view.map; const child = map.nodes.find(item => item.parentId === f.parent.id);
  const grand = await f.repo.createNote('Grand topic', 'model-a', map, f.view.path, 'workspace'); grand.parentId = child.id; map.nodes.push(grand); await f.repo.saveMap(f.view.path, map);
  await f.repo.updateNote(child.path, { status: 'completed', summary: 'Child summary', detail: 'Child finding.' });
  await f.repo.updateNote(grand.path, { summary: 'Grand summary' });
  if (parentStyle) await f.repo.updateNote(f.parent.path, { noteStyle: parentStyle });
  f.view.notes = new Map(await Promise.all(map.nodes.map(async item => [item.id, await f.repo.readNote(item.path)])));
  return { ...f, grand, child };
}
test('integrationUpdateMode: only an unset merge becomes fresh; a chosen style, top and an explicit fresh run as they say', () => {
  const { integrationUpdateMode } = load('experiences/visual-map/view.ts', { obsidian });
  const run = (updateMode, recipe) => ({ updateMode, recipe });
  assert.equal(integrationUpdateMode(run('merge', { source: 'kind', ref: 'builtin:general' })), 'fresh');
  assert.equal(integrationUpdateMode(run('merge', { source: 'topic', ref: 'legacy', implicit: true })), 'fresh');
  assert.equal(integrationUpdateMode(run('merge', { source: 'topic', ref: 'builtin:general' })), 'merge');
  assert.equal(integrationUpdateMode(run('merge', { source: 'run', ref: 'file:mine' })), 'merge');
  assert.equal(integrationUpdateMode(run('merge', { source: 'kind', ref: 'file:mine' })), 'merge');
  assert.equal(integrationUpdateMode(run('top', { source: 'kind', ref: 'builtin:general' })), 'top');
  assert.equal(integrationUpdateMode(run('fresh', { source: 'topic', ref: 'file:mine' })), 'fresh');
});
integrationTest('integration with no note style set is a whole rewrite: the old Detail is not sent, and the prompt carries the subtree outline', async () => {
  const f = await subtreeFixture();
  await f.view.integrateChildren(f.parent, { ...f.options(), subtreeIntegration: true }, 'Integrate', () => {}, m => assert.fail(m));
  const context = f.contexts[0];
  assert.equal(context.updateMode, 'fresh');
  assert.match(context.subtreeOutline, /- Child\n {2}- Grand topic — Grand summary \[unresearched\]/);
  assert.match(context.subtreeOutline, /Unresearched topics: 1 of 2\. Grand topic\./);
});
integrationTest('an explicit note style that merges keeps the merge update (and the old Detail) in the integration', async () => {
  const f = await subtreeFixture('builtin:general');
  await f.view.integrateChildren(f.parent, { ...f.options(), subtreeIntegration: true }, 'Integrate', () => {}, m => assert.fail(m));
  assert.equal(f.contexts[0].updateMode, 'merge');
  assert.equal(f.contexts[0].detail, 'Existing knowledge');
  assert.ok(f.contexts[0].subtreeOutline, 'the outline does not depend on the update mode');
});
// Decision #9: only the topic chat chain and the integrate dialog (with its retry) take the outline and the fresh default; every other path is as before.
integrationTest('an integration without the subtree option (map chat, ask action) keeps the style update mode and sends no outline', async () => {
  const f = await subtreeFixture();
  await f.view.startSynthesis(f.parent, f.options(), 'Integrate', m => assert.fail(m), () => {});
  const context = f.contexts[0];
  assert.equal(context.updateMode, 'merge', 'the unset style merges as before');
  assert.equal(context.detail, 'Existing knowledge', 'the old Detail travels as before');
  assert.equal('subtreeOutline' in context, false);
});
integrationTest('map chat single-topic synthesis goes through the real integrateChildren with merge and no outline', async () => {
  const f = await subtreeFixture();
  f.view.launchChatTask = async (_model, run) => { let accepted = false; await run(m => assert.fail(m), () => { accepted = true; }); return { status: 'started', accepted }; };
  f.view.outputLanguageMemory = () => ({});
  await f.view.chatSynthesize([f.parent.id], 'Integrate');
  assert.equal(f.contexts.length, 1, 'the model ran once');
  assert.equal(f.contexts[0].updateMode, 'merge');
  assert.equal('subtreeOutline' in f.contexts[0], false);
});
integrationTest('the retry of a dialog integration keeps the outline and the fresh default; the first attempt failed after the options were stored', async () => {
  const f = await subtreeFixture(undefined, async call => { if (call === 1) throw new Error('boom'); return f.draftResult; });
  const failures = [];
  await f.view.startSynthesis(f.parent, { ...f.options(), subtreeIntegration: true }, 'Integrate', m => failures.push(m), () => {});
  assert.equal(failures.length, 1); assert.equal(f.view.synthesisTasks.get(f.parent.path).state, 'failed');
  f.plugin.confirmAiUsage = async (_model, run) => run(); f.view.notesLoading = () => false;
  f.view.retrySynthesis(f.parent);
  await until(() => f.contexts.length === 2 && !f.view.synthesisTasks.has(f.parent.path));
  assert.equal(f.contexts[1].updateMode, 'fresh'); assert.ok(f.contexts[1].subtreeOutline);
});
integrationTest('a one-level subtree sends no outline; the direct subtopics travel as before', async () => {
  const f = await backgroundSynthesisFixture(async () => f.draftResult);
  await f.view.integrateChildren(f.parent, f.options(), 'Integrate', () => {}, m => assert.fail(m));
  assert.equal('subtreeOutline' in f.contexts[0], false);
  assert.equal(f.contexts[0].mode, 'synthesize');
});
integrationTest('fresh integration whose file cannot be read for the backup calls no AI and writes nothing (the guard holds on the new default)', async () => {
  const f = await subtreeFixture();
  const hooks = f.view.writebackHooks.bind(f.view);
  f.view.writebackHooks = () => ({ ...hooks(), readRaw: async () => { throw new Error('no file'); } });
  const failures = [];
  await f.view.integrateChildren(f.parent, { ...f.options(), subtreeIntegration: true }, 'Integrate', () => assert.fail('wrote'), m => failures.push(m));
  assert.equal(f.contexts.length, 0, 'no model call');
  assert.deepEqual(failures, [load('i18n.ts').t('ui.writeback_backup_failed')]);
  assert.equal((await f.repo.readNote(f.parent.path)).detail, 'Existing knowledge');
});
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
  await assert.rejects(f.view.history.undo().undo(), /Integration was not saved/i);
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
  const view = new VisualAgentMapView({ app }, attachTopicRuns(plugin)); view.path = mapPath; view.map = mapDoc; view.render = () => {}; view.hydrate = async () => {}; view.focusNode = () => {};
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
  const task = f.view.synthesisTasks.get(f.parent.path); assert.equal(task.state, 'failed'); assert.match(task.progress, /Integration was not saved/i);
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
  const view = new VisualAgentMapView({ app }, attachTopicRuns(plugin)); view.path = mapPath; view.map = mapDoc; view.contentEl = { querySelector: () => null }; view.render = () => {}; view.hydrate = async () => {};
  researchSeam(view).run = async (child, _done, failed, options, accepted, runOnce) => {
    const note = await repo.readNote(child.path);
    runs.push({ title: note.title, options, runOnce }); plugin.running.add(child.path); accepted();
    const finished = new Promise(resolve => { finish.set(note.title, (message) => { plugin.running.delete(child.path); if (message) failed(message); resolve(); }); options.signal.addEventListener('abort', () => { plugin.running.delete(child.path); resolve(); }, { once: true }); });
    return { finished };
  };
  const request = { researchMode: 'research', researchDepth: 'fast', requirements: '', imageSearch: false };
  return { repo, view, plugin, nodes, notices, runs, finish, confirms, opened, request, key: `multi-research:${mapPath}` };
}
integrationTest('multi research runs selected topics in the background with the chosen options and a map-level key', async () => {
  const h = await multiResearchHarness(['A', 'B']);
  await h.repo.updateNote(h.nodes[1].path, { prompt: 'Custom prompt for B' });
  h.view.selection.replaceMulti(h.nodes.map(n => n.id));
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
integrationTest('multi research dialog: Standard runs every topic as research with images even when its note stored local; Quick runs standard notes as local', async () => {
  for (const [picked, stored, expected, mode, charts] of [['research', 'local', 'auto', 'standard', true], ['local', 'research', 'off', 'quick', false]]) {
    const h = await multiResearchHarness(['A', 'B']);
    for (const n of h.nodes) await h.repo.updateNote(n.path, { researchMode: stored });
    h.view.selection.replaceMulti(h.nodes.map(n => n.id));
    await h.view.startMultiResearch({ researchMode: picked, researchDepth: 'normal', requirements: '', imageSearch: picked === 'research' });
    await until(() => h.runs.length === 2);
    for (const run of h.runs) { assert.equal(run.options.researchMode, picked); assert.equal(run.options.visualMode, expected); assert.equal(run.options.mapAiMode, mode); assert.equal(run.options.addCharts, charts); }
    h.finish.get('A')(); h.finish.get('B')();
  }
});
integrationTest('multi research without a mode override (retry with another provider) keeps each topic on its own stored mode', async () => {
  const h = await multiResearchHarness(['A', 'B']);
  await h.repo.updateNote(h.nodes[0].path, { researchMode: 'research' }); await h.repo.updateNote(h.nodes[1].path, { researchMode: 'local' });
  h.view.selection.replaceMulti(h.nodes.map(n => n.id));
  await h.view.retryWithOtherProvider(h.nodes, 'model-b');
  await until(() => h.runs.length === 2);
  assert.equal(h.runs.find(r => r.title === 'A').options.researchMode, 'research'); assert.equal(h.runs.find(r => r.title === 'A').options.visualMode, 'auto');
  assert.equal(h.runs.find(r => r.title === 'B').options.researchMode, 'local');
  h.finish.get('A')(); h.finish.get('B')();
});
integrationTest('multi research dialog opens on the map\'s remembered mode, remembers the pick on start without clearing the selection, and remembers nothing on cancel', async () => {
  const h = await multiResearchHarness(['A', 'B']);
  h.view.notes = new Map(h.nodes.map(n => [n.id, { title: n.id, researchMode: 'local' }]));
  h.view.selection.replaceMulti(h.nodes.map(n => n.id));
  h.view.openMultiResearch();
  assert.equal(h.opened[0].initialMode, 'quick', 'no remembered mode: Quick');
  h.view.map.aiMode = 'standard'; h.view.openMultiResearch();
  assert.equal(h.opened[1].initialMode, 'standard');
  // Cancel (nothing submitted): the map keeps its mode and nothing starts.
  assert.equal(h.view.map.aiMode, 'standard'); assert.equal(h.runs.length, 0);
  // Quick picked from the dialog: remembered, selection survives the map write, and both topics really start.
  // As the existing aiModeMemory test: the map write is a stub that applies the change and must not clear the selection.
  h.view.mapChange = async change => { change(h.view.map); };
  h.opened[1].submit({ requirements: '', researchMode: 'local', researchDepth: 'normal', imageSearch: false });
  await until(() => h.runs.length === 2);
  assert.equal(h.view.map.aiMode, 'quick'); assert.equal(h.runs.length, h.nodes.length);
  h.finish.get('A')(); h.finish.get('B')();
});
integrationTest('multi research dialog: a map write that fails starts nothing, shows a Notice and leaves no unhandled rejection', async () => {
  const h = await multiResearchHarness(['A', 'B']);
  h.view.notes = new Map(h.nodes.map(n => [n.id, { title: n.id, researchMode: 'local' }]));
  h.view.selection.replaceMulti(h.nodes.map(n => n.id));
  h.view.openMultiResearch();
  const unhandled = []; const onUnhandled = e => unhandled.push(e); process.on('unhandledRejection', onUnhandled);
  h.view.mapChange = async () => { throw new Error('disk full'); };
  try {
    h.opened[0].submit({ requirements: '', researchMode: 'local', researchDepth: 'normal', imageSearch: false });
    await until(() => h.notices.length > 0);
    await new Promise(resolve => setTimeout(resolve, 20));
  } finally { process.off('unhandledRejection', onUnhandled); }
  assert.deepEqual(unhandled, []); assert.equal(h.runs.length, 0);
  assert.ok(h.notices.includes('The research did not start because the map could not be saved.'));
});
integrationTest('multi research dialog: the batch the dialog listed runs even if the selection is cleared or changed while the map is written', async () => {
  for (const change of [view => view.selection.replaceMulti([]), view => view.selection.replaceMulti([view.map.nodes[0].id])]) {
    const h = await multiResearchHarness(['A', 'B']);
    h.view.notes = new Map(h.nodes.map(n => [n.id, { title: n.id, researchMode: 'local' }]));
    h.view.selection.replaceMulti(h.nodes.map(n => n.id));
    h.view.openMultiResearch();
    h.view.mapChange = async fn => { fn(h.view.map); change(h.view); };
    h.opened[0].submit({ requirements: '', researchMode: 'local', researchDepth: 'normal', imageSearch: false });
    await until(() => h.runs.length === 2);
    assert.deepEqual(plain(h.runs.map(r => r.title).sort()), ['A', 'B']);
    h.finish.get('A')(); h.finish.get('B')();
  }
});
integrationTest('multi research without an explicit language answers each topic in its own title language', async () => {
  const h = await multiResearchHarness(['要如何在陽台養香草', 'Balcony herbs']);
  h.view.selection.replaceMulti(h.nodes.map(n => n.id));
  await h.view.startMultiResearch(h.request); await until(() => h.runs.length === 2);
  assert.equal(h.runs.find(r => r.title === '要如何在陽台養香草').options.outputLanguage, 'zh-TW');
  assert.equal(h.runs.find(r => r.title === 'Balcony herbs').options.outputLanguage, 'same-as-input');
  assert.match(h.runs.find(r => r.title === '要如何在陽台養香草').options.task, /[\u4e00-\u9fff]/);
  h.finish.get('要如何在陽台養香草')(); h.finish.get('Balcony herbs')();
});
// Batches keep running after a map switch (dropMapBackground does not stop the coordinator), so a child that starts later
// must still use the language source of the map the batch was started on.
for (const [name, from, to, expected] of [
  ['Chinese map, then an English map', 'pstack 技能解析', 'The Roman Empire', 'zh-TW'],
  ['English map, then a Chinese map', 'The Roman Empire', 'pstack 技能解析', 'same-as-input']
]) {
  integrationTest(`card language: a multi research batch keeps the language of the map it started on (${name})`, async () => {
    const h = await multiResearchHarness(['sharpen']);
    const original = h.view.map; original.title = from;
    const other = { ...original, id: 'map-b', title: to };
    const confirm = h.plugin.confirmAiUsage;
    h.plugin.confirmAiUsage = async (model, run) => { h.view.map = other; return confirm(model, run); }; // the user switches map before the child starts
    h.view.selection.replaceMulti(h.nodes.map(n => n.id));
    await h.view.startMultiResearch(h.request); await until(() => h.runs.length === 1);
    assert.equal(h.runs[0].options.outputLanguage, expected);
    h.finish.get('sharpen')();
  });
  integrationTest(`card language: a shallow batch keeps the language of the map it started on (${name})`, async () => {
    const h = await multiResearchHarness(['sharpen']);
    const original = h.view.map; original.title = from;
    const other = { ...original, id: 'map-b', title: to };
    const options = { researchMode: 'research', researchDepth: 'fast', visualMode: 'off', referenceGroups: [], requirements: '' };
    const pending = h.view.startShallowResearch(h.nodes[0], h.nodes, options);
    h.view.map = other; // switched before the child starts
    await until(() => h.runs.length === 1);
    assert.equal(h.runs[0].options.outputLanguage, expected);
    h.finish.get('sharpen')(); await pending;
  });
}
integrationTest('multi research with image search runs each topic with auto visual mode', async () => {
  const h = await multiResearchHarness(['Img']);
  h.view.selection.replaceMulti([h.nodes[0].id]);
  await h.view.startMultiResearch({ ...h.request, imageSearch: true });
  await until(() => h.runs.length === 1);
  assert.equal(h.runs[0].options.visualMode, 'auto');
  h.finish.get('Img')(); await until(() => h.plugin.expansionBatches.get(h.key).status === 'completed');
});
integrationTest('multi research without requirements uses the topic prompt alone and web search maps to research', async () => {
  const h = await multiResearchHarness(['Solo']);
  h.view.selection.replaceMulti([h.nodes[0].id]);
  await h.view.startMultiResearch(h.request);
  await until(() => h.runs.length === 1);
  assert.doesNotMatch(h.runs[0].options.task, /\n\n$/); assert.equal(h.runs[0].options.researchMode, 'research');
  h.finish.get('Solo')(); await until(() => h.plugin.expansionBatches.get(h.key).status === 'completed');
});
integrationTest('multi research runs at most three topics at once and stop aborts every running one', async () => {
  const h = await multiResearchHarness(['A', 'B', 'C', 'D', 'E']);
  h.view.selection.replaceMulti(h.nodes.map(n => n.id));
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
  h.view.selection.replaceMulti(h.nodes.map(n => n.id));
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
  h.view.selection.replaceMulti(h.nodes.map(n => n.id));
  await h.view.startMultiResearch(h.request);
  assert.equal(h.plugin.expansionBatches.has(h.key), false); assert.equal(h.runs.length, 0);
  assert.equal(h.notices.length, 1); assert.match(h.notices[0], /already running/);
});
integrationTest('a second multi research batch on the same map is refused while one is running', async () => {
  const h = await multiResearchHarness(['A', 'B', 'C']);
  h.view.selection.replaceMulti([h.nodes[0].id]);
  await h.view.startMultiResearch(h.request); await until(() => h.runs.length === 1);
  h.view.selection.replaceMulti([h.nodes[1].id, h.nodes[2].id]);
  h.confirms.length = 0;
  await h.view.startMultiResearch(h.request);
  assert.equal(h.runs.length, 1); assert.equal(h.confirms.length, 0);
  assert.ok(h.notices.some(m => /already running on this map/.test(m)));
  assert.equal(h.plugin.expansionBatches.get(h.key).total, 1);
  h.finish.get('A')(); await until(() => h.plugin.expansionBatches.get(h.key).status === 'completed');
});
integrationTest('a failing topic is recorded and does not stop the others', async () => {
  const h = await multiResearchHarness(['A', 'B', 'C']);
  h.view.selection.replaceMulti(h.nodes.map(n => n.id));
  await h.view.startMultiResearch(h.request);
  await until(() => h.runs.length === 3);
  h.finish.get('B')('model exploded'); h.finish.get('A')(); h.finish.get('C')();
  await until(() => h.plugin.expansionBatches.get(h.key).status === 'completed');
  const state = h.plugin.expansionBatches.get(h.key);
  assert.equal(state.completed, 3); assert.equal(state.failures.length, 1); assert.match(state.failures[0], /model exploded/);
  assert.ok(h.notices.some(m => /1 failed/.test(m)), h.notices.join('|'));
});
integrationTest('multi research needs at least one topic', async () => {
  const h = await multiResearchHarness(['A']);
  h.view.selection.replaceMulti([]); await h.view.startMultiResearch(h.request);
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
  items = bar(); assert.equal(research(), undefined, 'no topic picked: no bar yet');
  h.view.selection.replaceMulti([h.nodes[0].id]); items = bar(); assert.equal(research().disabled, false); assert.equal(research().text, 'Research'); assert.equal(research().attrs['aria-label'], 'Research 1 topic');
  assert.equal(toolbar().length, 1);
  h.view.selection.chatSelect([h.nodes[0].id]);
  await h.view.startMultiResearch(h.request); await until(() => h.runs.length === 1);
  assert.equal(h.view.selection.state.multiSelectMode, false); assert.equal(h.view.selection.state.multiSelected.size, 0);
  h.view.selection.replaceMulti([h.nodes[1].id]); items = bar(); assert.equal(research().disabled, true);
  assert.equal(items.find(i => i.text === 'Researching: 0 of 1 done'), undefined);
  items = toolbar();
  assert.ok(items.find(i => i.tag === 'span' && i.text === `Researching: 0 of 1 done · ${h.nodes[0].id}`), items.map(i => i.text).join('|'));
  assert.ok(items.find(i => i.tag === 'div' && /vam-aim-statusbar/.test(i.cls)));
  const stop = items.find(i => i.tag === 'button' && i.text === 'Stop research'); assert.ok(stop);
  stop.listeners.click({ stopPropagation() {} });
  await until(() => h.plugin.expansionBatches.get(h.key).status === 'stopped');
  assert.equal(toolbar().length, 1);
});
integrationTest('multi research with a chosen model runs each started topic on it once, saves nothing on the topic and confirms usage for it', async () => {
  const h = await multiResearchHarness(['A', 'B', 'C']);
  h.plugin.running.add(h.nodes[2].path);
  h.view.selection.replaceMulti(h.nodes.map(n => n.id));
  await h.view.startMultiResearch({ ...h.request, model: 'model-b' });
  await until(() => h.runs.length === 2);
  assert.deepEqual(plain(h.confirms), ['model-b']);
  for (const node of h.nodes.slice(0, 2)) {
    const note = await h.repo.readNote(node.path);
    assert.notEqual(note.model, 'model-b'); assert.equal(note.modelSource, 'workspace', 'MS-06: the picked model is for this run only, never an override');
  }
  assert.deepEqual(plain(h.runs.map(run => run.runOnce)), [{ model: 'model-b' }, { model: 'model-b' }]);
  assert.equal((await h.repo.readNote(h.nodes[2].path)).model, h.repo.settings.cliModel, 'a workspace topic follows the current workspace model, not its creation snapshot');
  h.finish.get('A')(); h.finish.get('B')();
});
integrationTest('multi research without a chosen model runs a workspace topic on the current workspace model', async () => {
  const h = await multiResearchHarness(['A']);
  h.view.selection.replaceMulti([h.nodes[0].id]);
  await h.view.startMultiResearch(h.request); await until(() => h.runs.length === 1);
  const note = await h.repo.readNote(h.nodes[0].path);
  assert.equal(note.model, h.repo.settings.cliModel); assert.equal(note.modelSource, 'workspace');
  h.finish.get('A')();
});
integrationTest('multi research keeps selection mode when nothing starts', async () => {
  const h = await multiResearchHarness(['A']);
  h.plugin.running.add(h.nodes[0].path);
  h.view.selection.chatSelect([h.nodes[0].id]);
  await h.view.startMultiResearch(h.request);
  assert.equal(h.view.selection.state.multiSelectMode, true); assert.equal(h.view.selection.state.multiSelected.size, 1);
});
integrationTest('multi research: stop before any topic is accepted gives exactly one summary Notice and no launch error', async () => {
  const h = await multiResearchHarness(['A']);
  researchSeam(h.view).run = async () => { h.view.stopMultiResearch(); return undefined; };
  h.view.selection.replaceMulti([h.nodes[0].id]);
  await h.view.startMultiResearch(h.request);
  await until(() => h.plugin.expansionBatches.get(h.key).status !== 'running');
  assert.equal(h.notices.length, 1, h.notices.join('|'));
  assert.equal(h.notices[0], 'Research stopped: 0 of 1 succeeded, 0 failed, 0 skipped.');
});
integrationTest('multi research: a topic that became busy before dispatch is skipped, not failed', async () => {
  const h = await multiResearchHarness(['A', 'B', 'C', 'D']);
  h.view.selection.replaceMulti(h.nodes.map(n => n.id));
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
  h.view.selection.replaceMulti(h.nodes.map(n => n.id));
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
async function templateHarness({ language = 'zh-TW', settings = {}, mapTemplate, reply, captureModals = false } = {}) {
  const { repo, app, contents } = fixture(language), notices = [], modals = [], contexts = [], chartJobs = [], chartAborts = [];
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md', doc = { id: 'map-a', title: 'map-a', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  if (mapTemplate) doc.detailTemplateId = mapTemplate;
  await repo.ensureTopicFolders('Agent Workspace/Topics/map-a'); await app.vault.create(mapPath, core.serializeMap(doc));
  const topic = await repo.createNote('Topic', 'model-a', doc, mapPath, 'workspace'); doc.nodes.push(topic); await repo.saveMap(mapPath, doc);
  await repo.updateNote(topic.path, { prompt: 'Research the topic' });
  let view;
  const plugin = withExpansionCoordinator({ repo, settings: { ...DEFAULT_SETTINGS, language, ...settings }, running: new Set(), abortChartJobs: path => chartAborts.push(path), addChartsAfterWrite: job => chartJobs.push(job), activeTasks: new Map(), pendingSuggestions: new Map(), pendingResearchOptions: new Map(), rebuildDerivedData: async () => {}, mutate: async work => work(), views: () => [view], recordFailure: (_label, error) => error.message,
    askModel: async (context, _model, _reasoning, _signal, _exchange, onAccepted) => { contexts.push(context); onAccepted?.(); return (reply ?? (() => ({ summary: 'Saved summary', detail: 'Saved detail', visualReferences: [], suggestions: [] })))(context, contexts.length); } });
  const { VisualAgentMapView } = load('main.ts', { obsidian: { ...obsidian, ...(captureModals === 'dom' ? { Modal: class extends require('../support-dom.cjs').makeModal() { open() { modals.push(this); super.open(); } } } : captureModals ? { Modal: class { constructor() {} open() { modals.push(this); } close() {} } } : {}), Notice: class { constructor(message) { notices.push(message); } hide() {} } } }, { createFragment: require('../support-dom.cjs').createFragment });
  view = new VisualAgentMapView({ app }, attachTopicRuns(plugin)); view.path = mapPath; view.map = doc; view.contentEl = { querySelector: () => null }; view.render = () => {}; view.hydrate = async () => {}; view.ancestorContext = async () => '';
  // The research run aborts the old chart job inside the run module; record it there like the plugin double does for the other entries.
  const abortCharts = plugin.topicRuns.abortCharts.bind(plugin.topicRuns); plugin.topicRuns.abortCharts = path => { chartAborts.push(path); abortCharts(path); };
  const run = async (target = topic) => { const handle = await view.runAgent(target); await handle?.finished; await until(() => !plugin.running.size); };
  return { repo, app, contents, view, plugin, doc, mapPath, topic, notices, modals, contexts, run, chartJobs, chartAborts };
}
integrationTest('runAgent: context carries the resolved template (run > topic > topic type; the map and workspace keys are not read) (was: topic > map > workspace > Standard; grilling Q5/Q10/Q15)', async () => {
  const h = await templateHarness({ settings: { detailTemplates: sampleTemplates(), defaultDetailTemplateId: 'C', noteTemplateBlock: 'builtin:textbook', noteTemplateByKind: { topic: 'builtin:textbook' } } });
  await h.run(); assert.equal(h.contexts.at(-1).detailTemplate.id, 'standard', 'workspace keys do not choose the template');
  h.doc.detailTemplateId = 'B'; await h.run(); assert.equal(h.contexts.at(-1).detailTemplate.id, 'standard', 'the map template does not choose it either');
  await h.repo.updateNote(h.topic.path, { detailTemplateId: 'A' }); await h.run(); assert.equal(h.contexts.at(-1).detailTemplate.id, 'A');
  assert.deepEqual(h.notices, []);
  assert.equal((await h.repo.readNote(h.topic.path)).detailTemplateId, 'A');
  const typed = await templateHarness({ language: 'en', settings: { noteStyleByKind: { topic: 'builtin:textbook' }, defaultDetailTemplateId: 'C', detailTemplates: sampleTemplates() } });
  typed.doc.detailTemplateId = 'B';
  await typed.run();
  assert.equal(typed.contexts.at(-1).detailTemplate.id, 'textbook', 'the topic type decides when the topic has no style');
  const bare = await templateHarness({ language: 'en' });
  await bare.run();
  assert.equal(bare.contexts[0].detailTemplate.id, 'standard');
  assert.equal(bare.contexts[0].detailTemplate.sections[0].name, 'Core conclusions');
  assert.equal((await bare.repo.readNote(bare.topic.path)).detailTemplateId, undefined, 'resolution never writes the topic');
});
integrationTest('runAgent: a topic whose style file is missing keeps its note unchanged, says which file is missing and offers another style; an old template id that is gone is told but kept (was: cleared; grilling Q18, counterexample 14)', async () => {
  const h = await templateHarness({ language: 'en', settings: { detailTemplates: sampleTemplates() } });
  await h.repo.updateNote(h.topic.path, { detailTemplateId: 'style:Gone', toneId: 'plain' });
  await h.run();
  assert.equal(h.contexts.at(-1).detailTemplate.id, 'standard', 'falls back to the next level');
  assert.equal(h.notices.length, 1); assert.match(String(h.notices[0]), /"Gone\.md"/);
  const buttons = require('../support-dom.cjs').findAll(h.notices[0], i => i.tag === 'button');
  assert.deepEqual(buttons.map(b => b.text), ['Use another style']);
  const note = await h.repo.readNote(h.topic.path);
  assert.equal(note.detailTemplateId, 'style:Gone', 'the note is not rewritten: the file may come back');
  await h.repo.updateNote(h.topic.path, { detailTemplateId: 'old-gone' });
  h.notices.length = 0;
  await h.run();
  assert.equal(h.notices.length, 1); assert.match(String(h.notices[0]), /"old-gone" no longer exists/);
  assert.equal((await h.repo.readNote(h.topic.path)).detailTemplateId, 'old-gone', 'an old template id that is gone is told but the note keeps it');
});
// The topic type's style file points at a structure file that does not parse; the files are served by an in-memory port that refuses writes.
async function installStyleFiles(plugin, files) {
  const port = { list: async folder => Object.keys(files).filter(f => f.startsWith(`${folder}/`)).map(f => f.slice(folder.length + 1)), read: async f => files[f], folderExists: folder => Object.keys(files).some(f => f.startsWith(`${folder}/`)), createFolder: async () => {}, create: async () => { throw new Error('read only'); }, trash: async () => {} };
  const { NoteStyleStore } = load('ai/note-style-store.ts');
  plugin.noteStyles = new NoteStyleStore({ settings: () => plugin.settings, port, save: async () => {} });
  await plugin.noteStyles.refresh();
}
// Ticket 04 FB1: the Notice for an unreadable structure belongs to the entry of a run, once per execution.
const BAD_BLOCK = '## A\nbody\n%% never closed\nmore\n';
const installBadBlock = (plugin, file = 'Bad') => installStyleFiles(plugin, { [`WS/S/Styles/${file}.md`]: `---\nstructure: ${file}\n---\n`, [`WS/S/Structures/${file}.md`]: BAD_BLOCK });
const badBlockSettings = { workspaceFolder: 'WS', noteStylesFolder: 'WS/S', noteStyleByKind: { topic: 'file:Bad' } };
const blockNotices = notices => notices.filter(message => /Bad\.md/.test(String(message)));
integrationTest('runAgent: a structure file with a comment that never closes, set as the topic type style, still runs on the built-in template, with one Notice naming file and line, and the context carries the file text (04 counter 4; was: set as the workspace template block, grilling Q10)', async () => {
  const h = await templateHarness({ language: 'en', settings: badBlockSettings });
  await installBadBlock(h.plugin);
  await h.run();
  assert.equal(h.contexts.length, 1, 'the run is not stopped');
  assert.equal(h.contexts[0].detailTemplate.id, 'standard', 'the built-in template stands in');
  assert.equal(h.contexts[0].styleSelection.template.fileName, 'Bad.md');
  assert.equal(h.notices.length, 1, 'exactly one Notice');
  assert.match(String(h.notices[0]), /Bad\.md/); assert.match(String(h.notices[0]), /line 3/);
  assert.match(String(h.notices[0]), /The built-in structure is used instead\./);
});
integrationTest('FB1 F1: opening the selection synthesis dialog raises no Notice for an unreadable template block', async () => {
  const opened = [], notices = [];
  const h = await templateHarness({ language: 'en', settings: badBlockSettings });
  await installBadBlock(h.plugin);
  const other = await h.repo.createNote('Other', 'model-a', h.doc, h.mapPath, 'workspace'); h.doc.nodes.push(other); await h.repo.saveMap(h.mapPath, h.doc);
  const { VisualAgentMapView } = load('main.ts', { obsidian: { ...obsidian, Modal: class { constructor() {} open() { opened.push(this); } close() {} }, Notice: class { constructor(message) { notices.push(message); } } } });
  const view = new VisualAgentMapView({ app: h.app }, attachTopicRuns(h.plugin)); view.path = h.mapPath; view.map = h.doc; view.render = () => {};
  view.selection.replaceMulti([h.topic.id, other.id]);
  view.openSelectionSynthesis(null);
  await until(() => opened.length === 1); // the styles are read again first (#38), so the dialog opens a moment later
  assert.equal(opened.length, 1, 'the synthesis dialog opened');
  assert.deepEqual(notices, [], 'a label or a dialog is not a run');
  assert.deepEqual(h.notices, []);
});
integrationTest('FB1 F1: one runAgent, one synthesis and one integration each raise exactly one Notice naming file and line', async () => {
  const h = await templateHarness({ language: 'en', settings: badBlockSettings, reply: (_context, call) => (call === 1 ? { summary: 'S', detail: 'D', visualReferences: [], suggestions: [] } : { summary: 'Synth', detail: '### Core conclusions\n\nTwo', visualReferences: [], suggestions: [] }) });
  await installBadBlock(h.plugin);
  const other = await h.repo.createNote('Other', 'model-a', h.doc, h.mapPath, 'workspace'); h.doc.nodes.push(other); await h.repo.saveMap(h.mapPath, h.doc);
  await h.run();
  assert.equal(blockNotices(h.notices).length, 1, 'runAgent');
  assert.match(String(h.notices[0]), /line 3/);
  h.notices.length = 0;
  await h.view.createIntegratedNode('Combined', [h.topic, other], 'Compare', '');
  assert.equal(blockNotices(h.notices).length, 1, 'one integration (start and write-back together)');
  h.notices.length = 0;
  const child = await h.repo.createNote('Child', 'model-a', h.doc, h.mapPath, 'workspace'); child.parentId = h.topic.id; h.doc.nodes.push(child); await h.repo.saveMap(h.mapPath, h.doc);
  await h.repo.updateNote(h.topic.path, { status: 'completed' });
  await h.view.startSynthesis(h.topic, { researchMode: 'local', researchDepth: 'normal', visualMode: 'off', referenceGroups: [] }, 'Compare them', message => assert.fail(message), () => {});
  await until(() => !h.plugin.running.size);
  assert.equal(blockNotices(h.notices).length, 1, 'one synthesis');
});
integrationTest('FB1 F1: a multi-topic research batch raises the Notice once, not once per topic', async () => {
  const h = await templateHarness({ language: 'en', settings: badBlockSettings });
  await installBadBlock(h.plugin);
  const second = await h.repo.createNote('Second', 'model-a', h.doc, h.mapPath, 'workspace'); h.doc.nodes.push(second); await h.repo.saveMap(h.mapPath, h.doc);
  const third = await h.repo.createNote('Third', 'model-a', h.doc, h.mapPath, 'workspace'); h.doc.nodes.push(third); await h.repo.saveMap(h.mapPath, h.doc);
  await h.repo.updateNote(second.path, { prompt: 'Research second' }); await h.repo.updateNote(third.path, { prompt: 'Research third' });
  h.plugin.confirmAiUsage = async (_model, run) => { await run(); return true; };
  h.view.selection.replaceMulti([h.topic.id, second.id, third.id]);
  await h.view.startMultiResearch({ researchMode: 'local', researchDepth: 'fast', requirements: '' });
  await until(() => h.contexts.length === 3 && !h.plugin.running.size);
  assert.equal(blockNotices(h.notices).length, 1);
});
integrationTest('M1: an outline import with shallow research and an unreadable template block raises exactly one Notice', async () => {
  const h = await templateHarness({ language: 'en', settings: badBlockSettings });
  await installBadBlock(h.plugin);
  h.plugin.confirmAiUsage = async (_model, run) => { await run(); return true; };
  const nodes = [{ title: 'Root', level: 1, parent: null, line: 1 }, { title: 'One', level: 2, parent: 0, line: 2 }, { title: 'Two', level: 2, parent: 0, line: 3 }];
  await h.view.importOutline({ nodes, source: null, shallowResearch: true, placement: { kind: 'tree' } });
  await until(() => h.contexts.length === 2 && !h.plugin.running.size);
  assert.equal(h.contexts.length, 2, 'the shallow research really ran for both children');
  assert.equal(blockNotices(h.notices).length, 1, 'one operation, one Notice');
});
integrationTest('FB1 F2: an unreadable block with the output language different from the interface language falls back to the built-in template in the output language, and keeps file and line', async () => {
  const h = await templateHarness({ language: 'zh-TW', settings: badBlockSettings, reply: () => ({ summary: 'English summary', detail: '### Core conclusions\n\nC', visualReferences: [], suggestions: [] }) });
  await installBadBlock(h.plugin);
  const handle = await h.view.runAgent(h.topic, undefined, message => assert.fail(message), { outputLanguage: 'en' });
  await handle?.finished; await until(() => !h.plugin.running.size);
  const context = h.contexts[0];
  assert.equal(context.detailTemplate.id, 'standard');
  assert.equal(context.detailTemplate.sections[0].name, 'Core conclusions', 'the stand-in is in the output language');
  assert.equal(context.styleSelection.template.fileName, 'Bad.md', 'the block still travels with the run');
  const { AiTaskService } = load('core/ai-task-service.ts');
  const prompts = [];
  const runtime = { runTask: async prompt => { prompts.push(prompt); return JSON.stringify({ summary: 'S', detail: 'D', suggestions: [], visualReferences: [] }); } };
  const service = new AiTaskService({ pluginDirectory: () => '/plugin', language: () => 'zh-TW', defaultReasoning: () => 'low', exchangeLoggingEnabled: () => false, diagramsEnabled: () => false, mermaidParses: async () => true, codexRuntime: () => runtime, claudeRuntime: () => runtime });
  const { detailTemplate: _skip, ...rest } = context;
  await service.askModel({ ...rest, detailTemplate: context.detailTemplate, outputLanguage: 'en' }, 'gpt-6-luna', 'low');
  assert.match(prompts[0], /Core conclusions/, 'the prompt carries the English built-in headings');
  assert.doesNotMatch(prompts[0], /核心結論/, 'no interface-language headings');
  const note = await h.repo.readNote(h.topic.path);
  assert.deepEqual(note.detail.split('\n').filter(line => line.startsWith('### ')).slice(0, 2), ['### Core conclusions', '### Background and mechanism']);
  assert.equal(blockNotices(h.notices).length, 1);
  assert.match(String(blockNotices(h.notices)[0]), /line 3/);
});
integrationTest('runAgent: an edited copy of a built-in structure file does not replace the built-in, and raises no Notice (04; was: a changed built-in block keeps its text in the run context; decisions #22, grilling Q10)', async () => {
  const changed = '## Alpha\nDescribe alpha.\n\n## Beta\nDescribe beta.\n\n# Format rules\n\nFORMAT-LINE-MINE\n';
  const h = await templateHarness({ language: 'en', settings: { workspaceFolder: 'WS', noteStylesFolder: 'WS/S', noteStyleByKind: { topic: 'builtin:general' } } });
  await installStyleFiles(h.plugin, { 'WS/S/Structures/Standard six.md': changed });
  await h.run();
  assert.equal(h.contexts[0].detailTemplate.id, 'standard');
  assert.equal(h.contexts[0].detailTemplate.sections[0].name, 'Core conclusions', 'the built-in structure stands');
  assert.equal(h.contexts[0].styleSelection, undefined, 'no file text travels with the run');
  assert.deepEqual(h.notices, []);
});
integrationTest('runAgent: a structure file that still has a format rules heading runs on its sections and raises no Notice (04 counter 4; was: two format headings were an unreadable block, grilling Q1)', async () => {
  const files = { 'WS/S/Styles/Bad.md': '---\nstructure: Bad\n---\n', 'WS/S/Structures/Bad.md': '## A\nbody\n# Format rules\nr\n# Format rules\nr2\n' };
  const h = await templateHarness({ language: 'en', settings: badBlockSettings });
  await installStyleFiles(h.plugin, files);
  await h.run();
  assert.equal(h.contexts.length, 1);
  assert.deepEqual(plain(h.contexts[0].detailTemplate.sections.map(section => section.name)), ['A']);
  assert.equal(h.contexts[0].styleSelection.template.fileName, 'Bad.md');
  assert.deepEqual(h.notices, [], 'the format rules zone is only noted, not an error');
});
integrationTest('runAgent: choosing a style (a built-in or a style file) for a run is used by that run only and is the whole style, the topic tone stays on the note (was: choosing a template, the topic tone still applied; grilling Q18, D2)', async () => {
  const h = await templateHarness({ language: 'en', settings: { workspaceFolder: 'WS', noteStylesFolder: 'WS/S' } });
  await installStyleFiles(h.plugin, { 'WS/S/Styles/Mine.md': '---\nstructure: Mine\nvoice: Practical guide\n---\n', 'WS/S/Structures/Mine.md': '## Mine\nx\n' });
  await h.repo.updateNote(h.topic.path, { toneId: 'plain' });
  const chosen = await h.view.detailTemplateFor({ path: h.topic.path }, 'builtin:textbook');
  assert.equal(chosen.template.id, 'textbook');
  assert.deepEqual([(await h.repo.readNote(h.topic.path)).detailTemplateId, (await h.repo.readNote(h.topic.path)).toneId], [undefined, 'plain']);
  const file = await h.view.detailTemplateFor({ path: h.topic.path }, 'file:Mine');
  assert.equal(file.template.id, 'file:Mine');
  assert.equal(file.recipe.ref, 'file:Mine'); assert.equal(file.recipe.source, 'run');
  assert.equal(file.toneText, h.plugin.noteStyles.runStyle({ choice: { style: 'file:Mine' }, kind: 'topic', outputLanguage: 'en' }).toneText, 'the voice is the chosen style\'s own, not the topic tone');
  assert.notEqual(file.toneText, toneTexts('en').plain, 'the topic tone does not mix into a whole-style choice');
  const note = await h.repo.readNote(h.topic.path);
  assert.equal(note.detailTemplateId, undefined); assert.equal(note.toneId, 'plain', 'nothing is written to the topic'); assert.equal(note.noteStyle, undefined);
});
integrationTest('runAgent saves detail with the template order and stores formatIssues text; clears it when met', async () => {
  const template = { id: 'T', name: 'Counted', sections: [templateSection('t0', '結論'), templateSection('t1', '範例', { count: { mode: 'exact', n: 3 } }), templateSection('t2', '來源', { role: 'sources' })] };
  const picture = { title: 'Pic', imageUrl: 'https://example.com/a.png', sourceUrl: 'https://example.com/page', description: '', palette: [], formula: '' };
  const h = await templateHarness({ settings: { detailTemplates: [template] }, reply: (_context, call) => call === 1
    ? { summary: 'S1', detail: '### 範例\n\n- one\n\n### 結論\n\nConclusion text', suggestions: [], visualReferences: [picture], formatIssues: [{ section: '範例', mode: 'exact', n: 3, actual: 1 }] }
    : { summary: 'S2', detail: '### 結論\n\nDone\n\n### 範例\n\n- a\n- b\n- c', suggestions: [], visualReferences: [], formatIssues: [] } });
  await h.repo.updateNote(h.topic.path, { detailTemplateId: 'T' });
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
integrationTest('a deleted topic template notifies on each run, keeps the field and falls back to the topic type style (was: notified once, cleared the field, fell back to the map template; grilling Q5/Q18, counterexample 14)', async () => {
  const h = await templateHarness({ language: 'en', settings: { detailTemplates: sampleTemplates(), noteStyleByKind: { topic: 'builtin:textbook' } }, mapTemplate: 'B' });
  await h.repo.updateNote(h.topic.path, { detailTemplateId: 'gone' });
  await h.run();
  assert.equal(h.contexts[0].detailTemplate.id, 'standard', 'the structure of an unreadable old template is Standard; the map template is not read');
  assert.equal(h.notices.length, 1, h.notices.join('|'));
  assert.match(String(h.notices[0]), /"gone" no longer exists/);
  assert.deepEqual(require('../support-dom.cjs').findAll(h.notices[0], i => i.tag === 'button').map(b => b.text), ['Use another style'], 'every unreadable source offers the topic style chooser (#45, D5)');
  const note = await h.repo.readNote(h.topic.path);
  assert.equal(note.detailTemplateId, 'gone', 'the note keeps its old value');
  assert.equal(note.summary, 'Saved summary');
  await h.run();
  assert.equal(h.contexts[1].detailTemplate.id, 'standard');
  assert.equal(h.notices.length, 2, 'it is told again, nothing was cleared');
});
integrationTest('an explicit choice is used by that run only and its reply still saves (was: also recorded on the topic as detailTemplateId; grilling Q18, D2)', async () => {
  const h = await templateHarness({ language: 'en', settings: { detailTemplates: sampleTemplates(), defaultDetailTemplateId: 'C', workspaceFolder: 'WS', noteStylesFolder: 'WS/S' }, reply: () => ({ summary: 'Chosen summary', detail: '### Alpha\n\nBody', visualReferences: [], suggestions: [] }) });
  await installStyleFiles(h.plugin, { 'WS/S/Styles/Chosen.md': '---\nstructure: Chosen\n---\n', 'WS/S/Structures/Chosen.md': '## Alpha\nx\n\n## Beta\ny\n' });
  await h.view.researchChild(h.topic, new AbortController().signal, () => {}, { researchMode: 'local', researchDepth: 'fast', visualMode: 'off', referenceGroups: [], noteStyle: 'file:Chosen' });
  await until(() => !h.plugin.running.size);
  assert.equal(h.contexts[0].detailTemplate.id, 'file:Chosen');
  const note = await h.repo.readNote(h.topic.path);
  assert.equal(note.detailTemplateId, undefined, 'the topic is not changed'); assert.equal(note.noteStyle, undefined);
  assert.equal(note.summary, 'Chosen summary');
  assert.ok(!h.notices.some(message => /outdated/.test(message)), h.notices.join('|'));
  assert.match(note.detail, /^### Alpha/);
});
integrationTest('synthesis, integrated topics and contributions save with the template of the topic type style (was: the map template; grilling Q5/Q15)', async () => {
  const reply = (_context, call) => call === 1
    ? { summary: '', detail: '', visualReferences: [], suggestions: [{ title: 'Angle', task: 'Compare them', contribution: '', parentTitle: '' }] }
    : { summary: 'Synth', detail: '### Second part\n\nTwo\n\n### First part\n\nOne', visualReferences: [], suggestions: [] };
  const h = await templateHarness({ language: 'en', settings: { workspaceFolder: 'WS', noteStylesFolder: 'WS/S', noteStyleByKind: { topic: 'file:Custom' } }, mapTemplate: 'Y', reply });
  await installStyleFiles(h.plugin, { 'WS/S/Styles/Custom.md': '---\nstructure: Custom\n---\n', 'WS/S/Structures/Custom.md': '## First part\nA\n\n## Second part\nB\n\n## Refs\nC\n' });
  const child = await h.repo.createNote('Child', 'model-a', h.doc, h.mapPath, 'workspace'); child.parentId = h.topic.id; h.doc.nodes.push(child); await h.repo.saveMap(h.mapPath, h.doc);
  await h.repo.updateNote(h.topic.path, { status: 'completed' });
  const options = () => ({ researchMode: 'local', researchDepth: 'normal', visualMode: 'off', referenceGroups: [] });
  await h.view.startSynthesis(h.topic, options(), null, message => assert.fail(message), () => {});
  await h.view.startSynthesis(h.topic, options(), 'Compare them', message => assert.fail(message), () => {});
  assert.equal(h.contexts.at(-1).detailTemplate.id, 'file:Custom');
  assert.equal(h.view.synthesisTasks.has(h.topic.path), false, 'written directly');
  const parent = await h.repo.readNote(h.topic.path);
  assert.ok(parent.detail.indexOf('### First part') < parent.detail.indexOf('### Second part'), parent.detail);
  assert.ok(!/### Core conclusions/.test(parent.detail), parent.detail);
  const other = await h.repo.createNote('Other', 'model-a', h.doc, h.mapPath, 'workspace'); h.doc.nodes.push(other); await h.repo.saveMap(h.mapPath, h.doc);
  await h.view.createIntegratedNode('Combined', [h.topic, other], 'Compare', '');
  assert.equal(h.contexts.at(-1).detailTemplate.id, 'file:Custom');
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
// The topic type's style file carries a voice (every built-in style is academic), so a default tone comes from the topic type, not the map.
const voicedSettings = { workspaceFolder: 'WS', noteStylesFolder: 'WS/S', noteStyleByKind: { topic: 'file:Voiced' } };
const installVoiced = (plugin, voice) => installStyleFiles(plugin, { 'WS/S/Styles/Voiced.md': `---\nvoice: ${voice}\n---\n` });
integrationTest('tone: runAgent resolves run > topic override > topic type voice > academic, and the map tone is not read, and the prompt carries the tone block (was: topic override > map default > academic; grilling Q5/Q15)', async () => {
  const tones = toneTexts('en');
  const presets = [{ id: 'mine', kind: 'tone', name: 'Mine', text: 'Write like a friendly neighbour.' }];
  const bare = await templateHarness({ language: 'en', settings: { promptPresets: presets } });
  bare.doc.toneId = 'plain';
  await bare.run();
  assert.equal('toneText' in bare.contexts.at(-1), false, 'no tone: prompts unchanged, and the map tone does not count');
  const h = await templateHarness({ language: 'en', settings: { ...voicedSettings, promptPresets: presets } });
  await installVoiced(h.plugin, 'plain');
  await h.run();
  assert.equal(h.contexts.at(-1).toneText, tones.plain);
  assert.ok(renderTaskPrompt(h.contexts.at(-1), 'en').includes(tones.plain), 'the rendered prompt contains the tone text');
  await h.repo.updateNote(h.topic.path, { toneId: 'mine' }); await h.run();
  assert.equal(h.contexts.at(-1).toneText, 'Write like a friendly neighbour.');
  await h.repo.updateNote(h.topic.path, { toneId: 'academic' }); await h.run();
  assert.equal('toneText' in h.contexts.at(-1), false, 'an explicit academic topic override beats the topic type voice');
  assert.ok(!renderTaskPrompt(h.contexts.at(-1), 'en').includes(tones.plain) && !renderTaskPrompt(h.contexts.at(-1), 'en').includes(tones.academic), 'academic adds no tone block');
  await h.repo.updateNote(h.topic.path, { toneId: 'gone' }); await h.run();
  assert.equal('toneText' in h.contexts.at(-1), false, 'a deleted topic tone is academic rigor in the topic\'s own implicit style (was: fell through to the map default)');
});
integrationTest('tone: a dialog style choice brings its own voice for that run only and is not recorded on the topic (single and batch research) (was: a toneId choice; grilling Q18, D2)', async () => {
  const tones = toneTexts('en');
  const h = await templateHarness({ language: 'en', settings: { workspaceFolder: 'WS', noteStylesFolder: 'WS/S' } });
  await installStyleFiles(h.plugin, { 'WS/S/Styles/Magazine.md': '---\nvoice: magazine\n---\n' });
  await h.view.researchChild(h.topic, new AbortController().signal, () => {}, { researchMode: 'local', researchDepth: 'fast', visualMode: 'off', referenceGroups: [], noteStyle: 'file:Magazine' });
  await until(() => !h.plugin.running.size);
  assert.equal(h.contexts.at(-1).toneText, tones.magazine);
  assert.equal((await h.repo.readNote(h.topic.path)).toneId, undefined, 'the topic keeps no tone'); assert.equal((await h.repo.readNote(h.topic.path)).noteStyle, undefined);
  await h.view.researchChild(h.topic, new AbortController().signal, () => {}, { researchMode: 'local', researchDepth: 'fast', visualMode: 'off', referenceGroups: [] });
  await until(() => !h.plugin.running.size);
  assert.equal('toneText' in h.contexts.at(-1), false, 'no choice: the next run is back on the topic type voice');
});
integrationTest('tone: expansion, synthesis directions, draft and integrated topics all pass toneText of the topic type voice (was: the map tone; grilling Q5/Q15)', async () => {
  const tones = toneTexts('en');
  const reply = (_context, call) => call === 1
    ? { summary: '', detail: '', visualReferences: [], suggestions: [{ title: 'Angle', task: 'Compare them', contribution: '', parentTitle: '' }] }
    : { summary: 'Synth', detail: '### Core conclusions\n\nTwo', visualReferences: [], suggestions: [] };
  const h = await templateHarness({ language: 'en', reply, settings: voicedSettings });
  await installVoiced(h.plugin, 'summary');
  h.doc.toneId = 'plain';
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
  assert.equal(h.contexts.at(-1).toneText, tones.summary, 'multi-select integration uses the topic type voice, not the map tone');
  delete h.plugin.settings.noteStyleByKind.topic;
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
integrationTest('expand without shallow research: the chosen style shapes contributions for this batch only and is recorded on no new child (was: recorded on the new children; Q18, C5, #44)', async () => {
  const reply = () => ({ summary: '', detail: '', visualReferences: [], suggestions: [contributedSuggestion('One'), contributedSuggestion('Two'), contributedSuggestion('Three')] });
  const h = await templateHarness({ language: 'en', settings: { workspaceFolder: 'WS', noteStylesFolder: 'WS/S' }, reply });
  await installStyleFiles(h.plugin, { 'WS/S/Styles/X.md': '---\nstructure: X\n---\n', 'WS/S/Structures/X.md': '## First part\nA\n\n## Second part\nB\n' });
  const options = { researchMode: 'local', researchDepth: 'fast', visualMode: 'off', referenceGroups: [], shallowResearch: false, noteStyle: 'file:X' };
  let create;
  await h.view.proposeChildren(h.topic, options, '', (items, run) => { create = () => run(items.slice(0, 1)); }, message => assert.fail(message));
  assert.ok(create, 'suggestions were presented');
  await create();
  const saved = await h.repo.readMap(h.mapPath);
  const child = await h.repo.readNote(saved.nodes.find(node => node.parentId === h.topic.id).path);
  assert.equal(child.detailTemplateId, undefined, 'no child records the chosen style'); assert.equal(child.noteStyle, undefined); assert.equal(child.toneId, undefined);
  assert.match(child.detail, /^### First part\n\nA\n\n### Second part\n\nB$/);
  assert.equal(h.contexts.length, 1, 'no research ran');
});
integrationTest('opening the selection synthesis dialog for a topic with a deleted template neither notifies nor rewrites the note (the label is the topic type\'s structure, not the map template; grilling Q5/Q15)', async () => {
  const opened = [], notices = [];
  const h = await templateHarness({ language: 'en', settings: { detailTemplates: sampleTemplates() }, mapTemplate: 'B' });
  await h.repo.updateNote(h.topic.path, { detailTemplateId: 'gone' });
  const before = await h.app.vault.read(h.app.vault.getAbstractFileByPath(h.topic.path));
  const { VisualAgentMapView } = load('main.ts', { obsidian: { ...obsidian, Modal: class { constructor() {} open() { opened.push(this); } close() {} }, Notice: class { constructor(message) { notices.push(message); } } } });
  const view = new VisualAgentMapView({ app: h.app }, attachTopicRuns(h.plugin)); view.path = h.mapPath; view.map = h.doc; view.render = () => {};
  const other = await h.repo.createNote('Other', 'model-a', h.doc, h.mapPath, 'workspace'); h.doc.nodes.push(other); await h.repo.saveMap(h.mapPath, h.doc);
  view.selection.replaceMulti([h.topic.id, other.id]);
  view.openSelectionSynthesis(null);
  await until(() => opened.length === 1);
  assert.equal('currentTemplate' in opened[0].selectionFlow.fields, false, 'the dialog gets one style name, not template and tone lists');
  opened[0].close();
  assert.deepEqual(notices, []);
  assert.equal(await h.app.vault.read(h.app.vault.getAbstractFileByPath(h.topic.path)), before, 'note file unchanged');
  assert.equal((await h.repo.readNote(h.topic.path)).detailTemplateId, 'gone');
});
integrationTest('opening the selection synthesis dialog reads the style files again first, so a style made since the last run is named on the line (#38, counter-example 10)', async () => {
  const opened = [];
  const h = await templateHarness({ language: 'en', settings: { workspaceFolder: 'WS', noteStylesFolder: 'WS/S', noteStyleByKind: { topic: 'file:Fresh' } } });
  const files = {};
  const port = { list: async folder => Object.keys(files).filter(f => f.startsWith(`${folder}/`)).map(f => f.slice(folder.length + 1)), read: async f => files[f], folderExists: folder => Object.keys(files).some(f => f.startsWith(`${folder}/`)), createFolder: async () => {}, create: async () => {}, trash: async () => {} };
  const { NoteStyleStore } = load('ai/note-style-store.ts');
  h.plugin.noteStyles = new NoteStyleStore({ settings: () => h.plugin.settings, port, save: async () => {} });
  await h.plugin.noteStyles.refresh(); // the cache knows no style file
  files['WS/S/Styles/Fresh.md'] = '---\nvoice: plain\n---\n'; // made after the last refresh
  await h.repo.updateNote(h.topic.path, { noteStyle: 'file:Fresh' });
  const other = await h.repo.createNote('Other', 'model-a', h.doc, h.mapPath, 'workspace'); h.doc.nodes.push(other); await h.repo.saveMap(h.mapPath, h.doc);
  const { VisualAgentMapView } = load('main.ts', { obsidian: { ...obsidian, Modal: class { constructor() {} open() { opened.push(this); } close() {} }, Notice: class {} } });
  const view = new VisualAgentMapView({ app: h.app }, attachTopicRuns(h.plugin)); view.path = h.mapPath; view.map = h.doc; view.render = () => {};
  // The selection synthesis shows the topic type\'s style (no topic).
  h.plugin.settings.noteStyleByKind = { topic: 'file:Fresh' };
  view.selection.replaceMulti([h.topic.id, other.id]);
  view.openSelectionSynthesis(null);
  await until(() => opened.length === 1);
  assert.equal(opened[0].selectionFlow.fields.currentStyle, 'Fresh', 'the dialog names the style file made since the last refresh');
  // A second file made after the dialog above is read again on the next open.
  await h.plugin.noteStyles.refresh();
  files['WS/S/Styles/Newer.md'] = '---\nvoice: plain\n---\n';
  h.plugin.settings.noteStyleByKind = { topic: 'file:Newer' };
  view.openSelectionSynthesis(null);
  await until(() => opened.length === 2);
  assert.equal(opened[1].selectionFlow.fields.currentStyle, 'Newer');
});
integrationTest('no templates, zh-TW interface, English output: Standard follows the output language in the request and the saved note', async () => {
  const h = await templateHarness({ language: 'zh-TW', reply: () => ({ summary: 'English summary', detail: '### Core conclusions\n\nC\n\n### Key knowledge\n\nK', visualReferences: [], suggestions: [] }) });
  const handle = await h.view.runAgent(h.topic, undefined, message => assert.fail(message), { outputLanguage: 'en' });
  await handle?.finished; await until(() => !h.plugin.running.size);
  assert.equal(h.contexts[0].detailTemplate.id, 'standard');
  assert.equal(h.contexts[0].detailTemplate.sections[0].name, 'Core conclusions');
  const note = await h.repo.readNote(h.topic.path);
  assert.equal(note.summary, 'English summary');
  assert.deepEqual(note.detail.split('\n').filter(line => line.startsWith('### ')), ['### Core conclusions', '### Background and mechanism', '### Disagreements and limits', '### Open questions to check', '### Sources', '### Update log']);
  assert.match(note.detail, /### Core conclusions\n\nC\n\n### Background and mechanism\n\nK/);
});
integrationTest('multi research with a chosen style uses it for each started topic and records it on none (skipped topics untouched; was: a chosen template, recorded on each started topic; grilling Q18, D2)', async () => {
  const h = await templateHarness({ language: 'en', settings: { detailTemplates: sampleTemplates(), defaultDetailTemplateId: 'C', workspaceFolder: 'WS', noteStylesFolder: 'WS/S' } });
  await installStyleFiles(h.plugin, { 'WS/S/Styles/A.md': '---\nstructure: A\n---\n', 'WS/S/Structures/A.md': '## A\nx\n' });
  const second = await h.repo.createNote('Second', 'model-a', h.doc, h.mapPath, 'workspace'); h.doc.nodes.push(second); await h.repo.saveMap(h.mapPath, h.doc);
  const third = await h.repo.createNote('Third', 'model-a', h.doc, h.mapPath, 'workspace'); h.doc.nodes.push(third); await h.repo.saveMap(h.mapPath, h.doc);
  await h.repo.updateNote(second.path, { prompt: 'Research second' }); await h.repo.updateNote(third.path, { prompt: 'Research third' });
  h.plugin.confirmAiUsage = async (_model, run) => { await run(); return true; };
  h.plugin.running.add(third.path); // busy: skipped before any write
  h.view.selection.replaceMulti([h.topic.id, second.id, third.id]);
  await h.view.startMultiResearch({ researchMode: 'local', researchDepth: 'fast', requirements: '', noteStyle: 'file:A' });
  await until(() => h.contexts.length === 2 && !h.plugin.running.has(h.topic.path) && !h.plugin.running.has(second.path));
  assert.deepEqual(h.contexts.map(context => context.detailTemplate.id), ['file:A', 'file:A']);
  assert.equal((await h.repo.readNote(h.topic.path)).detailTemplateId, undefined);
  assert.equal((await h.repo.readNote(second.path)).detailTemplateId, undefined);
  assert.equal((await h.repo.readNote(third.path)).detailTemplateId, undefined);
});
// T6 P3: the topic's own note style chooser replaces the map style and map tone lists (grilling Q15/Q17, C5, #15, #45).
const OLD_PAIR = { detailTemplateId: 'textbook', toneId: 'plain' };
async function chooserHarness(patch = {}, { settings = {}, files = {} } = {}) {
  const h = await templateHarness({ language: 'en', captureModals: 'dom', settings: { workspaceFolder: 'WS', noteStylesFolder: 'WS/S', ...settings } });
  await installStyleFiles(h.plugin, files);
  if (Object.keys(patch).length) await h.repo.updateNote(h.topic.path, patch);
  const file = h.app.vault.getAbstractFileByPath(h.topic.path);
  const read = () => h.app.vault.read(file);
  const pending = []; h.view.enqueue = work => { const done = work(); pending.push(done); return done; }; h.view.hydrate = async () => {}; h.view.render = () => {};
  const dom = require('../support-dom.cjs');
  const radios = modal => dom.findAll(modal.contentEl, i => i.attrs.role === 'radio');
  const nameOf = row => dom.find(row, i => (i.cls ?? '').split(/\s+/).includes('vam-picker-name')).text.replace(/ · Current setting$/, '');
  const pick = (modal, label) => radios(modal).find(row => nameOf(row) === label);
  const button = (modal, text) => dom.button(modal.modalEl, text);
  // Choose a row, then press Apply: the write is queued by the view and awaited here.
  const choose = async (modal, label) => { pick(modal, label).click(); button(modal, 'Apply').click(); await Promise.all(pending); };
  let processes = 0; const process = h.app.vault.process.bind(h.app.vault); h.app.vault.process = (f, fn) => { processes++; return process(f, fn); };
  const open = async () => { await h.view.chooseTopicStyle(h.topic); return h.modals.at(-1); };
  return { ...h, read, open, radios, nameOf, pick, button, choose, processes: () => processes };
}
const withoutKeys = (text, keys) => text.split('\n').filter(line => !keys.some(key => line.startsWith(`${key}:`))).join('\n');
integrationTest('topic style picker: the one in force is first and marked, then the old pair row, four rows on show and the rest under "Other N styles", never the AIM report; opening writes nothing (counterexample 8; was: the rows of the choice list)', async () => {
  const h = await chooserHarness(OLD_PAIR, { files: { 'WS/S/Styles/Mine.md': '---\nstructure: Standard\n---\n', 'WS/S/Styles/Broken.md': '---\nstructure: Nope\nupdate: bogus\n---\n' } });
  const modal = await h.open();
  assert.equal(modal.titleEl.text, 'Note style of this topic');
  const rows = h.radios(modal);
  assert.equal(h.nameOf(rows[0]), 'Old setting (Intro + six · Plain explanation)'); assert.equal(rows[0].attrs['aria-checked'], 'true', 'a topic with only the old pair is on the old setting, first and marked');
  assert.equal(h.nameOf(rows[1]), 'Follow the topic type (General research)'); assert.equal(rows[1].attrs['aria-checked'], 'false');
  const labels = rows.map(h.nameOf);
  assert.ok(!labels.some(label => /AIM/i.test(label)), labels.join('|'));
  assert.ok(labels.includes('Textbook'), labels.join('|'));
  const more = require('../support-dom.cjs').find(modal.contentEl, i => i.attrs['aria-expanded'] !== undefined);
  assert.match(more.text, /^Other \d+ styles$/);
  assert.equal(h.processes(), 0, 'opening the picker writes nothing');
});
integrationTest('topic style chooser: Follow the topic type removes note-style, detail-template and tone, keeps every other line and the body, leaves updated alone, and undo gives the file back byte for byte (counterexample 1, #15; was: map style chosen on the map)', async () => {
  const h = await chooserHarness({ ...OLD_PAIR, noteStyle: 'builtin:evidence' });
  const before = await h.read();
  assert.ok(/^tone: /m.test(before) && /^detail-template: /m.test(before) && /^note-style: /m.test(before));
  const modal = await h.open();
  assert.equal(h.nameOf(h.radios(modal)[0]), 'Evidence record', 'the stored note-style is the one in force, first'); assert.equal(h.radios(modal)[0].attrs['aria-checked'], 'true');
  await h.choose(modal, 'Follow the topic type (General research)');
  const after = await h.read();
  assert.equal(after, withoutKeys(before, ['note-style', 'detail-template', 'tone']), 'only the three keys are gone: other lines, updated and the body keep their bytes');
  assert.equal(h.view.history.past.length, 1);
  await h.view.travel(false);
  assert.equal(await h.read(), before, 'undo restores the file byte for byte');
});
integrationTest('topic style chooser: choosing a style writes note-style only and keeps the old detail-template and tone lines byte for byte (counterexample 2, #4)', async () => {
  const h = await chooserHarness(OLD_PAIR);
  const before = await h.read();
  await h.choose(await h.open(), 'Textbook');
  const after = await h.read();
  assert.equal(withoutKeys(after, ['note-style']), before, 'nothing but the note-style line is new');
  assert.match(after, /^note-style: "builtin:textbook"$/m);
  assert.ok(/^detail-template: /m.test(after) && /^tone: /m.test(after));
  const second = await h.open();
  assert.equal(h.nameOf(h.radios(second)[0]), 'Textbook', 'the new choice is the one in force, first, when the picker opens again'); assert.equal(h.radios(second)[0].attrs['aria-checked'], 'true');
  assert.ok(!h.radios(second).some(row => /^Old setting/.test(h.nameOf(row))), 'a topic with note-style no longer reads its old pair');
});
integrationTest('topic style picker: choosing alone writes nothing; the row in force leaves Apply disabled; Cancel and Esc write nothing and add no history (counterexample 3)', async () => {
  const h = await chooserHarness({ noteStyle: 'builtin:evidence' });
  const modal = await h.open();
  h.pick(modal, 'Atomic note').click();
  assert.equal(h.processes(), 0, 'choosing writes nothing'); assert.equal(h.view.history.past.length, 0);
  h.pick(modal, 'Evidence record').click();
  assert.equal(h.button(modal, 'Apply').disabled, true); h.button(modal, 'Apply').click(); await Promise.resolve();
  assert.equal(h.processes(), 0); assert.equal(h.view.history.past.length, 0);
  h.pick(modal, 'Atomic note').click(); h.button(modal, 'Cancel').click();
  assert.equal(h.processes(), 0); assert.equal(h.view.history.past.length, 0);
  const bare = await chooserHarness();
  const second = await bare.open();
  assert.equal(bare.nameOf(bare.radios(second)[0]), 'Follow the topic type (General research)'); assert.equal(bare.radios(second)[0].attrs['aria-checked'], 'true', 'a topic with no style follows the topic type');
  bare.pick(second, 'Textbook').click(); second.close();
  assert.equal(bare.processes(), 0); assert.equal(bare.view.history.past.length, 0);
});
integrationTest('topic style chooser: refuses presentation mode, and re-reads the style folder before it opens (counterexample 15; the new style file is listed)', async () => {
  const h = await chooserHarness();
  h.view.presentation = { order: [], currentId: 'x' }; await h.view.chooseTopicStyle(h.topic); assert.equal(h.modals.length, 0); h.view.presentation = null;
  const files = {}; const { NoteStyleStore } = load('ai/note-style-store.ts');
  const port = { list: async folder => Object.keys(files).filter(f => f.startsWith(`${folder}/`)).map(f => f.slice(folder.length + 1)), read: async f => files[f], folderExists: folder => Object.keys(files).some(f => f.startsWith(`${folder}/`)), createFolder: async () => {}, create: async () => {}, trash: async () => {} };
  h.plugin.noteStyles = new NoteStyleStore({ settings: () => h.plugin.settings, port, save: async () => {} }); await h.plugin.noteStyles.refresh();
  files['WS/S/Styles/Fresh.md'] = '---\nvoice: magazine\n---\n';
  const fresh = await h.open(); assert.ok(h.radios(fresh).some(row => h.nameOf(row) === 'Fresh'), plain(h.radios(fresh).map(h.nameOf)).join('|'));
});
integrationTest('topic style chooser (counterexample 16, keyboard): the focus goes back to the topic card after Cancel and after a choice is written', async () => {
  const h = await chooserHarness();
  let focused = 0; h.view.cardEls = new Map([[h.topic.id, { focus: () => focused++ }]]);
  const modal = await h.open();
  modal.close(); assert.equal(focused, 1, 'Cancel / Escape');
  await h.choose(modal, 'Textbook'); assert.equal(focused, 2, 'after the write');
});
integrationTest('R1-L1 / counterexample 11: a topic tone that is gone is told once at the research entry with Use another style, the voice is academic and the note is not rewritten', async () => {
  const h = await templateHarness({ language: 'en', captureModals: true });
  await h.repo.updateNote(h.topic.path, { toneId: 'gone' });
  const before = await h.app.vault.read(h.app.vault.getAbstractFileByPath(h.topic.path));
  await h.run();
  assert.equal('toneText' in h.contexts.at(-1), false, 'academic rigor adds no tone text');
  assert.equal(h.notices.length, 1, h.notices.map(String).join('|'));
  assert.match(String(h.notices[0]), /The writing voice "gone" was not found; this topic now uses Professional\./);
  assert.deepEqual(require('../support-dom.cjs').findAll(h.notices[0], i => i.tag === 'button').map(b => b.text), ['Use another style']);
  const after = await h.app.vault.read(h.app.vault.getAbstractFileByPath(h.topic.path));
  assert.equal(after.includes('tone: "gone"') || after.includes('tone: gone'), true, 'the note keeps the tone');
  assert.equal(before.split('\n').filter(l => l.startsWith('tone:')).length, 1);
});
integrationTest('counterexample 12 and the Notice action: an unreadable note-style file is told with Use another style, and the button opens the same topic chooser; the note is not rewritten', async () => {
  const h = await templateHarness({ language: 'en', captureModals: 'dom', settings: { workspaceFolder: 'WS', noteStylesFolder: 'WS/S' } });
  await installStyleFiles(h.plugin, {});
  h.view.enqueue = work => work();
  await h.repo.updateNote(h.topic.path, { noteStyle: 'file:Deleted' });
  await h.run();
  const before = await h.app.vault.read(h.app.vault.getAbstractFileByPath(h.topic.path));
  assert.equal(h.notices.length, 1); assert.match(String(h.notices[0]), /"Deleted\.md" is missing/);
  const button = require('../support-dom.cjs').findAll(h.notices[0], i => i.tag === 'button')[0];
  button.click(); await until(() => h.modals.length === 1);
  assert.equal(h.modals[0].titleEl.text, 'Note style of this topic');
  assert.equal(await h.app.vault.read(h.app.vault.getAbstractFileByPath(h.topic.path)), before, 'the Notice and the picker write nothing');
});
integrationTest('run-style P3: the style line of the synthesis dialog names the style the run really uses (topic type voice, topic override, topic style file; the map tone and the workspace tone block are not read; was: "Keep as is (…)" naming style and tone; grilling Q5/Q10/Q15, D3)', async () => {
  const FILES = { 'WS/S/Voices/Pirate.md': 'Talk like a pirate.', 'WS/S/Styles/Pirated.md': '---\nvoice: Pirate\n---\n', 'WS/S/Styles/Own.md': '---\nvoice: plain\n---\n' };
  const { NoteStyleStore } = load('ai/note-style-store.ts');
  const cases = [
    { name: 'topic type voice', tone: 'Pirate', style: 'Pirated', note: {}, map: {} },
    { name: 'topic override', tone: 'Plain explanation', style: 'Old setting (Standard six · Plain explanation)', note: { toneId: 'plain' }, map: {} },
    { name: 'map tone is not read', tone: 'Pirate', style: 'Pirated', note: {}, map: { toneId: 'plain' } },
    { name: 'topic style file with its own voice', tone: 'Plain explanation', style: 'Own', note: { noteStyle: 'file:Own' }, map: {} }
  ];
  for (const row of cases) {
    const opened = [];
    const h = await templateHarness({ language: 'en', settings: { workspaceFolder: 'WS', noteStylesFolder: 'WS/S', noteStyleByKind: { topic: 'file:Pirated' }, noteToneBlock: 'builtin:plain' } });
    await installStyleFiles(h.plugin, FILES);
    Object.assign(h.doc, row.map);
    await h.repo.updateNote(h.topic.path, row.note);
    const other = await h.repo.createNote('Other', 'model-a', h.doc, h.mapPath, 'workspace'); h.doc.nodes.push(other); await h.repo.saveMap(h.mapPath, h.doc);
    const { VisualAgentMapView } = load('main.ts', { obsidian: { ...obsidian, Modal: class { constructor() {} open() { opened.push(this); } close() {} }, Notice: class {} } });
    const view = new VisualAgentMapView({ app: h.app }, attachTopicRuns(h.plugin)); view.path = h.mapPath; view.map = h.doc; view.render = () => {};
    assert.equal(h.view.topicStyle(await h.repo.readNote(h.topic.path), undefined, 'en').label.toneName, row.tone, `${row.name}: the voice the run really uses`);
    view.selection.replaceMulti([h.topic.id, other.id]);
    view.openSelectionSynthesis(null);
    await until(() => opened.length === 1); // the styles are read again first (#38)
    assert.equal('currentTone' in opened[0].selectionFlow.fields, false);
    assert.equal(opened[0].selectionFlow.fields.currentStyle, 'Pirated', `${row.name}: synthesis dialog style (no topic: the topic type style)`);
  }
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

// ---- S7: the research of AI-expanded subtopics follows the dialog's AI mode (Quick: local, no images; Standard: web, images).
integrationTest('S7: expansion subtopic research follows the AI mode: Quick = local, no images, no charts; Standard = web, images, charts; the new child notes start as Quick', async () => {
  const { repo, app } = fixture('en'), parent = await topicNote(repo, 'Parent', 'model-a');
  const mapPath = 'Agent Workspace/Topics/map-s7/Map.md', mapDoc = map([parent]); mapDoc.id = 'map-s7';
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const runs = [];
  const plugin = withExpansionCoordinator({ repo, settings: { ...DEFAULT_SETTINGS, language: 'en' }, running: new Set(), abortChartJobs: () => {}, addChartsAfterWrite: () => {}, pendingSuggestions: new Map(), pendingResearchOptions: new Map(), rebuildDerivedData: async () => {}, mutate: async work => work(), recordFailure: (_context, error) => error.message });
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app }, attachTopicRuns(plugin)); view.path = mapPath; view.map = mapDoc; view.contentEl = { querySelector: () => null }; view.render = () => {}; view.hydrate = async () => {};
  researchSeam(view).run = async (_child, _done, _failed, overrides, accepted) => { runs.push({ researchMode: overrides.researchMode, researchDepth: overrides.researchDepth, visualMode: overrides.visualMode, mapAiMode: overrides.mapAiMode, addCharts: overrides.addCharts }); accepted?.(); return { finished: Promise.resolve() }; };
  const { aiModeOptions } = load('experiences/visual-map/ai-mode.ts');
  const dialog = mode => ({ ...aiModeOptions(mode, 'subtopic'), referenceGroups: [], shallowResearch: true, outputLanguage: 'en' });
  const quick = dialog('quick');
  const children = await view.createChildBatch(parent, [{ title: 'One', task: 'Why one?', contribution: '' }], quick);
  const stored = await repo.readNote(children[0].path);
  assert.equal(stored.researchMode, 'local', 'the child note starts as Quick'); assert.equal('researchDepth' in stored, false);
  await view.startShallowResearch(parent, children, quick);
  await until(() => plugin.expansionBatches.get(parent.path).status !== 'running');
  assert.deepEqual(plain(runs), [{ researchMode: 'local', researchDepth: 'fast', visualMode: 'off', mapAiMode: 'quick', addCharts: false }]);
  runs.length = 0;
  const standard = dialog('standard');
  const second = await view.createChildBatch(parent, [{ title: 'Two', task: 'Why two?', contribution: '' }], standard);
  assert.equal((await repo.readNote(second[0].path)).researchMode, 'local', 'the research, once it writes, stores the mode it ran in');
  await view.startShallowResearch(parent, second, standard);
  await until(() => plugin.expansionBatches.get(parent.path).status !== 'running');
  assert.deepEqual(plain(runs), [{ researchMode: 'research', researchDepth: 'fast', visualMode: 'auto', mapAiMode: 'standard', addCharts: true }]);
  assert.equal(view.shallowChildOptions, undefined, 'the web checkbox helper for subtopic research is gone');
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
  const view = new VisualAgentMapView({ app: {} }, attachTopicRuns({ settings: { ...DEFAULT_SETTINGS, language: 'en' } }));
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
  const view = new VisualAgentMapView({ app: {} }, attachTopicRuns({ settings: { ...DEFAULT_SETTINGS, language: 'en' } }));
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
  const view = new VisualAgentMapView({ app: {} }, attachTopicRuns({ settings: { ...DEFAULT_SETTINGS, language: 'en' } }));
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

integrationTest('L4: startShallowResearch wires the chart decision: a Quick shallow child gets no chart job, a Standard one does', async () => {
  for (const [mode, expected] of [['quick', false], ['standard', true]]) {
    const h = await templateHarness({ language: 'en', reply: () => ({ summary: 'Sum', detail: 'Body paragraph.', visualReferences: [], suggestions: [] }) });
    const child = await h.repo.createNote('Child', 'model-a', h.doc, h.mapPath, 'workspace', h.topic.id);
    await h.repo.updateNote(child.path, { prompt: 'Research the child' });
    h.doc.nodes.push(child);
    const dialog = { ...load('experiences/visual-map/ai-mode.ts').aiModeOptions(mode, 'subtopic'), referenceGroups: [], shallowResearch: true, outputLanguage: 'en' };
    await h.view.startShallowResearch(h.topic, [child], dialog);
    await until(() => h.plugin.expansionBatches.get(h.topic.path).status !== 'running');
    assert.equal(h.contexts.at(-1).researchMode, expected ? 'research' : 'local'); assert.equal(h.contexts.at(-1).mapAiMode, mode, 'the context carries the mode');
    assert.equal(h.contexts.at(-1).addCharts === true, expected, `mode ${mode}`);
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
  const view = new VisualAgentMapView({ app: {} }, attachTopicRuns({ settings: { ...DEFAULT_SETTINGS, language: 'en' } }));
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
  const view = new VisualAgentMapView({ app: {} }, attachTopicRuns({ settings: { ...DEFAULT_SETTINGS, language: 'en' } }));
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
test('R2 M3: a stage or query change in a running research patches the card chip instead of redrawing the map', () => {
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const { ResearchProgressStore } = load('experiences/visual-map/research-progress.ts');
  class El {
    constructor(cls) { this.cls = new Set(cls ? [cls] : []); this.kids = []; this.attrs = {}; this.textContent = ''; this.offsetHeight = 100; }
    setText(v) { this.textContent = v; } setAttr(k, v) { this.attrs[k] = v; }
    createSpan(o = {}) { const e = new El(o.cls); e.textContent = o.text ?? ''; this.kids.push(e); return e; }
    querySelector(sel) { const c = sel.slice(1); for (const k of this.kids) { if (k.cls.has(c)) return k; const d = k.querySelector(sel); if (d) return d; } return null; }
  }
  const make = ({ drawn = true, chip = true, label = true } = {}) => {
    const view = new VisualAgentMapView({ app: {} }, attachTopicRuns({ settings: { ...DEFAULT_SETTINGS, language: 'en' } }));
    const store = new ResearchProgressStore();
    view.plugin = { researchProgress: store, settings: { ...DEFAULT_SETTINGS, language: 'en' }, modelLabel: m => m };
    view.map = { nodes: [{ id: 'n1', path: 'a.md' }] }; view.notes = new Map([['n1', { title: 'Topic A', summary: 'S' }]]);
    view.announcer = { setText() {} }; view.announcedStages = new Map(); view.closed = false; view.stageEl = {};
    view.paintHoverResearch = () => {}; view.paintCardPreview = () => {}; view.topicKindOf = () => 'topic';
    const card = new El('vam-card'); view.cardEls = new Map(drawn ? [['n1', card]] : []);
    const log = { renders: 0, edges: 0, settles: 0, fits: 0 }; let growTo = null;
    view.scheduleResearchRender = () => { log.renders++; };
    view.drawEdges = () => { log.edges++; }; view.settleCardHeights = () => { log.settles++; };
    view.fitKindShape = () => { log.fits++; };
    store.begin('a.md', 'x', 1);
    let stage = null;
    if (chip) { const c = card.createSpan({ cls: 'vam-status' }); stage = c.createSpan({ cls: 'vam-research-stage', text: 'Waiting for the model' }); }
    // The height follows the chip text (a wrapping header), so it changes at setText time, before any fitKindShape.
    Object.defineProperty(card, 'offsetHeight', { get: () => (growTo !== null && stage && stage.textContent !== 'Waiting for the model' ? growTo : 100) });
    if (label) view.labelCard(card, 'Topic A: Waiting for the model, Researched');
    view.researchSigs.set('a.md', view.researchSig(store.get('a.md')));
    return { view, store, card, stage, log, grow: h => { growTo = h; } };
  };
  const label = c => c.querySelector('.vam-card-label').textContent;
  // Stage and query changes: patched in place, no redraw.
  for (const [name, apply, text] of [
    ['stage', s => s.stage('a.md', 'x', 'reading', 2), 'Reading sources'],
    ['query', s => { s.stage('a.md', 'x', 'searching', 2, 'plain'); }, 'Searching: plain'],
    ['query with a pipe', s => { s.stage('a.md', 'x', 'searching', 2, 'a|b|0|1'); }, 'Searching: a|b|0|1']
  ]) {
    const h = make(); apply(h.store); h.view.onResearchProgress('a.md');
    assert.equal(h.log.renders, 0, `${name}: no full redraw`);
    assert.equal(h.stage.textContent, text, `${name}: chip text`); assert.equal(h.stage.attrs.title, text, `${name}: chip title`);
    assert.equal(label(h.card), `Topic A: ${text}, Researched`, `${name}: label`);
    assert.equal(h.view.researchSigs.get('a.md'), h.view.researchSig(h.store.get('a.md')), `${name}: stored signature`);
    assert.equal(h.log.edges, 0, `${name}: height unchanged leaves the edges`); assert.equal(h.log.settles, 0);
  }
  { // a query with a pipe, then a second change: the flags are still read from the end
    const h = make(); h.store.stage('a.md', 'x', 'searching', 2, 'a|b'); h.view.onResearchProgress('a.md');
    h.store.stage('a.md', 'x', 'searching', 3, 'c|d|1|1'); h.view.onResearchProgress('a.md');
    assert.equal(h.log.renders, 0); assert.equal(h.stage.textContent, 'Searching: c|d|1|1');
  }
  { // height change redraws the edges once
    const h = make(); h.grow(140); h.store.stage('a.md', 'x', 'reading', 2); h.view.onResearchProgress('a.md');
    assert.equal(h.log.renders, 0); assert.equal(h.log.edges, 1); assert.equal(h.log.settles, 1);
  }
  // Transitions that keep the full redraw: end, slow, charts, and a stage leaving charts.
  for (const [name, apply] of [
    ['end', s => s.end('a.md')],
    ['slow', s => s.markSlow('a.md', 'x', true, () => {})],
    ['charts', s => s.stage('a.md', 'x', 'charts', 2)]
  ]) {
    const h = make(); apply(h.store); h.view.onResearchProgress('a.md');
    assert.equal(h.log.renders, 1, `${name}: still a full redraw`); assert.equal(h.stage.textContent, 'Waiting for the model', `${name}: chip untouched`);
  }
  { const h = make(); h.store.stage('a.md', 'x', 'charts', 2); h.view.researchSigs.set('a.md', h.view.researchSig(h.store.get('a.md')));
    h.store.stage('a.md', 'x', 'writing', 3); h.view.onResearchProgress('a.md'); assert.equal(h.log.renders, 1, 'leaving charts redraws'); }
  { // begin: nothing drawn yet
    const h = make(); h.view.researchSigs.delete('a.md'); h.view.onResearchProgress('a.md'); assert.equal(h.log.renders, 1, 'begin redraws'); }
  { // resend
    const h = make(); h.store.stage('a.md', 'x', 'reading', 2); h.view.researchSigs.set('a.md', 'reading||0|1'); h.view.onResearchProgress('a.md');
    assert.equal(h.log.renders, 1, 'a resend flag change redraws'); }
  { // card not drawn: no redraw, no throw, signature untouched
    const h = make({ drawn: false }); h.store.stage('a.md', 'x', 'reading', 2); assert.doesNotThrow(() => h.view.onResearchProgress('a.md'));
    assert.equal(h.log.renders, 0); assert.equal(h.log.fits, 0); }
  { // chip missing: fall back to the scheduled redraw
    const h = make({ chip: false }); h.store.stage('a.md', 'x', 'reading', 2); h.view.onResearchProgress('a.md');
    assert.equal(h.log.renders, 1); assert.equal(h.view.researchSigs.get('a.md'), 'waiting||0|0'); }
  { // view closed: nothing happens
    const h = make(); h.view.closed = true; h.store.stage('a.md', 'x', 'reading', 2); h.view.onResearchProgress('a.md');
    assert.equal(h.log.renders, 0); assert.equal(h.stage.textContent, 'Waiting for the model'); }
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
  // An explicit note style: the merge update (carry-forward) is the style's own choice; the unset default integrates as a whole rewrite.
  await f.repo.updateNote(f.parent.path, { noteStyle: 'builtin:general', detail: earlierDetail, summary: 'Old summary https://summary.example/s', newFindings: 'Working [finding](https://finding.example/w)' });
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
  const f = await keepSourcesFixture(Array.from({ length: 300 }, (_, i) => `Line ${i} of a long child note with enough words to pass the batch size.`).join('\n'));
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
  await g.repo.updateNote(g.parent.path, { noteStyle: 'builtin:general' });
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
  // 128001 = the 32_000-token budget (core/ai-task-service.ts buildPreparedTaskContext(..., 32_000)) * 4 chars per token + 1; the budget is a literal there, not exported.
  const f = await findingsFixture('KEPT_FINDING_START ' + 'x'.repeat(128001));
  await synthesize(f);
  assert.equal(f.runtime.calls.length, 2);
  assert.ok(!f.runtime.calls[1].prompt.includes('x'.repeat(128001)), 'the findings were cut');
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

// ---- AI mode Quick / Standard: what a research writes, the re-run, and the modes of a batch ---------------------------
const GAP_DETAIL = 'Model knowledge is insufficient.';
integrationTest('AI mode: a research stores the mode it ran in on the topic (Quick = local, Standard = research) and one undo restores the earlier summary, detail and mode', async () => {
  const { aiModeOptions } = load('experiences/visual-map/ai-mode.ts');
  const h = await templateHarness({ language: 'en', reply: (_context, call) => ({ summary: `Summary ${call}`, detail: `Detail ${call}`, visualReferences: [], suggestions: [] }) });
  await h.repo.updateNote(h.topic.path, { researchMode: 'local', summary: 'Old summary', detail: 'Old detail', status: 'completed' });
  const before = await h.repo.readNote(h.topic.path);
  const handle = await h.view.runAgent(h.topic, undefined, undefined, { ...aiModeOptions('standard', 'research'), referenceGroups: [], rules: '' });
  await handle.finished; await until(() => !h.plugin.running.size);
  let note = await h.repo.readNote(h.topic.path);
  assert.equal(note.researchMode, 'research'); assert.equal(note.summary, 'Summary 1'); assert.equal('researchDepth' in note, false);
  const context = h.contexts.at(-1);
  assert.deepEqual(plain([context.researchMode, context.researchDepth, context.visualMode, context.mapAiMode]), ['research', 'normal', 'auto', 'standard']);
  const action = h.view.history.undo(); await action.undo();
  note = await h.repo.readNote(h.topic.path);
  assert.deepEqual(plain([note.researchMode, note.summary]), ['local', 'Old summary'], 'undo brings back the Quick mode with the old result');
  assert.equal(note.detail, before.detail);
  await h.view.runAgent(h.topic, undefined, undefined, { ...aiModeOptions('quick', 'research'), referenceGroups: [], rules: '', addCharts: false }).then(x => x.finished); await until(() => !h.plugin.running.size);
  assert.equal((await h.repo.readNote(h.topic.path)).researchMode, 'local');
  assert.equal(h.contexts.at(-1).mapAiMode, 'quick');
  assert.equal(h.chartJobs.filter(job => job.context.mapAiMode === 'quick').every(job => job.context.addCharts === false), true, 'a Quick research asks for no charts');
});
integrationTest('AI mode: a note with research-depth deep keeps that line after a research, and a note with no research-mode reads as Quick', async () => {
  const h = await templateHarness({ language: 'en' });
  const text = async () => h.contents.get(h.topic.path);
  h.contents.set(h.topic.path, h.contents.get(h.topic.path).replace('---\n', '---\nresearch-depth: deep\n'));
  assert.equal((await h.repo.readNote(h.topic.path)).researchMode, 'local', 'missing research-mode reads as Quick');
  await h.run();
  assert.match(await text(), /research-depth: deep/, 'the old line survives a research');
  assert.match(await text(), /research-mode: local/, 'a Quick run writes the mode it used');
  assert.equal(h.contexts.at(-1).researchDepth, 'normal', 'the depth no longer comes from the note');
});
integrationTest('Re-run with Standard: one usage confirmation, Standard options, the plain research task without sources or extra requirements, and the Quick result is restored by one undo', async () => {
  const h = await templateHarness({ language: 'en', reply: () => ({ summary: 'Standard summary', detail: 'Standard detail with sources', visualReferences: [], suggestions: [] }) });
  await h.repo.updateNote(h.topic.path, { researchMode: 'local', summary: 'Quick summary', detail: GAP_DETAIL, status: 'completed', prompt: 'A stored custom prompt' });
  const confirms = [];
  h.plugin.confirmAiUsage = async (model, run) => { confirms.push(model); await run(); return true; };
  h.view.rerunStandard(h.topic);
  await until(() => h.contexts.length === 1); await until(() => !h.plugin.running.size);
  assert.deepEqual(plain(confirms), [(await h.repo.readNote(h.topic.path)).model], 'the usual usage confirmation, for the topic\'s model');
  const context = h.contexts[0];
  const { researchTopicTask } = load('experiences/visual-map/steps/fragments.ts');
  assert.equal(context.task, researchTopicTask('en', 'Topic'), 'the plain research task: no stored prompt text, no extra requirements');
  assert.deepEqual(plain([context.researchMode, context.researchDepth, context.visualMode, context.mapAiMode, context.referenceGroups]), ['research', 'normal', 'auto', 'standard', []]);
  let note = await h.repo.readNote(h.topic.path);
  assert.deepEqual(plain([note.researchMode, note.summary]), ['research', 'Standard summary']);
  const action = h.view.history.undo(); await action.undo();
  note = await h.repo.readNote(h.topic.path);
  assert.deepEqual(plain([note.researchMode, note.summary, note.detail.includes(GAP_DETAIL)]), ['local', 'Quick summary', true], 'one undo restores summary, detail and the Quick mode');
});
integrationTest('Re-run with Standard: a note edited while the run is out is not overwritten (the existing stale fence), and the run does not start while the topic is busy', async () => {
  const h = await templateHarness({ language: 'en' });
  await h.repo.updateNote(h.topic.path, { researchMode: 'local', summary: 'Quick summary', detail: GAP_DETAIL, status: 'completed' });
  const gate = deferred();
  h.plugin.confirmAiUsage = async (_model, run) => { await run(); return true; };
  h.plugin.askModel = async (context, _model, _reasoning, _signal, _exchange, onAccepted) => { h.contexts.push(context); onAccepted?.(); await gate.promise; return { summary: 'Standard summary', detail: 'Standard detail', visualReferences: [], suggestions: [] }; };
  h.view.rerunStandard(h.topic);
  await until(() => h.contexts.length === 1);
  h.view.rerunStandard(h.topic);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(h.contexts.length, 1, 'a second press while the topic runs starts nothing');
  assert.ok(h.notices.some(message => /running/i.test(message)), 'and says why');
  await h.repo.updateNote(h.topic.path, { summary: 'Edited by the user' });
  gate.resolve(); await until(() => !h.plugin.running.size);
  const note = await h.repo.readNote(h.topic.path);
  assert.deepEqual(plain([note.summary, note.researchMode, note.detail.includes(GAP_DETAIL)]), ['Edited by the user', 'local', true], 'nothing of the late answer was written');
});
integrationTest('multi research without overrides runs each topic in its own note\'s mode: Quick notes local, no images, no charts; a research mode as Standard with the web, images and charts; a missing mode as Quick', async () => {
  const h = await multiResearchHarness(['Quick note', 'Old note', 'Standard note']);
  await h.repo.updateNote(h.nodes[0].path, { researchMode: 'local' });
  await h.repo.updateNote(h.nodes[2].path, { researchMode: 'research' });
  h.view.selection.replaceMulti(h.nodes.map(n => n.id));
  await h.view.startMultiResearch({ requirements: 'Be brief' });
  await until(() => h.runs.length === 3);
  const byTitle = Object.fromEntries(h.runs.map(run => [run.title, run.options]));
  const shape = options => plain([options.researchMode, options.researchDepth, options.visualMode, options.mapAiMode, options.addCharts]);
  assert.deepEqual(shape(byTitle['Quick note']), ['local', 'normal', 'off', 'quick', false]);
  assert.deepEqual(shape(byTitle['Old note']), ['local', 'normal', 'off', 'quick', false], 'an older note without research-mode is Quick');
  assert.deepEqual(shape(byTitle['Standard note']), ['research', 'normal', 'auto', 'standard', true]);
  for (const run of h.runs) assert.match(run.options.task, /Be brief$/);
  for (const name of h.finish.keys()) h.finish.get(name)();
  await until(() => h.plugin.expansionBatches.get(h.key).status === 'completed');
  // With the map chat's overrides the batch follows the override's mode (D-2026-10-231): research = Standard, local = Quick (no charts, the Quick prompt).
  const chat = await multiResearchHarness(['Chat topic']);
  chat.view.selection.replaceMulti(chat.nodes.map(n => n.id));
  await chat.view.startMultiResearch({ researchMode: 'research', researchDepth: 'deep', requirements: '', imageSearch: true });
  await until(() => chat.runs.length === 1);
  assert.deepEqual(plain([chat.runs[0].options.researchMode, chat.runs[0].options.researchDepth, chat.runs[0].options.visualMode, chat.runs[0].options.addCharts]), ['research', 'deep', 'auto', true]);
  assert.equal(chat.runs[0].options.mapAiMode, 'standard', 'a chat research override carries its mode so the right prompt is used');
  const quick = await multiResearchHarness(['Chat quick topic']);
  quick.view.selection.replaceMulti(quick.nodes.map(n => n.id));
  await quick.view.startMultiResearch({ researchMode: 'local', researchDepth: 'normal', requirements: '', imageSearch: false });
  await until(() => quick.runs.length === 1);
  assert.deepEqual(plain([quick.runs[0].options.researchMode, quick.runs[0].options.researchDepth, quick.runs[0].options.visualMode, quick.runs[0].options.mapAiMode, quick.runs[0].options.addCharts]), ['local', 'normal', 'off', 'quick', false]);
});
integrationTest('AI mode memory on the map: remembering writes aiMode once; the same value again writes nothing; unknown stored values are dropped on read', async () => {
  const h = await templateHarness({ language: 'en' });
  h.plugin.mutate = async work => work();
  h.view.mapChange = async (change, rebuild) => { await h.plugin.repo.updateMap(h.mapPath, change); change(h.view.map); h.mapChanges = (h.mapChanges ?? 0) + 1; assert.equal(rebuild, false, 'a mode change needs no derived-data rebuild'); };
  const memory = h.view.aiModeMemory();
  assert.equal(memory.aiMode, undefined, 'a map that never ran one remembers nothing (the dialog then starts on Quick)');
  await memory.rememberAiMode('standard');
  assert.equal((await h.repo.readMap(h.mapPath)).aiMode, 'standard'); assert.equal(h.mapChanges, 1);
  assert.equal(h.view.aiModeMemory().aiMode, 'standard');
  await h.view.aiModeMemory().rememberAiMode('standard');
  assert.equal(h.mapChanges, 1, 'the same mode again writes nothing');
  await h.view.aiModeMemory().rememberAiMode('quick');
  assert.equal((await h.repo.readMap(h.mapPath)).aiMode, 'quick');
  for (const bad of ['"deep"', '123', 'null', '{"a":1}']) {
    const text = h.contents.get(h.mapPath);
    assert.match(text, /"aiMode": "quick"/);
    h.contents.set(h.mapPath, text.replace('"aiMode": "quick"', `"aiMode": ${bad}`));
    const loaded = await h.repo.readMap(h.mapPath);
    assert.equal('aiMode' in loaded, false, `aiMode ${bad} is dropped; the map still loads`);
    assert.equal(loaded.nodes.length, 1);
    await h.repo.updateMap(h.mapPath, map => { map.aiMode = 'quick'; });
  }
  assert.equal((await h.repo.readMap(h.mapPath)).aiMode, 'quick', 'a valid value round-trips');
});
integrationTest('a topic added by hand or by an expansion without subtopic research starts in Quick mode too (addNode, D-2026-10-244)', async () => {
  const { repo, app } = fixture(), parent = await topicNote(repo, 'Parent', 'model-a');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md', mapDoc = map([parent]); mapDoc.id = 'map-a';
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const plugin = withExpansionCoordinator({ repo, settings: { ...DEFAULT_SETTINGS }, rebuildDerivedData: async () => {} });
  const view = new VisualAgentMapView({ app }, attachTopicRuns(plugin)); view.path = mapPath; view.map = mapDoc; view.contentEl = { querySelector: () => null }; view.render = () => {}; view.hydrate = async () => {}; view.focusNode = () => {};
  await view.createChildBatch(parent, [{ title: 'Plain child', task: 'Look', contribution: '', parentTitle: '' }]);
  const child = view.map.nodes.at(-1);
  assert.equal((await repo.readNote(child.path)).researchMode, 'local');
  assert.match(await app.vault.cachedRead(app.vault.getAbstractFileByPath(child.path)), /research-mode: local/);
  assert.equal((await repo.readNote(parent.path)).researchMode, 'local', 'the parent (no research-mode) reads as Quick and is not touched');
});
// MapTransaction 02 C5: confirming a synthesis topic is one transaction entry; redo refuses (stale) after an unrecorded write.
integrationTest('map transaction C5: synthesis topic undo parks the note, and redo after an unrecorded Map.md write refuses and keeps it', async () => {
  const h = await templateHarness({ language: 'en' });
  const other = await h.repo.createNote('Other', 'model-a', h.doc, h.mapPath, 'workspace'); h.doc.nodes.push(other); await h.repo.saveMap(h.mapPath, h.doc);
  await h.view.createIntegratedNode('Combined', [h.topic, other], 'Compare', '');
  const integrated = h.view.map.nodes.at(-1);
  assert.equal((await h.repo.readNote(integrated.path)).title, 'Combined');
  assert.equal(h.view.history.undoEntry.label, 'Create synthesis topic');
  await h.view.travel(false);
  assert.equal(h.view.map.nodes.some(n => n.id === integrated.id), false);
  const parked = [...h.contents.keys()].find(p => p.startsWith('Agent Workspace/Topics/map-a/Unassigned/'));
  assert.ok(parked, 'the note is parked in Unassigned');
  assert.equal(h.contents.has(integrated.path), false);
  const outside = await h.repo.readMap(h.mapPath);
  outside.title = 'Written by AIM';
  await h.repo.saveMap(h.mapPath, outside);
  h.view.map = await h.repo.readMap(h.mapPath);
  const before = new Map(h.contents);
  const error = await h.view.travel(true).then(() => null, e => e);
  assert.equal(error?.kind, 'stale');
  assert.deepEqual([...h.contents], [...before], 'nothing was written');
  assert.equal(h.contents.has(parked), true, 'the note stays parked');
  assert.equal((await h.repo.readMap(h.mapPath)).title, 'Written by AIM');
  assert.equal(h.view.history.canRedo, true, 'the pointer is back');
});
