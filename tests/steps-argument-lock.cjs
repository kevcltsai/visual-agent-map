const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const S = require('./support.cjs');
const dom = require('./support-dom.cjs');
const { core, fixture, DEFAULT_SETTINGS, obsidian, withExpansionCoordinator, attachTopicRuns, startResearch, until } = S;

const root = path.resolve(__dirname, '..');
const machine = S.load('core/argument-map/machine.ts');
const model = S.load('core/argument-map/model.ts');
const modelV1 = S.load('core/argument-map/model-v1.ts');
const { v2State } = require('./fixtures/argument-map-v2-state.cjs');
const MAP = 'Agent Workspace/Topics/map-a/Map.md';
const LOCKED_NOTICE = /議題已鎖定，AI 不會修改|Topic is locked; AI will not change it/;
async function harness(titles = ['P', 'S', 'C', 'V', 'E', 'H', 'N', 'F'], plugin = {}, argument = true) {
  const { repo, app, contents } = fixture('zh-TW');
  const mapDoc = { id: 'map-a', title: 'map-a', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  await repo.ensureTopicFolders('Agent Workspace/Topics/map-a');
  await app.vault.create(MAP, core.serializeMap(mapDoc));
  const nodes = [];
  for (const title of titles) {
    const created = await repo.createNote(title, 'gpt-6-luna', mapDoc, MAP, 'workspace');
    await repo.updateNote(created.path, { prompt: `Research ${title}` });
    mapDoc.nodes.push(created);
    nodes.push(created);
  }
  if (argument) {
    const [p, s, c, v, e, hy, need] = nodes;
    const state = machine.newArgumentMap({ proposition: p.id, situation: s.id, conclusion: c.id, verified: v.id, eliminated: e.id }, 'run-1');
    state.hypotheses.push({ id: hy.id, citedData: [], round: 1, location: 'verifying', needs: [{ id: need.id, text: 'n', addedRound: 1, state: 'pending' }] });
    if (nodes[8]) state.situation.data.push({ id: nodes[8].id, need: 'd', attempts: 0, state: 'pending' });
    mapDoc.argumentMap = state;
  }
  await repo.saveMap(MAP, mapDoc);
  const calls = [], notices = [];
  let gate = null;
  const reply = { summary: 'AI summary', detail: 'AI detail', visualReferences: [], suggestions: [] };
  const host = withExpansionCoordinator({
    repo, settings: { ...DEFAULT_SETTINGS, language: 'zh-TW', cliModel: 'gpt-6-luna', cliReasoning: 'low' }, running: new Set(),
    pendingSuggestions: new Map(), pendingResearchOptions: new Map(), rebuildDerivedData: async () => {},
    recordFailure: (_label, error) => String(error?.message ?? error), views: () => [],
    mutate: async work => work(),
    confirmAiUsage: async (_model, run) => { await run(); return true; },
    askModel: async (context, model, _reasoning, signal, _exchange, accepted) => {
      calls.push({ title: context.title, model });
      accepted?.();
      if (gate) await new Promise((resolve, reject) => { gate.push(resolve); signal?.addEventListener('abort', () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }))); });
      return reply;
    },
    ...plugin
  });
  repo.settings = host.settings;
  const modals = [];
  const { VisualAgentMapView } = S.load('main.ts', { obsidian: { ...obsidian, Notice: class { constructor(message) { notices.push(message); } }, Modal: class { constructor(app) { this.app = app; } open() { modals.push(this); } close() {} } } });
  const view = new VisualAgentMapView({ app }, attachTopicRuns(host));
  const hydrate = async () => { view.notes = new Map(await Promise.all(mapDoc.nodes.map(async n => [n.id, await repo.readNote(n.path, mapDoc)]))); };
  Object.assign(view, { path: MAP, map: mapDoc, contentEl: { querySelector: () => null }, render() {}, hydrate, ancestorContext: async () => '', queueCharts() {} });
  await hydrate();
  const raw = node => contents.get(node.path);
  return { repo, app, contents, view, host, nodes, calls, notices, raw, modals, hold: () => { gate = []; return gate; } };
}
const research = { researchMode: 'local', researchDepth: 'normal', visualMode: 'off', referenceGroups: [] };
const synthesis = research;
const signal = () => new AbortController().signal;
const byTitle = (h, title) => h.nodes.find(n => n.path && h.view.notes.get(n.id)?.title === title) ?? h.nodes[['P', 'S', 'C', 'V', 'E', 'H', 'N', 'F'].indexOf(title)];
const [P, S_, C, V, E, H, N, F] = [0, 1, 2, 3, 4, 5, 6, 7];
const managedOf = h => [P, S_, C, V, E, H, N].map(i => h.nodes[i]);

