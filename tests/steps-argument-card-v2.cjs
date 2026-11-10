// Version 2 argument cards (packet V7): what each card says for each state, the conclusion that never shows an answer early, the
// user's mark that is only a mark, model text that stays text, and the read-only marker on a legacy map. Pure + a DOM stand-in.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('./support.cjs');
const dom = require('./support-dom.cjs');
const card = S.load('experiences/visual-map/argument-card-v2.ts');
const machine = S.load('core/argument-map/machine.ts');
const { translate } = S.load('i18n.ts');
const { v2State } = require('./fixtures/argument-map-v2-state.cjs');

const t = (key, ...values) => translate('en', key, ...values);
const plain = value => JSON.parse(JSON.stringify(value));
const fresh = () => plain(v2State());
const view = (state, id) => plain(card.describeArgumentCardV2(state, id, t));
const chipTexts = v => v.chips.map(chip => chip.text);

// ---- comparison card -----------------------------------------------------------------------------------------------------------
test('comparison card: waiting until every hypothesis of the claim has a verdict, then in progress', () => {
  const state = fresh();
  delete state.hypotheses[0].verdict;
  const waiting = view(state, 'cmp');
  assert.equal(waiting.role, 'comparison');
  assert.equal(waiting.kind, t('ui.argument_v2_cmp_waiting'));
  assert.equal(waiting.title, t('ui.argument_v2_cmp_waiting_title'));
  assert.equal(waiting.state, 'pending');
  state.hypotheses[0].verdict = fresh().hypotheses[0].verdict;
  const running = view(state, 'cmp');
  assert.equal(running.kind, t('ui.argument_v2_cmp_running'));
  assert.equal(running.title, t('ui.argument_v2_cmp_running_title'));
  assert.equal(waiting.dashed, undefined);
});

test('comparison card: done shows the answer title; vetoed and undecidable list only the unresolved issues', () => {
  const state = fresh();
  Object.assign(state.claims[1].comparison, { state: 'done', answer: 'causal_conditional' });
  const done = view(state, 'cmp');
  assert.equal(done.kind, t('ui.argument_v2_cmp_done'));
  assert.equal(done.title, t('ui.argument_v2_answer_causal_conditional'));
  state.claims[1].comparison = { ...state.claims[1].comparison, state: 'vetoed', vetoes: [{ kind: 'missed_alternative', detail: 'x', resolved: false }, { kind: 'contradiction', detail: 'y', resolved: true }] };
  const vetoed = view(state, 'cmp');
  assert.equal(vetoed.kind, t('ui.argument_v2_cmp_vetoed'));
  assert.deepEqual(chipTexts(vetoed), [t('ui.argument_v2_cmp_blocked')]);
  assert.deepEqual(vetoed.lines, [t('ui.argument_v2_veto_missed_alternative')], 'a resolved veto is not listed');
  state.claims[1].comparison.state = 'undecidable';
  const undecidable = view(state, 'cmp');
  assert.equal(undecidable.kind, t('ui.argument_v2_cmp_undecidable'));
  assert.deepEqual(chipTexts(undecidable), [t('ui.argument_v2_claim_blocked')]);
});

test('comparison card: a hypothesis judged again marks the card; the veto detail text never reaches the card', () => {
  const state = fresh();
  state.hypotheses[0].verdict.reverdicts = 1;
  state.claims[1].comparison.vetoes[0].detail = 'SECRET-DETAIL';
  const v = view(state, 'cmp');
  assert.ok(chipTexts(v).includes(t('ui.argument_v2_reverdict')));
  assert.doesNotMatch(JSON.stringify(v), /SECRET-DETAIL/);
});

