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
  assert.deepEqual(clean, [{ usage: { inputTokens: 120, outputTokens: 45 }, textBeforeTool: false, textBeforeToolChars: 0, enforceRetry: false }]);
  const drafted = await run([text('{"summary":"S"}'), tool]);
  assert.equal(drafted[0].textBeforeTool, true); assert.equal(drafted[0].enforceRetry, false);
  const narration = await run([text('Let me search for that.'), tool]);
  assert.equal(narration[0].textBeforeTool, false, 'short search narration is not the answer');
  const summaryText = await run([text('Here is the result: "summary": "S"'), tool]);
  assert.equal(summaryText[0].textBeforeTool, true, 'text containing a summary field is the answer');
  // R1: a Markdown prose answer (heading, or more than ~300 characters) before the tool call is an answer; short narration is not.
  const heading = await run([text('### Core conclusions\nShort.'), tool]);
  assert.equal(heading[0].textBeforeTool, true, 'a Markdown heading line is answer text');
  const prose = await run([text('Plain prose without markers. '.repeat(14)), tool]);
  assert.equal(prose[0].textBeforeTool, true); assert.ok(prose[0].textBeforeToolChars > 300);
  const narrationChars = await run([text('Let me search for that.'), tool]);
  assert.equal(narrationChars[0].textBeforeToolChars, 'Let me search for that.'.length);
  const afterTool = await run([tool, text('Done.')]);
  assert.equal(afterTool[0].textBeforeTool, false, 'text after the tool call is not a draft');
  const enforced = await run([text(' '), tool, { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'text', text: '<system-reminder>structured-output-enforce: call the tool</system-reminder>' }] } }, tool]);
  assert.equal(enforced[0].enforceRetry, true); assert.equal(enforced[0].textBeforeTool, false, 'whitespace is not text');
  const subagent = await run([{ ...text('inner draft'), parent_tool_use_id: 'task-1' }, tool]);
  assert.equal(subagent[0].textBeforeTool, false, 'only the main agent counts');
  const none = await run([]);
  assert.deepEqual(none, [{ usage: { inputTokens: 120, outputTokens: 45 } }], 'no StructuredOutput call in the transcript: no claim about text before it');
});

