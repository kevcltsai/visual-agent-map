// Hypothesis research progress bar (P9b): describeArgumentProgress is a pure function of the saved state; renderArgumentRunBar builds the
// bar from it. Unit level: the view method runs on a plain object with a DOM stand-in, no Obsidian.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('./support.cjs');
const dom = require('./support-dom.cjs');
const progress = S.load('experiences/visual-map/argument-progress.ts');
const machine = S.load('core/argument-map/machine.ts');
const { translate } = S.load('i18n.ts');

const notices = [];
class Notice { constructor(message) { notices.push(message); } }
const MODULES = S.load('main.ts', { obsidian: { ...S.obsidian, Notice } }, { createFragment: dom.createFragment });
const { VisualAgentMapView } = MODULES;
const Plugin = MODULES.default;

const t = (key, ...values) => translate('en', key, ...values);
const roles = { proposition: 'p', situation: 's', conclusion: 'c', verified: 'v', eliminated: 'e' };
const need = (id, state) => ({ id, text: id, addedRound: 1, state });
const hyp = (id, needs, over = {}) => ({ id, citedData: [], round: 1, location: 'verifying', needs, ...over });
const make = ({ phase = 'analysis', status = 'running', stopReason, calls = 0, hypotheses = [], data = [] } = {}) => {
  const state = machine.newArgumentMap(roles, 'run');
  Object.assign(state.run, { phase, status, researchCalls: calls });
  if (stopReason) state.run.stopReason = stopReason;
  state.hypotheses = hypotheses;
  state.situation.data = data;
  return state;
};
const plain = value => JSON.parse(JSON.stringify(value));
const describe = (state, owned) => plain(progress.describeArgumentProgress(state, owned, t));

test('running and owned, analysis: round, searching evidence, used count, stop', () => {
  const state = make({ calls: 12, hypotheses: [hyp('h1', [need('a', 'searching'), need('b', 'found')], { round: 2 }), hyp('h2', [need('c', 'searching')], { round: 1 }), hyp('h3', [need('d', 'searching')], { location: 'eliminated', round: 3 })] });
  assert.deepEqual(describe(state, true), { tone: 'run', title: 'Testing hypotheses · round 2', detail: 'Looking for 2 pieces of evidence', count: '12/78 research calls used', action: 'stop' });
});

test('running and owned: round defaults to 1; no detail when nothing is searching', () => {
  const view = describe(make({ hypotheses: [hyp('h1', [need('a', 'pending')])] }), true);
  assert.equal(view.title, 'Testing hypotheses · round 1');
  assert.equal(view.detail, undefined);
  assert.equal(describe(make({ hypotheses: [] }), true).title, 'Testing hypotheses · round 1');
});

test('running and owned, situation phase: checking the situation with the data being searched', () => {
  const data = [{ id: 'd1', need: 'x', attempts: 1, state: 'searching' }, { id: 'd2', need: 'y', attempts: 0, state: 'pending' }];
  assert.deepEqual(describe(make({ phase: 'situation', data, calls: 1 }), true), { tone: 'run', title: 'Checking the situation', detail: 'Looking for 1 data points', count: '1/78 research calls used', action: 'stop' });
  assert.equal(describe(make({ phase: 'situation' }), true).detail, undefined);
});

test('paused by the user: paused, verified count, used count, resume', () => {
  const state = make({ status: 'paused', stopReason: 'user', calls: 20, hypotheses: [hyp('h1', [{ ...need('a', 'found'), stance: 'supports' }], { aiVerdict: 'supported' })] });
  assert.deepEqual(describe(state, false), { tone: 'paused', title: 'Paused', detail: '1/3 hypotheses verified', count: '20/78 research calls used', action: 'resume' });
  assert.equal(describe(make({ status: 'paused' }), false).action, 'resume', 'no stop reason is treated like the user stopping');
});

test('interrupted (paused or still marked running with no owner): says so, will not rerun, resume only when paused', () => {
  const paused = describe(make({ status: 'paused', stopReason: 'interrupted', calls: 9 }), false);
  assert.deepEqual(paused, { tone: 'warn', title: 'Interrupted last time, paused', detail: 'It will not run again on its own', action: 'resume' });
  const running = describe(make({ status: 'running' }), false);
  assert.deepEqual(running, { tone: 'warn', title: 'Interrupted last time, paused', detail: 'It will not run again on its own', action: null });
});

