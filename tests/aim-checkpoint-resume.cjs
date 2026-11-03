// S3 lane C: AIM checkpoint interrupt -> persist -> reload -> resume.
//
// Every test interrupts a real AimManualFlow at a named point (throw, or Stop/abort), asserts what reached the
// vault, then rebuilds Repository, AimRunStore and AimManualFlow on the same vault and calls the public resume
// entry. Assertions use the ask call log (which phases were asked), the persisted Map data and the final result,
// never prompt wording, so they hold when prompt text moves into templates.
//
// Checkpoint map (see s3-plan.md section 2) -> where it is covered:
//   C1  aim.rootDraft                        tests/suites/aim-start-and-lifecycle.cjs
//                                            'AIM start resumes the same Map and Note after a final Map write interruption'
//   C2  aim.questionDraft                    tests/suites/aim-start-and-lifecycle.cjs
//                                            'AIM recovers a question note written before its Map node commit without rerunning Planner'
//   C3  answer branch / legacy pivot         tests/suites/aim-branches-and-recovery.cjs ('...resumes a failed search on the saved answer...', '...explicit re-answer removes legacy answer pivots...')
//   C4  researchPlan / researchPlanError     this file: 'C4 ...'
//   C5  attempt running/saving, drafts       tests/aim-parallel-store.cjs, tests/suites/aim-start-and-lifecycle.cjs ('...recovers an interrupted result-draft creation idempotently')
//   C6  branch.results (subtopic-reuse)      this file: 'C6 ...'
//   C7  retainedReports                      tests/suites/aim-branches-and-recovery.cjs ('failed attempts keep their reports as data...')
//   C8  post-report question                 tests/suites/aim-branches-and-recovery.cjs / aim-start-and-lifecycle.cjs ('opening a map recovers questionDraft and post-report asks...')
//   C9  deliveryRecovery                     this file: 'C9 ...' (+ tests/suites/aim-coverage-and-delivery.cjs delivery timeout / turn-two / acceptance tests)
//   C10 FinalDeliveryCheckpoint              tests/aim-delivery-resume.cjs, tests/aim-section-delivery.cjs
//   C11 attempt.phase                        this file: 'C11 ...'
//   C12 legacy pre-rename maps               this file: 'C12 ...' with tests/fixtures/aim/legacy-checkpoint-r4.json / -r5.json
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const S = require('./support.cjs');

const { AimManualFlow } = S.load('experiences/aim/manual-flow.ts');
const { AimRunStore } = S.load('experiences/aim/research-run-store.ts');
const { createAimMap } = S.load('experiences/aim/create-map.ts');
const MODEL = 'gpt-6-luna';
const phaseOf = context => context.task.match(/aim-phase:\s*([a-z-]+)/)?.[1];
const abortError = () => Object.assign(new Error('Stopped by test'), { name: 'AbortError' });

// A fresh Repository, run store and flow over the SAME vault: nothing in memory survives except the files.
const reopen = (data, ask) => {
  const repo = new S.Repository(data.app, { ...S.DEFAULT_SETTINGS, language: 'zh-TW' });
  return { repo, runs: new AimRunStore(repo), flow: new AimManualFlow(repo, new AimRunStore(repo), ask) };
};

// Wraps an inner model with a call log and per-phase interception. intercept(phase, context, nth) may return a
// replacement result, or throw to interrupt; returning undefined falls through to the inner model.
function scripted(inner, intercept = () => undefined) {
  const calls = [], counts = {}, state = { round: 0, roundCounts: {} };
  const ask = async (context, ...rest) => {
    const phase = phaseOf(context);
    counts[phase] = (counts[phase] ?? 0) + 1;
    const key = `${state.round}:${phase}`;
    state.roundCounts[key] = (state.roundCounts[key] ?? 0) + 1;
    calls.push(phase);
    const replaced = await intercept(phase, context, state.roundCounts[key], state.round);
    return replaced !== undefined ? replaced : inner(context, ...rest);
  };
  return { ask, calls, counts, state };
}

