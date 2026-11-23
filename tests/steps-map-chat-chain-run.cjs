// MapChatChainRunner (C2): the chain's run on fake ports, a fake panel and a fake window timer. No UI, no vault, no AI.
const { test } = require('node:test');
const strict = require('node:assert/strict');
// The runner is loaded in its own vm realm: compare by value across realms.
const plain = value => JSON.parse(JSON.stringify(value));
const assert = Object.assign(Object.create(strict), { deepEqual: (a, b, m) => strict.deepEqual(plain(a), plain(b), m) });
const { load } = require('./support-replay.cjs');
const S = require('./support.cjs');

// One shared fake of the vm global `window`: the module calls window.setTimeout / clearTimeout, which land here.
const clock = { timers: [] };
const fakeWindow = {
  setTimeout: (fn, ms) => { clock.timers.push({ fn, ms, cleared: false, fired: false }); return clock.timers.length; },
  clearTimeout: id => { if (clock.timers[id - 1]) clock.timers[id - 1].cleared = true; }
};
const { MapChatChainRunner } = load('experiences/visual-map/map-chat-chain-run.ts', { obsidian: S.obsidian }, { window: fakeWindow });
const chain = load('core/map-chat-chain.ts');

const WAIT = 30 * 60 * 1000;
const ANCHOR = { path: 'Maps/A/Map.md', id: 'm1' };
const flush = () => new Promise(resolve => setImmediate(resolve));
const fire = index => { const timer = clock.timers[index]; if (timer && !timer.cleared) { timer.fired = true; timer.fn(); } };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

function rig(options = {}) {
  clock.timers = [];
  const log = [];
  const panel = {
    isBusy: false, conversationId: 'c1', point: null, turns: new Set(),
    resumePoint() { return panel.point; },
    dropResume(point) { log.push(['dropResume', point]); if (panel.point === point) panel.point = null; },
    setChainWaiting(waiting, remaining) { log.push(['setChainWaiting', waiting && { ...waiting }, remaining]); },
    endChain(...args) { log.push(['endChain', ...args]); },
    offerResume(point) { log.push(['offerResume', point]); },
    hasTurn(turn) { return panel.turns.has(turn); },
    hasQueuedSteers() { return state.queued; },
    setFlowProgress(flow) { log.push(['setFlowProgress', flow]); }
  };
  const state = {
    panel, closed: false, applying: false, notesLoading: false, path: ANCHOR.path,
    map: { id: 'm1', aiMode: 'standard', nodes: [{ id: 'a' }, { id: 'b' }] }, selection: ['sel'], autoApply: false, diagrams: true,
    record: { event(kind, fields) { log.push(['event', kind, fields]); } }, queued: false, sends: [], stops: [], flushes: 0, ...options
  };
  const runner = new MapChatChainRunner({
    panel: () => state.panel, closed: () => state.closed, applying: () => state.applying, notesLoading: () => state.notesLoading,
    path: () => state.path, map: () => state.map, selectionIds: () => state.selection, autoApply: () => state.autoApply,
    diagrams: () => state.diagrams, imageExists: id => (state.imageExists ? state.imageExists(id) : true), lastRecord: () => state.record, stopResearch: key => state.stops.push(key),
    flushSteers: send => { state.flushes++; log.push(['flushSteers', send]); },
    send: (...args) => { state.sends.push(args); log.push(['send', args.length]); }
  });
  return { runner, state, panel, log };
}
const ends = log => log.filter(entry => entry[0] === 'endChain');
const events = log => log.filter(entry => entry[0] === 'event');
const origin0 = (extra = {}) => ({ text: 'hi', chips: [], selectedIds: [], ...extra });
const newWork = (extra = {}) => ({
  controller: new AbortController(), research: [], researchTargets: 0, researchKeys: new Set(), created: [], expand: [],
  otherBackground: false, reads: new Set(), ...extra
});
const roundOf = (work, extra = {}) => ({
  result: { reply: '', actions: [], remaining: 'more' }, context: { selectedCount: 0 }, lines: [], work, anchor: { ...ANCHOR }, ...extra
});
/** A live chain of round 1 waiting for `n` expansions (none finished). */
function waiting(r, n = 1, extra = {}) {
  const run = r.runner.chainForRound(undefined, { ...ANCHOR }, 'do it');
  const gates = Array.from({ length: n }, () => deferred());
  const work = newWork({ expand: gates.map((gate, i) => ({ id: `x${i}`, title: `X${i}`, path: `n${i}.md`, done: gate.promise })), ...extra });
  run.work = work;
  r.runner.advanceChain(run, roundOf(work));
  return { run, gates, work };
}

