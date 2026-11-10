// Argument map runner v2 (V5a): start, premises, research, source check, evidence assessment, stop and the refusals. Fake ports over the real
// repository fixture; the stage-3 actions (verdict onward) pause the run with an explicit pending error, tested here as the hook.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const legacyMachine = require('./support.cjs').load('core/argument-map/machine.ts');
const { rig, locked, run, model, QUOTE, URL_OK, plain, tick, defer, foundEntry } = require('./support-argument-run-v2.cjs');
const machine = require('./support.cjs').load('core/argument-map/machine-v2.ts');

const pendingStop = async r => { const s = await r.state(); return `${s.run.status}/${s.run.stopReason}`; };

test('start: one card per claim, datum, comparison, hypothesis and need with real ids; runs to the stage-3 hook; logs carry no text', async () => {
  const r = await rig();
  const out = await r.runs.start(r.mapPath, locked());
  assert.deepEqual(plain(out), { ok: true });
  const s = await r.state();
  assert.equal(s.run.phase, 'analysis');
  assert.equal(await pendingStop(r), 'paused/error', 'verdict is stage 3: the run pauses explicitly');
  assert.ok(r.log().includes('pending action=verdict'));
  assert.ok(!r.stat.steps.includes('verdict'));
  const premise = s.claims.find(c => c.role === 'premise');
  const testable = s.claims.find(c => c.role === 'testable');
  assert.ok(!/^c\d/.test(premise.id) && premise.id.startsWith('id-'), 'labels were replaced by real ids');
  assert.deepEqual(plain(testable.dependsOn), [premise.id], 'dependsOn is remapped');
  assert.equal(premise.result, 'holds');
  assert.equal(premise.data[0].proof.check, 'page_match');
  const doc = await r.repo.readMap(r.mapPath);
  const ids = doc.nodes.map(n => n.id);
  assert.equal(new Set(ids).size, ids.length);
  const own = [...Object.values(s.roles), ...s.claims.map(c => c.id), premise.data[0].id, testable.comparison.nodeId, ...s.hypotheses.map(h => h.id), ...s.hypotheses.flatMap(h => h.needs.map(n => n.id))];
  assert.equal(doc.nodes.length, own.length);
  for (const id of own) assert.ok(ids.includes(id), id);
  assert.equal(s.hypotheses.length, 2);
  assert.equal(s.run.researchCalls, 1 + 2);
  const log = r.log();
  assert.ok(log.includes('stats.example.org') && !log.includes(QUOTE) && !log.includes(URL_OK) && log.includes(`runId=${s.run.runId}`));
  assert.deepEqual(plain(s.framing), plain(locked().framing), 'the framing stays as locked');
  assert.equal(r.runs.isRunning(r.mapPath), false);
});

test('start refusals write nothing: legacy, unusable, existing map, unlocked framing, illegal breakdown', async () => {
  const cases = {
    legacy: async r => { const doc = await r.repo.readMap(r.mapPath); const ids = {}; for (const role of ['proposition', 'situation', 'conclusion', 'verified', 'eliminated']) { const n = await r.repo.createNote(role, 'model-a', doc, r.mapPath, 'workspace'); doc.nodes.push(n); ids[role] = n.id; } doc.argumentMap = legacyMachine.newArgumentMap(ids, 'run-1'); await r.repo.saveMap(r.mapPath, doc); },
    unusable: async r => { const doc = await r.repo.readMap(r.mapPath); doc.argumentMap = { v: 2, junk: true }; await r.repo.saveMap(r.mapPath, doc); }
  };
  for (const [refusal, prepare] of Object.entries(cases)) {
    const r = await rig();
    await prepare(r);
    const before = await r.snapshot();
    const read = model.readArgumentMap(await r.repo.readMap(r.mapPath)).kind;
    assert.ok(read === refusal, `${refusal} fixture reads as ${read}`);
    assert.deepEqual(plain(await r.runs.start(r.mapPath, locked())), { ok: false, refusal });
    assert.equal(await r.snapshot(), before, `${refusal}: map untouched`);
    assert.equal(r.stat.notes + r.stat.steps.length + r.stat.ask.length, 0, `${refusal}: no card, no provider call`);
  }
  const r = await rig();
  assert.deepEqual(plain(await r.runs.start(r.mapPath, locked({ lockedAt: '' }))), { ok: false, refusal: 'not_locked' });
  assert.deepEqual(plain(await r.runs.start(r.mapPath, locked({ testable: { c2: ['zz'] } }))), { ok: false, refusal: 'not_locked' });
  assert.equal(r.stat.notes, 0, 'an illegal breakdown creates no card');
  assert.equal(model.readArgumentMap(await r.repo.readMap(r.mapPath)).kind, 'absent');
  await r.runs.start(r.mapPath, locked());
  const done = await r.snapshot();
  assert.deepEqual(plain(await r.runs.start(r.mapPath, locked())), { ok: false, refusal: 'exists' });
  assert.equal(await r.snapshot(), done);
});