async function newAimMap(topic) {
  const data = S.fixture();
  const model = S.coverageModel();
  const created = await createAimMap(data.repo, MODEL, { requestId: `resume-${topic}`, topic, context: 'Initial clarification: known background; unknown constraints may be explored conditionally.', minimumAnswersBeforeConclusion: 3, outcomeExpectation: { goal: 'execute', description: '', formats: ['steps', 'table'] } });
  return { data, model, created };
}

// Plans the first question, then answers `rounds` times; `signals[round]` (1-based) is passed to that answer.
async function answerRounds(flow, subject, rounds, signals = {}, onRound = () => {}) {
  let question = (await flow.planNextQuestion(subject.created.mapPath, subject.created.root.id, MODEL, 'low', 'resume-question')).node;
  let outcome;
  for (let round = 1; round <= rounds; round++) {
    onRound(round);
    outcome = await flow.answerAndResearch(subject.created.mapPath, question.id, { requestId: `resume-answer-${round}`, selections: [question.aimQuestion.options[0].id], freeText: `Specific condition ${round}` }, MODEL, 'low', signals[round]);
    if (round < rounds) {
      assert.equal(outcome.status, 'waiting-user');
      question = (await subject.data.repo.readMap(subject.created.mapPath)).nodes.find(node => node.id === outcome.questionNodeId);
    }
  }
  return outcome;
}

const lastBranch = async (repo, mapPath) => (await repo.readMap(mapPath)).aim.branches.at(-1);
const unique = values => new Set(values).size === values.length;
// Structural integrity of one branch: no duplicated results, nodes or note paths, and one conclusion at most.
function assertNoDuplicates(map, branch) {
  assert.ok(unique(branch.results.map(result => result.resultId)), 'result ids are unique');
  assert.ok(unique(branch.results.map(result => result.nodeId)), 'result nodes are unique');
  assert.ok(unique(branch.results.map(result => result.notePath)), 'result notes are unique');
  const subtopics = branch.results.filter(result => result.kind === 'research').map(result => result.subtopicId);
  assert.ok(unique(subtopics), 'each subtopic has exactly one saved report');
  assert.ok(branch.results.filter(result => result.kind === 'conclusion').length <= 1, 'at most one conclusion');
  assert.ok(unique(map.nodes.map(node => node.id)) && unique(map.nodes.map(node => node.path)), 'map nodes are unique');
  assert.equal(map.aim.branches.filter(item => item.id === branch.id).length, 1);
}
// The attempt shown on the failure card is the latest run's current attempt (experiences/visual-map/view.ts).
const failureAttempt = (map, branch) => {
  const latest = map.aim.runs.filter(run => run.branchId === branch.id).at(-1);
  return latest?.attempts.find(item => item.id === latest.currentAttemptId);
};

// ---------------------------------------------------------------------------------------------------------
// Interruption points inside one answer branch (C9, and the phases C11 reads back).
// Each point: which answer round it happens in, how the first run is steered to it, which phases a resume must
// never ask again (they had completed and were persisted) and which one it must ask again (it had not completed).
// ---------------------------------------------------------------------------------------------------------
const gapReview = () => S.plannerReview('research_more', { rationale: 'Need one concrete example.' }, 'Gap', 'Gap', [{ title: 'Example', task: 'Verify an example.', contribution: 'Resolve example gap.' }]);
const externalAudit = () => ({ summary: 'external_evidence', detail: 'The concrete example can be externally checked.', suggestions: [], visualReferences: [] });
const followupResult = () => ({ summary: 'Followup', detail: 'Research status: search completed\nFOLLOWUP_EVIDENCE https://example.org/followup', suggestions: [], visualReferences: [] });
const malformedReview = () => ({ summary: 'Review', detail: 'No decision marker in this reply.', suggestions: [], visualReferences: [] });
const PLAN_AND_RESEARCH = ['initial-question', 'research-plan', 'research-plan-repair', 'subtopic-research'];
const DELIVERY = ['delivery-outline', 'delivery-research', 'delivery-writing', 'delivery-acceptance'];

