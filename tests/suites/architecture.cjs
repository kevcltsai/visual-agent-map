const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, root, load, plain } = require('../support.cjs');
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
test('thinking artifacts route through shared core without view coupling', async () => {
  const artifacts = load('core/thinking-artifact.ts');
  const { ExperienceRouter } = load('core/experience-router.ts');
  const artifact = artifacts.createThinkingArtifact({
    id: 'artifact-1',
    kind: 'insight',
    title: 'A useful insight',
    content: 'The discussion exposed a tradeoff.',
    origin: { experience: 'coffee-tables', sessionId: 'table-1' },
    sources: [{ label: 'Coffee Table', experience: 'coffee-tables', sessionId: 'table-1' }]
  });
  assert.equal(artifact.version, 1);
  const router = new ExperienceRouter();
  let received;
  const unregister = router.register('visual-map', async value => { received = value; });
  assert.equal(router.canHandoff('visual-map'), true);
  await router.handoff({ target: 'visual-map', artifact });
  assert.deepEqual(plain(received), plain(artifact));
  unregister();
  assert.equal(router.canHandoff('visual-map'), false);
  await assert.rejects(() => router.handoff({ target: 'visual-map', artifact }), /not available/);
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