// ---- conclusion card -----------------------------------------------------------------------------------------------------------
test('conclusion card: four states; the answer (summary) is read only when concluded', () => {
  const state = fresh();
  Object.assign(state.run, { phase: 'concluded', status: 'finished' });
  state.conclusion.state = 'concluded';
  const concluded = view(state, 'c');
  assert.equal(card.conclusionViewV2(state), 'concluded');
  assert.equal(concluded.titleFrom, 'summary');
  assert.equal(concluded.kind, t('ui.argument_v2_concl_concluded'));
  state.conclusion.state = 'undecidable';
  const undecidable = view(state, 'c');
  assert.equal(undecidable.titleFrom, 'text');
  assert.equal(undecidable.title, t('ui.argument_v2_concl_undecidable_title'));
  state.run.phase = 'stopped_premise';
  const stopped = view(state, 'c');
  assert.equal(card.conclusionViewV2(state), 'stopped_premise');
  assert.equal(stopped.titleFrom, 'text');
  assert.equal(stopped.title, t('ui.argument_v2_concl_stopped_title'));
  state.run.phase = 'conclusion';
  state.conclusion.state = 'pending';
  assert.equal(card.conclusionViewV2(state), 'pending');
  assert.equal(view(state, 'c').titleFrom, 'text');
});

test('counterexample: inference_check or pending never shows the answer, even when the conclusion already says concluded', () => {
  for (const phase of ['premises', 'analysis', 'comparison', 'conclusion', 'inference_check']) {
    const state = fresh();
    state.run.phase = phase;
    state.conclusion.state = 'concluded';
    const v = view(state, 'c');
    assert.equal(card.conclusionViewV2(state), 'pending', phase);
    assert.notEqual(v.titleFrom, 'summary', phase);
    assert.equal(v.kind, t('ui.argument_v2_concl_pending'));
    assert.doesNotMatch(JSON.stringify(v), /parallel trends/, `${phase}: the answer sentence is not on the card`);
  }
  const state = fresh();
  state.run.phase = 'concluded';
  state.conclusion.state = 'pending';
  assert.equal(card.conclusionViewV2(state), 'pending', 'concluded phase with a pending conclusion is still pending');
});

test('a testable claim shows its answer only once the run has concluded', () => {
  const state = fresh();
  const open = view(state, 'q2');
  assert.deepEqual(open.lines.slice(0, 1), [t('ui.argument_v2_claim_answer_0', t('ui.argument_v2_claim_open'))]);
  Object.assign(state.run, { phase: 'concluded' });
  state.conclusion.state = 'concluded';
  assert.equal(view(state, 'q2').lines[0], t('ui.argument_v2_claim_answer_0', t('ui.argument_v2_answer_causal_conditional')));
});

// ---- premises: a failed premise stops only its dependants ----------------------------------------------------------------------
test('a failed premise: that premise says so; only the claim that depends on it is "not evaluated", an independent premise is untouched', () => {
  const state = fresh();
  state.claims.push({ id: 'q3', text: 'Another premise', type: 'fact', role: 'premise', dependsOn: [], definitions: [], status: 'done', result: 'holds', data: [] });
  state.claims[0].result = 'fails';
  state.claims[1].status = 'not_evaluated';
  const failed = view(state, 'q1');
  assert.deepEqual(chipTexts(failed), [t('ui.argument_v2_premise_fails')]);
  const stopped = view(state, 'q2');
  assert.equal(stopped.state, 'not_evaluated');
  assert.equal(stopped.dashed, true);
  assert.deepEqual(chipTexts(stopped), [t('ui.argument_v2_not_evaluated')]);
  const other = view(state, 'q3');
  assert.deepEqual(chipTexts(other), [t('ui.argument_v2_premise_holds')]);
  assert.equal(other.dashed, undefined);
});

// ---- hypotheses ----------------------------------------------------------------------------------------------------------------
test('hypothesis causal line: not applicable, established, conditional (assumptions named) and only compatible; absent for a non-cause role', () => {
  const state = fresh();
  const h = state.hypotheses[0];
  const line = causal => { h.verdict.causal = causal; return view(state, 'h1').lines[0]; };
  assert.equal(line('not_applicable'), t('ui.argument_v2_causal_line_0', t('ui.argument_v2_causal_not_applicable')));
  assert.equal(line('established'), t('ui.argument_v2_causal_line_0', t('ui.argument_v2_causal_established')));
  assert.equal(line('conditional'), t('ui.argument_v2_causal_line_0', t('ui.argument_v2_causal_conditional_0', 'parallel trends')));
  assert.equal(line('compatible'), t('ui.argument_v2_causal_line_0', t('ui.argument_v2_causal_compatible')));
  h.role = 'measurement';
  assert.doesNotMatch(view(state, 'h1').lines.join('|'), /Causation/);
  delete h.verdict;
  h.role = 'primary';
  assert.doesNotMatch(view(state, 'h1').lines.join('|'), /Causation/, 'no verdict yet: no causal line');
});