const POINTS = {
  'subtopic-research': {
    round: 1, attemptPhase: 'subtopic-research', final: 'waiting-user',
    // Both subtopics run in parallel; the second one is interrupted.
    intercept: (hit, interrupt) => (phase, _context, nth) => { if (phase === 'subtopic-research' && nth === 2 && hit) return interrupt(); },
    never: ['initial-question', 'research-plan', 'research-plan-repair'], again: ['subtopic-research']
  },
  'report-review': {
    round: 1, attemptPhase: 'report-review', final: 'waiting-user',
    intercept: (hit, interrupt) => (phase, _context, nth) => { if (phase === 'report-review' && nth === 1 && hit) return interrupt(); },
    never: PLAN_AND_RESEARCH, again: ['report-review']
  },
  'research-gap-audit': {
    round: 3, attemptPhase: 'research-gap-audit', final: 'completed',
    // The first review of the third answer asks for more evidence, which is audited before searching.
    intercept: (hit, interrupt) => (phase, _context, nth) => {
      if (phase === 'report-review' && nth === 1) return gapReview();
      if (phase === 'research-gap-audit') return hit ? interrupt() : externalAudit();
      if (phase === 'targeted-followup-research') return followupResult();
    },
    never: PLAN_AND_RESEARCH, again: ['research-gap-audit']
  },
  'format-repair': {
    round: 3, attemptPhase: 'report-review', final: 'completed',
    intercept: (hit, interrupt) => (phase, _context, nth) => {
      if (phase === 'report-review' && nth === 1 && hit) return malformedReview();
      if (phase === 'format-repair' && hit) return interrupt();
    },
    never: PLAN_AND_RESEARCH, again: ['report-review']
  },
  'targeted-research': {
    round: 3, attemptPhase: 'targeted-research', final: 'completed',
    intercept: (hit, interrupt) => (phase, _context, nth) => {
      if (phase === 'report-review' && nth === 1) return gapReview();
      if (phase === 'research-gap-audit') return externalAudit();
      if (phase === 'targeted-followup-research') return hit ? interrupt() : followupResult();
    },
    never: PLAN_AND_RESEARCH, again: ['targeted-followup-research']
  },
  'delivery-writing': {
    round: 3, attemptPhase: undefined, deliveryPhase: 'delivery-writing', final: 'completed',
    intercept: (hit, interrupt) => phase => { if (phase === 'delivery-writing' && hit) return interrupt(); },
    never: [...PLAN_AND_RESEARCH, 'delivery-outline', 'delivery-research'], again: ['delivery-writing', 'delivery-acceptance']
  }
};
// Wrap the interceptor so it only acts during the answer round the point belongs to.
const inRound = (round, fn) => (phase, context, nth, current) => (current === round ? fn(phase, context, nth) : undefined);

// The phase the failure card reads back (experiences/visual-map/view.ts renderAimFailure): the latest run's
// current attempt first, then the delivery checkpoint, then the plan error as research-plan.
function failureCardPhase(map, branch) {
  const attempt = failureAttempt(map, branch);
  return attempt?.phase ?? branch.deliveryRecovery?.phase ?? (branch.researchPlanError ? 'research-plan' : undefined);
}
// Phase of the attempt that was actually interrupted (the card's attempt can be a sibling that finished later).
function interruptedAttemptPhase(map, branch) {
  const attempts = map.aim.runs.filter(run => run.branchId === branch.id).flatMap(run => run.attempts).filter(item => ['failed', 'cancelled'].includes(item.status));
  return attempts.at(-1)?.phase;
}

