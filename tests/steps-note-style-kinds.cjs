// Topic-kind built-in template blocks (hypothesis, evidence, action, atomic), P1: the 12 section files parse in every
// language, the store resolves them without a legacy template, and the prompt carries them as a custom detail structure.
// Unit level, over an in-memory vault.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadSource } = require('./support-replay.cjs');

const M = loadSource(`
export { NoteStyleStore } from "./ai/note-style-store";
export { BUILTIN_BLOCKS, builtinTemplateText } from "./core/blocks/builtin";
export { parseTemplateBlock, splitTemplateZones } from "./core/blocks/template-block";
export { assembleTaskPrompt, selectionFromContext, promptStepOf } from "./core/steps/task/assemble";
export { OBSIDIAN_FORMAT, inLanguage } from "./core/steps/_shared/fragments";
export { translate } from "./i18n";
`);

const LANGUAGES = ['zh-TW', 'zh-CN', 'en'];
const HEADINGS = {
  hypothesis: {
    'zh-TW': ['主張', '預測', '驗證方式', '支持', '反駁', '目前判斷', '證據與來源', '更新紀錄'],
    en: ['Claim', 'Prediction', 'How to test', 'Support', 'Counterevidence', 'Current judgment', 'Evidence and sources', 'Update log']
  },
  evidence: {
    'zh-TW': ['內容', '證據與來源', '可信度', '支持或反駁', '更新紀錄'],
    en: ['Content', 'Evidence and sources', 'Credibility', 'Supports or refutes', 'Update log']
  },
  action: {
    'zh-TW': ['目標', '步驟', '檢查點', '完成條件', '證據與來源', '更新紀錄'],
    en: ['Goal', 'Steps', 'Checkpoints', 'Done when', 'Evidence and sources', 'Update log']
  },
  atomic: {
    'zh-TW': ['定義', '解釋', '例子', '證據與來源', '更新紀錄'],
    en: ['Definition', 'Explanation', 'Example', 'Evidence and sources', 'Update log']
  }
};
HEADINGS.hypothesis['zh-CN'] = HEADINGS.hypothesis['zh-TW'];
HEADINGS.evidence['zh-CN'] = HEADINGS.evidence['zh-TW'];
HEADINGS.action['zh-CN'] = HEADINGS.action['zh-TW'];
HEADINGS.atomic['zh-CN'] = HEADINGS.atomic['zh-TW'];
const NAMES = {
  'zh-TW': { hypothesis: '假設結構', evidence: '證據結構', action: '行動結構', atomic: '原子知識結構' },
  'zh-CN': { hypothesis: '假设结构', evidence: '证据结构', action: '行动结构', atomic: '原子知识结构' },
  en: { hypothesis: 'Hypothesis', evidence: 'Evidence', action: 'Action', atomic: 'Atomic note' }
};
const IDS = Object.keys(HEADINGS);
const FOLDER = { 'zh-TW': ['積木', '結構'], en: ['Blocks', 'Templates'] };

const STYLES = 'WS/S';
const TPL = `${STYLES}/Blocks/Templates`;
function vault(files = {}) {
  const state = { files: { ...files }, writes: [] };
  const under = folder => Object.keys(state.files).filter(file => file.startsWith(`${folder}/`) && !file.slice(folder.length + 1).includes('/'));
  state.port = {
    list: async folder => under(folder).map(file => file.slice(folder.length + 1)).filter(name => name.endsWith('.md')),
    read: async file => { if (!(file in state.files)) throw new Error(file); return state.files[file]; },
    folderExists: folder => Object.keys(state.files).some(file => file.startsWith(`${folder}/`)),
    createFolder: async folder => { state.writes.push(`folder ${folder}`); },
    create: async file => { state.writes.push(`create ${file}`); },
    trash: async file => { state.writes.push(`trash ${file}`); }
  };
  return state;
}
async function world(settingsPatch = {}, files = {}) {
  const v = vault(files);
  const settings = { detailTemplates: [], promptPresets: [], workspaceFolder: 'WS', noteStylesFolder: STYLES, language: 'en', ...settingsPatch };
  const store = new M.NoteStyleStore({ settings: () => settings, port: v.port, save: async () => {} });
  await store.refresh();
  return { store, v, settings };
}
const names = template => template.sections.map(section => section.name);
const base = { title: 'Topic T', summary: 'S', rules: 'R', detail: 'D', task: 'Do X', ancestors: 'A', workingFindings: 'F', sourceContext: 'Source [S1]: fact', mode: 'task', researchMode: 'research', researchDepth: 'normal', visualMode: 'auto' };
/** The prompt a run builds from a runStyle result, as the production call sites put it together. */
function promptOf(style, language) {
  const context = { ...base, outputLanguage: language, detailTemplate: style.template };
  const selection = style.contextFields.styleSelection ?? M.selectionFromContext(context, language);
  return M.assembleTaskPrompt(selection, M.promptStepOf(context), context, language);
}

