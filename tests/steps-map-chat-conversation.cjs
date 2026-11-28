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
    hasQueuedSteers() { return state.queued; },
    refreshPlan() { log.push(['refreshPlan']); }
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
    applyBlock: () => state.block ?? null, mergeBlock: () => null, targetStamps: async () => ({}),
    refTitles: actions => new Map(),
    actionLabel: action => `L:${action.kind}`,
    applyActions: (...args) => { applyCalls.push(args); return state.apply ? state.apply(...args) : Promise.resolve([{ status: 'done', text: 'ok' }]); }
  };
  const conv = new MapChatConversation(ports);
  conv.flushSteers = send => log.push(['flush', send]);
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
  await new Promise(done => setImmediate(done)); // the targets are compared before the write
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

test('apply: the selection snapshot in the baseline reaches applyActions unchanged', async () => {
  const r = rig();
  const { card, token, result } = offer(r, [act.child]);
  const baseline = { selectedCount: 2, selectedIds: ['a', 'b'] };
  await r.conv.applyChatPlan(card, token, result, baseline, { ...ANCHOR }, null);
  assert.equal(r.applyCalls.length, 1);
  strict.equal(r.applyCalls[0][1], baseline);
  assert.deepEqual(r.applyCalls[0][1].selectedIds, ['a', 'b']);
});

test('a plan that partly failed is not written again by a second Apply with the same card and token', async () => {
  const r = rig();
  const { card, token, result } = offer(r, [act.child, act.child]);
  r.state.apply = () => Promise.resolve([{ status: 'done', text: 'one' }, { status: 'failed', text: 'two' }]);
  await r.conv.applyChatPlan(card, token, result, { selectedCount: 0 }, { ...ANCHOR }, null);
  await r.conv.applyChatPlan(card, token, result, { selectedCount: 0 }, { ...ANCHOR }, null);
  assert.equal(r.applyCalls.length, 1, 'the done card is never applied a second time');
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
    await new Promise(done => setImmediate(done)); // the targets are compared before the write
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
  await new Promise(done => setImmediate(done)); // the targets are compared before the write
  r.state.closed = true;
  gate.resolve([]);
  await pending;
  assert.equal(r.conv.applying, false);
  assert.deepEqual(names(r.log), ['clearPreview', 'settlePlan', 'setApplying', 'setApplying']);
  assert.deepEqual(r.record.calls, []);
});