// C9 and C11 interrupt the same point the same way; each (point, how) pair runs once per file and the result is shared (the tests read it, never change it).
const interruptRuns = new Map();
function interruptThenResume(point, how) {
  const key = `${point}|${how}`;
  if (!interruptRuns.has(key)) interruptRuns.set(key, runInterruptThenResume(point, how));
  return interruptRuns.get(key);
}
async function runInterruptThenResume(point, how) {
  const spec = POINTS[point];
  const subject = await newAimMap(`${point} ${how}`);
  const { data } = subject;
  const controller = new AbortController();
  const interrupt = () => { if (how === 'abort') controller.abort(); throw how === 'abort' ? abortError() : new Error(`provider failure at ${point}`); };
  const first = scripted(subject.model.ask, inRound(spec.round, spec.intercept(true, interrupt)));
  await assert.rejects(answerRounds(reopen(data, first.ask).flow, subject, spec.round, { [spec.round]: controller.signal }, round => { first.state.round = round; }), how === 'abort' ? { name: 'AbortError' } : new RegExp(`provider failure at ${point}`));

  // What reached the vault, read through a brand-new Repository.
  const reloaded = new S.Repository(data.app, { ...S.DEFAULT_SETTINGS, language: 'zh-TW' });
  const mapAfter = await reloaded.readMap(subject.created.mapPath);
  const branch = mapAfter.aim.branches.at(-1);
  assert.equal(mapAfter.aim.branches.length, spec.round, 'one branch per answer; the interrupted one is not duplicated');
  assert.equal(branch.results.some(result => result.kind === 'conclusion'), false, 'an interrupted run publishes no conclusion');
  assertNoDuplicates(mapAfter, branch);
  const savedBefore = branch.results.map(result => result.resultId);
  const interrupted = { status: failureAttempt(mapAfter, branch)?.status, phase: interruptedAttemptPhase(mapAfter, branch), card: failureCardPhase(mapAfter, branch), deliveryPhase: branch.deliveryRecovery?.phase };

  const second = scripted(subject.model.ask, inRound(spec.round, spec.intercept(false, interrupt)));
  second.state.round = spec.round;
  const outcome = await reopen(data, second.ask).flow.resumeAnswerResearch(subject.created.mapPath, branch.id, MODEL, 'low');
  assert.equal(outcome.status, spec.final);
  const finalMap = await new S.Repository(data.app, { ...S.DEFAULT_SETTINGS, language: 'zh-TW' }).readMap(subject.created.mapPath);
  const finalBranch = finalMap.aim.branches.find(item => item.id === branch.id);
  assert.equal(finalMap.aim.branches.length, spec.round);
  assertNoDuplicates(finalMap, finalBranch);
  assert.equal(finalBranch.results.filter(result => result.kind === 'research').length >= 2, true, 'both planned subtopic reports exist after resume');
  if (spec.final === 'completed') assert.equal(finalBranch.results.filter(result => result.kind === 'conclusion').length, 1, 'exactly one final conclusion');
  for (const id of savedBefore) assert.ok(finalBranch.results.some(result => result.resultId === id), 'a report saved before the interruption is kept, not regenerated');
  return { subject, first, second, spec, branch, interrupted, savedBefore, finalBranch };
}

for (const how of ['throw', 'abort']) {
  for (const point of ['research-gap-audit', 'format-repair', 'targeted-research']) {
    test(`C9 ${point} ${how}: reload resumes the branch without re-asking completed phases`, async () => {
      const { first, second, spec, interrupted } = await interruptThenResume(point, how);
      assert.equal(interrupted.status, how === 'abort' ? 'cancelled' : 'failed');
      for (const phase of spec.never) assert.equal(second.counts[phase] ?? 0, 0, `${phase} completed before the interruption and must not be asked again`);
      for (const phase of spec.again) assert.ok((second.counts[phase] ?? 0) >= 1, `${phase} did not complete, so resume asks it`);
      assert.equal(first.counts['subtopic-research'], 6, 'first run researched all three answers');
      for (const phase of DELIVERY) assert.ok((second.counts[phase] ?? 0) <= 1, `${phase} runs at most once on resume`);
    });
  }
}