test('kinds: the four kind templates are registered after Textbook, with names in three languages', () => {
  const templates = M.BUILTIN_BLOCKS.filter(block => block.category === 'template');
  assert.equal(templates.map(block => block.id).join(), 'standard,textbook,hypothesis,evidence,action,atomic');
  for (const id of IDS) for (const language of LANGUAGES) {
    const block = templates.find(item => item.id === id);
    assert.equal(M.translate(language, block.nameKey), NAMES[language][id], `${id} ${language}`);
  }
});

test('kinds: each kind template parses without an issue in every language, with the source and log roles on the standard headings', () => {
  for (const id of IDS) for (const language of LANGUAGES) {
    const text = M.builtinTemplateText(id, language);
    const parsed = M.parseTemplateBlock(text, { id, name: id });
    assert.equal(parsed.ok, true, `${id} ${language}`);
    assert.deepEqual(JSON.parse(JSON.stringify(names(parsed.template))), HEADINGS[id][language], `${id} ${language}`);
    const roles = Object.fromEntries(parsed.template.sections.map(section => [section.name, section.role]));
    const [source, log] = language === 'en' ? ['Evidence and sources', 'Update log'] : ['證據與來源', '更新紀錄'];
    assert.equal(roles[source], 'sources', `${id} ${language}`);
    assert.equal(roles[log], 'log', `${id} ${language}`);
    for (const section of parsed.template.sections) assert.ok(section.description.trim().length > 0, `${id} ${language} ${section.name}`);
    assert.ok(parsed.template.sections.every(section => !section.count), `${id} ${language}: no count line`);
  }
});

test('kinds: the source and log sentences are the Standard ones word for word; zh-CN files hold the same text as zh-TW', () => {
  for (const id of IDS) for (const language of LANGUAGES) {
    const standard = M.parseTemplateBlock(M.builtinTemplateText('standard', language), { id: 'standard', name: 's' }).template;
    const kind = M.parseTemplateBlock(M.builtinTemplateText(id, language), { id, name: id }).template;
    for (const role of ['sources', 'log']) {
      const a = standard.sections.find(section => section.role === role);
      const b = kind.sections.find(section => section.role === role);
      assert.equal(b.name, a.name, `${id} ${language} ${role}`);
      assert.equal(b.description, a.description, `${id} ${language} ${role}`);
    }
  }
  for (const id of IDS) assert.equal(M.builtinTemplateText(id, 'zh-CN').split('\n# ')[0], M.builtinTemplateText(id, 'zh-TW').split('\n# ')[0], id);
});

test('kinds: builtinTemplateText has the sections, then the format rules heading, then the Obsidian format rules', () => {
  for (const id of IDS) for (const language of LANGUAGES) {
    const zones = M.splitTemplateZones(M.builtinTemplateText(id, language));
    assert.equal(zones.separatorLines.length, 1, `${id} ${language}`);
    assert.equal(zones.format, M.inLanguage(M.OBSIDIAN_FORMAT, language).trim(), `${id} ${language}`);
  }
});

test('kinds: the atomic note keeps itself short in its section descriptions, not with a count line', () => {
  const zh = M.parseTemplateBlock(M.builtinTemplateText('atomic', 'zh-TW'), { id: 'atomic', name: 'a' }).template;
  assert.match(zh.sections[0].description, /40/);
  assert.match(zh.sections[1].description, /三句/);
});

test('kinds: a store that picks a kind template gives that template, named, in the output language; the interface language stays out of the headings', async () => {
  for (const id of IDS) {
    const { store, v } = await world({ language: 'zh-TW', noteTemplateBlock: `builtin:${id}` });
    const got = store.runStyle({ outputLanguage: 'en' });
    assert.equal(got.template.id, id);
    assert.deepEqual(JSON.parse(JSON.stringify(names(got.template))), HEADINGS[id].en, id);
    assert.equal(got.label.templateName, NAMES['zh-TW'][id], 'the name follows the interface language, not the bare id');
    assert.deepEqual(JSON.parse(JSON.stringify(got.issues)), { missing: [], blockIssues: [] });
    assert.deepEqual(v.writes, []);
    const zh = store.runStyle({ outputLanguage: 'zh-TW' });
    assert.deepEqual(JSON.parse(JSON.stringify(names(zh.template))), HEADINGS[id]['zh-TW'], id);
  }
});

