// The machine-wide heavy-test lock and the end-of-run leak check (scripts/heavy-lock.mjs). Every test points VAM_HEAVY_LOCK_DIR at its own temp folder,
// so the real lock is never touched; child processes get a clean env (no CI, no inherited VAM_HEAVY_LOCK_HELD) so the outer `npm test` lock cannot leak in.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { test, root } = require('../support.cjs');

const moduleUrl = pathToFileURL(path.join(root, 'scripts', 'heavy-lock.mjs')).href;
const lib = () => import(moduleUrl);
const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const cleanEnv = (dir, extra = {}) => {
  const env = { ...process.env, VAM_HEAVY_LOCK_DIR: dir, ...extra };
  for (const name of ['CI', 'VAM_HEAVY_LOCK_HELD', 'NODE_TEST_CONTEXT']) if (!(name in extra)) delete env[name];
  return env;
};
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// A node child running an ES module snippet; `output` collects stdout and stderr, `waitFor` resolves when the pattern shows up.
function node(script, env, args = []) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const handle = { child, output: '', stdout: '', exit: null };
  const waiters = [];
  const feed = (chunk, key) => { handle.output += chunk; if (key) handle[key] += chunk; for (const w of waiters.slice()) if (w.pattern.test(handle.output)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(); } };
  child.stdout.on('data', chunk => feed(String(chunk), 'stdout'));
  child.stderr.on('data', chunk => feed(String(chunk)));
  handle.closed = new Promise(resolve => child.on('close', (code, signal) => { handle.exit = { code, signal }; resolve(handle.exit); }));
  handle.waitFor = (pattern, ms = 15000) => new Promise((resolve, reject) => {
    if (pattern.test(handle.output)) return resolve();
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${pattern}; output: ${handle.output}`)), ms);
    waiters.push({ pattern, resolve: () => { clearTimeout(timer); resolve(); } });
  });
  return handle;
}

// Takes the lock, prints "held <pid> <time>", holds for `hold` ms, then ends the way `ending` says.
const holderScript = (label, hold, ending = 'return') => `
  const { enterHeavy } = await import(${JSON.stringify(moduleUrl)});
  await enterHeavy(${JSON.stringify(label)}, { pollMs: 50, reportMs: 100 });
  console.log('held ' + process.pid + ' ' + Date.now());
  ${typeof hold === 'string' ? `const { existsSync } = await import('node:fs'); while (!existsSync(${JSON.stringify(hold)})) await new Promise(resolve => setTimeout(resolve, 20));` : `await new Promise(resolve => setTimeout(resolve, ${hold}));`}
  console.log('ending ' + Date.now());
  ${ending === 'fail' ? 'process.exit(3);' : ending === 'throw' ? 'throw new Error("boom");' : ''}
`;
const lockFile = dir => path.join(dir, 'heavy-test.lock');
const owner = dir => JSON.parse(fs.readFileSync(lockFile(dir), 'utf8'));
const stop = async (...handles) => { for (const h of handles) if (h && h.exit === null) { h.child.kill('SIGKILL'); await h.closed; } };

test('heavy lock: a second process waits for the first, names the holder, and starts only after it ended', async () => {
  const dir = tmp('vam-heavy-lock-');
  const release = path.join(dir, 'release-first'); // the first holder ends only when the test says so, however slow the machine is
  const first = node(holderScript('first-cmd', release), cleanEnv(dir));
  let second;
  try {
    await first.waitFor(/held \d+/);
    second = node(holderScript('second-cmd', 0), cleanEnv(dir));
    await second.waitFor(/等 \d+/);
    await sleep(300);
    assert.doesNotMatch(second.output, /held \d+/, 'the second must still be waiting');
    fs.writeFileSync(release, '');
    await Promise.all([first.closed, second.closed]);
    const firstEnd = Number(/ending (\d+)/.exec(first.stdout)[1]);
    const secondStart = Number(/held \d+ (\d+)/.exec(second.stdout)[1]);
    assert.ok(secondStart >= firstEnd, `second started at ${secondStart}, before the first ended at ${firstEnd}`);
    const firstPid = /held (\d+)/.exec(first.stdout)[1];
    assert.match(second.output, new RegExp(`等 ${firstPid} \\S+ first-cmd，已等 \\d+ 秒`));
    assert.equal(first.exit.code, 0); assert.equal(second.exit.code, 0);
    assert.equal(fs.existsSync(lockFile(dir)), false, 'the lock file is gone after both ended');
  } finally { await stop(first, second); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('heavy lock: the lock records pid, worktree, command and an ISO start time', async () => {
  const dir = tmp('vam-heavy-lock-');
  const holder = node(holderScript('record-cmd', 5000), cleanEnv(dir));
  try {
    await holder.waitFor(/held \d+/);
    const record = owner(dir);
    assert.equal(record.pid, holder.child.pid);
    assert.equal(record.command, 'record-cmd');
    assert.equal(path.resolve(record.worktree), path.resolve(root));
    assert.equal(new Date(record.startedAt).toISOString(), record.startedAt);
  } finally { await stop(holder); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('heavy lock: a holder killed with SIGKILL is reclaimed by the next process, which says so and then holds the lock', async () => {
  const dir = tmp('vam-heavy-lock-');
  const dead = node(holderScript('dead-cmd', 60000), cleanEnv(dir));
  let next;
  try {
    await dead.waitFor(/held \d+/);
    dead.child.kill('SIGKILL'); await dead.closed;
    assert.equal(owner(dir).pid, dead.child.pid, 'the dead holder left its lock behind');
    next = node(holderScript('next-cmd', 0), cleanEnv(dir));
    await next.closed;
    assert.match(next.output, new RegExp(`收回鎖：持有者 pid ${dead.child.pid}`));
    assert.match(next.output, /held \d+/);
    assert.equal(next.exit.code, 0);
  } finally { await stop(dead, next); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('heavy lock: a live non-ancestor holder is never bypassed, with a forged token or with the real token', async () => {
  const dir = tmp('vam-heavy-lock-');
  const holder = node(holderScript('real-holder', 60000), cleanEnv(dir));
  const waiters = [];
  try {
    await holder.waitFor(/held \d+/);
    const real = owner(dir).token;
    for (const token of ['forged-token', real, `ci-${holder.child.pid}`]) {
      // The token is only valid for the holder's own descendants: the CI marker for another pid and the real token from a stranger both queue.
      const waiter = node(holderScript('stranger', 0), cleanEnv(dir, { VAM_HEAVY_LOCK_HELD: token }));
      waiters.push(waiter);
      await waiter.waitFor(/等 \d+ \S+ real-holder/);
    }
    await sleep(300);
    for (const waiter of waiters) assert.doesNotMatch(waiter.output, /held \d+/, 'a stranger must not pass the lock');
    assert.equal(owner(dir).pid, holder.child.pid, 'the holder keeps the lock');
  } finally { await stop(holder, ...waiters); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('heavy lock: a child of the holder with the holder token passes at once; the holder keeps the lock meanwhile', async () => {
  const dir = tmp('vam-heavy-lock-');
  const script = `
    import { spawnSync } from 'node:child_process';
    const { enterHeavy } = await import(${JSON.stringify(moduleUrl)});
    await enterHeavy('outer', { pollMs: 50, reportMs: 100 });
    const inner = "const { enterHeavy } = await import(" + ${JSON.stringify(JSON.stringify(moduleUrl))} + "); await enterHeavy('inner', { pollMs: 50 }); console.log('inner passed');";
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', inner], { encoding: 'utf8', env: process.env, timeout: 10000 });
    console.log(run.stdout.trim(), 'status', run.status);
  `;
  const run = node(script, cleanEnv(dir));
  await run.closed;
  try {
    assert.match(run.stdout, /inner passed status 0/);
    assert.equal(fs.existsSync(lockFile(dir)), false);
  } finally { await stop(run); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('heavy lock: SIGINT while waiting exits 130, leaves no waiting trace and does not touch the holder lock', async () => {
  const dir = tmp('vam-heavy-lock-');
  const holder = node(holderScript('busy-holder', 60000), cleanEnv(dir));
  let waiter;
  try {
    await holder.waitFor(/held \d+/);
    const before = fs.readFileSync(lockFile(dir), 'utf8');
    waiter = node(holderScript('impatient', 0), cleanEnv(dir));
    await waiter.waitFor(/等 \d+/);
    waiter.child.kill('SIGINT');
    const exit = await waiter.closed;
    assert.equal(exit.code, 130);
    assert.equal(fs.readFileSync(lockFile(dir), 'utf8'), before, 'the holder lock is untouched');
    assert.deepEqual(fs.readdirSync(dir), ['heavy-test.lock'], 'no pending file or reclaim folder is left');
  } finally { await stop(holder, waiter); fs.rmSync(dir, { recursive: true, force: true }); }
});

for (const ending of ['return', 'fail', 'throw', 'SIGTERM']) {
  test(`heavy lock: the lock is released when the holder ends by ${ending}`, async () => {
    const dir = tmp('vam-heavy-lock-');
    const holder = node(holderScript('ending-cmd', ending === 'SIGTERM' ? 60000 : 100, ending), cleanEnv(dir));
    try {
      await holder.waitFor(/held \d+/);
      if (ending === 'SIGTERM') holder.child.kill('SIGTERM');
      const exit = await holder.closed;
      assert.equal(exit.code, { return: 0, fail: 3, throw: 1, SIGTERM: 143 }[ending]);
      assert.equal(fs.existsSync(lockFile(dir)), false);
    } finally { await stop(holder); fs.rmSync(dir, { recursive: true, force: true }); }
  });
}

test('heavy lock: only the owner token releases the lock', async () => {
  const { releaseLock, tryAcquire, readOwner } = await lib();
  const dir = tmp('vam-heavy-lock-');
  try {
    assert.equal(tryAcquire(dir, { token: 'a', pid: process.pid, worktree: 'w', command: 'c', startedAt: new Date().toISOString() }), true);
    assert.equal(tryAcquire(dir, { token: 'b', pid: process.pid, worktree: 'w', command: 'c', startedAt: new Date().toISOString() }), false);
    releaseLock(dir, 'b'); assert.equal(readOwner(dir).token, 'a');
    releaseLock(dir, 'a'); assert.equal(readOwner(dir), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('heavy lock: CI=true takes no lock and does not wait for a live holder', async () => {
  const dir = tmp('vam-heavy-lock-');
  const holder = node(holderScript('ci-holder', 60000), cleanEnv(dir));
  let ci;
  try {
    await holder.waitFor(/held \d+/);
    const before = fs.readFileSync(lockFile(dir), 'utf8');
    ci = node(holderScript('ci-run', 0), cleanEnv(dir, { CI: 'true' }));
    const exit = await ci.closed;
    assert.equal(exit.code, 0);
    assert.doesNotMatch(ci.output, /等 \d+/);
    assert.equal(fs.readFileSync(lockFile(dir), 'utf8'), before);
  } finally { await stop(holder, ci); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('heavy lock: the classifier accepts only vam- temp profiles for Chrome and .vam-app for Obsidian', async () => {
  const { classify } = await lib();
  const roots = ['/var/folders/xx/T', '/private/var/folders/xx/T'];
  assert.equal(classify('/var/folders/xx/T/vam-mermaid-colour-40fBgW/profile', roots), 'chrome');
  assert.equal(classify('/private/tmp/vam-e2e-uxonboard/.vam-app', ['/private/tmp']), 'obsidian');
  assert.equal(classify('/Users/u/Library/Application Support/Google/Chrome', roots), null);
  assert.equal(classify('/var/folders/xx/T/other-profile/p', roots), null);
  assert.equal(classify('/var/folders/xx/vam-elsewhere/p', roots), null);
  assert.equal(classify(null, roots), null);
});

test('heavy lock: findLeaks lists only this run\'s test processes and never the user\'s or another run\'s', async () => {
  const { findLeaks } = await lib();
  const roots = ['/var/folders/xx/T'];
  const p = (pid, ppid, command, pgid = pid) => ({ pid, ppid, pgid, command });
  const procs = [
    p(10, 1, 'node entry'),
    p(11, 10, 'node test'),
    p(12, 11, 'chrome --headless --user-data-dir=/var/folders/xx/T/vam-mine-AAAAAA/profile'),
    p(13, 12, 'chrome --type=renderer --user-data-dir=/var/folders/xx/T/vam-mine-AAAAAA/profile', 12),
    p(20, 1, 'chrome --user-data-dir=/var/folders/xx/T/vam-orphan-BBBBBB/profile'),
    p(21, 1, 'chrome --user-data-dir=/var/folders/xx/T/vam-before-CCCCCC/profile'),
    p(30, 1, '/Users/u/Chrome --user-data-dir=/Users/u/Library/Chrome'),
    p(40, 41, 'chrome --user-data-dir=/var/folders/xx/T/vam-other-run-DDDDDD/profile'),
    p(41, 1, 'node other test'),
    p(50, 11, 'Obsidian --user-data-dir=/var/folders/xx/T/vam-e2e-x/.vam-app'),
    p(51, 1, 'Obsidian --user-data-dir=/private/tmp/vam-e2e-theirs/.vam-app')
  ];
  const start = { pids: new Set([10, 21, 30, 40, 41, 51]), profiles: new Set(['/var/folders/xx/T/vam-before-CCCCCC/profile']) };
  const leaks = findLeaks({ procs, selfPid: 10, start, roots });
  assert.deepEqual(leaks.map(l => l.pid).sort((a, b) => a - b), [12, 20, 50]);
  assert.deepEqual(leaks.find(l => l.pid === 12).pids.sort((a, b) => a - b), [12, 13]);
  const kept = findLeaks({ procs, selfPid: 10, start, roots, keep: ['/var/folders/xx/T/vam-e2e-x/.vam-app'] });
  assert.deepEqual(kept.map(l => l.pid).sort((a, b) => a - b), [12, 20]);
});

test('heavy lock: a run that leaves a fake headless process fails, names it and its test file, and stops only its own leaks', async () => {
  const dir = tmp('vam-heavy-lock-');
  const userProfile = tmp('user-chrome-');
  const otherRunProfile = tmp('vam-heavy-lock-other-');
  const fake = profile => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', `--user-data-dir=${profile}`], { stdio: 'ignore' });
  const other = fake(otherRunProfile); // alive parent (this test): another run's process
  const script = `
    import { spawn, spawnSync } from 'node:child_process';
    import { mkdtempSync } from 'node:fs';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    const { enterHeavy } = await import(${JSON.stringify(moduleUrl)});
    await enterHeavy('leaky-run', { pollMs: 50 });
    const fake = profile => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', '--user-data-dir=' + profile], { stdio: 'ignore' });
    const direct = fake(join(mkdtempSync(join(tmpdir(), 'vam-heavy-lock-')), 'profile'));
    const notVam = fake(${JSON.stringify(userProfile)});
    const orphanProfile = join(mkdtempSync(join(tmpdir(), 'vam-heavy-lock-')), 'profile');
    spawnSync('sh', ['-c', process.execPath + ' -e "setInterval(() => {}, 1000)" -- --user-data-dir=' + orphanProfile + ' &'], { stdio: 'ignore' });
    console.log('pids ' + direct.pid + ' ' + notVam.pid);
    direct.unref(); notVam.unref();
  `;
  const run = node(script, cleanEnv(dir));
  let userPid;
  try {
    const exit = await run.closed;
    const [, directPid, notVamPid] = /pids (\d+) (\d+)/.exec(run.stdout);
    userPid = Number(notVamPid);
    assert.equal(exit.code, 1, `a leak makes the run fail: ${run.output}`);
    assert.match(run.output, new RegExp(`pid ${directPid}[^\\n]*vam-heavy-lock-[^\\n]*推得的測試檔 tests/suites/heavy-lock\\.cjs`));
    assert.equal((run.output.match(/留下仍存活的測試程序/g) || []).length, 2, `the direct and the orphaned process are named: ${run.output}`);
    await sleep(200);
    assert.equal(alive(Number(directPid)), false, 'the leaked process was stopped');
    assert.equal(alive(userPid), true, 'a profile that is not a vam- temp profile is never stopped');
    assert.equal(alive(other.pid), true, 'a process of another run is never stopped');
  } finally {
    if (userPid) try { process.kill(userPid, 'SIGKILL'); } catch { /* already gone */ }
    other.kill('SIGKILL');
    await stop(run);
    for (const folder of [dir, userProfile, otherRunProfile]) fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('heavy lock: a run that already failed keeps its own exit code when it also leaks', async () => {
  const dir = tmp('vam-heavy-lock-');
  const script = `
    import { spawn } from 'node:child_process';
    import { mkdtempSync } from 'node:fs';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    const { enterHeavy } = await import(${JSON.stringify(moduleUrl)});
    await enterHeavy('failing-leaky', { pollMs: 50 });
    spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', '--user-data-dir=' + join(mkdtempSync(join(tmpdir(), 'vam-heavy-lock-')), 'profile')], { stdio: 'ignore' }).unref();
    process.exitCode = 7;
  `;
  const run = node(script, cleanEnv(dir));
  try {
    const exit = await run.closed;
    assert.equal(exit.code, 7);
    assert.match(run.output, /留下仍存活的測試程序/);
  } finally { await stop(run); fs.rmSync(dir, { recursive: true, force: true }); }
});