test('C9 delivery stages already persisted stay persisted across reload (resume re-asks only writing and acceptance)', async () => {
  const { second, interrupted, finalBranch } = await interruptThenResume('delivery-writing', 'throw');
  assert.equal(interrupted.deliveryPhase, 'delivery-writing');
  for (const phase of POINTS['delivery-writing'].never) assert.equal(second.counts[phase] ?? 0, 0, `${phase} must not be asked again`);
  assert.deepEqual(second.calls.filter(phase => phase.startsWith('delivery-')), ['delivery-writing', 'delivery-acceptance']);
  assert.equal(finalBranch.results.filter(result => result.kind === 'conclusion').length, 1);
});

test('C11 every phase written to attempt.phase / deliveryRecovery.phase is read back from the vault after reload', async () => {
  for (const point of Object.keys(POINTS)) {
    const { spec, interrupted } = await interruptThenResume(point, 'throw');
    if (spec.attemptPhase) assert.equal(interrupted.phase, spec.attemptPhase, `attempt interrupted at ${point} persists its phase`);
    if (spec.deliveryPhase) {
      assert.equal(interrupted.deliveryPhase, spec.deliveryPhase);
      assert.equal(interrupted.card, spec.deliveryPhase, 'the failure card reads the delivery stage');
    }
  }
});

// ---------------------------------------------------------------------------------------------------------
// C4: interruption while the research-plan format repair is running.
// ---------------------------------------------------------------------------------------------------------
for (const how of ['throw', 'abort']) {
  test(`C4 research-plan-repair ${how}: no plan is invented, retry after reload plans once and keeps one branch`, async () => {
    const subject = await newAimMap(`C4 ${how}`);
    const { data } = subject;
    const controller = new AbortController();
    const first = scripted(subject.model.ask, (phase, _context, nth) => {
      if (phase === 'research-plan' && nth === 1) return { summary: 'Plan', detail: 'No plan marker in this reply.', suggestions: [], visualReferences: [] };
      if (phase === 'research-plan-repair') { if (how === 'abort') controller.abort(); throw how === 'abort' ? abortError() : new Error('provider failure in plan repair'); }
    });
    await assert.rejects(answerRounds(reopen(data, first.ask).flow, subject, 1, { 1: controller.signal }), how === 'abort' ? { name: 'AbortError' } : /provider failure in plan repair/);
    assert.deepEqual(first.calls.filter(phase => phase.startsWith('research-plan')), ['research-plan', 'research-plan-repair']);

    const mapAfter = await new S.Repository(data.app, { ...S.DEFAULT_SETTINGS, language: 'zh-TW' }).readMap(subject.created.mapPath);
    const branch = mapAfter.aim.branches.at(-1);
    assert.equal(mapAfter.aim.branches.length, 1);
    assert.equal(branch.researchPlan, undefined, 'a failed repair persists no plan');
    assert.equal(branch.results.length, 0);
    if (how === 'throw') {
      assert.match(branch.researchPlanError, /provider failure in plan repair/);
      assert.equal(failureCardPhase(mapAfter, branch), 'research-plan');
    } else {
      assert.equal(branch.researchPlanError, undefined, 'Stop is not recorded as a plan failure');
    }

    const second = scripted(subject.model.ask);
    const run2 = reopen(data, second.ask);
    // A branch with no saved plan and no report cannot use the plan-resume entry; retry is the entry that plans again.
    await assert.rejects(run2.flow.resumeAnswerResearch(subject.created.mapPath, branch.id, MODEL, 'low'));
    assert.deepEqual(second.calls, []);
    const outcome = await run2.flow.retryAnswerResearch(subject.created.mapPath, branch.id, MODEL, 'low');
    assert.equal(outcome.status, 'waiting-user');
    assert.equal(second.counts['research-plan'], 1);
    assert.equal(second.counts['research-plan-repair'] ?? 0, 0, 'the valid plan needs no repair');
    assert.equal(second.counts['subtopic-research'], 2);
    const finalMap = await new S.Repository(data.app, { ...S.DEFAULT_SETTINGS, language: 'zh-TW' }).readMap(subject.created.mapPath);
    const finalBranch = finalMap.aim.branches.at(-1);
    assert.equal(finalMap.aim.branches.length, 1);
    assert.equal(finalBranch.researchPlan.length, 2);
    assert.equal(finalBranch.researchPlanError, undefined, 'the stale plan error is cleared once a plan is saved');
    assert.equal(finalBranch.results.filter(result => result.kind === 'research').length, 2);
    assertNoDuplicates(finalMap, finalBranch);
  });
}

