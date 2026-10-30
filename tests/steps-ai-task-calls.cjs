// Characterization of AiTaskService's exchange-log sequence and call parameters (main task, reference rounds, count repair,
// re-ask, re-send, chart). Written against the Step Runner provider path; it pins what a refactor onto AiCalls must keep.
// `order` holds every log write and every onExchange call in the order they happened.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./support-replay.cjs');

const { translate } = load('i18n.ts');
const { AiTaskService } = load('core/ai-task-service.ts');
const { searchNotPerformedError } = load('ai/search-not-performed.ts');
const templates = load('ai/detail-templates.ts');

const GOOD = JSON.stringify({ summary: 'S', detail: 'D', suggestions: [], visualReferences: [] });
const context = (extra = {}) => ({ title: 'Topic', summary: 'Sum', rules: '', detail: '', task: 'Do the task', ancestors: '', sourceContext: '', mode: 'task', researchMode: 'local', researchDepth: 'fast', visualMode: 'off', ...extra });
const webEvent = { method: 'item/completed', params: { item: { type: 'webSearch', action: { type: 'search' } } } };
const flush = () => new Promise(resolve => setImmediate(resolve));
const waitFor = async predicate => { for (let i = 0; i < 200 && !predicate(); i++) await flush(); assert.ok(predicate(), 'condition reached'); };
const abortError = message => Object.assign(new Error(message), { name: 'AbortError' });

/** A service over a scripted runtime and a recording exchange log. `handler(call)` answers (or throws) per runtime call. */
function rig({ handler, logging = true, language = 'en', clock, pluginDirectory, extra = {} } = {}) {
  const state = { logging, calls: [], routes: [] };
  const order = [];
  const entries = new Map();
  const log = {
    begin: entry => { order.push(['begin', entry.id, entry]); entries.set(entry.id, { ...entry, status: 'preparing', events: ['begin'] }); },
    sent: (id, body, prompt) => { order.push(['sent', id, body, prompt]); entries.get(id).events.push('sent'); entries.get(id).status = 'sent'; },
    received: (id, body) => { order.push(['received', id, body]); entries.get(id).events.push('received'); entries.get(id).status = 'received'; },
    milestones: (id, data) => { order.push(['milestones', id, JSON.parse(JSON.stringify(data))]); entries.get(id).events.push('milestones'); entries.get(id).milestones = JSON.parse(JSON.stringify(data)); },
    parsed: id => { order.push(['parsed', id]); entries.get(id).events.push('parsed'); entries.get(id).status = 'parsed'; },
    completed: id => { order.push(['completed', id]); entries.get(id).events.push('completed'); entries.get(id).status = 'completed'; },
    failed: (id, error) => { order.push(['failed', id, error]); entries.get(id).events.push('failed'); Object.assign(entries.get(id), { status: 'failed', error }); }
  };
  const runtime = route => ({
    runTask: async (prompt, model, effort, schema, controls) => {
      const call = { n: state.calls.length + 1, prompt, model, effort, schema, controls, route };
      state.calls.push(call);
      return handler(call);
    }
  });
  const service = new AiTaskService({
    pluginDirectory: pluginDirectory ?? (() => '/plugin'), language: () => language, defaultReasoning: () => 'low',
    exchangeLoggingEnabled: () => state.logging, exchanges: () => log, ...(clock ? { clock } : {}),
    codexRuntime: (directory, local) => { state.routes.push(['codex', directory, local]); return runtime(local ? 'codex-local' : 'codex-web'); },
    claudeRuntime: directory => { state.routes.push(['claude', directory]); return runtime('claude'); },
    ...extra
  });
  const ids = [];
  const mark = id => { ids.push(id); order.push(['ox', id]); };
  const names = () => order.map(event => event[0]);
  const of = id => order.filter(event => event[1] === id).map(event => event[0]);
  return { service, state, order, entries, log, ids, mark, names, of };
}
/** A runtime reply that reports its request first, as the real runtimes do. */
const answer = (call, reply = GOOD) => { call.controls.onRequest?.({ via: 'fake', n: call.n }); return reply; };

