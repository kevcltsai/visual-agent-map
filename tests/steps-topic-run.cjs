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

test('research: two starts racing before the note is read run once; the second is refused with the running message (05)', async () => {
  const h = researchRuns();
  const [a, b] = await Promise.all([h.runs.start('A.md', 'research', h.options()), h.runs.start('A.md', 'research', h.options())]);
  await Promise.all([a?.finished, b?.finished]);
  assert.equal(h.log.asks.length, 1); assert.ok(a); assert.equal(b, null); assert.equal(h.log.failed.length, 1);
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

// ---- the view hands its research entry to the module (02b) ----
const viewSource = fs.readFileSync(path.join(__dirname, '..', 'experiences/visual-map/view.ts'), 'utf8');
const methodText = name => { const start = viewSource.indexOf(`  private ${name}(`); return viewSource.slice(start, viewSource.indexOf('\n  }\n', start)); };

test('the view research entry holds no registration, progress, model or write code of its own', () => {
  const body = methodText('runAgent');
  assert.ok(body.length > 100);
  assert.doesNotMatch(body, /\.running\b|activeTasks|askModel|updateNote|researchProgress|pendingSuggestions/);
  assert.match(body, /topicRuns\.start\(node\.path, "research"/);
});

function viewOverDouble(start) {
  const { VisualAgentMapView } = S.load('main.ts', { obsidian: { ...S.obsidian, Notice: class {} } });
  const plugin = { settings: { ...S.DEFAULT_SETTINGS, language: 'en' }, running: new Set(), activeTasks: new Map(), topicRuns: { start }, views: () => [] };
  const view = new VisualAgentMapView({ app: {} }, plugin);
  Object.assign(view, { map: { id: 'm', nodes: [], viewport: {} }, contentEl: { querySelector: () => null }, render() {}, hydrate: async () => {} });
  return { view, plugin };
}

test('view.runAgent passes the topic, the request, the run-once model and the callbacks to the module and registers nothing itself', async () => {
  const seen = [];
  const { view, plugin } = viewOverDouble(async (p, kind, options) => { seen.push([p, kind, options]); return { finished: Promise.resolve() }; });
  const done = () => {}; const failed = () => {}; const accepted = () => {}; const runOnce = { model: 'claude:sonnet' };
  const handle = await view.runAgent({ id: 'n1', path: 'A.md' }, done, failed, { task: 'go' }, accepted, runOnce);
  assert.ok(handle); assert.equal(seen.length, 1);
  const [p, kind, options] = seen[0];
  assert.equal(p, 'A.md'); assert.equal(kind, 'research'); assert.equal(options.origin, view);
  assert.deepEqual(options.request, { task: 'go' }); assert.equal(options.runOnce, runOnce);
  assert.equal(options.done, done); assert.equal(options.failed, failed); assert.equal(options.accepted, accepted);
  assert.equal(plugin.running.size, 0); assert.equal(plugin.activeTasks.size, 0);
});

test('the undo data the module reports becomes one undo step of the starting view', async () => {
  let captured;
  const { view } = viewOverDouble(async (_p, _kind, options) => { captured = options; return null; });
  await view.runAgent({ id: 'n1', path: 'A.md' });
  const before = { summary: 'old', detail: 'old', visualReferences: '', newFindings: '', status: 'idea' }; const after = { ...before, summary: 'new', status: 'completed' };
  assert.equal(view.history.canUndo, false);
  captured.onWritten({ before, after });
  assert.equal(view.history.canUndo, true);
});

test('a plugin that has no TopicRuns fails the view research entry loudly instead of running unregistered', async () => {
  const { VisualAgentMapView } = S.load('main.ts', { obsidian: { ...S.obsidian, Notice: class {} } });
  const view = new VisualAgentMapView({ app: {} }, { settings: { ...S.DEFAULT_SETTINGS }, topicRuns: undefined });
  await assert.rejects(async () => view.runAgent({ id: 'n1', path: 'A.md' }), /reading 'start'/);
});

test('the plugin clears the undo history of every other view and redraws all views through the view methods', () => {
  const plugin = realPlugin();
  const calls = [];
  const other = { clearUndoHistory: () => calls.push('clear-other'), reloadAfterAiRun: () => calls.push('reload-other') };
  const origin = { clearUndoHistory: () => calls.push('clear-origin'), reloadAfterAiRun: () => calls.push('reload-origin') };
  plugin.views = () => [origin, other];
  plugin.topicRuns.ports.clearOtherHistory(origin); plugin.topicRuns.ports.refreshViews();
  assert.deepEqual(calls, ['clear-other', 'reload-origin', 'reload-other']);
});

test('research: a double click is registered before the note is read, so only the first click runs and frees the topic (05)', async () => {
  const gates = [];
  const h = researchRuns({ ask: async (_c, _m, _r, _signal, onExchange, accepted) => { onExchange('ex'); accepted(); await new Promise(r => gates.push(r)); return { summary: 'S', detail: 'D', visualReferences: [], suggestions: [] }; } });
  const opts = () => h.options({ runOnce: { model: 'm1' } });
  const p1 = h.runs.start('A.md', 'research', opts()); const p2 = h.runs.start('A.md', 'research', opts());
  assert.equal(h.runs.isRunning('A.md'), true, 'registered before the first await');
  const [first, second] = await Promise.all([p1, p2]);
  assert.ok(first); assert.equal(second, null); assert.equal(gates.length, 1);
  assert.equal(h.running.has('A.md'), true); assert.ok(h.activeTasks.get('A.md'), 'the one run keeps its stop controller');
  gates[0](); await first.finished; await settle();
  assert.equal(h.runs.isRunning('A.md'), false); assert.equal(h.running.has('A.md'), false); assert.equal(h.activeTasks.has('A.md'), false);
});

// ---- child-topic proposal run (ticket 03) ----
const sugg = (title, over = {}) => ({ title, task: '', contribution: '', ...over });
function proposalRuns({ reply, ask, notes, extra } = {}) {
  const h = researchRuns({ notes, extra: { askModel: ask ?? (async (context, model, _r, _s, _e, accepted) => { h.log.asks.push({ context, model }); accepted(); return { summary: '', detail: '', visualReferences: [], suggestions: [sugg('X'), sugg('Y')], ...reply }; }), ...extra } });
  h.events = []; h.offered = []; h.flushOrder = [];
  h.pending.flush = async () => { h.log.flushed++; h.events.push(['flush', h.pending.has('A.md')]); };
  h.opts = (over = {}) => ({
    buildContext: async (note, language) => ({ title: note.title, mode: 'decompose', outputLanguage: language }),
    onStarted: () => h.events.push(['started', h.running.has('A.md'), h.activeTasks.has('A.md')]),
    onReleased: () => h.events.push(['released', h.running.has('A.md'), h.activeTasks.has('A.md')]),
    offer: items => { h.events.push(['offer', h.running.has('A.md')]); h.offered.push(items); },
    failed: (m, retryable) => h.log.failed.push([m, retryable]), ...over
  });
  return h;
}

test('proposal: a normal run stores pending suggestions with the origin baseline, offers them, then frees the topic', async () => {
  const h = proposalRuns({ notes: { 'A.md': fakeNote({ thinkingOrigin: 'o1' }) } });
  await h.runs.start('A.md', 'proposeChildren', h.opts());
  assert.equal(h.log.asks[0].context.mode, 'decompose'); assert.equal(h.log.asks[0].model, 'm1');
  const stored = h.pending.get('A.md'); assert.equal(stored.length, 2); assert.ok(stored.every(item => item.thinkingOriginBaseline !== undefined));
  assert.deepEqual(h.offered, [stored]); assert.deepEqual(h.log.failed, []);
  assert.equal(h.running.has('A.md'), false); assert.equal(h.activeTasks.has('A.md'), false); assert.equal(h.runs.isRunning('A.md'), false);
});

test('proposal: running clears after the offer and before the entry settles (307bcd7 order: register, ask, store, offer, release)', async () => {
  const h = proposalRuns();
  await h.runs.start('A.md', 'proposeChildren', h.opts());
  assert.deepEqual(h.events, [['started', true, true], ['flush', true], ['offer', true], ['released', false, false]]);
});

test('proposal: running is set while the model works and a second click is refused with the running message', async () => {
  let release; const gate = new Promise(r => { release = r; });
  const h = proposalRuns({ ask: async (_c, _m, _r, _s, _e, accepted) => { accepted(); await gate; return { suggestions: [sugg('X')] }; } });
  const first = h.runs.start('A.md', 'proposeChildren', h.opts());
  await settle(); assert.equal(h.running.has('A.md'), true);
  await h.runs.start('A.md', 'proposeChildren', h.opts());
  assert.equal(h.log.failed.length, 1); assert.deepEqual(h.offered, []);
  assert.equal(h.running.has('A.md'), true, 'the refused click does not free the first run');
  release(); await first; assert.equal(h.running.has('A.md'), false); assert.equal(h.offered.length, 1);
});

test('proposal: Stop (activeTasks controller, stop(), the dialog signal) discards the answer, stays silent and frees the topic', async () => {
  const stoppers = [(h) => h.activeTasks.get('A.md').abort(), (h) => h.runs.stop('A.md')];
  for (const stopper of stoppers) {
    let release; const gate = new Promise(r => { release = r; });
    const h = proposalRuns({ ask: async (_c, _m, _r, _s, _e, accepted) => { accepted(); await gate; return { suggestions: [sugg('X')] }; } });
    const dialog = new AbortController(); let accepted = 0;
    const run = h.runs.start('A.md', 'proposeChildren', h.opts({ signal: dialog.signal, accepted: () => { accepted++; } }));
    await settle(); stopper(h, dialog); release(); await run;
    assert.deepEqual(h.log.failed, []); assert.deepEqual(h.offered, []); assert.equal(h.pending.has('A.md'), false);
    assert.equal(h.running.has('A.md'), false); assert.equal(h.activeTasks.has('A.md'), false); assert.equal(accepted, 1);
  }
});

test('proposal: the dialog signal stops the run only until the AI accepted it (as in 307bcd7)', async () => {
  for (const [acceptFirst, stopped] of [[false, true], [true, false]]) {
    let release; const gate = new Promise(r => { release = r; });
    const h = proposalRuns({ ask: async (_c, _m, _r, signal, _e, accepted) => { if (acceptFirst) accepted(); await gate; if (signal.aborted) throw new DOMException('Aborted', 'AbortError'); return { suggestions: [sugg('X')] }; } });
    const dialog = new AbortController();
    const run = h.runs.start('A.md', 'proposeChildren', h.opts({ signal: dialog.signal }));
    await settle(); dialog.abort(); release(); await run;
    assert.equal(h.offered.length, stopped ? 0 : 1); assert.deepEqual(h.log.failed, []); assert.equal(h.running.has('A.md'), false);
  }
});

test('proposal: a dialog signal aborted before the start never asks the model and is not accepted', async () => {
  const h = proposalRuns(); const dialog = new AbortController(); dialog.abort(); let accepted = 0;
  await h.runs.start('A.md', 'proposeChildren', h.opts({ signal: dialog.signal, accepted: () => { accepted++; } }));
  assert.equal(h.log.asks.length, 0); assert.equal(accepted, 0); assert.deepEqual(h.log.failed, []); assert.equal(h.running.has('A.md'), false);
});

test('proposal: a changed thinking origin discards the answer with the outdated message; other fields do not count', async () => {
  for (const [change, stale] of [[{ thinkingOrigin: 'changed' }, true], [{ title: 'changed', detail: 'changed' }, false]]) {
    let release; const gate = new Promise(r => { release = r; });
    const h = proposalRuns({ ask: async (_c, _m, _r, _s, _e, accepted) => { accepted(); await gate; return { suggestions: [sugg('X')] }; } });
    const run = h.runs.start('A.md', 'proposeChildren', h.opts());
    await settle(); Object.assign(h.store.get('A.md'), change); release(); await run;
    assert.equal(h.log.failed.length, stale ? 1 : 0); assert.equal(h.offered.length, stale ? 0 : 1); assert.equal(h.pending.has('A.md'), !stale);
    assert.equal(h.running.has('A.md'), false);
  }
});

test('proposal: an answer with no first-level suggestion is reported (its detail first) and nothing is stored', async () => {
  const h = proposalRuns({ reply: { detail: 'not worth splitting', suggestions: [sugg('Z', { parentTitle: 'X' })] } });
  await h.runs.start('A.md', 'proposeChildren', h.opts());
  assert.deepEqual(h.log.failed, [['not worth splitting', undefined]]); assert.equal(h.pending.has('A.md'), false); assert.deepEqual(h.offered, []);
  assert.equal(h.running.has('A.md'), false);
});

test('proposal: at most 7 first-level suggestions are kept', async () => {
  const h = proposalRuns({ reply: { suggestions: Array.from({ length: 10 }, (_, i) => sugg(`T${i}`)) } });
  await h.runs.start('A.md', 'proposeChildren', h.opts());
  assert.equal(h.pending.get('A.md').length, 7);
});

test('proposal: an AI failure is reported as retryable, a partial batch as not retryable, a stopped batch stays silent', async () => {
  for (const [kind, expectFailed, retryable] of [[undefined, true, true], ['partial', true, false], ['stopped', false]]) {
    const h = proposalRuns({ ask: async () => { throw new Error('boom'); } });
    await h.runs.start('A.md', 'proposeChildren', h.opts({ classifyError: () => kind }));
    assert.equal(h.log.failed.length, expectFailed ? 1 : 0);
    if (expectFailed) { assert.match(h.log.failed[0][0], /boom/); assert.equal(h.log.failed[0][1], retryable); }
    assert.equal(h.running.has('A.md'), false);
  }
});

test('proposal: a failing store (flush) reports once and frees the topic; with no failed callback notify gets the message', async () => {
  const h = proposalRuns(); const notices = [];
  h.pending.flush = async () => { throw new Error('disk'); };
  await h.runs.start('A.md', 'proposeChildren', h.opts({ failed: undefined, notify: m => notices.push(m) }));
  assert.equal(notices.length, 1); assert.match(notices[0], /disk/); assert.equal(h.running.has('A.md'), false);
});

test('proposal: a run once model is resolved through the repository; a started research of the same topic blocks the proposal', async () => {
  const h = proposalRuns();
  await h.runs.start('A.md', 'proposeChildren', h.opts({ runOnce: { model: 'run-once', reasoning: 'high' } }));
  assert.equal(h.log.asks[0].model, 'run-once');
  h.running.add('A.md');
  await h.runs.start('A.md', 'proposeChildren', h.opts());
  assert.equal(h.log.asks.length, 1); assert.equal(h.log.failed.length, 1);
});

test('the view proposal entry no longer touches the running set; it goes through the run module', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'experiences/visual-map/view.ts'), 'utf8');
  const body = src.slice(src.indexOf('private async proposeChildren('), src.indexOf('private async assertSuggestionOrigin'));
  assert.doesNotMatch(body, /running\.(add|delete)/); assert.match(body, /topicRuns\.start\(parent\.path, "proposeChildren"/);
});

// ---- integration runs (ticket 04a): integrateDirection and integrateChildren ----
const directionRuns = ({ reply, ask, notes } = {}) => {
  const h = researchRuns({ notes, extra: { askModel: ask ?? (async (context, model, _r, signal, _e, accepted, _w, observer) => { h.log.asks.push({ context, model, signal, observer }); accepted(); return { summary: '', detail: '', visualReferences: [], suggestions: [sugg('A1'), sugg('A2'), sugg('A3')], ...reply }; }) } });
  h.found = []; h.fails = []; h.events = [];
  h.opts = (over = {}) => ({
    map: () => undefined, buildContext: async note => ({ title: note.title, mode: 'synthesize' }),
    onStarted: () => h.events.push(['started', h.running.has('A.md')]), accepted: () => h.events.push(['accepted']),
    found: items => h.found.push(items), failed: m => h.fails.push(m), onSettled: async () => h.events.push(['settled', h.running.has('A.md')]), ...over
  });
  return h;
};

test('integrateDirection: a normal run registers, asks, offers at most 2 directions and frees the topic before it settles', async () => {
  const h = directionRuns();
  await h.runs.start('A.md', 'integrateDirection', h.opts());
  assert.equal(h.log.asks[0].context.mode, 'synthesize'); assert.equal(h.log.asks[0].model, 'm1');
  assert.equal(h.found.length, 1); assert.equal(h.found[0].length, 2); assert.deepEqual(h.fails, []);
  assert.deepEqual(h.events, [['started', true], ['accepted'], ['accepted'], ['settled', false]], 'accepted twice, as in 307bcd7 (inside the ask, then after the answer)');
  assert.deepEqual(h.log.progress.map(entry => entry[0]), ['begin', 'end', 'end']);
  assert.equal(h.runs.isRunning('A.md'), false); assert.equal(h.activeTasks.has('A.md'), false, 'no activeTasks entry (the registry controller stops this run)');
});

test('integrateDirection: a second click while running is refused; precheck and an empty context report their message and free the topic', async () => {
  let release; const gate = new Promise(r => { release = r; });
  const h = directionRuns({ ask: async (_c, _m, _r, _s, _e, accepted) => { accepted(); await gate; return { suggestions: [sugg('X')] }; } });
  const first = h.runs.start('A.md', 'integrateDirection', h.opts());
  await settle(); assert.equal(h.running.has('A.md'), true);
  await h.runs.start('A.md', 'integrateDirection', h.opts());
  assert.equal(h.fails.length, 1); assert.equal(h.running.has('A.md'), true);
  release(); await first; assert.equal(h.running.has('A.md'), false); assert.equal(h.found.length, 1);
  const blocked = directionRuns();
  await blocked.runs.start('A.md', 'integrateDirection', blocked.opts({ precheck: () => 'no sources' }));
  assert.deepEqual(blocked.fails, ['no sources']); assert.equal(blocked.log.asks.length, 0); assert.equal(blocked.running.has('A.md'), false);
  const empty = directionRuns();
  await empty.runs.start('A.md', 'integrateDirection', empty.opts({ buildContext: async () => 'empty sources' }));
  assert.deepEqual(empty.fails, ['empty sources']); assert.equal(empty.log.asks.length, 0); assert.equal(empty.running.has('A.md'), false);
});

test('integrateDirection: Stop (the dialog signal or stop()) reports the stopped message, offers nothing and frees the topic', async () => {
  let release; const gate = new Promise(r => { release = r; });
  const h = directionRuns({ ask: async (_c, _m, _r, _s, _e, accepted) => { accepted(); await gate; return { suggestions: [sugg('X')] }; } });
  const dialog = new AbortController();
  const run = h.runs.start('A.md', 'integrateDirection', h.opts({ signal: dialog.signal }));
  await settle(); h.runs.stop('A.md'); dialog.abort(); release(); await run;
  assert.equal(h.fails.length, 1); assert.deepEqual(h.found, []); assert.equal(h.running.has('A.md'), false);
});

test('integrateDirection: no suggestion and an AI failure are reported; a double click runs once (05)', async () => {
  const none = directionRuns({ reply: { suggestions: [] } });
  await none.runs.start('A.md', 'integrateDirection', none.opts());
  assert.equal(none.fails.length, 1); assert.deepEqual(none.found, []); assert.equal(none.running.has('A.md'), false);
  const broken = directionRuns({ ask: async () => { throw new Error('boom'); } });
  await broken.runs.start('A.md', 'integrateDirection', broken.opts());
  assert.deepEqual(broken.fails, ['boom']); assert.equal(broken.running.has('A.md'), false);
  const gates = []; let asked = 0;
  const twice = directionRuns({ ask: async (_c, _m, _r, _s, _e, accepted) => { asked++; accepted(); await new Promise(r => gates.push(r)); return { suggestions: [sugg('X')] }; } });
  const runs = [twice.runs.start('A.md', 'integrateDirection', twice.opts()), twice.runs.start('A.md', 'integrateDirection', twice.opts())];
  await settle(); assert.equal(asked, 1, 'the run is registered before the note is read, so the second click is refused'); assert.equal(twice.fails.length, 1);
  gates[0](); await runs[0]; await runs[1]; assert.equal(twice.running.has('A.md'), false);
});

const integrateRuns = ({ reply, ask, notes = { 'A.md': fakeNote() } } = {}) => {
  for (const key of Object.keys(notes)) notes[key] = { visualReferences: '', ...notes[key] };
  const h = researchRuns({ notes, extra: { askModel: ask ?? (async (context, model, _r, signal, _e, accepted) => { h.log.asks.push({ context, model, signal }); h.events.push(['ask', h.running.has('A.md'), h.store.get('A.md').status]); accepted(); return { summary: 'NS', detail: 'ND', visualReferences: [], suggestions: [], ...reply }; }) } });
  h.events = []; h.fails = []; h.state = { viewChanged: false, sourcesChanged: false, sent: false };
  h.opts = (over = {}) => ({
    map: () => undefined,
    prepare: async () => ({ detailTemplate: { id: 'std', sections: [] }, viewChanged: () => h.state.viewChanged, sourcesChanged: async () => h.state.sourcesChanged }),
    onStarted: async () => h.events.push(['started', h.running.has('A.md'), h.store.get('A.md').status]),
    buildContext: async note => ({ title: note.title, mode: 'synthesize', outputLanguage: 'en' }), findingsSent: () => h.state.sent, accepted: () => h.events.push(['accepted']),
    drafted: async (_result, save, summary, detail) => { await save(summary, detail); h.events.push(['written']); },
    onWritten: async change => { h.log.written.push(change); h.events.push(['onWritten']); },
    queueCharts: job => h.log.charts.push(job), failed: m => h.fails.push(m), onSettled: async () => h.events.push(['settled', h.running.has('A.md')]), ...over
  });
  return h;
};

test('integrateChildren: a normal run sets running, asks, restores then writes the answer, queues charts and frees the topic', async () => {
  const h = integrateRuns({ notes: { 'A.md': fakeNote({ detail: 'old', status: 'completed', newFindings: 'nf' }) } });
  h.state.sent = true;
  await h.runs.start('A.md', 'integrateChildren', h.opts());
  assert.deepEqual(h.events.map(e => e[0]), ['started', 'ask', 'accepted', 'accepted', 'onWritten', 'written', 'settled']);
  assert.deepEqual(h.events[0], ['started', true, 'running']); assert.deepEqual(h.events.at(-1), ['settled', false]);
  assert.deepEqual(h.log.writes.map(([, patch]) => patch.status), ['running', 'completed', 'completed']);
  const final = h.store.get('A.md'); assert.equal(final.summary, 'NS'); assert.ok('detail' in h.log.writes[2][1]); assert.equal(final.status, 'completed'); assert.equal(final.newFindings, '');
  assert.equal(h.log.written[0].before.status, 'completed'); assert.equal(h.log.written[0].after.summary, 'NS');
  assert.equal(h.log.charts.length, 1); assert.equal(h.log.charts[0].model, 'm1');
  assert.deepEqual(h.fails, []); assert.equal(h.runs.isRunning('A.md'), false); assert.equal(h.activeTasks.has('A.md'), false);
});

test('integrateChildren: unsent findings stay; an edited draft and the save callback receive the note', async () => {
  const h = integrateRuns({ notes: { 'A.md': fakeNote({ newFindings: 'nf' }) } });
  let seen;
  await h.runs.start('A.md', 'integrateChildren', h.opts({ drafted: async (result, save, summary, detail, note) => { seen = [result.summary, note.title]; await save(`${summary}!`, detail); } }));
  assert.deepEqual(seen, ['NS', 'T']); assert.equal(h.store.get('A.md').summary, 'NS!'); assert.equal(h.store.get('A.md').newFindings, 'nf');
});

test('integrateChildren: Stop restores the status, reports the stopped message, writes nothing and frees the topic', async () => {
  let release; const gate = new Promise(r => { release = r; });
  const h = integrateRuns({ notes: { 'A.md': fakeNote({ status: 'completed' }) }, ask: async (_c, _m, _r, _s, _e, accepted) => { accepted(); await gate; return { summary: 'NS', detail: 'ND', suggestions: [] }; } });
  const dialog = new AbortController();
  const run = h.runs.start('A.md', 'integrateChildren', h.opts({ signal: dialog.signal }));
  await settle(); assert.equal(h.running.has('A.md'), true); dialog.abort(); release(); await run;
  assert.equal(h.fails.length, 1); assert.equal(h.store.get('A.md').status, 'completed'); assert.equal(h.store.get('A.md').summary, '');
  assert.equal(h.log.charts.length, 0); assert.equal(h.running.has('A.md'), false);
});

test('integrateChildren: a changed note field, children (view) or sources discards the answer, writes nothing and does not mark the topic failed', async () => {
  const changes = [
    h => { h.store.get('A.md').detail = 'edited'; },
    h => { h.store.get('A.md').newFindings = 'later'; },
    h => { h.store.get('A.md').thinkingOrigin = 'o2'; },
    h => { h.state.viewChanged = true; },
    h => { h.state.sourcesChanged = true; }
  ];
  for (const change of changes) {
    const h = integrateRuns({ notes: { 'A.md': fakeNote({ status: 'completed' }) }, ask: async (_c, _m, _r, _s, _e, accepted) => { accepted(); change(h); return { summary: 'NS', detail: 'ND', suggestions: [] }; } });
    await h.runs.start('A.md', 'integrateChildren', h.opts());
    assert.equal(h.fails.length, 1, 'one report'); assert.equal(h.store.get('A.md').summary, ''); assert.equal(h.store.get('A.md').status, 'completed');
    assert.equal(h.log.charts.length, 0); assert.equal(h.log.written.length, 0); assert.equal(h.running.has('A.md'), false);
  }
});

test('integrateChildren: the 11 note fields count, 12-field research fields (researchMode, visualMode) do not', async () => {
  for (const [field, value, stale] of [['researchMode', 'research', false], ['visualMode', 'on', false], ['model', 'm2', true], ['sourcePaths', ['x.md'], true], ['referencePaths', [{ path: 'r' }], true], ['title', 'U', true], ['summary', 'S2', true], ['prompt', 'p2', true], ['rules', 'r2', true]]) {
    const h = integrateRuns({ ask: async (_c, _m, _r, _s, _e, accepted) => { accepted(); h.store.get('A.md')[field] = value; return { summary: 'NS', detail: 'ND', suggestions: [] }; } });
    await h.runs.start('A.md', 'integrateChildren', h.opts());
    assert.equal(h.fails.length, stale ? 1 : 0, field); assert.equal(h.store.get('A.md').summary === 'NS', !stale, field);
  }
});

test('integrateChildren: a failure marks the topic as error and reports; prepare messages go to failed, else notify; a second click is refused', async () => {
  const h = integrateRuns({ ask: async () => { throw new Error('boom'); } });
  await h.runs.start('A.md', 'integrateChildren', h.opts());
  assert.deepEqual(h.fails, ['boom']); assert.equal(h.store.get('A.md').status, 'error'); assert.equal(h.running.has('A.md'), false);
  const notified = integrateRuns();
  await notified.runs.start('A.md', 'integrateChildren', notified.opts({ failed: undefined, notify: m => notified.log.notices.push(m), prepare: async () => 'no sources' }));
  assert.deepEqual(notified.log.notices, ['no sources']); assert.equal(notified.log.asks.length, 0); assert.equal(notified.running.has('A.md'), false); assert.deepEqual(notified.log.writes, []);
  let release; const gate = new Promise(r => { release = r; });
  const busy = integrateRuns({ ask: async (_c, _m, _r, _s, _e, accepted) => { accepted(); await gate; return { summary: 'S', detail: 'D', suggestions: [] }; } });
  const first = busy.runs.start('A.md', 'integrateChildren', busy.opts());
  await settle(); await busy.runs.start('A.md', 'integrateChildren', busy.opts({ failed: undefined, notify: m => busy.log.notices.push(m) }));
  assert.deepEqual(busy.log.notices, [], 'the refusal goes to failed only (not notify)');
  release(); await first; assert.equal(busy.running.has('A.md'), false);
});

test('the view integration entries no longer touch the running set; they go through the run module', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'experiences/visual-map/view.ts'), 'utf8');
  const body = src.slice(src.indexOf('private async proposeIntegrationDirections('), src.indexOf('private async startSynthesis('));
  assert.doesNotMatch(body, /running\.(add|delete)/); assert.match(body, /topicRuns\.start\(node\.path, "integrateDirection"/); assert.match(body, /topicRuns\.start\(node\.path, "integrateChildren"/);
});

