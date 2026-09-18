import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const requested = process.argv.find(argument => argument.startsWith("--profile="))?.split("=")[1] ?? "onboarding";
if (!["onboarding", "normal", "reinstall"].includes(requested)) throw new Error(`Unknown test-vault profile: ${requested}`);

const artifact = process.env.VAM_TEST_ARTIFACT_DIR || root;
const assets = ["main.js", "manifest.json", "styles.css"];
for (const name of assets) if (!existsSync(join(artifact, name))) throw new Error(`Missing release asset ${name} in ${artifact}`);

const vaultParent = process.env.VAM_TEST_VAULT_PARENT || tmpdir();
mkdirSync(vaultParent, { recursive: true });
const vault = mkdtempSync(join(vaultParent, `vam-${requested}-`));
const config = join(vault, ".ob" + "sidian");
const plugin = join(config, "plugins/visual-agent-map");
mkdirSync(plugin, { recursive: true });
for (const name of assets) copyFileSync(join(artifact, name), join(plugin, name));
writeFileSync(join(config, "community-plugins.json"), JSON.stringify(["visual-agent-map"], null, 2));
writeFileSync(join(config, "app.json"), JSON.stringify({ promptDelete: false }, null, 2));

function filesBelow(folder) {
  return readdirSync(folder, { withFileTypes: true }).flatMap(entry => {
    const path = join(folder, entry.name);
    return entry.isDirectory() ? filesBelow(path) : [path];
  });
}

function workspaceHashes(workspace) {
  return Object.fromEntries(filesBelow(workspace).sort().map(path => [relative(workspace, path), createHash("sha256").update(readFileSync(path)).digest("hex")]));
}

if (requested !== "onboarding") {
  const workspaceRoot = process.env.VAM_TEST_WORKSPACE_ROOT || "Agent Workspace";
  const workspace = join(vault, workspaceRoot);
  const topicRoot = join(workspace, "Topics", "Taiwan Travel Regression");
  mkdirSync(join(topicRoot, "Unassigned"), { recursive: true });
  mkdirSync(join(topicRoot, "Archive"), { recursive: true });
  mkdirSync(join(workspace, "Inbox"), { recursive: true });
  cpSync(join(root, "samples/taiwan-travel/zh-TW/Notes"), join(topicRoot, "Notes"), { recursive: true });
  cpSync(join(root, "samples/taiwan-travel/Attachments"), join(topicRoot, "Attachments"), { recursive: true, filter: source => statSync(source).isDirectory() || source.endsWith(".webp") });
  const notePrefix = `${workspaceRoot}/Topics/Taiwan Travel Regression/Notes/`;
  const map = readFileSync(join(root, "samples/taiwan-travel/zh-TW/Map.md"), "utf8").replaceAll('"Notes/', `"${notePrefix}`);
  writeFileSync(join(topicRoot, "Map.md"), map);
  for (const path of filesBelow(join(topicRoot, "Notes"))) writeFileSync(path, readFileSync(path, "utf8").replaceAll("Notes/", notePrefix));
  writeFileSync(join(plugin, "data.json"), JSON.stringify({
    language: "zh-TW", workspaceFolder: workspaceRoot, topicsFolder: `${workspaceRoot}/Topics`, inboxFolder: `${workspaceRoot}/Inbox`,
    notesFolder: `${workspaceRoot}/Nodes`, mapsFolder: `${workspaceRoot}/Maps`, migrated: true, structureVersion: 2,
    workspaceInitialized: true, firstUseNoticeSeen: true, sampleTourVersionSeen: 2
  }, null, 2));
  if (requested === "reinstall") writeFileSync(join(config, "vam-reinstall-baseline.json"), JSON.stringify({ profile: requested, workspaceRoot, hashes: workspaceHashes(workspace) }, null, 2));
}

process.stdout.write(`${vault}\n`);
