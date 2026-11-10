// Argument map state machine v2 (V2b): verdict, causal status, confidence, comparison with veto, re-judging, conclusion, inference check, limits and cost.
// Gates are pure reducers that throw GateError; nothing here asks an AI. V2a's tests are in tests/steps-argument-machine-v2.cjs.
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
const roles = { proposition: 'n-prop', premises: 'n-pre', conclusion: 'n-con' };
const crit = { supports: 'rises', refutes: 'falls', irrelevant: 'flat' };
let uid = 100;
const proof = (n, check = 'page_match') => ({ url: `https://example.org/p${n}`, quote: `quote ${n} from the page`, claim: `claim ${n}`, check, checkedAt: '2026-11-10T00:00:00.000Z' });
const found = (check = 'page_match') => ({ found: true, stance: 'supports', proof: proof(++uid, check) });
const assessment = (over = {}) => ({ relevant: true, stance: 'supports', scopeFit: true, sourceType: 'official statistics', underlyingSource: 'BLS', alsoRelevantTo: [], ...over });

const framing = (over = {}) => ({
  original: 'Is AI the main reason for youth unemployment?', restatement: 'Restated', presuppositions: [], loadedTerms: [], vagueTerms: [], outOfScope: [],
  candidates: [{ id: 'q1', question: 'Q1', answerShape: 'a ranking', diff: '', kind: 'interpretation', unanswered: false }],
  chosen: 'q1', settings: [], attempts: 1, lockedAt: '2026-11-10T00:00:00.000Z', ...over
});
const claimDrafts = (t1 = 'causal') => [
  { id: 'P1', text: 'Youth unemployment rose', type: 'fact', role: 'premise', dependsOn: [], definitions: [], data: [{ id: 'p1d1', need: 'rate series' }] },
  { id: 'P2', text: 'AI tools are in use', type: 'fact', role: 'premise', dependsOn: [], definitions: [], data: [{ id: 'p2d1', need: 'adoption survey' }] },
  { id: 'T1', text: 'AI caused the rise', type: t1, role: 'testable', dependsOn: ['P1'], definitions: [{ term: 'AI', meaning: 'generative AI' }], comparisonNodeId: 'cmp-T1' },
  { id: 'T2', text: 'Adoption is widespread', type: 'fact', role: 'testable', dependsOn: ['P2'], definitions: [], comparisonNodeId: 'cmp-T2' }
];
const make = (over = {}, claims = claimDrafts()) => m.newArgumentMap(framing(over), { runId: 'run-1', roles, claims });
const nodesOf = s => [...Object.values(roles), ...s.claims.flatMap(c => [c.id, ...(c.data ?? []).map(d => d.id), ...(c.comparison ? [c.comparison.nodeId] : [])]), ...s.hypotheses.flatMap(h => [h.id, ...h.needs.map(n => n.id)])].map(id => ({ id }));
/** The state must still be a well-formed v2 value under the model's own validator. */
const valid = s => { const r = model.readArgumentMap({ nodes: nodesOf(s), argumentMap: plain(s) }); assert.equal(r.kind, 'usable', r.reason); return s; };

function settlePremise(s, claimId, result = 'holds') {
  const claim = s.claims.find(c => c.id === claimId);
  claim.data.forEach(d => { s = m.beginPremiseResearch(s, claimId, d.id); s = m.applyPremiseEvidence(s, claimId, d.id, found()); });
  s = m.applyPremiseAssessments(s, claimId, claim.data.map(d => ({ datumId: d.id, assessment: assessment() })));
  return m.applyPremiseResult(s, claimId, { result, reason: 'because', citedData: [claim.data[0].id] });
}
const analysis = (claims, p2 = 'holds', over = {}) => settlePremise(settlePremise(make(over, claims), 'P1'), 'P2', p2);

const pred = (id, kind, over = {}) => ({ id, kind, text: `${id} text`, required: false, ...(kind === 'support' ? { alsoPredictedBy: [] } : {}), ...(kind === 'refute' ? { auxiliary: ['P1'], reason: 'lowers credibility' } : {}), ...over });
const hyp = (id, role, over = {}) => ({ id, role, identification: { strategy: 'difference in differences', assumptions: ['parallel trends'] }, predictions: [pred(`${id}-s`, 'support', { required: true }), pred(`${id}-r`, 'refute')], ...over });
const facet = id => hyp(id, 'facet', { identification: undefined });
const causalSet = () => [hyp('H1', 'primary'), hyp('H2', 'alternative'), hyp('H3', 'reverse')];
const hOf = (s, id) => s.hypotheses.find(h => h.id === id);
const cOf = (s, id) => s.claims.find(c => c.id === id);
const researched = (s, hid, nid, result = found()) => m.applyEvidence(m.beginResearch(s, hid, nid), hid, nid, result);
const assessAll = (s, hid, items) => m.applyEvidenceAssessment(s, hid, items);
const types = s => plain(m.nextActions(s)).map(a => a.type);

/**
 * Lists a support need (`<id>-n1`) and a refute need (`<id>-n2`), researches both and assesses them. `stance` is the refute need's stance:
 * `supports` = the refute prediction did not come true; `refutes` = counter-evidence.
 */
function tested(s, hid, { stance = 'supports', source = 'BLS', also = [], check = 'page_match' } = {}) {
  s = m.applyNeeds(s, hid, [{ id: `${hid}-n1`, predictionId: `${hid}-s`, text: 'a', criteria: crit }, { id: `${hid}-n2`, predictionId: `${hid}-r`, text: 'b', criteria: crit }]);
  s = researched(researched(s, hid, `${hid}-n1`, found(check)), hid, `${hid}-n2`, found(check));
  return assessAll(s, hid, [{ needId: `${hid}-n1`, assessment: assessment({ underlyingSource: source }) }, { needId: `${hid}-n2`, assessment: assessment({ stance, underlyingSource: source, alsoRelevantTo: also }) }]);
}
const supportedDraft = (over = {}) => ({ value: 'supported', reason: 'the tests agree', citedNeeds: ['H1-n1'], counterNotes: [], refutations: [], causal: 'established', assumptionStatus: [{ assumption: 'parallel trends', status: 'checked' }], confidence: 'medium', ...over });
const factSupported = hid => supportedDraft({ citedNeeds: [`${hid}-n1`], causal: 'not_applicable', assumptionStatus: [] });
const refutedDraft = hid => ({ value: 'refuted', reason: 'the refute test came true', citedNeeds: [`${hid}-n2`], counterNotes: ['the evidence contradicts it'], refutations: [{ needId: `${hid}-n2`, class: 'decisive', auxiliary: ['P1'] }], causal: 'not_applicable', assumptionStatus: [], confidence: 'medium' });
const undecidedDraft = () => ({ value: 'undecided', reason: 'neither way', citedNeeds: [], counterNotes: [], refutations: [], causal: 'not_applicable', assumptionStatus: [], confidence: 'low' });
const defended = (over = {}) => supportedDraft({ causal: 'conditional', assumptionStatus: [{ assumption: 'parallel trends', status: 'defended', defense: 'the pre-trend is flat' }], ...over });
const judged = (s, hid, opts, draft) => m.applyVerdict(tested(s, hid, opts), hid, draft);

/** T1 causal with H1 supported, H2 and H3 refuted, T2 with two supported facets. Every verdict is in: the run is at the comparison. */
function allJudged() {
  let s = m.applyHypotheses(m.applyHypotheses(analysis(), 'T1', causalSet()), 'T2', [facet('F1'), facet('F2')]);
  s = judged(s, 'H1', {}, supportedDraft());
  s = judged(s, 'H2', { stance: 'refutes' }, refutedDraft('H2'));
  s = judged(s, 'H3', { stance: 'refutes' }, refutedDraft('H3'));
  s = judged(s, 'F1', {}, factSupported('F1'));
  return judged(s, 'F2', {}, factSupported('F2'));
}
const done = (answer, over = {}) => ({ decision: 'complete', vetoes: [], allocations: [], answer, ...over });
function toConclusion() {
  let s = m.applyComparison(allJudged(), 'T1', done('causal_established'));
  s = m.applyComparison(s, 'T2', done('holds'));
  return s;
}
const answersOf = () => [{ claimId: 'T1', answer: 'causal_established', sentence: 'AI caused the rise.', assumptions: [] }, { claimId: 'T2', answer: 'holds', sentence: 'Adoption is widespread.', assumptions: [] }];
const concluded = (extra = {}) => m.applyConclusion(toConclusion(), { answers: answersOf(), ...extra });

// ---- cost --------------------------------------------------------------------------------------------------------------------------
test('WORST_CASE_AI_CALLS is 146 and is computed from the constants, not typed in', () => {
  assert.equal(model.WORST_CASE_AI_CALLS, 146);
  assert.equal(model.MAX_COMPARISONS, 2);
  assert.equal(model.MAX_REVERDICTS, 1);
  assert.equal(model.MAX_INFERENCE_CHECKS, 2);
  const sum = model.MAX_FRAMING_CALLS + model.MAX_RESEARCH_CALLS + model.MAX_PREMISES * 2 + model.MAX_TESTABLE * 2 + model.MAX_HYPOTHESES * model.MAX_ROUND * 3
    + model.MAX_HYPOTHESES * model.MAX_REVERDICTS + model.MAX_TESTABLE * model.MAX_COMPARISONS + 1 + model.MAX_INFERENCE_CHECKS;
  assert.equal(model.WORST_CASE_AI_CALLS, sum);
  assert.equal(3 + 66 + 6 + 4 + 54 + 6 + 4 + 1 + 2, 146);
});

