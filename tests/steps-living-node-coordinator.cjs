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

test('run registry: one run per map; a late subscriber replays progress; any view cancels; the last to leave cancels', () => {
  const c = new LivingCoordinator();
  const run = c.beginRun('Map.md');
  assert.equal(c.beginRun('Map.md'), undefined);
  assert.equal(c.runOf('Map.md'), run);
  const a = [], b = [];
  const leaveA = run.subscribe(e => a.push(e.kind));
  run.emit({ kind: 'start', total: 2 });
  run.emit({ kind: 'running', id: 'x' });
  const leaveB = run.subscribe(e => b.push(e.kind));
  assert.deepEqual(b, ['start', 'running']);
  leaveA();
  assert.equal(run.signal.aborted, false, 'leaving only unsubscribes while another view follows');
  leaveB();
  assert.equal(run.signal.aborted, true, 'the last view leaving cancels');
  run.emit({ kind: 'done' });
  assert.equal(c.runOf('Map.md'), undefined);
  assert.ok(c.beginRun('Map.md'));
});

test('run registry: cancel by one subscriber is seen by all; a finished run is not cancelled by leaving; unload cancels', () => {
  const c = new LivingCoordinator();
  const run = c.beginRun('M');
  const leave = run.subscribe(() => {});
  run.subscribe(() => {});
  run.cancel();
  assert.equal(run.signal.aborted, true);
  const done = c.beginRun('N');
  const leaveDone = done.subscribe(() => {});
  done.emit({ kind: 'done' });
  leaveDone();
  assert.equal(done.signal.aborted, false);
  leave();
  const live = c.beginRun('O');
  c.unload();
  assert.equal(live.signal.aborted, true);
  assert.equal(c.beginRun('P'), undefined);
});

test('trial lease is distinguishable from a formal lease', () => {
  const c = new LivingCoordinator();
  const trial = c.acquire('m', 'v', ['a.md'], false);
  const formal = c.acquire('m', 'v', ['b.md'], true);
  assert.equal(c.trialBusy('a.md'), true);
  assert.equal(c.formalBusy('a.md'), false);
  assert.equal(c.trialBusy('b.md'), false);
  assert.equal(c.formalBusy('b.md'), true);
  trial.release(); formal.release();
  assert.equal(c.trialBusy('a.md'), false);
});
