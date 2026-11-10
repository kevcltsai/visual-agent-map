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
  handle.waitFor = (pattern, ms = 40000) => new Promise((resolve, reject) => {
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

test('heavy lock: findLeaks lists only this run\'s test processes and never the user\'s, another run\'s, or a newly opened one without this run\'s token', async () => {
  const { findLeaks } = await lib();
  const roots = ['/var/folders/xx/T'];
  const p = (pid, ppid, command, pgid = pid) => ({ pid, ppid, pgid, command });
  const procs = [
    p(10, 1, 'node entry'),
    p(11, 10, 'node test'),
    p(12, 11, 'chrome --headless --user-data-dir=/var/folders/xx/T/vam-mine-AAAAAA/profile'),
    p(13, 12, 'chrome --type=renderer --user-data-dir=/var/folders/xx/T/vam-mine-AAAAAA/profile', 12),
    p(20, 1, 'chrome --user-data-dir=/var/folders/xx/T/vam-orphan-BBBBBB/profile'), // orphan of this run: carries the token
    p(21, 1, 'chrome --user-data-dir=/var/folders/xx/T/vam-new-other-CCCCCC/profile'), // new orphan of nobody we can name
    p(30, 1, '/Users/u/Chrome --user-data-dir=/Users/u/Library/Chrome'),
    p(40, 41, 'chrome --user-data-dir=/var/folders/xx/T/vam-other-run-DDDDDD/profile'),
    p(41, 1, 'node other test'),
    p(50, 11, 'Obsidian --user-data-dir=/var/folders/xx/T/vam-e2e-x/.vam-app'),
    p(51, 1, 'Obsidian --user-data-dir=/private/tmp/vam-e2e-theirs/.vam-app'), // opened by `open` during this run: ppid 1, new pid, new profile
    p(52, 1, 'Obsidian --user-data-dir=/Users/u/vaults/vam-e2e-current/.vam-app'),
    p(60, 61, '/bin/zsh -c pgrep -f -- "x --user-data-dir=/private/tmp/vam-e2e-theirs/.vam-app"', 60)
  ];
  const carries = pid => pid === 20;
  const leaks = findLeaks({ procs, selfPid: 10, roots, carries });
  assert.deepEqual(leaks.map(l => l.pid).sort((a, b) => a - b), [12, 20, 50]);
  assert.deepEqual(leaks.find(l => l.pid === 12).pids.sort((a, b) => a - b), [12, 13]);
  assert.deepEqual(leaks.flatMap(l => l.groups).sort((a, b) => a - b), [12, 20, 50], 'only the process groups of this run\'s own mains are signalled');
  const kept = findLeaks({ procs, selfPid: 10, roots, carries, keep: ['/var/folders/xx/T/vam-e2e-x/.vam-app'] });
  assert.deepEqual(kept.map(l => l.pid).sort((a, b) => a - b), [12, 20]);
});

test('heavy lock: a shell or grep that only mentions a profile in its text is not a browser', async () => {
  const { profileOf } = await lib();
  assert.equal(profileOf('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless --user-data-dir=/tmp/vam-x-AAAAAA/p --no-sandbox'), '/tmp/vam-x-AAAAAA/p');
  assert.equal(profileOf('node -e x -- --user-data-dir=/tmp/vam-x-AAAAAA/p'), '/tmp/vam-x-AAAAAA/p');
  assert.equal(profileOf('/bin/zsh -c eval \'pgrep -f -- "--user-data-dir=/tmp/vam-e2e-theirs/.vam-app"\''), null);
  assert.equal(profileOf('pgrep -f --user-data-dir=/tmp/vam-e2e-theirs/.vam-app'), null);
  assert.equal(profileOf('node x.js "note--user-data-dir=/tmp/vam-x-AAAAAA/p"'), null, 'the flag must be an argument of its own');
});

test('heavy lock: the CI marker ci-<pid> passes only with CI=true, so ci-$$ typed in a shell cannot skip the lock', async () => {
  const { isReentrant } = await lib();
  const dir = tmp('vam-heavy-lock-');
  const procs = [{ pid: 5, ppid: 1, pgid: 5, command: 'shell' }, { pid: 6, ppid: 5, pgid: 5, command: 'node' }];
  try {
    assert.equal(isReentrant({ VAM_HEAVY_LOCK_HELD: 'ci-5' }, dir, 6, procs), false);
    assert.equal(isReentrant({ VAM_HEAVY_LOCK_HELD: 'ci-5', CI: 'false' }, dir, 6, procs), false);
    assert.equal(isReentrant({ VAM_HEAVY_LOCK_HELD: 'ci-5', CI: 'true' }, dir, 6, procs), true);
    assert.equal(isReentrant({ VAM_HEAVY_LOCK_HELD: 'ci-7', CI: 'true' }, dir, 6, procs), false, 'still has to be an ancestor');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('heavy lock: a ci-<ancestor shell pid> token typed in a shell queues behind a live holder', async () => {
  const dir = tmp('vam-heavy-lock-');
  const holder = node(holderScript('real-holder', 60000), cleanEnv(dir));
  let forged;
  try {
    await holder.waitFor(/held \d+/);
    const inner = `import { enterHeavy } from ${JSON.stringify(moduleUrl)}; await enterHeavy('forger', { pollMs: 50, reportMs: 100 }); console.log('held');`;
    forged = spawn('sh', ['-c', `VAM_HEAVY_LOCK_HELD=ci-$$ node --input-type=module -e "$0"; true`, inner], { env: cleanEnv(dir), stdio: ['ignore', 'pipe', 'pipe'], detached: true }); // no exec: the shell stays an ancestor of node
    let output = '';
    forged.stdout.on('data', c => { output += c; }); forged.stderr.on('data', c => { output += c; });
    for (let i = 0; i < 400 && !/等 \d+|held/.test(output); i++) await sleep(50);
    assert.match(output, /等 \d+/, 'queued behind the holder');
    assert.doesNotMatch(output, /held/);
  } finally { if (forged) try { process.kill(-forged.pid, 'SIGKILL'); } catch { /* gone */ } await stop(holder); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('heavy lock: a recycled pid is not the holder: the lock records the process start time and a mismatch is reclaimed', async () => {
  const { ownerAlive, startTimeOf } = await lib();
  assert.ok(startTimeOf(process.pid), 'ps tells the start time of this process');
  assert.equal(ownerAlive({ pid: process.pid, procStart: startTimeOf(process.pid) }), true);
  assert.equal(ownerAlive({ pid: process.pid, procStart: 'Mon Jan  1 00:00:00 1990' }), false);
  assert.equal(ownerAlive({ pid: 1, procStart: 'Mon Jan  1 00:00:00 1990' }), false, 'an EPERM pid with another start time is not the holder either');
  const dir = tmp('vam-heavy-lock-');
  try {
    fs.writeFileSync(lockFile(dir), JSON.stringify({ token: 'old', pid: process.pid, procStart: 'Mon Jan  1 00:00:00 1990', worktree: 'w', command: 'ghost', startedAt: new Date().toISOString() }));
    const next = node(holderScript('after-reboot', 0), cleanEnv(dir));
    await next.closed;
    assert.match(next.output, /收回鎖：持有者 pid \d+（w，ghost）已不存在/);
    assert.match(next.output, /held \d+/);
    assert.equal(fs.existsSync(lockFile(dir)), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('heavy lock: a holder killed with SIGKILL while its children still run is not reclaimed until they end; leaked test profiles are reported and stopped', async () => {
  const dir = tmp('vam-heavy-lock-');
  const profile = path.join(tmp('vam-heavy-lock-'), 'profile');
  const script = `
    import { spawn } from 'node:child_process';
    const { enterHeavy } = await import(${JSON.stringify(moduleUrl)});
    await enterHeavy('doomed', { pollMs: 50 });
    const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true });
    const chrome = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', '--user-data-dir=' + ${JSON.stringify(profile)}], { stdio: 'ignore', detached: true });
    console.log('kids ' + process.pid + ' ' + worker.pid + ' ' + chrome.pid);
    setInterval(() => {}, 1000);
  `;
  const doomed = node(script, cleanEnv(dir));
  let next, worker, chrome;
  try {
    await doomed.waitFor(/kids \d+ \d+ \d+/);
    [, , worker, chrome] = /kids (\d+) (\d+) (\d+)/.exec(doomed.stdout).map(Number);
    doomed.child.kill('SIGKILL'); await doomed.closed;
    next = node(holderScript('successor', 0), cleanEnv(dir));
    await next.waitFor(/子程序還在跑/);
    await sleep(300);
    assert.doesNotMatch(next.output, /held \d+/, 'the lock stays taken while a child of the dead holder runs');
    process.kill(worker, 'SIGKILL');
    await next.closed;
    assert.match(next.output, new RegExp(`持有者 pid ${doomed.child.pid} 留下仍存活的測試程序：pid ${chrome}[^\\n]*推得的測試檔 tests/suites/heavy-lock\\.cjs`));
    assert.match(next.output, /收回鎖/);
    assert.match(next.output, /held \d+/);
    await sleep(200);
    assert.equal(alive(chrome), false, 'the dead run\'s leaked profile process was stopped');
  } finally {
    for (const pid of [worker, chrome]) if (pid) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
    await stop(doomed, next); fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(path.dirname(profile), { recursive: true, force: true });
  }
});

test('heavy lock: SIGTERM stops the holder\'s whole subtree before the lock is released', async () => {
  const dir = tmp('vam-heavy-lock-');
  const script = `
    import { spawn } from 'node:child_process';
    const { enterHeavy } = await import(${JSON.stringify(moduleUrl)});
    await enterHeavy('tree', { pollMs: 50 });
    const sh = spawn('sh', ['-c', process.execPath + ' -e "setInterval(() => {}, 1000)" & wait'], { stdio: 'ignore' });
    await new Promise(resolve => setTimeout(resolve, 500));
    console.log('tree ' + sh.pid);
    setInterval(() => {}, 1000);
  `;
  const holder = node(script, cleanEnv(dir));
  try {
    await holder.waitFor(/tree \d+/);
    const { descendantsOf, snapshot } = await lib();
    const kids = descendantsOf(holder.child.pid, snapshot());
    assert.ok(kids.length >= 2, 'a shell and its node child run under the holder');
    holder.child.kill('SIGTERM');
    const exit = await holder.closed;
    assert.equal(exit.code, 143);
    assert.deepEqual(kids.filter(alive), [], 'nothing of the subtree outlives the released lock');
    assert.equal(fs.existsSync(lockFile(dir)), false);
  } finally { await stop(holder); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('heavy lock: the CLI wrapper passes SIGTERM to the whole command tree (wrapper, npm-like shell, node --test)', async () => {
  const dir = tmp('vam-heavy-lock-');
  const wrapper = spawn(process.execPath, [path.join(root, 'scripts', 'heavy-lock.mjs'), 'wrapped', '--', 'sh', '-c', `${process.execPath} -e "console.log('inner ' + process.pid); setInterval(() => {}, 1000)" && true`], { env: cleanEnv(dir), stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  wrapper.stdout.on('data', c => { output += c; }); wrapper.stderr.on('data', c => { output += c; });
  const closed = new Promise(resolve => wrapper.on('close', (code, signal) => resolve({ code, signal })));
  try {
    for (let i = 0; i < 200 && !/inner \d+/.test(output); i++) await sleep(50);
    const inner = Number(/inner (\d+)/.exec(output)[1]);
    assert.ok(alive(inner));
    wrapper.kill('SIGTERM');
    const exit = await closed;
    assert.equal(exit.code, 143);
    assert.equal(alive(inner), false, 'the grandchild did not survive the wrapper');
    assert.equal(fs.existsSync(lockFile(dir)), false);
  } finally { wrapper.kill('SIGKILL'); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('heavy lock: a blocking entry (spawnSync) dies on SIGTERM at once and its lock is kept until its child ended', async () => {
  const dir = tmp('vam-heavy-lock-');
  const script = `
    import { spawnSync } from 'node:child_process';
    const { enterHeavy } = await import(${JSON.stringify(moduleUrl)});
    await enterHeavy('blocking', { pollMs: 50, blocking: true });
    console.log('blocking ' + process.pid);
    spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 6000)'], { stdio: 'ignore' });
  `;
  const holder = node(script, cleanEnv(dir));
  let next;
  try {
    await holder.waitFor(/blocking \d+/);
    const { descendantsOf, snapshot } = await lib();
    let sleeper;
    for (let i = 0; i < 100 && !sleeper; i++) { sleeper = descendantsOf(holder.child.pid, snapshot())[0]; if (!sleeper) await sleep(50); }
    assert.ok(sleeper, 'the synchronous child runs');
    holder.child.kill('SIGTERM');
    const exit = await holder.closed;
    assert.equal(exit.signal, 'SIGTERM');
    assert.equal(alive(sleeper), true, 'SIGTERM ended the holder while its synchronous child was still running, not after it');
    next = node(holderScript('after-blocking', 0), cleanEnv(dir));
    await next.waitFor(/子程序還在跑/);
    assert.doesNotMatch(next.output, /held \d+/);
    await next.closed; // the 6 s child ends, then the lock is reclaimed
    assert.match(next.output, /收回鎖/);
  } finally { await stop(holder, next); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('heavy lock: the reclaim mutex of a live but stalled process is never broken; one of a dead process is', async () => {
  const { reclaimStale, startTimeOf } = await lib();
  const dir = tmp('vam-heavy-lock-');
  const mutex = path.join(dir, 'heavy-test.reclaim');
  const old = new Date(Date.now() - 60_000);
  const ghost = { token: 'ghost', pid: 2 ** 22 + 7, worktree: 'w', command: 'ghost', startedAt: new Date().toISOString() };
  const lines = [];
  try {
    fs.writeFileSync(lockFile(dir), JSON.stringify(ghost));
    fs.mkdirSync(mutex); fs.writeFileSync(path.join(mutex, 'owner'), JSON.stringify({ nonce: 'a', pid: process.pid, procStart: startTimeOf(process.pid) }));
    fs.utimesSync(mutex, old, old);
    for (let i = 0; i < 3; i++) assert.equal(reclaimStale(dir, line => lines.push(line)), false, 'a stalled live mutex owner keeps the mutex');
    assert.equal(owner(dir).token, 'ghost');
    fs.writeFileSync(path.join(mutex, 'owner'), JSON.stringify({ nonce: 'a', pid: 2 ** 22 + 9 }));
    assert.equal(reclaimStale(dir, line => lines.push(line)), false, 'breaking a dead mutex takes the turn');
    assert.equal(reclaimStale(dir, line => lines.push(line)), true);
    assert.equal(fs.existsSync(lockFile(dir)), false);
    assert.equal(fs.existsSync(mutex), false, 'the mutex is released');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('heavy lock: a racer renaming its mutex in while the holder removes its own is not an error and keeps its mutex', async () => {
  const { reclaimStale } = await lib();
  const dir = tmp('vam-heavy-lock-');
  const mutex = path.join(dir, 'heavy-test.reclaim');
  const ghost = { token: 'ghost', pid: 2 ** 22 + 7, worktree: 'w', command: 'ghost', startedAt: new Date().toISOString() };
  const realRm = fs.rmSync;
  let raced = false;
  // Recursive removal deletes the files first and the folder last; the racer's complete mutex folder lands between those two steps.
  const wrapper = (target, options) => {
    const name = path.basename(String(target));
    if (raced || !(name === 'heavy-test.reclaim' || name.startsWith('.mutex-dropped-'))) return realRm(target, options);
    raced = true;
    for (const entry of fs.readdirSync(target)) realRm(path.join(target, entry), { recursive: true, force: true });
    const pending = path.join(dir, '.mutex-racerpending');
    fs.mkdirSync(pending); fs.writeFileSync(path.join(pending, 'owner'), JSON.stringify({ nonce: 'racer', pid: process.pid }));
    fs.renameSync(pending, mutex);
    fs.rmdirSync(target);
  };
  try {
    fs.writeFileSync(lockFile(dir), JSON.stringify(ghost));
    fs.rmSync = wrapper; require('node:module').syncBuiltinESMExports();
    try { assert.doesNotThrow(() => reclaimStale(dir, () => {})); } finally { fs.rmSync = realRm; require('node:module').syncBuiltinESMExports(); }
    assert.equal(raced, true, 'the racer got in while the holder was removing its mutex');
    assert.equal(JSON.parse(fs.readFileSync(path.join(mutex, 'owner'), 'utf8')).nonce, 'racer', 'the racer keeps the mutex it took');
    assert.deepEqual(fs.readdirSync(dir).filter(name => name.startsWith('.mutex-')), [], 'no leftover mutex folders');
  } finally { fs.rmSync = realRm; require('node:module').syncBuiltinESMExports(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('heavy lock: --require-held refuses to run outside the lock, with no token or a forged one, and runs under the wrapper', async () => {
  const cli = path.join(root, 'scripts', 'heavy-lock.mjs');
  const dir = tmp('vam-heavy-lock-');
  const run = (env, args) => require('node:child_process').spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8' });
  try {
    const bare = run(cleanEnv(dir), ['--require-held']);
    assert.equal(bare.status, 1); assert.match(bare.stderr, /只能在重量級鎖內執行/);
    assert.equal(run(cleanEnv(dir, { VAM_HEAVY_LOCK_HELD: 'forged' }), ['--require-held']).status, 1);
    const holder = node(holderScript('other', 60000), cleanEnv(dir));
    try {
      await holder.waitFor(/held \d+/);
      assert.equal(run(cleanEnv(dir, { VAM_HEAVY_LOCK_HELD: owner(dir).token }), ['--require-held']).status, 1, 'the real token from a non-descendant fails');
    } finally { await stop(holder); }
    const wrapped = run(cleanEnv(dir), ['guard', '--', process.execPath, cli, '--require-held']);
    assert.equal(wrapped.status, 0, wrapped.stderr);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('heavy lock: a moved VAM_HEAVY_LOCK_DIR is said out loud', async () => {
  const dir = tmp('vam-heavy-lock-');
  const run = node(holderScript('moved', 0), cleanEnv(dir));
  try { await run.closed; assert.match(run.output, new RegExp(`鎖位置改為 ${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
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
