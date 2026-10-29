// Output-only languages (D-2026-10-73, revised by D-2026-10-81..91): a language in OUTPUT_LANGUAGES has no dictionary and no
// snapshot tag. Its prompts are the English ones with the language named (Japanese) and the fixed-heading clauses, which
// this file proves by diffing against the English snapshots' builders; the virtual "same as input" row is proven the same
// way against the clause wording. Detection (kana rule, Vietnamese, Han script), the output language priority, the note
// language guard, per-map memory and the menu are covered below.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { load, promptsFor, normalizeText } = require('./support-replay.cjs');
const support = require('./support.cjs');

const i18n = load('i18n.ts');
const { LANGUAGES, OUTPUT_LANGUAGES } = load('i18n/languages.ts');
const content = load('experiences/aim/content-language.ts');
const { detectAimContentLanguage, chooseAimContentLanguage, resolveAimContentLanguage, selectionOutputLanguage, defaultOutputLanguage, outputLanguageForMap, noteLanguageFromBody } = content;
// The clause without an anchor (nothing to quote), then the anchored one that names and quotes the user's own text (D-2026-10-94).
const CLAUSE_EN = "the language in which the user's own text (topic, question or selection) is written (not the language of these instructions or of the fixed headings)";
const CLAUSE_ZH = '使用者自己輸入的文字（主題、問題或選取文字）所使用的語言（不是這些指示或固定標題的語言）';
const anchoredEn = (kind, text) => `the language in which the user's ${kind} "${text}" is written (not the language of these instructions or of the fixed headings)`;
const escapeRe = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const RULE_JA = /The six standard Detail headings are fixed in the note language \(English\) and are copied exactly from the detail structure; the body stays in Japanese\./g;
const RULE_EN = 'The six standard Detail headings must follow the interface language.';
const CLAUSE_JA = 'Write the fixed headings exactly as listed (English; do not convert them to Japanese) and add no second set of headings; only the content under the headings is written in Japanese.';
// The same-as-input prompt differs from the en prompt with the anchored clause where the language name was, and its own
// heading wording (no "English versus another language" contrast, D-2026-10-94), for the anchor `kind`/`text` it was built from.
const followFlavour = (kind, text) => {
  const name = anchoredEn(kind, text);
  return {
    name,
    rule: new RegExp(`The six standard Detail headings are fixed exactly as listed in the detail structure and are copied verbatim, not translated; the body is written in ${escapeRe(name)}\\.`, 'g'),
    clause: `Write the fixed headings exactly as listed and do not translate them; add no second set of headings; only the content under the headings is written in ${name}.`
  };
};
const FLAVOURS = { ja: { name: 'Japanese', rule: RULE_JA, clause: CLAUSE_JA } };
/** The prompt reduced to the en prompt: drop the heading clauses, restore the en heading rule, rename the language. */
function reduce(ja, flavour = FLAVOURS.ja) {
  const lines = ja.split('\n'), kept = lines.filter(line => line !== flavour.clause);
  return { text: kept.join('\n').replace(flavour.rule, RULE_EN).split(flavour.name).join('English'), clauses: lines.length - kept.length, rules: (ja.match(flavour.rule) ?? []).length };
}
function assertReduces(name, ja, en, expected, flavour = FLAVOURS.ja) {
  const reduced = reduce(normalizeText(ja), flavour);
  assert.equal(reduced.text, normalizeText(en), `${name}: ja prompt differs from en beyond the language name and heading clauses`);
  if (expected) assert.deepEqual({ clauses: reduced.clauses, rules: reduced.rules }, expected, `${name}: heading clauses`);
}

