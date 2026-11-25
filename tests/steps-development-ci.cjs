const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const YAML = require('yaml');
const root = path.join(__dirname, '..');

test('full CI builds once while all four test shards verify committed artifacts in parallel', () => {
  const workflow = YAML.parse(fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8'));
  const { checks, test: shards, gate } = workflow.jobs;
  const full = checks.steps.find(step => step.if === "env.MODE == 'full'" && step.run?.includes('npm run build'));
  assert.ok(full);
  assert.ok(full.run.includes('git diff --exit-code -- main.js experiences/sharing/viewer-bundle.generated.ts && npm run check:artifacts'));
  assert.equal(shards.needs, 'reuse');
  assert.deepEqual(shards.strategy.matrix.shard, [1, 2, 3, 4]);
  assert.equal(shards.steps.filter(step => step.run === 'npm run test:unit && npm run test:integration').length, 1);
  assert.ok(!shards.steps.some(step => step.run?.includes('npm test') || step.run?.includes('npm run build')));
  assert.ok(shards.steps.some(step => step.run === 'git diff --exit-code -- main.js experiences/sharing/viewer-bundle.generated.ts'));
  assert.ok(gate.needs.includes('checks') && gate.needs.includes('test'));
});

test('shared test helpers load no unused bundles and retain module identity', () => {
  const calls = [];
  const source = fs.readFileSync(path.join(__dirname, 'support.cjs'), 'utf8');
  const module = { exports: {} };
  const mockedRequire = name => name === './build.cjs' ? {
    buildSync: ({ entryPoints }) => {
      calls.push(path.basename(entryPoints[0]));
      return { outputFiles: [{ text: 'module.exports = { Repository: class Repository {}, DEFAULT_SETTINGS: {}, normalizeReasoningLevel: value => value };' }] };
    }
  } : require(name);
  // Evaluate the actual helper with a counting bundle stub, without affecting other suites' module cache.
  require('node:vm').runInNewContext(source, {
    require: mockedRequire, module, __dirname, process, console, TextEncoder, TextDecoder, btoa, Blob, URL, Event, AbortController, setTimeout, clearTimeout
  });
  const h = module.exports;
  h.node('n'); h.map([]); h.plain({ a: 1 });
  assert.deepEqual(calls, []);
  assert.equal(h.core, h.core);
  assert.equal(h.layout, h.layout);
  assert.equal(h.logging, h.logging);
  assert.equal(h.Repository, h.Repository);
  assert.equal(h.DEFAULT_SETTINGS, h.DEFAULT_SETTINGS);
  assert.equal(h.normalizeReasoningLevel('low'), 'low');
  assert.ok(h.fixture().repo instanceof h.Repository);
  assert.deepEqual(calls, ['map-model.ts', 'map-layout.ts', 'log-manager.ts', 'repository.ts']);
});

test('development timing summary separates modes and outcomes without exposing event identifiers', async () => {
  const { summarizeDevEvents } = await import(pathToFileURL(path.join(root, 'scripts/dev-metrics.mjs')).href);
  const row = (durationMs, extra = {}) => ({ version: 1, stage: 'affected-verification', outcome: 'ok', durationMs, mode: 'files', ...extra });
  const raw = [row(30, { fingerprint: 'PRIVATE_ID' }), row(10), row(20), row(100, { mode: 'full' }), row(500, { outcome: 'error' }), row(0, { stage: 'typecheck', mode: undefined }), row(-1), row(1, { stage: 'PRIVATE_STAGE' })].map(x => JSON.stringify(x)).join('\n') + '\nbroken';
  const report = summarizeDevEvents(raw);
  assert.equal(report.informationalOnly, true);
  assert.equal(report.invalid, 3);
  assert.equal(report.rows.length, 4);
  assert.deepEqual(report.rows.find(r => r.mode === 'files' && r.outcome === 'ok'), { stage: 'affected-verification', outcome: 'ok', mode: 'files', samples: 3, p50Ms: 20, p95Ms: 30 });
  assert.ok(report.rows.some(r => r.mode === 'full' && r.p95Ms === 100));
  assert.ok(report.rows.some(r => r.outcome === 'error' && r.p95Ms === 500));
  assert.ok(report.rows.some(r => r.stage === 'typecheck' && r.p95Ms === 0));
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE/);
  assert.deepEqual(summarizeDevEvents('').rows, []);
});

test('lazy shared module loads remain visible to the existing conservative dependency scanner', async () => {
  const { scanTestFile, buildDeps } = await import(pathToFileURL(path.join(root, 'scripts/test-affected.mjs')).href);
  const helper = 'tests/support.cjs';
  const consumer = 'tests/suites/example.cjs';
  const scans = {
    [helper]: scanTestFile(root, helper),
    [consumer]: { sources: [], prefixes: [], requires: [helper], reasons: [], cachedLoads: [] }
  };
  for (const entry of ['map-model.ts', 'map-layout.ts', 'log-manager.ts', 'repository.ts']) assert.ok(scans[helper].cachedLoads.includes(entry), entry);
  const deps = buildDeps({ testFiles: [consumer], records: {}, scans, bundles: { 'repository.ts': ['core/example.ts'] }, sha: 'a'.repeat(40) });
  assert.ok(deps.tests[consumer].sources.map(i => deps.paths[i]).includes('core/example.ts'));
});

test('new development stage timings use existing event summaries and preserve async failures', async () => {
  const { timedAsync, summarizeDevEvents } = await import(pathToFileURL(path.join(root, 'scripts/dev-metrics.mjs')).href);
  const stages = ['affected-plan', 'deps-fetch', 'deps-refresh', 'candidate-evidence', 'ci-proof-lookup', 'source-fingerprint', 'artifact-hashes', 'session-prepare', 'session-reload'];
  const raw = stages.map(stage => JSON.stringify({ version: 1, stage, outcome: 'ok', durationMs: 1 })).join('\n');
  const result = summarizeDevEvents(raw);
  assert.equal(result.invalid, 0);
  assert.equal(result.rows.length, stages.length);
  assert.equal(await timedAsync('session-reload', async () => 'loaded'), 'loaded');
  const failure = new Error('reload failed');
  await assert.rejects(timedAsync('session-reload', async () => { throw failure; }), error => error === failure);
});
