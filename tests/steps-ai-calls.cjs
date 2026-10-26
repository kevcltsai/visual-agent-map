// AiCalls: one model call's registration, exchange log entry, stop handling and cleanup, with a fake AiRuntime.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadWithAiCalls } = require('./support-ai-calls.cjs');
const { load } = require('./support-replay.cjs');

const mod = loadWithAiCalls('core/step-runner.ts');
const { translate } = load('i18n.ts');
const plain = value => JSON.parse(JSON.stringify(value));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const step = { id: 'test.step', version: 2, render: () => 'the prompt', parse: raw => raw };
const prepared = () => mod.prepareStep(step, {});

class RecordingMap extends Map {
  keysSet = [];
  set(key, value) { this.keysSet.push(key); return super.set(key, value); }
}

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const flush = () => new Promise(resolve => setImmediate(resolve));

/** An AiCalls with a recording exchange sink and a scripted runtime. `run(request)` is the runtime's behaviour. */
function harness({ run, logging = true } = {}) {
  const state = { logging, runtimeCalls: [], models: [] };
  const events = [];
  const sink = {
    begin: entry => events.push(['begin', entry]),
    sent: (id, request, prompt) => events.push(['sent', id, JSON.parse(request), prompt]),
    received: (id, response) => events.push(['received', id, response]),
    milestones: (id, data) => events.push(['milestones', id, { ...data }]),
    parsed: id => events.push(['parsed', id]),
    completed: id => events.push(['completed', id]),
    failed: (id, message) => events.push(['failed', id, message])
  };
  const runtime = {
    capabilities: mod.CODEX_CAPABILITIES,
    run: async request => {
      state.runtimeCalls.push(request);
      request.controls.onRequest?.({ via: 'runtime' });
      return run ? run(request, state) : 'reply';
    }
  };
  const active = new RecordingMap();
  const calls = new mod.AiCalls({ runtimeFor: model => { state.models.push(model); return runtime; }, exchanges: () => (state.logging ? sink : null), activeTasks: active });
  return { calls, events, state, active, names: () => events.map(event => event[0]) };
}

const options = (extra = {}) => ({ model: 'gpt-6-luna', effort: 'low', topic: 'A topic', taskName: 'test-task', signal: new AbortController().signal, localCodex: true, ...extra });

// ---- finishing ----
test('finish returns: one completed, and the callback value is the result', async () => {
  const h = harness();
  const result = await h.calls.run(prepared(), options(), raw => ({ parsed: raw }));
  assert.deepEqual(plain(result), { parsed: 'reply' });
  assert.deepEqual(h.names(), ['begin', 'sent', 'received', 'milestones', 'completed']);
  const [begin] = h.events;
  assert.deepEqual({ ...begin[1], id: undefined, startedAt: undefined }, { id: undefined, startedAt: undefined, topic: 'A topic', mode: 'task', model: 'gpt-6-luna', effort: 'low', step: 'test.step@2' });
  assert.deepEqual(h.events[1].slice(2), [{ request: { via: 'runtime' }, prompt: 'the prompt' }, 'the prompt']);
  assert.ok(h.events.every(event => event[0] === 'begin' || event[1] === begin[1].id), 'one id for the whole entry');
});

test('finish throws: one failed with the message, and the original error is rethrown', async () => {
  const h = harness();
  const boom = mod.makeError('finish boom');
  await assert.rejects(h.calls.run(prepared(), options(), () => { throw boom; }), error => error === boom);
  assert.deepEqual(h.names(), ['begin', 'sent', 'received', 'milestones', 'failed']);
  assert.equal(h.events[4][2], 'finish boom');
});

test('exchange.fail then return: one failed, no completed, and the value is still returned', async () => {
  const h = harness();
  const result = await h.calls.run(prepared(), options(), (_raw, exchange) => { exchange.fail('refused'); return 'kept'; });
  assert.equal(result, 'kept');
  assert.deepEqual(h.names().filter(name => name === 'failed' || name === 'completed'), ['failed']);
  assert.equal(h.events.find(event => event[0] === 'failed')[2], 'refused');
});

test('exchange.fail then throw: still exactly one failed', async () => {
  const h = harness();
  await assert.rejects(h.calls.run(prepared(), options(), (_raw, exchange) => { exchange.fail('first'); throw mod.makeError('second'); }), /second/);
  assert.deepEqual(h.events.filter(event => event[0] === 'failed').map(event => event[2]), ['first']);
  assert.equal(h.names().includes('completed'), false);
});

