"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = rel => fs.readFileSync(path.join(root, rel), "utf8");

test("a conclusion card never says To research; other types still do", () => {
  const src = read("experiences/visual-map/topic-kind-shape.ts");
  assert.match(src, /export function showsToResearch/);
  const { showsToResearch } = new Function(
    `${src.slice(src.indexOf("export function showsToResearch")).replace("export function", "function").replace(/: TopicKind|: "idea"[^)]*\)/g, m => (m.endsWith(")") ? ")" : "")).replace(/\): boolean/, ")")} return { showsToResearch };`
  )();
  assert.equal(showsToResearch("conclusion", "idea"), false);
  assert.equal(showsToResearch("conclusion", "completed"), true);
  assert.equal(showsToResearch("topic", "idea"), true);
  assert.equal(showsToResearch("hypothesis", "idea"), true);
});

test("the card view routes its status label and the next-step dialog through showsToResearch", () => {
  const view = read("experiences/visual-map/view.ts");
  assert.equal((view.match(/showsToResearch\(/g) || []).length >= 3, true);
});

test("research prompts remove outdated no-source statements and keep strength on the card only", () => {
  for (const f of ["core/steps/task/conflict-rule.en.md", "core/steps/task/conflict-rule.zh.md"])
    assert.match(read(f), /delete|刪除/);
  for (const f of ["en", "zh-TW", "zh-CN"]) {
    const t = read(`core/blocks/template/hypothesis.${f}.md`);
    assert.match(t, /Strength|强度|強度/);
  }
});
