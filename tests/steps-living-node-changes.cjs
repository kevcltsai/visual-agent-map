const { test } = require('node:test');
const assert = require('node:assert/strict');
const { applyLivingChanges, hasLivingResult, livingEventFingerprint, livingEventScopeFingerprint, livingEventTombstone, livingSuppressionV2, livingSuppressionV2Entry, parseLivingSuppressionV2, livingAppendSuppressed, livingLegacySuppressionIds, livingAiLatestBlocked } = require('./support.cjs').load('experiences/visual-map/living-node-changes.ts');
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
  assert.deepEqual(plain(result.records[0].evidence), [e('e2')]);
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
  // T06: a user-owned output is no longer a reason to reject; the AI result goes to aiLatest and the user text is kept.
  assert.equal(apply(base({ output: { text: 'manual', owner: 'user', evidence: [] } }), { kind: 'output', text: 'replacement', evidence: [] }).output.text, 'manual');
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

test('change set: empty knowledge cannot be successful even when it has a stored revision', () => {
  for (const revision of ['empty', 'stored-revision']) {
    for (const text of ['', ' \n ']) {
      const original = base({ revision, records: [], output: { text, owner: 'user', evidence: [e('e1')] } });
      assert.equal(hasLivingResult(original), false);
      assert.throws(() => applyLivingChanges(original, { baseRevision: revision, operations: [] }, context), /missing-formal-result/);
    }
  }
  const blankClaim = base({ records: [record({ claim: '   ', owner: 'user' })], output: { text: '', owner: 'ai', evidence: [] } });
  assert.equal(hasLivingResult(blankClaim), false);
  assert.throws(() => apply(blankClaim), /missing-formal-result/);
});

test('change set: explicit no-match and observation-only results remain usable; repeats remain no-change', () => {
  const original = base({ records: [], output: { text: '', owner: 'ai', evidence: [] } });
  const result = apply(original, { kind: 'output', text: 'No matching observations found.', evidence: ['e1'] });
  assert.equal(hasLivingResult(result), true);
  assert.equal(result.changed, true);
  assert.equal(apply({ ...original, output: result.output }).changed, false);
  const observations = base({ output: { text: '', owner: 'ai', evidence: [] } });
  assert.equal(hasLivingResult(observations), true);
  assert.equal(apply(observations).changed, false);
});

test('change set: current evidence is explicitly selected, not inherited from replaced claim', () => {
  const result = apply(base(), { kind: 'output', text: 'Revised answer', evidence: ['e2'] });
  assert.deepEqual(plain(result.output.evidence), [e('e2')]);
  const retained = apply(base(), { kind: 'output', text: 'Related answer', evidence: ['e1'] });
  assert.deepEqual(plain(retained.output.evidence), [e('e1')]);
  const disputed = apply(base(), { kind: 'dispute', id: 'r1', claim: '101', reason: 'conflict', evidence: ['e2'] });
  assert.deepEqual(plain(disputed.records[0].evidence), [e('e1')]);
  assert.deepEqual(plain(disputed.records[0].history[0].evidence), [e('e2')]);
  const withdrawn = apply(base(), { kind: 'invalidate', id: 'r1', reason: 'withdrawn', evidence: ['e2'] });
  assert.deepEqual(plain(withdrawn.records[0].evidence), [e('e1')]);
  assert.throws(() => apply({ ...base(), records: withdrawn.records }, { kind: 'append', id: 'different', subject: 'stock', scope: 'price', granularity: 'daily', eventTime: '2026-11-26', claim: '100', evidence: ['e2'] }), /inactive-record/);
});
test('change set: suppression survives new record ID, value and day alias; unrelated dates remain possible', () => {
  const old = record();
  const tombstone = livingEventTombstone(old.id, livingEventFingerprint(old), livingEventScopeFingerprint(old), false);
  const b = base({ records: [], suppressed: ['r1', tombstone] });
  const op = { kind: 'append', id: 'r2', subject: 'Stock', scope: 'price', granularity: 'day', eventTime: '2026-11-26', claim: '105', evidence: ['e2'] };
  assert.throws(() => apply(b, op), /suppressed-record/);
  assert.throws(() => apply(b, { ...op, eventTime: null }), /ambiguous-suppression/);
  assert.equal(apply(b, { ...op, eventTime: '2026-11-27' }).records.length, 1);
  assert.equal(apply(b, { ...op, scope: 'dividend' }).records.length, 1);
  const unknown = record({ eventTime: null, granularity: 'event' });
  const ub = base({ records: [], suppressed: ['r1', livingEventTombstone(unknown.id, livingEventFingerprint(unknown), livingEventScopeFingerprint(unknown), true)] });
  assert.throws(() => apply(ub, { ...op, eventTime: '2026-11-27' }), /ambiguous-suppression/);
});

