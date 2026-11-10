// Argument map runner v2 (V5b): verdict, comparison and send-back, late alternatives, conclusion, inference check. Fake ports over the real
// repository fixture; unit level only (live provider behaviour is not proved here).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const machine = require('./support.cjs').load('core/argument-map/machine-v2.ts');
const { rig, locked, model, plain, tick, defer } = require('./support-argument-run-v2.cjs');

const count = (r, name) => r.stat.steps.filter(n => n === name).length;
const hypothesisIds = request => request.input.hypotheses.map(h => h.id);
const veto = (kind, detail) => ({ kind, detail });
const finished = async r => { const s = await r.state(); return `${s.run.status}/${s.run.phase}/${s.conclusion.state}`; };

test('happy path: verdict, comparison, conclusion and inference check each run once; the conclusion card is written by the runner; logs carry ids and kinds only', async () => {
  const r = await rig();
  assert.deepEqual(plain(await r.runs.start(r.mapPath, locked())), { ok: true });
  const s = await r.state();
  assert.equal(await finished(r), 'finished/concluded/concluded');
  assert.deepEqual(plain(r.stat.steps.filter(n => ['verdict', 'comparison', 'conclusion', 'inference-check'].includes(n))), ['verdict', 'verdict', 'comparison', 'conclusion', 'inference-check']);
  assert.ok(s.hypotheses.every(h => h.verdict && h.verdict.by === 'ai'));
  const testable = s.claims.find(c => c.role === 'testable');
  assert.equal(testable.comparison.state, 'done');
  const card = await r.text(s.roles.conclusion);
  assert.equal(card.summary, r.ports.t('ui.argument_conclusion_state_concluded'));
  assert.ok(card.detail.includes(`${testable.text}: ${testable.text} cannot be settled`), 'sentence under the claim text');
  const log = r.log();
  for (const part of ['verdict runId=', 'compare runId=', 'conclusion runId=', 'inference runId=', 'vetoes=-']) assert.ok(log.includes(part), part);
  assert.ok(!log.includes('cannot be settled') && !log.includes('no decisive result'), 'no model text in the log');
  assert.equal(r.runs.isRunning(r.mapPath), false);
});

test('comparison vetoes: the sent-back hypothesis loses its verdict and is judged again once; the second comparison completes', async () => {
  let n = 0;
  const r = await rig({ script: { step: { comparison: request => (++n === 1
    ? { decision: 'rejudge', vetoes: [veto('contradiction', 'facets disagree')], allocations: [], rejudge: [hypothesisIds(request)[0]] }
    : { decision: 'complete', vetoes: [], allocations: [], rejudge: [], answer: 'insufficient' }) } } });
  await r.runs.start(r.mapPath, locked());
  const s = await r.state();
  assert.equal(await finished(r), 'finished/concluded/concluded');
  assert.equal(count(r, 'comparison'), 2);
  assert.equal(count(r, 'verdict'), 3, 'two first verdicts plus the one sent back');
  const back = s.hypotheses.filter(h => h.reverdicts === 1);
  assert.equal(back.length, 1);
  assert.equal(back[0].verdict.reverdicts, 1);
  assert.equal(s.claims.find(c => c.role === 'testable').comparison.attempts, 2);
  assert.ok(r.log().includes('vetoes=contradiction') && r.log().includes('state=vetoed'));
});

test('comparison vetoes twice: the second veto ends undecidable (no third comparison); the conclusion says so without a positive answer', async () => {
  const r = await rig({ script: { step: { comparison: request => ({ decision: 'rejudge', vetoes: [veto('double_count', 'same source twice')], allocations: [], rejudge: [hypothesisIds(request)[0]] }) } } });
  await r.runs.start(r.mapPath, locked());
  const s = await r.state();
  const testable = s.claims.find(c => c.role === 'testable');
  assert.equal(count(r, 'comparison'), 2);
  assert.equal(testable.comparison.state, 'undecidable');
  assert.equal(testable.comparison.answer, 'insufficient');
  assert.equal(await finished(r), 'finished/concluded/undecidable');
  assert.equal((await r.text(s.roles.conclusion)).summary, r.ports.t('ui.argument_conclusion_limit'));
});