test('paused by an error: the retry also failed text and resume, no count', () => {
  assert.deepEqual(describe(make({ status: 'paused', stopReason: 'error', calls: 30 }), false), { tone: 'warn', title: 'Paused', detail: 'The AI reply could not be used; a retry also failed', action: 'resume' });
});

test('counterexample: finished, concluded, stopped_mismatch and stopped_limit are ended with no resume, whatever the status', () => {
  for (const phase of ['concluded', 'stopped_mismatch', 'stopped_limit']) {
    for (const status of ['running', 'paused', 'finished']) {
      const view = describe(make({ phase, status, stopReason: status === 'paused' ? 'user' : undefined, calls: 40 }), status === 'running');
      assert.equal(view.action, null, `${phase}/${status}`);
      assert.equal(view.tone, 'done');
      assert.equal(view.title, 'Finished');
      assert.equal(view.detail, 'See the conclusion card for the result');
      assert.equal(view.count, '40 research calls in total');
    }
  }
  const finished = describe(make({ status: 'finished', phase: 'analysis', calls: 5 }), false);
  assert.equal(finished.action, null);
  assert.equal(finished.tone, 'done');
});

// ---- the bar in the view -----------------------------------------------------------------------------------------------
function fakeView(state, { owned = false, argumentMap = state } = {}) {
  const calls = { stop: [], resume: [] };
  const view = {
    path: 'M.vam',
    contentEl: dom.element('div'),
    map: { id: 'm1', nodes: [{ id: 'p' }, { id: 's' }, { id: 'c' }, { id: 'v' }, { id: 'e' }], ...(argumentMap === undefined ? {} : { argumentMap }) },
    plugin: { argumentRuns: { isRunning: () => owned, stop: path => { calls.stop.push(path); return Promise.resolve(); }, resume: path => { calls.resume.push(path); return view.resumeResult(path); } } },
    resumeResult: () => Promise.resolve()
  };
  return { view, calls };
}
const render = view => { const parent = dom.element('div'); parent.root = view.contentEl.root; Object.defineProperty(parent, 'ownerDocument', { get: () => parent.root }); view.contentEl = parent; VisualAgentMapView.prototype.renderArgumentRunBar.call(view, parent); return parent; };
const bars = parent => dom.findAll(parent, i => i.cls.split(/\s+/).includes('vam-argument-bar'));
const buttons = parent => dom.findAll(parent, i => i.tag === 'button');

test('the bar: region named, status live region holds only the phase text, count stays outside it, state on the bar', () => {
  const { view } = fakeView(make({ calls: 7, hypotheses: [hyp('h1', [need('a', 'searching')])] }), { owned: true });
  const parent = render(view);
  const [bar] = bars(parent);
  assert.equal(bars(parent).length, 1);
  assert.equal(bar.attrs.role, 'region');
  assert.equal(bar.attrs['aria-label'], 'Hypothesis research progress');
  assert.equal(bar.attrs['data-state'], 'run');
  assert.equal(bar.attrs.tabindex, '-1');
  const [status] = dom.findAll(bar, i => i.cls.split(/\s+/).includes('vam-argument-bar-status'));
  assert.equal(status.attrs.role, 'status');
  assert.equal(status.attrs['aria-live'], 'polite');
  const statusText = dom.texts(status).join(' ');
  assert.match(statusText, /Testing hypotheses/);
  assert.match(statusText, /Looking for 1 pieces of evidence/);
  assert.doesNotMatch(statusText, /research calls/, 'the count is not read out on every change');
  const [count] = dom.findAll(bar, i => i.cls.split(/\s+/).includes('vam-argument-bar-count'));
  assert.equal(count.text, '7/78 research calls used');
  assert.equal(dom.findAll(status, i => i === count).length, 0);
  assert.deepEqual(buttons(bar).map(b => b.text), ['Stop']);
});

test('stop: the button is disabled and the run is stopped; resume: mod-cta, disabled, runner asked once', async () => {
  const running = fakeView(make({ calls: 1 }), { owned: true });
  const bar = bars(render(running.view))[0];
  const stop = buttons(bar)[0];
  stop.click();
  assert.equal(stop.disabled, true);
  assert.deepEqual(running.calls.stop, ['M.vam']);
  const paused = fakeView(make({ status: 'paused', stopReason: 'user' }));
  const resume = buttons(bars(render(paused.view))[0])[0];
  assert.equal(resume.text, 'Resume');
  assert.ok(resume.hasClass('mod-cta'));
  resume.click();
  assert.equal(resume.disabled, true);
  assert.deepEqual(paused.calls.resume, ['M.vam']);
  await new Promise(resolve => setImmediate(resolve));
});

