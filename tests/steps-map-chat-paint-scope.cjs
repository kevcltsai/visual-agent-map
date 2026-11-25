const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./support-replay.cjs');
const { MapChatPaintScope } = load('experiences/visual-map/map-chat-paint-scope.ts');

function clock() {
  let next = 0;
  const intervals = new Map(), frames = new Map();
  const win = {
    setInterval(fn, ms) { assert.equal(ms, 1000); intervals.set(++next, fn); return next; },
    clearInterval(id) { intervals.delete(id); },
    requestAnimationFrame(fn) { frames.set(++next, fn); return next; },
    cancelAnimationFrame(id) { frames.delete(id); }
  };
  return { win, intervals, frames };
}

test('paint scope keeps one callback per slot and permits the next streaming frame', () => {
  const s = new MapChatPaintScope(), c = clock();
  let ticks = 0, paints = 0;
  s.interval('stage', c.win, () => ticks++);
  s.interval('stage', c.win, () => assert.fail('duplicate interval'));
  s.frame('stream', c.win, () => paints++);
  s.frame('stream', c.win, () => assert.fail('duplicate frame'));
  assert.equal(c.intervals.size, 1);
  assert.equal(c.frames.size, 1);
  [...c.intervals.values()][0]();
  [...c.intervals.values()][0]();
  const [id, run] = [...c.frames.entries()][0]; c.frames.delete(id); run(); run();
  assert.equal(ticks, 2); assert.equal(paints, 1);
  s.frame('stream', c.win, () => paints++);
  assert.equal(c.frames.size, 1);
  s.dispose();
});

test('cancel uses the scheduling window and stale callbacks cannot clear a replacement', () => {
  const s = new MapChatPaintScope(), old = clock(), current = clock();
  let paints = 0;
  s.frame('scroll', old.win, () => assert.fail('stale frame'));
  const stale = [...old.frames.values()][0];
  s.cancel('scroll');
  assert.equal(old.frames.size, 0);
  s.frame('scroll', current.win, () => paints++);
  stale();
  s.frame('scroll', current.win, () => assert.fail('replacement was lost'));
  assert.equal(current.frames.size, 1);
  [...current.frames.values()][0]();
  assert.equal(paints, 1);
  s.dispose();
});

test('reset cancels all four slots and permits a new conversation; disposal blocks scheduling until an explicit activation', () => {
  const s = new MapChatPaintScope(), c = clock();
  const oldPaint = () => assert.fail('old conversation painted');
  s.interval('stage', c.win, oldPaint);
  s.interval('chain-wait', c.win, oldPaint);
  s.frame('stream', c.win, oldPaint);
  s.frame('scroll', c.win, oldPaint);
  const queued = [...c.intervals.values(), ...c.frames.values()];
  s.reset();
  assert.equal(c.intervals.size, 0); assert.equal(c.frames.size, 0);
  queued.forEach(fn => fn());
  let ticks = 0;
  s.interval('chain-wait', c.win, () => ticks++);
  [...c.intervals.values()][0](); assert.equal(ticks, 1);
  const late = [...c.intervals.values()][0];
  s.dispose(); s.dispose(); late();
  s.interval('stage', c.win, oldPaint);
  s.frame('stream', c.win, oldPaint);
  s.frame('scroll', undefined, oldPaint);
  assert.equal(ticks, 1);
  assert.equal(c.intervals.size, 0); assert.equal(c.frames.size, 0);
  s.activate();
  s.frame('scroll', c.win, () => ticks++);
  late();
  [...c.frames.values()][0]();
  assert.equal(ticks, 2);
  s.dispose();
});

test('missing scheduling APIs keep frame fallback and suppress callbacks without cancellation APIs', () => {
  const s = new MapChatPaintScope();
  let paints = 0, late;
  s.interval('stage', undefined, () => assert.fail('no interval API'));
  s.frame('stream', undefined, () => paints++);
  assert.equal(paints, 1);
  s.frame('scroll', { requestAnimationFrame(fn) { late = fn; return 1; } }, () => assert.fail('stale frame'));
  s.cancel('scroll'); late();
  s.dispose();
});
