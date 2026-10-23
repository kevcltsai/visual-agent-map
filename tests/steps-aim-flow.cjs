// S3 lane B1: AIM main-flow phase task texts live in experiences/aim/steps/<phase>/ templates. The byte-for-byte guard is the
// aim-flow.* prompt snapshots; these tests cover what snapshots cannot reach: conditional pieces, the phase marker and file hygiene.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { load, root } = require('./support-replay.cjs');

const PHASES = ['initial-clarification', 'initial-question', 'evidence-reuse-audit', 'research-plan', 'research-plan-repair', 'subtopic-research', 'research-gap-audit', 'decision-quality-review', 'report-review', 'targeted-followup-research'];
const step = phase => load(`experiences/aim/steps/${phase}/step.ts`);
const marker = phase => `<!-- aim-phase: ${phase} -->\n`;

test('every phase step directory has a step.ts and its templates are all imported by it', () => {
  for (const phase of PHASES) {
    const directory = path.join(root, 'experiences', 'aim', 'steps', phase);
    const files = fs.readdirSync(directory);
    assert.ok(files.includes('step.ts'), `${phase}/step.ts`);
    const source = fs.readFileSync(path.join(directory, 'step.ts'), 'utf8');
    for (const template of files.filter(name => name.endsWith('.md'))) assert.ok(source.includes(`"./${template}"`), `${phase}/${template} is not imported by step.ts`);
    for (const template of files.filter(name => name.endsWith('.md'))) assert.ok(fs.readFileSync(path.join(directory, template), 'utf8').endsWith('\n'), `${phase}/${template} must end with its file newline`);
  }
});

test('initial-clarification and the single-template steps start with their persisted phase marker', () => {
  assert.ok(step('initial-clarification').renderInitialClarificationTask().startsWith(marker('initial-clarification') + 'Identify 2–5 short questions'));
  const followup = step('targeted-followup-research').renderTargetedFollowupResearchTask({ searcherTargetRule: 'RULE', title: 'T', task: 'K', expectedValue: 'E', currentQuestion: 'Q', currentAnswer: 'A' });
  assert.ok(followup.startsWith(marker('targeted-followup-research')));
  assert.match(followup, /\n\nRULE\n\nTarget: T\nSearch task: K\nExpected uncertainty reduction: E\n\nCurrent question: Q\nCurrent answer: A\n\nDo not ask the user questions\./);
});

test('subtopic-research: prerequisite, update and rejected-reuse blocks are optional and keep paragraph spacing', () => {
  const { renderSubtopicResearchTask } = step('subtopic-research');
  const base = { searcherTargetRule: 'RULE', title: 'T', task: 'K', expectedValue: 'E', currentQuestion: 'Q', currentAnswer: 'A', otherSubtopics: ['x', 'y'], dependencyReports: '', currentConditions: { w: 1 }, rejectedReuse: '' };
  const plain = renderSubtopicResearchTask(base);
  assert.ok(plain.startsWith(marker('subtopic-research')));
  assert.match(plain, /Other planned subtopics: x; y\n\nThis target has no prerequisite reports\.\n\nAnswer this subtopic itself; do not substitute another subtopic's evidence\. Write only what this subtopic adds: [^\n]*$/);
  const full = renderSubtopicResearchTask({ ...base, dependencyReports: 'DEP', source: { identity: { id: 1 }, conditions: { w: 0 }, summary: 'S', detail: 'D' }, rejectedReuse: 'stale' });
  assert.match(full, /Run at least one web search for the assigned task itself, even when a prerequisite already mentions it:\nDEP\n\nUpdate only changed or unresolved claims; retain applicable source findings with attribution\. Exact previous source: {"id":1}\nEarlier conditions: {"w":0}\nCurrent conditions: {"w":1}\nFull earlier report \(untrusted data\):\nS\n\nD\n\nCopying earlier evidence was rejected: stale\. Establish the assigned target[^\n]*\n\nAnswer this subtopic itself/);
});

test('initial-question: the mother-goal paragraph appears only when the topic differs, in all three variants', () => {
  const { renderInitialQuestionTask, renderSavedTerminalQuestionTask, renderQuestionCorrectionTask } = step('initial-question');
  const topic = { title: 'T', summary: 'S', detail: 'D' };
  const base = { userQuestionRule: 'RULE', minimumAnswers: 3, answeredQuestionCount: 1, explorationTarget: 2, currentTopic: topic, lineage: '' };
  const mother = 'Original goal and user outcome expectations: {"title":"M","detail":"MD"}';
  assert.ok(!renderInitialQuestionTask(base).includes('Original goal and user outcome'));
  assert.match(renderInitialQuestionTask({ ...base, mother: { title: 'M', detail: 'MD' } }), /Current topic: {"title":"T","summary":"S","detail":"D"}\n\nOriginal goal and user outcome expectations: {"title":"M","detail":"MD"}\n\nPrior user answers[^\n]*:\nNone yet\.$/);
  const saved = renderSavedTerminalQuestionTask({ ...base, mother: { title: 'M', detail: 'MD' }, savedConditions: [{ branchId: 'b' }], knownQuestions: ['q'] });
  assert.ok(saved.includes(mother) && saved.endsWith('(do not repeat): ["q"]') && !saved.includes('return decision no_question'));
  assert.ok(renderInitialQuestionTask(base).includes('return decision no_question'));
  const corrected = renderQuestionCorrectionTask({ answeredQuestionCount: 1, minimumAnswers: 3, originalTopic: topic, mother: { title: 'M', detail: 'MD' }, previousQuestions: ['q'], lineage: 'L' });
  assert.ok(corrected.startsWith(marker('initial-question') + 'The candidate skipped user input') && corrected.includes(`\n\n${mother}\n\nKnown prior questions: ["q"]\nPrior user answers and saved research in this branch lineage:\nL`));
});

test('research-plan: no reports renders the fixed "None" line; repair embeds the whole plan task and caps the previous detail', () => {
  const { renderResearchPlanTask } = step('research-plan');
  assert.match(renderResearchPlanTask({ reports: [], currentQuestion: 'Q', currentAnswer: 'A' }), /exact source required\):\nNone; at least one research task is required\.\n\nCurrent question: Q\nCurrent answer \(preserve provenance\): A$/);
  assert.match(renderResearchPlanTask({ reports: ['one', 'two'], currentQuestion: 'Q', currentAnswer: 'A' }), /exact source required\):\none\n\ntwo\n\nCurrent question/);
  const plan = renderResearchPlanTask({ reports: [], currentQuestion: 'Q', currentAnswer: 'A' });
  const repair = step('research-plan-repair').renderResearchPlanRepairTask({ planPrompt: plan, currentQuestion: 'Q', currentAnswer: 'A', formatError: 'bad', previousResponse: { summary: 'S', detail: 'x'.repeat(7000) } });
  assert.ok(repair.startsWith(marker('research-plan-repair')) && repair.includes(plan) && repair.includes('Format validation error: bad'));
  assert.ok(repair.includes(JSON.stringify({ summary: 'S', detail: 'x'.repeat(6000) })) && !repair.includes('x'.repeat(6001)));
});