test('wait timeout: the chain ends as wait_timeout after 30 minutes; stopResearch is never called', async () => {
  const r = rig();
  const { run } = waiting(r, 1, { researchKeys: new Set(['k1']) });
  assert.equal(run.state.phase, 'waiting');
  assert.equal(clock.timers.length, 1);
  assert.equal(clock.timers[0].ms, WAIT);
  fire(0);
  assert.equal(run.state.phase, 'ended');
  assert.equal(r.runner.current, null);
  assert.equal(run.timer, null);
  assert.deepEqual(r.state.stops, []);
  assert.equal(ends(r.log).length, 1);
  assert.equal(ends(r.log)[0][1], 'wait_timeout');
  assert.deepEqual(r.log.filter(e => e[0] === 'setChainWaiting').map(e => e[1] === null), [false, true]);
  assert.equal(events(r.log)[0][1], 'chain_end');
  assert.equal(events(r.log)[0][2].reason, 'wait_timeout');
  assert.equal(r.state.sends.length, 0);
});

test('auto-apply: each finished item re-arms the 30 minutes, so the timeout counts from the last one', async () => {
  const r = rig({ autoApply: true });
  const { run, gates } = waiting(r, 2);
  assert.equal(run.state.autoApply, true);
  gates[0].resolve({ status: 'succeeded', titles: [] });
  await flush();
  assert.equal(clock.timers.length, 2);
  assert.equal(clock.timers[0].cleared, true);
  assert.equal(clock.timers[1].cleared, false);
  assert.equal(clock.timers[1].ms, WAIT);
  fire(0);
  assert.equal(run.state.phase, 'waiting', 'the first timer is gone');
  fire(1);
  assert.equal(run.state.phase, 'ended');
  assert.equal(ends(r.log)[0][1], 'wait_timeout');
  assert.equal(ends(r.log)[0].length, 5, 'auto-apply tells the calls');
});

test('auto-apply reads the switch at each finished item (switched off meanwhile: no re-arm)', async () => {
  const r = rig({ autoApply: true });
  const { gates } = waiting(r, 2);
  r.state.autoApply = false;
  gates[0].resolve({ status: 'succeeded', titles: [] });
  await flush();
  assert.equal(clock.timers.length, 1);
  assert.equal(clock.timers[0].cleared, false);
});

test('not auto-apply: a finished item does not re-arm the timer', async () => {
  const r = rig();
  const { run, gates } = waiting(r, 2);
  gates[0].resolve({ status: 'succeeded', titles: [] });
  await flush();
  assert.equal(clock.timers.length, 1);
  assert.equal(clock.timers[0].cleared, false);
  assert.deepEqual(r.log.filter(e => e[0] === 'setChainWaiting').map(e => e[1] && e[1].settled), [0, 1]);
  fire(0);
  assert.equal(run.state.phase, 'ended');
  assert.equal(ends(r.log)[0][1], 'wait_timeout');
});

test('late results after the end do nothing and send no next round', async () => {
  const r = rig();
  const { run, gates } = waiting(r, 1);
  r.runner.interruptChain(run, 'stopped');
  const before = r.log.length;
  gates[0].resolve({ status: 'succeeded', titles: [] });
  await flush();
  fire(0);
  r.runner.settleChainWait(run, { expand: { succeeded: 1, failed: 0 } }, []);
  r.runner.advanceChain(run, roundOf(newWork()));
  assert.equal(r.log.length, before);
  assert.equal(r.state.sends.length, 0);
  assert.equal(ends(r.log).length, 1);
});

test('a late settle for an older chain changes nothing for the live one', () => {
  const r = rig();
  const first = waiting(r, 1);
  const second = r.runner.chainForRound(undefined, { ...ANCHOR }, 'again');
  assert.equal(first.run.state.phase, 'ended');
  assert.equal(r.runner.current, second);
  r.runner.settleChainWait(first.run, { expand: { succeeded: 1, failed: 0 } }, []);
  assert.equal(r.runner.current, second);
  assert.equal(r.state.sends.length, 0);
});

