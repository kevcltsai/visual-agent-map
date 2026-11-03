// L1 coverage for the injectable AIM flow limits: the production defaults still enforce every gate, and the smoke
// limits (which only tests/smoke/build-smoke.mjs can put into a bundle) behave as documented without leaving a
// half-written attempt behind. Prompts and parsers are untouched by the limits; the prompt snapshots and
// tests/aim-fingerprints.cjs prove that separately.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { integrationTest, load, plain, plannerReview, aimPhase, coverageSetup, coverageThreeAnswers, obsidian, deliveryFixture } = require('../support.cjs');

const production = load('experiences/aim/flow-limits.ts');
const smoke = load('tests/smoke/flow-limits.smoke.ts');
const { AimManualFlow, MIN_ANSWERED_QUESTIONS_BEFORE_CONCLUSION } = load('experiences/aim/manual-flow.ts', { obsidian });
const { AimRunStore } = load('experiences/aim/research-run-store.ts');
const { parseAimPlannerReview, AIM_MAX_RESEARCH_TURNS } = load('experiences/aim/planner-review.ts');
const { floorDecisions } = load('experiences/aim/manual-flow-support.ts');
const { scheduleAimResearch } = load('experiences/aim/research-scheduler.ts');
const { buildFinalDelivery } = load('experiences/aim/final-delivery.ts');
const smokeLimits = plain(smoke.SMOKE_AIM_FLOW_LIMITS);
const reply = (summary, detail) => ({ summary, detail, suggestions: [], visualReferences: [] });
const tick = () => new Promise(resolve => setImmediate(resolve));
const target = (id) => ({ id, title: `Target ${id}`, task: `Find ${id}`, expectedValue: `Resolve ${id}`, action: 'research', dependsOn: [] });

integrationTest('AIM flow limits: production defaults equal the legacy values and the smoke module cannot shift derived constants', () => {
  assert.deepEqual(plain(production.DEFAULT_AIM_FLOW_LIMITS), { minAnsweredBeforeConclusion: 3, maxResearchTurns: 2, researchParallelism: 3, webSearch: true, acceptGapAtBudget: false, publishDeliveryAtBudget: false });
  assert.ok(Object.isFrozen(production.DEFAULT_AIM_FLOW_LIMITS));
  assert.equal(production.ACTIVE_AIM_FLOW_LIMITS, production.DEFAULT_AIM_FLOW_LIMITS, 'the flow uses the defaults unless a test injects limits');
  assert.equal(MIN_ANSWERED_QUESTIONS_BEFORE_CONCLUSION, 3);
  assert.equal(AIM_MAX_RESEARCH_TURNS, 2);
  assert.deepEqual(plain(smoke.DEFAULT_AIM_FLOW_LIMITS), plain(production.DEFAULT_AIM_FLOW_LIMITS), 'constants derived from the defaults stay identical in the smoke bundle');
  assert.deepEqual(smokeLimits, { minAnsweredBeforeConclusion: 1, maxResearchTurns: 2, researchParallelism: 1, webSearch: true, acceptGapAtBudget: true, publishDeliveryAtBudget: true });
  const shown = [];
  production.announceTestOverrides(message => shown.push(message));
  assert.deepEqual(shown, [], 'production announces nothing');
  smoke.announceTestOverrides(message => shown.push(message));
  assert.match(shown[0], /Test overrides active/);
  assert.match(shown[0], /profile=smoke/);
});

integrationTest('AIM flow limits: floorDecisions withholds conclude below the production floor of 3 and follows injected limits', () => {
  assert.deepEqual(plain(floorDecisions(0)), ['research_more', 'ask_user']);
  assert.deepEqual(plain(floorDecisions(2)), ['research_more', 'ask_user']);
  assert.deepEqual(plain(floorDecisions(3)), ['research_more', 'ask_user', 'conclude']);
  assert.deepEqual(plain(floorDecisions(2, production.DEFAULT_AIM_FLOW_LIMITS)), ['research_more', 'ask_user']);
  assert.deepEqual(plain(floorDecisions(1, smokeLimits)), ['research_more', 'ask_user', 'conclude']);
  assert.deepEqual(plain(floorDecisions(0, smokeLimits)), ['research_more', 'ask_user']);
});

async function qualityReview(limits, answered) {
  const calls = [];
  const flow = new AimManualFlow({ settings: { language: 'en' } }, {}, async context => {
    calls.push(context.task.match(/aim-phase:\s*([a-z-]+)/)?.[1]);
    if (aimPhase(context, 'delivery-outline')) throw new Error('STOP_AT_DELIVERY');
    if (aimPhase(context, 'decision-quality-review')) return reply('How much time can you spend?', 'A useful conditional answer remains available.');
    if (aimPhase(context, 'format-repair')) return plannerReview('ask_user', { rationale: 'Replaced.', question: 'Other?' }, 'Changed.', 'Changed.', ['Under an hour', 'One to two hours']);
    throw new Error(`Unexpected phase ${context.task.slice(0, 80)}`);
  }, undefined, undefined, limits);
  const context = { goal: 'Plan a routine', goalDetail: '', outputLanguage: 'en', conditions: {}, currentQuestion: 'Do you exercise?', currentAnswer: 'Sometimes', answeredQuestionCount: answered, questionHistory: ['Do you exercise?'], lineage: '', reportSummary: 'Saved.', reportDetail: 'Saved reports.' };
  const candidate = parseAimPlannerReview(plannerReview('conclude', { rationale: 'Sufficient.', stopReason: 'No gap.' }, 'Candidate.', 'Candidate answer.'));
  // A conclude that survives the floor goes on to final delivery; that first delivery call is where these tests stop.
  try { return { review: await flow.reviewPlannerDecisionQuality(candidate, context, 'gpt-6-luna', 'low'), calls }; }
  catch (error) { if (/STOP_AT_DELIVERY/.test(error.message)) return { review: { decision: 'conclude' }, calls }; throw error; }
}
integrationTest('AIM flow limits: the production flow still turns a conclude below three answers into ask_user', async () => {
  for (const limits of [undefined, production.DEFAULT_AIM_FLOW_LIMITS]) {
    const { review, calls } = await qualityReview(limits, 2);
    assert.equal(review.decision, 'ask_user');
    assert.equal(review.question, 'How much time can you spend?');
    assert.equal(review.rationale, 'The branch has 2 answered question node(s); at least 3 are required before conclusion.');
    assert.deepEqual(plain(calls.slice(0, 1)), ['decision-quality-review'], 'the bounded correction ran');
  }
  const atFloor = await qualityReview(undefined, 3);
  assert.equal(atFloor.review.decision, 'conclude');
  assert.deepEqual(atFloor.calls, ['delivery-outline'], 'three answers meet the floor, so no correction runs and delivery starts');
});
integrationTest('AIM flow limits: smoke limits let one answer conclude without a correction call', async () => {
  const { review, calls } = await qualityReview(smokeLimits, 1);
  assert.equal(review.decision, 'conclude');
  assert.deepEqual(calls, ['delivery-outline'], 'no correction call; the conclusion proceeds to delivery');
  const below = await qualityReview(smokeLimits, 0);
  assert.equal(below.review.decision, 'ask_user', 'the injected floor of one still withholds conclude with no answer');
});