// ---- selection synthesis (ticket 04b): synthesizeSelection ----
const selectionRuns = ({ ask, mutate } = {}) => {
  const h = { events: [], asks: [], writes: [], fails: [], found: [], noDir: 0, sourcesNow: 'S1', current: true, mapChanged: false, closed: false, progressEnds: 0, task: null };
  h.runs = new TopicRuns(ports({
    mutate: mutate ?? (() => work => work()),
    askModel: ask ?? (async (context, model, reasoning, signal, _e, accepted) => { h.asks.push({ context, model, reasoning, signal }); accepted(); return { summary: 'S', detail: 'D', visualReferences: [], suggestions: [sugg('A1'), sugg('A2'), sugg('A3')] }; })
  }));
  h.ctl = new AbortController();
  h.opts = (step, over = {}) => ({
    step, signal: h.ctl.signal, model: async () => ({ model: 'mx', reasoning: 'low' }),
    readSources: async () => ({ id: 'g', name: 'g', location: 'M.md', documents: [{ path: 'a.md', content: h.sourcesNow }] }),
    begin: group => { h.task = { sourceContent: JSON.stringify(group.documents) }; h.events.push('begin'); },
    startProgress: () => ({ end: () => { h.progressEnds++; } }), buildContext: async () => ({ title: 'T', mode: 'synthesize' }),
    accepted: () => h.events.push('accepted'), current: () => h.current, mapChanged: () => h.mapChanged, recordedSources: () => h.task.sourceContent,
    found: items => h.found.push(items), noDirections: () => { h.noDir++; }, closed: () => h.closed,
    applying: () => { h.events.push('applying'); return 'mark'; }, write: async result => { h.writes.push(result); }, written: mark => h.events.push(['written', mark]),
    draftFailed: error => { h.events.push(['draftFailed', error.message]); }, finished: () => h.events.push('finished'),
    fail: error => h.fails.push(error), settled: () => h.events.push('settled'), ...over
  });
  return h;
};

