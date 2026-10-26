// The readiness and prewarm members of the AI runtimes and AiCalls.prewarm (ticket 05).
// Adapter checks use fakes; the last test runs the real AiRuntimeService with a fake process starter.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { loadWithAiCalls } = require('./support-ai-calls.cjs');

const mod = loadWithAiCalls('core/ai-runtime-service.ts', {}, { window: { process: { env: {} } } });
// Results come from the bundle's realm; compare them by value across realms.
const plain = value => JSON.parse(JSON.stringify(value));
const OPTIONS = { effort: 'low', schema: { type: 'object' }, webSearch: true };

/** Fake checks that record every call, in order, and answer from `answers`. */
function fakeChecks(answers = {}) {
  const calls = [];
  return {
    calls,
    refresh: async id => {
      calls.push(`refresh:${id}`);
      const answer = answers[id];
      if (answer instanceof Function) return answer();
      return answer ?? { status: 'ready', models: [] };
    },
    codexInstalled: () => { calls.push('installed'); return answers.installed ?? true; }
  };
}

test('claude readiness: ready only when the model is listed; missing is missing; everything else is an error without text', async () => {
  const cases = [
    [{ status: 'ready', models: ['claude:sonnet'] }, { status: 'ready' }],
    [{ status: 'missing', models: [] }, { status: 'missing' }],
    [{ status: 'ready', models: ['claude:haiku'] }, { status: 'error' }],
    [{ status: 'error', models: [] }, { status: 'error' }],
    [{ status: 'loading', models: [] }, { status: 'error' }],
    [{ status: 'idle', models: [] }, { status: 'error' }]
  ];
  for (const [state, expected] of cases) {
    const checks = fakeChecks({ claude: state });
    const result = await mod.claudeCodeAiRuntime(() => ({}), checks).readiness('claude:sonnet');
    assert.deepEqual(plain(result), expected, JSON.stringify(state));
    assert.equal('error' in result, false);
    assert.deepEqual(checks.calls, ['refresh:claude'], 'one refresh, no installed check');
  }
});

test('claude readiness: a refresh that rejects rejects the same error', async () => {
  const boom = mod.makeError('x');
  const checks = fakeChecks({ claude: () => Promise.reject(boom) });
  await assert.rejects(mod.claudeCodeAiRuntime(() => ({}), checks).readiness('claude:sonnet'), error => error === boom);
});

test('codex readiness: not installed is missing and never refreshes', async () => {
  const checks = fakeChecks({ installed: false });
  assert.deepEqual(plain(await mod.codexAppServerAiRuntime(() => ({}), checks).readiness('gpt-test')), { status: 'missing' });
  assert.deepEqual(checks.calls, ['installed']);
});

test('codex readiness: installed is checked before the refresh, and each state maps to its status', async () => {
  const cases = [
    [{ status: 'ready', models: ['gpt-test'] }, { status: 'ready' }],
    [{ status: 'missing', models: [] }, { status: 'missing' }],
    [{ status: 'ready', models: ['other'] }, { status: 'model-unavailable' }],
    [{ status: 'error', models: [] }, { status: 'model-unavailable' }],
    [{ status: 'loading', models: [] }, { status: 'model-unavailable' }],
    [{ status: 'idle', models: [] }, { status: 'model-unavailable' }]
  ];
  for (const [state, expected] of cases) {
    const checks = fakeChecks({ codex: state });
    assert.deepEqual(plain(await mod.codexAppServerAiRuntime(() => ({}), checks).readiness('gpt-test')), expected, JSON.stringify(state));
    assert.deepEqual(checks.calls, ['installed', 'refresh:codex']);
  }
});

test('codex readiness: a refresh that throws becomes an error with its text (Error, string; a foreign-realm Error reads as a string)', async () => {
  const run = async thrown => plain(await mod.codexAppServerAiRuntime(() => ({}), fakeChecks({ codex: () => Promise.reject(thrown) })).readiness('gpt-test'));
  assert.deepEqual(await run(mod.makeError('boom')), { status: 'error', error: 'boom' });
  assert.deepEqual(await run('boom2'), { status: 'error', error: 'boom2' });
  // The bundle runs in its own realm, so an Error made here fails `instanceof Error` and goes through String().
  assert.deepEqual(await run(new Error('boom')), { status: 'error', error: 'Error: boom' });
});

test('codex readiness: a throwing installed check is not caught', async () => {
  const boom = mod.makeError('no diagnostic');
  const checks = { refresh: async () => ({ status: 'ready', models: [] }), codexInstalled: () => { throw boom; } };
  await assert.rejects(mod.codexAppServerAiRuntime(() => ({}), checks).readiness('gpt-test'), error => error === boom);
});

test('readiness without checks rejects when called; run does not need them', async () => {
  for (const runtime of [mod.claudeCodeAiRuntime(() => ({ runTask: async () => 'ok' })), mod.codexAppServerAiRuntime(() => ({ runTask: async () => 'ok' }))]) {
    await assert.rejects(runtime.readiness('claude:sonnet'), /checks option/);
    assert.equal(await runtime.run({ prompt: 'p', model: 'claude:sonnet', effort: 'low', controls: {}, localCodex: false }), 'ok');
  }
});

