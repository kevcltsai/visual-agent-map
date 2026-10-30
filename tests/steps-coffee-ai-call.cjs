// Characterization of Coffee Tables' model call (main.ts runCoffeeRequest): exchange log events, the runtime's arguments and
// controls, the activeTasks key, stop handling and cleanup. Pinned on the pre-AiCalls code; the refactor must keep it green.
// Only the runtime injection (plugin.aiRuntime.codex/claude) and the exchange sink are test doubles.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const events = require('node:events');
const S = require('./support.cjs');

const { default: Plugin } = S.load('main.ts', { obsidian: S.obsidian });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEYS = ['begin', 'sent', 'received', 'milestones', 'parsed', 'completed', 'failed'];
const CONTROL_FIELDS = ['onRequest', 'onSteer', 'onText', 'searchBudget', 'signal', 'textOnly', 'timeoutMessage', 'timeoutMs'];
// Product code tests `instanceof Error`, so the failures the fake runtime throws must be Errors of the main.ts bundle's realm.
const BundleError = Plugin.prototype.pluginDirectory.constructor('return Error')();

/** A plugin with a recording exchange sink and scripted runtimes. `run(call)` is the runtime's behaviour for every provider. */
function harness({ run, logging = true, adapter = true, dir = 'plugin' } = {}) {
  const plugin = new Plugin();
  plugin.app = { vault: { adapter: adapter ? new S.obsidian.FileSystemAdapter() : {} } };
  plugin.manifest = { dir };
  plugin.settings.aiExchangeLoggingEnabled = logging;
  const log = [], calls = [], routes = [];
  plugin.exchanges = Object.fromEntries(KEYS.map(key => [key, (...args) => log.push([key, ...args])]));
  const runtime = route => ({
    runTask: async (prompt, model, effort, schema, controls) => {
      const call = { route, prompt, model, effort, schema, controls };
      calls.push(call);
      controls.onRequest({ via: 'runtime' });
      return run ? run(call) : 'reply';
    }
  });
  plugin.aiRuntime.codex = (directory, local) => { routes.push(['codex', directory, local]); return runtime('codex'); };
  plugin.aiRuntime.claude = directory => { routes.push(['claude', directory]); return runtime('claude'); };
  return { plugin, log, calls, routes, names: () => log.map(entry => entry[0]) };
}

const request = (extra = {}) => ({ session: { ...S.coffeeSession(), model: 'test-codex', reasoning: 'high' }, prompt: 'coffee prompt', signal: new AbortController().signal, step: 'coffee.table@1', ...extra });
const tick = () => new Promise(resolve => setImmediate(resolve));

test('Codex success: begin, sent, received, completed; runtime gets the plugin directory, the model as is and plain-text controls', async () => {
  const h = harness();
  const req = request();
  let during = null, listeners = null;
  const original = h.plugin.aiRuntime.codex;
  h.plugin.aiRuntime.codex = (...args) => { const runtime = original(...args); return { runTask: async (...rest) => { during = [...h.plugin.activeTasks.keys()]; listeners = events.getEventListeners(req.signal, 'abort').length; return runtime.runTask(...rest); } }; };
  assert.equal(await h.plugin.runCoffeeRequest(req), 'reply');
  assert.deepEqual(h.names(), ['begin', 'sent', 'received', 'completed']);
  const [begin, sent, received, completed] = h.log;
  assert.match(begin[1].id, UUID);
  assert.deepEqual({ ...begin[1], id: undefined, startedAt: undefined }, { id: undefined, startedAt: undefined, topic: `Coffee Tables · ${req.session.topic}`, mode: 'task', model: 'test-codex', effort: 'high', step: 'coffee.table@1' });
  assert.ok(!Number.isNaN(Date.parse(begin[1].startedAt)));
  assert.deepEqual(Object.keys(begin[1]), ['id', 'startedAt', 'topic', 'mode', 'model', 'effort', 'step']);
  assert.equal(sent[1], begin[1].id);
  assert.equal(sent[2], JSON.stringify({ request: { via: 'runtime' }, prompt: 'coffee prompt' }, null, 2));
  assert.equal(sent[3], 'coffee prompt');
  assert.deepEqual(received, ['received', begin[1].id, 'reply']);
  assert.deepEqual(completed, ['completed', begin[1].id]);
  assert.deepEqual(h.routes, [['codex', '/vault/plugin', true]]);
  assert.equal(h.calls.length, 1);
  const [call] = h.calls;
  assert.equal(call.route, 'codex'); assert.equal(call.prompt, 'coffee prompt'); assert.equal(call.model, 'test-codex'); assert.equal(call.effort, 'high'); assert.equal(call.schema, undefined);
  assert.deepEqual(Object.keys(call.controls).sort(), CONTROL_FIELDS);
  assert.equal(call.controls.textOnly, true); assert.equal(call.controls.searchBudget, 0); assert.equal(call.controls.timeoutMs, 900000);
  assert.equal(call.controls.timeoutMessage, S.load('i18n.ts').translate('en', 'ui.coffee_generation_timed_out'));
  assert.notEqual(call.controls.signal, req.signal);
  assert.equal(during.length, 1); assert.match(during[0], /^coffee:/); assert.match(during[0].slice('coffee:'.length), UUID);
  assert.equal(listeners, 1);
  assert.equal(h.plugin.activeTasks.size, 0);
  assert.equal(events.getEventListeners(req.signal, 'abort').length, 0);
});