test('exchange.parsed is written before completed, once; after fail it is ignored', async () => {
  const h = harness();
  await h.calls.run(prepared(), options(), (_raw, exchange) => { exchange.parsed(); exchange.parsed(); return 1; });
  assert.deepEqual(h.names().slice(-2), ['parsed', 'completed']); assert.equal(h.names().filter(name => name === 'parsed').length, 1);
  const g = harness();
  await g.calls.run(prepared(), options(), (_raw, exchange) => { exchange.fail('no'); exchange.parsed(); return 1; });
  assert.equal(g.names().includes('parsed'), false);
});

test('exchange.id is the entry id while logging is on and undefined when it was off at the start', async () => {
  const on = harness(); let seen;
  await on.calls.run(prepared(), options(), (_raw, exchange) => { seen = exchange.id; });
  assert.equal(seen, on.events[0][1].id); assert.match(seen, UUID);
  const off = harness({ logging: false });
  await off.calls.run(prepared(), options(), (_raw, exchange) => { seen = exchange.id; });
  assert.equal(seen, undefined);
});

// ---- stopping ----
test('a reply after the stop is refused with the custom stopped error: no received, callback not called', async () => {
  const outer = new AbortController(); let finished = 0;
  const h = harness({ run: () => { outer.abort(); return 'late'; } });
  const stopped = mod.makeError('custom stopped');
  await assert.rejects(h.calls.run(prepared(), options({ signal: outer.signal, stopped: () => stopped }), () => { finished++; }), error => error === stopped);
  assert.equal(finished, 0);
  assert.deepEqual(h.names(), ['begin', 'sent', 'failed']); assert.equal(h.events[2][2], 'custom stopped');
});

test('the default stopped message is the localized "AI task cancelled"', async () => {
  const outer = new AbortController();
  const h = harness({ run: () => { outer.abort(); return 'late'; } });
  await assert.rejects(h.calls.run(prepared(), options({ signal: outer.signal }), () => 1), error => error.message === translate('en', 'ui.ai_task_cancelled'));
});

test('a runtime that rejects after the stop keeps its own error', async () => {
  const outer = new AbortController(); const boom = mod.makeError('runtime boom');
  const h = harness({ run: () => { outer.abort(); throw boom; } });
  await assert.rejects(h.calls.run(prepared(), options({ signal: outer.signal }), () => 1), error => error === boom);
  assert.deepEqual(h.events.filter(event => event[0] === 'failed').map(event => event[2]), ['runtime boom']);
});

test('the runtime gets its own signal; an already aborted caller signal arrives aborted and the caller signal is never aborted by AiCalls', async () => {
  const early = new AbortController(); early.abort();
  const h = harness({ run: request => { h.seen = request.controls.signal; return 'x'; } });
  await assert.rejects(h.calls.run(prepared(), options({ signal: early.signal }), () => 1));
  assert.equal(h.seen.aborted, true); assert.notEqual(h.seen, early.signal);
  const outer = new AbortController(); const g = harness({ run: request => { g.seen = request.controls.signal; return 'x'; } });
  await g.calls.run(prepared(), options({ signal: outer.signal }), () => 1);
  assert.equal(outer.signal.aborted, false); assert.notEqual(g.seen, outer.signal);
});

// ---- logging gate ----
test('logging off at the start stays off even if switched on mid-call; switched off mid-call writes nothing after begin', async () => {
  const off = harness({ logging: false, run: (_request, state) => { state.logging = true; return 'x'; } });
  await off.calls.run(prepared(), options(), () => 1);
  assert.deepEqual(off.events, []);
  const mid = harness({ run: (_request, state) => { state.logging = false; return 'x'; } });
  await mid.calls.run(prepared(), options(), () => 1);
  assert.deepEqual(mid.names(), ['begin', 'sent']);
});

