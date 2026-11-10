// Argument map runner v2 recovery (V5a): `recover(path)` on map open pauses a v2 run a reload left `running` as `interrupted` and never calls
// a provider; every other map (legacy, unusable, absent, paused, finished, driven by this runner) is not written. Unit level: fake ports over the
// real repository fixture, not a live Obsidian.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('./support.cjs');
const { rig, locked, run, tick, defer, foundEntry } = require('./support-argument-run-v2.cjs');

const legacyMachine = S.load('core/argument-map/machine.ts');
const answer = ctx => ({ summary: '', detail: '', suggestions: [], visualReferences: [], evidence: { openedUrls: [] }, argumentEvidence: [foundEntry(ctx.argumentEvidenceNeeds[0].id)] });

/** A map whose run is `running` with a `searching` premise datum, as a reload leaves it: started by one runner that is then forgotten. */
async function interrupted() {
  const gate = defer();
  const r = await rig({ script: { ask: async ctx => { await gate.promise; return answer(ctx); } } });
  const started = r.runs.start(r.mapPath, locked());
  for (let i = 0; i < 50 && r.stat.ask.length === 0; i++) await tick();
  const s = await r.state();
  assert.equal(s.run.status, 'running');
  assert.equal(s.claims.find(c => c.role === 'premise').data[0].state, 'searching');
  // The "reload": the old runner is gone (its late result is dropped), a fresh one opens the map.
  r.runs.dispose();
  gate.resolve();
  await started;
  const fresh = new run.ArgumentRunsV2(r.ports);
  const before = { ask: r.stat.ask.length, steps: r.stat.steps.length };
  return { r, fresh, before };
}
const quiet = (r, before) => assert.deepEqual({ ask: r.stat.ask.length, steps: r.stat.steps.length }, before, 'no provider call, no step');

test('recover pauses a running v2 run as interrupted: searching goes back to pending, no provider call', async () => {
  const { r, fresh, before } = await interrupted();
  assert.equal(await fresh.recover(r.mapPath), true);
  const s = await r.state();
  assert.equal(s.run.status, 'paused');
  assert.equal(s.run.stopReason, 'interrupted');
  assert.equal(s.claims.find(c => c.role === 'premise').data[0].state, 'pending');
  quiet(r, before);
  assert.ok(r.log().includes('paused stopReason=interrupted'));
  assert.equal(await fresh.recover(r.mapPath), false, 'a second open finds it already paused');
});

test('recover leaves already paused and finished runs untouched', async () => {
  const gate = defer();
  const paused = await rig({ script: { ask: async ctx => { await gate.promise; return answer(ctx); } } });
  const started = paused.runs.start(paused.mapPath, locked());
  for (let i = 0; i < 50 && paused.stat.ask.length === 0; i++) await tick();
  await paused.runs.stop(paused.mapPath);
  gate.resolve();
  await started;
  assert.equal((await paused.state()).run.stopReason, 'user');
  let before = await paused.snapshot();
  assert.equal(await new run.ArgumentRunsV2(paused.ports).recover(paused.mapPath), false);
  assert.equal(await paused.snapshot(), before, 'paused: untouched');

  const finished = await rig({ script: { ask: ctx => ({ ...answer(ctx), argumentEvidence: [{ need: ctx.argumentEvidenceNeeds[0].id, status: 'not_found' }] }) } });
  await finished.runs.start(finished.mapPath, locked());
  assert.equal((await finished.state()).run.status, 'finished');
  before = await finished.snapshot();
  assert.equal(await new run.ArgumentRunsV2(finished.ports).recover(finished.mapPath), false);
  assert.equal(await finished.snapshot(), before, 'finished: untouched');
});

test('recover never writes legacy, unusable or absent maps', async () => {
  const legacy = await rig();
  const doc = await legacy.repo.readMap(legacy.mapPath);
  const ids = {};
  for (const role of ['proposition', 'situation', 'conclusion', 'verified', 'eliminated']) {
    const n = await legacy.repo.createNote(role, 'model-a', doc, legacy.mapPath, 'workspace');
    doc.nodes.push(n);
    ids[role] = n.id;
  }
  doc.argumentMap = legacyMachine.newArgumentMap(ids, 'run-1');
  await legacy.repo.saveMap(legacy.mapPath, doc);
  const unusable = await rig();
  const bad = await unusable.repo.readMap(unusable.mapPath);
  bad.argumentMap = { v: 2, junk: true };
  await unusable.repo.saveMap(unusable.mapPath, bad);
  const absent = await rig();
  for (const [name, r] of Object.entries({ legacy, unusable, absent })) {
    const before = await r.snapshot();
    assert.equal(await r.runs.recover(r.mapPath), false, name);
    assert.equal(await r.snapshot(), before, `${name}: untouched`);
    assert.equal(r.stat.ask.length + r.stat.steps.length, 0, `${name}: no provider call`);
  }
});

test('recover leaves a map this runner is driving, and does nothing after dispose', async () => {
  const gate = defer();
  const r = await rig({ script: { ask: async ctx => { await gate.promise; return answer(ctx); } } });
  const started = r.runs.start(r.mapPath, locked());
  for (let i = 0; i < 50 && r.stat.ask.length === 0; i++) await tick();
  const before = await r.snapshot();
  assert.equal(await r.runs.recover(r.mapPath), false, 'driven by this runner');
  assert.equal(await r.snapshot(), before);
  r.runs.dispose();
  assert.equal(await r.runs.recover(r.mapPath), false, 'disposed');
  gate.resolve();
  await started;
  assert.equal(await r.snapshot(), before, 'the late result was dropped too');
  const { r: r2, fresh } = await interrupted();
  fresh.dispose();
  const snap = await r2.snapshot();
  assert.equal(await fresh.recover(r2.mapPath), false);
  assert.equal(await r2.snapshot(), snap);
});

test('recover loses to a change made between its read and its write: nothing is written over a newer state', async () => {
  const { r } = await interrupted();
  let first = true;
  const ports = {
    ...r.ports,
    updateMap: (path, change) => r.ports.updateMap(path, doc => {
      if (first) { first = false; doc.argumentMap.run.researchCalls += 1; } // another writer got in after the read
      return change(doc);
    })
  };
  const racing = new run.ArgumentRunsV2(ports);
  assert.equal(await racing.recover(r.mapPath), false);
  assert.equal((await r.state()).run.status, 'running', 'the newer state stays');
});
