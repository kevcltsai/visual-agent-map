const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, integrationTest, root, load, core, plain, plannerReview, seedCoverageAncestors, deliveryFixture, savedEvidenceNeedsSearch, researchGapAudit, aimPhase, auditEcho, obsidian, Repository, DEFAULT_SETTINGS, fixture, aimMapFixture, coverageModel } = require('../support.cjs');
test('captured malformed ask_user Planner response is rejected when it omits choices', () => {
  const { parseAimPlannerReview } = load('experiences/aim/planner-review.ts');
  const captured = JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/aim/ask_user_missing_options.json'), 'utf8'));
  assert.equal(captured.provenance.artifact, 'aim-general-partial-live-20261005130054-abd4d5ae.json');
  assert.match(captured.result.detail, /"decision":"ask_user"/);
  assert.equal(captured.result.suggestions.length, 0);
  assert.throws(() => parseAimPlannerReview(captured.result), /ask_user requires one material question and 2–5 distinct answer options/);
});
test('captured malformed Planner response without a decision marker is rejected', () => {
  const { parseAimPlannerReview } = load('experiences/aim/planner-review.ts');
  const captured = JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/aim/planner_missing_marker.json'), 'utf8'));
  assert.equal(captured.provenance.artifact, 'aim-partial-continuation-retry-20261005130856-863f1bbd.json');
  assert.doesNotMatch(captured.result.detail, /aim-review/);
  assert.throws(() => parseAimPlannerReview(captured.result), /missing its machine-readable decision block/);
});
integrationTest('planned AIM resume skips the saved plan and already completed subtopics', async () => {
  const { repo, contents } = fixture();
  const mapPath = await repo.createMap('Planned resume');
  const { AimRunStore } = load('experiences/aim/research-run-store.ts');
  const { AimManualFlow } = load('experiences/aim/manual-flow.ts');
  const store = new AimRunStore(repo); let mapDoc = await repo.readMap(mapPath);
  const question = await repo.createNote('Synthetic resume question', 'gpt-6-luna', mapDoc, mapPath, 'workspace');
  question.aimKind = 'question'; question.aimQuestion = { requestId: 'planned-resume-question', parentBranchId: null, options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], allowMultiple: false, allowFreeText: true };
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
  const flow = new AimManualFlow(repo, store, async (context, _model, _reasoning, _signal, onWebSearchEvent) => {
    const delivery = deliveryFixture(context); if (delivery) return delivery;
    const phase = ['research-plan', 'subtopic-research', 'report-review', 'decision-quality-review'].find(item => aimPhase(context, item));
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
  const resumedBranch = mapDoc.aim.branches.find(item => item.id === branch.id);
  assert.equal(resumedBranch.results.filter(item => item.kind === 'research').map(item => item.subtopicId).join(','), 'safety,method');
  assert.equal(resumedBranch.results.filter(item => item.kind === 'conclusion').length, 1);
});
integrationTest('AIM research plans accept one target without quota filler and keep unique bounded targets', async () => {
  const { repo, mapPath, question, store } = await aimMapFixture();
  let map = await repo.readMap(mapPath); const questionNode = map.nodes.find(node => node.id === question.id);
  questionNode.aimKind = 'question'; questionNode.aimQuestion = { requestId: 'legacy-one-plan-question', parentBranchId: null, options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], allowMultiple: false, allowFreeText: true };
  await repo.saveMap(mapPath, map);
  const createBranch = requestId => store.createAnswerBranch(mapPath, { requestId, questionNodeId: question.id, parentBranchId: null, answerSnapshot: { selections: ['a'], freeText: '' }, inputSnapshot: { topic: 'Legacy plan', conditions: {}, upstreamResults: [] } });
  const invalidBranch = await createBranch('invalid-plan');
  const target = (id, title = id) => ({ id, title, task: `Research ${title}.`, expectedValue: `Clarify ${title}.` });
  await assert.rejects(store.saveResearchPlan(mapPath, invalidBranch.id, Array.from({ length: 6 }, (_, index) => target(`six-${index}`))), /0–5 valid research subtopics/);
  await assert.rejects(store.saveResearchPlan(mapPath, invalidBranch.id, [target('duplicate', 'Same'), target('duplicate', 'Other')]), /unique ids and titles/);
  assert.equal((await repo.readMap(mapPath)).aim.branches.find(branch => branch.id === invalidBranch.id).researchPlan, undefined, 'invalid plans are rejected before persistence');
  await store.saveResearchPlan(mapPath, invalidBranch.id, [target('one')]);

  const legacyBranch = await createBranch('legacy-one-plan');
  map = await repo.readMap(mapPath); map.aim.branches.find(branch => branch.id === legacyBranch.id).researchPlan = [target('legacy', 'Legacy target')]; await repo.saveMap(mapPath, map);
  const { AimManualFlow } = load('experiences/aim/manual-flow.ts'); const phases = [];
  const flow = new AimManualFlow(repo, store, async context => {
    const phase = aimPhase(context, 'research-plan') ? 'research-plan' : aimPhase(context, 'subtopic-research') ? 'subtopic-research' : aimPhase(context, 'report-review') ? 'report-review' : 'other'; phases.push(phase);
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
integrationTest('AIM removes duplicated topic context and rejects oversized prompts without truncation', async () => {
  const { repo } = fixture(); const { createAimMap } = load('experiences/aim/create-map.ts');
  const { AimManualFlow } = load('experiences/aim/manual-flow.ts');
  const duplicatedDetail = 'D'.repeat(70_000);
  const dedupeMap = await createAimMap(repo, 'gpt-6-luna', { requestId: 'aim-context-dedupe', topic: 'Synthetic context dedupe', context: '' });
  await repo.updateNote(dedupeMap.root.path, { detail: duplicatedDetail });
  let acceptedContext;
  const dedupeFlow = new AimManualFlow(repo, new (load('experiences/aim/research-run-store.ts').AimRunStore)(repo), async context => {
    acceptedContext = context;
    return { summary: 'Which condition matters?', detail: 'A synthetic choice is needed.', suggestions: [{ title: 'Option A' }, { title: 'Option B' }], visualReferences: [] };
  });
  const planned = await dedupeFlow.planNextQuestion(dedupeMap.mapPath, dedupeMap.root.id, 'gpt-6-luna', 'low', 'context-dedupe-question');
  assert.equal(planned.status, 'question');
  assert.equal(acceptedContext.detail, '', 'a topic detail already represented in the Planner task is removed from the duplicated context field');
  assert.ok(acceptedContext.task.includes(duplicatedDetail), 'deduplication preserves the full topic detail in the task');

  const oversizedMap = await createAimMap(repo, 'gpt-6-luna', { requestId: 'aim-context-oversized', topic: 'Synthetic oversized context', context: '' });
  const completeGoal = 'G'.repeat(240_000);
  await repo.updateNote(oversizedMap.root.path, { detail: completeGoal });
  let modelCalls = 0;
  const oversizedFlow = new AimManualFlow(repo, new (load('experiences/aim/research-run-store.ts').AimRunStore)(repo), async () => {
    modelCalls++;
    return { summary: 'Should not be called.', detail: 'The entire original goal must remain present.', suggestions: [], visualReferences: [] };
  });
  await assert.rejects(oversizedFlow.planNextQuestion(oversizedMap.mapPath, oversizedMap.root.id, 'gpt-6-luna', 'low', 'context-oversized-question'), /AIM model request is too large.*no goal, condition, or evidence was discarded/);
  assert.equal(modelCalls, 0, 'the model receives no truncated request when the full goal exceeds the budget');
});
integrationTest('AIM saved-evidence preflight includes one copy of ancestor reports and preserves branch answers', async () => {
  const { repo } = fixture(); const { createAimMap } = load('experiences/aim/create-map.ts');
  const { AimRunStore } = load('experiences/aim/research-run-store.ts');
  const { AimManualFlow } = load('experiences/aim/manual-flow.ts');
  const created = await createAimMap(repo, 'gpt-6-luna', { requestId: 'lineage-context-budget-map', topic: 'Choose a step-free outing route', context: 'Keep the total walk short.' });
  const store = new AimRunStore(repo); let map = await repo.readMap(created.mapPath);
  const parentQuestion = await repo.createNote('First route condition', 'gpt-6-luna', map, created.mapPath, 'workspace');
  parentQuestion.aimKind = 'question'; parentQuestion.aimQuestion = { requestId: 'lineage-context-parent-q', parentBranchId: null, options: [{ id: 'short', label: 'Short walking distance' }, { id: 'flat', label: 'Mostly flat' }], allowMultiple: false, allowFreeText: true };
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
  followupQuestion.parentId = reportDraft.nodeId; followupQuestion.aimKind = 'question';
  followupQuestion.aimQuestion = { requestId: 'lineage-context-child-q', parentBranchId: parentBranch.id, options: [{ id: 'stroller', label: 'Stroller access' }, { id: 'wheelchair', label: 'Wheelchair access' }], allowMultiple: false, allowFreeText: true };
  map.nodes.push(followupQuestion); await repo.saveMap(created.mapPath, map);
  const childBranch = await store.createAnswerBranch(created.mapPath, { requestId: 'lineage-context-child-a', questionNodeId: followupQuestion.id, parentBranchId: parentBranch.id, answerSnapshot: { selections: ['wheelchair'], freeText: 'Need a wide sidewalk.' }, inputSnapshot: { topic: map.title, conditions: { route: 'mostly flat', access: 'wheelchair; wide sidewalk' }, upstreamResults: [{ notePath: reportDraft.notePath, version: 1 }] } });
  await store.saveResearchPlanError(created.mapPath, childBranch.id, new Error('A prior plan response was invalid.'));
  const seen = [];
  const currentModel = coverageModel();
  const flow = new AimManualFlow(repo, store, async context => {
    seen.push(context);
    const complete = [context.task, context.detail, context.ancestors].join('\n');
    assert.match(complete, /Avoid steep ramps/); assert.match(complete, /wide sidewalk/);
    const indexedReport = complete.match(/Evidence ID: ([^\s]+)\nSummary: A route access report\./)?.[1];
    if (aimPhase(context, 'report-review') && indexedReport && !context.task.includes('Requested full evidence')) return { summary: 'Load the indexed parent evidence.', detail: `<!-- aim-evidence-request {"ids":["${indexedReport}"]} -->`, suggestions: [], visualReferences: [] };
    if (context.task.includes('Requested full evidence')) assert.equal(context.task.split('A'.repeat(80_000)).length - 1, 1, 'requested long report body is loaded once and never truncated');
    return currentModel.ask(context);
  });
  const result = await flow.retryAnswerResearch(created.mapPath, childBranch.id, 'gpt-6-luna', 'low');
  assert.equal(result.status, 'waiting-user');
  assert.ok(seen.some(context => aimPhase(context, 'subtopic-research')));
  assert.ok(seen.some(context => context.task.includes('Requested full evidence') && context.task.includes(uniqueMarker)), 'the full report is loaded only after an explicit evidence-ID request');
  assert.equal((await repo.readNote(reportDraft.notePath)).detail, longReport, 'stored source report is unchanged');

});
integrationTest('AIM topic rename rebases saved paths and refreshes attempt snapshot hashes', async () => {
  const { repo } = fixture();
  const { createAimMap } = load('experiences/aim/create-map.ts');
  const created = await createAimMap(repo, 'gpt-6-luna', { requestId: 'rename-aim-map', topic: 'Rename source', context: 'Synthetic fixture.' });
  const { AimRunStore } = load('experiences/aim/research-run-store.ts');
  let id = 0;
  const store = new AimRunStore(repo, () => `rename-id-${++id}`);
  let saved = await repo.readMap(created.mapPath);
  const question = await repo.createNote('Synthetic question', 'gpt-6-luna', saved, created.mapPath, 'workspace');
  saved.nodes.push(question);
  saved.aim.rootDraft = { nodeId: 'reserved-root-draft', notePath: created.root.path, title: 'Synthetic root draft', context: 'Fixture only.' };
  saved.aim.questionDraft = { requestId: 'rename-question-draft', nodeId: 'reserved-question-draft', parentId: question.id, notePath: `${repo.topicRoot(created.mapPath)}/Notes/Pending question.md`, title: 'Pending question', summary: 'A synthetic pending question.', detail: '', prompt: '', model: 'gpt-6-luna', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] };
  await repo.saveMap(created.mapPath, saved);
  const branch = await store.createAnswerBranch(created.mapPath, {
    questionNodeId: question.id, parentBranchId: null, answerSnapshot: { selections: ['a'], freeText: 'Synthetic answer.' },
    inputSnapshot: { topic: saved.title, conditions: {}, upstreamResults: [{ notePath: created.root.path, version: 1 }] }
  });
  const attempt = await store.startAttempt(created.mapPath, branch.id, 'rename-run');
  const draft = (await store.createResultDraft(created.mapPath, attempt, 'Synthetic result draft', 'gpt-6-luna')).draft;
  saved = await repo.readMap(created.mapPath);
  saved.aim.runs[0].attempts[0].status = 'completed';
  await repo.saveMap(created.mapPath, saved);
  store.releaseAttempt(created.mapPath, attempt);
  const resultAttempt = await store.startAttempt(created.mapPath, branch.id, 'rename-result-run');
  const committedDraft = (await store.createResultDraft(created.mapPath, resultAttempt, 'Synthetic committed result', 'gpt-6-luna')).draft;
  await store.commitResult(created.mapPath, resultAttempt, committedDraft.id, { summary: 'Synthetic result.', detail: 'Fixture report.' });
  store.releaseAttempt(created.mapPath, resultAttempt);

  const nextPath = await repo.renameTopic(created.mapPath, 'Rename target');
  const renamed = await repo.readMap(nextPath), renamedBranch = renamed.aim.branches[0];
  const nextRoot = repo.topicRoot(nextPath);
  assert.equal(renamed.title, 'Rename target');
  assert.ok(renamed.nodes.every(node => node.path.startsWith(`${nextRoot}/`)));
  assert.equal(renamedBranch.inputSnapshot.upstreamResults[0].notePath, `${nextRoot}/Notes/${created.root.path.split('/').at(-1)}`);
  assert.equal(renamed.aim.resultDrafts[0].notePath, `${nextRoot}/Notes/${draft.notePath.split('/').at(-1)}`);
  assert.equal(renamed.aim.rootDraft.notePath, `${nextRoot}/Notes/${created.root.path.split('/').at(-1)}`);
  assert.equal(renamed.aim.questionDraft.notePath, `${nextRoot}/Notes/Pending question.md`);
  assert.equal(renamedBranch.results[0].notePath, `${nextRoot}/Notes/${committedDraft.notePath.split('/').at(-1)}`);
  const expectedHash = require('node:crypto').createHash('sha256').update(JSON.stringify({ branch: renamedBranch.inputSnapshot, answer: renamedBranch.answerSnapshot })).digest('hex');
  assert.equal(renamed.aim.runs[0].attempts[0].inputSnapshotHash, expectedHash);
  assert.equal(renamed.aim.resultDrafts[0].inputSnapshotHash, expectedHash);
  assert.equal(core.parseMap(await repo.app.vault.read(repo.file(nextPath))).aim.resultDrafts[0].notePath, renamed.aim.resultDrafts[0].notePath);
});
integrationTest('AIM topic rename blocks persisted running or saving attempts across Repository instances', async () => {
  const { repo } = fixture();
  const { createAimMap } = load('experiences/aim/create-map.ts');
  const created = await createAimMap(repo, 'gpt-6-luna', { requestId: 'rename-active-map', topic: 'Active research', context: '' });
  const { AimRunStore } = load('experiences/aim/research-run-store.ts');
  const store = new AimRunStore(repo);
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
  assert.equal(pending.aim.runs[0].attempts[0].status, 'saving');
  assert.equal(pending.aim.pendingCommits[0].notePath, draft.notePath);
  await assert.rejects(reopenedRepo.renameTopic(created.mapPath, 'Should not move'), /still running or saving/);
  releaseSave(); await commit;
  assert.ok(repo.app.vault.getAbstractFileByPath(repo.topicRoot(created.mapPath)));
  assert.equal(repo.app.vault.getAbstractFileByPath('Agent Workspace/AIM/Should not move'), undefined);
});
integrationTest('AIM Manual Planner question, user answer, research result and outline metadata share one persisted branch', async () => {
  const { repo } = fixture();
  const { createAimMap } = load('experiences/aim/create-map.ts');
  const created = await createAimMap(repo, 'gpt-6-luna', { requestId: 'manual-flow-map-1', topic: '在家煎牛排', context: '鑄鐵鍋；沒有烤箱。' });
  const { AimRunStore } = load('experiences/aim/research-run-store.ts');
  const { AimManualFlow, AIM_UNKNOWN_OPTION_ID } = load('experiences/aim/manual-flow.ts');
  let nextId = 0, aiCalls = 0, researchCalls = 0, finishResearch;
  const store = new AimRunStore(repo, () => `manual-store-${++nextId}`, () => '2026-10-05T01:00:00.000Z');
  const flow = new AimManualFlow(repo, store, async context => {
    aiCalls++;
    if (aimPhase(context, 'saved-evidence-review')) return savedEvidenceNeedsSearch();
    if (context.task.includes('Decide whether one missing user condition')) {
      assert.equal(context.mode, 'task');
      return { summary: '你偏好的牛排熟度是什麼？', detail: '熟度會改變烹調建議，應由使用者決定。', suggestions: [{ title: '偏紅', task: '', contribution: '', parentTitle: '' }, { title: '較熟', task: '', contribution: '', parentTitle: '' }], visualReferences: [] };
    }
    if (aimPhase(context, 'research-plan')) return { summary: '食安與烹調方式兩項研究。', detail: '<!-- aim-plan {"subtopics":[{"id":"safety","title":"食安溫度","task":"查詢牛排安全溫度","expectedValue":"確保建議保留安全限制"},{"id":"method","title":"鑄鐵鍋做法","task":"查詢無烤箱時的烹調順序","expectedValue":"給出可操作做法"}]} -->\n兩個不同研究面向。', suggestions: [], visualReferences: [] };
    if (aimPhase(context, 'decision-quality-review')) return auditEcho(context);
    if (aimPhase(context, 'report-review')) return plannerReview('ask_user', { rationale: '在已完成研究後，個人偏好仍會改變最適合的收尾方式。', question: '下一步想深入哪一項？' }, '未知偏好時保留條件式選擇；食安與烹調報告已整理。', '未替使用者猜測熟度；來源界線與限制已保留。', ['食安限制', '烹調細節']);
    assert.equal(context.researchMode, 'research');
    if (!context.task.includes('__aim_unknown__') && !context.task.includes('未知／無偏好')) assert.match(context.task, /偏紅/);
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
  assert.equal(question.aimKind, 'question'); assert.equal(question.aimQuestion.allowMultiple, true); assert.equal(question.aimQuestion.allowFreeText, true);
  assert.equal(question.aimQuestion.options.at(-1).id, AIM_UNKNOWN_OPTION_ID);
  const questionNote = await repo.readNote(question.path);
  assert.equal(questionNote.summary, '你偏好的牛排熟度是什麼？'); assert.match(questionNote.prompt, /exactly one question node/i);

  const answer = { requestId: 'manual-answer-1', selections: question.aimQuestion.options.slice(0, 2).map(option => option.id), freeText: '約 1.5 吋；沒有烤箱。' };
  const first = flow.answerAndResearch(created.mapPath, question.id, answer, 'gpt-6-luna', 'low');
  while (!finishResearch) await new Promise(resolve => setTimeout(resolve, 0));
  const repeated = flow.answerAndResearch(created.mapPath, question.id, answer, 'gpt-6-luna', 'low');
  const finish = finishResearch; finishResearch = undefined; finish();
  const [outcome, repeatedOutcome] = await Promise.all([first, repeated]);
  assert.deepEqual(plain(outcome), plain(repeatedOutcome)); assert.equal(outcome.status, 'waiting-user'); assert.equal(aiCalls, 5, 'initial question, research plan, two independent searches, and report review');
  let savedMap = await repo.readMap(created.mapPath);
  assert.equal(savedMap.aim.branches.length, 1); assert.deepEqual(plain(savedMap.aim.branches[0].answerSnapshot), plain({ selections: answer.selections, freeText: answer.freeText }));
  const firstBranch = savedMap.aim.branches[0];
  assert.equal(firstBranch.results.filter(item => item.kind === 'research').length, 2);
  const resultRef = firstBranch.results.find(item => item.kind === 'synthesis'), resultNode = savedMap.nodes.find(node => node.id === resultRef.nodeId);
  assert.equal(resultNode.aimKind, 'synthesis');
  const report = await repo.readNote(resultRef.notePath); assert.match(report.summary, /未知偏好時保留條件式選擇/); assert.match(report.detail, /來源界線/); assert.match(report.detail, /條件式研究報告/);

  const unknown = { requestId: 'manual-answer-unknown', selections: [AIM_UNKNOWN_OPTION_ID], freeText: '' };
  const unknownResult = await flow.answerAndResearch(created.mapPath, question.id, unknown, 'gpt-6-luna', 'low');
  assert.equal(unknownResult.status, 'waiting-user');
  savedMap = await repo.readMap(created.mapPath); assert.equal(savedMap.aim.branches.length, 2);
  assert.deepEqual(plain(savedMap.aim.branches[1].answerSnapshot), { selections: unknown.selections, freeText: unknown.freeText });
});
integrationTest('AIM saved synthesis can create a distinct local-only question with saved lineage and duplicate protection', async () => {
  const { repo } = fixture();
  const { createAimMap } = load('experiences/aim/create-map.ts');
  const created = await createAimMap(repo, 'gpt-6-luna', { requestId: 'new-question-from-result-map', topic: 'Synthetic cooking plan', context: 'Use a cast-iron pan; no oven.' });
  const { AimRunStore } = load('experiences/aim/research-run-store.ts');
  const { AimManualFlow } = load('experiences/aim/manual-flow.ts');
  const store = new AimRunStore(repo); let id = 0;
  const originalQuestionFlow = new AimManualFlow(repo, store, async () => ({ summary: 'Which doneness do you prefer?', detail: 'Synthetic initial question.', suggestions: [{ title: 'Pink' }, { title: 'Well done' }], visualReferences: [] }));
  const originalQuestion = (await originalQuestionFlow.planNextQuestion(created.mapPath, created.root.id, 'gpt-6-luna', 'low', 'new-question-source-initial')).node;
  const branch = await store.createAnswerBranch(created.mapPath, { requestId: 'new-question-source-answer', questionNodeId: originalQuestion.id, parentBranchId: null, answerSnapshot: { selections: [originalQuestion.aimQuestion.options[0].id], freeText: 'Synthetic answer.' }, inputSnapshot: { topic: created.map.title, conditions: { equipment: 'Cast-iron pan; no oven.', preference: 'Synthetic pink doneness choice.' }, upstreamResults: [] } });
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
  const saved = await repo.readMap(created.mapPath), resultRef = saved.aim.branches.find(item => item.id === branch.id).results.find(item => item.kind === 'synthesis');
  const resultNode = saved.nodes.find(item => item.id === resultRef.nodeId);
  const synthesisRun = saved.aim.runs.find(item => item.id === resultRef.runId), synthesisAttempt = synthesisRun.attempts.find(item => item.id === resultRef.attemptId);
  synthesisAttempt.status = 'completed';
  synthesisAttempt.plannerReviews = [{ decision: 'ask_user', researchTurn: 1, question: 'Which part would you like to explore next?', rationale: 'The saved report supports more than one useful next direction.', answerOptions: ['Safety', 'Technique'] }];
  await repo.saveMap(created.mapPath, saved);
  const reviewRecovery = new AimManualFlow(repo, store, async () => { throw new Error('Recovery must use the persisted Planner review.'); });
  assert.equal(await reviewRecovery.recoverPostReportQuestions(created.mapPath), 1, 'the persisted report review creates its original follow-up question');
  let beforeDismiss = await repo.readMap(created.mapPath);
  const dismissed = beforeDismiss.nodes.find(item => item.aimQuestion?.requestId === `post-${resultRef.runId}-${resultRef.attemptId}`);
  assert.ok(dismissed); const branchResultsBeforeDelete = plain(beforeDismiss.aim.branches.find(item => item.id === branch.id).results);
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const deletionView = new VisualAgentMapView({ app: {} }, { repo, settings: { ...DEFAULT_SETTINGS } });
  const deletedNodeIds = new Set([dismissed.id]), originalNodesBeforeDelete = beforeDismiss.nodes;
  beforeDismiss.nodes = beforeDismiss.nodes.filter(item => !deletedNodeIds.has(item.id));
  deletionView.removeAimReferences(beforeDismiss, deletedNodeIds, originalNodesBeforeDelete);
  await repo.saveMap(created.mapPath, beforeDismiss);
  assert.equal(await reviewRecovery.recoverPostReportQuestions(created.mapPath), 0, 'reload recovery respects an explicitly dismissed question');
  const afterDismiss = await repo.readMap(created.mapPath);
  assert.equal(afterDismiss.nodes.some(item => item.id === dismissed.id), false);
  assert.deepEqual(plain(afterDismiss.aim.branches.find(item => item.id === branch.id).results), branchResultsBeforeDelete, 'dismissing the question preserves its answer branch and saved results');
  let modelCalls = 0, releasePlanner;
  const planner = new AimManualFlow(repo, store, async context => {
    modelCalls++;
    const response = new Promise(resolve => { releasePlanner = () => resolve({ summary: 'How much hands-on guidance would you like?', detail: 'Synthetic new question based on the saved report.', suggestions: [{ title: 'Step-by-step' }, { title: 'Brief overview' }], visualReferences: [] }); });
    assert.equal(context.mode, 'task'); assert.equal(context.researchMode, 'local');
    assert.match(context.task, /new follow-up question/i); assert.match(context.task, /cast-iron pan/i);
    assert.match(context.task, /Which doneness do you prefer/); assert.match(context.task, /Which part would you like to explore next/); assert.match(context.task, /Synthetic saved safety report/);
    assert.match(context.task, /Cast-iron pan; no oven/);
    assert.equal(context.aimEvidenceIds.length, 2, 'every saved branch result is available to the local Planner');
    return response;
  }, () => `new-question-id-${++id}`);
  const first = planner.planNextQuestion(created.mapPath, resultNode.id, 'gpt-6-luna', 'low', 'new-question-from-saved-result', branch.id);
  while (!releasePlanner) await new Promise(resolve => setTimeout(resolve, 0));
  const duplicateClick = planner.planNextQuestion(created.mapPath, resultNode.id, 'gpt-6-luna', 'low', 'new-question-from-saved-result', branch.id);
  releasePlanner();
  const [generated, duplicate] = await Promise.all([first, duplicateClick]);
  assert.equal(generated.status, 'question'); assert.equal(duplicate.node.id, generated.node.id); assert.equal(modelCalls, 1);
  assert.notEqual((await repo.readNote(generated.node.path)).summary, (await repo.readNote(dismissed.path)).summary, 'the new request generates a fresh question rather than reviving the dismissed one');
  assert.equal(generated.node.parentId, resultNode.id); assert.equal(generated.node.aimQuestion.parentBranchId, branch.id);
  assert.equal(generated.options.filter(option => option.id !== '__aim_unknown__').length, 2);
  assert.equal((await repo.readMap(created.mapPath)).nodes.filter(node => node.aimQuestion?.requestId === 'new-question-from-saved-result').length, 1);
  const noRepeatPlanner = new AimManualFlow(repo, store, async () => ({ summary: 'Which doneness do you prefer?', detail: 'Must be rejected as an existing question.', suggestions: [{ title: 'Pink' }, { title: 'Well done' }], visualReferences: [] }));
  await assert.rejects(noRepeatPlanner.planNextQuestion(created.mapPath, resultNode.id, 'gpt-6-luna', 'low', 'new-question-repeat-existing', branch.id), /repeated an existing question/);
  assert.equal((await repo.readMap(created.mapPath)).nodes.filter(node => node.parentId === resultNode.id && node.aimKind === 'question').length, 1);
  let releaseStale;
  const stalePlanner = new AimManualFlow(repo, store, async () => new Promise(resolve => { releaseStale = () => resolve({ summary: 'Should not be saved after branch changes?', detail: 'Synthetic stale output.', suggestions: [{ title: 'First' }, { title: 'Second' }], visualReferences: [] }); }));
  const staleResultPlan = stalePlanner.planNextQuestion(created.mapPath, resultNode.id, 'gpt-6-luna', 'low', 'new-question-stale-snapshot', branch.id);
  while (!releaseStale) await new Promise(resolve => setTimeout(resolve, 0));
  const changedMap = await repo.readMap(created.mapPath);
  changedMap.aim.branches.find(item => item.id === branch.id).inputSnapshot.conditions.latestUserCondition = 'Changed in another view.';
  await repo.saveMap(created.mapPath, changedMap);
  releaseStale();
  await assert.rejects(staleResultPlan, /saved answer or research changed/);
  assert.equal((await repo.readMap(created.mapPath)).nodes.some(node => node.aimQuestion?.requestId === 'new-question-stale-snapshot'), false, 'stale Planner output never writes a question');
});
integrationTest('captured malformed partial Planner replies recover once from the saved report without searching again or replacing the seed', async () => {
  const { AimRunStore } = load('experiences/aim/research-run-store.ts');
  const { AimManualFlow } = load('experiences/aim/manual-flow.ts');
  const { createAimMap } = load('experiences/aim/create-map.ts');
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
    const captured = JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/aim', scenario.file), 'utf8'));
    const { repo, contents } = fixture();
    const created = await createAimMap(repo, 'gpt-6-luna', { requestId: `format-recovery-${index}`, topic: `Synthetic format recovery ${scenario.name}`, context: 'Synthetic test only; do not infer a real preference.' });
    const store = new AimRunStore(repo);
    const questionPlanFlow = new AimManualFlow(repo, store, async context => {
      assert.match(context.task, /Plan the next Manual AIM interaction/);
      return { summary: 'Which doneness?', detail: 'A synthetic answer will be provided.', suggestions: [{ title: 'Three-quarter' }, { title: 'Well done' }], visualReferences: [] };
    });
    const planned = await questionPlanFlow.planNextQuestion(created.mapPath, created.root.id, 'gpt-6-luna', 'low', `question-${index}`);
    const questionNote = await repo.readNote(planned.node.path), selected = planned.options[0];
    const branch = await store.createAnswerBranch(created.mapPath, { requestId: `answer-${index}`, questionNodeId: planned.node.id, parentBranchId: null, answerSnapshot: { selections: [selected.id], freeText: 'Synthetic test condition; not a real user preference.' }, inputSnapshot: { topic: created.map.title, conditions: { [questionNote.summary]: `${selected.label}; explicitly synthetic.` }, upstreamResults: [] } });
    await seedCoverageAncestors(repo, created.mapPath, branch.id);
    const savedResearchNodeIds = [];
    if (index === 0) {
      const savedMap = await repo.readMap(created.mapPath), savedBranch = savedMap.aim.branches.find(item => item.id === branch.id);
      savedBranch.researchPlan = [{ id: 'saved-subtopic', title: 'Saved subtopic', task: 'Persist a synthetic prior subtopic report.', expectedValue: 'Exercise continuation convergence.' }];
      await repo.saveMap(created.mapPath, savedMap);
      const researchHandle = await store.startAttempt(created.mapPath, branch.id, `saved-subtopic-run-${index}`, { model: 'gpt-6-luna', reasoning: 'low', maxResearchTurns: 1 });
      await store.recordResearchTurn(created.mapPath, researchHandle);
      const researchDraft = await store.createResultDraft(created.mapPath, researchHandle, 'Saved subtopic report', 'gpt-6-luna', 'low', { kind: 'research', subtopicId: 'saved-subtopic' });
      assert.equal(researchDraft.status, 'ready');
      await store.updateResultDraftReport(created.mapPath, researchHandle, researchDraft.draft.id, 'Previously saved research summary.', 'Previously saved research detail.');
      const researchResult = await store.commitResult(created.mapPath, researchHandle, researchDraft.draft.id, { summary: 'Previously saved research summary.', detail: 'Previously saved research detail.' });
      assert.equal(researchResult.status, 'committed');
      const afterResearch = await repo.readMap(created.mapPath), branchAfterResearch = afterResearch.aim.branches.find(item => item.id === branch.id);
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
    const continuation = new AimManualFlow(repo, store, async (context, model, reasoning, signal, onWebSearchEvent) => {
      calls.push({ context, model, reasoning });
      assert.equal(model, 'gpt-6-luna'); assert.equal(reasoning, 'low');
      const delivery = deliveryFixture(context); if (delivery) return delivery;
      if (aimPhase(context, 'research-gap-audit')) return researchGapAudit('external_evidence', 'The target is a source-backed method fact that can be checked externally.');
      if (context.researchMode === 'research') {
        searchCalls++;
        onWebSearchEvent?.({ method: 'item/started', params: { item: { action: { type: 'search' } } } });
        onWebSearchEvent?.({ method: 'item/completed', params: { item: { action: { type: 'search' } } } });
        return { summary: 'Persisted report used by both Planner passes.', detail: 'Research status: search completed\nExact saved report content for this test.', suggestions: [], visualReferences: [] };
      }
      localPlannerCalls++;
      if (localPlannerCalls === 1) return captured.result;
      assert.match(context.task, /Format validation error:/);
      if (/aim-review/.test(captured.result.detail)) {
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
    const savedMap = await repo.readMap(created.mapPath), savedBranch = savedMap.aim.branches.find(item => item.id === branch.id), savedRun = savedMap.aim.runs.find(item => item.id === runId), attempt = savedRun.attempts.at(-1);
    assert.equal(savedBranch.results.length, 2 + savedResearchNodeIds.length); assert.ok(savedBranch.results.some(item => item.resultId === seed.resultId));
    const continuationResult = savedBranch.results.find(item => item.runId === runId && item.attemptId === attempt.id && item.kind === 'synthesis');
    const continuationNode = savedMap.nodes.find(item => item.id === continuationResult.nodeId);
    if (savedResearchNodeIds.length) {
      assert.equal(continuationNode.parentId, savedResearchNodeIds.at(-1), 'continued synthesis uses the latest saved research node as its parent');
      assert.deepEqual(plain(continuationNode.aimConvergesFromNodeIds), savedResearchNodeIds, 'continued synthesis links to all saved research nodes');
    } else {
      assert.equal(continuationNode.parentId, branch.questionNodeId, 'legacy continuation without research keeps the question as parent');
      assert.equal(continuationNode.aimConvergesFromNodeIds, undefined, 'legacy continuation does not invent convergence sources');
    }
    const pendingQuestion = outcome.status === 'waiting-user' ? savedMap.nodes.find(item => item.id === outcome.questionNodeId) : undefined;
    if (pendingQuestion) assert.equal(pendingQuestion.parentId, continuationNode.id, 'the user question remains attached to its continuation result');
    assert.equal(attempt.status, 'completed'); assert.equal(attempt.researchTurns, 1); assert.equal(attempt.searchDiagnostics.length, 1); assert.equal(attempt.searchDiagnostics[0].completedSearchActions, 1);
    assert.deepEqual(plain(attempt.plannerReviews.map(item => item.decision)), [scenario.outcome === 'waiting-user' ? 'ask_user' : 'conclude']);
    assert.equal(savedMap.aim.pendingCommits.length, 0); assert.equal(savedMap.aim.resultDrafts.length, 0);
  }
});
integrationTest('Planner reviews a saved Searcher diagnostic on a new fenced attempt without repeating completed research', async () => {
  const { AimRunStore } = load('experiences/aim/research-run-store.ts');
  const { AimManualFlow } = load('experiences/aim/manual-flow.ts');
  const runCase = async (suffix, reviews) => {
    const { repo, app, mapPath, question, store } = await aimMapFixture();
    await repo.updateNote(question.path, { summary: 'How can a 1.5-inch steak reach 145°F and develop a browned crust in a cast-iron pan without an oven?', detail: 'Synthetic test fixture: core requested outcomes are a safe internal temperature and a browned-crust stovetop method.' });
    const branch = await store.createAnswerBranch(mapPath, { requestId: `saved-report-${suffix}`, questionNodeId: question.id, parentBranchId: null, answerSnapshot: { selections: [], freeText: 'Synthetic scenario: medium rare; cast-iron pan; thermometer; no oven.' }, inputSnapshot: { topic: 'Steak', conditions: { scenario: 'synthetic medium-rare answer' }, upstreamResults: [] } });
    const first = await store.startAttempt(mapPath, branch.id, 'run-saved-report', { model: 'gpt-6-luna', reasoning: 'low', maxResearchTurns: 2 });
    await store.recordResearchTurn(mapPath, first);
    await store.recordSearchDiagnostic(mapPath, first, { researchTurn: 1, startedEvents: 1, completedEvents: 1, completedSearchActions: 1, otherCompletedActions: 0 });
    await store.failAttempt(mapPath, first, 'Original attempt failed after its Searcher report was retained for diagnostic recovery.');
    const map = await repo.readMap(mapPath);
    const questionNode = map.nodes.find(item => item.id === question.id); questionNode.aimKind = 'question';
    questionNode.aimQuestion = { requestId: `saved-report-question-${suffix}`, parentBranchId: null, options: [{ id: 'medium', label: 'Medium rare' }, { id: 'safe', label: 'Follow safety guidance' }], allowMultiple: false, allowFreeText: true };
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
      if (aimPhase(context, 'research-gap-audit')) return researchGapAudit('external_evidence', 'The remaining target is externally verifiable method evidence.');
      if (aimPhase(context, 'decision-quality-review')) return auditEcho(context);
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
    const view = new VisualAgentMapView({ app }, { repo, settings: { ...DEFAULT_SETTINGS, language: 'en' }, mutate: async work => work(), syncOutline() {}, releaseOutline() {}, addAimDiagrams: async request => request.detail, askModel: ask });
    view.path = mapPath; view.map = await repo.readMap(mapPath); view.render = () => {};
    await view.hydrateFailedReportTargets(() => true);
    assert.equal(view.aimFailedReports.get(question.id)?.runId, 'run-saved-report', 'the current failed attempt exposes its unique saved search report');
    assert.equal(view.aimFailedReports.get(question.id)?.diagnosticNotePath, report.path);
    await view.retryAimFromSavedReport(question.id);
    const outcome = { status: (await repo.readMap(mapPath)).aim.runs.find(item => item.id === 'run-saved-report').attempts[1].status === 'partial' ? 'partial' : 'completed' };
    const reopened = new Repository(app, repo.settings), savedMap = await reopened.readMap(mapPath);
    const savedBranch = savedMap.aim.branches.find(item => item.id === branch.id), savedRun = savedMap.aim.runs.find(item => item.id === 'run-saved-report');
    const originalReport = await reopened.readNote(report.path), finalRef = savedBranch.results.at(-1);
    assert.ok(finalRef, `saved-report retry did not publish a result; attempt=${JSON.stringify(savedRun.attempts[1])}; calls=${JSON.stringify(calls.map(context => ['saved-evidence-review', 'decision-quality-review', 'research-plan', 'subtopic-research', 'report-review'].find(phase => aimPhase(context, phase)) ?? 'unmarked'))}`);
    const resultNote = await reopened.readNote(finalRef.notePath);
    assert.equal(originalReport.status, 'error'); assert.match(originalReport.detail, /Diagnostic only/);
    assert.equal(savedRun.attempts[0].status, 'failed'); assert.equal(savedRun.attempts[1].status, outcome.status === 'partial' ? 'partial' : 'completed');
    assert.equal(savedRun.attempts[1].plannerReviews[0].researchTurn, 1);
    if (outcome.status === 'completed') {
      const modelDetail = reviews.at(-1).detail.replace(/^<!-- aim-review [^\n]* -->\s*\n/, '');
      assert.equal(resultNote.detail, 'Complete conditional document with practical details and source https://example.org/reference', 'a completed conclusion preserves its model-authored detail without a fixed Markdown wrapper');
    } else {
      // The report sits under the note's supporting-research heading, so its own headings are one level deeper.
      assert.ok(resultNote.detail.includes(reportDetail.replace(/^### /gm, '#### ')), 'a partial result preserves the saved diagnostic report and its source boundary');
      assert.match(resultNote.detail, /Agent-reported only/);
    }
    assert.equal(savedMap.aim.pendingCommits.length, 0); assert.equal(savedMap.aim.resultDrafts.length, 0);
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
  assert.match(coreGap.resultNote.detail, /partial/i); assert.match(coreGap.resultNote.detail, /^> \[!warning\] Research is not finished\n(?:>.*\n)*> - Still unresolved: stovetop crust method$/m); assert.doesNotMatch(coreGap.resultNote.detail, /core outcome remains open/i, 'the reviewer rationale stays in the run records');
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
  const { AimRunStore } = load('experiences/aim/research-run-store.ts');
  const { VisualAgentMapView } = load('experiences/visual-map/view.ts', { obsidian });
  const malformed = { summary: 'Diagnostic only.', detail: 'No machine-readable Planner marker.', suggestions: [], visualReferences: [] };
  for (const kind of ['invalid-repair', 'cancel-repair']) {
    const { repo, app, mapPath, question, store } = await aimMapFixture();
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
    const plugin = { repo, settings: { ...DEFAULT_SETTINGS, language: 'en' }, mutate: async work => work(), syncOutline() {}, releaseOutline() {}, askModel: async context => {
      calls.push(context);
      if (context.researchMode === 'research') { searches++; throw new Error('Saved-report retry unexpectedly repeated research.'); }
      if (calls.length === 1) return malformed;
      assert.match(context.task, /Make one local format-repair review/);
      assert.match(context.task, /Do not search, repeat research, add evidence, or invent facts/);
      if (kind === 'cancel-repair') return new Promise((resolve, reject) => { repairStarted(); context.signal.addEventListener('abort', () => { const error = new Error('Synthetic repair cancelled.'); error.name = 'AbortError'; reject(error); }, { once: true }); });
      return malformed;
    } };
    const view = new VisualAgentMapView({ app }, plugin); view.path = mapPath; view.map = await repo.readMap(mapPath); view.render = () => {};
    const request = view.reviewAimFailedReport(first.runId, report.path, controller.signal);
    if (kind === 'cancel-repair') { await repairGate; controller.abort(); await assert.rejects(request, error => error?.name === 'AbortError'); }
    else await assert.rejects(request, /missing its machine-readable decision block/);
    const saved = await repo.readMap(mapPath), savedRun = saved.aim.runs.find(item => item.id === first.runId), savedBranch = saved.aim.branches.find(item => item.id === branch.id), current = savedRun.attempts.find(item => item.id === savedRun.currentAttemptId);
    assert.equal(calls.length, 2, 'retry permits one malformed Planner reply and exactly one repair');
    assert.equal(searches, 0, 'saved-report recovery never repeats completed research during repair failure');
    assert.equal(savedRun.attempts[0].status, 'failed');
    assert.equal(current.status, kind === 'cancel-repair' ? 'cancelled' : 'failed');
    assert.equal(savedBranch.results.length, 0);
    assert.equal(saved.aim.pendingCommits.length, 0); assert.equal(saved.aim.resultDrafts.length, 0);
    assert.equal(await repo.app.vault.read(repo.app.vault.getAbstractFileByPath(report.path)), diagnosticBefore, 'the source Searcher diagnostic remains byte-for-byte unchanged');
  }
});
integrationTest('AIM gap audit uses a strict rationale-first schema for both providers and rejects invalid results', async () => {
  const { AiTaskService } = load('core/ai-task-service.ts');
  const { buildAimPrompt } = load('ai/aim-prompt.ts');
  const auditContext = { title: 'Audit', summary: '', rules: '', detail: '', task: 'Classify the gap.', ancestors: '', mode: 'task', promptProfile: 'aim', researchMode: 'local', researchDepth: 'fast', visualMode: 'off', responseContract: 'aim-gap-audit' };
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
  const auditPrompt = buildAimPrompt({ ...auditContext, task: '<!-- aim-phase: research-gap-audit -->\nAudit the proposed gap.' }, 'en');
  assert.match(auditPrompt, /dedicated response schema/);
  assert.match(auditPrompt, /concise rationale in detail and set summary to exactly user_condition or external_evidence/);
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
integrationTest('AIM forces ask_user below the answer floor and repairs only the decision using saved reports', async () => {
  const { AimManualFlow, MIN_ANSWERED_QUESTIONS_BEFORE_CONCLUSION } = load('experiences/aim/manual-flow.ts', { obsidian });
  const { parseAimPlannerReview } = load('experiences/aim/planner-review.ts');
  const calls = [];
  const flow = new AimManualFlow({ settings: { language: 'en' } }, {}, async context => {
    calls.push(context);
    assert.equal(context.researchMode, 'local');
    if (aimPhase(context, 'decision-quality-review')) {
      return { summary: 'How much time can you spend?', detail: 'A useful conditional answer remains available.', suggestions: [{ title: 'Less than an hour', task: '', contribution: '' }], visualReferences: [] };
    }
    if (aimPhase(context, 'format-repair')) {
      assert.match(context.task, /workflow has imposed decision=ask_user/);
      assert.match(context.task, /Exact original question to preserve: How much time can you spend\?/);
      assert.doesNotMatch(context.task, /Saved report one|Saved report two|Saved report three|Saved report four/);
      return plannerReview('ask_user', { rationale: 'Repaired rationale must be replaced.', question: 'A changed question?' }, 'Changed summary.', 'Changed body.', ['Less than an hour', 'One to two hours', 'More than two hours']);
    }
    throw new Error(`Unexpected research or Planner retry: ${context.task.slice(0, 120)}`);
  });
  const context = {
    goal: 'Plan a realistic routine', goalDetail: '', outputLanguage: 'en', conditions: {}, currentQuestion: 'Do you exercise?', currentAnswer: 'Sometimes',
    answeredQuestionCount: 2, questionHistory: ['Do you exercise?'], lineage: '',
    reportSummary: 'Four independent Searcher reports are already saved.',
    reportDetail: ['Saved report one', 'Saved report two', 'Saved report three', 'Saved report four'].map((name, index) => `### ${name}\nIndependent persisted finding ${index + 1}.`).join('\n\n')
  };
  const candidate = parseAimPlannerReview(plannerReview('conclude', { rationale: 'The research appears sufficient.', stopReason: 'No research gap.' }, 'Candidate conclusion.', 'Candidate answer.'));
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
    parseAimPlannerReview(plannerReview('ask_user', { rationale: 'A genuinely missing condition remains.', question: 'What schedule works best?' }, 'Conditional answer.', 'Useful detail.', ['Morning', 'Evening'])),
    { ...context, answeredQuestionCount: 4 }, 'gpt-6-luna', 'low'
  );
  assert.equal(aboveFloor.decision, 'ask_user');
  assert.equal(calls.length, 0, 'the floor does not force another correction once the branch has enough answers');
});
integrationTest('AIM turns below-floor research on an already answered goal into a user question', async () => {
  const { AimManualFlow } = load('experiences/aim/manual-flow.ts', { obsidian });
  const { parseAimPlannerReview } = load('experiences/aim/planner-review.ts');
  const phases = [];
  const flow = new AimManualFlow({ settings: { language: 'en' } }, {}, async context => {
    phases.push(context.task.match(/aim-phase: ([a-z-]+)/)?.[1]);
    if (aimPhase(context, 'decision-quality-review')) {
      assert.deepEqual(JSON.parse(JSON.stringify(context.aimContract)), { kind: 'review', decisions: ['ask_user'] });
      assert.match(context.task, /proposes more research although its reports already answer the goal/);
      return plannerReview('ask_user', { rationale: 'Shell choice changes the commands.', question: 'Which shell will you use?' }, 'Which shell will you use?', 'Commands differ per shell.', ['bash', 'PowerShell']);
    }
    if (aimPhase(context, 'research-gap-audit')) return { summary: 'external_evidence', detail: 'A public source can settle this.', suggestions: [], visualReferences: [] };
    throw new Error(`Unexpected phase: ${context.task.slice(0, 80)}`);
  });
  const context = { goal: 'Create a venv', goalDetail: '', conditions: {}, currentQuestion: 'Which OS?', currentAnswer: 'Unknown', answeredQuestionCount: 1, questionHistory: ['Which OS?'], lineage: '', reportSummary: 'Official docs cover every step.', reportDetail: 'Saved reports.' };
  const research = (goalAnswered) => {
    const candidate = plannerReview('research_more', { rationale: 'Double-check version notes.' }, 'Interim answer.', 'Body.', [{ title: 'Version notes', task: 'Check docs', contribution: 'Precision' }]);
    candidate.detail = candidate.detail.replace('"decision":"research_more"', `"decision":"research_more","goalAnswered":${goalAnswered}`);
    return parseAimPlannerReview(candidate);
  };
  const asked = await flow.reviewPlannerDecisionQuality(research(true), context, 'gpt-6-luna', 'low');
  assert.equal(asked.decision, 'ask_user');
  assert.equal(asked.question, 'Which shell will you use?');
  assert.deepEqual(phases, ['decision-quality-review'], 'no further research or gap audit ran');
  phases.length = 0;
  const kept = await flow.reviewPlannerDecisionQuality(research(false), context, 'gpt-6-luna', 'low');
  assert.equal(kept.decision, 'research_more', 'a genuine evidence gap is still researched below the floor');
  assert.deepEqual(phases, ['research-gap-audit']);
});
integrationTest('AIM at the answer floor turns research on an already answered goal into a conclusion or question without searching', async () => {
  const { AimManualFlow, MIN_ANSWERED_QUESTIONS_BEFORE_CONCLUSION } = load('experiences/aim/manual-flow.ts', { obsidian });
  const { parseAimPlannerReview } = load('experiences/aim/planner-review.ts');
  const phases = []; let corrected = 'conclude';
  const flow = new AimManualFlow({ settings: { language: 'en' } }, {}, async context => {
    phases.push(context.task.match(/aim-phase: ([a-z-]+)/)?.[1]);
    if (aimPhase(context, 'decision-quality-review')) {
      assert.deepEqual(JSON.parse(JSON.stringify(context.aimContract)).decisions.slice().sort(), ['ask_user', 'conclude']);
      assert.match(context.task, /marks the goal as already answered/);
      assert.match(context.task, /Saved reports\./);
      return corrected === 'conclude'
        ? plannerReview('conclude', { rationale: 'Official docs answer every step.', stopReason: 'No evidence gap remains.' }, 'Answer.', 'Body.')
        : plannerReview('ask_user', { rationale: 'Usage changes the recommendation.', question: 'Which project type is this for?' }, 'Answer.', 'Body.', ['Web app', 'Script']);
    }
    const delivered = deliveryFixture(context); if (delivered) return delivered;
    throw new Error(`Unexpected phase: ${context.task.slice(0, 80)}`);
  });
  const context = { goal: 'Create a venv', goalDetail: '', conditions: {}, currentQuestion: 'Which shell?', currentAnswer: 'Unknown', answeredQuestionCount: MIN_ANSWERED_QUESTIONS_BEFORE_CONCLUSION, questionHistory: ['Which OS?', 'Which shell?'], lineage: '', reportSummary: 'Official docs cover every step.', reportDetail: 'Saved reports.' };
  const research = goalAnswered => {
    const candidate = plannerReview('research_more', { rationale: 'Double-check version notes.' }, 'Interim answer.', 'Body.', [{ title: 'Version notes', task: 'Check docs', contribution: 'Precision' }]);
    candidate.detail = candidate.detail.replace('"decision":"research_more"', `"decision":"research_more","goalAnswered":${goalAnswered}`);
    return parseAimPlannerReview(candidate);
  };
  const concluded = await flow.reviewPlannerDecisionQuality(research(true), context, 'gpt-6-luna', 'low');
  assert.equal(concluded.decision, 'conclude');
  assert.equal(phases[0], 'decision-quality-review');
  assert.equal(phases.includes('research-gap-audit'), false, 'no gap audit or search for an answered goal');
  phases.length = 0; corrected = 'ask_user';
  const asked = await flow.reviewPlannerDecisionQuality(research(true), context, 'gpt-6-luna', 'low');
  assert.equal(asked.decision, 'ask_user');
  assert.equal(asked.question, 'Which project type is this for?');
  assert.deepEqual(phases, ['decision-quality-review']);
});
integrationTest('AIM re-decides a target-less research_more on an answered goal with research_more removed from the repair schema', async () => {
  const { AimManualFlow } = load('experiences/aim/manual-flow.ts', { obsidian });
  const contracts = [];
  const flow = new AimManualFlow({ settings: { language: 'en' } }, {}, async context => {
    if (!aimPhase(context, 'format-repair')) throw new Error(`Unexpected phase: ${context.task.slice(0, 80)}`);
    contracts.push(JSON.parse(JSON.stringify(context.aimContract)));
    return plannerReview('ask_user', { rationale: 'Usage context changes the commands.', question: 'Which shell will you use?' }, 'Interim answer.', 'Body.', ['bash', 'PowerShell']);
  });
  const original = plannerReview('research_more', { rationale: 'Every core outcome is answered; no evidence gap remains.' }, 'Interim answer.', 'Body.');
  original.detail = original.detail.replace('"decision":"research_more"', '"decision":"research_more","goalAnswered":true');
  const recoveryContext = { question: 'Create a venv', answerSnapshot: '{}', reportSummary: 'Official docs cover every step.', reportDetail: 'Saved reports.' };
  const taskContext = { title: 'Create a venv', summary: '', detail: '', ancestors: '', aimContract: { kind: 'review', decisions: ['research_more', 'ask_user'] } };
  const review = await flow.parsePlannerReviewWithRecovery(original, recoveryContext, taskContext, 'gpt-6-luna', 'low');
  assert.equal(review.decision, 'ask_user');
  assert.deepEqual(contracts, [{ kind: 'review', decisions: ['ask_user'] }], 'one repair call whose schema cannot offer research_more');
});
integrationTest('AIM research-gap audit preserves classifications from four saved report summaries without reopening evidence', async () => {
  const { repo } = fixture();
  const { createAimMap } = load('experiences/aim/create-map.ts');
  const created = await createAimMap(repo, 'gpt-6-luna', { requestId: 'gap-audit-map', topic: 'Roast this specific chicken for dinner', context: 'We know the flavor direction and evening meal, but the exact chicken weight and serving time are not supplied.' });
  const { AimRunStore } = load('experiences/aim/research-run-store.ts');
  const { AimManualFlow } = load('experiences/aim/manual-flow.ts');
  const store = new AimRunStore(repo); let searches = 0, audits = 0, corrections = 0;
  const flow = new AimManualFlow(repo, store, async context => {
    if (aimPhase(context, 'initial-question')) return { summary: 'Which flavor direction do you prefer?', detail: 'Synthetic user-condition question.', suggestions: [{ title: 'Herbs' }, { title: 'Citrus' }], visualReferences: [] };
    if (aimPhase(context, 'research-plan')) return { summary: 'Two synthetic evidence targets.', detail: '<!-- aim-plan {"subtopics":[{"id":"temperature","title":"Safe temperature","task":"Find official poultry temperature guidance.","expectedValue":"Keep the result safe."},{"id":"roast","title":"Roasting method","task":"Find a reliable roasting method.","expectedValue":"Support a practical method."}]} -->', suggestions: [], visualReferences: [] };
    if (aimPhase(context, 'subtopic-research')) { searches++; return { summary: `Synthetic saved evidence ${searches}.`, detail: `Research status: search completed\nSynthetic source-backed report ${searches}.`, suggestions: [], visualReferences: [] }; }
    if (aimPhase(context, 'report-review')) return plannerReview('research_more', { rationale: 'The specific bird weight and exact serving time were not provided; web search cannot establish either user-specific value.' }, 'Conditional roasting guidance is ready.', 'Preserve the temperature and method findings while obtaining the missing scenario values.', [{ title: 'Look up the bird weight and exact serving time', task: 'Search web recipes to infer the actual weight of this specific chicken and its exact dinner serving time.', contribution: 'These values would personalize the result.' }]);
    if (aimPhase(context, 'research-gap-audit')) {
      audits++; assert.equal(context.researchMode, 'local');
      assert.match(context.task, /Known conditions on this branch only/);
      assert.match(context.task, /specific bird weight and exact serving time/);
      assert.doesNotMatch(context.task, /Sibling answer|unrelated branch condition/);
      return researchGapAudit('user_condition', '實際雞重與上桌時間屬於這個分支的使用者情境，不能由網路來源查明。');
    }
    if (aimPhase(context, 'decision-quality-review')) {
      corrections++; assert.equal(context.researchMode, 'local');
      assert.match(context.task, /Decision=ask_user is mandatory/);
      assert.doesNotMatch(context.task, /Research status: search completed\nSynthetic source-backed report/);
      return { summary: 'How much does this chicken weigh, and when must it be served?', detail: 'A conditional roasting answer remains supported by the saved temperature and method reports.', suggestions: [{ title: 'I can provide the weight and time' }, { title: 'I need help estimating them' }], visualReferences: [] };
    }
    throw new Error(`Unexpected AIM phase: ${context.task.slice(0, 100)}`);
  });
  const question = (await flow.planNextQuestion(created.mapPath, created.root.id, 'gpt-6-luna', 'low', 'gap-audit-initial-question')).node;
  const result = await flow.answerAndResearch(created.mapPath, question.id, { requestId: 'gap-audit-answer', selections: [question.aimQuestion.options[0].id], freeText: 'Rosemary flavor; dinner in the evening.' }, 'gpt-6-luna', 'low');
  assert.equal(result.status, 'waiting-user');
  assert.equal(searches, 2, 'the classifier prevents the third Searcher pass for user-specific values');
  assert.equal(audits, 1); assert.equal(corrections, 1);
  const saved = await repo.readMap(created.mapPath), branch = saved.aim.branches.find(item => item.id === result.branchId);
  const newQuestion = saved.nodes.find(item => item.id === result.questionNodeId);
  assert.equal(branch.results.filter(item => item.kind === 'research').length, 2, 'both original reports are preserved');
  assert.equal(newQuestion.aimKind, 'question');
  assert.equal((await repo.readNote(newQuestion.path)).summary, 'How much does this chicken weigh, and when must it be served?');
  assert.deepEqual(plain(newQuestion.aimQuestion.options.slice(0, 2).map(item => item.label)), ['I can provide the weight and time', 'I need help estimating them']);

  const { parseAimPlannerReview } = load('experiences/aim/planner-review.ts');
  const genuineCandidate = parseAimPlannerReview(plannerReview('research_more', { rationale: 'A source-backed poultry temperature standard remains unresolved.' }, 'A useful conditional result.', 'One external standard remains unverified.', [{ title: 'Official safe temperature', task: 'Find the authoritative poultry safe-temperature standard.', contribution: 'An official source may resolve the factual gap.' }]));
  let externalAuditCalls = 0;
  const externalFlow = new AimManualFlow(repo, store, async context => {
    externalAuditCalls++;
    assert.equal(context.researchMode, 'local');
    assert.match(context.task, /Official safe temperature/);
    for (const savedSummary of ['Saved report 1: synthetic temperature guidance.', 'Saved report 2: synthetic roasting method.', 'Saved report 3: synthetic seasoning ratios.', 'Saved report 4: synthetic resting time.']) assert.ok(context.task.includes(savedSummary));
    return researchGapAudit('external_evidence', 'Saved branch reports do not establish the herb-to-butter ratio; a targeted source search can verify that external recipe fact.');
  });
  const externalContext = {
    goal: 'Roast poultry safely', goalDetail: '', conditions: { flavor: 'Rosemary' }, currentQuestion: 'How should it be cooked?', currentAnswer: 'Roast it.',
    answeredQuestionCount: 3, questionHistory: [], lineage: '', reportSummary: ['Saved report 1: synthetic temperature guidance.', 'Saved report 2: synthetic roasting method.', 'Saved report 3: synthetic seasoning ratios.', 'Saved report 4: synthetic resting time.'].join('\n'), reportDetail: 'Full saved reports.'
  };
  const retained = await externalFlow.reviewPlannerDecisionQuality(genuineCandidate, externalContext, 'gpt-6-luna', 'low');
  assert.equal(retained.decision, 'research_more', 'genuine external evidence gaps remain searchable');
  assert.equal(externalAuditCalls, 1, 'the schema-enforced class needs no extraction or format-only call');

  // A rationale may discuss both classes or contain a question; the schema enum alone is the decision.
  const discussedFlow = new AimManualFlow(repo, store, async () => researchGapAudit('external_evidence', 'Is this user_condition? No: the herb ratio is a published recipe fact, so it is external_evidence.'));
  assert.equal((await discussedFlow.reviewPlannerDecisionQuality(genuineCandidate, externalContext, 'gpt-6-luna', 'low')).decision, 'research_more');

  const noRationaleFlow = new AimManualFlow(repo, store, async () => researchGapAudit('external_evidence', ''));
  await assert.rejects(noRationaleFlow.reviewPlannerDecisionQuality(genuineCandidate, externalContext, 'gpt-6-luna', 'low'), /empty research-gap rationale/);

  let invalidCalls = 0;
  const invalidFlow = new AimManualFlow(repo, store, async () => { invalidCalls++; return { summary: 'The actual chicken weight is a private scenario value.', detail: 'No public source can establish this value.', suggestions: [], visualReferences: [] }; });
  await assert.rejects(invalidFlow.reviewPlannerDecisionQuality(genuineCandidate, externalContext, 'gpt-6-luna', 'low'), /invalid research-gap classification/);
  assert.equal(invalidCalls, 1, 'an unschematized class fails closed without another model call or Searcher');

  const duplicateFlow = new AimManualFlow(repo, store, async context => aimPhase(context, 'research-gap-audit')
    ? researchGapAudit('user_condition', 'A user-specific condition remains unknown.')
    : { summary: 'Which flavor direction do you prefer?', detail: 'Conditional answer.', suggestions: [{ title: 'Herbs' }, { title: 'Citrus' }], visualReferences: [] });
  await assert.rejects(duplicateFlow.reviewPlannerDecisionQuality(genuineCandidate, {
    goal: 'Roast poultry safely', goalDetail: '', conditions: {}, currentQuestion: 'Which flavor direction do you prefer?', currentAnswer: 'Herbs.',
    answeredQuestionCount: 3, questionHistory: ['Which flavor direction do you prefer?'], lineage: '', reportSummary: '', reportDetail: ''
  }, 'gpt-6-luna', 'low'), /without repeating a prior question/);
});
integrationTest('AIM retries failed decision formatting from four saved reports and commits the next question', async () => {
  const { repo } = fixture();
  const { createAimMap } = load('experiences/aim/create-map.ts');
  const created = await createAimMap(repo, 'gpt-6-luna', { requestId: 'forced-ask-map', topic: 'Plan a realistic routine', context: 'Synthetic test scenario.' });
  const { AimRunStore } = load('experiences/aim/research-run-store.ts');
  const { AimManualFlow } = load('experiences/aim/manual-flow.ts', { obsidian });
  let saved = await repo.readMap(created.mapPath);
  const earlier = await repo.createNote('Earlier answered condition', 'gpt-6-luna', saved, created.mapPath, 'workspace');
  earlier.aimKind = 'question';
  earlier.aimQuestion = { requestId: 'earlier-question', parentBranchId: null, options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }], allowMultiple: false, allowFreeText: true };
  const question = await repo.createNote('Current question', 'gpt-6-luna', saved, created.mapPath, 'workspace');
  question.aimKind = 'question';
  question.aimQuestion = { requestId: 'current-question', parentBranchId: 'earlier-answer', options: [{ id: 'some', label: 'Sometimes' }, { id: 'rare', label: 'Rarely' }], allowMultiple: false, allowFreeText: true };
  await repo.updateNote(question.path, { summary: 'Do you exercise regularly?' });
  saved.nodes.push(earlier, question);
  saved.aim.branches.push({ id: 'earlier-answer', questionNodeId: earlier.id, parentBranchId: null, answerSnapshot: { selections: ['yes'], freeText: 'Synthetic prior condition.' }, inputSnapshot: { topic: saved.title, conditions: { 'Do you exercise?': 'Yes' }, upstreamResults: [] }, createdAt: '2026-10-09T00:00:00.000Z', results: [] });
  await repo.saveMap(created.mapPath, saved);

  const plan = Array.from({ length: 4 }, (_, index) => ({ id: `target-${index + 1}`, title: `Research dimension ${index + 1}`, task: `Search distinct dimension ${index + 1}.`, expectedValue: `Resolve uncertainty ${index + 1}.` }));
  const exactQuestion = 'How much time can you spend each day?';
  const calls = []; let researchCalls = 0, repairCalls = 0;
  const flow = new AimManualFlow(repo, new AimRunStore(repo), async context => {
    calls.push(context);
    if (aimPhase(context, 'research-plan')) return { summary: 'Four complementary research dimensions.', detail: `<!-- aim-plan ${JSON.stringify({ subtopics: plan })} -->`, suggestions: [], visualReferences: [] };
    if (aimPhase(context, 'subtopic-research')) {
      researchCalls++;
      const target = plan.find(item => context.task.includes(item.title));
      return { summary: `${target.title} finding.`, detail: `Research status: search completed\nIndependent persisted finding for ${target.title}.`, suggestions: [], visualReferences: [] };
    }
    if (aimPhase(context, 'report-review')) return plannerReview('conclude', { rationale: 'The four reports appear sufficient.', stopReason: 'Research review ended.' }, 'Candidate conclusion.', 'Candidate conditional answer.');
    if (aimPhase(context, 'decision-quality-review')) return { summary: 'Could this plan be more ambitious?', detail: `Question: ${exactQuestion}\n\nThe useful conditional answer remains intact.`, suggestions: [{ title: 'Under 30 minutes', task: '', contribution: '' }], visualReferences: [] };
    if (aimPhase(context, 'format-repair')) {
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
  const branch = saved.aim.branches.find(item => item.submissionId === input.requestId);
  assert.ok(branch);
  assert.deepEqual(Array.from(branch.results.filter(item => item.kind === 'research'), item => item.subtopicId), plan.map(item => item.id));
  assert.ok(saved.aim.runs.filter(item => item.branchId === branch.id).flatMap(item => item.attempts).some(attempt => attempt.status === 'failed'), 'the failed decision attempt remains recorded');
  assert.equal(researchCalls, 4);

  const outcome = await flow.answerAndResearch(created.mapPath, question.id, input, 'gpt-6-luna', 'low');
  assert.equal(outcome.status, 'waiting-user');
  assert.equal(researchCalls, 4, 'retry reused all four saved reports and ran no Searcher calls');
  assert.equal(repairCalls, 2);
  saved = await repo.readMap(created.mapPath);
  const nextQuestion = saved.nodes.find(item => item.id === outcome.questionNodeId);
  assert.equal(nextQuestion.aimKind, 'question');
  assert.equal(await repo.readNote(nextQuestion.path).then(note => note.summary), exactQuestion);
  assert.equal(nextQuestion.aimQuestion.parentBranchId, branch.id);
  assert.equal(saved.aim.branches.find(item => item.id === branch.id).results.filter(item => item.kind === 'research').length, 4);
  const reviewCalls = calls.filter(context => aimPhase(context, 'report-review'));
  assert.equal(reviewCalls.length, 2);
  assert.ok(reviewCalls.every(context => plan.every(item => context.detail.includes(item.title))), 'both decision attempts reused the four independently saved reports');
});
integrationTest('AIM request deduplication preserves unique evidence and leaves original context intact', () => {
  const { deduplicateAimRequest } = load('experiences/aim/request-context.ts');
  const report = 'Complete report evidence '.repeat(100);
  const unique = 'Distinct evidence '.repeat(100);
  const context = { task: report, detail: report + '\n\n' + unique, ancestors: 'Ancestor header\n' + report, title: 'Original topic' };
  const prepared = deduplicateAimRequest(context);
  assert.equal(prepared.task, report);
  assert.ok(prepared.detail.includes(unique));
  assert.ok(!prepared.detail.includes(report));
  assert.ok(!prepared.ancestors.includes(report));
  assert.equal(context.detail, report + '\n\n' + unique);
  assert.equal(context.ancestors, 'Ancestor header\n' + report);
});
test('AIM repair hint does not treat Searcher readback errors as search failures', () => {
  const { aimRepairHint } = load('experiences/aim/failure-hint.ts');
  assert.equal(aimRepairHint('The Searcher report did not match the Repository readback before Planner review.'), 'ui.aim_repair_retry_hint');
  assert.equal(aimRepairHint('The Agent explicitly says no web search succeeded; the report remains an unpublished diagnostic.'), 'ui.aim_repair_search_hint');
  assert.equal(aimRepairHint('The targeted follow-up did not produce a usable searched report; the attempt remains incomplete.'), 'ui.aim_repair_search_hint');
  assert.equal(aimRepairHint('The provider did not perform web search. No researched result is available; check model/tool availability.'), 'ui.aim_repair_search_hint');
  assert.equal(aimRepairHint('AI 服務沒有實際執行網路搜尋，無法提供已查證結果；請確認模型與工具可用性。'), 'ui.aim_repair_search_hint');
  assert.equal(aimRepairHint('getaddrinfo ENOTFOUND api.anthropic.com'), 'ui.aim_repair_search_hint');
  assert.equal(aimRepairHint('The AI task exceeded 3 minutes; VAM attempts to interrupt it.'), 'ui.aim_repair_timeout_hint');
  assert.equal(aimRepairHint('Not logged in · Please run /login'), 'ui.aim_repair_auth_hint');
  assert.equal(aimRepairHint('Planner returned invalid JSON for the research plan.'), 'ui.aim_repair_format_hint');
  assert.equal(aimRepairHint(''), 'ui.aim_repair_retry_hint');
});