test('a missed alternative is asked once: new hypothesis cards under the claim with their own ids; a second request for one is undecidable', async () => {
  let n = 0;
  const r = await rig({ script: { step: { comparison: () => (++n <= 2
    ? { decision: 'add_alternative', vetoes: [veto('missed_alternative', 'a third facet was not considered')], allocations: [], rejudge: [] }
    : { decision: 'complete', vetoes: [], allocations: [], rejudge: [], answer: 'insufficient' }) } } });
  await r.runs.start(r.mapPath, locked());
  const s = await r.state();
  const testable = s.claims.find(c => c.role === 'testable');
  const asks = r.stat.requests.filter(x => x.name === 'hypotheses');
  assert.equal(asks.length, 2, 'first batch plus the one late batch');
  assert.equal(asks[1].request.mode, 'alternatives');
  assert.equal(asks[1].request.gap, 'a third facet was not considered', 'the gap is the veto detail');
  assert.equal(s.hypotheses.length, 4);
  assert.equal(s.hypotheses.filter(h => h.addedAfterComparison).length, 2);
  const doc = await r.repo.readMap(r.mapPath);
  for (const h of s.hypotheses.filter(x => x.addedAfterComparison)) {
    const node = doc.nodes.find(x => x.id === h.id);
    assert.ok(node, 'the card has the hypothesis id');
    assert.equal(node.parentId, testable.id);
  }
  assert.equal(testable.comparison.state, 'undecidable', 'the second comparison still vetoed');
  assert.equal(count(r, 'comparison'), 2);
});

test('conclusion answer that breaks the rules is refused; one corrective retry (not counted), a second refusal pauses with error', async () => {
  let n = 0;
  const r = await rig({ script: { step: { conclusion: request => ({ answers: request.input.claims.filter(c => c.evaluated).map(c => ({ claimId: c.id, answer: ++n === 1 ? 'holds' : c.comparison.answer, sentence: `${c.text} cannot be settled`, assumptions: [] })) }) } } });
  await r.runs.start(r.mapPath, locked());
  assert.equal(count(r, 'conclusion'), 2);
  assert.equal(await finished(r), 'finished/concluded/concluded');
  const bad = await rig({ script: { step: { conclusion: request => ({ answers: request.input.claims.filter(c => c.evaluated).map(c => ({ claimId: c.id, answer: 'holds', sentence: `${c.text} is true`, assumptions: [] })) }) } } });
  await bad.runs.start(bad.mapPath, locked());
  const s = await bad.state();
  assert.equal(count(bad, 'conclusion'), 2);
  assert.equal(`${s.run.status}/${s.run.stopReason}/${s.run.phase}`, 'paused/error/conclusion');
  assert.deepEqual(plain(s.conclusion.answers), []);
});

test('inference check runs twice when it rewrote; the second flagged sentence is deleted by the program and kept in conclusion.deleted', async () => {
  let n = 0;
  const r = await rig({ script: { step: { 'inference-check': request => request.input.sentences.map(x => (++n === 1
    ? { id: x.id, status: 'rewrite', rewrite: `${x.sentence} (careful)` }
    : { id: x.id, status: 'rewrite', rewrite: `${x.sentence} (again)` })) } } });
  await r.runs.start(r.mapPath, locked());
  const s = await r.state();
  assert.equal(count(r, 'inference-check'), 2);
  assert.equal(s.run.inferenceChecks, 2);
  assert.equal(s.conclusion.deleted.length, 1);
  assert.ok(s.conclusion.deleted[0].includes('(careful)'));
  assert.equal(s.conclusion.answers[0].sentence, '');
  assert.equal(await finished(r), 'finished/concluded/concluded');
  assert.ok(!(await r.text(s.roles.conclusion)).detail.includes('careful'), 'the deleted sentence is not on the card');
  const one = await rig({ script: { step: { 'inference-check': request => request.input.sentences.map(x => ({ id: x.id, status: 'delete' })) } } });
  await one.runs.start(one.mapPath, locked());
  assert.equal(count(one, 'inference-check'), 1, 'a deletion alone needs no second check');
  assert.equal((await one.state()).conclusion.deleted.length, 1);
});

