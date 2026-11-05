// Token usage accounting: core/ai-usage-store.ts (the store) and its wiring in core/ai-task-service.ts (what a provider
// call records) and ai/runtime/codex-app-server.ts (the Codex usage notification). Unit level: fake runtimes, a fake clock.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { load } = require('./support-replay.cjs');
const { nodeFsAdapter } = require('./support-fs-adapter.cjs');

const { AiUsageStore, localDayStart, localMonthStart, estimateUsageTokens } = load('core/ai-usage-store.ts');
const { AiTaskService } = load('core/ai-task-service.ts');
const { promptMetrics } = load('ai-exchange-log.ts');

const tempFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vam-usage-')), 'ai-usage.json');
const flush = () => new Promise(resolve => setImmediate(resolve));
const waitFor = async predicate => { for (let i = 0; i < 200 && !predicate(); i++) await flush(); assert.ok(predicate(), 'condition reached'); };
const row = (extra = {}) => ({ action: 'research', mapPath: 'A/map.vam', provider: 'claude', model: 'claude:sonnet', inputTokens: 10, outputTokens: 5, estimated: false, ...extra });
const newStore = (file, { now, errors = [] } = {}) => new AiUsageStore(nodeFsAdapter, file, error => errors.push(error), now);
// The modules load in their own realm, so compare values by their JSON form.
const same = (actual, expected, message) => assert.deepStrictEqual(JSON.parse(JSON.stringify(actual)), expected, message);
const ok = result => { assert.equal(result.status, 'ready'); return result.value; };

// ---- store ----
test('usage store: totals, byAction and recent follow the map path; byAction sums to the map total; the file round-trips', async () => {
  const file = tempFile();
  const store = newStore(file);
  await store.load();
  store.record(row({ action: 'research', inputTokens: 100, outputTokens: 40 }));
  store.record(row({ action: 'expand', inputTokens: 30, outputTokens: 10 }));
  store.record(row({ action: 'other', mapPath: 'B/map.vam', inputTokens: 7, outputTokens: 3 }));
  await store.flush();
  same(ok(store.totals({ mapPath: 'A/map.vam' })), { inputTokens: 130, outputTokens: 50 });
  same(ok(store.totals()), { inputTokens: 137, outputTokens: 53 });
  const by = ok(store.byAction('A/map.vam'));
  same(Object.keys(by).sort(), ['expand', 'other', 'research', 'synthesize', 'writeback']);
  assert.equal(Object.values(by).reduce((n, t) => n + t.inputTokens, 0), 130);
  assert.equal(Object.values(by).reduce((n, t) => n + t.outputTokens, 0), 50);
  same(ok(store.recent('A/map.vam', 10)).map(e => e.action).sort(), ['expand', 'research']);
  assert.equal(ok(store.recent('A/map.vam', 1)).length, 1);
  const reloaded = newStore(file);
  await reloaded.load();
  same(ok(reloaded.totals()), { inputTokens: 137, outputTokens: 53 });
});

test('usage store: subscribers hear every record; unsubscribe and dispose stop them', async () => {
  const store = newStore(tempFile());
  await store.load();
  let heard = 0;
  const off = store.subscribe(() => heard++);
  store.record(row());
  assert.equal(heard, 1);
  off();
  store.record(row());
  assert.equal(heard, 1);
  await store.dispose();
  store.record(row());
  assert.equal(ok(store.totals()).inputTokens, 20, 'a record after dispose is dropped');
});

test('usage store: today is the local day, so 23:59 and 00:01 belong to different days', async () => {
  const store = newStore(tempFile());
  await store.load();
  const late = new Date(2026, 10, 5, 23, 59).getTime();
  const early = new Date(2026, 10, 6, 0, 1).getTime();
  store.record(row({ at: new Date(late).toISOString(), inputTokens: 1, outputTokens: 1 }));
  store.record(row({ at: new Date(early).toISOString(), inputTokens: 100, outputTokens: 100 }));
  same(ok(store.totals({ since: localDayStart(new Date(2026, 10, 6, 9, 0)) })), { inputTokens: 100, outputTokens: 100 });
  same(ok(store.totals({ since: localDayStart(new Date(2026, 10, 5, 9, 0)) })), { inputTokens: 101, outputTokens: 101 });
  assert.equal(localMonthStart(new Date(2026, 10, 15)), new Date(2026, 10, 1).getTime());
});

