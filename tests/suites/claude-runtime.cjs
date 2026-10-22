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
  assert.deepEqual(m.stages.map(item => item.stage), ['waiting', 'writing']); assert.equal(m.stages[0].at, m.acceptedAt, 'the first stage is waiting, at acceptance'); assert.deepEqual(m.usage, { inputTokens: 10, outputTokens: 5 });
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

test('Claude stream-json: the raw StructuredOutput JSON accumulates, resets for a new call and clears when the CLI rejects one', async () => {
  const h = streamHarness();
  const call = id => [h.ev({ type: 'message_start' }), h.tool(id, 'StructuredOutput'), h.json(0, '{"items":[{"id":"c1","tier":"core"},'), h.json(0, '{"id":"c2","tier":"side"}]}'), h.stop(0), h.assistantTool(id, 'StructuredOutput', h.output)];
  const buffers = [];
  const out = await h.run([h.sys, ...call('so1'), h.toolResult('so1', { is_error: true, content: 'validation failed' }), ...call('so2'), h.result()], { onStructuredJson: buffer => buffers.push(buffer) });
  assert.deepEqual(JSON.parse(out.raw), h.output, 'the result still comes from the result record');
  assert.deepEqual(buffers, [
    '', '{"items":[{"id":"c1","tier":"core"},', '{"items":[{"id":"c1","tier":"core"},{"id":"c2","tier":"side"}]}',
    null,
    '', '{"items":[{"id":"c1","tier":"core"},', '{"items":[{"id":"c1","tier":"core"},{"id":"c2","tier":"side"}]}'
  ], 'a new call starts from "", is_error gives null, and the second call never continues the first one\'s text');
  const quiet = await h.run([h.sys, ...call('so1'), h.result()]);
  assert.deepEqual(JSON.parse(quiet.raw), h.output, 'no hook, no change');
  const lost = [];
  await h.run([h.sys, h.ev({ type: 'message_start' }), h.tool('so1', 'StructuredOutput'), h.json(0, '{"items":[{"id":"c1","tier":"core"}'), '{ this is not json', h.result()], { onStructuredJson: buffer => lost.push(buffer) });
  assert.equal(lost.at(-1), null, 'a line that cannot be read clears the count');
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
  assert.deepEqual(m.stages.map(item => item.stage), ['waiting', 'searching', 'reading', 'writing']);
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
  for (const key of ['textBeforeTool', 'textBeforeToolChars', 'enforceRetry']) assert.equal(key in out.milestones[0], false, `${key} is left unset after a lost line, so it cannot read as a false pass`);
  // A clean stream still reports them.
  const clean = await h.run([h.sys, ...h.structuredCall('so2'), h.result()]);
  assert.equal(clean.milestones[0].textBeforeTool, false); assert.equal(clean.milestones[0].textBeforeToolChars, 0);
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

// ---- Segment C: S6 warm pool (pre-started Claude CLI), all synthetic: no process is really started ----
const warmHarness = () => {
  const { EventEmitter } = require('node:events');
  const children = [];
  const makeChild = () => {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.writes = []; child.stdinEnded = false; child.signals = []; child.exited = false;
    child.stdin = { on() {}, write(text, done) { child.writes.push(text); done?.(); return true; }, end(text, done) { if (text !== undefined) child.writes.push(text); child.stdinEnded = true; done?.(); } };
    child.kill = signal => { child.signals.push(signal); if (signal === 'SIGTERM' && !child.ignoreTerm || signal === 'SIGKILL') { child.exited = true; process.nextTick(() => child.emit('close', null, signal)); } return true; };
    children.push(child); return child;
  };
  const spawn = (_exe, args) => { const child = makeChild(); child.args = args; return child; };
  const clock = (() => { let now = 0, id = 0; const timers = new Map();
    return { setTimeout: (callback, ms) => { timers.set(++id, { at: now + ms, callback }); return id; }, clearTimeout: handle => timers.delete(handle),
      advance(ms) { now += ms; for (const [key, timer] of [...timers]) if (timer.at <= now) { timers.delete(key); timer.callback(); } }, pending: () => timers.size }; })();
  const { ClaudeCodeCliRuntime } = load('ai/runtime/claude-code-cli.ts', { 'node:child_process': { spawn } });
  const { ClaudeWarmPool } = load('ai/runtime/claude-warm-pool.ts');
  const pool = new ClaudeWarmPool({ clock });
  const runtime = new ClaudeCodeCliRuntime({ executable: 'claude', cwd: '/plugin', env: {}, spawn, warmPool: pool });
  const schema = { type: 'object' };
  const output = { summary: 'Warm summary', detail: 'Warm detail', suggestions: [], visualReferences: [] };
  const finish = (child, extra = []) => {
    const lines = [{ type: 'system', subtype: 'init' }, ...extra, { type: 'result', subtype: 'success', is_error: false, structured_output: output }];
    child.stdout.emit('data', Buffer.from(lines.map(line => JSON.stringify(line)).join('\n') + '\n'));
    process.nextTick(() => child.emit('close', 0));
  };
  return { children, clock, pool, runtime, schema, output, finish, ClaudeCodeCliRuntime, spawn };
};
const sentText = child => JSON.parse(child.writes[0]).message.content[0].text;

test('S6 pool: a pre-started process writes nothing until the prompt, and a run with the same command takes it and writes only the prompt', async () => {
  const h = warmHarness();
  assert.equal(h.runtime.prewarm('sonnet', 'low', h.schema, true), true);
  assert.equal(h.children.length, 1);
  const warm = h.children[0];
  assert.ok(warm.args.includes('--input-format') && warm.args[warm.args.indexOf('--input-format') + 1] === 'stream-json');
  assert.equal(warm.args[warm.args.indexOf('--output-format') + 1], 'stream-json');
  assert.deepEqual(warm.writes, [], 'nothing is written to a waiting process, so it makes no model call');
  assert.equal(h.pool.size, 1);
  const milestones = [], modes = [];
  const run = h.runtime.runTask('the prompt', 'sonnet', 'low', h.schema, { stream: true, webSearch: true, onMilestones: data => milestones.push(data), onStreamMode: mode => modes.push(mode) });
  await until(() => warm.writes.length === 1);
  assert.equal(h.children.length, 1, 'no second process: the pre-started one is used');
  assert.equal(sentText(warm), 'the prompt');
  assert.equal(JSON.parse(warm.writes[0]).type, 'user');
  assert.equal(warm.stdinEnded, false, 'stdin stays open until the result');
  assert.equal(h.pool.size, 0, 'taken: the pool no longer owns it');
  h.finish(warm);
  assert.deepEqual(JSON.parse(await run), h.output);
  assert.equal(warm.stdinEnded, true, 'stdin is closed after the result so the process exits');
  assert.equal(milestones.find(item => 'prespawned' in item).prespawned, true);
  assert.deepEqual(modes, ['stream-json']);
});

test('S6 pool: any difference in model, effort, schema, tools or folder starts cold and leaves the pre-started process for its own run', async () => {
  const cases = [
    ['model', rt => rt.runTask('p', 'haiku', 'low', { type: 'object' }, { stream: true, webSearch: true })],
    ['effort', rt => rt.runTask('p', 'sonnet', 'high', { type: 'object' }, { stream: true, webSearch: true })],
    ['schema', rt => rt.runTask('p', 'sonnet', 'low', { type: 'object', required: [] }, { stream: true, webSearch: true })],
    ['tools', rt => rt.runTask('p', 'sonnet', 'low', { type: 'object' }, { stream: true, webSearch: false })]
  ];
  for (const [name, call] of cases) {
    const h = warmHarness();
    h.runtime.prewarm('sonnet', 'low', h.schema, true);
    const warm = h.children[0];
    const milestones = [];
    const run = call({ runTask: (prompt, model, effort, schema, controls) => h.runtime.runTask(prompt, model, effort, schema, { ...controls, onMilestones: data => milestones.push(data) }) });
    await until(() => h.children.length === 2);
    assert.deepEqual(warm.signals, [], `${name}: the pre-started process is left alone`);
    assert.equal(warm.writes.length, 0, `${name}: the prompt never reached it`);
    const cold = h.children[1];
    assert.ok(!cold.args.includes('--input-format'), `${name}: cold start uses the ordinary command`);
    h.finish(cold, []);
    await run.catch(() => {});
    assert.equal(milestones.find(item => 'prespawned' in item).prespawned, false, `${name}: recorded as not pre-spawned`);
    assert.equal(h.pool.size, 1, `${name}: the slot is still waiting for the dialog's own run`);
    assert.equal(h.children.length, 2, `${name}: no extra process`);
  }
  // another folder is another key
  const h = warmHarness();
  h.runtime.prewarm('sonnet', 'low', h.schema, true);
  const other = new h.ClaudeCodeCliRuntime({ executable: 'claude', cwd: '/elsewhere', env: {}, spawn: h.spawn, warmPool: h.pool });
  const run = other.runTask('p', 'sonnet', 'low', h.schema, { stream: true, webSearch: true });
  await until(() => h.children.length === 2);
  assert.deepEqual(h.children[0].signals, [], 'a different folder is a different key: cold start, the slot stays');
  assert.equal(h.pool.size, 1);
  h.finish(h.children[1]); await run;
  // the owner of the slot still finds it after the unrelated calls
  const own = h.runtime.runTask('mine', 'sonnet', 'low', h.schema, { stream: true, webSearch: true });
  await until(() => h.children[0].writes.length === 1);
  assert.equal(h.children.length, 2, 'the dialog\'s run reuses the original process');
  assert.equal(h.pool.size, 0);
  h.finish(h.children[0]); await own;
});

test('S6 pool: a take with another key returns null and keeps the slot (at most one idle process, still released by its own owner)', () => {
  const { ClaudeWarmPool } = load('ai/runtime/claude-warm-pool.ts');
  const killed = []; const child = () => ({ kill: signal => { killed.push(signal); return true; }, on() {} });
  const pool = new ClaudeWarmPool({ clock: { setTimeout: () => 1, clearTimeout() {} } });
  const mine = child();
  pool.prewarm('a', () => mine);
  assert.equal(pool.take('b'), null);
  assert.equal(pool.size, 1); assert.deepEqual(killed, []);
  assert.equal(pool.take('a'), mine); assert.equal(pool.size, 0);
  pool.prewarm('a', () => child()); pool.prewarm('b', () => child());
  assert.equal(pool.size, 1, 'a second pre-start replaces the first: never two idle processes'); assert.deepEqual(killed, ['SIGTERM']);
});

test('S6 pool: a disposed pool or service refuses every pre-start and has nothing left running', () => {
  const { ClaudeWarmPool } = load('ai/runtime/claude-warm-pool.ts');
  const signals = []; const clock = { setTimeout: () => 1, clearTimeout() {} };
  const pool = new ClaudeWarmPool({ clock });
  pool.prewarm('a', () => ({ kill: signal => { signals.push(signal); return true; }, on() {} }));
  pool.dispose();
  assert.deepEqual(signals, ['SIGTERM']); assert.equal(pool.size, 0);
  let started = 0;
  assert.equal(pool.prewarm('a', () => { started++; return { kill: () => true, on() {} }; }), false);
  assert.equal(started, 0); assert.equal(pool.size, 0);
  const h = warmHarness();
  const { AiRuntimeService } = load('core/ai-runtime-service.ts', { 'node:child_process': { spawn: h.spawn } });
  const service = new AiRuntimeService({ codexPath: () => 'codex', claudePath: () => '/bin/claude', clientVersion: () => '1', onLog: () => {}, warmClock: h.clock, claudeSpawn: h.spawn });
  const runtime = service.claude('/plugin');
  assert.equal(runtime.prewarm('sonnet', 'low', h.schema, true), true);
  service.dispose();
  assert.equal(h.children[0].signals[0], 'SIGTERM'); assert.equal(service.hasWarm(), false);
  assert.equal(runtime.prewarm('sonnet', 'low', h.schema, true), false, 'a runtime obtained earlier cannot start one either');
  assert.equal(service.claude('/other').prewarm('sonnet', 'low', h.schema, false), false);
  assert.equal(h.children.length, 1, 'no process was started after dispose'); assert.equal(service.hasWarm(), false);
});

test('S6 pool: a local run (no web tools) takes a process pre-started with webSearch false, and not one started with webSearch true', async () => {
  const h = warmHarness();
  h.runtime.prewarm('sonnet', 'low', h.schema, false);
  const local = h.children[0];
  assert.ok(local.args.includes('--tools') && local.args[local.args.indexOf('--tools') + 1] === '');
  const milestones = [];
  const run = h.runtime.runTask('local prompt', 'sonnet', 'low', h.schema, { stream: true, webSearch: false, onMilestones: data => milestones.push(data) });
  await until(() => local.writes.length === 1);
  assert.equal(h.children.length, 1, 'the local run reuses the local process');
  assert.equal(sentText(local), 'local prompt');
  h.finish(local); await run;
  assert.equal(milestones.find(item => 'prespawned' in item).prespawned, true);
  // a web-search pre-start does not serve a local run (and is not killed by it)
  const h2 = warmHarness();
  h2.runtime.prewarm('sonnet', 'low', h2.schema, true);
  const cold = h2.runtime.runTask('p', 'sonnet', 'low', h2.schema, { stream: true, webSearch: false });
  await until(() => h2.children.length === 2);
  assert.deepEqual(h2.children[0].signals, []); assert.equal(h2.pool.size, 1);
  h2.finish(h2.children[1]); await cold;
});

test('S6 pool: an idle pre-started process is killed after 180 s by the fake clock, and a later run starts cold', async () => {
  const h = warmHarness();
  h.runtime.prewarm('sonnet', 'low', h.schema, true);
  const warm = h.children[0];
  h.clock.advance(179_999);
  assert.deepEqual(warm.signals, [], 'not yet');
  h.clock.advance(1);
  assert.deepEqual(warm.signals, ['SIGTERM']);
  assert.equal(h.pool.size, 0);
  await until(() => warm.exited); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.clock.pending(), 0, 'no timer is left behind once the process has closed');
  const run = h.runtime.runTask('p', 'sonnet', 'low', h.schema, { stream: true, webSearch: true });
  await until(() => h.children.length === 2);
  h.finish(h.children[1]); await run;
});

test('S6 pool: prewarming again with the same command only restarts the idle time; a new command replaces the process', () => {
  const h = warmHarness();
  h.runtime.prewarm('sonnet', 'low', h.schema, true);
  h.clock.advance(100_000);
  h.runtime.prewarm('sonnet', 'low', h.schema, true);
  assert.equal(h.children.length, 1);
  h.clock.advance(100_000);
  assert.deepEqual(h.children[0].signals, [], 'the idle time restarted');
  h.runtime.prewarm('opus', 'low', h.schema, true);
  assert.equal(h.children.length, 2); assert.equal(h.children[0].signals[0], 'SIGTERM'); assert.equal(h.pool.size, 1);
});

test('S6 pool: dispose (release) kills the process, escalates to SIGKILL if it ignores SIGTERM, and a dead process is never handed out', async () => {
  const h = warmHarness();
  h.runtime.prewarm('sonnet', 'low', h.schema, true);
  const stubborn = h.children[0]; stubborn.ignoreTerm = true;
  h.pool.release();
  assert.deepEqual(stubborn.signals, ['SIGTERM']); assert.equal(h.pool.size, 0);
  h.clock.advance(1_500);
  assert.deepEqual(stubborn.signals, ['SIGTERM', 'SIGKILL'], 'no orphan: the stuck process is killed');
  h.pool.release(); // safe when empty
  // A process that exits by itself leaves the pool and cannot be taken.
  const h2 = warmHarness();
  h2.runtime.prewarm('sonnet', 'low', h2.schema, true);
  h2.children[0].exited = true; h2.children[0].emit('close', 1);
  assert.equal(h2.pool.size, 0);
  const run = h2.runtime.runTask('p', 'sonnet', 'low', h2.schema, { stream: true, webSearch: true });
  await until(() => h2.children.length === 2);
  assert.ok(!h2.children[1].args.includes('--input-format'));
  h2.finish(h2.children[1]); await run;
});

test('S6 pool: Stop after the process was taken kills it; Stop before the run reaches the CLI releases the waiting process', async () => {
  const h = warmHarness();
  h.runtime.prewarm('sonnet', 'low', h.schema, true);
  const warm = h.children[0];
  const controller = new AbortController();
  const run = h.runtime.runTask('p', 'sonnet', 'low', h.schema, { stream: true, webSearch: true, signal: controller.signal });
  await until(() => warm.writes.length === 1);
  controller.abort();
  await assert.rejects(run, error => error.name === 'AbortError');
  assert.equal(warm.signals[0], 'SIGTERM', 'taken-then-aborted: the process is killed by its own handle');
  assert.equal(h.children.length, 1);
  // aborted before the CLI step: the waiting process goes too
  const h2 = warmHarness();
  h2.runtime.prewarm('sonnet', 'low', h2.schema, true);
  const early = new AbortController(); early.abort();
  await assert.rejects(h2.runtime.runTask('p', 'sonnet', 'low', h2.schema, { stream: true, webSearch: true, signal: early.signal }), error => error.name === 'AbortError');
  assert.equal(h2.children[0].signals[0], 'SIGTERM'); assert.equal(h2.pool.size, 0);
});

test('S6 pool: AiRuntimeService.reset() (plugin unload and runtime reset) kills the waiting process; releaseWarm kills it too', () => {
  const h = warmHarness();
  const { AiRuntimeService } = load('core/ai-runtime-service.ts', { 'node:child_process': { spawn: h.spawn } });
  const service = new AiRuntimeService({ codexPath: () => 'codex', claudePath: () => '/bin/claude', clientVersion: () => '1', onLog: () => {}, warmClock: h.clock, claudeSpawn: h.spawn });
  const warmUp = () => service.claude('/plugin').prewarm('sonnet', 'low', h.schema, true);
  assert.equal(warmUp(), true); assert.equal(service.hasWarm(), true);
  service.reset();
  assert.equal(h.children[0].signals[0], 'SIGTERM'); assert.equal(service.hasWarm(), false);
  warmUp(); service.releaseWarm();
  assert.equal(h.children[1].signals[0], 'SIGTERM'); assert.equal(service.hasWarm(), false);
  warmUp(); h.clock.advance(180_000);
  assert.equal(h.children[2].signals[0], 'SIGTERM', 'the service pool uses the same 180 s idle limit');
});

test('S6 pool: a runtime without a pool, or a call that is not an observed schema call, never touches the pool', async () => {
  const h = warmHarness();
  const bare = new h.ClaudeCodeCliRuntime({ executable: 'claude', cwd: '/plugin', env: {}, spawn: h.spawn });
  assert.equal(bare.prewarm('sonnet', 'low', h.schema, true), false);
  assert.equal(h.runtime.prewarm('sonnet', 'low', undefined, true), false, 'no schema, no pre-start');
  assert.equal(h.children.length, 0);
});

test('L4: AiRuntimeService.claude() returns one runtime per executable and folder (so it remembers the CLI), and reset() drops it', () => {
  const { AiRuntimeService } = load('core/ai-runtime-service.ts');
  let path = '/bin/claude-a';
  const service = new AiRuntimeService({ codexPath: () => 'codex', claudePath: () => path, clientVersion: () => '1', onLog: () => {} });
  const first = service.claude('/plugin');
  assert.equal(service.claude('/plugin'), first, 'same executable and folder: the same runtime');
  assert.notEqual(service.claude('/other'), first, 'another folder: another runtime');
  const other = service.claude('/other');
  assert.equal(service.claude('/other'), other);
  path = '/bin/claude-b';
  assert.notEqual(service.claude('/other'), other, 'another executable: another runtime');
  const current = service.claude('/other');
  service.reset();
  assert.notEqual(service.claude('/other'), current, 'reset() clears the cached runtime');
});