integrationTest('AIM gap kind: a user_only gap becomes a question without the gap audit, and a not_decisive gap at the floor goes to delivery as an open item', async () => {
  const run = async (gapKind, answered) => {
    const calls = [], tasks = [];
    const flow = new AimManualFlow({ settings: { language: 'en' } }, {}, async context => {
      calls.push(context.task.match(/aim-phase:\s*([a-z-]+)/)?.[1]); tasks.push(context);
      if (aimPhase(context, 'delivery-outline')) throw new Error('STOP_AT_DELIVERY');
      if (aimPhase(context, 'decision-quality-review')) return plannerReview('ask_user', { rationale: 'Only you know this.', question: 'What does the offer letter say about backend work?' }, 'Conditional answer.', 'Saved reports stay valid.', ['Mostly backend', 'Not stated']);
      throw new Error(`Unexpected phase ${context.task.slice(0, 80)}`);
    });
    const context = { goal: 'Should I take the offer?', goalDetail: '', outputLanguage: 'en', conditions: {}, currentQuestion: 'What matters most?', currentAnswer: 'Backend work', answeredQuestionCount: answered, questionHistory: ['What matters most?'], lineage: '', reportSummary: 'Saved.', reportDetail: 'Saved reports.' };
    const raw = plannerReview('research_more', { rationale: 'The offer duties are unknown.' }, 'Interim.', 'Interim answer.', [{ title: 'Offer duties', task: 'Find the offer duties.', contribution: 'Shows whether the role is backend.' }]);
    const candidate = parseAimPlannerReview({ ...raw, detail: raw.detail.replace('"decision":"research_more"', `"decision":"research_more","gapKind":"${gapKind}"`) });
    assert.equal(candidate.gapKind, gapKind);
    try { return { review: await flow.reviewPlannerDecisionQuality(candidate, context, 'gpt-6-luna', 'low'), calls, tasks }; }
    catch (error) { if (/STOP_AT_DELIVERY/.test(error.message)) return { review: { decision: 'conclude' }, calls, tasks }; throw error; }
  };
  const userOnly = await run('user_only', 1);
  assert.equal(userOnly.review.decision, 'ask_user');
  assert.ok(!userOnly.calls.includes('research-gap-audit'), 'no gap audit call');
  const notDecisive = await run('not_decisive', 3);
  assert.equal(notDecisive.review.decision, 'conclude');
  assert.deepEqual(notDecisive.calls, ['delivery-outline']);
  assert.match(notDecisive.tasks[0].detail, /Offer duties/, 'the open item reaches the delivery context');
});
integrationTest('AIM checklist: after the intake, one answer may conclude, and a conclusion naming an unknown condition asks about it first', async () => {
  const run = async ({ detail, answered, unresolved, history = ['What matters most?'] }) => {
    const calls = [], tasks = [];
    const flow = new AimManualFlow({ settings: { language: 'en' } }, {}, async context => {
      calls.push(context.task.match(/aim-phase:\s*([a-z-]+)/)?.[1]); tasks.push(context);
      if (aimPhase(context, 'delivery-outline')) throw new Error('STOP_AT_DELIVERY');
      if (aimPhase(context, 'decision-quality-review')) return plannerReview('ask_user', { rationale: 'Unknown condition.', question: 'What is your budget?' }, 'Conditional answer.', 'Saved reports stay valid.', ['Under 1,000', 'Over 1,000']);
      throw new Error(`Unexpected phase ${context.task.slice(0, 80)}`);
    });
    const context = { goal: 'Choose a laptop', goalDetail: detail, outputLanguage: 'en', conditions: {}, currentQuestion: 'What matters most?', currentAnswer: 'Battery', answeredQuestionCount: answered, questionHistory: history, lineage: '', reportSummary: 'Saved.', reportDetail: 'Saved reports.' };
    const raw = plannerReview('conclude', { rationale: 'Sufficient.', stopReason: 'No gap.' }, 'Candidate.', 'Candidate answer.');
    const candidate = parseAimPlannerReview(unresolved ? { ...raw, detail: raw.detail.replace('"decision":"conclude"', `"decision":"conclude","unresolvedConditions":${JSON.stringify(unresolved)}`) } : raw);
    try { return { review: await flow.reviewPlannerDecisionQuality(candidate, context, 'gpt-6-luna', 'low'), calls, tasks }; }
    catch (error) { if (/STOP_AT_DELIVERY/.test(error.message)) return { review: { decision: 'conclude' }, calls, tasks }; throw error; }
  };
  const intake = 'Background.\n\n<!-- aim-intake-complete -->\n## Initial clarification\n\nBudget unknown.';
  assert.deepEqual((await run({ detail: intake, answered: 1 })).calls, ['delivery-outline'], 'the checklist floor lets one answer conclude');
  assert.equal((await run({ detail: 'Background.', answered: 1 })).review.decision, 'ask_user', 'without the intake the legacy floor still applies');
  const gated = await run({ detail: intake, answered: 1, unresolved: ['Budget'] });
  assert.equal(gated.review.decision, 'ask_user');
  assert.equal(gated.review.question, 'What is your budget?');
  const assumed = await run({ detail: intake, answered: 1, unresolved: ['Budget'], history: ['What matters most?', 'What is your budget?'] });
  assert.equal(assumed.review.decision, 'conclude', 'a condition the user was already asked about is kept as an assumption');
  assert.match(assumed.tasks.at(-1).detail, /Budget/, 'the assumption reaches the delivery as an open item');
  const limited = await run({ detail: intake, answered: 5, unresolved: ['Budget'] });
  assert.deepEqual(limited.calls, ['delivery-outline'], 'past the question limit an unknown condition is not asked again');
  assert.match(limited.tasks.at(-1).detail, /Budget/);
});
integrationTest('AIM checklist limit also covers questions made later in the review, and a not_decisive delivery rejection is delivered once more with the gap open', async () => {
  const intake = 'Background.\n\n<!-- aim-intake-complete -->';
  const context = (answered) => ({ goal: 'Buy a home?', goalDetail: intake, outputLanguage: 'en', conditions: {}, currentQuestion: 'Budget?', currentAnswer: 'Moderate', answeredQuestionCount: answered, questionHistory: ['Budget?'], lineage: '', reportSummary: 'Saved.', reportDetail: 'Saved reports.' });
  const withField = (raw, field) => ({ ...raw, detail: raw.detail.replace('"decision":"research_more"', `"decision":"research_more",${field}`) });
  // A legacy research_more without gapKind goes through the gap audit, which turns it into a user question.
  const calls = [];
  const flow = new AimManualFlow({ settings: { language: 'en' } }, {}, async ctx => {
    calls.push(ctx.task.match(/aim-phase:\s*([a-z-]+)/)?.[1]);
    if (aimPhase(ctx, 'research-gap-audit')) return reply('user_condition', 'Only the user knows the commute.');
    if (aimPhase(ctx, 'decision-quality-review')) return plannerReview('ask_user', { rationale: 'Commute unknown.', question: 'Where do you work?' }, 'Conditional.', 'Saved.', ['North', 'South']);
    if (aimPhase(ctx, 'delivery-outline')) throw new Error('STOP_AT_DELIVERY');
    throw new Error(`Unexpected phase ${ctx.task.slice(0, 80)}`);
  });
  const legacy = parseAimPlannerReview(plannerReview('research_more', { rationale: 'Commute unknown.' }, 'Interim.', 'Interim answer.', [{ title: 'Commute', task: 'Find the commute.', contribution: 'Changes the area.' }]));
  await assert.rejects(flow.reviewPlannerDecisionQuality(legacy, context(5), 'gpt-6-luna', 'low'), /STOP_AT_DELIVERY/, 'past the limit the question becomes a conclusion and goes to delivery');
  assert.deepEqual(calls.slice(-1), ['delivery-outline']);
  // The final delivery review says the remaining gap would not change the advice: one more delivery with it open.
  let acceptances = 0;
  const tasks = [];
  const deliver = new AimManualFlow({ settings: { language: 'en' } }, {}, async ctx => {
    tasks.push(ctx);
    if (aimPhase(ctx, 'delivery-acceptance')) {
      acceptances++;
      return acceptances === 1
        ? withField(plannerReview('research_more', { rationale: 'Exact fees would not change the advice.' }, 'Draft.', 'Draft.', [{ title: 'Exact closing fees', task: 'Find fees.', contribution: 'Precision.' }]), '"gapKind":"not_decisive"')
        : plannerReview('conclude', { rationale: 'Complete.', stopReason: 'Ready.' }, 'Complete document', 'Accepted.');
    }
    const fixture = deliveryFixture(ctx);
    if (fixture) return fixture;
    throw new Error(`Unexpected phase ${ctx.task.slice(0, 80)}`);
  });
  const conclude = parseAimPlannerReview(plannerReview('conclude', { rationale: 'Sufficient.', stopReason: 'No gap.' }, 'Candidate.', 'Candidate answer.'));
  const final = await deliver.reviewPlannerDecisionQuality(conclude, context(3), 'gpt-6-luna', 'low');
  assert.equal(final.decision, 'conclude');
  assert.equal(acceptances, 2);
  assert.match(tasks.filter(ctx => aimPhase(ctx, 'delivery-acceptance')).at(-1).task, /Exact closing fees/, 'the second acceptance knows the gap is an open item');
});
integrationTest('AIM unattended: after the intake it researches the goal without a Planner question and never stops to ask', async () => {
  const subject = await coverageSetup('Unattended run');
  const saved = await subject.repo.readMap(subject.created.mapPath);
  saved.aim.interaction = 'unattended';
  await subject.repo.saveMap(subject.created.mapPath, saved);
  const phases = [], contracts = [];
  const base = subject.model.ask;
  subject.flow = new AimManualFlow(subject.repo, new AimRunStore(subject.repo), async (context, ...rest) => {
    const phase = context.task.match(/aim-phase:\s*([a-z-]+)/)?.[1];
    phases.push(phase);
    if (aimPhase(context, 'report-review')) {
      contracts.push(context.aimContract?.decisions);
      return plannerReview('ask_user', { rationale: 'Budget would change the advice.', question: 'What is your budget?' }, 'Conditional answer.', 'Saved reports stay valid.', ['Low', 'High']);
    }
    return base(context, ...rest);
  });
  const progress = [];
  subject.flow.onProgress = event => { progress.push(event.kind === 'subtopic' ? `subtopic:${event.state}` : event.kind === 'stage' ? `stage:${event.stage}` : 'plan'); throw new Error('a broken listener must not stop research'); };
  const planned = await subject.flow.planNextQuestion(subject.created.mapPath, subject.created.root.id, 'gpt-6-luna', 'low', 'unattended-start');
  assert.equal(progress[0], 'stage:research-plan');
  assert.ok(progress.includes('plan') && progress.includes('subtopic:searching') && progress.includes('subtopic:done') && progress.includes('stage:report-review'), progress.join(','));
  assert.ok(progress.indexOf('plan') < progress.indexOf('subtopic:searching'), 'the plan is announced before any subtopic starts');
  assert.equal(planned.status, 'no-question', 'no Planner question is saved');
  assert.ok(!phases.includes('initial-question'), 'the first Planner question is skipped');
  assert.equal(phases[0], 'research-plan', 'research starts right away');
  assert.deepEqual(plain(contracts[0]), ['research_more', 'conclude'], 'the review schema cannot ask the user');
  assert.notEqual(planned.outcome.status, 'waiting-user', 'the run never stops for an answer');
  const notes = await Promise.all((await subject.repo.readMap(subject.created.mapPath)).nodes.map(node => subject.repo.readNote(node.path)));
  assert.ok(notes.some(note => /What is your budget\?/.test(note.detail)) || phases.includes('delivery-outline'), 'the question became an assumption carried into delivery');
  // The conclusion keeps its assumptions; correcting one researches again under the conclusion.
  const { readOpenItems } = load('experiences/aim/manual-flow.ts', { obsidian });
  const map = await subject.repo.readMap(subject.created.mapPath);
  const conclusionRef = map.aim.branches.flatMap(branch => branch.results).find(result => result.kind === 'conclusion');
  assert.ok(conclusionRef, 'an unattended run ends with a conclusion');
  const conclusion = await subject.repo.readNote(conclusionRef.notePath);
  assert.deepEqual(plain(readOpenItems(conclusion.detail)), ['What is your budget?']);
  phases.length = 0;
  const corrected = await subject.flow.correctAssumption(subject.created.mapPath, conclusionRef.nodeId, 'What is your budget?', 'About 1,500 a month', 'gpt-6-luna', 'low');
  assert.notEqual(corrected.status, 'stale');
  const after = await subject.repo.readMap(subject.created.mapPath);
  const question = after.nodes.find(node => node.aimKind === 'question' && node.parentId === conclusionRef.nodeId);
  assert.ok(question, 'the corrected assumption is saved as an answered question under the conclusion');
  assert.ok(phases.includes('research-plan'), 'the correction starts a new research round');
});
integrationTest('AIM unattended: a delivery rejection only the user can close keeps the delivered document and lists the gap instead of asking', async () => {
  const { readOpenItems, openItemsMarker } = load('experiences/aim/manual-flow.ts', { obsidian });
  const withField = (raw, field) => ({ ...raw, detail: raw.detail.replace(/"decision":"([a-z_]+)"/, `"decision":"$1",${field}`) });
  assert.deepEqual(plain(readOpenItems(`Doc\n${openItemsMarker(['A --> B'])}`)), ['A --> B']);
  assert.ok(!/A -->/.test(openItemsMarker(['A --> B'])), 'a title cannot end the hidden comment early');
  for (const gapKind of ['user_only', undefined]) {
    const phases = [];
    const flow = new AimManualFlow({ settings: { language: 'en' } }, {}, async ctx => {
      const phase = ctx.task.match(/aim-phase:\s*([a-z-]+)/)?.[1];
      phases.push(phase);
      if (aimPhase(ctx, 'delivery-acceptance')) {
        const gap = plannerReview('research_more', { rationale: 'Only the user knows the commute.' }, 'Delivered.', 'Delivered document.', [{ title: 'Commute', task: 'Ask the commute.', contribution: 'Changes the area.' }]);
        return gapKind ? withField(gap, `"gapKind":"${gapKind}"`) : gap;
      }
      if (aimPhase(ctx, 'research-gap-audit')) return reply('user_condition', 'Only the user knows the commute.');
      const fixture = deliveryFixture(ctx);
      if (fixture) return fixture;
      throw new Error(`Unexpected phase ${phase}`);
    });
    const context = { goal: 'Where should I live?', goalDetail: '', unattended: true, outputLanguage: 'en', conditions: {}, currentQuestion: '', currentAnswer: '', answeredQuestionCount: 0, questionHistory: [], lineage: '', reportSummary: 'Saved.', reportDetail: 'Saved reports.' };
    const candidate = { ...parseAimPlannerReview(plannerReview('conclude', { rationale: 'Sufficient.', stopReason: 'No gap.' }, 'Candidate.', 'Candidate answer.')), openItems: [{ title: 'Budget', task: 'Assumed.', expectedValue: 'Budget' }] };
    const final = await flow.reviewPlannerDecisionQuality(candidate, context, 'gpt-6-luna', 'low');
    assert.equal(final.decision, 'conclude', `gapKind=${gapKind}`);
    assert.deepEqual(plain(final.openItems.map(item => item.title)), ['Budget', 'Commute'], 'earlier assumptions and the new gap are both listed');
    assert.match(final.detail, /^> \[!warning\][^\n]*\n(?:>[^\n]*\n)*> - Commute$/m, 'the delivered document opens with a warning that lists the gap');
    assert.ok(!/Only the user knows the commute|Not yet verified/.test(final.detail), 'the reviewer rationale stays out of the document');
    assert.ok(!/Draft pending|Delivered document/.test(final.detail), 'the written document, not the rejection text');
    assert.ok(!phases.includes('decision-quality-review'), 'no question is written');
    assert.equal(phases.filter(phase => phase === 'delivery-acceptance').length, 1, 'the document is written once');
  }
});
integrationTest('AIM unattended: a legacy gap only the user can close, before any document, is delivered as an open item', async () => {
  const phases = [];
  const flow = new AimManualFlow({ settings: { language: 'en' } }, {}, async ctx => {
    phases.push(ctx.task.match(/aim-phase:\s*([a-z-]+)/)?.[1]);
    if (aimPhase(ctx, 'research-gap-audit')) return reply('user_condition', 'Only the user knows the commute.');
    if (aimPhase(ctx, 'delivery-acceptance')) return plannerReview('conclude', { rationale: 'Complete.', stopReason: 'Ready.' }, 'Complete document', 'Accepted.');
    const fixture = deliveryFixture(ctx);
    if (fixture) return fixture;
    throw new Error(`Unexpected phase ${phases.at(-1)}`);
  });
  const context = { goal: 'Where should I live?', goalDetail: '', unattended: true, outputLanguage: 'en', conditions: {}, currentQuestion: '', currentAnswer: '', answeredQuestionCount: 0, questionHistory: [], lineage: '', reportSummary: 'Saved.', reportDetail: 'Saved reports.' };
  const legacy = parseAimPlannerReview(plannerReview('research_more', { rationale: 'Commute unknown.' }, 'Interim.', 'Interim answer.', [{ title: 'Commute', task: 'Find the commute.', contribution: 'Changes the area.' }]));
  const final = await flow.reviewPlannerDecisionQuality(legacy, context, 'gpt-6-luna', 'low');
  assert.equal(final.decision, 'conclude');
  assert.ok(phases.includes('delivery-writing'), 'the document is written before it is published');
  assert.ok(!phases.includes('decision-quality-review'), 'no question is written');
  assert.ok(final.openItems.some(item => item.title === 'Commute'));
});
integrationTest('AIM: a targeted follow-up that finds nothing keeps the gap open and still delivers the document', async () => {
  const withField = (raw, field) => ({ ...raw, detail: raw.detail.replace(/"decision":"([a-z_]+)"/, `"decision":"$1",${field}`) });
  for (const failure of ['throw', 'empty']) {
    const subject = await coverageSetup(`Follow-up ${failure}`);
    const saved = await subject.repo.readMap(subject.created.mapPath);
    saved.aim.interaction = 'unattended';
    await subject.repo.saveMap(subject.created.mapPath, saved);
    const base = subject.model.ask;
    let reviews = 0;
    subject.flow = new AimManualFlow(subject.repo, new AimRunStore(subject.repo), async (context, ...rest) => {
      if (aimPhase(context, 'report-review') && ++reviews === 1)
        return withField(plannerReview('research_more', { rationale: 'Daily drive times are unverified.' }, 'Interim', 'Interim answer.', [{ title: 'Daily drive times', task: 'Verify drive times.', contribution: 'Sets the pace.' }]), '"gapKind":"searchable"');
      if (aimPhase(context, 'targeted-followup-research')) {
        if (failure === 'throw') throw new Error('Search did not perform web search.');
        return reply('Nothing', 'Research status: search failed');
      }
      return base(context, ...rest);
    });
    const planned = await subject.flow.planNextQuestion(subject.created.mapPath, subject.created.root.id, 'gpt-6-luna', 'low', `followup-${failure}`);
    assert.equal(planned.outcome.status, 'completed', failure);
    const map = await subject.repo.readMap(subject.created.mapPath);
    const conclusionRef = map.aim.branches.flatMap(branch => branch.results).find(result => result.kind === 'conclusion');
    assert.ok(conclusionRef, 'a conclusion is published');
    const { readOpenItems } = load('experiences/aim/manual-flow.ts', { obsidian });
    assert.ok(readOpenItems((await subject.repo.readNote(conclusionRef.notePath)).detail).includes('Daily drive times'), 'the unsearched gap is an open item');
  }
});
integrationTest('AIM steer: a new direction is a question titled by it, after the latest saved research, from the topic when nothing is saved yet', async () => {
  const subject = await coverageSetup('Steer');
  const saved = await subject.repo.readMap(subject.created.mapPath);
  saved.aim.interaction = 'unattended';
  await subject.repo.saveMap(subject.created.mapPath, saved);
  const phases = [];
  const base = subject.model.ask;
  subject.flow = new AimManualFlow(subject.repo, new AimRunStore(subject.repo), async (context, ...rest) => {
    phases.push(context.task.match(/aim-phase:\s*([a-z-]+)/)?.[1]);
    return base(context, ...rest);
  });
  const questionUnder = async parentId => {
    const map = await subject.repo.readMap(subject.created.mapPath);
    const node = map.nodes.filter(item => item.aimKind === 'question' && item.parentId === parentId).at(-1);
    return node && { node, note: await subject.repo.readNote(node.path), map };
  };
  // Nothing saved yet: the direction starts from the topic.
  const fromTopic = await subject.flow.steer(subject.created.mapPath, { nodeId: subject.created.root.id }, 'Focus on guesthouses', 'gpt-6-luna', 'low');
  assert.notEqual(fromTopic.status, 'stale');
  const first = await questionUnder(subject.created.root.id);
  assert.ok(first, 'the steer question hangs under the topic');
  assert.match(first.note.title, /Focus on guesthouses/, 'the question is titled by the new direction');
  assert.ok(phases.includes('research-plan'), 'the new direction is researched');
  // After a document: from the conclusion, which stays.
  const conclusion = first.map.aim.branches.flatMap(branch => branch.results).find(result => result.kind === 'conclusion');
  assert.ok(conclusion);
  await subject.flow.steer(subject.created.mapPath, { nodeId: conclusion.nodeId }, 'Only rural stays', 'gpt-6-luna', 'low');
  const second = await questionUnder(conclusion.nodeId);
  assert.ok(second && /Only rural stays/.test(second.note.title));
  assert.ok(second.map.nodes.some(node => node.id === conclusion.nodeId), 'the earlier document stays');
  // During a run, from its branch: after the latest saved result of that branch.
  const branch = second.map.aim.branches.find(item => item.results.some(result => result.nodeId === conclusion.nodeId));
  await subject.flow.steer(subject.created.mapPath, { nodeId: branch.questionNodeId, branchId: branch.id }, 'Near the coast', 'gpt-6-luna', 'low');
  const third = await questionUnder(branch.results.at(-1).nodeId);
  assert.ok(third && /Near the coast/.test(third.note.title), 'it continues after the latest saved result of that run');
});
integrationTest('AIM reuse: saved research from another answer to the same question is offered after the lineage, newest first and capped', async () => {
  const research = (branch, n) => ({ resultId: `${branch}-r${n}`, nodeId: `${branch}-n${n}`, notePath: `${branch}-${n}.md`, version: 1, kind: 'research' });
  const branch = (id, parentBranchId, results) => ({ id, parentBranchId, questionNodeId: 'q', results, inputSnapshot: { topic: 'Trip', conditions: { answer: id }, upstreamResults: [] }, answerSnapshot: { selections: [], freeText: '' } });
  const root = branch('root', null, [research('root', 1)]);
  const siblings = Array.from({ length: 4 }, (_, i) => branch(`sib${i}`, 'root', [research(`sib${i}`, 1), research(`sib${i}`, 2)]));
  const current = branch('current', 'root', []);
  const map = { aim: { branches: [root, ...siblings, current] }, nodes: [root, ...siblings].flatMap(item => item.results).map(result => ({ id: result.nodeId, path: result.notePath, aimKind: 'research' })) };
  const repo = { settings: { language: 'en' }, readNote: async path => ({ title: `Transport ${path}`, summary: 'Rail and bus times.', detail: 'Research status: search completed\nhttps://example.org/transport' }) };
  const flow = new AimManualFlow(repo, {}, async () => { throw new Error('no model call'); });
  const candidates = await flow.reusableResearchCandidates(map, current);
  assert.equal(candidates[0].source.branchId, 'root', 'the lineage comes first');
  assert.equal(candidates[1].source.branchId, 'sib3', 'then the newest other route');
  assert.deepEqual(plain(candidates[1].conditions), { answer: 'sib3' }, 'its own conditions go to the applicability audit');
  assert.equal(candidates.length, 1 + 6, 'other routes are capped');
  assert.ok(!candidates.some(item => item.source.branchId === 'current'));
});
const gapTarget = { title: 'Missing evidence', task: 'Search for the missing evidence.', contribution: 'Closes the gap.' };
/** A Planner that always wants more research, so the flow must end through the research-budget exit. */
function gapModel(base, seen) {
  return async (context, ...rest) => {
    const phase = context.task.match(/aim-phase:\s*([a-z-]+)/)?.[1];
    seen?.push({ phase, researchMode: context.researchMode });
    if (aimPhase(context, 'report-review')) return plannerReview('research_more', { rationale: 'Evidence is still missing.' }, 'Partial', 'Detail.', [gapTarget]);
    if (aimPhase(context, 'research-gap-audit')) return reply('external_evidence', 'An external fact is missing.');
    if (aimPhase(context, 'decision-quality-review')) return plannerReview('ask_user', { rationale: 'A decision-changing condition is unknown.', question: 'Which budget range fits you?' }, 'Conditional answer', 'Existing reports remain valid.', ['Low budget', 'High budget']);
    if (aimPhase(context, 'targeted-followup-research')) return reply('Follow-up', `Research status: search completed\nMore evidence ${'https://example.org/more'}`);
    if (context.aimContract?.kind === 'review' && !aimPhase(context, 'decision-quality-review') && !aimPhase(context, 'saved-evidence-review')) return plannerReview('research_more', { rationale: 'Evidence is still missing.' }, 'Partial', 'Detail.', [gapTarget]);
    return base(context, ...rest);
  };
}
async function runOneAnswer(limits, seen) {
  const subject = await coverageSetup(`Limits ${limits ? 'smoke' : 'production'}`);
  subject.flow = new AimManualFlow(subject.repo, new AimRunStore(subject.repo), gapModel(subject.model.ask, seen), undefined, undefined, limits);
  const question = (await subject.flow.planNextQuestion(subject.created.mapPath, subject.created.root.id, 'gpt-6-luna', 'low', 'limits-question')).node;
  const outcome = await subject.flow.answerAndResearch(subject.created.mapPath, question.id, { requestId: 'limits-answer', selections: [question.aimQuestion.options[0].id], freeText: 'Specific condition' }, 'gpt-6-luna', 'low');
  const saved = await subject.repo.readMap(subject.created.mapPath);
  const results = saved.aim.branches.flatMap(branch => branch.results);
  const notes = await Promise.all(results.map(result => subject.repo.readNote(result.notePath)));
  return { outcome, saved, results, notes, attempts: saved.aim.runs.flatMap(run => run.attempts), seen };
}
integrationTest('AIM flow limits: with production limits a research_more left at the second turn becomes the next question below the floor, not a partial stop', async () => {
  for (const limits of [undefined, production.DEFAULT_AIM_FLOW_LIMITS]) {
    const seen = [];
    const { outcome, attempts } = await runOneAnswer(limits, seen);
    assert.equal(outcome.status, 'waiting-user');
    assert.ok(!attempts.some(attempt => attempt.status === 'partial'), 'no attempt is saved partial');
    assert.equal(seen.filter(item => item.phase === 'targeted-followup-research').length, 1, 'exactly one bounded follow-up search before the budget ends');
  }
});
integrationTest('AIM flow limits: with smoke limits the Planner\'s own research_more at the budget is accepted as a synthesis, never published as a conclusion', async () => {
  const seen = [];
  const { outcome, attempts, results, notes } = await runOneAnswer(smokeLimits, seen);
  assert.equal(outcome.status, 'completed');
  assert.ok(!results.some(result => result.kind === 'conclusion'), 'no conclusion node');
  assert.ok(results.some(result => result.kind === 'synthesis'));
  assert.ok(!notes.some(note => /profile=smoke/.test(note.detail)), 'no smoke publication label');
  assert.ok(!seen.some(item => item.phase === 'delivery-acceptance'), 'no delivery was written or accepted');
  assert.ok(attempts.length >= 1 && attempts.every(attempt => attempt.status === 'completed'), `every attempt completed: ${attempts.map(attempt => attempt.status)}`);
  assert.ok(!attempts.some(attempt => ['running', 'saving'].includes(attempt.status)), 'no in-progress attempt is left behind');
  assert.equal(seen.filter(item => item.phase === 'targeted-followup-research').length, 1, 'the research budget (two turns) is unchanged');
});