test('usage store: details older than 90 days fold into their month without changing any total', async () => {
  const file = tempFile();
  const now = new Date(2026, 10, 5, 12, 0).getTime();
  const store = newStore(file, { now: () => now });
  await store.load();
  const old = new Date(now - 91 * 86_400_000);
  const oldMonth = new Date(old.getFullYear(), old.getMonth(), 1).getTime();
  store.record(row({ at: old.toISOString(), action: 'expand', inputTokens: 500, outputTokens: 50 }));
  store.record(row({ at: new Date(now - 3600_000).toISOString(), inputTokens: 10, outputTokens: 5 }));
  await store.flush();
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.entries.length, 1, 'the 91-day-old row is no longer a detail row');
  assert.equal(Object.keys(saved.monthly).length, 1);
  same(ok(store.totals({ since: oldMonth })), { inputTokens: 510, outputTokens: 55 }, 'the old month and this month still count');
  same(ok(store.totals({ mapPath: 'A/map.vam' })), { inputTokens: 510, outputTokens: 55 });
  assert.equal(ok(store.byAction('A/map.vam')).expand.inputTokens, 500, 'the folded month keeps its action split');
  same(ok(store.totals({ since: localMonthStart(now) })), { inputTokens: 10, outputTokens: 5 });
  assert.equal(ok(store.recent('A/map.vam', 10)).length, 1);
});

test('usage store: a corrupt file is kept byte for byte, persistence stops, and queries say unreadable, not zero', async () => {
  const file = tempFile();
  const garbage = '{"version":1,"entries":[oops';
  fs.writeFileSync(file, garbage);
  const errors = [];
  const store = newStore(file, { errors });
  await store.load();
  assert.equal(errors.length, 1, 'the error is reported');
  assert.equal(store.status, 'unreadable');
  store.record(row());
  await store.flush().catch(() => undefined);
  assert.equal(fs.readFileSync(file, 'utf8'), garbage, 'the original bytes are untouched');
  assert.equal(fs.existsSync(`${file}.tmp`), false, 'no temp file was written either');
  for (const result of [store.totals(), store.byAction('A/map.vam'), store.recent('A/map.vam')]) same(result, { status: 'unreadable' });
});

test('usage store: a file with a wrong shape or an invalid row is also unreadable', async () => {
  for (const content of ['[]', JSON.stringify({ version: 1, entries: [{ at: 'x' }], monthly: {} }), JSON.stringify({ version: 2, entries: [], monthly: {} })]) {
    const file = tempFile();
    fs.writeFileSync(file, content);
    const store = newStore(file);
    await store.load();
    assert.equal(store.status, 'unreadable', content);
    assert.equal(fs.readFileSync(file, 'utf8'), content);
  }
});

test('usage store: a write that throws is reported and record does not throw', async () => {
  const errors = [];
  const adapter = { ...nodeFsAdapter, write: async () => { throw new Error('disk full'); } };
  const store = new AiUsageStore(adapter, tempFile(), error => errors.push(error));
  await store.load();
  assert.doesNotThrow(() => store.record(row()));
  await store.flush().catch(() => undefined);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /disk full/);
  same(ok(store.totals()), { inputTokens: 10, outputTokens: 5 }, 'the in-memory count is kept');
});

test('usage estimate is the exchange log prompt formula', () => {
  for (const text of ['hello world', '中文提示 mixed with ascii', '']) {
    assert.equal(estimateUsageTokens(text), text ? promptMetrics({ prompt: text, request: '', mode: '' }).estimatedTokens : 0);
  }
  assert.equal(estimateUsageTokens('abcdefgh'), 2);
  assert.equal(estimateUsageTokens('中文'), 2);
});

// ---- service wiring ----
const GOOD = JSON.stringify({ summary: 'S', detail: 'D', suggestions: [], visualReferences: [] });
const context = (extra = {}) => ({ title: 'Topic', summary: 'Sum', rules: '', detail: '', task: 'Do the task', ancestors: '', sourceContext: '', mode: 'task', researchMode: 'local', researchDepth: 'fast', visualMode: 'off', usageMapPath: 'A/map.vam', ...extra });
const abortError = message => Object.assign(new Error(message), { name: 'AbortError' });

