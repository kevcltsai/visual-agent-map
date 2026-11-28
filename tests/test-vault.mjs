import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import { canonicalVault, restorePreviousInstall, prepareTestVault, updateCurrentTestVault, verifyTestVault, sameRepoCleanMain, assertContainsOriginMain, root, main, sourceFingerprint, assertSourceUnchanged, prepareObsidianProfile, ensureSessionProfile, selectObsidianRuntime, sessionVault, sessionVaultPrefix, ownerVaultPath, focusAction, whichInstalled, runHarnessCli, greenInstallRun, prepareSessionCandidate, assertSessionOwner, withSessionLock, sessionDisableExpression, reloadSessionVault, reloadPluginExpression, reloadRunningPlugin, ensureTestApp, testAppBundleId, launchArgs } from '../scripts/test-harness.mjs';
import { fetchDepsTable, refreshDepsTable } from '../scripts/test-affected.mjs';
import { typecheckArgs } from '../scripts/build-product.mjs';
import { viewerCacheEnabled, viewerInputs, viewerCacheKey, viewerCacheHit, readViewerCache, saveViewerCache } from '../scripts/viewer-cache.mjs';
import { generatedConflictPlan } from '../scripts/resolve-generated-conflicts.mjs';
import { matchingEvidence, recordDevEvent } from '../scripts/dev-metrics.mjs';
import { ownerBusyReasons, waitOwnerIdle } from '../scripts/owner-idle.mjs';
import { policyAction, applyPolicy, policyExpression, parseFrontApp } from '../scripts/keep-background.mjs';

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

test('--update-current on the owner vault never writes or changes codexPath / claudePath (the stub guard is not applied)', t => {
  const { folder } = environment(t);
  const owner = join(folder, 'owner', 'current');
  prepareTestVault({ vault: owner });
  const file = join(owner, '.obsidian/plugins/visual-agent-map/data.json');
  const saved = JSON.parse(readFileSync(file, 'utf8')); delete saved.codexPath; delete saved.claudePath;
  writeFileSync(file, JSON.stringify(saved, null, 2));
  rmSync(join(owner, '.obsidian/vam-provider-guard'), { recursive: true });
  const before = readFileSync(file, 'utf8');
  writeFileSync(join(owner, '.obsidian/plugins/visual-agent-map/main.js'), 'stale plugin build');
  updateCurrentTestVault({ vault: owner, owner, ownerIdleConfirmed: true });
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.equal(existsSync(join(owner, '.obsidian/vam-provider-guard')), false);
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

test('--update-current refuses a candidate that does not contain origin/main, after fetching origin', t => {
  const { folder } = environment(t);
  const behind = repoWithWorktree(sub(folder, 'b'), { behind: true });
  assert.throws(() => assertContainsOriginMain(behind.wt), /does not contain origin\/main.*git fetch origin && git rebase origin\/main/s);
  const ahead = repoWithWorktree(sub(folder, 'a'), { ahead: true });
  assert.doesNotThrow(() => assertContainsOriginMain(ahead.wt));
  const same = repoWithWorktree(sub(folder, 's'));
  assert.doesNotThrow(() => assertContainsOriginMain(same.main));
  // origin moves on without a local fetch: the check must fetch, not trust the stale origin/main ref.
  const stale = repoWithWorktree(sub(folder, 'f')), other = join(folder, 'f', 'other');
  execFileSync('git', ['clone', '-q', join(folder, 'f', 'origin.git'), other]);
  writeFileSync(join(other, 'a.txt'), 'new'); execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'new'], { cwd: other }); execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: other });
  assert.throws(() => assertContainsOriginMain(stale.wt), /does not contain origin\/main/);
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
  // Onboarding has no user settings; the only thing in data.json is the stub-mode provider guard.
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(plugin, 'data.json'), 'utf8'))).sort(), ['claudePath', 'codexPath']);
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

