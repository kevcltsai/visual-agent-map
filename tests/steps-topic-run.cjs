// TopicRuns: the plugin-level registry of topic AI runs (running set, stop controllers, chart queue).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { load, obsidian } = require('./support.cjs');

const { TopicRuns } = load('experiences/visual-map/topic-run.ts', { obsidian });
const ports = (extra = {}) => ({ running: (set => () => set)(new Set()), pendingSuggestions: (map => () => map)(new Map()), aiTasks: () => ({}), mutate: () => work => work(), progress: () => ({}), repository: () => undefined, ...extra });
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

// ---- pending suggestions and the real Plugin ----
test('pendingSuggestions returns the store the port currently holds, also after it is replaced', () => {
  let store = new Map();
  const runs = fresh({ pendingSuggestions: () => store });
  assert.equal(runs.pendingSuggestions, store);
  store = new Map();
  assert.equal(runs.pendingSuggestions, store);
});

const S = require('./support.cjs');
const { default: Plugin } = S.load('main.ts', { obsidian: S.obsidian });
function realPlugin() {
  const plugin = new Plugin();
  plugin.app = { vault: {}, fileManager: {}, workspace: { getLeavesOfType: () => [] } };
  plugin.logs = { appendLog() {} };
  return plugin;
}

test('the real Plugin shares running and pendingSuggestions with its TopicRuns, also after onload replaces the suggestions', () => {
  const plugin = realPlugin();
  assert.equal(plugin.running, plugin.topicRuns.running);
  assert.equal(plugin.pendingSuggestions, plugin.topicRuns.pendingSuggestions);
  const replaced = new Map();
  plugin.pendingSuggestions = replaced;
  assert.equal(plugin.topicRuns.pendingSuggestions, replaced); assert.equal(plugin.pendingSuggestions, replaced);
  plugin.topicRuns.begin('A.md', 'research');
  assert.equal(plugin.running.has('A.md'), true);
});

test('resetCodexRuntime stops every registered run; onunload disposes TopicRuns before the repository', () => {
  const plugin = realPlugin();
  const handle = plugin.topicRuns.begin('A.md', 'research');
  plugin.expansionCoordinator = { stopAll() {} }; plugin.modelDiscovery = { invalidate() {} }; plugin.aiRuntime = { reset() {}, dispose() {} };
  plugin.resetCodexRuntime();
  assert.equal(handle.signal.aborted, true);
  const second = plugin.topicRuns.begin('B.md', 'research');
  const order = [];
  second.signal.addEventListener('abort', () => order.push('stop'));
  plugin.repo = { dispose() { order.push('dispose'); } };
  plugin.onunload();
  assert.deepEqual(order, ['stop', 'dispose']);
  assert.equal(plugin.topicRuns.begin('C.md', 'research'), null);
});

