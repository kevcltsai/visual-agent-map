import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { runScenario } from "../scripts/run-scenario.mjs";

const fakeApp = ({ values = {}, errors = [], throwOn } = {}) => async () => ({
  async evaluate(expr) { if (throwOn && expr.includes(throwOn)) throw new Error("app gone"); return expr in values ? values[expr] : true; },
  async click() {}, async press() {}, async screenshot(path) { return path; },
  errors: () => errors, close() {}
});
const run = (scenario, app) => runScenario({ vault: "v", ...scenario }, { logDir: mkdtempSync(join(tmpdir(), "scn-")), connect: app, wait: async () => {} });

test("all assertions pass -> exit 0, PASS line, log path in summary", async () => {
  const r = await run({ steps: [{ wait: true }, { assert: "a", eval: "ok" }, { assert: "b", eval: "n", equals: 2 }] }, fakeApp({ values: { n: 2 } }));
  assert.equal(r.exitCode, 0);
  assert.match(r.lines.at(-1), /^PASS .*\(2\/2 assertions\) full log: .*scenario\.log$/);
});

test("failed assertion -> exit 1, FAIL names the item and the log path, no PASS", async () => {
  const r = await run({ steps: [{ assert: "wrong", eval: "n", equals: 3 }] }, fakeApp({ values: { n: 2 } }));
  assert.equal(r.exitCode, 1);
  assert.ok(r.lines.some(l => l.startsWith("FAIL wrong: got 2, expected 3")));
  assert.ok(!r.lines.some(l => l.startsWith("PASS")));
  assert.match(r.lines.at(-1), /^FAIL .*full log: /);
  assert.match(readFileSync(r.logFile, "utf8"), /assert wrong/);
});

test("app unreachable or crashing mid-scenario -> exit 2, never PASS", async () => {
  const gone = await run({ steps: [{ assert: "a", eval: "ok" }] }, async () => { throw new Error("No DevTools port"); });
  assert.equal(gone.exitCode, 2);
  const mid = await run({ steps: [{ assert: "a", eval: "ok" }, { assert: "b", eval: "boom" }] }, fakeApp({ throwOn: "boom" }));
  assert.equal(mid.exitCode, 2);
  assert.match(mid.lines.at(-1), /^CRASH .*full log: /);
  assert.ok(!mid.lines.some(l => /^PASS .*assertions\)/.test(l)));
});

test("zero assertions is not a pass", async () => {
  const r = await run({ steps: [{ wait: true }, { eval: "ok" }] }, fakeApp());
  assert.equal(r.exitCode, 1);
  assert.ok(r.lines.some(l => l.includes("no assertions")));
});

test("uncaught app exception fails an otherwise green scenario unless allowed", async () => {
  const steps = [{ assert: "a", eval: "ok" }];
  const bad = await run({ steps }, fakeApp({ errors: ["TypeError: x\n at y"] }));
  assert.equal(bad.exitCode, 1);
  assert.ok(bad.lines.some(l => l.startsWith("FAIL no uncaught exceptions")));
  assert.equal((await run({ steps, allowErrors: true }, fakeApp({ errors: ["TypeError: x"] }))).exitCode, 0);
});

test("invalid scenario and unknown step are crashes", async () => {
  assert.equal((await run({ steps: "x" }, fakeApp())).exitCode, 2);
  assert.equal((await run({ steps: [{ assert: "a", eval: "ok" }, { bogus: 1 }] }, fakeApp())).exitCode, 2);
});

test("a step that never answers times out as CRASH (exit 2), not a hang", async () => {
  const hang = () => async () => ({ evaluate: () => new Promise(() => {}), click() {}, press() {}, screenshot() {}, errors: () => [], close() {} });
  const r = await run({ stepTimeoutMs: 50, steps: [{ assert: "a", eval: "ok" }] }, hang());
  assert.equal(r.exitCode, 2);
  assert.match(r.lines.at(-1), /^CRASH .*\(0\/0 assertions\) full log: /);
  assert.ok(r.lines.some(l => /timed out after 50ms/.test(l)));
  const slowConnect = await run({ stepTimeoutMs: 50, steps: [{ assert: "a", eval: "ok" }] }, () => new Promise(() => {}));
  assert.equal(slowConnect.exitCode, 2);
});