// ---- the verdict step's input -----------------------------------------------------------------------------------------------------
test('prepareVerdict shows only that hypothesis: its predictions, needs, sources, the premises it leans on and the counter-evidence allocated to it', () => {
  let s = m.applyHypotheses(analysis(), 'T1', causalSet());
  s = tested(s, 'H1');
  s = tested(s, 'H2', { stance: 'refutes', also: ['H1'] });
  const v = plain(m.prepareVerdict(s, 'H1'));
  eq(v.evidence.map(e => e.needId), ['H1-n1', 'H1-n2']);
  eq(v.counterEvidence, []);
  eq(v.premises.map(p => p.id), ['P1']);
  const text = JSON.stringify(v);
  assert.ok(!text.includes('H3'), 'no other hypothesis');
  assert.ok(!text.includes('H2'), 'nothing of H2 before the comparison allocated it');
  assert.ok(!text.includes('userVerdict'));
  // after an allocation the allocated counter-evidence is shown and must be answered
  const alloc = plain(s); alloc.claims.find(c => c.id === 'T1').comparison.allocations.push({ needId: 'H2-n2', hypothesisId: 'H1' });
  const w = plain(m.prepareVerdict(alloc, 'H1'));
  eq(w.counterEvidence, ['H2-n2']);
  eq(w.evidence.filter(e => !e.own).map(e => e.needId), ['H2-n2']);
});
test('counterexample 使用者標記不影響輸入: a user mark changes neither the verdict, the comparison nor the conclusion input', () => {
  const s = allJudged();
  let marked = s;
  for (const h of s.hypotheses) marked = m.applyUserVerdict(marked, h.id, h.verdict.value === 'supported' ? 'refuted' : 'supported');
  assert.equal(JSON.stringify(m.prepareComparison(marked, 'T1')), JSON.stringify(m.prepareComparison(s, 'T1')));
  assert.equal(JSON.stringify(m.prepareComparison(marked, 'T2')), JSON.stringify(m.prepareComparison(s, 'T2')));
  const t = toConclusion();
  let markedT = t;
  for (const h of t.hypotheses) markedT = m.applyUserVerdict(markedT, h.id, 'undecided');
  assert.equal(JSON.stringify(m.prepareConclusion(markedT)), JSON.stringify(m.prepareConclusion(t)));
  const fresh = m.applyHypotheses(analysis(), 'T1', causalSet());
  const prepared = tested(fresh, 'H1');
  assert.equal(JSON.stringify(m.prepareVerdict(m.applyUserVerdict(prepared, 'H1', 'refuted'), 'H1')), JSON.stringify(m.prepareVerdict(prepared, 'H1')));
  eq(types(marked), types(s));
});

