// Note style recipe (note-style-recipe T2, P1): the pure model in ai/note-style-recipe.ts, the built-in format rules apart from
// the structures, the conclusion structure, the format zone that is noted and not read, and the assembler's format position.
// Unit level. P1 is the pure model; P2a (below the marker line) is the store's resolution over an in-memory vault; later packets add
// the settings and the call sites to this file.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadSource } = require('./support-replay.cjs');

const M = loadSource(`
export * from "./ai/note-style-recipe";
export { BUILTIN_BLOCKS, BUILTIN_FORMATS, lookupBuiltinFormat, builtinTemplateText } from "./core/blocks/builtin";
export { parseTemplateBlock, splitTemplateZones, templateFormatHeading } from "./core/blocks/template-block";
export { assembleTaskPrompt, selectionFromContext, promptStepOf, chartsWanted } from "./core/steps/task/assemble";
export { OBSIDIAN_FORMAT, inLanguage } from "./core/steps/_shared/fragments";
export { translate } from "./i18n";
export { NoteStyleStore } from "./ai/note-style-store";
export { normalizeTemplates, standardTemplate, textbookTemplate } from "./ai/detail-templates";
export { resolveToneText } from "./ai/prompt-presets";
export { readTopicKind, TOPIC_KINDS } from "./note-values";
`);

const LANGUAGES = ['zh-TW', 'zh-CN', 'en'];
const base = { title: 'Topic T', summary: 'Current summary S', rules: 'Rule R', detail: 'Existing detail D', task: 'Do task X', ancestors: 'Ancestor A', workingFindings: 'Older finding F', sourceContext: 'Source [S1]: fact', mode: 'task', researchMode: 'research', researchDepth: 'normal', visualMode: 'auto' };
const contextOf = language => ({ ...base, outputLanguage: language });
const plain = value => JSON.parse(JSON.stringify(value));
const standardFormat = language => M.inLanguage(M.OBSIDIAN_FORMAT, language);
const assemble = (selection, language, step = 'research') => M.assembleTaskPrompt(selection, step, contextOf(language), language);
const withFormat = (language, format, template) => ({ ...M.selectionFromContext(contextOf(language), language), ...(template ? { template } : {}), ...(format ? { format } : {}) });

// ---- the model's constants ----
test('recipe: the kind defaults and the eight built-in recipes follow design 3.2', () => {
  assert.deepEqual(plain(M.KIND_DEFAULT_RECIPE), { topic: 'builtin:general', atomic: 'builtin:atomic', hypothesis: 'builtin:hypothesis', evidence: 'builtin:evidence', conclusion: 'builtin:conclusion', action: 'builtin:action', aim: 'builtin:aim' });
  assert.equal(M.BUILTIN_RECIPES.map(recipe => recipe.id).join(), 'general,atomic,hypothesis,evidence,conclusion,action,aim,textbook');
  for (const [kind, ref] of Object.entries(M.KIND_DEFAULT_RECIPE)) assert.ok(M.BUILTIN_RECIPES.some(recipe => `builtin:${recipe.id}` === ref), kind);
  const row = id => plain(M.BUILTIN_RECIPES.find(recipe => recipe.id === id));
  for (const recipe of M.BUILTIN_RECIPES) {
    assert.equal(recipe.voice, 'academic', recipe.id);
    // note-style-editorial: atomic and evidence are short cards (lean); every type rewrites (hypothesis too, no longer "new on top").
    assert.equal(recipe.format, recipe.id === 'atomic' || recipe.id === 'evidence' ? 'lean' : 'standard', recipe.id);
    assert.equal(recipe.update, 'merge', recipe.id);
  }
  assert.equal(row('general').structure, 'standard');
  assert.equal(row('textbook').structure, 'textbook');
  assert.equal(row('aim').structure, 'aim-delivery');
  for (const id of ['atomic', 'hypothesis', 'evidence', 'conclusion', 'action']) assert.equal(row(id).structure, id);
  // Every named structure, voice and format of a recipe exists as a built-in part (the AIM structure is the one exception).
  for (const recipe of M.BUILTIN_RECIPES) {
    if (recipe.structure !== 'aim-delivery') assert.ok(M.BUILTIN_BLOCKS.some(block => block.category === 'template' && block.id === recipe.structure), recipe.id);
    assert.ok(M.BUILTIN_BLOCKS.some(block => block.category === 'tone' && block.id === recipe.voice), recipe.id);
    assert.ok(M.BUILTIN_FORMATS.some(format => format.id === recipe.format), recipe.id);
  }
});

test('recipe: every recipe, structure, format and update mode has a name in three languages, the recipe names as in design 3.2', () => {
  const names = {
    'zh-TW': ['一般研究', '原子知識', '假設檢驗', '證據紀錄', '結論', '行動計畫', 'AIM 報告', '教科書'],
    en: ['General research', 'Atomic note', 'Hypothesis test', 'Evidence record', 'Conclusion', 'Action plan', 'AIM report', 'Textbook'],
    'zh-CN': ['一般研究', '原子知识', '假设检验', '证据记录', '结论', '行动计划', 'AIM 报告', '教科书']
  };
  for (const language of LANGUAGES) {
    assert.deepEqual(plain(M.BUILTIN_RECIPES.map(recipe => M.translate(language, recipe.nameKey))), names[language], language);
    for (const block of M.BUILTIN_BLOCKS) assert.ok(M.translate(language, block.nameKey).length > 0, `${block.id} ${language}`);
    for (const format of M.BUILTIN_FORMATS) assert.ok(M.translate(language, format.nameKey).length > 0, `${format.id} ${language}`);
    for (const mode of M.UPDATE_MODES) assert.ok(M.translate(language, M.UPDATE_MODE_KEYS[mode]).length > 0, `${mode} ${language}`);
  }
  assert.deepEqual(plain(M.UPDATE_MODES.map(mode => M.translate('zh-TW', M.UPDATE_MODE_KEYS[mode]))), ['整合改寫', '新的放上面', '只存新內容']);
});

// ---- names and references ----
test('counter 3: validatePartName rejects separators, dots, padding, empty names and the built-in names of the category in any language and case', () => {
  for (const name of ['a/b', 'a\\b', '..', '../x', 'x/..', ' x', 'x ', '']) for (const category of ['structure', 'voice', 'format', 'recipe'])
    assert.equal(M.validatePartName(name, category).ok, false, JSON.stringify(name));
  const builtin = {
    structure: ['標準六段', 'Standard six', '标准六段', 'standard SIX', '結論與依據', '导读加六段'],
    voice: ['學術嚴謹', 'Academic rigor', '学术严谨'],
    format: ['標準格式', 'Standard format', '标准格式', 'LEAN format', '精简格式', '豐富格式'],
    recipe: ['一般研究', 'General research', '原子知识', 'general RESEARCH', 'AIM 報告', 'aim report']
  };
  for (const [category, list] of Object.entries(builtin)) for (const name of list) {
    const got = M.validatePartName(name, category);
    assert.equal(got.ok, false, `${category} ${name}`);
    assert.ok(got.reason, `${category} ${name}`);
  }
  // A name that is another category's built-in name is fine here.
  assert.equal(M.validatePartName('標準格式', 'structure').ok, true);
  assert.equal(M.validatePartName('我的風格', 'recipe').ok, true);
  assert.equal(M.validatePartName('Mine (2)', 'format').ok, true);
});

