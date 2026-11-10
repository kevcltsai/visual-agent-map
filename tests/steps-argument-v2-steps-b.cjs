// Argument map v2 steps, second half (V4b): verdict, comparison, conclusion and inference check.
// Each request carries the machine's own prepare* output; each parser refuses a missing or extra field, an id outside the request, an invented
// number or link and a runaway reply, and yields the Draft the matching apply* reducer takes (round trip); each runs text-only.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const S = require('./support.cjs');
const { loadWithAiCalls } = require('./support-ai-calls.cjs');
const m = S.load('core/argument-map/machine-v2.ts');
const model = S.load('core/argument-map/model.ts');
const sh = S.load('core/steps/argument-map/v2-shared.ts');
const mod = loadWithAiCalls('core/steps/argument-map/runner.ts');

const plain = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const eq = (actual, expected, message) => assert.deepEqual(plain(actual), plain(expected), message);
const base = { language: 'en', model: 'claude:haiku', reasoning: 'low' };
const isStepError = pattern => error => error.name === 'ArgumentStepError' && (!pattern || pattern.test(error.message));
const bad = (step, request, value, pattern) => assert.throws(() => step.parse(typeof value === 'string' ? value : JSON.stringify(value), request), isStepError(pattern));
const ok = (step, request, value) => plain(step.parse(JSON.stringify(value), request));
const gateError = fn => assert.throws(fn, error => error instanceof m.GateError, 'expected a GateError');
function exactKeys(step, request, value) {
  for (const key of Object.keys(value)) { const { [key]: _gone, ...rest } = value; bad(step, request, rest, /unexpected fields/); }
  bad(step, request, { ...value, extra: 1 }, /unexpected fields/);
}
const long = 'x'.repeat(sh.MAX_REPLY_TEXT + 1);

// ---- fixtures (same shapes as tests/steps-argument-machine-v2-verdict.cjs) ----
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

const vd = mod.verdictV2Step, cp = mod.comparisonStep, cn = mod.conclusionV2Step, ic = mod.inferenceCheckStep;
const hypothesesState = () => m.applyHypotheses(analysis(), 'T1', causalSet());

