// Output-only languages (D-2026-10-73): a language in OUTPUT_LANGUAGES has no dictionary and no snapshot tag. Its prompts
// are the English ones with the language named (Japanese) and the fixed-heading clauses, which this file proves by
// diffing against the English snapshots' builders; detection, persistence and the menu are covered below.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { load, promptsFor, normalizeText } = require('./support-replay.cjs');
const support = require('./support.cjs');

const i18n = load('i18n.ts');
const { LANGUAGES, OUTPUT_LANGUAGES } = load('i18n/languages.ts');
const content = load('experiences/aim/content-language.ts');
const { detectAimContentLanguage, chooseAimContentLanguage, resolveAimContentLanguage, selectionOutputLanguage } = content;

const RULE_JA = /The six standard Detail headings are fixed in the note language \(English\) and are copied exactly from the detail structure; the body stays in Japanese\./g;
const RULE_EN = 'The six standard Detail headings must follow the interface language.';
const CLAUSE_JA = 'Write the fixed headings exactly as listed (English; do not convert them to Japanese) and add no second set of headings; only the content under the headings is written in Japanese.';
/** The ja prompt reduced to the en prompt: drop the heading clauses, restore the en heading rule, rename the language. */
function reduce(ja) {
  const lines = ja.split('\n'), kept = lines.filter(line => line !== CLAUSE_JA);
  return { text: kept.join('\n').replace(RULE_JA, RULE_EN).split('Japanese').join('English'), clauses: lines.length - kept.length, rules: (ja.match(RULE_JA) ?? []).length };
}
function assertReduces(name, ja, en, expected) {
  const reduced = reduce(normalizeText(ja));
  assert.equal(reduced.text, normalizeText(en), `${name}: ja prompt differs from en beyond the language name and heading clauses`);
  if (expected) assert.deepEqual({ clauses: reduced.clauses, rules: reduced.rules }, expected, `${name}: heading clauses`);
}

test('output languages: table shape, not in LANGUAGES, English instruction and notes, nothing registered twice', () => {
  const ids = OUTPUT_LANGUAGES.map(item => item.id);
  assert.deepEqual([...ids], ['ja', 'ko', 'es', 'fr', 'de', 'pt', 'ru', 'ar', 'th', 'vi']);
  assert.equal(new Set(ids).size, ids.length);
  for (const entry of OUTPUT_LANGUAGES) {
    assert.equal(entry.instruction, 'en'); assert.equal(entry.note, 'en');
    assert.equal(LANGUAGES.some(item => item.id === entry.id), false, `${entry.id} is output-only`);
    assert.equal('dictionary' in entry, false);
    assert.ok(entry.label && entry.name && entry.intl);
    for (const instruction of ['zh', 'en']) for (const form of ['plain', 'region', 'usage']) assert.ok(entry.prompt[instruction][form]);
    assert.equal(i18n.isUiLanguage(entry.id), false, 'never an interface language');
    assert.equal(i18n.isNoteLanguage(entry.id), false);
    assert.equal(i18n.isContentLanguage(entry.id), true);
    assert.equal(i18n.noteLanguageOf(entry.id), 'en');
    assert.equal(i18n.instructionLanguageOf(entry.id), 'en');
    assert.equal(i18n.intlLocaleOf(entry.id), entry.intl);
    assert.equal(i18n.verbatimHeadingLanguage(entry.id), 'en');
  }
  assert.equal(i18n.initialUiLanguage('ja'), 'en'); assert.equal(i18n.uiLocale('ja'), 'en');
  assert.deepEqual([...i18n.SUPPORTED_LANGUAGES.map(item => item.id)], [...LANGUAGES.map(item => item.id)], 'interface menu unchanged');
  assert.equal(i18n.languagePromptName('ja', 'en', 'plain'), 'Japanese'); assert.equal(i18n.languagePromptName('ja', 'zh', 'plain'), '日文');
  assert.equal(i18n.translate('ja', 'ui.output_language'), i18n.translate('en', 'ui.output_language'), 'no dictionary: English text');
  assert.equal(i18n.supportedLanguageLabel('ja'), '日本語');
});

