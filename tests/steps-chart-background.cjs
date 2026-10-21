// S2: the plugin owns the background chart jobs: cap of 3, one per path, aborted on Stop paths, unload and runtime reset.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('./support.cjs');

const { default: Plugin } = S.load('main.ts', { obsidian: S.obsidian });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function newPlugin({ chart } = {}) {
  const plugin = new Plugin();
  plugin.app = { vault: {}, fileManager: {}, workspace: { getLeavesOfType: () => [] } };
  plugin.logs = { appendLog() {} };
  plugin.mutate = async work => { await work(); };
  const failed = [];
  plugin.aiTasks = {
    chartEligible: () => true,
    chartDetail: async request => { request.onExchange?.('x-' + failed.length); return chart ? chart(request) : request.detail + '\n\nCHART'; },
    failExchange: (id, reason) => failed.push([id, reason])
  };
  return { plugin, failed };
}
const job = (path, extra = {}) => ({ path, context: { title: path }, detail: 'body', model: 'claude:sonnet', apply: async () => true, ...extra });

test('a chart job applies the charted detail through the mutation queue and leaves the map when done', async () => {
  const { plugin, failed } = newPlugin();
  const applied = [];
  plugin.addChartsAfterWrite(job('A.md', { apply: async detail => { applied.push(detail); return true; } }));
  assert.equal(plugin.chartJobs.size, 1);
  await delay(10);
  assert.deepEqual(applied, ['body\n\nCHART']); assert.equal(plugin.chartJobs.size, 0); assert.deepEqual(failed, []);
});

test('a stale result is not applied and the chart exchange is marked failed with the stale reason', async () => {
  const { plugin, failed } = newPlugin();
  plugin.addChartsAfterWrite(job('A.md', { apply: async () => false }));
  await delay(10);
  assert.equal(failed.length, 1); assert.match(failed[0][1], /changed after it was written|筆記在寫入後已變更/);
});

test('a chart step that adds nothing or fails leaves the note alone; a failure never throws', async () => {
  let applied = 0;
  const same = newPlugin({ chart: request => request.detail });
  same.plugin.addChartsAfterWrite(job('A.md', { apply: async () => { applied++; return true; } }));
  const broken = newPlugin({ chart: () => { throw new Error('runtime down'); } });
  const warn = console.warn; console.warn = () => {};
  try { broken.plugin.addChartsAfterWrite(job('B.md', { apply: async () => { applied++; return true; } })); await delay(10); } finally { console.warn = warn; }
  assert.equal(applied, 0); assert.equal(broken.failed.length, 1); assert.equal(broken.plugin.chartJobs.size, 0);
});

test('Stop on a path, a new run on it, unload and runtime reset abort the job and never apply it; the exchange is marked failed', async () => {
  for (const abort of [p => p.abortChartJobs('A.md'), p => p.abortChartJobs(), p => { p.repo = { dispose() {} }; p.onunload(); }, p => { p.expansionCoordinator = { stopAll() {} }; p.modelDiscovery = { invalidate() {} }; p.aiRuntime = { reset() {} }; p.resetCodexRuntime(); }]) {
    const { plugin, failed } = newPlugin({ chart: request => new Promise((_resolve, reject) => request.signal.addEventListener('abort', () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })))) });
    let applied = 0;
    plugin.addChartsAfterWrite(job('A.md', { apply: async () => { applied++; return true; } }));
    abort(plugin);
    await delay(10);
    assert.equal(applied, 0); assert.equal(plugin.chartJobs.size, 0); assert.equal(failed.length, 1);
  }
});

test('unload aborts chart jobs before the repository is disposed', () => {
  const { plugin } = newPlugin({ chart: () => new Promise(() => {}) });
  const order = [];
  plugin.addChartsAfterWrite(job('A.md'));
  const controller = plugin.chartJobs.get('A.md'); controller.signal.addEventListener('abort', () => order.push('abort'));
  plugin.repo = { dispose() { order.push('dispose'); } };
  plugin.onunload();
  assert.deepEqual(order, ['abort', 'dispose']);
});

test('at most 3 jobs run at once; later jobs queue first-in-first-out and start when a slot frees; a new job on the same path replaces the old one', async () => {
  const gates = new Map(), started = [], applied = [];
  const { plugin } = newPlugin({ chart: request => { started.push(request.input.title); return new Promise(resolve => gates.set(request.input.title, () => resolve(request.detail + '\n\nCHART'))); } });
  for (const p of ['A.md', 'B.md', 'C.md', 'D.md', 'E.md']) plugin.addChartsAfterWrite(job(p, { apply: async () => { applied.push(p); return true; } }));
  assert.deepEqual(started, ['A.md', 'B.md', 'C.md'], 'only three run');
  assert.deepEqual([...plugin.chartJobs.keys()], ['A.md', 'B.md', 'C.md', 'D.md', 'E.md'], 'the queued ones are tracked too');
  gates.get('B.md')();
  await delay(10);
  assert.deepEqual(started, ['A.md', 'B.md', 'C.md', 'D.md'], 'the 4th starts when a slot frees, before the 5th');
  assert.deepEqual(applied, ['B.md']);
  gates.get('A.md')(); gates.get('C.md')(); gates.get('D.md')(); await delay(10); gates.get('E.md')(); await delay(10);
  assert.deepEqual(applied.slice().sort(), ['A.md', 'B.md', 'C.md', 'D.md', 'E.md']); assert.equal(plugin.chartJobs.size, 0);
  // Same path: the old job (running or queued) is aborted by the new one.
  const { plugin: other } = newPlugin({ chart: () => new Promise(() => {}) });
  for (const p of ['A.md', 'B.md', 'C.md', 'D.md']) other.addChartsAfterWrite(job(p));
  const queued = other.chartJobs.get('D.md'); other.addChartsAfterWrite(job('D.md'));
  assert.equal(queued.signal.aborted, true); assert.equal(other.chartJobs.size, 4);
  const running = other.chartJobs.get('A.md'); other.addChartsAfterWrite(job('A.md'));
  assert.equal(running.signal.aborted, true);
});

test('queued jobs are aborted by Stop on their path, unload and reset, and never start', async () => {
  for (const abort of [p => p.abortChartJobs('D.md'), p => { p.repo = { dispose() {} }; p.onunload(); }, p => { p.expansionCoordinator = { stopAll() {} }; p.modelDiscovery = { invalidate() {} }; p.aiRuntime = { reset() {} }; p.resetCodexRuntime(); }]) {
    const started = [];
    const { plugin } = newPlugin({ chart: request => { started.push(request.input.title); return new Promise((_resolve, reject) => request.signal.addEventListener('abort', () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })))); } });
    let applied = 0;
    for (const p of ['A.md', 'B.md', 'C.md', 'D.md']) plugin.addChartsAfterWrite(job(p, { apply: async () => { applied++; return true; } }));
    const queued = plugin.chartJobs.get('D.md');
    abort(plugin);
    await delay(10);
    assert.equal(queued.signal.aborted, true); assert.ok(!started.includes('D.md'), 'the queued job never started'); assert.equal(applied, 0);
    assert.equal(plugin.chartJobs.has('D.md'), false);
  }
});

test('a request that is not chart-eligible starts nothing', () => {
  const { plugin } = newPlugin();
  plugin.aiTasks.chartEligible = () => false;
  plugin.addChartsAfterWrite(job('A.md'));
  assert.equal(plugin.chartJobs.size, 0);
});
