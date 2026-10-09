const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { buildSync } = require('esbuild');

const root = path.resolve(__dirname, '..');
const code = buildSync({
  entryPoints: [path.join(root, 'ai-exchange-log.ts')],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  external: ['node:*']
}).outputFiles[0].text;
let now = 0;
class FakeDate extends Date {
  constructor(value) { super(value === undefined ? now : value); }
  static now() { return now; }
}
const loadedModule = { exports: {} };
vm.runInNewContext(code, { module: loadedModule, exports: loadedModule.exports, require, Date: FakeDate });
const { AiExchangeLog, formatAiExchange, promptMetrics } = loadedModule.exports;

function setNow(value) { now = Date.parse(value); }
function begin(log, id, startedAt = new Date(now).toISOString()) {
  log.begin({ id, startedAt, topic: 'Topic', mode: 'task', model: 'Model', effort: 'medium' });
}

test('persists deterministic send and completion timings across reload', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vam-prompt-timing-'));
  const file = path.join(directory, 'exchanges.json');
  try {
    setNow('2026-01-01T00:00:00.000Z');
    const log = new AiExchangeLog(file, error => { throw error; });
    begin(log, 'initial');
    setNow('2026-01-01T00:00:02.000Z');
    log.sent('initial', '{"request":{"prompt":"hello"}}', 'hello');
    setNow('2026-01-01T00:00:07.250Z');
    log.completed('initial');
    await log.flush();

    const reloaded = new AiExchangeLog(file, error => { throw error; });
    await reloaded.load();
    const [entry] = reloaded.getEntries();
    assert.equal(entry.sentAt, '2026-01-01T00:00:02.000Z');
    assert.equal(entry.completedAt, '2026-01-01T00:00:07.250Z');
    assert.equal(entry.durationMs, 5250);
    const exported = formatAiExchange(entry);
    assert.match(exported, /Request ID: initial/);
    assert.match(exported, /phase: task/);
    assert.match(exported, /prompt: 5 characters/);
    assert.match(exported, /approximately 2 tokens \(estimate, not billed usage\)/);
    assert.match(exported, /sent: 2026-01-01T00:00:02\.000Z/);
    assert.match(exported, /completed: 2026-01-01T00:00:07\.250Z/);
    assert.match(exported, /elapsed: 5\.3 s/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('the AiTaskService received-to-parsed success path persists its final duration', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vam-prompt-parsed-'));
  const file = path.join(directory, 'exchanges.json');
  try {
    setNow('2026-01-01T00:00:00.000Z');
    const log = new AiExchangeLog(file, error => { throw error; });
    begin(log, 'parsed-success');
    setNow('2026-01-01T00:00:01.000Z');
    log.sent('parsed-success', '{"request":true}', 'system prompt');
    setNow('2026-01-01T00:00:04.000Z');
    log.received('parsed-success', 'raw response');
    assert.equal(log.getEntries()[0].completedAt, undefined);
    setNow('2026-01-01T00:00:04.500Z');
    log.parsed('parsed-success');
    await log.flush();

    const reloaded = new AiExchangeLog(file, error => { throw error; });
    await reloaded.load();
    const [entry] = reloaded.getEntries();
    assert.equal(entry.status, 'parsed');
    assert.equal(entry.sentAt, '2026-01-01T00:00:01.000Z');
    assert.equal(entry.completedAt, '2026-01-01T00:00:04.500Z');
    assert.equal(entry.durationMs, 3500);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('preparing failures get elapsed time without pretending a request was sent', () => {
  setNow('2026-01-01T00:01:00.000Z');
  const log = new AiExchangeLog('/unused', () => {});
  begin(log, 'preparing-failure');
  setNow('2026-01-01T00:01:03.000Z');
  log.failed('preparing-failure', 'Provider did not start');
  const [entry] = log.getEntries();
  assert.equal(entry.sentAt, undefined);
  assert.equal(entry.completedAt, '2026-01-01T00:01:03.000Z');
  assert.equal(entry.durationMs, 3000);
});

test('legacy records retain missing timing fields and steering does not duplicate the initial prompt', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vam-prompt-legacy-'));
  const file = path.join(directory, 'exchanges.json');
  try {
    const legacy = { id: 'legacy', startedAt: '2025-01-01T00:00:00.000Z', topic: 'Topic', mode: 'task', model: 'Model', effort: 'low', request: '{}', prompt: 'old prompt', response: '', status: 'sent', error: '' };
    await fs.writeFile(file, JSON.stringify([legacy]));
    const log = new AiExchangeLog(file, error => { throw error; });
    await log.load();
    assert.equal(log.getEntries()[0].sentAt, undefined);
    assert.equal(log.getEntries()[0].completedAt, undefined);
    assert.equal(log.getEntries()[0].durationMs, undefined);
    const legacyExport = formatAiExchange(log.getEntries()[0]);
    assert.match(legacyExport, /sent: unavailable/);
    assert.match(legacyExport, /completed: unavailable/);
    assert.match(legacyExport, /elapsed: unavailable/);

    setNow('2026-01-01T00:02:00.000Z');
    log.sent('legacy', '{"steer":"continue"}', 'copied initial prompt');
    await log.flush();
    const entries = log.getEntries();
    assert.equal(entries.length, 2);
    assert.equal(entries[1].mode, 'steer');
    assert.equal(entries[1].prompt, undefined);
    assert.equal(promptMetrics(entries[0]).characters, 'old prompt'.length);
    assert.equal(promptMetrics(entries[1]).characters, 0);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('repair phase and reason come from the recorded prompt', () => {
  const metrics = promptMetrics({
    id: 'repair', startedAt: '', topic: '', mode: 'task', model: '', effort: '', request: '', response: '', status: 'sent', error: '',
    prompt: '<!-- mindsearch-phase: research-plan-repair -->\nFormat validation error: missing unique subtopic ids\nRest of prompt'
  });
  assert.equal(metrics.phase, 'research-plan-repair');
  assert.equal(metrics.repairReason, 'missing unique subtopic ids');
});

test('legacy or malformed optional prompt data cannot break monitor rendering', () => {
  const metrics = promptMetrics({
    id: 'legacy', startedAt: '', topic: '', mode: 'task', model: '', effort: '', request: 'null', response: '', status: 'sent', error: '', prompt: {}
  });
  assert.equal(metrics.prompt, '');
  assert.equal(metrics.characters, 0);
});
