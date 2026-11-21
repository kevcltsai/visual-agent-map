// Picture-book pipeline state machine (02a): every transition, the 3-attempt rule, the whole-book plan stopping at planning,
// idempotent resume, the separate budget pause, dispose, stale results, and a close injected at every commit boundary.
// Plus the admission gate on the shared call layer: reserved before every provider request, absent = unchanged.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('./support.cjs');
const { load } = require('./support-replay.cjs');
const { loadWithAiCalls } = require('./support-ai-calls.cjs');
const machine = S.load('core/book-pipeline/machine.ts');
const model = S.load('core/book-pipeline/model.ts');
const budgetMod = S.load('core/book-pipeline/budget.ts');
const admission = S.load('core/admission.ts');

const plain = value => JSON.parse(JSON.stringify(value));
const NOW = '2026-11-16T00:00:00.000Z';
const IDS = ['a', 'b', 'c'];
// An older run (no trial): every card is planned before gate 1. The trial tests below build theirs with `trialRun`.
const fresh = (extra = {}) => { const state = machine.newBookPipeline({ runId: 'run-1', order: IDS, now: NOW, ...extra }); delete state.trial; return state; };
const trialRun = (order = IDS) => machine.newBookPipeline({ runId: 'run-t', order, now: NOW, trial: order.slice(0, 3) });
const none = () => Object.fromEntries(IDS.map(id => [id, undefined]));
const actionsOf = (state, stages, busy) => plain(machine.nextActions(state, stages, busy));
/** Runs `kind` for `nodeId` to success the way a runner would (dispatch, then commit). */
const succeed = (state, kind, nodeId) => { const d = machine.beginStep(state, kind, nodeId); return machine.applySuccess(d.state, d.token).state; };

test('a new run: planning, running, budget 300, no cards trusted; the whole-book plan comes first and alone', () => {
  const state = fresh();
  assert.deepEqual([state.phase, state.status, state.budget.used, state.budget.limit, state.globalPlanned], ['planning', 'running', 0, 300, false]);
  assert.deepEqual(actionsOf(state, none()), { actions: [{ type: 'global_plan' }] });
  assert.equal(model.readBookPipeline({ bookPipeline: plain(state) }).kind, 'usable');
  assert.throws(() => machine.newBookPipeline({ runId: 'r', order: [], now: NOW }));
  assert.throws(() => machine.newBookPipeline({ runId: 'r', order: ['global'], now: NOW }));
});

test('transitions: global plan, every card plan, gate 1, confirm, write, proof, gate 2, done', () => {
  let state = fresh();
  const stages = none();
  state = succeed(state, 'global');
  assert.equal(state.globalPlanned, true);
  assert.deepEqual(actionsOf(state, stages).actions.map(a => `${a.type}:${a.nodeId}`), ['card_plan:a', 'card_plan:b', 'card_plan:c']);
  for (const id of IDS) { state = succeed(state, 'plan', id); stages[id] = 'planned'; assert.equal(machine.cardRevision(state, id), 1); }
  assert.deepEqual(actionsOf(state, stages).actions, [{ type: 'advance_phase' }]);
  state = machine.advancePhase(state, stages, NOW);
  assert.equal(state.phase, 'gate1');
  assert.deepEqual(actionsOf(state, stages), { actions: [], hold: 'gate1' });
  assert.equal(machine.confirmGate1(fresh(), NOW).phase, 'planning', 'confirm outside gate 1 is a no-op');
  state = machine.confirmGate1(state, NOW);
  assert.equal(state.phase, 'writing');
  assert.deepEqual(actionsOf(state, stages).actions.map(a => `${a.type}:${a.nodeId}`), ['card_write:a', 'card_write:b', 'card_write:c']);
  for (const id of IDS) { state = succeed(state, 'write', id); stages[id] = 'written'; assert.equal(machine.cardRevision(state, id), 2); }
  assert.deepEqual(actionsOf(state, stages).actions.map(a => a.type), ['card_proof', 'card_proof', 'card_proof']);
  for (const id of IDS) { state = succeed(state, 'proof', id); stages[id] = 'checked'; assert.equal(machine.cardRevision(state, id), 2, 'a proof does not raise the revision'); }
  state = machine.advancePhase(state, stages, NOW);
  assert.equal(state.phase, 'gate2');
  assert.deepEqual(actionsOf(state, stages), { actions: [{ type: 'advance_phase' }] }, 'the final gate passes by itself');
  assert.equal(machine.advancePhase(state, stages, NOW).phase, 'done');
  state = machine.finishRun(state, NOW);
  assert.equal(state.phase, 'done');
  assert.deepEqual(actionsOf(state, stages), { actions: [], hold: 'done' });
});

test('a step takes at most 3 attempts; the third failure marks needs-review and the other cards go on', () => {
  let state = succeed(fresh(), 'global');
  const stages = none();
  for (let n = 1; n <= 3; n++) {
    const d = machine.beginStep(state, 'plan', 'b');
    assert.equal(machine.attemptsOf ? 0 : 0, 0);
    state = d.state;
    const failed = machine.applyFailure(state, d.token);
    state = failed.state;
    assert.equal(!!failed.needsReview, n === 3, `attempt ${n}`);
    if (n === 3) assert.deepEqual(plain(failed.needsReview), { nodeId: 'b', step: 'plan' });
  }
  assert.equal(machine.beginStep(state, 'plan', 'b'), null, 'a fourth attempt is refused');
  assert.equal(state.attempts.b.plan, 3);
  // The marking is written to the note; if the app closes before that, the next plan says so again.
  assert.deepEqual(actionsOf(state, stages).actions.map(a => `${a.type}:${a.nodeId}`), ['card_plan:a', 'mark_needs_review:b', 'card_plan:c']);
  stages.b = 'needs-review';
  assert.deepEqual(actionsOf(state, stages).actions.map(a => `${a.type}:${a.nodeId}`), ['card_plan:a', 'card_plan:c']);
  for (const id of ['a', 'c']) { state = succeed(state, 'plan', id); stages[id] = 'planned'; }
  assert.deepEqual(actionsOf(state, stages).actions, [{ type: 'advance_phase' }], 'a needs-review card does not hold the phase');
  state = machine.advancePhase(state, stages, NOW);
  assert.equal(state.phase, 'gate1');
});

test('each step has its own count: a write that failed twice does not use up the proof', () => {
  let state = succeed(fresh(), 'global');
  const stages = { a: 'planned', b: 'planned', c: 'planned' };
  state = { ...plain(state), phase: 'writing' };
  for (let n = 0; n < 2; n++) { const d = machine.beginStep(state, 'write', 'a'); state = machine.applyFailure(d.state, d.token).state; }
  state = succeed(state, 'write', 'a');
  assert.deepEqual(plain(model.attemptsOf(state, 'a')), { plan: 0, write: 3, proof: 0 });
  assert.notEqual(machine.beginStep(state, 'proof', 'a'), null);
});

test('the whole-book plan failing 3 times stops at planning with no card plan; retry starts over', () => {
  let state = fresh();
  for (let n = 1; n <= 3; n++) { const d = machine.beginStep(state, 'global'); state = machine.applyFailure(d.state, d.token).state; }
  assert.equal(state.attempts.global, 3);
  assert.deepEqual(actionsOf(state, none()), { actions: [], hold: 'global_failed' });
  assert.equal(state.phase, 'planning');
  assert.equal(machine.beginStep(state, 'global'), null);
  state = machine.retryGlobalPlan(state);
  assert.deepEqual(actionsOf(state, none()), { actions: [{ type: 'global_plan' }] });
});

test('a stop is not a failure: the attempt is given back, and resume re-derives the next steps from the stages', () => {
  let state = succeed(fresh(), 'global');
  const d = machine.beginStep(state, 'plan', 'a');
  assert.equal(d.state.attempts.a.plan, 1);
  state = machine.stopRun(d.state);
  assert.deepEqual(actionsOf(state, none()), { actions: [], hold: 'stopped' });
  const cancelled = machine.applyCancelled(state, d.token);
  assert.equal(cancelled.state.attempts.a.plan, 0);
  const resumed = machine.resumeRun(cancelled.state);
  assert.equal(resumed.status, 'running');
  assert.equal(machine.resumeRun(resumed), resumed, 'resume is idempotent on a running run');
  assert.deepEqual(actionsOf(resumed, none()).actions.map(a => a.nodeId), ['a', 'b', 'c']);
});

test('resume is idempotent: finished cards are not redone, pressing it twice changes nothing', () => {
  let state = succeed(fresh(), 'global');
  state = { ...plain(state), phase: 'writing' };
  const stages = { a: 'checked', b: 'written', c: 'needs-review' };
  state = machine.stopRun(state);
  const once = machine.resumeRun(state);
  const twice = machine.resumeRun(machine.resumeRun(state));
  assert.deepEqual(plain(once), plain(twice));
  assert.deepEqual(actionsOf(once, stages).actions, [{ type: 'card_proof', nodeId: 'b' }]);
  assert.deepEqual(actionsOf(once, stages), actionsOf(once, stages));
  assert.deepEqual(actionsOf(once, stages, new Set(['b'])).actions, [], 'a card in flight is skipped');
});

