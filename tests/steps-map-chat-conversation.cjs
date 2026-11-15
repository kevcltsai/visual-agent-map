// MapChatConversation (C3a): the plan flow on fake ports and a fake panel. No UI, no vault, no AI.
const { test } = require('node:test');
const strict = require('node:assert/strict');
// The module is loaded in its own vm realm: compare by value across realms.
const plain = value => JSON.parse(JSON.stringify(value));
const assert = Object.assign(Object.create(strict), { deepEqual: (a, b, m) => strict.deepEqual(plain(a), plain(b), m) });
const { load } = require('./support-replay.cjs');
const S = require('./support.cjs');

const { MapChatConversation } = load('experiences/visual-map/map-chat-conversation.ts', { obsidian: S.obsidian });

const ANCHOR = { path: 'Maps/A/Map.md', id: 'm1' };
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const act = {
  anchor: { kind: 'add_anchor', imageId: 'img', x: 1, y: 2, note: 'n', ref: 'r' },
  read: { kind: 'read_md_file', path: 'a.md' },
  child: { kind: 'add_child', parentId: 'a', title: 'T' },
  del: { kind: 'delete_topic', id: 'a' }
};
const resultOf = actions => ({ reply: 'r', actions, remaining: 'none' });
const planOf = (extra = {}) => ({ reasons: ['new_map'], estimatedCalls: 0, ...extra });

function rig(options = {}) {
  const log = [];
  const state = { closed: false, path: ANCHOR.path, map: { id: 'm1' }, shows: false, queued: false, ...options };
  const plans = new WeakMap();
  const panel = {
    isBusy: false, pending: null, settleReturn: undefined,
    pendingPlan() { return panel.pending; },
    settlePlan(card, st, lines) { log.push(['settlePlan', st, lines]); card.state = st; if (panel.pending === card) panel.pending = null; return panel.settleReturn; },
    showPlan(card) { log.push(['showPlan']); panel.pending = card; },
    setApplying(on) { log.push(['setApplying', on]); },
    hasQueuedSteers() { return state.queued; }
  };
  state.panel = panel;
  const applyCalls = [];
  const ports = {
    panel: () => state.panel, closed: () => state.closed, path: () => state.path, map: () => state.map,
    chain: () => ({
      interruptChain: (run, reason) => log.push(['interrupt', run, reason]),
      chainShows: run => { log.push(['chainShows']); return state.shows; },
      stopChainWork: run => log.push(['stopChainWork']),
      advanceChain: (run, round) => log.push(['advance', round])
    }),
    plans: () => plans,
    showPreview: (token, anchors) => log.push(['showPreview', token, anchors]),
    clearPreview: () => log.push(['clearPreview']),
    refTitles: actions => new Map(),
    actionLabel: action => `L:${action.kind}`,
    applyActions: (...args) => { applyCalls.push(args); return state.apply ? state.apply(...args) : Promise.resolve([{ status: 'done', text: 'ok' }]); },
    flushSteers: send => log.push(['flush', send])
  };
  const conv = new MapChatConversation(ports);
  const record = { calls: [], plan(...args) { record.calls.push(args); } };
  return { conv, state, panel, log, plans, record, applyCalls };
}
const names = log => log.map(entry => entry[0]);
const offer = (r, actions = [act.child], extra = {}) => {
  const result = resultOf(actions);
  r.conv.offerChatPlan(result, planOf(extra.plan), { selectedCount: 0 }, { ...ANCHOR }, 'msg', extra.record === undefined ? null : extra.record, extra.run === undefined ? null : extra.run);
  return { card: r.panel.pending, token: r.conv.planToken, result };
};

test('supersede without a pending card: token++ and clear only', () => {
  const r = rig();
  r.conv.supersedeChatPlan();
  assert.equal(r.conv.planToken, 1);
  assert.deepEqual(names(r.log), ['clearPreview']);
});

test('supersede with a pending card: cancelled in the panel and the record', () => {
  const r = rig();
  const { card } = offer(r, [act.child], { record: r.record });
  r.log.length = 0;
  r.conv.supersedeChatPlan();
  assert.equal(r.conv.planToken, 2);
  assert.deepEqual(names(r.log), ['clearPreview', 'settlePlan']);
  assert.equal(card.state, 'cancelled');
  assert.deepEqual(r.record.calls, [['cancelled']]);
});

