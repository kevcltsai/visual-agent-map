// Machine-wide queue lock for the heavy test entries (npm test, test:unit, test:integration, test:affected --run, test:runtime, test:aim),
// plus an end-of-run check that stops the test processes (headless Chrome, test Obsidian) this run left behind.
//
//   import { enterHeavy } from "./heavy-lock.mjs";  await enterHeavy("test:unit");
//   node scripts/heavy-lock.mjs <label> -- <command> [args...]      (wraps a shell-level script such as test:aim)
//
// The lock is one file, <VAM_HEAVY_LOCK_DIR or ~/Library/Caches/vam>/heavy-test.lock, created atomically with link(2); it holds
// {token, pid, worktree, command, startedAt}. VAM_HEAVY_LOCK_DIR only moves the file, nothing skips the lock.
// Re-entry: the holder exports VAM_HEAVY_LOCK_HELD=<token>; a child passes through only when that token is the one in the lock file
// AND the holder pid is one of its ancestors, so a forged token or a stranger's lock never passes. The CI marker ci-<pid> counts only
// when CI=true.
// CI=true takes no lock (the check at the end still runs). Waiting never times out. A holder is gone when its pid no longer exists or
// the pid now belongs to another process (the lock records the process start time); a gone holder's lock is reclaimed only after every
// process still carrying its token (children of a SIGKILLed run) has ended, and test-profile processes among them are reported and stopped.
// Ownership of a leaked process = a descendant of this run, or a process whose environment carries this run's token (children inherit it,
// so it survives reparenting to pid 1; `open`-launched apps and other runs' processes never carry it).
import { randomBytes } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, relative, sep } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = fileURLToPath(new URL("..", import.meta.url));
const LOCK_NAME = "heavy-test.lock";
const MUTEX_NAME = "heavy-test.reclaim";
const out = line => process.stderr.write(`heavy-lock: ${line}\n`);

export function lockDir(env = process.env) {
  if (env.VAM_HEAVY_LOCK_DIR) return env.VAM_HEAVY_LOCK_DIR;
  return process.platform === "darwin" ? join(homedir(), "Library", "Caches", "vam") : join(homedir(), ".cache", "vam");
}

export function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; }
}

// Start time of a pid as ps prints it ("Tue Nov  3 19:20:13 2026"); null when ps cannot say. Recorded in the lock so a recycled pid is not mistaken for the holder.
export function startTimeOf(pid) {
  try { return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" }, stdio: ["ignore", "pipe", "ignore"] }).trim() || null; } catch { return null; }
}

// The recorded process is still the one that took the lock: its pid exists and (when recorded) still started at the same time.
export function ownerAlive(owner, startOf = startTimeOf) {
  if (!Number.isInteger(owner?.pid) || !pidAlive(owner.pid)) return false;
  if (!owner.procStart) return true;
  const now = startOf(owner.pid);
  return now === null || now === owner.procStart;
}

const sleepSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// One snapshot of every process: [{ pid, ppid, pgid, command }].
export function snapshot() {
  const text = execFileSync("ps", ["-axo", "pid=,ppid=,pgid=,command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const procs = [];
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match) procs.push({ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), command: match[4] });
  }
  return procs;
}

export function ancestorsOf(pid, procs) {
  const parent = new Map(procs.map(p => [p.pid, p.ppid]));
  const chain = [];
  for (let at = parent.get(pid); at && at > 1 && !chain.includes(at); at = parent.get(at)) chain.push(at);
  return chain;
}

export function descendantsOf(pid, procs) {
  const children = new Map();
  for (const p of procs) children.set(p.ppid, [...(children.get(p.ppid) ?? []), p.pid]);
  const found = [];
  for (const queue = [pid]; queue.length;) for (const child of children.get(queue.shift()) ?? []) if (!found.includes(child)) { found.push(child); queue.push(child); }
  return found;
}

