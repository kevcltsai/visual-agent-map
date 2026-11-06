// Plugin wiring for the goal recommend run. The old suggestion service and its step are gone (goal-recommend P4); the
// strict parser, budget refusal, stop handling and prompt contract live in tests/steps-goal-recommend.cjs.
const { test, load, obsidian } = require('../support.cjs');
const assert = require('node:assert/strict');

test('goal-topic-suggest: the plugin no longer wires the old suggestion service; the one recommend service replaced it (goal-recommend P3)', () => {
  const { default: Plugin } = load('main.ts', { obsidian });
  const plugin = new Plugin();
  assert.equal(plugin.goalTopicSuggest, undefined);
  assert.equal(plugin.goalRecommend.constructor.name, 'GoalRecommendService');
});
