// The plugin no longer imports node:fs: adapter-backed JSON stores, the shell executable probe and the Codex image reader.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./support-replay.cjs');

const { AiExchangeLog } = load('ai-exchange-log.ts');
const { PendingSuggestions } = load('pending-suggestions.ts');
const { AiRuntimeService, shellExecutableProbe } = load('core/ai-runtime-service.ts');

/** In-memory DataAdapter slice; rename refuses an existing destination like Obsidian's. */
function memoryAdapter(files = {}) {
  const calls = [];
  const adapter = {
    files, calls,
    async exists(path) { calls.push(['exists', path]); return path in files; },
    async read(path) { calls.push(['read', path]); if (!(path in files)) throw new Error('ENOENT'); return files[path]; },
    async write(path, data) { calls.push(['write', path]); files[path] = data; },
    async rename(path, to) { calls.push(['rename', path, to]); if (to in files) throw new Error('Destination file already exists!'); files[to] = files[path]; delete files[path]; },
    async remove(path) { calls.push(['remove', path]); delete files[path]; }
  };
  return adapter;
}
const exchange = { id: '1', startedAt: 'now', topic: 'T', mode: 'task', model: 'm', effort: 'low' };
const suggestion = { title: 'A', task: 'B', contribution: 'C' };

test('stores: a missing file loads empty without an error and without a read', async () => {
  const errors = [], adapter = memoryAdapter();
  const log = new AiExchangeLog(adapter, 'plugins/vam/ai-exchanges.json', e => errors.push(e));
  await log.load();
  const pending = new PendingSuggestions(adapter, 'plugins/vam/pending-suggestions.json', e => errors.push(e));
  await pending.load();
  assert.equal(log.getEntries().length, 0); assert.equal(pending.size, 0);
  assert.deepEqual(errors, []); assert.equal(adapter.calls.some(c => c[0] === 'read'), false);
});

test('stores: invalid JSON reports one error and blocks later writes', async () => {
  const errors = [], adapter = memoryAdapter({ 'a.json': '{broken', 'b.json': '{broken' });
  const log = new AiExchangeLog(adapter, 'a.json', e => errors.push(e)); await log.load();
  assert.equal(errors.length, 1);
  log.begin(exchange); await log.flush();
  assert.equal(adapter.files['a.json'], '{broken'); assert.equal(adapter.calls.some(c => c[0] === 'write'), false);
  errors.length = 1;
  const pending = new PendingSuggestions(adapter, 'b.json', e => errors.push(e)); await pending.load();
  assert.equal(errors.length, 2);
  pending.set('t.md', [suggestion]); await assert.rejects(pending.flush());
  assert.equal(adapter.files['b.json'], '{broken');
});

test('stores: a write goes to <path>.tmp, then replaces the existing file via remove and rename', async () => {
  const adapter = memoryAdapter({ 'dir/ai-exchanges.json': '[]', 'dir/pending-suggestions.json': '[]' });
  const log = new AiExchangeLog(adapter, 'dir/ai-exchanges.json', e => { throw e; });
  log.begin(exchange); await log.flush();
  assert.deepEqual(adapter.calls.filter(c => c[0] !== 'exists').map(c => c.join(' ')), [
    'write dir/ai-exchanges.json.tmp', 'remove dir/ai-exchanges.json', 'rename dir/ai-exchanges.json.tmp dir/ai-exchanges.json'
  ]);
  assert.equal(JSON.parse(adapter.files['dir/ai-exchanges.json'])[0].id, '1');
  assert.equal('dir/ai-exchanges.json.tmp' in adapter.files, false);
  adapter.calls.length = 0;
  const pending = new PendingSuggestions(adapter, 'dir/pending-suggestions.json', e => { throw e; });
  pending.set('t.md', [suggestion]); await pending.flush();
  assert.deepEqual(adapter.calls.filter(c => c[0] !== 'exists').map(c => c.join(' ')), [
    'write dir/pending-suggestions.json.tmp', 'remove dir/pending-suggestions.json', 'rename dir/pending-suggestions.json.tmp dir/pending-suggestions.json'
  ]);
  const reloaded = new PendingSuggestions(adapter, 'dir/pending-suggestions.json', e => { throw e; }); await reloaded.load();
  assert.equal(reloaded.get('t.md')[0].title, 'A');
});