test('recipe: parseRecipeRef reads builtin:<id> and file:<name> only, and the name has to pass the name rules', () => {
  assert.deepEqual(plain(M.parseRecipeRef('builtin:general')), { kind: 'builtin', id: 'general' });
  assert.deepEqual(plain(M.parseRecipeRef('file:我的風格')), { kind: 'file', name: '我的風格' });
  for (const bad of ['file:a/b', 'file:a\\b', 'file:..', 'file: x', 'file:x ', 'file:', 'builtin:', 'file:一般研究', 'file:General research', 'style:Mine', 'Mine', '', undefined, null, 5, {}])
    assert.equal(M.parseRecipeRef(bad), undefined, JSON.stringify(bad));
  assert.deepEqual(plain(M.parseRecipeRef('file:標準六段', 'format')), { kind: 'file', name: '標準六段' });
  assert.equal(M.parseRecipeRef('file:標準六段', 'structure'), undefined);
});

// ---- note-style-editorial K2: renamed voices, shared baseline ----
const OLD_VOICE_NAMES = [
  ['academic', ['學術嚴謹', '学术严谨', 'Academic rigor']],
  ['magazine', ['雜誌專欄', '杂志专栏', 'Magazine column']]
];
const NEW_VOICE_NAMES = [
  ['academic', ['專業', '专业', 'Professional']],
  ['magazine', ['敘事', '叙事', 'Narrative']]
];
test('K2 counter: the old voice names (three languages) still resolve to academic and magazine, stay reserved, and the new names do too', () => {
  for (const [id, names] of [...OLD_VOICE_NAMES, ...NEW_VOICE_NAMES])
    for (const name of names) {
      assert.equal(M.builtinPartIdOf('voice', name), id, name);
      assert.deepEqual(plain(M.validatePartName(name, 'voice')), { ok: false, reason: 'builtin' }, name);
      assert.equal(M.parseRecipeFile(`---\n寫作口吻: ${name}\n---\n`).voice, `builtin:${id}`, name);
    }
  assert.equal(M.translate('zh-TW', 'ui.preset_name_academic'), '專業');
  assert.equal(M.translate('zh-TW', 'ui.preset_name_magazine'), '敘事');
});

test('K2 counter: the shared writing baseline follows the voice in a topic prompt; the Taiwan wording rule is in zh-TW output only', () => {
  const TAIWAN = '台灣用語';
  for (const step of ['research', 'quick', 'merge']) {
    const zhTW = assemble(M.selectionFromContext(contextOf('zh-TW'), 'zh-TW'), 'zh-TW', step);
    const zhCN = assemble(M.selectionFromContext(contextOf('zh-CN'), 'zh-CN'), 'zh-CN', step);
    const en = assemble(M.selectionFromContext(contextOf('en'), 'en'), 'en', step);
    const text = result => (typeof result === 'string' ? result : result.prompt ?? result.text ?? JSON.stringify(result));
    assert.match(text(zhTW), /首先/, step);
    assert.ok(text(zhTW).includes(TAIWAN), step);
    assert.match(text(zhCN), /首先/, step);
    assert.ok(!text(zhCN).includes(TAIWAN), `${step} zh-CN has no Taiwan wording rule`);
    assert.match(text(en), /First/, step);
    assert.ok(!text(en).includes(TAIWAN), step);
  }
  // the baseline comes after the voice text
  const withTone = M.assembleTaskPrompt({ ...M.selectionFromContext(contextOf('en'), 'en'), tone: { id: 'custom-legacy', body: 'Tone: VOICE-MARK.' } }, 'research', { ...contextOf('en'), toneText: 'Tone: VOICE-MARK.' }, 'en');
  const flat = typeof withTone === 'string' ? withTone : withTone.prompt ?? withTone.text ?? JSON.stringify(withTone);
  assert.ok(flat.indexOf('VOICE-MARK') > -1 && flat.indexOf('VOICE-MARK') < flat.indexOf('First'));
});

// ---- recipe files ----
test('recipe: parseRecipeFile reads the four keys in any of the three languages, parts by name or by built-in name', () => {
  const zh = M.parseRecipeFile('---\n段落結構: 導讀加六段\n寫作口吻: 白話說明\n格式規則: 豐富格式\n更新方式: 新的放上面\n---\n這是我的風格。\n\n第二段。\n');
  assert.equal(zh.structure, 'builtin:textbook');
  assert.equal(zh.format, 'builtin:rich');
  assert.equal(zh.update, 'top');
  assert.equal(zh.description, '這是我的風格。');
  assert.equal(zh.issues.length, 0);
  assert.deepEqual(plain(zh.lines), { structure: 2, voice: 3, format: 4, update: 5 });
  const en = M.parseRecipeFile('---\nstructure: My sections\nvoice: Academic rigor\nformat: lean format\nupdate: fresh\n---\n');
  assert.equal(en.structure, 'file:My sections');
  assert.equal(en.voice, 'builtin:academic');
  assert.equal(en.format, 'builtin:lean');
  assert.equal(en.update, 'fresh');
  const cn = M.parseRecipeFile('---\n段落结构: 标准六段\n写作口吻: 我的口吻\n格式规则: 精简格式\n更新方式: 整合改写\n---\n');
  assert.deepEqual([cn.structure, cn.voice, cn.format, cn.update], ['builtin:standard', 'file:我的口吻', 'builtin:lean', 'merge']);
  for (const [value, mode] of [['merge', 'merge'], ['top', 'top'], ['FRESH', 'fresh'], ['Merge and rewrite', 'merge'], ['New on top', 'top'], ['只存新内容', 'fresh'], ['"新的放上面"', 'top']])
    assert.equal(M.parseRecipeFile(`---\nupdate: ${value}\n---\n`).update, mode, value);
});

test('recipe: a missing key is the general research part, an unknown key is ignored, and a text with no frontmatter reads as the general recipe', () => {
  for (const text of ['---\n未知的鍵: x\n---\n', '', 'Only a description.\n', '---\n格式規則: 精簡格式\n---\n']) {
    const got = M.parseRecipeFile(text);
    assert.equal(got.structure, 'builtin:standard');
    assert.equal(got.voice, 'builtin:academic');
    assert.equal(got.update, 'merge');
    assert.equal(got.issues.length, 0);
  }
  assert.equal(M.parseRecipeFile('---\n格式規則: 精簡格式\n---\n').format, 'builtin:lean');
  assert.equal(M.parseRecipeFile('Only a description.\n').description, 'Only a description.');
});

