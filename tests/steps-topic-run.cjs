// TopicRuns: the plugin-level registry of topic AI runs (running set, stop controllers, chart queue).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { load } = require('./support.cjs');

const { TopicRuns } = load('experiences/visual-map/topic-run.ts', {});
const ports = (extra = {}) => ({ aiTasks: () => ({}), mutate: () => work => work(), progress: () => ({}), repository: () => undefined, isUnloaded: () => false, ...extra });
const fresh = extra => new TopicRuns(ports(extra));

test('begin registers a run: isRunning, a live signal and the running set', () => {
  const runs = fresh();
  const h = runs.begin('A.md', 'research');
  assert.ok(h); assert.equal(h.path, 'A.md'); assert.equal(h.kind, 'research'); assert.equal(h.signal.aborted, false);
  assert.equal(runs.isRunning('A.md'), true); assert.ok(runs.running.has('A.md'));
  assert.equal(runs.isRunning('B.md'), false);
});

test('registering the same topic twice is refused with null and the first run is untouched', () => {
  const runs = fresh();
  const first = runs.begin('A.md', 'research');
  assert.equal(runs.begin('A.md', 'proposeChildren'), null);
  assert.equal(first.signal.aborted, false); assert.equal(runs.isRunning('A.md'), true);
});

test('release frees the topic so a new run can begin; a stale release does not free the newer run', () => {
  const runs = fresh();
  const h = runs.begin('A.md', 'research');
  h.release(); assert.equal(runs.isRunning('A.md'), false); assert.equal(runs.running.has('A.md'), false);
  const next = runs.begin('A.md', 'research'); assert.ok(next);
  h.release(); assert.equal(runs.isRunning('A.md'), true);
});

test('stop aborts one run and leaves the others; the topic stays registered until release', () => {
  const runs = fresh();
  const a = runs.begin('A.md', 'research'); const b = runs.begin('B.md', 'research');
  runs.stop('A.md');
  assert.equal(a.signal.aborted, true); assert.equal(b.signal.aborted, false);
  runs.stop('missing.md');
});

test('stopAll aborts every run', () => {
  const runs = fresh();
  const a = runs.begin('A.md', 'research'); const b = runs.begin('B.md', 'integrateChildren');
  runs.stopAll();
  assert.equal(a.signal.aborted, true); assert.equal(b.signal.aborted, true);
});

test('dispose stops everything and later begin returns null', () => {
  const runs = fresh();
  const a = runs.begin('A.md', 'research');
  runs.dispose();
  assert.equal(a.signal.aborted, true); assert.equal(runs.begin('B.md', 'research'), null);
});

test('the module imports neither obsidian nor the view', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'experiences/visual-map/topic-run.ts'), 'utf8');
  assert.doesNotMatch(src, /from\s+["']obsidian["']/); assert.doesNotMatch(src, /from\s+["'][^"']*view["']/);
});