integrationTest('AIM flow limits: the scheduler runs three independent tasks at once by default and an injected value caps it', async () => {
  const peak = async options => {
    let active = 0, max = 0;
    await scheduleAimResearch([target('a'), target('b'), target('c'), target('d')], async item => { max = Math.max(max, ++active); await tick(); await tick(); active--; return item.id; }, undefined, options);
    return max;
  };
  assert.equal(await peak(undefined), 3);
  assert.equal(await peak({}), 3);
  assert.equal(await peak({ parallelism: 1 }), 1);
  assert.equal(await peak({ parallelism: 2 }), 2);
});
integrationTest('AIM flow limits: the flow researches three subtopics in parallel by default, all of them finish, and one at a time under smoke limits', async () => {
  for (const [limits, expected] of [[undefined, 3], [smokeLimits, 1]]) {
    const subject = await coverageSetup(`Parallel ${expected}`);
    let active = 0, max = 0;
    const base = subject.model.ask;
    subject.flow = new AimManualFlow(subject.repo, new AimRunStore(subject.repo), async (context, ...rest) => {
      if (aimPhase(context, 'research-plan')) return reply('Three independent dimensions.', '<!-- aim-plan {"subtopics":[{"id":"method","title":"Method","task":"Research methods.","expectedValue":"Compare methods.","action":"research","dependsOn":[]},{"id":"constraints","title":"Constraints","task":"Research constraints.","expectedValue":"Find limits.","action":"research","dependsOn":[]},{"id":"costs","title":"Costs","task":"Research costs.","expectedValue":"Compare costs.","action":"research","dependsOn":[]}]} -->');
      if (aimPhase(context, 'subtopic-research')) { max = Math.max(max, ++active); await tick(); await tick(); active--; }
      return base(context, ...rest);
    }, undefined, undefined, limits);
    const question = (await subject.flow.planNextQuestion(subject.created.mapPath, subject.created.root.id, 'gpt-6-luna', 'low', 'parallel-question')).node;
    const outcome = await subject.flow.answerAndResearch(subject.created.mapPath, question.id, { requestId: 'parallel-answer', selections: [question.aimQuestion.options[0].id], freeText: 'Condition' }, 'gpt-6-luna', 'low');
    assert.equal(max, expected);
    assert.notEqual(outcome.status, 'in-progress', 'the run store admits every parallel subtopic');
  }
});

