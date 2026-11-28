import assert from "node:assert/strict";
import { test } from "node:test";
import { PERF_CARD_COUNT, perfFixtureCards, perfFixtureFiles, percentile, summarize } from "../scripts/perf-baseline.mjs";

test("perf fixture is one tree of 30-50 synthetic cards with unique ids and no overlapping positions", () => {
  const cards = perfFixtureCards();
  assert.equal(cards.length, PERF_CARD_COUNT);
  assert.ok(cards.length >= 30 && cards.length <= 50);
  const ids = new Set(cards.map(card => card.id));
  assert.equal(ids.size, cards.length);
  assert.equal(cards.filter(card => card.parent === null).length, 1);
  assert.ok(cards.every(card => card.parent === null || ids.has(card.parent)));
  assert.equal(new Set(cards.map(card => `${card.x},${card.y}`)).size, cards.length);
});

test("perf fixture files are one map plus one note per card under the topic folder", () => {
  const { mapPath, files } = perfFixtureFiles("Perf Fixture T");
  assert.equal(mapPath, "Agent Workspace/Topics/Perf Fixture T/Map.md");
  assert.equal(files.length, PERF_CARD_COUNT + 1);
  const json = JSON.parse(files[0].text.split("```agent-map\n")[1].split("\n```")[0]);
  assert.equal(json.nodes.length, PERF_CARD_COUNT);
  assert.ok(files.slice(1).every(file => file.text.includes("agent-map-node: true") && file.text.includes("## Current Summary")));
});

test("perf fixture --ai marks every card an AI card; the default fixture has none", () => {
  const plain = perfFixtureFiles("Perf Fixture T").files.slice(1);
  assert.ok(plain.every(file => !file.text.includes("ai-card:")));
  const ai = perfFixtureFiles("Perf Fixture T", "Agent Workspace", PERF_CARD_COUNT, { ai: true }).files.slice(1);
  assert.equal(ai.length, PERF_CARD_COUNT);
  assert.ok(ai.every(file => /^---\n[\s\S]*\nai-card: true\n---\n/.test(file.text) && file.text.includes("## Prompt")));
});

test("percentile is nearest-rank and summarize rounds to 0.1 ms", () => {
  const values = Array.from({ length: 20 }, (_, i) => i + 1);
  assert.equal(percentile(values, 0.5), 10);
  assert.equal(percentile(values, 0.95), 19);
  assert.equal(percentile([], 0.5), null);
  assert.deepEqual(summarize([1.04, 2.06, 3]), { n: 3, p50: 2.1, p95: 3, max: 3 });
});
