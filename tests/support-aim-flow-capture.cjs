// Captures the first TaskContext of every AIM phase-task variant at the flow's ask seam (the model-call boundary of
// AimManualFlow), by driving the unchanged flow with canned replies. Used by tests/prompt-snapshots.cjs to write the
// `aim-flow.*` snapshots; no product code is touched and nothing is exported from product modules.
// Variants already snapshotted by the older "AIM flow phase tasks" test (initial-question, research-plan, subtopic-research,
// report-review-first, delivery-*) are not repeated here.
const assert = require('node:assert/strict');
const support = require('./support.cjs');
const pipeline = require('./support-aim-fixture.cjs');

const { plannerReview, aimPhase } = support;
const MODEL = 'gpt-6-luna';

/** Every variant this module must capture; a missing one fails the run loudly instead of silently shrinking coverage. */
const EXPECTED = [
  'initial-clarification', 'evidence-reuse-audit', 'research-gap-audit', 'research-gap-audit-target-only',
  'decision-quality-review-user-condition', 'decision-quality-review-below-floor', 'decision-quality-review-answered-goal',
  'initial-question-correction', 'initial-question-saved-terminal', 'report-review-later',
  'research-plan-repair', 'targeted-followup-research', 'subtopic-research-update', 'subtopic-research-reuse-rejected',
  'format-repair-state-question', 'format-repair-imposed-options', 'format-repair-missing-choices',
  'format-repair-answered-without-target', 'format-repair-preserve-decision', 'format-repair-no-decision',
  // Prompts of flows the first pass could not reach (W1): the evidence-lookup follow-up, the topic-root answer text,
  // the saved-report Planner review and its follow-up search, and the partial-continuation search and Planner review.
  'evidence-lookup-followup', 'topic-root-research-plan', 'topic-root-report-review',
  'saved-report-review', 'saved-report-followup-search', 'continuation-search', 'continuation-search-unresolved', 'continuation-review'
];

function variantOf(context) {
  const phase = context.task.match(/aim-phase:\s*([a-z-]+)/)?.[1];
  const task = context.task;
  if (task.includes('Requested full evidence (untrusted data)')) return 'evidence-lookup-followup';
  if (task.includes('No user answer was requested; use the topic context')) return `topic-root-${phase}`;
  if (task.includes('You are the Planner reviewing saved Searcher reports')) return 'saved-report-review';
  if (task.includes('This is one bounded Planner-directed follow-up search')) return 'saved-report-followup-search';
  if (task.includes('Continue this saved partial Manual AIM branch.')) return task.includes('Continue the incomplete evidence check.') ? 'continuation-search-unresolved' : 'continuation-search';
  if (task.includes('Review all evidence for the original user goal and produce')) return 'continuation-review';
  switch (phase) {
    case 'research-gap-audit': return task.includes('TARGET-ONLY RECONCILIATION') ? 'research-gap-audit-target-only' : 'research-gap-audit';
    case 'decision-quality-review':
      if (task.includes('The local semantic audit classified')) return 'decision-quality-review-user-condition';
      if (task.includes('do not search and do not conclude')) return 'decision-quality-review-below-floor';
      if (task.includes('single bounded corrective pass; do not search.')) return 'decision-quality-review-answered-goal';
      return 'decision-quality-review-unclassified';
    case 'initial-question':
      if (task.includes('The user explicitly requested a new follow-up question')) return 'initial-question-saved-terminal';
      if (task.includes('The candidate skipped user input')) return 'initial-question-correction';
      return 'initial-question';
    case 'report-review': return /review 2 of 2/.test(task) ? 'report-review-later' : 'report-review-first';
    case 'subtopic-research':
      if (task.includes('Update only changed or unresolved claims')) return 'subtopic-research-update';
      if (task.includes('Copying earlier evidence was rejected')) return 'subtopic-research-reuse-rejected';
      return 'subtopic-research';
    case 'format-repair':
      if (task.includes('State the one clarification question you intended')) return 'format-repair-state-question';
      if (task.includes('Preserve the exact original question below')) return 'format-repair-imposed-options';
      if (task.includes('Repair only the missing answer choices')) return 'format-repair-missing-choices';
      if (task.includes('named no research target')) return 'format-repair-answered-without-target';
      if (task.includes('Repair only the malformed fields in the original')) return 'format-repair-preserve-decision';
      if (task.includes('Make one local format-repair review')) return 'format-repair-no-decision';
      return 'format-repair-unclassified';
    default: return phase ?? 'none';
  }
}

