// Simplified Chinese (zh-CN) contracts that sit between the interface language and what is written or sent
// (multilingual P3): note-language headings, template names, frontmatter issue text, placeholders, language menus.
// Also the zh-CN runtime fixes (multilingual P4): fixed headings stay in the note language, display strings follow the
// interface language, command and status labels come from the dictionaries, Simplified headings are normalized.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { load, root, obsidian, plain, DEFAULT_SETTINGS } = require('./support.cjs');
const { loadSource } = require('./support-replay.cjs');

const i18n = load('i18n.ts');
const templates = load('ai/detail-templates.ts');
const fragments = load('core/steps/_shared/fragments.ts');
const taskFragments = load('core/steps/task/fragments.ts');
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

test('B2: only a language whose note language differs from itself asks for verbatim headings', () => {
  assert.equal(i18n.verbatimHeadingLanguage('zh-CN'), 'zh-TW');
  assert.equal(i18n.verbatimHeadingLanguage('zh-TW'), null);
  assert.equal(i18n.verbatimHeadingLanguage('en'), null);
  assert.equal(fragments.headingsVerbatim('zh-TW'), '');
  assert.equal(fragments.headingsVerbatim('en'), '');
  assert.match(fragments.headingsVerbatim('zh-CN'), /逐字照上列寫出（繁體中文，不要轉成简体中文）/);
});

test('B2b: a custom template under zh-CN gets the verbatim clause without naming a heading language; zh-TW and en add nothing', () => {
  const custom = { ...templates.standardTemplate('zh-TW', 'zh-CN'), id: 'custom-1', name: '自订' };
  const build = (template, language) => templates.detailStructurePrompt(template, language, headings => taskFragments.detailStructure(language, headings));
  const last = build(custom, 'zh-CN').split('\n').pop();
  assert.ok(last.startsWith('固定標題必須逐字照上列寫出，'), last);
  assert.ok(!last.includes('繁體中文'), last);
  assert.equal(build(custom, 'zh-TW').includes('逐字'), false);
  assert.equal(build(custom, 'en').includes('exactly as listed'), false);
  assert.match(fragments.headingsVerbatim('zh-CN', 'en', true), /^Write the headings exactly as listed above/);
});

test('B2: the Detail prompt under zh-CN names the note language for headings and lists them as Traditional text', () => {
  const standard = templates.standardTemplate('zh-TW', 'zh-CN');
  const prompt = templates.detailStructurePrompt(standard, 'zh-CN', headings => taskFragments.detailStructure('zh-CN', headings));
  for (const section of standard.sections) assert.ok(prompt.includes(`### ${section.name}`));
  assert.ok(prompt.split('\n').pop().startsWith('固定標題必須逐字照上列寫出'));
  const language = taskFragments.outputLanguage('zh-CN');
  assert.ok(language.includes('六個標準 Detail 標題固定使用筆記語言（繁體中文）'));
  assert.ok(!language.includes('跟隨介面語言'));
  // zh-TW and en keep the original sentence and gain no clause.
  assert.ok(taskFragments.outputLanguage('zh-TW').includes('六個標準 Detail 標題固定跟隨介面語言。'));
  assert.ok(taskFragments.outputLanguage('en').includes('The six standard Detail headings must follow the interface language.'));
  const tw = templates.detailStructurePrompt(templates.standardTemplate('zh-TW'), 'zh-TW', headings => taskFragments.detailStructure('zh-TW', headings));
  assert.ok(!tw.includes('逐字照上列'));
});

test('B1: the selection-AI command and the map ribbon refresh with the language', () => {
  const { default: Plugin } = load('main.ts', { obsidian });
  const plugin = new Plugin(), attributes = {};
  const selection = { name: '' };
  plugin.ribbonIcon = { setAttribute: (key, value) => { attributes[key] = value; } };
  plugin.manifest = { name: 'Visual Agent Map' };
  plugin.localizedCommands = [{ command: selection, key: 'ui.command_selection_ai' }];
  plugin.settings = { ...DEFAULT_SETTINGS, language: 'zh-CN' };
  plugin.refreshLocalizedEntrypoints();
  assert.equal(selection.name, 'Visual Agent Map: ' + i18n.translate('zh-CN', 'ui.command_selection_ai'));
  const source = fs.readFileSync(path.join(root, 'main.ts'), 'utf8');
  assert.ok(/id: "markdown-selection-ai"[\s\S]{0,200}key: "ui\.command_selection_ai"/.test(source), 'the selection command is registered as localized');
});

