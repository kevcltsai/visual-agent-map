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