test('research limit: unfinished hypotheses get a program verdict (AI = 0) and still reach the comparison, the conclusion and the inference check', async () => {
  const ask = (ctx, n) => ({ summary: '', detail: '', suggestions: [], visualReferences: [], evidence: { openedUrls: [] }, argumentEvidence: [n === 1 ? { need: ctx.argumentEvidenceNeeds[0].id, status: 'found', stance: 'supports', claim: 'Rate rose', quote: 'Youth unemployment rose to 9.2 percent in March', url: 'https://stats.example.org/report' } : { need: ctx.argumentEvidenceNeeds[0].id, status: 'not_found' }] });
  const r = await rig({ script: { ask, step: { needs: async request => {
    await r.repo.updateMap(r.mapPath, doc => { doc.argumentMap.run.researchCalls = model.MAX_RESEARCH_CALLS - 1; });
    return { needs: request.hypothesis.predictions.filter(p => p.required).slice(0, request.max).map((p, i) => ({ id: request.ids[i], predictionId: p.id, text: `need for ${p.id}`, criteria: { supports: 's', refutes: 'r', irrelevant: 'i' } })) };
  } } } });
  await r.runs.start(r.mapPath, locked());
  assert.equal(count(r, 'verdict'), 0);
  for (const name of ['comparison', 'conclusion', 'inference-check']) assert.equal(count(r, name), 1, name);
  assert.equal(await finished(r), 'finished/concluded/concluded');
});

test('stale results: a comparison that returns after Stop, after dispose, or after the state moved on writes nothing', async () => {
  const stopGate = defer();
  const r = await rig({ script: { step: { comparison: async () => { await stopGate.promise; return { decision: 'complete', vetoes: [], allocations: [], rejudge: [], answer: 'insufficient' }; } } } });
  const started = r.runs.start(r.mapPath, locked());
  for (let i = 0; i < 100 && count(r, 'comparison') === 0; i++) await tick();
  await r.runs.stop(r.mapPath);
  await started;
  const after = await r.snapshot();
  stopGate.resolve();
  for (let i = 0; i < 20; i++) await tick();
  assert.equal(await r.snapshot(), after, 'a result after Stop writes nothing');
  assert.equal((await r.state()).claims.find(c => c.role === 'testable').comparison.state, 'pending');

  const gate = defer();
  const d = await rig({ script: { step: { conclusion: async request => { await gate.promise; return { answers: request.input.claims.filter(c => c.evaluated).map(c => ({ claimId: c.id, answer: c.comparison.answer, sentence: `${c.text} cannot be settled`, assumptions: [] })) }; } } } });
  const run = d.runs.start(d.mapPath, locked());
  for (let i = 0; i < 100 && count(d, 'conclusion') === 0; i++) await tick();
  const before = await d.snapshot();
  d.runs.dispose();
  gate.resolve();
  await run;
  assert.equal(await d.snapshot(), before, 'dispose: nothing written afterwards');

  // the prepared input moved on (a different claim state): the reply for the old input is dropped, not applied
  const moved = defer();
  const m = await rig({ script: { step: { verdict: async request => { await moved.promise; return { value: 'undecided', reason: 'no decisive result', citedNeeds: [], counterNotes: [], refutations: [], causal: 'not_applicable', assumptionStatus: [], confidence: 'low' }; } } } });
  const go = m.runs.start(m.mapPath, locked());
  for (let i = 0; i < 100 && count(m, 'verdict') === 0; i++) await tick();
  await m.repo.updateMap(m.mapPath, doc => { doc.argumentMap.hypotheses[0].predictions[0].text = 'changed meanwhile'; });
  moved.resolve();
  await go;
  const s = await m.state();
  assert.ok(count(m, 'verdict') >= 3, 'the reply for the old input was dropped and the hypothesis was asked again');
  assert.equal(await finished(m), 'finished/concluded/concluded');
});

