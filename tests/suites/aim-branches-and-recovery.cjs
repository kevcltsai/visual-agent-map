const assert = require('node:assert/strict');
const { integrationTest, load, node, map, plain, plannerReview, deliveryFixture, savedEvidenceNeedsSearch, researchGapAudit, aimPhase, obsidian, Repository, DEFAULT_SETTINGS, fixture, aimMapFixture, coverageModel } = require('../support.cjs');
integrationTest('a stale map copy saving its viewport keeps research state written meanwhile, and separate stores serialize', async () => {
  const subject = await aimMapFixture();
  let doc = await subject.repo.readMap(subject.mapPath);
  const secondQuestion = await subject.repo.createNote('第二個問題', 'gpt-6-luna', doc, subject.mapPath, 'workspace'); doc.nodes.push(secondQuestion); await subject.repo.saveMap(subject.mapPath, doc);
  const stale = await subject.repo.readMap(subject.mapPath);
  const input = requestId => ({ requestId, questionNodeId: requestId === 'first' ? subject.question.id : secondQuestion.id, parentBranchId: null, answerSnapshot: { selections: [], freeText: requestId }, inputSnapshot: { topic: 'T', conditions: {}, upstreamResults: [] } });
  // Two views own two store instances (from the same bundle) on one repository; their writes must not lose each other.
  const other = new subject.store.constructor(subject.repo);
  await Promise.all([subject.store.createAnswerBranch(subject.mapPath, input('first')), other.createAnswerBranch(subject.mapPath, input('second'))]);
  assert.equal((await subject.repo.readMap(subject.mapPath)).aim.branches.length, 2, 'concurrent writes from separate stores are both kept');
  // A view still holding the pre-research copy pans the map: only the viewport may change.
  stale.viewport = { x: 120, y: -40, zoom: 1.5 };
  await subject.repo.updateMap(subject.mapPath, map => { map.viewport = { ...stale.viewport }; });
  const saved = await subject.repo.readMap(subject.mapPath);
  assert.deepEqual(JSON.parse(JSON.stringify(saved.viewport)), { x: 120, y: -40, zoom: 1.5 });
  assert.equal(saved.aim.branches.length, 2, 'the viewport write did not overwrite research state with the stale copy');
});
integrationTest('fully specified startup still enforces the minimum answer floor without creating a conclusion', async () => {
  const { repo } = fixture();
  const { createAimMap } = load('experiences/aim/create-map.ts');
  const created = await createAimMap(repo, 'gpt-6-luna', { requestId: 'specified-start-map', topic: 'Build a three-color palette', context: 'Use the supplied blue, amber, and cream colors; preserve contrast and keep the result calm.' });
  const { AimRunStore } = load('experiences/aim/research-run-store.ts');
  const { AimManualFlow, AIM_NO_QUESTION } = load('experiences/aim/manual-flow.ts');
  const phases = [], models = [];
  const flow = new AimManualFlow(repo, new AimRunStore(repo), async (context, model, reasoning) => {
    const phase = ['initial-question', 'saved-evidence-review', 'decision-quality-review', 'research-plan', 'subtopic-research', 'report-review'].find(item => aimPhase(context, item));
    phases.push(phase ?? 'unmarked'); models.push([model, reasoning, context.researchMode]);
    if (phase === 'initial-question') return phases.filter(item => item === 'initial-question').length === 1
      ? { summary: AIM_NO_QUESTION, detail: 'The requested outcome and constraints are already supplied.', suggestions: [], visualReferences: [] }
      : { summary: 'Which contrast target should the palette prioritize?', detail: 'Choose the main accessibility constraint.', suggestions: [{ title: 'Standard text contrast', task: '', contribution: '', parentTitle: '' }, { title: 'Large display text', task: '', contribution: '', parentTitle: '' }], visualReferences: [] };
    throw new Error(`A fully specified startup unexpectedly requested ${phase ?? context.task.slice(0, 90)}.`);
  });
  const outcome = await flow.planNextQuestion(created.mapPath, created.root.id, 'gpt-6-luna', 'low', 'specified-start-question');
  assert.equal(outcome.status, 'question', 'the configured floor keeps an apparently complete topic open for user input');
  const saved = await repo.readMap(created.mapPath);
  assert.equal(saved.aim.branches.length, 0, 'the topic is not concluded without an answered question path');
  assert.equal(saved.nodes.some(node => node.aimKind === 'question'), true);
  assert.deepEqual(phases, ['initial-question', 'initial-question']);
  assert.deepEqual(models, Array(2).fill(['gpt-6-luna', 'low', 'local']));
});
integrationTest('a new answer researches its own target before reviewing inherited evidence', async () => {
  const { repo } = fixture();
  const { createAimMap } = load('experiences/aim/create-map.ts');
  const created = await createAimMap(repo, 'gpt-6-luna', { requestId: 'evidence-first-map', topic: 'Prepare a cast-iron steak', context: 'Synthetic scenario: 1.5-inch steak, cast-iron pan, thermometer, no oven.' });
  const { AimRunStore } = load('experiences/aim/research-run-store.ts');
  const { AimManualFlow } = load('experiences/aim/manual-flow.ts');
  const store = new AimRunStore(repo);
  let mapDoc = await repo.readMap(created.mapPath);
  const firstQuestion = await repo.createNote('Synthetic preparation question', 'gpt-6-luna', mapDoc, created.mapPath, 'workspace');
  firstQuestion.aimKind = 'question';
  firstQuestion.aimQuestion = { requestId: 'evidence-first-parent-question', parentBranchId: null, options: [{ id: 'pan', label: 'Cast iron' }, { id: 'other', label: 'Another pan' }], allowMultiple: false, allowFreeText: true };
  mapDoc.nodes.push(firstQuestion); await repo.saveMap(created.mapPath, mapDoc);
  const parent = await store.createAnswerBranch(created.mapPath, { requestId: 'evidence-first-parent-answer', questionNodeId: firstQuestion.id, parentBranchId: null, answerSnapshot: { selections: ['pan'], freeText: 'Use a thermometer; no oven.' }, inputSnapshot: { topic: mapDoc.title, conditions: { scenario: 'synthetic 1.5-inch steak' }, upstreamResults: [] } });
  const parentAttempt = await store.startAttempt(created.mapPath, parent.id, 'evidence-first-parent-run');
  await store.recordResearchTurn(created.mapPath, parentAttempt);
  await store.recordPlannerReview(created.mapPath, parentAttempt, { decision: 'ask_user', rationale: 'A finishing preference still changes the final serving advice.', researchTurn: 1, question: 'Which finish should be prioritized?', answerOptions: ['Simple pan finish', 'Resting and serving'] });
  const parentDraft = (await store.createResultDraft(created.mapPath, parentAttempt, 'Saved preparation report', 'gpt-6-luna', undefined, { kind: 'research' })).draft;
  await store.updateResultDraftReport(created.mapPath, parentAttempt, parentDraft.id, 'Synthetic saved report: safe-temperature and cast-iron method coverage.', 'Research status: search completed\nSynthetic report gives a conditional method, thermometer use, and its limits.');
  await store.commitResult(created.mapPath, parentAttempt, parentDraft.id, { summary: 'Synthetic saved report.', detail: 'Research status: search completed\nSynthetic conditional method and limitations.' });
  store.releaseAttempt(created.mapPath, parentAttempt);
  const recoveryFlow = new AimManualFlow(repo, store, async () => { throw new Error('Post-report question recovery must not invoke a Planner.'); });
  assert.equal(await recoveryFlow.recoverPostReportQuestions(created.mapPath), 1);
  mapDoc = await repo.readMap(created.mapPath);
  const followup = mapDoc.nodes.find(node => node.aimQuestion?.parentBranchId === parent.id);
  assert.ok(followup);

  const phases = []; let webCalls = 0;
  const flow = new AimManualFlow(repo, store, async context => {
  const phase = ['research-plan', 'saved-evidence-review', 'subtopic-research', 'report-review'].find(item => aimPhase(context, item));
    phases.push(phase ?? 'unmarked');
    if (phase === 'research-plan') return { summary: 'Two complementary targets', detail: '<!-- aim-plan {"subtopics":[{"id":"safety","title":"Safety limits","task":"Check safety limits for the answer","expectedValue":"Retain supported constraints"},{"id":"finish","title":"Finishing method","task":"Compare finishing techniques","expectedValue":"Resolve serving differences"}]} -->', suggestions: [], visualReferences: [] };
    if (context.researchMode === 'research') { webCalls++; return { summary: 'Synthetic answer-specific report.', detail: 'Research status: search completed\nA targeted report checked the current answer against the inherited method.', suggestions: [], visualReferences: [] }; }
    if (phase === 'report-review') {
      assert.match([context.task, context.detail, context.ancestors].join("\n"), /Synthetic saved report/);
      return plannerReview('ask_user', { rationale: 'The inherited and new reports support a conditional answer, but the finishing preference still changes serving advice.', question: 'Which finish should be prioritized?' }, 'Keep the supplied safety limit and compare the saved method with this answer-specific evidence.', 'The reports do not establish the user’s preferred finish.', ['Simple pan finish', 'Resting and serving']);
    }
    if (context.task.includes('Correct the candidate decision before it can be saved')) return plannerReview('ask_user', { rationale: 'Preparation time could materially change the practical recommendation and is not covered by the prior question.', question: 'How much preparation time is available?' }, 'Keep the supplied safety limit and compare the saved method with this answer-specific evidence.', 'The reports do not establish the available preparation time.', ['Under 30 minutes', 'At least 30 minutes']);
    throw new Error(`Unexpected phase ${phase ?? context.task.slice(0, 90)}.`);
  });
  const result = await flow.answerAndResearch(created.mapPath, followup.id, { requestId: 'evidence-first-child-answer', selections: [followup.aimQuestion.options[0].id], freeText: 'Keep the supplied safety limitation.' }, 'gpt-6-luna', 'low');
  assert.equal(result.status, 'waiting-user'); assert.equal(webCalls, 2);
  assert.deepEqual(phases, ['research-plan', 'subtopic-research', 'subtopic-research', 'report-review', 'unmarked'], 'one bounded quality correction replaces the unsupported early conclusion');
  const saved = await repo.readMap(created.mapPath), child = saved.aim.branches.find(item => item.id === result.branchId);
  assert.equal(child.parentBranchId, parent.id);
  assert.ok(child.inputSnapshot.upstreamResults.some(ref => ref.notePath === parentDraft.notePath));
  assert.equal(child.results.filter(item => item.kind === 'research').length, 2);
});
integrationTest('AIM retry clears a stale plan error when saved evidence concludes by replanning research', async () => {
  const { repo } = fixture(); const { createAimMap } = load('experiences/aim/create-map.ts');
  const created = await createAimMap(repo, 'gpt-6-luna', { requestId: 'plan-error-retry-map', topic: 'Choose a safe walking route', context: 'The user wants a short, step-free route.' });
  const { AimRunStore } = load('experiences/aim/research-run-store.ts');
  const { AimManualFlow } = load('experiences/aim/manual-flow.ts');
  const store = new AimRunStore(repo); let map = await repo.readMap(created.mapPath);
  const question = await repo.createNote('Route question', 'gpt-6-luna', map, created.mapPath, 'workspace');
  question.aimKind = 'question';
  question.aimQuestion = { requestId: 'plan-error-retry-question', parentBranchId: null, options: [{ id: 'short', label: 'Shortest route' }, { id: 'scenic', label: 'Scenic route' }], allowMultiple: false, allowFreeText: true };
  map.nodes.push(question); await repo.saveMap(created.mapPath, map);
  const branch = await store.createAnswerBranch(created.mapPath, { requestId: 'plan-error-retry-answer', questionNodeId: question.id, parentBranchId: null, answerSnapshot: { selections: ['short'], freeText: '' }, inputSnapshot: { topic: map.title, conditions: { preference: 'short route' }, upstreamResults: [] } });
  await store.saveResearchPlanError(created.mapPath, branch.id, new Error('A previous Planner response did not include a valid plan.'));
  const phases = [];
  const currentModel = coverageModel();
  const flow = new AimManualFlow(repo, store, async context => { phases.push(context.task.match(/aim-phase:\s*([a-z-]+)/)?.[1]); return currentModel.ask(context); });
  const result = await flow.retryAnswerResearch(created.mapPath, branch.id, 'gpt-6-luna', 'low');
  assert.equal(result.status, 'waiting-user');
  assert.equal(phases.includes('research-plan'), true); assert.equal(phases.filter(p => p === 'subtopic-research').length, 2); assert.equal(phases.includes('saved-evidence-review'), false);
  map = await repo.readMap(created.mapPath);
  const savedBranch = map.aim.branches.find(item => item.id === branch.id);
  assert.equal(savedBranch.researchPlanError, undefined, 'a successful saved-evidence outcome clears the obsolete plan error');
  assert.equal(savedBranch.results.filter(item => item.kind === 'research').length, 2);
  const element = tag => ({ tag, children: [], dataset: {}, style: {}, createDiv(options) { const child = element('div'); child.cls = options?.cls ?? options; this.children.push(child); return child; }, createEl(name, options) { const child = element(name); child.text = options?.text; child.cls = options?.cls ?? ''; this.children.push(child); return child; }, createSpan(options) { const child = element('span'); child.text = options?.text; child.cls = options?.cls ?? ''; this.children.push(child); return child; }, setAttr(name, value) { this[name] = value; }, addClass(name) { this.cls = name; }, addEventListener() {}, removeEventListener() {}, setPointerCapture() {} });
  const { VisualAgentMapView } = load('experiences/visual-map/view.ts', { obsidian });
  const view = new VisualAgentMapView({ app: {} }, { repo, settings: { ...DEFAULT_SETTINGS }, expansionBatches: new Map(), running: new Map(), quickExpandPending: new Set(), pendingSuggestions: new Map() });
  view.stageEl = element('stage'); view.map = map; view.notes = new Map([[question.id, { title: 'Route question', summary: 'Route question', status: 'idea' }]]); view.renderNode(question);
  const findStatusBadge = item => String(item.cls ?? '').includes('vam-aim-question-status') ? item : item.children?.map(findStatusBadge).find(Boolean);
  const statusBadge = findStatusBadge(view.stageEl);
  assert.ok(statusBadge, 'the question card shows its AIM result status');
  assert.match(statusBadge.cls, /completed/);
});
integrationTest('partial continuation asks about missing user conditions before starting another search', async () => {
  const { AimRunStore } = load('experiences/aim/research-run-store.ts');
  const { AimManualFlow } = load('experiences/aim/manual-flow.ts');
  const { createAimMap } = load('experiences/aim/create-map.ts');
  const { repo } = fixture();
  const created = await createAimMap(repo, 'gpt-6-luna', { requestId: 'partial-user-condition-map', topic: 'Synthetic roast chicken', context: 'Synthetic regression only.' });
  const store = new AimRunStore(repo);
  const planned = await new AimManualFlow(repo, store, async () => ({ summary: 'What serving time?', detail: 'Synthetic question.', suggestions: [{ title: 'Evening' }, { title: 'Lunch' }], visualReferences: [] })).planNextQuestion(created.mapPath, created.root.id, 'gpt-6-luna', 'low', 'partial-user-condition-question');
  const branch = await store.createAnswerBranch(created.mapPath, { requestId: 'partial-user-condition-answer', questionNodeId: planned.node.id, parentBranchId: null, answerSnapshot: { selections: [], freeText: 'Synthetic constraints only.' }, inputSnapshot: { topic: 'Synthetic roast chicken', conditions: { 'Serving time': 'evening; synthetic' }, upstreamResults: [] } });
  const original = await store.startAttempt(created.mapPath, branch.id, 'partial-user-condition-run', { model: 'gpt-6-luna', reasoning: 'low', maxResearchTurns: 2 });
  await store.recordResearchTurn(created.mapPath, original);
  const seedDraft = (await store.createResultDraft(created.mapPath, original, 'Earlier partial report', 'gpt-6-luna', 'low', { kind: 'synthesis' })).draft;
  await store.updateResultDraftReport(created.mapPath, original, seedDraft.id, 'The saved research covers seasoning but needs a serving estimate.', 'Persisted summary: research supports seasoning options. The serving-time constraint is stated in this branch; chicken weight is absent from this branch and cannot be discovered through web research.');
  await store.recordPlannerReview(created.mapPath, original, { decision: 'research_more', rationale: 'A weight-specific estimate requires the user’s actual chicken weight, which is not in branch conditions.', researchTurn: 1, researchTarget: { title: 'Chicken weight', task: 'Find a cooking time for this chicken.', expectedValue: 'Could improve the serving estimate.' } }, 'The saved research supports seasoning but lacks a user-provided weight.');
  const seed = await store.commitResult(created.mapPath, original, seedDraft.id, { summary: 'The saved research covers seasoning but needs a serving estimate.', detail: 'Persisted summary: research supports seasoning options. The serving-time constraint is stated in this branch; chicken weight is absent from this branch and cannot be discovered through web research.' }, 'partial');
  const calls = []; let searches = 0;
  const continuation = new AimManualFlow(repo, store, async context => {
    calls.push(context);
    if (context.researchMode === 'research') { searches++; throw new Error('User-specific weight must not start a Searcher call.'); }
    assert.equal(context.researchMode, 'local');
    if (aimPhase(context, 'research-gap-audit')) return researchGapAudit('user_condition', 'The missing actual chicken weight is a user-specific cooking condition.');
    assert.ok(aimPhase(context, 'decision-quality-review'), `unexpected phase ${context.task.slice(0, 100)}`);
    return plannerReview('ask_user', { rationale: 'The saved evidence can support a conditional answer, but the user’s actual chicken weight is needed for a useful estimate.', question: 'What is the chicken’s approximate weight?', }, 'Keep the saved seasoning guidance and ask only for the missing user-specific condition.', 'Do not infer a chicken weight from research.', ['About 1.2 kg', 'About 1.5 kg', 'About 2 kg']);
  });
  const outcome = await continuation.continuePartial(created.mapPath, 'partial-user-condition-run', 'gpt-6-luna', 'low');
  assert.equal(searches, 0); assert.deepEqual(calls.map(context => aimPhase(context, 'research-gap-audit') ? 'audit' : 'repair'), ['audit', 'repair']);
  assert.equal(outcome.status, 'waiting-user');
  const saved = await repo.readMap(created.mapPath), savedBranch = saved.aim.branches.find(item => item.id === branch.id), run = saved.aim.runs.find(item => item.id === 'partial-user-condition-run');
  assert.ok(savedBranch.results.some(item => item.resultId === seed.resultId), 'the prior partial result remains attached');
  assert.equal(savedBranch.results.length, 2, 'continuation adds its question result without replacing the saved partial');
  assert.equal(run.attempts.at(-1).searchDiagnostics?.length ?? 0, 0, 'no Searcher call or telemetry is created for a user condition');
  assert.equal(run.attempts.at(-1).plannerReviews.at(-1).decision, 'ask_user');
  const question = saved.nodes.find(item => item.id === outcome.questionNodeId);
  assert.equal(question.aimKind, 'question'); assert.equal(question.parentId, savedBranch.results.at(-1).nodeId);
  assert.match((await repo.readNote(question.path)).summary, /What is the chicken’s approximate weight\?/);
});
integrationTest('partial continuation invalid repair and cancellation retain only the earlier partial result', async () => {
  const { AimRunStore } = load('experiences/aim/research-run-store.ts');
  const { AimManualFlow } = load('experiences/aim/manual-flow.ts');
  const { createAimMap } = load('experiences/aim/create-map.ts');
  const malformed = { summary: 'Planner text without a decision block.', detail: 'No machine-readable marker.', suggestions: [], visualReferences: [] };
  for (const kind of ['invalid-repair', 'cancel-repair']) {
    const { repo, contents } = fixture();
    const created = await createAimMap(repo, 'gpt-6-luna', { requestId: `partial-recovery-${kind}`, topic: `Synthetic partial recovery ${kind}`, context: 'Synthetic-only regression input.' });
    const store = new AimRunStore(repo);
    const questionFlow = new AimManualFlow(repo, store, async () => ({ summary: 'Which synthetic doneness?', detail: 'Test fixture only.', suggestions: [{ title: 'Medium rare' }, { title: 'Follow safety guidance' }], visualReferences: [] }));
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
    const flow = new AimManualFlow(repo, store, async (context, model, reasoning, signal, onWebSearchEvent) => {
      calls.push(context); assert.equal(model, 'gpt-6-luna'); assert.equal(reasoning, 'low');
      if (aimPhase(context, 'research-gap-audit')) return researchGapAudit('external_evidence', 'The target is a distinct externally verifiable method fact.');
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
    const saved = await repo.readMap(created.mapPath), savedBranch = saved.aim.branches.find(item => item.id === branch.id), savedRun = saved.aim.runs.find(item => item.id === runId), current = savedRun.attempts.find(item => item.id === savedRun.currentAttemptId);
    assert.equal(searches, 1, 'the new continuation performs its one planned Searcher turn; format repair adds none');
    assert.equal(planners, 2, 'partial continuation permits one initial Planner and one repair only');
    assert.deepEqual(calls.map(item => item.researchMode), ['local', 'research', 'local', 'local']);
    assert.equal(current.status, kind === 'cancel-repair' ? 'cancelled' : 'failed');
    assert.equal(savedBranch.results.length, 1, 'the prior partial remains the only published result');
    assert.equal(savedBranch.results[0].resultId, seed.resultId);
    assert.equal(contents.get(seed.notePath), seedNoteBefore, 'the prior partial Note remains byte-for-byte unchanged');
    assert.equal(saved.aim.pendingCommits.length, 0); assert.equal(saved.aim.resultDrafts.length, 0);
    const diagnosticPaths = repo.app.vault.getMarkdownFiles().map(file => file.path).filter(filePath => filePath.includes('/Notes/'));
    const diagnostics = await Promise.all(diagnosticPaths.map(filePath => repo.readNote(filePath)));
    assert.ok(diagnostics.some(note => note.status === 'error' && note.detail.includes('AIM incomplete-attempt diagnostic')), 'the failed/cancelled new attempt remains unpublished diagnostic material');
  }
});
integrationTest('failed attempts keep their reports as data, so recovery survives an edited diagnostic note', async () => {
  const { repo, mapPath, question, store } = await aimMapFixture();
  let map = await repo.readMap(mapPath), questionNode = map.nodes.find(item => item.id === question.id);
  questionNode.aimKind = 'question';
  questionNode.aimQuestion = { requestId: 'structured-retry-question', parentBranchId: null, options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], allowMultiple: false, allowFreeText: true };
  await repo.saveMap(mapPath, map);
  const branch = await store.createAnswerBranch(mapPath, { requestId: 'structured-retry-branch', questionNodeId: question.id, parentBranchId: null, answerSnapshot: { selections: [], freeText: 'Synthetic.' }, inputSnapshot: { topic: 'T', conditions: {}, upstreamResults: [] } });
  const reports = [{ summary: 'First report.', detail: 'Findings one.' }, { summary: 'Second report.', detail: 'Findings two.' }];
  const fail = async (runId, diagnostics) => {
    const handle = await store.startAttempt(mapPath, branch.id, runId, { model: 'gpt-6-luna', reasoning: 'low', maxResearchTurns: 1 });
    const draft = (await store.createResultDraft(mapPath, handle, 'Saved reports', 'gpt-6-luna', 'low')).draft;
    await store.updateResultDraftReport(mapPath, handle, draft.id, 'Report 1: First report.\nReport 2: Second report.', '## Searcher report 1\n\nFindings one.\n\n## Searcher report 2\n\nFindings two.', reports);
    if (diagnostics) await store.recordSearchDiagnostic(mapPath, handle, diagnostics);
    await store.failAttempt(mapPath, handle, 'Synthetic failure.');
    return draft.notePath;
  };
  const notePath = await fail('structured-run', { researchTurn: 1, startedEvents: 1, completedEvents: 1, completedSearchActions: 0, otherCompletedActions: 1 });
  const attempt = (await repo.readMap(mapPath)).aim.runs.find(run => run.id === 'structured-run').attempts[0];
  assert.deepEqual(JSON.parse(JSON.stringify(attempt.retainedReports)), { notePath, reports });
  // The user rewrites the diagnostic note; its headings no longer follow the generated format.
  await repo.updateNote(notePath, { detail: 'My own notes about this failure.' });
  const { extractAimFailedReport, matchAimFailedReportTargets } = load('experiences/aim/retry-targets.ts');
  const note = await repo.readNote(notePath);
  assert.deepEqual(JSON.parse(JSON.stringify(extractAimFailedReport(note, attempt, notePath).map(item => item.summary))), ['First report.', 'Second report.']);
  assert.equal(extractAimFailedReport(note, attempt, 'Other/note.md'), null, 'reports belong to their own diagnostic note only');
  assert.equal(matchAimFailedReportTargets(await repo.readMap(mapPath), [{ path: notePath, note }]).get(question.id)?.runId, 'structured-run');
  // Without completed web retrieval nothing is retained.
  await fail('unsearched-run');
  const unsearched = (await repo.readMap(mapPath)).aim.runs.find(run => run.id === 'unsearched-run').attempts[0];
  assert.equal(unsearched.retainedReports, undefined);
});
integrationTest('native RunStore failed Searcher diagnostic enables the saved-report retry action only with completed-search telemetry', async () => {
  const { AimRunStore } = load('experiences/aim/research-run-store.ts');
  const { AimManualFlow } = load('experiences/aim/manual-flow.ts');
  const { repo, app, mapPath, question, store } = await aimMapFixture();
  let map = await repo.readMap(mapPath), questionNode = map.nodes.find(item => item.id === question.id);
  questionNode.aimKind = 'question';
  questionNode.aimQuestion = { requestId: 'native-retry-question', parentBranchId: null, options: [{ id: 'a', label: 'Synthetic A' }, { id: 'b', label: 'Synthetic B' }], allowMultiple: false, allowFreeText: true };
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
  assert.match(diagnosticBefore.detail, /AIM incomplete-attempt diagnostic/);
  assert.match(diagnosticBefore.detail, /## Searcher report 1/);

  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const calls = [];
  const view = new VisualAgentMapView({ app }, { repo, settings: { ...DEFAULT_SETTINGS, language: 'en' }, mutate: async work => work(), syncOutline() {}, releaseOutline() {}, askModel: async context => {
    calls.push(context);
    assert.equal(context.researchMode, 'local', 'reviewing a retained report does not repeat its search');
    return plannerReview('ask_user', { rationale: 'The retained report supports only a conditional answer, while the requested preference is still unknown.', question: 'Which option should the result prioritize?' }, 'Keep the saved report conditional until the user chooses.', 'Do not infer a preference from a failed Searcher attempt.', ['Option A', 'Option B']);
  } });
  view.path = mapPath; view.map = await repo.readMap(mapPath); view.render = () => {};
  await view.hydrateFailedReportTargets(() => true);
  assert.equal(view.aimFailedReports.get(question.id)?.diagnosticNotePath, draft.notePath, 'the authentic RunStore diagnostic becomes the target for the retry action');
  await view.retryAimFromSavedReport(question.id);
  const reopened = new Repository(app, repo.settings), after = await reopened.readMap(mapPath);
  const savedRun = after.aim.runs.find(item => item.id === 'native-retry-run');
  assert.equal(savedRun.attempts[0].status, 'failed');
  assert.equal(savedRun.attempts[1].status, 'completed');
  assert.equal(calls.length, 1, 'the saved-report retry uses one Planner review');
  assert.equal((await reopened.readNote(draft.notePath)).detail, diagnosticBefore.detail, 'the original diagnostic remains byte-for-byte unchanged');

  const zeroSearch = await aimMapFixture();
  const zeroBranch = await zeroSearch.store.createAnswerBranch(zeroSearch.mapPath, { requestId: 'native-retry-no-search', questionNodeId: zeroSearch.question.id, parentBranchId: null, answerSnapshot: { selections: [], freeText: 'Synthetic only.' }, inputSnapshot: { topic: 'Synthetic topic', conditions: {}, upstreamResults: [] } });
  const zeroHandle = await zeroSearch.store.startAttempt(zeroSearch.mapPath, zeroBranch.id, 'native-no-search-run');
  await zeroSearch.store.recordResearchTurn(zeroSearch.mapPath, zeroHandle);
  const zeroDraft = (await zeroSearch.store.createResultDraft(zeroSearch.mapPath, zeroHandle, 'No-search diagnostic', 'gpt-6-luna')).draft;
  await zeroSearch.store.updateResultDraftReport(zeroSearch.mapPath, zeroHandle, 'Report 1: Not searched.', '## Searcher report 1\n\nResearch status: not searched.');
  await zeroSearch.store.recordSearchDiagnostic(zeroSearch.mapPath, zeroHandle, { researchTurn: 1, startedEvents: 0, completedEvents: 0, completedSearchActions: 0, otherCompletedActions: 0 });
  await zeroSearch.store.failAttempt(zeroSearch.mapPath, zeroHandle, 'Synthetic no-search fixture.');
  const { matchAimFailedReportTargets } = load('experiences/aim/retry-targets.ts');
  map = await zeroSearch.repo.readMap(zeroSearch.mapPath);
  assert.equal(matchAimFailedReportTargets(map, [{ path: zeroDraft.notePath, note: await zeroSearch.repo.readNote(zeroDraft.notePath) }]).size, 0, 'a failed diagnostic without completed-search telemetry is never offered as a saved-report retry');

  const ambiguous = await aimMapFixture();
  map = await ambiguous.repo.readMap(ambiguous.mapPath);
  const secondQuestion = await ambiguous.repo.createNote('Second synthetic question', 'gpt-6-luna', map, ambiguous.mapPath, 'workspace');
  const firstQuestionNode = map.nodes.find(item => item.id === ambiguous.question.id);
  for (const item of [firstQuestionNode, secondQuestion]) {
    item.aimKind = 'question';
    item.aimQuestion = { requestId: `ambiguous-${item.id}`, parentBranchId: null, options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], allowMultiple: false, allowFreeText: true };
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
  assert.equal(matchAimFailedReportTargets(map, ambiguousNotes).size, 0, 'repeated native attempt ordinals are hidden even when only one same-ordinal run has completed-search telemetry');
  const ambiguousFlow = new AimManualFlow(ambiguous.repo, new AimRunStore(ambiguous.repo), async () => { throw new Error('ambiguous diagnostic must be rejected before model work'); });
  await assert.rejects(ambiguousFlow.reviewFailedAttemptReport(ambiguous.mapPath, ambiguousRuns[0], ambiguousNotes[0].path), /attempt number is ambiguous/);
});
integrationTest('AIM carries ancestor answers and reports into follow-up branches and Planner context', async () => {
  const { repo } = fixture();
  const { createAimMap } = load('experiences/aim/create-map.ts');
  const created = await createAimMap(repo, 'gpt-6-luna', { requestId: 'lineage-map', topic: '在家煎牛排', context: '鑄鐵鍋；沒有烤箱。' });
  const { AimRunStore } = load('experiences/aim/research-run-store.ts');
  const { AimManualFlow } = load('experiences/aim/manual-flow.ts');
  let call = 0, id = 0, requestedParentEvidence = false; const contexts = [];
  const flow = new AimManualFlow(repo, new AimRunStore(repo), async context => {
    contexts.push(context); call++;
    if (aimPhase(context, 'saved-evidence-review')) return savedEvidenceNeedsSearch();
    if (aimPhase(context, 'research-plan')) return { summary: '安全與操作兩個面向', detail: '<!-- aim-plan {"subtopics":[{"id":"safety","title":"安全條件","task":"查詢適用安全條件","expectedValue":"保留必要安全限制"},{"id":"method","title":"操作方法","task":"比較可行操作方式","expectedValue":"補足執行細節"}]} -->', suggestions: [], visualReferences: [] };
    if (context.task.includes('Decide whether one missing user condition')) return { summary: call === 1 ? '偏好熟度？' : '想要脆皮程度？', detail: '此條件會影響操作。', suggestions: [{ title: '偏紅' }, { title: '較熟' }], visualReferences: [] };
    if (aimPhase(context, 'report-review')) {
      const evidenceId = `${context.task}\n${context.detail}\n${context.ancestors}`.match(/Evidence ID: ([^\s]+)/)?.[1];
      if (/外層要酥脆/.test(context.task) && evidenceId && !requestedParentEvidence) { requestedParentEvidence = true; return { summary: 'Need the parent report details.', detail: `<!-- aim-evidence-request {"ids":["${evidenceId}"]} -->`, suggestions: [], visualReferences: [] }; }
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
  assert.equal(firstAnswerCalls.filter(context => aimPhase(context, 'report-review')).length, 1);
  assert.ok(firstAnswerCalls.every(context => `${context.task}\n${context.detail}\n${context.ancestors}`.length < 30000), 'branch context remains bounded');
  assert.ok(firstAnswerCalls.every(context => /鑄鐵鍋|沒有烤箱/.test(`${context.task}\n${context.detail}\n${context.ancestors}`)), 'the original conditions remain available to both calls');
  let map = await repo.readMap(created.mapPath); const firstBranch = map.aim.branches[0], firstResult = firstBranch.results.find(item => item.kind === 'synthesis');
  const secondQuestionNode = map.nodes.find(node => node.id === firstAnswer.questionNodeId);
  const secondQuestion = { node: secondQuestionNode, options: secondQuestionNode.aimQuestion.options };
  assert.equal(secondQuestion.node.aimQuestion.parentBranchId, firstBranch.id);
  const secondAnswer = await flow.answerAndResearch(created.mapPath, secondQuestion.node.id, { requestId: 'lineage-a2', selections: [secondQuestion.options.find(option => option.label === '烹調方式').id], freeText: '外層要酥脆' }, 'gpt-6-luna', 'low');
  assert.equal(secondAnswer.status, 'waiting-user'); map = await repo.readMap(created.mapPath);
  const followupResearch = contexts.find(context => context.researchMode === 'research' && /外層要酥脆/.test(context.task));
  assert.ok(followupResearch && /外層要酥脆/.test(followupResearch.task) && /偏紅/.test(followupResearch.ancestors) && /Evidence ID:/.test(followupResearch.ancestors) && /Full report retained/.test(followupResearch.ancestors), 'the follow-up search receives the latest answer, ancestor answer, and indexed parent report');
  const child = map.aim.branches.find(branch => branch.id === secondAnswer.branchId);
  assert.equal(child.parentBranchId, firstBranch.id);
  assert.deepEqual(plain(child.inputSnapshot.conditions), { '偏好熟度？': '偏紅 — 中等厚度', '接下來你希望優先深入哪個部分？': '烹調方式 — 外層要酥脆' });
  assert.ok(child.inputSnapshot.upstreamResults.some(result => result.notePath === firstResult.notePath && result.version === firstResult.version));
  const followupReview = contexts.find(context => aimPhase(context, 'report-review') && /外層要酥脆/.test(context.task));
  assert.ok(followupReview, 'the follow-up evidence review receives the latest answer and parent branch');
  assert.match(followupReview.task, /外層要酥脆/); assert.match(`${followupReview.task}\n${followupReview.detail}\n${followupReview.ancestors}`, /偏紅/); assert.match(`${followupReview.task}\n${followupReview.detail}\n${followupReview.ancestors}`, /Evidence ID:/);
});
integrationTest('AIM keeps changed answers on independent question pivots with direct research children', async () => {
  const { repo, mapPath, question, store } = await aimMapFixture();
  const questionMap = await repo.readMap(mapPath), questionNode = questionMap.nodes.find(node => node.id === question.id);
  questionNode.aimKind = 'question';
  questionNode.aimQuestion = { requestId: 'independent-answer-question', parentBranchId: null, options: [{ id: 'medium-rare', label: '偏紅熟度' }, { id: '安全建議優先', label: '安全優先' }], allowMultiple: true, allowFreeText: true };
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
  assert.equal(firstQuestion.aimKind, 'question');
  assert.equal(secondQuestion.aimKind, 'question');
  assert.equal(firstQuestion.id, question.id);
  assert.notEqual(firstQuestion.id, secondQuestion.id);
  assert.equal(pivotMap.nodes.some(node => node.aimKind === 'answer'), false, 'answer submissions must not create answer pivot nodes');
  const secondAttempt = await store.startAttempt(mapPath, secondBranch.id, 'run-safety-first');
  const secondDraft = (await store.createResultDraft(mapPath, secondAttempt, '安全優先建議', 'gpt-6-luna')).draft;
  assert.equal((await repo.readMap(mapPath)).nodes.find(node => node.id === firstDraft.nodeId).parentId, firstBranch.questionNodeId);
  assert.equal((await repo.readMap(mapPath)).nodes.find(node => node.id === secondDraft.nodeId).parentId, secondBranch.questionNodeId);
  assert.equal((await store.commitResult(mapPath, secondAttempt, secondDraft.id, { summary: '安全優先條件式建議', detail: '分支二的不同研究結果。' })).status, 'committed');

  const savedMap = await repo.readMap(mapPath), state = savedMap.aim;
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
integrationTest('AIM explicit re-answer removes legacy answer pivots, reconnects research, and preserves pivot notes', async () => {
  const { repo, mapPath, question, store } = await aimMapFixture();
  const branch = await store.createAnswerBranch(mapPath, { questionNodeId: question.id, parentBranchId: null, answerSnapshot: { selections: [], freeText: '文化古蹟與博物館' }, inputSnapshot: { topic: '台北一日遊', conditions: {}, upstreamResults: [] } });
  const attempt = await store.startAttempt(mapPath, branch.id, 'legacy-run');
  const draft = (await store.createResultDraft(mapPath, attempt, '文化古蹟研究', 'gpt-6-luna')).draft;
  await store.commitResult(mapPath, attempt, draft.id, { summary: '文化古蹟', detail: '既有研究。' });

  const legacy = await repo.readMap(mapPath), legacyBranch = legacy.aim.branches[0];
  const oldPivot = await repo.createNote('舊答案支點', 'gpt-6-luna', legacy, mapPath, 'workspace', { summary: '舊答案', detail: '保留這個 Markdown 檔案。' });
  oldPivot.parentId = legacyBranch.questionNodeId;
  oldPivot.aimKind = 'answer';
  legacy.nodes.push(oldPivot);
  legacyBranch.answerNodeId = oldPivot.id;
  legacy.nodes.find(node => node.id === draft.nodeId).parentId = oldPivot.id;
  await repo.saveMap(mapPath, legacy);

  assert.ok(await store.recoverAnswerBranches(mapPath) > 0);
  const restored = await repo.readMap(mapPath), restoredBranch = restored.aim.branches[0];
  assert.equal(restoredBranch.answerNodeId, undefined);
  assert.equal(restored.nodes.some(node => node.id === oldPivot.id), false, 'the legacy answer pivot is removed from the Map');
  assert.equal(restored.nodes.find(node => node.id === draft.nodeId).parentId, restoredBranch.questionNodeId);
  assert.equal((await repo.readNote(oldPivot.path)).summary, '舊答案', 'migration preserves the old Markdown note');
});
integrationTest('AIM reviews the other reports when one subtopic search fails', async () => {
  const { repo, mapPath, question, store } = await aimMapFixture();
  const map = await repo.readMap(mapPath), questionNode = map.nodes.find(node => node.id === question.id);
  questionNode.aimKind = 'question';
  questionNode.aimQuestion = { requestId: 'partial-search-question', parentBranchId: null, options: [{ id: 'history', label: '歷史街區' }, { id: 'museum', label: '博物館' }], allowMultiple: false, allowFreeText: true };
  await repo.saveMap(mapPath, map);
  const { AimManualFlow } = load('experiences/aim/manual-flow.ts');
  let reviewed = '';
  const flow = new AimManualFlow(repo, store, async context => {
    if (aimPhase(context, 'research-plan')) return { summary: '路線與無障礙條件', detail: '<!-- aim-plan {"subtopics":[{"id":"route","title":"路線選項","task":"研究可行路線與轉乘","expectedValue":"比較路線方案"},{"id":"access","title":"無障礙條件","task":"研究無障礙步行與車站資訊","expectedValue":"確認實際通行限制"}]} -->', suggestions: [], visualReferences: [] };
    if (context.researchMode === 'research') return context.task.includes('研究無障礙步行')
      ? { summary: 'Search unavailable', detail: 'Research status: unavailable', suggestions: [], visualReferences: [] }
      : { summary: 'Route evidence', detail: 'Research status: search completed\nROUTE_REPORT_ONLY a transit route report with its limits.', suggestions: [], visualReferences: [] };
    if (aimPhase(context, 'report-review')) { reviewed = [context.task, context.ancestors, context.detail].join('\n'); return plannerReview('ask_user', { rationale: 'Travel-time preference remains unknown.', question: 'Should the route prioritize the shortest walk or the fewest transfers?' }, 'Conditional route answer.', 'Use the saved route evidence.', ['Shortest walk', 'Fewest transfers']); }
    throw new Error(`Unexpected model request: ${context.task.slice(0, 100)}`);
  });
  const outcome = await flow.answerAndResearch(mapPath, question.id, { requestId: 'partial-search-answer', selections: ['history'], freeText: '' }, 'gpt-6-luna', 'low');
  assert.equal(outcome.status, 'waiting-user');
  assert.match(reviewed, /ROUTE_REPORT_ONLY/);
  const branch = (await repo.readMap(mapPath)).aim.branches[0];
  assert.deepEqual(plain(branch.results.filter(item => item.kind === 'research').map(item => item.subtopicId)), ['route'], 'the failed search publishes no report');
});
integrationTest('AIM reviews the other reports when the provider ran no web search for one subtopic (zh-TW runtime message)', async () => {
  const { repo, mapPath, question, store } = await aimMapFixture();
  const map = await repo.readMap(mapPath), questionNode = map.nodes.find(node => node.id === question.id);
  questionNode.aimKind = 'question';
  questionNode.aimQuestion = { requestId: 'zh-search-question', parentBranchId: null, options: [{ id: 'history', label: '歷史街區' }, { id: 'museum', label: '博物館' }], allowMultiple: false, allowFreeText: true };
  await repo.saveMap(mapPath, map);
  const { AimManualFlow } = load('experiences/aim/manual-flow.ts');
  let reviewed = '';
  const flow = new AimManualFlow(repo, store, async context => {
    if (aimPhase(context, 'research-plan')) return { summary: '路線與無障礙條件', detail: '<!-- aim-plan {"subtopics":[{"id":"route","title":"路線選項","task":"研究可行路線與轉乘","expectedValue":"比較路線方案"},{"id":"access","title":"無障礙條件","task":"研究無障礙步行與車站資訊","expectedValue":"確認實際通行限制"}]} -->', suggestions: [], visualReferences: [] };
    if (context.researchMode === 'research' && context.task.includes('研究無障礙步行')) throw new Error('AI 服務沒有實際執行網路搜尋，無法提供已查證結果；請確認模型與工具可用性。');
    if (context.researchMode === 'research') return { summary: 'Route evidence', detail: 'Research status: search completed\nROUTE_REPORT_ONLY a transit route report with its limits.', suggestions: [], visualReferences: [] };
    if (aimPhase(context, 'report-review')) { reviewed = [context.task, context.ancestors, context.detail].join('\n'); return plannerReview('ask_user', { rationale: 'Travel-time preference remains unknown.', question: 'Should the route prioritize the shortest walk or the fewest transfers?' }, 'Conditional route answer.', 'Use the saved route evidence.', ['Shortest walk', 'Fewest transfers']); }
    throw new Error(`Unexpected model request: ${context.task.slice(0, 100)}`);
  });
  const outcome = await flow.answerAndResearch(mapPath, question.id, { requestId: 'zh-search-answer', selections: ['history'], freeText: '' }, 'gpt-6-luna', 'low');
  assert.equal(outcome.status, 'waiting-user');
  assert.match(reviewed, /ROUTE_REPORT_ONLY/);
  const branch = (await repo.readMap(mapPath)).aim.branches[0];
  assert.deepEqual(plain(branch.results.filter(item => item.kind === 'research').map(item => item.subtopicId)), ['route'], 'the failed search publishes no report');
});
integrationTest('AIM reviews the other reports when one subtopic runs past its time limit', async () => {
  const { repo, mapPath, question, store } = await aimMapFixture();
  const map = await repo.readMap(mapPath), questionNode = map.nodes.find(node => node.id === question.id);
  questionNode.aimKind = 'question';
  questionNode.aimQuestion = { requestId: 'timeout-search-question', parentBranchId: null, options: [{ id: 'history', label: '歷史街區' }, { id: 'museum', label: '博物館' }], allowMultiple: false, allowFreeText: true };
  await repo.saveMap(mapPath, map);
  const { AimManualFlow } = load('experiences/aim/manual-flow.ts');
  let reviewed = '';
  const flow = new AimManualFlow(repo, store, async context => {
    if (aimPhase(context, 'research-plan')) return { summary: '路線與無障礙條件', detail: '<!-- aim-plan {"subtopics":[{"id":"route","title":"路線選項","task":"研究可行路線與轉乘","expectedValue":"比較路線方案"},{"id":"access","title":"無障礙條件","task":"研究無障礙步行與車站資訊","expectedValue":"確認實際通行限制"}]} -->', suggestions: [], visualReferences: [] };
    if (context.researchMode === 'research' && context.task.includes('研究無障礙步行')) throw new Error('The AI task exceeded 3 minutes. VAM attempts to interrupt it to avoid prolonged resource use. Incomplete results are not applied; try a smaller task.');
    if (context.researchMode === 'research') return { summary: 'Route evidence', detail: 'Research status: search completed\nROUTE_REPORT_ONLY a transit route report with its limits.', suggestions: [], visualReferences: [] };
    if (aimPhase(context, 'report-review')) { reviewed = [context.task, context.ancestors, context.detail].join('\n'); return plannerReview('ask_user', { rationale: 'Travel-time preference remains unknown.', question: 'Should the route prioritize the shortest walk or the fewest transfers?' }, 'Conditional route answer.', 'Use the saved route evidence.', ['Shortest walk', 'Fewest transfers']); }
    throw new Error(`Unexpected model request: ${context.task.slice(0, 100)}`);
  });
  const outcome = await flow.answerAndResearch(mapPath, question.id, { requestId: 'timeout-search-answer', selections: ['history'], freeText: '' }, 'gpt-6-luna', 'low');
  assert.equal(outcome.status, 'waiting-user');
  assert.match(reviewed, /ROUTE_REPORT_ONLY/);
  const branch = (await repo.readMap(mapPath)).aim.branches[0];
  assert.deepEqual(plain(branch.results.filter(item => item.kind === 'research').map(item => item.subtopicId)), ['route'], 'the failed search publishes no report');
});
integrationTest('AIM resumes a failed search on the saved answer without duplicating its branch', async () => {
  const { repo, mapPath, question, store } = await aimMapFixture();
  const map = await repo.readMap(mapPath), questionNode = map.nodes.find(node => node.id === question.id);
  questionNode.aimKind = 'question';
  questionNode.aimQuestion = { requestId: 'planning-retry-question', parentBranchId: null, options: [{ id: 'history', label: '歷史街區' }, { id: 'museum', label: '博物館' }], allowMultiple: false, allowFreeText: true };
  await repo.saveMap(mapPath, map);
  const { AimManualFlow } = load('experiences/aim/manual-flow.ts');
  let failSearch = true;
  const flow = new AimManualFlow(repo, store, async context => {
    if (aimPhase(context, 'research-plan')) return { summary: '路線與無障礙條件', detail: '<!-- aim-plan {"subtopics":[{"id":"route","title":"路線選項","task":"研究可行路線與轉乘","expectedValue":"比較路線方案"},{"id":"access","title":"無障礙條件","task":"研究無障礙步行與車站資訊","expectedValue":"確認實際通行限制"}]} -->', suggestions: [], visualReferences: [] };
    if (context.researchMode === 'research') return failSearch
      ? { summary: 'Search unavailable', detail: 'Research status: unavailable', suggestions: [], visualReferences: [] }
      : { summary: 'Route evidence', detail: 'Research status: search completed\nA step-free transit route report with its limits.', suggestions: [], visualReferences: [] };
    if (aimPhase(context, 'report-review')) return plannerReview('ask_user', { rationale: 'The route report supports a conditional answer, but travel-time preference remains unknown.', question: 'Should the route prioritize the shortest walk or the fewest transfers?' }, 'Use the saved route evidence conditionally until the travel preference is clear.', 'Do not infer a preference from the saved answer.', ['Shortest walk', 'Fewest transfers']);
    throw new Error(`Unexpected model request: ${context.task.slice(0, 100)}`);
  });
  const input = { requestId: 'saved-answer-planner-retry', selections: ['history'], freeText: '以大眾運輸為主' };
  await assert.rejects(flow.answerAndResearch(mapPath, question.id, input, 'gpt-6-luna', 'low'), /no web search succeeded/);
  let saved = await repo.readMap(mapPath), branch = saved.aim.branches[0];
  assert.equal(saved.aim.branches.length, 1, 'a failed search preserves one answer branch');
  assert.deepEqual(plain(branch.researchPlan.map(item => item.id)), ['route', 'access']);
  assert.equal(branch.results.length, 0);
  const failedRun = saved.aim.runs.find(run => run.branchId === branch.id);
  assert.ok(failedRun?.attempts.some(attempt => attempt.status === 'failed'), 'failed search state is persisted for resumption');
  const answerSnapshot = plain(branch.answerSnapshot), branchId = branch.id;
  failSearch = false;
  const retried = await flow.resumeAnswerResearch(mapPath, branchId, 'gpt-6-luna', 'low');
  assert.equal(retried.status, 'waiting-user');
  saved = await repo.readMap(mapPath); branch = saved.aim.branches.find(item => item.id === branchId);
  assert.equal(saved.aim.branches.length, 1, 'resume reuses the saved answer instead of creating a duplicate branch');
  assert.deepEqual(plain(branch.answerSnapshot), answerSnapshot);
  assert.deepEqual(plain(branch.researchPlan.map(item => item.id)), ['route', 'access']);
  const research = branch.results.filter(item => item.kind === 'research');
  assert.equal(research.length, 2);
  assert.ok(research.every(item => saved.nodes.find(node => node.id === item.nodeId).parentId === branch.questionNodeId));
});
integrationTest('AIM researches every planned subtopic independently and keeps re-answers in a new branch', async () => {
  const { repo } = fixture(); const { createAimMap } = load('experiences/aim/create-map.ts');
  const created = await createAimMap(repo, 'gpt-6-luna', { requestId: 'multi-subtopic-map', topic: '如何選擇牛排熟度？', context: '有溫度計。', minimumAnswersBeforeConclusion: 3 });
  const { AimRunStore } = load('experiences/aim/research-run-store.ts'); const { AimManualFlow } = load('experiences/aim/manual-flow.ts');
  let call = 0, synthesisCalls = 0;
  const flow = new AimManualFlow(repo, new AimRunStore(repo), async context => {
    call++;
    if (aimPhase(context, 'saved-evidence-review')) return savedEvidenceNeedsSearch();
    if (aimPhase(context, 'research-plan')) return { summary: '安全與口感兩個面向', detail: '<!-- aim-plan {"subtopics":[{"id":"safety","title":"安全溫度","task":"查詢牛排安全溫度","expectedValue":"確認安全底線"},{"id":"texture","title":"口感差異","task":"比較不同熟度口感","expectedValue":"呈現口感取捨"}]} -->', suggestions: [], visualReferences: [] };
    const delivery = deliveryFixture(context); if (delivery) return delivery;
    if (context.task.includes('Decide whether one missing user condition')) return { summary: '偏好哪種熟度？', detail: '用於收斂建議。', suggestions: [{ title: '偏嫩', task: '', contribution: '' }, { title: '較熟', task: '', contribution: '' }], visualReferences: [] };
    if (aimPhase(context, 'report-review')) {
      synthesisCalls++;
      if (synthesisCalls === 1) {
        assert.match(context.task, /Prior questions:/);
        assert.match(context.task, /do not require reaching it or add quota filler/);
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
  let saved = await repo.readMap(created.mapPath), branch = saved.aim.branches[0];
  assert.deepEqual(plain(branch.researchPlan.map(item => item.id)), ['safety', 'texture']);
  assert.equal(branch.results.filter(item => item.kind === 'research').length, 2);
  const reports = branch.results.filter(item => item.kind === 'research');
  assert.equal(branch.answerNodeId, undefined, 'answers are stored on the question branch, without an answer pivot');
  assert.ok(reports.every(item => saved.nodes.find(node => node.id === item.nodeId)?.parentId === branch.questionNodeId), 'the answer research target must grow directly from its answered question');
  const synthesis = branch.results.find(item => item.kind === 'synthesis');
  const convergenceNode = saved.nodes.find(item => item.id === synthesis.nodeId);
  assert.deepEqual(plain(convergenceNode.aimConvergesFromNodeIds), plain(reports.map(item => item.nodeId)));
  const followup = saved.nodes.find(item => item.id === first.questionNodeId);
  assert.equal(followup.parentId, synthesis.nodeId);
  assert.equal(followup.aimConvergesFromNodeIds, undefined, 'only the synthesis node converges research subtopics');
  const second = await flow.answerAndResearch(created.mapPath, first.questionNodeId, { requestId: 'multi-subtopic-answer-b', selections: [first.status === 'waiting-user' ? saved.nodes.find(item => item.id === first.questionNodeId).aimQuestion.options[1].id : question.options[1].id], freeText: '我重視快速完成。' }, 'gpt-6-luna', 'low');
  assert.equal(second.status, 'waiting-user');
  const nextMap = await repo.readMap(created.mapPath), thirdQuestion = nextMap.nodes.find(n => n.id === second.questionNodeId);
  const third = await flow.answerAndResearch(created.mapPath, thirdQuestion.id, { requestId: 'multi-subtopic-answer-c', selections: [thirdQuestion.aimQuestion.options[0].id], freeText: 'Third condition' }, 'gpt-6-luna', 'low');
  assert.equal(third.status, 'completed');
  saved = await repo.readMap(created.mapPath);
  assert.equal(saved.aim.branches.length, 3);
  assert.notEqual(saved.aim.branches[0].id, saved.aim.branches[1].id);
  assert.equal(saved.aim.branches[1].parentBranchId, saved.aim.branches[0].id);
  assert.equal(saved.aim.branches[1].results.filter(item => item.kind === 'research').length, 2);
  assert.ok(saved.aim.branches[2].results.some(item => item.kind === 'conclusion'));
  assert.equal(synthesisCalls, 3);
  assert.ok(call >= 8, 'all three answers run research and delivery stages');
});
integrationTest('opening a saved map clears legacy question convergence edges but keeps synthesis edges', async () => {
  const persisted = map([
    { ...node('question'), aimKind: 'question', aimConvergesFromNodeIds: ['research'] },
    { ...node('research', 'question'), aimKind: 'research' },
    { ...node('synthesis', 'question'), aimKind: 'synthesis', aimConvergesFromNodeIds: ['research'] }
  ]);
  let saved;
  const repo = { readMap: async () => structuredClone(persisted), saveMap: async (_path, value) => { saved = structuredClone(value); } };
  const plugin = { repo, settings: {}, mutate: work => work(), closeStaleDetails() {} };
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const view = new VisualAgentMapView({ app: { workspace: { requestSaveLayout() {} } } }, plugin);
  view.render = () => {}; view.hydrate = async () => {};
  await view.openMap('legacy.md');
  assert.ok(saved, 'opening a legacy map persists the one-time cleanup');
  assert.equal(saved.nodes[0].aimConvergesFromNodeIds, undefined);
  assert.deepEqual(plain(saved.nodes[2].aimConvergesFromNodeIds), ['research']);
});