test('a plan applied for a chain round hands the cards it created to advanceChain through the same work it set on the run', async () => {
  const r = rig();
  const run = { state: { round: 2 } };
  const { card, token, result } = offer(r, [act.child], { run });
  r.state.apply = async (_result, _baseline, _alive, _anchor, options) => { options.work.created.push('c1', 'c2'); return [{ status: 'done', text: 'ok' }]; };
  r.log.length = 0;
  await r.conv.applyChatPlan(card, token, result, { selectedCount: 0 }, { ...ANCHOR }, run);
  const advance = r.log.find(e => e[0] === 'advance')[1];
  assert.deepEqual(advance.work.created, ['c1', 'c2']);
  assert.equal(advance.work, run.work);
  assert.equal(advance.work, r.applyCalls.at(-1)[4].work);
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

// ---- C3b: the turn driver (send, answer, steer, flush, Stop) on fake ports and a fake panel ----
// The module gets its own realm with a fake `window` (runAttempts' slow timer) that a test advances by hand.
const timers = { now: 0, list: [] };
const fakeWindow = {
  setTimeout: (callback, ms) => { const handle = { callback, at: timers.now + ms }; timers.list.push(handle); return handle; },
  clearTimeout: handle => { timers.list = timers.list.filter(item => item !== handle); }
};
const tick = ms => {
  timers.now += ms;
  for (const item of timers.list.filter(entry => entry.at <= timers.now)) { timers.list = timers.list.filter(entry => entry !== item); item.callback(); }
};
const Turn = load('experiences/visual-map/map-chat-conversation.ts', { obsidian: S.obsidian }, { window: fakeWindow });
const settle = async () => { for (let i = 0; i < 8; i++) await flush(); };
const REQUEST = () => ({ model: 'haiku', message: 'q', context: { selectedCount: 0, research: { sent: ['n1'], deferred: [] }, basis: { cards: {}, read: [] } } });

function turnRig(options = {}) {
  timers.list = [];
  const log = [];
  const state = {
    closed: false, path: ANCHOR.path, map: { id: 'm1' }, notesLoading: false, selection: ['s1'], imageId: null, autoApply: false,
    confirmAs: 'run', build: () => Promise.resolve(REQUEST()), requests: [], applyLines: [], endReturns: true, drafts: 0, ...options
  };
  const sentOnce = new Set();
  const turnOf = () => ({ user: { id: 'u' }, assistant: { id: 'a' } });
  const panel = {
    isBusy: false, pending: null, turn: null, text: 'hello', queued: [], steerRows: [], lastTurn: null,
    get draft() { state.drafts++; return panel.text; },
    transcript: () => state.transcript || [],
    clearDraft() { log.push(['clearDraft']); panel.text = ''; },
    attachments: () => [{ name: 'chip' }],
    begin(message, origin, again, stage) { log.push(['begin', message, origin, again, stage]); panel.turn = turnOf(); panel.isBusy = true; return panel.turn; },
    beginAutoRound(...args) { log.push(['beginAuto', ...args]); panel.turn = turnOf(); panel.isBusy = true; return panel.turn; },
    retract(turn, text) { if (panel.turn !== turn) { log.push(['retract-false']); return false; } log.push(['retract', text]); panel.turn = null; panel.isBusy = false; panel.text = text ?? ''; return true; },
    hasTurn: turn => panel.turn === turn,
    setStage: stage => log.push(['stage', stage]),
    streamReply: text => log.push(['stream', text]),
    showSlow(text, resend) { log.push(['showSlow']); panel.resend = resend; },
    clearSlow: () => log.push(['clearSlow']),
    restartWaiting: () => log.push(['restartWaiting']),
    takeSteerTexts: () => [],
    finish(reply, lines) { log.push(['finish', reply]); panel.isBusy = false; return lines; },
    fail(...args) { log.push(['fail', ...args]); panel.isBusy = false; },
    setUnreadNotes: (turn, notes) => log.push(['unread', notes]),
    setReplyBasis: (turn, basis) => { panel.replyBasis = basis; },
    addSteer(text, mode) { log.push(['addSteer', text, mode]); if (state.noRow) return null; const row = { text, mode }; panel.steerRows.push(row); return row; },
    setSteerState: (row, mode, ...rest) => log.push(['setSteerState', row.text, mode, ...rest]),
    takeQueued() { const out = panel.queued; panel.queued = []; return out; },
    restoreDraft(texts) { log.push(['restoreDraft', texts]); },
    markStopped() { log.push(['markStopped']); panel.isBusy = false; },
    focusInput: () => log.push(['focus']),
    pendingPlan: () => panel.pending,
    settlePlan(card, st) { log.push(['settlePlan', st]); if (panel.pending === card) panel.pending = null; },
    showPlan(card) { log.push(['showPlan']); panel.pending = card; },
    setApplying: on => log.push(['setApplying', on]),
    hasQueuedSteers: () => false
  };
  state.panel = panel;
  const chainRun = () => ({ state: { round: 1, maxRounds: 3, remaining: 0, autoApply: false, calls: 0, phase: 'round' }, createdIds: new Set() });
  const chain = {
    current: null,
    chainForRound: (origin, anchor, message) => { log.push(['chainForRound', origin, anchor, message]); chain.current = state.run || chainRun(); return chain.current; },
    resumeChatChain: message => { log.push(['resume']); return state.canResume === true; },
    retryAutoRound: (run, origin) => { log.push(['retryAuto']); return state.retryAuto === true; },
    finishChatRound: (run, round) => log.push(['finishRound', round.lines]),
    interruptChain: (run, reason) => log.push(['interrupt', reason]),
    chainShows: () => state.shows === true,
    stopChainWork: () => log.push(['stopChainWork']),
    advanceChain: () => log.push(['advance'])
  };
  const record = { calls: [], steerTexts: () => [], raw: null, end(status, fields) { record.calls.push(['end', status, fields]); log.push(['recordEnd', status]); return state.endReturns; }, plan() {}, event: kind => { record.calls.push(['event', kind]); log.push(['recordEvent', kind]); } };
  const registry = new Map();
  let sequence = 0;
  const plans = new WeakMap();
  const ports = {
    panel: () => state.panel, closed: () => state.closed, path: () => state.path, map: () => state.map,
    notesLoading: () => state.notesLoading, selectionIds: () => state.selection, imageId: () => state.imageId,
    chain: () => chain, plans: () => plans,
    showPreview: () => {}, clearPreview: () => log.push(['clearPreview']), applyBlock: () => null, mergeBlock: () => null, targetStamps: async () => ({}), refTitles: () => new Map(), actionLabel: a => a.kind,
    applyActions: (...args) => { log.push(['apply']); return Promise.resolve(state.applyLines); },
    buildRequest: (message, origin, signal) => { log.push(['build', message]); state.buildSignal = signal; return state.build(message, origin, signal); },
    confirmAiUsage: async (model, run, hooks) => {
      log.push(['confirm']);
      if (state.confirmAs === 'throw') throw new Error('confirm boom');
      if (state.confirmAs === 'declined') { hooks.noticeOpening?.(); return false; }
      if (state.confirmAs === 'notReady') return false;
      if (state.confirmAs === 'hold') { hooks.noticeOpening?.(); await state.gate.promise; }
      await run();
      if (state.confirmAs === 'throwAfter') throw new Error('late boom');
      return true;
    },
    beginRecord: (turn, request, origin) => { log.push(['beginRecord']); return state.noRecord ? null : record; },
    endRecord: (status, fields) => log.push(['endRecord', status]),
    markLogged: answer => log.push(['markLogged', answer.id]),
    taskKey: () => `map-chat-view:${++sequence}`,
    registerTask: (key, controller) => { log.push(['register', key]); registry.set(key, controller); },
    unregisterTask: key => { log.push(['unregister', key]); registry.delete(key); },
    relocate: () => log.push(['relocate']),
    modelLabel: model => `label:${model}`,
    requestChat: (...args) => new Promise((resolve, reject) => { const [request, signal, onReply, onProgress, onSteer, onRaw] = args; state.requests.push({ request, signal, onReply, onProgress, onSteer, onRaw, resolve, reject }); }),
    researchSent: () => state.sentSet || (state.sentSet = new Set()), autoApply: () => state.autoApply,
    planOptions: () => ({}), replyEntry: () => ({ id: 'entry' }),
    markTurn: (origin, request, entry) => log.push(['markTurn', entry && entry.id]),
    errorText: error => ({ text: `E:${error.message}`, wrapped: false }),
    notice: text => log.push(['notice', text]),
    send: (...args) => { log.push(['send', ...args]); return Promise.resolve(); }
  };
  const conv = new Turn.MapChatConversation(ports);
  return { conv, state, panel, log, chain, record, registry, ports };
}
const first = (r, kind) => r.log.find(entry => entry[0] === kind);
const all = (r, kind) => r.log.filter(entry => entry[0] === kind);
const REPLY = (actions = [], extra = {}) => ({ reply: 'ans', actions, remaining: 'none', rejected: [], changeRequested: true, ...extra });
// The send promise stays open while the request runs; tests settle the fakes and await it only when they end the request.
async function start(r, ...args) { r.sending = r.conv.sendMapChat(...args); await settle(); }

test('turn: a draft typed while a plan applies is a queued follow-up, not a send', async () => {
  const r = turnRig();
  r.conv.applying = true;
  await start(r);
  assert.deepEqual(r.log, [['addSteer', 'hello', 'queued']]);
});

for (const [name, setup, draftRead] of [
  ['busy', r => { r.panel.isBusy = true; }, false],
  ['applying (no draft)', r => { r.conv.applying = true; r.panel.text = '  '; }, true],
  ['closed', r => { r.state.closed = true; }, false],
  ['no map', r => { r.state.map = null; }, false],
  ['notes loading', r => { r.state.notesLoading = true; }, false],
  ['empty draft', r => { r.panel.text = '   '; }, true],
  ['no panel', r => { r.state.panel = null; }, false]
]) {
  test(`turn guard: ${name} starts nothing${draftRead ? '' : ' and never reads the draft'}`, async () => {
    const r = turnRig();
    setup(r);
    await start(r);
    assert.deepEqual(r.log.filter(e => ['begin', 'build', 'chainForRound'].includes(e[0])), []);
    if (!draftRead) assert.equal(r.state.drafts, 0, 'the draft is not read');
  });
}

test('turn: the resume keyword clears the draft when the chain can go on; otherwise it is a normal message', async () => {
  const r = turnRig();
  r.panel.text = 'continue';
  r.state.canResume = true;
  r.state.transcript = [{ resume: true }];
  await start(r);
  assert.deepEqual(names(r.log), ['resume', 'clearDraft']);
  const r2 = turnRig();
  r2.panel.text = 'continue';
  r2.state.transcript = [{ resume: true }];
  await start(r2);
  assert.ok(names(r2.log).includes('begin'));
  assert.equal(first(r2, 'interrupt')[1], 'user_took_over');
});

test('turn: a normal send runs in the documented order, origin and anchor included', async () => {
  const r = turnRig();
  r.state.imageId = 'img1';
  await start(r);
  const begin = first(r, 'begin');
  assert.deepEqual(begin[2], { text: 'hello', chips: [{ name: 'chip' }], selectedIds: ['s1'], imageId: 'img1' });
  assert.equal(begin[4], 'preparing');
  assert.deepEqual(first(r, 'chainForRound')[2], { path: ANCHOR.path, id: 'm1' });
  assert.deepEqual(names(r.log), ['interrupt', 'chainForRound', 'begin', 'build', 'confirm', 'beginRecord', 'register', 'clearPreview', 'relocate', 'stage']);
  assert.equal(first(r, 'stage')[1], 'waiting');
  assert.equal(first(r, 'register')[1], 'map-chat-view:1');
  assert.equal(r.conv.taskKey, 'map-chat-view:1');
  assert.equal(r.conv.prepAbandon, null);
  assert.ok(r.conv.controller);
  assert.equal(r.state.requests.length, 1);
  assert.equal(first(r, 'interrupt')[1], 'user_took_over');
});

test('turn: no imageId key when none is selected', async () => {
  const r = turnRig();
  await start(r);
  assert.equal('imageId' in first(r, 'begin')[2], false);
});

test('turn: an answer without actions finishes, records done, marks the turn and ends the round; research is remembered', async () => {
  const r = turnRig();
  await start(r);
  r.state.requests[0].resolve(REPLY());
  await r.sending;
  assert.deepEqual(names(r.log).slice(10), ['apply', 'finish', 'markTurn', 'recordEnd', 'markLogged', 'finishRound', 'unregister']);
  assert.equal(all(r, 'stage').some(e => e[1] === 'applying'), false, 'a pure answer is not "applying"');
  assert.deepEqual([...r.state.sentSet], ['n1']);
  assert.equal(r.conv.controller, null);
  assert.equal(r.registry.size, 0);
  assert.equal(first(r, 'markLogged')[1], 'a');
});

test('turn: a reply whose actions failed the format check and came back with none shows the real cause, not the model\'s excuse', async () => {
  // ai-exchanges 986: 57 actions rejected for a missing "rewrite", a retry that did not parse, then an empty reply that blamed a "safety classifier".
  const r = turnRig();
  await start(r);
  r.state.requests[0].resolve(REPLY([], { reply: 'blocked by the safety classifier', remaining: '', droppedOnRetry: true }));
  await r.sending;
  const shown = first(r, 'finish')[1];
  assert.doesNotMatch(shown, /classifier/);
  assert.match(shown, /did not match the required format/);
  // A retry that kept actions is the model's reply as it is.
  const k = turnRig();
  await start(k);
  k.state.applyLines = [{ status: 'done', text: 'ok' }];
  k.state.requests[0].resolve(REPLY([act.child], { droppedOnRetry: true }));
  await k.sending;
  assert.equal(first(k, 'finish')[1], 'ans');
});

test('turn: actions apply (stage applying) and the entry is read before finish', async () => {
  const r = turnRig();
  await start(r);
  r.state.applyLines = [{ status: 'done', text: 'ok' }];
  r.state.requests[0].resolve(REPLY([act.child]));
  await r.sending;
  const order = names(r.log).slice(10);
  assert.deepEqual(order, ['stage', 'apply', 'finish', 'markTurn', 'recordEnd', 'markLogged', 'finishRound', 'unregister']);
  assert.equal(first(r, 'markTurn')[1], 'entry');
});

test('turn: the record end that returns false does not mark logged', async () => {
  const r = turnRig({ endReturns: false });
  await start(r);
  r.state.requests[0].resolve(REPLY());
  await r.sending;
  assert.equal(all(r, 'markLogged').length, 0);
});

test('turn: buildRequest throws: draft back, interrupt failed, the error as Notice; closed gives no Notice', async () => {
  const r = turnRig({ build: () => Promise.reject(new Error('bad')) });
  await start(r);
  assert.deepEqual(r.log.slice(-3), [['retract', 'hello'], ['interrupt', 'failed'], ['notice', 'bad']]);
  assert.equal(r.conv.prepAbandon, null);
  const c = turnRig({ build: () => { c.state.closed = true; return Promise.reject(new Error('bad')); } });
  await start(c);
  assert.equal(all(c, 'notice').length, 0);
});

for (const [name, setup] of [
  ['closed', r => { r.state.closed = true; }],
  ['turn gone', r => { r.panel.turn = null; }],
  ['path changed', r => { r.state.path = 'Other.md'; }],
  ['map replaced at same path', r => { r.state.map = { id: 'new' }; }],
  ['panel replaced', r => { r.state.panel = { ...r.panel }; }]
]) {
  test(`turn: the build finishes after ${name}: abandoned, no usage notice`, async () => {
    const gate = deferred();
    const r = turnRig({ build: () => gate.promise });
    await start(r);
    setup(r);
    gate.resolve(REQUEST());
    await r.sending;
    assert.equal(all(r, 'confirm').length, 0);
    assert.equal(all(r, 'interrupt').at(-1)[1], 'map_changed');
  });
}

test('turn: Stop while preparing aborts the build signal, puts the draft back, no Notice; the late build asks no consent', async () => {
  const gate = deferred();
  const r = turnRig({ build: () => gate.promise });
  await start(r);
  assert.equal(typeof r.conv.prepAbandon, 'function');
  r.conv.stopMapChat();
  assert.equal(r.state.buildSignal.aborted, true);
  assert.deepEqual(r.log.slice(-3), [['retract', 'hello'], ['interrupt', 'stopped'], ['focus']]);
  assert.equal(all(r, 'notice').length, 0);
  assert.equal(r.conv.prepAbandon, null);
  assert.equal(all(r, 'interrupt').at(-1)[1], 'stopped');
  gate.resolve(REQUEST());
  await r.sending;
  assert.equal(all(r, 'confirm').length, 0);
  assert.equal(all(r, 'retract-false').length, 0, 'late completion cannot abandon the turn twice');
  assert.equal(all(r, 'interrupt').filter(e => e[1] === 'stopped').length, 1);
  assert.equal(all(r, 'notice').length, 0);
});

test('turn: the usage notice opens only with a turn: stage consent', async () => {
  const r = turnRig({ confirmAs: 'declined' });
  await start(r);
  assert.equal(all(r, 'stage').some(e => e[1] === 'consent'), true);
  const gone = turnRig({ confirmAs: 'hold' });
  gone.state.gate = deferred();
  await start(gone);
  assert.equal(all(gone, 'stage').some(e => e[1] === 'consent'), true);
  gone.panel.turn = null;
  gone.state.gate.resolve();
  await gone.sending;
});

for (const [name, setup] of [
  ['closed', r => { r.state.closed = true; }],
  ['applying', r => { r.conv.applying = true; }],
  ['turn gone', r => { r.panel.turn = null; }],
  ['path changed', r => { r.state.path = 'Other.md'; }],
  ['map changed', r => { r.state.map = { id: 'other' }; }],
  ['panel replaced', r => { r.state.panel = { ...r.panel }; }]
]) {
  test(`turn: the consent window answers late (${name}): abandoned, nothing recorded, registered or sent`, async () => {
    const r = turnRig({ confirmAs: 'hold' });
    r.state.gate = deferred();
    await start(r);
    setup(r);
    r.state.gate.resolve();
    await r.sending;
    assert.equal(all(r, 'beginRecord').length, 0);
    assert.equal(all(r, 'register').length, 0);
    assert.equal(r.state.requests.length, 0);
    assert.equal(r.conv.controller, null);
  });
}

for (const [name, confirmAs, again, text] of [
  ['declined', 'declined', undefined, 'ui.map_chat_not_sent_draft'], ['AI not ready', 'notReady', undefined, 'ui.map_chat_not_sent_draft'],
  ['retry declined', 'declined', { text: 'again', chips: [], selectedIds: [] }, 'ui.map_chat_not_sent_kept']
]) {
  test(`turn: ${name}: Notice not-sent, ends not_ready${again ? ', the retry text goes back' : ''}`, async () => {
    const r = turnRig({ confirmAs });
    await start(r, again, again ? 'restore text' : undefined);
    assert.equal(all(r, 'notice').length, 1);
    assert.notEqual(first(r, 'notice')[1], text, 'the key is translated');
    assert.equal(all(r, 'interrupt').at(-1)[1], 'not_ready');
    assert.deepEqual(first(r, 'retract'), ['retract', again ? 'restore text' : 'hello']);
    assert.equal(r.state.requests.length, 0);
  });
}

test('turn: the two not-sent Notices differ (draft vs kept)', async () => {
  const a = turnRig({ confirmAs: 'declined' });
  await start(a);
  const b = turnRig({ confirmAs: 'declined' });
  await start(b, { text: 'again', chips: [], selectedIds: [] }, 'r');
  assert.notEqual(first(a, 'notice')[1], first(b, 'notice')[1]);
});

test('turn: confirm throws before sent: abandoned failed with the error; after sent it is rethrown', async () => {
  const r = turnRig({ confirmAs: 'throw' });
  await start(r);
  assert.deepEqual(r.log.slice(-3), [['retract', 'hello'], ['interrupt', 'failed'], ['notice', 'confirm boom']]);
  const late = turnRig({ confirmAs: 'throwAfter' });
  await start(late);
  late.state.requests[0].resolve(REPLY());
  await assert.rejects(late.sending, /late boom/);
  assert.equal(all(late, 'notice').length, 0);
});

test('turn: an automatic round abandons with a Notice only when it failed', async () => {
  const origin = { text: 'auto', chips: [], selectedIds: [], chain: { seq: 1 } };
  const declined = turnRig({ confirmAs: 'declined' });
  await start(declined, origin);
  assert.equal(all(declined, 'notice').length, 0);
  assert.equal(all(declined, 'beginAuto').length, 1);
  assert.equal(all(declined, 'interrupt').filter(e => e[1] === 'user_took_over').length, 0);
  const failed = turnRig({ build: () => Promise.reject(new Error('bad')) });
  await start(failed, origin);
  assert.equal(first(failed, 'notice')[1], 'bad');
});

test('turn: an empty-target research after select_topics is applied with the ids the gate resolved, never the live selection', async () => {
  const r = turnRig();
  const seen = [];
  r.ports.applyActions = (result, ...rest) => { seen.push(JSON.parse(JSON.stringify(result.actions))); return Promise.resolve(r.state.applyLines); };
  r.state.selection = ['live1', 'live2'];
  const select = { kind: 'select_topics', nodeIds: ['a', 'gone'], all: false };
  const research = { kind: 'run_map_action', action: 'research_standard', nodeIds: [], title: '', goal: '', direction: '', mode: '', images: false };
  const expand = { ...research, action: 'expand' };
  const other = { ...research, nodeIds: ['z'] };
  await start(r);
  r.state.requests[0].resolve(REPLY([select, research, expand, other]));
  await r.sending;
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].map(action => action.nodeIds), [['a', 'gone'], ['a', 'gone'], ['a', 'gone'], ['z']]);
  assert.deepEqual(research.nodeIds, [], 'the reply object itself is not mutated');
});