integrationTest('AIM flow limits: web search stays on by default and an injected off switches research phases to local mode', async () => {
  const modes = async limits => {
    const seen = [];
    const subject = await coverageSetup(`Search ${limits ? 'off' : 'on'}`);
    const base = subject.model.ask;
    subject.flow = new AimManualFlow(subject.repo, new AimRunStore(subject.repo), async context => {
      seen.push({ phase: context.task.match(/aim-phase:\s*([a-z-]+)/)?.[1], researchMode: context.researchMode });
      return base({ ...context, researchMode: context.researchMode === 'local' && aimPhase(context, 'subtopic-research') ? 'research' : context.researchMode });
    }, undefined, undefined, limits);
    const question = (await subject.flow.planNextQuestion(subject.created.mapPath, subject.created.root.id, 'gpt-6-luna', 'low', 'search-question')).node;
    await subject.flow.answerAndResearch(subject.created.mapPath, question.id, { requestId: 'search-answer', selections: [question.aimQuestion.options[0].id], freeText: 'Condition' }, 'gpt-6-luna', 'low');
    return seen.filter(item => item.phase === 'subtopic-research').map(item => item.researchMode);
  };
  assert.deepEqual([...new Set(await modes(undefined))], ['research']);
  assert.deepEqual([...new Set(await modes({ ...production.DEFAULT_AIM_FLOW_LIMITS, webSearch: false }))], ['local']);
});
integrationTest('AIM flow limits: final delivery research uses web search unless a test turns it off, and its acceptance check is unchanged', async () => {
  const base = { title: 'Goal', detail: 'Known conditions and prior reports', signal: new AbortController().signal };
  const outline = '<!-- aim-delivery-outline {"sections":[{"heading":"Steps","purpose":"Execute the goal","searchTask":"Find concrete examples"}]} -->';
  const run = async options => {
    const modes = [];
    const outputs = [outline, '<!-- aim-delivery-research {"status":"searched"} -->\nSource: https://example.org/docs', 'Complete actionable document', '<!-- aim-review {"decision":"conclude","rationale":"Complete","stopReason":"All sections usable"} -->\nComplete actionable document'];
    await buildFinalDelivery(base, async context => { modes.push(`${context.task.match(/aim-phase:\s*([a-z-]+)/)?.[1]}:${context.researchMode}`); return reply('Preview', outputs[modes.length - 1]); }, options);
    return modes;
  };
  assert.deepEqual(await run({}), ['delivery-outline:local', 'delivery-research:research', 'delivery-writing:local', 'delivery-acceptance:local']);
  assert.deepEqual(await run({ webSearch: false }), ['delivery-outline:local', 'delivery-research:local', 'delivery-writing:local', 'delivery-acceptance:local']);
  await assert.rejects(() => buildFinalDelivery(base, async context => reply('Preview', aimPhase(context, 'delivery-outline') ? outline : 'No search happened'), { webSearch: false }), /unavailable or not completed/);
});