test('owner install reuses full CI only for the exact clean landed commit with matching artifacts', t => {
  const { folder } = environment(t);
  const { main: checkout } = repoWithWorktree(folder);
  const git = (...args) => execFileSync('git', args, { cwd: checkout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const viewer = 'experiences/sharing/viewer-bundle.generated.ts';
  mkdirSync(join(checkout, 'experiences/sharing'), { recursive: true });
  for (const name of ['main.js', 'manifest.json', 'styles.css', viewer]) writeFileSync(join(checkout, name), 'committed ' + name);
  git('add', 'main.js', 'manifest.json', 'styles.css', viewer); git('commit', '-qm', 'artifacts'); git('push', '-q', 'origin', 'main'); git('fetch', '-q', 'origin');
  const sha = git('rev-parse', 'HEAD');
  const lookup = (dir, candidate) => { assert.equal(dir, checkout); assert.equal(candidate, sha); return '12345'; };
  assert.deepEqual(greenInstallRun(checkout, lookup), { sha, id: '12345' });
  git('update-index', '--assume-unchanged', 'a.txt');
  assert.equal(greenInstallRun(checkout, () => { throw new Error('must not look up hidden source'); }), null);
  git('update-index', '--no-assume-unchanged', 'a.txt');
  assert.equal(greenInstallRun(checkout, () => { throw new Error('no full green CI'); }), null);
  assert.equal(greenInstallRun(checkout, () => 'not a run id'), null);
  for (const name of ['a.txt', 'main.js', 'manifest.json', 'styles.css', viewer, 'new.ts']) {
    const path = join(checkout, name);
    const original = existsSync(path) ? readFileSync(path) : null;
    writeFileSync(path, 'dirty');
    let called = false;
    assert.equal(greenInstallRun(checkout, () => { called = true; return '12345'; }), null);
    assert.equal(called, false);
    if (original) writeFileSync(path, original); else rmSync(path);
  }
  assert.equal(greenInstallRun(checkout, () => { writeFileSync(join(checkout, 'a.txt'), 'changed during lookup'); return '12345'; }), null);
  git('restore', 'a.txt');
  writeFileSync(join(checkout, 'a.txt'), 'new candidate'); git('commit', '-qam', 'ahead');
  assert.equal(greenInstallRun(checkout, () => '12345'), null);
});

test('owner idle wait happens before the heavy lock and rechecks without waiting inside it', async () => {
  const events = [];
  const wait = () => events.push('wait');
  const enter = async () => events.push('lock');
  const execute = async args => events.push(args);
  await runHarnessCli(['--update-current', '--wait-idle'], { wait, enter, execute });
  assert.deepEqual(events, ['wait', 'lock', ['--update-current']]);
  events.length = 0;
  await assert.rejects(runHarnessCli(['--update-current', '--wait-idle'], { wait: () => { throw new Error('busy timeout'); }, enter, execute }), /busy timeout/);
  assert.deepEqual(events, []);
  await runHarnessCli(['--update-current', '--owner-idle-confirmed', '--wait-idle'], { wait, enter, execute });
  assert.deepEqual(events, ['lock', ['--update-current', '--owner-idle-confirmed', '--wait-idle']]);
});

test('dependency download does not touch CI cache or an explicitly selected table', t => {
  const { folder } = environment(t);
  let called = false;
  const lookup = () => { called = true; return ''; };
  assert.equal(fetchDepsTable(folder, lookup, { CI: 'true' }), false);
  assert.equal(fetchDepsTable(folder, lookup, { VAM_TEST_DEPS_FILE: '/custom/table.json' }), false);
  assert.equal(called, false);
  assert.equal(existsSync(join(folder, 'test-deps.json')), false);
});

test('build uses the native incremental compiler only locally and clean builds retain full checking', () => {
  assert.ok(typecheckArgs(root, {}).includes('--incremental'));
  for (const env of [{ CI: 'true' }, { VAM_CLEAN_BUILD: '1' }]) {
    const args = typecheckArgs(root, env);
    assert.ok(args.includes('-noEmit') && args.includes('-skipLibCheck'));
    assert.ok(!args.includes('--incremental'));
  }
});

test('generated conflict recovery refuses source conflicts and unrelated unstaged work', () => {
  const files = ['main.js', 'experiences/sharing/viewer-bundle.generated.ts'];
  assert.deepEqual(generatedConflictPlan(files, files, []), files);
  assert.throws(() => generatedConflictPlan([], [], []), /source conflict/);
  assert.throws(() => generatedConflictPlan(['main.ts', ...files], files, []), /source conflict/);
  assert.throws(() => generatedConflictPlan(files, ['main.ts'], []), /unstaged/);
  assert.throws(() => generatedConflictPlan(files, files, ['new.ts']), /unstaged/);
});

test('development telemetry stores only allowlisted fields and evidence matches the exact candidate', t => {
  const { folder } = environment(t);
  const file = join(folder, 'dev-events.jsonl');
  const opts = { env: { VAM_DEV_TELEMETRY_FILE: file } };
  const identity = { commit: 'a'.repeat(40), fingerprint: 'b'.repeat(64) };
  assert.equal(recordDevEvent('affected-verification', 125, 'ok', { ...identity, mode: 'files', prompt: 'SECRET' }, opts), true);
  assert.equal(recordDevEvent('affected-verification', 200, 'error', identity, opts), true);
  assert.equal(recordDevEvent('unrecognized', 1, 'ok', {}, opts), false);
  assert.equal(recordDevEvent('test-unit', 1, 'ok', {}, { env: { ...opts.env, CI: 'true' } }), false);
  assert.doesNotMatch(readFileSync(file, 'utf8'), /SECRET|prompt/);
  assert.equal(matchingEvidence(file, identity).length, 1);
  assert.deepEqual(matchingEvidence(file, { ...identity, fingerprint: 'c'.repeat(64) }), []);
});

test('fetchDepsTable fetches the latest green full main run once and fails soft', t => {
  const { folder } = environment(t);
  const calls = [];
  const fake = (command, args) => {
    calls.push([command, ...args]);
    if (args[1] === 'list') return 'noise\n111\n222\n';
    writeFileSync(join(args[args.indexOf('-D') + 1], 'test-deps.json'), JSON.stringify({ version: 1, sha: 'a'.repeat(40), paths: [], tests: {} }));
  };
  assert.equal(fetchDepsTable(folder, fake, {}), true);
  assert.equal(JSON.parse(readFileSync(join(folder, 'test-deps.json'), 'utf8')).sha, 'a'.repeat(40));
  assert.deepEqual(calls[1].slice(0, 5), ['gh', 'run', 'download', '111', '-n']);
  assert.equal(fetchDepsTable(folder, () => { throw new Error('must not run'); }, {}), false); // table already present
  rmSync(join(folder, 'test-deps.json'));
  assert.equal(fetchDepsTable(folder, () => { throw new Error('gh missing'); }, {}), false);
  assert.equal(existsSync(join(folder, 'test-deps.json')), false);
  assert.equal(fetchDepsTable(folder, () => '', {}), false); // no green full run
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
  assert.deepEqual({ ...(await reloadRunningPlugin('/v', connect(live))) }, { enabled: true, reloaded: true });
  assert.deepEqual(live.calls, ['disable visual-agent-map', 'enable visual-agent-map'], 'the plugin is reloaded; the saved enabled list is never written');
  await assert.rejects(reloadRunningPlugin('/v', connect(fakeApp(true, false))), /old plugin is still running/);
  const off = fakeApp(false);
  assert.equal((await reloadRunningPlugin('/v', connect(off))).enabled, false);
  assert.deepEqual(off.calls, [], 'a plugin the owner switched off is left off');
  assert.doesNotMatch(reloadPluginExpression, /AndSave|focus|activate/);
});

// 2026-11-24: the test Obsidian was running with its last window closed; the install succeeded but --update-current exited 1.
test('a running Obsidian with no window open is not a failed install: the new files load when a window opens', async () => {
  const noWindow = async () => { throw new Error('No Obsidian main window on DevTools port 60274.'); };
  assert.deepEqual(await reloadRunningPlugin('/v', noWindow), { enabled: true, window: false });
  await assert.rejects(reloadRunningPlugin('/v', async () => { throw new Error('Obsidian for /v is not answering on DevTools port 1; it may have quit.'); }), /not answering/);
});

test('session preparation selects exactly one verification policy, preserves full fallback and never labels preview as verified', () => {
  const simulate = (mode, green, env = {}, fail = null) => {
    const calls = [];
    const options = {
      mode, env, lookup: () => { calls.push('lookup'); return green; },
      execute: (_command, args) => { const name = args.join(' '); calls.push(name); if (name === fail) throw new Error('verification failed'); },
      fingerprint: () => 'same-source', artifactHashes: () => ({ 'main.js': 'same', viewer: 'same' })
    };
    return { calls, options, result: () => prepareSessionCandidate(options) };
  };
  const green = { sha: 'a'.repeat(40), id: '123' };
  for (const [mode, proof, env, expected, calls] of [
    ['affected', green, {}, 'ci-full', ['lookup', '--test tests/test-vault.mjs']],
    ['affected', null, {}, 'local-affected', ['lookup', 'run build', 'run test:affected']],
    ['affected', green, { VAM_CLEAN_BUILD: '1' }, 'local-affected', ['run build', 'run test:affected']],
    ['affected', green, { CI: 'true' }, 'local-affected', ['run build', 'run test:affected']],
    ['preview', green, {}, 'preview-unverified', ['run build']],
    ['full', green, {}, 'local-full', ['run build', 'run test:unit', 'run test:integration']]
  ]) {
    const s = simulate(mode, proof, env);
    assert.equal(s.result().verification.kind, expected);
    assert.deepEqual(s.calls, calls);
  }
  const failed = simulate('affected', null, {}, 'run test:affected');
  assert.throws(failed.result, /verification failed/);
  const localFailure = simulate('affected', green, {}, '--test tests/test-vault.mjs');
  assert.throws(localFailure.result, /verification failed/);
  const changed = simulate('preview', null);
  let reads = 0;
  changed.options.fingerprint = () => String(reads++);
  assert.throws(changed.result, /Source changed/);
  const changedArtifact = simulate('affected', green);
  reads = 0;
  changedArtifact.options.artifactHashes = () => ({ viewer: String(reads++) });
  assert.throws(changedArtifact.result, /artifacts changed/);
  assert.throws(() => main(['--session=a', '--preview', '--full']), /Conflicting session options/);
  assert.throws(() => main(['--session=a', '--stop', '--preview']), /Conflicting session options/);
  assert.throws(() => main(['--update-current', '--preview']), /Unknown argument/);
});

test('same session bytes skip asset replacement but update preview verification record', t => {
  const { vault } = environment(t);
  const previous = { fingerprint: 'same', verification: { kind: 'preview-unverified' } };
  prepareTestVault({ vault, source: previous });
  const plugin = join(vault, '.obsidian/plugins/visual-agent-map');
  const file = join(plugin, 'main.js');
  const before = readFileSync(file), inode = statSync(file).ino;
  const current = { fingerprint: 'same', verification: { kind: 'local-full' } };
  assert.deepEqual(updateCurrentTestVault({ vault, source: current }).source, current);
  assert.deepEqual(readFileSync(file), before);
  assert.equal(statSync(file).ino, inode, 'same bytes were not replaced');
  assert.deepEqual(verifyTestVault(vault).source, current);
  writeFileSync(file, 'tampered');
  updateCurrentTestVault({ vault, source: current });
  assert.deepEqual(readFileSync(file), before, 'tamper forces normal repair');
});
test('session full does not inherit selective test or CI shard settings', () => {
  const env = { VAM_AFFECTED_TESTS: 'other', VAM_CI_SHARD: '1/4', VAM_ISOLATED_SUITES: '1' };
  const calls = [];
  prepareSessionCandidate({ mode: 'full', env, fingerprint: () => 'x', artifactHashes: () => ({ x: 'y' }), execute: (_command, args, childEnv) => calls.push({ args, env: childEnv }) });
  for (const call of calls.slice(1)) for (const key of Object.keys(env)) assert.equal(call.env[key], undefined);
});

test('expensive affected plans refresh stale dependency tables without accepting unrelated or older proof', t => {
  const { folder } = environment(t);
  const { main: checkout } = repoWithWorktree(folder, { behind: true });
  const git = (...args) => execFileSync('git', args, { cwd: checkout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const base = git('rev-parse', 'origin/main'), old = git('rev-parse', 'HEAD^');
  const data = sha => JSON.stringify({ version: 1, sha, paths: [], tests: {} });
  const path = join(checkout, 'test-deps.json');
  writeFileSync(path, data(old));
  let calls = 0;
  const mock = sha => (_command, args) => {
    calls++;
    if (args[1] === 'list') return '111\n';
    writeFileSync(join(args[args.indexOf('-D') + 1], 'test-deps.json'), data(sha));
  };
  const full = { mode: 'full', files: [] };
  assert.equal(refreshDepsTable(checkout, 'origin/main', { mode: 'files', files: ['a'] }, mock(base), {}, 1000), false);
  assert.equal(calls, 0);
  assert.equal(refreshDepsTable(checkout, 'origin/main', full, mock('f'.repeat(40)), {}, 1000), false);
  assert.equal(readFileSync(path, 'utf8'), data(old));
  assert.equal(refreshDepsTable(checkout, 'origin/main', full, mock(base), {}, 1001), false, 'cooldown');
  assert.equal(calls, 2);
  assert.equal(refreshDepsTable(checkout, 'origin/main', full, mock(base), {}, 601001), true);
  assert.equal(readFileSync(path, 'utf8'), data(base));
  assert.equal(refreshDepsTable(checkout, 'origin/main', full, mock(old), {}, 1202000), false);
  assert.equal(readFileSync(path, 'utf8'), data(base));
});

test('viewer cache uses actual local graph and config, detects added resolution paths and output tampering', t => {
  const { folder } = environment(t);
  const output = 'experiences/sharing/viewer-bundle.generated.ts';
  const fixed = ['scripts/build-viewer.mjs', 'scripts/viewer-css.mjs', 'scripts/viewer-cache.mjs', 'styles.css',
    'experiences/sharing/viewer/viewer.css', 'package.json', 'package-lock.json', 'tsconfig.json', '.prettierrc.json',
    'experiences/sharing/viewer/index.ts', 'core/used.ts', 'core/other.ts', output,
    'node_modules/esbuild/index.js', 'node_modules/@esbuild/platform/bin', 'node_modules/prettier/index.js'];
  for (const path of fixed) {
    mkdirSync(dirname(join(folder, path)), { recursive: true });
    writeFileSync(join(folder, path), path.endsWith('.json') ? '{}' : path);
  }
  const entry = 'experiences/sharing/viewer/index.ts', used = 'core/used.ts';
  const inputs = viewerInputs({ inputs: { [entry]: { imports: [{ path: used, original: '../../../core/used' }] }, [used]: { imports: [] } } });
  assert.deepEqual(inputs, [used, entry]);
  assert.equal(viewerInputs({ inputs: { [entry]: { imports: [{ path: 'node_modules/pkg/index.js', original: 'pkg' }] } } }), null);
  assert.equal(viewerCacheEnabled({ CI: 'true' }), false);
  assert.equal(viewerCacheEnabled({ VAM_CLEAN_BUILD: '1' }), false);
  const key = () => viewerCacheKey(folder, inputs, {}, {});
  const initial = key();
  assert.match(initial, /^[0-9a-f]{64}$/);
  saveViewerCache(folder, inputs, null, output);
  assert.equal(viewerCacheHit(folder, readViewerCache(folder), initial), false);
  saveViewerCache(folder, inputs, initial, output);
  assert.equal(viewerCacheHit(folder, readViewerCache(folder), initial), true);
  writeFileSync(join(folder, 'core/other.ts'), 'unrelated content');
  assert.equal(key(), initial);
  writeFileSync(join(folder, used), 'changed dependency');
  assert.notEqual(key(), initial);
  writeFileSync(join(folder, used), used);
  writeFileSync(join(folder, 'core/used.js'), 'new resolver candidate');
  assert.notEqual(key(), initial);
  rmSync(join(folder, 'core/used.js'));
  assert.equal(key(), initial);
  writeFileSync(join(folder, output), 'tampered output');
  assert.equal(viewerCacheHit(folder, readViewerCache(folder), initial), false);
  writeFileSync(join(folder, 'node_modules/esbuild/index.js'), 'changed tool');
  assert.notEqual(key(), initial);
});

test('session operations have exclusive locks and cannot stop a foreign owned vault', async t => {
  const { vault } = environment(t);
  const record = prepareTestVault({ vault });
  assert.equal(assertSessionOwner(vault).owner, record.owner);
  await withSessionLock(vault, async () => {
    assert.throws(() => withSessionLock(vault, () => {}), /EEXIST/);
  });
  assert.equal(existsSync(vault + '.lock'), false);
  await assert.rejects(withSessionLock(vault, async () => { throw new Error('failure'); }), /failure/);
  assert.equal(existsSync(vault + '.lock'), false);
  const marker = join(vault, '.vam-test-environment.json');
  writeFileSync(marker, JSON.stringify({ ...record, owner: '/other' }));
  assert.throws(() => assertSessionOwner(vault), /another checkout/);
});
test('hot reload refuses busy/unknown instances, restores files and record on failed load', async t => {
  const { folder, vault } = environment(t);
  const runtime = { version: '1.14.0', hash: 'h' };
  const old = { fingerprint: 'old', obsidianRuntime: runtime };
  const next = { fingerprint: 'new', obsidianRuntime: runtime };
  prepareTestVault({ vault, source: old });
  const plugin = join(vault, '.obsidian/plugins/visual-agent-map');
  const bytes = readFileSync(join(plugin, 'main.js'));
  const artifact = join(folder, 'build');
  mkdirSync(artifact);
  for (const name of ['main.js', 'manifest.json', 'styles.css']) copyFileSync(join(root, name), join(artifact, name));
  writeFileSync(join(artifact, 'main.js'), 'new build');
  const connection = results => async () => ({ evaluate: async () => results.shift(), close() {} });
  const run = options => reloadSessionVault({ vault, source: next, artifact, idle() {}, ...options });
  await assert.rejects(run({ connect: connection([{ status: 'busy' }]) }), /busy/);
  assert.deepEqual(readFileSync(join(plugin, 'main.js')), bytes);
  await assert.rejects(run({ connect: connection([{ status: 'disabled' }, false, true, true]) }), /Previous files restored/);
  assert.deepEqual(readFileSync(join(plugin, 'main.js')), bytes);
  assert.deepEqual(verifyTestVault(vault).source, old);
  const installed = await run({ connect: connection([{ status: 'disabled' }, true]) });
  assert.deepEqual(installed.source, next);
  assert.equal(readFileSync(join(plugin, 'main.js'), 'utf8'), 'new build');
  assert.match(sessionDisableExpression('/test', runtime.version), /p\.activeTasks/);
  assert.match(sessionDisableExpression('/test', runtime.version), /wrong-vault/);
  assert.throws(() => main(['--session=a', '--stop', '--reload']), /Conflicting session options/);
});

test('an explicit owned session can reload after completed work without the owner quiet-time wait', t => {
  const vault = busyVault(t, { ...one([start(1, 4), end(1, 'done', 3)]), exchanges: [{ startedAt: ago(4), completedAt: ago(3) }] });
  assert.ok(ownerBusyReasons(vault, { now: NOW }).length > 0);
  assert.deepEqual(ownerBusyReasons(vault, { now: NOW, requireQuietWindow: false }), []);
  const active = busyVault(t, one([start(1, 3)]));
  assert.match(ownerBusyReasons(active, { now: NOW, requireQuietWindow: false }).join('\n'), /還沒結束/);
});
test('session runtime profile reuses matching bytes, refuses running mismatch and repairs only stopped runtime', t => {
  const { folder, vault } = environment(t);
  prepareTestVault({ vault });
  const path = join(folder, 'runtime.asar');
  const bytes = Buffer.from('runtime bytes');
  writeFileSync(path, bytes);
  const runtime = { version: '1.14.0', path, hash: createHash('sha256').update(bytes).digest('hex') };
  const profile = ensureSessionProfile(vault, runtime);
  assert.equal(ensureSessionProfile(vault, runtime, { running: true }), profile);
  const asar = join(profile, 'obsidian-1.14.0.asar');
  writeFileSync(asar, 'tampered');
  assert.throws(() => ensureSessionProfile(vault, runtime, { running: true }), /archive changed/);
  assert.equal(readFileSync(asar, 'utf8'), 'tampered');
  ensureSessionProfile(vault, runtime);
  assert.deepEqual(readFileSync(asar), bytes);
});

test('session reload CDP guard really executes: only an idle correct instance is unloaded', async () => {
  const id = 'visual-agent-map', empty = () => new Map();
  const setup = () => {
    const plugin = {
      repo: {}, unloaded: false, queue: Promise.resolve(), ready: Promise.resolve(), writing: 0,
      pendingRenames: null, externalReconcileTimer: null, languageSwitchPending: false,
      running: empty(), activeTasks: empty(), chartJobs: empty(), quickExpandPending: empty(),
      expansionBatches: empty(), pendingSuggestions: empty(), pendingResearchOptions: empty(), externalReconcilePaths: empty(),
      bookPipelineRuns: { drives: empty(), gateWaiting: empty(), notesJobs: empty() },
      argumentRuns: { drives: empty() }, bookNotesApply: { jobs: empty() },
      coffeeManager: { engines: empty(), deletingIds: empty() }
    };
    const calls = [], plugins = { enabledPlugins: new Set([id]), plugins: { [id]: plugin } };
    plugins.disablePlugin = async key => { calls.push(key); delete plugins.plugins[key]; };
    const context = { app: { vault: { adapter: { basePath: '/test' } }, plugins }, document: { querySelector: () => null },
      require: () => ({ ipcRenderer: { sendSync: () => '1.14.0' } }), setTimeout };
    return { plugin, calls, context };
  };
  const execute = state => vm.runInNewContext(sessionDisableExpression('/test', '1.14.0'), state.context);
  const idle = setup();
  assert.equal((await execute(idle)).status, 'disabled');
  assert.deepEqual(idle.calls, [id]);
  for (const alter of [
    s => s.plugin.activeTasks.set('ai', {}),
    s => s.plugin.bookPipelineRuns.drives.set('book', {}),
    s => s.plugin.writing = 1,
    s => s.plugin.queue = new Promise(() => {}),
    s => delete s.plugin.chartJobs,
    s => s.context.document.querySelector = () => ({}),
    s => s.context.app.vault.adapter.basePath = '/other',
    s => s.context.require = () => ({ ipcRenderer: { sendSync: () => '1.13.0' } })
  ]) {
    const state = setup();
    alter(state);
    assert.notEqual((await execute(state)).status, 'disabled');
    assert.deepEqual(state.calls, []);
  }
});

test('front app is read from both lsappinfo formats', () => {
  assert.deepEqual(parseFrontApp('"pid"=828\n"LSBundlePath"="/Applications/LINE.app"\n'), { pid: 828, path: '/Applications/LINE.app' });
  const macos27 = '[ NULL ]  ASN:0x0-0x15015: (in front) \n    bundleID=[ NULL ] \n    bundle path="/Applications/LINE.app"\n    executable path=[ NULL ] \n    pid = 828 !cgsConnection !signalled type=[ NULL ]\n';
  assert.deepEqual(parseFrontApp(macos27), { pid: 828, path: '/Applications/LINE.app' });
  assert.ok(Number.isNaN(parseFrontApp('').pid));
});

test('test Obsidian runs from a background-only copy with a mock keychain', { skip: process.platform !== 'darwin' && 'macOS bundle tools' }, t => {
  const folder = mkdtempSync(join(tmpdir(), 'vam-test-app-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const source = join(folder, 'Obsidian.app');
  mkdirSync(join(source, 'Contents', 'MacOS'), { recursive: true });
  copyFileSync('/usr/bin/true', join(source, 'Contents', 'MacOS', 'Obsidian'));
  writeFileSync(join(source, 'Contents', 'Info.plist'), '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>md.obsidian</string><key>CFBundleExecutable</key><string>Obsidian</string><key>CFBundleVersion</key><string>1.2.3</string></dict></plist>');
  const copies = join(folder, 'copies');
  const app = ensureTestApp(source, copies);
  assert.equal(app, join(copies, 'Obsidian-1.2.3.app'));
  const read = key => execFileSync('plutil', ['-extract', key, 'raw', join(app, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim();
  assert.equal(read('CFBundleIdentifier'), testAppBundleId);
  assert.equal(read('LSBackgroundOnly'), 'true');
  assert.match(readFileSync(join(source, 'Contents', 'Info.plist'), 'utf8'), /<string>md\.obsidian<\/string>/, 'the installed Obsidian is never changed');
  execFileSync('codesign', ['-v', app]);
  assert.equal(ensureTestApp(source, copies), app, 'an existing copy for the same build is reused');
  assert.deepEqual(readdirSync(copies), ['Obsidian-1.2.3.app'], 'no staging folder is left behind');
  const args = launchArgs(app, '/private/tmp/vam-e2e-x/.vam-app');
  assert.equal(args[args.indexOf('-a') + 1], app);
  assert.ok(args.includes('--use-mock-keychain') && args.includes('--password-store=basic'));
  // Electron's log goes into this test profile only, after --args so it never reaches `open` itself.
  assert.ok(args.indexOf('--enable-logging=file') > args.indexOf('--args'));
  assert.ok(args.includes('--log-file=/private/tmp/vam-e2e-x/.vam-app/electron.log'));
});