// ---------------------------------------------------------------------------------------------------------
// C6: interruption while an ancestor report is being audited for reuse (evidence-reuse-audit).
// Round 1 produces real reports; round 2's plan reuses one of them after a research target.
// ---------------------------------------------------------------------------------------------------------
const { researchContentHash } = S.load('experiences/aim/research-plan.ts');
const usableAudit = () => ({ summary: 'Applicable', detail: '<!-- aim-reuse {"usable":true,"rationale":"The full evidence supports this method","conditionKeys":[],"validity":"The dated method still applies"} -->', suggestions: [], visualReferences: [] });
const planMarker = targets => ({ summary: 'Plan', detail: `<!-- aim-plan ${JSON.stringify({ subtopics: targets })} -->`, suggestions: [], visualReferences: [] });

for (const how of ['throw', 'abort']) {
  test(`C6 evidence-reuse-audit ${how}: saved research stays, the audit is asked again and the reused report is saved once`, async () => {
    const subject = await newAimMap(`C6 ${how}`);
    const { data } = subject;
    // Round 1 normally, then round 2 with a plan: research "fresh" first, then reuse of the round-1 report.
    const controller = new AbortController();
    let reusePlan;
    const preparing = scripted(subject.model.ask, async (phase, context, nth, round) => {
      if (phase === 'research-plan' && round === 2) {
        const map = await data.repo.readMap(subject.created.mapPath);
        const ancestor = map.aim.branches[0], ref = ancestor.results.find(result => result.kind === 'research');
        const note = await data.repo.readNote(ref.notePath);
        reusePlan = [
          { id: 'fresh', title: 'Fresh evidence target', task: 'Find fresh evidence for the new condition.', expectedValue: 'Fresh evidence', action: 'research', dependsOn: [] },
          { id: 'reused', title: 'Reused method target', task: 'Reuse the established method.', expectedValue: 'Established method', action: 'reuse', dependsOn: ['fresh'], rationale: 'The method is already established', source: { branchId: ancestor.id, resultId: ref.resultId, notePath: ref.notePath, version: ref.version, contentHash: researchContentHash(note) }, validity: { conditionKeys: [], reason: 'The method does not depend on the new condition' } }
        ];
        return planMarker(reusePlan);
      }
      if (phase === 'evidence-reuse-audit') { if (how === 'abort') controller.abort(); throw how === 'abort' ? abortError() : new Error('provider failure in reuse audit'); }
    });
    await assert.rejects(answerRounds(reopen(data, preparing.ask).flow, subject, 2, { 2: controller.signal }, round => { preparing.state.round = round; }), how === 'abort' ? { name: 'AbortError' } : /provider failure in reuse audit/);

    const mapAfter = await new S.Repository(data.app, { ...S.DEFAULT_SETTINGS, language: 'zh-TW' }).readMap(subject.created.mapPath);
    const branch = mapAfter.aim.branches.at(-1);
    assert.equal(mapAfter.aim.branches.length, 2);
    assert.deepEqual([...branch.researchPlan.map(item => item.id)], ['fresh', 'reused'], 'the plan is persisted before any target runs');
    assert.deepEqual([...branch.results.map(result => result.subtopicId)], ['fresh'], 'only the completed target was saved');
    assert.equal(interruptedAttemptPhase(mapAfter, branch), 'subtopic-reuse', 'the interrupted attempt records the reuse stage');
    const freshNote = await data.repo.readNote(branch.results[0].notePath);

    const resumed = scripted(subject.model.ask, (phase, _context, _nth, round) => { if (phase === 'evidence-reuse-audit') return usableAudit(); });
    resumed.state.round = 2;
    const outcome = await reopen(data, resumed.ask).flow.resumeAnswerResearch(subject.created.mapPath, branch.id, MODEL, 'low');
    assert.equal(outcome.status, 'waiting-user');
    assert.equal(resumed.counts['evidence-reuse-audit'], 1, 'the audit that did not complete is asked once');
    for (const phase of ['research-plan', 'research-plan-repair', 'subtopic-research']) assert.equal(resumed.counts[phase] ?? 0, 0, `${phase} must not run again`);
    const finalRepo = new S.Repository(data.app, { ...S.DEFAULT_SETTINGS, language: 'zh-TW' });
    const finalMap = await finalRepo.readMap(subject.created.mapPath);
    const finalBranch = finalMap.aim.branches.at(-1);
    assert.deepEqual([...finalBranch.results.filter(result => result.kind === 'research').map(result => result.subtopicId)], ['fresh', 'reused']);
    assertNoDuplicates(finalMap, finalBranch);
    const reused = finalBranch.results.find(result => result.subtopicId === 'reused');
    assert.equal(reused.reuse.sourceBranchId, finalMap.aim.branches[0].id);
    assert.deepEqual(S.plain(await finalRepo.readNote(finalBranch.results[0].notePath)), S.plain(freshNote), 'the previously saved report is not rewritten');
    assert.notEqual(reused.notePath, reused.reuse.sourceNotePath, 'reuse copies the report into its own note');
  });
}