// ---- verdict gates ------------------------------------------------------------------------------------------------------------------
test('verdict: a supported cause with a complete test is stored, with its causal state; confidence is clamped by the ceilings, never raised', () => {
  let s = tested(m.applyHypotheses(analysis(), 'T1', causalSet()), 'H1');
  const v = hOf(m.applyVerdict(s, 'H1', supportedDraft({ confidence: 'high' })), 'H1').verdict;
  assert.equal(v.value, 'supported'); assert.equal(v.by, 'ai'); assert.equal(v.causal, 'established');
  assert.equal(v.confidence, 'medium', 'one underlying source caps at medium');
  eq(v.assumptionStatus, [{ assumption: 'parallel trends', status: 'checked' }]);
  // two underlying sources and a distinguishing, pre-registered support: high is allowed
  let two = m.applyHypotheses(analysis(), 'T1', causalSet());
  two = m.applyNeeds(two, 'H1', [{ id: 'H1-n1', predictionId: 'H1-s', text: 'a', criteria: crit }, { id: 'H1-n2', predictionId: 'H1-r', text: 'b', criteria: crit }]);
  two = researched(researched(two, 'H1', 'H1-n1'), 'H1', 'H1-n2');
  two = assessAll(two, 'H1', [{ needId: 'H1-n1', assessment: assessment({ underlyingSource: 'BLS' }) }, { needId: 'H1-n2', assessment: assessment({ underlyingSource: 'OECD' }) }]);
  assert.equal(hOf(m.applyVerdict(two, 'H1', supportedDraft({ citedNeeds: ['H1-n1', 'H1-n2'], confidence: 'high' })), 'H1').verdict.confidence, 'high');
  assert.equal(hOf(m.applyVerdict(two, 'H1', supportedDraft({ citedNeeds: ['H1-n1', 'H1-n2'], confidence: 'low' })), 'H1').verdict.confidence, 'low');
  // a conditional cause cannot be high even with two sources
  assert.equal(hOf(m.applyVerdict(two, 'H1', defended({ citedNeeds: ['H1-n1', 'H1-n2'], confidence: 'high' })), 'H1').verdict.confidence, 'medium');
  refuses(s, () => m.applyVerdict(s, 'H1', supportedDraft({ confidence: 'sure' })));
  valid(m.applyVerdict(s, 'H1', supportedDraft()));
});
test('counterexample AI 給 insufficient 被拒: only the program can; unknown values, a missing draft and a duplicate verdict are refused', () => {
  const s = tested(m.applyHypotheses(analysis(), 'T1', causalSet()), 'H1');
  refuses(s, () => m.applyVerdict(s, 'H1', supportedDraft({ value: 'insufficient', causal: 'not_applicable', assumptionStatus: [] })));
  refuses(s, () => m.applyVerdict(s, 'H1', supportedDraft({ value: 'maybe' })));
  refuses(s, () => m.applyVerdict(s, 'H1', undefined));
  refuses(s, () => m.applyVerdict(s, 'ghost', supportedDraft()));
  const after = m.applyVerdict(s, 'H1', supportedDraft());
  refuses(after, () => m.applyVerdict(after, 'H1', undecidedDraft()));
});
test('counterexample 判定越界: evidence ids outside the hypothesis, numbers and URLs that are not in the input are not adopted', () => {
  let s = m.applyHypotheses(analysis(), 'T1', causalSet());
  s = tested(tested(s, 'H1'), 'H2');
  refuses(s, () => m.applyVerdict(s, 'H1', supportedDraft({ citedNeeds: ['H1-n1', 'H2-n1'] })));
  refuses(s, () => m.applyVerdict(s, 'H1', supportedDraft({ citedNeeds: ['ghost'] })));
  refuses(s, () => m.applyVerdict(s, 'H1', supportedDraft({ citedNeeds: ['H1-n1', 'H1-n1'] })));
  refuses(s, () => m.applyVerdict(s, 'H1', supportedDraft({ reason: 'unemployment rose 37 percent' })));
  refuses(s, () => m.applyVerdict(s, 'H1', supportedDraft({ reason: 'see https://evil.example/x for details' })));
  refuses(s, () => m.applyVerdict(s, 'H1', supportedDraft({ reason: '  ' })));
  // a number the input does carry (a quote's number) is fine
  assert.equal(hOf(m.applyVerdict(s, 'H1', supportedDraft({ reason: `${hOf(s, 'H1').needs[0].proof.quote} agrees` })), 'H1').verdict.value, 'supported');
  // evidence that is not checked, relevant and in scope cannot be cited
  let u = tested(m.applyHypotheses(analysis(), 'T1', causalSet()), 'H1', { check: 'unverified_quote' });
  refuses(u, () => m.applyVerdict(u, 'H1', supportedDraft()));
});
test('counterexample 判定越界: no distinguishing support, no complete test, or no data for a refute prediction cannot be supported', () => {
  const shared = hyp('H1', 'primary', { predictions: [pred('H1-s', 'support', { required: true, alsoPredictedBy: [{ hypothesisId: 'H2', strength: 'same' }] }), pred('H1-r', 'refute')] });
  let s = m.applyHypotheses(analysis(), 'T1', [hyp('H2', 'alternative'), shared, hyp('H3', 'reverse')]);
  s = tested(s, 'H1');
  refuses(s, () => m.applyVerdict(s, 'H1', supportedDraft()));
  // undecided is the honest answer there
  assert.equal(hOf(m.applyVerdict(s, 'H1', undecidedDraft()), 'H1').verdict.value, 'undecided');
  // a weaker overlap still distinguishes
  const weaker = hyp('H1', 'primary', { predictions: [pred('H1-s', 'support', { required: true, alsoPredictedBy: [{ hypothesisId: 'H2', strength: 'weaker' }] }), pred('H1-r', 'refute')] });
  let w = tested(m.applyHypotheses(analysis(), 'T1', [hyp('H2', 'alternative'), weaker, hyp('H3', 'reverse')]), 'H1');
  assert.equal(hOf(m.applyVerdict(w, 'H1', supportedDraft()), 'H1').verdict.value, 'supported');
  // test not complete: only a refutation may be given
  let p = m.applyNeeds(m.applyHypotheses(analysis(), 'T1', causalSet()), 'H1', [{ id: 'H1-n1', predictionId: 'H1-s', text: 'a', criteria: crit }]);
  refuses(p, () => m.applyVerdict(p, 'H1', supportedDraft()));
  refuses(p, () => m.applyVerdict(p, 'H1', undecidedDraft()));
  // one required test met, another required test still open: not complete, so not supported (even with a distinguishing support in hand)
  const two = hyp('H1', 'primary', { predictions: [pred('H1-s', 'support', { required: true }), pred('H1-s2', 'support', { required: true }), pred('H1-r', 'refute')] });
  let part = m.applyNeeds(m.applyHypotheses(analysis(), 'T1', [two, hyp('H2', 'alternative'), hyp('H3', 'reverse')]), 'H1', [{ id: 'H1-n1', predictionId: 'H1-s', text: 'a', criteria: crit }, { id: 'H1-n2', predictionId: 'H1-r', text: 'b', criteria: crit }, { id: 'H1-n3', predictionId: 'H1-s2', text: 'c', criteria: crit }]);
  part = assessAll(researched(researched(researched(part, 'H1', 'H1-n1'), 'H1', 'H1-n2'), 'H1', 'H1-n3', { found: false, reason: 'none' }), 'H1', [{ needId: 'H1-n1', assessment: assessment() }, { needId: 'H1-n2', assessment: assessment() }]);
  assert.notEqual(m.testStatus(hOf(part, 'H1')), 'complete');
  refuses(part, () => m.applyVerdict(part, 'H1', supportedDraft()));
  // a refute prediction without data
  const noRefuteData = m.applyHypotheses(analysis(), 'T1', causalSet());
  let n = m.applyNeeds(noRefuteData, 'H1', [{ id: 'H1-n1', predictionId: 'H1-s', text: 'a', criteria: crit }]);
  n = assessAll(researched(n, 'H1', 'H1-n1'), 'H1', [{ needId: 'H1-n1', assessment: assessment() }]);
  assert.equal(m.testStatus(hOf(n, 'H1')), 'complete');
  refuses(n, () => m.applyVerdict(n, 'H1', supportedDraft()));
});
test('counterexample F5 條件式反駁: a conditional refutation (an auxiliary premise that does not hold) cannot be refuted, cannot be supported, only undecided', () => {
  // P2 is insufficient, so the refute prediction leans on a premise that is not established
  const set = [hyp('H1', 'primary', { predictions: [pred('H1-s', 'support', { required: true }), pred('H1-r', 'refute', { auxiliary: ['P2'] })] }), hyp('H2', 'alternative'), hyp('H3', 'reverse')];
  let s = tested(m.applyHypotheses(analysis(undefined, 'insufficient'), 'T1', set), 'H1', { stance: 'refutes' });
  const cond = { needId: 'H1-n2', class: 'conditional', auxiliary: ['P2'] };
  const body = { citedNeeds: ['H1-n2'], counterNotes: ['holds only if the premise holds'], refutations: [cond] };
  // decisive with a premise that is not established is refused; refuted needs a decisive refutation
  refuses(s, () => m.applyVerdict(s, 'H1', { ...refutedDraft('H1'), refutations: [{ needId: 'H1-n2', class: 'decisive', auxiliary: ['P2'] }] }));
  refuses(s, () => m.applyVerdict(s, 'H1', { ...refutedDraft('H1'), ...body }));
  refuses(s, () => m.applyVerdict(s, 'H1', supportedDraft({ ...body, citedNeeds: ['H1-n1', 'H1-n2'] })));
  const v = hOf(m.applyVerdict(s, 'H1', { ...undecidedDraft(), ...body }), 'H1').verdict;
  assert.equal(v.value, 'undecided');
  eq(v.refutations, [cond]);
  // the conditional refutation must name the prediction's auxiliary premises
  refuses(s, () => m.applyVerdict(s, 'H1', { ...undecidedDraft(), ...body, refutations: [{ ...cond, auxiliary: ['P1'] }] }));
  valid(m.applyVerdict(s, 'H1', { ...undecidedDraft(), ...body }));
});
test('counterexample 判定越界: a decisive refutation must be pre-registered, hold its premises, be cited, and every counter-evidence needs a classification and a note', () => {
  // exploratory (post) evidence cannot be decisive
  let s = m.applyHypotheses(analysis(), 'T1', causalSet());
  s = m.applyNeeds(s, 'H1', [{ id: 'H1-n1', predictionId: 'H1-s', text: 'a', criteria: crit }]);
  s = researched(s, 'H1', 'H1-n1', { found: false, reason: 'none' });
  s = m.startNextRound(s, 'H1', [{ id: 'H1-x', predictionId: 'H1-r', text: 'exploring', criteria: crit }]);
  s = assessAll(researched(s, 'H1', 'H1-x'), 'H1', [{ needId: 'H1-x', assessment: assessment({ stance: 'refutes' }) }]);
  assert.equal(hOf(s, 'H1').needs.find(n => n.id === 'H1-x').registered, 'post');
  const post = { value: 'refuted', reason: 'exploration says no', citedNeeds: ['H1-x'], counterNotes: ['note'], refutations: [{ needId: 'H1-x', class: 'decisive', auxiliary: ['P1'] }], causal: 'not_applicable', assumptionStatus: [], confidence: 'low' };
  refuses(s, () => m.applyVerdict(s, 'H1', post));
  // pre-registered refuting evidence: the decisive refutation is accepted and stored; the program flags it
  const r = tested(m.applyHypotheses(analysis(), 'T1', causalSet()), 'H1', { stance: 'refutes' });
  assert.equal(hOf(m.applyVerdict(r, 'H1', refutedDraft('H1')), 'H1').verdict.value, 'refuted');
  refuses(r, () => m.applyVerdict(r, 'H1', { ...refutedDraft('H1'), citedNeeds: ['H1-n1'] }));                         // decisive not cited
  refuses(r, () => m.applyVerdict(r, 'H1', { ...refutedDraft('H1'), refutations: [], counterNotes: [] }));              // counter-evidence unanswered
  refuses(r, () => m.applyVerdict(r, 'H1', { ...refutedDraft('H1'), counterNotes: [] }));                               // no note
  refuses(r, () => m.applyVerdict(r, 'H1', { ...refutedDraft('H1'), counterNotes: ['a', 'b'] }));                       // notes and refutations are one to one
  refuses(r, () => m.applyVerdict(r, 'H1', { ...refutedDraft('H1'), refutations: [{ needId: 'H1-n2', class: 'decisive', auxiliary: [] }] }));
  refuses(r, () => m.applyVerdict(r, 'H1', { ...refutedDraft('H1'), refutations: [{ needId: 'H1-n2', class: 'wild', auxiliary: ['P1'] }] }));
  refuses(r, () => m.applyVerdict(r, 'H1', { ...refutedDraft('H1'), refutations: [{ needId: 'H1-n1', class: 'decisive', auxiliary: ['P1'] }] })); // not counter-evidence
  refuses(r, () => m.applyVerdict(r, 'H1', { ...refutedDraft('H1'), value: 'undecided' }));                             // a decisive refutation forces refuted
  refuses(r, () => m.applyVerdict(r, 'H1', { ...refutedDraft('H1'), value: 'supported' }));
  // a non-decisive classification of the same evidence leaves the cause supported-capable only when the test allows it
  const soft = { ...refutedDraft('H1'), value: 'undecided', refutations: [{ needId: 'H1-n2', class: 'nondecisive', auxiliary: [] }] };
  assert.equal(hOf(m.applyVerdict(r, 'H1', soft), 'H1').verdict.value, 'undecided');
  refuses(r, () => m.applyVerdict(r, 'H1', { ...soft, refutations: [{ needId: 'H1-n2', class: 'nondecisive', auxiliary: ['P1'] }] }));
});
test('counterexample 因果越界: causal status follows the identification assumptions; a non-supported hypothesis has no causal state', () => {
  const s = tested(m.applyHypotheses(analysis(), 'T1', causalSet()), 'H1');
  const unchecked = [{ assumption: 'parallel trends', status: 'unchecked' }];
  refuses(s, () => m.applyVerdict(s, 'H1', supportedDraft({ assumptionStatus: unchecked })));                          // established needs all checked
  refuses(s, () => m.applyVerdict(s, 'H1', supportedDraft({ causal: 'conditional' })));                                 // conditional needs an open assumption
  refuses(s, () => m.applyVerdict(s, 'H1', supportedDraft({ causal: 'conditional', assumptionStatus: unchecked })));    // ... with a defense
  refuses(s, () => m.applyVerdict(s, 'H1', supportedDraft({ causal: 'not_applicable' })));
  refuses(s, () => m.applyVerdict(s, 'H1', supportedDraft({ assumptionStatus: [] })));
  refuses(s, () => m.applyVerdict(s, 'H1', supportedDraft({ assumptionStatus: [{ assumption: 'something else', status: 'checked' }] })));
  refuses(s, () => m.applyVerdict(s, 'H1', supportedDraft({ causal: 'conditional', assumptionStatus: [{ assumption: 'parallel trends', status: 'defended', defense: ' ' }] })));
  refuses(s, () => m.applyVerdict(s, 'H1', { ...undecidedDraft(), causal: 'established' }));
  assert.equal(hOf(m.applyVerdict(s, 'H1', defended()), 'H1').verdict.causal, 'conditional');
  assert.equal(hOf(m.applyVerdict(s, 'H1', supportedDraft({ causal: 'compatible', assumptionStatus: unchecked })), 'H1').verdict.causal, 'compatible');
});
test('a hypothesis that was judged cannot be judged again, by the AI or the program (a late duplicate result)', () => {
  let s = m.applyHypotheses(analysis(), 'T1', causalSet());
  s = tested(s, 'H1');
  s = m.applyVerdict(s, 'H1', supportedDraft());
  refuses(s, () => m.applyVerdict(s, 'H1', refutedDraft('H1')));
  const lim = plain(m.applyHypotheses(analysis(), 'T1', causalSet())); lim.run.researchCalls = model.MAX_RESEARCH_CALLS;
  const p = m.applyProgramVerdict(lim, 'H1');
  refuses(p, () => m.applyProgramVerdict(p, 'H1'));
  refuses(p, () => m.applyVerdict(p, 'H1', undecidedDraft()));
});
test('counterexample 到上限: at the research limit the AI giving undecided is stored as insufficient by the program, a decisive refutation still refutes', () => {
  let s = m.applyHypotheses(analysis(), 'T1', causalSet());
  s = m.applyNeeds(s, 'H1', [{ id: 'H1-n1', predictionId: 'H1-s', text: 'a', criteria: crit }, { id: 'H1-n2', predictionId: 'H1-r', text: 'b', criteria: crit }]);
  s = researched(s, 'H1', 'H1-n1', { found: false, reason: 'none' });
  s = assessAll(researched(s, 'H1', 'H1-n2'), 'H1', [{ needId: 'H1-n2', assessment: assessment({ stance: 'refutes' }) }]);
  s = plain(s); s.run.researchCalls = model.MAX_RESEARCH_CALLS;
  eq(plain(m.nextActions(s)).filter(a => a.hypothesisId === 'H1'), [{ type: 'verdict', hypothesisId: 'H1' }]);
  const soft = { ...undecidedDraft(), counterNotes: ['note'], refutations: [{ needId: 'H1-n2', class: 'nondecisive', auxiliary: [] }] };
  const v = hOf(m.applyVerdict(s, 'H1', soft), 'H1').verdict;
  assert.equal(v.value, 'insufficient'); assert.equal(v.by, 'program'); assert.equal(v.confidence, 'low');
  refuses(s, () => m.applyVerdict(s, 'H1', supportedDraft({ citedNeeds: ['H1-n2'] })));
  assert.equal(hOf(m.applyVerdict(s, 'H1', refutedDraft('H1')), 'H1').verdict.value, 'refuted');
});

