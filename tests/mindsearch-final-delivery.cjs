const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { buildSync } = require('esbuild');
const code = buildSync({ entryPoints: ['experiences/mind-search/final-delivery.ts'], bundle: true, write: false, platform: 'node', format: 'cjs' }).outputFiles[0].text;
const moduleValue = { exports: {} };
vm.runInNewContext(code, { module: moduleValue, exports: moduleValue.exports, require });
const { parseDeliveryOutline, buildFinalDelivery } = moduleValue.exports;
const base = { title: 'Goal', detail: 'Known conditions and prior reports', signal: new AbortController().signal };
const outline = '<!-- mindsearch-delivery-outline {"sections":[{"heading":"Steps","purpose":"Execute the goal","searchTask":"Find concrete examples"}]} -->';
const result = detail => ({ summary: 'Preview', detail, suggestions: [] });
test('final delivery follows outline, web research, full writing and acceptance', async () => {
  const calls = [];
  const outputs = [outline, '<!-- mindsearch-delivery-research {"status":"searched"} -->\nSource: https://example.org/docs', 'Complete actionable document', '<!-- mindsearch-review {"decision":"conclude","rationale":"Complete","stopReason":"All sections usable"} -->\nComplete actionable document'];
  const delivery = await buildFinalDelivery(base, async context => { calls.push(context); return result(outputs[calls.length - 1]); });
  assert.equal(calls.length, 4);
  assert.equal(calls[1].researchMode, 'research');
  assert.equal(calls[1].mindSearchIsolatedResearch, true);
  assert.equal(calls[2].researchMode, 'local');
  assert.ok(calls[2].task.includes('https://example.org/docs'));
  assert.ok(calls[3].task.includes('Complete actionable document'));
  assert.ok(delivery.result.detail.includes('Complete actionable document'));
});
test('missing or unavailable search never reaches writing or conclusion', async () => {
  for (const report of ['No search happened', '<!-- mindsearch-delivery-research {"status":"unavailable"} -->']) {
    let calls = 0;
    await assert.rejects(() => buildFinalDelivery(base, async () => result(++calls === 1 ? outline : report)));
    assert.equal(calls, 2);
  }
});
test('invalid and duplicate outlines are rejected', () => {
  assert.throws(() => parseDeliveryOutline('No marker'));
  assert.throws(() => parseDeliveryOutline('<!-- mindsearch-delivery-outline {"sections":[]} -->'));
  assert.throws(() => parseDeliveryOutline('<!-- mindsearch-delivery-outline {"sections":[{"heading":"A","purpose":"x","searchTask":""},{"heading":"a","purpose":"y","searchTask":""}]} -->'));
});
test('cancellation stops before another model call', async () => {
  const controller = new AbortController(); let calls = 0;
  await assert.rejects(() => buildFinalDelivery({ ...base, signal: controller.signal }, async () => { calls++; controller.abort(); return result(outline); }));
  assert.equal(calls, 1);
});
test('acceptance can retain a research gap without converting it to completion', async () => {
  const outputs = [outline, '<!-- mindsearch-delivery-research {"status":"searched"} -->\nUnresolved resource', 'Draft', '<!-- mindsearch-review {"decision":"research_more","rationale":"Missing concrete resources"} -->\nPartial'];
  const delivery = await buildFinalDelivery(base, async () => {
    const response = result(outputs.shift());
    if (response.detail.includes('\"decision\":\"research_more\"')) response.suggestions = [{ title: 'Concrete resource', task: 'Find a verified resource', contribution: 'Resolve the missing evidence' }];
    return response;
  });
  assert.ok(delivery.result.detail.includes('"research_more"'));
  assert.ok(delivery.result.detail.includes('Draft pending completion\n\nDraft'));
  assert.ok(delivery.result.detail.includes('Missing concrete resources'));
});
test('final delivery acceptance cannot replace or shorten the writer draft', async () => {
  const draft = 'Original complete document\n\nUnique source-backed step https://example.org/proof';
  const outputs = [outline, '<!-- mindsearch-delivery-research {"status":"searched"} -->\nSource https://example.org/proof', draft, '<!-- mindsearch-review {"decision":"conclude","rationale":"Verified","stopReason":"Ready"} -->\nShort acceptance note'];
  const delivery = await buildFinalDelivery(base, async () => result(outputs.shift()));
  assert.equal(delivery.result.detail.split('-->')[1].trim(), draft);
  assert.ok(!delivery.result.detail.includes('Short acceptance note'));
});
test('final delivery reuses evidence when outline has no search gaps', async () => {
  const phases = [];
  const outputs = ['<!-- mindsearch-delivery-outline {"sections":[{"heading":"Answer","purpose":"Existing proof","searchTask":""}]} -->', 'Full draft', '<!-- mindsearch-review {"decision":"conclude","rationale":"Complete","stopReason":"Ready"} -->\nPass'];
  await buildFinalDelivery(base, async context => { phases.push(context.task.match(/mindsearch-phase: ([a-z-]+)/)[1]); return result(outputs.shift()); });
  assert.deepEqual(phases, ['delivery-outline', 'delivery-writing', 'delivery-acceptance']);
});
