// Machine-wide queue lock for the heavy test entries (npm test, test:unit, test:integration, test:affected --run, test:runtime, test:aim),
// plus an end-of-run check that stops the test processes (headless Chrome, test Obsidian) this run left behind.
//
//   import { enterHeavy } from "./heavy-lock.mjs";  await enterHeavy("test:unit");
//   node scripts/heavy-lock.mjs <label> -- <command> [args...]      (wraps a shell-level script such as test:aim)
//
// The lock is one file, <VAM_HEAVY_LOCK_DIR or ~/Library/Caches/vam>/heavy-test.lock, created atomically with link(2); it holds
// {token, pid, worktree, command, startedAt}. VAM_HEAVY_LOCK_DIR only moves the file, nothing skips the lock.
// Re-entry: the holder exports VAM_HEAVY_LOCK_HELD=<token>; a child passes through only when that token is the one in the lock file
// AND the holder pid is one of its ancestors, so a forged token or a stranger's lock never passes.
// CI=true takes no lock (the check at the end still runs). Waiting never times out; a holder pid that no longer exists is reclaimed.
import { randomBytes } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
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

// Only the one process holding the short reclaim mutex may remove a stale lock, and it re-reads the lock inside, so two waiters cannot
// both delete and one of them remove the lock the other just took.
export function reclaimStale(dir, log = out) {
  const mutex = join(dir, MUTEX_NAME);
  try { mkdirSync(mutex); } catch (error) {
    if (error.code !== "EEXIST") throw error;
    try { if (Date.now() - statSync(mutex).mtimeMs > 10_000) rmSync(mutex, { recursive: true, force: true }); } catch { /* gone already */ }
    return false;
  }
  try {
    const owner = readOwner(dir);
    if (owner && Number.isInteger(owner.pid) && !pidAlive(owner.pid)) {
      unlinkSync(lockPath(dir));
      log(`收回鎖：持有者 pid ${owner.pid}（${owner.worktree}，${owner.command}）已不存在。`);
      return true;
    }
    if (!owner && existsSync(lockPath(dir)) && Date.now() - statSync(lockPath(dir)).mtimeMs > 10_000) { unlinkSync(lockPath(dir)); log("收回鎖：鎖檔損毀。"); return true; }
    return false;
  } catch (error) { if (error.code === "ENOENT") return false; throw error; } finally { rmSync(mutex, { recursive: true, force: true }); }
}

export function releaseLock(dir, token) {
  const owner = readOwner(dir);
  if (owner?.token === token) rmSync(lockPath(dir), { force: true });
}

// True when this process runs under the holder: same token as the lock file (or the CI marker) and the holder pid is an ancestor.
export function isReentrant(env, dir, pid = process.pid, procs = snapshot()) {
  const token = env.VAM_HEAVY_LOCK_HELD;
  if (!token) return false;
  const ancestors = ancestorsOf(pid, procs);
  const ci = /^ci-(\d+)$/.exec(token);
  if (ci) return ancestors.includes(Number(ci[1]));
  const owner = readOwner(dir);
  return Boolean(owner && owner.token === token && ancestors.includes(owner.pid) && pidAlive(owner.pid));
}

export async function acquire({ dir, label, worktree = root, pollMs = 1000, reportMs = 30_000, log = out, sleep = delay, now = Date.now } = {}) {
  const token = randomBytes(8).toString("hex");
  const record = { token, pid: process.pid, worktree, command: label, startedAt: new Date().toISOString() };
  const waitStart = now();
  let lastReport = -Infinity;
  for (;;) {
    if (tryAcquire(dir, record)) return { token, record };
    if (reclaimStale(dir, log)) continue;
    const owner = readOwner(dir);
    if (owner && now() - lastReport >= reportMs) {
      lastReport = now();
      log(`等 ${owner.pid} ${owner.worktree} ${owner.command}，已等 ${Math.round((now() - waitStart) / 1000)} 秒`);
    }
    await sleep(pollMs);
  }
}

// ---- the end-of-run check ----
const profileOf = command => /--user-data-dir=(.*?)(?=\s--|$)/.exec(command)?.[1]?.replace(/^"|"$/g, "") ?? null;
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

// What exists when the run starts: a later orphan with a profile or pid from this set is not ours.
export function baseline(procs, roots = tmpRoots()) {
  const profiles = new Set();
  for (const p of procs) { const profile = profileOf(p.command); if (profile && classify(profile, roots)) profiles.add(profile); }
  return { pids: new Set(procs.map(p => p.pid)), profiles };
}