// ---- comparison and veto ------------------------------------------------------------------------------------------------------------
test('comparison is offered once every hypothesis of the claim has a verdict, and the phase follows: analysis, comparison, conclusion', () => {
  let s = m.applyHypotheses(m.applyHypotheses(analysis(), 'T1', causalSet()), 'T2', [facet('F1'), facet('F2')]);
  assert.equal(s.run.phase, 'analysis');
  s = judged(s, 'H1', {}, supportedDraft());
  assert.ok(!types(s).includes('compare'));
  refuses(s, () => m.applyComparison(s, 'T1', done('causal_established')));
  s = judged(s, 'H2', { stance: 'refutes' }, refutedDraft('H2'));
  s = judged(s, 'H3', { stance: 'refutes' }, refutedDraft('H3'));
  eq(plain(m.nextActions(s)).filter(a => a.type === 'compare'), [{ type: 'compare', claimId: 'T1' }]);
  assert.equal(s.run.phase, 'analysis', 'T2 still has work');
  s = judged(judged(s, 'F1', {}, factSupported('F1')), 'F2', {}, factSupported('F2'));
  assert.equal(s.run.phase, 'comparison');
  const t1 = m.applyComparison(s, 'T1', done('causal_established'));
  assert.equal(cOf(t1, 'T1').comparison.state, 'done');
  assert.equal(t1.run.phase, 'comparison');
  assert.ok(!types(t1).includes('conclude'));
  const both = m.applyComparison(t1, 'T2', done('holds'));
  assert.equal(both.run.phase, 'conclusion');
  eq(plain(m.nextActions(both)), [{ type: 'conclude' }]);
  valid(both);
});
test('counterexample 結案越界: a hypothesis without a verdict, or a comparison that is vetoed and unresolved, never reaches the conclusion', () => {
  const s = allJudged();
  // missing verdict: the claim cannot be compared and the conclusion is not due
  let missing = m.applyHypotheses(m.applyHypotheses(analysis(), 'T1', causalSet()), 'T2', [facet('F1'), facet('F2')]);
  missing = judged(judged(missing, 'F1', {}, factSupported('F1')), 'F2', {}, factSupported('F2'));
  missing = m.applyComparison(missing, 'T2', done('holds'));
  assert.notEqual(missing.run.phase, 'conclusion');
  assert.ok(!types(missing).includes('conclude'));
  refuses(missing, () => m.applyConclusion(missing, { answers: answersOf() }));
  // vetoed and owing a late alternative: still not the conclusion
  const veto = m.applyComparison(s, 'T1', { decision: 'add_alternative', vetoes: [{ kind: 'missed_alternative', detail: 'a cause of H1 was not listed' }], allocations: [], answer: 'insufficient' });
  assert.equal(cOf(veto, 'T1').comparison.state, 'vetoed');
  let v = m.applyComparison(veto, 'T2', done('holds'));
  assert.notEqual(v.run.phase, 'conclusion');
  assert.ok(!types(v).includes('conclude'));
  refuses(v, () => m.applyConclusion(v, { answers: answersOf() }));
  eq(plain(m.nextActions(v)).filter(a => a.claimId === 'T1'), [{ type: 'propose_alternatives', claimId: 'T1' }]);
  // analysis phase: nothing concludes
  refuses(s, () => m.applyConclusion(s, { answers: answersOf() }));
});
test('counterexample 否決未解卻給肯定答案被拒: a veto never lets a positive answer through the comparison or the conclusion', () => {
  const s = allJudged();
  const vetoed = { vetoes: [{ kind: 'contradiction', detail: 'H1 and H2 cannot both hold' }], allocations: [] };
  // a veto with the positive answer: the answer is not adopted, the claim is sent back
  refuses(s, () => m.applyComparison(s, 'T1', { ...vetoed, decision: 'complete', answer: 'causal_established' }));
  const back = m.applyComparison(s, 'T1', { ...vetoed, decision: 'rejudge', rejudge: ['H1'], answer: 'causal_established' });
  assert.equal(cOf(back, 'T1').comparison.state, 'vetoed');
  assert.equal(cOf(back, 'T1').comparison.answer, undefined);
  // undecidable: only the undecidable answer is accepted at the conclusion
  const und = m.applyComparison(m.applyComparison(s, 'T2', done('holds')), 'T1', { ...vetoed, decision: 'undecidable' });
  assert.equal(cOf(und, 'T1').comparison.state, 'undecidable');
  assert.equal(cOf(und, 'T1').comparison.answer, 'insufficient');
  assert.equal(und.run.phase, 'conclusion');
  refuses(und, () => m.applyConclusion(und, { answers: answersOf() }));
  const ok = m.applyConclusion(und, { answers: [{ claimId: 'T1', answer: 'insufficient', sentence: 'The causes could not be told apart.', assumptions: [] }, answersOf()[1]] });
  assert.equal(ok.run.phase, 'inference_check');
  // the answer must also fit the verdicts: holds with a refuted facet, a cause answer that does not match
  refuses(s, () => m.applyComparison(s, 'T1', done('causal_conditional')));
  refuses(s, () => m.applyComparison(s, 'T1', done('causal_compatible')));
  refuses(s, () => m.applyComparison(s, 'T1', done('causal_against')));
  refuses(s, () => m.applyComparison(s, 'T1', done('holds')));
  refuses(s, () => m.applyComparison(s, 'T1', done('nonsense')));
  refuses(s, () => m.applyComparison(s, 'T1', done('main_cause_largest')));
  refuses(s, () => m.applyComparison(s, 'T1', { ...done('causal_established'), contributors: ['H1'] }));
  refuses(s, () => m.applyComparison(s, 'T1', { decision: 'complete', vetoes: [], allocations: [] }));
  refuses(s, () => m.applyComparison(s, 'T1', { ...done('causal_established'), decision: 'whatever' }));
  refuses(s, () => m.applyComparison(s, 'T1', { ...done('causal_established'), vetoes: [{ kind: 'bogus', detail: 'x' }] }));
});
test('counterexample 第 2 次比較仍否決→undecidable: the first veto sends hypotheses back once, the second ends the claim', () => {
  const s = allJudged();
  const veto = { vetoes: [{ kind: 'contradiction', detail: 'H1 and H2 cannot both hold' }], allocations: [] };
  const first = m.applyComparison(s, 'T1', { ...veto, decision: 'rejudge', rejudge: ['H1'], answer: 'insufficient' });
  const c1 = cOf(first, 'T1').comparison;
  assert.equal(c1.state, 'vetoed'); assert.equal(c1.attempts, 1);
  assert.equal(hOf(first, 'H1').verdict, undefined, 'the verdict is cleared in the same write');
  assert.equal(hOf(first, 'H1').reverdicts, 1);
  assert.equal(hOf(first, 'H2').reverdicts ?? 0, 0);
  assert.ok(!plain(m.nextActions(first)).some(a => a.type === 'compare' && a.claimId === 'T1'));
  eq(plain(m.nextActions(first)).filter(a => a.claimId === 'T1' || a.hypothesisId === 'H1').map(a => a.type), ['verdict']);
  assert.equal(first.run.phase, 'analysis');
  const again = m.applyVerdict(first, 'H1', supportedDraft());
  eq(plain(m.nextActions(again)).filter(a => a.type === 'compare' && a.claimId === 'T1'), [{ type: 'compare', claimId: 'T1' }]);
  // a second comparison that still vetoes: undecidable, whatever the remedy asked for
  for (const decision of ['rejudge', 'add_alternative', 'complete', 'undecidable']) {
    const last = m.applyComparison(again, 'T1', { decision, rejudge: ['H2'], vetoes: [{ kind: 'missed_alternative', detail: 'still a gap' }], allocations: [], answer: 'causal_established' });
    const c = cOf(last, 'T1').comparison;
    assert.equal(c.state, 'undecidable', decision); assert.equal(c.answer, 'insufficient'); assert.equal(c.attempts, 2);
    assert.ok(c.vetoes.some(v => !v.resolved), 'the last veto stays open');
    assert.ok(!plain(m.nextActions(last)).some(a => a.type === 'compare' && a.claimId === 'T1'));
    valid(last);
  }
  // a hypothesis is sent back at most once: H1 was, H1 again is refused (first comparison used up; here via a fresh state with reverdicts 1)
  const spent = plain(s); hOf(spent, 'H1').reverdicts = 1;
  refuses(spent, () => m.applyComparison(spent, 'T1', { ...veto, decision: 'rejudge', rejudge: ['H1'], answer: 'insufficient' }));
  refuses(s, () => m.applyComparison(s, 'T1', { ...veto, decision: 'rejudge', rejudge: ['ghost'], answer: 'insufficient' }));
  refuses(s, () => m.applyComparison(s, 'T1', { ...veto, decision: 'rejudge', rejudge: [], answer: 'insufficient' }));
  // a program verdict is not sent back (the AI never judged it)
  const prog = plain(s); hOf(prog, 'H2').verdict = { ...hOf(prog, 'H2').verdict, by: 'program', value: 'insufficient', causal: 'not_applicable' };
  refuses(prog, () => m.applyComparison(prog, 'T1', { ...veto, decision: 'rejudge', rejudge: ['H2'], answer: 'insufficient' }));
});
test('a comparison that finds an unanswered allocated counter-evidence adds its own veto and sends that hypothesis back; the new verdict must answer it', () => {
  let s = m.applyHypotheses(m.applyHypotheses(analysis(), 'T1', causalSet()), 'T2', [facet('F1'), facet('F2')]);
  s = judged(s, 'H1', {}, supportedDraft());
  s = judged(s, 'H2', { stance: 'refutes', also: ['H1'] }, refutedDraft('H2'));
  s = judged(s, 'H3', { stance: 'refutes' }, refutedDraft('H3'));
  // an allocation must be real: refuting, checked, marked relevant to the target, not the hypothesis' own
  refuses(s, () => m.applyComparison(s, 'T1', done('causal_established', { allocations: [{ needId: 'H3-n2', hypothesisId: 'H1' }] })));
  refuses(s, () => m.applyComparison(s, 'T1', done('causal_established', { allocations: [{ needId: 'H2-n2', hypothesisId: 'H2' }] })));
  refuses(s, () => m.applyComparison(s, 'T1', done('causal_established', { allocations: [{ needId: 'H2-n1', hypothesisId: 'H1' }] })));
  refuses(s, () => m.applyComparison(s, 'T1', done('causal_established', { allocations: [{ needId: 'H2-n2', hypothesisId: 'F1' }] })));
  const back = m.applyComparison(s, 'T1', done('causal_established', { allocations: [{ needId: 'H2-n2', hypothesisId: 'H1' }] }));
  const c = cOf(back, 'T1').comparison;
  assert.equal(c.state, 'vetoed');
  assert.ok(c.vetoes.some(v => v.kind === 'unhandled_counter'));
  assert.equal(hOf(back, 'H1').verdict, undefined);
  assert.equal(hOf(back, 'H1').reverdicts, 1);
  eq(plain(m.prepareVerdict(back, 'H1').counterEvidence), ['H2-n2']);
  // the new verdict has to answer it, and may then be supported (a non-decisive counter) and the second comparison completes
  const bare = supportedDraft();
  refuses(back, () => m.applyVerdict(back, 'H1', bare));
  const answered = supportedDraft({ counterNotes: ['the other cause is weaker evidence'], refutations: [{ needId: 'H2-n2', class: 'nondecisive', auxiliary: [] }] });
  const again = m.applyVerdict(back, 'H1', answered);
  const fin = m.applyComparison(again, 'T1', done('causal_established'));
  assert.equal(cOf(fin, 'T1').comparison.state, 'done');
  assert.equal(cOf(fin, 'T1').comparison.attempts, 2);
  // a conditional or decisive refutation cannot come from another hypothesis' evidence
  refuses(back, () => m.applyVerdict(back, 'H1', { ...undecidedDraft(), counterNotes: ['n'], refutations: [{ needId: 'H2-n2', class: 'decisive', auxiliary: ['P1'] }] }));
  valid(fin);
});
test('counterexample 補替代假設第二批: one late batch per claim, new roles only, addedAfterComparison, its needs pre-registered, and the next comparison is the last', () => {
  const s = allJudged();
  const veto = { decision: 'add_alternative', vetoes: [{ kind: 'missed_alternative', detail: 'a policy change was not listed' }], allocations: [], answer: 'insufficient' };
  const v = m.applyComparison(s, 'T1', veto);
  eq(plain(m.nextActions(v)).filter(a => a.claimId === 'T1'), [{ type: 'propose_alternatives', claimId: 'T1' }]);
  assert.equal(v.run.phase, 'analysis');
  refuses(s, () => m.applyAlternativeHypotheses(s, 'T1', [hyp('H4', 'alternative')]));       // no veto owes it
  const late = [hyp('H4', 'alternative', { predictions: [pred('H4-s', 'support', { required: true, alsoPredictedBy: [{ hypothesisId: 'H1', strength: 'weaker' }] }), pred('H4-r', 'refute')] })];
  refuses(v, () => m.applyAlternativeHypotheses(v, 'T1', []));
  refuses(v, () => m.applyAlternativeHypotheses(v, 'T1', [hyp('H4', 'primary')]));
  refuses(v, () => m.applyAlternativeHypotheses(v, 'T1', [hyp('H4', 'facet', { identification: undefined })]));
  refuses(v, () => m.applyAlternativeHypotheses(v, 'T1', [hyp('H1', 'alternative')]));        // duplicate id
  refuses(v, () => m.applyAlternativeHypotheses(v, 'T2', late));
  const w = m.applyAlternativeHypotheses(v, 'T1', late);
  const h4 = hOf(w, 'H4');
  assert.equal(h4.addedAfterComparison, true);
  assert.equal(h4.round, 1);
  assert.equal(hOf(w, 'H1').addedAfterComparison, undefined);
  assert.equal(cOf(w, 'T1').comparison.missedAlternativeAdded, true);
  assert.ok(cOf(w, 'T1').comparison.vetoes.every(x => x.resolved));
  eq(plain(m.nextActions(w)).filter(a => a.hypothesisId === 'H4'), [{ type: 'add_needs', hypothesisId: 'H4' }]);
  assert.ok(!plain(m.nextActions(w)).some(a => a.type === 'compare' && a.claimId === 'T1'), 'the new hypothesis still needs its verdict');
  const roomy = plain(w); roomy.hypotheses = roomy.hypotheses.filter(h => h.id !== 'F2');
  refuses(roomy, () => m.applyAlternativeHypotheses(roomy, 'T1', [hyp('H5', 'alternative')]));  // once, even with room under the cap
  // its needs are pre-registered like any first needs
  let n = tested(w, 'H4');
  assert.ok(hOf(n, 'H4').needs.every(x => x.registered === 'pre'));
  n = m.applyVerdict(n, 'H4', undecidedDraft());
  eq(plain(m.nextActions(n)).filter(a => a.type === 'compare' && a.claimId === 'T1'), [{ type: 'compare', claimId: 'T1' }]);
  assert.equal(JSON.parse(JSON.stringify(m.prepareComparison(n, 'T1'))).hypotheses.find(h => h.id === 'H4').addedAfterComparison, true);
  eq(plain(m.prepareComparison(n, 'T1').comparison.room), { lastAttempt: true, canAddAlternative: false, canSendBack: ['H1', 'H2', 'H3', 'H4'].filter(id => (hOf(n, id).reverdicts ?? 0) < 1) });
  valid(n);
});
test('late alternatives respect the 6-hypothesis cap and need a missed_alternative veto from the AI', () => {
  const s = allJudged();
  refuses(s, () => m.applyComparison(s, 'T1', { decision: 'add_alternative', vetoes: [{ kind: 'contradiction', detail: 'x' }], allocations: [], answer: 'insufficient' }));
  const capped = plain(s); capped.hypotheses = capped.hypotheses.filter(h => h.id !== 'F2'); capped.hypotheses.push({ ...plain(hOf(s, 'F1')), id: 'F9', predictions: [], needs: [] }, { ...plain(hOf(s, 'F1')), id: 'F8', predictions: [], needs: [] });
  assert.equal(capped.hypotheses.length, 6);
  // no room: the request is refused (the input says canAddAlternative is false); giving up is the legal way out
  assert.equal(plain(m.prepareComparison(capped, 'T1')).comparison.room.canAddAlternative, false);
  refuses(capped, () => m.applyComparison(capped, 'T1', { decision: 'add_alternative', vetoes: [{ kind: 'missed_alternative', detail: 'x' }], allocations: [], answer: 'insufficient' }));
  const out = m.applyComparison(capped, 'T1', { decision: 'undecidable', vetoes: [{ kind: 'missed_alternative', detail: 'x' }], allocations: [], answer: 'insufficient' });
  assert.equal(cOf(out, 'T1').comparison.state, 'undecidable');
});

