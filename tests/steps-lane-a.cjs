// Lane A: Visual Map and the general task service run through the Step Runner.
//  - AiTaskService sends every model call as a step (task.run, aim.<phase>, task.reference-extract/reduce) and keeps
//    its exchange-log sequence: begin -> sent(request json) -> received -> parsed, or failed with the stage message.
//  - The 42 lane prompt keys left i18n.ts; their texts are Markdown fragments with a zh and an en file.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { load, root, makeService } = require('./support-replay.cjs');

const { translate } = load('i18n.ts');
const { buildAimPrompt } = load('ai/aim-prompt.ts');
const { taskPrompt } = load('core/steps/task/render.ts');

const GOOD = JSON.stringify({ summary: 'S', detail: 'D', suggestions: [], visualReferences: [] });
const context = (extra = {}) => ({ title: 'Topic', summary: 'Sum', rules: '', detail: '', task: 'Do the task', ancestors: '', sourceContext: '', mode: 'task', researchMode: 'local', researchDepth: 'fast', visualMode: 'off', ...extra });

/** An exchange log that records every call the service makes, in order. */
function spyLog() {
  const events = [], milestoneEvents = [];
  const record = name => (...args) => { events.push([name, ...args]); };
  // Milestones are written once per call next to the exchange sequence; they are collected apart so the sequence stays comparable.
  return { events, milestoneEvents, milestones: (...args) => { milestoneEvents.push(args); }, begin: record('begin'), sent: record('sent'), received: record('received'), parsed: record('parsed'), completed: record('completed'), failed: record('failed') };
}
/** A runtime that reports its request (as the real runtimes do) and answers with `reply(prompt, call)`. */
function runtime(reply) {
  const calls = [];
  return { calls, runTask: async (prompt, model, effort, schema, controls) => { calls.push({ prompt, model, effort, schema, controls }); controls.onRequest?.({ via: 'fake', n: calls.length }); return typeof reply === 'function' ? reply(prompt, calls.length) : reply; } };
}

test('a regular task is the step task.run@1; the exchange log keeps begin, sent(request json), received, parsed', async () => {
  const log = spyLog(), fake = runtime(GOOD), ids = [];
  await makeService(fake, { logging: true, exchanges: log }).askModel(context(), 'gpt-6-luna', 'low', undefined, id => ids.push(id));
  assert.deepEqual(log.events.map(event => event[0]), ['begin', 'sent', 'received', 'parsed'], 'no completed entry: the service ends the exchange with parsed');
  const [begin, sent, received, parsed] = log.events;
  assert.deepEqual({ ...begin[1], id: '<id>', startedAt: '<time>' }, { id: '<id>', startedAt: '<time>', topic: 'Topic', mode: 'task', model: 'gpt-6-luna', effort: 'low', step: 'task.run@1' });
  assert.equal(sent[1], begin[1].id); assert.equal(sent[2], JSON.stringify({ via: 'fake', n: 1 }, null, 2), 'sent stores the runtime request only, as before steps existed');
  assert.equal(sent[3], fake.calls[0].prompt); assert.equal(received[2], GOOD); assert.equal(parsed[1], begin[1].id);
  assert.deepEqual(ids, [begin[1].id]);
});

test('with exchange logging off nothing is logged, onExchange is not called and the call still runs', async () => {
  const log = spyLog(), fake = runtime(GOOD), ids = [];
  const result = await makeService(fake, { logging: false, exchanges: log }).askModel(context(), 'gpt-6-luna', 'low', undefined, id => ids.push(id));
  assert.equal(result.summary, 'S'); assert.deepEqual(log.events, []); assert.deepEqual(ids, []);
});

test('a parse failure ends the entry with failed(stage "parsing", message) and rethrows the parser error', async () => {
  const log = spyLog(), fake = runtime('this is not json');
  await assert.rejects(makeService(fake, { logging: true, exchanges: log }).askModel(context(), 'gpt-6-luna', 'low'), /JSON/);
  assert.deepEqual(log.events.map(event => event[0]), ['begin', 'sent', 'received', 'failed']);
  const failed = log.events[3];
  assert.match(failed[2], new RegExp(`^${translate('en', 'log.stage_parsing_reply')}: `));
  assert.equal(failed[1], log.events[0][1].id);
});

test('a runtime failure reports the stage it was in: starting before the request, waiting after it', async () => {
  for (const [reportRequest, stage] of [[false, 'log.stage_starting_ai'], [true, 'log.stage_waiting_reply']]) {
    const log = spyLog();
    const failing = { runTask: async (_prompt, _model, _effort, _schema, controls) => { if (reportRequest) controls.onRequest({ via: 'fake' }); throw new Error('provider down'); } };
    await assert.rejects(makeService(failing, { logging: true, exchanges: log }).askModel(context(), 'gpt-6-luna', 'low'), /provider down/);
    const names = log.events.map(event => event[0]);
    assert.deepEqual(names, reportRequest ? ['begin', 'sent', 'failed'] : ['begin', 'failed']);
    // The test's Error belongs to another realm than the service bundle, so the service reports it as text (as it always did).
    assert.match(log.events.at(-1)[2], new RegExp(`^${translate('en', stage)}: (Error: )?provider down$`));
  }
});