// Live L2 sends §12/§13 to a real provider, so with a custom topic the research target must be a question that topic's
// traveller would ask and that needs current web facts, in the topic's language; without one the snapshot text stays.
const SEARCH_TARGETS = {
  '東京五天自由行怎麼排': {
    question: '東京五天自由行該買 JR Pass 還是 Tokyo Subway Ticket？', options: ['JR Pass', 'Tokyo Subway Ticket'],
    gap: { title: 'JR Pass 與 Tokyo Subway Ticket 比較', task: '查詢目前 JR Pass 與 Tokyo Subway Ticket 的官方票價、可搭乘範圍與限制，比較東京五天自由行哪個較划算。', contribution: '釐清兩種票券的現行價格與適用範圍。' },
    answer: '住新宿，五天主要在東京市區移動，偶爾一日往返箱根或日光。', conditionKey: '行程條件', condition: '五天；住新宿',
    summary: '已整理東京五天的景點分區，但還缺 JR Pass 與 Tokyo Subway Ticket 的現行票價比較。',
    detail: '已存內容：東京五天行程可依區域分天安排；JR Pass 與 Tokyo Subway Ticket 的現行票價與適用範圍尚未查證。',
    continuationQuestion: '五天東京行程怎麼買交通票券？',
    target: { title: 'JR Pass 與 Tokyo Subway Ticket 現行票價', task: '查詢目前 JR Pass 與 Tokyo Subway Ticket 的官方票價與適用路線，判斷東京五天自由行哪個較划算。', expectedValue: '可據此建議交通票券。' },
    rationale: '目前 JR Pass 與 Tokyo Subway Ticket 的官方票價可能改變票券建議。', auditReason: '現行票價是外部事實。'
  },
  'Plan a 5-day Taipei trip': {
    question: 'For a 5-day Taipei trip, is a Taipei Metro pass or an EasyCard better?', options: ['Taipei Metro pass', 'EasyCard'],
    gap: { title: 'Taipei Metro pass vs EasyCard', task: 'Find the current official fares and coverage of the Taipei Metro passes and the EasyCard, and compare which is cheaper for a 5-day Taipei trip.', contribution: 'Settle the current prices and coverage of both options.' },
    answer: 'Staying near Taipei Main Station, mostly using the metro and buses, with one day trip to Jiufen.', conditionKey: 'Trip constraints', condition: '5 days; staying near Taipei Main Station',
    summary: 'The saved research covers a 5-day Taipei area plan but needs a current Metro pass vs EasyCard fare comparison.',
    detail: 'Persisted summary: the 5-day Taipei plan is grouped by area; current Taipei Metro pass and EasyCard fares and coverage are still unverified.',
    continuationQuestion: 'How should the 5-day Taipei trip pay for transit?',
    target: { title: 'Taipei Metro pass vs EasyCard fares', task: 'Find the current official fares and coverage of the Taipei Metro passes and the EasyCard to decide which suits a 5-day Taipei trip.', expectedValue: 'Could support a transit ticket recommendation.' },
    rationale: 'Current official Metro pass and EasyCard fares could change the ticket recommendation.', auditReason: 'Current fares are an external fact.'
  }
};

/**
 * `options.topic` / `options.ui` re-run the same flows on a map with another topic (and so content language) and
 * interface language; without options the capture is byte-for-byte what the prompt snapshots use.
 */