test('synthesizeSelection directions: asks, offers at most 2 directions, registers under the map path and frees it when done', async () => {
  const h = selectionRuns();
  await h.runs.start('M.md', 'synthesizeSelection', h.opts('directions'));
  assert.equal(h.asks[0].model, 'mx'); assert.equal(h.found.length, 1); assert.equal(h.found[0].length, 2); assert.deepEqual(h.fails, []);
  assert.deepEqual(h.events, ['begin', 'accepted', 'accepted', 'settled']);
  assert.equal(h.runs.isRunning('M.md'), false); assert.equal(h.runs.running.size, 0);
  assert.ok(h.progressEnds >= 2);
});

test('synthesizeSelection directions: Stop or a changed map discards the answer; changed sources and an empty answer are reported', async () => {
  const stopped = selectionRuns({ ask: async (_c, _m, _r, _s, _e, accepted) => { accepted(); stopped.ctl.abort(); return { suggestions: [sugg('X')] }; } });
  await stopped.runs.start('M.md', 'synthesizeSelection', stopped.opts('directions'));
  assert.equal(stopped.found.length, 0); assert.equal(stopped.fails.length, 1); // the sandbox has no DOMException, so only the count is checked here
  const moved = selectionRuns(); moved.mapChanged = true;
  await moved.runs.start('M.md', 'synthesizeSelection', moved.opts('directions'));
  assert.equal(moved.found.length, 0); assert.equal(moved.fails.length, 1);
  const stale = selectionRuns({ ask: async (_c, _m, _r, _s, _e, accepted) => { accepted(); stale.sourcesNow = 'S2'; return { suggestions: [sugg('X')] }; } });
  await stale.runs.start('M.md', 'synthesizeSelection', stale.opts('directions'));
  assert.equal(stale.found.length, 0); assert.equal(stale.fails.length, 1);
  const none = selectionRuns({ ask: async () => ({ suggestions: [] }) });
  await none.runs.start('M.md', 'synthesizeSelection', none.opts('directions'));
  assert.equal(none.noDir, 1); assert.deepEqual(none.fails, []);
  const gone = selectionRuns(); gone.current = false;
  await gone.runs.start('M.md', 'synthesizeSelection', gone.opts('directions'));
  assert.equal(gone.found.length, 0); assert.equal(gone.noDir, 0); assert.deepEqual(gone.fails, []);
});

