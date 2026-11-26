const { test } = require('node:test');
const assert = require('node:assert/strict');
const { applyLivingChanges } = require('./support.cjs').load('experiences/visual-map/living-node-changes.ts');
const e = (id, retrievedAt = 't1') => ({ id, source: 'source:' + id, retrievedAt });
const context = { at: 't2', evidence: [e('e1', 't2'), e('e2')] };
const record = (extra = {}) => ({ id: 'r1', subject: 'stock', scope: 'price', granularity: 'daily', eventTime: '2026-11-26', claim: '100', evidence: [e('e1')], validity: 'active', owner: 'ai', history: [], ...extra });
const base = (extra = {}) => ({ revision: 'base', records: [record()], suppressed: [], output: { text: 'summary', owner: 'ai', evidence: [e('e1')] }, ...extra });
const proposal = (...operations) => ({ baseRevision: 'base', operations });
const apply = (b, ...operations) => applyLivingChanges(b, proposal(...operations), context);
const plain = value => JSON.parse(JSON.stringify(value));

test('change set: repeated evidence is no-op and does not replace original retrieval time', () => {
  const original = base();
  const result = apply(original, { kind: 'supplement', id: 'r1', evidence: ['e1', 'e1'] });
  assert.equal(result.changed, false);
  assert.deepEqual(plain(result.records), original.records);
  assert.equal(apply(original, { kind: 'output', text: 'summary', evidence: ['e1'] }).changed, false);
});

test('change set: new evidence supplements a record; correction preserves previous value and provenance', () => {
  const original = base();
  const result = apply(original, { kind: 'correct', id: 'r1', claim: '105', reason: 'corrected close', evidence: ['e2'] });
  assert.equal(result.changed, true);
  assert.equal(result.records[0].claim, '105');
  assert.equal(result.records[0].history[0].claim, '100');
  assert.deepEqual(plain(result.records[0].history[0].previousEvidence), [e('e1')]);
  assert.deepEqual(plain(result.records[0].evidence), [e('e1'), e('e2')]);
  assert.equal(original.records[0].claim, '100');
  assert.equal(apply(original, { kind: 'supplement', id: 'r1', evidence: ['e2'] }).records[0].evidence.length, 2);
});

test('change set: dispute and invalidation preserve original claim and never delete records', () => {
  const disputed = apply(base(), { kind: 'dispute', id: 'r1', claim: '101', reason: 'conflicting report', evidence: ['e2'] });
  assert.equal(disputed.records[0].claim, '100');
  assert.equal(disputed.records[0].validity, 'disputed');
  assert.equal(disputed.records[0].history[0].claim, '101');
  const invalidated = apply(base(), { kind: 'invalidate', id: 'r1', reason: 'withdrawn', evidence: ['e2'] });
  assert.equal(invalidated.records[0].validity, 'invalidated');
  assert.equal(invalidated.records[0].claim, '100');
});

test('change set: new time bucket remains distinct even when the value is unchanged', () => {
  const op = { kind: 'append', id: 'r2', subject: 'stock', scope: 'price', granularity: 'daily', eventTime: '2026-11-27', claim: '100', evidence: ['e2'] };
  const result = apply(base(), op);
  assert.equal(result.records.length, 2);
  assert.equal(result.records[1].eventTime, '2026-11-27');
  assert.throws(() => apply(base(), { ...op, id: 'r1' }), /existing-record/);
  assert.throws(() => apply(base({ suppressed: ['r2'] }), op), /suppressed-record/);
});