test('offer: no panel does nothing and keeps the token', () => {
  const r = rig();
  r.state.panel = null;
  r.conv.offerChatPlan(resultOf([act.child]), planOf(), { selectedCount: 0 }, { ...ANCHOR }, 'm');
  assert.equal(r.conv.planToken, 0);
  assert.deepEqual(r.log, []);
});

test('offer: no add_anchor shows an empty preview; read_md_file is not an item; card fields', () => {
  const r = rig();
  const { card, token } = offer(r, [act.read, act.child, act.del], { plan: { reasons: ['image_preview', 'many_actions'], estimatedCalls: 3 } });
  assert.deepEqual(r.log[0], ['showPreview', 1, []]);
  assert.equal(token, 1);
  assert.deepEqual(card.items, ['L:add_child', 'L:delete_topic']);
  assert.equal(card.openGroups, true);
  assert.equal(card.state, 'pending');
  assert.equal(card.aiWork, false);
  assert.equal(card.reasons.length, 2);
  assert.ok(card.groups.some(group => group.danger), 'the delete group carries danger');
  assert.equal(card.estimate.includes('3'), true);
  assert.deepEqual(names(r.log), ['showPreview', 'showPlan']);
});

test('offer: add_anchor sends all anchors to the preview; aiWork follows run_map_action', () => {
  const r = rig();
  const second = { ...act.anchor, x: 5 };
  const { card } = offer(r, [act.anchor, second, { kind: 'run_map_action' }]);
  assert.equal(r.log[0][1], 1);
  assert.deepEqual(r.log[0][2], [{ imageId: 'img', x: 1, y: 2, note: 'n' }, { imageId: 'img', x: 5, y: 2, note: 'n' }]);
  assert.equal(card.aiWork, true);
  assert.equal(card.openGroups, undefined);
});

test('offer: the record is kept only when given; the reason text counts researchSoFar from the run', () => {
  const r = rig();
  const a = offer(r, [act.child]);
  assert.equal(r.plans.get(a.card), undefined);
  const b = offer(r, [act.child], { record: r.record, run: { state: { researchTargets: 7, round: 1 } }, plan: { reasons: ['many_research'] } });
  assert.equal(r.plans.get(b.card), r.record);
  assert.ok(b.card.reasons[0].includes('7'));
});

test('cancel: works only while the token is current; a second press interrupts the chain once', () => {
  const r = rig();
  const run = { state: { round: 1 } };
  const { card } = offer(r, [act.child], { record: r.record, run });
  r.log.length = 0;
  card.cancel();
  card.cancel();
  assert.deepEqual(names(r.log), ['clearPreview', 'settlePlan', 'interrupt']);
  assert.equal(r.log[2][2], 'plan_cancelled');
  assert.equal(r.conv.planToken, 2);
  assert.deepEqual(r.record.calls, [['cancelled']]);
  const again = offer(r);
  r.conv.planToken++;
  r.log.length = 0;
  again.card.cancel();
  assert.deepEqual(r.log, [], 'an old token does nothing');
});

for (const [name, setup] of [
  ['closed', r => { r.state.closed = true; }],
  ['busy', r => { r.panel.isBusy = true; }],
  ['applying', r => { r.conv.applying = true; }],
  ['stale token', r => { r.conv.planToken++; }],
  ['no panel', r => { r.state.panel = null; }]
]) {
  test(`apply is refused when ${name}: nothing is applied or settled`, async () => {
    const r = rig();
    const { card } = offer(r);
    r.log.length = 0;
    setup(r);
    await r.conv.applyChatPlan(card, 1, resultOf([act.child]), { selectedCount: 0 }, { ...ANCHOR });
    assert.equal(r.applyCalls.length, 0);
    assert.deepEqual(names(r.log), []);
    assert.equal(r.conv.applying, name === 'applying');
    assert.equal(r.panel.pending === null, false);
  });
}

for (const [name, change] of [['id', r => { r.state.map = { id: 'other' }; }], ['path', r => { r.state.path = 'Other.md'; }], ['no map', r => { r.state.map = null; }]]) {
  test(`apply when the map changed (${name}): map_changed with a skip line, no applyActions`, async () => {
    const r = rig();
    const run = { state: { round: 1 } };
    const { card, token, result } = offer(r, [act.child], { record: r.record, run });
    r.log.length = 0;
    change(r);
    await r.conv.applyChatPlan(card, token, result, { selectedCount: 0 }, { ...ANCHOR }, run);
    assert.equal(r.applyCalls.length, 0);
    assert.equal(r.conv.planToken, token + 1);
    assert.deepEqual(names(r.log), ['clearPreview', 'interrupt', 'settlePlan']);
    assert.equal(r.log[1][2], 'map_changed');
    assert.equal(r.log[2][1], 'cancelled');
    assert.equal(r.log[2][2][0].status, 'skipped');
    assert.deepEqual(r.record.calls, [['cancelled', r.log[2][2]]]);
    assert.equal(r.conv.applying, false);
  });
}

