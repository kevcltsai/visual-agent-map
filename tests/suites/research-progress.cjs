// Research progress store: attempt guarding, preview tail, throttling and timer cleanup with a fake clock.
const assert = require('node:assert/strict');
const { test, load } = require('../support.cjs');

const { ResearchProgressStore } = load('experiences/visual-map/research-progress.ts');

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
      clock.timers.delete(due[0]);
      clock.time = due[1].at;
      due[1].callback();
    }
    clock.time = target;
  };
  return clock;
}
const setup = () => {
  const clock = fakeClock();
  const store = new ResearchProgressStore(clock);
  const calls = [];
  const unsubscribe = store.subscribe(path => calls.push(path));
  return { clock, store, calls, unsubscribe };
};

test('research progress: begin, stage changes notify immediately and carry the query', () => {
  const { store, calls } = setup();
  store.begin('a.md', 'x1', 1000);
  assert.deepEqual(JSON.parse(JSON.stringify(store.get('a.md'))), { attemptId: 'x1', startedAt: 1000, stage: 'waiting', stageAt: 1000, slow: false });
  store.stage('a.md', 'x1', 'searching', 1500, 'synthetic query');
  assert.equal(store.get('a.md').stage, 'searching');
  assert.equal(store.get('a.md').query, 'synthetic query');
  assert.equal(store.get('a.md').stageAt, 1500);
  store.stage('a.md', 'x1', 'writing', 1600);
  assert.equal(store.get('a.md').query, undefined);
  assert.equal(calls.length, 3);
});

test('research progress: events from a stale attemptId are ignored', () => {
  const { store, calls } = setup();
  store.begin('a.md', 'new', 0);
  const before = calls.length;
  store.stage('a.md', 'old', 'writing', 5);
  store.markSlow('a.md', 'old', true);
  store.preview('a.md', 'old', { summary: 'stale' });
  store.stage('missing.md', 'new', 'writing', 5);
  assert.equal(store.get('a.md').stage, 'waiting');
  assert.equal(store.get('a.md').slow, false);
  assert.equal(store.get('a.md').preview, undefined);
  assert.equal(calls.length, before);
});

test('research progress: newAttempt clears preview and slow flag and resets the stage', () => {
  const { store, clock } = setup();
  store.begin('a.md', 'a1', 0);
  store.stage('a.md', 'a1', 'writing', 10);
  store.markSlow('a.md', 'a1', true);
  store.preview('a.md', 'a1', { summary: 'S', detail: 'D' });
  store.newAttempt('a.md', 'a2', 20);
  const entry = store.get('a.md');
  assert.equal(entry.attemptId, 'a2');
  assert.equal(entry.stage, 'waiting');
  assert.equal(entry.slow, false);
  assert.equal(entry.preview, undefined);
  assert.equal(entry.startedAt, 0, 'elapsed time keeps counting across attempts');
  store.preview('a.md', 'a1', { summary: 'late' });
  assert.equal(store.get('a.md').preview, undefined, 'the old attempt can no longer write');
  assert.equal(clock.timers.size, 0);
});

test('research progress: preview keeps summary and only the last 600 characters of detail', () => {
  const { store } = setup();
  store.begin('a.md', 'a1', 0);
  const detail = 'x'.repeat(500) + 'y'.repeat(600);
  store.preview('a.md', 'a1', { summary: 'Sum', detail });
  assert.equal(store.get('a.md').preview.summary, 'Sum');
  assert.equal(store.get('a.md').preview.detailTail, 'y'.repeat(600));
  store.preview('a.md', 'a1', { summary: 'Sum', detail: 'short' });
  assert.equal(store.get('a.md').preview.detailTail, 'short');
  store.preview('a.md', 'a1', {});
  assert.equal(store.get('a.md').preview, undefined, 'an empty preview retracts');
});