test('A08: re-querying an already recorded change observation under a new ID is a no-op, not a fifth record', () => {
  const op = (id, time, claim) => ({ kind: 'append', id, subject: 'stock', scope: 'price', granularity: 'change', eventTime: '2026-11-26T' + time + ':00+08:00', claim, evidence: ['e1'] });
  const first = apply(base({ records: [] }), op('c0', '09:00', '100'), op('c1', '11:00', '105'));
  const again = apply(base({ records: first.records }), op('requery-a', '11:00', '105'), op('requery-b', '12:00', '105'));
  assert.equal(again.changed, false);
  assert.equal(again.records.length, 2);
  assert.deepEqual(plain(again.records), plain(first.records));
});

const v2 = r => livingSuppressionV2Entry(livingSuppressionV2(r));
const appendOp = (extra = {}) => ({ kind: 'append', id: 'r2', subject: 'stock', scope: 'price', granularity: 'daily', eventTime: '2026-11-26', claim: '105', evidence: ['e2'], ...extra });

test('A39 suppression v2: same event under a new id, wording, scope punctuation, time form or source stays suppressed', () => {
  const b = base({ records: [], suppressed: [v2(record())] });
  for (const extra of [{}, { id: 'brand-new' }, { claim: 'reworded' }, { evidence: ['e1'] }, { subject: 'STOCK', scope: 'Price.' }, { scope: '  price  ' }, { granularity: 'day' }, { eventTime: '2026-11-26T09:30:00+08:00' }, { eventTime: '2026-11-26T20:00:00Z' }])
    assert.throws(() => apply(b, appendOp(extra)), /suppressed-record/, JSON.stringify(extra));
  assert.equal(apply(b, appendOp({ eventTime: '2026-11-27' })).records.length, 1);
  assert.equal(apply(b, appendOp({ scope: 'dividend' })).records.length, 1);
  assert.throws(() => apply(b, appendOp({ eventTime: null })), /ambiguous-suppression/);
});

test('A39 suppression v2: unknown-time hold blocks the whole scope, a month period matches any day in it', () => {
  const unknown = record({ eventTime: null, granularity: 'event' });
  assert.throws(() => apply(base({ records: [], suppressed: [v2(unknown)] }), appendOp({ eventTime: '2026-11-27' })), /ambiguous-suppression/);
  const month = record({ granularity: 'monthly', eventTime: '2026-11-01' });
  const b = base({ records: [], suppressed: [v2(month)] });
  assert.throws(() => apply(b, appendOp({ granularity: 'month', eventTime: '2026-11-30' })), /suppressed-record/);
  assert.equal(apply(b, appendOp({ granularity: 'month', eventTime: '2026-12-01' })).records.length, 1);
});

test('A39 suppression v2: entries are strict, canonical and carry no claim text', () => {
  const entry = v2(record());
  assert.deepEqual(plain(parseLivingSuppressionV2(entry)), plain(livingSuppressionV2(record())));
  assert.equal(entry.includes('100'), false);
  for (const bad of ['@v2:', '@v2:[2,"event"]', entry.replace('[2,', '[3,'), entry + ' ', '@v2:[2,"event","x","2026",null]'])
    assert.equal(parseLivingSuppressionV2(bad), undefined, bad);
});

