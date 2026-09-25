import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { sourceFingerprint } from "./test-harness.mjs";

const vault = resolve(process.argv[2] || "/private/tmp/vam-e2e-current");
const environmentPath = `${vault}/.vam-test-environment.json`;
const reportPath = "/private/tmp/vam-runtime-last-report.json";
const startedAt = new Date().toISOString();
const report = { startedAt, vault, status: "running", checks: [], diagnostics: {} };

function run(...args) {
  const result = spawnSync("obsidian", args, { cwd: vault, encoding: "utf8", timeout: 15_000, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`obsidian ${args[0]} failed: ${(result.stderr || result.stdout || result.error?.message || "unknown CLI error").trim()}`);
  return result.stdout.trim();
}

function evaluate(expression) {
  const output = run("eval", `code=${expression}`);
  const value = output.startsWith("=> ") ? output.slice(3) : output;
  return JSON.parse(value);
}

async function waitFor(name, predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = evaluate(`JSON.stringify((()=>{const p=app.plugins.plugins["visual-agent-map"];return {vault:app.vault.getName(),enabled:app.plugins.enabledPlugins.has("visual-agent-map"),ready:!!p?.repo,language:p?.settings?.language,workspaceInitialized:p?.settings?.workspaceInitialized,sample:app.workspace.getLeavesOfType("visual-agent-map-view").some(l=>l.view.builtIn)}})())`);
      if (predicate(last)) return last;
    } catch { /* The app may still be starting; the bounded deadline captures the last state. */ }
    await delay(500);
  }
  throw new Error(`Timed out waiting for ${name}: ${JSON.stringify(last)}`);
}

function check(name, condition, details) {
  assert.ok(condition, `${name}: ${details ?? "condition failed"}`);
  report.checks.push({ name, status: "passed", details });
}

function save(status) {
  report.status = status;
  report.finishedAt = new Date().toISOString();
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}