test('turn: a retry of a chain round keeps its chain: no user_took_over, message and chips set on the run', async () => {
  const run = { state: { round: 1, maxRounds: 3, remaining: 0, autoApply: false, calls: 0 }, createdIds: new Set() };
  const r = turnRig();
  await start(r, undefined, undefined, run);
  assert.equal(all(r, 'chainForRound').length, 0);
  assert.equal(all(r, 'interrupt').length, 0);
  assert.equal(run.message, 'hello');
  assert.deepEqual(run.chips, [{ name: 'chip' }]);
  assert.equal(run.turn, r.panel.turn);
});

test('turn: Stop during the request: unregister the key, abort, record stopped before the panel, steers returned; a late reply changes nothing', async () => {
  const r = turnRig();
  await start(r);
  const key = r.conv.taskKey;
  const { signal } = r.state.requests[0];
  r.conv.stopMapChat();
  assert.equal(signal.aborted, true);
  assert.deepEqual(names(r.log).slice(-6), ['unregister', 'endRecord', 'markStopped', 'interrupt', 'restoreDraft', 'focus']);
  assert.deepEqual(first(r, 'unregister'), ['unregister', key]);
  const order = names(r.log);
  assert.ok(order.indexOf('endRecord') < order.indexOf('markStopped'));
  assert.ok(order.indexOf('unregister') < order.indexOf('endRecord'));
  const before = r.log.length;
  r.state.requests[0].resolve(REPLY([act.child]));
  await r.sending.catch(() => {});
  await settle();
  assert.deepEqual(names(r.log.slice(before)).filter(n => ['finish', 'showPlan', 'apply', 'fail'].includes(n)), []);
  assert.equal(r.conv.controller, null);
});

