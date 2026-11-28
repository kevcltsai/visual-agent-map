const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('./support.cjs');
const state = S.load('experiences/visual-map/living-node-state.ts');
const plain = value => JSON.parse(JSON.stringify(value));
const card = (extra = {}) => state.livingCardState({ runtime: 'idle', latestOutcome: 'never', validity: 'none', ...extra });

test('card state: the seven states come from the actual task result', () => {
  const table = [
    ['suggested: never run', {}, 'suggested'],
    ['suggested: ok but stale', { latestOutcome: 'ok', validity: 'stale' }, 'suggested'],
    ['suggested: ok but the knowledge is gone (validity none)', { latestOutcome: 'ok', validity: 'none' }, 'suggested'],
    ['suggested: ok with validity not loaded', { latestOutcome: 'ok', validity: undefined }, 'suggested'],
    ['waiting', { runtime: 'waiting' }, 'waiting'],
    ['running', { runtime: 'running' }, 'running'],
    ['done: changed', { settlement: 'changed' }, 'done'],
    ['done: no-change', { settlement: 'no-change' }, 'done'],
    ['done: stored ok and valid', { latestOutcome: 'ok', validity: 'valid' }, 'done'],
    ['failed: settlement', { settlement: 'failed' }, 'failed'],
    ['failed: stored attempt', { latestOutcome: 'failed', validity: 'valid' }, 'failed'],
    ['blocked: settlement', { settlement: 'blocked' }, 'blocked'],
    ['blocked: stored attempt', { latestOutcome: 'blocked' }, 'blocked'],
    ['stopped: cancelled', { settlement: 'cancelled' }, 'stopped'],
    ['stopped: not-run in aborted round', { settlement: 'not-run', aborted: true }, 'stopped'],
    ['stopped: stored attempt', { latestOutcome: 'cancelled' }, 'stopped']
  ];
  for (const [name, input, want] of table) assert.equal(card(input), want, name);
});

test('card state: edge inputs', () => {
  // running and waiting win over any stored or settled result
  assert.equal(card({ runtime: 'running', settlement: 'failed', latestOutcome: 'failed' }), 'running');
  assert.equal(card({ runtime: 'waiting', latestOutcome: 'ok', validity: 'valid' }), 'waiting');
  // a not-run card of a normal round and a reused card keep what was stored, not done or stopped
  assert.equal(card({ settlement: 'not-run', latestOutcome: 'ok', validity: 'valid' }), 'done');
  assert.equal(card({ settlement: 'not-run' }), 'suggested');
  assert.equal(card({ settlement: 'reused', latestOutcome: 'never', validity: 'none' }), 'suggested');
  assert.equal(card({ settlement: 'reused', latestOutcome: 'ok', validity: 'valid' }), 'done');
  // this round's result beats an older stored attempt
  assert.equal(card({ settlement: 'changed', latestOutcome: 'failed' }), 'done');
  assert.equal(card({ settlement: 'cancelled', latestOutcome: 'ok', validity: 'valid' }), 'stopped');
  assert.equal(card({ aborted: true, latestOutcome: 'ok', validity: 'valid' }), 'done');
});

test('card state: a failed attempt is orthogonal to validity', () => {
  for (const validity of ['none', 'valid', 'stale']) assert.equal(card({ latestOutcome: 'failed', validity }), 'failed');
  const first = state.livingSuccess({ latestOutcome: 'never' }, 't1', { configRevision: 'c', model: 'm', language: 'en', reads: [] }, 'k1');
  const failed = state.livingAttempt(first, 't2', 'failed');
  assert.equal(state.livingValidity(failed.lastSuccessfulInput, { configRevision: 'c', model: 'm', language: 'en', reads: [] }, 'k1', false), 'valid');
  assert.equal(card({ latestOutcome: failed.latestOutcome, validity: 'valid' }), 'failed');
});

test('round stats: success is changed plus no-change only; reused and skipped are not success', () => {
  const all = ['changed', 'no-change', 'reused', 'failed', 'blocked', 'cancelled', 'not-run'];
  assert.deepEqual(plain(state.livingRoundStats(all)), { success: 2, noChange: 1, failed: 1, blocked: 1, cancelled: 1, skipped: 1, reused: 1 });
  assert.deepEqual(plain(state.livingRoundStats(['reused', 'reused', 'not-run'])), { success: 0, noChange: 0, failed: 0, blocked: 0, cancelled: 0, skipped: 1, reused: 2 });
  assert.deepEqual(plain(state.livingRoundStats([])), { success: 0, noChange: 0, failed: 0, blocked: 0, cancelled: 0, skipped: 0, reused: 0 });
});

test('round stats: a not-run in an aborted round is stopped, otherwise skipped', () => {
  assert.deepEqual(plain(state.livingRoundStats(['changed', 'not-run', 'not-run'], true)), { success: 1, noChange: 0, failed: 0, blocked: 0, cancelled: 2, skipped: 0, reused: 0 });
  assert.equal(state.livingRoundStats(new Set(['not-run']).values(), false).skipped, 1);
});
