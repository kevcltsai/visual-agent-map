// P2 (28): the ledger of two-map changes. Undo or redo asked from either map runs once; a broken change is refused.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, obsidian } = require('./support.cjs');
const mod = load('experiences/visual-map/cross-map-history.ts', { obsidian });
const { CrossMapLedger, ledgerFor, CROSS_MAP_HISTORY_LIMIT } = mod;
// The module runs in its own vm realm, so results are copied into this realm before deepEqual compares them.
const plain = value => JSON.parse(JSON.stringify(value));

const make = (log, over = {}) => ({ undo: async () => { log.push('undo'); }, redo: async () => { log.push('redo'); }, ...over });
const push = (ledger, id, log = [], paths = ['A/Map.md', 'B/Map.md'], over = {}) => ledger.push({ id, paths, entry: make(log, over) });
const gate = () => { let open; const promise = new Promise(r => { open = r; }); return { promise, open }; };

test('the limit is 20 and the 21st push evicts the oldest only', () => {
  assert.equal(CROSS_MAP_HISTORY_LIMIT, 20);
  const l = new CrossMapLedger();
  for (let i = 1; i <= 21; i++) assert.equal(push(l, `e${i}`), true);
  const ids = plain(l.entriesFor('A/Map.md')).map(e => e.id);
  assert.equal(ids.length, 20); assert.equal(ids[0], 'e2'); assert.equal(ids[19], 'e21');
  assert.equal(l.statusOf('e1'), undefined);
});
test('an evicted entry cannot be run', async () => {
  const l = new CrossMapLedger(); const log = [];
  push(l, 'old', log);
  for (let i = 0; i < 20; i++) push(l, `n${i}`);
  assert.deepEqual(plain(await l.run('old', 'undo')), { ran: false, reason: 'unknown' });
  assert.deepEqual(log, []);
});
test('eviction applies to any status, including a broken or undone one', async () => {
  const l = new CrossMapLedger();
  push(l, 'u'); await l.run('u', 'undo');
  for (let i = 0; i < 20; i++) push(l, `n${i}`);
  assert.equal(l.statusOf('u'), undefined);
});
test('undo then redo flip the status and call the handlers once each', async () => {
  const l = new CrossMapLedger(); const log = [];
  push(l, 'e', log);
  assert.equal(l.statusOf('e'), 'applied');
  assert.deepEqual(plain(await l.run('e', 'undo')), { ran: true, status: 'undone' });
  assert.deepEqual(plain(await l.run('e', 'redo')), { ran: true, status: 'applied' });
  assert.deepEqual(log, ['undo', 'redo']);
});
test('undo on an undone entry and redo on an applied entry are no-ops', async () => {
  const l = new CrossMapLedger(); const log = [];
  push(l, 'e', log);
  assert.equal((await l.run('e', 'redo')).ran, false); assert.equal(l.statusOf('e'), 'applied');
  await l.run('e', 'undo');
  const again = plain(await l.run('e', 'undo'));
  assert.deepEqual(again, { ran: false, reason: 'wrong-state', status: 'undone' });
  assert.deepEqual(log, ['undo']);
});
test('two runs of the same entry at the same time: the second is a no-op', async () => {
  const l = new CrossMapLedger(); const g = gate(); const log = [];
  push(l, 'e', log, undefined, { undo: async () => { log.push('undo-start'); await g.promise; log.push('undo-end'); } });
  const first = l.run('e', 'undo');
  const second = await l.run('e', 'undo');
  const third = await l.run('e', 'redo');
  assert.deepEqual(plain(second), { ran: false, reason: 'busy', status: 'applied' });
  assert.equal(third.ran, false);
  g.open();
  assert.equal((await first).ran, true);
  assert.deepEqual(log, ['undo-start', 'undo-end']);
  assert.equal(l.statusOf('e'), 'undone');
});
test('an entry is free to run again after the first run finishes', async () => {
  const l = new CrossMapLedger();
  push(l, 'e');
  await Promise.all([l.run('e', 'undo'), l.run('e', 'undo')]);
  assert.equal(l.statusOf('e'), 'undone');
  assert.equal((await l.run('e', 'redo')).ran, true);
});
test('a broken entry refuses undo and redo and never calls the handlers again', async () => {
  const l = new CrossMapLedger(); const log = [];
  push(l, 'e', log, undefined, { undo: async () => { log.push('undo'); throw Object.assign(new AggregateError([new Error('x')], 'rollback'), { kind: 'rollback-failed' }); } });
  const r = plain(await l.run('e', 'undo'));
  assert.equal(r.ran, false); assert.equal(r.reason, 'broken'); assert.equal(l.statusOf('e'), 'broken');
  assert.deepEqual(plain(await l.run('e', 'undo')), { ran: false, reason: 'broken', status: 'broken' });
  assert.deepEqual(plain(await l.run('e', 'redo')), { ran: false, reason: 'broken', status: 'broken' });
  assert.deepEqual(log, ['undo']);
});
test('a stale or guard throw leaves the entry applied and retryable; the error is returned', async () => {
  const l = new CrossMapLedger(); let fail = true;
  push(l, 'e', [], undefined, { undo: async () => { if (fail) throw Object.assign(new Error('changed'), { kind: 'stale' }); } });
  const r = await l.run('e', 'undo');
  assert.equal(r.ran, false); assert.equal(r.reason, 'failed'); assert.equal(r.error.message, 'changed');
  assert.equal(l.statusOf('e'), 'applied');
  fail = false;
  assert.equal((await l.run('e', 'undo')).ran, true);
});
test('a synchronous throw is handled the same way', async () => {
  const l = new CrossMapLedger();
  push(l, 'e', [], undefined, { undo: () => { throw new Error('sync'); } });
  assert.equal((await l.run('e', 'undo')).reason, 'failed');
  assert.equal(l.statusOf('e'), 'applied');
});
test('entriesFor lists, oldest first, only changes that touched the path, with their status', async () => {
  const l = new CrossMapLedger();
  push(l, 'ab', [], ['A/Map.md', 'B/Map.md']); push(l, 'bc', [], ['B/Map.md', 'C/Map.md']); push(l, 'ca', [], ['C/Map.md', 'A/Map.md']);
  await l.run('bc', 'undo');
  assert.deepEqual(plain(l.entriesFor('A/Map.md')).map(e => [e.id, e.status]), [['ab', 'applied'], ['ca', 'applied']]);
  assert.deepEqual(plain(l.entriesFor('B/Map.md')).map(e => [e.id, e.status]), [['ab', 'applied'], ['bc', 'undone']]);
  assert.deepEqual(plain(l.entriesFor('Z/Map.md')), []);
});
test('running from either map runs it once: the entry is the same for both paths', async () => {
  const l = new CrossMapLedger(); const log = [];
  push(l, 'ab', log);
  const fromA = l.entriesFor('A/Map.md')[0].id, fromB = l.entriesFor('B/Map.md')[0].id;
  const [r1, r2] = await Promise.all([l.run(fromA, 'undo'), l.run(fromB, 'undo')]);
  assert.deepEqual([r1.ran, r2.ran].sort(), [false, true]);
  assert.deepEqual(log, ['undo']);
});
test('a repeated id is refused and the original is kept; an unknown id is unknown', async () => {
  const l = new CrossMapLedger(); const log = [];
  assert.equal(push(l, 'e', log), true);
  assert.equal(push(l, 'e', ['other']), false);
  await l.run('e', 'undo');
  assert.deepEqual(log, ['undo']);
  assert.deepEqual(plain(await l.run('nope', 'undo')), { ran: false, reason: 'unknown' });
});
test('forget removes an entry; paths are copied, deduplicated and frozen', () => {
  const l = new CrossMapLedger(); const paths = ['A/Map.md', 'A/Map.md', 'B/Map.md'];
  l.push({ id: 'e', paths, entry: make([]) });
  paths.push('C/Map.md');
  assert.deepEqual(plain(l.entriesFor('A/Map.md'))[0].paths, ['A/Map.md', 'B/Map.md']);
  assert.deepEqual(plain(l.entriesFor('C/Map.md')), []);
  assert.equal(Object.isFrozen(l.entriesFor('A/Map.md')[0].paths), true);
  l.forget('e'); assert.equal(l.statusOf('e'), undefined);
});
test('ledgerFor gives one ledger per plugin object and refuses non-objects', () => {
  const p1 = {}, p2 = {};
  assert.equal(ledgerFor(p1), ledgerFor(p1)); assert.notEqual(ledgerFor(p1), ledgerFor(p2));
  push(ledgerFor(p1), 'e'); assert.equal(ledgerFor(p2).statusOf('e'), undefined);
  for (const bad of [null, undefined, 'x', 1]) assert.throws(() => ledgerFor(bad), { name: 'TypeError' });
});