test('A39 legacy: id-only tombstone matches only its own id, unrelated append works and is listed for diagnostics', () => {
  const b = base({ records: [], suppressed: ['legacy-id'] });
  assert.equal(apply(b, appendOp()).records.length, 1);
  assert.throws(() => apply(b, appendOp({ id: 'legacy-id' })), /suppressed-record/);
  assert.deepEqual(plain(livingLegacySuppressionIds(b)), ['legacy-id']);
});

test('A39 legacy: v1 fingerprints are dual-read and v1 and v2 entries coexist byte-identical', () => {
  const old = record();
  const tombstone = livingEventTombstone(old.id, livingEventFingerprint(old), livingEventScopeFingerprint(old), false);
  const other = record({ id: 'r9', scope: 'dividend' });
  const b = base({ records: [], suppressed: ['r1', tombstone, v2(other)] });
  assert.throws(() => apply(b, appendOp({ subject: 'Stock', granularity: 'day' })), /suppressed-record/);
  assert.throws(() => apply(b, appendOp({ scope: 'dividend' })), /suppressed-record/);
  assert.equal(apply(b, appendOp({ eventTime: '2026-11-27' })).records.length, 1);
  assert.deepEqual(plain(b.suppressed), ['r1', tombstone, v2(other)]);
});

test('A39: livingAppendSuppressed reports only appends the holds reject', () => {
  const b = base({ records: [], suppressed: [v2(record())] });
  assert.equal(livingAppendSuppressed(b, appendOp()), true);
  assert.equal(livingAppendSuppressed(b, appendOp({ eventTime: '2026-11-27' })), false);
  assert.equal(livingAppendSuppressed(b, { kind: 'supplement', id: 'r1', evidence: ['e1'] }), false);
  assert.equal(livingAppendSuppressed(b, { kind: 'append' }), false);
});

test('A39 suppression v2: period truncates on the wall-clock time in its own offset; week is ISO, quarter and year bucket', () => {
  const key = (granularity, eventTime) => livingSuppressionV2(record({ granularity, eventTime })).periodKey;
  assert.equal(key('day', '2026-11-26T23:30:00-05:00'), '2026-11-26');
  assert.equal(key('day', '2026-11-26T23:30:00+08:00'), '2026-11-26');
  assert.equal(key('day', '2026-11-26'), '2026-11-26');
  assert.equal(key('hour', '2026-11-26T09:30:00+08:00'), '2026-11-26T09');
  assert.equal(key('week', '2026-11-26'), '2026-W48');
  assert.equal(key('week', '2026-01-01'), '2026-W01');
  assert.equal(key('week', '2027-01-01'), '2026-W53');
  assert.equal(key('weekly', '2026-12-31T10:00:00Z'), '2026-W53');
  assert.equal(key('quarter', '2026-11-26'), '2026-Q4');
  assert.equal(key('quarterly', '2026-03-31'), '2026-Q1');
  assert.equal(key('year', '2026-11-26T10:00:00+08:00'), '2026');
  const b = base({ records: [], suppressed: [v2(record({ granularity: 'week', eventTime: '2026-11-23' }))] });
  assert.throws(() => apply(b, appendOp({ granularity: 'weekly', eventTime: '2026-11-29' })), /suppressed-record/);
  assert.equal(apply(b, appendOp({ granularity: 'weekly', eventTime: '2026-11-30' })).records.length, 1);
  const q = base({ records: [], suppressed: [v2(record({ granularity: 'quarter', eventTime: '2026-10-01' }))] });
  assert.throws(() => apply(q, appendOp({ granularity: 'quarterly', eventTime: '2026-12-31' })), /suppressed-record/);
  assert.equal(apply(q, appendOp({ granularity: 'quarterly', eventTime: '2027-01-01' })).records.length, 1);
});

