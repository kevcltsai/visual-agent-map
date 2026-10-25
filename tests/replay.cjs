// Replay provider tests. Recorded raw replies are fed through the real AiTaskService parsing path (and, for AIM
// review cases, the real Planner-review parser) at the single runtime.runTask seam. No live provider is involved.
// Case kinds: (default) one raw reply through AiTaskService; "flow" an ordered list of raw replies (one AIM flow run, each exchange
// keeps its step stepId@version); "aim-flow-result-layer" historical PARSED results fed through the AimManualFlow ask seam.
// "parse" (exchanges-to-replay.mjs --parse-layer): raw replies from a live ai-exchanges.json replayed through the step's own parser only.
// Set VAM_REPLAY_CORPUS=<dir> to also run every *.replay.json case in that directory (private corpus, optional layer).
const { test } = require('node:test');
const { nodeFsAdapter } = require('./support-fs-adapter.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { load, makeService, replayRuntime, replayAsk, ReplayMiss, readJson, sha256 } = require('./support-replay.cjs');
const { fixture, AimManualFlow } = require('./support-aim-fixture.cjs');

const fixtures = path.join(__dirname, 'fixtures', 'replay');
const plain = value => JSON.parse(JSON.stringify(value));
const { parseAimPlannerReview } = load('experiences/aim/planner-review.ts');
const { parseAiResult, extractJsonObject } = load('core/steps/task/parse.ts');

/** Neutral, NON-historical stand-ins that let the flow reach the phase under test. They are never presented as recorded output. */
const aimReview = (decision, extra = {}) => ({ summary: 'Neutral review', detail: `<!-- aim-review ${JSON.stringify({ decision, ...extra })} -->\nNeutral review`, suggestions: [], visualReferences: [] });
const aimFills = headings => ({
  'subtopic-research': { summary: 'Neutral research', detail: 'Research status: search completed\nNeutral evidence https://example.org/neutral', suggestions: [], visualReferences: [] },
  'report-review': aimReview('conclude', { rationale: 'Neutral rationale.', stopReason: 'Neutral stop reason.' }),
  'delivery-outline': { summary: 'Neutral outline', detail: `<!-- aim-delivery-outline ${JSON.stringify({ sections: (headings ?? ['Section A']).map(heading => ({ heading, purpose: 'Neutral purpose.', searchTask: '' })) })} -->`, suggestions: [], visualReferences: [] },
  'delivery-writing': { summary: 'Neutral draft', detail: 'Neutral draft text.', suggestions: [], visualReferences: [] },
  'delivery-acceptance': aimReview('conclude', { rationale: 'Neutral rationale.', stopReason: 'Neutral stop reason.' })
});

/**
 * Result-layer replay. The historical values are already-parsed AiResult objects (old mindsearch-* marker contract); they enter
 * at the ask seam, AFTER AiTaskService has folded a structured aim payload. So this asserts what CURRENT code does with those
 * historical outputs; it does not reproduce the original failure layer.
 */
async function runResultLayerCase(replayCase) {
  assert.ok(replayCase.historical?.length && replayCase.scenarios?.length, `${replayCase.name}: result-layer case needs historical[] and scenarios[]`);
  for (const step of replayCase.historical) assert.equal(step.context.promptProfile, 'mindsearch', `${replayCase.name}: historical call carries the old mindsearch profile`);
  const outcomes = [];
  for (const scenario of replayCase.scenarios) {
    const label = `${replayCase.name} / ${scenario.name}`;
    const feed = scenario.feed.map(index => ({ phase: replayCase.historical[index].phase, result: replayCase.historical[index].result }));
    const all = aimFills(scenario.outlineHeadings);
    const fills = Object.fromEntries(scenario.fills.map(phase => [phase, all[phase]]));
    const subject = fixture({ depth: 1 });
    const replay = replayAsk(feed, fills);
    let next = 0;
    const flow = new AimManualFlow(subject.repository, subject.store, replay.ask, () => `replay-${++next}`);
    let failure;
    try { await flow.resumeAnswerResearch('Map.md', 'current', 'test', 'low'); } catch (error) { failure = error; }
    const { expect } = scenario;
    if (expect.phases) assert.deepEqual(replay.phases(), expect.phases, `${label}: phases the current flow requested`);
    if (expect.neverRequested) assert.ok(!replay.phases().includes(expect.neverRequested), `${label}: current flow never requests ${expect.neverRequested}`);
    assert.equal(replay.consumed(), expect.consumed, `${label}: historical results consumed`);
    if (expect.error === null) assert.ifError(failure);
    else { assert.ok(failure, `${label}: expected the current flow to reject`); assert.match(failure.message, new RegExp(expect.error), `${label}: rejection`); }
    if (expect.recoveryPhase !== undefined) assert.equal(subject.getMap().aim.branches.find(branch => branch.id === 'current').deliveryRecovery?.phase ?? null, expect.recoveryPhase, `${label}: saved delivery recovery phase`);
    for (const { phase, context } of replay.observed) assert.equal(context.promptProfile, 'aim', `${label}: current ${phase} context uses the aim profile, not the historical mindsearch profile`);
    outcomes.push({ scenario: scenario.name, failure, replay });
  }
  return outcomes;
}

/** A "flow" case: ordered raw exchanges for one flow run, replayed through one AiTaskService in order. */
async function runFlowCase(replayCase) {
  assert.ok(Array.isArray(replayCase.exchanges) && replayCase.exchanges.length, `${replayCase.name}: a flow case needs exchanges`);
  if (replayCase.expect?.stepOrder) assert.deepEqual(replayCase.exchanges.map(item => item.step), replayCase.expect.stepOrder, `${replayCase.name}: recorded step order`);
  const runtime = replayRuntime(replayCase.exchanges.map(item => ({ promptSha256: replayCase.matchPrompt === false ? undefined : item.promptSha256, response: item.response, error: item.error })));
  const service = makeService(runtime, { language: replayCase.language ?? 'en' });
  const observed = [];
  for (const [index, exchange] of replayCase.exchanges.entries()) {
    const label = `${replayCase.name}[${index}${exchange.step ? ` ${exchange.step}` : ''}]`;
    assert.ok(exchange.context && exchange.expect?.askModel, `${label}: a flow exchange needs "context" and "expect.askModel" (add them via the converter manifest)`);
    let result, failure;
    try { result = plain(await service.askModel(plain(exchange.context), exchange.model, exchange.effort)); } catch (error) { failure = error; }
    if (exchange.expect.askModel.error !== undefined) { assert.ok(failure, `${label}: expected askModel to reject`); assert.match(failure.message, new RegExp(exchange.expect.askModel.error), `${label}: rejection`); }
    else { assert.ifError(failure); assert.deepEqual(result, exchange.expect.askModel.result, `${label}: parsed AiResult`); }
    assert.equal(runtime.calls[index].hash, exchange.promptSha256 ?? runtime.calls[index].hash, `${label}: calls arrive in recorded order`);
    observed.push({ result, failure });
  }
  assert.deepEqual(runtime.unused(), [], `${replayCase.name}: every recorded reply was consumed`);
  return { observed, runtime };
}

const KNOWN_TASK_STEP = /^(?:task\.(?:run|reference-extract|reference-reduce)|aim\.[a-z][a-z-]*)@1$/;
const STAGE_PREFIX = /^(?:Starting AI|Waiting for the AI reply|Parsing the AI reply|啟動 AI|等待 AI 回覆|解析 AI 回覆)\s*[:：]\s*/;
const PARSING_STAGE = /^(?:Parsing the AI reply|解析 AI 回覆)\s*[:：]/;
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** The contract a recorded `aim` payload schema was built from (see ai/aim-contracts.ts payloadSchema), or undefined. */
function contractFromAimSchema(aim) {
  const keys = Object.keys(aim?.properties ?? {});
  const has = key => keys.includes(key);
  if (has('subtopics')) return { kind: 'plan' };
  if (has('sections')) return { kind: 'outline' };
  if (has('usable')) return { kind: 'reuse' };
  if (has('goalAnswered') && aim.properties.decision?.enum) return { kind: 'review', decisions: aim.properties.decision.enum };
  if (has('questions')) return { kind: 'intake' };
  if (has('status') && !has('decision')) return { kind: 'delivery-research' };
  if (has('decision') && has('question') && has('answerOptions') && aim.properties.decision.enum) return { kind: 'question', requireQuestion: aim.properties.decision.enum.length === 1 };
  return undefined;
}

/**
 * Parse options for one recorded exchange, derived from its step id and the schema its request carried. This mirrors
 * taskResponseShape: an `aim` property means an AIM contract; the gap-audit summary enum means strict gap audit; a required
 * searchStatus means isolated web research. Anything it cannot derive is "schema-only", never a guess.
 */
function parseOptionsFor(entry) {
  if (typeof entry.step !== 'string' || !KNOWN_TASK_STEP.test(entry.step)) throw new Error(`${entry.exchangeId}: unknown step id ${JSON.stringify(entry.step)}; replay knows task.run, task.reference-extract, task.reference-reduce and aim.<phase> at version 1`);
  const schema = entry.responseSchema;
  if (!schema || typeof schema !== 'object') return { schemaOnly: 'no response schema in the logged request' };
  const required = Array.isArray(schema.required) ? schema.required : [];
  const aim = schema.properties?.aim;
  const base = { strictGapAudit: false, webResearch: required.includes('searchStatus') };
  if (aim) {
    const contract = contractFromAimSchema(aim);
    return contract ? { ...base, contract } : { schemaOnly: 'aim payload schema matches no known contract', requiredKeys: required };
  }
  if (sameJson(schema.properties?.summary?.enum, ['user_condition', 'external_evidence'])) return { ...base, strictGapAudit: true };
  for (const key of ['summary', 'detail', 'suggestions', 'visualReferences']) if (!required.includes(key)) return { schemaOnly: `schema does not require ${key}`, requiredKeys: required };
  return base;
}

/** Run one parse-layer entry. Returns "parsed", "parse-failure", "schema-only", "provider-error" or "unfinished". */
function checkParseEntry(entry, language) {
  const label = `${entry.exchangeId} ${entry.step ?? 'no-step'}`;
  const providerLabel = entry.provider === 'claude' ? 'Claude Code' : 'Codex App Server';
  if (typeof entry.raw !== 'string' || !entry.raw) {
    assert.equal(entry.recordedStatus, 'failed', `${label}: an entry without a raw reply must be a recorded provider failure`);
    return 'provider-error';
  }
  const options = parseOptionsFor(entry);
  const recordedError = String(entry.recordedError ?? '');
  const parseFailure = entry.recordedStatus === 'failed' && PARSING_STAGE.test(recordedError);
  if (entry.recordedStatus === 'failed' && !parseFailure) return 'provider-error';
  if (options.schemaOnly) {
    if (!parseFailure && ['parsed', 'completed'].includes(entry.recordedStatus)) {
      const object = JSON.parse(extractJsonObject(entry.raw));
      for (const key of options.requiredKeys ?? []) assert.ok(key in object, `${label}: raw reply lacks required key ${key}`);
    }
    return 'schema-only';
  }
  let result, failure;
  try { result = parseAiResult(entry.raw, providerLabel, language, options.strictGapAudit, options.webResearch, options.contract); } catch (error) { failure = error; }
  if (parseFailure) {
    assert.ok(failure, `${label}: recorded as a parse failure but current code parsed it`);
    const expected = recordedError.replace(STAGE_PREFIX, '');
    assert.ok(failure.message.startsWith(expected.slice(0, 40)), `${label}: error "${failure.message}" does not start with recorded "${expected.slice(0, 40)}"`);
    return 'parse-failure';
  }
  if (['parsed', 'completed'].includes(entry.recordedStatus)) {
    assert.ifError(failure);
    assert.equal(typeof result.summary, 'string', `${label}: parsed summary`);
    assert.equal(typeof result.detail, 'string', `${label}: parsed detail`);
    return 'parsed';
  }
  return 'unfinished';
}

/** Whether an entry is replayed as schema-only (for the test name). An unknown step is not schema-only: the check itself fails it. */
function isSchemaOnly(entry) {
  if (typeof entry.raw !== 'string' || !entry.raw) return false;
  try { return Boolean(parseOptionsFor(entry).schemaOnly); } catch { return false; }
}

/**
 * A "parse" case: raw replies from a live ai-exchanges.json, replayed through the SAME parse the product runs after the
 * provider returns (parseAiResult with the options the step prepared). Live logs hold no TaskContext, so nothing earlier than
 * the parse (prompt build, schema choice) is reproduced. With a node:test context each entry is its own subtest.
 */
async function runParseCase(replayCase, context) {
  assert.ok(Array.isArray(replayCase.entries) && replayCase.entries.length, `${replayCase.name}: a parse case needs entries`);
  const language = replayCase.language ?? 'en';
  const modes = [];
  for (const entry of replayCase.entries) {
    const name = `${entry.exchangeId} ${entry.step ?? 'no-step'}${isSchemaOnly(entry) ? ' [schema-only]' : ''}`;
    if (context) await context.test(name, () => { modes.push(checkParseEntry(entry, language)); });
    else modes.push(checkParseEntry(entry, language));
  }
  return modes;
}

/** Run any case kind. */
async function runAnyCase(replayCase, context) {
  if (replayCase.kind === 'parse') return runParseCase(replayCase, context);
  if (replayCase.kind === 'aim-flow-result-layer') return runResultLayerCase(replayCase);
  if (replayCase.kind === 'flow') return runFlowCase(replayCase);
  return runCase(replayCase);
}

/** Drive one replay case through AiTaskService and assert its `expect` block. Returns the observed outcome. */
async function runCase(replayCase) {
  assert.ok(replayCase.context, `${replayCase.name}: a replay case needs "context" (the TaskContext to drive); add it via the converter manifest`);
  assert.ok(replayCase.expect, `${replayCase.name}: a replay case needs an "expect" block`);
  const entries = replayCase.exchanges.map(item => ({ promptSha256: replayCase.matchPrompt === false ? undefined : item.promptSha256, response: item.response, error: item.error }));
  const runtime = replayRuntime(entries);
  const service = makeService(runtime, { language: replayCase.language ?? 'en' });
  let result, failure;
  try { result = plain(await service.askModel(plain(replayCase.context), replayCase.model, replayCase.effort)); } catch (error) { failure = error; }
  const { askModel, plannerReview } = replayCase.expect;
  if (askModel.error !== undefined) {
    assert.ok(failure, `${replayCase.name}: expected askModel to reject`);
    assert.match(failure.message, new RegExp(askModel.error), `${replayCase.name}: rejection message`);
  } else {
    assert.ifError(failure);
    assert.deepEqual(result, askModel.result, `${replayCase.name}: parsed AiResult`);
  }
  if (askModel.schemaRequiresAim !== undefined) assert.equal(runtime.calls[0].schema.required.includes('aim'), askModel.schemaRequiresAim, `${replayCase.name}: provider schema requires the aim payload`);
  if (askModel.responseHasAim !== undefined) assert.equal('aim' in JSON.parse(replayCase.exchanges[0].response), askModel.responseHasAim, `${replayCase.name}: recorded reply carries an aim payload`);
  if (plannerReview) {
    assert.ok(result, `${replayCase.name}: Planner review needs a parsed result`);
    if (plannerReview.error !== undefined) assert.throws(() => parseAimPlannerReview(result), new RegExp(plannerReview.error), `${replayCase.name}: Planner review parser`);
    else assert.deepEqual(plain(parseAimPlannerReview(result)), plannerReview.review);
  }
  if (askModel.error === undefined || runtime.calls.length) assert.deepEqual(runtime.unused(), [], `${replayCase.name}: every recorded reply was consumed`);
  return { result, failure, runtime };
}

test('replay provider answers by prompt hash or in order, supports recorded errors, and never falls back', async () => {
  const runtime = replayRuntime([{ promptSha256: sha256('second'), response: 'R2' }, { response: 'R-seq-1' }, { error: 'recorded provider failure' }]);
  assert.equal(await runtime.runTask('second'), 'R2');
  assert.equal(await runtime.runTask('anything'), 'R-seq-1');
  await assert.rejects(runtime.runTask('third'), /recorded provider failure/);
  await assert.rejects(runtime.runTask('fourth'), error => error instanceof ReplayMiss && /no recorded response for prompt sha256/.test(error.message));
  assert.deepEqual(runtime.unused(), []);
  const hashed = replayRuntime([{ promptSha256: sha256('wanted'), response: 'X' }]);
  await assert.rejects(hashed.runTask('different'), ReplayMiss);
  assert.equal(sha256('a 2031-02-03T04:05:06.789Z b 12345678-1234-4123-8123-123456789abc'), sha256('a 2030-01-01T00:00:00Z b ffffffff-ffff-ffff-ffff-ffffffffffff'), 'time and UUID are normalized');
});

test('Round7 native ask_user response (de-identified): provider schema requires aim, reply has none, parser rejects it', async () => {
  const replayCase = readJson(path.join(fixtures, 'round7-native-ask-user.replay.json'));
  const { result } = await runCase(replayCase);
  // Current behavior is REJECT, not repair: AiTaskService passes the reply through unchanged (no aim payload to fold,
  // so no aim-review marker is produced) and parseAimPlannerReview refuses it. Nothing repairs the missing payload here.
  assert.equal(/aim-review/.test(result.detail), false);
  assert.equal(result.suggestions.length, 3);
});

test('Round6 failed exchange (de-identified) converts with the script and replays; current code rejects it at the Planner review parser (the recorded failure was in AiTaskService parsing)', async () => {
  const { convertExchanges } = await import(pathToFileURL(path.join(__dirname, 'tools', 'exchanges-to-replay.mjs')).href);
  const exchanges = readJson(path.join(fixtures, 'round6-failed-exchange.exchanges.json'));
  const manifest = readJson(path.join(fixtures, 'round6-failed-exchange.manifest.json'));
  assert.equal(exchanges[0].status, 'failed');
  assert.match(exchanges[0].error, /structured control response was invalid/);
  const [sequential] = convertExchanges(exchanges, { manifest, sequential: true });
  assert.equal(sequential.exchanges[0].promptSha256, sha256(exchanges[0].prompt), 'converter and test helper hash identically');
  assert.equal(sequential.source.status, 'failed');
  assert.equal(sequential.exchanges[0].error, undefined, 'a parse-stage failure replays the raw reply, not a provider error');
  const { result } = await runCase(sequential);
  assert.equal(result.suggestions.length, 3);
  // Hash-bound replay refuses a prompt that current code no longer builds: it must not silently answer.
  const [bound] = convertExchanges(exchanges, { manifest, sequential: false });
  await assert.rejects(runCase(bound), /no recorded response for prompt sha256/);
});

test('record once, convert, replay: the replayed run reproduces the live parsed result and failure', async () => {
  const { AiExchangeLog } = load('ai-exchange-log.ts');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vam-replay-'));
  try {
    const logFile = path.join(directory, 'ai-exchanges.json');
    const errors = [];
    const log = new AiExchangeLog(nodeFsAdapter, logFile, error => errors.push(error));
    const raw = {
      ok: JSON.stringify({ summary: 'Live summary', detail: 'Live detail with [S1]', suggestions: [{ title: 'Next', task: 'Do next', contribution: 'Why' }], visualReferences: [] }),
      review: JSON.stringify({ summary: 'Which option fits?', detail: 'Interim answer.', suggestions: [{ title: 'Option A', task: '', contribution: '' }, { title: 'Option B', task: '', contribution: '' }], visualReferences: [], aim: { goalAnswered: false, decision: 'ask_user', rationale: 'Needs one condition.', stopReason: '', question: 'Which option fits?', answerOptions: ['Option A', 'Option B'], researchTarget: null } })
    };
    const live = {
      runTask: async (prompt, _model, _effort, _schema, controls) => {
        controls.onRequest({ input: [{ type: 'text', text: prompt }] });
        if (prompt.includes('Failing topic')) throw new Error('provider boom');
        return prompt.includes('Review topic') ? raw.review : raw.ok;
      }
    };
    const contexts = {
      ok: { title: 'Ok topic', summary: '', rules: '', detail: '', task: 'Plain task', ancestors: '', sourceContext: 'Source [S1]: a fact', mode: 'task', researchMode: 'local', researchDepth: 'fast', visualMode: 'off' },
      review: { title: 'Review topic', summary: '', rules: '', detail: 'Reports', task: '<!-- aim-phase: report-review -->\nReview', ancestors: '', mode: 'task', promptProfile: 'aim', researchMode: 'local', researchDepth: 'fast', visualMode: 'off', aimContract: { kind: 'review', decisions: ['research_more', 'ask_user'] } },
      failing: { title: 'Failing topic', summary: '', rules: '', detail: '', task: 'Plain task', ancestors: '', mode: 'task', researchMode: 'local', researchDepth: 'fast', visualMode: 'off' }
    };
    const liveService = makeService(live, { logging: true, exchanges: log });
    const liveResults = {};
    for (const key of ['ok', 'review']) liveResults[key] = plain(await liveService.askModel(contexts[key], 'gpt-6-luna', 'low'));
    await assert.rejects(liveService.askModel(contexts.failing, 'gpt-6-luna', 'low'), /provider boom/);
    await log.flush();
    assert.deepEqual(errors, []);
    const recorded = readJson(logFile);
    assert.equal(recorded.length, 3);
    assert.deepEqual(recorded.map(item => item.status), ['parsed', 'parsed', 'failed']);

    const manifest = { 'Ok topic': { name: 'roundtrip-ok', context: contexts.ok, expect: { askModel: { result: liveResults.ok } } }, 'Review topic': { name: 'roundtrip-review', context: contexts.review, expect: { askModel: { result: liveResults.review }, plannerReview: { review: plain(parseAimPlannerReview(liveResults.review)) } } }, 'Failing topic': { name: 'roundtrip-failing', context: contexts.failing, expect: { askModel: { error: 'provider boom' } } } };
    const manifestFile = path.join(directory, 'manifest.json');
    fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    const corpus = path.join(directory, 'corpus');
    const output = execFileSync(process.execPath, [path.join(__dirname, 'tools', 'exchanges-to-replay.mjs'), logFile, corpus, '--manifest', manifestFile], { encoding: 'utf8' });
    assert.match(output, /3 replay case\(s\) written/);
    const files = fs.readdirSync(corpus).sort();
    assert.deepEqual(files, ['roundtrip-failing.replay.json', 'roundtrip-ok.replay.json', 'roundtrip-review.replay.json']);
    for (const file of files) {
      const replayCase = readJson(path.join(corpus, file));
      assert.equal(replayCase.matchPrompt, true);
      const { result } = await runCase(replayCase); // hash-bound: current code must rebuild the very same prompt
      if (file.includes('ok')) assert.deepEqual(result, liveResults.ok);
      if (file.includes('review')) assert.deepEqual(result, liveResults.review);
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

for (const round of ['r4', 'r5']) {
  const file = path.join(fixtures, `${round}-result-layer.replay.json`);
  test(`${round.toUpperCase()} result-layer replay (de-identified): CURRENT code handling of historical parsed outputs (old mindsearch-* marker contract), not a reproduction of the original failure layer`, async () => {
    await runResultLayerCase(readJson(file));
  });
  test(`${round.toUpperCase()} public replay fixture is de-identified (no ids, paths, timestamps, research or user text from the evidence)`, () => {
    const text = fs.readFileSync(file, 'utf8');
    for (const [name, pattern] of Object.entries({
      uuid: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, hex: /[0-9a-f]{16,}/i, time: /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, path: /\/Users\/|[A-Za-z]:\\\\|\.md\b/,
      topic: /venv|powershell|unittest|python|windows|\.venv|Scripts/i, cjk: /[\u3040-\u30ff\u3400-\u9fff]/
    })) assert.equal(pattern.test(text), false, `${round}: fixture must not contain ${name}`);
    for (const url of text.match(/https?:\/\/[^\s"\\)]+/g) ?? []) assert.match(url, /^https:\/\/example\.org\/neutral$/, `${round}: only the neutral URL may appear`);
  });
}

test('flow case: converter keeps AiExchange step and order, and the ordered raw exchanges replay to the live parsed results', async () => {
  const { AiExchangeLog } = load('ai-exchange-log.ts');
  const { convertExchanges } = await import(pathToFileURL(path.join(__dirname, 'tools', 'exchanges-to-replay.mjs')).href);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vam-flow-'));
  try {
    const logFile = path.join(directory, 'ai-exchanges.json');
    const log = new AiExchangeLog(nodeFsAdapter, logFile, () => {});
    const replies = { 'Step one topic': JSON.stringify({ summary: 'One', detail: 'First detail', suggestions: [], visualReferences: [] }), 'Step two topic': JSON.stringify({ summary: 'Two', detail: 'Second detail', suggestions: [{ title: 'Next', task: 'Do next', contribution: 'Why' }], visualReferences: [] }) };
    const live = { runTask: async (prompt, _model, _effort, _schema, controls) => { controls.onRequest({ input: [{ type: 'text', text: prompt }] }); return replies[prompt.includes('Step one topic') ? 'Step one topic' : 'Step two topic']; } };
    const contexts = ['Step one topic', 'Step two topic'].map(title => ({ title, summary: '', rules: '', detail: '', task: 'Plain task', ancestors: '', mode: 'task', researchMode: 'local', researchDepth: 'fast', visualMode: 'off' }));
    const service = makeService(live, { logging: true, exchanges: log });
    const results = [];
    for (const context of contexts) results.push(plain(await service.askModel(context, 'gpt-6-luna', 'low')));
    await log.flush();
    const recorded = readJson(logFile);
    assert.equal(recorded.length, 2);
    recorded[0].step = 'aim.outline@1'; recorded[1].step = 'aim.write@2'; // a Step Runner call stamps stepId@version on its exchange
    const manifest = { '@flow': { language: 'en', expect: { stepOrder: ['aim.outline@1', 'aim.write@2'] } } };
    recorded.forEach((entry, index) => { manifest[entry.id] = { context: contexts[index], expect: { askModel: { result: results[index] } } }; });
    const [flow, ...rest] = convertExchanges(recorded, { manifest, flow: 'live-flow' });
    assert.equal(rest.length, 0, 'a flow converts to exactly one case');
    assert.equal(flow.kind, 'flow');
    assert.deepEqual(flow.exchanges.map(item => item.step), ['aim.outline@1', 'aim.write@2']);
    assert.deepEqual(flow.exchanges.map(item => item.exchangeId), recorded.map(item => item.id));
    assert.equal(flow.matchPrompt, true);
    const { observed } = await runFlowCase(JSON.parse(JSON.stringify(flow)));
    assert.deepEqual(observed.map(item => item.result), results);
    // CLI: --flow writes one file; a wrong step order is caught.
    const manifestFile = path.join(directory, 'manifest.json'); fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    fs.writeFileSync(logFile, JSON.stringify(recorded));
    const out = path.join(directory, 'corpus');
    assert.match(execFileSync(process.execPath, [path.join(__dirname, 'tools', 'exchanges-to-replay.mjs'), logFile, out, '--manifest', manifestFile, '--flow', 'live-flow'], { encoding: 'utf8' }), /1 replay case\(s\) written/);
    assert.deepEqual(fs.readdirSync(out), ['live-flow.replay.json']);
    const written = readJson(path.join(out, 'live-flow.replay.json'));
    await runAnyCase(written);
    await assert.rejects(runFlowCase({ ...written, expect: { stepOrder: ['aim.write@2', 'aim.outline@1'] } }), /recorded step order/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});


/** Build a synthetic live ai-exchanges.json through the real AiExchangeLog + runtimeStepProvider + AiTaskService, with a fake runtime that logs a Codex-shaped (or Claude-shaped) request. */
async function recordSyntheticExchanges(directory) {
  const { AiExchangeLog } = load('ai-exchange-log.ts');
  const logFile = path.join(directory, 'ai-exchanges.json');
  const log = new AiExchangeLog(nodeFsAdapter, logFile, error => { throw error; });
  const base = { summary: '', rules: '', detail: '', ancestors: '', mode: 'task', researchMode: 'local', researchDepth: 'fast', visualMode: 'off' };
  const reviewReply = JSON.stringify({ summary: 'Review', detail: 'Interim.', suggestions: [], visualReferences: [], aim: { goalAnswered: true, decision: 'conclude', rationale: 'Enough evidence.', stopReason: 'Goal answered.', question: '', answerOptions: [], researchTarget: null } });
  const auditReply = JSON.stringify({ summary: 'external_evidence', detail: 'A web search can answer it.', suggestions: [], visualReferences: [] });
  const replies = {
    'Review topic': reviewReply,
    'Audit topic': auditReply,
    'Claude topic': JSON.stringify({ summary: 'Claude summary', detail: 'Claude detail', suggestions: [], visualReferences: [] }),
    'Broken topic': 'this is not json at all'
  };
  const runtime = {
    runTask: async (prompt, _model, _effort, schema, controls) => {
      const topic = Object.keys(replies).concat('Provider topic').find(name => prompt.includes(name));
      controls.onRequest(topic === 'Claude topic' ? { provider: 'claude', executable: 'claude', args: ['--print', '--json-schema', '<response-schema>'], input: '<VAM prompt via stdin>' } : { threadId: 't', input: [{ type: 'text', text: prompt }], model: 'gpt-6-luna', effort: 'low', ...(schema ? { outputSchema: schema } : {}) });
      if (topic === 'Provider topic') throw new Error('provider boom');
      return replies[topic];
    }
  };
  const service = makeService(runtime, { logging: true, exchanges: log });
  const aim = { ...base, promptProfile: 'aim', ancestors: '' };
  const contexts = [
    ['gpt-6-luna', { ...aim, title: 'Review topic', detail: 'Reports', task: '<!-- aim-phase: report-review -->\nReview', aimContract: { kind: 'review', decisions: ['research_more', 'ask_user', 'conclude'] } }],
    ['gpt-6-luna', { ...aim, title: 'Audit topic', task: '<!-- aim-phase: research-gap-audit -->\nAudit', responseContract: 'aim-gap-audit' }],
    ['claude:sonnet', { ...base, title: 'Claude topic', task: 'Plain task' }],
    ['gpt-6-luna', { ...base, title: 'Broken topic', task: 'Plain task' }],
    ['gpt-6-luna', { ...base, title: 'Provider topic', task: 'Plain task' }]
  ];
  for (const [model, context] of contexts) { try { await service.askModel(context, model, 'low'); } catch { /* the failures are what is recorded */ } }
  await log.flush();
  return { logFile, recorded: readJson(logFile) };
}

test('parse-layer replay: a recorded live log converts without a manifest and replays through the step parser; a mutated raw reply fails', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vam-parse-layer-'));
  try {
    const { logFile, recorded } = await recordSyntheticExchanges(directory);
    assert.deepEqual(recorded.map(item => item.status), ['parsed', 'parsed', 'parsed', 'failed', 'failed']);
    assert.deepEqual(recorded.map(item => item.step), ['aim.report-review@1', 'aim.research-gap-audit@1', 'task.run@1', 'task.run@1', 'task.run@1']);
    const corpus = path.join(directory, 'corpus');
    const output = execFileSync(process.execPath, [path.join(__dirname, 'tools', 'exchanges-to-replay.mjs'), logFile, corpus, '--parse-layer', 'synthetic-live'], { encoding: 'utf8' });
    assert.match(output, /1 replay case\(s\) written/);
    assert.deepEqual(fs.readdirSync(corpus), ['synthetic-live.replay.json']);
    const replayCase = readJson(path.join(corpus, 'synthetic-live.replay.json'));
    assert.equal(replayCase.kind, 'parse');
    assert.equal(replayCase.entries.length, 5);
    assert.deepEqual(replayCase.entries.map(item => item.responseSchema !== null), [true, true, true, true, true].map((_value, index) => index !== 2), 'Codex requests carry the schema; the Claude request log does not');
    assert.equal(replayCase.entries[0].responseSchema.properties.aim.properties.decision.enum.includes('conclude'), true);
    assert.equal(replayCase.entries[4].raw, null, 'a provider failure keeps no raw reply');
    assert.equal(replayCase.entries[0].promptSha256, sha256(recorded[0].prompt));
    const modes = await runParseCase(replayCase);
    assert.deepEqual(modes, ['parsed', 'parsed', 'schema-only', 'parse-failure', 'provider-error']);
    // The AIM entry really goes through the contract fold (the aim payload becomes the review marker); the gap audit is checked strictly.
    const mutatedAudit = JSON.parse(JSON.stringify(replayCase));
    mutatedAudit.entries[1].raw = JSON.stringify({ summary: 'something_else', detail: 'x', suggestions: [], visualReferences: [] });
    await assert.rejects(runParseCase(mutatedAudit), /invalid structured classification/);
    const mutatedAim = JSON.parse(JSON.stringify(replayCase));
    mutatedAim.entries[0].raw = 'not json at all';
    await assert.rejects(runParseCase(mutatedAim), /No complete JSON object/);
    const mutatedFailure = JSON.parse(JSON.stringify(replayCase));
    mutatedFailure.entries[3].raw = JSON.stringify({ summary: 'S', detail: 'D', suggestions: [], visualReferences: [] });
    await assert.rejects(runParseCase(mutatedFailure), /recorded as a parse failure but current code parsed it/);
    const unknownStep = JSON.parse(JSON.stringify(replayCase));
    unknownStep.entries[0].step = 'mystery.step@1';
    await assert.rejects(runParseCase(unknownStep), /unknown step id/);
    const noStep = JSON.parse(JSON.stringify(replayCase));
    noStep.entries[0].step = null;
    await assert.rejects(runParseCase(noStep), /unknown step id/);
    // Through the corpus dispatcher with node:test subtests, schema-only entries are named as such.
    await runAnyCase(replayCase);
    assert.equal(isSchemaOnly(replayCase.entries[2]), true);
    assert.equal(isSchemaOnly(replayCase.entries[0]), false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

// Merge mode: one request when the sources fit, extraction only when they do not, and a prompt that cannot ask for synthesis.
const mergeReply = JSON.stringify({ summary: 'S', detail: 'D', suggestions: [], visualReferences: [] });
const mergeContext = (content, over = {}) => ({ title: 'T', summary: 'No summary yet', rules: '', detail: '', task: 'MERGE-TASK', ancestors: '', mode: 'merge', researchMode: 'local', researchDepth: 'normal', visualMode: 'off', referenceDelivery: 'direct', referenceGroups: [{ id: 'g', name: 'Sources', location: 'Map.md', documents: [{ path: 'Notes/A.md', content }, { path: 'Notes/B.md', content: 'second source' }] }], ...over });
test('merge request: sources that fit one batch go in as written in a single task.run request', async () => {
  const runtime = replayRuntime([{ response: mergeReply }]);
  await makeService(runtime, { language: 'en' }).askModel(mergeContext('first source facts: 42 degrees'), 'claude:sonnet', 'low');
  assert.equal(runtime.calls.length, 1, 'no extraction pass');
  assert.match(runtime.calls[0].prompt, /first source facts: 42 degrees/); assert.match(runtime.calls[0].prompt, /second source/);
});
test('merge request: sources over the batch budget are still extracted first, and a normal synthesis always is', async () => {
  const big = 'x'.repeat(18_001);
  const runtime = replayRuntime([{ response: JSON.stringify({ summary: '', detail: 'finding', suggestions: [], visualReferences: [] }) }, { response: JSON.stringify({ summary: '', detail: 'finding', suggestions: [], visualReferences: [] }) }, { response: JSON.stringify({ summary: '', detail: 'finding', suggestions: [], visualReferences: [] }) }, { response: mergeReply }]);
  await makeService(runtime, { language: 'en' }).askModel(mergeContext(big), 'claude:sonnet', 'low');
  assert.ok(runtime.calls.length >= 2, 'extraction then the task');
  const synth = replayRuntime([{ response: JSON.stringify({ summary: '', detail: 'finding', suggestions: [], visualReferences: [] }) }, { response: mergeReply }]);
  await makeService(synth, { language: 'en' }).askModel(mergeContext('short', { mode: 'synthesize', referenceDelivery: undefined }), 'claude:sonnet', 'low');
  assert.equal(synth.calls.length, 2, 'synthesize keeps its extraction pass');
});
// Synthesis delivery (plan E W1): the four view call sites send referenceDelivery 'direct', so child notes that fit one batch
// go in as written in the single task request; over-budget sources are still extracted first.
const synthContext = (content, over = {}) => mergeContext(content, { mode: 'synthesize', task: 'SYNTH-TASK', ...over });
test('synthesis request (direct): child notes that fit one batch go in as written in a single task request with the Source registry', async () => {
  const runtime = replayRuntime([{ response: mergeReply }]);
  await makeService(runtime, { language: 'en' }).askModel(synthContext('child summary: 42 degrees'), 'claude:sonnet', 'low');
  assert.equal(runtime.calls.length, 1, 'no extraction pass');
  assert.match(runtime.calls[0].prompt, /child summary: 42 degrees/); assert.match(runtime.calls[0].prompt, /second source/);
  assert.match(runtime.calls[0].prompt, /\[S1\]/); assert.match(runtime.calls[0].prompt, /Notes\/A\.md/); assert.match(runtime.calls[0].prompt, /SYNTH-TASK/);
  assert.doesNotMatch(runtime.calls[0].prompt, /task\.reference-extract/);
});
test('synthesis request (direct): more than one batch is still extracted first, and [S#] in the reply resolves to the child note links', async () => {
  const finding = { response: JSON.stringify({ summary: '', detail: 'finding', suggestions: [], visualReferences: [] }) };
  const main = JSON.stringify({ summary: 'Sum [S1]', detail: '### Core conclusions\n\nA claim [S1] and another [S2].', suggestions: [], visualReferences: [] });
  const runtime = { calls: [], runTask: async prompt => { runtime.calls.push({ prompt }); return /SYNTH-TASK/.test(prompt) && !/Reference extraction|reference-extract/i.test(prompt) && /Source registry/i.test(prompt) ? main : finding.response; } };
  const result = await makeService(runtime, { language: 'en' }).askModel(synthContext('x'.repeat(18_001)), 'claude:sonnet', 'low');
  assert.ok(runtime.calls.length >= 2, 'extraction then the task');
  assert.match(result.detail, /\[\^1\]: \[\[Notes\/A\.md\|A\]\]/); assert.match(result.detail, /\[\^2\]: \[\[Notes\/B\.md\|B\]\]/);
});
test('synthesis request (direct): [S#] in a one-batch reply resolve to child note footnotes, and a copied child footnote keeps its definition', async () => {
  const detail = '### Core conclusions\n\nClaim [S1]. Copied from the child [^src-0abcdef] and [^1].\n\n### Evidence\n\n[^src-0abcdef]: https://example.org/original\n[^1]: https://example.org/child-one\n';
  const runtime = replayRuntime([{ response: JSON.stringify({ summary: 'Sum [S2]', detail, suggestions: [], visualReferences: [] }) }]);
  const result = await makeService(runtime, { language: 'en' }).askModel(synthContext('child with [^src-0abcdef] and [^1]\n\n[^src-0abcdef]: https://example.org/original\n[^1]: https://example.org/child-one'), 'claude:sonnet', 'low');
  assert.equal(runtime.calls.length, 1);
  assert.match(result.detail, /\[\[Notes\/A\.md\|A\]\]/); assert.doesNotMatch(result.summary, /\[S\d\]/);
  const references = [...result.detail.matchAll(/\[\^([^\]\s]+)\](?!:)/g)].map(match => match[1]);
  const definitions = new Set([...result.detail.matchAll(/^\[\^([^\]\s]+)\]:/gm)].map(match => match[1]));
  for (const label of references) assert.ok(definitions.has(label), `footnote [^${label}] is defined`);
});
test('synthesis request (direct): a reply that copies a child footnote reference without its definition never leaves an undefined footnote (one defining child: that source; ambiguous: removed)', async () => {
  const detail = '### Core conclusions\n\nClaim [S1]. Copied from the child [^1].\n';
  const runtime = replayRuntime([{ response: JSON.stringify({ summary: 'Sum', detail, suggestions: [], visualReferences: [] }) }]);
  const result = await makeService(runtime, { language: 'en' }).askModel(synthContext('child with [^1]\n\n[^1]: https://example.org/child-one'), 'claude:sonnet', 'low');
  const labels = [...result.detail.matchAll(/\[\^([^\]\s]+)\](?!:)/g)].map(match => match[1]);
  const defined = new Set([...result.detail.matchAll(/^\[\^([^\]\s]+)\]:/gm)].map(match => match[1]));
  const undefinedLabels = labels.filter(label => !defined.has(label));
  // Fixed 0.25 B6: the copied "[^1]" is defined by exactly one reference note, so it becomes that note's numbered source footnote.
  assert.deepEqual(undefinedLabels, []);
});
test('merge prompt never asks for synthesis (agreements, tradeoffs, open questions) or for added callouts; synthesize still does', async () => {
  for (const [language, ask, forbid] of [['en', /agreements, disagreements, tradeoffs/, /Practical tips or examples/], ['zh-TW', /共識、分歧、取捨/, /實用提醒|實用技巧/]]) {
    const merge = replayRuntime([{ response: mergeReply }]), synth = replayRuntime([{ response: JSON.stringify({ summary: '', detail: 'finding', suggestions: [], visualReferences: [] }) }, { response: mergeReply }]);
    await makeService(merge, { language }).askModel(mergeContext('a'), 'claude:sonnet', 'low');
    await makeService(synth, { language }).askModel(mergeContext('a', { mode: 'synthesize', referenceDelivery: undefined }), 'claude:sonnet', 'low');
    const mergePrompt = merge.calls.at(-1).prompt, synthPrompt = synth.calls.at(-1).prompt;
    assert.doesNotMatch(mergePrompt, ask, `${language}: merge prompt has no synthesize instruction`); assert.match(synthPrompt, ask, `${language}: synthesize unchanged`);
    assert.doesNotMatch(mergePrompt, /Synthesize mode|這是 Synthesize 模式/);
    assert.match(mergePrompt, /Merge mode|這是 Merge 模式/); assert.match(mergePrompt, /MERGE-TASK/);
    assert.match(mergePrompt, language === 'en' ? /Do not add comparisons, trends/ : /不得新增來源沒有的比較、趨勢/);
    assert.doesNotMatch(mergePrompt, /\[!tip\]/, `${language}: no callout suggestions`); assert.match(synthPrompt, /\[!tip\]/);
  }
});

const corpusDirectory = process.env.VAM_REPLAY_CORPUS;
if (corpusDirectory) {
  const files = fs.readdirSync(corpusDirectory).filter(file => file.endsWith('.replay.json')).sort();
  test(`private replay corpus ${corpusDirectory} contains cases`, () => assert.ok(files.length > 0, 'VAM_REPLAY_CORPUS is set but holds no *.replay.json'));
  for (const file of files) test(`corpus case ${file}`, async t => { await runAnyCase(readJson(path.join(corpusDirectory, file)), t); });
}