test('two interrupts in a row: only the first takes effect, endChain is called once', () => {
  const r = rig();
  const { run } = waiting(r, 1);
  r.runner.interruptChain(run, 'stopped');
  r.runner.interruptChain(run, 'map_changed');
  r.runner.interruptChain(null, 'stopped');
  assert.equal(ends(r.log).length, 1);
  assert.equal(ends(r.log)[0][1], 'stopped');
  assert.equal(events(r.log).length, 1);
  assert.equal(events(r.log)[0][2].reason, 'stopped');
});

test('retryAutoRound: once per round, calls + 1, send(origin copy, undefined, run); a second try is false', () => {
  const r = rig({ autoApply: true });
  const run = r.runner.chainForRound(undefined, { ...ANCHOR }, 'hi');
  const origin = origin0({ chain: { seq: run.seq } });
  assert.equal(r.runner.retryAutoRound(run, origin), true);
  assert.equal(run.state.calls, 1);
  assert.equal(run.retriedRound, 1);
  assert.equal(r.state.sends.length, 1);
  const [sent, restore, retryOf] = r.state.sends[0];
  assert.equal(r.state.sends[0].length, 3);
  assert.deepEqual(sent, origin);
  assert.notEqual(sent, origin);
  assert.equal(restore, undefined);
  assert.equal(retryOf, run);
  assert.equal(r.runner.retryAutoRound(run, origin), false);
  assert.equal(run.state.calls, 1);
  assert.equal(r.state.sends.length, 1);
});

test('retryAutoRound: every guard that fails returns false and sends nothing', () => {
  const cases = {
    'auto-apply off': (r, run) => { r.state.autoApply = false; },
    'run is not current': (r, run) => { r.runner.current = null; },
    'phase is not round': (r, run) => { run.state = { ...run.state, phase: 'waiting' }; },
    'closed': (r, run) => { r.state.closed = true; },
    'applying': (r, run) => { r.state.applying = true; },
    'no map': (r, run) => { r.state.map = null; },
    'notes loading': (r, run) => { r.state.notesLoading = true; }
  };
  for (const [name, change] of Object.entries(cases)) {
    const r = rig({ autoApply: true });
    const run = r.runner.chainForRound(undefined, { ...ANCHOR }, 'hi');
    change(r, run);
    assert.equal(r.runner.retryAutoRound(run, origin0()), false, name);
    assert.equal(r.state.sends.length, 0, name);
    assert.equal(run.state.calls, 0, name);
    assert.equal(run.retriedRound, null, name);
  }
  const r = rig({ autoApply: true });
  const run = r.runner.chainForRound(undefined, { ...ANCHOR }, 'hi');
  assert.equal(r.runner.retryAutoRound(run, origin0({ text: '' })), false, 'no text');
  assert.equal(r.state.sends.length, 0);
});

const point = (extra = {}) => ({
  message: 'go on', round: 2, maxRounds: 8, remaining: 'rest', lastResults: [{ text: 'x', status: 'done' }], selectedIds: ['a', 'gone'],
  stoppedRound: 2, reason: 'stopped', conversationId: 'c1', ...extra
});

test('resumeChatChain: every failing guard keeps the point and sends nothing', () => {
  const cases = {
    'no panel': (r, p) => { r.state.panel = null; },
    'no point': (r, p) => {},
    'panel busy': (r, p) => { r.panel.isBusy = true; },
    'applying': (r, p) => { r.state.applying = true; },
    'closed': (r, p) => { r.state.closed = true; },
    'no map': (r, p) => { r.state.map = null; },
    'notes loading': (r, p) => { r.state.notesLoading = true; },
    'a chain is live': (r, p) => { r.runner.current = {}; },
    'a different point is kept': (r, p) => { r.panel.point = point(); },
    'another conversation': (r, p) => { p.conversationId = 'other'; }
  };
  for (const [name, change] of Object.entries(cases)) {
    const r = rig();
    const p = point();
    r.panel.point = p;
    change(r, p);
    const message = name === 'no point' ? { text: 'a' } : { text: 'a', resume: p };
    assert.equal(r.runner.resumeChatChain(message), false, name);
    assert.equal(r.state.sends.length, 0, name);
    assert.equal(r.log.filter(e => e[0] === 'dropResume').length, 0, name);
  }
  const r = rig();
  r.panel.point = point();
  assert.equal(r.panel.point !== null, true);
});