function rig({ handler, usage, clock } = {}) {
  const records = [];
  const sink = usage ?? { record: entry => records.push(entry) };
  const calls = [];
  const runtime = () => ({ runTask: async (prompt, model, effort, schema, controls) => { const call = { n: calls.length + 1, prompt, model, controls }; calls.push(call); return handler(call); } });
  const service = new AiTaskService({
    pluginDirectory: () => '/plugin', language: () => 'en', defaultReasoning: () => 'low',
    exchangeLoggingEnabled: () => false, exchanges: () => null, usage: () => sink, ...(clock ? { clock } : {}),
    codexRuntime: () => runtime(), claudeRuntime: () => runtime()
  });
  return { service, records, calls };
}

test('Claude: a reported usage of 120 in / 45 out is recorded once, not estimated, with action, map and topic', async () => {
  const h = rig({ handler: call => { call.controls.onMilestones({ usage: { inputTokens: 120, outputTokens: 45 } }); return GOOD; } });
  await h.service.askModel(context({ researchMode: 'research' }), 'claude:sonnet', 'low');
  assert.equal(h.records.length, 1);
  same({ ...h.records[0], durationMs: typeof h.records[0].durationMs }, { action: 'research', mapPath: 'A/map.vam', topic: 'Topic', provider: 'claude', model: 'claude:sonnet', inputTokens: 120, outputTokens: 45, estimated: false, durationMs: 'number' });
});

test('actions: decompose is expand, synthesize and merge are synthesize, every task (quick or local too) is research, a count repair is other', async () => {
  const h = rig({ handler: call => { call.controls.onMilestones({ usage: { inputTokens: 1, outputTokens: 1 } }); return GOOD; } });
  for (const mode of ['decompose', 'synthesize', 'merge', 'task']) await h.service.askModel(context({ mode }), 'claude:sonnet', 'low');
  same(h.records.map(r => r.action), ['expand', 'synthesize', 'synthesize', 'research']);
  h.records.length = 0;
  await h.service.askModel(context({ countRepair: true }), 'claude:sonnet', 'low');
  assert.equal(h.records[0].action, 'other');
});

test('Codex without a usage report is estimated from the prompt and the reply and marked estimated; with a report the real numbers win', async () => {
  const h = rig({ handler: call => { call.controls.onRequest({ threadId: 't', input: [{ type: 'text', text: 'abcdefgh' }] }); return GOOD; } });
  await h.service.askModel(context(), 'gpt-6-luna', 'low');
  assert.equal(h.records.length, 1);
  assert.equal(h.records[0].estimated, true);
  assert.equal(h.records[0].inputTokens, estimateUsageTokens('abcdefgh'));
  assert.equal(h.records[0].outputTokens, estimateUsageTokens(GOOD));
  const real = rig({ handler: call => { call.controls.onRequest({ input: [{ type: 'text', text: 'abcdefgh' }] }); call.controls.onMilestones({ usage: { inputTokens: 900, outputTokens: 80 } }); return GOOD; } });
  await real.service.askModel(context(), 'gpt-6-luna', 'low');
  same([real.records[0].inputTokens, real.records[0].outputTokens, real.records[0].estimated], [900, 80, false]);
});

test('Claude without a usage report records nothing (no prompt text to estimate from)', async () => {
  const h = rig({ handler: () => GOOD });
  await h.service.askModel(context(), 'claude:sonnet', 'low');
  assert.equal(h.records.length, 0);
});

test('a failed call that reported usage is recorded once; a runtime that reports twice still counts once', async () => {
  const h = rig({ handler: call => { call.controls.onMilestones({ usage: { inputTokens: 5, outputTokens: 1 } }); call.controls.onMilestones({ usage: { inputTokens: 8, outputTokens: 2 } }); throw new Error('provider failed'); } });
  await assert.rejects(h.service.askModel(context(), 'claude:sonnet', 'low'), /provider failed/);
  assert.equal(h.records.length, 1);
  same([h.records[0].inputTokens, h.records[0].outputTokens], [8, 2]);
});

test('a cancelled call whose provider still reports usage is recorded once', async () => {
  const controller = new AbortController();
  const h = rig({ handler: call => new Promise((_resolve, reject) => {
    call.controls.signal.addEventListener('abort', () => { call.controls.onMilestones({ usage: { inputTokens: 3, outputTokens: 2 } }); reject(abortError('cancelled')); });
  }) });
  const done = h.service.askModel(context(), 'claude:sonnet', 'low', controller.signal);
  await waitFor(() => h.calls.length === 1);
  controller.abort();
  await assert.rejects(done);
  await flush();
  assert.equal(h.records.length, 1);
});

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