// Test processes this run left alive. Ours = the main process of a test profile is a descendant of this process, or it was orphaned
// (parent 1) with a pid and profile that did not exist when the run started. A process whose parent is alive and elsewhere belongs to
// another run (or to the user) and is never listed; a profile that is not a test profile is never listed.
export function findLeaks({ procs, selfPid = process.pid, start, roots = tmpRoots(), keep = [] }) {
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
    const owned = mains.some(p => mine.has(p.pid) || (p.ppid === 1 && !start.pids.has(p.pid) && !start.profiles.has(profile)));
    if (!owned) continue;
    const tree = new Set(group.map(p => p.pid));
    for (const main of mains) for (const pid of descendantsOf(main.pid, procs)) tree.add(pid);
    leaks.push({ kind: classify(profile, roots), profile, pid: mains[0].pid, pids: [...tree], groups: mains.filter(p => p.pgid === p.pid).map(p => p.pgid) });
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

export function killLeaks(leaks, selfPgid) {
  const all = [...new Set(leaks.flatMap(l => l.pids))];
  const send = (pid, signal) => { try { process.kill(pid, signal); } catch { /* gone */ } };
  for (const leak of leaks) for (const group of leak.groups) if (group !== selfPgid) send(-group, "SIGTERM");
  for (const pid of all) send(pid, "SIGTERM");
  for (let i = 0; i < 20 && all.some(pidAlive); i++) sleepSync(100);
  for (const pid of all) if (pidAlive(pid)) send(pid, "SIGKILL");
}

export function checkAtEnd({ start, repo = root, keep = [], log = out, kill = true }) {
  let procs;
  try { procs = snapshot(); } catch (error) { log(`結束時檢查略過，原因：ps 無法執行（${error.message}）`); return []; }
  const leaks = findLeaks({ procs, start, keep });
  for (const leak of leaks) log(`本次 run 留下仍存活的測試程序（${leak.kind}）：pid ${leak.pid}（共 ${leak.pids.length} 個）profile ${leak.profile}，推得的測試檔 ${inferTestFile(leak.profile, repo)}`);
  if (leaks.length && kill) killLeaks(leaks, procs.find(p => p.pid === process.pid)?.pgid);
  return leaks;
}

// Profiles a test entry launched on purpose and leaves for the owner (the harness's Obsidian); never reported as leaks.
const kept = [];
export const keepProfile = profile => { kept.push(profile); };

// ---- entry ----
let entered = false;
export async function enterHeavy(label, { env = process.env, dir = lockDir(env), ...options } = {}) {
  if (entered) return;
  if (isReentrant(env, dir)) return; // under the holder: it locks and checks for this whole tree
  entered = true;
  const ci = env.CI === "true";
  let held = null, finished = false, start;
  try { start = baseline(snapshot()); } catch { start = { pids: new Set(), profiles: new Set() }; }
  const finish = () => {
    if (finished) return;
    finished = true;
    if (held) releaseLock(dir, held.token);
    const leaks = checkAtEnd({ start, keep: kept });
    if (leaks.length && !process.exitCode) process.exitCode = 1;
  };
  const onSignal = signal => { finish(); process.exit(128 + ({ SIGINT: 2, SIGTERM: 15, SIGHUP: 1 }[signal] ?? 1)); };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => onSignal(signal));
  process.on("exit", finish);
  if (ci) { env.VAM_HEAVY_LOCK_HELD = `ci-${process.pid}`; return; }
  held = await acquire({ dir, label, ...options });
  env.VAM_HEAVY_LOCK_HELD = held.token;
}

// CLI wrapper: node scripts/heavy-lock.mjs <label> -- <command> [args...]
async function cli(argv) {
  const split = argv.indexOf("--");
  if (split < 1 || split === argv.length - 1) { process.stderr.write("usage: heavy-lock.mjs <label> -- <command> [args...]\n"); process.exit(2); }
  let child = null;
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child?.kill(signal)); // before enterHeavy's handler, which exits
  await enterHeavy(argv.slice(0, split).join(" "));
  const [command, ...args] = argv.slice(split + 1);
  child = spawn(command, args, { stdio: "inherit", env: process.env });
  child.on("close", (code, signal) => { process.exitCode = code ?? (signal ? 128 : 1); });
  child.on("error", error => { out(`cannot start ${command}: ${error.message}`); process.exitCode = 1; });
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await cli(process.argv.slice(2));
