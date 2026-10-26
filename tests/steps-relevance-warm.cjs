// The relevance grade and the pre-started Claude CLI (D-2026-10-99..103): the plugin starts the very command the grade
// will run, the real runner takes that process, and nothing else is started or killed. Synthetic: no process, no AI.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const S = require('./support.cjs');
const { loadWithAiCalls, aiCallsFor } = require('./support-ai-calls.cjs');
const { nodeFsAdapter } = require('./support-fs-adapter.cjs');

const { default: Plugin } = S.load('main.ts', { obsidian: S.obsidian });
const grade = loadWithAiCalls('core/relevance-grade-service.ts');
const { AiExchangeLog } = S.load('ai-exchange-log.ts');
const { stepEffort } = S.load('core/provider-step-runner.ts');

const newPlugin = () => {
  const plugin = new Plugin();
  plugin.app = { vault: {}, fileManager: {} };
  plugin.logs = { appendLog() {} };
  plugin.pluginDirectory = () => '/plugin';
  return plugin;
};

test('plugin: prewarmClaudeStep starts the step\'s own command (model id, effort rule, its schema, no web tools); a Codex model releases; after unload nothing starts', () => {
  const plugin = newPlugin();
  const calls = [];
  plugin.claudeCli = directory => ({ prewarm: (...args) => { calls.push([directory, ...args]); return true; } });
  plugin.prewarmClaudeStep('claude:sonnet', 'auto', grade.RELEVANCE_GRADE_SCHEMA);
  plugin.prewarmClaudeStep('claude:opus', 'high', grade.RELEVANCE_RECALIBRATE_SCHEMA);
  assert.deepEqual(calls.map(call => [call[0], call[1], call[2], call[3] === grade.RELEVANCE_GRADE_SCHEMA, call[4]]), [['/plugin', 'sonnet', 'low', true, false], ['/plugin', 'opus', 'high', false, false]], 'auto is low, like the run');
  assert.equal(calls[1][3], grade.RELEVANCE_RECALIBRATE_SCHEMA);
  assert.equal(stepEffort('auto'), 'low'); assert.equal(stepEffort('medium'), 'medium');
  let released = 0;
  plugin.aiRuntime = { releaseWarm: () => { released++; }, reset: () => { released += 10; }, dispose: () => { released += 100; } };
  plugin.prewarmClaudeStep('gpt-test', 'low', grade.RELEVANCE_GRADE_SCHEMA);
  assert.equal(released, 1, 'Codex starts nothing and drops a waiting process'); assert.equal(calls.length, 2);
  plugin.pluginDirectory = () => { throw new Error('no folder'); };
  assert.doesNotThrow(() => plugin.prewarmClaudeStep('claude:sonnet', 'low', grade.RELEVANCE_GRADE_SCHEMA), 'pre-starting never fails the panel');
  plugin.repo = { dispose() {} }; plugin.expansionCoordinator = { stopAll() {} }; plugin.modelDiscovery = { invalidate() {} };
  plugin.onunload();
  plugin.pluginDirectory = () => '/plugin';
  plugin.prewarmClaudeStep('claude:sonnet', 'low', grade.RELEVANCE_GRADE_SCHEMA);
  assert.equal(calls.length, 2, 'a panel event after unload starts nothing');
  assert.equal(plugin.usageNoticePending('claude:sonnet'), !plugin.settings.claudeUsageNoticeSeen);
});

const tree = [
  { id: 'r', title: 'Root', summary: 'Root summary', status: 'completed', parentId: null, depth: 0 },
  { id: 'a', title: 'A', summary: 'A summary', status: 'idea', parentId: 'r', depth: 1 },
  { id: 'b', title: 'B', summary: 'B summary', status: 'idea', parentId: 'r', depth: 1 }
];
const request = (extra = {}) => ({ goal: 'Cook a steak', nodes: tree, language: 'en', model: 'claude:sonnet', reasoning: 'auto', ...extra });

