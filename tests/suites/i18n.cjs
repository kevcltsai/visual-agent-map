const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, root, load, plain, obsidian, DEFAULT_SETTINGS } = require('../support.cjs');
test('UI language switch translates stable semantic keys and placeholders', () => {
  const {t,setUiLanguage,translate}=load('i18n.ts');setUiLanguage('en');assert.equal(t('ui.interface_language'),'Interface language');assert.equal(t('ui.expand_0',3),'Expand 3');assert.equal(translate('en','detail.core_conclusions'),'Core conclusions');assert.equal(translate('zh-TW','detail.core_conclusions'),'核心結論');assert.equal(translate('zh-TW','ui.expand_0'),'展開 {0}');assert.equal(translate('zh-TW','ui.interface_language'),'介面語言');
  assert.equal(translate('zh-TW','missing.runtime.key'), 'missing.runtime.key');
});
test('first install defaults to English regardless of Obsidian language while saved VAM choice wins', () => {
  const { initialUiLanguage } = load('i18n.ts');
  assert.equal(DEFAULT_SETTINGS.language, 'en');
  assert.equal(initialUiLanguage(undefined), 'en');
  assert.equal(initialUiLanguage(null), 'en');
  assert.equal(initialUiLanguage('invalid'), 'en');
  assert.equal(initialUiLanguage('en'), 'en');
  assert.equal(initialUiLanguage('zh-TW'), 'zh-TW');
});
test('language change saves before applying and refreshes all views without mutating notes', async () => {
  const { default: Plugin, VisualAgentMapSettingTab } = load('main.ts', { obsidian });
  const plugin = new Plugin();
  const calls = [];
  plugin.settings = { ...DEFAULT_SETTINGS, language: 'en' };
  const sharedSettings = plugin.settings;
  plugin.saveData = async settings => { calls.push(['save', settings.language, plugin.settings.language]); };
  plugin.repo = { settings: sharedSettings, syncManagedDetailHeadings: async () => { throw new Error('language switch must not rewrite Markdown'); } };
  plugin.views = () => [
    { refreshFromPlugin: async () => { calls.push(['view-a', plugin.settings.language]); throw new Error('test view error'); } },
    { refreshFromPlugin: async () => calls.push(['view-b', plugin.settings.language]) }
  ];
  plugin.coffeeViews = () => [{ refreshForLanguageChange: async () => calls.push(['coffee-a', plugin.settings.language]) }, { refreshForLanguageChange: async () => calls.push(['coffee-b', plugin.settings.language]) }];
  plugin.refreshLocalizedEntrypoints = () => calls.push(['commands', plugin.settings.language]);
  plugin.recordFailure = (...args) => calls.push(['diagnostic', ...args]);
  plugin.settingTab = { update() {}, refreshAfterLanguageChange: () => calls.push(['settings', plugin.settings.language, plugin.languageSwitchPending]) };
  const tab = new VisualAgentMapSettingTab({}, plugin);
  await tab.setControlValue('language', 'zh-TW');
  assert.equal(plugin.settings.language, 'zh-TW');
  assert.deepEqual(calls.filter(([kind]) => ['save', 'commands', 'view-a', 'view-b', 'coffee-a', 'coffee-b'].includes(kind)), [['save', 'zh-TW', 'en'], ['commands', 'zh-TW'], ['view-a', 'zh-TW'], ['view-b', 'zh-TW'], ['coffee-a', 'zh-TW'], ['coffee-b', 'zh-TW']]);
  assert.equal(plugin.settings, sharedSettings);
  assert.equal(plugin.repo.settings.language, 'zh-TW', 'repository keeps the shared settings object updated');
  assert.equal(calls.filter(([kind]) => kind === 'diagnostic').length, 1);
  assert.equal(plugin.languageSwitchPending, false);
  calls.length = 0;
  await tab.setControlValue('language', 'en');
  assert.equal(plugin.settings.language, 'en');
  assert.equal(calls.filter(([kind]) => kind === 'save').length, 1);
  assert.equal(calls.filter(([kind]) => kind === 'view-b').length, 1);
});
test('failed language save keeps the old selection and does not refresh views', async () => {
  const { default: Plugin } = load('main.ts', { obsidian });
  const plugin = new Plugin(), calls = [];
  plugin.settings = { ...DEFAULT_SETTINGS, language: 'en' };
  plugin.saveData = async () => { throw new Error('disk full'); };
  plugin.views = () => [{ refreshFromPlugin: async () => calls.push('view') }];
  plugin.refreshLocalizedEntrypoints = () => calls.push('commands');
  plugin.recordFailure = () => calls.push('logged');
  plugin.settingTab = { update() {}, refreshAfterLanguageChange: () => calls.push(['settings', plugin.languageSwitchPending]) };
  assert.equal(await plugin.changeLanguage('zh-TW'), false);
  assert.equal(plugin.settings.language, 'en');
  assert.deepEqual(calls, [['settings', true], 'logged', ['settings', false]]);
});
test('concurrent language changes are ignored until the first save and refresh completes', async () => {
  const { default: Plugin } = load('main.ts', { obsidian });
  let finishSave, writes = 0;
  const plugin = new Plugin(); plugin.settings = { ...DEFAULT_SETTINGS, language: 'en' };
  plugin.saveData = async () => { writes++; await new Promise(resolve => { finishSave = resolve; }); };
  plugin.views = () => [];
  plugin.refreshLocalizedEntrypoints = () => {};
  plugin.recordFailure = () => {};
  plugin.settingTab = { update() {}, refreshAfterLanguageChange() {} };
  const first = plugin.changeLanguage('zh-TW'); await Promise.resolve();
  assert.equal(plugin.languageSwitchPending, true);
  assert.equal(await plugin.changeLanguage('en'), false);
  assert.equal(writes, 1);
  finishSave();
  assert.equal(await first, true);
  assert.equal(plugin.settings.language, 'zh-TW');
  assert.equal(plugin.languageSwitchPending, false);
});
test('built-in Sample language refresh preserves selected topic and view state', async () => {
  const { VisualAgentMapView } = load('main.ts', { obsidian });
  const { builtInSample } = load('builtin-sample.ts');
  const plugin = { settings: { language: 'zh-TW' }, syncOutline() {}, releaseOutline() {} };
  const view = new VisualAgentMapView({ app: {} }, plugin);
  view.builtIn = true; view.map = builtInSample('en').map; view.notes = builtInSample('en').notes;
  view.map.viewport = { x: -128, y: 74, zoom: 0.83 };
  view.selected = view.map.nodes[0].id; view.render = () => {};
  const selected = view.selected, viewport = plain(view.map.viewport);
  await view.refreshFromPlugin();
  assert.match(view.map.title, /範例/);
  assert.equal(view.selected, selected);
  assert.deepEqual(plain(view.map.viewport), viewport);
});
test('AI entry prompts for Codex only when unavailable and leaves manual work available', async () => {
  const { default: Plugin } = load('main.ts', { obsidian });
  const plugin = new Plugin(); let guides = 0;
  plugin.settings = { ...DEFAULT_SETTINGS, models: '' };
  plugin.openCodexSetupGuide = () => { guides++; };
  plugin.codexDiagnostic = () => ({ installed: false });
  assert.equal(await plugin.codexReadyForAi(), false);
  assert.equal(guides, 1);
  plugin.codexDiagnostic = () => ({ installed: true });
  plugin.settings.cliModel = 'gpt-test';
  plugin.refreshModelDiscovery = async () => ({ provider: 'codex', status: 'ready', models: ['gpt-test'] });
  assert.equal(await plugin.codexReadyForAi(), true);
  plugin.settings.models = 'gpt-test';
  assert.equal(await plugin.codexReadyForAi(), true);
  assert.equal(guides, 1);
});
test('localized command and ribbon labels follow the selected VAM language', () => {
  const { default: Plugin } = load('main.ts', { obsidian });
  const plugin = new Plugin(), attributes = {}, command = { name: '' };
  plugin.ribbonIcon = { setAttribute: (key, value) => { attributes[key] = value; } };
  plugin.localizedCommands = [{ command, key: 'ui.open_map' }];
  plugin.settings = { ...DEFAULT_SETTINGS, language: 'en' }; plugin.refreshLocalizedEntrypoints();
  assert.equal(command.name, 'Visual Agent Map (VAM): Open mind map');
  assert.equal(attributes['aria-label'], 'Open mind map');
  plugin.settings.language = 'zh-TW'; plugin.refreshLocalizedEntrypoints();
  assert.equal(command.name, 'Visual Agent Map (VAM): 開啟心智圖');
});
test('map switch closes only the VAM note that remains in its right pane and clears Obsidian Outline', () => {
  class MarkdownView { constructor(path) { this.file = { path }; } }
  const { default: Plugin } = load('main.ts', { obsidian: { ...obsidian, MarkdownView } });
  const plugin = new Plugin(); let closed = 0, fileCleared = 0, synchronized = 0; plugin.app = { workspace: { getActiveViewOfType: () => ({ leaf: { id: 'map-view' } }), trigger: (event, leaf) => { if (event === 'file-open') { assert.equal(leaf, null); fileCleared++; } else { assert.equal(event, 'active-leaf-change'); assert.equal(leaf.id, 'map-view'); synchronized++; } } } };
  plugin.detailsPath = 'old-note.md';
  plugin.detailsLeaf = { view: new MarkdownView('other-user-note.md'), detach: () => { closed++; } };
  plugin.closeStaleDetails(); assert.equal(closed, 0); assert.equal(fileCleared, 0); assert.equal(synchronized, 0);
  plugin.detailsPath = 'old-note.md';
  plugin.detailsLeaf = { view: new MarkdownView('old-note.md'), detach: () => { closed++; } };
  plugin.closeStaleDetails(); assert.equal(closed, 1); assert.equal(fileCleared, 1); assert.equal(synchronized, 1);
});
test('topic status labels follow the selected UI language after startup', () => {
  const {topicStatusLabel}=load('i18n.ts');
  assert.equal(topicStatusLabel('idea', 'en'), 'To research');
  assert.equal(topicStatusLabel('idea', 'zh-TW'), '待研究');
  assert.equal(topicStatusLabel('error', 'en'), 'Task error');
});
// Files whose messages, logs and generated note text must come from i18n.ts, never inline Chinese.
const runtimeMessageFiles = ['ai/runtime/codex-app-server.ts', 'ai/runtime/claude-code-cli.ts', 'core/ai-task-service.ts', 'core/reframing-service.ts', 'ai-exchange-log.ts', 'pending-suggestions.ts', 'main.ts', 'experiences/aim/research-run-store.ts', 'ai/reference-materials.ts', 'ui/modals/aim-clarification-modal.ts', 'ui/preview-utils.ts'];
test('runtime, service and log messages carry no inline Chinese text', () => {
  const offenders = runtimeMessageFiles.flatMap(file => fs.readFileSync(path.join(root, file), 'utf8').split('\n').map((line, index) => [file, index + 1, line]).filter(([, , line]) => /\p{Script=Han}/u.test(line)).map(([file, line]) => `${file}:${line}`));
  assert.deepEqual(offenders, []);
});
test('all user-facing translations use stable semantic keys', () => {
  const english = fs.readFileSync(path.join(root, 'i18n', 'en.ts'), 'utf8');
  const chinese = fs.readFileSync(path.join(root, 'i18n', 'zh-TW.ts'), 'utf8');
  const extract = value => new Set([...value.matchAll(/^  "((?:[^"\\]|\\.)+)":/gm)].map(match => match[1]));
  const keys = extract(english);
  assert.deepEqual([...extract(chinese)].sort(), [...keys].sort(), 'every locale must define exactly the same semantic keys');
  const tsFiles = dir => fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? tsFiles(`${dir}/${entry.name}`) : entry.name.endsWith('.ts') ? [`${dir}/${entry.name}`] : []);
  // Coffee Tables prompt, transcript and Markdown-format modules hold conversation content, not interface text.
  const coffeeContent = /^experiences\/coffee-tables\/(prompts|engine|convergence|storage|insights|types|topics|samples|outline|segments)\.ts$/;
  const sourceFiles = ['main.ts', 'map-model.ts', ...runtimeMessageFiles.filter(file => !file.startsWith('ui/') && file !== 'main.ts'), ...tsFiles('ui'), ...tsFiles('experiences').filter(file => !coffeeContent.test(file))];
  const missing = [];
  let checked = 0;
  for (const file of sourceFiles) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    for (const match of source.matchAll(/(?:\bt\(|\btranslate\([^,()]+(?:\([^()]*\))?,\s*)"((?:[^"\\]|\\.)*)"/g)) {
      checked++;
      if (!/^[a-z][a-z0-9_.]*$/.test(match[1]) || !keys.has(match[1])) missing.push(`${file}: ${match[1]}`);
    }
  }
  assert.deepEqual(missing, []);
  assert.ok(checked > 600, `expected the scan to reach Coffee Tables keys, saw ${checked}`);
  const coffeeSources = tsFiles('experiences/coffee-tables').filter(file => !coffeeContent.test(file));
  for (const file of coffeeSources) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    assert.doesNotMatch(source, /\btr\(\s*["`]|this\.zh\b|\bmessage\(\s*["`]/, `${file} must use i18n keys instead of inline bilingual pairs`);
  }
  const dictionaryValues = source => new Map([...source.matchAll(/^  "((?:[^"\\]|\\.)+)": "((?:[^"\\]|\\.)*)",?$/gm)].map(match => [match[1], match[2]]));
  const englishValues = dictionaryValues(english), chineseValues = dictionaryValues(chinese);
  const placeholders = value => [...value.matchAll(/\{\d+\}/g)].map(match => match[0]).sort();
  for (const [key, value] of englishValues) assert.deepEqual(placeholders(chineseValues.get(key)), placeholders(value), `${key} placeholders must match between locales`);
});
test('the sample tour names the controls exactly as the map labels them, in both languages', () => {
  const { translate } = load('i18n.ts');
  for (const lang of ['en', 'zh-TW']) {
    const tr = key => translate(lang, key);
    for (const key of ['ui.collapse', 'ui.node_tool_links', 'ui.node_tool_rename', 'ui.node_tool_details', 'ui.ai_explore'])
      assert.ok(tr('ui.tour_2_body').includes(tr(key)), `${lang}: tour step 2 names ${tr(key)}`);
    assert.ok(tr('ui.tour_4_body').includes(tr('ui.select_topics')), `${lang}: tour step 4 names the select button`);
    assert.ok(tr('ui.tour_5_body').includes(tr('ui.topic')), `${lang}: tour step 5 names the add-topic button`);
  }
});
test('language registry helpers resolve the four language axes', () => {
  const i18n = load('i18n.ts');
  assert.deepEqual(plain(i18n.LANGUAGES.map(item => item.id)), ['zh-TW', 'en']);
  assert.equal(i18n.noteLanguageOf('zh-TW'), 'zh-TW');
  assert.equal(i18n.noteLanguageOf('en'), 'en');
  assert.equal(i18n.instructionLanguageOf('zh-TW'), 'zh');
  assert.equal(i18n.instructionLanguageOf('en'), 'en');
  assert.equal(i18n.isUiLanguage('zh-TW'), true);
  assert.equal(i18n.isUiLanguage('zh-CN'), false);
  assert.equal(i18n.isNoteLanguage('en'), true);
  assert.equal(i18n.isNoteLanguage('unsupported'), false);
  assert.equal(i18n.contentLocale('zh-TW', 'zh-TW'), 'zh-TW');
  assert.equal(i18n.contentLocale('zh-TW', 'en'), 'zh-TW');
  assert.equal(i18n.contentLocale('en', 'zh-TW'), 'en');
  assert.equal(i18n.intlLocaleOf('zh-TW'), 'zh-TW');
  assert.equal(i18n.uiLocale('zh-TW'), 'zh-TW');
  assert.equal(i18n.uiLocale('zh-CN'), 'en');
  assert.equal(i18n.initialUiLanguage('zh-CN'), 'en');
});
test('registry prompt names reproduce every language spelling in the prompt files', () => {
  const { languagePromptName: name } = load('i18n.ts');
  assert.equal(name('zh-TW', 'zh', 'plain'), '繁體中文');
  assert.equal(name('zh-TW', 'zh', 'region'), '繁體中文（台灣）');
  assert.equal(name('zh-TW', 'zh', 'usage'), '繁體中文（台灣用法）');
  assert.equal(name('zh-TW', 'en', 'plain'), 'Traditional Chinese');
  assert.equal(name('zh-TW', 'en', 'region'), 'Traditional Chinese (Taiwan)');
  assert.equal(name('en', 'en', 'plain'), 'English');
  // The core language fragments take the name from the registry ({{language}}); the Coffee Tables prompt still spells it out.
  const parameterised = ['core/steps/aim/language.zh.md', 'core/steps/relevance-grade/language.zh.md', 'core/steps/reframe/language.zh.md'];
  for (const file of parameterised) assert.ok(fs.readFileSync(path.join(root, file), 'utf8').includes('{{language}}'), file);
  const files = ['experiences/coffee-tables/steps/table/prompt.zh.md'];
  const spellings = new Set(['繁體中文（台灣用法）', '繁體中文（台灣）', 'Traditional Chinese (Taiwan)']);
  for (const file of files) assert.ok([...spellings].some(text => fs.readFileSync(path.join(root, file), 'utf8').includes(text)), file);
});
test('inLanguage selects the fragment by instruction language', () => {
  const { inLanguage } = load('core/steps/_shared/fragments.ts');
  assert.equal(inLanguage({ zh: '中', en: 'E' }, 'zh-TW'), '中');
  assert.equal(inLanguage({ zh: '中', en: 'E' }, 'en'), 'E');
});
test('translate looks up the language dictionary and falls back to English', () => {
  const { translate } = load('i18n.ts');
  assert.equal(translate('zh-TW', 'ui.interface_language'), '介面語言');
  assert.equal(translate('en', 'ui.expand_0', 2), 'Expand 2');
});
test('check:i18n passes on the repository dictionaries and fails on a bad placeholder fixture', () => {
  const os = require('node:os');
  const { spawnSync } = require('node:child_process');
  const script = path.join(root, 'scripts', 'check-i18n.mjs');
  const real = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
  assert.equal(real.status, 0, real.stderr);
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'vam-i18n-'));
  try {
    fs.mkdirSync(path.join(fixture, 'i18n'));
    fs.copyFileSync(path.join(root, 'i18n', 'languages.ts'), path.join(fixture, 'i18n', 'languages.ts'));
    const write = (name, exportName, entries) => fs.writeFileSync(path.join(fixture, 'i18n', name), `export const ${exportName} = {\n  // coffee:begin\n  "coffee.a": "Hello **{0}**",\n  // coffee:end\n${entries}};\n`);
    write('en.ts', 'en', '  "ui.b": "Count {0} of {1}",\n');
    write('zh-TW.ts', 'zhTW', '  "ui.b": "第 {0} 項",\n');
    const bad = spawnSync(process.execPath, [script, '--root', fixture], { cwd: root, encoding: 'utf8' });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /zh-TW ui\.b: placeholders differ/);
    write('zh-TW.ts', 'zhTW', '  "ui.b": "第 {0} 項，共 {1}",\n');
    assert.equal(spawnSync(process.execPath, [script, '--root', fixture], { cwd: root, encoding: 'utf8' }).status, 0);
    write('zh-TW.ts', 'zhTW', '  "ui.b": "第 {0} 項，共 {1}",\n  "ui.extra": "x",\n');
    const extra = spawnSync(process.execPath, [script, '--root', fixture], { cwd: root, encoding: 'utf8' });
    assert.equal(extra.status, 1);
    assert.match(extra.stderr, /extra key/);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
