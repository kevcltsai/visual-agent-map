// Built-in note-style blocks (P1): the registry bodies equal the text the prompt carries today. Unit level.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadSource } = require('./support-replay.cjs');

const M = loadSource(`
export { BUILTIN_BLOCKS, lookupBuiltinBlock } from "./core/blocks/builtin";
export { OBSIDIAN_FORMAT, inLanguage } from "./core/steps/_shared/fragments";
export { builtinPresets } from "./ai/prompt-presets";
export { translate } from "./i18n";
`);
const LANGUAGES = ['zh-TW', 'zh-CN', 'en'];

test('standard Obsidian format block equals the format fragment in all three languages', () => {
  for (const language of LANGUAGES) {
    assert.equal(M.lookupBuiltinBlock('format', 'standard-obsidian', language), M.inLanguage(M.OBSIDIAN_FORMAT, language));
  }
});

test('academic rigor tone block is empty; the other tones equal the built-in tone presets', () => {
  for (const language of LANGUAGES) {
    assert.equal(M.lookupBuiltinBlock('tone', 'academic', language), '');
    for (const id of ['plain', 'magazine', 'summary', 'guide', 'auto']) {
      const preset = M.builtinPresets(language, 'tone').find(item => item.id === id);
      assert.ok(preset.text.length > 0);
      assert.equal(M.lookupBuiltinBlock('tone', id, language), preset.text);
    }
  }
});

test('plain text format has no callout, mermaid, task list or highlight syntax and keeps the shared rules', () => {
  for (const language of LANGUAGES) {
    const body = M.lookupBuiltinBlock('format', 'plain-text', language);
    for (const banned of ['[!', 'mermaid', '- [ ]', '==']) assert.equal(body.includes(banned), false, `${language}: ${banned}`);
    assert.ok(body.includes('####'));
    assert.ok(body.endsWith('\\]`。') || body.endsWith('\\]`.'));
  }
});

test('plain text rules are verbatim lines of the standard format rules', () => {
  for (const language of LANGUAGES) {
    const standard = M.lookupBuiltinBlock('format', 'standard-obsidian', language);
    const rules = M.lookupBuiltinBlock('format', 'plain-text', language).split('\n').filter(line => /^\d\. /.test(line));
    assert.equal(rules.length, 5);
    for (const rule of rules) assert.ok(standard.includes(rule.replace(/^\d\. /, '')), rule);
  }
});

test('template blocks are registered with names; every block has a name in all languages', () => {
  const templates = M.BUILTIN_BLOCKS.filter(block => block.category === 'template').map(block => block.id);
  assert.equal(templates.join(), 'standard,textbook');
  for (const block of M.BUILTIN_BLOCKS) {
    for (const language of LANGUAGES) assert.ok(M.translate(language, block.nameKey).length > 0, `${block.id} ${language}`);
  }
});

test('an unknown block id or category throws instead of returning an empty body', () => {
  assert.throws(() => M.lookupBuiltinBlock('format', 'nope', 'en'), /Unknown built-in block/);
  assert.throws(() => M.lookupBuiltinBlock('tone', 'standard-obsidian', 'en'), /Unknown built-in block/);
});