test('B5: the model discovery summary reads the dictionaries, including the error text', () => {
  const { modelDiscoverySummary, ui: i18n } = loadSource("export * as ui from './i18n'; export { modelDiscoverySummary } from './core/model-discovery';", { obsidian });
  const codex = { provider: 'codex', status: 'ready', models: [] }, claude = { provider: 'claude', status: 'missing', models: [] };
  i18n.setUiLanguage('en');
  assert.equal(modelDiscoverySummary(codex, claude), 'Codex: ready · Claude CLI candidates: not found');
  i18n.setUiLanguage('zh-CN');
  try {
    assert.equal(modelDiscoverySummary({ ...codex, status: 'error', error: 'boom' }, claude), 'Codex：错误 · boom · Claude CLI 候选模型：找不到');
  } finally { i18n.setUiLanguage('en'); }
  for (const file of ['ui/settings-tab.ts'])
    assert.ok(!/CLI candidates/.test(fs.readFileSync(path.join(root, file), 'utf8')), `${file}: no inline status text`);
});

// The dialogs read the name from runStyle's label; steps-run-style.cjs slice 9 checks it in the interface language.
test('B6: the built-in template name used for "keep current" is the interface-language name', () => {
  assert.equal(templates.builtinTemplates('zh-TW', 'zh-CN')[0].name, '标准');
});

// N1: the model sometimes writes a Simplified built-in heading under zh-CN; it is mapped to the verbatim note heading.
const resultUtils = load('ai/result-utils.ts');
const normalize = (detail, output, template) => resultUtils.normalizeOutputScriptHeadings(detail, output, template);
const standardZh = templates.standardTemplate('zh-TW', 'zh-CN');
const textbookZh = templates.textbookTemplate('zh-TW', 'zh-CN');

test('N1: zh-CN standard Simplified heading becomes the canonical heading and keeps its content', () => {
  const out = normalize('### 核心結論\n\n### 核心结论\n\n真正的内容', 'zh-CN', standardZh);
  assert.equal(out, '### 核心結論\n\n### 核心結論\n\n真正的内容');
  const canonical = resultUtils.canonicalDetail(out, 'zh-TW', standardZh);
  assert.equal(canonical.match(/### 核心結論/g).length, 1);
  assert.ok(canonical.includes('真正的内容'));
  assert.ok(!canonical.includes('核心结论'));
  assert.equal(normalize('### 证据与来源\n\n- a', 'zh-CN', standardZh), '### 證據與來源\n\n- a');
  assert.equal(resultUtils.normalizeOutputScriptHeadings('### 核心结论\n\nx', 'zh-CN', undefined, { detailFormat: undefined, promptProfile: undefined }), '### 核心結論\n\nx');
});

test('N1: zh-CN textbook Simplified heading is mapped too', () => {
  const out = normalize('导言\n\n### 关键知识\n\n内容', 'zh-CN', textbookZh);
  assert.equal(out, '导言\n\n### 關鍵知識\n\n内容');
  assert.ok(resultUtils.canonicalDetail(out, 'zh-TW', textbookZh).includes('### 背景與機制\n\n内容'), 'the 0.29.0 heading is rewritten to the new name');
});

test('N1: mixed Traditional and Simplified duplicates merge into one section without losing text', () => {
  const out = normalize('### 核心結論\n\n繁體段落\n\n### 核心结论\n\n简体段落', 'zh-CN', standardZh);
  const canonical = resultUtils.canonicalDetail(out, 'zh-TW', standardZh);
  assert.equal(canonical.match(/### 核心結論/g).length, 1);
  assert.ok(canonical.indexOf('繁體段落') >= 0 && canonical.indexOf('简体段落') > canonical.indexOf('繁體段落'));
});

test('N1 counterexamples: zh-TW, en, custom template, body text, wrong level, near match, code and tilde stay untouched', () => {
  const simplified = '### 核心结论\n\n内容';
  assert.equal(normalize(simplified, 'zh-TW', standardZh), simplified);
  assert.equal(normalize(simplified, 'en', standardZh), simplified);
  const custom = { ...standardZh, id: 'custom-1', name: '自订' };
  assert.equal(normalize(simplified, 'zh-CN', custom), simplified);
  const body = '### 核心結論\n\n核心结论是这样。\n\n- 核心结论';
  assert.equal(normalize(body, 'zh-CN', standardZh), body);
  for (const text of ['#### 核心结论\n\nx', '## 核心结论\n\nx', '### 核心结论总览\n\nx', '### 新的核心结论\n\nx', '```\n### 核心结论\n```'])
    assert.equal(normalize(text, 'zh-CN', standardZh), text);
});

test('N1 counterexamples: adaptive format under zh-CN is not rewritten', () => {
  const simplified = '### 核心结论\n\n内容';
  const run = context => resultUtils.normalizeOutputScriptHeadings(simplified, 'zh-CN', undefined, context);
  assert.equal(run({ detailFormat: 'adaptive' }), simplified);
  assert.equal(run({}), '### 核心結論\n\n内容');
});
