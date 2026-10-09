const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { buildSync } = require('esbuild');

const code = buildSync({ entryPoints: ['mindsearch-mve/planner-review.ts'], bundle: true, write: false, platform: 'node', format: 'cjs' }).outputFiles[0].text;
const moduleValue = { exports: {} };
vm.runInNewContext(code, { module: moduleValue, exports: moduleValue.exports });
const { parseMindSearchPlannerReviewWithRecovery } = moduleValue.exports;
const fixture = JSON.parse(fs.readFileSync(path.join('tests/fixtures/mindsearch/ask_user_missing_options.json'), 'utf8'));
const context = { question: 'Fixture question', answerSnapshot: 'Synthetic answer snapshot', reportSummary: 'Private full report summary', reportDetail: 'Private full report detail' };

test('captured ask_user with missing suggestions repairs choices and preserves original content', async () => {
  const calls = [];
  const parsed = await parseMindSearchPlannerReviewWithRecovery(fixture.result, context, async task => {
    calls.push(task);
    assert.match(task, /Repair only the missing answer choices/);
    assert.match(task, /Original question: 此合成分支選定的牛排熟度是哪一種？請選：三分熟、五分熟、七分熟、全熟，或其他。/);
    assert.doesNotMatch(task, /Private full report|Already completed report/);
    return {
      summary: '替換後的摘要不可採用。',
      detail: '<!-- mindsearch-review {"decision":"ask_user","rationale":"替換後的理由不可採用。","question":"替換後的問題不可採用？"} -->\n替換後的正文不可採用。',
      suggestions: ['三分熟', '五分熟', '七分熟', '全熟', '其他'].map(title => ({ title, task: '', contribution: '' }))
    };
  });
  assert.equal(calls.length, 1);
  assert.equal(parsed.decision, 'ask_user');
  assert.equal(parsed.question, '此合成分支選定的牛排熟度是哪一種？請選：三分熟、五分熟、七分熟、全熟，或其他。');
  assert.equal(parsed.rationale, fixture.result.detail.match(/"rationale":"([^"]+)/)[1]);
  assert.equal(parsed.summary, fixture.result.summary);
  assert.equal(parsed.detail, fixture.result.detail.replace(/^<!--[\s\S]*?-->\s*/, '').trim());
  assert.deepEqual(Array.from(parsed.answerOptions), ['三分熟', '五分熟', '七分熟', '全熟', '其他']);
});

test('explicitly labeled 2–5 option bullets are recovered without a model call', async () => {
  const original = {
    summary: 'A choice is needed.',
    detail: '<!-- mindsearch-review {"decision":"ask_user","rationale":"This preference changes the recommendation.","question":"Which pace do you prefer?"} -->\nThe supported answer is conditional.\n\nAnswer options:\n- Relaxed pace\n- Fast pace',
    suggestions: []
  };
  let calls = 0;
  const parsed = await parseMindSearchPlannerReviewWithRecovery(original, context, async () => { calls++; throw new Error('must not call model'); });
  assert.equal(calls, 0);
  assert.deepEqual(Array.from(parsed.answerOptions), ['Relaxed pace', 'Fast pace']);
  assert.equal(parsed.question, 'Which pace do you prefer?');
  assert.equal(parsed.detail, 'The supported answer is conditional.\n\nAnswer options:\n- Relaxed pace\n- Fast pace');
});

test('repair cannot switch a valid original decision to conclude', async () => {
  await assert.rejects(() => parseMindSearchPlannerReviewWithRecovery(fixture.result, context, async () => ({
    summary: 'Concluded.',
    detail: '<!-- mindsearch-review {"decision":"conclude","rationale":"Complete","stopReason":"No more work."} -->\nChanged body.',
    suggestions: []
  })), /changed or omitted the original ask_user decision/);
});

test('malformed marker fallback uses one repair and does not pretend the original decision is known', async () => {
  const original = { summary: 'Draft', detail: 'No usable decision marker. Draft body.', suggestions: [] };
  let calls = 0;
  await assert.rejects(() => parseMindSearchPlannerReviewWithRecovery(original, context, async task => {
    calls++;
    assert.match(task, /original decision marker is unusable/);
    assert.match(task, /Private full report summary/);
    return original;
  }), /missing its machine-readable decision block/);
  assert.equal(calls, 1);
});

test('invalid repair remains bounded to one model call', async () => {
  let calls = 0;
  await assert.rejects(() => parseMindSearchPlannerReviewWithRecovery(fixture.result, context, async () => {
    calls++;
    return fixture.result;
  }), /did not provide 2–5 distinct answer choices/);
  assert.equal(calls, 1);
});
test('question followed only by answer bullets needs no format-repair model call', async () => {
  const question = 'How much time can you spend each day?';
  const original = { summary: 'Time changes the plan.', detail: `<!-- mindsearch-review ${JSON.stringify({ decision: 'ask_user', rationale: 'Daily time is unknown.', question })} -->\n${question}\n\n- 1–2 hours\n- 3–5 hours\n- 6 hours or more`, suggestions: [] };
  const parsed = await parseMindSearchPlannerReviewWithRecovery(original, context, async () => { throw new Error('should recover existing choices'); });
  assert.equal(parsed.question, question);
  assert.deepEqual(Array.from(parsed.answerOptions), ['1–2 hours', '3–5 hours', '6 hours or more']);
});