// ---- main cause (F6) --------------------------------------------------------------------------------------------------------------
/** T1 is a main-cause claim; H1 is established, H2 conditional, H3 only compatible (all supported), or H3 refuted. */
function mainCause(h3 = 'compatible') {
  let s = m.applyHypotheses(analysis(claimDrafts('main_cause')), 'T1', causalSet());
  s = judged(s, 'H1', {}, supportedDraft());
  s = judged(s, 'H2', {}, defended({ citedNeeds: ['H2-n1'] }));
  s = h3 === 'compatible'
    ? judged(s, 'H3', {}, supportedDraft({ citedNeeds: ['H3-n1'], causal: 'compatible', assumptionStatus: [{ assumption: 'parallel trends', status: 'unchecked' }] }))
    : judged(s, 'H3', { stance: 'refutes' }, refutedDraft('H3'));
  return s;
}
const rank = (answer, over = {}) => done(answer, { contributors: ['H1', 'H2'], largest: 'H1', basis: 'difference_with_uncertainty', ...over });
test('counterexample F6 因果越界: a cause that is only compatible cannot enter the main-cause comparison', () => {
  const s = mainCause('compatible');
  refuses(s, () => m.applyComparison(s, 'T1', rank('main_cause_undecidable', { contributors: ['H1', 'H3'] })));
  refuses(s, () => m.applyComparison(s, 'T1', rank('main_cause_undecidable', { contributors: ['H1', 'H1'] })));
  refuses(s, () => m.applyComparison(s, 'T1', rank('main_cause_undecidable', { contributors: ['H1', 'F1'] })));
  refuses(s, () => m.applyComparison(s, 'T1', rank('main_cause_undecidable', { largest: 'H3' })));
  refuses(s, () => m.applyComparison(s, 'T1', rank('main_cause_undecidable', { basis: 'guess' })));
});
test('counterexample F6 主因子集逐一點名: with an incomplete candidate set only "cannot tell the order" is allowed, and the sentence names every compared candidate', () => {
  const s = mainCause('compatible');
  // the compatible H3 is not refuted, so the candidate set is incomplete: no ranking answer
  for (const answer of ['main_cause_largest', 'main_cause_secondary']) refuses(s, () => m.applyComparison(s, 'T1', rank(answer)));
  refuses(s, () => m.applyComparison(s, 'T1', done('main_cause_not')));
  refuses(s, () => m.applyComparison(s, 'T1', { ...done('main_cause_undecidable'), largest: 'H1', contributors: ['H1', 'H2'], basis: 'point_estimates' }));
  refuses(s, () => m.applyComparison(s, 'T1', { ...done('main_cause_undecidable'), largest: 'H1', contributors: ['H1'], basis: 'difference_with_uncertainty' }));
  refuses(s, () => m.applyComparison(s, 'T1', done('main_cause_undecidable', { contributors: ['H1', 'H2'], largest: 'H1' })));  // a subset result states its basis
  refuses(s, () => m.applyComparison(s, 'T1', done('causal_established')));
  const c = cOf(m.applyComparison(s, 'T1', rank('main_cause_undecidable')), 'T1').comparison;
  assert.equal(c.answer, 'main_cause_undecidable'); eq(c.contributors, ['H1', 'H2']); assert.equal(c.largest, 'H1'); assert.equal(c.basis, 'difference_with_uncertainty');
  // the whole-set answer: undecidable without a ranking
  assert.equal(cOf(m.applyComparison(s, 'T1', done('main_cause_undecidable')), 'T1').comparison.answer, 'main_cause_undecidable');
  // the conclusion: each compared candidate is named, the conditional contributor's assumption is written into the sentence
  let t = m.applyComparison(s, 'T1', rank('main_cause_undecidable'));
  const sentence = 'Among H1 and H2, H1 is larger, assuming parallel trends, but the other candidates were not compared.';
  const body = (text, assumptions = ['parallel trends']) => ({ answers: [{ claimId: 'T1', answer: 'main_cause_undecidable', sentence: text, assumptions }] });
  // finish T2 so the run reaches the conclusion
  let all = s;
  all = m.applyHypotheses(all, 'T2', [facet('F1'), facet('F2')]);
  all = judged(judged(all, 'F1', {}, factSupported('F1')), 'F2', {}, factSupported('F2'));
  all = m.applyComparison(m.applyComparison(all, 'T1', rank('main_cause_undecidable')), 'T2', done('holds'));
  assert.equal(all.run.phase, 'conclusion');
  const t2 = answersOf()[1];
  const draft = (text, assumptions) => ({ answers: [body(text, assumptions).answers[0], t2] });
  assert.ok(m.applyConclusion(all, draft(sentence)));
  refuses(all, () => m.applyConclusion(all, draft('Among H1, H1 is larger, assuming parallel trends.')));                    // H2 not named
  refuses(all, () => m.applyConclusion(all, draft('Among H1 and H2, H1 is larger.', [])));                                    // assumption missing
  refuses(all, () => m.applyConclusion(all, draft('Among H1 and H2, H1 is larger.')));                                        // listed but not in the sentence
  refuses(all, () => m.applyConclusion(all, draft('Among H1 and H2, H1 is larger, assuming parallel trends.', ['parallel trends', 'extra'])));
});
test('F6 a complete candidate set (the others refuted) allows a ranking, and the largest must be the main cause for "largest"', () => {
  const s = mainCause('refuted');
  const c = cOf(m.applyComparison(s, 'T1', rank('main_cause_largest')), 'T1').comparison;
  assert.equal(c.answer, 'main_cause_largest');
  refuses(s, () => m.applyComparison(s, 'T1', rank('main_cause_largest', { largest: 'H2' })));
  refuses(s, () => m.applyComparison(s, 'T1', rank('main_cause_secondary')));
  assert.equal(cOf(m.applyComparison(s, 'T1', rank('main_cause_secondary', { largest: 'H2' })), 'T1').comparison.answer, 'main_cause_secondary');
  refuses(s, () => m.applyComparison(s, 'T1', rank('main_cause_largest', { basis: 'point_estimates' })));                      // point estimates cannot rank
  refuses(s, () => m.applyComparison(s, 'T1', rank('main_cause_largest', { basis: 'none' })));
  refuses(s, () => m.applyComparison(s, 'T1', done('main_cause_largest', { contributors: ['H1', 'H2'], basis: 'difference_with_uncertainty' }))); // no largest named
  refuses(s, () => m.applyComparison(s, 'T1', rank('main_cause_largest', { contributors: ['H1'], largest: 'H1' })));            // needs 2 contributors
  refuses(s, () => m.applyComparison(s, 'T1', done('main_cause_not')));                                                         // the main cause was not refuted
  // a refuted main cause: "not the main cause"
  let r = m.applyHypotheses(analysis(claimDrafts('main_cause')), 'T1', causalSet());
  r = judged(r, 'H1', { stance: 'refutes' }, refutedDraft('H1'));
  r = judged(r, 'H2', {}, undecidedDraft());
  r = judged(r, 'H3', {}, undecidedDraft());
  assert.equal(cOf(m.applyComparison(r, 'T1', done('main_cause_not')), 'T1').comparison.answer, 'main_cause_not');
  refuses(r, () => m.applyComparison(r, 'T1', done('main_cause_largest')));
  // contributors on a non-main-cause claim are refused (the causal T1 in allJudged)
  const plainCause = allJudged();
  refuses(plainCause, () => m.applyComparison(plainCause, 'T1', done('causal_established', { basis: 'none' })));
});

