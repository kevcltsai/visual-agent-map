// runAttempts (core/attempt-runner.ts): the slow notice after FIRST_EVENT_WAIT_MS without a model event, and the re-send that replaces an attempt.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./support-replay.cjs');

const { runAttempts, FIRST_EVENT_WAIT_MS } = load('core/attempt-runner.ts');

const flush = () => new Promise(resolve => setImmediate(resolve));
const stopped = () => Object.assign(new Error('stopped'), { name: 'AbortError' });

function fakeClock() {
  const clock = { time: 0, timers: new Map(), next: 1 };
  clock.now = () => clock.time;
  clock.setTimeout = (callback, ms) => { const id = clock.next++; clock.timers.set(id, { at: clock.time + ms, callback }); return id; };
  clock.clearTimeout = id => { clock.timers.delete(id); };
  clock.advance = ms => {
    const target = clock.time + ms;
    for (;;) {
      const due = [...clock.timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      clock.timers.delete(due[0]); clock.time = due[1].at; due[1].callback();
    }
    clock.time = target;
  };
  return clock;
}

/** An outer signal that counts its listeners. */
function countedSignal() {
  const controller = new AbortController();
  const signal = controller.signal;
  const state = { listeners: 0 };
  const add = signal.addEventListener.bind(signal), remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = (type, fn, options) => { state.listeners++; add(type, fn, options); };
  signal.removeEventListener = (type, fn, options) => { state.listeners--; remove(type, fn, options); };
  return { controller, signal, state };
}

/** Runs attempts whose `start` is controlled by the test; `starts[i]` holds attempt i with its resolve / reject. */
function rig({ armOnStart = true, hooks = {}, signal, streamModeEndsResend } = {}) {
  const clock = fakeClock();
  const log = [];
  const starts = [];
  const slow = [];
  const run = runAttempts({
    signal, clock, stopped, streamModeEndsResend,
    start: attempt => new Promise((resolve, reject) => {
      starts.push({ attempt, resolve, reject });
      log.push(`start ${attempt.number}`);
      if (armOnStart) attempt.arm();
    }),
    onAttempt: attempt => { log.push(`attempt ${attempt.number}`); hooks.onAttempt?.(attempt); },
    onSlow: (attempt, resend) => { slow.push({ attempt, resend }); log.push(`slow ${attempt.number}`); hooks.onSlow?.(attempt, resend); },
    onCleared: attempt => { log.push(`cleared ${attempt.number}`); hooks.onCleared?.(attempt); },
    onResend: attempt => { log.push(`resend ${attempt.number} aborted=${attempt.signal.aborted}`); hooks.onResend?.(attempt); },
    onReplaced: attempt => { log.push(`replaced ${attempt.number}`); hooks.onReplaced?.(attempt); }
  });
  run.catch(() => undefined);
  return { clock, log, starts, slow, run };
}

test('the notice comes at 20 s, not at 19.9 s', async () => {
  const r = rig(); await flush();
  r.clock.advance(FIRST_EVENT_WAIT_MS - 100); assert.equal(r.slow.length, 0);
  r.clock.advance(100); assert.equal(r.slow.length, 1);
  r.starts[0].resolve('ok'); assert.equal(await r.run, 'ok');
});

test('arm starts the count again', async () => {
  const r = rig(); await flush();
  r.clock.advance(15_000); r.starts[0].attempt.arm();
  r.clock.advance(19_900); assert.equal(r.slow.length, 0, 'counted from the second arm');
  r.clock.advance(100); assert.equal(r.slow.length, 1);
  r.starts[0].resolve('ok'); await r.run;
});

test('without arm there is no notice', async () => {
  const r = rig({ armOnStart: false }); await flush();
  r.clock.advance(120_000); assert.equal(r.slow.length, 0);
  r.starts[0].resolve('ok'); await r.run;
});

test('a model event before 20 s means the notice never comes, and nothing is cleared', async () => {
  const r = rig(); await flush();
  r.clock.advance(10_000); assert.equal(r.starts[0].attempt.seen(), true);
  r.clock.advance(120_000); assert.equal(r.slow.length, 0); assert.ok(!r.log.some(line => line.startsWith('cleared')));
  r.starts[0].resolve('ok'); await r.run;
});

test('a model event after the notice clears it once', async () => {
  const r = rig(); await flush();
  r.clock.advance(20_000); assert.equal(r.slow.length, 1);
  r.starts[0].attempt.seen(); r.starts[0].attempt.seen();
  assert.equal(r.log.filter(line => line === 'cleared 1').length, 1);
  r.starts[0].resolve('ok'); await r.run;
});

test('stream mode other than stream-json: no notice, and a re-send is a no-op (json, json-fallback)', async () => {
  for (const mode of ['json', 'json-fallback']) {
    const r = rig(); await flush();
    r.starts[0].attempt.streamMode(mode); r.clock.advance(120_000); assert.equal(r.slow.length, 0, `${mode}: no notice`);
    r.starts[0].resolve('ok'); await r.run;
  }
  const r = rig({ streamModeEndsResend: true }); await flush();
  r.starts[0].attempt.streamMode('stream-json'); r.clock.advance(20_000); assert.equal(r.slow.length, 1, 'stream-json keeps the watch');
  r.starts[0].attempt.streamMode('json-fallback'); r.slow[0].resend(); await flush();
  assert.equal(r.starts.length, 1, 'a notice already shown cannot replace the attempt once watching stopped'); assert.equal(r.starts[0].attempt.signal.aborted, false);
  r.starts[0].resolve('ok'); await r.run;
});

test('re-send: onResend runs before the abort, the old result is dropped, onReplaced comes before the next start', async () => {
  const r = rig(); await flush();
  r.clock.advance(20_000); r.slow[0].resend(); await flush();
  assert.deepEqual(r.log, ['attempt 1', 'start 1', 'slow 1', 'resend 1 aborted=false', 'replaced 1', 'attempt 2', 'start 2']);
  assert.equal(r.starts[0].attempt.signal.aborted, true); assert.equal(r.starts[0].attempt.live(), false);
  r.starts[0].resolve('OLD'); await flush();
  r.starts[1].resolve('NEW'); assert.equal(await r.run, 'NEW');
  r.clock.advance(120_000); assert.equal(r.slow.length, 1, 'no timer is left for the old attempt');
});

test('re-send: a runtime that rejects on abort is not a failure either', async () => {
  const r = rig(); await flush();
  r.starts[0].attempt.signal.addEventListener('abort', () => r.starts[0].reject(new Error('aborted')));
  r.clock.advance(20_000); r.slow[0].resend(); await flush();
  assert.equal(r.starts.length, 2); r.starts[1].resolve('NEW'); assert.equal(await r.run, 'NEW');
});

test('re-send has no effect after a model event, after Stop, after being replaced, and pressing twice counts once', async () => {
  let r = rig(); await flush();
  r.clock.advance(20_000); r.starts[0].attempt.seen(); r.slow[0].resend(); await flush(); assert.equal(r.starts.length, 1, 'after a model event');
  r.starts[0].resolve('ok'); await r.run;

  const outer = new AbortController(); r = rig({ signal: outer.signal }); await flush();
  r.clock.advance(20_000); outer.abort(); r.slow[0].resend(); await flush(); assert.equal(r.starts.length, 1, 'after Stop');
  await assert.rejects(r.run, /stopped/); assert.ok(!r.log.some(line => line.startsWith('resend')));

  r = rig(); await flush();
  r.clock.advance(20_000); const first = r.slow[0].resend; first(); first(); await flush();
  assert.equal(r.starts.length, 2, 'twice on one notice is one re-send'); assert.equal(r.log.filter(line => line.startsWith('resend')).length, 1);
  first(); await flush(); assert.equal(r.starts.length, 2, 'a replaced attempt cannot be replaced again');
  r.starts[1].resolve('ok'); await r.run;
});

test('two re-sends on two notices run three attempts', async () => {
  const r = rig(); await flush();
  r.clock.advance(20_000); r.slow[0].resend(); await flush(); r.clock.advance(20_000); r.slow[1].resend(); await flush();
  assert.equal(r.starts.length, 3); assert.deepEqual(r.starts.map(s => s.attempt.signal.aborted), [true, true, false]);
  assert.deepEqual(r.starts.map(s => s.attempt.number), [1, 2, 3]); assert.equal(new Set(r.starts.map(s => s.attempt.id)).size, 3);
  r.starts[2].resolve('ok'); assert.equal(await r.run, 'ok');
});

test('the outer abort aborts the attempt at once, even when the runtime ignores it, and onReplaced is not called', async () => {
  const outer = new AbortController(); const r = rig({ signal: outer.signal }); await flush();
  outer.abort(); await assert.rejects(r.run, /stopped/);
  assert.equal(r.starts[0].attempt.signal.aborted, true); assert.ok(!r.log.some(line => line.startsWith('replaced')));
});

test('an outer abort between a re-send and the next start never starts it', async () => {
  const outer = new AbortController();
  const r = rig({ signal: outer.signal, hooks: { onReplaced: () => outer.abort() } }); await flush();
  r.clock.advance(20_000); r.slow[0].resend(); await flush();
  await assert.rejects(r.run, /stopped/); assert.equal(r.starts.length, 1);
});

test('an outer signal that is already aborted never starts', async () => {
  const outer = new AbortController(); outer.abort(); const r = rig({ signal: outer.signal });
  await assert.rejects(r.run, /stopped/); assert.equal(r.starts.length, 0);
});

test('success, failure and Stop leave no timer and no listener', async () => {
  for (const end of ['success', 'failure', 'stop']) {
    const counted = countedSignal(); const r = rig({ signal: counted.signal }); await flush();
    assert.equal(counted.state.listeners, 1); assert.equal(r.clock.timers.size, 1);
    if (end === 'success') r.starts[0].resolve('ok'); else if (end === 'failure') r.starts[0].reject(new Error('boom')); else counted.controller.abort();
    await r.run.catch(() => undefined);
    assert.equal(counted.state.listeners, 0, `${end}: listener removed`);
    assert.equal(r.clock.timers.size, 0, `${end}: no timer`);
  }
});

test('a failure that is not a re-send is rethrown as it is', async () => {
  const r = rig(); await flush(); const error = new Error('Map chat timed out');
  r.starts[0].reject(error); await assert.rejects(r.run, error);
});

test('a hook that throws does not fail the request', async () => {
  const boom = () => { throw new Error('observer'); };
  const r = rig({ hooks: { onAttempt: boom, onSlow: boom, onCleared: boom, onResend: boom, onReplaced: boom } }); await flush();
  r.clock.advance(20_000); r.slow[0].resend(); await flush(); assert.equal(r.starts.length, 2);
  r.clock.advance(20_000); r.starts[1].attempt.seen(); r.starts[1].resolve('ok'); assert.equal(await r.run, 'ok');
});

test('research (option off): a notice already shown can still re-send after a json-fallback stream mode, and no new notice comes', async () => {
  const r = rig(); await flush();
  r.clock.advance(20_000); r.starts[0].attempt.streamMode('json-fallback'); r.slow[0].resend(); await flush();
  assert.equal(r.starts.length, 2, 're-sent'); assert.equal(r.starts[0].attempt.signal.aborted, true);
  r.starts[1].attempt.streamMode('json'); r.clock.advance(120_000); assert.equal(r.slow.length, 1, 'json still shows no notice');
  r.starts[1].resolve('ok'); await r.run;
});

test('after the attempt has its answer, Resend does nothing (both modes)', async () => {
  for (const streamModeEndsResend of [true, false]) {
    const r = rig({ streamModeEndsResend }); await flush();
    r.clock.advance(20_000); r.starts[0].resolve('ok'); assert.equal(await r.run, 'ok');
    r.slow[0].resend(); await flush();
    assert.equal(r.starts.length, 1); assert.ok(!r.log.some(line => line.startsWith('resend')), 'no onResend after the runner returned');
  }
});