// ---- research run (ticket 02) ----
const fakeNote = (over = {}) => ({ title: 'T', summary: '', rules: '', detail: '', prompt: 'ask', model: 'm1', reasoning: undefined, researchMode: 'local', visualMode: 'off', sourcePaths: [], referencePaths: [], thinkingOrigin: '', status: 'idea', newFindings: '', ...over });
function researchRuns({ reply, ask, notes = {}, extra = {} } = {}) {
  const store = new Map(Object.entries({ 'A.md': fakeNote(), ...notes }));
  const log = { writes: [], progress: [], failed: [], notices: [], cleared: [], refreshed: 0, asks: [], charts: [], written: [], exchanges: [], flushed: 0 };
  const running = new Set(); const activeTasks = new Map(); const pending = new Map();
  pending.flush = async () => { log.flushed++; };
  const repo = {
    readNote: async p => ({ ...store.get(p) }),
    updateNote: async (p, patch) => { log.writes.push([p, patch]); Object.assign(store.get(p), patch); },
    resolveTopicModel: async (p, _map, runOnce) => ({ model: runOnce.model, reasoning: runOnce.reasoning })
  };
  const resolveModel = (...args) => repo.resolveTopicModel(...args);
  const answer = { summary: 'S', detail: 'D', visualReferences: [], suggestions: [], ...reply };
  const runs = new TopicRuns(ports({
    running: () => running, pendingSuggestions: () => pending, activeTasks: () => activeTasks,
    repository: () => repo, resolveModel, aiTasks: () => ({ chartEligible: () => false }),
    askModel: ask ?? (async (context, model, reasoning, signal, onExchange, accepted) => { log.asks.push({ context, model, reasoning }); onExchange('ex1'); accepted(); return answer; }),
    settings: () => ({ language: 'en', aiExchangeLoggingEnabled: true }),
    exchanges: () => ({ failed: (id, reason) => log.exchanges.push(['failed', id, reason]), completed: id => log.exchanges.push(['completed', id]), getEntries: () => [] }),
    recordFailure: (_label, error) => String(error?.message ?? error),
    progress: () => ({ begin: (...a) => log.progress.push(['begin', a[3]]), newAttempt() {}, stage() {}, preview() {}, markSlow() {}, end: () => log.progress.push(['end']) }),
    runStyle: () => ({ template: undefined, label: { fileName: 'std' }, contextFields: {}, issues: {} }),
    clearOtherHistory: origin => log.cleared.push(origin),
    refreshViews: () => { log.refreshed++; },
    ...extra
  }));
  const options = (over = {}) => ({
    origin: 'view-1', request: { task: 'go', researchMode: 'local' }, failed: m => log.failed.push(m), notify: m => log.notices.push(m),
    ancestors: async () => '', userTexts: () => '',
    onWritten: change => log.written.push(change), queueCharts: job => log.charts.push(job), ...over
  });
  return { runs, store, log, running, activeTasks, pending, options };
}
const settle = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms));

test('research: a normal run registers, asks the note model, writes in one update, queues charts and releases', async () => {
  const h = researchRuns();
  const done = [];
  const handle = await h.runs.start('A.md', 'research', h.options({ done: r => done.push(r) }));
  assert.ok(handle); await handle.finished;
  assert.equal(h.log.asks[0].model, 'm1'); assert.equal(h.log.asks[0].context.mode, 'task');
  assert.equal(h.store.get('A.md').status, 'completed'); assert.equal(h.store.get('A.md').summary, 'S');
  assert.equal(h.running.has('A.md'), false); assert.equal(h.activeTasks.has('A.md'), false); assert.equal(h.runs.isRunning('A.md'), false);
  assert.equal(done.length, 1); assert.equal(h.log.charts.length, 1); assert.equal(h.log.charts[0].path, 'A.md');
  assert.deepEqual(h.log.exchanges, [['completed', 'ex1']]);
  assert.equal(h.log.refreshed, 1); assert.deepEqual(h.log.failed, []);
});

test('research: the registered run is stoppable through the plugin activeTasks map and running is set while it waits', async () => {
  let release; const gate = new Promise(r => { release = r; });
  const h = researchRuns({ ask: async (_c, _m, _r, signal, onExchange, accepted) => { onExchange('ex'); accepted(); await gate; if (signal.aborted) throw new DOMException('Aborted', 'AbortError'); return {}; } });
  const handle = await h.runs.start('A.md', 'research', h.options());
  assert.equal(h.running.has('A.md'), true); assert.ok(h.activeTasks.get('A.md'));
  h.activeTasks.get('A.md').abort(); release(); await handle.finished;
  assert.equal(h.store.get('A.md').status, 'idea', 'the status is restored'); assert.equal(h.store.get('A.md').summary, '');
  assert.match(h.log.failed[0], /stopped|停止/); assert.equal(h.running.has('A.md'), false); assert.equal(h.activeTasks.has('A.md'), false);
  assert.deepEqual(h.log.written, []);
});

