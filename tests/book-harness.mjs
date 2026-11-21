import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { bookFixtureFiles, cli as seedCli, seedBookMap } from "../scripts/book-fixture.mjs";
import { BOOK_SELECTORS, barMode, coverBlockExpression } from "../scripts/book-selectors.mjs";
import { runScenario } from "../scripts/run-scenario.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const tempVault = (marked = true) => {
  const vault = mkdtempSync(join(tmpdir(), "book-seed-"));
  if (marked) writeFileSync(join(vault, ".vam-test-environment.json"), "{}");
  return vault;
};

test("test-harness --help prints usage and exits fast instead of waiting for the heavy lock", () => {
  const result = spawnSync(process.execPath, ["scripts/test-harness.mjs", "--help"], { cwd: root, encoding: "utf8", timeout: 15_000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^Usage: node scripts\/test-harness\.mjs/);
});

test("book seeder writes root + 3 chapters with 1-2 sections each and every card note", () => {
  const vault = tempVault();
  const { mapPath, created } = seedBookMap({ vault });
  assert.equal(created, true);
  const text = readFileSync(join(vault, mapPath), "utf8");
  const map = JSON.parse(/```agent-map\n([\s\S]*?)\n```/.exec(text)[1]);
  const roots = map.nodes.filter(node => !node.parentId);
  assert.equal(roots.length, 1);
  const chapters = map.nodes.filter(node => node.parentId === roots[0].id);
  assert.equal(chapters.length, 3);
  for (const chapter of chapters) { const sections = map.nodes.filter(node => node.parentId === chapter.id).length; assert.ok(sections >= 1 && sections <= 2); }
  assert.equal(readdirSync(join(vault, mapPath, "../Notes")).length, map.nodes.length);
  for (const node of map.nodes) assert.match(readFileSync(join(vault, node.path), "utf8"), new RegExp(`node-id: ${node.id}\\n`));
});

test("book seeder is idempotent, preserves changed fixtures, and refuses the owner vault and unmarked vaults", () => {
  const vault = tempVault();
  assert.equal(seedBookMap({ vault }).created, true);
  assert.equal(seedBookMap({ vault }).created, false);
  const files = bookFixtureFiles();
  writeFileSync(join(vault, files.notes[0].path), "edited");
  assert.throws(() => seedBookMap({ vault }), /preserving it without overwrite/);
  assert.equal(readFileSync(join(vault, files.notes[0].path), "utf8"), "edited");
  const owner = tempVault();
  assert.throws(() => seedBookMap({ vault: owner, owner }), /owner's testing vault/);
  assert.throws(() => seedBookMap({ vault: tempVault(false) }), /not a harness-owned test vault/);
});

test("book seeder CLI: --help exits 0, no target exits 2, unmarked vault exits 2 with the reason", () => {
  assert.equal(seedCli(["--help"]).code, 0);
  assert.equal(seedCli([]).code, 2);
  const bad = seedCli([`--vault=${tempVault(false)}`]);
  assert.equal(bad.code, 2);
  assert.match(bad.text, /not a harness-owned test vault/);
});

test("book selectors are all classes the product still renders", () => {
  const sources = ["experiences/visual-map", "core/book-pipeline"].flatMap(dir => readdirSync(join(root, dir)).filter(name => name.endsWith(".ts")).map(name => readFileSync(join(root, dir, name), "utf8")));
  sources.push(readFileSync(join(root, "styles.css"), "utf8"));
  const all = sources.join("\n");
  for (const [name, selector] of Object.entries(BOOK_SELECTORS)) {
    const cls = selector.replace(/^\./, "");
    assert.ok(all.includes(cls), `${name}: ${cls} not found in the product source`);
  }
  assert.equal(barMode("gate1"), ".vam-book-bar[data-mode='gate1']");
  assert.match(coverBlockExpression("a b.md"), /book-cover:v1/);
});

const appWith = sequence => async () => {
  let call = 0;
  return { async evaluate(expr) { if (expr.includes("querySelectorAll")) return sequence[Math.min(call++, sequence.length - 1)]; return true; }, async click() {}, async press() {}, async screenshot(path) { return path; }, errors: () => [], close() {} };
};
const run = (scenario, app) => runScenario({ vault: "v", ...scenario }, { logDir: mkdtempSync(join(tmpdir(), "scn-")), connect: app, wait: async () => {} });

test("waitFor polls until the selector shows, then later steps run", async () => {
  const r = await run({ steps: [{ waitFor: ".x", timeoutMs: 5000 }, { assert: "after", eval: "ok" }] }, appWith([{ count: 0, visible: false }, { count: 1, visible: true }]));
  assert.equal(r.exitCode, 0);
  assert.ok(r.lines.some(l => l === "PASS after"));
});

test("waitFor gone waits for the element to disappear", async () => {
  const r = await run({ steps: [{ waitFor: ".x", gone: true, timeoutMs: 5000 }, { assert: "after", eval: "ok" }] }, appWith([{ count: 1, visible: true }, { count: 0, visible: false }]));
  assert.equal(r.exitCode, 0);
});

test("waitFor that times out is a FAIL naming the selector and stops the scenario (not a crash, not a pass)", async () => {
  const r = await run({ steps: [{ waitFor: ".never", timeoutMs: 300 }, { assert: "must not run", eval: "ok" }] }, appWith([{ count: 0, visible: false }]));
  assert.equal(r.exitCode, 1);
  assert.ok(r.lines.some(l => l.startsWith("FAIL wait for .never to be visible: not met within 300ms")));
  assert.ok(!r.lines.some(l => l === "PASS must not run"));
});

test("waitUntil polls a JavaScript expression; bad wait steps are format errors", async () => {
  let n = 0;
  const app = async () => ({ async evaluate(expr) { return expr === "ready()" ? ++n >= 3 : true; }, async click() {}, async press() {}, async screenshot(p) { return p; }, errors: () => [], close() {} });
  const ok = await run({ steps: [{ waitUntil: "ready()", timeoutMs: 5000 }, { assert: "a", eval: "ok" }] }, app);
  assert.equal(ok.exitCode, 0);
  assert.equal(n, 3);
  for (const step of [{ waitFor: ".x", timeoutMs: 0 }, { waitFor: ".x", eval: "1" }, { waitUntil: "1", gone: true }, { timeoutMs: 5 }]) {
    const bad = await run({ steps: [step, { assert: "a", eval: "ok" }] }, appWith([{ count: 1, visible: true }]));
    assert.equal(bad.exitCode, 2, JSON.stringify(step));
  }
});

test("trust step leaves Restricted Mode, and a prompt left open makes the run crash instead of continue", async () => {
  const withTrust = result => async () => ({ async evaluate(expr) { return expr.includes("getWindowStack") ? result : true; }, async click() {}, async press() {}, async screenshot(p) { return p; }, errors: () => [], close() {} });
  const steps = [{ trust: true }, { assert: "a", eval: "ok" }];
  assert.equal((await run({ steps }, withTrust({ prompts: 0, leakedScopes: 0 }))).exitCode, 0);
  assert.equal((await run({ steps }, withTrust({ prompts: 1, leakedScopes: 0 }))).exitCode, 2);
  assert.equal((await run({ steps: [{ trust: false }, { assert: "a", eval: "ok" }] }, withTrust({ prompts: 0, leakedScopes: 0 }))).exitCode, 2);
});

test("book seeder --small: root + 2 chapters in its own topic folder, every card note written", () => {
  const vault = tempVault();
  const { mapPath, created } = seedBookMap({ vault, small: true });
  assert.equal(created, true);
  assert.match(mapPath, /Book Fixture Small\/Map\.md$/);
  const map = JSON.parse(/```agent-map\n([\s\S]*?)\n```/.exec(readFileSync(join(vault, mapPath), "utf8"))[1]);
  assert.equal(map.nodes.length, 3);
  assert.equal(map.nodes.filter(node => !node.parentId).length, 1);
  assert.equal(readdirSync(join(vault, mapPath, "../Notes")).length, 3);
  assert.equal(seedBookMap({ vault }).created, true, "the full fixture sits beside it without colliding");
  assert.match(seedCli([`--vault=${vault}`, "--small"]).text, /"created": false/);
});
