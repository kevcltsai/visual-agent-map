// Argument map state machine v2 (V2a): premises, hypotheses, needs, research, evidence assessment, test status. Gates are pure reducers
// that throw GateError; nothing here asks an AI. The v1 machine (tests/steps-argument-machine.cjs) is untouched and still serves the v1 runner.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('./support.cjs');
const m = S.load('core/argument-map/machine-v2.ts');
const model = S.load('core/argument-map/model.ts');

const plain = value => JSON.parse(JSON.stringify(value));
const eq = (actual, expected, message) => assert.deepEqual(plain(actual), plain(expected), message);
const gateError = fn => assert.throws(fn, error => error instanceof m.GateError, 'expected a GateError');
/** Fails when a reducer changed its input, even though it threw. */
const refuses = (state, fn) => { const before = JSON.stringify(state); gateError(fn); assert.equal(JSON.stringify(state), before, 'a rejected call must not change the state'); };
const proof = (n = 1, check = 'page_match') => ({ url: `https://example.org/${n}`, quote: `quote number ${n} from the page`, claim: `claim ${n}`, check, checkedAt: '2026-11-10T00:00:00.000Z' });
const found = (n = 1, check = 'page_match') => ({ found: true, stance: 'supports', proof: proof(n, check) });
const miss = { found: false, reason: 'nothing found' };
const assessment = (over = {}) => ({ relevant: true, stance: 'supports', scopeFit: true, sourceType: 'official statistics', underlyingSource: 'BLS', alsoRelevantTo: [], ...over });

const roles = { proposition: 'n-prop', premises: 'n-pre', conclusion: 'n-con' };
const framing = (over = {}) => ({
  original: 'Is AI the main reason for youth unemployment?', restatement: 'Restated', presuppositions: ['youth unemployment rose'], loadedTerms: [], vagueTerms: ['main'], outOfScope: [],
  candidates: [{ id: 'q1', question: 'Q1', answerShape: 'a ranking', diff: '', kind: 'interpretation', unanswered: false }, { id: 'q2', question: 'Q2', answerShape: 'yes/no', diff: 'narrower', kind: 'related', unanswered: false }],
  chosen: 'q1', settings: [], attempts: 1, lockedAt: '2026-11-10T00:00:00.000Z', ...over
});
const claimDrafts = () => [
  { id: 'P1', text: 'Youth unemployment rose', type: 'fact', role: 'premise', dependsOn: [], definitions: [], data: [{ id: 'p1d1', need: 'rate series' }, { id: 'p1d2', need: 'age split' }] },
  { id: 'P2', text: 'AI tools are in use', type: 'fact', role: 'premise', dependsOn: [], definitions: [], data: [{ id: 'p2d1', need: 'adoption survey' }] },
  { id: 'T1', text: 'AI caused the rise', type: 'causal', role: 'testable', dependsOn: ['P1'], definitions: [{ term: 'AI', meaning: 'generative AI' }], comparisonNodeId: 'cmp-T1' },
  { id: 'T2', text: 'Adoption is widespread', type: 'fact', role: 'testable', dependsOn: ['P2'], definitions: [], comparisonNodeId: 'cmp-T2' }
];
const make = (over = {}, claims = claimDrafts()) => m.newArgumentMap(framing(over), { runId: 'run-1', roles, claims });
const nodesOf = s => [...Object.values(roles), ...s.claims.flatMap(c => [c.id, ...(c.data ?? []).map(d => d.id), ...(c.comparison ? [c.comparison.nodeId] : [])]), ...s.hypotheses.flatMap(h => [h.id, ...h.needs.map(n => n.id)])].map(id => ({ id }));
/** The state must still be a well-formed v2 value under the model's own validator. */
const valid = s => { const r = model.readArgumentMap({ nodes: nodesOf(s), argumentMap: plain(s) }); assert.equal(r.kind, 'usable', r.reason); return s; };

/** Researches every datum of a premise, assesses them and gives the AI result. */
function settlePremise(s, claimId, result = 'holds', check = 'page_match') {
  const claim = s.claims.find(c => c.id === claimId);
  claim.data.forEach((d, i) => { s = m.beginPremiseResearch(s, claimId, d.id); s = m.applyPremiseEvidence(s, claimId, d.id, found(i + 1, check)); });
  s = m.applyPremiseAssessments(s, claimId, claim.data.map(d => ({ datumId: d.id, assessment: assessment() })));
  return m.applyPremiseResult(s, claimId, { result, reason: 'because', citedData: [claim.data[0].id] });
}
/** Both premises hold: the run is in analysis. */
const analysis = () => settlePremise(settlePremise(make(), 'P1'), 'P2');

const pred = (id, kind, over = {}) => ({ id, kind, text: `${id} text`, required: false, ...(kind === 'support' ? { alsoPredictedBy: [] } : {}), ...(kind === 'refute' ? { auxiliary: ['P1'], reason: 'lowers credibility' } : {}), ...over });
const hyp = (id, role, over = {}) => ({
  id, role, identification: { strategy: 'difference in differences', assumptions: ['parallel trends'] },
  predictions: [pred(`${id}-s`, 'support', { required: true }), pred(`${id}-r`, 'refute')], ...over
});
const causalSet = () => [hyp('H1', 'primary'), hyp('H2', 'alternative'), hyp('H3', 'reverse')];
const factSet = () => [hyp('F1', 'facet', { identification: undefined }), hyp('F2', 'facet', { identification: undefined })];
const crit = { supports: 'rises', refutes: 'falls', irrelevant: 'flat' };
const needs = (hid, n = 1) => Array.from({ length: n }, (_, i) => ({ id: `${hid}-n${i + 1}`, predictionId: `${hid}-s`, text: `need ${i + 1}`, criteria: crit }));
/** Analysis with T1 hypotheses H1..H3 and T2 facets F1,F2 listed. */
function hypothesised() {
  let s = analysis();
  s = m.applyHypotheses(s, 'T1', causalSet());
  return m.applyHypotheses(s, 'T2', factSet());
}
const researched = (s, hid, nid, result = found()) => m.applyEvidence(m.beginResearch(s, hid, nid), hid, nid, result);
const assessAll = (s, hid, items) => m.applyEvidenceAssessment(s, hid, items.map(i => (typeof i === 'string' ? { needId: i, assessment: assessment() } : i)));
const hOf = (s, id) => s.hypotheses.find(h => h.id === id);
const types = s => plain(m.nextActions(s)).map(a => a.type);

