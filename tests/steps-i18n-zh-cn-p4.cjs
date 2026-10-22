// P4 runtime fixes for Simplified Chinese (B1-B3, B5, B6): fixed headings stay in the note language, display strings follow
// the interface language, command and status labels come from the dictionaries.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { load, root, obsidian, DEFAULT_SETTINGS } = require('./support.cjs');
const { loadSource } = require('./support-replay.cjs');

const i18n = load('i18n.ts');
const templates = load('ai/detail-templates.ts');
const fragments = load('core/steps/_shared/fragments.ts');
const taskFragments = load('core/steps/task/fragments.ts');

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

test('B2: the Coffee observer format adds the verbatim-heading clause only for zh-CN', () => {
  const shared = loadSource("export * as ui from './i18n'; export * as prompts from './experiences/coffee-tables/prompt-parts'; export * as language from './experiences/coffee-tables/language';", { obsidian });
  const { prompts, language, ui } = shared;
  const i18n = ui;
  i18n.setUiLanguage('zh-CN');
  try {
    assert.match(prompts.observerTitles('zh-TW'), /^# 觀察者整理\n## 意外連結[\s\S]*\n固定標題必須逐字照上列寫出（繁體中文，不要轉成简体中文）/);
    assert.equal(language.coffeeContentLocale('zh-TW'), 'zh-CN');
    i18n.setUiLanguage('zh-TW');
    assert.equal(prompts.observerTitles('zh-TW'), prompts.OBSERVER_TITLES.zh);
    i18n.setUiLanguage('en');
    assert.equal(prompts.observerTitles('en'), prompts.OBSERVER_TITLES.en);
  } finally { i18n.setUiLanguage('en'); }
});

test('B1 and B5: the selection-AI and Coffee Tables commands and ribbon refresh with the language', () => {
  const { default: Plugin } = load('main.ts', { obsidian });
  const plugin = new Plugin(), attributes = {}, coffeeAttributes = {};
  const selection = { name: '' }, coffee = { name: '' };
  plugin.ribbonIcon = { setAttribute: (key, value) => { attributes[key] = value; } };
  plugin.coffeeRibbonIcon = { setAttribute: (key, value) => { coffeeAttributes[key] = value; } };
  plugin.localizedCommands = [{ command: selection, key: 'ui.context_ai_open' }, { command: coffee, key: 'ui.open_coffee_tables' }];
  plugin.settings = { ...DEFAULT_SETTINGS, language: 'zh-CN' };
  plugin.refreshLocalizedEntrypoints();
  assert.equal(selection.name, 'Visual Agent Map (VAM): ' + i18n.translate('zh-CN', 'ui.context_ai_open'));
  assert.equal(coffee.name, 'Visual Agent Map (VAM): 打开 Coffee Tables');
  assert.equal(coffeeAttributes['aria-label'], '打开 Coffee Tables');
  plugin.settings.language = 'en'; plugin.refreshLocalizedEntrypoints();
  assert.equal(coffeeAttributes['aria-label'], 'Open Coffee Tables');
  const source = fs.readFileSync(path.join(root, 'main.ts'), 'utf8');
  assert.ok(/id: "markdown-selection-ai"[\s\S]{0,200}key: "ui\.context_ai_open"/.test(source), 'the selection command is registered as localized');
  assert.ok(!/Open \$\{COFFEE_TABLES_NAME\}/.test(source));
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
  for (const file of ['ui/settings-tab.ts', 'experiences/coffee-tables/view.ts', 'experiences/coffee-tables/handoff-modal.ts'])
    assert.ok(!/CLI candidates/.test(fs.readFileSync(path.join(root, file), 'utf8')), `${file}: no inline status text`);
});

test('B3: Coffee roster placeholders follow the interface language while real guests keep their stored role', () => {
  const { rosterFor, ui: i18n } = loadSource("export * as ui from './i18n'; export { rosterFor } from './experiences/coffee-tables/view';", { obsidian });
  const session = { id: 's', language: 'zh-TW', guests: { hostCount: 1, counts: { experts: 1, 'cross-domain': 0, generalist: 0, affected: 0 }, guests: [], background: '', customPrompt: '' } };
  i18n.setUiLanguage('zh-CN');
  try {
    const roster = rosterFor(session, '- **林岑｜主持人**：擅長追問。');
    const placeholder = roster.find(person => person.role !== '主持人' && person.bio !== '擅長追問。');
    assert.equal(placeholder.role, '即将登场');
    assert.ok(placeholder.name.includes('主题专家') || placeholder.name.includes('观察'), placeholder.name);
    assert.equal(roster[0].role, '主持人');
    i18n.setUiLanguage('zh-TW');
    assert.equal(rosterFor(session, '').find(person => person.role === '即將登場').role, '即將登場');
  } finally { i18n.setUiLanguage('en'); }
});

test('B3b: Simplified, Traditional and English roles of real guests count toward the roster (no duplicate placeholders)', () => {
  const { rosterFor, ui: i18n } = loadSource("export * as ui from './i18n'; export { rosterFor } from './experiences/coffee-tables/view';", { obsidian });
  const session = language => ({ id: 's', language, guests: { hostCount: 1, counts: { experts: 1, 'cross-domain': 1, generalist: 1, affected: 1 }, guests: [], background: '', customPrompt: '' } });
  const placeholders = (roster, joining) => roster.filter(person => person.role === joining);
  try {
    i18n.setUiLanguage('zh-CN');
    const cn = ['主持人', '中立观察者', '主题专家', '跨领域专家', '好奇的通才', '受影响者'].map((role, index) => `- **林${index}｜${role}**：简介${index}。`).join('\n');
    const roster = rosterFor(session('zh-CN'), cn);
    assert.equal(roster.length, 6);
    assert.equal(placeholders(roster, '即将登场').length, 0);
    assert.equal(rosterFor(session('zh-CN'), '').length, 6);
    i18n.setUiLanguage('zh-TW');
    const tw = ['主持人', '觀察者', '主題專家', '跨領域專家', '好奇的通才', '受影響者'].map((role, index) => `- **林${index}｜${role}**：簡介${index}。`).join('\n');
    assert.equal(placeholders(rosterFor(session('zh-TW'), tw), '即將登場').length, 0);
    i18n.setUiLanguage('en');
    const en = ['Host', 'Observer', 'Topic expert', 'Cross-domain expert', 'Curious generalist', 'Affected perspective'].map((role, index) => `- **Lin ${index}｜${role}**: Bio ${index}.`).join('\n');
    assert.equal(placeholders(rosterFor(session('en'), en), 'Joining').length, 0);
  } finally { i18n.setUiLanguage('en'); }
});

test('B6: the built-in template name used for "keep current" is the interface-language name', () => {
  const source = fs.readFileSync(path.join(root, 'experiences/visual-map/view.ts'), 'utf8');
  assert.match(source, /builtinTemplates\(noteLanguageOf\(language\), language\)\.find/);
  assert.match(source, /currentTemplate: templateInLanguage\(/);
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
  assert.equal(normalize('### 核心结论\n\nx', 'zh-CN'), '### 核心結論\n\nx');
});

test('N1: zh-CN textbook Simplified heading is mapped too', () => {
  const out = normalize('导言\n\n### 关键知识\n\n内容', 'zh-CN', textbookZh);
  assert.equal(out, '导言\n\n### 關鍵知識\n\n内容');
  assert.ok(resultUtils.canonicalDetail(out, 'zh-TW', textbookZh).includes('### 關鍵知識\n\n内容'));
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
