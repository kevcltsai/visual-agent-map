// Simplified Chinese (zh-CN) contracts that sit between the interface language and what is written or sent
// (multilingual P3): note-language headings, template names, frontmatter issue text, placeholders, language menus.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { load, root, obsidian, plain } = require('./support.cjs');

const i18n = load('i18n.ts');
const templates = load('ai/detail-templates.ts');
const names = template => template.sections.map(section => section.name);

test('built-in templates: the display name follows the interface language, the headings follow the note language', () => {
  const noteLanguage = i18n.noteLanguageOf('zh-CN');
  assert.equal(noteLanguage, 'zh-TW');
  const [standard, textbook] = templates.builtinTemplates(noteLanguage, 'zh-CN');
  assert.equal(standard.name, '标准');
  assert.equal(textbook.name, '教科书');
  const traditional = templates.builtinTemplates('zh-TW');
  assert.deepEqual(plain(names(standard)), plain(names(traditional[0])), 'zh-CN headings are exactly the zh-TW headings');
  assert.deepEqual(plain(standard.sections.map(section => section.description)), plain(traditional[0].sections.map(section => section.description)));
  assert.ok(names(standard).every(name => !/[结关证与]/.test(name)), 'no Simplified headings');
  assert.equal(templates.standardTemplate('en', 'zh-CN').name, '标准', 'an English-note template can still be named in the interface language');
  assert.equal(templates.standardTemplate('zh-TW').name, '標準', 'the display language defaults to the note language');
  assert.equal(templates.builtinTemplates('en')[1].name, 'Textbook');
});

test('built-in template names of every registered interface language are reserved', () => {
  const taken = i18n.LANGUAGES.flatMap(({ id }) => templates.builtinTemplates(i18n.noteLanguageOf(id), id).map(template => template.name));
  for (const expected of ['Standard', 'Textbook', '標準', '教科書', '标准', '教科书']) assert.ok(taken.includes(expected), expected);
  const source = fs.readFileSync(path.join(root, 'ui/modals/detail-templates-modal.ts'), 'utf8');
  assert.match(source, /LANGUAGES\.flatMap\(/, 'the reserved-name check walks the registry, not a fixed language list');
  assert.doesNotMatch(source, /NOTE_LANGUAGES/);
});

test('frontmatter format issues are written in the note language, never the interface language', () => {
  const { formatIssuesPatch } = load('experiences/visual-map/view.ts', { obsidian });
  const issues = [{ section: '核心結論', mode: 'exact', n: 3, actual: 1 }, { section: 'Sources', mode: 'min', n: 2, actual: 0 }];
  const zhTW = plain(formatIssuesPatch(issues, 'zh-TW'));
  assert.deepEqual(plain(formatIssuesPatch(issues, 'zh-CN')), zhTW, 'zh-CN writes the zh-TW text');
  assert.doesNotMatch(zhTW.detailFormatIssues.join('\n'), /[条项个]/);
  assert.notDeepEqual(plain(formatIssuesPatch(issues, 'en')), zhTW);
  assert.deepEqual(plain(formatIssuesPatch(undefined, 'zh-CN')), { detailFormatIssues: [] });
});

test('the outline topic placeholder follows the instruction language, so zh-CN matches the zh preset text', () => {
  const presets = load('ai/prompt-presets.ts');
  const { OUTLINE_TOPIC_PLACEHOLDERS } = load('core/steps/outline-generate/step.ts', { obsidian });
  assert.equal(presets.OUTLINE_TOPIC_PLACEHOLDER['zh-CN'], presets.OUTLINE_TOPIC_PLACEHOLDER['zh-TW']);
  for (const { id } of i18n.LANGUAGES) assert.ok(OUTLINE_TOPIC_PLACEHOLDERS.includes(presets.OUTLINE_TOPIC_PLACEHOLDER[id]), `${id}: a placeholder the outline generator recognises`);
  const [outline] = presets.builtinPresets('zh-CN', 'outline');
  assert.ok(outline.text.includes(presets.OUTLINE_TOPIC_PLACEHOLDER['zh-CN']), 'the built-in zh-CN outline preset contains its placeholder');
  assert.equal(outline.text, presets.builtinPresets('zh-TW', 'outline')[0].text, 'the preset text is the zh one');
});

test('every language menu lists 简体中文 from the registry', () => {
  assert.ok(plain(i18n.SUPPORTED_LANGUAGES).some(item => item.id === 'zh-CN' && item.label === '简体中文' && item.name === 'Simplified Chinese'));
  assert.deepEqual(plain(i18n.SUPPORTED_LANGUAGES.map(item => item.id)), plain(i18n.LANGUAGES.map(item => item.id)));
  assert.equal(i18n.supportedLanguageLabel('zh-CN'), '简体中文');
  // The settings dropdown, the output-language menu and the image-translation menu all iterate the registry list.
  for (const file of ['ui/settings-tab.ts', 'experiences/visual-map/modals.ts', 'experiences/markdown-context/image-translate-action.ts'])
    assert.match(fs.readFileSync(path.join(root, file), 'utf8'), /of SUPPORTED_LANGUAGES\b/, file);
});