test('locked framing: the runner has no operation that edits the framing or the breakdown; a second start cannot replace it', async () => {
  const names = Object.getOwnPropertyNames(run.ArgumentRunsV2.prototype).filter(n => !n.startsWith('_') && n !== 'constructor');
  const privateByDesign = new Set(['t', 'makeNote', 'writeNote', 'drafts', 'guard', 'open', 'dead', 'go', 'usageAllowed', 'settle', 'fail', 'pause', 'loop', 'state', 'guarded', 'checkpoint', 'attach', 'base', 'ask', 'claimOf', 'pathOf', 'cardNote', 'textStep', 'afterPremise', 'proposeIds', 'propose', 'needs', 'slot', 'free', 'research', 'releaseFailed', 'commitEvidence']);
  assert.deepEqual(names.filter(n => !privateByDesign.has(n)).sort(), ['dispose', 'frame', 'isRunning', 'recover', 'resume', 'start', 'stop']);
  const r = await rig();
  await r.runs.start(r.mapPath, locked());
  const s = await r.state();
  const other = locked(); other.framing.restatement = 'something else entirely';
  assert.deepEqual(plain(await r.runs.start(r.mapPath, other)), { ok: false, refusal: 'exists' });
  assert.equal((await r.state()).framing.restatement, s.framing.restatement);
});

test('frame: one framing call, writes nothing, a failure is thrown, an attempt past the limit makes no provider call', async () => {
  const r = await rig({ script: { step: { framing: request => ({ restatement: `r${request.attempt}` }) } } });
  const before = await r.snapshot();
  const result = await r.runs.frame('Q', { note: 'n', attempt: 2, signal: new AbortController().signal });
  assert.equal(result.restatement, 'r2');
  assert.deepEqual(r.stat.requests.map(x => [x.name, x.request.original, x.request.note, x.request.attempt, x.request.usageMapPath]), [['framing', 'Q', 'n', 2, undefined]]);
  await assert.rejects(r.runs.frame('Q', { attempt: 4, signal: new AbortController().signal }), e => e.code === 'framing_limit');
  await assert.rejects(r.runs.frame('Q', { attempt: 0, signal: new AbortController().signal }), e => e.code === 'framing_limit');
  assert.equal(r.stat.steps.length, 1);
  const failing = await rig({ script: { step: { framing: () => { throw new Error('bad reply'); } } } });
  await assert.rejects(failing.runs.frame('Q', { attempt: 1, signal: new AbortController().signal }), /bad reply/);
  assert.equal(await r.snapshot(), before);
  assert.equal(failing.stat.notes, 0);
});