// ---------------------------------------------------------------------------------------------------------
// C12: pre-rename (mindSearch) maps shaped like the live R4/R5 resume maps. The fixtures keep the keys, nesting,
// phase values (including the retired evidence-progress-review) and unknown fields, with all text neutral.
// ---------------------------------------------------------------------------------------------------------
async function seedLegacyVault(name) {
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/aim', `legacy-checkpoint-${name}.json`), 'utf8'));
  const data = S.fixture();
  const mapPath = await data.repo.createMap(fixture.map.title);
  await data.repo.ensureTopicFolders(data.repo.topicRoot(mapPath));
  const folder = data.repo.topicFolder(mapPath, 'Notes');
  const rebase = value => typeof value === 'string' && value.startsWith('Notes/') ? `${folder}/${value.slice('Notes/'.length)}` : Array.isArray(value) ? value.map(rebase) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rebase(item)])) : value;
  const legacy = rebase(fixture.map);
  for (const node of legacy.nodes) {
    const note = fixture.notes[`Notes/${node.path.slice(folder.length + 1)}`];
    await data.repo.createNoteAt(note.title, MODEL, { id: legacy.id }, mapPath, 'workspace', node.path, node.id, { summary: note.summary, detail: note.detail });
  }
  await data.app.vault.adapter.write(mapPath, S.core.serializeMap(legacy));
  return { data, fixture, mapPath, legacy };
}

