// Characterization of one AI call's lifecycle (exchange log events, runtime arguments, activeTasks key, stop handling)
// for the outline, map-chat and reframe runners. These tests pin today's behaviour; the AiCalls refactor must keep them green.
// Only `makeRunner` knows how a runner is built, so a later packet changes that one helper.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadSource, load } = require('./support-replay.cjs');
const S = require('./support.cjs');

// One bundle, so the runners and `prepareStep` share the step brand registry (see tests/support-ai-calls.cjs).
const bundle = loadSource(`
export { providerOutlineRunner } from "./core/outline-generation-service";
export { providerMapChatRunner } from "./core/map-chat-service";
export { providerReframeRunner } from "./core/reframing-service";
export { prepareStep } from "./core/step-runner";
export { outlineGenerateStep } from "./core/steps/outline-generate/step";
export { mapChatStep, MAP_CHAT_SCHEMA } from "./core/steps/map-chat/step";
export { reframeStep, REFRAME_SCHEMA } from "./core/steps/reframe/step";
// An Error of the bundle's own realm: product code tests instanceof Error, which a host-realm Error would fail.
export const makeError = (message: string): Error => new Error(message);
`, { obsidian: S.obsidian });
const { buildMapChatContext } = load('core/map-chat-context.ts');

/** Builds the runner under test; returns `(request, signal, onStructuredJson?) => Promise<string>`. */
function makeRunner(kind, options, active) {
  const prepare = (step, request) => bundle.prepareStep(step, request);
  if (kind === 'outline') {
    const runner = bundle.providerOutlineRunner(options, active);
    return (request, signal, onJson) => runner(request, signal, prepare(bundle.outlineGenerateStep, request), onJson);
  }
  if (kind === 'map-chat') {
    const runner = bundle.providerMapChatRunner(options, active);
    return (request, signal, onJson) => runner(request, signal, prepare(bundle.mapChatStep, request), onJson);
  }
  const runner = bundle.providerReframeRunner(options, active);
  return (request, signal) => {
    const prepared = prepare(bundle.reframeStep, request);
    return runner(request, prepared.prompt, bundle.REFRAME_SCHEMA, signal, prepared);
  };
}