// pids (a Set; null when ps cannot run) whose environment carries VAM_HEAVY_LOCK_HELD=<token> (own-user processes only; macOS: ps eww prints the environment after the arguments, Linux: /proc/<pid>/environ).
export function tokenCarriers(token, selfPid = process.pid) {
  const needle = `VAM_HEAVY_LOCK_HELD=${token}\0`;
  if (existsSync("/proc/self/environ")) { // Linux: ps does not print the environment with -o, /proc does
    const found = new Set();
    for (const name of readdirSync("/proc")) {
      if (!/^\d+$/.test(name) || Number(name) === selfPid) continue;
      try { if (readFileSync(`/proc/${name}/environ`, "latin1").includes(needle)) found.add(Number(name)); } catch { /* not ours to read, or gone */ }
    }
    return found;
  }
  let text;
  try { text = execFileSync("ps", ["eww", "-axo", "pid=,command="], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }); } catch { return null; }
  const marker = new RegExp(`(?:^|\\s)VAM_HEAVY_LOCK_HELD=${token.replace(/[^\w-]/g, "")}(?:\\s|$)`);
  const found = [];
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match && Number(match[1]) !== selfPid && marker.test(match[2])) found.push(Number(match[1]));
  }
  return new Set(found);
}

// ---- the lock ----
const lockPath = dir => join(dir, LOCK_NAME);
export function readOwner(dir) {
  try { return JSON.parse(readFileSync(lockPath(dir), "utf8")); } catch { return null; }
}

// Atomic create: the complete record is written to a private file, then linked to the lock name (EEXIST when someone holds it).
export function tryAcquire(dir, record) {
  mkdirSync(dir, { recursive: true });
  const mine = join(dir, `.pending-${record.token}`);
  writeFileSync(mine, JSON.stringify(record));
  try { linkSync(mine, lockPath(dir)); return true; } catch (error) { if (error.code === "EEXIST") return false; throw error; } finally { rmSync(mine, { force: true }); }
}

// ---- reclaiming a dead holder ----
const readJson = file => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; } };

// The reclaim mutex is a folder created complete (it already holds its owner file) and renamed into place, so it is never seen half-made.
// A held mutex is broken only when its owner process is gone; a live but stalled owner (Ctrl-Z, sleeping laptop) keeps it.
function takeMutex(dir) {
  const mutex = join(dir, MUTEX_NAME);
  const nonce = randomBytes(6).toString("hex");
  const pending = join(dir, `.mutex-${nonce}`);
  mkdirSync(pending, { recursive: true });
  writeFileSync(join(pending, "owner"), JSON.stringify({ nonce, pid: process.pid, procStart: startTimeOf(process.pid) }));
  try { renameSync(pending, mutex); return nonce; } catch (error) {
    rmSync(pending, { recursive: true, force: true });
    if (error.code !== "EEXIST" && error.code !== "ENOTEMPTY") throw error;
  }
  const held = readJson(join(mutex, "owner"));
  let stale;
  try { stale = held ? !ownerAlive(held) : Date.now() - statSync(mutex).mtimeMs > 10_000; } catch { return null; }
  if (stale) { // move it away first (atomic), so two breakers cannot both remove and one remove a mutex the other just took
    const tomb = join(dir, `.mutex-stale-${nonce}`);
    try { renameSync(mutex, tomb); } catch { return null; }
    rmSync(tomb, { recursive: true, force: true });
  }
  return null;
}
// Moved away before it is emptied, so the mutex path never holds a folder that is ours but already half-removed (a racer renaming into it would make rmdir fail ENOTEMPTY).
function dropMutex(dir, nonce) {
  const mutex = join(dir, MUTEX_NAME);
  if (readJson(join(mutex, "owner"))?.nonce !== nonce) return;
  const tomb = join(dir, `.mutex-dropped-${nonce}`);
  try { renameSync(mutex, tomb); } catch (error) { if (error.code === "ENOENT") return; throw error; }
  rmSync(tomb, { recursive: true, force: true });
}

// Processes still alive that carry a dead holder's token: the test-profile ones are its leaks, anything else is still running its tests.
function afterlife(owner) {
  const carriers = tokenCarriers(owner.token);
  if (!carriers?.size) return { busy: [], leaks: [] };
  let procs;
  try { procs = snapshot(); } catch { return { busy: [], leaks: [] }; }
  const roots = tmpRoots();
  const busy = [], leaks = [];
  for (const p of procs) {
    if (!carriers.has(p.pid)) continue;
    const profile = profileOf(p.command);
    if (profile && classify(profile, roots)) leaks.push(p); else busy.push(p);
  }
  return { busy, leaks };
}

