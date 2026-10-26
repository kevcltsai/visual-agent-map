// S2 lane C: the reframing step and the runtime steering messages.
const { test } = require('node:test');
const { nodeFsAdapter } = require('./support-fs-adapter.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { load, root } = require('./support-replay.cjs');
const { loadWithAiCalls, aiCallsFor } = require('./support-ai-calls.cjs');

const { reframeStep, REFRAME_SCHEMA, REFRAME_TOKEN_BUDGET } = load('core/steps/reframe/step.ts');
// One bundle: the runner, prepareStep's brand registry and AiCalls must come from the same module graph.
const reframing = loadWithAiCalls('core/reframing-service.ts');
const { ReframingService, providerReframeRunner, buildReframePrompt } = reframing;
const { prepareStep } = load('core/step-runner.ts');
const { searchBudgetExhaustedMessage } = load('ai/runtime/messages/index.ts');
const { translate } = load('i18n.ts');
const { AiExchangeLog } = load('ai-exchange-log.ts');

const request = (extra = {}) => ({ targetCore: 'understand', source: 'Candidate insight', question: 'Explore this', context: '', language: 'en', model: 'gpt-6-luna', reasoning: 'low', ...extra });
const goodReply = JSON.stringify({ question: 'What distinguishes these?', context: 'Open tensions remain.', rationale: 'Test it.' });

test('the reframe step renders the same prompt in both languages, carries the schema and a stable label', () => {
  assert.equal(reframeStep.id, 'reframe'); assert.equal(reframeStep.version, 1);
  assert.equal(reframeStep.schema, REFRAME_SCHEMA);
  assert.match(buildReframePrompt(request()), /^Reframe the supplied thinking[\s\S]*Write in English\.[\s\S]*Source snapshot \(JSON string\):\n"Candidate insight"$/);
  assert.match(buildReframePrompt(request({ language: 'zh-TW' })), /Write in Traditional Chinese \(Taiwan\)\./);
  assert.equal(prepareStep(reframeStep, request()).prompt, buildReframePrompt(request()));
});

test('over-budget is a policy: refused before render output reaches any provider, with the localized message', () => {
  const big = request({ source: 'x'.repeat(REFRAME_TOKEN_BUDGET * 4 + 1) });
  assert.throws(() => prepareStep(reframeStep, big), error => error.message === translate('en', 'error.reframing_over_budget'));
  assert.throws(() => prepareStep(reframeStep, { ...big, language: 'zh-TW' }), error => error.message === translate('zh-TW', 'error.reframing_over_budget'));
});

test('the step parser keeps the strict reply contract', () => {
  assert.deepEqual({ ...reframeStep.parse(goodReply, request()) }, { question: 'What distinguishes these?', context: 'Open tensions remain.', rationale: 'Test it.' });
  for (const bad of ['{"question":"q","context":"c","rationale":"r","path":"x"}', '{"question":"a\\nb","context":"c","rationale":"r"}', '{"question":"q","context":" ","rationale":"r"}', '[]'])
    assert.throws(() => reframeStep.parse(bad, request()), /Invalid reframing response/);
});

function runnerFixture({ reply = goodReply, runTask, model = 'gpt-6-luna' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vam-lane-c-'));
  const log = new AiExchangeLog(nodeFsAdapter, path.join(dir, 'ai-exchanges.json'), error => { throw error; });
  const calls = [];
  const runtime = { runTask: runTask ?? (async (...args) => { calls.push(args); args[4].onRequest?.({ via: 'runtime' }); return reply; }) };
  const options = { pluginDirectory: () => '/plugin', exchangeLoggingEnabled: () => true, exchanges: () => log, codexRuntime: (_dir, local) => { calls.localCodex = local; return runtime; }, claudeRuntime: () => runtime };
  const active = new Map();
  return { log, calls, active, service: new ReframingService(providerReframeRunner(aiCallsFor(reframing, options, active))), model };
}

test('provider path: step label on the exchange, sent payload unchanged, log sequence received -> parsed -> completed', async () => {
  const { log, calls, active, service } = runnerFixture();
  const draft = await service.reframe(request(), new AbortController().signal);
  assert.equal(draft.question, 'What distinguishes these?'); assert.equal(active.size, 0); assert.equal(calls.localCodex, true);
  const [prompt, model, effort, schema, controls] = calls[0];
  assert.equal(prompt, buildReframePrompt(request())); assert.equal(model, 'gpt-6-luna'); assert.equal(effort, 'low'); assert.equal(JSON.stringify(schema), JSON.stringify(REFRAME_SCHEMA));
  assert.equal(controls.textOnly, true); assert.equal(controls.searchBudget, 0); assert.ok(controls.signal);
  const [entry] = log.getEntries();
  assert.equal(entry.step, 'reframe@1'); assert.equal(entry.topic, 'Reframing · Explore this'); assert.equal(entry.mode, 'task');
  assert.equal(entry.status, 'completed'); assert.equal(entry.response, goodReply);
  assert.deepEqual(JSON.parse(entry.request), { request: { via: 'runtime' }, prompt });
});

test('provider path: an invalid reply ends the entry as failed, not completed; a runtime error is failed with its message', async () => {
  const states = [];
  const hook = log => { for (const name of ['begin', 'sent', 'received', 'parsed', 'completed', 'failed']) { const original = log[name].bind(log); log[name] = (...args) => { states.push(name); return original(...args); }; } };
  const bad = runnerFixture({ reply: '{"question":"Q?","context":"","rationale":"r"}' }); hook(bad.log);
  await assert.rejects(bad.service.reframe(request(), new AbortController().signal), /Invalid reframing response/);
  assert.deepEqual(states, ['begin', 'sent', 'received', 'failed']);
  const failing = runnerFixture({ runTask: async () => { throw new Error('runtime exploded'); } });
  await assert.rejects(failing.service.reframe(request(), new AbortController().signal), /runtime exploded/);
  const [entry] = failing.log.getEntries(); assert.equal(entry.status, 'failed'); assert.match(entry.error ?? entry.response ?? JSON.stringify(entry), /runtime exploded/);
  assert.equal(failing.active.size, 0);
});

test('provider path: a stop that lands during the call fails the entry as "Reframing stopped" without logging received', async () => {
  const states = [], controller = new AbortController();
  const fx = runnerFixture({ runTask: async () => { controller.abort(); return goodReply; } });
  for (const name of ['received', 'parsed', 'completed', 'failed']) { const original = fx.log[name].bind(fx.log); fx.log[name] = (...args) => { states.push(name); return original(...args); }; }
  await assert.rejects(fx.service.reframe(request(), controller.signal), /Reframing stopped/);
  assert.deepEqual(states, ['failed']);
});

test('provider path: an unsupported Claude model is refused inside the logged exchange', async () => {
  const fx = runnerFixture();
  await assert.rejects(fx.service.reframe(request({ model: 'claude:not-a-real-model' }), new AbortController().signal), /Unsupported Claude model/);
  const [entry] = fx.log.getEntries(); assert.equal(entry.status, 'failed'); assert.equal(entry.step, 'reframe@1'); assert.equal(fx.calls.length, 0);
});

test('over-budget is refused before any provider work or exchange entry', async () => {
  const fx = runnerFixture();
  await assert.rejects(fx.service.reframe(request({ source: 'x'.repeat(REFRAME_TOKEN_BUDGET * 4 + 1) }), new AbortController().signal), /budget|預算/i);
  assert.equal(fx.calls.length, 0); assert.equal(fx.log.getEntries().length, 0);
});

test('the search-budget steer text comes from runtime message files in both languages and is gone from i18n', () => {
  assert.equal(searchBudgetExhaustedMessage('en'), 'The web search budget is used up. Stop searching and finish the answer from the information already gathered; list anything missing as unconfirmed.');
  assert.equal(searchBudgetExhaustedMessage('zh-TW'), '網路搜尋預算已用完。請停止搜尋，根據已取得的資料完成答案；不足之處明確列為待確認。');
  assert.doesNotMatch(require('./support.cjs').i18nSource(), /prompt\.search_budget_exhausted/);
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'ai', 'runtime', 'codex-app-server.ts'), 'utf8'), /search_budget_exhausted/);
  assert.match(fs.readFileSync(path.join(root, 'ai', 'runtime', 'codex-app-server.ts'), 'utf8'), /searchBudgetExhaustedMessage\(\)/);
});

test('reframing no longer builds its prompt or calls runTask; it sends the prepared step through AiCalls', () => {
  const source = fs.readFileSync(path.join(root, 'core', 'reframing-service.ts'), 'utf8');
  assert.doesNotMatch(source, /\.runTask\(|providerModelId|Reframe the supplied/);
  assert.match(source, /\.run\(prepared,/);
  assert.match(fs.readFileSync(path.join(root, 'core', 'ai-calls.ts'), 'utf8'), /\.send\(prepared/);
});