test('synthesizeSelection draft: a normal run writes once through the mutate queue, then reports finished', async () => {
  const queued = []; const h = selectionRuns({ mutate: () => async work => { queued.push('in'); await work(); queued.push('out'); } });
  await h.runs.start('M.md', 'synthesizeSelection', h.opts('draft'));
  assert.equal(h.writes.length, 1); assert.deepEqual(queued, ['in', 'out']); assert.deepEqual(h.fails, []);
  assert.deepEqual(h.events, ['begin', 'accepted', 'applying', ['written', 'mark'], 'finished', 'settled']);
});

test('synthesizeSelection draft: Stop, changed sources, a changed map and a closed view write nothing', async () => {
  const stopped = selectionRuns({ ask: async (_c, _m, _r, _s, _e, accepted) => { accepted(); stopped.ctl.abort(); return { summary: 'S', detail: 'D', suggestions: [] }; } });
  await stopped.runs.start('M.md', 'synthesizeSelection', stopped.opts('draft'));
  assert.equal(stopped.writes.length, 0); assert.ok(stopped.events.some(e => Array.isArray(e) && e[0] === 'draftFailed'));
  const stale = selectionRuns({ ask: async (_c, _m, _r, _s, _e, accepted) => { accepted(); stale.sourcesNow = 'S2'; return { summary: 'S', detail: 'D', suggestions: [] }; } });
  await stale.runs.start('M.md', 'synthesizeSelection', stale.opts('draft'));
  assert.equal(stale.writes.length, 0); assert.ok(stale.events.some(e => Array.isArray(e) && e[0] === 'draftFailed'));
  const moved = selectionRuns(); moved.mapChanged = true;
  await moved.runs.start('M.md', 'synthesizeSelection', moved.opts('draft'));
  assert.equal(moved.writes.length, 0); assert.ok(moved.events.some(e => Array.isArray(e) && e[0] === 'draftFailed'));
  const closed = selectionRuns(); closed.closed = true;
  await closed.runs.start('M.md', 'synthesizeSelection', closed.opts('draft'));
  assert.equal(closed.writes.length, 0);
  const gone = selectionRuns(); gone.current = false;
  await gone.runs.start('M.md', 'synthesizeSelection', gone.opts('draft'));
  assert.equal(gone.writes.length, 0); assert.ok(gone.events.includes('finished'), '307bcd7: a discarded task still ends the draft step normally');
});

