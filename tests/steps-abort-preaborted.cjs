const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./support.cjs');
const { untilAborted } = load('core/abort.ts');

test('a pre-aborted call observes an already-started rejection', async () => {
  const controller = new AbortController();
  controller.abort();
  const work = Promise.reject(new Error('late provider failure'));
  await assert.rejects(untilAborted(controller.signal, work), /aborted/);
  // An unobserved provider rejection fails this node:test case.
  await new Promise(resolve => setImmediate(resolve));
});

test('a pre-aborted call observes a future failure without waiting for it', async () => {
  const controller = new AbortController();
  controller.abort();
  let reject;
  const work = new Promise((_resolve, fail) => { reject = fail; });
  await assert.rejects(untilAborted(controller.signal, work), /aborted/);
  reject(new Error('late provider failure'));
  await new Promise(resolve => setImmediate(resolve));
});
