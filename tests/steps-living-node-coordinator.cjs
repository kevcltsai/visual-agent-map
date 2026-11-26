const { test } = require('node:test');
const assert = require('node:assert/strict');
const { LivingCoordinator } = require('./support.cjs').load('experiences/visual-map/living-node-coordinator.ts');

test('single flight: formal map and note paths are shared across views and maps', () => {
  const c = new LivingCoordinator();
  const a = c.acquire('m', 'v1', ['a.md', 'b.md'], true);
  assert.ok(a.current());
  assert.equal(c.acquire('m', 'v2', ['c.md'], true), undefined);
  assert.equal(c.acquire('other', 'v3', ['b.md'], true), undefined);
  assert.equal(c.acquire('m', 'v2', ['a.md'], false), undefined);
  const trial = c.acquire('m', 'v2', ['c.md'], false);
  assert.ok(trial.current());
  assert.ok(c.busy('a.md'));
  trial.release();
  a.release();
  assert.equal(c.busy('a.md'), false);
  assert.ok(c.acquire('m', 'v2', ['a.md'], true));
});

test('single flight: cancelled provider retains lease until it actually settles', () => {
  const c = new LivingCoordinator();
  const a = c.acquire('m', 'v1', ['a.md'], false);
  c.stopView('v1');
  assert.equal(a.signal.aborted, true);
  assert.equal(a.current(), false);
  assert.equal(c.acquire('m', 'v2', ['a.md'], true), undefined);
  a.release();
  const b = c.acquire('m', 'v2', ['a.md'], true);
  a.release();
  assert.ok(b.current());
  assert.ok(c.busy('a.md'));
  c.unload();
  assert.equal(b.current(), false);
  b.release();
  assert.equal(c.acquire('m', 'v3', ['a.md'], true), undefined);
});

test('single flight: view stop leaves unrelated work running', () => {
  const c = new LivingCoordinator();
  const a = c.acquire('m', 'v1', ['a.md'], false);
  const b = c.acquire('m', 'v2', ['b.md'], true);
  a.stop();
  assert.equal(a.current(), false);
  assert.ok(b.current());
  a.release();
  b.release();
});