test('synthesizeSelection draft: a thrown draftFailed or a failing write reaches fail; the view selection entry goes through the module', async () => {
  const h = selectionRuns({ ask: async () => { throw new Error('boom'); } });
  await h.runs.start('M.md', 'synthesizeSelection', h.opts('draft', { draftFailed: error => { throw error; } }));
  assert.equal(h.fails.length, 1); assert.equal(h.fails[0].message, 'boom'); assert.ok(!h.events.includes('finished'));
  const src = fs.readFileSync(path.join(__dirname, '..', 'experiences/visual-map/view.ts'), 'utf8');
  const body = src.slice(src.indexOf('private async startSelectionSynthesis('), src.indexOf('private discardSelectionSynthesis('));
  assert.match(body, /topicRuns\.start\(mapPath, "synthesizeSelection"/); assert.doesNotMatch(body, /plugin\.askModel|running\.(add|delete)/);
});

test('04c: isBusy, hasTask, stopTask, registerTask and releaseTask go through the ports', () => {
  const running = new Set(), activeTasks = new Map();
  const runs = fresh({ running: () => running, activeTasks: () => activeTasks });
  running.add('A.md'); assert.equal(runs.isBusy('A.md'), true); assert.equal(runs.isBusy('B.md'), false);
  const a = new AbortController(), b = new AbortController();
  runs.registerTask('A.md', a); assert.equal(runs.hasTask('A.md'), true); assert.equal(runs.taskController('A.md'), a);
  runs.releaseTask('A.md', b); assert.equal(runs.hasTask('A.md'), true, 'a foreign controller does not release');
  runs.stopTask('A.md'); assert.equal(a.signal.aborted, true); runs.stopTask('Z.md');
  runs.releaseTask('A.md', a); assert.equal(runs.hasTask('A.md'), false);
});

test('04c: pending, dropPending and flushPending follow the store the port holds now', async () => {
  let store = new Map([['A.md', [{ title: 'x' }]]]);
  const runs = fresh({ pendingSuggestions: () => store });
  assert.equal(runs.pending('A.md').length, 1); runs.dropPending('A.md'); assert.equal(runs.pending('A.md'), undefined);
  await runs.flushPending();
  let flushed = 0; store = Object.assign(new Map([['B.md', []]]), { flush: async () => { flushed++; } });
  runs.dropPending('B.md'); await runs.flushPending(); assert.equal(flushed, 1); assert.equal(runs.pending('B.md'), undefined);
});

test('04c: the view never touches the running set, the pending store or topic-run stop registration directly', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'experiences/visual-map/view.ts'), 'utf8');
  const rest = src.slice(0, src.indexOf('private async chatExpand(')) + src.slice(src.indexOf('private async chatSynthesize('));
  assert.doesNotMatch(rest, /plugin\.(running|pendingSuggestions)\b/);
  assert.doesNotMatch(rest, /plugin\.activeTasks\??\.(set|delete|get|has)\((?!key|this\.chatTaskKey)/);
  assert.doesNotMatch(src, /import \{ PendingSuggestions \}/);
});