test('T06: with a user-owned output an output op updates aiLatest, never the user text and never rejects the proposal', () => {
  const user = base({ output: { text: 'manual', owner: 'user', evidence: [] } });
  const result = apply(user, { kind: 'output', text: 'ai answer', evidence: ['e1'] }, { kind: 'supplement', id: 'r1', evidence: ['e2'] });
  assert.equal(result.changed, true);
  assert.equal(result.output.text, 'manual');
  assert.equal(result.output.owner, 'user');
  assert.deepEqual(plain(result.aiLatest), { text: 'ai answer', owner: 'ai', at: 't2', evidence: [e('e1', 't2')] });
  assert.equal(result.records[0].evidence.length, 2);
  assert.equal(user.aiLatest, undefined);
});

test('T06: aiLatest is replaced as a unit, an identical result is a no-op that keeps its time, an edited one is dropped with a warning and never rejects the proposal', () => {
  const user = base({ output: { text: 'manual', owner: 'user', evidence: [] }, aiLatest: { text: 'old', owner: 'ai', at: 't0', evidence: [e('e1', 't0')] } });
  const same = apply(user, { kind: 'output', text: 'old', evidence: ['e1'] });
  assert.equal(same.changed, false);
  assert.equal(same.aiLatest.at, 't0');
  const next = apply(user, { kind: 'output', text: 'new', evidence: ['e2'] });
  assert.deepEqual(plain(next.aiLatest), { text: 'new', owner: 'ai', at: 't2', evidence: [e('e2')] });
  const edited = base({ output: { text: 'manual', owner: 'user', evidence: [] }, aiLatest: { text: 'edited', owner: 'user', at: 't0', evidence: [] } });
  const dropped = apply(edited, { kind: 'output', text: 'x', evidence: [] }, { kind: 'supplement', id: 'r1', evidence: ['e2'] });
  assert.deepEqual(plain(dropped.warnings), ['ai-latest-user-edited']);
  assert.equal(dropped.aiLatest.text, 'edited');
  assert.equal(dropped.records[0].evidence.length, 2);
  assert.equal(apply(edited, { kind: 'output', text: 'x', evidence: [] }).changed, false);
});

test('T06: an owner:ai output is replaced in place and no aiLatest appears; aiLatest alone counts as a result', () => {
  const result = apply(base(), { kind: 'output', text: 'replaced', evidence: ['e1'] });
  assert.equal(result.output.text, 'replaced');
  assert.equal(result.aiLatest, undefined);
  assert.equal(hasLivingResult({ records: [], output: { text: '', owner: 'user', evidence: [] }, aiLatest: { text: 'x', owner: 'ai', at: 't', evidence: [] } }), true);
  assert.equal(hasLivingResult({ records: [], output: { text: '', owner: 'user', evidence: [] } }), false);
});

test('T06: an AI latest the owner deleted is not rewritten with the same text; a different text creates it and clears the memory', () => {
  const sha = require('node:crypto').createHash('sha256').update('same text').digest('hex');
  const gone = base({ output: { text: 'manual', owner: 'user', evidence: [] }, aiLatestDeleted: sha });
  const same = apply(gone, { kind: 'output', text: 'same text', evidence: ['e1'] });
  assert.deepEqual(plain(same.warnings), ['ai-latest-deleted']);
  assert.equal(same.aiLatest, undefined);
  assert.equal(same.aiLatestDeleted, sha);
  assert.equal(same.changed, false);
  const other = apply(gone, { kind: 'output', text: 'other text', evidence: ['e1'] });
  assert.equal(other.aiLatest.text, 'other text');
  assert.equal(other.aiLatestDeleted, undefined);
  assert.deepEqual(plain(other.warnings), []);
  assert.deepEqual(plain(livingAiLatestBlocked(gone, 'same text')), 'ai-latest-deleted');
});