test('output languages: table shape, not in LANGUAGES, English instruction and notes, nothing registered twice', () => {
  const ids = OUTPUT_LANGUAGES.map(item => item.id);
  assert.deepEqual([...ids], ['ja', 'ko', 'es', 'fr', 'de', 'pt', 'ru', 'ar', 'th', 'vi', 'same-as-input']);
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

test('output languages: the same-as-input row is a virtual row with the exact clause, in every name form and both instruction languages', () => {
  const row = OUTPUT_LANGUAGES.find(item => item.followsInput);
  assert.equal(row.id, 'same-as-input'); assert.equal(row.followsInput, true);
  assert.equal(OUTPUT_LANGUAGES.filter(item => item.followsInput).length, 1);
  assert.equal(row.detect, undefined, 'never matched by script');
  for (const form of ['plain', 'region', 'usage']) {
    assert.equal(i18n.languagePromptName('same-as-input', 'en', form), CLAUSE_EN);
    assert.equal(i18n.languagePromptName('same-as-input', 'zh', form), CLAUSE_ZH);
    assert.equal(i18n.languagePromptName('same-as-input', 'en', form, { kind: 'topic', text: '  ' }), CLAUSE_EN, 'a blank anchor falls back to the unanchored clause');
  }
  // Anchored: names and quotes the user's text; other languages ignore the anchor (D-2026-10-94).
  assert.equal(i18n.languagePromptName('same-as-input', 'en', 'plain', { kind: 'topic', text: 'Histoire de la Révolution' }), anchoredEn('topic', 'Histoire de la Révolution'));
  assert.equal(i18n.languagePromptName('same-as-input', 'en', 'plain', { kind: 'question', text: 'Pourquoi?' }), anchoredEn('question', 'Pourquoi?'));
  assert.equal(i18n.languagePromptName('same-as-input', 'en', 'plain', { kind: 'selection', text: 'Texto' }), anchoredEn('selected text', 'Texto'));
  assert.equal(i18n.languagePromptName('same-as-input', 'zh', 'plain', { kind: 'topic', text: 'La vie' }), '使用者的主題「La vie」所使用的語言（不是這些指示或固定標題的語言）');
  assert.equal(i18n.languagePromptName('same-as-input', 'en', 'plain', { kind: 'topic', text: 'Say "hi"\nthen {anchor} \\ ok' }), anchoredEn('topic', 'Say \\"hi\\" then {anchor} \\\\ ok'), 'one line, quotes and backslashes escaped, placeholders in the text are not re-expanded');
  const long = 'x'.repeat(200);
  assert.equal(i18n.languagePromptName('same-as-input', 'en', 'plain', { kind: 'topic', text: long }), anchoredEn('topic', `${'x'.repeat(80)}…`), 'long anchors are cut to 80 characters');
  assert.equal(i18n.languagePromptName('ja', 'en', 'plain', { kind: 'topic', text: 'Topic' }), 'Japanese');
  assert.equal(i18n.isFollowInputLanguage('same-as-input'), true);
  for (const id of ['ja', 'en', 'zh-TW', 'xx', undefined]) assert.equal(i18n.isFollowInputLanguage(id), false);
  assert.equal(i18n.noteLanguageOf('same-as-input'), 'en', 'fixed note text is English (D-2026-10-84)');
  assert.equal(i18n.verbatimHeadingLanguage('same-as-input'), 'en');
  assert.deepEqual([...i18n.OUTPUT_LANGUAGE_CHOICES.map(item => item.id)], ['ja', 'ko', 'es', 'fr', 'de', 'pt', 'ru', 'ar', 'th', 'vi'], 'the language lists (menu group, image translation) do not offer the virtual row');
  // The menu label is a dictionary key in all three dictionaries, so it is shown in the interface language.
  const labels = ['en', 'zh-TW', 'zh-CN'].map(id => i18n.translate(id, 'ui.output_language_follow_input'));
  assert.equal(new Set(labels).size, 3); assert.equal(labels[1], '跟隨輸入語言');
  assert.equal(i18n.translate('same-as-input', 'ui.output_language_follow_input'), labels[0]);
});

test('output languages: detection follows the table data (kana rule, hangul, Arabic script, Thai, Vietnamese); other letters follow the input', () => {
  const cases = [
    ['カタカナ', 'ja'], ['東京ラーメンの旅', 'ja'], ['東京ラーメン guide', 'ja'], ['日本語です Plan', 'ja'], ['한국 여행', 'ko'], ['서울', 'ko'], ['رحلة إلى القاهرة', 'ar'], ['การเดินทางไปเชียงใหม่', 'th'],
    ['Du lịch Hà Nội', 'vi'], ['Phở bò', 'vi'], ['Món ăn Việt Nam', 'vi'], ['tiếng Việt', 'vi'], ['Việt', 'vi'], ['người', 'vi'],
    ['東京五天自由行怎麼排', 'zh-TW'], ['东京五天自由行怎么排', 'zh-CN'], ['Python 的 async 怎麼用', 'zh-TW'],
    ['Plan a trip', 'same-as-input'], ['What does 侘寂 mean', 'same-as-input'], ['Planificar un viaje', 'same-as-input'], ['Какой маршрут', 'same-as-input'], ['Τι είναι', 'same-as-input'], ['מה זה', 'same-as-input'],
    ['', undefined], ['2026', undefined], ['🍜', undefined]
  ];
  for (const [text, expected] of cases) assert.equal(detectAimContentLanguage(text), expected, text);
  // Vietnamese: a lone đ or ă does not count (Tagalog-free Latin text, Romanian), the stacked-diacritic block and ơ ư do.
  for (const text of ['Đà', 'Ma ăn', 'dap', 'Dien Bien Phu']) assert.equal(detectAimContentLanguage(text), 'same-as-input', text);
  for (const letter of ['ơ', 'Ơ', 'ư', 'Ư', '\u1EA0', '\u1EF9']) assert.equal(detectAimContentLanguage(`abc ${letter}`), 'vi', `U+${letter.codePointAt(0).toString(16)}`);
  assert.equal(detectAimContentLanguage('abc \u1EFA'), 'same-as-input', 'U+1EFA is outside the block');
  // Persian and Urdu write Arabic script; their own letters mean it is not Arabic, so the model follows the text (D-2026-10-85).
  for (const letter of ['پ', 'چ', 'ژ', 'گ', 'ک', 'ی', 'ٹ', 'ڈ', 'ڑ', 'ں', 'ے']) assert.equal(detectAimContentLanguage(`رحلة ${letter}`), 'same-as-input', `Arabic script with ${letter} follows the input`);
  for (const text of ['東京の旅行', '한국 여행']) assert.notEqual(detectAimContentLanguage(text), 'unsupported');
  for (const ui of ['en', 'zh-TW', 'zh-CN']) {
    assert.equal(chooseAimContentLanguage(ui, '한국 여행', '中文'), 'ko');
    assert.equal(chooseAimContentLanguage(ui, 'رحلة گ', 'Some English context'), 'same-as-input', 'the topic has letters nothing recognises: follow the input, not the later context');
    assert.equal(chooseAimContentLanguage(ui, '🍜', 'Some English context'), 'same-as-input', 'no letters in the topic: the context decides');
    assert.equal(chooseAimContentLanguage(ui, '🍜'), ui, 'no letters anywhere: the interface language');
    assert.equal(chooseAimContentLanguage(ui, 'Plan a trip'), 'same-as-input');
  }
  assert.equal(chooseAimContentLanguage('zh-CN', '中文主题'), 'zh-CN');
  assert.equal(chooseAimContentLanguage('zh-TW', '中文主题'), 'zh-CN', 'Simplified characters in a Traditional interface: Simplified (D-2026-10-87)');
  assert.equal(chooseAimContentLanguage('zh-CN', '東京五天自由行怎麼排'), 'zh-TW', 'Traditional characters in a Simplified interface: Traditional');
  assert.equal(chooseAimContentLanguage('zh-CN', '中文背景'), 'zh-CN', 'only shared characters: the interface decides');
  assert.equal(chooseAimContentLanguage('zh-TW', '中文背景'), 'zh-TW');
  assert.equal(chooseAimContentLanguage('en', '中文背景'), 'zh-TW');
});

test('output languages: the kana rule needs two kana besides の and kana plus Han of at least twice the Latin words (D-2026-10-86)', () => {
  // Chinese titles borrow の; one or only の is not a Japanese signal.
  for (const text of ['小確幸の生活', '台灣の旅', '東京の旅行', '日本語の勉強', 'の', 'ののの', '台灣のみ']) assert.notEqual(detectAimContentLanguage(text), 'ja', text);
  for (const ui of ['en', 'zh-TW']) {
    assert.equal(chooseAimContentLanguage(ui, '小確幸の生活'), 'zh-TW'); assert.equal(chooseAimContentLanguage(ui, '台灣の旅'), 'zh-TW'); assert.equal(chooseAimContentLanguage(ui, '東京の旅行'), 'zh-TW');
    assert.equal(chooseAimContentLanguage(ui, 'Notes on ラーメン shops'), 'same-as-input', 'a Latin sentence quoting katakana');
    assert.equal(chooseAimContentLanguage(ui, '東京ラーメン guide'), 'ja');
  }
  assert.equal(detectAimContentLanguage('ひらがな'), 'ja');
  assert.equal(detectAimContentLanguage('東京ラーメン'), 'ja');
  assert.equal(detectAimContentLanguage('ラメン'), 'ja', 'exactly two kana besides の');
  assert.equal(detectAimContentLanguage('ラの'), 'zh-TW' === 'ja' ? 'ja' : detectAimContentLanguage('ラの'), 'one kana besides の is not enough');
  assert.notEqual(detectAimContentLanguage('ラの'), 'ja');
  // Boundary of the Latin ratio: kana + Han = 2 * words passes, one short does not.
  assert.equal(detectAimContentLanguage('東京ラメン A'), 'ja'); assert.equal(detectAimContentLanguage('東京ラメン A B'), 'ja'); assert.notEqual(detectAimContentLanguage('東京ラメン A B C'), 'ja');
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

test('output languages: ja outline and structure-review prompts equal the en prompts except the language name', () => {
  const { buildOutlineGeneratePrompt } = support.load('core/outline-generation-service.ts', { obsidian: support.obsidian });
  const { buildStructureReviewPrompt } = support.load('core/structure-review-service.ts', { obsidian: support.obsidian });
  const { buildRelevanceGradePrompt } = support.load('core/relevance-grade-service.ts', { obsidian: support.obsidian });
  const nodes = [{ id: 'n1', title: 'Root topic', summary: 'Root summary', status: 'completed', parentId: null, depth: 0 }, { id: 'n2', title: 'Child topic', summary: 'Child summary', status: 'idea', parentId: 'n1', depth: 1 }];
  const calls = {
    outline: contentLanguage => buildOutlineGeneratePrompt({ language: 'en', contentLanguage, topic: 'Topic under study', presetText: 'Build a knowledge tree for {Enter research topic} in three levels.', model: 'm', reasoning: 'low' }),
    structure: contentLanguage => buildStructureReviewPrompt({ language: 'en', contentLanguage, rootQuestion: 'Root question text', nodes, model: 'm', reasoning: 'low' })
  };
  // The relevance grade has no output language since D-2026-10-99..103 (it writes no prose): its prompt is the same for every language.
  assert.equal(buildRelevanceGradePrompt({ language: 'en', goal: 'Learner goal text', nodes, model: 'm', reasoning: 'low' }), buildRelevanceGradePrompt({ language: 'zh-TW', goal: 'Learner goal text', nodes, model: 'm', reasoning: 'low' }));
  for (const [name, build] of Object.entries(calls)) {
    const en = build('en'), ja = build('ja');
    assert.ok(ja.includes('Japanese'), `${name} names Japanese`);
    assertReduces(name, ja, en);
  }
});

test('output languages: same-as-input task prompts equal the en prompts except the clause where the language name was, and the heading clauses', async () => {
  const base = { title: 'Topic T', summary: 'Current summary S', rules: 'Rule R', detail: 'Existing detail D', task: 'Do task X', ancestors: 'Ancestor A', workingFindings: 'Older finding F', sourceContext: 'Source [S1]: fact', mode: 'task', researchMode: 'research', researchDepth: 'normal', visualMode: 'auto' };
  const variants = [{}, { visualMode: 'on' }, { researchMode: 'local', researchDepth: 'fast' }, { mode: 'decompose', researchDepth: 'deep' }, { mode: 'synthesize', researchMode: 'local', visualMode: 'off' }];
  for (const [index, extra] of variants.entries()) {
    const en = await promptsFor({ ...base, ...extra, outputLanguage: 'en' }, { language: 'en' });
    const follow = await promptsFor({ ...base, ...extra, outputLanguage: 'same-as-input' }, { language: 'en' });
    assert.equal(follow.length, en.length);
    follow.forEach((call, i) => assertReduces(`task variant ${index}`, call.prompt, en[i].prompt, undefined, followFlavour('topic', 'Topic T')));
  }
  const follow = (await promptsFor({ ...base, outputLanguage: 'same-as-input' }, { language: 'en' }))[0].prompt;
  const flavour = followFlavour('topic', 'Topic T');
  assert.ok(follow.includes(`Write newly generated content in ${flavour.name} by default`), 'carries the anchored clause where the language name was');
  assert.ok(follow.includes(flavour.clause), 'carries the fixed-heading clause');
  assert.match(follow, flavour.rule);
  assert.doesNotMatch(follow, /note language|do not convert them to/, 'no English-versus-other-language contrast in follow-input mode');
  assert.ok(follow.includes('Topic T') && follow.includes('Do task X'), 'the prompt contains the user text the clause refers to');
  // Under a zh-TW interface the instruction language stays English for this row (the clause is spelled for the instruction language).
  const zhUi = (await promptsFor({ ...base, outputLanguage: 'same-as-input' }, { language: 'zh-TW' }))[0].prompt;
  assert.ok(zhUi.includes(flavour.name) && !zhUi.includes('使用者的主題'));
});

test('output languages: same-as-input AIM shell prompts equal the en prompts except the clause (no heading clause, as for ja)', async () => {
  const aimBase = { title: 'Goal G', summary: 'Summary S', rules: 'Rule R', detail: 'Reports D', ancestors: 'Known conditions C', workingFindings: 'Prior findings F', sourceContext: 'Source [S1]: fact', mode: 'task', promptProfile: 'aim', researchMode: 'local', researchDepth: 'normal', visualMode: 'off' };
  for (const phase of [undefined, 'initial-clarification', 'initial-question', 'research-plan', 'report-review', 'delivery-writing']) {
    const task = phase ? `<!-- aim-phase: ${phase} -->\nPhase task text.` : 'Plain task text.';
    const en = await promptsFor({ ...aimBase, task, outputLanguage: 'en' }, { language: 'en' });
    const follow = await promptsFor({ ...aimBase, task, outputLanguage: 'same-as-input' }, { language: 'en' });
    assert.equal(follow.length, en.length, String(phase));
    follow.forEach((call, i) => assertReduces(`aim ${phase}`, call.prompt, en[i].prompt, undefined, followFlavour('topic', 'Goal G')));
    assert.ok(follow[0].prompt.includes(anchoredEn('topic', 'Goal G')), `aim ${phase} carries the anchored clause`);
    assert.ok(follow[0].prompt.includes('Goal G'), `aim ${phase}: the prompt contains the user text (the goal)`);
  }
});

test('output languages: same-as-input outline and structure-review prompts equal the en prompts except the clause, and contain the user text', () => {
  const { buildOutlineGeneratePrompt } = support.load('core/outline-generation-service.ts', { obsidian: support.obsidian });
  const { buildStructureReviewPrompt } = support.load('core/structure-review-service.ts', { obsidian: support.obsidian });
  const nodes = [{ id: 'n1', title: 'Root topic', summary: 'Root summary', status: 'completed', parentId: null, depth: 0 }, { id: 'n2', title: 'Child topic', summary: 'Child summary', status: 'idea', parentId: 'n1', depth: 1 }];
  const calls = {
    outline: ['topic', contentLanguage => buildOutlineGeneratePrompt({ language: 'en', contentLanguage, topic: 'Topic under study', presetText: 'Build a knowledge tree for {Enter research topic} in three levels.', model: 'm', reasoning: 'low' }), 'Topic under study'],
    structure: ['question', contentLanguage => buildStructureReviewPrompt({ language: 'en', contentLanguage, rootQuestion: 'Root question text', nodes, model: 'm', reasoning: 'low' }), 'Root question text']
  };
  for (const [name, [kind, build, userText]] of Object.entries(calls)) {
    const en = build('en'), follow = build('same-as-input');
    assert.ok(follow.includes(anchoredEn(kind, userText)), `${name} carries the anchored clause`);
    assert.ok(follow.includes(userText), `${name}: the prompt contains the user text the clause refers to`);
    assertReduces(name, follow, en, undefined, followFlavour(kind, userText));
  }
});

test('output languages: a map records its output language in map.outputLanguage and resolves it first (D-2026-10-88)', () => {
  const ja = { title: '東京の旅行', outputLanguage: 'ja', aim: { version: 1, contentLanguage: 'en' } };
  for (const ui of ['en', 'zh-TW', 'zh-CN']) assert.equal(resolveAimContentLanguage(ja, ui), 'ja');
  assert.equal(i18n.noteLanguageOf(resolveAimContentLanguage(ja, 'zh-TW')), 'en', 'fixed note text is English');
  // A map without an AIM extension remembers too, and any content language is valid, including the follow-the-input row.
  for (const id of ['same-as-input', 'zh-CN', 'zh-TW', 'en', 'es', 'ko']) for (const ui of ['en', 'zh-TW']) assert.equal(resolveAimContentLanguage({ title: 'Plan', outputLanguage: id }, ui), id);
  // Compatibility: a map saved before output-only languages existed stored the note language only.
  assert.equal(resolveAimContentLanguage({ title: '東京ラーメンの旅', aim: { version: 1, contentLanguage: 'en' } }, 'en'), 'ja', 'English-interface Japanese map upgrades to Japanese');
  assert.equal(resolveAimContentLanguage({ title: '東京ラーメンの旅', aim: { version: 1, contentLanguage: 'zh-TW' } }, 'zh-TW'), 'zh-TW', 'Chinese-interface map keeps Chinese');
  assert.equal(resolveAimContentLanguage({ title: '東京ラーメンの旅', aim: { version: 1, contentLanguage: 'zh-TW' } }, 'en'), 'zh-TW');
  assert.equal(resolveAimContentLanguage({ title: '東京の旅行', aim: { version: 1, contentLanguage: 'en' } }, 'en'), 'en', 'no longer detected as Japanese (D-2026-10-86): the stored value stands');
  assert.equal(resolveAimContentLanguage({ title: 'Plan a trip', aim: { version: 1, contentLanguage: 'en' } }, 'en'), 'en', 'a stored note language is not upgraded to the follow-the-input row');
  // An unknown stored value is ignored, never thrown on.
  for (const bad of ['xx', '', 7, null, {}, [], true]) {
    assert.doesNotThrow(() => resolveAimContentLanguage({ title: 'Plan', outputLanguage: bad, aim: { version: 1, contentLanguage: 'en' } }, 'en'));
    assert.equal(resolveAimContentLanguage({ title: 'Plan', outputLanguage: bad, aim: { version: 1, contentLanguage: 'en' } }, 'en'), 'en');
    assert.equal(i18n.isContentLanguage(bad), false);
  }
  assert.equal(resolveAimContentLanguage({ title: 'Plan a trip', aim: { version: 1, contentLanguage: 'zh-TW' } }, 'en'), 'zh-TW');
  // The hook for other code (default names, labels): one function returning the map's ContentLanguage.
  assert.equal(content.resolveMapOutputLanguage, resolveAimContentLanguage);
  assert.equal(content.rememberedOutputLanguage({ outputLanguage: 'ja' }), 'ja'); assert.equal(content.rememberedOutputLanguage({ outputLanguage: 'xx' }), undefined); assert.equal(content.rememberedOutputLanguage(undefined), undefined);
  // A map-level run without a dialog: remembered first, then the user's own text, then the interface.
  assert.equal(outputLanguageForMap({ outputLanguage: 'ko' }, 'en', 'Plan a trip'), 'ko');
  assert.equal(outputLanguageForMap({}, 'en', 'Plan a trip'), 'same-as-input');
  assert.equal(outputLanguageForMap(undefined, 'zh-TW', '🍜'), 'zh-TW');
});

test('output languages: map.outputLanguage round-trips, and an unknown value is dropped when the map is read', () => {
  const { parseMap, serializeMap } = support.load('map-model.ts');
  const base = { version: 1, id: 'm', title: 'T', nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  for (const id of ['ja', 'same-as-input', 'zh-CN']) assert.equal(parseMap(serializeMap({ ...base, outputLanguage: id })).outputLanguage, id);
  assert.equal('outputLanguage' in parseMap(serializeMap(base)), false);
  for (const bad of ['xx', 5, null, {}]) assert.equal('outputLanguage' in parseMap(serializeMap({ ...base, outputLanguage: bad })), false, `${JSON.stringify(bad)} is ignored`);
});

test('output languages: new AIM maps record outputLanguage when it differs from the note language or was picked by hand; a legacy map gets it on first write', async () => {
  const subject = await support.coverageSetup('東京ラーメンの旅');
  const stored = await subject.repo.readMap(subject.created.mapPath);
  assert.equal(stored.outputLanguage, 'ja');
  assert.equal(stored.aim.contentLanguage, 'en');
  assert.equal('outputLanguage' in stored.aim, false, 'the 6e2250e aim.outputLanguage field is gone');
  // A Chinese topic in the same interface stores no outputLanguage.
  const plain = await support.coverageSetup('東京五天自由行怎麼排');
  assert.equal('outputLanguage' in (await plain.repo.readMap(plain.created.mapPath)), false);
  // An English topic follows its text (D-2026-10-83) and fixed text stays English; Simplified Chinese keeps Traditional fixed text.
  const english = await support.coverageSetup('Plan a 5-day Taipei trip');
  const englishMap = await english.repo.readMap(english.created.mapPath);
  assert.equal(englishMap.outputLanguage, 'same-as-input'); assert.equal(englishMap.aim.contentLanguage, 'en');
  const simplified = await support.coverageSetup('东京五天自由行怎么排');
  const simplifiedMap = await simplified.repo.readMap(simplified.created.mapPath);
  assert.equal(simplifiedMap.outputLanguage, 'zh-CN'); assert.equal(simplifiedMap.aim.contentLanguage, 'zh-TW');
  // A language picked by hand in the start dialog wins over detection and is recorded even when it equals the note language.
  const { createAimMap } = support.load('experiences/aim/create-map.ts');
  const repo = support.fixture('en').repo;
  const manual = await createAimMap(repo, 'gpt-6-luna', { requestId: 'manual-1', topic: 'Plan a 5-day Taipei trip', context: '', outputLanguage: 'es', minimumAnswersBeforeConclusion: 3 });
  assert.equal((await repo.readMap(manual.mapPath)).outputLanguage, 'es'); assert.equal((await repo.readMap(manual.mapPath)).aim.contentLanguage, 'en');
  const sameAsNote = await createAimMap(repo, 'gpt-6-luna', { requestId: 'manual-2', topic: 'Plan a trip', context: '', outputLanguage: 'en', minimumAnswersBeforeConclusion: 3 });
  assert.equal((await repo.readMap(sameAsNote.mapPath)).outputLanguage, 'en');
  // Legacy: no contentLanguage at all; the first write stamps both fields and a later title edit cannot change them.
  const legacy = await subject.repo.readMap(subject.created.mapPath);
  delete legacy.aim.contentLanguage; delete legacy.outputLanguage;
  await subject.repo.saveMap(subject.created.mapPath, legacy);
  const written = await subject.repo.readMap(subject.created.mapPath);
  assert.equal(written.aim.contentLanguage, 'en');
  assert.equal(written.outputLanguage, 'ja');
  // A map upgraded from the note-language-only form (0.24) is pinned on its next write.
  delete written.outputLanguage;
  await subject.repo.saveMap(subject.created.mapPath, written);
  assert.equal((await subject.repo.readMap(subject.created.mapPath)).outputLanguage, 'ja');
  // An unknown stored outputLanguage does not stop the map from opening, and is dropped.
  const odd = await subject.repo.readMap(subject.created.mapPath);
  odd.outputLanguage = 'xx';
  await subject.repo.saveMap(subject.created.mapPath, odd);
  await assert.doesNotReject(subject.repo.readMap(subject.created.mapPath));
  assert.notEqual((await subject.repo.readMap(subject.created.mapPath)).outputLanguage, 'xx');
});

test('output languages: selection AI follows the selected text (letters, then the follow-the-text clause, then the interface)', () => {
  for (const ui of ['en', 'zh-TW', 'zh-CN']) {
    assert.equal(selectionOutputLanguage(ui, '東京ラーメンの旅'), 'ja');
    assert.equal(selectionOutputLanguage(ui, '한국 여행'), 'ko');
    assert.equal(selectionOutputLanguage(ui, 'Du lịch Hà Nội'), 'vi');
    assert.equal(selectionOutputLanguage(ui, '東京五天自由行怎麼排'), 'zh-TW');
    assert.equal(selectionOutputLanguage(ui, '东京五天自由行怎么排'), 'zh-CN');
    assert.equal(selectionOutputLanguage(ui, '中文內容'), 'zh-TW');
    assert.equal(selectionOutputLanguage(ui, 'English text'), 'same-as-input');
    assert.equal(selectionOutputLanguage(ui, 'Texto en español'), 'same-as-input');
    assert.equal(selectionOutputLanguage(ui, ''), ui, 'no letters: the interface language');
  }
  assert.equal(selectionOutputLanguage('zh-CN', '中文背景'), 'zh-CN', 'shared characters only: the interface decides');
});

test('output languages: a general task defaults by priority (remembered, then detected), and a note with another note language keeps the old default (D-2026-10-84)', () => {
  assert.equal(defaultOutputLanguage('en', '東京ラーメンの旅'), 'ja');
  assert.equal(defaultOutputLanguage('zh-TW', '東京ラーメンの旅', undefined), 'ja');
  assert.equal(defaultOutputLanguage('en', '東京ラーメンの旅', 'en'), 'ja', 'same note language: follows the detection');
  assert.equal(defaultOutputLanguage('zh-TW', '東京ラーメンの旅', 'zh-TW'), 'zh-TW', 'differing note language keeps the interface default');
  assert.equal(defaultOutputLanguage('en', 'Plan a trip', 'en'), 'same-as-input');
  assert.equal(defaultOutputLanguage('en', 'Plan a trip', 'zh-TW'), 'en', 'an English topic in a Traditional Chinese note: the previous default');
  assert.equal(defaultOutputLanguage('zh-TW', 'Plan a trip', 'zh-TW'), 'zh-TW');
  assert.equal(defaultOutputLanguage('zh-TW', '中文主題', 'zh-TW'), 'zh-TW');
  assert.equal(defaultOutputLanguage('zh-TW', '东京五天自由行怎么排', 'zh-TW'), 'zh-CN', 'Simplified text: Simplified output, the note language stays zh-TW');
  // The map's remembered choice outranks detection and the note guard; unknown values are ignored.
  assert.equal(defaultOutputLanguage('en', 'Plan a trip', undefined, 'es'), 'es');
  assert.equal(defaultOutputLanguage('en', '東京ラーメンの旅', 'zh-TW', 'same-as-input'), 'same-as-input');
  assert.equal(defaultOutputLanguage('en', 'Plan a trip', undefined, 'xx'), 'same-as-input');
  assert.equal(defaultOutputLanguage('en', '🍜', undefined, undefined), 'en');
  // modals.ts re-exports the same function for the dialog.
  const dialog = support.load('experiences/visual-map/modals.ts', { obsidian: support.obsidian }).defaultOutputLanguage;
  assert.equal(dialog('en', 'Plan a trip', undefined, 'es'), 'es'); assert.equal(dialog('en', '東京ラーメンの旅'), 'ja');
});

test('output languages: the note language guard reads content-language, else the standard headings of the body, in either dictionary', () => {
  const heading = (language, key) => i18n.translate(language, key);
  const body = (language, ...keys) => keys.map(key => `## ${heading(language, key)}\n\ntext`).join('\n\n');
  assert.equal(noteLanguageFromBody(body('zh-TW', 'detail.core_conclusions', 'detail.key_knowledge')), 'zh-TW');
  assert.equal(noteLanguageFromBody(body('en', 'detail.open_questions')), 'en');
  assert.equal(noteLanguageFromBody(`${body('zh-TW', 'detail.update_log')}\n\n${body('en', 'detail.update_log')}`), undefined, 'mixed spellings: no verdict');
  assert.equal(noteLanguageFromBody('Plain text without headings'), undefined);
  assert.equal(noteLanguageFromBody('## Something else\n\ntext'), undefined);
  assert.equal(noteLanguageFromBody(undefined), undefined);
  assert.equal(noteLanguageFromBody(`  ### ${heading('en', 'detail.core_conclusions')} ###`.trim()), 'en');
  assert.equal(content.existingNoteLanguage({ contentLanguage: 'en', detail: body('zh-TW', 'detail.core_conclusions') }), 'en', 'content-language wins');
  assert.equal(content.existingNoteLanguage({ detail: body('zh-TW', 'detail.core_conclusions') }), 'zh-TW');
  assert.equal(content.existingNoteLanguage({ detail: '' }), undefined);
  // A 0.24 Traditional Chinese note on a Japanese card keeps Traditional Chinese on rerun (the guard of the dialog default).
  const existing = content.existingNoteLanguage({ detail: body('zh-TW', 'detail.core_conclusions') });
  assert.equal(defaultOutputLanguage('zh-TW', '東京ラーメンの旅', existing), 'zh-TW');
  assert.equal(defaultOutputLanguage('en', '東京ラーメンの旅', content.existingNoteLanguage({ detail: body('en', 'detail.core_conclusions') })), 'ja');
});

test('output languages: an English topic with function words is the en path; one without keeps the anchored follow-input clause (D-2026-10-90, D-2026-10-94)', async () => {
  const task = title => ({ title, summary: 'S', rules: '', detail: '', task: `Research ${title}`, ancestors: '', mode: 'task', researchMode: 'local', researchDepth: 'normal', visualMode: 'off' });
  // Function words and no foreign function word: detected as English, so the prompt is exactly the explicit-en prompt.
  const plain = task('How to plan a 5-day Taipei trip');
  assert.equal(chooseAimContentLanguage('zh-TW', plain.title), 'en');
  const detectedEn = (await promptsFor({ ...plain, outputLanguage: chooseAimContentLanguage('en', plain.title) }, { language: 'en' }))[0].prompt;
  const explicitEn = (await promptsFor({ ...plain, outputLanguage: 'en' }, { language: 'en' }))[0].prompt;
  assert.equal(normalizeText(detectedEn), normalizeText(explicitEn));
  assert.doesNotMatch(detectedEn, /the language in which the user's/);
  // No function word either way: the model follows the quoted text.
  const bare = task('Plan a 5-day Taipei trip');
  assert.equal(chooseAimContentLanguage('en', bare.title), 'same-as-input');
  const en = (await promptsFor({ ...bare, outputLanguage: 'en' }, { language: 'en' }))[0].prompt;
  const follow = (await promptsFor({ ...bare, outputLanguage: chooseAimContentLanguage('en', bare.title) }, { language: 'en' }))[0].prompt;
  assert.notEqual(normalizeText(follow), normalizeText(en), 'the runtime prompt of such a topic changed: the anchored clause replaces the language name');
  assertReduces('english topic', follow, en, undefined, followFlavour('topic', bare.title));
  assert.equal(i18n.noteLanguageOf('same-as-input'), i18n.noteLanguageOf('en'));
});

test('output languages: plain English is told from other Latin text by function words (D-2026-10-94)', () => {
  const expectEn = ['How do vaccines work', 'Why do cats purr', 'Do you need a VPN', 'Smith et al. 2020 review of the evidence', 'History of Los Angeles', 'MIT courses for beginners', 'How to come up with ideas', 'The Da Vinci Code analysis', 'Visit the Des Moines zoo', 'Non-profit management for the arts', 'Why cells die', 'How to plan a trip', 'What is the best way to learn', 'Why are bridges built with arches', 'The history of Rome', 'My notes from this trip', 'Plan for the week'];
  for (const text of expectEn) assert.equal(detectAimContentLanguage(text), 'en', text);
  const expectFollow = [
    'Ancient Egypt', // no function word either way
    'Historia de Roma', // Spanish function word
    'Histoire de la Révolution française', // accents and French function words
    'La vie en rose', // French function words
    'The history of el Camino', // mixed: a foreign function word wins
    'Der Weg of the Samurai', 'Wat is the best', 'Plan para the trip', // foreign word beside an English one
    'Café and the city', // an accent: not plain ASCII, so not decided by word lists
    'Notes on ラーメン shops', // the kana rule says no (too many Latin words); non-ASCII, so no English
    'Что is the', 'a in no', 'on an as' // other script; shared words are in neither list
  ];
  for (const text of expectFollow) assert.equal(detectAimContentLanguage(text), 'same-as-input', text);
  // Digits, punctuation and spaces around ASCII letters do not matter; the rest of the priority order is unchanged.
  assert.equal(detectAimContentLanguage('  How-to: 5 steps for 2026!  '), 'en');
  assert.equal(detectAimContentLanguage('東京の旅 and the food'), 'zh-TW', 'Han text outweighing Latin words stays Chinese');
  assert.equal(detectAimContentLanguage('🍜 123'), undefined);
  // Every word list entry is a lower-case ASCII word, the two lists never overlap, and shared words are in neither.
  const { LATIN_TEXT_DETECTION: data } = load('i18n/languages.ts');
  for (const word of [...data.words, ...data.foreign]) assert.match(word, /^[a-z]+$/, word);
  assert.equal(data.words.filter(word => data.foreign.includes(word)).length, 0);
  for (const word of ['a', 'in', 'no', 'on', 'an', 'as', 'at', 'per', 'plus', 'par', 'van', 'met', 'op', 'was', 'am', 'den']) assert.ok(!data.words.includes(word) && !data.foreign.includes(word), `${word} is shared and listed nowhere`);
});

test('output languages: the menu offers the follow-input row first, then registry languages, then an optgroup of output-only languages', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'experiences/visual-map/modals.ts'), 'utf8');
  assert.match(source, /languageSelect\.createEl\("option", \{ value: FOLLOW_INPUT_ID, text: supportedLanguageLabel\(FOLLOW_INPUT_ID\) \}\)/);
  assert.match(source, /for \(const option of SUPPORTED_LANGUAGES\)\s+languageSelect\.createEl\("option"/);
  assert.match(source, /createEl\("optgroup", \{ attr: \{ label: t\("ui\.output_language_more"\) \} \}\)/);
  assert.match(source, /for \(const option of OUTPUT_LANGUAGE_CHOICES\)\s+moreLanguages\.createEl\("option"/);
  assert.ok(source.indexOf('FOLLOW_INPUT_ID, text') < source.indexOf('SUPPORTED_LANGUAGES)'));
  assert.ok(source.indexOf('SUPPORTED_LANGUAGES)') < source.indexOf('OUTPUT_LANGUAGE_CHOICES)'));
  assert.deepEqual([...i18n.OUTPUT_LANGUAGE_CHOICES.map(item => item.id)], [...OUTPUT_LANGUAGES.filter(item => !item.followsInput).map(item => item.id)]);
  for (const id of ['en', 'zh-TW', 'zh-CN']) assert.ok(i18n.translate(id, 'ui.output_language_more').length > 0);
  assert.equal(i18n.supportedLanguageLabel('same-as-input'), i18n.translate(i18n.getUiLanguage(), 'ui.output_language_follow_input'), 'the summary row names it in the interface language');
  const settings = fs.readFileSync(path.join(__dirname, '..', 'ui/settings-tab.ts'), 'utf8');
  assert.equal(settings.includes('OUTPUT_LANGUAGE'), false, 'the interface-language menu does not list output-only languages');
  assert.equal(settings.includes('FOLLOW_INPUT'), false);
  // The AIM start dialog has the same menu and sends the language only when it was picked by hand.
  const start = fs.readFileSync(path.join(__dirname, '..', 'ui/modals/aim-start-modal.ts'), 'utf8');
  assert.match(start, /FOLLOW_INPUT_ID, text: supportedLanguageLabel\(FOLLOW_INPUT_ID\)/);
  assert.match(start, /for \(const option of OUTPUT_LANGUAGE_CHOICES\)/);
  assert.match(start, /\.\.\.\(languagePicked \? \{ outputLanguage: language\.value as ContentLanguage \} : \{\}\)/);
  assert.match(start, /chooseAimContentLanguage\(getUiLanguage\(\), topic\.value, context\.value\)/);
});

test('output languages: a manual choice in the task menu is saved on the map when a run starts, from the dialog and the selection dialog', () => {
  const modals = fs.readFileSync(path.join(__dirname, '..', 'experiences/visual-map/modals.ts'), 'utf8');
  assert.match(modals, /this\.manualOutputLanguage = languageSelect\.value as ContentLanguage/);
  assert.match(modals, /this\.info\?\.rememberOutputLanguage/);
  assert.match(modals, /defaultOutputLanguage\(\s*this\.plugin\.settings\.language,\s*this\.topic,\s*this\.modelSettings\?\.contentLanguage,\s*this\.info\?\.outputLanguage\s*\)/);
  const view = fs.readFileSync(path.join(__dirname, '..', 'experiences/visual-map/view.ts'), 'utf8');
  assert.equal((view.match(/\.\.\.this\.outputLanguageMemory\(\)/g) ?? []).length, 2, 'topic dialog and selection synthesis dialog');
  assert.match(view, /map\.outputLanguage = language/);
  assert.match(view, /contentLanguage: existingNoteLanguage\(note\)/);
  for (const call of ['request.topic', 'rootQuestion']) assert.ok(view.includes(`outputLanguageForMap(this.map, settings.language, ${call})`), `map-level run: ${call}`);
});

test('output languages: the Markdown selection AI is wired to the selected text', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.ts'), 'utf8');
  assert.match(main, /selectionOutputLanguage\(this\.settings\.language, selected\)/);
  const panel = fs.readFileSync(path.join(__dirname, '..', 'experiences/markdown-context/selection-ai.ts'), 'utf8');
  assert.match(panel, /this\.options\.language\(snapshot\.text\)/);
  // Translate reads the target language, so it gets the interface language, never the follow-the-text clause.
  assert.match(main, /translateTarget: \(\) => languagePromptName\(this\.settings\.language, "en", "plain"\)/);
  assert.match(panel, /translatePresetStep\.render\(\{ language, target: this\.translateTarget \}\)/);
});

test('output languages: no existing prompt snapshot changed (the new languages add none)', () => {
  const directory = path.join(__dirname, 'snapshots', 'prompts');
  const names = fs.readdirSync(directory);
  for (const entry of OUTPUT_LANGUAGES) assert.equal(names.some(name => new RegExp(`\\.${entry.id}(\\.\\d+)?\\.(txt|schema\\.json)$`).test(name)), false, entry.id);
});

test('output languages: the single-card task line and the selection AI use the resolved output language and the selected text (D-2026-10-94)', () => {
  const view = fs.readFileSync(path.join(__dirname, '..', 'experiences/visual-map/view.ts'), 'utf8');
  // Single card (B2): the dialog's language, else the map's, never the interface language (the batch path reads the same way).
  assert.match(view, /const taskLanguage =\s+options\.outputLanguage \?\? outputLanguageForMap\(this\.map, this\.plugin\.settings\.language, latest\.title\);\s+const task = researchTopicTask\(taskLanguage, latest\.title\);/);
  assert.equal(view.includes('researchTopicTask(this.plugin.settings.language'), false);
  // The "no conclusion yet" summary placeholder of the synthesis prompts is written in the output language's note language.
  assert.match(view, /summary: translateNote\(runOptions\.outputLanguage \?\? language, "note\.no_conclusion_yet"\)/);
  assert.match(view, /summary: translateNote\(options\?\.outputLanguage \?\? language, "note\.no_conclusion_yet"\)/);
  // Selection AI: the follow-the-text clause quotes the selection.
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.ts'), 'utf8');
  assert.match(main, /kind: "selection",\s+text: selected/);
  assert.equal(i18n.languagePromptName(selectionOutputLanguage('en', 'Texto sin acentos'), 'en', 'plain', { kind: 'selection', text: 'Texto sin acentos' }), anchoredEn('selected text', 'Texto sin acentos'));
});

test('the Chinese follow-the-input clause keeps the user\'s own 「」 from closing its quote (D-2026-10-95)', () => {
  const text = i18n.languagePromptName('same-as-input', 'zh', 'plain', { kind: 'topic', text: '他說「好」' });
  assert.ok(text.includes('「他說『好』」'), text);
});

// 0.28 ticket 06: the kana rule also needs a kana share, and links and code are not the user's own words.
const T06_HEAD = "幫我依照以下chaptgpt 的回應產生一個心智圖:\n\n# 一、先講結論：v0.2 最大的問題，不是缺少原則，而是缺少取捨的判斷系統\n";
const T06_JA_LINK = "[『push me pull you』澄 敬一 作品集 : くうろときろ                   essentials    ｜   古   ｜  周辺  ｜   栃木  ｜   茂呂　MORO  ｜ 古道具 ｜古物｜骨董｜プロダクト｜書籍｜アート](https://images.openai.com/static-rsc-4/eQcwB79?purpose=inline)\n";
const T06_RU_LINK = "[Morning Reading Nook with Oak Chair & Travertine Table в 2025 г | Уголок для чтения, Уютный уголок, Нордический стиль](https://images.openai.com/static-rsc-4/SX3B?purpose=inline)\n";
const T06_BODY = "你目前的文件是一份有明確價值觀的「產品哲學」，但還不是一套成熟的「個人品味系統」。\n".repeat(120);

test('ticket 06: Chinese text with a little Japanese (link titles, quoted words, ー dashes) is not Japanese', () => {
  for (const ui of ['zh-TW', 'en']) {
    assert.equal(chooseAimContentLanguage(ui, T06_HEAD + T06_BODY + T06_RU_LINK), 'zh-TW', '原文去掉日文連結');
    assert.equal(chooseAimContentLanguage(ui, T06_HEAD + T06_BODY + T06_JA_LINK + T06_RU_LINK), 'zh-TW', '原文含日文連結');
    assert.equal(chooseAimContentLanguage(ui, '幫我依照以下回應產生心智圖：\n品味系統的五個盲點。\n[作品集 : くうろときろ](https://example.com/a.png)'), 'zh-TW', '最小重現');
    assert.equal(chooseAimContentLanguage(ui, '品味系統需要審美判斷。アート'), 'zh-TW', '最小重現(只有アート)');
    assert.equal(chooseAimContentLanguage(ui, '品味系統 ー 從價值清單到判斷規則ー三層結構'), 'zh-TW');
    assert.equal(chooseAimContentLanguage(ui, '這個介面設計參考侘寂（わびさび）與留白的美學'), 'zh-TW');
    assert.equal(chooseAimContentLanguage(ui, '台灣の旅：VAM 的品味系統'), 'zh-TW');
    assert.equal(chooseAimContentLanguage(ui, '形・色・節奏・質感・動態'), 'zh-TW');
  }
  const long = '這是一段關於產品設計與個人判斷系統的長文，內容反覆討論取捨與原則。'.repeat(100) + 'シンプル';
  assert.ok(long.length > 2000);
  assert.equal(chooseAimContentLanguage('zh-TW', long), 'zh-TW', 'long Chinese ending with one katakana word');
  assert.equal(detectAimContentLanguage('品味系統需要審美判斷。アート'), 'zh-TW');
});

test('ticket 06: real Japanese stays Japanese, also with many Han characters or a long paragraph', () => {
  const samples = [
    '日本銀行が金融政策を変更した', '東京ラーメンの旅', '今日は天気がいいので公園に行きます', '政府は新しい経済対策を発表した',
    '私は毎朝コーヒーを飲みます', 'この映画はとても面白かったです', '来週の会議の資料を準備してください', '京都の紅葉を見に行きたい',
    '新幹線で大阪まで行く', '日本語です Plan', '東京ラメン A B', 'ラメン'
  ];
  for (const text of samples) {
    assert.equal(detectAimContentLanguage(text), 'ja', text);
    assert.equal(chooseAimContentLanguage('zh-TW', text), 'ja', text);
  }
  const paragraph = '日本の経済は長い間、低成長とデフレに悩まされてきました。しかし最近では、賃金の上昇や企業の投資拡大により、少しずつ明るい兆しが見え始めています。専門家は、今後の金融政策の動向が景気の回復に大きな影響を与えると指摘しています。一方で、物価の上昇が家計に与える負担も無視できません。政府は支援策を検討しており、国民の生活を守るための対応が求められています。さらに、地方の中小企業では人手不足が深刻になっており、働き方の見直しや新しい技術の導入が急がれています。';
  assert.ok(paragraph.length >= 200);
  assert.equal(chooseAimContentLanguage('zh-TW', paragraph), 'ja');
});

test('ticket 06: links, images, URLs and code are not counted; a lone Japanese link still is', () => {
  assert.equal(chooseAimContentLanguage('zh-TW', '品味系統的五個盲點。`こんにちはさようなら` 是範例'), 'zh-TW', 'inline code');
  assert.equal(chooseAimContentLanguage('zh-TW', '品味系統的五個盲點。\n```\nこんにちは さようなら ラーメン\n```\n以上是範例'), 'zh-TW', 'fenced code');
  assert.equal(chooseAimContentLanguage('zh-TW', '品味系統的五個盲點。\n~~~\nこんにちは さようなら ラーメン\n~~~\n以上是範例'), 'zh-TW', 'tilde fence');
  assert.equal(chooseAimContentLanguage('zh-TW', '品味系統的五個盲點。![ラーメンの写真](https://x.jp/a.png)'), 'zh-TW', 'image');
  assert.equal(chooseAimContentLanguage('zh-TW', '品味系統。https://example.com/the-best-guide-for-the-trip'), 'zh-TW', 'bare URL: its Latin words are not counted');
  assert.equal(chooseAimContentLanguage('zh-TW', 'アート https://x.jp品味系統需要審美判斷系統的說明與更多的中文內容'), 'zh-TW', 'bare URL: Chinese right after it is kept');
  assert.equal(chooseAimContentLanguage('zh-TW', '[東京ラーメンガイド](https://x.jp)'), 'ja', 'only a Japanese link: no letters left, the original text decides');
  assert.equal(detectAimContentLanguage('[東京ラーメンガイド](https://x.jp)'), 'ja');
  // An unclosed fence does not swallow the rest of the text.
  assert.equal(chooseAimContentLanguage('zh-TW', '品味系統的五個盲點。\n```\nconst a = 1;\n這是後面的中文內容，很長很長很長'), 'zh-TW', 'unclosed fence, Chinese after it');
  assert.equal(chooseAimContentLanguage('zh-TW', '```\nconst a = 1;\n東京ラーメンの旅に行きます。日本語を勉強しています'), 'ja', 'unclosed fence, Japanese after it');
  // Wiki links keep their text.
  assert.equal(chooseAimContentLanguage('zh-TW', '[[東京ラーメンガイド]]'), 'ja');
});
