import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import { canonicalVault, restorePreviousInstall, prepareTestVault, updateCurrentTestVault, verifyTestVault, sameRepoCleanMain, root, main, sourceFingerprint, assertSourceUnchanged, prepareObsidianProfile, selectObsidianRuntime, sessionVault, sessionVaultPrefix, ownerVaultPath, focusAction, whichInstalled, fetchDepsTable, reloadPluginExpression, reloadRunningPlugin } from '../scripts/test-harness.mjs';
import { ownerBusyReasons, waitOwnerIdle } from '../scripts/owner-idle.mjs';
import { policyAction, applyPolicy, policyExpression } from '../scripts/keep-background.mjs';

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

test('owner vault update neither seeds nor requires fixture maps; other vaults still do', t => {
  const { folder, vault } = environment(t);
  const fixtures = ['Topics/Local Source Fixture', 'Topics/Taiwan Travel Regression (zh-TW test fixture)'];
  prepareTestVault({ vault });
  for (const f of fixtures) rmSync(join(vault, 'Agent Workspace', f), { recursive: true, force: true });
  // Non-owner vault: verify still fails and update re-seeds the local-source fixture.
  assert.throws(() => verifyTestVault(vault), /Fixture\/settings/);
  assert.throws(() => updateCurrentTestVault({ vault }), /Fixture\/settings/);
  // Owner vault: update does not create fixtures and verify passes without them.
  const ownerFolder = join(folder, 'owner'); const owner = join(ownerFolder, 'current');
  prepareTestVault({ vault: owner });
  for (const f of fixtures) rmSync(join(owner, 'Agent Workspace', f), { recursive: true, force: true });
  writeFileSync(join(owner, '.obsidian/plugins/visual-agent-map/main.js'), 'stale plugin build');
  assert.throws(() => verifyTestVault(owner), /hash mismatch|Fixture\/settings/);
  updateCurrentTestVault({ vault: owner, owner, ownerIdleConfirmed: true });
  for (const f of fixtures) assert.equal(existsSync(join(owner, 'Agent Workspace', f)), false);
  verifyTestVault(owner, root, owner);
  assert.throws(() => verifyTestVault(owner), /Fixture\/settings/);
});

test('in-place refresh preserves complete user-modified source-selection fixtures', t => {
  const { vault } = environment(t); prepareTestVault({ vault });
  const fixture = join(vault, 'Agent Workspace/Topics/Local Source Fixture');
  const files = [join(fixture, 'Map.md'), join(fixture, 'Notes/alpha.md'), join(fixture, 'Notes/beta.md')];
  const contents = ['User map', 'User alpha note', 'User beta note'];
  files.forEach((path, index) => writeFileSync(path, contents[index]));

  updateCurrentTestVault({ vault });

  assert.deepEqual(files.map(path => readFileSync(path, 'utf8')), contents);
  assert.deepEqual(verifyTestVault(vault).hashes, JSON.parse(readFileSync(join(vault, '.vam-test-environment.json'), 'utf8')).hashes);
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
  assert.throws(() => updateCurrentTestVault({ vault }), /another checkout: \/another\/checkout \(branch unknown\)\. Run --update-current from that checkout/);
  assert.equal(readFileSync(main, 'utf8'), 'keep the existing build');
});

// Builds a real repo + worktree + origin so the same-repo rule runs against actual git state.
function repoWithWorktree(folder, { behind = false, dirty = false, ahead = false, edit = null, untracked = false } = {}) {
  const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const origin = join(folder, 'origin.git'), main = join(folder, 'main'), wt = join(folder, 'wt');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  mkdirSync(main); g(main, 'init', '-q', '-b', 'main'); g(main, 'config', 'user.email', 't@t'); g(main, 'config', 'user.name', 't');
  writeFileSync(join(main, 'a.txt'), '1'); g(main, 'add', 'a.txt'); g(main, 'commit', '-qm', 'one');
  g(main, 'remote', 'add', 'origin', origin); g(main, 'push', '-q', 'origin', 'main'); g(main, 'fetch', '-q', 'origin');
  g(main, 'worktree', 'add', '-q', '--detach', wt, 'origin/main');
  if (behind) { writeFileSync(join(main, 'a.txt'), '2'); g(main, 'commit', '-qam', 'two'); g(main, 'push', '-q', 'origin', 'main'); g(main, 'fetch', '-q', 'origin'); }
  if (dirty) writeFileSync(join(wt, 'a.txt'), 'edited');
  if (ahead) { writeFileSync(join(wt, 'a.txt'), 'exp'); g(wt, 'config', 'user.email', 't@t'); g(wt, 'config', 'user.name', 't'); g(wt, 'commit', '-qam', 'experiment'); }
  if (edit) writeFileSync(join(wt, edit), 'edited');
  if (untracked) writeFileSync(join(wt, 'new.tsx'), 'x');
  return { main, wt };
}
const vaultWithOwner = (vault, owner) => {
  prepareTestVault({ vault });
  const record = join(vault, '.vam-test-environment.json');
  writeFileSync(record, JSON.stringify({ ...JSON.parse(readFileSync(record, 'utf8')), owner }));
  const main = join(vault, '.obsidian/plugins/visual-agent-map/main.js');
  writeFileSync(main, 'keep the existing build');
  return main;
};

