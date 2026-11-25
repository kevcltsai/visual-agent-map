const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, root, load } = require('../support.cjs');
test('product architecture keeps shell, core, and experiences separated', () => {
  const shell = fs.readFileSync(path.join(root, 'main.ts'), 'utf8');
  assert.doesNotMatch(shell, /class VisualAgentMapView/);
  assert.doesNotMatch(shell, /class AiTaskService/);

  const coreFiles = fs.readdirSync(path.join(root, 'core')).filter(name => name.endsWith('.ts'));
  for (const name of coreFiles) {
    const source = fs.readFileSync(path.join(root, 'core', name), 'utf8');
    assert.doesNotMatch(source, /(?:\.\.\/)+experiences\//, `core/${name} must not import an experience`);
    assert.doesNotMatch(source, /from ["'][^"']*repository["']/, `core/${name} must not depend on repository settings that include experience state`);
  }

  for (const sharedAi of ['types.ts', 'task-policy.ts', 'visual-guidance.ts', 'model-resolution.ts', 'note-style-store.ts', 'note-style-label.ts', 'note-style-references.ts', 'markdown-intake.ts']) {
    const source = fs.readFileSync(path.join(root, 'ai', sharedAi), 'utf8');
    assert.doesNotMatch(source, /from ["'][^"']*repository["']/, `ai/${sharedAi} must stay experience-independent`);
    assert.doesNotMatch(source, /experiences\//, `ai/${sharedAi} must not import an experience`);
  }
});

test('shared error message preserves the raw message across realms and stringifies other thrown values', () => {
  const { errorMessage } = load('core/error-message.ts');
  assert.equal(errorMessage(new Error('failed')), 'failed');
  assert.equal(errorMessage({ message: 'cross-realm' }), 'cross-realm');
  assert.equal(errorMessage({ message: '' }), '');
  assert.equal(errorMessage('raw failure'), 'raw failure');
  assert.equal(errorMessage(42), '42');
  assert.equal(errorMessage(null), 'null');
  assert.equal(errorMessage(undefined), 'undefined');
  assert.equal(errorMessage({ message: 42 }), '[object Object]');
});

test('escapeRegExp treats every metacharacter as literal text', () => {
  const { escapeRegExp } = load('core/escape-regexp.ts');
  for (const input of ['a.b', 'a+b?', '[x](y){z}', '^x$|y', 'a\\\\b', '資料/檔案.md', '']) {
    const pattern = new RegExp('^' + escapeRegExp(input) + '$');
    assert.ok(pattern.test(input), input);
    assert.ok(!pattern.test(input + 'x'), input);
  }
});

test('shared record guard preserves the non-null, non-array object check', () => {
  const { isRecord } = load('core/is-record.ts');
  for (const value of [{}, { a: 1 }, Object.create(null), new Date()]) assert.equal(isRecord(value), true);
  for (const value of [null, undefined, [], [1], '', 'text', 0, 1, false, true, () => {}]) assert.equal(isRecord(value), false);
});