for (const ignoreAbort of [false, true]) {
  test(`re-send${ignoreAbort ? ' (runtime ignores the abort)' : ''}: the replaced attempt and the new attempt are each recorded once`, async () => {
    const clock = fakeClock();
    let late;
    const h = rig({ clock, handler: call => {
      call.controls.onStreamMode?.('stream-json'); call.controls.onAccepted();
      if (call.n === 1) {
        const report = () => call.controls.onMilestones({ usage: { inputTokens: 10, outputTokens: 5 } });
        if (ignoreAbort) return new Promise(resolve => { late = () => { report(); resolve(GOOD); }; });
        return new Promise((_resolve, reject) => call.controls.signal.addEventListener('abort', () => { report(); reject(abortError('cancelled')); }));
      }
      call.controls.onMilestones({ usage: { inputTokens: 120, outputTokens: 45 } });
      return GOOD;
    } });
    let resend;
    const observer = { onSlow: (_id, slow, handle) => { if (handle) resend = handle; } };
    const done = h.service.askModel(context(), 'claude:sonnet', 'low', undefined, undefined, undefined, undefined, observer);
    await waitFor(() => h.calls.length === 1);
    clock.advance(20_000);
    resend();
    await done;
    if (ignoreAbort) { late(); await flush(); await flush(); }
    else await waitFor(() => h.records.length === 2);
    await flush();
    same(h.records.map(r => [r.inputTokens, r.outputTokens]).sort((a, b) => a[0] - b[0]), [[10, 5], [120, 45]]);
  });
}

test('a store that throws on record does not change the task result', async () => {
  const h = rig({ usage: { record: () => { throw new Error('store exploded'); } }, handler: call => { call.controls.onMilestones({ usage: { inputTokens: 120, outputTokens: 45 } }); return GOOD; } });
  const result = await h.service.askModel(context(), 'claude:sonnet', 'low');
  assert.equal(result.summary, 'S');
});

test('a real store whose disk write fails does not change the task result', async () => {
  const errors = [];
  const adapter = { ...nodeFsAdapter, write: async () => { throw new Error('disk full'); } };
  const store = new AiUsageStore(adapter, tempFile(), error => errors.push(error));
  await store.load();
  const h = rig({ usage: store, handler: call => { call.controls.onMilestones({ usage: { inputTokens: 120, outputTokens: 45 } }); return GOOD; } });
  const result = await h.service.askModel(context(), 'claude:sonnet', 'low');
  assert.equal(result.summary, 'S');
  await store.flush().catch(() => undefined);
  assert.equal(errors.length, 1);
});

test('the usage map path never reaches the prompt', async () => {
  const h = rig({ handler: call => { call.controls.onMilestones({ usage: { inputTokens: 1, outputTokens: 1 } }); return GOOD; } });
  await h.service.askModel(context({ usageMapPath: 'SECRET/PATH/map.vam' }), 'claude:sonnet', 'low');
  assert.ok(!h.calls[0].prompt.includes('SECRET/PATH'));
});

test('without a usage store the call runs and nothing is recorded', async () => {
  const service = new AiTaskService({
    pluginDirectory: () => '/plugin', language: () => 'en', defaultReasoning: () => 'low',
    exchangeLoggingEnabled: () => false, exchanges: () => null,
    codexRuntime: () => ({ runTask: async () => GOOD }), claudeRuntime: () => ({ runTask: async () => GOOD })
  });
  assert.equal((await service.askModel(context(), 'gpt-6-luna', 'low')).summary, 'S');
});

// ---- AiCalls is the one place a call is recorded ----
const { loadSource } = require('./support-replay.cjs');
const S = require('./support.cjs');
const shared = loadSource(`
export { providerOutlineRunner } from "./core/outline-generation-service";
export { providerReframeRunner } from "./core/reframing-service";
export { prepareStep } from "./core/step-runner";
export { AiCalls } from "./core/ai-calls";
export { aiRuntimeForModel } from "./core/ai-runtime-service";
export { outlineGenerateStep } from "./core/steps/outline-generate/step";
export { reframeStep, REFRAME_SCHEMA } from "./core/steps/reframe/step";
`, { obsidian: S.obsidian });