// ---- 1. main task ----
test('main task success: begin, ox, sent(request json), received, milestones, parsed; no completed', async () => {
  const h = rig({ handler: call => answer(call) });
  const result = await h.service.askModel(context(), 'gpt-6-luna', 'low', undefined, h.mark);
  assert.equal(result.summary, 'S');
  assert.deepEqual(h.names(), ['begin', 'ox', 'sent', 'received', 'milestones', 'parsed']);
  const [begin, ox, sent, received, milestones, parsed] = h.order;
  assert.equal(ox[1], begin[1]);
  assert.deepEqual({ ...begin[2], id: '<id>', startedAt: '<time>' }, { id: '<id>', startedAt: '<time>', topic: 'Topic', mode: 'task', model: 'gpt-6-luna', effort: 'low', step: 'task.run@1' });
  assert.equal(sent[1], begin[1]);
  assert.equal(sent[2], JSON.stringify({ via: 'fake', n: 1 }, null, 2), 'sent stores the runtime request only');
  assert.equal(sent[3], h.state.calls[0].prompt, 'the prompt is the third argument');
  assert.equal(received[2], GOOD);
  assert.ok(milestones[2].receivedAt, 'receivedAt is a milestone');
  assert.equal(parsed[1], begin[1]);
  assert.deepEqual(h.ids, [begin[1]]);
});

test('main task routing: Codex local and web, Claude without the prefix; the schema is the same for the same request', async () => {
  const h = rig({ handler: call => answer(call) });
  await h.service.askModel(context({ researchMode: 'local' }), 'gpt-6-luna', 'low');
  await h.service.askModel(context({ researchMode: 'local' }), 'claude:sonnet', 'low');
  await h.service.askModel(context({ researchMode: 'local' }), 'gpt-6-luna', 'low');
  assert.deepEqual(h.state.routes, [['codex', '/plugin', true], ['claude', '/plugin'], ['codex', '/plugin', true]]);
  assert.deepEqual(h.state.calls.map(call => call.route), ['codex-local', 'claude', 'codex-local']);
  assert.deepEqual(h.state.calls.map(call => call.model), ['gpt-6-luna', 'sonnet', 'gpt-6-luna']);
  assert.deepEqual(JSON.parse(JSON.stringify(h.state.calls[0].schema)), JSON.parse(JSON.stringify(h.state.calls[2].schema)));
  assert.ok(h.state.calls[0].schema.required.includes('summary'));
  const web = rig({ handler: call => { call.controls.onWebSearchEvent?.(webEvent); return answer(call); } });
  await web.service.askModel(context({ researchMode: 'research', researchDepth: 'normal' }), 'gpt-6-luna', 'low');
  assert.deepEqual(web.state.routes, [['codex', '/plugin', false]]);
  assert.equal(web.state.calls[0].route, 'codex-web');
});

test('main task controls: signal reaches the runtime and aborts with the caller, timeout, search flags, accepted and web callbacks', async () => {
  const h = rig({ handler: call => answer(call) });
  const controller = new AbortController(), accepted = () => {}, web = () => {};
  await h.service.askModel(context({ researchMode: 'research', timeoutMs: 240_000, aimIsolatedResearch: true }), 'gpt-6-luna', 'low', controller.signal, undefined, accepted, web);
  const controls = h.state.calls[0].controls;
  assert.equal(controls.onAccepted, accepted); assert.equal(controls.onWebSearchEvent, web);
  assert.equal(controls.timeoutMs, 240_000); assert.equal(controls.timeoutMessage, translate('en', 'ui.aim_task_timeout', 4));
  assert.equal(controls.webSearch, true); assert.equal(controls.searchBudget, 0); assert.equal(controls.webSearchOnly, true); assert.equal(controls.textOnly, false);
  assert.ok(h.state.calls[0].schema.required.includes('searchStatus'), 'isolated web research selects the web research schema');
  assert.ok(controls.signal instanceof AbortSignal);
  assert.equal(controls.signal.aborted, false);
  // D-2026-10-318: the runtime signal belongs to AiCalls and follows the caller's only while the call runs.
  assert.notEqual(controls.signal, controller.signal);
  const midCall = new AbortController(); let seen;
  const m = rig({ handler: call => { seen = call.controls.signal; assert.equal(seen.aborted, false); midCall.abort(); assert.equal(seen.aborted, true, 'the caller\'s abort reaches the runtime signal'); return answer(call); } });
  await assert.rejects(m.service.askModel(context(), 'gpt-6-luna', 'low', midCall.signal), error => error.name === 'AbortError');
  assert.notEqual(seen, midCall.signal);
});

