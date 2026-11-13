// The shared source exit (core/source-gateway.ts) with AiTaskService over a counting fake provider:
// full-request direct/condense boundary, condensing call cap, scrubbing of external roots, stop and read failure.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./support-replay.cjs');

const { AiTaskService } = load('core/ai-task-service.ts');
const gateway = load('core/source-gateway.ts');
const { scrubExternalPaths } = load('experiences/visual-map/external-sources.ts');
const { translate } = load('i18n.ts');

const finding = size => JSON.stringify({ summary: 'S', detail: 'e'.repeat(size), suggestions: [], visualReferences: [] });
const GOOD = JSON.stringify({ summary: 'S', detail: 'D', suggestions: [], visualReferences: [] });
const context = (extra = {}) => ({ title: 'Topic', summary: 'Sum', rules: '', detail: '', task: 'Do the task', ancestors: '', sourceContext: '', mode: 'merge', researchMode: 'local', researchDepth: 'fast', visualMode: 'off', ...extra });
const group = documents => ({ id: 'g', name: 'g', location: 'l', documents });
const doc = (path, size, fill = 'x') => ({ path, content: fill.repeat(size) });
const overBudget = translate('en', 'ui.source_context_exceeds_budget');

/** A service over a fake provider that counts every request; `reply(call)` answers or throws. */
function rig(reply = call => (call.prompt.includes('Extract relevant facts') ? finding(100) : GOOD)) {
  const calls = [];
  const runtime = { runTask: async (prompt, model, effort, schema, controls) => { const call = { prompt, n: calls.length + 1 }; calls.push(call); controls.onRequest?.({ n: call.n }); return reply(call); } };
  const service = new AiTaskService({
    pluginDirectory: () => '/plugin', language: () => 'en', defaultReasoning: () => 'low',
    exchangeLoggingEnabled: () => false, exchanges: () => null,
    codexRuntime: () => runtime, claudeRuntime: () => runtime
  });
  return { service, calls };
}
const ask = (h, extra, signal) => h.service.askModel(context(extra), 'gpt-6-luna', 'low', signal);

test('full-request boundary: a source that fits alone but not beside large rules is condensed, not sent whole', async () => {
  const groups = [group([doc('a.md', 100_000)])];
  const small = rig();
  await ask(small, { referenceGroups: groups, referenceDelivery: 'direct' });
  assert.equal(small.calls.length, 1, 'cards and rules fit: documents go in the one request');
  assert.ok(small.calls[0].prompt.includes('xxxxxxxxxxxxxxxx'));
  const rules = 'r'.repeat(100_000);
  const big = rig();
  await ask(big, { referenceGroups: groups, referenceDelivery: 'direct', rules });
  assert.equal(big.calls.length, 2, 'source alone is 25k tokens, with the 25k-token rules the request is over 48k: extract, then the task');
  assert.ok(big.calls[0].prompt.includes('Extract relevant facts'));
  assert.ok(!big.calls[1].prompt.includes('x'.repeat(50)), 'the condensed request no longer carries the raw documents');
});

test('planSourceDelivery counts cards, rules, task and the caller own source text, one token per 4 characters', () => {
  const groups = [group([doc('a.md', 4_000)])];
  const parts = { title: 't', summary: '', rules: '', detail: '', task: '', ancestors: '', mode: 'merge' };
  assert.equal(gateway.planSourceDelivery(groups, parts).kind, 'direct');
  assert.equal(gateway.planSourceDelivery(groups, { ...parts, detail: 'd'.repeat(4 * 48_000), workingFindings: 'w'.repeat(4 * 48_000) }).kind, 'direct', 'old detail and working findings are cut by the budget step before the sources');
  assert.equal(gateway.planSourceDelivery(groups, { ...parts, task: 'k'.repeat(4 * 48_000) }).kind, 'condense', 'the task text counts');
  assert.equal(gateway.planSourceDelivery(groups, { ...parts, summary: 's'.repeat(4 * 48_000) }).kind, 'condense', 'a card summary counts');
  assert.equal(gateway.planSourceDelivery(groups, { ...parts, subtreeOutline: 'o'.repeat(4 * 48_000) }).kind, 'condense', 'the outline shrinks the budget');
  assert.equal(gateway.planSourceDelivery([], parts).kind, 'none');
  assert.equal(gateway.planSourceDelivery(groups, parts, false).kind, 'condense', 'a caller that does not ask for direct always condenses');
});

test('condensing request count: extract + reduce are counted on the provider, the estimate is a worst case', async () => {
  const documents = [1, 2, 3].map(n => doc(`n${n}.md`, 100_000));
  const h = rig(call => (call.prompt.includes('Extract relevant facts') ? finding(9_001) : call.prompt.includes('Combine the supplied extracted evidence') ? finding(500) : GOOD));
  await ask(h, { mode: 'task', referenceGroups: [group(documents)] });
  assert.equal(h.calls.length, 5, '3 extract + 1 reduce + the task');
  assert.ok(gateway.estimateCondenseCalls([group(documents)]) >= 4);
  assert.equal(gateway.estimateCondenseCalls([group([doc('a.md', 10)])]), 1);
  assert.ok(gateway.estimateCondenseCalls([group(Array.from({ length: 9 }, (_, n) => doc(`n${n}.md`, 100_000)))]) <= gateway.MAX_CONDENSE_CALLS);
});