try {
  assert.ok(existsSync(environmentPath), `Managed test-vault record not found at ${environmentPath}`);
  const environment = JSON.parse(readFileSync(environmentPath, "utf8"));
  assert.equal(environment.kind, "vam-disposable-test-vault", "refusing a vault not owned by the plugin test harness");
  assert.equal(environment.profile, "onboarding", "runtime smoke requires a clean onboarding profile");
  assert.equal(environment.owner, resolve(new URL("..", import.meta.url).pathname), "vault belongs to another checkout");
  check("Source fingerprint matches prepared build", sourceFingerprint() === environment.source.fingerprint, environment.source.fingerprint);
  report.source = environment.source;
  for (const name of ["main.js", "manifest.json", "styles.css"]) {
    const actual = createHash("sha256").update(readFileSync(`${vault}/.obsidian/plugins/visual-agent-map/${name}`)).digest("hex");
    check(`${name} matches the prepared build`, actual === environment.hashes[name], actual);
  }

  const appVersion = run("version").split(/\s/)[0];
  check("Obsidian runtime version", appVersion === environment.source.obsidianRuntime.version, `${appVersion} matches harness runtime`);
  const activeVaultPath = run("vault", "info=path").replace(/\/$/, "");
  check("CLI targets the canonical test vault", activeVaultPath === vault.replace(/\/$/, ""), activeVaultPath);

  await waitFor("VAM cold-start initialization", state => state.vault === "vam-e2e-current" && state.enabled && state.ready && state.workspaceInitialized && state.sample);
  const initial = evaluate(`JSON.stringify((() => { const p=app.plugins.plugins["visual-agent-map"]; const leaves=app.workspace.getLeavesOfType("visual-agent-map-view"); return { enabled:app.plugins.enabledPlugins.has("visual-agent-map"), pluginLoaded:!!p, language:p?.settings?.language, workspaceInitialized:p?.settings?.workspaceInitialized, ready:!!p?.repo, sample:leaves.some(l=>l.view.builtIn), mapTitles:leaves.map(l=>l.view.getDisplayText()), commands:p?.localizedCommands?.map(x=>x.command.name), logEntries:p?.logs?.entries||[] }; })())`);
  check("VAM is enabled and initialized", initial.enabled && initial.pluginLoaded && initial.ready && initial.workspaceInitialized, JSON.stringify({ enabled: initial.enabled, loaded: initial.pluginLoaded, ready: initial.ready, workspaceInitialized: initial.workspaceInitialized }));
  check("Fresh English install selects English", initial.language === "en", `language=${initial.language}`);
  check("First launch opens the official Sample", initial.sample && initial.mapTitles.some(title => title.startsWith("Sample:")), JSON.stringify(initial.mapTitles));
  check("VAM command entry points registered", initial.commands?.some(name => name.endsWith("Open mind map")) && initial.commands?.some(name => name.endsWith("Open the Taiwan travel sample")), JSON.stringify(initial.commands));

  const startupErrors = run("dev:errors");
  report.diagnostics.startupErrors = startupErrors;
  check("No captured startup errors", /^No errors captured\.?$/.test(startupErrors), startupErrors);
  run("dev:debug", "on");
  run("dev:errors", "clear");
  run("dev:console", "clear");
  run("command", "id=visual-agent-map:open-built-in-sample");
  const sample = evaluate(`JSON.stringify((() => { const p=app.plugins.plugins["visual-agent-map"]; const v=app.workspace.getLeavesOfType("visual-agent-map-view").find(l=>l.view.builtIn)?.view; return { language:p.settings.language, builtIn:!!v, title:v?.getDisplayText(), badge:document.querySelector(".vam-readonly-badge")?.innerText||"", start:document.querySelector(".vam-sample-start")?.innerText||"", command:p.localizedCommands.find(x=>x.command.id==="open-map")?.command.name }; })())`);
  check("Sample command opens the built-in read-only map", sample.builtIn && sample.badge.includes("Official sample") && sample.title.includes("Taiwan Journey"), JSON.stringify({ title: sample.title, badge: sample.badge }));
  check("English first-use actions are visible without Codex", sample.start.includes("Duplicate to my workspace") && sample.start.includes("Create an empty mind map") && sample.start.includes("only needed for AI tasks"), sample.start.replace(/\s+/g, " "));

  evaluate(`(async()=>{await app.plugins.plugins["visual-agent-map"].settingTab.setControlValue("language","zh-TW"); return true})()`);
  const chinese = evaluate(`JSON.stringify((() => { const p=app.plugins.plugins["visual-agent-map"]; const v=app.workspace.getLeavesOfType("visual-agent-map-view").find(l=>l.view.builtIn)?.view; return { language:p.settings.language, title:v?.getDisplayText(), mapTitle:v?.map?.title, command:p.localizedCommands.find(x=>x.command.id.endsWith(":open-map"))?.command.name, hint:document.querySelector(".vam-sample-start")?.innerText||"" }; })())`);
  check("Language change updates Sample and entry points", chinese.language === "zh-TW" && chinese.command === "開啟心智圖" && chinese.mapTitle?.includes("台灣"), JSON.stringify({ language: chinese.language, mapTitle: chinese.mapTitle, command: chinese.command }));
  check("Chinese first-use actions remain available", chinese.hint.includes("複製到我的工作區") && chinese.hint.includes("建立空白心智圖"), chinese.hint.replace(/\s+/g, " "));

  evaluate(`(async()=>{await app.plugins.plugins["visual-agent-map"].settingTab.setControlValue("language","en"); return true})()`);
  const afterSwitch = evaluate(`JSON.stringify((() => { const p=app.plugins.plugins["visual-agent-map"]; const v=app.workspace.getLeavesOfType("visual-agent-map-view").find(l=>l.view.builtIn)?.view; return { language:p.settings.language, title:v?.map?.title, command:p.localizedCommands.find(x=>x.command.id.endsWith(":open-map"))?.command.name }; })())`);
  check("Switching back restores English Sample", afterSwitch.language === "en" && afterSwitch.command === "Open mind map" && afterSwitch.title?.includes("Taiwan Journey"), JSON.stringify(afterSwitch));

  const errors = run("dev:errors");
  const pluginLogs = evaluate(`JSON.stringify(app.plugins.plugins["visual-agent-map"].logs.entries.filter(e=>e.level==="error"||e.message.includes("初始化未完成")))`);
  report.diagnostics.errors = errors;
  report.diagnostics.pluginErrors = pluginLogs;
  check("No captured Obsidian or VAM initialization errors", /^No errors captured\.?$/.test(errors) && pluginLogs.length === 0, JSON.stringify({ errors, pluginErrors: pluginLogs }));

  report.runtime = { appVersion, activeVaultPath };
  save("passed");
  process.stdout.write(`${JSON.stringify({ status: report.status, checks: report.checks.length, reportPath }, null, 2)}\n`);
} catch (error) {
  try {
    report.diagnostics.errors = run("dev:errors");
    try { report.diagnostics.console = run("dev:console", "level=error", "limit=50"); } catch (consoleError) { report.diagnostics.console = String(consoleError); }
    report.diagnostics.workspace = run("workspace");
    report.diagnostics.plugin = evaluate(`JSON.stringify((()=>{const p=app.plugins.plugins["visual-agent-map"];return p?{enabled:app.plugins.enabledPlugins.has("visual-agent-map"),language:p.settings?.language,workspaceInitialized:p.settings?.workspaceInitialized,logs:p.logs?.entries}:null})())`);
  } catch (diagnosticError) { report.diagnostics.collectionFailure = String(diagnosticError); }
  report.failure = error instanceof Error ? error.message : String(error);
  save("failed");
  process.stderr.write(`${report.failure}\nRuntime diagnostics saved to ${reportPath}\n`);
  process.exitCode = 1;
}
