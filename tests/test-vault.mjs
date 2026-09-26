import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { prepareTestVault, updateCurrentTestVault, verifyTestVault, root, main, sourceFingerprint, assertSourceUnchanged, prepareObsidianProfile, selectObsidianRuntime } from '../scripts/test-harness.mjs';

function environment(t) {
  const folder = mkdtempSync(join(tmpdir(), 'vam-harness-test-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  return { folder, vault: join(folder, 'current') };
}

test('canonical reset installs exact artifacts/settings/fixtures and detects tampering', t => {
  const { vault } = environment(t);
  const record = prepareTestVault({ vault });
  assert.equal(record.version, JSON.parse(readFileSync(join(root, 'manifest.json'))).version);
  const plugin = join(vault, '.obsidian/plugins/visual-agent-map');
  writeFileSync(join(vault, 'stale.md'), 'old fixture');
  writeFileSync(join(plugin, 'main.js'), 'stale build');
  assert.throws(() => verifyTestVault(vault), /hash mismatch/);
  prepareTestVault({ vault });
  assert.equal(existsSync(join(vault, 'stale.md')), false);
  assert.deepEqual(verifyTestVault(vault).hashes, record.hashes);
  writeFileSync(join(plugin, 'data.json'), '{}');
  assert.throws(() => verifyTestVault(vault), /Fixture\/settings/);
});

test('in-place plugin refresh updates only installed artifacts and preserves test-vault data', t => {
  const { vault } = environment(t); prepareTestVault({ vault });
  const plugin = join(vault, '.obsidian/plugins/visual-agent-map');
  const note = join(vault, 'Agent Workspace/Topics/Taiwan Travel Regression (zh-TW test fixture)/Notes/owner-test.md');
  const attachment = join(vault, 'Agent Workspace/Attachments/owner-test.bin');
  mkdirSync(join(vault, 'Agent Workspace/Topics/Taiwan Travel Regression (zh-TW test fixture)/Notes'), { recursive: true });
  mkdirSync(join(vault, 'Agent Workspace/Attachments'), { recursive: true });
  writeFileSync(note, '---\nuser: keep\n---\nKeep this note.'); writeFileSync(attachment, Buffer.from([0, 255, 3, 128]));
  writeFileSync(join(plugin, 'main.js'), 'stale plugin build');
  const updated = updateCurrentTestVault({ vault, source: { branch: 'codex/test-harness' } });
  assert.deepEqual(updated.hashes, verifyTestVault(vault).hashes);
  assert.equal(readFileSync(note, 'utf8'), '---\nuser: keep\n---\nKeep this note.');
  assert.deepEqual(readFileSync(attachment), Buffer.from([0, 255, 3, 128]));
  assert.equal(readFileSync(join(plugin, 'main.js'), 'utf8'), readFileSync(join(root, 'main.js'), 'utf8'));
});

test('in-place refresh upgrades an older owned test build without replacing vault data', t => {
  const { vault } = environment(t); prepareTestVault({ vault });
  const plugin = join(vault, '.obsidian/plugins/visual-agent-map');
  const recordPath = join(vault, '.vam-test-environment.json');
  const record = JSON.parse(readFileSync(recordPath, 'utf8'));
  const installed = JSON.parse(readFileSync(join(plugin, 'manifest.json'), 'utf8'));
  record.version = installed.version = '0.9.5';
  writeFileSync(recordPath, JSON.stringify(record));
  writeFileSync(join(plugin, 'manifest.json'), JSON.stringify(installed));
  const note = join(vault, 'keep.md'); writeFileSync(note, 'Keep existing content.');

  const updated = updateCurrentTestVault({ vault });

  assert.equal(updated.version, JSON.parse(readFileSync(join(root, 'manifest.json'))).version);
  assert.equal(JSON.parse(readFileSync(join(plugin, 'manifest.json'))).version, updated.version);
  assert.equal(readFileSync(note, 'utf8'), 'Keep existing content.');
});

test('in-place refresh refuses a stale ownership record that disagrees with the installed plugin', t => {
  const { vault } = environment(t); prepareTestVault({ vault });
  const recordPath = join(vault, '.vam-test-environment.json');
  const record = JSON.parse(readFileSync(recordPath, 'utf8'));
  record.version = '0.9.5'; writeFileSync(recordPath, JSON.stringify(record));
  const plugin = join(vault, '.obsidian/plugins/visual-agent-map'), mainPath = join(plugin, 'main.js');
  writeFileSync(mainPath, 'keep the existing build');
  assert.throws(() => updateCurrentTestVault({ vault }), /does not match the owned test-vault record/);
  assert.equal(readFileSync(mainPath, 'utf8'), 'keep the existing build');
});

test('in-place refresh refuses vaults owned by another checkout without changing data', t => {
  const { vault } = environment(t); prepareTestVault({ vault });
  const record = join(vault, '.vam-test-environment.json');
  const original = readFileSync(record, 'utf8'); writeFileSync(record, original.replace(root.replace(/\/$/, ''), '/another/checkout'));
  const plugin = join(vault, '.obsidian/plugins/visual-agent-map'), main = join(plugin, 'main.js');
  writeFileSync(main, 'keep the existing build');
  assert.throws(() => updateCurrentTestVault({ vault }), /another checkout/);
  assert.equal(readFileSync(main, 'utf8'), 'keep the existing build');
});

test('reset refuses unowned directories and symlinks without touching user data', t => {
  const { folder, vault } = environment(t);
  mkdirSync(vault); writeFileSync(join(vault, 'keep.md'), 'keep');
  assert.throws(() => prepareTestVault({ vault }), /unowned/);
  const link = join(folder, 'link'); symlinkSync(vault, link, 'dir');
  assert.throws(() => prepareTestVault({ vault: link }), /symlink/);
  assert.equal(readFileSync(join(vault, 'keep.md'), 'utf8'), 'keep');
});

test('invalid fixtures preserve the previous managed vault', t => {
  const { folder, vault } = environment(t);
  prepareTestVault({ vault }); writeFileSync(join(vault, 'keep.md'), 'keep');
  for (const options of [{ profile: 'invalid' }, { workspaceRoot: '../escape' }, { artifact: folder }]) {
    assert.throws(() => prepareTestVault({ vault, ...options }));
    assert.equal(readFileSync(join(vault, 'keep.md'), 'utf8'), 'keep');
  }
  verifyTestVault(vault);
});

test('onboarding is clean and reinstall preserves Markdown and attachment bytes without UI', t => {
  const { vault } = environment(t);
  prepareTestVault({ vault, profile: 'onboarding' });
  const plugin = join(vault, '.obsidian/plugins/visual-agent-map');
  assert.equal(existsSync(join(plugin, 'data.json')), false);
  assert.equal(existsSync(join(vault, 'Agent Workspace')), false);
  prepareTestVault({ vault, profile: 'reinstall' });
  const verify = phase => execFileSync(process.execPath, [join(root, 'scripts/verify-reinstall-test-vault.mjs'), vault, phase], { stdio: 'pipe' });
  rmSync(plugin, { recursive: true }); verify('uninstalled');
  mkdirSync(plugin);
  for (const name of ['main.js', 'manifest.json', 'styles.css']) copyFileSync(join(root, name), join(plugin, name));
  verify('reinstalled');
  writeFileSync(join(vault, 'Agent Workspace/Topics/Taiwan Travel Regression (zh-TW test fixture)/Map.md'), 'damaged');
  assert.throws(() => verify('reinstalled'));
});

test('unknown launch/profile options fail before executing build or opening Obsidian', () => {
  assert.throws(() => main(['--unexpected']), /Unknown argument/);
  assert.throws(() => main(['--profile=normal']), /requires/);
});

test('source fingerprint includes untracked inputs and rejects edits after build', t => {
  const { folder } = environment(t);
  const git = (...args) => execFileSync('git', args, { cwd: folder, stdio: 'pipe' });
  git('init'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'fixture');
  writeFileSync(join(folder, 'source.ts'), 'before');
  const fingerprint = sourceFingerprint(folder);
  assertSourceUnchanged(fingerprint, folder);
  writeFileSync(join(folder, 'main.js'), 'generated output');
  assertSourceUnchanged(fingerprint, folder);
  writeFileSync(join(folder, 'source.ts'), 'after');
  assert.throws(() => assertSourceUnchanged(fingerprint, folder), /Source changed/);
});

test('isolated app profile opens only the canonical vault without changing personal registration', t => {
  const { vault } = environment(t);
  prepareTestVault({ vault });
  const profile = prepareObsidianProfile(vault);
  const config = JSON.parse(readFileSync(join(profile, 'obsidian.json')));
  assert.equal(Object.keys(config.vaults).length, 1);
  assert.deepEqual(Object.values(config.vaults)[0], { path: vault, ts: 0, open: true });
  assert.equal(config.updateDisabled, true);
  assert.equal(config.cli, true, 'the isolated profile enables Obsidian CLI without changing personal settings');
});

test('harness stops at the first failing layer', t => {
  const { folder } = environment(t);
  const bin = join(folder, 'bin'); mkdirSync(bin);
  const log = join(folder, 'commands');
  writeFileSync(join(bin, 'npm'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$VAM_TEST_COMMAND_LOG"\n[ "$2" != "$VAM_FAIL_STAGE" ]\n', { mode: 0o755 });
  const stages = ['build', 'test:unit', 'test:integration'];
  for (const [index, stage] of stages.entries()) {
    writeFileSync(log, '');
    assert.throws(() => execFileSync(process.execPath, [join(root, 'scripts/test-harness.mjs')], {
      stdio: 'pipe', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, VAM_TEST_COMMAND_LOG: log, VAM_FAIL_STAGE: stage }
    }));
    assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), stages.slice(0, index + 1).map(value => `run ${value}`));
  }
});

test('isolated profile uses a compatible installed runtime, including updates outside the app bundle', t => {
  const { folder, vault } = environment(t);
  const archive = version => {
    const data = Buffer.from(JSON.stringify({ version }));
    const header = Buffer.from(JSON.stringify({ files: { 'package.json': { offset: '0', size: data.length } } }));
    const bytes = Buffer.alloc(16 + header.length + data.length);
    bytes.writeUInt32LE(8 + header.length, 4); bytes.writeUInt32LE(header.length, 12);
    header.copy(bytes, 16); data.copy(bytes, 16 + header.length);
    const file = join(folder, `obsidian-${version}.asar`); writeFileSync(file, bytes); return file;
  };
  const old = archive('1.12.7'), update = archive('1.13.7');
  assert.throws(() => selectObsidianRuntime('1.13.7', [old]), /No installed Obsidian/);
  const runtime = selectObsidianRuntime('1.13.7', [old, update]);
  assert.equal(runtime.version, '1.13.7');
  prepareTestVault({ vault });
  const profile = prepareObsidianProfile(vault, runtime);
  assert.deepEqual(readFileSync(join(profile, 'obsidian-1.13.7.asar')), readFileSync(update));
});
