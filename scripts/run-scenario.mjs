// Fixed entry for live-Obsidian checks: runs one scenario file against a harness vault over CDP and prints only the
// assertion results and a failure summary. The full log and screenshots go to a directory outside the repo
// (default: the OS temp dir), so a tester reads a few lines instead of piping eval output through the shell.
// Exit codes: 0 every assertion passed; 1 an assertion or step failed; 2 harness/usage/product crash. PASS is printed
// only when the scenario ran to the end, made at least one assertion, and the app threw no uncaught exception.
//
// Scenario file (JSON): { "name", "vault"?, "allowErrors"?, "steps": [ ... ] }. Steps:
//   {"wait": true}                              wait for the workspace to be ready
//   {"eval": "<js>"}                            run JavaScript in the app window (result goes to the log)
//   {"click": "<css selector>"}                 trusted click on the first visible match
//   {"key": "Mod+Enter"}                        trusted key press
//   {"sleep": 500}                              wait milliseconds
//   {"screenshot": "name"}                      save <log dir>/name.png (path goes to the log)
//   {"assert": "label", "eval": "<js>", "equals"?: <json>, "contains"?: "<text>"}   truthy value when neither is given
//   {"assert": "label", "selector": "<css>", "visible"?: true|false}               element exists (and is shown / hidden)
// Each step holds exactly one action; extra or unknown keys (or equals/contains without assert) are a format error (exit 2).
// Every step has a timeout (default 90s, "stepTimeoutMs" in the scenario overrides; wait steps get +60s, sleep steps +sleep
// ms); a step that never answers (app crashed, socket gone) is a CRASH, never a silent exit.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { clickSelector, connectCdp, waitForInstance } from "./obsidian-cdp.mjs";

const visibleExpression = selector => `(()=>{const els=[...document.querySelectorAll(${JSON.stringify(selector)})];return {count:els.length,visible:els.some(el=>{const r=el.getBoundingClientRect();return r.width>0&&r.height>0})}})()`;

function judge(step, value) {
  if ("equals" in step) return { ok: JSON.stringify(value) === JSON.stringify(step.equals), detail: `got ${short(value)}, expected ${short(step.equals)}` };
  if ("contains" in step) return { ok: String(value).includes(step.contains), detail: `got ${short(value)}, expected to contain ${short(step.contains)}` };
  return { ok: Boolean(value), detail: `got ${short(value)}, expected truthy` };
}
const ACTIONS = ["wait", "eval", "click", "key", "sleep", "screenshot"];
const KNOWN = new Set([...ACTIONS, "assert", "selector", "visible", "equals", "contains"]);
// Returns an error text when a step is malformed, otherwise undefined.
function validateStep(step, index) {
  const where = `step ${index + 1}`;
  if (!step || typeof step !== "object" || Array.isArray(step)) return `${where} is not an object`;
  const keys = Object.keys(step);
  const unknown = keys.filter(key => !KNOWN.has(key));
  if (unknown.length) return `${where} has unknown key(s): ${unknown.join(", ")}`;
  if (step.assert !== undefined) {
    const extra = keys.filter(key => ACTIONS.includes(key) && key !== "eval");
    if (extra.length) return `${where} mixes assert with ${extra.join(", ")}`;
    if ((step.eval === undefined) === (step.selector === undefined)) return `${where} assert needs exactly one of eval or selector`;
    if (step.selector !== undefined && ("equals" in step || "contains" in step)) return `${where} equals/contains only work with an eval assert`;
    if (step.eval !== undefined && "visible" in step) return `${where} visible only works with a selector assert`;
    if ("equals" in step && "contains" in step) return `${where} has both equals and contains`;
    return undefined;
  }
  const actions = keys.filter(key => ACTIONS.includes(key));
  if (actions.length !== 1) return `${where} needs exactly one action (${ACTIONS.join("/")}) or assert, got ${actions.length ? actions.join("+") : "none"}`;
  const stray = keys.filter(key => !ACTIONS.includes(key));
  if (stray.length) return `${where} has ${stray.join(", ")} without assert`;
  return undefined;
}

const DEFAULT_STEP_TIMEOUT_MS = 90_000;
const WAIT_STEP_EXTRA_MS = 60_000; // waitForInstance gives up after 60s on its own; the step limit must outlast it
const ERRORS_SETTLE_MS = 200; // same pause as `obsidian-cdp.mjs errors`