test('turn: Stop then a second send: the first turn finally does not release the second key or controller', async () => {
  const r = turnRig();
  await start(r);
  const firstRequest = r.state.requests[0];
  r.conv.stopMapChat();
  r.panel.text = 'second';
  await start(r);
  const secondController = r.conv.controller;
  const secondKey = r.conv.taskKey;
  assert.ok(secondController);
  firstRequest.reject(new Error('stopped'));
  await settle();
  assert.equal(r.conv.controller, secondController);
  assert.equal(r.conv.taskKey, secondKey);
  assert.equal(r.registry.has(secondKey), true);
});

test('turn: after Stop the stream, events, steer handler and raw are ignored', async () => {
  const r = turnRig();
  await start(r);
  const req = r.state.requests[0];
  r.conv.stopMapChat();
  const before = r.log.length;
  const bound = [];
  req.onReply('late');
  req.onProgress({ kind: 'activity', activity: 'writing' });
  req.onSteer(() => bound.push('x'));
  req.onRaw('raw');
  assert.equal(r.log.length, before);
  assert.equal(r.record.raw, null);
});

test('turn: while live the stream, writing stage and raw come through; stream-mode and a started activity are handled', async () => {
  const r = turnRig();
  await start(r);
  const req = r.state.requests[0];
  req.onReply('part');
  req.onProgress({ kind: 'activity', activity: 'writing' });
  req.onProgress({ kind: 'stream-mode', mode: 'stream-json' });
  req.onRaw('RAW');
  assert.deepEqual(all(r, 'stream'), [['stream', 'part']]);
  assert.ok(all(r, 'stage').some(e => e[1] === 'writing'));
  assert.equal(r.record.raw, 'RAW');
});