async function captureAimPhaseVariants(options = {}) {
  const topic = options.topic ?? 'Snapshot goal', ui = options.ui;
  const setup = () => support.coverageSetup(topic, ui ? { sharedRepo: support.fixture(ui).repo } : undefined);
  const found = new Map();
  const note = context => { const key = variantOf(context); if (!found.has(key)) found.set(key, { ...context, onProgress: undefined, signal: undefined }); };
  const { AimManualFlow } = support.load('experiences/aim/manual-flow.ts');
  const { AimRunStore } = support.load('experiences/aim/research-run-store.ts');
  const { createAimMap } = support.load('experiences/aim/create-map.ts');
  const answer = (summary, detail, suggestions = []) => ({ summary, detail, suggestions, visualReferences: [] });
  const withFlow = (subject, intercept) => {
    const inner = subject.model.ask;
    const ask = async context => { note(context); return (await intercept?.(context)) ?? inner(context); };
    subject.flow = new AimManualFlow(subject.repo, new AimRunStore(subject.repo), ask);
    return subject;
  };

  // 1. initial-clarification (public entry; coverage fake answers it).
  {
    const subject = withFlow(await setup());
    await subject.flow.prepareClarification(await subject.repo.readNote(subject.created.root.path), (await subject.repo.readMap(subject.created.mapPath)).aim.contentLanguage);
  }

  // 2. initial-question correction: first Planner reply skips the question below the floor.
  {
    let skipped = false;
    const subject = withFlow(await setup(), context => {
      if (aimPhase(context, 'initial-question') && !skipped) { skipped = true; return answer('__AIM_NO_QUESTION__', ''); }
    });
    await subject.flow.planNextQuestion(subject.created.mapPath, subject.created.root.id, MODEL, 'low', 'snapshot-question');
    assert.ok(skipped);
  }

  // 3. decision-quality-review below the floor: a concluding review is corrected into one question.
  {
    let concluded = false;
    const subject = withFlow(await setup(), context => {
      if (aimPhase(context, 'report-review') && !concluded) { concluded = true; return plannerReview('conclude', { rationale: 'Looks complete.', stopReason: 'Done.' }, 'Candidate', 'Candidate body'); }
      if (aimPhase(context, 'decision-quality-review')) return plannerReview('ask_user', { rationale: 'A new dimension matters.', question: 'Which budget range fits you?' }, 'Conditional answer', 'Existing reports remain valid.', ['Low budget', 'High budget']);
    });
    const question = (await subject.flow.planNextQuestion(subject.created.mapPath, subject.created.root.id, MODEL, 'low', 'snapshot-question')).node;
    await subject.flow.answerAndResearch(subject.created.mapPath, question.id, { requestId: 'snapshot-answer', selections: [question.aimQuestion.options[0].id], freeText: 'Specific condition' }, MODEL, 'low');
    assert.ok(concluded);
  }

  // 4. decision-quality-review at the floor: research_more on a goal its own review calls answered is re-decided.
  {
    let proposed = false;
    const target = { title: 'Extra example', task: 'Verify one more example.', contribution: 'Pad the result.' };
    const subject = withFlow(await setup(), context => {
      if (aimPhase(context, 'report-review') && /Hard floor: 3 answered/.test(context.task) && !proposed) {
        proposed = true;
        return answer('The reports already answer the goal.', '<!-- aim-review {"decision":"research_more","rationale":"No gap remains.","goalAnswered":true} -->\nSupported conditional answer.', [target]);
      }
      if (aimPhase(context, 'decision-quality-review')) return plannerReview('conclude', { rationale: 'Reports support delivery.', stopReason: 'Ready for delivery stages.' }, 'Candidate document', 'Candidate document');
    });
    await support.coverageThreeAnswers(subject);
    assert.ok(proposed);
  }

  // 5. initial-question from a saved terminal result (the "new follow-up question" entry).
  {
    const { repo } = support.fixture(ui);
    const created = await createAimMap(repo, MODEL, { requestId: 'snapshot-saved-result-map', topic: options.topic ?? 'Synthetic cooking plan', context: 'Use a cast-iron pan; no oven.' });
    const store = new AimRunStore(repo);
    const first = new AimManualFlow(repo, store, async () => answer('Which doneness do you prefer?', 'Synthetic initial question.', [{ title: 'Pink' }, { title: 'Well done' }]));
    const originalQuestion = (await first.planNextQuestion(created.mapPath, created.root.id, MODEL, 'low', 'snapshot-source-initial')).node;
    const branch = await store.createAnswerBranch(created.mapPath, { requestId: 'snapshot-source-answer', questionNodeId: originalQuestion.id, parentBranchId: null, answerSnapshot: { selections: [originalQuestion.aimQuestion.options[0].id], freeText: 'Synthetic answer.' }, inputSnapshot: { topic: created.map.title, conditions: { equipment: 'Cast-iron pan; no oven.' }, upstreamResults: [] } });
    const handle = await store.startAttempt(created.mapPath, branch.id, 'snapshot-saved-synthesis');
    const draft = (await store.createResultDraft(created.mapPath, handle, 'Saved synthesis', MODEL, 'low', { kind: 'synthesis' })).draft;
    await store.commitResult(created.mapPath, handle, draft.id, { summary: 'Synthetic method summary.', detail: 'Use the saved safety report and user conditions.' });
    store.releaseAttempt(created.mapPath, handle);
    const saved = await repo.readMap(created.mapPath);
    const resultRef = saved.aim.branches.find(item => item.id === branch.id).results.find(item => item.kind === 'synthesis');
    const planner = new AimManualFlow(repo, store, async context => { note(context); return answer('How much hands-on guidance would you like?', 'Synthetic new question.', [{ title: 'Step-by-step' }, { title: 'Brief overview' }]); });
    await planner.planNextQuestion(created.mapPath, resultRef.nodeId, MODEL, 'low', 'snapshot-new-question', branch.id);
  }

  // 6. gap audit (both forms), user-condition correction, targeted follow-up and the second report review.
  {
    const { repo } = support.fixture(ui);
    const created = await createAimMap(repo, MODEL, { requestId: 'snapshot-range-map', topic: options.topic ?? 'Prepare a herb roast chicken', context: 'Synthetic range-answer scenario.' });
    let searches = 0, reviews = 0;
    const target = { title: 'Small-chicken herb butter recipe', task: 'Find a published recipe for a chicken below 1.5 kg with herb, garlic and butter quantities.', contribution: 'Verify published ingredient ratios for a small bird.' };
    const plan = ['recipe', 'method', 'doneness'].map(id => ({ id, title: id, task: `Find ${id} evidence.`, expectedValue: `Support ${id}.` }));
    const flow = new AimManualFlow(repo, new AimRunStore(repo), async context => {
      note(context);
      if (aimPhase(context, 'initial-question')) return answer('How much does the chicken weigh?', 'Choose a range.', [{ title: 'Below 1.5 kg' }, { title: 'Above 1.5 kg' }]);
      if (aimPhase(context, 'research-plan')) return answer('Plan', `<!-- aim-plan ${JSON.stringify({ subtopics: plan })} -->`);
      if (aimPhase(context, 'subtopic-research')) { searches++; return answer(`Saved evidence ${searches}`, `Research status: search completed\nSaved evidence ${searches}.`); }
      if (aimPhase(context, 'report-review')) {
        reviews++;
        if (reviews === 1) return plannerReview('research_more', { rationale: 'The exact weight is not known, and the small-bird recipe ratios still need a published source.' }, 'A conditional method is available.', 'Preserve the saved evidence.', [target]);
        return plannerReview('ask_user', { rationale: 'Oven mode changes the practical instructions.', question: 'Which oven mode will you use?' }, 'Recipe evidence now saved.', 'Keep all four reports.', ['Fan', 'Conventional']);
      }
      if (aimPhase(context, 'research-gap-audit')) return context.task.includes('TARGET-ONLY RECONCILIATION')
        ? answer('external_evidence', 'A published recipe for the supplied weight range is an external fact.')
        : answer('user_condition', 'The exact weight of this particular bird cannot be found online.');
      if (aimPhase(context, 'decision-quality-review')) return plannerReview('ask_user', { rationale: 'More precise weight is needed.', question: 'How much does the chicken weigh?' }, 'Conditional method.', 'Existing reports remain valid.', ['Below 1 kg', '1 to 1.2 kg', '1.2 to 1.5 kg']);
      if (aimPhase(context, 'targeted-followup-research')) { searches++; return answer('Published small-bird recipe found.', 'Research status: search completed\nPublished recipe quantities and limitations.'); }
      throw new Error(`Unexpected phase: ${context.task.slice(0, 150)}`);
    });
    const question = (await flow.planNextQuestion(created.mapPath, created.root.id, MODEL, 'low', 'snapshot-range-question')).node;
    const map = await repo.readMap(created.mapPath);
    const prior = await repo.createNote('Earlier condition', MODEL, map, created.mapPath, 'workspace');
    prior.aimKind = 'question'; map.nodes.push(prior);
    map.aim.branches.push({ id: 'range-prior', questionNodeId: prior.id, parentBranchId: null, answerSnapshot: { selections: [], freeText: 'Known' }, inputSnapshot: { topic: map.title, conditions: { flavor: 'Herbs' }, upstreamResults: [] }, createdAt: '2026-10-09T00:00:00.000Z', results: [] });
    map.nodes.find(item => item.id === question.id).aimQuestion.parentBranchId = 'range-prior';
    await repo.saveMap(created.mapPath, map);
    const result = await flow.answerAndResearch(created.mapPath, question.id, { requestId: 'snapshot-range-answer', selections: [question.aimQuestion.options[0].id], freeText: '' }, MODEL, 'low');
    assert.equal(result.status, 'waiting-user');
  }

  // 7. evidence-reuse-audit, update research and a rejected reuse (deterministic in-memory fixture).
  const stop = context => { if (pipeline.phaseOf(context) === 'report-review') throw new Error('STOP_AT_REVIEW'); throw new Error(`Unexpected phase ${pipeline.phaseOf(context)}`); };
  const runResume = async (subject, ask, method = 'resumeAnswerResearch') => {
    const flow = new pipeline.AimManualFlow(subject.repository, subject.store, async context => { note(context); return ask(context); });
    await assert.rejects(flow[method]('Map.md', 'current', 'test', 'low'), /STOP_AT_REVIEW/);
  };
  {
    const subject = pipeline.fixture(); await subject.setPlan([pipeline.reuseTarget(subject.source)]);
    await runResume(subject, context => pipeline.phaseOf(context) === 'evidence-reuse-audit' ? pipeline.usableAudit : stop(context));
  }
  {
    const subject = pipeline.fixture({ conditions: { weight: '2kg' } });
    await subject.setPlan([{ ...pipeline.reuseTarget(subject.source), action: 'update', task: 'Update cooking time for the changed 2kg weight only' }]);
    await runResume(subject, context => pipeline.phaseOf(context) === 'subtopic-research' ? pipeline.answer('Updated time', 'Research status: search completed\nAdjusted cooking time https://example.org/update') : stop(context));
  }
  {
    const subject = pipeline.fixture(); await subject.setPlan([pipeline.reuseTarget(subject.source)]);
    await runResume(subject, context => {
      if (pipeline.phaseOf(context) === 'evidence-reuse-audit') return pipeline.answer('Not reusable', '<!-- aim-reuse {"usable":false,"rationale":"Source is stale","conditionKeys":[],"validity":"New verification required"} -->');
      if (pipeline.phaseOf(context) === 'subtopic-research') return pipeline.answer('Fresh method', 'Research status: search completed\nFRESH_TARGET_EVIDENCE https://example.org/fresh');
      return stop(context);
    });
  }
  // 8. research-plan-repair: the first plan reply has no machine-readable marker.
  {
    const subject = pipeline.fixture({ ancestor: false, plan: undefined }); await subject.setPlan(undefined);
    let planCalls = 0;
    await runResume(subject, context => {
      const phase = pipeline.phaseOf(context);
      if (phase === 'research-plan' || phase === 'research-plan-repair') {
        planCalls++;
        return planCalls === 1 ? pipeline.answer('Plan', 'No marker here.') : pipeline.answer('Plan', '<!-- aim-plan {"subtopics":[{"id":"a","title":"A","task":"Find a.","expectedValue":"Resolve a."}]} -->');
      }
      if (phase === 'subtopic-research') return pipeline.answer('Found', 'Research status: search completed\nhttps://example.org/a');
      return stop(context);
    }, 'retryAnswerResearch');
  }

  // 9. planner-review.ts repair tasks, driven through the flow's own format-repair wrapper.
  {
    const flow = new AimManualFlow({ settings: { language: 'en' } }, {}, async context => {
      note(context);
      return plannerReview('ask_user', { rationale: 'Repaired rationale.', question: 'Which pace do you prefer?' }, 'Repaired summary', 'Repaired body', ['Relaxed pace', 'Fast pace']);
    });
    const recoveryContext = { question: 'Original goal', answerSnapshot: '{"conditions":{"weight":"1kg"}}', reportSummary: 'Saved report summary', reportDetail: 'Saved report detail' };
    const taskContext = { title: 'Original goal', summary: '', detail: 'Goal background', ancestors: '', task: 'Planner review task', outputLanguage: 'en', mode: 'task', researchMode: 'local', researchDepth: 'fast', visualMode: 'off', aimContract: { kind: 'review', decisions: ['research_more', 'ask_user', 'conclude'] } };
    // The canned reply may be rejected by the product's own checks; only the task sent through the seam matters here.
    const run = (original, context) => flow.parsePlannerReviewWithRecovery(original, context, taskContext, MODEL, 'low').catch(error => { if (process.env.AIM_CAPTURE_DEBUG) console.log('repair run rejected:', error.message); });
    const unmarked = { summary: 'Needs a clarification.', detail: 'Based on the saved reports, a simple approach is advisable.', suggestions: [{ title: '30 minutes', task: '', contribution: '' }] };
    const floor = { ...recoveryContext, requiredDecision: 'ask_user', requiredDecisionRationale: 'The branch has 1 answered question node(s); at least 3 are required before conclusion.' };
    await run(unmarked, floor);
    await run(unmarked, { ...floor, preferredQuestion: 'How much preparation time can you spend?' });
    await run({ summary: 'A choice is needed.', detail: '<!-- aim-review {"decision":"ask_user","rationale":"This preference changes the recommendation.","question":"Which pace do you prefer?"} -->\nThe supported answer is conditional.', suggestions: [] }, recoveryContext);
    const answeredWithoutTarget = { summary: 'The reports already answer the goal.', detail: '<!-- aim-review {"decision":"research_more","rationale":"The reports answer every core outcome; no evidence gap remains.","goalAnswered":true} -->\nSupported conditional answer.', suggestions: [] };
    await run(answeredWithoutTarget, recoveryContext);
    await run({ ...answeredWithoutTarget, detail: answeredWithoutTarget.detail.replace('"goalAnswered":true', '"goalAnswered":false') }, recoveryContext);
    await run({ summary: 'Draft', detail: 'No usable decision marker. Draft body.', suggestions: [] }, recoveryContext);
  }

  // 10. Evidence lookup: a report-review asks for the full text of a lineage report; the flow appends it and asks again.
  {
    let requested = false;
    const subject = withFlow(await setup(), context => {
      if (!aimPhase(context, 'report-review') || requested) return;
      const id = `${context.task}\n${context.detail}\n${context.ancestors}`.match(/Evidence ID: ([^\s]+)/)?.[1];
      if (!id) return;
      requested = true;
      return answer('Need the parent report details.', `<!-- aim-evidence-request {"ids":["${id}"]} -->`);
    });
    await support.coverageThreeAnswers(subject);
    assert.ok(requested, 'a report-review evidence lookup was driven');
  }

  // 11. A branch whose question node is the topic root (a persisted pre-question branch): research-plan and report-review.
  {
    const subject = pipeline.fixture({ ancestor: false, plan: undefined }); await subject.setPlan(undefined);
    const saved = subject.getMap(); saved.aim.branches[0].questionNodeId = 'topic'; await subject.repository.saveMap('Map.md', saved);
    await runResume(subject, context => {
      const phase = pipeline.phaseOf(context);
      if (phase === 'research-plan') return pipeline.answer('Plan', '<!-- aim-plan {"subtopics":[{"id":"a","title":"A","task":"Find a.","expectedValue":"Resolve a."}]} -->');
      if (phase === 'subtopic-research') return pipeline.answer('Found', 'Research status: search completed\nhttps://example.org/a');
      return stop(context);
    }, 'retryAnswerResearch');
  }

  // 12. Saved-report Planner review: research_more -> bounded follow-up search -> second review.
  {
    const { repo, mapPath, question, store } = await support.aimMapFixture();
    let map = await repo.readMap(mapPath);
    const questionNode = map.nodes.find(item => item.id === question.id);
    const search = SEARCH_TARGETS[options.topic];
    if (search) { questionNode.title = search.question; await repo.updateNote(questionNode.path, { title: search.question, summary: search.question }); }
    questionNode.aimKind = 'question';
    questionNode.aimQuestion = { requestId: 'snapshot-saved-report-question', parentBranchId: null, options: [{ id: 'a', label: search?.options[0] ?? 'Synthetic A' }, { id: 'b', label: search?.options[1] ?? 'Synthetic B' }], allowMultiple: false, allowFreeText: true };
    await repo.saveMap(mapPath, map);
    const branch = await store.createAnswerBranch(mapPath, { requestId: 'snapshot-saved-report-branch', questionNodeId: question.id, parentBranchId: null, answerSnapshot: { selections: [], freeText: search?.answer ?? 'Synthetic scenario only.' }, inputSnapshot: { topic: options.topic ?? 'Synthetic topic', conditions: { provenance: 'synthetic fixture' }, upstreamResults: [] } });
    const handle = await store.startAttempt(mapPath, branch.id, 'snapshot-saved-report-run', { model: MODEL, reasoning: 'low', maxResearchTurns: 2 });
    await store.recordResearchTurn(mapPath, handle);
    const draft = (await store.createResultDraft(mapPath, handle, 'Synthetic saved report', MODEL, 'low')).draft;
    await store.updateResultDraftReport(mapPath, handle, draft.id, 'Report 1: Synthetic report summary.', '## Searcher report 1\n\nResearch status: search completed\n\n### Findings\nPersisted report content; synthetic contract fixture only.');
    await store.recordSearchDiagnostic(mapPath, handle, { researchTurn: 1, startedEvents: 1, completedEvents: 1, completedSearchActions: 1, otherCompletedActions: 0 });
    await store.failAttempt(mapPath, handle, 'Synthetic contract fixture: Planner response was invalid.');
    const gap = search?.gap ?? { title: 'Option comparison', task: 'Find one published comparison of the two options.', contribution: 'Reduce uncertainty about the trade-off.' };
    let reviews = 0;
    const flow = new AimManualFlow(repo, store, async context => {
      note(context);
      if (aimPhase(context, 'research-gap-audit')) return support.researchGapAudit('external_evidence', search?.auditReason ?? 'A published comparison is an external fact.');
      if (context.researchMode === 'research') return answer('Comparison found.', 'Research status: search completed\nPublished comparison with limits.');
      reviews++;
      if (reviews === 1) return plannerReview('research_more', { rationale: search?.rationale ?? 'One published comparison could change the answer.' }, 'The saved report supports a conditional answer.', 'Keep the saved report.', [gap]);
      return plannerReview('ask_user', { rationale: 'The remaining preference changes the result.', question: 'Which option should the result prioritize?' }, 'Conditional answer.', 'Keep both reports.', ['Option A', 'Option B']);
    });
    await flow.reviewFailedAttemptReport(mapPath, 'snapshot-saved-report-run', draft.notePath);
    assert.equal(reviews, 2, 'the saved-report review ran two Planner turns around the follow-up search');
  }

  // 13. Partial continuation: bounded search, then the Planner review of all evidence. The second pass saves no Planner
  // review and no stop reason, so the search is sent without a target (the Planner's unresolved-gap fallback text).
  for (const withTarget of [true, false]) {
    const { repo } = support.fixture(ui);
    const search = SEARCH_TARGETS[options.topic];
    const created = await createAimMap(repo, MODEL, { requestId: 'snapshot-continuation-map', topic: options.topic ?? 'Synthetic roast chicken', context: 'Synthetic regression only.' });
    const store = new AimRunStore(repo);
    const planned = await new AimManualFlow(repo, store, async () => answer(search?.continuationQuestion ?? 'What serving time?', 'Synthetic question.', [{ title: 'Evening' }, { title: 'Lunch' }])).planNextQuestion(created.mapPath, created.root.id, MODEL, 'low', 'snapshot-continuation-question');
    const branch = await store.createAnswerBranch(created.mapPath, { requestId: 'snapshot-continuation-answer', questionNodeId: planned.node.id, parentBranchId: null, answerSnapshot: { selections: [], freeText: search?.answer ?? 'Synthetic constraints only.' }, inputSnapshot: { topic: options.topic ?? 'Synthetic roast chicken', conditions: { [search?.conditionKey ?? 'Serving time']: search?.condition ?? 'evening; synthetic' }, upstreamResults: [] } });
    const original = await store.startAttempt(created.mapPath, branch.id, 'snapshot-continuation-run', { model: MODEL, reasoning: 'low', maxResearchTurns: 2 });
    await store.recordResearchTurn(created.mapPath, original);
    const seedDraft = (await store.createResultDraft(created.mapPath, original, 'Earlier partial report', MODEL, 'low', { kind: 'synthesis' })).draft;
    const seedSummary = search?.summary ?? 'The saved research covers seasoning but needs a cooking-time source.';
    const seedDetail = search?.detail ?? 'Persisted summary: research supports seasoning options; a published cooking-time source is still missing.';
    await store.updateResultDraftReport(created.mapPath, original, seedDraft.id, seedSummary, seedDetail);
    if (withTarget) await store.recordPlannerReview(created.mapPath, original, { decision: 'research_more', rationale: search?.rationale ?? 'A published cooking-time source could materially improve the estimate.', researchTurn: 1, researchTarget: search?.target ?? { title: 'Cooking time source', task: 'Find a published cooking time for this setup.', expectedValue: 'Could improve the estimate.' } }, 'The saved research lacks a cooking-time source.');
    await store.commitResult(created.mapPath, original, seedDraft.id, { summary: seedSummary, detail: seedDetail }, 'partial');
    const continuation = new AimManualFlow(repo, store, async context => {
      note(context);
      if (aimPhase(context, 'research-gap-audit')) return support.researchGapAudit('external_evidence', search?.auditReason ?? 'A published cooking time is an external fact.');
      if (context.researchMode === 'research') return answer('Cooking time found.', 'Research status: search completed\nPublished cooking time with limits.');
      return plannerReview('ask_user', { rationale: 'The remaining serving preference changes the result.', question: 'How hands-on do you want the instructions?' }, 'Conditional answer.', 'Keep the saved evidence.', ['Step-by-step', 'Brief overview']);
    });
    const outcome = await continuation.continuePartial(created.mapPath, 'snapshot-continuation-run', MODEL, 'low');
    assert.equal(outcome.status, 'waiting-user');
  }

  const missing = EXPECTED.filter(name => !found.has(name));
  assert.deepEqual(missing, [], `AIM phase variants not captured: ${missing.join(', ')}`);
  assert.ok(!found.has('decision-quality-review-unclassified') && !found.has('format-repair-unclassified'), 'a captured repair/review task matched no known variant');
  return new Map([...found].filter(([name]) => EXPECTED.includes(name)));
}
module.exports = { captureAimPhaseVariants, EXPECTED };
