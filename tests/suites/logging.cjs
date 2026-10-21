const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, integrationTest, root, load, logging, plain, obsidian } = require('../support.cjs');
test('debug log manager timestamps, bounds, formats and clears in-memory entries', () => {
  const logs = new logging.LogManager(2);
  let changes = 0; const unsubscribe = logs.subscribe(() => changes++);
  logs.appendLog('debug', 'discarded'); logs.appendLog('info', 'runtime started'); logs.appendLog('error', 'runtime failed');
  const entries = logs.getLogs();
  assert.equal(entries.length, 2); assert.equal(entries[0].message, 'runtime started'); assert.match(entries[0].timestamp, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(logging.formatDebugLogs(entries), /\[INFO\] runtime started/); assert.match(logging.formatDebugLogs(entries), /\[ERROR\] runtime failed/);
  entries[0].message = 'changed outside'; assert.equal(logs.getLogs()[0].message, 'runtime started');
  logs.clear(); assert.equal(logs.getLogs().length, 0); assert.equal(changes, 4);
  unsubscribe(); logs.appendLog('info', 'ignored by listener'); assert.equal(changes, 4);
});
integrationTest('AI exchange log persists exact request and reply with a bounded history and clear', async () => {
  const { AiExchangeLog, formatAiExchange } = load('ai-exchange-log.ts');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vam-ai-log-'));
  const file = path.join(directory, 'ai-exchanges.json');
  const errors = [];
  const sentinel = path.join(directory, 'unrelated.md'); fs.writeFileSync(sentinel, 'preserve');
  try {
    const exchanges = new AiExchangeLog(file, error => errors.push(error), 2);
    for (let index = 0; index < 3; index++) {
      const id = String(index);
      exchanges.begin({ id, startedAt: new Date().toISOString(), topic: `Topic ${index}`, mode: 'task', model: 'test', effort: 'low' });
      exchanges.sent(id, JSON.stringify({ input: `private prompt ${index}` }));
      exchanges.received(id, `raw response ${index}`);
      exchanges.completed(id);
    }
    await exchanges.flush();
    const restored = new AiExchangeLog(file, error => errors.push(error), 2);
    await restored.load();
    assert.deepEqual(plain(restored.getEntries().map(entry => entry.id)), ['1', '2']);
    assert.match(formatAiExchange(restored.getEntries()[1]), /private prompt 2/);
    assert.match(formatAiExchange(restored.getEntries()[1]), /raw response 2/);
    restored.clear(); await restored.flush();
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), []);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'preserve');
    assert.deepEqual(fs.readdirSync(directory).sort(), ['ai-exchanges.json', 'unrelated.md']);
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(errors, []);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
test('debug log command opens the custom modal and exposes copy and clear actions', () => {
  const source = fs.readFileSync(path.join(root, 'main.ts'), 'utf8');
  const mapSource = fs.readFileSync(path.join(root, 'experiences/visual-map/view.ts'), 'utf8');
  const modal = fs.readFileSync(path.join(root, 'ui/modals/debug-log-modal.ts'), 'utf8');
  assert.match(source, /addLocalizedCommand\("open-debug-log"/); assert.match(source, /new DebugLogModal\(this\.app, this\.logs, this\.exchanges/);
  assert.match(modal, /navigator\.clipboard\.writeText/); assert.match(modal, /this\.logs\.clear\(\)/);
  assert.match(modal, /ui\.debug_log/);
  assert.match(modal, /this\.logs\.subscribe/);
  assert.match(source, /codexReadyForAi\(\)/);
  assert.match(source, /ui\.codex_app_server_is_ready_0/);
  assert.match(mapSource, /log\.ai_task_failed/);
});
integrationTest('AI exchange logging captures the sent payload, raw reply and parse failure', async () => {
  const { default: Plugin } = load('main.ts', { obsidian });
  const { AiExchangeLog } = load('ai-exchange-log.ts');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vam-ai-capture-'));
  try {
    const plugin = new Plugin(); plugin.app = { vault: { adapter: new obsidian.FileSystemAdapter() } }; plugin.manifest = { dir: '.obsidian/plugins/visual-agent-map' };
    plugin.settings.aiExchangeLoggingEnabled = true;
    plugin.exchanges = new AiExchangeLog(path.join(directory, 'exchanges.json'), error => assert.fail(String(error)));
    let reply = '{"summary":"done","detail":"details","suggestions":[],"visualReferences":[]}';
    plugin.runtime = () => ({ runTask: async (prompt, model, effort, _schema, controls) => { controls.onRequest({ input: prompt, model, effort }); return reply; } });
    const context = { title: 'Private topic', summary: 'private summary', rules: '', detail: '', task: 'Analyze this', ancestors: '', mode: 'task', researchMode: 'local', researchDepth: 'fast', visualMode: 'off' };
    await plugin.askModel(context, 'test-model', 'low');
    reply = 'invalid raw answer';
    await assert.rejects(plugin.askModel(context, 'test-model', 'low'));
    await plugin.exchanges.flush();
    const entries = plugin.exchanges.getEntries();
    assert.equal(entries.length, 2);
    assert.match(entries[0].request, /private summary/); assert.match(entries[0].response, /"summary":"done"/); assert.equal(entries[0].status, 'parsed');
    assert.equal(entries[1].response, 'invalid raw answer'); assert.equal(entries[1].status, 'failed'); assert.match(entries[1].error, /Parsing the AI reply/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
integrationTest('turning exchange logging off during a task stops recording its reply', async () => {
  const { default: Plugin } = load('main.ts', { obsidian });
  const { AiExchangeLog } = load('ai-exchange-log.ts');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vam-ai-toggle-'));
  try {
    const plugin = new Plugin(); plugin.app = { vault: { adapter: new obsidian.FileSystemAdapter() } }; plugin.manifest = { dir: '.obsidian/plugins/visual-agent-map' };
    plugin.settings.aiExchangeLoggingEnabled = true;
    plugin.exchanges = new AiExchangeLog(path.join(directory, 'exchanges.json'), error => assert.fail(String(error)));
    let release;
    plugin.runtime = () => ({ runTask: async (_prompt, _model, _effort, _schema, controls) => {
      controls.onRequest({ input: 'sent prompt' });
      return new Promise(resolve => { release = resolve; });
    } });
    const context = { title: 'Topic', summary: '', rules: '', detail: '', task: 'task', ancestors: '', mode: 'task', researchMode: 'local', researchDepth: 'fast', visualMode: 'off' };
    const running = plugin.askModel(context, 'test-model', 'low');
    await new Promise(resolve => setTimeout(resolve, 0));
    plugin.settings.aiExchangeLoggingEnabled = false;
    release('{"summary":"done","detail":"private answer","suggestions":[],"visualReferences":[]}');
    await running; await plugin.exchanges.flush();
    const entry = plugin.exchanges.getEntries()[0];
    assert.match(entry.request, /sent prompt/);
    assert.equal(entry.response, '');
    assert.equal(entry.status, 'sent');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
integrationTest('a Markdown selection reply that arrives after Stop is logged as failed without being received', async () => {
  const { Plugin, prepareStep, planStep } = load('tests/fixtures/entries/markdown-call.ts', { obsidian });
  const { AiExchangeLog } = load('ai-exchange-log.ts');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vam-markdown-stop-'));
  try {
    const plugin = new Plugin(); plugin.app = { vault: { adapter: new obsidian.FileSystemAdapter() } }; plugin.manifest = { dir: '.obsidian/plugins/visual-agent-map' };
    plugin.settings.aiExchangeLoggingEnabled = true;
    plugin.exchanges = new AiExchangeLog(path.join(directory, 'exchanges.json'), error => assert.fail(String(error)));
    const stop = new AbortController();
    plugin.runtime = () => ({ runTask: async (_prompt, _model, _effort, _schema, controls) => { controls.onRequest({ input: 'sent prompt' }); stop.abort(); return 'late reply'; } });
    const prepared = prepareStep(planStep, { instruction: 'Condense', selected: 'Selected text', context: '', hasImage: false });
    await assert.rejects(plugin.runMarkdownContextAi(prepared, 'test-model', stop.signal));
    await plugin.exchanges.flush();
    const [entry] = plugin.exchanges.getEntries();
    assert.equal(entry.step, 'markdown.plan@1'); assert.match(entry.request, /sent prompt/);
    assert.equal(entry.response, ''); assert.equal(entry.status, 'failed');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
integrationTest('Prompt monitor preserves exact Claude prompts, phases and separate steering requests after reload', async () => {
  const { AiExchangeLog, promptMetrics } = load('ai-exchange-log.ts');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vam-prompt-monitor-'));
  try {
    const file = path.join(directory, 'log.json');
    const log = new AiExchangeLog(file, error => assert.fail(String(error)));
    log.begin({ id: 'one', startedAt: new Date().toISOString(), topic: 'Research', mode: 'task', model: 'claude', effort: 'high' });
    const prompt = '<!-- aim-phase: research-plan -->\n完整指令\nprivate context';
    log.sent('one', JSON.stringify({ input: '<VAM prompt via stdin>' }), prompt);
    log.sent('one', JSON.stringify({ input: [{ type: 'text', text: 'Stop and use existing evidence' }] }));
    log.completed('one'); await log.flush();
    const restored = new AiExchangeLog(file, error => assert.fail(String(error))); await restored.load();
    const entries = restored.getEntries(); assert.equal(entries.length, 2);
    assert.equal(promptMetrics(entries[0]).prompt, prompt);
    assert.equal(promptMetrics(entries[0]).phase, 'research-plan');
    assert.equal(promptMetrics(entries[0]).characters, Array.from(prompt).length);
    assert.equal(promptMetrics(entries[1]).prompt, 'Stop and use existing evidence');
    assert.equal(entries[1].mode, 'steer');
    assert.ok(promptMetrics(entries[0]).estimatedTokens > 0);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
test('Prompt monitor reads phases and repair reasons from prompts logged before the AIM rename', () => {
  const { promptMetrics } = load('ai-exchange-log.ts');
  const { LEGACY_MARKER_PREFIX } = load('experiences/aim/legacy-names.ts');
  const prompt = `<!-- ${LEGACY_MARKER_PREFIX}phase: research-plan-repair -->\nRepair reason: missing plan marker\nRetry`;
  const metrics = promptMetrics({ id: 'legacy', startedAt: 'now', topic: 'Research', mode: 'task', model: 'codex', effort: 'low', prompt });
  assert.equal(metrics.phase, 'research-plan-repair');
  assert.equal(metrics.repairReason, 'missing plan marker');
  assert.equal(metrics.prompt, prompt);
});
test('AIM create command keeps its original command ID so existing hotkeys and URIs still work', () => {
  const source = fs.readFileSync(path.join(root, 'main.ts'), 'utf8');
  const { AIM_CREATE_MAP_COMMAND_ID, LEGACY_MARKER_PREFIX } = load('experiences/aim/legacy-names.ts');
  assert.match(source, /addLocalizedCommand\(AIM_CREATE_MAP_COMMAND_ID, "ui\.aim_create_map"/);
  assert.equal(AIM_CREATE_MAP_COMMAND_ID, `create-${LEGACY_MARKER_PREFIX}map`);
});
integrationTest('AI exchange log: milestones are optional, validated as an object on load, ignore unknown keys, and are printed', async () => {
  const { AiExchangeLog, formatAiExchange } = load('ai-exchange-log.ts');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vam-milestones-'));
  try {
    const file = path.join(directory, 'ai-exchanges.json');
    const valid = { id: '1', startedAt: 'now', topic: 'Topic', mode: 'task', model: 'test', effort: 'low', request: 'prompt', response: 'answer', status: 'completed', error: '' };
    // An older log without milestones loads; unknown keys inside milestones are not an error.
    fs.writeFileSync(file, JSON.stringify([valid, { ...valid, id: '2', milestones: { receivedAt: '2026-01-01T00:00:00.000Z', futureKey: { a: 1 }, usage: { inputTokens: 3 }, stream: 'stream-json', acceptedAt: '2026-01-01T00:00:00.000Z', firstEventAt: '2026-01-01T00:00:01.000Z', structuredCalls: 2, textBeforeToolChars: 12, slowShownAt: '2026-01-01T00:00:20.000Z', resendOf: 'old', resentAs: 'new', stages: [{ stage: 'writing', at: '2026-01-01T00:00:02.000Z' }], searches: [{ kind: 'search', startedAt: '2026-01-01T00:00:01.000Z', query: 'synthetic' }] } }]));
    const errors = [];
    const log = new AiExchangeLog(file, error => errors.push(error)); await log.load();
    assert.deepEqual(errors, []); assert.equal(log.getEntries().length, 2);
    assert.equal(log.getEntries()[0].milestones, undefined);
    assert.doesNotMatch(formatAiExchange(log.getEntries()[0]), /milestones:/);
    assert.match(formatAiExchange(log.getEntries()[1]), /milestones: \{"receivedAt":"2026-01-01T00:00:00.000Z"/);
    // A milestones value that is not an object invalidates the log, like any other bad field.
    for (const bad of ['text', 5, [], null]) {
      fs.writeFileSync(file, JSON.stringify([{ ...valid, milestones: bad }]));
      const failures = []; const broken = new AiExchangeLog(file, error => failures.push(error)); await broken.load();
      assert.equal(failures.length, 1, JSON.stringify(bad)); assert.equal(broken.getEntries().length, 0);
    }
    // milestones() stores the data on the entry and persists it.
    const writer = new AiExchangeLog(path.join(directory, 'new.json'), error => errors.push(error));
    writer.begin({ id: 'm', startedAt: new Date().toISOString(), topic: 'T', mode: 'task', model: 'test', effort: 'low' });
    writer.milestones('m', { receivedAt: 'x', textBeforeTool: false }); await writer.flush();
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, 'new.json'), 'utf8'))[0].milestones, { receivedAt: 'x', textBeforeTool: false });
    assert.deepEqual(errors, []);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
