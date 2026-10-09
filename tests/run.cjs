const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const vm = require('node:vm');
const path = require('node:path');
const { test: nodeTest } = require('node:test');
const layer = process.argv.find(value => value.startsWith('--layer='))?.split('=')[1];
if (layer && !['unit', 'integration'].includes(layer)) throw new Error('Unknown test layer');
const test = (name, fn) => { if (!layer || layer === 'unit') nodeTest(name, fn); };
const integrationTest = (name, fn) => { if (!layer || layer === 'integration') nodeTest(name, fn); };
const { buildSync } = require('esbuild');
const root = path.resolve(__dirname, '..');
function load(entry, overrides = {}, windowValues = {}) {
  if (overrides.obsidian && !overrides.obsidian.Component) overrides = { ...overrides, obsidian: { ...overrides.obsidian, Component: class {} } };
  const code = buildSync({ entryPoints: [path.join(root, entry)], bundle: true, write: false, platform: 'node', format: 'cjs', external: ['obsidian', 'node:*'] }).outputFiles[0].text;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, require: name => overrides[name] || require(name), console, TextDecoder, crypto: require('node:crypto').webcrypto, process, AbortController, Option: class { constructor(text, value) { this.tag = 'option'; this.text = text; this.value = value; this.cls = ''; this.children = []; this.attrs = {}; } }, HTMLInputElement: class {}, HTMLTextAreaElement: class {}, HTMLSelectElement: class {}, window: { setTimeout, clearTimeout, ...windowValues } });
  return module.exports;
}
const core = load('map-model.ts');
const layout = load('map-layout.ts');
const logging = load('log-manager.ts');
const node = (id, parentId = null, collapsed = false) => ({ id, parentId, path: `${id}.md`, x: 0, y: 0, collapsed });
const map = nodes => ({ id: 'map', title: '測試心智圖', version: 1, nodes, viewport: { x: 0, y: 0, zoom: 1 } });
const plain = obj => JSON.parse(JSON.stringify(obj));
const plannerReview = (decision, { rationale, stopReason, question } = {}, summary = 'Supported conditional answer.', detail = 'Evidence-based detail.', suggestions = []) => ({
  summary,
  detail: `<!-- mindsearch-review ${JSON.stringify({ decision, rationale, ...(stopReason ? { stopReason } : {}), ...(question ? { question } : {}) })} -->\n${detail}`,
  suggestions: suggestions.map(item => typeof item === 'string' ? { title: item, task: '', contribution: '' } : item),
  visualReferences: []
});
async function seedCoverageAncestors(repo, mapPath, branchId) {
  const saved = await repo.readMap(mapPath); let parent = null;
  for (let index = 0; index < 2; index++) {
    const n = await repo.createNote(`Previously answered condition ${index}`, 'gpt-6-luna', saved, mapPath, 'workspace');
    n.mindSearchKind = 'question'; n.parentId = saved.nodes.find(node => node.parentId === null)?.id ?? null;
    saved.nodes.push(n); const id = `ancestor-${branchId}-${index}`;
    saved.mindSearch.branches.push({ id, questionNodeId: n.id, parentBranchId: parent, answerSnapshot: { selections: [], freeText: `Known prior condition ${index}` }, inputSnapshot: { topic: saved.title, conditions: { [`Prior condition ${index}`]: 'Known' }, upstreamResults: [] }, createdAt: new Date().toISOString(), results: [] });
    parent = id;
  }
  const target = saved.mindSearch.branches.find(b => b.id === branchId); target.parentBranchId = parent;
  const targetNode = saved.nodes.find(n => n.id === target.questionNodeId); if (targetNode.mindSearchQuestion) targetNode.mindSearchQuestion.parentBranchId = parent;
  await repo.saveMap(mapPath, saved);
}
function deliveryFixture(context) {
  if (mindSearchPhase(context, 'delivery-outline')) return { summary: 'Document outline', detail: '<!-- mindsearch-delivery-outline {"sections":[{"heading":"Answer","purpose":"Deliver original goal","searchTask":"Verify practical details"}]} -->', suggestions: [], visualReferences: [] };
  if (mindSearchPhase(context, 'delivery-research')) return { summary: 'Verified delivery evidence', detail: '<!-- mindsearch-delivery-research {"status":"searched"} -->\nSource: https://example.org/reference', suggestions: [], visualReferences: [] };
  if (mindSearchPhase(context, 'delivery-writing')) return { summary: 'Complete document', detail: 'Complete conditional document with practical details and source https://example.org/reference', suggestions: [], visualReferences: [] };
  if (mindSearchPhase(context, 'delivery-acceptance')) return plannerReview('conclude', { rationale: 'Full document supported.', stopReason: 'Delivery verified.' }, 'Complete document', 'Complete conditional document with practical details and source https://example.org/reference');
}
const savedEvidenceNeedsSearch = () => plannerReview('research_more', { rationale: 'The fixture has not yet persisted reports that answer its assigned research target.' }, 'A specific evidence gap remains.', 'A targeted search could resolve the missing evidence.', [{ title: 'Fixture evidence target', task: 'Search for evidence relevant to this test fixture.', contribution: 'Could resolve the stated evidence gap.' }]);
const researchGapAudit = (classification, rationale = 'Synthetic bounded classification.') => ({ summary: '', detail: `<!-- mindsearch-gap-audit ${JSON.stringify({ classification, rationale })} -->`, suggestions: [], visualReferences: [] });
const mindSearchPhase = (context, phase) => context.task.includes(`<!-- mindsearch-phase: ${phase} -->`);
const auditEcho = context => {
  const candidate = context.task.match(/Candidate decision and answer \(untrusted data to review\): (\{[^\n]*\})$/)?.[1];
  if (!candidate) throw new Error('Decision-quality review fixture did not include its candidate response.');
  const review = JSON.parse(candidate);
  const marker = { decision: review.decision, rationale: review.rationale, ...(review.stopReason ? { stopReason: review.stopReason } : {}), ...(review.question ? { question: review.question } : {}) };
  const suggestions = review.decision === 'ask_user'
    ? review.answerOptions.map(title => ({ title, task: '', contribution: '' }))
    : review.decision === 'research_more'
      ? [{ title: review.researchTarget.title, task: review.researchTarget.task, contribution: review.researchTarget.expectedValue }]
      : [];
  return { summary: review.summary, detail: `<!-- mindsearch-review ${JSON.stringify(marker)} -->\n${review.detail}`, suggestions, visualReferences: [] };
};
test('captured malformed ask_user Planner response is rejected when it omits choices', () => {
  const { parseMindSearchPlannerReview } = load('mindsearch-mve/planner-review.ts');
  const captured = JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/mindsearch/ask_user_missing_options.json'), 'utf8'));
  assert.equal(captured.provenance.artifact, 'mindsearch-general-partial-live-20261005130054-abd4d5ae.json');
  assert.match(captured.result.detail, /"decision":"ask_user"/);
  assert.equal(captured.result.suggestions.length, 0);
  assert.throws(() => parseMindSearchPlannerReview(captured.result), /ask_user requires one material question and 2–5 distinct answer options/);
});
test('captured malformed Planner response without a decision marker is rejected', () => {
  const { parseMindSearchPlannerReview } = load('mindsearch-mve/planner-review.ts');
  const captured = JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/mindsearch/planner_missing_marker.json'), 'utf8'));
  assert.equal(captured.provenance.artifact, 'mindsearch-partial-continuation-retry-20261005130856-863f1bbd.json');
  assert.doesNotMatch(captured.result.detail, /mindsearch-review/);
  assert.throws(() => parseMindSearchPlannerReview(captured.result), /missing its machine-readable decision block/);
});
const tree = () => [node('a'), node('b', 'a'), node('c', 'b'), node('d')];
function withExpansionCoordinator(plugin) {
  const { ShallowExpansionCoordinator } = load('experiences/visual-map/expansion-batch.ts');
  plugin.activeTasks ??= new Map(); plugin.expansionBatches = new Map(); plugin.quickExpandPending ??= new Set(); plugin.quickExpandFailures ??= new Map();
  plugin.expansionCoordinator = new ShallowExpansionCoordinator(plugin.activeTasks, plugin.expansionBatches);
  return plugin;
}
test('rejects self links, descendant links, missing parent; allows detaching and reparenting', () => {
  assert.equal(core.canParent(tree(), 'a', 'a'), false);
  assert.equal(core.canParent(tree(), 'a', 'c'), false);
  assert.equal(core.canParent(tree(), 'b', 'missing'), false);
  assert.equal(core.canParent(tree(), 'b', 'd'), true);
  assert.equal(core.canParent(tree(), 'b', null), true);
});
test('collapse hides every descendant, not unrelated roots; nested collapse persists', () => {
  const nodes = tree(); nodes[0].collapsed = true; nodes[1].collapsed = true;
  assert.deepEqual(Array.from(core.visibleNodes(nodes), n => n.id), ['a', 'd']);
  nodes[0].collapsed = false;
  assert.deepEqual(Array.from(core.visibleNodes(nodes), n => n.id), ['a', 'b', 'd']);
});
test('single removal promotes immediate children but preserves deeper links', () => {
  const result = core.removeNodes(tree(), 'a', false);
  assert.deepEqual(Array.from(result, n => [n.id, n.parentId]), [['b', null], ['c', 'b'], ['d', null]]);
});
test('branch removal removes descendants and leaves other trees intact', () => {
  assert.deepEqual(Array.from(core.removeNodes(tree(), 'a', true), n => n.id), ['d']);
});
test('map round trip retains structure, viewport and collapse', () => {
  const source = map(tree()); source.nodes[1].collapsed = true; source.viewport = { x: -720, y: 83, zoom: .65 };
  assert.deepEqual(plain(core.parseMap(core.serializeMap(source))), source);
});
test('clears stale question convergence links while preserving synthesis convergence', () => {
  const fixture = map([
    { ...node('question'), mindSearchKind: 'question', mindSearchConvergesFromNodeIds: ['research'] },
    { ...node('research', 'question'), mindSearchKind: 'research' },
    { ...node('synthesis', 'question'), mindSearchKind: 'synthesis', mindSearchConvergesFromNodeIds: ['research'] }
  ]);
  assert.equal(core.clearQuestionConvergenceEdges(fixture), true);
  assert.equal(fixture.nodes[0].mindSearchConvergesFromNodeIds, undefined, 'legacy question refs are removed');
  assert.deepEqual(plain(fixture.nodes[2].mindSearchConvergesFromNodeIds), ['research'], 'the synthesis node keeps its dashed link to research');
  assert.equal(core.clearQuestionConvergenceEdges(fixture), false, 'cleanup is idempotent');
  assert.deepEqual(plain(core.parentIdsForNode(fixture.nodes[0])), [], 'renderer never draws a dashed convergence edge into a question');
  assert.deepEqual(plain(core.parentIdsForNode(fixture.nodes[2])), ['question', 'research'], 'synthesis keeps its direct and dashed source edges');
});
test('repairs legacy MindSearch continuation convergence from preceding saved research only', () => {
  const fixture = map([
    { ...node('q1'), mindSearchKind: 'question', mindSearchConvergesFromNodeIds: ['legacy-wrong-source'] },
    { ...node('r1', 'q1'), mindSearchKind: 'research' },
    { ...node('r2', 'q1'), mindSearchKind: 'research' },
    { ...node('r-default-kind', 'q1'), mindSearchKind: 'research' },
    { ...node('synthesis', 'q1'), mindSearchKind: 'synthesis' },
    { ...node('r-future', 'q1'), mindSearchKind: 'research' },
    { ...node('conclusion', 'q1'), mindSearchKind: 'conclusion', mindSearchConvergesFromNodeIds: ['existing-source'] },
    { ...node('conclusion-missing', 'q1'), mindSearchKind: 'conclusion' },
    { ...node('q-legacy'), mindSearchKind: 'question' },
    { ...node('legacy-synthesis', 'q-legacy'), mindSearchKind: 'synthesis' }
  ]);
  fixture.mindSearch = { version: 1, branches: [
    { id: 'branch-with-reports', questionNodeId: 'q1', parentBranchId: null, answerSnapshot: { selections: [], freeText: 'synthetic' }, inputSnapshot: { topic: 'test', conditions: {}, upstreamResults: [] }, createdAt: '2026-10-09T00:00:00.000Z', results: [
      { resultId: 'r1', runId: 'run', attemptId: 'a1', nodeId: 'r1', notePath: 'r1.md', version: 1, kind: 'research', subtopicId: 'subtopic-1' },
      { resultId: 'r2', runId: 'run', attemptId: 'a1', nodeId: 'r2', notePath: 'r2.md', version: 2, kind: 'research', subtopicId: 'subtopic-2' },
      { resultId: 'legacy-default', runId: 'legacy-run', attemptId: 'a1', nodeId: 'r-default-kind', notePath: 'r-default-kind.md', version: 3, kind: 'research' },
      { resultId: 's', runId: 'run', attemptId: 'a1', nodeId: 'synthesis', notePath: 's.md', version: 4, kind: 'synthesis' },
      { resultId: 'future', runId: 'run', attemptId: 'a2', nodeId: 'r-future', notePath: 'future.md', version: 5, kind: 'research', subtopicId: 'subtopic-3' },
      { resultId: 'c', runId: 'run', attemptId: 'a2', nodeId: 'conclusion', notePath: 'c.md', version: 6, kind: 'conclusion' },
      { resultId: 'cm', runId: 'run', attemptId: 'a2', nodeId: 'conclusion-missing', notePath: 'cm.md', version: 7, kind: 'conclusion' }
    ] },
    { id: 'legacy-branch', questionNodeId: 'q-legacy', parentBranchId: null, answerSnapshot: { selections: [], freeText: 'synthetic' }, inputSnapshot: { topic: 'legacy', conditions: {}, upstreamResults: [] }, createdAt: '2026-10-09T00:00:00.000Z', results: [
      { resultId: 'legacy-synthesis', runId: 'legacy-run', attemptId: 'a1', nodeId: 'legacy-synthesis', notePath: 'legacy.md', version: 1, kind: 'synthesis' }
    ] }
  ], runs: [], pendingCommits: [] };
  assert.equal(core.repairMindSearchResultConvergence(fixture), true);
  assert.equal(fixture.nodes.find(item => item.id === 'synthesis').parentId, 'r2');
  assert.deepEqual(plain(fixture.nodes.find(item => item.id === 'synthesis').mindSearchConvergesFromNodeIds), ['r1', 'r2'], 'later reports are excluded from this saved synthesis');
  assert.deepEqual(plain(fixture.nodes.find(item => item.id === 'conclusion').mindSearchConvergesFromNodeIds), ['existing-source'], 'existing convergence edges are not rewritten');
  assert.equal(fixture.nodes.find(item => item.id === 'conclusion').parentId, 'q1');
  assert.equal(fixture.nodes.find(item => item.id === 'conclusion-missing').parentId, 'r-future');
  assert.deepEqual(plain(fixture.nodes.find(item => item.id === 'conclusion-missing').mindSearchConvergesFromNodeIds), ['r1', 'r2', 'r-future']);
  assert.deepEqual(plain(fixture.nodes.find(item => item.id === 'q1').mindSearchConvergesFromNodeIds), ['legacy-wrong-source'], 'question nodes are not modified');
  assert.equal(fixture.nodes.find(item => item.id === 'legacy-synthesis').parentId, 'q-legacy', 'legacy branch without saved research remains unchanged');
  assert.equal(core.repairMindSearchResultConvergence(fixture), false, 'repair is idempotent');
});
test('MindSearch rejects a relocated result node when its branch reference still points to the source Vault', () => {
  const malformed = {
    version: 1, id: 'mindsearch-fixture-map', title: 'Planner ask-user follow-up UI fixture',
    nodes: [
      { id: '8e541501-7636-41a3-8bd8-41650937236d', path: 'Agent Workspace/Topics/Planner ask-user follow-up UI fixture/Notes/如何用鑄鐵鍋在家煎出自己喜歡的牛排熟度？.md', parentId: null, x: 80, y: 80, collapsed: false, mindSearchKind: 'topic' },
      { id: '5d756d6e-d119-43ac-b611-54353b574aa4', path: 'Agent Workspace/Topics/Planner ask-user follow-up UI fixture/Notes/問題 · 你希望牛排煎到哪種熟度？.md', parentId: '8e541501-7636-41a3-8bd8-41650937236d', x: 440, y: 80, collapsed: false, mindSearchKind: 'question', mindSearchQuestion: { requestId: '282bceaa-8fb9-47e3-abc7-dd2ce293e705', parentBranchId: null, options: [{ id: 'rare', label: '三分熟（中心偏紅）' }, { id: 'medium', label: '五分熟' }], allowMultiple: true, allowFreeText: true } },
      { id: 'e0a25570-f0f1-47d2-a4e5-3c645cde6036', path: 'Agent Workspace/Topics/Planner ask-user follow-up UI fixture/Notes/你希望牛排煎到哪種熟度？・回答研究.md', parentId: '5d756d6e-d119-43ac-b611-54353b574aa4', x: 800, y: 80, collapsed: false, mindSearchKind: 'research' }
    ],
    viewport: { x: 0, y: 0, zoom: 1 },
    mindSearch: {
      version: 1, branches: [{ id: '5719e17c-fced-46e5-947c-410dd73fbed9', submissionId: '7eb4a718-f3e7-462e-bda4-439daac43030', questionNodeId: '5d756d6e-d119-43ac-b611-54353b574aa4', parentBranchId: null, answerSnapshot: { selections: ['rare'], freeText: 'Synthetic UI fixture.' }, inputSnapshot: { topic: '如何用鑄鐵鍋在家煎出自己喜歡的牛排熟度？', conditions: { '你希望牛排煎到哪種熟度？': 'Synthetic answer.' }, upstreamResults: [] }, createdAt: '2026-10-05T05:37:21.519Z', results: [{ resultId: 'result-f042d30c-c76a-4bd1-8912-990a14ef1f2f-attempt-1', runId: 'f042d30c-c76a-4bd1-8912-990a14ef1f2f', attemptId: 'attempt-1', nodeId: 'e0a25570-f0f1-47d2-a4e5-3c645cde6036', notePath: 'Agent Workspace/Topics/如何用鑄鐵鍋在家煎出自己喜歡的牛排熟度？/Notes/你希望牛排煎到哪種熟度？・回答研究.md', version: 1 }] }],
      runs: [{ id: 'f042d30c-c76a-4bd1-8912-990a14ef1f2f', branchId: '5719e17c-fced-46e5-947c-410dd73fbed9', currentAttemptId: 'attempt-1', attempts: [{ id: 'attempt-1', inputSnapshotHash: 'e1d8c45129677f8003c8233e371fba8722032a0e367b8e02f9ab09423c57a44f', status: 'completed' }] }],
      pendingCommits: []
    }
  };
  assert.throws(() => core.parseMap(core.serializeMap(malformed)), /Invalid MindSearch branch result reference/);
  const repaired = plain(malformed); repaired.mindSearch.branches[0].results[0].notePath = repaired.nodes.find(item => item.id === 'e0a25570-f0f1-47d2-a4e5-3c645cde6036').path;
  assert.equal(core.parseMap(core.serializeMap(repaired)).mindSearch.branches[0].results[0].notePath, repaired.nodes[2].path);
});
test('MindSearch accepts legacy persisted Planner answer option objects without rewriting them', () => {
  const legacy = {
    version: 1, id: 'legacy-mindsearch-map', title: 'Legacy MindSearch fixture',
    nodes: [
      { id: 'topic', path: 'topic.md', parentId: null, x: 0, y: 0, collapsed: false, mindSearchKind: 'topic' },
      { id: 'question', path: 'question.md', parentId: 'topic', x: 360, y: 0, collapsed: false, mindSearchKind: 'question' },
      { id: 'result', path: 'result.md', parentId: 'question', x: 720, y: 0, collapsed: false, mindSearchKind: 'research' }
    ],
    viewport: { x: 0, y: 0, zoom: 1 },
    mindSearch: {
      version: 1,
      branches: [{ id: 'branch', questionNodeId: 'question', parentBranchId: null, answerSnapshot: { selections: ['x'], freeText: '' }, inputSnapshot: { topic: 'Legacy fixture', conditions: {}, upstreamResults: [] }, createdAt: 'now', results: [{ resultId: 'result-1', runId: 'run', attemptId: 'attempt-1', nodeId: 'result', notePath: 'result.md', version: 1 }] }],
      runs: [{ id: 'run', branchId: 'branch', currentAttemptId: 'attempt-1', attempts: [{ id: 'attempt-1', inputSnapshotHash: 'hash', status: 'completed', plannerReviews: [{ decision: 'ask_user', rationale: 'A user condition is missing.', researchTurn: 1, question: 'Which option?', answerAxis: { id: 'axis', label: 'Preference' }, answerOptions: [{ axisId: 'axis', value: 'Option A' }, { axisId: 'axis', value: 'Option B' }] }] }] }],
      pendingCommits: []
    }
  };
  assert.deepEqual(plain(core.parseMap(core.serializeMap(legacy)).mindSearch), plain(legacy.mindSearch));
});
test('new branch layout keeps older coordinates while full layout arranges all levels', () => {
  const nodes = [
    { ...node('root'), x: 80, y: 80 },
    { ...node('older', 'root'), x: 440, y: 80 },
    { ...node('new-a', 'root'), x: 440, y: 80 },
    { ...node('new-b', 'root'), x: 440, y: 80 },
    { ...node('grandchild', 'new-a'), x: 440, y: 80 }
  ];
  const branch = layout.arrangeNewBranch(nodes, 'root', new Set(['new-a', 'new-b', 'grandchild']));
  assert.deepEqual(plain(branch.slice(0, 2)), plain(nodes.slice(0, 2)));
  for (const fresh of branch.slice(2)) for (const fixed of branch.slice(0, 2)) assert.ok(Math.abs(fresh.x - fixed.x) >= 300 || Math.abs(fresh.y - fixed.y) >= 190);
  assert.equal(branch[4].x, branch[2].x + 360);
  const full = layout.arrangeMap(nodes);
  assert.equal(full[4].x, full[2].x + 360);
  assert.notDeepEqual(plain(full), plain(nodes));
  const crowded = [{ ...node('root'), x: 0, y: 0 }, ...Array.from({ length: 5 }, (_, index) => ({ ...node(`old-${index}`, 'root'), x: 360, y: index * 440 })), { ...node('fresh', 'root'), x: 0, y: 0 }];
  const clear = layout.arrangeNewBranch(crowded, 'root', new Set(['fresh']));
  for (const old of clear.slice(1, 6)) assert.ok(Math.abs(clear[6].x - old.x) >= 300 || Math.abs(clear[6].y - old.y) >= 190);
});
test('malformed maps fail before data can be overwritten', () => {
  for (const nodes of [[node('a'), node('a')], [node('a', 'b'), node('b', 'a')], [node('a', 'missing')]]) {
    assert.throws(() => core.parseMap(core.serializeMap(map(nodes))));
  }
  assert.throws(() => core.parseMap('No map data'));
});
test('MindSearch pending commits must match their run, current saving attempt, branch, and owned result node', () => {
  const valid = map([node('question'), node('result', 'question')]);
  valid.mindSearch = {
    version: 1,
    branches: [
      { id: 'branch-a', questionNodeId: 'question', parentBranchId: null, answerSnapshot: { selections: [], freeText: '' }, inputSnapshot: { topic: 'topic', conditions: {}, upstreamResults: [] }, createdAt: 'now', results: [] },
      { id: 'branch-b', questionNodeId: 'question', parentBranchId: null, answerSnapshot: { selections: [], freeText: '' }, inputSnapshot: { topic: 'topic', conditions: {}, upstreamResults: [] }, createdAt: 'now', results: [] }
    ],
    runs: [{ id: 'run-a', branchId: 'branch-a', currentAttemptId: 'attempt-a', attempts: [{ id: 'attempt-a', inputSnapshotHash: 'hash', status: 'saving' }] }],
    resultDrafts: [{ id: 'draft-a', branchId: 'branch-a', runId: 'run-a', attemptId: 'attempt-a', nodeId: 'result', notePath: 'result.md', title: 'result', status: 'ready', inputSnapshotHash: 'hash' }],
    pendingCommits: [{ resultId: 'result-a', branchId: 'branch-a', runId: 'run-a', attemptId: 'attempt-a', resultDraftId: 'draft-a', nodeId: 'result', notePath: 'result.md', title: 'result', summary: 'summary', detail: 'detail', version: 1 }]
  };
  assert.deepEqual(plain(core.parseMap(core.serializeMap(valid)).mindSearch), plain(valid.mindSearch));
  const crossBranch = structuredClone(valid); crossBranch.mindSearch.pendingCommits[0].branchId = 'branch-b';
  assert.throws(() => core.parseMap(core.serializeMap(crossBranch)), /Invalid MindSearch pending commit/);
  const staleAttempt = structuredClone(valid); staleAttempt.mindSearch.pendingCommits[0].attemptId = 'attempt-old';
  assert.throws(() => core.parseMap(core.serializeMap(staleAttempt)), /Invalid MindSearch pending commit/);
});
test('model inheritance distinguishes CLI default from absent parent and copies once', () => {
  assert.equal(core.inheritModel(undefined, 'root-model'), 'root-model');
  assert.equal(core.inheritModel('', 'root-model'), '');
  let parent = 'parent-model'; const child = core.inheritModel(parent, 'root-model'); parent = 'changed';
  assert.equal(child, 'parent-model');
});
test('workspace defaults to the configured low-cost model and low reasoning', () => {
  assert.equal(DEFAULT_SETTINGS.cliModel, 'gpt-5.6-luna');
  assert.equal(DEFAULT_SETTINGS.cliReasoning, 'low');
  assert.equal(DEFAULT_SETTINGS.codexPath, 'codex');
  assert.equal(DEFAULT_SETTINGS.claudePath, 'claude');
  assert.equal(DEFAULT_SETTINGS.firstUseNoticeSeen, false);
  assert.equal(DEFAULT_SETTINGS.codexUsageNoticeSeen, false);
  assert.equal(DEFAULT_SETTINGS.claudeUsageNoticeSeen, false);
  assert.equal(DEFAULT_SETTINGS.workspaceInitialized, false);
  assert.equal(DEFAULT_SETTINGS.sampleTourVersionSeen, 0);
  assert.doesNotMatch(DEFAULT_SETTINGS.models, /claude:/);
  assert.equal(normalizeReasoningLevel('medium'), 'medium');
  assert.equal(normalizeReasoningLevel('high'), 'high');
  assert.equal(normalizeReasoningLevel('auto'), 'auto');
  assert.equal(normalizeReasoningLevel('unsupported'), 'low');
});
test('product architecture keeps shell, core, and experiences separated', () => {
  const shell = fs.readFileSync(path.join(root, 'main.ts'), 'utf8');
  assert.doesNotMatch(shell, /class VisualAgentMapView/);
  assert.doesNotMatch(shell, /class CoffeeTablesView/);
  assert.doesNotMatch(shell, /class AiTaskService/);

  const coreFiles = fs.readdirSync(path.join(root, 'core')).filter(name => name.endsWith('.ts'));
  for (const name of coreFiles) {
    const source = fs.readFileSync(path.join(root, 'core', name), 'utf8');
    assert.doesNotMatch(source, /(?:\.\.\/)+experiences\//, `core/${name} must not import an experience`);
    assert.doesNotMatch(source, /from ["'][^"']*repository["']/, `core/${name} must not depend on repository settings that include experience state`);
  }

  for (const sharedAi of ['types.ts', 'task-policy.ts', 'visual-guidance.ts']) {
    const source = fs.readFileSync(path.join(root, 'ai', sharedAi), 'utf8');
    assert.doesNotMatch(source, /from ["'][^"']*repository["']/, `ai/${sharedAi} must stay experience-independent`);
    assert.doesNotMatch(source, /experiences\//, `ai/${sharedAi} must not import an experience`);
  }

  const visualFiles = fs.readdirSync(path.join(root, 'experiences', 'visual-map')).filter(name => name.endsWith('.ts'));
  for (const name of visualFiles) {
    const source = fs.readFileSync(path.join(root, 'experiences', 'visual-map', name), 'utf8');
    assert.doesNotMatch(source, /experiences\/coffee-tables|\.\.\/coffee-tables/, `visual-map/${name} must not import Coffee Tables`);
  }

  const coffeeFiles = fs.readdirSync(path.join(root, 'experiences', 'coffee-tables')).filter(name => name.endsWith('.ts'));
  for (const name of coffeeFiles) {
    const source = fs.readFileSync(path.join(root, 'experiences', 'coffee-tables', name), 'utf8');
    assert.doesNotMatch(source, /experiences\/visual-map|\.\.\/visual-map/, `coffee-tables/${name} must not import Visual Map`);
  }
});

test('thinking artifacts route through shared core without view coupling', async () => {
  const artifacts = load('core/thinking-artifact.ts');
  const { ExperienceRouter } = load('core/experience-router.ts');
  const artifact = artifacts.createThinkingArtifact({
    id: 'artifact-1',
    kind: 'insight',
    title: 'A useful insight',
    content: 'The discussion exposed a tradeoff.',
    origin: { experience: 'coffee-tables', sessionId: 'table-1' },
    sources: [{ label: 'Coffee Table', experience: 'coffee-tables', sessionId: 'table-1' }]
  });
  assert.equal(artifact.version, 1);
  const router = new ExperienceRouter();
  let received;
  const unregister = router.register('visual-map', async value => { received = value; });
  assert.equal(router.canHandoff('visual-map'), true);
  await router.handoff({ target: 'visual-map', artifact });
  assert.deepEqual(plain(received), plain(artifact));
  unregister();
  assert.equal(router.canHandoff('visual-map'), false);
  await assert.rejects(() => router.handoff({ target: 'visual-map', artifact }), /not available/);
});

test('model identifiers select one provider and preserve stable Claude aliases', () => {
  const providers = load('ai/providers/provider.ts');
  assert.equal(providers.providerForModel('gpt-5.6-luna'), 'codex');
  assert.equal(providers.providerForModel('claude:sonnet'), 'claude');
  assert.equal(providers.providerModelId('claude:opus'), 'opus');
  assert.equal(providers.claudeModelChoice('claude:sonnet').model, 'sonnet');
  assert.equal(providers.claudeModelChoice('claude:unknown'), undefined);
});
test('stale Codex discovery cannot replace the current models or reasoning catalog', async () => {
  const { ModelDiscovery } = load('core/model-discovery.ts');
  let first, second;
  const discovery = new ModelDiscovery(() => true, () => new Promise(resolve => { if (!first) first = resolve; else second = resolve; }), () => false);
  const stale = discovery.refresh('codex');
  discovery.invalidate('codex');
  const current = discovery.refresh('codex');
  second({ models: ['current'], reasoningEfforts: { current: ['high'] } });
  await current;
  first({ models: ['stale'], reasoningEfforts: { stale: ['low'] } });
  await stale;
  assert.deepEqual(plain(discovery.state('codex')), { provider: 'codex', status: 'ready', models: ['current'], reasoningEfforts: { current: ['high'] } });
});
test('Codex reasoning metadata survives loading and error refresh states', async () => {
  const { ModelDiscovery } = load('core/model-discovery.ts'); let fail;
  let loadCount = 0;
  const discovery = new ModelDiscovery(() => true, () => {
    if (loadCount++ === 0) return Promise.resolve({ models: ['model'], reasoningEfforts: { model: ['high'] } });
    return new Promise((_resolve, reject) => { fail = reject; });
  }, () => false);
  await discovery.refresh('codex');
  const loading = discovery.refresh('codex');
  assert.deepEqual(plain(discovery.state('codex').reasoningEfforts), { model: ['high'] });
  fail(new Error('temporary failure'));
  await loading;
  assert.deepEqual(plain(discovery.state('codex').reasoningEfforts), { model: ['high'] });
});
test('Coffee Tables preserves a requested reasoning choice while model discovery is pending', () => {
  const { reasoningChoiceState } = load('experiences/coffee-tables/view.ts', { obsidian });
  assert.deepEqual(plain(reasoningChoiceState('high', [], 'loading')), { values: ['auto', 'high'], selected: 'high' });
  assert.deepEqual(plain(reasoningChoiceState('high', [], 'error')), { values: ['auto', 'high'], selected: 'high' });
  assert.deepEqual(plain(reasoningChoiceState('high', ['low'], 'ready')), { values: ['auto', 'low'], selected: 'auto' });
  assert.deepEqual(plain(reasoningChoiceState('high', ['high'], 'ready')), { values: ['auto', 'high'], selected: 'high' });
});
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
test('a shallow batch with no accepted child rejects after all failures and releases ownership', async () => {
  const { ShallowExpansionCoordinator } = load('experiences/visual-map/expansion-batch.ts');
  const active = new Map(), states = new Map(), coordinator = new ShallowExpansionCoordinator(active, states), calls = [];
  await assert.rejects(coordinator.start('parent.md', [node('first'), node('second')], async child => { calls.push(child.path); throw new Error('not accepted'); }, () => {}), /stopped before launch/);
  assert.deepEqual(calls, ['first.md', 'second.md']);
  assert.equal(states.get('parent.md').completed, 2);
  assert.equal(states.get('parent.md').failures.length, 2);
  assert.equal(active.has('parent.md'), false);
});
test('automatic reasoning respects manual choices and local tasks avoid research', () => {
  const { effectiveReasoningLevel, researchGuidance } = load('ai/task-policy.ts');
  const task = { title: 'Topic', summary: '', rules: '', detail: '', task: 'Organize', ancestors: '', mode: 'task', researchMode: 'local' };
  assert.equal(effectiveReasoningLevel(task, 'auto'), 'low');
  assert.equal(effectiveReasoningLevel({ ...task, mode: 'synthesize' }, 'auto'), 'medium');
  assert.equal(effectiveReasoningLevel({ ...task, sourceContext: 'x'.repeat(6_001) }, 'auto'), 'medium');
  assert.equal(effectiveReasoningLevel({ ...task, mode: 'synthesize' }, 'high'), 'high');
  assert.match(researchGuidance(task), /不要搜尋網路/);
  assert.match(researchGuidance(task), /現有資料不足/);
  assert.match(researchGuidance({ ...task, researchMode: 'research' }), /沒有固定/);
  assert.match(researchGuidance({ ...task, researchMode: 'research' }), /預期價值偏低時停止/);
});
test('research depth remains qualitative and imposes no fixed query or source count', () => {
  const { researchGuidance } = load('ai/task-policy.ts');
  assert.match(researchGuidance({ researchMode: 'local', researchDepth: 'fast' }), /快速概覽/);
  assert.match(researchGuidance({ researchMode: 'local', researchDepth: 'deep' }), /深入研究/);
  assert.match(researchGuidance({ researchMode: 'research', researchDepth: 'fast' }), /沒有固定/);
  assert.doesNotMatch(researchGuidance({ researchMode: 'research', researchDepth: 'fast' }), /最多 \\d+ 次/);
});
test('explicit source context survives long existing Markdown', () => {
  const { buildPreparedTaskContext } = load('ai/context-builder.ts');
  const context = { title: 'Topic', summary: '', rules: '', detail: 'old '.repeat(8_000), task: 'Review selected note', ancestors: '', workingFindings: '', sourceContext: '來源：selected.md\nverified evidence', mode: 'task', researchMode: 'local', researchDepth: 'normal', visualMode: 'off' };
  const prepared = buildPreparedTaskContext(context, 'test-model', 1_000);
  assert.match(prepared.context.sourceContext, /verified evidence/);
  assert.ok(prepared.context.detail.length < context.detail.length);
});
test('Codex executable discovery covers Homebrew, local npm, Volta, fnm, nvm and inherited PATH', () => {
  const { executableCandidates } = load('main.ts', { obsidian });
  const candidates = executableCandidates('codex', '/Users/friend', '/custom/npm/bin:/usr/bin', ['v20.18.0']);
  for (const path of [
    '/Users/friend/.local/bin/codex', '/Users/friend/.npm-global/bin/codex',
    '/Users/friend/.volta/bin/codex', '/Users/friend/.fnm/current/bin/codex',
    '/opt/homebrew/bin/codex', '/usr/local/bin/codex',
    '/Users/friend/.nvm/versions/node/v20.18.0/bin/codex', '/custom/npm/bin/codex'
  ]) assert.ok(candidates.includes(path), path);
  assert.deepEqual(Array.from(executableCandidates('/exact/codex', '/Users/friend', '', [])), ['/exact/codex']);
});

integrationTest('Codex launch uses its sibling Node with automatic nvm discovery and explicit paths', async () => {
  const temporary = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'vam-codex-path-'));
  const home = path.join(temporary, 'Friend Home');
  const bin = path.join(home, '.nvm/versions/node/v24.14.0/bin');
  const executable = path.join(bin, 'codex');
  fs.mkdirSync(bin, { recursive: true });
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  fs.writeFileSync(path.join(bin, 'node'), `#!/bin/sh\nVAM_TEST_NODE=sibling exec ${quote(process.execPath)} "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(executable, `#!/usr/bin/env node
const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  const model = process.env.VAM_TEST_NODE === 'sibling' ? 'sibling-node' : 'wrong-node';
  const result = message.method === 'model/list'
    ? { data: [{ id: model, model, displayName: model, hidden: false, supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }] }
    : {};
  process.stdout.write(JSON.stringify({ id: message.id, result }) + '\\n');
});
`, { mode: 0o755 });
  try {
    for (const configured of ['codex', executable]) {
      const environment = { HOME: home, PATH: '/usr/bin:/bin', VAM_TEST_PRESERVED: 'yes' };
      const before = { ...environment };
      const { default: Plugin } = load('main.ts', { obsidian }, { process: { env: environment } });
      const plugin = new Plugin();
      plugin.settings.codexPath = configured; plugin.manifest = { version: '0.7.1' };
      const runtime = plugin.runtime(temporary);
      try {
        assert.equal(runtime.options.executable, executable);
        const models = await runtime.listModels();
        assert.equal(models[0].model, 'sibling-node');
        assert.equal(runtime.options.env.PATH.split(path.delimiter)[0], bin);
        assert.equal(runtime.options.env.VAM_TEST_PRESERVED, 'yes');
        assert.deepEqual(environment, before);
      } finally { runtime.stop(); }
    }
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});
test('Codex launch retains fallback PATH without adding the working directory', () => {
  for (const environment of [{}, { PATH: '/custom/bin:/usr/bin:/custom/bin', KEEP: 'yes' }]) {
    const { default: Plugin } = load('main.ts', { obsidian, 'node:fs': { existsSync: () => false, readdirSync: () => [] } }, { process: { env: environment } });
    const plugin = new Plugin(); plugin.manifest = { version: '0.7.1' };
    const runtime = plugin.runtime('/vault');
    const dirs = Array.from(runtime.options.env.PATH.split(path.delimiter));
    assert.equal(runtime.options.executable, 'codex');
    assert.ok(!dirs.includes('.') && !dirs.includes(''));
    for (const dir of ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']) assert.ok(dirs.includes(dir));
    if (environment.PATH) assert.ok(dirs.includes('/custom/bin'));
    assert.equal(dirs.length, new Set(dirs).size);
    assert.equal(runtime.options.env.KEEP, environment.KEEP);
  }
});

test('built-in Taiwan sample is bilingual, read-only source data with exploration and synthesis roots', () => {
  const sample = load('builtin-sample.ts');
  for (const language of ['zh-TW', 'en']) {
    assert.deepEqual(Array.from(sample.validateBuiltInSample(language)), []);
    const data = sample.builtInSample(language);
    assert.equal(data.map.nodes.filter(node => node.parentId === null).length, 2);
    assert.ok(Array.from(data.notes.values()).some(note => note.sourcePaths.length === 6));
    assert.equal(data.map.nodes.length, 12); assert.equal(data.assets.size, 5);
  }
  assert.notEqual(sample.builtInSample('zh-TW').map.title, sample.builtInSample('en').map.title);
});
test('official samples teach per-run requirements without active Rules in both languages', () => {
  const sample = load('builtin-sample.ts');
  assert.equal(sample.SAMPLE_CONTENT_VERSION, 3); assert.equal(sample.SAMPLE_TOUR_VERSION, 2);
  for (const locale of ['en', 'zh-TW']) {
    const data = sample.builtInSample(locale, false);
    for (const note of data.notes.values()) {
      assert.equal(note.rules, '');
      assert.match(note.detail, locale === 'en' ? /Requirements for this run[\s\S]*Additional requirements/ : /本次任務要求[\s\S]*本次附加要求/);
    }
    const root = data.notes.get('explore');
    assert.match(root.detail, locale === 'en' ? /Nine days; favor public transport; no more than two priorities per day/ : /九天八夜；以大眾運輸為主；每天最多安排兩個重點/);
  }
});
integrationTest('workspace repair creates only the configured base folders and is idempotent', async () => {
  const { repo, app } = fixture();
  assert.equal(repo.workspaceExists(), false);
  await repo.ensureWorkspace(); await repo.ensureWorkspace();
  assert.ok(app.vault.getAbstractFileByPath('Agent Workspace/Topics') instanceof TFolder);
  assert.ok(app.vault.getAbstractFileByPath('Agent Workspace/Inbox') instanceof TFolder);
});
integrationTest('workspace rediscovery finds valid custom VAM workspaces without accepting unrelated Map files', async () => {
  const { repo, app } = fixture();
  await repo.folder('Research/My Maps/Topics/Trip');
  await app.vault.create('Research/My Maps/Topics/Trip/Map.md', core.serializeMap(map([])));
  await repo.folder('Unrelated/Topics/Folder');
  await app.vault.create('Unrelated/Topics/Folder/Map.md', '# Not a VAM map');
  assert.deepEqual(Array.from(await repo.workspaceCandidates()), ['Research/My Maps']);
  assert.equal(repo.workspaceExists(), false);
});
test('general tasks retain existing Detail while decompose uses lightweight context', () => {
  const { buildPreparedTaskContext, extractJsonObject } = load('main.ts', { obsidian });
  const input = { title: 'Topic', summary: 'Existing summary', detail: 'Existing Detail', rules: '', task: 'Research the topic', ancestors: '', mode: 'task' };
  assert.equal(buildPreparedTaskContext(input, 'gpt-5.6-luna').context.detail, 'Existing Detail');
  assert.equal(buildPreparedTaskContext({ ...input, mode: 'decompose' }, 'gpt-5.6-luna').context.detail, '');
  assert.deepEqual(JSON.parse(extractJsonObject('我會先查核。\n{"summary":"ok","detail":"brace } in string"}\n完成。')), { summary: 'ok', detail: 'brace } in string' });
  assert.throws(() => extractJsonObject('沒有結構化回應'), /JSON object/);
});
test('Codex output schema requires every declared property', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(root, 'response-schema.json'), 'utf8'));
  assert.deepEqual(new Set(schema.required), new Set(Object.keys(schema.properties)));
});
test('undo and redo preserve ordering; new edit invalidates redo', () => {
  const h = new core.History(); h.push('move'); h.push('delete'); assert.equal(h.undo(), 'delete'); assert.equal(h.undo(), 'move'); assert.equal(h.redo(), 'move'); h.push('edit'); assert.equal(h.canRedo, false); assert.equal(h.undo(), 'edit');
});
test('debug log manager timestamps, bounds, formats and clears in-memory entries', () => {
  const logs = new logging.LogManager(2);
  let changes = 0; const unsubscribe = logs.subscribe(() => changes++);
  logs.appendLog('debug', 'discarded'); logs.appendLog('info', 'runtime started'); logs.appendLog('error', 'runtime failed');
  const entries = logs.getLogs();
  assert.equal(entries.length, 2); assert.equal(entries[0].message, 'runtime started'); assert.match(entries[0].timestamp, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(logging.formatDebugLogs(entries), /\[INFO\] runtime started/); assert.match(logging.formatDebugLogs(entries), /\[ERROR\] runtime failed/);
  entries[0].message = 'changed outside'; assert.equal(logs.getLogs()[0].message, 'runtime started');
  logs.clear(); assert.equal(logs.getLogs().length, 0); assert.equal(changes, 4);
  unsubscribe(); logs.appendLog('info', 'ignored by listener'); assert.equal(changes, 4);
});
integrationTest('AI exchange log persists exact request and reply with a bounded history and clear', async () => {
  const { AiExchangeLog, formatAiExchange } = load('ai-exchange-log.ts');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vam-ai-log-'));
  const file = path.join(directory, 'ai-exchanges.json');
  const errors = [];
  const sentinel = path.join(directory, 'unrelated.md'); fs.writeFileSync(sentinel, 'preserve');
  try {
    const exchanges = new AiExchangeLog(file, error => errors.push(error), 2);
    for (let index = 0; index < 3; index++) {
      const id = String(index);
      exchanges.begin({ id, startedAt: new Date().toISOString(), topic: `Topic ${index}`, mode: 'task', model: 'test', effort: 'low' });
      exchanges.sent(id, JSON.stringify({ input: `private prompt ${index}` }));
      exchanges.received(id, `raw response ${index}`);
      exchanges.completed(id);
    }
    await exchanges.flush();
    const restored = new AiExchangeLog(file, error => errors.push(error), 2);
    await restored.load();
    assert.deepEqual(plain(restored.getEntries().map(entry => entry.id)), ['1', '2']);
    assert.match(formatAiExchange(restored.getEntries()[1]), /private prompt 2/);
    assert.match(formatAiExchange(restored.getEntries()[1]), /raw response 2/);
    restored.clear(); await restored.flush();
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), []);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'preserve');
    assert.deepEqual(fs.readdirSync(directory).sort(), ['ai-exchanges.json', 'unrelated.md']);
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(errors, []);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
integrationTest('pending child suggestions persist across reload and disappear after dismissal', async () => {
  const { PendingSuggestions } = load('pending-suggestions.ts');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vam-proposals-'));
  const file = path.join(directory, 'pending-suggestions.json');
  const errors = [];
  try {
    const first = new PendingSuggestions(file, error => errors.push(error));
    first.set('topic.md', [{ title: 'A', task: 'Research A', contribution: 'Scope A', parentTitle: '' }]);
    await first.flush();
    const second = new PendingSuggestions(file, error => errors.push(error));
    await second.load();
    assert.equal(second.get('topic.md')[0].title, 'A');
    second.delete('topic.md'); await second.flush();
    const third = new PendingSuggestions(file, error => errors.push(error)); await third.load();
    assert.equal(third.has('topic.md'), false);
    assert.deepEqual(errors, []);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
integrationTest('proposal persistence reports disk write failure to the caller', async () => {
  const { PendingSuggestions } = load('pending-suggestions.ts');
  const errors = [];
  const store = new PendingSuggestions(path.join(os.tmpdir(), `vam-missing-${Date.now()}`, 'pending.json'), error => errors.push(error));
  store.set('topic.md', [{ title: 'A', task: 'Research A', contribution: '' }]);
  await assert.rejects(store.flush());
  assert.equal(errors.length, 1);
});
test('debug log command opens the custom modal and exposes copy and clear actions', () => {
  const source = fs.readFileSync(path.join(root, 'main.ts'), 'utf8');
  const mapSource = fs.readFileSync(path.join(root, 'experiences/visual-map/view.ts'), 'utf8');
  const modal = fs.readFileSync(path.join(root, 'ui/modals/debug-log-modal.ts'), 'utf8');
  assert.match(source, /addLocalizedCommand\("open-debug-log"/); assert.match(source, /new DebugLogModal\(this\.app, this\.logs, this\.exchanges/);
  assert.match(modal, /navigator\.clipboard\.writeText/); assert.match(modal, /this\.logs\.clear\(\)/);
  assert.match(modal, /ui\.debug_log/);
  assert.match(modal, /this\.logs\.subscribe/);
  assert.match(source, /codexReadyForAi\(\)/);
  assert.match(source, /ui\.codex_app_server_is_ready_0/);
  assert.match(mapSource, /AI 任務失敗/);
});
class TFolder { constructor(path) { this.path = path; this.name = path.split('/').at(-1); this.children = []; this.parent = null; } }
class TFile { constructor(path) { this.path = path; this.name = path.split('/').at(-1); this.basename = this.name.replace(/\.md$/, ''); this.extension = this.name.includes('.') ? this.name.split('.').at(-1) : ''; this.parent = null; this.stat = { mtime: Date.now() }; } }
const obsidian = { setIcon: (parent, name) => { parent.iconName = name; }, Menu: class { addItem(callback) { callback({ setTitle() { return this; }, setWarning() { return this; }, onClick() { return this; } }); return this; } showAtMouseEvent() { return this; } },
  TFile, TFolder, App: class {}, Plugin: class {}, ItemView: class { constructor(leaf) { this.app = leaf.app; } async setState() {} }, PluginSettingTab: class {}, Modal: class {}, Notice: class {}, FileSystemAdapter: class { getBasePath() { return '/vault'; } },
  normalizePath: value => value.replace(/\/+/g, '/').replace(/^\//, ''),
  parseYaml: text => Object.fromEntries(text.trim().split('\n').filter(Boolean).map(line => { const index = line.indexOf(':'); const raw = line.slice(index + 1).trim(); let value; try { value = JSON.parse(raw); } catch { value = raw; } return [line.slice(0, index), value]; })),
  stringifyYaml: obj => Object.entries(obj).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n') + '\n'
};
test('MindSearch model refresh updates choices, preserves selection, and reports failures', async () => {
  class Element {
    constructor(tag, options = {}) { this.tag = tag; this.children = []; this.attributes = {}; this.text = options.text ?? ''; this.value = options.value ?? ''; this.disabled = false; this.checked = false; this.isConnected = true; this.handlers = {}; }
    createDiv(options) { const child = new Element('div', options); this.children.push(child); return child; }
    createEl(tag, options) { const child = new Element(tag, options); this.children.push(child); return child; }
    createSpan(options) { return this.createEl('span', options); }
    setAttr(name, value) { this.attributes[name] = value; }
    setText(value) { this.text = value; }
    addClass() {}
    toggleClass() {}
    addEventListener(name, handler) { this.handlers[name] = handler; }
    replaceChildren() { this.children = []; }
    focus() {}
    querySelector(selector) { return selector === 'button:last-child' ? this.children.filter(child => child.tag === 'button').at(-1) : null; }
    click() { return this.handlers.click?.(); }
  }
  class Modal { constructor() { this.contentEl = new Element('div'); this.titleEl = new Element('h2'); } close() { this.contentEl.isConnected = false; } }
  class Setting {
    constructor(parent) { this.controlEl = parent.createDiv(); }
    addButton(configure) { const button = this.controlEl.createEl('button'); configure({ setButtonText(text) { button.text = text; return this; }, setCta() { return this; }, onClick(handler) { button.handlers.click = handler; return this; } }); return this; }
  }
  const { MindSearchStartModal } = load('ui/modals/mind-search-start-modal.ts', { obsidian: { ...obsidian, Modal, Setting } });
  const open = refreshModels => {
    const modal = new MindSearchStartModal({}, async () => {}, [{ id: 'old-model', label: 'Old model' }], 'old-model', 'low', refreshModels);
    modal.onOpen();
    const all = []; const visit = el => { all.push(el); for (const child of el.children) visit(child); }; visit(modal.contentEl);
    return { modal, all };
  };
  let calls = 0;
  const success = open(async () => { calls++; return [{ id: 'old-model', label: 'Old model' }, { id: 'new-model', label: 'New model' }]; });
  const refresh = success.all.find(el => el.tag === 'button' && el.text === 'Refresh model list');
  const model = success.all.find(el => el.tag === 'select' && el.attributes['aria-label'] === 'Model');
  refresh.click(); await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(calls, 1); assert.equal(model.value, 'old-model');
  assert.deepEqual(model.children.map(option => option.value), ['old-model', 'new-model']);
  const changedSelection = open(async () => ({ models: [{ id: 'new-model', label: 'New model' }], message: 'partial provider error', preserveSelection: true }));
  const changedModel = changedSelection.all.find(el => el.tag === 'select' && el.attributes['aria-label'] === 'Model');
  const initialRequestId = changedSelection.modal.requestId;
  changedSelection.all.find(el => el.tag === 'button' && el.text === 'Refresh model list').click(); await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(changedModel.value, 'old-model'); assert.equal(changedSelection.modal.requestId, initialRequestId);
  assert.deepEqual(changedModel.children.map(option => option.value), ['new-model', 'old-model']);
  assert.ok(changedSelection.all.some(el => el.text === 'partial provider error'));
  const removedSelection = open(async () => [{ id: 'new-model', label: 'New model' }]);
  const removedModel = removedSelection.all.find(el => el.tag === 'select' && el.attributes['aria-label'] === 'Model');
  const removedRequestId = removedSelection.modal.requestId;
  removedSelection.all.find(el => el.tag === 'button' && el.text === 'Refresh model list').click(); await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(removedModel.value, 'new-model'); assert.notEqual(removedSelection.modal.requestId, removedRequestId);
  const failed = open(async () => { throw new Error('provider unavailable'); });
  failed.all.find(el => el.tag === 'button' && el.text === 'Refresh model list').click(); await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(failed.all.some(el => el.text.includes('provider unavailable')));
});
const { Repository, DEFAULT_SETTINGS, normalizeReasoningLevel } = load('repository.ts', { obsidian });
integrationTest('node plus adds a child without opening a duplicate right-click menu', () => {
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const events = new Map(), buttons = [];
  const element = tag => ({ tag, children: [], dataset: {}, style: {},
    createDiv(options) { const child = element('div'); child.cls = options?.cls ?? options; this.children.push(child); return child; },
    createEl(name, options) { const child = element(name); child.text = options?.text; this.children.push(child); if (name === 'button') buttons.push(child); return child; },
    createSpan(options) { const child = element('span'); child.text = options?.text; this.children.push(child); return child; },
    setAttr(name, value) { this[name] = value; }, addClass(name) { this.cls = name; }, setPointerCapture() {},
    addEventListener(name, handler) { events.set(`${tag}:${name}`, handler); if (tag === 'button') this.click = handler; }, removeEventListener() {}
  });
  const topic = node('parent');
  const view = new VisualAgentMapView({ app: {} }, { pendingSuggestions: new Map([['parent.md', [{ title: 'Idea', task: 'Investigate', contribution: '' }]]]), expansionBatches: new Map() });
  view.stageEl = element('stage'); view.map = map([topic]);
  view.notes = new Map([[topic.id, { title: 'Parent', summary: '', status: 'completed' }]]);
  view.render = () => {};
  let added = 0, opened = [], details = [], next = [], renders = 0;
  view.addNode = () => { added++; }; view.enqueue = work => work(); view.openNodePanel = (topic, mode) => opened.push([topic.id, mode]);
  view.openDetails = topic => details.push(topic.id); view.openNextStep = topic => next.push(topic.id); view.render = () => { renders++; };
  view.renderNode(topic);
  const plus = buttons.find(button => button.text === '+');
  assert.equal(plus['aria-label'], 'Add subtopic manually');
  plus.click({ stopPropagation() {} });
  assert.equal(added, 1);
  const badge = buttons.find(button => button.text === 'View 1 expansion suggestions');
  badge.click({ stopPropagation() {} });
  buttons.find(button => button['aria-label'] === 'How would you like to explore next?').click({ stopPropagation() {} });
  buttons.find(button => button['aria-label'] === 'Structure and links').click({ stopPropagation() {} });
  assert.deepEqual(opened, [[topic.id, 'proposals'], [topic.id, 'structure']]); assert.deepEqual(next, [topic.id]);
  assert.equal(view.selected, null);
  events.get('div:click')({ target: { closest: () => null }, metaKey: false, ctrlKey: false });
  assert.equal(view.selected, topic.id); assert.equal(renders, 1); assert.deepEqual(details, [topic.id]);
  view.selected = null; renders = 0; details.length = 0;
  events.get('div:keydown')({ key: 'Enter', target: view.stageEl.children[0] });
  assert.equal(view.selected, topic.id); assert.equal(renders, 1); assert.deepEqual(details, [topic.id]);
  view.selected = null; renders = 0; details.length = 0;
  view.mapChange = async () => {}; view.drawEdges = () => {};
  events.get('div:pointerdown')({ target: { closest: () => null }, button: 0, pointerId: 2, clientX: 10, clientY: 10 });
  events.get('div:pointermove')({ clientX: 14, clientY: 10 });
  events.get('div:pointerup')({ type: 'pointerup' });
  events.get('div:click')({ target: { closest: () => null }, metaKey: false, ctrlKey: false });
  assert.equal(view.selected, null, 'a >3px pointer movement is treated as a drag and its follow-on click is suppressed');
  assert.equal(renders, 0);
  events.get('div:pointerdown')({ target: { closest: () => null }, button: 0, pointerId: 1, clientX: 0, clientY: 0 });
  events.get('div:pointerup')({ type: 'pointerup', clientX: 0, clientY: 0 });
  assert.deepEqual(details, [topic.id]);
  assert.equal(opened.filter(([, mode]) => mode === 'edit').length, 0);
  view.suppressClickUntil = 0; events.get('div:click')({ target: { closest: () => null }, metaKey: false, ctrlKey: false });
  assert.deepEqual(details, [topic.id, topic.id]);
  events.get('div:keydown')({ key: 'Enter', target: view.stageEl.children[0] });
  assert.deepEqual(details, [topic.id, topic.id, topic.id]);
  assert.equal(events.has('div:contextmenu'), false);
});
integrationTest('MindSearch cards hide generic map actions while ordinary map cards retain them', () => {
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const makeElement = (tag, buttons) => ({ tag, children: [], dataset: {}, style: {},
    createDiv(options) { const child = makeElement('div', buttons); child.cls = options?.cls ?? options; this.children.push(child); return child; },
    createEl(name, options) { const child = makeElement(name, buttons); child.text = options?.text; this.children.push(child); if (name === 'button') buttons.push(child); return child; },
    createSpan(options) { const child = makeElement('span', buttons); child.text = options?.text; this.children.push(child); return child; },
    setAttr(name, value) { this[name] = value; }, addClass(name) { this.cls = name; }, setPointerCapture() {},
    addEventListener() {}, removeEventListener() {}
  });
  const topic = node('topic');
  const render = doc => {
    const buttons = [], view = new VisualAgentMapView({ app: {} }, { pendingSuggestions: new Map([['topic.md', [{ title: 'Idea', task: 'Research', contribution: '' }]]]), expansionBatches: new Map() });
    view.stageEl = makeElement('stage', buttons); view.map = doc; view.notes = new Map([[topic.id, { title: 'Topic', summary: '', status: 'completed' }]]);
    view.renderNode(topic); return buttons;
  };
  const ordinaryButtons = render(map([topic]));
  assert.ok(ordinaryButtons.some(button => button['aria-label'] === 'How would you like to explore next?'));
  assert.ok(ordinaryButtons.some(button => button['aria-label'] === 'Structure and links'));
  assert.ok(ordinaryButtons.some(button => button['aria-label'] === 'New topic name'));
  assert.ok(ordinaryButtons.some(button => button['aria-label'] === 'Add subtopic manually'));
  const mindSearch = map([topic]); mindSearch.mindSearch = { version: 1, branches: [], runs: [], pendingCommits: [] };
  const mindSearchButtons = render(mindSearch);
  for (const label of ['How would you like to explore next?', 'Structure and links', 'New topic name', 'Add subtopic manually']) {
    assert.equal(mindSearchButtons.some(button => button['aria-label'] === label), false, `${label} is hidden in MindSearch`);
  }
  const resultNode = node('saved-synthesis', topic.id); resultNode.mindSearchKind = 'synthesis';
  const resultMap = map([topic, resultNode]);
  resultMap.mindSearch = { version: 1, branches: [{ id: 'saved-branch', questionNodeId: topic.id, parentBranchId: null, answerSnapshot: { selections: [], freeText: '' }, inputSnapshot: { topic: 'Fixture', conditions: {}, upstreamResults: [] }, createdAt: '2026-10-09T00:00:00.000Z', results: [{ nodeId: resultNode.id, notePath: resultNode.path, version: 1, kind: 'synthesis' }] }], runs: [], pendingCommits: [] };
  const resultButtons = [], resultView = new VisualAgentMapView({ app: {} }, { pendingSuggestions: new Map(), expansionBatches: new Map() });
  resultView.stageEl = makeElement('stage', resultButtons); resultView.map = resultMap; resultView.notes = new Map([[resultNode.id, { title: 'Saved synthesis', summary: 'A saved result.', status: 'completed' }]]);
  resultView.renderNode(resultNode);
  const newQuestion = resultButtons.find(button => button['aria-label'] === 'Generate another question from this research, keeping existing branches');
  assert.ok(newQuestion, 'a saved synthesis exposes the new-question action'); assert.equal(newQuestion.disabled, false);
  resultView.mindSearchBusy = true;
  const busyButtons = [], busyView = new VisualAgentMapView({ app: {} }, { pendingSuggestions: new Map(), expansionBatches: new Map() });
  busyView.stageEl = makeElement('stage', busyButtons); busyView.map = resultMap; busyView.notes = resultView.notes; busyView.mindSearchBusy = true;
  busyView.renderNode(resultNode);
  assert.equal(busyButtons.find(button => button['aria-label'] === 'Generate another question from this research, keeping existing branches').disabled, true, 'the action is disabled while another MindSearch operation is active');
  const ordinaryResult = node('ordinary-synthesis'); ordinaryResult.mindSearchKind = 'synthesis';
  const ordinaryButtonsForResult = [], ordinaryResultView = new VisualAgentMapView({ app: {} }, { pendingSuggestions: new Map(), expansionBatches: new Map() });
  ordinaryResultView.stageEl = makeElement('stage', ordinaryButtonsForResult); ordinaryResultView.map = map([ordinaryResult]); ordinaryResultView.notes = new Map([[ordinaryResult.id, { title: 'Ordinary note', summary: '', status: 'completed' }]]);
  ordinaryResultView.renderNode(ordinaryResult);
  assert.equal(ordinaryButtonsForResult.some(button => button['aria-label'] === 'Generate another question from this research, keeping existing branches'), false, 'ordinary maps do not expose the MindSearch action');
  assert.match(fs.readFileSync(path.join(root, 'experiences/visual-map/view.ts'), 'utf8'), /if \(!mindSearchMode\) this\.button\(tools, t\("ui\.organize"\)/);
  assert.match(fs.readFileSync(path.join(root, 'experiences/visual-map/view.ts'), 'utf8'), /if \(!mindSearchMode\) \{\s*const integrate = this\.button\(tools/);
});
integrationTest('MindSearch question cards show branch progress instead of note lifecycle status', () => {
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const element = tag => ({ tag, children: [], dataset: {}, style: {},
    createDiv(options) { const child = element('div'); child.cls = options?.cls ?? options; this.children.push(child); return child; },
    createEl(name, options) { const child = element(name); child.text = options?.text; this.children.push(child); return child; },
    createSpan(options) { const child = element('span'); child.text = options?.text; this.children.push(child); return child; },
    setAttr(name, value) { this[name] = value; }, addClass(name) { this.cls = name; },
    addEventListener() {}, removeEventListener() {}, setPointerCapture() {}
  });
  const question = node('question'); question.mindSearchKind = 'question';
  const branch = { id: 'branch', questionNodeId: question.id, parentBranchId: null, answerSnapshot: { selections: [], freeText: '已回答' }, inputSnapshot: { topic: '測試', conditions: {}, upstreamResults: [] }, createdAt: '2026-10-09T00:00:00.000Z', results: [{ kind: 'conclusion', runId: 'run', attemptId: 'attempt' }] };
  const doc = map([question]); doc.mindSearch = { version: 1, branches: [branch], runs: [{ id: 'run', branchId: branch.id, currentAttemptId: 'attempt', attempts: [{ id: 'attempt', inputSnapshotHash: 'hash', status: 'completed' }] }], pendingCommits: [] };
  const plugin = { repo: {}, settings: { ...DEFAULT_SETTINGS }, expansionBatches: new Map(), running: new Map(), quickExpandPending: new Set(), pendingSuggestions: new Map() };
  const view = new VisualAgentMapView({ app: {} }, plugin); view.stageEl = element('stage'); view.map = doc; view.notes = new Map([[question.id, { title: 'Question', summary: 'Question', status: 'idea' }]]);
  view.renderNode(question);
  assert.equal(view.stageEl.children[0].children[0].children[0].text, 'Research complete');
  doc.mindSearch.runs[0].attempts[0].status = 'running'; view.stageEl = element('stage'); view.renderNode(question);
  assert.equal(view.stageEl.children[0].children[0].children[0].text, 'Researching');
});
integrationTest('MindSearch outline keeps only note titles and hierarchy', () => {
  const { OutlineView } = load('ui/outline-view.ts', { obsidian });
  const element = (tag, options = {}) => ({ tag, text: options.text, cls: options.cls ?? '', children: [], style: {},
    get childElementCount() { return this.children.length; },
    createDiv(value) { const child = element('div', { cls: typeof value === 'string' ? value : value?.cls }); this.children.push(child); return child; },
    createEl(name, value = {}) { const child = element(name, value); this.children.push(child); return child; },
    createSpan(value = {}) { const child = element('span', typeof value === 'string' ? { cls: value } : value); this.children.push(child); return child; },
    addClass(value) { this.cls = value; }, setAttr(name, value) { this[name] = value; }, addEventListener() {}, remove() { this.removed = true; },
    empty() { this.children = []; }, querySelector(selector) { const cls = selector.slice(1); const visit = item => item.cls.split(' ').includes(cls) ? item : item.children.map(visit).find(Boolean); return visit(this); }
  });
  const root = node('root'), child = node('child', root.id); root.mindSearchKind = 'topic'; child.mindSearchKind = 'research';
  const doc = map([root, child]); doc.mindSearch = { version: 1, branches: [{ id: 'branch', questionNodeId: root.id, parentBranchId: null, answerSnapshot: { selections: [], freeText: '私有答案資料' }, inputSnapshot: { topic: 'map', conditions: {}, upstreamResults: [] }, createdAt: '2026-10-09T00:00:00.000Z', results: [{ resultId: 'result', runId: 'run', attemptId: 'attempt', nodeId: child.id, notePath: child.path, version: 1 }] }], runs: [], pendingCommits: [] };
  const view = new OutlineView({ app: {} }, async () => {}); view.contentEl = element('content');
  view.setMap(doc, new Map([[root.id, 'MindSearch topic'], [child.id, 'Research subtopic']]));
  const tree = view.contentEl.querySelector('.vam-outline-tree');
  const flatten = item => [item, ...item.children.flatMap(flatten)]; const rendered = flatten(tree);
  assert.ok(rendered.some(item => item.text === 'MindSearch topic'));
  assert.ok(rendered.some(item => item.text === 'Research subtopic'));
  assert.ok(!rendered.some(item => item.cls.includes('vam-outline-kind') || item.cls.includes('vam-outline-branch-meta')));
  assert.ok(!rendered.some(item => item.text === '私有答案資料'));
  assert.deepEqual(rendered.filter(item => item.cls === 'vam-outline-row').map(item => item.style.paddingLeft), ['8px', '24px']);
});
integrationTest('Next Step reviews first expansion proposals in place and keeps existing proposal review', async () => {
  let closed = 0, expandCalls = 0, synthCalls = 0, created, saved, quickOptions, expandOptions, researchOptions, synthOptions; const notices = [];
  const element = (tag, options = {}) => ({
    tag, type: options.type, text: options.text, get textContent() { return this.text; }, value: options.value ?? options.text ?? '', cls: options.cls ?? '', children: [], get options() { return this.children.filter(child => child.tag === 'option' || child.value !== undefined); }, style: {}, dataset: {}, disabled: false,
    classList: { toggle(name, enabled) { this[name] = enabled; } },
    createDiv(value) { const child = element('div', { cls: typeof value === 'string' ? value : value?.cls }); this.children.push(child); return child; },
    createEl(name, value) { const child = element(name, value); this.children.push(child); return child; },
    createSpan(value) { const child = element('span', value); this.children.push(child); return child; },
    addClass(name) { this.cls = name; }, setText(value) { this.text = value; }, setAttr(name, value) { this[name] = value; }, add(option) { this.children.push(option); }, replaceChildren(...children) { this.children = children; },
    addEventListener(name, handler) { if (name === 'click') this.click = handler; if (name === 'change') this.change = handler; if (name === 'input') this.input = handler; },
    querySelector(selector) { const name = selector.slice(1); return find(this, item => item.cls.split(' ').includes(name)); },
    querySelectorAll(selector) { return all(this, item => selector === 'button[data-topic-run]' && item.tag === 'button' && item.dataset.topicRun !== undefined); },
    empty() { this.children = []; }, remove() { this.removed = true; }
  });
  const find = (root, predicate) => predicate(root) ? root : root.children.map(child => find(child, predicate)).find(Boolean);
  const all = (root, predicate) => [...(predicate(root) ? [root] : []), ...root.children.flatMap(child => all(child, predicate))];
  const button = (root, label) => find(root, item => item.tag === 'button' && item.text === label);
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  class Modal { constructor() { this.modalEl = element('modal'); this.titleEl = element('title'); this.contentEl = element('content'); } close() { closed++; this.onClose?.(); } }
  const { NextStepModal } = load('main.ts', { obsidian: { ...obsidian, Modal, setIcon: () => {}, Notice: class { constructor(message) { notices.push(message); } } } });
  const checkedModels = [];
  const modelState = provider => ({ provider, status: 'ready', models: provider === 'codex' ? ['gpt-test'] : [] });
  const plugin = { settings: { codexUsageNoticeSeen: true, claudeUsageNoticeSeen: true, models: 'gpt-test', cliReasoning: 'low', language: 'en' }, aiReadyForModel: async model => { checkedModels.push(model); return true; }, confirmAiUsage: async (model, run) => { checkedModels.push(model); await run(); return true; }, saveSettings: async () => {}, activeTasks: new Map(), availableModels: () => ['gpt-test'], modelLabel: model => model, modelDiscoveryState: modelState, subscribeModelDiscovery: () => () => {}, refreshModelDiscovery: async provider => modelState(provider), sources: { currentTopicId: 'current', currentLabel: 'Current topic included', synthesisLabel: 'Current topic and child topics included', synthesisTopics: ['Child A', 'Child B'], topics: async () => [], readTopic: async () => [] } };
  const modelSettings = { model: 'gpt-test', modelSource: 'workspace', reasoning: 'low', save: async () => {}, sources: plugin.sources };
  const modal = new NextStepModal({}, 'Parent', 'normal', 1, 1, plugin,
    async (options, _focus, _done, _failed, accepted) => { researchOptions = options; accepted(); },
    async (options, _direction, found, _failed, _createdMap, accepted) => { expandOptions = options; expandCalls++; if (options.multiLayer) { quickOptions = options; accepted(); } else found([{ title: 'Transport', task: 'Compare', contribution: '', parentTitle: '' }], async items => { created = items; }); },
    async (options, angles, drafted) => { synthCalls++; synthOptions = options; angles([{ title: 'Shared constraints', task: 'Find tradeoffs', contribution: 'Across children' }], async () => { drafted({ summary: 'Draft', detail: 'Detail' }, async (summary, detail) => { saved = [summary, detail]; }); }); }, modelSettings);
  modal.onOpen();
  assert.ok(find(modal.contentEl, item => /3 minutes.*avoid prolonged resource use/.test(item.text ?? '')));
  assert.ok(modal.modalEl.cls.includes('vam-next-modal'));
  const requirementsDisclosure = find(modal.contentEl, item => item.cls.includes('vam-next-requirements'));
  assert.equal(requirementsDisclosure.open, false);
  const cards = find(modal.contentEl, item => item.cls === 'vam-next-cards');
  assert.deepEqual(cards.children.map(item => item['aria-pressed']), ['true', 'false', 'false']);
  const [research, expand, synthesize] = all(modal.contentEl, item => item.cls.includes('vam-next-research'));
  const panelHeader = find(modal.contentEl, item => item.cls.includes('vam-next-panel-header'));
  const panelTitle = find(panelHeader, item => item.tag === 'h3');
  const researchAction = button(panelHeader, 'Confirm research task');
  assert.equal(modal.contentEl.children.indexOf(cards), modal.contentEl.children.indexOf(panelHeader) + 1);
  assert.equal(panelTitle.text, 'Research this topic');
  assert.equal(researchAction.dataset.topicRun, 'Confirm research task');
  assert.equal(researchAction.disabled, false);
  assert.equal(button(research, 'Confirm research task'), undefined);
  assert.equal(find(modal.contentEl, item => /Summary = card conclusion/.test(item.text ?? '')), undefined);
  assert.equal(find(modal.contentEl, item => /Run with .*sources:.*result:/.test(item.text ?? '')), undefined);
  assert.equal(find(modal.contentEl, item => /Full results go to Markdown/.test(item.text ?? '')), undefined);
  assert.ok(find(research, item => item.cls.includes('vam-next-status')));
  const depthSet = find(research, item => item.tag === 'fieldset');
  assert.equal(depthSet.children[0].tag, 'legend');
  assert.equal(find(research, item => item.cls.includes('vam-next-depth-help')).open, false);
  const sourceDisclosures = all(modal.contentEl, item => item.cls.includes('vam-next-source-details'));
  assert.equal(sourceDisclosures.length, 3);
  assert.ok(sourceDisclosures.every(item => item.open === false));
  assert.ok(sourceDisclosures.every(item => item.children[0].children[0].children[1].text.includes('0 Markdown files')));
  const outputLanguage = find(modal.contentEl, item => item['aria-label'] === 'Answer language for this task');
  assert.equal(outputLanguage.value, 'en');
  outputLanguage.value = 'zh-TW';
  assert.equal(plugin.settings.language, 'en'); assert.equal(panelTitle.text, 'Research this topic');
  const requirements = find(modal.contentEl, item => item.tag === 'textarea');
  assert.equal(requirements.value, '');
  assert.equal(all(modal.contentEl, item => item.tag === 'textarea').length, 1);
  assert.equal(button(modal.contentEl, 'Save instructions'), undefined);
  requirements.value = 'Only this run';
  const researchChecks = all(research, item => item.tag === 'input' && item.type === 'checkbox');
  assert.equal(researchChecks.length, 2); assert.ok(researchChecks[0].checked); assert.ok(researchChecks[1].checked);
  assert.ok(find(research, item => item.text === 'Search for image references'));
  assert.ok(find(research, item => /Standard: provide the main evidence, limits, and open questions/.test(item.text ?? '')), JSON.stringify(all(research, item => item.text).map(item => item.text)));
  const expandChecks = all(expand, item => item.tag === 'input' && item.type === 'checkbox');
  assert.equal(expandChecks.length, 3); assert.ok(expandChecks[0].checked); assert.ok(expandChecks[1].checked);
  assert.ok(find(expand, item => item.text === 'Search for image references'));
  assert.equal(all(research, item => item.tag === 'input' && item.type === 'file').length, 2);
  assert.equal(all(expand, item => item.tag === 'input' && item.type === 'file').length, 2);
  assert.equal(all(synthesize, item => item.tag === 'input' && item.type === 'file').length, 2);
  assert.ok(find(research, item => item.text === 'Allow web search'));
  assert.ok(find(expand, item => item.text === 'Allow web search'));
  assert.ok(find(synthesize, item => item.text === 'Allow web search'));
  assert.equal(find(synthesize, item => item.text === 'Does not copy full subtopic notes'), undefined);
  cards.children[1].click();
  assert.equal(panelTitle.text, 'Expand this topic'); assert.equal(researchAction.hidden, true);
  assert.equal(research.style.display, 'none'); assert.equal(expand.style.display, '');
  expandChecks[0].checked = false; expandChecks[0].change();
  assert.equal(expandChecks[1].disabled, true); assert.equal(expandChecks[1].checked, false);
  button(expand, 'Review AI subtopic suggestions').click(); await tick();
  assert.equal(expandCalls, 1); assert.equal(closed, 0);
  const proposalCheck = find(expand.querySelector('.vam-next-result'), item => item.tag === 'input' && item.type === 'checkbox');
  proposalCheck.checked = false; button(expand, 'Create subtopics').click(); await tick();
  assert.equal(created, undefined); assert.equal(expand.querySelector('.vam-next-status').text, 'Select at least one subtopic.');
  proposalCheck.checked = true;
  button(expand, 'Create subtopics').click(); await tick();
  assert.equal(created[0].title, 'Transport'); assert.equal(expandOptions.outputLanguage, 'zh-TW'); assert.equal(closed, 0);
  let firstCreated, firstAttempts = 0;
  const firstFlow = new NextStepModal({}, 'Parent', 'normal', 0, 0, plugin, async () => {}, async (_options, _direction, found, failed) => {
    firstAttempts++;
    if (firstAttempts === 1) { failed('No useful proposals'); return; }
    found([{ title: 'First idea', task: 'Explore it', contribution: '', parentTitle: '' }], async items => { firstCreated = items; });
  }, async () => {});
  firstFlow.onOpen(); find(firstFlow.contentEl, item => item.cls === 'vam-next-cards').children[1].click();
  const firstPanel = all(firstFlow.contentEl, item => item.cls.includes('vam-next-research'))[1];
  const firstRequirements = find(firstFlow.contentEl, item => item.tag === 'textarea'); firstRequirements.value = 'Keep this while retrying';
  button(firstPanel, 'Get expansion directions').click(); await tick();
  assert.equal(firstPanel.querySelector('.vam-next-status').text, 'No useful proposals');
  assert.equal(firstRequirements.value, 'Keep this while retrying'); assert.equal(closed, 0);
  button(firstPanel, 'Get expansion directions').click(); await tick();
  assert.ok(find(firstPanel.querySelector('.vam-next-result'), item => item.text === 'AI subtopic proposals'));
  const firstCheckbox = find(firstPanel.querySelector('.vam-next-result'), item => item.tag === 'input' && item.type === 'checkbox');
  firstCheckbox.checked = false;
  button(firstPanel, 'Create subtopics').click(); await tick();
  assert.equal(firstCreated, undefined); assert.equal(firstPanel.querySelector('.vam-next-status').text, 'Select at least one subtopic.');
  firstCheckbox.checked = true;
  const firstName = find(firstPanel.querySelector('.vam-next-result'), item => item.tag === 'input' && item.type === 'text'); firstName.value = 'Edited idea';
  button(firstPanel, 'Create subtopics').click(); await tick();
  assert.equal(firstCreated[0].title, 'Edited idea'); assert.equal(closed, 0);
  const contentChoice = find(synthesize, item => item.tag === 'select' && item['aria-label'] === 'Topic synthesis content');
  assert.equal(contentChoice.value, 'full');
  assert.ok(find(synthesize, item => item.tag === 'li' && item.text === 'Child A'));
  assert.ok(find(synthesize, item => item.tag === 'li' && item.text === 'Child B'));
  contentChoice.value = 'summary'; contentChoice.change();
  assert.ok(find(synthesize, item => /Important conditions in the body may be omitted/.test(item.text ?? '')));
  cards.children[2].click(); assert.equal(panelTitle.text, 'Synthesize subtopic findings'); assert.equal(researchAction.hidden, true);
  button(synthesize, 'Get synthesis suggestions first').click(); await tick();
  assert.equal(contentChoice.disabled, true);
  assert.equal(synthOptions.synthesisContent, 'summary');
  assert.equal(synthCalls, 1); assert.equal(closed, 0);
  assert.equal(synthOptions.researchMode, 'local');
  assert.equal(synthOptions.outputLanguage, 'zh-TW');
  assert.ok(button(synthesize, 'Choose this direction'));
  button(synthesize, 'Get synthesis draft').click(); await tick();
  assert.equal(synthOptions.synthesisContent, 'summary');
  button(synthesize, 'Confirm update to parent topic').click(); await tick();
  assert.deepEqual(saved, ['Draft', 'Detail']); assert.equal(closed, 0);
  cards.children[0].click(); assert.equal(panelTitle.text, 'Research this topic'); assert.equal(researchAction.hidden, false);
  button(modal.contentEl, 'Confirm research task').click(); await tick();
  assert.equal(researchOptions.requirements, 'Only this run'); assert.equal(researchOptions.researchMode, 'research'); assert.equal(researchOptions.referenceGroups.length, 0);
  assert.equal(researchOptions.outputLanguage, 'zh-TW');
  assert.equal(closed, 1); assert.equal(research.querySelector('.vam-next-result'), undefined);
  const quickModal = new NextStepModal({}, 'Parent', 'normal', 1, 0, plugin, async () => {}, modal.expand, async () => {});
  quickModal.onOpen(); find(quickModal.contentEl, item => item.cls === 'vam-next-cards').children[1].click(); button(quickModal.contentEl, 'Quickly explore a map').click();
  find(quickModal.contentEl, item => item['aria-label'] === 'Answer language for this task').value = 'zh-TW';
  assert.equal(button(quickModal.contentEl, 'Review AI subtopic suggestions'), undefined);
  const quickNumbers = all(quickModal.contentEl, item => item.tag === 'input' && item.type === 'number');
  const [levelInput, , childrenInput] = quickNumbers;
  assert.equal(childrenInput.disabled, false);
  levelInput.value = '1'; levelInput.input();
  assert.equal(childrenInput.disabled, true);
  assert.equal(find(quickModal.contentEl, item => item.text === 'Not used when expanding only one level.').hidden, false);
  levelInput.value = '2'; levelInput.input();
  assert.equal(childrenInput.disabled, false);
  button(quickModal.contentEl, 'Create starter map now').click(); await tick();
  assert.equal(quickOptions.multiLayer, true); assert.equal(quickOptions.shallowResearch, false); assert.equal(quickOptions.layers, 2); assert.equal(quickOptions.firstLayerCount, 3); assert.equal(quickOptions.childrenPerParent, 2); assert.equal(closed, 2);
  assert.equal(quickOptions.researchMode, 'local'); assert.equal(quickOptions.referenceGroups.length, 0); assert.equal(quickOptions.outputLanguage, 'zh-TW');
  const partial = new NextStepModal({}, 'Parent', 'normal', 1, 0, plugin, async () => {}, async (_options, _direction, _found, failed) => failed('部分子議題已建立，請重新開啟視窗。', false), async () => {});
  partial.onOpen(); find(partial.contentEl, item => item.cls === 'vam-next-cards').children[1].click(); button(partial.contentEl, 'Quickly explore a map').click();
  const closedBeforePartial = closed;
  button(partial.contentEl, 'Create starter map now').click(); await tick();
  assert.equal(closed, closedBeforePartial); assert.equal(button(partial.contentEl, 'Create starter map now').disabled, true); assert.match(all(partial.contentEl, item => item.cls.includes('vam-next-research'))[1].querySelector('.vam-next-status').text, /部分子議題已建立/);
  let continueBackground; let acceptedSignal;
  const background = new Promise(resolve => { continueBackground = resolve; });
  const acceptedModal = new NextStepModal({}, 'Parent', 'normal', 1, 0, plugin, async () => {}, async (options, _direction, _found, _failed, _created, accepted) => { acceptedSignal = options.signal; accepted(); await background; }, async () => {});
  acceptedModal.onOpen(); find(acceptedModal.contentEl, item => item.cls === 'vam-next-cards').children[1].click(); button(acceptedModal.contentEl, 'Quickly explore a map').click(); button(acceptedModal.contentEl, 'Create starter map now').click();
  await until(() => acceptedModal.closed);
  assert.equal(acceptedSignal.aborted, false); assert.equal(acceptedModal.taskSignal, undefined);
  continueBackground(); await tick();
  let emptyOptions;
  const empty = new NextStepModal({}, 'No children', 'normal', 0, 0, plugin, async () => {}, async () => {}, async options => { synthCalls++; emptyOptions = options; });
  empty.onOpen(); find(empty.contentEl, item => item.cls === 'vam-next-cards').children[2].click();
  const emptyPanel = all(empty.contentEl, item => item.cls.includes('vam-next-research'))[2];
  assert.match(emptyPanel.children[0].text, /no direct subtopics/i);
  button(emptyPanel, 'Get synthesis suggestions first').click(); await tick();
  assert.equal(synthCalls, 1); assert.equal(emptyOptions, undefined);
  const failing = new NextStepModal({}, 'Parent', 'normal', 1, 1, plugin, async () => {}, async (_options, _direction, _found, failed) => failed('Provider failed'), async () => {});
  failing.onOpen(); find(failing.contentEl, item => item.cls === 'vam-next-cards').children[1].click();
  button(failing.contentEl, 'Review AI subtopic suggestions').click(); await tick();
  assert.equal(all(failing.contentEl, item => item.cls.includes('vam-next-research'))[1].querySelector('.vam-next-status').text, 'Provider failed'); assert.equal(closed, 3);
  const failedResearch = new NextStepModal({}, 'Parent', 'normal', 1, 0, plugin, async (_options, _focus, _done, failed) => failed('Cannot start'), async () => {}, async () => {});
  failedResearch.onOpen(); button(failedResearch.contentEl, 'Confirm research task').click(); await tick();
  assert.equal(closed, 3); assert.equal(all(failedResearch.contentEl, item => item.cls.includes('vam-next-research'))[0].querySelector('.vam-next-status').text, 'Cannot start');
  const unacceptedResearch = new NextStepModal({}, 'Parent', 'normal', 1, 0, plugin, async () => {}, async () => {}, async () => {});
  unacceptedResearch.onOpen(); button(unacceptedResearch.contentEl, 'Confirm research task').click(); await tick();
  const unacceptedPanel = all(unacceptedResearch.contentEl, item => item.cls.includes('vam-next-research'))[0];
  assert.equal(closed, 3); assert.equal(button(unacceptedResearch.contentEl, 'Confirm research task').disabled, false);
  assert.match(unacceptedPanel.querySelector('.vam-next-status').text, /cancelled/i);
  let acknowledged = 0, began = 0;
  let firstUseConfirmed = false;
  const firstUsePlugin = { settings: { codexUsageNoticeSeen: false }, aiReadyForModel: async () => true, confirmAiUsage: async (_model, run) => { if (!firstUseConfirmed) { firstUseConfirmed = true; return false; } acknowledged++; await run(); return true; }, saveSettings: async () => { acknowledged++; } };
  const firstUse = new NextStepModal({}, 'Parent', 'normal', 1, 0, firstUsePlugin, async (_options, _focus, _done, _failed, accepted) => { began++; accepted(); }, async () => {}, async () => {});
  firstUse.onOpen(); button(firstUse.contentEl, 'Confirm research task').click(); await tick();
  assert.equal(began, 0); assert.equal(button(firstUse.contentEl, 'Understand and run'), undefined); assert.equal(closed, 3);
  button(firstUse.contentEl, 'Confirm research task').click(); await tick();
  assert.equal(began, 1); assert.equal(acknowledged, 1); assert.equal(closed, 4);
  let pendingCalls = 0;
  let pendingConfirmed = false;
  const pendingPlugin = { settings: { codexUsageNoticeSeen: false }, aiReadyForModel: async () => true, confirmAiUsage: async (_model, run) => { if (!pendingConfirmed) { pendingConfirmed = true; return false; } await run(); return true; }, saveSettings: async () => {} };
  const pendingModal = new NextStepModal({}, 'Parent', 'normal', 1, 1, pendingPlugin, async () => {}, async (_options, _direction, found) => { pendingCalls++; found([{ title: 'Existing', task: 'Research', contribution: '', parentTitle: '' }], async () => {}); }, async () => {});
  pendingModal.onOpen(); find(pendingModal.contentEl, item => item.cls === 'vam-next-cards').children[1].click();
  button(pendingModal.contentEl, 'Review AI subtopic suggestions').click(); await tick();
  assert.equal(pendingCalls, 1); assert.equal(button(pendingModal.contentEl, 'Understand and run'), undefined);
  button(pendingModal.contentEl, 'Create subtopics').click(); await tick();
  assert.ok(button(pendingModal.contentEl, 'Get expansion directions'));
  button(pendingModal.contentEl, 'Get expansion directions').click(); await tick();
  assert.equal(pendingCalls, 1); assert.equal(button(pendingModal.contentEl, 'Understand and run'), undefined);
  let finishQuick, completedQuick = false, delayedOptions;
  const delayed = new NextStepModal({}, 'Parent', 'normal', 1, 0, plugin, async () => {}, async (options, _direction, _failed, _failure, accepted) => {
    delayedOptions = options;
    accepted();
    await new Promise(resolve => { finishQuick = resolve; });
    completedQuick = true;
  }, async () => {});
  delayed.onOpen(); find(delayed.contentEl, item => item.cls === 'vam-next-cards').children[1].click(); button(delayed.contentEl, 'Quickly explore a map').click();
  const numbers = all(delayed.contentEl, item => item.tag === 'input' && item.type === 'number');
  numbers[0].value = '3'; numbers[1].value = '2'; numbers[2].value = '2'; numbers[0].input();
  const shallow = find(all(delayed.contentEl, item => item.cls.includes('vam-next-research'))[1], item => item.tag === 'input' && item.type === 'checkbox' && item.checked === false);
  shallow.checked = true;
  button(delayed.contentEl, 'Create starter map now').click(); await tick();
  assert.equal(closed, 5); assert.equal(completedQuick, false);
  assert.equal(delayedOptions.layers, 3); assert.equal(delayedOptions.firstLayerCount, 2); assert.equal(delayedOptions.childrenPerParent, 2); assert.equal(delayedOptions.shallowResearch, true);
  finishQuick(); await tick(); assert.equal(completedQuick, true); assert.equal(closed, 5);
  const invalid = new NextStepModal({}, 'Parent', 'normal', 1, 0, plugin, async () => {}, async () => assert.fail('over-limit task started'), async () => {});
  invalid.onOpen(); find(invalid.contentEl, item => item.cls === 'vam-next-cards').children[1].click(); button(invalid.contentEl, 'Quickly explore a map').click();
  const invalidNumbers = all(invalid.contentEl, item => item.tag === 'input' && item.type === 'number'); invalidNumbers[0].value = '3'; invalidNumbers[1].value = '3'; invalidNumbers[2].value = '2'; invalidNumbers[0].input();
  assert.match(find(invalid.contentEl, item => item.tag === 'p' && item.text?.includes('exceeding the limit of 15')).text, /21 subtopics/);
  assert.equal(button(invalid.contentEl, 'Create starter map now').disabled, true);
  invalidNumbers[0].value = '2'; invalidNumbers[0].input();
  assert.equal(button(invalid.contentEl, 'Create starter map now').disabled, false);
  assert.ok(all(invalid.contentEl, item => item.tag === 'p').some(item => /3/.test(item.text ?? '') && /6/.test(item.text ?? '') && /9/.test(item.text ?? '')));
  assert.equal(closed, 5);
  let finishGuided, guidedFinished = false;
  const guidedModal = new NextStepModal({}, 'Parent', 'normal', 1, 0, plugin, async () => {}, async (_options, _direction, found) => {
    await new Promise(resolve => { finishGuided = resolve; });
    found([{ title: 'Later', task: 'Explore', contribution: '' }], async () => {});
    guidedFinished = true;
  }, async () => {});
  guidedModal.onOpen(); find(guidedModal.contentEl, item => item.cls === 'vam-next-cards').children[1].click();
  button(guidedModal.contentEl, 'Get expansion directions').click(); await tick();
  assert.equal(closed, 5); assert.equal(guidedFinished, false);
  finishGuided(); await tick();
  assert.equal(guidedFinished, true); assert.ok(button(guidedModal.contentEl, 'Create subtopics'));
  button(guidedModal.contentEl, 'Create subtopics').click(); await tick();
  assert.equal(closed, 5);
  const settingsWrites = []; let researchAfterSave = false;
  const settingsModal = new NextStepModal({}, 'Parent', 'normal', 0, 0,
    { settings: { codexUsageNoticeSeen: true, models: 'model-a,model-b' }, availableModels: () => ['model-a', 'model-b'], modelLabel: model => model, modelDiscoveryState: provider => ({ provider, status: 'ready', models: ['model-a', 'model-b'] }), subscribeModelDiscovery: () => () => {}, refreshModelDiscovery: async provider => ({ provider, status: 'ready', models: ['model-a', 'model-b'] }), aiReadyForModel: async model => { checkedModels.push(model); return true; }, confirmAiUsage: async (model, run) => { checkedModels.push(model); await run(); return true; }, saveSettings: async () => {} },
    async (_options, _focus, _done, _failed, accepted) => { researchAfterSave = settingsWrites.length === 2; accepted(); }, async () => {}, async () => {},
    { model: 'model-a', modelSource: 'workspace', reasoning: 'low', save: async patch => { settingsWrites.push(patch); } });
  settingsModal.onOpen();
  assert.equal(settingsModal.contentEl.children.find(item => item.cls.includes('vam-next-model')).children[0].text, 'Model and advanced settings');
  const modelSelect = find(settingsModal.contentEl, item => item['aria-label'] === 'Model');
  const reasoningSelect = find(settingsModal.contentEl, item => item['aria-label'] === 'Reasoning level');
  modelSelect.value = 'model-b'; modelSelect.change(); reasoningSelect.value = 'high'; reasoningSelect.change();
  assert.equal(researchAfterSave, false);
  button(settingsModal.contentEl, 'Confirm research task').click(); await tick();
  assert.deepEqual(plain(settingsWrites), [{ model: 'model-b', modelSource: 'manual' }, { reasoning: 'high' }]);
  assert.equal(checkedModels.at(-1), 'model-b');
  assert.equal(researchAfterSave, true);
  const closedBeforeCancel = closed;
  const cancelModal = new NextStepModal({}, 'Parent', 'normal', 1, 0, plugin, async () => {}, async options => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => { const error = new Error('aborted'); error.name = 'AbortError'; reject(error); }, { once: true })), async () => {});
  cancelModal.onOpen(); find(cancelModal.contentEl, item => item.cls === 'vam-next-cards').children[1].click();
  button(cancelModal.contentEl, 'Quickly explore a map').click(); button(cancelModal.contentEl, 'Create starter map now').click(); await tick();
  const taskCancel = find(cancelModal.contentEl, item => item.cls === 'vam-task-cancel');
  assert.equal(taskCancel.hidden, false); taskCancel.onclick(); await tick();
  assert.match(find(all(cancelModal.contentEl, item => item.cls.includes('vam-next-research'))[1], item => item.cls.includes('vam-next-status')).text, /cancelled/i);
  assert.equal(closed, closedBeforeCancel);
});
function fixture(language = 'zh-TW') {
  const files = new Map(), contents = new Map();
  const attach = item => { const folderPath = item.path.split('/').slice(0, -1).join('/'); item.parent = files.get(folderPath) || null; if (item.parent instanceof TFolder && !item.parent.children.includes(item)) item.parent.children.push(item); };
  const renameTree = (from, to) => { const entries = Array.from(files.entries()).filter(([p]) => p === from || p.startsWith(`${from}/`)).sort((a, b) => a[0].length - b[0].length); for (const [old, item] of entries) { files.delete(old); const next = `${to}${old.slice(from.length)}`; item.path = next; item.name = next.split('/').at(-1); if (item instanceof TFile) { item.basename = item.name.replace(/\.md$/, ''); item.stat.mtime = Date.now(); const content = contents.get(old); contents.delete(old); contents.set(next, content); } files.set(next, item); } for (const [, item] of entries) attach(item); };
  const app = { vault: {
    getAbstractFileByPath: p => files.get(p),
    getMarkdownFiles: () => Array.from(files.values()).filter(file => file instanceof TFile && file.extension === 'md'),
    read: async file => contents.get(file.path), cachedRead: async file => contents.get(file.path),
    createFolder: async p => { if (files.has(p)) throw new Error(`Folder already exists: ${p}`); const folder = new TFolder(p); files.set(p, folder); attach(folder); return folder; },
    create: async (p, content) => { assert.equal(files.has(p), false); const file = new TFile(p); files.set(p, file); contents.set(p, content); attach(file); return file; },
    createBinary: async (p, content) => { assert.equal(files.has(p), false); const file = new TFile(p); files.set(p, file); contents.set(p, content); attach(file); return file; },
    process: async (file, change) => { contents.set(file.path, change(contents.get(file.path))); },
    adapter: {
      exists: async p => files.has(p),
      mkdir: async p => { if (files.has(p)) throw new Error(`Folder already exists: ${p}`); const folder = new TFolder(p); files.set(p, folder); attach(folder); },
      list: async p => ({ files: [...files.values()].filter(file => file instanceof TFile && file.parent?.path === p).map(file => file.path), folders: [...files.values()].filter(file => file instanceof TFolder && file.parent?.path === p).map(file => file.path) }),
      read: async p => { if (!contents.has(p)) throw new Error(`Missing file: ${p}`); return contents.get(p); },
      write: async (p, value) => { if (!files.has(p)) { const file = new TFile(p); files.set(p, file); attach(file); } contents.set(p, value); },
      process: async (p, change) => { if (!contents.has(p)) throw new Error(`Missing file: ${p}`); const next = change(contents.get(p)); contents.set(p, next); return next; }
    }
  }, metadataCache: { getFileCache: file => { const text = contents.get(file.path) || ''; return { frontmatter: text.includes('agent-map-node: true') ? { 'agent-map-node': true } : text.includes('visual-agent-map: true') ? { 'visual-agent-map': true } : {} }; }, getFirstLinkpathDest: link => Array.from(files.values()).find(file => file instanceof TFile && (file.basename === link || file.path.replace(/\.md$/, '') === link)) || null }, fileManager: { renameFile: async (item, target) => renameTree(item.path, target), trashFile: async () => {} } };
  return { app, contents, files, repo: new Repository(app, { ...DEFAULT_SETTINGS, language }) };
}
async function topicNote(repo, title = '題目', model = 'model-a', id = 'map-a') {
  const mapDoc = { id, title: id, version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  const mapPath = `Agent Workspace/Topics/${id}/Map.md`; await repo.ensureTopicFolders(`Agent Workspace/Topics/${id}`);
  return repo.createNote(title, model, mapDoc, mapPath, 'workspace');
}
async function mindSearchMapFixture() {
  const data = fixture(); const mapPath = await data.repo.createMap('MindSearch MVE'); let document = await data.repo.readMap(mapPath);
  const question = await data.repo.createNote('使用者問題', 'gpt-6-luna', document, mapPath, 'workspace');
  document.nodes.push(question); await data.repo.saveMap(mapPath, document);
  const { MindSearchRunStore } = load('mindsearch-mve/research-run-store.ts');
  return { ...data, mapPath, question, store: new MindSearchRunStore(data.repo, (() => { let next = 0; return () => `mindsearch-id-${++next}`; })(), () => '2026-10-04T22:30:00.000Z') };
}
integrationTest('fully specified startup still enforces the minimum answer floor without creating a conclusion', async () => {
  const { repo } = fixture();
  const { createMindSearchMap } = load('experiences/mind-search/create-map.ts');
  const created = await createMindSearchMap(repo, 'gpt-6-luna', { requestId: 'specified-start-map', topic: 'Build a three-color palette', context: 'Use the supplied blue, amber, and cream colors; preserve contrast and keep the result calm.' });
  const { MindSearchRunStore } = load('mindsearch-mve/research-run-store.ts');
  const { MindSearchManualFlow, MINDSEARCH_NO_QUESTION } = load('experiences/mind-search/manual-flow.ts');
  const phases = [], models = [];
  const flow = new MindSearchManualFlow(repo, new MindSearchRunStore(repo), async (context, model, reasoning) => {
    const phase = ['initial-question', 'saved-evidence-review', 'decision-quality-review', 'research-plan', 'subtopic-research', 'report-review'].find(item => mindSearchPhase(context, item));
    phases.push(phase ?? 'unmarked'); models.push([model, reasoning, context.researchMode]);
    if (phase === 'initial-question') return phases.filter(item => item === 'initial-question').length === 1
      ? { summary: MINDSEARCH_NO_QUESTION, detail: 'The requested outcome and constraints are already supplied.', suggestions: [], visualReferences: [] }
      : { summary: 'Which contrast target should the palette prioritize?', detail: 'Choose the main accessibility constraint.', suggestions: [{ title: 'Standard text contrast', task: '', contribution: '', parentTitle: '' }, { title: 'Large display text', task: '', contribution: '', parentTitle: '' }], visualReferences: [] };
    throw new Error(`A fully specified startup unexpectedly requested ${phase ?? context.task.slice(0, 90)}.`);
  });
  const outcome = await flow.planNextQuestion(created.mapPath, created.root.id, 'gpt-6-luna', 'low', 'specified-start-question');
  assert.equal(outcome.status, 'question', 'the configured floor keeps an apparently complete topic open for user input');
  const saved = await repo.readMap(created.mapPath);
  assert.equal(saved.mindSearch.branches.length, 0, 'the topic is not concluded without an answered question path');
  assert.equal(saved.nodes.some(node => node.mindSearchKind === 'question'), true);
  assert.deepEqual(phases, ['initial-question', 'initial-question']);
  assert.deepEqual(models, Array(2).fill(['gpt-6-luna', 'low', 'local']));
});
integrationTest('a new answer researches its own target before reviewing inherited evidence', async () => {
  const { repo } = fixture();
  const { createMindSearchMap } = load('experiences/mind-search/create-map.ts');
  const created = await createMindSearchMap(repo, 'gpt-6-luna', { requestId: 'evidence-first-map', topic: 'Prepare a cast-iron steak', context: 'Synthetic scenario: 1.5-inch steak, cast-iron pan, thermometer, no oven.' });
  const { MindSearchRunStore } = load('mindsearch-mve/research-run-store.ts');
  const { MindSearchManualFlow } = load('experiences/mind-search/manual-flow.ts');
  const store = new MindSearchRunStore(repo);
  let mapDoc = await repo.readMap(created.mapPath);
  const firstQuestion = await repo.createNote('Synthetic preparation question', 'gpt-6-luna', mapDoc, created.mapPath, 'workspace');
  firstQuestion.mindSearchKind = 'question';
  firstQuestion.mindSearchQuestion = { requestId: 'evidence-first-parent-question', parentBranchId: null, options: [{ id: 'pan', label: 'Cast iron' }, { id: 'other', label: 'Another pan' }], allowMultiple: false, allowFreeText: true };
  mapDoc.nodes.push(firstQuestion); await repo.saveMap(created.mapPath, mapDoc);
  const parent = await store.createAnswerBranch(created.mapPath, { requestId: 'evidence-first-parent-answer', questionNodeId: firstQuestion.id, parentBranchId: null, answerSnapshot: { selections: ['pan'], freeText: 'Use a thermometer; no oven.' }, inputSnapshot: { topic: mapDoc.title, conditions: { scenario: 'synthetic 1.5-inch steak' }, upstreamResults: [] } });
  const parentAttempt = await store.startAttempt(created.mapPath, parent.id, 'evidence-first-parent-run');
  await store.recordResearchTurn(created.mapPath, parentAttempt);
  await store.recordPlannerReview(created.mapPath, parentAttempt, { decision: 'ask_user', rationale: 'A finishing preference still changes the final serving advice.', researchTurn: 1, question: 'Which finish should be prioritized?', answerOptions: ['Simple pan finish', 'Resting and serving'] });
  const parentDraft = (await store.createResultDraft(created.mapPath, parentAttempt, 'Saved preparation report', 'gpt-6-luna', undefined, { kind: 'research' })).draft;
  await store.updateResultDraftReport(created.mapPath, parentAttempt, parentDraft.id, 'Synthetic saved report: safe-temperature and cast-iron method coverage.', 'Research status: search completed\nSynthetic report gives a conditional method, thermometer use, and its limits.');
  await store.commitResult(created.mapPath, parentAttempt, parentDraft.id, { summary: 'Synthetic saved report.', detail: 'Research status: search completed\nSynthetic conditional method and limitations.' });
  store.releaseAttempt(created.mapPath, parentAttempt);
  const recoveryFlow = new MindSearchManualFlow(repo, store, async () => { throw new Error('Post-report question recovery must not invoke a Planner.'); });
  assert.equal(await recoveryFlow.recoverPostReportQuestions(created.mapPath), 1);
  mapDoc = await repo.readMap(created.mapPath);
  const followup = mapDoc.nodes.find(node => node.mindSearchQuestion?.parentBranchId === parent.id);
  assert.ok(followup);

  const phases = []; let webCalls = 0;
  const flow = new MindSearchManualFlow(repo, store, async context => {
  const phase = ['research-plan', 'saved-evidence-review', 'subtopic-research', 'report-review'].find(item => mindSearchPhase(context, item));
    phases.push(phase ?? 'unmarked');
    if (phase === 'research-plan') return { summary: 'Two complementary targets', detail: '<!-- mindsearch-plan {"subtopics":[{"id":"safety","title":"Safety limits","task":"Check safety limits for the answer","expectedValue":"Retain supported constraints"},{"id":"finish","title":"Finishing method","task":"Compare finishing techniques","expectedValue":"Resolve serving differences"}]} -->', suggestions: [], visualReferences: [] };
    if (context.researchMode === 'research') { webCalls++; return { summary: 'Synthetic answer-specific report.', detail: 'Research status: search completed\nA targeted report checked the current answer against the inherited method.', suggestions: [], visualReferences: [] }; }
    if (phase === 'report-review') {
      assert.match([context.task, context.detail, context.ancestors].join("\n"), /Synthetic saved report/);
      return plannerReview('ask_user', { rationale: 'The inherited and new reports support a conditional answer, but the finishing preference still changes serving advice.', question: 'Which finish should be prioritized?' }, 'Keep the supplied safety limit and compare the saved method with this answer-specific evidence.', 'The reports do not establish the user’s preferred finish.', ['Simple pan finish', 'Resting and serving']);
    }
    if (context.task.includes('Correct the candidate decision before it can be saved')) return plannerReview('ask_user', { rationale: 'Preparation time could materially change the practical recommendation and is not covered by the prior question.', question: 'How much preparation time is available?' }, 'Keep the supplied safety limit and compare the saved method with this answer-specific evidence.', 'The reports do not establish the available preparation time.', ['Under 30 minutes', 'At least 30 minutes']);
    throw new Error(`Unexpected phase ${phase ?? context.task.slice(0, 90)}.`);
  });
  const result = await flow.answerAndResearch(created.mapPath, followup.id, { requestId: 'evidence-first-child-answer', selections: [followup.mindSearchQuestion.options[0].id], freeText: 'Keep the supplied safety limitation.' }, 'gpt-6-luna', 'low');
  assert.equal(result.status, 'waiting-user'); assert.equal(webCalls, 2);
  assert.deepEqual(phases, ['research-plan', 'subtopic-research', 'subtopic-research', 'report-review', 'unmarked'], 'one bounded quality correction replaces the unsupported early conclusion');
  const saved = await repo.readMap(created.mapPath), child = saved.mindSearch.branches.find(item => item.id === result.branchId);
  assert.equal(child.parentBranchId, parent.id);
  assert.ok(child.inputSnapshot.upstreamResults.some(ref => ref.notePath === parentDraft.notePath));
  assert.equal(child.results.filter(item => item.kind === 'research').length, 2);
});
integrationTest('MindSearch retry clears a stale plan error when saved evidence concludes by replanning research', async () => {
  const { repo } = fixture(); const { createMindSearchMap } = load('experiences/mind-search/create-map.ts');
  const created = await createMindSearchMap(repo, 'gpt-6-luna', { requestId: 'plan-error-retry-map', topic: 'Choose a safe walking route', context: 'The user wants a short, step-free route.' });
  const { MindSearchRunStore } = load('mindsearch-mve/research-run-store.ts');
  const { MindSearchManualFlow } = load('experiences/mind-search/manual-flow.ts');
  const store = new MindSearchRunStore(repo); let map = await repo.readMap(created.mapPath);
  const question = await repo.createNote('Route question', 'gpt-6-luna', map, created.mapPath, 'workspace');
  question.mindSearchKind = 'question';
  question.mindSearchQuestion = { requestId: 'plan-error-retry-question', parentBranchId: null, options: [{ id: 'short', label: 'Shortest route' }, { id: 'scenic', label: 'Scenic route' }], allowMultiple: false, allowFreeText: true };
  map.nodes.push(question); await repo.saveMap(created.mapPath, map);
  const branch = await store.createAnswerBranch(created.mapPath, { requestId: 'plan-error-retry-answer', questionNodeId: question.id, parentBranchId: null, answerSnapshot: { selections: ['short'], freeText: '' }, inputSnapshot: { topic: map.title, conditions: { preference: 'short route' }, upstreamResults: [] } });
  await store.saveResearchPlanError(created.mapPath, branch.id, new Error('A previous Planner response did not include a valid plan.'));
  const phases = [];
  const currentModel = coverageModel();
  const flow = new MindSearchManualFlow(repo, store, async context => { phases.push(context.task.match(/mindsearch-phase:\s*([a-z-]+)/)?.[1]); return currentModel.ask(context); });
  const result = await flow.retryAnswerResearch(created.mapPath, branch.id, 'gpt-6-luna', 'low');
  assert.equal(result.status, 'waiting-user');
  assert.equal(phases.includes('research-plan'), true); assert.equal(phases.filter(p => p === 'subtopic-research').length, 2); assert.equal(phases.includes('saved-evidence-review'), false);
  map = await repo.readMap(created.mapPath);
  const savedBranch = map.mindSearch.branches.find(item => item.id === branch.id);
  assert.equal(savedBranch.researchPlanError, undefined, 'a successful saved-evidence outcome clears the obsolete plan error');
  assert.equal(savedBranch.results.filter(item => item.kind === 'research').length, 2);
  const element = tag => ({ tag, children: [], dataset: {}, style: {}, createDiv(options) { const child = element('div'); child.cls = options?.cls ?? options; this.children.push(child); return child; }, createEl(name, options) { const child = element(name); child.text = options?.text; child.cls = options?.cls ?? ''; this.children.push(child); return child; }, createSpan(options) { const child = element('span'); child.text = options?.text; child.cls = options?.cls ?? ''; this.children.push(child); return child; }, setAttr(name, value) { this[name] = value; }, addClass(name) { this.cls = name; }, addEventListener() {}, removeEventListener() {}, setPointerCapture() {} });
  const { VisualAgentMapView } = load('experiences/visual-map/view.ts', { obsidian });
  const view = new VisualAgentMapView({ app: {} }, { repo, settings: { ...DEFAULT_SETTINGS }, expansionBatches: new Map(), running: new Map(), quickExpandPending: new Set(), pendingSuggestions: new Map() });
  view.stageEl = element('stage'); view.map = map; view.notes = new Map([[question.id, { title: 'Route question', summary: 'Route question', status: 'idea' }]]); view.renderNode(question);
  const findStatusBadge = item => String(item.cls ?? '').includes('vam-mindsearch-question-status') ? item : item.children?.map(findStatusBadge).find(Boolean);
  const statusBadge = findStatusBadge(view.stageEl);
  assert.ok(statusBadge, 'the question card shows its MindSearch result status');
  assert.match(statusBadge.cls, /completed/);
});
integrationTest('planned MindSearch resume skips the saved plan and already completed subtopics', async () => {
  const { repo, contents } = fixture();
  const mapPath = await repo.createMap('Planned resume');
  const { MindSearchRunStore } = load('mindsearch-mve/research-run-store.ts');
  const { MindSearchManualFlow } = load('experiences/mind-search/manual-flow.ts');
  const store = new MindSearchRunStore(repo); let mapDoc = await repo.readMap(mapPath);
  const question = await repo.createNote('Synthetic resume question', 'gpt-6-luna', mapDoc, mapPath, 'workspace');
  question.mindSearchKind = 'question'; question.mindSearchQuestion = { requestId: 'planned-resume-question', parentBranchId: null, options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], allowMultiple: false, allowFreeText: true };
  mapDoc.nodes.push(question); await repo.saveMap(mapPath, mapDoc);
  const branch = await store.createAnswerBranch(mapPath, { requestId: 'planned-resume-answer', questionNodeId: question.id, parentBranchId: null, answerSnapshot: { selections: ['a'], freeText: 'Synthetic conditions.' }, inputSnapshot: { topic: mapDoc.title, conditions: { scenario: 'resume fixture' }, upstreamResults: [] } });
  const plan = [
    { id: 'safety', title: 'Safety guidance', task: 'Find relevant safety guidance.', expectedValue: 'Preserve safety limits.' },
    { id: 'method', title: 'Practical method', task: 'Find a practical method.', expectedValue: 'Provide an actionable procedure.' }
  ];
  await store.saveResearchPlan(mapPath, branch.id, plan);
  const firstAttempt = await store.startAttempt(mapPath, branch.id, 'resume-seed-run');
  await store.recordResearchTurn(mapPath, firstAttempt);
  const firstDraft = (await store.createResultDraft(mapPath, firstAttempt, plan[0].title, 'gpt-6-luna', undefined, { kind: 'research', subtopicId: plan[0].id })).draft;
  await store.updateResultDraftReport(mapPath, firstAttempt, firstDraft.id, 'Saved safety report.', 'Research status: search completed\nSynthetic safety report retained before interruption.');
  await store.commitResult(mapPath, firstAttempt, firstDraft.id, { summary: 'Saved safety report.', detail: 'Research status: search completed\nSynthetic safety report retained before interruption.' });
  store.releaseAttempt(mapPath, firstAttempt);
  await seedCoverageAncestors(repo, mapPath, branch.id);
  const bytesBefore = contents.get(firstDraft.notePath), calls = [];
  const flow = new MindSearchManualFlow(repo, store, async (context, _model, _reasoning, _signal, onWebSearchEvent) => {
    const delivery = deliveryFixture(context); if (delivery) return delivery;
    const phase = ['research-plan', 'subtopic-research', 'report-review', 'decision-quality-review'].find(item => mindSearchPhase(context, item));
    calls.push({ context, phase });
    if (phase === 'research-plan') throw new Error('Resume must use the immutable previously saved plan.');
    if (phase === 'subtopic-research') {
      assert.match(context.task, /Assigned research subtopic: Practical method/);
      onWebSearchEvent?.({ method: 'item/completed', params: { item: { action: { type: 'search' } } } });
      return { summary: 'Completed method report.', detail: 'Research status: search completed\nSynthetic practical method and limitations.', suggestions: [], visualReferences: [] };
    }
    if (phase === 'report-review') return plannerReview('conclude', { rationale: 'The saved and resumed reports together answer the request.', stopReason: 'Both planned subtopics now have persisted reports.' }, 'A conditional answer based on both reports.', 'Keep the saved safety limit and practical procedure together.');
    if (phase === 'decision-quality-review') return auditEcho(context);
    throw new Error(`Unexpected resume call: ${context.task.slice(0, 90)}`);
  });
  const outcome = await flow.resumeAnswerResearch(mapPath, branch.id, 'gpt-6-luna', 'low');
  assert.equal(outcome.status, 'completed');
  assert.deepEqual(calls.map(call => call.phase), ['subtopic-research', 'report-review']);
  assert.equal(contents.get(firstDraft.notePath), bytesBefore, 'resuming does not rewrite the previously saved subtopic report');
  mapDoc = await repo.readMap(mapPath);
  const resumedBranch = mapDoc.mindSearch.branches.find(item => item.id === branch.id);
  assert.equal(resumedBranch.results.filter(item => item.kind === 'research').map(item => item.subtopicId).join(','), 'safety,method');
  assert.equal(resumedBranch.results.filter(item => item.kind === 'conclusion').length, 1);
});
integrationTest('MindSearch research plans accept one target without quota filler and keep unique bounded targets', async () => {
  const { repo, mapPath, question, store } = await mindSearchMapFixture();
  let map = await repo.readMap(mapPath); const questionNode = map.nodes.find(node => node.id === question.id);
  questionNode.mindSearchKind = 'question'; questionNode.mindSearchQuestion = { requestId: 'legacy-one-plan-question', parentBranchId: null, options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], allowMultiple: false, allowFreeText: true };
  await repo.saveMap(mapPath, map);
  const createBranch = requestId => store.createAnswerBranch(mapPath, { requestId, questionNodeId: question.id, parentBranchId: null, answerSnapshot: { selections: ['a'], freeText: '' }, inputSnapshot: { topic: 'Legacy plan', conditions: {}, upstreamResults: [] } });
  const invalidBranch = await createBranch('invalid-plan');
  const target = (id, title = id) => ({ id, title, task: `Research ${title}.`, expectedValue: `Clarify ${title}.` });
  await assert.rejects(store.saveResearchPlan(mapPath, invalidBranch.id, Array.from({ length: 6 }, (_, index) => target(`six-${index}`))), /0–5 valid research subtopics/);
  await assert.rejects(store.saveResearchPlan(mapPath, invalidBranch.id, [target('duplicate', 'Same'), target('duplicate', 'Other')]), /unique ids and titles/);
  assert.equal((await repo.readMap(mapPath)).mindSearch.branches.find(branch => branch.id === invalidBranch.id).researchPlan, undefined, 'invalid plans are rejected before persistence');
  await store.saveResearchPlan(mapPath, invalidBranch.id, [target('one')]);

  const legacyBranch = await createBranch('legacy-one-plan');
  map = await repo.readMap(mapPath); map.mindSearch.branches.find(branch => branch.id === legacyBranch.id).researchPlan = [target('legacy', 'Legacy target')]; await repo.saveMap(mapPath, map);
  const { MindSearchManualFlow } = load('experiences/mind-search/manual-flow.ts'); const phases = [];
  const flow = new MindSearchManualFlow(repo, store, async context => {
    const phase = mindSearchPhase(context, 'research-plan') ? 'research-plan' : mindSearchPhase(context, 'subtopic-research') ? 'subtopic-research' : mindSearchPhase(context, 'report-review') ? 'report-review' : 'other'; phases.push(phase);
    if (phase === 'research-plan') throw new Error('A saved legacy plan must be reused.');
    if (phase === 'subtopic-research') return { summary: 'Legacy report', detail: 'Research status: search completed\nLegacy evidence.', suggestions: [], visualReferences: [] };
    if (phase === 'report-review') return plannerReview('ask_user', { rationale: 'The saved legacy report supports a conditional answer.', question: 'Which route detail matters most?' }, 'Conditional legacy result.', 'Preserve the saved evidence.', ['Distance', 'Transfers']);
    throw new Error('Unexpected legacy resume phase.');
  });
  const resumed = await flow.resumeAnswerResearch(mapPath, legacyBranch.id, 'gpt-6-luna', 'low');
  assert.equal(resumed.status, 'waiting-user');
  assert.deepEqual(phases.filter(phase => phase === 'subtopic-research'), ['subtopic-research']);
  assert.equal(phases.includes('research-plan'), false);
});
integrationTest('MindSearch removes duplicated topic context and rejects oversized prompts without truncation', async () => {
  const { repo } = fixture(); const { createMindSearchMap } = load('experiences/mind-search/create-map.ts');
  const { MindSearchManualFlow } = load('experiences/mind-search/manual-flow.ts');
  const duplicatedDetail = 'D'.repeat(70_000);
  const dedupeMap = await createMindSearchMap(repo, 'gpt-6-luna', { requestId: 'mindsearch-context-dedupe', topic: 'Synthetic context dedupe', context: '' });
  await repo.updateNote(dedupeMap.root.path, { detail: duplicatedDetail });
  let acceptedContext;
  const dedupeFlow = new MindSearchManualFlow(repo, new (load('mindsearch-mve/research-run-store.ts').MindSearchRunStore)(repo), async context => {
    acceptedContext = context;
    return { summary: 'Which condition matters?', detail: 'A synthetic choice is needed.', suggestions: [{ title: 'Option A' }, { title: 'Option B' }], visualReferences: [] };
  });
  const planned = await dedupeFlow.planNextQuestion(dedupeMap.mapPath, dedupeMap.root.id, 'gpt-6-luna', 'low', 'context-dedupe-question');
  assert.equal(planned.status, 'question');
  assert.equal(acceptedContext.detail, '', 'a topic detail already represented in the Planner task is removed from the duplicated context field');
  assert.ok(acceptedContext.task.includes(duplicatedDetail), 'deduplication preserves the full topic detail in the task');

  const oversizedMap = await createMindSearchMap(repo, 'gpt-6-luna', { requestId: 'mindsearch-context-oversized', topic: 'Synthetic oversized context', context: '' });
  const completeGoal = 'G'.repeat(112_000);
  await repo.updateNote(oversizedMap.root.path, { detail: completeGoal });
  let modelCalls = 0;
  const oversizedFlow = new MindSearchManualFlow(repo, new (load('mindsearch-mve/research-run-store.ts').MindSearchRunStore)(repo), async () => {
    modelCalls++;
    return { summary: 'Should not be called.', detail: 'The entire original goal must remain present.', suggestions: [], visualReferences: [] };
  });
  await assert.rejects(oversizedFlow.planNextQuestion(oversizedMap.mapPath, oversizedMap.root.id, 'gpt-6-luna', 'low', 'context-oversized-question'), /MindSearch model request is too large.*no goal, condition, or evidence was discarded/);
  assert.equal(modelCalls, 0, 'the model receives no truncated request when the full goal exceeds the budget');
});
integrationTest('MindSearch saved-evidence preflight includes one copy of ancestor reports and preserves branch answers', async () => {
  const { repo } = fixture(); const { createMindSearchMap } = load('experiences/mind-search/create-map.ts');
  const { MindSearchRunStore } = load('mindsearch-mve/research-run-store.ts');
  const { MindSearchManualFlow } = load('experiences/mind-search/manual-flow.ts');
  const created = await createMindSearchMap(repo, 'gpt-6-luna', { requestId: 'lineage-context-budget-map', topic: 'Choose a step-free outing route', context: 'Keep the total walk short.' });
  const store = new MindSearchRunStore(repo); let map = await repo.readMap(created.mapPath);
  const parentQuestion = await repo.createNote('First route condition', 'gpt-6-luna', map, created.mapPath, 'workspace');
  parentQuestion.mindSearchKind = 'question'; parentQuestion.mindSearchQuestion = { requestId: 'lineage-context-parent-q', parentBranchId: null, options: [{ id: 'short', label: 'Short walking distance' }, { id: 'flat', label: 'Mostly flat' }], allowMultiple: false, allowFreeText: true };
  map.nodes.push(parentQuestion); await repo.saveMap(created.mapPath, map);
  const parentBranch = await store.createAnswerBranch(created.mapPath, { requestId: 'lineage-context-parent-a', questionNodeId: parentQuestion.id, parentBranchId: null, answerSnapshot: { selections: ['flat'], freeText: 'Avoid steep ramps.' }, inputSnapshot: { topic: map.title, conditions: { route: 'mostly flat', access: 'avoid steep ramps' }, upstreamResults: [] } });
  await store.saveResearchPlan(created.mapPath, parentBranch.id, [{ id: 'access', title: 'Route access', task: 'Research route accessibility.', expectedValue: 'Preserve access limits.' }, { id: 'distance', title: 'Walking distance', task: 'Research route distance.', expectedValue: 'Keep the route short.' }]);
  const parentAttempt = await store.startAttempt(created.mapPath, parentBranch.id, 'lineage-context-run');
  await store.recordResearchTurn(created.mapPath, parentAttempt);
  const uniqueMarker = 'SAVED_REPORT_UNIQUE_EVIDENCE_MARKER_8f3c';
  const longReport = `${uniqueMarker}\n${'A'.repeat(80_000)}`;
  const reportDraft = (await store.createResultDraft(created.mapPath, parentAttempt, 'Route access report', 'gpt-6-luna', undefined, { kind: 'research', subtopicId: 'access' })).draft;
  await store.updateResultDraftReport(created.mapPath, parentAttempt, reportDraft.id, 'A route access report.', longReport);
  await store.commitResult(created.mapPath, parentAttempt, reportDraft.id, { summary: 'A route access report.', detail: longReport });
  store.releaseAttempt(created.mapPath, parentAttempt);
  map = await repo.readMap(created.mapPath);
  const followupQuestion = await repo.createNote('Second route condition', 'gpt-6-luna', map, created.mapPath, 'workspace');
  followupQuestion.parentId = reportDraft.nodeId; followupQuestion.mindSearchKind = 'question';
  followupQuestion.mindSearchQuestion = { requestId: 'lineage-context-child-q', parentBranchId: parentBranch.id, options: [{ id: 'stroller', label: 'Stroller access' }, { id: 'wheelchair', label: 'Wheelchair access' }], allowMultiple: false, allowFreeText: true };
  map.nodes.push(followupQuestion); await repo.saveMap(created.mapPath, map);
  const childBranch = await store.createAnswerBranch(created.mapPath, { requestId: 'lineage-context-child-a', questionNodeId: followupQuestion.id, parentBranchId: parentBranch.id, answerSnapshot: { selections: ['wheelchair'], freeText: 'Need a wide sidewalk.' }, inputSnapshot: { topic: map.title, conditions: { route: 'mostly flat', access: 'wheelchair; wide sidewalk' }, upstreamResults: [{ notePath: reportDraft.notePath, version: 1 }] } });
  await store.saveResearchPlanError(created.mapPath, childBranch.id, new Error('A prior plan response was invalid.'));
  const seen = [];
  const currentModel = coverageModel();
  const flow = new MindSearchManualFlow(repo, store, async context => {
    seen.push(context);
    const complete = [context.task, context.detail, context.ancestors].join('\n');
    assert.match(complete, /Avoid steep ramps/); assert.match(complete, /wide sidewalk/);
    const indexedReport = complete.match(/Evidence ID: ([^\s]+)\nSummary: A route access report\./)?.[1];
    if (mindSearchPhase(context, 'report-review') && indexedReport && !context.task.includes('Requested full evidence')) return { summary: 'Load the indexed parent evidence.', detail: `<!-- mindsearch-evidence-request {"ids":["${indexedReport}"]} -->`, suggestions: [], visualReferences: [] };
    if (context.task.includes('Requested full evidence')) assert.equal(context.task.split('A'.repeat(80_000)).length - 1, 1, 'requested long report body is loaded once and never truncated');
    return currentModel.ask(context);
  });
  const result = await flow.retryAnswerResearch(created.mapPath, childBranch.id, 'gpt-6-luna', 'low');
  assert.equal(result.status, 'waiting-user');
  assert.ok(seen.some(context => mindSearchPhase(context, 'subtopic-research')));
  assert.ok(seen.some(context => context.task.includes('Requested full evidence') && context.task.includes(uniqueMarker)), 'the full report is loaded only after an explicit evidence-ID request');
  assert.equal((await repo.readNote(reportDraft.notePath)).detail, longReport, 'stored source report is unchanged');

});
integrationTest('MindSearch topic rename rebases saved paths and refreshes attempt snapshot hashes', async () => {
  const { repo } = fixture();
  const { createMindSearchMap } = load('experiences/mind-search/create-map.ts');
  const created = await createMindSearchMap(repo, 'gpt-6-luna', { requestId: 'rename-mindsearch-map', topic: 'Rename source', context: 'Synthetic fixture.' });
  const { MindSearchRunStore } = load('mindsearch-mve/research-run-store.ts');
  let id = 0;
  const store = new MindSearchRunStore(repo, () => `rename-id-${++id}`);
  let saved = await repo.readMap(created.mapPath);
  const question = await repo.createNote('Synthetic question', 'gpt-6-luna', saved, created.mapPath, 'workspace');
  saved.nodes.push(question);
  saved.mindSearch.rootDraft = { nodeId: 'reserved-root-draft', notePath: created.root.path, title: 'Synthetic root draft', context: 'Fixture only.' };
  saved.mindSearch.questionDraft = { requestId: 'rename-question-draft', nodeId: 'reserved-question-draft', parentId: question.id, notePath: `${repo.topicRoot(created.mapPath)}/Notes/Pending question.md`, title: 'Pending question', summary: 'A synthetic pending question.', detail: '', prompt: '', model: 'gpt-6-luna', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] };
  await repo.saveMap(created.mapPath, saved);
  const branch = await store.createAnswerBranch(created.mapPath, {
    questionNodeId: question.id, parentBranchId: null, answerSnapshot: { selections: ['a'], freeText: 'Synthetic answer.' },
    inputSnapshot: { topic: saved.title, conditions: {}, upstreamResults: [{ notePath: created.root.path, version: 1 }] }
  });
  const attempt = await store.startAttempt(created.mapPath, branch.id, 'rename-run');
  const draft = (await store.createResultDraft(created.mapPath, attempt, 'Synthetic result draft', 'gpt-6-luna')).draft;
  saved = await repo.readMap(created.mapPath);
  saved.mindSearch.runs[0].attempts[0].status = 'completed';
  await repo.saveMap(created.mapPath, saved);
  store.releaseAttempt(created.mapPath, attempt);
  const resultAttempt = await store.startAttempt(created.mapPath, branch.id, 'rename-result-run');
  const committedDraft = (await store.createResultDraft(created.mapPath, resultAttempt, 'Synthetic committed result', 'gpt-6-luna')).draft;
  await store.commitResult(created.mapPath, resultAttempt, committedDraft.id, { summary: 'Synthetic result.', detail: 'Fixture report.' });
  store.releaseAttempt(created.mapPath, resultAttempt);

  const nextPath = await repo.renameTopic(created.mapPath, 'Rename target');
  const renamed = await repo.readMap(nextPath), renamedBranch = renamed.mindSearch.branches[0];
  const nextRoot = repo.topicRoot(nextPath);
  assert.equal(renamed.title, 'Rename target');
  assert.ok(renamed.nodes.every(node => node.path.startsWith(`${nextRoot}/`)));
  assert.equal(renamedBranch.inputSnapshot.upstreamResults[0].notePath, `${nextRoot}/Notes/${created.root.path.split('/').at(-1)}`);
  assert.equal(renamed.mindSearch.resultDrafts[0].notePath, `${nextRoot}/Notes/${draft.notePath.split('/').at(-1)}`);
  assert.equal(renamed.mindSearch.rootDraft.notePath, `${nextRoot}/Notes/${created.root.path.split('/').at(-1)}`);
  assert.equal(renamed.mindSearch.questionDraft.notePath, `${nextRoot}/Notes/Pending question.md`);
  assert.equal(renamedBranch.results[0].notePath, `${nextRoot}/Notes/${committedDraft.notePath.split('/').at(-1)}`);
  const expectedHash = require('node:crypto').createHash('sha256').update(JSON.stringify({ branch: renamedBranch.inputSnapshot, answer: renamedBranch.answerSnapshot })).digest('hex');
  assert.equal(renamed.mindSearch.runs[0].attempts[0].inputSnapshotHash, expectedHash);
  assert.equal(renamed.mindSearch.resultDrafts[0].inputSnapshotHash, expectedHash);
  assert.equal(core.parseMap(await repo.app.vault.read(repo.file(nextPath))).mindSearch.resultDrafts[0].notePath, renamed.mindSearch.resultDrafts[0].notePath);
});
integrationTest('MindSearch topic rename blocks persisted running or saving attempts across Repository instances', async () => {
  const { repo } = fixture();
  const { createMindSearchMap } = load('experiences/mind-search/create-map.ts');
  const created = await createMindSearchMap(repo, 'gpt-6-luna', { requestId: 'rename-active-map', topic: 'Active research', context: '' });
  const { MindSearchRunStore } = load('mindsearch-mve/research-run-store.ts');
  const store = new MindSearchRunStore(repo);
  let saved = await repo.readMap(created.mapPath);
  const question = await repo.createNote('Synthetic question', 'gpt-6-luna', saved, created.mapPath, 'workspace');
  saved.nodes.push(question); await repo.saveMap(created.mapPath, saved);
  const branch = await store.createAnswerBranch(created.mapPath, { questionNodeId: question.id, parentBranchId: null, answerSnapshot: { selections: [], freeText: 'Synthetic.' }, inputSnapshot: { topic: 'Active research', conditions: {}, upstreamResults: [] } });
  const running = await store.startAttempt(created.mapPath, branch.id, 'active-run');
  const reopenedRepo = new Repository(repo.app, repo.settings);
  await assert.rejects(reopenedRepo.renameTopic(created.mapPath, 'Should not move'), /still running or saving/);
  const draft = (await store.createResultDraft(created.mapPath, running, 'Synthetic pending result', 'gpt-6-luna')).draft;
  let releaseSave, savingStarted;
  const savingReady = new Promise(resolve => { savingStarted = resolve; });
  const updateNote = repo.updateNote.bind(repo);
  repo.updateNote = async (path, patch) => {
    if (patch.summary === 'Pending save fixture.') { savingStarted(); await new Promise(resolve => { releaseSave = resolve; }); }
    return updateNote(path, patch);
  };
  const commit = store.commitResult(created.mapPath, running, draft.id, { summary: 'Pending save fixture.', detail: 'Pending commit fixture.' });
  await savingReady;
  const pending = await reopenedRepo.readMap(created.mapPath);
  assert.equal(pending.mindSearch.runs[0].attempts[0].status, 'saving');
  assert.equal(pending.mindSearch.pendingCommits[0].notePath, draft.notePath);
  await assert.rejects(reopenedRepo.renameTopic(created.mapPath, 'Should not move'), /still running or saving/);
  releaseSave(); await commit;
  assert.ok(repo.app.vault.getAbstractFileByPath(repo.topicRoot(created.mapPath)));
  assert.equal(repo.app.vault.getAbstractFileByPath('Agent Workspace/Topics/Should not move'), undefined);
});
integrationTest('topic rename restores the original folder and exact Map.md when derived-data rebuild fails', async () => {
  const { repo, app } = fixture();
  app.vault.modify = async (file, content) => app.vault.process(file, () => content);
  const originalPath = await repo.createMap('Rollback source');
  const originalRoot = repo.topicRoot(originalPath), destination = 'Agent Workspace/Topics/Rollback target';
  const originalContent = await app.vault.read(repo.file(originalPath));
  const rebuild = repo.rebuildDerivedData.bind(repo); let failOnce = true;
  repo.rebuildDerivedData = async (...args) => { if (failOnce) { failOnce = false; throw new Error('simulated rebuild failure'); } return rebuild(...args); };
  await assert.rejects(repo.renameTopic(originalPath, 'Rollback target'), /simulated rebuild failure/);
  assert.ok(app.vault.getAbstractFileByPath(originalRoot));
  assert.equal(app.vault.getAbstractFileByPath(destination), undefined);
  assert.equal(await app.vault.read(repo.file(originalPath)), originalContent);
});
integrationTest('MindSearch freezes each answer/input branch snapshot and fences late attempts', async () => {
  const { repo, mapPath, question, store } = await mindSearchMapFixture();
  const answer = { selections: ['鑄鐵鍋'], freeText: '沒有烤箱' };
  const input = { topic: '在家煎牛排', conditions: { doneness: 'medium-rare' }, upstreamResults: [{ notePath: 'existing/report.md', version: 1 }] };
  const branch = await store.createAnswerBranch(mapPath, { questionNodeId: question.id, parentBranchId: null, answerSnapshot: answer, inputSnapshot: input });
  answer.selections[0] = '不應回寫'; input.conditions.doneness = 'well-done';
  const first = await store.startAttempt(mapPath, branch.id, 'run-1');
  const oldDraft = (await store.createResultDraft(mapPath, first, '舊 attempt 診斷', 'gpt-6-luna')).draft;
  const retry = await store.startAttempt(mapPath, branch.id, 'run-1');
  assert.equal(first.inputSnapshotHash, retry.inputSnapshotHash);
  const retiredDraft = await repo.readNote(oldDraft.notePath);
  assert.equal(retiredDraft.status, 'error'); assert.match(retiredDraft.summary, /不是有效研究結果/);
  assert.equal((await repo.readMap(mapPath)).nodes.some(node => node.id === oldDraft.nodeId), false);
  assert.deepEqual(plain(await store.createResultDraft(mapPath, first, '舊 attempt 不得產生結果', 'gpt-6-luna')), { status: 'stale', runId: 'run-1', attemptId: 'attempt-1' });
  const result = (await store.createResultDraft(mapPath, retry, '研究結果', 'gpt-6-luna')).draft;
  assert.deepEqual(plain((await repo.readMap(mapPath)).mindSearch.branches[0].answerSnapshot), { selections: ['鑄鐵鍋'], freeText: '沒有烤箱' });
  assert.equal((await store.commitResult(mapPath, first, result.id, { summary: 'late result', detail: 'must not publish' })).status, 'stale');
  assert.equal((await repo.readNote(result.notePath)).summary.includes('late result'), false);
  assert.deepEqual(plain(await store.commitResult(mapPath, retry, result.id, { summary: 'current result', detail: 'current attempt only' })), { status: 'committed', resultId: 'result-run-1-attempt-2', notePath: result.notePath });
  const savedMap = await repo.readMap(mapPath), savedNote = await repo.readNote(result.notePath);
  assert.equal(savedMap.mindSearch.runs[0].attempts[0].status, 'superseded');
  assert.equal(savedMap.mindSearch.runs[0].attempts[1].status, 'completed');
  assert.equal(savedMap.mindSearch.branches[0].results.length, 1);
  assert.equal(savedMap.mindSearch.branches[0].results[0].nodeId, result.nodeId);
  assert.equal(savedMap.mindSearch.resultDrafts.length, 0);
  assert.equal(savedNote.summary, 'current result'); assert.equal(savedNote.detail, 'current attempt only');
});
integrationTest('MindSearch start creates a typed mother topic through the production Map/Note Repository', async () => {
  const { repo } = fixture();
  const { createMindSearchMap } = load('experiences/mind-search/create-map.ts');
  const created = await createMindSearchMap(repo, 'gpt-6-luna', { requestId: 'mindsearch-start-test-1', topic: '如何安排一週的居家運動？', context: '每次不超過 30 分鐘；家中沒有器材。', model: 'gpt-6-luna', reasoning: 'low' });
  const savedMap = await repo.readMap(created.mapPath), savedNote = await repo.readNote(created.root.path);
  assert.equal(savedMap.title, '如何安排一週的居家運動？');
  assert.deepEqual(plain(savedMap.mindSearch), { version: 1, creationId: 'mindsearch-start-test-1', minimumAnswersBeforeConclusion: 3, branches: [], runs: [], resultDrafts: [], pendingCommits: [] });
  assert.equal(savedMap.nodes.length, 1);
  assert.equal(savedMap.nodes[0].mindSearchKind, 'topic');
  assert.equal(savedMap.nodes[0].id, created.root.id);
  assert.equal(savedNote.title, '如何安排一週的居家運動？');
  assert.equal(savedNote.summary, '如何安排一週的居家運動？');
  assert.match(savedNote.detail, /每次不超過 30 分鐘；家中沒有器材。/);
  assert.equal(savedNote.model, 'gpt-6-luna'); assert.equal(savedNote.reasoning, 'low');
  assert.equal(savedNote.status, 'idea');
});
integrationTest('MindSearch start locks submitted input and reuses its request identity after failure', async () => {
  const makeElement = (tag, options = {}) => ({ tag, text: options.text ?? '', value: options.value ?? '', cls: options.cls ?? '', children: [], disabled: false, style: {},
    createEl(name, value) { const child = makeElement(name, value); this.children.push(child); return child; },
    createSpan(value) { const child = makeElement('span', value); this.children.push(child); return child; },
    replaceChildren() { this.children = []; },
    setText(value) { this.text = value; }, setAttr(name, value) { this[name] = value; },
    addClass(name) { this.cls = `${this.cls} ${name}`.trim(); }, toggleClass(name, enabled) { this.cls = enabled ? `${this.cls} ${name}`.trim() : this.cls.split(' ').filter(item => item !== name).join(' '); },
    addEventListener(name, handler) { this[name] = handler; }, focus() {},
    querySelector(selector) { return selector === 'button:last-child' ? this.children.filter(child => child.tag === 'button').at(-1) : undefined; }
  });
  class Modal { constructor() { this.titleEl = makeElement('title'); this.contentEl = makeElement('content'); } close() { this.closed = true; } }
  class Setting { constructor(root) { this.controlEl = makeElement('setting'); root.children.push(this.controlEl); }
    addButton(configure) { const button = makeElement('button'); button.setButtonText = value => { button.text = value; return button; }; button.setCta = () => button; button.onClick = handler => { button.click = handler; return button; }; this.controlEl.children.push(button); configure(button); return this; }
  }
  const { MindSearchStartModal } = load('ui/modals/mind-search-start-modal.ts', { obsidian: { ...obsidian, Modal, Setting } });
  let rejectSubmit; const submissions = [];
  const modal = new MindSearchStartModal({}, input => { submissions.push(input); if (submissions.length === 1) return new Promise((_resolve, reject) => { rejectSubmit = reject; }); return Promise.resolve(); }, [{ id: 'gpt-5.6-luna', label: 'old default' }, { id: 'gpt-6-luna', label: 'approved model' }], 'gpt-6-luna', 'low');
  modal.onOpen();
  const topic = modal.contentEl.children.find(child => child.cls === 'vam-field').children[1];
  const context = modal.contentEl.children.filter(child => child.cls === 'vam-field')[1].children[1];
  const model = modal.contentEl.children.filter(child => child.cls === 'vam-field').flatMap(child => child.children).find(child => child['aria-label'] === 'Model' || child['aria-label'] === '使用模型');
  const reasoning = modal.contentEl.children.filter(child => child.cls === 'vam-field').flatMap(child => child.children).find(child => child['aria-label'] === 'Reasoning level' || child['aria-label'] === '推理等級');
  assert.equal(model.value, 'gpt-6-luna'); assert.equal(reasoning.value, 'low');
  topic.value = '牛排'; context.value = '鑄鐵鍋';
  const create = modal.contentEl.children.at(-1).children.at(-1);
  const cancel = modal.contentEl.children.at(-1).children.at(-2);
  create.click(); await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(topic.disabled, true); assert.equal(context.disabled, true); assert.equal(create.disabled, true); assert.equal(cancel.disabled, true);
  const originalRequestId = submissions[0].requestId;
  rejectSubmit(new Error('temporary failure')); await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(topic.disabled, false); assert.equal(context.disabled, false); assert.equal(create.disabled, false); assert.equal(cancel.disabled, false);
  create.click(); await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(submissions[1].requestId, originalRequestId);
  assert.equal(submissions[1].topic, '牛排'); assert.equal(submissions[1].context, '鑄鐵鍋'); assert.equal(modal.closed, true);
  assert.equal(submissions[1].model, 'gpt-6-luna'); assert.equal(submissions[1].reasoning, 'low');
});
integrationTest('MindSearch answer modal supports multiple choices, exclusive unknown, free text, and retry', async () => {
  const makeElement = (tag, options = {}) => ({ tag, type: options.type, text: options.text ?? '', value: options.value ?? '', cls: options.cls ?? '', checked: false, disabled: false, children: [],
    createDiv(value) { const child = makeElement('div', { cls: typeof value === 'string' ? value : value?.cls }); this.children.push(child); return child; },
    createEl(name, value) { const child = makeElement(name, value); this.children.push(child); return child; }, createSpan(value) { const child = makeElement('span', value); this.children.push(child); return child; },
    setText(value) { this.text = value; }, setAttr(name, value) { this[name] = value; }, focus() {}, addEventListener(name, handler) { this[name] = handler; },
    querySelector(selector) { return selector === 'button:last-child' ? this.children.filter(child => child.tag === 'button').at(-1) : undefined; }
  });
  class Modal { constructor() { this.titleEl = makeElement('title'); this.contentEl = makeElement('content'); } open() { this.onOpen(); } close() { this.closed = true; } }
  class Setting { constructor(root) { this.controlEl = makeElement('setting'); root.children.push(this.controlEl); } addButton(configure) { const button = makeElement('button'); button.setButtonText = value => { button.text = value; return button; }; button.setCta = () => button; button.onClick = handler => { button.click = handler; return button; }; this.controlEl.children.push(button); configure(button); return this; } }
  const all = (root, predicate) => [...(predicate(root) ? [root] : []), ...root.children.flatMap(child => all(child, predicate))];
  const { MindSearchAnswerModal } = load('ui/modals/mind-search-answer-modal.ts', { obsidian: { ...obsidian, Modal, Setting } });
  const answers = []; let rejectFirst;
  const modal = new MindSearchAnswerModal({}, '偏好的熟度？', [{ id: 'red', label: '偏紅' }, { id: 'done', label: '較熟' }, { id: '__mindsearch_unknown__', label: '未知／無偏好' }], input => {
    answers.push(input); if (answers.length === 1) return new Promise((_resolve, reject) => { rejectFirst = reject; }); return Promise.resolve();
  });
  modal.open(); const boxes = all(modal.contentEl, item => item.tag === 'input'), free = all(modal.contentEl, item => item.tag === 'textarea')[0];
  assert.equal(boxes.length, 3); assert.equal(boxes[0]['aria-label'], '偏紅'); assert.equal(free['aria-label'], 'Add details or another answer');
  boxes[0].checked = true; boxes[0].change(); boxes[1].checked = true; boxes[1].change(); boxes[2].checked = true; boxes[2].change();
  assert.equal(boxes[0].checked, false); assert.equal(boxes[1].checked, false); assert.equal(boxes[2].checked, true);
  free.value = '暫時不確定'; free.input(); const button = modal.contentEl.children.at(-1).children.at(-1);
  button.click(); await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(button.disabled, true);
  assert.equal(modal.closed, true, 'submitting closes the blocking modal while research continues in the background');
  rejectFirst(new Error('temporary persistence failure')); await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(modal.closed, true, 'a failed background submission does not reopen the modal'); assert.deepEqual(plain(answers[0].selections), ['__mindsearch_unknown__']); assert.equal(answers[0].freeText, '暫時不確定');
  const firstRequestId = answers[0].requestId;
  const retry = new MindSearchAnswerModal({}, '偏好的熟度？', [{ id: 'red', label: '偏紅' }, { id: 'done', label: '較熟' }, { id: '__mindsearch_unknown__', label: '未知／無偏好' }], input => { answers.push(input); return Promise.resolve(); }, firstRequestId);
  retry.open(); const retryBoxes = all(retry.contentEl, item => item.tag === 'input'), retryButton = retry.contentEl.children.at(-1).children.at(-1);
  retryBoxes[2].checked = true; retryButton.click(); await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(retry.closed, true); assert.equal(answers[1].requestId, firstRequestId, 'reopening after an error can safely retry the same submission identity');
  assert.deepEqual(plain(answers[1].selections), ['__mindsearch_unknown__']);
});
integrationTest('MindSearch start resumes the same Map and Note after a final Map write interruption', async () => {
  const { repo, files } = fixture();
  const { createMindSearchMap } = load('experiences/mind-search/create-map.ts');
  const input = { requestId: 'mindsearch-start-retry-1', topic: '建立家庭緊急聯絡計畫', context: '優先確認離線時可用的聯絡方式。' };
  const saveMap = repo.saveMap.bind(repo); let mapSaves = 0;
  repo.saveMap = async (...args) => { mapSaves++; if (mapSaves === 2) throw new Error('simulated interruption after the root Note was created'); return saveMap(...args); };
  await assert.rejects(createMindSearchMap(repo, 'gpt-6-luna', input), /simulated interruption/);
  repo.saveMap = saveMap;
  const incomplete = (await repo.mapFiles()).map(file => file.path);
  assert.equal(incomplete.length, 1);
  const pendingMap = await repo.readMap(incomplete[0]);
  assert.equal(pendingMap.nodes.length, 0);
  assert.equal(pendingMap.mindSearch.rootDraft.title, input.topic);
  assert.ok(files.has(pendingMap.mindSearch.rootDraft.notePath));

  const resumed = await createMindSearchMap(repo, 'gpt-6-luna', input);
  assert.equal(resumed.mapPath, incomplete[0]);
  assert.equal((await repo.mapFiles()).length, 1);
  const savedMap = await repo.readMap(resumed.mapPath);
  assert.equal(savedMap.nodes.length, 1);
  assert.equal(savedMap.nodes[0].id, pendingMap.mindSearch.rootDraft.nodeId);
  assert.equal(savedMap.mindSearch.rootDraft, undefined);
  const rootNotes = Array.from(files.keys()).filter(path => path.startsWith(`${repo.topicRoot(resumed.mapPath)}/Notes/`));
  assert.equal(rootNotes.length, 1);
  assert.equal((await repo.readNote(resumed.root.path)).detail, `## User-provided context\n\n${input.context}`);
});
integrationTest('MindSearch start reuses only its empty topic folder after the first Map write fails', async () => {
  const { repo, app, files } = fixture();
  const { createMindSearchMap } = load('experiences/mind-search/create-map.ts');
  const input = { requestId: 'mindsearch-empty-folder-retry', topic: '牛排熟度決策', context: '條件會影響建議。' };
  const create = app.vault.create.bind(app.vault); let failMapWrite = true;
  app.vault.create = async (path, content) => {
    if (failMapWrite && path.endsWith('/Map.md')) { failMapWrite = false; throw new Error('simulated first Map write failure'); }
    return create(path, content);
  };
  await assert.rejects(createMindSearchMap(repo, 'gpt-6-luna', input), /simulated first Map write failure/);
  const stranded = files.get('Agent Workspace/Topics/牛排熟度決策');
  assert.ok(stranded); assert.equal(stranded.children.length, 0);
  const resumed = await createMindSearchMap(repo, 'gpt-6-luna', input);
  assert.equal(resumed.mapPath, 'Agent Workspace/Topics/牛排熟度決策/Map.md');
  assert.equal((await repo.mapFiles()).length, 1);
  assert.equal((await repo.readNote(resumed.root.path)).detail, `## User-provided context\n\n${input.context}`);
});
integrationTest('MindSearch Manual Planner question, user answer, research result and outline metadata share one persisted branch', async () => {
  const { repo } = fixture();
  const { createMindSearchMap } = load('experiences/mind-search/create-map.ts');
  const created = await createMindSearchMap(repo, 'gpt-6-luna', { requestId: 'manual-flow-map-1', topic: '在家煎牛排', context: '鑄鐵鍋；沒有烤箱。' });
  const { MindSearchRunStore } = load('mindsearch-mve/research-run-store.ts');
  const { MindSearchManualFlow, MINDSEARCH_UNKNOWN_OPTION_ID } = load('experiences/mind-search/manual-flow.ts');
  let nextId = 0, aiCalls = 0, researchCalls = 0, finishResearch;
  const store = new MindSearchRunStore(repo, () => `manual-store-${++nextId}`, () => '2026-10-05T01:00:00.000Z');
  const flow = new MindSearchManualFlow(repo, store, async context => {
    aiCalls++;
    if (mindSearchPhase(context, 'saved-evidence-review')) return savedEvidenceNeedsSearch();
    if (context.task.includes('Decide whether one missing user condition')) {
      assert.equal(context.mode, 'task');
      return { summary: '你偏好的牛排熟度是什麼？', detail: '熟度會改變烹調建議，應由使用者決定。', suggestions: [{ title: '偏紅', task: '', contribution: '', parentTitle: '' }, { title: '較熟', task: '', contribution: '', parentTitle: '' }], visualReferences: [] };
    }
    if (mindSearchPhase(context, 'research-plan')) return { summary: '食安與烹調方式兩項研究。', detail: '<!-- mindsearch-plan {"subtopics":[{"id":"safety","title":"食安溫度","task":"查詢牛排安全溫度","expectedValue":"確保建議保留安全限制"},{"id":"method","title":"鑄鐵鍋做法","task":"查詢無烤箱時的烹調順序","expectedValue":"給出可操作做法"}]} -->\n兩個不同研究面向。', suggestions: [], visualReferences: [] };
    if (mindSearchPhase(context, 'decision-quality-review')) return auditEcho(context);
    if (mindSearchPhase(context, 'report-review')) return plannerReview('ask_user', { rationale: '在已完成研究後，個人偏好仍會改變最適合的收尾方式。', question: '下一步想深入哪一項？' }, '未知偏好時保留條件式選擇；食安與烹調報告已整理。', '未替使用者猜測熟度；來源界線與限制已保留。', ['食安限制', '烹調細節']);
    assert.equal(context.researchMode, 'research');
    if (!context.task.includes('__mindsearch_unknown__') && !context.task.includes('未知／無偏好')) assert.match(context.task, /偏紅/);
    const result = { summary: '依熟度偏好調整煎製與測溫方式。', detail: '條件式研究報告；來源與不確定性保留。', suggestions: [], visualReferences: [] };
    researchCalls++;
    if (researchCalls === 1) return new Promise(resolve => { finishResearch = () => resolve(result); });
    return result;
  }, () => `manual-flow-${++nextId}`);
  const planned = await flow.planNextQuestion(created.mapPath, created.root.id, 'gpt-6-luna', 'low', 'planner-turn-1');
  assert.equal(planned.status, 'question');
  const repeatedPlan = await flow.planNextQuestion(created.mapPath, created.root.id, 'gpt-6-luna', 'low', 'planner-turn-1');
  assert.equal(repeatedPlan.status, 'question'); assert.equal(repeatedPlan.node.id, planned.node.id); assert.equal(aiCalls, 1);
  const question = planned.node;
  assert.equal(question.mindSearchKind, 'question'); assert.equal(question.mindSearchQuestion.allowMultiple, true); assert.equal(question.mindSearchQuestion.allowFreeText, true);
  assert.equal(question.mindSearchQuestion.options.at(-1).id, MINDSEARCH_UNKNOWN_OPTION_ID);
  const questionNote = await repo.readNote(question.path);
  assert.equal(questionNote.summary, '你偏好的牛排熟度是什麼？'); assert.match(questionNote.prompt, /one concise question/i);

  const answer = { requestId: 'manual-answer-1', selections: question.mindSearchQuestion.options.slice(0, 2).map(option => option.id), freeText: '約 1.5 吋；沒有烤箱。' };
  const first = flow.answerAndResearch(created.mapPath, question.id, answer, 'gpt-6-luna', 'low');
  while (!finishResearch) await new Promise(resolve => setTimeout(resolve, 0));
  const repeated = flow.answerAndResearch(created.mapPath, question.id, answer, 'gpt-6-luna', 'low');
  const finish = finishResearch; finishResearch = undefined; finish();
  const [outcome, repeatedOutcome] = await Promise.all([first, repeated]);
  assert.deepEqual(plain(outcome), plain(repeatedOutcome)); assert.equal(outcome.status, 'waiting-user'); assert.equal(aiCalls, 5, 'initial question, research plan, two independent searches, and report review');
  let savedMap = await repo.readMap(created.mapPath);
  assert.equal(savedMap.mindSearch.branches.length, 1); assert.deepEqual(plain(savedMap.mindSearch.branches[0].answerSnapshot), plain({ selections: answer.selections, freeText: answer.freeText }));
  const firstBranch = savedMap.mindSearch.branches[0];
  assert.equal(firstBranch.results.filter(item => item.kind === 'research').length, 2);
  const resultRef = firstBranch.results.find(item => item.kind === 'synthesis'), resultNode = savedMap.nodes.find(node => node.id === resultRef.nodeId);
  assert.equal(resultNode.mindSearchKind, 'synthesis');
  const report = await repo.readNote(resultRef.notePath); assert.match(report.summary, /未知偏好時保留條件式選擇/); assert.match(report.detail, /來源界線/); assert.match(report.detail, /條件式研究報告/);

  const unknown = { requestId: 'manual-answer-unknown', selections: [MINDSEARCH_UNKNOWN_OPTION_ID], freeText: '' };
  const unknownResult = await flow.answerAndResearch(created.mapPath, question.id, unknown, 'gpt-6-luna', 'low');
  assert.equal(unknownResult.status, 'waiting-user');
  savedMap = await repo.readMap(created.mapPath); assert.equal(savedMap.mindSearch.branches.length, 2);
  assert.deepEqual(plain(savedMap.mindSearch.branches[1].answerSnapshot), { selections: unknown.selections, freeText: unknown.freeText });
});
integrationTest('MindSearch saved synthesis can create a distinct local-only question with saved lineage and duplicate protection', async () => {
  const { repo } = fixture();
  const { createMindSearchMap } = load('experiences/mind-search/create-map.ts');
  const created = await createMindSearchMap(repo, 'gpt-6-luna', { requestId: 'new-question-from-result-map', topic: 'Synthetic cooking plan', context: 'Use a cast-iron pan; no oven.' });
  const { MindSearchRunStore } = load('mindsearch-mve/research-run-store.ts');
  const { MindSearchManualFlow } = load('experiences/mind-search/manual-flow.ts');
  const store = new MindSearchRunStore(repo); let id = 0;
  const originalQuestionFlow = new MindSearchManualFlow(repo, store, async () => ({ summary: 'Which doneness do you prefer?', detail: 'Synthetic initial question.', suggestions: [{ title: 'Pink' }, { title: 'Well done' }], visualReferences: [] }));
  const originalQuestion = (await originalQuestionFlow.planNextQuestion(created.mapPath, created.root.id, 'gpt-6-luna', 'low', 'new-question-source-initial')).node;
  const branch = await store.createAnswerBranch(created.mapPath, { requestId: 'new-question-source-answer', questionNodeId: originalQuestion.id, parentBranchId: null, answerSnapshot: { selections: [originalQuestion.mindSearchQuestion.options[0].id], freeText: 'Synthetic answer.' }, inputSnapshot: { topic: created.map.title, conditions: { equipment: 'Cast-iron pan; no oven.', preference: 'Synthetic pink doneness choice.' }, upstreamResults: [] } });
  const plan = [{ id: 'safety', title: 'Food safety', task: 'Persist synthetic safety evidence.', expectedValue: 'Keep the method safe.' }, { id: 'method', title: 'Pan method', task: 'Persist synthetic pan evidence.', expectedValue: 'Give a practical method.' }];
  await store.saveResearchPlan(created.mapPath, branch.id, plan);
  const researchHandle = await store.startAttempt(created.mapPath, branch.id, 'new-question-saved-research');
  await store.recordResearchTurn(created.mapPath, researchHandle);
  const researchDraft = (await store.createResultDraft(created.mapPath, researchHandle, 'Saved food safety report', 'gpt-6-luna', 'low', { kind: 'research', subtopicId: 'safety' })).draft;
  await store.updateResultDraftReport(created.mapPath, researchHandle, researchDraft.id, 'Synthetic report: use a thermometer and observe the safe temperature.', 'Persisted report body: keep the safety threshold visible and explain uncertainty.');
  await store.commitResult(created.mapPath, researchHandle, researchDraft.id, { summary: 'Synthetic saved safety report.', detail: 'Persisted report body: keep the safety threshold visible and explain uncertainty.' });
  store.releaseAttempt(created.mapPath, researchHandle);
  const synthesisHandle = await store.startAttempt(created.mapPath, branch.id, 'new-question-saved-synthesis');
  const synthesisDraft = (await store.createResultDraft(created.mapPath, synthesisHandle, 'Saved synthesis', 'gpt-6-luna', 'low', { kind: 'synthesis' })).draft;
  await store.commitResult(created.mapPath, synthesisHandle, synthesisDraft.id, { summary: 'Synthetic method summary.', detail: 'Use the saved safety report and user conditions; leave preference tradeoffs explicit.' });
  store.releaseAttempt(created.mapPath, synthesisHandle);
  const saved = await repo.readMap(created.mapPath), resultRef = saved.mindSearch.branches.find(item => item.id === branch.id).results.find(item => item.kind === 'synthesis');
  const resultNode = saved.nodes.find(item => item.id === resultRef.nodeId);
  const synthesisRun = saved.mindSearch.runs.find(item => item.id === resultRef.runId), synthesisAttempt = synthesisRun.attempts.find(item => item.id === resultRef.attemptId);
  synthesisAttempt.status = 'completed';
  synthesisAttempt.plannerReviews = [{ decision: 'ask_user', researchTurn: 1, question: 'Which part would you like to explore next?', rationale: 'The saved report supports more than one useful next direction.', answerOptions: ['Safety', 'Technique'] }];
  await repo.saveMap(created.mapPath, saved);
  const reviewRecovery = new MindSearchManualFlow(repo, store, async () => { throw new Error('Recovery must use the persisted Planner review.'); });
  assert.equal(await reviewRecovery.recoverPostReportQuestions(created.mapPath), 1, 'the persisted report review creates its original follow-up question');
  let beforeDismiss = await repo.readMap(created.mapPath);
  const dismissed = beforeDismiss.nodes.find(item => item.mindSearchQuestion?.requestId === `post-${resultRef.runId}-${resultRef.attemptId}`);
  assert.ok(dismissed); const branchResultsBeforeDelete = plain(beforeDismiss.mindSearch.branches.find(item => item.id === branch.id).results);
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const deletionView = new VisualAgentMapView({ app: {} }, { repo, settings: { ...DEFAULT_SETTINGS } });
  const deletedNodeIds = new Set([dismissed.id]), originalNodesBeforeDelete = beforeDismiss.nodes;
  beforeDismiss.nodes = beforeDismiss.nodes.filter(item => !deletedNodeIds.has(item.id));
  deletionView.removeMindSearchReferences(beforeDismiss, deletedNodeIds, originalNodesBeforeDelete);
  await repo.saveMap(created.mapPath, beforeDismiss);
  assert.equal(await reviewRecovery.recoverPostReportQuestions(created.mapPath), 0, 'reload recovery respects an explicitly dismissed question');
  const afterDismiss = await repo.readMap(created.mapPath);
  assert.equal(afterDismiss.nodes.some(item => item.id === dismissed.id), false);
  assert.deepEqual(plain(afterDismiss.mindSearch.branches.find(item => item.id === branch.id).results), branchResultsBeforeDelete, 'dismissing the question preserves its answer branch and saved results');
  let modelCalls = 0, releasePlanner;
  const planner = new MindSearchManualFlow(repo, store, async context => {
    modelCalls++;
    const response = new Promise(resolve => { releasePlanner = () => resolve({ summary: 'How much hands-on guidance would you like?', detail: 'Synthetic new question based on the saved report.', suggestions: [{ title: 'Step-by-step' }, { title: 'Brief overview' }], visualReferences: [] }); });
    assert.equal(context.mode, 'task'); assert.equal(context.researchMode, 'local');
    assert.match(context.task, /new follow-up question/i); assert.match(context.task, /cast-iron pan/i);
    assert.match(context.task, /Which doneness do you prefer/); assert.match(context.task, /Which part would you like to explore next/); assert.match(context.task, /Synthetic saved safety report/);
    assert.match(context.task, /Cast-iron pan; no oven/);
    assert.equal(context.mindSearchEvidenceIds.length, 2, 'every saved branch result is available to the local Planner');
    return response;
  }, () => `new-question-id-${++id}`);
  const first = planner.planNextQuestion(created.mapPath, resultNode.id, 'gpt-6-luna', 'low', 'new-question-from-saved-result', branch.id);
  while (!releasePlanner) await new Promise(resolve => setTimeout(resolve, 0));
  const duplicateClick = planner.planNextQuestion(created.mapPath, resultNode.id, 'gpt-6-luna', 'low', 'new-question-from-saved-result', branch.id);
  releasePlanner();
  const [generated, duplicate] = await Promise.all([first, duplicateClick]);
  assert.equal(generated.status, 'question'); assert.equal(duplicate.node.id, generated.node.id); assert.equal(modelCalls, 1);
  assert.notEqual((await repo.readNote(generated.node.path)).summary, (await repo.readNote(dismissed.path)).summary, 'the new request generates a fresh question rather than reviving the dismissed one');
  assert.equal(generated.node.parentId, resultNode.id); assert.equal(generated.node.mindSearchQuestion.parentBranchId, branch.id);
  assert.equal(generated.options.filter(option => option.id !== '__mindsearch_unknown__').length, 2);
  assert.equal((await repo.readMap(created.mapPath)).nodes.filter(node => node.mindSearchQuestion?.requestId === 'new-question-from-saved-result').length, 1);
  const noRepeatPlanner = new MindSearchManualFlow(repo, store, async () => ({ summary: 'Which doneness do you prefer?', detail: 'Must be rejected as an existing question.', suggestions: [{ title: 'Pink' }, { title: 'Well done' }], visualReferences: [] }));
  await assert.rejects(noRepeatPlanner.planNextQuestion(created.mapPath, resultNode.id, 'gpt-6-luna', 'low', 'new-question-repeat-existing', branch.id), /repeated an existing question/);
  assert.equal((await repo.readMap(created.mapPath)).nodes.filter(node => node.parentId === resultNode.id && node.mindSearchKind === 'question').length, 1);
  let releaseStale;
  const stalePlanner = new MindSearchManualFlow(repo, store, async () => new Promise(resolve => { releaseStale = () => resolve({ summary: 'Should not be saved after branch changes?', detail: 'Synthetic stale output.', suggestions: [{ title: 'First' }, { title: 'Second' }], visualReferences: [] }); }));
  const staleResultPlan = stalePlanner.planNextQuestion(created.mapPath, resultNode.id, 'gpt-6-luna', 'low', 'new-question-stale-snapshot', branch.id);
  while (!releaseStale) await new Promise(resolve => setTimeout(resolve, 0));
  const changedMap = await repo.readMap(created.mapPath);
  changedMap.mindSearch.branches.find(item => item.id === branch.id).inputSnapshot.conditions.latestUserCondition = 'Changed in another view.';
  await repo.saveMap(created.mapPath, changedMap);
  releaseStale();
  await assert.rejects(staleResultPlan, /saved answer or research changed/);
  assert.equal((await repo.readMap(created.mapPath)).nodes.some(node => node.mindSearchQuestion?.requestId === 'new-question-stale-snapshot'), false, 'stale Planner output never writes a question');
});
integrationTest('captured malformed partial Planner replies recover once from the saved report without searching again or replacing the seed', async () => {
  const { MindSearchRunStore } = load('mindsearch-mve/research-run-store.ts');
  const { MindSearchManualFlow } = load('experiences/mind-search/manual-flow.ts');
  const { createMindSearchMap } = load('experiences/mind-search/create-map.ts');
  const capturedCases = [
    {
      name: 'ask_user without choices',
      file: 'ask_user_missing_options.json',
      recovery: plannerReview('ask_user', { rationale: 'A real preference is missing from this synthetic branch and cannot be inferred.', question: 'Which doneness should the next answer optimize for?' }, 'The method is supported conditionally; choose the desired doneness.', 'The existing evidence cannot choose for the user.', ['Three-quarter', 'Well done']),
      outcome: 'waiting-user'
    },
    {
      name: 'answer without marker',
      file: 'planner_missing_marker.json',
      recovery: plannerReview('ask_user', { rationale: 'The stored evidence does not establish a decision-relevant preference.', question: 'Which constraint should the next answer prioritize?' }, 'Preserve the useful conditional answer while the missing preference remains unknown.', 'Do not infer preferences beyond the saved synthetic answer.', ['Time available', 'Equipment available']),
      outcome: 'waiting-user'
    }
  ];
  for (const [index, scenario] of capturedCases.entries()) {
    const captured = JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/mindsearch', scenario.file), 'utf8'));
    const { repo, contents } = fixture();
    const created = await createMindSearchMap(repo, 'gpt-6-luna', { requestId: `format-recovery-${index}`, topic: `Synthetic format recovery ${scenario.name}`, context: 'Synthetic test only; do not infer a real preference.' });
    const store = new MindSearchRunStore(repo);
    const questionPlanFlow = new MindSearchManualFlow(repo, store, async context => {
      assert.match(context.task, /Plan the next Manual MindSearch interaction/);
      return { summary: 'Which doneness?', detail: 'A synthetic answer will be provided.', suggestions: [{ title: 'Three-quarter' }, { title: 'Well done' }], visualReferences: [] };
    });
    const planned = await questionPlanFlow.planNextQuestion(created.mapPath, created.root.id, 'gpt-6-luna', 'low', `question-${index}`);
    const questionNote = await repo.readNote(planned.node.path), selected = planned.options[0];
    const branch = await store.createAnswerBranch(created.mapPath, { requestId: `answer-${index}`, questionNodeId: planned.node.id, parentBranchId: null, answerSnapshot: { selections: [selected.id], freeText: 'Synthetic test condition; not a real user preference.' }, inputSnapshot: { topic: created.map.title, conditions: { [questionNote.summary]: `${selected.label}; explicitly synthetic.` }, upstreamResults: [] } });
    await seedCoverageAncestors(repo, created.mapPath, branch.id);
    const savedResearchNodeIds = [];
    if (index === 0) {
      const savedMap = await repo.readMap(created.mapPath), savedBranch = savedMap.mindSearch.branches.find(item => item.id === branch.id);
      savedBranch.researchPlan = [{ id: 'saved-subtopic', title: 'Saved subtopic', task: 'Persist a synthetic prior subtopic report.', expectedValue: 'Exercise continuation convergence.' }];
      await repo.saveMap(created.mapPath, savedMap);
      const researchHandle = await store.startAttempt(created.mapPath, branch.id, `saved-subtopic-run-${index}`, { model: 'gpt-6-luna', reasoning: 'low', maxResearchTurns: 1 });
      await store.recordResearchTurn(created.mapPath, researchHandle);
      const researchDraft = await store.createResultDraft(created.mapPath, researchHandle, 'Saved subtopic report', 'gpt-6-luna', 'low', { kind: 'research', subtopicId: 'saved-subtopic' });
      assert.equal(researchDraft.status, 'ready');
      await store.updateResultDraftReport(created.mapPath, researchHandle, researchDraft.draft.id, 'Previously saved research summary.', 'Previously saved research detail.');
      const researchResult = await store.commitResult(created.mapPath, researchHandle, researchDraft.draft.id, { summary: 'Previously saved research summary.', detail: 'Previously saved research detail.' });
      assert.equal(researchResult.status, 'committed');
      const afterResearch = await repo.readMap(created.mapPath), branchAfterResearch = afterResearch.mindSearch.branches.find(item => item.id === branch.id);
      savedResearchNodeIds.push(branchAfterResearch.results.find(item => item.resultId === researchResult.resultId).nodeId);
    }
    const runId = `partial-format-run-${index}`, initialHandle = await store.startAttempt(created.mapPath, branch.id, runId, { model: 'gpt-6-luna', reasoning: 'low', maxResearchTurns: 2 });
    await store.recordResearchTurn(created.mapPath, initialHandle);
    const seedDraft = await store.createResultDraft(created.mapPath, initialHandle, 'Synthetic partial seed', 'gpt-6-luna', 'low', { kind: 'synthesis' });
    assert.equal(seedDraft.status, 'ready');
    const seedText = 'Fixture only: a decision-relevant method remains unanswered before continuation.';
    const seedDetail = 'Synthetic partial result. No research is claimed by this fixture.';
    await store.updateResultDraftReport(created.mapPath, initialHandle, seedDraft.draft.id, seedText, seedDetail);
    await store.recordPlannerReview(created.mapPath, initialHandle, { decision: 'research_more', rationale: 'The synthetic seed leaves one material method gap.', researchTurn: 1, researchTarget: { title: 'Targeted method', task: 'Find one report for the stated synthetic conditions.', expectedValue: 'Could materially improve the conditional answer.' } }, 'Synthetic partial seed; continuation not yet run.');
    const seed = await store.commitResult(created.mapPath, initialHandle, seedDraft.draft.id, { summary: seedText, detail: seedDetail }, 'partial');
    assert.equal(seed.status, 'committed');
    const seedBytesBefore = contents.get(seed.notePath);
    const calls = []; let searchCalls = 0, localPlannerCalls = 0;
    const continuation = new MindSearchManualFlow(repo, store, async (context, model, reasoning, signal, onWebSearchEvent) => {
      calls.push({ context, model, reasoning });
      assert.equal(model, 'gpt-6-luna'); assert.equal(reasoning, 'low');
      const delivery = deliveryFixture(context); if (delivery) return delivery;
      if (mindSearchPhase(context, 'research-gap-audit')) return researchGapAudit('external_evidence', 'The target is a source-backed method fact that can be checked externally.');
      if (context.researchMode === 'research') {
        searchCalls++;
        onWebSearchEvent?.({ method: 'item/started', params: { item: { action: { type: 'search' } } } });
        onWebSearchEvent?.({ method: 'item/completed', params: { item: { action: { type: 'search' } } } });
        return { summary: 'Persisted report used by both Planner passes.', detail: 'Research status: search completed\nExact saved report content for this test.', suggestions: [], visualReferences: [] };
      }
      localPlannerCalls++;
      if (localPlannerCalls === 1) return captured.result;
      assert.match(context.task, /Format validation error:/);
      if (/mindsearch-review/.test(captured.result.detail)) {
        assert.match(context.task, /Repair only the missing answer choices/);
        assert.match(context.task, /Original question:/);
        assert.doesNotMatch(context.task, /Exact saved report content for this test/);
      } else {
        assert.match(context.task, /Already completed report detail:[\s\S]*Exact saved report content for this test\./);
        assert.match(context.task, /Original Planner response to review/);
        assert.match(context.task, /Do not search, repeat research, add evidence, or invent facts/);
      }
      return scenario.recovery;
    });
    const outcome = await continuation.continuePartial(created.mapPath, runId, 'gpt-6-luna', 'low');
    assert.equal(outcome.status, scenario.outcome, `${scenario.name} should be repaired into a valid product decision`);
    assert.equal(searchCalls, 1, 'format recovery must reuse the already persisted report instead of repeating Searcher');
    assert.equal(localPlannerCalls, 2, 'allow exactly one Planner format-recovery invocation');
    assert.deepEqual(calls.filter(call => !deliveryFixture(call.context)).map(call => call.context.researchMode), ['local', 'research', 'local', 'local']);
    assert.equal(contents.get(seed.notePath), seedBytesBefore, 'the prior partial result Note must remain byte-for-byte unchanged');
    const savedMap = await repo.readMap(created.mapPath), savedBranch = savedMap.mindSearch.branches.find(item => item.id === branch.id), savedRun = savedMap.mindSearch.runs.find(item => item.id === runId), attempt = savedRun.attempts.at(-1);
    assert.equal(savedBranch.results.length, 2 + savedResearchNodeIds.length); assert.ok(savedBranch.results.some(item => item.resultId === seed.resultId));
    const continuationResult = savedBranch.results.find(item => item.runId === runId && item.attemptId === attempt.id && item.kind === 'synthesis');
    const continuationNode = savedMap.nodes.find(item => item.id === continuationResult.nodeId);
    if (savedResearchNodeIds.length) {
      assert.equal(continuationNode.parentId, savedResearchNodeIds.at(-1), 'continued synthesis uses the latest saved research node as its parent');
      assert.deepEqual(plain(continuationNode.mindSearchConvergesFromNodeIds), savedResearchNodeIds, 'continued synthesis links to all saved research nodes');
    } else {
      assert.equal(continuationNode.parentId, branch.questionNodeId, 'legacy continuation without research keeps the question as parent');
      assert.equal(continuationNode.mindSearchConvergesFromNodeIds, undefined, 'legacy continuation does not invent convergence sources');
    }
    const pendingQuestion = outcome.status === 'waiting-user' ? savedMap.nodes.find(item => item.id === outcome.questionNodeId) : undefined;
    if (pendingQuestion) assert.equal(pendingQuestion.parentId, continuationNode.id, 'the user question remains attached to its continuation result');
    assert.equal(attempt.status, 'completed'); assert.equal(attempt.researchTurns, 1); assert.equal(attempt.searchDiagnostics.length, 1); assert.equal(attempt.searchDiagnostics[0].completedSearchActions, 1);
    assert.deepEqual(plain(attempt.plannerReviews.map(item => item.decision)), [scenario.outcome === 'waiting-user' ? 'ask_user' : 'conclude']);
    assert.equal(savedMap.mindSearch.pendingCommits.length, 0); assert.equal(savedMap.mindSearch.resultDrafts.length, 0);
  }
});
integrationTest('partial continuation asks about missing user conditions before starting another search', async () => {
  const { MindSearchRunStore } = load('mindsearch-mve/research-run-store.ts');
  const { MindSearchManualFlow } = load('experiences/mind-search/manual-flow.ts');
  const { createMindSearchMap } = load('experiences/mind-search/create-map.ts');
  const { repo } = fixture();
  const created = await createMindSearchMap(repo, 'gpt-6-luna', { requestId: 'partial-user-condition-map', topic: 'Synthetic roast chicken', context: 'Synthetic regression only.' });
  const store = new MindSearchRunStore(repo);
  const planned = await new MindSearchManualFlow(repo, store, async () => ({ summary: 'What serving time?', detail: 'Synthetic question.', suggestions: [{ title: 'Evening' }, { title: 'Lunch' }], visualReferences: [] })).planNextQuestion(created.mapPath, created.root.id, 'gpt-6-luna', 'low', 'partial-user-condition-question');
  const branch = await store.createAnswerBranch(created.mapPath, { requestId: 'partial-user-condition-answer', questionNodeId: planned.node.id, parentBranchId: null, answerSnapshot: { selections: [], freeText: 'Synthetic constraints only.' }, inputSnapshot: { topic: 'Synthetic roast chicken', conditions: { 'Serving time': 'evening; synthetic' }, upstreamResults: [] } });
  const original = await store.startAttempt(created.mapPath, branch.id, 'partial-user-condition-run', { model: 'gpt-6-luna', reasoning: 'low', maxResearchTurns: 2 });
  await store.recordResearchTurn(created.mapPath, original);
  const seedDraft = (await store.createResultDraft(created.mapPath, original, 'Earlier partial report', 'gpt-6-luna', 'low', { kind: 'synthesis' })).draft;
  await store.updateResultDraftReport(created.mapPath, original, seedDraft.id, 'The saved research covers seasoning but needs a serving estimate.', 'Persisted summary: research supports seasoning options. The serving-time constraint is stated in this branch; chicken weight is absent from this branch and cannot be discovered through web research.');
  await store.recordPlannerReview(created.mapPath, original, { decision: 'research_more', rationale: 'A weight-specific estimate requires the user’s actual chicken weight, which is not in branch conditions.', researchTurn: 1, researchTarget: { title: 'Chicken weight', task: 'Find a cooking time for this chicken.', expectedValue: 'Could improve the serving estimate.' } }, 'The saved research supports seasoning but lacks a user-provided weight.');
  const seed = await store.commitResult(created.mapPath, original, seedDraft.id, { summary: 'The saved research covers seasoning but needs a serving estimate.', detail: 'Persisted summary: research supports seasoning options. The serving-time constraint is stated in this branch; chicken weight is absent from this branch and cannot be discovered through web research.' }, 'partial');
  const calls = []; let searches = 0;
  const continuation = new MindSearchManualFlow(repo, store, async context => {
    calls.push(context);
    if (context.researchMode === 'research') { searches++; throw new Error('User-specific weight must not start a Searcher call.'); }
    assert.equal(context.researchMode, 'local');
    if (mindSearchPhase(context, 'research-gap-audit')) return researchGapAudit('user_condition', 'The missing actual chicken weight is a user-specific cooking condition.');
    assert.ok(mindSearchPhase(context, 'decision-quality-review'), `unexpected phase ${context.task.slice(0, 100)}`);
    return plannerReview('ask_user', { rationale: 'The saved evidence can support a conditional answer, but the user’s actual chicken weight is needed for a useful estimate.', question: 'What is the chicken’s approximate weight?', }, 'Keep the saved seasoning guidance and ask only for the missing user-specific condition.', 'Do not infer a chicken weight from research.', ['About 1.2 kg', 'About 1.5 kg', 'About 2 kg']);
  });
  const outcome = await continuation.continuePartial(created.mapPath, 'partial-user-condition-run', 'gpt-6-luna', 'low');
  assert.equal(searches, 0); assert.deepEqual(calls.map(context => mindSearchPhase(context, 'research-gap-audit') ? 'audit' : 'repair'), ['audit', 'repair']);
  assert.equal(outcome.status, 'waiting-user');
  const saved = await repo.readMap(created.mapPath), savedBranch = saved.mindSearch.branches.find(item => item.id === branch.id), run = saved.mindSearch.runs.find(item => item.id === 'partial-user-condition-run');
  assert.ok(savedBranch.results.some(item => item.resultId === seed.resultId), 'the prior partial result remains attached');
  assert.equal(savedBranch.results.length, 2, 'continuation adds its question result without replacing the saved partial');
  assert.equal(run.attempts.at(-1).searchDiagnostics?.length ?? 0, 0, 'no Searcher call or telemetry is created for a user condition');
  assert.equal(run.attempts.at(-1).plannerReviews.at(-1).decision, 'ask_user');
  const question = saved.nodes.find(item => item.id === outcome.questionNodeId);
  assert.equal(question.mindSearchKind, 'question'); assert.equal(question.parentId, savedBranch.results.at(-1).nodeId);
  assert.match((await repo.readNote(question.path)).summary, /What is the chicken’s approximate weight\?/);
});
integrationTest('partial continuation invalid repair and cancellation retain only the earlier partial result', async () => {
  const { MindSearchRunStore } = load('mindsearch-mve/research-run-store.ts');
  const { MindSearchManualFlow } = load('experiences/mind-search/manual-flow.ts');
  const { createMindSearchMap } = load('experiences/mind-search/create-map.ts');
  const malformed = { summary: 'Planner text without a decision block.', detail: 'No machine-readable marker.', suggestions: [], visualReferences: [] };
  for (const kind of ['invalid-repair', 'cancel-repair']) {
    const { repo, contents } = fixture();
    const created = await createMindSearchMap(repo, 'gpt-6-luna', { requestId: `partial-recovery-${kind}`, topic: `Synthetic partial recovery ${kind}`, context: 'Synthetic-only regression input.' });
    const store = new MindSearchRunStore(repo);
    const questionFlow = new MindSearchManualFlow(repo, store, async () => ({ summary: 'Which synthetic doneness?', detail: 'Test fixture only.', suggestions: [{ title: 'Medium rare' }, { title: 'Follow safety guidance' }], visualReferences: [] }));
    const planned = await questionFlow.planNextQuestion(created.mapPath, created.root.id, 'gpt-6-luna', 'low', `partial-question-${kind}`);
    const questionNote = await repo.readNote(planned.node.path), selected = planned.options[0];
    const branch = await store.createAnswerBranch(created.mapPath, { requestId: `partial-answer-${kind}`, questionNodeId: planned.node.id, parentBranchId: null, answerSnapshot: { selections: [selected.id], freeText: 'Synthetic answer only.' }, inputSnapshot: { topic: created.map.title, conditions: { [questionNote.summary]: `${selected.label}; synthetic only` }, upstreamResults: [] } });
    const runId = `partial-recovery-run-${kind}`, initial = await store.startAttempt(created.mapPath, branch.id, runId, { model: 'gpt-6-luna', reasoning: 'low', maxResearchTurns: 2 });
    await store.recordResearchTurn(created.mapPath, initial);
    const seedDraft = await store.createResultDraft(created.mapPath, initial, 'Earlier synthetic partial', 'gpt-6-luna', 'low', { kind: 'synthesis' });
    await store.updateResultDraftReport(created.mapPath, initial, seedDraft.draft.id, 'Earlier partial seed.', 'Synthetic seed; the central method question remains unresolved.');
    await store.recordPlannerReview(created.mapPath, initial, { decision: 'research_more', rationale: 'The seed retains a material synthetic evidence gap.', researchTurn: 1, researchTarget: { title: 'One target', task: 'Search only this synthetic target.', expectedValue: 'Could change the conditional answer.' } }, 'Partial seed; continuation has not run.');
    const seed = await store.commitResult(created.mapPath, initial, seedDraft.draft.id, { summary: 'Earlier partial seed.', detail: 'Synthetic seed; the central method question remains unresolved.' }, 'partial');
    assert.equal(seed.status, 'committed');
    const seedNoteBefore = contents.get(seed.notePath);
    const abort = new AbortController(); let repairStarted;
    const repairGate = new Promise(resolve => { repairStarted = resolve; });
    const calls = []; let searches = 0, planners = 0;
    const flow = new MindSearchManualFlow(repo, store, async (context, model, reasoning, signal, onWebSearchEvent) => {
      calls.push(context); assert.equal(model, 'gpt-6-luna'); assert.equal(reasoning, 'low');
      if (mindSearchPhase(context, 'research-gap-audit')) return researchGapAudit('external_evidence', 'The target is a distinct externally verifiable method fact.');
      if (context.researchMode === 'research') {
        searches++;
        onWebSearchEvent?.({ method: 'item/started', params: { item: { action: { type: 'search' } } } });
        onWebSearchEvent?.({ method: 'item/completed', params: { item: { action: { type: 'search' } } } });
        return { summary: 'Persisted continuation report.', detail: 'Research status: search completed\nSynthetic result retained for this recovery test.', suggestions: [], visualReferences: [] };
      }
      planners++;
      if (planners === 1) return malformed;
      assert.match(context.task, /Make one local format-repair review/);
      assert.match(context.task, /Do not search, repeat research, add evidence, or invent facts/);
      if (kind === 'cancel-repair') return new Promise((resolve, reject) => { repairStarted(); signal.addEventListener('abort', () => { const error = new Error('Synthetic partial repair cancelled.'); error.name = 'AbortError'; reject(error); }, { once: true }); });
      return malformed;
    });
    const request = flow.continuePartial(created.mapPath, runId, 'gpt-6-luna', 'low', kind === 'cancel-repair' ? abort.signal : undefined);
    if (kind === 'cancel-repair') { await repairGate; abort.abort(); await assert.rejects(request, error => error?.name === 'AbortError'); }
    else await assert.rejects(request, /missing its machine-readable decision block/);
    const saved = await repo.readMap(created.mapPath), savedBranch = saved.mindSearch.branches.find(item => item.id === branch.id), savedRun = saved.mindSearch.runs.find(item => item.id === runId), current = savedRun.attempts.find(item => item.id === savedRun.currentAttemptId);
    assert.equal(searches, 1, 'the new continuation performs its one planned Searcher turn; format repair adds none');
    assert.equal(planners, 2, 'partial continuation permits one initial Planner and one repair only');
    assert.deepEqual(calls.map(item => item.researchMode), ['local', 'research', 'local', 'local']);
    assert.equal(current.status, kind === 'cancel-repair' ? 'cancelled' : 'failed');
    assert.equal(savedBranch.results.length, 1, 'the prior partial remains the only published result');
    assert.equal(savedBranch.results[0].resultId, seed.resultId);
    assert.equal(contents.get(seed.notePath), seedNoteBefore, 'the prior partial Note remains byte-for-byte unchanged');
    assert.equal(saved.mindSearch.pendingCommits.length, 0); assert.equal(saved.mindSearch.resultDrafts.length, 0);
    const diagnosticPaths = repo.app.vault.getMarkdownFiles().map(file => file.path).filter(filePath => filePath.includes('/Notes/'));
    const diagnostics = await Promise.all(diagnosticPaths.map(filePath => repo.readNote(filePath)));
    assert.ok(diagnostics.some(note => note.status === 'error' && note.detail.includes('MindSearch incomplete-attempt diagnostic')), 'the failed/cancelled new attempt remains unpublished diagnostic material');
  }
});
integrationTest('native RunStore failed Searcher diagnostic enables the saved-report retry action only with completed-search telemetry', async () => {
  const { MindSearchRunStore } = load('mindsearch-mve/research-run-store.ts');
  const { MindSearchManualFlow } = load('experiences/mind-search/manual-flow.ts');
  const { repo, app, mapPath, question, store } = await mindSearchMapFixture();
  let map = await repo.readMap(mapPath), questionNode = map.nodes.find(item => item.id === question.id);
  questionNode.mindSearchKind = 'question';
  questionNode.mindSearchQuestion = { requestId: 'native-retry-question', parentBranchId: null, options: [{ id: 'a', label: 'Synthetic A' }, { id: 'b', label: 'Synthetic B' }], allowMultiple: false, allowFreeText: true };
  await repo.saveMap(mapPath, map);
  const branch = await store.createAnswerBranch(mapPath, { requestId: 'native-retry-branch', questionNodeId: question.id, parentBranchId: null, answerSnapshot: { selections: [], freeText: 'Synthetic scenario only.' }, inputSnapshot: { topic: 'Synthetic topic', conditions: { provenance: 'synthetic fixture' }, upstreamResults: [] } });
  const handle = await store.startAttempt(mapPath, branch.id, 'native-retry-run', { model: 'gpt-6-luna', reasoning: 'low', maxResearchTurns: 1 });
  await store.recordResearchTurn(mapPath, handle);
  const draft = (await store.createResultDraft(mapPath, handle, 'Synthetic saved report', 'gpt-6-luna', 'low')).draft;
  const report = { summary: 'Synthetic report summary.', detail: 'Research status: search completed\n\n### Findings\nPersisted report content; synthetic contract fixture only.' };
  await store.updateResultDraftReport(mapPath, handle, draft.id, `Report 1: ${report.summary}`, `## Searcher report 1\n\n${report.detail}`);
  await store.recordSearchDiagnostic(mapPath, handle, { researchTurn: 1, startedEvents: 1, completedEvents: 1, completedSearchActions: 1, otherCompletedActions: 0 });
  await store.failAttempt(mapPath, handle, 'Synthetic contract fixture: Planner response was invalid.');
  const diagnosticBefore = await repo.readNote(draft.notePath);
  assert.match(diagnosticBefore.detail, /MindSearch incomplete-attempt diagnostic/);
  assert.match(diagnosticBefore.detail, /## Searcher report 1/);

  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const calls = [];
  const view = new VisualAgentMapView({ app }, { repo, settings: { ...DEFAULT_SETTINGS, language: 'en' }, mutate: async work => work(), syncOutline() {}, askModel: async context => {
    calls.push(context);
    assert.equal(context.researchMode, 'local', 'reviewing a retained report does not repeat its search');
    return plannerReview('ask_user', { rationale: 'The retained report supports only a conditional answer, while the requested preference is still unknown.', question: 'Which option should the result prioritize?' }, 'Keep the saved report conditional until the user chooses.', 'Do not infer a preference from a failed Searcher attempt.', ['Option A', 'Option B']);
  } });
  view.path = mapPath; view.map = await repo.readMap(mapPath); view.render = () => {};
  await view.hydrateFailedReportTargets(() => true);
  assert.equal(view.mindSearchFailedReports.get(question.id)?.diagnosticNotePath, draft.notePath, 'the authentic RunStore diagnostic becomes the target for the retry action');
  await view.retryMindSearchFromSavedReport(question.id);
  const reopened = new Repository(app, repo.settings), after = await reopened.readMap(mapPath);
  const savedRun = after.mindSearch.runs.find(item => item.id === 'native-retry-run');
  assert.equal(savedRun.attempts[0].status, 'failed');
  assert.equal(savedRun.attempts[1].status, 'completed');
  assert.equal(calls.length, 1, 'the saved-report retry uses one Planner review');
  assert.equal((await reopened.readNote(draft.notePath)).detail, diagnosticBefore.detail, 'the original diagnostic remains byte-for-byte unchanged');

  const zeroSearch = await mindSearchMapFixture();
  const zeroBranch = await zeroSearch.store.createAnswerBranch(zeroSearch.mapPath, { requestId: 'native-retry-no-search', questionNodeId: zeroSearch.question.id, parentBranchId: null, answerSnapshot: { selections: [], freeText: 'Synthetic only.' }, inputSnapshot: { topic: 'Synthetic topic', conditions: {}, upstreamResults: [] } });
  const zeroHandle = await zeroSearch.store.startAttempt(zeroSearch.mapPath, zeroBranch.id, 'native-no-search-run');
  await zeroSearch.store.recordResearchTurn(zeroSearch.mapPath, zeroHandle);
  const zeroDraft = (await zeroSearch.store.createResultDraft(zeroSearch.mapPath, zeroHandle, 'No-search diagnostic', 'gpt-6-luna')).draft;
  await zeroSearch.store.updateResultDraftReport(zeroSearch.mapPath, zeroHandle, 'Report 1: Not searched.', '## Searcher report 1\n\nResearch status: not searched.');
  await zeroSearch.store.recordSearchDiagnostic(zeroSearch.mapPath, zeroHandle, { researchTurn: 1, startedEvents: 0, completedEvents: 0, completedSearchActions: 0, otherCompletedActions: 0 });
  await zeroSearch.store.failAttempt(zeroSearch.mapPath, zeroHandle, 'Synthetic no-search fixture.');
  const { matchMindSearchFailedReportTargets } = load('experiences/mind-search/retry-targets.ts');
  map = await zeroSearch.repo.readMap(zeroSearch.mapPath);
  assert.equal(matchMindSearchFailedReportTargets(map, [{ path: zeroDraft.notePath, note: await zeroSearch.repo.readNote(zeroDraft.notePath) }]).size, 0, 'a failed diagnostic without completed-search telemetry is never offered as a saved-report retry');

  const ambiguous = await mindSearchMapFixture();
  map = await ambiguous.repo.readMap(ambiguous.mapPath);
  const secondQuestion = await ambiguous.repo.createNote('Second synthetic question', 'gpt-6-luna', map, ambiguous.mapPath, 'workspace');
  const firstQuestionNode = map.nodes.find(item => item.id === ambiguous.question.id);
  for (const item of [firstQuestionNode, secondQuestion]) {
    item.mindSearchKind = 'question';
    item.mindSearchQuestion = { requestId: `ambiguous-${item.id}`, parentBranchId: null, options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], allowMultiple: false, allowFreeText: true };
  }
  map.nodes.push(secondQuestion); await ambiguous.repo.saveMap(ambiguous.mapPath, map);
  const ambiguousNotes = [], ambiguousRuns = [];
  for (const [index, questionNode] of [firstQuestionNode, secondQuestion].entries()) {
    const runId = `same-ordinal-run-${index + 1}`;
    const answerBranch = await ambiguous.store.createAnswerBranch(ambiguous.mapPath, { requestId: `same-ordinal-branch-${index + 1}`, questionNodeId: questionNode.id, parentBranchId: null, answerSnapshot: { selections: [], freeText: 'Synthetic only.' }, inputSnapshot: { topic: 'Synthetic topic', conditions: {}, upstreamResults: [] } });
    const attempt = await ambiguous.store.startAttempt(ambiguous.mapPath, answerBranch.id, runId);
    await ambiguous.store.recordResearchTurn(ambiguous.mapPath, attempt);
    const resultDraft = (await ambiguous.store.createResultDraft(ambiguous.mapPath, attempt, `Run ${index + 1} report`, 'gpt-6-luna')).draft;
    const searched = index === 0;
    await ambiguous.store.updateResultDraftReport(ambiguous.mapPath, attempt, resultDraft.id, `Report 1: Synthetic report ${index + 1}.`, `## Searcher report 1\n\nResearch status: ${searched ? 'search completed' : 'not searched'}\nSynthetic report ${index + 1}.`);
    await ambiguous.store.recordSearchDiagnostic(ambiguous.mapPath, attempt, { researchTurn: 1, startedEvents: Number(searched), completedEvents: Number(searched), completedSearchActions: Number(searched), otherCompletedActions: 0 });
    await ambiguous.store.failAttempt(ambiguous.mapPath, attempt, 'Synthetic ambiguous binding fixture.');
    ambiguousNotes.push({ path: resultDraft.notePath, note: await ambiguous.repo.readNote(resultDraft.notePath) }); ambiguousRuns.push(runId);
  }
  map = await ambiguous.repo.readMap(ambiguous.mapPath);
  assert.equal(matchMindSearchFailedReportTargets(map, ambiguousNotes).size, 0, 'repeated native attempt ordinals are hidden even when only one same-ordinal run has completed-search telemetry');
  const ambiguousFlow = new MindSearchManualFlow(ambiguous.repo, new MindSearchRunStore(ambiguous.repo), async () => { throw new Error('ambiguous diagnostic must be rejected before model work'); });
  await assert.rejects(ambiguousFlow.reviewFailedAttemptReport(ambiguous.mapPath, ambiguousRuns[0], ambiguousNotes[0].path), /attempt number is ambiguous/);
});

integrationTest('Planner reviews a saved Searcher diagnostic on a new fenced attempt without repeating completed research', async () => {
  const { MindSearchRunStore } = load('mindsearch-mve/research-run-store.ts');
  const { MindSearchManualFlow } = load('experiences/mind-search/manual-flow.ts');
  const runCase = async (suffix, reviews) => {
    const { repo, app, mapPath, question, store } = await mindSearchMapFixture();
    await repo.updateNote(question.path, { summary: 'How can a 1.5-inch steak reach 145°F and develop a browned crust in a cast-iron pan without an oven?', detail: 'Synthetic test fixture: core requested outcomes are a safe internal temperature and a browned-crust stovetop method.' });
    const branch = await store.createAnswerBranch(mapPath, { requestId: `saved-report-${suffix}`, questionNodeId: question.id, parentBranchId: null, answerSnapshot: { selections: [], freeText: 'Synthetic scenario: medium rare; cast-iron pan; thermometer; no oven.' }, inputSnapshot: { topic: 'Steak', conditions: { scenario: 'synthetic medium-rare answer' }, upstreamResults: [] } });
    const first = await store.startAttempt(mapPath, branch.id, 'run-saved-report', { model: 'gpt-6-luna', reasoning: 'low', maxResearchTurns: 2 });
    await store.recordResearchTurn(mapPath, first);
    await store.recordSearchDiagnostic(mapPath, first, { researchTurn: 1, startedEvents: 1, completedEvents: 1, completedSearchActions: 1, otherCompletedActions: 0 });
    await store.failAttempt(mapPath, first, 'Original attempt failed after its Searcher report was retained for diagnostic recovery.');
    const map = await repo.readMap(mapPath);
    const questionNode = map.nodes.find(item => item.id === question.id); questionNode.mindSearchKind = 'question';
    questionNode.mindSearchQuestion = { requestId: `saved-report-question-${suffix}`, parentBranchId: null, options: [{ id: 'medium', label: 'Medium rare' }, { id: 'safe', label: 'Follow safety guidance' }], allowMultiple: false, allowFreeText: true };
    await repo.saveMap(mapPath, map);
    const report = await repo.createNote(`Diagnostic retry · ${suffix}`, 'gpt-6-luna', map, mapPath, 'workspace', { summary: 'Synthetic scenario: thermometer use and safe-temperature tradeoff.', detail: '' });
    const reportDetail = 'Research status: search completed\n\n### Findings\nReported guidance gives a 145°F target and a three-minute rest, and describes thermometer placement. It does not provide a cast-iron browning sequence, heat cue, or timing method.\n\n### Source boundary\nAgent-reported only; VAM has not independently verified the sources.';
    await repo.updateNote(report.path, { summary: 'Synthetic scenario: thermometer use and safe-temperature tradeoff.', detail: `**Status:** Diagnostic only. This report is unpublished.\n\n**Prior attempt:** ${branch.id} / attempt-1; the persisted attempt remains failed.\n\n**Source boundary:** ${reportDetail}`, status: 'error' });
    await seedCoverageAncestors(repo, mapPath, branch.id);
    const calls = []; let searches = 0, reviewsUsed = 0;
    const ask = async context => {
      const delivery = deliveryFixture(context); if (delivery) return delivery;
      calls.push(context);
      if (context.researchMode === 'research') { searches++; assert.match(context.task, /Answer the assigned research target first/); return { summary: 'Bounded follow-up report', detail: 'Research status: search completed\nThe follow-up repeats safety-temperature advice but finds no supported skillet browning sequence, heat cue, or timing. The core method remains unresolved.', suggestions: [], visualReferences: [] }; }
      assert.equal(context.researchMode, 'local');
      if (mindSearchPhase(context, 'research-gap-audit')) return researchGapAudit('external_evidence', 'The remaining target is externally verifiable method evidence.');
      if (mindSearchPhase(context, 'decision-quality-review')) return auditEcho(context);
      const response = reviews[reviewsUsed++];
      if (context.task.includes('Make one local format-repair review')) {
        assert.match(context.task, /Format validation error:/);
        assert.match(context.task, /Already completed report detail:[\s\S]*Research status: search completed/);
        assert.match(context.task, /Original Planner response to review/);
        assert.match(context.task, /Do not search, repeat research/);
      } else {
        assert.match(context.task, /Do not search in this Planner turn/);
        assert.match(context.task, /Before deciding, compare the original topic and current question with the requested outcome and every persisted report/);
        assert.match(context.task, /A relevant side fact does not answer a missing core outcome/);
        assert.match(context.task, /Original question: How can a 1.5-inch steak reach 145°F and develop a browned crust in a cast-iron pan without an oven/);
        assert.match(context.task, /Research status: search completed/); assert.match(context.task, /Agent-reported only; VAM has not independently verified/);
      }
      return response;
    };
    const { VisualAgentMapView } = load('main.ts', { obsidian });
    const view = new VisualAgentMapView({ app }, { repo, settings: { ...DEFAULT_SETTINGS, language: 'en' }, mutate: async work => work(), syncOutline() {}, askModel: ask });
    view.path = mapPath; view.map = await repo.readMap(mapPath); view.render = () => {};
    await view.hydrateFailedReportTargets(() => true);
    assert.equal(view.mindSearchFailedReports.get(question.id)?.runId, 'run-saved-report', 'the current failed attempt exposes its unique saved search report');
    assert.equal(view.mindSearchFailedReports.get(question.id)?.diagnosticNotePath, report.path);
    await view.retryMindSearchFromSavedReport(question.id);
    const outcome = { status: (await repo.readMap(mapPath)).mindSearch.runs.find(item => item.id === 'run-saved-report').attempts[1].status === 'partial' ? 'partial' : 'completed' };
    const reopened = new Repository(app, repo.settings), savedMap = await reopened.readMap(mapPath);
    const savedBranch = savedMap.mindSearch.branches.find(item => item.id === branch.id), savedRun = savedMap.mindSearch.runs.find(item => item.id === 'run-saved-report');
    const originalReport = await reopened.readNote(report.path), finalRef = savedBranch.results.at(-1);
    assert.ok(finalRef, `saved-report retry did not publish a result; attempt=${JSON.stringify(savedRun.attempts[1])}; calls=${JSON.stringify(calls.map(context => ['saved-evidence-review', 'decision-quality-review', 'research-plan', 'subtopic-research', 'report-review'].find(phase => mindSearchPhase(context, phase)) ?? 'unmarked'))}`);
    const resultNote = await reopened.readNote(finalRef.notePath);
    assert.equal(originalReport.status, 'error'); assert.match(originalReport.detail, /Diagnostic only/);
    assert.equal(savedRun.attempts[0].status, 'failed'); assert.equal(savedRun.attempts[1].status, outcome.status === 'partial' ? 'partial' : 'completed');
    assert.equal(savedRun.attempts[1].plannerReviews[0].researchTurn, 1);
    if (outcome.status === 'completed') {
      const modelDetail = reviews.at(-1).detail.replace(/^<!-- mindsearch-review [^\n]* -->\s*\n/, '');
      assert.equal(resultNote.detail, 'Complete conditional document with practical details and source https://example.org/reference', 'a completed conclusion preserves its model-authored detail without a fixed Markdown wrapper');
    } else {
      assert.ok(resultNote.detail.includes(reportDetail), 'a partial result preserves the saved diagnostic report and its source boundary');
      assert.match(resultNote.detail, /Agent-reported only/);
    }
    assert.equal(savedMap.mindSearch.pendingCommits.length, 0); assert.equal(savedMap.mindSearch.resultDrafts.length, 0);
    return { outcome, calls, searches, savedMap, savedBranch, savedRun, resultNote, reportDetail };
  };

  const concluded = await runCase('conclude', [plannerReview('conclude', { rationale: 'The saved report supports a useful conditional answer and identifies its limits.', stopReason: 'Remaining uncertainty does not change the supported conditional answer.' }, 'Under this synthetic scenario, use thermometer readings and keep the safety tradeoff visible.', 'Preserve source attribution and do not infer the real user’s preference.')]);
  assert.equal(concluded.outcome.status, 'completed'); assert.equal(concluded.searches, 0); assert.equal(concluded.calls.length, 1);
  assert.equal(concluded.savedRun.attempts[0].status, 'failed'); assert.equal(concluded.savedBranch.results.length, 1);

  const followed = await runCase('follow-up', [
    plannerReview('research_more', { rationale: 'Probe placement for this thickness could materially change the practical advice.' }, 'Interim conditional answer.', 'A material evidence gap remains.', [{ title: 'Probe placement', task: 'Find official thermometer placement guidance for a 1.5-inch steak.', contribution: 'Could change how this scenario checks temperature.' }]),
    plannerReview('conclude', { rationale: 'The bounded follow-up resolves the measurement gap sufficiently for a conditional answer.', stopReason: 'The remaining uncertainty does not change the recommendation.' }, 'Final conditional answer.', 'Use center-temperature readings; the evidence does not support a fixed cooking time.')
  ]);
  assert.equal(followed.outcome.status, 'completed'); assert.equal(followed.searches, 1);
  assert.deepEqual(followed.calls.map(context => context.researchMode), ['local', 'local', 'research', 'local']);
  assert.deepEqual(plain(followed.savedRun.attempts[1].plannerReviews.map(item => [item.researchTurn, item.decision])), [[1, 'research_more'], [2, 'conclude']]);
  assert.equal(followed.savedRun.attempts[1].researchTurns, 2);
  assert.ok(followed.calls.some(context => context.task.includes('The follow-up repeats safety-temperature advice')), 'the bounded follow-up uses the completed report context');

  const coreGap = await runCase('core-method-gap', [
    plannerReview('research_more', { rationale: 'The report covers temperature and probe placement but leaves the requested browned-crust stovetop method unanswered; a targeted search may change the practical recommendation.' }, 'Temperature guidance is available, but the cooking method remains open.', 'Find a cast-iron browning method for this thickness.', [{ title: 'Cast-iron crust method', task: 'Find an agent-reported stovetop method for browning a 1.5-inch steak in cast iron while checking internal temperature; preserve the exact method and source limits.', contribution: 'Could supply the missing central cooking method.' }]),
    plannerReview('research_more', { rationale: 'The follow-up again reports safety facts but does not answer the requested skillet method; the core outcome remains open.' }, 'The available report supports temperature guidance only; the stovetop crust method is still unresolved.', 'This result is partial because the central requested method lacks support.', [{ title: 'Still unresolved: stovetop crust method', task: 'The prototype budget is exhausted; retain this as an open question.', contribution: 'The central requested cooking method remains unsupported.' }])
  ]);
  assert.equal(coreGap.outcome.status, 'partial', 'a still-open central method must not be committed as complete');
  assert.equal(coreGap.searches, 1); assert.deepEqual(coreGap.calls.map(context => context.researchMode), ['local', 'local', 'research', 'local', 'local']);
  const targetedFollowup = coreGap.calls.find(context => context.researchMode === 'research' && context.task.includes('Planner follow-up target: Cast-iron crust method'));
  assert.ok(targetedFollowup, 'the bounded follow-up uses a research-mode Planner target');
  assert.match(targetedFollowup.task, /Planner follow-up target: Cast-iron crust method[\s\S]*Find an agent-reported stovetop method/);
  assert.equal(coreGap.savedRun.attempts[1].status, 'partial');
  assert.deepEqual(plain(coreGap.savedRun.attempts[1].plannerReviews.map(item => item.decision)), ['research_more', 'research_more']);
  assert.match(coreGap.resultNote.detail, /partial/i); assert.match(coreGap.resultNote.detail, /core outcome remains open/i);
  assert.match(coreGap.resultNote.detail, /does not provide a cast-iron browning sequence/);

  const repairedMissingMarker = await runCase('format-repair', [
    { summary: 'Supported conditional answer.', detail: 'This Planner response deliberately omits the decision marker.', suggestions: [], visualReferences: [] },
    plannerReview('conclude', { rationale: 'The saved report supports only a conditional answer and retains its clear limitations.', stopReason: 'No new evidence is needed to communicate the supported limits.' }, 'Repaired conditional answer.', 'Keep the missing core method explicit.')
  ]);
  assert.equal(repairedMissingMarker.outcome.status, 'completed'); assert.equal(repairedMissingMarker.searches, 0);
  assert.deepEqual(repairedMissingMarker.calls.map(context => context.researchMode), ['local', 'local']);
  assert.equal(repairedMissingMarker.savedRun.attempts[1].status, 'completed');
  assert.equal(repairedMissingMarker.savedBranch.results.length, 1);
  assert.equal(repairedMissingMarker.savedRun.attempts[0].status, 'failed');
});
integrationTest('saved-report Planner repair failure and cancellation do not publish a retry result', async () => {
  const { MindSearchRunStore } = load('mindsearch-mve/research-run-store.ts');
  const { VisualAgentMapView } = load('experiences/visual-map/view.ts', { obsidian });
  const malformed = { summary: 'Diagnostic only.', detail: 'No machine-readable Planner marker.', suggestions: [], visualReferences: [] };
  for (const kind of ['invalid-repair', 'cancel-repair']) {
    const { repo, app, mapPath, question, store } = await mindSearchMapFixture();
    const branch = await store.createAnswerBranch(mapPath, { requestId: `saved-report-failure-${kind}`, questionNodeId: question.id, parentBranchId: null, answerSnapshot: { selections: [], freeText: 'Synthetic answer only.' }, inputSnapshot: { topic: 'Synthetic steak task', conditions: { provenance: 'synthetic' }, upstreamResults: [] } });
    const first = await store.startAttempt(mapPath, branch.id, `saved-report-failure-${kind}`, { model: 'gpt-6-luna', reasoning: 'low', maxResearchTurns: 2 });
    await store.recordResearchTurn(mapPath, first);
    await store.recordSearchDiagnostic(mapPath, first, { researchTurn: 1, startedEvents: 1, completedEvents: 1, completedSearchActions: 1, otherCompletedActions: 0 });
    await store.failAttempt(mapPath, first, 'Synthetic initial failure retained for retry regression.');
    const report = await repo.createNote(`Synthetic diagnostic ${kind}`, 'gpt-6-luna', await repo.readMap(mapPath), mapPath, 'workspace', { summary: 'Synthetic saved report.', detail: '' });
    const savedReportDetail = 'Research status: search completed\n\nSynthetic agent report; source claims are not independently verified.';
    await repo.updateNote(report.path, { summary: 'Synthetic saved report.', detail: `**Status:** Diagnostic only.\n\n**Prior attempt:** ${branch.id} / ${first.attemptId}; the persisted attempt remains failed.\n\n**Source boundary:** ${savedReportDetail}`, status: 'error' });
    const diagnosticBefore = await repo.app.vault.read(repo.app.vault.getAbstractFileByPath(report.path));
    const controller = new AbortController(); let repairStarted;
    const repairGate = new Promise(resolve => { repairStarted = resolve; });
    const calls = []; let searches = 0;
    const plugin = { repo, settings: { ...DEFAULT_SETTINGS, language: 'en' }, mutate: async work => work(), syncOutline() {}, askModel: async context => {
      calls.push(context);
      if (context.researchMode === 'research') { searches++; throw new Error('Saved-report retry unexpectedly repeated research.'); }
      if (calls.length === 1) return malformed;
      assert.match(context.task, /Make one local format-repair review/);
      assert.match(context.task, /Do not search, repeat research, add evidence, or invent facts/);
      if (kind === 'cancel-repair') return new Promise((resolve, reject) => { repairStarted(); context.signal.addEventListener('abort', () => { const error = new Error('Synthetic repair cancelled.'); error.name = 'AbortError'; reject(error); }, { once: true }); });
      return malformed;
    } };
    const view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = await repo.readMap(mapPath); view.render = () => {};
    const request = view.reviewMindSearchFailedReport(first.runId, report.path, controller.signal);
    if (kind === 'cancel-repair') { await repairGate; controller.abort(); await assert.rejects(request, error => error?.name === 'AbortError'); }
    else await assert.rejects(request, /missing its machine-readable decision block/);
    const saved = await repo.readMap(mapPath), savedRun = saved.mindSearch.runs.find(item => item.id === first.runId), savedBranch = saved.mindSearch.branches.find(item => item.id === branch.id), current = savedRun.attempts.find(item => item.id === savedRun.currentAttemptId);
    assert.equal(calls.length, 2, 'retry permits one malformed Planner reply and exactly one repair');
    assert.equal(searches, 0, 'saved-report recovery never repeats completed research during repair failure');
    assert.equal(savedRun.attempts[0].status, 'failed');
    assert.equal(current.status, kind === 'cancel-repair' ? 'cancelled' : 'failed');
    assert.equal(savedBranch.results.length, 0);
    assert.equal(saved.mindSearch.pendingCommits.length, 0); assert.equal(saved.mindSearch.resultDrafts.length, 0);
    assert.equal(await repo.app.vault.read(repo.app.vault.getAbstractFileByPath(report.path)), diagnosticBefore, 'the source Searcher diagnostic remains byte-for-byte unchanged');
  }
});
integrationTest('MindSearch recovers a question note written before its Map node commit without rerunning Planner', async () => {
  const { repo, files } = fixture();
  const { createMindSearchMap } = load('experiences/mind-search/create-map.ts');
  const created = await createMindSearchMap(repo, 'gpt-6-luna', { requestId: 'question-recovery-map', topic: '牛排熟度', context: '' });
  const { MindSearchRunStore } = load('mindsearch-mve/research-run-store.ts');
  const { MindSearchManualFlow } = load('experiences/mind-search/manual-flow.ts');
  let plannerCalls = 0, saves = 0, nextId = 0; const saveMap = repo.saveMap.bind(repo);
  repo.saveMap = async (...args) => { saves++; if (saves === 2) throw new Error('injected interruption after question Note creation'); return saveMap(...args); };
  const flow = new MindSearchManualFlow(repo, new MindSearchRunStore(repo), async () => { plannerCalls++; return { summary: '想要什麼熟度？', detail: '熟度會改變建議。', suggestions: [{ title: '偏紅' }, { title: '較熟' }], visualReferences: [] }; }, () => `question-recovery-${++nextId}`);
  await assert.rejects(flow.planNextQuestion(created.mapPath, created.root.id, 'gpt-6-luna', 'low', 'question-request-1'), /injected interruption/);
  repo.saveMap = saveMap;
  const pending = await repo.readMap(created.mapPath), draft = pending.mindSearch.questionDraft;
  assert.ok(draft); assert.ok(files.has(draft.notePath)); assert.equal(pending.nodes.some(node => node.id === draft.nodeId), false);
  assert.equal(await flow.recoverQuestionDraft(created.mapPath), true);
  const recovered = await repo.readMap(created.mapPath);
  assert.equal(recovered.mindSearch.questionDraft, undefined); assert.equal(recovered.nodes.filter(node => node.mindSearchKind === 'question').length, 1);
  assert.equal(recovered.nodes.find(node => node.id === draft.nodeId).path, draft.notePath); assert.equal(plannerCalls, 1);
});
integrationTest('opening a map recovers questionDraft and post-report asks without re-entering the mutation queue', async () => {
  const { VisualAgentMapView } = load('experiences/visual-map/view.ts', { obsidian });
  const openThroughSerialQueue = async (repo, mapPath) => {
    let queue = Promise.resolve(), mutationCalls = 0, aiCalls = 0;
    const plugin = {
      repo, settings: { ...DEFAULT_SETTINGS, cliModel: 'gpt-6-luna' }, closeStaleDetails() {}, syncOutline() {},
      askModel: async () => { aiCalls++; throw new Error('opening a persisted map must recover without Planner work'); },
      mutate: work => { mutationCalls++; const current = queue.then(work); queue = current.catch(() => {}); return current; }
    };
    const view = new VisualAgentMapView({ app: { workspace: { requestSaveLayout() {} } } }, plugin);
    view.render = () => {};
    let deadline;
    await Promise.race([view.openMap(mapPath), new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('openMap re-entered its serialized mutation queue')), 250); })]);
    clearTimeout(deadline);
    assert.equal(mutationCalls, 1, 'openMap enters the repository mutation queue once');
    assert.equal(aiCalls, 0, 'both recovery paths are deterministic and do not rerun Planner');
    return view;
  };

  const questionDraftData = fixture();
  const { createMindSearchMap } = load('experiences/mind-search/create-map.ts');
  const questionDraftCreated = await createMindSearchMap(questionDraftData.repo, 'gpt-6-luna', { requestId: 'queue-question-draft-map', topic: 'Question draft recovery', context: '' });
  const questionDraftMapPath = questionDraftCreated.mapPath;
  const questionDraftMap = await questionDraftData.repo.readMap(questionDraftMapPath), questionParent = questionDraftMap.nodes.find(node => node.id === questionDraftCreated.root.id);
  questionDraftMap.mindSearch.questionDraft = {
    requestId: 'queue-question-draft', nodeId: 'queue-question-node', parentId: questionParent.id, parentBranchId: null,
    notePath: `${questionDraftData.repo.topicRoot(questionDraftMapPath)}/Notes/Recovered question.md`,
    title: 'Recovered question', summary: 'Which synthetic option applies?', detail: 'Fixture only.', prompt: 'Fixture only.', model: 'gpt-6-luna',
    options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }]
  };
  await questionDraftData.repo.saveMap(questionDraftMapPath, questionDraftMap);
  const questionDraftView = await openThroughSerialQueue(questionDraftData.repo, questionDraftMapPath);
  assert.equal(questionDraftView.map.mindSearch.questionDraft, undefined);
  assert.ok(questionDraftView.map.nodes.some(node => node.id === 'queue-question-node' && node.mindSearchKind === 'question'));

  const postAsk = await mindSearchMapFixture();
  let saved = await postAsk.repo.readMap(postAsk.mapPath);
  const question = saved.nodes.find(node => node.id === postAsk.question.id);
  question.mindSearchKind = 'question';
  question.mindSearchQuestion = { requestId: 'queue-postask-parent', parentBranchId: null, options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], allowMultiple: false, allowFreeText: true };
  await postAsk.repo.saveMap(postAsk.mapPath, saved);
  const branch = await postAsk.store.createAnswerBranch(postAsk.mapPath, { requestId: 'queue-postask-answer', questionNodeId: question.id, parentBranchId: null, answerSnapshot: { selections: ['a'], freeText: '' }, inputSnapshot: { topic: saved.title, conditions: {}, upstreamResults: [] } });
  const attempt = await postAsk.store.startAttempt(postAsk.mapPath, branch.id, 'queue-postask-run');
  await postAsk.store.recordResearchTurn(postAsk.mapPath, attempt);
  await postAsk.store.recordPlannerReview(postAsk.mapPath, attempt, { decision: 'ask_user', rationale: 'This saved decision changes the answer.', researchTurn: 1, question: 'Which synthetic direction?', answerOptions: ['Option A', 'Option B'] }, 'Waiting for the follow-up answer.');
  const resultDraft = (await postAsk.store.createResultDraft(postAsk.mapPath, attempt, 'Saved interim report', 'gpt-6-luna', undefined, { kind: 'synthesis' })).draft;
  await postAsk.store.updateResultDraftReport(postAsk.mapPath, attempt, resultDraft.id, 'Synthetic interim report.', 'Synthetic report retained for post-ask recovery.');
  await postAsk.store.commitResult(postAsk.mapPath, attempt, resultDraft.id, { summary: 'Synthetic interim report.', detail: 'Synthetic report retained for post-ask recovery.' });
  postAsk.store.releaseAttempt(postAsk.mapPath, attempt);
  const postAskView = await openThroughSerialQueue(postAsk.repo, postAsk.mapPath);
  const recoveredPostAsk = postAskView.map.nodes.find(node => node.mindSearchQuestion?.parentBranchId === branch.id);
  assert.ok(recoveredPostAsk, 'openMap materializes the persisted post-report ask_user decision');
  assert.equal(recoveredPostAsk.parentId, resultDraft.nodeId);
  assert.equal(postAskView.map.mindSearch.questionDraft, undefined);
});
integrationTest('MindSearch Planner request identity prevents duplicate Map questions across Flow instances', async () => {
  const { repo } = fixture(); const { createMindSearchMap } = load('experiences/mind-search/create-map.ts');
  const created = await createMindSearchMap(repo, 'gpt-6-luna', { requestId: 'planner-race-map', topic: '牛排', context: '' });
  const { MindSearchRunStore } = load('mindsearch-mve/research-run-store.ts'); const { MindSearchManualFlow } = load('experiences/mind-search/manual-flow.ts');
  const resolvers = []; let call = 0, sequence = 0;
  const ask = () => { call++; return new Promise(resolve => resolvers.push(() => resolve({ summary: '熟度偏好？', detail: '需要使用者回答。', suggestions: [{ title: '偏紅' }, { title: '較熟' }], visualReferences: [] }))); };
  let queue = Promise.resolve(); const persist = work => { const current = queue.then(work); queue = current.catch(() => {}); return current; };
  const flowA = new MindSearchManualFlow(repo, new MindSearchRunStore(repo), ask, () => `planner-race-a-${++sequence}`, persist);
  const flowB = new MindSearchManualFlow(repo, new MindSearchRunStore(repo), ask, () => `planner-race-b-${++sequence}`, persist);
  const first = flowA.planNextQuestion(created.mapPath, created.root.id, 'gpt-6-luna', 'low', 'same-planner-request');
  const second = flowB.planNextQuestion(created.mapPath, created.root.id, 'gpt-6-luna', 'low', 'same-planner-request');
  while (resolvers.length < 1) await new Promise(resolve => setTimeout(resolve, 0));
  resolvers[0]();
  const [left, right] = await Promise.all([first, second]); const saved = await repo.readMap(created.mapPath);
  assert.equal(call, 1, 'same-process Flow instances share one Planner request and one model dispatch');
  assert.equal(left.status, 'question'); assert.equal(right.status, 'question'); assert.equal(left.node.id, right.node.id);
  assert.equal(saved.nodes.filter(node => node.mindSearchQuestion?.requestId === 'same-planner-request').length, 1);
});
integrationTest('MindSearch Planner close cancels only its View subscriber and fences late results', async () => {
  const { repo } = fixture(); const { createMindSearchMap } = load('experiences/mind-search/create-map.ts');
  const created = await createMindSearchMap(repo, 'gpt-6-luna', { requestId: 'planner-close-map', topic: '牛排', context: '' });
  const { MindSearchRunStore } = load('mindsearch-mve/research-run-store.ts'); const { MindSearchManualFlow } = load('experiences/mind-search/manual-flow.ts');
  let resolvePlanner, call = 0;
  const ask = (_context, _model, _reasoning, signal) => { call++; return new Promise(resolve => { resolvePlanner = () => resolve({ summary: '熟度偏好？', detail: '需要本人回答。', suggestions: [{ title: '偏紅' }, { title: '較熟' }], visualReferences: [] }); ask.signal = signal; }); };
  const flowA = new MindSearchManualFlow(repo, new MindSearchRunStore(repo), ask), flowB = new MindSearchManualFlow(repo, new MindSearchRunStore(repo), ask);
  const owner = new AbortController(), otherView = new AbortController();
  const first = flowA.planNextQuestion(created.mapPath, created.root.id, 'gpt-6-luna', 'low', 'shared-close-question', null, owner.signal);
  const second = flowB.planNextQuestion(created.mapPath, created.root.id, 'gpt-6-luna', 'low', 'shared-close-question', null, otherView.signal);
  while (!resolvePlanner) await new Promise(resolve => setTimeout(resolve, 0));
  owner.abort(); await assert.rejects(first, error => error?.name === 'AbortError');
  assert.equal(ask.signal.aborted, false, 'closing one View leaves a coalesced Planner turn alive for its other subscriber');
  resolvePlanner(); const shared = await second;
  assert.equal(call, 1); assert.equal(shared.status, 'question');
  assert.equal((await repo.readMap(created.mapPath)).nodes.filter(node => node.mindSearchQuestion?.requestId === 'shared-close-question').length, 1);

  const lateController = new AbortController(); let resolveLate;
  const lateFlow = new MindSearchManualFlow(repo, new MindSearchRunStore(repo), async (_context, _model, _reasoning, signal) => {
    return new Promise(resolve => { resolveLate = () => resolve({ summary: '不應發布的問題？', detail: 'late', suggestions: [{ title: 'A' }, { title: 'B' }], visualReferences: [] }); ask.lateSignal = signal; });
  });
  const late = lateFlow.planNextQuestion(created.mapPath, created.root.id, 'gpt-6-luna', 'low', 'late-close-question', null, lateController.signal);
  while (!resolveLate) await new Promise(resolve => setTimeout(resolve, 0));
  lateController.abort(); await assert.rejects(late, error => error?.name === 'AbortError');
  assert.equal(ask.lateSignal.aborted, true);
  resolveLate(); await new Promise(resolve => setTimeout(resolve, 0));
  let saved = await repo.readMap(created.mapPath);
  assert.equal(saved.nodes.some(node => node.mindSearchQuestion?.requestId === 'late-close-question'), false, 'an abort-ignoring late model completion cannot commit a question');
  const retry = new MindSearchManualFlow(repo, new MindSearchRunStore(repo), async () => ({ summary: '重新規劃？', detail: '新 turn。', suggestions: [{ title: 'A', task: '', contribution: '', parentTitle: '' }, { title: 'B', task: '', contribution: '', parentTitle: '' }], visualReferences: [] }));
  assert.equal((await retry.planNextQuestion(created.mapPath, created.root.id, 'gpt-6-luna', 'low', 'late-close-question')).status, 'question', 'the request registry is released after cancellation');
  saved = await repo.readMap(created.mapPath);
  assert.equal(saved.nodes.filter(node => node.mindSearchQuestion?.requestId === 'late-close-question').length, 1);
});
integrationTest('Visual Map close fences late Planner rendering and reopen starts a fresh lifecycle', async () => {
  const { repo } = fixture(); const { createMindSearchMap } = load('experiences/mind-search/create-map.ts');
  const created = await createMindSearchMap(repo, 'gpt-6-luna', { requestId: 'view-close-map', topic: '牛排', context: '' });
  await repo.updateNote(created.root.path, { detail: `${(await repo.readNote(created.root.path)).detail}\n\n<!-- mindsearch-intake-complete -->` });
  let resolvePlanner, call = 0, renders = 0;
  const plugin = { repo, settings: { language: 'zh-TW', cliModel: 'gpt-6-luna' }, ready: Promise.resolve(), mutate: async work => work(),
    askModel: async () => { call++; if (call === 1) return new Promise(resolve => { resolvePlanner = () => resolve({ summary: '晚到問題？', detail: '不應寫回關閉的 View。', suggestions: [{ title: 'A', task: '', contribution: '', parentTitle: '' }, { title: 'B', task: '', contribution: '', parentTitle: '' }], visualReferences: [] }); }); return { summary: '重新開啟後的問題？', detail: '新生命週期。', suggestions: [{ title: 'A', task: '', contribution: '', parentTitle: '' }, { title: 'B', task: '', contribution: '', parentTitle: '' }], visualReferences: [] }; },
    syncOutline() {}, consumeFirstInstallSample: () => false };
  const { VisualAgentMapView } = load('main.ts', { obsidian }); const view = new VisualAgentMapView({ app: {} }, plugin);
  view.contentEl = { addClass() {}, tabIndex: 0 }; view.registerDomEvent = () => {};
  view.path = created.mapPath; view.map = created.map; view.notes.set(created.root.id, await repo.readNote(created.root.path)); view.selected = created.root.id; view.render = () => { renders++; };
  await view.onOpen(); const work = view.planMindSearchFromSelection();
  while (!resolvePlanner) await new Promise(resolve => setTimeout(resolve, 0));
  await view.onClose(); const rendersAtClose = renders;
  resolvePlanner(); await work;
  assert.equal(renders, rendersAtClose, 'late Planner completion cannot render after close');
  assert.equal((await repo.readMap(created.mapPath)).nodes.some(node => node.mindSearchKind === 'question'), false);
  await view.onOpen(); view.selected = created.root.id;
  await view.planMindSearchFromSelection();
  assert.equal(call, 2); assert.equal((await repo.readMap(created.mapPath)).nodes.some(node => node.mindSearchKind === 'question'), true);
});
integrationTest('Visual Map close during Planner question save lets the started Note/Map commit finish without late rendering', async () => {
  const { repo } = fixture(); const { createMindSearchMap } = load('experiences/mind-search/create-map.ts');
  const created = await createMindSearchMap(repo, 'gpt-6-luna', { requestId: 'planner-save-close-map', topic: '牛排', context: '' });
  await repo.updateNote(created.root.path, { detail: `${(await repo.readNote(created.root.path)).detail}\n\n<!-- mindsearch-intake-complete -->` });
  let releaseNote, announceNote; const noteStarted = new Promise(resolve => { announceNote = resolve; });
  const createNoteAt = repo.createNoteAt.bind(repo);
  repo.createNoteAt = async (...args) => { announceNote(); await new Promise(resolve => { releaseNote = resolve; }); return createNoteAt(...args); };
  const realSaveMap = repo.saveMap.bind(repo); let mapWrites = 0, announceMapCommit;
  const mapCommitted = new Promise(resolve => { announceMapCommit = resolve; });
  repo.saveMap = async (...args) => { const result = await realSaveMap(...args); if (++mapWrites === 2) announceMapCommit(); return result; };
  const plugin = { repo, settings: { language: 'zh-TW', cliModel: 'gpt-6-luna' }, mutate: async work => work(), syncOutline() {},
    askModel: async () => ({ summary: '偏好熟度？', detail: '請使用者選擇。', suggestions: [{ title: '偏紅', task: '', contribution: '', parentTitle: '' }, { title: '較熟', task: '', contribution: '', parentTitle: '' }], visualReferences: [] }) };
  const { VisualAgentMapView } = load('main.ts', { obsidian }); const view = new VisualAgentMapView({ app: {} }, plugin);
  view.path = created.mapPath; view.map = created.map; view.notes.set(created.root.id, await repo.readNote(created.root.path)); view.selected = created.root.id;
  let renders = 0; view.render = () => { renders++; };
  const work = view.planMindSearchFromSelection(); await noteStarted; await view.onClose(); const rendersAtClose = renders;
  releaseNote(); await work; await mapCommitted;
  const saved = await repo.readMap(created.mapPath);
  assert.equal(saved.mindSearch.questionDraft, undefined);
  assert.equal(saved.nodes.filter(node => node.mindSearchKind === 'question').length, 1);
  assert.equal(renders, rendersAtClose, 'the already-started persistence can complete without publishing to the closed View');
});
integrationTest('MindSearch answer modal from an older View lifecycle cannot submit after reopen', async () => {
  const { repo } = fixture(); const { createMindSearchMap } = load('experiences/mind-search/create-map.ts');
  const created = await createMindSearchMap(repo, 'gpt-6-luna', { requestId: 'stale-modal-map', topic: '牛排', context: '' });
  const { MindSearchRunStore } = load('mindsearch-mve/research-run-store.ts'); const { MindSearchManualFlow } = load('experiences/mind-search/manual-flow.ts');
  const planner = new MindSearchManualFlow(repo, new MindSearchRunStore(repo), async () => ({ summary: '偏好熟度？', detail: '本人回答。', suggestions: [{ title: '偏紅', task: '', contribution: '', parentTitle: '' }, { title: '較熟', task: '', contribution: '', parentTitle: '' }], visualReferences: [] }));
  const planned = await planner.planNextQuestion(created.mapPath, created.root.id, 'gpt-6-luna', 'low', 'stale-modal-question');
  let modal, modelCalls = 0;
  class CapturingModal { constructor(app) { this.app = app; } open() { modal = this; } close() {} }
  const plugin = { repo, settings: { language: 'zh-TW', cliModel: 'gpt-6-luna' }, ready: Promise.resolve(), mutate: async work => work(), syncOutline() {},
    askModel: async () => { modelCalls++; return { summary: '不應啟動', detail: 'stale modal', suggestions: [], visualReferences: [] }; } };
  const { VisualAgentMapView } = load('main.ts', { obsidian: { ...obsidian, Modal: CapturingModal } });
  const view = new VisualAgentMapView({ app: {} }, plugin); view.contentEl = { addClass() {}, tabIndex: 0 }; view.registerDomEvent = () => {};
  view.path = created.mapPath; view.map = await repo.readMap(created.mapPath); view.notes.set(planned.node.id, await repo.readNote(planned.node.path)); view.render = () => {};
  await view.onOpen(); view.openMindSearchAnswer(planned.node);
  const staleSubmit = modal.submit;
  await view.onClose(); await view.onOpen();
  await staleSubmit({ requestId: 'stale-modal-answer', selections: [planned.options[0].id], freeText: '' });
  const saved = await repo.readMap(created.mapPath);
  assert.equal(modelCalls, 0); assert.equal(saved.mindSearch.branches.length, 0);
});
integrationTest('MindSearch start modal from an older View lifecycle cannot create or render after reopen', async () => {
  const { repo } = fixture(); let modal, createCalls = 0, rebuildCalls = 0, renders = 0;
  class CapturingModal { constructor(app, ...args) { this.app = app; this.args = args; } open() { modal = this; } close() {} }
  const realCreate = repo.createMap.bind(repo);
  repo.createMap = async (...args) => { createCalls++; return realCreate(...args); };
  const plugin = { repo, settings: { language: 'zh-TW', cliModel: 'gpt-5.6-luna', cliReasoning: 'medium' }, availableModels: () => ['gpt-6-luna'], ready: Promise.resolve(), mutate: async work => work(), closeStaleDetails() {}, syncOutline() {},
    rebuildDerivedData: async () => { rebuildCalls++; } };
  const { VisualAgentMapView } = load('main.ts', { obsidian: { ...obsidian, Modal: CapturingModal } });
  const view = new VisualAgentMapView({ app: { workspace: { requestSaveLayout() {} } } }, plugin);
  view.contentEl = { addClass() {}, tabIndex: 0 }; view.registerDomEvent = () => {}; view.path = 'existing/Map.md'; view.render = () => { renders++; };
  await view.onOpen(); view.openMindSearchStart(); const staleSubmit = modal.submit; const beforeClose = renders;
  assert.deepEqual(plain(modal.models.map(choice => choice.id)), ['gpt-5.6-luna', 'gpt-6-luna']);
  assert.equal(modal.defaultModel, 'gpt-5.6-luna', 'MindSearch honors the workspace-selected model rather than silently overriding it.');
  assert.equal(modal.defaultReasoning, 'medium', 'MindSearch honors the workspace reasoning setting.');
  await view.onClose(); await view.onOpen(); const afterReopen = renders;
  await staleSubmit({ requestId: 'stale-start', topic: '不應建立', context: '' });
  assert.equal(createCalls, 0); assert.equal(rebuildCalls, 0);
  assert.equal((await repo.mapFiles()).length, 0); assert.equal(renders, afterReopen); assert.ok(afterReopen >= beforeClose);
});
integrationTest('Visual Map ignores an earlier asynchronous open after close and a newer open', async () => {
  const { repo } = fixture(); const stalePath = await repo.createMap('舊圖載入'); const currentPath = await repo.createMap('新圖載入');
  const readMap = repo.readMap.bind(repo); let releaseStale, signalStaleRead;
  const staleReadStarted = new Promise(resolve => { signalStaleRead = resolve; });
  repo.readMap = async path => { if (path === stalePath) { signalStaleRead(); await new Promise(resolve => { releaseStale = resolve; }); } return readMap(path); };
  const plugin = { repo, settings: { language: 'zh-TW', cliModel: 'gpt-6-luna' }, ready: Promise.resolve(), mutate: async work => work(), closeStaleDetails() {}, syncOutline() {} };
  const app = { workspace: { requestSaveLayout() {} } };
  const { VisualAgentMapView } = load('main.ts', { obsidian }); const view = new VisualAgentMapView({ app }, plugin);
  view.contentEl = { addClass() {}, tabIndex: 0 }; view.registerDomEvent = () => {}; view.path = currentPath; let renders = 0; view.render = () => { renders++; };
  const staleOpen = view.openMap(stalePath); await staleReadStarted;
  await view.onClose(); await view.onOpen(); await view.openMap(currentPath);
  const rendersAfterCurrentOpen = renders;
  releaseStale(); await staleOpen;
  assert.equal(view.path, currentPath); assert.equal(view.map.title, '新圖載入'); assert.equal(renders, rendersAfterCurrentOpen);
});
integrationTest('MindSearch carries ancestor answers and reports into follow-up branches and Planner context', async () => {
  const { repo } = fixture();
  const { createMindSearchMap } = load('experiences/mind-search/create-map.ts');
  const created = await createMindSearchMap(repo, 'gpt-6-luna', { requestId: 'lineage-map', topic: '在家煎牛排', context: '鑄鐵鍋；沒有烤箱。' });
  const { MindSearchRunStore } = load('mindsearch-mve/research-run-store.ts');
  const { MindSearchManualFlow } = load('experiences/mind-search/manual-flow.ts');
  let call = 0, id = 0, requestedParentEvidence = false; const contexts = [];
  const flow = new MindSearchManualFlow(repo, new MindSearchRunStore(repo), async context => {
    contexts.push(context); call++;
    if (mindSearchPhase(context, 'saved-evidence-review')) return savedEvidenceNeedsSearch();
    if (mindSearchPhase(context, 'research-plan')) return { summary: '安全與操作兩個面向', detail: '<!-- mindsearch-plan {"subtopics":[{"id":"safety","title":"安全條件","task":"查詢適用安全條件","expectedValue":"保留必要安全限制"},{"id":"method","title":"操作方法","task":"比較可行操作方式","expectedValue":"補足執行細節"}]} -->', suggestions: [], visualReferences: [] };
    if (context.task.includes('Decide whether one missing user condition')) return { summary: call === 1 ? '偏好熟度？' : '想要脆皮程度？', detail: '此條件會影響操作。', suggestions: [{ title: '偏紅' }, { title: '較熟' }], visualReferences: [] };
    if (mindSearchPhase(context, 'report-review')) {
      const evidenceId = `${context.task}\n${context.detail}\n${context.ancestors}`.match(/Evidence ID: ([^\s]+)/)?.[1];
      if (/外層要酥脆/.test(context.task) && evidenceId && !requestedParentEvidence) { requestedParentEvidence = true; return { summary: 'Need the parent report details.', detail: `<!-- mindsearch-evidence-request {"ids":["${evidenceId}"]} -->`, suggestions: [], visualReferences: [] }; }
      return plannerReview('ask_user', /外層要酥脆/.test(context.task) ? { rationale: '下一個未確認條件會影響結果。', question: '你能提前多久準備？' } : { rationale: '牛排的具體烹調方向仍由使用者選擇，這項條件無法從證據推斷。', question: '接下來你希望優先深入哪個部分？' }, '保存祖先條件及研究報告：不同熟度與建議溫度存在取捨。', '已整理熟度與溫度取捨，請選擇下一個重點。', ['烹調方式', '安全溫度']);
    }
    if (context.researchMode === 'research') {
      if (context.task.includes('Assigned research subtopic')) {
        if (/外層要酥脆/.test(context.ancestors)) { assert.match(context.task, /不同熟度與建議溫度存在取捨/); assert.match(context.task, /外層要酥脆/); assert.match(context.ancestors, /沒有烤箱/); return { summary: '依先前熟度與本次表面偏好提供條件式建議。', detail: '保留祖先條件及研究報告。', suggestions: [], visualReferences: [] }; }
        return { summary: '偏紅需要留意溫度取捨。', detail: '先前研究報告：不同熟度與建議溫度存在取捨。', suggestions: [], visualReferences: [] };
      }
      return { summary: '偏紅需要留意溫度取捨。', detail: '先前研究報告：不同熟度與建議溫度存在取捨。', suggestions: [], visualReferences: [] };
    }
    throw new Error('Unexpected Planner request in lineage test.');
  }, () => `lineage-${++id}`);
  const firstQuestion = await flow.planNextQuestion(created.mapPath, created.root.id, 'gpt-6-luna', 'low', 'lineage-q1');
  const beforeFirstAnswer = contexts.length;
  const firstAnswer = await flow.answerAndResearch(created.mapPath, firstQuestion.node.id, { requestId: 'lineage-a1', selections: [firstQuestion.options[0].id], freeText: '中等厚度' }, 'gpt-6-luna', 'low');
  assert.equal(firstAnswer.status, 'waiting-user');
  const firstAnswerCalls = contexts.slice(beforeFirstAnswer);
  assert.equal(firstAnswerCalls.filter(context => context.researchMode === 'research').length, 2, 'each planned subtopic has an independent research call');
  assert.equal(firstAnswerCalls.filter(context => mindSearchPhase(context, 'report-review')).length, 1);
  assert.ok(firstAnswerCalls.every(context => `${context.task}\n${context.detail}\n${context.ancestors}`.length < 30000), 'branch context remains bounded');
  assert.ok(firstAnswerCalls.every(context => /鑄鐵鍋|沒有烤箱/.test(`${context.task}\n${context.detail}\n${context.ancestors}`)), 'the original conditions remain available to both calls');
  let map = await repo.readMap(created.mapPath); const firstBranch = map.mindSearch.branches[0], firstResult = firstBranch.results.find(item => item.kind === 'synthesis');
  const secondQuestionNode = map.nodes.find(node => node.id === firstAnswer.questionNodeId);
  const secondQuestion = { node: secondQuestionNode, options: secondQuestionNode.mindSearchQuestion.options };
  assert.equal(secondQuestion.node.mindSearchQuestion.parentBranchId, firstBranch.id);
  const secondAnswer = await flow.answerAndResearch(created.mapPath, secondQuestion.node.id, { requestId: 'lineage-a2', selections: [secondQuestion.options.find(option => option.label === '烹調方式').id], freeText: '外層要酥脆' }, 'gpt-6-luna', 'low');
  assert.equal(secondAnswer.status, 'waiting-user'); map = await repo.readMap(created.mapPath);
  const followupResearch = contexts.find(context => context.researchMode === 'research' && /外層要酥脆/.test(context.task));
  assert.ok(followupResearch && /外層要酥脆/.test(followupResearch.task) && /偏紅/.test(followupResearch.ancestors) && /Evidence ID:/.test(followupResearch.ancestors) && /Full report retained/.test(followupResearch.ancestors), 'the follow-up search receives the latest answer, ancestor answer, and indexed parent report');
  const child = map.mindSearch.branches.find(branch => branch.id === secondAnswer.branchId);
  assert.equal(child.parentBranchId, firstBranch.id);
  assert.deepEqual(plain(child.inputSnapshot.conditions), { '偏好熟度？': '偏紅 — 中等厚度', '接下來你希望優先深入哪個部分？': '烹調方式 — 外層要酥脆' });
  assert.ok(child.inputSnapshot.upstreamResults.some(result => result.notePath === firstResult.notePath && result.version === firstResult.version));
  const followupReview = contexts.find(context => mindSearchPhase(context, 'report-review') && /外層要酥脆/.test(context.task));
  assert.ok(followupReview, 'the follow-up evidence review receives the latest answer and parent branch');
  assert.match(followupReview.task, /外層要酥脆/); assert.match(`${followupReview.task}\n${followupReview.detail}\n${followupReview.ancestors}`, /偏紅/); assert.match(`${followupReview.task}\n${followupReview.detail}\n${followupReview.ancestors}`, /Evidence ID:/);
});
integrationTest('MindSearch shares active run reservation across Manual Flow instances', async () => {
  const { repo } = fixture(); const { createMindSearchMap } = load('experiences/mind-search/create-map.ts');
  const created = await createMindSearchMap(repo, 'gpt-6-luna', { requestId: 'multi-flow-map', topic: '牛排', context: '' });
  const { MindSearchRunStore } = load('mindsearch-mve/research-run-store.ts'); const { MindSearchManualFlow } = load('experiences/mind-search/manual-flow.ts');
  const question = await new MindSearchManualFlow(repo, new MindSearchRunStore(repo), async () => ({ summary: '熟度？', detail: '個人條件。', suggestions: [{ title: '偏紅' }, { title: '較熟' }], visualReferences: [] })).planNextQuestion(created.mapPath, created.root.id, 'gpt-6-luna', 'low', 'multi-q');
  let queued = Promise.resolve(); const persist = work => { const current = queued.then(work); queued = current.catch(() => {}); return current; };
  let calls = 0, researchCalls = 0, flowAIds = 0, flowBIds = 0, release; const ask = async context => { calls++; if (mindSearchPhase(context, 'saved-evidence-review')) return savedEvidenceNeedsSearch(); if (mindSearchPhase(context, 'decision-quality-review')) return auditEcho(context); if (mindSearchPhase(context, 'research-plan')) return { summary: '兩個研究面向', detail: '<!-- mindsearch-plan {"subtopics":[{"id":"a","title":"研究 A","task":"查詢 A","expectedValue":"補足 A"},{"id":"b","title":"研究 B","task":"查詢 B","expectedValue":"補足 B"}]} -->', suggestions: [], visualReferences: [] }; if (mindSearchPhase(context, 'report-review')) return plannerReview('ask_user', { rationale: '兩份研究完成後，使用者仍需選擇要採用的實作方向。', question: '下一步想深入哪一項？' }, '熟度條件式結果已整理。', '有依據的條件式報告。', ['研究 A', '研究 B']); researchCalls++; if (researchCalls === 1) return new Promise(resolve => { release = () => resolve({ summary: '條件式結果', detail: '有依據的報告。', suggestions: [], visualReferences: [] }); }); return { summary: '第二份研究結果', detail: '補充有依據的報告', suggestions: [], visualReferences: [] }; };
  const flowA = new MindSearchManualFlow(repo, new MindSearchRunStore(repo), ask, () => `flow-a-${++flowAIds}`, persist);
  const flowB = new MindSearchManualFlow(repo, new MindSearchRunStore(repo), ask, () => `flow-b-${++flowBIds}`, persist);
  const answer = { requestId: 'multi-answer-one', selections: [question.options[0].id], freeText: '' };
  const first = flowA.answerAndResearch(created.mapPath, question.node.id, answer, 'gpt-6-luna', 'low');
  while (!release) await new Promise(resolve => setTimeout(resolve, 0));
  const second = await flowB.answerAndResearch(created.mapPath, question.node.id, answer, 'gpt-6-luna', 'low');
  assert.equal(second.status, 'in-progress'); assert.equal(researchCalls, 1);
  release(); const completed = await first; assert.equal(completed.status, 'waiting-user'); assert.equal(researchCalls, 2);
  const [reservedA, reservedB] = await Promise.all([
    persist(() => new MindSearchRunStore(repo).startAttempt(created.mapPath, completed.branchId)),
    persist(() => new MindSearchRunStore(repo).startAttempt(created.mapPath, completed.branchId))
  ]);
  assert.deepEqual([reservedA.dispatch, reservedB.dispatch].sort(), [false, true]);
});
integrationTest('Visual Map protects the MindSearch root and allows recoverable question-node removal', async () => {
  const { repo, app } = fixture(); const { createMindSearchMap } = load('experiences/mind-search/create-map.ts');
  const created = await createMindSearchMap(repo, 'gpt-6-luna', { requestId: 'protect-map', topic: '牛排', context: '' });
  const { MindSearchRunStore } = load('mindsearch-mve/research-run-store.ts'); const { MindSearchManualFlow } = load('experiences/mind-search/manual-flow.ts');
  const flow = new MindSearchManualFlow(repo, new MindSearchRunStore(repo), async context => mindSearchPhase(context, 'saved-evidence-review') ? savedEvidenceNeedsSearch() : mindSearchPhase(context, 'decision-quality-review') ? auditEcho(context) : context.task.includes('Decide whether one missing user condition') ? { summary: '熟度？', detail: '', suggestions: [{ title: '偏紅' }, { title: '較熟' }], visualReferences: [] } : mindSearchPhase(context, 'research-plan') ? { summary: '研究規劃', detail: '<!-- mindsearch-plan {"subtopics":[{"id":"a","title":"食安溫度","task":"查詢安全溫度","expectedValue":"確認安全條件"},{"id":"b","title":"烹調方法","task":"查詢烹調方式","expectedValue":"提供操作步驟"}]} -->', suggestions: [], visualReferences: [] } : mindSearchPhase(context, 'report-review') ? plannerReview('ask_user', { rationale: '完成研究後，使用者的偏好仍會影響實際做法。', question: '下一步想深入哪一項？' }, '研究已整理。', '保留條件式建議。', ['食安溫度', '烹調方法']) : { summary: '研究結果', detail: '報告', suggestions: [], visualReferences: [] });
  const question = await flow.planNextQuestion(created.mapPath, created.root.id, 'gpt-6-luna', 'low', 'protect-q');
  await flow.answerAndResearch(created.mapPath, question.node.id, { requestId: 'protect-a', selections: [question.options[0].id], freeText: '' }, 'gpt-6-luna', 'low');
  const map = await repo.readMap(created.mapPath), original = plain(map);
  const { VisualAgentMapView } = load('main.ts', { obsidian }); const plugin = { repo, settings: { ...DEFAULT_SETTINGS }, rebuildDerivedData: async () => {} };
  const view = new VisualAgentMapView({ app }, plugin); view.path = created.mapPath; view.map = map; view.render = () => {}; view.hydrate = async () => {}; view.multiSelected = new Set([created.root.id]);
  await assert.rejects(view.removeSelected(), /referenced by saved branches/);
  assert.deepEqual(plain(await repo.readMap(created.mapPath)), original);
  assert.equal((await repo.collectionFiles(created.mapPath, 'Unassigned')).length, 0);
  const questionNode = map.nodes.find(node => node.id === map.mindSearch.branches[0].questionNodeId);
  await view.removeToUnassigned(questionNode, false);
  const after = await repo.readMap(created.mapPath);
  assert.ok(!after.nodes.some(node => node.id === questionNode.id));
  assert.equal(after.mindSearch.branches.length, 0, 'deleting a question removes its stale answer-branch index');
  assert.ok(after.nodes.filter(node => original.nodes.find(item => item.id === node.id)?.parentId === questionNode.id).every(node => node.parentId === null), 'children are kept as roots when only the question is removed');
  const unassigned = await repo.collectionFiles(created.mapPath, 'Unassigned');
  assert.equal(unassigned.length, 1, 'the Markdown note is preserved in Unassigned');
  assert.equal((await repo.readNote(unassigned[0].path)).summary, '熟度？', 'the original question content remains readable after removal');
});
integrationTest('Visual Map wires Manual Planner and answer submissions through the plugin AI and outline refresh boundary', async () => {
  const { repo } = fixture();
  const { createMindSearchMap } = load('experiences/mind-search/create-map.ts');
  const created = await createMindSearchMap(repo, 'gpt-6-luna', { requestId: 'manual-wiring-map-1', topic: '如何選擇牛排熟度？', context: '有溫度計。' });
  let askCalls = 0; const outlinedMaps = [];
  const plugin = {
    repo,
    mutate: async work => work(),
    syncOutline: (map, notes) => outlinedMaps.push({ map: plain(map), noteIds: [...notes.keys()] }),
    askModel: async (context, _model, _reasoning, _signal, _onExchange, _onAccepted, onWebSearchEvent) => {
      askCalls++;
      if (mindSearchPhase(context, 'saved-evidence-review')) return savedEvidenceNeedsSearch();
      if (context.task.includes('Decide whether one missing user condition')) return { summary: '偏好熟度為何？', detail: '熟度是使用者條件。', suggestions: [{ title: '偏紅', task: '', contribution: '', parentTitle: '' }, { title: '較熟', task: '', contribution: '', parentTitle: '' }], visualReferences: [] };
      if (mindSearchPhase(context, 'research-plan')) return { summary: '拆成食安與口感兩個研究面向。', detail: '<!-- mindsearch-plan {"subtopics":[{"id":"safety","title":"安全溫度","task":"查詢牛排安全溫度","expectedValue":"釐清食安下限"},{"id":"texture","title":"口感差異","task":"比較熟度口感","expectedValue":"呈現口感取捨"}]} -->\n兩項互補研究。', suggestions: [], visualReferences: [] };
      if (mindSearchPhase(context, 'decision-quality-review')) return auditEcho(context);
      if (mindSearchPhase(context, 'report-review')) return plannerReview('ask_user', { rationale: '報告可以支持條件式答案，但使用者還需選擇偏好的方向。', question: '接下來想深入哪一項？' }, '依本人熟度偏好提供條件式建議。', '來源與限制依 Agent 報告記錄。', ['安全溫度', '口感差異']);
      onWebSearchEvent?.({ method: 'item/completed', params: { item: { id: 'fixture-search', type: 'webSearch', action: { type: 'search' } } } });
      return { summary: '依本人熟度偏好提供條件式建議。', detail: '來源與限制依 Agent 報告記錄。', suggestions: [], visualReferences: [] };
    }
  };
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app: {} }, plugin);
  view.path = created.mapPath; view.map = created.map; view.notes.set(created.root.id, await repo.readNote(created.root.path));
  view.render = () => {};
  const planned = await view.planMindSearchQuestion(created.root.id, 'manual-wiring-question-1');
  assert.equal(planned.status, 'question');
  const answered = await view.submitMindSearchAnswer(planned.node.id, { requestId: 'manual-wiring-answer-1', selections: [planned.options[0].id], freeText: '約 1.5 吋。' });
  assert.equal(answered.status, 'waiting-user'); assert.equal(askCalls, 5); assert.ok(outlinedMaps.length >= 2);
  assert.equal(view.map.mindSearch.branches.length, 1);
  const branch = view.map.mindSearch.branches[0], researchRefs = branch.results.filter(item => item.kind === 'research');
  const conclusionRef = branch.results.find(item => item.kind === 'synthesis');
  assert.equal(researchRefs.length, 2);
  assert.equal(view.map.nodes.find(node => node.id === conclusionRef.nodeId).mindSearchKind, 'synthesis');
  assert.ok(view.map.nodes.some(node => node.id === answered.questionNodeId && node.parentId === conclusionRef.nodeId && !node.mindSearchConvergesFromNodeIds?.length), 'the next question is a child of synthesis without dashed convergence edges');
  assert.ok(outlinedMaps.some(entry => researchRefs.every(ref => entry.map.nodes.some(node => node.id === ref.nodeId && node.mindSearchKind === 'research'))));
});
integrationTest('Visual Map permits telemetry gaps but keeps an explicit no-search Agent report incomplete', async () => {
  const { repo } = fixture(); const { createMindSearchMap } = load('experiences/mind-search/create-map.ts');
  const { MindSearchRunStore } = load('mindsearch-mve/research-run-store.ts'); const { MindSearchManualFlow } = load('experiences/mind-search/manual-flow.ts');
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const makeCase = async (suffix, report, shouldComplete) => {
    const created = await createMindSearchMap(repo, 'gpt-6-luna', { requestId: `search-status-map-${suffix}`, topic: `牛排熟度 ${suffix}`, context: '' });
    const planner = new MindSearchManualFlow(repo, new MindSearchRunStore(repo), async () => ({ summary: '想要哪種熟度？', detail: '', suggestions: [{ title: '偏紅' }, { title: '較熟' }], visualReferences: [] }));
    const planned = await planner.planNextQuestion(created.mapPath, created.root.id, 'gpt-6-luna', 'low', `search-status-question-${suffix}`);
    const plugin = { repo, settings: { ...DEFAULT_SETTINGS }, mutate: async work => work(), syncOutline() {}, askModel: async context => mindSearchPhase(context, 'saved-evidence-review') ? savedEvidenceNeedsSearch() : mindSearchPhase(context, 'decision-quality-review') ? auditEcho(context) : mindSearchPhase(context, 'research-plan')
      ? { summary: '兩個研究面向', detail: '<!-- mindsearch-plan {"subtopics":[{"id":"safety","title":"食安依據","task":"查詢安全溫度","expectedValue":"確認安全條件"},{"id":"method","title":"操作方法","task":"查詢料理方式","expectedValue":"補足操作步驟"}]} -->', suggestions: [], visualReferences: [] }
      : mindSearchPhase(context, 'report-review') ? plannerReview('ask_user', { rationale: '牛排厚度會改變加熱時間和溫度控制，無法從已提供的偏好推斷。', question: '牛排大約有多厚？' }, '來源報告提供熟度限制；請補充厚度以細化操作建議。', '在得知厚度前不推定固定時間。', ['薄於 2 公分', '約 2–4 公分', '厚於 4 公分'])
      : context.researchMode === 'local' ? plannerReview('conclude', { rationale: '既有條件足夠。', stopReason: '不需要新增問題。' }, '條件式結論', '保留限制。') : report };
    const view = new VisualAgentMapView({ app: {} }, plugin);
    view.path = created.mapPath; view.map = await repo.readMap(created.mapPath); view.notes.set(planned.node.id, await repo.readNote(planned.node.path)); view.render = () => {};
    const input = { requestId: `search-status-answer-${suffix}`, selections: [planned.options[0].id], freeText: '' };
    let diagnosticPath = '';
    const updateNote = repo.updateNote.bind(repo);
    if (!shouldComplete) repo.updateNote = async (notePath, patch) => {
      if (patch.status === 'error' && patch.detail?.includes('MindSearch incomplete-attempt diagnostic')) diagnosticPath = notePath;
      return updateNote(notePath, patch);
    };
    if (shouldComplete) {
      const outcome = await view.submitMindSearchAnswer(planned.node.id, input); assert.equal(outcome.status, 'waiting-user');
    } else {
      await assert.rejects(view.submitMindSearchAnswer(planned.node.id, input), /explicitly says no web search succeeded/);
      repo.updateNote = updateNote;
    }
    const saved = await repo.readMap(created.mapPath), branch = saved.mindSearch.branches[0];
    if (shouldComplete) { assert.equal(branch.results.filter(item => item.kind === 'research').length, 2); assert.equal(branch.results.find(item => item.kind === 'synthesis').kind, 'synthesis'); assert.ok(saved.mindSearch.runs.every(run => run.attempts[0].status === 'completed')); }
    else {
      assert.equal(branch.results.length, 0); assert.equal(saved.mindSearch.runs[0].attempts[0].status, 'failed'); assert.equal(saved.mindSearch.resultDrafts.length, 0);
      assert.ok(diagnosticPath, 'the unusable report remains visible as a Repository error diagnostic');
      const diagnostic = await repo.readNote(diagnosticPath); assert.equal(diagnostic.status, 'error'); assert.match(diagnostic.detail, /incomplete-attempt diagnostic/); assert.match(diagnostic.detail, /Research status: not searched/);
    }
  };
  await makeCase('explicit-miss', { summary: 'Research status: not searched — the search service was unavailable.', detail: 'No external search was completed.', suggestions: [], visualReferences: [] }, false);
  await makeCase('telemetry-gap', { summary: 'Useful report with conditional findings.', detail: 'The report contains useful findings and limits but no status telemetry was delivered.', suggestions: [], visualReferences: [] }, true);
});
integrationTest('MindSearch keeps changed answers on independent question pivots with direct research children', async () => {
  const { repo, mapPath, question, store } = await mindSearchMapFixture();
  const questionMap = await repo.readMap(mapPath), questionNode = questionMap.nodes.find(node => node.id === question.id);
  questionNode.mindSearchKind = 'question';
  questionNode.mindSearchQuestion = { requestId: 'independent-answer-question', parentBranchId: null, options: [{ id: 'medium-rare', label: '偏紅熟度' }, { id: '安全建議優先', label: '安全優先' }], allowMultiple: true, allowFreeText: true };
  await repo.saveMap(mapPath, questionMap);
  const inputSnapshot = { topic: '在家煎牛排', conditions: { equipment: 'cast iron' }, upstreamResults: [{ notePath: 'existing/report.md', version: 1 }] };
  const firstBranch = await store.createAnswerBranch(mapPath, { questionNodeId: question.id, parentBranchId: null, answerSnapshot: { selections: ['medium-rare'], freeText: '厚約 1.5 吋' }, inputSnapshot });
  const firstAttempt = await store.startAttempt(mapPath, firstBranch.id, 'run-medium-rare');
  const firstDraft = (await store.createResultDraft(mapPath, firstAttempt, '偏紅熟度建議', 'gpt-6-luna')).draft;
  assert.equal((await store.commitResult(mapPath, firstAttempt, firstDraft.id, { summary: '偏紅熟度條件式建議', detail: '分支一的獨立研究結果。' })).status, 'committed');

  const secondBranch = await store.createAnswerBranch(mapPath, { questionNodeId: question.id, parentBranchId: null, answerSnapshot: { selections: ['安全建議優先'], freeText: '接受較熟的建議' }, inputSnapshot });
  const pivotMap = await repo.readMap(mapPath);
  const firstQuestion = pivotMap.nodes.find(node => node.id === firstBranch.questionNodeId);
  const secondQuestion = pivotMap.nodes.find(node => node.id === secondBranch.questionNodeId);
  assert.ok(firstQuestion, 'the first answer must remain on its question pivot');
  assert.ok(secondQuestion, 'a different answer must get its own question pivot');
  assert.equal(firstQuestion.mindSearchKind, 'question');
  assert.equal(secondQuestion.mindSearchKind, 'question');
  assert.equal(firstQuestion.id, question.id);
  assert.notEqual(firstQuestion.id, secondQuestion.id);
  assert.equal(pivotMap.nodes.some(node => node.mindSearchKind === 'answer'), false, 'answer submissions must not create answer pivot nodes');
  const secondAttempt = await store.startAttempt(mapPath, secondBranch.id, 'run-safety-first');
  const secondDraft = (await store.createResultDraft(mapPath, secondAttempt, '安全優先建議', 'gpt-6-luna')).draft;
  assert.equal((await repo.readMap(mapPath)).nodes.find(node => node.id === firstDraft.nodeId).parentId, firstBranch.questionNodeId);
  assert.equal((await repo.readMap(mapPath)).nodes.find(node => node.id === secondDraft.nodeId).parentId, secondBranch.questionNodeId);
  assert.equal((await store.commitResult(mapPath, secondAttempt, secondDraft.id, { summary: '安全優先條件式建議', detail: '分支二的不同研究結果。' })).status, 'committed');

  const savedMap = await repo.readMap(mapPath), state = savedMap.mindSearch;
  assert.notEqual(firstBranch.id, secondBranch.id);
  assert.equal(state.branches.length, 2);
  assert.deepEqual(plain(state.branches.map(branch => branch.answerSnapshot)), [
    { selections: ['medium-rare'], freeText: '厚約 1.5 吋' },
    { selections: ['安全建議優先'], freeText: '接受較熟的建議' }
  ]);
  assert.deepEqual(plain(state.branches.map(branch => branch.results.length)), [1, 1]);
  assert.equal(state.branches[0].results[0].nodeId, firstDraft.nodeId);
  assert.equal(state.branches[1].results[0].nodeId, secondDraft.nodeId);
  assert.notEqual(firstDraft.notePath, secondDraft.notePath);
  assert.equal((await repo.readNote(firstDraft.notePath)).detail, '分支一的獨立研究結果。');
  assert.equal((await repo.readNote(secondDraft.notePath)).detail, '分支二的不同研究結果。');
});
integrationTest('MindSearch explicit re-answer removes legacy answer pivots, reconnects research, and preserves pivot notes', async () => {
  const { repo, mapPath, question, store } = await mindSearchMapFixture();
  const branch = await store.createAnswerBranch(mapPath, { questionNodeId: question.id, parentBranchId: null, answerSnapshot: { selections: [], freeText: '文化古蹟與博物館' }, inputSnapshot: { topic: '台北一日遊', conditions: {}, upstreamResults: [] } });
  const attempt = await store.startAttempt(mapPath, branch.id, 'legacy-run');
  const draft = (await store.createResultDraft(mapPath, attempt, '文化古蹟研究', 'gpt-6-luna')).draft;
  await store.commitResult(mapPath, attempt, draft.id, { summary: '文化古蹟', detail: '既有研究。' });

  const legacy = await repo.readMap(mapPath), legacyBranch = legacy.mindSearch.branches[0];
  const oldPivot = await repo.createNote('舊答案支點', 'gpt-6-luna', legacy, mapPath, 'workspace', { summary: '舊答案', detail: '保留這個 Markdown 檔案。' });
  oldPivot.parentId = legacyBranch.questionNodeId;
  oldPivot.mindSearchKind = 'answer';
  legacy.nodes.push(oldPivot);
  legacyBranch.answerNodeId = oldPivot.id;
  legacy.nodes.find(node => node.id === draft.nodeId).parentId = oldPivot.id;
  await repo.saveMap(mapPath, legacy);

  assert.ok(await store.recoverAnswerBranches(mapPath) > 0);
  const restored = await repo.readMap(mapPath), restoredBranch = restored.mindSearch.branches[0];
  assert.equal(restoredBranch.answerNodeId, undefined);
  assert.equal(restored.nodes.some(node => node.id === oldPivot.id), false, 'the legacy answer pivot is removed from the Map');
  assert.equal(restored.nodes.find(node => node.id === draft.nodeId).parentId, restoredBranch.questionNodeId);
  assert.equal((await repo.readNote(oldPivot.path)).summary, '舊答案', 'migration preserves the old Markdown note');
});
integrationTest('MindSearch resumes a failed search on the saved answer without duplicating its branch', async () => {
  const { repo, mapPath, question, store } = await mindSearchMapFixture();
  const map = await repo.readMap(mapPath), questionNode = map.nodes.find(node => node.id === question.id);
  questionNode.mindSearchKind = 'question';
  questionNode.mindSearchQuestion = { requestId: 'planning-retry-question', parentBranchId: null, options: [{ id: 'history', label: '歷史街區' }, { id: 'museum', label: '博物館' }], allowMultiple: false, allowFreeText: true };
  await repo.saveMap(mapPath, map);
  const { MindSearchManualFlow } = load('experiences/mind-search/manual-flow.ts');
  let failSearch = true;
  const flow = new MindSearchManualFlow(repo, store, async context => {
    if (mindSearchPhase(context, 'research-plan')) return { summary: '路線與無障礙條件', detail: '<!-- mindsearch-plan {"subtopics":[{"id":"route","title":"路線選項","task":"研究可行路線與轉乘","expectedValue":"比較路線方案"},{"id":"access","title":"無障礙條件","task":"研究無障礙步行與車站資訊","expectedValue":"確認實際通行限制"}]} -->', suggestions: [], visualReferences: [] };
    if (context.researchMode === 'research') return failSearch
      ? { summary: 'Search unavailable', detail: 'Research status: unavailable', suggestions: [], visualReferences: [] }
      : { summary: 'Route evidence', detail: 'Research status: search completed\nA step-free transit route report with its limits.', suggestions: [], visualReferences: [] };
    if (mindSearchPhase(context, 'report-review')) return plannerReview('ask_user', { rationale: 'The route report supports a conditional answer, but travel-time preference remains unknown.', question: 'Should the route prioritize the shortest walk or the fewest transfers?' }, 'Use the saved route evidence conditionally until the travel preference is clear.', 'Do not infer a preference from the saved answer.', ['Shortest walk', 'Fewest transfers']);
    throw new Error(`Unexpected model request: ${context.task.slice(0, 100)}`);
  });
  const input = { requestId: 'saved-answer-planner-retry', selections: ['history'], freeText: '以大眾運輸為主' };
  await assert.rejects(flow.answerAndResearch(mapPath, question.id, input, 'gpt-6-luna', 'low'), /no web search succeeded/);
  let saved = await repo.readMap(mapPath), branch = saved.mindSearch.branches[0];
  assert.equal(saved.mindSearch.branches.length, 1, 'a failed search preserves one answer branch');
  assert.deepEqual(plain(branch.researchPlan.map(item => item.id)), ['route', 'access']);
  assert.equal(branch.results.length, 0);
  const failedRun = saved.mindSearch.runs.find(run => run.branchId === branch.id);
  assert.ok(failedRun?.attempts.some(attempt => attempt.status === 'failed'), 'failed search state is persisted for resumption');
  const answerSnapshot = plain(branch.answerSnapshot), branchId = branch.id;
  failSearch = false;
  const retried = await flow.resumeAnswerResearch(mapPath, branchId, 'gpt-6-luna', 'low');
  assert.equal(retried.status, 'waiting-user');
  saved = await repo.readMap(mapPath); branch = saved.mindSearch.branches.find(item => item.id === branchId);
  assert.equal(saved.mindSearch.branches.length, 1, 'resume reuses the saved answer instead of creating a duplicate branch');
  assert.deepEqual(plain(branch.answerSnapshot), answerSnapshot);
  assert.deepEqual(plain(branch.researchPlan.map(item => item.id)), ['route', 'access']);
  const research = branch.results.filter(item => item.kind === 'research');
  assert.equal(research.length, 2);
  assert.ok(research.every(item => saved.nodes.find(node => node.id === item.nodeId).parentId === branch.questionNodeId));
});
integrationTest('MindSearch researches every planned subtopic independently and keeps re-answers in a new branch', async () => {
  const { repo } = fixture(); const { createMindSearchMap } = load('experiences/mind-search/create-map.ts');
  const created = await createMindSearchMap(repo, 'gpt-6-luna', { requestId: 'multi-subtopic-map', topic: '如何選擇牛排熟度？', context: '有溫度計。', minimumAnswersBeforeConclusion: 3 });
  const { MindSearchRunStore } = load('mindsearch-mve/research-run-store.ts'); const { MindSearchManualFlow } = load('experiences/mind-search/manual-flow.ts');
  let call = 0, synthesisCalls = 0;
  const flow = new MindSearchManualFlow(repo, new MindSearchRunStore(repo), async context => {
    call++;
    if (mindSearchPhase(context, 'saved-evidence-review')) return savedEvidenceNeedsSearch();
    if (mindSearchPhase(context, 'research-plan')) return { summary: '安全與口感兩個面向', detail: '<!-- mindsearch-plan {"subtopics":[{"id":"safety","title":"安全溫度","task":"查詢牛排安全溫度","expectedValue":"確認安全底線"},{"id":"texture","title":"口感差異","task":"比較不同熟度口感","expectedValue":"呈現口感取捨"}]} -->', suggestions: [], visualReferences: [] };
    const delivery = deliveryFixture(context); if (delivery) return delivery;
    if (context.task.includes('Decide whether one missing user condition')) return { summary: '偏好哪種熟度？', detail: '用於收斂建議。', suggestions: [{ title: '偏嫩', task: '', contribution: '' }, { title: '較熟', task: '', contribution: '' }], visualReferences: [] };
    if (mindSearchPhase(context, 'report-review')) {
      synthesisCalls++;
      if (synthesisCalls === 1) {
        assert.match(context.task, /Prior questions:/);
        assert.match(context.task, /do not require reaching 10 or add quota filler/);
        assert.match(context.task, /Ask only for a genuinely missing user condition/);
      }
      return synthesisCalls < 3
        ? plannerReview('ask_user', { rationale: '肉排厚度會影響火候和烹調時間。', question: synthesisCalls === 1 ? '這次牛排大約多厚？' : '能提前多久準備？' }, '下一步先確認牛排厚度。', '依厚度調整火候與時間。', ['薄於 2 公分', '約 2–4 公分', '厚於 4 公分'])
        : plannerReview('conclude', { rationale: '兩題答案與所有研究已足以完成結果。', stopReason: '已回答至少兩題。' }, '依兩題答案收斂最終建議。', '安全底線、口感取捨與操作條件已整合。');
    }
    return { summary: '已完成此答案的研究。', detail: 'Research status: search completed\n來源報告與限制。', suggestions: [], visualReferences: [] };
  });
  const question = await flow.planNextQuestion(created.mapPath, created.root.id, 'gpt-6-luna', 'low', 'multi-subtopic-question');
  const first = await flow.answerAndResearch(created.mapPath, question.node.id, { requestId: 'multi-subtopic-answer-a', selections: [question.options[0].id], freeText: '' }, 'gpt-6-luna', 'low');
  assert.equal(first.status, 'waiting-user');
  let saved = await repo.readMap(created.mapPath), branch = saved.mindSearch.branches[0];
  assert.deepEqual(plain(branch.researchPlan.map(item => item.id)), ['safety', 'texture']);
  assert.equal(branch.results.filter(item => item.kind === 'research').length, 2);
  const reports = branch.results.filter(item => item.kind === 'research');
  assert.equal(branch.answerNodeId, undefined, 'answers are stored on the question branch, without an answer pivot');
  assert.ok(reports.every(item => saved.nodes.find(node => node.id === item.nodeId)?.parentId === branch.questionNodeId), 'the answer research target must grow directly from its answered question');
  const synthesis = branch.results.find(item => item.kind === 'synthesis');
  const convergenceNode = saved.nodes.find(item => item.id === synthesis.nodeId);
  assert.deepEqual(plain(convergenceNode.mindSearchConvergesFromNodeIds), plain(reports.map(item => item.nodeId)));
  const followup = saved.nodes.find(item => item.id === first.questionNodeId);
  assert.equal(followup.parentId, synthesis.nodeId);
  assert.equal(followup.mindSearchConvergesFromNodeIds, undefined, 'only the synthesis node converges research subtopics');
  const second = await flow.answerAndResearch(created.mapPath, first.questionNodeId, { requestId: 'multi-subtopic-answer-b', selections: [first.status === 'waiting-user' ? saved.nodes.find(item => item.id === first.questionNodeId).mindSearchQuestion.options[1].id : question.options[1].id], freeText: '我重視快速完成。' }, 'gpt-6-luna', 'low');
  assert.equal(second.status, 'waiting-user');
  const nextMap = await repo.readMap(created.mapPath), thirdQuestion = nextMap.nodes.find(n => n.id === second.questionNodeId);
  const third = await flow.answerAndResearch(created.mapPath, thirdQuestion.id, { requestId: 'multi-subtopic-answer-c', selections: [thirdQuestion.mindSearchQuestion.options[0].id], freeText: 'Third condition' }, 'gpt-6-luna', 'low');
  assert.equal(third.status, 'completed');
  saved = await repo.readMap(created.mapPath);
  assert.equal(saved.mindSearch.branches.length, 3);
  assert.notEqual(saved.mindSearch.branches[0].id, saved.mindSearch.branches[1].id);
  assert.equal(saved.mindSearch.branches[1].parentBranchId, saved.mindSearch.branches[0].id);
  assert.equal(saved.mindSearch.branches[1].results.filter(item => item.kind === 'research').length, 2);
  assert.ok(saved.mindSearch.branches[2].results.some(item => item.kind === 'conclusion'));
  assert.equal(synthesisCalls, 3);
  assert.ok(call >= 8, 'all three answers run research and delivery stages');
});
integrationTest('opening a saved map clears legacy question convergence edges but keeps synthesis edges', async () => {
  const persisted = map([
    { ...node('question'), mindSearchKind: 'question', mindSearchConvergesFromNodeIds: ['research'] },
    { ...node('research', 'question'), mindSearchKind: 'research' },
    { ...node('synthesis', 'question'), mindSearchKind: 'synthesis', mindSearchConvergesFromNodeIds: ['research'] }
  ]);
  let saved;
  const repo = { readMap: async () => structuredClone(persisted), saveMap: async (_path, value) => { saved = structuredClone(value); } };
  const plugin = { repo, settings: {}, mutate: work => work(), closeStaleDetails() {} };
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app: { workspace: { requestSaveLayout() {} } } }, plugin);
  view.render = () => {}; view.hydrate = async () => {};
  await view.openMap('legacy.md');
  assert.ok(saved, 'opening a legacy map persists the one-time cleanup');
  assert.equal(saved.nodes[0].mindSearchConvergesFromNodeIds, undefined);
  assert.deepEqual(plain(saved.nodes[2].mindSearchConvergesFromNodeIds), ['research']);
});
integrationTest('MindSearch persists cancellation and fences late draft/result writes', async () => {
  const { repo, mapPath, question, store } = await mindSearchMapFixture();
  const branch = await store.createAnswerBranch(mapPath, { questionNodeId: question.id, parentBranchId: null, answerSnapshot: { selections: [], freeText: 'synthetic answer' }, inputSnapshot: { topic: 'steak', conditions: {}, upstreamResults: [] } });
  const attempt = await store.startAttempt(mapPath, branch.id, 'run-cancelled');
  const draft = (await store.createResultDraft(mapPath, attempt, '待取消結果', 'gpt-6-luna')).draft;
  assert.equal(await store.cancelAttempt(mapPath, attempt, 'User cancelled after runtime interrupt.'), true);
  let savedMap = await repo.readMap(mapPath);
  assert.equal(savedMap.mindSearch.runs[0].attempts[0].status, 'cancelled');
  assert.equal(savedMap.mindSearch.runs[0].attempts[0].stopReason, 'User cancelled after runtime interrupt.');
  assert.equal(savedMap.mindSearch.resultDrafts.length, 0);
  assert.equal(savedMap.mindSearch.branches[0].results.length, 0);
  assert.equal(savedMap.nodes.some(node => node.id === draft.nodeId), false);
  const diagnostic = await repo.readNote(draft.notePath);
  assert.equal(diagnostic.status, 'error');
  assert.match(diagnostic.detail, /User cancelled after runtime interrupt/);
  assert.deepEqual(plain(await store.createResultDraft(mapPath, attempt, '晚到結果不得建立', 'gpt-6-luna')), { status: 'stale', runId: 'run-cancelled', attemptId: 'attempt-1' });
  assert.deepEqual(plain(await store.commitResult(mapPath, attempt, draft.id, { summary: 'late result', detail: 'must not publish' })), { status: 'stale', runId: 'run-cancelled', attemptId: 'attempt-1' });
  savedMap = await repo.readMap(mapPath);
  assert.equal(savedMap.mindSearch.runs[0].attempts[0].status, 'cancelled');
  assert.equal(savedMap.mindSearch.branches[0].results.length, 0);
  assert.notEqual((await repo.readNote(draft.notePath)).summary, 'late result');
});
integrationTest('Visual Map reopen recovers a pending Note/Map commit and marks a stopped runtime as failed without rerunning', async () => {
  const { repo, app, mapPath, question, store } = await mindSearchMapFixture();
  const branch = await store.createAnswerBranch(mapPath, { questionNodeId: question.id, parentBranchId: null, answerSnapshot: { selections: [], freeText: 'synthetic answer' }, inputSnapshot: { topic: 'steak', conditions: {}, upstreamResults: [] } });
  const attempt = await store.startAttempt(mapPath, branch.id, 'run-reopen-save');
  const draft = (await store.createResultDraft(mapPath, attempt, '重開後提交修復', 'gpt-6-luna')).draft;
  const saveMap = repo.saveMap.bind(repo); let saveCalls = 0;
  repo.saveMap = async (...args) => { if (++saveCalls === 2) throw new Error('injected interruption after pending Note write'); return saveMap(...args); };
  await assert.rejects(store.commitResult(mapPath, attempt, draft.id, { summary: 'saved summary', detail: 'Searcher report and Planner conclusion.' }), /injected interruption/);
  repo.saveMap = saveMap; store.releaseAttempt(mapPath, attempt);
  app.workspace = { requestSaveLayout() {} };
  const { VisualAgentMapView } = load('main.ts', { obsidian }); const plugin = { repo, settings: { ...DEFAULT_SETTINGS }, mutate: async work => work(), closeStaleDetails() {}, syncOutline() {} };
  const view = new VisualAgentMapView({ app }, plugin); view.render = () => {}; view.hydrate = async () => {};
  await view.openMap(mapPath);
  let saved = await repo.readMap(mapPath), committed = saved.mindSearch.branches[0].results[0];
  assert.ok(committed); assert.equal(saved.mindSearch.runs[0].attempts[0].status, 'completed');
  assert.equal(saved.mindSearch.pendingCommits.length, 0); assert.equal((await repo.readNote(committed.notePath)).detail, 'Searcher report and Planner conclusion.');

  const interrupted = await store.startAttempt(mapPath, branch.id, 'run-app-exit');
  const interruptedDraft = (await store.createResultDraft(mapPath, interrupted, 'App 結束前未完成', 'gpt-6-luna')).draft;
  store.releaseAttempt(mapPath, interrupted);
  await view.openMap(mapPath);
  saved = await repo.readMap(mapPath);
  const stopped = saved.mindSearch.runs.find(run => run.id === 'run-app-exit').attempts[0];
  assert.equal(stopped.status, 'failed'); assert.match(stopped.stopReason, /Retry is available/);
  assert.equal(saved.mindSearch.resultDrafts.some(item => item.id === interruptedDraft.id), false);
  assert.equal(saved.nodes.some(node => node.id === interruptedDraft.nodeId), false);
  assert.equal((await repo.readNote(interruptedDraft.notePath)).status, 'error');
});
integrationTest('Visual Map close cancels unfinished MindSearch work but lets an already-started subtopic commit finish', async () => {
  const makeQuestion = async () => {
    const { repo } = fixture(); const { createMindSearchMap } = load('experiences/mind-search/create-map.ts');
    const created = await createMindSearchMap(repo, 'gpt-6-luna', { requestId: 'close-save-map', topic: '牛排熟度', context: '' });
    const { MindSearchRunStore } = load('mindsearch-mve/research-run-store.ts'); const { MindSearchManualFlow } = load('experiences/mind-search/manual-flow.ts');
    const planner = new MindSearchManualFlow(repo, new MindSearchRunStore(repo), async () => ({ summary: '偏好熟度？', detail: '由使用者決定。', suggestions: [{ title: '偏紅' }, { title: '較熟' }], visualReferences: [] }));
    const planned = await planner.planNextQuestion(created.mapPath, created.root.id, 'gpt-6-luna', 'low', 'close-save-question');
    return { repo, mapPath: created.mapPath, question: planned.node };
  };
  const { repo, mapPath, question } = await makeQuestion();
  let releaseSearcher, searcherStarted; const searcherReady = new Promise(resolve => { searcherStarted = resolve; });
  const plugin = { repo, settings: { language: 'zh-TW', cliModel: 'gpt-6-luna' }, mutate: async work => work(), syncOutline() {},
    askModel: async (context, _model, _reasoning, _signal, _onExchange, _onAccepted, onWebSearchEvent) => {
      if (mindSearchPhase(context, 'saved-evidence-review')) return savedEvidenceNeedsSearch();
      if (mindSearchPhase(context, 'research-plan')) return { summary: '安全與操作面向', detail: '<!-- mindsearch-plan {"subtopics":[{"id":"a","title":"安全溫度","task":"查詢安全溫度","expectedValue":"保留安全條件"},{"id":"b","title":"烹調方法","task":"查詢烹調方法","expectedValue":"提供實作方式"}]} -->', suggestions: [], visualReferences: [] };
      if (mindSearchPhase(context, 'decision-quality-review')) return auditEcho(context);
      if (mindSearchPhase(context, 'report-review')) return plannerReview('conclude', { rationale: '兩份報告足以整理本次答案。', stopReason: '完成指定收斂。' }, '條件式結論', '保存邊界測試。');
      if (context.researchMode === 'research') { onWebSearchEvent?.({ method: 'item/completed', params: { item: { id: 'fixture-search', type: 'webSearch', action: { type: 'search' } } } }); searcherStarted(); return new Promise(resolve => { releaseSearcher = () => resolve({ summary: '晚到研究摘要', detail: '關閉後不應發布的報告。', suggestions: [], visualReferences: [] }); }); }
      return plannerReview('conclude', { rationale: 'The report supports the controlled persistence conclusion.', stopReason: 'The answer is sufficiently supported.' }, '條件式結論', '保存邊界測試。');
    } };
  const { VisualAgentMapView } = load('main.ts', { obsidian }); const view = new VisualAgentMapView({ app: {} }, plugin);
  view.path = mapPath; view.map = await repo.readMap(mapPath); view.notes.set(question.id, await repo.readNote(question.path)); view.render = () => {};
  const controller = new AbortController(); view.mindSearchController = controller; view.mindSearchBusy = true;
  const cancelled = view.submitMindSearchAnswer(question.id, { requestId: 'close-during-searcher', selections: [question.mindSearchQuestion.options[0].id], freeText: '' }, controller.signal);
  await searcherReady; await view.onClose(); releaseSearcher();
  await assert.rejects(cancelled, error => error?.name === 'AbortError');
  let saved = await repo.readMap(mapPath);
  assert.equal(saved.mindSearch.runs[0].attempts[0].status, 'cancelled');
  assert.equal(saved.mindSearch.branches[0].results.length, 0);
  assert.equal(saved.mindSearch.resultDrafts.length, 0);

  const second = await makeQuestion(); let releaseCommit, commitStarted;
  const commitReady = new Promise(resolve => { commitStarted = resolve; });
  const updateNote = second.repo.updateNote.bind(second.repo);
  second.repo.updateNote = async (path, patch) => {
    if (patch.status === 'completed') { commitStarted(); await new Promise(resolve => { releaseCommit = resolve; }); }
    return updateNote(path, patch);
  };
  const commitPlugin = { repo: second.repo, settings: { language: 'zh-TW', cliModel: 'gpt-6-luna' }, mutate: async work => work(), syncOutline() {},
    askModel: async (context, _model, _reasoning, _signal, _onExchange, _onAccepted, onWebSearchEvent) => mindSearchPhase(context, 'saved-evidence-review') ? savedEvidenceNeedsSearch() : mindSearchPhase(context, 'research-plan')
      ? { summary: '安全與操作面向', detail: '<!-- mindsearch-plan {"subtopics":[{"id":"a","title":"安全溫度","task":"查詢安全溫度","expectedValue":"保留安全條件"},{"id":"b","title":"烹調方法","task":"查詢烹調方法","expectedValue":"提供實作方式"}]} -->', suggestions: [], visualReferences: [] }
      : mindSearchPhase(context, 'decision-quality-review') ? auditEcho(context)
      : mindSearchPhase(context, 'report-review') ? plannerReview('conclude', { rationale: '兩份報告足以整理本次答案。', stopReason: '完成原子提交。' }, '保存中的結論', '完成原子提交。')
      : (onWebSearchEvent?.({ method: 'item/completed', params: { item: { id: 'fixture-search', type: 'webSearch', action: { type: 'search' } } } }), { summary: '已回傳報告', detail: 'Searcher report。', suggestions: [], visualReferences: [] }) };
  const savingView = new VisualAgentMapView({ app: {} }, commitPlugin); savingView.path = second.mapPath; savingView.map = await second.repo.readMap(second.mapPath); savingView.notes.set(second.question.id, await second.repo.readNote(second.question.path)); savingView.render = () => {};
  const saveController = new AbortController(); savingView.mindSearchController = saveController; savingView.mindSearchBusy = true;
  const saving = savingView.submitMindSearchAnswer(second.question.id, { requestId: 'close-during-result-commit', selections: [second.question.mindSearchQuestion.options[0].id], freeText: '' }, saveController.signal);
  await commitReady; await savingView.onClose(); releaseCommit();
  await assert.rejects(saving, error => error?.name === 'AbortError'); saved = await second.repo.readMap(second.mapPath);
  assert.equal(saved.mindSearch.runs[0].attempts[0].status, 'completed', 'closing does not revoke a subtopic save already in its commit section');
  assert.equal(saved.mindSearch.pendingCommits.length, 0); assert.equal(saved.mindSearch.branches[0].results.length, 1);
});
integrationTest('MindSearch serializes cancellation against an in-flight runtime result save', async () => {
  const { repo, mapPath, question, store } = await mindSearchMapFixture();
  const branch = await store.createAnswerBranch(mapPath, { questionNodeId: question.id, parentBranchId: null, answerSnapshot: { selections: [], freeText: 'synthetic answer' }, inputSnapshot: { topic: 'steak', conditions: {}, upstreamResults: [] } });
  const attempt = await store.startAttempt(mapPath, branch.id, 'run-cancel-save-race');
  const draft = (await store.createResultDraft(mapPath, attempt, '受控 runtime 結果', 'gpt-6-luna')).draft;
  let releaseWrite;
  let announceWrite;
  const writeStarted = new Promise(resolve => { announceWrite = resolve; });
  const holdWrite = new Promise(resolve => { releaseWrite = resolve; });
  const updateNote = repo.updateNote.bind(repo);
  repo.updateNote = async (...args) => { announceWrite(); await holdWrite; return updateNote(...args); };
  const runtimeResult = Promise.resolve({ summary: 'controlled runtime result', detail: 'A result returned before cancellation acquired the store lock.' });
  const commit = runtimeResult.then(result => store.commitResult(mapPath, attempt, draft.id, result));
  await writeStarted;
  const cancel = store.cancelAttempt(mapPath, attempt, 'Cancellation requested while result save was in progress.');
  releaseWrite();
  const committed = await commit;
  const cancelled = await cancel;
  repo.updateNote = updateNote;

  assert.equal(committed.status, 'committed');
  assert.equal(cancelled, false, 'the store treats a save already in its commit section as committed before cancellation takes effect');
  const savedMap = await repo.readMap(mapPath), savedNote = await repo.readNote(draft.notePath);
  assert.equal(savedMap.mindSearch.runs[0].attempts[0].status, 'completed');
  assert.equal(savedMap.mindSearch.pendingCommits.length, 0);
  assert.equal(savedMap.mindSearch.resultDrafts.length, 0);
  assert.equal(savedMap.mindSearch.branches[0].results.length, 1);
  assert.equal(savedMap.mindSearch.branches[0].results[0].notePath, draft.notePath);
  assert.equal(savedNote.status, 'completed');
  assert.equal(savedNote.summary, 'controlled runtime result');
  assert.equal(savedNote.detail, 'A result returned before cancellation acquired the store lock.');
});
integrationTest('MindSearch persists a runtime initialization blocker as failed and fences late publication', async () => {
  const { repo, mapPath, question, store } = await mindSearchMapFixture();
  const branch = await store.createAnswerBranch(mapPath, { questionNodeId: question.id, parentBranchId: null, answerSnapshot: { selections: [], freeText: '合成答案' }, inputSnapshot: { topic: '牛排', conditions: {}, upstreamResults: [] } });
  const attempt = await store.startAttempt(mapPath, branch.id, 'run-runtime-blocked');
  const beforeRuntime = await repo.readMap(mapPath);
  assert.equal(beforeRuntime.nodes.length, 1, 'the answer remains on the question; no answer pivot is created');
  assert.equal(beforeRuntime.nodes[0].mindSearchKind, undefined);
  const unrelated = await repo.createNote('既有無關筆記', 'gpt-6-luna', await repo.readMap(mapPath), mapPath, 'workspace', { summary: '保留原內容' });
  await repo.updateNote(unrelated.path, { detail: '既有正文不可覆蓋' });
  await assert.rejects(store.commitResult(mapPath, attempt, unrelated.path, { summary: 'must stay absent', detail: 'no publication after startup block' }), /fresh, registered result draft/);
  assert.equal(await store.failAttempt(mapPath, attempt, 'Codex runtime 初始化被執行環境拒絕；未 dispatch thread/turn。'), true);
  assert.equal((await store.commitResult(mapPath, attempt, unrelated.path, { summary: 'late output', detail: 'must remain fenced' })).status, 'stale');
  const savedMap = await repo.readMap(mapPath), savedNote = await repo.readNote(unrelated.path);
  assert.equal(savedMap.mindSearch.runs[0].attempts[0].status, 'failed');
  assert.match(savedMap.mindSearch.runs[0].attempts[0].stopReason, /未 dispatch thread\/turn/);
  assert.equal(savedNote.summary, '保留原內容'); assert.equal(savedNote.detail, '既有正文不可覆蓋');
});
integrationTest('MindSearch recovers an interrupted result-draft creation idempotently', async () => {
  const { repo, mapPath, question, store, files } = await mindSearchMapFixture();
  const branch = await store.createAnswerBranch(mapPath, { questionNodeId: question.id, parentBranchId: null, answerSnapshot: { selections: [], freeText: '合成答案' }, inputSnapshot: { topic: '牛排', conditions: {}, upstreamResults: [] } });
  const attempt = await store.startAttempt(mapPath, branch.id, 'run-draft-recovery');
  const realSaveMap = repo.saveMap.bind(repo); let mapWrites = 0;
  repo.saveMap = async (...args) => { mapWrites++; if (mapWrites === 2) throw new Error('simulated interruption after draft Note creation'); return realSaveMap(...args); };
  await assert.rejects(store.createResultDraft(mapPath, attempt, '結果草稿', 'gpt-6-luna'), /simulated interruption/);
  repo.saveMap = realSaveMap;
  store.releaseAttempt(mapPath, attempt);
  const pending = await repo.readMap(mapPath), draft = pending.mindSearch.resultDrafts[0];
  assert.equal(draft.status, 'creating'); assert.ok(files.has(draft.notePath));
  let expensiveResearchRuns = 1;
  const recovered = plain(await store.recoverPending(mapPath));
  assert.deepEqual(recovered, { recovered: [draft.id], stale: [] });
  assert.equal(expensiveResearchRuns, 1);
  assert.equal((await repo.readMap(mapPath)).mindSearch.resultDrafts[0].status, 'ready');
  assert.equal(Array.from(files.keys()).filter(path => path === draft.notePath).length, 1);
  assert.deepEqual(plain(await store.recoverPending(mapPath)), { recovered: [], stale: [] });
  const retry = await store.startAttempt(mapPath, branch.id, 'run-draft-recovery');
  assert.equal(retry.attemptId, 'attempt-2');
  const retired = await repo.readNote(draft.notePath);
  assert.equal(retired.status, 'error'); assert.match(retired.detail, /stale-attempt diagnostic/);
  assert.equal((await repo.readMap(mapPath)).nodes.some(node => node.id === draft.nodeId), false);
});
integrationTest('MindSearch retires an attempt-scoped draft if another store supersedes it after Note creation', async () => {
  const { repo, mapPath, question, store, files } = await mindSearchMapFixture();
  const branch = await store.createAnswerBranch(mapPath, { questionNodeId: question.id, parentBranchId: null, answerSnapshot: { selections: [], freeText: 'answer' }, inputSnapshot: { topic: 'steak', conditions: {}, upstreamResults: [] } });
  const attempt = await store.startAttempt(mapPath, branch.id, 'run-concurrent-supersede');
  const { MindSearchRunStore } = load('mindsearch-mve/research-run-store.ts');
  const secondStore = new MindSearchRunStore(repo, () => 'other-store-id');
  const createNoteAt = repo.createNoteAt.bind(repo);
  repo.createNoteAt = async (...args) => { const node = await createNoteAt(...args); await secondStore.startAttempt(mapPath, branch.id, 'run-concurrent-supersede'); return node; };
  const creation = await store.createResultDraft(mapPath, attempt, '舊回覆', 'gpt-6-luna');
  repo.createNoteAt = createNoteAt;
  assert.equal(creation.status, 'stale');
  const notePath = Array.from(files.keys()).find(item => item.endsWith('/Notes/舊回覆.md'));
  assert.ok(notePath);
  const diagnostic = await repo.readNote(notePath), savedMap = await repo.readMap(mapPath);
  assert.equal(diagnostic.status, 'error'); assert.match(diagnostic.detail, /stale-attempt diagnostic/);
  assert.equal(savedMap.nodes.some(node => node.path === notePath), false);
  assert.equal(savedMap.mindSearch.branches[0].results.length, 0);
  assert.equal(savedMap.mindSearch.resultDrafts.length, 0);
});
integrationTest('MindSearch recovers a Map commit interrupted after its Note was written without rerunning research', async () => {
  const { repo, mapPath, question, store, files } = await mindSearchMapFixture();
  const branch = await store.createAnswerBranch(mapPath, { questionNodeId: question.id, parentBranchId: null, answerSnapshot: { selections: ['鑄鐵鍋'], freeText: '沒有烤箱' }, inputSnapshot: { topic: '在家煎牛排', conditions: {}, upstreamResults: [] } });
  const attempt = await store.startAttempt(mapPath, branch.id, 'run-recovery');
  const result = (await store.createResultDraft(mapPath, attempt, '研究結果', 'gpt-6-luna')).draft;
  const realSaveMap = repo.saveMap.bind(repo); let mapWrites = 0;
  repo.saveMap = async (...args) => { mapWrites++; if (mapWrites === 2) throw new Error('simulated interruption after Note persistence'); return realSaveMap(...args); };
  await assert.rejects(store.commitResult(mapPath, attempt, result.id, { summary: 'stored result', detail: 'conditional report' }), /simulated interruption/);
  repo.saveMap = realSaveMap;
  const pending = await repo.readMap(mapPath);
  assert.equal(pending.mindSearch.pendingCommits.length, 1);
  assert.equal((await repo.readNote(result.notePath)).summary, 'stored result');
  let expensiveResearchRuns = 1;
  const recovered = plain(await store.recoverPending(mapPath));
  assert.deepEqual(recovered, { recovered: ['result-run-recovery-attempt-1'], stale: [] });
  assert.equal(expensiveResearchRuns, 1);
  const repeated = plain(await store.recoverPending(mapPath)); assert.deepEqual(repeated, { recovered: [], stale: [] });
  const savedMap = await repo.readMap(mapPath), savedNote = await repo.readNote(result.notePath);
  assert.equal(savedMap.mindSearch.pendingCommits.length, 0);
  assert.equal(savedMap.mindSearch.branches[0].results.length, 1);
  assert.equal(savedNote.summary, 'stored result'); assert.equal(savedNote.detail, 'conditional report');
  assert.equal(Array.from(files.keys()).filter(path => path === result.notePath).length, 1);
});
integrationTest('editing note fields preserves latest AI detail and unrelated frontmatter', async () => {
  const { repo, contents } = fixture(); const n = await topicNote(repo);
  contents.set(n.path, contents.get(n.path).replace('---\n', '---\ncustom: "retain me"\n'));
  await repo.updateNote(n.path, { detail: '## Nested heading\n\nAI result with $& and ```code```', newFindings: 'Fresh research', status: 'review' });
  await repo.updateNote(n.path, { title: '修改標題', model: 'model-b', reasoning: 'high', prompt: 'A task with $&' });
  const result = await repo.readNote(n.path);
  assert.equal(result.detail, '## Nested heading\n\nAI result with $& and ```code```'); assert.equal(result.prompt, 'A task with $&'); assert.equal(result.model, 'model-b'); assert.equal(result.status, 'completed');
  assert.equal(result.reasoning, 'high');
  assert.equal(result.newFindings, 'Fresh research');
  assert.match(contents.get(n.path), /## Working Findings\n\nFresh research/);
  assert.match(contents.get(n.path), /custom: "retain me"/);
});
integrationTest('local research mode persists without changing older notes', async () => {
  const { repo } = fixture(); const n = await topicNote(repo);
  const original = await repo.readNote(n.path);
  assert.equal(original.researchMode, 'research');
  assert.equal(original.researchDepth, 'normal');
  assert.equal(original.visualMode, 'auto');
  await repo.updateNote(n.path, { researchMode: 'local', researchDepth: 'deep', visualMode: 'off' });
  const updated = await repo.readNote(n.path);
  assert.equal(updated.researchMode, 'local');
  assert.equal(updated.researchDepth, 'deep');
  assert.equal(updated.visualMode, 'off');
});
integrationTest('current summary is editable in the Markdown body', async () => {
  const { repo, contents } = fixture(); const n = await topicNote(repo, 'Editable summary');
  assert.match(contents.get(n.path), /## Current Summary\n\n尚未形成結論/);
  await repo.updateNote(n.path, { summary: 'AI conclusion that can be edited' });
  assert.match(contents.get(n.path), /summary: "AI conclusion that can be edited"/);
  assert.match(contents.get(n.path), /## Current Summary\n\nAI conclusion that can be edited/);
  contents.set(n.path, contents.get(n.path).replace('## Current Summary\n\nAI conclusion that can be edited', '## Current Summary\n\nUser-edited conclusion'));
  assert.equal((await repo.readNote(n.path)).summary, 'User-edited conclusion');
});
integrationTest('English notes use English preview, pending summary, and managed reference labels', async () => {
  const { repo, app, contents } = fixture('en');
  const mapPath = await repo.createMap('Travel'), map = await repo.readMap(mapPath);
  assert.match(contents.get(mapPath), /This file stores the mind map structure/);
  assert.doesNotMatch(contents.get(mapPath), /此檔案保存心智圖結構/);
  const note = await repo.createNote('Route', 'model-a', map, mapPath, 'workspace');
  map.nodes.push(note); await repo.saveMap(mapPath, map); await repo.rebuildDerivedData();
  let markdown = contents.get(note.path);
  assert.match(markdown, /## Current Summary\n\nNo conclusion yet/);
  assert.match(markdown, /## Preview\n\nNo conclusion yet/);
  assert.match(markdown, /- Topic: \[\[/);
  assert.match(markdown, /- Mind map: \[\[/);
  assert.doesNotMatch(markdown, /尚未形成結論|## 預覽|所屬主題|所屬心智圖/);
  await repo.updateNote(note.path, { sourcePaths: ['Source.md'], detail: 'English detail' });
  markdown = contents.get(note.path);
  assert.match(markdown, /- Source topic: \[\[Source\]\]/);
  assert.equal((await repo.readNote(note.path)).preview, 'No conclusion yet');
  await repo.updateNote(note.path, { summary: 'English conclusion' });
  assert.equal((await repo.readNote(note.path)).preview, 'English conclusion');
  assert.match(contents.get(note.path), /## Preview\n\nEnglish conclusion/);
  const copy = await repo.duplicateNote(note.path, map, mapPath);
  assert.match(copy.path, /Route copy\.md$/);
  assert.throws(() => repo.file('Missing.md'), /File not found/);
});
integrationTest('language switch localizes only generated note scaffolding and preserves authored text', async () => {
  const { repo, app, contents } = fixture();
  const mapPath = await repo.createMap('Travel'), map = await repo.readMap(mapPath);
  const note = await repo.createNote('Route', 'model-a', map, mapPath, 'workspace');
  map.nodes.push(note); await repo.saveMap(mapPath, map); await repo.rebuildDerivedData();
  await repo.updateNote(note.path, { detail: 'Keep detail', sourcePaths: ['Source.md'] });
  const beforeSwitch = contents.get(note.path);
  repo.settings.language = 'en';
  assert.equal(contents.get(note.path), beforeSwitch);
  await repo.updateNote(note.path, { model: 'model-b' });
  let markdown = contents.get(note.path);
  assert.match(markdown, /## Preview\n\nNo conclusion yet/);
  assert.match(markdown, /## Current Summary\n\nNo conclusion yet/);
  assert.match(markdown, /- Topic: \[\[/);
  assert.match(markdown, /- Source topic: \[\[Source\]\]/);
  assert.match(markdown, /Keep detail/);
  assert.doesNotMatch(markdown, /## 預覽|尚未形成結論|所屬主題|來源議題/);
  await repo.updateNote(note.path, { preview: 'My own preview' });
  repo.settings.language = 'zh-TW';
  await repo.rebuildDerivedData();
  markdown = contents.get(note.path);
  assert.match(markdown, /## 預覽\n\nMy own preview/);
  assert.match(markdown, /## Current Summary\n\n尚未形成結論/);
  assert.match(markdown, /- 所屬主題：\[\[/);
  assert.match(markdown, /Keep detail/);
  assert.doesNotMatch(markdown, /## Preview|No conclusion yet/);
  assert.equal((await repo.readNote(note.path)).preview, 'My own preview');
});
integrationTest('editing a note heading updates its card title and survives later note writes', async () => {
  const { repo, contents } = fixture(); const n = await topicNote(repo, '新的子議題');
  contents.set(n.path, contents.get(n.path).replace('# 新的子議題', '# 要如何推廣VAM'));
  assert.equal((await repo.readNote(n.path)).title, '要如何推廣VAM');
  await repo.updateNote(n.path, { summary: '新的摘要' });
  assert.equal((await repo.readNote(n.path)).title, '要如何推廣VAM');
  assert.match(contents.get(n.path), /title: "要如何推廣VAM"/);
  assert.match(contents.get(n.path), /^# 要如何推廣VAM$/m);
  await repo.rebuildDerivedData();
  assert.equal((await repo.readNote(n.path)).title, '要如何推廣VAM');
});
integrationTest('visual references are stored inside the editable Detail section', async () => {
  const { repo, contents } = fixture(); const n = await topicNote(repo, 'Outfit');
  await repo.updateNote(n.path, { visualReferences: '### Navy + Beige\n\n![Navy + Beige](https://example.com/outfit.jpg)\n\n來源：https://example.com/page\n配色：navy / beige' });
  let note = await repo.readNote(n.path);
  assert.equal(note.visualReferences, '');
  assert.match(note.detail, /\*\*Navy \+ Beige\*\*/);
  assert.doesNotMatch(note.detail, /### 視覺參考/);
  assert.doesNotMatch(contents.get(n.path), /## Visual References/);
  await repo.updateNote(n.path, { visualReferences: '' });
  note = await repo.readNote(n.path);
  assert.equal(note.visualReferences, '');
  assert.doesNotMatch(contents.get(n.path), /## Visual References/);
});
integrationTest('managed references stay outside Detail and preserve user-authored content', async () => {
  const { repo, contents, app } = fixture(); const n = await topicNote(repo);
  const mapPath = await repo.createMap('Map A', [n]);
  await repo.rebuildDerivedData();
  let text = contents.get(n.path);
  assert.match(text, /visual-agent-map:references:start/);
  assert.match(text, /## Reference Links/);
  assert.match(text, /agent-map-references:/);
  assert.doesNotMatch((await repo.readNote(n.path)).detail, /關聯議題/);
  text = text.replace('<!-- visual-agent-map:detail:end -->', '<!-- visual-agent-map:detail:end -->\n\n## User notes\n\nUser content'); contents.set(n.path, text);
  await repo.updateNote(n.path, { detail: 'New detail' }); await repo.rebuildDerivedData();
  assert.match(contents.get(n.path), /User content/); assert.equal((await repo.readNote(n.path)).detail, 'New detail');
  assert.ok(app.vault.getAbstractFileByPath(mapPath));
});
integrationTest('a note cannot belong to two maps', async () => {
  const { repo } = fixture(); const n = await topicNote(repo, 'shared');
  await repo.createMap('One', [n]); await repo.createMap('Two', [n]);
  await assert.rejects(() => repo.rebuildDerivedData(), /同時出現在兩張心智圖/);
});
integrationTest('removing a node clears ownership and generated references while keeping the note', async () => {
  const { repo, contents } = fixture(); const n = await topicNote(repo, 'kept'); const mapPath = await repo.createMap('One', [n]);
  await repo.rebuildDerivedData(); const mapDoc = await repo.readMap(mapPath); mapDoc.nodes = []; await repo.saveMap(mapPath, mapDoc); await repo.rebuildDerivedData();
  assert.equal((await repo.readNote(n.path)).mapId, ''); assert.doesNotMatch(contents.get(n.path), /visual-agent-map:references:start/); assert.doesNotMatch(contents.get(n.path), /agent-map-references:/);
});
integrationTest('maps keep independent layout and preserve Markdown prose', async () => {
  const { repo, contents } = fixture(); const firstNode = await topicNote(repo, 'first', 'gpt-5.6-terra', 'map-a'); const secondNode = await topicNote(repo, 'second', 'gpt-5.6-terra', 'map-b');
  const first = await repo.createMap('One', [firstNode]), second = await repo.createMap('Two', [secondNode]);
  contents.set(first, contents.get(first) + '\nUser annotation\n');
  const changed = await repo.readMap(first); changed.nodes[0].x = 600; changed.title = 'Renamed'; await repo.saveMap(first, changed);
  assert.equal((await repo.readMap(second)).nodes[0].x, 80); assert.match(contents.get(first), /User annotation/); assert.match(contents.get(first), /# Renamed/);
});
integrationTest('preview migration moves owned notes into a topic and unknown orphans into Inbox', async () => {
  const { repo, app } = fixture();
  await repo.folder('Agent Workspace/Maps'); await repo.folder('Agent Workspace/Nodes');
  const content = id => `---\nagent-map-node: true\nnode-id: "${id}"\ntitle: "${id}"\n---\n\n# ${id}\n\n## Prompt\n\n## Rules\n\n## Detail\n\nOld detail\n`;
  await app.vault.create('Agent Workspace/Nodes/a.md', content('a')); await app.vault.create('Agent Workspace/Nodes/orphan.md', content('orphan'));
  const legacy = map([node('a')]); legacy.title = 'Legacy'; legacy.nodes[0].path = 'Agent Workspace/Nodes/a.md';
  await app.vault.create('Agent Workspace/Maps/Legacy.md', core.serializeMap(legacy));
  const plan = await repo.legacyMigrationPlan(); assert.equal(plan.maps.length, 1); assert.deepEqual(plain(plan.orphanPaths), ['Agent Workspace/Nodes/orphan.md']);
  const mapping = await repo.migrateLegacyWorkspace(plan), next = mapping.get('Agent Workspace/Maps/Legacy.md');
  assert.equal(next, 'Agent Workspace/Topics/Legacy/Map.md');
  const movedMap = await repo.readMap(next); assert.match(movedMap.nodes[0].path, /\/Notes\/a\.md$/);
  assert.equal((await repo.readNote(movedMap.nodes[0].path)).topicState, 'active');
  assert.equal((await repo.inboxFiles()).length, 1); assert.equal((await repo.readNote((await repo.inboxFiles())[0].path)).topicState, 'inbox');
});
integrationTest('preview migration rolls back all completed moves when a later move fails', async () => {
  const { repo, app } = fixture();
  await repo.folder('Agent Workspace/Maps'); await repo.folder('Agent Workspace/Nodes');
  const content = `---\nagent-map-node: true\nnode-id: "a"\ntitle: "a"\n---\n\n# a\n`;
  await app.vault.create('Agent Workspace/Nodes/a.md', content);
  const legacy = map([node('a')]); legacy.title = 'Rollback'; legacy.nodes[0].path = 'Agent Workspace/Nodes/a.md';
  await app.vault.create('Agent Workspace/Maps/Rollback.md', core.serializeMap(legacy));
  const rename = app.fileManager.renameFile; let failed = false;
  app.fileManager.renameFile = async (item, target) => {
    if (!failed && target.includes('/Notes/')) { failed = true; throw new Error('controlled migration failure'); }
    await rename(item, target);
  };
  const plan = await repo.legacyMigrationPlan();
  await assert.rejects(() => repo.migrateLegacyWorkspace(plan), /controlled migration failure/);
  assert.ok(app.vault.getAbstractFileByPath('Agent Workspace/Maps/Rollback.md'));
  assert.ok(app.vault.getAbstractFileByPath('Agent Workspace/Nodes/a.md'));
  assert.equal(app.vault.getAbstractFileByPath('Agent Workspace/Topics/Rollback/Map.md'), undefined);
});
integrationTest('external rename reconciliation only follows a unique matching node-id', async () => {
  const { repo, app, contents } = fixture(); const n = await topicNote(repo, 'External rename');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md', doc = { id: 'map-a', title: 'Map A', version: 1, nodes: [n], viewport: { x: 0, y: 0, zoom: 1 } };
  await app.vault.create(mapPath, core.serializeMap(doc));
  const renamed = 'Agent Workspace/Topics/map-a/Notes/External rename moved.md';
  await app.fileManager.renameFile(app.vault.getAbstractFileByPath(n.path), renamed);
  assert.equal(await repo.reconcileMissingNodePaths(), 1);
  assert.equal((await repo.readMap(mapPath)).nodes[0].path, renamed);

  const second = fixture(); const other = await topicNote(second.repo, 'Ambiguous rename');
  const otherMap = 'Agent Workspace/Topics/map-a/Map.md', otherDoc = { id: 'map-a', title: 'Map A', version: 1, nodes: [other], viewport: { x: 0, y: 0, zoom: 1 } };
  await second.app.vault.create(otherMap, core.serializeMap(otherDoc));
  const firstCandidate = 'Agent Workspace/Topics/map-a/Notes/Ambiguous one.md', secondCandidate = 'Agent Workspace/Topics/map-a/Notes/Ambiguous two.md';
  await second.app.fileManager.renameFile(second.app.vault.getAbstractFileByPath(other.path), firstCandidate);
  await second.app.vault.create(secondCandidate, second.contents.get(firstCandidate));
  assert.equal(await second.repo.reconcileMissingNodePaths(), 0);
  assert.equal((await second.repo.readMap(otherMap)).nodes[0].path, other.path);
});
integrationTest('new topics contain Map, Notes, Unassigned and Archive', async () => {
  const { repo, app } = fixture(), mapPath = await repo.createMap('Topic A');
  assert.equal(mapPath, 'Agent Workspace/Topics/Topic A/Map.md');
  for (const name of ['Notes', 'Unassigned', 'Archive']) assert.ok(app.vault.getAbstractFileByPath(`Agent Workspace/Topics/Topic A/${name}`) instanceof TFolder);
});
integrationTest('unassigned and archived notes keep topic ownership but leave the map', async () => {
  const { repo, contents } = fixture(), mapPath = await repo.createMap('Lifecycle'), mapDoc = await repo.readMap(mapPath);
  const n = await repo.createNote('Knowledge', 'a', mapDoc, mapPath, 'workspace'); mapDoc.nodes.push(n); await repo.saveMap(mapPath, mapDoc); await repo.rebuildDerivedData();
  const unassigned = await repo.moveUnique(n.path, repo.topicFolder(mapPath, 'Unassigned')); await repo.setLifecycle(unassigned, mapDoc.id, '', 'unassigned'); mapDoc.nodes = []; await repo.saveMap(mapPath, mapDoc); await repo.rebuildDerivedData();
  let note = await repo.readNote(unassigned); assert.equal(note.topicId, mapDoc.id); assert.equal(note.mapId, ''); assert.equal(note.topicState, 'unassigned'); assert.match(contents.get(unassigned), /狀態：未歸類/);
  const archived = await repo.moveUnique(unassigned, repo.topicFolder(mapPath, 'Archive')); await repo.setLifecycle(archived, mapDoc.id, '', 'archived'); await repo.rebuildDerivedData();
  note = await repo.readNote(archived); assert.equal(note.topicState, 'archived'); assert.match(contents.get(archived), /狀態：已封存/);
});
integrationTest('a missing Map can be rebuilt from topic Notes as root nodes', async () => {
  const { repo } = fixture(), root = 'Agent Workspace/Topics/Broken', placeholder = { id: 'stable-topic', title: 'Broken', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  await repo.ensureTopicFolders(root); await repo.createNote('Recovered', 'a', placeholder, `${root}/Map.md`, 'workspace');
  const path = await repo.rebuildMissingMap(root), rebuilt = await repo.readMap(path); assert.equal(rebuilt.id, 'stable-topic'); assert.equal(rebuilt.nodes.length, 1); assert.equal(rebuilt.nodes[0].parentId, null);
});
integrationTest('replacing AI synthesis preserves 預覽', async () => {
  const { repo } = fixture(), n = await topicNote(repo, 'Synthesis');
  await repo.updateNote(n.path, { detail: 'Old synthesis', preview: 'Keep this manually written note' });
  await repo.updateNote(n.path, { detail: 'New synthesis', prompt: '' });
  const result = await repo.readNote(n.path); assert.equal(result.detail, 'New synthesis'); assert.equal(result.preview, 'Keep this manually written note'); assert.equal(result.prompt, '');
});
integrationTest('text undo uses field patches and preserves AI details arriving in between', async () => {
  const { repo, app } = fixture(), n = await topicNote(repo, 'Original', 'a');
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app }, { repo, rebuildDerivedData: async () => {} });
  view.refreshCard = () => {}; view.updateHistoryButtons = () => {}; view.render = () => {};
  await view.noteChange(n, { title: 'Edited' }); await repo.updateNote(n.path, { detail: 'New AI answer' }); await view.travel(false);
  const note = await repo.readNote(n.path); assert.equal(note.title, 'Original'); assert.equal(note.detail, 'New AI answer');
});
test('AI result formatting always produces the canonical knowledge structure', async () => {
  const { canonicalDetail } = load('main.ts', { obsidian });
  const result = canonicalDetail('New analysis');
  for (const heading of ['核心結論', '關鍵知識', '證據與來源', '取捨與限制', '待確認事項', '更新紀錄']) assert.match(result, new RegExp(`### ${heading}`));
  assert.equal((result.match(/New analysis/g) || []).length, 1);
  const english = canonicalDetail('New analysis', 'en');
  for (const heading of ['Core conclusions', 'Key knowledge', 'Evidence and sources', 'Tradeoffs and limitations', 'Open questions', 'Update log']) assert.match(english, new RegExp(`### ${heading}`));
  assert.doesNotMatch(english, /核心結論|尚待補充|整理為結構化知識/);
  const bilingual = canonicalDetail('### 核心結論\n\n中文結論\n\n### 證據與來源\n\n[[來源.md]]', 'en');
  assert.equal((bilingual.match(/中文結論/g) || []).length, 1);
  assert.match(bilingual, /### Core conclusions\n\n中文結論/);
  assert.doesNotMatch(bilingual, /### 核心結論/);
  assert.doesNotMatch(bilingual, /To be added/);
});
test('AI visual references render as image cards', () => {
  const { visualReferencesMarkdown } = load('main.ts', { obsidian });
  const markdown = visualReferencesMarkdown([{ title: 'Navy + Beige', imageUrl: 'https://example.com/outfit.jpg', sourceUrl: 'https://example.com/page', description: '乾淨休閒穿搭', palette: ['navy', 'white', 'beige'], formula: '深色外套 + 白色內搭 + 淺色褲' }]);
  assert.match(markdown, /!\[Navy \+ Beige\]\(https:\/\/example.com\/outfit.jpg\)/);
  assert.match(markdown, /來源：https:\/\/example.com\/page/);
  assert.match(markdown, /配色：navy \/ white \/ beige/);
  const english = visualReferencesMarkdown([{ title: 'Map', imageUrl: 'https://example.com/map.jpg', sourceUrl: 'https://example.com/page', description: 'Route', palette: [], formula: '' }], 'en');
  assert.match(english, /Source: https:\/\/example.com\/page/);
  assert.doesNotMatch(english, /來源：|用途：/);
});
integrationTest('AI prompt defaults to the selected language across task modes', async () => {
  const { default: Plugin } = load('main.ts', { obsidian });
  const plugin = new Plugin(); plugin.app = { vault: { adapter: new obsidian.FileSystemAdapter() } }; plugin.manifest = { dir: '.obsidian/plugins/visual-agent-map' };
  const prompts = [];
  plugin.runtime = () => ({ runTask: async prompt => { prompts.push(prompt); return '{"summary":"done","detail":"details","suggestions":[],"visualReferences":[]}'; } });
  const context = { title: 'English topic', summary: 'English summary', rules: '', detail: '', task: 'Expand the map', ancestors: '', researchMode: 'local', researchDepth: 'fast', visualMode: 'off' };
  plugin.settings.language = 'en';
  for (const mode of ['task', 'decompose', 'synthesize']) await plugin.askModel({ ...context, mode }, 'test-model', 'low');
  for (const prompt of prompts) {
    assert.match(prompt, /Write newly generated content in English by default/);
    assert.doesNotMatch(prompt, /[一-龥]/);
  }
  assert.match(prompts[0], /### Core conclusions/);
  assert.match(prompts[0], /Insufficient information/);
  assert.doesNotMatch(prompts[0], /現有資料不足/);
  assert.doesNotMatch(prompts[0], /detail 必須是完整繁體中文/);
  plugin.settings.language = 'zh-TW';
  await plugin.askModel({ ...context, mode: 'task' }, 'test-model', 'low');
  assert.match(prompts[3], /新產生的內容預設使用繁體中文/);
  assert.match(prompts[3], /### 核心結論/);
});
integrationTest('Claude Code uses the shared task prompt and structured result parser without provider fallback', async () => {
  const { default: Plugin } = load('main.ts', { obsidian });
  const plugin = new Plugin(); plugin.app = { vault: { adapter: new obsidian.FileSystemAdapter() } }; plugin.manifest = { dir: '.obsidian/plugins/visual-agent-map' };
  let call;
  plugin.claudeCli = () => ({ runTask: async (...args) => { call = args; return JSON.stringify({ summary: 'Claude result', detail: 'Claude detail', suggestions: [], visualReferences: [] }); } });
  plugin.runtime = () => { assert.fail('Claude selection must not fall back to Codex'); };
  const result = await plugin.askModel({ title: 'Topic', summary: 'Existing summary', rules: '', detail: 'Full detail', task: 'One-run requirement', ancestors: '', mode: 'synthesize', researchMode: 'research', researchDepth: 'fast', visualMode: 'off' }, 'claude:sonnet', 'high');
  assert.equal(call[1], 'sonnet'); assert.equal(call[2], 'high');
  assert.match(call[0], /One-run requirement/); assert.match(call[0], /Full detail/);
  assert.ok(call[3] && typeof call[3] === 'object');
  assert.equal(call[4].searchBudget, 0);
  assert.equal(call[4].webSearch, true);
  assert.deepEqual(plain(result), { summary: 'Claude result', detail: 'Claude detail', suggestions: [], visualReferences: [] });
});
integrationTest('AI response fallback keeps the language captured when the task started', async () => {
  const { default: Plugin } = load('main.ts', { obsidian });
  const plugin = new Plugin(); plugin.app = { vault: { adapter: new obsidian.FileSystemAdapter() } }; plugin.manifest = { dir: '.obsidian/plugins/visual-agent-map' };
  plugin.settings.language = 'en';
  plugin.runtime = () => ({ runTask: async () => {
    plugin.settings.language = 'zh-TW';
    return JSON.stringify({ summary: 'Done', detail: 'Details', suggestions: [], visualReferences: [{ imageUrl: 'https://example.com/image.jpg', sourceUrl: 'https://example.com' }] });
  } });
  const result = await plugin.askModel({ title: 'Topic', summary: '', rules: '', detail: '', task: 'Research', ancestors: '', mode: 'task', researchMode: 'local', visualMode: 'off' }, 'test-model', 'low');
  assert.equal(result.visualReferences[0].title, 'Visual reference');
});
test('hover helpers extract image and table from user notes markdown', () => {
  const { firstMarkdownImage, firstMarkdownTable, markdownImages } = load('main.ts', { obsidian });
  const markdown = '我的筆記\n\n![配色](https://example.com/style.jpg)\n![髮型](https://example.com/hair.jpg)\n![鞋子](https://example.com/shoes.jpg)\n![外套](https://example.com/jacket.jpg)\n![忽略](https://example.com/ignored.jpg)\n\n| 面向 | 判斷 |\n| --- | --- |\n| 顏色 | navy / beige |\n| 鞋子 | white sneakers |';
  const image = firstMarkdownImage(markdown);
  assert.equal(image.alt, '配色');
  assert.equal(image.url, 'https://example.com/style.jpg');
  assert.equal(markdownImages(markdown, 4).length, 4);
  assert.equal(markdownImages(markdown, 4)[3].alt, '外套');
  assert.equal(JSON.stringify(firstMarkdownTable(markdown)), JSON.stringify([['面向', '判斷'], ['顏色', 'navy / beige'], ['鞋子', 'white sneakers']]));
});
integrationTest('new notes omit inactive rules and working findings; clearing legacy findings removes the section', async () => {
  const { repo, contents } = fixture(), n = await topicNote(repo, 'Direct write', 'a');
  assert.match(contents.get(n.path), /## Prompt[\s\S]*## 預覽[\s\S]*## Detail/);
  assert.doesNotMatch(contents.get(n.path), /## Rules/);
  assert.doesNotMatch(contents.get(n.path), /## Working Findings/);
  await repo.updateNote(n.path, { newFindings: 'Legacy finding' });
  assert.match(contents.get(n.path), /## Working Findings\n\nLegacy finding/);
  await repo.updateNote(n.path, { newFindings: '' });
  assert.doesNotMatch(contents.get(n.path), /## Working Findings/);
  assert.equal((await repo.readNote(n.path)).newFindings, '');
});
integrationTest('a successful AI task immediately updates summary and MD detail', async () => {
  const { repo, app, contents } = fixture(), n = await topicNote(repo, 'Direct write', 'a');
  await repo.updateNote(n.path, { prompt: 'Research this', rules: 'Use a comparison table.', detail: 'Existing detail', newFindings: 'Legacy finding', sourcePaths: ['Other.md'] });
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md';
  const mapDoc = { id: 'map-a', title: 'map-a', version: 1, nodes: [n], viewport: { x: 0, y: 0, zoom: 1 } };
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const { VisualAgentMapView } = load('main.ts', { obsidian }); let view;
  let acceptedLaunch = false, acceptedSignal;
  let finishAi;
  const plugin = {
    repo, settings: { ...DEFAULT_SETTINGS }, running: new Set(), activeTasks: new Map(), pendingSuggestions: new Map(),
    askModel: (context, _model, _reasoning, signal, _onExchange, onAccepted) => { acceptedSignal = signal; assert.equal(context.mode, 'task'); assert.equal(context.task, 'One-time request'); assert.equal(context.rules, ''); assert.equal(context.detail, 'Existing detail'); assert.equal(context.workingFindings, 'Legacy finding'); assert.equal(context.sourceContext, ''); onAccepted?.(); return new Promise(resolve => { finishAi = () => resolve({ summary: 'Direct summary', detail: '### 核心結論\n\nDirect detail\n\n### 關鍵知識\n\nExisting detail; Legacy finding\n\n### 證據與來源\n\nSource\n\n### 取捨與限制\n\nNone\n\n### 待確認事項\n\nNone\n\n### 更新紀錄\n\n- Updated', suggestions: [] }); }); },
    rebuildDerivedData: async () => {}, mutate: async work => work(), views: () => [view]
  };
  view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.render = () => {}; view.hydrate = async () => {};
  const run = view.runAgent(n, undefined, undefined, { task: 'One-time request' }, () => {
    acceptedLaunch = true;
    assert.ok(plugin.activeTasks.has(n.path)); assert.ok(plugin.running.has(n.path));
    assert.equal(acceptedSignal.aborted, false);
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(acceptedLaunch, true);
  finishAi();
  await run; await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(acceptedLaunch, true); assert.equal(acceptedSignal.aborted, false);
  const updated = await repo.readNote(n.path);
  assert.equal(updated.prompt, 'Research this'); assert.equal(updated.summary, 'Direct summary'); assert.equal(updated.rules, 'Use a comparison table.');
  assert.equal(updated.status, 'completed');
  assert.equal(updated.newFindings, '');
  assert.match(updated.detail, /Direct detail/);
  assert.match(updated.detail, /Legacy finding/);
  assert.match(updated.detail, /Existing detail/);
  assert.doesNotMatch(contents.get(n.path), /## Working Findings/);
  assert.equal(updated.previewInitialized, true);
  await view.travel(false);
  const restored = await repo.readNote(n.path);
  assert.equal(restored.status, 'idea');
  assert.equal(restored.previewInitialized, false);
  assert.doesNotMatch(restored.previewSection, /Direct summary/);
  await view.travel(true);
  assert.equal((await repo.readNote(n.path)).previewInitialized, true);
});
integrationTest('cancelling a node task keeps its earlier Markdown and status', async () => {
  const { repo, app } = fixture(), n = await topicNote(repo, 'Cancel');
  await repo.updateNote(n.path, { prompt: 'Research', detail: 'Keep this' });
  const { VisualAgentMapView } = load('main.ts', { obsidian }); let view;
  const plugin = {
    repo, settings: { ...DEFAULT_SETTINGS }, running: new Set(), activeTasks: new Map(), pendingSuggestions: new Map(),
    askModel: (_context, _model, _reasoning, signal, _exchange, accepted) => { accepted?.(); return new Promise((_resolve, reject) => signal.addEventListener('abort', () => { const error = new Error('cancelled'); error.name = 'AbortError'; reject(error); }, { once: true })); },
    mutate: async work => work(), views: () => [view]
  };
  view = new VisualAgentMapView({ app }, plugin); view.path = 'Map.md'; view.map = map([n]); view.render = () => {}; view.hydrate = async () => {};
  await view.runAgent(n);
  assert.equal((await repo.readNote(n.path)).status, 'running');
  plugin.activeTasks.get(n.path).abort();
  await new Promise(resolve => setTimeout(resolve, 20));
  const after = await repo.readNote(n.path);
  assert.equal(after.status, 'idea'); assert.equal(after.detail, 'Keep this'); assert.equal(plugin.activeTasks.size, 0);
});
integrationTest('prelaunch AI failures release task ownership and preserve startup errors', async () => {
  const { repo, app } = fixture(), n = await topicNote(repo, 'Startup cleanup');
  await repo.updateNote(n.path, { prompt: 'Research', detail: 'Keep this' });
  const { VisualAgentMapView } = load('main.ts', { obsidian }); let view;
  const plugin = { repo, settings: { ...DEFAULT_SETTINGS }, running: new Set(), activeTasks: new Map(), pendingSuggestions: new Map(), askModel: async () => { assert.fail('provider must not start'); }, mutate: async work => work(), views: () => [view] };
  view = new VisualAgentMapView({ app }, plugin); view.path = 'Map.md'; view.map = map([n]); view.render = () => {}; view.hydrate = async () => { throw new Error('hydrate failed'); };
  await assert.rejects(view.runAgent(n), /hydrate failed/);
  assert.equal((await repo.readNote(n.path)).status, 'idea'); assert.equal(plugin.activeTasks.size, 0); assert.equal(plugin.running.size, 0);

  const { repo: abortRepo, app: abortApp } = fixture(), abortNode = await topicNote(abortRepo, 'Abort startup cleanup');
  await abortRepo.updateNote(abortNode.path, { prompt: 'Research' });
  const originalUpdate = abortRepo.updateNote.bind(abortRepo); let enteredRunning = false;
  abortRepo.updateNote = async (path, patch) => {
    if (patch.status === 'running') enteredRunning = true;
    if (enteredRunning && patch.status === 'idea') throw new Error('status restore failed');
    return originalUpdate(path, patch);
  };
  const abortPlugin = { repo: abortRepo, settings: { ...DEFAULT_SETTINGS }, running: new Set(), activeTasks: new Map(), pendingSuggestions: new Map(), askModel: async () => { assert.fail('provider must not start'); }, mutate: async work => work(), views: () => [abortView] }; let abortView;
  abortView = new VisualAgentMapView({ app: abortApp }, abortPlugin); abortView.path = 'Map.md'; abortView.map = map([abortNode]); abortView.render = () => {};
  abortView.hydrate = async () => { abortPlugin.activeTasks.get(abortNode.path).abort(); };
  await assert.rejects(abortView.runAgent(abortNode), /status restore failed/);
  assert.equal(abortPlugin.activeTasks.size, 0); assert.equal(abortPlugin.running.size, 0);
});
integrationTest('cancelling child synthesis restores the topic status and does not report a failure', async () => {
  const { repo, app } = fixture(), parent = await topicNote(repo, 'Synthesis parent');
  await repo.updateNote(parent.path, { status: 'completed', summary: 'Existing conclusion', detail: 'Existing knowledge' });
  const child = await topicNote(repo, 'Synthesis child');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md';
  const mapDoc = { id: 'map-a', title: 'map-a', version: 1, nodes: [{ ...parent, status: 'completed' }, { ...child, parentId: parent.id }], viewport: { x: 0, y: 0, zoom: 1 } };
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const controller = new AbortController(); let view, reported = '';
  const plugin = {
    repo, settings: { ...DEFAULT_SETTINGS }, running: new Set(), activeTasks: new Map(),
    askModel: (_context, _model, _reasoning, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => { const error = new Error('cancelled'); error.name = 'AbortError'; reject(error); }, { once: true })),
    mutate: async work => work(), views: () => [view], recordFailure: (_context, error) => { reported = error.message; return error.message; }
  };
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.render = () => {}; view.hydrate = async () => {};
  const pending = view.integrateChildren(parent, true, { researchMode: 'local', researchDepth: 'normal', visualMode: 'off', referenceGroups: [], signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve)); controller.abort(); await pending;
  const after = await repo.readNote(parent.path);
  assert.equal(after.status, 'completed'); assert.equal(after.summary, 'Existing conclusion'); assert.equal(after.detail, 'Existing knowledge');
  assert.equal(reported, ''); assert.equal(plugin.running.has(parent.path), false);
});
integrationTest('provider failure keeps its original AI log stage during node error writeback', async () => {
  const { repo, app } = fixture(), n = await topicNote(repo, 'Provider failure');
  await repo.updateNote(n.path, { prompt: 'Research' });
  const entry = { id: 'exchange-1', status: 'failed', error: '等待 AI 回覆：provider timeout' };
  const exchanges = { getEntries: () => [entry], failed: (_id, error) => { entry.error = error; } };
  let view;
  const plugin = { repo, settings: { ...DEFAULT_SETTINGS, aiExchangeLoggingEnabled: true }, exchanges, running: new Set(), activeTasks: new Map(), pendingSuggestions: new Map(),
    askModel: async (_context, _model, _reasoning, _signal, onExchange) => { onExchange(entry.id); throw new Error('provider timeout'); },
    mutate: async work => work(), views: () => [view], recordFailure: (_context, error) => error.message };
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  view = new VisualAgentMapView({ app }, plugin); view.path = 'Map.md'; view.map = map([n]); view.render = () => {}; view.hydrate = async () => {};
  const originalError = console.error; console.error = () => {};
  try { await view.runAgent(n); await new Promise(resolve => setTimeout(resolve, 20)); }
  finally { console.error = originalError; }
  assert.equal((await repo.readNote(n.path)).status, 'error');
  assert.equal(entry.error, '等待 AI 回覆：provider timeout');
});
integrationTest('proposal persistence failure does not erase completed shallow research', async () => {
  const { repo, app } = fixture(), n = await topicNote(repo, 'Research result');
  await repo.updateNote(n.path, { prompt: 'Research' });
  const pending = new Map(); pending.flush = async () => { throw new Error('disk unavailable'); };
  let exchangeStatus = 'parsed', view, reported = '';
  const plugin = { repo, settings: { ...DEFAULT_SETTINGS, aiExchangeLoggingEnabled: true }, exchanges: { completed: () => { exchangeStatus = 'completed'; }, getEntries: () => [{ id: 'exchange-1', status: exchangeStatus }], failed: () => { exchangeStatus = 'failed'; } }, running: new Set(), activeTasks: new Map(), pendingSuggestions: pending,
    askModel: async (_context, _model, _reasoning, _signal, onExchange) => { onExchange('exchange-1'); return { summary: 'Researched', detail: 'Result body', suggestions: [{ title: 'Proposal', task: 'Investigate', contribution: '' }], visualReferences: [] }; },
    mutate: async work => work(), views: () => [view], recordFailure: (_context, error) => { reported = error.message; return reported; } };
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  view = new VisualAgentMapView({ app }, plugin); view.path = 'Map.md'; view.map = map([n]); view.render = () => {}; view.hydrate = async () => {};
  await view.runAgent(n); await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal((await repo.readNote(n.path)).status, 'completed');
  assert.equal((await repo.readNote(n.path)).summary, 'Researched');
  assert.equal(exchangeStatus, 'completed'); assert.equal(reported, 'disk unavailable');
});
integrationTest('a completed but stale answer cannot overwrite an edited note', async () => {
  const { repo, app } = fixture(), n = await topicNote(repo, 'Stale');
  await repo.updateNote(n.path, { prompt: 'Research', detail: 'Original' });
  let finish; const { VisualAgentMapView } = load('main.ts', { obsidian }); let view;
  const plugin = {
    repo, settings: { ...DEFAULT_SETTINGS }, running: new Set(), activeTasks: new Map(), pendingSuggestions: new Map(),
    askModel: (_context, _model, _reasoning, _signal, _exchange, accepted) => { accepted?.(); return new Promise(resolve => { finish = resolve; }); }, mutate: async work => work(), views: () => [view]
  };
  view = new VisualAgentMapView({ app }, plugin); view.path = 'Map.md'; view.map = map([n]); view.render = () => {}; view.hydrate = async () => {};
  await view.runAgent(n);
  await repo.updateNote(n.path, { detail: 'User edit' });
  finish({ summary: 'Stale summary', detail: 'Stale detail', suggestions: [], visualReferences: [] });
  await new Promise(resolve => setTimeout(resolve, 20));
  const after = await repo.readNote(n.path);
  assert.equal(after.detail, 'User edit'); assert.equal(after.status, 'idea'); assert.notEqual(after.summary, 'Stale summary');
});
integrationTest('new child topics inherit reasoning without activating legacy rules', async () => {
  const { repo, app } = fixture(), parent = await topicNote(repo, 'Parent', 'a');
  await repo.updateNote(parent.path, { rules: 'Use official sources and tables.', reasoning: 'high' });
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md';
  const mapDoc = { id: 'map-a', title: 'map-a', version: 1, nodes: [parent], viewport: { x: 0, y: 0, zoom: 1 } };
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app }, { repo, settings: { ...DEFAULT_SETTINGS }, rebuildDerivedData: async () => {} });
  view.path = mapPath; view.map = mapDoc; view.render = () => {};
  await view.addNode(parent, 'Child');
  const child = (await repo.readMap(mapPath)).nodes.at(-1);
  assert.equal((await repo.readNote(child.path)).rules, '');
  assert.equal((await repo.readNote(child.path)).reasoning, 'high');
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
  ], { researchMode: 'research', researchDepth: 'normal', visualMode: 'auto', referenceGroups: [], multiLayer: true });
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
  await view.createChildBatch(parent, [{ title: 'Research me', task: 'Find evidence', contribution: '', parentTitle: '' }], { researchMode: 'local', researchDepth: 'fast', visualMode: 'off', referenceGroups: [], multiLayer: false, shallowResearch: true });
  assert.deepEqual(researched, []);
  assert.equal((await repo.readNote(view.map.nodes.at(-1).path)).researchMode, 'research');
});
integrationTest('one shallow-research startup failure marks that child and does not strand later children', async () => {
  const { repo, app } = fixture(), parent = await topicNote(repo, 'Parent', 'model-a');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md', mapDoc = map([parent]); mapDoc.id = 'map-a';
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const failures = [], started = [];
  const plugin = withExpansionCoordinator({ repo, settings: { ...DEFAULT_SETTINGS }, running: new Set(), quickExpandFailures: new Map(), pendingSuggestions: new Map(), pendingResearchOptions: new Map(), rebuildDerivedData: async () => {}, mutate: async work => work(), recordFailure: (context, error) => { failures.push(`${context}: ${error.message}`); return error.message; } });
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
integrationTest('cancelling shallow research stops the batch without marking unstarted children as errors', async () => {
  const { repo, app } = fixture(), parent = await topicNote(repo, 'Parent', 'model-a');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md', mapDoc = map([parent]); mapDoc.id = 'map-a';
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const failures = [], started = [], controller = new AbortController(); let finishFirst;
  const plugin = withExpansionCoordinator({ repo, settings: { ...DEFAULT_SETTINGS }, running: new Set(), quickExpandFailures: new Map(), pendingSuggestions: new Map(), pendingResearchOptions: new Map(), rebuildDerivedData: async () => {}, mutate: async work => work(), recordFailure: (context, error) => { failures.push(`${context}: ${error.message}`); return error.message; } });
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
integrationTest('accepted shallow research is parallel, detached from modal close, and stopped by the parent', async () => {
  const { repo, app } = fixture(), parent = await topicNote(repo, 'Parent', 'model-a');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md', mapDoc = map([parent]); mapDoc.id = 'map-a';
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const controller = new AbortController(), started = [], finish = new Map(), signals = [];
  const plugin = withExpansionCoordinator({ repo, settings: { ...DEFAULT_SETTINGS }, rebuildDerivedData: async () => {}, recordFailure: (_context, error) => error.message, mutate: async work => work(), views: () => [view] });
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.contentEl = { querySelector: () => null }; view.render = () => {}; view.hydrate = async () => {};
  view.runAgent = async (child, _done, _failed, options, accepted) => {
    started.push((await repo.readNote(child.path)).title);
    assert.equal(options.referenceGroups.length, 0); assert.equal(options.onProgress, undefined);
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
integrationTest('quick exploration creates two levels directly and leaves them unresearched', async () => {
  const { repo, app } = fixture(), parent = await topicNote(repo, 'Parent', 'model-a');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md';
  const mapDoc = map([parent]); mapDoc.id = 'map-a';
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const plugin = withExpansionCoordinator({ repo, settings: { ...DEFAULT_SETTINGS }, running: new Set(), pendingSuggestions: new Map(), pendingResearchOptions: new Map(), rebuildDerivedData: async () => {}, mutate: async work => work(), askModel: async () => ({ summary: '', detail: '', visualReferences: [], suggestions: [
    { title: 'A', task: 'Explore A', contribution: '', parentTitle: '' },
    { title: 'B', task: 'Explore B', contribution: '', parentTitle: '' },
    { title: 'A1', task: 'Explore A1', contribution: '', parentTitle: 'A' },
    { title: 'B1', task: 'Explore B1', contribution: '', parentTitle: 'B' }
  ] }) });
  const view = new VisualAgentMapView({ app }, plugin);
  view.path = mapPath; view.map = mapDoc; view.contentEl = { querySelector: () => null }; view.render = () => {}; view.hydrate = async () => {}; view.focusNode = () => {};
  let reviewed = 0, completed = 0, researched = 0;
  view.runAgent = async () => { researched++; };
  await view.proposeChildren(parent, true, { researchMode: 'research', researchDepth: 'fast', visualMode: 'off', referenceGroups: [], multiLayer: true, shallowResearch: false, layers: 2, firstLayerCount: 2, childrenPerParent: 1 }, '', () => { reviewed++; }, message => assert.fail(message), true, () => { completed++; });
  const saved = await repo.readMap(mapPath);
  assert.equal(saved.nodes.length, 5); assert.equal(saved.nodes[3].parentId, saved.nodes[1].id); assert.equal(saved.nodes[4].parentId, saved.nodes[2].id);
  assert.equal(reviewed, 0); assert.equal(completed, 1); assert.equal(researched, 0);
  for (const child of saved.nodes.slice(1)) assert.equal((await repo.readNote(child.path)).status, 'idea');
});
integrationTest('quick exploration rejects zero for multiple levels and ignores unused single-level child count', async () => {
  const { repo, app } = fixture(), parent = await topicNote(repo, 'Parent', 'model-a');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md';
  const mapDoc = map([parent]); mapDoc.id = 'map-a';
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  let task = '';
  const plugin = withExpansionCoordinator({ recordFailure: (_label, error) => String(error), repo, settings: { ...DEFAULT_SETTINGS, language: 'en' }, running: new Set(), pendingSuggestions: new Map(), pendingResearchOptions: new Map(), rebuildDerivedData: async () => {}, mutate: async work => work(), askModel: async context => {
    task = context.task;
    return { summary: '', detail: '', visualReferences: [], suggestions: Array.from({ length: 10 }, (_, index) => ({ title: `Child ${index + 1}`, task: `Explore ${index + 1}`, contribution: '', parentTitle: '' })) };
  } });
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.contentEl = { querySelector: () => null }; view.render = () => {}; view.hydrate = async () => {}; view.focusNode = () => {};
  let completed = false;
  let failure = '';
  await view.proposeChildren(parent, true, { multiLayer: true, layers: 2, firstLayerCount: 10, childrenPerParent: 0 }, '', () => assert.fail('invalid shape'), message => { failure = message; }, true);
  assert.match(failure, /positive whole/); assert.equal(task, ''); assert.equal((await repo.readMap(mapPath)).nodes.length, 1);
  await view.proposeChildren(parent, true, { researchMode: 'research', researchDepth: 'fast', visualMode: 'off', referenceGroups: [], multiLayer: true, layers: 1, firstLayerCount: 10, childrenPerParent: NaN }, '', () => assert.fail('quick map should not show review'), message => assert.fail(message), true, () => { completed = true; });
  const saved = await repo.readMap(mapPath);
  assert.equal(saved.nodes.length, 11);
  assert.ok(saved.nodes.slice(1).every(child => child.parentId === parent.id));
  assert.match(task, /1 level/);
  assert.match(task, /total: 10/);
  assert.equal(completed, true);
});
integrationTest('quick exploration gives every parent two children across three levels and starts optional research', async () => {
  const { repo, app } = fixture(), parent = await topicNote(repo, 'Parent', 'model-a');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md';
  const mapDoc = map([parent]); mapDoc.id = 'map-a';
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const suggestions = []; let parents = [''];
  for (let depth = 0; depth < 3; depth++) {
    const current = [];
    for (const parentTitle of parents) for (let index = 0; index < 2; index++) {
      const title = `L${depth}-${current.length}`;
      suggestions.push({ title, task: `Research ${title}`, contribution: '', parentTitle }); current.push(title);
    }
    parents = current;
  }
  const plugin = withExpansionCoordinator({ repo, settings: { ...DEFAULT_SETTINGS }, running: new Set(), quickExpandFailures: new Map(), pendingSuggestions: new Map(), pendingResearchOptions: new Map(), rebuildDerivedData: async () => {}, mutate: async work => work(), recordFailure: (_context, error) => error.message, askModel: async () => ({ summary: '', detail: '', visualReferences: [], suggestions }) });
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.contentEl = { querySelector: () => null }; view.render = () => {}; view.hydrate = async () => {}; view.focusNode = () => {};
  let researched = 0; view.runAgent = async (child, _done, _failed, _options, accepted) => { researched++; await repo.updateNote(child.path, { status: 'running' }); accepted?.(); return { finished: Promise.resolve() }; };
  await view.proposeChildren(parent, true, { researchMode: 'research', researchDepth: 'fast', visualMode: 'off', referenceGroups: [], multiLayer: true, shallowResearch: true, layers: 3, firstLayerCount: 2, childrenPerParent: 2 }, '', () => assert.fail('quick map should not show review'), message => assert.fail(message), true);
  await until(() => plugin.expansionBatches.get(parent.path).status !== 'running');
  const saved = await repo.readMap(mapPath);
  assert.equal(saved.nodes.length, 15); assert.equal(researched, 14);
  const byTitle = new Map(); for (const item of saved.nodes.slice(1)) byTitle.set((await repo.readNote(item.path)).title, item);
  for (const item of suggestions) assert.equal(byTitle.get(item.title).parentId, item.parentTitle ? byTitle.get(item.parentTitle).id : parent.id);
});
integrationTest('quick exploration rejects an uneven branch before creating any topic', async () => {
  const { repo, app } = fixture(), parent = await topicNote(repo, 'Parent', 'model-a');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md'; const mapDoc = map([parent]); mapDoc.id = 'map-a';
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const suggestions = [
    { title: 'A', task: 'Explore A', contribution: '', parentTitle: '' },
    { title: 'B', task: 'Explore B', contribution: '', parentTitle: '' },
    { title: 'A1', task: 'Explore A1', contribution: '', parentTitle: 'A' },
    { title: 'A2', task: 'Explore A2', contribution: '', parentTitle: 'A' }
  ];
  const plugin = withExpansionCoordinator({ repo, settings: { ...DEFAULT_SETTINGS }, running: new Set(), pendingSuggestions: new Map(), pendingResearchOptions: new Map(), rebuildDerivedData: async () => {}, mutate: async work => work(), recordFailure: (_context, error) => error.message, askModel: async () => ({ summary: '', detail: '', visualReferences: [], suggestions }) });
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.contentEl = { querySelector: () => null }; view.render = () => {}; view.hydrate = async () => {};
  let failure = '';
  await view.proposeChildren(parent, true, { researchMode: 'research', researchDepth: 'fast', visualMode: 'off', referenceGroups: [], multiLayer: true, layers: 2, firstLayerCount: 2, childrenPerParent: 1 }, '', () => assert.fail('uneven map accepted'), message => { failure = message; }, true);
  assert.match(failure, /level counts and parent-child structure/);
  assert.equal((await repo.readMap(mapPath)).nodes.length, 1);
});
integrationTest('quick AI wait leaves map mutations free and uses the latest parent position', async () => {
  const { repo, app } = fixture(), parent = await topicNote(repo, 'Parent', 'model-a');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md'; const mapDoc = map([parent]); mapDoc.id = 'map-a';
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  let resolveModel, tail = Promise.resolve();
  const plugin = withExpansionCoordinator({ repo, settings: { ...DEFAULT_SETTINGS }, running: new Set(), pendingSuggestions: new Map(), pendingResearchOptions: new Map(), rebuildDerivedData: async () => {}, recordFailure: (_context, error) => error.message,
    askModel: () => new Promise(resolve => { resolveModel = resolve; }), mutate(work) { const job = tail.then(work); tail = job.catch(() => {}); return job; } });
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.contentEl = { querySelector: () => null }; view.render = () => {}; view.hydrate = async () => {}; view.focusNode = () => {};
  const options = { researchMode: 'local', researchDepth: 'fast', visualMode: 'off', referenceGroups: [], multiLayer: true, shallowResearch: false, layers: 1, firstLayerCount: 1, childrenPerParent: 1 };
  const job = view.startQuickExpansion(parent, options, '', message => assert.fail(message), () => {});
  await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(plugin.quickExpandPending.has(parent.path), true);
  let moved = false;
  const change = plugin.mutate(async () => { await view.mapChange(map => { map.nodes[0].x = 500; }, false); moved = true; });
  const progressed = await Promise.race([change.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 100))]);
  resolveModel({ summary: '', detail: '', visualReferences: [], suggestions: [{ title: 'Child', task: 'Explore', contribution: '', parentTitle: '' }] });
  await job;
  assert.equal(progressed, true); assert.equal(moved, true);
  const saved = await repo.readMap(mapPath); assert.equal(saved.nodes.length, 2); assert.equal(saved.nodes[1].x, 860);
  assert.equal(plugin.quickExpandPending.size, 0);
});
integrationTest('accepted quick expansion closes its modal but completes after a deferred provider result', async () => {
  const { repo, app } = fixture(), parent = await topicNote(repo, 'Parent', 'model-a');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md', mapDoc = map([parent]); mapDoc.id = 'map-a';
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const pending = deferred(), modalController = new AbortController(); let accepted = false, created = 0;
  const plugin = withExpansionCoordinator({
    repo, settings: { ...DEFAULT_SETTINGS, language: 'en' }, running: new Set(), pendingSuggestions: new Map(), pendingResearchOptions: new Map(),
    rebuildDerivedData: async () => {}, mutate: async work => work(), recordFailure: (_context, error) => error.message,
    askModel: (_context, _model, _reasoning, _signal, _exchange, onAccepted) => { onAccepted?.(); return pending.promise; }
  });
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.contentEl = { querySelector: () => null }; view.render = () => {}; view.hydrate = async () => {}; view.focusNode = () => {};
  const options = { researchMode: 'local', researchDepth: 'fast', visualMode: 'off', referenceGroups: [], multiLayer: true, shallowResearch: false, layers: 1, firstLayerCount: 1, childrenPerParent: 1, signal: modalController.signal };
  const job = view.startQuickExpansion(parent, options, '', message => assert.fail(message), () => { created++; }, () => { accepted = true; modalController.abort(); });
  await until(() => accepted);
  assert.equal(modalController.signal.aborted, true);
  assert.ok(plugin.running.has(parent.path));
  assert.ok(plugin.activeTasks.has(parent.path));
  assert.equal(plugin.activeTasks.get(parent.path).signal.aborted, false);
  pending.resolve({ summary: '', detail: '', visualReferences: [], suggestions: [{ title: 'Accepted child', task: 'Explore this', contribution: '', parentTitle: '' }] });
  await job;
  assert.equal(created, 1);
  assert.equal(plugin.activeTasks.has(parent.path), false);
  assert.equal(plugin.quickExpandPending.has(parent.path), false);
  const saved = await repo.readMap(mapPath);
  assert.equal(saved.nodes.length, 2);
  assert.equal((await repo.readNote(saved.nodes[1].path)).title, 'Accepted child');
});
integrationTest('stopping quick shallow research before child acceptance keeps created nodes without an expansion failure', async () => {
  const { repo, app } = fixture(), parent = await topicNote(repo, 'Parent', 'model-a');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md', mapDoc = map([parent]); mapDoc.id = 'map-a';
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const failures = [], plugin = withExpansionCoordinator({
    repo, settings: { ...DEFAULT_SETTINGS }, running: new Set(), pendingSuggestions: new Map(), pendingResearchOptions: new Map(),
    rebuildDerivedData: async () => {}, mutate: async work => work(), recordFailure: (context, error) => { failures.push(`${context}: ${error.message}`); return error.message; },
    askModel: async (_context, _model, _reasoning, _signal, _exchange, accepted) => {
      accepted?.();
      return { summary: '', detail: '', visualReferences: [], suggestions: [{ title: 'Accepted child', task: 'Explore this', contribution: '', parentTitle: '' }] };
    }
  });
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.contentEl = { querySelector: () => null }; view.render = () => {}; view.hydrate = async () => {}; view.focusNode = () => {};
  let childSignal, failure = '';
  view.runAgent = async (_child, _done, failed, options) => {
    childSignal = options.signal;
    return new Promise(resolve => childSignal.addEventListener('abort', () => resolve(null), { once: true }));
  };
  const job = view.startQuickExpansion(parent, { researchMode: 'research', researchDepth: 'fast', visualMode: 'off', referenceGroups: [], multiLayer: true, shallowResearch: true, layers: 1, firstLayerCount: 1, childrenPerParent: 1 }, '', message => { failure = message; }, () => {});
  await until(() => childSignal);
  plugin.expansionCoordinator.stop(parent.path);
  await job;
  const saved = await repo.readMap(mapPath);
  assert.equal(saved.nodes.length, 2);
  assert.equal((await repo.readNote(saved.nodes[1].path)).title, 'Accepted child');
  assert.equal(childSignal.aborted, true);
  assert.equal(plugin.expansionBatches.get(parent.path).status, 'stopped');
  assert.equal(plugin.expansionBatches.get(parent.path).failures.length, 0);
  assert.equal(plugin.quickExpandFailures.has(parent.path), false);
  assert.equal(plugin.quickExpandPending.has(parent.path), false);
  assert.deepEqual(failures, []);
  assert.equal(failure, '');
});
integrationTest('quick expansion keeps a genuine provider failure visible', async () => {
  const { repo, app } = fixture(), parent = await topicNote(repo, 'Parent', 'model-a');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md', mapDoc = map([parent]); mapDoc.id = 'map-a';
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  let attempts = 0;
  const plugin = withExpansionCoordinator({ repo, settings: { ...DEFAULT_SETTINGS }, running: new Set(), pendingSuggestions: new Map(), pendingResearchOptions: new Map(), rebuildDerivedData: async () => {}, mutate: async work => work(), recordFailure: (_context, error) => error.message,
    askModel: async (_context, _model, _reasoning, _signal, _exchange, accepted) => {
      attempts++;
      if (attempts === 1) {
        accepted?.();
        return { summary: '', detail: '', visualReferences: [], suggestions: [{ title: 'Stopped child', task: 'Explore this', contribution: '', parentTitle: '' }] };
      }
      throw new Error('provider unavailable');
    } });
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.contentEl = { querySelector: () => null }; view.render = () => {}; view.hydrate = async () => {};
  let childSignal;
  view.runAgent = async (_child, _done, _failed, options) => { childSignal = options.signal; return new Promise(resolve => childSignal.addEventListener('abort', () => resolve(null), { once: true })); };
  const research = view.startQuickExpansion(parent, { researchMode: 'research', researchDepth: 'fast', visualMode: 'off', referenceGroups: [], multiLayer: true, shallowResearch: true, layers: 1, firstLayerCount: 1, childrenPerParent: 1 }, '', message => assert.fail(message), () => {});
  await until(() => childSignal);
  plugin.expansionCoordinator.stop(parent.path);
  await research;
  assert.equal(plugin.expansionBatches.get(parent.path).status, 'stopped');
  assert.equal(plugin.quickExpandFailures.has(parent.path), false);
  let failure = '';
  await view.startQuickExpansion(parent, { researchMode: 'research', researchDepth: 'fast', visualMode: 'off', referenceGroups: [], multiLayer: true, shallowResearch: false, layers: 1, firstLayerCount: 1, childrenPerParent: 1 }, '', message => { failure = message; }, () => {});
  assert.equal(failure, 'provider unavailable');
  assert.equal(plugin.quickExpandFailures.get(parent.path), 'provider unavailable');
});
integrationTest('Map Stop before accepted decomposition ignores a late answer without creating children', async () => {
  const { repo, app } = fixture(), parent = await topicNote(repo, 'Parent', 'model-a');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md', mapDoc = map([parent]); mapDoc.id = 'map-a';
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  let resolveModel, accepted = false, recorded = [];
  const plugin = withExpansionCoordinator({ repo, settings: { ...DEFAULT_SETTINGS }, running: new Set(), pendingSuggestions: new Map(), pendingResearchOptions: new Map(), rebuildDerivedData: async () => {}, mutate: async work => work(), recordFailure: (context, error) => { recorded.push(`${context}: ${error.message}`); return error.message; },
    askModel: (_context, _model, _reasoning, _signal, _exchange, onAccepted) => { onAccepted?.(); accepted = true; return new Promise(resolve => { resolveModel = resolve; }); } });
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.contentEl = { querySelector: () => null }; view.render = () => {}; view.hydrate = async () => {}; view.focusNode = () => {};
  const job = view.startQuickExpansion(parent, { researchMode: 'research', researchDepth: 'fast', visualMode: 'off', referenceGroups: [], multiLayer: true, shallowResearch: true, layers: 1, firstLayerCount: 1, childrenPerParent: 1 }, '', message => assert.fail(message), () => {});
  await until(() => accepted && plugin.activeTasks.has(parent.path));
  plugin.activeTasks.get(parent.path).abort();
  resolveModel({ summary: '', detail: '', visualReferences: [], suggestions: [{ title: 'Late child', task: 'Explore this', contribution: '', parentTitle: '' }] });
  await job;
  assert.equal((await repo.readMap(mapPath)).nodes.length, 1);
  assert.equal(plugin.quickExpandFailures.has(parent.path), false);
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
    const plugin = withExpansionCoordinator({ repo, settings: { ...DEFAULT_SETTINGS }, running: new Set(), pendingSuggestions: new Map(), pendingResearchOptions: new Map(), rebuildDerivedData: async () => {}, mutate: async work => work(), recordFailure: (context, error) => { failed.push(`${context}: ${error.message}`); return error.message; },
      askModel: (_context, _model, _reasoning, signal, _exchange, onAccepted) => {
        providerSignal = signal;
        onAccepted?.(); accepted = true;
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(makeError()), { once: true }));
      } });
    const { VisualAgentMapView } = load('main.ts', { obsidian });
    const view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.contentEl = { querySelector: () => null }; view.render = () => {}; view.hydrate = async () => {}; view.focusNode = () => {};
    let failedCallback = '';
    const job = view.startQuickExpansion(parent, { researchMode: 'research', researchDepth: 'fast', visualMode: 'off', referenceGroups: [], multiLayer: true, shallowResearch: true, layers: 1, firstLayerCount: 1, childrenPerParent: 1 }, '', message => { failedCallback = message; }, () => {});
    await until(() => accepted && plugin.activeTasks.has(parent.path));
    assert.equal(plugin.activeTasks.get(parent.path).signal.aborted, false);
    plugin.activeTasks.get(parent.path).abort();
    await job;
    assert.equal(providerSignal.aborted, true);
    assert.equal((await repo.readMap(mapPath)).nodes.length, 1);
    assert.equal(plugin.quickExpandFailures.has(parent.path), false);
    assert.equal(failedCallback, '');
    assert.deepEqual(failed, []);
    assert.equal(plugin.activeTasks.has(parent.path), false);
    assert.equal(plugin.running.has(parent.path), false);
    assert.equal(plugin.quickExpandPending.has(parent.path), false);
  }
});
integrationTest('quick expansion reports a terminal render exception through its outer failure handler', async () => {
  const { repo, app } = fixture(), parent = await topicNote(repo, 'Parent', 'model-a');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md', mapDoc = map([parent]); mapDoc.id = 'map-a';
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  let accepted = false, providerSignal, terminalRenderFailed = false;
  const plugin = withExpansionCoordinator({ repo, settings: { ...DEFAULT_SETTINGS }, running: new Set(), pendingSuggestions: new Map(), pendingResearchOptions: new Map(), rebuildDerivedData: async () => {}, mutate: async work => work(), recordFailure: (_context, error) => error.message,
    askModel: (_context, _model, _reasoning, signal, _exchange, onAccepted) => {
      providerSignal = signal;
      onAccepted?.(); accepted = true;
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => { const error = new Error('cancelled'); error.name = 'AbortError'; reject(error); }, { once: true }));
    } });
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.contentEl = { querySelector: () => null }; view.hydrate = async () => {}; view.focusNode = () => {};
  view.render = () => { if (providerSignal?.aborted && !terminalRenderFailed) { terminalRenderFailed = true; throw new Error('terminal render failure'); } };
  let failure = '';
  const job = view.startQuickExpansion(parent, { researchMode: 'research', researchDepth: 'fast', visualMode: 'off', referenceGroups: [], multiLayer: true, shallowResearch: false, layers: 1, firstLayerCount: 1, childrenPerParent: 1 }, '', message => { failure = message; }, () => {});
  await until(() => accepted && plugin.activeTasks.has(parent.path));
  plugin.activeTasks.get(parent.path).abort();
  await assert.rejects(job, /terminal render failure/);
  assert.equal(terminalRenderFailed, true);
  assert.equal(failure, '');
  assert.equal(plugin.quickExpandFailures.get(parent.path), 'Error: terminal render failure');
  assert.equal(plugin.activeTasks.has(parent.path), false);
  assert.equal(plugin.running.has(parent.path), false);
});
integrationTest('quick map discards a delayed answer when its parent has been removed', async () => {
  const { repo, app } = fixture(), parent = await topicNote(repo, 'Parent', 'model-a');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md'; const mapDoc = map([parent]); mapDoc.id = 'map-a';
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  let resolveModel, tail = Promise.resolve(), error = '';
  const plugin = withExpansionCoordinator({ repo, settings: { ...DEFAULT_SETTINGS }, running: new Set(), pendingSuggestions: new Map(), pendingResearchOptions: new Map(), rebuildDerivedData: async () => {}, recordFailure: (_context, failure) => failure.message,
    askModel: () => new Promise(resolve => { resolveModel = resolve; }), mutate(work) { const job = tail.then(work); tail = job.catch(() => {}); return job; } });
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.contentEl = { querySelector: () => null }; view.render = () => {}; view.hydrate = async () => {}; view.focusNode = () => {};
  const options = { researchMode: 'local', researchDepth: 'fast', visualMode: 'off', referenceGroups: [], multiLayer: true, shallowResearch: false, layers: 1, firstLayerCount: 1, childrenPerParent: 1 };
  const job = view.startQuickExpansion(parent, options, '', message => { error = message; }, () => assert.fail('stale result created nodes'));
  await new Promise(resolve => setTimeout(resolve, 0));
  await plugin.mutate(() => view.mapChange(map => { map.nodes = []; }));
  resolveModel({ summary: '', detail: '', visualReferences: [], suggestions: [{ title: 'Stale child', task: 'Explore', contribution: '', parentTitle: '' }] });
  await job;
  assert.match(error, /map or parent topic changed/); assert.equal((await repo.readMap(mapPath)).nodes.length, 0);
  assert.equal(plugin.quickExpandPending.size, 0); assert.ok(plugin.quickExpandFailures.has(parent.path));
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
  const options = { researchMode: 'local', researchDepth: 'fast', visualMode: 'off', referenceGroups: [{ name: 'Reference map', documents: [{ path: 'map/topic.md', content: 'private source' }] }], multiLayer: false, shallowResearch: true };
  await view.proposeChildren({ id: 'parent', path: 'parent.md' }, true, options, '', (_items, confirm) => { create = confirm; }, message => assert.fail(message));
  const storedChoices = plugin.pendingResearchOptions.get('parent.md');
  assert.equal(storedChoices.researchMode, 'local'); assert.equal(storedChoices.researchDepth, 'fast'); assert.equal(storedChoices.visualMode, 'off');
  assert.equal(storedChoices.referenceGroups.length, 0); assert.equal(storedChoices.signal, undefined); assert.equal(storedChoices.onProgress, undefined);
  await create(suggestions);
  assert.equal(queued, 1); assert.equal(used.researchMode, 'local'); assert.equal(used.researchDepth, 'fast'); assert.equal(used.visualMode, 'off'); assert.equal(used.referenceGroups.length, 0); assert.notEqual(used, options); assert.equal(plugin.pendingSuggestions.has('parent.md'), false);
  assert.equal(startedResearch.queued, 1); assert.equal(startedResearch.children.length, 1); assert.equal(startedResearch.options.referenceGroups.length, 0);
  plugin.pendingSuggestions.set('parent.md', suggestions); plugin.pendingResearchOptions.set('parent.md', options);
  await view.proposeChildren({ id: 'parent', path: 'parent.md' }, true, { ...options, shallowResearch: false }, '', () => {}, message => assert.fail(message));
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
  await first.proposeChildren({ id: 'parent', path: 'parent.md' }, true, undefined, '', (_items, accept) => { acceptFirst = accept; });
  await second.proposeChildren({ id: 'parent', path: 'parent.md' }, true, undefined, '', (_items, accept) => { acceptSecond = accept; });
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
  await view.proposeChildren(parent, true, undefined, '', (_items, confirm) => { create = confirm; }, message => assert.fail(message));
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
  const plugin = { repo, settings: { ...DEFAULT_SETTINGS }, running: new Set(), mutate: async work => work(), askModel: async context => { contexts.push(context); return contexts.length === 1 ? { summary: '', detail: '', visualReferences: [], suggestions: [{ title: 'Common ground', task: 'Find shared constraints', contribution: 'A shared view', parentTitle: '' }] } : { summary: 'Draft summary', detail: 'Draft detail', visualReferences: [], suggestions: [] }; } };
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.render = () => {}; view.hydrate = async () => {}; view.ancestorContext = async () => '';
  let choose, save;
  const options = { requirements: 'Only compare cost', researchMode: 'local', researchDepth: 'normal', visualMode: 'off', referenceGroups: [{ id: 'picked', name: 'Picked', location: '/refs', documents: [{ path: '/refs/selected.md', content: 'Selected note content', external: true }] }] };
  await view.proposeIntegrationDirections(parent, options, (items, draft) => { assert.equal(items[0].title, 'Common ground'); choose = draft; }, (_result, commit) => { save = commit; }, message => assert.fail(message));
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
    const plugin = { repo, settings: { ...DEFAULT_SETTINGS }, running: new Set(), mutate: async work => work(), recordFailure: (_label, error) => error.message,
      askModel: async context => { contexts.push(context); return contexts.length === 1 ? { suggestions: [{ title: 'Direction', task: 'Compare evidence', contribution: '' }] } : { summary: 'Draft', detail: 'Draft', visualReferences: [], suggestions: [] }; } };
    const view = new VisualAgentMapView({ app }, plugin); view.map = map([parent, ...children, grandchild, unrelated]); view.render = () => {}; view.hydrate = async () => {}; view.ancestorContext = async () => '';
    let draft, save;
    const options = { researchMode: 'local', researchDepth: 'normal', visualMode: 'off', requirements: 'Respect the budget', referenceGroups: [selected], ...(choice ? { synthesisContent: choice } : {}) };
    await view.proposeIntegrationDirections(parent, options, (_items, next) => { draft = next; }, (_result, commit) => { save = commit; }, message => assert.fail(message));
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
    await assert.rejects(view.createIntegratedNode('Draft', [a, b], 'Compare', '', { synthesisContent: choice, requirements: 'This run only', referenceGroups: [extra] }, true), /Stop before any write/);
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
  const plugin = { repo, settings: { ...DEFAULT_SETTINGS }, running: new Set(), mutate: async work => work(), recordFailure: (_label, error) => error.message, askModel: async context => {
    const batches = referenceBatches(context.referenceGroups).join('\n');
    assert.match(batches, /FULL_OVERLAP_CONDITION/);
    assert.equal(batches.split('FULL_OVERLAP_CONDITION').length - 1, 1);
    calls++;
    return { summary: 'Draft', detail: 'Draft', visualReferences: [], suggestions: [{ title: 'Angle', task: 'Compare', contribution: '' }] };
  } };
  const view = new VisualAgentMapView({ app }, plugin); view.map = map([parent, a, b]); view.render = () => {}; view.hydrate = async () => {}; view.ancestorContext = async () => '';
  const options = { synthesisContent: 'summary', referenceGroups: [extra], researchMode: 'local', researchDepth: 'normal', visualMode: 'off' };
  let draft;
  await view.proposeIntegrationDirections(parent, options, (_items, next) => { draft = next; }, () => {}, message => assert.fail(message));
  await draft('Compare');
  view.saveIntegratedNode = async () => {};
  await view.createIntegratedNode('Combined', [a, b], 'Compare', '', options);
  assert.equal(calls, 3);
  assert.equal(await app.vault.read(repo.file(a.path)), full);
});
integrationTest('synthesis can use selected notes when a topic has no children', async () => {
  const { repo, app } = fixture(), parent = await topicNote(repo, 'Parent', 'model-a');
  const contexts = [];
  const plugin = { repo, settings: { ...DEFAULT_SETTINGS }, running: new Set(), mutate: async work => work(), recordFailure: (_context, error) => error.message, askModel: async context => { contexts.push(context); return contexts.length === 1 ? { summary: '', detail: '', suggestions: [{ title: 'Shared view', task: 'Combine notes', contribution: '' }] } : { summary: 'Combined', detail: 'Combined detail', suggestions: [] }; } };
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app }, plugin); view.map = map([parent]); view.render = () => {}; view.hydrate = async () => {}; view.ancestorContext = async () => '';
  const empty = { researchMode: 'local', researchDepth: 'normal', visualMode: 'off', referenceGroups: [] };
  let failure = '';
  await view.proposeIntegrationDirections(parent, empty, () => assert.fail('missing sources'), () => {}, message => { failure = message; });
  assert.match(failure, /Choose another note source first/);
  assert.equal(contexts.length, 0);
  await view.proposeIntegrationDirections(parent, { ...empty, referenceGroups: [{ id: 'empty', name: 'Empty', location: '', documents: [] }] }, () => assert.fail('empty source'), () => {}, message => { failure = message; });
  assert.match(failure, /Choose another note source first/);
  assert.equal(contexts.length, 0);
  let draft, save;
  const selectedGroup = { id: 'selected', name: 'Selected', location: '/refs', documents: [{ path: '/refs/selected.md', content: 'Selected note content', external: true }] };
  await view.proposeIntegrationDirections(parent, { ...empty, referenceGroups: [selectedGroup] }, (_items, next) => { draft = next; }, (_result, commit) => { save = commit; }, message => assert.fail(message));
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
  const plugin = withExpansionCoordinator({ repo, settings: { ...DEFAULT_SETTINGS }, running: new Set(), pendingSuggestions: new Map(), askModel: async () => ({ summary: '', detail: '', visualReferences: [], suggestions: [{ title: 'Only one', task: '', contribution: '' }, { title: 'Only two', task: '', contribution: '' }] }) });
  const view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.render = () => {}; view.hydrate = async () => {}; view.openChildSuggestions = () => {};
  await view.proposeChildren(parent, true);
  assert.equal(plugin.pendingSuggestions.get(parent.path).length, 2);
  plugin.pendingSuggestions.clear();
  assert.equal((await repo.readMap(mapPath)).nodes.length, 1);
  plugin.askModel = async () => ({ summary: '', detail: '', visualReferences: [], suggestions: [{ title: 'Only one', task: '', contribution: '' }] });
  await view.proposeChildren(parent, true);
  assert.equal(plugin.pendingSuggestions.get(parent.path).length, 1);
  plugin.pendingSuggestions.clear();
  plugin.askModel = async () => ({ summary: '', detail: '', visualReferences: [], suggestions: Array.from({ length: 8 }, (_, index) => ({ title: `Suggestion ${index + 1}`, task: '', contribution: '' })) });
  await view.proposeChildren(parent, true);
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
  const plugin = withExpansionCoordinator({ recordFailure: (_label, error) => String(error), repo, settings: { ...DEFAULT_SETTINGS, language: 'en' }, running: new Set(), pendingSuggestions: new Map(), askModel: async context => { task = context.task; return { summary: '', detail: '', visualReferences: [], suggestions: Array.from({ length: 3 }, (_, index) => ({ title: `Idea ${index}`, task: 'Research', contribution: '' })) }; } });
  const view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.render = () => {}; view.hydrate = async () => {}; view.openChildSuggestions = () => {}; view.ancestorContext = async () => '';
  await view.proposeChildren(parent, true);
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
  const plugin = withExpansionCoordinator({ repo, settings: { ...DEFAULT_SETTINGS }, running: new Set(), pendingSuggestions: new Map(), askModel: async context => { captured = context; return { summary: 'No split', detail: '', visualReferences: [], suggestions: [] }; } });
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.notes.set(child.id, await repo.readNote(child.path)); view.render = () => {}; view.hydrate = async () => {};
  await view.proposeChildren(parent, true);
  assert.match(captured.task, /Existing direct subtopics/);
  assert.match(captured.task, /交通/);
  assert.match(captured.task, /do not pad the count/);
  assert.equal(captured.researchMode, 'research');
  assert.equal(captured.referenceGroups, undefined);
  assert.equal(plugin.pendingSuggestions.size, 0);
});
integrationTest('duplicating the built-in sample creates an independent editable map with new identities', async () => {
  const { repo, app } = fixture();
  const { default: Plugin } = load('main.ts', { obsidian });
  const plugin = new Plugin(); plugin.app = app; plugin.repo = repo; plugin.settings = { ...DEFAULT_SETTINGS }; plugin.saveSettings = async () => {};
  const mapPath = await plugin.duplicateBuiltInSample();
  const sample = await repo.readMap(mapPath);
  assert.match(mapPath, /Agent Workspace\/Topics\/Sample Planning a Taiwan Journey\/Map\.md$/);
  assert.equal(sample.nodes.length, 12);
  assert.equal(sample.nodes.filter(node => node.parentId === null).length, 2);
  assert.notEqual(sample.id, 'builtin-taiwan-travel');
  assert.ok(sample.nodes.every(node => !['explore', 'constraints', 'transport', 'food', 'nature', 'journey'].includes(node.id)));
  const synthesis = await repo.readNote(sample.nodes.find(node => node.x === 1050).path);
  assert.equal(synthesis.status, 'completed'); assert.equal(synthesis.sourcePaths.length, 6);
  assert.ok(synthesis.sourcePaths.every(source => source.startsWith('Agent Workspace/Topics/')));
  assert.ok(app.vault.getAbstractFileByPath('Agent Workspace/Topics/Sample Planning a Taiwan Journey/Attachments/east-coast-landscape.webp'));
});
integrationTest('failed Sample duplication removes only its new map and reports cleanup failures', async () => {
  const { repo, app, files, contents } = fixture();
  const existingPath = await repo.createMap('Sample Planning a Taiwan Journey');
  const existingMap = contents.get(existingPath);
  const { default: Plugin } = load('main.ts', { obsidian });
  const plugin = new Plugin(); plugin.app = app; plugin.repo = repo; plugin.settings = { ...DEFAULT_SETTINGS }; plugin.saveSettings = async () => {};
  const trashFile = async folder => {
    for (const [path, item] of Array.from(files.entries())) if (path === folder.path || path.startsWith(`${folder.path}/`)) { files.delete(path); contents.delete(path); item.parent?.children && (item.parent.children = item.parent.children.filter(child => child !== item)); }
  };
  app.fileManager.trashFile = trashFile;
  const createBinary = app.vault.createBinary;
  app.vault.createBinary = async () => { throw new Error('injected attachment failure'); };
  await assert.rejects(plugin.duplicateBuiltInSample(), /injected attachment failure/);
  app.vault.createBinary = createBinary;
  assert.equal(contents.get(existingPath), existingMap);
  assert.ok(app.vault.getAbstractFileByPath(existingPath));
  assert.equal(!!app.vault.getAbstractFileByPath('Agent Workspace/Topics/Sample Planning a Taiwan Journey 2'), false);

  const cleanupFailure = new Error('injected cleanup failure');
  app.fileManager.trashFile = async () => { throw cleanupFailure; };
  app.vault.createBinary = async () => { throw new Error('injected second attachment failure'); };
  await assert.rejects(plugin.duplicateBuiltInSample(), /cleanup failed for Agent Workspace\/Topics\/Sample Planning a Taiwan Journey 2: Error: injected cleanup failure/);
});

integrationTest('Sample rollback covers creation failures and never adopts a colliding or replaced folder', async () => {
  const { default: Plugin } = load('main.ts', { obsidian });
  for (const stage of ['root-collision', 'child-folder', 'map-file', 'read-map', 'note-create', 'note-update', 'save-map', 'rebuild', 'settings', 'replacement']) {
    const { repo, app, files, contents } = fixture('en');
    const oldPath = await repo.createMap('Existing');
    const oldMap = await repo.readMap(oldPath);
    const oldNode = await repo.createNote('Existing note', 'model', oldMap, oldPath, 'workspace');
    const before = new Map(contents);
    const plugin = new Plugin(); Object.assign(plugin, { app, repo, settings: { ...DEFAULT_SETTINGS }, saveSettings: async () => {} });
    const root = 'Agent Workspace/Topics/Sample Planning a Taiwan Journey';
    const trashed = [];
    app.fileManager.trashFile = async folder => { trashed.push(folder.path); for (const key of [...files.keys()]) if (key === folder.path || key.startsWith(folder.path + '/')) { files.delete(key); contents.delete(key); } };
    const fail = () => { throw new Error('injected ' + stage); };
    const createFolder = app.vault.createFolder;
    if (stage === 'root-collision') app.vault.createFolder = async path => { if (path === root) { await createFolder(path); fail(); } return createFolder(path); };
    if (stage === 'child-folder') app.vault.createFolder = async path => { if (path === root + '/Unassigned') fail(); return createFolder(path); };
    const create = app.vault.create;
    if (stage === 'map-file') app.vault.create = async (path, data) => { if (path === root + '/Map.md') fail(); return create(path, data); };
    if (stage === 'read-map') repo.readMap = fail;
    if (stage === 'note-create') repo.createNote = fail;
    if (stage === 'note-update') repo.updateNote = fail;
    if (stage === 'save-map') repo.saveMap = fail;
    if (stage === 'rebuild') repo.rebuildDerivedData = fail;
    if (stage === 'settings') plugin.saveSettings = fail;
    if (stage === 'replacement') app.vault.createBinary = async () => { files.set(root, new TFolder(root)); fail(); };
    await assert.rejects(plugin.duplicateBuiltInSample(), /injected/);
    const preserved = stage === 'root-collision' || stage === 'replacement';
    assert.equal(!!files.get(root), preserved, stage);
    assert.deepEqual(trashed, preserved ? [] : [root], stage);
    for (const [path, content] of before) assert.equal(contents.get(path), content, stage + ': ' + path);
    assert.ok(files.get(oldNode.path));
  }
});

integrationTest('guided proposals support zero, one, two and seven, saving selected edits and rejecting a switched map', async () => {
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  for (const count of [0, 1, 2, 7]) {
    const { repo, app } = fixture('en');
    const path = await repo.createMap('Guided'), doc = await repo.readMap(path);
    const parent = await repo.createNote('Parent', 'model-a', doc, path, 'workspace'); doc.nodes.push(parent); await repo.saveMap(path, doc);
    const plugin = withExpansionCoordinator({ repo, settings: { ...DEFAULT_SETTINGS }, running: new Set(), pendingSuggestions: new Map(), pendingResearchOptions: new Map(), mutate: async work => work(), rebuildDerivedData: async () => {}, askModel: async () => ({ summary: '', detail: 'No useful split', suggestions: Array.from({length: count}, (_, i) => ({title: 'Child ' + i, task: 'Explore', contribution: ''})) }) });
    const view = new VisualAgentMapView({app}, plugin); Object.assign(view, {path, map: doc, contentEl: {querySelector: () => null}, render() {}, async hydrate() {}, focusNode() {}});
    let offered, confirm, failure, renderedPending;
    view.render = () => { renderedPending = plugin.pendingSuggestions.size; };
    await view.proposeChildren(parent, true, {}, '', (items, create) => { offered = items; confirm = create; }, message => { failure = message; });
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
test('first-use map view waits for async initialization and opens the official Sample once', async () => {
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  let resolveReady, pending = true, opened = 0;
  const ready = new Promise(resolve => { resolveReady = resolve; });
  const plugin = {
    ready,
    consumeFirstInstallSample() { const value = pending; pending = false; return value; },
    repo: { workspaceExists: () => false, mapFiles: async () => [] }
  };
  const view = new VisualAgentMapView({ app: {} }, plugin);
  view.contentEl = { addClass() {} }; view.registerDomEvent = () => {};
  view.openBuiltInSample = async () => { opened++; view.builtIn = true; };
  const opening = view.onOpen();
  await Promise.resolve();
  assert.equal(opened, 0, 'the view must not read workspace data before initialization completes');
  resolveReady(); await opening;
  assert.equal(pending, false);
  assert.equal(opened, 1);
  assert.equal(view.builtIn, true);
});
test('the first AI task shows a provider-specific usage acknowledgement only once', () => {
  const source = fs.readFileSync(path.join(root, 'main.ts'), 'utf8');
  const settingsSource = fs.readFileSync(path.join(root, 'ui/settings-tab.ts'), 'utf8');
  assert.match(settingsSource, /class AiUsageModal/);
  assert.match(settingsSource, /ui\.vam_runs_ai_tasks_through_your_signed_in_codex_account_and_u/);
  assert.match(settingsSource, /ui\.vam_runs_ai_tasks_through_your_claude_code_account_and_uses/);
  assert.match(source, /if \(!confirmed\) return false;/);
  assert.match(source, /this\.settings\.codexUsageNoticeSeen = true/);
  assert.match(source, /this\.settings\.claudeUsageNoticeSeen = true/);
  assert.match(source, /confirmAiUsage\(model/);
});
test('Obsidian 1.13 declarative settings expose workspace recovery and App Server diagnostics', () => {
  const source = fs.readFileSync(path.join(root, 'main.ts'), 'utf8');
  const settingsSource = fs.readFileSync(path.join(root, 'ui/settings-tab.ts'), 'utf8');
  const mapSource = fs.readFileSync(path.join(root, 'experiences/visual-map/view.ts'), 'utf8');
  const definitions = settingsSource.slice(settingsSource.indexOf('getSettingDefinitions()'), settingsSource.indexOf('async setControlValue'));
  assert.match(definitions, /ui\.workspace_location/);
  assert.match(definitions, /ui\.repair_agent_workspace/);
  assert.match(definitions, /ui\.ai_reasoning_level/);
  assert.match(definitions, /cliReasoning/);
  assert.match(definitions, /low: t\("ui\.low"\)/);
  assert.match(definitions, /medium: t\("ui\.medium"\)/);
  assert.match(definitions, /high: t\("ui\.high"\)/);
  assert.match(definitions, /ui\.refresh_vam_data/);
  assert.match(definitions, /ui\.full_rebuild/);
  assert.match(definitions, /ui\.reconnect_existing_workspace/);
  assert.match(definitions, /ui\.codex_app_server_status/);
  assert.match(definitions, /ui\.check_again/);
  assert.match(definitions, /ui\.installation_guide/);
  assert.match(source, /this\.settingTab\?\.refreshAfterLanguageChange\(\)/);
  assert.match(mapSource, /setAttr\("aria-label", t\("ui\.reasoning_level"\)\)/);
  assert.match(mapSource, /save\(\{ reasoning: normalizeReasoningLevel\(reasoning\.value\) \}\)/);
});
integrationTest('full rebuild refreshes derived data and open views', async () => {
  const { default: Plugin } = load('main.ts', { obsidian }); let rebuilds = 0, refreshes = 0;
  const plugin = new Plugin();
  plugin.repo = { rebuildDerivedData: async () => { rebuilds++; } };
  plugin.views = () => [{ refreshFromPlugin: async () => { refreshes++; } }];
  await plugin.fullRebuild();
  assert.equal(rebuilds, 1);
  assert.equal(refreshes, 1);
});
test('missing Codex opens an in-product setup guide with official installation and sign-in steps', () => {
  const source = fs.readFileSync(path.join(root, 'main.ts'), 'utf8');
  const settingsSource = fs.readFileSync(path.join(root, 'ui/settings-tab.ts'), 'utf8');
  assert.match(settingsSource, /class CodexSetupModal/);
  assert.match(settingsSource, /https:\/\/developers\.openai\.com\/codex\/cli\//);
  assert.match(settingsSource, /ui\.codex_setup_for_ai_only/);
  assert.match(settingsSource, /ui\.no_api_key_is_required_the_standalone_codex_cli_does_not_req/);
  assert.match(settingsSource, /ui\.run_codex_in_terminal_and_sign_in_with_your_chatgpt_account/);
  assert.match(source, /if \(showGuide\) this\.openCodexSetupGuide\(\)/);
  assert.match(source, /this\.recheckCodex\(false\)/);
});
integrationTest('generated child filenames are migrated to their topic titles and maps stay linked', async () => {
  const { repo, app } = fixture(), mapPath = await repo.createMap('Filename migration'), mapDoc = await repo.readMap(mapPath);
  const child = await repo.createNote('新的子議題', 'a', mapDoc, mapPath, 'workspace');
  await repo.updateNote(child.path, { title: '清楚的子議題名稱' }); mapDoc.nodes.push(child); await repo.saveMap(mapPath, mapDoc);
  const count = await repo.normalizeGeneratedNoteFilenames(), updated = await repo.readMap(mapPath);
  assert.equal(count, 1); assert.match(updated.nodes[0].path, /清楚的子議題名稱\.md$/); assert.ok(app.vault.getAbstractFileByPath(updated.nodes[0].path));
});
integrationTest('map topic sources retain every selected summary and working finding', async () => {
  const { repo, app } = fixture(), first = await topicNote(repo, 'Recipe A', 'a'), second = await topicNote(repo, 'Recipe B', 'a');
  await repo.updateNote(first.path, { summary: 'Use more onion', newFindings: '### 暫存結論\n\nOnion adds sweetness.' });
  await repo.updateNote(second.path, { summary: 'Toast the buns' });
  const { VisualAgentMapView } = load('main.ts', { obsidian }); const view = new VisualAgentMapView({ app }, { repo });
  const group = await view.topicReferenceGroup([first, second]);
  assert.deepEqual(group.documents.map(document => document.path), [first.path, second.path]);
  assert.match(group.documents[0].content, /Use more onion/);
  assert.match(group.documents[0].content, /Onion adds sweetness/);
  assert.match(group.documents[1].content, /Toast the buns/);
});
integrationTest('legacy integrated source links resolve from short Obsidian links', async () => {
  const { repo, app } = fixture(), source = await topicNote(repo, 'Recipe A', 'a'), root = await topicNote(repo, 'Integrated Burger', 'a');
  await repo.updateNote(root.path, { detail: '### 整合來源（保存內容）\n\n- [[Recipe A]]' });
  const { VisualAgentMapView } = load('main.ts', { obsidian }); const view = new VisualAgentMapView({ app }, { repo });
  assert.deepEqual(plain(view.referenceSourcePaths(await repo.readNote(root.path), root.path)), [source.path]);
});
integrationTest('creating an integrated topic runs AI with full sources and keeps clickable source paths', async () => {
  const { repo, app } = fixture(), first = await topicNote(repo, 'Recipe A', 'model-a'), second = await topicNote(repo, 'Recipe B', 'model-a');
  await repo.updateNote(first.path, { summary: 'Saved onion note', newFindings: 'Caramelize slowly.' });
  await repo.updateNote(second.path, { summary: 'Saved bun note' });
  first.x = 80; first.y = 80; second.x = 420; second.y = 220;
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md';
  const mapDoc = { id: 'map-a', title: 'map-a', version: 1, nodes: [first, second], viewport: { x: 0, y: 0, zoom: 1 } };
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const plugin = { repo, settings: { ...DEFAULT_SETTINGS }, rebuildDerivedData: async () => {}, askModel: async context => {
    assert.equal(context.mode, 'synthesize'); const allSources = context.referenceGroups.flatMap(group => group.documents).map(document => document.content).join('\n'); assert.match(allSources, /Saved onion note/); assert.match(allSources, /Caramelize slowly/); assert.match(allSources, /Saved bun note/);
    return { summary: 'Integrated answer', detail: 'Integrated detail', suggestions: [] };
  } };
  const view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.render = () => {};
  await view.createIntegratedNode('Personal Burger', [first, second], 'Find the best approach', 'Use tables');
  const savedMap = await repo.readMap(mapPath); assert.equal(savedMap.nodes.length, 3);
  const integrated = await repo.readNote(savedMap.nodes[2].path);
  assert.match(integrated.detail, /### Core conclusions/);
  assert.deepEqual(integrated.sourcePaths, [first.path, second.path]);
  assert.equal(integrated.rules, '');
  assert.equal(integrated.status, 'completed');
});
integrationTest('failed multi-select integration creates no empty root or note', async () => {
  const { repo, app } = fixture(), first = await topicNote(repo, 'Recipe A', 'model-a'), second = await topicNote(repo, 'Recipe B', 'model-a');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md';
  const mapDoc = { id: 'map-a', title: 'map-a', version: 1, nodes: [first, second], viewport: { x: 0, y: 0, zoom: 1 } };
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const plugin = { repo, settings: { ...DEFAULT_SETTINGS }, askModel: async () => { throw new Error('provider unavailable'); } };
  const view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.render = () => {};
  await assert.rejects(() => view.createIntegratedNode('Should not exist', [first, second], 'Combine', ''), /provider unavailable/);
  assert.equal((await repo.readMap(mapPath)).nodes.length, 2);
  assert.equal(app.vault.getAbstractFileByPath('Agent Workspace/Topics/map-a/Notes/Should not exist.md'), undefined);
});
integrationTest('saved integration is not offered for retry when derived-data refresh fails', async () => {
  const { repo, app } = fixture(), first = await topicNote(repo, 'Source A'), second = await topicNote(repo, 'Source B');
  const mapPath = 'Agent Workspace/Topics/map-a/Map.md';
  const mapDoc = { id: 'map-a', title: 'map-a', version: 1, nodes: [first, second], viewport: { x: 0, y: 0, zoom: 1 } };
  await app.vault.create(mapPath, core.serializeMap(mapDoc));
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const plugin = { repo, settings: { ...DEFAULT_SETTINGS }, rebuildDerivedData: async () => { throw new Error('refresh unavailable'); }, askModel: async () => ({ summary: 'Combined', detail: 'Combined knowledge', suggestions: [] }) };
  const view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = mapDoc; view.render = () => {}; view.focusNode = () => {};
  await view.createIntegratedNode('Combined', [first, second], 'Compare', '');
  assert.equal((await repo.readMap(mapPath)).nodes.length, 3);
  assert.equal(view.integrationTask, null);
});
integrationTest('topic notes hide properties without removing existing css classes', async () => {
  const { repo, contents } = fixture(); const n = await topicNote(repo, 'Styled', 'a');
  let content = contents.get(n.path); assert.match(content, /visual-agent-map-node/);
  content = content.replace('cssclasses: ["visual-agent-map-node"]', 'cssclasses: ["user-class"]'); contents.set(n.path, content);
  await repo.ensureNodePresentation(); content = contents.get(n.path); assert.match(content, /user-class/); assert.match(content, /visual-agent-map-node/);
});
integrationTest('deleted map restore refuses an occupied path without changing its contents', async () => {
  const { repo, app } = fixture(), path = await repo.createMap('Restoration conflict', []);
  const existing = await app.vault.read(repo.file(path));
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app }, { repo });
  view.deletedMap = { path, content: 'previous map contents', map: await repo.readMap(path), deleted: true };
  await assert.rejects(() => view.restoreDeletedMap());
  assert.equal(await app.vault.read(repo.file(path)), existing);
  assert.equal(view.deletedMap.deleted, true);
});
integrationTest('map structural undo restores deleted branch; redo removes it again', async () => {
  const { repo, app } = fixture(); const file = await repo.createMap('Undo', tree());
  const { VisualAgentMapView } = load('main.ts', { obsidian }); const view = new VisualAgentMapView({ app }, { repo, rebuildDerivedData: async () => {} });
  view.path = file; view.map = await repo.readMap(file); view.render = () => {}; view.hydrate = async () => {};
  await view.mapChange(m => { m.nodes = core.removeNodes(m.nodes, 'a', true); }); assert.equal((await repo.readMap(file)).nodes.length, 1);
  await view.travel(false); assert.equal((await repo.readMap(file)).nodes.length, 4);
  await view.travel(true); assert.equal((await repo.readMap(file)).nodes.length, 1);
});
integrationTest('layout-only map changes and AI note results do not rebuild derived data', async () => {
  const { repo, app } = fixture(), file = await repo.createMap('Layout', tree()); let rebuilds = 0;
  const { VisualAgentMapView } = load('main.ts', { obsidian }); const view = new VisualAgentMapView({ app }, { repo, rebuildDerivedData: async () => { rebuilds++; } });
  view.path = file; view.map = await repo.readMap(file); view.render = () => {}; view.hydrate = async () => {};
  await view.mapChange(map => { map.nodes[0].x = 120; map.viewport.zoom = 1.2; }); assert.equal(rebuilds, 0);
  await view.mapChange(map => { map.nodes[0].parentId = 'd'; }); assert.equal(rebuilds, 1);
});
integrationTest('full auto layout can be undone without changing parent links', async () => {
  const { repo, app } = fixture(), file = await repo.createMap('Arrange', tree());
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app }, { repo, rebuildDerivedData: async () => assert.fail('layout should not rebuild ownership') });
  view.path = file; view.map = await repo.readMap(file); view.render = () => {}; view.hydrate = async () => {};
  const before = plain(view.map.nodes);
  await view.mapChange(map => { map.nodes = layout.arrangeMap(map.nodes); }, false);
  const after = (await repo.readMap(file)).nodes;
  assert.notDeepEqual(plain(after), before);
  assert.deepEqual(Array.from(after, item => item.parentId), Array.from(before, item => item.parentId));
  await view.travel(false);
  assert.deepEqual(plain((await repo.readMap(file)).nodes), before);
});
integrationTest('Codex App Server uses model/list, selected reasoning and fresh ephemeral threads', async () => {
  const { EventEmitter } = require('node:events'); let command, args, turnCount = 0, threadCount = 0, unsubscribeCount = 0; const efforts = [];
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
  child.stdin = { write: line => {
    const message = JSON.parse(line.trim());
    const reply = result => process.nextTick(() => child.stdout.emit('data', Buffer.from(`${JSON.stringify({ id: message.id, result })}\n`)));
    if (message.method === 'initialize') reply({});
    else if (message.method === 'model/list') reply({ data: [
      { id: 'visible', model: 'visible-model', displayName: 'Visible', hidden: false, supportedReasoningEfforts: [{ reasoningEffort: 'low' }], defaultReasoningEffort: 'low', isDefault: true },
      { id: 'hidden', model: 'hidden-model', displayName: 'Hidden', hidden: true, supportedReasoningEfforts: [{ reasoningEffort: 'low' }], defaultReasoningEffort: 'low', isDefault: false },
      { id: 'internal', model: 'internal-model', displayName: '', hidden: false, supportedReasoningEfforts: [], defaultReasoningEffort: 'low', isDefault: false }
    ], nextCursor: null });
    else if (message.method === 'thread/start') { assert.equal(message.params.ephemeral, true); assert.equal(message.params.sandbox, 'read-only'); reply({ thread: { id: `thread-${++threadCount}` } }); }
    else if (message.method === 'thread/unsubscribe') { unsubscribeCount++; reply({}); }
    else if (message.method === 'turn/start') {
      turnCount++; efforts.push(message.params.effort); assert.ok(message.params.outputSchema.properties.summary); assert.match(message.params.input[0].text, /Current topic/);
      assert.deepEqual(plain(message.params.sandboxPolicy), { type: 'readOnly', networkAccess: false });
      const threadId = message.params.threadId, summary = threadId === 'thread-1' ? 'first' : 'second';
      process.nextTick(() => {
        child.stdout.emit('data', Buffer.from(`${JSON.stringify({ id: message.id, result: { turn: { id: `turn-${turnCount}` } } })}\n`));
        child.stdout.emit('data', Buffer.from(`${JSON.stringify({ method: 'item/completed', params: { threadId, turnId: `turn-${turnCount}`, item: { type: 'agentMessage', text: 'Progress commentary' } } })}\n`));
        child.stdout.emit('data', Buffer.from(`${JSON.stringify({ method: 'item/completed', params: { threadId, turnId: `turn-${turnCount}`, item: { type: 'agentMessage', text: JSON.stringify({ summary, detail: 'detail', suggestions: [], visualReferences: [] }) } } })}\n`));
        child.stdout.emit('data', Buffer.from(`${JSON.stringify({ method: 'turn/completed', params: { threadId, turn: { status: 'completed' } } })}\n`));
      });
    }
  } };
  const { default: Plugin } = load('main.ts', { obsidian, 'node:fs': { existsSync: () => false, readdirSync: () => [] }, 'node:child_process': { spawn: (path, invocation) => { command = path; args = invocation; return child; } } });
  const plugin = new Plugin(); plugin.app = { vault: { adapter: new obsidian.FileSystemAdapter() }, workspace: { getLeavesOfType: () => [] } }; plugin.manifest = { dir: '.obsidian/plugins/visual-agent-map' };
  plugin.saveData = async data => { plugin.saved = data; };
  plugin.codexDiagnostic = () => ({ executable: 'codex', installed: true });
  await plugin.refreshModelDiscovery('codex');
  plugin.settings.cliReasoning = 'low';
  const [result, second] = await Promise.all([
    plugin.askModel({ title: 'Current topic', summary: 'current summary', rules: 'Use official sources', task: 'task', ancestors: 'context', mode: 'task' }, 'visible-model', 'medium'),
    plugin.askModel({ title: 'Current topic', summary: 'current summary', rules: 'Use official sources', task: 'task', ancestors: 'context', mode: 'synthesize' }, 'visible-model', 'medium')
  ]);
  assert.equal(command, DEFAULT_SETTINGS.codexPath); assert.deepEqual(Array.from(args), ['app-server']);
  assert.equal(turnCount, 2); assert.equal(threadCount, 2);
  assert.equal(unsubscribeCount, 2);
  assert.deepEqual(efforts, ['medium', 'medium']);
  assert.equal(plugin.settings.models, 'visible-model');
  assert.equal(result.summary, 'first');
  assert.equal(second.summary, 'second');
});
integrationTest('Codex late turn acknowledgement after abort is never reported accepted', async () => {
  const { EventEmitter } = require('node:events'); const sent = []; let turnRequest;
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
  const emit = message => process.nextTick(() => child.stdout.emit('data', Buffer.from(`${JSON.stringify(message)}\n`)));
  child.stdin = { write: line => {
    const message = JSON.parse(line.trim()); sent.push(message);
    if (message.method === 'initialize') emit({ id: message.id, result: {} });
    else if (message.method === 'thread/start') emit({ id: message.id, result: { thread: { id: 'late-thread' } } });
    else if (message.method === 'turn/start') turnRequest = message.id;
    else if (message.method === 'thread/unsubscribe') emit({ id: message.id, result: {} });
  } };
  const { CodexAppServerRuntime } = load('ai/runtime/codex-app-server.ts', { 'node:child_process': { spawn: () => child } });
  const runtime = new CodexAppServerRuntime({ executable: 'codex', cwd: '/plugin', env: {}, clientVersion: 'test' });
  const controller = new AbortController(); let accepted = 0;
  try {
    const pending = runtime.runTask('research', 'model', 'low', {}, { signal: controller.signal, onAccepted: () => accepted++ });
    await until(() => !!turnRequest);
    assert.equal(accepted, 0);
    controller.abort();
    emit({ id: turnRequest, result: { turn: { id: 'late-turn' } } });
    await assert.rejects(pending, error => error.name === 'AbortError');
    assert.equal(accepted, 0);
  } finally { runtime.stop(); }
});
integrationTest('Codex App Server accepts a plain-text turn without changing structured VAM turns', async () => {
  const { EventEmitter } = require('node:events'); const sent = []; let steer;
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
  const emit = message => process.nextTick(() => child.stdout.emit('data', Buffer.from(`${JSON.stringify(message)}\n`)));
  child.stdin = { write: line => {
    const message = JSON.parse(line.trim()); sent.push(message);
    if (message.method === 'initialize') emit({ id: message.id, result: {} });
    else if (message.method === 'config/read') emit({ id: message.id, result: { config: { mcp_servers: { inherited: {} } } } });
    else if (message.method === 'thread/start') { assert.equal(message.params.config['features.shell_tool'], false); assert.equal(message.params.config['features.unified_exec'], false); assert.match(message.params.baseInstructions, /text-generation/); emit({ id: message.id, result: { thread: { id: 'plain-thread' } } }); }
    else if (message.method === 'turn/start') {
      assert.equal(Object.hasOwn(message.params, 'outputSchema'), false);
      emit({ id: message.id, result: { turn: { id: 'plain-turn' } } });
      emit({ method: 'item/agentMessage/delta', params: { threadId: 'plain-thread', itemId: 'agent-1', delta: '# Full' } });
      emit({ method: 'item/agentMessage/delta', params: { threadId: 'plain-thread', itemId: 'agent-1', delta: ' conversation' } });
    } else if (message.method === 'turn/steer') {
      assert.match(message.params.input[0].text, /include parent question/); emit({ id: message.id, result: {} });
      emit({ method: 'item/completed', params: { threadId: 'plain-thread', item: { id: 'agent-1', type: 'agentMessage', text: '# Full conversation' } } });
      emit({ method: 'turn/completed', params: { threadId: 'plain-thread', turn: { status: 'completed' } } });
    } else if (message.method === 'thread/unsubscribe') emit({ id: message.id, result: {} });
  } };
  const { CodexAppServerRuntime } = load('ai/runtime/codex-app-server.ts', { 'node:child_process': { spawn: () => child } });
  const runtime = new CodexAppServerRuntime({ executable: 'codex', cwd: '/plugin', env: {}, clientVersion: 'test' });
  try { const chunks = []; const running = runtime.runTask('coffee', 'model', 'high', undefined, { textOnly: true, onText: text => chunks.push(text), onSteer: handler => { steer = handler; } }); await until(() => !!steer); await steer('include parent question'); assert.equal(await running, '# Full conversation'); assert.deepEqual(chunks, ['# Full', '# Full conversation', '# Full conversation']); }
  finally { runtime.stop(); }
});
integrationTest('AI exchange logging captures the sent payload, raw reply and parse failure', async () => {
  const { default: Plugin } = load('main.ts', { obsidian });
  const { AiExchangeLog } = load('ai-exchange-log.ts');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vam-ai-capture-'));
  try {
    const plugin = new Plugin(); plugin.app = { vault: { adapter: new obsidian.FileSystemAdapter() } }; plugin.manifest = { dir: '.obsidian/plugins/visual-agent-map' };
    plugin.settings.aiExchangeLoggingEnabled = true;
    plugin.exchanges = new AiExchangeLog(path.join(directory, 'exchanges.json'), error => assert.fail(String(error)));
    let reply = '{"summary":"done","detail":"details","suggestions":[],"visualReferences":[]}';
    plugin.runtime = () => ({ runTask: async (prompt, model, effort, _schema, controls) => { controls.onRequest({ input: prompt, model, effort }); return reply; } });
    const context = { title: 'Private topic', summary: 'private summary', rules: '', detail: '', task: 'Analyze this', ancestors: '', mode: 'task', researchMode: 'local', researchDepth: 'fast', visualMode: 'off' };
    await plugin.askModel(context, 'test-model', 'low');
    reply = 'invalid raw answer';
    await assert.rejects(plugin.askModel(context, 'test-model', 'low'));
    await plugin.exchanges.flush();
    const entries = plugin.exchanges.getEntries();
    assert.equal(entries.length, 2);
    assert.match(entries[0].request, /private summary/); assert.match(entries[0].response, /"summary":"done"/); assert.equal(entries[0].status, 'parsed');
    assert.equal(entries[1].response, 'invalid raw answer'); assert.equal(entries[1].status, 'failed'); assert.match(entries[1].error, /解析 AI 回覆/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
test('AI task acceptance waits for the provider acknowledgement, not request logging', async () => {
  const { AiTaskService } = load('core/ai-task-service.ts');
  let controls, release, accepted = 0;
  const service = new AiTaskService({
    pluginDirectory: () => '/plugin', language: () => 'en', defaultReasoning: () => 'low',
    exchangeLoggingEnabled: () => false, exchanges: () => null,
    codexRuntime: () => ({ runTask: (_prompt, _model, _effort, _schema, runtimeControls) => {
      controls = runtimeControls; controls.onRequest({ method: 'turn/start' });
      return new Promise(resolve => { release = resolve; });
    } }), claudeRuntime: () => { throw new Error('unexpected provider'); }
  });
  const context = { title: 'Topic', summary: '', rules: '', detail: '', task: 'task', ancestors: '', mode: 'task', researchMode: 'local', researchDepth: 'fast', visualMode: 'off' };
  const pending = service.askModel(context, 'test-model', 'low', undefined, undefined, () => accepted++);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(accepted, 0);
  controls.onAccepted();
  assert.equal(accepted, 1);
  release('{"summary":"done","detail":"details","suggestions":[],"visualReferences":[]}');
  await pending;
});
integrationTest('MindSearch gap audit uses a strict rationale-first schema for both providers and rejects invalid results', async () => {
  const { AiTaskService } = load('core/ai-task-service.ts');
  const { buildMindSearchPrompt } = load('ai/mindsearch-prompt.ts');
  const auditContext = { title: 'Audit', summary: '', rules: '', detail: '', task: 'Classify the gap.', ancestors: '', mode: 'task', promptProfile: 'mindsearch', researchMode: 'local', researchDepth: 'fast', visualMode: 'off', responseContract: 'mindsearch-gap-audit' };
  const valid = JSON.stringify({ detail: 'The missing item is specific to this user.', summary: 'user_condition', suggestions: [], visualReferences: [] });
  const seen = [];
  for (const model of ['gpt-6-luna', 'claude:sonnet']) {
    let suppliedSchema;
    const service = new AiTaskService({
      pluginDirectory: () => '/plugin', language: () => 'en', defaultReasoning: () => 'low',
      exchangeLoggingEnabled: () => false, exchanges: () => null,
      codexRuntime: () => ({ runTask: async (_prompt, _model, _effort, schema) => { suppliedSchema = schema; return valid; } }),
      claudeRuntime: () => ({ runTask: async (_prompt, _model, _effort, schema) => { suppliedSchema = schema; return valid; } })
    });
    const result = await service.askModel(auditContext, model, 'low');
    seen.push(suppliedSchema);
    assert.equal(result.summary, 'user_condition');
    assert.equal(result.detail, 'The missing item is specific to this user.');
    assert.equal(result.suggestions.length, 0);
    assert.equal(result.visualReferences.length, 0);
  }
  assert.deepEqual(plain(seen[0]), plain(seen[1]), 'both provider paths receive the same dedicated schema');
  assert.deepEqual(Array.from(seen[0].required), ['detail', 'summary', 'suggestions', 'visualReferences']);
  assert.equal(seen[0].properties.summary.enum.join(','), 'user_condition,external_evidence');
  assert.equal(seen[0].properties.suggestions.maxItems, 0);
  assert.equal(seen[0].properties.visualReferences.maxItems, 0);
  const auditPrompt = buildMindSearchPrompt({ ...auditContext, task: '<!-- mindsearch-phase: research-gap-audit -->\nAudit the proposed gap.' }, 'en');
  assert.match(auditPrompt, /dedicated response schema/);
  assert.match(auditPrompt, /rationale first in detail, then set summary to exactly user_condition or external_evidence/);
  assert.doesNotMatch(auditPrompt, /machine-readable marker/);

  for (const response of [
    { detail: 'Rationale exists.', summary: 'external evidence', suggestions: [], visualReferences: [] },
    { detail: 'Rationale exists.', summary: 'external_evidence', suggestions: [{ title: 'Search' }], visualReferences: [] },
    { detail: '', summary: 'external_evidence', suggestions: [], visualReferences: [] },
    { detail: 'Rationale exists.', summary: 'external_evidence' },
    { detail: 'Rationale exists.', summary: 'external_evidence', suggestions: [{ title: 42 }], visualReferences: [] },
    { detail: 'Rationale exists.', summary: 'external_evidence', suggestions: [], visualReferences: [{ imageUrl: 42 }] }
  ]) {
    const service = new AiTaskService({
      pluginDirectory: () => '/plugin', language: () => 'en', defaultReasoning: () => 'low',
      exchangeLoggingEnabled: () => false, exchanges: () => null,
      codexRuntime: () => ({ runTask: async () => JSON.stringify(response) }),
      claudeRuntime: () => { throw new Error('unexpected provider'); }
    });
    await assert.rejects(service.askModel(auditContext, 'gpt-6-luna', 'low'), /invalid structured classification/);
  }

  let genericSchema;
  const genericService = new AiTaskService({
    pluginDirectory: () => '/plugin', language: () => 'en', defaultReasoning: () => 'low',
    exchangeLoggingEnabled: () => false, exchanges: () => null,
    codexRuntime: () => ({ runTask: async (_prompt, _model, _effort, schema) => { genericSchema = schema; return valid; } }),
    claudeRuntime: () => { throw new Error('unexpected provider'); }
  });
  await genericService.askModel({ ...auditContext, promptProfile: undefined, responseContract: undefined }, 'gpt-6-luna', 'low');
  assert.equal(genericSchema.properties.summary.enum, undefined, 'generic tasks retain the shared response schema');
});
integrationTest('turning exchange logging off during a task stops recording its reply', async () => {
  const { default: Plugin } = load('main.ts', { obsidian });
  const { AiExchangeLog } = load('ai-exchange-log.ts');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vam-ai-toggle-'));
  try {
    const plugin = new Plugin(); plugin.app = { vault: { adapter: new obsidian.FileSystemAdapter() } }; plugin.manifest = { dir: '.obsidian/plugins/visual-agent-map' };
    plugin.settings.aiExchangeLoggingEnabled = true;
    plugin.exchanges = new AiExchangeLog(path.join(directory, 'exchanges.json'), error => assert.fail(String(error)));
    let release;
    plugin.runtime = () => ({ runTask: async (_prompt, _model, _effort, _schema, controls) => {
      controls.onRequest({ input: 'sent prompt' });
      return new Promise(resolve => { release = resolve; });
    } });
    const context = { title: 'Topic', summary: '', rules: '', detail: '', task: 'task', ancestors: '', mode: 'task', researchMode: 'local', researchDepth: 'fast', visualMode: 'off' };
    const running = plugin.askModel(context, 'test-model', 'low');
    await new Promise(resolve => setTimeout(resolve, 0));
    plugin.settings.aiExchangeLoggingEnabled = false;
    release('{"summary":"done","detail":"private answer","suggestions":[],"visualReferences":[]}');
    await running; await plugin.exchanges.flush();
    const entry = plugin.exchanges.getEntries()[0];
    assert.match(entry.request, /sent prompt/);
    assert.equal(entry.response, '');
    assert.equal(entry.status, 'sent');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
integrationTest('local Codex runtime disables web search for its process', async () => {
  const { EventEmitter } = require('node:events'); let args;
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
  child.stdin = { write: line => { const message = JSON.parse(line.trim()); if (message.method === 'initialize') process.nextTick(() => child.stdout.emit('data', Buffer.from(`${JSON.stringify({ id: message.id, result: {} })}\n`))); } };
  const { CodexAppServerRuntime } = load('ai/runtime/codex-app-server.ts', { 'node:child_process': { spawn: (_path, invocation) => { args = invocation; return child; } } });
  const runtime = new CodexAppServerRuntime({ executable: 'codex', cwd: '/plugin', env: {}, clientVersion: 'test', webSearchDisabled: true });
  await runtime.start(); assert.deepEqual(plain(args), ['--config', 'web_search="disabled"', 'app-server']); runtime.stop();
});
integrationTest('AiTaskService forwards native Codex webSearch events unchanged to the caller', async () => {
  const { EventEmitter } = require('node:events');
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
  const emit = message => process.nextTick(() => child.stdout.emit('data', Buffer.from(`${JSON.stringify(message)}\n`)));
  const rawEvents = [
    { method: 'item/started', params: { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'webSearch', id: 'search-1', query: '', action: null, results: null } } },
    { method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'webSearch', id: 'search-1', query: 'site:fsis.usda.gov safe minimum internal temperature beef steaks rest time', action: { type: 'search', query: 'site:fsis.usda.gov safe minimum internal temperature beef steaks rest time', queries: null }, results: [{ type: 'text_result', domain: 'ask.fsis.usda.gov', ref_id: 'turn0search0', snippet: 'Snippet only; not a page body.', title: 'USDA temperature guidance', url: 'https://ask.fsis.usda.gov/example' }] } } },
    { method: 'item/started', params: { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'webSearch', id: 'read-1', query: '', action: null, results: null } } },
    { method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'webSearch', id: 'read-1', query: '', action: { type: 'other' }, results: [{ type: 'text_result', ref_id: 'turn1view0', snippet: 'Total lines: 1', title: 'Internal Error' }] } } }
  ];
  child.stdin = { write: line => {
    const message = JSON.parse(line.trim());
    if (message.method === 'initialize') emit({ id: message.id, result: {} });
    else if (message.method === 'thread/start') emit({ id: message.id, result: { thread: { id: 'thread-1' } } });
    else if (message.method === 'turn/start') {
      emit({ id: message.id, result: { turn: { id: 'turn-1' } } });
      rawEvents.forEach(emit);
      emit({ method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'agentMessage', id: 'answer-1', text: '{"summary":"Search only","detail":"The original page body was unavailable.","suggestions":[],"visualReferences":[]}' } } });
      emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { status: 'completed' } } });
    } else if (message.method === 'thread/unsubscribe') emit({ id: message.id, result: { status: 'unsubscribed' } });
  } };
  const { CodexAppServerRuntime } = load('ai/runtime/codex-app-server.ts', { 'node:child_process': { spawn: () => child } });
  const { AiTaskService } = load('core/ai-task-service.ts');
  const runtime = new CodexAppServerRuntime({ executable: 'codex', cwd: '/plugin', env: {}, clientVersion: 'test' });
  const service = new AiTaskService({
    pluginDirectory: () => '/plugin', language: () => 'en', defaultReasoning: () => 'low',
    exchangeLoggingEnabled: () => false, exchanges: () => null,
    codexRuntime: () => runtime, claudeRuntime: () => { throw new Error('unexpected provider'); }
  });
  const received = [];
  let capturedSearchBudget;
  const originalRunTask = runtime.runTask.bind(runtime);
  runtime.runTask = async (prompt, model, effort, schema, controls = {}) => { capturedSearchBudget = controls.searchBudget; return originalRunTask(prompt, model, effort, schema, controls); };
  const result = await service.askModel({ title: 'Public source probe', summary: '', rules: '', detail: '', task: 'Search then read the original page.', ancestors: '', mode: 'task', researchMode: 'research', researchDepth: 'fast', visualMode: 'off' }, 'gpt-6-luna', 'low', undefined, undefined, undefined, event => received.push(event));
  assert.equal(result.summary, 'Search only');
  assert.equal(capturedSearchBudget, 0, 'normal VAM research must not impose a fixed search-count cap');
  assert.deepEqual(plain(received), rawEvents);
  assert.equal(received[1].params.item.results[0].snippet, 'Snippet only; not a page body.');
  assert.equal(received[3].params.item.results[0].title, 'Internal Error');
  runtime.stop();
});
integrationTest('research budget sends one stop-search steer after three searches', async () => {
  const { EventEmitter } = require('node:events'); const sent = [];
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
  const emit = message => process.nextTick(() => child.stdout.emit('data', Buffer.from(`${JSON.stringify(message)}\n`)));
  child.stdin = { write: line => {
    const message = JSON.parse(line.trim()); sent.push(message);
    if (message.method === 'initialize') emit({ id: message.id, result: {} });
    else if (message.method === 'thread/start') emit({ id: message.id, result: { thread: { id: 'thread-1' } } });
    else if (message.method === 'turn/start') {
      emit({ id: message.id, result: { turn: { id: 'turn-1' } } });
      for (let i = 0; i < 3; i++) {
        emit({ method: 'item/started', params: { threadId: 'thread-1', item: { id: `search-${i}`, type: 'webSearch', action: null } } });
        emit({ method: 'item/completed', params: { threadId: 'thread-1', item: { id: `search-${i}`, type: 'webSearch', action: { type: 'search' } } } });
      }
    } else if (message.method === 'turn/steer') {
      emit({ id: message.id, result: { turnId: 'turn-1' } });
      emit({ method: 'item/completed', params: { threadId: 'thread-1', item: { type: 'agentMessage', text: 'answer' } } });
      emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { status: 'completed' } } });
    } else if (message.method === 'thread/unsubscribe') emit({ id: message.id, result: {} });
  } };
  const { CodexAppServerRuntime } = load('ai/runtime/codex-app-server.ts', { 'node:child_process': { spawn: () => child } });
  const runtime = new CodexAppServerRuntime({ executable: 'codex', cwd: '/plugin', env: {}, clientVersion: 'test' });
  try {
    assert.equal(await runtime.runTask('research', 'model', 'low', {}, { searchBudget: 3 }), 'answer');
    assert.equal(sent.filter(message => message.method === 'turn/steer').length, 1);
    assert.equal(sent.filter(message => message.method === 'turn/interrupt').length, 0);
    assert.match(sent.find(message => message.method === 'turn/steer').params.input[0].text, /停止搜尋/);
  } finally { runtime.stop(); }
});
integrationTest('opening a web page does not consume the search query budget', async () => {
  const { EventEmitter } = require('node:events'); const sent = [];
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
  const emit = message => process.nextTick(() => child.stdout.emit('data', Buffer.from(`${JSON.stringify(message)}\n`)));
  child.stdin = { write: line => {
    const message = JSON.parse(line.trim()); sent.push(message);
    if (message.method === 'initialize') emit({ id: message.id, result: {} });
    else if (message.method === 'thread/start') emit({ id: message.id, result: { thread: { id: 'thread-1' } } });
    else if (message.method === 'turn/start') {
      emit({ id: message.id, result: { turn: { id: 'turn-1' } } });
      emit({ method: 'item/started', params: { threadId: 'thread-1', item: { id: 'open-1', type: 'webSearch', action: null } } });
      emit({ method: 'item/completed', params: { threadId: 'thread-1', item: { id: 'open-1', type: 'webSearch', action: { type: 'openPage', url: 'https://example.org/source' } } } });
      emit({ method: 'item/completed', params: { threadId: 'thread-1', item: { type: 'agentMessage', text: 'answer' } } });
      emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { status: 'completed' } } });
    } else if (message.method === 'thread/unsubscribe') emit({ id: message.id, result: {} });
  } };
  const { CodexAppServerRuntime } = load('ai/runtime/codex-app-server.ts', { 'node:child_process': { spawn: () => child } });
  const runtime = new CodexAppServerRuntime({ executable: 'codex', cwd: '/plugin', env: {}, clientVersion: 'test' });
  try {
    assert.equal(await runtime.runTask('research', 'model', 'low', {}, { searchBudget: 1 }), 'answer');
    assert.equal(sent.filter(message => message.method === 'turn/steer').length, 0);
  } finally { runtime.stop(); }
});
integrationTest('cancelling a Codex turn sends interrupt and rejects the result', async () => {
  const { EventEmitter } = require('node:events'); const sent = [], timerDelays = [];
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
  const emit = message => process.nextTick(() => child.stdout.emit('data', Buffer.from(`${JSON.stringify(message)}\n`)));
  child.stdin = { write: line => {
    const message = JSON.parse(line.trim()); sent.push(message);
    if (message.method === 'initialize') emit({ id: message.id, result: {} });
    else if (message.method === 'thread/start') emit({ id: message.id, result: { thread: { id: 'thread-1' } } });
    else if (message.method === 'turn/start') emit({ id: message.id, result: { turn: { id: 'turn-1' } } });
    else if (message.method === 'turn/interrupt') { emit({ id: message.id, result: {} }); emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { status: 'interrupted' } } }); }
    else if (message.method === 'thread/unsubscribe') emit({ id: message.id, result: {} });
  } };
  const { CodexAppServerRuntime } = load('ai/runtime/codex-app-server.ts', { 'node:child_process': { spawn: () => child } }, { setTimeout: (callback, delay) => { timerDelays.push(delay); return setTimeout(callback, delay); } });
  const runtime = new CodexAppServerRuntime({ executable: 'codex', cwd: '/plugin', env: {}, clientVersion: 'test' });
  const controller = new AbortController();
  try {
    const pending = runtime.runTask('research', 'model', 'low', {}, { signal: controller.signal });
    while (!sent.some(message => message.method === 'turn/start')) await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve)); controller.abort();
    assert.equal(timerDelays.at(-1), 30_000);
    await assert.rejects(pending, error => error.name === 'AbortError');
    assert.equal(sent.filter(message => message.method === 'turn/interrupt').length, 1);
  } finally { runtime.stop(); }
});
for (const delayedStart of [false, true]) test(`timed-out Codex turn attempts one interrupt${delayedStart ? ' after a late turn/start reply' : ''}`, async () => {
  const { EventEmitter } = require('node:events'); const sent = [], logs = []; let turnTimeout, startRequest;
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
  const emit = message => process.nextTick(() => child.stdout.emit('data', Buffer.from(`${JSON.stringify(message)}\n`)));
  child.stdin = { write: line => {
    const message = JSON.parse(line.trim()); sent.push(message);
    if (message.method === 'initialize') emit({ id: message.id, result: {} });
    else if (message.method === 'thread/start') emit({ id: message.id, result: { thread: { id: 'thread-1' } } });
    else if (message.method === 'turn/start') { startRequest = message.id; if (!delayedStart) emit({ id: message.id, result: { turn: { id: 'turn-1' } } }); }
    else if (message.method === 'turn/interrupt') emit({ id: message.id, error: { message: 'interrupt unavailable' } });
    else if (message.method === 'thread/unsubscribe') emit({ id: message.id, result: {} });
  } };
  const windowValues = {
    setTimeout: (callback, delay) => delay === 180_000 ? (turnTimeout = callback, 1) : setTimeout(callback, delay),
    clearTimeout: timer => { if (timer !== 1) clearTimeout(timer); }
  };
  const { CodexAppServerRuntime } = load('ai/runtime/codex-app-server.ts', { 'node:child_process': { spawn: () => child } }, windowValues);
  const runtime = new CodexAppServerRuntime({ executable: 'codex', cwd: '/plugin', env: {}, clientVersion: 'test', onLog: (level, message) => logs.push([level, message]) });
  try {
    const pending = runtime.runTask('research', 'model', 'low', {});
    while (!startRequest || !turnTimeout) await new Promise(resolve => setImmediate(resolve));
    if (!delayedStart) await new Promise(resolve => setImmediate(resolve));
    turnTimeout();
    if (delayedStart) emit({ id: startRequest, result: { turn: { id: 'turn-1' } } });
    await assert.rejects(pending, /AI task exceeded 3 minutes.*interrupt it to avoid prolonged resource use.*Incomplete results are not applied/);
    assert.equal(sent.filter(message => message.method === 'turn/interrupt').length, 1);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(logs.filter(([level, message]) => level === 'warn' && message.includes('逾時後無法停止 AI 任務')).length, 1);
  } finally { runtime.stop(); }
});
integrationTest('Codex App Server declines unsupported interaction requests instead of hanging', async () => {
  const { EventEmitter } = require('node:events'); const sent = [];
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
  child.stdin = { write: line => {
    const message = JSON.parse(line.trim()); sent.push(message);
    if (message.method === 'initialize') process.nextTick(() => child.stdout.emit('data', Buffer.from(`${JSON.stringify({ id: message.id, result: {} })}\n`)));
  } };
  const { CodexAppServerRuntime } = load('ai/runtime/codex-app-server.ts', { 'node:child_process': { spawn: () => child } });
  const runtime = new CodexAppServerRuntime({ executable: 'codex', cwd: '/plugin', env: {}, clientVersion: 'test' });
  await runtime.start();
  const requests = [
    { id: 'command', method: 'item/commandExecution/requestApproval', expected: { decision: 'decline' } },
    { id: 'file', method: 'item/fileChange/requestApproval', expected: { decision: 'decline' } },
    { id: 'permission', method: 'item/permissions/requestApproval', expected: { permissions: {} } },
    { id: 'input', method: 'item/tool/requestUserInput', expected: { answers: {} } },
    { id: 'mcp', method: 'mcpServer/elicitation/request', expected: { action: 'decline', content: null } }
  ];
  for (const request of requests) child.stdout.emit('data', Buffer.from(`${JSON.stringify({ id: request.id, method: request.method, params: {} })}\n`));
  child.stdout.emit('data', Buffer.from(`${JSON.stringify({ id: 'unknown', method: 'unknown/request', params: {} })}\n`));
  await new Promise(resolve => setImmediate(resolve));
  for (const request of requests) assert.deepEqual(plain(sent.find(message => message.id === request.id)?.result), request.expected);
  assert.equal(sent.find(message => message.id === 'unknown')?.error?.code, -32601);
  runtime.stop();
});
integrationTest('Codex App Server ignores stale child events after a clean restart', async () => {
  const { EventEmitter } = require('node:events'); const children = [];
  const spawn = () => {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
    child.stdin = { write: line => {
      const message = JSON.parse(line.trim());
      if (message.method === 'initialize') process.nextTick(() => child.stdout.emit('data', Buffer.from(`${JSON.stringify({ id: message.id, result: {} })}\n`)));
      else if (message.method === 'model/list') process.nextTick(() => child.stdout.emit('data', Buffer.from(`${JSON.stringify({ id: message.id, result: { data: [], nextCursor: null } })}\n`)));
    } };
    children.push(child); return child;
  };
  const { CodexAppServerRuntime } = load('ai/runtime/codex-app-server.ts', { 'node:child_process': { spawn } });
  const runtime = new CodexAppServerRuntime({ executable: 'codex', cwd: '/plugin', env: {}, clientVersion: 'test' });
  await runtime.start();
  const first = children[0]; first.stdout.emit('data', Buffer.from('{')); first.emit('error', new Error('first failed'));
  await runtime.start();
  first.emit('close', 1);
  await runtime.listModels();
  assert.equal(children.length, 2);
  runtime.stop();
});
test('Claude CLI uses the local structured-output interface with tools restricted by task mode', async () => {
  const { EventEmitter } = require('node:events'); let args, prompt, cwd;
  const result = { type: 'result', subtype: 'success', is_error: false, structured_output: { summary: 'Summary', detail: 'Evidence', suggestions: [], visualReferences: [] } };
  const spawn = (_executable, received, options) => {
    args = received; cwd = options.cwd;
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => true;
    child.stdin = { end: text => { prompt = text; process.nextTick(() => { child.stdout.emit('data', Buffer.from(JSON.stringify(result))); child.emit('close', 0); }); } };
    return child;
  };
  const { ClaudeCodeCliRuntime, claudeTaskArgs, claudeStructuredOutput } = load('ai/runtime/claude-code-cli.ts', { 'node:child_process': { spawn } });
  const schema = { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false };
  const localArgs = claudeTaskArgs('sonnet', 'medium', schema, false);
  const claudeSchema = JSON.parse(localArgs[localArgs.indexOf('--json-schema') + 1]);
  assert.equal(claudeSchema.$schema, undefined);
  assert.deepEqual(claudeSchema.required, ['summary']);
  assert.equal(claudeSchema.additionalProperties, false);
  assert.equal(localArgs[localArgs.indexOf('--tools') + 1], '');
  assert.ok(localArgs.includes('--safe-mode'));
  assert.ok(localArgs.includes('--strict-mcp-config'));
  assert.deepEqual(JSON.parse(localArgs[localArgs.indexOf('--mcp-config') + 1]), { mcpServers: {} });
  assert.ok(localArgs.includes('--no-session-persistence'));
  const webArgs = claudeTaskArgs('opus', 'high', schema, true);
  assert.equal(webArgs[webArgs.indexOf('--tools') + 1], 'WebSearch,WebFetch');
  assert.doesNotMatch(webArgs.join(' '), /\b(Bash|Read|Write|Edit|Agent)\b/);
  const runtime = new ClaudeCodeCliRuntime({ executable: '/usr/local/bin/claude', cwd: '/plugin', env: {}, spawn });
  const raw = await runtime.runTask('VAM prompt', 'sonnet', 'medium', schema, { searchBudget: 0 });
  assert.equal(cwd, '/plugin'); assert.equal(prompt, 'VAM prompt');
  assert.equal(args[args.indexOf('--model') + 1], 'sonnet');
  assert.deepEqual(JSON.parse(raw), result.structured_output);
  assert.deepEqual(JSON.parse(claudeStructuredOutput(JSON.stringify([{ type: 'system', subtype: 'init' }, result]))), result.structured_output);
  assert.deepEqual(JSON.parse(claudeStructuredOutput(JSON.stringify(result))), result.structured_output);
  assert.throws(() => claudeStructuredOutput('not-json'));
  assert.throws(() => claudeStructuredOutput(JSON.stringify({ ...result, structured_output: undefined })), /structured result/);
  assert.throws(() => claudeStructuredOutput(JSON.stringify({ ...result, subtype: 'error_max_turns', is_error: true, errors: ['turn limit'] })), /turn limit/);
  const textResult = { type: 'result', subtype: 'success', is_error: false, result: '# Complete Markdown table' };
  assert.equal(claudeStructuredOutput(JSON.stringify(textResult), true), '# Complete Markdown table');
  assert.ok(!claudeTaskArgs('sonnet', 'high', undefined, false).includes('--json-schema'));
});
integrationTest('Claude stream-json keeps one request open for live guest interventions', async () => {
  const { EventEmitter } = require('node:events'); let args, handler, child; const input = [], chunks = [];
  const result = { type: 'result', subtype: 'success', is_error: false, result: 'Hello there' };
  const spawn = (_executable, received) => {
    args = received; child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => true;
    child.stdin = { write: line => { const message = JSON.parse(line); input.push(message); if (input.length === 1) process.nextTick(() => child.stdout.emit('data', Buffer.from(`${JSON.stringify({ type: 'stream_event', event: { delta: { type: 'text_delta', text: 'Hello' } } })}\n`))); else process.nextTick(() => { child.stdout.emit('data', Buffer.from(`${JSON.stringify({ type: 'stream_event', event: { delta: { type: 'text_delta', text: ' there' } } })}\n${JSON.stringify(result)}\n`)); }); return true; }, end: () => process.nextTick(() => child.emit('close', 0)) };
    return child;
  };
  const { ClaudeCodeCliRuntime } = load('ai/runtime/claude-code-cli.ts', { 'node:child_process': { spawn } });
  const runtime = new ClaudeCodeCliRuntime({ executable: 'claude', cwd: '/plugin', env: {}, spawn });
  const task = runtime.runTask('initial prompt', 'sonnet', 'low', undefined, { onText: text => chunks.push(text), onSteer: steer => { handler = steer; } });
  await until(() => !!handler); await handler('Ask Lin to explain the cost'); assert.equal(await task, 'Hello there');
  assert.ok(args.includes('--input-format') && args[args.indexOf('--input-format') + 1] === 'stream-json');
  assert.deepEqual(input.map(item => item.message.content[0].text), ['initial prompt', 'Ask Lin to explain the cost']);
  assert.deepEqual(chunks, ['Hello', 'Hello there']);
});

test('Claude cancellation rejects immediately and terminates only its own process', async () => {
  const { EventEmitter } = require('node:events'); const kills = [];
  const spawn = () => {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.kill = signal => { kills.push(signal); if (signal === 'SIGTERM') process.nextTick(() => child.emit('close', null, signal)); return true; };
    child.stdin = { end: () => {} }; return child;
  };
  const { ClaudeCodeCliRuntime } = load('ai/runtime/claude-code-cli.ts', { 'node:child_process': { spawn } });
  const runtime = new ClaudeCodeCliRuntime({ executable: 'claude', cwd: '/plugin', env: {}, spawn });
  const controller = new AbortController();
  const task = runtime.runTask('prompt', 'sonnet', 'low', {}, { signal: controller.signal });
  controller.abort();
  await assert.rejects(task, error => error.name === 'AbortError');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(kills, ['SIGTERM']);
});

test('Claude timeout stops its process and never accepts a late structured result', async () => {
  const { EventEmitter } = require('node:events'); let child; const kills = [];
  const spawn = () => {
    child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.kill = signal => { kills.push(signal); if (signal === 'SIGTERM') process.nextTick(() => child.emit('close', null, signal)); return true; };
    child.stdin = { end: () => {} }; return child;
  };
  const { ClaudeCodeCliRuntime } = load('ai/runtime/claude-code-cli.ts', { 'node:child_process': { spawn } });
  const runtime = new ClaudeCodeCliRuntime({ executable: 'claude', cwd: '/plugin', env: {}, spawn, timeoutMs: 15 });
  const task = runtime.runTask('prompt', 'sonnet', 'low', {});
  await assert.rejects(task, /exceeded 3 minutes/);
  child.stdout.emit('data', Buffer.from(JSON.stringify({ structured_output: { detail: 'late write' } })));
  child.emit('close', 0);
  assert.deepEqual(kills, ['SIGTERM']);
});

test('Claude launch failure before stdin flush never reports accepted', async () => {
  const { EventEmitter } = require('node:events'); let child, flush; let accepted = 0;
  const spawn = () => {
    child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => true;
    child.stdin = { end: (_prompt, callback) => { flush = callback; } }; return child;
  };
  const { ClaudeCodeCliRuntime } = load('ai/runtime/claude-code-cli.ts', { 'node:child_process': { spawn } });
  const runtime = new ClaudeCodeCliRuntime({ executable: 'claude', cwd: '/plugin', env: {}, spawn });
  const task = runtime.runTask('prompt', 'sonnet', 'low', {}, { onAccepted: () => accepted++ });
  child.emit('error', new Error('ENOENT'));
  flush(null);
  await assert.rejects(task);
  assert.equal(accepted, 0);
});

test('external map conflict UI retains file, screen, and manual merge choices', () => {
  const source = fs.readFileSync(path.join(root, 'experiences/visual-map/view.ts'), 'utf8');
  for (const modal of ['class MapConflictModal']) {
    const start = source.indexOf(modal), next = source.indexOf('\nclass ', start + modal.length);
    const body = source.slice(start, next < 0 ? source.length : next);
    assert.match(body, /ui\.use_file_contents/); assert.match(body, /ui\.keep_editor_contents/); assert.match(body, /ui\.save_merged_contents/);
  }
});

test('VAM notes hide properties in reading and live preview without removing frontmatter', () => {
  const styles = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  assert.match(styles, /\.markdown-preview-view\.visual-agent-map-node \.metadata-container/);
  assert.match(styles, /body \.workspace-leaf-content\.vam-topic-markdown \.markdown-source-view\.mod-cm6 \.metadata-container \{ display: none; \}/);
  assert.doesNotMatch(styles, /\.markdown-preview-view\.vam-topic-markdown \.metadata-container/);
  assert.doesNotMatch(styles, /!important/);
});

test('Coffee Tables room switches conversation and insights by pane width', () => {
  const styles = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  const responsive = styles.slice(styles.indexOf('@container (max-width: 899px)'));
  assert.match(responsive, /\.ct-room-columns\s*\{\s*flex-direction:\s*column/);
  assert.match(responsive, /\.ct-pane-tabs\s*\{[^}]*display:\s*flex/);
  assert.match(responsive, /\.ct-room-columns\[data-pane="chat"\].*\.ct-insight-panel/);
  assert.doesNotMatch(styles.match(/@media\s*\(max-width:\s*900px\)\s*\{([^}]*(?:\}[^}]*)?)\}/s)?.[1] ?? '', /\.ct-room-columns/);
});

integrationTest('legacy User Notes move to preview without losing either section or duplicating on save', async () => {
  const { repo, contents } = fixture(), n = await topicNote(repo, 'Legacy preview');
  await repo.updateNote(n.path, { preview: 'New preview' });
  contents.set(n.path, contents.get(n.path).replace('## Detail', '## User Notes\n\nLegacy text\n\n## Detail'));
  assert.equal((await repo.readNote(n.path)).preview, 'New preview\n\nLegacy text');
  await repo.updateNote(n.path, { summary: 'AI summary' });
  await repo.updateNote(n.path, { detail: 'AI detail' });
  assert.equal((await repo.readNote(n.path)).preview, 'New preview\n\nLegacy text');
  assert.doesNotMatch(contents.get(n.path), /## User Notes/);
  await repo.updateNote(n.path, { preview: '' });
  assert.equal((await repo.readNote(n.path)).preview, '');
});
test('preview cards display only editable preview content', () => {
  const source = fs.readFileSync(path.join(root, 'experiences/visual-map/view.ts'), 'utf8');
  const card = source.slice(source.indexOf('preview.createEl("strong", { text: note.title })'), source.indexOf('const host = workspace.getBoundingClientRect()'));
  assert.match(card, /note.preview/);
  assert.doesNotMatch(card, /note.summary|User Notes|目前結論/);
});

integrationTest('first AI answer seeds summary and image in preview, later answers preserve it including an explicit clear', async () => {
  const { repo } = fixture(), n = await topicNote(repo, 'Preview default');
  assert.equal((await repo.readNote(n.path)).preview, '尚未形成結論');
  await repo.updateNote(n.path, { summary: '簡短結論', detail: '文字\n\n![相關圖片](https://example.com/image.jpg)' });
  assert.equal((await repo.readNote(n.path)).preview, '簡短結論\n\n![相關圖片](https://example.com/image.jpg)');
  await repo.updateNote(n.path, { summary: '第二次結論', detail: '新正文' });
  assert.match((await repo.readNote(n.path)).preview, /簡短結論/);
  await repo.updateNote(n.path, { preview: '' });
  await repo.updateNote(n.path, { summary: '第三次結論' });
  assert.equal((await repo.readNote(n.path)).preview, '');
});
integrationTest('AI answer cannot replace preview edited while task was running', async () => {
  const { repo } = fixture(), n = await topicNote(repo, 'Manual preview');
  await repo.updateNote(n.path, { preview: '使用者的文字' });
  await repo.updateNote(n.path, { summary: 'AI 結論', detail: '![圖](https://example.com/image.jpg)' });
  assert.equal((await repo.readNote(n.path)).preview, '使用者的文字');
});
integrationTest('AI history refuses to undo over a later edit and retains the undo entry', async () => {
  const { repo, app } = fixture(), node = await topicNote(repo, 'Conflict guard');
  const before = await repo.readNote(node.path);
  await repo.updateNote(node.path, { summary: 'AI answer', detail: 'AI detail', status: 'completed' });
  const after = await repo.readNote(node.path);
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app }, { repo }); view.map = map([node]); view.render = () => {}; view.hydrate = async () => {};
  view.recordNoteWrite(node.path, before, after, ['summary', 'detail', 'status'], 'Research');
  await repo.updateNote(node.path, { detail: 'Manual follow-up' });
  await assert.rejects(() => view.travel(false));
  assert.equal((await repo.readNote(node.path)).detail, 'Manual follow-up');
  assert.equal(view.history.canUndo, true);
  await repo.updateNote(node.path, { detail: 'AI detail' });
  await view.travel(false);
  assert.equal((await repo.readNote(node.path)).summary, before.summary);
  assert.equal(view.history.canRedo, true);
});
integrationTest('images follow related text and inline images are not duplicated', async () => {
  const { repo } = fixture(), n = await topicNote(repo, 'Inline images');
  const reference = '**配色建議**\n![配色](https://example.com/color.jpg)\n來源：https://example.com/source';
  await repo.updateNote(n.path, { summary: '結論', detail: '### 核心結論\n\n摘要\n\n### 關鍵知識\n\n配色建議：採用低彩度。\n\n另一項建議。\n\n### 證據與來源\n\n來源', visualReferences: reference });
  let detail = (await repo.readNote(n.path)).detail;
  assert.ok(detail.indexOf('![配色]') > detail.indexOf('配色建議：'));
  assert.ok(detail.indexOf('![配色]') < detail.indexOf('另一項建議'));
  assert.doesNotMatch(detail, /### 視覺參考/);
  await repo.updateNote(n.path, { visualReferences: reference });
  detail = (await repo.readNote(n.path)).detail;
  assert.equal((detail.match(/color.jpg/g) || []).length, 1);
  assert.match((await repo.readNote(n.path)).preview, /color.jpg/);
});

integrationTest('references in synthesized notes remain clickable after rebuilding, updates and source renames', async () => {
  const { repo, contents } = fixture(); const path = await repo.createMap('References', []), mapDoc = await repo.readMap(path);
  const first = await repo.createNote('Source A', 'a', mapDoc, path, 'workspace'), second = await repo.createNote('Source B', 'a', mapDoc, path, 'workspace');
  const integrated = await repo.createNote('Integrated', 'a', mapDoc, path, 'workspace'); mapDoc.nodes.push(first, second, integrated); await repo.saveMap(path, mapDoc);
  await repo.updateNote(integrated.path, {sourcePaths: [first.path, second.path], detail: 'Knowledge'});
  await repo.rebuildDerivedData(); await repo.updateNote(integrated.path, {summary: 'Updated'}); await repo.rebuildDerivedData();
  const text = contents.get(integrated.path);
  assert.match(text, /## Reference Links/);
  assert.ok(text.includes('[[' + first.path.replace(/\.md$/, '') + ']]'));
  assert.ok(text.includes('[[' + second.path.replace(/\.md$/, '') + ']]'));
  assert.equal((text.match(/## Reference Links/g) || []).length, 1);
  assert.equal((await repo.readNote(integrated.path)).detail, 'Knowledge');
  const renamed = await repo.renameNote(first.path, 'Source renamed'); await repo.rebuildDerivedData();
  assert.ok(contents.get(integrated.path).includes('[[' + renamed.replace(/\.md$/, '') + ']]'));
  assert.deepEqual((await repo.readNote(integrated.path)).sourcePaths, [renamed, second.path]);
  const moved = await repo.moveUnique(renamed, repo.topicFolder(path, 'Unassigned'));
  await repo.rebuildDerivedData();
  assert.ok(contents.get(integrated.path).includes('[[' + moved.replace(/\.md$/, '') + ']]'));
});
test('preview renderer receives Markdown in original order with no extra Preview label', () => {
  const created = []; let rendered;
  const rect = {left:0,top:0,right:100,width:800,height:600};
  const element = () => ({style:{setProperty(){}},addEventListener(){},createEl(tag, options){created.push([tag,options.text]);return element()},createDiv(){return element()},getBoundingClientRect(){return rect},remove(){}});
  const workspace = element(); const contentEl = {querySelector(){return workspace}};
  const {VisualAgentMapView} = load('main.ts', {obsidian:{...obsidian,MarkdownRenderer:{render(app, markdown, el, path){rendered={markdown,path};return Promise.resolve()}}}});
  const view = new VisualAgentMapView({app:{}},{settings:{...DEFAULT_SETTINGS}}); view.contentEl=contentEl;view.map=map([node('a')]);
  const markdown='Text first\n\n![Image](https://example.com/a.png)\n\nText after\n\n|A|B|\n|---|---|\n|1|2|';
  view.showHoverCard({...element(),dataset:{nodeId:'a'}},{title:'Topic',preview:markdown});
  assert.equal(rendered.markdown,markdown);assert.equal(rendered.path,'a.md');assert.deepEqual(created,[['strong','Topic']]);
});
integrationTest('dragging synthesized roots persists coordinates and removal preserves notes with undo', async () => {
  const {repo,app} = fixture(), path = await repo.createMap('Root operations', []), mapDoc = await repo.readMap(path);
  const first = await repo.createNote('First','a',mapDoc,path,'workspace'), second=await repo.createNote('Second','a',mapDoc,path,'workspace'); mapDoc.nodes.push(first,second);await repo.saveMap(path,mapDoc);
  let pending=Promise.resolve();
  const plugin={repo,settings:{...DEFAULT_SETTINGS},rebuildDerivedData:()=>repo.rebuildDerivedData(),askModel:async()=>({summary:'Merged',detail:'Knowledge',visualReferences:[],suggestions:[]}),mutate(work){pending=pending.then(work);return pending}};
  const {VisualAgentMapView}=load('main.ts',{obsidian}); const view=new VisualAgentMapView({app},plugin);view.path=path;view.map=mapDoc;view.integrationMode=true;view.render=()=>{};view.focusNode=()=>{};view.drawEdges=()=>{};view.updateHistoryButtons=()=>{};
  await view.createIntegratedNode('Combined',[first,second],'Combine','');
  const root=view.map.nodes.find(n=>n.id!==first.id&&n.id!==second.id); assert.equal(root.parentId,null);assert.equal(view.integrationMode,false);
  const origin={x:root.x,y:root.y}; const events=new Map(),card={style:{},setPointerCapture(){},addEventListener(name,fn){events.set(name,fn)},removeEventListener(name){events.delete(name)}};
  view.enableDrag(card,root);events.get('pointerdown')({target:{closest(){return null}},button:0,clientX:10,clientY:10,pointerId:1});assert.equal(view.dragging,true);
  events.get('pointermove')({clientX:80,clientY:50});events.get('pointerup')({type:'pointerup'});await pending;
  const saved=(await repo.readMap(path)).nodes.find(n=>n.id===root.id); assert.equal(saved.x,origin.x+70);assert.equal(saved.y,origin.y+40);assert.equal(view.dragging,false);
  await view.removeToUnassigned(saved,false);assert.ok(!(await repo.readMap(path)).nodes.some(n=>n.id===root.id));assert.equal((await repo.collectionFiles(path,'Unassigned')).length,1);
  await view.travel(false);assert.ok((await repo.readMap(path)).nodes.some(n=>n.id===root.id));assert.ok(app.vault.getAbstractFileByPath(root.path));
});
test('UI language switch translates stable semantic keys and placeholders', () => {
  const {t,setUiLanguage,translate}=load('i18n.ts');setUiLanguage('en');assert.equal(t('ui.interface_language'),'Interface language');assert.equal(t('ui.expand_0',3),'Expand 3');assert.equal(translate('en','detail.core_conclusions'),'Core conclusions');assert.equal(translate('zh-TW','detail.core_conclusions'),'核心結論');assert.equal(translate('zh-TW','ui.expand_0'),'展開 {0}');assert.equal(translate('zh-TW','ui.interface_language'),'介面語言');
  assert.equal(translate('zh-TW','missing.runtime.key'), 'missing.runtime.key');
});
test('first install defaults to English regardless of Obsidian language while saved VAM choice wins', () => {
  const { initialUiLanguage } = load('i18n.ts');
  assert.equal(DEFAULT_SETTINGS.language, 'en');
  assert.equal(initialUiLanguage(undefined), 'en');
  assert.equal(initialUiLanguage(null), 'en');
  assert.equal(initialUiLanguage('invalid'), 'en');
  assert.equal(initialUiLanguage('en'), 'en');
  assert.equal(initialUiLanguage('zh-TW'), 'zh-TW');
});
test('language change saves before applying and refreshes all views without mutating notes', async () => {
  const { default: Plugin, VisualAgentMapSettingTab } = load('main.ts', { obsidian });
  const plugin = new Plugin();
  const calls = [];
  plugin.settings = { ...DEFAULT_SETTINGS, language: 'en' };
  const sharedSettings = plugin.settings;
  plugin.saveData = async settings => { calls.push(['save', settings.language, plugin.settings.language]); };
  plugin.repo = { settings: sharedSettings, syncManagedDetailHeadings: async () => { throw new Error('language switch must not rewrite Markdown'); } };
  plugin.views = () => [
    { refreshFromPlugin: async () => { calls.push(['view-a', plugin.settings.language]); throw new Error('test view error'); } },
    { refreshFromPlugin: async () => calls.push(['view-b', plugin.settings.language]) }
  ];
  plugin.coffeeViews = () => [{ refreshForLanguageChange: async () => calls.push(['coffee-a', plugin.settings.language]) }, { refreshForLanguageChange: async () => calls.push(['coffee-b', plugin.settings.language]) }];
  plugin.refreshLocalizedEntrypoints = () => calls.push(['commands', plugin.settings.language]);
  plugin.recordFailure = (...args) => calls.push(['diagnostic', ...args]);
  plugin.settingTab = { update() {}, refreshAfterLanguageChange: () => calls.push(['settings', plugin.settings.language, plugin.languageSwitchPending]) };
  const tab = new VisualAgentMapSettingTab({}, plugin);
  await tab.setControlValue('language', 'zh-TW');
  assert.equal(plugin.settings.language, 'zh-TW');
  assert.deepEqual(calls.filter(([kind]) => ['save', 'commands', 'view-a', 'view-b', 'coffee-a', 'coffee-b'].includes(kind)), [['save', 'zh-TW', 'en'], ['commands', 'zh-TW'], ['view-a', 'zh-TW'], ['view-b', 'zh-TW'], ['coffee-a', 'zh-TW'], ['coffee-b', 'zh-TW']]);
  assert.equal(plugin.settings, sharedSettings);
  assert.equal(plugin.repo.settings.language, 'zh-TW', 'repository keeps the shared settings object updated');
  assert.equal(calls.filter(([kind]) => kind === 'diagnostic').length, 1);
  assert.equal(plugin.languageSwitchPending, false);
  calls.length = 0;
  await tab.setControlValue('language', 'en');
  assert.equal(plugin.settings.language, 'en');
  assert.equal(calls.filter(([kind]) => kind === 'save').length, 1);
  assert.equal(calls.filter(([kind]) => kind === 'view-b').length, 1);
});
test('failed language save keeps the old selection and does not refresh views', async () => {
  const { default: Plugin } = load('main.ts', { obsidian });
  const plugin = new Plugin(), calls = [];
  plugin.settings = { ...DEFAULT_SETTINGS, language: 'en' };
  plugin.saveData = async () => { throw new Error('disk full'); };
  plugin.views = () => [{ refreshFromPlugin: async () => calls.push('view') }];
  plugin.refreshLocalizedEntrypoints = () => calls.push('commands');
  plugin.recordFailure = () => calls.push('logged');
  plugin.settingTab = { update() {}, refreshAfterLanguageChange: () => calls.push(['settings', plugin.languageSwitchPending]) };
  assert.equal(await plugin.changeLanguage('zh-TW'), false);
  assert.equal(plugin.settings.language, 'en');
  assert.deepEqual(calls, [['settings', true], 'logged', ['settings', false]]);
});
test('concurrent language changes are ignored until the first save and refresh completes', async () => {
  const { default: Plugin } = load('main.ts', { obsidian });
  let finishSave, writes = 0;
  const plugin = new Plugin(); plugin.settings = { ...DEFAULT_SETTINGS, language: 'en' };
  plugin.saveData = async () => { writes++; await new Promise(resolve => { finishSave = resolve; }); };
  plugin.views = () => [];
  plugin.refreshLocalizedEntrypoints = () => {};
  plugin.recordFailure = () => {};
  plugin.settingTab = { update() {}, refreshAfterLanguageChange() {} };
  const first = plugin.changeLanguage('zh-TW'); await Promise.resolve();
  assert.equal(plugin.languageSwitchPending, true);
  assert.equal(await plugin.changeLanguage('en'), false);
  assert.equal(writes, 1);
  finishSave();
  assert.equal(await first, true);
  assert.equal(plugin.settings.language, 'zh-TW');
  assert.equal(plugin.languageSwitchPending, false);
});
integrationTest('switching the interface language preserves exact existing Markdown bytes', async () => {
  const { app, contents, repo } = fixture('zh-TW');
  const note = await topicNote(repo, '保留原文');
  const before = contents.get(note.path);
  const { default: Plugin } = load('main.ts', { obsidian });
  const plugin = new Plugin(); plugin.settings = repo.settings;
  plugin.repo = repo; plugin.saveData = async () => {}; plugin.views = () => [];
  plugin.refreshLocalizedEntrypoints = () => {}; plugin.settingTab = { update() {}, refreshAfterLanguageChange() {} };
  await plugin.changeLanguage('en');
  await plugin.changeLanguage('zh-TW');
  assert.equal(contents.get(note.path), before);
  assert.equal(await app.vault.read(app.vault.getAbstractFileByPath(note.path)), before);
});
test('built-in Sample language refresh preserves selected topic and view state', async () => {
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const { builtInSample } = load('builtin-sample.ts');
  const plugin = { settings: { language: 'zh-TW' }, syncOutline() {} };
  const view = new VisualAgentMapView({ app: {} }, plugin);
  view.builtIn = true; view.map = builtInSample('en').map; view.notes = builtInSample('en').notes;
  view.map.viewport = { x: -128, y: 74, zoom: 0.83 };
  view.selected = view.map.nodes[0].id; view.render = () => {};
  const selected = view.selected, viewport = plain(view.map.viewport);
  await view.refreshFromPlugin();
  assert.match(view.map.title, /範例/);
  assert.equal(view.selected, selected);
  assert.deepEqual(plain(view.map.viewport), viewport);
});
test('AI entry prompts for Codex only when unavailable and leaves manual work available', async () => {
  const { default: Plugin } = load('main.ts', { obsidian });
  const plugin = new Plugin(); let guides = 0;
  plugin.settings = { ...DEFAULT_SETTINGS, models: '' };
  plugin.openCodexSetupGuide = () => { guides++; };
  plugin.codexDiagnostic = () => ({ installed: false });
  assert.equal(await plugin.codexReadyForAi(), false);
  assert.equal(guides, 1);
  plugin.codexDiagnostic = () => ({ installed: true });
  plugin.settings.cliModel = 'gpt-test';
  plugin.refreshModelDiscovery = async () => ({ provider: 'codex', status: 'ready', models: ['gpt-test'] });
  assert.equal(await plugin.codexReadyForAi(), true);
  plugin.settings.models = 'gpt-test';
  assert.equal(await plugin.codexReadyForAi(), true);
  assert.equal(guides, 1);
});
test('localized command and ribbon labels follow the selected VAM language', () => {
  const { default: Plugin } = load('main.ts', { obsidian });
  const plugin = new Plugin(), attributes = {}, command = { name: '' };
  plugin.ribbonIcon = { setAttribute: (key, value) => { attributes[key] = value; } };
  plugin.localizedCommands = [{ command, key: 'ui.open_map' }];
  plugin.settings = { ...DEFAULT_SETTINGS, language: 'en' }; plugin.refreshLocalizedEntrypoints();
  assert.equal(command.name, 'Visual Agent Map (VAM): Open mind map');
  assert.equal(attributes['aria-label'], 'Open mind map');
  plugin.settings.language = 'zh-TW'; plugin.refreshLocalizedEntrypoints();
  assert.equal(command.name, 'Visual Agent Map (VAM): 開啟心智圖');
});
test('map switch closes only the VAM note that remains in its right pane and clears Obsidian Outline', () => {
  class MarkdownView { constructor(path) { this.file = { path }; } }
  const { default: Plugin } = load('main.ts', { obsidian: { ...obsidian, MarkdownView } });
  const plugin = new Plugin(); let closed = 0, fileCleared = 0, synchronized = 0; plugin.app = { workspace: { getActiveViewOfType: () => ({ leaf: { id: 'map-view' } }), trigger: (event, leaf) => { if (event === 'file-open') { assert.equal(leaf, null); fileCleared++; } else { assert.equal(event, 'active-leaf-change'); assert.equal(leaf.id, 'map-view'); synchronized++; } } } };
  plugin.detailsPath = 'old-note.md';
  plugin.detailsLeaf = { view: new MarkdownView('other-user-note.md'), detach: () => { closed++; } };
  plugin.closeStaleDetails(); assert.equal(closed, 0); assert.equal(fileCleared, 0); assert.equal(synchronized, 0);
  plugin.detailsPath = 'old-note.md';
  plugin.detailsLeaf = { view: new MarkdownView('old-note.md'), detach: () => { closed++; } };
  plugin.closeStaleDetails(); assert.equal(closed, 1); assert.equal(fileCleared, 1); assert.equal(synchronized, 1);
});
test('topic status labels follow the selected UI language after startup', () => {
  const {topicStatusLabel}=load('i18n.ts');
  assert.equal(topicStatusLabel('idea', 'en'), 'To research');
  assert.equal(topicStatusLabel('idea', 'zh-TW'), '待研究');
  assert.equal(topicStatusLabel('error', 'en'), 'Task error');
});
test('all user-facing translations use stable semantic keys', () => {
  const dictionary = fs.readFileSync(path.join(root, 'i18n.ts'), 'utf8');
  const english = dictionary.slice(dictionary.indexOf('const english = {'), dictionary.indexOf('} as const;'));
  const chinese = dictionary.slice(dictionary.indexOf('const traditionalChinese:'), dictionary.lastIndexOf('};'));
  const extract = value => new Set([...value.matchAll(/^  "((?:[^"\\]|\\.)+)":/gm)].map(match => match[1]));
  const keys = extract(english);
  assert.deepEqual([...extract(chinese)].sort(), [...keys].sort(), 'every locale must define exactly the same semantic keys');
  const sourceFiles = ['main.ts', 'map-model.ts', 'ai/runtime/codex-app-server.ts', ...fs.readdirSync(path.join(root, 'ui')).filter(name => name.endsWith('.ts')).map(name => `ui/${name}`), ...fs.readdirSync(path.join(root, 'ui/modals')).filter(name => name.endsWith('.ts')).map(name => `ui/modals/${name}`)];
  const missing = [];
  for (const file of sourceFiles) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    for (const match of source.matchAll(/\bt\("((?:[^"\\]|\\.)*)"/g)) if (!/^[a-z][a-z0-9_.]*$/.test(match[1]) || !keys.has(match[1])) missing.push(`${file}: ${match[1]}`);
  }
  assert.deepEqual(missing, []);
  const dictionaryValues = source => new Map([...source.matchAll(/^  "((?:[^"\\]|\\.)+)": "((?:[^"\\]|\\.)*)",?$/gm)].map(match => [match[1], match[2]]));
  const englishValues = dictionaryValues(english), chineseValues = dictionaryValues(chinese);
  const placeholders = value => [...value.matchAll(/\{\d+\}/g)].map(match => match[0]).sort();
  for (const [key, value] of englishValues) assert.deepEqual(placeholders(chineseValues.get(key)), placeholders(value), `${key} placeholders must match between locales`);
});

test('reference batches include every selected Markdown source, deduplicate overlaps, split long files, and keep citations', () => {
  const api = load('ai/reference-materials.ts', { obsidian });
  const groups = [
    { id: 'map-a', name: 'Map A', location: 'Maps/A/Map.md', documents: [{ key: 'same', path: 'Maps/A/one.md', content: 'A'.repeat(35_000) }, { key: 'external', path: '/Volumes/Refs/source.md', external: true, content: 'external evidence' }] },
    { id: 'folder', name: 'Folder', location: '/Volumes/Refs', documents: [{ key: 'same', path: 'Maps/A/one.md', content: 'duplicate' }, ...Array.from({ length: 100 }, (_, index) => ({ key: `note-${index}`, path: `Folder/note-${index}.md`, content: `unique-sentinel-${index}` }))] }
  ];
  const batches = api.referenceBatches(groups, 10_000, 12_000);
  const joined = batches.join('\n');
  assert.ok(batches.length > 1); assert.match(joined, /\[S1\] Vault Markdown; cite as an Obsidian wikilink: Maps\/A\/one\.md/);
  assert.match(joined, /\[S2\] external Markdown; cite the exact path as plain text: \/Volumes\/Refs\/source\.md/);
  assert.match(joined, /unique-sentinel-0/); assert.match(joined, /unique-sentinel-99/);
  assert.equal(joined.match(/duplicate/g), null);
  assert.match(joined, /part 1\/4/); assert.match(joined, /part 4\/4/);
  assert.match(api.referenceCatalog(groups), /\[S2\] External file \(plain path\): \/Volumes\/Refs\/source\.md/);
  assert.equal(api.resolveReferenceLinks('See [[source.md]]', groups), 'See 外部來源：/Volumes/Refs/source.md');
  assert.equal(api.resolveReferenceLinks('Vault [S1], external [S2]', groups), 'Vault [[Maps/A/one.md]], external 外部來源：/Volumes/Refs/source.md');
  const namesake = [{ id: 'mixed', documents: [{ path: 'Vault/source.md', content: 'vault' }, { path: '/Volumes/Refs/source.md', external: true, content: 'external' }] }];
  assert.equal(api.resolveReferenceLinks('Vault [S1], external [S2]', namesake), 'Vault [[Vault/source.md]], external 外部來源：/Volumes/Refs/source.md');
  assert.equal(api.resolveReferenceLinks('Ambiguous [[source.md]]', namesake), 'Ambiguous 來源待確認：source.md');
  assert.equal(api.resolveReferenceLinks('Exact [[Vault/source.md]]', namesake), 'Exact [[Vault/source.md]]');
  assert.equal(api.resolveReferenceLinks('Unknown [S3]', namesake), 'Unknown 來源待確認：[S3]');
  assert.equal(api.resolveReferenceLinks('See [[same.md]]', [{ id: 'a', documents: [{ path: '/a/same.md', external: true, content: '' }, { path: '/b/same.md', external: true, content: '' }] }]), 'See 來源待確認：same.md');
});

test('reference picker keeps source groups compact, collapsible and task-local', async () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
  assert.match(css, /\.vam-reference-picker \.vam-reference-feedback \.is-hidden\s*\{\s*display:\s*none;\s*\}/);
  const element = (tag, options = {}) => ({ tag, cls: options.cls ?? '', text: options.text ?? '', children: [], dataset: {}, listeners: {},
    createDiv(value) { const child = element('div', { cls: typeof value === 'string' ? value : value?.cls }); this.children.push(child); return child; },
    createEl(name, value = {}) { const child = element(name, value); Object.assign(child, value); Object.assign(child, value.attr ?? {}); this.children.push(child); return child; },
    createSpan(value = {}) { const child = element('span', value); this.children.push(child); return child; },
    addEventListener(name, handler) { this.listeners[name] = handler; }, setText(value) { this.text = value; }, setAttr(name, value) { this[name] = value; },
    addClass(name) { this.cls = `${this.cls} ${name}`.trim(); }, removeClass(name) { this.cls = this.cls.split(' ').filter(item => item !== name).join(' '); }, empty() { this.children = []; }
  });
  const find = (root, predicate) => predicate(root) ? root : root.children.map(child => find(child, predicate)).find(Boolean);
  class Modal { constructor() { this.titleEl = element('h2'); this.contentEl = element('div'); } open() {} close() {} }
  const { ReferencePicker } = load('ui/reference-picker.ts', { obsidian: { ...obsidian, Modal, setIcon: (parent, name) => { const icon = element('svg'); icon.iconName = name; parent.children.push(icon); } } });
  const root = element('root');
  const picker = new ReferencePicker({ vault: { adapter: {} } }, root, async () => [], async () => [], 'current', 'Current topic and parent are included');
  const offline = new ReferencePicker({ vault: { adapter: {} } }, element('root'), async () => [], async () => [], 'current', 'Current topic and parent are included', false, true);
  assert.deepEqual(plain(offline.selection()), { webSearch: false, imageSearch: false });
  const area = root.children[0];
  assert.ok(find(area, child => child.cls.includes('vam-reference-cancel')).cls.includes('is-hidden'));
  assert.ok(find(area, child => child.cls.includes('vam-reference-error-acknowledge')).cls.includes('is-hidden'));
  assert.deepEqual(area.children.filter(child => child.cls.includes('vam-reference-section')).map(child => child.cls), [
    'vam-reference-section vam-reference-network-section', 'vam-reference-section vam-reference-local-section'
  ]);
  const web = find(area, child => child.tag === 'input' && child.type === 'checkbox');
  const image = find(area, child => child.tag === 'input' && child !== web && child.type === 'checkbox');
  assert.ok(find(area, child => child.tag === 'strong' && !!child.text));
  const actionRow = find(area, child => child.cls === 'vam-reference-actions');
  assert.equal(actionRow.children.filter(child => child.tag === 'button').length, 3);
  assert.deepEqual(actionRow.children.filter(child => child.tag === 'button').map(button => button.children[0].children[0].iconName), ['brain-circuit', 'folder-open', 'file-text']);
  web.checked = false; web.listeners.change(); assert.equal(image.disabled, true); assert.equal(image.checked, false);
  picker.groups = [{ id: 'map', name: 'Travel map', location: 'Maps/Travel/Map.md', documents: [{ path: 'Maps/Travel/Notes/Train.md', content: 'rail' }] }];
  picker.refresh();
  const details = find(area, child => child.tag === 'details');
  assert.equal(details.open, undefined);
  assert.equal(find(details, child => child.tag === 'ul'), undefined);
  const groupRow = find(area, child => child.cls === 'vam-reference-group-row');
  const remove = find(area, child => child.cls === 'vam-reference-remove');
  assert.equal(groupRow.children.includes(remove), true);
  assert.equal(find(find(details, child => child.tag === 'summary'), child => child.tag === 'button'), undefined);
  details.open = true; details.listeners.toggle();
  assert.equal(find(details, child => child.tag === 'li').text, 'Maps/Travel/Notes/Train.md');
  remove.listeners.click({ preventDefault() {} });
  assert.equal((await picker.ready()).groups.length, 0);
  assert.ok(find(area, child => child.cls.includes('vam-reference-cancel')).cls.includes('is-hidden'));
  const input = (path, content) => ({name: path.split('/').at(-1), webkitRelativePath: path, text: async () => content});
  const archived = input('Vault/Topic/Archive/old.md', '---\nagent-map-node: true\ntopic-state: archived\n---\nOld');
  const ordinary = input('Vault/Archive/ordinary.md', 'Ordinary archive');
  const active = input('Archive/Topics/Archive/Notes/active.md', '---\nagent-map-node: true\ntopic-state: active\n---\nCurrent');
  picker.addFolder([archived, ordinary, active]);
  let chosen = await picker.ready();
  assert.deepEqual(plain(chosen.groups.flatMap(group => group.documents).map(doc => doc.path)), [ordinary.webkitRelativePath, active.webkitRelativePath]);
  assert.ok(find(area, child => child.text.includes('Excluded 1')));
  picker.addFiles([archived]); chosen = await picker.ready();
  assert.equal(chosen.groups.flatMap(group => group.documents).length, 3);
  assert.ok(chosen.groups.flatMap(group => group.documents).some(doc => doc.content.endsWith('Old')));
});

integrationTest('Markdown reader accepts only Markdown and reads the full file without changing it', async () => {
  const api = load('ai/reference-materials.ts', { obsidian });
  const body = 'Full source sentinel\n'.repeat(30_000);
  const file = { extension: 'md', path: 'Maps/Source.md' };
  const result = await api.readMarkdownFile({ vault: { read: async selected => { assert.equal(selected, file); return body; } } }, file);
  assert.equal(result.path, file.path); assert.equal(result.content, body); assert.equal(result.external, undefined);
  await assert.rejects(api.readMarkdownFile({ vault: { read: async () => { throw new Error('should not read'); } } }, { extension: 'pdf', path: 'Source.pdf' }), /Only Markdown/);
});

integrationTest('legacy reference metadata is preserved but no longer copied when duplicating a map', async () => {
  const { repo } = fixture(); const note = await topicNote(repo, 'Reference owner', 'model');
  await repo.updateNote(note.path, { referencePaths: ['Evidence.pdf', 'Other.md'], detail: 'Keep all detail' });
  const preserved = await repo.readNote(note.path);
  assert.deepEqual(preserved.referencePaths, ['Evidence.pdf', 'Other.md']); assert.equal(preserved.detail, 'Keep all detail');
  const source = fs.readFileSync(path.join(root, 'main.ts'), 'utf8');
  assert.doesNotMatch(source, /referencePaths:\s*note\.referencePaths/);
});

integrationTest('persisted JSON validates all exchange fields and optional suggestion parent without rewriting input', async () => {
  const { AiExchangeLog } = load('ai-exchange-log.ts');
  const { PendingSuggestions } = load('pending-suggestions.ts');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vam-json-boundary-'));
  try {
    const file = path.join(directory, 'exchanges.json');
    const valid = { id: '1', startedAt: 'now', topic: 'Topic', mode: 'task', model: 'test', effort: 'low', request: 'prompt', response: 'answer', status: 'completed', error: '' };
    const invalid = Object.keys(valid).map(key => ({ ...valid, [key]: 12 }));
    const text = JSON.stringify([valid, ...invalid, { ...valid, status: 'unknown' }]); fs.writeFileSync(file, text);
    const errors = []; const log = new AiExchangeLog(file, error => errors.push(error)); await log.load();
    assert.equal(log.getEntries().length, 0); assert.equal(errors.length, 1);
    log.begin({ ...valid, id: 'new' }); await log.flush(); assert.equal(fs.readFileSync(file, 'utf8'), text);
    const proposals = path.join(directory, 'suggestions.json');
    fs.writeFileSync(proposals, JSON.stringify([['topic.md', [{ title: 'A', task: 'B', contribution: 'C' }, { title: 'A', task: 'B', contribution: 'C', parentTitle: 12 }]]]));
    const pending = new PendingSuggestions(proposals, error => errors.push(error)); await pending.load();
    assert.equal(pending.size, 0); const original = fs.readFileSync(proposals, 'utf8');
    pending.set('new.md', [{ title: 'New', task: '', contribution: '' }]); await assert.rejects(pending.flush());
    assert.equal(fs.readFileSync(proposals, 'utf8'), original);
    for (const Store of [AiExchangeLog, PendingSuggestions]) {
      const failures = []; const broken = new Store(file, error => failures.push(error));
      fs.writeFileSync(file, '{broken'); await broken.load(); assert.equal(failures.length, 1);
      fs.rmSync(file); const missing = new Store(file, error => failures.push(error)); await missing.load(); assert.equal(failures.length, 1);
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

integrationTest('Codex launch preserves executable as one argument and refuses privileged server requests', async () => {
  const { EventEmitter } = require('node:events'); const sent = []; let launch;
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
  child.stdin = { write: line => { const message = JSON.parse(line.trim()); sent.push(message); if (message.method === 'initialize') process.nextTick(() => child.stdout.emit('data', Buffer.from(`${JSON.stringify({ id: message.id, result: {} })}\n`))); } };
  const { CodexAppServerRuntime } = load('ai/runtime/codex-app-server.ts', { 'node:child_process': { spawn: (...args) => { launch = args; return child; } } });
  const executable = '/trusted path/codex;unexpected'; const env = { PATH: '/trusted/bin' };
  const runtime = new CodexAppServerRuntime({ executable, cwd: '/vault/custom-config/plugins/visual-agent-map', env, clientVersion: 'test' });
  try {
    await runtime.start(); assert.equal(launch[0], executable); assert.deepEqual(plain(launch[1]), ['app-server']);
    assert.equal(launch[2].cwd, '/vault/custom-config/plugins/visual-agent-map'); assert.equal(launch[2].env, env); assert.ok(!launch[2].shell);
    for (const [index, method] of ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'unknown/privilege'].entries()) {
      child.stdout.emit('data', Buffer.from(`${JSON.stringify({ id: 'server-' + index, method, params: {} })}\n`));
    }
    assert.deepEqual(sent.find(message => message.id === 'server-0').result, { decision: 'decline' });
    assert.deepEqual(sent.find(message => message.id === 'server-1').result, { decision: 'decline' });
    assert.deepEqual(sent.find(message => message.id === 'server-2').result, { permissions: {} });
    assert.equal(sent.find(message => message.id === 'server-3').error.code, -32601);
  } finally { runtime.stop(); }
});

// Coffee Tables uses one plain-text generation, then one request per follow-up.
const coffeeTypes = load('experiences/coffee-tables/types.ts');
const coffee = load('experiences/coffee-tables/engine.ts');
const coffeePrompts = load('experiences/coffee-tables/prompts.ts');
const coffeeInsights = load('experiences/coffee-tables/insights.ts');
const coffeeGuestInvitations = load('experiences/coffee-tables/guest-invitations.ts');
const coffeeCustomization = load('experiences/coffee-tables/customization.ts');
const coffeeConvergence = load('experiences/coffee-tables/convergence.ts');
test('Coffee insight migration retains distinct older notes and creates stable IDs', () => {
  const oldest = '# 觀察者整理\n\n## 核心分歧\n- 規則一致能增加可預期性，但無法消除起點差異。<!-- source: 規則要一樣 -->\n';
  const latest = '# 觀察者整理\n\n## 核心分歧\n- 規則一致能增加可預期性，但無法消除起點差異。\n- 申請門檻可能先排除最需要協助的人。\n';
  const baseline = coffeeInsights.baselineFromVersions([latest, oldest], 'zh-TW');
  assert.equal(baseline.length, 2);
  assert.equal(new Set(baseline.map(item => item.id)).size, 2);
  assert.equal(baseline[0].sources[0], '規則要一樣');
});
test('Coffee insight merge updates IDs, explicitly folds aliases, and keeps omitted insights', () => {
  const current = coffeeInsights.baselineFromVersions(['# 觀察者整理\n\n## 核心分歧\n- 舊觀點 A。\n- 舊觀點 B。\n'], 'zh-TW');
  const [a,b] = current;
  const update = `# 觀察者整理\n\n## 疑問與可能解方\n- 疑問的可能解方仍受資源限制。<!-- coffee-insight:merge:${a.id},${b.id} -->\n  疑問：需要支援但流程很長。\n  可能解方：提供簡化申請。\n  條件與限制：簡化流程仍需足夠人力。\n`;
  const merged = coffeeInsights.mergeInsightUpdates(current, update, 'zh-TW');
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, a.id);
  assert.deepEqual(plain(merged[0].mergedIds), [b.id]);
  assert.match(merged[0].proposedSolution, /簡化申請/);
  assert.match(merged[0].detail, /舊觀點 B/);
  const roundTrip = coffeeInsights.parseInsightNotes(coffeeInsights.serializeInsightNotes(merged, 'zh-TW'), 'zh-TW');
  assert.equal(roundTrip[0].id, a.id);
  assert.deepEqual(plain(roundTrip[0].mergedIds), [b.id]);
});
test('Coffee insight update preserves the explicit ID through summary changes and reopen', () => {
  const original = coffeeInsights.serializeInsightNotes(coffeeInsights.baselineFromVersions(['# 觀察者整理\n\n## 核心分歧\n- 規則一致可能掩蓋不同起點。\n'], 'zh-TW'), 'zh-TW');
  const before = coffeeInsights.parseInsightNotes(original, 'zh-TW')[0];
  const generated = `# 觀察者整理\n\n## 核心分歧\n- 統一規則提升可預期性，卻可能讓起點差異更難被看見。<!-- coffee-insight:update:${before.id} -->\n  - 脈絡：來賓補充資源配置條件會改變規則效果。\n`;
  const revised = coffeeInsights.mergeInsightUpdates([before], generated, 'zh-TW');
  assert.equal(revised[0].id, before.id);
  const reopened = coffeeInsights.baselineFromVersions([coffeeInsights.serializeInsightNotes(revised, 'zh-TW')], 'zh-TW');
  assert.equal(reopened[0].id, before.id);
  assert.match(reopened[0].summary, /統一規則提升可預期性/);
});
test('Coffee insight duplicate consolidation retains persisted merge aliases', () => {
  const versions = [
    '# 觀察者整理\n\n## 核心分歧\n- 同一核心觀點。<!-- coffee-insight:v1:id=primary;merged=older-alias -->\n',
    '# 觀察者整理\n\n## 核心分歧\n- 同一核心觀點。<!-- coffee-insight:v1:id=duplicate;merged=another-alias -->\n',
  ];
  const merged = coffeeInsights.baselineFromVersions(versions, 'zh-TW');
  assert.equal(merged.length, 1);
  assert.deepEqual(plain(merged[0].mergedIds), ['older-alias', 'duplicate', 'another-alias']);
  const reopened = coffeeInsights.parseInsightNotes(coffeeInsights.serializeInsightNotes(merged, 'zh-TW'), 'zh-TW');
  assert.deepEqual(plain(reopened[0].mergedIds), ['older-alias', 'duplicate', 'another-alias']);
});
test('Coffee insight update rejects unknown targets without modifying baseline', () => {
  const current = coffeeInsights.baselineFromVersions(['# 觀察者整理\n\n## 核心分歧\n- 保留舊內容。\n'], 'zh-TW');
  assert.throws(() => coffeeInsights.mergeInsightUpdates(current, '# 觀察者整理\n\n## 核心分歧\n- 新內容。<!-- coffee-insight:update:missing-id -->\n', 'zh-TW'), /unknown|不存在/i);
  assert.match(coffeeInsights.serializeInsightNotes(current, 'zh-TW'), /保留舊內容/);
});
test('Coffee invitation validation accepts a new guest and caps cumulative room size', () => {
  const types = load('experiences/coffee-tables/types.ts');
  const counts = { experts: 4, 'cross-domain': 1, generalist: 1, affected: 1 };
  const invites = (length, category = 'experts') => Array.from({ length }, (_, index) => ({ id: `new-${index}`, name: `新來賓${index}`, category, description: '帶來不同處境的觀點' }));
  assert.equal(coffeeGuestInvitations.validateGuestInvitations(invites(1), counts, []), null);
  assert.match(coffeeGuestInvitations.validateGuestInvitations(invites(6), counts, []), /12 位/);
  assert.match(coffeeGuestInvitations.validateGuestInvitations([{ ...invites(1)[0], name: '既有來賓' }], counts, [], undefined, ['既有來賓']), /已在這桌/);
  const completed = { id: 'asked-before', question: 'q', answer: 'a', status: 'complete', invitedGuests: invites(1, 'affected') };
  assert.equal(coffeeGuestInvitations.validateGuestInvitations(invites(4).map((guest, index) => ({ ...guest, id: `later-${index}`, name: `後續來賓${index}` })), counts, [completed]), null);
  assert.ok(types.parseSession(JSON.stringify({ ...types.createSession('題目', 'm', 'low', 'zh-TW'), status: 'completed', questions: [{ ...completed, createdAt: new Date().toISOString() }] })).questions[0].invitedGuests);
});
test('Coffee Tables every prompt mode carries cumulative update operations and the solutions category', () => {
  const session = coffeeTypes.createSession('整桌題目', 'm', 'low', 'zh-TW');
  session.status = 'completed';
  session.observerNotes = ['# 觀察者整理\n\n## 核心分歧\n- 最新整桌洞見。', '# 觀察者整理\n\n## 意外連結\n- 更早保存的跨域連結。'];
  const prompts = [coffeePrompts.tablePrompt(session.topic, session.language, session.guests), coffeePrompts.tablePrompt(session.topic, session.language, session.guests, '草稿'), coffeePrompts.questionPrompt(session, '新追問'), coffeePrompts.observerOnlyPrompt(session)];
  for (const prompt of prompts) {
    assert.match(prompt, /疑問與可能解方/);
    assert.match(prompt, /coffee-insight:(?:keep|update|merge):/);
    assert.match(prompt, /coffee-insight:new/);
    assert.match(prompt, /沒有重新輸出的舊項目會由程式保留|the program retains old items you do not rewrite/i);
  }
  const refresh = coffeePrompts.observerOnlyPrompt(session);
  assert.match(refresh, /更早保存的跨域連結/);
});
test('Coffee customization preserves saved text, validates reserved markers, and keeps editable style focused', () => {
  const defaults = coffeeCustomization.defaultCustomization('zh-TW');
  const saved = { ...defaults, observerPrompt: '不要刪除來源；這是一般整理偏好。' };
  assert.equal(coffeeCustomization.normalizeCustomization(saved, 'zh-TW').observerPrompt, saved.observerPrompt);
  assert.deepEqual(plain(coffeeCustomization.validateCustomization(saved, 'zh-TW')), []);
  assert.match(coffeeCustomization.validateCustomization({ ...saved, observerPrompt: 'x'.repeat(12001) }, 'zh-TW')[0], /12,000/);
  assert.match(coffeeCustomization.validateCustomization({ ...saved, observerPrompt: '保留 <!-- coffee-insight:keep:x -->' }, 'zh-TW')[0], /保留的內部標記/);
  const clean = coffeePrompts.cleanChatStyle(coffeePrompts.BUILTIN_COFFEE_STYLE_PROMPT);
  assert.match(clean, /自然、口語/); assert.doesNotMatch(clean, /觀察者整理|coffee-insight|stable program IDs/);
  const custom = { ...coffeeTypes.createSession('題目', 'm', 'low', 'zh-TW').guests, customization: saved };
  const preview = coffeePrompts.openingPromptPreview('題目', 'zh-TW', custom);
  assert.match(preview, /不要刪除來源/); assert.doesNotMatch(preview, /coffee-insight:(?:keep|update|merge):/);
});
test('Coffee convergence accounts for each baseline once and applies partial proposals with safe undo', async () => {
  const notes = '# 觀察者整理\n\n## 核心分歧\n- 洞見 A，保留來源脈絡。<!-- coffee-insight:v1:id=insight-a -->\n- 洞見 B，保留條件脈絡。<!-- coffee-insight:v1:id=insight-b -->\n\n## 值得繼續想的問題\n- 洞見 C，仍有一個待答問題。<!-- coffee-insight:v1:id=insight-c -->';
  const baseline = coffeeInsights.baselineFromVersions([notes], 'zh-TW');
  const proposals = [
    { sourceIds: ['insight-a', 'insight-b'], summary: '合併兩個洞見。', detail: '保留不同理由。', category: 'disagreements' },
    { sourceIds: ['insight-c'], summary: '保留問題。', detail: '問題仍未解。', category: 'questions' },
  ];
  const raw = JSON.stringify({ proposals });
  assert.equal(coffeeCustomization.parseConvergenceProposals(raw, baseline.map(item => item.id)).length, 2);
  assert.throws(() => coffeeCustomization.parseConvergenceProposals(JSON.stringify({ proposals: [proposals[0]] }), baseline.map(item => item.id)), /every baseline|每個|exactly once/i);
  const session = coffeeSession(); session.status = 'completed'; session.observerNotes = [notes];
  const fingerprint = coffeeConvergence.convergenceFingerprint(session);
  session.convergenceDraft = { baseFingerprint: fingerprint, proposals, raw, createdAt: session.createdAt, customization: coffeeCustomization.defaultCustomization(session.language) };
  const engine = new coffee.CoffeeEngine(session, async () => assert.fail('Convergence apply must not call a provider'), async () => {});
  await assert.rejects(engine.applyConvergence([0, 1], { 0: { summary: '## injected heading', detail: 'invalid' } }), /單行|標題|heading|metadata/i);
  await engine.applyConvergence([0]);
  const applied = coffeeInsights.baselineFromVersions(engine.session.observerNotes, 'zh-TW');
  assert.deepEqual(plain(applied.map(item => item.id).sort()), ['insight-a', 'insight-c']);
  assert.match(applied.find(item => item.id === 'insight-a').summary, /合併兩個洞見/); assert.deepEqual(plain(applied.find(item => item.id === 'insight-a').sources), []);
  await engine.undoConvergence(); assert.deepEqual(plain(engine.session.observerNotes), [notes]);
  const staleSession = coffeeSession(); staleSession.status = 'completed'; staleSession.observerNotes = [notes];
  staleSession.convergenceDraft = { baseFingerprint: coffeeConvergence.convergenceFingerprint(staleSession), proposals, raw, createdAt: staleSession.createdAt, customization: coffeeCustomization.defaultCustomization(staleSession.language) };
  const staleEngine = new coffee.CoffeeEngine(staleSession, async () => assert.fail('A stale preview must not call a provider'), async () => {});
  staleEngine.session.transcriptMarkdown = 'New dialogue invalidates a saved preview';
  await assert.rejects(staleEngine.applyConvergence([0]), /changed|refresh|已更新|重新整理/);
  assert.deepEqual(plain(staleEngine.session.observerNotes), [notes]); assert.ok(staleEngine.session.convergenceDraft);
});
test('Coffee convergence keeps pinned items isolated during proposals and protects sample sessions', async () => {
  const notes = '# 觀察者整理\n\n## 核心分歧\n- 釘選洞見 A。<!-- coffee-insight:v1:id=pinned-a -->\n- 洞見 B。<!-- coffee-insight:v1:id=insight-b -->';
  const baseline = coffeeInsights.baselineFromVersions([notes], 'zh-TW');
  assert.throws(() => coffeeConvergence.enforcePinnedProposals([{ sourceIds: ['pinned-a', 'insight-b'], summary: '合併', detail: '', category: 'disagreements' }], baseline, ['pinned-a']), /Pinned|釘選/);
  const session = coffeeSession(); session.id = 'sample-zh'; session.status = 'completed'; session.observerNotes = [notes]; session.pinnedInsightIds = ['pinned-a'];
  let calls = 0;
  const engine = new coffee.CoffeeEngine(session, async () => { calls++; return ''; }, async () => { calls++; });
  await assert.rejects(engine.togglePinnedInsight('pinned-a'), /read-only|只能閱讀/); await engine.previewConvergence(); await engine.continueTable();
  assert.deepEqual(plain(engine.session.pinnedInsightIds), ['pinned-a']);
  assert.equal(calls, 0);
});
test('Coffee observer refresh preserves every baseline insight in a generated merge that touches a pin', async () => {
  const notes = '# 觀察者整理\n\n## 核心分歧\n- 釘選洞見 A 有它自己的理由與條件。<!-- coffee-insight:v1:id=pinned-a -->\n- 洞見 B 有不同理由與適用情境。<!-- coffee-insight:v1:id=insight-b -->';
  const baseline = coffeeInsights.baselineFromVersions([notes], 'zh-TW');
  const generated = '# 觀察者整理\n\n## 意外連結\n\n- 這是一個具體的意外連結並且有完整脈絡。\n\n## 值得繼續想的問題\n\n- 這個問題仍需要進一步討論並確認更多情境。\n\n## 核心分歧\n\n- 合併後的新寫法，忽略 pinned note。<!-- coffee-insight:merge:pinned-a,insight-b -->\n\n## 探索方向\n\n- 下一步可以在不同服務情境中觀察成果。\n\n## 值得查證的假設\n\n- 仍要確認這個假設是否符合當事人的經驗。';
  const session = coffeeSession(); session.status = 'completed'; session.observerNotes = [notes]; session.pinnedInsightIds = ['pinned-a'];
  const engine = new coffee.CoffeeEngine(session, async () => generated, async () => {});
  await engine.refreshObserverNotes();
  const after = coffeeInsights.baselineFromVersions(engine.session.observerNotes, 'zh-TW');
  assert.deepEqual(plain(after.filter(item => ['pinned-a', 'insight-b'].includes(item.id)).map(item => [item.id, item.summary]).sort()), [['insight-b', '洞見 B 有不同理由與適用情境。'], ['pinned-a', '釘選洞見 A 有它自己的理由與條件。']]);
});
test('Coffee follow-up prompts name invited guests and retain them in later table continuations', () => {
  const session = coffeeTypes.createSession('整桌題目', 'm', 'low', 'zh-TW');
  const invite = { id: 'guest-invite-1', name: '林照', category: 'affected', description: '熟悉夜班與照護資源的社工' };
  const followUp = coffeePrompts.questionPrompt(session, '夜班怎麼找支援', '', [invite]);
  assert.match(followUp, /林照[｜|]受影響者：熟悉夜班與照護資源的社工/);
  session.questions.push({ id: 'q-1', createdAt: session.createdAt, question: '已完成的追問', answer: '林照談到夜班資源。', status: 'complete', invitedGuests: [invite] });
  assert.match(coffeePrompts.tablePrompt(session.topic, session.language, session.guests, '', coffeePrompts.assembleCoffeeContext(session)), /林照[｜|]受影響者：熟悉夜班與照護資源的社工/);
});
const coffeeSession = () => coffeeTypes.createSession('學生免費的營養午餐是否應該開放讓家長加價', 'test-model', 'high', 'zh-TW');
const coffeeTableList = load('experiences/coffee-tables/list.ts');
const coffeeTopics = load('experiences/coffee-tables/topics.ts');
integrationTest('Coffee Tables keeps an invited guest through failed retry and later continuation', async () => {
  const session = coffeeSession(); session.status = 'completed'; session.transcriptMarkdown = '### 周沐｜主持人\n\n先談如何求援。'; session.rounds = [{ id: 'prior-round', markdown: session.transcriptMarkdown, notes: '', status: 'completed', createdAt: session.createdAt }];
  const invitation = { id: 'invite-care-worker', name: '林照', category: 'affected', description: '熟悉夜班與照護資源的社工' }; let fail = true, prompts = [];
  const notes = '# 觀察者整理\n\n' + ['意外連結','值得繼續想的問題','核心分歧','探索方向','值得查證的假設'].map((title,index)=>`## ${title}\n- 具體洞見 ${index + 1}，脈絡完整且仍待對談推進。`).join('\n\n');
  const engine = new coffee.CoffeeEngine(session, async request => { prompts.push(request.prompt); if (fail) throw new Error('retry this invite'); if (prompts.length === 2) return `### 林照｜受影響者\n\n夜班同仁要有可直接使用的求援窗口。\n\n${notes}`; return `### 周沐｜主持人\n\n${prompts.length === 3 ? '林照提出的窗口需要接上正式交接流程。' : '正式交接流程應列明跨班支援窗口。'}\n\n${notes}`; }, async () => {});
  await engine.ask('夜班如何找到即時支援？', 'followup-care', [invitation]); assert.equal(engine.session.questions[0].status, 'error'); assert.equal(JSON.stringify(engine.session.questions[0].invitedGuests), JSON.stringify([invitation]));
  fail = false; await engine.ask('夜班如何找到即時支援？', 'followup-care'); assert.equal(engine.session.questions.length, 1); assert.match(prompts[1], /林照[｜|].*熟悉夜班與照護資源的社工/); assert.equal(engine.session.questions[0].status, 'complete');
  await engine.continueTable(); assert.match(prompts[2], /林照[｜|].*熟悉夜班與照護資源的社工/); assert.match(prompts[2], /求援窗口/); await engine.continueTable(); assert.match(prompts[3], /正式交接流程/); assert.equal(engine.session.observerNotes.length, 1);
});
test('Coffee Tables inspiration topics are bilingual, deterministic in tests and avoid immediate repeats', () => {
  assert.equal(coffeeTopics.COFFEE_TOPICS.length, 20);
  assert.ok(coffeeTopics.COFFEE_TOPICS.every(item => item.zh.length > 8 && item.en.length > 8));
  assert.equal(new Set(coffeeTopics.COFFEE_TOPICS.map(item => item.id)).size, 20);
  assert.equal(coffeeTopics.coffeeTopicText('school-lunch', 'en'), coffeeTopics.COFFEE_TOPICS[6].en);
  assert.equal(coffeeTopics.coffeeTopicText('school-lunch', 'zh-TW'), coffeeTopics.COFFEE_TOPICS[6].zh);
  assert.equal(coffeeTopics.pickCoffeeTopic('zh-TW', '', () => 0), coffeeTopics.COFFEE_TOPICS[0].zh);
  assert.equal(coffeeTopics.pickCoffeeTopic('zh-TW', coffeeTopics.COFFEE_TOPICS[0].zh, () => 0), coffeeTopics.COFFEE_TOPICS[1].zh);
  assert.equal(coffeeTopics.pickCoffeeTopic('en', '', () => 0), coffeeTopics.COFFEE_TOPICS[0].en);
});
test('Coffee Tables roster shows configured role placeholders and replaces introduced guests as text arrives', () => {
  const { rosterFor, liveRosterFor } = load('experiences/coffee-tables/view.ts', { obsidian }); const session = coffeeSession();
  const roster = rosterFor(session, '- **林岑｜主持人**：擅長追問。\n- **許雯｜主題專家**：研究勞動。');
  assert.equal(roster.length, 10); assert.deepEqual(Array.from(roster.slice(0, 2), person => person.name), ['林岑', '許雯']);
  assert.equal(roster.filter(person => person.role === '即將登場').length, 8);
  session.rounds = [{ id: 'round-1', markdown: '- **林岑｜主持人**：擅長追問。\n- **許雯｜主題專家**：研究勞動。', notes: '', status: 'completed', createdAt: '2026-01-01T00:00:00.000Z' }];
  const whileContinuing = liveRosterFor(session, '- **柏翰｜主題專家**：研究組織行為。\n\n### 柏翰｜主題專家\n接續發言。');
  assert.deepEqual(Array.from(whileContinuing.slice(0, 2), person => person.name), ['林岑', '許雯']);
  assert.equal(whileContinuing.find(person => person.name === '柏翰')?.role, '主題專家');
  assert.equal(whileContinuing.length, 10);
});
test('Coffee Tables recent-first list filters states, searches exact topics and sorts by meaningful activity', () => {
  const now = Date.parse('2026-09-30T00:00:00.000Z'), item = (id, topic, status, updatedAt, extra = {}) => ({ id, path: `${id}.md`, topic, status, createdAt: '2026-09-01T00:00:00.000Z', updatedAt, model: 'm', ...extra });
  const entries = [item('older','Shared','completed','2026-09-29T23:00:00.000Z',{lastCompletedAt:'2026-09-02T00:00:00.000Z'}), item('running','Shared','generating','2026-09-20T00:00:00.000Z',{lastGenerationStartedAt:'2026-09-29T23:30:00.000Z'}), item('draft','unfinished','error','2026-09-28T00:00:00.000Z'), item('recent','recent','completed','2026-09-10T00:00:00.000Z',{lastCompletedAt:'2026-09-29T23:45:00.000Z'}), item('past','past','completed','2026-09-29T00:00:00.000Z',{lastCompletedAt:'2026-09-22T00:00:00.000Z'})];
  assert.deepEqual(coffeeTableList.selectTables(entries).map(row => row.id), ['recent','running','draft','past','older']);
  assert.deepEqual(coffeeTableList.selectTables(entries, 'SHARED').map(row => row.id), ['running','older']);
  assert.deepEqual(coffeeTableList.selectTables(entries, '', 'unfinished').map(row => row.id), ['draft']);
  assert.deepEqual(coffeeTableList.selectTables(entries, '', 'completed', ' Shared ').map(row => row.id), ['older']);
  assert.equal(coffeeTableList.topicTableCount('Shared', entries), 2); assert.equal(coffeeTableList.topicTableCount('shared', entries), 0);
  assert.equal(coffeeTableList.tableTime(entries[2]).isFallback, true); assert.equal(coffeeTableList.tableTime(entries[1]).value, Date.parse('2026-09-29T23:30:00.000Z'));
  assert.equal(coffeeTableList.effectiveTableStatus({ status: 'completed', questions: [{ status: 'pending' }], rounds: [] }, true), 'generating'); assert.equal(coffeeTableList.effectiveTableStatus({ status: 'completed', questions: [{ status: 'error' }], rounds: [] }), 'error'); assert.equal(coffeeTableList.effectiveTableStatus({ status: 'generating', questions: [], rounds: [] }), 'error'); assert.deepEqual(coffeeTableList.selectTables([], '').map(row => row.id), []);
});
test('Coffee Tables list timestamps stay compact while retaining clear day and year context', () => {
  const now = new Date(2026, 8, 30, 16, 0).getTime();
  assert.match(coffeeTableList.formatTableTime(new Date(2026, 8, 30, 14, 30).getTime(), now, 'zh-TW'), /^今天/);
  assert.match(coffeeTableList.formatTableTime(new Date(2026, 8, 29, 14, 30).getTime(), now, 'en'), /^Yesterday/);
  assert.doesNotMatch(coffeeTableList.formatTableTime(new Date(2026, 8, 20, 14, 30).getTime(), now, 'zh-TW'), /2026/);
  assert.match(coffeeTableList.formatTableTime(new Date(2025, 8, 20, 14, 30).getTime(), now, 'en'), /2025/);
});
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const until = async predicate => { for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(r => setImmediate(r)); } throw new Error('condition not reached'); };
test('Coffee Tables prompt keeps the owner’s role topology and conversational intent in one plain-text request', () => {
  const prompt = coffeePrompts.tablePrompt('Topic', 'zh-TW');
  assert.match(prompt, /使用者原始主題[\s\S]*\nTopic\n/); assert.match(prompt, /主持人 2 位/); assert.match(prompt, /兩位主持人分工為一位留意矛盾、一位好奇追問/); assert.match(prompt, /觀察者/); assert.match(prompt, /source: 對談中的原句/); assert.equal((prompt.match(/- 主題專家/g) ?? []).length, 4);
  assert.match(prompt, /每個可定位到具體發言的洞見，都要/); assert.match(prompt, /沒有單一來源/);
  assert.match(prompt, /跨領域專家/); assert.match(prompt, /generalist/); assert.match(prompt, /虛構模擬/); assert.match(prompt, /完整保留，不另取聊天室標題/);
  assert.match(prompt, /10–18 次簡短發言/); assert.match(prompt, /# 觀察者整理/); assert.match(prompt, /## 意外連結[\s\S]*## 值得繼續想的問題[\s\S]*## 核心分歧[\s\S]*## 探索方向[\s\S]*## 值得查證的假設/); assert.match(prompt, /每次續聊新增約 8–12 次簡短發言/); assert.match(prompt, /未解問題/); assert.match(prompt, /coffee-tables-complete/);
  const resumed = coffeePrompts.tablePrompt('Topic', 'zh-TW', undefined, '### 林岑｜主持人\n先前中斷的話');
  assert.match(resumed, /不加前言、流程說明或重複人物介紹/); assert.match(resumed, /從前一句自然接續/);
  const resumedEnglish = coffeePrompts.tablePrompt('Topic', 'en', undefined, '### Host\nAn interrupted thought');
  assert.match(resumedEnglish, /without a preamble, process notes/); assert.match(resumedEnglish, /resume naturally from the last sentence/);
  const tailored = coffeePrompts.tablePrompt('原始主題：保留標點？', 'en', { counts: { experts: 0, 'cross-domain': 0, generalist: 0, affected: 1 }, guests: [{ id: 'g1', category: 'affected', description: 'frontline support' }], background: '', customPrompt: 'Use small company examples.' });
  assert.match(tailored, /原始主題：保留標點？/); assert.match(tailored, /frontline support/); assert.match(tailored, /Use small company examples/); assert.doesNotMatch(tailored, /4 位與主題相關/); assert.doesNotMatch(tailored, /本桌沒有跨領域來賓/);
  assert.match(tailored, /For an opening, aim for 10–18 concise turns/); assert.match(tailored, /# Observer’s notes/); assert.match(tailored, /## Unexpected connections[\s\S]*## Questions worth pursuing[\s\S]*## Core disagreements[\s\S]*## Directions to explore[\s\S]*## Assumptions to verify/); assert.match(tailored, /questions worth pursuing/i); assert.match(tailored, /coffee-tables-complete/);
  assert.match(tailored, /For every insight that can be located in specific dialogue, append one or more/);
  assert.doesNotMatch(prompt, /JSON|nextSpeakerId|輪數|字數限制/);
  const session = coffeeSession(); session.transcriptMarkdown = '主持人：我們剛才談到免費午餐。';
  assert.match(coffeePrompts.questionPrompt(session, '那家長付費會不會讓孩子被分級？'), /我們剛才談到免費午餐/);
  assert.match(coffeePrompts.questionPrompt(session, '那家長付費會不會讓孩子被分級？'), /家長付費/);
  assert.match(coffeePrompts.questionPrompt(session, '追問'), /## 意外連結[\s\S]*## 值得繼續想的問題[\s\S]*## 核心分歧[\s\S]*## 探索方向[\s\S]*## 值得查證的假設/); assert.match(coffeePrompts.questionPrompt(session, '追問'), /coffee-tables-complete/);
  const snapshot = { ...session, guests: { ...session.guests, styleId: 'style-1', styleName: '輕鬆聊天', stylePrompt: '先多問問題，再整理分歧。', referenceFiles: [{ name: '背景.md', content: '# 標題\n```md\n<!-- coffee-tables-complete -->\n```' }] } };
  assert.match(coffeePrompts.tablePrompt('Topic', 'zh-TW', snapshot.guests), /先多問問題，再整理分歧/); assert.match(coffeePrompts.tablePrompt('Topic', 'zh-TW', snapshot.guests), /背景.md[\s\S]*<!-- coffee-tables-complete -->/);
  assert.match(coffeePrompts.questionPrompt(snapshot, '追問'), /先多問問題，再整理分歧/); assert.match(coffeePrompts.questionPrompt(snapshot, '追問'), /背景.md/);
  assert.match(coffeePrompts.observerOnlyPrompt(snapshot), /先多問問題，再整理分歧/); assert.match(coffeePrompts.observerOnlyPrompt(snapshot), /背景.md/); assert.match(coffeePrompts.observerOnlyPrompt(snapshot), /source: 對談中的原句/);
  assert.throws(() => coffeePrompts.questionPrompt(snapshot, 'x'.repeat(180000)), /太長|too long/);
});
test('Coffee Tables custom style replaces editable built-in behavior guidance in every generation mode', () => {
  const session = coffeeSession();
  session.guests.stylePrompt = '自由深入討論，不限制發言輪數；遇到草稿從全新角度重新展開；觀察者只整理三個最重要的發現。';
  session.observerNotes = ['舊觀察整理'];
  const opening = coffeePrompts.tablePrompt('Topic', 'zh-TW', session.guests);
  const continuation = coffeePrompts.tablePrompt('Topic', 'zh-TW', session.guests, '### 主持人｜甲\n草稿');
  const followUp = coffeePrompts.questionPrompt(session, '請談談成本', '先前追問草稿');
  const observerRefresh = coffeePrompts.observerOnlyPrompt(session);
  for (const prompt of [opening, continuation, followUp, observerRefresh]) {
    assert.match(prompt, /自由深入討論，不限制發言輪數[\s\S]*遇到草稿從全新角度重新展開/);
    assert.doesNotMatch(prompt, /10–18 次簡短發言|約 8–12 次簡短發言|roughly 8–12 concise speaker turns|10–18 concise speaker turns|每個標題下 2–4 個條列|each followed by 2–4 bullets|一位留意矛盾，一位好奇追問/);
    assert.doesNotMatch(prompt, /只作脈絡，不要重寫|請從最後一句接續|只用來推進討論，不要重寫|請從最後一句繼續|不要重複/);
  }
  assert.match(opening, /### 姓名｜角色/);
  assert.match(opening, /## 意外連結/);
  assert.match(opening, /coffee-tables-complete/);
  assert.match(observerRefresh, /只更新觀察者整理/);
  session.guests.stylePrompt = '';
  assert.doesNotMatch(coffeePrompts.tablePrompt('Topic', 'zh-TW', session.guests), /聊天室風格：[\s\S]*?請用自然、口語的繁體中文（台灣用法）對話/);
});
test('Coffee Tables assembles the full timeline chronologically, including interventions, drafts and custom instructions', () => {
  const session = coffeeSession();
  session.guests.customPrompt = '多談第一線的實際情況';
  session.rounds = [{ id: 'r1', markdown: '第一段來賓發言', notes: '', status: 'completed', createdAt: '2026-01-01T00:00:00.000Z' }, { id: 'r2', markdown: '', draftMarkdown: '第二段未完成草稿', notes: '', status: 'error', createdAt: '2026-01-01T00:00:04.000Z' }];
  session.transcriptMarkdown = '第一段來賓發言';
  session.questions = [{ id: 'q1', question: '追問已完成？', answer: '已完成回答', status: 'complete', createdAt: '2026-01-01T00:00:02.000Z' }, { id: 'q2', question: '追問中斷？', answer: '', draftAnswer: '追問回答草稿', status: 'error', createdAt: '2026-01-01T00:00:05.000Z' }];
  session.interventions = [{ id: 'i1', kind: 'comment', text: '使用者中途補充', createdAt: '2026-01-01T00:00:03.000Z' }];
  const context = coffeePrompts.assembleCoffeeContext(session);
  const positions = ['第一段來賓發言', '追問已完成？', '使用者中途補充', '第二段未完成草稿', '追問中斷？'].map(item => context.indexOf(item));
  assert.ok(positions.every(position => position >= 0));
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
  assert.match(coffeePrompts.observerOnlyPrompt(session), /第二段未完成草稿/);
  assert.match(coffeePrompts.observerOnlyPrompt(session), /追問回答草稿/);
  assert.match(coffeePrompts.questionPrompt(session, '接下來呢？'), /多談第一線的實際情況/);
  session.rounds[0].markdown = '### 主持人｜甲\n\n第一句。\n\n### 專家｜乙\n\n第二句。';
  session.interventions = [{ id: 'mid', kind: 'comment', text: '使用者在兩位發言間插話', createdAt: '2026-01-01T00:00:01.500Z', roundId: 'r1', afterTurn: 1 }];
  const interleaved = coffeePrompts.assembleCoffeeContext(session);
  assert.ok(interleaved.indexOf('第一句。') < interleaved.indexOf('使用者在兩位發言間插話'));
  assert.ok(interleaved.indexOf('使用者在兩位發言間插話') < interleaved.indexOf('第二句。'));
});
test('Coffee Tables bilingual samples retain full discussions, five observer notes and a follow-up each', () => {
  const { COFFEE_SAMPLE_ZH, COFFEE_SAMPLE_EN } = load('experiences/coffee-tables/samples.ts');
  for (const sample of [COFFEE_SAMPLE_ZH, COFFEE_SAMPLE_EN]) {
    assert.ok(sample.markdown.length > 8000); assert.ok(sample.question.length > 20); assert.ok(sample.answer.length > 100);
    assert.match(sample.markdown, /(?:最大.*討論轉折|Major turns)/); assert.match(sample.markdown, /(?:尚未解決的核心衝突|Unresolved conflicts)/);
  }
  assert.match(COFFEE_SAMPLE_ZH.title, /中文/); assert.match(COFFEE_SAMPLE_EN.title, /English/);
});
test('Coffee Tables validates numeric guest counts and named guests occupy their selected category slots', () => {
  const { parseSession } = coffeeTypes;
  const valid = coffeeSession();
  valid.guests = { counts: { experts: 2, 'cross-domain': 0, generalist: 0, affected: 1 }, guests: [{ id: 'named-1', category: 'experts', description: '第一線客服' }], background: '小公司', customPrompt: '多談實際做法' };
  assert.equal(parseSession(JSON.stringify(valid)).guests.guests.length, 1); assert.equal(parseSession(JSON.stringify(valid)).guests.hostCount, 2);
  for (let count = 1; count <= 4; count++) { const hosted = { ...valid, guests: { ...valid.guests, hostCount: count } }; assert.equal(parseSession(JSON.stringify(hosted)).guests.hostCount, count); assert.match(coffeePrompts.tablePrompt('Topic', 'en', hosted.guests), new RegExp(`主持人 ${count} 位`)); }
  assert.throws(() => parseSession(JSON.stringify({ ...valid, guests: { ...valid.guests, hostCount: 5 } })), /guest count/i);
  for (const counts of [
    { experts: 0, 'cross-domain': 0, generalist: 0, affected: 0 },
    { experts: 8, 'cross-domain': 8, generalist: 0, affected: 0 },
    { experts: 9, 'cross-domain': 1, generalist: 1, affected: 1 },
    { experts: 1, 'cross-domain': 0, generalist: 0, affected: 0 },
  ]) {
    const invalid = { ...valid, guests: { ...valid.guests, counts, guests: [{ id: 'named-1', category: 'experts', description: '客服' }, { id: 'named-2', category: 'experts', description: '店長' }] } };
    assert.throws(() => parseSession(JSON.stringify(invalid)), /guest count/i);
  }
});
integrationTest('Coffee Tables continues in the same timeline and refreshes observer notes from the full context', async () => {
  const session = coffeeSession(); session.guests.customPrompt = '多談小公司能採取的做法';
  const notes = (version, label) => `# 觀察者整理\n\n## 最大討論轉折\n- ${label}\n\n## 被推翻或修正的假設\n- ${version}\n\n## 值得繼續追問的問題\n- 下一步？\n\n## 尚未解決的核心分歧\n- 仍有取捨`;
  const responses = [
    `### 主持人｜林岑\n先從規模談起。\n\n${notes('小公司不一定有完整團隊', '從導入轉向誰負責')}`,
    `### 受影響者｜客服代表\n我們要先談員工能不能拒絕。\n\n${notes('效率不代表工作量消失', '追問把焦點帶到拒絕權')}`,
    `### 主持人｜周以安\n先把試辦退出條件寫清楚。\n\n${notes('試辦也需要退出條件', '使用者追問帶出可逆性')}`,
  ];
  const prompts = [];
  const engine = new coffee.CoffeeEngine(session, async request => { prompts.push(request.prompt); return responses.shift(); }, async () => {});
  await engine.start(); const firstTranscript = engine.session.transcriptMarkdown;
  await engine.continueTable();
  assert.equal(engine.session.rounds.length, 2); assert.match(engine.session.transcriptMarkdown, /先從規模談起/); assert.match(engine.session.transcriptMarkdown, /我們要先談員工能不能拒絕/);
  assert.match(prompts[1], /(?:新增約 8–12 次簡短發言|add roughly 8–12 concise speaker turns)/); assert.match(prompts[1], /小公司能採取的做法/); assert.match(prompts[1], /從導入轉向誰負責/);
  assert.equal(engine.session.observerNotes.length, 1); assert.match(engine.session.observerNotes[0], /追問把焦點帶到拒絕權/); assert.match(engine.session.observerNotes[0], /從導入轉向誰負責/);
  await engine.ask('員工能拒絕試辦嗎？');
  assert.match(engine.session.questions.at(-1).question, /員工能拒絕試辦嗎/); assert.match(engine.session.questions.at(-1).answer, /先把試辦退出條件寫清楚/); assert.match(prompts[2], /小公司能採取的做法/); assert.match(prompts[2], /使用者的新問題/); assert.match(prompts[2], /追問把焦點帶到拒絕權/);
  assert.equal(engine.session.observerNotes.length, 1); assert.match(engine.session.observerNotes[0], /小公司不一定有完整團隊/); assert.ok(firstTranscript.length > 0);
});
integrationTest('Coffee Tables makes one full-text call and saves the complete Markdown only after success', async () => {
  const session = coffeeSession(); let calls = 0, saves = [];
  const transcript = '# 對談\n\n### 主持人｜主持人\n\n可以加菜，但別讓孩子被標記。\n\n# 觀察者整理\n\n## 最大討論轉折\n- 從公平轉向選擇\n\n## 被推翻或修正的假設\n- 家長付費必然改善品質\n\n## 值得繼續追問的問題\n- 如何避免標記\n\n## 尚未解決的核心分歧\n- 公平與選擇的取捨';
  const engine = new coffee.CoffeeEngine(session, async request => { calls++; assert.match(request.prompt, /1 位中立觀察者/); assert.equal(request.session.model, 'test-model'); return transcript; }, async value => saves.push(plain(value)));
  await engine.generate();
  assert.equal(calls, 1); assert.equal(engine.session.status, 'completed', engine.error); assert.equal(engine.session.transcriptMarkdown, '# 對談\n\n### 主持人｜主持人\n\n可以加菜，但別讓孩子被標記。');
  assert.equal(saves.at(-1).transcriptMarkdown, engine.session.transcriptMarkdown); assert.equal(saves.at(-1).status, 'completed');
});
integrationTest('Coffee Tables recognizes a complete saved draft with bold Markdown insight groups without calling the model again', async () => {
  const session = coffeeSession(); const transcript = '### 主持人｜周沐\n\n先從時間實際去了哪裡開始。\n\n### 觀察者｜許安\n\n要確認績效制度有沒有改變。'; const notes = '# 觀察者整理\n\n- **最新轉折**\n  - 焦點轉向時間是否真的回到員工。\n- **修正後的假設**\n  - 省時不代表工作量下降。\n- **值得繼續追問的問題**\n  - 如何記錄修正成本？\n- **尚未解決的核心分歧**\n  - 產能與喘息空間如何取捨。'; const draft = `${transcript}\n\n${notes}\n\n${transcript}\n\n${notes}\n\n<!-- coffee-tables-complete -->`;
  session.status = 'error'; session.error = 'observer format'; session.draftMarkdown = draft;
  session.rounds = [{ id: 'draft-round', markdown: '', notes: '', draftMarkdown: draft, status: 'error', createdAt: session.createdAt }];
  let calls = 0, saved;
  const engine = new coffee.CoffeeEngine(session, async () => { calls++; return ''; }, async value => { saved = plain(value); });
  await engine.start();
  assert.equal(calls, 0); assert.equal(engine.session.status, 'completed'); assert.match(engine.session.transcriptMarkdown, /先從時間實際去了哪裡開始/); assert.equal((engine.session.transcriptMarkdown.match(/先從時間實際去了哪裡開始/g) ?? []).length, 1, engine.session.transcriptMarkdown);
  assert.match(engine.session.observerNotes[0], /省時不代表工作量下降/); assert.equal(engine.session.draftMarkdown, undefined); assert.equal(saved.status, 'completed');
});
integrationTest('Coffee Tables recovers complete observer sections when the root heading is missing', async () => {
  const session = coffeeSession();
  const dialogue = '### 主持人｜林岑\n\n對話文字。\n\n### 沈默｜中立觀察者\n\n簡短觀察。';
  const notes = [
    '## 意外連結\n\n- 這裡寫出討論中出現的意外連結。',
    '## 值得繼續想的問題\n\n- 還要釐清後續值得討論的問題。',
    '## 核心分歧\n\n- 這裡保留尚未解決的核心分歧。',
    '## 探索方向\n\n- 可以接著探索其他方向。',
    '## 值得查證的假設\n\n- 需要查證的假設仍待確認。',
  ].join('\n\n');
  const draft = `${dialogue}\n\n${notes}\n\n<!-- coffee-tables-complete -->`;
  session.status = 'error'; session.error = 'observer format'; session.draftMarkdown = draft;
  session.rounds = [{ id: 'missing-root-round', markdown: '', notes: '', draftMarkdown: draft, status: 'error', createdAt: session.createdAt }];
  let calls = 0;
  const engine = new coffee.CoffeeEngine(session, async () => { calls++; return ''; }, async () => {});
  await engine.start();
  assert.equal(calls, 0); assert.equal(engine.session.status, 'completed');
  assert.match(engine.session.transcriptMarkdown, /簡短觀察/); assert.doesNotMatch(engine.session.transcriptMarkdown, /## 意外連結/);
  assert.match(engine.session.observerNotes[0], /^# 觀察者整理/); assert.match(engine.session.observerNotes[0], /## 意外連結/);
});
integrationTest('Coffee Tables removes earlier rootless observer sections when a complete draft is duplicated', async () => {
  const session = coffeeSession();
  const notes = label => [
    `## 意外連結\n\n- ${label} 的意外連結內容已完整整理。`,
    `## 值得繼續想的問題\n\n- ${label} 後續值得討論的問題仍然存在。`,
    `## 核心分歧\n\n- ${label} 尚未解決的核心分歧需要保留。`,
    `## 探索方向\n\n- ${label} 可以接著探索其他方向。`,
    `## 值得查證的假設\n\n- ${label} 還需要查證這項假設。`,
  ].join('\n\n');
  const first = `### 主持人｜林岑\n\n第一段對談。\n\n### 沈默｜中立觀察者\n\n第一份整理前的觀察。\n\n${notes('第一份')}`;
  const second = `### 主持人｜周禾\n\n第二段對談。\n\n### 沈默｜中立觀察者\n\n第二份整理前的觀察。\n\n${notes('第二份')}`;
  const draft = `${first}\n\n${second}\n\n<!-- coffee-tables-complete -->`;
  session.status = 'error'; session.draftMarkdown = draft; session.rounds = [{ id: 'duplicate-rootless-round', markdown: '', notes: '', draftMarkdown: draft, status: 'error', createdAt: session.createdAt }];
  let calls = 0; const engine = new coffee.CoffeeEngine(session, async () => { calls++; return ''; }, async () => {});
  await engine.start();
  assert.equal(calls, 0); assert.equal(engine.session.status, 'completed');
  assert.match(engine.session.transcriptMarkdown, /第一段對談/); assert.match(engine.session.transcriptMarkdown, /第二段對談/);
  assert.doesNotMatch(engine.session.transcriptMarkdown, /## 意外連結/);
  assert.match(engine.session.observerNotes[0], /第二份.*意外連結內容/); assert.doesNotMatch(engine.session.observerNotes[0], /第一份.*意外連結內容/);
});
integrationTest('Coffee Tables does not recover rootless observer notes missing a standard section', async () => {
  const session = coffeeSession();
  const draft = '### 主持人｜林岑\n\n對談文字。\n\n### 沈默｜中立觀察者\n\n簡短觀察。\n\n## 意外連結\n\n- 有整理。\n\n## 值得繼續想的問題\n\n- 有整理。\n\n## 核心分歧\n\n- 有整理。\n\n## 探索方向\n\n- 有整理。\n\n<!-- coffee-tables-complete -->';
  session.status = 'error'; session.draftMarkdown = draft; session.rounds = [{ id: 'incomplete-rootless-round', markdown: '', notes: '', draftMarkdown: draft, status: 'error', createdAt: session.createdAt }];
  let calls = 0; const engine = new coffee.CoffeeEngine(session, async () => { calls++; return ''; }, async () => {});
  await engine.start();
  assert.equal(calls, 1); assert.equal(engine.session.status, 'error'); assert.equal(engine.session.transcriptMarkdown, '');
});
integrationTest('Coffee Tables does not recover rootless observer notes with an empty standard section', async () => {
  const session = coffeeSession();
  const draft = '### 主持人｜林岑\n\n對談文字。\n\n### 沈默｜中立觀察者\n\n簡短觀察。\n\n## 意外連結\n\n- 有整理。\n\n## 值得繼續想的問題\n\n- 有整理。\n\n## 核心分歧\n\n- 有整理。\n\n## 探索方向\n\n- 有整理。\n\n## 值得查證的假設\n\n<!-- coffee-tables-complete -->';
  session.status = 'error'; session.draftMarkdown = draft; session.rounds = [{ id: 'empty-rootless-round', markdown: '', notes: '', draftMarkdown: draft, status: 'error', createdAt: session.createdAt }];
  let calls = 0; const engine = new coffee.CoffeeEngine(session, async () => { calls++; return ''; }, async () => {});
  await engine.start();
  assert.equal(calls, 1); assert.equal(engine.session.status, 'error'); assert.equal(engine.session.transcriptMarkdown, '');
});
integrationTest('Coffee Tables recognizes complete English observer sections without the root heading', async () => {
  const session = coffeeSession(); session.language = 'en';
  const draft = '### Host | Lin Cen\n\nConversation text.\n\n### Observer | Observer\n\nBrief observation.\n\n## Unexpected connections\n\n- A useful unexpected connection is visible in the conversation.\n\n## Questions worth pursuing\n\n- A question remains open for further discussion.\n\n## Core disagreements\n\n- The unresolved disagreement should be retained.\n\n## Directions to explore\n\n- Several directions remain available for exploration.\n\n## Assumptions to verify\n\n- This assumption needs checking before it is treated as fact.\n\n<!-- coffee-tables-complete -->';
  session.status = 'error'; session.draftMarkdown = draft; session.rounds = [{ id: 'english-rootless-round', markdown: '', notes: '', draftMarkdown: draft, status: 'error', createdAt: session.createdAt }];
  let calls = 0; const engine = new coffee.CoffeeEngine(session, async () => { calls++; return ''; }, async () => {});
  await engine.start();
  assert.equal(calls, 0); assert.equal(engine.session.status, 'completed'); assert.match(engine.session.observerNotes[0], /^# Observer’s notes/);
});
integrationTest('Coffee Tables trusts a complete observer summary from the resolved stream when the runtime final text disagrees', async () => {
  const session = coffeeSession(), streamed = '### 主持人｜林岑\n\n省下時間要先確認有沒有轉成別人的工作。\n\n# 觀察者整理\n\n- **最新轉折**\n  - 討論從節省時間轉向工作是否轉移。\n- **修正後的假設**\n  - 個人省時不代表案件總時間下降。\n- **值得繼續追問的問題**\n  - 如何記錄交接成本？\n- **尚未解決的核心分歧**\n  - 緩衝和產能怎麼分配？';
  let calls = 0; const engine = new coffee.CoffeeEngine(session, async request => { calls++; request.onText?.(streamed); return 'Runtime final text omitted the completed summary.'; }, async () => {});
  await engine.start(); assert.equal(calls, 1); assert.equal(engine.session.status, 'completed'); assert.match(engine.session.transcriptMarkdown, /省下時間要先確認/); assert.match(engine.session.observerNotes[0], /交接成本/); assert.equal(engine.session.draftMarkdown, undefined);
});
integrationTest('Coffee Tables accepts the concise prose observer summary returned during Obsidian acceptance', async () => {
  const session = coffeeSession();
  const transcript = '### 周沐｜主持人（好奇追問）\n\n今天的題目是省下的時間應該去哪裡？';
  const notes = '# 觀察者整理\n\n目前桌上有一個暫時共識：省下的時間不應自動等同於多接案件，應該考慮減少尖峰壓力、培訓、交接緩衝和實際休息。但這些選項怎麼分配，仍取決於績效制度與輪班安排是否一起調整。\n\n還需要查證幾件事：AI 真正節省的是哪些工作時間；人工檢查和修正增加多少成本；不同班別、資歷和案件類型是否受到不同影響；以及員工選擇休息或培訓後，績效評估是否真的不會吃虧。';
  const engine = new coffee.CoffeeEngine(session, async () => `${transcript}\n\n${notes}`, async () => {});
  await engine.start();
  assert.equal(engine.session.status, 'completed', engine.error);
  assert.equal(engine.session.transcriptMarkdown, transcript);
  assert.match(engine.session.observerNotes[0], /省下的時間不應自動等同於多接案件/);
  assert.match(engine.session.observerNotes[0], /還需要查證幾件事/);
});
integrationTest('Coffee Tables keeps a prose observer summary as a draft when its final paragraph is truncated', async () => {
  const session = coffeeSession();
  const response = '### 周沐｜主持人\n\n我們需要一起看工作量。\n\n# 觀察者整理\n\n目前桌上有一個暫時共識：要同時觀察緩衝時間、交接和工作負擔。\n\n還需要查證幾件事：不同班別是否受影響，以及客服選擇休息後的績效「保護條款」';
  const engine = new coffee.CoffeeEngine(session, async request => { request.onText?.(response); return response; }, async () => {});
  await engine.start();
  assert.equal(engine.session.status, 'error');
  assert.equal(engine.session.transcriptMarkdown, '');
  assert.match(engine.session.draftMarkdown, /績效「保護條款」$/);
  assert.match(engine.error, /整理格式不完整/);
});
integrationTest('Coffee Tables does not recover an interrupted draft with empty observer groups', async () => {
  const session = coffeeSession(); const partial = '### 主持人｜林岑\n\n先把問題拆小。\n\n# 觀察者整理\n\n- **最新轉折**\n  - 焦點改變了。\n- **修正後的假設**\n  - 假設需要重看。\n- **值得繼續追問的問題**\n  - 這段尚未完成。\n- **尚未解決的核心分歧**\n  - 尚';
  session.status = 'error'; session.draftMarkdown = partial; session.rounds = [{ id: 'partial-round', markdown: '', notes: '', draftMarkdown: partial, status: 'error', createdAt: session.createdAt }];
  const pending = deferred(); let calls = 0;
  const engine = new coffee.CoffeeEngine(session, async () => { calls++; return pending.promise; }, async () => {});
  const running = engine.start(); await until(() => calls === 1); assert.equal(engine.session.status, 'generating');
  engine.cancel(); pending.resolve(''); await running; assert.equal(engine.session.status, 'error'); assert.match(engine.session.draftMarkdown, /尚未完成/);
});
integrationTest('Coffee Tables preserves turn positions when recovering a draft that contains interventions', async () => {
  const session = coffeeSession(); const speech = '### 主持人｜林岑\n\n先談怎麼分工。'; const notes = '# 觀察者整理\n\n- **最新轉折**\n  - 討論開始從工具轉向工作如何重新分配。\n- **修正後的假設**\n  - 省下時間不代表第一線工作量自然下降。\n- **值得繼續追問的問題**\n  - 誰來記錄並處理自動化的例外？\n- **尚未解決的核心分歧**\n  - 效率提升應該回到公司還是員工？';
  const draft = `${speech}\n\n${speech}\n\n${notes}\n\n<!-- coffee-tables-complete -->`; session.status = 'error'; session.draftMarkdown = draft; session.rounds = [{ id: 'draft-with-intervention', markdown: '', notes: '', draftMarkdown: draft, status: 'error', createdAt: session.createdAt }]; session.interventions = [{ id: 'comment-1', kind: 'comment', text: '先談第一線的工作量。', createdAt: new Date().toISOString(), status: 'sent', roundId: 'draft-with-intervention', afterTurn: 2 }];
  const engine = new coffee.CoffeeEngine(session, async () => { throw new Error('must not call provider'); }, async () => {}); await engine.start();
  assert.equal(engine.session.interventions[0].afterTurn, 2); assert.equal((engine.session.transcriptMarkdown.match(/先談怎麼分工/g) ?? []).length, 2); assert.equal(engine.session.status, 'completed');
});
integrationTest('Coffee Tables failure preserves the existing transcript and retry replaces the same follow-up', async () => {
  const session = coffeeSession(); session.status = 'completed'; session.transcriptMarkdown = '完整對談'; let fail = true, calls = 0;
  const engine = new coffee.CoffeeEngine(session, async request => { calls++; assert.match(request.prompt, /完整對談/); if (fail) throw new Error('provider failed'); return '### 林岑｜主持人\n\n由主持人接話。\n\n# 觀察者整理\n\n## 最大討論轉折\n- 更新\n## 被推翻或修正的假設\n- 更新\n## 值得繼續追問的問題\n- 更新\n## 尚未解決的核心分歧\n- 更新'; }, async () => {});
  await engine.ask('為什麼免費和加價不能混在一起？', 'q1');
  assert.equal(engine.session.questions.length, 1); assert.equal(engine.session.questions[0].status, 'error'); assert.equal(engine.session.transcriptMarkdown, '完整對談');
  fail = false; await engine.ask('為什麼免費和加價不能混在一起？', 'q1');
  assert.equal(calls, 2); assert.equal(engine.session.questions.length, 1); assert.equal(engine.session.questions[0].status, 'complete'); assert.equal(engine.session.questions[0].answer, '### 林岑｜主持人\n\n由主持人接話。');
});
integrationTest('Coffee Tables follow-up retry drops an interrupted observer-notes tail from the answer', async () => {
  const session = coffeeSession(); session.status = 'completed'; session.transcriptMarkdown = '原本對談'; session.questions = [{ id: 'q-tail', question: '追問問題', answer: '', draftAnswer: '### 林岑｜主持人\n\n已收到的回答。\n\n# 觀察者整理\n\n## 核心分歧\n- 尚未整理完成', status: 'error', createdAt: session.createdAt }];
  const notes = '# 觀察者整理\n\n## 最大討論轉折\n- 回到工作分配\n\n## 被推翻或修正的假設\n- 效率不等於公平\n\n## 值得繼續追問的問題\n- 誰承擔例外？\n\n## 尚未解決的核心分歧\n- 由誰決定';
  const engine = new coffee.CoffeeEngine(session, async () => `### 受影響者｜客服代表\n\n我補充例外工作。\n\n${notes}`, async () => {});
  await engine.ask('追問問題', 'q-tail');
  const answer = engine.session.questions[0].answer;
  assert.match(answer, /已收到的回答/); assert.match(answer, /我補充例外工作/);
  assert.doesNotMatch(answer, /# 觀察者整理|尚未整理完成/);
  assert.equal((answer.match(/已收到的回答/g) ?? []).length, 1);
});
integrationTest('Coffee Tables locks follow-up submission while the question is being saved', async () => {
  const session = coffeeSession(); session.status = 'completed'; session.transcriptMarkdown = 'Full table'; const saved = deferred(); let saving = false;
  const engine = new coffee.CoffeeEngine(session, async () => 'One answer', async value => { if (value.questions.length && !saving) { saving = true; await saved.promise; } });
  const first = engine.ask('First question'); await until(() => saving); await engine.ask('Second question'); saved.resolve(); await first;
  assert.equal(engine.session.questions.length, 1); assert.equal(engine.session.questions[0].question, 'First question');
});
integrationTest('Coffee Tables cancellation discards late text and closing waits for the pending request', async () => {
  const late = deferred(); let saved = [];
  const engine = new coffee.CoffeeEngine(coffeeSession(), async request => { request.onText?.('已收到的草稿'); return late.promise; }, async value => saved.push(plain(value)));
  const running = engine.generate(); await until(() => engine.busy && engine.session.draftMarkdown); engine.cancel(); late.resolve('這是取消後的晚到回答'); await running;
  assert.equal(engine.session.transcriptMarkdown, ''); assert.equal(engine.session.status, 'error'); assert.equal(engine.session.draftMarkdown, '已收到的草稿'); assert.equal(saved.at(-1).draftMarkdown, '已收到的草稿');
  const second = new coffee.CoffeeEngine(coffeeSession(), async () => late.promise, async () => {}); const task = second.generate(); await until(() => second.busy); const closing = second.stop(); await closing; await task;
  assert.equal(second.session.transcriptMarkdown, '');
});
integrationTest('Coffee Tables retry folds its saved partial conversation into the completed segment', async () => {
  const session = coffeeSession(); let calls = 0; const partial = '### 林岑｜主持人\n先談怎麼分工。';
  session.status = 'error'; session.draftMarkdown = partial; session.rounds = [{ id: 'failed-round', markdown: '', notes: '', draftMarkdown: partial, status: 'error', createdAt: session.createdAt }]; session.interventions = [{ id: 'retry-comment', kind: 'comment', text: '先把第一線的工作量算進去。', createdAt: session.createdAt, status: 'sent', roundId: 'failed-round', afterTurn: 1 }];
  const notes = '# 觀察者整理\n\n## 最大討論轉折\n- 從工具轉向分工\n\n## 被推翻或修正的假設\n- 自動化不會自行減少責任\n\n## 值得繼續追問的問題\n- 誰負責覆核？\n\n## 尚未解決的核心分歧\n- 效率與控制';
  const engine = new coffee.CoffeeEngine(session, async request => { calls++; if (calls === 1) { request.onText?.(partial); throw new Error('network interrupted'); } assert.match(request.prompt, /先談怎麼分工/); request.onText?.(`${partial}\n\n### 家長｜受影響者\n我想先知道誰負責。`); return `### 家長｜受影響者\n我想先知道誰負責。\n\n${notes}`; }, async () => {});
  await engine.start(); assert.equal(engine.session.status, 'error'); assert.match(engine.session.draftMarkdown, /先談怎麼分工/);
  await engine.start(); assert.equal(engine.session.status, 'completed'); assert.match(engine.session.transcriptMarkdown, /先談怎麼分工/); assert.match(engine.session.transcriptMarkdown, /誰負責/); assert.equal(engine.session.draftMarkdown, undefined); assert.equal(engine.session.rounds.filter(round => round.draftMarkdown).length, 0); assert.equal(engine.session.interventions[0].roundId, engine.session.rounds[0].id); assert.equal(engine.session.interventions[0].afterTurn, 1); assert.ok(Date.parse(engine.session.lastCompletedAt) >= Date.parse(session.createdAt));
});
integrationTest('Coffee Tables can refresh observer notes from a stopped draft without generating dialogue', async () => {
  const session = coffeeSession(); session.status = 'error'; session.transcriptMarkdown = '### 林岑｜主持人\n\n先前已完成的對談。'; session.draftMarkdown = '### 家長｜受影響者\n\n收到一半的觀點。';
  const previous = '# 觀察者整理\n\n## 最大討論轉折\n- 舊整理'; session.observerNotes = [previous]; let calls = 0, saved;
  const fresh = '# 觀察者整理\n\n## 最大討論轉折\n- 草稿帶來的新轉折\n\n## 被推翻或修正的假設\n- 舊假設需要修正\n\n## 值得繼續追問的問題\n- 誰承擔後續責任？\n\n## 尚未解決的核心分歧\n- 效率與公平';
  const engine = new coffee.CoffeeEngine(session, async request => { calls++; assert.match(request.prompt, /只更新觀察者整理|only produce observer notes/i); assert.match(request.prompt, /收到一半的觀點/); request.onText?.(fresh); return fresh; }, async value => { saved = plain(value); });
  await engine.refreshObserverNotes();
  assert.equal(calls, 1); assert.equal(engine.session.status, 'error'); assert.match(engine.session.draftMarkdown, /收到一半的觀點/); assert.match(engine.session.observerNotes[0], /草稿帶來的新轉折/); assert.equal(saved.status, 'error');
});
integrationTest('Coffee Tables retains a previous observer-summary draft if a summary retry fails', async () => {
  const session = coffeeSession(); session.status = 'error'; session.draftMarkdown = '### 來賓｜專家\n\n已保存對談。'; session.observerDraftMarkdown = '# 觀察者整理\n\n## 核心分歧\n- 先前整理草稿';
  const previous = '# 觀察者整理\n\n## 核心分歧\n- 正式舊版'; session.observerNotes = [previous];
  const engine = new coffee.CoffeeEngine(session, async request => { request.onText?.('未完成的新整理'); throw new Error('network interrupted'); }, async () => {});
  await engine.refreshObserverNotes();
  assert.equal(engine.session.observerNotes[0], previous);
  assert.match(engine.session.observerDraftMarkdown, /先前整理草稿/);
  assert.match(engine.session.observerDraftMarkdown, /未完成的新整理/);
  assert.equal(engine.session.dirtyNotes, true);
});
integrationTest('Coffee Tables routes in-room comments, guest questions and direction changes into the active request', async () => {
  const pending = deferred(), steers = [], saves = [];
  const engine = new coffee.CoffeeEngine(coffeeSession(), async request => { request.registerIntervention?.(async text => { steers.push(text); }); return pending.promise; }, async value => saves.push(plain(value)));
  const task = engine.start(); const early = engine.intervene('comment', 'A parent in the room has a different concern.'); await until(() => engine.busy && engine.steer); await early;
  await engine.intervene('guest-question', 'What would this cost?', '林岑');
  await engine.intervene('redirect', 'Compare equal access with family choice.');
  assert.equal(steers.length, 3); assert.match(steers[0], /A parent/); assert.match(steers[1], /林岑/); assert.match(steers[2], /new direction|redirect/i);
  assert.equal(engine.session.interventions?.length, 3); assert.ok(engine.session.interventions.every(item => item.status === 'sent')); assert.equal(saves.at(-1).interventions.length, 3);
  pending.resolve('The full discussion.'); await task;
});
integrationTest('Coffee Tables shutdown drains an accepted intervention before returning', async () => {
  const response = deferred(), steering = deferred(); let startedSteer = false;
  const engine = new coffee.CoffeeEngine(coffeeSession(), async request => { request.signal.addEventListener('abort', () => response.resolve('')); request.registerIntervention?.(async () => { startedSteer = true; await steering.promise; }); return response.promise; }, async () => {});
  const task = engine.start(); await until(() => engine.busy && engine.steer);
  const intervention = engine.intervene('comment', 'One last point.'); await until(() => startedSteer);
  let returned = false; const stopping = engine.stop().then(() => { returned = true; }); await task; await Promise.resolve(); assert.equal(returned, false);
  steering.resolve(); await intervention; await stopping; assert.equal(returned, true);
});
integrationTest('Coffee Tables preview inspection is read-only and refuses an incomplete save journal', async () => {
  const { CoffeeStorage } = load('experiences/coffee-tables/storage.ts', { obsidian }); const { app, files, contents } = fixture(); app.vault.getFiles = () => [...files.values()].filter(f => f instanceof TFile);
  const store = new CoffeeStorage(app.vault, 'Agent Workspace'), session = coffeeSession(); session.status = 'completed'; session.transcriptMarkdown = '### 主持人｜林岑\n已保存。'; session.rounds = [{ id: 'round-ro', markdown: session.transcriptMarkdown, notes: '# 觀察者整理\n\n## 分歧\n- 保留', status: 'completed', createdAt: session.createdAt }]; await store.save(session);
  const path = store.sessionPath(session.id), before = contents.get(path), sidePath = store.sidecarPath(session.id), sideRaw = contents.get(sidePath); let writes = 0; const write = app.vault.adapter.write, processFile = app.vault.adapter.process; app.vault.adapter.write = async (...args) => { writes++; return write(...args); }; app.vault.adapter.process = async (...args) => { writes++; return processFile(...args); };
  const read = await store.inspectReadOnly(path); assert.equal(read.id, session.id); assert.equal(writes, 0); assert.equal(contents.get(path), before);
  const side = JSON.parse(sideRaw); side.journal = { previousMarkdownHash: 'x', nextMarkdownHash: 'y', previousSidecar: sideRaw }; contents.set(sidePath, JSON.stringify(side)); const journal = contents.get(sidePath); await assert.rejects(store.inspectReadOnly(path), /unfinished save/); assert.equal(writes, 0); assert.equal(contents.get(sidePath), journal);
});

integrationTest('Coffee Tables persists follow-up guest invitations and keeps one cumulative insight document', async () => {
  const { CoffeeStorage } = load('experiences/coffee-tables/storage.ts', { obsidian });
  const { app, files, contents } = fixture(); app.vault.getFiles = () => [...files.values()].filter(file => file instanceof TFile);
  const store = new CoffeeStorage(app.vault, 'Agent Workspace'), session = coffeeSession(); session.status = 'completed';
  const invited = [{ id: 'invite-anna', name: '林照', category: 'affected', description: '熟悉夜班與照護資源的社工' }];
  session.questions = [{ id: 'question-guest', question: '夜班遇到突發狀況如何求援？', answer: '先確認交接流程。', status: 'complete', createdAt: session.createdAt, invitedGuests: invited }];
  session.observerNotes = ['# 觀察者整理\n\n## 核心分歧\n- 是否把求援責任留給第一線。', '# 觀察者整理\n\n## 意外連結\n- 夜班支援也像備援網絡。'];
  await store.save(session); const path = store.sessionPath(session.id), raw = contents.get(path);
  assert.match(raw, /林照｜受影響者/); assert.doesNotMatch(raw, /### 先前版本|### 最新版本/); assert.match(raw, /夜班支援也像備援網絡/); assert.match(raw, /是否把求援責任留給第一線/);
  const restored = await new CoffeeStorage(app.vault, 'Agent Workspace').load(session.id);
  assert.equal(JSON.stringify(restored.questions[0].invitedGuests), JSON.stringify(invited)); assert.equal(restored.observerNotes.length, 1);
});
integrationTest('Coffee Tables backs up the exact old versioned Markdown before its first cumulative rewrite', async () => {
  const { CoffeeStorage } = load('experiences/coffee-tables/storage.ts', { obsidian });
  const { app, files, contents } = fixture(); app.vault.getFiles = () => [...files.values()].filter(file => file instanceof TFile);
  const store = new CoffeeStorage(app.vault, 'Agent Workspace'), session = coffeeSession(); session.status = 'completed';
  session.observerNotes = ['# 觀察者整理\n\n## 核心分歧\n- 最新見解。', '# 觀察者整理\n\n## 意外連結\n- 早期跨域線索。']; await store.save(session);
  const path = store.sessionPath(session.id), first = contents.get(path), old = first.replace(/## 觀察者整理[\s\S]*$/, '## 觀察者整理\n\n### 最新版本\n\n# 觀察者整理\n\n## 核心分歧\n- 最新見解。\n\n### 先前版本\n\n#### 第 1 版\n\n# 觀察者整理\n\n## 意外連結\n- 早期跨域線索。'); contents.set(path, old);
  const reopenedStore = new CoffeeStorage(app.vault, 'Agent Workspace'), loaded = await reopenedStore.load(session.id); await reopenedStore.save(loaded);
  const backups = [...contents.keys()].filter(name => name.includes('/.sessions/backups/') && name.endsWith('.md'));
  assert.equal(backups.length, 1); assert.equal(contents.get(backups[0]), old); assert.match(contents.get(path), /早期跨域線索/); assert.doesNotMatch(contents.get(path), /### 先前版本/);
});
integrationTest('Coffee Tables Markdown storage round trips punctuation, Traditional Chinese, Q&A and protects outside edits', async () => {
  const { CoffeeStorage } = load('experiences/coffee-tables/storage.ts', { obsidian });
  const { app, files, contents } = fixture(); app.vault.getFiles = () => [...files.values()].filter(f => f instanceof TFile);
  const store = new CoffeeStorage(app.vault, 'Agent Workspace'), session = coffeeSession();
  session.status = 'completed'; session.lastGenerationStartedAt = '2026-09-29T20:00:00.000Z'; session.lastCompletedAt = '2026-09-29T20:05:00.000Z'; session.transcriptMarkdown = '### 林岑｜主持人\n先問現場怎麼運作。\n\n### 家長｜受影響者\n孩子會注意到標籤。'; session.rounds = [{ id: 'round-main', markdown: session.transcriptMarkdown, notes: '', status: 'completed', createdAt: session.createdAt }];
  session.draftMarkdown = '### 主持人｜追問\n第一段尚未完成';
  session.observerDraftMarkdown = '# 觀察者整理\n\n## 核心分歧\n- 整理草稿也需要保存';
  session.observerNotes = ['# 觀察者整理\n\n## 最大討論轉折\n- 新版轉折\n\n## 尚未解決的核心分歧\n- 新版分歧', '# 觀察者整理\n\n## 最大討論轉折\n- 舊版轉折\n\n## 尚未解決的核心分歧\n- 舊版分歧'];
  session.questions = [{ id: 'q-1', question: '會不會造成分級？', answer: '要看加價如何呈現。', draftAnswer: '### 觀眾｜家長\n我還在回答…', status: 'complete', createdAt: new Date(Date.parse(session.createdAt) + 2000).toISOString() }];
  session.interventions = [{ id: 'comment-1', kind: 'comment', text: '家長也需要看得到退出方式。', createdAt: new Date(Date.parse(session.createdAt) + 1000).toISOString(), status: 'sent', roundId: 'round-main', afterTurn: 1 }];
  await store.save(session); const filePath = store.sessionPath(session.id), original = contents.get(filePath);
  assert.match(original, /先問現場怎麼運作[\s\S]*你（插話）[\s\S]*家長也需要看得到退出方式[\s\S]*孩子會注意到標籤/); assert.match(original, /會不會造成分級/); assert.match(original, /Reasoning|推理強度/); assert.match(original, /## 對話紀錄/); assert.equal(original.split("\n")[0], `# ${session.topic}`); assert.doesNotMatch(original, /coffee-tables-data|coffee-tables-transcript-end|<\!--.*version/i); assert.ok(files.has(`${store.hidden}/${session.id}.json`)); assert.doesNotMatch(original, new RegExp(session.id));
  assert.ok(original.length < (session.transcriptMarkdown.length + session.draftMarkdown.length + session.questions[0].draftAnswer.length) * 2 + 2200, 'session metadata should not duplicate or expand the transcript');
  const reopened = new CoffeeStorage(app.vault, 'Agent Workspace'), restored = await reopened.load(session.id); assert.equal(restored.topic, session.topic); assert.match(restored.transcriptMarkdown,/先問現場怎麼運作/); assert.equal(restored.questions[0].question,session.questions[0].question); assert.equal(restored.questions[0].draftAnswer,session.questions[0].draftAnswer); assert.match(restored.interventions[0].text,/退出方式/); assert.match(restored.draftMarkdown,/第一段尚未完成/); assert.match(restored.observerDraftMarkdown,/整理草稿也需要保存/); assert.match(restored.observerNotes[0], /新版分歧/); assert.match(restored.observerNotes[0], /舊版分歧/); assert.equal(restored.observerNotes.length, 1); assert.equal(restored.model,session.model); assert.equal(restored.lastGenerationStartedAt, session.lastGenerationStartedAt); assert.equal(restored.lastCompletedAt, session.lastCompletedAt);
  const outside = original.replace('先問現場怎麼運作。', '編輯者補上現場資訊。'); contents.set(filePath, outside); const inspected = await store.inspect(filePath); assert.equal(inspected.dirtyNotes, true); await assert.rejects(store.save(session), /changed outside/); assert.equal(contents.get(filePath), outside);
  const adopted = await store.reload(filePath); assert.match(adopted.transcriptMarkdown, /編輯者補上現場資訊/); assert.match(adopted.interventions[0].text, /退出方式/); assert.equal(adopted.dirtyNotes, true);
});
integrationTest('Coffee Tables Markdown round trips style snapshots and reference text without parsing embedded headings as dialogue', async () => {
  const { CoffeeStorage } = load('experiences/coffee-tables/storage.ts', { obsidian }); const { app, files } = fixture(); app.vault.getFiles = () => [...files.values()].filter(file => file instanceof TFile);
  const store = new CoffeeStorage(app.vault, 'Agent Workspace'), session = coffeeSession(); session.status = 'completed'; session.guests.styleId = 'style-1'; session.guests.styleName = '輕鬆聊天'; session.guests.stylePrompt = '主持人多追問。'; session.guests.referenceFiles = [{ name: '背景.md', content: '# 內文標題\n```md\n### 假來賓｜主持人\n<!-- coffee-tables-complete -->\n```' }]; session.transcriptMarkdown = '### 林岑｜主持人\n真正的發言。'; session.rounds = [{ id: 'style-round', markdown: session.transcriptMarkdown, notes: '', status: 'completed', createdAt: session.createdAt }];
  await store.save(session); const restored = await new CoffeeStorage(app.vault, 'Agent Workspace').load(session.id); assert.equal(restored.guests.styleId, 'style-1'); assert.equal(restored.guests.styleName, '輕鬆聊天'); assert.equal(restored.guests.stylePrompt, '主持人多追問。'); assert.equal(JSON.stringify(restored.guests.referenceFiles), JSON.stringify(session.guests.referenceFiles)); assert.equal(restored.rounds[0].markdown, session.transcriptMarkdown);
});
integrationTest('Coffee Tables Markdown omits empty failed rounds while retaining the saved draft', async () => {
  const { CoffeeStorage } = load('experiences/coffee-tables/storage.ts', { obsidian }); const { app, files, contents } = fixture(); app.vault.getFiles = () => [...files.values()].filter(file => file instanceof TFile);
  const store = new CoffeeStorage(app.vault, 'Agent Workspace'), session = coffeeSession(); session.status = 'error'; session.rounds = [{ id: 'empty-1', markdown: '', notes: '', status: 'error', createdAt: session.createdAt }, { id: 'empty-2', markdown: '', notes: '', status: 'error', createdAt: session.createdAt }, { id: 'draft-3', markdown: '', notes: '', draftMarkdown: '### 主持人｜林岑\n草稿保留。', status: 'error', createdAt: session.createdAt }]; session.draftMarkdown = session.rounds[2].draftMarkdown;
  await store.save(session); const markdown = contents.get(store.sessionPath(session.id)); assert.doesNotMatch(markdown, /^## (?:Conversation part \d+|對談第 \d+ 段)$/m); assert.match(markdown, /Unfinished drafts|未完成草稿/); assert.match(markdown, /草稿保留/);
  const restored = await new CoffeeStorage(app.vault, 'Agent Workspace').load(session.id); assert.deepEqual(Array.from(restored.rounds, item => item.id), ["empty-1","empty-2","draft-3"]); assert.match(restored.draftMarkdown, /草稿保留/);
});
integrationTest('Coffee Tables titles produce safe Markdown names without replacing a same-title table', async () => {
  const { CoffeeStorage, topicSlug } = load('experiences/coffee-tables/storage.ts', { obsidian }); const { app, files, contents } = fixture(); app.vault.getFiles = () => [...files.values()].filter(file => file instanceof TFile);
  assert.equal(topicSlug('  AI / 工作？  '), 'AI 工作？');
  const store = new CoffeeStorage(app.vault, 'Agent Workspace'), first = coffeeSession(); first.topic = 'AI / 工作？'; await store.save(first);
  const second = coffeeSession(); second.topic = first.topic; await store.save(second);
  assert.match(store.sessionPath(first.id), /AI 工作？\.md$/); assert.match(store.sessionPath(second.id), /AI 工作？（2）\.md$/);
  const reopened = new CoffeeStorage(app.vault, 'Agent Workspace'); assert.equal((await reopened.load(store.sessionPath(first.id))).topic, first.topic);
  files.delete(store.sessionPath(first.id)); contents.delete(store.sessionPath(first.id)); assert.equal((await reopened.load(store.sessionPath(second.id))).id, second.id); assert.equal((await reopened.reload(store.sessionPath(second.id))).id, second.id);
});
integrationTest('Coffee Tables recovers a new table when interruption occurs between Markdown and sidecar writes', async () => {
  const { CoffeeStorage } = load('experiences/coffee-tables/storage.ts', { obsidian }); const { app, files, contents } = fixture(); app.vault.getFiles = () => [...files.values()].filter(file => file instanceof TFile);
  const store = new CoffeeStorage(app.vault, 'Agent Workspace'), session = coffeeSession(); session.transcriptMarkdown = '### 主持人｜林岑\n這是第一段完整對談。'; session.rounds = [{ id: 'round-a', markdown: session.transcriptMarkdown, notes: '', status: 'completed', createdAt: session.createdAt }];
  const process = app.vault.adapter.process; let writes = 0; app.vault.adapter.process = async (...args) => { if (++writes === 1) throw new Error('simulated interruption'); return process(...args); };
  await assert.rejects(store.save(session), /simulated interruption/);
  const markdownPath = store.path(session.id, session.topic), sidecarPath = store.sidecarPath(session.id); assert.ok(contents.has(markdownPath)); assert.match(contents.get(sidecarPath), /targetMarkdown/);
  const reopened = new CoffeeStorage(app.vault, 'Agent Workspace'); await reopened.recoverPendingCreates();
  assert.doesNotMatch(contents.get(sidecarPath), /targetMarkdown/); const loaded = await reopened.load(markdownPath); assert.match(loaded.transcriptMarkdown, /第一段完整對談/);
});

integrationTest('Coffee Tables stores same-topic sessions in native topic folders and moves legacy notes with their sidecar mapping', async () => {
  const { CoffeeStorage } = load('experiences/coffee-tables/storage.ts', { obsidian }); const { app, files, contents } = fixture(); app.vault.getFiles = () => [...files.values()].filter(file => file instanceof TFile);
  const store = new CoffeeStorage(app.vault, 'Agent Workspace', (file, target) => app.fileManager.renameFile(file, target));
  const first = coffeeSession(); first.status = 'completed'; first.transcriptMarkdown = '### 林岑｜主持人\n\n完整內容'; first.rounds = [{ id: 'r1', markdown: first.transcriptMarkdown, notes: '', status: 'completed', createdAt: first.createdAt }];
  await store.save(first); const firstPath = store.sessionPath(first.id); assert.match(firstPath, /Coffee Tables\/.+（[a-f0-9]{8}）\/.+\.md$/);
  const second = { ...coffeeSession(), id: 'coffee-second' }; await store.save(second); assert.equal(store.sessionPath(first.id).split('/').at(-2), store.sessionPath(second.id).split('/').at(-2));
  const original = app.vault.getAbstractFileByPath(firstPath), legacyPath = `${store.folder}/legacy.md`; await app.fileManager.renameFile(original, legacyPath);
  const sidePath = store.sidecarPath(first.id), side = JSON.parse(contents.get(sidePath)); side.filePath = legacyPath; contents.set(sidePath, JSON.stringify(side, null, 2));
  const upgrader = new CoffeeStorage(app.vault, 'Agent Workspace', (file, target) => app.fileManager.renameFile(file, target)); const moved = await upgrader.organizeExisting(); assert.equal(moved.moved, 1);
  assert.equal((await new CoffeeStorage(app.vault, 'Agent Workspace').load(first.id)).id, first.id);
});
integrationTest('Coffee Tables resolves a moved note with frontmatter and preserves an explicitly edited root title', async () => {
  const { CoffeeStorage } = load('experiences/coffee-tables/storage.ts', { obsidian }); const { app, files, contents } = fixture(); app.vault.getFiles = () => [...files.values()].filter(file => file instanceof TFile);
  const initial = new CoffeeStorage(app.vault, 'Agent Workspace', (file, target) => app.fileManager.renameFile(file, target)); const session = coffeeSession(); await initial.save(session);
  const originalPath = initial.sessionPath(session.id), originalFile = app.vault.getAbstractFileByPath(originalPath); contents.set(originalPath, `---\ntags: [coffee]\n---\n\n${contents.get(originalPath)}`);
  const movedPath = `${initial.folder}/renamed-note.md`; await app.fileManager.renameFile(originalFile, movedPath);
  const reopened = new CoffeeStorage(app.vault, 'Agent Workspace', (file, target) => app.fileManager.renameFile(file, target)); const restored = await reopened.load(session.id); assert.equal(restored.topic, session.topic);
  const edited = contents.get(movedPath).replace(`# ${session.topic}`, '# A title explicitly changed in Obsidian'); contents.set(movedPath, edited);
  const adopted = await reopened.reload(movedPath); assert.equal(adopted.topic, 'A title explicitly changed in Obsidian');
});
integrationTest('Coffee Tables startup move recovery does not clear a live FileManager move journal', async () => {
  const { CoffeeStorage } = load('experiences/coffee-tables/storage.ts', { obsidian }); const { app, files, contents } = fixture(); app.vault.getFiles = () => [...files.values()].filter(file => file instanceof TFile);
  const initial = new CoffeeStorage(app.vault, 'Agent Workspace', (file, target) => app.fileManager.renameFile(file, target)); const session = coffeeSession(); await initial.save(session); const current = initial.sessionPath(session.id), legacyPath = `${initial.folder}/moving-note.md`; await app.fileManager.renameFile(app.vault.getAbstractFileByPath(current), legacyPath); const sidePath = initial.sidecarPath(session.id), side = JSON.parse(contents.get(sidePath)); side.filePath = legacyPath; contents.set(sidePath, JSON.stringify(side, null, 2));
  const gate = deferred(), renameStarted = deferred(), store = new CoffeeStorage(app.vault, 'Agent Workspace', (file, target) => { renameStarted.resolve({ file, target }); return gate.promise.then(() => app.fileManager.renameFile(file, target)); }); const moving = store.organizeExisting(); const { target } = await renameStarted.promise; const staged = JSON.parse(contents.get(sidePath)); assert.ok(staged.moveJournal); await store.recoverMoves(); assert.ok(JSON.parse(contents.get(sidePath)).moveJournal); gate.resolve(); const result = await moving; assert.equal(result.moved, 1); assert.equal((await new CoffeeStorage(app.vault, 'Agent Workspace').load(target)).id, session.id);
});
integrationTest('Coffee Tables deletion waits for a safe archive and restores Markdown and hidden session state without overwrite', async () => {
  const { CoffeeStorage } = load('experiences/coffee-tables/storage.ts', { obsidian }); const { app, files, contents } = fixture(); app.vault.getFiles = () => [...files.values()].filter(file => file instanceof TFile);
  app.vault.delete = async file => { files.delete(file.path); contents.delete(file.path); }; app.vault.adapter.remove = async path => { files.delete(path); contents.delete(path); }; const store = new CoffeeStorage(app.vault, 'Agent Workspace', (file, target) => app.fileManager.renameFile(file, target), async file => app.vault.delete(file));
  const session = coffeeSession(); session.status = 'completed'; session.transcriptMarkdown = '### 林岑｜主持人\n\n保留對談'; session.rounds = [{ id: 'r1', markdown: session.transcriptMarkdown, notes: '', status: 'completed', createdAt: session.createdAt }]; await store.save(session);
  const originalPath = store.sessionPath(session.id), trashRecord = await store.delete(session.id); assert.equal(app.vault.getAbstractFileByPath(originalPath), undefined); assert.equal((await store.deletedTables()).length, 1); await assert.rejects(store.save(session), /was deleted/);
  const restoredPath = await store.restoreDeleted(trashRecord); assert.equal((await new CoffeeStorage(app.vault, 'Agent Workspace').load(restoredPath)).id, session.id); assert.match(await app.vault.read(app.vault.getAbstractFileByPath(restoredPath)), /保留對談/); const restoredSession = await store.load(restoredPath); restoredSession.updatedAt = new Date().toISOString(); await store.save(restoredSession);
  const other = { ...coffeeSession(), topic: 'Collision test topic' }; await store.save(other); const record = await store.delete(other.id); const parsed = JSON.parse(contents.get(record)); await app.vault.create(parsed.originalPath, '# occupied'); const collisionPath = await store.restoreDeleted(record); assert.notEqual(collisionPath, parsed.originalPath); assert.match(collisionPath, /（2）\.md$/);
  const retainedSidecar = { ...coffeeSession(), id: 'coffee-delete-retained', topic: 'Retained sidecar topic' }; await store.save(retainedSidecar); const retainedPath = store.sessionPath(retainedSidecar.id); const remove = app.vault.adapter.remove; app.vault.adapter.remove = async path => { if (path === store.sidecarPath(retainedSidecar.id)) throw new Error('simulated sidecar cleanup failure'); return remove(path); }; const retainedRecord = await store.delete(retainedSidecar.id); assert.equal((await store.deletedTables()).some(item => item.path === retainedRecord), true); await app.vault.create(retainedPath, '# collision'); const retainedRestored = await store.restoreDeleted(retainedRecord); const reopenedRetained = await new CoffeeStorage(app.vault, 'Agent Workspace').load(retainedRestored); assert.equal(reopenedRetained.id, retainedSidecar.id); assert.equal(JSON.parse(contents.get(store.sidecarPath(retainedSidecar.id))).filePath, retainedRestored);
  const interrupted = { ...coffeeSession(), id: 'coffee-delete-interrupted', topic: 'Interrupted trash metadata' }; await store.save(interrupted); const process = app.vault.adapter.process; let failedOnce = false; app.vault.adapter.process = async (path, fn) => { if (!failedOnce && path.includes('/.sessions/trash/')) { failedOnce = true; throw new Error('simulated archive status interruption'); } return process(path, fn); }; const interruptedRecord = await store.delete(interrupted.id); app.vault.adapter.process = process; assert.equal(JSON.parse(contents.get(interruptedRecord)).trashed, false); assert.equal((await store.deletedTables()).some(item => item.path === interruptedRecord), true); const interruptedPath = await store.restoreDeleted(interruptedRecord); assert.equal((await new CoffeeStorage(app.vault, 'Agent Workspace').load(interruptedPath)).id, interrupted.id);
  const partial = { ...coffeeSession(), id: 'coffee-restore-interrupted', topic: 'Interrupted restore' }; await store.save(partial); const partialRecord = await store.delete(partial.id); const processRestore = app.vault.adapter.process; let restoreFailed = false; app.vault.adapter.process = async (path, fn) => { if (!restoreFailed && path === store.sidecarPath(partial.id)) { restoreFailed = true; throw new Error('simulated sidecar restore interruption'); } return processRestore(path, fn); }; await assert.rejects(store.restoreDeleted(partialRecord), /simulated sidecar restore interruption/); app.vault.adapter.process = processRestore; const journal = JSON.parse(contents.get(partialRecord)).restoreJournal; assert.ok(journal.targetPath); const partialRestored = await store.restoreDeleted(partialRecord); assert.equal(partialRestored, journal.targetPath); assert.equal((await new CoffeeStorage(app.vault, 'Agent Workspace').load(partialRestored)).id, partial.id);
});
integrationTest('Coffee Tables delete archives the latest hidden state if it changes during the trash callback', async () => {
  const { CoffeeStorage } = load('experiences/coffee-tables/storage.ts', { obsidian }); const { app, files, contents } = fixture(); app.vault.getFiles = () => [...files.values()].filter(file => file instanceof TFile); app.vault.adapter.remove = async path => { files.delete(path); contents.delete(path); };
  const session = coffeeSession(); session.status = 'completed'; const sidePath = `Agent Workspace/Coffee Tables/.sessions/${session.id}.json`; const store = new CoffeeStorage(app.vault, 'Agent Workspace', (file, target) => app.fileManager.renameFile(file, target), async file => { const side = JSON.parse(contents.get(sidePath)); side.updatedAt = '2026-09-30T12:00:00.000Z'; contents.set(sidePath, JSON.stringify(side, null, 2)); files.delete(file.path); contents.delete(file.path); }); await store.save(session);
  const recordPath = await store.delete(session.id), record = JSON.parse(contents.get(recordPath)); assert.equal(JSON.parse(record.sidecar).updatedAt, '2026-09-30T12:00:00.000Z'); assert.equal((await store.deletedTables()).length, 1);
});
integrationTest('Coffee Tables v2 migration backs up the source, writes clean Markdown and is idempotent', async () => {
  const { CoffeeStorage } = load('experiences/coffee-tables/storage.ts', { obsidian }); const { app, files, contents } = fixture(); app.vault.getFiles = () => [...files.values()].filter(file => file instanceof TFile);
  const id = 'coffee-v2-recoverable', topic = '舊版桌聊主題', path = `Agent Workspace/Coffee Tables/${id}.md`, createdAt = '2026-09-29T00:00:00.000Z';
  await app.vault.createFolder('Agent Workspace'); await app.vault.createFolder('Agent Workspace/Coffee Tables');
  const legacy = { version: 2, id, topic, language: 'zh-TW', model: 'test-model', reasoning: 'low', createdAt, updatedAt: createdAt, status: 'completed', transcriptMarkdown: '', questions: [], guests: { perspectives: ['experts'], background: '客服' } };
  const source = `# ${topic}\n\n<!-- coffee-tables-data:${encodeURIComponent(JSON.stringify(legacy))} -->\n\n## 對談\n\n### 主持人｜林岑\n\n保留這段原始對談。\n\n<!-- coffee-tables-transcript-end:${id} -->\n\n<!-- coffee-tables-draft-start:${id} -->\n\n### 主持人｜續聊\n\n保留這段舊草稿。\n\n<!-- coffee-tables-draft-end:${id} -->`;
  const oldFile = await app.vault.create(path, source); const store = new CoffeeStorage(app.vault, 'Agent Workspace', (file, next) => app.fileManager.renameFile(file, next)); const migrated = await store.load(path);
  assert.equal(migrated.version, 3); assert.match(migrated.transcriptMarkdown, /保留這段原始對談/); assert.match(migrated.draftMarkdown, /保留這段舊草稿/); assert.equal(migrated.guests.counts.experts, 4);
  const backup = contents.get(`${store.hidden}/backups/${id}-v2.md`); assert.equal(backup, source); assert.doesNotMatch(contents.get(store.sessionPath(id)), /coffee-tables-data/);
  const again = await new CoffeeStorage(app.vault, 'Agent Workspace').load(store.sessionPath(id)); assert.equal(again.id, id); assert.equal(oldFile.path, store.sessionPath(id)); assert.notEqual(oldFile.path, path); assert.equal([...files.keys()].filter(item => item.endsWith(`${id}-v2.md`)).length, 1);
});
test('Coffee Tables speaker parser creates stable roster and speech identities and ignores note headings', () => {
  const { parseGuests, parseSpeeches } = load('experiences/coffee-tables/view.ts', { obsidian });
  const markdown = '- **主持人 甲｜林岑**：抓矛盾\n- **Xiao Yun｜Customer-support lead**: Frontline work\n\n### 林岑｜主持人\n你說要自動化，責任歸誰？\n\n### Xiao Yun｜Customer-support lead\n工作量沒有減少。\n\n# 觀察者整理\n## 主要轉折\n### 假設一\n不是來賓';
  assert.deepEqual(plain(parseGuests(markdown)), [{ name: '林岑', role: '主持人 甲', bio: '抓矛盾' }, { name: 'Xiao Yun', role: 'Customer-support lead', bio: 'Frontline work' }]);
  assert.deepEqual(plain(parseSpeeches(markdown)), [{ name: '林岑', role: '主持人', text: '你說要自動化，責任歸誰？' }, { name: 'Xiao Yun', role: 'Customer-support lead', text: '工作量沒有減少。' }]);
});
integrationTest('Coffee Tables engine survives view closure and reopening without starting a duplicate request', async () => {
  const pending = deferred(); let calls = 0, saved = [];
  const manager = new coffee.CoffeeManager(async request => { calls++; request.onText?.('Live draft'); return pending.promise; }, async value => { saved.push(plain(value)); });
  const session = coffeeSession(), firstViewEngine = manager.open(session), task = firstViewEngine.start(); await until(() => calls === 1 && firstViewEngine.session.draftMarkdown === 'Live draft');
  const reopenedViewEngine = manager.open(session); assert.equal(reopenedViewEngine, firstViewEngine); assert.equal(calls, 1);
  pending.resolve('### 主持人｜主持人\n\nComplete conversation\n\n# 觀察者整理\n\n## 最大討論轉折\n- A\n## 被推翻或修正的假設\n- B\n## 值得繼續追問的問題\n- C\n## 尚未解決的核心分歧\n- D'); await task; assert.equal(manager.open(firstViewEngine.session).session.status, 'completed'); assert.equal(calls, 1); assert.match(saved.at(-1).transcriptMarkdown, /Complete conversation/);
});
test('Coffee Tables outline parses localized headings, wrapped bullets and nested list detail without treating code as structure', () => {
  assert.ok(fs.existsSync(path.join(root, 'experiences/coffee-tables/outline.ts')), 'Coffee Tables outline logic module exists');
  const { parseCoffeeOutline } = load('experiences/coffee-tables/outline.ts');
  const notes = '# 觀察者整理\n\n## 意外連結\n- **創作價值**與勞動條件相連，\n  速度未必讓人得到更多自由。 <!-- source: AI 工具讓創作者產出更快，卻沒有得到更多自由時間。 -->\n  - 也要查看接案者的修改成本。\n\n## Questions worth pursuing\n- Can creators refuse training use?\n\n```md\n## fake section\n- fake item\n```';
  const parsedNotes = parseCoffeeOutline(notes);
  assert.equal(parsedNotes[0].items[0].sourceText, 'AI 工具讓創作者產出更快，卻沒有得到更多自由時間。');
  assert.doesNotMatch(parsedNotes[0].items[0].text, /source:/);
  const { findRelatedSpeech } = load('experiences/coffee-tables/outline.ts');
  assert.equal(findRelatedSpeech(parsedNotes[0].items[0].sourceText, [{ id: 'source-speech', text: 'AI 工具讓創作者產出更快，卻沒有得到更多自由時間。', order: 5 }]), 'source-speech');
  assert.deepEqual(plain(parsedNotes), [
    { id: 'section-0', title: '意外連結', depth: 2, items: [
      { id: 'section-0-item-0', text: '創作價值與勞動條件相連，速度未必讓人得到更多自由。', sourceText: 'AI 工具讓創作者產出更快，卻沒有得到更多自由時間。', context: '也要查看接案者的修改成本。', depth: 0 },
    ] },
    { id: 'section-1', title: 'Questions worth pursuing', depth: 2, items: [
      { id: 'section-1-item-0', text: 'Can creators refuse training use?', depth: 0 },
    ] },
  ]);
});
test('Coffee Tables outline matching finds the strongest related Chinese speech and refuses ambiguous or generic matches', () => {
  assert.ok(fs.existsSync(path.join(root, 'experiences/coffee-tables/outline.ts')), 'Coffee Tables outline logic module exists');
  const { findRelatedSpeech } = load('experiences/coffee-tables/outline.ts');
  const targets = [
    { id: 'dialogue-1', text: 'AI工具讓作品生產更快，卻沒有證據顯示創作者因此得到更多自由時間。', order: 0 },
    { id: 'dialogue-2', text: '稿酬降低可能和接案工作者需要反覆修改作品有關。', order: 1 },
    { id: 'dialogue-3', text: '要再觀察使用者是否真的理解作品。', order: 2 },
  ];
  assert.equal(findRelatedSpeech('自動化產出更快，創作者仍沒有因此得到更多自由時間。', targets), 'dialogue-1');
  assert.equal(findRelatedSpeech('加價午餐不只涉及食物，也像公共運輸的差別定價，牽涉基本服務與額外選擇的界線。', [
    { id: 'analogy', text: '公共運輸有時會讓乘客加價買更舒適的座位，這跟午餐有一點相似：都是在基本服務之外提供選擇。但限制也很明顯，交通座位比較像個人使用；孩子一起吃飯時，食物差異會直接變成同儕之間看得見的差距。', order: 0 },
    { id: 'other', text: '學校必須先保障基本營養，不能把過敏或醫療需求當成額外選擇。', order: 1 },
  ]), 'analogy');
  assert.equal(findRelatedSpeech('產出速度和創作人自由時間的關係', [
    { id: 'first', text: 'AI提高產出速度，也未增加創作者的自由時間。', order: 0 },
    { id: 'second', text: 'AI提升產出速度，也未增加創作者的休閒時間。', order: 1 },
  ]), 'first');
  assert.equal(findRelatedSpeech('先用 MIT、之後改授權聽起來簡單，但外部貢獻者的著作權會讓未來的選擇更複雜。', [
    { id: 'license-question', text: '那如果我不確定未來會不會做雲端服務，是不是先 MIT，之後有人拿去做 SaaS 再改 AGPL 就好？', order: 0 },
    { id: 'license-rights', text: '你通常可以對未來版本改授權，但已經用舊版本的人仍按舊授權使用；若程式有外部貢獻，還得確認你有權這麼做。', order: 1 },
    { id: 'license-followup', text: '以後改授權不是完全不行，但不會把舊版本的使用權收回來；開始接受外部貢獻後，還多一層權利確認。', order: 2 },
  ]), 'license-followup');
  assert.equal(findRelatedSpeech('加速產出之後創作者仍沒有更多自由時間', [
    { id: 'one', text: 'AI加快產出，但創作者沒有得到更多自由時間。', order: 0 },
    { id: 'two', text: 'AI加速產出，創作者仍沒有得到更多自由時間。', order: 1 },
  ]), null);
  assert.equal(findRelatedSpeech('意外連結', targets), null);
  assert.equal(findRelatedSpeech('作品生產速度更快', [
    { id: 'earlier', text: '作品生產速度更快。', order: 0 },
    { id: 'later', text: '作品生產速度更快。', order: 1 },
  ]), 'earlier');
  assert.equal(findRelatedSpeech('今天摘要要討論親子講座如何安排時間', [
    { id: 'short-phrase', text: '親子講座', order: 0 },
  ]), null);
});
test('Coffee Tables deletion locks every view of a shared manager engine and retires it after removal', async () => {
  let calls = 0; const manager = new coffee.CoffeeManager(async () => { calls++; return 'not expected'; }, async () => {}); const session = coffeeSession(); session.status = 'completed'; const first = manager.open(session), second = manager.open(session); assert.equal(first, second);
  const locked = await manager.prepareDelete(session.id); await Promise.all([second.continueTable(), second.ask('continue?')]); assert.equal(calls, 0); assert.equal(manager.get(session.id), first); manager.completeDelete(session.id, locked); await Promise.all([first.start(), second.continueTable(), second.ask('late?')]); assert.equal(first.deleted, true); assert.equal(manager.get(session.id), undefined); assert.equal(calls, 0); assert.throws(() => manager.open(session), /being deleted or was deleted/); manager.restore(session.id); assert.equal(manager.open(session).session.id, session.id);
  const uncached = { ...coffeeSession(), id: 'uncached-delete-id' }; await manager.prepareDelete(uncached.id); assert.throws(() => manager.open(uncached), /being deleted or was deleted/); manager.cancelDelete(uncached.id, undefined); assert.equal(manager.open(uncached).session.id, uncached.id);
});
test('Coffee Tables copies legacy sessions without rewriting the source', () => {
  const legacy = { version: 1, id: 'old-session', topic: '舊桌', language: 'zh-TW', model: 'm', reasoning: 'low', createdAt: '2026-01-01', updatedAt: '2026-01-01', status: 'completed', participants: [{ id: 'host-a', name: '小安', role: '主持人', lens: '好奇' }], messages: [{ id: 'm1', speakerId: 'host-a', text: '保留這句', replyTo: null, move: 'opening', targetId: null, createdAt: '2026-01-01' }], nextSpeakerId: 'host-a', segmentStart: 0, notes: null, endReason: 'natural' };
  const copy = coffeeTypes.copyLegacySession(legacy);
  assert.equal(copy.version, 3); assert.match(copy.transcriptMarkdown, /保留這句/); assert.notEqual(copy.id, legacy.id); assert.equal(legacy.version, 1);
});
integrationTest('Coffee Tables provider adapter uses plain text while preserving model, reasoning, logging and cancellation', async () => {
  const { default: Plugin } = load('main.ts', { obsidian });
  for (const model of ['test-codex', 'claude:sonnet']) {
    const plugin = new Plugin(); plugin.app = { vault: { adapter: new obsidian.FileSystemAdapter() } }; plugin.manifest = { dir: 'plugin' }; plugin.settings.aiExchangeLoggingEnabled = true;
    const events = []; plugin.exchanges = Object.fromEntries(['begin', 'sent', 'received', 'completed', 'failed'].map(key => [key, (...args) => events.push([key, ...args])]));
    const runTask = async (_prompt, actualModel, effort, schema, controls) => { assert.equal(effort, 'high'); assert.equal(schema, undefined); assert.equal(controls.searchBudget, 0); assert.equal(actualModel, model === 'claude:sonnet' ? 'sonnet' : model); controls.onRequest({ prompt: 'plain text' }); return '完整 Markdown'; };
    plugin.runtime = (_directory, local) => { assert.equal(local, true); return { runTask }; }; plugin.claudeCli = () => ({ runTask });
    const request = { session: { ...coffeeSession(), model, reasoning: 'high' }, prompt: 'coffee prompt', signal: new AbortController().signal };
    assert.equal(await plugin.runCoffeeRequest(request), '完整 Markdown'); assert.deepEqual(events.map(event => event[0]), ['begin', 'sent', 'received', 'completed']); assert.equal(plugin.activeTasks.size, 0);
    const abort = new AbortController(); abort.abort(); await assert.rejects(plugin.runCoffeeRequest({ ...request, signal: abort.signal }), /cancelled/);
  }
});
function coffeeElement(tag, options = {}) {
  return { tag, cls: options.cls ?? '', querySelectorAll(selector) { const result = []; const visit = node => { for (const child of node.children) { if (selector.startsWith('.') ? child.cls.split(' ').includes(selector.slice(1)) : child.tag === selector) result.push(child); visit(child); } }; visit(this); return result; }, text: options.text ?? '', value: options.value ?? '', children: [], disabled: false, attrs: options.attr ?? {}, get options() { return this.children.filter(child => child.tag === 'option' || child.value !== undefined); },
    createDiv(value) { const element = coffeeElement('div', typeof value === 'string' ? { cls: value } : value); this.children.push(element); return element; },
    createEl(name, value) { const element = coffeeElement(name, value); this.children.push(element); return element; }, createSpan(value) { const element = coffeeElement('span', value); this.children.push(element); return element; }, addClass() {}, toggleClass() {}, removeClass() {}, setText(value) { this.text = value; }, empty() { this.children = []; }, focus() {}, remove() { this.removed = true; },
    add(option) { this.children.push(option); }, replaceChildren(...children) { this.children = children; },
    classList: { add() {}, toggle() {} }, dataset: {},
    setAttribute(name, value) { this.attrs[name] = value; },
    addEventListener(name, handler) { this[name] = handler; }, get childElementCount() { return this.children.length; } };
}
const coffeeFind = (root, predicate) => predicate(root) ? root : root.children.map(child => coffeeFind(child, predicate)).find(Boolean);
function withCoffeeModelDiscovery(plugin, models) {
  const states = {
    codex: { provider: 'codex', status: 'ready', models: models.filter(model => !model.startsWith('claude:')) },
    claude: { provider: 'claude', status: 'ready', models: models.filter(model => model.startsWith('claude:')) }
  };
  const listeners = new Set();
  plugin.availableModels = () => [...new Set([...states.codex.models, ...states.claude.models])];
  plugin.modelLabel = plugin.modelLabel ?? (model => model);
  plugin.modelDiscoveryState = provider => ({ ...states[provider], models: [...states[provider].models] });
  plugin.subscribeModelDiscovery = listener => { listeners.add(listener); return () => listeners.delete(listener); };
  plugin.refreshModelDiscovery = async provider => { const state = plugin.modelDiscoveryState(provider); for (const listener of listeners) listener(state); return state; };
  plugin.refreshCoffeeModels = plugin.refreshCoffeeModels ?? (async () => plugin.availableModels());
  plugin.coffeeReasoningEfforts = plugin.coffeeReasoningEfforts ?? (model => model.startsWith('claude:') ? ['low', 'medium', 'high'] : []);
  return plugin;
}
integrationTest('Coffee Tables puts saved-draft recovery in the pinned room toolbar', () => {
  const { CoffeeTablesView } = load('experiences/coffee-tables/view.ts', { obsidian }, { requestAnimationFrame: callback => callback() });
  const session = coffeeSession(); session.status = 'error'; session.draftMarkdown = '### 主持人｜林岑\n\n已收到的對談。'; session.rounds = [{ id: 'failed-round', markdown: '', notes: '', draftMarkdown: session.draftMarkdown, status: 'error', createdAt: session.createdAt }];
  const plugin = { settings: { language: 'zh-TW' }, modelLabel: value => value, confirmAiUsage: async (_model, run) => run() };
  const view = new CoffeeTablesView({ app: { workspace: { requestSaveLayout() {} } } }, plugin); view.engine = { session, busy: false, persistenceFailed: false, error: 'observer summary incomplete' }; view.store = { sessionPath: () => 'failed.md' }; view.contentEl = coffeeElement('root'); view.contentEl.ownerDocument = { activeElement: null }; view.contentEl.querySelector = () => null; view.contentEl.querySelectorAll = () => [];
  view.renderRound = () => {}; view.renderMarkdown = () => {}; view.renderRoster = () => {}; view.updateStatus = () => {};
  view.render();
  const fixed = view.contentEl.children[0].children[0];
  const header = fixed.children[0], actions = header.children[1];
  assert.equal(header.children[0].tag, 'h2');
  assert.equal(actions.tag, 'div');
  assert.deepEqual(actions.children.map(item => item.text), ['回主頁', '開啟 Markdown', '刪除桌聊', '開新桌']);
  assert.equal(header.children[2].tag, 'p');
  assert.ok(coffeeFind(fixed, item => item.tag === 'button' && item.text === '從已保存草稿繼續'));
});
integrationTest('Coffee Tables home form keeps discovered model and reasoning choices and disables start during discovery', async () => {
  const { CoffeeTablesView } = load('experiences/coffee-tables/view.ts', { obsidian });
  const plugin = withCoffeeModelDiscovery({ settings: { language: 'en', cliModel: 'm', cliReasoning: 'low' }, coffeeReasoningEfforts: model => model === 'm' ? ['low'] : ['medium', 'high'], refreshCoffeeModels: async () => ['m', 'codex-other'], confirmAiUsage: async (_model, run) => run() }, ['m', 'codex-other']);
  const view = new CoffeeTablesView({ app: {} }, plugin); view.contentEl = coffeeElement('root'); view.store = { cleanupEmptyTopicFolders: async () => {}, list: () => [] }; await view.home();
  const selects = []; const visit = node => { if (node.tag === 'select') selects.push(node); node.children.forEach(visit); }; visit(view.contentEl);
  await until(() => !selects[0].disabled); assert.deepEqual(selects[0].children.map(option => option.value), ['m', 'codex-other']);
  assert.deepEqual(selects[1].children.map(option => option.value), ['auto', 'low']);
  const summaries = []; const findSummaries = node => { if (node.tag === 'summary') summaries.push(node.text); node.children.forEach(findSummaries); }; findSummaries(view.contentEl); assert.ok(summaries.some(text => /Adjust this table · m · 2 hosts \+ 7 guests/.test(text)));
  selects[0].value = 'codex-other'; selects[0].change(); assert.deepEqual(selects[1].children.map(option => option.value), ['auto', 'medium', 'high']);
});
integrationTest('Coffee Tables explicit return home cannot be overridden by a delayed saved session state', async () => {
  const { CoffeeTablesView } = load('experiences/coffee-tables/view.ts', { obsidian }); let loads = 0, saves = 0;
  const plugin = { ready: Promise.resolve(), settings: {}, coffeeStorage: {} };
  const view = new CoffeeTablesView({ app: { workspace: { requestSaveLayout: () => saves++ } } }, plugin); view.store = {}; view.home = async () => { view.engine = null; }; view.loadSession = async () => { loads++; };
  view.returnHome(); await view.setState({ sessionId: 'previous-session' }, { history: false });
  assert.equal(loads, 0); assert.equal(saves, 1);
  const restored = new CoffeeTablesView({ app: { workspace: { requestSaveLayout() {} } } }, plugin); restored.store = {}; restored.loadSession = async () => { loads++; };
  await restored.setState({ sessionId: 'saved-session' }, { history: false }); assert.equal(loads, 1);
});
integrationTest('Coffee Tables stale external-conflict loads cannot override a newer room selection', async () => {
  const { CoffeeTablesView } = load('experiences/coffee-tables/view.ts', { obsidian }), oldLoad = { promise: null, reject: null }, newLoad = deferred(), stopPending = deferred(); oldLoad.promise = new Promise((_resolve, reject) => { oldLoad.reject = reject; }); let stopCalled = false, attached = []; const session = { ...coffeeSession(), status: 'completed' };
  const cached = { busy: true, session, stop: async () => { stopCalled = true; await stopPending.promise; }, reportPersistenceError() {} }; const plugin = { coffeeManager: { get: () => cached } };
  const view = new CoffeeTablesView({ app: {} }, plugin); view.store = { load: path => path === 'old.md' ? oldLoad.promise : newLoad.promise, inspect: async () => session }; view.attach = value => attached.push(value.topic);
  const older = view.loadSession('old.md'); oldLoad.reject(new Error('changed outside the room')); await until(() => stopCalled); const newer = view.loadSession('new.md'); stopPending.resolve(); await older; assert.deepEqual(attached, []); newLoad.resolve(session); await newer; assert.deepEqual(attached, [session.topic]);
});

integrationTest('Coffee Tables historical preview cancels a pending generating-room navigation', async () => {
  const { CoffeeTablesView } = load('experiences/coffee-tables/view.ts', { obsidian });
  let delayedRoom = deferred(); const completed = { ...coffeeSession(), id: 'done', topic: 'History topic', status: 'completed', transcriptMarkdown: '', rounds: [], observerNotes: [] };
  const generating = { ...coffeeSession(), id: 'running', topic: 'Running topic', status: 'generating', transcriptMarkdown: '', rounds: [], observerNotes: [] };
  const plugin = withCoffeeModelDiscovery({ settings: { language: 'en', cliModel: 'm', cliReasoning: 'low', workspaceFolder: 'workspace' }, coffeeReasoningEfforts: () => ['low'], refreshCoffeeModels: async () => ['m'], confirmAiUsage: async (_model, run) => run(), coffeeManager: { get: id => id === generating.id ? { busy: true, session: generating } : undefined } }, ['m']);
  const view = new CoffeeTablesView({ app: { workspace: { requestSaveLayout() {} } } }, plugin); view.contentEl = coffeeElement('root');
  view.store = { cleanupEmptyTopicFolders: async () => {}, recoverPendingCreates: async () => {}, list: () => [{ path: 'running.md', extension: 'md', basename: 'Running topic', stat: { ctime: 1, mtime: 1 } }, { path: 'done.md', extension: 'md', basename: 'History topic', stat: { ctime: 1, mtime: 1 } }], inspectReadOnly: async path => path === 'done.md' ? completed : generating, load: () => delayedRoom.promise };
  const attached = []; view.attach = session => attached.push(session.id); await view.home();
  const findButton = text => coffeeFind(view.contentEl, element => element.tag === 'button' && (element.text.includes(text) || element.children.some(child => child.text.includes(text))));
  await until(() => findButton('Running topic')); const runningButton = findButton('Running topic'); assert.ok(runningButton); runningButton.click(); await Promise.resolve();
  const historyButton = findButton('History topic'); assert.ok(historyButton); historyButton.click(); await until(() => findButton('Enter this table'));
  delayedRoom.resolve(generating); await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(attached, []);
  delayedRoom = deferred(); findButton('Enter this table').click(); await Promise.resolve(); findButton('Open new table').click(); delayedRoom.resolve(completed); await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(attached, []);
});

integrationTest('Coffee Tables VAM handoff preserves insight snapshots and requires editable confirmation', async () => {
  const fixtureData = await reframingModalFixture(); const {modal,repo,store,contents,session,path,plugin} = fixtureData;
  const before = contents.get(path), sideBefore=contents.get(store.sidecarPath(session.id));
  assert.equal((await repo.mapFiles()).length,0);
  const question=coffeeFind(modal.contentEl,e=>e.attrs['aria-label']==='Research question'); question.value='Which evidence would distinguish access from affordability?';
  const create=coffeeFind(modal.contentEl,e=>e.text==='Create research map'); create.onclick(); create.onclick();
  await until(()=>fixtureData.opened.length===1);
  const map=await repo.readMap(fixtureData.opened[0]); assert.equal(map.nodes.length,1);
  const note=await repo.readNote(map.nodes[0].path); assert.match(note.detail,/Candidate/); assert.match(note.thinkingOrigin,/Important limits/); assert.match(note.thinkingOrigin,/coffee-tables/); assert.equal(note.model,session.model); assert.equal(plugin.running.size,0);
  assert.equal(contents.get(path),before);assert.equal(contents.get(store.sidecarPath(session.id)),sideBefore); assert.equal((await repo.mapFiles()).length,1);
});

test('product ribbon pins both entrances below other actions and cleans up on unload', () => {
  let observer;
  class Observer {
    constructor(callback) { this.callback = callback; observer = this; }
    observe() { this.connected = true; }
    disconnect() { this.connected = false; }
    moved(node) { if (this.connected) this.callback([{ addedNodes: [node] }]); }
  }
  const parent = {
    children: [],
    classList: { add() {}, remove() {} },
    get lastElementChild() { return this.children.at(-1); },
    appendChild(icon) { this.insertBefore(icon, null); },
    insertBefore(icon, next) {
      this.children = this.children.filter(child => child !== icon);
      const index = next ? this.children.indexOf(next) : this.children.length;
      this.children.splice(index, 0, icon); icon.parentElement = this;
    }
  };
  const make = name => ({
    name, parentElement: parent,
    classList: { values: new Set(), add(...names) { names.forEach(n => this.values.add(n)); }, remove(...names) { names.forEach(n => this.values.delete(n)); } },
    get nextSibling() { return parent.children[parent.children.indexOf(this) + 1] || null; },
    get nextElementSibling() { return this.nextSibling; }
  });
  const before = make('before'), coffee = make('coffee'), other = make('other'), map = make('map');
  parent.children = [before, coffee, other, map];
  const { groupRibbonIcons } = load('ui/ribbon-group.ts', {}, { MutationObserver: Observer });
  const stop = groupRibbonIcons(map, coffee);
  assert.deepEqual(parent.children.map(x => x.name), ['before', 'other', 'map', 'coffee']);
  assert.ok(map.classList.values.has('vam-ribbon-group-start'));
  assert.ok(coffee.classList.values.has('vam-ribbon-group-end'));
  parent.insertBefore(coffee, before); observer.moved(coffee);
  assert.deepEqual(parent.children.map(x => x.name), ['before', 'other', 'map', 'coffee']);
  parent.insertBefore(map, null); observer.moved(map);
  assert.deepEqual(parent.children.map(x => x.name), ['before', 'other', 'map', 'coffee']);
  parent.children = parent.children.filter(x => x !== coffee); coffee.parentElement = null;
  observer.moved(other);
  assert.ok(map.classList.values.has('vam-ribbon-group-start'));
  assert.ok(map.classList.values.has('vam-ribbon-group-end'));
  parent.insertBefore(coffee, before); observer.moved(coffee);
  assert.equal(map.nextElementSibling, coffee);
  stop();
  assert.equal(observer.connected, false);
  assert.equal(map.classList.values.size, 0);
  assert.equal(coffee.classList.values.size, 0);
});

integrationTest('Coffee Tables streaming restores scroll after asynchronous Markdown and preserves user scrolling', async () => {
  const { CoffeeTablesView } = load('experiences/coffee-tables/view.ts', { obsidian }, { requestAnimationFrame: callback => callback() });
  const session = coffeeSession(); session.status = 'generating'; session.draftMarkdown = 'A growing dialogue';
  const view = new CoffeeTablesView({ app: {} }, { settings: { language: 'en' } });
  view.engine = { session }; view.renderRoster = () => {};
  const scrolling = { scrollTop: 400, scrollHeight: 1000, clientHeight: 300, isConnected: true };
  const draft = { style: {}, setCssProps() {}, addClass() { this.style.minHeight = "900px"; }, removeClass() { this.style.minHeight = ""; }, offsetHeight: 900, empty() { scrolling.scrollHeight = 500; } };
  view.contentEl = { querySelector: selector => selector === '.ct-chat-scroll' ? scrolling : selector === '.ct-live-draft' ? draft : null };
  let pending = deferred();
  view.renderRound = () => { view.markdownJobs.push(pending.promise.then(() => { scrolling.scrollHeight = 1200; })); };
  view.refreshLive();
  pending.resolve(); await until(() => draft.style.minHeight === '');
  assert.equal(scrolling.scrollTop, 400);
  scrolling.scrollTop = 900; pending = deferred(); view.refreshLive();
  scrolling.scrollTop = 650; view.scrollEpoch++; pending.resolve(); await until(() => draft.style.minHeight === '');
  assert.equal(scrolling.scrollTop, 650);
});

integrationTest('Coffee Tables accepts complete bold observer headings and prose with hidden source comments', async () => {
  const sections = ['意外連結', '值得繼續想的問題', '核心分歧', '探索方向', '值得查證的假設'];
  const notes = sections.map(title => `**## ${title}**\n\n共同規則有助於避免任意，但可能忽略處境差異，仍需要確認實際使用情況。<!-- source: 共同規則可能把差異藏起來。 -->`).join('\n\n');
  const response = `### 林予安｜主持人\n\n共同規則可能把差異藏起來。\n\n### 陳敬文｜中立觀察者\n\n${notes}\n\n<!-- coffee-tables-complete -->`;
  const engine = new coffee.CoffeeEngine(coffeeSession(), async () => response, async () => {});
  await engine.start();
  assert.equal(engine.session.status, 'completed');
  assert.doesNotMatch(engine.session.transcriptMarkdown, /核心分歧/);
  assert.match(engine.session.observerNotes[0], /^# 觀察者整理/);
  const { parseCoffeeOutline } = load('experiences/coffee-tables/outline.ts');
  const outline = parseCoffeeOutline(engine.session.observerNotes[0]);
  assert.equal(outline.length, 5);
  assert.equal(outline[0].items[0].sourceText, '共同規則可能把差異藏起來。');
  const stopped = coffeeSession(); stopped.status = 'stopped'; stopped.draftMarkdown = response;
  const reopened = new coffee.CoffeeEngine(stopped, async () => { assert.fail('Complete stopped draft must recover without AI'); }, async () => {});
  await reopened.start(); assert.equal(reopened.session.status, 'completed');
});


test('Coffee Tables restored visible built-in insights apply in all four modes without constraining custom styles', () => {
  for (const language of ['zh-TW', 'en']) {
    const session = coffeeSession(); session.language = language;
    session.guests.stylePrompt = language === 'zh-TW' ? coffeePrompts.BUILTIN_COFFEE_STYLE_PROMPT : coffeePrompts.BUILTIN_COFFEE_STYLE_PROMPT_EN;
    session.transcriptMarkdown = 'Earlier important exchange'; session.observerNotes = ['# 觀察者整理\n\n## 核心分歧\n\n- Earlier valuable insight: the exchange showed a concrete unresolved tradeoff.'];
    session.guests.referenceFiles = [{ name: 'context.md', content: 'Reference background' }];
    const prompts = [coffeePrompts.tablePrompt(session.topic, language, session.guests), coffeePrompts.tablePrompt(session.topic, language, session.guests, 'Saved draft', coffeePrompts.assembleCoffeeContext(session)), coffeePrompts.questionPrompt(session, 'New question'), coffeePrompts.observerOnlyPrompt(session)];
    for (const prompt of prompts) {
      assert.match(prompt, /原本五類每類整理 2–4|2–4 distinct, substantive insights in each of the first five categories/);
      assert.match(prompt, /沒有重新輸出的舊項目會由程式保留|the program retains old items you do not rewrite/); assert.match(prompt, /整合完整對談|use the complete saved conversation/);
      assert.match(prompt, /context.md/);
      assert.match(prompt, /程式會保留未提及項目|the program retains old items you do not rewrite/);
    }
    for (const prompt of prompts.slice(1)) { assert.match(prompt, /Earlier important exchange/); assert.match(prompt, /Earlier valuable insight/); }
    session.guests.stylePrompt = 'User-authored style only';
    for (const prompt of [coffeePrompts.tablePrompt(session.topic, language, session.guests), coffeePrompts.questionPrompt(session, 'Question'), coffeePrompts.observerOnlyPrompt(session)]) assert.doesNotMatch(prompt, /原本五類每類整理 2–4|2–4 distinct, substantive insights in each of the first five categories/);
  }
});
integrationTest('Coffee Tables token timestamps repaint live regions instead of rebuilding the reading pane', async () => {
  const { CoffeeTablesView } = load('experiences/coffee-tables/view.ts', { obsidian });
  const session = coffeeSession(); session.status = 'generating'; let renders = 0, live = 0;
  const view = new CoffeeTablesView({ app: {} }, { settings: {} }); view.engine = { session, busy: true, error: '' }; view.render = () => renders++; view.refreshLive = () => live++;
  view.refresh(); session.updatedAt = 'later-token'; view.refresh(); await new Promise(resolve => setTimeout(resolve, 300)); assert.equal(live, 1); assert.equal(renders, 1);
});
integrationTest('Coffee Tables consecutive full repaints retain reading position until Markdown finishes', async () => {
  const { CoffeeTablesView } = load('experiences/coffee-tables/view.ts', { obsidian }, { requestAnimationFrame: callback => callback() });
  const session = coffeeSession(); session.status = 'completed'; session.rounds = [{id:'r',markdown:'Saved dialogue',createdAt:session.createdAt}];
  const view = new CoffeeTablesView({ app: {} }, {settings:{language:'en'},modelLabel:x=>x}); view.engine = {session,busy:false}; view.store = {sessionPath:()=>''}; view.renderRoster=()=>{}; view.updateStatus=()=>{}; view.renderMarkdown=()=>{};
  let scrolling = {scrollTop:400,scrollHeight:1000,clientHeight:300}; const pending = deferred();
  const make = (tag, options={}) => { const el = coffeeElement(tag,options); const cls=typeof options==='string'?options:options.cls; el.isConnected=true;
    el.createDiv=value=>{const child=make('div',typeof value==='string'?{cls:value}:value);el.children.push(child);return child};
    if (cls==='ct-chat-scroll') { scrolling=el; el.scrollHeight=300;el.clientHeight=300;let top=0;Object.defineProperty(el,'scrollTop',{get:()=>top,set:value=>{top=Math.max(0,Math.min(value,el.scrollHeight-el.clientHeight))}}); }
    if (cls==='ct-messages') { const owner=scrolling;el.setCssProps=props=>{owner.scrollHeight=parseFloat(props['--ct-live-held-height'])};el.removeClass=()=>{owner.scrollHeight=1200}; }
    return el;
  };
  view.contentEl=make('root');view.contentEl.ownerDocument={activeElement:null};view.contentEl.querySelector=selector=>selector==='.ct-chat-scroll'?scrolling:null;view.contentEl.querySelectorAll=()=>[];
  view.renderRound=()=>view.markdownJobs.push(pending.promise);
  view.render(); assert.equal(scrolling.scrollTop,400);view.render();assert.equal(scrolling.scrollTop,400);
  pending.resolve();await new Promise(resolve=>setTimeout(resolve,0));assert.equal(scrolling.scrollTop,400);
  view.engine.busy=true; session.status='generating'; view.render(); let rebuilt=0; view.render=()=>rebuilt++; view.refreshLive=()=>{}; session.updatedAt='next-token';view.refresh();assert.equal(rebuilt,0);
});
integrationTest('Coffee Tables observer refresh keeps the previous latest notes when final saving fails', async () => {
  const session=coffeeSession();session.status='completed';session.observerNotes=['Previous latest notes'];
  const fresh='# 觀察者整理\n\n'+['意外連結','值得繼續想的問題','核心分歧','探索方向','值得查證的假設'].map(t=>'## '+t+'\n- A concrete observation.\n- A second observation.').join('\n\n');
  const engine=new coffee.CoffeeEngine(session,async request=>{request.onText?.(fresh);return fresh},async value=>{if(value.observerNotes[0].includes('A concrete observation.'))throw new Error('Final save failed')});
  await engine.refreshObserverNotes();assert.equal(engine.session.observerNotes[0],'Previous latest notes');assert.match(engine.session.observerDraftMarkdown,/A concrete observation\./);assert.match(engine.error,/Final save failed/);
});

test('Coffee segment navigation sorts rounds and follow-ups without treating interventions as new segments', () => {
  const { coffeeSegments } = load('experiences/coffee-tables/segments.ts');
  const session = { id: 'table', createdAt: '2026-01-01', transcriptMarkdown: '', rounds: [{ id: 'a', createdAt: '2026-01-01', kind: 'initial', status: 'completed', markdown: 'A', summary: 'Opening.' }, { id: 'b', createdAt: '2026-01-03', kind: 'continuation', status: 'error', markdown: '', draftMarkdown: 'Draft' }], questions: [{ id: 'q', createdAt: '2026-01-02', question: 'Why?', answer: 'Because.', status: 'complete' }], interventions: [{ id: 'i', text: 'A turning question', roundId: 'a', afterTurn: 2, createdAt: '2026-01-02' }] };
  assert.deepEqual(plain(coffeeSegments(session)).map(x => [x.id,x.kind,x.status]), [['round:a','initial','completed'],['question:q','question','completed'],['round:b','continuation','error']]);
  assert.ok(coffeeSegments(session)[0].text.includes('A turning question'));
});
test('Coffee summary parsing removes metadata without damaging notes and ignores malformed summaries', () => {
  const { extractSegmentSummary, parseSummaryBatch } = load('experiences/coffee-tables/segments.ts');
  const result = extractSegmentSummary('### A｜Host\nHello.\n<!-- coffee-segment-summary: {"summary":"The debate shifted to responsibility."} -->\n# Observer’s notes\nNotes');
  assert.equal(result.summary, 'The debate shifted to responsibility.'); assert.ok(!result.markdown.includes('coffee-segment-summary')); assert.ok(result.markdown.includes('# Observer’s notes'));
  assert.equal(extractSegmentSummary('text\n<!-- coffee-segment-summary: bad -->').summary, undefined);
  assert.deepEqual(plain(parseSummaryBatch('{"summaries":[{"id":"round:a","summary":"One."},{"id":"foreign","summary":"Ignore."}]}', ['round:a'])), [{id:'round:a',summary:'One.'}]);
  assert.throws(() => parseSummaryBatch('{"summaries":[{"id":"round:a","summary":"One."},{"id":"round:a","summary":"Two."}]}', ['round:a']));
});

integrationTest('Coffee segment summaries are saved with generation; retries retain round identity and missing summaries do not fail dialogue', async () => {
  const { CoffeeEngine } = load('experiences/coffee-tables/engine.ts');
  const session = coffeeSession(); let attempts = 0;
  const coffeeResponse = '### Host|Host\nA discussion.\n# Observer’s notes\n' + ['Unexpected connections','Questions worth pursuing','Core disagreements','Directions to explore','Assumptions to verify'].map(title => `## ${title}\n- A concrete observation from this dialogue.`).join('\n');
  const engine = new CoffeeEngine(session, async () => { if (++attempts === 1) throw new Error('offline'); return coffeeResponse + '\n<!-- coffee-segment-summary: {"summary":"A shift in the question."} -->'; }, async () => {});
  await engine.start(); const id = engine.session.rounds[0].id; assert.equal(engine.session.rounds[0].status, 'error');
  await engine.start(); assert.equal(engine.session.rounds.length,1); assert.equal(engine.session.rounds[0].id,id); assert.equal(engine.session.rounds[0].summary,'A shift in the question.'); assert.ok(!engine.session.transcriptMarkdown.includes('coffee-segment-summary'));
  const other = new CoffeeEngine(coffeeSession(), async () => coffeeResponse, async () => {}); await other.start(); assert.equal(other.session.status,'completed'); assert.equal(other.session.rounds[0].summary,undefined);
});
integrationTest('Coffee summary backfill makes one request, saves partial IDs only, and preserves dialogue and insights on failure or cancellation', async () => {
  const { CoffeeEngine } = load('experiences/coffee-tables/engine.ts');
  const session = coffeeSession(); session.status='completed'; session.rounds=[{id:'a',markdown:'Hello.',notes:'',status:'completed',createdAt:session.createdAt},{id:'b',markdown:'More.',notes:'',summary:'Existing.',status:'completed',createdAt:session.createdAt}]; session.questions=[{id:'q',question:'Why?',answer:'Reason.',status:'complete',createdAt:session.createdAt}]; session.observerNotes=['Keep these notes.']; let calls=0;
  const engine = new CoffeeEngine(session, async ({prompt}) => {calls++; assert.ok(prompt.includes('round:a')); assert.ok(!prompt.includes('round:b')); return '{"summaries":[{"id":"round:a","summary":"Opening turn."}]}';},async()=>{});
  await engine.fillSegmentSummaries(); assert.equal(calls,1); assert.equal(engine.session.rounds[0].summary,'Opening turn.'); assert.equal(engine.session.rounds[1].summary,'Existing.'); assert.equal(engine.session.questions[0].summary,undefined); assert.equal(engine.session.observerNotes[0],'Keep these notes.'); assert.ok(engine.error);
  const failed = new CoffeeEngine(session,async()=>'{broken',async()=>{}); await failed.fillSegmentSummaries(); assert.deepEqual(plain(failed.session),plain(session));
  const saveFailed = new CoffeeEngine(session,async()=>'{"summaries":[{"id":"round:a","summary":"Opening turn."}]}',async()=>{throw new Error('disk');}); await saveFailed.fillSegmentSummaries(); assert.equal(saveFailed.session.rounds[0].summary,undefined);
  let abort; const cancelled = new CoffeeEngine(session,({signal})=>new Promise(resolve=>{abort=()=>resolve('{"summaries":[{"id":"round:a","summary":"Never save."}]}'); signal.addEventListener('abort',abort);}),async()=>{}); const pending=cancelled.fillSegmentSummaries(); cancelled.cancel(); await pending; assert.equal(cancelled.session.rounds[0].summary,undefined);
});

integrationTest('Coffee navigation summary metadata round trips by identity without changing transcript or triggering stale insights', async () => {
  const { CoffeeStorage } = load('experiences/coffee-tables/storage.ts', { obsidian }); const { app, files, contents } = fixture(); app.vault.getFiles = () => [...files.values()].filter(f=>f instanceof TFile);
  const store=new CoffeeStorage(app.vault,'Agent Workspace'), session=coffeeSession(); session.status='completed'; session.rounds=[{id:'empty',markdown:'',notes:'',status:'error',createdAt:session.createdAt},{id:'spoken',markdown:'### A|Host\nSpeech.',notes:'',kind:'continuation',summary:'A concrete turn.',status:'completed',createdAt:session.createdAt}]; session.questions=[{id:'q',question:'Why?',answer:'Because.',status:'complete',summary:'The follow-up explores causes.',createdAt:session.createdAt}];
  await store.save(session); const reopened=await new CoffeeStorage(app.vault,'Agent Workspace').load(session.id); assert.equal(reopened.rounds.find(x=>x.id==='spoken').summary,'A concrete turn.'); assert.equal(reopened.rounds.find(x=>x.id==='spoken').kind,'continuation'); assert.equal(reopened.questions[0].summary,'The follow-up explores causes.'); assert.ok(!reopened.dirtyNotes); assert.equal(reopened.transcriptMarkdown,'### A|Host\nSpeech.');
  const file=store.sessionPath(session.id), raw=contents.get(file); const marker=/<!-- coffee-tables-navigation:([^\n]+) -->/.exec(raw); const metadata=JSON.parse(decodeURIComponent(marker[1])); metadata.find(x=>x.id==='round:spoken').summary='Edited summary.'; contents.set(file,raw.replace(marker[0],`<!-- coffee-tables-navigation:${encodeURIComponent(JSON.stringify(metadata))} -->`)); const edited=await new CoffeeStorage(app.vault,'Agent Workspace').load(session.id); assert.equal(edited.rounds.find(x=>x.id==='spoken').summary,'Edited summary.'); assert.ok(!edited.dirtyNotes);
});
integrationTest('Coffee insight filtering expands matching context without changing saved collapse preferences', () => {
  const {CoffeeTablesView}=load('experiences/coffee-tables/view.ts',{obsidian}); const view=new CoffeeTablesView({app:{}},{settings:{language:'en'}}); view.engine={session:{id:'table',language:'en'}}; view.renderMarkdown=()=>{};
  const markdown='# Observer’s notes\n## Unexpected connections\n- Brief insight. <!-- coffee-insight:v1:id=item-a -->\n  - Context: A detailed bridge to trust.\n## Core disagreements\n- Other insight. <!-- coffee-insight:v1:id=item-b -->'; const target=coffeeElement('root'); view.renderInsightNotes(markdown,target);
  const input=coffeeFind(target,x=>x.tag==='input'); input.value='trust'; input.input(); assert.equal(coffeeFind(target,x=>x.tag==='input'),input);
  const state=view.insightStates.get('table'); state.collapsed.add('connections'); state.query='trust'; target.empty(); view.renderInsightNotes(markdown,target); const group=coffeeFind(target,x=>x.tag==='details' && x.dataset.insightCategory); assert.equal(group.open,true); assert.equal(coffeeFind(group,x=>x.dataset.insightId==='item-a').open,true); assert.equal(coffeeFind(target,x=>x.dataset.insightId==='item-b'),undefined); assert.equal(state.expanded.size,0); assert.ok(state.collapsed.has('connections'));
  state.query='';target.empty();view.renderInsightNotes(markdown,target); assert.equal(coffeeFind(target,x=>x.dataset.insightCategory==='connections').open,false); assert.equal(coffeeFind(target,x=>x.dataset.insightId==='item-a').open,false);
});
integrationTest('Coffee segment jump uses exact anchors and switches narrow layout to conversation', () => {
  const {CoffeeTablesView}=load('experiences/coffee-tables/view.ts',{obsidian}); const view=new CoffeeTablesView({app:{}},{settings:{language:'en'}}); let scroll; const message={addClass(){},removeClass(){}}, segment={dataset:{coffeeSegment:'round:a'},getBoundingClientRect:()=>({top:300}),querySelector:()=>message},scroller={scrollTop:50,getBoundingClientRect:()=>({top:100}),scrollTo:value=>scroll=value},body={dataset:{pane:'insight'}};
  view.contentEl={querySelectorAll:()=>[segment],querySelector:q=>q==='.ct-chat-scroll'?scroller:q==='.ct-room-columns'?body:null}; assert.equal(view.locateSegment('round:a'),true); assert.equal(scroll.top,226); assert.equal(body.dataset.pane,'chat'); assert.equal(view.locateSegment('round:missing'),false);
});

integrationTest('Coffee legacy navigation stays read only and clears the previous room', () => {
  const {CoffeeTablesView}=load('experiences/coffee-tables/view.ts',{obsidian:{...obsidian,MarkdownRenderer:{render:async()=>{}}}});
  const view=new CoffeeTablesView({app:{workspace:{}}},{settings:{language:'en'},isCoffeeOutlineSource:()=>true,refreshCoffeeOutline(){}});
  view.contentEl=coffeeElement('root'); view.button=()=>{}; view.store={sessionPath:()=> 'legacy.md'}; view.engine={session:{id:'previous'}};
  view.attachLegacy({version:1,id:'old',topic:'Old table',model:'model',createdAt:'2026-01-01',messages:[{speakerId:'host',text:'Old discussion'}],participants:[{id:'host',name:'Host',role:'Host'}],notes:null});
  assert.equal(view.engine,null); assert.equal(view.outlineSnapshot().sessionId,'old'); assert.equal(view.outlineSnapshot().segments[0].kind,'legacy'); assert.ok(coffeeFind(view.contentEl,x=>x.attrs['data-coffee-segment']==='legacy'));
});

integrationTest('Coffee summary-only save preserves exact historic insight Markdown', async () => {
 const {CoffeeStorage}=load('experiences/coffee-tables/storage.ts',{obsidian}); const {app,files,contents}=fixture(); app.vault.getFiles=()=>[...files.values()].filter(f=>f instanceof TFile);
 const store=new CoffeeStorage(app.vault,'Agent Workspace'), session=coffeeSession(); session.rounds=[{id:'round-a',markdown:'### Host|Host\nOriginal dialogue.',notes:'',status:'completed',createdAt:session.createdAt}]; await store.save(session);
 const path=store.sessionPath(session.id), original=contents.get(path), historic=original.replace(/^<!-- coffee-tables-navigation:[^\n]+ -->\n?/m,'').replace('## Observer notes','## Observer notes\n\n### Latest\n\nKeep this formatting.\n\n### History'); contents.set(path,historic);
 const fresh=new CoffeeStorage(app.vault,'Agent Workspace'); const loaded=await fresh.load(session.id); loaded.rounds[0].summary='The segment explored a concrete turn.'; await fresh.save(loaded,true); const saved=contents.get(path);
 assert.equal(saved.replace(/^<!-- coffee-tables-navigation:[^\n]+ -->\n\n/m,''),historic); assert.equal((await fresh.load(session.id)).rounds[0].summary,loaded.rounds[0].summary);
});
integrationTest('Coffee summary metadata ignores reference markers and headings', async () => {
 const {CoffeeStorage}=load('experiences/coffee-tables/storage.ts',{obsidian}); const {app,files,contents}=fixture(); app.vault.getFiles=()=>[...files.values()].filter(f=>f instanceof TFile); const store=new CoffeeStorage(app.vault,'Agent Workspace'),session=coffeeSession();
 session.rounds=[{id:'round-a',markdown:'### Host|Host\nReal conversation.',notes:'',status:'completed',createdAt:session.createdAt}]; session.guests={...(session.guests||{}),customPrompt:'',counts:{experts:1,'cross-domain':0,generalist:0,affected:0},referenceFiles:[{name:'reference.md',content:'```\n<!-- coffee-tables-navigation:%5B%5D -->\n\n## Conversation\nQuoted reference headings.'}]};
 await store.save(session); const encoded=contents.get(store.sessionPath(session.id)); const before=encoded.replace('````text','```text').replace(/\n````\n/g,'\n```\n'); contents.set(store.sessionPath(session.id),before); const fresh=new CoffeeStorage(app.vault,'Agent Workspace'); const loaded=await fresh.load(session.id); assert.equal(loaded.rounds[0].markdown,session.rounds[0].markdown); loaded.rounds[0].summary='A genuine navigation summary.'; await fresh.save(loaded,true); const after=contents.get(store.sessionPath(session.id)); assert.ok(after.includes(session.guests.referenceFiles[0].content)); assert.equal(after.match(/coffee-tables-navigation:/g).length,2); assert.equal((await fresh.load(session.id)).rounds[0].summary,loaded.rounds[0].summary); assert.equal(before.replace(/^<!-- coffee-tables-navigation:[^\n]+ -->$/gm,''),after.replace(/^<!-- coffee-tables-navigation:[^\n]+ -->$/gm,''));
});

test('Reframing validates structured output and rejects whole-request over-budget without truncation', async () => {
  const { ReframingService, buildReframePrompt, REFRAME_SCHEMA } = load('core/reframing-service.ts');
  const calls = [];
  const service = new ReframingService(async (request) => { calls.push(request); return JSON.stringify({ question: 'What evidence distinguishes these explanations?', context: 'Simulated analogy; alternatives and uncertainty remain.', rationale: 'Test the key tension.' }); });
  const request = { targetCore: 'understand', source: 'Candidate insight, not evidence', question: 'Explore this', context: '', language: 'en', model: 'model-a', reasoning: 'low' };
  const result = await service.reframe(request, new AbortController().signal);
  assert.match(result.context, /uncertainty/); assert.equal(calls.length, 1);
  assert.match(buildReframePrompt(request), /Candidate insight/); assert.equal(REFRAME_SCHEMA.additionalProperties, false);
  await assert.rejects(service.reframe({ ...request, source: 'x'.repeat(128001) }, new AbortController().signal), /budget|large/i); assert.equal(calls.length, 1);
  const invalid = new ReframingService(async () => '{"question":"q","context":"c","rationale":"r","path":"invented"}');
  await assert.rejects(invalid.reframe(request, new AbortController().signal), /invalid/i);
});

test('Coffee reframing snapshots exclude drafts/style and never turn ambiguous excerpts into provenance', () => {
  const { buildCoffeeSource, coffeeCommittedKey } = load('experiences/coffee-tables/handoff-source.ts');
  const session = { ...coffeeSession(), status: 'completed', rounds: [{id:'r1',status:'completed',createdAt:'now',markdown:'Unique line. Repeat phrase.',notes:''}, {id:'r2',status:'completed',createdAt:'now',markdown:'Repeat phrase.',notes:''}], transcriptMarkdown:'Unique line. Repeat phrase.\nRepeat phrase.', draftMarkdown:'UNFINISHED', observerDraftMarkdown:'DRAFT NOTES', dirtyNotes:true, guests: {...coffeeSession().guests,background:'Provided background',stylePrompt:'STYLE INSTRUCTION',customPrompt:'CUSTOM STYLE'}, observerNotes:['# Observer’s notes\n\n## Unexpected connections\n- Candidate analogy <!-- coffee-insight:v1:id=idea --> <!-- source: Unique line. -->\n  - Context: Important limits'] };
  const whole = buildCoffeeSource(session); assert.match(whole.content, /Provided background/); assert.match(whole.content, /Unique line/); assert.doesNotMatch(whole.content, /UNFINISHED|DRAFT NOTES|STYLE INSTRUCTION|CUSTOM STYLE/); assert.match(whole.sourceSnapshot, /Important limits/);
  const single = buildCoffeeSource(session, 'idea'); assert.match(single.content, /Unique line/); assert.match(single.content, /not.*updated|stale/i);
  const changed = {...session, observerNotes:[session.observerNotes[0].replace('Unique line.', 'Repeat phrase.')]}; const ambiguous = buildCoffeeSource(changed, 'idea'); assert.match(ambiguous.content, /unresolved|not.*located/i);
  assert.notEqual(coffeeCommittedKey(session), coffeeCommittedKey(changed));
});

integrationTest('Thinking Origin survives managed updates and hostile Markdown headings', async () => {
  const { repo } = fixture('en');
  const mapPath = await repo.createMap('Origin'); const map = await repo.readMap(mapPath);
  const origin = 'Original framing\n\n## Detail\n```md\n<!-- visual-agent-map:detail:end -->\n```\n### Limits\nNot verified';
  const n = await repo.createNote('Question', 'm', map, mapPath, 'manual', {detail:'Editable framing',thinkingOrigin:origin});
  assert.equal((await repo.readNote(n.path)).thinkingOrigin, origin);
  await repo.updateNote(n.path,{detail:'New research',summary:'Updated summary',preview:'User preview'});
  assert.equal((await repo.readNote(n.path)).thinkingOrigin,origin); assert.equal((await repo.readNote(n.path)).detail,'New research');
});

test('Visual Map origin is source context including decomposition and rejects silent omission', () => {
  const { withThinkingOrigin } = load('experiences/visual-map/thinking-origin.ts');
  const context = {title:'Question',summary:'',detail:'',task:'Expand',ancestors:'',rules:'',mode:'decompose',sourceContext:'Selected sources'};
  const joined = withThinkingOrigin(context, {thinkingOrigin:'Candidate analogy with limits'});
  assert.match(joined.sourceContext, /Selected sources/); assert.match(joined.sourceContext,/Candidate analogy/); assert.equal(joined.rules,'');
  const prepared = load('ai/context-builder.ts').buildPreparedTaskContext(joined,'m'); assert.match(prepared.context.sourceContext,/Candidate analogy/);
});

async function reframingModalFixture(insightId) {
  const data=fixture('en'); const {app,contents,repo}=data;
  const {CoffeeStorage}=load('experiences/coffee-tables/storage.ts',{obsidian});
  const session=coffeeSession(); session.status='completed'; session.language='en'; session.rounds=[{id:'round-handoff',createdAt:session.createdAt,status:'completed',markdown:'### Host|Host\nUnique discussion line.',notes:''}]; session.transcriptMarkdown=session.rounds[0].markdown;
  session.observerNotes=['# Observer’s notes\n\n## Unexpected connections\n- Candidate analogy <!-- coffee-insight:v1:id=idea --> <!-- source: Unique discussion line. -->\n  - Context: Important limits'];
  const store=new CoffeeStorage(app.vault,'Agent Workspace'); await store.save(session); const path=store.sessionPath(session.id), displayed=await store.inspectReadOnly(path);
  const {default:Plugin}=load('main.ts',{obsidian});const plugin=new Plugin(); plugin.app=app;plugin.repo=repo;plugin.coffeeStorage=store;plugin.settings.language='en';withCoffeeModelDiscovery(plugin,['test-model']); plugin.confirmAiUsage=async (_m,run)=>{await run();return true;}; plugin.register=()=>{};
  const opened=[];plugin.activateView=async p=>{opened.push(p);};plugin.openResearchMap=async p=>{opened.push(p);};plugin.mutate=async work=>work();
  const {receiveVisualMapHandoff}=load('experiences/visual-map/handoff.ts',{obsidian});
  plugin.core.experiences.register('visual-map',(artifact,beforeWrite)=>receiveVisualMapHandoff(artifact,{repo,defaultModel:()=>plugin.settings.cliModel,exists:p=>!!app.vault.getAbstractFileByPath(p),mutate:work=>plugin.mutate(work),navigate:p=>plugin.activateView(p),beforeWrite}));
  class Modal {constructor(){this.titleEl=coffeeElement('title');this.contentEl=coffeeElement('content');}open(){this.onOpen?.();}close(){this.didClose=true;this.onClose?.();}}
  const {openCoffeeResearchHandoff}=load('experiences/coffee-tables/handoff-modal.ts',{obsidian:{...obsidian,Modal}});
  const modal=await openCoffeeResearchHandoff(plugin,store,displayed,path,insightId);
  return {...data,plugin,store,session:displayed,path,modal,opened};
}

integrationTest('Coffee reframing stops late results and preserves drafts on invalid/failed requests', async () => {
  const data=await reframingModalFixture('idea'),{modal,plugin}=data;const pending=deferred();
  plugin.core.reframing={reframe:()=>pending.promise};
  const context=coffeeFind(modal.contentEl,e=>e.attrs['aria-label']==='Research context'), old=context.value;
  coffeeFind(modal.contentEl,e=>e.text==='Organize with AI').onclick();await until(()=>modal.controller);
  coffeeFind(modal.contentEl,e=>e.text==='Stop').onclick();pending.resolve({question:'late',context:'late result',rationale:'late'});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(context.value,old);assert.equal(plugin.activeTasks.size,0);assert.equal(data.opened.length,0);
  plugin.core.reframing={reframe:async()=>{throw Error('invalid response');}};
  coffeeFind(modal.contentEl,e=>e.text==='Organize with AI').onclick();await until(()=>!modal.controller);assert.equal(context.value,old);assert.match(modal.status.text,/invalid/);
});

integrationTest('Coffee reframing checks Markdown/sidecar changes and busy state before creating', async () => {
  for (const kind of ['markdown','sidecar','busy']) {
    const data=await reframingModalFixture();
    if(kind==='markdown')data.contents.set(data.path,data.contents.get(data.path)+'\nExternal edit');
    if(kind==='sidecar'){const p=data.store.sidecarPath(data.session.id);data.contents.set(p,data.contents.get(p)+' ');}
    if(kind==='busy')data.plugin.coffeeManager={get:()=>({busy:true})};
    coffeeFind(data.modal.contentEl,e=>e.text==='Create research map').onclick();await until(()=>!data.modal.creating);
    assert.equal((await data.repo.mapFiles()).length,0);assert.equal(data.opened.length,0);assert.match(data.modal.status.text,/changed|generating/);
  }
});

integrationTest('Visual Map handoff separates synchronization/navigation failure from durable completion', async () => {
  const {receiveVisualMapHandoff}=load('experiences/visual-map/handoff.ts',{obsidian});const {repo,files}=fixture('en');let navigations=0;
  const artifact={version:1,id:'operation',kind:'question',title:'Question',content:'Context',sourceSnapshot:'Idea',origin:{experience:'coffee-tables'},sources:[]};
  const result=await receiveVisualMapHandoff(artifact,{repo,defaultModel:()=> 'm',exists:p=>files.has(p),mutate:async work=>{await work();throw Error('sync failed');},navigate:async()=>{navigations++;throw Error('open failed');}});
  assert.match(result.navigationError,/sync failed/);assert.match(result.navigationError,/open failed/);assert.ok(files.has(result.targetPath));assert.equal((await repo.readMap(result.targetPath)).nodes.length,1);assert.equal(navigations,1);
});

integrationTest('Visual Map handoff exposes exact partial paths at every persistence stage', async () => {
  const {receiveVisualMapHandoff}=load('experiences/visual-map/handoff.ts',{obsidian});
  for(const stage of ['folders','map','note','saveMap']){
    const {repo,app,files}=fixture('en');
    if(stage==='folders'){const fn=repo.ensureTopicFolders.bind(repo);repo.ensureTopicFolders=async root=>{await fn(root);throw Error('folder failed');};}
    if(stage==='map'||stage==='note'){const fn=app.vault.create;app.vault.create=async(p,s)=>{if(stage==='map'?p.endsWith('/Map.md'):p.includes('/Notes/'))throw Error(stage+' failed');return fn(p,s);};}
    if(stage==='saveMap')repo.saveMap=async()=>{throw Error('save failed');};
    const artifact={version:1,id:stage,kind:'question',title:'Question',content:'Context',origin:{experience:'coffee-tables'},sources:[]};
    await assert.rejects(receiveVisualMapHandoff(artifact,{repo,defaultModel:()=> 'm',exists:p=>files.has(p),mutate:work=>work(),navigate:async()=>{throw Error('should not navigate');}}),e=>{assert.equal(e.name,'HandoffWriteError');assert.ok(e.paths.length>=1);assert.ok(e.paths.every(p=>files.has(p)));return true;});
  }
});

integrationTest('Coffee handoff partial writes disable creation; saved navigation failures retry only opening', async () => {
  const partial=await reframingModalFixture();partial.repo.saveMap=async()=>{throw Error('save failed');};
  const create=coffeeFind(partial.modal.contentEl,e=>e.text==='Create research map');create.onclick();await until(()=>!partial.modal.creating);assert.equal(create.disabled,true);const paths=[...partial.files.keys()];create.onclick();await Promise.resolve();assert.deepEqual([...partial.files.keys()],paths);assert.match(partial.modal.status.text,/Some files/);
  const saved=await reframingModalFixture();saved.plugin.activateView=async()=>{throw Error('navigation failed');};
  const open=coffeeFind(saved.modal.contentEl,e=>e.text==='Create research map');open.onclick();await until(()=>!saved.modal.creating);assert.equal(open.text,'Open saved map');assert.equal((await saved.repo.mapFiles()).length,1);open.onclick();await until(()=>saved.opened.length===1);assert.equal((await saved.repo.mapFiles()).length,1);
});

integrationTest('Root research and decomposition use Thinking Origin and preserve it across writeback', async () => {
  const {repo,app}=fixture('en'), n=await topicNote(repo,'Research source');
  const mapPath='Agent Workspace/Topics/map-a/Map.md', doc={...map([n]),id:'map-a'};await app.vault.create(mapPath,core.serializeMap(doc));
  await repo.updateNote(n.path,{prompt:'Research',detail:'Initial context',thinkingOrigin:'Unverified analogy. Important conditions and alternatives.'});
  const {VisualAgentMapView}=load('main.ts',{obsidian});let view;const modes=[],languages=[];
  const plugin=withExpansionCoordinator({repo,settings:{...DEFAULT_SETTINGS,language:'en'},running:new Set(),activeTasks:new Map(),pendingSuggestions:new Map(),pendingResearchOptions:new Map(),mutate:work=>work(),views:()=>[view],askModel:async context=>{modes.push(context.mode);languages.push(context.outputLanguage);assert.match(context.sourceContext,/Important conditions/);assert.equal(context.rules,'');return {summary:'New understanding',detail:'Research findings',suggestions:[]};},rebuildDerivedData:async()=>{}});
  view=new VisualAgentMapView({app},plugin);view.path=mapPath;view.map=doc;view.render=()=>{};view.hydrate=async()=>{};view.contentEl={querySelector:()=>null};
  await view.runAgent(n,undefined,undefined,{outputLanguage:'zh-TW'});await until(()=>!plugin.running.size);assert.match((await repo.readNote(n.path)).thinkingOrigin,/Important conditions/);
  await view.proposeChildren(n,true,{researchMode:'local',researchDepth:'normal',visualMode:'off',referenceGroups:[]},'Explore',()=>{},()=>{});
  assert.deepEqual(modes,['task','decompose']);assert.equal(languages[0],'zh-TW');
});

integrationTest('Editing Thinking Origin during root research fences stale results', async () => {
  const {repo,app}=fixture('en'),n=await topicNote(repo,'Editable source');await repo.updateNote(n.path,{prompt:'Research',detail:'Keep',thinkingOrigin:'Old source'});
  const {VisualAgentMapView}=load('main.ts',{obsidian});const pending=deferred();let view,accepted=false;
  const plugin={repo,settings:{...DEFAULT_SETTINGS},running:new Set(),activeTasks:new Map(),pendingSuggestions:new Map(),mutate:work=>work(),views:()=>[view],askModel:(_context,_model,_reasoning,_signal,_exchange,onAccepted)=>{onAccepted?.();accepted=true;return pending.promise;}};
  view=new VisualAgentMapView({app},plugin);view.map=map([n]);view.render=()=>{};view.hydrate=async()=>{};
  const handle=await view.runAgent(n);assert.ok(handle);assert.equal(accepted,true);await repo.updateNote(n.path,{thinkingOrigin:'User corrected source'});pending.resolve({summary:'Stale',detail:'Stale',suggestions:[]});await handle.finished;
  const note=await repo.readNote(n.path);assert.equal(note.detail,'Keep');assert.equal(note.thinkingOrigin,'User corrected source');
});

integrationTest('Reframing close/reset and declined usage confirmation never apply late drafts', async () => {
  for(const action of ['close','reset','decline']){
    const data=await reframingModalFixture(),{modal,plugin}=data;const pending=deferred();let request;
    plugin.core.reframing={reframe:(input,signal)=>{request={input,signal};return pending.promise;}};
    if(action==='decline')plugin.confirmAiUsage=async()=>false;
    const question=coffeeFind(modal.contentEl,e=>e.attrs['aria-label']==='Research question'),before=question.value;
    coffeeFind(modal.contentEl,e=>e.text==='Organize with AI').onclick();
    if(action==='decline'){await until(()=>!modal.controller);assert.equal(request,undefined);assert.match(modal.status.text,/did not run/);continue;}
    await until(()=>request);if(action==='close')modal.close();else plugin.resetCodexRuntime();
    assert.equal(request.signal.aborted,true);pending.resolve({question:'Late',context:'Late',rationale:'Late'});await new Promise(resolve=>setImmediate(resolve));assert.equal(question.value,before);assert.equal(data.opened.length,0);assert.equal(plugin.activeTasks.size,0);
  }
});

integrationTest('Coffee handoff rechecks source after waiting in the write queue', async () => {
  const data=await reframingModalFixture();const gate=deferred();data.plugin.mutate=async work=>{await gate.promise;await work();};
  coffeeFind(data.modal.contentEl,e=>e.text==='Create research map').onclick();await until(()=>data.modal.creating);
  data.contents.set(data.path,data.contents.get(data.path)+'\nChanged while queued');gate.resolve();await until(()=>!data.modal.creating);assert.equal((await data.repo.mapFiles()).length,0);assert.equal(data.opened.length,0);
});

integrationTest('Reframing runner uses structured output and disabled tools on both provider adapters', async () => {
  const {EventEmitter}=require('node:events');const requests=[];
  const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.kill=()=>{};
  const emit=message=>process.nextTick(()=>child.stdout.emit('data',Buffer.from(JSON.stringify(message)+'\n')));
  child.stdin={write:line=>{const m=JSON.parse(line);requests.push(m);if(m.method==='initialize')emit({id:m.id,result:{}});else if(m.method==='config/read')emit({id:m.id,result:{config:{mcp_servers:{'inherited.server':{},enabledServer:{enabled:true}}}}});else if(m.method==='thread/start'){assert.equal(m.params.config.mcp_servers['inherited.server'].enabled,false);assert.equal(m.params.config.mcp_servers.enabledServer.enabled,false);for(const feature of ['apps','plugins','browser_use','computer_use','multi_agent','goals','code_mode_host'])assert.equal(m.params.config['features.'+feature],false);assert.equal(m.params.config['web_search'],'disabled');assert.equal(m.params.config['features.shell_tool'],false);assert.equal(m.params.config['features.unified_exec'],false);assert.doesNotMatch(m.params.baseInstructions,/only.*Markdown/);emit({id:m.id,result:{thread:{id:'reframe-thread'}}});}else if(m.method==='turn/start'){assert.equal(m.params.outputSchema.additionalProperties,false);emit({id:m.id,result:{turn:{id:'reframe-turn'}}});emit({method:'item/completed',params:{threadId:'reframe-thread',item:{id:'message',type:'agentMessage',text:'{"question":"Q?","context":"Unverified context","rationale":"R"}'}}});emit({method:'turn/completed',params:{threadId:'reframe-thread',turn:{status:'completed'}}});}else if(m.method==='thread/unsubscribe')emit({id:m.id,result:{}});}};
  const {CodexAppServerRuntime}=load('ai/runtime/codex-app-server.ts',{'node:child_process':{spawn:()=>child}});const {ReframingService}=load('core/reframing-service.ts');
  const runtime=new CodexAppServerRuntime({executable:'codex',cwd:'/plugin',env:{},clientVersion:'test',webSearchDisabled:true});
  try{const service=new ReframingService((request,prompt,schema,signal)=>runtime.runTask(prompt,request.model,request.reasoning,schema,{textOnly:true,searchBudget:0,signal}));await service.reframe({targetCore:'understand',source:'Unverified idea',question:'Q',context:'',model:'m',reasoning:'low',language:'en'},new AbortController().signal);assert.ok(requests.some(r=>r.method==='turn/start'));}finally{runtime.stop();}
  const args=load('ai/runtime/claude-code-cli.ts').claudeTaskArgs('sonnet','low',load('core/reframing-service.ts').REFRAME_SCHEMA,false);assert.equal(args[args.indexOf('--tools')+1],'');assert.ok(args.includes('--json-schema'));
});

integrationTest('Oversized Thinking Origin is rejected before provider work without trimming', async () => {
  const {default:Plugin}=load('main.ts',{obsidian});const plugin=new Plugin();let calls=0;plugin.runtime=()=>{calls++;throw Error('must not run');};
  await assert.rejects(plugin.askModel({title:'Q',summary:'',detail:'',task:'Research',rules:'',ancestors:'',sourceContext:'x'.repeat(128001)},'m'),/budget|預算/i);assert.equal(calls,0);
});

integrationTest('Coffee becoming busy during the final snapshot read blocks handoff writes', async () => {
  const data=await reframingModalFixture();let checks=0;const read=data.store.assertHandoffSnapshot.bind(data.store);
  data.store.assertHandoffSnapshot=async s=>{await read(s);if(++checks===2)data.plugin.coffeeManager={get:()=>({busy:true})};};
  coffeeFind(data.modal.contentEl,e=>e.text==='Create research map').onclick();await until(()=>!data.modal.creating);assert.equal((await data.repo.mapFiles()).length,0);assert.match(data.modal.status.text,/generating/);
});

integrationTest('Reframing exchange logs record validation failure and clean active controllers', async () => {
  const {providerReframeRunner,ReframingService}=load('core/reframing-service.ts');const states=[];const active=new Map();
  const log={begin:()=>states.push('begin'),sent:()=>{},received:()=>states.push('received'),parsed:()=>states.push('parsed'),completed:()=>states.push('completed'),failed:()=>states.push('failed')};
  const options={pluginDirectory:()=>'/plugin',exchangeLoggingEnabled:()=>true,exchanges:()=>log,codexRuntime:()=>({runTask:async()=>'{"question":"Q?","context":"","rationale":"r"}'})};
  const service=new ReframingService(providerReframeRunner(options,active));
  await assert.rejects(service.reframe({targetCore:'understand',source:'idea',question:'Q?',context:'',language:'en',model:'m',reasoning:'low'},new AbortController().signal),/Invalid/);assert.deepEqual(states,['begin','received','failed']);assert.equal(active.size,0);
});

integrationTest('Guided proposals fence Thinking Origin at publication and after persisted reload', async () => {
  for(const stage of ['publication','acceptance','reload']) {
    const {repo,app}=fixture('en'), n=await topicNote(repo,'Guided origin');
    await repo.updateNote(n.path,{thinkingOrigin:'Old analogy'});
    const {VisualAgentMapView}=load('main.ts',{obsidian});const deferredResult=deferred();let view,accept,error;
    const plugin=withExpansionCoordinator({repo,settings:{...DEFAULT_SETTINGS,language:'en'},running:new Set(),activeTasks:new Map(),quickExpandPending:new Set(),pendingSuggestions:new Map(),pendingResearchOptions:new Map(),mutate:work=>work(),views:()=>[view],askModel:(_context,_model,_reasoning,_signal,_exchange,accepted)=>{accepted?.();return deferredResult.promise;},recordFailure:(_label,e)=>e.message});
    view=new VisualAgentMapView({app},plugin);view.map=map([n]);view.render=()=>{};view.hydrate=async()=>{};
    const modalController=new AbortController(); let accepted=false;
    const task=view.proposeChildren(n,true,{referenceGroups:[],shallowResearch:true,signal:modalController.signal,onProgress:()=>assert.fail('closed modal progress callback used')},'Explore',(_items,create)=>{accept=create;},message=>{error=message;},false,undefined,()=>{accepted=true;});
    await until(()=>accepted);
    assert.equal(accepted,true); assert.equal(modalController.signal.aborted,false); assert.ok(plugin.activeTasks.has(n.path));
    if(stage==='publication')await repo.updateNote(n.path,{thinkingOrigin:'Corrected source'});
    deferredResult.resolve({summary:'',detail:'',suggestions:[{title:'Proposal',task:'Explore',contribution:'Understanding'}]});await task;
    assert.equal(plugin.activeTasks.has(n.path),false);
    if(stage==='publication'){assert.equal(accept,undefined);assert.equal(plugin.pendingSuggestions.size,0);assert.ok(error);continue;}
    const proposals=plugin.pendingSuggestions.get(n.path);
    const savedOptions=plugin.pendingResearchOptions.get(n.path);
    assert.equal(savedOptions.signal,undefined); assert.equal(savedOptions.onProgress,undefined);
    if(stage==='reload')plugin.pendingSuggestions.set(n.path,JSON.parse(JSON.stringify(proposals)));
    await repo.updateNote(n.path,{thinkingOrigin:'Corrected source'});
    if(stage==='reload')await view.proposeChildren(n,true,undefined,'',(_items,create)=>{accept=create;});
    await assert.rejects(accept(plugin.pendingSuggestions.get(n.path)),/changed|變更/);
    assert.equal(view.map.nodes.length,1);assert.equal(plugin.pendingSuggestions.size,0);
  }
});

integrationTest('Claude nonzero exit exposes structured provider rejection without stderr', async () => {
  const {EventEmitter}=require('node:events');const spawn=()=>{const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.kill=()=>true;child.stdin={end:()=>process.nextTick(()=>{child.stdout.emit('data',Buffer.from(JSON.stringify({type:'result',is_error:true,result:'Subscription access disabled'})));child.emit('close',1);})};return child;};
  const {ClaudeCodeCliRuntime}=load('ai/runtime/claude-code-cli.ts');const runtime=new ClaudeCodeCliRuntime({executable:'claude',cwd:'/test',env:{},spawn});
  await assert.rejects(runtime.runTask('Synthetic source','sonnet','low',{},{}),/Subscription access disabled/);
});

// Current MindSearch coverage scenarios: verify outcomes rather than exact prompt wording/call counts.
function coverageModel({ failSearch = false, unavailableDelivery = false, clarifyConflict = false } = {}) {
  const phases = [], state = { failSearch, clarifyConflict };
  const response = (summary, detail, suggestions = []) => ({ summary, detail, suggestions, visualReferences: [] });
  const ask = async context => {
    const phase = context.task.match(/mindsearch-phase:\s*([a-z-]+)/)?.[1]; phases.push(phase);
    if (phase === 'saved-evidence-review') return savedEvidenceNeedsSearch();
    if (phase === 'initial-clarification') return response('Clarification', '<!-- mindsearch-intake {"questions":["What constraints matter?"]} -->');
    if (phase === 'initial-question') return response('What is your intended outcome?', 'Unknown success criterion.', [{ title: 'Executable project', task: '', contribution: '' }, { title: 'Compare alternatives', task: '', contribution: '' }]);
    if (phase === 'research-plan') return response('Two complementary research dimensions.', '<!-- mindsearch-plan {"subtopics":[{"id":"method","title":"Method and options","task":"Research practical methods and relevant alternatives.","expectedValue":"Compare feasible ways to meet the goal."},{"id":"constraints","title":"Constraints and quality","task":"Research key constraints, timing, and quality or safety considerations.","expectedValue":"Identify conditions that could change execution."}]} -->');
    if (phase === 'report-review') {
      const count = Number(context.task.match(/Hard floor: (\d+) answered/)?.[1]);
      const suppliedContext = `${context.task}\n${context.detail}\n${context.ancestors}`;
      if (clarifyConflict && /occasional contributor/i.test(suppliedContext) && /primary operations owner/i.test(suppliedContext)) return plannerReview('ask_user', { rationale: 'The same project is described as both occasional contribution and primary operations ownership; clarify responsibility before personalizing the plan.', question: 'For this same project, are you an occasional contributor or the primary operations owner?' }, 'Keep the answer conditional until the conflicting responsibility is clarified.', 'The supplied responsibility descriptions conflict; do not choose one.', ['Occasional contributor', 'Primary operations owner']);
      return count < 3 ? plannerReview('ask_user', { rationale: 'A different unknown constraint changes execution.', question: `Which constraint matters at stage ${count + 1}?` }, 'Interim evidence', 'Applicable evidence and limitations.', ['Time constraint', 'Resource constraint']) : plannerReview('conclude', { rationale: 'Three answers and reports support delivery.', stopReason: 'Ready for delivery stages.' }, 'Candidate document', 'Candidate document');
    }
    if (phase === 'delivery-outline') return response('Document outline', '<!-- mindsearch-delivery-outline {"sections":[{"heading":"Execution plan","purpose":"Complete the original goal","searchTask":"Find verified runnable examples"}]} -->');
    if (phase === 'delivery-research') return response('Delivery evidence', `<!-- mindsearch-delivery-research {"status":"${unavailableDelivery ? 'unavailable' : 'searched'}"} -->\nConcrete example and source https://example.org/reference`);
    if (phase === 'delivery-writing') return response('Canvas preview', '# Complete execution plan\n\n1. Build a small example.\n2. Check the output against requirements.\n3. Extend with evidence.\n\nSource: https://example.org/reference');
    if (phase === 'delivery-acceptance') return plannerReview('conclude', { rationale: 'Every required section is concrete and supported.', stopReason: 'Document usable for original goal.' }, 'Completed document preview', '# Complete execution plan\n\n1. Build a small example.\n2. Check the output against requirements.\n3. Extend with evidence.\n\nSource: https://example.org/reference');
    if (context.researchMode === 'research') {
      if (state.failSearch) return response('Search unavailable', 'Research status: unavailable');
      return response('Researched evidence', 'Research status: search completed\nApplicable evidence: https://example.org/reference');
    }
    throw new Error(`Unexpected coverage phase ${phase}`);
  };
  return { ask, phases, state };
}
async function coverageSetup(topic = 'Produce an actionable learning plan', config = {}) {
  const repo = config.sharedRepo ?? fixture().repo;
  const { createMindSearchMap } = load('experiences/mind-search/create-map.ts');
  const { MindSearchRunStore } = load('mindsearch-mve/research-run-store.ts');
  const { MindSearchManualFlow } = load('experiences/mind-search/manual-flow.ts');
  const model = coverageModel(config);
  const created = await createMindSearchMap(repo, 'gpt-6-luna', { requestId: `coverage-${topic}`, topic, context: 'Initial clarification: known background; unknown constraints may be explored conditionally.', minimumAnswersBeforeConclusion: 3, outcomeExpectation: { goal: 'execute', description: '', formats: ['steps', 'table'] } });
  const flow = new MindSearchManualFlow(repo, new MindSearchRunStore(repo), model.ask);
  return { repo, created, flow, model };
}
async function coverageThreeAnswers(subject) {
  let question = (await subject.flow.planNextQuestion(subject.created.mapPath, subject.created.root.id, 'gpt-6-luna', 'low', 'coverage-question')).node;
  let outcome;
  for (let round = 1; round <= 3; round++) {
    const freeText = subject.model.state.clarifyConflict
      ? round === 1 ? 'I am an occasional contributor.' : round === 3 ? 'I am the primary operations owner for this same project.' : `Additional condition ${round}`
      : `Specific condition ${round}`;
    outcome = await subject.flow.answerAndResearch(subject.created.mapPath, question.id, { requestId: `coverage-answer-${round}`, selections: [question.mindSearchQuestion.options[0].id], freeText }, 'gpt-6-luna', 'low');
    const saved = await subject.repo.readMap(subject.created.mapPath);
    const branch = saved.mindSearch.branches.find(b => b.id === outcome.branchId);
    assert.equal(branch.results.filter(r => r.kind === 'research').length, 2);
    for (const result of branch.results.filter(r => r.kind === 'research')) assert.equal(saved.nodes.find(n => n.id === result.nodeId).parentId, branch.questionNodeId);
    if (round < 3) { assert.equal(outcome.status, 'waiting-user'); assert.equal(branch.results.some(r => r.kind === 'conclusion'), false); question = saved.nodes.find(n => n.id === outcome.questionNodeId); assert.equal(question.mindSearchConvergesFromNodeIds, undefined); }
  }
  return outcome;
}
integrationTest('coverage: three researched answers produce an outline-searched-written-checked complete document', async () => {
  const subject = await coverageSetup(); const outcome = await coverageThreeAnswers(subject);
  assert.equal(outcome.status, 'completed');
  const saved = await subject.repo.readMap(subject.created.mapPath);
  assert.equal(saved.mindSearch.branches.length, 3);
  assert.deepEqual(subject.model.phases.filter(p => p?.startsWith('delivery-')), ['delivery-outline', 'delivery-research', 'delivery-writing', 'delivery-acceptance']);
  const note = await subject.repo.readNote(outcome.result.notePath);
  assert.match(note.detail, /Complete execution plan/); assert.match(note.detail, /https:\/\/example.org\/reference/);
});
integrationTest('coverage: final search unavailable preserves prior research and never publishes conclusion', async () => {
  const subject = await coverageSetup('Search unavailable scenario', { unavailableDelivery: true });
  await assert.rejects(() => coverageThreeAnswers(subject), /web research was unavailable/);
  const saved = await subject.repo.readMap(subject.created.mapPath);
  assert.equal(saved.mindSearch.branches.flatMap(b => b.results).filter(r => r.kind === 'research').length, 6);
  assert.equal(saved.mindSearch.branches.some(b => b.results.some(r => r.kind === 'conclusion')), false);
});
integrationTest('coverage: failed search resumes the saved default plan on the same answer branch', async () => {
  const subject = await coverageSetup('Retry scenario', { failSearch: true });
  const q = await subject.flow.planNextQuestion(subject.created.mapPath, subject.created.root.id, 'gpt-6-luna', 'low', 'retry-question');
  await assert.rejects(() => subject.flow.answerAndResearch(subject.created.mapPath, q.node.id, { requestId: 'retry-answer', selections: [q.options[0].id], freeText: 'Saved condition' }, 'gpt-6-luna', 'low'));
  let saved = await subject.repo.readMap(subject.created.mapPath); assert.equal(saved.mindSearch.branches.length, 1);
  const branchId = saved.mindSearch.branches[0].id;
  assert.deepEqual(plain(saved.mindSearch.branches[0].researchPlan.map(target => target.id)), ['method', 'constraints']);
  subject.model.state.failSearch = false;
  const resumed = await subject.flow.resumeAnswerResearch(subject.created.mapPath, branchId, 'gpt-6-luna', 'low');
  assert.equal(resumed.status, 'waiting-user');
  saved = await subject.repo.readMap(subject.created.mapPath); const branch = saved.mindSearch.branches.find(item => item.id === branchId);
  assert.equal(saved.mindSearch.branches.length, 1); assert.equal(branch.answerSnapshot.freeText, 'Saved condition');
  assert.deepEqual(plain(branch.researchPlan.map(target => target.id)), ['method', 'constraints']);
  assert.equal(branch.results.filter(r => r.kind === 'research').length, 2);
  assert.equal(saved.nodes.find(node => node.id === branch.results.find(r => r.kind === 'research').nodeId).parentId, branch.questionNodeId);
});
integrationTest('coverage: changed answers keep independent research parents and do not count sibling answers', async () => {
  const subject = await coverageSetup('Independent answers scenario');
  const q = await subject.flow.planNextQuestion(subject.created.mapPath, subject.created.root.id, 'gpt-6-luna', 'low', 'branch-question');
  for (let index = 0; index < 2; index++) await subject.flow.answerAndResearch(subject.created.mapPath, q.node.id, { requestId: `branch-answer-${index}`, selections: [q.options[index].id], freeText: '' }, 'gpt-6-luna', 'low');
  const saved = await subject.repo.readMap(subject.created.mapPath), branches = saved.mindSearch.branches;
  assert.equal(branches.length, 2); assert.notEqual(branches[0].questionNodeId, branches[1].questionNodeId);
  const { countMindSearchAnsweredQuestions } = load('experiences/mind-search/manual-flow.ts');
  for (const b of branches) { assert.equal(countMindSearchAnsweredQuestions(saved, b.id), 1); for (const r of b.results.filter(r => r.kind === 'research')) assert.equal(saved.nodes.find(n => n.id === r.nodeId).parentId, b.questionNodeId); }
});
integrationTest('coverage: two simultaneous MindSearch maps run without mixing branches or evidence', async () => {
  const sharedRepo = fixture().repo;
  const subjects = await Promise.all([coverageSetup('Travel document', { sharedRepo }), coverageSetup('Learning document', { sharedRepo })]);
  const results = await Promise.all(subjects.map(coverageThreeAnswers));
  for (let i = 0; i < 2; i++) { assert.equal(results[i].status, 'completed'); const saved = await subjects[i].repo.readMap(subjects[i].created.mapPath); assert.equal(saved.title, i === 0 ? 'Travel document' : 'Learning document'); assert.equal(saved.mindSearch.branches.length, 3); }
});
integrationTest('coverage: initial clarification is separate from answered exploration count', async () => {
  const subject = await coverageSetup('Intake scenario'); const topic = await subject.repo.readNote(subject.created.root.path);
  const questions = await subject.flow.prepareClarification(topic); assert.equal(questions.length, 1);
  const saved = await subject.repo.readMap(subject.created.mapPath); assert.equal(saved.mindSearch.branches.length, 0);
  const { countMindSearchAnsweredQuestions } = load('experiences/mind-search/manual-flow.ts'); assert.equal(countMindSearchAnsweredQuestions(saved, null), 0);
});
integrationTest('coverage: repeated identical answer is idempotent and unknown is exclusive', async () => {
  const subject = await coverageSetup('Idempotency scenario');
  const q = await subject.flow.planNextQuestion(subject.created.mapPath, subject.created.root.id, 'gpt-6-luna', 'low', 'idempotency-question');
  const input = { requestId: 'same-answer', selections: [q.options[0].id], freeText: 'Known condition' };
  const first = await subject.flow.answerAndResearch(subject.created.mapPath, q.node.id, input, 'gpt-6-luna', 'low');
  const calls = subject.model.phases.length;
  const second = await subject.flow.answerAndResearch(subject.created.mapPath, q.node.id, input, 'gpt-6-luna', 'low');
  assert.equal(first.branchId, second.branchId); assert.equal(subject.model.phases.length, calls);
  await assert.rejects(() => subject.flow.answerAndResearch(subject.created.mapPath, q.node.id, { requestId: 'bad-multiple', selections: [q.options[0].id, '__mindsearch_unknown__'], freeText: '' }, 'gpt-6-luna', 'low'), /cannot be combined/);
  const saved = await subject.repo.readMap(subject.created.mapPath); assert.equal(saved.mindSearch.branches.length, 1);
});
integrationTest('coverage: preflight failures are persisted and cancellation does not fabricate failure', async () => {
  const { MindSearchManualFlow } = load('experiences/mind-search/manual-flow.ts'); let captured;
  const flow = new MindSearchManualFlow({}, { saveResearchPlanError: async (_map, _branch, error) => { captured = error.message; } });
  flow.executeSubtopicWorkflow = async () => { throw new Error('Preflight rejected'); };
  await assert.rejects(() => flow.runSubtopicWorkflow('map', 'branch', {}, {}, [], '', '', 'model', 'low'), /Preflight rejected/); assert.equal(captured, 'Preflight rejected');
  captured = undefined; const controller = new AbortController(); controller.abort();
  await assert.rejects(() => flow.runSubtopicWorkflow('map', 'branch', {}, {}, [], '', '', 'model', 'low', controller.signal)); assert.equal(captured, undefined);
});
integrationTest('coverage: reload uses persisted reports without regenerating an already completed answer', async () => {
  const subject = await coverageSetup('Reopen scenario');
  const q = await subject.flow.planNextQuestion(subject.created.mapPath, subject.created.root.id, 'gpt-6-luna', 'low', 'reopen-question');
  const input = { requestId: 'reopen-answer', selections: [q.options[0].id], freeText: 'Persisted condition' };
  const first = await subject.flow.answerAndResearch(subject.created.mapPath, q.node.id, input, 'gpt-6-luna', 'low');
  const { MindSearchManualFlow } = load('experiences/mind-search/manual-flow.ts'); const { MindSearchRunStore } = load('mindsearch-mve/research-run-store.ts');
  const reopened = new MindSearchManualFlow(subject.repo, new MindSearchRunStore(subject.repo), async () => { throw new Error('Must reuse persisted answer'); });
  const result = await reopened.answerAndResearch(subject.created.mapPath, q.node.id, input, 'gpt-6-luna', 'low'); assert.equal(result.branchId, first.branchId);
});

integrationTest('MindSearch forces ask_user below the answer floor and repairs only the decision using saved reports', async () => {
  const { MindSearchManualFlow, MIN_ANSWERED_QUESTIONS_BEFORE_CONCLUSION } = load('experiences/mind-search/manual-flow.ts', { obsidian });
  const { parseMindSearchPlannerReview } = load('mindsearch-mve/planner-review.ts');
  const calls = [];
  const flow = new MindSearchManualFlow({ settings: { language: 'en' } }, {}, async context => {
    calls.push(context);
    assert.equal(context.researchMode, 'local');
    if (mindSearchPhase(context, 'decision-quality-review')) {
      return { summary: 'How much time can you spend?', detail: 'A useful conditional answer remains available.', suggestions: [{ title: 'Less than an hour', task: '', contribution: '' }], visualReferences: [] };
    }
    if (mindSearchPhase(context, 'format-repair')) {
      assert.match(context.task, /workflow has imposed decision=ask_user/);
      assert.match(context.task, /Exact original question to preserve: How much time can you spend\?/);
      assert.doesNotMatch(context.task, /Saved report one|Saved report two|Saved report three|Saved report four/);
      return plannerReview('ask_user', { rationale: 'Repaired rationale must be replaced.', question: 'A changed question?' }, 'Changed summary.', 'Changed body.', ['Less than an hour', 'One to two hours', 'More than two hours']);
    }
    throw new Error(`Unexpected research or Planner retry: ${context.task.slice(0, 120)}`);
  });
  const context = {
    goal: 'Plan a realistic routine', goalDetail: '', conditions: {}, currentQuestion: 'Do you exercise?', currentAnswer: 'Sometimes',
    answeredQuestionCount: 2, questionHistory: ['Do you exercise?'], lineage: '',
    reportSummary: 'Four independent Searcher reports are already saved.',
    reportDetail: ['Saved report one', 'Saved report two', 'Saved report three', 'Saved report four'].map((name, index) => `### ${name}\nIndependent persisted finding ${index + 1}.`).join('\n\n')
  };
  const candidate = parseMindSearchPlannerReview(plannerReview('conclude', { rationale: 'The research appears sufficient.', stopReason: 'No research gap.' }, 'Candidate conclusion.', 'Candidate answer.'));
  const review = await flow.reviewPlannerDecisionQuality(candidate, context, 'gpt-6-luna', 'low');
  assert.equal(review.decision, 'ask_user');
  assert.equal(review.question, 'How much time can you spend?');
  assert.equal(review.summary, 'How much time can you spend?');
  assert.equal(review.detail, 'A useful conditional answer remains available.');
  assert.equal(review.rationale, `The branch has 2 answered question node(s); at least ${MIN_ANSWERED_QUESTIONS_BEFORE_CONCLUSION} are required before conclusion.`);
  assert.equal(calls.length, 2, 'only the bounded correction and its local format repair ran');
  assert.equal(calls.some(call => call.researchMode === 'research'), false, 'completed research was not repeated');
  assert.ok(calls[0].task.includes(context.reportDetail), 'the original quality decision sees the four saved reports');

  calls.length = 0;
  const aboveFloor = await flow.reviewPlannerDecisionQuality(
    parseMindSearchPlannerReview(plannerReview('ask_user', { rationale: 'A genuinely missing condition remains.', question: 'What schedule works best?' }, 'Conditional answer.', 'Useful detail.', ['Morning', 'Evening'])),
    { ...context, answeredQuestionCount: 4 }, 'gpt-6-luna', 'low'
  );
  assert.equal(aboveFloor.decision, 'ask_user');
  assert.equal(calls.length, 0, 'the floor does not force another correction once the branch has enough answers');
});

integrationTest('MindSearch research-gap audit preserves classifications from four saved report summaries without reopening evidence', async () => {
  const { repo } = fixture();
  const { createMindSearchMap } = load('experiences/mind-search/create-map.ts');
  const created = await createMindSearchMap(repo, 'gpt-6-luna', { requestId: 'gap-audit-map', topic: 'Roast this specific chicken for dinner', context: 'We know the flavor direction and evening meal, but the exact chicken weight and serving time are not supplied.' });
  const { MindSearchRunStore } = load('mindsearch-mve/research-run-store.ts');
  const { MindSearchManualFlow } = load('experiences/mind-search/manual-flow.ts');
  const store = new MindSearchRunStore(repo); let searches = 0, audits = 0, corrections = 0;
  const flow = new MindSearchManualFlow(repo, store, async context => {
    if (mindSearchPhase(context, 'initial-question')) return { summary: 'Which flavor direction do you prefer?', detail: 'Synthetic user-condition question.', suggestions: [{ title: 'Herbs' }, { title: 'Citrus' }], visualReferences: [] };
    if (mindSearchPhase(context, 'research-plan')) return { summary: 'Two synthetic evidence targets.', detail: '<!-- mindsearch-plan {"subtopics":[{"id":"temperature","title":"Safe temperature","task":"Find official poultry temperature guidance.","expectedValue":"Keep the result safe."},{"id":"roast","title":"Roasting method","task":"Find a reliable roasting method.","expectedValue":"Support a practical method."}]} -->', suggestions: [], visualReferences: [] };
    if (mindSearchPhase(context, 'subtopic-research')) { searches++; return { summary: `Synthetic saved evidence ${searches}.`, detail: `Research status: search completed\nSynthetic source-backed report ${searches}.`, suggestions: [], visualReferences: [] }; }
    if (mindSearchPhase(context, 'report-review')) return plannerReview('research_more', { rationale: 'The specific bird weight and exact serving time were not provided; web search cannot establish either user-specific value.' }, 'Conditional roasting guidance is ready.', 'Preserve the temperature and method findings while obtaining the missing scenario values.', [{ title: 'Look up the bird weight and exact serving time', task: 'Search web recipes to infer the actual weight of this specific chicken and its exact dinner serving time.', contribution: 'These values would personalize the result.' }]);
    if (mindSearchPhase(context, 'research-gap-audit')) {
      audits++; assert.equal(context.researchMode, 'local');
      assert.match(context.task, /Known conditions on this branch only/);
      assert.match(context.task, /specific bird weight and exact serving time/);
      assert.doesNotMatch(context.task, /Sibling answer|unrelated branch condition/);
      return { summary: '此缺口屬於使用者條件。', detail: '實際雞重與上桌時間屬於這個分支的使用者情境，不能由網路來源查明。', suggestions: [], visualReferences: [] };
    }
    if (mindSearchPhase(context, 'decision-quality-review')) {
      corrections++; assert.equal(context.researchMode, 'local');
      assert.match(context.task, /Decision=ask_user is mandatory/);
      assert.doesNotMatch(context.task, /Research status: search completed\nSynthetic source-backed report/);
      return { summary: 'How much does this chicken weigh, and when must it be served?', detail: 'A conditional roasting answer remains supported by the saved temperature and method reports.', suggestions: [{ title: 'I can provide the weight and time' }, { title: 'I need help estimating them' }], visualReferences: [] };
    }
    throw new Error(`Unexpected MindSearch phase: ${context.task.slice(0, 100)}`);
  });
  const question = (await flow.planNextQuestion(created.mapPath, created.root.id, 'gpt-6-luna', 'low', 'gap-audit-initial-question')).node;
  const result = await flow.answerAndResearch(created.mapPath, question.id, { requestId: 'gap-audit-answer', selections: [question.mindSearchQuestion.options[0].id], freeText: 'Rosemary flavor; dinner in the evening.' }, 'gpt-6-luna', 'low');
  assert.equal(result.status, 'waiting-user');
  assert.equal(searches, 2, 'the classifier prevents the third Searcher pass for user-specific values');
  assert.equal(audits, 1); assert.equal(corrections, 1);
  const saved = await repo.readMap(created.mapPath), branch = saved.mindSearch.branches.find(item => item.id === result.branchId);
  const newQuestion = saved.nodes.find(item => item.id === result.questionNodeId);
  assert.equal(branch.results.filter(item => item.kind === 'research').length, 2, 'both original reports are preserved');
  assert.equal(newQuestion.mindSearchKind, 'question');
  assert.equal((await repo.readNote(newQuestion.path)).summary, 'How much does this chicken weigh, and when must it be served?');
  assert.deepEqual(plain(newQuestion.mindSearchQuestion.options.slice(0, 2).map(item => item.label)), ['I can provide the weight and time', 'I need help estimating them']);

  const { parseMindSearchPlannerReview } = load('mindsearch-mve/planner-review.ts');
  const genuineCandidate = parseMindSearchPlannerReview(plannerReview('research_more', { rationale: 'A source-backed poultry temperature standard remains unresolved.' }, 'A useful conditional result.', 'One external standard remains unverified.', [{ title: 'Official safe temperature', task: 'Find the authoritative poultry safe-temperature standard.', contribution: 'An official source may resolve the factual gap.' }]));
  let externalAuditCalls = 0;
  const externalAuditReplies = [
    {
      summary: '主要缺口屬外部證據：分量與調整方法可由可靠食譜來源查證。',
      detail: '候選缺口是香草、大蒜、奶油與香料的用量比例，以及依雞重或奶油鹹度調整的方法。這些是可透過定向搜尋烹飪來源查證的外部配方資訊，應分類為 external_evidence。分支已知全雞完全解凍、偏好香草大蒜與奶油香料，但這些條件不補足配方比例證據。本階段未進行網路搜尋，尚未核實比例。',
      suggestions: [], visualReferences: []
    },
    {
      summary: '主要缺口是外部配方證據；目前風味比例未獲可靠來源支持。',
      detail: 'Candidate research gap 指出，香草、大蒜、奶油與香料的具體用量及適用雞重尚無可靠依據。這是可透過針對食譜比例的來源搜尋查證的外部事實缺口，分類為 external_evidence。已完全解凍是已知個人條件，但與此缺口無關。',
      suggestions: [], visualReferences: []
    },
    {
      summary: 'external_evidence',
      detail: 'Saved branch reports do not establish the herb-to-butter ratio; a targeted source search can verify that external recipe fact.',
      suggestions: [], visualReferences: []
    }
  ];
  const externalFlow = new MindSearchManualFlow(repo, store, async context => {
    externalAuditCalls++;
    assert.equal(context.researchMode, 'local');
    assert.match(context.task, /Official safe temperature/);
    for (const savedSummary of ['Saved report 1: synthetic temperature guidance.', 'Saved report 2: synthetic roasting method.', 'Saved report 3: synthetic seasoning ratios.', 'Saved report 4: synthetic timing ranges.']) assert.equal(context.task.split(savedSummary).length - 1, 1, 'gap audit receives each saved report summary once');
    assert.doesNotMatch(context.task, /Omitted from gap audit context/);
    return externalAuditReplies.shift();
  });
  const externalContext = {
    goal: 'Roast poultry safely', goalDetail: '', conditions: { flavor: 'Rosemary' }, currentQuestion: 'How should it be cooked?', currentAnswer: 'Roast it.',
    answeredQuestionCount: 3, questionHistory: [], lineage: '', reportSummary: ['Saved report 1: synthetic temperature guidance.', 'Saved report 2: synthetic roasting method.', 'Saved report 3: synthetic seasoning ratios.', 'Saved report 4: synthetic timing ranges.'].join('\n'), reportDetail: 'Omitted from gap audit context.'
  };
  const retained = await externalFlow.reviewPlannerDecisionQuality(genuineCandidate, externalContext, 'gpt-6-luna', 'low');
  assert.equal(retained.decision, 'research_more', 'genuine external evidence gaps remain searchable');
  const retargeted = await externalFlow.reviewPlannerDecisionQuality(genuineCandidate, externalContext, 'gpt-6-luna', 'low');
  assert.equal(retargeted.decision, 'research_more', 'the alternate wording for the same enum remains searchable');
  const structured = await externalFlow.reviewPlannerDecisionQuality(genuineCandidate, externalContext, 'gpt-6-luna', 'low');
  assert.equal(structured.decision, 'research_more', 'the exact structured summary enum is accepted');
  assert.equal(externalAuditCalls, 3, 'captured natural-language and structured audit replies are accepted without a format-repair call');

  const savedFourReportSummary = externalContext.reportSummary;
  const liveConflict = {
    summary: 'user_condition',
    detail: '本階段只稽核候選缺口，不查網路。缺口是法式全雞食譜中香草、大蒜、奶油與香料的明確用量及依雞重調整方式，屬可由外部食譜來源查證的配方事實，因此應分類為 `external_evidence`。已知使用者偏好「香草與大蒜」及「奶油與香料」，且全雞已完全解凍；雞重未知只影響個別雞隻的烤時與按重量換算，並非此候選配方比例缺口的主要輸入。現有資料不足以核實任何具體比例。本階段結論應為 `external_evidence`，不應標記為 `user_condition`。',
    suggestions: [], visualReferences: []
  };
  const liveCorrectionQuote = '本階段結論應為 `external_evidence`，不應標記為 `user_condition`。';
  const selfCorrectionFlow = (repair) => {
    const calls = [];
    return {
      calls,
      flow: new MindSearchManualFlow(repo, store, async context => {
        calls.push(context);
        assert.equal(context.researchMode, 'local');
        if (mindSearchPhase(context, 'research-gap-audit')) return liveConflict;
        assert.ok(mindSearchPhase(context, 'research-gap-audit-conflict-extract'));
        assert.equal(context.title, 'MindSearch audit label extractor');
        assert.match(context.task, /Original audit summary:[\s\S]*user_condition/);
        assert.match(context.task, /Original audit detail:[\s\S]*本階段結論應為/);
        assert.doesNotMatch(context.task, /Roast poultry safely|Saved report [1-4]|Official safe temperature|Known conditions on this branch/);
        return repair(liveCorrectionQuote);
      })
    };
  };
  const wrongEnumExtraction = selfCorrectionFlow(quote => ({ summary: 'user_condition', detail: quote, suggestions: [], visualReferences: [] }));
  await assert.rejects(wrongEnumExtraction.flow.reviewPlannerDecisionQuality(genuineCandidate, externalContext, 'gpt-6-luna', 'low'), /could not extract the original audit self-correction exactly/);
  assert.deepEqual(wrongEnumExtraction.calls.map(context => mindSearchPhase(context, 'research-gap-audit') ? 'audit' : 'extract'), ['audit', 'extract']);
  const wrongQuoteExtraction = selfCorrectionFlow(quote => ({ summary: 'external_evidence', detail: quote.replace('external_evidence', 'external evidence'), suggestions: [], visualReferences: [] }));
  await assert.rejects(wrongQuoteExtraction.flow.reviewPlannerDecisionQuality(genuineCandidate, externalContext, 'gpt-6-luna', 'low'), /could not extract the original audit self-correction exactly/);
  assert.deepEqual(wrongQuoteExtraction.calls.map(context => mindSearchPhase(context, 'research-gap-audit') ? 'audit' : 'extract'), ['audit', 'extract']);
  const recoveredExtraction = selfCorrectionFlow(quote => ({ summary: 'external_evidence', detail: quote, suggestions: [], visualReferences: [] }));
  const recoveredDecision = await recoveredExtraction.flow.reviewPlannerDecisionQuality(genuineCandidate, externalContext, 'gpt-6-luna', 'low');
  assert.equal(recoveredDecision.decision, 'research_more');
  assert.deepEqual(recoveredExtraction.calls.map(context => mindSearchPhase(context, 'research-gap-audit') ? 'audit' : 'extract'), ['audit', 'extract']);
  assert.equal(externalContext.reportSummary, savedFourReportSummary, 'the failed extraction recovery reuses the same four saved report summaries without Searcher work');

  const reverseConflict = {
    summary: 'external_evidence',
    detail: '本階段結論應為 `user_condition`，不應標記為 `external_evidence`。',
    suggestions: [], visualReferences: []
  };
  const reverseFlow = new MindSearchManualFlow(repo, store, async context => {
    if (mindSearchPhase(context, 'research-gap-audit')) return reverseConflict;
    if (mindSearchPhase(context, 'research-gap-audit-conflict-extract')) return { summary: 'user_condition', detail: reverseConflict.detail, suggestions: [], visualReferences: [] };
    assert.ok(mindSearchPhase(context, 'decision-quality-review'));
    return { summary: 'Which weight should I use?', detail: 'The branch needs the user-provided chicken weight.', suggestions: [{ title: 'I will provide it' }, { title: 'Help me estimate it' }], visualReferences: [] };
  });
  const reverseDecision = await reverseFlow.reviewPlannerDecisionQuality(genuineCandidate, externalContext, 'gpt-6-luna', 'low');
  assert.equal(reverseDecision.decision, 'ask_user', 'the reverse summary/detail self-correction is recovered as user_condition');

  const affirmativeConflict = new MindSearchManualFlow(repo, store, async context => ({
    summary: 'user_condition', detail: '分類為 external_evidence；分類為 user_condition。', suggestions: [], visualReferences: []
  }));
  await assert.rejects(affirmativeConflict.reviewPlannerDecisionQuality(genuineCandidate, externalContext, 'gpt-6-luna', 'low'), /conflicting research-gap classifications/);

  const noRationaleFlow = new MindSearchManualFlow(repo, store, async () => ({ summary: 'external_evidence', detail: '', suggestions: [], visualReferences: [] }));
  await assert.rejects(noRationaleFlow.reviewPlannerDecisionQuality(genuineCandidate, externalContext, 'gpt-6-luna', 'low'), /empty research-gap rationale/);

  let invalidGapCalls = 0;
  const invalidGapRepair = new MindSearchManualFlow(repo, store, async context => {
    invalidGapCalls++;
    assert.equal(context.researchMode, 'local');
    assert.doesNotMatch(context.task, /Do not include this report in the repair context/);
    if (mindSearchPhase(context, 'research-gap-audit')) return { summary: 'The actual chicken weight is a private scenario value.', detail: 'No public source can establish this value.', suggestions: [], visualReferences: [] };
    throw new Error('No classification was selected, so no format repair or search is allowed.');
  });
  await assert.rejects(invalidGapRepair.reviewPlannerDecisionQuality(genuineCandidate, {
    goal: 'Roast poultry safely', goalDetail: '', conditions: {}, currentQuestion: 'How should it be cooked?', currentAnswer: 'Roast it.',
    answeredQuestionCount: 3, questionHistory: [], lineage: '', reportSummary: 'Saved report summaries are not part of the format repair.', reportDetail: 'Do not include this report in the repair context.'
  }, 'gpt-6-luna', 'low'), /could not classify the research gap from an explicit audit decision/);
  assert.equal(invalidGapCalls, 1, 'an audit without an explicit class fails closed without another model call or Searcher');

  let quoteRepairCalls = 0;
  const quoteOnlyRepair = new MindSearchManualFlow(repo, store, async context => {
    assert.equal(context.researchMode, 'local');
    assert.doesNotMatch(context.task, /Omitted from gap audit context/);
    if (mindSearchPhase(context, 'research-gap-audit')) return { summary: 'The user_condition enum is the original audit choice.', detail: 'The user_condition enum is the original audit choice.', suggestions: [], visualReferences: [] };
    if (mindSearchPhase(context, 'research-gap-audit-format-only')) {
      assert.doesNotMatch(context.task, /Saved report 1|Research status|full report/i);
      quoteRepairCalls++;
      return { summary: 'user_condition', detail: 'The user_condition enum is the original audit choice.', suggestions: [], visualReferences: [] };
    }
    assert.ok(mindSearchPhase(context, 'decision-quality-review'));
    return plannerReview('ask_user', { rationale: 'The actual scenario weight is a user-specific condition.', question: 'What is the chicken weight?' }, 'Keep the conditional evidence summary.', 'Do not infer a weight.', ['1 kg', '2 kg']);
  });
  const quoted = await quoteOnlyRepair.reviewPlannerDecisionQuality(genuineCandidate, externalContext, 'gpt-6-luna', 'low');
  assert.equal(quoted.decision, 'ask_user');
  assert.equal(quoteRepairCalls, 1, 'one quote-only formatting call preserves the sole original class token');

  const changedClassRepair = new MindSearchManualFlow(repo, store, async context => mindSearchPhase(context, 'research-gap-audit')
    ? { summary: 'The user_condition enum is the original audit choice.', detail: 'The user_condition enum is the original audit choice.', suggestions: [], visualReferences: [] }
    : { summary: 'external_evidence', detail: 'The user_condition enum is the original audit choice.', suggestions: [], visualReferences: [] });
  await assert.rejects(changedClassRepair.reviewPlannerDecisionQuality(genuineCandidate, externalContext, 'gpt-6-luna', 'low'), /without changing it/);

  let negativeCalls = 0;
  const negativeClassFlow = new MindSearchManualFlow(repo, store, async context => {
    negativeCalls++;
    assert.equal(context.researchMode, 'local');
    if (mindSearchPhase(context, 'research-gap-audit')) return { summary: 'The audit does not select an external class.', detail: 'The gap is not classified as external_evidence.', suggestions: [], visualReferences: [] };
    throw new Error('Negated labels must not reach formatting or Searcher.');
  });
  await assert.rejects(negativeClassFlow.reviewPlannerDecisionQuality(genuineCandidate, externalContext, 'gpt-6-luna', 'low'), /negated research-gap classification/);
  assert.equal(negativeCalls, 1, 'a negated class mention fails before format repair or search');

  const mixedPolarityFlow = new MindSearchManualFlow(repo, store, async () => ({
    summary: 'external_evidence',
    detail: 'The gap is not classified as user_condition; it is classified as external_evidence because a source can establish the fact.',
    suggestions: [], visualReferences: []
  }));
  const mixedPolarity = await mixedPolarityFlow.reviewPlannerDecisionQuality(genuineCandidate, externalContext, 'gpt-6-luna', 'low');
  assert.equal(mixedPolarity.decision, 'research_more', 'a negated alternate class does not hide the single positive classification');

  const samePolarityConflict = new MindSearchManualFlow(repo, store, async () => ({
    summary: 'external_evidence',
    detail: 'It is not classified as external_evidence, but classification is external_evidence.',
    suggestions: [], visualReferences: []
  }));
  await assert.rejects(samePolarityConflict.reviewPlannerDecisionQuality(genuineCandidate, externalContext, 'gpt-6-luna', 'low'), /positive and negated evidence/);

  const conflictingGap = new MindSearchManualFlow(repo, store, async context => ({
    summary: '',
    detail: `${researchGapAudit('external_evidence', 'An external fact needs a source.').detail}\n<!-- mindsearch-gap-audit ${JSON.stringify({ classification: 'user_condition', rationale: 'A scenario value is missing.' })} -->`,
    suggestions: [], visualReferences: []
  }));
  await assert.rejects(conflictingGap.reviewPlannerDecisionQuality(genuineCandidate, {
    goal: 'Roast poultry safely', goalDetail: '', conditions: {}, currentQuestion: 'How should it be cooked?', currentAnswer: 'Roast it.',
    answeredQuestionCount: 3, questionHistory: [], lineage: '', reportSummary: '', reportDetail: ''
  }, 'gpt-6-luna', 'low'), /multiple research-gap markers/);

  const duplicateFlow = new MindSearchManualFlow(repo, store, async context => mindSearchPhase(context, 'research-gap-audit')
    ? researchGapAudit('user_condition', 'A user-specific condition remains unknown.')
    : { summary: 'Which flavor direction do you prefer?', detail: 'Conditional answer.', suggestions: [{ title: 'Herbs' }, { title: 'Citrus' }], visualReferences: [] });
  await assert.rejects(duplicateFlow.reviewPlannerDecisionQuality(genuineCandidate, {
    goal: 'Roast poultry safely', goalDetail: '', conditions: {}, currentQuestion: 'Which flavor direction do you prefer?', currentAnswer: 'Herbs.',
    answeredQuestionCount: 3, questionHistory: ['Which flavor direction do you prefer?'], lineage: '', reportSummary: '', reportDetail: ''
  }, 'gpt-6-luna', 'low'), /without repeating a prior question/);
});

integrationTest('MindSearch retries failed decision formatting from four saved reports and commits the next question', async () => {
  const { repo } = fixture();
  const { createMindSearchMap } = load('experiences/mind-search/create-map.ts');
  const created = await createMindSearchMap(repo, 'gpt-6-luna', { requestId: 'forced-ask-map', topic: 'Plan a realistic routine', context: 'Synthetic test scenario.' });
  const { MindSearchRunStore } = load('mindsearch-mve/research-run-store.ts');
  const { MindSearchManualFlow } = load('experiences/mind-search/manual-flow.ts', { obsidian });
  let saved = await repo.readMap(created.mapPath);
  const earlier = await repo.createNote('Earlier answered condition', 'gpt-6-luna', saved, created.mapPath, 'workspace');
  earlier.mindSearchKind = 'question';
  earlier.mindSearchQuestion = { requestId: 'earlier-question', parentBranchId: null, options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }], allowMultiple: false, allowFreeText: true };
  const question = await repo.createNote('Current question', 'gpt-6-luna', saved, created.mapPath, 'workspace');
  question.mindSearchKind = 'question';
  question.mindSearchQuestion = { requestId: 'current-question', parentBranchId: 'earlier-answer', options: [{ id: 'some', label: 'Sometimes' }, { id: 'rare', label: 'Rarely' }], allowMultiple: false, allowFreeText: true };
  await repo.updateNote(question.path, { summary: 'Do you exercise regularly?' });
  saved.nodes.push(earlier, question);
  saved.mindSearch.branches.push({ id: 'earlier-answer', questionNodeId: earlier.id, parentBranchId: null, answerSnapshot: { selections: ['yes'], freeText: 'Synthetic prior condition.' }, inputSnapshot: { topic: saved.title, conditions: { 'Do you exercise?': 'Yes' }, upstreamResults: [] }, createdAt: '2026-10-09T00:00:00.000Z', results: [] });
  await repo.saveMap(created.mapPath, saved);

  const plan = Array.from({ length: 4 }, (_, index) => ({ id: `target-${index + 1}`, title: `Research dimension ${index + 1}`, task: `Search distinct dimension ${index + 1}.`, expectedValue: `Resolve uncertainty ${index + 1}.` }));
  const exactQuestion = 'How much time can you spend each day?';
  const calls = []; let researchCalls = 0, repairCalls = 0;
  const flow = new MindSearchManualFlow(repo, new MindSearchRunStore(repo), async context => {
    calls.push(context);
    if (mindSearchPhase(context, 'research-plan')) return { summary: 'Four complementary research dimensions.', detail: `<!-- mindsearch-plan ${JSON.stringify({ subtopics: plan })} -->`, suggestions: [], visualReferences: [] };
    if (mindSearchPhase(context, 'subtopic-research')) {
      researchCalls++;
      const target = plan.find(item => context.task.includes(item.title));
      return { summary: `${target.title} finding.`, detail: `Research status: search completed\nIndependent persisted finding for ${target.title}.`, suggestions: [], visualReferences: [] };
    }
    if (mindSearchPhase(context, 'report-review')) return plannerReview('conclude', { rationale: 'The four reports appear sufficient.', stopReason: 'Research review ended.' }, 'Candidate conclusion.', 'Candidate conditional answer.');
    if (mindSearchPhase(context, 'decision-quality-review')) return { summary: 'Could this plan be more ambitious?', detail: `Question: ${exactQuestion}\n\nThe useful conditional answer remains intact.`, suggestions: [{ title: 'Under 30 minutes', task: '', contribution: '' }], visualReferences: [] };
    if (mindSearchPhase(context, 'format-repair')) {
      repairCalls++;
      assert.match(context.task, /workflow has imposed decision=ask_user/);
      assert.ok(context.task.includes(`Exact original question to preserve: ${exactQuestion}`));
      assert.doesNotMatch(context.task, /Research dimension [1-4]|Independent persisted finding/);
      if (repairCalls === 1) return plannerReview('conclude', { rationale: 'Repairer must not change this decision.', stopReason: 'Forbidden.' }, 'Changed.', 'Changed.');
      return plannerReview('ask_user', { rationale: 'A user condition changes the routine.', question: 'Changed question?' }, 'Changed summary.', 'Changed body.', ['Under 30 minutes', '30 to 60 minutes', 'Over 60 minutes']);
    }
    throw new Error(`Unexpected AI phase or research retry: ${context.task.slice(0, 140)}`);
  });

  const input = { requestId: 'forced-ask-answer', selections: ['some'], freeText: 'Synthetic answer about current availability.' };
  await assert.rejects(() => flow.answerAndResearch(created.mapPath, question.id, input, 'gpt-6-luna', 'low'), /changed or omitted the required ask_user decision/);
  saved = await repo.readMap(created.mapPath);
  const branch = saved.mindSearch.branches.find(item => item.submissionId === input.requestId);
  assert.ok(branch);
  assert.deepEqual(Array.from(branch.results.filter(item => item.kind === 'research'), item => item.subtopicId), plan.map(item => item.id));
  assert.ok(saved.mindSearch.runs.filter(item => item.branchId === branch.id).flatMap(item => item.attempts).some(attempt => attempt.status === 'failed'), 'the failed decision attempt remains recorded');
  assert.equal(researchCalls, 4);

  const outcome = await flow.answerAndResearch(created.mapPath, question.id, input, 'gpt-6-luna', 'low');
  assert.equal(outcome.status, 'waiting-user');
  assert.equal(researchCalls, 4, 'retry reused all four saved reports and ran no Searcher calls');
  assert.equal(repairCalls, 2);
  saved = await repo.readMap(created.mapPath);
  const nextQuestion = saved.nodes.find(item => item.id === outcome.questionNodeId);
  assert.equal(nextQuestion.mindSearchKind, 'question');
  assert.equal(await repo.readNote(nextQuestion.path).then(note => note.summary), exactQuestion);
  assert.equal(nextQuestion.mindSearchQuestion.parentBranchId, branch.id);
  assert.equal(saved.mindSearch.branches.find(item => item.id === branch.id).results.filter(item => item.kind === 'research').length, 4);
  const reviewCalls = calls.filter(context => mindSearchPhase(context, 'report-review'));
  assert.equal(reviewCalls.length, 2);
  assert.ok(reviewCalls.every(context => plan.every(item => context.detail.includes(item.title))), 'both decision attempts reused the four independently saved reports');
});

integrationTest('MindSearch request deduplication preserves unique evidence and leaves original context intact', () => {
  const { deduplicateMindSearchRequest } = load('experiences/mind-search/request-context.ts');
  const report = 'Complete report evidence '.repeat(100);
  const unique = 'Distinct evidence '.repeat(100);
  const context = { task: report, detail: report + '\n\n' + unique, ancestors: 'Ancestor header\n' + report, title: 'Original topic' };
  const prepared = deduplicateMindSearchRequest(context);
  assert.equal(prepared.task, report);
  assert.ok(prepared.detail.includes(unique));
  assert.ok(!prepared.detail.includes(report));
  assert.ok(!prepared.ancestors.includes(report));
  assert.equal(context.detail, report + '\n\n' + unique);
  assert.equal(context.ancestors, 'Ancestor header\n' + report);
});

integrationTest('coverage: third answer researches first and conflicting responsibility keeps exploration open', async () => {
  const subject = await coverageSetup('Conflicting operations responsibilities', { clarifyConflict: true });
  const outcome = await coverageThreeAnswers(subject);
  assert.equal(outcome.status, 'waiting-user');
  const saved = await subject.repo.readMap(subject.created.mapPath);
  const branch = saved.mindSearch.branches.find(b => b.id === outcome.branchId);
  assert.equal(branch.results.filter(r => r.kind === 'research').length, 2);
  assert.equal(branch.results.some(r => r.kind === 'conclusion'), false);
  assert.equal(subject.model.phases.includes('saved-evidence-review'), false);
  assert.equal(subject.model.phases.some(p => p?.startsWith('delivery-')), false);
  assert.match((await subject.repo.readNote(saved.nodes.find(n => n.id === outcome.questionNodeId).path)).summary, /occasional contributor|primary operations owner/i);
});

integrationTest('Prompt monitor preserves exact Claude prompts, phases and separate steering requests after reload', async () => {
  const { AiExchangeLog, promptMetrics } = load('ai-exchange-log.ts');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vam-prompt-monitor-'));
  try {
    const file = path.join(directory, 'log.json');
    const log = new AiExchangeLog(file, error => assert.fail(String(error)));
    log.begin({ id: 'one', startedAt: new Date().toISOString(), topic: 'Research', mode: 'task', model: 'claude', effort: 'high' });
    const prompt = '<!-- mindsearch-phase: research-plan -->\n完整指令\nprivate context';
    log.sent('one', JSON.stringify({ input: '<VAM prompt via stdin>' }), prompt);
    log.sent('one', JSON.stringify({ input: [{ type: 'text', text: 'Stop and use existing evidence' }] }));
    log.completed('one'); await log.flush();
    const restored = new AiExchangeLog(file, error => assert.fail(String(error))); await restored.load();
    const entries = restored.getEntries(); assert.equal(entries.length, 2);
    assert.equal(promptMetrics(entries[0]).prompt, prompt);
    assert.equal(promptMetrics(entries[0]).phase, 'research-plan');
    assert.equal(promptMetrics(entries[0]).characters, Array.from(prompt).length);
    assert.equal(promptMetrics(entries[1]).prompt, 'Stop and use existing evidence');
    assert.equal(entries[1].mode, 'steer');
    assert.ok(promptMetrics(entries[0]).estimatedTokens > 0);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

integrationTest('MindSearch reconciles a repeated weight question against the original recipe target and saves the next step', async () => {
  const { repo } = fixture();
  const { createMindSearchMap } = load('experiences/mind-search/create-map.ts');
  const { MindSearchRunStore } = load('mindsearch-mve/research-run-store.ts');
  const { MindSearchManualFlow } = load('experiences/mind-search/manual-flow.ts');
  const created = await createMindSearchMap(repo, 'gpt-6-luna', { requestId: 'range-reconcile-map', topic: 'Prepare a herb roast chicken', context: 'Synthetic range-answer regression.' });
  let searches = 0, reviews = 0, reconciliations = 0, corrections = 0;
  const target = { title: 'Small-chicken herb butter recipe', task: 'Find a published recipe for a chicken below 1.5 kg with herb, garlic and butter quantities.', contribution: 'Verify published ingredient ratios for a small bird.' };
  const plan = ['recipe', 'method', 'doneness'].map(id => ({ id, title: id, task: `Find ${id} evidence.`, expectedValue: `Support ${id}.` }));
  const flow = new MindSearchManualFlow(repo, new MindSearchRunStore(repo), async context => {
    if (mindSearchPhase(context, 'initial-question')) return { summary: 'How much does the chicken weigh?', detail: 'Choose a range.', suggestions: [{ title: 'Below 1.5 kg' }, { title: 'Above 1.5 kg' }], visualReferences: [] };
    if (mindSearchPhase(context, 'research-plan')) return { summary: 'Plan', detail: `<!-- mindsearch-plan ${JSON.stringify({ subtopics: plan })} -->`, suggestions: [], visualReferences: [] };
    if (mindSearchPhase(context, 'subtopic-research')) { searches++; return { summary: `Saved evidence ${searches}`, detail: `Research status: search completed\nSaved evidence ${searches}.`, suggestions: [], visualReferences: [] }; }
    if (mindSearchPhase(context, 'report-review')) {
      reviews++;
      if (reviews === 1) return plannerReview('research_more', { rationale: 'The exact weight is not known, and the small-bird recipe ratios still need a published source.' }, 'A conditional method is available.', 'Preserve the saved evidence.', [target]);
      return plannerReview('ask_user', { rationale: 'Oven mode changes the practical instructions.', question: 'Which oven mode will you use?' }, 'Recipe evidence now saved.', 'Keep all four reports.', ['Fan', 'Conventional']);
    }
    if (mindSearchPhase(context, 'research-gap-audit')) {
      if (context.task.includes('TARGET-ONLY RECONCILIATION')) {
        reconciliations++;
        assert.ok(context.task.includes(target.task));
        assert.doesNotMatch(context.task, /Candidate research gap|Saved evidence/);
        return { summary: 'external_evidence', detail: 'A published recipe for the supplied weight range is an external fact; the target does not ask for the actual weight.', suggestions: [], visualReferences: [] };
      }
      return { summary: 'user_condition', detail: 'The exact weight of this particular bird cannot be found online.', suggestions: [], visualReferences: [] };
    }
    if (mindSearchPhase(context, 'decision-quality-review')) {
      corrections++;
      assert.match(context.task, /Earlier user questions in this path/);
      return plannerReview('ask_user', { rationale: 'More precise weight is needed.', question: 'How much does the chicken weigh?' }, 'Conditional method.', 'Existing reports remain valid.', ['Below 1 kg', '1 to 1.2 kg', '1.2 to 1.5 kg']);
    }
    if (mindSearchPhase(context, 'targeted-followup-research')) {
      searches++; assert.ok(context.task.includes(target.task));
      return { summary: 'Published small-bird recipe found.', detail: 'Research status: search completed\nPublished recipe quantities and limitations.', suggestions: [], visualReferences: [] };
    }
    throw new Error(`Unexpected phase: ${context.task.slice(0, 150)}`);
  });
  const question = (await flow.planNextQuestion(created.mapPath, created.root.id, 'gpt-6-luna', 'low', 'range-reconcile-question')).node;
  const saved = await repo.readMap(created.mapPath);
  const prior = await repo.createNote('Earlier condition', 'gpt-6-luna', saved, created.mapPath, 'workspace');
  prior.mindSearchKind = 'question'; saved.nodes.push(prior);
  saved.mindSearch.branches.push({ id: 'range-prior', questionNodeId: prior.id, parentBranchId: null, answerSnapshot: { selections: [], freeText: 'Known' }, inputSnapshot: { topic: saved.title, conditions: { flavor: 'Herbs' }, upstreamResults: [] }, createdAt: new Date().toISOString(), results: [] });
  saved.nodes.find(n => n.id === question.id).mindSearchQuestion.parentBranchId = 'range-prior';
  await repo.saveMap(created.mapPath, saved);
  const result = await flow.answerAndResearch(created.mapPath, question.id, { requestId: 'range-reconcile-answer', selections: [question.mindSearchQuestion.options[0].id], freeText: '' }, 'gpt-6-luna', 'low');
  assert.equal(result.status, 'waiting-user');
  assert.equal(searches, 4, 'three original reports and one bounded follow-up, no repeated original search');
  assert.equal(reconciliations, 1); assert.equal(corrections, 1);
  const after = await repo.readMap(created.mapPath);
  const branch = after.mindSearch.branches.find(b => b.id === result.branchId);
  assert.equal(branch.results.filter(r => r.kind === 'research').length, 3);
  assert.equal(await repo.readNote(after.nodes.find(n => n.id === result.questionNodeId).path).then(n => n.summary), 'Which oven mode will you use?');
  assert.ok(after.mindSearch.runs.filter(r => r.branchId === branch.id).every(r => r.attempts.every(a => a.status !== 'failed')));
});

integrationTest('MindSearch target reconciliation keeps private values local and bounds clarification recovery', async () => {
  const { repo } = fixture();
  const { MindSearchManualFlow } = load('experiences/mind-search/manual-flow.ts');
  const { MindSearchRunStore } = load('mindsearch-mve/research-run-store.ts');
  const { parseMindSearchPlannerReview } = load('mindsearch-mve/planner-review.ts');
  const candidate = parseMindSearchPlannerReview(plannerReview('research_more', { rationale: 'The supplied weight range is insufficient for the requested exact calculation.' }, 'Conditional guidance.', 'Preserve this body.', [{ title: 'Actual weight', task: 'Establish the exact weight of this user-owned item.', contribution: 'Enable the requested exact calculation.' }]));
  const context = { goal: 'Calculate exact quantities', goalDetail: '', conditions: { 'What is its weight?': 'Below 1.5 kg' }, currentQuestion: 'What is its weight?', currentAnswer: 'Below 1.5 kg', answeredQuestionCount: 3, questionHistory: ['What is its weight?'], lineage: '', reportSummary: 'Saved public guidance.', reportDetail: '' };
  let audits = 0, questions = 0;
  const flow = new MindSearchManualFlow(repo, new MindSearchRunStore(repo), async task => {
    assert.equal(task.researchMode, 'local', 'no web search for the private value');
    if (mindSearchPhase(task, 'research-gap-audit')) { audits++; return { summary: 'user_condition', detail: 'This target explicitly requires the exact private weight; a published range cannot supply it.', suggestions: [], visualReferences: [] }; }
    questions++;
    return plannerReview('ask_user', { rationale: 'Exact calculation needs more precision than the supplied range.', question: questions === 1 ? 'What is its weight?' : 'Can you provide the exact label weight for this calculation?' }, 'Question', 'No replacement assumptions.', ['1.1 kg', '1.3 kg', 'Exact weight unavailable']);
  });
  const result = await flow.reviewPlannerDecisionQuality(candidate, context, 'gpt-6-luna', 'low');
  assert.equal(result.decision, 'ask_user'); assert.equal(audits, 2); assert.equal(questions, 2);
  assert.equal(result.question, 'Can you provide the exact label weight for this calculation?');
  assert.equal(result.detail, 'Preserve this body.'); assert.ok(result.answerOptions.includes('Exact weight unavailable'));

  let rejectedCalls = 0;
  const invalid = new MindSearchManualFlow(repo, new MindSearchRunStore(repo), async task => {
    rejectedCalls++; assert.equal(task.researchMode, 'local');
    return mindSearchPhase(task, 'research-gap-audit')
      ? { summary: 'user_condition', detail: 'The private exact weight is required.', suggestions: [], visualReferences: [] }
      : plannerReview('ask_user', { rationale: 'Weight is needed.', question: 'What is its weight?' }, 'Question', 'Body.', ['Small', 'Large']);
  });
  await assert.rejects(invalid.reviewPlannerDecisionQuality(candidate, context, 'gpt-6-luna', 'low'), /without repeating a prior question/);
  assert.equal(rejectedCalls, 4, 'one reconciliation and one clarification retry, then stop');

  const controller = new AbortController(); let cancelledCalls = 0;
  const cancelled = new MindSearchManualFlow(repo, new MindSearchRunStore(repo), async task => {
    cancelledCalls++;
    if (mindSearchPhase(task, 'research-gap-audit')) return { summary: 'user_condition', detail: 'A private value is required.', suggestions: [], visualReferences: [] };
    controller.abort();
    return plannerReview('ask_user', { rationale: 'More precision.', question: 'What is its weight?' }, 'Question', 'Body.', ['Small', 'Large']);
  });
  await assert.rejects(cancelled.reviewPlannerDecisionQuality(candidate, context, 'gpt-6-luna', 'low', controller.signal));
  assert.equal(cancelledCalls, 2, 'cancellation prevents reconciliation or another provider call');
});


integrationTest('MindSearch delivery timeout persists stages and resumes writing after reload without repeating research', async () => {
  const subject = await coverageSetup('Delivery timeout recovery');
  const original = subject.model.ask;
  let failWriting = true;
  const calls = [];
  const ask = async context => {
    const phase = context.task.match(/mindsearch-phase:\s*([a-z-]+)/)?.[1]; calls.push({ phase, timeout: context.timeoutMs });
    if (phase === 'delivery-writing' && failWriting) throw new Error('AI 任務超過 3 分鐘');
    return original(context);
  };
  const { MindSearchManualFlow } = load('experiences/mind-search/manual-flow.ts');
  const { MindSearchRunStore } = load('mindsearch-mve/research-run-store.ts');
  subject.flow = new MindSearchManualFlow(subject.repo, new MindSearchRunStore(subject.repo), ask);
  await assert.rejects(coverageThreeAnswers(subject), /超過 3 分鐘/);
  let map = await subject.repo.readMap(subject.created.mapPath);
  const branch = map.mindSearch.branches.at(-1);
  assert.equal(branch.deliveryRecovery.phase, 'delivery-writing');
  assert.ok(branch.deliveryRecovery.checkpoint.outline);
  assert.ok(branch.deliveryRecovery.checkpoint.research);
  assert.equal(branch.deliveryRecovery.checkpoint.draft, undefined);
  const before = calls.length;
  const runs = new MindSearchRunStore(subject.repo);
  await runs.configureRetryTimeout(subject.created.mapPath, branch.id, 600_000);
  failWriting = false;
  const reopened = new MindSearchManualFlow(subject.repo, runs, ask);
  const outcome = await reopened.resumeAnswerResearch(subject.created.mapPath, branch.id, 'gpt-6-luna', 'low');
  assert.equal(outcome.status, 'completed');
  const resumed = calls.slice(before);
  assert.deepEqual(resumed.map(item => item.phase), ['delivery-writing', 'delivery-acceptance']);
  assert.ok(resumed.every(item => item.timeout === 600_000));
  map = await subject.repo.readMap(subject.created.mapPath);
  assert.ok(map.mindSearch.branches.at(-1).results.some(result => result.kind === 'conclusion'));
  const handle = await runs.startAttempt(subject.created.mapPath, branch.id, undefined, { model: 'gpt-6-luna', reasoning: 'low', maxResearchTurns: 1 });
  await runs.cancelAttempt(subject.created.mapPath, handle, 'Cancelled');
  await assert.rejects(runs.saveDeliveryRecovery(subject.created.mapPath, handle, branch.deliveryRecovery), /no longer current/);
  await assert.rejects(runs.configureRetryTimeout(subject.created.mapPath, branch.id, 999999), /Invalid retry timeout/);
});

integrationTest('AI task timeout override reaches both providers with accurate non-Coffee timeout text', async () => {
  const { AiTaskService } = load('core/ai-task-service.ts');
  for (const model of ['gpt-6-luna', 'claude:sonnet']) {
    let seen;
    const runtime = { runTask: async (_p, _m, _e, _s, controls) => { seen = controls; return JSON.stringify({summary:'S',detail:'D',suggestions:[],visualReferences:[]}); } };
    const service = new AiTaskService({ pluginDirectory:()=>'/plugin', language:()=> 'en', defaultReasoning:()=> 'low', exchangeLoggingEnabled:()=>false, exchanges:()=>null, codexRuntime:()=>runtime, claudeRuntime:()=>runtime });
    const context = { title:'Goal', summary:'', rules:'', detail:'', task:'Write', ancestors:'', mode:'task', researchMode:'local', timeoutMs:600_000 };
    await service.askModel(context, model, 'low');
    assert.equal(seen.timeoutMs, 600_000);
    assert.match(seen.timeoutMessage, /10 minutes/);
    assert.ok(!seen.timeoutMessage.includes('Coffee'));
    await service.askModel({...context,timeoutMs:undefined}, model, 'low');
    assert.equal(seen.timeoutMs, undefined);
  }
});

integrationTest('MindSearch delivery resume retains turn-two follow-up evidence and invalidates changed source reports', async () => {
  for (const changeSource of [false, true]) {
    const subject = await coverageSetup(`Turn-two delivery recovery ${changeSource}`);
    const original = subject.model.ask, calls = [];
    let needsFollowup = true, failWriting = true;
    const ask = async context => {
      const phase = context.task.match(/mindsearch-phase:\s*([a-z-]+)/)?.[1]; calls.push(context);
      if (phase === 'report-review' && /Hard floor: 3/.test(context.task) && needsFollowup) {
        needsFollowup = false;
        return plannerReview('research_more', {rationale:'Need one concrete example.'}, 'Gap', 'Gap', [{title:'Example',task:'Verify an example.',contribution:'Resolve example gap.'}]);
      }
      if (phase === 'research-gap-audit') return {summary:'external_evidence',detail:'The concrete example can be externally checked.',suggestions:[],visualReferences:[]};
      if (phase === 'targeted-followup-research') return {summary:'Unique followup',detail:'Research status: search completed\nUNIQUE_FOLLOWUP_EVIDENCE https://example.org/followup',suggestions:[],visualReferences:[]};
      if (phase === 'delivery-writing' && failWriting) throw new Error('timeout');
      return original(context);
    };
    const { MindSearchManualFlow } = load('experiences/mind-search/manual-flow.ts');
    const { MindSearchRunStore } = load('mindsearch-mve/research-run-store.ts');
    subject.flow = new MindSearchManualFlow(subject.repo, new MindSearchRunStore(subject.repo), ask);
    await assert.rejects(coverageThreeAnswers(subject), /timeout/);
    const map = await subject.repo.readMap(subject.created.mapPath), branch = map.mindSearch.branches.at(-1);
    assert.equal(branch.deliveryRecovery.researchTurn, 2);
    assert.ok(branch.deliveryRecovery.reports.detail.includes('UNIQUE_FOLLOWUP_EVIDENCE'));
    if (changeSource) {
      const path = branch.results.find(r => r.kind === 'research').notePath;
      const note = await subject.repo.readNote(path);
      await subject.repo.updateNote(path, {detail: note.detail + '\nCHANGED_SOURCE'});
    }
    const before = calls.length; failWriting = false;
    const reopened = new MindSearchManualFlow(subject.repo, new MindSearchRunStore(subject.repo), ask);
    const outcome = await reopened.resumeAnswerResearch(subject.created.mapPath, branch.id, 'gpt-6-luna','low');
    assert.equal(outcome.status,'completed');
    const phases = calls.slice(before).map(c => c.task.match(/mindsearch-phase:\s*([a-z-]+)/)?.[1]);
    if (!changeSource) {
      assert.deepEqual(phases, ['delivery-writing','delivery-acceptance']);
      assert.ok(calls.slice(before)[0].task.includes('UNIQUE_FOLLOWUP_EVIDENCE'));
    } else {
      assert.ok(phases.includes('report-review'));
      assert.ok(!phases.includes('delivery-outline'), 'the unchanged document outline is retained while affected sections are revalidated');
      assert.ok(calls.slice(before).some(c => c.detail.includes('CHANGED_SOURCE')));
    }
  }
});

integrationTest('MindSearch resumed delivery acceptance can request fresh evidence instead of reusing old checkpoints', async () => {
  const subject = await coverageSetup('Acceptance continuation adds fresh evidence');
  const original = subject.model.ask, calls = [];
  let failAcceptance = true, requestGap = true;
  const ask = async context => {
    const phase = context.task.match(/mindsearch-phase:\s*([a-z-]+)/)?.[1]; calls.push(context);
    if (phase === 'delivery-acceptance' && failAcceptance) throw new Error('timeout at acceptance');
    if (phase === 'delivery-acceptance' && requestGap) {
      requestGap = false;
      return plannerReview('research_more', {rationale:'A concrete reference is missing.'}, 'Gap', 'Need reference', [{title:'Reference',task:'Verify a concrete reference.',contribution:'Complete the document.'}]);
    }
    if (phase === 'research-gap-audit') return {summary:'external_evidence',detail:'The reference needs source verification.',suggestions:[],visualReferences:[]};
    if (phase === 'targeted-followup-research') return {summary:'Fresh reference',detail:'Research status: search completed\nFRESH_ACCEPTANCE_EVIDENCE https://example.org/fresh',suggestions:[],visualReferences:[]};
    return original(context);
  };
  const { MindSearchManualFlow } = load('experiences/mind-search/manual-flow.ts');
  const { MindSearchRunStore } = load('mindsearch-mve/research-run-store.ts');
  subject.flow = new MindSearchManualFlow(subject.repo, new MindSearchRunStore(subject.repo), ask);
  await assert.rejects(coverageThreeAnswers(subject), /timeout at acceptance/);
  const branch = (await subject.repo.readMap(subject.created.mapPath)).mindSearch.branches.at(-1);
  const before = calls.length; failAcceptance = false;
  const reopened = new MindSearchManualFlow(subject.repo, new MindSearchRunStore(subject.repo), ask);
  const outcome = await reopened.resumeAnswerResearch(subject.created.mapPath, branch.id, 'gpt-6-luna','low');
  assert.equal(outcome.status,'completed');
  const resumed = calls.slice(before);
  assert.ok(mindSearchPhase(resumed[0], 'delivery-acceptance'));
  assert.equal(resumed.filter(c => mindSearchPhase(c,'delivery-writing')).length,1);
  const laterWriter = resumed.find(c => mindSearchPhase(c,'delivery-writing'));
  assert.ok(laterWriter.task.includes('FRESH_ACCEPTANCE_EVIDENCE'));
});


integrationTest('MindSearch final acceptance pins the complete review marker to detail for both providers', async () => {
  const { AiTaskService } = load('core/ai-task-service.ts');
  const marker = '<!-- mindsearch-review {"decision":"conclude","rationale":"Source-backed document is complete","stopReason":"All requested sections supported"} -->';
  for (const model of ['gpt-6-luna', 'claude:sonnet']) {
    let seen;
    const runtime = { runTask: async (_p, _m, _e, schema) => { seen = schema; return JSON.stringify({summary:'Ready',detail:marker,suggestions:[],visualReferences:[]}); } };
    const service = new AiTaskService({ pluginDirectory:()=>'/plugin', language:()=> 'en', defaultReasoning:()=> 'low', exchangeLoggingEnabled:()=>false, exchanges:()=>null, codexRuntime:()=>runtime, claudeRuntime:()=>runtime });
    const result = await service.askModel({title:'Goal',summary:'',rules:'',detail:'',task:'<!-- mindsearch-phase: delivery-acceptance -->\nReview full document',ancestors:'',mode:'task',researchMode:'local',promptProfile:'mindsearch',responseContract:'mindsearch-delivery-acceptance'}, model, 'low');
    const pattern = new RegExp(seen.properties.detail.pattern);
    assert.ok(pattern.test(marker));
    assert.ok(!pattern.test('Issues: the review marker was misplaced'));
    assert.match(seen.properties.summary.description, /Never put machine-readable/);
    assert.equal(result.detail, marker);
    assert.equal(result.summary, 'Ready');
  }
});