// ---- creation and locking ---------------------------------------------------------------------------------------------------------
test('newArgumentMap builds a locked v2 map that the model validator accepts, in the premises phase', () => {
  const s = valid(make());
  assert.equal(s.v, 2);
  assert.equal(s.run.phase, 'premises');
  assert.equal(s.run.status, 'running');
  assert.equal(s.run.researchCalls, 0);
  assert.equal(s.framing.lockedAt, '2026-11-10T00:00:00.000Z');
  assert.equal(s.claims.find(c => c.id === 'T1').comparison.nodeId, 'cmp-T1');
  assert.equal(s.claims.find(c => c.id === 'P1').data[0].state, 'pending');
  assert.equal(s.conclusion.state, 'pending');
  assert.equal(s.hypotheses.length, 0);
});
test('lock gate: an unlocked framing, a chosen question outside the candidates, a bad candidate or too many attempts build nothing', () => {
  for (const bad of [{ lockedAt: '' }, { lockedAt: '  ' }, { lockedAt: undefined }, { chosen: 'q9' }, { chosen: '' }, { candidates: [] }, { attempts: 0 }, { attempts: 4 }, { original: '' }, { restatement: '' },
    { candidates: [{ id: 'q1', question: 'Q', answerShape: 's', diff: '', kind: 'nonsense', unanswered: false }] }])
    gateError(() => make(bad));
  gateError(() => m.newArgumentMap(null, { runId: 'r', roles, claims: claimDrafts() }));
  gateError(() => m.newArgumentMap(framing(), { runId: '', roles, claims: claimDrafts() }));
});
test('claim gates: only a fact can be a premise, a cause cannot, limits, dependencies, ids', () => {
  const swap = (id, patch) => claimDrafts().map(c => (c.id === id ? { ...c, ...patch } : c));
  const bad = [
    swap('P1', { type: 'causal' }), swap('P1', { type: 'main_cause' }), swap('P1', { type: 'comparison' }),
    swap('T1', { type: 'nonsense' }), swap('T1', { role: 'nonsense' }), swap('T1', { text: ' ' }),
    swap('P1', { data: [] }), swap('P1', { data: undefined }), swap('P1', { data: [{ id: 'a', need: 'x' }, { id: 'b', need: 'y' }, { id: 'c', need: 'z' }] }), swap('P1', { data: [{ id: 'a', need: '' }] }),
    swap('T1', { data: [{ id: 'a', need: 'x' }] }), swap('T1', { comparisonNodeId: undefined }), swap('P1', { comparisonNodeId: 'x' }),
    swap('T1', { dependsOn: ['ghost'] }), swap('T1', { dependsOn: ['T1'] }), swap('T1', { dependsOn: ['T2'] }), swap('P1', { dependsOn: ['P2'] }).map(c => (c.id === 'P2' ? { ...c, dependsOn: ['P1'] } : c)),
    swap('T2', { id: 'T1' }), swap('T2', { comparisonNodeId: 'cmp-T1' }), swap('P2', { data: [{ id: 'p1d1', need: 'dup' }] }),
    claimDrafts().filter(c => c.role === 'premise'),
    [...claimDrafts(), { id: 'T3', text: 't', type: 'fact', role: 'testable', dependsOn: [], definitions: [], comparisonNodeId: 'cmp-T3' }],
    [...claimDrafts(), { id: 'P3', text: 'p', type: 'fact', role: 'premise', dependsOn: [], definitions: [], data: [{ id: 'p3d', need: 'n' }] }, { id: 'P4', text: 'p', type: 'fact', role: 'premise', dependsOn: [], definitions: [], data: [{ id: 'p4d', need: 'n' }] }]
  ];
  bad.forEach((claims, i) => assert.throws(() => make({}, claims), error => error instanceof m.GateError, `bad claims #${i} must be refused`));
});
test('counterexample 零前提: a map with no premise is refused (a refute prediction needs a premise, so it could never conclude)', () => {
  const noPremise = claimDrafts().filter(c => c.id === 'T2').map(c => ({ ...c, dependsOn: [] }));
  assert.throws(() => make({}, noPremise), error => error instanceof m.GateError && /at least 1 premise/.test(error.message));
});
test('a map with one premise settles into analysis, takes hypotheses whose refute prediction leans on it, and can conclude', () => {
  const one = [claimDrafts()[1], { ...claimDrafts()[3], dependsOn: ['P2'] }];
  const s = valid(settlePremise(make({}, one), 'P2'));
  assert.equal(s.run.phase, 'analysis');
  const set = [1, 2].map(i => hyp(`H${i}`, 'facet', { predictions: [pred(`H${i}-s`, 'support', { required: true }), pred(`H${i}-r`, 'refute', { auxiliary: ['P2'] })] }));
  const next = m.applyHypotheses(s, 'T2', set);
  assert.equal(next.hypotheses.length, 2, 'the hypotheses are accepted with the one premise as the auxiliary');
});
test('locked: there is no reducer that edits the framing, the breakdown or a definition, and a whole run leaves them as locked', () => {
  eq(Object.keys(m).filter(k => /framing|restate|decompos|definition|rewrite|relax|remove|delete|edit|loosen/i.test(k)), []);
  const before = make();
  const lockedPart = s => JSON.stringify({ framing: s.framing, claims: s.claims.map(c => ({ id: c.id, text: c.text, type: c.type, role: c.role, dependsOn: c.dependsOn, definitions: c.definitions })) });
  let s = analysis();
  s = m.applyHypotheses(s, 'T1', causalSet());
  s = m.applyNeeds(s, 'H1', needs('H1'));
  s = researched(s, 'H1', 'H1-n1');
  s = m.applyUserVerdict(s, 'H1', 'supported');
  assert.equal(lockedPart(s), lockedPart(before));
});