test('output languages: detection follows the table data (kana, hangul, Arabic script, Thai) and keeps Han and Latin', () => {
  const cases = [
    ['東京の旅行', 'ja'], ['日本語の勉強', 'ja'], ['カタカナ', 'ja'], ['한국 여행', 'ko'], ['서울', 'ko'], ['رحلة إلى القاهرة', 'ar'], ['การเดินทางไปเชียงใหม่', 'th'],
    ['日本語です Plan', 'ja'], ['東京五天自由行怎麼排', 'zh-TW'], ['东京五天自由行怎么排', 'zh-TW'], ['Plan a trip', 'en'], ['What does 侘寂 mean', 'en'],
    ['Python 的 async 怎麼用', 'zh-TW'], ['', undefined], ['2026', undefined], ['🍜', undefined]
  ];
  for (const [text, expected] of cases) assert.equal(detectAimContentLanguage(text), expected, text);
  // Persian and Urdu write Arabic script; their own letters mean there is no Arabic signal.
  for (const letter of ['پ', 'چ', 'ژ', 'گ', 'ک', 'ی', 'ٹ', 'ڈ', 'ڑ', 'ں', 'ے']) assert.equal(detectAimContentLanguage(`رحلة ${letter}`), undefined, `Arabic script with ${letter} gives no signal`);
  for (const text of ['東京の旅行', '한국 여행']) assert.notEqual(detectAimContentLanguage(text), 'unsupported');
  for (const ui of ['en', 'zh-TW', 'zh-CN']) {
    assert.equal(chooseAimContentLanguage(ui, '한국 여행', '中文'), 'ko');
    assert.equal(chooseAimContentLanguage(ui, 'رحلة گ', 'Some English context'), 'en', 'a no-signal topic falls through to the context');
    assert.equal(chooseAimContentLanguage(ui, 'رحلة گ'), ui, 'no signal anywhere: the interface language');
    assert.equal(chooseAimContentLanguage(ui, '🍜'), ui);
  }
  assert.equal(chooseAimContentLanguage('zh-CN', '中文主题'), 'zh-CN', 'registry behaviour unchanged');
});

test('output languages: ja task prompt equals the en prompt except the language name and heading clauses', async () => {
  const base = { title: 'Topic T', summary: 'Current summary S', rules: 'Rule R', detail: 'Existing detail D', task: 'Do task X', ancestors: 'Ancestor A', workingFindings: 'Older finding F', sourceContext: 'Source [S1]: fact', mode: 'task', researchMode: 'research', researchDepth: 'normal', visualMode: 'auto' };
  const variants = [{}, { visualMode: 'on' }, { researchMode: 'local', researchDepth: 'fast' }, { mode: 'decompose', researchDepth: 'deep' }, { mode: 'synthesize', researchMode: 'local', visualMode: 'off' }];
  for (const [index, extra] of variants.entries()) {
    const en = await promptsFor({ ...base, ...extra, outputLanguage: 'en' }, { language: 'en' });
    const ja = await promptsFor({ ...base, ...extra, outputLanguage: 'ja' }, { language: 'en' });
    assert.equal(ja.length, en.length);
    ja.forEach((call, i) => assertReduces(`task variant ${index}`, call.prompt, en[i].prompt));
  }
  const ja = (await promptsFor({ ...base, outputLanguage: 'ja' }, { language: 'en' }))[0].prompt;
  assert.ok(ja.includes('Write newly generated content in Japanese'), 'names the language');
  assert.ok(ja.includes(CLAUSE_JA), 'carries the fixed-heading clause');
  assert.match(ja, RULE_JA);
  assert.equal(/日本語|日文/.test(ja), false);
});

test('output languages: ja AIM shell prompts equal the en prompts except the language name and heading clauses', async () => {
  const aimBase = { title: 'Goal G', summary: 'Summary S', rules: 'Rule R', detail: 'Reports D', ancestors: 'Known conditions C', workingFindings: 'Prior findings F', sourceContext: 'Source [S1]: fact', mode: 'task', promptProfile: 'aim', researchMode: 'local', researchDepth: 'normal', visualMode: 'off' };
  for (const phase of [undefined, 'initial-clarification', 'initial-question', 'research-plan', 'report-review', 'delivery-writing']) {
    const task = phase ? `<!-- aim-phase: ${phase} -->\nPhase task text.` : 'Plain task text.';
    const en = await promptsFor({ ...aimBase, task, outputLanguage: 'en' }, { language: 'en' });
    const ja = await promptsFor({ ...aimBase, task, outputLanguage: 'ja' }, { language: 'en' });
    assert.equal(ja.length, en.length, String(phase));
    ja.forEach((call, i) => assertReduces(`aim ${phase}`, call.prompt, en[i].prompt));
    assert.ok(ja[0].prompt.includes('Japanese'), `aim ${phase} names Japanese`);
    assert.equal(ja[0].prompt.includes(CLAUSE_JA), false, `aim ${phase}: AIM prompts carry no fixed-heading clause (as for zh-CN)`);
  }
});