// ---- registry ----
test('the registry holds the call under taskName:uuid while it runs, in the Map that was passed in, and every ending clears it', async () => {
  const hold = deferred();
  const h = harness({ run: () => hold.promise });
  const pending = h.calls.run(prepared(), options(), () => 1);
  await flush();
  assert.equal(h.calls.activeTasks, h.active); assert.equal(h.active.size, 1);
  const [key] = h.active.keys(); assert.ok(key.startsWith('test-task:')); assert.match(key.slice('test-task:'.length), UUID);
  hold.resolve('x'); await pending; assert.equal(h.active.size, 0);
  const fresh = new mod.AiCalls({ runtimeFor: () => { throw new Error('unused'); }, exchanges: () => null }).activeTasks;
  assert.equal(Object.prototype.toString.call(fresh), '[object Map]'); assert.equal(fresh.size, 0);

  const endings = {
    success: [harness(), () => 1],
    'runtime failure': [harness({ run: () => { throw mod.makeError('x'); } }), () => 1],
    'finish failure': [harness(), () => { throw mod.makeError('f'); }]
  };
  for (const [name, [fixture, finish]] of Object.entries(endings)) {
    await fixture.calls.run(prepared(), options(), finish).catch(() => {});
    assert.equal(fixture.active.size, 0, name);
  }
  const stopped = harness({ run: () => { stopped.calls.stopAll(); return 'x'; } });
  await assert.rejects(stopped.calls.run(prepared(), options(), () => 1));
  assert.equal(stopped.active.size, 0, 'stop');
  const invalid = harness();
  await assert.rejects(invalid.calls.run(prepared(), options({ validate: () => { throw mod.makeError('no model'); } }), () => 1), /no model/);
  assert.equal(invalid.active.size, 0, 'validate failure'); assert.equal(invalid.state.runtimeCalls.length, 0);
  assert.deepEqual(invalid.names(), ['begin', 'failed']);
});

test('stopAll aborts every running call and keys others registered, leaves the foreign entry, and each call removes only its own key', async () => {
  const hold = deferred(); const seen = [];
  const h = harness({ run: request => { seen.push(request.controls.signal); return hold.promise; } });
  const foreign = new AbortController(); h.active.set('foreign:1', foreign);
  const one = h.calls.run(prepared(), options({ taskName: 'one' }), () => 1);
  const two = h.calls.run(prepared(), options({ taskName: 'two' }), () => 2);
  await flush(); assert.equal(h.active.size, 3);
  h.calls.stopAll();
  assert.equal(foreign.signal.aborted, true); assert.deepEqual(seen.map(signal => signal.aborted), [true, true]);
  assert.equal(h.active.size, 3, 'stopAll only aborts');
  hold.resolve('late');
  await assert.rejects(one); await assert.rejects(two);
  assert.deepEqual([...h.active.keys()], ['foreign:1']);
});

// ---- run(prepared) ----
test('anything but a prepared step is refused before registration, logging or the runtime', async () => {
  const h = harness();
  for (const bad of ['a prompt', { step, input: {}, prompt: 'forged', parse: () => 1 }, undefined])
    await assert.rejects(h.calls.run(bad, options(), () => 1), /requires a step made by prepareStep/);
  assert.deepEqual(h.events, []); assert.equal(h.state.runtimeCalls.length, 0); assert.deepEqual(h.active.keysSet, []);
});

// ---- other options ----
test('exchangeId, extraMilestones (the runtime wins), afterReply and chained callbacks', async () => {
  const chained = [];
  const h = harness({ run: request => { request.controls.onMilestones({ stream: 'stream-json' }); return 'x'; } });
  await h.calls.run(prepared(), options({ exchangeId: 'fixed-id', extraMilestones: () => ({ stream: 'extra', slow: true }), task: { onRequest: data => chained.push(['request', data]), onMilestones: data => chained.push(['milestones', { ...data }]), textOnly: true } }), () => 1);
  assert.equal(h.events[0][1].id, 'fixed-id');
  const milestones = h.events.find(event => event[0] === 'milestones')[2];
  assert.equal(typeof milestones.receivedAt, 'string'); delete milestones.receivedAt;
  assert.deepEqual(milestones, { stream: 'stream-json', slow: true });
  assert.deepEqual(chained, [['request', { via: 'runtime' }], ['milestones', { stream: 'stream-json' }]]);
  assert.equal(h.state.runtimeCalls[0].controls.textOnly, true);

  const g = harness();
  await assert.rejects(g.calls.run(prepared(), options({ afterReply: () => { throw mod.makeError('refused reply'); } }), () => 1), /refused reply/);
  assert.deepEqual(g.names(), ['begin', 'sent', 'failed']);
});