// ---- ticket 05a: one start per topic, and every kind of run is stoppable through the registry ----
// Each kind gets the same harness: a run whose model call waits on a gate and records the signal it was given.
function lifecycleKind(kind) {
  const gate = {}; const waiting = new Promise(resolve => { gate.release = resolve; });
  const asked = [];
  const slowAsk = async (_c, _m, _r, signal, _e, accepted) => { asked.push(signal); accepted?.(); await waiting; return { summary: 'S', detail: 'D', visualReferences: [], suggestions: [sugg('X')] }; };
  const path = kind === 'synthesizeSelection' ? 'M.md' : 'A.md';
  let h; let start;
  if (kind === 'research') { h = researchRuns({ ask: slowAsk }); start = () => h.runs.start(path, kind, h.options({ runOnce: { model: 'm1' } })); }
  if (kind === 'proposeChildren') { h = proposalRuns({ ask: slowAsk }); start = () => h.runs.start(path, kind, h.opts()); }
  if (kind === 'integrateDirection') { h = directionRuns({ ask: slowAsk }); start = () => h.runs.start(path, kind, h.opts()); }
  if (kind === 'integrateChildren') { h = integrateRuns({ ask: slowAsk }); start = () => h.runs.start(path, kind, h.opts()); }
  if (kind === 'synthesizeSelection') { h = selectionRuns({ ask: slowAsk }); start = () => h.runs.start(path, kind, h.opts('directions', { stop: () => h.ctl.abort(), refused: () => {} })); }
  return { h, path, start, asked, release: gate.release };
}
const everyKind = ['research', 'proposeChildren', 'integrateDirection', 'integrateChildren', 'synthesizeSelection'];