// ---- premises ---------------------------------------------------------------------------------------------------------------------
test('premise data: 2 attempts, a first miss retries, the call counter counts dispatches', () => {
  let s = make();
  s = m.beginPremiseResearch(s, 'P1', 'p1d1');
  assert.equal(s.run.researchCalls, 1);
  assert.equal(s.claims[0].status, 'in_progress');
  refuses(s, () => m.beginPremiseResearch(s, 'P1', 'p1d1'));
  s = m.applyPremiseEvidence(s, 'P1', 'p1d1', miss);
  assert.equal(s.claims[0].data[0].state, 'pending');
  s = m.applyPremiseEvidence(m.beginPremiseResearch(s, 'P1', 'p1d1'), 'P1', 'p1d1', miss);
  assert.equal(s.claims[0].data[0].state, 'not_found');
  assert.equal(s.claims[0].data[0].attempts, 2);
  refuses(s, () => m.beginPremiseResearch(s, 'P1', 'p1d1'));
  refuses(s, () => m.applyPremiseEvidence(s, 'P1', 'p1d2', miss));
  valid(s);
});
test('premise evidence: a miss needs a reason, a found one needs a source shape and a known check', () => {
  let s = m.beginPremiseResearch(make(), 'P1', 'p1d1');
  refuses(s, () => m.applyPremiseEvidence(s, 'P1', 'p1d1', { found: false, reason: ' ' }));
  refuses(s, () => m.applyPremiseEvidence(s, 'P1', 'p1d1', { found: true, stance: 'supports', proof: { ...proof(), url: 'javascript:alert(1)' } }));
  refuses(s, () => m.applyPremiseEvidence(s, 'P1', 'p1d1', { found: true, stance: 'supports', proof: { ...proof(), check: 'provider_read' } }));
  refuses(s, () => m.applyPremiseEvidence(s, 'P1', 'p1d1', { found: true, stance: 'supports', proof: { ...proof(), quote: '' } }));
  s = m.applyPremiseEvidence(s, 'P1', 'p1d1', found(1, 'unverified_quote'));
  assert.equal(s.claims[0].data[0].proof.check, 'unverified_quote');
});
test('counterexample 前提失敗只停依賴者: a failed premise marks only its dependents not_evaluated and the rest of the run goes on', () => {
  let s = settlePremise(make(), 'P1', 'fails');
  assert.equal(s.claims.find(c => c.id === 'P1').result, 'fails');
  assert.equal(s.claims.find(c => c.id === 'T1').status, 'not_evaluated');
  assert.equal(s.claims.find(c => c.id === 'T2').status, 'pending', 'T2 does not depend on P1');
  assert.equal(s.run.phase, 'premises', 'P2 is still open');
  s = settlePremise(s, 'P2', 'holds');
  assert.equal(s.run.phase, 'analysis');
  assert.equal(s.run.status, 'running');
  eq(plain(m.nextActions(s)), [{ type: 'propose_hypotheses', claimId: 'T2' }], 'only the live claim moves');
  valid(s);
});
test('insufficient premise stops its dependents the same way; a failed premise also stops a dependent premise transitively', () => {
  const claims = claimDrafts().map(c => (c.id === 'P2' ? { ...c, dependsOn: ['P1'] } : c));
  let s = make({}, claims);
  s = settlePremise(s, 'P1', 'insufficient');
  assert.equal(s.claims.find(c => c.id === 'P2').status, 'not_evaluated');
  assert.equal(s.claims.find(c => c.id === 'T2').status, 'not_evaluated', 'T2 depends on P2, which was not evaluated');
  assert.equal(s.claims.find(c => c.id === 'T1').status, 'not_evaluated');
  assert.equal(s.run.phase, 'stopped_premise');
});
test('all testable claims stopped: stopped_premise, finished, no next action, no reducer works on it', () => {
  let s = settlePremise(make(), 'P1', 'fails');
  s = settlePremise(s, 'P2', 'fails');
  assert.equal(s.run.phase, 'stopped_premise');
  assert.equal(s.run.status, 'finished');
  assert.equal(s.run.stopReason, 'premise');
  assert.equal(s.conclusion.state, 'stopped_premise');
  eq(m.nextActions(s), []);
  refuses(s, () => m.applyHypotheses(s, 'T1', causalSet()));
  refuses(s, () => m.applyPause(s, 'user'));
  valid(s);
});
test('counterexample 前提缺數據不呼叫 AI: missing data end in insufficient by the program, the judge is never offered or accepted', () => {
  let s = make();
  s = m.applyPremiseEvidence(m.beginPremiseResearch(s, 'P1', 'p1d1'), 'P1', 'p1d1', found());
  for (let i = 0; i < 2; i++) s = m.applyPremiseEvidence(m.beginPremiseResearch(s, 'P1', 'p1d2'), 'P1', 'p1d2', miss);
  assert.ok(types(s).includes('premise_missing'));
  assert.ok(!types(s).includes('judge_premise') && !types(s).includes('assess_premise'), 'no AI step for a premise with a datum missing');
  const calls = s.run.researchCalls;
  refuses(s, () => m.applyPremiseAssessments(s, 'P1', [{ datumId: 'p1d1', assessment: assessment() }]));
  refuses(s, () => m.applyPremiseResult(s, 'P1', { result: 'holds', reason: 'r', citedData: ['p1d1'] }));
  s = m.applyPremiseMissing(s, 'P1');
  assert.equal(s.claims[0].result, 'insufficient');
  assert.equal(s.claims[0].status, 'done');
  assert.equal(s.claims.find(c => c.id === 'T1').status, 'not_evaluated');
  assert.equal(s.run.researchCalls, calls, 'no call was spent');
  refuses(s, () => m.applyPremiseMissing(s, 'P1'));
});
test('a premise with every datum found cannot be closed by the program', () => {
  let s = make();
  s = m.applyPremiseEvidence(m.beginPremiseResearch(s, 'P2', 'p2d1'), 'P2', 'p2d1', found());
  refuses(s, () => m.applyPremiseMissing(s, 'P2'));
});
test('premise actions: research, then assess, then judge; waits while a datum is searching', () => {
  let s = make();
  eq(plain(m.nextActions(s)).filter(a => a.claimId === 'P1'), [{ type: 'research_premise', claimId: 'P1', dataId: 'p1d1' }, { type: 'research_premise', claimId: 'P1', dataId: 'p1d2' }]);
  s = m.beginPremiseResearch(s, 'P1', 'p1d1');
  assert.ok(!plain(m.nextActions(s)).some(a => a.dataId === 'p1d1'));
  s = m.applyPremiseEvidence(s, 'P1', 'p1d1', found());
  s = m.applyPremiseEvidence(m.beginPremiseResearch(s, 'P1', 'p1d2'), 'P1', 'p1d2', found(2));
  eq(plain(m.nextActions(s)).filter(a => a.claimId === 'P1'), [{ type: 'assess_premise', claimId: 'P1' }]);
  s = m.applyPremiseAssessments(s, 'P1', [{ datumId: 'p1d1', assessment: assessment() }, { datumId: 'p1d2', assessment: assessment() }]);
  eq(plain(m.nextActions(s)).filter(a => a.claimId === 'P1'), [{ type: 'judge_premise', claimId: 'P1' }]);
});
test('premise judgement: unassessed data, empty or foreign citations, unverified quotes and a missing reason are not adopted', () => {
  let s = make();
  for (const d of ['p1d1', 'p1d2']) s = m.applyPremiseEvidence(m.beginPremiseResearch(s, 'P1', d), 'P1', d, found());
  refuses(s, () => m.applyPremiseResult(s, 'P1', { result: 'holds', reason: 'r', citedData: ['p1d1'] }));
  refuses(s, () => m.applyPremiseAssessments(s, 'P1', [{ datumId: 'p1d1', assessment: assessment() }]));
  s = m.applyPremiseAssessments(s, 'P1', [{ datumId: 'p1d1', assessment: assessment() }, { datumId: 'p1d2', assessment: assessment({ scopeFit: false, scopeNote: 'other country' }) }]);
  refuses(s, () => m.applyPremiseAssessments(s, 'P1', [{ datumId: 'p1d1', assessment: assessment() }]));
  refuses(s, () => m.applyPremiseResult(s, 'P1', { result: 'holds', reason: 'r', citedData: [] }));
  refuses(s, () => m.applyPremiseResult(s, 'P1', { result: 'holds', reason: 'r', citedData: ['p2d1'] }));
  refuses(s, () => m.applyPremiseResult(s, 'P1', { result: 'holds', reason: 'r', citedData: ['p1d2'] }));
  refuses(s, () => m.applyPremiseResult(s, 'P1', { result: 'holds', reason: ' ', citedData: ['p1d1'] }));
  refuses(s, () => m.applyPremiseResult(s, 'P1', { result: 'maybe', reason: 'r', citedData: ['p1d1'] }));
  let u = make();
  for (const d of ['p1d1', 'p1d2']) u = m.applyPremiseEvidence(m.beginPremiseResearch(u, 'P1', d), 'P1', d, found(1, 'unverified_quote'));
  u = m.applyPremiseAssessments(u, 'P1', ['p1d1', 'p1d2'].map(datumId => ({ datumId, assessment: assessment() })));
  refuses(u, () => m.applyPremiseResult(u, 'P1', { result: 'holds', reason: 'r', citedData: ['p1d1'] }));
  refuses(u, () => m.applyPremiseResult(u, 'P1', { result: 'fails', reason: 'r', citedData: ['p1d1'] }));
  const kept = m.applyPremiseResult(u, 'P1', { result: 'insufficient', reason: 'only tool-log quotes', citedData: [] });
  assert.equal(kept.claims[0].result, 'insufficient');
});
test('assessment fields: relevance and stance agree, a scope miss says why, ids stay inside the claim, sourceType and underlyingSource are required', () => {
  let s = m.applyPremiseEvidence(m.beginPremiseResearch(make(), 'P2', 'p2d1'), 'P2', 'p2d1', found());
  const bad = [assessment({ relevant: false, stance: 'supports' }), assessment({ relevant: true, stance: 'irrelevant' }), assessment({ scopeFit: false }), assessment({ scopeFit: false, scopeNote: ' ' }),
    assessment({ sourceType: '' }), assessment({ underlyingSource: '' }), assessment({ stance: 'maybe' }), assessment({ relevant: 'yes' }), assessment({ alsoRelevantTo: ['H1'] }), null];
  bad.forEach((a, i) => assert.throws(() => m.applyPremiseAssessments(s, 'P2', [{ datumId: 'p2d1', assessment: a }]), error => error instanceof m.GateError, `bad assessment #${i}`));
  s = m.applyPremiseAssessments(s, 'P2', [{ datumId: 'p2d1', assessment: assessment({ relevant: false, stance: 'irrelevant' }) }]);
  assert.equal(s.claims[1].data[0].assessment.stance, 'irrelevant');
  valid(s);
});