test('requestLog "request" stores only the runtime request object', async () => {
  const h = harness();
  await h.calls.run(prepared(), options({ requestLog: 'request', mode: 'custom' }), () => 1);
  assert.deepEqual(h.events[1].slice(2), [{ via: 'runtime' }, 'the prompt']);
  assert.equal(h.events[0][1].mode, 'custom');
});

// ---- adapters ----
test('aiRuntimeForModel: Claude gets the id without its prefix; Codex gets the localCodex flag; nothing starts before run', async () => {
  const seen = []; let claudeGets = 0; const codexGets = [];
  const sources = {
    claude: () => { claudeGets++; return { runTask: async (...args) => { seen.push(['claude', ...args.slice(0, 4)]); return 'c'; } }; },
    codex: local => { codexGets.push(local); return { runTask: async (...args) => { seen.push(['codex', ...args.slice(0, 4)]); return 'x'; } }; }
  };
  const claude = mod.aiRuntimeForModel('claude:sonnet', sources), codex = mod.aiRuntimeForModel('gpt-6-luna', sources);
  assert.equal(claudeGets, 0); assert.deepEqual(codexGets, []);
  const controls = {};
  assert.equal(await claude.run({ prompt: 'p', model: 'claude:sonnet', effort: 'low', schema: 's', controls, localCodex: true }), 'c');
  assert.equal(await codex.run({ prompt: 'p', model: 'gpt-6-luna', effort: 'high', controls, localCodex: true }), 'x');
  assert.equal(await codex.run({ prompt: 'p', model: 'gpt-6-luna', effort: 'high', controls, localCodex: false }), 'x');
  assert.deepEqual(seen, [['claude', 'p', 'sonnet', 'low', 's'], ['codex', 'p', 'gpt-6-luna', 'high', undefined], ['codex', 'p', 'gpt-6-luna', 'high', undefined]]);
  assert.equal(claudeGets, 1); assert.deepEqual(codexGets, [true, false]);
});

test('capabilities: Claude has no image generation, takes 1568px / 5 MiB images and a fixed effort list; Codex generates images and does not prewarm', () => {
  assert.deepEqual(plain(mod.CLAUDE_CAPABILITIES), { id: 'claude', imageGeneration: false, imageInput: { maxEdgePx: 1568, maxBytes: 5 * 1024 * 1024 }, webSearch: true, prewarm: true, fixedReasoningEfforts: ['low', 'medium', 'high'] });
  assert.deepEqual(plain(mod.CODEX_CAPABILITIES), { id: 'codex', imageGeneration: true, webSearch: true, prewarm: false });
  assert.equal(mod.aiRuntimeForModel('claude:opus', { claude: () => ({ runTask: async () => '' }), codex: () => ({ runTask: async () => '' }) }).capabilities, mod.CLAUDE_CAPABILITIES);
});

test('a sink whose begin throws: the original error rejects, nothing stays registered or listening, and the runtime never runs', async () => {
  const boom = mod.makeError('begin exploded');
  const controller = new AbortController();
  let added = 0, removed = 0;
  const add = controller.signal.addEventListener.bind(controller.signal), remove = controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.addEventListener = (type, ...rest) => { if (type === 'abort') added++; return add(type, ...rest); };
  controller.signal.removeEventListener = (type, ...rest) => { if (type === 'abort') removed++; return remove(type, ...rest); };
  const runtimeCalls = [];
  const runtime = { capabilities: mod.CODEX_CAPABILITIES, run: async request => { runtimeCalls.push(request); return 'reply'; } };
  const sink = { begin: () => { throw boom; }, sent() {}, received() {}, milestones() {}, parsed() {}, completed() {}, failed() {} };
  const active = new RecordingMap();
  const calls = new mod.AiCalls({ runtimeFor: () => runtime, exchanges: () => sink, activeTasks: active });
  await assert.rejects(calls.run(prepared(), options({ signal: controller.signal }), raw => raw), error => error === boom);
  assert.equal(active.size, 0);
  assert.equal(added - removed, 0, 'the caller signal keeps no abort listener');
  assert.ok(added >= 1, 'the listener was added, so the removal is what is checked');
  assert.equal(runtimeCalls.length, 0);
});