const sub = (folder, name) => { const d = join(folder, name); mkdirSync(d); return d; };

test('a same-repo worktree exactly at origin/main may update a vault owned by the main checkout', t => {
  const { folder } = environment(t); const { main, wt } = repoWithWorktree(folder);
  const vault = join(folder, 'v'); vaultWithOwner(vault, main);
  assert.equal(sameRepoCleanMain(main, wt), true);
});

test('only the generated main.js may differ from HEAD; styles.css is source', t => {
  const { folder } = environment(t);
  const base = (name, file) => { const r = repoWithWorktree(sub(folder, name)); writeFileSync(join(r.main, 'main.js'), '1'); writeFileSync(join(r.main, 'styles.css'), '1'); execFileSync('git', ['add', 'main.js', 'styles.css'], { cwd: r.main }); execFileSync('git', ['commit', '-qm', 'assets'], { cwd: r.main }); execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: r.main }); execFileSync('git', ['fetch', '-q', 'origin'], { cwd: r.main }); execFileSync('git', ['checkout', '-q', '--detach', 'origin/main'], { cwd: r.wt }); writeFileSync(join(r.wt, file), 'edited'); return r; };
  const js = base('g', 'main.js'), css = base('h', 'styles.css');
  assert.equal(sameRepoCleanMain(js.main, js.wt), true);
  assert.equal(sameRepoCleanMain(css.main, css.wt), false);
});

test('a same-repo worktree behind origin/main, edited, or a different repo is refused', t => {
  const { folder } = environment(t);
  const behind = repoWithWorktree(mkdirSync(join(folder, 'b'), { recursive: true }) ?? join(folder, 'b'), { behind: true });
  assert.equal(sameRepoCleanMain(behind.main, behind.wt), false);
  const dirty = repoWithWorktree(mkdirSync(join(folder, 'd'), { recursive: true }) ?? join(folder, 'd'), { dirty: true });
  assert.equal(sameRepoCleanMain(dirty.main, dirty.wt), false);
  const a = repoWithWorktree(mkdirSync(join(folder, 'x'), { recursive: true }) ?? join(folder, 'x'));
  const other = repoWithWorktree(mkdirSync(join(folder, 'y'), { recursive: true }) ?? join(folder, 'y'));
  assert.equal(sameRepoCleanMain(a.main, other.wt), false);
  assert.equal(sameRepoCleanMain('/does/not/exist', a.wt), false);
  const ahead = repoWithWorktree(sub(folder, 'e'), { ahead: true });
  assert.equal(sameRepoCleanMain(ahead.main, ahead.wt), false);
  const untracked = repoWithWorktree(sub(folder, 'f'), { untracked: true });
  assert.equal(sameRepoCleanMain(untracked.main, untracked.wt), false);
});

