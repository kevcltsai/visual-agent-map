// The absolute-millisecond scanner (scripts/check-test-timing.mjs): what it reports and what it leaves alone.
// Sample lines are built from their comparison alone so that the scanner does not report this file.
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test, root } = require('../support.cjs');
const scanner = () => import(pathToFileURL(path.join(root, 'scripts', 'check-test-timing.mjs')).href);
const call = body => 'assert.ok(' + body + ');';

test('timing scanner: reports an assert that compares a timing value with a number or an all-caps constant', async () => {
  const { isAbsoluteTimingLine } = await scanner();
  for (const body of [
    'ms < 50', 'ms < 100, `${name}`', 'elapsed <= 200', 'durationMs < 5', 'ms < LIMIT_MS', 'r.ms < 50', 't.elapsedMs < 200', '50 > ms', 'LIMIT_MS >= ms',
    'startMS < 10', 'wait_ms < 10', 'timers[0].ms <= 200', 'totalDuration < 1_000', 'ms < 0.5',
    'Date.now() - started < 200', 'performance.now() - t0 <= 50', 'Number(process.hrtime.bigint() - start) / 1e6 < 100', 'LIMIT_MS > Date.now() - started', '200 > Date.now() - started', 'end - Date.now() < 5'
  ]) assert.equal(isAbsoluteTimingLine(call(body)), true, body);
  const timer = 'assert.equal' + '(timers[0].ms <= 200, true);';
  assert.equal(isAbsoluteTimingLine(timer), true);
});
test('timing scanner: leaves other comparisons alone, including names that merely contain ms', async () => {
  const { isAbsoluteTimingLine } = await scanner();
  for (const body of ['count < 5', 'numItems < 10', 'terms < 5', 'msgCount <= 3', 'items.length >= 2', 'ratio <= STREAM_RATIO_LIMIT', 'ms <= other', 'items.map(i => i.ms)', 'a => b', 'a - b < 5', 'Date.now() - started', 'Date.now() > started', 'Date.now() - started < elapsedLimit', 'items.length - 1 < 5']) {
    assert.equal(isAbsoluteTimingLine(call(body)), false, body);
  }
  assert.equal(isAbsoluteTimingLine('const ms = 5 < 6;'), false, 'not inside an assert');
});
test('timing scanner: only the fake-timer delay line in expansion-and-synthesis is allowed, by file and exact text', async () => {
  const { findAbsoluteTiming } = await scanner();
  const fake = '  assert.equal' + '(timers[0].ms <= 200, true);';
  const file = 'tests/suites/expansion-and-synthesis.cjs';
  assert.deepEqual(findAbsoluteTiming(fake, file), []);
  assert.equal(findAbsoluteTiming(fake, 'tests/suites/other.cjs').length, 1);
  const slow = call('ms < 50');
  assert.equal(findAbsoluteTiming('  ' + slow, file).length, 1);
  assert.deepEqual(findAbsoluteTiming('x\n' + slow + '\n', 'a.cjs'), [{ line: 2, text: slow }]);
});

// The per-test timeout (tests/support.cjs): a test that never settles must fail its run, not hang it.
test('test timeout: a registered test that never settles makes its run fail instead of hanging', () => {
  const { spawnSync } = require('node:child_process');
  const script = "const { test } = require('./tests/support.cjs'); test('never settles', () => new Promise(() => {}));";
  const result = spawnSync(process.execPath, ['-e', script], { cwd: root, env: { ...process.env, VAM_TEST_TIMEOUT_MS: '200' }, encoding: 'utf8', timeout: 50000 });
  assert.equal(result.signal, null, 'the child must end by itself, not be killed after hanging');
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /timed out after 200ms/);
});