test('an interrupted run (running on disk, no drive) reads as stopped', () => {
  const state = machine.recoverInterrupted(fresh());
  assert.equal(state.status, 'stopped');
  assert.equal(state.pauseReason, undefined);
  assert.equal(machine.recoverInterrupted(state), state);
});

test('budget exhausted is its own pause: no failure count, no needs-review, attempt given back; add budget ends it', () => {
  let state = succeed(fresh({ budgetLimit: 5 }), 'global');
  const d = machine.beginStep(state, 'plan', 'a');
  const e = machine.beginStep(d.state, 'plan', 'b');
  const first = machine.applyBudgetExhausted(e.state, d.token);
  const second = machine.applyBudgetExhausted(first.state, e.token);
  state = second.state;
  assert.deepEqual([state.status, state.pauseReason], ['stopped', 'budget']);
  assert.deepEqual(plain(model.attemptsOf(state, 'a')), { plan: 0, write: 0, proof: 0 });
  assert.deepEqual(plain(model.attemptsOf(state, 'b')), { plan: 0, write: 0, proof: 0 });
  assert.deepEqual(actionsOf(state, none()), { actions: [], hold: 'budget' });
  assert.equal(machine.applyBudgetExhausted(machine.stopRun(fresh()), { ...d.token, runId: 'other' }).accepted, false);
  const full = { ...plain(state), budget: { used: 5, limit: 5 } };
  assert.equal(machine.resumeRun(full), null, 'resume is refused while the budget is used up');
  const raised = machine.addBudget(full, 100);
  assert.deepEqual([raised.status, raised.pauseReason, raised.budget.limit], ['running', undefined, 105]);
  assert.deepEqual(plain(machine.addBudget(raised, 0)), plain(raised));
  const owner = machine.stopRun(state);
  assert.equal(owner.pauseReason, undefined, 'an owner stop after a budget pause reads as a plain stop');
});

test('late results are dropped: stale run, stopped run, changed card revision, card gone from the map', () => {
  const base = succeed(fresh(), 'global');
  const d = machine.beginStep(base, 'plan', 'a');
  const dropped = result => { assert.equal(result.accepted, false); };
  dropped(machine.applySuccess(d.state, { ...d.token, runId: 'run-0' }));
  dropped(machine.applyFailure(d.state, { ...d.token, runId: 'run-0' }));
  dropped(machine.applySuccess(machine.stopRun(d.state), d.token));
  dropped(machine.applySuccess(machine.resetCard(d.state, 'a'), d.token));
  dropped(machine.applySuccess({ ...plain(d.state), order: ['b', 'c'] }, d.token));
  const accepted = machine.applySuccess(d.state, d.token);
  assert.equal(accepted.accepted, true);
  dropped(machine.applySuccess(accepted.state, d.token), 'the same result twice');
  assert.equal(machine.applySuccess(d.state, { ...d.token, revision: 0 }).state.revisions.a, 1);
  const stale = machine.applySuccess(d.state, { ...d.token, revision: 9 });
  assert.equal(stale.state, d.state, 'a dropped result returns the input untouched');
  // A proof dispatched before a rewrite cannot commit after it.
  const w = machine.beginStep({ ...plain(base), phase: 'writing' }, 'proof', 'b');
  dropped(machine.applySuccess(machine.applySuccess(machine.beginStep(w.state, 'write', 'b').state, { ...w.token, kind: 'write' }).state, w.token));
});

test('stop then resume: a result issued before the stop is dropped after the resume, even though the run is running again', () => {
  const base = succeed(fresh(), 'global');
  const old = machine.beginStep(base, 'plan', 'a');
  const stopped = machine.stopRun(old.state);
  assert.equal(stopped.stopEpoch, 1);
  const resumed = machine.resumeRun(stopped);
  assert.equal(resumed.status, 'running');
  for (const late of [machine.applySuccess(resumed, old.token), machine.applyFailure(resumed, old.token)]) { assert.equal(late.accepted, false); assert.equal(late.state, resumed); }
  const fresher = machine.beginStep(resumed, 'plan', 'a');
  assert.equal(fresher.token.stopEpoch, 1);
  assert.equal(machine.applySuccess(fresher.state, fresher.token).accepted, true, 'the step begun after the resume commits');
  // stop, resume, stop again, resume: the first result stays dropped
  const again = machine.resumeRun(machine.stopRun(fresher.state));
  assert.equal(again.stopEpoch, 2);
  assert.equal(machine.applySuccess(again, fresher.token).accepted, false);
  assert.equal(machine.stopRun(machine.stopRun(old.state)).stopEpoch, 1, 'a stop on a stopped run does not count again');
  assert.equal(model.readBookPipeline({ bookPipeline: plain(stopped) }).kind, 'usable');
  assert.equal(model.readBookPipeline({ bookPipeline: { ...plain(stopped), stopEpoch: -1 } }).kind, 'unusable');
  assert.equal(machine.applySuccess(base, { ...machine.beginStep(base, 'plan', 'a').token, stopEpoch: 0 }).accepted, true, 'a saved run without the field counts as 0');
});

test('reducers never touch their input', () => {
  const state = succeed(fresh(), 'global');
  const frozen = JSON.stringify(state);
  const d = machine.beginStep(state, 'plan', 'a');
  machine.applySuccess(d.state, d.token); machine.applyFailure(d.state, d.token); machine.applyCancelled(d.state, d.token);
  machine.applyBudgetExhausted(d.state, d.token); machine.stopRun(state); machine.addBudget(state, 5); machine.advancePhase(state, none(), NOW);
  assert.equal(JSON.stringify(state), frozen);
});

test('a new run clears stale stages first (never trusted across runs), idempotently', () => {
  let state = machine.newBookPipeline({ runId: 'run-2', order: IDS, now: NOW, staleStages: ['a', 'c'] });
  const stages = { a: 'checked', b: undefined, c: 'needs-review' };
  assert.deepEqual(actionsOf(state, stages).actions, [{ type: 'reset_stage', nodeId: 'a' }, { type: 'reset_stage', nodeId: 'c' }]);
  stages.a = undefined;
  state = machine.applyReset(state, 'a');
  assert.deepEqual(actionsOf(state, stages).actions, [{ type: 'reset_stage', nodeId: 'c' }]);
  stages.c = undefined;
  assert.deepEqual(actionsOf(state, stages).actions, [{ type: 'advance_phase' }], 'already clear: only bookkeeping left');
  state = machine.advancePhase(state, stages, NOW);
  assert.equal(state.pendingReset, undefined);
  assert.deepEqual(actionsOf(state, stages).actions, [{ type: 'global_plan' }]);
});

test('dispose: nothing is written after it, a late commit reports dropped, and the saved state is untouched', async () => {
  const saved = [];
  const store = new machine.PipelineStore(fresh(), async state => { await Promise.resolve(); saved.push(plain(state)); });
  const first = await store.commit(state => machine.beginStep(state, 'global'));
  assert.equal(saved.length, 1);
  const pending = store.commit(state => ({ state: machine.stopRun(state), accepted: true }));
  store.dispose();
  assert.equal(await pending, null, 'a commit queued before dispose is not written');
  assert.equal(await store.commit(state => machine.applySuccess(state, first.token)), null);
  assert.equal(saved.length, 1);
  assert.equal(store.isDisposed, true);
});

test('store: commits run one at a time in order; a rejected save keeps the old state and the queue goes on', async () => {
  let fail = true;
  const saved = [];
  const store = new machine.PipelineStore(fresh(), async state => { if (fail) { fail = false; throw new Error('disk'); } saved.push(state.revision); });
  const a = store.commit(state => machine.beginStep(state, 'global'));
  const b = store.commit(state => machine.beginStep(state, 'global'));
  await assert.rejects(a, /disk/);
  const second = await b;
  assert.equal(second.state.attempts.global, 1, 'the failed save did not become current');
  assert.deepEqual(saved, [1]);
  const noop = await store.commit(state => ({ state, accepted: true }));
  assert.equal(noop.accepted, true);
  assert.equal(saved.length, 1, 'an unchanged state is not saved again');
});

// --- A close injected at every commit boundary ------------------------------------------------------------------------------
class Crash extends Error {}
/**
 * A runner over fake notes: each step writes its note, then the stage, then commits the state, in that order (the real order of
 * the plan). `tick` is called at every boundary; the Nth call throws Crash, which is the app closing there. The "map file" and the
 * notes outlive the crash; the store does not.
 */