test('stores: first write with no destination skips remove; adapter failures reach onError', async () => {
  const adapter = memoryAdapter();
  const log = new AiExchangeLog(adapter, 'new.json', e => { throw e; });
  log.begin(exchange); await log.flush();
  assert.equal(adapter.calls.some(c => c[0] === 'remove'), false);
  assert.ok('new.json' in adapter.files);
  const errors = [], failing = { ...memoryAdapter(), write: async () => { throw new Error('disk full'); } };
  const broken = new AiExchangeLog(failing, 'x.json', e => errors.push(e));
  broken.begin(exchange); await broken.flush();
  assert.match(String(errors[0]), /disk full/);
});

function service(probe, env, configured = 'claude') {
  const { AiRuntimeService: Service } = load('core/ai-runtime-service.ts', {}, { window: { process: { env } } });
  return new Service({ codexPath: () => configured, claudePath: () => configured, clientVersion: () => 't', onLog() {}, probe });
}

test('probe: the first existing candidate wins, in the original order with nvm versions after /usr/local/bin', () => {
  const seen = [];
  const probe = {
    listDirectory: dir => { seen.push(['list', dir]); return ['v18.0.0', 'v20.1.0']; },
    firstExisting: candidates => { seen.push(['first', candidates]); return null; }
  };
  assert.equal(service(probe, { HOME: '/h', PATH: '/p1:/p2' }).resolveExecutable('claude'), 'claude');
  assert.deepEqual(seen[0], ['list', '/h/.nvm/versions/node']);
  assert.deepEqual(Array.from(seen[1][1]), [
    '/h/.local/bin/claude', '/h/.npm-global/bin/claude', '/h/.volta/bin/claude', '/h/.fnm/current/bin/claude',
    '/opt/homebrew/bin/claude', '/usr/local/bin/claude',
    '/h/.nvm/versions/node/v18.0.0/bin/claude', '/h/.nvm/versions/node/v20.1.0/bin/claude', '/p1/claude', '/p2/claude'
  ]);
  const found = { listDirectory: () => [], firstExisting: c => c[1] };
  assert.equal(service(found, { HOME: '/h', PATH: '' }).resolveExecutable('claude'), '/h/.npm-global/bin/claude');
});

test('probe: an explicit path is probed alone; nothing found falls back to the configured value; diagnostic reports missing', () => {
  const calls = [];
  const probe = { listDirectory: () => [], firstExisting: c => { calls.push(Array.from(c)); return null; } };
  const s = service(probe, { HOME: '/h', PATH: '/bin' }, '/opt/x/claude');
  assert.equal(s.resolveExecutable('/opt/x/claude'), '/opt/x/claude');
  assert.deepEqual(calls[0], ['/opt/x/claude']);
  assert.deepEqual({ ...s.diagnostic('/opt/x/claude') }, { executable: '/opt/x/claude', installed: false });
  const present = service({ listDirectory: () => [], firstExisting: c => c[0] }, { HOME: '/h', PATH: '' });
  assert.deepEqual({ ...present.diagnostic('claude') }, { executable: '/h/.local/bin/claude', installed: true });
});

