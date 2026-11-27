// Living Node V1 A33: a card whose history grew keeps updating; the provider sees a bounded recent-first projection.
const assert = require('node:assert/strict');
const S = require('../support.cjs');
const { commitLivingMarkdown, livingGeneration, livingSnapshotRevision, readLivingMarkdown } = S.load('experiences/visual-map/living-node-markdown.ts', { obsidian: S.obsidian });
const { generateLivingProposal } = S.load('experiences/visual-map/living-node-provider.ts', { obsidian: S.obsidian });
const { applyLivingChanges } = S.load('experiences/visual-map/living-node-changes.ts', { obsidian: S.obsidian });
const initial = '---\nagent-map-id: map\ntopic-id: map\nnode-id: card\nai-card: true\n---\n# Card\n';
const path = 'card.md';
const day = n => new Date(Date.UTC(2020, 0, 1 + n)).toISOString().slice(0, 10);
const append = n => ({ kind: 'append', id: 'r' + n, subject: 'subject ' + n, scope: 'scope', granularity: 'day', eventTime: day(n), claim: 'claim ' + n + ' ' + 'x'.repeat(300), evidence: ['e1'] });
const context = { at: '2026-11-27T04:00:00+08:00', evidence: [{ id: 'e1', source: 'https://example.com', retrievedAt: 't1' }] };

async function commit(f, base, operations, expected) {
  const expectedContent = expected ?? f.contents.get(path);
  const candidate = { executionId: 'x' + Math.random(), cardId: 'card', mapId: 'map', baseRevision: livingSnapshotRevision(expectedContent), inputRevision: 'i', viewSession: 'v' };
  return commitLivingMarkdown(f.repo, { path, expectedContent, candidate, base, baseGeneration: livingGeneration(expectedContent), proposal: { baseRevision: base.revision, operations }, context, signal: new AbortController().signal, isCurrent: () => true,
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
async function round(f, operations, echoed) {
  const base = readLivingMarkdown(f.contents.get(path));
  const sent = [];
  const calls = { run: async (prepared, options, finish) => {
    sent.push(prepared.prompt);
    return finish(JSON.stringify({ baseRevision: echoed ?? base.revision, requiresWeb: false, operations }), { signal: options.signal, parsed() {} });
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

const memBase = (count, mutate = () => ({})) => ({ revision: 'rev', suppressed: [], output: { text: '', owner: 'ai', evidence: [] },
  records: Array.from({ length: count }, (_, n) => ({ id: 'r' + n, subject: 's' + n, scope: 'sc', granularity: 'day', eventTime: day(n) + 'T00:00:00.000Z', claim: 'c' + n + ' ' + 'x'.repeat(300), evidence: [], validity: 'active', owner: 'ai', history: [], ...mutate(n) })) });
const sendOnce = async base => {
  const sent = [];
  const calls = { run: async (prepared, options, finish) => { sent.push(prepared.prompt); return finish(JSON.stringify({ baseRevision: base.revision, requiresWeb: false, operations: [] }), { signal: options.signal, parsed() {} }); } };
  await generateLivingProposal(calls, { model: 'm', reasoning: 'auto', prompt: 'track', language: 'en', base, context: '{}', evidence: [], mapPath: 'map.md' }, new AbortController().signal);
  return sent;
};

S.integrationTest('Living Node A33: the projected prompt never exceeds 100,000 chars however little room is left', async () => {
  for (let pad = 0; pad < 450; pad++) {
    const base = memBase(330, n => (n === 329 ? { claim: 'x'.repeat(300 + pad) } : {}));
    const sent = await sendOnce(base);
    assert.equal(sent.length, 1);
    assert.ok(sent[0].length <= 100_000, 'pad ' + pad + ' length ' + sent[0].length);
  }
});

S.integrationTest('Living Node A33: untimed records rank newest, then time descending, then insertion descending', async () => {
  const base = memBase(330, n => (n % 3 === 0 ? { eventTime: null } : {}));
  const shown = [...(await sendOnce(base))[0].matchAll(/"id":"r(\d+)"/g)].map(m => Number(m[1]));
  const untimed = Array.from({ length: 330 }, (_, n) => n).filter(n => n % 3 === 0);
  assert.ok(untimed.every(n => shown.includes(n)), 'all untimed shown ' + shown.length + ' ' + shown.slice(0, 5));
  const timedShown = shown.filter(n => n % 3 !== 0);
  assert.ok(timedShown.length > 0 && timedShown.length < 220);
  const cutoff = Math.min(...timedShown);
  assert.ok(Array.from({ length: 330 - cutoff }, (_, i) => cutoff + i).filter(n => n % 3 !== 0).every(n => shown.includes(n)), 'timed shown form a newest suffix');
});

S.integrationTest('Living Node A33: a wrong echoed baseRevision (a document hash) no longer fails the round, while a real concurrent edit is still refused', async () => {
  const f = await bigCard(3);
  const base = readLivingMarkdown(f.contents.get(path));
  const hash = 'a'.repeat(64);
  const { generated } = await round(f, [append(1000)], hash);
  assert.equal(generated.proposal.baseRevision, base.revision);
  const stale = f.contents.get(path);
  f.contents.set(path, stale + '\nOwner edit\n');
  const outcome = await commit(f, base, generated.proposal.operations, stale).catch(error => error.message);
  assert.notEqual(outcome, 'written');
  assert.ok(!f.contents.get(path).includes('r1000'));
});

S.integrationTest('A39 suppression v2: deleted-observation holds are never sent to the model; suppressed appends are dropped and counted', async () => {
  const { livingSuppressionV2, livingSuppressionV2Entry } = S.load('experiences/visual-map/living-node-changes.ts', { obsidian: S.obsidian });
  const gone = { id: 'gone', subject: 'stock', scope: 'price', granularity: 'day', eventTime: '2026-11-26', claim: 'SECRET-DELETED-TEXT', evidence: [], validity: 'active', owner: 'ai', history: [] };
  const base = { ...memBase(3), suppressed: ['legacy-only-id', livingSuppressionV2Entry(livingSuppressionV2(gone))] };
  for (const size of [3, 330]) {
    const b = size === 3 ? base : { ...memBase(330), suppressed: base.suppressed };
    const sent = (await sendOnce(b))[0];
    assert.ok(!/suppress|@v2|@event|legacy-only-id|SECRET-DELETED-TEXT/i.test(sent.replace(/Preserve|Deleted observations are held back locally[^.]*\./g, '')), 'size ' + size);
  }
  const alias = { kind: 'append', id: 'again', subject: 'Stock', scope: 'price', granularity: 'daily', eventTime: '2026-11-26T08:00:00+08:00', claim: 'reworded', evidence: ['e1'] };
  const fresh = { ...alias, id: 'fresh', eventTime: '2026-11-27' };
  const calls = { run: async (prepared, options, finish) => finish(JSON.stringify({ baseRevision: base.revision, requiresWeb: false, operations: [alias, fresh] }), { signal: options.signal, parsed() {} }) };
  const out = await generateLivingProposal(calls, { model: 'm', reasoning: 'auto', prompt: 'track', language: 'en', base, context: '{}', evidence: [{ id: 'e1', source: 'https://example.com', retrievedAt: 't' }], mapPath: 'map.md' }, new AbortController().signal);
  assert.equal(out.suppressedDropped, 1);
  assert.deepEqual(S.plain(out.proposal.operations.map(o => o.id)), ['fresh']);
});
