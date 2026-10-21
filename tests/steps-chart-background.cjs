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

test('at most 3 jobs run at once, and a new job on the same path replaces the old one', async () => {
  const { plugin } = newPlugin({ chart: () => new Promise(() => {}) });
  for (const p of ['A.md', 'B.md', 'C.md', 'D.md']) plugin.addChartsAfterWrite(job(p));
  assert.deepEqual([...plugin.chartJobs.keys()], ['A.md', 'B.md', 'C.md'], 'the fourth waits for no one: it is skipped');
  const old = plugin.chartJobs.get('A.md');
  plugin.addChartsAfterWrite(job('A.md'));
  assert.equal(old.signal.aborted, true); assert.equal(plugin.chartJobs.size, 3); assert.notEqual(plugin.chartJobs.get('A.md'), old);
});

test('a request that is not chart-eligible starts nothing', () => {
  const { plugin } = newPlugin();
  plugin.aiTasks.chartEligible = () => false;
  plugin.addChartsAfterWrite(job('A.md'));
  assert.equal(plugin.chartJobs.size, 0);
});
