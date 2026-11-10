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
