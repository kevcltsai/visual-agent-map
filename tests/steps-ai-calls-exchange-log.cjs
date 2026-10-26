// core/ai-calls.ts: the model call over the Claude and Codex runtimes and the AI exchange log. Ported from the former
// runtimeStepProvider tests; the assertions are the same except where AiCalls differs by design (D-2026-10-334 D2):
// the runtime signal is AiCalls' own controller, `onBegin` replaces `onExchange`, `entryEnd: 'caller'` replaces
// `finish: 'caller'`, and the call goes through `runCall` / `run` instead of `provider.complete`.
const { test } = require('node:test');
const { nodeFsAdapter } = require('./support-fs-adapter.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { load } = require('./support-replay.cjs');
const { loadWithAiCalls } = require('./support-ai-calls.cjs');

const mod = loadWithAiCalls('core/step-runner.ts');
const { prepareStep } = mod;
const { AiExchangeLog, formatAiExchange } = load('ai-exchange-log.ts');

const newLog = () => new AiExchangeLog(nodeFsAdapter, path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vam-ai-calls-')), 'ai-exchanges.json'), error => { throw error; });
const callsOver = (runtimeOf, locals, exchanges) => new mod.AiCalls({
  runtimeFor: model => mod.aiRuntimeForModel(model, { claude: () => runtimeOf('claude'), codex: local => { locals.push(local); return runtimeOf('codex'); } }),
  exchanges
});

function fixture({ reply = 'raw reply', fail, logging = true, onRun } = {}) {
  const runs = [];
  const runtime = name => ({ runTask: async (...args) => { runs.push({ name, args }); args[4].onRequest?.({ provider: name }); onRun?.(args); if (fail) throw fail; return reply; } });
  const log = newLog();
  const locals = [];
  const calls = callsOver(runtime, locals, () => (logging ? log : null));
  return { runs, log, locals, calls };
}
const request = (extra = {}) => ({ prompt: 'the prompt', schema: { type: 'object' }, step: 'test.step@4', ...extra });
const options = (extra = {}) => ({ model: 'gpt-6-luna', effort: 'low', topic: 'Test · topic', taskName: 'test', signal: new AbortController().signal, localCodex: false, ...extra });
const raw = value => value;
const run = (calls, extra, extraRequest) => calls.runCall(request(extraRequest), options(extra), raw);

// old :24
test('a Codex model runs through the Codex runtime with the step schema, and the exchange records the step label', async () => {
  const { runs, log, calls, locals } = fixture();
  const signal = new AbortController().signal, onText = () => {};
  const reply = await run(calls, { signal, task: { onText, textOnly: true } });
  assert.equal(reply, 'raw reply');
  assert.equal(runs.length, 1); assert.equal(runs[0].name, 'codex'); assert.deepEqual(locals, [false]);
  const [prompt, model, effort, schema, controls] = runs[0].args;
  assert.equal(prompt, 'the prompt'); assert.equal(model, 'gpt-6-luna'); assert.equal(effort, 'low'); assert.deepEqual({ ...schema }, { type: 'object' });
  // D2(a): the runtime signal is AiCalls' own controller; it follows the caller's abort while the call runs.
  assert.notEqual(controls.signal, signal); assert.ok(controls.signal instanceof AbortSignal);
  assert.equal(controls.onText, onText); assert.equal(controls.textOnly, true);
  const [entry] = log.getEntries();
  assert.equal(entry.step, 'test.step@4'); assert.equal(entry.topic, 'Test · topic'); assert.equal(entry.mode, 'task');
  assert.equal(entry.model, 'gpt-6-luna'); assert.equal(entry.effort, 'low'); assert.equal(entry.prompt, 'the prompt');
  assert.equal(entry.status, 'completed'); assert.equal(entry.response, 'raw reply');
  assert.deepEqual(JSON.parse(entry.request), { request: { provider: 'codex' }, prompt: 'the prompt' });
  assert.match(formatAiExchange(entry), /step: test\.step@4/);
  // D2(a): the caller's abort during the call reaches the runtime signal.
  const midCall = new AbortController(); let seen, abortedBefore, abortedAfter;
  const aborting = fixture({ onRun: args => { seen = args[4].signal; abortedBefore = seen.aborted; midCall.abort(); abortedAfter = seen.aborted; } });
  await assert.rejects(run(aborting.calls, { signal: midCall.signal }), error => error.message === 'AI task cancelled');
  assert.equal(abortedBefore, false); assert.equal(abortedAfter, true, 'the caller abort reaches the runtime signal');
  assert.notEqual(seen, midCall.signal);
});

// old :41
test('a claude: model runs through the Claude runtime with the provider model id', async () => {
  const { runs, calls, log } = fixture();
  await run(calls, { model: 'claude:sonnet', mode: 'task' });
  assert.equal(runs[0].name, 'claude'); assert.equal(runs[0].args[1], 'sonnet');
  assert.equal(log.getEntries()[0].model, 'claude:sonnet', 'the log keeps the stored model id');
});

// old :48
test('localCodex selects the Codex runtime without web search', async () => {
  const { calls, locals } = fixture();
  await run(calls, { localCodex: true });
  assert.deepEqual(locals, [true]);
});

// old :54
test('the caller onRequest still runs, and onBegin receives the id of the logged entry', async () => {
  const { calls, log } = fixture();
  const requests = [], ids = [];
  await run(calls, { task: { onRequest: data => requests.push(data) }, onBegin: id => ids.push(id) });
  assert.deepEqual(requests, [{ provider: 'codex' }]);
  assert.deepEqual(ids, [log.getEntries()[0].id]);
});

// old :62
test('a runtime error is logged as failed and rethrown as the same error', async () => {
  const failure = new Error('runtime down'), { calls, log } = fixture({ fail: failure });
  await assert.rejects(run(calls, {}), error => error === failure);
  const [entry] = log.getEntries();
  assert.equal(entry.status, 'failed'); assert.match(entry.error, /runtime down/); assert.equal(entry.step, 'test.step@4');
});

// old :69
test('with exchange logging off nothing is logged and the model still runs', async () => {
  const { calls, log, runs } = fixture({ logging: false });
  const ids = [];
  assert.equal(await run(calls, { onBegin: id => ids.push(id) }), 'raw reply');
  assert.equal(runs.length, 1); assert.equal(log.getEntries().length, 0); assert.deepEqual(ids, []);
});

// old :76
test('through the StepRunner: label from the step definition, schema from the step, parse after the provider', async () => {
  const { calls, log, runs } = fixture({ reply: '{"ok":true}' });
  const step = { id: 'unit.json', version: 7, schema: { type: 'object' }, render: input => `go ${input.name}`, parse: text => JSON.parse(text) };
  const output = await calls.run(prepareStep(step, { name: 'now' }), options({ model: 'claude:opus', effort: 'high', topic: 'Via runner' }), text => step.parse(text));
  assert.deepEqual({ ...output }, { ok: true }); assert.equal(runs[0].args[0], 'go now');
  assert.deepEqual({ ...runs[0].args[3] }, { type: 'object' });
  assert.equal(log.getEntries()[0].step, 'unit.json@7'); assert.equal(log.getEntries()[0].prompt, 'go now');
  const prepared = prepareStep(step, { name: 'again' });
  await calls.run(prepared, options({ model: 'gpt-6-luna', effort: 'low', topic: 'Via send' }), text => step.parse(text));
  assert.equal(log.getEntries()[1].step, 'unit.json@7');
});

// old :87
test('entryEnd "caller": AiCalls stops after received and the caller ends the entry with its own status and message', async () => {
  const { calls, log } = fixture();
  const ids = [];
  await run(calls, { entryEnd: 'caller', onBegin: id => ids.push(id) });
  assert.equal(log.getEntries()[0].status, 'received'); assert.equal(log.getEntries()[0].response, 'raw reply');
  log.parsed(ids[0]);
  assert.equal(log.getEntries()[0].status, 'parsed');
  log.completed(ids[0]);
  assert.equal(log.getEntries()[0].status, 'completed');
});

// old :98
test('entryEnd "caller": a runtime error is rethrown unchanged and not logged as failed, so the caller chooses the message', async () => {
  const failure = new Error('runtime down'), { calls, log } = fixture({ fail: failure });
  const ids = [];
  await assert.rejects(run(calls, { entryEnd: 'caller', onBegin: id => ids.push(id) }), error => error === failure);
  assert.equal(log.getEntries()[0].status, 'sent');
  log.failed(ids[0], 'stage: custom message');
  assert.equal(log.getEntries()[0].status, 'failed'); assert.equal(log.getEntries()[0].error, 'stage: custom message');
});

// old :107
test('turning logging off during a call stops recording; logging off at the start never begins an entry', async () => {
  let logging = true;
  const log = newLog();
  const runtime = { runTask: async (...args) => { args[4].onRequest?.({ provider: 'codex' }); logging = false; return 'late reply'; } };
  const calls = callsOver(() => runtime, [], () => (logging ? log : null));
  assert.equal(await run(calls, {}), 'late reply');
  const [entry] = log.getEntries();
  assert.equal(entry.status, 'sent'); assert.equal(entry.response, '');
  let ids = 0;
  assert.equal(await run(calls, { onBegin: () => ids++ }), 'late reply');
  assert.equal(log.getEntries().length, 1); assert.equal(ids, 0);
});

// old :120
test('afterReply can refuse a reply before it is logged as received', async () => {
  const { log, calls } = fixture({ reply: 'late reply' });
  await assert.rejects(run(calls, { entryEnd: 'caller', afterReply: () => { throw new Error('stopped'); } }), /stopped/);
  const [entry] = log.getEntries();
  assert.equal(entry.status, 'sent'); assert.equal(entry.response, '');
});

// old :127
test('milestones: written once per call with receivedAt and what the runtime reported; a failed call still writes them once', async () => {
  const written = [];
  const sink = { begin() {}, sent() {}, received() {}, parsed() {}, completed() {}, failed() {}, milestones: (id, data) => written.push([id, JSON.parse(JSON.stringify(data))]) };
  const claude = fail => ({ runTask: async (...args) => {
    args[4].onRequest?.({ provider: 'claude' });
    args[4].onMilestones({ usage: { inputTokens: 12, outputTokens: 34 } });
    args[4].onMilestones({ textBeforeTool: true, enforceRetry: false });
    if (fail) throw fail;
    return 'raw';
  } });
  for (const fail of [undefined, new Error('boom')]) {
    written.length = 0;
    const calls = callsOver(name => { if (name !== 'claude') throw new Error('unexpected'); return claude(fail); }, [], () => sink);
    const outcome = run(calls, { model: 'claude:sonnet' });
    if (fail) await assert.rejects(outcome, /boom/); else await outcome;
    assert.equal(written.length, 1, 'one write per call');
    const data = written[0][1];
    assert.deepEqual(data.usage, { inputTokens: 12, outputTokens: 34 });
    assert.equal(data.textBeforeTool, true); assert.equal(data.enforceRetry, false);
    assert.equal('receivedAt' in data, !fail, 'receivedAt only when a reply arrived');
  }
});

// old :150
test('milestones: a Codex call records receivedAt; no write when logging is off', async () => {
  const { log, calls } = fixture();
  await run(calls, {});
  const [entry] = log.getEntries();
  assert.match(entry.milestones.receivedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(formatAiExchange(entry), /milestones: \{"receivedAt":/);
  const off = fixture({ logging: false });
  await run(off.calls, {});
  assert.equal(off.log.getEntries().length, 0);
});