test('Claude success: the plugin directory and the model without the claude: prefix, no milestones', async () => {
  const h = harness();
  const req = request({ session: { ...request().session, model: 'claude:sonnet', reasoning: 'low' } });
  assert.equal(await h.plugin.runCoffeeRequest(req), 'reply');
  assert.deepEqual(h.names(), ['begin', 'sent', 'received', 'completed']);
  assert.equal(h.log[0][1].model, 'claude:sonnet');
  assert.deepEqual(h.routes, [['claude', '/vault/plugin']]);
  assert.equal(h.calls[0].route, 'claude'); assert.equal(h.calls[0].model, 'sonnet'); assert.equal(h.calls[0].effort, 'low'); assert.equal(h.calls[0].schema, undefined);
  assert.deepEqual(Object.keys(h.calls[0].controls).sort(), CONTROL_FIELDS);
  assert.equal(h.calls[0].controls.searchBudget, 0);
  assert.equal(h.plugin.activeTasks.size, 0);
  // Claude with the high reasoning level: effort is high, still plain text and no search budget.
  const high = harness();
  assert.equal(await high.plugin.runCoffeeRequest(request({ session: { ...request().session, model: 'claude:sonnet', reasoning: 'high' } })), 'reply');
  assert.equal(high.calls[0].model, 'sonnet'); assert.equal(high.calls[0].effort, 'high'); assert.equal(high.calls[0].schema, undefined);
  assert.equal(high.calls[0].controls.searchBudget, 0); assert.equal(high.calls[0].controls.textOnly, true);
});

test('without a step the begin entry has no step property', async () => {
  const h = harness();
  await h.plugin.runCoffeeRequest(request({ step: undefined }));
  assert.ok(!('step' in h.log[0][1]));
  assert.deepEqual(Object.keys(h.log[0][1]), ['id', 'startedAt', 'topic', 'mode', 'model', 'effort']);
});

test('effort follows the session reasoning level', async () => {
  const efforts = {};
  for (const reasoning of ['low', 'high', undefined]) {
    const h = harness();
    const session = { ...request().session }; if (reasoning === undefined) delete session.reasoning; else session.reasoning = reasoning;
    await h.plugin.runCoffeeRequest(request({ session }));
    efforts[String(reasoning)] = [h.calls[0].effort, h.log[0][1].effort];
  }
  assert.deepEqual(efforts, { low: ['low', 'low'], high: ['high', 'high'], undefined: ['low', 'low'] });
});

test('onText and onSteer are forwarded to the request', async () => {
  const texts = [], handlers = [];
  const h = harness({ run: call => { call.controls.onText('x'); call.controls.onSteer(async () => {}); return 'reply'; } });
  await h.plugin.runCoffeeRequest(request({ onText: text => texts.push(text), registerIntervention: handler => handlers.push(handler) }));
  assert.deepEqual(texts, ['x']); assert.equal(handlers.length, 1); assert.equal(typeof handlers[0], 'function');
  const bare = harness({ run: call => { call.controls.onText('x'); call.controls.onSteer(async () => {}); return 'reply'; } });
  assert.equal(await bare.plugin.runCoffeeRequest(request()), 'reply');
});

