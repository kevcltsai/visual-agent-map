// core/runtime-step-provider.ts: the shared StepProvider over the Claude and Codex runtimes and the AI exchange log.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { load } = require('./support-replay.cjs');

const { runtimeStepProvider } = load('core/runtime-step-provider.ts');
const { StepRunner, prepareStep } = load('core/step-runner.ts');
const { AiExchangeLog, formatAiExchange } = load('ai-exchange-log.ts');

function fixture({ reply = 'raw reply', fail, logging = true } = {}) {
  const runs = [];
  const runtime = name => ({ runTask: async (...args) => { runs.push({ name, args }); args[4].onRequest?.({ provider: name }); if (fail) throw fail; return reply; } });
  const log = new AiExchangeLog(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vam-runtime-provider-')), 'ai-exchanges.json'), error => { throw error; });
  const locals = [];
  const provider = runtimeStepProvider({ claude: () => runtime('claude'), codex: local => { locals.push(local); return runtime('codex'); }, exchanges: () => (logging ? log : null) });
  return { runs, log, locals, provider, localProvider: runtimeStepProvider({ claude: () => runtime('claude'), codex: local => { locals.push(local); return runtime('codex'); }, exchanges: () => log, localCodex: true }) };
}
const call = (controls, extra = {}) => ({ stepId: 'test.step', version: 4, prompt: 'the prompt', schema: { type: 'object' }, controls: { model: 'gpt-6-luna', effort: 'low', topic: 'Test · topic', ...controls }, ...extra });

test('a Codex model runs through the Codex runtime with the step schema, and the exchange records the step label', async () => {
  const { runs, log, provider, locals } = fixture();
  const signal = new AbortController().signal, onText = () => {};
  const raw = await provider.complete(call({ task: { signal, onText, textOnly: true } }));
  assert.equal(raw, 'raw reply');
  assert.equal(runs.length, 1); assert.equal(runs[0].name, 'codex'); assert.deepEqual(locals, [false]);
  const [prompt, model, effort, schema, controls] = runs[0].args;
  assert.equal(prompt, 'the prompt'); assert.equal(model, 'gpt-6-luna'); assert.equal(effort, 'low'); assert.deepEqual({ ...schema }, { type: 'object' });
  assert.equal(controls.signal, signal); assert.equal(controls.onText, onText); assert.equal(controls.textOnly, true);
  const [entry] = log.getEntries();
  assert.equal(entry.step, 'test.step@4'); assert.equal(entry.topic, 'Test · topic'); assert.equal(entry.mode, 'task');
  assert.equal(entry.model, 'gpt-6-luna'); assert.equal(entry.effort, 'low'); assert.equal(entry.prompt, 'the prompt');
  assert.equal(entry.status, 'completed'); assert.equal(entry.response, 'raw reply');
  assert.deepEqual(JSON.parse(entry.request), { request: { provider: 'codex' }, prompt: 'the prompt' });
  assert.match(formatAiExchange(entry), /step: test\.step@4/);
});

test('a claude: model runs through the Claude runtime with the provider model id', async () => {
  const { runs, provider, log } = fixture();
  await provider.complete(call({ model: 'claude:sonnet', mode: 'task' }));
  assert.equal(runs[0].name, 'claude'); assert.equal(runs[0].args[1], 'sonnet');
  assert.equal(log.getEntries()[0].model, 'claude:sonnet', 'the log keeps the stored model id');
});

test('localCodex selects the Codex runtime without web search', async () => {
  const { localProvider, locals } = fixture();
  await localProvider.complete(call({}));
  assert.deepEqual(locals, [true]);
});

test('the caller onRequest still runs, and onExchange receives the id of the logged entry', async () => {
  const { provider, log } = fixture();
  const requests = [], ids = [];
  await provider.complete(call({ task: { onRequest: data => requests.push(data) }, onExchange: id => ids.push(id) }));
  assert.deepEqual(requests, [{ provider: 'codex' }]);
  assert.deepEqual(ids, [log.getEntries()[0].id]);
});

test('a runtime error is logged as failed and rethrown as the same error', async () => {
  const failure = new Error('runtime down'), { provider, log } = fixture({ fail: failure });
  await assert.rejects(provider.complete(call({})), error => error === failure);
  const [entry] = log.getEntries();
  assert.equal(entry.status, 'failed'); assert.match(entry.error, /runtime down/); assert.equal(entry.step, 'test.step@4');
});

test('with exchange logging off nothing is logged and the model still runs', async () => {
  const { provider, log, runs } = fixture({ logging: false });
  const ids = [];
  assert.equal(await provider.complete(call({ onExchange: id => ids.push(id) })), 'raw reply');
  assert.equal(runs.length, 1); assert.equal(log.getEntries().length, 0); assert.deepEqual(ids, []);
});

test('through the StepRunner: label from the step definition, schema from the step, parse after the provider', async () => {
  const { provider, log } = fixture({ reply: '{"ok":true}' });
  const step = { id: 'unit.json', version: 7, schema: { type: 'object' }, render: input => `go ${input.name}`, parse: raw => JSON.parse(raw) };
  const result = await new StepRunner(provider).run(step, { name: 'now' }, { model: 'claude:opus', effort: 'high', topic: 'Via runner' });
  assert.deepEqual({ ...result.output }, { ok: true }); assert.equal(result.prompt, 'go now');
  assert.equal(log.getEntries()[0].step, 'unit.json@7'); assert.equal(log.getEntries()[0].prompt, 'go now');
  const prepared = prepareStep(step, { name: 'again' });
  await new StepRunner(provider).send(prepared, { model: 'gpt-6-luna', effort: 'low', topic: 'Via send' });
  assert.equal(log.getEntries()[1].step, 'unit.json@7');
});

test('finish "caller": the provider stops after received and the caller ends the entry with its own status and message', async () => {
  const { provider, log } = fixture();
  const ids = [];
  await provider.complete(call({ finish: 'caller', onExchange: id => ids.push(id) }));
  assert.equal(log.getEntries()[0].status, 'received'); assert.equal(log.getEntries()[0].response, 'raw reply');
  log.parsed(ids[0]);
  assert.equal(log.getEntries()[0].status, 'parsed');
  log.completed(ids[0]);
  assert.equal(log.getEntries()[0].status, 'completed');
});

test('finish "caller": a runtime error is rethrown unchanged and not logged as failed, so the caller chooses the message', async () => {
  const failure = new Error('runtime down'), { provider, log } = fixture({ fail: failure });
  const ids = [];
  await assert.rejects(provider.complete(call({ finish: 'caller', onExchange: id => ids.push(id) })), error => error === failure);
  assert.equal(log.getEntries()[0].status, 'sent');
  log.failed(ids[0], 'stage: custom message');
  assert.equal(log.getEntries()[0].status, 'failed'); assert.equal(log.getEntries()[0].error, 'stage: custom message');
});

test('turning logging off during a call stops recording; logging off at the start never begins an entry', async () => {
  let logging = true;
  const log = new AiExchangeLog(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vam-runtime-provider-')), 'ai-exchanges.json'), error => { throw error; });
  const runtime = { runTask: async (...args) => { args[4].onRequest?.({ provider: 'codex' }); logging = false; return 'late reply'; } };
  const provider = runtimeStepProvider({ claude: () => runtime, codex: () => runtime, exchanges: () => (logging ? log : null) });
  assert.equal(await provider.complete(call({})), 'late reply');
  const [entry] = log.getEntries();
  assert.equal(entry.status, 'sent'); assert.equal(entry.response, '');
  let ids = 0;
  assert.equal(await provider.complete(call({ onExchange: () => ids++ })), 'late reply');
  assert.equal(log.getEntries().length, 1); assert.equal(ids, 0);
});

test('afterReply can refuse a reply before it is logged as received', async () => {
  const { log, provider } = fixture({ reply: 'late reply' });
  await assert.rejects(provider.complete(call({ finish: 'caller', afterReply: () => { throw new Error('stopped'); } })), /stopped/);
  const [entry] = log.getEntries();
  assert.equal(entry.status, 'sent'); assert.equal(entry.response, '');
});

test('milestones: written once per call with receivedAt and what the runtime reported; a failed call still writes them once', async () => {
  const written = [];
  const sink = { begin() {}, sent() {}, received() {}, completed() {}, failed() {}, milestones: (id, data) => written.push([id, JSON.parse(JSON.stringify(data))]) };
  const claude = fail => ({ runTask: async (...args) => {
    args[4].onRequest?.({ provider: 'claude' });
    args[4].onMilestones({ usage: { inputTokens: 12, outputTokens: 34 } });
    args[4].onMilestones({ textBeforeTool: true, enforceRetry: false });
    if (fail) throw fail;
    return 'raw';
  } });
  for (const fail of [undefined, new Error('boom')]) {
    written.length = 0;
    const provider = runtimeStepProvider({ claude: () => claude(fail), codex: () => { throw new Error('unexpected'); }, exchanges: () => sink });
    const outcome = provider.complete(call({ model: 'claude:sonnet' }));
    if (fail) await assert.rejects(outcome, /boom/); else await outcome;
    assert.equal(written.length, 1, 'one write per call');
    const data = written[0][1];
    assert.deepEqual(data.usage, { inputTokens: 12, outputTokens: 34 });
    assert.equal(data.textBeforeTool, true); assert.equal(data.enforceRetry, false);
    assert.equal('receivedAt' in data, !fail, 'receivedAt only when a reply arrived');
  }
});

test('milestones: a Codex call records receivedAt; no write when logging is off', async () => {
  const { log, provider } = fixture();
  await provider.complete(call({}));
  const [entry] = log.getEntries();
  assert.match(entry.milestones.receivedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(formatAiExchange(entry), /milestones: \{"receivedAt":/);
  const off = fixture({ logging: false });
  await off.provider.complete(call({}));
  assert.equal(off.log.getEntries().length, 0);
});