test('counter 5 (recipe part): an update mode that is not one of the three is an issue with its line and reads as merge; nothing throws', () => {
  const got = M.parseRecipeFile('---\n段落結構: 標準六段\n更新方式: 隨便\n---\n');
  assert.equal(got.update, 'merge');
  assert.equal(got.issues.length, 1);
  assert.equal(got.issues[0].line, 3);
  assert.equal(got.issues[0].code, 'update_invalid');
  // an unclosed frontmatter and a part name that cannot be a file name are issues too, each with its line
  const open = M.parseRecipeFile('---\n段落結構: 標準六段\n');
  assert.equal(open.issues[0].code, 'frontmatter_unclosed');
  assert.equal(open.issues[0].line, 1);
  const bad = M.parseRecipeFile('---\n寫作口吻: a/b\n---\n');
  assert.equal(bad.voice, 'builtin:academic');
  assert.equal(bad.issues[0].line, 2);
  assert.equal(bad.issues[0].code, 'part_name_invalid');
});

// ---- format rules ----
test('counter 10: the standard format is byte-equal to the Obsidian format fragment in en, zh-TW and zh-CN', () => {
  for (const language of LANGUAGES) {
    assert.equal(M.lookupBuiltinFormat('standard', language), standardFormat(language), language);
    assert.ok(standardFormat(language).includes('```mermaid'), language);
  }
  assert.throws(() => M.lookupBuiltinFormat('nope', 'en'), /Unknown built-in format/);
});

test('counter 10: the standard format at its place is the prompt of today, and a missing format choice is the same prompt', () => {
  for (const language of LANGUAGES) for (const step of ['research', 'synthesize']) {
    const context = { ...contextOf(language), ...(step === 'synthesize' ? { mode: 'synthesize' } : {}) };
    const none = M.assembleTaskPrompt(M.selectionFromContext(context, language), M.promptStepOf(context), context, language);
    const named = M.assembleTaskPrompt({ ...M.selectionFromContext(context, language), format: { id: 'standard' } }, M.promptStepOf(context), context, language);
    assert.equal(named.text, none.text, `${language} ${step}`);
    assert.ok(none.text.includes(standardFormat(language)), `${language} ${step}: the fragment is in the prompt as it is`);
    assert.equal(JSON.stringify(named.segments), JSON.stringify(none.segments), `${language} ${step}`);
  }
});

test('counter 10: the rich format starts with the standard text and adds a part that keeps the diagram and HTML safety rules', () => {
  for (const language of LANGUAGES) {
    const rich = M.lookupBuiltinFormat('rich', language);
    const standard = standardFormat(language);
    assert.ok(rich.startsWith(standard), language);
    const extra = rich.slice(standard.length);
    assert.ok(extra.length > 200, language);
    assert.equal(extra.includes('```'), false, 'the added part draws nothing and fences nothing');
    const zh = language !== 'en';
    assert.ok(extra.includes(zh ? '規則 3、5、10 照舊' : 'Rules 3, 5 and 10 stay as they are'), language);
    assert.ok(extra.includes(zh ? '形態沒有對應的語法時，就寫一般段落' : "when no syntax fits the content's shape, write a plain paragraph"), `${language}: it names the rule it takes precedence over`);
    assert.ok(extra.includes(zh ? '規則 2 的上限照舊' : 'The cap in rule 2 stays'), language);
  }
});

test('counter 10: the lean format has no mermaid, no callout instruction, and the word-for-word rules 4, 6, 7, 8, 9 and the ban of rule 5', () => {
  for (const language of LANGUAGES) {
    const lean = M.lookupBuiltinFormat('lean', language);
    const standard = standardFormat(language);
    assert.equal(/mermaid/i.test(lean), false, language);
    assert.equal(/\[![a-z]+\]/.test(lean), false, `${language}: no callout type is offered`);
    // It names what it does not use only as a ban: the list of what it offers holds headings, bullets and tables.
    assert.ok(/(?:不要使用|never use) callout/.test(lean) || /never use callouts/.test(lean), `${language}: the ban of callouts, charts, highlights and task lists`);
    const rule = number => {
      const line = standard.split('\n').find(item => item.startsWith(`${number}. `));
      assert.ok(line, `rule ${number}`);
      return line.slice(`${number}. `.length);
    };
    for (const number of [4, 6, 7, 8, 9]) assert.ok(lean.includes(rule(number)), `${language}: rule ${number} word for word`);
    const five = rule(5);
    const ban = five.slice(five.indexOf(language === 'en' ? 'never use <iframe>' : '不要用 <iframe>'));
    assert.ok(ban.includes('on…') && ban.includes(':::'), ban);
    assert.ok(lean.includes(ban), `${language}: the ban of rule 5 word for word`);
    assert.equal(lean.includes('<details>'), false, language);
  }
});

test('counter 10: with the lean format charts are never wanted, even when the sections hold a mermaid block; standard and rich still want them', () => {
  const sections = '## 流程\n畫一張流程圖：\n```mermaid\nflowchart TD\n  A --> B\n```\n';
  for (const language of LANGUAGES) {
    const context = contextOf(language);
    const select = format => withFormat(language, format, { id: 'file:Own', body: sections });
    assert.equal(M.chartsWanted(select(undefined), context, language), true, language);
    assert.equal(M.chartsWanted(select({ id: 'standard' }), context, language), true, language);
    assert.equal(M.chartsWanted(select({ id: 'rich' }), context, language), true, language);
    assert.equal(M.chartsWanted(select({ id: 'lean' }), context, language), false, language);
    assert.equal(assemble(select({ id: 'lean' }), language).charts, false, language);
    assert.equal(assemble(select({ id: 'rich' }), language).charts, true, language);
    // a format rules file that merely has the id "lean" is a file, not the built-in
    assert.equal(M.chartsWanted(select({ id: 'lean', body: 'Own rules.' }), context, language), true, language);
    // the lean text itself is in the prompt, the standard text is not
    const lean = assemble(select({ id: 'lean' }), language).text;
    assert.ok(lean.includes(M.lookupBuiltinFormat('lean', language)), language);
    assert.equal(lean.includes(standardFormat(language)), false, language);
    // sections without a mermaid block and a mermaid-free format file: no chart
    assert.equal(M.chartsWanted(withFormat(language, { id: 'file:F', body: 'No diagrams here.' }), context, language), false, language);
    assert.equal(M.chartsWanted(withFormat(language, { id: 'file:F', body: 'Draw:\n```mermaid\nflowchart TD\n```' }), context, language), true, language);
  }
});