function withTimeout(promise, ms, what) {
  if (!(ms > 0)) return promise;
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms (app not answering?)`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const short = value => { const text = JSON.stringify(value) ?? "undefined"; return text.length > 160 ? `${text.slice(0, 160)}...` : text; };

// Runs the scenario and returns { exitCode, lines, logFile }. `deps` lets tests replace the app connection.
// `state` (optional) is filled with { logFile, results, done } so a caller can report progress if the run never returns.
export async function runScenario(scenario, { logDir, connect = connectCdp, wait = waitForInstance, vault = scenario.vault, state = {} } = {}) {
  mkdirSync(logDir, { recursive: true });
  const logFile = join(logDir, "scenario.log");
  state.logFile = logFile;
  writeFileSync(logFile, "");
  const log = text => appendFileSync(logFile, `${text}\n`);
  const lines = [];
  const results = [];
  state.results = results;
  let allowed = 0;
  const fail = (label, detail) => { results.push({ label, ok: false }); lines.push(`FAIL ${label}: ${detail}`); log(`FAIL ${label}: ${detail}`); };
  const finish = (exitCode, verdict) => { lines.push(`${verdict} ${scenario.name ?? "scenario"} (${results.filter(r => r.ok).length}/${results.length} assertions${allowed ? `, ${allowed} uncaught exception(s) allowed by allowErrors` : ""}) full log: ${logFile}`); return { exitCode, lines, logFile }; };
  if (!Array.isArray(scenario.steps) || !vault) return finish(2, "CRASH invalid scenario (needs vault and steps)");
  for (const [index, step] of scenario.steps.entries()) {
    const problem = validateStep(step, index);
    if (problem) { log(`CRASH invalid scenario: ${problem}`); lines.push(`CRASH invalid scenario: ${problem}`); return finish(2, "CRASH"); }
  }
  const baseTimeout = scenario.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
  let cdp;
  let current = "";
  const guard = (promise, extra = 0) => withTimeout(promise, baseTimeout > 0 ? baseTimeout + extra : 0, current);
  try {
    for (const [index, step] of scenario.steps.entries()) {
      current = `step ${index + 1}`;
      log(`step ${index + 1}: ${JSON.stringify(step).slice(0, 300)}`);
      if (step.wait) { await guard(wait(vault), WAIT_STEP_EXTRA_MS); continue; }
      cdp ??= await guard(connect(vault));
      const evaluate = expression => guard(cdp.evaluate(expression));
      if (step.assert !== undefined) {
        let value;
        if (step.selector !== undefined) {
          const found = await evaluate(visibleExpression(step.selector));
          const wantVisible = step.visible !== false;
          const ok = wantVisible ? found.visible : found.count === 0 || !found.visible;
          value = found;
          log(`  assert ${step.assert}: ${JSON.stringify(found)}`);
          if (ok) { results.push({ label: step.assert, ok: true }); lines.push(`PASS ${step.assert}`); } else fail(step.assert, `selector ${step.selector} ${JSON.stringify(found)}, expected ${wantVisible ? "visible" : "hidden"}`);
          continue;
        }
        value = await evaluate(step.eval);
        log(`  assert ${step.assert}: ${short(value)}`);
        const verdict = judge(step, value);
        if (verdict.ok) { results.push({ label: step.assert, ok: true }); lines.push(`PASS ${step.assert}`); } else fail(step.assert, verdict.detail);
      } else if (step.eval !== undefined) log(`  => ${short(await evaluate(step.eval))}`);
      else if (step.click !== undefined) log(`  => ${JSON.stringify(await guard(clickSelector(cdp, step.click)))}`);
      else if (step.key !== undefined) await guard(cdp.press(step.key));
      else if (step.sleep !== undefined) await guard(delay(Number(step.sleep)), Number(step.sleep));
      else if (step.screenshot !== undefined) log(`  => ${await guard(cdp.screenshot(join(logDir, `${String(step.screenshot).replace(/[^\w.-]/g, "_")}.png`)))}`);
    }
    let errors = [];
    if (cdp) { current = "reading app errors"; await guard(delay(ERRORS_SETTLE_MS)); errors = cdp.errors(); }
    if (errors.length && scenario.allowErrors) allowed = errors.length;
    if (errors.length && !scenario.allowErrors) { log(errors.join("\n")); fail("no uncaught exceptions in the app", `${errors.length} captured, first: ${errors[0].split("\n")[0].slice(0, 160)}`); }
  } catch (error) {
    // A step that throws (app gone, selector missing, bad JavaScript) is a crash or failure, never a pass.
    log(`CRASH ${error.stack ?? error.message}`);
    lines.push(`CRASH step could not complete: ${String(error.message).split("\n")[0].slice(0, 200)}`);
    return finish(2, "CRASH");
  } finally { cdp?.close(); }
  if (results.length === 0) { lines.push("FAIL no assertions ran"); return finish(1, "FAIL"); }
  return results.every(r => r.ok) ? finish(0, "PASS") : finish(1, "FAIL");
}

export const usage = "Usage: node scripts/run-scenario.mjs <scenario.json> [--vault=<path>] [--log-dir=<dir>]";

async function cli(args) {
  const file = args.find(arg => !arg.startsWith("--"));
  if (!file) { process.stderr.write(`${usage}\n`); return 2; }
  const option = name => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  let scenario;
  try { scenario = JSON.parse(readFileSync(file, "utf8")); }
  catch (error) { process.stderr.write(`CRASH cannot read scenario ${file}: ${error.message}\n`); return 2; }
  const logDir = resolve(option("log-dir") ?? join(tmpdir(), "vam-scenario", `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`));
  // If the event loop empties before the run returns (socket died with a call pending), exit non-zero and say so.
  process.exitCode = 2;
  const state = { done: false };
  process.on("beforeExit", () => {
    if (state.done) return;
    state.done = true;
    const passed = (state.results ?? []).filter(r => r.ok).length;
    process.stdout.write(`CRASH scenario did not finish (app connection lost?) (${passed}/${(state.results ?? []).length} assertions) full log: ${state.logFile ?? "none"}\n`);
    process.exitCode = 2;
  });
  const { exitCode, lines } = await runScenario(scenario, { logDir, vault: option("vault") ?? scenario.vault, state });
  state.done = true;
  process.stdout.write(`${lines.join("\n")}\n`);
  return exitCode;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => { process.stderr.write(`CRASH ${error.message}\n`); process.exitCode = 2; });
}