test('apply: panel order, applyActions arguments, run.work, merged lines to record and chain, flush(true)', async () => {
  const r = rig();
  const run = { state: { round: 2 }, work: null };
  const { card, token, result } = offer(r, [act.child], { record: r.record, run });
  const merged = [{ status: 'done', text: 'merged' }];
  r.panel.settleReturn = merged;
  const gate = deferred();
  r.state.apply = () => gate.promise;
  r.log.length = 0;
  const baseline = { selectedCount: 0, basis: 'b', parents: [] };
  const pending = r.conv.applyChatPlan(card, token, { ...result, message: 'msg' }, baseline, { ...ANCHOR }, run);
  assert.equal(r.conv.applying, true);
  assert.deepEqual(names(r.log), ['clearPreview', 'settlePlan', 'setApplying']);
  assert.equal(r.log[1][1], 'applied');
  assert.equal(r.log[2][1], true);
  const [res, base, alive, live, options] = r.applyCalls[0];
  assert.equal(res.message, 'msg');
  assert.equal(base, baseline);
  assert.equal(alive(), true);
  assert.deepEqual(live, ANCHOR);
  assert.equal(options.context, baseline);
  assert.equal(options.work, run.work);
  assert.equal(options.continuation, true);
  assert.equal(options.chain, run);
  gate.resolve([{ status: 'done', text: 'raw' }]);
  await pending;
  assert.equal(r.conv.applying, false);
  assert.deepEqual(names(r.log), ['clearPreview', 'settlePlan', 'setApplying', 'setApplying', 'settlePlan', 'advance', 'flush']);
  assert.equal(r.log[3][1], false);
  assert.deepEqual(r.log[4][2], [{ status: 'done', text: 'raw' }]);
  assert.deepEqual(r.record.calls, [['applied', merged]]);
  assert.equal(r.log[5][1].lines, merged);
  assert.equal(r.log[5][1].work, run.work);
  assert.deepEqual(r.log[6], ['flush', true]);
});

test('apply: round 1 is not a continuation; run null touches no chain port and no run.work', async () => {
  const r = rig();
  const { card, token, result } = offer(r, [act.child]);
  r.log.length = 0;
  await r.conv.applyChatPlan(card, token, result, { selectedCount: 0 }, { ...ANCHOR }, null);
  assert.equal(r.applyCalls[0][4].continuation, false);
  assert.equal(r.applyCalls[0][4].chain, null);
  assert.deepEqual(names(r.log).filter(n => ['interrupt', 'chainShows', 'stopChainWork', 'advance'].includes(n)), []);
  assert.deepEqual(r.log.at(-1), ['flush', true]);
});

test('settlePlan returning undefined keeps the original lines', async () => {
  const r = rig();
  const run = { state: { round: 1 } };
  const { card, token, result } = offer(r, [act.child], { record: r.record, run });
  const lines = [{ status: 'done', text: 'x' }];
  r.state.apply = () => Promise.resolve(lines);
  await r.conv.applyChatPlan(card, token, result, { selectedCount: 0 }, { ...ANCHOR }, run);
  assert.equal(r.record.calls[0][1], lines);
});

test('applyActions throws: one failed line, state recovered, round still finishes', async () => {
  const r = rig();
  const run = { state: { round: 1 } };
  const { card, token, result } = offer(r, [act.child], { record: r.record, run });
  r.state.apply = () => Promise.reject(new Error('boom'));
  await r.conv.applyChatPlan(card, token, result, { selectedCount: 0 }, { ...ANCHOR }, run);
  assert.equal(r.conv.applying, false);
  assert.deepEqual(r.record.calls[0][1], [{ status: 'failed', text: 'boom' }]);
  assert.deepEqual(r.log.filter(e => e[0] === 'setApplying').map(e => e[1]), [true, false]);
  assert.ok(names(r.log).includes('advance'));
});

