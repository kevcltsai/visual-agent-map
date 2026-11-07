import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
