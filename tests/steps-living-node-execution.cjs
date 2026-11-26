const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('./support.cjs');
const { planLivingNodes } = S.load('experiences/visual-map/living-node-plan.ts');
const { executeLivingPlan } = S.load('experiences/visual-map/living-node-execution.ts');
const state = S.load('experiences/visual-map/living-node-state.ts');
const ai = (id, extra = {}) => ({ id, prompt: 'p', aiCard: true, hasKnowledge: true, ...extra });
const input = (extra = {}) => ({ configRevision: 'c1', model: 'm', language: 'en', reads: [{ id: 'a', revision: 'r1', scope: 'full' }], ...extra });
const ready = (validity = 'valid', extra = {}) => ({ validity, locked: false, current: true, ...extra });
const plain = value => JSON.parse(JSON.stringify(value));

test('state: input revisions include full content revisions, model, language and actual read scope', () => {
  const a = input();
  const revision = state.livingInputRevision(a);
  for (const changed of [
    input({ model: 'other' }), input({ language: 'zh-TW' }), input({ configRevision: 'c2' }),
    input({ reads: [{ id: 'a', revision: 'r2', scope: 'full' }] }),
    input({ reads: [{ id: 'a', revision: 'r1', scope: 'summary' }] })
  ]) assert.notEqual(state.livingInputRevision(changed), revision);
  assert.equal(state.livingInputRevision(input({ reads: [a.reads[0], a.reads[0]] })), revision);
  assert.equal(state.livingConfigRevision(' p ', ['b', 'a', 'a']), state.livingConfigRevision('p', ['a', 'b']));
  assert.notEqual(state.livingKnowledgeRevision('same summary\nnew detail', []), state.livingKnowledgeRevision('same summary\nold detail', []));
});

test('state: success, failure, stale and no-change diagnostics are independent', () => {
  const first = state.livingSuccess({ latestOutcome: 'never' }, 't1', input(), 'k1');
  const failed = state.livingAttempt(first, 't2', 'failed');
  assert.equal(failed.latestOutcome, 'failed');
  assert.equal(failed.lastSuccessfulCheck, 't1');
  assert.equal(state.livingValidity(failed.lastSuccessfulInput, input(), 'k1', false), 'valid');
  assert.equal(state.livingValidity(failed.lastSuccessfulInput, input(), 'k1', true), 'stale');
  assert.equal(state.livingValidity(failed.lastSuccessfulInput, input(), 'k2', false), 'stale');
  assert.equal(state.livingValidity(undefined, input(), 'k1', false), 'none');
  const unchanged = state.livingSuccess(failed, 't3', input(), 'k1');
  assert.equal(unchanged.lastSuccessfulCheck, 't3');
  assert.equal(unchanged.lastAttempt, 't3');
  assert.equal(unchanged.lastContentChange, 't1');
  assert.equal(state.livingSuccess(unchanged, 't4', input(), 'k2').lastContentChange, 't4');
});

test('state: reject stale, cross-card, cross-view, replay, locked, cancelled and unready commits', () => {
  const candidate = { executionId: 'e', cardId: 'a', mapId: 'm', baseRevision: 'b', inputRevision: 'i', viewSession: 'v' };
  const current = { ...candidate, locked: false, aborted: false, dependenciesReady: true, alreadyCommitted: false };
  assert.equal(state.canCommitLivingCandidate(candidate, current), true);
  for (const change of [
    { executionId: 'other' }, { cardId: 'other' }, { mapId: 'other' }, { baseRevision: 'new' },
    { inputRevision: 'new' }, { viewSession: 'new' }, { locked: true }, { aborted: true },
    { dependenciesReady: false }, { alreadyCommitted: true }
  ]) assert.equal(state.canCommitLivingCandidate(candidate, { ...current, ...change }), false);
});

test('execution: no-op clears derived stale before dispatch; explicit target still runs', async () => {
  const plan = planLivingNodes([ai('root'), ai('middle', { parentId: 'root' }), ai('leaf', { parentId: 'middle' })], ['root']);
  const called = [];
  let leafDone = false;
  const results = await executeLivingPlan(plan, {
    signal: new AbortController().signal,
    inspect: async id => ready(id === 'leaf' || (id === 'middle' && !leafDone) ? 'stale' : 'valid'),
    execute: async id => { called.push(id); if (id === 'leaf') leafDone = true; return 'no-change'; }
  });
  assert.deepEqual(called, ['leaf', 'root']);
  assert.deepEqual(plain([...results]), [['leaf', 'no-change'], ['middle', 'reused'], ['root', 'no-change']]);
});

test('execution: failure blocks dependent branches without losing independent results', async () => {
  const plan = planLivingNodes([ai('root'), ai('child', { parentId: 'root' }), ai('other')]);
  const called = [];
  const results = await executeLivingPlan(plan, {
    signal: new AbortController().signal, inspect: async () => ready(),
    execute: async id => { called.push(id); if (id === 'child') throw new Error('provider'); return 'changed'; }
  });
  assert.equal(results.get('child'), 'failed');
  assert.equal(results.get('root'), 'blocked');
  assert.equal(results.get('other'), 'changed');
  assert.equal(called.includes('root'), false);
});

test('execution: stop retains a completed commit and prevents later dispatch', async () => {
  const controller = new AbortController();
  const plan = planLivingNodes([ai('a'), ai('b')]);
  const called = [];
  const results = await executeLivingPlan(plan, {
    signal: controller.signal, inspect: async () => ready(),
    execute: async id => { called.push(id); controller.abort(); return 'changed'; }
  });
  assert.deepEqual(called, ['a']);
  assert.equal(results.get('a'), 'changed');
  assert.equal(results.get('b'), 'not-run');
});

test('execution: frozen dependency changed or lost blocks its consumer', async () => {
  const plan = planLivingNodes([ai('root'), ai('frozen', { parentId: 'root', aiLocked: true }), ai('other')]);
  for (const frozenState of [ready('none', { locked: true }), ready('valid', { locked: false }), ready('valid', { locked: true, current: false })]) {
    const called = [];
    const results = await executeLivingPlan(plan, {
      signal: new AbortController().signal, inspect: async id => id === 'frozen' ? frozenState : ready(),
      execute: async id => { called.push(id); return 'changed'; }
    });
    assert.equal(results.get('root'), 'blocked');
    assert.deepEqual(called, ['other']);
  }
});