test('resumeChatChain: the point is dropped before one send(origin); a second press sends nothing', () => {
  const r = rig();
  const p = point();
  r.panel.point = p;
  assert.equal(r.runner.resumeChatChain({ text: 'a', resume: p }), true);
  assert.deepEqual(r.log.map(e => e[0]), ['dropResume', 'send']);
  assert.equal(r.state.sends[0].length, 1);
  const sent = r.state.sends[0][0];
  assert.equal(sent.text, 'go on');
  assert.deepEqual(sent.selectedIds, ['a']);
  assert.equal(sent.chain.resumed, true);
  assert.equal(sent.chain.seq, 0);
  assert.deepEqual(sent.chain.aiSelection, ['a']);
  assert.equal(sent.chain.state.round, 2);
  assert.equal(sent.chain.state.maxRounds, 8);
  assert.equal(sent.chain.continuation.remaining, 'rest');
  assert.equal(r.runner.resumeChatChain({ text: 'a', resume: p }), false);
  assert.equal(r.state.sends.length, 1);
});

test('resumeChatChain: the toggle of the moment decides the segment and the selection falls back to the canvas', () => {
  const r = rig({ autoApply: true });
  const p = point({ selectedIds: ['gone'], round: 9, maxRounds: 16 });
  r.panel.point = p;
  assert.equal(r.runner.resumeChatChain({ text: 'a', resume: p }), true);
  const sent = r.state.sends[0][0];
  assert.deepEqual(sent.selectedIds, ['sel']);
  assert.equal('aiSelection' in sent.chain, false);
  assert.equal(sent.chain.state.autoApply, true);
  assert.equal(sent.chain.state.maxRounds, 60);
});

test('chainForRound: an automatic round of the same seq continues the live chain and updates its fields', () => {
  const r = rig();
  const run = r.runner.chainForRound(undefined, { ...ANCHOR }, 'one');
  assert.equal(run.seq, 1);
  const origin = { seq: 1, state: run.state, continuation: { round: 2, maxRounds: 8, remaining: 'rem', lastResults: [], research: [] } };
  const again = r.runner.chainForRound(origin, { path: 'Maps/B/Map.md', id: 'm2' }, 'two');
  assert.equal(again, run);
  assert.equal(r.runner.seq, 1);
  assert.deepEqual(run.anchor, { path: 'Maps/B/Map.md', id: 'm2' });
  assert.equal(run.message, 'two');
  assert.equal(run.replyRemaining, 'rem');
  assert.equal(run.roundRemaining, 'rem');
  assert.equal(ends(r.log).length, 0);
});

test('chainForRound: a new message while a chain lives ends it as user_took_over first; seq counts up only for a new run', () => {
  const r = rig();
  const live = r.runner.chainForRound(undefined, { ...ANCHOR }, 'one');
  live.replyRemaining = 'x';
  const next = r.runner.chainForRound(undefined, { ...ANCHOR }, 'two');
  assert.equal(next.seq, 2);
  assert.equal(r.runner.current, next);
  assert.equal(live.state.phase, 'ended');
  assert.equal(ends(r.log).length, 1);
  assert.equal(ends(r.log)[0][1], 'user_took_over');
  // A retry of an old round (seq 1) while seq 2 is alive and in its round: that chain ends first, then a new run is made.
  const old = { seq: 1, state: { ...live.state, phase: 'ended' }, createdIds: ['n1'], continuation: { round: 2, maxRounds: 8, remaining: 'r', lastResults: [], research: [] } };
  next.replyRemaining = 'y';
  const retried = r.runner.chainForRound(old, { ...ANCHOR }, 'one');
  assert.equal(retried.seq, 3);
  assert.equal(next.state.phase, 'ended');
  assert.equal(retried.state.phase, 'round');
  assert.deepEqual([...retried.createdIds], ['n1']);
  assert.equal(retried.replyRemaining, 'r');
  assert.equal(r.runner.seq, 3);
});