test('counter 10: a format body loses its blank lines at both ends; an empty or blank body puts no format text and no extra blank line', () => {
  for (const language of LANGUAGES) {
    const padded = assemble(withFormat(language, { id: 'file:F', body: '\n\n  \nRULES-LINE-1\nRULES-LINE-2\n\n \n' }), language);
    assert.ok(padded.text.includes('\nRULES-LINE-1\nRULES-LINE-2\n\n'), language);
    assert.equal(padded.text.includes('\n\n\nRULES-LINE-1'), false, language);
    const format = padded.segments.filter(segment => segment.source.kind === 'block' && segment.source.part === 'format');
    assert.equal(format.length, 1, language);
    assert.equal(format[0].text, 'RULES-LINE-1\nRULES-LINE-2');
    for (const body of ['', '\n\n', ' \n  \n']) {
      const got = assemble(withFormat(language, { id: 'file:E', body }), language);
      assert.equal(got.segments.some(segment => segment.source.kind === 'block' && segment.source.part === 'format'), false, `${language} ${JSON.stringify(body)}`);
      // no two separators in a row (that would be the blank line of a format piece that is not there)
      got.segments.forEach((segment, index) => assert.equal(segment.source.kind === 'separator' && got.segments[index + 1]?.source.kind === 'separator', false, `${language} ${index}`));
      assert.equal(got.text.includes('\n\n\n\n'), false, `${language} ${JSON.stringify(body)}`);
      assert.equal(got.charts, false, language);
    }
    // the merge step keeps its own formatting: no format text, whatever the format choice
    const merge = M.assembleTaskPrompt(withFormat(language, { id: 'rich' }), 'merge', { ...contextOf(language), mode: 'merge' }, language);
    assert.equal(merge.segments.some(segment => segment.source.part === 'format'), false, language);
  }
});

// ---- the conclusion structure ----
test('recipe: the conclusion structure parses in three languages with the log sentence of Standard word for word and one sources section', () => {
  const headings = {
    'zh-TW': ['結論', '信心', '依據', '什麼會改變這個結論', '適用範圍', '影響與下一步', '來源', '更新紀錄'],
    en: ['Conclusion', 'Confidence', 'Basis', 'What would change it', 'Scope', 'Impact and next steps', 'Sources', 'Update log']
  };
  headings['zh-CN'] = headings['zh-TW'];
  for (const language of LANGUAGES) {
    const parsed = M.parseTemplateBlock(M.builtinTemplateText('conclusion', language), { id: 'conclusion', name: 'c' });
    assert.equal(parsed.ok, true, language);
    assert.deepEqual(plain(parsed.template.sections.map(section => section.name)), headings[language], language);
    const standard = M.parseTemplateBlock(M.builtinTemplateText('standard', language), { id: 'standard', name: 's' }).template;
    const log = standard.sections.find(section => section.role === 'log'), conclusionLog = parsed.template.sections.find(section => section.role === 'log');
    assert.equal(conclusionLog.name, log.name, language);
    assert.equal(conclusionLog.description, log.description, language);
    assert.equal(parsed.template.sections.filter(section => section.role === 'sources').length, 1, language);
    for (const section of parsed.template.sections) assert.ok(section.description.trim().length > 0, `${language} ${section.name}`);
    assert.equal(parsed.template.sections.some(section => section.count), false, language);
  }
  assert.equal(M.builtinTemplateText('conclusion', 'zh-CN'), M.builtinTemplateText('conclusion', 'zh-TW'));
});

// ---- an old format zone in a structure text ----
test('counter 11: a format rules zone in a structure text is not read: its text is not in the prompt, the sections are used, a notice names the line, nothing falls back', () => {
  for (const language of LANGUAGES) for (const heading of LANGUAGES.map(name => M.templateFormatHeading(name))) {
    const body = `## Alpha\nDescribe alpha.\n\n## Beta\nDescribe beta.\n\n# ${heading}\n\nZONE-MARKER-RULES\n`;
    const parsed = M.parseTemplateBlock(body, { id: 'file:X', name: 'X' });
    assert.equal(parsed.ok, true, heading);
    assert.deepEqual(plain(parsed.notices), [{ line: 7, code: 'format_zone_moved' }], heading);
    const got = assemble(withFormat(language, undefined, { id: 'file:X', body }), language);
    assert.equal(got.text.includes('ZONE-MARKER-RULES'), false, `${language} ${heading}`);
    assert.ok(got.text.includes('### Alpha') && got.text.includes('Describe beta.'), `${language} ${heading}: the sections are used`);
    assert.equal(got.issues.length, 0, `${language} ${heading}: no fallback`);
    assert.deepEqual(plain(got.notices), [{ line: 7, code: 'format_zone_moved' }], `${language} ${heading}`);
    assert.ok(got.text.includes(standardFormat(language)), `${language} ${heading}: the format is the standard one`);
    // the format part given on its own is used in that place
    const own = assemble(withFormat(language, { id: 'file:F', body: 'OWN-FORMAT' }, { id: 'file:X', body }), language);
    assert.ok(own.text.includes('OWN-FORMAT') && !own.text.includes('ZONE-MARKER-RULES') && !own.text.includes(standardFormat(language)), `${language} ${heading}`);
  }
  // a heading line inside a code fence is no zone; a text with no zone has no notice
  const fenced = M.parseTemplateBlock('## A\n```\n# Format rules\n```\n', { id: 'file:X', name: 'X' });
  assert.equal(fenced.ok, true);
  assert.equal(fenced.notices.length, 0);
  assert.equal(M.parseTemplateBlock('## A\nbody\n', { id: 'file:X', name: 'X' }).notices.length, 0);
});

test('recipe: the built-in structure texts hold no format rules zone, so editing or restoring one never writes the format rules into it', () => {
  for (const block of M.BUILTIN_BLOCKS.filter(item => item.category === 'template')) for (const language of LANGUAGES) {
    const text = M.builtinTemplateText(block.id, language);
    assert.equal(M.splitTemplateZones(text).separatorLines.length, 0, `${block.id} ${language}`);
    assert.equal(text.includes('```mermaid'), false, `${block.id} ${language}`);
    assert.equal(text, block.body(language), `${block.id} ${language}`);
  }
});

// ======== P2a: the store resolves run -> topic -> kind over the four folders ========
const STYLES = 'WS/S';
const DIR = { recipe: `${STYLES}/Styles`, template: `${STYLES}/Structures`, tone: `${STYLES}/Voices`, format: `${STYLES}/Formats`, backup: `${STYLES}/Backups` };
const KINDS7 = ['topic', 'atomic', 'hypothesis', 'evidence', 'conclusion', 'action', 'aim'];
const PRESETS = [{ id: 'custom-tone-1', kind: 'tone', name: 'Pirate', text: 'Talk like a pirate.' }];