test('change set: rejects protected records, protected summaries, unknown fields and forged evidence', () => {
  const correct = { kind: 'correct', id: 'r1', claim: '105', reason: 'correction', evidence: ['e2'] };
  assert.throws(() => apply(base({ records: [record({ owner: 'user' })] }), correct), /protected-record/);
  assert.throws(() => apply(base({ output: { text: 'manual', owner: 'user', evidence: [] } }), { kind: 'output', text: 'replacement', evidence: [] }), /protected-output/);
  assert.throws(() => apply(base(), { ...correct, evidence: ['forged'] }), /unauthorized-evidence/);
  assert.throws(() => apply(base(), { ...correct, targetCard: 'other' }), /unknown-field/);
  assert.throws(() => apply(base(), { ...correct, id: 'missing' }), /unknown-record/);
  assert.throws(() => apply(base(), { ...correct, evidence: [] }), /missing-evidence/);
  assert.throws(() => apply(base(), { ...correct, evidence: ['e1'] }), /missing-new-evidence/);
  assert.throws(() => apply(base(), { kind: 'delete', id: 'r1' }), /unknown-operation/);
});

test('change set: a rejected late operation leaves the entire base unchanged', () => {
  const original = base();
  const before = JSON.stringify(original);
  assert.throws(() => apply(original, { kind: 'supplement', id: 'r1', evidence: ['e2'] }, { kind: 'delete', id: 'r1' }));
  assert.equal(JSON.stringify(original), before);
  assert.throws(() => applyLivingChanges(original, { ...proposal(), baseRevision: 'old' }, context), /stale-base/);
  assert.throws(() => applyLivingChanges(original, null, context), /invalid-change/);
});

test('change set: same event with another ID merges new evidence instead of appending', () => {
  const op = { kind: 'append', id: 'different-id', subject: 'stock', scope: 'price', granularity: 'daily', eventTime: '2026-11-26', claim: '100', evidence: ['e2'] };
  const result = apply(base(), op);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].id, 'r1');
  assert.equal(result.records[0].evidence.length, 2);
  assert.equal(apply(base(), { ...op, evidence: ['e1'] }).changed, false);
  assert.throws(() => apply(base(), { ...op, claim: '101' }), /period-conflict-requires-correction/);
});

test('change set: repeated change observations are no-op but hourly samples and a return to an old value stay distinct', () => {
  const op = (id, time, claim, granularity) => ({ kind: 'append', id, subject: 'stock', scope: 'price', granularity, eventTime: time, claim, evidence: ['e1'] });
  const emptyBase = base({ records: [] });
  const observations = ['09:00', '10:00', '11:00', '12:00', '13:30'].map((time, i) => [time, ['100', '100', '105', '103', '108'][i]]);
  const changes = apply(emptyBase, ...observations.map(([time, claim], i) => op('c' + i, '2026-11-26T' + time + ':00+08:00', claim, 'change')));
  const hourly = apply(emptyBase, ...observations.map(([time, claim], i) => op('h' + i, '2026-11-26T' + time + ':00+08:00', claim, 'hourly')));
  assert.equal(changes.records.length, 4);
  assert.equal(hourly.records.length, 5);
  const returnValue = apply({ ...emptyBase, records: changes.records }, op('c5', '2026-11-26T14:00:00+08:00', '100', 'change'));
  assert.equal(returnValue.records.length, 5);
});

test('change set: late historical observations do not become the latest change', () => {
  const op = (id, time, claim) => ({
    kind: 'append', id, subject: 'stock', scope: 'price', granularity: 'change',
    eventTime: '2026-11-26T' + time + ':00+08:00', claim, evidence: ['e1']
  });
  const original = base({ records: [] });
  const first = apply(original, op('r09', '09:00', '100'), op('r13', '13:00', '108'), op('r11', '11:00', '105'));
  assert.equal(first.records.length, 3);
  const withBackfill = { ...original, records: first.records };
  const unchanged = apply(withBackfill, op('r14', '14:00', '108'));
  assert.equal(unchanged.changed, false);
  assert.deepEqual(plain(unchanged.records), plain(first.records));
  const changed = apply(withBackfill, op('r14', '14:00', '105'));
  assert.equal(changed.changed, true);
  assert.equal(changed.records.length, 4);
  const intermediate = apply(withBackfill, op('r12', '12:00', '105'));
  assert.equal(intermediate.changed, false);
});
