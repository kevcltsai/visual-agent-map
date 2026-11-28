// TopicChatRun: the topic chat's free question and the end of a run (entry state machine) on fake ports. No UI, no vault, no AI.
const { test } = require('node:test');
const strict = require('node:assert/strict');
// The module is loaded in its own vm realm: compare by value across realms.
const plain = value => JSON.parse(JSON.stringify(value));
const assert = Object.assign(Object.create(strict), { deepEqual: (a, b, m) => strict.deepEqual(plain(a), plain(b), m) });
const { load } = require('./support-replay.cjs');
const S = require('./support.cjs');

const { TopicChatRun } = load('experiences/visual-map/topic-chat-run.ts', { obsidian: S.obsidian });
const { TopicChatSteers } = load('experiences/visual-map/topic-chat-steer.ts', { obsidian: S.obsidian });

const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; let reject; const promise = new Promise((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; };
const NODES = [
  { id: 'root', parentId: null, path: 'root.md' },
  { id: 'c1', parentId: 'root', path: 'c1.md' },
  { id: 'other', parentId: null, path: 'other.md' }
];
const addChild = { kind: 'add_child', parentId: 'root', title: 'T' };
const addOut = { kind: 'add_child', parentId: 'other', title: 'T' };
const ignored = { kind: 'read_md_file', path: 'a.md' };
const del = { kind: 'delete_topic', nodeId: 'c1' };
const reply = (actions = [], text = 'R') => ({ reply: text, actions, remaining: 'none', changeRequested: true });
const request = () => ({ context: { parents: [], selectedCount: 0, basis: 'x' } });

function newEntry(extra = {}) {
  return {
    nodeId: 'root', mapId: 'm1', mapPath: 'Maps/A/Map.md',
    session: { turns: [], mode: 'standard', running: true, draftKind: null, draftText: '' },
    watchers: new Set(), runningTurnId: 'turn1', ...extra
  };
}

function rig(options = {}) {
  const log = [];
  const state = {
    closed: false, path: 'Maps/A/Map.md', mapId: 'm1', win: null, key: 'topic-chat-ask:7', taskKey: 0,
    map: { id: 'm1', nodes: NODES, aiMode: undefined },
    chat: async () => reply([addChild]),
    build: async () => request(),
    apply: async () => [{ status: 'done', text: 'ok' }],
    follow: async () => true,
    ...options
  };
  const ports = {
    closed: () => state.closed,
    path: () => state.path,
    map: () => (state.map === null ? null : { ...state.map, id: state.mapId }),
    taskKey: () => { log.push(['taskKey']); state.taskKey++; return state.key; },
    registerTask: (key, controller) => log.push(['register', key, controller]),
    unregisterTask: key => log.push(['unregister', key]),
    requestChat: (...args) => { log.push(['chat']); return state.chat(...args); },
    errorText: error => ({ text: `E:${error.message}`, wrapped: false }),
    notice: text => log.push(['notice', text]),
    addDiagrams: () => true,
    buildRequest: (...args) => { log.push(['build']); return state.build(...args); },
    applyActions: (...args) => { log.push(['apply']); state.applyArgs = args; return state.apply(...args); },
    runAction: (...args) => { log.push(['runAction', ...args]); return Promise.resolve({ status: 'done', text: 'x' }); },
    window: entry => state.win,
    notify: () => log.push(['notify']),
    writeLine: (entry, line) => log.push(['line', line]),
    followUp: (entry, node, steers) => { log.push(['followUp', entry.submitting]); return state.follow(entry, node, steers); }
  };
  const hooks = { begin: c => log.push(['hbegin', c]), end: () => log.push(['hend']) };
  const run = new TopicChatRun(ports);
  const live = () => !state.closed && state.mapId === 'm1';
  const entry = newEntry();
  const steers = new TopicChatSteers();
  entry.steers = steers;
  const controller = new AbortController();
  const ask = (text = 'hello', mode = 'standard') =>
    run.ask(entry, NODES[0], {}, mode, text, controller, 'en', live, hooks, steers);
  return { run, state, log, entry, steers, controller, hooks, ask, live };
}
const names = log => log.map(item => item[0]);
const lines = r => r.log.filter(item => item[0] === 'line').map(item => item[1]);
const lastTurn = r => r.entry.session.turns[r.entry.session.turns.length - 1];

test('1 build fails without abort: no register, no hooks.begin, failed with errorText, Notice when the window is closed', async () => {
  const r = rig({ build: async () => { throw new Error('boom'); } });
  await r.ask();
  assert.ok(!names(r.log).includes('register'));
  assert.ok(!names(r.log).includes('hbegin'));
  assert.ok(!names(r.log).includes('hend'));
  assert.equal(lastTurn(r).text, 'Did not finish: E:boom');
  assert.equal(lines(r)[0].status, 'failed');
  assert.deepEqual(r.log.filter(item => item[0] === 'notice'), [['notice', 'Did not finish: E:boom']]);
  assert.equal(r.state.taskKey, 1);
});

test('2 build fails after abort: stopped, no Notice', async () => {
  const r = rig();
  r.state.build = async () => { r.controller.abort(); throw new Error('late'); };
  await r.ask();
  assert.equal(lastTurn(r).text, 'Stopped.');
  assert.equal(lines(r)[0].status, 'stopped');
  assert.ok(!names(r.log).includes('notice'));
});

test('3 normal reply: register before hooks.begin, unregister and hooks.end once each, key from taskKey', async () => {
  const r = rig();
  await r.ask();
  const n = names(r.log);
  assert.ok(n.indexOf('taskKey') < n.indexOf('build'));
  assert.ok(n.indexOf('build') < n.indexOf('register'));
  assert.ok(n.indexOf('register') < n.indexOf('hbegin'));
  assert.equal(n.filter(x => x === 'unregister').length, 1);
  assert.equal(n.filter(x => x === 'hend').length, 1);
  assert.ok(n.indexOf('unregister') < n.indexOf('hend'));
  assert.ok(n.indexOf('hend') < n.indexOf('apply'));
  const reg = r.log.find(item => item[0] === 'register');
  assert.equal(reg[1], 'topic-chat-ask:7');
  assert.equal(reg[2], r.controller);
  assert.equal(r.log.find(item => item[0] === 'unregister')[1], 'topic-chat-ask:7');
  assert.equal(r.entry.session.running, false);
  assert.equal(lines(r)[0].status, 'done');
});

test('4 requestChat throws: end runs once, failed', async () => {
  const r = rig({ chat: async () => { throw new Error('net'); } });
  await r.ask();
  const n = names(r.log);
  assert.equal(n.filter(x => x === 'unregister').length, 1);
  assert.equal(n.filter(x => x === 'hend').length, 1);
  assert.equal(lastTurn(r).text, 'Did not finish: E:net');
  assert.equal(lines(r)[0].status, 'failed');
});

test('5 abort while requesting, reply arrives later: no apply, stopped line written', async () => {
  const d = deferred();
  const r = rig({ chat: () => d.promise });
  const p = r.ask();
  await flush();
  r.controller.abort();
  d.resolve(reply([addChild]));
  await p;
  assert.ok(!names(r.log).includes('apply'));
  assert.equal(lastTurn(r).text, 'Stopped.');
  assert.equal(lines(r)[0].status, 'stopped');
  assert.equal(lastTurn(r).markdown, true);
});

test('6 view closed when the reply arrives: nothing written, no notify, no Notice; turn id cleared, running off', async () => {
  const d = deferred();
  const r = rig({ chat: () => d.promise });
  const p = r.ask();
  await flush();
  r.state.closed = true;
  d.resolve(reply([addChild]));
  await p;
  assert.deepEqual(lines(r), []);
  assert.equal(r.entry.session.turns.length, 0);
  assert.ok(!names(r.log).includes('notify'));
  assert.ok(!names(r.log).includes('notice'));
  assert.ok(!names(r.log).includes('apply'));
  assert.equal(r.entry.runningTurnId, null);
  assert.equal(r.entry.session.running, false);
});

test('7 map changed (and a missing map): same as closed', async () => {
  const d = deferred();
  const r = rig({ chat: () => d.promise });
  const p = r.ask();
  await flush();
  r.state.mapId = 'm2';
  d.resolve(reply([addChild]));
  await p;
  assert.deepEqual(lines(r), []);
  assert.ok(!names(r.log).includes('notice'));
  assert.equal(r.entry.runningTurnId, null);
  const g = rig();
  g.state.map = null;
  await g.ask();
  assert.ok(!names(g.log).includes('apply'));
  assert.equal(lines(g)[0].status, 'stopped');
});

test('8 stream-mode: json turns steers.live off, stream-json does not', async () => {
  for (const [mode, off] of [['json', true], ['json-fallback', true], ['stream-json', false]]) {
    const r = rig();
    const calls = [];
    const original = r.steers.live.bind(r.steers);
    r.steers.live = on => { calls.push(on); original(on); };
    r.state.chat = async (req, signal, progress, onEvent) => { onEvent({ kind: 'other' }); onEvent({ kind: 'stream-mode', mode }); return reply(); };
    await r.ask();
    assert.deepEqual(calls, off ? [false] : [], mode);
  }
});

test('9 steer entries: close finishes before apply; message carries the delivered additions; onSteer binds', async () => {
  const r = rig();
  let sent = [];
  r.state.chat = async (req, signal, progress, onEvent, onSteer) => {
    onSteer(async text => { sent.push(text); });
    r.steers.add('extra');
    await flush();
    return reply([addChild]);
  };
  let closedAtApply = null;
  r.state.apply = async () => { closedAtApply = r.steers.waits; return [{ status: 'done', text: 'ok' }]; };
  await r.ask('hello');
  assert.deepEqual(sent, ['extra']);
  assert.equal(closedAtApply, true);
  assert.equal(r.state.applyArgs[0].message, 'hello\n\nextra');
});

test('10 out-of-scope action: not applied, sentence gets the out_of_scope line', async () => {
  const r = rig({ chat: async () => reply([addOut], 'R') });
  await r.ask();
  assert.ok(!names(r.log).includes('apply'));
  assert.equal(lastTurn(r).text, 'R\n\nParts outside this topic were skipped.');
  assert.equal(lines(r)[0].status, 'done');
});

test('11 reply needs a plan: not applied, too_big / notice / done / plan; endSteers does not follow up', async () => {
  const r = rig({ chat: async () => reply([del]) });
  r.entry.readsSources = true;
  r.steers.live(false);
  r.steers.add('q');
  await r.ask();
  assert.ok(!names(r.log).includes('apply'));
  assert.equal(lastTurn(r).text, 'This request touches too much; please use the AI chat in the left sidebar.');
  assert.deepEqual(r.entry.steerEnd, { status: 'done', plan: true });
  assert.deepEqual(r.log.filter(item => item[0] === 'notice').length, 1);
  assert.equal(r.entry.session.running, true);
  await r.run.endSteers(r.entry, r.steers, 'turn1', r.live);
  assert.ok(!names(r.log).includes('followUp'));
  assert.equal(r.entry.session.draftText, 'q');
  assert.equal(r.entry.session.running, false);
});

test('12 allowed action failed: failed with its line; an ignored action line is not a problem', async () => {
  const r = rig({ chat: async () => reply([addChild], 'R'), apply: async () => [{ status: 'failed', text: 'bad' }] });
  await r.ask();
  assert.equal(lastTurn(r).text, 'R\n\nbad');
  assert.equal(lines(r)[0].status, 'failed');
  const g = rig({ chat: async () => reply([addChild, ignored], 'R'), apply: async () => [{ status: 'done', text: 'ok' }, { status: 'failed', text: 'skip' }] });
  await g.ask();
  assert.equal(lastTurn(g).text, 'R');
  assert.equal(lines(g)[0].status, 'done');
  // A line added after the actions counts.
  const h = rig({ chat: async () => reply([addChild], 'R'), apply: async () => [{ status: 'done', text: 'ok' }, { status: 'failed', text: 'extra' }] });
  await h.ask();
  assert.equal(lastTurn(h).text, 'R\n\nextra');
});

test('13 empty reply and no lines: result_unknown', async () => {
  const r = rig({ chat: async () => reply([], '  ') });
  await r.ask();
  assert.equal(lastTurn(r).text, 'See the topic itself for this result.');
  assert.equal(lines(r)[0].status, 'done');
});

test('14 abort while applying: stopped; alive turns false after the abort', async () => {
  const r = rig();
  let aliveBefore;
  r.state.apply = async (res, base, alive) => { aliveBefore = alive(); r.controller.abort(); assert.equal(alive(), false); return [{ status: 'done', text: 'ok' }]; };
  await r.ask();
  assert.equal(aliveBefore, true);
  assert.equal(lastTurn(r).text, 'Stopped.');
  assert.equal(lines(r)[0].status, 'stopped');
});

test('15 topicScope.run calls runAction with action.mode || mode, language and the signal', async () => {
  const r = rig();
  r.state.apply = async (res, base, alive, anchor, options) => {
    assert.equal(options.topicScope.rootId, 'root');
    assert.equal(options.context, base);
    await options.topicScope.run({ kind: 'run_map_action', action: 'expand', nodeIds: ['c1'], mode: 'quick' }, ['c1']);
    await options.topicScope.run({ kind: 'run_map_action', action: 'expand', nodeIds: ['c1'] }, ['c1']);
    return [{ status: 'done', text: 'ok' }];
  };
  await r.ask('hello', 'standard');
  const calls = r.log.filter(item => item[0] === 'runAction');
  assert.equal(calls[0][3], 'quick');
  assert.equal(calls[1][3], 'standard');
  assert.equal(calls[0][4], 'en');
  assert.equal(calls[0][5], r.controller.signal);
  assert.deepEqual(plain(calls[0][2]), ['c1']);
});

test('16 anchor path is read at apply time', async () => {
  const d = deferred();
  const r = rig({ chat: () => d.promise });
  const p = r.ask();
  await flush();
  r.state.path = 'Maps/B/Map.md';
  d.resolve(reply([addChild]));
  await p;
  assert.deepEqual(r.state.applyArgs[3], { path: 'Maps/B/Map.md', id: 'm1' });
});

test('17 settle with steers: running stays true, steerEnd set', async () => {
  const r = rig();
  r.steers.add('x');
  r.run.settle(r.entry, 'S', r.live, false, 'done');
  assert.equal(r.entry.session.running, true);
  assert.deepEqual(r.entry.steerEnd, { status: 'done', plan: false });
  const g = rig();
  g.entry.steerFolded = ['f'];
  g.run.settle(g.entry, 'S', g.live, false, 'done');
  assert.equal(g.entry.session.running, true);
  const h = rig();
  h.run.settle(h.entry, 'S', h.live, false, 'failed', true, true);
  assert.equal(h.entry.session.running, false);
  assert.deepEqual(h.entry.steerEnd, { status: 'failed', plan: true });
  assert.equal(h.entry.session.turns[0].markdown, true);
});

test('18 Notice only when asked and the window is closed', () => {
  const r = rig();
  r.state.win = { setInputText() {} };
  r.run.settle(r.entry, 'S', r.live, true, 'done');
  assert.ok(!names(r.log).includes('notice'));
  const g = rig();
  g.run.settle(g.entry, 'S', g.live, true, 'done');
  assert.deepEqual(g.log.filter(item => item[0] === 'notice'), [['notice', 'S']]);
  const h = rig();
  h.run.settle(h.entry, 'S', h.live, false, 'done');
  assert.ok(!names(h.log).includes('notice'));
});

function queued(r, ...texts) {
  r.steers.live(false);
  for (const text of texts) r.steers.add(text);
}

test('19 endSteers done with queued: submitting is true during followUp and false after; true keeps running and returns nothing', async () => {
  const r = rig();
  queued(r, 'q');
  r.run.settle(r.entry, 'S', r.live, false, 'done');
  r.log.length = 0;
  await r.run.endSteers(r.entry, r.steers, 'turn1', r.live);
  assert.deepEqual(r.log.filter(item => item[0] === 'followUp'), [['followUp', true]]);
  assert.equal(r.entry.submitting, false);
  assert.equal(r.entry.session.running, true);
  assert.equal(r.entry.session.draftText, '');
});

test('20 followUp refuses: draft gets the steer texts in front with a Notice (closed window); open window gets setInputText; running off and notify', async () => {
  const r = rig({ follow: async () => false });
  r.entry.session.draftText = 'old';
  queued(r, 'q1', 'q2');
  r.run.settle(r.entry, 'S', r.live, false, 'done');
  await r.run.endSteers(r.entry, r.steers, 'turn1', r.live);
  assert.equal(r.entry.session.draftText, 'q1\n\nq2\n\nold');
  assert.deepEqual(r.log.filter(item => item[0] === 'notice'), [['notice', 'Not sent. Your message is back in the box.']]);
  assert.equal(r.entry.session.running, false);
  assert.ok(names(r.log).includes('notify'));
  const g = rig({ follow: async () => false });
  const set = [];
  g.state.win = { setInputText: text => set.push(text) };
  g.entry.session.draftText = 'old';
  queued(g, 'q');
  g.run.settle(g.entry, 'S', g.live, false, 'done');
  await g.run.endSteers(g.entry, g.steers, 'turn1', g.live);
  assert.deepEqual(set, ['q\n\nold']);
  assert.ok(!names(g.log).includes('notice'));
});

test('21 stopped or failed: folded and queued go back to the draft, no Notice, no followUp', async () => {
  for (const status of ['stopped', 'failed']) {
    const r = rig();
    r.entry.steerFolded = ['f'];
    queued(r, 'q');
    r.run.settle(r.entry, 'S', r.live, false, status);
    await r.run.endSteers(r.entry, r.steers, 'turn1', r.live);
    assert.equal(r.entry.session.draftText, 'f\n\nq', status);
    assert.ok(!names(r.log).includes('followUp'));
    assert.ok(!names(r.log).includes('notice'));
    assert.equal(r.entry.session.running, false);
  }
});

test('22 card deleted: queued texts go back with a Notice', async () => {
  const r = rig();
  r.state.map = { id: 'm1', nodes: [], aiMode: undefined };
  queued(r, 'q');
  r.run.settle(r.entry, 'S', r.live, false, 'done');
  await r.run.endSteers(r.entry, r.steers, 'turn1', r.live);
  assert.ok(!names(r.log).includes('followUp'));
  assert.equal(r.entry.session.draftText, 'q');
  assert.equal(r.log.filter(item => item[0] === 'notice').length, 1);
  assert.equal(r.entry.session.running, false);
});

test('23 view not live: no steer lines, no follow-up', async () => {
  const r = rig();
  queued(r, 'q');
  r.run.settle(r.entry, 'S', r.live, false, 'done');
  r.state.closed = true;
  await r.run.endSteers(r.entry, r.steers, 'turn1', r.live);
  assert.deepEqual(lines(r).filter(line => line.type === 'steer'), []);
  assert.ok(!names(r.log).includes('followUp'));
  assert.equal(r.entry.session.draftText, 'q');
});

test('24 close() throws: runningTurnId set returns untouched; unset puts the texts back and finishes', async () => {
  const r = rig();
  queued(r, 'q');
  r.steers.close = async () => { throw new Error('x'); };
  r.entry.runningTurnId = 'next';
  await r.run.endSteers(r.entry, r.steers, 'turn1', r.live);
  assert.equal(r.entry.session.running, true);
  assert.equal(r.entry.session.draftText, '');
  assert.ok(!names(r.log).includes('notify'));
  const g = rig();
  queued(g, 'q');
  g.steers.close = async () => { throw new Error('x'); };
  g.entry.runningTurnId = null;
  await g.run.endSteers(g.entry, g.steers, 'turn1', g.live);
  assert.equal(g.entry.session.running, false);
  assert.equal(g.entry.session.draftText, 'q');
  assert.equal(g.log.filter(item => item[0] === 'notice').length, 1);
  assert.ok(names(g.log).includes('notify'));
});

test('25 steer lines: done writes folded then delivered with the turn id; otherwise only delivered', async () => {
  const make = async status => {
    const r = rig();
    r.entry.steerFolded = ['f'];
    r.steers.bind(async () => {});
    r.steers.add('d');
    await flush();
    r.run.settle(r.entry, 'S', r.live, false, status);
    r.log.length = 0;
    await r.run.endSteers(r.entry, r.steers, 'turn9', r.live);
    return lines(r).map(line => [line.type, line.id, line.text]);
  };
  assert.deepEqual(await make('done'), [['steer', 'turn9', 'f'], ['steer', 'turn9', 'd']]);
  assert.deepEqual(await make('failed'), [['steer', 'turn9', 'd']]);
});

test('26 null turn id: no steer line', async () => {
  const r = rig();
  r.entry.steerFolded = ['f'];
  r.steers.bind(async () => {});
  r.steers.add('d');
  await flush();
  r.run.settle(r.entry, 'S', r.live, false, 'done');
  r.log.length = 0;
  await r.run.endSteers(r.entry, r.steers, null, r.live);
  assert.deepEqual(lines(r), []);
});