test('controls reach the runtime unchanged: abort signal, timeout, search flags, accepted callback and web events', async () => {
  const fake = runtime(GOOD), controller = new AbortController(), accepted = () => {}, web = () => {};
  await makeService(fake).askModel(context({ researchMode: 'research', timeoutMs: 240_000, aimIsolatedResearch: true }), 'gpt-6-luna', 'low', controller.signal, undefined, accepted, web);
  const controls = fake.calls[0].controls;
  assert.equal(controls.signal, controller.signal); assert.equal(controls.onAccepted, accepted); assert.equal(controls.onWebSearchEvent, web);
  assert.equal(controls.timeoutMs, 240_000); assert.ok(controls.timeoutMessage);
  assert.equal(controls.webSearch, true); assert.equal(controls.searchBudget, 0); assert.equal(controls.webSearchOnly, true); assert.equal(controls.textOnly, false);
  assert.ok(fake.calls[0].schema.required.includes('searchStatus'), 'isolated web research selects the web research schema');
});

test('Codex local research selects the runtime without web search; Claude models run through the Claude runtime', async () => {
  const { AiTaskService } = load('core/ai-task-service.ts');
  const seen = [], answer = name => ({ runTask: async (_p, model, _e, _s, controls) => { seen.push([name, model]); controls.onRequest?.({}); return GOOD; } });
  const service = new AiTaskService({ pluginDirectory: () => '/plugin', language: () => 'en', defaultReasoning: () => 'low', exchangeLoggingEnabled: () => false, exchanges: () => null, codexRuntime: (_dir, local) => answer(local ? 'codex-local' : 'codex-web'), claudeRuntime: () => answer('claude') });
  await service.askModel(context({ researchMode: 'local' }), 'gpt-6-luna', 'low');
  await service.askModel(context({ researchMode: 'research' }), 'gpt-6-luna', 'low');
  await service.askModel(context(), 'claude:sonnet', 'low');
  assert.deepEqual(seen, [['codex-local', 'gpt-6-luna'], ['codex-web', 'gpt-6-luna'], ['claude', 'sonnet']]);
});

test('an AIM request is the step aim.<phase>@1 and its prompt is exactly buildAimPrompt', async () => {
  const log = spyLog(), fake = runtime(GOOD);
  const aim = context({ promptProfile: 'aim', task: '<!-- aim-phase: research-plan -->\nPlan the evidence.', outputLanguage: 'zh-TW' });
  await makeService(fake, { logging: true, exchanges: log }).askModel(aim, 'gpt-6-luna', 'low');
  assert.equal(log.events[0][1].step, 'aim.research-plan@1');
  assert.equal(fake.calls[0].prompt, buildAimPrompt(aim, 'zh-TW'));
  assert.equal(taskPrompt(aim, 'zh-TW'), buildAimPrompt(aim, 'zh-TW'), 'the step render delegates to buildAimPrompt');
});

test('the reference extract and reduce rounds are their own steps, followed by the task.run step', async () => {
  const log = spyLog();
  const big = JSON.stringify({ summary: 'S', detail: 'e'.repeat(10_000), suggestions: [], visualReferences: [] });
  const fake = runtime(prompt => (prompt.includes('Extract relevant facts') ? big : GOOD));
  const documents = [1, 2, 3, 4].map(n => ({ path: `n${n}.md`, content: 'x'.repeat(14_000) }));
  const progress = [];
  await makeService(fake, { logging: true, exchanges: log }).askModel(context({ referenceGroups: [{ id: 'g', name: 'g', location: 'l', documents }], onProgress: text => progress.push(text) }), 'gpt-6-luna', 'low');
  const steps = log.events.filter(event => event[0] === 'begin').map(event => event[1].step);
  assert.deepEqual(steps, [...Array(4).fill('task.reference-extract@1'), ...Array(4).fill('task.reference-reduce@1'), 'task.run@1']);
  assert.ok(fake.calls[0].prompt.includes('Extract relevant facts'));
  assert.ok(fake.calls[4].prompt.includes('Combine the supplied extracted evidence'));
  assert.ok(fake.calls[8].prompt.includes('Source registry (retain these identities in citations):\n[S1]'));
  assert.equal(progress.at(-1), '');
});