// ---- hypotheses -------------------------------------------------------------------------------------------------------------------
test('hypotheses: only in analysis, for a live testable claim, once', () => {
  const early = make();
  refuses(early, () => m.applyHypotheses(early, 'T1', causalSet()));
  let s = settlePremise(settlePremise(make(), 'P1', 'fails'), 'P2');
  refuses(s, () => m.applyHypotheses(s, 'T1', causalSet()));
  refuses(s, () => m.applyHypotheses(s, 'P1', causalSet()));
  refuses(s, () => m.applyHypotheses(s, 'nope', causalSet()));
  s = m.applyHypotheses(s, 'T2', factSet());
  assert.equal(s.claims.find(c => c.id === 'T2').status, 'in_progress');
  refuses(s, () => m.applyHypotheses(s, 'T2', [hyp('F3', 'facet', { identification: undefined }), hyp('F4', 'facet', { identification: undefined })]));
  valid(s);
});
test('hypothesis floor and roles by claim type (spec 4): cause and main cause need H-Y plus 2 alternatives, a comparison A, B and a measurement, a fact 2 facets', () => {
  const a = analysis();
  const refusedFor = (claimId, set) => assert.throws(() => m.applyHypotheses(a, claimId, set), error => error instanceof m.GateError);
  refusedFor('T1', [hyp('H1', 'primary'), hyp('H2', 'alternative')]);
  refusedFor('T1', [hyp('H1', 'alternative'), hyp('H2', 'alternative'), hyp('H3', 'alternative')]);
  refusedFor('T1', [hyp('H1', 'primary'), hyp('H2', 'primary'), hyp('H3', 'alternative')]);
  refusedFor('T1', [hyp('H1', 'primary'), hyp('H2', 'alternative'), hyp('H3', 'facet')]);
  refusedFor('T1', [hyp('H1', 'primary'), hyp('H2', 'alternative'), hyp('H3', 'measurement')]);
  refusedFor('T2', [hyp('F1', 'facet', { identification: undefined })]);
  refusedFor('T2', [hyp('F1', 'primary', { identification: undefined }), hyp('F2', 'facet', { identification: undefined })]);
  const ok = m.applyHypotheses(a, 'T1', [hyp('H1', 'primary'), hyp('H2', 'common_cause'), hyp('H3', 'reverse'), hyp('H4', 'alternative')]);
  assert.equal(ok.hypotheses.length, 4);
  const cmp = claimDrafts().map(c => (c.id === 'T1' ? { ...c, type: 'comparison' } : c));
  let c = make({}, cmp);
  c = settlePremise(settlePremise(c, 'P1'), 'P2');
  const noId = x => ({ ...x, identification: undefined });
  assert.throws(() => m.applyHypotheses(c, 'T1', [noId(hyp('A', 'primary')), noId(hyp('B', 'alternative'))]), error => error instanceof m.GateError, 'a measurement alternative is missing');
  assert.equal(m.applyHypotheses(c, 'T1', [noId(hyp('A', 'primary')), noId(hyp('B', 'alternative')), noId(hyp('M', 'measurement'))]).hypotheses.length, 3, 'a comparison needs no identification strategy');
});
test('hypothesis cap: 6 in the whole map, duplicate ids anywhere are refused', () => {
  let s = analysis();
  s = m.applyHypotheses(s, 'T1', [hyp('H1', 'primary'), hyp('H2', 'alternative'), hyp('H3', 'alternative'), hyp('H4', 'reverse'), hyp('H5', 'common_cause')]);
  refuses(s, () => m.applyHypotheses(s, 'T2', [hyp('F1', 'facet', { identification: undefined }), hyp('F2', 'facet', { identification: undefined })]));
  refuses(s, () => m.applyHypotheses(s, 'T2', [hyp('P1', 'facet', { identification: undefined }), hyp('F2', 'facet', { identification: undefined })]));
  refuses(s, () => m.applyHypotheses(s, 'T2', [hyp('H1', 'facet', { identification: undefined }), hyp('F2', 'facet', { identification: undefined })]));
  refuses(analysis(), () => m.applyHypotheses(analysis(), 'T2', [hyp('F1', 'facet', { identification: undefined }), hyp('F1', 'facet', { identification: undefined })]));
});
test('prediction fields: a refute prediction needs premise auxiliaries and a reason, a support prediction states who else predicts it, a cause needs an identification strategy', () => {
  const a = analysis();
  const withPred = (preds, over = {}) => [hyp('H1', 'primary', { predictions: preds, ...over }), hyp('H2', 'alternative'), hyp('H3', 'reverse')];
  const S1 = pred('H1-s', 'support', { required: true });
  const bad = [
    withPred([S1, pred('H1-r', 'refute', { auxiliary: [] })]),
    withPred([S1, pred('H1-r', 'refute', { auxiliary: undefined })]),
    withPred([S1, pred('H1-r', 'refute', { reason: '' })]),
    withPred([S1, pred('H1-r', 'refute', { reason: undefined })]),
    withPred([S1, pred('H1-r', 'refute', { auxiliary: ['T2'] })]),
    withPred([S1, pred('H1-r', 'refute', { auxiliary: ['ghost'] })]),
    withPred([{ ...S1, alsoPredictedBy: undefined }, pred('H1-r', 'refute')]),
    withPred([pred('H1-s', 'support', { required: true, alsoPredictedBy: [{ hypothesisId: 'H1', strength: 'same' }] }), pred('H1-r', 'refute')]),
    withPred([pred('H1-s', 'support', { required: true, alsoPredictedBy: [{ hypothesisId: 'ghost', strength: 'same' }] }), pred('H1-r', 'refute')]),
    withPred([pred('H1-s', 'support', { required: true, alsoPredictedBy: [{ hypothesisId: 'H2', strength: 'equal' }] }), pred('H1-r', 'refute')]),
    withPred([pred('H1-s', 'support'), pred('H1-r', 'refute')]),
    withPred([pred('H1-r', 'refute', { required: true })]),
    withPred([S1]),
    withPred([S1, pred('H1-r', 'refute'), pred('H1-r', 'refute')]),
    withPred([S1, { ...pred('H1-x', 'guess'), required: false }]),
    withPred([S1, pred('H1-r', 'refute')], { identification: undefined }),
    withPred([S1, pred('H1-r', 'refute')], { identification: { strategy: '', assumptions: ['x'] } }),
    withPred([S1, pred('H1-r', 'refute')], { identification: { strategy: 'RDD', assumptions: [] } }),
    withPred([S1, pred('H1-r', 'refute')], { role: 'alternative' })
  ];
  bad.forEach((set, i) => assert.throws(() => m.applyHypotheses(a, 'T1', set), error => error instanceof m.GateError, `bad hypothesis set #${i}`));
  const good = m.applyHypotheses(a, 'T1', withPred([pred('H1-s', 'support', { required: true, alsoPredictedBy: [{ hypothesisId: 'H2', strength: 'weaker' }] }), pred('H1-r', 'refute'), pred('H1-i', 'identification')]));
  assert.equal(hOf(good, 'H1').predictions[1].reason, 'lowers credibility');
  assert.equal(hOf(good, 'H1').round, 1);
  valid(good);
});