// ---- conclusion ---------------------------------------------------------------------------------------------------------------------
test('prepareConclusion carries the locked framing, each comparison result and verdict summary, and no evidence text', () => {
  const s = toConclusion();
  const p = plain(m.prepareConclusion(s));
  assert.equal(p.framing.composition, null);
  eq(p.claims.map(c => c.id), ['T1', 'T2']);
  assert.equal(p.claims[0].comparison.answer, 'causal_established');
  const text = JSON.stringify(p);
  assert.ok(!text.includes('example.org'), 'no source url');
  assert.ok(!text.includes('quote 1'), 'no quoted page text');
  assert.ok(!text.includes('userVerdict'));
  // the assumptions a conditional answer rests on are listed for the sentence
  let c = mainCause('compatible');
  c = m.applyComparison(c, 'T1', rank('main_cause_undecidable'));
  eq(plain(m.prepareConclusion(c)).claims[0].comparison.requiredAssumptions, ['parallel trends']);
});
test('conclusion: one answer per evaluated testable claim, equal to its comparison, in the conclusion phase only', () => {
  const t = toConclusion();
  const ok = m.applyConclusion(t, { answers: answersOf() });
  assert.equal(ok.run.phase, 'inference_check'); assert.equal(ok.run.status, 'running'); assert.equal(ok.run.inferenceChecks, 0);
  assert.equal(ok.conclusion.state, 'pending'); eq(ok.conclusion.deleted, []);
  eq(ok.conclusion.answers.map(a => a.claimId), ['T1', 'T2']);
  assert.equal(ok.conclusion.overall, undefined);
  valid(ok);
  const [a, b] = answersOf();
  refuses(t, () => m.applyConclusion(t, { answers: [a] }));
  refuses(t, () => m.applyConclusion(t, { answers: [a, a] }));
  refuses(t, () => m.applyConclusion(t, { answers: [a, { ...b, claimId: 'P1' }] }));
  refuses(t, () => m.applyConclusion(t, { answers: [{ ...a, answer: 'causal_conditional' }, b] }));
  refuses(t, () => m.applyConclusion(t, { answers: [{ ...a, answer: 'bogus' }, b] }));
  refuses(t, () => m.applyConclusion(t, { answers: [a, { ...b, answer: 'fails' }] }));
  refuses(t, () => m.applyConclusion(t, { answers: [{ ...a, sentence: 'It rose 37 percent.' }, b] }));
  refuses(t, () => m.applyConclusion(t, { answers: [{ ...a, sentence: 'See https://evil.example/' }, b] }));
  refuses(t, () => m.applyConclusion(t, { answers: [{ ...a, sentence: ' ' }, b] }));
  refuses(t, () => m.applyConclusion(t, undefined));
  refuses(ok, () => m.applyConclusion(ok, { answers: answersOf() }));
});
test('counterexample 前提失敗: a stopped claim gets no answer; the conclusion covers only the evaluated claims', () => {
  let s = settlePremise(settlePremise(make(), 'P1'), 'P2', 'fails');   // T2 depends on P2 and is not evaluated
  s = m.applyHypotheses(s, 'T1', causalSet());
  s = judged(s, 'H1', {}, supportedDraft());
  s = judged(s, 'H2', { stance: 'refutes' }, refutedDraft('H2'));
  s = judged(s, 'H3', { stance: 'refutes' }, refutedDraft('H3'));
  s = m.applyComparison(s, 'T1', done('causal_established'));
  assert.equal(s.run.phase, 'conclusion');
  refuses(s, () => m.applyConclusion(s, { answers: answersOf() }));
  const ok = m.applyConclusion(s, { answers: [answersOf()[0]] });
  eq(ok.conclusion.answers.map(a => a.claimId), ['T1']);
});
test('counterexample F7 組合規則: a whole-sentence answer exists only when the locked breakdown carries a composition rule', () => {
  const t = toConclusion();
  refuses(t, () => m.applyConclusion(t, { answers: answersOf(), overall: 'The policy improves both A and B.' }));
  const withRule = (() => {
    let s = m.applyHypotheses(m.applyHypotheses(analysis(undefined, 'holds', { composition: 'every part must hold for the whole to hold' }), 'T1', causalSet()), 'T2', [facet('F1'), facet('F2')]);
    s = judged(s, 'H1', {}, supportedDraft()); s = judged(s, 'H2', { stance: 'refutes' }, refutedDraft('H2')); s = judged(s, 'H3', { stance: 'refutes' }, refutedDraft('H3'));
    s = judged(judged(s, 'F1', {}, factSupported('F1')), 'F2', {}, factSupported('F2'));
    return m.applyComparison(m.applyComparison(s, 'T1', done('causal_established')), 'T2', done('holds'));
  })();
  const ok = m.applyConclusion(withRule, { answers: answersOf(), overall: 'Both parts hold, so the whole claim holds.' });
  assert.equal(ok.conclusion.overall, 'Both parts hold, so the whole claim holds.');
  refuses(withRule, () => m.applyConclusion(withRule, { answers: answersOf(), overall: 'It rose 37 percent.' }));
  refuses(withRule, () => m.applyConclusion(withRule, { answers: answersOf(), overall: ' ' }));
  // no composition rule: the claims are reported, nothing more is stored
  assert.equal(m.applyConclusion(t, { answers: answersOf() }).conclusion.overall, undefined);
  const blankRule = plain(t); blankRule.framing.composition = '  ';
  refuses(blankRule, () => m.applyConclusion(blankRule, { answers: answersOf(), overall: 'Whole.' }));
});
test('counterexample 因果越界: an identification assumption the answer rests on must be written into the sentence itself', () => {
  let s = m.applyHypotheses(m.applyHypotheses(analysis(), 'T1', causalSet()), 'T2', [facet('F1'), facet('F2')]);
  s = judged(s, 'H1', {}, defended());
  s = judged(s, 'H2', { stance: 'refutes' }, refutedDraft('H2'));
  s = judged(s, 'H3', { stance: 'refutes' }, refutedDraft('H3'));
  s = judged(judged(s, 'F1', {}, factSupported('F1')), 'F2', {}, factSupported('F2'));
  refuses(s, () => m.applyComparison(s, 'T1', done('causal_established')));
  s = m.applyComparison(m.applyComparison(s, 'T1', done('causal_conditional')), 'T2', done('holds'));
  const t2 = answersOf()[1];
  const t1 = (sentence, assumptions = ['parallel trends']) => ({ claimId: 'T1', answer: 'causal_conditional', sentence, assumptions });
  assert.ok(m.applyConclusion(s, { answers: [t1('AI caused the rise, provided parallel trends hold.'), t2] }));
  refuses(s, () => m.applyConclusion(s, { answers: [t1('AI caused the rise.'), t2] }));                              // listed, not written into the sentence
  refuses(s, () => m.applyConclusion(s, { answers: [t1('AI caused the rise.', []), t2] }));                           // not even listed
  refuses(s, () => m.applyConclusion(s, { answers: [t1('AI caused the rise, provided parallel trends hold.', []), t2] }));
  refuses(s, () => m.applyConclusion(s, { answers: [t1('AI caused the rise, provided parallel trends hold.', ['parallel trends', 'more']), t2] }));
  // the established answer lists no assumption
  const est = toConclusion();
  refuses(est, () => m.applyConclusion(est, { answers: [{ ...answersOf()[0], assumptions: ['parallel trends'] }, answersOf()[1]] }));
});