// ---- shared ----
test('the four judging steps: strict schemas, own ids at version 1, and the runner table names them', () => {
  const walk = (node, where) => {
    if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${where}[${i}]`));
    if (!node || typeof node !== 'object') return;
    if (node.type === 'object') {
      assert.equal(node.additionalProperties, false, `${where} additionalProperties`);
      eq([...(node.required ?? [])].sort(), Object.keys(node.properties ?? {}).sort(), `${where} required`);
    }
    for (const [k, v] of Object.entries(node)) walk(v, `${where}.${k}`);
  };
  for (const [name, step] of Object.entries({ verdict: vd, comparison: cp, conclusion: cn, inference: ic })) walk(step.schema, name);
  eq([vd, cp, cn, ic].map(x => `${x.id}@${x.version}`), ['argument-map.v2-verdict@1', 'argument-map.v2-comparison@1', 'argument-map.v2-conclusion@1', 'argument-map.v2-inference-check@1']);
  const t = mod.ARGUMENT_STEPS_V2;
  assert.equal(t.verdict, vd); assert.equal(t.compare, cp); assert.equal(t.conclude, cn); assert.equal(t.inference_check, ic);
  // V1 keeps its own steps
  assert.notEqual(mod.ARGUMENT_STEPS.verdict, vd); assert.notEqual(mod.ARGUMENT_STEPS.conclude, cn);
  assert.ok(!vd.schema.properties.value.enum.includes('insufficient'), 'the model cannot offer insufficient');
});
test('shared: parseReply, asRec, asArr, idsOf, hasKey, groundedIn and strOf read an input without trusting it', () => {
  assert.throws(() => sh.parseReply('{x'), isStepError(/not JSON/));
  eq(sh.parseReply('{"a":1}'), { a: 1 });
  eq(sh.asRec(null), {}); eq(sh.asRec([1]), {}); eq(sh.asArr('x'), []);
  eq(sh.idsOf([{ id: 'a' }, { id: 3 }, null, { x: 1 }], 'id'), ['a']);
  assert.equal(sh.hasKey({ a: [{ b: { userVerdict: 'x' } }] }, 'userVerdict'), true);
  assert.equal(sh.hasKey({ a: [{ b: 1 }] }, 'userVerdict'), false);
  assert.equal(sh.strOf(4), ''); assert.equal(sh.strOf('t'), 't');
  assert.throws(() => sh.groundedIn(['rose 77 percent'], { t: 'rose 9 percent' }), isStepError(/number 77/));
  assert.throws(() => sh.groundedIn(['see https://evil.example'], { t: 'https://ok.example' }), isStepError(/link/));
  sh.groundedIn(['rose 9 percent, see https://ok.example'], { t: 'rose 9 percent https://ok.example' });
});

// ---- verdict ----
const alloc = () => {
  let s = tested(hypothesesState(), 'H1');
  s = tested(s, 'H2', { stance: 'refutes', also: ['H1'] });
  const out = plain(s); out.claims.find(c => c.id === 'T1').comparison.allocations.push({ needId: 'H2-n2', hypothesisId: 'H1' });
  return out;
};
const vReq = (s = tested(hypothesesState(), 'H1'), hid = 'H1', over = {}) => ({ ...base, input: plain(m.prepareVerdict(s, hid)), ...over });
const vOk = (over = {}) => ({ value: 'supported', reason: 'the tests agree', citedNeeds: ['H1-n1'], counterNotes: [], refutations: [], causal: 'established', assumptionStatus: [{ assumption: 'parallel trends', status: 'checked', defense: '' }], confidence: 'medium', ...over });
const vCounter = (over = {}) => vOk({ value: 'undecided', citedNeeds: [], counterNotes: ['it counts against H1 only weakly'], refutations: [{ needId: 'H2-n2', class: 'nondecisive', auxiliary: [] }], causal: 'not_applicable', assumptionStatus: [], confidence: 'low', ...over });

test('verdict: the request is the hypothesis only (no mark, no other hypothesis, no page text) and a valid reply parses and applies', () => {
  const s = tested(hypothesesState(), 'H1');
  const marked = m.applyUserVerdict(s, 'H1', 'refuted');
  const request = vReq(marked);
  const prompt = vd.render(request);
  assert.doesNotMatch(prompt, /userVerdict|H2|H3/);
  assert.ok(prompt.includes('"counterEvidence":[]'));
  assert.equal(JSON.stringify(request.input), JSON.stringify(m.prepareVerdict(s, 'H1')), 'a user mark changes nothing the step sees');
  const out = ok(vd, request, vOk());
  eq(out.assumptionStatus, [{ assumption: 'parallel trends', status: 'checked' }]);
  assert.equal(out.value, 'supported');
  const next = valid(m.applyVerdict(s, 'H1', vd.parse(JSON.stringify(vOk()), request)));
  assert.equal(next.hypotheses.find(h => h.id === 'H1').verdict.value, 'supported');
  assert.equal(next.hypotheses.find(h => h.id === 'H1').verdict.causal, 'established');
  assert.doesNotThrow(() => vd.policy(prompt, request));
});
test('verdict: with allocated counter-evidence every one is classified once and noted once; the parsed reply applies', () => {
  const s = alloc(); const request = vReq(s);
  eq(request.input.counterEvidence, ['H2-n2']);
  const out = ok(vd, request, vCounter());
  eq(out.refutations, [{ needId: 'H2-n2', class: 'nondecisive', auxiliary: [] }]);
  const next = valid(m.applyVerdict(s, 'H1', vd.parse(JSON.stringify(vCounter()), request)));
  assert.equal(next.hypotheses.find(h => h.id === 'H1').verdict.value, 'undecided');
  bad(vd, request, vCounter({ refutations: [], counterNotes: [] }), /every counter-evidence/);
  bad(vd, request, vCounter({ counterNotes: [] }), /one to one/);
  bad(vd, request, vCounter({ counterNotes: ['a', 'b'] }), /one to one/);
  bad(vd, request, vCounter({ refutations: [{ needId: 'H2-n2', class: 'nondecisive', auxiliary: [] }, { needId: 'H2-n2', class: 'nondecisive', auxiliary: [] }], counterNotes: ['a', 'b'] }), /every counter-evidence/);
  bad(vd, request, vCounter({ refutations: [{ needId: 'H1-n2', class: 'nondecisive', auxiliary: [] }] }), /outside the request/);
  // the machine still refuses a decisive class for allocated evidence (the parser leaves legality to applyVerdict)
  gateError(() => m.applyVerdict(s, 'H1', vd.parse(JSON.stringify(vCounter({ refutations: [{ needId: 'H2-n2', class: 'decisive', auxiliary: ['P1'] }] })), request)));
});
test('verdict: missing, extra and non-enum fields, insufficient from the model, and a non-JSON reply throw', () => {
  const request = vReq();
  exactKeys(vd, request, vOk());
  bad(vd, request, vOk({ assumptionStatus: [{ assumption: 'parallel trends', status: 'checked' }] }), /unexpected fields/);
  bad(vd, request, vOk({ assumptionStatus: [{ assumption: 'parallel trends', status: 'checked', defense: '', extra: 1 }] }), /unexpected fields/);
  bad(vd, alloc() && vReq(alloc()), vCounter({ refutations: [{ needId: 'H2-n2', class: 'nondecisive' }] }), /unexpected fields/);
  bad(vd, request, vOk({ value: 'insufficient' }), /only the program/);
  for (const [key, v] of [['value', 'maybe'], ['value', 3], ['causal', 'proven'], ['confidence', 'certain'], ['confidence', null]]) bad(vd, request, vOk({ [key]: v }), /not allowed/);
  bad(vd, vReq(alloc()), vCounter({ refutations: [{ needId: 'H2-n2', class: 'fatal', auxiliary: [] }] }), /not allowed/);
  bad(vd, request, vOk({ assumptionStatus: [{ assumption: 'parallel trends', status: 'proved', defense: '' }] }), /not allowed/);
  bad(vd, request, '{"value":', /not JSON/); bad(vd, request, '[]', /must be an object/); bad(vd, request, 'null', /must be an object/);
});
test('verdict: ids outside the request (needs, counter-evidence, premises, assumptions) and a repeat throw', () => {
  const request = vReq();
  bad(vd, request, vOk({ citedNeeds: ['H2-n1'] }), /outside the request/);
  bad(vd, request, vOk({ citedNeeds: ['zz'] }), /outside the request/);
  bad(vd, request, vOk({ citedNeeds: ['H1-n1', 'H1-n1'] }), /repeats/);
  bad(vd, request, vOk({ assumptionStatus: [{ assumption: 'common trends', status: 'checked', defense: '' }] }), /outside the request/);
  bad(vd, request, vOk({ assumptionStatus: [{ assumption: 'parallel trends', status: 'checked', defense: '' }, { assumption: 'parallel trends', status: 'checked', defense: '' }] }), /listed twice/);
  const withAux = vReq(alloc());
  bad(vd, withAux, vCounter({ refutations: [{ needId: 'H2-n2', class: 'nondecisive', auxiliary: ['P9'] }] }), /outside the request/);
  assert.equal(ok(vd, withAux, vCounter({ refutations: [{ needId: 'H2-n2', class: 'nondecisive', auxiliary: ['P1'] }] })).refutations[0].auxiliary[0], 'P1');
});
test('verdict: a number or link the input does not have is refused in the reason, a note and a defense; numbers and links of the input pass', () => {
  const request = vReq(alloc());
  bad(vd, request, vCounter({ reason: 'it fell 77 percent' }), /number 77/);
  bad(vd, request, vCounter({ reason: 'see https://evil.example/x' }), /link/);
  bad(vd, request, vCounter({ counterNotes: ['rose 12 points'] }), /number 12/);
  bad(vd, request, vCounter({ counterNotes: ['see http://evil.example'] }), /link/);
  // the quote of H1-n1 says "quote 103 from the page": its number and url are in the input and may be repeated
  const own = vReq(); const url = own.input.evidence[0].source.url; const quote = own.input.evidence[0].source.quote;
  assert.equal(ok(vd, own, vOk({ reason: `${quote} (${url})` })).reason, `${quote} (${url})`);
  const cond = (defense) => vOk({ causal: 'conditional', assumptionStatus: [{ assumption: 'parallel trends', status: 'defended', defense }] });
  bad(vd, own, cond('the trend is flat since 2015'), /number 2015/);
  bad(vd, own, cond('see https://evil.example'), /link/);
  assert.equal(ok(vd, own, cond('the pre-trend is flat')).assumptionStatus[0].defense, 'the pre-trend is flat');
});
test('verdict: empty, overlong, wrong typed and Unicode text; a defense belongs to a defended assumption only', () => {
  const request = vReq(alloc());
  for (const reason of ['', '   ', long, 5, null, ['x']]) bad(vd, request, vCounter({ reason }), /./);
  bad(vd, request, vCounter({ counterNotes: [''] }), /./); bad(vd, request, vCounter({ counterNotes: [long] }), /too long/);
  assert.equal(ok(vd, request, vCounter({ reason: '青年失業率\r\n上升' })).reason, '青年失業率\r\n上升');
  assert.equal(ok(vd, request, vCounter({ reason: 'x'.repeat(sh.MAX_REPLY_TEXT) })).reason.length, sh.MAX_REPLY_TEXT);
  const own = vReq();
  bad(vd, own, vOk({ assumptionStatus: [{ assumption: 'parallel trends', status: 'checked', defense: 'x' }] }), /only a defended/);
  bad(vd, own, vOk({ causal: 'conditional', assumptionStatus: [{ assumption: 'parallel trends', status: 'defended', defense: '' }] }), /./);
  bad(vd, own, vOk({ assumptionStatus: [{ assumption: 'parallel trends', status: 'checked', defense: 4 }] }), /string/);
  eq(ok(vd, own, vOk({ value: 'undecided', causal: 'not_applicable', assumptionStatus: [], citedNeeds: [] })).citedNeeds, []);
});
test('verdict: the policy refuses a user mark in the input, missing evidence and an over-budget request before any call', () => {
  const request = vReq();
  const run = r => vd.policy(vd.render(r), r);
  run(request);
  assert.throws(() => run({ ...request, input: { ...request.input, hypothesis: { ...request.input.hypothesis, userVerdict: 'supported' } } }), isStepError(/user mark/));
  assert.throws(() => run({ ...request, input: { ...request.input, evidence: undefined } }), isStepError(/evidence/));
  assert.throws(() => run({ ...request, input: { ...request.input, counterEvidence: 'x' } }), isStepError(/evidence/));
  assert.throws(() => run({ ...request, input: null }), isStepError());
  const fat = { ...request, input: { ...request.input, claim: { ...request.input.claim, text: 'x'.repeat(200_000) } } };
  assert.throws(() => run(fat), isStepError(/over the token budget/));
});

// ---- comparison ----
const cReq = (s = allJudged(), claimId = 'T1', over = {}) => ({ ...base, input: plain(m.prepareComparison(s, claimId)), ...over });
const cOk = (over = {}) => ({ decision: 'complete', vetoes: [], allocations: [], rejudge: [], answer: 'causal_established', contributors: null, largest: null, basis: null, ...over });
const cVeto = (over = {}) => cOk({ decision: 'rejudge', vetoes: [{ kind: 'contradiction', detail: 'two verdicts clash' }], rejudge: ['H1'], answer: null, ...over });
test('comparison: the request shows verdicts, evidence and shared sources only (no mark, no page text); a complete reply applies', () => {
  const s = allJudged();
  let marked = s; for (const h of s.hypotheses) marked = m.applyUserVerdict(marked, h.id, 'undecided');
  const request = cReq(marked);
  const prompt = cp.render(request);
  assert.doesNotMatch(prompt, /userVerdict|F1|F2|"T2"/, 'nothing of the other claim');
  assert.equal(JSON.stringify(request.input), JSON.stringify(m.prepareComparison(s, 'T1')));
  const draft = cp.parse(JSON.stringify(cOk()), request);
  eq(draft, { decision: 'complete', vetoes: [], allocations: [], answer: 'causal_established' });
  const next = valid(m.applyComparison(s, 'T1', draft));
  assert.equal(next.claims.find(c => c.id === 'T1').comparison.answer, 'causal_established');
  cp.policy(prompt, request);
});
test('comparison: a veto with a rejudge, an alternative or a give-up parses and applies; the remedy and the veto must agree', () => {
  const s = allJudged(); const request = cReq(s);
  const sent = valid(m.applyComparison(s, 'T1', cp.parse(JSON.stringify(cVeto()), request)));
  assert.equal(sent.hypotheses.find(h => h.id === 'H1').verdict, undefined, 'H1 was sent back');
  const alt = cVeto({ decision: 'add_alternative', vetoes: [{ kind: 'missed_alternative', detail: 'a wage explanation is absent' }], rejudge: [] });
  valid(m.applyComparison(s, 'T1', cp.parse(JSON.stringify(alt), request)));
  const giveUp = cVeto({ decision: 'undecidable', rejudge: [] });
  assert.equal(valid(m.applyComparison(s, 'T1', cp.parse(JSON.stringify(giveUp), request))).claims.find(c => c.id === 'T1').comparison.state, 'undecidable');
  bad(cp, request, cVeto({ vetoes: [] }), /every remedy needs one/);
  bad(cp, request, cOk({ vetoes: [{ kind: 'contradiction', detail: 'x' }] }), /no veto/);
  bad(cp, request, cVeto({ rejudge: [] }), /only a rejudge/);
  bad(cp, request, cVeto({ decision: 'undecidable' }), /only a rejudge/);
  bad(cp, request, cVeto({ decision: 'add_alternative', rejudge: [] }), /missed_alternative/);
  bad(cp, request, cVeto({ answer: 'causal_established' }), /only a complete/);
  bad(cp, request, cOk({ answer: null }), /gives an answer/);
});
test('comparison: missing, extra and non-enum fields, a program-owned veto kind and a non-JSON reply throw', () => {
  const request = cReq();
  exactKeys(cp, request, cOk());
  bad(cp, request, cVeto({ vetoes: [{ kind: 'contradiction' }] }), /unexpected fields/);
  bad(cp, request, cVeto({ vetoes: [{ kind: 'contradiction', detail: 'x', extra: 1 }] }), /unexpected fields/);
  bad(cp, request, cVeto({ allocations: [{ needId: 'H2-n2' }] }), /unexpected fields/);
  for (const [key, v] of [['decision', 'abort'], ['decision', 1], ['answer', 'maybe'], ['answer', 5]]) bad(cp, request, cOk({ [key]: v }), /not allowed/);
  bad(cp, request, cVeto({ vetoes: [{ kind: 'unhandled_counter', detail: 'x' }] }), /not allowed/);
  bad(cp, request, cVeto({ vetoes: [{ kind: 'bias', detail: 'x' }] }), /not allowed/);
  bad(cp, request, 'oops', /not JSON/); bad(cp, request, '[]', /must be an object/);
});
test('comparison: ids outside the request (rejudge, allocation, contributors) throw; a hypothesis that cannot be sent back is refused', () => {
  const request = cReq();
  bad(cp, request, cVeto({ rejudge: ['H9'] }), /outside the request/);
  bad(cp, request, cVeto({ rejudge: ['H1', 'H1'] }), /repeats/);
  bad(cp, request, cVeto({ rejudge: ['F1'] }), /outside the request/);
  bad(cp, request, cVeto({ allocations: [{ needId: 'F1-n2', hypothesisId: 'H1' }] }), /outside the request/);
  bad(cp, request, cVeto({ allocations: [{ needId: 'H2-n2', hypothesisId: 'H9' }] }), /outside the request/);
  const noRoom = cReq(); noRoom.input.comparison.room.canSendBack = [];
  bad(cp, noRoom, cVeto(), /sent back once/);
  const noAlt = cReq(); noAlt.input.comparison.room.canAddAlternative = false;
  bad(cp, noAlt, cVeto({ decision: 'add_alternative', vetoes: [{ kind: 'missed_alternative', detail: 'x' }], rejudge: [] }), /room/);
  eq(ok(cp, request, cVeto({ allocations: [{ needId: 'H2-n2', hypothesisId: 'H1' }] })).allocations, [{ needId: 'H2-n2', hypothesisId: 'H1' }]);
});
test('comparison: only a main-cause claim gives contributors, largest and basis, from its own hypotheses; the answer applies', () => {
  const request = cReq();
  for (const extra of [{ contributors: ['H1'] }, { largest: 'H1' }, { basis: 'none' }]) bad(cp, request, cOk(extra), /belong to a complete main-cause/);
  const mcs = m.applyHypotheses(m.applyHypotheses(analysis(claimDrafts('main_cause')), 'T1', causalSet()), 'T2', [facet('F1'), facet('F2')]);
  let t = judged(mcs, 'H1', {}, supportedDraft()); t = judged(t, 'H2', {}, supportedDraft({ citedNeeds: ['H2-n1'] })); t = judged(t, 'H3', { stance: 'refutes' }, refutedDraft('H3'));
  t = judged(t, 'F1', {}, factSupported('F1')); t = judged(t, 'F2', {}, factSupported('F2'));
  const mc = cReq(t);
  assert.equal(mc.input.claim.type, 'main_cause');
  const reply = cOk({ answer: 'main_cause_undecidable', contributors: ['H1', 'H2'], basis: 'point_estimates' });
  const draft = cp.parse(JSON.stringify(reply), mc);
  eq(draft.contributors, ['H1', 'H2']); assert.equal(draft.basis, 'point_estimates'); assert.equal(draft.largest, undefined);
  eq(m.applyComparison(t, 'T1', draft).claims.find(c => c.id === 'T1').comparison.contributors, ['H1', 'H2']);
  bad(cp, mc, { ...reply, contributors: ['H1', 'F1'] }, /outside the request/);
  bad(cp, mc, { ...reply, contributors: ['H1', 'H1'] }, /repeats/);
  bad(cp, mc, { ...reply, largest: 'H3' }, /outside the request/);
  bad(cp, mc, { ...reply, basis: 'guess' }, /not allowed/);
  assert.equal(cp.parse(JSON.stringify({ ...reply, largest: 'H2', basis: 'difference_with_uncertainty' }), mc).largest, 'H2');
  // a ranking on point estimates, or a contributor that is only compatible, is the machine's refusal
  gateError(() => m.applyComparison(t, 'T1', cp.parse(JSON.stringify({ ...reply, answer: 'main_cause_largest', largest: 'H1' }), mc)));
});
test('comparison: a veto detail may use only the numbers and links of the input; empty and overlong text throw', () => {
  const request = cReq();
  bad(cp, request, cVeto({ vetoes: [{ kind: 'contradiction', detail: 'off by 4242' }] }), /number 4242/);
  bad(cp, request, cVeto({ vetoes: [{ kind: 'contradiction', detail: 'see https://evil.example' }] }), /link/);
  for (const detail of ['', '  ', long, 3]) bad(cp, request, cVeto({ vetoes: [{ kind: 'contradiction', detail }] }), /./);
  const url = request.input.hypotheses[0].evidence[0].source.url;
  assert.equal(ok(cp, request, cVeto({ vetoes: [{ kind: 'double_count', detail: `both rest on ${url}` }] })).vetoes[0].detail, `both rest on ${url}`);
  assert.equal(ok(cp, request, cVeto({ vetoes: [{ kind: 'contradiction', detail: '青年失業率\r\n上升' }] })).vetoes[0].detail, '青年失業率\r\n上升');
});
test('comparison: the policy refuses a user mark, an empty hypothesis list and an over-budget request', () => {
  const request = cReq();
  const run = r => cp.policy(cp.render(r), r);
  run(request);
  assert.throws(() => run({ ...request, input: { ...request.input, userVerdict: 'x' } }), isStepError(/user mark/));
  assert.throws(() => run({ ...request, input: { ...request.input, hypotheses: [] } }), isStepError(/hypotheses/));
  assert.throws(() => run({ ...request, input: { ...request.input, claim: { ...request.input.claim, text: 'x'.repeat(200_000) } } }), isStepError(/token budget/));
});

// ---- conclusion ----
const toCond = () => {
  let s = m.applyHypotheses(m.applyHypotheses(analysis(), 'T1', causalSet()), 'T2', [facet('F1'), facet('F2')]);
  s = judged(s, 'H1', {}, defended());
  s = judged(s, 'H2', { stance: 'refutes' }, refutedDraft('H2'));
  s = judged(s, 'H3', { stance: 'refutes' }, refutedDraft('H3'));
  s = judged(s, 'F1', {}, factSupported('F1'));
  s = judged(s, 'F2', {}, factSupported('F2'));
  s = m.applyComparison(s, 'T1', done('causal_conditional'));
  return m.applyComparison(s, 'T2', done('holds'));
};
const nReq = (s = toConclusion(), over = {}) => ({ ...base, input: plain(m.prepareConclusion(s)), ...over });
const nOk = (over = {}) => ({ answers: [{ claimId: 'T1', answer: 'causal_established', sentence: 'AI caused the rise.', assumptions: [] }, { claimId: 'T2', answer: 'holds', sentence: 'Adoption is widespread.', assumptions: [] }], overall: '', ...over });
const nWith = (i, patch) => { const v = nOk(); v.answers[i] = { ...v.answers[i], ...patch }; return v; };

test('conclusion: the request has the comparison results and verdict summaries only; a valid reply parses and applies', () => {
  const s = toConclusion();
  let marked = s; for (const h of s.hypotheses) marked = m.applyUserVerdict(marked, h.id, 'undecided');
  const request = nReq(marked);
  const prompt = cn.render(request);
  assert.doesNotMatch(prompt, /userVerdict|quote \d+ from the page|https:\/\//, 'no mark and no evidence text');
  assert.equal(JSON.stringify(request.input), JSON.stringify(m.prepareConclusion(s)));
  const draft = cn.parse(JSON.stringify(nOk()), request);
  eq(draft.answers.map(a => a.claimId), ['T1', 'T2']); assert.equal(draft.overall, undefined);
  const next = valid(m.applyConclusion(s, draft));
  assert.equal(next.run.phase, 'inference_check');
  cn.policy(prompt, request);
});
test('conclusion: the answer must equal the comparison, every evaluated claim is answered once, and the machine agrees', () => {
  const request = nReq();
  bad(cn, request, nWith(0, { answer: 'causal_compatible' }), /comparison's/);
  bad(cn, request, nWith(0, { answer: 'holds' }), /comparison's/);
  bad(cn, request, nOk({ answers: nOk().answers.slice(0, 1) }), /every evaluated claim/);
  bad(cn, request, nOk({ answers: [nOk().answers[0], nOk().answers[0]] }), /twice/);
  bad(cn, request, nOk({ answers: [nOk().answers[0], { ...nOk().answers[1], claimId: 'T9' }] }), /outside the request/);
  bad(cn, request, nOk({ answers: [nOk().answers[0], { ...nOk().answers[1], claimId: 'P1' }] }), /outside the request/);
  bad(cn, request, nOk({ answers: [] }), /every evaluated claim/);
  eq(cn.parse(JSON.stringify(nOk()), request).answers.length, 2);
});
test('conclusion: missing, extra and non-enum fields throw', () => {
  const request = nReq();
  exactKeys(cn, request, nOk());
  for (const key of ['claimId', 'answer', 'sentence', 'assumptions']) { const v = nOk(); delete v.answers[0][key]; bad(cn, request, v, /unexpected fields/); }
  bad(cn, request, nWith(0, { extra: 1 }), /unexpected fields/);
  bad(cn, request, nWith(0, { answer: 'certainly' }), /not allowed/); bad(cn, request, nWith(1, { answer: 7 }), /not allowed/);
  bad(cn, request, '{', /not JSON/); bad(cn, request, '"x"', /must be an object/);
});
test('conclusion: a conditional answer lists exactly its assumptions and writes them into the sentence', () => {
  const s = toCond(); const request = nReq(s);
  const need = request.input.claims[0].comparison.requiredAssumptions;
  eq(need, ['parallel trends']);
  const reply = nOk({ answers: [{ claimId: 'T1', answer: 'causal_conditional', sentence: 'AI caused the rise, if parallel trends holds.', assumptions: ['parallel trends'] }, nOk().answers[1]] });
  valid(m.applyConclusion(s, cn.parse(JSON.stringify(reply), request)));
  const patch = patchAnswer => nOk({ answers: [{ ...reply.answers[0], ...patchAnswer }, reply.answers[1]] });
  bad(cn, request, patch({ assumptions: [] }), /exactly the assumptions/);
  bad(cn, request, patch({ assumptions: ['parallel trends', 'parallel trends'] }), /exactly the assumptions/);
  bad(cn, request, patch({ assumptions: ['other trends'] }), /outside the request/);
  bad(cn, request, patch({ sentence: 'AI caused the rise.' }), /written into the sentence/);
  bad(cn, request, nOk({ answers: [{ claimId: 'T1', answer: 'causal_conditional', sentence: 'AI caused the rise.', assumptions: [] }, nOk().answers[1]] }), /exactly the assumptions/);
  const listedButUnwritten = nOk({ answers: [{ claimId: 'T1', answer: 'causal_conditional', sentence: 'AI caused the rise.', assumptions: ['parallel trends'] }, nOk().answers[1]] });
  bad(cn, request, listedButUnwritten, /written into the sentence/);
  bad(cn, nReq(), nWith(0, { assumptions: ['parallel trends'] }), /outside the request/, 'an answer with no required assumption lists none');
});
test('conclusion: no whole-sentence answer without a composition rule; with one it is accepted', () => {
  const request = nReq();
  assert.equal(request.input.framing.composition, null);
  bad(cn, request, nOk({ overall: 'AI caused it and adoption is widespread.' }), /composition rule/);
  const withRule = nReq(); withRule.input.framing.composition = 'both claims must hold';
  const out = ok(cn, withRule, nOk({ overall: 'AI caused it and adoption is widespread.' }));
  assert.equal(out.overall, 'AI caused it and adoption is widespread.');
  bad(cn, withRule, nOk({ overall: 3 }), /string/); bad(cn, withRule, nOk({ overall: long }), /too long/);
  // a real composition: the machine takes the overall sentence only when the locked framing carries a rule
  const real = m.applyConclusion(toConclusion(), { answers: nOk().answers });
  assert.equal(real.conclusion.overall, undefined);
  gateError(() => m.applyConclusion(toConclusion(), { answers: nOk().answers, overall: 'x' }));
});
test('conclusion: sentences may use only the numbers and links of the input; empty, overlong, Unicode and CRLF text', () => {
  const request = nReq();
  bad(cn, request, nWith(0, { sentence: 'AI caused 63 percent of it.' }), /number 63/);
  bad(cn, request, nWith(1, { sentence: 'See https://evil.example for adoption.' }), /link/);
  for (const sentence of ['', '   ', long, null, 4]) bad(cn, request, nWith(0, { sentence }), /./);
  assert.equal(ok(cn, request, nWith(0, { sentence: '人工智慧造成上升。\r\n第二行' })).answers[0].sentence, '人工智慧造成上升。\r\n第二行');
  const withNumber = nReq(); withNumber.input.framing.original = 'Is AI the reason since 2023?';
  assert.equal(ok(cn, withNumber, nWith(0, { sentence: 'Since 2023 AI caused the rise.' })).answers[0].sentence, 'Since 2023 AI caused the rise.');
});
test('conclusion: the policy refuses a user mark and an input without an evaluated claim', () => {
  const request = nReq();
  const run = r => cn.policy(cn.render(r), r);
  run(request);
  assert.throws(() => run({ ...request, input: { ...request.input, userVerdict: 'x' } }), isStepError(/user mark/));
  assert.throws(() => run({ ...request, input: { ...request.input, claims: request.input.claims.map(c => ({ ...c, evaluated: false })) } }), isStepError(/evaluated/));
  assert.throws(() => run({ ...request, input: null }), isStepError());
  assert.throws(() => run({ ...request, input: { ...request.input, framing: { ...request.input.framing, original: 'x'.repeat(200_000) } } }), isStepError(/token budget/));
});

// ---- inference check ----
const iReq = (s = concluded(), over = {}) => ({ ...base, input: plain(m.prepareInferenceCheck(s)), ...over });
const iOk = (over = {}) => ({ items: [{ id: 'T1', status: 'ok', rewrite: '' }, { id: 'T2', status: 'ok', rewrite: '' }], ...over });
const iWith = (i, patch) => { const v = iOk(); v.items[i] = { ...v.items[i], ...patch }; return v; };

test('inference check: the request is the sentences and the conclusion input; ok, rewrite and delete parse and apply', () => {
  const s = concluded();
  const request = iReq(s);
  const prompt = ic.render(request);
  assert.doesNotMatch(prompt, /userVerdict|quote \d+ from the page/);
  assert.equal(JSON.stringify(request.input), JSON.stringify(m.prepareInferenceCheck(s)));
  const items = ic.parse(JSON.stringify(iOk()), request);
  eq(items, [{ id: 'T1', status: 'ok' }, { id: 'T2', status: 'ok' }]);
  assert.equal(valid(m.applyInferenceCheck(s, items)).run.phase, 'concluded');
  const mixed = ic.parse(JSON.stringify(iWith(1, { status: 'rewrite', rewrite: 'Adoption looks widespread.' })), request);
  eq(mixed[1], { id: 'T2', status: 'rewrite', rewrite: 'Adoption looks widespread.' });
  const next = m.applyInferenceCheck(s, mixed);
  assert.equal(next.conclusion.answers.find(a => a.claimId === 'T2').sentence, 'Adoption looks widespread.');
  assert.equal(next.run.phase, 'inference_check', 'a rewrite earns a second check');
  const del = ic.parse(JSON.stringify(iWith(0, { status: 'delete' })), request);
  const deleted = m.applyInferenceCheck(s, del);
  eq(deleted.conclusion.deleted, ['AI caused the rise.']);
  ic.policy(prompt, request);
});
test('inference check: missing, extra and non-enum fields, an id outside the request, a repeat and a short list throw', () => {
  const request = iReq();
  exactKeys(ic, request, iOk());
  for (const key of ['id', 'status', 'rewrite']) { const v = iOk(); delete v.items[0][key]; bad(ic, request, v, /unexpected fields/); }
  bad(ic, request, iWith(0, { extra: 1 }), /unexpected fields/);
  for (const status of ['pass', 'keep', 3, null, '']) bad(ic, request, iWith(0, { status }), /not allowed/);
  bad(ic, request, iWith(0, { id: 'T9' }), /outside the request/);
  bad(ic, request, iWith(0, { id: 'overall' }), /outside the request/);
  bad(ic, request, iOk({ items: [iOk().items[0], iOk().items[0]] }), /twice/);
  bad(ic, request, iOk({ items: [iOk().items[0]] }), /every sentence/);
  bad(ic, request, iOk({ items: [] }), /every sentence/);
  bad(ic, request, '{', /not JSON/);
});
test('inference check: only a rewrite carries a sentence, and it passes the number and link guard', () => {
  const request = iReq();
  bad(ic, request, iWith(0, { status: 'ok', rewrite: 'x' }), /only a rewrite/);
  bad(ic, request, iWith(0, { status: 'delete', rewrite: 'x' }), /only a rewrite/);
  for (const rewrite of ['', '  ', long, 5, null]) bad(ic, request, iWith(0, { status: 'rewrite', rewrite }), /./);
  bad(ic, request, iWith(0, { status: 'rewrite', rewrite: 'AI caused 55 percent.' }), /number 55/);
  bad(ic, request, iWith(0, { status: 'rewrite', rewrite: 'See https://evil.example' }), /link/);
  assert.equal(ok(ic, request, iWith(0, { status: 'rewrite', rewrite: '人工智慧可能造成上升。\r\n' }))[0].rewrite, '人工智慧可能造成上升。');
});
test('inference check: a rewrite keeps the assumptions its answer needs (and the sentence "overall" is checkable)', () => {
  const s = m.applyConclusion(toCond(), { answers: [{ claimId: 'T1', answer: 'causal_conditional', sentence: 'AI caused the rise, if parallel trends holds.', assumptions: ['parallel trends'] }, nOk().answers[1]] });
  const request = iReq(s);
  const item = rewrite => iWith(0, { status: 'rewrite', rewrite });
  bad(ic, request, item('AI caused the rise.'), /written into the sentence/);
  const good = ic.parse(JSON.stringify(item('AI may have caused the rise if parallel trends holds.')), request);
  valid(m.applyInferenceCheck(s, good));
  gateError(() => m.applyInferenceCheck(s, ic.parse(JSON.stringify(iOk({ items: [iOk().items[0]] })), { ...request, input: { ...request.input, sentences: request.input.sentences.slice(0, 1) } })));
  const overall = plain(request); overall.input.sentences.push({ id: 'overall', sentence: 'All of it holds.' });
  const withOverall = iOk({ items: [...iOk().items, { id: 'overall', status: 'delete', rewrite: '' }] });
  assert.equal(ok(ic, overall, withOverall)[2].id, 'overall');
  bad(ic, request, withOverall, /every sentence|outside the request/);
});
test('inference check: the policy refuses a user mark and an input with no sentence', () => {
  const request = iReq();
  const run = r => ic.policy(ic.render(r), r);
  run(request);
  assert.throws(() => run({ ...request, input: { ...request.input, userVerdict: 'x' } }), isStepError(/user mark/));
  assert.throws(() => run({ ...request, input: { ...request.input, sentences: [] } }), isStepError(/no sentence/));
  assert.throws(() => run({ ...request, input: null }), isStepError());
  assert.throws(() => run({ ...request, input: { ...request.input, sentences: [{ id: 'T1', sentence: 'x'.repeat(200_000) }] } }), isStepError(/token budget/));
});

// ---- text-only through the real runtimes (same check as the five V4a steps) ----
const claudeChild = (spawned, structured) => (executable, args) => {
  spawned.push(args);
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => true;
  child.stdin = { end: () => process.nextTick(() => { child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, structured_output: structured }))); child.emit('close', 0); }) };
  return child;
};
function codexChild(requests, text) {
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
  const emit = message => process.nextTick(() => child.stdout.emit('data', Buffer.from(JSON.stringify(message) + '\n')));
  child.stdin = { write: line => {
    const msg = JSON.parse(line); requests.push(msg);
    if (msg.method === 'initialize') emit({ id: msg.id, result: {} });
    else if (msg.method === 'config/read') emit({ id: msg.id, result: { config: { mcp_servers: {} } } });
    else if (msg.method === 'thread/start') emit({ id: msg.id, result: { thread: { id: 't1' } } });
    else if (msg.method === 'turn/start') {
      emit({ id: msg.id, result: { turn: { id: 'u1' } } });
      emit({ method: 'item/completed', params: { threadId: 't1', item: { id: 'm', type: 'agentMessage', text } } });
      emit({ method: 'turn/completed', params: { threadId: 't1', turn: { status: 'completed' } } });
    } else if (msg.method === 'thread/unsubscribe') emit({ id: msg.id, result: {} });
  } };
  return child;
}
const judgeCases = () => [['verdict', vd, vReq(), vOk()], ['comparison', cp, cReq(), cOk()], ['conclusion', cn, nReq(), nOk()], ['inference check', ic, iReq(), iOk()]];
test('the four judging steps on Claude: --tools "" and no web tool reach the runtime, the reply is parsed, and a bad reply is a step error', async () => {
  for (const [name, step, request, answer] of judgeCases()) {
    const spawned = [];
    const claude = S.load('ai/runtime/claude-code-cli.ts', { 'node:child_process': { spawn: claudeChild(spawned, answer) } });
    const runtime = new claude.ClaudeCodeCliRuntime({ executable: 'claude', cwd: '/plugin', env: {}, spawn: claudeChild(spawned, answer) });
    const calls = new mod.AiCalls({ runtimeFor: model => mod.aiRuntimeForModel(model, { claude: () => runtime, codex: () => { throw new Error('unexpected codex'); } }), exchanges: () => null });
    const out = await mod.askArgumentStep(step, request, mod.providerArgumentRunner(calls), new AbortController().signal);
    assert.ok(out, name);
    assert.equal(spawned.length, 1, name);
    const args = spawned[0];
    assert.equal(args[args.indexOf('--tools') + 1], '', `${name}: --tools ""`);
    assert.ok(!args.includes('--allowedTools'), name);
    assert.ok(!args.some(a => /WebSearch|WebFetch/.test(a)), name);
    assert.ok(args.includes('--json-schema'), name);
  }
  const spawned = [];
  const claude = S.load('ai/runtime/claude-code-cli.ts');
  const runtime = new claude.ClaudeCodeCliRuntime({ executable: 'claude', cwd: '/plugin', env: {}, spawn: claudeChild(spawned, vOk({ citedNeeds: ['H9-n1'] })) });
  const calls = new mod.AiCalls({ runtimeFor: model => mod.aiRuntimeForModel(model, { claude: () => runtime, codex: () => { throw new Error('x'); } }), exchanges: () => null });
  await assert.rejects(mod.askArgumentStep(vd, vReq(), mod.providerArgumentRunner(calls), new AbortController().signal), isStepError());
});
test('the four judging steps on Codex: web_search is disabled in the thread config and the shell tool is off', async () => {
  for (const [name, step, request, answer] of judgeCases()) {
    const requests = [];
    const codex = S.load('ai/runtime/codex-app-server.ts', { 'node:child_process': { spawn: () => codexChild(requests, JSON.stringify(answer)) } });
    const runtime = new codex.CodexAppServerRuntime({ executable: 'codex', cwd: '/plugin', env: {}, clientVersion: 'test', webSearchDisabled: true });
    try {
      const calls = new mod.AiCalls({ runtimeFor: model => mod.aiRuntimeForModel(model, { claude: () => { throw new Error('unexpected claude'); }, codex: () => runtime }), exchanges: () => null });
      const out = await mod.askArgumentStep(step, { ...request, model: 'gpt-test' }, mod.providerArgumentRunner(calls), new AbortController().signal);
      assert.ok(out, name);
      const config = requests.find(r => r.method === 'thread/start').params.config;
      assert.equal(config.web_search, 'disabled', name);
      assert.equal(config['features.shell_tool'], false, name);
    } finally { runtime.stop(); }
  }
});