// ---- Segment B: stream-json observation with synthetic JSONL fixtures ----
const streamHarness = () => {
  const { EventEmitter } = require('node:events');
  const output = { summary: 'Synthetic summary', detail: 'Line one\nLine two', suggestions: [], visualReferences: [] };
  const sys = { type: 'system', subtype: 'init' };
  const ev = event => ({ type: 'stream_event', event });
  const start = (index, block) => ev({ type: 'content_block_start', index, content_block: block });
  const delta = (index, d) => ev({ type: 'content_block_delta', index, delta: d });
  const json = (index, partial) => delta(index, { type: 'input_json_delta', partial_json: partial });
  const stop = index => ev({ type: 'content_block_stop', index });
  const tool = (id, name) => start(0, { type: 'tool_use', id, name, input: {} });
  const assistantTool = (id, name, input) => ({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id, name, input }] } });
  const result = (extra = {}) => ({ type: 'result', subtype: 'success', is_error: false, structured_output: output, usage: { input_tokens: 10, output_tokens: 5 }, ...extra });
  const toolResult = (id, extra = {}) => ({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok', ...extra }] } });
  const structuredCall = id => [ev({ type: 'message_start' }), tool(id, 'StructuredOutput'), json(0, '{"summary":"Syn'), json(0, 'thetic summary","detail":"Line one\\n'), json(0, 'Line two"}'), stop(0), assistantTool(id, 'StructuredOutput', output)];
  const run = async (chunks, controls = {}, { runtime, code = 0, stderr = '' } = {}) => {
    const spawns = [];
    const spawn = (_exe, args) => {
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => true;
      const mine = { args, prompt: '' }; spawns.push(mine);
      child.stdin = { on() {}, end: (text, done) => { mine.prompt = text; done?.(); process.nextTick(() => {
        const lines = typeof chunks === 'function' ? chunks(spawns.length) : chunks;
        const body = lines.map(line => typeof line === 'string' ? line : JSON.stringify(line)).join('\n') + '\n';
        if (Array.isArray(lines) && lines.length) for (let i = 0; i < body.length; i += 37) child.stdout.emit('data', Buffer.from(body.slice(i, i + 37)));
        if (mine.stderr || (typeof stderr === 'function' ? stderr(spawns.length) : stderr)) child.stderr.emit('data', Buffer.from(typeof stderr === 'function' ? stderr(spawns.length) : stderr));
        child.emit('close', typeof code === 'function' ? code(spawns.length) : code);
      }); } };
      return child;
    };
    const { ClaudeCodeCliRuntime } = load('ai/runtime/claude-code-cli.ts', { 'node:child_process': { spawn } });
    const rt = runtime ?? new ClaudeCodeCliRuntime({ executable: 'claude', cwd: '/plugin', env: {}, spawn, onLog: (level, message) => logs.push([level, message]) });
    const logs = [], stages = [], deltas = [], milestones = [], modes = []; let firstEvents = 0;
    const raw = await rt.runTask('p', 'sonnet', 'low', { type: 'object' }, { stream: true, onStage: (stage, query) => stages.push([stage, query]), onStructuredDelta: fields => deltas.push(fields && JSON.parse(JSON.stringify(fields))), onFirstEvent: () => { firstEvents++; }, onMilestones: data => milestones.push(JSON.parse(JSON.stringify(data))), onStreamMode: mode => modes.push(mode), ...controls }).catch(error => { error.spawns = spawns; throw error; });
    return { raw, spawns, stages, deltas, milestones, firstEvents, modes, logs, rt };
  };
  return { output, sys, ev, start, delta, json, stop, tool, assistantTool, result, toolResult, structuredCall, run, EventEmitter, spawnRuntime: () => null };
};

test('Claude stream-json: a normal observed call reports the first model event, writing stage and the growing preview', async () => {
  const h = streamHarness();
  const out = await h.run([h.sys, ...h.structuredCall('so1'), h.result()]);
  const args = out.spawns[0].args;
  assert.equal(args[args.indexOf('--output-format') + 1], 'stream-json');
  assert.ok(args.includes('--include-partial-messages') && args.includes('--verbose'));
  assert.deepEqual(JSON.parse(out.raw), h.output, 'the result comes from the result record');
  assert.equal(out.firstEvents, 1, 'the CLI init line is not a model event');
  assert.deepEqual(out.stages, [['writing', undefined]]);
  assert.deepEqual(out.deltas[0], { summaryComplete: false, detailComplete: false }, 'a StructuredOutput start resets the preview');
  assert.ok(out.deltas.some(d => d && d.summary === 'Synthetic summary' && d.summaryComplete));
  const last = out.deltas.at(-1); assert.equal(last.detail, 'Line one\nLine two'); assert.equal(last.detailComplete, true);
  assert.deepEqual(out.modes, ['stream-json']);
  const m = out.milestones[0];
  assert.equal(m.stream, 'stream-json'); assert.equal(m.structuredCalls, 1); assert.ok(m.firstEventAt && m.structuredStartAt && m.previewSummaryAt && m.acceptedAt);
  assert.deepEqual(m.stages.map(item => item.stage), ['writing']); assert.deepEqual(m.usage, { inputTokens: 10, outputTokens: 5 });
  assert.equal(m.textBeforeTool, false); assert.equal(m.enforceRetry, false); assert.equal(out.milestones.length, 1, 'milestones are reported once');
});

test('Claude stream-json: answer text before the tool call, a rejected call (retraction) and the enforce retry', async () => {
  const h = streamHarness();
  const prose = 'Synthetic prose that restates the answer before calling the tool. '.repeat(6);
  const lines = [
    h.sys, h.ev({ type: 'message_start' }), h.start(0, { type: 'text', text: '' }), h.delta(0, { type: 'text_delta', text: prose }), h.stop(0),
    ...h.structuredCall('so1').slice(1), h.toolResult('so1', { is_error: true, content: 'validation failed' }),
    { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'text', text: '<system-reminder>structured-output-enforce: call the tool</system-reminder>' }] } },
    ...h.structuredCall('so2'), h.result()
  ];
  const out = await h.run(lines);
  assert.deepEqual(JSON.parse(out.raw), h.output);
  const nullIndex = out.deltas.indexOf(null);
  assert.ok(nullIndex > 0, 'an is_error tool_result clears the preview');
  assert.deepEqual(out.deltas[nullIndex + 1], { summaryComplete: false, detailComplete: false }, 'the new call starts from nothing');
  assert.equal(out.deltas.at(-1).summary, 'Synthetic summary');
  const m = out.milestones[0];
  assert.equal(m.textBeforeTool, true); assert.ok(m.textBeforeToolChars > 300); assert.equal(m.structuredCalls, 2); assert.equal(m.enforceRetry, true); assert.ok(m.firstTextAt);
});