test('settle: a changed path, map or turn ends the chain as map_changed (and the research is not stopped)', () => {
  const cases = {
    'path': r => { r.state.path = 'Maps/Z/Map.md'; },
    'map id': r => { r.state.map = { ...r.state.map, id: 'm9' }; },
    'turn gone': r => { r.panel.turns.clear(); }
  };
  for (const [name, change] of Object.entries(cases)) {
    const r = rig();
    const { run } = waiting(r, 1, { researchKeys: new Set(['k']) });
    run.turn = { id: 't' };
    r.panel.turns.add(run.turn);
    change(r);
    r.runner.settleChainWait(run, { expand: { succeeded: 1, failed: 0 } }, []);
    assert.equal(ends(r.log)[0][1], 'map_changed', name);
    assert.equal(r.state.sends.length, 0, name);
    assert.deepEqual(r.state.stops, [], name);
    assert.equal(r.runner.current, null, name);
  }
  const r = rig();
  const { run } = waiting(r, 1);
  r.state.panel = null;
  r.runner.settleChainWait(run, { expand: { succeeded: 1, failed: 0 } }, []);
  assert.equal(events(r.log)[0][2].reason, 'map_changed', 'no panel');
  assert.equal(r.state.sends.length, 0);
});

test('settle: a healthy chain clears the wait, keeps the waited work and starts the next round with send(origin)', () => {
  const r = rig();
  const { run } = waiting(r, 1);
  run.chips = [{ id: 'chip' }];
  run.aiSelection = ['a', 'gone'];
  r.runner.settleChainWait(run, { expand: { succeeded: 1, failed: 0 } }, [{ id: 'x0', title: 'X0', status: 'succeeded' }]);
  assert.equal(run.timer, null);
  assert.equal(clock.timers[0].cleared, true);
  assert.equal(run.waitShown, false);
  assert.equal(r.state.sends.length, 1);
  const sent = r.state.sends[0];
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, 'do it');
  assert.deepEqual(sent[0].chips, [{ id: 'chip' }]);
  assert.deepEqual(sent[0].selectedIds, ['a']);
  assert.equal(sent[0].chain.seq, run.seq);
  assert.deepEqual(sent[0].chain.aiSelection, ['a', 'gone']);
  assert.equal(sent[0].chain.continuation.round, 2);
  assert.equal(sent[0].chain.continuation.remaining, 'more');
  assert.deepEqual(sent[0].chain.continuation.research, [{ id: 'x0', title: 'X0', status: 'succeeded' }]);
  assert.equal(run.work, null);
  assert.equal(ends(r.log).length, 0);
});

test('next round: a changed map ends as map_changed; a busy panel or an applying plan ends as user_took_over; nothing is sent', () => {
  const cases = {
    'path': [r => { r.state.path = 'Maps/Z/Map.md'; }, 'map_changed'],
    'closed': [r => { r.state.closed = true; }, null],
    'busy': [r => { r.panel.isBusy = true; }, 'user_took_over'],
    'applying': [r => { r.state.applying = true; }, 'user_took_over']
  };
  for (const [name, [change, reason]] of Object.entries(cases)) {
    const r = rig();
    const { run } = waiting(r, 1);
    change(r);
    r.runner.startNextRound(run, 2, 'more');
    assert.equal(r.state.sends.length, 0, name);
    if (reason) assert.equal(ends(r.log)[0][1], reason, name);
    assert.equal(run.state.phase, 'ended', name);
  }
});

test('end: the timer is cleared and current is null; a closed view touches neither the panel nor the record', () => {
  const r = rig();
  const { run } = waiting(r, 1);
  assert.equal(typeof run.timer, 'number');
  r.runner.interruptChain(run, 'stopped');
  assert.equal(clock.timers[0].cleared, true);
  assert.equal(run.timer, null);
  assert.equal(r.runner.current, null);
  assert.equal(run.state.phase, 'ended');
  assert.equal(run.waitShown, false);

  const c = rig();
  const closed = waiting(c, 1);
  c.state.closed = true;
  const before = c.log.length;
  c.runner.interruptChain(closed.run, 'map_changed');
  assert.equal(c.log.length, before, 'no panel call, no record');
  assert.equal(c.runner.current, null);
  assert.equal(clock.timers[0].cleared, true);
  assert.equal(closed.run.state.phase, 'ended');
});

