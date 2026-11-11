// Argument map steps (P3): the five steps that never browse. Each request type holds only the allowed fields, each parser refuses
// any id, number or URL outside the request, and each runs text-only (Claude `--tools ""`, Codex web search disabled).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const S = require('./support.cjs');
const { loadWithAiCalls } = require('./support-ai-calls.cjs');
const m = S.load('core/argument-map/machine.ts');
const mod = loadWithAiCalls('core/steps/argument-map/runner.ts');
const sr = S.load('core/step-runner.ts');

const roles = { proposition: 'p', situation: 's', conclusion: 'c', verified: 'v', eliminated: 'e' };
const base = { language: 'en', model: 'claude:haiku', reasoning: 'low' };
const plain = value => JSON.parse(JSON.stringify(value));
const reply = value => JSON.stringify(value);
const bad = (step, request, value, pattern) => assert.throws(() => step.parse(typeof value === 'string' ? value : reply(value), request), error => error.name === 'ArgumentStepError' && (!pattern || pattern.test(error.message)));
const ok = (step, request, value) => step.parse(reply(value), request);

const datum = (id, over = {}) => ({ id, need: `need of ${id}`, claim: `claim of ${id}`, quote: `quote of ${id} says 9.2 percent`, url: `https://stats.example.org/${id}`, stance: 'supports', ...over });
const PROP = 'Youth unemployment rose in 2024';

// ---- state helpers (same shape the runner will use) ----
const proof = n => ({ url: `https://example.org/${n}`, quote: `quote number ${n} from the page`, claim: `claim ${n}`, check: 'page_match', checkedAt: '2026-11-09T00:00:00.000Z' });
function matched() {
  let s = m.newArgumentMap(roles, 'run-1');
  s = m.applySituationData(s, [{ id: 'd1', need: 'need 1' }, { id: 'd2', need: 'need 2' }]);
  for (const [i, id] of ['d1', 'd2'].entries()) { s = m.beginSituationResearch(s, id); s = m.applySituationEvidence(s, id, { found: true, stance: i ? 'opposes' : 'supports', proof: proof(i + 1) }); }
  return m.applySituationGate(s, { matches: true, reason: 'fits', citedData: ['d1'] });
}
function settle(s, hid, verdict = 'supported') {
  s = m.addNeeds(s, hid, [{ id: `${hid}-n1`, text: `secret need text of ${hid}` }]);
  s = m.beginResearch(s, hid, `${hid}-n1`);
  s = m.applyEvidence(s, hid, `${hid}-n1`, { found: true, stance: 'supports', proof: { ...proof(7), claim: `claim of ${hid}`, quote: `quote of ${hid} is long enough`, url: `https://example.org/${hid}` } });
  return verdict ? m.applyVerdict(s, hid, { verdict, citedNeeds: [`${hid}-n1`], reason: 'because' }) : s;
}
const withHyps = ids => m.applyHypotheses(matched(), ids.map(id => ({ id, citedData: ['d1'] })));

// ---- situation gate ----
const gateReq = { ...base, proposition: PROP, data: [datum('d1'), datum('d2', { stance: 'opposes' })] };
const gateOk = { matches: true, reason: 'd1 says 9.2 percent, which fits', citedData: ['d1'] };

test('gate: a well formed reply parses; opposing data with matches:true is allowed', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(ok(mod.situationGateStep, gateReq, gateOk))), gateOk);
  assert.equal(ok(mod.situationGateStep, gateReq, { ...gateOk, matches: false }).matches, false);
});
test('gate: a citation outside the request, an empty one, or a missing one throws', () => {
  bad(mod.situationGateStep, gateReq, { ...gateOk, citedData: ['d9'] }, /outside/);
  bad(mod.situationGateStep, gateReq, { ...gateOk, citedData: [] }, /at least one/);
  bad(mod.situationGateStep, gateReq, { ...gateOk, matches: false, citedData: [] }, /at least one/);
  bad(mod.situationGateStep, gateReq, { matches: true, reason: 'x' });
  bad(mod.situationGateStep, gateReq, { ...gateOk, citedData: ['d1', 7] });
});
test('gate: a number or URL the request does not have, a non-boolean, an empty reason and extra fields throw', () => {
  bad(mod.situationGateStep, gateReq, { ...gateOk, reason: 'it rose to 11.4 percent' }, /number 11.4/);
  bad(mod.situationGateStep, gateReq, { ...gateOk, reason: 'see https://evil.example.com/x' }, /link/);
  assert.ok(ok(mod.situationGateStep, gateReq, { ...gateOk, reason: 'see https://stats.example.org/d1 for 9.2' }));
  bad(mod.situationGateStep, gateReq, { ...gateOk, matches: 'yes' }, /boolean/);
  bad(mod.situationGateStep, gateReq, { ...gateOk, reason: '  ' });
  bad(mod.situationGateStep, gateReq, { ...gateOk, extra: 1 });
  bad(mod.situationGateStep, gateReq, 'not json');
  bad(mod.situationGateStep, gateReq, '[]');
});
test('gate: gateData refuses (so no AI call) unless every datum is found with proof; it copies only the allowed fields', () => {
  const s = matched();
  const data = mod.gateData(s.situation.data);
  assert.deepEqual(plain(data.map(d => Object.keys(d).sort())), [['claim', 'id', 'need', 'quote', 'stance', 'url'], ['claim', 'id', 'need', 'quote', 'stance', 'url']]);
  const pending = m.applySituationData(m.newArgumentMap(roles, 'r'), [{ id: 'd1', need: 'x' }]);
  assert.throws(() => mod.gateData(pending.situation.data), error => error.name === 'ArgumentStepError');
  assert.throws(() => mod.gateData([]), error => error.name === 'ArgumentStepError');
});
test('gate: the prompt shows only the allowed datum fields, even when the caller passes a richer object', () => {
  const rich = { ...gateReq, data: [{ ...datum('d1'), attempts: 2, reason: 'LEAKED-REASON', proof: { secret: 'LEAKED-PROOF' } }] };
  const prompt = mod.situationGateStep.render(rich);
  assert.doesNotMatch(prompt, /LEAKED/);
  assert.match(prompt, /"id":"d1"/);
  assert.match(prompt, /Youth unemployment rose in 2024/);
});
test('gate: the prompt defines the premise, keeps causal claims out of it, and asks for premise data in citedData', () => {
  for (const language of ['en', 'zh-TW']) {
    const prompt = mod.situationGateStep.render({ ...gateReq, language });
    assert.match(prompt, /premise is the facts about the current situation that the proposition takes for granted/i, language);
    assert.match(prompt, /causal or explanatory claim is not part of the premise/i, language);
    assert.match(prompt, /must not decide this judgement/i, language);
    assert.match(prompt, /matches is true, include data that bear on the premise/i, language);
    const rules = prompt.split('\n\n').slice(1, 3).join('\n');
    assert.doesNotMatch(rules, /\d|https?:/, `${language}: no number or link in the rule text`);
  }
});

// ---- hypotheses ----
const hypReq = { ...base, proposition: PROP, data: [datum('d1'), datum('d2')], count: 3, existing: ['Old idea about hiring'] };
const hyp = (title, ids = ['d1']) => ({ title, statement: `${title} statement`, citedData: ids });
const hypOk = { hypotheses: [hyp('Hiring slowed'), hyp('Entry jobs automated'), hyp('Wages stalled', ['d1', 'd2'])] };

test('hypotheses: exactly the asked number, each citing situation data of the request', () => {
  assert.equal(ok(mod.hypothesesStep, hypReq, hypOk).hypotheses.length, 3);
  bad(mod.hypothesesStep, hypReq, { hypotheses: hypOk.hypotheses.slice(0, 2) }, /exactly 3/);
  bad(mod.hypothesesStep, hypReq, { hypotheses: [...hypOk.hypotheses, hyp('Fourth')] }, /exactly 3/);
  bad(mod.hypothesesStep, hypReq, { hypotheses: [hyp('A'), hyp('B'), hyp('C', ['d9'])] }, /outside/);
  bad(mod.hypothesesStep, hypReq, { hypotheses: [hyp('A'), hyp('B'), hyp('C', [])] }, /at least one/);
});
test('hypotheses: a title that repeats an existing or another hypothesis (after normalising) throws', () => {
  bad(mod.hypothesesStep, hypReq, { hypotheses: [hyp('old IDEA about hiring!'), hyp('B'), hyp('C')] }, /repeats/);
  bad(mod.hypothesesStep, hypReq, { hypotheses: [hyp('B'), hyp('b.'), hyp('C')] }, /repeats/);
});
test('hypotheses: numbers and URLs outside the request throw', () => {
  bad(mod.hypothesesStep, hypReq, { hypotheses: [hyp('A'), hyp('B'), { ...hyp('C'), statement: 'Costs rose 31 percent' }] }, /number 31/);
  bad(mod.hypothesesStep, hypReq, { hypotheses: [hyp('A'), hyp('B'), { ...hyp('C'), statement: 'per https://memory.example.com/a' }] }, /link/);
});

// ---- needs ----
const needReq = { ...base, proposition: PROP, hypothesis: { title: 'Hiring slowed', statement: 'Firms hired fewer juniors', round: 1 }, data: [datum('d1')], existing: [{ text: 'Monthly junior hiring counts', state: 'found' }], max: 2 };
test('needs: 1..max new needs, none repeating an existing one', () => {
  assert.equal(ok(mod.needsStep, needReq, { needs: [{ text: 'Job posting trends for juniors' }] }).needs.length, 1);
  bad(mod.needsStep, needReq, { needs: [] }, /expected 1 to 2/);
  bad(mod.needsStep, needReq, { needs: [{ text: 'a' }, { text: 'b' }, { text: 'c' }] }, /expected 1 to 2/);
  bad(mod.needsStep, needReq, { needs: [{ text: 'monthly JUNIOR hiring counts.' }] }, /repeats/);
  bad(mod.needsStep, needReq, { needs: [{ text: 'x' }, { text: 'X' }] }, /repeats/);
  bad(mod.needsStep, needReq, { needs: [{ text: '' }] });
  bad(mod.needsStep, needReq, { needs: [{ text: 'x', extra: 1 }] });
});
test('needs: a number or URL the request does not have throws; round and max come from the machine limits', () => {
  bad(mod.needsStep, needReq, { needs: [{ text: 'BLS series for 2019' }] }, /number 2019/);
  bad(mod.needsStep, needReq, { needs: [{ text: 'read https://x.example.com' }] }, /link/);
  const s = settle(withHyps(['h1', 'h2', 'h3']), 'h1', 'undecided');
  const h = s.hypotheses.find(x => x.id === 'h1');
  assert.equal(mod.needsAllowed(h), 2);
  assert.equal(mod.needsAllowed({ ...h, needs: [1, 2, 3, 4, 5, 6].map(i => ({ ...h.needs[0], id: `n${i}`, addedRound: 1 })) }), 0);
});