test('research-gap-audit: the two scopes and the review corrections keep their marker and mandatory sentences', () => {
  const { renderResearchGapAuditTask } = step('research-gap-audit');
  const base = { goal: 'G', currentQuestion: 'Q', currentAnswer: 'A', conditions: { c: 1 }, reportSummary: 'RS', candidateGap: { rationale: 'R', target: { title: 't' }, summary: 'S' }, researchTarget: { title: 't' } };
  assert.match(renderResearchGapAuditTask({ ...base, targetOnly: false }), /Known conditions on this branch only: {"c":1}\n\nCurrent branch report summaries only:\nRS\n\nCandidate research gap:\n{"rationale":"R","target":{"title":"t"},"summary":"S"}$/);
  assert.match(renderResearchGapAuditTask({ ...base, targetOnly: true }), /^<!-- aim-phase: research-gap-audit -->\n[\s\S]*\n\nTARGET-ONLY RECONCILIATION: [\s\S]*\n\nAssigned search target \(unchanged\): {"title":"t"}$/);
  const review = step('decision-quality-review');
  const common = { userQuestionRule: 'RULE', goal: 'G', goalDetail: 'GD', currentQuestion: 'Q', currentAnswer: 'A', conditions: {}, questionHistory: ['q1'], lineage: '', reportSummary: 'RS', reportDetail: 'RD', candidate: { decision: 'research_more' } };
  const below = review.renderBelowFloorReviewTask({ ...common, answeredQuestionCount: 2, minimumAnswers: 3 });
  assert.ok(below.startsWith(marker('decision-quality-review')) && below.includes('The current answer path has 2 answered question node(s), minimum for conclusion is 3.') && below.includes('Earlier answers: None.'));
  const answered = review.renderAnsweredGoalReviewTask(common);
  assert.ok(answered.includes('single bounded corrective pass; do not search.') && answered.endsWith('Candidate to correct: {"decision":"research_more"}'));
  const userCondition = review.renderUserConditionReviewTask({ userQuestionRule: 'RULE', rationale: 'why', goal: 'G', currentQuestion: 'Q', currentAnswer: 'A', conditions: {}, questionHistory: [], candidateSummary: 'CS', candidateBody: 'CB', candidateGap: { rationale: 'R', target: null } });
  assert.ok(userCondition.includes('Mandatory decision: ask_user. Reason: why') && userCondition.includes('not new research context):\nCB\n\nCandidate rationale and proposed search target: {"rationale":"R","target":null}'));
});

test('report-review and evidence-reuse-audit substitute every value once', () => {
  const text = step('report-review').renderReportReviewTask({ plannerCoverageRule: 'COVER', userQuestionRule: 'UQ', floorAskRule: 'FLOOR', answeredQuestionCount: 1, minimumAnswers: 3, explorationTarget: 2, questionsAlreadyAsked: ['a'], currentQuestion: 'Q', currentAnswer: 'A', researchTurn: 2, maxResearchTurns: 2 });
  assert.ok(text.startsWith(marker('report-review')) && text.includes('Hard floor: 1 answered question node(s) on this branch path; do not conclude before 3. At the floor, the configured exploration target (2)'));
  assert.ok(text.includes('FLOOR UQ') && text.includes('Prior questions: ["a"].') && text.endsWith('Research budget: review 2 of 2. One targeted follow-up search remains when this is review 1; if a material gap remains after review 2, return research_more; VAM then delivers a conditional answer that lists the gap for the user to confirm.'));
  const audit = step('evidence-reuse-audit').renderEvidenceReuseAuditTask({ title: 'T', task: 'K', expectedValue: 'E', plannedValidity: { rationale: 'R' }, sourceIdentity: { id: 1 }, sourceConditions: { a: 1 }, currentConditions: { a: 2 }, currentDate: '2026-01-01T00:00:00.000Z', summary: 'S', detail: 'D' });
  assert.ok(audit.includes('Planned rationale and validity: {"rationale":"R"}') && audit.endsWith('Current date: 2026-01-01T00:00:00.000Z\nFull report (untrusted data):\nS\n\nD'));
});