function world(order = IDS) {
  const w = { stages: Object.fromEntries(order.map(id => [id, undefined])), bodies: {}, plans: {}, proofs: [], globalPlans: 0, file: null, ticks: 0, crashAt: Infinity, failProofOnce: new Set() };
  w.file = JSON.stringify(machine.newBookPipeline({ runId: 'run-1', order, now: NOW }));
  w.tick = () => { if (++w.ticks === w.crashAt) throw new Crash('closed'); };
  return w;
}
async function drive(w, { opens = 'saved' } = {}) {
  let initial = JSON.parse(w.file);
  initial = machine.resumeRun(machine.recoverInterrupted(initial));
  const store = new machine.PipelineStore(initial, async state => { w.tick(); w.file = JSON.stringify(state); w.tick(); });
  for (let guard = 0; guard < 200; guard++) {
    const { actions, hold } = machine.nextActions(store.state, w.stages);
    if (hold === 'gate1') { await store.commit(state => ({ state: machine.confirmGate1(state, NOW), accepted: true })); continue; }
    if (hold === 'gate2') { await store.commit(state => ({ state: machine.finishRun(state, NOW), accepted: true })); continue; }
    if (hold) return hold;
    for (const action of actions) {
      if (action.type === 'advance_phase') { await store.commit(state => ({ state: machine.advancePhase(state, w.stages, NOW), accepted: true })); continue; }
      if (action.type === 'reset_stage') { w.tick(); w.stages[action.nodeId] = undefined; w.tick(); await store.commit(state => ({ state: machine.applyReset(state, action.nodeId), accepted: true })); continue; }
      if (action.type === 'mark_needs_review') { w.tick(); w.stages[action.nodeId] = 'needs-review'; w.tick(); continue; }
      const kind = action.type === 'global_plan' ? 'global' : action.type.slice(5);
      const dispatched = await store.commit(state => machine.beginStep(state, kind, action.nodeId) ?? { state, accepted: false });
      const token = dispatched?.token;
      if (!token) continue;
      w.tick();
      if (kind === 'global') { w.globalPlans++; w.tick(); }
      else if (kind === 'plan') { w.plans[action.nodeId] = `plan ${action.nodeId}`; w.tick(); w.stages[action.nodeId] = 'planned'; w.tick(); }
      else if (kind === 'write') { w.bodies[action.nodeId] = `body ${action.nodeId}`; w.tick(); w.stages[action.nodeId] = 'written'; w.tick(); }
      else {
        const key = `${token.runId}:${action.nodeId}:${token.revision}:${w.bodies[action.nodeId]}`;
        if (!w.proofs.includes(key)) w.proofs.push(key);
        w.tick();
        w.stages[action.nodeId] = 'checked';
        w.tick();
      }
      await store.commit(state => machine.applySuccess(state, token));
    }
  }
  throw new Error('did not settle');
}

test('closing the app at every commit boundary: resumes, loses nothing, appends each proof once', async () => {
  const clean = world();
  assert.equal(await drive(clean), 'done');
  const boundaries = clean.ticks;
  assert.ok(boundaries > 30, `many boundaries (${boundaries})`);
  assert.deepEqual(clean.proofs.length, 3);
  for (let at = 1; at <= boundaries; at++) {
    const w = world();
    w.crashAt = at;
    await assert.rejects(drive(w), Crash, `crash ${at}`);
    w.crashAt = Infinity;
    assert.equal(await drive(w), 'done', `resume after crash ${at}`);
    for (const id of IDS) {
      assert.equal(w.stages[id], 'checked', `crash ${at}: card ${id}`);
      assert.equal(w.bodies[id], `body ${id}`, `crash ${at}: body ${id} kept`);
      assert.equal(w.plans[id], `plan ${id}`, `crash ${at}: plan ${id} kept`);
    }
    assert.equal(new Set(w.proofs).size, w.proofs.length, `crash ${at}: no duplicate proof key`);
    assert.equal(w.proofs.length, 3, `crash ${at}: one proof record per card`);
    assert.ok(w.globalPlans >= 1, `crash ${at}: the whole-book plan was done`);
    assert.equal(JSON.parse(w.file).phase, 'done');
  }
});

test('a close mid-run then resume does not redo finished cards beyond the one step that was open', async () => {
  const w = world();
  w.crashAt = 40;
  await assert.rejects(drive(w), Crash);
  const stagesBefore = { ...w.stages };
  const proofsBefore = [...w.proofs];
  w.crashAt = Infinity;
  await drive(w);
  for (const id of IDS) if (stagesBefore[id] === 'checked') assert.ok(proofsBefore.some(k => k.includes(`:${id}:`)), 'a card already checked keeps its record');
  assert.equal(w.proofs.filter(k => k.includes(':a:')).length, 1);
});

test('stages from an older run are not trusted: the next run clears them before planning, and a close in between loses nothing', async () => {
  const w = world();
  assert.equal(await drive(w), 'done');
  const next = machine.newBookPipeline({ runId: 'run-2', order: IDS, now: NOW, staleStages: IDS });
  const clean = JSON.stringify(next);
  for (let at = 1; at < 60; at++) {
    const x = { ...w, stages: { ...w.stages }, proofs: [], plans: {}, bodies: {}, file: clean, ticks: 0, crashAt: at };
    x.tick = () => { if (++x.ticks === x.crashAt) throw new Crash('closed'); };
    let crashed = false;
    try { await drive(x); } catch (error) { if (!(error instanceof Crash)) throw error; crashed = true; }
    x.crashAt = Infinity;
    assert.equal(await drive(x), 'done', `at ${at}`);
    assert.deepEqual(IDS.map(id => x.stages[id]), ['checked', 'checked', 'checked']);
    assert.equal(x.proofs.length, 3, `at ${at}: proofs belong to run-2 only`);
    assert.ok(x.proofs.every(k => k.startsWith('run-2:')));
    if (!crashed) break;
  }
});

// --- Admission on the shared call layer --------------------------------------------------------------------------------------
const callsMod = loadWithAiCalls('core/step-runner.ts');
const step = { id: 'test.step', version: 1, render: () => 'the prompt', parse: raw => raw };
function callsRig(run) {
  const calls = [];
  const runtime = { capabilities: callsMod.CODEX_CAPABILITIES, run: async request => { calls.push(request); return run(request, calls.length); } };
  const aiCalls = new callsMod.AiCalls({ runtimeFor: () => runtime, exchanges: () => null });
  const send = (admissionContext, signal = new AbortController().signal) => aiCalls.run(callsMod.prepareStep(step, {}), { model: 'm', effort: 'low', topic: 't', taskName: 'x', signal, localCodex: true, ...(admissionContext ? { admission: admissionContext } : {}) }, raw => raw);
  return { calls, send };
}
const ctx = (used, limit) => {
  const port = { used, limit, persisted: [] };
  return { port, gate: budgetMod.createBudgetAdmission({ get: () => ({ used: port.used, limit: port.limit }), persist: async next => { port.persisted.push(next.used); port.used = next.used; } }) };
};

test('AiCalls: no admission context means no reservation and the call is exactly as before', async () => {
  const r = callsRig(() => 'ok');
  assert.equal(await r.send(), 'ok');
  assert.equal(r.calls.length, 1);
});

test('AiCalls: the call is reserved (and saved) before the provider is asked; an exhausted budget sends nothing', async () => {
  const c = ctx(0, 1);
  const r = callsRig(() => { assert.deepEqual(c.port.persisted, [1], 'saved before the provider call'); return 'ok'; });
  assert.equal(await r.send(c.gate), 'ok');
  await assert.rejects(r.send(c.gate), e => e.outcome === 'budget-exhausted' && admission.isBudgetExhausted(e));
  assert.equal(r.calls.length, 1, 'the refused call never reached the provider');
});

test('AiCalls: five parallel calls with one reservation left reach the provider once', async () => {
  const c = ctx(299, 300);
  const r = callsRig(async () => 'ok');
  const results = await Promise.allSettled([1, 2, 3, 4, 5].map(() => r.send(c.gate)));
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(r.calls.length, 1);
  assert.equal(c.port.used, 300);
});

test('AiCalls: a call already stopped does not take a reservation', async () => {
  const c = ctx(0, 5);
  const r = callsRig(() => 'ok');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(r.send(c.gate, controller.signal));
  assert.equal(c.port.used, 0);
  assert.equal(r.calls.length, 0);
});