integrationTest('AIM flow limits: the smoke bundle is built outside the repository and the production bundle carries no smoke marker', async () => {
  const { buildSmoke } = await import('../smoke/build-smoke.mjs');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'vam-smoke-build-'));
  try {
    const result = await buildSmoke({ out, webSearch: false });
    const bundle = fs.readFileSync(path.join(out, 'main.js'), 'utf8');
    assert.match(bundle, /VAM_SMOKE_PROFILE_ACTIVE/);
    assert.match(bundle, /Test overrides active/);
    assert.equal(result.profile, 'smoke');
    assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'smoke-profile.json'), 'utf8')).webSearch, false);
    assert.match(bundle, /acceptGapAtBudget: true/);
    assert.match(bundle, /researchParallelism: 1/);
    await assert.rejects(() => buildSmoke({ out: path.join(path.resolve(__dirname, '..', '..'), 'tests', 'smoke-output-must-not-exist') }), /outside the repository/);
    assert.ok(!fs.existsSync(path.join(path.resolve(__dirname, '..', '..'), 'tests', 'smoke-output-must-not-exist', 'main.js')));
  } finally { fs.rmSync(out, { recursive: true, force: true }); fs.rmSync(path.join(path.resolve(__dirname, '..', '..'), 'tests', 'smoke-output-must-not-exist'), { recursive: true, force: true }); }
  const productionBundle = fs.readFileSync(path.join(__dirname, '..', '..', 'main.js'), 'utf8');
  for (const marker of ['VAM_SMOKE_PROFILE_ACTIVE', 'Test overrides active', 'flow-limits.smoke']) assert.ok(!productionBundle.includes(marker), `production main.js must not contain ${marker}`);
});

