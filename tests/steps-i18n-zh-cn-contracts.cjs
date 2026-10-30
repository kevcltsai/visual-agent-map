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
  assert.equal(resultUtils.normalizeOutputScriptHeadings('### 核心结论\n\nx', 'zh-CN', undefined, { detailFormat: undefined, promptProfile: undefined }), '### 核心結論\n\nx');
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

// N1b (D-2026-10-69): Simplified observer headings are mapped instead of dropped.
const coffeeInsights = load('experiences/coffee-tables/insights.ts');
const coffeeEngine = load('experiences/coffee-tables/engine.ts');
const SIMPLIFIED_NOTES = ['# 观察者整理', '', '## 意外链接', '- 连结甲。', '', '## 值得继续想的问题', '- 问题乙。', '', '## 核心分歧', '- 分歧丙。', '', '## 探索方向', '- 方向丁。', '', '## 值得查证的假设', '- 假设戊。'].join('\n');

test('N1 counterexamples: adaptive format and AIM profile under zh-CN are not rewritten', () => {
  const simplified = '### 核心结论\n\n内容';
  const run = context => resultUtils.normalizeOutputScriptHeadings(simplified, 'zh-CN', undefined, context);
  assert.equal(run({ detailFormat: 'adaptive' }), simplified);
  assert.equal(run({ promptProfile: 'aim' }), simplified);
  assert.equal(run({ promptProfile: 'aim', detailFormat: 'adaptive' }), simplified);
  assert.equal(run({}), '### 核心結論\n\n内容');
});

test('N1b: Simplified observer headings parse into the right categories and are not dropped', () => {
  const parsed = coffeeInsights.baselineFromVersions([SIMPLIFIED_NOTES], 'zh-TW');
  assert.deepEqual([...parsed.map(item => item.category)], ['connections', 'questions', 'disagreements', 'directions', 'assumptions']);
  assert.deepEqual([...parsed.map(item => item.summary)], ['连结甲。', '问题乙。', '分歧丙。', '方向丁。', '假设戊。']);
  const solutions = coffeeInsights.baselineFromVersions(['# 观察者整理\n\n## 疑问与可能解方\n- 解方己。'], 'zh-TW');
  assert.deepEqual([...solutions.map(item => item.category)], ['solutions']);
});

test('N1b: a Simplified observer reply is split as complete notes (no incomplete-format path)', () => {
  const { dialogue, notes } = coffeeEngine.splitObserverNotes(`### 来宾｜甲\n\n发言。\n\n${SIMPLIFIED_NOTES}`);
  assert.equal(dialogue, '### 来宾｜甲\n\n发言。');
  assert.ok(notes.startsWith('# 觀察者整理'));
  for (const heading of ['## 意外連結', '## 值得繼續想的問題', '## 核心分歧', '## 探索方向', '## 值得查證的假設']) assert.ok(notes.includes(heading), heading);
});

test('N1b counterexamples: Traditional and English unchanged; near matches and body lines are not matched', () => {
  const traditional = '# 觀察者整理\n\n## 意外連結\n- 甲。\n\n## 核心分歧\n- 乙。';
  assert.equal(coffeeEngine.splitObserverNotes(`### 來賓｜甲\n\n話。\n\n${traditional}`).notes, traditional);
  const english = '# Observer’s notes\n\n## Unexpected connections\n- A.';
  assert.equal(coffeeEngine.splitObserverNotes(`### Guest｜A\n\nHi.\n\n${english}`).notes, english);
  assert.deepEqual([...coffeeInsights.baselineFromVersions([traditional], 'zh-TW').map(item => item.category)], ['connections', 'disagreements']);
  // Near match (extra words) and wrong level: not mapped, the section is not recognised as a category.
  const near = coffeeInsights.baselineFromVersions(['# 观察者整理\n\n## 意外链接总览\n- 甲。\n\n### 意外链接\n- 乙。'], 'zh-TW');
  assert.ok(near.every(item => item.category === 'questions'));
  // Body lines containing the words stay as they are.
  const body = coffeeInsights.baselineFromVersions(['# 观察者整理\n\n## 意外链接\n- 提到意外链接与核心分歧。'], 'zh-TW');
  assert.equal(body.length, 1);
  assert.equal(body[0].summary, '提到意外链接与核心分歧。');
  assert.equal(coffeeEngine.splitObserverNotes('对话里说 ## 意外链接 很有趣\n\n- 意外链接').notes, '');
});