test('05: two starts of the same topic at once run only once, for every kind of run', async () => {
  for (const kind of everyKind) {
    const run = lifecycleKind(kind);
    const both = [run.start(), run.start()];
    await settle(20);
    assert.equal(run.asked.length, 1, kind + ': the model is asked once');
    run.release(); await Promise.all(both.map(p => p.then(handle => handle?.finished)));
    await settle();
    assert.equal(run.h.runs.isRunning(run.path), false, kind + ': the topic is freed when the one run ends');
  }
});

test('05: stop(path) stops a run of every kind', async () => {
  for (const kind of everyKind) {
    const run = lifecycleKind(kind);
    const started = run.start(); await settle();
    assert.equal(run.asked.length, 1, kind + ': the run is waiting for the model');
    run.h.runs.stop(run.path);
    assert.equal(run.asked[0].aborted, true, kind + ': stop(path) aborts the signal the model call got');
    run.release(); await started; await settle();
    assert.equal(run.h.runs.isRunning(run.path), false, kind + ': stopped run frees the topic');
  }
});

test('05: stopAll (resetting Codex) stops a run of every kind, selection synthesis and integrations included', async () => {
  for (const kind of everyKind) {
    const run = lifecycleKind(kind);
    const started = run.start(); await settle();
    run.h.runs.stopAll();
    assert.equal(run.asked[0].aborted, true, kind + ': stopAll aborts the signal the model call got');
    run.release(); await started; await settle();
    assert.equal(run.h.runs.isRunning(run.path), false);
  }
});