test('managedNodeIds: roles, hypotheses and needs; empty without the key; tolerant of an unusable key', async () => {
  const h = await harness();
  assert.deepEqual([...model.managedNodeIds(h.view.map)].sort(), managedOf(h).map(n => n.id).sort());
  assert.equal(model.managedNodeIds({}).size, 0);
  assert.equal(model.managedNodeIds({ argumentMap: 'junk' }).size, 0);
  assert.deepEqual([...model.managedNodeIds({ argumentMap: { v: 2, roles: { proposition: 'x' }, hypotheses: [{ id: 'h', needs: [{ id: 'n' }] }] } })].sort(), ['h', 'n', 'x']);
});

test('managedNodeIds includes situation data ids (the data are leaf cards the flow owns); tolerant of junk entries', async () => {
  assert.deepEqual([...model.managedNodeIds({ argumentMap: { v: 2, roles: {}, situation: { data: [{ id: 'd1' }, { id: 7 }, 'x', null, {}] } } })].sort(), ['d1']);
  assert.equal(model.managedNodeIds({ argumentMap: { situation: 'junk' } }).size, 0);
  const h = await harness([...'PSCVEHNF'].concat('D'));
  for (const op of ['write', 'addChild', 'remove', 'move']) assert.equal(h.view.aiLockReason(op, [h.nodes[8].id], undefined, { to: null }), 'locked', op);
  assert.equal(h.view.aiLockReason('write', [h.nodes[7].id]), null);
});

test('shapeKindOf: the flow\'s cards are rectangles on an argument map; a free card and every card of a plain map keep their kind', async () => {
  const h = await harness();
  const [p, , , , , hy, , free] = h.nodes;
  for (const id of [p.id, hy.id]) h.view.notes.get(id).topicKind = 'hypothesis';
  h.view.notes.get(free.id).topicKind = 'hypothesis';
  assert.equal(h.view.shapeKindOf(hy.id), 'action');
  assert.equal(h.view.shapeKindOf(p.id), 'action');
  assert.equal(h.view.shapeKindOf(free.id), 'hypothesis');
  const plain = await harness(undefined, {}, false);
  for (const node of plain.nodes) {
    plain.view.notes.get(node.id).topicKind = 'hypothesis';
    assert.equal(plain.view.shapeKindOf(node.id), 'hypothesis');
  }
});