// ---- 2. failures ----
test('parse failure: begin, ox, sent, received, milestones, failed(stage parsing)', async () => {
  const h = rig({ handler: call => answer(call, 'this is not json') });
  await assert.rejects(h.service.askModel(context(), 'gpt-6-luna', 'low', undefined, h.mark), /JSON/);
  assert.deepEqual(h.names(), ['begin', 'ox', 'sent', 'received', 'milestones', 'failed']);
  const failed = h.order.at(-1);
  assert.match(failed[2], new RegExp(`^${translate('en', 'log.stage_parsing_reply')}: `));
  assert.equal(failed[1], h.ids[0]);
});

test('runtime failure before the request: begin, ox, failed(stage starting); after it: begin, ox, sent, failed(stage waiting)', async () => {
  for (const [reportRequest, stage, expected] of [[false, 'log.stage_starting_ai', ['begin', 'ox', 'failed']], [true, 'log.stage_waiting_reply', ['begin', 'ox', 'sent', 'failed']]]) {
    const h = rig({ handler: call => { if (reportRequest) call.controls.onRequest({ via: 'fake' }); throw new Error('provider down'); } });
    await assert.rejects(h.service.askModel(context(), 'gpt-6-luna', 'low', undefined, h.mark), /provider down/);
    assert.deepEqual(h.names(), expected, stage);
    // The test's Error belongs to another realm than the service bundle, so the service reports it as text.
    assert.match(h.order.at(-1)[2], new RegExp(`^${translate('en', stage)}: (Error: )?provider down$`));
    assert.equal(h.order.at(-1)[1], h.ids[0]);
  }
});

// ---- 3. re-ask when a research made no search ----
test('re-ask after no search: first entry failed(original message), second entry parsed; runtime called twice', async () => {
  const h = rig({ handler: call => {
    if (call.n === 1) { call.controls.onRequest({}); throw searchNotPerformedError(); }
    call.controls.onWebSearchEvent?.(webEvent);
    return answer(call);
  } });
  const result = await h.service.askModel(context({ researchMode: 'research', researchDepth: 'normal' }), 'gpt-6-luna', 'low', undefined, h.mark);
  assert.equal(h.state.calls.length, 2); assert.equal(result.retrievals, 1);
  assert.equal(h.ids.length, 2); assert.notEqual(h.ids[0], h.ids[1]);
  assert.deepEqual(h.names(), ['begin', 'ox', 'sent', 'failed', 'begin', 'ox', 'sent', 'received', 'milestones', 'parsed']);
  assert.equal(h.order[3][1], h.ids[0]); assert.equal(h.order[4][1], h.ids[1]);
  assert.equal(h.order[3][2], String(searchNotPerformedError()), 'the first entry keeps the original message, without a stage prefix');
});

test('re-ask that still finds no search: failed(original), second begin then failed(stage message); rejects; two runtime calls', async () => {
  const h = rig({ handler: call => { call.controls.onRequest({}); throw searchNotPerformedError(); } });
  await assert.rejects(h.service.askModel(context({ researchMode: 'research', researchDepth: 'normal' }), 'gpt-6-luna', 'low', undefined, h.mark), error => error.name === 'SearchNotPerformedError');
  assert.equal(h.state.calls.length, 2);
  assert.deepEqual(h.names(), ['begin', 'ox', 'sent', 'failed', 'begin', 'ox', 'sent', 'failed']);
  assert.equal(h.order[3][2], String(searchNotPerformedError()));
  assert.match(h.order[7][2], new RegExp(`^${translate('en', 'log.stage_waiting_reply')}: `));
  assert.equal(h.order[7][1], h.ids[1]);
});

test('an aborted signal is not re-asked: one runtime call, one failed entry', async () => {
  const controller = new AbortController();
  const h = rig({ handler: call => { call.controls.onRequest({}); controller.abort(); throw searchNotPerformedError(); } });
  await assert.rejects(h.service.askModel(context({ researchMode: 'research', researchDepth: 'normal' }), 'gpt-6-luna', 'low', controller.signal, h.mark), error => error.name === 'SearchNotPerformedError');
  assert.equal(h.state.calls.length, 1);
  assert.equal(h.names().filter(name => name === 'begin').length, 1);
  assert.equal(h.names().filter(name => name === 'failed').length, 1);
});