test('Visual Map task text comes from fragments and renders the same as the strings it replaced', () => {
  const { expansionTask, researchTopicTask, synthesisGoalTask, mergeGoalTask, noSummaryYet } = load('experiences/visual-map/steps/fragments.ts');
  for (const language of ['en', 'zh-TW']) {
    assert.match(researchTopicTask(language, 'My {0} topic'), /My \{0\} topic/, 'a title is never re-scanned for placeholders');
    assert.ok(expansionTask(language, '- a: b', 'Go deeper').startsWith('Go deeper\n'));
    assert.ok(expansionTask(language, '- a: b', '').includes('\n- a: b\n'));
    assert.ok(synthesisGoalTask(language).length > 10 && noSummaryYet(language).length > 2);
    assert.ok(mergeGoalTask(language).length > 10 && mergeGoalTask(language) !== synthesisGoalTask(language));
  }
});

test('the lane keys are gone from i18n.ts and every fragment has a zh and an en file that a module imports', () => {
  const source = require('./support.cjs').i18nSource();
  const removed = 'research_topic direct_expansion guided_expansion expansion_direction existing_subtopics avoid_duplicates synthesis_directions synthesis_goal preliminary_map label_current_summary label_visual_references label_full_knowledge label_old_findings no_summary_yet output_language reference_extract reference_reduce json detail_structure adaptive_detail_structure general_task decompose synthesize default_task label_detail label_findings visual_none visual_preserve visual_on visual_auto visual_embed role source_safety reference_citations local_first label_topic label_summary label_rules label_sources label_ancestors label_task none'.split(' ');
  assert.equal(removed.length, 42);
  for (const key of removed) assert.doesNotMatch(source, new RegExp(`"prompt\\.${key}":`), `prompt.${key} must live in a fragment`);
  for (const directory of ['core/steps/_shared', 'core/steps/task', 'core/steps/reference', 'experiences/visual-map/steps']) {
    const names = fs.readdirSync(path.join(root, directory));
    for (const base of new Set(names.filter(name => /\.(zh|en)\.md$/.test(name)).map(name => name.replace(/\.(zh|en)\.md$/, ''))))
      for (const language of ['zh', 'en']) assert.ok(names.includes(`${base}.${language}.md`), `${directory}/${base}.${language}.md is missing`);
    const modules = names.filter(name => name.endsWith('.ts')).map(name => fs.readFileSync(path.join(root, directory, name), 'utf8')).join('\n');
    for (const name of names.filter(item => item.endsWith('.md'))) assert.ok(modules.includes(`./${name}`), `${directory}/${name} is not imported by a module in the directory`);
  }
});

test('architecture: ai-task-service sends model calls only through the Step Runner provider, and no lane file reads a removed key', () => {
  const service = fs.readFileSync(path.join(root, 'core', 'ai-task-service.ts'), 'utf8');
  assert.doesNotMatch(service, /\.runTask\(/, 'AiTaskService must not call a runtime directly');
  assert.match(service, /runtimeStepProvider\(/);
  for (const file of ['core/ai-task-service.ts', 'core/steps/task/render.ts', 'ai/aim-prompt.ts', 'ai/visual-guidance.ts', 'experiences/visual-map/view.ts', 'experiences/visual-map/thinking-origin.ts'])
    assert.doesNotMatch(fs.readFileSync(path.join(root, file), 'utf8'), /["`]prompt\.[a-z_]+["`]/, `${file} must not read a prompt.* i18n key`);
});

test('with note sources the task counts as accepted when the first extraction request is accepted, once', async () => {
  const order = [];
  let acceptedCount = 0;
  const fake = {
    calls: [],
    runTask: async (prompt, _model, _effort, _schema, controls) => {
      fake.calls.push(prompt);
      order.push(prompt.includes('Extract relevant facts') ? 'extract' : 'main');
      controls.onRequest?.({});
      controls.onAccepted?.();
      return GOOD;
    }
  };
  const documents = [{ path: 'n1.md', content: 'x'.repeat(100) }];
  await makeService(fake).askModel(context({ referenceGroups: [{ id: 'g', name: 'g', location: 'l', documents }] }), 'gpt-6-luna', 'low', undefined, undefined, () => {
    acceptedCount++;
    order.push('accepted');
  });
  assert.deepEqual(order, ['extract', 'accepted', 'main']);
  assert.equal(acceptedCount, 1);
});

test('a rerun without note sources keeps a source footnote linked by restoring its definition from the current detail', async () => {
  const kept = JSON.stringify({ summary: 'S', detail: '### Core conclusions\n\nKept[^1]', suggestions: [], visualReferences: [] });
  const result = await makeService(runtime(kept)).askModel(context({ detail: 'Old[^1]\n\n[^1]: [[Maps/A/one.md|one]]' }), 'gpt-6-luna', 'low');
  assert.ok(result.detail.includes('Kept[^1]'));
  assert.ok(result.detail.includes('[^1]: [[Maps/A/one.md|one]]'));
});