test('premise missing: no AI call; a failed premise stops only its dependents, the other premise and claim go on', async () => {
  const gone = foundEntry('x'); gone.status = 'not_found';
  const r = await rig({ script: { ask: async ctx => {
    const s = await r.state();
    const id = ctx.argumentEvidenceNeeds[0].id;
    const datum = s.claims.flatMap(c => c.data ?? []).find(d => d.id === id);
    const owner = s.claims.find(c => c.data?.some(d => d.id === id));
    if (owner && owner.text === 'claim c1') return { summary: '', detail: '', suggestions: [], visualReferences: [], evidence: { openedUrls: [] }, argumentEvidence: [{ ...gone, need: datum.id }] };
    return { summary: '', detail: '', suggestions: [], visualReferences: [], evidence: { openedUrls: [] }, argumentEvidence: [foundEntry(id)] };
  } } });
  await r.runs.start(r.mapPath, locked({ premises: { c1: ['a'], c2: ['b'] }, testable: { t1: ['c1'], t2: ['c2'] } }));
  const s = await r.state();
  const by = text => s.claims.find(c => c.text === text);
  assert.equal(by('claim c1').result, 'insufficient');
  assert.equal(by('claim c1').data[0].state, 'not_found');
  assert.equal(by('claim c2').result, 'holds');
  assert.equal(by('claim t1').status, 'not_evaluated');
  assert.notEqual(by('claim t2').status, 'not_evaluated');
  const assessed = r.stat.requests.filter(x => x.name === 'assessment').map(x => x.request.scope.claim);
  assert.ok(!assessed.includes('claim c1'), 'a premise with no data is not assessed (premise_missing: AI = 0)');
  assert.equal(r.stat.requests.filter(x => x.name === 'premise').length, 1, 'only the premise that has data is judged');
  const proposedFor = r.stat.requests.filter(x => x.name === 'hypotheses').map(x => x.request.claim.text);
  assert.deepEqual(proposedFor, ['claim t2'], 'the stopped claim gets no hypotheses');
  const stoppedPhase = r.stat.ask.map(c => c.task);
  assert.ok(!stoppedPhase.some(t => t.includes('t1')), 'research never touches the stopped claim');
});

test('every premise fails: the run stops on the premise, finished, the conclusion card says so, nothing else is called', async () => {
  const r = await rig({ script: { step: { premise: request => ({ result: 'insufficient', reason: 'cannot tell', citedData: [] }) } } });
  await r.runs.start(r.mapPath, locked());
  const s = await r.state();
  assert.equal(s.run.phase, 'stopped_premise');
  assert.equal(s.run.status, 'finished');
  assert.equal(s.claims.find(c => c.role === 'testable').status, 'not_evaluated');
  assert.equal(r.stat.steps.includes('hypotheses'), false);
  assert.ok(r.log().includes('stopped runId'));
  assert.deepEqual(plain(await r.runs.resume(r.mapPath)), { ok: false, refusal: 'finished' });
});

test('research limit: when the call budget runs out the program decides (AI = 0), no verdict step is asked', async () => {
  // The only need comes back not_found, so no required test is met: with the budget spent a complete test would still be the AI's, an incomplete one is the program's.
  const ask = (ctx, n) => ({ summary: '', detail: '', suggestions: [], visualReferences: [], evidence: { openedUrls: [] }, argumentEvidence: [n === 1 ? foundEntry(ctx.argumentEvidenceNeeds[0].id) : { need: ctx.argumentEvidenceNeeds[0].id, status: 'not_found' }] }); // call 1 is the premise
  const r = await rig({ script: { ask, step: { needs: async request => {
    await r.repo.updateMap(r.mapPath, doc => { doc.argumentMap.run.researchCalls = model.MAX_RESEARCH_CALLS - 1; });
    return { needs: request.hypothesis.predictions.filter(p => p.required).slice(0, request.max).map((p, i) => ({ id: request.ids[i], predictionId: p.id, text: `need for ${p.id}`, criteria: { supports: 's', refutes: 'r', irrelevant: 'i' } })) };
  } } } });
  await r.runs.start(r.mapPath, locked({ testable: { c2: ['c1'] } }));
  const s = await r.state();
  assert.equal(s.run.researchCalls, model.MAX_RESEARCH_CALLS);
  assert.ok(s.hypotheses.length >= 1);
  for (const h of s.hypotheses) { assert.equal(h.verdict.by, 'program'); assert.equal(h.verdict.value, 'insufficient'); }
  assert.ok(!r.stat.steps.includes('verdict'));
  assert.ok(r.log().includes('by=program'));
  assert.equal(r.stat.ask.length, 1, 'only the call that fit the budget went out');
});

