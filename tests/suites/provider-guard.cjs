// Stub-mode fail-closed (HX-stubclose). A harness vault made with stubProviders points both provider paths at a guard shim,
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
  return { dir, bin, marker, vault: path.join(dir, 'vault') };
}
const settingsOf = vault => JSON.parse(fs.readFileSync(path.join(vault, '.obsidian/plugins/visual-agent-map/data.json'), 'utf8'));
const guardLog = vault => { const file = path.join(vault, '.obsidian/vam-provider-guard/calls.log'); return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''; };

test('stub mode points claude and codex at guard shims inside the test vault; live mode (default) leaves the settings alone', async () => {
  const { createTestVault } = await vaultLib();
  const box = sandbox();
  try {
    createTestVault({ vault: box.vault, profile: 'normal', stubProviders: true });
    const saved = settingsOf(box.vault);
    for (const key of ['claudePath', 'codexPath']) {
      assert.ok(path.isAbsolute(saved[key]) && saved[key].startsWith(box.vault), `${key} is a shim inside the vault: ${saved[key]}`);
      assert.ok(fs.statSync(saved[key]).mode & 0o100, `${key} is executable`);
    }
    // Onboarding has no other settings, but the guard still has to be there.
    createTestVault({ vault: path.join(box.dir, 'onboarding'), profile: 'onboarding', stubProviders: true });
    assert.ok(settingsOf(path.join(box.dir, 'onboarding')).codexPath);
    // Default: no guard, the plugin keeps resolving the real providers (live runs are not touched).
    createTestVault({ vault: path.join(box.dir, 'live'), profile: 'normal' });
    const live = settingsOf(path.join(box.dir, 'live'));
    assert.equal(live.codexPath, undefined); assert.equal(live.claudePath, undefined);
    assert.equal(fs.existsSync(path.join(box.dir, 'live', '.obsidian/vam-provider-guard')), false);
    createTestVault({ vault: path.join(box.dir, 'live-onboarding'), profile: 'onboarding' });
    assert.equal(fs.existsSync(path.join(box.dir, 'live-onboarding', '.obsidian/plugins/visual-agent-map/data.json')), false);
  } finally { fs.rmSync(box.dir, { recursive: true, force: true }); }
});

test('VAM_STUB_PROVIDERS=1 turns the guard on without an option', async () => {
  const { createTestVault } = await vaultLib();
  const box = sandbox();
  const before = process.env.VAM_STUB_PROVIDERS;
  try {
    process.env.VAM_STUB_PROVIDERS = '1';
    createTestVault({ vault: box.vault, profile: 'normal' });
    assert.ok(settingsOf(box.vault).codexPath.startsWith(box.vault));
  } finally {
    if (before === undefined) delete process.env.VAM_STUB_PROVIDERS; else process.env.VAM_STUB_PROVIDERS = before;
    fs.rmSync(box.dir, { recursive: true, force: true });
  }
});

integrationTest('an unstubbed provider call in stub mode throws naming the provider and the path, and never reaches a real provider', async () => {
  const { createTestVault } = await vaultLib();
  const box = sandbox();
  const beforePath = process.env.PATH;
  try {
    createTestVault({ vault: box.vault, profile: 'normal', stubProviders: true });
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

integrationTest('the guard shim exits non-zero and prints provider and arguments when run directly', async () => {
  const { createTestVault } = await vaultLib();
  const box = sandbox();
  try {
    createTestVault({ vault: box.vault, profile: 'normal', stubProviders: true });
    const saved = settingsOf(box.vault);
    const run = spawnSync(saved.codexPath, ['exec', 'hello'], { encoding: 'utf8', env: { PATH: `${box.bin}:/usr/bin:/bin` } });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /provider=codex/); assert.match(run.stderr, /exec hello/);
    assert.match(guardLog(box.vault), /^codex\texec hello/m);
    assert.equal(fs.existsSync(box.marker), false);
  } finally { fs.rmSync(box.dir, { recursive: true, force: true }); }
});
