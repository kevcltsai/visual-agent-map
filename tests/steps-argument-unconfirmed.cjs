// Decision #58: a facet gate that ends data_insufficient no longer stops the run; the situation is "unconfirmed" and the run goes on.
// Unit level: machine, hypotheses parse, conclusion prompt, card, notes, data contract. The full run is in steps-argument-run.cjs.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const S = require('./support.cjs');
const { loadWithAiCalls } = require('./support-ai-calls.cjs');
const m = S.load('core/argument-map/machine.ts');
const model = S.load('core/argument-map/model.ts');
const card = S.load('experiences/visual-map/argument-card.ts');
const N = S.load('experiences/visual-map/argument-notes.ts');
const mod = loadWithAiCalls('core/steps/argument-map/runner.ts');
const { translate } = S.load('i18n.ts');

const roles = { proposition: 'p', situation: 's', conclusion: 'c', verified: 'v', eliminated: 'e' };
const plain = value => JSON.parse(JSON.stringify(value));
const proof = n => ({ url: `https://example.org/${n}`, quote: `quote number ${n} from the page`, claim: `claim ${n}`, check: 'page_match', checkedAt: '2026-11-09T00:00:00.000Z' });
const found = (stance, n) => ({ found: true, stance, proof: proof(n) });
const plan = () => ({
  assumptions: { id: 'as1', items: [{ label: 'Age band', value: '16-24', reason: 'the proposition says young people' }] },
  facets: [1, 2, 3, 4].map(i => ({ id: `f${i}`, title: `Facet ${i}`, needs: [{ id: `f${i}d1`, need: `need ${i}` }] })),
  causalQuestions: ['why did it happen?'],
  questionType: 'causal', groups: { verified: 'gv', eliminated: 'ge', unconfirmed: 'gu' }
});
function researchAll(s, miss = []) {
  for (const d of plain(s.situation.data).filter(x => x.state === 'pending')) {
    s = m.beginSituationResearch(s, d.id);
    s = m.applySituationEvidence(s, d.id, miss.includes(d.id) ? { found: false, reason: 'nothing' } : found('supports', Number(d.id.replace(/\D/g, '')) || 1));
  }
  return s;
}
function judgement(s, stances = {}, verdicts = {}) {
  const pending = s.situation.facets.filter(f => f.verdict === 'pending');
  const ids = new Set(pending.map(f => f.id));
  const fd = s.situation.data.filter(d => ids.has(d.facetId) && d.state === 'found');
  const stance = d => d.propStance ?? stances[d.id] ?? 'supports';
  return {
    data: fd.map(d => ({ id: d.id, propStance: stance(d), reason: `why ${d.id}` })),
    facets: pending.map(f => {
      const verdict = verdicts[f.id] ?? 'supports';
      return { id: f.id, verdict, reason: `because ${f.id}`, citedData: fd.filter(d => d.facetId === f.id && stance(d) === verdict).map(d => d.id), summary: `summary of ${f.id}` };
    })
  };
}
const judged = (s, stances, verdicts) => m.applyFacetVerdicts(s, judgement(s, stances, verdicts));
/** Round 1 retry then round 2 still short, every facet insufficient (decision #60: composed outcome insufficient): the unconfirmed state. */
function unconfirmed() {
  let s = researchAll(m.applySituationPlan(m.newArgumentMap(roles, 'run-u'), plan()), ['f2d1', 'f3d1', 'f4d1']);
  s = judged(s, {}, { f1: 'insufficient', f2: 'insufficient', f3: 'insufficient', f4: 'insufficient' });
  s = m.addRetryNeeds(s, [{ facetId: 'f2', id: 'r2', need: 'other way 2' }]);
  s = researchAll(s, ['r2']);
  return judged(s, {}, {});
}
const types = s => plain(m.nextActions(s).map(a => a.type));

