const assert = require('node:assert/strict');
const { test, integrationTest, load, until } = require('../support.cjs');
test('Claude isolated research reports web activity in the Codex event shape and requires a real retrieval', async () => {
  const { EventEmitter } = require('node:events');
  const output = { summary: 'S', detail: 'D', suggestions: [], visualReferences: [], searchStatus: 'completed' };
  const runWith = async (records, controls = {}) => {
    const spawn = () => {
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => true;
      child.stdin = { on: () => {}, end: () => process.nextTick(() => {
        const text = JSON.stringify([...records, { type: 'result', subtype: 'success', is_error: false, structured_output: output }]);
        for (let index = 0; index < text.length; index += 1_000_000) child.stdout.emit('data', Buffer.from(text.slice(index, index + 1_000_000)));
        child.emit('close', 0);
      }) };
      return child;
    };
    const { ClaudeCodeCliRuntime } = load('ai/runtime/claude-code-cli.ts', { 'node:child_process': { spawn } });
    return new ClaudeCodeCliRuntime({ executable: 'claude', cwd: '/plugin', env: {}, spawn }).runTask('research', 'sonnet', 'low', { type: 'object' }, { webSearch: true, webSearchOnly: true, ...controls });
  };
  const use = (id, name) => ({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id, name, input: {} }] } });
  const done = (id, extra = {}) => ({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok', ...extra }] } });
  const events = [];
  // A fetched page larger than the former 4 MB stdout tail must not break parsing.
  assert.equal(JSON.parse(await runWith([use('s1', 'WebSearch'), done('s1'), use('f1', 'WebFetch'), done('f1', { content: 'x'.repeat(5_000_000) })], { onWebSearchEvent: event => { events.push(JSON.parse(JSON.stringify(event))); } })).summary, 'S');
  assert.deepEqual(events.map(event => [event.method, event.params.item.action?.type ?? null]), [['item/started', null], ['item/completed', 'search'], ['item/started', null], ['item/completed', 'openPage']]);
  await assert.rejects(runWith([]), /did not perform web search|沒有實際執行網路搜尋/);
  await assert.rejects(runWith([use('s1', 'WebSearch'), done('s1', { is_error: true })]), /did not perform web search|沒有實際執行網路搜尋/, 'a denied or failed tool call is not a retrieval');
  const subagent = { ...use('s2', 'WebSearch'), parent_tool_use_id: 'task-1' };
  await assert.rejects(runWith([subagent, { ...done('s2'), parent_tool_use_id: 'task-1' }]), /did not perform web search|沒有實際執行網路搜尋/, 'only the main agent counts');
  assert.equal(JSON.parse(await runWith([use('s3', 'WebSearch'), done('s3')], { onWebSearchEvent: () => { throw new Error('UI failure'); } })).summary, 'S', 'a telemetry consumer error does not fail the task');
  assert.equal(JSON.parse(await runWith([], { webSearchOnly: false })).summary, 'S', 'ordinary tasks do not require search');
});
test('Claude stream mode skips plain-text warning lines between JSON records', async () => {
  const { EventEmitter } = require('node:events');
  const spawn = () => {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => true;
    child.stdin = { end: () => process.nextTick(() => {
      child.stdout.emit('data', Buffer.from('Warning: update available\n' + JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } }) + '\n' + JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'hello' }) + '\n'));
      child.emit('close', 0);
    }) };
    return child;
  };
  const { ClaudeCodeCliRuntime } = load('ai/runtime/claude-code-cli.ts', { 'node:child_process': { spawn } });
  assert.equal(await new ClaudeCodeCliRuntime({ executable: 'claude', cwd: '/plugin', env: {}, spawn }).runTask('hi', 'sonnet', 'low', undefined, { onText: () => {} }), 'hello');
});
test('AiTaskService gives Claude the same web telemetry and search requirement as Codex for isolated research', async () => {
  const { AiTaskService } = load('core/ai-task-service.ts');
  let received;
  const service = new AiTaskService({
    pluginDirectory: () => '/plugin', language: () => 'en', defaultReasoning: () => 'low', exchangeLoggingEnabled: () => false, exchanges: () => null,
    codexRuntime: () => { throw new Error('unexpected provider'); },
    claudeRuntime: () => ({ runTask: async (_prompt, _model, _effort, _schema, controls) => { received = controls; controls.onWebSearchEvent({ method: 'item/completed', params: { item: { type: 'webSearch', action: { type: 'search' } } } }); return JSON.stringify({ summary: 's', detail: 'd', suggestions: [], visualReferences: [], searchStatus: 'completed' }); } })
  });
  const events = [];
  await service.askModel({ title: 'T', summary: '', rules: '', detail: '', task: 'Research', ancestors: '', mode: 'task', researchMode: 'research', researchDepth: 'normal', visualMode: 'off', promptProfile: 'aim', aimIsolatedResearch: true }, 'claude:sonnet', 'low', undefined, undefined, undefined, event => events.push(event));
  assert.equal(received.webSearchOnly, true);
  assert.equal(events.length, 1);
});
test('Claude CLI uses the local structured-output interface with tools restricted by task mode', async () => {
  const { EventEmitter } = require('node:events'); let args, prompt, cwd;
  const result = { type: 'result', subtype: 'success', is_error: false, structured_output: { summary: 'Summary', detail: 'Evidence', suggestions: [], visualReferences: [] } };
  const spawn = (_executable, received, options) => {
    args = received; cwd = options.cwd;
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => true;
    child.stdin = { end: text => { prompt = text; process.nextTick(() => { child.stdout.emit('data', Buffer.from(JSON.stringify(result))); child.emit('close', 0); }); } };
    return child;
  };
  const { ClaudeCodeCliRuntime, claudeTaskArgs, claudeStructuredOutput } = load('ai/runtime/claude-code-cli.ts', { 'node:child_process': { spawn } });
  const schema = { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false };
  const localArgs = claudeTaskArgs('sonnet', 'medium', schema, false);
  const claudeSchema = JSON.parse(localArgs[localArgs.indexOf('--json-schema') + 1]);
  assert.equal(claudeSchema.$schema, undefined);
  assert.deepEqual(claudeSchema.required, ['summary']);
  assert.equal(claudeSchema.additionalProperties, false);
  assert.equal(localArgs[localArgs.indexOf('--tools') + 1], '');
  assert.ok(!localArgs.includes('--allowedTools'));
  assert.ok(localArgs.includes('--safe-mode'));
  assert.ok(localArgs.includes('--strict-mcp-config'));
  assert.deepEqual(JSON.parse(localArgs[localArgs.indexOf('--mcp-config') + 1]), { mcpServers: {} });
  assert.ok(localArgs.includes('--no-session-persistence'));
  const webArgs = claudeTaskArgs('opus', 'high', schema, true);
  assert.equal(webArgs[webArgs.indexOf('--tools') + 1], 'WebSearch,WebFetch');
  assert.equal(webArgs[webArgs.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.equal(webArgs[webArgs.indexOf('--allowedTools') + 1], 'WebSearch,WebFetch');
  assert.doesNotMatch(webArgs.join(' '), /\b(Bash|Read|Write|Edit|Agent)\b/);
  const runtime = new ClaudeCodeCliRuntime({ executable: '/usr/local/bin/claude', cwd: '/plugin', env: {}, spawn });
  const raw = await runtime.runTask('VAM prompt', 'sonnet', 'medium', schema, { searchBudget: 0 });
  assert.equal(cwd, '/plugin'); assert.equal(prompt, 'VAM prompt');
  assert.equal(args[args.indexOf('--model') + 1], 'sonnet');
  assert.deepEqual(JSON.parse(raw), result.structured_output);
  assert.deepEqual(JSON.parse(claudeStructuredOutput(JSON.stringify([{ type: 'system', subtype: 'init' }, result]))), result.structured_output);
  assert.deepEqual(JSON.parse(claudeStructuredOutput(JSON.stringify(result))), result.structured_output);
  assert.throws(() => claudeStructuredOutput('not-json'));
  assert.throws(() => claudeStructuredOutput(JSON.stringify({ ...result, structured_output: undefined })), /structured result/);
  assert.throws(() => claudeStructuredOutput(JSON.stringify({ ...result, subtype: 'error_max_turns', is_error: true, errors: ['turn limit'] })), /turn limit/);
  const textResult = { type: 'result', subtype: 'success', is_error: false, result: '# Complete Markdown table' };
  assert.equal(claudeStructuredOutput(JSON.stringify(textResult), true), '# Complete Markdown table');
  assert.ok(!claudeTaskArgs('sonnet', 'high', undefined, false).includes('--json-schema'));
});
integrationTest('Claude stream-json keeps one request open for live guest interventions', async () => {
  const { EventEmitter } = require('node:events'); let args, handler, child; const input = [], chunks = [];
  const result = { type: 'result', subtype: 'success', is_error: false, result: 'Hello there' };
  const spawn = (_executable, received) => {
    args = received; child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => true;
    child.stdin = { write: line => { const message = JSON.parse(line); input.push(message); if (input.length === 1) process.nextTick(() => child.stdout.emit('data', Buffer.from(`${JSON.stringify({ type: 'stream_event', event: { delta: { type: 'text_delta', text: 'Hello' } } })}\n`))); else process.nextTick(() => { child.stdout.emit('data', Buffer.from(`${JSON.stringify({ type: 'stream_event', event: { delta: { type: 'text_delta', text: ' there' } } })}\n${JSON.stringify(result)}\n`)); }); return true; }, end: () => process.nextTick(() => child.emit('close', 0)) };
    return child;
  };
  const { ClaudeCodeCliRuntime } = load('ai/runtime/claude-code-cli.ts', { 'node:child_process': { spawn } });
  const runtime = new ClaudeCodeCliRuntime({ executable: 'claude', cwd: '/plugin', env: {}, spawn });
  const task = runtime.runTask('initial prompt', 'sonnet', 'low', undefined, { onText: text => chunks.push(text), onSteer: steer => { handler = steer; } });
  await until(() => !!handler); await handler('Ask Lin to explain the cost'); assert.equal(await task, 'Hello there');
  assert.ok(args.includes('--input-format') && args[args.indexOf('--input-format') + 1] === 'stream-json');
  assert.deepEqual(input.map(item => item.message.content[0].text), ['initial prompt', 'Ask Lin to explain the cost']);
  assert.deepEqual(chunks, ['Hello', 'Hello there']);
});
integrationTest('Claude receives an attached image as a base64 block in one stream-json message and returns the final result', async () => {
  const { EventEmitter } = require('node:events'); let args, ended = false; const input = [];
  const result = { type: 'result', subtype: 'success', is_error: false, result: 'Translated text' };
  const spawn = (_executable, received) => {
    args = received; const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => true;
    child.stdin = { on: () => {}, write: (line, done) => { input.push(JSON.parse(line)); done?.(); process.nextTick(() => child.stdout.emit('data', Buffer.from(`not json warning\n${JSON.stringify(result)}\n`))); return true; }, end: () => { ended = true; process.nextTick(() => child.emit('close', 0)); } };
    return child;
  };
  const { ClaudeCodeCliRuntime, claudeImageSource } = load('ai/runtime/claude-code-cli.ts', { 'node:child_process': { spawn } });
  const runtime = new ClaudeCodeCliRuntime({ executable: 'claude', cwd: '/plugin', env: {}, spawn });
  let accepted = 0;
  const reply = await runtime.runTask('Translate the text in the image', 'sonnet', 'low', undefined, { imageDataUrl: 'data:image/png;base64,iVBORw0KGgo=', onAccepted: () => accepted++ });
  assert.equal(reply, 'Translated text'); assert.equal(accepted, 1); assert.equal(ended, true);
  assert.equal(args[args.indexOf('--output-format') + 1], 'stream-json'); assert.equal(args[args.indexOf('--input-format') + 1], 'stream-json');
  assert.equal(input.length, 1);
  assert.deepEqual(input[0].message.content, [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }, { type: 'text', text: 'Translate the text in the image' }]);
  assert.throws(() => claudeImageSource('data:image/svg+xml;base64,PHN2Zz4='), /PNG|圖片|image/i);
  assert.throws(() => claudeImageSource('https://example.org/a.png'));
});
test('Claude cancellation rejects immediately and terminates only its own process', async () => {
  const { EventEmitter } = require('node:events'); const kills = [];
  const spawn = () => {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.kill = signal => { kills.push(signal); if (signal === 'SIGTERM') process.nextTick(() => child.emit('close', null, signal)); return true; };
    child.stdin = { end: () => {} }; return child;
  };
  const { ClaudeCodeCliRuntime } = load('ai/runtime/claude-code-cli.ts', { 'node:child_process': { spawn } });
  const runtime = new ClaudeCodeCliRuntime({ executable: 'claude', cwd: '/plugin', env: {}, spawn });
  const controller = new AbortController();
  const task = runtime.runTask('prompt', 'sonnet', 'low', {}, { signal: controller.signal });
  controller.abort();
  await assert.rejects(task, error => error.name === 'AbortError');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(kills, ['SIGTERM']);
});
test('Claude timeout stops its process and never accepts a late structured result', async () => {
  const { EventEmitter } = require('node:events'); let child; const kills = [];
  const spawn = () => {
    child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.kill = signal => { kills.push(signal); if (signal === 'SIGTERM') process.nextTick(() => child.emit('close', null, signal)); return true; };
    child.stdin = { end: () => {} }; return child;
  };
  const { ClaudeCodeCliRuntime } = load('ai/runtime/claude-code-cli.ts', { 'node:child_process': { spawn } });
  const runtime = new ClaudeCodeCliRuntime({ executable: 'claude', cwd: '/plugin', env: {}, spawn, timeoutMs: 15 });
  const task = runtime.runTask('prompt', 'sonnet', 'low', {});
  await assert.rejects(task, /exceeded 3 minutes/);
  child.stdout.emit('data', Buffer.from(JSON.stringify({ structured_output: { detail: 'late write' } })));
  child.emit('close', 0);
  assert.deepEqual(kills, ['SIGTERM']);
});
test('Claude launch failure before stdin flush never reports accepted', async () => {
  const { EventEmitter } = require('node:events'); let child, flush; let accepted = 0;
  const spawn = () => {
    child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => true;
    child.stdin = { end: (_prompt, callback) => { flush = callback; } }; return child;
  };
  const { ClaudeCodeCliRuntime } = load('ai/runtime/claude-code-cli.ts', { 'node:child_process': { spawn } });
  const runtime = new ClaudeCodeCliRuntime({ executable: 'claude', cwd: '/plugin', env: {}, spawn });
  const task = runtime.runTask('prompt', 'sonnet', 'low', {}, { onAccepted: () => accepted++ });
  child.emit('error', new Error('ENOENT'));
  flush(null);
  await assert.rejects(task);
  assert.equal(accepted, 0);
});
integrationTest('Claude nonzero exit exposes structured provider rejection without stderr', async () => {
  const {EventEmitter}=require('node:events');const spawn=()=>{const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.kill=()=>true;child.stdin={end:()=>process.nextTick(()=>{child.stdout.emit('data',Buffer.from(JSON.stringify({type:'result',is_error:true,result:'Subscription access disabled'})));child.emit('close',1);})};return child;};
  const {ClaudeCodeCliRuntime}=load('ai/runtime/claude-code-cli.ts');const runtime=new ClaudeCodeCliRuntime({executable:'claude',cwd:'/test',env:{},spawn});
  await assert.rejects(runtime.runTask('Synthetic source','sonnet','low',{},{}),/Subscription access disabled/);
});
test('Claude json mode reports usage, text before the StructuredOutput call and an enforce retry from the verbose transcript', async () => {
  const { EventEmitter } = require('node:events');
  const output = { summary: 'S', detail: 'D', suggestions: [], visualReferences: [] };
  const run = async records => {
    const spawn = () => {
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => true;
      child.stdin = { on: () => {}, end: () => process.nextTick(() => {
        child.stdout.emit('data', Buffer.from(JSON.stringify([...records, { type: 'result', subtype: 'success', is_error: false, structured_output: output, usage: { input_tokens: 120, output_tokens: 45 } }])));
        child.emit('close', 0);
      }) };
      return child;
    };
    const { ClaudeCodeCliRuntime } = load('ai/runtime/claude-code-cli.ts', { 'node:child_process': { spawn } });
    const seen = [];
    await new ClaudeCodeCliRuntime({ executable: 'claude', cwd: '/plugin', env: {}, spawn }).runTask('p', 'sonnet', 'low', { type: 'object' }, { onMilestones: data => seen.push(JSON.parse(JSON.stringify(data))) });
    return seen;
  };
  const text = value => ({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: value }] } });
  const tool = { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 't1', name: 'StructuredOutput', input: output }] } };
  const clean = await run([tool]);
  assert.deepEqual(clean, [{ usage: { inputTokens: 120, outputTokens: 45 }, textBeforeTool: false, enforceRetry: false }]);
  const drafted = await run([text('{"summary":"S"}'), tool]);
  assert.equal(drafted[0].textBeforeTool, true); assert.equal(drafted[0].enforceRetry, false);
  const narration = await run([text('Let me search for that.'), tool]);
  assert.equal(narration[0].textBeforeTool, false, 'short search narration is not the answer');
  const summaryText = await run([text('Here is the result: "summary": "S"'), tool]);
  assert.equal(summaryText[0].textBeforeTool, true, 'text containing a summary field is the answer');
  const afterTool = await run([tool, text('Done.')]);
  assert.equal(afterTool[0].textBeforeTool, false, 'text after the tool call is not a draft');
  const enforced = await run([text(' '), tool, { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'text', text: '<system-reminder>structured-output-enforce: call the tool</system-reminder>' }] } }, tool]);
  assert.equal(enforced[0].enforceRetry, true); assert.equal(enforced[0].textBeforeTool, false, 'whitespace is not text');
  const subagent = await run([{ ...text('inner draft'), parent_tool_use_id: 'task-1' }, tool]);
  assert.equal(subagent[0].textBeforeTool, false, 'only the main agent counts');
  const none = await run([]);
  assert.deepEqual(none, [{ usage: { inputTokens: 120, outputTokens: 45 } }], 'no StructuredOutput call in the transcript: no claim about text before it');
});