function vault(files = {}) {
  const state = { files: { ...files }, writes: [] };
  const under = folder => Object.keys(state.files).filter(file => file.startsWith(`${folder}/`) && !file.slice(folder.length + 1).includes('/'));
  state.port = {
    list: async folder => under(folder).map(file => file.slice(folder.length + 1)).filter(name => name.endsWith('.md')),
    read: async file => { if (!(file in state.files)) throw new Error(file); return state.files[file]; },
    folderExists: folder => Object.keys(state.files).some(file => file.startsWith(`${folder}/`)),
    createFolder: async folder => { state.writes.push(`createFolder ${folder}`); },
    create: async file => { state.writes.push(`create ${file}`); },
    trash: async file => { state.writes.push(`trash ${file}`); }
  };
  return state;
}
async function world(settingsPatch = {}, files = {}) {
  const v = vault(files);
  const settings = { detailTemplates: [], promptPresets: PRESETS, workspaceFolder: 'WS', noteStylesFolder: STYLES, language: 'en', ...settingsPatch };
  const store = new M.NoteStyleStore({ settings: () => settings, port: v.port, save: async () => { v.writes.push('save'); } });
  await store.refresh();
  return { store, v, settings };
}
/** The task prompt a run builds from a runStyle result, as the production call sites put it together. */
function promptOf(style, language, step = 'research') {
  const context = { ...contextOf(language), detailTemplate: style.template, ...(style.toneText ? { toneText: style.toneText } : {}) };
  const selection = style.contextFields.styleSelection ?? M.selectionFromContext(context, language);
  return M.assembleTaskPrompt(selection, step, context, language).text;
}
const baseText = (language, detailTemplate) => {
  const context = { ...contextOf(language), ...(detailTemplate ? { detailTemplate } : {}) };
  return M.assembleTaskPrompt(M.selectionFromContext(context, language), 'research', context, language).text;
};
const summaryOf = style => plain({ ref: style.recipe.ref, source: style.recipe.source, template: style.template, toneText: style.toneText, formatText: style.formatText, updateMode: style.updateMode, contextFields: style.contextFields, issues: style.issues });

test('P2a kinds: the six topic kinds and AIM each resolve to their built-in style (design 3.2): style, structure, voice academic, format standard, update mode', async () => {
  const { store } = await world();
  const structureOf = { topic: 'standard', atomic: 'atomic', hypothesis: 'hypothesis', evidence: 'evidence', conclusion: 'conclusion', action: 'action', aim: 'standard' };
  for (const kind of KINDS7) {
    const got = store.runStyle({ kind, outputLanguage: 'en' });
    const label = kind;
    assert.equal(got.recipe.ref, M.KIND_DEFAULT_RECIPE[kind], label);
    assert.equal(got.recipe.source, 'kind', label);
    assert.equal(got.template.id, structureOf[kind], label);
    assert.equal(got.toneText, undefined, label);
    assert.equal(got.formatText, kind === 'atomic' || kind === 'evidence' ? M.lookupBuiltinFormat('lean', 'en') : standardFormat('en'), label);
    assert.equal(got.updateMode, 'merge', label);
    if (kind === 'atomic' || kind === 'evidence') assert.equal(got.contextFields.styleSelection.format.id, 'lean', label);
    else assert.deepEqual(plain(got.contextFields), {}, label);
    assert.equal(got.recipe.aimDelivery, kind === 'aim' ? true : undefined, label);
    assert.deepEqual(plain(got.issues), { missing: [], blockIssues: [], notices: [] }, label);
  }
  assert.equal(store.runStyle({ outputLanguage: 'en' }).recipe.ref, 'builtin:general', 'no kind counts as the general topic kind');
});

test('P2a kinds: general research and Textbook give prompts byte-equal to a run with no style fields, in all three languages (the kind=topic default path)', async () => {
  for (const language of LANGUAGES) {
    const { store } = await world({ language });
    const general = store.runStyle({ kind: 'topic', outputLanguage: language });
    assert.deepEqual(plain(general.contextFields), {});
    for (const step of ['research', 'synthesize', 'decompose']) assert.equal(promptOf(general, language, step), M.assembleTaskPrompt(M.selectionFromContext(contextOf(language), language), step, contextOf(language), language).text, `${language} ${step}`);
    const textbook = (await world({ language, noteStyleByKind: { topic: 'builtin:textbook' } })).store.runStyle({ kind: 'topic', outputLanguage: language });
    assert.deepEqual(plain(textbook.contextFields), {});
    assert.equal(promptOf(textbook, language), baseText(language, M.textbookTemplate(language === 'en' ? 'en' : 'zh-TW', language)), language);
  }
});

test('counter 1: a map\'s template and tone never reach the result: the seven kinds equal the same runs with no map', async () => {
  const { store } = await world({ detailTemplates: M.normalizeTemplates([{ id: 'u1', name: 'U', sections: [{ id: 's', name: 'S', description: 'd', role: 'none', aliases: [] }] }]) });
  for (const kind of KINDS7) for (const language of LANGUAGES) {
    const without = store.runStyle({ kind, outputLanguage: language });
    for (const extra of [{ map: { template: 'textbook', tone: 'plain' } }, { map: { template: 'u1', tone: 'custom-tone-1' }, toneOnly: true }, { map: { template: 'file:X' } }]) {
      const got = store.runStyle({ kind, outputLanguage: language, ...extra });
      assert.deepEqual(summaryOf(got), summaryOf(without), `${kind} ${language} ${JSON.stringify(extra)}`);
      assert.equal(promptOf(got, language), promptOf(without, language), `${kind} ${language}`);
    }
  }
});

test('counter 2: the workspace keys and the unpublished keys do not reach the result: the seven kinds equal the empty settings', async () => {
  const empty = await world();
  const set = await world({
    noteTemplateBlock: 'builtin:textbook', noteToneBlock: 'builtin:plain', defaultNoteStyleId: 'textbook', defaultDetailTemplateId: 'textbook',
    noteTemplateByKind: { hypothesis: 'builtin:action' }, noteStyleAliases: { standard: { template: 'builtin:textbook' } }, noteStyleUpgrade: { version: 1 },
    noteStyleFiles: { standard: 'Standard.md' }
  }, { [`${STYLES}/Standard.md`]: '---\ntone: x\n---\n## A\ntext\n', [`${DIR.template}/Mine.md`]: '## A\nx\n' });
  for (const kind of KINDS7) for (const language of LANGUAGES) {
    const a = set.store.runStyle({ kind, outputLanguage: language }), b = empty.store.runStyle({ kind, outputLanguage: language });
    assert.deepEqual(summaryOf(a), summaryOf(b), `${kind} ${language}`);
    assert.equal(promptOf(a, language), promptOf(b, language), `${kind} ${language}`);
  }
});

test('counter 3 (store part): a kind setting that is a bad ref is skipped and reported, and the result is general research', async () => {
  for (const ref of ['file:a/b', 'file:a\\b', 'file:..', 'file:../x', 'file: x', 'file:', 'file:標準六段', 'file:General research', 'x']) {
    const { store } = await world({ noteStyleByKind: { topic: ref } }, { [`${DIR.recipe}/x.md`]: '', [`${DIR.recipe}/a.md`]: '' });
    const got = store.runStyle({ kind: 'topic', outputLanguage: 'en' });
    assert.equal(got.recipe.ref, 'builtin:general', ref);
    assert.deepEqual(plain(got.issues.missing), [ref], ref);
  }
});