// The service: an inner re-ask is a second provider call and takes a second reservation; a repair call refused for budget is not swallowed.
const { AiTaskService } = load('core/ai-task-service.ts');
const { searchNotPerformedError } = load('ai/search-not-performed.ts');
const templates = load('ai/detail-templates.ts');
const GOOD = JSON.stringify({ summary: 'S', detail: 'D', suggestions: [], visualReferences: [] });
const taskContext = (extra = {}) => ({ title: 'Topic', summary: 'Sum', rules: '', detail: '', task: 'Do the task', ancestors: '', sourceContext: '', mode: 'task', researchMode: 'local', researchDepth: 'fast', visualMode: 'off', ...extra });
function serviceRig(handler) {
  const calls = [];
  const runtime = { runTask: async (prompt, model, effort, schema, controls) => { const call = { n: calls.length + 1, controls }; calls.push(call); call.controls.onRequest?.({}); return handler(call); } };
  const service = new AiTaskService({ pluginDirectory: () => '/plugin', language: () => 'en', defaultReasoning: () => 'low', exchangeLoggingEnabled: () => false, exchanges: () => null, codexRuntime: () => runtime, claudeRuntime: () => runtime });
  return { service, calls };
}
const webEvent = { method: 'item/completed', params: { item: { type: 'webSearch', action: { type: 'search' } } } };

test('task service: the re-ask after no search takes its own reservation (inner retries count)', async () => {
  const c = ctx(0, 10);
  const r = serviceRig(call => { if (call.n === 1) throw searchNotPerformedError(); call.controls.onWebSearchEvent?.(webEvent); return GOOD; });
  const result = await r.service.askModel(taskContext({ researchMode: 'research', researchDepth: 'normal', admission: c.gate }), 'gpt-6-luna', 'low');
  assert.equal(result.summary, 'S');
  assert.equal(r.calls.length, 2);
  assert.equal(c.port.used, 2);
});

test('task service: budget exhausted passes through as its own outcome (not a note error) and the repair path does not swallow it', async () => {
  const template = templates.copyTemplate(templates.standardTemplate('zh-TW'), '教學', 't1');
  template.sections.splice(2, 0, { id: 'ex', name: '範例', description: '', role: 'none', count: { mode: 'exact', n: 3 }, aliases: [] });
  const detail = '### 核心結論\n\n- a\n\n### 範例\n\n- 1\n- 2';
  const c = ctx(0, 1);
  const r = serviceRig(() => JSON.stringify({ summary: 'S', detail, suggestions: [], visualReferences: [] }));
  await assert.rejects(r.service.askModel(taskContext({ language: 'zh-TW', outputLanguage: 'zh-TW', detailTemplate: template, admission: c.gate }), 'gpt-6-luna', 'low'), e => admission.isBudgetExhausted(e));
  assert.equal(r.calls.length, 1, 'the repair was refused before it was sent');
  assert.equal(c.port.used, 1);
  const plainRun = serviceRig(() => GOOD);
  assert.equal((await plainRun.service.askModel(taskContext(), 'gpt-6-luna', 'low')).summary, 'S', 'a task without a context is untouched');
});

test('another map\'s ordinary research is not affected when this map\'s budget is used up', async () => {
  const used = ctx(300, 300);
  const r = serviceRig(() => GOOD);
  await assert.rejects(r.service.askModel(taskContext({ admission: used.gate }), 'gpt-6-luna', 'low'), e => admission.isBudgetExhausted(e));
  assert.equal(r.calls.length, 0);
  assert.equal((await r.service.askModel(taskContext({ usageMapPath: 'other/Map.md' }), 'gpt-6-luna', 'low')).summary, 'S');
  assert.equal(r.calls.length, 1);
});

test('requestAutoFix: one redo per card, a revision rise, attempts kept, the use survives stop and resume; not outside writing or for an unknown card', () => {
  const writing = () => ({ ...plain(fresh()), phase: 'writing', globalPlanned: true });
  const state = writing();
  state.attempts.a = { plan: 1, write: 1, proof: 1 };
  const rev = machine.cardRevision(state, 'a');
  const first = machine.requestAutoFix(state, 'a');
  assert.equal(first.accepted, true);
  assert.equal(first.state.autoFixes.a, 1);
  assert.equal(machine.cardRevision(first.state, 'a'), rev + 1, 'a late result of the old round is stale');
  assert.deepEqual(plain(first.state.attempts.a), plain(state.attempts.a), 'attempts are not reset');
  assert.equal(state.autoFixes, undefined, 'the input is not changed');
  const stopped = machine.stopRun(first.state);
  assert.equal(machine.autoFixesOf(machine.resumeRun(stopped), 'a'), 1, 'stop and reopen never give another');
  const second = machine.requestAutoFix(first.state, 'a');
  assert.equal(second.accepted, false);
  assert.equal(second.state, first.state);
  assert.equal(machine.requestAutoFix(first.state, 'b').accepted, true, 'another card has its own');
  const spent = writing();
  spent.attempts.a = { plan: 1, write: 3, proof: 1 };
  assert.equal(machine.requestAutoFix(spent, 'a').accepted, false, 'a card with every write attempt used is refused');
  spent.attempts.a = { plan: 1, write: 1, proof: 3 };
  assert.equal(machine.requestAutoFix(spent, 'a').accepted, false, 'and one with every proof attempt used');
  assert.equal(machine.requestAutoFix(state, 'zzz').accepted, false);
  assert.equal(machine.requestAutoFix(machine.stopRun(state), 'a').accepted, false);
  assert.equal(machine.requestAutoFix(fresh(), 'a').accepted, false, 'planning phase');
  assert.equal(model.readBookPipeline({ bookPipeline: plain(first.state) }).kind, 'usable');
});

test('trial: a new run carries the first three cards; every card is planned first, then only the trial cards are written and proofread before gate 1, then the rest after the confirmation', () => {
  const order = ['a', 'b', 'c', 'd', 'e'];
  let state = trialRun(order);
  assert.deepEqual(state.trial, ['a', 'b', 'c']);
  assert.equal(model.readBookPipeline({ bookPipeline: plain(state) }).kind, 'usable');
  assert.deepEqual(trialRun(['a', 'b']).trial, ['a', 'b'], 'fewer than three: all of them');
  const stages = Object.fromEntries(order.map(id => [id, undefined]));
  state = succeed(state, 'global');
  assert.deepEqual(actionsOf(state, stages).actions.map(a => `${a.type}:${a.nodeId}`), ['card_plan:a', 'card_plan:b', 'card_plan:c', 'card_plan:d', 'card_plan:e'], 'every card is planned first, the trial too');
  for (const id of ['a', 'b', 'c', 'd']) { state = succeed(state, 'plan', id); stages[id] = 'planned'; }
  assert.deepEqual(actionsOf(state, stages, new Set(['e'])).actions, [], 'no chapter is written while another is still being planned');
  state = succeed(state, 'plan', 'e'); stages.e = 'planned';
  assert.equal(state.planReview, true, 'a new run waits at the plan review');
  assert.deepEqual(actionsOf(state, stages).actions, [{ type: 'advance_phase' }], 'nothing is written before the owner saw the plan');
  state = machine.advancePhase(state, stages, NOW);
  assert.equal(state.phase, 'gate1');
  assert.equal(machine.backToPlan(state, NOW), state, 'already at the plan: a no-op');
  state = machine.startTrial(state, NOW);
  assert.equal(state.phase, 'planning'); assert.equal(state.planReview, undefined);
  assert.equal(machine.startTrial(state, NOW), state, 'not at the plan review: a no-op');
  assert.deepEqual(actionsOf(state, stages).actions.map(a => `${a.type}:${a.nodeId}`), ['card_write:a', 'card_write:b', 'card_write:c'], 'the trial goes on to the author while the phase is still planning');
  assert.equal(state.phase, 'planning');
  for (const id of ['a', 'b', 'c']) { state = succeed(state, 'write', id); stages[id] = 'written'; }
  assert.deepEqual(actionsOf(state, stages).actions.map(a => a.type), ['card_proof', 'card_proof', 'card_proof']);
  for (const id of ['a', 'b']) { state = succeed(state, 'proof', id); stages[id] = 'checked'; }
  assert.equal(machine.advancePhase(state, stages, NOW).phase, 'planning', 'one trial card is still unproofed');
  state = succeed(state, 'proof', 'c'); stages.c = 'needs-review';
  assert.deepEqual(actionsOf(state, stages).actions, [{ type: 'advance_phase' }]);
  state = machine.advancePhase(state, stages, NOW);
  assert.equal(state.phase, 'gate1', 'a needs-review trial card does not hold gate 1 back');
  assert.deepEqual(actionsOf(state, stages), { actions: [{ type: 'advance_phase' }] }, 'the trial gate passes by itself');
  const back = machine.backToPlan(state, NOW);
  assert.equal(back.phase, 'gate1'); assert.equal(back.planReview, true, 'back to the plan review');
  assert.deepEqual(actionsOf(back, stages), { actions: [], hold: 'gate1' }, 'the plan review still waits');
  assert.deepEqual(plain(back.attempts.a), { plan: 0, write: 0, proof: 0 }, 'the trial counters start over');
  assert.equal(machine.cardRevision(back, 'a'), machine.cardRevision(state, 'a') + 1, 'a result still in flight can no longer commit');
  state = machine.confirmGate1(state, NOW);
  assert.deepEqual(actionsOf(state, stages).actions.map(a => `${a.type}:${a.nodeId}`), ['card_write:d', 'card_write:e'], 'after the confirmation the trial cards start no further call');
});