test('the user\'s mark is only a mark: shown as a chip, the verdict chip is the AI\'s and the card state does not change', () => {
  const state = fresh();
  const v = view(state, 'h1');
  assert.ok(chipTexts(v).includes(t('ui.hypothesis_supported')), 'the AI verdict stays');
  assert.ok(chipTexts(v).includes(t('ui.argument_v2_user_mark_0', t('ui.hypothesis_refuted'))), 'the mark is named as the user\'s');
  const noMark = fresh();
  delete noMark.hypotheses[0].userVerdict;
  assert.deepEqual(view(noMark, 'h1').chips.filter(chip => /Your mark/.test(chip.text)), []);
  assert.equal(JSON.stringify(view(state, 'cmp')), JSON.stringify(view(noMark, 'cmp')), 'the comparison ignores the mark');
});

test('a hypothesis added after the comparison carries the late marker; one with no verdict says it is being tested', () => {
  const state = fresh();
  state.hypotheses[0].addedAfterComparison = true;
  delete state.hypotheses[0].verdict;
  const v = view(state, 'h1');
  assert.ok(chipTexts(v).includes(t('ui.argument_v2_late')));
  assert.ok(chipTexts(v).includes(t('ui.argument_v2_testing')));
});

// ---- evidence chips ------------------------------------------------------------------------------------------------------------
test('evidence chips: checked quote versus unchecked quote in the type line', () => {
  const state = fresh();
  assert.match(view(state, 'n1').kind, /example\.org · Checked$/);
  state.hypotheses[0].needs[0].proof.check = 'not_checked';
  assert.match(view(state, 'n1').kind, new RegExp(`${t('ui.argument_v2_unchecked')}$`));
  delete state.hypotheses[0].needs[0].proof.check;
  assert.match(view(state, 'n1').kind, new RegExp(`${t('ui.argument_v2_unchecked')}$`));
});

test('evidence chips: scope mismatch and exploratory (registered post, no replaces) versus added later (replaces another need)', () => {
  const state = fresh();
  const n = state.hypotheses[0].needs[0];
  n.assessment.scopeFit = false;
  assert.ok(chipTexts(view(state, 'n1')).includes(t('ui.argument_v2_scope_mismatch')));
  n.registered = 'post';
  assert.ok(chipTexts(view(state, 'n1')).includes(t('ui.argument_v2_exploratory')));
  n.replaces = 'other';
  const replaced = chipTexts(view(state, 'n1'));
  assert.ok(replaced.includes(t('ui.argument_v2_post')));
  assert.ok(!replaced.includes(t('ui.argument_v2_exploratory')));
  n.registered = 'pre';
  delete n.replaces;
  assert.ok(!chipTexts(view(state, 'n1')).includes(t('ui.argument_v2_exploratory')), 'pre-registered is never exploratory');
});

test('evidence chips: missing evidence is dashed with its own wording; awaiting assessment when found but not assessed', () => {
  const state = fresh();
  const n = state.hypotheses[0].needs[0];
  delete n.assessment;
  assert.ok(chipTexts(view(state, 'n1')).includes(t('ui.argument_v2_awaiting_assessment')));
  for (const [s, key] of [['searching', 'ui.argument_missing_searching'], ['pending', 'ui.argument_missing_pending'], ['not_found', 'ui.argument_missing_not_found']]) {
    n.state = s;
    const v = view(state, 'n1');
    assert.equal(v.dashed, true, s);
    assert.deepEqual(chipTexts(v), [t(key)], s);
  }
});

