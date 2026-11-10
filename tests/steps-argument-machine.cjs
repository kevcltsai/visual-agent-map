// Argument map state machine (P1): gates are enforced by pure reducers that throw GateError, never by the AI's output.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('./support.cjs');
const m = S.load('core/argument-map/machine.ts');
const model = S.load('core/argument-map/model.ts');

const roles = { proposition: 'p', situation: 's', conclusion: 'c', verified: 'v', eliminated: 'e' };
const proof = (n = 1) => ({ url: `https://example.org/${n}`, quote: `quote number ${n} from the page`, claim: `claim ${n}`, check: 'page_match', checkedAt: '2026-11-09T00:00:00.000Z' });
const found = (stance = 'supports', n = 1) => ({ found: true, stance, proof: proof(n) });
const plain = value => JSON.parse(JSON.stringify(value));
const gateError = fn => assert.throws(fn, error => error instanceof m.GateError, 'expected a GateError');
/** Fails the test when a reducer changed its input, even though it threw. */
const refuses = (state, fn) => { const before = JSON.stringify(state); gateError(fn); assert.equal(JSON.stringify(state), before, 'a rejected call must not change the state'); };

/** A run whose situation data are all found and whose gate matched. */
function matched(dataCount = 2) {
  let s = m.newArgumentMap(roles, 'run-1');
  s = m.applySituationData(s, Array.from({ length: dataCount }, (_, i) => ({ id: `d${i + 1}`, need: `need ${i + 1}` })));
  for (let i = 1; i <= dataCount; i++) {
    s = m.beginSituationResearch(s, `d${i}`);
    s = m.applySituationEvidence(s, `d${i}`, found(i === 2 ? 'opposes' : 'supports', i));
  }
  return m.applySituationGate(s, { matches: true, reason: 'data fit', citedData: ['d1', 'd2'] });
}
/** One hypothesis `h` with the given needs started (round 1). */
function withHypotheses(ids = ['h1', 'h2', 'h3'], base = matched()) {
  return m.applyHypotheses(base, ids.map(id => ({ id, citedData: ['d1'] })));
}
function researched(s, hid, needId, result) {
  s = m.beginResearch(s, hid, needId);
  return m.applyEvidence(s, hid, needId, result);
}
/** Hypothesis `hid` with `n` found needs and the AI verdict `verdict`. */
function settle(s, hid, n = 2, verdict = 'supported') {
  const round = s.hypotheses.find(h => h.id === hid).round;
  s = m.addNeeds(s, hid, Array.from({ length: n }, (_, i) => ({ id: `${hid}-r${round}-n${i + 1}`, text: `need ${i + 1}` })));
  for (let i = 1; i <= n; i++) s = researched(s, hid, `${hid}-r${round}-n${i}`, found('supports', i));
  return verdict ? m.applyVerdict(s, hid, { verdict, citedNeeds: [`${hid}-r${round}-n1`], reason: 'because' }) : s;
}
/** AI-decided elimination: needs a refuted verdict first. */
const drop = (s, hid) => m.eliminate(settle(s, hid, 1, 'refuted'), hid, 'refuted by the evidence');
const actions = s => plain(m.nextActions(s));
const types = s => actions(s).map(a => a.type);

// ---- situation gate (現況不符 / 現況資料缺) ------------------------------------------------------------------------------
test('situation mismatch: matches:false stops the run, GateError on hypotheses, no research action, resume refused', () => {
  let s = m.newArgumentMap(roles, 'r');
  s = m.applySituationData(s, [{ id: 'd1', need: 'x' }]);
  s = m.beginSituationResearch(s, 'd1');
  s = m.applySituationEvidence(s, 'd1', found('supports'));
  assert.deepEqual(types(s), ['judge_gate']);
  s = m.applySituationGate(s, { matches: false, reason: 'd1 shows the opposite', citedData: ['d1'] });
  assert.equal(s.situation.gate.state, 'unmatched');
  assert.equal(s.situation.gate.kind, 'not_matching');
  assert.equal(s.run.phase, 'stopped_mismatch');
  assert.deepEqual(actions(s), [], 'unmatched has no next action');
  refuses(s, () => m.applyHypotheses(s, [{ id: 'h1', citedData: ['d1'] }]));
  assert.equal(s.hypotheses.length, 0);
  const calls = s.run.researchCalls;
  refuses(s, () => m.applyResume(s));
  assert.equal(s.run.researchCalls, calls);
  assert.equal(model.conclusionView(s), 'stopped_mismatch');
});
test('situation gate before it is matched: hypotheses are refused', () => {
  const s = m.newArgumentMap(roles, 'r');
  refuses(s, () => m.applyHypotheses(s, [{ id: 'h1', citedData: [] }]));
});
test('situation data missing: unfound data go straight to unmatched with no AI call, never to the judge', () => {
  let s = m.newArgumentMap(roles, 'r');
  s = m.applySituationData(s, [{ id: 'd1', need: 'x' }, { id: 'd2', need: 'y' }]);
  s = m.beginSituationResearch(s, 'd1');
  s = m.applySituationEvidence(s, 'd1', found());
  for (let i = 0; i < 2; i++) { s = m.beginSituationResearch(s, 'd2'); s = m.applySituationEvidence(s, 'd2', { found: false, reason: 'nothing found' }); }
  assert.equal(s.situation.data[1].state, 'not_found');
  assert.equal(s.situation.data[1].attempts, 2);
  assert.deepEqual(types(s), ['gate_missing'], 'no judge_gate action when a datum is missing');
  refuses(s, () => m.applySituationGate(s, { matches: true, reason: 'ok', citedData: ['d1'] }));
  s = m.applyGateMissing(s);
  assert.equal(s.situation.gate.kind, 'data_missing');
  assert.equal(s.run.phase, 'stopped_mismatch');
  assert.deepEqual(actions(s), []);
});
test('situation data get at most 2 attempts; the first miss retries', () => {
  let s = m.applySituationData(m.newArgumentMap(roles, 'r'), [{ id: 'd1', need: 'x' }]);
  s = m.beginSituationResearch(s, 'd1');
  s = m.applySituationEvidence(s, 'd1', { found: false, reason: 'miss' });
  assert.equal(s.situation.data[0].state, 'pending');
  assert.deepEqual(types(s), ['research_situation']);
  s = m.beginSituationResearch(s, 'd1');
  refuses(s, () => m.beginSituationResearch(s, 'd1'));
  s = m.applySituationEvidence(s, 'd1', { found: false, reason: 'miss again' });
  refuses(s, () => m.beginSituationResearch(s, 'd1'));
});
test('situation gate: matches:true needs a reason and citations that are found data; otherwise not adopted', () => {
  let base = m.applySituationData(m.newArgumentMap(roles, 'r'), [{ id: 'd1', need: 'x' }, { id: 'd2', need: 'y' }]);
  for (const id of ['d1', 'd2']) { base = m.beginSituationResearch(base, id); base = m.applySituationEvidence(base, id, found(id === 'd2' ? 'opposes' : 'supports')); }
  refuses(base, () => m.applySituationGate(base, { matches: true, reason: 'ok', citedData: [] }));
  refuses(base, () => m.applySituationGate(base, { matches: true, reason: 'ok', citedData: ['zzz'] }));
  refuses(base, () => m.applySituationGate(base, { matches: true, reason: '  ', citedData: ['d1'] }));
  refuses(base, () => m.applySituationGate(base, { matches: 'yes', reason: 'ok', citedData: ['d1'] }));
  const ok = m.applySituationGate(base, { matches: true, reason: 'ok despite d2 opposing', citedData: ['d1', 'd2'] });
  assert.equal(ok.situation.gate.state, 'matched', 'an individual opposing datum does not block a matching gate');
  assert.equal(ok.run.phase, 'analysis');
  assert.equal(ok.situation.data[1].stance, 'opposes');
});
test('situation gate cannot run while data are unresolved', () => {
  let s = m.applySituationData(m.newArgumentMap(roles, 'r'), [{ id: 'd1', need: 'x' }]);
  refuses(s, () => m.applySituationGate(s, { matches: true, reason: 'ok', citedData: ['d1'] }));
  refuses(s, () => m.applyGateMissing(s));
});
test('situation data: at most 6 items, add-only', () => {
  const six = Array.from({ length: 6 }, (_, i) => ({ id: `d${i}`, need: 'x' }));
  const s = m.applySituationData(m.newArgumentMap(roles, 'r'), six);
  refuses(s, () => m.applySituationData(s, [{ id: 'd7', need: 'x' }]));
  refuses(m.newArgumentMap(roles, 'r'), () => m.applySituationData(m.newArgumentMap(roles, 'r'), [...six, { id: 'd7', need: 'x' }]));
  assert.equal(s.situation.data.length, 6);
});