test('unverified_quote (tool log only, page blocked) is kept but never satisfies a need; the premise cannot rest on it', async () => {
  let blocked = false;
  const fetch = request => (blocked ? { status: 403, headers: {}, text: '' } : { status: 200, headers: { 'content-type': 'text/html' }, text: `<p>${QUOTE}, the highest in a decade.</p>`, url: request.url });
  const withLog = { evidence: { openedUrls: [URL_OK] } };
  const ask = ctx => ({ summary: '', detail: '', suggestions: [], visualReferences: [], ...withLog, argumentEvidence: [foundEntry(ctx.argumentEvidenceNeeds[0].id)] });
  const base = require('./support-argument-run-v2.cjs').steps();
  const r = await rig({ fetch, script: { ask, step: { hypotheses: (request, n) => { blocked = true; return base.hypotheses(request, n); } } } });
  await r.runs.start(r.mapPath, locked());
  const s = await r.state();
  const needs = s.hypotheses.flatMap(h => h.needs);
  assert.ok(needs.length > 0 && needs.some(n => n.proof?.check === 'unverified_quote'));
  for (const h of s.hypotheses) assert.notEqual(machine.testStatus(h, s.run.researchCalls), 'complete', 'an unverified quote never completes a test');
  assert.ok(!r.stat.steps.includes('verdict'), 'it is not enough for an AI verdict');
  assert.match(r.log(), /argument-run unverified_quote runId=\S+ count=1 items=\S+@stats\.example\.org/);
  assert.ok(!r.log().includes(QUOTE));
  // a premise judged "holds" on such a datum is refused by the gate: the run pauses, the premise stays open
  const p = await rig({ ports: {}, fetch: () => ({ status: 403, headers: {}, text: '' }), script: { ask, step: { premise: request => ({ result: 'holds', reason: 'r', citedData: request.data.map(d => d.id) }) } } });
  await p.runs.start(p.mapPath, locked());
  const ps = await p.state();
  assert.equal(ps.claims.find(c => c.role === 'premise').status, 'in_progress');
  assert.equal(await pendingStop(p), 'paused/error');
});

test('stop aborts, pauses (user), puts searching items back; a late provider result writes nothing', async () => {
  const gate = defer();
  const r = await rig({ script: { ask: async (ctx) => { await gate.promise; return { summary: '', detail: '', suggestions: [], visualReferences: [], evidence: { openedUrls: [] }, argumentEvidence: [foundEntry(ctx.argumentEvidenceNeeds[0].id)] }; } } });
  const started = r.runs.start(r.mapPath, locked());
  for (let i = 0; i < 50 && r.stat.ask.length === 0; i++) await tick();
  assert.equal((await r.state()).claims.find(c => c.role === 'premise').data[0].state, 'searching');
  await r.runs.stop(r.mapPath);
  await started;
  const s = await r.state();
  assert.equal(await pendingStop(r), 'paused/user');
  assert.equal(s.claims.find(c => c.role === 'premise').data[0].state, 'pending');
  const after = await r.snapshot();
  gate.resolve();
  for (let i = 0; i < 20; i++) await tick();
  assert.equal(await r.snapshot(), after, 'the late result was dropped');
  assert.equal(r.runs.isRunning(r.mapPath), false);
});