test('over the call cap: refused with the existing notice before any request is sent', async () => {
  const documents = Array.from({ length: 20 }, (_, n) => doc(`n${n}.md`, 100_000));
  assert.ok(gateway.estimateCondenseCalls([group(documents)]) > gateway.MAX_CONDENSE_CALLS);
  const h = rig();
  await assert.rejects(ask(h, { mode: 'task', referenceGroups: [group(documents)] }), error => error.message === overBudget);
  assert.equal(h.calls.length, 0);
  await assert.rejects(h.service.condenseReferences(context({ referenceGroups: [group(documents)] }), 'gpt-6-luna', 'low'), error => error.message === overBudget);
  assert.equal(h.calls.length, 0, 'the public condense refuses the same way');
});

test('a vault source quoting an external root is scrubbed (input path and realpath alias) before it is sent', async () => {
  const roots = ['/Users/me/Research', '/private/Users/me/Research'];
  const vault = { path: 'Notes/a.md', content: 'see /Users/me/Research/x.md and /private/Users/me/Research/y.md' };
  const groups = gateway.scrubReferenceGroups([group([vault, { path: 'ext/b.md', external: true, content: 'at /Users/me/Research' }])], text => scrubExternalPaths(text, roots));
  assert.ok(!JSON.stringify(groups).includes('/Users/me/Research'));
  assert.ok(!JSON.stringify(groups).includes('/private/Users/me'));
  assert.equal(vault.content.includes('/Users/me/Research'), true, 'the input is not mutated');
  const h = rig();
  await ask(h, { referenceGroups: groups, referenceDelivery: 'direct' });
  assert.equal(h.calls.length, 1);
  assert.ok(!h.calls[0].prompt.includes('/Users/me/Research') && !h.calls[0].prompt.includes('/private/Users'));
  assert.ok(h.calls[0].prompt.includes('[external folder]'));
});

test('a stop throws AbortError and reads and sends nothing; a read failure gives no sources', async () => {
  const stopped = new AbortController();
  stopped.abort();
  let reads = 0;
  await assert.rejects(gateway.readSourceGroups(async () => { reads++; return [group([doc('a.md', 5)])]; }, stopped.signal), error => error.name === 'AbortError');
  assert.equal(reads, 0);
  const late = new AbortController();
  await assert.rejects(gateway.readSourceGroups(async () => { late.abort(); throw new Error('boom'); }, late.signal), error => error.name === 'AbortError' || late.signal.aborted, 'a failure caused by the stop stays a stop');
  const named = Object.assign(new Error('x'), { name: 'AbortError' });
  await assert.rejects(gateway.readSourceGroups(async () => { throw named; }, new AbortController().signal), error => error === named);
  assert.equal(JSON.stringify(await gateway.readSourceGroups(async () => { throw new Error('unreadable'); }, new AbortController().signal)), '[]');
  const groups = [group([doc('a.md', 5)])];
  assert.equal(await gateway.readSourceGroups(async () => groups, new AbortController().signal), groups);
  const h = rig();
  await assert.rejects(h.service.condenseReferences(context({ referenceGroups: groups }), 'gpt-6-luna', 'low', stopped.signal), error => error.name === 'AbortError');
  assert.equal(h.calls.length, 0);
});

test('a condensing failure fails the task: no main request, no fallback to no sources', async () => {
  const h = rig(call => { throw new Error('provider down'); });
  await assert.rejects(ask(h, { mode: 'task', referenceGroups: [group([doc('a.md', 200_000)])] }), /provider down/);
  assert.equal(h.calls.length, 1, 'only the failed extraction was sent');
  const empty = rig(call => (call.prompt.includes('Extract relevant facts') ? finding(0) : GOOD));
  await assert.rejects(ask(empty, { mode: 'task', referenceGroups: [group([doc('a.md', 10)])] }));
  assert.equal(empty.calls.length, 1);
});

test('prepared findings skip extraction and keep the catalog from the groups', async () => {
  const groups = [group([doc('Notes/a.md', 100_000)])];
  const h = rig();
  const findings = await h.service.condenseReferences(context({ referenceGroups: groups }), 'gpt-6-luna', 'low');
  assert.equal(h.calls.length, 1);
  await ask(h, { mode: 'task', referenceGroups: groups, preparedReferenceFindings: findings });
  assert.equal(h.calls.length, 2, 'the task adds one request, no second extraction');
  assert.ok(h.calls[1].prompt.includes('[S1]') && h.calls[1].prompt.includes('Notes/a.md'), 'the catalog still names the source');
  assert.ok(h.calls[1].prompt.includes('Evidence:'));
});

test('batch sharing decided per child request: sources fit alone but not beside each child\'s content, three children, exactly one condensing', async () => {
  const groups = [group([doc('a.md', 150_000)])];
  const h = rig();
  const shared = gateway.sharedSourceFindings(3, signal => h.service.condenseReferences(context({ referenceGroups: groups }), 'gpt-6-luna', 'low', signal));
  const rules = 'r'.repeat(50_000);
  for (let child = 0; child < 3; child++) await ask(h, { referenceGroups: groups, referenceDelivery: 'direct', rules, sharedReferenceCondense: shared });
  assert.equal(h.calls.filter(call => call.prompt.includes('Extract relevant facts')).length, 1, 'one extraction for the batch');
  assert.equal(h.calls.length, 4, 'one condensing plus one task request per child');
  // A child whose own request fits sends the documents whole and never starts the condensing.
  const small = rig(); const lazy = gateway.sharedSourceFindings(3, signal => small.service.condenseReferences(context({ referenceGroups: [group([doc('a.md', 100_000)])] }), 'gpt-6-luna', 'low', signal));
  await ask(small, { referenceGroups: [group([doc('a.md', 100_000)])], referenceDelivery: 'direct', sharedReferenceCondense: lazy });
  assert.equal(small.calls.length, 1); assert.equal(gateway.sharedSourceFindings(1, async () => 'x'), undefined);
});
