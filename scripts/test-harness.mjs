import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { createTestVault, ensureSourceSelectionFixture } from "./create-onboarding-test-vault.mjs";

export const root = fileURLToPath(new URL("..", import.meta.url));
export const canonicalVault = process.platform === "darwin" ? "/private/tmp/vam-e2e-current" : join(tmpdir(), "vam-e2e-current");
const assets = ["main.js", "manifest.json", "styles.css"];
const marker = ".vam-test-environment.json";
const obsidianApp = "/Applications/Obsidian.app";
const hash = data => createHash("sha256").update(data).digest("hex");
const hashes = folder => Object.fromEntries(assets.map(name => [name, hash(readFileSync(join(folder, name)))]));
const json = path => JSON.parse(readFileSync(path, "utf8"));

export function verifyTestVault(vault, artifact = root) {
  const record = json(join(vault, marker));
  const plugin = join(vault, ".obsidian/plugins/visual-agent-map");
  const manifest = json(join(plugin, "manifest.json"));
  if (manifest.id !== "visual-agent-map" || manifest.version !== record.version || JSON.stringify(hashes(plugin)) !== JSON.stringify(record.hashes) || JSON.stringify(hashes(artifact)) !== JSON.stringify(record.hashes)) throw new Error("Installed plugin identity/hash mismatch.");
  const enabled = json(join(vault, ".obsidian/community-plugins.json"));
  if (JSON.stringify(enabled) !== JSON.stringify([manifest.id])) throw new Error("Plugin enablement mismatch.");
  if (record.profile !== "onboarding") {
    const settings = json(join(plugin, "data.json"));
    if (!settings.workspaceInitialized || settings.workspaceFolder !== record.workspaceRoot || !existsSync(join(vault, settings.workspaceFolder, "Topics/Taiwan Travel Regression/Map.md"))) throw new Error("Fixture/settings mismatch.");
    if (!existsSync(join(vault, settings.workspaceFolder, "Topics/Local Source Fixture/Map.md"))) throw new Error("Local-source fixture missing.");
  }
  return record;
}