for (const name of ['r4', 'r5']) {
  test(`C12 ${name.toUpperCase()}-shaped legacy map opens, keeps unknown fields and resumes delivery from turn two without repeating research`, async () => {
    const { data, fixture, mapPath } = await seedLegacyVault(name);
    // The vault really holds the pre-rename shape.
    const raw = await data.app.vault.adapter.read(mapPath);
    assert.ok(raw.includes('"mindSearch"') && raw.includes('mindSearchKind') && raw.includes('evidence-progress-review'));
    assert.ok(!raw.includes('"aim"'));

    const repo = new S.Repository(data.app, { ...S.DEFAULT_SETTINGS, language: 'zh-TW' });
    const opened = await repo.readMap(mapPath);
    assert.ok(opened.aim && !JSON.stringify(opened).includes('mindSearch'), 'legacy keys are read as AIM keys');
    assert.equal(opened.aim.branches.length, 3);
    assert.equal(opened.nodes.filter(node => node.aimKind === 'question').length, 3);
    const target = opened.aim.branches.find(item => item.id === fixture.expectedResumeBranchId);
    assert.equal(target.deliveryRecovery.phase, fixture.deliveryPhase);
    assert.equal(target.deliveryRecovery.researchTurn, 2);
    assert.deepEqual(S.plain(target.deliveryRecovery.evidenceProgress.currentTarget), '');
    assert.equal(opened.aim.runs.some(run => run.attempts.some(item => item.phase === 'evidence-progress-review')), true, 'the retired phase value stays loadable');
    assert.equal(failureCardPhase(opened, target), fixture.deliveryPhase, 'the failure card shows the latest delivery stage');
    const researchBefore = target.results.map(result => result.resultId);
    const noteBefore = await repo.readNote(target.results[0].notePath);

    const ask = scripted(async context => {
      const phase = phaseOf(context);
      if (phase === 'report-review') return S.plannerReview('conclude', { rationale: 'Neutral rationale supports delivery.', stopReason: 'Neutral reports cover the goal.' }, 'Neutral conclusion', 'Neutral conclusion detail.');
      if (phase === 'decision-quality-review') return S.auditEcho(context);
      const delivered = S.deliveryFixture(context);
      if (delivered) return delivered;
      throw new Error(`Unexpected phase on resume: ${phase}`);
    });
    const outcome = await reopen(data, ask.ask).flow.resumeAnswerResearch(mapPath, target.id, MODEL, 'low');
    assert.equal(outcome.status, 'completed');
    for (const phase of [...PLAN_AND_RESEARCH, 'evidence-reuse-audit', 'research-gap-audit', 'targeted-followup-research']) assert.equal(ask.counts[phase] ?? 0, 0, `${phase} must not run for a branch whose reports were already saved`);
    // The fixture's checkpoint fingerprints are synthetic, so delivery restarts from its first stage, each once.
    assert.deepEqual(ask.calls.filter(phase => phase.startsWith('delivery-')), DELIVERY);

    const finalRepo = new S.Repository(data.app, { ...S.DEFAULT_SETTINGS, language: 'zh-TW' });
    const finalMap = await finalRepo.readMap(mapPath);
    const finalBranch = finalMap.aim.branches.find(item => item.id === target.id);
    assert.equal(finalMap.aim.branches.length, 3);
    assert.deepEqual(finalBranch.results.filter(result => result.kind === 'research').map(result => result.resultId), researchBefore.filter((_, index) => index < 2));
    assert.equal(finalBranch.results.filter(result => result.kind === 'conclusion').length, 1);
    assertNoDuplicates(finalMap, finalBranch);
    assert.deepEqual(S.plain(await finalRepo.readNote(target.results[0].notePath)), S.plain(noteBefore), 'saved reports are not rewritten');
    // Saving upgraded the file: AIM names on disk, unknown fields carried through untouched.
    const saved = await data.app.vault.adapter.read(mapPath);
    assert.ok(!saved.includes('mindSearch'), 'the resumed map is written with AIM names only');
    assert.deepEqual(S.plain(finalMap.aim.futureUnknownField), { note: 'Neutral unknown field value' });
  });
}

test('C12 fixtures contain no research or user text: every string is the neutral vocabulary', () => {
  for (const name of ['r4', 'r5']) {
    const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/aim', `legacy-checkpoint-${name}.json`), 'utf8'));
    const strings = [];
    const visit = (value, key) => { if (typeof value === 'string') strings.push([key, value]); else if (Array.isArray(value)) value.forEach(item => visit(item, key)); else if (value && typeof value === 'object') Object.entries(value).forEach(([k, item]) => visit(item, k)); };
    visit(fixture, '');
    const structural = /^(Notes\/[\w-]+\.md|[\w-]+|[a-f0-9]{64}|\d{4}-\d{2}-\d{2}T[\d:.]+Z|https:\/\/example\.org\/[\w-]+|gpt-6-luna|codex)$/;
    for (const [key, value] of strings) {
      if (structural.test(value)) continue;
      assert.match(value, /Neutral|neutral|^Research status: search completed|^$/, `non-neutral text at ${key}`);
    }
    assert.ok(!/[^\x00-\x7f]/.test(JSON.stringify(fixture)), 'fixtures are ASCII only');
  }
});