function sharedCalls(reply, { report, records }) {
  const runtime = () => ({ runTask: async (_prompt, _model, _effort, _schema, controls) => { if (report) controls.onMilestones(report); return reply; } });
  return new shared.AiCalls({
    runtimeFor: model => shared.aiRuntimeForModel(model, { claude: runtime, codex: runtime }),
    exchanges: () => null,
    usage: () => ({ record: entry => records.push(entry) })
  });
}

test('a provider-step call (outline) is recorded exactly once, under its map path', async () => {
  const records = [];
  const calls = sharedCalls('# Root\n## A', { report: { usage: { inputTokens: 70, outputTokens: 9 } }, records });
  const request = { topic: 'Sleep', presetText: 'Make a tree for {research topic}.', language: 'en', model: 'claude:sonnet', reasoning: 'low', usageMapPath: 'A/map.vam' };
  await shared.providerOutlineRunner(calls)(request, new AbortController().signal, shared.prepareStep(shared.outlineGenerateStep, request));
  assert.equal(records.length, 1, 'one call, one entry');
  same([records[0].action, records[0].mapPath, records[0].inputTokens, records[0].outputTokens, records[0].estimated, records[0].provider], ['other', 'A/map.vam', 70, 9, false, 'claude']);
});

test('a reframe call is recorded exactly once', async () => {
  const records = [];
  const reply = JSON.stringify({ question: 'What distinguishes these?', context: 'Open tensions remain.', rationale: 'Test it.' });
  const calls = sharedCalls(reply, { report: { usage: { inputTokens: 40, outputTokens: 6 } }, records });
  const request = { targetCore: 'understand', source: 'Candidate', question: 'Explore this', context: '', language: 'en', model: 'claude:sonnet', reasoning: 'low' };
  const prepared = shared.prepareStep(shared.reframeStep, request);
  await shared.providerReframeRunner(calls)(request, prepared.prompt, shared.REFRAME_SCHEMA, new AbortController().signal, prepared);
  assert.equal(records.length, 1);
  same([records[0].action, records[0].inputTokens, records[0].outputTokens], ['other', 40, 6]);
});

test('an AiTaskService task goes through AiCalls and is still recorded exactly once', async () => {
  const h = rig({ handler: call => { call.controls.onMilestones({ usage: { inputTokens: 120, outputTokens: 45 } }); return GOOD; } });
  await h.service.askModel(context({ mode: 'decompose' }), 'claude:sonnet', 'low');
  assert.equal(h.records.length, 1);
  same([h.records[0].action, h.records[0].mapPath], ['expand', 'A/map.vam']);
});

test('a data: URL reply (image generation) is never estimated as output; only the input is', async () => {
  const records = [];
  const runtime = () => ({ capabilities: { id: 'codex', imageGeneration: true }, runTask: async (_p, _m, _e, _s, controls) => { controls.onRequest({ input: [{ type: 'text', text: 'abcdefgh' }] }); return 'data:image/png;base64,' + 'A'.repeat(4000); } });
  const calls = new shared.AiCalls({
    runtimeFor: model => shared.aiRuntimeForModel(model, { claude: runtime, codex: runtime }),
    exchanges: () => null, usage: () => ({ record: entry => records.push(entry) })
  });
  const prepared = shared.prepareStep(shared.outlineGenerateStep, { topic: 't', presetText: 'p {research topic}', language: 'en', model: 'gpt-6-luna', reasoning: 'low' });
  await calls.run(prepared, { model: 'gpt-6-luna', effort: 'low', topic: 'Markdown selection', taskName: 'markdown-context', signal: new AbortController().signal, localCodex: true, usage: { action: 'writeback' }, task: { generateImage: false } }, raw => raw);
  assert.equal(records.length, 1);
  same([records[0].action, records[0].estimated, records[0].outputTokens, records[0].inputTokens], ['writeback', true, 0, estimateUsageTokens('abcdefgh')]);
});

test('an unreadable usage store reports its error once, not on every record', async () => {
  const file = tempFile();
  fs.writeFileSync(file, '{ not json');
  const errors = [];
  const store = newStore(file, { errors });
  await store.load();
  assert.equal(errors.length, 1);
  store.record(row()); store.record(row()); store.record(row());
  assert.equal(errors.length, 2, 'one for the load, one for the first dropped call');
});
