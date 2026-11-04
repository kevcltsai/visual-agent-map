const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, root, load, plain, obsidian, DEFAULT_SETTINGS, languageIds } = require('../support.cjs');
test('UI language switch translates stable semantic keys and placeholders', () => {
  const {t,setUiLanguage,translate}=load('i18n.ts');setUiLanguage('en');assert.equal(t('ui.interface_language'),'Interface language');assert.equal(t('ui.expand_0',3),'Expand 3');assert.equal(translate('en','detail.core_conclusions'),'Core conclusions');assert.equal(translate('zh-TW','detail.core_conclusions'),'核心結論');assert.equal(translate('zh-TW','ui.expand_0'),'展開 {0}');assert.equal(translate('zh-TW','ui.interface_language'),'介面語言');
  assert.equal(translate('zh-TW','missing.runtime.key'), 'missing.runtime.key');
});
// UX B5 (owner request 2026-11): this replaces "first install defaults to English regardless of Obsidian language".
test('first install follows the Obsidian language when VAM has an interface in it, English otherwise, while a saved VAM choice wins', () => {
  const { initialUiLanguage, uiLanguageFromAppLocale } = load('i18n.ts');
  assert.equal(DEFAULT_SETTINGS.language, 'en');
  assert.equal(initialUiLanguage(undefined), 'en', 'no app language known: English');
  assert.equal(initialUiLanguage(null), 'en');
  for (const [app, expected] of [['zh-TW', 'zh-TW'], ['zh', 'zh-CN'], ['zh-CN', 'zh-CN'], ['zh-Hant-HK', 'zh-TW'], ['zh_HK', 'zh-TW'], ['zh-Hans', 'zh-CN'], ['en', 'en'], ['en-GB', 'en'], ['fr', 'en'], ['ja', 'en'], ['', 'en']])
    assert.equal(initialUiLanguage(undefined, app), expected, `Obsidian in ${app}`);
  assert.equal(uiLanguageFromAppLocale('fr'), null); assert.equal(uiLanguageFromAppLocale('zh-tw'), 'zh-TW'); assert.equal(uiLanguageFromAppLocale(42), null);
  assert.equal(initialUiLanguage('en', 'zh-TW'), 'en', 'a saved choice is never replaced by the Obsidian language');
  assert.equal(initialUiLanguage('zh-CN', 'zh-TW'), 'zh-CN');
  assert.equal(initialUiLanguage('invalid', 'zh-TW'), 'en', 'an invalid saved value (or one from a newer version) stays English, as before');
  assert.equal(initialUiLanguage('invalid'), 'en');
  assert.equal(initialUiLanguage('en'), 'en');
  assert.equal(initialUiLanguage('zh-TW'), 'zh-TW');
  assert.equal(initialUiLanguage('zh-CN'), 'zh-CN');
});
test('UX B5: settingsFromSaved starts a new install in the Obsidian language and leaves saved settings alone', () => {
  const { settingsFromSaved } = load('main.ts', { obsidian });
  assert.equal(settingsFromSaved(null, 'zh-TW').language, 'zh-TW', 'a new install in a Traditional Chinese Obsidian');
  assert.equal(settingsFromSaved(null, 'zh').language, 'zh-CN');
  assert.equal(settingsFromSaved(null, 'de').language, 'en', 'no German interface: English');
  assert.equal(settingsFromSaved({ language: 'en' }, 'zh-TW').language, 'en', 'a saved English stays English');
  assert.equal(settingsFromSaved({ language: 'zh-TW' }, 'en').language, 'zh-TW');
  assert.equal(settingsFromSaved(null).language, 'en');
});
test('UX B5: onload reads the Obsidian language through getLanguage (and English when it cannot)', () => {
  const withLanguage = code => load('main.ts', { obsidian: { ...obsidian, getLanguage: () => code } }).obsidianAppLanguage();
  assert.equal(withLanguage('zh-TW'), 'zh-TW');
  assert.equal(load('main.ts', { obsidian: { ...obsidian, getLanguage: () => { throw new Error('old app'); } } }).obsidianAppLanguage(), 'en');
  const source = fs.readFileSync(path.join(root, 'main.ts'), 'utf8'); assert.match(source, /settingsFromSaved\(saved, obsidianAppLanguage\(\)\)/);
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
test('changeLanguage("zh-CN") saves first, then refreshes commands and views without touching Markdown', async () => {
  const { default: Plugin } = load('main.ts', { obsidian });
  const plugin = new Plugin(), calls = [];
  plugin.settings = { ...DEFAULT_SETTINGS, language: 'en' };
  plugin.saveData = async settings => { calls.push(['save', settings.language, plugin.settings.language]); };
  plugin.repo = { settings: plugin.settings, syncManagedDetailHeadings: async () => { throw new Error('language switch must not rewrite Markdown'); } };
  plugin.views = () => [{ refreshFromPlugin: async () => calls.push(['view', plugin.settings.language]) }];
  plugin.coffeeViews = () => [{ refreshForLanguageChange: async () => calls.push(['coffee', plugin.settings.language]) }];
  plugin.refreshLocalizedEntrypoints = () => calls.push(['commands', plugin.settings.language]);
  plugin.recordFailure = (...args) => calls.push(['diagnostic', ...args]);
  plugin.settingTab = { update() {}, refreshAfterLanguageChange: () => calls.push(['settings', plugin.settings.language]) };
  assert.equal(await plugin.changeLanguage('zh-CN'), true);
  assert.equal(plugin.settings.language, 'zh-CN');
  assert.deepEqual(calls.filter(([kind]) => kind !== 'settings'), [['save', 'zh-CN', 'en'], ['commands', 'zh-CN'], ['view', 'zh-CN'], ['coffee', 'zh-CN']]);
  assert.equal(calls.filter(([kind]) => kind === 'diagnostic').length, 0);
  assert.equal(plugin.languageSwitchPending, false);
  assert.equal(await plugin.changeLanguage('zh-CN'), false, 'selecting the current language is a no-op');
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
  plugin.manifest = { name: 'Visual Agent Map' };
  plugin.localizedCommands = [{ command, key: 'ui.command_open_map' }];
  plugin.settings = { ...DEFAULT_SETTINGS, language: 'en' }; plugin.refreshLocalizedEntrypoints();
  // The same prefix Obsidian gives a command when it is added (the plugin name), so a language change never renames it.
  assert.equal(command.name, 'Visual Agent Map: Open mind map');
  assert.equal(attributes['aria-label'], 'Open mind map');
  plugin.settings.language = 'zh-TW'; plugin.refreshLocalizedEntrypoints();
  assert.equal(command.name, 'Visual Agent Map: 開啟心智圖');
});
test('C4: every command keeps its id, takes its name from a ui.command_* key without the plugin name, and maintenance and diagnostics commands share a category word in every language', () => {
  const source = fs.readFileSync(path.join(root, 'main.ts'), 'utf8');
  const { translate } = load('i18n.ts');
  const ids = [], keys = new Map();
  for (const match of source.matchAll(/addLocalizedCommand\(\s*("[^"]+"|AIM_CREATE_MAP_COMMAND_ID),\s*"([^"]+)"/g)) { ids.push(match[1].replace(/"/g, '')); keys.set(ids.at(-1), match[2]); }
  for (const match of source.matchAll(/id: "([^"]+)",\s*name: t\("([^"]+)"\)/g)) { ids.push(match[1]); keys.set(match[1], match[2]); }
  assert.deepEqual(ids.slice().sort(), ['AIM_CREATE_MAP_COMMAND_ID', 'add-summary-bracket', 'add-text-node', 'fix-math-formulas', 'import-outline', 'import-outline-exchange', 'markdown-selection-ai', 'normalize-note-filenames', 'open-coffee-tables', 'open-debug-log', 'open-map', 'open-note-styles-folder', 'open-prompt-monitor', 'open-topic-outline', 'organize-workspace-folders', 'preview-full-prompt', 'rebuild-references', 'reconnect-workspace', 'repair-note-presentation', 'repair-workspace', 'share-map', 'toggle-map-chat'].sort(), 'the 22 command ids are unchanged, so hotkeys keep working');
  const category = { en: ['Maintenance: ', 'Diagnostics: '], 'zh-TW': ['維護：', '診斷：'], 'zh-CN': ['维护：', '诊断：'] };
  const maintenance = ['rebuild-references', 'normalize-note-filenames', 'repair-note-presentation', 'fix-math-formulas', 'organize-workspace-folders', 'repair-workspace', 'reconnect-workspace'];
  const diagnostics = ['open-prompt-monitor', 'open-debug-log'];
  for (const [id, key] of keys) {
    // toggle-map-chat keeps its older key (the map chat's own tests name it); every other command has a ui.command_* key.
    assert.match(key, id === 'toggle-map-chat' ? /^ui\.map_chat_toggle_command$/ : /^ui\.command_/, `${id} has its own command name key`);
    for (const language of ['en', 'zh-TW', 'zh-CN']) {
      const name = translate(language, key);
      assert.doesNotMatch(name, /Visual Agent Map|VAM\)|^VAM:/, `${language} ${id}: Obsidian adds the plugin name`);
      assert.ok(name.length <= 45, `${language} ${id} is short: ${name}`);
      if (language !== 'en') assert.doesNotMatch(name, /\([A-Za-z ]+\)/, `${language} ${id} has no English gloss in brackets`);
      const [care, diag] = category[language];
      assert.equal(name.startsWith(care), maintenance.includes(id), `${language} ${id}: ${name}`);
      assert.equal(name.startsWith(diag), diagnostics.includes(id), `${language} ${id}: ${name}`);
    }
  }
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
  const dictionaryFiles = languageIds().filter(id => id !== 'en').map(id => [id, fs.readFileSync(path.join(root, 'i18n', `${id}.ts`), 'utf8')]);
  const extract = value => new Set([...value.matchAll(/^  "((?:[^"\\]|\\.)+)":/gm)].map(match => match[1]));
  const keys = extract(english);
  for (const [id, source] of dictionaryFiles) assert.deepEqual([...extract(source)].sort(), [...keys].sort(), `${id} must define exactly the same semantic keys as en`);
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
  const englishValues = dictionaryValues(english);
  const placeholders = value => [...value.matchAll(/\{\d+\}/g)].map(match => match[0]).sort();
  for (const [id, source] of dictionaryFiles) {
    const values = dictionaryValues(source);
    for (const [key, value] of englishValues) assert.deepEqual(placeholders(values.get(key)), placeholders(value), `${id} ${key} placeholders must match between locales`);
  }
});
test('language registry helpers resolve the four language axes', () => {
  const i18n = load('i18n.ts');
  const ids = plain(i18n.LANGUAGES.map(item => item.id));
  for (const id of ['zh-TW', 'zh-CN', 'en']) assert.ok(ids.includes(id), `the registry lists ${id}`);
  assert.ok(ids.indexOf('zh-TW') < ids.indexOf('zh-CN') && ids.indexOf('zh-CN') < ids.indexOf('en'), 'zh-TW, zh-CN, en keep their relative order');
  assert.equal(i18n.noteLanguageOf('zh-TW'), 'zh-TW');
  assert.equal(i18n.noteLanguageOf('zh-CN'), 'zh-TW');
  assert.equal(i18n.noteLanguageOf('en'), 'en');
  assert.equal(i18n.instructionLanguageOf('zh-TW'), 'zh');
  assert.equal(i18n.instructionLanguageOf('zh-CN'), 'zh');
  assert.equal(i18n.instructionLanguageOf('en'), 'en');
  assert.equal(i18n.isUiLanguage('zh-TW'), true);
  assert.equal(i18n.isUiLanguage('zh-CN'), true);
  assert.equal(i18n.isUiLanguage('xx-unregistered'), false);
  assert.equal(i18n.isNoteLanguage('zh-CN'), false, 'a Simplified Chinese note language is never persisted');
  assert.equal(i18n.isNoteLanguage('en'), true);
  assert.equal(i18n.isNoteLanguage('unsupported'), false);
  assert.equal(i18n.contentLocale('zh-TW', 'zh-TW'), 'zh-TW');
  assert.equal(i18n.contentLocale('zh-TW', 'en'), 'zh-TW');
  assert.equal(i18n.contentLocale('en', 'zh-TW'), 'en');
  assert.equal(i18n.intlLocaleOf('zh-TW'), 'zh-TW');
  assert.equal(i18n.intlLocaleOf('zh-CN'), 'zh-CN');
  assert.equal(i18n.uiLocale('zh-TW'), 'zh-TW');
  assert.equal(i18n.uiLocale('zh-CN'), 'zh-CN');
  assert.equal(i18n.uiLocale('xx-unregistered'), 'en');
  assert.equal(i18n.initialUiLanguage('zh-CN'), 'zh-CN');
  assert.equal(i18n.initialUiLanguage('xx-unregistered'), 'en', 'a language written by a newer version reads as English');
});
test('contentLocale: the interface language when its note language matches, otherwise the note language', () => {
  const { contentLocale } = load('i18n.ts');
  const table = [
    ['zh-TW', 'zh-TW', 'zh-TW'], ['zh-TW', 'zh-CN', 'zh-CN'], ['zh-TW', 'en', 'zh-TW'],
    ['en', 'zh-TW', 'en'], ['en', 'zh-CN', 'en'], ['en', 'en', 'en']
  ];
  for (const [note, ui, expected] of table) assert.equal(contentLocale(note, ui), expected, `contentLocale(${note}, ${ui})`);
});
test('registry prompt names reproduce every language spelling in the prompt files', () => {
  const { languagePromptName: name } = load('i18n.ts');
  assert.equal(name('zh-TW', 'zh', 'plain'), '繁體中文');
  assert.equal(name('zh-TW', 'zh', 'region'), '繁體中文（台灣）');
  assert.equal(name('zh-TW', 'zh', 'usage'), '繁體中文（台灣用法）');
  assert.equal(name('zh-TW', 'en', 'plain'), 'Traditional Chinese');
  assert.equal(name('zh-TW', 'en', 'region'), 'Traditional Chinese (Taiwan)');
  assert.equal(name('zh-CN', 'zh', 'plain'), '简体中文');
  assert.equal(name('zh-CN', 'zh', 'region'), '简体中文（中国大陆）');
  assert.equal(name('zh-CN', 'zh', 'usage'), '简体中文（中国大陆用法）');
  assert.equal(name('zh-CN', 'en', 'plain'), 'Simplified Chinese');
  assert.equal(name('zh-CN', 'en', 'region'), 'Simplified Chinese (Mainland China)');
  assert.equal(name('zh-CN', 'en', 'usage'), 'Simplified Chinese (Mainland China usage)');
  assert.equal(name('en', 'en', 'plain'), 'English');
  // The language fragments (core and Coffee Tables) take the name from the registry ({{language}}) instead of spelling it out.
  const parameterised = ['core/steps/aim/language.zh.md', 'core/steps/reframe/language.zh.md'];
  for (const step of ['table', 'question', 'observer-only', 'navigation-summary']) for (const lang of ['zh', 'en']) parameterised.push(`experiences/coffee-tables/steps/${step}/prompt.${lang}.md`);
  for (const lang of ['zh', 'en']) parameterised.push(`experiences/coffee-tables/steps/_shared/builtin-style.${lang}.md`);
  for (const file of parameterised) assert.ok(fs.readFileSync(path.join(root, file), 'utf8').includes('{{language}}'), file);
  const spelled = ['experiences/coffee-tables/steps/table/prompt.zh.md', 'experiences/coffee-tables/steps/_shared/builtin-style.zh.md'];
  for (const file of spelled) assert.ok(!/繁體中文|Traditional Chinese/.test(fs.readFileSync(path.join(root, file), 'utf8')), file);
});
test('inLanguage selects the fragment by instruction language', () => {
  const { inLanguage } = load('core/steps/_shared/fragments.ts');
  assert.equal(inLanguage({ zh: '中', en: 'E' }, 'zh-TW'), '中');
  assert.equal(inLanguage({ zh: '中', en: 'E' }, 'zh-CN'), '中');
  assert.equal(inLanguage({ zh: '中', en: 'E' }, 'en'), 'E');
});
test('translate looks up the language dictionary and falls back to English', () => {
  const { translate } = load('i18n.ts');
  assert.equal(translate('zh-TW', 'ui.interface_language'), '介面語言');
  assert.equal(translate('en', 'ui.expand_0', 2), 'Expand 2');
  assert.equal(translate('zh-CN', 'ui.interface_language'), '界面语言');
});
test('check:i18n fails on bad placeholder and extra-key fixtures and passes on a good one', async () => {
  const os = require('node:os');
  const { execFile } = require('node:child_process');
  const script = path.join(root, 'scripts', 'check-i18n.mjs');
  const { LANGUAGES } = load('i18n/languages.ts');
  const exportName = id => id.replace(/-([A-Za-z])/g, (_, letter) => letter.toUpperCase()).replace(/-/g, '');
  const fixtures = [];
  // One fixture directory per case, so the three real CLI runs go at once; each holds the dictionaries the case needs.
  const makeFixture = chinese => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'vam-i18n-')); fixtures.push(fixture);
    fs.mkdirSync(path.join(fixture, 'i18n'));
    fs.copyFileSync(path.join(root, 'i18n', 'languages.ts'), path.join(fixture, 'i18n', 'languages.ts'));
    const write = (name, name2, entries) => fs.writeFileSync(path.join(fixture, 'i18n', name), `export const ${name2} = {\n  // coffee:begin\n  "coffee.a": "Hello **{0}**",\n  // coffee:end\n${entries}};\n`);
    write('en.ts', 'en', '  "ui.b": "Count {0} of {1}",\n');
    // One dictionary per non-English registry language, so a new language needs no edit here.
    for (const { id } of LANGUAGES) if (id !== 'en') write(`${id}.ts`, exportName(id), chinese);
    return fixture;
  };
  const run = fixture => new Promise(resolve => execFile(process.execPath, [script, '--root', fixture], { cwd: root, encoding: 'utf8' }, (error, stdout, stderr) => resolve({ status: error ? error.code : 0, stdout, stderr })));
  try {
    const [bad, good, extra] = await Promise.all([
      run(makeFixture('  "ui.b": "第 {0} 項",\n')),
      run(makeFixture('  "ui.b": "第 {0} 項，共 {1}",\n')),
      run(makeFixture('  "ui.b": "第 {0} 項，共 {1}",\n  "ui.extra": "x",\n'))
    ]);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /zh-TW ui\.b: placeholders differ/);
    assert.equal(good.status, 0);
    assert.equal(extra.status, 1);
    assert.match(extra.stderr, /extra key/);
  } finally {
    for (const fixture of fixtures) fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('bug bash #31: the root-topic action label exists in all three languages and keeps its placeholder', () => {
  const { translate } = load('i18n.ts');
  assert.equal(translate('en', 'ui.map_chat_do_add_root_0'), 'Add root topic “{0}”');
  assert.equal(translate('zh-TW', 'ui.map_chat_do_add_root_0'), '新增根議題「{0}」');
  assert.equal(translate('zh-CN', 'ui.map_chat_do_add_root_0'), '新增根议题“{0}”');
});

test('bug bash #30: the delete-to-Unassigned label says 未歸類 / 未归类, never 未分配', () => {
  const { translate } = load('i18n.ts');
  assert.equal(translate('zh-TW', 'ui.map_chat_do_delete_0', 'X'), '把「X」移到未歸類');
  assert.equal(translate('zh-CN', 'ui.map_chat_do_delete_0', 'X'), '把“X”移到未归类');
  assert.equal(translate('en', 'ui.map_chat_do_delete_0', 'X'), 'Move “X” to Unassigned');
});
test('bug bash #32: the Codex turn labels are translated and keep the status', () => {
  const { translate } = load('i18n.ts');
  assert.equal(translate('zh-TW', 'ui.codex_turn_0', 'S'), 'Codex 回合未完成：S');
  assert.equal(translate('zh-CN', 'ui.codex_turn_0', 'S'), 'Codex 回合未完成：S');
  assert.equal(translate('en', 'ui.codex_turn_0', 'S'), 'Codex turn S');
  assert.equal(translate('en', 'ui.codex_status_interrupted'), 'interrupted');
  assert.equal(translate('zh-TW', 'ui.codex_status_interrupted'), '已中斷');
  assert.equal(translate('zh-CN', 'ui.codex_status_interrupted'), '已中断');
});
test('bug bash #33: ui.undo_0 and ui.redo_0 use a full-width colon in Chinese', () => {
  const { translate } = load('i18n.ts');
  assert.deepEqual([translate('en', 'ui.undo_0', 'A'), translate('en', 'ui.redo_0', 'A')], ['Undo: A', 'Redo: A']);
  assert.deepEqual([translate('zh-TW', 'ui.undo_0', 'A'), translate('zh-TW', 'ui.redo_0', 'A')], ['復原：A', '重做：A']);
  assert.deepEqual([translate('zh-CN', 'ui.undo_0', 'A'), translate('zh-CN', 'ui.redo_0', 'A')], ['复原：A', '重做：A']);
});
test('bug bash #34: zh-CN uses mainland wording (折叠, 点击, 添加文字), not 收合 or 按一下 or 新增文字', () => {
  const source = fs.readFileSync(path.join(root, 'i18n/zh-CN.ts'), 'utf8');
  for (const word of ['收合', '按一下', '新增文字']) assert.ok(!source.includes(word), `zh-CN contains ${word}`);
  const { translate } = load('i18n.ts');
  assert.equal(translate('zh-CN', 'ui.text_node_add'), '添加文字');
  assert.equal(translate('zh-CN', 'ui.zoom_level_0_reset', '80%'), '当前缩放 80%，点击重置为 100%');
  assert.equal(translate('zh-CN', 'ui.collapse'), '折叠');
  assert.equal(translate('zh-CN', 'ui.collapse_all'), '全部折叠');
  assert.equal(translate('zh-CN', 'ui.map_chat_do_collapse_0', 'A'), '折叠“A”');
});
// Persona 25: the Synthesize dialog picks full content or summary in the same window (renderSynthesisContent), so the intro must not promise a next step.
test('Synthesize intro does not promise a nonexistent next step for the content choice', () => {
  const { translate } = load('i18n.ts');
  for (const lang of ['en', 'zh-TW', 'zh-CN']) {
    const text = translate(lang, 'ui.synthesize_0_source_topics_ai_reads_their_full_knowledge_and', 3);
    assert.doesNotMatch(text, /next step|下一步/i, lang);
    assert.match(text, /3/, lang);
  }
});