// ---- inference check ----------------------------------------------------------------------------------------------------------------
const ok2 = () => [{ id: 'T1', status: 'ok' }, { id: 'T2', status: 'ok' }];
test('inference check: all ok at the first check ends the run concluded with one check', () => {
  const s = concluded();
  eq(plain(m.nextActions(s)), [{ type: 'inference_check' }]);
  const input = plain(m.prepareInferenceCheck(s));
  assert.equal(input.check, 1); eq(input.sentences.map(x => x.id), ['T1', 'T2']);
  const end = m.applyInferenceCheck(s, ok2());
  assert.equal(end.run.phase, 'concluded'); assert.equal(end.run.status, 'finished'); assert.equal(end.run.inferenceChecks, 1);
  assert.equal(end.conclusion.state, 'concluded');
  eq(m.nextActions(end), []);
  refuses(end, () => m.applyInferenceCheck(end, ok2()));
  valid(end);
});
test('inference check: a rewrite calls for a second check, a sentence still flagged there is deleted and kept in deleted[]', () => {
  const s = concluded();
  const mid = m.applyInferenceCheck(s, [{ id: 'T1', status: 'rewrite', rewrite: 'AI plausibly caused the rise.' }, { id: 'T2', status: 'ok' }]);
  assert.equal(mid.run.phase, 'inference_check'); assert.equal(mid.run.inferenceChecks, 1); assert.equal(mid.run.status, 'running');
  assert.equal(mid.conclusion.answers[0].sentence, 'AI plausibly caused the rise.');
  eq(plain(m.nextActions(mid)), [{ type: 'inference_check' }]);
  assert.equal(plain(m.prepareInferenceCheck(mid)).check, 2);
  // second check: flagged again (rewrite or delete) -> deleted by the program
  for (const second of [{ id: 'T1', status: 'rewrite', rewrite: 'AI caused it.' }, { id: 'T1', status: 'delete' }]) {
    const end = m.applyInferenceCheck(mid, [second, { id: 'T2', status: 'ok' }]);
    assert.equal(end.run.phase, 'concluded'); assert.equal(end.run.status, 'finished'); assert.equal(end.run.inferenceChecks, 2);
    eq(end.conclusion.deleted, ['AI plausibly caused the rise.']);
    assert.equal(end.conclusion.answers[0].sentence, '');
    assert.equal(end.conclusion.answers[1].sentence, 'Adoption is widespread.');
    valid(end);
  }
  const clean = m.applyInferenceCheck(mid, ok2());
  assert.equal(clean.run.phase, 'concluded'); eq(clean.conclusion.deleted, []);
  // a deleted sentence is no longer read
  const del = m.applyInferenceCheck(s, [{ id: 'T1', status: 'delete' }, { id: 'T2', status: 'ok' }]);
  eq(del.conclusion.deleted, ['AI caused the rise.']);
  assert.equal(del.run.phase, 'concluded', 'a deletion alone needs no second check');
  assert.equal(del.run.inferenceChecks, 1);
});
test('inference check gates: every sentence once, only ok/rewrite/delete, a rewrite passes the number and URL guard and keeps the required assumptions, nothing outside the conclusion phase', () => {
  const s = concluded();
  refuses(s, () => m.applyInferenceCheck(s, [{ id: 'T1', status: 'ok' }]));
  refuses(s, () => m.applyInferenceCheck(s, [{ id: 'T1', status: 'ok' }, { id: 'T1', status: 'ok' }]));
  refuses(s, () => m.applyInferenceCheck(s, [{ id: 'T1', status: 'ok' }, { id: 'T9', status: 'ok' }]));
  refuses(s, () => m.applyInferenceCheck(s, [{ id: 'T1', status: 'maybe' }, { id: 'T2', status: 'ok' }]));
  refuses(s, () => m.applyInferenceCheck(s, [{ id: 'T1', status: 'rewrite' }, { id: 'T2', status: 'ok' }]));
  refuses(s, () => m.applyInferenceCheck(s, [{ id: 'T1', status: 'rewrite', rewrite: 'It rose 37 percent.' }, { id: 'T2', status: 'ok' }]));
  refuses(s, () => m.applyInferenceCheck(s, [{ id: 'T1', status: 'rewrite', rewrite: 'See https://evil.example/' }, { id: 'T2', status: 'ok' }]));
  refuses(s, () => m.applyInferenceCheck(s, undefined));
  const t = toConclusion();
  refuses(t, () => m.applyInferenceCheck(t, ok2()));
  // a rewrite of a conditional answer must keep the assumption in the sentence
  let c = m.applyHypotheses(m.applyHypotheses(analysis(), 'T1', causalSet()), 'T2', [facet('F1'), facet('F2')]);
  c = judged(c, 'H1', {}, defended()); c = judged(c, 'H2', { stance: 'refutes' }, refutedDraft('H2')); c = judged(c, 'H3', { stance: 'refutes' }, refutedDraft('H3'));
  c = judged(judged(c, 'F1', {}, factSupported('F1')), 'F2', {}, factSupported('F2'));
  c = m.applyComparison(m.applyComparison(c, 'T1', done('causal_conditional')), 'T2', done('holds'));
  c = m.applyConclusion(c, { answers: [{ claimId: 'T1', answer: 'causal_conditional', sentence: 'AI caused the rise, provided parallel trends hold.', assumptions: ['parallel trends'] }, answersOf()[1]] });
  refuses(c, () => m.applyInferenceCheck(c, [{ id: 'T1', status: 'rewrite', rewrite: 'AI caused the rise.' }, { id: 'T2', status: 'ok' }]));
  assert.ok(m.applyInferenceCheck(c, [{ id: 'T1', status: 'rewrite', rewrite: 'Provided parallel trends hold, AI caused the rise.' }, { id: 'T2', status: 'ok' }]));
});
test('an undecidable claim makes the finished conclusion undecidable; overall sentence is checked like the others', () => {
  const s = allJudged();
  const und = m.applyComparison(m.applyComparison(s, 'T2', done('holds')), 'T1', { decision: 'undecidable', vetoes: [{ kind: 'contradiction', detail: 'x' }], allocations: [], answer: 'insufficient' });
  const c = m.applyConclusion(und, { answers: [{ claimId: 'T1', answer: 'insufficient', sentence: 'Not decided.', assumptions: [] }, answersOf()[1]] });
  const end = m.applyInferenceCheck(c, ok2());
  assert.equal(end.conclusion.state, 'undecidable'); assert.equal(end.run.phase, 'concluded'); assert.equal(end.run.status, 'finished');
  valid(end);
  // overall: its own rewrite and deletion
  let w = allJudged(); w = plain(w); w.framing.composition = 'rule';
  w = m.applyComparison(m.applyComparison(w, 'T1', done('causal_established')), 'T2', done('holds'));
  w = m.applyConclusion(w, { answers: answersOf(), overall: 'Both hold.' });
  eq(plain(m.prepareInferenceCheck(w)).sentences.map(x => x.id), ['T1', 'T2', 'overall']);
  const items = [...ok2(), { id: 'overall', status: 'rewrite', rewrite: 'Together they hold.' }];
  const mid = m.applyInferenceCheck(w, items);
  assert.equal(mid.conclusion.overall, 'Together they hold.');
  const end2 = m.applyInferenceCheck(mid, [...ok2(), { id: 'overall', status: 'delete' }]);
  assert.equal(end2.conclusion.overall, undefined); eq(end2.conclusion.deleted, ['Together they hold.']);
});