// A real Claude runtime and warm pool behind the real step runner, with a fake process.
function fixture() {
  const children = [];
  const spawn = (_exe, args) => {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.args = args; child.writes = []; child.signals = [];
    child.stdin = { on() {}, write(text, done) { child.writes.push(text); done?.(); return true; }, end(text, done) { if (text !== undefined) child.writes.push(text); done?.(); } };
    child.kill = signal => { child.signals.push(signal); process.nextTick(() => child.emit('close', null, signal)); return true; };
    children.push(child); return child;
  };
  const { ClaudeCodeCliRuntime } = S.load('ai/runtime/claude-code-cli.ts', { 'node:child_process': { spawn } });
  const { ClaudeWarmPool } = S.load('ai/runtime/claude-warm-pool.ts');
  const pool = new ClaudeWarmPool({ clock: { setTimeout: () => 0, clearTimeout() {} } });
  const runtime = new ClaudeCodeCliRuntime({ executable: 'claude', cwd: '/plugin', env: {}, spawn, warmPool: pool });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vam-relevance-warm-'));
  const log = new AiExchangeLog(nodeFsAdapter, path.join(dir, 'ai-exchanges.json'), error => { throw error; });
  const options = { pluginDirectory: () => '/plugin', exchangeLoggingEnabled: () => true, exchanges: () => log, codexRuntime: () => { throw new Error('unexpected provider'); }, claudeRuntime: () => runtime };
  const service = new grade.RelevanceGradeService(grade.providerRelevanceGradeRunner(aiCallsFor(grade, options, new Map())));
  // Answers whichever process received the prompt with a valid grade of the two cards.
  const answer = async child => {
    for (let i = 0; i < 50 && !child.writes.length; i++) await new Promise(resolve => setImmediate(resolve));
    const lines = [{ type: 'system', subtype: 'init' }, { type: 'result', subtype: 'success', is_error: false, structured_output: { items: [{ id: 'c2', tier: 'core' }, { id: 'c3', tier: 'side' }] } }];
    child.stdout.emit('data', Buffer.from(lines.map(line => JSON.stringify(line)).join('\n') + '\n'));
    process.nextTick(() => child.emit('close', 0));
  };
  return { children, pool, runtime, service, log, answer };
}

test('a grade takes the process the panel pre-started (same command), reads stream-json and records prespawned', async () => {
  const f = fixture();
  assert.equal(f.runtime.prewarm('sonnet', stepEffort('auto'), grade.RELEVANCE_GRADE_SCHEMA, false), true);
  assert.equal(f.children.length, 1); assert.deepEqual(f.children[0].writes, [], 'nothing is sent while it waits');
  const warm = f.children[0];
  const run = f.service.grade(request(), new AbortController().signal);
  await f.answer(warm);
  const result = await run;
  assert.equal(f.children.length, 1, 'no second process: the pre-started one is used');
  assert.deepEqual(JSON.parse(JSON.stringify(result.items)), [{ id: 'a', tier: 'core' }, { id: 'b', tier: 'side' }]);
  assert.equal(warm.args[warm.args.indexOf('--output-format') + 1], 'stream-json');
  assert.ok(warm.args.includes('--include-partial-messages'));
  assert.equal(warm.args[warm.args.indexOf('--effort') + 1], 'low');
  assert.equal(JSON.parse(warm.writes[0]).message.content[0].text.includes('Cook a steak'), true, 'only the prompt is written');
  const entry = f.log.getEntries()[0];
  assert.equal(entry.milestones.prespawned, true); assert.equal(entry.milestones.stream, 'stream-json');
  assert.equal(f.pool.size, 0);
});

test('without a pre-started process the grade starts its own and records prespawned false; a recalibration pre-start does not serve a full grade and is left alone', async () => {
  const cold = fixture();
  const run = cold.service.grade(request(), new AbortController().signal);
  for (let i = 0; i < 50 && !cold.children.length; i++) await new Promise(resolve => setImmediate(resolve));
  await cold.answer(cold.children[0]); await run;
  assert.equal(cold.log.getEntries()[0].milestones.prespawned, false);
  const f = fixture();
  f.runtime.prewarm('sonnet', 'low', grade.RELEVANCE_RECALIBRATE_SCHEMA, false);
  const other = f.service.grade(request(), new AbortController().signal);
  for (let i = 0; i < 50 && f.children.length < 2; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.children.length, 2, 'the full grade started its own process');
  assert.deepEqual(f.children[0].signals, [], 'and left the waiting one alone'); assert.equal(f.pool.size, 1);
  await f.answer(f.children[1]); await other;
});

test('a different reasoning level, model or folder starts cold; Stop before the call releases the waiting process', async () => {
  const f = fixture();
  f.runtime.prewarm('sonnet', 'low', grade.RELEVANCE_GRADE_SCHEMA, false);
  const high = f.service.grade(request({ reasoning: 'high' }), new AbortController().signal);
  for (let i = 0; i < 50 && f.children.length < 2; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.children.length, 2, 'effort high differs from the pre-started low');
  await f.answer(f.children[1]); await high;
  const early = new AbortController(); early.abort();
  await assert.rejects(f.service.grade(request(), early.signal), error => error.code === 'stopped');
  assert.equal(f.children.length, 2, 'a run stopped before it started sends nothing');
});