test('output languages: ja outline, structure-review and relevance prompts equal the en prompts except the language name', () => {
  const { buildOutlineGeneratePrompt } = support.load('core/outline-generation-service.ts', { obsidian: support.obsidian });
  const { buildStructureReviewPrompt } = support.load('core/structure-review-service.ts', { obsidian: support.obsidian });
  const { buildRelevanceGradePrompt } = support.load('core/relevance-grade-service.ts', { obsidian: support.obsidian });
  const nodes = [{ id: 'n1', title: 'Root topic', summary: 'Root summary', status: 'completed', parentId: null, depth: 0 }, { id: 'n2', title: 'Child topic', summary: 'Child summary', status: 'idea', parentId: 'n1', depth: 1 }];
  const calls = {
    outline: contentLanguage => buildOutlineGeneratePrompt({ language: 'en', contentLanguage, topic: 'Topic under study', presetText: 'Build a knowledge tree for {Enter research topic} in three levels.', model: 'm', reasoning: 'low' }),
    structure: contentLanguage => buildStructureReviewPrompt({ language: 'en', contentLanguage, rootQuestion: 'Root question text', nodes, model: 'm', reasoning: 'low' }),
    relevance: contentLanguage => buildRelevanceGradePrompt({ language: 'en', contentLanguage, goal: 'Learner goal text', nodes, model: 'm', reasoning: 'low' })
  };
  for (const [name, build] of Object.entries(calls)) {
    const en = build('en'), ja = build('ja');
    assert.ok(ja.includes('Japanese'), `${name} names Japanese`);
    assertReduces(name, ja, en);
  }
});

test('output languages: AIM maps record outputLanguage beside the note language, and resolve it first', () => {
  const ja = { title: '東京の旅行', aim: { version: 1, contentLanguage: 'en', outputLanguage: 'ja' } };
  for (const ui of ['en', 'zh-TW', 'zh-CN']) assert.equal(resolveAimContentLanguage(ja, ui), 'ja');
  assert.equal(i18n.noteLanguageOf(resolveAimContentLanguage(ja, 'zh-TW')), 'en', 'fixed note text is English');
  // Compatibility: a map saved before output-only languages existed stored the note language only.
  assert.equal(resolveAimContentLanguage({ title: '東京の旅行', aim: { version: 1, contentLanguage: 'en' } }, 'en'), 'ja', 'English-interface Japanese map upgrades to Japanese');
  assert.equal(resolveAimContentLanguage({ title: '東京の旅行', aim: { version: 1, contentLanguage: 'zh-TW' } }, 'zh-TW'), 'zh-TW', 'Chinese-interface map keeps Chinese');
  assert.equal(resolveAimContentLanguage({ title: '東京の旅行', aim: { version: 1, contentLanguage: 'zh-TW' } }, 'en'), 'zh-TW');
  // An unknown stored value is ignored, never thrown on.
  for (const bad of ['xx', 'zh-TW', 'en', 7, null, {}]) assert.doesNotThrow(() => resolveAimContentLanguage({ title: 'Plan', aim: { version: 1, contentLanguage: 'en', outputLanguage: bad } }, 'en'));
  assert.equal(resolveAimContentLanguage({ title: 'Plan', aim: { version: 1, contentLanguage: 'en', outputLanguage: 'xx' } }, 'en'), 'en');
  assert.equal(resolveAimContentLanguage({ title: 'Plan', aim: { version: 1, contentLanguage: 'zh-TW', outputLanguage: 'zh-TW' } }, 'en'), 'zh-TW', 'an interface id in the field is not an output-only language');
  assert.equal(resolveAimContentLanguage({ title: 'Plan a trip', aim: { version: 1, contentLanguage: 'zh-TW' } }, 'en'), 'zh-TW');
});