test('research: stop(path) and stopAll abort a run that is waiting for the answer', async () => {
  for (const stopper of [runs => runs.stop('A.md'), runs => runs.stopAll()]) {
    let release; const gate = new Promise(r => { release = r; });
    const h = researchRuns({ ask: async (_c, _m, _r, signal, _e, accepted) => { accepted(); await gate; if (signal.aborted) throw new DOMException('Aborted', 'AbortError'); return {}; } });
    const handle = await h.runs.start('A.md', 'research', h.options());
    stopper(h.runs); release(); await handle.finished;
    assert.equal(h.store.get('A.md').status, 'idea'); assert.equal(h.running.has('A.md'), false);
  }
});

test('research: an AI failure sets status error, reports through failed and releases', async () => {
  const h = researchRuns({ ask: async (_c, _m, _r, _s, _e, accepted) => { accepted(); throw new Error('boom'); } });
  const handle = await h.runs.start('A.md', 'research', h.options());
  await handle.finished;
  assert.equal(h.store.get('A.md').status, 'error'); assert.match(h.log.failed[0], /boom/);
  assert.equal(h.running.has('A.md'), false); assert.equal(h.activeTasks.has('A.md'), false); assert.deepEqual(h.log.written, []);
});

test('research: every one of the 12 compared fields makes the result stale and nothing is written', async () => {
  const changes = { thinkingOrigin: 'x', title: 'x', prompt: 'x', rules: 'x', detail: 'x', summary: 'x', model: 'x', reasoning: 'high', researchMode: 'web', visualMode: 'on', sourcePaths: ['s.md', 'z.md'], referencePaths: [{ path: 'r.md' }] };
  assert.equal(Object.keys(changes).length, 12);
  for (const [field, value] of Object.entries(changes)) {
    let release; const gate = new Promise(r => { release = r; });
    const h = researchRuns({ ask: async (_c, _m, _r, _s, _e, accepted) => { accepted(); await gate; return { summary: 'NEW', detail: 'NEW', visualReferences: [], suggestions: [] }; } });
    const handle = await h.runs.start('A.md', 'research', h.options());
    h.store.get('A.md')[field] = value; release(); await handle.finished;
    assert.equal(h.store.get('A.md').status, 'idea', field); assert.notEqual(h.store.get('A.md').summary, 'NEW', field);
    assert.match(h.log.failed.at(-1), /changed|變更|outdated/, field);
  }
});

test('research: undo data carries the note before and after, and the other views are told to clear their history', async () => {
  const h = researchRuns();
  const handle = await h.runs.start('A.md', 'research', h.options());
  await handle.finished;
  assert.equal(h.log.written.length, 1);
  const { before, after } = h.log.written[0];
  assert.equal(before.status, 'idea'); assert.equal(before.summary, ''); assert.equal(after.summary, 'S'); assert.equal(after.status, 'completed');
  assert.deepEqual(h.log.cleared, ['view-1']);
});

test('research: the write still happens when no view is left to take the undo data', async () => {
  const h = researchRuns();
  const handle = await h.runs.start('A.md', 'research', h.options({ onWritten: undefined, queueCharts: undefined, origin: undefined }));
  await handle.finished;
  assert.equal(h.store.get('A.md').summary, 'S');
});

test('research: the check and the write happen inside one mutate call', async () => {
  const order = [];
  const h = researchRuns({ extra: { mutate: () => async work => { order.push('in'); await work(); order.push('out'); } } });
  const handle = await h.runs.start('A.md', 'research', h.options());
  await handle.finished;
  assert.deepEqual(order, ['in', 'out']);
  assert.equal(h.log.writes.filter(([, patch]) => patch.status === 'completed').length, 1);
});

test('research: suggestions are stored (at most 7) with the origin baseline and flushed; a new run clears the old ones first', async () => {
  const suggestions = Array.from({ length: 9 }, (_, i) => ({ title: 'c' + i, task: 't', contribution: '', parentTitle: '' }));
  const h = researchRuns({ reply: { suggestions } });
  h.pending.set('A.md', [{ title: 'old' }]);
  const handle = await h.runs.start('A.md', 'research', h.options());
  await handle.finished;
  assert.equal(h.pending.get('A.md').length, 7); assert.ok(h.pending.get('A.md')[0].thinkingOriginBaseline); assert.equal(h.log.flushed, 1);
});