test('plan review: "skip the trial" confirms gate 1 without a trial, and every chapter is written in the writing phase', () => {
  const order = ['a', 'b', 'c', 'd'];
  let state = succeed(trialRun(order), 'global');
  const stages = Object.fromEntries(order.map(id => [id, 'planned']));
  state = machine.advancePhase(state, stages, NOW);
  assert.equal(state.phase, 'gate1'); assert.equal(state.planReview, true);
  state = machine.confirmGate1(state, NOW);
  assert.equal(state.phase, 'writing'); assert.equal(state.trial, undefined); assert.equal(state.planReview, undefined);
  assert.deepEqual(actionsOf(state, stages).actions.map(a => `${a.type}:${a.nodeId}`), ['card_write:a', 'card_write:b', 'card_write:c', 'card_write:d']);
  assert.equal(model.readBookPipeline({ bookPipeline: { ...plain(trialRun(order)), planReview: false } }).kind !== 'usable', true, 'planReview is true or absent');
});

test('trial: the whole-book plan must be done first, and a one-card or three-card book goes straight from the trial to gate 2 after the confirmation', () => {
  let state = trialRun(['a', 'b']);
  assert.deepEqual(actionsOf(state, { a: undefined, b: undefined }), { actions: [{ type: 'global_plan' }] });
  state = succeed(state, 'global');
  const stages = { a: 'checked', b: 'checked' };
  state = machine.advancePhase(state, stages, NOW);
  assert.equal(state.phase, 'gate1');
  state = machine.confirmGate1(state, NOW);
  assert.deepEqual(actionsOf(state, stages).actions, [{ type: 'advance_phase' }]);
  assert.equal(machine.advancePhase(state, stages, NOW).phase, 'gate2');
});

test('retryTrial: back to planning with only the trial cards reset (stage cleared first, attempts, automatic redo, revision); a no-op outside gate 1 or without a trial', () => {
  const order = ['a', 'b', 'c', 'd'];
  let state = succeed(trialRun(order), 'global');
  const stages = { a: 'checked', b: 'needs-review', c: 'checked', d: undefined };
  state.attempts.a = { plan: 1, write: 3, proof: 1 };
  state.autoFixes = { a: 1, d: 1 };
  state.revisions.a = 2;
  state.phase = 'gate1';
  const before = plain(state);
  const retried = machine.retryTrial(state, NOW);
  assert.deepEqual(plain(state), before, 'the input is left alone');
  assert.equal(retried.phase, 'planning');
  assert.deepEqual(plain(retried.pendingReset), ['a', 'b', 'c']);
  assert.deepEqual(plain(retried.attempts.a), { plan: 0, write: 0, proof: 0 });
  assert.equal(retried.autoFixes.a, undefined);
  assert.equal(retried.autoFixes.d, 1, 'a card outside the trial keeps its own');
  assert.equal(machine.cardRevision(retried, 'a'), 3, 'a result still in flight can no longer commit');
  assert.equal(retried.globalPlanned, true, 'the whole-book plan stays');
  assert.deepEqual(actionsOf(retried, stages).actions.map(a => `${a.type}:${a.nodeId}`), ['reset_stage:a', 'reset_stage:b', 'reset_stage:c']);
  const cleared = { a: undefined, b: undefined, c: undefined, d: 'planned' };
  let next = retried;
  for (const id of ['a', 'b', 'c']) next = machine.applyReset(next, id);
  assert.deepEqual(actionsOf(next, cleared).actions.map(a => `${a.type}:${a.nodeId}`), ['card_plan:a', 'card_plan:b', 'card_plan:c'], 'the card outside the trial keeps its plan');
  assert.equal(machine.retryTrial(succeed(trialRun(order), 'global'), NOW).phase, 'planning', 'not at gate 1: no-op');
  const old = fresh(); old.phase = 'gate1';
  assert.equal(machine.retryTrial(old, NOW), old, 'an older run has no trial to retry');
  assert.equal(machine.retryTrial(machine.stopRun(state), NOW).phase, 'gate1', 'a stopped run is not retried');
});

test('trial: the one automatic redo is allowed for a trial card while planning, not for another card, and the use is kept', () => {
  const order = ['a', 'b', 'c', 'd'];
  const state = succeed(trialRun(order), 'global');
  const done = machine.requestAutoFix(state, 'a');
  assert.equal(done.accepted, true);
  assert.equal(machine.autoFixesOf(done.state, 'a'), 1);
  assert.equal(machine.requestAutoFix(state, 'd').accepted, false, 'd is not a trial card and the run is not writing');
});

test('model: trial must be a list of ids that are in the order; an older run without it stays usable', () => {
  const ok = plain(trialRun());
  assert.equal(model.readBookPipeline({ bookPipeline: ok }).kind, 'usable');
  assert.equal(model.readBookPipeline({ bookPipeline: { ...ok, trial: ['zzz'] } }).reason, 'trial');
  assert.equal(model.readBookPipeline({ bookPipeline: { ...ok, trial: 'a' } }).reason, 'trial');
  assert.equal(model.readBookPipeline({ bookPipeline: { ...ok, trial: [1] } }).reason, 'trial');
  const old = { ...ok }; delete old.trial;
  assert.equal(model.readBookPipeline({ bookPipeline: old }).kind, 'usable');
});

test('map change: acceptMapChange with every trial card removed refills the trial from what remains and gate 1 goes back to planning', () => {
  const order = ['a', 'b', 'c', 'd', 'e'];
  const gate = { ...plain(trialRun(order)), phase: 'gate1' };
  const paused = machine.pauseForMap(gate, { added: [], missing: ['a', 'b', 'c'] });
  assert.deepEqual([paused.status, paused.pauseReason], ['stopped', 'map']);
  const next = machine.acceptMapChange(paused, ['d', 'e'], 'later');
  assert.deepEqual(plain(next.removed), ['a', 'b', 'c']);
  assert.deepEqual(plain(next.trial), ['d', 'e']);
  assert.deepEqual([next.phase, next.phaseStartedAt, next.status, next.pauseReason, next.changed], ['planning', 'later', 'running', undefined, undefined]);
  assert.deepEqual(plain(next.accepted), ['d', 'e']);
  assert.deepEqual(plain(model.effectiveOrder(next)), ['d', 'e']);
  assert.equal(model.readBookPipeline({ bookPipeline: plain(next) }).kind, 'usable');
  // Only some trial cards removed: the trial stays, the phase stays.
  const some = machine.acceptMapChange(machine.pauseForMap(gate, { added: [], missing: ['a'] }), ['b', 'c', 'd', 'e'], 'later');
  assert.deepEqual([plain(some.trial), some.phase], [['a', 'b', 'c'], 'gate1']);
});

test('map change: effectiveOrder and mapDifference on older data (no accepted/removed/ignored) fall back to order', () => {
  const old = plain(fresh());
  for (const key of ['accepted', 'ignored', 'removed', 'changed']) delete old[key];
  assert.deepEqual(plain(model.effectiveOrder(old)), IDS);
  assert.deepEqual(plain(model.mapDifference(old, ['a', 'b', 'c'])), { added: [], missing: [] });
  assert.deepEqual(plain(model.mapDifference(old, ['b', 'c', 'x'])), { added: ['x'], missing: ['a'] });
  assert.deepEqual(plain(model.effectiveOrder({ order: IDS, removed: ['b'] })), ['a', 'c']);
  assert.equal(model.readBookPipeline({ bookPipeline: old }).kind, 'usable');
});

test('map change: the new fields are validated when present and optional when absent', () => {
  const ok = plain(fresh());
  for (const bad of [{ accepted: 'a' }, { ignored: [1] }, { removed: [''] }, { pauseReason: 'other' }, { changed: { added: 'x', missing: [] } }, { changed: { added: [], missing: [3] } }, { chapters: 'x' }, { chapters: { a: { title: 1, path: 'a.md' } } }, { chapters: { a: { title: 'A' } } }]) {
    assert.equal(model.readBookPipeline({ bookPipeline: { ...ok, ...bad } }).kind, 'unusable', JSON.stringify(bad));
  }
  assert.equal(model.readBookPipeline({ bookPipeline: { ...ok, pauseReason: 'map', changed: { added: ['x'], missing: [] }, removed: ['a'], ignored: ['x'], accepted: ['a'] } }).kind, 'usable');
  assert.equal(model.readBookPipeline({ bookPipeline: { ...ok, chapters: { a: { title: 'A', path: 'a.md' } } } }).kind, 'usable');
});