test('applyActions throws a non-Error: its string is the text', async () => {
  const r = rig();
  const { card, token, result } = offer(r);
  r.state.apply = () => Promise.reject('plain');
  await r.conv.applyChatPlan(card, token, result, { selectedCount: 0 }, { ...ANCHOR });
  assert.equal(r.log.filter(e => e[0] === 'settlePlan').at(-1)[2][0].text, 'plain');
});

for (const shows of [true, false]) {
  test(`Stop mid-apply (chainShows ${shows}): alive false, record stopped, ${shows ? 'stopChainWork then ' : ''}interrupt stopped, flush(false)`, async () => {
    const r = rig({ shows });
    const run = { state: { round: 1 } };
    const { card, token, result } = offer(r, [act.child], { record: r.record, run });
    const gate = deferred();
    r.state.apply = () => gate.promise;
    r.log.length = 0;
    const pending = r.conv.applyChatPlan(card, token, result, { selectedCount: 0 }, { ...ANCHOR }, run);
    r.conv.planToken++;
    r.conv.planStopped = true;
    assert.equal(r.applyCalls[0][2](), false);
    gate.resolve([]);
    await pending;
    assert.equal(r.record.calls[0][0], 'stopped');
    const tail = names(r.log).slice(-(shows ? 5 : 4));
    assert.deepEqual(tail, shows ? ['settlePlan', 'chainShows', 'stopChainWork', 'interrupt', 'flush'] : ['settlePlan', 'chainShows', 'interrupt', 'flush']);
    assert.equal(r.log.find(e => e[0] === 'interrupt')[2], 'stopped');
    assert.deepEqual(r.log.at(-1), ['flush', false]);
    assert.equal(names(r.log).includes('advance'), false);
  });
}

test('planStopped is reset when a new apply starts', async () => {
  const r = rig();
  r.conv.planStopped = true;
  const { card, token, result } = offer(r, [act.child], { record: r.record });
  await r.conv.applyChatPlan(card, token, result, { selectedCount: 0 }, { ...ANCHOR });
  assert.equal(r.conv.planStopped, false);
  assert.equal(r.record.calls[0][0], 'applied');
});

test('closed when the apply ends: no settle, record, chain or flush; applying still cleared', async () => {
  const r = rig();
  const run = { state: { round: 1 } };
  const { card, token, result } = offer(r, [act.child], { record: r.record, run });
  const gate = deferred();
  r.state.apply = () => gate.promise;
  r.log.length = 0;
  const pending = r.conv.applyChatPlan(card, token, result, { selectedCount: 0 }, { ...ANCHOR }, run);
  r.state.closed = true;
  gate.resolve([]);
  await pending;
  assert.equal(r.conv.applying, false);
  assert.deepEqual(names(r.log), ['clearPreview', 'settlePlan', 'setApplying', 'setApplying']);
  assert.deepEqual(r.record.calls, []);
});

test('queued steers: user_took_over, no advance, flush(true)', async () => {
  const r = rig({ queued: true });
  const run = { state: { round: 1 } };
  const { card, token, result } = offer(r, [act.child], { run });
  r.log.length = 0;
  await r.conv.applyChatPlan(card, token, result, { selectedCount: 0 }, { ...ANCHOR }, run);
  assert.equal(r.log.find(e => e[0] === 'interrupt')[2], 'user_took_over');
  assert.equal(names(r.log).includes('advance'), false);
  assert.deepEqual(r.log.at(-1), ['flush', true]);
});

test('the card apply calls the instance applyChatPlan (a patch takes effect) with the message merged in', async () => {
  const r = rig();
  const calls = [];
  const run = { state: { round: 1 } };
  const { card, token, result } = offer(r, [act.child], { run });
  r.conv.applyChatPlan = (...args) => { calls.push(args); return Promise.resolve(); };
  card.apply();
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], card);
  assert.equal(calls[0][1], token);
  assert.equal(calls[0][2].message, 'msg');
  assert.equal(calls[0][5], run);
  assert.equal(r.applyCalls.length, 0);
});

test('ports are read at call time: a replaced panel is the one used', async () => {
  const r = rig();
  offer(r);
  const other = { ...r.panel, pendingPlan: () => null, settlePlan: () => { throw new Error('old panel used'); } };
  const swapped = [];
  other.settlePlan = (...args) => swapped.push(args);
  r.state.panel = other;
  r.conv.supersedeChatPlan();
  assert.deepEqual(swapped, [], 'no pending card on the new panel: nothing settled');
});
