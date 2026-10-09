const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { buildSync } = require('esbuild');
const code = buildSync({ entryPoints: ['experiences/mind-search/final-delivery.ts'], bundle: true, write: false, platform: 'node', format: 'cjs' }).outputFiles[0].text;
const moduleValue = { exports: {} };
vm.runInNewContext(code, { module: moduleValue, exports: moduleValue.exports, require });
const { buildFinalDelivery } = moduleValue.exports;
const base = { title: 'Goal', detail: 'Conditions and prior reports' };
const answer = detail => ({ summary: 'Preview', detail, suggestions: [], visualReferences: [] });
const outputs = {
  'delivery-outline': answer('<!-- mindsearch-delivery-outline {"sections":[{"heading":"Steps","purpose":"Execute","searchTask":"Find examples"}]} -->'),
  'delivery-research': answer('<!-- mindsearch-delivery-research {"status":"searched"} -->\nhttps://example.org/docs'),
  'delivery-writing': answer('Full draft with steps and sources'),
  'delivery-acceptance': answer('<!-- mindsearch-review {"decision":"conclude","rationale":"Complete","stopReason":"Ready"} -->'),
};
const phases = Object.keys(outputs);
const phaseOf = context => context.task.match(/mindsearch-phase: ([a-z-]+)/)[1];

for (const failedPhase of phases) {
  test(`final delivery resumes persisted successes after ${failedPhase} failure and reload`, async () => {
    let saved;
    const firstCalls = [];
    await assert.rejects(buildFinalDelivery(base, async context => {
      const phase = phaseOf(context); firstCalls.push(phase);
      if (phase === failedPhase) throw new Error('provider failure');
      return outputs[phase];
    }, { onCheckpoint: checkpoint => { saved = JSON.parse(JSON.stringify(checkpoint)); } }), /provider failure/);
    const retryCalls = [];
    const events = [];
    const delivery = await buildFinalDelivery(base, async context => {
      const phase = phaseOf(context); retryCalls.push(phase);
      assert.equal(events.at(-1), phase);
      assert.equal(context.timeoutMs, 180000);
      if (phase === 'delivery-acceptance') assert.ok(context.task.includes(outputs['delivery-writing'].detail));
      return outputs[phase];
    }, { checkpoint: saved, timeoutMs: 180000, onPhase: phase => { events.push(phase); }, onCheckpoint: async checkpoint => {
      await Promise.resolve();
      events.push(Object.keys(checkpoint).at(-1));
    } });
    assert.deepEqual(firstCalls, phases.slice(0, phases.indexOf(failedPhase) + 1));
    assert.deepEqual(retryCalls, phases.slice(phases.indexOf(failedPhase)));
    assert.ok(delivery.result.detail.endsWith(outputs['delivery-writing'].detail));
    assert.equal(events.length, retryCalls.length * 2 + (retryCalls.includes('delivery-writing') ? 1 : 0));
  });
}

test('final delivery does not checkpoint invalid outline, unavailable research, empty draft or incomplete acceptance', async () => {
  const invalid = ['No outline', '<!-- mindsearch-delivery-research {"status":"unavailable"} -->', '', '<!-- mindsearch-review {"decision":"conclude","rationale":"","stopReason":""} -->'];
  for (let index = 0; index < phases.length; index++) {
    let saved = {}; let calls = 0;
    await assert.rejects(buildFinalDelivery(base, async context => {
      const phase = phaseOf(context); calls++;
      return phase === phases[index] ? answer(invalid[index]) : outputs[phase];
    }, { onCheckpoint: checkpoint => { saved = checkpoint; } }));
    assert.equal(calls, index + 1);
    assert.equal(['outline', 'research', 'draft', 'acceptance'].filter(key => saved[key]).length, index);
  }
});

test('final delivery regenerates corrupt checkpoint and drops downstream cached output', async () => {
  const calls = [];
  const delivery = await buildFinalDelivery(base, async context => {
    const phase = phaseOf(context); calls.push(phase); return outputs[phase];
  }, { checkpoint: { outline: outputs['delivery-outline'], research: answer('not searched'), draft: answer('Stale draft'), acceptance: outputs['delivery-acceptance'] } });
  assert.deepEqual(calls, phases.slice(1));
  assert.ok(!delivery.result.detail.includes('Stale draft'));
});