test('arrangeAll: an argument map is arranged by role (situation above conclusion); a map without the key takes the ordinary path; layout controls are off', async () => {
  const layoutHarness = async argument => {
    const h = await harness(undefined, {}, argument);
    const [p, s, c, v, e, hy, n] = h.nodes;
    for (const [node, parent] of [[s, p], [c, p], [v, c], [e, c], [hy, v], [n, hy]]) node.parentId = parent.id;
    // saved order puts the conclusion before the situation: only the argument path reorders them
    h.view.map.nodes = [p, c, s, v, e, hy, n, h.nodes[7]];
    return h;
  };
  const arranged = await layoutHarness(true);
  arranged.view.arrangeAll(arranged.view.map);
  const at = (h, i) => h.view.map.nodes.find(node => node.id === h.nodes[i].id);
  assert.ok(at(arranged, 1).y < at(arranged, 2).y, 'situation above conclusion');
  assert.ok(at(arranged, 3).y <= at(arranged, 4).y, 'verified group before eliminated group');
  assert.equal(at(arranged, 4).parentId, at(arranged, 2).id);
  const plain = await layoutHarness(false);
  plain.view.arrangeAll(plain.view.map);
  assert.ok(at(plain, 2).y < at(plain, 1).y, 'the ordinary path keeps the saved order');
  let changes = 0;
  for (const h of [arranged, plain]) h.view.mapChange = async () => { changes++; };
  arranged.view.setLayout({ direction: 'down' });
  await arranged.view.changeBranchLayout(at(arranged, 6), 'down');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(changes, 0, 'an argument map takes no layout direction or branch layout');
  plain.view.setLayout({ direction: 'down' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(changes, 1, 'a plain map still does');
  assert.deepEqual([...arranged.view.branchLayoutChoices(at(arranged, 6))], []);
  assert.ok(plain.view.branchLayoutChoices(at(plain, 6)).length > 0);
});

test('aiLockReason: every managed node is locked for every op; the free node and a map without the key are not', async () => {
  const h = await harness();
  for (const node of managedOf(h)) for (const op of ['write', 'addChild', 'remove', 'move']) assert.equal(h.view.aiLockReason(op, [node.id], undefined, { to: null }), 'locked', `${node.id} ${op}`);
  for (const op of ['write', 'addChild', 'remove', 'move']) assert.equal(h.view.aiLockReason(op, [h.nodes[F].id], undefined, { to: null }), null, op);
  const plain = await harness(undefined, {}, false);
  for (const node of plain.nodes) assert.equal(plain.view.aiLockReason('write', [node.id]), null);
});

test('v2 map: every managed node (roles, claims, premise data, comparison, hypothesis, need) is locked for every op and readNote marks it aiLocked; the free node is not', async () => {
  const h = await harness([...'PRCQDTMHNF'], {}, false);
  const [P_, PR, C_, Q1, D1, Q2, CMP, H1, N1, FREE] = h.nodes;
  h.view.map.argumentMap = v2State({ P: P_.id, PR: PR.id, C: C_.id, Q1: Q1.id, D1: D1.id, Q2: Q2.id, CMP: CMP.id, H1: H1.id, N1: N1.id });
  assert.equal(model.readArgumentMap(h.view.map).kind, 'usable', 'the fixture is a usable v2 value');
  await h.repo.saveMap(MAP, h.view.map);
  for (const node of [P_, PR, C_, Q1, D1, Q2, CMP, H1, N1]) {
    for (const op of ['write', 'addChild', 'remove', 'move']) assert.equal(h.view.aiLockReason(op, [node.id], undefined, { to: null }), 'locked', `${node.id} ${op}`);
    assert.equal((await h.repo.readNote(node.path, h.view.map)).aiLocked, true, 'readNote marks it');
  }
  assert.equal(h.view.aiLockReason('write', [FREE.id]), null);
  assert.notEqual((await h.repo.readNote(FREE.path, h.view.map)).aiLocked, true);
});

test('legacy and unusable keys: the nodes they name stay locked (a v:3 key and a v1 key alike)', async () => {
  const h = await harness([...'PRCQDTMHNF'], {}, false);
  const [P_, PR, C_, Q1, D1, Q2, CMP, H1, N1] = h.nodes;
  const ids = { P: P_.id, PR: PR.id, C: C_.id, Q1: Q1.id, D1: D1.id, Q2: Q2.id, CMP: CMP.id, H1: H1.id, N1: N1.id };
  h.view.map.argumentMap = { ...v2State(ids), v: 3 };
  assert.equal(model.readArgumentMap(h.view.map).kind, 'unusable');
  for (const id of Object.values(ids)) assert.equal(h.view.aiLockReason('write', [id]), 'locked', `v:3 ${id}`);
  h.view.map.argumentMap = machine.newArgumentMap({ proposition: P_.id, situation: PR.id, conclusion: C_.id, verified: Q1.id, eliminated: D1.id }, 'run-1');
  assert.equal(model.readArgumentMap(h.view.map).kind, 'legacy');
  for (const node of [P_, PR, C_, Q1, D1]) assert.equal(h.view.aiLockReason('write', [node.id]), 'locked', `legacy ${node.id}`);
  assert.equal(h.view.aiLockReason('write', [Q2.id]), null, 'a node the legacy key does not name is free');
});

test('readNote marks managed notes aiLocked only when given the map; the free note and a plain map are unmarked', async () => {
  const h = await harness();
  assert.equal((await h.repo.readNote(h.nodes[H].path, h.view.map)).aiLocked, true);
  assert.equal((await h.repo.readNote(h.nodes[F].path, h.view.map)).aiLocked, undefined);
  const plain = await harness(undefined, {}, false);
  assert.equal((await plain.repo.readNote(plain.nodes[H].path, plain.view.map)).aiLocked, undefined);
});

// ---- research ---------------------------------------------------------------------------------------------------------
test('entry research: a managed topic is refused before any provider call and writes nothing; the free topic still runs', async () => {
  const h = await harness();
  const a = h.nodes[H];
  const before = h.raw(a);
  const failures = [];
  const handle = await startResearch(h.host, a, { map: h.view.map, failed: message => failures.push(message), request: { task: 'go', ...research } });
  assert.equal(handle, null);
  assert.equal(h.calls.length, 0);
  assert.equal(h.raw(a), before);
  assert.match(failures[0], LOCKED_NOTICE);
  const ok = await startResearch(h.host, h.nodes[F], { map: h.view.map, failed: m => failures.push(m), request: { task: 'go', ...research } });
  assert.notEqual(ok, null);
});

test('entry re-run Standard and topic chat: refused on a managed topic', async () => {
  const h = await harness();
  const a = h.nodes[H];
  h.view.rerunStandard(a);
  await until(() => h.notices.length >= 1);
  assert.match(h.notices.at(-1), LOCKED_NOTICE);
  h.notices.length = 0;
  let pending;
  h.view.enqueue = fn => { pending = fn(); };
  h.view.openTopicChat(a);
  await pending;
  assert.match(h.notices.at(-1) ?? '', LOCKED_NOTICE);
  assert.equal(h.view.topicChatOpen ?? null, null);
  assert.equal(h.calls.length, 0);
});

test('entry multi research: managed topics are skipped, the free one reaches the provider', async () => {
  const h = await harness();
  h.view.selection.replaceMulti([h.nodes[H].id, h.nodes[N].id, h.nodes[F].id]);
  await h.view.startMultiResearch({ requirements: '', researchMode: 'local', researchDepth: 'normal', imageSearch: false });
  await until(() => h.view.plugin.expansionBatches.get(`multi-research:${MAP}`)?.status === 'completed');
  assert.deepEqual(h.calls.map(call => call.title), [(await h.repo.readNote(h.nodes[F].path)).title]);
});

// ---- expand ----------------------------------------------------------------------------------------------------------
test('entry expand: proposing subtopics, creating them, quick explore and chat expand are refused on a managed topic', async () => {
  const h = await harness();
  const p = h.nodes[H];
  const failures = [];
  await h.view.proposeChildren(p, { ...synthesis, shallowResearch: false }, '', () => assert.fail('no suggestions'), m => failures.push(m));
  assert.match(failures.join('\n'), LOCKED_NOTICE);
  const mapBefore = h.contents.get(MAP), count = h.view.map.nodes.length;
  await assert.rejects(h.view.createChildBatch(p, [{ title: 'Child', task: 't', contribution: '' }]), LOCKED_NOTICE);
  assert.equal(h.view.map.nodes.length, count);
  assert.equal(h.contents.get(MAP), mapBefore);
  let outlineCalls = 0;
  h.host.outlineGeneration = { generate: async () => { outlineCalls++; return { nodes: [], markdown: '' }; } };
  await assert.rejects(h.view.quickOutline(p).generate({ presetId: 'default', requirements: '', language: 'en', limits: { levels: 2, maxTopics: 5 } }, signal()), LOCKED_NOTICE);
  await h.view.chatExpand(p, '');
  assert.equal(outlineCalls, 0);
  assert.equal(h.calls.length, 0);
});

// ---- consolidate / merge ------------------------------------------------------------------------------------------------
test('entry consolidate: integrating into a managed parent is refused before the AI', async () => {
  const h = await harness();
  const p = h.nodes[H];
  for (const child of [h.nodes[N], h.nodes[F]]) {
    for (const list of [h.nodes, h.view.map.nodes]) list.find(n => n.id === child.id).parentId = p.id;
    await h.repo.updateNote(child.path, { summary: 'child summary', detail: 'Child detail', status: 'completed' });
  }
  await h.repo.saveMap(MAP, h.view.map);
  await h.view.hydrate();
  const before = h.raw(p), failures = [];
  await h.view.integrateChildren(p, synthesis, '', undefined, m => failures.push(m));
  assert.equal(h.calls.length, 0);
  assert.equal(h.raw(p), before);
  assert.match(failures.join('\n'), LOCKED_NOTICE);
  failures.length = 0;
  await h.view.proposeIntegrationDirections(p, synthesis, () => assert.fail('no directions'), m => failures.push(m));
  assert.equal(h.calls.length, 0);
  assert.match(failures.join('\n'), LOCKED_NOTICE);
});

test('entry consolidate selection: a managed source refuses the synthesis; nothing is added', async () => {
  const h = await harness();
  const [a, b] = [h.nodes[H], h.nodes[F]];
  const failures = [];
  await h.view.startSelectionSynthesis([a, b], { ...synthesis, synthesisTitle: 'Synth' }, 'Compare', m => failures.push(m), () => {});
  assert.match(failures.join('\n'), LOCKED_NOTICE);
  assert.equal(h.calls.length, 0);
  assert.equal(h.view.map.nodes.length, 8);
});

test('entry merge: an AI merge with a managed source is refused before the AI and writes nothing', async () => {
  const h = await harness();
  await h.view.hydrate();
  h.view.mergeOpen = false;
  const [a, b] = [h.nodes[H], h.nodes[F]];
  const before = [h.raw(a), h.raw(b)], mapBefore = h.contents.get(MAP);
  const snap = { path: MAP, mapId: h.view.map.id, parentId: null, targetId: null, sources: [a, b].map(n => ({ id: n.id, path: n.path })) };
  const began = await h.view.startMergeDraft('M', snap, () => assert.fail('not started'), signal());
  assert.equal(began, false);
  assert.equal(h.calls.length, 0);
  assert.match(h.notices.join('\n'), LOCKED_NOTICE);
  assert.deepEqual([h.raw(a), h.raw(b)], before);
  assert.equal(h.contents.get(MAP), mapBefore);
});

// ---- structure suggestion and goal grading -----------------------------------------------------------------------------
test('entry structure suggestion: suggestions touching managed topics are dropped; applying one refuses', async () => {
  const h = await harness();
  const [a, f] = [h.nodes[H], h.nodes[F]];
  const basis = { targetTitle: '', targetParentId: null };
  const result = { suggestions: [
    { kind: 'strengthen', targetId: a.id, basis }, { kind: 'move', targetId: f.id, newParentId: a.id, basis }, { kind: 'reduce', targetId: f.id, basis }
  ], rejected: [] };
  const { kept, skipped } = h.view.dropAiLockedSuggestions(result);
  assert.equal(skipped, 2);
  assert.deepEqual(kept.suggestions.map(s => s.kind), ['reduce']);
  const count = h.view.map.nodes.length;
  await assert.rejects(h.view.applyStructureSuggestion({ kind: 'strengthen', targetId: a.id, basis }, 'New', () => null), LOCKED_NOTICE);
  assert.equal(h.view.map.nodes.length, count);
});

test('entry goal grading: a managed card keeps its tier and is counted as skipped', async () => {
  const h = await harness();
  const [root, a, f] = [h.nodes[P], h.nodes[H], h.nodes[F]];
  await h.repo.writeRelevance(a.path, { tier: 'side' });
  for (const node of [a, f]) for (const list of [h.nodes, h.view.map.nodes]) list.find(n => n.id === node.id).parentId = root.id;
  const run = { token: 1, owner: h.view, controller: new AbortController(), goal: 'g', status: 'running' };
  h.host.relevanceGrades = new Map([[MAP, run]]);
  h.host.logs = { appendLog() {} };
  await h.view.hydrate();
  const basis = h.nodes.map(n => ({ id: n.id, title: h.view.notes.get(n.id).title, parentId: n.parentId ?? null }));
  const before = h.raw(a);
  await h.view.applyRelevanceGrade(run, MAP, basis, { items: [{ id: a.id, tier: 'core' }, { id: f.id, tier: 'core' }], suggestions: [], dropped: [] }, { scope: 'all', pins: [] });
  assert.equal(h.raw(a), before);
  assert.equal((await h.repo.readNote(f.path)).relevance.tier, 'core');
  assert.equal(run.outcome.skipped, 1);
});

// ---- map chat ----------------------------------------------------------------------------------------------------------
const chatBaseline = h => ({ mdHashes: {}, topicHashes: Object.fromEntries(h.view.map.nodes.map(n => [n.id, { title: h.view.notes.get(n.id).title, parentId: n.parentId }])) });
const applyChat = (h, action) => h.view.applyChatWrite(action, chatBaseline(h), () => true);

test('entry map chat: every write tool on a managed card is skipped as locked and Map.md is untouched; a free card is renamed', async () => {
  const h = await harness();
  const [hy, need, prop, f] = [h.nodes[H], h.nodes[N], h.nodes[P], h.nodes[F]];
  const mapBefore = h.contents.get(MAP), noteBefore = [hy, need, prop].map(n => h.raw(n));
  const actions = [
    { kind: 'rename_topic', nodeId: hy.id, title: 'X' },
    { kind: 'update_summary', nodeId: need.id, summary: 'S' },
    { kind: 'edit_topic_note', nodeId: prop.id, detail: 'D' },
    { kind: 'collapse_topic', nodeId: hy.id },
    { kind: 'set_topic_kind', nodeIds: [hy.id], topicKind: 'evidence' },
    { kind: 'set_appearance', nodeIds: [need.id], color: 'red', markers: ['star'] },
    { kind: 'add_child', parentId: hy.id, title: 'New child' },
    { kind: 'move_topic', nodeId: hy.id, newParentId: f.id },
    { kind: 'move_topic', nodeId: f.id, newParentId: hy.id },
    { kind: 'add_relation', fromId: f.id, toId: hy.id, relationKind: 'supports' },
    { kind: 'delete_topic', nodeId: need.id, branch: true },
    { kind: 'edit_md_file', path: hy.path, content: 'x' }
  ];
  for (const action of actions) {
    const outcome = await applyChat(h, action);
    assert.equal(outcome.status, 'skipped', JSON.stringify(action));
    assert.match(outcome.reason, LOCKED_NOTICE, JSON.stringify(action));
  }
  assert.equal(h.contents.get(MAP), mapBefore);
  assert.deepEqual([hy, need, prop].map(n => h.raw(n)), noteBefore);
  const ok = await applyChat(h, { kind: 'rename_topic', nodeId: f.id, title: 'Renamed' });
  assert.equal(ok.status, 'done');
});

test('entry map chat: a free card keeps working when added under another free card; Map.md edit tools stay guarded', async () => {
  const h = await harness();
  const ok = await applyChat(h, { kind: 'add_child', parentId: h.nodes[F].id, title: 'Free child' });
  assert.equal(ok.status, 'done');
  const guard = fs.readFileSync(path.join(root, 'core/map-chat-guard.ts'), 'utf8');
  assert.match(guard, /map_file/);
});

test('entry chart queue and topic runs: readNote(path, map) reports a managed note as aiLocked', async () => {
  const h = await harness();
  const note = await h.repo.readNote(h.nodes[H].path, h.view.map);
  assert.equal(note.aiLocked, true, 'readNote with the owning map sees the lock (the checks that hold the map: charts, topic runs)');
});

test('entry markdown selection AI: the repository names a managed note, and only a managed one', async () => {
  const h = await harness();
  for (const index of [P, S_, C, V, E, H, N]) assert.equal(await h.repo.isArgumentManagedNote(h.nodes[index].path), true, `node ${index}`);
  assert.equal(await h.repo.isArgumentManagedNote(h.nodes[F].path), false, 'a free card stays an AI target');
  const plain = await harness(['A', 'B'], {}, false);
  assert.equal(await plain.repo.isArgumentManagedNote(plain.nodes[0].path), false, 'a map without argumentMap behaves as before');
});

test('entry markdown selection AI: a managed note opened in the editor gets no model call and no write', async () => {
  const { runPanel } = require('./support-selection-ai.cjs');
  const notices = [];
  const outcome = await runPanel({ markdown: 'A note\n\ntext to rewrite\n', selected: 'text to rewrite', replies: ['Rewritten'], outcome: true, notices, isManagedNote: async () => true });
  assert.deepEqual(outcome.sent, [], 'no model call for a managed note');
  assert.deepEqual(outcome.replaced, []);
  assert.match(notices.join('|'), LOCKED_NOTICE);
  const free = await runPanel({ markdown: 'A note\n\ntext to rewrite\n', selected: 'text to rewrite', replies: ['Rewritten'], outcome: true, isManagedNote: async () => false });
  assert.equal(free.sent.length, 1, 'an ordinary note still reaches the model');
});

// ---- the runner is not an AI entry --------------------------------------------------------------------------------------
test('runner: ArgumentRuns never asks the AI lock, and its note and Map.md writes on managed nodes are not blocked', async () => {
  const runner = fs.readFileSync(path.join(root, 'experiences/visual-map/argument-run.ts'), 'utf8');
  assert.doesNotMatch(runner, /aiLock|aiLocked|isAiLocked/);
  const h = await harness();
  await h.repo.updateNote(h.nodes[H].path, { summary: 'runner wrote this' });
  assert.equal((await h.repo.readNote(h.nodes[H].path)).summary, 'runner wrote this');
});

// ---- user verdict ------------------------------------------------------------------------------------------------------
async function verdictHarness() {
  const h = await harness();
  await h.repo.updateNote(h.nodes[H].path, {});
  await h.repo.writeTopicKind(h.nodes[H].path, 'hypothesis');
  Object.assign(h.view, { history: { push() {} }, refreshAfterSavedChange: async () => {}, relationsEnabled: () => true, isHypothesis: () => true });
  return h;
}

test('legacy verdict: the Inspector setter writes the note leaning but never the legacy argumentMap key (read-only); aiVerdict and userVerdict untouched', async () => {
  const h = await verdictHarness();
  const hy = h.nodes[H];
  h.view.map.argumentMap.hypotheses[0].aiVerdict = 'refuted';
  await h.repo.saveMap(MAP, h.view.map);
  const keyBefore = JSON.stringify(core.parseMap(h.contents.get(MAP)).argumentMap);
  await h.view.changeHypothesisLeaning(hy, 'supported');
  const saved = core.parseMap(h.contents.get(MAP));
  const entry = saved.argumentMap.hypotheses[0];
  assert.equal(entry.userVerdict, undefined, 'the legacy key gets no userVerdict');
  assert.equal(JSON.stringify(saved.argumentMap), keyBefore, 'the legacy key is byte-identical');
  assert.equal(entry.aiVerdict, 'refuted');
  assert.equal((await h.repo.readNote(hy.path)).hypothesisLeaning, 'supported', 'the note leaning (a note, not the key) is still saved');
  assert.equal(h.view.argumentVerdictOf(hy.id), 'refuted', 'the legacy display shows the stored verdict');
  assert.equal(modelV1.isVerified(entry), false);
  assert.equal(modelV1.displayVerdict(entry), 'verifying');
  assert.equal((await h.repo.readNote(hy.path)).hypothesisStrength, 'weak', 'the existing setter lifts none to weak, exactly as on any map');
});

test('legacy verdict: no verdict reads as undecided, the AI value shows; the user value is not written; a plain map gets no userVerdict', async () => {
  const h = await verdictHarness();
  const hy = h.nodes[H];
  const entry = h.view.map.argumentMap.hypotheses[0];
  entry.needs[0].state = 'found';
  assert.equal(h.view.argumentVerdictOf(hy.id), 'undecided');
  entry.aiVerdict = 'supported';
  assert.equal(h.view.argumentVerdictOf(hy.id), 'supported');
  await h.repo.saveMap(MAP, h.view.map);
  await h.view.changeHypothesisLeaning(hy, 'refuted');
  const saved = core.parseMap(h.contents.get(MAP)).argumentMap.hypotheses[0];
  assert.equal(saved.userVerdict, undefined, 'legacy: never written');
  assert.equal(modelV1.isVerified(saved), true, 'the AI value stands; the user value never overrides it on a legacy map');
  const plain = await harness(undefined, {}, false);
  Object.assign(plain.view, { history: { push() {} }, refreshAfterSavedChange: async () => {}, relationsEnabled: () => true, isHypothesis: () => true });
  await plain.view.changeHypothesisLeaning(plain.nodes[H], 'supported');
  assert.equal(core.parseMap(plain.contents.get(MAP)).argumentMap, undefined);
  assert.equal(plain.view.argumentVerdictOf(plain.nodes[H].id), undefined);
});

test('v2 verdict: the Inspector setter writes the note leaning and the key userVerdict in one save; the card shows the mark chip; the mark never reaches a step input; no-key maps get none', async () => {
  const h = await harness([...'PRCQDTMHNF'], {}, false);
  Object.assign(h.view, { history: { push() {} }, refreshAfterSavedChange: async () => {}, relationsEnabled: () => true, isHypothesis: () => true });
  const [P_, PR, C_, Q1, D1, Q2, CMP, H1, N1] = h.nodes;
  await h.repo.writeTopicKind(H1.path, 'hypothesis');
  const state = v2State({ P: P_.id, PR: PR.id, C: C_.id, Q1: Q1.id, D1: D1.id, Q2: Q2.id, CMP: CMP.id, H1: H1.id, N1: N1.id });
  delete state.hypotheses[0].userVerdict;
  h.view.map.argumentMap = state;
  await h.repo.saveMap(MAP, h.view.map);
  await h.view.changeHypothesisLeaning(H1, 'refuted');
  const saved = core.parseMap(h.contents.get(MAP)).argumentMap;
  assert.equal(saved.hypotheses[0].userVerdict, 'refuted', 'the key records the user mark');
  assert.equal(saved.hypotheses[0].verdict.value, 'supported', 'the AI verdict is untouched');
  assert.equal((await h.repo.readNote(H1.path)).hypothesisLeaning, 'refuted', 'the note is saved as before');
  const cardModule = S.load('experiences/visual-map/argument-card-v2.ts');
  const { translate } = S.load('i18n.ts');
  const shown = cardModule.describeArgumentCardV2(model.readArgumentMap(core.parseMap(h.contents.get(MAP))).data, H1.id, (k, ...v) => translate('en', k, ...v));
  assert.ok(shown.chips.some(chip => /refuted/i.test(chip.text) && chip.text !== 'Refuted'), 'the mark chip appears after a redraw');
  // The mark is a mark only (machine layer: steps-argument-machine-v2-verdict 使用者標記不影響輸入); here the write changes nothing but that field.
  const rest = JSON.parse(JSON.stringify(saved)); delete rest.hypotheses[0].userVerdict;
  assert.deepEqual(rest, JSON.parse(JSON.stringify({ ...state, hypotheses: [{ ...state.hypotheses[0] }] })), 'only userVerdict changed in the key');
  await h.view.changeHypothesisLeaning(H1, 'undecided');
  assert.equal(core.parseMap(h.contents.get(MAP)).argumentMap.hypotheses[0].userVerdict, 'undecided');
});

test('v2 verdict: a hypothesis note that is not in the key (user-added or old note) saves only the note; no key write, no error, the save still succeeds', async () => {
  const h = await harness([...'PRCQDTMHNF'], {}, false);
  Object.assign(h.view, { history: { push() {} }, refreshAfterSavedChange: async () => {}, relationsEnabled: () => true, isHypothesis: () => true });
  const [P_, PR, C_, Q1, D1, Q2, CMP, H1, N1] = h.nodes;
  await h.repo.writeTopicKind(H1.path, 'hypothesis');
  const state = v2State({ P: P_.id, PR: PR.id, C: C_.id, Q1: Q1.id, D1: D1.id, Q2: Q2.id, CMP: CMP.id, H1: H1.id, N1: N1.id });
  h.view.map.argumentMap = state;
  await h.repo.saveMap(MAP, h.view.map);
  const keyBefore = JSON.stringify(core.parseMap(h.contents.get(MAP)).argumentMap);
  const stranger = { ...H1, id: 'user-added-node-not-in-key' };
  await h.view.changeHypothesisLeaning(stranger, 'refuted');
  assert.equal(JSON.stringify(core.parseMap(h.contents.get(MAP)).argumentMap), keyBefore, 'the key is byte-identical');
  assert.equal((await h.repo.readNote(H1.path)).hypothesisLeaning, 'refuted', 'the note leaning is still written');
});