test('Claude stream-json: WebSearch then WebFetch report searching with the query, reading and writing, and the searches', async () => {
  const h = streamHarness();
  const lines = [
    h.sys, h.ev({ type: 'message_start' }), h.tool('ws1', 'WebSearch'), h.json(0, '{"query":"synthetic'), h.json(0, ' query"}'), h.stop(0), h.assistantTool('ws1', 'WebSearch', { query: 'synthetic query' }), h.toolResult('ws1'),
    h.ev({ type: 'message_start' }), h.tool('wf1', 'WebFetch'), h.json(0, '{"url":"https://example.org/a"}'), h.stop(0), h.assistantTool('wf1', 'WebFetch', { url: 'https://example.org/a' }), h.toolResult('wf1', { is_error: true }),
    ...h.structuredCall('so1'), h.result()
  ];
  const events = [];
  const out = await h.run(lines, { webSearch: true, webSearchOnly: true, onWebSearchEvent: event => events.push(event.method) });
  assert.deepEqual(out.stages, [['searching', undefined], ['searching', 'synthetic query'], ['reading', undefined], ['writing', undefined]]);
  const m = out.milestones[0];
  assert.deepEqual(m.stages.map(item => item.stage), ['searching', 'reading', 'writing']);
  assert.equal(m.searches.length, 2);
  assert.equal(m.searches[0].kind, 'search'); assert.equal(m.searches[0].query, 'synthetic query'); assert.ok(m.searches[0].completedAt); assert.equal(m.searches[0].failed, undefined);
  assert.equal(m.searches[1].kind, 'openPage'); assert.equal(m.searches[1].failed, true);
  assert.deepEqual(events, ['item/started', 'item/completed', 'item/started'], 'web telemetry keeps its Codex shape; the failed fetch is not a retrieval');
});

test('Claude stream-json: a line that cannot be read stops stage and preview updates but the result is still taken', async () => {
  const h = streamHarness();
  const lines = [h.sys, h.ev({ type: 'message_start' }), h.tool('so1', 'StructuredOutput'), h.json(0, '{"summary":"Part'), '{ this is not json', h.json(0, 'ial"}'), h.tool('ws9', 'WebSearch'), h.result()];
  const out = await h.run(lines);
  assert.deepEqual(JSON.parse(out.raw), h.output);
  assert.equal(out.deltas.at(-1), null, 'the preview is cleared and stays cleared');
  assert.deepEqual(out.stages, [['writing', undefined]], 'no stage after the bad line');
  assert.deepEqual(out.milestones[0].usage, { inputTokens: 10, outputTokens: 5 });
});

test('Claude stream-json: a CLI that rejects the stream flags at boot is run once in json mode and remembered', async () => {
  const h = streamHarness();
  const jsonBody = [{ type: 'system', subtype: 'init' }, h.result()];
  const first = await h.run(count => (count === 1 ? [] : [JSON.stringify(jsonBody)]), {}, { code: count => (count === 1 ? 1 : 0), stderr: count => (count === 1 ? "error: unknown option '--include-partial-messages'" : '') });
  assert.equal(first.spawns.length, 2);
  assert.equal(first.spawns[0].args[first.spawns[0].args.indexOf('--output-format') + 1], 'stream-json');
  assert.equal(first.spawns[1].args[first.spawns[1].args.indexOf('--output-format') + 1], 'json');
  assert.ok(!first.spawns[1].args.includes('--include-partial-messages'));
  assert.deepEqual(JSON.parse(first.raw), h.output);
  assert.deepEqual(first.modes, ['stream-json', 'json-fallback']);
  assert.equal(first.milestones.at(-1).stream, 'json-fallback');
  assert.ok(first.logs.some(([level, message]) => level === 'warn' && /stream/i.test(message)), 'the fallback is logged');
  // The same runtime remembers: the next call goes straight to json.
  const modes = [];
  const again = await first.rt.runTask('p', 'sonnet', 'low', { type: 'object' }, { stream: true, onStreamMode: mode => modes.push(mode) });
  assert.deepEqual(JSON.parse(again), h.output); assert.deepEqual(modes, ['json']);
});

test('Claude stream-json: a model-side failure is not mistaken for rejected flags and is not rerun', async () => {
  const h = streamHarness();
  const out = await h.run([h.sys, h.ev({ type: 'message_start' }), { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['synthetic model failure'] }], {}, { code: 1, stderr: 'mentions --output-format in a hint' }).catch(error => error);
  assert.equal(out.spawns.length, 1, 'a failure that produced a result record is not rerun');
  assert.match(String(out.message), /--output-format/);
});