test('final delivery waits for checkpoint persistence and stops on save rejection', async () => {
  let calls = 0;
  await assert.rejects(buildFinalDelivery(base, async context => { calls++; return outputs[phaseOf(context)]; }, {
    onCheckpoint: async () => { await Promise.resolve(); throw new Error('disk failure'); },
  }), /disk failure/);
  assert.equal(calls, 1);
});

test('final delivery cancellation during checkpoint save prevents next provider call', async () => {
  let calls = 0; const controller = new AbortController();
  await assert.rejects(buildFinalDelivery({ ...base, signal: controller.signal }, async context => { calls++; return outputs[phaseOf(context)]; }, {
    onCheckpoint: async () => { controller.abort(); },
  }));
  assert.equal(calls, 1);
});

test('final delivery phase persistence rejection and cancellation prevent dispatch', async () => {
  let calls = 0;
  await assert.rejects(buildFinalDelivery(base, async () => { calls++; }, { onPhase: async () => { throw new Error('phase save failed'); } }), /phase save failed/);
  const controller = new AbortController();
  await assert.rejects(buildFinalDelivery({ ...base, signal: controller.signal }, async () => { calls++; }, { onPhase: () => { controller.abort(); } }));
  assert.equal(calls, 0);
});

test('final delivery checkpoints reused research before writing without web dispatch', async () => {
  const localOutline = answer('<!-- mindsearch-delivery-outline {"sections":[{"heading":"Answer","purpose":"Explain","searchTask":""}]} -->');
  const events = [];
  await buildFinalDelivery(base, async context => {
    const phase = phaseOf(context); events.push(phase);
    if (phase === 'delivery-outline') return localOutline;
    if (phase === 'delivery-writing') assert.equal(events.at(-2), 'saved:research');
    return outputs[phase];
  }, { onCheckpoint: checkpoint => { events.push(`saved:${Object.keys(checkpoint).at(-1)}`); } });
  assert.ok(!events.includes('delivery-research'));
});


test('final delivery rejects incomplete research_more acceptance and retries acceptance alone after reload', async () => {
  const gapMarker = '<!-- mindsearch-review {"decision":"research_more","rationale":"Missing source"} -->';
  const target = { title: 'Source', task: 'Find a verified source', contribution: 'Support the missing claim' };
  for (const suggestions of [[], [target, target], [{ ...target, title: ' ' }], [{ ...target, task: '' }], [{ ...target, contribution: '' }]]) {
    let saved;
    await assert.rejects(buildFinalDelivery(base, async context => {
      const phase = phaseOf(context);
      return phase === 'delivery-acceptance' ? { ...answer(gapMarker), suggestions } : outputs[phase];
    }, { onCheckpoint: checkpoint => { saved = JSON.parse(JSON.stringify(checkpoint)); } }), /one concrete evidence gap/);
    assert.equal(saved.acceptance, undefined);
    assert.ok(saved.draft);
    const calls = [];
    const delivery = await buildFinalDelivery(base, async context => {
      calls.push(phaseOf(context));
      return { ...answer(gapMarker), suggestions: [target] };
    }, { checkpoint: saved });
    assert.deepEqual(calls, ['delivery-acceptance']);
    assert.ok(delivery.result.detail.includes('Draft pending completion'));
  }
});

test('final delivery regenerates invalid cached research_more acceptance only', async () => {
  const calls = [];
  await buildFinalDelivery(base, async context => { calls.push(phaseOf(context)); return outputs['delivery-acceptance']; }, { checkpoint: {
    outline: outputs['delivery-outline'], research: outputs['delivery-research'], draft: outputs['delivery-writing'],
    acceptance: answer('<!-- mindsearch-review {"decision":"research_more","rationale":"Missing source"} -->'),
  } });
  assert.deepEqual(calls, ['delivery-acceptance']);
});
