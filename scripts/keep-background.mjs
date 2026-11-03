// Detached watcher: keeps one harness-launched Obsidian instance out of the owner's foreground for its whole life.
// Obsidian 1.14+ opens Settings etc. in new windows and each one activates the app, so a short launch-time window is not enough.
// Usage: node keep-background.mjs <app-profile> <obsidian-app-bundle>
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// The pattern is built here, never passed as an argument: a watcher whose own command line contained it would match
// its own pgrep and never exit.
// `--` keeps pgrep/pkill from reading the pattern as an option; matching the main executable leaves helpers to it.
export const instancePattern = appProfile => `MacOS/Obsidian --user-data-dir=${appProfile}`;

// Pure decision: remember whatever is in front when it is not this instance; hand focus back only when this instance
// itself is in front, an owner app is known, and the allow-focus switch is off.
export function focusAction({ frontPid, frontPath, instancePid, ownerApp = null, allowFocus = false, testPids = [], ownerAlive = true, obsidianPath }) {
  if (!Number.isFinite(frontPid) || !frontPath) return { ownerApp, reopen: false };
  // Another harness instance in front is not the owner's app: keep what was recorded.
  if (frontPid !== instancePid && testPids.includes(frontPid)) return { ownerApp, reopen: false };
  if (frontPid !== instancePid) return { ownerApp: { pid: frontPid, path: frontPath }, reopen: false };
  // The owner quit their app: reopening it would relaunch what they just closed.
  if (ownerApp && !ownerAlive) return { ownerApp: null, reopen: false };
  // The owner's own Obsidian shares the bundle path: `open -a` could pick a test instance, so never target it.
  return { ownerApp, reopen: Boolean(ownerApp?.path) && !allowFocus && ownerApp.path !== obsidianPath };
}

export function frontApp() {
  const info = spawnSync("sh", ["-c", "lsappinfo info -only pid -only bundlepath \"$(lsappinfo front)\""], { encoding: "utf8" }).stdout ?? "";
  return { pid: Number(/"pid"=(\d+)/.exec(info)?.[1]), path: /"LSBundlePath"="([^"]+)"/.exec(info)?.[1] };
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

export function watch(appProfile, obsidianApp, previous = frontApp(), intervalSeconds = 0.2) {
  const pattern = instancePattern(appProfile);
  let started = false;
  let misses = 0;
  let ownerApp = previous.path ? previous : null;
  for (;;) {
    const found = spawnSync("pgrep", ["-f", "--", pattern], { encoding: "utf8" });
    const instancePid = Number(found.stdout.trim().split("\n")[0]);
    if (found.status !== 0 || !instancePid) {
      // Launch is asynchronous: give `open` a moment to create the process before treating absence as the end.
      if (!started) { misses++; if (misses < 100) { spawnSync("sleep", [String(intervalSeconds)]); continue; } }
      return;
    }
    started = true;
    const front = frontApp();
    const testPids = spawnSync("pgrep", ["-f", "--", "MacOS/Obsidian --user-data-dir="], { encoding: "utf8" }).stdout.split("\n").filter(Boolean).map(Number);
    const action = focusAction({ frontPid: front.pid, frontPath: front.path, instancePid, ownerApp, allowFocus: existsSync(join(appProfile, "allow-focus")), testPids, ownerAlive: ownerApp ? processAlive(ownerApp.pid) : true, obsidianPath: obsidianApp });
    ownerApp = action.ownerApp;
    if (action.reopen) spawnSync("open", ["-a", ownerApp.path]);
    spawnSync("sleep", [String(intervalSeconds)]);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [appProfile, obsidianApp, ownerPid, ownerPath] = process.argv.slice(2);
  watch(appProfile, obsidianApp, ownerPath ? { pid: Number(ownerPid), path: ownerPath } : { pid: NaN, path: undefined });
}