test('expand passes: useExpandPass counts per card, stops at BOOK_EXPAND_PASSES, survives a reopen and starts over with the card reset', () => {
  const state = { v: 1, runId: 'r', phase: 'writing', status: 'running', order: ['a'], globalPlanned: true, attempts: { global: 1, a: { plan: 1, write: 1, proof: 0 } }, revisions: { a: 0 }, budget: { used: 1, limit: 300 }, revision: 1, startedAt: 'x', phaseStartedAt: 'x' };
  const one = machine.useExpandPass(state, 'a');
  assert.equal(one.accepted, true);
  const two = machine.useExpandPass(one.state, 'a');
  assert.equal(two.accepted, true);
  assert.equal(machine.expandPassesOf(two.state, 'a'), 2);
  assert.equal(machine.useExpandPass(two.state, 'a').accepted, false, 'the cap is per chapter and run');
  assert.equal(machine.useExpandPass(two.state, 'b').accepted, true, 'another chapter has its own');
  assert.equal(machine.expandPassesOf(machine.resetCard(two.state, 'a'), 'a'), 0);
});

// ---- The independent AI proofread: chapter and book steps, rounds, fences, old saves ------------------------------------------------
const AI = { aiProof: true };
const checkedRun = (extra = {}) => {
  const order = ['a', 'b'];
  let state = machine.newBookPipeline({ runId: 'run-ai', order, now: NOW, ...extra });
  delete state.trial; delete state.planReview;
  state = { ...state, phase: 'writing', globalPlanned: true };
  return { state, stages: { a: 'checked', b: 'checked' } };
};
const pending = (id = 'P1') => ({ id, quote: 'q', problem: 'p', suggestion: 's' });
const begin = (state, scope, key, step) => { const d = machine.beginAiStep(state, scope, key, step); assert.ok(d, `begin ${step}`); return d; };

test('ai proof: a checked chapter gets ai_proof; with fixable problems the rounds go proof, fix, proof, fix, proof and stop at MAX_AI_FIX_ROUNDS', () => {
  assert.equal(model.MAX_AI_FIX_ROUNDS, 2);
  const { state: start, stages } = checkedRun();
  assert.deepEqual(plain(machine.nextActions(start, stages, new Set(), AI).actions), [{ type: 'ai_proof', nodeId: 'a' }, { type: 'ai_proof', nodeId: 'b' }]);
  assert.deepEqual(plain(machine.nextActions(start, stages, new Set(['a']), AI).actions), [{ type: 'ai_proof', nodeId: 'b' }], 'a chapter in flight is skipped');
  assert.deepEqual(plain(machine.nextActions(start, stages)).actions, [{ type: 'advance_phase' }], 'without the option the run is as before');
  let state = start;
  const seen = [];
  let key = 'k0';
  for (let round = 0; round < 3; round++) {
    const p = begin(state, { nodeId: 'a' }, key, 'proof');
    assert.equal(p.token.round, round);
    const res = machine.applyAiProof(p.state, p.token, { checked: 3, pending: [pending()], open: [] });
    assert.equal(res.accepted, true);
    state = res.state;
    seen.push(state.aiProof.a.step);
    if (state.aiProof.a.done) break;
    assert.equal(plain(machine.nextActions(state, stages, new Set(), AI).actions)[0].type, 'ai_fix');
    const f = begin(state, { nodeId: 'a' }, key, 'fix');
    key = `k${round + 1}`;
    const fixed = machine.applyAiFix(f.state, f.token, { applied: 1, replacements: ['qq'], key, changed: ['a'] });
    state = fixed.state;
    assert.equal(machine.cardRevision(state, 'a'), machine.cardRevision(start, 'a') + round + 1, 'a fix that wrote raises the revision');
  }
  assert.deepEqual(seen, ['fix', 'fix', 'proof'], 'proof, fix, proof, fix, proof');
  const done = state.aiProof.a;
  assert.deepEqual([done.done, done.round, done.fixed, done.checked], [true, 2, 2, 3]);
  assert.deepEqual(plain(done.open), [{ id: 'P1', quote: 'q', problem: 'p', reason: 'still_present' }], 'a problem still reported after the last round stays open');
  assert.equal(model.readBookPipeline({ bookPipeline: plain(state) }).kind, 'usable');
  assert.deepEqual(plain(machine.nextActions(state, stages, new Set(['b']), AI).actions), [], 'a finished chapter asks for nothing');
});

test('ai proof: nothing fixable ends the chapter at once; unfixable items are kept as open with their own reason, a blocked fix keeps its reason', () => {
  const { state: start } = checkedRun();
  const p = begin(start, { nodeId: 'a' }, 'k0', 'proof');
  const res = machine.applyAiProof(p.state, p.token, { checked: 2, pending: [], open: [{ id: 'P2', quote: 'x', problem: 'y', reason: 'sources_conflict' }] });
  assert.deepEqual([res.state.aiProof.a.done, res.state.aiProof.a.round], [true, 0]);
  assert.deepEqual(plain(res.state.aiProof.a.open), [{ id: 'P2', quote: 'x', problem: 'y', reason: 'sources_conflict' }]);
  const q = begin(start, { nodeId: 'b' }, 'k0', 'proof');
  let state = machine.applyAiProof(q.state, q.token, { checked: 1, pending: [pending()], open: [] }).state;
  const f = begin(state, { nodeId: 'b' }, 'k0', 'fix');
  state = machine.applyAiFix(f.state, f.token, { applied: 0, refused: { P1: 'fix_refused_picture' } }).state;
  assert.equal(machine.cardRevision(state, 'b'), 0, 'nothing written: the revision does not move');
  for (let n = 0; n < 2; n++) {
    const r = begin(state, { nodeId: 'b' }, 'k0', 'proof');
    state = machine.applyAiProof(r.state, r.token, { checked: 1, pending: [pending()], open: [] }).state;
    if (state.aiProof.b.done) break;
    const g = begin(state, { nodeId: 'b' }, 'k0', 'fix');
    state = machine.applyAiFix(g.state, g.token, { applied: 0 }).state;
  }
  assert.equal(state.aiProof.b.open[0].reason, 'fix_refused_picture');
});

test('ai proof: three failed checks end it as incomplete (never solved); three failed fixes leave the problems open as fix_failed and open no further round', () => {
  const { state: start } = checkedRun();
  let state = start;
  for (let n = 1; n <= 3; n++) {
    const p = begin(state, { nodeId: 'a' }, 'k0', 'proof');
    assert.equal(p.state.aiProof.a.attempts, n);
    const r = machine.applyAiFailure(p.state, p.token);
    state = r.state;
    assert.equal(!!r.finished, n === 3);
  }
  assert.deepEqual([state.aiProof.a.done, state.aiProof.a.incomplete], [true, true]);
  assert.equal(machine.beginAiStep(state, { nodeId: 'a' }, 'k0', 'proof'), null, 'a finished proofread does not start again');
  let s2 = start;
  const p = begin(s2, { nodeId: 'b' }, 'k0', 'proof');
  s2 = machine.applyAiProof(p.state, p.token, { checked: 1, pending: [pending()], open: [] }).state;
  for (let n = 1; n <= 3; n++) {
    const f = begin(s2, { nodeId: 'b' }, 'k0', 'fix');
    s2 = machine.applyAiFailure(f.state, f.token).state;
  }
  assert.deepEqual([s2.aiProof.b.done, s2.aiProof.b.incomplete, s2.aiProof.b.round], [true, undefined, 0]);
  assert.deepEqual(plain(s2.aiProof.b.open.map(item => item.reason)), ['fix_failed']);
});

test('ai proof: a stop or a changed text drops the result and gives the attempt back; a budget pause resumes at the same step without repeating the fix', () => {
  const { state: start } = checkedRun();
  const p = begin(start, { nodeId: 'a' }, 'k0', 'proof');
  const stopped = machine.stopRun(p.state);
  assert.equal(machine.applyAiProof(stopped, p.token, { checked: 1, pending: [], open: [] }).accepted, false, 'late result after a stop');
  assert.equal(machine.applyAiStopped(stopped, p.token, false).state.aiProof.a.attempts, 0, 'attempt given back');
  const resumed = machine.resumeRun(machine.applyAiStopped(stopped, p.token, false).state);
  assert.equal(machine.applyAiProof(resumed, p.token, { checked: 1, pending: [], open: [] }).accepted, false, 'a result from before the stop never commits after the resume');
  const hand = { ...p.state, revisions: { ...p.state.revisions, a: 5 } };
  assert.equal(machine.applyAiProof(hand, p.token, { checked: 1, pending: [], open: [] }).accepted, false, 'revision changed: dropped');
  const wrongStep = machine.applyAiFix(p.state, { ...p.token, step: 'fix' }, { applied: 1 });
  assert.equal(wrongStep.accepted, false);
  // Budget during a fix: the run pauses, the attempt comes back, and the resume starts the fix again (once) instead of a new proof.
  let state = machine.applyAiProof(p.state, p.token, { checked: 2, pending: [pending()], open: [] }).state;
  const f = begin(state, { nodeId: 'a' }, 'k0', 'fix');
  const paused = machine.applyAiStopped(f.state, f.token, true).state;
  assert.deepEqual([paused.status, paused.pauseReason, paused.aiProof.a.attempts, paused.aiProof.a.step], ['stopped', 'budget', 0, 'fix']);
  assert.deepEqual(plain(machine.nextActions(paused, { a: 'checked', b: 'checked' }, new Set(), AI)), { actions: [], hold: 'budget' });
  const back = machine.resumeRun(machine.addBudget(paused, 10));
  assert.equal(plain(machine.nextActions(back, { a: 'checked', b: 'checked' }, new Set(), AI).actions)[0].type, 'ai_fix');
  // A changed text starts a chapter's proofread over from the check.
  const fresh2 = machine.beginAiStep(back, { nodeId: 'a' }, 'other', 'proof');
  assert.deepEqual([fresh2.state.aiProof.a.round, fresh2.state.aiProof.a.attempts], [0, 1]);
  assert.equal(machine.beginAiStep(back, { nodeId: 'a' }, 'other', 'fix'), null, 'a fix needs the proof that asked for it');
});

