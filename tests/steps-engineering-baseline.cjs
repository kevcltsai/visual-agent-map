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

test('engineering baseline: simulated store I/O and hydrate cache scope', async t => {
  const { readStoreText, writeStoreAtomically } = load('store-adapter.ts');
  const { createNoteReadContext, readOnce } = load('core/note-read-context.ts');
  const path = 'store.json';
  const text = JSON.stringify({ text: zhText(4000, 3) });
  const bytes = Buffer.byteLength(text);
  function adapterFor(initial) {
    const files = new Map(initial);
    const calls = { exists: 0, read: 0, write: 0, rename: 0, remove: 0, readBytes: 0, writtenBytes: 0 };
    return {
      files, calls,
      adapter: {
        async exists(name) { calls.exists++; return files.has(name); },
        async read(name) {
          calls.read++;
          assert.ok(files.has(name));
          const value = files.get(name);
          calls.readBytes += Buffer.byteLength(value);
          return value;
        },
        async write(name, value) {
          calls.write++; calls.writtenBytes += Buffer.byteLength(value); files.set(name, value);
        },
        async rename(from, to) {
          calls.rename++;
          assert.ok(files.has(from) && !files.has(to));
          files.set(to, files.get(from)); files.delete(from);
        },
        async remove(name) { calls.remove++; assert.ok(files.delete(name)); }
      }
    };
  }
  const stores = [];
  for (const [id, initial] of [
    ['create', []],
    ['replace', [[path, 'old']]],
    ['recover-before-replace', [[path + '.tmp', 'recoverable']]]
  ]) {
    const { adapter, files, calls } = adapterFor(initial);
    await writeStoreAtomically(adapter, path, text);
    assert.equal(files.get(path), text);
    assert.equal(files.has(path + '.tmp'), false);
    assert.equal(calls.write, 1);
    assert.equal(calls.writtenBytes, bytes);
    stores.push({ id, ...calls });
  }
  const recovery = adapterFor([[path + '.tmp', text]]);
  assert.equal(await readStoreText(recovery.adapter, path), text);
  assert.equal(recovery.files.get(path), text);
  assert.equal(recovery.files.has(path + '.tmp'), false);
  stores.push({ id: 'recover-on-read', ...recovery.calls });

  const unique = full ? 256 : 8;
  const repeats = full ? 20 : 2;
  let reads = 0;
  const caches = [];
  const read = async () => { reads++; return text; };
  for (let round = 0; round < 3; round++) {
    const ctx = createNoteReadContext();
    const before = reads;
    const results = await Promise.all(Array.from({ length: unique * repeats }, (_, i) =>
      readOnce(ctx, 'note-' + (i % unique), read)));
    assert.equal(reads - before, unique);
    assert.equal(ctx.reads.size, unique);
    assert.ok(results.every(result => result === text));
    caches.push({ round, requests: results.length, reads: reads - before, cacheEntries: ctx.reads.size, readBytes: unique * bytes });
  }
  const failed = createNoteReadContext();
  const fail = async () => { throw new Error('simulated read failure'); };
  const a = readOnce(failed, 'missing', fail);
  const b = readOnce(failed, 'missing', fail);
  assert.equal(a, b);
  await assert.rejects(a, /simulated read failure/);
  assert.equal(failed.failedPaths.has('missing'), true);
  assert.equal(await readOnce(createNoteReadContext(), 'missing', read), text);
  if (full) t.diagnostic(JSON.stringify({
    schema: 1, evidence: 'simulated-io-and-cache-scope', stores, caches,
    nativeVaultIo: 'NOT RUN', heapAndProcess: 'NOT RUN'
  }));
});