test('end: chain_end is recorded only when the chain shows, with calls only for auto-apply; the notice follows the reason', () => {
  const r = rig();
  const quiet = r.runner.chainForRound(undefined, { ...ANCHOR }, 'one');
  r.runner.endChatChain(quiet, 'stopped', '');
  assert.equal(events(r.log).length, 0);
  assert.equal(ends(r.log).length, 0);

  const a = rig({ autoApply: true });
  const shown = a.runner.chainForRound(undefined, { ...ANCHOR }, 'one');
  shown.replyRemaining = 'left';
  shown.state = { ...shown.state, round: 2 };
  a.runner.interruptChain(shown, 'stopped');
  assert.deepEqual(events(a.log)[0].slice(1), ['chain_end', { reason: 'stopped', round: 2, remaining: 'left', calls: 0 }]);
  assert.equal(ends(a.log)[0].length, 5);
  assert.equal(a.log.filter(e => e[0] === 'offerResume').length, 1);

  const n = rig();
  const plain = n.runner.chainForRound(undefined, { ...ANCHOR }, 'one');
  plain.replyRemaining = 'left';
  n.runner.interruptChain(plain, 'failed');
  assert.deepEqual(events(n.log)[0].slice(1), ['chain_end', { reason: 'failed', round: 1, remaining: 'left' }]);
  assert.equal(ends(n.log)[0].length, 4);
  assert.equal(n.log.filter(e => e[0] === 'offerResume').length, 0, 'a failed round has its Retry button');
});

test('finishChatRound: queued follow-ups end the chain as user_took_over, then flushSteers(true); otherwise the chain advances', () => {
  const r = rig({ queued: true });
  const { run } = waiting(r, 1);
  r.log.length = 0;
  r.runner.finishChatRound(run, roundOf(newWork()));
  assert.deepEqual(r.log.map(e => e[0]).filter(k => k !== 'event' && k !== 'offerResume' && k !== 'setChainWaiting'), ['endChain', 'flushSteers']);
  assert.equal(ends(r.log)[0][1], 'user_took_over');
  assert.deepEqual(r.log.find(e => e[0] === 'flushSteers'), ['flushSteers', true]);
  assert.equal(r.state.sends.length, 0);

  const q = rig();
  const run2 = q.runner.chainForRound(undefined, { ...ANCHOR }, 'one');
  const work = newWork({ researchTargets: 1, research: [deferred().promise] });
  q.runner.finishChatRound(run2, roundOf(work));
  assert.equal(run2.state.phase, 'waiting');
  assert.equal(q.state.flushes, 1);
  assert.equal(ends(q.log).length, 0);
});

test('advanceChain: counts the round (calls with the diagrams port), keeps created ids and AI selection, shows the flow for auto-apply', () => {
  const r = rig({ autoApply: true, diagrams: false });
  const run = r.runner.chainForRound(undefined, { ...ANCHOR }, 'one');
  const work = newWork({ created: ['n1'], selected: ['a'], expand: [{ id: 'x', title: 'X', path: 'x.md', done: deferred().promise }] });
  const research = { kind: 'run_map_action', action: 'research_standard', nodeIds: ['a', 'b'], source: 'web' };
  r.runner.advanceChain(run, roundOf(work, {
    result: { reply: '', actions: [research], remaining: 'more', progress: { steps: [{ text: 's', status: 'open' }], notes: [] } },
    lines: [{ status: 'done', text: 'Research 2' }]
  }));
  assert.deepEqual([...run.createdIds], ['n1']);
  assert.deepEqual(run.aiSelection, ['a']);
  assert.equal(run.state.phase, 'waiting');
  assert.equal(run.state.calls, 3, 'the request plus the two researches (diagrams off: one call each)');
  assert.equal(r.log.filter(e => e[0] === 'setFlowProgress').length, 1);
  assert.equal(r.log.find(e => e[0] === 'setFlowProgress')[1].maxCalls, 300);
});

test('stopChainWork aborts the controller and stops every research key; without work it does nothing', () => {
  const r = rig();
  const run = r.runner.chainForRound(undefined, { ...ANCHOR }, 'one');
  r.runner.stopChainWork(run);
  assert.deepEqual(r.state.stops, []);
  run.work = newWork({ researchKeys: new Set(['k1', 'k2']) });
  r.runner.stopChainWork(run);
  assert.equal(run.work.controller.signal.aborted, true);
  assert.deepEqual(r.state.stops, ['k1', 'k2']);
});