test('capabilitiesFor returns the constants without calling any adapter get(); needs.imageGeneration refuses Claude only', () => {
  let claudeGets = 0, codexGets = 0;
  const sources = {
    claude: () => { claudeGets++; return { runTask: async () => '' }; },
    codex: () => { codexGets++; return { runTask: async () => '' }; }
  };
  const calls = new mod.AiCalls({ runtimeFor: model => mod.aiRuntimeForModel(model, sources), exchanges: () => null });
  assert.equal(calls.capabilitiesFor('claude:sonnet'), mod.CLAUDE_CAPABILITIES);
  assert.equal(calls.capabilitiesFor('gpt-6-luna'), mod.CODEX_CAPABILITIES);
  assert.equal(calls.capabilitiesFor('claude:sonnet', {}), mod.CLAUDE_CAPABILITIES);
  assert.equal(calls.capabilitiesFor('claude:sonnet', { imageGeneration: false }), mod.CLAUDE_CAPABILITIES);
  assert.equal(calls.capabilitiesFor('gpt-6-luna', { imageGeneration: true }), mod.CODEX_CAPABILITIES);
  assert.throws(() => calls.capabilitiesFor('claude:sonnet', { imageGeneration: true }), error => error.message === translate('en', 'ui.context_ai_image_generation_codex'));
  assert.equal(claudeGets, 0);
  assert.equal(codexGets, 0);
});

test('run with task.generateImage on a runtime without image generation: refused with 0 events, 0 registrations, 0 listeners, 0 runtime calls', async () => {
  const controller = new AbortController();
  let added = 0;
  const add = controller.signal.addEventListener.bind(controller.signal);
  controller.signal.addEventListener = (type, ...rest) => { if (type === 'abort') added++; return add(type, ...rest); };
  const h = harness();
  const runtimeCalls = h.state.runtimeCalls;
  const noImage = { capabilities: mod.CLAUDE_CAPABILITIES, run: async request => { runtimeCalls.push(request); return 'reply'; } };
  const active = new RecordingMap();
  const events = [];
  const sink = { begin: e => events.push(e), sent: e => events.push(e), received: e => events.push(e), milestones: e => events.push(e), parsed: e => events.push(e), completed: e => events.push(e), failed: e => events.push(e) };
  const calls = new mod.AiCalls({ runtimeFor: () => noImage, exchanges: () => sink, activeTasks: active });
  await assert.rejects(calls.run(prepared(), options({ model: 'claude:sonnet', signal: controller.signal, task: { generateImage: true } }), raw => raw), error => error.message === translate('en', 'ui.context_ai_image_generation_codex'));
  assert.equal(events.length, 0);
  assert.equal(active.keysSet.length, 0);
  assert.equal(active.size, 0);
  assert.equal(added, 0);
  assert.equal(runtimeCalls.length, 0);
  // The same options on a runtime that can draw go through.
  assert.equal(await h.calls.run(prepared(), options({ task: { generateImage: true } }), raw => raw), 'reply');
});

// ---- onBegin, failMessage, entryEnd ----
/** A caller signal that counts its abort listeners. */
function listenerCountingSignal() {
  const controller = new AbortController();
  const counts = { added: 0, removed: 0 };
  const add = controller.signal.addEventListener.bind(controller.signal), remove = controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.addEventListener = (type, ...rest) => { if (type === 'abort') counts.added++; return add(type, ...rest); };
  controller.signal.removeEventListener = (type, ...rest) => { if (type === 'abort') counts.removed++; return remove(type, ...rest); };
  return { controller, counts };
}

test('onBegin: called once right after begin with the entry id; a preset exchangeId is what it receives; not called when logging was off', async () => {
  const h = harness();
  await h.calls.run(prepared(), options({ onBegin: id => h.events.push(['onBegin', id]) }), () => 1);
  assert.deepEqual(h.names(), ['begin', 'onBegin', 'sent', 'received', 'milestones', 'completed']);
  assert.equal(h.events[1][1], h.events[0][1].id);
  const preset = harness();
  await preset.calls.run(prepared(), options({ exchangeId: 'promised-id', onBegin: id => preset.events.push(['onBegin', id]) }), () => 1);
  assert.deepEqual(preset.events[1], ['onBegin', 'promised-id']); assert.equal(preset.events[0][1].id, 'promised-id');
  const off = harness({ logging: false });
  let called = 0;
  await off.calls.run(prepared(), options({ onBegin: () => { called++; } }), () => 1);
  assert.equal(called, 0);
  const late = harness({ logging: false, run: (_request, state) => { state.logging = true; return 'x'; } });
  await late.calls.run(prepared(), options({ onBegin: () => { called++; } }), () => 1);
  assert.equal(called, 0, 'logging switched on mid-call does not start a notification');
});

