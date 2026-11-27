// Living Node V1 A33: a card whose history grew keeps updating; the provider sees a bounded recent-first projection.
const assert = require('node:assert/strict');
const S = require('../support.cjs');
const { commitLivingMarkdown, livingSnapshotRevision, readLivingMarkdown } = S.load('experiences/visual-map/living-node-markdown.ts', { obsidian: S.obsidian });
const { generateLivingProposal } = S.load('experiences/visual-map/living-node-provider.ts', { obsidian: S.obsidian });
const { applyLivingChanges } = S.load('experiences/visual-map/living-node-changes.ts', { obsidian: S.obsidian });
const initial = '---\nagent-map-id: map\ntopic-id: map\nnode-id: card\nai-card: true\n---\n# Card\n';
const path = 'card.md';
const day = n => new Date(Date.UTC(2020, 0, 1 + n)).toISOString().slice(0, 10);
const append = n => ({ kind: 'append', id: 'r' + n, subject: 'subject ' + n, scope: 'scope', granularity: 'day', eventTime: day(n), claim: 'claim ' + n + ' ' + 'x'.repeat(300), evidence: ['e1'] });
const context = { at: '2026-11-27T04:00:00+08:00', evidence: [{ id: 'e1', source: 'https://example.com', retrievedAt: 't1' }] };

async function commit(f, base, operations) {
  const expectedContent = f.contents.get(path);
  const candidate = { executionId: 'x' + Math.random(), cardId: 'card', mapId: 'map', baseRevision: livingSnapshotRevision(expectedContent), inputRevision: 'i', viewSession: 'v' };
  return commitLivingMarkdown(f.repo, { path, expectedContent, candidate, base, proposal: { baseRevision: base.revision, operations }, context, signal: new AbortController().signal, isCurrent: () => true,
    inspect: async () => ({ ...candidate, locked: false, aborted: false, dependenciesReady: true, alreadyCommitted: false }) });
}
async function bigCard(count) {
  const f = S.fixture();
  await f.app.vault.create(path, initial);
  for (let from = 0; from < count; from += 100) {
    const base = readLivingMarkdown(f.contents.get(path));
    const ops = Array.from({ length: Math.min(100, count - from) }, (_, i) => append(from + i));
    assert.equal(await commit(f, base, ops), 'written');
  }
  return f;
}
// One formal round: the fake transport answers with `operations`; the production validator runs against the full base.
async function round(f, operations) {
  const base = readLivingMarkdown(f.contents.get(path));
  const sent = [];
  const calls = { run: async (prepared, options, finish) => {
    sent.push(prepared.prompt);
    return finish(JSON.stringify({ baseRevision: base.revision, requiresWeb: false, operations }), { signal: options.signal, parsed() {} });
  } };
  const generated = await generateLivingProposal(calls, { model: 'm', reasoning: 'auto', prompt: 'track', language: 'en', base, context: '{}', evidence: context.evidence, mapPath: 'map.md' }, new AbortController().signal);
  return { sent, base, generated };
}

S.integrationTest('Living Node A33: a card over 100k chars of records makes one bounded provider call, commits, and keeps every record', async () => {
  const f = await bigCard(320);
  const base = readLivingMarkdown(f.contents.get(path));
  assert.equal(base.records.length, 320);
  assert.ok(JSON.stringify(base).length > 100_000);
  const { sent, generated } = await round(f, [append(1000)]);
  assert.equal(sent.length, 1);
  assert.ok(sent[0].length <= 100_000);
  assert.ok(sent[0].includes('"id":"r319"') && !sent[0].includes('"id":"r0"'));
  assert.match(sent[0], /"omittedOlderRecords":\d+/);
  assert.equal(await commit(f, base, generated.proposal.operations), 'written');
  const after = readLivingMarkdown(f.contents.get(path));
  assert.equal(after.records.length, 321);
  assert.deepEqual(S.plain(after.records.slice(0, 320).map(r => r.id)), S.plain(base.records.map(r => r.id)));
});

S.integrationTest('Living Node A33: an unknown record is refused, a shown one is allowed, and a re-reported old event is a no-op', async () => {
  const f = await bigCard(320);
  const base = readLivingMarkdown(f.contents.get(path));
  const { sent } = await round(f, []);
  assert.ok(!sent[0].includes('"id":"r0"'));
  const ghost = { baseRevision: base.revision, operations: [{ kind: 'invalidate', id: 'nope', reason: 'why', evidence: ['e1'] }] };
  assert.throws(() => applyLivingChanges(base, ghost, context));
  await assert.rejects(() => round(f, [{ kind: 'invalidate', id: 'nope', reason: 'why', evidence: ['e1'] }]), /unknown|invalid|missing/i);
  const shown = await round(f, [{ kind: 'supplement', id: 'r319', evidence: ['e1'] }]);
  assert.equal(shown.generated.proposal.operations.length, 1);
  const again = applyLivingChanges(base, { baseRevision: base.revision, operations: [append(0)] }, context);
  assert.deepEqual(S.plain(again.records.map(r => r.id)), S.plain(base.records.map(r => r.id)));
  assert.equal(again.records.length, 320);
});

S.integrationTest('Living Node A33: ops on omitted records do not fail the round: supplement passes, correct is dropped with a count, other ops still commit', async () => {
  const f = await bigCard(320);
  const base = readLivingMarkdown(f.contents.get(path));
  const supp = await round(f, [{ kind: 'supplement', id: 'r0', evidence: ['e1'] }]);
  assert.equal(supp.generated.droppedOperations, 0);
  assert.equal(supp.generated.proposal.operations.length, 1);
  const mixed = await round(f, [{ kind: 'correct', id: 'r0', claim: 'rewritten', reason: 'why', evidence: ['e1'] }, { kind: 'dispute', id: 'r1', claim: 'c', reason: 'why', evidence: ['e1'] }, append(1000)]);
  assert.equal(mixed.generated.droppedOperations, 2);
  assert.deepEqual(S.plain(mixed.generated.proposal.operations.map(o => o.kind)), ['append']);
  assert.equal(await commit(f, base, mixed.generated.proposal.operations), 'written');
  assert.equal(readLivingMarkdown(f.contents.get(path)).records.length, 321);
});

S.integrationTest('Living Node A33: a recent record with no parseable time stays shown; the time boundary appears only when omitting', async () => {
  const f = await bigCard(320);
  const base = readLivingMarkdown(f.contents.get(path));
  await commit(f, base, [{ ...append(5000), id: 'undated', eventTime: null }]);
  const { sent } = await round(f, []);
  assert.ok(sent[0].includes('"id":"undated"'));
  assert.match(sent[0], /"oldestShownEventTime":"20\d\d-\d\d-\d\d"/);
  const small = await bigCard(3);
  assert.ok(!(await round(small, [])).sent[0].includes('oldestShownEventTime":'));
});