test('turn: slow 20 s shows the notice; Resend logs event, drops steers, restarts waiting, in that order; a late press does nothing', async () => {
  const r = turnRig();
  await start(r);
  tick(19000);
  assert.equal(all(r, 'showSlow').length, 0);
  tick(1500);
  assert.equal(all(r, 'showSlow').length, 1);
  r.panel.resend();
  const names2 = names(r.log).filter(n => ['recordEvent', 'restartWaiting'].includes(n));
  assert.deepEqual(names2, ['recordEvent', 'restartWaiting']);
  assert.equal(first(r, 'recordEvent')[1], 'resend');
  await settle();
  assert.equal(r.state.requests.length, 2, 'the same question is sent again');
  const late = turnRig();
  await start(late);
  tick(21000);
  const resend = late.panel.resend;
  late.conv.stopMapChat();
  const before = late.log.length;
  resend();
  assert.equal(all(late, 'recordEvent').length, 0);
  assert.equal(late.log.length, before);
});

test('turn: a failure shows the text, records failed (timeout or error), returns steers; retryAutoRound true skips the interrupt', async () => {
  const r = turnRig();
  await start(r);
  r.state.requests[0].reject(new Error('request timed out'));
  await r.sending;
  assert.equal(first(r, 'fail')[1], 'E:request timed out');
  assert.equal(r.record.calls.at(-1)[2].reason, 'timeout');
  assert.equal(r.record.calls.at(-1)[2].error.text, 'E:request timed out');
  assert.equal(all(r, 'interrupt').at(-1)[1], 'failed');
  assert.equal(all(r, 'restoreDraft').length, 1);
  const other = turnRig({ retryAuto: true });
  await start(other);
  other.state.requests[0].reject(new Error('plain'));
  await other.sending;
  assert.equal(other.record.calls.at(-1)[2].reason, 'error');
  assert.equal(all(other, 'interrupt').filter(e => e[1] === 'failed').length, 0);
  assert.equal(other.conv.controller, null);
});

