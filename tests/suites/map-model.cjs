const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, core, layout, node, map, plain, tree, root } = require('../support.cjs');
// Cards without a measured height use the default, stacked with the fixed gap.
const ROW = layout.DEFAULT_CARD_HEIGHT + layout.LAYOUT_GAP;
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
    { ...node('question'), aimKind: 'question', aimConvergesFromNodeIds: ['research'] },
    { ...node('research', 'question'), aimKind: 'research' },
    { ...node('synthesis', 'question'), aimKind: 'synthesis', aimConvergesFromNodeIds: ['research'] }
  ]);
  assert.equal(core.clearQuestionConvergenceEdges(fixture), true);
  assert.equal(fixture.nodes[0].aimConvergesFromNodeIds, undefined, 'legacy question refs are removed');
  assert.deepEqual(plain(fixture.nodes[2].aimConvergesFromNodeIds), ['research'], 'the synthesis node keeps its dashed link to research');
  assert.equal(core.clearQuestionConvergenceEdges(fixture), false, 'cleanup is idempotent');
  assert.deepEqual(plain(core.parentIdsForNode(fixture.nodes[0])), [], 'renderer never draws a dashed convergence edge into a question');
  assert.deepEqual(plain(core.parentIdsForNode(fixture.nodes[2])), ['question', 'research'], 'synthesis keeps its direct and dashed source edges');
});
test('repairs legacy AIM continuation convergence from preceding saved research only', () => {
  const fixture = map([
    { ...node('q1'), aimKind: 'question', aimConvergesFromNodeIds: ['legacy-wrong-source'] },
    { ...node('r1', 'q1'), aimKind: 'research' },
    { ...node('r2', 'q1'), aimKind: 'research' },
    { ...node('r-default-kind', 'q1'), aimKind: 'research' },
    { ...node('synthesis', 'q1'), aimKind: 'synthesis' },
    { ...node('r-future', 'q1'), aimKind: 'research' },
    { ...node('conclusion', 'q1'), aimKind: 'conclusion', aimConvergesFromNodeIds: ['existing-source'] },
    { ...node('conclusion-missing', 'q1'), aimKind: 'conclusion' },
    { ...node('q-legacy'), aimKind: 'question' },
    { ...node('legacy-synthesis', 'q-legacy'), aimKind: 'synthesis' }
  ]);
  fixture.aim = { version: 1, branches: [
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
  assert.equal(core.repairAimResultConvergence(fixture), true);
  assert.equal(fixture.nodes.find(item => item.id === 'synthesis').parentId, 'r2');
  assert.deepEqual(plain(fixture.nodes.find(item => item.id === 'synthesis').aimConvergesFromNodeIds), ['r1', 'r2'], 'later reports are excluded from this saved synthesis');
  assert.deepEqual(plain(fixture.nodes.find(item => item.id === 'conclusion').aimConvergesFromNodeIds), ['existing-source'], 'existing convergence edges are not rewritten');
  assert.equal(fixture.nodes.find(item => item.id === 'conclusion').parentId, 'q1');
  assert.equal(fixture.nodes.find(item => item.id === 'conclusion-missing').parentId, 'r-future');
  assert.deepEqual(plain(fixture.nodes.find(item => item.id === 'conclusion-missing').aimConvergesFromNodeIds), ['r1', 'r2', 'r-future']);
  assert.deepEqual(plain(fixture.nodes.find(item => item.id === 'q1').aimConvergesFromNodeIds), ['legacy-wrong-source'], 'question nodes are not modified');
  assert.equal(fixture.nodes.find(item => item.id === 'legacy-synthesis').parentId, 'q-legacy', 'legacy branch without saved research remains unchanged');
  assert.equal(core.repairAimResultConvergence(fixture), false, 'repair is idempotent');
});
test('AIM rejects a relocated result node when its branch reference still points to the source Vault', () => {
  const malformed = {
    version: 1, id: 'aim-fixture-map', title: 'Planner ask-user follow-up UI fixture',
    nodes: [
      { id: '8e541501-7636-41a3-8bd8-41650937236d', path: 'Agent Workspace/Topics/Planner ask-user follow-up UI fixture/Notes/如何用鑄鐵鍋在家煎出自己喜歡的牛排熟度？.md', parentId: null, x: 80, y: 80, collapsed: false, aimKind: 'topic' },
      { id: '5d756d6e-d119-43ac-b611-54353b574aa4', path: 'Agent Workspace/Topics/Planner ask-user follow-up UI fixture/Notes/問題 · 你希望牛排煎到哪種熟度？.md', parentId: '8e541501-7636-41a3-8bd8-41650937236d', x: 440, y: 80, collapsed: false, aimKind: 'question', aimQuestion: { requestId: '282bceaa-8fb9-47e3-abc7-dd2ce293e705', parentBranchId: null, options: [{ id: 'rare', label: '三分熟（中心偏紅）' }, { id: 'medium', label: '五分熟' }], allowMultiple: true, allowFreeText: true } },
      { id: 'e0a25570-f0f1-47d2-a4e5-3c645cde6036', path: 'Agent Workspace/Topics/Planner ask-user follow-up UI fixture/Notes/你希望牛排煎到哪種熟度？・回答研究.md', parentId: '5d756d6e-d119-43ac-b611-54353b574aa4', x: 800, y: 80, collapsed: false, aimKind: 'research' }
    ],
    viewport: { x: 0, y: 0, zoom: 1 },
    aim: {
      version: 1, branches: [{ id: '5719e17c-fced-46e5-947c-410dd73fbed9', submissionId: '7eb4a718-f3e7-462e-bda4-439daac43030', questionNodeId: '5d756d6e-d119-43ac-b611-54353b574aa4', parentBranchId: null, answerSnapshot: { selections: ['rare'], freeText: 'Synthetic UI fixture.' }, inputSnapshot: { topic: '如何用鑄鐵鍋在家煎出自己喜歡的牛排熟度？', conditions: { '你希望牛排煎到哪種熟度？': 'Synthetic answer.' }, upstreamResults: [] }, createdAt: '2026-10-05T05:37:21.519Z', results: [{ resultId: 'result-f042d30c-c76a-4bd1-8912-990a14ef1f2f-attempt-1', runId: 'f042d30c-c76a-4bd1-8912-990a14ef1f2f', attemptId: 'attempt-1', nodeId: 'e0a25570-f0f1-47d2-a4e5-3c645cde6036', notePath: 'Agent Workspace/Topics/如何用鑄鐵鍋在家煎出自己喜歡的牛排熟度？/Notes/你希望牛排煎到哪種熟度？・回答研究.md', version: 1 }] }],
      runs: [{ id: 'f042d30c-c76a-4bd1-8912-990a14ef1f2f', branchId: '5719e17c-fced-46e5-947c-410dd73fbed9', currentAttemptId: 'attempt-1', attempts: [{ id: 'attempt-1', inputSnapshotHash: 'e1d8c45129677f8003c8233e371fba8722032a0e367b8e02f9ab09423c57a44f', status: 'completed' }] }],
      pendingCommits: []
    }
  };
  assert.throws(() => core.parseMap(core.serializeMap(malformed)), /Invalid AIM branch result reference/);
  const repaired = plain(malformed); repaired.aim.branches[0].results[0].notePath = repaired.nodes.find(item => item.id === 'e0a25570-f0f1-47d2-a4e5-3c645cde6036').path;
  assert.equal(core.parseMap(core.serializeMap(repaired)).aim.branches[0].results[0].notePath, repaired.nodes[2].path);
});
test('AIM accepts legacy persisted Planner answer option objects without rewriting them', () => {
  const legacy = {
    version: 1, id: 'legacy-aim-map', title: 'Legacy AIM fixture',
    nodes: [
      { id: 'topic', path: 'topic.md', parentId: null, x: 0, y: 0, collapsed: false, aimKind: 'topic' },
      { id: 'question', path: 'question.md', parentId: 'topic', x: 360, y: 0, collapsed: false, aimKind: 'question' },
      { id: 'result', path: 'result.md', parentId: 'question', x: 720, y: 0, collapsed: false, aimKind: 'research' }
    ],
    viewport: { x: 0, y: 0, zoom: 1 },
    aim: {
      version: 1,
      branches: [{ id: 'branch', questionNodeId: 'question', parentBranchId: null, answerSnapshot: { selections: ['x'], freeText: '' }, inputSnapshot: { topic: 'Legacy fixture', conditions: {}, upstreamResults: [] }, createdAt: 'now', results: [{ resultId: 'result-1', runId: 'run', attemptId: 'attempt-1', nodeId: 'result', notePath: 'result.md', version: 1 }] }],
      runs: [{ id: 'run', branchId: 'branch', currentAttemptId: 'attempt-1', attempts: [{ id: 'attempt-1', inputSnapshotHash: 'hash', status: 'completed', plannerReviews: [{ decision: 'ask_user', rationale: 'A user condition is missing.', researchTurn: 1, question: 'Which option?', answerAxis: { id: 'axis', label: 'Preference' }, answerOptions: [{ axisId: 'axis', value: 'Option A' }, { axisId: 'axis', value: 'Option B' }] }] }] }],
      pendingCommits: []
    }
  };
  assert.deepEqual(plain(core.parseMap(core.serializeMap(legacy)).aim), plain(legacy.aim));
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
test('new tree layout keeps every existing node and places the new tree below them without overlap', () => {
  const existing = [
    { ...node('root'), x: 200, y: 80 },
    { ...node('child-a', 'root'), x: 560, y: -100 },
    { ...node('child-b', 'root'), x: 560, y: 520 },
    { ...node('other-root'), x: 120, y: 900 }
  ];
  const fresh = [{ ...node('new-root'), x: 80, y: 80 }, { ...node('new-a', 'new-root'), x: 80, y: 80 }, { ...node('new-b', 'new-root'), x: 80, y: 80 }, { ...node('new-a1', 'new-a'), x: 80, y: 80 }];
  const result = layout.arrangeNewTree([...existing, ...fresh], 'new-root', new Set(fresh.map(item => item.id)));
  assert.deepEqual(plain(result.slice(0, 4)), plain(existing), 'existing nodes never move');
  const placed = result.slice(4);
  for (const item of placed) for (const fixed of existing) assert.ok(Math.abs(item.x - fixed.x) >= 300 || Math.abs(item.y - fixed.y) >= 190, `${item.id} overlaps ${fixed.id}`);
  for (const item of placed) assert.ok(item.y >= 900 + ROW, `${item.id} below the lowest node`);
  assert.equal(placed[0].x, 120, 'leftmost root column');
  assert.equal(placed[1].x, 120 + 360); assert.equal(placed[3].x, 120 + 720);
  assert.deepEqual(plain(layout.arrangeNewTree(existing, 'missing', new Set())), plain(existing));
});
test('malformed maps fail before data can be overwritten', () => {
  for (const nodes of [[node('a'), node('a')], [node('a', 'b'), node('b', 'a')], [node('a', 'missing')]]) {
    assert.throws(() => core.parseMap(core.serializeMap(map(nodes))));
  }
  assert.throws(() => core.parseMap('No map data'));
});
test('AIM pending commits must match their run, current saving attempt, branch, and owned result node', () => {
  const valid = map([node('question'), node('result', 'question')]);
  valid.aim = {
    version: 1,
    branches: [
      { id: 'branch-a', questionNodeId: 'question', parentBranchId: null, answerSnapshot: { selections: [], freeText: '' }, inputSnapshot: { topic: 'topic', conditions: {}, upstreamResults: [] }, createdAt: 'now', results: [] },
      { id: 'branch-b', questionNodeId: 'question', parentBranchId: null, answerSnapshot: { selections: [], freeText: '' }, inputSnapshot: { topic: 'topic', conditions: {}, upstreamResults: [] }, createdAt: 'now', results: [] }
    ],
    runs: [{ id: 'run-a', branchId: 'branch-a', currentAttemptId: 'attempt-a', attempts: [{ id: 'attempt-a', inputSnapshotHash: 'hash', status: 'saving' }] }],
    resultDrafts: [{ id: 'draft-a', branchId: 'branch-a', runId: 'run-a', attemptId: 'attempt-a', nodeId: 'result', notePath: 'result.md', title: 'result', status: 'ready', inputSnapshotHash: 'hash' }],
    pendingCommits: [{ resultId: 'result-a', branchId: 'branch-a', runId: 'run-a', attemptId: 'attempt-a', resultDraftId: 'draft-a', nodeId: 'result', notePath: 'result.md', title: 'result', summary: 'summary', detail: 'detail', version: 1 }]
  };
  assert.deepEqual(plain(core.parseMap(core.serializeMap(valid)).aim), plain(valid.aim));
  const crossBranch = structuredClone(valid); crossBranch.aim.pendingCommits[0].branchId = 'branch-b';
  assert.throws(() => core.parseMap(core.serializeMap(crossBranch)), /Invalid AIM pending commit/);
  const staleAttempt = structuredClone(valid); staleAttempt.aim.pendingCommits[0].attemptId = 'attempt-old';
  assert.throws(() => core.parseMap(core.serializeMap(staleAttempt)), /Invalid AIM pending commit/);
});
test('undo and redo preserve ordering; new edit invalidates redo', () => {
  const h = new core.History(); h.push('move'); h.push('delete'); assert.equal(h.undo(), 'delete'); assert.equal(h.undo(), 'move'); assert.equal(h.redo(), 'move'); h.push('edit'); assert.equal(h.canRedo, false); assert.equal(h.undo(), 'edit');
});
test('maps saved under the pre-AIM name are upgraded to AIM keys, markers and sentinels on read', () => {
  const { LEGACY_KEY_PREFIX, LEGACY_MARKER_PREFIX, LEGACY_VALUES } = require('../support.cjs').load('experiences/aim/legacy-names.ts');
  const legacyKey = key => key.startsWith('aim') ? LEGACY_KEY_PREFIX + key.slice(3) : key;
  const toLegacy = value => Array.isArray(value) ? value.map(toLegacy)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [legacyKey(key), toLegacy(item)]))
    : typeof value === 'string' ? LEGACY_VALUES.reduce((text, [legacy, current]) => text.split(current).join(legacy), value.replace('<!-- aim-', `<!-- ${LEGACY_MARKER_PREFIX}`))
    : value;
  const current = map([
    { ...node('topic'), aimKind: 'topic' },
    { ...node('question', 'topic'), aimKind: 'question', aimDismissedQuestionRequestIds: ['request'] }
  ]);
  current.aim = { version: 1, branches: [], runs: [], pendingCommits: [], note: '<!-- aim-review {} --> __aim_unknown__' };
  const legacy = toLegacy(current);
  assert.ok(!('aim' in legacy) && legacy.nodes[1][`${LEGACY_KEY_PREFIX}Kind`] === 'question');
  const parsed = plain(core.parseMap(core.serializeMap(legacy)));
  assert.deepEqual(parsed.nodes.map(item => item.aimKind), ['topic', 'question']);
  assert.deepEqual(parsed.nodes[1].aimDismissedQuestionRequestIds, ['request']);
  assert.equal(parsed.aim.note, '<!-- aim-review {} --> __aim_unknown__');
  assert.ok(!JSON.stringify(parsed).includes(LEGACY_KEY_PREFIX) && !JSON.stringify(parsed).includes(LEGACY_MARKER_PREFIX));
});

test('AIM map validation accepts a missing or supported content language and rejects any other value', () => {
  const base = { version: 1, id: 'content-language-map', title: 'Content language fixture', nodes: [], viewport: { x: 0, y: 0, zoom: 1 }, aim: { version: 1, branches: [], runs: [], pendingCommits: [] } };
  assert.equal(core.parseMap(core.serializeMap(base)).aim.contentLanguage, undefined);
  for (const value of ['en', 'zh-TW']) assert.equal(core.parseMap(core.serializeMap({ ...base, aim: { ...base.aim, contentLanguage: value } })).aim.contentLanguage, value);
  for (const value of ['fr', '', 'zh', 5, null]) assert.throws(() => core.parseMap(core.serializeMap({ ...base, aim: { ...base.aim, contentLanguage: value } })), /Invalid AIM content language/);
});

test('map default content template survives parse and serialize; non-strings are dropped', () => {
  const map = { version: 1, id: 'm', title: 'M', nodes: [], viewport: { x: 0, y: 0, zoom: 1 }, detailTemplateId: 't1' };
  assert.equal(core.parseMap(core.serializeMap(map)).detailTemplateId, 't1');
  assert.equal(core.parseMap(core.serializeMap({ ...map, detailTemplateId: 5 })).detailTemplateId, undefined);
});

test('full layout treats a collapsed topic as a leaf and leaves its hidden branch where it was', () => {
  const nodes = [
    { ...node('root'), x: 0, y: 0 },
    { ...node('big', 'root'), x: 0, y: 0, collapsed: true },
    ...Array.from({ length: 6 }, (_, index) => ({ ...node(`hidden-${index}`, 'big'), x: 999, y: index })),
    { ...node('next', 'root'), x: 0, y: 0 }
  ];
  const at = (list, id) => list.find(item => item.id === id);
  const folded = layout.arrangeMap(nodes);
  assert.equal(at(folded, 'next').y - at(folded, 'big').y, ROW, 'the sibling sits one row below, not below six hidden rows');
  for (let index = 0; index < 6; index++) assert.deepEqual([at(folded, `hidden-${index}`).x, at(folded, `hidden-${index}`).y], [999, index]);
  const open = layout.arrangeMap(folded.map(item => ({ ...item, collapsed: false })));
  assert.equal(at(open, 'next').y - at(open, 'hidden-5').y, ROW, 'expanded, the branch takes its rows again');
});

const aimNode = (id, parentId, aimKind, converges, collapsed = false) => ({ ...node(id, parentId, collapsed), aimKind, ...(converges ? { aimConvergesFromNodeIds: converges } : {}) });
const noOverlap = placed => {
  for (const a of placed) for (const b of placed) if (a.id < b.id && a.x === b.x) assert.ok(Math.abs(a.y - b.y) >= ROW, `${a.id} and ${b.id} overlap`);
};
const checkJoins = (source, placed) => {
  const at = id => placed.find(item => item.id === id);
  for (const join of source.filter(item => item.aimConvergesFromNodeIds?.length && item.aimKind !== 'question')) {
    const ys = join.aimConvergesFromNodeIds.map(id => at(id).y).sort((a, b) => a - b);
    ys.forEach((y, index) => index && assert.equal(y - ys[index - 1], ROW, `${join.id} sources are consecutive rows`));
    assert.equal(at(join.id).x, at(join.aimConvergesFromNodeIds[0]).x + 360, `${join.id} is one column right of its sources`);
    // Sibling joins stack by subtree height, so only a lone join is centered on its sources.
    if (source.filter(item => item.aimConvergesFromNodeIds?.join() === join.aimConvergesFromNodeIds.join() && item.aimKind !== 'question').length === 1)
      assert.ok(at(join.id).y >= ys[0] && at(join.id).y <= ys[ys.length - 1], `${join.id} sits among its sources`);
  }
};
const aimChain = () => [
  aimNode('topic', null, 'topic'), aimNode('Q', 'topic', 'question'),
  aimNode('R1', 'Q', 'research'), aimNode('R2', 'Q', 'research'), aimNode('R3', 'Q', 'research'),
  aimNode('C', 'R3', 'conclusion', ['R1', 'R2', 'R3']), aimNode('Q2', 'C', 'question'),
  ...[1, 2, 3, 4].map(i => aimNode(`S${i}`, 'Q2', 'research')),
  aimNode('C2', 'S4', 'conclusion', ['S1', 'S2', 'S3', 'S4'])
];
test('AIM convergence nodes are laid out after all their research sources', () => {
  const placed = layout.arrangeMap(aimChain());
  const at = id => placed.find(item => item.id === id);
  assert.equal(at('R2').y - at('R1').y, ROW);
  assert.equal(at('R3').y - at('R2').y, ROW);
  assert.equal(at('C').x, at('R1').x + 360);
  assert.ok(Math.abs(at('C').y - (at('R1').y + at('R3').y) / 2) <= 1);
  checkJoins(aimChain(), placed);
  noOverlap(placed);
});
test('real-shaped AIM map: every convergence node sits among consecutive source rows without overlap', () => {
  const source = require('../fixtures/aim-convergence-layout.json').map(item => ({ ...item, path: `${item.id}.md`, x: 0, y: 0 }));
  const placed = layout.arrangeMap(source);
  checkJoins(source, placed);
  noOverlap(placed);
});
test('collapsing the primary source hides the convergence node and its subtree from layout', () => {
  const nodes = aimChain().map((item, index) => ({ ...item, x: 900 + index, y: 5 + index, collapsed: item.id === 'R3' }));
  const placed = layout.arrangeMap(nodes);
  for (const id of ['C', 'Q2', 'S1', 'S4', 'C2']) {
    const before = nodes.find(item => item.id === id), after = placed.find(item => item.id === id);
    assert.deepEqual([after.x, after.y], [before.x, before.y], `${id} keeps its coordinates`);
  }
  assert.equal(placed.find(item => item.id === 'R3').y - placed.find(item => item.id === 'R1').y, 2 * ROW);
});
test('ordinary trees keep their exact full-layout coordinates', () => {
  const nodes = [node('r'), node('a', 'r'), node('b', 'r'), node('a1', 'a'), node('a2', 'a'), node('a3', 'a'), node('b1', 'b'), node('r2'), node('c', 'r2')];
  assert.deepEqual(layout.arrangeMap(nodes).map(item => [item.id, item.x, item.y]), [['r', 80, 488], ['a', 440, 284], ['b', 440, 692], ['a1', 800, 80], ['a2', 800, 284], ['a3', 800, 488], ['b1', 800, 692], ['r2', 80, 896], ['c', 440, 896]]);
});

const interimMap = (overrides = {}) => {
  const nodes = [
    aimNode('topic', null, 'topic'), aimNode('Q', 'topic', 'question'),
    aimNode('R1', 'Q', 'research'), aimNode('R2', 'Q', 'research'), aimNode('R3', 'Q', 'research'),
    aimNode('c098a2c1', 'R3', 'synthesis', ['R1', 'R2', 'R3']), aimNode('03d99151', 'R3', 'synthesis', ['R1', 'R2', 'R3']),
    aimNode('cd914778', 'R3', 'conclusion', ['R1', 'R2', 'R3'])
  ];
  const result = (nodeId, kind, runId = 'run') => ({ resultId: `res-${nodeId}`, runId, attemptId: `att-${nodeId}`, nodeId, notePath: `${nodeId}.md`, version: 1, kind });
  const doc = map(nodes);
  doc.aim = { version: 1, branches: [{ id: 'b', questionNodeId: 'Q', parentBranchId: null, answerSnapshot: { selections: [], freeText: '' }, inputSnapshot: { topic: 't', conditions: {}, upstreamResults: [] }, createdAt: '2026-10-09T00:00:00.000Z',
    results: [result('R1', 'research'), result('c098a2c1', 'synthesis'), result('03d99151', 'synthesis'), ...(overrides.noConclusion ? [] : [result('cd914778', 'conclusion', overrides.conclusionRun ?? 'run')])] }], runs: [], pendingCommits: [] };
  if (overrides.child) doc.nodes.push(aimNode('ask', 'c098a2c1', 'question'));
  return doc;
};
test('supersededAimNodeIds lists interim synthesis nodes once the same run has a later conclusion', () => {
  assert.deepEqual([...core.supersededAimNodeIds(interimMap())].sort(), ['03d99151', 'c098a2c1']);
  assert.equal(core.supersededAimNodeIds(map(tree())).size, 0, 'ordinary maps have none');
});
test('supersededAimNodeIds keeps interim nodes for a different run, a pending run, or a node that owns children', () => {
  assert.equal(core.supersededAimNodeIds(interimMap({ conclusionRun: 'other' })).size, 0);
  assert.equal(core.supersededAimNodeIds(interimMap({ noConclusion: true })).size, 0);
  assert.deepEqual([...core.supersededAimNodeIds(interimMap({ child: true }))], ['03d99151']);
});
test('arrangeMap with a hidden set lays out as if the hidden nodes did not exist and leaves their coordinates alone', () => {
  const doc = interimMap();
  const hidden = core.supersededAimNodeIds(doc);
  const nodes = doc.nodes.map(item => hidden.has(item.id) ? { ...item, x: 777, y: 999 } : item);
  const placed = layout.arrangeMap(nodes, hidden);
  const at = id => placed.find(item => item.id === id);
  const bare = layout.arrangeMap(nodes.filter(item => !hidden.has(item.id)));
  for (const item of bare) assert.deepEqual([at(item.id).x, at(item.id).y], [item.x, item.y], `${item.id} is placed as without the hidden nodes`);
  for (const id of hidden) assert.deepEqual([at(id).x, at(id).y], [777, 999], `${id} keeps its stored coordinates`);
  assert.equal(at('R2').y - at('R1').y, ROW); assert.equal(at('R1').y, at('R1').y);
});

test('card-height layout: short cards pack with exactly the gap, a tall card gets more space, unknown height falls back', () => {
  const { LAYOUT_GAP, DEFAULT_CARD_HEIGHT } = layout;
  const nodes = [node('r'), node('a', 'r'), node('b', 'r'), node('c', 'r')];
  const at = (placed, id) => placed.find(item => item.id === id);
  const heights = { r: 60, a: 60, b: 60, c: 60 };
  const short = layout.arrangeMap(nodes, undefined, id => heights[id]);
  assert.equal(at(short, 'b').y - at(short, 'a').y, 60 + LAYOUT_GAP, 'short cards are exactly one gap apart');
  assert.equal(at(short, 'c').y - at(short, 'b').y, 60 + LAYOUT_GAP);
  assert.equal(at(short, 'r').y, at(short, 'b').y, 'parent is centered on its children');
  const tall = layout.arrangeMap(nodes, undefined, id => (id === 'a' ? 300 : 60));
  assert.equal(at(tall, 'b').y - at(tall, 'a').y, 300 + LAYOUT_GAP, 'a tall card pushes its sibling down by its own height');
  assert.equal(at(tall, 'c').y - at(tall, 'b').y, 60 + LAYOUT_GAP);
  const unknown = layout.arrangeMap(nodes, undefined, id => (id === 'a' ? undefined : 60));
  assert.equal(at(unknown, 'b').y - at(unknown, 'a').y, DEFAULT_CARD_HEIGHT + LAYOUT_GAP, 'unknown height uses the default');
  const bad = layout.arrangeMap(nodes, undefined, id => (id === 'a' ? 0 : NaN));
  assert.equal(at(bad, 'b').y - at(bad, 'a').y, DEFAULT_CARD_HEIGHT + LAYOUT_GAP, 'zero or NaN heights count as unknown');
});
test('card-height layout: a deep branch only takes the room it needs, so shallow siblings stay close', () => {
  const nodes = [node('r'), node('a', 'r'), node('b', 'r'), ...[1, 2, 3].map(i => node(`a${i}`, 'a'))];
  const placed = layout.arrangeMap(nodes, undefined, () => 60);
  const at = id => placed.find(item => item.id === id);
  assert.equal(at('a3').y - at('a1').y, 2 * 84);
  assert.equal(at('b').y - at('a1').y, 3 * 84, 'b starts after the three-kid subtree (3 cards + 3 gaps), not after fixed rows');
  assert.equal(at('a').y, at('a2').y, 'parent is centered on its kids');
});
test('card-height overlap checks use real heights plus the gap', () => {
  const { LAYOUT_GAP } = layout;
  const heightOf = id => (id === 'old' ? 400 : 60);
  const base = [{ ...node('root'), x: 0, y: 0 }, { ...node('old', 'root'), x: 360, y: 0 }, { ...node('fresh', 'root'), x: 0, y: 0 }];
  const branch = layout.arrangeNewBranch(base, 'root', new Set(['fresh']), heightOf);
  assert.equal(branch[2].y, 400 + LAYOUT_GAP, 'the new card clears the tall card by exactly the gap');
  const close = layout.arrangeNewBranch(base.map(item => (item.id === 'old' ? { ...item, y: 500 } : item)), 'root', new Set(['fresh']), heightOf);
  assert.equal(close[2].y, 0 + 60 / 2 - 60 / 2, 'no push when the cards already clear each other');
  const fixed = [{ ...node('r'), x: 80, y: 80 }, { ...node('low', 'r'), x: 440, y: 500 }, { ...node('n'), x: 0, y: 0 }];
  const tree = layout.arrangeNewTree(fixed, 'n', new Set(['n']), id => (id === 'low' ? 250 : 60));
  assert.equal(tree[2].y, 500 + 250 + LAYOUT_GAP, 'a new tree starts below the lowest real card bottom plus the gap');
});

test('medianHeight gives the typical rendered card height for unmeasured cards', () => {
  assert.equal(layout.medianHeight([]), undefined, 'nothing rendered');
  assert.equal(layout.medianHeight([0, NaN, -5]), undefined, 'unusable values are ignored');
  assert.equal(layout.medianHeight([90, 60, 400]), 90, 'odd count: middle value, a tall outlier does not skew it');
  assert.equal(layout.medianHeight([60, 80, 100, 400]), 90, 'even count: mean of the middle two');
  const nodes = [node('r'), node('a', 'r'), node('b', 'r')];
  const typical = layout.medianHeight([70, 70, 70]);
  const placed = layout.arrangeMap(nodes, undefined, id => (id === 'r' ? 70 : typical));
  assert.equal(placed.find(item => item.id === 'b').y - placed.find(item => item.id === 'a').y, 70 + layout.LAYOUT_GAP);
});
// ---- hypothesis-evidence: topic relations (evidence / prerequisite) ----
const relMap = (relations, ids = ['a', 'b', 'c', 'h', 'h2']) => { const m = map(ids.map(id => node(id))); if (relations !== undefined) m.topicRelations = relations; return m; };
const parseWith = (m, extra) => { const logs = []; const parsed = core.parseMap(core.serializeMap(extra ? { ...m, ...extra } : m), (level, message) => logs.push({ level, message })); return { parsed, logs }; };
const ev = (from, to) => ({ kind: 'supports', from, to });
const legacyEv = (from, to) => ({ kind: 'evidence', from, to });
const pre = (from, to) => ({ kind: 'prerequisite', from, to });
test('hypothesis-evidence: parse drops a non-list topicRelations key, warns once, and does not throw', () => {
  const { parsed, logs } = parseWith(relMap(), { topicRelations: { kind: 'evidence' } });
  assert.equal('topicRelations' in parsed, false);
  assert.equal(logs.length, 1); assert.equal(logs[0].level, 'warn');
});
test('hypothesis-evidence: parse drops malformed, unknown-kind, dangling, self and duplicate relations; logs counts only', () => {
  const secret = 'secret-title-never-logged';
  const { parsed, logs } = parseWith(relMap([ev('a', 'h'), ev('a', 'h'), { kind: 'weird', from: 'a', to: 'h' }, ev('a', 'missing'), ev('missing', 'h'), ev('a', 'a'), null, 5, { kind: 'evidence', from: 'a' }, { kind: 'evidence', from: 1, to: 'h' }, pre('b', 'c'), pre('b', 'c'), { ...ev('b', 'h2'), note: secret }]));
  assert.deepEqual(plain(parsed.topicRelations), [ev('a', 'h'), pre('b', 'c'), ev('b', 'h2')]);
  assert.equal(JSON.stringify(parsed).includes(secret), false, 'extra keys are not carried over');
  assert.equal(logs.length, 1); assert.equal(logs[0].level, 'warn');
  assert.match(logs[0].message, /\b10\b/, 'the drop count is logged');
  assert.equal(logs[0].message.includes(secret), false); assert.doesNotMatch(logs[0].message, /missing|weird|evidence/);
});
test('hypothesis-evidence: parse removes the key when nothing valid remains and logs nothing for a clean list', () => {
  assert.equal('topicRelations' in parseWith(relMap([ev('a', 'a')])).parsed, false);
  assert.equal('topicRelations' in parseWith(relMap([])).parsed, false, 'an empty list is not kept');
  const clean = parseWith(relMap([ev('a', 'h')]));
  assert.deepEqual(clean.logs, []);
});
test('hypothesis-evidence: parse keeps a hand-written prerequisite cycle (A->B->A)', () => {
  const { parsed, logs } = parseWith(relMap([pre('a', 'b'), pre('b', 'a'), pre('a', 'c'), pre('c', 'a')]));
  assert.equal(parsed.topicRelations.length, 4); assert.deepEqual(logs, []);
});
test('hypothesis-evidence: a map without relations serializes byte for byte as before, and the key never appears', () => {
  const source = relMap(undefined);
  const text = core.serializeMap(source);
  assert.equal(text.includes('topicRelations'), false);
  assert.equal(core.serializeMap(core.parseMap(text)), text);
  const sample = fs.readFileSync(path.join(root, 'samples/taiwan-travel/en/Map.md'), 'utf8');
  assert.equal(core.serializeMap(core.parseMap(sample)).includes('topicRelations'), false);
});
test('hypothesis-evidence: both relation kinds round-trip through serialize and parse', () => {
  const source = relMap([ev('a', 'h'), pre('b', 'c'), ev('b', 'h2')]);
  const { parsed, logs } = parseWith(source);
  assert.deepEqual(plain(parsed), plain(source)); assert.deepEqual(logs, []);
  assert.deepEqual(plain(core.parseMap(core.serializeMap(parsed))), plain(source));
});
test('hypothesis-evidence: setTopicRelations removes the key for an empty list; removeTopicRelationsFor drops both kinds', () => {
  const m = relMap([ev('a', 'h'), pre('b', 'c'), pre('c', 'a'), ev('b', 'h2')]);
  core.removeTopicRelationsFor(m, ['a']);
  assert.deepEqual(plain(m.topicRelations), [pre('b', 'c'), ev('b', 'h2')]);
  core.removeTopicRelationsFor(m, ['b']);
  assert.equal('topicRelations' in m, false, 'the last removal deletes the key');
  core.setTopicRelations(m, [ev('a', 'h')]); assert.equal(m.topicRelations.length, 1);
  core.setTopicRelations(m, []); assert.equal('topicRelations' in m, false);
});
const preSources = (m, to) => m.nodes.filter(n => core.relationAllowed(m.topicRelations ?? [], { kind: 'prerequisite', from: n.id, to })).map(n => n.id);
test('hypothesis-evidence: legalRelationTargets for supports excludes itself and linked targets and allows any topic type at both ends', () => {
  const m = relMap([ev('a', 'h')]);
  assert.deepEqual(core.legalRelationTargets(m, 'supports', 'a'), ['b', 'c', 'h2'], 'h is already linked; the ends need not be a fact or a hypothesis');
  assert.deepEqual(core.legalRelationTargets(m, 'supports', 'h'), ['a', 'b', 'c', 'h2'], 'a hypothesis can be a source; the reverse direction is a different link');
  assert.deepEqual(plain(core.legalRelationTargets(relMap(undefined, ['a']), 'supports', 'a')), []);
});
test('hypothesis-evidence: prerequisite sources (relationAllowed) exclude itself, existing sources and anything that would close a cycle, directly or indirectly', () => {
  const m = relMap([pre('a', 'b')], ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(preSources(m, 'b'), ['c', 'd', 'e'], 'self and existing source a are out');
  core.setTopicRelations(m, [pre('b', 'x'), pre('x', 'c')]); m.nodes.push(node('x'));
  assert.deepEqual(preSources(m, 'b'), ['a', 'd', 'e'], 'x and c are reachable from b, so they would close a cycle');
  assert.deepEqual(preSources(relMap([ev('a', 'b')]), 'b'), ['a', 'c', 'h', 'h2'], 'supports links do not count');
});
test('hypothesis-evidence: prerequisite sources terminate on a hand-written cycle', () => {
  const m = relMap([pre('a', 'b'), pre('b', 'a'), pre('b', 'c'), pre('c', 'b')]);
  assert.deepEqual(preSources(m, 'a'), ['h', 'h2']);
  assert.deepEqual(preSources(m, 'h'), ['a', 'b', 'c', 'h2']);
});
test('hypothesis-evidence: retargetTopicRelations merges ends, dedupes, drops self links and reports new cycles', () => {
  const m = relMap([ev('a', 'h'), ev('b', 'h'), pre('a', 'b'), pre('c', 'a'), pre('b', 'h2')]);
  const result = core.retargetTopicRelations(m, ['a', 'b'], 'a');
  assert.deepEqual(plain(m.topicRelations), [ev('a', 'h'), pre('c', 'a'), pre('a', 'h2')], 'two evidence links collapse; a->b becomes a self link and goes');
  assert.deepEqual(plain(result), { droppedCycles: 0 });
  const cyc = relMap([pre('a', 'c'), pre('c', 'b')]);
  const merged = core.retargetTopicRelations(cyc, ['a', 'b'], 'a');
  assert.deepEqual(plain(cyc.topicRelations), [pre('a', 'c')], 'c->a would close a cycle with a->c');
  assert.deepEqual(plain(merged), { droppedCycles: 1 });
  const none = relMap(undefined); assert.deepEqual(plain(core.retargetTopicRelations(none, ['a'], 'b')), { droppedCycles: 0 }); assert.equal('topicRelations' in none, false);
});
test('hypothesis-evidence: retargetTopicRelations leaves a pre-existing cycle alone', () => {
  const m = relMap([pre('a', 'b'), pre('b', 'a'), ev('c', 'h')]);
  assert.deepEqual(plain(core.retargetTopicRelations(m, ['c'], 'c2')), { droppedCycles: 0 });
  assert.deepEqual(plain(m.topicRelations), [pre('a', 'b'), pre('b', 'a'), ev('c2', 'h')]);
});
// ---- hypothesis-evidence (P7): six relation kinds, description, relationAllowed ----
const rel = (kind, from, to, description) => (description === undefined ? { kind, from, to } : { kind, from, to, description });
const KINDS6 = ['supports', 'contradicts', 'verifies', 'derives_from', 'related', 'prerequisite'];
test('hypothesis-evidence: all six kinds with and without a description round-trip byte for byte', () => {
  const source = relMap(KINDS6.map((k, i) => rel(k, 'a', ['b', 'c', 'h', 'h2', 'b', 'c'][i], i % 2 ? `note ${k}` : undefined)));
  const { parsed, logs } = parseWith(source);
  assert.deepEqual(plain(parsed), plain(source)); assert.deepEqual(logs, []);
  const text = core.serializeMap(source);
  assert.equal(core.serializeMap(core.parseMap(text)), text);
});
test('hypothesis-evidence: parse drops a V1.5 evidence relation as an unknown kind, warns with a count only, keeps the rest and does not migrate it', () => {
  const { parsed, logs } = parseWith(relMap([legacyEv('a', 'h'), ev('b', 'c'), legacyEv('b', 'h2')]));
  assert.deepEqual(plain(parsed.topicRelations), [ev('b', 'c')], 'evidence is gone and is not turned into supports');
  assert.equal(logs.length, 1); assert.equal(logs[0].level, 'warn'); assert.match(logs[0].message, /\b2\b/); assert.doesNotMatch(logs[0].message, /evidence|"a"|h2/);
  const only = parseWith(relMap([legacyEv('a', 'h')]));
  assert.equal('topicRelations' in only.parsed, false, 'the key goes when nothing valid remains'); assert.equal(only.logs.length, 1);
  assert.equal(core.legalEvidenceTargets, undefined); assert.equal(core.legalPrerequisiteSources, undefined, 'the V1.5 helpers are removed');
});
test('hypothesis-evidence: parse drops a related duplicate in the other direction and keeps the first', () => {
  const { parsed, logs } = parseWith(relMap([rel('related', 'b', 'a', 'first'), rel('related', 'a', 'b'), rel('supports', 'a', 'b'), rel('supports', 'b', 'a')]));
  assert.deepEqual(plain(parsed.topicRelations), [rel('related', 'b', 'a', 'first'), rel('supports', 'a', 'b'), rel('supports', 'b', 'a')], 'only related ignores direction');
  assert.equal(logs.length, 1); assert.equal(logs[0].level, 'warn'); assert.match(logs[0].message, /\b1\b/);
});
test('hypothesis-evidence: a non-string description is removed with a warn but the relation stays', () => {
  const { parsed, logs } = parseWith(relMap([{ ...rel('supports', 'a', 'h'), description: 42 }, { ...rel('contradicts', 'b', 'c'), description: null }, { ...rel('verifies', 'a', 'c'), description: { x: 1 } }]));
  assert.deepEqual(plain(parsed.topicRelations), [rel('supports', 'a', 'h'), rel('contradicts', 'b', 'c'), rel('verifies', 'a', 'c')]);
  assert.equal(parsed.topicRelations.some(r => 'description' in r), false);
  assert.equal(logs.length, 1); assert.equal(logs[0].level, 'warn'); assert.match(logs[0].message, /\b3\b/);
});
test('hypothesis-evidence: a string description is read as written, even long, with markup, or multi-line', () => {
  const long = 'x'.repeat(500); const html = '<img src=x onerror=alert(1)>'; const multi = ' a\n  b ';
  const { parsed, logs } = parseWith(relMap([rel('supports', 'a', 'h', long), rel('related', 'b', 'c', html), rel('verifies', 'a', 'c', multi), rel('contradicts', 'b', 'h', '')]));
  assert.deepEqual(plain(parsed.topicRelations.map(r => r.description)), [long, html, multi, '']); assert.deepEqual(logs, []);
});
test('hypothesis-evidence: a hand-written derivation cycle and a prerequisite cycle are kept', () => {
  const { parsed, logs } = parseWith(relMap([rel('derives_from', 'a', 'b'), rel('derives_from', 'b', 'a'), rel('prerequisite', 'b', 'c'), rel('prerequisite', 'c', 'b')]));
  assert.equal(parsed.topicRelations.length, 4); assert.deepEqual(logs, []);
});
test('hypothesis-evidence: unknown kind, dangling end, self link and same-kind duplicate are dropped with one count-only warn', () => {
  const { parsed, logs } = parseWith(relMap([rel('related', 'a', 'a'), rel('supports', 'a', 'zzz'), { kind: 'likes', from: 'a', to: 'b' }, rel('verifies', 'a', 'b'), rel('verifies', 'a', 'b', 'dup'), rel('contradicts', 'a', 'b')]));
  assert.deepEqual(plain(parsed.topicRelations), [rel('verifies', 'a', 'b'), rel('contradicts', 'a', 'b')]);
  assert.equal(logs.length, 1); assert.match(logs[0].message, /\b4\b/); assert.doesNotMatch(logs[0].message, /zzz|likes|dup/);
});
test('hypothesis-evidence: isAcyclicKind is true only for derives_from and prerequisite', () => {
  assert.deepEqual(KINDS6.filter(k => core.isAcyclicKind(k)), ['derives_from', 'prerequisite']);
});
test('hypothesis-evidence: normalizeRelationDescription trims, folds whitespace and newlines, caps at 200, and empties to undefined', () => {
  assert.equal(core.normalizeRelationDescription('  a \n\t b  '), 'a b');
  assert.equal(core.normalizeRelationDescription(''), undefined);
  assert.equal(core.normalizeRelationDescription(' \n\t '), undefined);
  assert.equal(core.normalizeRelationDescription('x'.repeat(200)).length, 200);
  assert.equal(core.normalizeRelationDescription('x'.repeat(201)), 'x'.repeat(200));
  assert.equal(core.normalizeRelationDescription('x'.repeat(199) + ' y'), 'x'.repeat(199), 'no trailing space after the cut');
  assert.equal(core.normalizeRelationDescription('<b>hi</b>'), '<b>hi</b>', 'text is not interpreted');
});
test('hypothesis-evidence: setTopicRelations keeps a description and never writes an undefined key', () => {
  const m = relMap(undefined);
  core.setTopicRelations(m, [rel('supports', 'a', 'h', 'why'), { kind: 'related', from: 'b', to: 'c', description: undefined }]);
  assert.equal(m.topicRelations[0].description, 'why');
  assert.equal('description' in m.topicRelations[1], false);
  assert.equal(core.serializeMap(m).includes('undefined'), false);
});
test('hypothesis-evidence: relationAllowed refuses a self link and a same-kind duplicate; related ignores direction', () => {
  const rs = [rel('supports', 'a', 'b'), rel('related', 'a', 'c')];
  assert.equal(core.relationAllowed(rs, rel('supports', 'a', 'a')), false);
  assert.equal(core.relationAllowed(rs, rel('supports', 'a', 'b')), false);
  assert.equal(core.relationAllowed(rs, rel('supports', 'b', 'a')), true, 'supports has a direction');
  assert.equal(core.relationAllowed(rs, rel('contradicts', 'a', 'b')), true, 'another kind on the same pair is fine');
  assert.equal(core.relationAllowed(rs, rel('related', 'c', 'a')), false, 'related reversed is a duplicate');
  assert.equal(core.relationAllowed(rs, rel('related', 'a', 'c')), false);
  assert.equal(core.relationAllowed([], rel('related', 'a', 'b')), true);
});
test('hypothesis-evidence: relationAllowed refuses direct and indirect derivation and prerequisite cycles', () => {
  for (const kind of ['derives_from', 'prerequisite']) {
    const rs = [rel(kind, 'a', 'b'), rel(kind, 'b', 'c')];
    assert.equal(core.relationAllowed(rs, rel(kind, 'b', 'a')), false, `${kind} direct`);
    assert.equal(core.relationAllowed(rs, rel(kind, 'c', 'a')), false, `${kind} indirect`);
    assert.equal(core.relationAllowed(rs, rel(kind, 'a', 'c')), true, `${kind} a shortcut is not a cycle`);
    assert.equal(core.relationAllowed(rs, rel(kind, 'c', 'h')), true);
  }
  const sup = [rel('supports', 'a', 'b')];
  assert.equal(core.relationAllowed(sup, rel('supports', 'b', 'a')), true, 'supports may point both ways');
});
test('hypothesis-evidence: relationAllowed lets a derivation and a prerequisite point opposite ways (cycles are per kind)', () => {
  assert.equal(core.relationAllowed([rel('derives_from', 'a', 'b')], rel('prerequisite', 'b', 'a')), true);
  assert.equal(core.relationAllowed([rel('prerequisite', 'a', 'b'), rel('supports', 'b', 'c')], rel('derives_from', 'c', 'a')), true);
});
test('hypothesis-evidence: relationAllowed with replacingIndex excludes the replaced relation (reverse, change kind)', () => {
  const rs = [rel('derives_from', 'a', 'b'), rel('derives_from', 'b', 'c')];
  assert.equal(core.relationAllowed(rs, rel('derives_from', 'b', 'a'), 0), true, 'reversing a->b is fine once a->b is excluded');
  assert.equal(core.relationAllowed(rs, rel('derives_from', 'c', 'b'), 1), true);
  assert.equal(core.relationAllowed([rel('derives_from', 'a', 'b'), rel('derives_from', 'b', 'c'), rel('derives_from', 'c', 'd')], rel('derives_from', 'd', 'a'), 0), true, 'chain without the replaced link');
  assert.equal(core.relationAllowed([rel('derives_from', 'a', 'b'), rel('derives_from', 'b', 'c'), rel('derives_from', 'c', 'a')], rel('derives_from', 'a', 'c'), 2), true, 'reversing the closing link of a loop');
  assert.equal(core.relationAllowed([rel('derives_from', 'a', 'b'), rel('derives_from', 'b', 'c')], rel('derives_from', 'c', 'a'), 5), false, 'an index that matches nothing excludes nothing');
  const dup = [rel('supports', 'a', 'b'), rel('contradicts', 'a', 'b')];
  assert.equal(core.relationAllowed(dup, rel('supports', 'a', 'b'), 1), false, 'changing contradicts to supports duplicates supports');
  assert.equal(core.relationAllowed(dup, rel('verifies', 'a', 'b'), 1), true);
  assert.equal(core.relationAllowed(dup, rel('supports', 'a', 'b'), 0), true, 'replacing itself with the same value');
  const cyc = [rel('prerequisite', 'a', 'b'), rel('supports', 'b', 'a')];
  assert.equal(core.relationAllowed(cyc, rel('prerequisite', 'b', 'a'), 1), false, 'changing supports b->a to prerequisite closes a cycle');
});
test('hypothesis-evidence: relationAllowed terminates on a hand-written cycle', () => {
  const rs = [rel('derives_from', 'a', 'b'), rel('derives_from', 'b', 'a'), rel('prerequisite', 'b', 'c'), rel('prerequisite', 'c', 'b')];
  assert.equal(core.relationAllowed(rs, rel('derives_from', 'b', 'c')), true, 'c does not reach b by derivation');
  assert.equal(core.relationAllowed(rs, rel('derives_from', 'c', 'a')), true, 'a reaches nothing that leads back to c');
  assert.equal(core.relationAllowed(rs, rel('derives_from', 'a', 'c')), true);
  assert.equal(core.relationAllowed(rs, rel('prerequisite', 'c', 'h')), true);
  assert.equal(core.relationAllowed(rs, rel('prerequisite', 'h', 'b')), true);
  assert.equal(core.relationAllowed([...rs, rel('derives_from', 'c', 'a')], rel('derives_from', 'a', 'c'), undefined), false, 'c->a is now a derivation, so a->c would close a loop');
  assert.equal(core.relationAllowed(rs, rel('derives_from', 'h', 'a')), true, 'the search from a walks the a<->b loop and ends without reaching h');
});
test('hypothesis-evidence: legalRelationTargets lists every topic relationAllowed accepts', () => {
  const m = relMap([rel('supports', 'a', 'b'), rel('derives_from', 'b', 'c'), rel('related', 'h', 'a')]);
  assert.deepEqual(core.legalRelationTargets(m, 'supports', 'a'), ['c', 'h', 'h2']);
  assert.deepEqual(core.legalRelationTargets(m, 'derives_from', 'c'), ['a', 'h', 'h2'], 'b is out: it would close b->c->b');
  assert.deepEqual(core.legalRelationTargets(m, 'related', 'a'), ['b', 'c', 'h2'], 'h already has related with a');
  assert.deepEqual(core.legalRelationTargets(relMap(undefined), 'verifies', 'a'), ['b', 'c', 'h', 'h2']);
});
test('hypothesis-evidence: retargetTopicRelations drops a newly closed derivation cycle and counts both acyclic kinds together', () => {
  const m = relMap([rel('derives_from', 'a', 'c'), rel('derives_from', 'c', 'b'), rel('prerequisite', 'a', 'h'), rel('prerequisite', 'h', 'b'), rel('supports', 'c', 'b', 'kept')]);
  const result = core.retargetTopicRelations(m, ['a', 'b'], 'a');
  assert.deepEqual(plain(m.topicRelations), [rel('derives_from', 'a', 'c'), rel('prerequisite', 'a', 'h'), rel('supports', 'c', 'a', 'kept')]);
  assert.deepEqual(plain(result), { droppedCycles: 2 });
});
test('hypothesis-evidence: retargetTopicRelations leaves an existing derivation cycle alone and keeps descriptions', () => {
  const m = relMap([rel('derives_from', 'a', 'b'), rel('derives_from', 'b', 'a'), rel('verifies', 'c', 'h', 'note')]);
  assert.deepEqual(plain(core.retargetTopicRelations(m, ['c'], 'c2')), { droppedCycles: 0 });
  assert.deepEqual(plain(m.topicRelations), [rel('derives_from', 'a', 'b'), rel('derives_from', 'b', 'a'), rel('verifies', 'c2', 'h', 'note')]);
});
test('hypothesis-evidence: retargetTopicRelations keeps one related link when two merged topics were both related to the same topic', () => {
  const m = relMap([rel('related', 'a', 'b', 'first'), rel('related', 'b', 'c'), rel('related', 'h', 'c'), rel('supports', 'a', 'b')]);
  core.retargetTopicRelations(m, ['a', 'c'], 'a');
  assert.deepEqual(plain(m.topicRelations), [rel('related', 'a', 'b', 'first'), rel('related', 'h', 'a'), rel('supports', 'a', 'b')], 'b-a and b-c collapse; a-b supports is a different kind');
  const self = relMap([rel('related', 'a', 'c')]); core.retargetTopicRelations(self, ['a', 'c'], 'a');
  assert.equal('topicRelations' in self, false, 'a link between the merged topics becomes a self link and goes');
});
test('hypothesis-evidence: dangling AIM convergence still throws', () => {
  const m = map([{ ...node('a'), aimKind: 'question' }]); m.aim = { branches: [], runs: [] };
  m.nodes[0].aimConvergesFromNodeIds = ['missing'];
  assert.throws(() => core.parseMap(core.serializeMap(m)));
});