test('a runtime timeout rejects with the same error, logs its message and releases everything', async () => {
  const timeout = { error: null };
  const h = harness({ run: call => { timeout.error = new BundleError(call.controls.timeoutMessage); throw timeout.error; } });
  const req = request();
  await assert.rejects(h.plugin.runCoffeeRequest(req), error => error === timeout.error);
  assert.deepEqual(h.names(), ['begin', 'sent', 'failed']);
  assert.equal(h.log[2][2], S.load('i18n.ts').translate('en', 'ui.coffee_generation_timed_out'));
  assert.equal(h.plugin.activeTasks.size, 0);
  assert.equal(events.getEventListeners(req.signal, 'abort').length, 0);
});

test('a runtime error is thrown as is: begin, sent, failed', async () => {
  const failure = new BundleError('boom');
  const h = harness({ run: () => { throw failure; } });
  await assert.rejects(h.plugin.runCoffeeRequest(request()), error => error === failure);
  assert.deepEqual(h.names(), ['begin', 'sent', 'failed']);
  assert.deepEqual(h.log[2], ['failed', h.log[0][1].id, 'boom']);
  assert.equal(h.plugin.activeTasks.size, 0);
});

test('a reply that arrives after Stop is refused as cancelled (activeTasks controller aborted)', async () => {
  const gate = S.deferred();
  const h = harness({ run: () => gate.promise });
  const pending = h.plugin.runCoffeeRequest(request());
  const settled = assert.rejects(pending, error => error.message === 'Coffee Tables request cancelled');
  await tick(); assert.equal(h.plugin.activeTasks.size, 1);
  [...h.plugin.activeTasks.values()][0].abort();
  gate.resolve('late reply');
  await settled;
  assert.deepEqual(h.names(), ['begin', 'sent', 'failed']);
  assert.deepEqual(h.log[2], ['failed', h.log[0][1].id, 'Coffee Tables request cancelled']);
  assert.equal(h.plugin.activeTasks.size, 0);
});

test('a reply that arrives after the caller aborts is refused as cancelled', async () => {
  const gate = S.deferred(), abort = new AbortController();
  const h = harness({ run: () => gate.promise });
  const pending = h.plugin.runCoffeeRequest(request({ signal: abort.signal }));
  const settled = assert.rejects(pending, error => error.message === 'Coffee Tables request cancelled');
  await tick(); abort.abort(); gate.resolve('late reply');
  await settled;
  assert.deepEqual(h.names(), ['begin', 'sent', 'failed']);
  assert.equal(h.plugin.activeTasks.size, 0);
  assert.equal(events.getEventListeners(abort.signal, 'abort').length, 0);
});

test('a caller signal that is already aborted is refused as cancelled and cleans up', async () => {
  const abort = new AbortController(); abort.abort();
  const h = harness();
  await assert.rejects(h.plugin.runCoffeeRequest(request({ signal: abort.signal })), /cancelled/);
  assert.deepEqual(h.names(), ['begin', 'sent', 'failed']);
  assert.deepEqual(h.log[2], ['failed', h.log[0][1].id, 'Coffee Tables request cancelled']);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].controls.signal.aborted, true);
  assert.equal(h.plugin.activeTasks.size, 0);
  assert.equal(events.getEventListeners(abort.signal, 'abort').length, 0);
});

test('without the desktop runtime nothing is logged, registered or run', async () => {
  for (const options of [{ adapter: false }, { dir: '' }]) {
    const h = harness(options);
    await assert.rejects(h.plugin.runCoffeeRequest(request()), error => error.message === 'Coffee Tables requires the desktop runtime');
    assert.equal(h.log.length, 0); assert.equal(h.calls.length, 0); assert.equal(h.routes.length, 0); assert.equal(h.plugin.activeTasks.size, 0);
  }
});

test('exchange logging off at the start writes nothing; turning it off after sent stops later writes', async () => {
  const off = harness({ logging: false });
  assert.equal(await off.plugin.runCoffeeRequest(request()), 'reply');
  assert.equal(off.log.length, 0); assert.equal(off.calls.length, 1);
  const h = harness({ run: call => { h.plugin.settings.aiExchangeLoggingEnabled = false; return 'reply'; } });
  assert.equal(await h.plugin.runCoffeeRequest(request()), 'reply');
  assert.deepEqual(h.names(), ['begin', 'sent']);
  const failing = harness({ run: call => { failing.plugin.settings.aiExchangeLoggingEnabled = false; throw new BundleError('late'); } });
  await assert.rejects(failing.plugin.runCoffeeRequest(request()), /late/);
  assert.deepEqual(failing.names(), ['begin', 'sent']);
});