// ---- place_image: the runner waits for the canvas image and carries it into the next round once (canvas-image-anchors P2) ----
const imageRound = (r, gate, extra = {}) => {
  const run = r.runner.chainForRound(undefined, { ...ANCHOR }, 'one sentence');
  const work = newWork({ canvasImage: gate ? gate.promise : null, ...extra });
  run.work = work;
  r.runner.advanceChain(run, roundOf(work, { result: { reply: '', actions: [{ kind: 'place_image', direction: 'x' }], remaining: 'then look at it' }, lines: [{ status: 'done' }] }));
  return { run, work };
};
const carried = send => send[0].imageId;
test('image: a round whose place_image is pending waits, then the next round carries the new id once', async () => {
  const r = rig();
  const gate = deferred();
  const { run } = imageRound(r, gate);
  assert.equal(run.state.phase, 'waiting');
  assert.deepEqual(r.log.filter(e => e[0] === 'setChainWaiting')[0][1].kinds, ['image']);
  assert.equal(r.state.sends.length, 0);
  gate.resolve('img-new');
  await flush();
  assert.equal(r.state.sends.length, 1);
  assert.equal(carried(r.state.sends[0]), 'img-new');
  assert.equal(run.attachImageId, undefined, 'used up as it is sent');
  // Round 3 (chain origin of the next round) carries nothing.
  const run3 = r.runner.chainForRound(r.state.sends[0][0].chain, { ...ANCHOR }, 'one sentence');
  assert.equal(run3, run);
  const work = newWork({ expand: [{ id: 'x', title: 'X', path: 'p', done: Promise.resolve({ status: 'succeeded', titles: [] }) }] });
  run3.work = work;
  r.runner.advanceChain(run3, roundOf(work));
  await flush();
  assert.equal(r.state.sends.length, 2);
  assert.equal('imageId' in r.state.sends[1][0], false);
  assert.equal(r.state.sends[1][0].imageId, undefined);
});
test('image: a failed placement (null or a rejected promise) goes on without a picture', async () => {
  for (const settle of [gate => gate.resolve(null), gate => gate.reject(new Error('boom'))]) {
    const r = rig();
    const gate = {};
    gate.promise = new Promise((resolve, reject) => { gate.resolve = resolve; gate.reject = reject; });
    imageRound(r, gate);
    settle(gate);
    await flush();
    assert.equal(r.state.sends.length, 1);
    assert.equal(carried(r.state.sends[0]), undefined);
    assert.equal(ends(r.log).length, 0);
  }
});
test('image: Stop or a new message while waiting carries no picture and starts no next round, even when the placement lands later', async () => {
  for (const reason of ['stopped', 'user_took_over']) {
    const r = rig();
    const gate = deferred();
    const { run } = imageRound(r, gate);
    r.runner.interruptChain(run, reason);
    gate.resolve('late');
    await flush();
    assert.equal(r.state.sends.length, 0, reason);
    assert.equal(run.attachImageId, undefined, reason);
    assert.equal(ends(r.log).length, 1, reason);
  }
});
test('image: the image deleted before the next round is not carried (the view tells through imageExists)', async () => {
  const r = rig({ imageExists: id => id !== 'img-gone' });
  const gate = deferred();
  imageRound(r, gate);
  gate.resolve('img-gone');
  await flush();
  assert.equal(r.state.sends.length, 1);
  assert.equal(carried(r.state.sends[0]), undefined);
});
test('image: a changed map while waiting ends the chain and carries nothing', async () => {
  const r = rig();
  const gate = deferred();
  imageRound(r, gate);
  r.state.map = { id: 'other', aiMode: 'standard', nodes: [] };
  gate.resolve('img-new');
  await flush();
  assert.equal(r.state.sends.length, 0);
});
test('image: the carried id is the one the chain got, whatever the canvas selection is', async () => {
  const r = rig({ selection: ['topic-1'] });
  const gate = deferred();
  imageRound(r, gate);
  gate.resolve('img-new');
  await flush();
  assert.equal(carried(r.state.sends[0]), 'img-new');
});
test('image: research started in the same round is waited for with the image; the picture rides the next round only', async () => {
  const r = rig();
  const gate = deferred();
  const research = deferred();
  const { run } = imageRound(r, gate, { researchTargets: 1, research: [research.promise] });
  assert.deepEqual(r.log.filter(e => e[0] === 'setChainWaiting')[0][1].kinds, ['research', 'image']);
  gate.resolve('img-new');
  await flush();
  assert.equal(r.state.sends.length, 0, 'research still running');
  research.resolve({ kind: 'settled', succeeded: 1, failed: 0, stopped: 0, topics: [{ id: 'a', title: 'A', status: 'succeeded' }] });
  await flush();
  assert.equal(carried(r.state.sends[0]), 'img-new');
  assert.equal(run.attachImageId, undefined);
});