test('adapter prewarm: claude passes the bare model, effort, schema and web search; codex does nothing and never reads get', () => {
  const seen = []; let gets = 0;
  const claude = mod.claudeCodeAiRuntime(() => { gets += 1; return { runTask: async () => '', prewarm: (...args) => { seen.push(args); return true; } }; });
  claude.prewarm('claude:sonnet', OPTIONS);
  assert.deepEqual(seen, [['sonnet', 'low', OPTIONS.schema, true]]);
  assert.equal(gets, 1);
  let codexGets = 0;
  const codex = mod.codexAppServerAiRuntime(() => { codexGets += 1; return { runTask: async () => '' }; });
  assert.doesNotThrow(() => codex.prewarm('gpt-test', OPTIONS));
  assert.equal(codexGets, 0);
});

test('AiCalls.prewarm: a capable runtime is pre-started, any other drops the waiting process', () => {
  for (const [prewarm, started, released] of [[true, 1, 0], [false, 0, 1]]) {
    const counts = { prewarm: 0, release: 0 }; const args = [];
    const runtime = { capabilities: { id: 'claude', imageGeneration: false, webSearch: true, prewarm }, run: async () => '', readiness: async () => ({ status: 'ready' }), prewarm: (...a) => { counts.prewarm += 1; args.push(a); } };
    const logged = [];
    const calls = new mod.AiCalls({ runtimeFor: () => runtime, exchanges: () => { logged.push('read'); return null; }, releaseWarm: () => { counts.release += 1; } });
    calls.prewarm('claude:sonnet', OPTIONS);
    assert.deepEqual([counts.prewarm, counts.release], [started, released]);
    if (started) assert.deepEqual(args, [['claude:sonnet', OPTIONS]]);
    assert.equal(calls.activeTasks.size, 0);
    assert.deepEqual(logged, [], 'no exchange log event');
  }
});

test('AiCalls.prewarm: no releaseWarm option is fine; a runtimeFor that throws throws', () => {
  const runtime = { capabilities: { id: 'codex', imageGeneration: true, webSearch: true, prewarm: false }, run: async () => '', readiness: async () => ({ status: 'ready' }), prewarm() { assert.fail('must not pre-start'); } };
  assert.doesNotThrow(() => new mod.AiCalls({ runtimeFor: () => runtime, exchanges: () => null }).prewarm('gpt-test', OPTIONS));
  const boom = mod.makeError('no runtime');
  assert.throws(() => new mod.AiCalls({ runtimeFor: () => { throw boom; }, exchanges: () => null }).prewarm('x', OPTIONS), error => error === boom);
});

test('full entry: AiCalls.prewarm over the real AiRuntimeService pre-starts Claude, releases for Codex, and refuses after dispose', async () => {
  const children = [];
  const spawn = (_exe, args) => {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.signals = []; child.args = args;
    child.stdin = { on() {}, write(_text, done) { done?.(); return true; }, end(_text, done) { done?.(); } };
    child.kill = signal => { child.signals.push(signal); process.nextTick(() => child.emit('close', null, signal)); return true; };
    children.push(child); return child;
  };
  const clock = { setTimeout: () => 1, clearTimeout: () => {} };
  const checks = fakeChecks({ claude: { status: 'ready', models: ['claude:sonnet'] } });
  const service = new mod.AiRuntimeService({
    codexPath: () => 'codex', claudePath: () => '/bin/claude', clientVersion: () => '1', onLog: () => {},
    warmClock: clock, claudeSpawn: spawn, probe: { firstExisting: () => null, listDirectory: () => [], available: () => true },
    pluginDirectory: () => '/plugin', checks
  });
  const calls = new mod.AiCalls({ runtimeFor: model => service.runtimeFor(model), exchanges: () => null, releaseWarm: () => service.releaseWarm() });

  calls.prewarm('claude:sonnet', OPTIONS);
  assert.equal(service.hasWarm(), true);
  assert.equal(children.length, 1);
  assert.ok(children[0].args.includes('sonnet'), 'spawned with the bare model');
  assert.ok(!children[0].args.includes('claude:sonnet'));

  calls.prewarm('gpt-test', OPTIONS);
  assert.equal(service.hasWarm(), false);
  assert.equal(children[0].signals[0], 'SIGTERM', 'the waiting process was killed');

  assert.deepEqual(plain(await service.runtimeFor('claude:sonnet').readiness('claude:sonnet')), { status: 'ready' });
  assert.deepEqual(checks.calls, ['refresh:claude'], 'readiness read options.checks');

  service.dispose();
  calls.prewarm('claude:sonnet', OPTIONS);
  assert.equal(service.hasWarm(), false);
  assert.equal(children.length, 1, 'no new process after dispose');
});