// ---- 4. count repair ----
const countTemplate = () => {
  const template = templates.copyTemplate(templates.standardTemplate('zh-TW'), '教學', 't1');
  template.sections.splice(2, 0, { id: 'ex', name: '範例', description: '', role: 'none', count: { mode: 'exact', n: 3 }, aliases: [] });
  return template;
};
const detailWith = items => `### 核心結論\n\n- a\n\n### 範例\n\n${Array.from({ length: items }, (_, i) => `- ${i + 1}`).join('\n')}`;
const replyWith = detail => JSON.stringify({ summary: 'S', detail, suggestions: [], visualReferences: [] });
const repairInput = () => context({ language: 'zh-TW', outputLanguage: 'zh-TW', detailTemplate: countTemplate() });

test('count repair success: first entry parsed then completed after the repair entry is parsed; ox sees both ids in order', async () => {
  const h = rig({ language: 'zh-TW', handler: call => answer(call, replyWith(detailWith(call.n === 1 ? 2 : 3))) });
  const result = await h.service.askModel(repairInput(), 'gpt-6-luna', 'low', undefined, h.mark);
  assert.equal(h.state.calls.length, 2); assert.deepEqual(JSON.parse(JSON.stringify(result.formatIssues)), []);
  assert.equal(h.ids.length, 2);
  assert.deepEqual(h.names(), ['begin', 'ox', 'sent', 'received', 'milestones', 'parsed', 'begin', 'ox', 'sent', 'received', 'milestones', 'parsed', 'completed']);
  assert.equal(h.order[0][1], h.ids[0]); assert.equal(h.order[6][1], h.ids[1]);
  assert.equal(h.order.at(-1)[1], h.ids[0], 'the superseded first entry is the one completed');
  assert.equal(h.entries.get(h.ids[0]).status, 'completed'); assert.equal(h.entries.get(h.ids[1]).status, 'parsed');
  assert.equal(h.state.calls[1].route, 'codex-local');
});

test('count repair aborted: the first entry ends completed, the repair entry failed, AbortError is rethrown', async () => {
  const controller = new AbortController();
  const h = rig({ language: 'zh-TW', handler: call => {
    if (call.n === 1) return answer(call, replyWith(detailWith(2)));
    call.controls.onRequest({}); controller.abort(); throw abortError('Aborted');
  } });
  await assert.rejects(h.service.askModel(repairInput(), 'gpt-6-luna', 'low', controller.signal, h.mark), error => error.name === 'AbortError');
  assert.equal(h.ids.length, 2);
  assert.equal(h.entries.get(h.ids[0]).status, 'completed');
  assert.equal(h.entries.get(h.ids[1]).status, 'failed');
  assert.deepEqual(h.of(h.ids[0]), ['begin', 'ox', 'sent', 'received', 'milestones', 'parsed', 'completed']);
  assert.deepEqual(h.of(h.ids[1]), ['begin', 'ox', 'sent', 'failed']);
});