test('#58 machine: data_insufficient after the retry round goes on to analysis with an unconfirmed gate, not stopped', () => {
  const s = unconfirmed();
  assert.equal(s.situation.gate.state, 'unconfirmed');
  assert.equal(s.situation.gate.kind, 'data_insufficient');
  assert.equal(s.situation.gate.round, 2);
  assert.equal(s.run.phase, 'analysis');
  assert.equal(s.run.status, 'running');
  assert.equal(s.run.stopReason, undefined);
  assert.equal(s.conclusion.state, 'pending');
  assert.ok(m.isSituationUnconfirmed(s));
  assert.deepEqual(types(s), ['propose_hypotheses']);
});
test('#58 machine: an empty retry batch and a spent budget also end unconfirmed', () => {
  let s = researchAll(m.applySituationPlan(m.newArgumentMap(roles, 'r'), plan()), ['f2d1', 'f3d1', 'f4d1']);
  s = judged(s, {}, { f1: 'insufficient', f2: 'insufficient', f3: 'insufficient', f4: 'insufficient' });
  const none = m.addRetryNeeds(s, []);
  assert.equal(none.situation.gate.state, 'unconfirmed');
  assert.equal(none.run.phase, 'analysis');
  let b = m.applySituationPlan(m.newArgumentMap(roles, 'r'), plan());
  b.run.researchCalls = 78;
  b = judged(m.applySituationBudgetOut(b), {}, {});
  assert.equal(b.situation.gate.state, 'unconfirmed');
  assert.equal(b.run.phase, 'analysis');
});
test('#58 machine: refuting facets and no supporting one still stop as mismatch; matched still goes on as matched', () => {
  const refuted = judged(researchAll(m.applySituationPlan(m.newArgumentMap(roles, 'r'), plan())), { f1d1: 'refutes', f2d1: 'refutes', f3d1: 'refutes', f4d1: 'refutes' }, { f1: 'refutes', f2: 'refutes', f3: 'refutes', f4: 'refutes' });
  assert.equal(refuted.run.phase, 'stopped_mismatch');
  assert.equal(refuted.run.stopReason, 'mismatch');
  assert.equal(refuted.situation.gate.state, 'unmatched');
  const ok = judged(researchAll(m.applySituationPlan(m.newArgumentMap(roles, 'r'), plan())), {}, {});
  assert.equal(ok.situation.gate.state, 'matched');
  assert.ok(!m.isSituationUnconfirmed(ok));
});
test('#58 machine: refutes in round 2 beats insufficient: still stops', () => {
  let s = researchAll(m.applySituationPlan(m.newArgumentMap(roles, 'r'), plan()), ['f2d1', 'f3d1', 'f4d1']);
  s = judged(s, {}, { f1: 'insufficient', f2: 'insufficient', f3: 'insufficient', f4: 'insufficient' });
  s = m.addRetryNeeds(s, [{ facetId: 'f2', id: 'r2', need: 'other' }]);
  s = researchAll(s);
  s = judged(s, { r2: 'refutes' }, { f2: 'refutes' });
  assert.equal(s.run.phase, 'stopped_mismatch');
});
test('#58 machine: while unconfirmed an empty citation is fine; a citation must still name found data', () => {
  const s = unconfirmed();
  const one = m.applyHypotheses(s, [{ id: 'h1', citedData: [], alternative: true }]);
  assert.equal(one.hypotheses.length, 1);
  assert.deepEqual(plain(one.hypotheses[0].citedData), []);
  assert.throws(() => m.applyHypotheses(s, [{ id: 'h1', citedData: ['ghost'] }]), e => e instanceof m.GateError);
});
test('#58 resume while unconfirmed: a paused unconfirmed run keeps its gate and offers the same next action', () => {
  const s = unconfirmed();
  const paused = plain(s);
  paused.run.status = 'paused';
  assert.deepEqual(types(paused), []);
  paused.run.status = 'running';
  assert.deepEqual(types(paused), ['propose_hypotheses']);
  assert.ok(m.isSituationUnconfirmed(paused));
});

const base = { language: 'en', model: 'claude:haiku', reasoning: 'low' };
const fdatum = (id, over = {}) => ({ id, need: `need of ${id}`, claim: `claim of ${id}`, quote: `quote of ${id} says the rate`, url: `https://stats.example.org/${id}`, stance: 'supports', propStance: 'supports', ...over });
const hreq = over => ({ ...base, proposition: 'Crime got worse', data: [], count: 1, existing: [], causalQuestions: [], ...over });
const hyp = (over = {}) => ({ title: 'Reporting changed', statement: 'People report more now', alternative: true, ...over });
const reply = value => JSON.stringify({ hypotheses: [value] });
test('#58 hypotheses step (#62 shape): a reply with no data parses; the policy and prompt differ only when the request says unconfirmed', () => {
  const step = mod.facetHypothesesStep;
  const parsed = step.parse(reply(hyp()), hreq({ unconfirmed: true }));
  assert.deepEqual(plain(parsed.hypotheses[0]), { title: 'Reporting changed', statement: 'People report more now', alternative: true });
  assert.throws(() => step.parse(reply(hyp({ alternative: false })), hreq({ unconfirmed: true })), e => /alternative/.test(e.message), 'first batch still needs an alternative');
  assert.throws(() => step.parse(reply(hyp({ statement: 'It rose 77 percent' })), hreq({ unconfirmed: true })), e => e.name === 'ArgumentStepError', 'number guard stays');
  step.policy(step.render(hreq({ unconfirmed: true })), hreq({ unconfirmed: true }));
  assert.throws(() => step.policy('x', hreq()), e => e.name === 'ArgumentStepError', 'confirmed with no supporting data is still refused');
  assert.match(step.render(hreq({ unconfirmed: true })), /unconfirmed/i);
  assert.ok(!/unconfirmed/i.test(step.render(hreq({ data: [fdatum('d1')] }))));
});
test('#58 conclusion step: the premise rule text is in the prompt only when the premise is unconfirmed', () => {
  const input = { hypotheses: [1, 2, 3].map(i => ({ id: `h${i}`, round: 1, evidence: [{ id: `n${i}`, claim: `c${i}`, quote: `q${i}`, url: `https://e.org/${i}`, stance: 'supports' }] })) };
  const statements = { h1: 'a', h2: 'b', h3: 'c' };
  const req = { ...base, proposition: 'Crime got worse', input, statements };
  const rule = fs.readFileSync(path.join(__dirname, '..', 'core', 'steps', 'argument-map', 'conclusion-unconfirmed.md'), 'utf8').trim();
  assert.ok(rule.length > 40);
  assert.ok(mod.conclusionStep.render({ ...req, unconfirmed: true }).includes(rule));
  assert.ok(!mod.conclusionStep.render(req).includes(rule));
});