// ---- needs: pre-registration, add-only, replacement ----------------------------------------------------------------------------------
test('pre-registration: needs listed before the first research are pre, those added after research began are post', () => {
  let s = hypothesised();
  s = m.applyNeeds(s, 'H1', needs('H1', 2));
  eq(hOf(s, 'H1').needs.map(n => n.registered), ['pre', 'pre']);
  assert.equal(hOf(s, 'H1').needs[0].addedRound, 1);
  assert.equal(hOf(s, 'H1').needs[0].state, 'pending');
  s = researched(s, 'H1', 'H1-n1', miss);
  s = researched(s, 'H1', 'H1-n2');
  s = assessAll(s, 'H1', ['H1-n2']);
  s = m.startNextRound(s, 'H1', [{ id: 'H1-x1', predictionId: 'H1-r', text: 'extra', criteria: crit }]);
  const extra = hOf(s, 'H1').needs.find(n => n.id === 'H1-x1');
  assert.equal(extra.registered, 'post');
  assert.equal(extra.addedRound, 2);
  assert.equal(hOf(s, 'H1').round, 2);
  valid(s);
});
test('needs: add-only, ids unique, caps 3 per round and 6 per hypothesis, every required prediction gets one, the prediction must be its own', () => {
  const s = hypothesised();
  refuses(s, () => m.applyNeeds(s, 'H1', []));
  refuses(s, () => m.applyNeeds(s, 'H1', needs('H1', 4)));
  refuses(s, () => m.applyNeeds(s, 'H1', [{ id: 'x', predictionId: 'H1-r', text: 'only the refute one', criteria: crit }]));
  refuses(s, () => m.applyNeeds(s, 'H1', [{ id: 'x', predictionId: 'H2-s', text: 'foreign prediction', criteria: crit }]));
  refuses(s, () => m.applyNeeds(s, 'H1', [{ id: 'x', predictionId: 'H1-s', text: 'no criteria', criteria: { supports: 'a', refutes: '', irrelevant: 'c' } }]));
  refuses(s, () => m.applyNeeds(s, 'H1', [{ id: 'P1', predictionId: 'H1-s', text: 'dup id', criteria: crit }]));
  refuses(s, () => m.applyNeeds(s, 'H1', [{ id: 'x', predictionId: 'H1-s', text: ' ', criteria: crit }]));
  const listed = m.applyNeeds(s, 'H1', needs('H1', 1));
  refuses(listed, () => m.applyNeeds(listed, 'H1', needs('H1', 1)));
  refuses(listed, () => m.applyNeeds(listed, 'H1', [{ id: 'y', predictionId: 'H1-s', text: 'a second listing', criteria: crit }]));
  eq(Object.keys(m).filter(k => /removeneed|editneed|deleteneed|updateneed|relax|loosen|dropneed|removehyp/i.test(k)), [], 'no reducer can remove or relax a need');
});
test('counterexample 需求放寬不存在: later reducers never rewrite or drop a listed need', () => {
  let s = m.applyNeeds(hypothesised(), 'H1', needs('H1', 2));
  const original = plain(hOf(s, 'H1').needs);
  s = researched(s, 'H1', 'H1-n1', miss);
  s = researched(s, 'H1', 'H1-n2', miss);
  s = m.startNextRound(s, 'H1', [{ id: 'r1', predictionId: 'H1-s', text: 'softer', criteria: { supports: 'anything', refutes: 'nothing', irrelevant: 'none' }, replaces: 'H1-n1' }]);
  const now = plain(hOf(s, 'H1').needs);
  assert.equal(now.length, 3);
  now.slice(0, 2).forEach((n, i) => { assert.equal(n.text, original[i].text); eq(n.criteria, original[i].criteria); assert.equal(n.registered, 'pre'); assert.equal(n.id, original[i].id); assert.equal(n.state, 'not_found'); });
});
test('counterexample 取代需求 sameCondition: a replacement is post until the assessment confirms the same condition, and then counts as pre', () => {
  const dead = () => {
    let s = m.applyNeeds(hypothesised(), 'H1', needs('H1', 1));
    s = researched(s, 'H1', 'H1-n1', miss);
    return m.startNextRound(s, 'H1', [{ id: 'H1-r1', predictionId: 'H1-s', text: 'same thing, other source', criteria: crit, replaces: 'H1-n1' }]);
  };
  let s = dead();
  assert.equal(hOf(s, 'H1').needs[1].registered, 'post');
  assert.equal(hOf(s, 'H1').needs[1].replaces, 'H1-n1');
  s = researched(s, 'H1', 'H1-r1', found(2));
  refuses(s, () => assessAll(s, 'H1', ['H1-r1']), 'a replacement assessment must answer sameCondition');
  const no = assessAll(s, 'H1', [{ needId: 'H1-r1', assessment: assessment(), sameCondition: false }]);
  assert.equal(hOf(no, 'H1').needs[1].registered, 'post');
  assert.equal(hOf(no, 'H1').needs[1].sameCondition, false);
  assert.equal(m.testStatus(hOf(no, 'H1')), 'in_progress', 'the dead need is still unmet');
  const yes = assessAll(s, 'H1', [{ needId: 'H1-r1', assessment: assessment(), sameCondition: true }]);
  assert.equal(hOf(yes, 'H1').needs[1].registered, 'pre');
  assert.equal(m.testStatus(hOf(yes, 'H1')), 'complete');
  refuses(s, () => assessAll(s, 'H1', [{ needId: 'H1-r1', assessment: assessment(), sameCondition: 'yes' }]));
  valid(yes);
  // sameCondition is only meaningful on a replacement
  let plainNeed = researched(m.applyNeeds(hypothesised(), 'H1', needs('H1', 1)), 'H1', 'H1-n1');
  refuses(plainNeed, () => assessAll(plainNeed, 'H1', [{ needId: 'H1-n1', assessment: assessment(), sameCondition: true }]));
});
test('replacement rules: only a dead need of an earlier round, once, for the same prediction; round 4 and a 7th need are refused', () => {
  const base = m.applyNeeds(hypothesised(), 'H1', needs('H1', 2));
  const afterMiss = assessAll(researched(researched(base, 'H1', 'H1-n1', miss), 'H1', 'H1-n2'), 'H1', ['H1-n2']);
  refuses(afterMiss, () => m.startNextRound(afterMiss, 'H1', [{ id: 'r1', predictionId: 'H1-s', text: 'x', criteria: crit, replaces: 'H1-n2' }]));
  refuses(afterMiss, () => m.startNextRound(afterMiss, 'H1', [{ id: 'r1', predictionId: 'H1-r', text: 'x', criteria: crit, replaces: 'H1-n1' }]));
  refuses(afterMiss, () => m.startNextRound(afterMiss, 'H1', [{ id: 'r1', predictionId: 'H1-s', text: 'x', criteria: crit, replaces: 'ghost' }]));
  refuses(afterMiss, () => m.startNextRound(afterMiss, 'H1', [{ id: 'r1', predictionId: 'H1-s', text: 'x', criteria: crit, replaces: 'H1-n1' }, { id: 'r2', predictionId: 'H1-s', text: 'y', criteria: crit, replaces: 'H1-n1' }]));
  refuses(base, () => m.startNextRound(base, 'H1', [{ id: 'r1', predictionId: 'H1-s', text: 'x', criteria: crit }]), 'needs are still pending');
  let s = m.startNextRound(afterMiss, 'H1', [{ id: 'r1', predictionId: 'H1-s', text: 'x', criteria: crit, replaces: 'H1-n1' }]);
  refuses(s, () => m.startNextRound(s, 'H1', [{ id: 'r2', predictionId: 'H1-s', text: 'y', criteria: crit, replaces: 'H1-n1' }]));
  s = researched(s, 'H1', 'r1', miss);
  s = m.startNextRound(s, 'H1', [{ id: 'r2', predictionId: 'H1-s', text: 'y', criteria: crit }]);
  assert.equal(hOf(s, 'H1').round, 3);
  s = researched(s, 'H1', 'r2', miss);
  refuses(s, () => m.startNextRound(s, 'H1', [{ id: 'r3', predictionId: 'H1-s', text: 'z', criteria: crit }]), 'round 4');
  valid(s);
});