test('provider failure (timeout) is not a try and never a miss: released once, a second failure pauses with error; resume continues', async () => {
  let fail = true;
  const r = await rig({ script: { ask: ctx => { if (fail) throw new Error('timeout'); return { summary: '', detail: '', suggestions: [], visualReferences: [], evidence: { openedUrls: [] }, argumentEvidence: [foundEntry(ctx.argumentEvidenceNeeds[0].id)] }; } } });
  await r.runs.start(r.mapPath, locked());
  let s = await r.state();
  const datum = () => s.claims.find(c => c.role === 'premise').data[0];
  assert.equal(await pendingStop(r), 'paused/error');
  assert.equal(datum().state, 'pending');
  assert.equal(datum().attempts, 0, 'the attempt was refunded');
  assert.equal(r.stat.ask.length, 2, 'one automatic retry');
  fail = false;
  assert.deepEqual(plain(await r.runs.resume(r.mapPath)), { ok: true });
  s = await r.state();
  assert.equal(datum().state, 'found');
  assert.equal(await pendingStop(r), 'paused/error', 'and then the stage-3 hook');
});

test('stale fence: a result for a run whose id changed meanwhile, and one after dispose, write nothing', async () => {
  const swap = await rig({ script: { ask: async ctx => {
    await r_swap.repo.updateMap(r_swap.mapPath, doc => { doc.argumentMap.run.runId = 'other'; });
    return { summary: '', detail: '', suggestions: [], visualReferences: [], evidence: { openedUrls: [] }, argumentEvidence: [foundEntry(ctx.argumentEvidenceNeeds[0].id)] };
  } } });
  const r_swap = swap;
  await swap.runs.start(swap.mapPath, locked());
  const s = await swap.state();
  assert.equal(s.run.runId, 'other');
  assert.equal(s.claims.find(c => c.role === 'premise').data[0].state, 'searching', 'the foreign run was not written to');
  const gate = defer();
  const r = await rig({ script: { ask: async ctx => { await gate.promise; return { summary: '', detail: '', suggestions: [], visualReferences: [], evidence: { openedUrls: [] }, argumentEvidence: [foundEntry(ctx.argumentEvidenceNeeds[0].id)] }; } } });
  const started = r.runs.start(r.mapPath, locked());
  for (let i = 0; i < 50 && r.stat.ask.length === 0; i++) await tick();
  r.runs.dispose();
  const frozen = await r.snapshot();
  gate.resolve();
  await started;
  for (let i = 0; i < 20; i++) await tick();
  assert.equal(await r.snapshot(), frozen);
  assert.deepEqual(plain(await r.runs.start(r.mapPath, locked())), { ok: false, refusal: 'disposed' });
  assert.deepEqual(plain(await r.runs.resume(r.mapPath)), { ok: false, refusal: 'disposed' });
  await assert.rejects(r.runs.frame('Q', { attempt: 1, signal: new AbortController().signal }), e => e.code === 'disposed');
});

test('resume refusals write nothing: missing, legacy, unusable, not paused, finished; busy while running', async () => {
  const r = await rig();
  assert.deepEqual(plain(await r.runs.resume(r.mapPath)), { ok: false, refusal: 'missing' });
  await r.runs.start(r.mapPath, locked());
  const paused = await r.snapshot();
  const doc = await r.repo.readMap(r.mapPath);
  const stored = doc.argumentMap;
  doc.argumentMap = { ...stored, run: { ...stored.run, status: 'running' } };
  await r.repo.saveMap(r.mapPath, doc);
  assert.deepEqual(plain(await r.runs.resume(r.mapPath)), { ok: false, refusal: 'not_paused' });
  doc.argumentMap = { v: 2, junk: 1 };
  await r.repo.saveMap(r.mapPath, doc);
  const junk = await r.snapshot();
  assert.deepEqual(plain(await r.runs.resume(r.mapPath)), { ok: false, refusal: 'unusable' });
  assert.equal(await r.snapshot(), junk);
  assert.ok(paused.length > 0);
});
