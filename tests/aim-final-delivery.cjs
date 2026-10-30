const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { buildSync } = require('./build.cjs');
const code = buildSync({ entryPoints: ['experiences/aim/final-delivery.ts'] }).outputFiles[0].text;
const moduleValue = { exports: {} };
vm.runInNewContext(code, { module: moduleValue, exports: moduleValue.exports, require });
const { parseDeliveryOutline, buildFinalDelivery } = moduleValue.exports;
const base = { title: 'Goal', detail: 'Known conditions and prior reports', signal: new AbortController().signal };
const outline = '<!-- aim-delivery-outline {"sections":[{"heading":"Steps","purpose":"Execute the goal","searchTask":"Find concrete examples"}]} -->';
const result = detail => ({ summary: 'Preview', detail, suggestions: [] });
test('final delivery follows outline, web research, full writing and acceptance', async () => {
  const calls = [];
  const outputs = [outline, '<!-- aim-delivery-research {"status":"searched"} -->\nSource: https://example.org/docs', 'Complete actionable document', '<!-- aim-review {"decision":"conclude","rationale":"Complete","stopReason":"All sections usable"} -->\nComplete actionable document'];
  const delivery = await buildFinalDelivery(base, async context => { calls.push(context); return result(outputs[calls.length - 1]); });
  assert.equal(calls.length, 4);
  assert.equal(calls[1].researchMode, 'research');
  assert.equal(calls[1].aimIsolatedResearch, true);
  assert.equal(calls[2].researchMode, 'local');
  assert.ok(calls[2].task.includes('https://example.org/docs'));
  assert.ok(calls[3].task.includes('Complete actionable document'));
  assert.ok(delivery.result.detail.includes('Complete actionable document'));
});
test('missing or unavailable search never reaches writing or conclusion', async () => {
  for (const report of ['No search happened', '<!-- aim-delivery-research {"status":"unavailable"} -->']) {
    let calls = 0;
    await assert.rejects(() => buildFinalDelivery(base, async () => result(++calls === 1 ? outline : report)));
    assert.equal(calls, 2);
  }
});
test('invalid and duplicate outlines are rejected', () => {
  assert.throws(() => parseDeliveryOutline('No marker'));
  assert.throws(() => parseDeliveryOutline('<!-- aim-delivery-outline {"sections":[]} -->'));
  assert.throws(() => parseDeliveryOutline('<!-- aim-delivery-outline {"sections":[{"heading":"A","purpose":"x","searchTask":""},{"heading":"a","purpose":"y","searchTask":""}]} -->'));
});
test('cancellation stops before another model call', async () => {
  const controller = new AbortController(); let calls = 0;
  await assert.rejects(() => buildFinalDelivery({ ...base, signal: controller.signal }, async () => { calls++; controller.abort(); return result(outline); }));
  assert.equal(calls, 1);
});
test('acceptance can retain a research gap without converting it to completion', async () => {
  const outputs = [outline, '<!-- aim-delivery-research {"status":"searched"} -->\nUnresolved resource', 'Draft', '<!-- aim-review {"decision":"research_more","rationale":"Missing concrete resources"} -->\nPartial'];
  const delivery = await buildFinalDelivery(base, async () => {
    const response = result(outputs.shift());
    if (response.detail.includes('\"decision\":\"research_more\"')) response.suggestions = [{ title: 'Concrete resource', task: 'Find a verified resource', contribution: 'Resolve the missing evidence' }];
    return response;
  });
  assert.ok(delivery.result.detail.includes('"research_more"'));
  assert.ok(delivery.result.detail.includes('Draft pending completion\n\nDraft'));
  assert.ok(delivery.result.detail.includes('Missing concrete resources'));
});
test('AIM pending-draft heading follows the content language', async () => {
  for (const [language, heading, other] of [['zh-TW', '## 草稿待補完\n\nDraft', 'Draft pending completion'], ['en', '## Draft pending completion\n\nDraft', '草稿待補完']]) {
    const outputs = [outline, '<!-- aim-delivery-research {"status":"searched"} -->\nUnresolved resource', 'Draft', '<!-- aim-review {"decision":"research_more","rationale":"Missing concrete resources"} -->\nPartial'];
    const delivery = await buildFinalDelivery({ ...base, outputLanguage: language }, async () => {
      const response = result(outputs.shift());
      if (response.detail.includes('"decision":"research_more"')) response.suggestions = [{ title: 'Concrete resource', task: 'Find a verified resource', contribution: 'Resolve the missing evidence' }];
      return response;
    });
    assert.ok(delivery.result.detail.includes(heading), language);
    assert.ok(!delivery.result.detail.includes(other), language);
  }
});
test('final delivery acceptance cannot replace or shorten the writer draft', async () => {
  const draft = 'Original complete document\n\nUnique source-backed step https://example.org/proof';
  const outputs = [outline, '<!-- aim-delivery-research {"status":"searched"} -->\nSource https://example.org/proof', draft, '<!-- aim-review {"decision":"conclude","rationale":"Verified","stopReason":"Ready"} -->\nShort acceptance note'];
  const delivery = await buildFinalDelivery(base, async () => result(outputs.shift()));
  assert.equal(delivery.result.detail.split('-->')[1].trim(), draft);
  assert.ok(!delivery.result.detail.includes('Short acceptance note'));
});
test('final delivery reuses evidence when outline has no search gaps', async () => {
  const phases = [];
  const outputs = ['<!-- aim-delivery-outline {"sections":[{"heading":"Answer","purpose":"Existing proof","searchTask":""}]} -->', 'Full draft', '<!-- aim-review {"decision":"conclude","rationale":"Complete","stopReason":"Ready"} -->\nPass'];
  await buildFinalDelivery(base, async context => { phases.push(context.task.match(/aim-phase: ([a-z-]+)/)[1]); return result(outputs.shift()); });
  assert.deepEqual(phases, ['delivery-outline', 'delivery-writing', 'delivery-acceptance']);
});