// ---- research ---------------------------------------------------------------------------------------------------------------------
test('research: counted at dispatch, capped at the model constant, a provider failure is released without a try', () => {
  let s = m.applyNeeds(hypothesised(), 'H1', needs('H1', 2));
  const before = s.run.researchCalls;
  s = m.beginResearch(s, 'H1', 'H1-n1');
  assert.equal(s.run.researchCalls, before + 1);
  assert.equal(hOf(s, 'H1').needs[0].state, 'searching');
  refuses(s, () => m.beginResearch(s, 'H1', 'H1-n1'));
  refuses(s, () => m.beginResearch(s, 'H1', 'ghost'));
  s = m.releaseNeedResearch(s, 'H1', 'H1-n1');
  assert.equal(hOf(s, 'H1').needs[0].state, 'pending');
  assert.equal(s.run.researchCalls, before + 1);
  refuses(s, () => m.releaseNeedResearch(s, 'H1', 'H1-n1'));
  const capped = plain(s); capped.run.researchCalls = model.MAX_RESEARCH_CALLS;
  refuses(capped, () => m.beginResearch(capped, 'H1', 'H1-n1'));
  refuses(m.applyPause(s, 'user'), () => m.beginResearch(m.applyPause(s, 'user'), 'H1', 'H1-n1'));
  valid(s);
});
test('research evidence: a found need keeps its proof check; a miss needs a reason; fake proofs are not adopted', () => {
  let s = m.beginResearch(m.applyNeeds(hypothesised(), 'H1', needs('H1', 1)), 'H1', 'H1-n1');
  refuses(s, () => m.applyEvidence(s, 'H1', 'H1-n1', { found: false, reason: '' }));
  refuses(s, () => m.applyEvidence(s, 'H1', 'H1-n1', { found: true, stance: 'supports', proof: { url: 'ftp://x', quote: 'q', claim: 'c', check: 'page_match', checkedAt: 'now' } }));
  refuses(s, () => m.applyEvidence(s, 'H1', 'H1-n1', { found: true, stance: 'supports', proof: { ...proof(), check: 'guess' } }));
  s = m.applyEvidence(s, 'H1', 'H1-n1', found(1, 'unverified_quote'));
  assert.equal(hOf(s, 'H1').needs[0].proof.check, 'unverified_quote');
  assert.equal(hOf(s, 'H1').needs[0].state, 'found');
  refuses(s, () => m.applyEvidence(s, 'H1', 'H1-n1', found()));
});
test('counterexample 研究 dispatch 不碰被停子主張: a stopped claim gets no action, no hypotheses and no research even from a forged hypothesis', () => {
  let s = settlePremise(settlePremise(make(), 'P1', 'fails'), 'P2');
  assert.ok(plain(m.nextActions(s)).every(a => a.claimId === 'T2'));
  const forged = plain(s);
  forged.hypotheses.push({ id: 'HX', claimId: 'T1', role: 'primary', round: 1, predictions: [{ id: 'HX-s', kind: 'support', text: 't', alsoPredictedBy: [], auxiliary: [], required: true }], needs: [{ id: 'HX-n', predictionId: 'HX-s', text: 'n', criteria: crit, registered: 'pre', addedRound: 1, state: 'pending' }] });
  assert.ok(!plain(m.nextActions(forged)).some(a => a.hypothesisId === 'HX'));
  refuses(forged, () => m.beginResearch(forged, 'HX', 'HX-n'));
  refuses(forged, () => m.applyNeeds(forged, 'HX', needs('HX')));
  refuses(forged, () => m.applyProgramVerdict(forged, 'HX'));
});
test('analysis actions: hypotheses, needs, research, assessment, next round', () => {
  let s = analysis();
  eq(plain(m.nextActions(s)), [{ type: 'propose_hypotheses', claimId: 'T1' }, { type: 'propose_hypotheses', claimId: 'T2' }]);
  s = m.applyHypotheses(s, 'T1', causalSet());
  eq(plain(m.nextActions(s)).filter(a => a.hypothesisId), [{ type: 'add_needs', hypothesisId: 'H1' }, { type: 'add_needs', hypothesisId: 'H2' }, { type: 'add_needs', hypothesisId: 'H3' }]);
  s = m.applyNeeds(s, 'H1', needs('H1'));
  eq(plain(m.nextActions(s)).filter(a => a.hypothesisId === 'H1'), [{ type: 'research_need', hypothesisId: 'H1', needId: 'H1-n1' }]);
  s = m.beginResearch(s, 'H1', 'H1-n1');
  eq(plain(m.nextActions(s)).filter(a => a.hypothesisId === 'H1'), []);
  s = m.applyEvidence(s, 'H1', 'H1-n1', found());
  eq(plain(m.nextActions(s)).filter(a => a.hypothesisId === 'H1'), [{ type: 'assess_evidence', hypothesisId: 'H1' }]);
  s = assessAll(s, 'H1', ['H1-n1']);
  eq(plain(m.nextActions(s)).filter(a => a.hypothesisId === 'H1'), [{ type: 'verdict', hypothesisId: 'H1' }], 'complete: the verdict step belongs to V2b');
  const dead = researched(m.applyNeeds(m.applyHypotheses(analysis(), 'T1', causalSet()), 'H1', needs('H1')), 'H1', 'H1-n1', miss);
  eq(plain(m.nextActions(dead)).filter(a => a.hypothesisId === 'H1'), [{ type: 'next_round', hypothesisId: 'H1' }]);
  eq(m.nextActions(m.applyPause(s, 'user')), []);
});