// ---- model text is text --------------------------------------------------------------------------------------------------------
const EVIL = '<img src=x onerror=alert(1)><script>boom()</script>';
test('counterexample: model text becomes text, never markup (textContent through the DOM stand-in)', () => {
  const state = fresh();
  state.claims[0].data[0].proof.claim = EVIL;
  state.hypotheses[0].needs[0].proof.claim = EVIL;
  state.hypotheses[0].verdict.assumptionStatus[0].assumption = EVIL;
  state.framing.candidates[0].question = EVIL;
  state.claims[1].comparison.vetoes[0].detail = EVIL;
  for (const id of ['d1', 'n1', 'h1', 'p', 'cmp', 'q1', 'q2', 'c', 'pr']) {
    const v = card.describeArgumentCardV2(state, id, t);
    const host = dom.element('div');
    const header = host.createDiv({});
    card.renderArgumentKindV2(header, v);
    const root = host.createDiv({});
    card.renderArgumentCardBodyV2(root, v);
    const tags = dom.findAll(host, item => true).map(item => item.tag);
    assert.ok(tags.every(tag => ['div', 'span', 'p'].includes(tag)), `${id}: only div, span and p are created (${tags})`);
  }
  const shown = dom.texts(card.renderArgumentCardBodyV2(dom.element('div'), card.describeArgumentCardV2(state, 'd1', t))).join('|');
  assert.ok(shown.includes(EVIL), 'the string is shown literally');
});

test('the renderer source never writes HTML', () => {
  const source = require('node:fs').readFileSync(require('node:path').resolve(__dirname, '../experiences/visual-map/argument-card-v2.ts'), 'utf8');
  assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|createFragment|MarkdownRenderer/);
});

test('every node the flow owns has a card; an unknown id has none', () => {
  const state = fresh();
  for (const id of ['p', 'pr', 'c', 'q1', 'd1', 'q2', 'cmp', 'h1', 'n1']) assert.ok(card.describeArgumentCardV2(state, id, t), id);
  assert.equal(card.describeArgumentCardV2(state, 'nope', t), null);
});

// ---- legacy ------------------------------------------------------------------------------------------------------------------
test('legacy (V1) map: the conclusion card carries the "Old method (V1)" marker, other cards are the V1 cards unchanged', () => {
  const roles = { proposition: 'p', situation: 's', conclusion: 'c', verified: 'v', eliminated: 'e' };
  const state = plain(machine.newArgumentMap(roles, 'run'));
  const conclusion = plain(card.describeLegacyArgumentCard(state, 'c', t));
  assert.equal(conclusion.role, 'conclusion');
  assert.equal(conclusion.lines.at(-1), t('ui.argument_legacy_marker'));
  assert.match(conclusion.label, /Old method \(V1\)/);
  const others = plain(card.describeLegacyArgumentCard(state, 's', t));
  assert.doesNotMatch(JSON.stringify(others), /Old method/);
  assert.equal(card.describeLegacyArgumentCard(state, 'nope', t), null);
});

test('legacy (V1) map in the view: managed nodes still count as argument cards (so they stay locked), an ordinary node does not; the V2 key is the same', () => {
  const dom2 = require('./support-dom.cjs');
  const { VisualAgentMapView } = S.load('main.ts', { obsidian: S.obsidian }, { createFragment: dom2.createFragment });
  const roles = { proposition: 'p', situation: 's', conclusion: 'c', verified: 'v', eliminated: 'e' };
  const nodes = ['p', 's', 'c', 'v', 'e', 'free'].map(id => ({ id }));
  const legacy = { id: 'm', nodes, argumentMap: machine.newArgumentMap(roles, 'run') };
  const v2 = { id: 'm', nodes: ['p', 'pr', 'c', 'q1', 'd1', 'q2', 'cmp', 'h1', 'n1', 'free'].map(id => ({ id })), argumentMap: fresh() };
  for (const map of [legacy, v2]) {
    const fake = { map };
    const isCard = id => VisualAgentMapView.prototype.isArgumentCard.call(fake, id);
    assert.equal(isCard('c'), true);
    assert.equal(isCard('free'), false);
    const shape = VisualAgentMapView.prototype.argumentCardView.call(fake, 'c');
    assert.ok(shape && shape.role === 'conclusion');
  }
  const legacyShape = VisualAgentMapView.prototype.argumentCardView.call({ map: legacy }, 'c');
  assert.match(legacyShape.label, /Old method \(V1\)/);
});
