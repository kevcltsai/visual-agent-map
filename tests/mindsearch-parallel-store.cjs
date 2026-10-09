const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { buildSync } = require('esbuild');
const code = buildSync({ entryPoints: ['mindsearch-mve/research-run-store.ts'], bundle: true, write: false, platform: 'node', format: 'cjs' }).outputFiles[0].text;
const moduleValue = { exports: {} };
vm.runInNewContext(code, { module: moduleValue, exports: moduleValue.exports, require });
const { MindSearchRunStore } = moduleValue.exports;
const copy = value => JSON.parse(JSON.stringify(value));
let fixtureId = 0;
function fixture() {
  const mapPath = `parallel-store-${++fixtureId}/Map.md`;
  let id = 0;
  let map = { id: 'map', title: 'Goal', nodes: [{ id: 'question', path: 'Question.md', x: 0, y: 0, parentId: null }], mindSearch: { version: 1, branches: [{ id: 'branch', questionNodeId: 'question', parentBranchId: null, answerSnapshot: { selections: [], freeText: 'condition' }, inputSnapshot: { topic: 'Goal', conditions: {}, upstreamResults: [] }, createdAt: 'today', results: [] }], runs: [], pendingCommits: [] } };
  const notes = new Map();
  const repo = {
    readMap: async () => copy(map), saveMap: async (_path, value) => { map = copy(value); },
    topicFolder: () => 'Notes', topicRoot: () => 'Topic', ensureTopicFolders: async () => {},
    unique: (_folder, title) => `Notes/${title}-${++id}.md`,
    createNoteAt: async (title, _model, _map, _mapPath, _scope, path, nodeId, fields) => { notes.set(path, { title, path, nodeId, ...copy(fields), detail: '' }); },
    hasNote: path => notes.has(path),
    readNote: async path => copy(notes.get(path)),
    updateNote: async (path, fields) => { notes.set(path, { ...notes.get(path), ...copy(fields) }); },
  };
  const newStore = () => new MindSearchRunStore(repo, () => `id-${++id}`);
  return { mapPath, repo, newStore, store: newStore() };
}
const config = subtopicId => ({ subtopicId, model: 'test-model', reasoning: 'low', maxResearchTurns: 1 });