test('ai proof: the book proofread starts after every chapter is done; once begun the chapter proofreads do not reopen (no loop); its fix never calls the author', () => {
  const { state: start, stages } = checkedRun();
  let state = start;
  for (const id of ['a', 'b']) {
    const p = begin(state, { nodeId: id }, 'k0', 'proof');
    state = machine.applyAiProof(p.state, p.token, { checked: 1, pending: [], open: [] }).state;
  }
  assert.deepEqual(plain(machine.nextActions(state, stages, new Set(['#book-proof']), AI).actions), [], 'busy book proofread');
  assert.deepEqual(plain(machine.nextActions(state, stages, new Set(), AI).actions), [{ type: 'book_ai_proof' }]);
  const b = begin(state, {}, 'bk0', 'proof');
  assert.equal(b.token.nodeId, undefined);
  state = machine.applyAiProof(b.state, b.token, { checked: 4, pending: [{ ...pending(), chapter: 1 }], open: [] }).state;
  assert.deepEqual(plain(machine.nextActions(state, stages, new Set(), AI).actions), [{ type: 'book_ai_fix' }]);
  const f = begin(state, {}, 'bk0', 'fix');
  state = machine.applyAiFix(f.state, f.token, { applied: 1, key: 'bk1', changed: ['a'] }).state;
  assert.equal(machine.cardRevision(state, 'a'), 1, 'a cross-chapter fix raises the revision of the chapter it changed');
  assert.equal(machine.aiChapterDue(state, 'a'), false);
  const reopened = { ...state, aiProof: {} };
  assert.deepEqual(plain(machine.nextActions(reopened, stages, new Set(), AI).actions), [{ type: 'book_ai_proof' }], 'a chapter without a record is not proofread again once the book one began');
  const r = begin(state, {}, 'bk1', 'proof');
  state = machine.applyAiProof(r.state, r.token, { checked: 4, pending: [], open: [] }).state;
  assert.equal(state.bookProof.done, true);
  assert.deepEqual(plain(machine.nextActions(state, stages, new Set(), AI).actions), [{ type: 'advance_phase' }]);
  assert.equal(machine.advancePhase(state, stages, NOW).phase, 'gate2');
  assert.equal(model.readBookPipeline({ bookPipeline: plain(state) }).kind, 'usable');
});

test('ai proof: a chapter that needs a person is proofread too (R1 T1); a trial chapter is proofread before the trial gate passes; a plan review waits', () => {
  const run = trialRun(['a', 'b', 'c', 'd']);
  let state = { ...run, phase: 'planning', globalPlanned: true };
  delete state.planReview;
  const stages = { a: 'checked', b: 'needs-review', c: 'checked', d: 'planned' };
  assert.deepEqual(plain(machine.nextActions(state, stages, new Set(), AI).actions), [{ type: 'ai_proof', nodeId: 'a' }, { type: 'ai_proof', nodeId: 'b' }, { type: 'ai_proof', nodeId: 'c' }], 'the trial chapters, the needs-review one too');
  assert.equal(machine.aiChapterDue({ ...state, planReview: true }, 'a'), false, 'nothing is proofread at the plan review');
  assert.deepEqual(plain(machine.nextActions({ ...state, phase: 'gate1', planReview: true }, stages, new Set(), AI)), { actions: [], hold: 'gate1' });
});

test('old saves: a run parked at gate2 does the whole-book proofread and then finishes; a trial gate1 goes on; the plan review still waits; consistency stays readable', () => {
  const { state: start, stages } = checkedRun();
  const consistency = { key: 'x', attempts: 1, done: true, findings: [] };
  const old = { ...start, phase: 'gate2', consistency };
  assert.equal(model.readBookPipeline({ bookPipeline: plain(old) }).kind, 'usable', 'consistency field still reads');
  assert.deepEqual(plain(machine.nextActions(old, stages, new Set(), AI).actions), [{ type: 'book_ai_proof' }], 'no chapter proofread for an old gate2 run');
  assert.deepEqual(plain(machine.nextActions(old, stages, new Set(['#book-proof']), AI).actions), []);
  const b = begin(old, {}, 'bk', 'proof');
  const done = machine.applyAiProof(b.state, b.token, { checked: 0, pending: [], open: [] }).state;
  assert.deepEqual(plain(machine.nextActions(done, stages, new Set(), AI).actions), [{ type: 'advance_phase' }]);
  assert.equal(machine.advancePhase(done, stages, NOW).phase, 'done');
  const gate1 = { ...start, phase: 'gate1', trial: ['a'] };
  assert.deepEqual(plain(machine.nextActions(gate1, stages, new Set(), AI).actions), [{ type: 'advance_phase' }]);
  assert.equal(machine.advancePhase(gate1, stages, NOW).phase, 'writing');
  assert.deepEqual(plain(machine.nextActions({ ...gate1, planReview: true }, stages, new Set(), AI)), { actions: [], hold: 'gate1' });
});

test('ai proof: the saved records are validated; a rerun or a trial reset clears the chapter record', () => {
  const { state: start } = checkedRun();
  const p = begin(start, { nodeId: 'a' }, 'k0', 'proof');
  const ok = plain(p.state);
  assert.equal(model.readBookPipeline({ bookPipeline: ok }).kind, 'usable');
  for (const bad of [{ ...ok, aiProof: { a: { ...ok.aiProof.a, round: 3 } } }, { ...ok, aiProof: { a: { ...ok.aiProof.a, step: 'x' } } }, { ...ok, bookProof: { key: 1 } }, { ...ok, aiProof: { a: { ...ok.aiProof.a, open: [{ id: 'x' }] } } }])
    assert.equal(model.readBookPipeline({ bookPipeline: bad }).kind, 'unusable');
  assert.equal(machine.resetCard(p.state, 'a').aiProof.a, undefined);
  assert.equal(p.state.aiProof.a.key, 'k0', 'reducers leave their input alone');
});

test('ai proof: a fix keeps the findings for the re-check; isAiCurrent fences a token; abandonAi ends a stuck step as incomplete', () => {
  const { state: start } = checkedRun();
  let state = machine.applyAiProof(begin(start, { nodeId: 'a' }, 'k0', 'proof').state, begin(start, { nodeId: 'a' }, 'k0', 'proof').token, { checked: 2, pending: [pending()], open: [] }).state;
  const f = begin(state, { nodeId: 'a' }, 'k0', 'fix');
  assert.equal(machine.isAiCurrent(f.state, f.token), true);
  assert.equal(machine.isAiCurrent(machine.stopRun(f.state), f.token), false, 'a stop closes the fence');
  const fixed = machine.applyAiFix(f.state, f.token, { applied: 1 }).state;
  assert.deepEqual(plain(fixed.aiProof.a.pending.map(item => item.id)), ['P1'], 'earlier findings kept for the re-check');
  const gone = machine.abandonAi(start, 'a');
  assert.deepEqual([gone.aiProof.a.done, gone.aiProof.a.incomplete], [true, true]);
  assert.equal(machine.beginAiStep(gone, { nodeId: 'a' }, 'k0', 'proof'), null);
});

