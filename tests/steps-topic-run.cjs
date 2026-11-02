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

// ---- chart queue ----
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function chartRuns({ chart, eligible = true, disposed = false } = {}) {
  const failed = []; const events = []; const applied = [];
  const gate = [];
  const runs = fresh({
    aiTasks: () => ({
      chartEligible: () => eligible,
      chartDetail: async request => { request.onExchange?.('x-' + request.detail); return chart ? chart(request, gate) : request.detail + '\n\nCHART'; },
      failExchange: (id, reason) => failed.push([id, reason])
    }),
    progress: () => ({ begin: (p, id) => events.push(['begin', p, id]), stage: (p, id, s) => events.push(['stage', p, id, s]), end: (p, id) => events.push(['end', p, id]) }),
    repository: () => ({ isDisposed: () => disposed })
  });
  return { runs, failed, events, applied, gate };
}
const job = (p, extra = {}) => ({ path: p, context: { title: p }, detail: 'body', model: 'claude:sonnet', apply: async () => true, ...extra });
const hold = (request, gate) => new Promise((resolve, reject) => {
  gate.push(() => resolve(request.detail + '\n\nCHART'));
  request.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
});

test('a written note is charted through the mutation queue and leaves chartJobs and progress when done', async () => {
  const { runs, events, failed } = chartRuns();
  const applied = [];
  runs.addChartsAfterWrite(job('A.md', { apply: async d => { applied.push(d); return true; } }));
  assert.equal(runs.chartJobs.size, 1);
  assert.deepEqual(events.map(e => e[0] + (e[3] ? ':' + e[3] : '')), ['begin', 'stage:charts']);
  await delay(10);
  assert.deepEqual(applied, ['body\n\nCHART']); assert.equal(runs.chartJobs.size, 0); assert.deepEqual(failed, []);
  assert.equal(events.at(-1)[0], 'end');
});

test('a different snapshot is not applied (apply false) and the exchange is marked stale', async () => {
  const { runs, failed } = chartRuns();
  runs.addChartsAfterWrite(job('A.md', { apply: async () => false }));
  await delay(10);
  assert.equal(failed.length, 1); assert.match(failed[0][1], /changed after it was written|筆記在寫入後已變更/);
});

test('a new chart job on the same topic aborts the old one', async () => {
  const { runs, failed } = chartRuns({ chart: hold });
  runs.addChartsAfterWrite(job('A.md'));
  const old = runs.chartJobs.get('A.md');
  runs.addChartsAfterWrite(job('A.md', { detail: 'second' }));
  assert.equal(old.signal.aborted, true); assert.notEqual(runs.chartJobs.get('A.md'), old);
  await delay(10);
  assert.ok(failed.some(f => /stopped|停止/.test(f[1])));
  runs.abortCharts();
});

test('at most 3 chart jobs run at once; the rest wait first in first out', async () => {
  const started = [];
  const { runs, gate } = chartRuns({ chart: (request, g) => { started.push(request.detail); return hold(request, g); } });
  for (const n of ['1', '2', '3', '4', '5']) runs.addChartsAfterWrite(job(n + '.md', { detail: n }));
  await delay(5);
  assert.deepEqual(started, ['1', '2', '3']); assert.equal(runs.chartJobs.size, 5);
  gate[0](); await delay(5);
  assert.deepEqual(started, ['1', '2', '3', '4']);
  gate[1](); await delay(5);
  assert.deepEqual(started, ['1', '2', '3', '4', '5']);
  runs.abortCharts();
});

test('a queued job that is aborted never starts and does not take a slot', async () => {
  const started = [];
  const { runs, gate } = chartRuns({ chart: (request, g) => { started.push(request.detail); return hold(request, g); } });
  for (const n of ['1', '2', '3', '4', '5']) runs.addChartsAfterWrite(job(n + '.md', { detail: n }));
  runs.abortCharts('4.md');
  gate[0](); await delay(5);
  assert.deepEqual(started, ['1', '2', '3', '5']);
  runs.abortCharts();
});

test('an aborted running job frees its slot only when it settles', async () => {
  const started = [];
  const { runs } = chartRuns({ chart: (request, g) => { started.push(request.detail); return hold(request, g); } });
  for (const n of ['1', '2', '3', '4']) runs.addChartsAfterWrite(job(n + '.md', { detail: n }));
  runs.abortCharts('1.md');
  await delay(5);
  assert.deepEqual(started, ['1', '2', '3', '4']);
  runs.abortCharts();
});

test('no chart job starts when the repository is disposed or the note has no charts to add', () => {
  const a = chartRuns({ disposed: true }); a.runs.addChartsAfterWrite(job('A.md')); assert.equal(a.runs.chartJobs.size, 0);
  const b = chartRuns({ eligible: false }); b.runs.addChartsAfterWrite(job('A.md')); assert.equal(b.runs.chartJobs.size, 0);
  const c = chartRuns(); c.runs.addChartsAfterWrite(job('A.md', { detail: '  ' })); assert.equal(c.runs.chartJobs.size, 0);
});

test('ports are read on every use, so a replaced aiTasks takes effect', async () => {
  let tasks = { chartEligible: () => false };
  const runs = fresh({ aiTasks: () => tasks });
  runs.addChartsAfterWrite(job('A.md')); assert.equal(runs.chartJobs.size, 0);
  const seen = [];
  tasks = { chartEligible: () => true, chartDetail: async r => { seen.push(r.detail); return r.detail; }, failExchange() {} };
  const events = [];
  const withProgress = fresh({ aiTasks: () => tasks, progress: () => ({ begin() {}, stage() {}, end: () => events.push('end') }) });
  withProgress.addChartsAfterWrite(job('A.md')); await delay(5);
  assert.deepEqual(seen, ['body']);
});