test('turn: a plan is needed: only while busy; offers the card, flushes with false, records plan and marks logged', async () => {
  const r = turnRig();
  r.conv.flushSteers = send => r.log.push(['portFlush', send]);
  await start(r);
  r.state.requests[0].resolve(REPLY([{ kind: 'create_map', title: 'T' }]));
  await r.sending;
  const order = names(r.log);
  assert.ok(order.includes('showPlan'));
  assert.deepEqual(r.log.filter(e => e[0] === 'portFlush'), [['portFlush', false]]);
  assert.equal(first(r, 'recordEnd')[1], 'plan');
  assert.equal(all(r, 'markLogged').length, 1);
  assert.equal(order.includes('apply'), false);
  assert.equal(r.chain.current.state.phase, 'plan', 'the chain waits for the plan');
  const idle = turnRig();
  await start(idle);
  idle.panel.isBusy = false;
  const before = idle.log.length;
  idle.state.requests[0].resolve(REPLY([{ kind: 'create_map', title: 'T' }]));
  await idle.sending;
  assert.deepEqual(names(idle.log.slice(before)).filter(n => n !== 'unregister'), []);
});

test('turn: the apply ends after Stop-like loss of alive: no finish, no finishChatRound', async () => {
  const r = turnRig();
  await start(r);
  const gate = deferred();
  r.ports.applyActions = () => gate.promise;
  r.state.requests[0].resolve(REPLY([act.child]));
  await settle();
  r.conv.controller.abort();
  gate.resolve([]);
  await r.sending;
  assert.equal(all(r, 'finish').length, 0);
  assert.equal(all(r, 'finishRound').length, 0);
});

test('steer: a turn in flight takes a live row (queued once the stream cannot take it); no row means nothing is added', async () => {
  const r = turnRig();
  await start(r);
  r.panel.text = 'more';
  r.conv.steerMapChat();
  assert.deepEqual(first(r, 'addSteer'), ['addSteer', 'more', 'live']);
  assert.equal(r.conv.steer.rows.size, 1);
  r.state.requests[0].onProgress({ kind: 'stream-mode', mode: 'other' });
  r.panel.text = 'later';
  r.conv.steerMapChat();
  assert.deepEqual(all(r, 'addSteer').at(-1), ['addSteer', 'later', 'queued']);
  const none = turnRig({ noRow: true });
  await start(none);
  none.panel.text = 'x';
  none.conv.steerMapChat();
  assert.equal(none.conv.steer.rows.size, 0);
});