// ---- evidence needs ------------------------------------------------------------------------------------------------------
test('source proof: found needs a verified-source shape; fake proofs are not adopted', () => {
  let s = withHypotheses();
  s = m.addNeeds(s, 'h1', [{ id: 'n1', text: 'x' }]);
  s = m.beginResearch(s, 'h1', 'n1');
  for (const bad of [
    { found: true, stance: 'supports' },
    { found: true, stance: 'supports', proof: { ...proof(), url: 'not a url' } },
    { found: true, stance: 'supports', proof: { ...proof(), url: 'file:///etc/passwd' } },
    { found: true, stance: 'supports', proof: { ...proof(), quote: '' } },
    { found: true, stance: 'supports', proof: { ...proof(), check: 'ai_said_so' } },
    { found: true, stance: 'maybe', proof: proof() }
  ]) refuses(s, () => m.applyEvidence(s, 'h1', 'n1', bad));
  s = m.applyEvidence(s, 'h1', 'n1', found('contradicts'));
  assert.equal(s.hypotheses[0].needs[0].state, 'found');
  assert.equal(s.hypotheses[0].needs[0].stance, 'contradicts');
});
test('needs are add-only: no reducer deletes or edits a listed need, and ids are not reused', () => {
  const exported = Object.keys(m).filter(name => /remove|delete|edit|relax|drop|update/i.test(name));
  assert.deepEqual(exported, [], 'no reducer may remove or rewrite needs');
  let s = withHypotheses();
  s = m.addNeeds(s, 'h1', [{ id: 'n1', text: 'original' }]);
  refuses(s, () => m.addNeeds(s, 'h1', [{ id: 'n1', text: 'relaxed' }]));
  s = m.addNeeds(s, 'h1', [{ id: 'n2', text: 'more' }]);
  assert.deepEqual(plain(s.hypotheses[0].needs.map(n => n.text)), ['original', 'more']);
});
test('need caps: 3 per hypothesis per round, 6 per hypothesis', () => {
  let s = withHypotheses();
  refuses(s, () => m.addNeeds(s, 'h1', [1, 2, 3, 4].map(i => ({ id: `n${i}`, text: 'x' }))));
  s = m.addNeeds(s, 'h1', [1, 2, 3].map(i => ({ id: `n${i}`, text: 'x' })));
  refuses(s, () => m.addNeeds(s, 'h1', [{ id: 'n4', text: 'x' }]));
  assert.equal(s.hypotheses[0].needs.length, 3);
  // round 2 and 3: 3 more, then the 7th need is refused
  for (const id of ['n1', 'n2', 'n3']) s = researched(s, 'h1', id, { found: false, reason: 'none' });
  s = m.startNextRound(s, 'h1', [4, 5, 6].map(i => ({ id: `n${i}`, text: 'x' })));
  assert.equal(s.hypotheses[0].needs.length, 6);
  for (const id of ['n4', 'n5', 'n6']) s = researched(s, 'h1', id, { found: false, reason: 'none' });
  refuses(s, () => m.startNextRound(s, 'h1', [{ id: 'n7', text: 'x' }]));
});
test('research caps: researchCalls is counted at dispatch and capped at 66', () => {
  let s = withHypotheses();
  s = m.addNeeds(s, 'h1', [{ id: 'n1', text: 'x' }, { id: 'n2', text: 'x' }]);
  const before = s.run.researchCalls;
  s = m.beginResearch(s, 'h1', 'n1');
  assert.equal(s.run.researchCalls, before + 1, 'counted before the answer arrives');
  assert.equal(s.hypotheses[0].needs[0].state, 'searching');
  refuses(s, () => m.beginResearch(s, 'h1', 'n1'));
  const capped = plain(s); capped.run.researchCalls = 66;
  refuses(capped, () => m.beginResearch(capped, 'h1', 'n2'));
  assert.ok(!actions(capped).some(a => a.type === 'research_need'), 'no research action at the cap');
});
test('only verifying hypotheses can take research or needs', () => {
  let s = withHypotheses();
  s = drop(s, 'h3');
  refuses(s, () => m.addNeeds(s, 'h3', [{ id: 'x', text: 'x' }]));
});