test('counter 4: a file named like a built-in part is never the built-in; file:<built-in name> is unreadable', async () => {
  const files = { [`${DIR.template}/標準六段.md`]: '## Changed\nOnly one.\n', [`${DIR.template}/Standard six.md`]: '## Changed\nOnly one.\n', [`${DIR.tone}/Plain explanation.md`]: 'file voice', [`${DIR.format}/Standard format.md`]: 'file format', [`${DIR.recipe}/General research.md`]: '---\nstructure: Changed\n---\n' };
  for (const language of LANGUAGES) {
    const { store } = await world({ language }, files);
    const general = store.runStyle({ kind: 'topic', outputLanguage: language });
    assert.equal(promptOf(general, language), baseText(language), language);
    assert.equal(general.recipe.ref, 'builtin:general');
    // a run that names the file as a structure, a voice, or a style cannot read it
    for (const [request, ref] of [[{ choice: { style: 'file:標準六段' } }, 'file:標準六段'], [{ choice: { style: 'file:Standard six' } }, 'file:Standard six'], [{ choice: { style: 'file:General research' } }, 'file:General research']]) {
      const got = store.runStyle({ kind: 'topic', outputLanguage: language, ...request });
      assert.deepEqual(plain(got.issues.missing), [ref], ref);
      assert.equal(got.template.id, 'standard');
      assert.equal(got.recipe.ref, 'builtin:general');
    }
    // #18: a run tone is ignored (replacement: steps-run-style.cjs slice 12)
    assert.equal(store.runStyle({ kind: 'topic', outputLanguage: language, choice: { tone: 'file:Plain explanation' } }).toneText, undefined);
  }
  // the conversion table cannot reach a built-in name through a file either
  const { store } = await world({ noteStyleRecipe: { migrated: 1, legacy: { templates: { old: 'file:標準六段' }, tones: {} } } }, files);
  const got = store.runStyle({ kind: 'topic', topic: { template: 'old' }, outputLanguage: 'en' });
  assert.equal(got.template.id, 'standard');
  assert.deepEqual(plain(got.issues.missing), ['old']);
});

test('counter 5: every unreadable level falls back and nothing throws: a missing kind style, a style naming a gone structure, an update mode that is not one', async () => {
  const { store } = await world({ noteStyleByKind: { hypothesis: 'file:不存在' } }, {
    [`${DIR.recipe}/Gone part.md`]: '---\nstructure: 不存在的結構\nvoice: 不存在的口吻\nformat: 不存在的格式\n---\n',
    [`${DIR.recipe}/Bad mode.md`]: '---\n更新方式: 隨便\n---\n'
  });
  const hypothesis = store.runStyle({ kind: 'hypothesis', outputLanguage: 'en' });
  assert.equal(hypothesis.recipe.ref, 'builtin:hypothesis');
  assert.deepEqual(plain(hypothesis.issues.missing), ['file:不存在']);
  assert.equal(hypothesis.template.id, 'hypothesis');
  const part = store.runStyle({ choice: { style: 'file:Gone part' }, outputLanguage: 'en' });
  assert.equal(part.recipe.ref, 'file:Gone part');
  assert.equal(part.template.id, 'standard');
  assert.equal(part.toneText, undefined);
  assert.equal(part.formatText, standardFormat('en'));
  assert.deepEqual(plain(part.issues.blockIssues.map(issue => [issue.fileName, issue.line, issue.code])), [['Gone part.md', 2, 'ui.note_style_issue_part_missing'], ['Gone part.md', 3, 'ui.note_style_issue_part_missing'], ['Gone part.md', 4, 'ui.note_style_issue_part_missing']]);
  const mode = store.runStyle({ choice: { style: 'file:Bad mode' }, outputLanguage: 'en' });
  assert.equal(mode.updateMode, 'merge');
  assert.deepEqual(plain(mode.issues.blockIssues.map(issue => [issue.fileName, issue.line, issue.code])), [['Bad mode.md', 2, 'ui.note_style_issue_update_invalid']]);
  assert.equal(mode.recipe.ref, 'file:Bad mode', 'the style is still used');
});

test('counter 6: AIM is isolated: builtin:aim is unreadable outside kind aim, kind aim with no setting is the AIM report, a setting for aim picks another style', async () => {
  for (const patch of [{ noteStyleByKind: { topic: 'builtin:aim' } }]) {
    const got = (await world(patch)).store.runStyle({ kind: 'topic', outputLanguage: 'en' });
    assert.equal(got.recipe.ref, 'builtin:general');
    assert.deepEqual(plain(got.issues.missing), ['builtin:aim']);
  }
  const { store } = await world({ noteStyleByKind: { aim: 'builtin:general' } });
  const viaTopic = store.runStyle({ kind: 'topic', topic: { style: 'builtin:aim' }, outputLanguage: 'en' });
  assert.equal(viaTopic.recipe.ref, 'builtin:general');
  assert.deepEqual(plain(viaTopic.issues.missing), ['builtin:aim']);
  const viaRun = store.runStyle({ kind: 'hypothesis', choice: { style: 'builtin:aim' }, outputLanguage: 'en' });
  assert.equal(viaRun.recipe.ref, 'builtin:hypothesis');
  const aim = (await world()).store.runStyle({ kind: 'aim', outputLanguage: 'en' });
  assert.equal(aim.recipe.ref, 'builtin:aim');
  assert.equal(aim.recipe.aimDelivery, true);
  assert.equal(aim.template.id, 'standard');
  const other = store.runStyle({ kind: 'aim', outputLanguage: 'en' });
  assert.equal(other.recipe.ref, 'builtin:general');
  assert.equal(other.recipe.aimDelivery, undefined);
});

test('counter 7: a kind that is not one of the seven reads as the general topic kind, and a stored topic-kind that is not a kind reads as topic', async () => {
  assert.equal(M.readTopicKind({ 'topic-kind': '亂寫' }), 'topic');
  const { store } = await world();
  const got = store.runStyle({ kind: M.readTopicKind({ 'topic-kind': '亂寫' }), outputLanguage: 'en' });
  assert.equal(got.recipe.ref, 'builtin:general');
  assert.equal(store.runStyle({ kind: '亂寫', outputLanguage: 'en' }).recipe.ref, 'builtin:general', 'the store itself does not throw on an unknown kind');
});