// Removes the lock of a gone holder. Returns true when the lock is free to take. A holder whose children still run is not reclaimed.
export function reclaimStale(dir, log = out, { onDraining } = {}) {
  const nonce = takeMutex(dir);
  if (!nonce) return false;
  try {
    const owner = readOwner(dir);
    if (owner && Number.isInteger(owner.pid) && !ownerAlive(owner)) {
      const { busy, leaks } = afterlife(owner);
      if (busy.length) { onDraining?.(owner, busy); return false; }
      for (const leak of leaks) log(`持有者 pid ${owner.pid} 留下仍存活的測試程序：pid ${leak.pid} profile ${profileOf(leak.command)}，推得的測試檔 ${inferTestFile(profileOf(leak.command))}，結束它`);
      if (leaks.length) killPids(leaks.map(l => l.pid), leaks.filter(l => l.pgid === l.pid).map(l => l.pgid));
      if (readOwner(dir)?.token !== owner.token) return false; // the lock changed hands while we looked
      unlinkSync(lockPath(dir));
      log(`收回鎖：持有者 pid ${owner.pid}（${owner.worktree}，${owner.command}）已不存在。`);
      return true;
    }
    if (!owner && existsSync(lockPath(dir)) && Date.now() - statSync(lockPath(dir)).mtimeMs > 10_000) { unlinkSync(lockPath(dir)); log("收回鎖：鎖檔損毀。"); return true; }
    return false;
  } catch (error) { if (error.code === "ENOENT") return false; throw error; } finally { dropMutex(dir, nonce); }
}

export function releaseLock(dir, token) {
  const owner = readOwner(dir);
  if (owner?.token === token) rmSync(lockPath(dir), { force: true });
}

// True when this process runs under the holder: same token as the lock file and the holder pid is an ancestor. The CI marker ci-<pid>
// counts only when CI=true (a shell variable such as ci-$$ must not pass for a local run).
export function isReentrant(env, dir, pid = process.pid, procs = snapshot()) {
  const token = env.VAM_HEAVY_LOCK_HELD;
  if (!token) return false;
  const ancestors = ancestorsOf(pid, procs);
  const ci = /^ci-(\d+)$/.exec(token);
  if (ci) return env.CI === "true" && ancestors.includes(Number(ci[1]));
  const owner = readOwner(dir);
  return Boolean(owner && owner.token === token && ancestors.includes(owner.pid) && ownerAlive(owner));
}

export async function acquire({ dir, label, worktree = root, pollMs = 1000, reportMs = 30_000, log = out, sleep = delay, now = Date.now } = {}) {
  const token = randomBytes(8).toString("hex");
  const record = { token, pid: process.pid, procStart: startTimeOf(process.pid), worktree, command: label, startedAt: new Date().toISOString() };
  const waitStart = now();
  let lastReport = -Infinity;
  const report = line => { if (now() - lastReport >= reportMs) { lastReport = now(); log(line); } };
  const onDraining = (owner, busy) => report(`持有者 ${owner.pid} 已結束，但它的 ${busy.length} 個子程序還在跑（pid ${busy.slice(0, 5).map(p => p.pid).join(" ")}），等它們結束`);
  for (;;) {
    if (tryAcquire(dir, record)) return { token, record };
    if (reclaimStale(dir, log, { onDraining })) continue;
    const owner = readOwner(dir);
    if (owner && ownerAlive(owner)) report(`等 ${owner.pid} ${owner.worktree} ${owner.command}，已等 ${Math.round((now() - waitStart) / 1000)} 秒`);
    await sleep(pollMs);
  }
}

// ---- the end-of-run check ----
// The argument is "--user-data-dir=<path>" on its own; a shell or grep that only mentions it in text does not count.
const NOT_A_BROWSER = new Set(["sh", "bash", "zsh", "dash", "fish", "ksh", "csh", "tcsh", "pgrep", "pkill", "grep", "egrep", "rg", "ps", "awk", "sed", "tail", "head", "cat", "less", "watch", "tee", "xargs", "env", "time", "sudo"]);
export const profileOf = command => {
  if (NOT_A_BROWSER.has(basename(command.trim().split(/\s/)[0]).replace(/^-/, ""))) return null;
  return /(?:^|\s)--user-data-dir=(.*?)(?=\s--|$)/.exec(command)?.[1]?.replace(/^"|"$/g, "") ?? null;
};
const realOrSame = path => { try { return realpathSync(path); } catch { return path; } };