test('reload: a run left running in the conclusion phase is paused as interrupted by recover, and no provider is called', async () => {
  const r = await rig({ script: { step: { conclusion: () => { throw new Error('down'); } } } });
  await r.runs.start(r.mapPath, locked());
  const doc = await r.repo.readMap(r.mapPath);
  doc.argumentMap.run.status = 'running';
  delete doc.argumentMap.run.stopReason;
  await r.repo.saveMap(r.mapPath, doc);
  const calls = r.stat.steps.length + r.stat.ask.length;
  assert.equal(await r.runs.recover(r.mapPath), true);
  const s = await r.state();
  assert.equal(`${s.run.status}/${s.run.stopReason}/${s.run.phase}`, 'paused/interrupted/conclusion');
  assert.equal(r.stat.steps.length + r.stat.ask.length, calls);
});

test('the user mark never reaches the comparison or the conclusion: the inputs are the same with and without it', async () => {
  const seen = async mark => {
    const r = await rig({ script: { step: { verdict: async (request, k) => {
      if (mark && k === 1) await r.repo.updateMap(r.mapPath, doc => { doc.argumentMap.hypotheses[0].userVerdict = 'supported'; });
      return { value: 'undecided', reason: 'no decisive result', citedNeeds: [], counterNotes: [], refutations: [], causal: 'not_applicable', assumptionStatus: [], confidence: 'low' };
    } } } });
    await r.runs.start(r.mapPath, locked());
    if (mark) assert.ok((await r.state()).hypotheses.some(h => h.userVerdict === 'supported'), 'the mark was set');
    return JSON.stringify(r.stat.requests.filter(x => ['comparison', 'conclusion', 'inference-check'].includes(x.name)).map(x => x.request.input));
  };
  const plainRun = await seen(false);
  const marked = await seen(true);
  assert.equal(marked, plainRun);
  assert.ok(!marked.includes('userVerdict'));
  assert.equal(typeof machine.applyUserVerdict, 'function');
});

test('worst case: sends back, a late alternative and undecidable results on both claims stay within WORST_CASE_AI_CALLS (counter fake)', async () => {
  const seen = [];
  const r = await rig({ script: { step: { comparison: request => {
    if (!seen.includes(request.input.claim.id)) seen.push(request.input.claim.id);
    const first = seen.indexOf(request.input.claim.id) === 0;
    if (request.input.comparison.attempts > 0) return { decision: 'rejudge', vetoes: [veto('contradiction', 'still contradicts')], allocations: [], rejudge: [] };
    return first
      ? { decision: 'add_alternative', vetoes: [veto('missed_alternative', 'one more reading')], allocations: [], rejudge: [] }
      : { decision: 'rejudge', vetoes: [veto('double_count', 'same source twice')], allocations: [], rejudge: [hypothesisIds(request)[0]] };
  } } } });
  await r.runs.start(r.mapPath, locked({ premises: { c1: ['rate'] }, testable: { c2: ['c1'], c3: ['c1'] } }));
  const s = await r.state();
  const calls = r.stat.steps.length + r.stat.ask.length + 1; // + the framing call the window made first
  assert.ok(calls <= model.WORST_CASE_AI_CALLS, `${calls} <= ${model.WORST_CASE_AI_CALLS}`);
  assert.equal(count(r, 'comparison') <= model.MAX_TESTABLE * model.MAX_COMPARISONS, true);
  assert.equal(r.stat.requests.filter(x => x.name === 'hypotheses' && x.request.mode === 'alternatives').length <= model.MAX_TESTABLE, true);
  assert.ok(s.hypotheses.every(h => (h.reverdicts ?? 0) <= model.MAX_REVERDICTS));
  assert.equal(await finished(r), 'finished/concluded/undecidable');
});