test('counter 8: priority: the topic\'s note-style beats its old keys; the run\'s style beats the topic; a run tone is ignored (#18)', async () => {
  const { store } = await world({ detailTemplates: M.normalizeTemplates([{ id: 'u1', name: 'U', sections: [{ id: 's', name: 'S', description: 'd', role: 'none', aliases: [] }] }]) });
  const ask = request => store.runStyle({ kind: 'topic', outputLanguage: 'en', ...request });
  const both = ask({ topic: { style: 'builtin:atomic', template: 'u1', tone: 'plain' } });
  assert.equal(both.recipe.ref, 'builtin:atomic');
  assert.equal(both.template.id, 'atomic');
  assert.equal(both.toneText, undefined, 'the old tone is not mixed into a style');
  assert.equal(both.recipe.source, 'topic');
  const run = ask({ choice: { style: 'builtin:evidence' }, topic: { style: 'builtin:atomic' } });
  assert.deepEqual([run.recipe.ref, run.recipe.source, run.template.id], ['builtin:evidence', 'run', 'evidence']);
  // #18: a run tone no longer changes the voice or the source (replacement: steps-run-style.cjs slice 12)
  const tone = ask({ choice: { tone: 'plain' }, topic: { style: 'builtin:atomic' } });
  assert.deepEqual([tone.recipe.ref, tone.recipe.source, tone.template.id], ['builtin:atomic', 'topic', 'atomic']);
  assert.equal(tone.toneText, undefined);
  assert.notEqual(tone.label.toneName, 'Plain explanation');
  const old = ask({ topic: { template: 'u1', tone: 'plain' } });
  assert.deepEqual([old.recipe.source, old.recipe.implicit, old.template.id], ['topic', true, 'u1']);
});

test('counter 9: the implicit style of an old topic: a custom template is the 0.28.0 path; a custom tone preset sends its text; unknown or file ids are Standard; one key takes the kind default for the other part; the conversion table first', async () => {
  const templates = M.normalizeTemplates([{ id: 'uuid-9', name: 'Mine', sections: [{ id: 's', name: 'Findings', description: 'What we found.', role: 'none', aliases: [] }] }]);
  const { store } = await world({ detailTemplates: templates });
  for (const language of LANGUAGES) {
    const got = store.runStyle({ kind: 'topic', topic: { template: 'uuid-9' }, outputLanguage: language });
    assert.deepEqual(plain(got.contextFields), {}, 'no styleSelection: the 0.28.0 path');
    assert.deepEqual(plain(got.template), plain(templates[0]));
    assert.equal(promptOf(got, language), baseText(language, templates[0]), language);
  }
  assert.equal(store.runStyle({ topic: { tone: 'custom-tone-1' }, outputLanguage: 'en' }).toneText, 'Talk like a pirate.');
  for (const id of ['style:X', 'file:X', 'builtin:standard', 'nope']) {
    const got = store.runStyle({ topic: { template: id }, outputLanguage: 'en' });
    assert.equal(got.template.id, 'standard', id);
    assert.deepEqual(plain(got.issues.missing), [id], id);
  }
  const hypothesis = store.runStyle({ kind: 'hypothesis', topic: { tone: 'plain' }, outputLanguage: 'en' });
  assert.equal(hypothesis.template.id, 'hypothesis', 'only a tone: the structure of the kind');
  assert.ok(hypothesis.toneText);
  const kindStructure = store.runStyle({ kind: 'atomic', topic: { template: 'textbook' }, outputLanguage: 'en' });
  assert.equal(kindStructure.template.id, 'textbook');
  assert.equal(kindStructure.toneText, undefined, 'only a structure: the voice of the kind (academic)');
  assert.equal(kindStructure.updateMode, 'merge');
  // the conversion table is looked up before the saved templates
  const table = await world({ detailTemplates: templates, noteStyleRecipe: { migrated: 1, legacy: { templates: { 'uuid-9': 'builtin:action' }, tones: { 'custom-tone-1': 'builtin:summary' } } } });
  const mapped = table.store.runStyle({ topic: { template: 'uuid-9', tone: 'custom-tone-1' }, outputLanguage: 'en' });
  assert.equal(mapped.template.id, 'action');
  assert.ok(mapped.toneText && mapped.toneText !== 'Talk like a pirate.');
  assert.equal(mapped.label.styleName, 'Old setting (Goal to done · Key-point summary)');
});

test('counter 12: reading and resolving write nothing: refresh and the seven kinds make no create, createFolder, trash or save', async () => {
  const { store, v } = await world({}, { [`${DIR.recipe}/R.md`]: '---\nstructure: Mine\n---\n', [`${DIR.template}/Mine.md`]: '## A\nx\n' });
  await store.refresh();
  for (const kind of KINDS7) store.runStyle({ kind, outputLanguage: 'en' });
  store.runStyle({ choice: { style: 'file:R' }, outputLanguage: 'en' });
  assert.deepEqual(v.writes, []);
});

test('P2a folders: the four folders are read in the spelling that exists (zh-TW here); a style file, a structure, a voice and a format file make a style that reads all of them', async () => {
  const files = {
    [`${STYLES}/風格/我的.md`]: '---\n段落結構: 我的結構\n寫作口吻: 我的口吻\n格式規則: 我的格式\n更新方式: 只存新內容\n---\n這是一行說明。\n',
    [`${STYLES}/段落結構/我的結構.md`]: '## 重點\n說明\n',
    [`${STYLES}/寫作口吻/我的口吻.md`]: '<!-- note -->\n像朋友一樣說話。\n',
    [`${STYLES}/格式規則/我的格式.md`]: '\n\n只用條列。\n\n'
  };
  const { store } = await world({ language: 'en' }, files);
  const got = store.runStyle({ choice: { style: 'file:我的' }, outputLanguage: 'zh-TW' });
  assert.deepEqual([got.recipe.ref, got.recipe.name, got.template.id, got.toneText, got.formatText, got.updateMode], ['file:我的', '我的', 'file:我的結構', '像朋友一樣說話。', '只用條列。', 'fresh']);
  assert.deepEqual(plain(got.contextFields.styleSelection.format), { id: 'file:我的格式', body: '\n\n只用條列。\n\n', fileName: '我的格式.md' });
  assert.equal(got.contextFields.styleSelection.template.body, '## 重點\n說明\n');
  const text = promptOf(got, 'zh-TW');
  assert.ok(text.includes('只用條列。') && text.includes('像朋友一樣說話。'));
  assert.equal(text.includes(standardFormat('zh-TW')), false, 'the format file replaces the standard format');
  // an empty format file adds no format text; a built-in format is named by its name in any language
  const empty = await world({}, { [`${DIR.recipe}/E.md`]: '---\nformat: Blank\n---\n', [`${DIR.format}/Blank.md`]: '\n\n' });
  const none = empty.store.runStyle({ choice: { style: 'file:E' }, outputLanguage: 'en' });
  assert.equal(none.formatText, '');
  assert.equal(promptOf(none, 'en').includes('Obsidian'), false);
  const lean = (await world({}, { [`${DIR.recipe}/L.md`]: '---\nformat: 精簡格式\n---\n' })).store.runStyle({ choice: { style: 'file:L' }, outputLanguage: 'en' });
  assert.deepEqual(plain(lean.contextFields.styleSelection.format), { id: 'lean' });
  assert.equal(lean.formatText, M.lookupBuiltinFormat('lean', 'en'));
});