test('the refusal names the branch the owning checkout is on', t => {
  const { folder, vault } = environment(t); prepareTestVault({ vault });
  const owner = join(folder, 'owner');
  mkdirSync(owner); execFileSync('git', ['init', '-q', '-b', 'fix/someone-else', owner]);
  const record = join(vault, '.vam-test-environment.json');
  writeFileSync(record, JSON.stringify({ ...JSON.parse(readFileSync(record, 'utf8')), owner }));
  assert.throws(() => updateCurrentTestVault({ vault }), /owner \(on branch fix\/someone-else\)/);
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

test('reset never replaces the owner testing vault; it is only updated in place', t => {
  // Only exercised where the testing vault exists, so the test can never create or remove it.
  if (!existsSync(canonicalVault)) return t.skip('no testing vault on this machine');
  const before = readdirSync(canonicalVault).sort();
  for (const profile of ['normal', 'onboarding', 'reinstall'])
    assert.throws(() => prepareTestVault({ vault: canonicalVault, profile }), /owner's testing vault/);
  assert.deepEqual(readdirSync(canonicalVault).sort(), before);
});

test('session vaults get their own path, refuse reserved names and bad options before building', () => {
  assert.equal(sessionVault('md-rich-syntax'), `${sessionVaultPrefix}md-rich-syntax`);
  for (const name of ['', 'Upper', 'has space', '../escape', '-lead', 'x'.repeat(33)]) assert.throws(() => sessionVault(name), /lowercase letters/);
  for (const name of ['current', 'smoke']) assert.throws(() => sessionVault(name), /reserved/);
  assert.throws(() => main(['--session=current']), /reserved/);
  assert.throws(() => main(['--session=a', '--ui']), /cannot be combined/);
  assert.throws(() => main(['--session=a', '--update-current']), /cannot be combined/);
});

test('session app profiles disable the CLI so a shared CLI socket never drives the wrong vault', t => {
  const { vault } = environment(t);
  prepareTestVault({ vault });
  const config = JSON.parse(readFileSync(join(prepareObsidianProfile(vault, undefined, { cli: false }), 'obsidian.json')));
  assert.equal(config.cli, false);
  assert.equal(Object.keys(config.vaults).length, 1);
});

test('owner vault is outside the temp session prefix, shared by worktrees, and overridable', () => {
  assert.ok(!canonicalVault.startsWith(sessionVaultPrefix));
  assert.ok(!canonicalVault.startsWith('/private/tmp/'));
  assert.equal(canonicalVault, ownerVaultPath(root, {}));
  assert.equal(ownerVaultPath(root, { VAM_OWNER_VAULT: '/somewhere/else' }), '/somewhere/else');
  assert.equal(ownerVaultPath(root, {}).endsWith(join('vaults', 'vam-e2e-current')), true);
  const main = execFileSync('git', ['-C', root, 'rev-parse', '--git-common-dir'], { encoding: 'utf8' }).trim();
  assert.equal(canonicalVault, join(dirname(dirname(resolve(root, main))), 'vaults', 'vam-e2e-current'));
  assert.equal(ownerVaultPath(join(root, 'scripts'), {}), canonicalVault);
});

const focusOwner = { pid: 10, path: '/Applications/Terminal.app' };
const focusBase = { instancePid: 99, ownerApp: focusOwner, allowFocus: false };
const obsidianPath = '/Applications/Obsidian.app';

test('focusAction reopens the recorded owner app when the test instance stole the foreground', () => {
  assert.deepEqual(focusAction({ ...focusBase, frontPid: 99, frontPath: obsidianPath }), { ownerApp: focusOwner, reopen: true });
});

test('focusAction remembers a non-test foreground app as the owner app without reopening', () => {
  assert.deepEqual(focusAction({ ...focusBase, ownerApp: null, frontPid: 11, frontPath: '/Applications/Safari.app' }), { ownerApp: { pid: 11, path: '/Applications/Safari.app' }, reopen: false });
  assert.deepEqual(focusAction({ ...focusBase, frontPid: NaN, frontPath: undefined }), { ownerApp: focusOwner, reopen: false });
});

test('focusAction does not reopen when the owner\'s own Obsidian (same bundle, other pid) is in front', () => {
  assert.equal(focusAction({ ...focusBase, frontPid: 50, frontPath: obsidianPath }).reopen, false);
});

test('focusAction does not reopen and keeps the owner app when another test instance is in front', () => {
  assert.deepEqual(focusAction({ ...focusBase, testPids: [99, 77], frontPid: 77, frontPath: obsidianPath }), { ownerApp: focusOwner, reopen: false });
});

test('focusAction clears the owner app instead of reopening when the owner app has quit', () => {
  assert.deepEqual(focusAction({ ...focusBase, ownerAlive: false, frontPid: 99, frontPath: obsidianPath }), { ownerApp: null, reopen: false });
});

test('focusAction never reopens when the recorded owner app is the Obsidian bundle', () => {
  const ownObsidian = { pid: 50, path: obsidianPath };
  assert.deepEqual(focusAction({ ...focusBase, ownerApp: ownObsidian, obsidianPath, frontPid: 99, frontPath: obsidianPath }), { ownerApp: ownObsidian, reopen: false });
});

test('focusAction with allow-focus does not reopen and keeps the recorded owner app', () => {
  assert.deepEqual(focusAction({ ...focusBase, allowFocus: true, frontPid: 99, frontPath: obsidianPath }), { ownerApp: focusOwner, reopen: false });
});

test('focusAction does not reopen when no owner app was recorded', () => {
  assert.deepEqual(focusAction({ ...focusBase, ownerApp: null, frontPid: 99, frontPath: obsidianPath }), { ownerApp: null, reopen: false });
});

// Prevention (activation policy) decisions; the real macOS effect is checked by the UI sampling in the task handoff.
const policyProfile = '/private/tmp/vam-e2e-x/.vam-app';

test('policyAction prohibits activation for a harness profile and goes back to regular when allow-focus exists', () => {
  assert.equal(policyAction({ appProfile: policyProfile, portFileExists: true, allowFocus: false }), 'prohibited');
  assert.equal(policyAction({ appProfile: policyProfile, portFileExists: true, allowFocus: true }), 'regular');
  assert.equal(policyAction({ appProfile: policyProfile, portFileExists: true, allowFocus: true, applied: 'regular' }), null);
  assert.equal(policyAction({ appProfile: policyProfile, portFileExists: true, allowFocus: false, applied: 'regular' }), 'prohibited');
});

test('policyAction never targets a non-harness profile or an instance without a DevToolsActivePort', () => {
  assert.equal(policyAction({ appProfile: policyProfile, portFileExists: false }), null);
  assert.equal(policyAction({ appProfile: '/Users/someone/Library/Application Support/obsidian', portFileExists: true }), null);
  assert.equal(policyAction({ appProfile: undefined, portFileExists: true }), null);
});

test('applyPolicy evaluates the requested policy and reports failure instead of throwing', async () => {
  const calls = [];
  const fake = { evaluate: async expression => { calls.push(expression); }, close: () => calls.push('close') };
  assert.equal(await applyPolicy(policyProfile, 'prohibited', async vault => { calls.push(vault); return fake; }), true);
  assert.deepEqual(calls, ['/private/tmp/vam-e2e-x', policyExpression('prohibited'), 'close']);
  assert.equal(await applyPolicy(policyProfile, 'prohibited', async () => { throw new Error('no port'); }), false);
  assert.equal(await applyPolicy(policyProfile, 'prohibited', async () => ({ evaluate: async () => { throw new Error('eval failed'); }, close() {} })), false);
  assert.equal(await applyPolicy(policyProfile, 'prohibited', () => new Promise(() => {}), 50), false);
});

test('new test vaults write appearance.json with native menus off', t => {
  const { vault } = environment(t); prepareTestVault({ vault });
  assert.deepEqual(JSON.parse(readFileSync(join(vault, '.obsidian/appearance.json'), 'utf8')), { nativeMenus: false });
});

test('in-place refresh turns native menus off for session vaults only when unset, keeping other keys', t => {
  const { folder, vault } = environment(t);
  const appearance = join(vault, '.obsidian/appearance.json');
  const read = () => JSON.parse(readFileSync(appearance, 'utf8'));
  prepareTestVault({ vault });
  rmSync(appearance); updateCurrentTestVault({ vault });
  assert.deepEqual(read(), { nativeMenus: false });
  writeFileSync(appearance, '{"theme":"system"}'); updateCurrentTestVault({ vault });
  assert.deepEqual(read(), { theme: 'system', nativeMenus: false });
  writeFileSync(appearance, '{"nativeMenus":true,"theme":"moonstone"}'); updateCurrentTestVault({ vault });
  assert.deepEqual(read(), { nativeMenus: true, theme: 'moonstone' });
  // Owner vault: appearance.json stays byte-identical (and is not created when absent).
  const owner = join(folder, 'owner', 'current'); prepareTestVault({ vault: owner });
  const ownerAppearance = join(owner, '.obsidian/appearance.json');
  writeFileSync(ownerAppearance, '{"theme":"system"}');
  const before = readFileSync(ownerAppearance);
  updateCurrentTestVault({ vault: owner, owner, ownerIdleConfirmed: true });
  assert.deepEqual(readFileSync(ownerAppearance), before);
  rmSync(ownerAppearance); updateCurrentTestVault({ vault: owner, owner, ownerIdleConfirmed: true });
  assert.equal(existsSync(ownerAppearance), false);
});

// Owner-idle install guard (scripts/owner-idle.mjs): every refusal condition and the matching allowed case, on fixture vaults.
const NOW = Date.parse('2026-11-15T02:00:00.000Z');
const ago = minutes => new Date(NOW - minutes * 60000).toISOString();
function busyVault(t, { records = { 'Mind Maps/甲': { '20261115-010000-aaaaaa': [] } }, exchanges = [{ startedAt: ago(120), completedAt: ago(119) }] } = {}) {
  const { vault } = environment(t);
  for (const [map, files] of Object.entries(records)) {
    const dir = join(vault, 'Agent Workspace', map, 'Chats/records'); mkdirSync(dir, { recursive: true });
    for (const [name, lines] of Object.entries(files)) writeFileSync(join(dir, `${name}.jsonl`), [{ v: 1, type: 'conversation', id: name }, ...lines].map(line => typeof line === 'string' ? line : JSON.stringify(line)).join('\n') + '\n');
  }
  const plugin = join(vault, '.obsidian/plugins/visual-agent-map'); mkdirSync(plugin, { recursive: true });
  if (exchanges !== 'missing') writeFileSync(join(plugin, 'ai-exchanges.json'), typeof exchanges === 'string' ? exchanges : JSON.stringify(exchanges));
  return vault;
}
const start = (turn, minutes, extra = {}) => ({ v: 1, type: 'turn_start', turn, message: 'x', at: ago(minutes), ...extra });
const end = (turn, status, minutes) => ({ v: 1, type: 'turn_end', turn, status, at: ago(minutes) });
const one = lines => ({ records: { 'Mind Maps/甲': { '20261115-010000-aaaaaa': lines } } });
const reasons = (t, setup) => ownerBusyReasons(busyVault(t, setup), { now: NOW });

test('owner-idle guard: idle vault passes; a finished chain and an applied plan pass', t => {
  assert.deepEqual(reasons(t, one([start(1, 60), end(1, 'done', 59), start(2, 59, { auto: true, round: 2 }), end(2, 'plan', 58), { v: 1, type: 'plan', turn: 2, state: 'applied', at: ago(57) }, { v: 1, type: 'event', turn: 2, kind: 'chain_end', reason: 'done', at: ago(57) }])), []);
  assert.deepEqual(reasons(t, { records: {} }), []);
});

test('owner-idle guard: a plan nobody applied or cancelled refuses; applied, cancelled or chain_end after it passes', t => {
  const pending = [start(1, 60), end(1, 'plan', 59)];
  assert.match(reasons(t, one(pending)).join('\n'), /甲：最後一輪（第 1 輪）有待套用的計畫/);
  for (const state of ['applied', 'cancelled', 'stopped']) assert.deepEqual(reasons(t, one([...pending, { v: 1, type: 'plan', turn: 1, state, at: ago(58) }])), []);
  assert.deepEqual(reasons(t, one([...pending, { v: 1, type: 'event', turn: 1, kind: 'chain_end', reason: 'plan_cancelled', at: ago(58) }])), []);
  // Only the newest conversation of a map decides: an older one left on a plan does not refuse.
  assert.deepEqual(reasons(t, { records: { 'Mind Maps/甲': { '20261114-010000-old000': pending, '20261115-010000-new000': [start(1, 50), end(1, 'done', 49)] } } }), []);
  // Every map counts.
  assert.match(reasons(t, { records: { 'Mind Maps/甲': { '20261115-010000-aaaaaa': [] }, 'Topics/乙': { '20261115-010000-bbbbbb': pending } } }).join('\n'), /乙：最後一輪/);
});

test('owner-idle guard: an automatic continuation with no chain_end refuses; chain_end or a later user turn passes', t => {
  const running = [start(1, 60), end(1, 'done', 59), start(2, 59, { auto: true, round: 2 })];
  assert.match(reasons(t, one(running)).join('\n'), /自動接續還在跑（第 2 輪/);
  assert.match(reasons(t, one([...running, end(2, 'done', 40)])).join('\n'), /自動接續還在跑/);
  assert.deepEqual(reasons(t, one([...running, end(2, 'done', 40), { v: 1, type: 'event', turn: 2, kind: 'chain_end', reason: 'done', at: ago(40) }])), []);
  assert.deepEqual(reasons(t, one([...running, end(2, 'done', 40), start(3, 30), end(3, 'done', 29)])), []);
});

test('owner-idle guard: a turn_start or an AI call in the last 15 minutes refuses; 16 minutes ago passes', t => {
  assert.match(reasons(t, one([start(1, 10), end(1, 'done', 9)])).join('\n'), /剛開始一輪對話（15 分鐘內）/);
  assert.deepEqual(reasons(t, one([start(1, 16), end(1, 'done', 15.5)])), []);
  // An older conversation written in the window still counts.
  assert.match(reasons(t, { records: { 'Mind Maps/甲': { '20261114-000000-old000': [start(1, 5)], '20261115-010000-new000': [] } } }).join('\n'), /15 分鐘內/);
  assert.match(reasons(t, { exchanges: [{ startedAt: ago(200) }, { startedAt: ago(14), completedAt: ago(13) }] }).join('\n'), /ai-exchanges\.json：.*有 AI 呼叫/);
  assert.match(reasons(t, { exchanges: [{ startedAt: ago(20) }, { startedAt: ago(16), sentAt: ago(16) }, { startedAt: ago(30), completedAt: ago(5) }] }).join('\n'), /有 AI 呼叫/);
  assert.deepEqual(reasons(t, { exchanges: [{ startedAt: ago(20), completedAt: ago(16) }] }), []);
  assert.deepEqual(reasons(t, { exchanges: [] }), []);
});

test('owner-idle guard: a turn or an AI call still running (no end, under 60 minutes) refuses; an older leftover passes', t => {
  assert.match(reasons(t, one([start(1, 20)])).join('\n'), /第 1 輪（.*開始）還沒結束/);
  assert.deepEqual(reasons(t, one([start(1, 61)])), []);
  assert.match(reasons(t, { exchanges: [{ startedAt: ago(20), sentAt: ago(20) }] }).join('\n'), /開始的 AI 呼叫還沒結束/);
  assert.deepEqual(reasons(t, { exchanges: [{ startedAt: ago(61), sentAt: ago(61) }] }), []);
});

test('owner-idle --wait-idle: re-checks while busy, returns once idle, refuses after the timeout', t => {
  // A turn that started 10 minutes before NOW stops counting 15 minutes after it started, i.e. 5 minutes later.
  const vault = busyVault(t, one([start(1, 10), end(1, 'done', 9)]));
  let clock = NOW; const slept = []; const out = [];
  waitOwnerIdle(vault, { clock: () => clock, sleep: ms => { slept.push(ms); clock += ms; }, out: text => out.push(text) });
  assert.equal(slept.length, 6);
  assert.equal(out.length, 1, 'the same reasons are printed once');
  clock = NOW; slept.length = 0;
  assert.throws(() => waitOwnerIdle(busyVault(t, one([start(1, 60), end(1, 'plan', 59)])), { clock: () => clock, sleep: ms => { slept.push(ms); clock += ms; }, out: () => {}, timeoutMs: 3 * 60000 }), /Refusing to install[\s\S]*待套用的計畫/);
  assert.equal(slept.length, 3);
});

test('owner-idle guard: anything it cannot read refuses', t => {
  assert.match(reasons(t, one(['{not json'])).join('\n'), /格式不對/);
  assert.match(reasons(t, one([{ v: 1, type: 'turn_start', turn: 1 }])).join('\n'), /沒有可讀的時間/);
  assert.match(reasons(t, { exchanges: 'missing' }).join('\n'), /檔案不存在/);
  assert.match(reasons(t, { exchanges: '{"a":1}' }).join('\n'), /not a list/);
  assert.match(reasons(t, { exchanges: '[{"startedAt":' }).join('\n'), /判斷不出狀態/);
  assert.match(reasons(t, { exchanges: [{ id: 'no time' }] }).join('\n'), /no readable time/);
  assert.match(ownerBusyReasons(join(tmpdir(), 'vam-no-such-vault-owner-idle'), { now: NOW }).join('\n'), /無法讀取 vault/);
});

test('owner-idle guard: updating the owner vault refuses while busy and leaves main.js; --owner-idle-confirmed installs', t => {
  const { folder } = environment(t);
  const owner = join(folder, 'owner', 'current'); prepareTestVault({ vault: owner });
  const plugin = join(owner, '.obsidian/plugins/visual-agent-map');
  const dir = join(owner, 'Agent Workspace/Mind Maps/甲/Chats/records'); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '20261115-010000-aaaaaa.jsonl'), [start(1, 60), end(1, 'plan', 59)].map(l => JSON.stringify(l)).join('\n'));
  writeFileSync(join(plugin, 'ai-exchanges.json'), JSON.stringify([{ startedAt: ago(120) }]));
  writeFileSync(join(plugin, 'main.js'), 'stale plugin build');
  assert.throws(() => updateCurrentTestVault({ vault: owner, owner, now: NOW }), /Refusing to install into the owner's vault[\s\S]*待套用的計畫[\s\S]*--owner-idle-confirmed/);
  assert.equal(readFileSync(join(plugin, 'main.js'), 'utf8'), 'stale plugin build');
  // The owner applied the plan: the same update goes through.
  writeFileSync(join(dir, '20261115-010000-aaaaaa.jsonl'), [start(1, 60), end(1, 'plan', 59), { v: 1, type: 'plan', turn: 1, state: 'applied', at: ago(58) }].map(l => JSON.stringify(l)).join('\n'));
  updateCurrentTestVault({ vault: owner, owner, now: NOW });
  assert.equal(readFileSync(join(plugin, 'main.js'), 'utf8'), readFileSync(join(root, 'main.js'), 'utf8'));
  // Busy again, but the owner said 「可以裝」.
  writeFileSync(join(plugin, 'ai-exchanges.json'), JSON.stringify([{ startedAt: ago(1) }]));
  writeFileSync(join(plugin, 'main.js'), 'stale plugin build');
  assert.throws(() => updateCurrentTestVault({ vault: owner, owner, now: NOW }), /有 AI 呼叫/);
  updateCurrentTestVault({ vault: owner, owner, now: NOW, ownerIdleConfirmed: true });
  assert.equal(readFileSync(join(plugin, 'main.js'), 'utf8'), readFileSync(join(root, 'main.js'), 'utf8'));
  // A session vault is never checked.
  const { vault } = environment(t); prepareTestVault({ vault });
  writeFileSync(join(vault, '.obsidian/plugins/visual-agent-map/ai-exchanges.json'), JSON.stringify([{ startedAt: ago(1) }]));
  updateCurrentTestVault({ vault, now: NOW });
});

test('--owner-idle-confirmed only goes with --update-current; --which-installed stands alone and names the installed commit', t => {
  assert.throws(() => main(['--owner-idle-confirmed']), /applies only to --update-current/);
  assert.throws(() => main(['--wait-idle']), /--wait-idle applies only/);
  assert.throws(() => main(['--update-current', '--owner-idle-confirmed', '--wait-idle']), /--wait-idle applies only/);
  assert.throws(() => main(['--prepare', '--owner-idle-confirmed']), /cannot be combined|applies only/);
  assert.throws(() => main(['--which-installed', '--ui']), /takes no other options/);
  const { vault } = environment(t);
  prepareTestVault({ vault, source: { branch: 'main', commit: 'abc1234deadbeef', status: '' } });
  const text = whichInstalled(vault);
  assert.match(text, /commit: abc1234deadbeef\n/);
  assert.match(text, /branch at install: main/);
  writeFileSync(join(vault, '.obsidian/plugins/visual-agent-map/main.js'), 'hand edited');
  assert.match(whichInstalled(vault), /commit: unknown \(main\.js changed after the recorded install\)/);
});

test('fetchDepsTable fetches the latest green full main run once and fails soft', t => {
  const { folder } = environment(t);
  const calls = [];
  const fake = (command, args) => {
    calls.push([command, ...args]);
    if (args[1] === 'list') return 'noise\n111\n222\n';
    writeFileSync(join(args[args.indexOf('-D') + 1], 'test-deps.json'), '{"fetched":true}');
  };
  assert.equal(fetchDepsTable(folder, fake), true);
  assert.equal(readFileSync(join(folder, 'test-deps.json'), 'utf8'), '{"fetched":true}');
  assert.deepEqual(calls[1].slice(0, 5), ['gh', 'run', 'download', '111', '-n']);
  assert.equal(fetchDepsTable(folder, () => { throw new Error('must not run'); }), false); // table already present
  rmSync(join(folder, 'test-deps.json'));
  assert.equal(fetchDepsTable(folder, () => { throw new Error('gh missing'); }), false);
  assert.equal(existsSync(join(folder, 'test-deps.json')), false);
  assert.equal(fetchDepsTable(folder, () => ''), false); // no green full run
});

test('a refresh that fails part-way puts back the replaced artifacts and the ownership record', t => {
  const { folder } = environment(t);
  const plugin = join(folder, 'plugin'), staging = join(folder, 'staging');
  mkdirSync(plugin); mkdirSync(staging);
  const recordPath = join(plugin, '.vam-test-environment.json');
  writeFileSync(join(plugin, 'main.js'), 'new main'); writeFileSync(join(plugin, 'styles.css'), 'new css'); writeFileSync(recordPath, 'new record');
  writeFileSync(join(staging, 'main.js.previous'), 'old main'); writeFileSync(join(staging, 'styles.css.previous'), 'old css');
  restorePreviousInstall({ staging, plugin, replaced: ['main.js'], recordPath });
  assert.equal(readFileSync(join(plugin, 'main.js'), 'utf8'), 'old main', 'a replaced artifact comes back');
  assert.equal(readFileSync(join(plugin, 'styles.css'), 'utf8'), 'new css', 'one that was never replaced is left alone');
  assert.equal(readFileSync(recordPath, 'utf8'), 'new record', 'no record copy in staging: the record stays');
  writeFileSync(join(staging, '.vam-test-environment.json.previous'), 'old record');
  restorePreviousInstall({ staging, plugin, replaced: [], recordPath });
  assert.equal(readFileSync(recordPath, 'utf8'), 'old record');
});

test('an unreadable appearance.json stops a refresh before any installed file or the record changes', t => {
  const { vault } = environment(t); prepareTestVault({ vault });
  const plugin = join(vault, '.obsidian/plugins/visual-agent-map');
  writeFileSync(join(vault, '.obsidian/appearance.json'), '{ not json');
  writeFileSync(join(plugin, 'main.js'), 'stale plugin build');
  const record = readFileSync(join(vault, '.vam-test-environment.json'), 'utf8');
  assert.throws(() => updateCurrentTestVault({ vault }));
  assert.equal(readFileSync(join(plugin, 'main.js'), 'utf8'), 'stale plugin build');
  assert.equal(readFileSync(join(vault, '.vam-test-environment.json'), 'utf8'), record);
  assert.deepEqual(readdirSync(plugin).filter(name => name.startsWith('.vam-update-')), [], 'no staging left behind');
});

// The owner's 2026-11-22 book ran a days-old build: --update-current replaced the files while Obsidian was open and never reloaded the plugin.
test('a running Obsidian is made to load the new build: the plugin is disabled and enabled (enabled list untouched), a stale instance or a switched-off plugin is reported', async () => {
  const fakeApp = (enabled, loads = true) => {
    const calls = [];
    const plugins = { enabledPlugins: new Set(enabled ? ['visual-agent-map'] : []), plugins: enabled ? { 'visual-agent-map': { manifest: { version: '0.34.0' } } } : {} };
    plugins.disablePlugin = async id => { calls.push(`disable ${id}`); delete plugins.plugins[id]; };
    plugins.enablePlugin = async id => { calls.push(`enable ${id}`); plugins.plugins[id] = loads ? { manifest: { version: '0.34.0' } } : undefined; };
    plugins.disablePluginAndSave = plugins.enablePluginAndSave = async () => calls.push('saved');
    return { app: { plugins }, calls };
  };
  const connect = fake => async () => ({ evaluate: expression => vm.runInNewContext(expression, { app: fake.app }), close() {} });
  const live = fakeApp(true);
  assert.deepEqual({ ...(await reloadRunningPlugin('/v', '0.34.0', connect(live))) }, { enabled: true, reloaded: true, version: '0.34.0' });
  assert.deepEqual(live.calls, ['disable visual-agent-map', 'enable visual-agent-map'], 'the plugin is reloaded; the saved enabled list is never written');
  await assert.rejects(reloadRunningPlugin('/v', '0.34.0', connect(fakeApp(true, false))), /old plugin is still running|did not load it/);
  await assert.rejects(reloadRunningPlugin('/v', '0.35.0', connect(fakeApp(true))), /did not load it/, 'a version other than the installed one is not taken as loaded');
  const off = fakeApp(false);
  assert.equal((await reloadRunningPlugin('/v', '0.34.0', connect(off))).enabled, false);
  assert.deepEqual(off.calls, [], 'a plugin the owner switched off is left off');
  assert.doesNotMatch(reloadPluginExpression, /AndSave|focus|activate/);
});
