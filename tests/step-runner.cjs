// Step Runner unit tests. Runner behaviour is tested with fake steps/providers.
const { test } = require('node:test');
const { nodeFsAdapter } = require('./support-fs-adapter.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { load } = require('./support-replay.cjs');

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