test('research progress: preview notifications are throttled to one per 200 ms per path', () => {
  const { store, clock, calls } = setup();
  store.begin('a.md', 'a1', 0);
  store.begin('b.md', 'b1', 0);
  calls.length = 0;
  clock.advance(1000);
  store.preview('a.md', 'a1', { detail: 'one' });
  assert.deepEqual(calls, ['a.md'], 'first preview after a quiet period notifies at once');
  clock.advance(50);
  store.preview('a.md', 'a1', { detail: 'one two' });
  clock.advance(50);
  store.preview('a.md', 'a1', { detail: 'one two three' });
  assert.equal(calls.length, 1, 'bursts inside the window are held');
  assert.equal(store.get('a.md').preview.detailTail, 'one two three', 'state is current even while notifications wait');
  store.preview('b.md', 'b1', { detail: 'other path' });
  assert.deepEqual(calls, ['a.md', 'b.md'], 'throttle is per path');
  clock.advance(99);
  assert.equal(calls.length, 2);
  clock.advance(1);
  assert.deepEqual(calls, ['a.md', 'b.md', 'a.md'], 'one trailing notification at the 200 ms mark');
  clock.advance(1000);
  assert.equal(calls.length, 3);
  assert.equal(clock.timers.size, 0);
});

test('research progress: a stage change during throttling notifies immediately and absorbs the pending preview', () => {
  const { store, clock, calls } = setup();
  store.begin('a.md', 'a1', 0);
  clock.advance(500);
  store.preview('a.md', 'a1', { summary: 'a' });
  store.preview('a.md', 'a1', { summary: 'ab' });
  const before = calls.length;
  store.stage('a.md', 'a1', 'charts', clock.now());
  assert.equal(calls.length, before + 1);
  assert.equal(clock.timers.size, 0);
  clock.advance(1000);
  assert.equal(calls.length, before + 1);
});

test('research progress: end and unsubscribe leave no pending timers', () => {
  const { store, clock, calls, unsubscribe } = setup();
  store.begin('a.md', 'a1', 0);
  clock.advance(500);
  store.preview('a.md', 'a1', { summary: 'a' });
  store.preview('a.md', 'a1', { summary: 'ab' });
  assert.equal(clock.timers.size, 1);
  store.end('a.md');
  assert.equal(clock.timers.size, 0);
  assert.equal(store.get('a.md'), undefined);
  const after = calls.length;
  clock.advance(1000);
  assert.equal(calls.length, after, 'no notification fires after end');

  store.begin('b.md', 'b1', 2000);
  clock.advance(500);
  store.preview('b.md', 'b1', { summary: 'a' });
  store.preview('b.md', 'b1', { summary: 'ab' });
  assert.equal(clock.timers.size, 1);
  unsubscribe();
  assert.equal(clock.timers.size, 0);
  assert.doesNotThrow(() => clock.advance(1000));
  store.end('missing.md');
});

test('research progress: end with an attempt id only removes the entry that attempt still owns', () => {
  const { store, calls } = setup();
  store.begin('a.md', 'run', 0);
  store.begin('a.md', 'charts-1', 5);
  store.end('a.md', 'run');
  assert.equal(store.get('a.md').attemptId, 'charts-1', 'the chart step that took over keeps its entry');
  store.end('a.md', 'charts-1');
  assert.equal(store.get('a.md'), undefined);
  assert.ok(calls.length >= 3);
});

test('research progress: the re-send handle lives only while slow and for the current attempt', () => {
  const { store } = setup();
  const resend = () => {};
  store.begin('a.md', 'a1', 0);
  store.markSlow('a.md', 'old', true, resend);
  assert.equal(store.get('a.md').slow, false, 'a stale attempt cannot raise the notice');
  store.markSlow('a.md', 'a1', true, resend);
  assert.equal(store.get('a.md').resend, resend);
  store.markSlow('a.md', 'a1', false);
  assert.equal(store.get('a.md').resend, undefined);
  store.markSlow('a.md', 'a1', true, resend);
  store.newAttempt('a.md', 'a2', 30);
  assert.equal(store.get('a.md').slow, false); assert.equal(store.get('a.md').resend, undefined);
});