// A test profile is a headless-Chrome profile under the temp dir whose first folder starts with "vam-", or a Obsidian ".vam-app" profile.
export function classify(profile, tmpRoots) {
  if (!profile) return null;
  if (basename(profile) === ".vam-app") return "obsidian";
  for (const base of tmpRoots) {
    const rel = relative(base, profile);
    if (rel && !rel.startsWith("..") && !rel.startsWith(sep) && rel.split(sep)[0].startsWith("vam-")) return "chrome";
  }
  return null;
}

export const tmpRoots = () => [...new Set([tmpdir(), realOrSame(tmpdir()), "/tmp", "/private/tmp"])];

// Test processes this run left alive. A profile group is ours when its main process is a descendant of this process, or its environment
// carries this run's token (`carries(pid)`; an orphan keeps the token after it is reparented to pid 1). Nothing else is ever listed: a
// run without the token (another worktree, a smoke or --session Obsidian opened through `open`, the user's own apps) is not ours, however
// new it is. A profile that is not a test profile is never listed.
export function findLeaks({ procs, selfPid = process.pid, roots = tmpRoots(), keep = [], carries = () => false }) {
  const mine = new Set(descendantsOf(selfPid, procs));
  const byProfile = new Map();
  for (const p of procs) {
    const profile = profileOf(p.command);
    if (!profile || p.pid === selfPid || !classify(profile, roots)) continue;
    byProfile.set(profile, [...(byProfile.get(profile) ?? []), p]);
  }
  const leaks = [];
  for (const [profile, group] of byProfile) {
    if (keep.includes(profile)) continue;
    const pids = new Set(group.map(p => p.pid));
    const mains = group.filter(p => !pids.has(p.ppid));
    const ours = mains.filter(p => mine.has(p.pid) || carries(p.pid));
    if (!ours.length) continue;
    const tree = new Set(group.map(p => p.pid));
    for (const main of ours) for (const pid of descendantsOf(main.pid, procs)) tree.add(pid);
    leaks.push({ kind: classify(profile, roots), profile, pid: ours[0].pid, pids: [...tree], groups: ours.filter(p => p.pgid === p.pid).map(p => p.pgid) });
  }
  return leaks;
}

// The test file whose temp prefix the profile folder carries (vam-<prefix>-<random>/...), found by reading tests/suites.
export function inferTestFile(profile, repo = root, roots = tmpRoots()) {
  const base = roots.map(r => relative(r, profile)).find(rel => rel && !rel.startsWith(".."));
  const folder = base?.split(sep)[0];
  if (!folder) return "unknown";
  const prefix = folder.replace(/-[A-Za-z0-9]{6}$/, "");
  const dir = join(repo, "tests", "suites");
  try {
    for (const file of readdirSync(dir).sort()) if (readFileSync(join(dir, file), "utf8").includes(`"${prefix}-`) || readFileSync(join(dir, file), "utf8").includes(`'${prefix}-`)) return `tests/suites/${file}`;
    const named = prefix.replace(/^vam-/, "");
    if (existsSync(join(dir, `${named}.cjs`))) return `tests/suites/${named}.cjs`;
  } catch { /* no suites folder */ }
  return "unknown";
}

function killPids(all, groups, selfPgid) {
  const send = (pid, signal) => { try { process.kill(pid, signal); } catch { /* gone */ } };
  for (const group of groups) if (group !== selfPgid) send(-group, "SIGTERM");
  for (const pid of all) send(pid, "SIGTERM");
  for (let i = 0; i < 20 && all.some(pidAlive); i++) sleepSync(100);
  for (const pid of all) if (pidAlive(pid)) send(pid, "SIGKILL");
}
export function killLeaks(leaks, selfPgid) {
  killPids([...new Set(leaks.flatMap(l => l.pids))], leaks.flatMap(l => l.groups), selfPgid);
}

export function checkAtEnd({ token, repo = root, keep = [], log = out, kill = true, carriersOf = tokenCarriers }) {
  let procs;
  try { procs = snapshot(); } catch (error) { log(`結束時檢查略過，原因：ps 無法執行（${error.message}）`); return []; }
  let carriers;
  const carries = pid => { carriers ??= (token && carriersOf(token)) || new Set(); return carriers.has(pid); };
  const leaks = findLeaks({ procs, keep, carries });
  for (const leak of leaks) log(`本次 run 留下仍存活的測試程序（${leak.kind}）：pid ${leak.pid}（共 ${leak.pids.length} 個）profile ${leak.profile}，推得的測試檔 ${inferTestFile(leak.profile, repo)}`);
  if (leaks.length && kill) killLeaks(leaks, procs.find(p => p.pid === process.pid)?.pgid);
  return leaks;
}

