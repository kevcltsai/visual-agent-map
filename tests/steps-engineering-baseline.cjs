// Offline baseline runner. Existing fixtures, real product functions; no provider calls, no Vault access.
// Normal unit runs exercise one small control; opt-in runs print numerical diagnostics without timing gates.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { load, root } = require('./support-replay.cjs');
const { LARGE, zhText } = require('./tools/map-chat-eval/size.cjs');

const { estimateTokens, buildPreparedTaskContext } = load('ai/context-builder.ts');
const { estimateMapChatTokens } = load('core/map-chat-tokens.ts');
const { estimateUsageTokens } = load('core/ai-usage-store.ts');
const { buildMapChatContext } = load('core/map-chat-context.ts');
const { arrangeMap } = load('map-layout.ts');
const full = process.env.VAM_ENGINEERING_BASELINE === '1';
const samples = full ? 15 : 1;
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const percentile = (sorted, fraction) => sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];

function measure(run, summarize) {
  const warm = run();
  const expected = sha(summarize(warm));
  const durations = [];
  for (let i = 0; i < samples; i++) {
    const start = performance.now();
    const output = run();
    durations.push(performance.now() - start);
    assert.equal(sha(summarize(output)), expected, 'same input yields the same measured result');
  }
  durations.sort((a, b) => a - b);
  return { samples, p50Ms: percentile(durations, .5), p95Ms: percentile(durations, .95), outputSha256: expected, ...summarize(warm) };
}

const estimates = text => ({
  utf16Units: text.length,
  utf8Bytes: Buffer.byteLength(text),
  taskEstimate: estimateTokens(text),
  chatEstimate: estimateMapChatTokens(text),
  usageEstimate: estimateUsageTokens(text)
});

test('engineering baseline: offline context and layout controls', t => {
  const report = { schema: 1, evidence: 'offline-synthetic', actualProviderUsage: 'NOT RUN', nativeUi: 'NOT RUN', tokenEstimatesAreNotBilledUsage: true, contexts: [], layouts: [], taskContexts: [] };
  for (const [id, text] of [
    ['en', 'The team discussed delivery dates and staffing. '.repeat(200)],
    ['zh', zhText(13_000, 3)],
    ['mixed', zhText(6_000, 4) + 'Research summary and evidence. '.repeat(200)],
    ['unicode', '中文𠀀 한국어 カタカナ café 😀'.repeat(100)]
  ]) {
    const counts = estimates(text);
    assert.ok(Object.values(counts).every(n => Number.isFinite(n) && n > 0));
    report.contexts.push({ id, inputSha256: sha(text), ...counts });
  }

  for (const item of full ? LARGE : LARGE.filter(item => item.id === 'SZ1c')) {
    const input = item.input;
    const inputHash = sha(input);
    const metrics = measure(() => buildMapChatContext(input), result => ({
      ...estimates(result.json), contextSha256: sha(result.json),
      outlineSent: JSON.parse(result.json).outline.length,
      editableFiles: Object.keys(result.mdHashes).length
    }));
    assert.equal(sha(input), inputHash, 'context preparation must not mutate the input');
    report.contexts.push({ id: item.id, inputSha256: inputHash, ...metrics });
  }
  assert.ok(report.contexts.some(row => row.id === 'SZ1c'));

  for (const [id, source] of [
    ['en-small', 'Research evidence. '.repeat(200)],
    ['zh-large', zhText(210_000, 7)]
  ].slice(0, full ? 2 : 1)) {
    const input = { title: 'Topic', summary: 'Summary', task: 'Research the evidence', rules: 'Use evidence', detail: '', ancestors: '', workingFindings: '', sourceContext: source, mode: 'task' };
    const inputHash = sha(input);
    const metrics = measure(() => buildPreparedTaskContext(input, 'offline-fixture'), result => ({
      contextSha256: sha(result.context),
      sourceUnits: result.context.sourceContext.length,
      estimatedInputTokens: result.metrics.estimatedInputTokens,
      breakdown: result.metrics.contextBreakdown
    }));
    assert.equal(sha(input), inputHash);
    assert.ok(metrics.sourceUnits <= source.length);
    report.taskContexts.push({ id, inputSha256: inputHash, ...metrics });
  }

  for (const count of full ? [64, 256, 1024] : [64]) {
    const nodes = Array.from({ length: count }, (_, i) => ({
      id: String(i), parentId: i === 0 ? null : String(Math.floor((i - 1) / 4)),
      path: `topic-${i}.md`, x: 0, y: 0, collapsed: false
    }));
    const inputHash = sha(nodes);
    const metrics = measure(() => arrangeMap(nodes, undefined, undefined, 'right'), result => {
      assert.equal(result.length, count);
      assert.ok(result.every((node, i) => node.id === nodes[i].id && node.parentId === nodes[i].parentId && Number.isFinite(node.x) && Number.isFinite(node.y)));
      return { nodes: count, positionsSha256: sha(result.map(node => [node.id, node.x, node.y])) };
    });
    assert.equal(sha(nodes), inputHash, 'layout must not mutate original nodes');
    report.layouts.push({ inputSha256: inputHash, ...metrics });
  }
  if (full) {
    const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    report.environment = { node: process.version, platform: process.platform, arch: process.arch, commit: git(['rev-parse', 'HEAD']), dirty: Boolean(git(['status', '--porcelain'])) };
    t.diagnostic(JSON.stringify(report));
  }
});
