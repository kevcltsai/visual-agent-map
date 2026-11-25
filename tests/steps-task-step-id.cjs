const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, obsidian } = require('./support.cjs');
const { taskStepId } = load('core/steps/task/step.ts', { obsidian });

test('task step identity needs only the explicit reference role', () => {
  assert.equal(taskStepId(), 'task.run');
  assert.equal(taskStepId('reference-extract'), 'task.reference-extract');
  assert.equal(taskStepId('reference-reduce'), 'task.reference-reduce');
});
