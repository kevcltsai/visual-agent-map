// Batch 2 N1: a card still carrying its default placeholder name ("New topic 5") says nothing about the user's language,
// so the output language comes from the interface (before: "New topic 5" read as unrecognised Latin letters -> follow-the-input -> Spanish).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./support.cjs');

const content = load('core/content-language.ts');
const names = load('core/default-names.ts');

test('N1 placeholder topic names: three languages, optional number, nothing else', () => {
  for (const title of ['New topic', 'New topic 5', '新議題', '新議題 12', '新议题 3']) assert.equal(names.isPlaceholderTopicTitle(title), true, title);
  for (const title of ['New topic idea', 'New topics 5', '新議題X', 'Ancient Egypt', '']) assert.equal(names.isPlaceholderTopicTitle(title), false, title);
});

test('N1 the output language of a placeholder-titled card is the interface language', () => {
  for (const ui of ['en', 'zh-TW', 'zh-CN']) {
    for (const title of ['New topic 5', '新議題 5', '新议题 5']) {
      assert.equal(content.outputLanguageForMap(undefined, ui, title), ui, `${ui} ${title}`);
      assert.equal(content.defaultOutputLanguage(ui, title), ui, `${ui} ${title}`);
    }
  }
});

test('N1 a real title still decides the language (unchanged), and a placeholder falls through to the next source', () => {
  assert.equal(content.outputLanguageForMap(undefined, 'en', 'Ancient Egypt'), 'same-as-input');
  assert.equal(content.outputLanguageForMap(undefined, 'en', '台灣旅行'), 'zh-TW');
  assert.equal(content.outputLanguageForMap(undefined, 'en', 'New topic 5', '한국 여행'), 'ko');
});

test('N1 the language instruction for an English interface and "New topic 5" names English, not a follow-the-title clause', () => {
  const i18n = load('i18n.ts');
  const language = content.outputLanguageForMap(undefined, 'en', 'New topic 5');
  assert.equal(i18n.languagePromptName(language, 'en', 'plain', { kind: 'topic', text: 'New topic 5' }), 'English');
});