// ---- evidence assessment and test status -----------------------------------------------------------------------------------------
test('evidence assessment: only found needs, all of the settled round at once, once each, other hypotheses of the same claim only', () => {
  let s = m.applyNeeds(hypothesised(), 'H1', needs('H1', 2));
  refuses(s, () => assessAll(s, 'H1', ['H1-n1']));
  s = researched(researched(s, 'H1', 'H1-n1'), 'H1', 'H1-n2', found(2));
  refuses(s, () => assessAll(s, 'H1', []));
  refuses(s, () => assessAll(s, 'H1', ['H1-n1']), 'every found need of the round is assessed in the same call');
  refuses(s, () => assessAll(s, 'H1', ['H1-n1', 'ghost']));
  refuses(s, () => assessAll(s, 'H1', [{ needId: 'H1-n1', assessment: assessment({ alsoRelevantTo: ['F1'] }) }, 'H1-n2']), 'F1 belongs to another claim');
  refuses(s, () => assessAll(s, 'H1', [{ needId: 'H1-n1', assessment: assessment({ alsoRelevantTo: ['H1'] }) }, 'H1-n2']));
  const done = assessAll(s, 'H1', [{ needId: 'H1-n1', assessment: assessment({ alsoRelevantTo: ['H2'] }) }, 'H1-n2']);
  eq(hOf(done, 'H1').needs[0].assessment.alsoRelevantTo, ['H2']);
  refuses(done, () => assessAll(done, 'H1', ['H1-n1']));
  valid(done);
});
test('counterexample V3: an unverified_quote need never completes the test and borrows nothing from another need page_match', () => {
  let s = m.applyNeeds(hypothesised(), 'H1', needs('H1', 2));
  s = researched(researched(s, 'H1', 'H1-n1', found(1, 'unverified_quote')), 'H1', 'H1-n2', found(2, 'page_match'));
  s = assessAll(s, 'H1', ['H1-n1', 'H1-n2']);
  assert.equal(m.testStatus(hOf(s, 'H1')), 'in_progress', 'one unmet need keeps the test open');
  let only = researched(m.applyNeeds(hypothesised(), 'H1', needs('H1', 1)), 'H1', 'H1-n1', found(1, 'unverified_quote'));
  only = assessAll(only, 'H1', ['H1-n1']);
  assert.notEqual(m.testStatus(hOf(only, 'H1')), 'complete');
  assert.equal(hOf(only, 'H1').needs[0].proof.check, 'unverified_quote', 'kept on record');
});
test('testStatus: in_progress, complete, limit_incomplete are derived and never stored', () => {
  let s = m.applyNeeds(hypothesised(), 'H1', needs('H1'));
  assert.equal(m.testStatus(hOf(s, 'H1')), 'in_progress');
  s = researched(s, 'H1', 'H1-n1');
  assert.equal(m.testStatus(hOf(s, 'H1')), 'in_progress', 'found but not yet assessed');
  s = assessAll(s, 'H1', ['H1-n1']);
  assert.equal(m.testStatus(hOf(s, 'H1')), 'complete');
  assert.ok(!JSON.stringify(s).includes('limit_incomplete') && !JSON.stringify(s).includes('"complete"'), 'not stored');
  assert.equal(m.testStatus(hOf(hypothesised(), 'H1')), 'in_progress', 'no needs yet');
  // a refute prediction that is not required does not hold the status back; an irrelevant or out-of-scope result does not satisfy
  const irrelevant = assessAll(researched(m.applyNeeds(hypothesised(), 'H1', needs('H1')), 'H1', 'H1-n1'), 'H1', [{ needId: 'H1-n1', assessment: assessment({ relevant: false, stance: 'irrelevant' }) }]);
  assert.equal(m.testStatus(hOf(irrelevant, 'H1')), 'in_progress');
  const outScope = assessAll(researched(m.applyNeeds(hypothesised(), 'H1', needs('H1')), 'H1', 'H1-n1'), 'H1', [{ needId: 'H1-n1', assessment: assessment({ scopeFit: false, scopeNote: 'another country' }) }]);
  assert.equal(m.testStatus(hOf(outScope, 'H1')), 'in_progress');
  assert.equal(m.testStatus(hOf(s, 'H1'), model.MAX_RESEARCH_CALLS), 'complete', 'a complete test stays complete at the limit');
});
test('counterexample 未核對引文不能滿足需求: an unverified quote never completes the test, and it is not pooled with a verified need of another prediction', () => {
  const two = [{ id: 'H1-n1', predictionId: 'H1-s', text: 'a', criteria: crit }, { id: 'H1-n2', predictionId: 'H1-x', text: 'b', criteria: crit }];
  const set = [hyp('H1', 'primary', { predictions: [pred('H1-s', 'support', { required: true }), pred('H1-x', 'support', { required: true }), pred('H1-r', 'refute')] }), hyp('H2', 'alternative'), hyp('H3', 'reverse')];
  let s = m.applyNeeds(m.applyHypotheses(analysis(), 'T1', set), 'H1', two);
  s = researched(s, 'H1', 'H1-n1', found(1, 'unverified_quote'));
  s = researched(s, 'H1', 'H1-n2', found(2, 'page_match'));
  s = assessAll(s, 'H1', ['H1-n1', 'H1-n2']);
  assert.notEqual(m.testStatus(hOf(s, 'H1')), 'complete');
  // alone
  let one = m.applyNeeds(hypothesised(), 'H1', needs('H1'));
  one = assessAll(researched(one, 'H1', 'H1-n1', found(1, 'unverified_quote')), 'H1', ['H1-n1']);
  assert.equal(m.testStatus(hOf(one, 'H1')), 'in_progress');
  assert.equal(m.testStatus(hOf(one, 'H1'), model.MAX_RESEARCH_CALLS), 'limit_incomplete', 'at the research limit it stays incomplete');
  assert.equal(m.testStatus({ ...hOf(one, 'H1'), round: 3 }), 'limit_incomplete', 'at the last round it stays incomplete');
  // a verified one does satisfy
  const ok = assessAll(researched(m.applyNeeds(hypothesised(), 'H1', needs('H1')), 'H1', 'H1-n1'), 'H1', ['H1-n1']);
  assert.equal(m.testStatus(hOf(ok, 'H1')), 'complete');
  // an exploratory (post) success does not satisfy a required test either
  let post = m.applyNeeds(hypothesised(), 'H1', needs('H1'));
  post = researched(post, 'H1', 'H1-n1', miss);
  post = m.startNextRound(post, 'H1', [{ id: 'H1-x', predictionId: 'H1-s', text: 'exploratory', criteria: crit }]);
  post = assessAll(researched(post, 'H1', 'H1-x', found(3)), 'H1', ['H1-x']);
  assert.notEqual(m.testStatus(hOf(post, 'H1')), 'complete');
});

