// CI sharding (scripts/test-integration.mjs shardParts, scripts/ci-shard-gate.mjs, .github/workflows/ci.yml): the shards partition the parts, the gate rejects an incomplete or red run.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const YAML = require('yaml');
const { test, root } = require('../support.cjs');
const mod = name => import(pathToFileURL(path.join(root, 'scripts', name)).href);
const FILES = Array.from({ length: 23 }, (_, i) => `tests/f${String(i).padStart(2, '0')}.cjs`);
const sizeOf = file => 100 + (Number(file.slice(7, 9)) * 37) % 11; // varied, with ties

test('ci shard: unset VAM_CI_SHARD leaves the parts untouched', async () => {
  const { shardParts, parseShard } = await mod('test-integration.mjs');
  const list = [{ name: 'a', args: ['tests/run.cjs'] }, { name: 'b', args: ['--test', ...FILES] }];
  assert.equal(parseShard(''), null);
  assert.equal(shardParts(list, parseShard(''), { splitNodeTest: true, sizeOf }), list);
});
test('ci shard: bad VAM_CI_SHARD values throw', async () => {
  const { parseShard } = await mod('test-integration.mjs');
  for (const bad of ['0/4', '5/4', 'x', '1/', '1-4']) assert.throws(() => parseShard(bad), /bad VAM_CI_SHARD/);
  assert.deepEqual(parseShard('2/4'), { index: 2, count: 4 });
});
test('ci shard: for n = 1..5 the shards cover every file and every whole part exactly once', async () => {
  const { shardParts } = await mod('test-integration.mjs');
  const list = [1, 2, 3, 4].map(j => ({ name: `run ${j}`, args: ['tests/run.cjs', `--shard=${j}/4`] })).concat({ name: 'node', args: ['--test', ...FILES] });
  for (let n = 1; n <= 5; n++) {
    const names = [], files = [];
    for (let i = 1; i <= n; i++) {
      for (const part of shardParts(list, { index: i, count: n }, { splitNodeTest: true, sizeOf })) {
        if (part.args[0] === '--test') files.push(...part.args.slice(1)); else names.push(part.name);
      }
    }
    assert.deepEqual(names.sort(), list.slice(0, 4).map(part => part.name).sort(), `n=${n} parts`);
    assert.deepEqual(files.sort(), FILES.slice().sort(), `n=${n} files`);
  }
});
test('ci shard: whole parts go round robin by position, also the single-file node --test part when not split', async () => {
  const { shardParts } = await mod('test-integration.mjs');
  const list = [1, 2, 3].map(j => ({ name: `run ${j}`, args: ['tests/run.cjs', `--shard=${j}/3`] })).concat({ name: 'vault', args: ['--test', 'tests/test-vault.mjs'] });
  const names = i => shardParts(list, { index: i, count: 4 }, { sizeOf }).map(part => part.name);
  assert.deepEqual([1, 2, 3, 4].map(names), [['run 1'], ['run 2'], ['run 3'], ['vault']]);
  const reversed = i => shardParts(list, { index: i, count: 4 }, { sizeOf, reverse: true }).map(part => part.name);
  assert.deepEqual([1, 2, 3, 4].map(reversed), [['vault'], ['run 3'], ['run 2'], ['run 1']]);
});
test('ci shard: file split is deterministic, balanced to within one file and orders ties by path', async () => {
  const { splitFiles } = await mod('test-integration.mjs');
  const a = splitFiles(FILES, 4, sizeOf), b = splitFiles(FILES.slice().reverse(), 4, sizeOf);
  assert.deepEqual(a, b);
  const bytes = a.map(group => group.reduce((sum, file) => sum + sizeOf(file), 0));
  assert.ok(Math.max(...bytes) - Math.min(...bytes) <= 110, `unbalanced: ${bytes}`);
});

const unitsFor = layerUnits => layerUnits.slice();
function greenReports(expected, shards) {
  const reports = [];
  for (const layer of ['unit', 'integration']) {
    expected[layer].forEach((unit, i) => reports.push({ layer, shard: `${(i % shards) + 1}/${shards}`, part: `p${i}`, units: [unit], tests: 5, pass: 5, fail: 0, code: 0 }));
  }
  return reports;
}
const EXPECTED = { unit: ['run.cjs --layer=unit --shard=1/2', 'run.cjs --layer=unit --shard=2/2', 'tests/a.cjs', 'tests/b.cjs'], integration: ['run.cjs --layer=integration --shard=1/2', 'tests/test-vault.mjs'] };