test("real CLI exits non-zero with a CRASH line when the event loop empties mid-scenario", () => {
  const dir = mkdtempSync(join(tmpdir(), "scn-cli-"));
  const stub = join(dir, "stub.mjs");
  // Transport stub: a socket that goes silent on Runtime.evaluate, like an Obsidian that died with a call pending.
  writeFileSync(stub, `globalThis.fetch = async () => ({ json: async () => [{ type: "page", url: "app://obsidian.md/index.html", webSocketDebuggerUrl: "ws://stub" }] });
globalThis.WebSocket = class {
  constructor() { setImmediate(() => this.onopen?.({})); }
  send(text) { const m = JSON.parse(text); if (m.method === "Runtime.evaluate") return; setImmediate(() => this.onmessage?.({ data: JSON.stringify({ id: m.id, result: {} }) })); }
  close() {}
};`);
  const vault = join(dir, "vault");
  mkdirSync(join(vault, ".vam-app"), { recursive: true });
  writeFileSync(join(vault, ".vam-app", "DevToolsActivePort"), "9999\n");
  const file = join(dir, "s.json");
  writeFileSync(file, JSON.stringify({ name: "crash probe", vault, stepTimeoutMs: 0, steps: [{ assert: "first", eval: "1" }] }));
  const r = spawnSync(process.execPath, ["--import", stub, resolve("scripts/run-scenario.mjs"), file, `--log-dir=${join(dir, "log")}`], { encoding: "utf8", timeout: 20000 });
  assert.equal(r.status, 2);
  assert.match(r.stdout, /^CRASH scenario did not finish .*\(0\/0 assertions\) full log: .*scenario\.log$/m);
});

test("malformed steps are format errors (exit 2): assert typos, mixed actions, unknown keys", async () => {
  const bad = [
    [{ eval: "ok", equals: 1 }],
    [{ eval: "ok", contains: "x" }],
    [{ assert: "a", eval: "ok", equal: 1 }],
    [{ wait: true, assert: "a", eval: "ok" }],
    [{ wait: true, sleep: 5 }],
    [{ assert: "a" }],
    [{ assert: "a", selector: "div", equals: 1 }],
    [{ click: "div", visible: true }],
    [{ bogus: 1 }]
  ];
  for (const steps of bad) {
    const r = await run({ steps: [{ assert: "ok", eval: "ok" }, ...steps] }, fakeApp());
    assert.equal(r.exitCode, 2, JSON.stringify(steps));
    assert.match(r.lines.at(-2), /^CRASH invalid scenario: /);
  }
});

test("shipped smoke scenarios are valid", async () => {
  for (const name of ["smoke-ok", "smoke-fail"]) {
    const scenario = JSON.parse(readFileSync(resolve("scripts/scenarios", `${name}.json`), "utf8"));
    const r = await run(scenario, fakeApp());
    assert.ok(!r.lines.some(l => l.startsWith("CRASH")), name);
  }
});

test("exceptions that appear after the last step still fail the run", async () => {
  const errors = [];
  const app = async () => ({
    async evaluate() { setTimeout(() => errors.push("TypeError: late"), 100); return true; },
    async click() {}, async press() {}, async screenshot(path) { return path; }, errors: () => errors, close() {}
  });
  const r = await run({ steps: [{ assert: "a", eval: "ok" }] }, app);
  assert.equal(r.exitCode, 1);
  assert.ok(r.lines.some(l => l.startsWith("FAIL no uncaught exceptions")));
});

test("allowErrors reports how many exceptions it let through", async () => {
  const r = await run({ allowErrors: true, steps: [{ assert: "a", eval: "ok" }] }, fakeApp({ errors: ["E1", "E2"] }));
  assert.equal(r.exitCode, 0);
  assert.match(r.lines.at(-1), /2 uncaught exception\(s\) allowed by allowErrors/);
});
