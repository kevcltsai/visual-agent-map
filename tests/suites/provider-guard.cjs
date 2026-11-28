// Stub-mode fail-closed (HX-stubclose), on by default. Every harness vault points both provider paths at a guard shim,
// so a provider call that no stub caught fails loudly (and is logged) instead of reaching a real claude / codex.
// The "real" providers here are fake binaries on PATH that leave a marker when run: the markers must stay absent.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const { test, integrationTest, root, load } = require('../support.cjs');

const vaultLib = () => import(pathToFileURL(path.join(root, 'scripts', 'create-onboarding-test-vault.mjs')).href);

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vam-provider-guard-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const marker = path.join(dir, 'REAL-PROVIDER-RAN');
  for (const name of ['claude', 'codex']) fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${marker}"\nexit 0\n`, { mode: 0o755 });
const marked = box => fs.existsSync(box.marker) ? fs.readFileSync(box.marker, 'utf8') : '';
  return { dir, bin, marker, vault: path.join(dir, 'vault') };
}
const marked = box => fs.existsSync(box.marker) ? fs.readFileSync(box.marker, 'utf8') : '';
const settingsOf = vault => JSON.parse(fs.readFileSync(path.join(vault, '.obsidian/plugins/visual-agent-map/data.json'), 'utf8'));
const guardLog = vault => { const file = path.join(vault, '.obsidian/vam-provider-guard/calls.log'); return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''; };

test('every harness vault is fail-closed by default (no option, no env); only stubProviders:false opts out', async () => {
  const { createTestVault } = await vaultLib();
  const box = sandbox();
  const before = process.env.VAM_STUB_PROVIDERS;
  try {
    delete process.env.VAM_STUB_PROVIDERS;
    for (const profile of ['normal', 'onboarding', 'reinstall']) {
      const vault = path.join(box.dir, profile);
      createTestVault({ vault, profile });
      const saved = settingsOf(vault);
      for (const key of ['claudePath', 'codexPath']) {
        assert.ok(path.isAbsolute(saved[key]) && saved[key].startsWith(vault), `${profile} ${key} is a shim inside the vault: ${saved[key]}`);
        assert.ok(fs.statSync(saved[key]).mode & 0o100, `${key} is executable`);
      }
    }
    createTestVault({ vault: path.join(box.dir, 'open'), profile: 'normal', stubProviders: false });
    assert.equal(settingsOf(path.join(box.dir, 'open')).codexPath, undefined);
  } finally {
    if (before !== undefined) process.env.VAM_STUB_PROVIDERS = before;
    fs.rmSync(box.dir, { recursive: true, force: true });
  }
});

test('--live parsing: a model alone means claude, claude:<model> is the same, anything else is refused', async () => {
  const { parseLive } = await import(pathToFileURL(path.join(root, 'scripts', 'provider-guard.mjs')).href);
  assert.deepEqual({ ...parseLive('sonnet') }, { provider: 'claude', model: 'sonnet' });
  assert.deepEqual({ ...parseLive('claude:Sonnet') }, { provider: 'claude', model: 'sonnet' });
  for (const bad of ['codex:gpt-5', 'claude:', 'claude:a b', '']) assert.throws(() => parseLive(bad), /--live/);
});

test('the harness accepts --live only where it applies, and --update-current never takes it', async () => {
  const run = args => spawnSync(process.execPath, [path.join(root, 'scripts/test-harness.mjs'), ...args], { encoding: 'utf8' });
  assert.match(run(['--update-current', '--live=sonnet']).stderr, /--live applies only to --prepare/);
  assert.match(run(['--live=codex:gpt']).stderr, /only claude can be let through/);
  assert.match(run(['--session=x', '--stop', '--live=sonnet']).stderr, /Conflicting session options/);
  assert.match(run(['--session=x', '--reload', '--live=sonnet']).stderr, /--live cannot be combined with --reload/);
  assert.match(run(['--bogus']).stderr, /Unknown argument/);
});