test('steer: no turn but busy or applying queues; closed, empty or no panel does nothing; a new turn kills the old steers', async () => {
  const r = turnRig();
  r.panel.isBusy = true;
  r.conv.steerMapChat();
  assert.deepEqual(r.log, [['addSteer', 'hello', 'queued']]);
  for (const setup of [x => { x.state.closed = true; }, x => { x.panel.text = ' '; }, x => { x.state.panel = null; }]) {
    const q = turnRig();
    q.panel.isBusy = true;
    setup(q);
    q.conv.steerMapChat();
    assert.deepEqual(q.log, []);
  }
  const t = turnRig();
  await start(t);
  const oldSteers = t.conv.steer.steers;
  t.conv.stopMapChat();
  t.panel.text = 'again';
  await start(t);
  assert.notEqual(t.conv.steer.steers, oldSteers);
  assert.equal(oldSteers.isAlive(), false, 'the old turn steers are no longer alive');
  assert.equal(t.conv.steer.steers.isAlive(), true);
});

test('returnSteers via Stop: rows that did not go in turn queued, the queued text goes back to the field', async () => {
  const r = turnRig();
  await start(r);
  r.panel.text = 'more';
  r.conv.steerMapChat();
  r.panel.queued = ['more'];
  r.conv.stopMapChat();
  assert.ok(all(r, 'setSteerState').some(e => e.length === 4 && e[1] === 'more' && e[2] === 'queued' && e[3] === false));
  assert.deepEqual(all(r, 'restoreDraft').at(-1), ['restoreDraft', ['more']]);
});

test('flush: nothing queued does nothing; cannot send puts the text back; otherwise one send with the image id', () => {
  const r = turnRig();
  r.conv.flushSteers(true);
  assert.deepEqual(r.log, []);
  for (const [name, setup, send] of [['no send', () => {}, false], ['closed', x => { x.state.closed = true; }, true], ['busy', x => { x.panel.isBusy = true; }, true], ['applying', x => { x.conv.applying = true; }, true], ['no map', x => { x.state.map = null; }, true]]) {
    const q = turnRig();
    q.panel.queued = ['a', 'b'];
    setup(q);
    q.conv.flushSteers(send);
    assert.deepEqual(q.log, [['restoreDraft', ['a', 'b']]], name);
  }
  const ok = turnRig();
  ok.state.imageId = 'im';
  ok.panel.queued = ['a', 'b'];
  ok.conv.flushSteers(true);
  assert.deepEqual(plain(ok.log), [['send', { text: 'a\n\nb', chips: [], selectedIds: ['s1'], imageId: 'im' }, 'a\nb']]);
  const noImage = turnRig();
  noImage.panel.queued = ['a'];
  noImage.conv.flushSteers(true);
  assert.equal('imageId' in noImage.log[0][1], false);
});

test('flush: the resend goes through the port and gets no catch of its own', () => {
  const r = turnRig();
  const promise = Promise.resolve();
  let caught = false;
  promise.catch = () => { caught = true; };
  r.ports.send = (...args) => { r.log.push(['send', ...args]); return promise; };
  r.panel.queued = ['a'];
  r.conv.flushSteers(true);
  assert.equal(all(r, 'send').length, 1);
  assert.equal(caught, false);
});

test('Stop: waiting chain ends the wait; applying without a request skips the rest; preparing and consent abandon; none does nothing but focus', () => {
  const waiting = turnRig();
  waiting.chain.current = { state: { phase: 'waiting' } };
  waiting.conv.stopMapChat();
  assert.deepEqual(names(waiting.log), ['stopChainWork', 'interrupt', 'focus']);
  const applying = turnRig({ shows: true });
  applying.chain.current = { state: { phase: 'round' } };
  applying.conv.applying = true;
  applying.conv.stopMapChat();
  assert.equal(applying.conv.planToken, 1);
  assert.equal(applying.conv.planStopped, true);
  assert.deepEqual(names(applying.log), ['stopChainWork', 'focus']);
  const none = turnRig();
  none.conv.stopMapChat();
  assert.deepEqual(names(none.log), ['focus']);
  const prep = turnRig();
  let called = 0;
  prep.conv.prepAbandon = () => { called++; };
  prep.conv.stopMapChat();
  assert.equal(called, 1);
  assert.equal(all(prep, 'notice').length, 0);
});

test('Stop in flight stops the chain work too when the chain shows it', async () => {
  const r = turnRig({ shows: true });
  await start(r);
  r.conv.stopMapChat();
  assert.ok(names(r.log).indexOf('stopChainWork') < names(r.log).indexOf('unregister'));
});

test('releaseChatTask: no key means no unregister; a key is unregistered once and both fields clear', () => {
  const r = turnRig();
  r.conv.releaseChatTask();
  assert.equal(all(r, 'unregister').length, 0);
  r.conv.taskKey = 'k';
  r.conv.controller = new AbortController();
  r.conv.releaseChatTask();
  assert.deepEqual(all(r, 'unregister'), [['unregister', 'k']]);
  assert.equal(r.conv.taskKey, null);
  assert.equal(r.conv.controller, null);
});

test('unread research notes are told under the result; a note read in an earlier round is not', async () => {
  const r = turnRig({ build: () => Promise.resolve({ ...REQUEST(), context: { selectedCount: 0, research: { sent: [], deferred: [{ title: 'A', oversize: true }, { title: 'B', sentBefore: true }] }, basis: { cards: {}, read: [] } } }) });
  await start(r);
  r.state.requests[0].resolve(REPLY());
  await r.sending;
  assert.deepEqual(plain(first(r, 'unread')[1]), [{ title: 'A', oversize: true }]);
});