// ---- verdict ----
function verdictFixture() {
  let s = withHyps(['h1', 'h2', 'h3']);
  s = settle(s, 'h2');
  s = settle(s, 'h1', null);
  return { s, input: m.prepareVerdict(s, 'h1') };
}
const vReq = (input, hypothesis = 'Firms hired fewer juniors') => ({ ...base, hypothesis, input });
test('verdict: the input is only that hypothesis\' found evidence; the prompt has no other hypothesis or need text', () => {
  const { s, input } = verdictFixture();
  const prompt = mod.verdictStep.render(vReq(input));
  assert.match(prompt, /claim of h1/);
  for (const hidden of ['claim of h2', 'secret need text of h1', 'secret need text of h2', 'quote of h2']) assert.ok(!prompt.includes(hidden), hidden);
  assert.deepEqual(plain(m.prepareVerdict(s, 'h1').evidence.map(e => Object.keys(e).sort())), [['claim', 'id', 'quote', 'stance', 'url']]);
  const rich = { ...input, evidence: [{ ...input.evidence[0], text: 'LEAKED-NEED', reason: 'LEAKED-REASON' }] };
  assert.doesNotMatch(mod.verdictStep.render(vReq(rich)), /LEAKED/);
});
test('verdict: a cited need outside the input (another hypothesis), an empty citation or an unknown verdict throws', () => {
  const { input } = verdictFixture();
  const req = vReq(input);
  const good = { verdict: 'supported', citedNeeds: ['h1-n1'], reason: 'The claim of h1 is backed' };
  assert.equal(ok(mod.verdictStep, req, good).verdict, 'supported');
  bad(mod.verdictStep, req, { ...good, citedNeeds: ['h2-n1'] }, /outside/);
  bad(mod.verdictStep, req, { ...good, citedNeeds: ['h1-n1', 'h2-n1'] }, /outside/);
  bad(mod.verdictStep, req, { ...good, citedNeeds: [] }, /at least one/);
  bad(mod.verdictStep, req, { ...good, verdict: 'maybe' }, /verdict/);
  bad(mod.verdictStep, req, { ...good, reason: '' });
});
test('verdict: a number or URL the input does not have throws; ones it has pass', () => {
  const input = { hypothesisId: 'h1', round: 1, evidence: [{ id: 'n1', claim: 'Rate was 9.2 percent', quote: 'rate 9.2 percent', url: 'https://stats.example.org/a', stance: 'supports' }] };
  const req = vReq(input);
  const good = { verdict: 'supported', citedNeeds: ['n1'], reason: 'Matches the 9.2 percent at https://stats.example.org/a' };
  assert.ok(ok(mod.verdictStep, req, good));
  bad(mod.verdictStep, req, { ...good, reason: 'It is really 12 percent' }, /number 12/);
  bad(mod.verdictStep, req, { ...good, reason: 'Per https://other.example.com' }, /link/);
});
test('verdict: policy refuses an empty evidence list (the machine refuses earlier)', () => {
  assert.throws(() => sr.prepareStep(mod.verdictStep, vReq({ hypothesisId: 'h1', round: 1, evidence: [] })), error => error.name === 'ArgumentStepError');
  const s = settle(withHyps(['h1', 'h2', 'h3']), 'h1', null);
  const open = m.addNeeds(s, 'h1', [{ id: 'h1-n2', text: 'more' }]);
  assert.throws(() => m.prepareVerdict(open, 'h1'), error => error instanceof m.GateError);
});

// ---- conclusion ----
function conclusionFixture() {
  let s = withHyps(['h1', 'h2', 'h3']);
  for (const id of ['h1', 'h2', 'h3']) s = settle(s, id);
  s = m.applyHypotheses(s, [{ id: 'h4', citedData: ['d1'] }, { id: 'h5', citedData: ['d1'] }]);
  s = m.eliminate(settle(s, 'h4', 'refuted'), 'h4', 'refuted by the evidence');
  s = settle(s, 'h5', null);
  const statements = { h1: 'Hiring slowed', h2: 'Entry jobs automated', h3: 'Wages stalled' };
  return { s, input: m.prepareConclusion(s), statements };
}
const cReq = f => ({ ...base, proposition: PROP, input: f.input, statements: f.statements });
test('conclusion: the input and the prompt hold only verified hypotheses and their evidence', () => {
  const f = conclusionFixture();
  assert.deepEqual(plain(f.input.hypotheses.map(h => h.id)), ['h1', 'h2', 'h3']);
  const prompt = mod.conclusionStep.render(cReq(f));
  assert.match(prompt, /claim of h3/);
  for (const hidden of ['h4', 'h5', 'claim of h4', 'claim of h5', 'secret need text']) assert.ok(!prompt.includes(hidden), hidden);
  assert.throws(() => mod.conclusionStep.render({ ...cReq(f), statements: { h1: 'x' } }), error => error.name === 'ArgumentStepError');
});
test('conclusion: citing an eliminated or still-verifying hypothesis, or none, throws; every point needs hypothesisIds', () => {
  const f = conclusionFixture();
  const req = cReq(f);
  const good = { summary: 'Juniors face a weak market', points: [{ text: 'Hiring slowed', hypothesisIds: ['h1'] }, { text: 'Jobs automated', hypothesisIds: ['h2', 'h3'] }] };
  const parsed = ok(mod.conclusionStep, req, good);
  assert.deepEqual(plain(parsed.basedOn), ['h1', 'h2', 'h3']);
  for (const id of ['h4', 'h5', 'h9']) bad(mod.conclusionStep, req, { ...good, points: [{ text: 'x', hypothesisIds: [id] }] }, /outside/);
  bad(mod.conclusionStep, req, { ...good, points: [{ text: 'x', hypothesisIds: [] }] }, /at least one/);
  bad(mod.conclusionStep, req, { ...good, points: [] }, /at least one point/);
  bad(mod.conclusionStep, req, { ...good, points: [{ text: 'x' }] });
  bad(mod.conclusionStep, req, { ...good, summary: ' ' });
});
test('conclusion: a number or URL outside the input throws; no verified hypothesis the policy refuses (1 or 2 is allowed, decision #59)', () => {
  const f = conclusionFixture();
  const req = cReq(f);
  bad(mod.conclusionStep, req, { summary: 'Unemployment hit 14 percent', points: [{ text: 'x', hypothesisIds: ['h1'] }] }, /number 14/);
  bad(mod.conclusionStep, req, { summary: 's', points: [{ text: 'see https://memory.example.com', hypothesisIds: ['h1'] }] }, /link/);
  const none = { ...req, input: { hypotheses: [] } };
  assert.throws(() => sr.prepareStep(mod.conclusionStep, none), error => error.name === 'ArgumentStepError');
  const s2 = withHyps(['h1', 'h2', 'h3']);
  assert.throws(() => m.prepareConclusion(settle(settle(s2, 'h1'), 'h2')), error => error instanceof m.GateError);
});

// ---- schemas and registry ----
test('every step has a strict schema and the registry maps the machine actions', () => {
  for (const step of [mod.facetPlanStep, mod.situationGateStep, mod.facetJudgeStep, mod.hypothesesStep, mod.facetHypothesesStep, mod.needsStep, mod.verdictStep, mod.facetVerdictStep, mod.conclusionStep]) {
    assert.equal(step.schema.additionalProperties, false);
    assert.deepEqual([...step.schema.required].sort(), Object.keys(step.schema.properties).sort());
  }
  assert.deepEqual(Object.keys(mod.ARGUMENT_STEPS).sort(), ['add_needs', 'conclude', 'judge_facets', 'judge_gate', 'plan_facets', 'propose_facet_hypotheses', 'propose_hypotheses', 'revise', 'verdict']);
  assert.equal(mod.ARGUMENT_STEPS.plan_facets, mod.facetPlanStep);
  assert.equal(mod.ARGUMENT_STEPS.plan_situation, undefined); // the old plan step was removed; plan_facets serves the action
  assert.equal(mod.ARGUMENT_STEPS.revise, mod.needsStep);
  const ids = new Set(Object.values(mod.ARGUMENT_STEPS).map(step => step.id));
  assert.equal(ids.size, 8);
});

