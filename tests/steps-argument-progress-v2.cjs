// Version 2 progress bar text (packet V7): describeArgumentProgressV2 is a pure function of the saved state; the legacy bar offers nothing.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('./support.cjs');
const progress = S.load('experiences/visual-map/argument-progress-v2.ts');
const machine = S.load('core/argument-map/machine.ts');
const { translate } = S.load('i18n.ts');
const { v2State } = require('./fixtures/argument-map-v2-state.cjs');

const t = (key, ...values) => translate('en', key, ...values);
const plain = value => JSON.parse(JSON.stringify(value));
const make = ({ phase = 'analysis', status = 'running', stopReason, calls = 0, mutate } = {}) => {
  const state = plain(v2State());
  Object.assign(state.run, { phase, status, researchCalls: calls });
  if (stopReason) state.run.stopReason = stopReason; else delete state.run.stopReason;
  mutate?.(state);
  return state;
};
const describe = (state, owned) => plain(progress.describeArgumentProgressV2(state, owned, t));

test('running and owned: the title names the phase; only a running owned run offers stop and shows the used count', () => {
  const titles = { premises: 'Checking premises', comparison: 'Comparing hypotheses', conclusion: 'Writing the conclusion', inference_check: 'Checking the inferences' };
  for (const [phase, title] of Object.entries(titles)) {
    const view = describe(make({ phase, calls: 5 }), true);
    assert.equal(view.title, title, phase);
    assert.equal(view.action, 'stop');
    assert.equal(view.tone, 'run');
    assert.equal(view.count, '5/66 research calls used');
  }
});

test('analysis stage: proposing, finding evidence (round, searching count), assessing, judging', () => {
  const open = state => { delete state.hypotheses[0].verdict; };
  assert.equal(describe(make({ mutate: s => { s.hypotheses = []; } }), true).title, 'Proposing hypotheses');
  const searching = describe(make({ mutate: s => { open(s); s.hypotheses[0].round = 2; s.hypotheses[0].needs[0].state = 'searching'; } }), true);
  assert.equal(searching.title, 'Finding evidence · round 2');
  assert.match(searching.detail, /Looking for 1 pieces of evidence/);
  assert.equal(describe(make({ mutate: s => { open(s); s.hypotheses[0].needs[0].state = 'found'; delete s.hypotheses[0].needs[0].assessment; } }), true).title, 'Assessing evidence');
  assert.equal(describe(make({ mutate: open }), true).title, 'Judging hypotheses');
});

test('premise phase: the data being searched is counted', () => {
  const view = describe(make({ phase: 'premises', mutate: s => { s.claims[0].data[0].state = 'searching'; } }), true);
  assert.equal(view.detail, 'Looking for 1 premise data points');
});

test('a premise that did not hold: the not-evaluated count rides on a running bar, and stopped_premise is final with no button', () => {
  const view = describe(make({ phase: 'comparison', mutate: s => { s.claims[1].status = 'not_evaluated'; } }), true);
  assert.equal(view.detail, '1 claims not evaluated because a premise did not hold');
  const stopped = describe(make({ phase: 'stopped_premise', status: 'paused', stopReason: 'premise', calls: 3 }), false);
  assert.deepEqual(stopped, { tone: 'done', title: 'Stopped: a premise did not hold', detail: 'See the conclusion card for the result', count: '3 research calls in total', action: null });
});

test('paused: each stop reason has its own words and offers resume; the interrupted and error ones are warnings', () => {
  const reasons = { limit: 'Research limit reached', data_missing: 'Premise data could not be found', premise: 'A premise did not hold', user: '0/1 hypotheses judged' };
  for (const [stopReason, text] of Object.entries(reasons)) {
    const view = describe(make({ status: 'paused', stopReason, calls: 8, mutate: s => { delete s.hypotheses[0].verdict; } }), false);
    assert.equal(view.title, 'Paused');
    assert.equal(view.detail, text, stopReason);
    assert.equal(view.action, 'resume');
    assert.equal(view.count, '8/66 research calls used');
  }
  assert.equal(describe(make({ status: 'paused', stopReason: 'interrupted' }), false).tone, 'warn');
  assert.equal(describe(make({ status: 'paused', stopReason: 'error' }), false).action, 'resume');
});

test('counterexample: running but nobody drives it is interrupted with no button; finished and concluded are final whatever the status', () => {
  const orphan = describe(make({ status: 'running' }), false);
  assert.deepEqual([orphan.tone, orphan.action], ['warn', null]);
  for (const [phase, status] of [['concluded', 'running'], ['concluded', 'paused'], ['analysis', 'finished']]) {
    const view = describe(make({ phase, status, stopReason: status === 'paused' ? 'user' : undefined, calls: 40 }), status === 'running');
    assert.equal(view.action, null, `${phase}/${status}`);
    assert.equal(view.title, 'Finished');
    assert.equal(view.count, '40 research calls in total');
  }
});

test('legacy bar: says old method and read-only, offers nothing, shows the total', () => {
  const roles = { proposition: 'p', situation: 's', conclusion: 'c', verified: 'v', eliminated: 'e' };
  const state = machine.newArgumentMap(roles, 'run');
  state.run.researchCalls = 12;
  const view = plain(progress.describeLegacyProgress(state, t));
  assert.equal(view.action, null);
  assert.equal(view.title, 'Old method (V1) · read-only');
  assert.equal(view.count, '12 research calls in total');
});