test('shell probe: finds the first existing path, lists nvm-style directories, and treats failure as nothing', () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vam-probe-'));
  try {
    fs.mkdirSync(path.join(dir, 'v18')); fs.mkdirSync(path.join(dir, 'v20'));
    fs.writeFileSync(path.join(dir, 'with space'), '');
    assert.equal(shellExecutableProbe.firstExisting([path.join(dir, 'nope'), path.join(dir, 'with space'), path.join(dir, 'v18')]), path.join(dir, 'with space'));
    assert.equal(shellExecutableProbe.firstExisting([path.join(dir, 'nope')]), null);
    assert.equal(shellExecutableProbe.firstExisting([]), null);
    assert.deepEqual(Array.from(shellExecutableProbe.listDirectory(dir)), ['v18', 'v20', 'with space']);
    assert.deepEqual(Array.from(shellExecutableProbe.listDirectory(path.join(dir, 'missing'))), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('shell probe: a failing spawn reads as not found', () => {
  const { shellExecutableProbe: probe } = load('core/ai-runtime-service.ts', { 'node:child_process': { spawnSync: () => ({ error: new Error('ENOENT'), status: null }) } });
  assert.equal(probe.firstExisting(['/bin/sh']), null);
  assert.deepEqual(Array.from(probe.listDirectory('/')), []);
});

test('Codex image: a saved path is read through the injected local-file reader', async () => {
  const read = [];
  const reader = async p => { read.push(p); return new Uint8Array([137, 80, 78, 71]).buffer; };
  const { generatedImageDataUrl } = load('ai/runtime/codex-app-server.ts', {}, { btoa });
  assert.equal(await generatedImageDataUrl({ savedPath: '/tmp/a.png' }, reader), `data:image/png;base64,${Buffer.from([137, 80, 78, 71]).toString('base64')}`);
  assert.equal((await generatedImageDataUrl({ savedPath: '/tmp/a.JPG' }, reader)).startsWith('data:image/jpeg;base64,'), true);
  assert.deepEqual(read, ['/tmp/a.png', '/tmp/a.JPG']);
  await assert.rejects(generatedImageDataUrl({}, reader));
  await assert.rejects(generatedImageDataUrl({ savedPath: '/tmp/a.png' }));
});

test('stores: only <path>.tmp left by an interrupted write is recovered and kept by the next write', async () => {
  const errors = [];
  const logAdapter = memoryAdapter({ 'd/ai-exchanges.json.tmp': JSON.stringify([{ ...exchange, request: '', response: '', status: 'sent', error: '' }]) });
  const log = new AiExchangeLog(logAdapter, 'd/ai-exchanges.json', e => errors.push(e)); await log.load();
  assert.equal(log.getEntries().length, 1); assert.ok('d/ai-exchanges.json' in logAdapter.files); assert.equal('d/ai-exchanges.json.tmp' in logAdapter.files, false);
  log.begin({ ...exchange, id: '2' }); await log.flush();
  assert.deepEqual(JSON.parse(logAdapter.files['d/ai-exchanges.json']).map(e => e.id), ['1', '2']);
  const pendingAdapter = memoryAdapter({ 'd/p.json.tmp': JSON.stringify([['t.md', [suggestion]]]) });
  const pending = new PendingSuggestions(pendingAdapter, 'd/p.json', e => errors.push(e)); await pending.load();
  assert.equal(pending.get('t.md')[0].title, 'A');
  pending.set('u.md', [suggestion]); await pending.flush();
  assert.equal(JSON.parse(pendingAdapter.files['d/p.json']).length, 2);
  const broken = memoryAdapter({ 'd/p.json.tmp': '{broken' });
  const blocked = new PendingSuggestions(broken, 'd/p.json', e => errors.push(e)); await blocked.load();
  blocked.set('t.md', [suggestion]); await assert.rejects(blocked.flush());
  assert.equal(errors.length >= 2, true);
});

test('diagnostic: an unavailable probe (no /bin/sh) reports installed for explicit paths and bare names', () => {
  const dead = { available: () => false, listDirectory: () => [], firstExisting: () => null };
  assert.deepEqual({ ...service(dead, { HOME: '/h', PATH: '' }, 'C:\\tools\\claude.cmd').diagnostic('C:\\tools\\claude.cmd') }, { executable: 'C:\\tools\\claude.cmd', installed: true });
  assert.equal(service(dead, { HOME: '/h', PATH: '' }).diagnostic('claude').installed, true);
  assert.equal(service(dead, { HOME: '/h', PATH: '' }).resolveExecutable('claude'), 'claude');
  const live = { available: () => true, listDirectory: () => [], firstExisting: () => null };
  assert.equal(service(live, { HOME: '/h', PATH: '' }).diagnostic('claude').installed, false);
});

test('shell probe: reports unavailable when the shell cannot be spawned', () => {
  const { shellExecutableProbe: probe } = load('core/ai-runtime-service.ts', { 'node:child_process': { spawnSync: () => ({ error: new Error('ENOENT'), status: null }) } });
  assert.equal(probe.available(), false);
});
