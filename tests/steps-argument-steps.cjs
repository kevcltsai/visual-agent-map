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

// ---- plan_situation ----
const planReq = { ...base, proposition: PROP, max: 3 };
test('plan_situation: 1..max needs, none repeating another; the program (not the reply) makes the ids', () => {
  const out = plain(ok(mod.planSituationStep, planReq, { data: [{ need: 'Official youth unemployment rate series' }, { need: 'Labour force survey notes' }] }));
  assert.deepEqual(out, { data: [{ need: 'Official youth unemployment rate series' }, { need: 'Labour force survey notes' }] });
  bad(mod.planSituationStep, planReq, { data: [] }, /expected 1 to 3/);
  bad(mod.planSituationStep, planReq, { data: [{ need: 'a' }, { need: 'b' }, { need: 'c' }, { need: 'd' }] }, /expected 1 to 3/);
  bad(mod.planSituationStep, planReq, { data: [{ need: 'x' }, { need: 'X.' }] }, /repeats/);
  bad(mod.planSituationStep, planReq, { data: [{ need: '' }] });
  bad(mod.planSituationStep, planReq, { data: [{ need: 'x', id: 'd1' }] });
  bad(mod.planSituationStep, planReq, { data: [{ need: 'x' }], extra: 1 });
  bad(mod.planSituationStep, planReq, 'not json');
});
test('plan_situation: a number or URL the proposition does not have throws; ones it has pass; the result fits the machine', () => {
  bad(mod.planSituationStep, planReq, { data: [{ need: 'Rate in 2019' }] }, /number 2019/);
  bad(mod.planSituationStep, planReq, { data: [{ need: 'see https://x.example.com' }] }, /link/);
  assert.ok(ok(mod.planSituationStep, planReq, { data: [{ need: 'Rate for 2024' }] }));
  const out = ok(mod.planSituationStep, planReq, { data: [{ need: 'Rate series' }, { need: 'Survey notes' }] });
  const s = m.applySituationData(m.newArgumentMap(roles, 'r'), plain(out).data.map((d, i) => ({ id: `d${i + 1}`, need: d.need })));
  assert.equal(s.situation.data.length, 2);
});
test('plan_situation: policy needs a sane max within the machine cap; the prompt shows only the proposition and the cap', () => {
  const prep = max => sr.prepareStep(mod.planSituationStep, { ...planReq, max });
  assert.ok(prep(1) && prep(6));
  for (const max of [0, 7, 1.5, NaN]) assert.throws(() => prep(max), error => error.name === 'ArgumentStepError');
  const prompt = mod.planSituationStep.render({ ...planReq, secret: 'LEAKED-X' });
  assert.doesNotMatch(prompt, /LEAKED/);
  assert.match(prompt, /Youth unemployment rose in 2024/);
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
test('conclusion: a number or URL outside the input throws; below 3 verified hypotheses the policy refuses', () => {
  const f = conclusionFixture();
  const req = cReq(f);
  bad(mod.conclusionStep, req, { summary: 'Unemployment hit 14 percent', points: [{ text: 'x', hypothesisIds: ['h1'] }] }, /number 14/);
  bad(mod.conclusionStep, req, { summary: 's', points: [{ text: 'see https://memory.example.com', hypothesisIds: ['h1'] }] }, /link/);
  const two = { ...req, input: { hypotheses: f.input.hypotheses.slice(0, 2) } };
  assert.throws(() => sr.prepareStep(mod.conclusionStep, two), error => error.name === 'ArgumentStepError');
  const s2 = withHyps(['h1', 'h2', 'h3']);
  assert.throws(() => m.prepareConclusion(settle(settle(s2, 'h1'), 'h2')), error => error instanceof m.GateError);
});

// ---- schemas and registry ----
test('every step has a strict schema and the registry maps the machine actions', () => {
  for (const step of [mod.planSituationStep, mod.situationGateStep, mod.hypothesesStep, mod.needsStep, mod.verdictStep, mod.conclusionStep]) {
    assert.equal(step.schema.additionalProperties, false);
    assert.deepEqual([...step.schema.required].sort(), Object.keys(step.schema.properties).sort());
  }
  assert.deepEqual(Object.keys(mod.ARGUMENT_STEPS).sort(), ['add_needs', 'conclude', 'judge_gate', 'plan_situation', 'propose_hypotheses', 'revise', 'verdict']);
  assert.equal(mod.ARGUMENT_STEPS.plan_situation, mod.planSituationStep);
  assert.equal(mod.ARGUMENT_STEPS.revise, mod.needsStep);
  const ids = new Set(Object.values(mod.ARGUMENT_STEPS).map(step => step.id));
  assert.equal(ids.size, 6);
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
const stepCases = () => {
  const f = conclusionFixture();
  const v = verdictFixture();
  return [
    ['plan', mod.planSituationStep, planReq, { data: [{ need: 'Official rate series' }] }],
    ['gate', mod.situationGateStep, gateReq, gateOk],
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