const t = (key, ...values) => translate('zh-TW', key, ...values);
function cardState(phase = 'analysis') {
  const s = unconfirmed();
  s.run.phase = phase;
  return s;
}
test('#58 situation card: chip 現況未確認 with a reason line; no 判斷中, no 已停止', () => {
  const view = card.describeArgumentCard(cardState(), 's', t);
  assert.equal(view.chips[0].text, '現況未確認');
  assert.equal(view.chips[0].text, t('ui.argument_gate_unconfirmed'));
  assert.ok(view.lines.some(l => l.startsWith('原因：')), JSON.stringify(view.lines));
  const text = JSON.stringify(view);
  assert.ok(!text.includes(t('ui.argument_gate_pending')) && !text.includes('已停止'));
  for (const lang of ['zh-CN', 'en']) assert.notEqual(translate(lang, 'ui.argument_gate_unconfirmed'), 'ui.argument_gate_unconfirmed');
});
test('#58 conclusion card: a concluded unconfirmed run has the premise line first', () => {
  const s = cardState('concluded');
  s.run.status = 'finished';
  s.conclusion = { state: 'concluded', basedOn: [], missing: [] };
  s.hypotheses = [1, 2, 3].map(i => ({ id: `h${i}`, citedData: [], round: 1, location: 'verifying', aiVerdict: 'supported', needs: [{ id: `n${i}`, text: 'n', addedRound: 1, state: 'found', stance: 'supports', proof: proof(i) }] }));
  const view = card.describeArgumentCard(s, 'c', t);
  assert.equal(view.lines[0], '現況資料不足，以下結論前提未確認');
  assert.equal(view.lines[0], t('ui.argument_premise_unconfirmed'));
});
test('#58 conclusion note: the premise line is the first line of the note; absent when confirmed', () => {
  const s = cardState('concluded');
  const withLine = N.conclusionDetail(t, s, new Map(), { summary: 'final', points: [] }, '', t('ui.argument_premise_unconfirmed'));
  assert.ok(withLine.startsWith('現況資料不足，以下結論前提未確認'));
  assert.ok(!N.conclusionDetail(t, s, new Map(), { summary: 'final', points: [] }).includes('前提未確認'));
});
test('#58 data contract: the unconfirmed state reads as usable and round-trips; an old map stopped at data_missing is unchanged', () => {
  const ids = state => { const out = new Set(Object.values(state.roles)); (function walk(v) { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') { if (typeof v.id === 'string') out.add(v.id); Object.values(v).forEach(walk); } })(state); return [...out].map(id => ({ id })); };
  const wrap = state => ({ nodes: ids(state), argumentMap: state });
  const doc = wrap(plain(unconfirmed()));
  const doc2 = doc;
  assert.ok(model.GATE_STATES.includes('unconfirmed'));
  const old = wrap(plain(unconfirmed()));
  old.argumentMap.situation.gate = { state: 'unmatched', kind: 'data_insufficient', reason: 'r', citedData: [], round: 2 };
  old.argumentMap.run.phase = 'stopped_mismatch';
  old.argumentMap.run.status = 'finished';
  old.argumentMap.run.stopReason = 'data_missing';
  old.argumentMap.conclusion = { state: 'stopped', basedOn: [], missing: [] };
  assert.equal(model.readArgumentMap(old).kind, 'usable');
  const view = card.describeArgumentCard(old.argumentMap, 's', t);
  assert.equal(view.chips[0].text, '資料不足');
  const concl = card.describeArgumentCard(old.argumentMap, 'c', t);
  assert.equal(concl.state, 'stopped_insufficient');
  assert.equal(model.readArgumentMap(doc2).kind, 'usable');
});
