import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { focusAction, frontApp, instancePattern } from "./keep-background.mjs";
import { enterHeavy, keepProfile } from "./heavy-lock.mjs";
export { focusAction };
import { createTestVault, ensureSourceSelectionFixture } from "./create-onboarding-test-vault.mjs";
import { applyProviderGuard, parseLive } from "./provider-guard.mjs";
import { assertOwnerIdle, ownerBusyReasons, waitOwnerIdle } from "./owner-idle.mjs";
import { connectCdp } from "./obsidian-cdp.mjs";
import { sourceFingerprint } from "./candidate-id.mjs";
import { recordDevEvent, timedSync, timedAsync } from "./dev-metrics.mjs";
export { sourceFingerprint };

export const root = fileURLToPath(new URL("..", import.meta.url));
// The owner's vault must survive reboots (macOS clears /private/tmp), so it lives beside the main checkout, never under the temp session prefix.
// Worktrees resolve to the same vault through the git common dir; VAM_OWNER_VAULT overrides.
export function ownerVaultPath(checkout = root, env = process.env) {
  if (env.VAM_OWNER_VAULT) return resolve(env.VAM_OWNER_VAULT);
  let main = checkout;
  try {
    const common = execFileSync("git", ["-C", checkout, "rev-parse", "--git-common-dir"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (common) main = dirname(resolve(checkout, common));
  } catch { /* no git: fall back to this checkout */ }
  return join(dirname(resolve(main)), "vaults", "vam-e2e-current");
}
export const canonicalVault = ownerVaultPath();
const assets = ["main.js", "manifest.json", "styles.css"];
const viewerArtifact = "experiences/sharing/viewer-bundle.generated.ts";
const buildHashes = directory => ({ ...hashes(directory), viewer: hash(readFileSync(join(directory, viewerArtifact))) });
const marker = ".vam-test-environment.json";
const obsidianApp = "/Applications/Obsidian.app";
const hash = data => createHash("sha256").update(data).digest("hex");
const hashes = folder => Object.fromEntries(assets.map(name => [name, hash(readFileSync(join(folder, name)))]));
const json = path => JSON.parse(readFileSync(path, "utf8"));
// Names the checkout that owns a vault and the branch it is on, so a refused agent can say what it is waiting for.
function ownerCheckoutState(owner) {
  try { return `${owner} (on branch ${execFileSync("git", ["-C", owner, "branch", "--show-current"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || "detached HEAD"})`; }
  catch { return `${owner} (branch unknown)`; }
}

// A vault recorded for one checkout may also be updated from another checkout of the SAME git repo (e.g. a worktree), but only when that
// checkout is exactly origin/main with no tracked source edits: it can neither be behind main nor carry unmerged experiments.
// The generated main.js is tracked and rewritten by every build, so it alone is ignored here; styles.css is hand-written source.
export function sameRepoCleanMain(owner, checkout) {
  const git = (dir, ...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  const common = dir => realpathSync(resolve(dir, git(dir, "rev-parse", "--git-common-dir")));
  try {
    if (common(owner) !== common(checkout)) return false;
    if (git(checkout, "rev-parse", "HEAD") !== git(checkout, "rev-parse", "refs/remotes/origin/main")) return false;
    return git(checkout, "status", "--porcelain", "--untracked-files=normal", "--", ".", ":(exclude)main.js") === "";
  } catch { return false; }
}

// A candidate must contain origin/main (main itself, or a branch with its own commits on top), or the install would drop fixes
// already merged. Fetches first so the comparison is never against a stale remote ref.
export function assertContainsOriginMain(checkout = root) {
  const git = (...args) => execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("fetch", "-q", "origin");
  try { git("merge-base", "--is-ancestor", "refs/remotes/origin/main", "HEAD"); }
  catch { throw new Error(`Refusing to install: ${checkout} does not contain origin/main (${git("rev-list", "--count", "HEAD..refs/remotes/origin/main").trim()} commit(s) missing), so it would drop fixes already merged. Run git fetch origin && git rebase origin/main (or merge origin/main), then rerun --update-current.`); }
}

// The owner's canonical vault holds their own maps; the regression fixture maps are neither seeded into nor required of it.
// Session and --prepare vaults keep both. `owner` is a parameter only so tests can designate a temp vault.
const isOwnerVault = (vault, owner = canonicalVault) => resolve(vault) === resolve(owner);

export function verifyTestVault(vault, artifact = root, owner = canonicalVault) {
  const record = json(join(vault, marker));
  const plugin = join(vault, ".obsidian/plugins/visual-agent-map");
  const manifest = json(join(plugin, "manifest.json"));
  if (manifest.id !== "visual-agent-map" || manifest.version !== record.version || JSON.stringify(hashes(plugin)) !== JSON.stringify(record.hashes) || JSON.stringify(hashes(artifact)) !== JSON.stringify(record.hashes)) throw new Error("Installed plugin identity/hash mismatch.");
  const enabled = json(join(vault, ".obsidian/community-plugins.json"));
  if (JSON.stringify(enabled) !== JSON.stringify([manifest.id])) throw new Error("Plugin enablement mismatch.");
  if (record.profile !== "onboarding") {
    const settings = json(join(plugin, "data.json"));
    if (!settings.workspaceInitialized || settings.workspaceFolder !== record.workspaceRoot) throw new Error("Fixture/settings mismatch.");
    if (!isOwnerVault(vault, owner)) {
      if (!existsSync(join(vault, settings.workspaceFolder, "Topics/Taiwan Travel Regression (zh-TW test fixture)/Map.md"))) throw new Error("Fixture/settings mismatch.");
      if (!existsSync(join(vault, settings.workspaceFolder, "Topics/Local Source Fixture/Map.md"))) throw new Error("Local-source fixture missing.");
    }
  }
  return record;
}

// Only a vault created by this checkout may be reset. Never follow a root symlink.
export function prepareTestVault({ vault = canonicalVault, artifact = root, profile = "normal", workspaceRoot = "Agent Workspace", source = {}, live = null, owner = canonicalVault } = {}) {
  if (existsSync(vault) || (() => { try { lstatSync(vault); return true; } catch { return false; } })()) {
    // The canonical vault is the owner's designated testing vault and holds their maps: it is created once and then
    // only updated in place (--update-current). A fresh profile needs a different vault path, never a reset of this one.
    if (resolve(vault) === resolve(canonicalVault)) throw new Error(`Refusing to reset ${canonicalVault}: it is the owner's testing vault and may only be updated in place with --update-current.`);
    if (lstatSync(vault).isSymbolicLink() || !lstatSync(vault).isDirectory()) throw new Error("Refusing non-directory/symlink test vault.");
    if (!existsSync(join(vault, marker))) throw new Error("Refusing to reset an unowned vault.");
    const previous = json(join(vault, marker));
    if (previous.owner !== realpathSync(root) || previous.kind !== "vam-disposable-test-vault") throw new Error("Refusing to reset a vault owned by another checkout.");
  }
  mkdirSync(dirname(vault), { recursive: true });
  const staging = mkdtempSync(join(dirname(vault), ".vam-fixture-"));
  try {
    const fresh = join(staging, "vault");
    // The owner's testing vault is never guarded: the owner calls AI there for real. Only session vaults fail closed.
    createTestVault({ vault: fresh, artifact, profile, workspaceRoot, live, stubProviders: !isOwnerVault(vault, owner) });
    const record = { kind: "vam-disposable-test-vault", owner: realpathSync(root), profile, workspaceRoot, version: json(join(artifact, "manifest.json")).version, hashes: hashes(artifact), source };
    writeFileSync(join(fresh, marker), JSON.stringify(record, null, 2));
    verifyTestVault(fresh, artifact);
    rmSync(vault, { recursive: true, force: true });
    renameSync(fresh, vault);
    return verifyTestVault(vault, artifact);
  } finally { rmSync(staging, { recursive: true, force: true }); }
}

// Session vaults get Obsidian's DOM menus so CDP can open them in the background. An existing nativeMenus choice and every
// other appearance key stay as they are; the owner vault never reaches this.
function ensureNativeMenusOff(vault) {
  const path = join(vault, ".obsidian/appearance.json");
  const current = existsSync(path) ? json(path) : {};
  if (Object.hasOwn(current, "nativeMenus")) return;
  writeFileSync(path, JSON.stringify({ ...current, nativeMenus: false }, null, 2));
}

// A refresh that failed part-way puts back every artifact it had already replaced and the ownership record (from the copies in staging).
export function restorePreviousInstall({ staging, plugin, replaced, recordPath }) {
  for (const name of [...replaced].reverse()) {
    const previous = join(staging, `${name}.previous`);
    if (existsSync(previous)) renameSync(previous, join(plugin, name));
  }
  const previousRecord = join(staging, `${marker}.previous`);
  if (existsSync(previousRecord)) renameSync(previousRecord, recordPath);
}

// Refresh only installed code in an owned Vault. Preserve every fixture, note, and attachment.
// The owner's vault is refused while the owner may be using it (scripts/owner-idle.mjs) unless the session that has the owner's
// own 「可以裝」 passes ownerIdleConfirmed (--owner-idle-confirmed).
export function updateCurrentTestVault({ vault = canonicalVault, artifact = root, source = {}, owner = canonicalVault, ownerIdleConfirmed = false, now } = {}) {
  if (isOwnerVault(vault, owner) && !ownerIdleConfirmed) assertOwnerIdle(vault, { now });
  if (!existsSync(vault) || lstatSync(vault).isSymbolicLink() || !lstatSync(vault).isDirectory() || !existsSync(join(vault, marker))) throw new Error("Refusing to update a missing or unowned test vault.");
  const recordPath = join(vault, marker), record = json(recordPath);
  if (record.kind !== "vam-disposable-test-vault") throw new Error("Refusing to update a missing or unowned test vault.");
  if (record.owner !== realpathSync(root) && !sameRepoCleanMain(record.owner, root)) throw new Error(`Refusing to update a test vault owned by another checkout: ${ownerCheckoutState(record.owner)}. Run --update-current from that checkout once it is on main, or from a worktree of the same repo that is exactly origin/main (fetch first) with no source edits; if another session holds it, tell the session that opened you what you are waiting for.`);
  const manifest = json(join(artifact, "manifest.json"));
  const plugin = join(vault, ".obsidian/plugins/visual-agent-map");
  if (!existsSync(plugin) || lstatSync(plugin).isSymbolicLink() || !lstatSync(plugin).isDirectory()) throw new Error("Refusing an invalid installed plugin directory.");
  const installedManifest = json(join(plugin, "manifest.json"));
  if (manifest.id !== "visual-agent-map" || installedManifest.id !== manifest.id || installedManifest.version !== record.version) throw new Error("Installed plugin identity/version does not match the owned test-vault record.");
  if (record.profile !== "onboarding" && !isOwnerVault(vault, owner)) ensureSourceSelectionFixture(vault, record.workspaceRoot, { preserveExisting: true });
  if (!isOwnerVault(vault, owner)) ensureNativeMenusOff(vault);
  // Identical verified files need no copy. Still validate settings/fixtures and update
  // the source record atomically when preview/verification or runtime identity changed.
  if ([recordPath, ...assets.map(name => join(plugin, name))].every(path => existsSync(path) && lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink()) && JSON.stringify(hashes(artifact)) === JSON.stringify(record.hashes)) {
    let verified;
    try { verified = verifyTestVault(vault, artifact, owner); } catch { /* repair via normal staging */ }
    if (verified) {
      if (JSON.stringify(record.source) === JSON.stringify(source)) return record;
      const staging = mkdtempSync(join(plugin, ".vam-record-"));
      try {
        writeFileSync(join(staging, marker), JSON.stringify({ ...record, source }, null, 2));
        renameSync(join(staging, marker), recordPath);
        return { ...record, source };
      } finally { rmSync(staging, { recursive: true, force: true }); }
    }
  }
  const staging = mkdtempSync(join(plugin, ".vam-update-")), replaced = [];
  try {
    for (const name of assets) copyFileSync(join(artifact, name), join(staging, name));
    const newHashes = hashes(staging);
    if (JSON.stringify(newHashes) !== JSON.stringify(hashes(artifact))) throw new Error("Staged plugin artifacts failed hash verification.");
    for (const name of assets) if (existsSync(join(plugin, name))) copyFileSync(join(plugin, name), join(staging, `${name}.previous`));
    copyFileSync(recordPath, join(staging, `${marker}.previous`));
    try {
      for (const name of assets) { renameSync(join(staging, name), join(plugin, name)); replaced.push(name); }
      writeFileSync(join(staging, marker), JSON.stringify({ ...record, version: manifest.version, hashes: newHashes, source }, null, 2));
      renameSync(join(staging, marker), recordPath);
      return verifyTestVault(vault, artifact, owner);
    } catch (error) {
      restorePreviousInstall({ staging, plugin, replaced, recordPath });
      throw error;
    }
  } finally { rmSync(staging, { recursive: true, force: true }); }
}

// A private Electron profile registers only the canonical vault. URI path alone
// cannot reliably open a freshly created, previously unregistered vault.
// Session profiles disable the CLI: a second instance takes over the per-user CLI socket anyway, and a disabled CLI
// fails loudly instead of silently driving the wrong vault. Session instances are driven through obsidian-cdp.mjs.
export function prepareObsidianProfile(vault, runtime, { cli = true } = {}) {
  const directory = join(vault, ".vam-app");
  mkdirSync(directory);
  const id = hash(resolve(vault)).slice(0, 16);
  writeFileSync(join(directory, "obsidian.json"), JSON.stringify({ vaults: { [id]: { path: resolve(vault), ts: 0, open: true } }, updateDisabled: true, cli }, null, 2));
  if (runtime) {
    const destination = join(directory, `obsidian-${runtime.version}.asar`);
    copyFileSync(runtime.path, destination);
    if (hash(readFileSync(destination)) !== runtime.hash) throw new Error("Obsidian runtime changed during preparation.");
  }
  return directory;
}

export function selectObsidianRuntime(minVersion, candidates) {
  const parts = version => version.split(".").map(Number);
  const compare = (a, b) => { const x = parts(a), y = parts(b); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; };
  const runtimes = candidates.filter(path => existsSync(path)).map(path => {
    const bytes = readFileSync(path);
    const header = JSON.parse(bytes.subarray(16, 16 + bytes.readUInt32LE(12)).toString());
    const entry = header.files["package.json"];
    const start = 8 + bytes.readUInt32LE(4) + Number(entry.offset);
    const version = JSON.parse(bytes.subarray(start, start + entry.size).toString()).version;
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Unsupported Obsidian runtime version.");
    return { path, version, hash: hash(bytes) };
  }).sort((a, b) => compare(b.version, a.version));
  const runtime = runtimes.find(candidate => compare(candidate.version, minVersion) >= 0);
  if (!runtime) throw new Error(`No installed Obsidian runtime meets ${minVersion}; update Obsidian before UI testing.`);
  return runtime;
}

export function ensureSessionProfile(vault, runtime, { running = false } = {}) {
  const profile = join(vault, ".vam-app");
  if (!existsSync(profile)) {
    if (running) throw new Error("Running session has no owned runtime profile.");
    return prepareObsidianProfile(vault, runtime, { cli: false });
  }
  if (!lstatSync(profile).isDirectory() || lstatSync(profile).isSymbolicLink()) throw new Error("Invalid session runtime profile.");
  const configPath = join(profile, "obsidian.json");
  if (!existsSync(configPath) || !lstatSync(configPath).isFile() || lstatSync(configPath).isSymbolicLink()) throw new Error("Missing or invalid session profile configuration.");
  const config = json(configPath), entries = Object.values(config.vaults || {});
  if (config.cli !== false || entries.length !== 1 || !entries[0]?.path || realpathSync(entries[0].path) !== realpathSync(vault)) throw new Error("Session profile does not identify only the owned vault.");
  const name = "obsidian-" + runtime.version + ".asar";
  const current = join(profile, name);
  const compare = (a, b) => {
    const x = a.split(".").map(Number), y = b.split(".").map(Number);
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
  };
  for (const file of readdirSync(profile)) {
    const version = /^obsidian-(\d+\.\d+\.\d+)\.asar$/.exec(file)?.[1];
    if (version && compare(version, runtime.version) > 0) throw new Error("Session profile contains a newer runtime; inspect before reuse.");
  }
  if (existsSync(current)) {
    if (!lstatSync(current).isFile() || lstatSync(current).isSymbolicLink()) throw new Error("Invalid session runtime archive.");
    if (hash(readFileSync(current)) === runtime.hash) return profile;
  }
  if (running) throw new Error("Session runtime archive changed; stop and restart instead.");
  const staging = mkdtempSync(join(profile, ".vam-runtime-"));
  try {
    const file = join(staging, name);
    copyFileSync(runtime.path, file);
    if (hash(readFileSync(file)) !== runtime.hash) throw new Error("Obsidian runtime changed during preparation.");
    renameSync(file, current);
    return profile;
  } finally { rmSync(staging, { recursive: true, force: true }); }
}

function installedObsidianRuntime() {
  const updates = join(homedir(), "Library/Application Support/obsidian");
  const candidates = ["/Applications/Obsidian.app/Contents/Resources/obsidian.asar"];
  if (existsSync(updates)) candidates.push(...readdirSync(updates).filter(name => /^obsidian-\d+\.\d+\.\d+\.asar$/.test(name)).map(name => join(updates, name)));
  return selectObsidianRuntime(json(join(root, "manifest.json")).minAppVersion, candidates);
}

// Opens in the background (`open -g`) so testing never takes over the owner's screen or focus. Port 0 lets Chromium
// pick a free DevTools port and record it in <profile>/DevToolsActivePort for obsidian-cdp.mjs.
// A running Obsidian keeps the plugin code it loaded when the plugin was enabled: new files on disk take effect only after the plugin
// is reloaded in it (the owner's book of 2026-11-22 ran a days-old build after an install). Disable + enable (not the *AndSave forms,
// so the enabled list on disk is untouched) reads main.js from disk again: a new plugin instance is the proof (the manifest version is read at
// startup and is the same across builds, so it proves nothing). A plugin the owner switched off is left off. No window is focused.
export const reloadPluginExpression = `(async()=>{const id="visual-agent-map";if(!app.plugins.enabledPlugins.has(id))return {enabled:false};const before=app.plugins.plugins[id];await app.plugins.disablePlugin(id);await app.plugins.enablePlugin(id);const after=app.plugins.plugins[id];return {enabled:true,reloaded:!!after&&after!==before}})()`;
export async function reloadRunningPlugin(vault, connect = connectCdp) {
  let cdp;
  // macOS keeps Obsidian running after its last window closes; the installed files load when a window opens, so that is not a failure.
  try { cdp = await connect(vault); }
  catch (error) { if (/No Obsidian main window/.test(error.message)) return { enabled: true, window: false }; throw error; }
  let result;
  try { result = await cdp.evaluate(reloadPluginExpression); } finally { cdp.close(); }
  if (result?.enabled === false) return result;
  if (!result?.reloaded) throw new Error(`The new build is installed, but the running Obsidian did not load it (${JSON.stringify(result)}): the old plugin is still running. Reload the plugin or restart Obsidian.`);
  return result;
}

// Test instances run from a background-only copy of Obsidian: `LSBackgroundOnly` (which needs its own bundle id and an ad-hoc
// re-sign) makes macOS never activate it, so no window ever reaches the front, even before the watcher's policy applies.
// The copy is an APFS clone kept per Obsidian build; a re-signed copy cannot read the owner's keychain, so it is launched with a mock
// keychain (otherwise macOS asks the owner for the login keychain password).
export const testAppBundleId = "md.obsidian.vamtest";
export function ensureTestApp(source = obsidianApp, directory = join(homedir(), "Library", "Caches", "vam-test-obsidian")) {
  const build = execFileSync("plutil", ["-extract", "CFBundleVersion", "raw", join(source, "Contents", "Info.plist")], { encoding: "utf8" }).trim();
  const target = join(directory, `Obsidian-${build}.app`);
  if (existsSync(target)) return target;
  mkdirSync(directory, { recursive: true });
  const staging = mkdtempSync(join(directory, ".staging-"));
  try {
    const app = join(staging, "Obsidian.app");
    execFileSync("cp", ["-cR", source, app]);
    const plist = join(app, "Contents", "Info.plist");
    execFileSync("plutil", ["-replace", "CFBundleIdentifier", "-string", testAppBundleId, plist]);
    execFileSync("plutil", ["-replace", "LSBackgroundOnly", "-bool", "YES", plist]);
    execFileSync("codesign", ["--force", "--deep", "-s", "-", app], { stdio: "ignore" });
    // Another harness may have finished the same copy first: its rename wins and this one is dropped.
    try { renameSync(app, target); } catch (error) { if (!existsSync(target)) throw error; }
  } finally { rmSync(staging, { recursive: true, force: true }); }
  return target;
}

// Electron writes its own log (V8 "Fatal error" lines included) into the test profile, so a renderer crash can be told apart: OOM vs. a product bug.
export const launchArgs = (app, appProfile) => ["-g", "-n", "-a", app, "--args", `--user-data-dir=${appProfile}`, "--enable-logging=file", `--log-file=${join(appProfile, "electron.log")}`, "--remote-debugging-port=0", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", "--use-mock-keychain", "--password-store=basic"];

function launchObsidian(appProfile) {
  if (!existsSync(obsidianApp)) throw new Error(`Obsidian app bundle not found at ${obsidianApp}.`);
  if (instanceRunning(appProfile)) return;
  rmSync(join(appProfile, "DevToolsActivePort"), { force: true });
  keepProfile(appProfile); // left running on purpose for the owner; the end-of-run check must not stop it
  const app = ensureTestApp();
  const previous = frontApp();
  execFileSync("open", launchArgs(app, appProfile));
  startFocusWatcher(appProfile, previous, app);
}

// Obsidian activates itself whenever a window opens (Settings etc. since 1.14), even under `open -g`. A detached watcher
// hands focus back to the owner's app for the instance's whole life; it exits on its own when the instance is gone.
function startFocusWatcher(appProfile, previous, app) {
  if (process.platform !== "darwin") return;
  spawn(process.execPath, [fileURLToPath(new URL("./keep-background.mjs", import.meta.url)), appProfile, app, String(previous.pid), previous.path ?? ""], { detached: true, stdio: "ignore" }).unref();
}

const instanceRunning = appProfile => spawnSync("pgrep", ["-f", "--", instancePattern(appProfile)], { encoding: "utf8" }).status === 0;

// Per-session vaults let parallel sessions run UI acceptance without sharing the owner's testing vault.
export const sessionVaultPrefix = process.platform === "darwin" ? "/private/tmp/vam-e2e-" : join(tmpdir(), "vam-e2e-");
export function sessionVault(name) {
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(name ?? "")) throw new Error("--session needs a name of lowercase letters, digits and hyphens (at most 32).");
  const vault = `${sessionVaultPrefix}${name}`;
  if (["current", "smoke"].includes(name) || [canonicalVault, smokeVault].some(reserved => resolve(reserved) === resolve(vault))) throw new Error(`Session name "${name}" is reserved.`);
  return vault;
}

// Only the exact owning checkout can operate on an isolated session.
export function assertSessionOwner(vault) {
  if (isOwnerVault(vault) || !existsSync(vault) || (existsSync(canonicalVault) && realpathSync(vault) === realpathSync(canonicalVault)) || !lstatSync(vault).isDirectory() || lstatSync(vault).isSymbolicLink()) throw new Error("Refusing an unowned session vault.");
  const path = join(vault, marker);
  if (!existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error("Refusing an unowned session vault.");
  const record = json(path);
  if (record.kind !== "vam-disposable-test-vault" || record.owner !== realpathSync(root)) throw new Error("Refusing a session vault owned by another checkout.");
  return record;
}
export function withSessionLock(vault, work) {
  const lock = vault + ".lock";
  mkdirSync(lock); // interrupted operation: inspect stale lock instead of racing another writer
  const release = () => rmSync(lock, { recursive: true });
  let result;
  try { result = work(); } catch (error) { release(); throw error; }
  if (result && typeof result.then === "function") return result.finally(release);
  release();
  return result;
}
function assertSessionIdle(vault) {
  const reasons = ownerBusyReasons(vault, { requireQuietWindow: false });
  if (reasons.length) throw new Error("Session reload refused: possible pending work or unknown state; finish work or stop the session. " + reasons.join("; "));
}
// Missing/unknown runtime state is not permission to unload. Deliberately
// conservative, especially for books, chat, Coffee sessions and queued writes.
export function sessionDisableExpression(vault, runtimeVersion) {
  return "(async()=>{" +
    "if(app.vault.adapter.basePath!==" + JSON.stringify(vault) + ")return {status:'wrong-vault'};" +
    "const id='visual-agent-map',p=app.plugins.plugins[id];" +
    "if(require('electron').ipcRenderer.sendSync('version')!==" + JSON.stringify(runtimeVersion) + ")return {status:'runtime-mismatch'};" +
    "if(!app.plugins.enabledPlugins.has(id)||!p||!p.repo||p.unloaded!==false)return {status:'unknown'};" +
    "const queue=p.queue;if(!queue||typeof queue.then!=='function'||!p.ready||typeof p.ready.then!=='function')return {status:'unknown'};" +
    "const settled=await Promise.race([Promise.all([queue,p.ready]).then(()=>true),new Promise(resolve=>setTimeout(()=>resolve(false),0))]);" +
    "const empty=x=>x!=null&&typeof x.size==='number'&&x.size===0;" +
    "if(!settled||p.queue!==queue||p.writing!==0||p.pendingRenames!==null||p.externalReconcileTimer!==null||p.languageSwitchPending!==false||document.querySelector('.modal-container')||" +
    "![p.running,p.activeTasks,p.chartJobs,p.quickExpandPending,p.expansionBatches,p.pendingSuggestions,p.pendingResearchOptions,p.externalReconcilePaths,p.bookPipelineRuns?.drives,p.bookPipelineRuns?.gateWaiting,p.bookPipelineRuns?.notesJobs,p.argumentRuns?.drives,p.bookNotesApply?.jobs,p.coffeeManager?.engines,p.coffeeManager?.deletingIds].every(empty))return {status:'busy'};" +
    "await app.plugins.disablePlugin(id);return {status:!app.plugins.plugins[id]?'disabled':'unknown'};})()";
}
function sessionEnableExpression(vault, enable) {
  return "(async()=>{if(app.vault.adapter.basePath!==" + JSON.stringify(vault) + ")return false;const id='visual-agent-map';" +
    (enable ? "await app.plugins.enablePlugin(id);return !!app.plugins.plugins[id]&&app.plugins.enabledPlugins.has(id);" : "if(app.plugins.plugins[id])await app.plugins.disablePlugin(id);return !app.plugins.plugins[id];") + "})()";
}
export async function reloadSessionVault({ vault, source, artifact = root, connect = connectCdp, idle = assertSessionIdle, checkCandidate = () => {} }) {
  const previous = assertSessionOwner(vault);
  idle(vault);
  const runtime = source.obsidianRuntime;
  if (!runtime?.version || JSON.stringify(previous.source?.obsidianRuntime) !== JSON.stringify(runtime)) throw new Error("Session runtime changed or is unknown; stop and restart instead.");
  const plugin = join(vault, ".obsidian/plugins/visual-agent-map");
  if (!lstatSync(plugin).isDirectory() || lstatSync(plugin).isSymbolicLink()) throw new Error("Invalid installed plugin directory.");
  for (const name of assets) if (!lstatSync(join(plugin, name)).isFile() || lstatSync(join(plugin, name)).isSymbolicLink()) throw new Error("Invalid installed artifact.");
  verifyTestVault(vault, plugin);
  const recordPath = join(vault, marker);
  const staging = mkdtempSync(join(plugin, ".vam-reload-"));
  const realVault = realpathSync(vault);
  let cdp, disabled = false, keepBackup = false;
  try {
    for (const name of assets) copyFileSync(join(plugin, name), join(staging, name + ".previous"));
    copyFileSync(recordPath, join(staging, marker + ".previous"));
    cdp = await connect(vault);
    idle(vault);
    checkCandidate();
    const result = await cdp.evaluate(sessionDisableExpression(realVault, runtime.version));
    if (result?.status !== "disabled") throw new Error("Session reload refused: " + (result?.status || "unknown") + "; finish work or stop/restart.");
    disabled = true;
    checkCandidate();
    const record = updateCurrentTestVault({ vault, artifact, source });
    if (await cdp.evaluate(sessionEnableExpression(realVault, true)) !== true) throw new Error("New plugin instance not loaded.");
    verifyTestVault(vault, artifact);
    checkCandidate();
    return record;
  } catch (error) {
    if (disabled) {
      let restored = false;
      try { await cdp.evaluate(sessionEnableExpression(realVault, false)); } catch { /* restore disk, never claim runtime PASS */ }
      try {
        restorePreviousInstall({ staging, plugin, replaced: assets, recordPath });
        verifyTestVault(vault, plugin);
        restored = true;
      } catch { keepBackup = true; }
      if (restored) {
        try { await cdp.evaluate(sessionEnableExpression(realVault, true)); } catch { /* restart required */ }
      }
      throw new Error("Session reload failed: " + error.message + ". " + (restored ? "Previous files restored; runtime requires stop/restart and verification." : "Rollback incomplete; retained backup at " + staging));
    }
    throw error;
  } finally {
    if (cdp) cdp.close();
    if (!keepBackup) rmSync(staging, { recursive: true, force: true });
  }
}

// Session preparation has three distinct policies. Only an exact, landed, clean CI
// candidate can bypass build; preview is explicitly unverified and never a runtime PASS.
export function prepareSessionCandidate({
  mode = "affected", execute = run, lookup = greenInstallRun, fingerprint = sourceFingerprint,
  artifactHashes = () => buildHashes(root),
  env = process.env
} = {}) {
  if (!["affected", "full", "preview"].includes(mode)) throw new Error("Unknown session verification mode.");
  const readFingerprint = () => timedSync("source-fingerprint", fingerprint);
  const readArtifacts = () => timedSync("artifact-hashes", artifactHashes);
  const findProof = () => timedSync("ci-proof-lookup", lookup);
  const before = readFingerprint();
  const canReuse = mode === "affected" && env.CI !== "true" && env.VAM_CLEAN_BUILD !== "1";
  let green = canReuse ? findProof() : null;
  const buildReused = !!green;
  let beforeBuild;
  if (!green) {
    if (canReuse) try { beforeBuild = readArtifacts(); } catch { /* missing artifacts */ }
    execute("npm", ["run", "build"]);
  }
  const built = readArtifacts();
  // A second lookup is worthwhile only when the build restored/changed bytes.
  // A missing CI proof for identical artifacts must not cause two network waits.
  if (!green && canReuse && JSON.stringify(beforeBuild) !== JSON.stringify(built)) green = findProof();
  const testEnv = { ...env };
  for (const key of ["VAM_AFFECTED_TESTS", "VAM_ISOLATED_SUITES", "VAM_ISOLATED_TEST_LAYER", "VAM_CI_SHARD", "VAM_CI_REPORT_DIR"]) delete testEnv[key];
  let verification;
  if (green) {
    process.stdout.write(`Vault: reusing full CI run ${green.id} for ${green.sha}; checking the local vault harness.\n`);
    timedSync("local-vault-test", () => execute(process.execPath, ["--test", "tests/test-vault.mjs"], testEnv));
    recordDevEvent("ci-reuse-install", 0, "ok", { commit: green.sha, runId: green.id });
    verification = { kind: "ci-full", ...green, localVaultTest: true, buildReused };
  } else if (mode === "preview") {
    verification = { kind: "preview-unverified" };
    process.stdout.write("PREVIEW ONLY: backend verification NOT RUN; not acceptance evidence.\n");
  } else if (mode === "full") {
    execute("npm", ["run", "test:unit"], testEnv);
    execute("npm", ["run", "test:integration"], testEnv);
    verification = { kind: "local-full" };
  } else {
    execute("npm", ["run", "test:affected"], testEnv);
    verification = { kind: "local-affected" };
  }
  if (readFingerprint() !== before) throw new Error("Source changed during session preparation; rerun the harness before E2E.");
  if (JSON.stringify(readArtifacts()) !== JSON.stringify(built)) throw new Error("Build artifacts changed during session preparation.");
  return { fingerprint: before, verification, artifacts: built };
}

/** Session vaults are fail-closed on every run (create, update in place, reload); the owner vault is never touched. */
export function applySessionGuard(vault, live = null, owner = canonicalVault) {
  return isOwnerVault(vault, owner) ? null : applyProviderGuard(vault, live);
}

/**
 * Session vaults only. The onboarding profile cannot carry the provider guard: a data.json would count as saved settings and skip the
 * first-install flow (main.ts initializeFirstInstall), and a bare "codex"/"claude" is resolved from ~/.local/bin, Homebrew, /usr/local/bin
 * and nvm before PATH, so a guard folder on PATH would lose. So such a session is refused before Obsidian starts unless the tester says
 * --unguarded. --unguarded means "this run is not guarded"; --live means "this model may be called". They are not mixed: --live alone on an
 * onboarding vault is refused, and --live together with --unguarded is accepted only because the tester asked for both.
 */
export function assertOnboardingChoice(args) {
  const unguarded = args.includes("--unguarded");
  if (!args.includes("--profile=onboarding")) return;
  if (unguarded) return;
  throw new Error(`Refusing an onboarding vault with no provider guard${args.some(arg => arg.startsWith("--live=")) ? " (--live alone does not help: there is no data.json to carry it)" : ""}. The first-install flow needs a vault with no data.json (saved settings skip it), and a bare codex/claude is found in ~/.local/bin, Homebrew, /usr/local/bin and nvm before PATH, so the harness cannot make this vault fail closed. Add --unguarded if you know this run is unguarded (walk the first-install flow without calling any AI). After the first run has made data.json, the next --session run adds the guard.`);
}

/** An existing session vault the guard cannot be written into (no data.json yet) is refused before launch unless --unguarded. */
export function assertSessionGuardable(vault, args, owner = canonicalVault) {
  if (isOwnerVault(vault, owner) || args.includes("--unguarded")) return;
  if (!existsSync(join(vault, ".ob" + "sidian/plugins/visual-agent-map/data.json"))) throw new Error(`Refusing ${vault}: it has no data.json yet (an onboarding vault before its first run), so the provider guard cannot be added and the vault would not fail closed. Add --unguarded if this run is meant to be unguarded.`);
}

// `--live=<model>` / `--live=claude:<model>`: the only provider call a harness vault may really make (see scripts/provider-guard.mjs).
const liveOf = args => { const values = args.filter(arg => arg.startsWith("--live=")); if (values.length > 1) throw new Error("Give --live once."); return values.length ? parseLive(values[0].slice("--live=".length)) : null; };

function sessionMain(args) {
  for (const arg of args) if (!/^--session=/.test(arg) && !["--stop", "--preview", "--full", "--reload"].includes(arg) && !/^--profile=(normal|onboarding|reinstall)$/.test(arg) && !arg.startsWith("--live=") && arg !== "--unguarded") throw new Error(`--session cannot be combined with: ${arg}`);
  if (args.filter(arg => arg.startsWith("--session=")).length !== 1) throw new Error("Exactly one session name is required.");
  assertOnboardingChoice(args);
  if ((args.includes("--preview") && args.includes("--full")) || (args.includes("--stop") && args.some(arg => arg === "--preview" || arg === "--full" || arg === "--reload" || arg.startsWith("--profile=") || arg.startsWith("--live=")))) throw new Error("Conflicting session options.");
  if (args.includes("--reload") && args.some(arg => arg.startsWith("--live="))) throw new Error("--live cannot be combined with --reload (a running Obsidian keeps the settings it loaded).");
  const mode = args.includes("--preview") ? "preview" : args.includes("--full") ? "full" : "affected";
  const vault = sessionVault(args.find(arg => arg.startsWith("--session=")).slice("--session=".length));
  return withSessionLock(vault, () => sessionMainLocked(args, vault, mode));
}

function sessionMainLocked(args, vault, mode) {
  const appProfile = join(vault, ".vam-app");
  if (args.includes("--stop")) {
    assertSessionOwner(vault);
    // SIGTERM lets Obsidian save its workspace. Only the instance using this session's own profile is stopped.
    spawnSync("pkill", ["-TERM", "-f", "--", instancePattern(appProfile)]);
    for (let wait = 0; wait < 40 && instanceRunning(appProfile); wait++) spawnSync("sleep", ["0.25"]);
    if (instanceRunning(appProfile)) throw new Error(`Obsidian on ${vault} did not stop.`);
    process.stdout.write(`${JSON.stringify({ vault, stopped: true })}\n`);
    return;
  }
  if (process.platform !== "darwin") throw new Error("Automatic Obsidian preparation/launch currently supports macOS only; automated tests are cross-platform.");
  const running = instanceRunning(appProfile), reload = args.includes("--reload");
  if (running && !reload) throw new Error("Obsidian is running on " + vault + ". Finish or stop its work; use --stop or explicitly --reload.");
  if (reload && !running) throw new Error("No running session to reload; run ordinary session preparation.");
  const exists = existsSync(vault);
  if (exists && args.some(arg => arg.startsWith("--profile="))) throw new Error(`${vault} exists and is updated in place; --profile applies only when it is first created.`);
  if (exists) assertSessionOwner(vault);
  if (exists) assertSessionGuardable(vault, args);
  if (reload) { assertSessionOwner(vault); assertSessionIdle(vault); }
  const { fingerprint, verification, artifacts } = timedSync("session-prepare", () => prepareSessionCandidate({ mode }));
  if (instanceRunning(appProfile) !== running) throw new Error("Session Obsidian changed state during preparation; refusing to replace loaded files.");
  const git = (...values) => execFileSync("git", values, { cwd: root, encoding: "utf8" }).trim();
  const runtime = installedObsidianRuntime();
  const source = { branch: git("branch", "--show-current"), commit: git("rev-parse", "HEAD"), status: git("status", "--short"), diffHash: gitDiffHash(root, ["diff", "HEAD", "--binary"]), fingerprint, verification, obsidianRuntime: { version: runtime.version, hash: runtime.hash } };
  const checkCandidate = () => {
    assertSourceUnchanged(fingerprint);
    if (JSON.stringify(buildHashes(root)) !== JSON.stringify(artifacts)) throw new Error("Build artifacts changed before installation.");
  };
  checkCandidate();
  if (reload) {
    ensureSessionProfile(vault, runtime, { running: true });
    applySessionGuard(vault); // an older session vault gets the guard on reload too (no --live on reload: it is reset to blocked)
    return timedAsync("session-reload", () => reloadSessionVault({ vault, source, checkCandidate })).then(record => {
      process.stdout.write(JSON.stringify({ vault, reloaded: true, version: record.version, hashes: record.hashes, verification, acceptance: "PENDING" }, null, 2) + "\n");
    });
  }
  const live = liveOf(args);
  const record = timedSync("install", () => exists
    ? updateCurrentTestVault({ vault, source })
    : prepareTestVault({ vault, profile: args.find(arg => arg.startsWith("--profile="))?.split("=")[1] || "normal", source, live }));
  // Session vaults are always fail-closed: an older vault gets the guard too, and --live is re-decided on every run.
  if (exists) applySessionGuard(vault, live);
  ensureSessionProfile(vault, runtime);
  launchObsidian(appProfile);
  const cdp = `node scripts/obsidian-cdp.mjs --vault=${vault}`;
  process.stdout.write(`${JSON.stringify({ vault, created: !exists, version: record.version, hashes: record.hashes, verification, acceptance: "PENDING", next: [`${cdp} wait`, `${cdp} trust`, `${cdp} eval "<expression>"`, `${cdp} screenshot <file.png>`, `node scripts/test-harness.mjs --session=${vault.slice(sessionVaultPrefix.length)} --stop`, `Test Obsidian stays in the background for its whole life; to watch it, create ${join(appProfile, "allow-focus")} (delete it to hide again)`] }, null, 2)}\n`);
}

export function assertSourceUnchanged(expected, directory = root) {
  if (sourceFingerprint(directory) !== expected) throw new Error("Source changed during verification; rerun the harness before E2E.");
}

// Only reuse full CI for a clean, already-landed candidate whose locally built install artifacts
// are byte-identical to the commit. The existing full-CI lookup rejects affected runs and fails closed.
// Any local edit (including generated output), missing proof or lookup failure retains targeted verification.
export function greenInstallRun(directory = root, lookup = (dir, sha) => execFileSync("sh", ["scripts/find-green-ci-run.sh", sha], { cwd: dir, encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "ignore"] }).trim()) {
  const git = (...args) => execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  try {
    const sha = git("rev-parse", "HEAD");
    if (!/^[0-9a-f]{40}$/.test(sha) || sha !== git("rev-parse", "refs/remotes/origin/main")) return null;
    const clean = () => !git("status", "--porcelain", "--untracked-files=all") &&
      git("ls-files", "-v").split("\n").every(line => !line || line.startsWith("H "));
    if (!clean()) return null;
    const matches = () => [...assets, viewerArtifact].every(name => {
      const committed = execFileSync("git", ["show", `${sha}:${name}`], { cwd: directory, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
      return hash(committed) === hash(readFileSync(join(directory, name)));
    });
    if (!matches()) return null;
    const id = lookup(directory, sha);
    if (!/^\d+$/.test(id || "") || git("rev-parse", "HEAD") !== sha || git("rev-parse", "refs/remotes/origin/main") !== sha || !clean() || !matches()) return null;
    return { sha, id };
  } catch { return null; }
}

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", env });
  if (result.error || result.status !== 0) throw new Error(`Failed: ${command} ${args.join(" ")}`, { cause: result.error });
}

function gitDiffHash(directory, args) {
  return hash(execFileSync("git", args, { cwd: directory, maxBuffer: 512 * 1024 * 1024 }));
}

function assertObsidianClosed() {
  if (process.platform !== "darwin") throw new Error("Automatic Obsidian preparation/launch currently supports macOS only; automated tests are cross-platform.");
  const result = spawnSync("pgrep", ["-x", "Obsidian"], { encoding: "utf8" });
  if (result.error || result.status !== 1) throw new Error("Close Obsidian before resetting the canonical vault, then rerun. No running vault will be replaced.");
}

// The name "smoke" stays reserved for a session vault: the old AIM smoke profile used this vault path.
export const smokeVault = process.platform === "darwin" ? "/private/tmp/vam-e2e-smoke" : join(tmpdir(), "vam-e2e-smoke");

export const usage = `Usage: node scripts/test-harness.mjs [--ui | --prepare [--profile=normal|onboarding|reinstall] | --update-current [--wait-idle | --owner-idle-confirmed] | --session=<name> [--stop | --preview | --full] [--reload] [--profile=...] [--live=<model>] [--unguarded (onboarding vaults and vaults with no data.json yet)] | --which-installed | --help]
  (no option)        build + unit + integration tests only
  --session=<name>   isolated vault /private/tmp/vam-e2e-<name>, background Obsidian driven over CDP (see scripts/obsidian-cdp.mjs, scripts/run-scenario.mjs)
  --preview          session only: build and install for inspection; verification NOT RUN, not acceptance
  --full             session only: force build + full unit and integration tests
  --reload           session only: explicitly refresh a running owned idle session; refuses uncertain state
  default session    reuse exact clean landed CI artifacts + local vault test, otherwise build + affected tests (full fallback)
  seed a picture-book map into a session vault: node scripts/book-fixture.mjs --session=<name>`;
export const isHelp = args => args.includes("--help") || args.includes("-h");

export function main(args = process.argv.slice(2)) {
  if (isHelp(args)) return process.stdout.write(`${usage}\n`);
  if (args.some(arg => arg.startsWith("--session="))) return sessionMain(args);
  if (args.includes("--which-installed")) {
    if (args.length !== 1) throw new Error("--which-installed takes no other options.");
    return process.stdout.write(`${whichInstalled()}\n`);
  }
  for (const arg of args) if (!["--ui", "--prepare", "--update-current", "--owner-idle-confirmed", "--wait-idle"].includes(arg) && !/^--profile=(normal|onboarding|reinstall)$/.test(arg) && !arg.startsWith("--live=") && arg !== "--unguarded") throw new Error(`Unknown argument: ${arg}`);
  const ui = args.includes("--ui"), prepare = ui || args.includes("--prepare");
  const update = args.includes("--update-current");
  if (update && prepare) throw new Error("--update-current cannot be combined with reset/prepare options.");
  const ownerIdleConfirmed = args.includes("--owner-idle-confirmed");
  if (ownerIdleConfirmed && !update) throw new Error("--owner-idle-confirmed applies only to --update-current.");
  const waitIdle = args.includes("--wait-idle");
  if (waitIdle && (!update || ownerIdleConfirmed)) throw new Error("--wait-idle applies only to --update-current without --owner-idle-confirmed.");
  if (args.some(arg => arg.startsWith("--live=") || arg === "--unguarded")) throw new Error("--live and --unguarded apply only to --session: --prepare, --ui and --update-current handle the owner's testing vault, which is never guarded and never touched by the guard.");
  if (args.some(arg => arg.startsWith("--profile=")) && !prepare) throw new Error("Profile requires --prepare or --ui.");
  for (const name of ["VAM_TEST_TARGET_VERSION", "VAM_TEST_VAULT_PARENT", "VAM_TEST_ARTIFACT_DIR", "VAM_TEST_WORKSPACE_ROOT"]) if (process.env[name]) throw new Error(`${name} is retired in the current-branch harness; unset it to avoid testing a stale target.`);
  if (prepare) assertObsidianClosed();
  if (update) {
    assertContainsOriginMain();
    // Checked before the build so a busy owner is not kept waiting, and again right before the files are replaced.
    if (ownerIdleConfirmed) process.stdout.write("--owner-idle-confirmed: skipping the owner-idle check (only after the owner said 「可以裝」).\n");
    else if (waitIdle) waitOwnerIdle(canonicalVault, { sleep: ms => spawnSync("sleep", [String(ms / 1000)]) });
    else assertOwnerIdle(canonicalVault);
    const { fingerprint, verification, artifacts } = timedSync("session-prepare", () => prepareSessionCandidate());
    const git = (...values) => execFileSync("git", values, { cwd: root, encoding: "utf8" });
    const source = { branch: git("branch", "--show-current").trim(), commit: git("rev-parse", "HEAD").trim(), status: git("status", "--short").trim(), fingerprint };
    const runtime = installedObsidianRuntime();
    source.verification = verification;
    source.obsidianRuntime = { version: runtime.version, hash: runtime.hash };
    source.diffHash = gitDiffHash(root, ["diff", "HEAD", "--binary"]);
    assertSourceUnchanged(fingerprint);
    if (JSON.stringify(buildHashes(root)) !== JSON.stringify(artifacts)) throw new Error("Build artifacts changed before owner installation.");
    const record = timedSync("install", () => updateCurrentTestVault({ source, ownerIdleConfirmed }));
    const appProfile = join(canonicalVault, ".vam-app");
    if (!existsSync(join(appProfile, "obsidian.json")) || !readdirSync(appProfile).some(name => name.endsWith(".asar"))) prepareObsidianProfile(canonicalVault, runtime);
    process.stdout.write(`${JSON.stringify({ vault: canonicalVault, version: record.version, hashes: record.hashes, updatedInPlace: true, appProfile }, null, 2)}\n`);
    if (!instanceRunning(appProfile)) return launchObsidian(appProfile);
    return reloadRunningPlugin(canonicalVault).then(result => {
      process.stdout.write(result.enabled === false ? "The plugin is switched off in the running Obsidian; left off (the new files load when it is switched on).\n" : result.window === false ? "The running Obsidian has no window open; the new files load when a window opens.\n" : "Reloaded the plugin in the running Obsidian.\n");
    });
  }
  const lock = `${canonicalVault}.lock`;
  if (prepare) mkdirSync(lock); // Exclusive writer; an existing lock requires investigation.
  try {
    const fingerprint = prepare ? sourceFingerprint() : null;
    // Shared by npm test, CI and E2E: a failing layer never starts the next one.
    run("npm", ["run", "build"]);
    const builtHashes = prepare ? hashes(root) : null;
    run("npm", ["run", "test:unit"]);
    run("npm", ["run", "test:integration"]);
    if (!prepare) return;
    assertObsidianClosed();
    const git = (...values) => execFileSync("git", values, { cwd: root, encoding: "utf8" }).trim();
    const source = { branch: git("branch", "--show-current"), commit: git("rev-parse", "HEAD"), status: git("status", "--short"), diffHash: gitDiffHash(root, ["diff", "HEAD", "--", "."]) };
    const artifactVersion = json(join(root, "manifest.json")).version;
    if (artifactVersion !== json(join(root, "package.json")).version || artifactVersion !== json(join(root, "package-lock.json")).version) throw new Error("Build/package version mismatch.");
    assertSourceUnchanged(fingerprint);
    if (JSON.stringify(hashes(root)) !== JSON.stringify(builtHashes)) throw new Error("Build artifacts changed during tests.");
    source.fingerprint = fingerprint;
    const profile = args.find(arg => arg.startsWith("--profile="))?.split("=")[1] || "normal";
    const runtime = installedObsidianRuntime();
    source.obsidianRuntime = { version: runtime.version, hash: runtime.hash };
    const record = prepareTestVault({ profile, source });
    const appProfile = prepareObsidianProfile(canonicalVault, runtime);
    process.stdout.write(`${JSON.stringify({ vault: canonicalVault, appProfile, ...record }, null, 2)}\n`);
    assertSourceUnchanged(fingerprint);
    if (JSON.stringify(hashes(root)) !== JSON.stringify(builtHashes)) throw new Error("Build artifacts changed during preparation.");
    if (ui) {
      verifyTestVault(canonicalVault);
      launchObsidian(appProfile);
      process.stdout.write("Environment verified; E2E smoke is PENDING. Run only the planned UI criteria and record evidence. Launch success is not UI PASS.\n");
    }
  } finally { if (prepare) rmSync(lock, { recursive: true }); }
}

// Names the commit installed in a vault (default: the owner's): the install record's commit when the installed main.js still
// has the hash recorded at install time, and how that commit stands against origin/main. Read-only.
export function whichInstalled(vault = canonicalVault, checkout = root) {
  const plugin = join(vault, ".obsidian/plugins/visual-agent-map");
  const record = json(join(vault, marker));
  const installed = hash(readFileSync(join(plugin, "main.js")));
  const version = json(join(plugin, "manifest.json")).version;
  const lines = [`vault: ${vault}`, `version: ${version}`];
  const git = (...values) => { try { return execFileSync("git", ["-C", checkout, ...values], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; } };
  if (installed !== record.hashes?.["main.js"]) {
    const here = existsSync(join(checkout, "main.js")) && hash(readFileSync(join(checkout, "main.js"))) === installed;
    lines.push(`commit: unknown (main.js changed after the recorded install${here ? `; it matches this checkout's build of ${git("rev-parse", "HEAD") ?? "?"}` : ""})`);
    return lines.join("\n");
  }
  const commit = record.source?.commit ?? "unknown";
  const dirty = record.source?.status ? " (built with uncommitted changes)" : "";
  lines.push(`commit: ${commit}${dirty}`, `branch at install: ${record.source?.branch || "unknown"}`);
  const subject = git("log", "-1", "--format=%s", commit);
  if (subject) lines.push(`subject: ${subject}`);
  if (git("merge-base", "--is-ancestor", commit, "origin/main") !== null) lines.push(`on origin/main: yes, ${git("rev-list", "--count", `${commit}..origin/main`)} commit(s) behind`);
  else lines.push("on origin/main: no (or unknown here; run git fetch)");
  return lines.join("\n");
}

// Waiting for the owner does no heavy work and must not occupy the machine-wide test lock.
// Once the lock is acquired, main() still fetches origin and checks the owner before build
// and updateCurrentTestVault checks again before replacing files. If the owner became busy
// in the queue, refuse instead of waiting while holding the lock.
export async function runHarnessCli(argv, {
  wait = () => waitOwnerIdle(canonicalVault, { sleep: ms => spawnSync("sleep", [String(ms / 1000)]) }),
  enter = enterHeavy,
  execute = main
} = {}) {
  const waitOutsideLock = argv.length === 2 && argv.includes("--update-current") && argv.includes("--wait-idle");
  if (waitOutsideLock) timedSync("owner-idle-wait", wait);
  // --help and read-only/session paths must not wait for the heavy lock.
  if (!isHelp(argv) && !argv.includes("--smoke") && !argv.includes("--which-installed") && !argv.some(arg => arg.startsWith("--session="))) await enter(`npm test ${argv.join(" ")}`.trim(), { blocking: true });
  await execute(waitOutsideLock ? argv.filter(arg => arg !== "--wait-idle") : argv);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runHarnessCli(process.argv.slice(2));
}