// ---- limits: claims that never got hypotheses ------------------------------------------------------------------------------------
test('counterexample 上限用盡時未提假設子主張: it ends undecidable with the answer insufficient, no AI call, and still reaches the conclusion', () => {
  let s = plain(analysis());
  s.run.researchCalls = model.MAX_RESEARCH_CALLS;
  const calls = s.run.researchCalls;
  eq(plain(m.nextActions(s)).map(a => a.type), ['no_hypotheses', 'no_hypotheses']);
  assert.ok(!types(s).includes('propose_hypotheses'));
  const a = m.applyNoHypotheses(s, 'T1');
  const c = cOf(a, 'T1').comparison;
  assert.equal(c.state, 'undecidable'); assert.equal(c.answer, 'insufficient'); assert.equal(cOf(a, 'T1').status, 'done');
  assert.equal(a.run.researchCalls, calls);
  const b = m.applyNoHypotheses(a, 'T2');
  assert.equal(b.run.phase, 'conclusion');
  const end = m.applyConclusion(b, { answers: [{ claimId: 'T1', answer: 'insufficient', sentence: 'Not examined.', assumptions: [] }, { claimId: 'T2', answer: 'insufficient', sentence: 'Not examined either.', assumptions: [] }] });
  assert.equal(end.run.phase, 'inference_check');
  assert.equal(m.applyInferenceCheck(end, ok2()).conclusion.state, 'undecidable');
  // positive answers have no basis
  refuses(b, () => m.applyConclusion(b, { answers: answersOf() }));
  // proposing is still possible while research can run, so the program may not close the claim
  const fresh = analysis();
  refuses(fresh, () => m.applyNoHypotheses(fresh, 'T1'));
  refuses(a, () => m.applyNoHypotheses(a, 'T1'));
  const has = plain(m.applyHypotheses(fresh, 'T1', causalSet())); has.run.researchCalls = model.MAX_RESEARCH_CALLS;
  refuses(has, () => m.applyNoHypotheses(has, 'T1'));
  valid(b);
});
test('the 6-hypothesis cap leaving no room for a claim floor closes that claim the same conservative way', () => {
  const five = [hyp('H1', 'primary'), hyp('H2', 'alternative'), hyp('H3', 'reverse'), hyp('H4', 'common_cause'), hyp('H5', 'alternative')];
  const s = m.applyHypotheses(analysis(), 'T1', five);
  eq(plain(m.nextActions(s)).filter(a => a.claimId === 'T2').map(a => a.type), ['no_hypotheses']);
  const closed = m.applyNoHypotheses(s, 'T2');
  assert.equal(cOf(closed, 'T2').comparison.answer, 'insufficient');
  assert.equal(closed.hypotheses.length, 5);
});

// ---- purity ---------------------------------------------------------------------------------------------------------------------------
test('reducers are pure: a successful V2b call leaves its input untouched and returns a new object', () => {
  const calls = [];
  const s0 = tested(m.applyHypotheses(analysis(), 'T1', causalSet()), 'H1');
  calls.push([s0, s => m.applyVerdict(s, 'H1', supportedDraft())]);
  calls.push([s0, s => m.prepareVerdict(s, 'H1')]);
  const s1 = allJudged();
  calls.push([s1, s => m.applyComparison(s, 'T1', done('causal_established'))]);
  calls.push([s1, s => m.applyComparison(s, 'T1', { decision: 'rejudge', rejudge: ['H1'], vetoes: [{ kind: 'contradiction', detail: 'x' }], allocations: [], answer: 'insufficient' })]);
  calls.push([s1, s => m.applyComparison(s, 'T1', { decision: 'add_alternative', vetoes: [{ kind: 'missed_alternative', detail: 'x' }], allocations: [], answer: 'insufficient' })]);
  calls.push([s1, s => m.prepareComparison(s, 'T1')]);
  const s2 = toConclusion();
  calls.push([s2, s => m.applyConclusion(s, { answers: answersOf() })]);
  calls.push([s2, s => m.prepareConclusion(s)]);
  const s3 = concluded();
  calls.push([s3, s => m.applyInferenceCheck(s, ok2())]);
  calls.push([s3, s => m.applyInferenceCheck(s, [{ id: 'T1', status: 'delete' }, { id: 'T2', status: 'ok' }])]);
  calls.push([s3, s => m.prepareInferenceCheck(s)]);
  const lim = plain(analysis()); lim.run.researchCalls = model.MAX_RESEARCH_CALLS;
  calls.push([lim, s => m.applyNoHypotheses(s, 'T1')]);
  const veto = m.applyComparison(allJudged(), 'T1', { decision: 'add_alternative', vetoes: [{ kind: 'missed_alternative', detail: 'x' }], allocations: [], answer: 'insufficient' });
  calls.push([veto, s => m.applyAlternativeHypotheses(s, 'T1', [hyp('H4', 'alternative')])]);
  for (const [state, fn] of calls) {
    const before = JSON.stringify(state);
    const out = fn(state);
    assert.equal(JSON.stringify(state), before);
    if (out && out.v === 2) assert.notEqual(out, state);
  }
});

// ---- compare_equivalent needs a supported primary (review R2 M1; methodology 9: equivalence needs evidence) ----------------------
function comparisonJudged(primaryDraft, measurementOpen = false) {
  const cmp = claimDrafts().map(c => (c.id === 'T1' ? { ...c, type: 'comparison' } : c));
  let s = m.applyHypotheses(m.applyHypotheses(analysis(cmp), 'T1', [facet('A'), facet('B'), facet('M')].map((h, i) => ({ ...h, role: ['primary', 'alternative', 'measurement'][i] }))), 'T2', [facet('F1'), facet('F2')]);
  s = judged(s, 'A', primaryDraft === 'refuted' ? { stance: 'refutes' } : {}, primaryDraft === 'supported' ? factSupported('A') : primaryDraft === 'refuted' ? refutedDraft('A') : undecidedDraft());
  s = judged(s, 'B', { stance: 'refutes' }, refutedDraft('B'));
  s = judged(s, 'M', measurementOpen ? {} : { stance: 'refutes' }, measurementOpen ? undecidedDraft() : refutedDraft('M'));
  s = judged(s, 'F1', {}, factSupported('F1'));
  return judged(s, 'F2', {}, factSupported('F2'));
}
test('compare_equivalent: refused unless the primary is supported; a refuted, undecided or insufficient primary cannot be answered as equal', () => {
  for (const kind of ['refuted', 'undecided']) {
    const s = comparisonJudged(kind);
    refuses(s, () => m.applyComparison(s, 'T1', done('compare_equivalent')));
    refuses(s, () => m.applyComparison(s, 'T1', done('compare_greater')));
  }
  const ok = comparisonJudged('supported');
  assert.equal(cOf(m.applyComparison(ok, 'T1', done('compare_equivalent')), 'T1').comparison.answer, 'compare_equivalent');
  assert.equal(cOf(m.applyComparison(ok, 'T1', done('compare_greater')), 'T1').comparison.answer, 'compare_greater', 'the existing direction answer is unchanged');
});
test('compare_equivalent: the measurement explanation must be refuted too (as strict as a direction); undetermined stays free', () => {
  const s = comparisonJudged('supported', true);
  refuses(s, () => m.applyComparison(s, 'T1', done('compare_equivalent')));
  assert.equal(cOf(m.applyComparison(s, 'T1', done('compare_undetermined')), 'T1').comparison.answer, 'compare_undetermined');
});