// ---- text-only through the real runtimes ----
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
// ---- V1 boost P3: facet judge step ----
const fdatum = (id, over = {}) => ({ id, need: `need of ${id}`, claim: `claim of ${id}`, quote: `quote of ${id} says 9.2 percent`, url: `https://stats.example.org/${id}`, stance: 'supports', ...over });
const fjReq = (over = {}) => ({ ...base, proposition: PROP, round: 1, facets: [
  { id: 'fa', title: 'Level of the rate', criterion: 'Supports when the level of the rate holds', data: [fdatum('a1'), fdatum('a2', { stance: 'opposes' })] },
  { id: 'fb', title: 'Direction of change', criterion: 'Supports when the direction of change holds', data: [fdatum('b1', { stance: 'uncertain', fixedStance: 'irrelevant' })] },
  { id: 'fc', title: 'Who is counted', criterion: 'Supports when the who is counted holds', data: [] }
], ...over });
const fjOk = () => ({
  data: [{ id: 'a1', propStance: 'supports', reason: 'a1 says 9.2 percent' }, { id: 'a2', propStance: 'refutes', reason: 'a2 points the other way' }, { id: 'b1', propStance: 'irrelevant', reason: 'b1 is unclear' }],
  facets: [
    { id: 'fa', verdict: 'supports', reason: 'a1 fits', summary: 'The rate level fits.', citedData: ['a1'], retryNeeds: [] },
    { id: 'fb', verdict: 'insufficient', reason: 'only unclear data', summary: 'Direction is not shown.', citedData: [], retryNeeds: ['Year on year change in the youth rate'] },
    { id: 'fc', verdict: 'insufficient', reason: 'no data', summary: 'Nothing found.', citedData: [], retryNeeds: [] }
  ],
  assumptionInsights: []
});
const fjWith = fn => { const v = fjOk(); fn(v); return v; };
const fjFacet = (v, id) => v.facets.find(f => f.id === id);
test('facet judge: a well formed reply parses and feeds applyFacetVerdicts shape', () => {
  const out = plain(ok(mod.facetJudgeStep, fjReq(), fjOk()));
  assert.deepEqual(out, fjOk());
});
test('facet judge: data ids must be exactly the found ones; facet ids exactly those sent; more than 5 facets refused', () => {
  bad(mod.facetJudgeStep, fjReq(), fjWith(v => { v.data.pop(); }), /every found datum|data/);
  bad(mod.facetJudgeStep, fjReq(), fjWith(v => { v.data.push({ id: 'zz', propStance: 'supports', reason: 'x' }); }), /data/);
  bad(mod.facetJudgeStep, fjReq(), fjWith(v => { v.data[1].id = 'a1'; }), /data/);
  bad(mod.facetJudgeStep, fjReq(), fjWith(v => { v.facets.pop(); }), /facets/);
  bad(mod.facetJudgeStep, fjReq(), fjWith(v => { v.facets[2].id = 'fz'; }), /facets/);
  bad(mod.facetJudgeStep, fjReq({ facets: Array.from({ length: 6 }, (_, i) => ({ id: `x${i}`, title: `T${i}`, data: [] })) }), fjOk(), /5 facets/);
});
test('facet judge: a stance already fixed in the request must come back unchanged; unknown stance refused', () => {
  bad(mod.facetJudgeStep, fjReq(), fjWith(v => { v.data[2].propStance = 'supports'; }), /fixed/);
  bad(mod.facetJudgeStep, fjReq(), fjWith(v => { v.data[0].propStance = 'maybe'; }), /stance/);
});
test('facet judge: citations belong to the facet, are found, not irrelevant, and a supports/refutes verdict cites a same stance datum', () => {
  bad(mod.facetJudgeStep, fjReq(), fjWith(v => { fjFacet(v, 'fa').citedData = ['b1']; }), /cite/);
  bad(mod.facetJudgeStep, fjReq(), fjWith(v => { fjFacet(v, 'fa').citedData = ['zz']; }), /cite/);
  assert.ok(ok(mod.facetJudgeStep, fjReq(), fjWith(v => { fjFacet(v, 'fb').citedData = ['b1']; })), 'a facet with only irrelevant data is left to the machine (M1)');
  bad(mod.facetJudgeStep, fjReq(), fjWith(v => { fjFacet(v, 'fa').citedData = []; }), /same stance|cite/);
  bad(mod.facetJudgeStep, fjReq(), fjWith(v => { fjFacet(v, 'fa').verdict = 'refutes'; }), /same stance/);
  bad(mod.facetJudgeStep, fjReq(), fjWith(v => { fjFacet(v, 'fa').verdict = 'pending'; }), /verdict/);
  assert.ok(ok(mod.facetJudgeStep, fjReq(), fjWith(v => { fjFacet(v, 'fa').verdict = 'refutes'; fjFacet(v, 'fa').citedData = ['a2']; })));
});
test('facet judge: a datum stance without a reason (or a blank one) is refused, so an irrelevant datum never has an empty reason', () => {
  bad(mod.facetJudgeStep, fjReq(), fjWith(v => { v.data[2].reason = ''; }), /reason/);
  bad(mod.facetJudgeStep, fjReq(), fjWith(v => { v.data[2].reason = '   '; }), /reason/);
  bad(mod.facetJudgeStep, fjReq(), fjWith(v => { delete v.data[2].reason; }));
});
test('facet judge: an empty summary or reason is refused', () => {
  bad(mod.facetJudgeStep, fjReq(), fjWith(v => { fjFacet(v, 'fa').summary = ''; }), /summary/);
  bad(mod.facetJudgeStep, fjReq(), fjWith(v => { fjFacet(v, 'fa').summary = '  '; }), /summary/);
  bad(mod.facetJudgeStep, fjReq(), fjWith(v => { fjFacet(v, 'fa').reason = ''; }), /reason/);
  bad(mod.facetJudgeStep, fjReq(), fjWith(v => { delete fjFacet(v, 'fa').summary; }));
});
test('facet judge: a facet with no found data, or only irrelevant data, is not refused for its verdict or citations; the machine forces it', () => {
  const out = plain(ok(mod.facetJudgeStep, fjReq(), fjWith(v => {
    Object.assign(fjFacet(v, 'fc'), { verdict: 'supports', citedData: ['a1'] });
    Object.assign(fjFacet(v, 'fb'), { verdict: 'refutes', citedData: ['b1'], retryNeeds: [] });
  })));
  assert.equal(out.facets.find(f => f.id === 'fc').verdict, 'supports', 'parse leaves forcing to the machine');
  bad(mod.facetJudgeStep, fjReq(), fjWith(v => { Object.assign(fjFacet(v, 'fc'), { verdict: 'supports', reason: ' ' }); }), /reason/);
  bad(mod.facetJudgeStep, fjReq(), fjWith(v => { Object.assign(fjFacet(v, 'fc'), { verdict: 'supports', summary: '' }); }), /summary/);
  // a facet with usable data keeps the full check
  bad(mod.facetJudgeStep, fjReq(), fjWith(v => { fjFacet(v, 'fa').citedData = ['b1']; }), /cite/);
  // the machine will force it insufficient, so retry needs stay allowed in round 1
  assert.ok(ok(mod.facetJudgeStep, fjReq(), fjWith(v => { Object.assign(fjFacet(v, 'fb'), { verdict: 'supports', citedData: [] }); })));
});
test('facet judge: a retry need equal to a need already tried (not found) for a pending facet is refused, and the prompt lists it', () => {
  const req = fjReq({ facets: [{ id: 'fa', title: 'Level of the rate', criterion: 'Supports when the level of the rate holds', data: [fdatum('a1')], notFoundNeeds: ['Rate in the labour force survey'] }, { id: 'fb', title: 'Direction of change', criterion: 'Supports when the direction of change holds', data: [fdatum('b1', { fixedStance: 'irrelevant' })] }, { id: 'fc', title: 'Who is counted', criterion: 'Supports when the who is counted holds', data: [] }] });
  const good = fjWith(v => { v.data = v.data.filter(d => d.id !== 'a2'); fjFacet(v, 'fa').retryNeeds = []; fjFacet(v, 'fb').retryNeeds = ['Year on year change in the youth rate']; });
  assert.ok(ok(mod.facetJudgeStep, req, good));
  const repeat = fjWith(v => { v.data = v.data.filter(d => d.id !== 'a2'); fjFacet(v, 'fa').verdict = 'insufficient'; fjFacet(v, 'fa').citedData = []; fjFacet(v, 'fa').retryNeeds = ['rate in the labour force survey.']; });
  bad(mod.facetJudgeStep, req, repeat, /repeat/);
  const prompt = mod.facetJudgeStep.render(req);
  assert.match(prompt, /Rate in the labour force survey/);
  assert.match(prompt, /already tried/i);
  assert.ok(!mod.facetJudgeStep.render(fjReq()).includes('"notFoundNeeds":['), 'no not-found needs, nothing extra in the prompt');
});
test('facet judge: retryNeeds only on insufficient, only in round 1, at most 3 per facet and 9 in all, grounded', () => {
  bad(mod.facetJudgeStep, fjReq(), fjWith(v => { fjFacet(v, 'fa').retryNeeds = ['Another series']; }), /retry/);
  bad(mod.facetJudgeStep, fjReq({ round: 2 }), fjOk(), /retry/);
  bad(mod.facetJudgeStep, fjReq(), fjWith(v => { fjFacet(v, 'fb').retryNeeds = ['one', 'two', 'three', 'four'].map(x => `Need ${x}`); }), /retry/);
  const wide = fjReq({ facets: ['p', 'q', 'r', 's'].map(id => ({ id, title: `Title ${id}`, data: [] })) });
  const wideOk = n => ({ data: [], facets: ['p', 'q', 'r', 's'].map(id => ({ id, verdict: 'insufficient', reason: 'none', summary: 'none', citedData: [], retryNeeds: ['alpha', 'bravo', 'charlie'].slice(0, n).map(w => `${w} ${id}`) })), assumptionInsights: [] });
  assert.ok(ok(mod.facetJudgeStep, wide, wideOk(2)), '8 in all is fine');
  bad(mod.facetJudgeStep, wide, wideOk(3), /retry/);
  bad(mod.facetJudgeStep, fjReq(), fjWith(v => { fjFacet(v, 'fb').retryNeeds = ['Rate for 2019']; }), /number 2019/);
  bad(mod.facetJudgeStep, fjReq(), fjWith(v => { fjFacet(v, 'fb').retryNeeds = ['see https://x.example.com']; }), /link/);
  bad(mod.facetJudgeStep, fjReq(), fjWith(v => { fjFacet(v, 'fb').retryNeeds = ['Need a', 'need a.']; }), /repeat/);
  assert.ok(ok(mod.facetJudgeStep, fjReq({ round: 2 }), fjWith(v => { fjFacet(v, 'fb').retryNeeds = []; })));
});
test('facet judge: free text may not carry a number or link the request lacks; extra fields refused', () => {
  bad(mod.facetJudgeStep, fjReq(), fjWith(v => { fjFacet(v, 'fa').summary = 'It reached 11.4 percent'; }), /number 11.4/);
  bad(mod.facetJudgeStep, fjReq(), fjWith(v => { v.data[0].reason = 'see https://evil.example.com'; }), /link/);
  bad(mod.facetJudgeStep, fjReq(), fjWith(v => { v.extra = 1; }));
  bad(mod.facetJudgeStep, fjReq(), fjWith(v => { fjFacet(v, 'fa').extra = 1; }));
  bad(mod.facetJudgeStep, fjReq(), 'not json');
});
test('facet judge: the prompt shows only the proposition and the facets; a secret field never appears; round 1 and 2 differ only by the request', () => {
  const prompt = mod.facetJudgeStep.render({ ...fjReq(), secret: 'LEAKED-X' });
  assert.doesNotMatch(prompt, /LEAKED/);
  assert.match(prompt, /Level of the rate/);
  assert.match(prompt, /"fixedStance":"irrelevant"/);
  assert.notEqual(prompt, mod.facetJudgeStep.render(fjReq({ round: 2 })));
  assert.throws(() => sr.prepareStep(mod.facetJudgeStep, fjReq({ facets: [] })), error => error.name === 'ArgumentStepError');
});

// ---- V1 boost P4 (decision #50): hypotheses of a facet map ----
const fhReq = (over = {}) => ({ ...base, proposition: PROP, count: 3, existing: [], causalQuestions: ['Did automation drive the rise?'],
  data: [datum('d1', { propStance: 'supports' }), datum('d2', { propStance: 'supports' }), datum('d3', { propStance: 'irrelevant' }), datum('d4', { propStance: 'refutes' })], ...over });
const fh = (title, over = {}) => ({ title, statement: `${title} statement`, basis: `From d1 we observe the rate, so we guess ${title}`, alternative: false, citedData: ['d1'], ...over });
const fhOk = () => ({ hypotheses: [fh('Hiring slowed'), fh('Entry jobs automated'), fh('Wages stalled', { alternative: true, citedData: ['d1', 'd2'] })] });
const fhWith = fn => { const v = fhOk(); fn(v); return v; };
test('facet hypotheses: a well formed reply parses with basis and alternative; the old step keeps its V1 schema and parser', () => {
  assert.deepEqual(plain(ok(mod.facetHypothesesStep, fhReq(), fhOk())), fhOk());
  assert.deepEqual(Object.keys(mod.hypothesesStep.schema.properties.hypotheses.items.properties), ['title', 'statement', 'citedData']);
  assert.deepEqual(plain(ok(mod.hypothesesStep, hypReq, hypOk)), hypOk);
  bad(mod.hypothesesStep, hypReq, { hypotheses: hypOk.hypotheses.map(h => ({ ...h, basis: 'x' })) });
  assert.deepEqual(Object.keys(mod.facetHypothesesStep.schema.properties.hypotheses.items.properties), ['title', 'statement', 'basis', 'alternative', 'citedData']);
  assert.equal(mod.ARGUMENT_STEPS.propose_facet_hypotheses, mod.facetHypothesesStep);
});
test('facet hypotheses: an empty or missing basis, or a non-boolean alternative, is refused', () => {
  bad(mod.facetHypothesesStep, fhReq(), fhWith(v => { v.hypotheses[0].basis = ''; }), /basis/);
  bad(mod.facetHypothesesStep, fhReq(), fhWith(v => { v.hypotheses[0].basis = '  '; }), /basis/);
  bad(mod.facetHypothesesStep, fhReq(), fhWith(v => { delete v.hypotheses[0].basis; }));
  bad(mod.facetHypothesesStep, fhReq(), fhWith(v => { v.hypotheses[0].alternative = 'yes'; }), /alternative/);
  bad(mod.facetHypothesesStep, fhReq(), fhWith(v => { v.hypotheses[0].basis = 'we guess 11.4 percent'; }), /number 11.4/);
});
test('facet hypotheses: citing irrelevant or refuting data is refused', () => {
  bad(mod.facetHypothesesStep, fhReq(), fhWith(v => { v.hypotheses[0].citedData = ['d3']; }), /support/);
  bad(mod.facetHypothesesStep, fhReq(), fhWith(v => { v.hypotheses[0].citedData = ['d4']; }), /support/);
  bad(mod.facetHypothesesStep, fhReq(), fhWith(v => { v.hypotheses[0].citedData = ['d1', 'd4']; }), /support/);
});
test('facet hypotheses: the first batch needs one alternative; a later (replacement) batch does not', () => {
  bad(mod.facetHypothesesStep, fhReq(), fhWith(v => { v.hypotheses[2].alternative = false; }), /alternative/);
  assert.ok(ok(mod.facetHypothesesStep, fhReq({ existing: ['Earlier hypothesis'], count: 1 }), { hypotheses: [fh('Replacement idea')] }));
});
test('facet hypotheses: a title equal to a causal question (after folding) is refused; the question is shown as a question, not a hypothesis', () => {
  bad(mod.facetHypothesesStep, fhReq(), fhWith(v => { v.hypotheses[0].title = 'did AUTOMATION drive the rise'; }), /causal question/);
  const prompt = mod.facetHypothesesStep.render(fhReq());
  assert.match(prompt, /Did automation drive the rise\?/);
  assert.match(prompt, /not candidate hypotheses/);
  assert.match(prompt, /"propStance":"supports"/);
  assert.match(prompt, /one hypothesis whose alternative is true/);
});