test('ci gate: a complete green run passes and counts tests per shard', async () => {
  const { checkReports } = await mod('ci-shard-gate.mjs');
  const result = checkReports(greenReports(EXPECTED, 2), 2, EXPECTED);
  assert.deepEqual(result.errors, []);
  assert.equal(result.total, 30);
  assert.equal(result.perShard[1].unit + result.perShard[1].integration + result.perShard[2].unit + result.perShard[2].integration, 30);
});
test('ci gate: a missing unit fails', async () => {
  const { checkReports } = await mod('ci-shard-gate.mjs');
  const reports = greenReports(EXPECTED, 2).filter(report => report.units[0] !== 'tests/b.cjs');
  assert.match(checkReports(reports, 2, EXPECTED).errors.join('\n'), /tests\/b\.cjs was not run/);
});
test('ci gate: a unit reported twice fails', async () => {
  const { checkReports } = await mod('ci-shard-gate.mjs');
  const reports = greenReports(EXPECTED, 2);
  reports.push({ ...reports[2], shard: '2/2' });
  assert.match(checkReports(reports, 2, EXPECTED).errors.join('\n'), /ran 2 times/);
});
test('ci gate: an unknown unit fails', async () => {
  const { checkReports } = await mod('ci-shard-gate.mjs');
  const reports = greenReports(EXPECTED, 2).concat({ layer: 'unit', shard: '1/2', part: 'x', units: ['tests/zzz.cjs'], tests: 1, pass: 1, fail: 0, code: 0 });
  assert.match(checkReports(reports, 2, EXPECTED).errors.join('\n'), /zzz\.cjs is not in the part list/);
});
test('ci gate: a part with fail, non-zero exit or a non-positive test count fails', async () => {
  const { checkReports } = await mod('ci-shard-gate.mjs');
  for (const [patch, pattern] of [[{ fail: 1 }, /fail is 1/], [{ code: 1 }, /exit code 1/], [{ tests: 0 }, /positive integer/], [{ tests: null }, /positive integer/], [{ tests: 1.5 }, /positive integer/]]) {
    const reports = greenReports(EXPECTED, 2);
    reports[0] = { ...reports[0], ...patch };
    assert.match(checkReports(reports, 2, EXPECTED).errors.join('\n'), pattern);
  }
});
test('ci gate: a shard without a report for either layer fails', async () => {
  const { checkReports } = await mod('ci-shard-gate.mjs');
  const missing = greenReports(EXPECTED, 2).map(report => (report.shard === '2/2' ? { ...report, shard: '1/2' } : report));
  assert.match(checkReports(missing, 2, EXPECTED).errors.join('\n'), /shard 2\/2: no unit report/);
  assert.match(checkReports(missing, 2, EXPECTED).errors.join('\n'), /shard 2\/2: no integration report/);
  assert.match(checkReports(greenReports(EXPECTED, 2), 3, EXPECTED).errors.join('\n'), /shard is not i\/3/);
});
test('ci gate: the real part lists give a non-empty expected set that the real shards cover once', async () => {
  const { expectedUnits } = await mod('ci-shard-gate.mjs');
  const { shardParts, unitsOf } = await mod('test-integration.mjs');
  const { parts: unitParts, runnable } = await mod('test-unit.mjs');
  const { parts: integrationParts } = await mod('test-integration.mjs');
  const expected = expectedUnits();
  assert.ok(expected.unit.length > 10 && expected.integration.length >= 2);
  assert.ok(expected.unit.some(unit => unit.startsWith('tests/steps-')));
  for (const n of [1, 2, 3, 4, 5]) {
    const unit = [], integration = [];
    for (let i = 1; i <= n; i++) {
      unit.push(...shardParts(runnable(unitParts), { index: i, count: n }, { splitNodeTest: true }).flatMap(unitsOf));
      integration.push(...shardParts(integrationParts, { index: i, count: n }, { reverse: true }).flatMap(unitsOf));
    }
    assert.deepEqual(unit.sort(), expected.unit.slice().sort(), `n=${n} unit`);
    assert.deepEqual(integration.sort(), expected.integration.slice().sort(), `n=${n} integration`);
  }
});

test('ci.yml: gate runs always, needs checks and test, and the matrix size matches --shards', () => {
  const workflow = YAML.parse(fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8'));
  const { gate, test: shardJob, checks } = workflow.jobs;
  assert.match(String(gate.if), /always\(\)/);
  for (const name of ['reuse', 'checks', 'test']) assert.ok(gate.needs.includes(name), `gate needs ${name}`);
  const shards = shardJob.strategy.matrix.shard;
  const gateText = JSON.stringify(gate.steps);
  assert.match(gateText, new RegExp(`--shards=${shards.length}\\b`));
  assert.equal(shardJob.env.VAM_CI_SHARD, '${{ matrix.shard }}/' + shards.length);
  assert.deepEqual(shards, Array.from({ length: shards.length }, (_, i) => i + 1));
  assert.equal(shardJob.strategy['fail-fast'], false);
  assert.equal(gate.env, undefined);
  assert.ok(checks && workflow.jobs.reuse);
});
// Runs the gate's "every job must succeed" step itself, so a skipped, cancelled or failed job is proven to fail the gate (a text match would pass with the check deleted).
test('ci.yml: the gate step fails unless checks and, in full mode, every test shard succeeded', () => {
  const { spawnSync } = require('node:child_process');
  const workflow = YAML.parse(fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8'));
  const step = workflow.jobs.gate.steps.find(item => item.name === 'Require checks and every test shard to succeed');
  assert.ok(step && step.run, 'gate has the require-success step');
  const cases = [
    ['full', 'success', 'success', 0],
    ['full', 'success', 'skipped', 1],
    ['full', 'success', 'cancelled', 1],
    ['full', 'success', 'failure', 1],
    ['full', 'skipped', 'success', 1],
    ['full', 'failure', 'success', 1],
    ['affected', 'success', 'skipped', 0],
    ['affected', 'skipped', 'skipped', 1],
  ];
  for (const [MODE, CHECKS_RESULT, TEST_RESULT, expected] of cases) {
    const result = spawnSync('bash', ['-e', '-c', step.run], { env: { PATH: process.env.PATH, MODE, CHECKS_RESULT, TEST_RESULT }, encoding: 'utf8' });
    assert.equal(result.status, expected, `MODE=${MODE} checks=${CHECKS_RESULT} test=${TEST_RESULT}: ${result.stdout}${result.stderr}`);
  }
});
