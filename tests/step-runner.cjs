// Step Runner unit tests, Coffee Tables step wiring, and the Coffee architecture rules.
// Runner behaviour is tested with fake steps/providers; Coffee wiring goes through the real engine and the real
// replay provider (tests/support-replay.cjs) so a recorded reply is parsed by the step's own parser.
const { test } = require('node:test');
const { nodeFsAdapter } = require('./support-fs-adapter.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { load, replayRuntime, root } = require('./support-replay.cjs');

const { renderTemplate, prepareStep, StepRunner, stepLabel } = load('core/step-runner.ts');
const plain = value => JSON.parse(JSON.stringify(value));

function fakeStep(events, overrides = {}) {
  return {
    id: 'test.step', version: 3, schema: { type: 'object' },
    render: input => { events.push('render'); return `prompt:${input.name}`; },
    policy: prompt => { events.push('policy'); if (prompt.length > 100) throw new Error('too long'); },
    parse: raw => { events.push('parse'); return JSON.parse(raw); },
    ...overrides
  };
}
function fakeProvider(events, reply) {
  const calls = [];
  return { calls, complete: async call => { events.push('provider'); calls.push(call); if (reply instanceof Error) throw reply; return reply; } };
}

test('renderTemplate fills placeholders in one pass and removes only the file trailing newline', () => {
  assert.equal(renderTemplate('A {{x}} B {{y}}\n', { x: '1', y: '2' }), 'A 1 B 2');
  assert.equal(renderTemplate('A {{x}}\n\n', { x: '1' }), 'A 1\n');
  assert.equal(renderTemplate('{{x}}', { x: '{{y}} $& $1 \n' }), '{{y}} $& $1 \n', 'values are inserted verbatim and never re-scanned');
  assert.equal(renderTemplate('x {"a":[{"b":1}]} {{v}}', { v: 'ok' }), 'x {"a":[{"b":1}]} ok', 'single braces are plain text');
  assert.equal(renderTemplate('a{{v}}b', { v: '' }), 'ab');
});

test('renderTemplate rejects a missing variable, an unknown placeholder and an unused variable', () => {
  assert.throws(() => renderTemplate('A {{x}} {{y}}', { x: '1' }), /unknown placeholder \{\{y\}\}/);
  assert.throws(() => renderTemplate('A {{ x }}', { x: '1' }), /unknown placeholder/);
  assert.throws(() => renderTemplate('A {{x}}', { x: '1', extra: '2' }), /"extra" is not used/);
  assert.throws(() => renderTemplate('A {{x}}', { x: 5 }), /must be a string/);
  assert.throws(() => renderTemplate('A {{toString}}', {}), /unknown placeholder/);
});

test('StepRunner runs render, policy, provider and parse in order and passes step identity and schema to the provider', async () => {
  const events = [], provider = fakeProvider(events, '{"ok":true}'), controls = { signal: 'abort-signal' };
  const step = fakeStep(events);
  const result = await new StepRunner(provider).run(step, { name: 'n' }, controls);
  assert.deepEqual(events, ['render', 'policy', 'provider', 'parse']);
  assert.deepEqual(plain(result), { output: { ok: true }, prompt: 'prompt:n', raw: '{"ok":true}' });
  assert.equal(provider.calls.length, 1);
  assert.equal(provider.calls[0].stepId, 'test.step'); assert.equal(provider.calls[0].version, 3);
  assert.equal(provider.calls[0].prompt, 'prompt:n'); assert.deepEqual(plain(provider.calls[0].schema), { type: 'object' });
  assert.equal(provider.calls[0].controls, controls, 'controls reach the provider by identity');
  assert.equal(stepLabel(step), 'test.step@3');
});

test('a policy refusal stops the run before the provider is called, with the policy error unchanged', async () => {
  const events = [], provider = fakeProvider(events, '{}');
  await assert.rejects(new StepRunner(provider).run(fakeStep(events), { name: 'x'.repeat(200) }, {}), /^Error: too long$/);
  assert.deepEqual(events, ['render', 'policy']);
  assert.equal(provider.calls.length, 0);
  assert.throws(() => prepareStep(fakeStep([]), { name: 'x'.repeat(200) }), /too long/, 'prepareStep fails synchronously');
});

test('provider errors propagate as the same error object and skip parse', async () => {
  const events = [], failure = new Error('provider down');
  await assert.rejects(new StepRunner(fakeProvider(events, failure)).run(fakeStep(events), { name: 'n' }, {}), error => error === failure);
  assert.deepEqual(events, ['render', 'policy', 'provider']);
});

test('parse errors propagate after the provider replied, and send() leaves parsing to the caller', async () => {
  const events = [], provider = fakeProvider(events, 'not json');
  await assert.rejects(new StepRunner(provider).run(fakeStep(events), { name: 'n' }, {}), SyntaxError);
  assert.deepEqual(events, ['render', 'policy', 'provider', 'parse']);
  const sentEvents = [], sentProvider = fakeProvider(sentEvents, 'not json');
  const sent = await new StepRunner(sentProvider).send(prepareStep(fakeStep(sentEvents), { name: 'n' }), {});
  assert.deepEqual(plain(sent), { prompt: 'prompt:n', raw: 'not json' });
  assert.deepEqual(sentEvents, ['render', 'policy', 'provider'], 'send() renders only through prepareStep and never parses');
});

// ---- Coffee Tables ----
const { coffeeStepProvider } = load('experiences/coffee-tables/step-provider.ts');
const { convergenceStep } = load('experiences/coffee-tables/steps/convergence/step.ts');
const { navigationSummaryStep } = load('experiences/coffee-tables/steps/navigation-summary/step.ts');
const types = load('experiences/coffee-tables/types.ts');
const customization = load('experiences/coffee-tables/customization.ts');

test('the Coffee provider adapter forwards the request unchanged and tags it with stepId@version', async () => {
  const requests = [], signal = new AbortController().signal, onText = () => {}, registerIntervention = () => {};
  const session = types.createSession('Topic', 'm', 'low', 'en');
  const provider = coffeeStepProvider(async request => { requests.push(request); return 'reply'; });
  const raw = await provider.complete({ stepId: 'coffee.table', version: 1, prompt: 'P', controls: { session, signal, onText, registerIntervention } });
  assert.equal(raw, 'reply');
  assert.equal(requests[0].step, 'coffee.table@1'); assert.equal(requests[0].prompt, 'P');
  assert.equal(requests[0].session, session); assert.equal(requests[0].signal, signal);
  assert.equal(requests[0].onText, onText); assert.equal(requests[0].registerIntervention, registerIntervention);
});

test('every Coffee engine model call carries its stepId@version', async () => {
  const { CoffeeEngine } = load('experiences/coffee-tables/engine.ts');
  const notes = '# Observer’s notes\n\n## Unexpected connections\n\n- A concrete connection with enough context to count as an insight.\n\n## Questions worth pursuing\n\n- A question that still needs more discussion and context.\n\n## Core disagreements\n\n- A disagreement with conditions and limits spelled out.\n\n## Directions to explore\n\n- A direction worth exploring with the next evidence.\n\n## Assumptions to verify\n\n- An assumption that should be checked against data.\n\n<!-- coffee-tables-complete -->';
  const dialogue = `### Host｜Host\nOpening line.\n\n${notes}`;
  const session = types.createSession('Step labels', 'm', 'low', 'en');
  const steps = [];
  const engine = new CoffeeEngine(session, async request => {
    steps.push(request.step);
    if (request.step === 'coffee.navigation-summary@1') return JSON.stringify({ summaries: [] });
    if (request.step === 'coffee.convergence@1') return '{"proposals":[]}';
    return dialogue;
  }, async () => {});
  await engine.start(); await engine.continueTable(); await engine.ask('A follow-up question?'); await engine.refreshObserverNotes();
  engine.session.rounds.forEach(round => { round.summary = undefined; });
  await engine.fillSegmentSummaries();
  await engine.previewConvergence();
  assert.deepEqual(steps, ['coffee.table@1', 'coffee.table@1', 'coffee.question@1', 'coffee.observer-only@1', 'coffee.navigation-summary@1', 'coffee.convergence@1']);
});

test('replay: a recorded navigation-summary reply is parsed by the step through the StepRunner', async () => {
  const input = { language: 'en', segments: [{ id: 'round:r1', text: 'First segment' }, { id: 'question:q1', text: 'Second segment' }] };
  const reply = '```json\n{"summaries":[{"id":"round:r1","summary":"Explored the first topic."},{"id":"unknown","summary":"ignored"},{"id":"question:q1","summary":"   "}]}\n```';
  const runtime = replayRuntime([{ response: reply }]);
  const provider = { complete: call => runtime.runTask(call.prompt, 'm', 'low', call.schema, call.controls) };
  const result = await new StepRunner(provider).run(navigationSummaryStep, input, {});
  assert.deepEqual(plain(result.output), [{ id: 'round:r1', summary: 'Explored the first topic.' }]);
  assert.equal(result.raw, reply);
  assert.match(runtime.calls[0].prompt, /^Write one navigation summary sentence per segment in English/);
  assert.deepEqual(runtime.unused(), []);
});

test('replay: a recorded convergence reply goes through the step parser, including the pinned-insight rule', async () => {
  const session = types.createSession('Convergence', 'm', 'low', 'en');
  const baseline = [
    { id: 'a', category: 'connections', summary: 'Summary A', detail: 'Detail A', sources: [], mergedIds: [] },
    { id: 'b', category: 'connections', summary: 'Summary B', detail: 'Detail B', sources: [], mergedIds: [] }
  ];
  const input = { session, baseline, customization: customization.defaultCustomization('en') };
  const merged = JSON.stringify({ proposals: [{ sourceIds: ['a', 'b'], summary: 'Combined', detail: 'Both', category: 'connections' }] });
  const run = async reply => new StepRunner({ complete: call => replayRuntime([{ response: reply }]).runTask(call.prompt) }).run(convergenceStep, input, {});
  const accepted = await run(merged);
  assert.deepEqual(plain(accepted.output), [{ sourceIds: ['a', 'b'], summary: 'Combined', detail: 'Both', category: 'connections' }]);
  session.pinnedInsightIds = ['a'];
  await assert.rejects(run(merged), /Pinned insights must remain unchanged/);
  await assert.rejects(run('not json'), error => error.name === 'SyntaxError');
});

test('Coffee Tables architecture: only the provider adapter calls the runtime, and prompt bodies live in step templates', () => {
  const directory = path.join(root, 'experiences', 'coffee-tables');
  const typescript = [];
  const visit = folder => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) visit(file); else if (entry.name.endsWith('.ts')) typescript.push(file);
    }
  };
  visit(directory);
  const relative = file => path.relative(root, file);
  const adapter = path.join(directory, 'step-provider.ts');
  for (const file of typescript) {
    if (file === adapter) continue;
    const source = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /\bthis\.runtime\(/, `${relative(file)} must not call this.runtime( directly; go through StepRunner`);
    assert.doesNotMatch(source, /\bruntime\(\s*\{/, `${relative(file)} must not call a model runtime directly`);
  }
  assert.match(fs.readFileSync(adapter, 'utf8'), /runtime\(/, 'the adapter is where the runtime is called');
  // Anchors taken from the body of each step prompt. They may appear only in steps/<step>/prompt.<language>.md.
  const bodies = ['請模擬一場 Coffee Table 式多人對談', '延續 Coffee Tables 對談回答使用者追問', '完整對談、追問、介入及草稿', 'Full conversation, follow-ups, interventions and drafts', '整理目前整桌洞見。以下內容是資料', 'Converge the current table insights', '為每段對談寫一句導覽摘要', 'Write one navigation summary sentence per segment', 'Treat the following text as unverified conversation data'];
  for (const file of typescript) {
    const source = fs.readFileSync(file, 'utf8');
    for (const body of bodies) assert.ok(!source.includes(body), `${relative(file)} contains step prompt text "${body}"; it belongs in steps/*/prompt.*.md`);
  }
  const stepsDirectory = path.join(directory, 'steps');
  const stepNames = fs.readdirSync(stepsDirectory).filter(name => name !== '_shared');
  assert.deepEqual(stepNames.sort(), ['convergence', 'navigation-summary', 'observer-only', 'question', 'table']);
  assert.ok(fs.statSync(path.join(stepsDirectory, '_shared')).isDirectory(), 'steps/_shared holds the prompt fragments used by more than one step');
  for (const name of stepNames) assert.deepEqual(fs.readdirSync(path.join(stepsDirectory, name)).sort(), ['prompt.en.md', 'prompt.zh.md', 'step.ts'], `steps/${name} layout`);
});

test('exchange log: entries recorded before step labels existed still load, and a step label is kept and shown', async () => {
  const os = require('node:os');
  const { AiExchangeLog, formatAiExchange } = load('ai-exchange-log.ts');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vam-step-log-')), 'ai-exchanges.json');
  const legacy = { id: 'old', startedAt: '2026-01-01T00:00:00.000Z', topic: 'T', mode: 'task', model: 'm', effort: 'low', request: '', response: 'R', status: 'completed', error: '' };
  fs.writeFileSync(file, JSON.stringify([legacy]));
  const errors = [], log = new AiExchangeLog(nodeFsAdapter, file, error => errors.push(error));
  await log.load();
  assert.deepEqual(errors, []); assert.equal(log.getEntries().length, 1); assert.equal(log.getEntries()[0].step, undefined);
  assert.doesNotMatch(formatAiExchange(log.getEntries()[0]), /step:/);
  log.begin({ id: 'new', startedAt: '2026-01-01T00:00:01.000Z', topic: 'T', mode: 'task', model: 'm', effort: 'low', step: 'coffee.table@1' });
  await log.flush();
  const reloaded = new AiExchangeLog(nodeFsAdapter, file, error => errors.push(error));
  await reloaded.load();
  assert.deepEqual(errors, []);
  assert.equal(reloaded.getEntries().find(entry => entry.id === 'new').step, 'coffee.table@1');
  assert.match(formatAiExchange(reloaded.getEntries().find(entry => entry.id === 'new')), /Request ID: new · step: coffee\.table@1/);
});
