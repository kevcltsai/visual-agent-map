// Decision #59 (machine level): a partial conclusion at the research limit, open hypotheses finish before replacements, the stricter supported gate, limit-cut hypotheses.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('./support.cjs');
const m = S.load('core/argument-map/machine.ts');
const model = S.load('core/argument-map/model.ts');

const roles = { proposition: 'p', situation: 's', conclusion: 'c', verified: 'v', eliminated: 'e' };
const proof = n => ({ url: `https://example.org/${n}`, quote: `quote number ${n} from the page`, claim: `claim ${n}`, check: 'page_match', checkedAt: '2026-11-09T00:00:00.000Z' });
const plain = value => JSON.parse(JSON.stringify(value));
const types = s => plain(m.nextActions(s)).map(a => a.type);
const gateError = fn => assert.throws(fn, error => error instanceof m.GateError, 'expected a GateError');

function matched() {
  let s = m.newArgumentMap(roles, 'run-1');
  s = m.applySituationData(s, [{ id: 'd1', need: 'a' }, { id: 'd2', need: 'b' }]);
  for (const id of ['d1', 'd2']) { s = m.beginSituationResearch(s, id); s = m.applySituationEvidence(s, id, { found: true, stance: id === 'd2' ? 'opposes' : 'supports', proof: proof(id === 'd1' ? 1 : 2) }); }
  return m.applySituationGate(s, { matches: true, reason: 'fit', citedData: ['d1', 'd2'] });
}
const withHyp = (ids, base = matched()) => m.applyHypotheses(base, ids.map(id => ({ id, citedData: ['d1'] })));
/** Hypothesis `hid` with one found need per stance in `stances`, then the AI verdict. */
function settle(s, hid, stances = ['supports', 'supports'], verdict = 'supported') {
  const round = s.hypotheses.find(h => h.id === hid).round;
  const first = stances.slice(0, 3);
  s = m.addNeeds(s, hid, first.map((_, i) => ({ id: `${hid}-r${round}-n${i + 1}`, text: `need ${i + 1}` })));
  first.forEach((stance, i) => { const id = `${hid}-r${round}-n${i + 1}`; s = m.beginResearch(s, hid, id); s = m.applyEvidence(s, hid, id, { found: true, stance, proof: proof(i + 1) }); });
  if (stances.length > 3) {
    // a round holds 3 needs: further found needs are copied in as data, then the verdict is applied to the whole set
    s = plain(s);
    const h = s.hypotheses.find(x => x.id === hid);
    stances.slice(3).forEach((stance, i) => h.needs.push({ ...plain(h.needs[0]), id: `${hid}-r${round}-n${i + 4}`, stance }));
  }
  return m.applyVerdict(s, hid, { verdict, citedNeeds: [`${hid}-r${round}-n1`], reason: 'because' });
}
const six = () => withHyp(['h1', 'h2', 'h3']);
const sixFull = () => m.applyHypotheses(six(), [4, 5, 6].map(i => ({ id: `h${i}`, citedData: ['d1'] })));
const drop = (s, hid) => m.eliminate(settle(s, hid, ['contradicts'], 'refuted'), hid, 'refuted by the evidence');
/** n verified, the rest eliminated, 6 hypotheses on the map: the research limit. */
function limitWith(n) {
  let s = sixFull();
  for (let i = 1; i <= 6; i++) s = i <= n ? settle(s, `h${i}`) : drop(s, `h${i}`);
  return s;
}

