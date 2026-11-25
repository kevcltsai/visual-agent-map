const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { load, root } = require('./support-replay.cjs');

const { claudeReportedUsage, codexReportedUsage, normalizeReportedUsage, reportedUsageSubtotal } = load('core/ai-usage-measurement.ts');
const plain = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

test('provider usage preserves explicit zeros, rejects invalid facts and does not invent missing counts', () => {
  assert.deepEqual(plain(claudeReportedUsage({ input_tokens: 2, cache_creation_input_tokens: 1000, cache_read_input_tokens: 40000, output_tokens: 300 })), { inputTokens: 41002, outputTokens: 300, cacheReadInputTokens: 40000, cacheWriteInputTokens: 1000 });
  assert.deepEqual(plain(claudeReportedUsage({ input_tokens: 0 })), { inputTokens: 0 });
  assert.deepEqual(plain(claudeReportedUsage({ cache_read_input_tokens: 100, output_tokens: 4 })), { outputTokens: 4, cacheReadInputTokens: 100 });
  assert.deepEqual(plain(claudeReportedUsage({ input_tokens: 10, cache_read_input_tokens: -1, output_tokens: 2 })), { outputTokens: 2 });
  assert.deepEqual(plain(codexReportedUsage({ inputTokens: 100, outputTokens: 0, cachedInputTokens: 60, cacheWriteInputTokens: 0 })), { inputTokens: 100, outputTokens: 0, cacheReadInputTokens: 60, cacheWriteInputTokens: 0 });
  assert.deepEqual(plain(codexReportedUsage({ inputTokens: 5, outputTokens: null })), { inputTokens: 5 });
  assert.equal(normalizeReportedUsage({ inputTokens: -1, outputTokens: NaN, cacheReadInputTokens: Infinity }), undefined);
  assert.deepEqual(plain(normalizeReportedUsage({ inputTokens: 10, outputTokens: 3, prompt: 'private' })), { inputTokens: 10, outputTokens: 3 });
  assert.deepEqual(plain(reportedUsageSubtotal({ inputTokens: 0 })), { inputTokens: 0, outputTokens: 0, incomplete: true });
  assert.deepEqual(plain(reportedUsageSubtotal({ inputTokens: 0, outputTokens: 0 })), { inputTokens: 0, outputTokens: 0 });
  assert.equal(reportedUsageSubtotal({ cacheReadInputTokens: 4 }), undefined);
});

const script = path.join(root, 'scripts/engineering-usage-scorecard.mjs');
const records = [
  { model: 'claude:sonnet', effort: 'low', step: 'task.run@1', status: 'completed', durationMs: 100, sentAt: '2026-11-25T00:00:00.000Z', milestones: { usage: { inputTokens: 100, outputTokens: 0, cacheReadInputTokens: 60 }, firstTextAt: '2026-11-25T00:00:00.030Z', receivedAt: '2026-11-25T00:00:00.080Z', apiRetries: [] }, prompt: 'PRIVATE_PROMPT', topic: 'PRIVATE_TOPIC', id: 'PRIVATE_ID' },
  { model: 'claude:sonnet', effort: 'low', step: 'task.run@1', status: 'failed', durationMs: 200, milestones: { usage: { outputTokens: 3 }, apiRetries: [429] }, error: 'PRIVATE_ERROR' },
  { model: 'gpt-test', effort: 'high', status: 'sent', response: 'PRIVATE_RESPONSE', milestones: { usage: { inputTokens: -1, outputTokens: null, cacheWriteInputTokens: 0 } } }
];
test('engineering scorecard separates complete, partial, missing, timing and retry evidence', async () => {
  const { buildUsageScorecard } = await import(pathToFileURL(script).href);
  const report = buildUsageScorecard(records);
  assert.equal(report.selectedEntries, 3);
  assert.deepEqual(report.total.usage.complete, { entries: 1, inputTokens: 100, outputTokens: 0 });
  assert.deepEqual(report.total.usage.partial, { entries: 1, inputSamples: 0, outputSamples: 1, knownInputTokens: 0, knownOutputTokens: 3 });
  assert.equal(report.total.usage.missing, 1);
  assert.deepEqual(report.total.usage.cache, { read: { samples: 1, tokens: 60 }, write: { samples: 1, tokens: 0 } });
  assert.equal(report.total.outcomes.completed, 1);
  assert.equal(report.total.outcomes.failed, 1);
  assert.equal(report.total.outcomes.sent, 1);
  assert.deepEqual(report.total.exchangeDuration, { samples: 2, unavailable: 0, p50Ms: 100, p95Ms: 200 });
  assert.deepEqual(report.total.firstTextFromLoggedSend, { samples: 1, unavailable: 2, p50Ms: 30, p95Ms: 30 });
  assert.deepEqual(report.total.replyFromLoggedSend, { samples: 1, unavailable: 2, p50Ms: 80, p95Ms: 80 });
  assert.deepEqual(report.total.reportedApiRetries, { samples: 2, unavailable: 1, events: 1 });
  assert.equal(report.claude.entries, 2);
  assert.equal(report.codex.entries, 1);
  assert.equal(buildUsageScorecard(records, { step: 'task.run@1', effort: 'low', model: 'claude:sonnet' }).selectedEntries, 2);
  assert.equal(buildUsageScorecard(records, { model: 'unknown' }).total.exchangeDuration.p95Ms, null);
  assert.equal(report.taskAttribution, 'unavailable');
  assert.equal(report.semanticQuality, 'unavailable');
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_|claude:sonnet|gpt-test/);
  assert.throws(() => buildUsageScorecard([{ model: 'x', status: 'unknown' }]), /Invalid exchange log shape/);
});

test('scorecard CLI reads the file without modifying it and never prints private log content', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vam-scorecard-'));
  try {
    const file = path.join(dir, 'ai-exchanges.json');
    const data = JSON.stringify(records);
    fs.writeFileSync(file, data);
    const run = spawnSync(process.execPath, [script, file, '--model=claude:sonnet'], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(JSON.parse(run.stdout).selectedEntries, 2);
    assert.doesNotMatch(run.stdout + run.stderr, /PRIVATE_|claude:sonnet/);
    assert.equal(fs.readFileSync(file, 'utf8'), data);
    fs.writeFileSync(file, 'PRIVATE_INVALID');
    const invalid = spawnSync(process.execPath, [script, file], { encoding: 'utf8' });
    assert.equal(invalid.status, 1);
    assert.doesNotMatch(invalid.stdout + invalid.stderr, /PRIVATE_INVALID/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('usage fact normalization remains dependency-free', () => {
  const source = fs.readFileSync(path.join(root, 'core/ai-usage-measurement.ts'), 'utf8');
  assert.doesNotMatch(source, /^\s*import\s/m);
});
