const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { buildSync } = require('esbuild');
const code = buildSync({ entryPoints: ['experiences/mind-search/final-delivery.ts'], bundle: true, write: false, platform: 'node', format: 'cjs' }).outputFiles[0].text;
const moduleValue = { exports: {} };
vm.runInNewContext(code, { module: moduleValue, exports: moduleValue.exports });
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
  const delivery = await buildFinalDelivery(base, async () => result(outputs.shift()));
  assert.ok(delivery.result.detail.includes('"research_more"'));
});