// ---- 5. re-send ----
function fakeClock() {
  const clock = { time: 0, timers: new Map(), next: 1 };
  clock.now = () => clock.time;
  clock.setTimeout = (callback, ms) => { const id = clock.next++; clock.timers.set(id, { at: clock.time + ms, callback }); return id; };
  clock.clearTimeout = id => { clock.timers.delete(id); };
  clock.advance = ms => {
    const target = clock.time + ms;
    for (;;) {
      const due = [...clock.timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      clock.timers.delete(due[0]); clock.time = due[1].at; due[1].callback();
    }
    clock.time = target;
  };
  return clock;
}

const resendRig = ignoreAbort => {
  const clock = fakeClock();
  const state = { late: undefined, resend: undefined, slow: [] };
  const h = rig({ clock, handler: call => {
    call.controls.onStreamMode?.('stream-json'); call.controls.onAccepted();
    call.controls.onRequest({ n: call.n });
    if (call.n === 1) {
      if (ignoreAbort) return new Promise(resolve => { state.late = () => resolve(replyWith('OLD')); });
      return new Promise((_resolve, reject) => call.controls.signal.addEventListener('abort', () => reject(abortError('cancelled'))));
    }
    return GOOD;
  } });
  const observer = { onSlow: (_id, isSlow, handle) => { state.slow.push(isSlow); if (handle) state.resend = handle; } };
  const start = () => h.service.askModel(context(), 'claude:sonnet', 'low', undefined, h.mark, undefined, undefined, observer);
  return { h, clock, state, start };
};

test('re-send: the first entry is failed(resent) by the time the call resolves; the second carries resendOf and the promised id', async () => {
  const { h, clock, state, start } = resendRig(false);
  const done = start();
  await waitFor(() => h.state.calls.length === 1);
  clock.advance(20_000);
  assert.deepEqual(state.slow, [true]);
  state.resend();
  const result = await done;
  assert.equal(result.summary, 'S');
  assert.equal(h.ids.length, 2);
  const [first, second] = h.ids.map(id => h.entries.get(id));
  assert.equal(first.status, 'failed', 'already failed when the call resolves');
  assert.equal(first.error, translate('en', 'log.research_resent_by_user'));
  assert.equal(first.milestones.resentAs, second.id, 'the first entry names the id the second one was promised');
  assert.equal(second.milestones.resendOf, first.id);
  assert.equal(second.milestones.resentAs, undefined);
  assert.notEqual(second.status, 'failed'); assert.equal(second.status, 'parsed');
  assert.ok(first.milestones.slowShownAt && first.milestones.acceptedAt);
  assert.deepEqual(h.of(first.id), ['begin', 'ox', 'sent', 'failed', 'milestones'], 'failed(resent) is written at once; the attempt\'s milestones follow when it unwinds');
  assert.deepEqual(h.of(second.id), ['begin', 'ox', 'sent', 'received', 'milestones', 'parsed']);
  assert.ok(h.state.calls[0].controls.signal.aborted && !h.state.calls[1].controls.signal.aborted);
});

test('re-send with a runtime that ignores the abort: the first entry is failed at once and a late reply never revives it', async () => {
  const { h, clock, state, start } = resendRig(true);
  const done = start();
  await waitFor(() => h.state.calls.length === 1);
  clock.advance(20_000);
  state.resend();
  assert.equal((await done).summary, 'S');
  const [first, second] = h.ids.map(id => h.entries.get(id));
  assert.equal(first.status, 'failed'); assert.equal(first.error, translate('en', 'log.research_resent_by_user'));
  assert.equal(second.milestones.resendOf, first.id); assert.equal(second.status, 'parsed');
  assert.deepEqual(h.of(second.id), ['begin', 'ox', 'sent', 'received', 'milestones', 'parsed']);
  const before = h.order.length;
  state.late(); await flush(); await flush();
  assert.deepEqual(h.order.slice(before).map(event => [event[0], event[1]]), [['milestones', first.id]], 'the late reply only completes the replaced entry\'s milestones');
  assert.equal(h.entries.get(first.id).status, 'failed');
  assert.ok(!h.of(first.id).includes('received'));
});

// ---- reference rounds ----
test('reference rounds: four extract, four reduce and the main task each end parsed with no completed', async () => {
  const big = JSON.stringify({ summary: 'S', detail: 'e'.repeat(9_001), suggestions: [], visualReferences: [] });
  const h = rig({ handler: call => answer(call, call.prompt.includes('Extract relevant facts') ? big : GOOD) });
  const documents = [1, 2, 3, 4].map(n => ({ path: `n${n}.md`, content: 'x'.repeat(9_001) }));
  const progress = [];
  await h.service.askModel(context({ referenceGroups: [{ id: 'g', name: 'g', location: 'l', documents }], onProgress: text => progress.push(text) }), 'gpt-6-luna', 'low', undefined, h.mark);
  assert.ok(h.state.calls[0].prompt.includes('Extract relevant facts'));
  assert.ok(h.state.calls[4].prompt.includes('Combine the supplied extracted evidence'));
  assert.ok(h.state.calls[8].prompt.includes('Source registry (retain these identities in citations):\n[S1]'));
  assert.equal(progress.at(-1), '');
  const begins = h.order.filter(event => event[0] === 'begin');
  assert.deepEqual(begins.map(event => event[2].step), [...Array(4).fill('task.reference-extract@1'), ...Array(4).fill('task.reference-reduce@1'), 'task.run@1']);
  assert.equal(h.state.calls.length, 9);
  const ids = begins.map(event => event[1]);
  assert.deepEqual(h.ids, [ids[8]], 'onExchange sees the main task entry only; the reference rounds are not reported');
  for (const id of ids) assert.deepEqual(h.of(id), id === ids[8] ? ['begin', 'ox', 'sent', 'received', 'milestones', 'parsed'] : ['begin', 'sent', 'received', 'milestones', 'parsed'], id);
});

// ---- 6. log switches ----
test('logging off from the start: no log write, no onExchange, the result is returned', async () => {
  const h = rig({ logging: false, handler: call => answer(call) });
  const result = await h.service.askModel(context(), 'gpt-6-luna', 'low', undefined, h.mark);
  assert.equal(result.summary, 'S'); assert.deepEqual(h.order, []); assert.deepEqual(h.ids, []);
});

test('logging off at the start and switched on during the call: nothing is recorded', async () => {
  const h = rig({ logging: false, handler: call => { h.state.logging = true; return answer(call); } });
  const result = await h.service.askModel(context(), 'gpt-6-luna', 'low', undefined, h.mark);
  assert.equal(result.summary, 'S'); assert.deepEqual(h.order, []);
});

test('logging switched off after sent: begin, ox and sent only', async () => {
  const h = rig({ handler: call => { const reply = answer(call); h.state.logging = false; return reply; } });
  const result = await h.service.askModel(context(), 'gpt-6-luna', 'low', undefined, h.mark);
  assert.equal(result.summary, 'S');
  assert.deepEqual(h.names(), ['begin', 'ox', 'sent']);
});

// ---- 7. chart ----
const P1 = 'The larva stage lasts 3 days at 25°C and reaches 160–180 mm.';
const NOTE = `${P1}\n\nThe pupa stage lasts 5 days.`;
const TIMELINE = 'timeline\n  title Life cycle\n  3 days : Larva\n  5 days : Pupa';
const chartReply = (anchor = P1, mermaid = TIMELINE) => JSON.stringify({ charts: [{ anchor, shape: 'stages', mermaid }] });
const withWarn = async work => {
  const seen = [], original = console.warn;
  console.warn = (...args) => seen.push(args);
  try { return [await work(), seen]; } finally { console.warn = original; }
};
const chartBase = (extra = {}) => context({ outputLanguage: 'en', addCharts: true, visualMode: 'auto', ...extra });
const chartRig = (handler, options = {}) => rig({ handler, extra: { mermaidParses: async () => true, ...(options.extra ?? {}) }, ...options });
const count = (h, name) => h.names().filter(item => item === name).length;
const notAdded = code => translate('en', 'log.chart_not_added_0', code);

test('chart success: begin(chart.add@1), ox, sent(request only), received, milestones, parsed, completed; runtime controls', async () => {
  const h = chartRig(call => answer(call, chartReply()));
  const controller = new AbortController();
  const [detail, warns] = await withWarn(() => h.service.chartDetail({ input: chartBase(), detail: NOTE, model: 'gpt-6-luna', signal: controller.signal, onExchange: h.mark }));
  assert.match(detail, /```mermaid\ntimeline/); assert.deepEqual(warns, []);
  assert.deepEqual(h.names(), ['begin', 'ox', 'sent', 'received', 'milestones', 'parsed', 'completed']);
  const begin = h.order[0];
  assert.deepEqual({ ...begin[2], id: '<id>', startedAt: '<time>' }, { id: '<id>', startedAt: '<time>', topic: 'Topic', mode: 'task', model: 'gpt-6-luna', effort: 'low', step: 'chart.add@1' });
  assert.equal(h.order[2][2], JSON.stringify({ via: 'fake', n: 1 }, null, 2));
  assert.deepEqual(h.ids, [begin[1]]);
  const call = h.state.calls[0], controls = call.controls;
  assert.equal(call.effort, 'low'); assert.equal(controls.timeoutMs, 180_000);
  assert.equal(controls.timeoutMessage, translate('en', 'ui.ai_task_exceeded_0_minutes', 3));
  assert.equal(controls.webSearch, false); assert.equal(controls.textOnly, true); assert.equal(controls.searchBudget, 0);
  assert.deepEqual(h.state.routes, [['codex', '/plugin', true]]);
  assert.equal(controls.signal.aborted, false);
  // D-2026-10-318: the runtime signal belongs to AiCalls and follows the caller's only while the call runs.
  assert.notEqual(controls.signal, controller.signal);
  const midCall = new AbortController(); let seen;
  const m = chartRig(call => { seen = call.controls.signal; assert.equal(seen.aborted, false); midCall.abort(); assert.equal(seen.aborted, true, 'the caller\'s abort reaches the runtime signal'); return answer(call, chartReply()); });
  await assert.rejects(withWarn(() => m.service.chartDetail({ input: chartBase(), detail: NOTE, model: 'gpt-6-luna', signal: midCall.signal })), error => error.name === 'AbortError');
  assert.notEqual(seen, midCall.signal);
});

test('chart refused by the rules (number, counts, invalid reply): one failed with chart_not_added_0, no completed, one warn, detail unchanged', async () => {
  const section = templates.standardTemplate('en').sections[0];
  let flipped = false;
  const template = { ...templates.standardTemplate('en'), get sections() { return templates.standardTemplate('en').sections.map(s => (s.id === section.id ? { ...s, count: { mode: 'exact', n: flipped ? 2 : 1 } } : s)); } };
  const note = `### ${section.name}\n\n${P1}\n\n- one item`;
  const cases = [
    { code: 'number_not_in_note', reply: chartReply(P1, 'timeline\n  title T\n  170 mm : Larva'), detail: NOTE, input: chartBase() },
    { code: 'counts_changed', reply: chartReply(P1, 'timeline\n  title T\n  3 days : Larva'), detail: note, input: chartBase({ detailTemplate: template }), countIssues: [], flip: true },
    { code: 'invalid_reply', reply: 'not json', detail: NOTE, input: chartBase() }
  ];
  for (const item of cases) {
    flipped = false;
    const h = chartRig(call => { if (item.flip) flipped = true; return answer(call, item.reply); });
    const [detail, warns] = await withWarn(() => h.service.chartDetail({ input: item.input, detail: item.detail, countIssues: item.countIssues, model: 'gpt-6-luna', onExchange: h.mark }));
    assert.equal(detail, item.detail, item.code);
    assert.deepEqual(warns, [['Visual Agent Map chart step', item.code]], item.code);
    assert.deepEqual(h.names(), ['begin', 'ox', 'sent', 'received', 'milestones', 'failed'], item.code);
    assert.equal(count(h, 'failed'), 1); assert.equal(count(h, 'completed'), 0); assert.equal(count(h, 'parsed'), 0);
    assert.equal(h.order.at(-1)[2], notAdded(item.code));
  }
});

test('chart runtime error and timeout: begin, ox, sent, failed(chart_not_added_0 runtime_error) once, detail unchanged, one warn', async () => {
  for (const error of [new Error('runtime down'), new Error('AI task exceeded 3 minutes')]) {
    const h = chartRig(call => { call.controls.onRequest({ n: call.n }); throw error; });
    const [detail, warns] = await withWarn(() => h.service.chartDetail({ input: chartBase(), detail: NOTE, model: 'gpt-6-luna', onExchange: h.mark }));
    assert.equal(detail, NOTE);
    assert.deepEqual(warns, [['Visual Agent Map chart step', 'runtime_error']]);
    assert.deepEqual(h.names(), ['begin', 'ox', 'sent', 'failed']);
    assert.equal(count(h, 'failed'), 1); assert.equal(count(h, 'completed'), 0);
    assert.equal(h.order.at(-1)[2], notAdded('runtime_error'));
  }
  const before = chartRig(() => { throw new Error('runtime down'); });
  await withWarn(() => before.service.chartDetail({ input: chartBase(), detail: NOTE, model: 'gpt-6-luna', onExchange: before.mark }));
  assert.deepEqual(before.names(), ['begin', 'ox', 'failed'], 'a failure before the request has no sent');
  assert.equal(before.order.at(-1)[2], notAdded('runtime_error'));
});

test('chart abort while the runtime runs: one failed with the error message, no completed, AbortError rethrown, no warn', async () => {
  const controller = new AbortController();
  const h = chartRig(call => { call.controls.onRequest({ n: call.n }); controller.abort(); throw abortError('Aborted'); });
  const [outcome, warns] = await withWarn(() => h.service.chartDetail({ input: chartBase(), detail: NOTE, model: 'gpt-6-luna', signal: controller.signal, onExchange: h.mark }).then(() => 'resolved', error => error));
  assert.equal(outcome.name, 'AbortError'); assert.deepEqual(warns, []);
  assert.deepEqual(h.names(), ['begin', 'ox', 'sent', 'failed']);
  assert.equal(count(h, 'failed'), 1); assert.equal(count(h, 'completed'), 0);
  assert.match(h.order.at(-1)[2], /^(AbortError: )?Aborted$/);
});

test('chart: an already aborted signal throws before anything is logged or called', async () => {
  const controller = new AbortController(); controller.abort();
  const h = chartRig(call => answer(call, chartReply()));
  await assert.rejects(h.service.chartDetail({ input: chartBase(), detail: NOTE, model: 'gpt-6-luna', signal: controller.signal, onExchange: h.mark }), error => error.name === 'AbortError');
  assert.deepEqual(h.order, []); assert.equal(h.state.calls.length, 0);
});

test('chart: pluginDirectory throwing gives 0 events, 0 runtime calls and the original error', async () => {
  const boom = new Error('no plugin directory');
  const h = chartRig(call => answer(call, chartReply()), { pluginDirectory: () => { throw boom; } });
  await assert.rejects(h.service.chartDetail({ input: chartBase(), detail: NOTE, model: 'gpt-6-luna', onExchange: h.mark }), error => error === boom);
  assert.deepEqual(h.order, []); assert.equal(h.state.calls.length, 0);
});

test('chart with logging off: no events, no onExchange, the chart is still added', async () => {
  const h = chartRig(call => answer(call, chartReply()), { logging: false });
  const detail = await h.service.chartDetail({ input: chartBase(), detail: NOTE, model: 'gpt-6-luna', onExchange: h.mark });
  assert.match(detail, /```mermaid\ntimeline/);
  assert.deepEqual(h.order, []); assert.deepEqual(h.ids, []); assert.equal(h.state.calls.length, 1);
});

test('chart with three diagrams already in the detail: no runtime call and no events', async () => {
  const d = n => `Para ${n}.\n\n\`\`\`mermaid\nflowchart TD\nA-->B\n\`\`\``;
  const h = chartRig(call => answer(call, chartReply()));
  const detail = [d(1), d(2), d(3)].join('\n\n');
  assert.equal(await h.service.chartDetail({ input: chartBase(), detail, model: 'gpt-6-luna', onExchange: h.mark }), detail);
  assert.deepEqual(h.order, []); assert.equal(h.state.calls.length, 0);
});

test('chart log switched on during the call is not recorded; switched off after sent leaves begin, ox, sent', async () => {
  const on = chartRig(call => { on.state.logging = true; return answer(call, chartReply()); }, { logging: false });
  await on.service.chartDetail({ input: chartBase(), detail: NOTE, model: 'gpt-6-luna', onExchange: on.mark });
  assert.deepEqual(on.order, []);
  const off = chartRig(call => { const reply = answer(call, chartReply()); off.state.logging = false; return reply; });
  await off.service.chartDetail({ input: chartBase(), detail: NOTE, model: 'gpt-6-luna', onExchange: off.mark });
  assert.deepEqual(off.names(), ['begin', 'ox', 'sent']);
});

// ---- 8. AIM conclusion diagrams ----
test('addDiagramsToDetail: diagrams off means no call, no event and no onStart; on gives the chart success sequence', async () => {
  const off = chartRig(call => answer(call, chartReply()), { extra: { diagramsEnabled: () => false } });
  let started = 0;
  const same = await off.service.addDiagramsToDetail({ title: 'Goal', detail: NOTE, language: 'en', model: 'gpt-6-luna', onStart: () => { started++; } });
  assert.equal(same, NOTE); assert.equal(started, 0); assert.deepEqual(off.order, []); assert.equal(off.state.calls.length, 0);
  const on = chartRig(call => answer(call, chartReply()), { extra: { diagramsEnabled: () => true } });
  const detail = await on.service.addDiagramsToDetail({ title: 'Goal', detail: NOTE, language: 'en', model: 'gpt-6-luna', onStart: () => { started++; } });
  assert.match(detail, /```mermaid\ntimeline/); assert.equal(started, 1);
  assert.deepEqual(on.names(), ['begin', 'sent', 'received', 'milestones', 'parsed', 'completed'], 'no onExchange on this path');
  assert.deepEqual({ ...on.order[0][2], id: '<id>', startedAt: '<time>' }, { id: '<id>', startedAt: '<time>', topic: 'Goal', mode: 'task', model: 'gpt-6-luna', effort: 'low', step: 'chart.add@1' });
  assert.equal(on.state.calls[0].controls.timeoutMs, 180_000);
});