/** Final delivery acceptance keeps asking for more research, so the flow ends through the delivery-acceptance budget exit. */
async function deliveryRejected(limits) {
  const smoked = limits?.minAnsweredBeforeConclusion === 1;
  const subject = await coverageSetup(`Delivery rejected ${smoked ? 'smoke' : 'production'}`);
  const base = subject.model.ask, phases = [];
  subject.flow = new AimManualFlow(subject.repo, new AimRunStore(subject.repo), async (context, ...rest) => {
    phases.push(context.task.match(/aim-phase:\s*([a-z-]+)/)?.[1]);
    if (aimPhase(context, 'research-gap-audit')) return reply('external_evidence', 'An external fact is missing.');
    if (smoked && aimPhase(context, 'report-review')) return plannerReview('conclude', { rationale: 'One answer meets the injected floor.', stopReason: 'Ready for delivery stages.' }, 'Candidate document', 'Candidate document');
    if (aimPhase(context, 'delivery-acceptance')) {
      const rejected = plannerReview('research_more', { rationale: 'A cited claim does not match its source.' }, 'Rejected draft', 'Draft pending completion', [{ title: 'Verify claim', task: 'Find a source for the claim.', contribution: 'Resolve the mismatch.' }]);
      return rejected;
    }
    return base(context, ...rest);
  }, undefined, undefined, limits);
  const outcome = smoked
    ? await (async () => {
        const question = (await subject.flow.planNextQuestion(subject.created.mapPath, subject.created.root.id, 'gpt-6-luna', 'low', 'rejected-question')).node;
        return subject.flow.answerAndResearch(subject.created.mapPath, question.id, { requestId: 'rejected-answer', selections: [question.aimQuestion.options[0].id], freeText: 'Condition' }, 'gpt-6-luna', 'low');
      })()
    : await coverageThreeAnswers(subject);
  const saved = await subject.repo.readMap(subject.created.mapPath);
  const results = saved.aim.branches.flatMap(branch => branch.results);
  const notes = await Promise.all(results.map(async result => ({ result, note: await subject.repo.readNote(result.notePath) })));
  assert.ok(phases.includes('delivery-acceptance'), 'the scenario reached final delivery acceptance');
  return { outcome, saved, results, notes, attempts: saved.aim.runs.flatMap(run => run.attempts) };
}
integrationTest('AIM flow limits: with production limits a rejected final delivery at the budget publishes the written document with the gap stated and open', async () => {
  // Reviewer findings can name evidence IDs; none reaches the document.
  const { readOpenItems } = load('experiences/aim/manual-flow.ts', { obsidian });
  for (const limits of [undefined, production.DEFAULT_AIM_FLOW_LIMITS]) {
    const { outcome, results, notes, attempts } = await deliveryRejected(limits);
    assert.equal(outcome.status, 'completed');
    assert.equal(results.filter(result => result.kind === 'conclusion').length, 1, 'one conclusion is published');
    const conclusion = notes.find(item => item.result.kind === 'conclusion').note;
    assert.match(conclusion.detail, /^> \[!warning\]/, 'the rejected document opens with a warning');
    assert.match(conclusion.detail, /^> - Verify claim$/m, 'the warning lists what to fix');
    assert.ok(!/A cited claim does not match its source|Not yet verified/.test(conclusion.detail), 'the reviewer rationale stays out of the document');
    assert.ok(!/Draft pending completion/.test(conclusion.detail), 'the written document, not the pending draft wrapper');
    assert.ok(readOpenItems(conclusion.detail).includes('Verify claim'), 'the gap is an open item');
    assert.ok(!notes.some(item => /profile=smoke/.test(item.note.detail)), 'production notes never carry the smoke label');
    assert.ok(!attempts.some(attempt => attempt.status === 'partial'), 'no attempt is left partial');
  }
});
integrationTest('AIM flow limits: with smoke limits a rejected final delivery at the budget is published as a labelled conclusion that keeps the rejection reason', async () => {
  const { outcome, results, notes, attempts } = await deliveryRejected(smokeLimits);
  assert.equal(outcome.status, 'completed');
  const conclusion = notes.find(item => item.result.kind === 'conclusion');
  assert.ok(conclusion, 'a conclusion note is published through the normal commit path');
  assert.match(conclusion.note.detail, /profile=smoke/);
  assert.match(conclusion.note.detail, /A cited claim does not match its source\./);
  assert.ok(attempts.length >= 1 && attempts.every(attempt => attempt.status === 'completed'), `every attempt completed: ${attempts.map(attempt => attempt.status)}`);
  assert.ok(!attempts.some(attempt => ['running', 'saving'].includes(attempt.status)));
  assert.equal(results.filter(result => result.kind === 'conclusion').length, 1);
});