const outline = [
  { id: 'r', title: 'Root', summary: 'Root summary', parentId: null, depth: 0 },
  { id: 'a', title: 'A', summary: 'A summary', parentId: 'r', depth: 1 }
];
const KINDS = {
  outline: {
    request: (extra = {}) => ({ topic: 'Sleep and memory', presetText: 'Make a tree for {research topic}.', language: 'en', model: 'gpt-6-luna', reasoning: 'low', ...extra }),
    good: '# Root\n## A', bad: 'Sorry, I cannot do that.',
    name: 'outline-generate', topic: 'Outline · Sleep and memory', step: 'outline-generate@1', stopped: 'Outline generation stopped',
    schema: () => undefined, stream: false
  },
  'map-chat': {
    request: (extra = {}) => ({ message: 'What is missing?', context: buildMapChatContext({ mapTitle: 'Steak', outline, selected: [], references: [], snippets: [], files: [], activeFile: null, history: [] }), language: 'en', model: 'claude:sonnet', reasoning: 'low', ...extra }),
    good: JSON.stringify({ reply: 'ok', actions: [] }), bad: 'not json',
    name: 'map-chat', topic: 'Map chat · What is missing?', step: 'map-chat@6', stopped: 'Map chat stopped',
    schema: () => bundle.MAP_CHAT_SCHEMA, stream: true
  },
  reframe: {
    request: (extra = {}) => ({ targetCore: 'understand', source: 'Candidate insight', question: 'Explore this', context: '', language: 'en', model: 'gpt-6-luna', reasoning: 'low', ...extra }),
    good: JSON.stringify({ question: 'What distinguishes these?', context: 'Open tensions remain.', rationale: 'Test it.' }), bad: '{"question":"q"}',
    name: 'reframe', topic: 'Reframing · Explore this', step: 'reframe@1', stopped: 'Reframing stopped',
    schema: () => bundle.REFRAME_SCHEMA, stream: false
  }
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

class RecordingMap extends Map {
  keysSet = [];
  set(key, value) { this.keysSet.push(key); return super.set(key, value); }
}

/** A signal whose abort listeners are counted (added minus removed). */
function countedSignal(aborted = false) {
  const controller = new AbortController();
  const state = { listeners: 0 };
  const add = controller.signal.addEventListener.bind(controller.signal);
  const remove = controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.addEventListener = (type, ...rest) => { if (type === 'abort') state.listeners++; return add(type, ...rest); };
  controller.signal.removeEventListener = (type, ...rest) => { if (type === 'abort') state.listeners--; return remove(type, ...rest); };
  if (aborted) controller.abort();
  return { controller, signal: controller.signal, state };
}

function fixture(kind, { logging = true, beforeRequest, afterRequest } = {}) {
  const spec = KINDS[kind];
  const state = { logging, runtimeCalls: [], directoryCalls: 0, codexLocal: [] };
  const events = [];
  const sink = {
    begin: entry => { const { id, startedAt, ...rest } = entry; assert.ok(id && startedAt); events.push(['begin', { ...rest }]); },
    sent: (_id, request, prompt) => events.push(['sent', JSON.parse(request), prompt]),
    received: (_id, response) => events.push(['received', response]),
    milestones: (_id, data) => events.push(['milestones', Object.keys(data).sort()]),
    parsed: () => events.push(['parsed']),
    completed: () => events.push(['completed']),
    failed: (_id, message) => events.push(['failed', message])
  };
  const runtime = {
    runTask: async (...args) => {
      state.runtimeCalls.push(args);
      beforeRequest?.(state, args);
      args[4].onRequest?.({ via: 'runtime' });
      if (afterRequest) return afterRequest(state, args);
      return spec.good;
    }
  };
  const options = {
    pluginDirectory: () => { state.directoryCalls++; return '/plugin'; },
    exchangeLoggingEnabled: () => state.logging,
    exchanges: () => sink,
    codexRuntime: (_dir, local) => { state.codexLocal.push(local); return runtime; },
    claudeRuntime: () => runtime
  };
  const active = new RecordingMap();
  return { spec, state, events, active, run: makeRunner(kind, options, active) };
}

for (const kind of Object.keys(KINDS)) {
  const spec = KINDS[kind];

  test(`${kind}: success logs begin, sent, received, milestones, parsed, completed and sends the runtime the exact arguments`, async () => {
    const f = fixture(kind);
    const request = spec.request();
    const external = countedSignal();
    const onJson = () => {};
    const raw = await f.run(request, external.signal, onJson);
    assert.equal(raw, spec.good);
    const prompt = f.state.runtimeCalls[0][0];
    assert.deepEqual(f.events, [
      ['begin', { topic: spec.topic, mode: 'task', model: request.model, effort: 'low', step: spec.step }],
      ['sent', { request: { via: 'runtime' }, prompt }, prompt],
      ['received', spec.good],
      ['milestones', ['receivedAt']],
      ['parsed'],
      ['completed']
    ]);
    const [sentPrompt, model, effort, schema, controls] = f.state.runtimeCalls[0];
    assert.ok(sentPrompt.length > 0);
    assert.equal(model, request.model.replace(/^claude:/, ''));
    assert.equal(effort, 'low');
    assert.equal(schema, spec.schema());
    assert.equal(controls.textOnly, true); assert.equal(controls.searchBudget, 0);
    assert.ok(controls.signal instanceof AbortSignal); assert.notEqual(controls.signal, external.signal);
    assert.equal(controls.stream, spec.stream ? true : undefined);
    assert.equal(controls.onStructuredJson, spec.stream ? onJson : undefined);
    if (!request.model.startsWith('claude:')) assert.deepEqual(f.state.codexLocal, [true], 'Codex always runs without web search');
    assert.equal(f.active.keysSet.length, 1);
    assert.ok(f.active.keysSet[0].startsWith(`${spec.name}:`)); assert.match(f.active.keysSet[0].slice(spec.name.length + 1), UUID);
    assert.equal(f.active.size, 0); assert.equal(external.state.listeners, 0);
  });

  test(`${kind}: a reply that does not parse writes one failed with the parse message, no completed`, async () => {
    const f = fixture(kind, { afterRequest: () => spec.bad });
    const error = await f.run(spec.request(), new AbortController().signal).then(() => null, e => e);
    assert.ok(error, 'the call rejects');
    assert.deepEqual(f.events.map(event => event[0]), ['begin', 'sent', 'received', 'milestones', 'failed']);
    assert.deepEqual(f.events[4], ['failed', error.message]);
    assert.equal(f.active.size, 0);
  });

  test(`${kind}: a reply that arrives after the stop is refused with the stopped error, never logged as received`, async () => {
    const external = countedSignal();
    const f = fixture(kind, { afterRequest: (_s, args) => { args[4].signal.dispatchEvent?.(new Event('abort')); external.controller.abort(); return spec.good; } });
    const error = await f.run(spec.request(), external.signal).then(() => null, e => e);
    assert.ok(error); assert.equal(error.message, spec.stopped);
    assert.deepEqual(f.events.map(event => event[0]), ['begin', 'sent', 'failed']);
    assert.deepEqual(f.events[2], ['failed', spec.stopped]);
    assert.equal(f.active.size, 0); assert.equal(external.state.listeners, 0);
  });

  test(`${kind}: a runtime that rejects after the stop throws its own error and logs that message`, async () => {
    const external = countedSignal();
    const f = fixture(kind, { afterRequest: () => { external.controller.abort(); throw bundle.makeError('runtime boom'); } });
    const error = await f.run(spec.request(), external.signal).then(() => null, e => e);
    assert.equal(error.message, 'runtime boom');
    assert.deepEqual(f.events.map(event => event[0]), ['begin', 'sent', 'failed']);
    assert.deepEqual(f.events[2], ['failed', 'runtime boom']);
    assert.equal(f.active.size, 0);
  });

  test(`${kind}: an unsupported Claude model logs begin and failed only and touches neither runtime nor plugin directory`, async () => {
    const f = fixture(kind);
    const error = await f.run(spec.request({ model: 'claude:not-a-model' }), new AbortController().signal).then(() => null, e => e);
    assert.equal(error.message, 'Unsupported Claude model');
    assert.deepEqual(f.events.map(event => event[0]), ['begin', 'failed']);
    assert.deepEqual(f.events[1], ['failed', 'Unsupported Claude model']);
    assert.equal(f.state.runtimeCalls.length, 0); assert.equal(f.state.directoryCalls, 0);
    assert.equal(f.active.size, 0);
  });

  test(`${kind}: logging off at the start writes nothing; turned off while the runtime runs leaves only begin`, async () => {
    const off = fixture(kind, { logging: false });
    assert.equal(await off.run(spec.request(), new AbortController().signal), spec.good);
    assert.deepEqual(off.events, []); assert.equal(off.active.size, 0);
    const mid = fixture(kind, { beforeRequest: state => { state.logging = false; } });
    assert.equal(await mid.run(spec.request(), new AbortController().signal), spec.good);
    assert.deepEqual(mid.events.map(event => event[0]), ['begin']);
    assert.equal(mid.active.size, 0);
  });

  test(`${kind}: an external signal that is already aborted reaches the runtime aborted`, async () => {
    const external = countedSignal(true);
    const f = fixture(kind, { beforeRequest: (state, args) => { state.sawAborted = args[4].signal.aborted; } });
    await f.run(spec.request(), external.signal).then(() => null, e => e);
    assert.equal(f.state.sawAborted, true);
    assert.equal(f.active.size, 0); assert.equal(external.state.listeners, 0);
  });
}
