// Stop semantics after AiTaskService moved onto AiCalls (ticket 04, accepted differences A6):
//  (a) main task / reference: a reply that arrives after the caller's stop is refused before `received`;
//  (b) chart: the same, with only failed("Aborted") written;
//  (c) log switched off after attempt 1: the re-asked attempt writes no begin and calls no onExchange.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./support-replay.cjs');

const { translate } = load('i18n.ts');
const { AiTaskService } = load('core/ai-task-service.ts');
const { searchNotPerformedError } = load('ai/search-not-performed.ts');

const GOOD = JSON.stringify({ summary: 'S', detail: 'D', suggestions: [], visualReferences: [] });
const context = (extra = {}) => ({ title: 'Topic', summary: 'Sum', rules: '', detail: '', task: 'Do the task', ancestors: '', sourceContext: '', mode: 'task', researchMode: 'local', researchDepth: 'fast', visualMode: 'off', ...extra });

function rig(handler, extra = {}) {
  const state = { logging: true, calls: 0 };
  const order = [];
  const log = {
    begin: entry => order.push(['begin', entry.id, entry]), sent: (id, body) => order.push(['sent', id, body]),
    received: (id, body) => order.push(['received', id, body]), milestones: id => order.push(['milestones', id]),
    parsed: id => order.push(['parsed', id]), completed: id => order.push(['completed', id]), failed: (id, error) => order.push(['failed', id, error])
  };
  const runtime = { runTask: async (prompt, model, effort, schema, controls) => { state.calls++; controls.onRequest?.({ via: 'fake' }); return handler(state.calls, controls); } };
  const service = new AiTaskService({
    pluginDirectory: () => '/plugin', language: () => 'en', defaultReasoning: () => 'low',
    exchangeLoggingEnabled: () => state.logging, exchanges: () => log,
    codexRuntime: () => runtime, claudeRuntime: () => runtime, ...extra
  });
  return { service, state, order, names: () => order.map(event => event[0]) };
}

test('A6(a) main task: a reply that resolves after the caller stopped is refused before received; failed starts with the waiting stage', async () => {
  const stop = new AbortController();
  const h = rig(() => { stop.abort(); return GOOD; });
  await assert.rejects(h.service.askModel(context(), 'gpt-6-luna', 'low', stop.signal), error => error.name === 'AbortError');
  assert.equal(h.names().filter(name => name === 'received').length, 0);
  const failed = h.order.filter(event => event[0] === 'failed');
  assert.equal(failed.length, 1);
  assert.ok(failed[0][2].startsWith(`${translate('en', 'log.stage_waiting_reply')}`), failed[0][2]);
});

test('A6(a) reference: the same stop on a reference round (no observer) is refused before received', async () => {
  const stop = new AbortController();
  const h = rig(() => { stop.abort(); return GOOD; });
  const request = context({ referenceGroups: [{ id: 'g', name: 'g', location: 'l', documents: [{ path: 'n1.md', content: 'x'.repeat(9_001) }] }] });
  await assert.rejects(h.service.askModel(request, 'gpt-6-luna', 'low', stop.signal), error => error.name === 'AbortError');
  assert.equal(h.names().filter(name => name === 'received').length, 0);
  const failed = h.order.filter(event => event[0] === 'failed');
  assert.equal(failed.length, 1);
  assert.ok(failed[0][2].startsWith(translate('en', 'log.stage_waiting_reply')), failed[0][2]);
});

test('A6(b) chart: a reply after the stop writes no received, exactly one failed(Aborted) and no completed', async () => {
  const stop = new AbortController();
  const h = rig(() => { stop.abort(); return JSON.stringify({ charts: [] }); }, { mermaidParses: async () => true });
  const note = 'The larva stage lasts 3 days at 25°C and reaches 160–180 mm.\n\nThe pupa stage lasts 5 days.';
  await assert.rejects(
    h.service.chartDetail({ input: context({ outputLanguage: 'en', addCharts: true, visualMode: 'auto' }), detail: note, model: 'gpt-6-luna', signal: stop.signal }),
    error => error.name === 'AbortError'
  );
  assert.equal(h.names().filter(name => name === 'received').length, 0);
  assert.equal(h.names().filter(name => name === 'completed').length, 0);
  const failed = h.order.filter(event => event[0] === 'failed');
  assert.equal(failed.length, 1);
  assert.match(failed[0][2], /^(AbortError: )?Aborted$/);
});

test('A6(c) logging switched off after attempt 1: the re-asked attempt writes no begin and calls no onExchange', async () => {
  const ids = [];
  const h = rig(count => { if (count === 1) { h.state.logging = false; throw searchNotPerformedError(); } return GOOD; });
  const result = await h.service.askModel(context({ researchMode: 'research' }), 'gpt-6-luna', 'low', undefined, id => ids.push(id));
  assert.equal(result.summary, 'S');
  assert.equal(h.state.calls, 2);
  assert.equal(h.names().filter(name => name === 'begin').length, 1);
  assert.equal(ids.length, 1);
});
