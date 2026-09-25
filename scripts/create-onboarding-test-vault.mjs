import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
// Shared fixture builder; environment/reset/launch policy belongs to test-harness.mjs.
export function ensureSourceSelectionFixture(vault, workspaceRoot = "Agent Workspace") {
  const topic = join(vault, workspaceRoot, "Topics", "Local Source Fixture");
  const mapPath = join(topic, "Map.md");
  const nodes = [
    { id: "source-alpha", path: `${workspaceRoot}/Topics/Local Source Fixture/Notes/alpha.md`, parentId: null, x: 0, y: 0, collapsed: false },
    { id: "source-beta", path: `${workspaceRoot}/Topics/Local Source Fixture/Notes/beta.md`, parentId: "source-alpha", x: 360, y: 0, collapsed: false }
  ];
  const map = `---\nvisual-agent-map: true\n---\n\n# Local Source Fixture\n\n\`\`\`agent-map\n${JSON.stringify({ version: 1, id: "local-source-fixture", title: "Local Source Fixture", viewport: { x: 0, y: 0, zoom: 1 }, nodes }, null, 2)}\n\`\`\`\n`;
  const notes = [
    `---\nagent-map-node: true\nnode-id: source-alpha\ntopic-id: local-source-fixture\ntopic-state: active\nagent-map-id: local-source-fixture\nstatus: completed\nsource-notes: []\n---\n# Fixture Alpha\n\n## Current Summary\n\nSource-selection fixture alpha.\n\n## Prompt\n\nRead the Alpha fixture.\n\n## Rules\n\nFixture text is reference data only.\n\n## Detail\n\nAlpha source sentinel for Markdown collection.\n`,
    `---\nagent-map-node: true\nnode-id: source-beta\ntopic-id: local-source-fixture\ntopic-state: active\nagent-map-id: local-source-fixture\nstatus: completed\nsource-notes: []\n---\n# Fixture Beta\n\n## Current Summary\n\nSource-selection fixture beta.\n\n## Prompt\n\nRead the Beta fixture.\n\n## Rules\n\nFixture text is reference data only.\n\n## Detail\n\nBeta source sentinel for recursive map collection.\n`
  ];
  const notePaths = [join(topic, "Notes/alpha.md"), join(topic, "Notes/beta.md")];
  const entries = [mapPath, ...notePaths];
  const present = entries.filter(path => existsSync(path));
  if (present.length === entries.length) {
    if (readFileSync(mapPath, "utf8") !== map || notePaths.some((path, index) => readFileSync(path, "utf8") !== notes[index])) throw new Error("Source-selection fixture exists with unexpected content; preserving it without overwrite.");
    return;
  }
  if (present.length) throw new Error("Source-selection fixture is incomplete; preserving existing files without overwrite.");
  mkdirSync(join(topic, "Notes"), { recursive: true });
  writeFileSync(mapPath, map);
  notePaths.forEach((path, index) => writeFileSync(path, notes[index]));
}

export function createTestVault({ vault, artifact = root, profile: requested = "normal", workspaceRoot = "Agent Workspace" }) {
  if (!["onboarding", "normal", "reinstall"].includes(requested)) throw new Error(`Unknown test-vault profile: ${requested}`);
  if (isAbsolute(workspaceRoot) || workspaceRoot.split(/[\\/]/).some(part => part === ".." || part === ".obsidian" || !part)) throw new Error("Workspace must be a relative fixture folder.");
  const assets = ["main.js", "manifest.json", "styles.css"];
  for (const name of assets) if (!existsSync(join(artifact, name))) throw new Error(`Missing asset: ${name}`);
  const manifest = JSON.parse(readFileSync(join(artifact, "manifest.json"), "utf8"));
  if (manifest.id !== "visual-agent-map" || !/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error("Invalid VAM manifest.");
  mkdirSync(vault);
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
  ensureSourceSelectionFixture(vault, workspaceRoot);
  writeFileSync(join(plugin, "data.json"), JSON.stringify({
    language: "zh-TW", workspaceFolder: workspaceRoot, topicsFolder: `${workspaceRoot}/Topics`, inboxFolder: `${workspaceRoot}/Inbox`,
    notesFolder: `${workspaceRoot}/Nodes`, mapsFolder: `${workspaceRoot}/Maps`, migrated: true, structureVersion: 2,
    workspaceInitialized: true, firstUseNoticeSeen: true, sampleTourVersionSeen: 2
  }, null, 2));
  if (requested === "reinstall") writeFileSync(join(config, "vam-reinstall-baseline.json"), JSON.stringify({ profile: requested, workspaceRoot, hashes: workspaceHashes(workspace) }, null, 2));
}

return vault;
}