test('kinds: the hypothesis prompt goes through the custom detail structure with the eight headings in order, in each output language', async () => {
  for (const language of LANGUAGES) {
    const { store } = await world({ language: 'en', noteTemplateBlock: 'builtin:hypothesis' });
    const style = store.runStyle({ outputLanguage: language });
    const { text, segments } = promptOf(style, language);
    const headings = HEADINGS.hypothesis[language];
    let at = -1;
    for (const heading of headings) {
      const next = text.indexOf(`### ${heading}`, at + 1);
      assert.ok(next > at, `${language}: ${heading} after position ${at}`);
      at = next;
    }
    assert.ok(text.includes(headings.map(heading => `### ${heading}`).join(', ')), `${language}: the headings are listed in order`);
    assert.ok(text.includes(M.inLanguage(M.OBSIDIAN_FORMAT, language)), `${language}: the Obsidian format rules are in the prompt`);
    assert.ok(segments.some(segment => segment.source.kind === 'block' && segment.source.part === 'format'), language);
    // Standard's own headings are not in it.
    assert.equal(text.includes(language === 'en' ? '### Core conclusions' : '### 核心結論'), false, language);
  }
});

test('kinds: an override file equal to the built-in text is the built-in; a changed one that parses is used as written', async () => {
  const same = await world({ noteTemplateBlock: 'builtin:action' }, { [`${TPL}/Action.md`]: M.builtinTemplateText('action', 'en') });
  const got = same.store.runStyle({ outputLanguage: 'en' });
  assert.deepEqual(JSON.parse(JSON.stringify(names(got.template))), HEADINGS.action.en);
  assert.equal(got.contextFields.styleSelection, undefined);
  assert.equal(got.label.templateName, 'Action');
  const changed = await world({ noteTemplateBlock: 'builtin:action' }, { [`${TPL}/Action.md`]: '## Only\nOne section.\n' });
  const used = changed.store.runStyle({ outputLanguage: 'en' });
  assert.deepEqual(JSON.parse(JSON.stringify(names(used.template))), ['Only']);
  assert.equal(used.contextFields.styleSelection.template.fileName, 'Action.md');
});

test('kinds: a broken override of a kind template is stood in for by the same built-in, with the issues; nothing throws', async () => {
  const BROKEN = '## A\nbody\n# Format rules\nr\n# Format rules\nr2\n';
  for (const id of IDS) {
    const file = { hypothesis: 'Hypothesis', evidence: 'Evidence', action: 'Action', atomic: 'Atomic note' }[id];
    const { store, v } = await world({ noteTemplateBlock: `builtin:${id}` }, { [`${TPL}/${file}.md`]: BROKEN });
    let got;
    assert.doesNotThrow(() => { got = store.runStyle({ outputLanguage: 'en' }); }, id);
    assert.equal(got.template.id, id);
    assert.deepEqual(JSON.parse(JSON.stringify(names(got.template))), HEADINGS[id].en, id);
    assert.ok(got.issues.blockIssues.length > 0, id);
    assert.equal(got.issues.blockIssues[0].fileName, `${file}.md`);
    assert.doesNotThrow(() => promptOf(got, 'en'), id);
    assert.ok(promptOf(got, 'en').text.includes(`### ${HEADINGS[id].en[0]}`), id);
    assert.deepEqual(v.writes, []);
  }
});

test('kinds: the built-in names are not mistaken for the legacy ids, and Standard and Textbook still resolve as before', async () => {
  for (const id of ['standard', 'textbook']) {
    const { store } = await world({ noteTemplateBlock: `builtin:${id}` });
    const got = store.runStyle({ outputLanguage: 'en' });
    assert.equal(got.template.id, id);
    assert.equal(got.label.templateName, id === 'standard' ? 'Standard' : 'Textbook');
  }
  const { store } = await world({});
  assert.equal(store.runStyle({ outputLanguage: 'en' }).template.id, 'standard');
  assert.deepEqual(JSON.parse(JSON.stringify(store.listBlocks('template').filter(item => item.kind === 'builtin').map(item => item.ref))), ['builtin:standard', 'builtin:textbook', 'builtin:hypothesis', 'builtin:evidence', 'builtin:action', 'builtin:atomic']);
});