test('ai fix records what it changed: the targets that were not blocked, kept across rounds, and still a readable state', () => {
  const { state: start } = checkedRun();
  const p = begin(start, { nodeId: 'a' }, 'k0', 'proof');
  let state = machine.applyAiProof(p.state, p.token, { checked: 3, pending: [pending('P1'), pending('P2')], open: [] }).state;
  const f = begin(state, { nodeId: 'a' }, 'k0', 'fix');
  state = machine.applyAiFix(f.state, f.token, { applied: 1, refused: { P2: 'fix_quote_missing' }, key: 'k1', changed: ['a'] }).state;
  assert.deepEqual(plain(state.aiProof.a.fixes.map(item => item.id)), ['P1'], 'the blocked target is not a fix');
  const q = begin(state, { nodeId: 'a' }, 'k1', 'proof');
  state = machine.applyAiProof(q.state, q.token, { checked: 3, pending: [pending('P3')], open: [] }).state;
  const g = begin(state, { nodeId: 'a' }, 'k1', 'fix');
  state = machine.applyAiFix(g.state, g.token, { applied: 1, key: 'k2', changed: ['a'] }).state;
  assert.deepEqual(plain(state.aiProof.a.fixes.map(item => item.id)), ['P1', 'P3'], 'a second round adds to the first');
  assert.equal(model.readBookPipeline({ bookPipeline: plain(state) }).kind, 'usable');
  const none = begin(start, { nodeId: 'b' }, 'k0', 'proof');
  let other = machine.applyAiProof(none.state, none.token, { checked: 1, pending: [pending()], open: [] }).state;
  const h = begin(other, { nodeId: 'b' }, 'k0', 'fix');
  other = machine.applyAiFix(h.state, h.token, { applied: 0, refused: { P1: 'fix_refused_picture' } }).state;
  assert.equal(other.aiProof.b.fixes, undefined, 'nothing applied: no fix recorded');
});

const pq = (id, quote) => ({ id, quote, problem: `p-${quote}`, suggestion: `s-${quote}` });
test('R1 B1: a target the model gave no edit for is not recorded as a fix (only ids that were applied)', () => {
  const { state: start } = checkedRun();
  const p = begin(start, { nodeId: 'a' }, 'k0', 'proof');
  let state = machine.applyAiProof(p.state, p.token, { checked: 3, pending: [pq('P1', 'qa'), pq('P2', 'qb')], open: [] }).state;
  const f = begin(state, { nodeId: 'a' }, 'k0', 'fix');
  state = machine.applyAiFix(f.state, f.token, { applied: 1, appliedIds: ['P1'], key: 'k1', changed: ['a'] }).state;
  assert.deepEqual(plain(state.aiProof.a.fixes.map(item => item.id)), ['P1'], 'P2 was skipped by the model: no fix');
  assert.equal(state.aiProof.a.fixed, state.aiProof.a.fixes.length, 'the number and the list agree');
});

test('R1 B2: ids renumbered between rounds: the reason follows the quote, a stale refusal of a reused id is not carried over', () => {
  const { state: start } = checkedRun();
  const p0 = begin(start, { nodeId: 'a' }, 'k0', 'proof');
  let state = machine.applyAiProof(p0.state, p0.token, { checked: 1, pending: [pq('P1', 'qa')], open: [] }).state;
  const f0 = begin(state, { nodeId: 'a' }, 'k0', 'fix');
  state = machine.applyAiFix(f0.state, f0.token, { applied: 0, refused: { P1: 'fix_refused_picture' } }).state;
  const p1 = begin(state, { nodeId: 'a' }, 'k0', 'proof');
  // qa is gone; a different problem now carries the id P1
  state = machine.applyAiProof(p1.state, p1.token, { checked: 1, pending: [pq('P1', 'qb')], open: [] }).state;
  const f1 = begin(state, { nodeId: 'a' }, 'k0', 'fix');
  state = machine.applyAiFix(f1.state, f1.token, { applied: 1, appliedIds: ['P1'], replacements: ['qb fixed'], key: 'k1', changed: ['a'] }).state;
  const p2 = begin(state, { nodeId: 'a' }, 'k1', 'proof');
  state = machine.applyAiProof(p2.state, p2.token, { checked: 1, pending: [pq('P1', 'qb')], open: [] }).state;
  assert.deepEqual(plain(state.aiProof.a.open.map(item => [item.quote, item.reason])), [['qb', 'still_present']], 'same quote under a new id: still present, not the old picture refusal');
});

test('R1 B2: a problem first found in the last check is not_fixed_in_time, not "fixed twice and still there"', () => {
  const { state: start } = checkedRun();
  let state = start;
  let key = 'k0';
  for (let round = 0; round < 3; round++) {
    const p = begin(state, { nodeId: 'a' }, key, 'proof');
    const found = round < 2 ? pq('P1', 'old') : pq('N9', 'brand new');
    state = machine.applyAiProof(p.state, p.token, { checked: 2, pending: [found], open: [] }).state;
    if (state.aiProof.a.done) break;
    const f = begin(state, { nodeId: 'a' }, key, 'fix');
    key = `k${round + 1}`;
    state = machine.applyAiFix(f.state, f.token, { applied: 1, appliedIds: ['P1'], key, changed: ['a'] }).state;
  }
  assert.deepEqual(plain(state.aiProof.a.open.map(item => [item.quote, item.reason])), [['brand new', 'not_fixed_in_time']]);
});

test('R3 M-R3-2: a target the model skipped (nothing written, nothing refused) and still reported is not_fixed, never "still there after the AI fixed it"', () => {
  const { state: start } = checkedRun();
  let state = start;
  for (let round = 0; round < 3; round++) {
    const p = begin(state, { nodeId: 'a' }, 'k0', 'proof');
    state = machine.applyAiProof(p.state, p.token, { checked: 1, pending: [pq('P1', 'qs')], open: [] }).state;
    if (state.aiProof.a.done) break;
    const f = begin(state, { nodeId: 'a' }, 'k0', 'fix');
    state = machine.applyAiFix(f.state, f.token, { applied: 0, appliedIds: [] }).state;
  }
  assert.deepEqual(plain(state.aiProof.a.open.map(item => [item.quote, item.reason])), [['qs', 'not_fixed']]);
});

test('R1 B2: ids renumbered: a refused problem reported again under another id keeps its own refusal reason (matched by the quote)', () => {
  const { state: start } = checkedRun();
  let state = start;
  let key = 'k0';
  for (let round = 0; round < 3; round++) {
    const p = begin(state, { nodeId: 'a' }, key, 'proof');
    state = machine.applyAiProof(p.state, p.token, { checked: 2, pending: [pq(round === 2 ? 'Z5' : 'P1', 'qa')], open: [] }).state;
    if (state.aiProof.a.done) break;
    const f = begin(state, { nodeId: 'a' }, key, 'fix');
    state = machine.applyAiFix(f.state, f.token, { applied: 0, refused: { P1: 'fix_refused_picture' } }).state;
  }
  assert.deepEqual(plain(state.aiProof.a.open.map(item => [item.id, item.reason])), [['Z5', 'fix_refused_picture']]);
});

test('R1 T1: a needs-review chapter is also asked for its chapter AI proofread (it needs it most)', () => {
  const { state: start } = checkedRun();
  assert.deepEqual(plain(machine.nextActions(start, { a: 'needs-review', b: 'checked' }, new Set(), AI).actions), [{ type: 'ai_proof', nodeId: 'a' }, { type: 'ai_proof', nodeId: 'b' }]);
});

test('ai proof R4: a needs-review chapter with a queued automatic redo is not proofread until the redo settled', () => {
  const { state, stages } = checkedRun();
  const review = { ...stages, a: 'needs-review' };
  const options = { aiProof: true, authorPending: new Set(['a']) };
  assert.deepEqual(plain(machine.nextActions(state, review, new Set(), options).actions), [{ type: 'ai_proof', nodeId: 'b' }], 'only the settled chapter');
  assert.deepEqual(plain(machine.nextActions(state, review, new Set(), AI).actions), [{ type: 'ai_proof', nodeId: 'a' }, { type: 'ai_proof', nodeId: 'b' }], 'settled: both');
});

test('ai proof R4: a chapter proofread for a text that a later write changed is dropped and due again, until the whole-book proofread begins', () => {
  const { state, stages } = checkedRun();
  const p = begin(state, { nodeId: 'a' }, `${machine.cardRevision(state, 'a')}:h`, 'proof');
  let done = machine.applyAiProof(p.state, p.token, { checked: 3, pending: [], open: [] }).state;
  assert.equal(done.aiProof.a.done, true);
  assert.equal(machine.invalidateStaleAiChapters(done).accepted, false, 'the key matches the revision: nothing to do');
  const rewritten = { ...done, revisions: { ...done.revisions, a: machine.cardRevision(done, 'a') + 1 } };
  const res = machine.invalidateStaleAiChapters(rewritten);
  assert.equal(res.accepted, true);
  assert.equal(res.state.aiProof.a, undefined, 'the stale slot is dropped');
  assert.deepEqual(plain(machine.nextActions(res.state, stages, new Set(), AI).actions), [{ type: 'ai_proof', nodeId: 'a' }, { type: 'ai_proof', nodeId: 'b' }], 'and the chapter is proofread again');
  assert.equal(machine.invalidateStaleAiChapters({ ...rewritten, bookProof: { key: 'x', attempts: 0, round: 0, step: 'proof', checked: 0, fixed: 0, open: [] } }).accepted, false, 'not once the whole-book proofread began');
  const abandoned = machine.abandonAi(state, 'a');
  assert.equal(machine.invalidateStaleAiChapters({ ...abandoned, revisions: { a: 3 } }).accepted, false, 'a given-up slot (no key) is not looped');
});