test('at most two distinct subtopic attempts dispatch; duplicates and synthesis wait', async () => {
  const { store, repo, mapPath } = fixture();
  const [first, second] = await Promise.all([store.startAttempt(mapPath, 'branch', undefined, config('one')), store.startAttempt(mapPath, 'branch', undefined, config('two'))]);
  assert.ok(first.dispatch && second.dispatch);
  assert.notEqual(first.runId, second.runId);
  assert.equal((await store.startAttempt(mapPath, 'branch', undefined, config('one'))).dispatch, false);
  assert.equal((await store.startAttempt(mapPath, 'branch', undefined, config('three'))).dispatch, false);
  assert.equal((await store.startAttempt(mapPath, 'branch', undefined, config(undefined))).dispatch, false);
  assert.equal((await repo.readMap(mapPath)).mindSearch.runs.length, 2);
  await store.cancelAttempt(mapPath, first, 'done');
  await store.cancelAttempt(mapPath, second, 'done');
});
test('explicit new run IDs cannot bypass cap, duplicate target or synthesis isolation', async () => {
  const { store, mapPath } = fixture();
  const first = await store.startAttempt(mapPath, 'branch', 'explicit-one', config('one'));
  assert.equal((await store.startAttempt(mapPath, 'branch', 'duplicate-one', config('one'))).dispatch, false);
  assert.equal((await store.startAttempt(mapPath, 'branch', 'explicit-synthesis', config(undefined))).dispatch, false);
  const second = await store.startAttempt(mapPath, 'branch', 'explicit-two', config('two'));
  assert.ok(second.dispatch);
  assert.equal((await store.startAttempt(mapPath, 'branch', 'explicit-three', config('three'))).dispatch, false);
  await store.cancelAttempt(mapPath, first, 'done');
  await store.cancelAttempt(mapPath, second, 'done');
});
test('both parallel results commit durably and remain available after reopening store', async () => {
  const { store, repo, mapPath, newStore } = fixture();
  const first = await store.startAttempt(mapPath, 'branch', undefined, config('one'));
  const second = await store.startAttempt(mapPath, 'branch', undefined, config('two'));
  const [draft1, draft2] = await Promise.all([
    store.createResultDraft(mapPath, first, 'First', 'test-model', undefined, { subtopicId: 'one', kind: 'research' }),
    store.createResultDraft(mapPath, second, 'Second', 'test-model', undefined, { subtopicId: 'two', kind: 'research' }),
  ]);
  const committed = await Promise.all([
    store.commitResult(mapPath, first, draft1.draft.id, { summary: 'First', detail: 'Full first report' }),
    store.commitResult(mapPath, second, draft2.draft.id, { summary: 'Second', detail: 'Full second report' }),
  ]);
  assert.deepEqual(committed.map(value => value.status), ['committed', 'committed']);
  const saved = await repo.readMap(mapPath);
  assert.deepEqual(saved.mindSearch.branches[0].results.map(value => value.subtopicId), ['one', 'two']);
  assert.deepEqual(saved.mindSearch.branches[0].results.map(value => value.version), [1, 2]);
  assert.equal(saved.mindSearch.pendingCommits.length, 0);
  const reopened = newStore();
  await reopened.recoverPending(mapPath);
  assert.equal((await repo.readMap(mapPath)).mindSearch.branches[0].results.length, 2);
  const synthesis = await reopened.startAttempt(mapPath, 'branch', undefined, config(undefined));
  assert.ok(synthesis.dispatch);
  await reopened.cancelAttempt(mapPath, synthesis, 'done');
});
test('cancelling one attempt preserves its sibling and allows it to commit', async () => {
  const { store, repo, mapPath } = fixture();
  const first = await store.startAttempt(mapPath, 'branch', undefined, config('one'));
  const second = await store.startAttempt(mapPath, 'branch', undefined, config('two'));
  const firstDraft = await store.createResultDraft(mapPath, first, 'First', 'test-model', undefined, { subtopicId: 'one' });
  const secondDraft = await store.createResultDraft(mapPath, second, 'Second', 'test-model', undefined, { subtopicId: 'two' });
  assert.ok(await store.cancelAttempt(mapPath, first, 'Only first cancelled'));
  const cancelledMap = await repo.readMap(mapPath);
  assert.equal(cancelledMap.mindSearch.runs.find(run => run.id === first.runId).attempts[0].status, 'cancelled');
  assert.equal(cancelledMap.mindSearch.runs.find(run => run.id === second.runId).attempts[0].status, 'running');
  assert.ok(!cancelledMap.nodes.some(node => node.id === firstDraft.draft.nodeId));
  assert.ok(cancelledMap.nodes.some(node => node.id === secondDraft.draft.nodeId));
  assert.equal((await store.commitResult(mapPath, second, secondDraft.draft.id, { summary: 'Second', detail: 'Sibling intact' })).status, 'committed');
});
test('saved delivery evidence is validated on reopen while optional legacy evidence remains readable', async () => {
  const modelCode = buildSync({ entryPoints: ['map-model.ts'], bundle: true, write: false, platform: 'node', format: 'cjs' }).outputFiles[0].text;
  const modelModule = { exports: {} };
  vm.runInNewContext(modelCode, { module: modelModule, exports: modelModule.exports, require });
  const { parseMap, serializeMap } = modelModule.exports;
  const { repo, mapPath } = fixture();
  const map = await repo.readMap(mapPath); map.version = 1;
  const source = { id: 'source', hash: 'a'.repeat(64), detail: 'Full source report' };
  map.mindSearch.branches[0].deliveryRecovery = { fingerprint: 'base', planner: { summary: 'Preview', detail: 'Planner', suggestions: [], visualReferences: [] }, checkpoint: {} };
  assert.doesNotThrow(() => parseMap(serializeMap(map)));
  for (const evidence of [{}, [null], [{ ...source, hash: 'invalid' }], [{ ...source, detail: '' }], [source, source]]) {
    map.mindSearch.branches[0].deliveryRecovery.evidence = evidence;
    assert.throws(() => parseMap(serializeMap(map)), /delivery evidence/);
  }
  map.mindSearch.branches[0].deliveryRecovery.evidence = [source];
  const reopened = parseMap(serializeMap(map));
  assert.equal(reopened.mindSearch.branches[0].deliveryRecovery.evidence[0].detail, source.detail);
});