// Only a vault created by this checkout may be reset. Never follow a root symlink.
export function prepareTestVault({ vault = canonicalVault, artifact = root, profile = "normal", workspaceRoot = "Agent Workspace", source = {} } = {}) {
  if (existsSync(vault) || (() => { try { lstatSync(vault); return true; } catch { return false; } })()) {
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

// Refresh only installed code in an owned Vault. Preserve every fixture, note, and attachment.
export function updateCurrentTestVault({ vault = canonicalVault, artifact = root, source = {} } = {}) {
  if (!existsSync(vault) || lstatSync(vault).isSymbolicLink() || !lstatSync(vault).isDirectory() || !existsSync(join(vault, marker))) throw new Error("Refusing to update a missing or unowned test vault.");
  const recordPath = join(vault, marker), record = json(recordPath);
  if (record.owner !== realpathSync(root) || record.kind !== "vam-disposable-test-vault") throw new Error("Refusing to update a test vault owned by another checkout.");
  const manifest = json(join(artifact, "manifest.json"));
  if (manifest.id !== "visual-agent-map" || manifest.version !== record.version) throw new Error("Artifact identity/version does not match the existing test vault.");
  const plugin = join(vault, ".obsidian/plugins/visual-agent-map");
  if (!existsSync(plugin) || lstatSync(plugin).isSymbolicLink() || !lstatSync(plugin).isDirectory()) throw new Error("Refusing an invalid installed plugin directory.");
  if (record.profile !== "onboarding") ensureSourceSelectionFixture(vault, record.workspaceRoot);
  const staging = mkdtempSync(join(plugin, ".vam-update-")), replaced = [];
  try {
    for (const name of assets) copyFileSync(join(artifact, name), join(staging, name));
    const newHashes = hashes(staging);
    if (JSON.stringify(newHashes) !== JSON.stringify(hashes(artifact))) throw new Error("Staged plugin artifacts failed hash verification.");
    for (const name of assets) if (existsSync(join(plugin, name))) copyFileSync(join(plugin, name), join(staging, `${name}.previous`));
    copyFileSync(recordPath, join(staging, `${marker}.previous`));
    try {
      for (const name of assets) { renameSync(join(staging, name), join(plugin, name)); replaced.push(name); }
      writeFileSync(join(staging, marker), JSON.stringify({ ...record, hashes: newHashes, source }, null, 2));
      renameSync(join(staging, marker), recordPath);
      return verifyTestVault(vault, artifact);
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
export function prepareObsidianProfile(vault, runtime) {
  const directory = join(vault, ".vam-app");
  mkdirSync(directory);
  const id = hash(resolve(vault)).slice(0, 16);
  writeFileSync(join(directory, "obsidian.json"), JSON.stringify({ vaults: { [id]: { path: resolve(vault), ts: 0, open: true } }, updateDisabled: true }, null, 2));
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

function launchObsidian(appProfile) {
  if (!existsSync(obsidianApp)) throw new Error(`Obsidian app bundle not found at ${obsidianApp}.`);
  return run("open", ["-na", obsidianApp, "--args", `--user-data-dir=${appProfile}`]);
}

export function sourceFingerprint(directory = root) {
  const git = (...args) => execFileSync("git", args, { cwd: directory, encoding: "utf8" });
  const generated = new Set(["main.js", "samples/taiwan-travel/compiled.json"]);
  const files = [...new Set(git("ls-files", "--cached", "--others", "--exclude-standard", "-z").split("\0").filter(name => name && !generated.has(name)))].sort();
  return hash(JSON.stringify({ commit: git("rev-parse", "HEAD").trim(), branch: git("branch", "--show-current").trim(), files: files.map(name => [name, existsSync(join(directory, name)) ? hash(readFileSync(join(directory, name))) : null]) }));
}

export function assertSourceUnchanged(expected, directory = root) {
  if (sourceFingerprint(directory) !== expected) throw new Error("Source changed during verification; rerun the harness before E2E.");
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

export function main(args = process.argv.slice(2)) {
  for (const arg of args) if (!["--ui", "--prepare", "--update-current"].includes(arg) && !/^--profile=(normal|onboarding|reinstall)$/.test(arg)) throw new Error(`Unknown argument: ${arg}`);
  const ui = args.includes("--ui"), prepare = ui || args.includes("--prepare");
  const update = args.includes("--update-current");
  if (update && prepare) throw new Error("--update-current cannot be combined with reset/prepare options.");
  if (args.some(arg => arg.startsWith("--profile=")) && !prepare) throw new Error("Profile requires --prepare or --ui.");
  for (const name of ["VAM_TEST_TARGET_VERSION", "VAM_TEST_VAULT_PARENT", "VAM_TEST_ARTIFACT_DIR", "VAM_TEST_WORKSPACE_ROOT"]) if (process.env[name]) throw new Error(`${name} is retired in the current-branch harness; unset it to avoid testing a stale target.`);
  if (prepare) assertObsidianClosed();
  if (update) {
    run("npm", ["run", "build"]);
    const builtHashes = hashes(root);
    // The build regenerates ignored artifacts; anchor the non-destructive update
    // check after those expected outputs exist, then protect them through tests.
    const fingerprint = sourceFingerprint();
    run("npm", ["run", "test:unit"]);
    run("npm", ["run", "test:integration"]);
    assertSourceUnchanged(fingerprint);
    if (JSON.stringify(hashes(root)) !== JSON.stringify(builtHashes)) throw new Error("Build artifacts changed during tests.");
    const git = (...values) => execFileSync("git", values, { cwd: root, encoding: "utf8" });
    const source = { branch: git("branch", "--show-current").trim(), commit: git("rev-parse", "HEAD").trim(), status: git("status", "--short").trim(), fingerprint: sourceFingerprint() };
    source.diffHash = gitDiffHash(root, ["diff", "HEAD", "--binary"]);
    const record = updateCurrentTestVault({ source });
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