integrationTest('(a) no --live: all three codex paths and claude are blocked; the error names provider and path; nothing real runs', async () => {
  const { createTestVault } = await vaultLib();
  const box = sandbox();
  const beforePath = process.env.PATH;
  try {
    createTestVault({ vault: box.vault, profile: 'normal' });
    const saved = settingsOf(box.vault);
    // The real providers would be found first on PATH (the bare names "claude" / "codex" are what a vault without the guard resolves).
    process.env.PATH = `${box.bin}:${beforePath}`;
    const { AiRuntimeService } = load('core/ai-runtime-service.ts');
    const service = new AiRuntimeService({ codexPath: () => saved.codexPath, claudePath: () => saved.claudePath, clientVersion: () => '1', onLog: () => {} });
    const plugin = path.join(box.vault, '.obsidian/plugins/visual-agent-map');
    const failure = async run => { try { await run(); } catch (error) { return String(error.message); } assert.fail('the unstubbed call did not throw'); };
    const codexRemote = await failure(() => service.codex(plugin, false).listModels());
    const codexLocal = await failure(() => service.codex(plugin, true).runTask('p', 'gpt', 'low', { type: 'object' }, {}));
    const claude = await failure(() => service.claude(plugin).runTask('p', 'sonnet', 'low', { type: 'object' }, {}));
    assert.match(codexRemote, /provider=codex/); assert.match(codexRemote, /app-server/);
    assert.match(codexLocal, /provider=codex/); assert.match(codexLocal, /web_search="disabled"/, 'the local (no web search) runtime is named by its args');
    assert.match(claude, /provider=claude/); assert.match(claude, /stream-json|--output-format|-p/);
    for (const message of [codexRemote, codexLocal, claude]) assert.match(message, /stub/i);
    const log = guardLog(box.vault);
    assert.equal(log.split('\n').filter(line => line.startsWith('codex\t')).length, 2, log);
    assert.equal(log.split('\n').filter(line => line.startsWith('claude\t')).length, 1, log);
    assert.equal(fs.existsSync(box.marker), false, 'no real provider binary ran');
    service.dispose();
  } finally { process.env.PATH = beforePath; fs.rmSync(box.dir, { recursive: true, force: true }); }
});

integrationTest('(b) --live=sonnet: only claude with a sonnet model gets through; other claude models and every codex path stay blocked', async () => {
  const { createTestVault } = await vaultLib();
  const { parseLive } = await import(pathToFileURL(path.join(root, 'scripts', 'provider-guard.mjs')).href);
  const box = sandbox();
  const beforePath = process.env.PATH;
  try {
    process.env.PATH = `${box.bin}:${beforePath}`;
    createTestVault({ vault: box.vault, profile: 'normal', live: parseLive('sonnet') });
    const saved = settingsOf(box.vault);
    const { AiRuntimeService } = load('core/ai-runtime-service.ts');
    const service = new AiRuntimeService({ codexPath: () => saved.codexPath, claudePath: () => saved.claudePath, clientVersion: () => '1', onLog: () => {} });
    const plugin = path.join(box.vault, '.obsidian/plugins/visual-agent-map');
    const attempt = async run => { try { await run(); return ''; } catch (error) { return String(error.message); } };
    // The fake claude prints nothing, so the runtime's own parse error is expected; what matters is that the real binary ran with the sonnet model.
    const sonnet = await attempt(() => service.claude(plugin).runTask('p', 'sonnet', 'low', { type: 'object' }, {}));
    assert.doesNotMatch(sonnet, /fail closed/, sonnet);
    assert.match(marked(box), /^claude .*--model sonnet/m, 'the PATH claude ran with model sonnet');
    const opus = await attempt(() => service.claude(plugin).runTask('p', 'opus', 'low', { type: 'object' }, {}));
    assert.match(opus, /provider=claude/); assert.match(opus, /only claude model sonnet/);
    const codex = [await attempt(() => service.codex(plugin, false).listModels()), await attempt(() => service.codex(plugin, true).runTask('p', 'gpt', 'low', { type: 'object' }, {})), await attempt(() => service.codex(plugin, false).runTask('p', 'gpt', 'low', { type: 'object' }, {}))];
    for (const message of codex) assert.match(message, /provider=codex/);
    assert.deepEqual(marked(box).trim().split('\n').filter(line => !line.startsWith('claude ')), [], 'no codex binary ran');
    assert.equal(marked(box).trim().split('\n').length, 1, 'the real claude ran exactly once (sonnet), opus never reached it');
    const log = guardLog(box.vault);
    assert.equal(log.split('\n').filter(line => line.startsWith('codex\t')).length, 3, log);
    assert.equal(log.split('\n').filter(line => line.startsWith('claude\t')).length, 1, log);
    service.dispose();
  } finally { process.env.PATH = beforePath; fs.rmSync(box.dir, { recursive: true, force: true }); }
});

integrationTest('the guard shim exits non-zero and prints provider and arguments when run directly', async () => {
  const { createTestVault } = await vaultLib();
  const box = sandbox();
  try {
    createTestVault({ vault: box.vault, profile: 'normal' });
    const saved = settingsOf(box.vault);
    const run = spawnSync(saved.codexPath, ['exec', 'hello'], { encoding: 'utf8', env: { PATH: `${box.bin}:/usr/bin:/bin` } });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /provider=codex/); assert.match(run.stderr, /exec hello/);
    assert.match(guardLog(box.vault), /^codex\texec hello/m);
    assert.equal(fs.existsSync(box.marker), false);
  } finally { fs.rmSync(box.dir, { recursive: true, force: true }); }
});
