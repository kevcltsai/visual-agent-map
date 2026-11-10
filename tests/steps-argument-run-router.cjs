// The argument run router (V5b): routes the view's calls by the map's argument kind and turns v2 refusals into the v1 error the view handles.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('./support.cjs');
const legacyMachine = S.load('core/argument-map/machine.ts');
const routerModule = S.load('experiences/visual-map/argument-run-router.ts');
const v1Module = S.load('experiences/visual-map/argument-run.ts');
const v2Module = S.load('experiences/visual-map/argument-run-v2.ts');
const { rig, locked, plain } = require('./support-argument-run-v2.cjs');

const fakeV1 = () => {
  const calls = [];
  return { calls, isRunning: () => false, start: async (...a) => { calls.push(['start', ...a]); }, resume: async (...a) => { calls.push(['resume', ...a]); }, stop: async (...a) => { calls.push(['stop', ...a]); }, dispose: () => { calls.push(['dispose']); } };
};
const code = async work => { try { await work(); return 'no error'; } catch (error) { assert.equal(error.name, 'ArgumentRunError', `${error}`); return error.code; } };
const legacyMap = async r => {
  const doc = await r.repo.readMap(r.mapPath); const ids = {};
  for (const role of ['proposition', 'situation', 'conclusion', 'verified', 'eliminated']) { const n = await r.repo.createNote(role, 'model-a', doc, r.mapPath, 'workspace'); doc.nodes.push(n); ids[role] = n.id; }
  doc.argumentMap = legacyMachine.newArgumentMap(ids, 'run-1'); doc.argumentMap.run.status = 'paused'; await r.repo.saveMap(r.mapPath, doc);
};

test('router: a usable v2 map goes to the v2 runner, a legacy map to v1, start is v1, stop and isRunning cover both, recover is v2', async () => {
  const r = await rig({ script: { step: { conclusion: () => { throw new Error('down'); } } } });
  await r.runs.start(r.mapPath, locked());
  const v1 = fakeV1();
  const router = new routerModule.ArgumentRunRouter(v1, r.runs, path => r.ports.readMap(path));
  assert.equal(r.stat.steps.filter(n => n === 'conclusion').length, 2);
  r.script.step = { ...r.script.step, conclusion: request => ({ answers: request.input.claims.filter(c => c.evaluated).map(c => ({ claimId: c.id, answer: c.comparison.answer, sentence: `${c.text} cannot be settled`, assumptions: [] })) }), 'inference-check': request => request.input.sentences.map(x => ({ id: x.id, status: 'ok' })) };
  await router.resume(r.mapPath);
  assert.equal((await r.state()).run.status, 'finished', 'v2 resumed through the router');
  assert.deepEqual(v1.calls, [], 'v1 untouched');
  assert.equal(await code(() => router.resume(r.mapPath)), 'finished', 'a v2 refusal is a v1 ArgumentRunError');
  await router.start('p', 'a claim');
  await router.stop('p');
  assert.deepEqual(plain(v1.calls), [['start', 'p', 'a claim'], ['stop', 'p']]);
  assert.equal(await router.recover(r.mapPath), false);
  assert.equal(router.isRunning(r.mapPath), false);
  const legacy = await rig();
  await legacyMap(legacy);
  const v1b = fakeV1();
  const routerB = new routerModule.ArgumentRunRouter(v1b, legacy.runs, path => legacy.ports.readMap(path));
  await routerB.resume(legacy.mapPath);
  assert.deepEqual(plain(v1b.calls), [['resume', legacy.mapPath]]);
  assert.equal(legacy.stat.steps.length + legacy.stat.ask.length, 0, 'the v2 runner was not asked for a legacy map');
  routerB.dispose();
  assert.ok(v1b.calls.some(c => c[0] === 'dispose'));
});

test('router: v2 refusals become v1 error codes; legacy and the codes v1 does not have become unusable', async () => {
  for (const [v2, v1] of [['busy', 'busy'], ['exists', 'exists'], ['missing', 'missing'], ['finished', 'finished'], ['not_paused', 'not_paused'], ['disposed', 'disposed'], ['unusable', 'unusable'], ['legacy', 'unusable'], ['framing_limit', 'unusable'], ['not_locked', 'unusable']])
    assert.equal(routerModule.toV1Refusal(v2).code, v1, v2);
  const r = await rig({ script: { step: { conclusion: () => { throw new Error('down'); } } } });
  const router = new routerModule.ArgumentRunRouter(fakeV1(), r.runs, path => r.ports.readMap(path));
  await r.runs.start(r.mapPath, locked());
  const doc = await r.repo.readMap(r.mapPath);
  doc.argumentMap.run.status = 'running'; await r.repo.saveMap(r.mapPath, doc);
  assert.equal(await code(() => router.resume(r.mapPath)), 'not_paused');
  r.runs.dispose();
  assert.equal(await code(() => router.resume(r.mapPath)), 'disposed');
  assert.ok(v2Module.ArgumentRunV2Error);
});