test('05: dispose stops every run in flight and refuses a new start, for every kind', async () => {
  for (const kind of everyKind) {
    const run = lifecycleKind(kind);
    const started = run.start(); await settle();
    run.h.runs.dispose();
    assert.equal(run.asked[0].aborted, true, kind + ': dispose aborts the signal the model call got');
    run.release(); await started; await settle();
    await run.start();
    assert.equal(run.asked.length, 1, kind + ': nothing starts after dispose');
  }
});

test('05 (L33): a thrown startup of an integrate-children run restores the status, frees the topic and rethrows', async () => {
  const h = integrateRuns({ notes: { 'A.md': fakeNote({ status: 'completed' }) } });
  await assert.rejects(h.runs.start('A.md', 'integrateChildren', h.opts({ onStarted: async () => { throw new Error('redraw failed'); } })), /redraw failed/);
  assert.equal(h.runs.isRunning('A.md'), false); assert.equal(h.running.has('A.md'), false);
  assert.equal(h.store.get('A.md').status, 'completed'); assert.equal(h.log.asks.length, 0);
  const note = integrateRuns({ notes: { 'A.md': fakeNote({ status: 'completed' }) } });
  await assert.rejects(note.runs.start('A.md', 'integrateChildren', note.opts({ prepare: async () => { throw new Error('prepare failed'); } })), /prepare failed/);
  assert.equal(note.running.has('A.md'), false, 'an error before the status change also frees the topic');
});

test('05 (L34): the selection error sink is a closure of each call, not a view field', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'experiences/visual-map/view.ts'), 'utf8');
  assert.doesNotMatch(src, /synthesisErrorSink/); assert.match(src, /errorSink/);
});

test('05: a refused selection synthesis calls refused and none of the run callbacks; the first run keeps going', async () => {
  const run = lifecycleKind('synthesizeSelection');
  const first = run.start(); await settle();
  const refused = []; const events = run.h.events;
  await run.h.runs.start('M.md', 'synthesizeSelection', run.h.opts('directions', { refused: () => refused.push(1), settled: () => events.push('second-settled') }));
  assert.equal(refused.length, 1); assert.ok(!events.includes('second-settled'));
  assert.equal(run.h.runs.isRunning('M.md'), true);
  run.release(); await first;
});