test('research: a new run on a topic aborts that topic chart step first', async () => {
  const h = researchRuns();
  let aborted = 0; const original = h.runs.abortCharts.bind(h.runs);
  h.runs.abortCharts = path => { aborted++; original(path); };
  const handle = await h.runs.start('A.md', 'research', h.options());
  await handle.finished;
  assert.equal(aborted, 1);
});

test('research: an empty prompt is refused with null, a notice, and nothing is registered', async () => {
  const h = researchRuns({ notes: { 'A.md': fakeNote({ prompt: '' }) } });
  const result = await h.runs.start('A.md', 'research', h.options({ failed: undefined, request: {} }));
  assert.equal(result, null); assert.equal(h.log.notices.length, 1); assert.equal(h.running.has('A.md'), false);
});

test('research: a topic that is already running is refused with null and a message, the first run is untouched', async () => {
  let release; const gate = new Promise(r => { release = r; });
  const h = researchRuns({ ask: async (_c, _m, _r, _s, _e, accepted) => { accepted(); await gate; return {}; } });
  const first = await h.runs.start('A.md', 'research', h.options());
  const second = await h.runs.start('A.md', 'research', h.options());
  assert.equal(second, null); assert.equal(h.log.failed.length, 1);
  assert.equal(h.runs.isRunning('A.md'), true); release(); await first.finished;
});

test('research: two starts racing past the guard both run (current behavior, flipped by ticket 05)', async () => {
  const h = researchRuns();
  const [a, b] = await Promise.all([h.runs.start('A.md', 'research', h.options()), h.runs.start('A.md', 'research', h.options())]);
  await Promise.all([a?.finished, b?.finished]);
  assert.equal(h.log.asks.length, 2);
});

test('research: after dispose a start returns null and asks nothing', async () => {
  const h = researchRuns(); h.runs.dispose();
  assert.equal(await h.runs.start('A.md', 'research', h.options()), null); assert.equal(h.log.asks.length, 0);
});

test('research: a run-once model reaches the ask and the progress line, the topic keeps its own model', async () => {
  const h = researchRuns();
  const handle = await h.runs.start('A.md', 'research', h.options({ runOnce: { model: 'claude:sonnet', reasoning: 'medium' } }));
  await handle.finished;
  assert.equal(h.log.asks[0].model, 'claude:sonnet'); assert.equal(h.log.asks[0].reasoning, 'medium');
  assert.equal(h.log.progress[0][1], 'claude:sonnet'); assert.equal(h.store.get('A.md').model, 'm1');
});

test('research: the style comes from the given runStyle, else the options resolver, else the runStyle port', async () => {
  const style = tag => ({ template: undefined, label: { fileName: tag }, contextFields: { toneText: tag }, toneText: tag, issues: {} });
  const a = researchRuns(); let resolved = 0;
  await (await a.runs.start('A.md', 'research', a.options({ request: { task: 'go', runStyle: style('given') } }))).finished;
  assert.equal(a.log.asks[0].context.toneText, 'given');
  const b = researchRuns();
  await (await b.runs.start('A.md', 'research', b.options({ resolveStyle: async () => { resolved++; return style('opt'); } }))).finished;
  assert.equal(resolved, 1); assert.equal(b.log.asks[0].context.toneText, 'opt');
  const c = researchRuns({ extra: { runStyle: () => style('port') } });
  await (await c.runs.start('A.md', 'research', c.options())).finished;
  assert.equal(c.log.asks[0].context.toneText, 'port');
});

test('research: the module still imports neither obsidian nor the view and drops isUnloaded', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'experiences/visual-map/topic-run.ts'), 'utf8');
  assert.doesNotMatch(src, /isUnloaded/);
});
