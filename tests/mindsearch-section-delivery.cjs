const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { buildSync } = require('esbuild');
const code = buildSync({ entryPoints: ['experiences/mind-search/final-delivery.ts'], bundle: true, write: false, platform: 'node', format: 'cjs' }).outputFiles[0].text;
const moduleValue = { exports: {} };
vm.runInNewContext(code, { module: moduleValue, exports: moduleValue.exports, require });
const { buildFinalDelivery } = moduleValue.exports;
const answer = detail => ({ summary: 'Preview only', detail, suggestions: [], visualReferences: [] });
const base = { title: 'Goal', detail: 'ALL PRIOR REPORTS including unrelated source B', rules: '' };
const outline = answer('<!-- mindsearch-delivery-outline {"sections":[{"heading":"First","purpose":"Use first evidence","searchTask":"","evidenceIds":["source-a"]},{"heading":"Second","purpose":"Use second evidence","searchTask":"","evidenceIds":["source-b"]}]} -->');
const acceptance = answer('<!-- mindsearch-review {"decision":"conclude","rationale":"Coherent and supported","stopReason":"All sections complete"} -->');
const evidence = [{ id: 'source-a', hash: 'a-v1', detail: 'First proof https://a.example/docs' }, { id: 'source-b', hash: 'b-v1', detail: 'Second proof https://b.example/docs' }];
const phaseOf = context => context.task.match(/mindsearch-phase: ([a-z-]+)/)[1];
const sectionOf = context => context.task.match(/Write only the complete section "([^"]+)"/)[1];
const options = { evidence, knownConditions: 'Original goal and known conditions only' };
function provider(calls, failSection) {
  return async context => {
    const phase = phaseOf(context);
    calls.push(phase === 'delivery-writing' ? sectionOf(context) : phase);
    if (phase === 'delivery-outline') {
      assert.ok(context.task.includes('Source ID: source-a'));
      return outline;
    }
    if (phase === 'delivery-writing') {
      const section = sectionOf(context);
      if (section === failSection) throw new Error('section provider failed');
      const own = section === 'First' ? 'a' : 'b';
      const other = own === 'a' ? 'b' : 'a';
      assert.ok(context.task.includes(`Source ID: source-${own}`));
      assert.ok(!context.task.includes(`https://${other}.example/docs`));
      assert.ok(!context.detail.includes('ALL PRIOR REPORTS'));
      return answer(`Detailed ${section} content\n\nLong executable material with https://${own}.example/docs`);
    }
    assert.equal(phase, 'delivery-acceptance');
    assert.ok(context.task.includes('cross-section coherence'));
    assert.ok(context.task.includes('duplicate passages'));
    assert.ok(context.task.includes('wrong claims'));
    assert.ok(context.task.includes('missing sections'));
    return acceptance;
  };
}
test('each section is independently durable and a failed section alone resumes after reload', async () => {
  let saved;
  const firstCalls = [];
  await assert.rejects(buildFinalDelivery(base, provider(firstCalls, 'Second'), { ...options, onCheckpoint: value => { saved = JSON.parse(JSON.stringify(value)); } }), /section provider failed/);
  assert.deepEqual(firstCalls, ['delivery-outline', 'First', 'Second']);
  assert.ok(saved.sections.first.result.detail.includes('Long executable material'));
  assert.equal(saved.sections.second, undefined);
  const retryCalls = [];
  const delivery = await buildFinalDelivery(base, provider(retryCalls), { ...options, checkpoint: saved });
  assert.deepEqual(retryCalls, ['Second', 'delivery-acceptance']);
  assert.ok(delivery.result.detail.includes('Detailed First content'));
  assert.ok(delivery.result.detail.includes('Detailed Second content'));
  assert.equal((delivery.result.detail.match(/Long executable material/g) ?? []).length, 2);
});
test('changing one mapped source invalidates only its section and final acceptance', async () => {
  let saved;
  await buildFinalDelivery(base, provider([]), { ...options, onCheckpoint: value => { saved = JSON.parse(JSON.stringify(value)); } });
  const calls = [];
  await buildFinalDelivery({ ...base, detail: 'Updated full report text' }, provider(calls), { ...options, evidence: [{ ...evidence[0], hash: 'a-v2', detail: 'Updated first proof https://a.example/docs' }, evidence[1]], checkpoint: saved });
  assert.deepEqual(calls, ['First', 'delivery-acceptance']);
});
test('cancellation after a persisted section resumes the next section without rewriting', async () => {
  let saved;
  const controller = new AbortController();
  await assert.rejects(buildFinalDelivery({ ...base, signal: controller.signal }, provider([]), { ...options, onCheckpoint: value => {
    saved = JSON.parse(JSON.stringify(value));
    if (value.sections?.first) controller.abort();
  } }));
  const calls = [];
  await buildFinalDelivery(base, provider(calls), { ...options, checkpoint: saved });
  assert.deepEqual(calls, ['Second', 'delivery-acceptance']);
});
test('acceptance failure retries only the final join review with every section intact', async () => {
  let saved;
  const ask = provider([]);
  await assert.rejects(buildFinalDelivery(base, async context => {
    if (phaseOf(context) === 'delivery-acceptance') throw new Error('join review failed');
    return ask(context);
  }, { ...options, onCheckpoint: value => { saved = JSON.parse(JSON.stringify(value)); } }), /join review failed/);
  const calls = [];
  await buildFinalDelivery(base, provider(calls), { ...options, checkpoint: saved });
  assert.deepEqual(calls, ['delivery-acceptance']);
});
test('unknown source mapping is rejected before a section writer is dispatched', async () => {
  const calls = [];
  await assert.rejects(buildFinalDelivery(base, async context => {
    calls.push(phaseOf(context));
    return answer(outline.detail.replace('source-a', 'unknown-source'));
  }, options), /unavailable source ID/);
  assert.deepEqual(calls, ['delivery-outline']);
});
test('changed known user conditions invalidate all sections', async () => {
  let saved;
  await buildFinalDelivery(base, provider([]), { ...options, onCheckpoint: value => { saved = JSON.parse(JSON.stringify(value)); } });
  const calls = [];
  await buildFinalDelivery(base, provider(calls), { ...options, knownConditions: 'Changed condition', checkpoint: saved });
  assert.deepEqual(calls, ['delivery-outline', 'First', 'Second', 'delivery-acceptance']);
});
test('changed source backing a supplemental search reruns that research and dependent writing only', async () => {
  let saved; let revision = 1;
  const gapOutline = answer(outline.detail.replace('"searchTask":""', '"searchTask":"Verify the first source gap"'));
  const calls = [];
  const ask = async context => {
    const phase = phaseOf(context);
    calls.push(phase === 'delivery-writing' ? sectionOf(context) : phase);
    if (phase === 'delivery-outline') return gapOutline;
    if (phase === 'delivery-research') return answer(`<!-- mindsearch-delivery-research {"status":"searched"} -->\nUpdated supplemental research ${revision} https://extra.example/docs`);
    if (phase === 'delivery-writing') return answer(`Full ${sectionOf(context)} document section ${revision}`);
    return acceptance;
  };
  await buildFinalDelivery(base, ask, { ...options, onCheckpoint: value => { saved = JSON.parse(JSON.stringify(value)); } });
  calls.length = 0; revision = 2;
  await buildFinalDelivery(base, ask, { ...options, checkpoint: saved, evidence: [{ ...evidence[0], hash: 'a-v2' }, evidence[1]] });
  assert.deepEqual(calls, ['delivery-research', 'First', 'delivery-acceptance']);
});
test('two supplemental gaps still invalidate only the section whose research changed', async () => {
  let saved; let revision = 1;
  const twoGaps = answer(outline.detail.replaceAll('"searchTask":""', '"searchTask":"Verify this section gap"'));
  const calls = [];
  const ask = async context => {
    const phase = phaseOf(context);
    calls.push(phase === 'delivery-writing' ? sectionOf(context) : phase);
    if (phase === 'delivery-outline') return twoGaps;
    if (phase === 'delivery-research') return answer(`<!-- mindsearch-delivery-research {"status":"searched"} -->\n## First\nFirst gap evidence ${revision}\n## Second\nUnchanged second gap evidence`);
    if (phase === 'delivery-writing') {
      const own = sectionOf(context);
      assert.ok(context.task.includes(own === 'First' ? 'First gap evidence' : 'Unchanged second gap evidence'));
      assert.ok(!context.task.includes(own === 'First' ? 'Unchanged second gap evidence' : 'First gap evidence'));
      return answer(`Full ${own} detail`);
    }
    return acceptance;
  };
  await buildFinalDelivery(base, ask, { ...options, onCheckpoint: value => { saved = JSON.parse(JSON.stringify(value)); } });
  calls.length = 0; revision = 2;
  await buildFinalDelivery(base, ask, { ...options, checkpoint: saved, evidence: [{ ...evidence[0], hash: 'a-v2' }, evidence[1]] });
  assert.deepEqual(calls, ['delivery-research', 'First', 'delivery-acceptance']);
});
test('outline/research persistence retains unrelated saved sections across a source-update failure', async () => {
  let saved;
  const gapOutline = answer(outline.detail.replace('"searchTask":""', '"searchTask":"Verify first source"'));
  const ask = async context => {
    if (phaseOf(context) === 'delivery-outline') return gapOutline;
    if (phaseOf(context) === 'delivery-research') return answer('<!-- mindsearch-delivery-research {"status":"searched"} -->\nFirst supplemental source');
    if (phaseOf(context) === 'delivery-writing') return answer(`Full ${sectionOf(context)} content`);
    return acceptance;
  };
  await buildFinalDelivery(base, ask, { ...options, onCheckpoint: value => { saved = JSON.parse(JSON.stringify(value)); } });
  // A damaged outline needs regeneration, but its valid independent section records survive.
  saved.outline = answer('Corrupted outline');
  const updatedEvidence = [{ ...evidence[0], hash: 'a-v2' }, evidence[1]];
  await assert.rejects(buildFinalDelivery(base, async context => {
    if (phaseOf(context) === 'delivery-research') throw new Error('supplemental provider failure');
    return ask(context);
  }, { ...options, evidence: updatedEvidence, checkpoint: saved, onCheckpoint: value => { saved = JSON.parse(JSON.stringify(value)); } }), /supplemental provider failure/);
  assert.ok(saved.sections.second.result.detail.includes('Full Second content'));
  const calls = [];
  await buildFinalDelivery(base, async context => {
    calls.push(phaseOf(context) === 'delivery-writing' ? sectionOf(context) : phaseOf(context));
    return ask(context);
  }, { ...options, evidence: updatedEvidence, checkpoint: saved });
  assert.deepEqual(calls, ['delivery-research', 'First', 'delivery-acceptance']);
});
