"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = rel => fs.readFileSync(path.join(root, rel), "utf8");

const ts = require("typescript");
function load(src) {
  const code = ts.transpileModule(src.slice(src.indexOf("export function showsToResearch")), {
    compilerOptions: { target: "ES2020" }
  }).outputText;
  return new Function(`${code.replace("export function", "function")} return { showsToResearch };`)();
}

test("a conclusion card never says To research; other types still do", () => {
  const src = read("experiences/visual-map/topic-kind-shape.ts");
  assert.match(src, /export function showsToResearch/);
  const { showsToResearch } = load(src);
  assert.equal(showsToResearch("conclusion", "idea"), false);
  assert.equal(showsToResearch("conclusion", "completed"), true);
  assert.equal(showsToResearch("topic", "idea"), true);
  assert.equal(showsToResearch("hypothesis", "idea"), true);
});

test("the card view routes its status label (both card label sites) through showsToResearch", () => {
  const view = read("experiences/visual-map/view.ts");
  assert.equal((view.match(/showsToResearch\(/g) || []).length >= 2, true);
});

test("research prompts remove outdated no-source statements and keep strength on the card only", () => {
  for (const f of ["core/steps/task/conflict-rule.en.md", "core/steps/task/conflict-rule.zh.md"])
    assert.match(read(f), /delete|刪除/);
  for (const f of ["en", "zh-TW", "zh-CN"]) {
    const t = read(`core/blocks/template/hypothesis.${f}.md`);
    assert.match(t, /Strength|强度|強度/);
  }
});

test("a card marked 100% progress never says To research; the map header shows the marked progress", () => {
  const shape = read("experiences/visual-map/topic-kind-shape.ts");
  const { showsToResearch } = load(shape);
  assert.equal(showsToResearch("topic", "idea", true), false);
  assert.equal(showsToResearch("topic", "idea", false), true);
  assert.equal(showsToResearch("topic", "completed", true), true);
  const view = read("experiences/visual-map/view.ts");
  assert.match(view, /progressDone\(node\.id\)/);
  assert.match(view, /markedProgressPercent\(/);
  for (const f of ["en", "zh-TW", "zh-CN"]) assert.match(read(`i18n/${f}.ts`), /"ui\.marked_progress_0"/);
});