// Lineage evidence in the delivery writer (formerly aim-delivery-lineage.cjs).
const lineageBase = { title: 'Goal', detail: 'Conditions' };
const answer = detail => ({ summary: 'Preview', detail, suggestions: [], visualReferences: [] });
const phaseOf = context => context.task.match(/aim-phase: ([a-z-]+)/)[1];
const current = [{ id: 'cur-1', hash: 'h1', detail: '## Current\n\nCURRENT-DETAIL' }];
const lineage = [{ id: 'L-v6', hash: 'hl', detail: '## Earlier\n\n史前博物館週一休' }];
const outlineWith = section => answer(`<!-- aim-delivery-outline ${JSON.stringify({ sections: [{ heading: 'Steps', purpose: 'Execute', searchTask: '', ...section }] })} -->`);

async function run(outline, options) {
  const tasks = {};
  await buildFinalDelivery(lineageBase, async context => {
    const phase = phaseOf(context);
    tasks[phase] = context.task;
    if (phase === 'delivery-outline') return outline;
    if (phase === 'delivery-research') return answer('<!-- aim-delivery-research {"status":"searched"} -->');
    if (phase === 'delivery-writing') return answer('Draft');
    return answer('<!-- aim-review {"decision":"conclude","rationale":"ok","stopReason":"Ready"} -->');
  }, { evidence: current, knownConditions: '{}', ...options, onCheckpoint: c => { tasks.checkpoint = JSON.parse(JSON.stringify(c)); } });
  return tasks;
}

test('writer reads a lineage source the outline maps; outline and acceptance do not carry it', async () => {
  const tasks = await run(outlineWith({ evidenceIds: ['L-v6'] }), { lineageEvidence: lineage });
  assert.ok(tasks['delivery-writing'].includes('史前博物館週一休'));
  assert.deepEqual(tasks.checkpoint.sections.document.evidenceIds, ['L-v6']);
  assert.ok(!tasks['delivery-outline'].includes('史前博物館週一休'));
  assert.ok(!tasks['delivery-acceptance'].includes('史前博物館週一休'));
});

test('an id in neither pool is dropped', async () => {
  const tasks = await run(outlineWith({ evidenceIds: ['L-v6', 'invented'] }), { lineageEvidence: lineage });
  assert.deepEqual(tasks.checkpoint.sections.document.evidenceIds, ['L-v6']);
  const none = await run(outlineWith({ evidenceIds: ['invented'] }), { lineageEvidence: lineage });
  assert.deepEqual(none.checkpoint.sections.document.evidenceIds, ['cur-1']);
});

test('a section without a mapping pulls only this round evidence', async () => {
  const tasks = await run(outlineWith({}), { lineageEvidence: lineage });
  assert.deepEqual(tasks.checkpoint.sections.document.evidenceIds, ['cur-1']);
  assert.ok(!tasks['delivery-writing'].includes('史前博物館週一休'));
});

test('a current-round source wins an id collision with lineage', async () => {
  const tasks = await run(outlineWith({ evidenceIds: ['cur-1'] }), { lineageEvidence: [{ id: 'cur-1', hash: 'x', detail: 'LINEAGE-COPY' }] });
  assert.ok(tasks['delivery-writing'].includes('CURRENT-DETAIL'));
  assert.ok(!tasks['delivery-writing'].includes('LINEAGE-COPY'));
});