// Profiles a test entry launched on purpose and leaves for the owner (the harness's Obsidian); never reported as leaks.
const kept = [];
export const keepProfile = profile => { kept.push(profile); };

// SIGTERM the whole subtree of this process (npm, sh, node --test, shards, Chrome), wait for it, then SIGKILL what is left.
export async function stopTree(selfPid = process.pid, graceMs = 5000) {
  let procs;
  try { procs = snapshot(); } catch { return; }
  const tree = descendantsOf(selfPid, procs);
  const send = signal => { for (const pid of tree) try { process.kill(pid, signal); } catch { /* gone */ } };
  send("SIGTERM");
  for (let waited = 0; waited < graceMs && tree.some(pidAlive); waited += 100) await delay(100);
  send("SIGKILL");
}

// ---- entry ----
// { blocking: true } for entries that run their children with spawnSync: their event loop is blocked, so a signal listener would only
// run after everything finished and would turn SIGTERM into "ignored". After the lock is taken they keep the default signal behaviour
// (the process dies, the lock stays until its children have ended, then a waiter reclaims it).
let entered = false;
export async function enterHeavy(label, { env = process.env, dir = lockDir(env), blocking = false, ...options } = {}) {
  if (entered) return;
  if (isReentrant(env, dir)) return; // under the holder: it locks and checks for this whole tree
  entered = true;
  const ci = env.CI === "true";
  let held = null, finished = false, signalled = false;
  const token = ci ? `ci-${process.pid}` : randomBytes(8).toString("hex");
  const finish = () => {
    if (finished) return;
    finished = true;
    if (held) releaseLock(dir, held.token);
    const leaks = checkAtEnd({ token: held?.token ?? token, keep: kept });
    if (leaks.length && !process.exitCode) process.exitCode = 1;
  };
  const onSignal = async signal => {
    if (signalled) return;
    signalled = true;
    await stopTree(); // the lock must not be released while this run's processes still run
    finish();
    process.exit(128 + ({ SIGINT: 2, SIGTERM: 15, SIGHUP: 1 }[signal] ?? 1));
  };
  const listeners = ["SIGINT", "SIGTERM", "SIGHUP"].map(signal => [signal, () => onSignal(signal)]);
  for (const [signal, listener] of listeners) process.on(signal, listener);
  process.on("exit", finish);
  if (ci) { env.VAM_HEAVY_LOCK_HELD = token; return; }
  if (env.VAM_HEAVY_LOCK_DIR && dir !== lockDir({})) out(`鎖位置改為 ${dir}（不與預設位置的鎖互斥）`);
  held = await acquire({ dir, label, ...options });
  env.VAM_HEAVY_LOCK_HELD = held.token;
  if (blocking) for (const [signal, listener] of listeners) process.off(signal, listener);
}

// CLI wrapper: node scripts/heavy-lock.mjs <label> -- <command> [args...]
//              node scripts/heavy-lock.mjs --require-held     (guard for a script that must only run under the lock)
async function cli(argv) {
  if (argv[0] === "--require-held") {
    if (isReentrant(process.env, lockDir())) return;
    process.stderr.write("heavy-lock: 這個 script 只能在重量級鎖內執行；請用會排隊的入口（例如 npm run test:aim）。\n");
    process.exit(1);
  }
  const split = argv.indexOf("--");
  if (split < 1 || split === argv.length - 1) { process.stderr.write("usage: heavy-lock.mjs <label> -- <command> [args...]\n"); process.exit(2); }
  await enterHeavy(argv.slice(0, split).join(" "));
  const [command, ...args] = argv.slice(split + 1);
  const child = spawn(command, args, { stdio: "inherit", env: process.env });
  child.on("close", (code, signal) => { process.exitCode = code ?? (signal ? 128 : 1); });
  child.on("error", error => { out(`cannot start ${command}: ${error.message}`); process.exitCode = 1; });
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await cli(process.argv.slice(2));