test('failMessage: a runtime reject and a finish throw write failMessage(error) with the original error object', async () => {
  const boom = mod.makeError('runtime boom'), seen = [];
  const failMessage = error => { seen.push(error); return 'custom message'; };
  const h = harness({ run: () => { throw boom; } });
  await assert.rejects(h.calls.run(prepared(), options({ failMessage }), () => 1), error => error === boom);
  assert.deepEqual(h.events.filter(event => event[0] === 'failed').map(event => event[2]), ['custom message']);
  assert.equal(seen[0], boom);
  const finishBoom = mod.makeError('finish boom');
  const g = harness();
  await assert.rejects(g.calls.run(prepared(), options({ failMessage }), () => { throw finishBoom; }), error => error === finishBoom);
  assert.deepEqual(g.events.filter(event => event[0] === 'failed').map(event => event[2]), ['custom message']);
  assert.equal(seen[1], finishBoom);
});

test('failMessage is not called after exchange.fail: one failed with the finish callback\'s message', async () => {
  let called = 0;
  const h = harness();
  await assert.rejects(h.calls.run(prepared(), options({ failMessage: () => { called++; return 'never'; } }), (_raw, exchange) => { exchange.fail('first'); throw mod.makeError('second'); }), /second/);
  assert.deepEqual(h.events.filter(event => event[0] === 'failed').map(event => event[2]), ['first']);
  assert.equal(called, 0);
});

test('without failMessage the failed entry keeps the error message', async () => {
  const h = harness({ run: () => { throw mod.makeError('plain message'); } });
  await assert.rejects(h.calls.run(prepared(), options(), () => 1), /plain message/);
  assert.deepEqual(h.events.filter(event => event[0] === 'failed').map(event => event[2]), ['plain message']);
});

test('entryEnd "caller", success: begin, sent, received, milestones and no completed; parsed and fail written through exchange still work', async () => {
  const { controller, counts } = listenerCountingSignal();
  const h = harness();
  await h.calls.run(prepared(), options({ entryEnd: 'caller', signal: controller.signal }), () => 1);
  assert.deepEqual(h.names(), ['begin', 'sent', 'received', 'milestones']);
  assert.equal(h.active.size, 0); assert.equal(counts.added - counts.removed, 0);
  const g = harness();
  await g.calls.run(prepared(), options({ entryEnd: 'caller' }), (_raw, exchange) => { exchange.parsed(); });
  assert.deepEqual(g.names(), ['begin', 'sent', 'received', 'milestones', 'parsed']);
  const f = harness();
  await f.calls.run(prepared(), options({ entryEnd: 'caller' }), (_raw, exchange) => { exchange.fail('by the caller'); });
  assert.deepEqual(f.events.filter(event => event[0] === 'failed').map(event => event[2]), ['by the caller']);
  assert.equal(f.names().includes('completed'), false);
});

test('entryEnd "caller", runtime reject: milestones written, no failed, the original error rejects; failMessage is unused', async () => {
  const { controller, counts } = listenerCountingSignal();
  const boom = mod.makeError('runtime boom');
  let called = 0;
  const h = harness({ run: () => { throw boom; } });
  await assert.rejects(h.calls.run(prepared(), options({ entryEnd: 'caller', signal: controller.signal, extraMilestones: () => ({ slow: true }), failMessage: () => { called++; return 'x'; } }), () => 1), error => error === boom);
  assert.deepEqual(h.names(), ['begin', 'sent', 'milestones']);
  assert.deepEqual(h.events[2][2], { slow: true });
  assert.equal(called, 0); assert.equal(h.active.size, 0); assert.equal(counts.added - counts.removed, 0);
});

test('entryEnd "caller", reply after a stop: stopped() rejects, no received, no failed, nothing left registered or listening', async () => {
  const { controller, counts } = listenerCountingSignal();
  const stopped = mod.makeError('stopped here');
  let finished = 0;
  const h = harness({ run: () => { controller.abort(); return 'late'; } });
  await assert.rejects(h.calls.run(prepared(), options({ entryEnd: 'caller', signal: controller.signal, stopped: () => stopped }), () => { finished++; }), error => error === stopped);
  assert.equal(finished, 0);
  assert.deepEqual(h.names(), ['begin', 'sent']);
  assert.equal(h.active.size, 0); assert.equal(counts.added - counts.removed, 0);
});
