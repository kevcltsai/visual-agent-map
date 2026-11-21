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
import { assertOwnerIdle, waitOwnerIdle } from "./owner-idle.mjs";

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
export function prepareTestVault({ vault = canonicalVault, artifact = root, profile = "normal", workspaceRoot = "Agent Workspace", source = {} } = {}) {
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
    createTestVault({ vault: fresh, artifact, profile, workspaceRoot });
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
      for (const name of replaced.reverse()) {
        const previous = join(staging, `${name}.previous`);
        if (existsSync(previous)) renameSync(previous, join(plugin, name));
      }
      const previousRecord = join(staging, `${marker}.previous`);
      if (existsSync(previousRecord)) renameSync(previousRecord, recordPath);
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

function installedObsidianRuntime() {
  const updates = join(homedir(), "Library/Application Support/obsidian");
  const candidates = ["/Applications/Obsidian.app/Contents/Resources/obsidian.asar"];
  if (existsSync(updates)) candidates.push(...readdirSync(updates).filter(name => /^obsidian-\d+\.\d+\.\d+\.asar$/.test(name)).map(name => join(updates, name)));
  return selectObsidianRuntime(json(join(root, "manifest.json")).minAppVersion, candidates);
}

// Opens in the background (`open -g`) so testing never takes over the owner's screen or focus. Port 0 lets Chromium
// pick a free DevTools port and record it in <profile>/DevToolsActivePort for obsidian-cdp.mjs.
function launchObsidian(appProfile) {
  if (!existsSync(obsidianApp)) throw new Error(`Obsidian app bundle not found at ${obsidianApp}.`);
  if (instanceRunning(appProfile)) return;
  rmSync(join(appProfile, "DevToolsActivePort"), { force: true });
  keepProfile(appProfile); // left running on purpose for the owner; the end-of-run check must not stop it
  const previous = frontApp();
  execFileSync("open", ["-g", "-n", "-a", obsidianApp, "--args", `--user-data-dir=${appProfile}`, "--remote-debugging-port=0", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"]);
  startFocusWatcher(appProfile, previous);
}

// Obsidian activates itself whenever a window opens (Settings etc. since 1.14), even under `open -g`. A detached watcher
// hands focus back to the owner's app for the instance's whole life; it exits on its own when the instance is gone.
function startFocusWatcher(appProfile, previous) {
  if (process.platform !== "darwin") return;
  spawn(process.execPath, [fileURLToPath(new URL("./keep-background.mjs", import.meta.url)), appProfile, obsidianApp, String(previous.pid), previous.path ?? ""], { detached: true, stdio: "ignore" }).unref();
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

function sessionMain(args) {
  for (const arg of args) if (!/^--session=/.test(arg) && arg !== "--stop" && !/^--profile=(normal|onboarding|reinstall)$/.test(arg)) throw new Error(`--session cannot be combined with: ${arg}`);
  const vault = sessionVault(args.find(arg => arg.startsWith("--session=")).slice("--session=".length));
  const appProfile = join(vault, ".vam-app");
  if (args.includes("--stop")) {
    // SIGTERM lets Obsidian save its workspace. Only the instance using this session's own profile is stopped.
    spawnSync("pkill", ["-TERM", "-f", "--", instancePattern(appProfile)]);
    for (let wait = 0; wait < 40 && instanceRunning(appProfile); wait++) spawnSync("sleep", ["0.25"]);
    if (instanceRunning(appProfile)) throw new Error(`Obsidian on ${vault} did not stop.`);
    process.stdout.write(`${JSON.stringify({ vault, stopped: true })}\n`);
    return;
  }
  if (process.platform !== "darwin") throw new Error("Automatic Obsidian preparation/launch currently supports macOS only; automated tests are cross-platform.");
  // Refreshing files under a running instance would leave it on the old build; stopping it is the session's call.
  if (instanceRunning(appProfile)) throw new Error(`Obsidian is running on ${vault}. Finish or stop its work, run with --stop, then rerun.`);
  const exists = existsSync(vault);
  if (exists && args.some(arg => arg.startsWith("--profile="))) throw new Error(`${vault} exists and is updated in place; --profile applies only when it is first created.`);
  const fingerprint = sourceFingerprint();
  run("npm", ["run", "build"]);
  const builtHashes = hashes(root);
  run("npm", ["run", "test:unit"]);
  run("npm", ["run", "test:integration"]);
  assertSourceUnchanged(fingerprint);
  if (JSON.stringify(hashes(root)) !== JSON.stringify(builtHashes)) throw new Error("Build artifacts changed during tests.");
  const git = (...values) => execFileSync("git", values, { cwd: root, encoding: "utf8" }).trim();
  const runtime = installedObsidianRuntime();
  const source = { branch: git("branch", "--show-current"), commit: git("rev-parse", "HEAD"), status: git("status", "--short"), diffHash: gitDiffHash(root, ["diff", "HEAD", "--binary"]), fingerprint, obsidianRuntime: { version: runtime.version, hash: runtime.hash } };
  const record = exists
    ? updateCurrentTestVault({ vault, source })
    : prepareTestVault({ vault, profile: args.find(arg => arg.startsWith("--profile="))?.split("=")[1] || "normal", source });
  if (!existsSync(join(appProfile, "obsidian.json"))) prepareObsidianProfile(vault, runtime, { cli: false });
  launchObsidian(appProfile);
  const cdp = `node scripts/obsidian-cdp.mjs --vault=${vault}`;
  process.stdout.write(`${JSON.stringify({ vault, created: !exists, version: record.version, hashes: record.hashes, next: [`${cdp} wait`, `${cdp} trust`, `${cdp} eval "<expression>"`, `${cdp} screenshot <file.png>`, `node scripts/test-harness.mjs --session=${vault.slice(sessionVaultPrefix.length)} --stop`, `Test Obsidian stays in the background for its whole life; to watch it, create ${join(appProfile, "allow-focus")} (delete it to hide again)`] }, null, 2)}\n`);
}

export function sourceFingerprint(directory = root) {
  const git = (...args) => execFileSync("git", args, { cwd: directory, encoding: "utf8" });
  const generated = new Set(["main.js", "experiences/sharing/viewer-bundle.generated.ts"]);
  const files = [...new Set(git("ls-files", "--cached", "--others", "--exclude-standard", "-z").split("\0").filter(name => name && !generated.has(name)))].sort();
  return hash(JSON.stringify({ commit: git("rev-parse", "HEAD").trim(), branch: git("branch", "--show-current").trim(), files: files.map(name => [name, existsSync(join(directory, name)) ? hash(readFileSync(join(directory, name))) : null]) }));
}

export function assertSourceUnchanged(expected, directory = root) {
  if (sourceFingerprint(directory) !== expected) throw new Error("Source changed during verification; rerun the harness before E2E.");
}

/** Best effort: fetch the dependency table test:affected needs from the latest green full CI run on main. Any failure leaves it missing, which means the full suite. */
export function fetchDepsTable(directory = root, exec = execFileSync) {
  const table = join(directory, "test-deps.json");
  if (existsSync(table)) return false;
  let scratch;
  try {
    const rows = exec("gh", ["run", "list", "--workflow", "ci.yml", "--branch", "main", "--limit", "20", "--json", "databaseId,displayTitle,conclusion", "--jq", '.[] | select(.conclusion == "success") | select(.displayTitle | startswith("CI full")) | .databaseId'], { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const id = rows.split("\n").map(line => line.trim()).find(line => /^\d+$/.test(line));
    if (!id) return false;
    scratch = mkdtempSync(join(tmpdir(), "vam-deps-"));
    exec("gh", ["run", "download", id, "-n", "test-deps", "-D", scratch], { cwd: directory, stdio: "ignore" });
    copyFileSync(join(scratch, "test-deps.json"), table);
    return true;
  } catch { return false; } finally { if (scratch) rmSync(scratch, { recursive: true, force: true }); }
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
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

export const usage = `Usage: node scripts/test-harness.mjs [--ui | --prepare [--profile=normal|onboarding|reinstall] | --update-current [--wait-idle | --owner-idle-confirmed] | --session=<name> [--stop] [--profile=...] | --which-installed | --help]
  (no option)        build + unit + integration tests only
  --session=<name>   isolated vault /private/tmp/vam-e2e-<name>, background Obsidian driven over CDP (see scripts/obsidian-cdp.mjs, scripts/run-scenario.mjs)
  seed a picture-book map into a session vault: node scripts/book-fixture.mjs --session=<name>`;
export const isHelp = args => args.includes("--help") || args.includes("-h");

export function main(args = process.argv.slice(2)) {
  if (isHelp(args)) return process.stdout.write(`${usage}\n`);
  if (args.some(arg => arg.startsWith("--session="))) return sessionMain(args);
  if (args.includes("--which-installed")) {
    if (args.length !== 1) throw new Error("--which-installed takes no other options.");
    return process.stdout.write(`${whichInstalled()}\n`);
  }
  for (const arg of args) if (!["--ui", "--prepare", "--update-current", "--owner-idle-confirmed", "--wait-idle"].includes(arg) && !/^--profile=(normal|onboarding|reinstall)$/.test(arg)) throw new Error(`Unknown argument: ${arg}`);
  const ui = args.includes("--ui"), prepare = ui || args.includes("--prepare");
  const update = args.includes("--update-current");
  if (update && prepare) throw new Error("--update-current cannot be combined with reset/prepare options.");
  const ownerIdleConfirmed = args.includes("--owner-idle-confirmed");
  if (ownerIdleConfirmed && !update) throw new Error("--owner-idle-confirmed applies only to --update-current.");
  const waitIdle = args.includes("--wait-idle");
  if (waitIdle && (!update || ownerIdleConfirmed)) throw new Error("--wait-idle applies only to --update-current without --owner-idle-confirmed.");
  if (args.some(arg => arg.startsWith("--profile=")) && !prepare) throw new Error("Profile requires --prepare or --ui.");
  for (const name of ["VAM_TEST_TARGET_VERSION", "VAM_TEST_VAULT_PARENT", "VAM_TEST_ARTIFACT_DIR", "VAM_TEST_WORKSPACE_ROOT"]) if (process.env[name]) throw new Error(`${name} is retired in the current-branch harness; unset it to avoid testing a stale target.`);
  if (prepare) assertObsidianClosed();
  if (update) {
    // Checked before the build so a busy owner is not kept waiting, and again right before the files are replaced.
    if (ownerIdleConfirmed) process.stdout.write("--owner-idle-confirmed: skipping the owner-idle check (only after the owner said 「可以裝」).\n");
    else if (waitIdle) waitOwnerIdle(canonicalVault, { sleep: ms => spawnSync("sleep", [String(ms / 1000)]) });
    else assertOwnerIdle(canonicalVault);
    fetchDepsTable();
    run("npm", ["run", "build"]);
    const builtHashes = hashes(root);
    // The build regenerates ignored artifacts; anchor the non-destructive update
    // check after those expected outputs exist, then protect them through tests.
    const fingerprint = sourceFingerprint();
    // Only the tests this change can reach; test:affected answers every doubt (missing/stale table, unknown file) with the full suite.
    run("npm", ["run", "test:affected"]);
    assertSourceUnchanged(fingerprint);
    if (JSON.stringify(hashes(root)) !== JSON.stringify(builtHashes)) throw new Error("Build artifacts changed during tests.");
    const git = (...values) => execFileSync("git", values, { cwd: root, encoding: "utf8" });
    const source = { branch: git("branch", "--show-current").trim(), commit: git("rev-parse", "HEAD").trim(), status: git("status", "--short").trim(), fingerprint: sourceFingerprint() };
    const runtime = installedObsidianRuntime();
    source.obsidianRuntime = { version: runtime.version, hash: runtime.hash };
    source.diffHash = gitDiffHash(root, ["diff", "HEAD", "--binary"]);
    const record = updateCurrentTestVault({ source, ownerIdleConfirmed });
    const appProfile = join(canonicalVault, ".vam-app");
    if (!existsSync(join(appProfile, "obsidian.json")) || !readdirSync(appProfile).some(name => name.endsWith(".asar"))) prepareObsidianProfile(canonicalVault, installedObsidianRuntime());
    process.stdout.write(`${JSON.stringify({ vault: canonicalVault, version: record.version, hashes: record.hashes, updatedInPlace: true, appProfile }, null, 2)}\n`);
    return launchObsidian(appProfile);
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  // --help, --smoke, --session= and --which-installed are the paths that build nothing; every other form builds and runs the test layers.
  // --help must not wait for the heavy lock: it used to queue behind other test runs and never print.
  if (!isHelp(argv) && !argv.includes("--smoke") && !argv.includes("--which-installed") && !argv.some(arg => arg.startsWith("--session="))) await enterHeavy(`npm test ${argv.join(" ")}`.trim(), { blocking: true }); // main() runs spawnSync: see enterHeavy
  main();
}