// ---- hypotheses, caps ------------------------------------------------------------------------------------------------------
test('hypotheses: gate matched, citations must be found situation data, the 7th is refused', () => {
  const base = matched();
  refuses(base, () => m.applyHypotheses(base, [{ id: 'h1', citedData: [] }]));
  refuses(base, () => m.applyHypotheses(base, [{ id: 'h1', citedData: ['nope'] }]));
  refuses(base, () => m.applyHypotheses(base, [1, 2, 3, 4, 5, 6, 7].map(i => ({ id: `h${i}`, citedData: ['d1'] }))));
  let s = withHypotheses(['h1', 'h2', 'h3']);
  s = m.applyHypotheses(s, [4, 5, 6].map(i => ({ id: `h${i}`, citedData: ['d1'] })));
  assert.equal(s.hypotheses.length, 6);
  refuses(s, () => m.applyHypotheses(s, [{ id: 'h7', citedData: ['d1'] }]));
  assert.equal(s.hypotheses.length, 6);
});
test('eliminated hypotheses still count toward the 6 cap', () => {
  let s = withHypotheses(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
  s = drop(s, 'h1');
  refuses(s, () => m.applyHypotheses(s, [{ id: 'h7', citedData: ['d1'] }]));
});
test('hypothesis ids must be unique across the map', () => {
  const s = withHypotheses(['h1']);
  refuses(s, () => m.applyHypotheses(s, [{ id: 'h1', citedData: ['d1'] }]));
  refuses(s, () => m.applyHypotheses(s, [{ id: 'd1', citedData: ['d1'] }]));
});
test('rounds: round 1 to 3 only; a 4th round is refused; round 3 failure is eliminated by the program', () => {
  let s = withHypotheses();
  s = m.addNeeds(s, 'h1', [{ id: 'na', text: 'x' }]);
  s = researched(s, 'h1', 'na', { found: false, reason: 'none' });
  assert.deepEqual(actions(s).filter(a => a.hypothesisId === 'h1').map(a => a.type), ['revise']);
  s = m.startNextRound(s, 'h1', [{ id: 'nb', text: 'x' }]);
  assert.equal(s.hypotheses[0].round, 2);
  s = researched(s, 'h1', 'nb', { found: false, reason: 'none' });
  s = m.startNextRound(s, 'h1', [{ id: 'nc', text: 'x' }]);
  assert.equal(s.hypotheses[0].round, 3);
  s = researched(s, 'h1', 'nc', { found: false, reason: 'none' });
  refuses(s, () => m.startNextRound(s, 'h1', [{ id: 'nd', text: 'x' }]));
  assert.deepEqual(actions(s).filter(a => a.hypothesisId === 'h1').map(a => a.type), ['eliminate_limit']);
  s = m.eliminateAtLimit(s, 'h1');
  assert.equal(s.hypotheses[0].location, 'eliminated');
  assert.ok(s.hypotheses[0].eliminationReason);
  assert.equal(s.hypotheses[0].needs.length, 3, 'searched needs are kept with the eliminated hypothesis');
});
test('early elimination needs a refuted verdict on found evidence', () => {
  let s = settle(withHypotheses(), 'h1', 1, 'supported');
  refuses(s, () => m.eliminate(s, 'h1', 'because'));
  const fresh = withHypotheses();
  refuses(fresh, () => m.eliminate(fresh, 'h2', 'because'));
  refuses(fresh, () => m.eliminate(settle(fresh, 'h2', 1, 'undecided'), 'h2', 'because'));
});
test('program elimination is refused before round 3 and for verified hypotheses', () => {
  let s = settle(withHypotheses(), 'h1');
  refuses(s, () => m.eliminateAtLimit(s, 'h1'));
  const early = withHypotheses();
  refuses(early, () => m.eliminateAtLimit(early, 'h1'));
});
test('next round needs a settled, not-yet-verified hypothesis', () => {
  let s = withHypotheses();
  s = m.addNeeds(s, 'h1', [{ id: 'a', text: 'x' }]);
  refuses(s, () => m.startNextRound(s, 'h1', [{ id: 'b', text: 'x' }]));
  s = researched(s, 'h1', 'a', found());
  s = m.applyVerdict(s, 'h1', { verdict: 'supported', citedNeeds: ['a'], reason: 'r' });
  refuses(s, () => m.startNextRound(s, 'h1', [{ id: 'b', text: 'x' }]));
});

// ---- verdicts ------------------------------------------------------------------------------------------------------------------
test('verdict is not produced and prepareVerdict throws until every need is found', () => {
  let s = withHypotheses();
  s = m.addNeeds(s, 'h1', [{ id: 'a', text: 'x' }, { id: 'b', text: 'y' }]);
  s = researched(s, 'h1', 'a', found());
  assert.ok(!types(s).includes('verdict'), 'unfound need: no verdict action');
  refuses(s, () => m.prepareVerdict(s, 'h1'));
  refuses(s, () => m.applyVerdict(s, 'h1', { verdict: 'supported', citedNeeds: ['a'], reason: 'r' }));
  s = researched(s, 'h1', 'b', { found: false, reason: 'none' });
  refuses(s, () => m.prepareVerdict(s, 'h1'));
});
test('verdictInput exposes only that hypothesis\' found needs (claim, quote, url, stance)', () => {
  let s = withHypotheses();
  s = settle(s, 'h1', 2, null);
  s = m.addNeeds(s, 'h2', [{ id: 'other', text: 'secret other hypothesis need' }]);
  s = researched(s, 'h2', 'other', found('supports', 9));
  const input = m.prepareVerdict(s, 'h1');
  assert.deepEqual(plain(input).evidence.map(e => Object.keys(e).sort()), [['claim', 'id', 'quote', 'stance', 'url'], ['claim', 'id', 'quote', 'stance', 'url']]);
  assert.ok(!JSON.stringify(input).includes('other'), 'no other hypothesis leaks into the input');
  assert.ok(!JSON.stringify(input).includes('example.org/9'));
});
test('verdict citations must be non-empty and inside that hypothesis\' found needs', () => {
  let s = settle(withHypotheses(), 'h1', 2, null);
  s = m.addNeeds(s, 'h2', [{ id: 'other', text: 'x' }]);
  s = researched(s, 'h2', 'other', found());
  refuses(s, () => m.applyVerdict(s, 'h1', { verdict: 'supported', citedNeeds: [], reason: 'r' }));
  refuses(s, () => m.applyVerdict(s, 'h1', { verdict: 'supported', citedNeeds: ['other'], reason: 'r' }));
  refuses(s, () => m.applyVerdict(s, 'h1', { verdict: 'supported', citedNeeds: ['h1-r1-n1'], reason: '' }));
  refuses(s, () => m.applyVerdict(s, 'h1', { verdict: 'certain', citedNeeds: ['h1-r1-n1'], reason: 'r' }));
});
test('isVerified: unfound needs stay unverified even if the user marks the hypothesis supported', () => {
  let s = withHypotheses();
  s = m.addNeeds(s, 'h1', [{ id: 'a', text: 'x' }, { id: 'b', text: 'y' }]);
  s = researched(s, 'h1', 'a', found());
  const edited = plain(s);
  edited.hypotheses[0].userVerdict = 'supported';
  edited.hypotheses[0].aiVerdict = 'supported';
  assert.equal(model.isVerified(edited.hypotheses[0]), false);
  assert.equal(model.displayVerdict(edited.hypotheses[0]), 'verifying');
  assert.equal(model.isVerified({ ...edited.hypotheses[0], needs: [] }), false, 'no needs listed is not verified');
  edited.hypotheses[0].needs[1].state = 'found';
  assert.equal(model.isVerified(edited.hypotheses[0]), true);
  edited.hypotheses[0].userVerdict = 'refuted';
  assert.equal(model.isVerified(edited.hypotheses[0]), false, 'the user value wins over the AI value');
  edited.hypotheses[0].userVerdict = undefined;
  edited.hypotheses[0].location = 'eliminated';
  assert.equal(model.isVerified(edited.hypotheses[0]), false, 'eliminated never counts');
});

// ---- conclusion ----------------------------------------------------------------------------------------------------------------
test('conclusion: fewer than 3 verified never produces a conclude action or conclusion input', () => {
  let s = withHypotheses();
  s = settle(s, 'h1'); s = settle(s, 'h2');
  assert.equal(model.verifiedCount(s), 2);
  assert.ok(!types(s).includes('conclude'));
  refuses(s, () => m.prepareConclusion(s));
  refuses(s, () => m.applyConclusion(s, { basedOn: ['h1', 'h2'] }));
  assert.equal(s.conclusion.state, 'pending');
  assert.equal(model.conclusionView(s), 'in_progress');
  s = settle(s, 'h3');
  assert.deepEqual(types(s), ['conclude']);
});
test('conclusion input and citations are limited to verified hypotheses', () => {
  let s = withHypotheses(['h1', 'h2', 'h3', 'h4']);
  s = settle(s, 'h1'); s = settle(s, 'h2'); s = settle(s, 'h3'); s = settle(s, 'h4', 2, 'refuted');
  const input = m.prepareConclusion(s);
  assert.deepEqual(plain(input.hypotheses.map(h => h.id)), ['h1', 'h2', 'h3']);
  assert.ok(!JSON.stringify(input).includes('h4'));
  refuses(s, () => m.applyConclusion(s, { basedOn: ['h1', 'h2', 'h4'] }));
  refuses(s, () => m.applyConclusion(s, { basedOn: [] }));
  refuses(s, () => m.applyConclusion(s, { basedOn: ['h1', 'h2', 'zzz'] }));
  s = m.eliminate(s, 'h4', 'refuted');
  refuses(s, () => m.applyConclusion(s, { basedOn: ['h4'] }));
  s = m.applyConclusion(s, { basedOn: ['h1', 'h2', 'h3'] });
  assert.equal(s.run.phase, 'concluded');
  assert.equal(s.run.status, 'finished');
  assert.equal(s.conclusion.state, 'concluded');
  assert.equal(model.conclusionView(s), 'concluded');
  assert.deepEqual(actions(s), []);
});
test('after a conclusion, losing support makes the card fall back to in-progress, not re-run', () => {
  let s = withHypotheses();
  for (const id of ['h1', 'h2', 'h3']) s = settle(s, id);
  s = m.applyConclusion(s, { basedOn: ['h1', 'h2', 'h3'] });
  const edited = plain(s);
  edited.hypotheses[0].userVerdict = 'refuted';
  assert.equal(model.conclusionView(edited), 'in_progress');
  assert.deepEqual(actions(edited), []);
});

// ---- limits, stopping, resume ---------------------------------------------------------------------------------------------------
test('limit stop: with 6 hypotheses and fewer than 3 still alive, the run stops and lists what is missing', () => {
  let s = withHypotheses(['h1', 'h2', 'h3']);
  s = m.applyHypotheses(s, [4, 5, 6].map(i => ({ id: `h${i}`, citedData: ['d1'] })));
  for (const id of ['h1', 'h2', 'h3', 'h4']) s = drop(s, id);
  assert.deepEqual(types(s), ['stop_limit']);
  refuses(withHypotheses(), () => m.applyLimitStop(withHypotheses()));
  s = m.applyLimitStop(s);
  assert.equal(s.run.phase, 'stopped_limit');
  assert.equal(s.run.stopReason, 'limit');
  assert.ok(s.conclusion.missing.length > 0);
  assert.equal(s.conclusion.state, 'stopped');
  assert.equal(model.conclusionView(s), 'stopped_limit');
  assert.deepEqual(actions(s), []);
  refuses(s, () => m.applyResume(s));
});
test('propose_hypotheses fills the verifying group up to 3 within the 6 cap', () => {
  let s = matched();
  assert.deepEqual(actions(s), [{ type: 'propose_hypotheses', count: 3 }]);
  s = withHypotheses(['h1', 'h2', 'h3']);
  s = drop(s, 'h1');
  assert.deepEqual(actions(s).filter(a => a.type === 'propose_hypotheses'), [{ type: 'propose_hypotheses', count: 1 }]);
});
test('pause and resume: paused emits no action; resume works only from paused, never from a terminal phase', () => {
  let s = withHypotheses();
  s = m.applyPause(s, 'user');
  assert.equal(s.run.status, 'paused');
  assert.deepEqual(actions(s), []);
  s = m.applyResume(s);
  assert.equal(s.run.status, 'running');
  refuses(s, () => m.applyResume(s));
});
test('searching items return to pending on pause so a resume redoes only unfinished items', () => {
  let s = withHypotheses();
  s = m.addNeeds(s, 'h1', [{ id: 'a', text: 'x' }, { id: 'b', text: 'y' }]);
  s = researched(s, 'h1', 'a', found());
  s = m.beginResearch(s, 'h1', 'b');
  const calls = s.run.researchCalls;
  s = m.applyPause(s, 'interrupted');
  assert.equal(s.hypotheses[0].needs[1].state, 'pending');
  assert.equal(s.hypotheses[0].needs[0].state, 'found');
  assert.equal(s.run.researchCalls, calls, 'the dispatched call stays counted');
  assert.equal(s.run.stopReason, 'interrupted');
});
test('reducers are pure: the input state is never mutated by a successful call either', () => {
  const s = withHypotheses();
  const snapshot = JSON.stringify(s);
  m.addNeeds(s, 'h1', [{ id: 'n1', text: 'x' }]);
  m.eliminate(settle(s, 'h2', 1, 'refuted'), 'h2', 'x');
  assert.equal(JSON.stringify(s), snapshot);
});
test('no reducer works on a stopped_mismatch or concluded run', () => {
  let s = m.applySituationData(m.newArgumentMap(roles, 'r'), [{ id: 'd1', need: 'x' }]);
  s = m.beginSituationResearch(s, 'd1');
  s = m.applySituationEvidence(s, 'd1', found());
  s = m.applySituationGate(s, { matches: false, reason: 'no', citedData: ['d1'] });
  refuses(s, () => m.applyPause(s, 'user'));
  refuses(s, () => m.applySituationData(s, [{ id: 'd2', need: 'x' }]));
  refuses(s, () => m.addNeeds(s, 'x', []));
});

// ---- dead need replaced (ticket 01) -------------------------------------------------------------------------------------------
const miss = { found: false, reason: 'none' };
/** h1 round 1 with needs [a found, b not_found], settled. */
function deadB() {
  let s = withHypotheses();
  s = m.addNeeds(s, 'h1', [{ id: 'a', text: 'x' }, { id: 'b', text: 'y' }]);
  s = researched(s, 'h1', 'a', found());
  return researched(s, 'h1', 'b', miss);
}
test('dead need #1: revise replaces the not_found need; once the replacement is found the verdict is offered in round 2 and the hypothesis verifies', () => {
  let s = deadB();
  assert.deepEqual(actions(s).filter(a => a.hypothesisId === 'h1').map(a => a.type), ['revise']);
  s = m.startNextRound(s, 'h1', [{ id: 'rc', text: 'z' }]);
  assert.equal(s.hypotheses[0].needs.find(n => n.id === 'rc').replaces, 'b');
  assert.equal(s.hypotheses[0].needs.find(n => n.id === 'b').state, 'not_found', 'the dead need record is kept');
  s = researched(s, 'h1', 'rc', found('supports', 3));
  assert.deepEqual(actions(s).filter(a => a.hypothesisId === 'h1').map(a => a.type), ['verdict']);
  s = m.applyVerdict(s, 'h1', { verdict: 'supported', citedNeeds: ['a', 'rc'], reason: 'ok' });
  assert.equal(model.isVerified(s.hypotheses[0]), true);
  assert.equal(s.hypotheses[0].round, 2);
});
test('dead need #2: with no replacement the not_found need still blocks, even when the user marks supported', () => {
  const s = plain(deadB());
  s.hypotheses[0].aiVerdict = 'supported';
  s.hypotheses[0].userVerdict = 'supported';
  assert.equal(model.isVerified(s.hypotheses[0]), false);
  assert.equal(model.displayVerdict(s.hypotheses[0]), 'verifying');
  assert.deepEqual([...model.retiredNeedIds(s.hypotheses[0])], []);
});
test('dead need #3: a pending or not_found replacement does not verify; a round-3 replacement that is also dead goes to eliminate_limit', () => {
  let s = m.startNextRound(deadB(), 'h1', [{ id: 'rc', text: 'z' }]);
  assert.equal(model.isVerified({ ...plain(s.hypotheses[0]), aiVerdict: 'supported', userVerdict: 'supported' }), false, 'pending replacement');
  s = researched(s, 'h1', 'rc', miss);
  assert.equal(model.allNeedsFound(s.hypotheses[0]), false, 'dead replacement');
  s = m.startNextRound(s, 'h1', [{ id: 'rd', text: 'w' }]);
  assert.equal(s.hypotheses[0].needs.find(n => n.id === 'rd').replaces, 'rc', 'chain: only the still-open dead need is taken');
  s = researched(s, 'h1', 'rd', miss);
  assert.deepEqual(actions(s).filter(a => a.hypothesisId === 'h1').map(a => a.type), ['eliminate_limit']);
  s = m.eliminateAtLimit(s, 'h1');
  assert.equal(s.hypotheses[0].location, 'eliminated');
});
test('dead need #4: addNeeds in the same round never sets replaces and the dead need still blocks', () => {
  let s = withHypotheses();
  s = m.addNeeds(s, 'h1', [{ id: 'a', text: 'x' }]);
  s = researched(s, 'h1', 'a', miss);
  s = m.addNeeds(s, 'h1', [{ id: 'b', text: 'y' }]);
  assert.equal(s.hypotheses[0].needs[1].replaces, undefined);
  s = researched(s, 'h1', 'b', found());
  assert.equal(model.allNeedsFound(s.hypotheses[0]), false);
  assert.deepEqual(types(s).filter(t => t === 'verdict'), []);
});
test('dead need: extra items beyond the dead needs carry no replaces; fewer items leave dead needs open', () => {
  let s = withHypotheses();
  s = m.addNeeds(s, 'h1', [{ id: 'a', text: 'x' }, { id: 'b', text: 'y' }, { id: 'c2', text: 'w' }]);
  s = researched(s, 'h1', 'a', miss); s = researched(s, 'h1', 'b', miss); s = researched(s, 'h1', 'c2', found());
  const two = m.startNextRound(s, 'h1', [{ id: 'r1', text: 'p' }]);
  assert.deepEqual(plain(two.hypotheses[0].needs.slice(3).map(n => n.replaces)), ['a']);
  const more = m.startNextRound(s, 'h1', [{ id: 'r1', text: 'p' }, { id: 'r2', text: 'q' }, { id: 'r3', text: 'r' }]);
  assert.deepEqual(plain(more.hypotheses[0].needs.slice(3).map(n => n.replaces ?? null)), ['a', 'b', null]);
  let done = more;
  for (const id of ['r1', 'r2', 'r3']) done = researched(done, 'h1', id, found());
  assert.equal(model.allNeedsFound(done.hypotheses[0]), true);
  const one = researched(two, 'h1', 'r1', found());
  assert.equal(model.allNeedsFound(one.hypotheses[0]), false, 'b is still open and blocks');
});
test('dead need #5: forged replaces at selector level does not retire anything', () => {
  const base = plain(deadB()).hypotheses[0];
  base.needs.push({ id: 'rc', text: 'z', addedRound: 2, state: 'found', replaces: 'b' });
  base.aiVerdict = 'supported';
  assert.equal(model.isVerified(base), true, 'the legitimate shape verifies');
  const forge = edit => { const h = plain(base); edit(h); return h; };
  const cases = {
    'points to a found need': h => { h.needs[2].replaces = 'a'; },
    'points to a pending need': h => { h.needs[1].state = 'pending'; h.needs[2].state = 'found'; },
    'same round': h => { h.needs[2].addedRound = 1; },
    'earlier round': h => { h.needs[1].addedRound = 2; h.needs[2].addedRound = 1; },
    'unknown id': h => { h.needs[2].replaces = 'zzz'; }
  };
  for (const [name, edit] of Object.entries(cases)) assert.equal(model.isVerified(forge(edit)), false, name);
  const other = plain(base); other.needs[2].replaces = 'x-in-another-hypothesis';
  assert.equal(model.isVerified(other), false, 'a need in another hypothesis cannot be retired from here');
  const searching = forge(h => { h.needs[1].state = 'searching'; });
  assert.deepEqual([...model.retiredNeedIds(searching)], []);
});
test('dead need #7: caps hold with replacements (6 needs, round 4, 7th need, no re-research, 66 calls)', () => {
  let s = withHypotheses();
  s = m.addNeeds(s, 'h1', [1, 2, 3].map(i => ({ id: `n${i}`, text: 'x' })));
  for (const id of ['n1', 'n2', 'n3']) s = researched(s, 'h1', id, miss);
  s = m.startNextRound(s, 'h1', [4, 5, 6].map(i => ({ id: `n${i}`, text: 'x' })));
  assert.deepEqual(plain(s.hypotheses[0].needs.slice(3).map(n => n.replaces)), ['n1', 'n2', 'n3']);
  assert.equal(s.hypotheses[0].needs.length, 6);
  refuses(s, () => m.beginResearch(s, 'h1', 'n1'));
  for (const id of ['n4', 'n5', 'n6']) s = researched(s, 'h1', id, miss);
  refuses(s, () => m.startNextRound(s, 'h1', [{ id: 'n7', text: 'x' }]));
  const four = withHypotheses();
  let t = m.addNeeds(four, 'h1', [{ id: 'a', text: 'x' }]);
  t = researched(t, 'h1', 'a', miss); t = m.startNextRound(t, 'h1', [{ id: 'b', text: 'x' }]);
  t = researched(t, 'h1', 'b', miss); t = m.startNextRound(t, 'h1', [{ id: 'c2', text: 'x' }]);
  t = researched(t, 'h1', 'c2', miss);
  refuses(t, () => m.startNextRound(t, 'h1', [{ id: 'd', text: 'x' }]));
  let u = m.startNextRound(deadB(), 'h1', [{ id: 'rc', text: 'z' }]);
  const capped = plain(u); capped.run.researchCalls = 66;
  refuses(capped, () => m.beginResearch(capped, 'h1', 'rc'));
  assert.ok(!actions(capped).some(a => a.type === 'research_need'));
});
test('dead need #8: verdict input excludes the dead need and citing it is refused', () => {
  let s = m.startNextRound(deadB(), 'h1', [{ id: 'rc', text: 'z' }]);
  s = researched(s, 'h1', 'rc', found('supports', 3));
  assert.deepEqual(plain(m.prepareVerdict(s, 'h1').evidence.map(e => e.id)), ['a', 'rc']);
  refuses(s, () => m.applyVerdict(s, 'h1', { verdict: 'supported', citedNeeds: ['b'], reason: 'r' }));
});

// ---- provider failure is not a try (ticket 04) -------------------------------------------------------------------------------
test('releaseSituationResearch: a searching datum returns to pending, the attempt is refunded, nothing else moves', () => {
  let s = m.applySituationData(m.newArgumentMap(roles, 'r'), [{ id: 'd1', need: 'x' }]);
  s = m.beginSituationResearch(s, 'd1');
  s = m.applySituationEvidence(s, 'd1', { found: false, reason: 'not_found' });
  s = m.beginSituationResearch(s, 'd1');
  const before = JSON.stringify(s);
  const next = m.releaseSituationResearch(s, 'd1');
  assert.equal(JSON.stringify(s), before, 'input untouched');
  const datum = next.situation.data[0];
  assert.equal(datum.state, 'pending');
  assert.equal(datum.attempts, 1);
  assert.equal(datum.reason, 'not_found');
  assert.equal(datum.proof, undefined);
  assert.equal(datum.stance, undefined);
  assert.equal(next.run.researchCalls, 2, 'the call was made, researchCalls keeps it');
  assert.equal(next.run.status, 'running');
  assert.deepEqual(types(next), ['research_situation']);
});

test('releaseSituationResearch refuses a pending, found or not_found datum, an unknown id, a terminal run and the analysis phase', () => {
  let s = m.applySituationData(m.newArgumentMap(roles, 'r'), [{ id: 'd1', need: 'x' }, { id: 'd2', need: 'y' }]);
  refuses(s, () => m.releaseSituationResearch(s, 'd1'));
  refuses(s, () => m.releaseSituationResearch(s, 'nope'));
  s = m.beginSituationResearch(s, 'd1');
  s = m.applySituationEvidence(s, 'd1', found());
  refuses(s, () => m.releaseSituationResearch(s, 'd1'));
  s = m.beginSituationResearch(s, 'd2');
  s = m.applySituationEvidence(s, 'd2', { found: false, reason: 'a' });
  s = m.beginSituationResearch(s, 'd2');
  s = m.applySituationEvidence(s, 'd2', { found: false, reason: 'b' });
  assert.equal(s.situation.data[1].state, 'not_found');
  refuses(s, () => m.releaseSituationResearch(s, 'd2'));
  const stopped = m.applyGateMissing(s);
  refuses(stopped, () => m.releaseSituationResearch(stopped, 'd2'));
  const analysis = withHypotheses();
  refuses(analysis, () => m.releaseSituationResearch(analysis, 'd1'));
});

test('releaseNeedResearch: a searching need returns to pending, nothing else moves', () => {
  let s = m.addNeeds(withHypotheses(), 'h1', [{ id: 'n1', text: 'a' }, { id: 'n2', text: 'b' }]);
  s = m.beginResearch(s, 'h1', 'n1');
  const before = JSON.stringify(s);
  const next = m.releaseNeedResearch(s, 'h1', 'n1');
  assert.equal(JSON.stringify(s), before, 'input untouched');
  const need = next.hypotheses.find(h => h.id === 'h1').needs.find(n => n.id === 'n1');
  assert.equal(need.state, 'pending');
  assert.equal(need.proof, undefined);
  assert.equal(need.reason, undefined);
  assert.equal(next.run.researchCalls, s.run.researchCalls);
  assert.equal(next.hypotheses.find(h => h.id === 'h1').round, 1);
});

test('releaseNeedResearch refuses a non-searching need, an eliminated hypothesis and the situation phase', () => {
  let s = m.addNeeds(withHypotheses(), 'h1', [{ id: 'n1', text: 'a' }]);
  refuses(s, () => m.releaseNeedResearch(s, 'h1', 'n1'));
  refuses(s, () => m.releaseNeedResearch(s, 'h1', 'nope'));
  s = researched(s, 'h1', 'n1', found());
  refuses(s, () => m.releaseNeedResearch(s, 'h1', 'n1'));
  const gone = drop(withHypotheses(), 'h1');
  refuses(gone, () => m.releaseNeedResearch(gone, 'h1', 'h1-r1-n1'));
  const situation = m.beginSituationResearch(m.applySituationData(m.newArgumentMap(roles, 'r'), [{ id: 'd1', need: 'x' }]), 'd1');
  refuses(situation, () => m.releaseNeedResearch(situation, 'h1', 'n1'));
});

test('situation research budget exhausted with data still pending ends at the limit (stop_limit); not_found still goes to data_missing', () => {
  let s = m.applySituationData(m.newArgumentMap(roles, 'r'), [{ id: 'd1', need: 'x' }, { id: 'd2', need: 'y' }]);
  s = m.beginSituationResearch(s, 'd2');
  s = m.applySituationEvidence(s, 'd2', found());
  while (s.run.researchCalls < 66) {
    s = m.beginSituationResearch(s, 'd1');
    s = m.releaseSituationResearch(s, 'd1');
  }
  assert.equal(s.situation.data[0].state, 'pending');
  assert.deepEqual(types(s), ['stop_limit']);
  const stopped = m.applyLimitStop(s);
  assert.equal(stopped.run.phase, 'stopped_limit');
  assert.equal(stopped.run.status, 'finished');
  assert.equal(stopped.run.stopReason, 'limit');
  assert.ok(stopped.conclusion.missing.length > 0);
  assert.deepEqual(actions(stopped), []);
  // below the budget a pending datum still gets research, and not_found still ends as data_missing
  const fresh = m.applySituationData(m.newArgumentMap(roles, 'r2'), [{ id: 'd1', need: 'x' }]);
  assert.deepEqual(types(fresh), ['research_situation']);
  refuses(fresh, () => m.applyLimitStop(fresh));
});


// ---- V1 boost P1: facets (面向判定), data_insufficient, one research per need ------------------------------------------------------
const f4 = (counts = [1, 1, 1, 1]) => ({
  assumptions: { id: 'as1', items: [{ label: 'Age band', value: '16-24 in 2024', reason: 'the proposition says young people' }] },
  facets: counts.map((c, i) => ({ id: `f${i + 1}`, title: `Facet ${i + 1}`, needs: Array.from({ length: c }, (_, j) => ({ id: `f${i + 1}d${j + 1}`, need: `need f${i + 1}-${j + 1}` })) })),
  causalQuestions: ['why did it happen?']
});
const planned = (counts, run = 'run-f') => m.applySituationPlan(m.newArgumentMap(roles, run), f4(counts));
const dataOf = (s, facetId) => s.situation.data.filter(d => d.facetId === facetId);
/** Research every pending datum once: `miss` ids are not found, the rest are found (research stance supports). */
function researchAll(s, miss = []) {
  for (const d of plain(s.situation.data).filter(x => x.state === 'pending')) {
    s = m.beginSituationResearch(s, d.id);
    s = m.applySituationEvidence(s, d.id, miss.includes(d.id) ? { found: false, reason: 'nothing' } : found('supports', Number(d.id.replace(/\D/g, '')) || 1));
  }
  return s;
}
/** A judgement for every pending facet: stances by datum id (default supports), verdicts by facet id (default supports); cites the facet's found data of the matching stance. */
function judgement(s, stances = {}, verdicts = {}) {
  const pending = s.situation.facets.filter(f => f.verdict === 'pending');
  const ids = new Set(pending.map(f => f.id));
  const found = s.situation.data.filter(d => ids.has(d.facetId) && d.state === 'found');
  const stance = d => d.propStance ?? stances[d.id] ?? 'supports';
  return {
    data: found.map(d => ({ id: d.id, propStance: stance(d), reason: `why ${d.id}` })),
    facets: pending.map(f => {
      const verdict = verdicts[f.id] ?? 'supports';
      const citedData = found.filter(d => d.facetId === f.id && stance(d) === verdict).map(d => d.id);
      return { id: f.id, verdict, reason: `because ${f.id}`, citedData, summary: `summary of ${f.id}` };
    })
  };
}
const judged = (s, stances, verdicts) => m.applyFacetVerdicts(s, judgement(s, stances, verdicts));

test('facet boost: the unemployment fixture (5 found + 1 not_found) still stops an old map with gate_missing', () => {
  let s = m.newArgumentMap(roles, 'r');
  s = m.applySituationData(s, Array.from({ length: 6 }, (_, i) => ({ id: `d${i + 1}`, need: `need ${i + 1}` })));
  for (let i = 1; i <= 6; i++) for (let k = 0; k < (i === 6 ? 2 : 1); k++) {
    s = m.beginSituationResearch(s, `d${i}`);
    s = m.applySituationEvidence(s, `d${i}`, i === 6 ? { found: false, reason: 'x' } : found('supports', i));
  }
  assert.deepEqual(types(s), ['gate_missing']);
  assert.equal(m.applyGateMissing(s).run.phase, 'stopped_mismatch');
});
test('facet boost: the same data on a facet map do not stop: judge_facets', () => {
  let s = planned([2, 2, 1, 1]);
  s = researchAll(s, ['f4d1']);
  assert.equal(s.situation.data.find(d => d.id === 'f4d1').state, 'not_found');
  assert.deepEqual(types(s), ['judge_facets']);
  refuses(s, () => m.applyGateMissing(s), 'a facet map never stops early on a missing datum');
});
test('facet boost: a facet map researches each need once; a miss is not_found at once and never asked again', () => {
  let s = planned([1, 1, 1]);
  s = m.beginSituationResearch(s, 'f1d1');
  s = m.applySituationEvidence(s, 'f1d1', { found: false, reason: 'nothing' });
  const d = s.situation.data.find(x => x.id === 'f1d1');
  assert.equal(d.state, 'not_found');
  assert.equal(d.attempts, 1);
  assert.ok(!actions(s).some(a => a.dataId === 'f1d1'));
  refuses(s, () => m.beginSituationResearch(s, 'f1d1'));
  assert.equal(s.situation.gate.round, 1);
});
test('facet boost: the plan makes the facet cards, the assumption card id and causal questions; ids join allIds', () => {
  const s = planned([2, 1, 1, 1]);
  assert.equal(s.situation.facets.length, 4);
  assert.deepEqual(plain(s.situation.facets[0]), { id: 'f1', title: 'Facet 1', verdict: 'pending', reason: '', citedData: [], summary: '' });
  assert.equal(s.situation.assumptions.id, 'as1');
  assert.deepEqual(plain(s.situation.causalQuestions), ['why did it happen?']);
  assert.equal(s.situation.data.length, 5);
  assert.ok(s.situation.data.every(d => d.facetId && d.state === 'pending'));
  refuses(s, () => m.applySituationPlan(s, f4()));
  const clash = f4(); clash.facets[0].id = 'p';
  gateError(() => m.applySituationPlan(m.newArgumentMap(roles, 'r'), clash));
  const clash2 = f4(); clash2.assumptions.id = 'f1';
  gateError(() => m.applySituationPlan(m.newArgumentMap(roles, 'r'), clash2));
  const none = f4(); none.assumptions = { id: 'as1', items: [] };
  assert.equal(m.applySituationPlan(m.newArgumentMap(roles, 'r'), none).situation.assumptions, undefined);
});
test('facet boost: plan limits: 6 facets, 2 facets, 0 or 4 needs in a facet, 16 needs are refused', () => {
  const blankState = () => m.newArgumentMap(roles, 'r');
  gateError(() => m.applySituationPlan(blankState(), f4([1, 1, 1, 1, 1, 1])));
  gateError(() => m.applySituationPlan(blankState(), f4([1, 1])));
  gateError(() => m.applySituationPlan(blankState(), f4([0, 1, 1])));
  gateError(() => m.applySituationPlan(blankState(), f4([4, 1, 1])));
  gateError(() => m.applySituationPlan(blankState(), f4([3, 3, 3, 3, 4])));
  assert.equal(m.applySituationPlan(blankState(), f4([3, 3, 3, 3, 3])).situation.data.length, 15);
  const blankTitle = f4(); blankTitle.facets[0].title = '  ';
  gateError(() => m.applySituationPlan(blankState(), blankTitle));
  const old = m.applySituationData(blankState(), [{ id: 'd1', need: 'x' }]);
  gateError(() => m.applySituationPlan(old, f4()));
  gateError(() => m.applySituationData(planned(), [{ id: 'zz', need: 'x' }]));
});
test('facet boost: any refuting facet: unmatched / not_matching, hypotheses refused', () => {
  let s = researchAll(planned([1, 1, 1, 1]));
  s = judged(s, { f2d1: 'refutes' }, { f2: 'refutes' });
  assert.equal(s.situation.gate.state, 'unmatched');
  assert.equal(s.situation.gate.kind, 'not_matching');
  assert.deepEqual(plain(s.situation.gate.citedData), ['f2d1']);
  assert.equal(s.situation.gate.round, 1);
  assert.equal(s.run.phase, 'stopped_mismatch');
  assert.equal(s.run.stopReason, 'mismatch');
  assert.deepEqual(actions(s), []);
  refuses(s, () => m.applyHypotheses(s, [{ id: 'h1', citedData: ['f1d1'] }]));
});
test('facet boost: 2 of 4 supports and no refutes goes to analysis, and hypotheses are accepted', () => {
  let s = researchAll(planned([1, 1, 1, 1]));
  s = judged(s, {}, { f3: 'insufficient', f4: 'insufficient' });
  assert.equal(s.situation.gate.state, 'matched');
  assert.equal(s.run.phase, 'analysis');
  assert.deepEqual(plain(s.situation.facets.map(f => f.verdict)), ['supports', 'supports', 'insufficient', 'insufficient']);
  assert.ok(s.situation.gate.citedData.length >= 1);
  assert.equal(m.applyHypotheses(s, [{ id: 'h1', citedData: ['f1d1'], basis: 'from f1d1 we observe the rate, so we guess a cause' }]).hypotheses.length, 1);
});
test('facet boost: 1 of 4 supports: retry round, then still short: data_insufficient (stopReason data_missing)', () => {
  let s = researchAll(planned([1, 1, 1, 1]), ['f2d1', 'f3d1']);
  s = judged(s, {}, { f1: 'supports', f2: 'supports', f3: 'supports', f4: 'insufficient' });
  assert.deepEqual(plain(s.situation.facets.map(f => f.verdict)), ['supports', 'insufficient', 'insufficient', 'insufficient'], 'facets without found data are forced insufficient');
  assert.equal(s.run.phase, 'situation');
  assert.deepEqual(types(s), ['add_retry_needs']);
  s = m.addRetryNeeds(s, [{ facetId: 'f2', id: 'r2', need: 'other way 2' }, { facetId: 'f3', id: 'r3', need: 'other way 3' }]);
  assert.equal(s.situation.gate.round, 2);
  assert.deepEqual(plain(s.situation.facets.map(f => f.verdict)), ['supports', 'pending', 'pending', 'insufficient']);
  assert.deepEqual(types(s), ['research_situation', 'research_situation']);
  s = researchAll(s, ['r2', 'r3']);
  assert.deepEqual(types(s), ['judge_facets']);
  s = judged(s, {}, {});
  assert.equal(s.situation.gate.state, 'unmatched');
  assert.equal(s.situation.gate.kind, 'data_insufficient');
  assert.equal(s.situation.gate.round, 2);
  assert.equal(s.run.phase, 'stopped_mismatch');
  assert.equal(s.run.stopReason, 'data_missing');
  assert.deepEqual(plain(s.situation.facets.map(f => f.verdict)), ['supports', 'insufficient', 'insufficient', 'insufficient']);
  assert.deepEqual(actions(s), []);
});
test('facet boost: round 2 only re-judges the facets that were insufficient; a supported one keeps its verdict', () => {
  let s = researchAll(planned([1, 1, 1, 1]), ['f3d1', 'f4d1']);
  s = judged(s, {}, { f1: 'supports', f2: 'insufficient', f3: 'supports', f4: 'supports' });
  s = m.addRetryNeeds(s, [{ facetId: 'f3', id: 'r3', need: 'other' }]);
  assert.deepEqual(plain(s.situation.facets.map(f => f.verdict)), ['supports', 'insufficient', 'pending', 'insufficient']);
  s = researchAll(s);
  const j = judgement(s);
  assert.deepEqual(plain(j.facets.map(f => f.id)), ['f3']);
  const withExtra = { ...j, facets: [...j.facets, { id: 'f1', verdict: 'refutes', reason: 'x', citedData: ['f1d1'] }] };
  refuses(s, () => m.applyFacetVerdicts(s, withExtra));
  s = m.applyFacetVerdicts(s, j);
  assert.equal(s.situation.gate.state, 'matched', '2 supports of 4 once f3 is supported');
});
test('facet boost: a facet with no found data judged supports is stored insufficient', () => {
  let s = researchAll(planned([1, 1, 1, 1]), ['f4d1']);
  const j = judgement(s);
  j.facets.find(f => f.id === 'f4').verdict = 'supports';
  s = m.applyFacetVerdicts(s, j);
  assert.equal(s.situation.facets.find(f => f.id === 'f4').verdict, 'insufficient');
  assert.deepEqual(plain(s.situation.facets.find(f => f.id === 'f4').citedData), []);
});
test('facet boost: citations: other facet, irrelevant data, other stance, unfound data, no citation are all GateErrors', () => {
  const s = researchAll(planned([2, 1, 1, 1]), ['f1d2']);
  const mutate = fn => { const j = judgement(s, { f2d1: 'irrelevant' }, { f2: 'insufficient' }); fn(j); return j; };
  const f1 = j => j.facets.find(f => f.id === 'f1');
  assert.equal(m.applyFacetVerdicts(s, mutate(() => {})).situation.facets.length, 4, 'the unmutated judgement is accepted');
  refuses(s, () => m.applyFacetVerdicts(s, mutate(j => { f1(j).citedData = ['f2d1']; })));
  refuses(s, () => m.applyFacetVerdicts(s, mutate(j => { f1(j).citedData = ['f1d2']; })));
  refuses(s, () => m.applyFacetVerdicts(s, mutate(j => { f1(j).citedData = []; })));
  refuses(s, () => m.applyFacetVerdicts(s, mutate(j => { j.facets.find(f => f.id === 'f3').citedData = ['ghost']; })));
  const s2 = researchAll(planned([2, 1, 1, 1]));
  const irrelevant = judgement(s2, { f1d1: 'irrelevant' });
  assert.equal(m.applyFacetVerdicts(s2, irrelevant).situation.facets[0].verdict, 'supports', 'citing the other, relevant datum is fine');
  irrelevant.facets.find(f => f.id === 'f1').citedData = ['f1d1', 'f1d2'];
  refuses(s2, () => m.applyFacetVerdicts(s2, irrelevant));
  const wrongStance = judgement(s, { f1d1: 'refutes' });
  refuses(s, () => m.applyFacetVerdicts(s, wrongStance));
  const refuteNoCite = judgement(s, {}, { f1: 'refutes' });
  refuses(s, () => m.applyFacetVerdicts(s, refuteNoCite));
  const missingData = judgement(s); missingData.data.pop();
  refuses(s, () => m.applyFacetVerdicts(s, missingData));
  const unknownStance = judgement(s); unknownStance.data[0].propStance = 'maybe';
  refuses(s, () => m.applyFacetVerdicts(s, unknownStance));
  const noReason = judgement(s); noReason.data[0].reason = ' ';
  refuses(s, () => m.applyFacetVerdicts(s, noReason));
  const pendingVerdict = judgement(s); pendingVerdict.facets[0].verdict = 'pending';
  refuses(s, () => m.applyFacetVerdicts(s, pendingVerdict));
});
test('facet boost: uncertain research maps to the single stance constant and the judgement cannot override it', () => {
  assert.equal(model.UNCERTAIN_RESEARCH_STANCE, 'irrelevant');
  assert.equal(model.propStanceForUncertainResearch(), 'irrelevant');
  let s = planned([1, 1, 1, 1]);
  s = m.beginSituationResearch(s, 'f1d1');
  s = m.applySituationEvidence(s, 'f1d1', { found: true, stance: 'uncertain', proof: proof(1) });
  const d = s.situation.data.find(x => x.id === 'f1d1');
  assert.equal(d.state, 'found');
  assert.equal(d.propStance, 'irrelevant');
  s = researchAll(s);
  const j = judgement(s);
  j.data.find(x => x.id === 'f1d1').propStance = 'supports';
  refuses(s, () => m.applyFacetVerdicts(s, j));
  const keep = judgement(s);
  assert.equal(keep.data.find(x => x.id === 'f1d1').propStance, 'irrelevant');
  s = m.applyFacetVerdicts(s, keep);
  assert.equal(s.situation.data.find(x => x.id === 'f1d1').propStance, 'irrelevant');
  assert.equal(s.situation.facets[0].verdict, 'insufficient', 'only irrelevant data: no basis');
  // old maps are untouched: an uncertain stance is still refused there
  let o = m.applySituationData(m.newArgumentMap(roles, 'r'), [{ id: 'd1', need: 'x' }]);
  o = m.beginSituationResearch(o, 'd1');
  refuses(o, () => m.applySituationEvidence(o, 'd1', { found: true, stance: 'uncertain', proof: proof(1) }));
});
test('facet boost: retry needs: only insufficient facets, once, 3 per facet, 9 in all; before the judgement or after round 2 refused', () => {
  const fresh = () => judged(researchAll(planned([1, 1, 1, 1, 1]), ['f1d1', 'f2d1', 'f3d1', 'f4d1']), {}, { f5: 'supports' });
  const base = fresh();
  assert.equal(base.situation.gate.round, 1);
  assert.deepEqual(types(base), ['add_retry_needs']);
  const need = (facetId, id) => ({ facetId, id, need: `n ${id}` });
  // not yet judged
  const early = researchAll(planned([1, 1, 1, 1]));
  refuses(early, () => m.addRetryNeeds(early, [need('f1', 'x1')]));
  // a supported facet, an unknown facet, a blank need, a duplicate id
  refuses(base, () => m.addRetryNeeds(base, [need('f5', 'x1')]));
  refuses(base, () => m.addRetryNeeds(base, [need('zz', 'x1')]));
  refuses(base, () => m.addRetryNeeds(base, [{ facetId: 'f1', id: 'x1', need: ' ' }]));
  refuses(base, () => m.addRetryNeeds(base, [need('f1', 'x1'), need('f2', 'x1')]));
  refuses(base, () => m.addRetryNeeds(base, [need('f1', 'f2')]));
  // 4 for one facet; 10 in all
  refuses(base, () => m.addRetryNeeds(base, [1, 2, 3, 4].map(i => need('f1', `a${i}`))));
  const ten = ['f1', 'f2', 'f3', 'f4'].flatMap((f, i) => [1, 2, 3].map(k => need(f, `b${i}${k}`))).slice(0, 10);
  assert.equal(ten.length, 10);
  refuses(base, () => m.addRetryNeeds(base, ten));
  // nine is fine
  const nine = ten.slice(0, 9);
  const after = m.addRetryNeeds(base, nine);
  assert.equal(after.situation.data.length, 14);
  // a second batch is refused (round is 2 now)
  refuses(after, () => m.addRetryNeeds(after, [need('f1', 'again')]));
  // an empty batch ends the run as data_insufficient (round 1)
  const none = m.addRetryNeeds(base, []);
  assert.equal(none.situation.gate.kind, 'data_insufficient');
  assert.equal(none.run.stopReason, 'data_missing');
  assert.equal(none.situation.gate.round, 1);
  // a refuting facet never reaches a retry
  const refuted = judged(researchAll(planned([1, 1, 1, 1])), { f1d1: 'refutes' }, { f1: 'refutes' });
  refuses(refuted, () => m.addRetryNeeds(refuted, [need('f2', 'x')]));
});
test('facet boost: budget spent: only situation_budget, no stop_limit; the unresearched needs become not_found(budget) and the run ends data_insufficient', () => {
  let s = planned([1, 1, 1, 1]);
  s.run.researchCalls = 78;
  assert.deepEqual(types(s), ['situation_budget']);
  refuses(planned([1, 1, 1, 1]), () => m.applySituationBudgetOut(planned([1, 1, 1, 1])));
  refuses(s, () => m.applyLimitStop(s));
  s = m.applySituationBudgetOut(s);
  assert.ok(s.situation.data.every(d => d.state === 'not_found' && d.reason === 'budget'));
  assert.deepEqual(types(s), ['judge_facets']);
  s = judged(s, {}, {});
  assert.equal(s.situation.gate.kind, 'data_insufficient');
  assert.equal(s.run.stopReason, 'data_missing');
  assert.equal(s.run.phase, 'stopped_mismatch');
  assert.ok(!s.situation.data.some(d => d.state === 'pending'));
});
test('facet boost: the research cap is min(24 - used, whole-map remaining); a facet map never emits stop_limit', () => {
  const s = planned([3, 3, 3, 3, 3]);
  assert.equal(actions(s).length, 15);
  s.run.researchCalls = 60;
  assert.equal(actions(s).length, 6, 'whole-map remaining is smaller');
  const t = planned([3, 3, 3, 3, 3]);
  t.situation.data.forEach((d, i) => { if (i < 10) { d.state = 'not_found'; d.attempts = 1; } });
  t.run.researchCalls = 10;
  const used = t.situation.data.filter(d => d.attempts > 0).length;
  assert.equal(used, 10);
  assert.equal(actions(t).length, 5);
  assert.ok(!types(s).includes('stop_limit') && !types(t).includes('stop_limit'));
});
test('facet boost: pausing a facet map puts searching data back to pending and refunds the attempt, so it researches again after resume', () => {
  let s = planned([1, 1, 1]);
  s = m.beginSituationResearch(s, 'f1d1');
  s = m.applyPause(s, 'user');
  const d = s.situation.data.find(x => x.id === 'f1d1');
  assert.equal(d.state, 'pending');
  assert.equal(d.attempts, 0);
  s = m.applyResume(s);
  assert.ok(actions(s).some(a => a.dataId === 'f1d1'));
  s = m.beginSituationResearch(s, 'f1d1');
  assert.equal(s.situation.data.find(x => x.id === 'f1d1').state, 'searching');
});
test('facet boost: old maps keep every old action and cap (no facets key, gate_missing / judge_gate / stop_limit unchanged)', () => {
  let s = m.newArgumentMap(roles, 'r');
  s = m.applySituationData(s, [{ id: 'd1', need: 'x' }]);
  assert.equal(s.situation.facets, undefined);
  s.run.researchCalls = 66;
  assert.deepEqual(types(s), ['stop_limit']);
});

// ---- V1 boost P3: the facet summary (decision B5) ----
test('facet summary: the judgement stores each facet summary; a blank or missing summary is refused, also for a facet with no data', () => {
  const s0 = researchAll(planned([1, 1, 1, 1]));
  const done = judged(s0);
  for (const f of done.situation.facets) assert.equal(f.summary, `summary of ${f.id}`);
  for (const blank of ['', '  ', undefined]) {
    const j = judgement(s0);
    j.facets[0].summary = blank;
    assert.throws(() => m.applyFacetVerdicts(s0, j), e => e.name === 'GateError' && /summary/.test(e.message));
  }
  const nodata = researchAll(planned([1, 1, 1, 1]), ['f1d1']);
  const empty = nodata.situation.facets.find(f => dataOf(nodata, f.id).every(d => d.state !== 'found'));
  assert.ok(empty, 'one facet has no found data');
  const j = judgement(nodata);
  j.facets.find(v => v.id === empty.id).summary = '';
  assert.throws(() => m.applyFacetVerdicts(nodata, j), e => e.name === 'GateError' && /summary/.test(e.message));
  assert.equal(judged(nodata).situation.facets.find(f => f.id === empty.id).summary, `summary of ${empty.id}`);
});

// ---- V1 boost P4 (decision #50): basis, alternative and the supports-only citation on a facet map ----
const matchedFacets = () => judged(researchAll(planned([1, 1, 1, 1])), { f3d1: 'irrelevant', f4d1: 'refutes' }, { f3: 'insufficient', f4: 'insufficient' });
test('facet hypotheses: basis and alternative are stored; a blank basis is refused; only data that support the proposition can be cited', () => {
  const s = matchedFacets();
  assert.equal(s.situation.gate.state, 'matched');
  const h = m.applyHypotheses(s, [{ id: 'h1', citedData: ['f1d1'], basis: 'from f1d1 we observe a rise, so we guess hiring slowed', alternative: true }]).hypotheses[0];
  assert.equal(h.basis, 'from f1d1 we observe a rise, so we guess hiring slowed');
  assert.equal(h.alternative, true);
  for (const basis of ['', '  ', undefined]) refuses(s, () => m.applyHypotheses(s, [{ id: 'h1', citedData: ['f1d1'], basis }]));
  refuses(s, () => m.applyHypotheses(s, [{ id: 'h1', citedData: ['f3d1'], basis: 'b' }]));
  refuses(s, () => m.applyHypotheses(s, [{ id: 'h1', citedData: ['f4d1'], basis: 'b' }]));
  refuses(s, () => m.applyHypotheses(s, [{ id: 'h1', citedData: ['f1d1', 'f4d1'], basis: 'b' }]));
});
test('facet hypotheses: an old map (no facets) accepts the old item shape and stores no basis or alternative', () => {
  const h = withHypotheses(["h1"]).hypotheses[0];
  assert.equal('basis' in h, false);
  assert.equal('alternative' in h, false);
});