// ---- limit and the program verdict --------------------------------------------------------------------------------------------------
test('counterexample 到上限由程式判證據不足 AI=0: at the research limit an incomplete hypothesis gets insufficient from the program, no AI action, no call', () => {
  let s = m.applyNeeds(hypothesised(), 'H1', needs('H1'));
  assert.equal(plain(m.nextActions(s)).some(a => a.hypothesisId === 'H1' && a.type === 'program_verdict'), false);
  s = plain(s); s.run.researchCalls = model.MAX_RESEARCH_CALLS;
  assert.equal(m.testStatus(hOf(s, 'H1'), s.run.researchCalls), 'limit_incomplete');
  const next = plain(m.nextActions(s)).filter(a => a.hypothesisId === 'H1');
  eq(next, [{ type: 'program_verdict', hypothesisId: 'H1' }]);
  const calls = s.run.researchCalls;
  const done = m.applyProgramVerdict(s, 'H1');
  const v = hOf(done, 'H1').verdict;
  assert.equal(v.value, 'insufficient');
  assert.equal(v.by, 'program');
  assert.equal(v.causal, 'not_applicable');
  assert.equal(v.confidence, 'low');
  eq(v.citedNeeds, []);
  assert.ok(v.reason.length > 0);
  assert.equal(done.run.researchCalls, calls);
  eq(plain(m.nextActions(done)).filter(a => a.hypothesisId === 'H1'), []);
  refuses(done, () => m.applyProgramVerdict(done, 'H1'));
  refuses(done, () => m.applyNeeds(done, 'H1', needs('H1')));
  valid(done);
  // a hypothesis that never got its needs listed is decided the same way, without an AI listing call
  const bare = plain(hypothesised()); bare.run.researchCalls = model.MAX_RESEARCH_CALLS;
  eq(plain(m.nextActions(bare)).filter(a => a.hypothesisId === 'H2'), [{ type: 'program_verdict', hypothesisId: 'H2' }]);
  assert.equal(hOf(m.applyProgramVerdict(bare, 'H2'), 'H2').verdict.value, 'insufficient');
});
test('program verdict at the last round with every need dead, and its refusals: in progress, complete, a verified refuting evidence, a sibling in flight', () => {
  let s = m.applyNeeds(hypothesised(), 'H1', needs('H1'));
  refuses(s, () => m.applyProgramVerdict(s, 'H1'));
  s = researched(s, 'H1', 'H1-n1', miss);
  s = m.startNextRound(s, 'H1', [{ id: 'r1', predictionId: 'H1-s', text: 'x', criteria: crit, replaces: 'H1-n1' }]);
  s = researched(s, 'H1', 'r1', miss);
  s = m.startNextRound(s, 'H1', [{ id: 'r2', predictionId: 'H1-s', text: 'y', criteria: crit }]);
  s = researched(s, 'H1', 'r2', miss);
  assert.equal(m.testStatus(hOf(s, 'H1')), 'limit_incomplete');
  assert.equal(hOf(m.applyProgramVerdict(s, 'H1'), 'H1').verdict.value, 'insufficient');
  // complete: not for the program
  const complete = assessAll(researched(m.applyNeeds(hypothesised(), 'H1', needs('H1')), 'H1', 'H1-n1'), 'H1', ['H1-n1']);
  refuses(complete, () => m.applyProgramVerdict(complete, 'H1'));
  // limit reached but a verified, relevant, in-scope refuting evidence exists: the AI must judge it
  const two = [{ id: 'H1-n1', predictionId: 'H1-s', text: 'a', criteria: crit }, { id: 'H1-n2', predictionId: 'H1-r', text: 'b', criteria: crit }];
  const set = [hyp('H1', 'primary', { predictions: [pred('H1-s', 'support', { required: true }), pred('H1-r', 'refute', { required: true })] }), hyp('H2', 'alternative'), hyp('H3', 'reverse')];
  let r = m.applyNeeds(m.applyHypotheses(analysis(), 'T1', set), 'H1', two);
  r = researched(researched(r, 'H1', 'H1-n1', miss), 'H1', 'H1-n2', found(2));
  r = assessAll(r, 'H1', [{ needId: 'H1-n2', assessment: assessment({ stance: 'refutes' }) }]);
  r = plain(r); r.run.researchCalls = model.MAX_RESEARCH_CALLS;
  assert.equal(m.testStatus(hOf(r, 'H1'), r.run.researchCalls), 'limit_incomplete');
  refuses(r, () => m.applyProgramVerdict(r, 'H1'));
  eq(plain(m.nextActions(r)).filter(a => a.hypothesisId === 'H1'), [{ type: 'verdict', hypothesisId: 'H1' }]);
  // the same refuting evidence unverified does not stop the program
  let u = m.applyNeeds(m.applyHypotheses(analysis(), 'T1', set), 'H1', two);
  u = researched(researched(u, 'H1', 'H1-n1', miss), 'H1', 'H1-n2', found(2, 'unverified_quote'));
  u = plain(assessAll(u, 'H1', [{ needId: 'H1-n2', assessment: assessment({ stance: 'refutes' }) }])); u.run.researchCalls = model.MAX_RESEARCH_CALLS;
  assert.equal(hOf(m.applyProgramVerdict(u, 'H1'), 'H1').verdict.value, 'insufficient');
});

// ---- user marks -------------------------------------------------------------------------------------------------------------------
test('counterexample 使用者標記不影響輸入: a user verdict is a mark only; actions, test status, needs and verdicts are unchanged', () => {
  let s = assessAll(researched(m.applyNeeds(hypothesised(), 'H1', needs('H1')), 'H1', 'H1-n1'), 'H1', ['H1-n1']);
  const base = plain(s);
  const marked = m.applyUserVerdict(s, 'H1', 'refuted');
  assert.equal(hOf(marked, 'H1').userVerdict, 'refuted');
  const strip = state => { const c = plain(state); for (const h of c.hypotheses) delete h.userVerdict; return c; };
  eq(strip(marked), strip(base));
  eq(plain(m.nextActions(marked)), plain(m.nextActions(s)));
  assert.equal(m.testStatus(hOf(marked, 'H1')), m.testStatus(hOf(s, 'H1')));
  assert.equal(hOf(marked, 'H1').verdict, undefined);
  const cleared = m.applyUserVerdict(marked, 'H1', undefined);
  eq(plain(cleared), base);
  refuses(s, () => m.applyUserVerdict(s, 'H1', 'maybe'));
  refuses(s, () => m.applyUserVerdict(s, 'ghost', 'supported'));
  // the mark on a program verdict does not touch the verdict itself
  const lim = plain(s); lim.run.researchCalls = model.MAX_RESEARCH_CALLS;
  valid(marked);
});

// ---- pause and purity -------------------------------------------------------------------------------------------------------------
test('pause returns searching items to pending, resume only from paused, finished runs refuse both', () => {
  let s = m.beginPremiseResearch(make(), 'P1', 'p1d1');
  s = m.applyPause(s, 'interrupted');
  assert.equal(s.run.status, 'paused');
  assert.equal(s.run.stopReason, 'interrupted');
  assert.equal(s.claims[0].data[0].state, 'pending');
  eq(m.nextActions(s), []);
  refuses(s, () => m.applyPause(s, 'bogus'));
  const back = m.applyResume(s);
  assert.equal(back.run.status, 'running');
  assert.equal(back.run.stopReason, undefined);
  refuses(back, () => m.applyResume(back));
  let h = m.applyNeeds(hypothesised(), 'H1', needs('H1'));
  h = m.applyPause(m.beginResearch(h, 'H1', 'H1-n1'), 'user');
  assert.equal(hOf(h, 'H1').needs[0].state, 'pending');
  valid(h);
});
test('reducers are pure: a successful call leaves its input untouched and the output is a new object', () => {
  const s = hypothesised();
  const before = JSON.stringify(s);
  const next = m.applyNeeds(s, 'H1', needs('H1'));
  assert.equal(JSON.stringify(s), before);
  assert.notEqual(next, s);
  assert.notEqual(next.framing, s.framing);
  const f = framing();
  const built = m.newArgumentMap(f, { runId: 'r', roles, claims: claimDrafts() });
  built.framing.restatement = 'changed';
  assert.equal(f.restatement, 'Restated', 'the map owns a copy of the framing');
});
test('counterexample 前提失敗 (R1 L2): a premise that fails closes a dependent premise whose datum was being searched; that datum does not stay searching', () => {
  const drafts = claimDrafts().map(c => c.id === 'P2' ? { ...c, dependsOn: ['P1'] } : c);
  let s = make({}, drafts);
  s = m.beginPremiseResearch(s, 'P2', 'p2d1');
  assert.equal(s.claims.find(c => c.id === 'P2').data[0].state, 'searching');
  s = settlePremise(s, 'P1', 'fails');
  const p2 = s.claims.find(c => c.id === 'P2');
  assert.equal(p2.status, 'not_evaluated');
  assert.ok(p2.data.every(d => d.state !== 'searching'), 'no datum is left searching on a closed premise');
  valid(s);
});