integrationTest('AIM tone: the map tone is no longer read, only the final written document carries the AIM note style tone, and no style leaves every context untouched', async () => {
  // Rewritten from "AIM tone: research calls carry the map tone, structured Planner calls never do, and no tone leaves
  // every context untouched" (grilling Q15/Q16, decisions #8 OQ11): the map tone stops applying to AIM (Q15, C5); the tone
  // of the user's AIM note style applies to the final conclusion Detail only (Q16, OQ11).
  const style = { recipe: { ref: 'file:Plain', name: 'Plain', source: 'kind' }, template: { id: 'p', name: 'Plain', sections: [{ id: 'a', name: 'Answer', description: 'The answer.', role: 'none', aliases: [] }] }, formatText: '', toneText: 'Write in plain words.', contextFields: { styleSelection: { template: { id: 'p' }, tone: {}, format: { id: 'lean' } } } };
  const run = async (toneId, noteStyle) => {
    const seen = [];
    const subject = await coverageSetup(`Tone ${toneId ?? 'none'} ${noteStyle ? 'styled' : 'plain'}`);
    if (toneId) { const doc = await subject.repo.readMap(subject.created.mapPath); doc.toneId = toneId; await subject.repo.saveMap(subject.created.mapPath, doc); }
    const base = subject.model.ask;
    subject.flow = new AimManualFlow(subject.repo, new AimRunStore(subject.repo), async (context, ...rest) => {
      seen.push({ phase: aimPhase(context, 'subtopic-research') ? 'research' : aimPhase(context, 'delivery-writing') ? 'writing' : 'other', structured: !!context.aimContract, hasTone: 'toneText' in context, toneText: context.toneText });
      return base(context, ...rest);
    });
    if (noteStyle) subject.flow.noteStyle = () => noteStyle;
    await coverageThreeAnswers(subject);
    return seen;
  };
  const mapTone = await run('plain');
  assert.ok(mapTone.some(item => item.phase === 'research'), 'the scenario ran research');
  assert.ok(!mapTone.some(item => item.hasTone), 'the map tone is not read: no context has the key (Q15)');
  const styled = await run('plain', style);
  const writing = styled.filter(item => item.phase === 'writing');
  assert.ok(writing.length > 0 && writing.every(item => item.hasTone && item.toneText === 'Write in plain words.'), 'only the final written document gets the style tone (Q16)');
  assert.ok(styled.filter(item => item.phase === 'research').every(item => !item.hasTone), 'research calls carry no tone (OQ11)');
  assert.ok(styled.filter(item => item.structured).every(item => !item.hasTone), 'contract calls never carry the tone');
  assert.ok(!(await run(undefined)).some(item => item.hasTone), 'no port: no context has the key');
});
