import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const vault = resolve(process.argv[2] || "");
const phase = process.argv[3] || "reinstalled";
if (!vault || !["uninstalled", "reinstalled"].includes(phase)) throw new Error("Usage: node scripts/verify-reinstall-test-vault.mjs <vault> <uninstalled|reinstalled>");
const config = join(vault, ".ob" + "sidian"), plugin = join(config, "plugins/visual-agent-map");
const baselinePath = join(config, "vam-reinstall-baseline.json");
if (!existsSync(baselinePath)) throw new Error("This is not a VAM reinstall fixture.");
const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
const workspace = join(vault, baseline.workspaceRoot || "Agent Workspace");
if (!existsSync(workspace)) throw new Error(`Workspace is missing: ${baseline.workspaceRoot || "Agent Workspace"}`);

function filesBelow(folder) {
  return readdirSync(folder, { withFileTypes: true }).flatMap(entry => {
    const path = join(folder, entry.name);
    return entry.isDirectory() ? filesBelow(path) : [path];
  });
}

const hashes = Object.fromEntries(filesBelow(workspace).sort().map(path => [relative(workspace, path), createHash("sha256").update(readFileSync(path)).digest("hex")]));
if (JSON.stringify(hashes) !== JSON.stringify(baseline.hashes)) throw new Error("Agent Workspace contents changed after uninstall/reinstall.");
if (phase === "uninstalled" && existsSync(plugin)) throw new Error("Plugin folder still exists; uninstall is incomplete.");
if (phase === "reinstalled") for (const name of ["main.js", "manifest.json", "styles.css"]) if (!existsSync(join(plugin, name))) throw new Error(`Reinstalled plugin is missing ${name}`);
process.stdout.write(`PASS ${phase}: ${Object.keys(hashes).length} workspace files match the baseline.\n`);