test('counterexample: a forced resume on a finished run shows the finished notice; other refusals show the generic one; busy is silent', async () => {
  const runs = new Plugin().argumentRuns;
  const refusal = async (call) => (await call().catch(error => error));
  const finished = await refusal(() => runs.start('Nothing.md', ''));
  assert.ok(finished && finished.code, 'the real runner refuses with a code');
  for (const [code, expected] of [['finished', ['This research has ended and cannot be resumed.']], ['not_paused', ['Could not resume this research.']], ['busy', []]]) {
    const { view } = fakeView(make({ status: 'paused', stopReason: 'user' }));
    const error = Object.assign(Object.create(Object.getPrototypeOf(finished)), finished, { code });
    view.resumeResult = () => Promise.reject(error);
    notices.length = 0;
    const resume = buttons(bars(render(view))[0])[0];
    resume.click();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(notices, expected, code);
  }
});

test('counterexample: a terminal state has no resume or stop button to press; the bar still names the result', () => {
  for (const phase of ['concluded', 'stopped_mismatch', 'stopped_limit']) {
    const { view } = fakeView(make({ phase, status: 'paused', stopReason: 'user', calls: 3 }));
    const [bar] = bars(render(view));
    assert.equal(buttons(bar).length, 0, phase);
    assert.equal(bar.attrs['data-state'], 'done');
  }
});

test('counterexample: ordinary maps, version 2 keys and unusable keys get no bar elements', () => {
  const none = fakeView(undefined, { argumentMap: undefined });
  assert.equal(render(none.view).children.length, 0, 'no key');
  const v2 = fakeView(undefined, { argumentMap: { ...make(), v: 2 } });
  assert.equal(render(v2.view).children.length, 0, 'v: 2');
  const broken = fakeView(undefined, { argumentMap: { v: 1 } });
  assert.equal(render(broken.view).children.length, 0, 'unusable');
});

// ---- keyboard focus survives the repaint (paint() empties contentEl) -----------------------------------------------------
const withDocument = view => { view.contentEl.root = { activeElement: null, body: { tag: 'body' } }; Object.defineProperty(view.contentEl, 'ownerDocument', { get: () => view.contentEl.root }); return view; };
const repaint = view => {
  const restore = VisualAgentMapView.prototype.keepArgumentBarFocus.call(view);
  const doc = view.contentEl.root;
  doc.activeElement = doc.body; // the old bar is gone: focus fell to the page
  const parent = render(view);
  restore();
  return { parent, doc };
};

test('focus follows the swap: after stop the next bar puts focus on resume; after resume, on stop; a bar without buttons takes it itself', () => {
  const view = withDocument(fakeView(make({ calls: 1 }), { owned: true }).view);
  let parent = render(view);
  buttons(parent)[0].click();
  view.map.argumentMap = make({ status: 'paused', stopReason: 'user' });
  view.plugin.argumentRuns.isRunning = () => false;
  parent = repaint(view).parent;
  const resume = buttons(parent)[0];
  assert.equal(resume.focused, true, 'focus on resume');
  resume.click();
  view.map.argumentMap = make({ calls: 2 });
  view.plugin.argumentRuns.isRunning = () => true;
  parent = repaint(view).parent;
  assert.equal(buttons(parent)[0].focused, true, 'focus on stop');
  buttons(parent)[0].click();
  view.map.argumentMap = make({ phase: 'concluded', status: 'finished' });
  parent = repaint(view).parent;
  assert.equal(bars(parent)[0].focused, true, 'no button: the bar holds the focus');
});

test('focus is not moved by a repaint that did not change the button, nor when nothing was pressed', () => {
  const view = withDocument(fakeView(make({ calls: 1 }), { owned: true }).view);
  let parent = render(view);
  assert.equal(buttons(parent)[0].focused, undefined, 'nothing pressed: no focus taken');
  buttons(parent)[0].click();
  view.map.argumentMap = make({ calls: 2 });
  parent = repaint(view).parent;
  assert.equal(buttons(parent)[0].focused, undefined, 'same action still showing: wait for the swap');
});

