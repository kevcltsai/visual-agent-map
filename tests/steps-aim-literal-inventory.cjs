// G2: replaces the 40-character / 5-word blind spot of tests/steps-architecture.cjs for AIM. Every string or template
// literal in experiences/aim/**/*.ts that contains a capitalized Latin word (3+ letters) must be classified in
// tests/literal-inventory/aim.json, so a new short English literal cannot reach a note unnoticed. Existing literal-scan
// checks stay in place and are not loosened.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { literalsOf, markdownFiles, root } = require('./support-aim-literal-scan.cjs');
const inventory = JSON.parse(fs.readFileSync(path.join(__dirname, 'literal-inventory', 'aim.json'), 'utf8'));
const CLASSES = new Set(['content', 'ui', 'machine-marker', 'attempt-record', 'prompt-only']);

test('AIM literal inventory entries are well formed and point at existing files', () => {
  for (const entry of inventory.literals) {
    assert.ok(CLASSES.has(entry.class), `${entry.file} ${entry.text}: unknown class ${entry.class}`);
    assert.ok(typeof entry.text === 'string' && entry.text && typeof entry.reason === 'string' && entry.reason.trim().length >= 20, `needs text and a reason: ${JSON.stringify(entry)}`);
    assert.ok(fs.existsSync(path.join(root, entry.file)), `${entry.file} does not exist`);
  }
  for (const entry of inventory.markdown.overrides) {
    assert.ok(CLASSES.has(entry.class) && entry.reason.trim().length >= 20 && fs.existsSync(path.join(root, entry.file)), JSON.stringify(entry));
  }
});

test('every AIM literal with a capitalized Latin word is classified (content, ui, machine-marker, attempt-record or prompt-only)', () => {
  const unclassified = [], used = new Set();
  for (const literal of literalsOf('experiences/aim')) {
    const index = inventory.literals.findIndex(entry => entry.file === literal.file && literal.text.startsWith(entry.text));
    if (index < 0) unclassified.push(`${literal.file}:${literal.line} ${JSON.stringify(literal.text.slice(0, 80))}`); else used.add(index);
  }
  assert.deepEqual(unclassified, [], 'classify new literals in tests/literal-inventory/aim.json (text that lands in a note must use an i18n key and the AIM content language)');
  assert.deepEqual(inventory.literals.filter((_entry, index) => !used.has(index)).map(entry => `${entry.file} ${entry.text}`), [], 'inventory entries that match nothing must be removed');
  // A literal classified as content would be written into notes without i18n; none may remain.
  assert.deepEqual(inventory.literals.filter(entry => entry.class === 'content').map(entry => entry.text), [], 'literals that land in notes must be i18n keys, not literals');
});

test('every AIM step markdown file is either prompt-only or explicitly classified as data', () => {
  const files = markdownFiles('experiences/aim');
  const overrides = new Map(inventory.markdown.overrides.map(entry => [entry.file, entry]));
  for (const file of overrides.keys()) assert.ok(files.includes(file), `${file} no longer exists`);
  for (const file of files) assert.ok(file.startsWith('experiences/aim/steps/') || overrides.has(file), `${file} is a markdown file outside experiences/aim/steps and must be classified`);
  // The language twin of every data template must exist.
  for (const file of overrides.keys()) if (!file.endsWith('.zh.md')) assert.ok(overrides.has(file.replace(/\.md$/, '.zh.md')), `${file} needs a .zh.md twin`);
});