test('counter 11 (store part): a structure file with an old format rules zone is used for its sections; the zone is not in the prompt; the notice names the line; no fallback', async () => {
  const text = `## Alpha\nDescribe alpha.\n\n# Format rules\n\nFORMAT-ZONE-LINE\n`;
  const { store } = await world({ noteStyleByKind: { topic: 'file:Z' } }, { [`${DIR.recipe}/Z.md`]: '---\nstructure: Old zone\n---\n', [`${DIR.template}/Old zone.md`]: text });
  const got = store.runStyle({ kind: 'topic', outputLanguage: 'en' });
  assert.deepEqual(plain(got.template.sections.map(section => section.name)), ['Alpha']);
  assert.deepEqual(plain(got.issues.blockIssues), []);
  assert.deepEqual(plain(got.issues.notices), [{ line: 4, code: 'format_zone_moved', id: 'file:Old zone', fileName: 'Old zone.md' }]);
  assert.equal(promptOf(got, 'en').includes('FORMAT-ZONE-LINE'), false);
  assert.ok(promptOf(got, 'en').includes('Describe alpha.'));
});

// ---- P2b: the settings keys, the topic's note-style frontmatter, loading ----
const S = require('./support.cjs');
const Main = S.load('main.ts', { obsidian: S.obsidian });

test('P2b settings (T3 P2b, decisions #32): the other unpublished and old keys round-trip byte for byte through settingsFromSaved; noteStyleAliases and noteStyleUpgrade are not read and are gone after a save', () => {
  const saved = {
    noteTemplateBlock: 'builtin:textbook', noteToneBlock: 'file:Mine', noteTemplateByKind: { hypothesis: 'builtin:action', evidence: 'file:Mine' }, // noteTemplateByKind: removed in T5 P2b, read no more
    noteStyleAliases: { standard: { template: 'builtin:textbook', tone: 'builtin:plain' } }, noteStyleUpgrade: { version: 1 }, defaultNoteStyleId: 'textbook', defaultDetailTemplateId: 'u1',
    detailTemplates: [{ id: 'u1', name: 'U', sections: [{ id: 's', name: 'S', description: 'd', role: 'none', aliases: [] }] }],
    promptPresets: [{ id: 'p1', kind: 'tone', name: 'P', text: 'x' }]
  };
  const once = Main.settingsFromSaved(saved);
  assert.equal('noteTemplateByKind' in once, false, 'noteTemplateByKind is not read; it is gone after a save (T5 P2b, #31)');
  assert.equal('noteTemplateByKind' in Main.settingsFromSaved(JSON.parse(JSON.stringify(once))), false);
  for (const key of ['defaultNoteStyleId', 'defaultDetailTemplateId'])
    assert.deepEqual(plain(once[key]), plain(saved[key]), key);
  // #40: the two unpublished workspace keys are not read any more
  assert.equal('noteTemplateBlock' in once, false);
  assert.equal('noteToneBlock' in once, false);
  assert.equal('noteStyleAliases' in once, false);
  assert.equal('noteStyleUpgrade' in once, false);
  assert.equal('noteStyleAliases' in Main.settingsFromSaved(JSON.parse(JSON.stringify(once))), false);
  assert.deepEqual(plain(once.detailTemplates.map(({ id, name }) => ({ id, name }))), [{ id: 'u1', name: 'U' }]);
  assert.deepEqual(plain(once.promptPresets.map(({ id, name }) => ({ id, name }))), [{ id: 'p1', name: 'P' }]);
  // Saving what was loaded and loading it again changes nothing, and T2 writes neither new key.
  assert.deepEqual(plain(Main.settingsFromSaved(JSON.parse(JSON.stringify(once)))), plain(once));
  assert.equal('noteStyleByKind' in once, false);
  assert.equal('noteStyleRecipe' in once, false);
});

test('P2b settings: noteStyleByKind keeps only the seven known kinds with a readable ref; bad names are dropped; nothing left = no key', () => {
  const kept = Main.settingsFromSaved({ noteStyleByKind: { topic: 'builtin:textbook', atomic: 'file:Mine', hypothesis: 'file:a/b', evidence: 'file:一般研究', conclusion: 5, action: 'x', aim: 'builtin:aim', other: 'builtin:general' } });
  assert.deepEqual(plain(kept.noteStyleByKind), { topic: 'builtin:textbook', atomic: 'file:Mine', aim: 'builtin:aim' });
  for (const value of [{ topic: 'file:a/b' }, { topic: 'file:..' }, { topic: '' }, { nope: 'builtin:general' }, [], 'builtin:general', null, 5])
    assert.equal('noteStyleByKind' in Main.settingsFromSaved({ noteStyleByKind: value }), false, JSON.stringify(value));
});

test('P2b settings: noteStyleRecipe is kept only when its shape is valid', () => {
  const good = { migrated: 1, mapsNotified: true, legacy: { templates: { u1: 'file:A' }, tones: { t1: 'builtin:plain' } } };
  assert.deepEqual(plain(Main.settingsFromSaved({ noteStyleRecipe: good }).noteStyleRecipe), good);
  assert.deepEqual(plain(Main.settingsFromSaved({ noteStyleRecipe: { migrated: 1 } }).noteStyleRecipe), { migrated: 1 });
  for (const bad of [{ migrated: 2 }, { migrated: 1, legacy: { templates: {} } }, { migrated: 1, legacy: { templates: { a: 1 }, tones: {} } }, [], 'x', null])
    assert.equal('noteStyleRecipe' in Main.settingsFromSaved({ noteStyleRecipe: bad }), false, JSON.stringify(bad));
});

test('P2b frontmatter: note-style is read when it is a non-empty string, written only when the patch carries it, and "" removes it; detail-template and tone are untouched', async () => {
  const { repo, contents } = S.fixture('en');
  const note = await S.topicNote(repo);
  assert.equal(note.noteStyle, undefined);
  await repo.updateNote(note.path, { detailTemplateId: 'u1', toneId: 'plain' });
  assert.equal(contents.get(note.path).includes('note-style'), false, 'no patch field, no key');
  assert.equal((await repo.readNote(note.path)).noteStyle, undefined);
  await repo.updateNote(note.path, { noteStyle: 'file:Mine' });
  const set = await repo.readNote(note.path);
  assert.equal(set.noteStyle, 'file:Mine');
  assert.equal(set.detailTemplateId, 'u1');
  assert.equal(set.toneId, 'plain');
  await repo.updateNote(note.path, { title: 'Other' });
  assert.equal((await repo.readNote(note.path)).noteStyle, 'file:Mine', 'a patch without the field keeps it');
  await repo.updateNote(note.path, { noteStyle: '' });
  assert.equal(contents.get(note.path).includes('note-style'), false);
  assert.equal((await repo.readNote(note.path)).detailTemplateId, 'u1');
});