test('keyboard focus on Stop is restored to the new Stop after a checkpoint repaint', () => {
  const view = withDocument(fakeView(make({ calls: 1 }), { owned: true }).view);
  buttons(render(view))[0].focus();
  view.map.argumentMap = make({ calls: 2 });
  const { parent, doc } = repaint(view);
  assert.equal(doc.activeElement, buttons(parent)[0]);
  assert.equal(buttons(parent)[0].text, 'Stop');
});

test('keyboard focus on Resume is restored to the new Resume after a repaint', () => {
  const view = withDocument(fakeView(make({ status: 'paused', stopReason: 'user' })).view);
  buttons(render(view))[0].focus();
  const { parent, doc } = repaint(view);
  assert.equal(doc.activeElement, buttons(parent)[0]);
  assert.equal(buttons(parent)[0].text, 'Resume');
});

test('counterexample: a repaint does not take focus when the keyboard was not in the bar', () => {
  const view = withDocument(fakeView(make({ calls: 1 }), { owned: true }).view);
  render(view);
  const other = dom.element('input');
  other.focus = () => { view.contentEl.root.activeElement = other; };
  other.focus();
  const restore = VisualAgentMapView.prototype.keepArgumentBarFocus.call(view);
  const parent = render(view);
  restore();
  assert.equal(view.contentEl.root.activeElement, other);
  assert.equal(buttons(parent)[0].focused, undefined);
});

test('counterexample: press Stop, move focus elsewhere (it is inside the content a repaint empties), several repaints, focus is never pulled back', () => {
  const view = withDocument(fakeView(make({ calls: 1 }), { owned: true }).view);
  buttons(render(view))[0].click();
  const composer = dom.element('textarea');
  composer.root = view.contentEl.root;
  composer.focus();
  view.map.argumentMap = make({ status: 'paused', stopReason: 'user' });
  view.plugin.argumentRuns.isRunning = () => false;
  for (let n = 0; n < 3; n++) {
    const { parent, doc } = repaint(view);
    assert.equal(buttons(parent)[0].focused, undefined, `repaint ${n}: the new button took nothing`);
    assert.equal(doc.activeElement, doc.body, `repaint ${n}: the composer is rebuilt by the view, the bar leaves the focus alone`);
    doc.activeElement = composer; // the view puts the focus back on the composer after the repaint
  }
});

test('counterexample: a press on one map does not move focus in a bar of another map', () => {
  const view = withDocument(fakeView(make({ calls: 1 }), { owned: true }).view);
  buttons(render(view))[0].click();
  view.path = 'Other.vam';
  view.map.argumentMap = make({ status: 'paused', stopReason: 'user' });
  view.plugin.argumentRuns.isRunning = () => false;
  assert.equal(buttons(repaint(view).parent)[0].focused, undefined);
});

test('legacy refusal: resuming a pre-question-type facet map shows the "use the definitions card" notice, not the generic one', async () => {
  const runs = new Plugin().argumentRuns;
  const base = await runs.start('Nothing.md', '').catch(error => error);
  const { view } = fakeView(make({ status: 'paused', stopReason: 'user' }));
  view.resumeResult = () => Promise.reject(Object.assign(Object.create(Object.getPrototypeOf(base)), base, { code: 'legacy' }));
  notices.length = 0;
  buttons(bars(render(view))[0])[0].click();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(notices, [translate('en', 'ui.argument_resume_refused_legacy')]);
  assert.match(notices[0], /Re-run with these assumptions/);
});

test('fact question: the running bar says the conclusion is being written (no hypothesis round); a paused one shows no verified count', () => {
  const fact = make({ calls: 4 });
  fact.situation.facets = [{ id: 'f1', title: 'F', verdict: 'supports', reason: '', citedData: [], summary: '' }];
  fact.situation.questionType = 'fact';
  assert.deepEqual(describe(fact, true), { tone: 'run', title: 'Writing the conclusion from the facets', count: '4/78 research calls used', action: 'stop' });
  fact.run.status = 'paused';
  fact.run.stopReason = 'user';
  const paused = describe(fact, false);
  assert.equal(paused.detail, undefined);
  assert.equal(paused.action, 'resume');
  const causal = make({ status: 'paused', stopReason: 'user' });
  causal.situation.questionType = 'causal';
  assert.match(describe(causal, false).detail, /hypotheses verified/);
});
