const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, integrationTest, root, load, plain, obsidian, DEFAULT_SETTINGS, until } = require('../support.cjs');
test('Codex executable discovery covers Homebrew, local npm, Volta, fnm, nvm and inherited PATH', () => {
  const { executableCandidates } = load('main.ts', { obsidian });
  const candidates = executableCandidates('codex', '/Users/friend', '/custom/npm/bin:/usr/bin', ['v20.18.0']);
  for (const path of [
    '/Users/friend/.local/bin/codex', '/Users/friend/.npm-global/bin/codex',
    '/Users/friend/.volta/bin/codex', '/Users/friend/.fnm/current/bin/codex',
    '/opt/homebrew/bin/codex', '/usr/local/bin/codex',
    '/Users/friend/.nvm/versions/node/v20.18.0/bin/codex', '/custom/npm/bin/codex'
  ]) assert.ok(candidates.includes(path), path);
  assert.deepEqual(Array.from(executableCandidates('/exact/codex', '/Users/friend', '', [])), ['/exact/codex']);
});
integrationTest('Codex launch uses its sibling Node with automatic nvm discovery and explicit paths', async () => {
  const temporary = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'vam-codex-path-'));
  const home = path.join(temporary, 'Friend Home');
  const bin = path.join(home, '.nvm/versions/node/v24.14.0/bin');
  const executable = path.join(bin, 'codex');
  fs.mkdirSync(bin, { recursive: true });
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  fs.writeFileSync(path.join(bin, 'node'), `#!/bin/sh\nVAM_TEST_NODE=sibling exec ${quote(process.execPath)} "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(executable, `#!/usr/bin/env node
const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  const model = process.env.VAM_TEST_NODE === 'sibling' ? 'sibling-node' : 'wrong-node';
  const result = message.method === 'model/list'
    ? { data: [{ id: model, model, displayName: model, hidden: false, supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }] }
    : {};
  process.stdout.write(JSON.stringify({ id: message.id, result }) + '\\n');
});
`, { mode: 0o755 });
  try {
    for (const configured of ['codex', executable]) {
      const environment = { HOME: home, PATH: '/usr/bin:/bin', VAM_TEST_PRESERVED: 'yes' };
      const before = { ...environment };
      const { default: Plugin } = load('main.ts', { obsidian }, { process: { env: environment } });
      const plugin = new Plugin();
      plugin.settings.codexPath = configured; plugin.manifest = { version: '0.7.1' };
      const runtime = plugin.runtime(temporary);
      try {
        assert.equal(runtime.options.executable, executable);
        const models = await runtime.listModels();
        assert.equal(models[0].model, 'sibling-node');
        assert.equal(runtime.options.env.PATH.split(path.delimiter)[0], bin);
        assert.equal(runtime.options.env.VAM_TEST_PRESERVED, 'yes');
        assert.deepEqual(environment, before);
      } finally { runtime.stop(); }
    }
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});
test('Codex launch retains fallback PATH without adding the working directory', () => {
  for (const environment of [{}, { PATH: '/custom/bin:/usr/bin:/custom/bin', KEEP: 'yes' }]) {
    const { default: Plugin } = load('main.ts', { obsidian, 'node:fs': { existsSync: () => false, readdirSync: () => [] } }, { process: { env: environment } });
    const plugin = new Plugin(); plugin.manifest = { version: '0.7.1' };
    const runtime = plugin.runtime('/vault');
    const dirs = Array.from(runtime.options.env.PATH.split(path.delimiter));
    assert.equal(runtime.options.executable, 'codex');
    assert.ok(!dirs.includes('.') && !dirs.includes(''));
    for (const dir of ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']) assert.ok(dirs.includes(dir));
    if (environment.PATH) assert.ok(dirs.includes('/custom/bin'));
    assert.equal(dirs.length, new Set(dirs).size);
    assert.equal(runtime.options.env.KEEP, environment.KEEP);
  }
});
test('Codex output schema requires every declared property', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(root, 'response-schema.json'), 'utf8'));
  assert.deepEqual(new Set(schema.required), new Set(Object.keys(schema.properties)));
});
integrationTest('Codex App Server uses model/list, selected reasoning and fresh ephemeral threads', async () => {
  const { EventEmitter } = require('node:events'); let command, args, turnCount = 0, threadCount = 0, unsubscribeCount = 0; const efforts = [];
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
  child.stdin = { write: line => {
    const message = JSON.parse(line.trim());
    const reply = result => process.nextTick(() => child.stdout.emit('data', Buffer.from(`${JSON.stringify({ id: message.id, result })}\n`)));
    if (message.method === 'initialize') reply({});
    else if (message.method === 'model/list') reply({ data: [
      { id: 'visible', model: 'visible-model', displayName: 'Visible', hidden: false, supportedReasoningEfforts: [{ reasoningEffort: 'low' }], defaultReasoningEffort: 'low', isDefault: true },
      { id: 'hidden', model: 'hidden-model', displayName: 'Hidden', hidden: true, supportedReasoningEfforts: [{ reasoningEffort: 'low' }], defaultReasoningEffort: 'low', isDefault: false },
      { id: 'internal', model: 'internal-model', displayName: '', hidden: false, supportedReasoningEfforts: [], defaultReasoningEffort: 'low', isDefault: false }
    ], nextCursor: null });
    else if (message.method === 'thread/start') { assert.equal(message.params.ephemeral, true); assert.equal(message.params.sandbox, 'read-only'); reply({ thread: { id: `thread-${++threadCount}` } }); }
    else if (message.method === 'thread/unsubscribe') { unsubscribeCount++; reply({}); }
    else if (message.method === 'turn/start') {
      turnCount++; efforts.push(message.params.effort); assert.ok(message.params.outputSchema.properties.summary); assert.match(message.params.input[0].text, /Current topic/);
      assert.deepEqual(plain(message.params.sandboxPolicy), { type: 'readOnly', networkAccess: false });
      const threadId = message.params.threadId, summary = threadId === 'thread-1' ? 'first' : 'second';
      process.nextTick(() => {
        child.stdout.emit('data', Buffer.from(`${JSON.stringify({ id: message.id, result: { turn: { id: `turn-${turnCount}` } } })}\n`));
        child.stdout.emit('data', Buffer.from(`${JSON.stringify({ method: 'item/completed', params: { threadId, turnId: `turn-${turnCount}`, item: { type: 'agentMessage', text: 'Progress commentary' } } })}\n`));
        child.stdout.emit('data', Buffer.from(`${JSON.stringify({ method: 'item/completed', params: { threadId, turnId: `turn-${turnCount}`, item: { type: 'agentMessage', text: JSON.stringify({ summary, detail: 'detail', suggestions: [], visualReferences: [] }) } } })}\n`));
        child.stdout.emit('data', Buffer.from(`${JSON.stringify({ method: 'turn/completed', params: { threadId, turn: { status: 'completed' } } })}\n`));
      });
    }
  } };
  const { default: Plugin } = load('main.ts', { obsidian, 'node:fs': { existsSync: () => false, readdirSync: () => [] }, 'node:child_process': { spawn: (path, invocation) => { command = path; args = invocation; return child; } } });
  const plugin = new Plugin(); plugin.app = { vault: { adapter: new obsidian.FileSystemAdapter() }, workspace: { getLeavesOfType: () => [] } }; plugin.manifest = { dir: '.obsidian/plugins/visual-agent-map' };
  plugin.saveData = async data => { plugin.saved = data; };
  plugin.codexDiagnostic = () => ({ executable: 'codex', installed: true });
  await plugin.refreshModelDiscovery('codex');
  plugin.settings.cliReasoning = 'low';
  const [result, second] = await Promise.all([
    plugin.askModel({ title: 'Current topic', summary: 'current summary', rules: 'Use official sources', task: 'task', ancestors: 'context', mode: 'task' }, 'visible-model', 'medium'),
    plugin.askModel({ title: 'Current topic', summary: 'current summary', rules: 'Use official sources', task: 'task', ancestors: 'context', mode: 'synthesize' }, 'visible-model', 'medium')
  ]);
  assert.equal(command, DEFAULT_SETTINGS.codexPath); assert.deepEqual(Array.from(args), ['app-server']);
  assert.equal(turnCount, 2); assert.equal(threadCount, 2);
  assert.equal(unsubscribeCount, 2);
  assert.deepEqual(efforts, ['medium', 'medium']);
  assert.equal(plugin.settings.models, 'visible-model');
  assert.equal(result.summary, 'first');
  assert.equal(second.summary, 'second');
});
integrationTest('Codex late turn acknowledgement after abort is never reported accepted', async () => {
  const { EventEmitter } = require('node:events'); const sent = []; let turnRequest;
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
  const emit = message => process.nextTick(() => child.stdout.emit('data', Buffer.from(`${JSON.stringify(message)}\n`)));
  child.stdin = { write: line => {
    const message = JSON.parse(line.trim()); sent.push(message);
    if (message.method === 'initialize') emit({ id: message.id, result: {} });
    else if (message.method === 'thread/start') emit({ id: message.id, result: { thread: { id: 'late-thread' } } });
    else if (message.method === 'turn/start') turnRequest = message.id;
    else if (message.method === 'thread/unsubscribe') emit({ id: message.id, result: {} });
  } };
  const { CodexAppServerRuntime } = load('ai/runtime/codex-app-server.ts', { 'node:child_process': { spawn: () => child } });
  const runtime = new CodexAppServerRuntime({ executable: 'codex', cwd: '/plugin', env: {}, clientVersion: 'test' });
  const controller = new AbortController(); let accepted = 0;
  try {
    const pending = runtime.runTask('research', 'model', 'low', {}, { signal: controller.signal, onAccepted: () => accepted++ });
    await until(() => !!turnRequest);
    assert.equal(accepted, 0);
    controller.abort();
    emit({ id: turnRequest, result: { turn: { id: 'late-turn' } } });
    await assert.rejects(pending, error => error.name === 'AbortError');
    assert.equal(accepted, 0);
  } finally { runtime.stop(); }
});
integrationTest('Codex App Server accepts a plain-text turn without changing structured VAM turns', async () => {
  const { EventEmitter } = require('node:events'); const sent = []; let steer;
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
  const emit = message => process.nextTick(() => child.stdout.emit('data', Buffer.from(`${JSON.stringify(message)}\n`)));
  child.stdin = { write: line => {
    const message = JSON.parse(line.trim()); sent.push(message);
    if (message.method === 'initialize') emit({ id: message.id, result: {} });
    else if (message.method === 'config/read') emit({ id: message.id, result: { config: { mcp_servers: { inherited: {} } } } });
    else if (message.method === 'thread/start') { assert.equal(message.params.config['features.shell_tool'], false); assert.equal(message.params.config['features.unified_exec'], false); assert.match(message.params.baseInstructions, /text-generation/); emit({ id: message.id, result: { thread: { id: 'plain-thread' } } }); }
    else if (message.method === 'turn/start') {
      assert.equal(Object.hasOwn(message.params, 'outputSchema'), false);
      emit({ id: message.id, result: { turn: { id: 'plain-turn' } } });
      emit({ method: 'item/agentMessage/delta', params: { threadId: 'plain-thread', itemId: 'agent-1', delta: '# Full' } });
      emit({ method: 'item/agentMessage/delta', params: { threadId: 'plain-thread', itemId: 'agent-1', delta: ' conversation' } });
    } else if (message.method === 'turn/steer') {
      assert.match(message.params.input[0].text, /include parent question/); emit({ id: message.id, result: {} });
      emit({ method: 'item/completed', params: { threadId: 'plain-thread', item: { id: 'agent-1', type: 'agentMessage', text: '# Full conversation' } } });
      emit({ method: 'turn/completed', params: { threadId: 'plain-thread', turn: { status: 'completed' } } });
    } else if (message.method === 'thread/unsubscribe') emit({ id: message.id, result: {} });
  } };
  const { CodexAppServerRuntime } = load('ai/runtime/codex-app-server.ts', { 'node:child_process': { spawn: () => child } });
  const runtime = new CodexAppServerRuntime({ executable: 'codex', cwd: '/plugin', env: {}, clientVersion: 'test' });
  try { const chunks = []; const running = runtime.runTask('coffee', 'model', 'high', undefined, { textOnly: true, onText: text => chunks.push(text), onSteer: handler => { steer = handler; } }); await until(() => !!steer); await steer('include parent question'); assert.equal(await running, '# Full conversation'); assert.deepEqual(chunks, ['# Full', '# Full conversation', '# Full conversation']); }
  finally { runtime.stop(); }
});
test('AI task acceptance waits for the provider acknowledgement, not request logging', async () => {
  const { AiTaskService } = load('core/ai-task-service.ts');
  let controls, release, accepted = 0;
  const service = new AiTaskService({
    pluginDirectory: () => '/plugin', language: () => 'en', defaultReasoning: () => 'low',
    exchangeLoggingEnabled: () => false, exchanges: () => null,
    codexRuntime: () => ({ runTask: (_prompt, _model, _effort, _schema, runtimeControls) => {
      controls = runtimeControls; controls.onRequest({ method: 'turn/start' });
      return new Promise(resolve => { release = resolve; });
    } }), claudeRuntime: () => { throw new Error('unexpected provider'); }
  });
  const context = { title: 'Topic', summary: '', rules: '', detail: '', task: 'task', ancestors: '', mode: 'task', researchMode: 'local', researchDepth: 'fast', visualMode: 'off' };
  const pending = service.askModel(context, 'test-model', 'low', undefined, undefined, () => accepted++);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(accepted, 0);
  controls.onAccepted();
  assert.equal(accepted, 1);
  release('{"summary":"done","detail":"details","suggestions":[],"visualReferences":[]}');
  await pending;
});
integrationTest('local Codex runtime disables web search for its process', async () => {
  const { EventEmitter } = require('node:events'); let args;
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
  child.stdin = { write: line => { const message = JSON.parse(line.trim()); if (message.method === 'initialize') process.nextTick(() => child.stdout.emit('data', Buffer.from(`${JSON.stringify({ id: message.id, result: {} })}\n`))); } };
  const { CodexAppServerRuntime } = load('ai/runtime/codex-app-server.ts', { 'node:child_process': { spawn: (_path, invocation) => { args = invocation; return child; } } });
  const runtime = new CodexAppServerRuntime({ executable: 'codex', cwd: '/plugin', env: {}, clientVersion: 'test', webSearchDisabled: true });
  await runtime.start(); assert.deepEqual(plain(args), ['--config', 'web_search="disabled"', 'app-server']); runtime.stop();
});
integrationTest('AiTaskService forwards native Codex webSearch events unchanged to the caller', async () => {
  const { EventEmitter } = require('node:events');
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
  const emit = message => process.nextTick(() => child.stdout.emit('data', Buffer.from(`${JSON.stringify(message)}\n`)));
  const rawEvents = [
    { method: 'item/started', params: { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'webSearch', id: 'search-1', query: '', action: null, results: null } } },
    { method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'webSearch', id: 'search-1', query: 'site:fsis.usda.gov safe minimum internal temperature beef steaks rest time', action: { type: 'search', query: 'site:fsis.usda.gov safe minimum internal temperature beef steaks rest time', queries: null }, results: [{ type: 'text_result', domain: 'ask.fsis.usda.gov', ref_id: 'turn0search0', snippet: 'Snippet only; not a page body.', title: 'USDA temperature guidance', url: 'https://ask.fsis.usda.gov/example' }] } } },
    { method: 'item/started', params: { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'webSearch', id: 'read-1', query: '', action: null, results: null } } },
    { method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'webSearch', id: 'read-1', query: '', action: { type: 'other' }, results: [{ type: 'text_result', ref_id: 'turn1view0', snippet: 'Total lines: 1', title: 'Internal Error' }] } } }
  ];
  child.stdin = { write: line => {
    const message = JSON.parse(line.trim());
    if (message.method === 'initialize') emit({ id: message.id, result: {} });
    else if (message.method === 'thread/start') emit({ id: message.id, result: { thread: { id: 'thread-1' } } });
    else if (message.method === 'turn/start') {
      emit({ id: message.id, result: { turn: { id: 'turn-1' } } });
      rawEvents.forEach(emit);
      emit({ method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'agentMessage', id: 'answer-1', text: '{"summary":"Search only","detail":"The original page body was unavailable.","suggestions":[],"visualReferences":[]}' } } });
      emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { status: 'completed' } } });
    } else if (message.method === 'thread/unsubscribe') emit({ id: message.id, result: { status: 'unsubscribed' } });
  } };
  const { CodexAppServerRuntime } = load('ai/runtime/codex-app-server.ts', { 'node:child_process': { spawn: () => child } });
  const { AiTaskService } = load('core/ai-task-service.ts');
  const runtime = new CodexAppServerRuntime({ executable: 'codex', cwd: '/plugin', env: {}, clientVersion: 'test' });
  const service = new AiTaskService({
    pluginDirectory: () => '/plugin', language: () => 'en', defaultReasoning: () => 'low',
    exchangeLoggingEnabled: () => false, exchanges: () => null,
    codexRuntime: () => runtime, claudeRuntime: () => { throw new Error('unexpected provider'); }
  });
  const received = [];
  let capturedSearchBudget;
  const originalRunTask = runtime.runTask.bind(runtime);
  runtime.runTask = async (prompt, model, effort, schema, controls = {}) => { capturedSearchBudget = controls.searchBudget; return originalRunTask(prompt, model, effort, schema, controls); };
  const result = await service.askModel({ title: 'Public source probe', summary: '', rules: '', detail: '', task: 'Search then read the original page.', ancestors: '', mode: 'task', researchMode: 'research', researchDepth: 'fast', visualMode: 'off' }, 'gpt-6-luna', 'low', undefined, undefined, undefined, event => received.push(event));
  assert.equal(result.summary, 'Search only');
  assert.equal(capturedSearchBudget, 0, 'normal VAM research must not impose a fixed search-count cap');
  assert.deepEqual(plain(received), rawEvents);
  assert.equal(received[1].params.item.results[0].snippet, 'Snippet only; not a page body.');
  assert.equal(received[3].params.item.results[0].title, 'Internal Error');
  runtime.stop();
});
integrationTest('research budget sends one stop-search steer after three searches', async () => {
  const { EventEmitter } = require('node:events'); const sent = [];
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
  const emit = message => process.nextTick(() => child.stdout.emit('data', Buffer.from(`${JSON.stringify(message)}\n`)));
  child.stdin = { write: line => {
    const message = JSON.parse(line.trim()); sent.push(message);
    if (message.method === 'initialize') emit({ id: message.id, result: {} });
    else if (message.method === 'thread/start') emit({ id: message.id, result: { thread: { id: 'thread-1' } } });
    else if (message.method === 'turn/start') {
      emit({ id: message.id, result: { turn: { id: 'turn-1' } } });
      for (let i = 0; i < 3; i++) {
        emit({ method: 'item/started', params: { threadId: 'thread-1', item: { id: `search-${i}`, type: 'webSearch', action: null } } });
        emit({ method: 'item/completed', params: { threadId: 'thread-1', item: { id: `search-${i}`, type: 'webSearch', action: { type: 'search' } } } });
      }
    } else if (message.method === 'turn/steer') {
      emit({ id: message.id, result: { turnId: 'turn-1' } });
      emit({ method: 'item/completed', params: { threadId: 'thread-1', item: { type: 'agentMessage', text: 'answer' } } });
      emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { status: 'completed' } } });
    } else if (message.method === 'thread/unsubscribe') emit({ id: message.id, result: {} });
  } };
  const { CodexAppServerRuntime } = load('ai/runtime/codex-app-server.ts', { 'node:child_process': { spawn: () => child } });
  const runtime = new CodexAppServerRuntime({ executable: 'codex', cwd: '/plugin', env: {}, clientVersion: 'test' });
  try {
    assert.equal(await runtime.runTask('research', 'model', 'low', {}, { searchBudget: 3 }), 'answer');
    assert.equal(sent.filter(message => message.method === 'turn/steer').length, 1);
    assert.equal(sent.filter(message => message.method === 'turn/interrupt').length, 0);
    assert.match(sent.find(message => message.method === 'turn/steer').params.input[0].text, /Stop searching/);
  } finally { runtime.stop(); }
});
integrationTest('a failing caller callback fails only its own Codex turn and keeps the shared process', async () => {
  const { EventEmitter } = require('node:events'); let spawned = 0, threads = 0; const sent = [];
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
  const emit = message => process.nextTick(() => child.stdout.emit('data', Buffer.from(`${JSON.stringify(message)}\n`)));
  child.stdin = { write: line => {
    const message = JSON.parse(line.trim()); sent.push(message);
    if (message.method === 'initialize') emit({ id: message.id, result: {} });
    else if (message.method === 'thread/start') emit({ id: message.id, result: { thread: { id: `thread-${++threads}` } } });
    else if (message.method === 'turn/start') {
      const threadId = message.params.threadId;
      emit({ id: message.id, result: { turn: { id: `turn-${threadId}` } } });
      setTimeout(() => {
        emit({ method: 'item/completed', params: { threadId, item: { type: 'agentMessage', text: `answer ${threadId}` } } });
        emit({ method: 'turn/completed', params: { threadId, turn: { status: 'completed' } } });
      }, 5);
    } else if (message.method === 'turn/interrupt' || message.method === 'thread/unsubscribe') emit({ id: message.id, result: {} });
  } };
  const { CodexAppServerRuntime } = load('ai/runtime/codex-app-server.ts', { 'node:child_process': { spawn: () => { spawned++; return child; } } });
  const runtime = new CodexAppServerRuntime({ executable: 'codex', cwd: '/plugin', env: {}, clientVersion: 'test' });
  try {
    const failing = runtime.runTask('a', 'model', 'low', undefined, { onText: () => { throw new Error('UI callback failed'); } });
    const healthy = runtime.runTask('b', 'model', 'low', undefined, {});
    await assert.rejects(failing, /UI callback failed/);
    assert.match(await healthy, /^answer thread-/);
    assert.equal(spawned, 1, 'the shared app-server process was not restarted');
    assert.ok(sent.some(message => message.method === 'turn/interrupt'), 'the abandoned turn is interrupted');
  } finally { runtime.stop(); }
});
integrationTest('opening a web page does not consume the search query budget', async () => {
  const { EventEmitter } = require('node:events'); const sent = [];
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
  const emit = message => process.nextTick(() => child.stdout.emit('data', Buffer.from(`${JSON.stringify(message)}\n`)));
  child.stdin = { write: line => {
    const message = JSON.parse(line.trim()); sent.push(message);
    if (message.method === 'initialize') emit({ id: message.id, result: {} });
    else if (message.method === 'thread/start') emit({ id: message.id, result: { thread: { id: 'thread-1' } } });
    else if (message.method === 'turn/start') {
      emit({ id: message.id, result: { turn: { id: 'turn-1' } } });
      emit({ method: 'item/started', params: { threadId: 'thread-1', item: { id: 'open-1', type: 'webSearch', action: null } } });
      emit({ method: 'item/completed', params: { threadId: 'thread-1', item: { id: 'open-1', type: 'webSearch', action: { type: 'openPage', url: 'https://example.org/source' } } } });
      emit({ method: 'item/completed', params: { threadId: 'thread-1', item: { type: 'agentMessage', text: 'answer' } } });
      emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { status: 'completed' } } });
    } else if (message.method === 'thread/unsubscribe') emit({ id: message.id, result: {} });
  } };
  const { CodexAppServerRuntime } = load('ai/runtime/codex-app-server.ts', { 'node:child_process': { spawn: () => child } });
  const runtime = new CodexAppServerRuntime({ executable: 'codex', cwd: '/plugin', env: {}, clientVersion: 'test' });
  try {
    assert.equal(await runtime.runTask('research', 'model', 'low', {}, { searchBudget: 1 }), 'answer');
    assert.equal(sent.filter(message => message.method === 'turn/steer').length, 0);
  } finally { runtime.stop(); }
});
integrationTest('a web-search-only turn accepts a directly opened page but rejects a turn with no web retrieval', async () => {
  const run = async items => {
    const { EventEmitter } = require('node:events');
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
    const emit = message => process.nextTick(() => child.stdout.emit('data', Buffer.from(`${JSON.stringify(message)}\n`)));
    child.stdin = { write: line => {
      const message = JSON.parse(line.trim());
      if (message.method === 'initialize') emit({ id: message.id, result: {} });
      else if (message.method === 'config/read') emit({ id: message.id, result: { config: {} } });
      else if (message.method === 'thread/start') emit({ id: message.id, result: { thread: { id: 'thread-1' } } });
      else if (message.method === 'turn/start') {
        emit({ id: message.id, result: { turn: { id: 'turn-1' } } });
        for (const item of items) emit({ method: 'item/completed', params: { threadId: 'thread-1', item } });
        emit({ method: 'item/completed', params: { threadId: 'thread-1', item: { type: 'agentMessage', text: 'answer' } } });
        emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { status: 'completed' } } });
      } else if (message.method === 'thread/unsubscribe') emit({ id: message.id, result: {} });
    } };
    const { CodexAppServerRuntime } = load('ai/runtime/codex-app-server.ts', { 'node:child_process': { spawn: () => child } });
    const runtime = new CodexAppServerRuntime({ executable: 'codex', cwd: '/plugin', env: {}, clientVersion: 'test' });
    try { return await runtime.runTask('research', 'model', 'low', {}, { webSearchOnly: true }); } finally { runtime.stop(); }
  };
  assert.equal(await run([{ id: 'open-1', type: 'webSearch', action: { type: 'openPage', url: 'https://obsidian.md/changelog/' } }]), 'answer');
  await assert.rejects(run([]), /did not perform web search|沒有實際執行網路搜尋/);
});
integrationTest('an image generation turn enables only the image tool and resolves to the generated image as a data URL', async () => {
  const run = async items => {
    const { EventEmitter } = require('node:events'); const sent = [];
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
    const emit = message => process.nextTick(() => child.stdout.emit('data', Buffer.from(`${JSON.stringify(message)}\n`)));
    child.stdin = { write: line => {
      const message = JSON.parse(line.trim()); sent.push(message);
      if (message.method === 'initialize') emit({ id: message.id, result: {} });
      else if (message.method === 'config/read') emit({ id: message.id, result: { config: {} } });
      else if (message.method === 'thread/start') emit({ id: message.id, result: { thread: { id: 'thread-1' } } });
      else if (message.method === 'turn/start') {
        emit({ id: message.id, result: { turn: { id: 'turn-1' } } });
        for (const item of items) emit({ method: 'item/completed', params: { threadId: 'thread-1', item } });
        emit({ method: 'item/completed', params: { threadId: 'thread-1', item: { type: 'agentMessage', text: 'Done.' } } });
        emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { status: 'completed' } } });
      } else if (message.method === 'thread/unsubscribe') emit({ id: message.id, result: {} });
    } };
    const { CodexAppServerRuntime } = load('ai/runtime/codex-app-server.ts', { 'node:child_process': { spawn: () => child } });
    const runtime = new CodexAppServerRuntime({ executable: 'codex', cwd: '/plugin', env: {}, clientVersion: 'test' });
    try { return { result: await runtime.runTask('translate the image', 'model', 'low', undefined, { generateImage: true, imageDataUrl: 'data:image/png;base64,iVBORw0KGgo=' }), sent }; } finally { runtime.stop(); }
  };
  const base64 = 'A'.repeat(80);
  const { result, sent } = await run([{ id: 'img-1', type: 'imageGeneration', status: 'completed', result: base64, savedPath: null }]);
  assert.equal(result, `data:image/png;base64,${base64}`);
  const config = sent.find(message => message.method === 'thread/start').params.config;
  assert.equal(config['features.image_generation'], true); assert.equal(config['features.shell_tool'], false); assert.equal(config.web_search, 'disabled');
  const turn = sent.find(message => message.method === 'turn/start').params;
  assert.deepEqual(turn.input.map(item => item.type), ['text', 'image']);
  await assert.rejects(run([]), /did not return an image|沒有回傳圖片/);
  await assert.rejects(run([{ id: 'img-2', type: 'imageGeneration', status: 'failed', result: '', failure: { message: 'content policy' } }]), /content policy/);
});
integrationTest('cancelling a Codex turn sends interrupt and rejects the result', async () => {
  const { EventEmitter } = require('node:events'); const sent = [], timerDelays = [];
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
  const emit = message => process.nextTick(() => child.stdout.emit('data', Buffer.from(`${JSON.stringify(message)}\n`)));
  child.stdin = { write: line => {
    const message = JSON.parse(line.trim()); sent.push(message);
    if (message.method === 'initialize') emit({ id: message.id, result: {} });
    else if (message.method === 'thread/start') emit({ id: message.id, result: { thread: { id: 'thread-1' } } });
    else if (message.method === 'turn/start') emit({ id: message.id, result: { turn: { id: 'turn-1' } } });
    else if (message.method === 'turn/interrupt') { emit({ id: message.id, result: {} }); emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { status: 'interrupted' } } }); }
    else if (message.method === 'thread/unsubscribe') emit({ id: message.id, result: {} });
  } };
  const { CodexAppServerRuntime } = load('ai/runtime/codex-app-server.ts', { 'node:child_process': { spawn: () => child } }, { setTimeout: (callback, delay) => { timerDelays.push(delay); return setTimeout(callback, delay); } });
  const runtime = new CodexAppServerRuntime({ executable: 'codex', cwd: '/plugin', env: {}, clientVersion: 'test' });
  const controller = new AbortController();
  try {
    const pending = runtime.runTask('research', 'model', 'low', {}, { signal: controller.signal });
    while (!sent.some(message => message.method === 'turn/start')) await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve)); controller.abort();
    assert.equal(timerDelays.at(-1), 30_000);
    await assert.rejects(pending, error => error.name === 'AbortError');
    assert.equal(sent.filter(message => message.method === 'turn/interrupt').length, 1);
  } finally { runtime.stop(); }
});
for (const delayedStart of [false, true]) test(`timed-out Codex turn attempts one interrupt${delayedStart ? ' after a late turn/start reply' : ''}`, async () => {
  const { EventEmitter } = require('node:events'); const sent = [], logs = []; let turnTimeout, startRequest;
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
  const emit = message => process.nextTick(() => child.stdout.emit('data', Buffer.from(`${JSON.stringify(message)}\n`)));
  child.stdin = { write: line => {
    const message = JSON.parse(line.trim()); sent.push(message);
    if (message.method === 'initialize') emit({ id: message.id, result: {} });
    else if (message.method === 'thread/start') emit({ id: message.id, result: { thread: { id: 'thread-1' } } });
    else if (message.method === 'turn/start') { startRequest = message.id; if (!delayedStart) emit({ id: message.id, result: { turn: { id: 'turn-1' } } }); }
    else if (message.method === 'turn/interrupt') emit({ id: message.id, error: { message: 'interrupt unavailable' } });
    else if (message.method === 'thread/unsubscribe') emit({ id: message.id, result: {} });
  } };
  const windowValues = {
    setTimeout: (callback, delay) => delay === 180_000 ? (turnTimeout = callback, 1) : setTimeout(callback, delay),
    clearTimeout: timer => { if (timer !== 1) clearTimeout(timer); }
  };
  const { CodexAppServerRuntime } = load('ai/runtime/codex-app-server.ts', { 'node:child_process': { spawn: () => child } }, windowValues);
  const runtime = new CodexAppServerRuntime({ executable: 'codex', cwd: '/plugin', env: {}, clientVersion: 'test', onLog: (level, message) => logs.push([level, message]) });
  try {
    const pending = runtime.runTask('research', 'model', 'low', {});
    while (!startRequest || !turnTimeout) await new Promise(resolve => setImmediate(resolve));
    if (!delayedStart) await new Promise(resolve => setImmediate(resolve));
    turnTimeout();
    if (delayedStart) emit({ id: startRequest, result: { turn: { id: 'turn-1' } } });
    await assert.rejects(pending, /AI task exceeded 3 minutes.*interrupt it to avoid prolonged resource use.*Incomplete results are not applied/);
    assert.equal(sent.filter(message => message.method === 'turn/interrupt').length, 1);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(logs.filter(([level, message]) => level === 'warn' && message.includes('Could not stop the AI task after it timed out')).length, 1);
  } finally { runtime.stop(); }
});
integrationTest('Codex App Server declines unsupported interaction requests instead of hanging', async () => {
  const { EventEmitter } = require('node:events'); const sent = [];
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
  child.stdin = { write: line => {
    const message = JSON.parse(line.trim()); sent.push(message);
    if (message.method === 'initialize') process.nextTick(() => child.stdout.emit('data', Buffer.from(`${JSON.stringify({ id: message.id, result: {} })}\n`)));
  } };
  const { CodexAppServerRuntime } = load('ai/runtime/codex-app-server.ts', { 'node:child_process': { spawn: () => child } });
  const runtime = new CodexAppServerRuntime({ executable: 'codex', cwd: '/plugin', env: {}, clientVersion: 'test' });
  await runtime.start();
  const requests = [
    { id: 'command', method: 'item/commandExecution/requestApproval', expected: { decision: 'decline' } },
    { id: 'file', method: 'item/fileChange/requestApproval', expected: { decision: 'decline' } },
    { id: 'permission', method: 'item/permissions/requestApproval', expected: { permissions: {} } },
    { id: 'input', method: 'item/tool/requestUserInput', expected: { answers: {} } },
    { id: 'mcp', method: 'mcpServer/elicitation/request', expected: { action: 'decline', content: null } }
  ];
  for (const request of requests) child.stdout.emit('data', Buffer.from(`${JSON.stringify({ id: request.id, method: request.method, params: {} })}\n`));
  child.stdout.emit('data', Buffer.from(`${JSON.stringify({ id: 'unknown', method: 'unknown/request', params: {} })}\n`));
  await new Promise(resolve => setImmediate(resolve));
  for (const request of requests) assert.deepEqual(plain(sent.find(message => message.id === request.id)?.result), request.expected);
  assert.equal(sent.find(message => message.id === 'unknown')?.error?.code, -32601);
  runtime.stop();
});
integrationTest('Codex App Server ignores stale child events after a clean restart', async () => {
  const { EventEmitter } = require('node:events'); const children = [];
  const spawn = () => {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
    child.stdin = { write: line => {
      const message = JSON.parse(line.trim());
      if (message.method === 'initialize') process.nextTick(() => child.stdout.emit('data', Buffer.from(`${JSON.stringify({ id: message.id, result: {} })}\n`)));
      else if (message.method === 'model/list') process.nextTick(() => child.stdout.emit('data', Buffer.from(`${JSON.stringify({ id: message.id, result: { data: [], nextCursor: null } })}\n`)));
    } };
    children.push(child); return child;
  };
  const { CodexAppServerRuntime } = load('ai/runtime/codex-app-server.ts', { 'node:child_process': { spawn } });
  const runtime = new CodexAppServerRuntime({ executable: 'codex', cwd: '/plugin', env: {}, clientVersion: 'test' });
  await runtime.start();
  const first = children[0]; first.stdout.emit('data', Buffer.from('{')); first.emit('error', new Error('first failed'));
  await runtime.start();
  first.emit('close', 1);
  await runtime.listModels();
  assert.equal(children.length, 2);
  runtime.stop();
});
integrationTest('Codex launch preserves executable as one argument and refuses privileged server requests', async () => {
  const { EventEmitter } = require('node:events'); const sent = []; let launch;
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
  child.stdin = { write: line => { const message = JSON.parse(line.trim()); sent.push(message); if (message.method === 'initialize') process.nextTick(() => child.stdout.emit('data', Buffer.from(`${JSON.stringify({ id: message.id, result: {} })}\n`))); } };
  const { CodexAppServerRuntime } = load('ai/runtime/codex-app-server.ts', { 'node:child_process': { spawn: (...args) => { launch = args; return child; } } });
  const executable = '/trusted path/codex;unexpected'; const env = { PATH: '/trusted/bin' };
  const runtime = new CodexAppServerRuntime({ executable, cwd: '/vault/custom-config/plugins/visual-agent-map', env, clientVersion: 'test' });
  try {
    await runtime.start(); assert.equal(launch[0], executable); assert.deepEqual(plain(launch[1]), ['app-server']);
    assert.equal(launch[2].cwd, '/vault/custom-config/plugins/visual-agent-map'); assert.equal(launch[2].env, env); assert.ok(!launch[2].shell);
    for (const [index, method] of ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'unknown/privilege'].entries()) {
      child.stdout.emit('data', Buffer.from(`${JSON.stringify({ id: 'server-' + index, method, params: {} })}\n`));
    }
    assert.deepEqual(sent.find(message => message.id === 'server-0').result, { decision: 'decline' });
    assert.deepEqual(sent.find(message => message.id === 'server-1').result, { decision: 'decline' });
    assert.deepEqual(sent.find(message => message.id === 'server-2').result, { permissions: {} });
    assert.equal(sent.find(message => message.id === 'server-3').error.code, -32601);
  } finally { runtime.stop(); }
});
integrationTest('S4: Codex events map to waiting/searching/reading/writing for the observer, without a query or preview', async () => {
  const { EventEmitter } = require('node:events');
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
  const emit = message => process.nextTick(() => child.stdout.emit('data', Buffer.from(`${JSON.stringify(message)}\n`)));
  const search = (method, id) => ({ method, params: { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'webSearch', id, query: 'synthetic query', action: method === 'item/started' ? null : { type: 'search' } } } });
  child.stdin = { write: line => {
    const message = JSON.parse(line.trim());
    if (message.method === 'initialize') emit({ id: message.id, result: {} });
    else if (message.method === 'thread/start') emit({ id: message.id, result: { thread: { id: 'thread-1' } } });
    else if (message.method === 'turn/start') {
      emit({ id: message.id, result: { turn: { id: 'turn-1' } } });
      emit({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-1' } } });
      emit(search('item/started', 's1')); emit(search('item/completed', 's1'));
      emit({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', itemId: 'a1', delta: '{"summary"' } });
      emit({ method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'agentMessage', id: 'a1', text: '{"summary":"S","detail":"D","suggestions":[],"visualReferences":[]}' } } });
      emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { status: 'completed' } } });
    } else if (message.method === 'thread/unsubscribe') emit({ id: message.id, result: { status: 'unsubscribed' } });
  } };
  const { CodexAppServerRuntime } = load('ai/runtime/codex-app-server.ts', { 'node:child_process': { spawn: () => child } });
  const { AiTaskService } = load('core/ai-task-service.ts');
  const runtime = new CodexAppServerRuntime({ executable: 'codex', cwd: '/plugin', env: {}, clientVersion: 'test' });
  const service = new AiTaskService({ pluginDirectory: () => '/plugin', language: () => 'en', defaultReasoning: () => 'low', exchangeLoggingEnabled: () => false, exchanges: () => null, codexRuntime: () => runtime, claudeRuntime: () => { throw new Error('unexpected provider'); } });
  const events = [];
  const observer = { onAttempt: () => events.push('attempt'), onStage: (_id, stage, query) => events.push([stage, query]), onPreview: () => events.push('preview'), onSlow: () => events.push('slow') };
  const result = await service.askModel({ title: 'T', summary: '', rules: '', detail: '', task: 'Research', ancestors: '', mode: 'task', researchMode: 'research', researchDepth: 'fast', visualMode: 'off' }, 'gpt-6-luna', 'low', undefined, undefined, undefined, undefined, observer);
  assert.equal(result.summary, 'S');
  assert.deepEqual(plain(events), ['attempt', ['searching', null], ['reading', null], ['writing', null]]);
  runtime.stop();
});

integrationTest('L2: turn/started is not the first model event; the first item or delta is', async () => {
  const { EventEmitter } = require('node:events');
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
  const emit = message => child.stdout.emit('data', Buffer.from(`${JSON.stringify(message)}\n`));
  const reply = message => process.nextTick(() => emit(message));
  child.stdin = { write: line => {
    const message = JSON.parse(line.trim());
    if (message.method === 'initialize') reply({ id: message.id, result: {} });
    else if (message.method === 'thread/start') reply({ id: message.id, result: { thread: { id: 'thread-1' } } });
    else if (message.method === 'turn/start') { reply({ id: message.id, result: { turn: { id: 'turn-1' } } }); reply({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-1' } } }); }
    else if (message.method === 'thread/unsubscribe') reply({ id: message.id, result: { status: 'unsubscribed' } });
  } };
  const { CodexAppServerRuntime } = load('ai/runtime/codex-app-server.ts', { 'node:child_process': { spawn: () => child } });
  const runtime = new CodexAppServerRuntime({ executable: 'codex', cwd: '/plugin', env: {}, clientVersion: 'test' });
  const activity = [];
  const run = runtime.runTask('p', 'gpt-6-luna', 'low', { type: 'object' }, { onActivity: item => activity.push(item) });
  for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(activity, [], 'turn/started alone reports nothing, so the slow notice can still appear');
  emit({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', itemId: 'a1', delta: '{' } });
  assert.deepEqual(activity, ['started', 'writing'], 'the first delta is the first model event');
  emit({ method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'agentMessage', id: 'a1', text: '{"summary":"S","detail":"D","suggestions":[],"visualReferences":[]}' } } });
  emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { status: 'completed' } } });
  assert.match(await run, /"summary":"S"/);
  runtime.stop();
});

// B2-feat (W1): a standard research of normal or deep depth reaches Codex as a web-search-only turn. Args and config only; no live run.
integrationTest('B2 W1 Codex: a web-search-only turn starts its thread with web_search live; a plain turn adds no web override; the local runtime starts with web search disabled', async () => {
  const run = async controls => {
    const { EventEmitter } = require('node:events'); const sent = [];
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
    const emit = message => process.nextTick(() => child.stdout.emit('data', Buffer.from(`${JSON.stringify(message)}\n`)));
    child.stdin = { write: line => {
      const message = JSON.parse(line.trim()); sent.push(message);
      if (message.method === 'initialize') emit({ id: message.id, result: {} });
      else if (message.method === 'config/read') emit({ id: message.id, result: { config: { mcp_servers: { 'user.mcp': { command: 'x' } } } } });
      else if (message.method === 'thread/start') emit({ id: message.id, result: { thread: { id: 'thread-1' } } });
      else if (message.method === 'turn/start') {
        emit({ id: message.id, result: { turn: { id: 'turn-1' } } });
        emit({ method: 'item/completed', params: { threadId: 'thread-1', item: { id: 'w1', type: 'webSearch', action: { type: 'search' } } } });
        emit({ method: 'item/completed', params: { threadId: 'thread-1', item: { type: 'agentMessage', text: 'answer' } } });
        emit({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { status: 'completed' } } });
      } else if (message.method === 'thread/unsubscribe') emit({ id: message.id, result: {} });
    } };
    let spawnArgs;
    const { CodexAppServerRuntime } = load('ai/runtime/codex-app-server.ts', { 'node:child_process': { spawn: (_exe, args) => { spawnArgs = args; return child; } } });
    const runtime = new CodexAppServerRuntime({ executable: 'codex', cwd: '/plugin', env: {}, clientVersion: 'test', webSearchDisabled: controls.local === true });
    try { await runtime.runTask('research', 'model', 'low', {}, controls.local ? {} : controls); } finally { runtime.stop(); }
    return { thread: sent.find(m => m.method === 'thread/start').params, spawnArgs, configReads: sent.filter(m => m.method === 'config/read').length };
  };
  const web = await run({ webSearchOnly: true });
  assert.equal(web.thread.config.web_search, 'live'); assert.match(web.thread.baseInstructions, /web search only/);
  // Standard research and AIM share this isolated thread: features off, user MCP servers disabled, web-only instructions, config read once.
  assert.equal(web.thread.config['features.shell_tool'], false, 'features are off'); assert.equal(web.thread.config['features.apps'], false);
  assert.deepEqual(JSON.parse(JSON.stringify(web.thread.config.mcp_servers)), { 'user.mcp': { enabled: false } }, 'user MCP servers are disabled');
  assert.equal(web.configReads, 1, 'the effective config is read to disable MCP servers');
  assert.equal(typeof web.thread.baseInstructions, 'string');
  const plainTurn = await run({});
  assert.equal(plainTurn.thread.config, undefined, 'an ordinary turn sends no config override');
  const local = await run({ local: true });
  assert.deepEqual(JSON.parse(JSON.stringify(local.spawnArgs)), ['--config', 'web_search="disabled"', 'app-server'], 'local mode: web search disabled at launch');
  assert.equal(local.thread.config, undefined);
});