test('E4b: the line under the answer is what the request read (cards, files, research), never what the reply claims', async () => {
  const read = { cards: { c1: { title: 'A', research: false }, r1: { title: 'R', research: true } }, read: [{ id: 'c1', path: 'A.md', title: 'A' }, { path: 'Drop.md', title: 'Drop' }, { id: 'r1', path: 'R.md', title: 'R' }] };
  const r = turnRig({ build: () => Promise.resolve({ ...REQUEST(), context: { ...REQUEST().context, basis: read } }) });
  await start(r); r.state.requests[0].resolve(REPLY()); await r.sending;
  assert.deepEqual(plain(r.panel.replyBasis), { notes: 2, research: true });
  // The reply says it read the research sources; the request carried no note at all: it is inference.
  const n = turnRig();
  await start(n); n.state.requests[0].resolve(REPLY([], { reply: 'I read your research sources and 3 card notes.' })); await n.sending;
  assert.deepEqual(plain(n.panel.replyBasis), { notes: 0, research: false });
  // A question whose reply wants a change waits on a plan card: its answer gets the line too.
  const p = turnRig({ build: () => Promise.resolve({ ...REQUEST(), context: { ...REQUEST().context, basis: read } }) });
  await start(p); p.state.requests[0].resolve(REPLY([act.child], { changeRequested: false })); await p.sending;
  assert.ok(names(p.log).includes('showPlan'), names(p.log).join());
  assert.deepEqual(plain(p.panel.replyBasis), { notes: 2, research: true });
});

test('the plan apply ends through the instance flushSteers (a replaced one is called), after the settle', async () => {
  const r = turnRig();
  const calls = [];
  r.conv.flushSteers = send => calls.push(send);
  await start(r);
  r.state.requests[0].resolve(REPLY([{ kind: 'create_map', title: 'T' }]));
  await r.sending;
  assert.deepEqual(calls, [false], 'the plan card step flushes with false through the instance');
  const card = r.panel.pending;
  await r.conv.applyChatPlan(card, r.conv.planToken, REPLY([act.child]), { selectedCount: 0 }, { ...ANCHOR }, null);
  assert.deepEqual(calls, [false, true]);
});

test('offer: a book plan diff next to a delete_topic still lists the delete group (with its danger mark) on the card', () => {
  const planText = load('core/book-pipeline/plan-text.ts');
  const prompt = planText.composeCardPrompt({ role: 'body', kind: 'chapter', covers: 'c', points: ['p'], entry: 'e', handoff: 'h', checklist: [{ id: 'C1', type: 'structure', text: 'c1' }] }, 'en');
  const baseline = { selectedCount: 0, bookPlan: { runId: 'run-1', unlocked: ['b'], prompts: { b: { path: 'b.md', prompt, kind: 'chapter', title: 'B' } } } };
  const edit = { kind: 'edit_book_plan', changes: [{ id: 'b', entry: 'new entry' }] };
  const r = rig();
  r.conv.offerChatPlan(resultOf([edit, act.del]), planOf({ reasons: ['book_plan_edit'] }), baseline, { ...ANCHOR }, 'm');
  const card = r.panel.pending;
  assert.equal(card.diff.length, 1, 'the before and after is there');
  assert.deepEqual(card.groups.map(g => g.items), [['L:delete_topic']], 'the delete is listed, the book edit is not repeated');
  assert.ok(card.groups[0].danger.mark, 'and marked as removing');
  const alone = rig();
  alone.conv.offerChatPlan(resultOf([edit]), planOf({ reasons: ['book_plan_edit'] }), baseline, { ...ANCHOR }, 'm');
  assert.deepEqual(alone.panel.pending.groups, [], 'a diff alone has no group');
});

test('offer: a structure card where every item is refused offers no apply; one with an applicable item, or next to another action, keeps it', () => {
  const nodes = [
    { id: 'root', parentId: null, title: 'Book' }, { id: 'ch1', parentId: 'root', title: 'One' },
    { id: 'sec', parentId: 'ch1', title: 'Sec' }, { id: 'ch2', parentId: 'root', title: 'Two' }
  ];
  const baseline = { selectedCount: 0, bookPlan: { runId: 'r', unlocked: ['ch1', 'ch2', 'sec'], thread: '', prompts: {}, nodes } };
  const refused = { kind: 'edit_book_structure', items: [{ kind: 'remove', nodeId: 'ch1' }] };
  const fine = { kind: 'edit_book_structure', items: [{ kind: 'rename', nodeId: 'ch2', title: 'Deux' }] };
  const shown = actions => {
    const r = rig();
    r.conv.offerChatPlan(resultOf(actions), planOf({ reasons: ['book_plan_edit'] }), baseline, { ...ANCHOR }, 'm');
    return r.panel.pending;
  };
  assert.equal(shown([refused]).noApply, true, 'nothing applicable: refusal lines and cancel only');
  assert.equal(shown([refused]).diff.length, 1, 'the refusal lines are still shown');
  assert.equal(shown([fine]).noApply, undefined);
  assert.equal(shown([refused, fine]).noApply, undefined);
  assert.equal(shown([refused, act.del]).noApply, undefined, 'another action of the reply is still applicable');
});

test('E3 apply gate: a read-only map at Apply writes nothing, keeps the card waiting and draws it again; once writable it applies once', async () => {
  const r = rig();
  const { card } = offer(r);
  assert.equal(typeof card.blocked, 'function');
  r.state.block = 'read-only';
  assert.equal(card.blocked(), 'read-only');
  r.log.length = 0;
  card.apply(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(r.applyCalls.length, 0, 'nothing written');
  assert.equal(card.state, 'pending');
  assert.deepEqual(names(r.log), ['refreshPlan']);
  r.state.block = null;
  card.apply(); card.apply(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(r.applyCalls.length, 1, 'written once');
});