const stepCases = () => {
  const f = conclusionFixture();
  const v = verdictFixture();
  return [
    ['gate', mod.situationGateStep, gateReq, gateOk],
    ['facet-judge', mod.facetJudgeStep, fjReq(), fjOk()],
    ['facet-hypotheses', mod.facetHypothesesStep, fhReq(), fhOk()],
    ['hypotheses', mod.hypothesesStep, hypReq, hypOk],
    ['needs', mod.needsStep, needReq, { needs: [{ text: 'Job posting trends for juniors' }] }],
    ['verdict', mod.verdictStep, vReq(v.input), { verdict: 'supported', citedNeeds: ['h1-n1'], reason: 'The claim of h1 is backed' }],
    ['conclusion', mod.conclusionStep, cReq(f), { summary: 'ok', points: [{ text: 'p', hypothesisIds: ['h1'] }] }]
  ];
};
test('all six steps on Claude: textOnly and searchBudget 0 reach the runtime, args carry --tools "" and no web tool, the reply is parsed', async () => {
  for (const [name, step, request, answer] of stepCases()) {
    const spawned = [];
    const claude = S.load('ai/runtime/claude-code-cli.ts', { 'node:child_process': { spawn: claudeChild(spawned, answer) } });
    const runtime = new claude.ClaudeCodeCliRuntime({ executable: 'claude', cwd: '/plugin', env: {}, spawn: claudeChild(spawned, answer) });
    const calls = new mod.AiCalls({ runtimeFor: model => mod.aiRuntimeForModel(model, { claude: () => runtime, codex: () => { throw new Error('unexpected codex'); } }), exchanges: () => null });
    const runner = mod.providerArgumentRunner(calls);
    const out = await mod.askArgumentStep(step, request, runner, new AbortController().signal);
    assert.ok(out, name);
    assert.equal(spawned.length, 1, name);
    const args = spawned[0];
    assert.equal(args[args.indexOf('--tools') + 1], '', `${name}: --tools ""`);
    assert.ok(!args.includes('--allowedTools'), name);
    assert.ok(!args.some(a => /WebSearch|WebFetch/.test(a)), name);
    assert.ok(args.includes('--json-schema'), name);
  }
});
test('all six steps on Codex: web_search is disabled in the thread config and the shell tool is off', async () => {
  for (const [name, step, request, answer] of stepCases()) {
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
test('a reply that cites outside the input fails inside the runner (nothing is accepted)', async () => {
  const spawned = [];
  const answer = { ...gateOk, citedData: ['d9'] };
  const claude = S.load('ai/runtime/claude-code-cli.ts');
  const runtime = new claude.ClaudeCodeCliRuntime({ executable: 'claude', cwd: '/plugin', env: {}, spawn: claudeChild(spawned, answer) });
  const calls = new mod.AiCalls({ runtimeFor: model => mod.aiRuntimeForModel(model, { claude: () => runtime, codex: () => { throw new Error('x'); } }), exchanges: () => null });
  await assert.rejects(mod.askArgumentStep(mod.situationGateStep, gateReq, mod.providerArgumentRunner(calls), new AbortController().signal), error => error.name === 'ArgumentStepError');
});


// ---- V1 boost P2: facet plan step and the causal input of the hypotheses step ----
const fpReq = { ...base, proposition: PROP };
const fneed = (need, kind = 'fact') => ({ need, kind });
const fpOk = () => ({
  assumptions: { items: [
    { label: 'Age band', value: 'ages 16 to 24 for the years 2023 to 2024', reason: 'the proposition names young people' },
    { label: 'Baselines', value: 'the overall rate in the same period; the rate of the same age band before the pandemic', reason: 'a level claim needs something to compare with' }
  ] },
  facets: [
    { title: 'Level of the rate', criterion: 'Supports: the youth rate is above the overall rate in the same period. Refutes: it is at or below it.', baseline: 'The overall rate in the same period', needs: [fneed('Official youth unemployment rate series'), fneed('Survey notes on the rate')] },
    { title: 'Direction of change', criterion: 'Supports: the youth rate is higher than the same age band before the pandemic. Refutes: it is lower.', baseline: 'the rate of the same age band before the pandemic', needs: [fneed('Year on year change in the youth rate')] },
    { title: 'Who is counted', criterion: 'Supports: the agency counts the young people the proposition means.', baseline: '', needs: [fneed('Definition of unemployed used by the agency'), fneed('Why the labour force survey changed', 'cause')] }
  ],
  causalQuestions: ['Did automation drive the rise?'],
  question: 'Did youth unemployment rise in 2024?'
});
const fpWith = fn => { const v = fpOk(); fn(v); return v; };

test('facet plan: a well formed reply parses; ids are not in the output; cause needs move to causalQuestions and build no data', () => {
  const out = plain(ok(mod.facetPlanStep, fpReq, fpOk()));
  assert.deepEqual(Object.keys(out).sort(), ['assumptions', 'causalQuestions', 'definitionNeeds', 'facets', 'question']);
  assert.equal(out.question, 'Did youth unemployment rise in 2024?');
  assert.equal(out.facets.length, 3);
  assert.deepEqual(out.facets[2].needs, [{ need: 'Definition of unemployed used by the agency' }]);
  assert.deepEqual(out.causalQuestions, ['Why the labour force survey changed', 'Did automation drive the rise?'], 'cause needs first, then the explicit questions');
  assert.equal(out.facets.reduce((n, f) => n + f.needs.length, 0), 4, 'the cause need is not a datum');
  assert.equal(out.assumptions.items.length, 2);
  assert.deepEqual(plain(ok(mod.facetPlanStep, fpReq, fpWith(v => { v.assumptions = { items: [] }; v.facets.forEach(f => { f.baseline = ''; }); }))).assumptions, { items: [] });
});
// Real claude:haiku replies (ids 5aaf3f5e, 6633f1f1, 752a4543) the parser wrongly refused for 「紐西蘭治安相比20年前, 是不是有變差了」.
const liveNzFixture = name => require('node:fs').readFileSync(require('node:path').join(__dirname, 'fixtures', `facet-plan-nz-${name}.json`), 'utf8');
const liveNzReq = { ...base, language: 'zh-TW', proposition: '紐西蘭治安相比20年前, 是不是有變差了', today: '2026-11-11' };
test('facet plan: real replies that restate a stated year range, use a year inside it, or write the date before a fullwidth comma are accepted', () => {
  for (const name of ['baseline-restates-range', 'year-inside-range', 'date-with-fullwidth-comma']) assert.doesNotThrow(() => mod.facetPlanStep.parse(liveNzFixture(name), liveNzReq), name);
});
test('facet plan: a number outside the request and outside every stated range is still refused; a wide span or another range grounds nothing', () => {
  const real = JSON.parse(liveNzFixture('year-inside-range'));
  const invented = JSON.parse(JSON.stringify(real)); invented.facets[0].criterion += ' 11202 cases';
  bad(mod.facetPlanStep, liveNzReq, invented, /11202/);
  const outside = JSON.parse(JSON.stringify(real)); outside.facets[0].criterion += ' 2009';
  bad(mod.facetPlanStep, liveNzReq, outside, /2009/);
  const wide = JSON.parse(JSON.stringify(real)); wide.assumptions.items[3].value = '1980至2007年前後的範圍'; wide.assumptions.items[3].reason = '以2025年回推20年約為2005年';
  bad(mod.facetPlanStep, liveNzReq, wide, /2005/);
  const unrelated = JSON.parse(liveNzFixture('baseline-restates-range')); unrelated.facets[0].baseline = '約1990至1994年的每十萬人警方紀錄犯罪率';
  bad(mod.facetPlanStep, liveNzReq, unrelated, /baseline/);
});
test('facet plan: the output feeds applySituationPlan (the ids come from the program)', () => {
  const out = ok(mod.facetPlanStep, fpReq, fpOk());
  const plan = { assumptions: { id: 'as', items: out.assumptions.items }, facets: out.facets.map((f, i) => ({ id: `f${i}`, title: f.title, criterion: f.criterion, baseline: f.baseline, needs: f.needs.map((n, j) => ({ id: `f${i}d${j}`, need: n.need })) })), causalQuestions: out.causalQuestions, questionType: 'fact' };
  assert.equal(m.applySituationPlan(m.newArgumentMap(roles, 'r'), plan).situation.data.length, 4);
});
// ---- sem3: baseline-type facets (criterion, baseline, definition needs) ----
test('sem3 facet plan: every facet needs a non-empty criterion', () => {
  bad(mod.facetPlanStep, fpReq, fpWith(v => { delete v.facets[0].criterion; }), /criterion/);
  bad(mod.facetPlanStep, fpReq, fpWith(v => { v.facets[1].criterion = '  '; }), /criterion/);
  bad(mod.facetPlanStep, fpReq, fpWith(v => { v.facets[2].criterion = ''; }), /criterion/);
  assert.equal(ok(mod.facetPlanStep, fpReq, fpOk()).facets[0].criterion.startsWith('Supports:'), true);
});
test('sem3 facet plan: a baseline must equal (normalized) an assumption value or one listed phrase of it', () => {
  bad(mod.facetPlanStep, fpReq, fpWith(v => { v.facets[0].baseline = 'the rate of the over 25s'; }), /baseline/);
  assert.ok(ok(mod.facetPlanStep, fpReq, fpWith(v => { v.facets[0].baseline = 'THE overall rate, in the same period!'; })), 'case and punctuation are normalized away');
  assert.ok(ok(mod.facetPlanStep, fpReq, fpWith(v => { v.facets[1].baseline = 'ages 16 to 24 for the years 2023 to 2024'; })), 'a whole item value');
  bad(mod.facetPlanStep, fpReq, fpWith(v => { v.assumptions.items = []; }), /baseline/);
  bad(mod.facetPlanStep, fpReq, fpWith(v => { delete v.facets[0].baseline; }), /baseline/);
  assert.equal(ok(mod.facetPlanStep, fpReq, fpOk()).facets[2].baseline, undefined, 'an empty baseline is not carried');
});
test('sem3 facet plan: a definition need builds no datum, is kept for the definitions card, and the facet still needs a fact need', () => {
  const out = ok(mod.facetPlanStep, fpReq, fpWith(v => { v.facets[2].needs.push(fneed('How the agency defines the youth group', 'definition')); }));
  assert.deepEqual(plain(out.definitionNeeds), ['How the agency defines the youth group']);
  assert.equal(out.facets.reduce((n, f) => n + f.needs.length, 0), 4, 'no datum for the definition need');
  bad(mod.facetPlanStep, fpReq, fpWith(v => { v.facets[1].needs = [fneed('How is it measured', 'definition')]; }), /1 to 3/);
  bad(mod.facetPlanStep, fpReq, fpWith(v => { v.facets[1].needs.push(fneed('official youth unemployment rate series', 'definition')); }), /repeats/);
  const plan = { assumptions: { id: 'as', items: out.assumptions.items }, definitionNeeds: out.definitionNeeds, facets: out.facets.map((f, i) => ({ id: `f${i}`, title: f.title, criterion: f.criterion, baseline: f.baseline, needs: f.needs.map((n, j) => ({ id: `f${i}d${j}`, need: n.need })) })), causalQuestions: out.causalQuestions, questionType: 'fact' };
  const state = m.applySituationPlan(m.newArgumentMap(roles, 'r'), plan);
  assert.equal(state.situation.data.length, 4);
  assert.deepEqual(plain(state.situation.assumptions.definitionNeeds), ['How the agency defines the youth group']);
  assert.equal(state.situation.facets[0].criterion, out.facets[0].criterion);
  assert.equal(state.situation.facets[0].baseline, 'The overall rate in the same period');
});
test('sem3 facet plan: the prompt asks for one facet per baseline and no longer lists trend/subgroups/measurement as default facets', () => {
  const prompt = mod.facetPlanStep.render(fpReq);
  assert.doesNotMatch(prompt, /the trend, the comparison groups, how it is measured/);
  assert.match(prompt, /criterion/);
  assert.match(prompt, /one facet per comparison baseline/);
  assert.match(prompt, /"definition"/);
});
test('facet plan: after the cause needs leave, a facet without a fact need or fewer than 3 facets throws', () => {
  bad(mod.facetPlanStep, fpReq, fpWith(v => { v.facets[1].needs = [fneed('Why did it change', 'cause')]; }), /at least one|1 to 3/);
  bad(mod.facetPlanStep, fpReq, fpWith(v => { v.facets.pop(); }), /3 to 5/);
  bad(mod.facetPlanStep, fpReq, fpWith(v => { v.facets = []; }), /3 to 5/);
});
test('facet plan: 6 facets, 16 fact needs, and 0 or 4 fact needs in one facet are refused', () => {
  bad(mod.facetPlanStep, fpReq, fpWith(v => { for (const t of ['Fourth', 'Fifth', 'Sixth']) v.facets.push({ title: t, criterion: 'Supports when it holds.', baseline: '', needs: [fneed(`need of ${t}`)] }); }), /3 to 5/);
  const W = ['alpha', 'bravo', 'charlie', 'delta', 'echo'];
  const many = i => Array.from({ length: 3 }, (_, k) => fneed(`distinct need ${W[i]} ${W[k]}`));
  const five = extra => ({ ...fpOk(), facets: Array.from({ length: 5 }, (_, i) => ({ title: `Title ${W[i]}`, criterion: 'Supports when it holds.', baseline: '', needs: i === 4 ? many(i).slice(0, extra) : many(i) })) });
  assert.ok(ok(mod.facetPlanStep, fpReq, five(3)), '15 needs are fine');
  const sixteen = five(3); sixteen.facets[4].needs.push(fneed('one more need'));
  bad(mod.facetPlanStep, fpReq, sixteen, /1 to 3|at most 15/);
  bad(mod.facetPlanStep, fpReq, fpWith(v => { v.facets[0].needs = []; }), /1 to 3/);
  bad(mod.facetPlanStep, fpReq, fpWith(v => { v.facets[0].needs = W.slice(0, 4).map(i => fneed(`extra need ${i}`)); }), /1 to 3/);
});
test('facet plan: an unknown kind, a repeated title or need, a blank text, extra fields and non JSON throw', () => {
  bad(mod.facetPlanStep, fpReq, fpWith(v => { v.facets[0].needs[0].kind = 'opinion'; }), /kind/);
  bad(mod.facetPlanStep, fpReq, fpWith(v => { v.facets[1].title = 'level of the RATE!'; }), /repeats/);
  bad(mod.facetPlanStep, fpReq, fpWith(v => { v.facets[1].needs[0].need = 'official youth unemployment rate series.'; }), /repeats/);
  bad(mod.facetPlanStep, fpReq, fpWith(v => { v.facets[1].title = ' '; }));
  bad(mod.facetPlanStep, fpReq, fpWith(v => { v.assumptions.items[0].label = ''; }));
  bad(mod.facetPlanStep, fpReq, fpWith(v => { v.extra = 1; }));
  bad(mod.facetPlanStep, fpReq, fpWith(v => { v.facets[0].id = 'f1'; }));
  bad(mod.facetPlanStep, fpReq, 'not json');
});
test('facet plan: an assumption value may carry years (not checked) but not a link; needs, titles and causal questions are checked as before', () => {
  assert.ok(ok(mod.facetPlanStep, fpReq, fpWith(v => { v.assumptions.items[0].value = 'ages 16 to 24 in 2019'; })));
  bad(mod.facetPlanStep, fpReq, fpWith(v => { v.assumptions.items[0].value = 'per https://memory.example.com/a'; }), /link/);
  bad(mod.facetPlanStep, fpReq, fpWith(v => { v.facets[0].needs[0].need = 'Rate series for 2019'; }), /number 2019/);
  bad(mod.facetPlanStep, fpReq, fpWith(v => { v.facets[0].title = 'Rate in 2019'; }), /number 2019/);
  bad(mod.facetPlanStep, fpReq, fpWith(v => { v.causalQuestions = ['Did the 2008 crisis do it?']; }), /number 2008/);
  bad(mod.facetPlanStep, fpReq, fpWith(v => { v.facets[1].needs[0].need = 'see https://x.example.com'; }), /link/);
  bad(mod.facetPlanStep, fpReq, fpWith(v => { v.facets[1].needs.push(fneed('Why in 2008', 'cause')); }), /number 2008/);
  bad(mod.facetPlanStep, fpReq, fpWith(v => { v.assumptions.items[0].reason = 'because of 2008'; }), /number 2008/);
});
test('facet plan: the prompt shows only the proposition; the secret field of a richer request never appears', () => {
  const prompt = mod.facetPlanStep.render({ ...fpReq, secret: 'LEAKED-X' });
  assert.doesNotMatch(prompt, /LEAKED/);
  assert.match(prompt, /Youth unemployment rose in 2024/);
  assert.match(prompt, /"kind"/);
  assert.equal(sr.prepareStep(mod.facetPlanStep, fpReq).prompt.length > 100, true);
});



// ---- V1 boost P4b: question, preset assumptions, assumption insights, verdict insights ----
test('facet plan: the question is required, non blank, a plain string and grounded in the proposition', () => {
  bad(mod.facetPlanStep, fpReq, fpWith(v => { delete v.question; }), /unexpected fields/);
  bad(mod.facetPlanStep, fpReq, fpWith(v => { v.question = '   '; }), /non-empty/);
  bad(mod.facetPlanStep, fpReq, fpWith(v => { v.question = 5; }), /non-empty/);
  bad(mod.facetPlanStep, fpReq, fpWith(v => { v.question = 'Did the rate rise in 2019?'; }), /number 2019/);
  bad(mod.facetPlanStep, fpReq, fpWith(v => { v.question = 'See https://x.example.com'; }), /link/);
  assert.equal(ok(mod.facetPlanStep, fpReq, fpWith(v => { v.question = '  Did the rate rise?  '; })).question, 'Did the rate rise?');
  assert.ok(mod.FACET_PLAN_SCHEMA.required.includes('question'));
});
// ---- V1 boost semantic fix: the situation answers only the fact; causes go to hypotheses (decisions #36 A1/A2, #38) ----
test('facet plan: a causal question is refused (zh-TW, zh-CN, en)', () => {
  for (const q of ['Is youth unemployment high because of automation?', 'Is it caused by AI?', 'Is it due to AI?', 'Is it driven by AI?', 'What is the reason for the rise?', '失業率偏高是否由AI造成？', '失業率偏高的原因？', '失业率偏高是否由AI导致？', '因为AI吗？'])
    bad(mod.facetPlanStep, fpReq, fpWith(v => { v.question = q; }), /only the factual claim/);
});
test('facet plan: a facet whose title is causal is dropped; fewer than 3 facets left throws', () => {
  const four = fpWith(v => { v.facets.push({ title: 'Other reasons for the rise', criterion: 'c', baseline: '', needs: [fneed('Candidate list')] }); });
  const out = ok(mod.facetPlanStep, fpReq, four);
  assert.equal(out.facets.length, 3);
  assert.ok(!out.facets.some(f => /reasons/.test(f.title)));
  const caused = fpWith(v => { v.facets.push({ title: 'What caused the change', criterion: 'c', baseline: '', needs: [fneed('Change series')] }); });
  assert.deepEqual(plain(ok(mod.facetPlanStep, fpReq, caused)).facets.map(f => f.title), ['Level of the rate', 'Direction of change', 'Who is counted']);
  bad(mod.facetPlanStep, fpReq, fpWith(v => { v.facets[1].title = '導致失業的職業'; }), /3 to 5/);
  bad(mod.facetPlanStep, fpReq, fpWith(v => { v.facets[1].title = '失业的原因'; }), /3 to 5/);
});
test('facet plan: a fact need with a causal marker moves to causalQuestions and builds no datum', () => {
  const out = plain(ok(mod.facetPlanStep, fpReq, fpWith(v => { v.facets[0].needs.push(fneed('Share of the rise that is due to automation')); })));
  assert.deepEqual(out.facets[0].needs.map(n => n.need), ['Official youth unemployment rate series', 'Survey notes on the rate']);
  assert.ok(out.causalQuestions.includes('Share of the rise that is due to automation'));
  const zh = plain(ok(mod.facetPlanStep, fpReq, fpWith(v => { v.facets[0].needs.push(fneed('造成上升的因素')); })));
  assert.ok(zh.causalQuestions.includes('造成上升的因素'));
});
test('facet plan: the marker lists cover zh-TW, zh-CN and en; the prompt tells the facets to be sub-aspects of the fact', () => {
  const lists = mod.CAUSAL_MARKERS;
  for (const word of ['造成', '導致', '引起', '原因', '因為', '是否由']) assert.ok(lists.traditional.includes(word), word);
  for (const word of ['造成', '导致', '引起', '原因', '因为', '是否由']) assert.ok(lists.simplified.includes(word), word);
  for (const word of ['cause', 'caused', 'because', 'due to', 'driven by', 'reason']) assert.ok(lists.en.includes(word), word);
  assert.match(mod.facetPlanStep.render(fpReq), /sub-claim of the FACT[\s\S]*never a cause/);
  for (const word of ['why', '為什麼', '为什么', '由於', '由于', '成因', '歸因', '归因']) assert.ok(mod.CAUSAL_MARKERS.traditional.includes(word) || mod.CAUSAL_MARKERS.simplified.includes(word) || mod.CAUSAL_MARKERS.en.includes(word), word);
  for (const q of ['Why is youth unemployment high?', '為什麼失業率偏高？', '为什么失业率偏高？', '失業率偏高由於AI？', '失业率偏高由于AI？', '失業率偏高的成因？', '失業率偏高的歸因？', '失业率偏高的归因？'])
    bad(mod.facetPlanStep, fpReq, fpWith(v => { v.question = q; }), /only the factual claim/);
  assert.ok(!/factors?\b|因素/.test(mod.CAUSAL_MARKERS.traditional.join()), 'the too-broad 因素 stays out');
});
test('facet plan: the number rule matches the grounding (proposition, assumption values or today\'s date), not "only the proposition"', () => {
  const prompt = mod.facetPlanStep.render(fpReq);
  assert.match(prompt, /only numbers that appear in the proposition, the assumption values or today's date/);
  assert.doesNotMatch(prompt, /numbers and links that appear in the proposition\./);
});
test('facet judge: the prompt carries the scope rule (judged against the claim within the card scope; prompt-only, not program-checkable)', () => {
  const prompt = mod.facetJudgeStep.render(fjReq());
  assert.match(prompt, /WITHIN the scope of the assumption card/);
  assert.match(prompt, /different subgroup[\s\S]*"irrelevant"[\s\S]*scope difference/);
  assert.match(prompt, /"refutes" only when a datum inside the scope contradicts/);
});
test('facet plan: a relative or current period is "the latest published year" and a baseline is a range around the point (prompt-only, not program-checkable)', () => {
  const prompt = mod.facetPlanStep.render(fpReq);
  assert.match(prompt, /relative or current period[\s\S]*latest published year[\s\S]*not today's calendar year/);
  assert.match(prompt, /about 20 years ago[\s\S]*span of a few years around it/);
  assert.match(prompt, /written as such in the assumption value/);
});
test('facet judge: a datum in the assumption period range or the nearest period within a few years is in scope, and the reason names the gap (prompt-only, not program-checkable)', () => {
  for (const step of [mod.facetJudgeStep]) {
    const prompt = step.render(fjReq());
    assert.match(prompt, /Period rule[\s\S]*inside the range of the assumption[\s\S]*nearest available period[\s\S]*within a few years[\s\S]*IN scope/);
    assert.match(prompt, /reason must say the period gap in plain words/);
    assert.match(prompt, /different place, population or measure, or a period clearly outside the range/);
  }
});
const preset = [{ label: 'Age band', value: 'ages 25 to 34, 2018 to 2019', reason: 'edited by the owner' }];
test('facet plan: preset assumptions replace the AI assumption card; without them the AI card stays; the prompt shows them only when given', () => {
  const withPreset = { ...fpReq, presetAssumptions: preset };
  const noBase = fn => fpWith(v => { v.facets.forEach(f => { f.baseline = ''; }); fn(v); });
  assert.deepEqual(plain(ok(mod.facetPlanStep, withPreset, noBase(() => {})).assumptions), { items: preset });
  assert.deepEqual(plain(ok(mod.facetPlanStep, withPreset, noBase(v => { v.assumptions = { items: [] }; })).assumptions), { items: preset });
  // the baseline is checked against the preset the owner kept, not against the AI card
  bad(mod.facetPlanStep, withPreset, fpOk(), /baseline/);
  assert.equal(ok(mod.facetPlanStep, fpReq, fpOk()).assumptions.items[0].label, 'Age band');
  assert.notEqual(ok(mod.facetPlanStep, fpReq, fpOk()).assumptions.items[0].value, preset[0].value);
  assert.match(mod.facetPlanStep.render(withPreset), /ages 25 to 34, 2018 to 2019/);
  assert.doesNotMatch(mod.facetPlanStep.render(fpReq), /ages 25 to 34/);
  assert.doesNotMatch(mod.facetPlanStep.render({ ...fpReq, presetAssumptions: [] }), /fixed by the owner/);
  assert.equal(mod.facetPlanStep.render({ ...fpReq, presetAssumptions: [] }), mod.facetPlanStep.render(fpReq));
  // The preset is a program value: a malformed one is refused before any call.
  for (const presetAssumptions of [[{ label: '', value: 'v', reason: 'r' }], [{ label: 'l', value: 'v' }], 'x', [{ label: 'l', value: 'v', reason: 'r', extra: 1 }]])
    assert.throws(() => sr.prepareStep(mod.facetPlanStep, { ...fpReq, presetAssumptions }), error => error.name === 'ArgumentStepError');
});

const withAssumptions = { assumptions: [{ label: 'Age band', value: 'ages 16 to 24 in 2023 to 2024', reason: 'young people' }] };
test('facet judge: assumptionInsights are 0 to 3 texts, empty when the request has no assumption card, grounded', () => {
  // no assumption card: must be empty
  bad(mod.facetJudgeStep, fjReq(), fjWith(v => { v.assumptionInsights = ['The age band matters']; }), /assumption/);
  assert.deepEqual(plain(ok(mod.facetJudgeStep, fjReq(), fjOk()).assumptionInsights), []);
  // with a card: 0 to 3
  const req = fjReq(withAssumptions);
  assert.deepEqual(plain(ok(mod.facetJudgeStep, req, fjWith(v => { v.assumptionInsights = ['The age band narrows the data', 'The period fits']; })).assumptionInsights), ['The age band narrows the data', 'The period fits']);
  assert.deepEqual(plain(ok(mod.facetJudgeStep, req, fjOk()).assumptionInsights), []);
  bad(mod.facetJudgeStep, req, fjWith(v => { v.assumptionInsights = ['a', 'b', 'c', 'd']; }), /assumption/);
  bad(mod.facetJudgeStep, req, fjWith(v => { v.assumptionInsights = ['  ']; }), /non-empty/);
  bad(mod.facetJudgeStep, req, fjWith(v => { v.assumptionInsights = [5]; }), /non-empty/);
  bad(mod.facetJudgeStep, req, fjWith(v => { v.assumptionInsights = ['Rate was 77 percent']; }), /number 77/);
  bad(mod.facetJudgeStep, req, fjWith(v => { delete v.assumptionInsights; }), /unexpected fields/);
  assert.ok(mod.FACET_JUDGE_SCHEMA.required.includes('assumptionInsights'));
  assert.match(mod.facetJudgeStep.render(req), /ages 16 to 24 in 2023 to 2024/);
  assert.doesNotMatch(mod.facetJudgeStep.render(fjReq()), /Age band/);
});

const fvReq = (input, over = {}) => ({ ...vReq(input), ...over });
const fvGood = { verdict: 'supported', citedNeeds: ['n1'], reason: 'Matches the 9.2 percent', insights: [{ kind: 'consistent', text: 'The data agree on 9.2 percent' }] };
const fvInput = { hypothesisId: 'h1', round: 1, evidence: [{ id: 'n1', claim: 'Rate was 9.2 percent', quote: 'rate 9.2 percent', url: 'https://stats.example.org/a', stance: 'supports' }] };
test('facet verdict: insights are 1 to 3 of consistent, tension or missing; the old verdict step keeps its V1 schema, parser and prompt', () => {
  const req = fvReq(fvInput);
  assert.equal(ok(mod.facetVerdictStep, req, fvGood).insights.length, 1);
  const three = ['consistent', 'tension', 'missing'].map(kind => ({ kind, text: `${kind} point about 9.2 percent` }));
  assert.equal(ok(mod.facetVerdictStep, req, { ...fvGood, insights: three }).insights.length, 3);
  bad(mod.facetVerdictStep, req, { ...fvGood, insights: [] }, /insights/);
  bad(mod.facetVerdictStep, req, { ...fvGood, insights: [...three, three[0]] }, /insights/);
  bad(mod.facetVerdictStep, req, { ...fvGood, insights: undefined }, /unexpected fields/);
  bad(mod.facetVerdictStep, req, { ...fvGood, insights: 'x' }, /insights/);
  bad(mod.facetVerdictStep, req, { ...fvGood, insights: [{ kind: 'other', text: 'x' }] }, /kind/);
  bad(mod.facetVerdictStep, req, { ...fvGood, insights: [{ kind: 'missing', text: ' ' }] }, /non-empty/);
  bad(mod.facetVerdictStep, req, { ...fvGood, insights: [{ kind: 'missing', text: 'It was 12 percent' }] }, /number 12/);
  bad(mod.facetVerdictStep, req, { ...fvGood, insights: [{ kind: 'missing', text: 'x', extra: 1 }] }, /unexpected fields/);
  bad(mod.facetVerdictStep, req, { ...fvGood, citedNeeds: ['n9'] }, /outside/);
  assert.ok(mod.FACET_VERDICT_SCHEMA.required.includes('insights'));
  // the V1 step is untouched: no insights in its schema, and an insights reply is refused by it
  assert.equal('insights' in mod.verdictStep.schema.properties, false);
  const { insights, ...old } = fvGood;
  assert.ok(ok(mod.verdictStep, req, old));
  bad(mod.verdictStep, req, fvGood, /unexpected fields/);
  assert.notEqual(mod.facetVerdictStep.render(req), mod.verdictStep.render(req));
  assert.throws(() => sr.prepareStep(mod.facetVerdictStep, fvReq({ hypothesisId: 'h1', round: 1, evidence: [] })), error => error.name === 'ArgumentStepError');
});
// ---- V1 boost live run 2: baseline rule and round 2 request shape ----
test('facet judge prompt: baseline data of the card are in scope for the comparing facet', () => {
  const prompt = mod.facetJudgeStep.render(fjReq());
  assert.match(prompt, /Baseline rule/);
  assert.match(prompt, /IN scope for the facet that compares against that baseline/);
  assert.match(prompt, /do NOT serve as its baseline/);
});
test('facet judge round 2 request: fixed stances are marked copy exactly and every existing need is listed as already asked', () => {
  const req = fjReq({ round: 2, facets: [
    { id: 'fa', title: 'Level of the rate', criterion: 'Supports when the level of the rate holds', data: [fdatum('a1', { fixedStance: 'supports' }), fdatum('a2')], notFoundNeeds: ['Rate in the labour force survey'] },
    { id: 'fb', title: 'Direction of change', criterion: 'Supports when the direction of change holds', data: [fdatum('b1', { fixedStance: 'irrelevant' })] }
  ] });
  const prompt = mod.facetJudgeStep.render(req);
  assert.match(prompt, /- a1: propStance supports \(fixed — copy exactly\)/);
  assert.match(prompt, /- b1: propStance irrelevant \(fixed — copy exactly\)/);
  assert.doesNotMatch(prompt, /- a2: propStance/);
  const asked = prompt.slice(prompt.indexOf('Already asked'));
  for (const need of ['need of a1', 'need of a2', 'need of b1', 'Rate in the labour force survey']) assert.ok(asked.includes(JSON.stringify(need).slice(1, -1)), need);
});
test('sem3 facet judge: the prompt renders each facet criterion and baseline and says to decide by the criterion', () => {
  const req = fjReq({ facets: [{ id: 'fa', title: 'Level of the rate', criterion: 'Supports when above the overall rate', baseline: 'the overall rate', data: [fdatum('a1')] }] });
  const prompt = mod.facetJudgeStep.render(req);
  assert.ok(prompt.includes('Supports when above the overall rate') && prompt.includes('the overall rate'));
  assert.match(prompt, /"criterion":"Supports when above the overall rate"/);
  assert.match(prompt, /by that criterion/);
});
test('sem3 facet judge: a facet without a criterion is refused before any call; the prompt lists re-judge allowed prior stances', () => {
  for (const criterion of [undefined, '', '  '])
    assert.throws(() => sr.prepareStep(mod.facetJudgeStep, fjReq({ facets: [{ id: 'fa', title: 'T', criterion, data: [fdatum('a1')] }] })), error => error.name === 'ArgumentStepError' && /criterion/.test(error.message));
  const prompt = mod.facetJudgeStep.render(fjReq({ round: 2, facets: [{ id: 'fa', title: 'T', criterion: 'c', data: [fdatum('a1', { priorStance: 'irrelevant' })] }] }));
  assert.match(prompt, /- a1: propStance irrelevant \(prior, re-judge allowed\)/);
  assert.doesNotMatch(prompt, /copy exactly\)/);
  assert.ok(ok(mod.facetJudgeStep, fjReq({ round: 2, facets: [{ id: 'fa', title: 'T', criterion: 'c', data: [fdatum('a1', { priorStance: 'irrelevant' })] }] }), { data: [{ id: 'a1', propStance: 'supports', reason: 'a1 says 9.2 percent' }], facets: [{ id: 'fa', verdict: 'supports', reason: 'ok', summary: 'ok', citedData: ['a1'], retryNeeds: [] }], assumptionInsights: [] }));
});
test('facet judge request without fixed data has no fixed stances block', () => {
  assert.doesNotMatch(mod.facetJudgeStep.render(fjReq({ facets: [{ id: 'fa', title: 'T', data: [fdatum('a1')] }] })), /\nFixed stances \(/);
});

// ---- real haiku replies (owner's first run, 2026-11-11) that an over-strict parser refused ----
const REAL_PROP = '台灣少子化主要是因為經濟壓力嗎';
const realReq = { ...base, language: 'zh-TW', proposition: REAL_PROP };
const REAL_YEARS = "{\"assumptions\":{\"items\":[{\"label\":\"指標\",\"value\":\"總生育率（TFR）與年出生人數\",\"reason\":\"少子化通常以生育率與出生數衡量，原命題未指明用哪一個指標。\"},{\"label\":\"期間\",\"value\":\"2015至2025年\",\"reason\":\"原命題沒有時間範圍，以近十年作為預設，較能反映目前狀況。\"},{\"label\":\"比較基準（更替水準）\",\"value\":\"更替水準（每位婦女約2.1人）\",\"reason\":\"判斷是否屬於少子化，需要一個生育率門檻。\"},{\"label\":\"比較基準（前期）\",\"value\":\"2015年的水準\",\"reason\":\"判斷是否在下降，需要一個起點。\"},{\"label\":\"比較對象（同區域）\",\"value\":\"南韓與日本的同期生育率\",\"reason\":\"判斷台灣的情況是否比鄰近經濟體更低。\"}]},\"facets\":[{\"title\":\"台灣總生育率低於更替水準\",\"criterion\":\"若2015至2025年間台灣總生育率長期低於2.1，支持此面向；若達到或高於2.1，則反駁。\",\"baseline\":\"更替水準（每位婦女約2.1人）\",\"needs\":[{\"need\":\"台灣近年總生育率數值及其與更替水準的差距\",\"kind\":\"fact\"},{\"need\":\"總生育率與更替水準的定義及計算方式\",\"kind\":\"definition\"}]},{\"title\":\"台灣出生率較2015年下降\",\"criterion\":\"若2015至2025年間台灣年出生人數與總生育率明顯下降，支持此面向；若持平或上升，則反駁。\",\"baseline\":\"2015年的水準\",\"needs\":[{\"need\":\"2015至2025年台灣年出生人數與總生育率的變化數據\",\"kind\":\"fact\"}]},{\"title\":\"台灣生育率低於南韓與日本同期水準\",\"criterion\":\"若同期台灣總生育率低於南韓與日本，支持此面向；若不低於或較高，則反駁。\",\"baseline\":\"南韓與日本的同期生育率\",\"needs\":[{\"need\":\"同期南韓與日本總生育率的官方統計數據\",\"kind\":\"fact\"}]}],\"causalQuestions\":[\"經濟壓力是否為台灣少子化的主要原因？\"],\"question\":\"台灣是否正在經歷少子化？\"}";
const REAL_PARTS = "{\"assumptions\":{\"items\":[{\"label\":\"地理範圍\",\"value\":\"臺灣全境（全國層級）\",\"reason\":\"命題只寫「台灣」，未說明是全國或某個縣市，預設採全國資料。\"},{\"label\":\"時間範圍\",\"value\":\"最近已公布的完整年度；比較對象為較早的同期（約十年前）\",\"reason\":\"命題沒有指定時間，預設看最新可得的統計，並與較早的同期比較才能判斷「少子化」是否存在。\"},{\"label\":\"少子化指標\",\"value\":\"總生育率與年度出生數\",\"reason\":\"「少子化」在命題中沒有數值定義，預設以官方常用的總生育率與出生數來檢查。\"},{\"label\":\"國際比較基準\",\"value\":\"其他已開發經濟體的平均總生育率\",\"reason\":\"命題沒有比較對象；若要判斷臺灣的水準是否偏低，需要與其他已開發經濟體比較。\"},{\"label\":\"替代水準基準\",\"value\":\"總生育率需達到的人口替代水準（每名婦女約2.1名子女）\",\"reason\":\"人口學上常以維持人口穩定所需的生育率作為判斷少子化的門檻，預設用來衡量臺灣是否低於該水準。\"}]},\"facets\":[{\"title\":\"出生數或總生育率低於較早的同期\",\"criterion\":\"若臺灣最近已公布年度的總生育率或出生數低於較早的同期，支持此面向；若兩者持平或更高，則反駁。\",\"baseline\":\"較早的同期（約十年前）\",\"needs\":[{\"need\":\"臺灣最近已公布年度的總生育率與較早同期的總生育率\",\"kind\":\"fact\"},{\"need\":\"臺灣最近已公布年度的出生數與較早同期的出生數\",\"kind\":\"fact\"},{\"need\":\"少子化的定義，以及官方採用的總生育率與出生數計算方式\",\"kind\":\"definition\"}]},{\"title\":\"總生育率低於人口替代水準\",\"criterion\":\"若臺灣最近已公布年度的總生育率低於人口替代水準，支持此面向；若達到或高於該水準，則反駁。\",\"baseline\":\"人口替代水準\",\"needs\":[{\"need\":\"臺灣最近已公布年度總生育率與人口替代水準的差距\",\"kind\":\"fact\"}]},{\"title\":\"總生育率在已開發經濟體中偏低\",\"criterion\":\"若臺灣最近已公布年度的總生育率低於其他已開發經濟體的平均值，支持此面向；若高於或相近，則反駁。\",\"baseline\":\"其他已開發經濟體的平均總生育率\",\"needs\":[{\"need\":\"臺灣與其他已開發經濟體最近年度平均總生育率的比較資料\",\"kind\":\"fact\"}]}],\"causalQuestions\":[\"經濟壓力是否是臺灣少子化的主要原因？\"],\"question\":\"臺灣正在出現少子化現象嗎？\"}";
const realWith = (raw, fn) => { const v = JSON.parse(raw); fn(v); return v; };

test('facet plan: years in the reply\'s own assumption values may be reused in question, titles, criteria, baselines and needs', () => {
  const out = plain(ok(mod.facetPlanStep, realReq, JSON.parse(REAL_YEARS)));
  assert.equal(out.facets[1].baseline, '2015年的水準');
  bad(mod.facetPlanStep, realReq, realWith(REAL_YEARS, v => { v.facets[1].title = '台灣出生率較2012年下降'; }), /number 2012/);
  bad(mod.facetPlanStep, realReq, realWith(REAL_YEARS, v => { v.facets[0].needs[0].need = '2012年的總生育率'; }), /number 2012/);
  bad(mod.facetPlanStep, realReq, realWith(REAL_YEARS, v => { v.question = '台灣2030年是否少子化？'; }), /number 2030/);
  // P2-7 (intentional change): causal questions may now reuse a year of the assumption values; a year nowhere in the request is still refused.
  assert.ok(ok(mod.facetPlanStep, realReq, realWith(REAL_YEARS, v => { v.causalQuestions = ['2015年經濟壓力是主因嗎？']; })));
  bad(mod.facetPlanStep, realReq, realWith(REAL_YEARS, v => { v.causalQuestions = ['2012年經濟壓力是主因嗎？']; }), /number 2012/);
});

test('facet plan: a baseline may be a part of an assumption value, or contain one; trivial or unrelated baselines still fail', () => {
  const out = plain(ok(mod.facetPlanStep, realReq, JSON.parse(REAL_PARTS)));
  assert.deepEqual(out.facets.map(f => f.baseline), ['較早的同期（約十年前）', '人口替代水準', '其他已開發經濟體的平均總生育率']);
  assert.ok(ok(mod.facetPlanStep, realReq, realWith(REAL_PARTS, v => { v.facets[2].baseline = '臺灣全境（全國層級）的數據'; })), 'a baseline that contains a value');
  bad(mod.facetPlanStep, realReq, realWith(REAL_PARTS, v => { v.facets[1].baseline = '歷史平均出生人數'; }), /baseline/);
  bad(mod.facetPlanStep, realReq, realWith(REAL_PARTS, v => { v.facets[1].baseline = '水'; }), /baseline/);
  bad(mod.facetPlanStep, realReq, realWith(REAL_PARTS, v => { v.facets[1].baseline = '年'; }), /baseline/);
  bad(mod.facetPlanStep, fpReq, fpWith(v => { v.facets[0].baseline = 'all'; v.assumptions.items.forEach(i => { i.value = 'overall'; }); }), /baseline/);
});

test('P1-4: a retry need that asks for a cause is refused like a facet-plan need (zh-TW, zh-CN and en markers)', () => {
  for (const need of ['What caused the rise in the youth rate', 'Why the youth rate went up', '青年失業率上升的原因', '青年失业率上升的成因', 'Youth rate rise due to automation']) {
    bad(mod.facetJudgeStep, fjReq(), fjWith(v => { fjFacet(v, 'fb').retryNeeds = [need]; }), /cause|retry/);
  }
});

test('P2-7: an assumption label, reason and a causal question may reuse a year the assumption values carry; a number or link nowhere in the request is still refused', () => {
  const prop = ok(mod.facetPlanStep, { ...base, proposition: 'Youth unemployment is rising' }, fpWith(v => {
    v.assumptions.items[0].value = 'ages 16 to 24 for the years 2023 to 2024';
    v.assumptions.items[0].label = 'Age band 16 to 24';
    v.assumptions.items[0].reason = 'covers 2023 to 2024 only';
    v.causalQuestions = ['Did automation drive the rise in 2023?'];
    v.question = 'Did youth unemployment rise?';
  }));
  assert.ok(prop);
  const req = { ...base, proposition: 'Youth unemployment is rising' };
  bad(mod.facetPlanStep, req, fpWith(v => { v.assumptions.items[0].reason = 'covers 1999 only'; v.question = 'Did youth unemployment rise?'; }), /1999/);
  bad(mod.facetPlanStep, req, fpWith(v => { v.causalQuestions = ['Did automation drive the rise in 1999?']; v.question = 'Did youth unemployment rise?'; }), /1999/);
  bad(mod.facetPlanStep, req, fpWith(v => { v.assumptions.items[0].reason = 'see https://x.example.com'; v.question = 'Did youth unemployment rise?'; }), /link/);
});

// The owner's real 2026-11-11 replies for 「紐西蘭治安相比20年前, 是不是有變差了」: the build of that day refused them for 2006 and 2026,
// years the model wrote into its own assumption values (period, baseline). Both must parse now.
const NZ_PROP = '紐西蘭治安相比20年前, 是不是有變差了';
const nzReq = { ...base, language: 'zh-TW', proposition: NZ_PROP, today: '2026-11-11' };
const NZ_2006 = "{\"assumptions\":{\"items\":[{\"label\":\"比較基準時點\",\"value\":\"約2006年（20年前）\",\"reason\":\"提問以「20年前」為比較起點，以今年往前推算。\"},{\"label\":\"現況時點\",\"value\":\"最新可得的官方資料\",\"reason\":\"提問說「現在」但未指定年份，因此採用最新公布的資料。\"},{\"label\":\"治安衡量指標\",\"value\":\"警方登記的犯罪率，並以國家受害調查為輔\",\"reason\":\"治安沒有單一數字，需先決定用哪類統計來判斷。\"},{\"label\":\"地區範圍\",\"value\":\"紐西蘭全國\",\"reason\":\"提問未限定地區，採全國整體。\"},{\"label\":\"對象範圍\",\"value\":\"全體居民\",\"reason\":\"提問未指定年齡或族群，採整體人口。\"}]},\"facets\":[{\"title\":\"警方登記的整體犯罪率與基準時點相比\",\"criterion\":\"若最新官方資料的整體登記犯罪率高於約2006年（20年前），則支持「變差」；若低於或持平，則反駁。需同時取得最新與基準時點的數字。\",\"baseline\":\"約2006年（20年前）\",\"needs\":[{\"need\":\"紐西蘭警方公布的最新整體登記犯罪率統計\",\"kind\":\"fact\"},{\"need\":\"紐西蘭約2006年的整體登記犯罪率統計\",\"kind\":\"fact\"},{\"need\":\"登記犯罪與受害調查在統計口徑與定義上的差異\",\"kind\":\"definition\"}]},{\"title\":\"國家受害調查的被害比例與基準時點相比\",\"criterion\":\"若最新受害調查的被害比例高於約2006年（20年前），則支持「變差」；若低於或持平，則反駁。受害調查可補足未報案的犯罪。\",\"baseline\":\"約2006年（20年前）\",\"needs\":[{\"need\":\"紐西蘭國家受害調查中最新的被害比例\",\"kind\":\"fact\"},{\"need\":\"紐西蘭國家受害調查中約2006年的被害比例\",\"kind\":\"fact\"}]},{\"title\":\"暴力犯罪數字與基準時點相比\",\"criterion\":\"若最新暴力犯罪的登記數字或比率高於約2006年（20年前），則支持「變差」；若低於或持平，則反駁。\",\"baseline\":\"約2006年（20年前）\",\"needs\":[{\"need\":\"紐西蘭警方統計中最新的暴力犯罪數字\",\"kind\":\"fact\"},{\"need\":\"紐西蘭警方統計中約2006年的暴力犯罪數字\",\"kind\":\"fact\"}]}],\"causalQuestions\":[],\"question\":\"紐西蘭治安相比20年前有變差嗎？\"}";
const NZ_2026 = "{\"assumptions\":{\"items\":[{\"label\":\"時間範圍\",\"value\":\"現在（2026年）與20年前（2006年）\",\"reason\":\"今天是2026-11-11，「20年前」可換算為2006年，命題未寫明確切年份。\"},{\"label\":\"地區範圍\",\"value\":\"紐西蘭全國\",\"reason\":\"命題說「紐西蘭」，未限定城市或地區。\"},{\"label\":\"對象範圍\",\"value\":\"全體人口\",\"reason\":\"命題未指定特定年齡、族群或對象。\"},{\"label\":\"比較基準\",\"value\":\"2006年的全國治安指標\",\"reason\":\"命題以20年前作為比較基準，因此以2006年的同類指標為對照。\"},{\"label\":\"治安指標\",\"value\":\"警方登記的暴力與財產犯罪率，並參考住戶犯罪被害調查\",\"reason\":\"「治安」沒有單一量測方式，需同時看登記數據與民眾被害經驗才能判斷。\"}]},\"facets\":[{\"title\":\"警方登記犯罪率高於20年前\",\"criterion\":\"若2026年與2006年的全國每人口登記犯罪率比較顯示上升，支持此面向；若下降或持平，則反駁。\",\"baseline\":\"2006年的全國治安指標\",\"needs\":[{\"need\":\"紐西蘭警方或統計局公布的2026年全國每人口登記犯罪率\",\"kind\":\"fact\"},{\"need\":\"紐西蘭警方或統計局公布的2006年全國每人口登記犯罪率\",\"kind\":\"fact\"},{\"need\":\"紐西蘭警方「登記犯罪」與計算每人口犯罪率的定義與方法\",\"kind\":\"definition\"}]},{\"title\":\"暴力犯罪率高於20年前\",\"criterion\":\"若2026年與2006年的全國暴力犯罪率比較顯示上升，支持此面向；若下降或持平，則反駁。\",\"baseline\":\"2006年的全國治安指標\",\"needs\":[{\"need\":\"紐西蘭2026年全國暴力犯罪的每人口登記數據\",\"kind\":\"fact\"},{\"need\":\"紐西蘭2006年全國暴力犯罪的每人口登記數據\",\"kind\":\"fact\"}]},{\"title\":\"民眾犯罪被害經驗高於20年前\",\"criterion\":\"若住戶犯罪被害調查顯示近期的被害比例高於2006年前後，支持此面向；若較低或持平，則反駁。\",\"baseline\":\"2006年的全國治安指標\",\"needs\":[{\"need\":\"紐西蘭犯罪與被害調查（NZCVS）近期年度的民眾被害比例\",\"kind\":\"fact\"},{\"need\":\"紐西蘭犯罪與被害調查2006年前後的民眾被害比例\",\"kind\":\"fact\"}]},{\"title\":\"近年治安指標的變化方向\",\"criterion\":\"若近年警方登記犯罪與被害調查的年度數據整體走升，且長期高於2006年水準，支持此面向；若整體走降或回到原水準，則反駁。\",\"baseline\":\"2006年的全國治安指標\",\"needs\":[{\"need\":\"紐西蘭警方登記犯罪的近年年度變化數據與官方趨勢說明\",\"kind\":\"fact\"}]}],\"causalQuestions\":[],\"question\":\"紐西蘭治安相比20年前是否變差？\"}";
test('owner regression 2026-11-11: the New Zealand 20-years replies with 2006 and 2026 from the assumption values parse', () => {
  for (const raw of [NZ_2006, NZ_2026]) {
    const out = plain(ok(mod.facetPlanStep, nzReq, JSON.parse(raw)));
    assert.ok(out.facets.length >= 3 && out.facets.length <= 5);
    assert.ok(out.assumptions.items.length > 0);
  }
  // Without today's date the reason "今天是2026-11-11" has no source: the date is what makes it grounded, not a looser rule.
  bad(mod.facetPlanStep, { ...nzReq, today: undefined }, JSON.parse(NZ_2026), /number 11/);
  bad(mod.facetPlanStep, nzReq, realWith(NZ_2026, v => { v.assumptions.items[0].reason = '今天是2026-11-12'; }), /number 12/);
});

// ---- #59: replies that name an id; partial conclusion ----
const realReplies = require('./fixtures/argument-real-replies-with-ids.json');
const P59_PROP = '紐西蘭治安相比20年前, 是不是有變差了';
test('#59 real failed reply (needs, exchange 92d08dc8): the made-up number 111 is still refused', () => {
  const req = { ...needReq, proposition: P59_PROP, hypothesis: { title: '警力配置與執法強度改變', statement: '治安感受的變化可能來自警力部署的調整', round: 3 }, data: [], existing: [], max: 1 };
  bad(mod.needsStep, req, realReplies.needs.response, /number 111/);
});
test('#59 real failed reply (facet verdict, exchange 6333bbea): an id in the reason or insight text is refused as an id, not as a number', () => {
  const ids = ['4924cc48-8487-4f23-88d9-154103363460', 'f1f62724-6a32-4d93-b9a0-c1d7bc3fbff3', 'c8cc89c1-0000-4000-8000-000000000001'];
  const evidence = ids.map(id => ({ id, claim: '證據', quote: 'quote text here', url: 'https://example.org/a', stance: 'contradicts' }));
  const req = fvReq({ hypothesisId: 'h1', round: 1, evidence }, { hypothesis: '監視器普及使治安改善' });
  bad(mod.facetVerdictStep, req, realReplies.facetVerdict.response, /names an id/);
  // the same reply with the ids removed from the text passes the id check (it then fails only on the numbers, which this fixture does not have)
  const clean = JSON.parse(realReplies.facetVerdict.response);
  clean.reason = '假說主張治安改善，但證據顯示不安全感上升。';
  clean.insights = clean.insights.map(i => ({ ...i, text: i.text.replace(/c8cc89c1/g, '某項證據') }));
  assert.equal(mod.facetVerdictStep.parse(reply(clean), req).citedNeeds.length, 2);
});
test('#59 verdict reason naming an evidence id (or its first 8 characters) is refused; short ids are not checked', () => {
  const longId = 'abcdef12-3456-4789-8abc-def012345678';
  const input = { hypothesisId: 'h1', round: 1, evidence: [{ id: longId, claim: 'Rate was 9.2 percent', quote: 'rate 9.2 percent', url: 'https://stats.example.org/a', stance: 'supports' }, { id: 'n2', claim: 'c', quote: 'q q q', url: 'https://stats.example.org/b', stance: 'supports' }] };
  const req = fvReq(input);
  const good = { verdict: 'supported', citedNeeds: [longId], reason: 'Matches the 9.2 percent', insights: [{ kind: 'consistent', text: 'The data agree on 9.2 percent' }] };
  assert.ok(ok(mod.facetVerdictStep, req, good));
  bad(mod.facetVerdictStep, req, { ...good, reason: `${longId} matches` }, /names an id/);
  bad(mod.facetVerdictStep, req, { ...good, reason: 'ABCDEF12 matches' }, /names an id/);
  const { insights, ...v1 } = good;
  bad(mod.verdictStep, req, { ...v1, reason: 'abcdef12 matches' }, /names an id/);
  assert.ok(ok(mod.facetVerdictStep, req, { ...good, reason: 'n2 matches the 9.2 percent' }), 'a short id is ordinary text');
});
test('#59 conclusion: an id in the summary or a point is refused; one verified hypothesis is a valid request and partial adds the partial rule to the prompt', () => {
  const hid = '4924cc48-8487-4f23-88d9-154103363460';
  const eid = 'f1f62724-6a32-4d93-b9a0-c1d7bc3fbff3';
  const input = { hypotheses: [{ id: hid, round: 1, evidence: [{ id: eid, claim: 'Rate was 9.2 percent', quote: 'rate 9.2 percent', url: 'https://stats.example.org/a', stance: 'supports' }] }] };
  const req = { ...base, proposition: PROP, input, statements: { [hid]: 'Hiring slowed' } };
  const good = { summary: 'Hiring slowed', points: [{ text: 'Rate was 9.2 percent', hypothesisIds: [hid] }] };
  assert.ok(ok(mod.conclusionStep, req, good));
  bad(mod.conclusionStep, req, { ...good, summary: `see ${hid}` }, /names an id/);
  bad(mod.conclusionStep, req, { ...good, points: [{ text: 'in 4924cc48 it rose', hypothesisIds: [hid] }] }, /names an id/);
  bad(mod.conclusionStep, req, { ...good, points: [{ text: `evidence ${eid}`, hypothesisIds: [hid] }] }, /names an id/);
  assert.ok(sr.prepareStep(mod.conclusionStep, req));
  const full = mod.conclusionStep.render(req);
  const partial = mod.conclusionStep.render({ ...req, partial: true });
  assert.notEqual(partial, full);
  assert.ok(partial.length > full.length);
});
