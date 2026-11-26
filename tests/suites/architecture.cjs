const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, root, load } = require('../support.cjs');
const { repoFiles } = require('../support-repo-scan.cjs');
test('product architecture keeps shell, core, and experiences separated', () => {
  const shell = fs.readFileSync(path.join(root, 'main.ts'), 'utf8');
  assert.doesNotMatch(shell, /class VisualAgentMapView/);
  assert.doesNotMatch(shell, /class AiTaskService/);

  // Existing shared feature imports predate this recursive guard. Pin the exact paths.
  const existing = new Map([
    ['core/steps/map-chat/step.ts', '../../../experiences/visual-map/canvas-items'],
    ['core/steps/outline-generate/step.ts', '../../../experiences/visual-map/outline-import'],
    ['core/steps/goal-recommend/step.ts', '../../../experiences/visual-map/relevance-pins']
  ]);
  const coreFiles = repoFiles(root, { from: 'core' }).filter(name => name.endsWith('.ts'));
  for (const name of coreFiles) {
    let source = fs.readFileSync(path.join(root, name), 'utf8');
    const exception = existing.get(name);
    if (exception) {
      assert.equal(source.split(exception).length, 2, `${name}: remove a retired exception or review a changed one`);
      source = source.replace(exception, '');
    }
    assert.doesNotMatch(source, /(?:\.\.\/)+experiences\//, `${name} must not import an experience`);
    assert.doesNotMatch(source, /from ["'][^"']*repository["']/, `${name} must not depend on repository settings that include experience state`);
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

test('shared evidence tokens retain quantity and link comparison semantics', () => {
  const tokens = load('core/evidence-tokens.ts');
  assert.deepEqual([...tokens.numberTokens('A1 v2 C4 H2O quadrant-1 ７ 1,200.5')], ['7', '1200.5']);
  assert.deepEqual([...tokens.noteNumbers('2.0 [link](target42) https://example.org/99 [^8] <!-- 7 -->\n```mermaid\n99\n```')], ['2.0']);
  assert.equal(tokens.normalNumber('2.0'), '2');
  assert.equal(tokens.normalNumber('1234567890123456'), '1234567890123456');
  assert.deepEqual([...tokens.linksOf(['[[Folder/Note.md#heading|alias]] [file](Doc%20A.pdf) https://EXAMPLE.org/path/']).keys()], ['https://example.org/path', 'wiki:folder/note', 'link:doc a.pdf']);
});

test('evidence extraction has no dependency on chart insertion or task merge', () => {
  const read = name => fs.readFileSync(path.join(root, name), 'utf8');
  assert.doesNotMatch(read('core/evidence-tokens.ts'), /^import\s/m);
  for (const name of ['core/steps/task/carry-sources.ts', 'core/steps/argument-map/shared.ts']) {
    assert.doesNotMatch(read(name), /from ["'][^"']*merge-check["']/);
  }
  for (const name of ['core/steps/task/merge-check.ts', 'core/steps/argument-map/shared.ts', 'core/book-pipeline/figure-spec.ts', 'core/steps/book-pipeline/draw-diagrams.ts']) {
    assert.doesNotMatch(read(name), /from ["'][^"']*chart\/insert["']/);
  }
});

test('map card-note rewrites go through the repository vault, so the write-recovery copy covers them', () => {
  for (const name of ['experiences/visual-map/view.ts']) {
    const source = fs.readFileSync(path.join(root, name), 'utf8');
    assert.doesNotMatch(source, /this\.app\.vault\.(?:process|modify)\(/, `${name}: use this.plugin.repo.app.vault`);
  }
  assert.match(fs.readFileSync(path.join(root, 'main.ts'), 'utf8'), /applyMathRepair\(this\.repo\.app\.vault,/);
});