test('output languages: a new Japanese AIM map stores outputLanguage ja and contentLanguage en; a legacy map gets both on first write', async () => {
  const subject = await support.coverageSetup('東京の旅行');
  const stored = await subject.repo.readMap(subject.created.mapPath);
  assert.equal(stored.aim.outputLanguage, 'ja');
  assert.equal(stored.aim.contentLanguage, 'en');
  // A Chinese topic in the same interface stores no outputLanguage.
  const plain = await support.coverageSetup('東京五天自由行怎麼排');
  assert.equal('outputLanguage' in (await plain.repo.readMap(plain.created.mapPath)).aim, false);
  // Legacy: no contentLanguage at all; the first write stamps both fields and a later title edit cannot change them.
  const legacy = await subject.repo.readMap(subject.created.mapPath);
  delete legacy.aim.contentLanguage; delete legacy.aim.outputLanguage;
  await subject.repo.saveMap(subject.created.mapPath, legacy);
  const written = await subject.repo.readMap(subject.created.mapPath);
  assert.equal(written.aim.contentLanguage, 'en');
  assert.equal(written.aim.outputLanguage, 'ja');
  // A map upgraded from the note-language-only form (0.24) is pinned on its next write.
  delete written.aim.outputLanguage;
  await subject.repo.saveMap(subject.created.mapPath, written);
  assert.equal((await subject.repo.readMap(subject.created.mapPath)).aim.outputLanguage, 'ja');
  // An unknown stored outputLanguage does not stop the map from opening.
  const odd = await subject.repo.readMap(subject.created.mapPath);
  odd.aim.outputLanguage = 'xx';
  await subject.repo.saveMap(subject.created.mapPath, odd);
  await assert.doesNotReject(subject.repo.readMap(subject.created.mapPath));
});

test('output languages: selection AI follows an output-only language in the selected text, registry languages follow the interface', () => {
  for (const ui of ['en', 'zh-TW', 'zh-CN']) {
    assert.equal(selectionOutputLanguage(ui, '東京の旅行'), 'ja');
    assert.equal(selectionOutputLanguage(ui, '한국 여행'), 'ko');
    assert.equal(selectionOutputLanguage(ui, '中文內容'), ui, 'registry language follows the interface');
    assert.equal(selectionOutputLanguage(ui, 'English text'), ui);
    assert.equal(selectionOutputLanguage(ui, ''), ui);
  }
});

test('output languages: a general task defaults to the detected language; a note with another content-language keeps the old default', () => {
  const { defaultOutputLanguage } = support.load('experiences/visual-map/modals.ts', { obsidian: support.obsidian });
  assert.equal(defaultOutputLanguage('en', '東京の旅行'), 'ja');
  assert.equal(defaultOutputLanguage('zh-TW', '東京の旅行', undefined), 'ja');
  assert.equal(defaultOutputLanguage('en', '東京の旅行', 'en'), 'ja', 'same note language: follows the detection');
  assert.equal(defaultOutputLanguage('zh-TW', '東京の旅行', 'zh-TW'), 'zh-TW', 'differing content-language keeps the interface default');
  assert.equal(defaultOutputLanguage('en', 'Plan a trip', 'zh-TW'), 'en');
  assert.equal(defaultOutputLanguage('zh-TW', '中文主題', 'zh-TW'), 'zh-TW');
});

test('output languages: the menu lists registry languages first, then an optgroup of output-only languages', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'experiences/visual-map/modals.ts'), 'utf8');
  assert.match(source, /for \(const option of SUPPORTED_LANGUAGES\)\s+languageSelect\.createEl\("option"/);
  assert.match(source, /createEl\("optgroup", \{ attr: \{ label: t\("ui\.output_language_more"\) \} \}\)/);
  assert.match(source, /for \(const option of OUTPUT_LANGUAGE_CHOICES\)\s+moreLanguages\.createEl\("option"/);
  assert.ok(source.indexOf('SUPPORTED_LANGUAGES)') < source.indexOf('OUTPUT_LANGUAGE_CHOICES)'));
  assert.deepEqual([...i18n.OUTPUT_LANGUAGE_CHOICES.map(item => item.id)], [...OUTPUT_LANGUAGES.map(item => item.id)]);
  for (const id of ['en', 'zh-TW', 'zh-CN']) assert.ok(i18n.translate(id, 'ui.output_language_more').length > 0);
  const settings = fs.readFileSync(path.join(__dirname, '..', 'ui/settings-tab.ts'), 'utf8');
  assert.equal(settings.includes('OUTPUT_LANGUAGE'), false, 'the interface-language menu does not list output-only languages');
});

test('output languages: the Markdown selection AI is wired to the selected text', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.ts'), 'utf8');
  assert.match(main, /selectionOutputLanguage\(this\.settings\.language, selected\)/);
  const panel = fs.readFileSync(path.join(__dirname, '..', 'experiences/markdown-context/selection-ai.ts'), 'utf8');
  assert.match(panel, /this\.options\.language\(snapshot\.text\)/);
});

test('output languages: no existing prompt snapshot changed (the new languages add none)', () => {
  const directory = path.join(__dirname, 'snapshots', 'prompts');
  const names = fs.readdirSync(directory);
  for (const entry of OUTPUT_LANGUAGES) assert.equal(names.some(name => new RegExp(`\\.${entry.id}(\\.\\d+)?\\.(txt|schema\\.json)$`).test(name)), false, entry.id);
});