test('#59 limit with 1 or 2 verified: the next action is conclude, prepare and apply mark the conclusion partial', () => {
  for (const n of [1, 2]) {
    let s = limitWith(n);
    assert.deepEqual(types(s), ['conclude'], `${n} verified`);
    const input = m.prepareConclusion(s);
    assert.equal(input.hypotheses.length, n);
    s = m.applyConclusion(s, { basedOn: input.hypotheses.map(h => h.id) });
    assert.equal(s.run.phase, 'concluded');
    assert.equal(s.conclusion.partial, true);
    assert.equal(model.conclusionView(s), 'concluded');
    assert.equal(model.isPartialConclusion(s), true);
  }
});
test('#59 a full conclusion is not partial', () => {
  let s = sixFull();
  for (const id of ['h1', 'h2', 'h3']) s = settle(s, id);
  s = m.applyConclusion(s, { basedOn: ['h1', 'h2', 'h3'] });
  assert.equal(s.conclusion.partial, undefined);
  assert.equal(model.isPartialConclusion(s), false);
});
test('#59 2 verified but not at the limit: conclusion is refused; 0 verified at the limit still stops', () => {
  let s = withHyp(['h1', 'h2', 'h3']);
  s = settle(s, 'h1'); s = settle(s, 'h2');
  assert.ok(!types(s).includes('conclude'));
  const before = JSON.stringify(s);
  gateError(() => m.prepareConclusion(s));
  gateError(() => m.applyConclusion(s, { basedOn: ['h1', 'h2'] }));
  assert.equal(JSON.stringify(s), before);
  const none = limitWith(0);
  assert.deepEqual(types(none), ['stop_limit']);
  gateError(() => m.prepareConclusion(none));
});
test('#59 at the limit a hypothesis still being worked on finishes before the partial conclusion', () => {
  let s = sixFull();
  s = settle(s, 'h1');
  for (const id of ['h2', 'h3', 'h4', 'h5']) s = drop(s, id);
  // h6 is still open with no needs: its own step comes first, no conclude yet
  const t = types(s);
  assert.ok(t.includes('add_needs') && !t.includes('conclude') && !t.includes('stop_limit'), t.join());
});
test('#59 no new hypothesis is proposed while one is still open; replacements come once none is open', () => {
  let s = withHyp(['h1', 'h2', 'h3']);
  s = drop(s, 'h3');
  assert.ok(!types(s).includes('propose_hypotheses'), types(s).join());
  s = settle(s, 'h1'); s = settle(s, 'h2');
  const a = plain(m.nextActions(s));
  assert.deepEqual(a, [{ type: 'propose_hypotheses', count: 1 }]);
});
test('#59 supported needs clear support: 1/1/4 undecided, 4/0/0 supported, 3/1/0 supported, 2/1/0 undecided, 1 support + 5 uncertain undecided', () => {
  const run = stances => { let s = withHyp(['h1', 'h2', 'h3']); s = settle(s, 'h1', stances); return s.hypotheses[0]; };
  const x = (n, st) => Array(n).fill(st);
  const cases = [
    [[...x(1, 'supports'), ...x(1, 'contradicts'), ...x(4, 'uncertain')], 'undecided', false],
    [x(4, 'supports'), 'supported', true],
    [[...x(3, 'supports'), ...x(1, 'contradicts')], 'supported', true],
    [[...x(2, 'supports'), ...x(1, 'contradicts')], 'undecided', false],
    [[...x(1, 'supports'), ...x(5, 'uncertain')], 'undecided', false]
  ];
  for (const [stances, verdict, verified] of cases) {
    const h = run(stances);
    assert.equal(h.aiVerdict, verdict, stances.join());
    assert.equal(model.isVerified(h), verified, stances.join());
  }
});
test('#59 isLimitCut: a limit-eliminated hypothesis with no refuting verdict is cut, one with a refuted verdict is not; other reasons are not', () => {
  let s = withHyp(['h1', 'h2', 'h3']);
  s = m.addNeeds(s, 'h1', [{ id: 'na', text: 'x' }]);
  s = m.beginResearch(s, 'h1', 'na'); s = m.applyEvidence(s, 'h1', 'na', { found: false, reason: 'none' });
  for (const [id, n] of [['nb', 2], ['nc', 3]]) { s = m.startNextRound(s, 'h1', [{ id, text: 'x' }]); s = m.beginResearch(s, 'h1', id); s = m.applyEvidence(s, 'h1', id, { found: false, reason: 'none' }); }
  s = m.eliminateAtLimit(s, 'h1');
  assert.equal(model.isLimitCut(s.hypotheses[0]), true);
  const refuted = plain(drop(withHyp(['h1', 'h2', 'h3']), 'h1').hypotheses[0]);
  refuted.eliminationReason = 'round_limit';
  assert.equal(model.isLimitCut(refuted), false, 'refuted by its evidence');
  refuted.eliminationReason = 'refuted by the evidence';
  assert.equal(model.isLimitCut(refuted), false);
});
test('#59 the stopped summary stores ids of what is open, never "id: state" text', () => {
  const s = m.applyLimitStop(limitWith(0));
  assert.ok(s.conclusion.missing.every(x => /^h\d$/.test(x)), s.conclusion.missing.join());
  assert.ok(!s.conclusion.missing.some(x => /verified|eliminated|:/.test(x)));
});
