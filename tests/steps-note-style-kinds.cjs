// Topic-kind built-in template blocks (hypothesis, evidence, action, atomic), P1: the 12 section files parse in every
// language, the store resolves them without a legacy template, and the prompt carries them as a custom detail structure.
// Unit level, over an in-memory vault.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadSource } = require('./support-replay.cjs');

const M = loadSource(`
export { NoteStyleStore } from "./ai/note-style-store";
export { BUILTIN_BLOCKS, builtinTemplateText, lookupBuiltinBlock } from "./core/blocks/builtin";
export { builtinBlockIdOfName } from "./core/blocks/block-files";
export { parseTemplateBlock, splitTemplateZones } from "./core/blocks/template-block";
export { assembleTaskPrompt, selectionFromContext, promptStepOf } from "./core/steps/task/assemble";
export { OBSIDIAN_FORMAT, inLanguage } from "./core/steps/_shared/fragments";
export { translate } from "./i18n";
export { normalizeNoteTemplateByKind } from "./ai/note-style-store";
export { TOPIC_KINDS } from "./note-values";
export { runStyleLabelText } from "./ai/note-style-label";
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
// The names are the design's part names (decisions: a part is named for what it holds, not "... structure").
const NAMES = {
  'zh-TW': { hypothesis: '主張到判斷', evidence: '內容與可信度', action: '目標到完成', atomic: '定義解釋例子' },
  'zh-CN': { hypothesis: '主张到判断', evidence: '内容与可信度', action: '目标到完成', atomic: '定义解释例子' },
  en: { hypothesis: 'Claim to verdict', evidence: 'Content & credibility', action: 'Goal to done', atomic: 'Definition & example' }
};
const IDS = Object.keys(HEADINGS);

const STYLES = 'WS/S';
const TPL = `${STYLES}/Structures`;
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

// Since note-style-recipe T2 a run reads styles (recipes) and their parts. A style file "Mix" in `Styles/` names a structure and a
// voice (a built-in by its English name, an own file by its base name); `mixWorld` makes it the style of `kind` (default topic).
const RECIPES = `${STYLES}/Styles`;
const partNameOf = (ref, part) => (ref.startsWith('file:') ? ref.slice(5) : M.translate('en', part === 'tone' ? `ui.preset_name_${ref.slice(8)}` : `ui.structure_name_${ref.slice(8)}`));
function mixWorld({ structure, voice } = {}, settingsPatch = {}, files = {}, kind = 'topic') {
  const lines = ['---', ...(structure ? [`structure: ${partNameOf(structure, 'template')}`] : []), ...(voice ? [`voice: ${partNameOf(voice, 'tone')}`] : []), '---', ''];
  return world({ ...settingsPatch, noteStyleByKind: { ...settingsPatch.noteStyleByKind, [kind]: 'file:Mix' } }, { ...files, [`${RECIPES}/Mix.md`]: lines.join('\n') });
}
const base = { title: 'Topic T', summary: 'S', rules: 'R', detail: 'D', task: 'Do X', ancestors: 'A', workingFindings: 'F', sourceContext: 'Source [S1]: fact', mode: 'task', researchMode: 'research', researchDepth: 'normal', visualMode: 'auto' };
/** The prompt a run builds from a runStyle result, as the production call sites put it together. */
function promptOf(style, language) {
  const context = { ...base, outputLanguage: language, detailTemplate: style.template };
  const selection = style.contextFields.styleSelection ?? M.selectionFromContext(context, language);
  return M.assembleTaskPrompt(selection, M.promptStepOf(context), context, language);
}

test('kinds: the four kind templates are registered after Textbook, with names in three languages', () => {
  const templates = M.BUILTIN_BLOCKS.filter(block => block.category === 'template');
  assert.equal(templates.map(block => block.id).join(), 'standard,textbook,hypothesis,evidence,action,atomic,conclusion');
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

test('kinds: builtinTemplateText is the sections only; the format rules are a part of their own (Q1)', () => {
  for (const id of IDS) for (const language of LANGUAGES) {
    const text = M.builtinTemplateText(id, language);
    const zones = M.splitTemplateZones(text);
    assert.equal(zones.separatorLines.length, 0, `${id} ${language}`);
    assert.equal(zones.format, undefined, `${id} ${language}`);
    assert.equal(text.includes(M.inLanguage(M.OBSIDIAN_FORMAT, language).trim()), false, `${id} ${language}`);
  }
});

test('kinds: the atomic note keeps itself short in its section descriptions, not with a count line', () => {
  const zh = M.parseTemplateBlock(M.builtinTemplateText('atomic', 'zh-TW'), { id: 'atomic', name: 'a' }).template;
  assert.match(zh.sections[0].description, /40/);
  assert.match(zh.sections[1].description, /三句/);
});

test('kinds: a store whose kind style is a kind template gives that template, named, in the output language; the interface language stays out of the headings', async () => {
  for (const id of IDS) {
    const { store, v } = await world({ language: 'zh-TW', noteStyleByKind: { topic: `builtin:${id}` } });
    const got = store.runStyle({ outputLanguage: 'en' });
    assert.equal(got.template.id, id);
    assert.deepEqual(JSON.parse(JSON.stringify(names(got.template))), HEADINGS[id].en, id);
    assert.equal(got.label.templateName, NAMES['zh-TW'][id], 'the name follows the interface language, not the bare id');
    assert.deepEqual(JSON.parse(JSON.stringify(got.issues)), { missing: [], blockIssues: [], notices: [] });
    assert.deepEqual(v.writes, []);
    const zh = store.runStyle({ outputLanguage: 'zh-TW' });
    assert.deepEqual(JSON.parse(JSON.stringify(names(zh.template))), HEADINGS[id]['zh-TW'], id);
  }
});

test('kinds: the hypothesis prompt goes through the custom detail structure with the eight headings in order, in each output language', async () => {
  for (const language of LANGUAGES) {
    const { store } = await world({ language: 'en', noteStyleByKind: { topic: 'builtin:hypothesis' } });
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

test('kinds (was: an override file of a built-in; grilling Q5/decision #22): a file named like a built-in structure, equal to it or changed, is never read; the built-in stands', async () => {
  for (const text of [M.builtinTemplateText('action', 'en'), '## Only\nOne section.\n']) {
    const { store } = await world({ noteStyleByKind: { topic: 'builtin:action' } }, { [`${TPL}/Goal to done.md`]: text });
    const got = store.runStyle({ outputLanguage: 'en' });
    assert.deepEqual(JSON.parse(JSON.stringify(names(got.template))), HEADINGS.action.en);
    assert.equal(got.contextFields.styleSelection, undefined);
    assert.equal(got.label.templateName, 'Goal to done');
    assert.deepEqual(JSON.parse(JSON.stringify(got.issues.blockIssues)), []);
  }
});

test('kinds (was: a broken override of a kind template; grilling Q5/decision #22): a broken file named like a kind structure is not read, so the built-in has no issue; nothing throws or is written', async () => {
  // A count line that is not a number: still a problem the sections parser reports (a second format heading is not one any more, Q1).
  const BROKEN = '## A\nCount: x\nbody\n';
  for (const id of IDS) {
    const file = NAMES.en[id];
    const { store, v } = await world({ noteStyleByKind: { topic: `builtin:${id}` } }, { [`${TPL}/${file}.md`]: BROKEN });
    let got;
    assert.doesNotThrow(() => { got = store.runStyle({ outputLanguage: 'en' }); }, id);
    assert.equal(got.template.id, id);
    assert.deepEqual(JSON.parse(JSON.stringify(names(got.template))), HEADINGS[id].en, id);
    assert.deepEqual(JSON.parse(JSON.stringify(got.issues.blockIssues)), [], id);
    assert.ok(promptOf(got, 'en').text.includes(`### ${HEADINGS[id].en[0]}`), id);
    assert.deepEqual(v.writes, []);
  }
  // a broken structure file a style names is stood in for by Standard, with the issues
  for (const id of IDS) {
    const { store } = await mixWorld({ structure: 'file:Broken' }, {}, { [`${TPL}/Broken.md`]: BROKEN });
    const got = store.runStyle({ outputLanguage: 'en' });
    assert.equal(got.template.id, 'standard', id);
    assert.equal(got.issues.blockIssues[0].fileName, 'Broken.md');
    assert.doesNotThrow(() => promptOf(got, 'en'), id);
  }
});

test('kinds: the built-in names are not mistaken for the legacy ids, and Standard and Textbook still resolve as before', async () => {
  for (const [id, recipe] of [['standard', 'general'], ['textbook', 'textbook']]) {
    const { store } = await world({ noteStyleByKind: { topic: `builtin:${recipe}` } });
    const got = store.runStyle({ outputLanguage: 'en' });
    assert.equal(got.template.id, id);
    assert.equal(got.label.templateName, id === 'standard' ? 'Standard six' : 'Intro + six');
  }
  const { store } = await world({});
  assert.equal(store.runStyle({ outputLanguage: 'en' }).template.id, 'standard');
  assert.deepEqual(JSON.parse(JSON.stringify(store.listBlocks('template').filter(item => item.kind === 'builtin').map(item => item.ref))), ['builtin:standard', 'builtin:textbook', 'builtin:hypothesis', 'builtin:evidence', 'builtin:action', 'builtin:atomic', 'builtin:conclusion']);
});

test('kinds: a user file named Evidence / Action / Hypothesis / Atomic note stays a file ("mine"), is not claimed by a built-in, and a style naming it resolves to it', async () => {
  const OWN = '## Mine A\nbody\n## Mine B\nbody\n';
  for (const [name, id] of [['Evidence', 'evidence'], ['Action', 'action'], ['Hypothesis', 'hypothesis'], ['Atomic note', 'atomic']]) {
    assert.equal(M.builtinBlockIdOfName('template', name), undefined, name);
    const { store, v } = await mixWorld({ structure: `file:${name}` }, {}, { [`${TPL}/${name}.md`]: OWN });
    const items = store.listBlocks('template');
    const mine = items.find(item => item.kind === 'file' && item.name === name);
    assert.ok(mine, `${name} is listed as a file item`);
    assert.equal(mine.ref, `file:${name}`);
    assert.equal(mine.modified, false, name);
    assert.equal(items.find(item => item.ref === `builtin:${id}`).modified, false, `${id} built-in is untouched`);
    const got = store.runStyle({ outputLanguage: 'en' });
    assert.deepEqual(plainOf(names(got.template)), ['Mine A', 'Mine B'], name);
    assert.deepEqual(v.writes, [], name);
  }
});

// ---- P2: the topic-kind level of the resolution (ticket 07; decisions #10, #18, #19) ----
const KINDS = ['topic', 'action', 'atomic', 'hypothesis', 'evidence', 'conclusion'];
const plainOf = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const FREE_TONE = '---\ntone: Short sentences, friendly.\n---\n## A\ntext\n';
const summaryOf = style => plainOf({ template: style.template, toneText: style.toneText, label: style.label, contextFields: style.contextFields, issues: style.issues });

test('kind level (was: noteTemplateByKind with no topicKind is no kind level; grilling Q5): a request with no kind is the general topic kind; the entries of other kinds do not touch it', async () => {
  const a = await world({ noteStyleByKind: { hypothesis: 'builtin:hypothesis', action: 'builtin:atomic' } });
  const b = await world({});
  for (const request of [{ outputLanguage: 'en' }, { outputLanguage: 'zh-TW', topic: { template: 'textbook' } }])
    assert.deepEqual(summaryOf(a.store.runStyle(request)), summaryOf(b.store.runStyle(request)));
  const topic = await world({ noteStyleByKind: { topic: 'builtin:atomic' } });
  assert.equal(topic.store.runStyle({ outputLanguage: 'en' }).template.id, 'atomic', 'no kind counts as the general topic kind');
});

test('kind level (was: no key gives the same as no topicKind; grilling Q5): a kind with no entry gets its built-in style; an entry for another kind changes nothing', async () => {
  const none = await world({});
  const other = await world({ noteStyleByKind: { action: 'builtin:general' } });
  for (const kind of KINDS) {
    if (kind === 'action') continue;
    for (const extra of [{}, { map: { template: 'textbook', tone: 'summary' } }]) {
      const alone = other.store.runStyle({ outputLanguage: 'en', kind, ...extra });
      const reference = none.store.runStyle({ outputLanguage: 'en', kind });
      assert.deepEqual(summaryOf(alone), summaryOf(reference), kind);
    }
  }
  assert.equal(other.store.runStyle({ outputLanguage: 'en', kind: 'action' }).template.id, 'standard', 'the entry of its own kind applies');
  assert.equal(none.store.runStyle({ outputLanguage: 'en', kind: 'action' }).template.id, 'action');
});

test('kind level (was: the kind structure wins over the map and the workspace; grilling Q5/Q10/Q15): run > topic > kind; the map and the workspace are not levels', async () => {
  const { store } = await world({ noteTemplateBlock: 'builtin:textbook', noteStyleByKind: { hypothesis: 'builtin:hypothesis' } }, { [`${TPL}/Mine.md`]: '## Mine\nText.\n', [`${TPL}/Mine2.md`]: '## Mine2\nText.\n' });
  const request = extra => ({ outputLanguage: 'en', kind: 'hypothesis', map: { template: 'standard' }, ...extra });
  const got = store.runStyle(request({}));
  assert.equal(got.template.id, 'hypothesis');
  assert.equal(got.label.templateSource, 'kind');
  assert.equal(got.recipe.source, 'kind');
  const topic = store.runStyle(request({ topic: { template: 'textbook' } }));
  assert.equal(topic.template.id, 'textbook');
  assert.equal(topic.label.templateSource, 'topic');
  const run = store.runStyle(request({ topic: { template: 'textbook' }, choice: { template: 'file:Mine2' } }));
  assert.equal(run.template.id, 'file:Mine2');
  assert.equal(run.label.templateSource, 'run');
  const evidence = store.runStyle({ outputLanguage: 'en', kind: 'evidence', map: { template: 'standard' } });
  assert.equal(evidence.template.id, 'evidence', 'a kind with no entry has its built-in style, whatever the map holds');
  assert.equal(evidence.label.templateSource, 'kind');
  assert.equal((await world({})).store.runStyle({ outputLanguage: 'en' }).label.templateSource, 'kind');
});

test('kind level (was: a style file at the map level decides its own tone; grilling Q10/Q15): the map\'s stored template and tone never reach the result', async () => {
  const { store } = await world({ noteStyleByKind: { hypothesis: 'builtin:hypothesis' } });
  const map = { template: 'style:Free', tone: 'summary' };
  const without = store.runStyle({ outputLanguage: 'en', kind: 'hypothesis' });
  const got = store.runStyle({ outputLanguage: 'en', kind: 'hypothesis', map });
  assert.equal(got.template.id, 'hypothesis');
  assert.equal(got.toneText, undefined);
  assert.deepEqual(summaryOf(got), summaryOf(without));
  // a topic that names an old tone replaces the voice only
  const topic = store.runStyle({ outputLanguage: 'en', kind: 'hypothesis', topic: { tone: 'summary' }, map });
  assert.equal(topic.template.id, 'hypothesis');
  assert.equal(topic.toneText, M.lookupBuiltinBlock('tone', 'summary', 'en'));
  assert.equal(topic.label.templateSource, 'topic');
});

test('kind level (was: a stored value that is a style file ... is dropped on load; grilling Q5): noteTemplateByKind is not read at all; a noteStyleByKind value that is not a readable style is skipped and reported, with no exception', async () => {
  const dirty = { topic: 'style:Free', action: 'standard', atomic: 'whatever', hypothesis: 'builtin:', evidence: '', conclusion: 7, bogus: 'builtin:hypothesis' };
  assert.equal(M.normalizeNoteTemplateByKind(dirty), undefined);
  assert.equal(M.normalizeNoteTemplateByKind([]), undefined);
  assert.equal(M.normalizeNoteTemplateByKind('x'), undefined);
  assert.equal(M.normalizeNoteTemplateByKind(null), undefined);
  assert.equal(M.normalizeNoteTemplateByKind({}), undefined);
  assert.deepEqual(plainOf(M.normalizeNoteTemplateByKind({ ...dirty, atomic: 'builtin:atomic', topic: 'file:Mine' })), { atomic: 'builtin:atomic', topic: 'file:Mine' });
  const none = await world({});
  const old = await world({ noteTemplateByKind: { ...dirty, atomic: 'builtin:atomic', topic: 'file:Mine' } });
  const { store } = await world({ noteStyleByKind: dirty });
  for (const kind of KINDS) {
    assert.deepEqual(summaryOf(old.store.runStyle({ outputLanguage: 'en', kind })), summaryOf(none.store.runStyle({ outputLanguage: 'en', kind })), `${kind}: noteTemplateByKind is ignored`);
    let got;
    assert.doesNotThrow(() => { got = store.runStyle({ outputLanguage: 'en', kind }); }, kind);
    const reference = none.store.runStyle({ outputLanguage: 'en', kind });
    assert.equal(got.template.id, reference.template.id, kind);
    assert.equal(got.recipe.ref, reference.recipe.ref, kind);
    assert.equal(got.toneText, undefined, `${kind}: no tone from a dropped value`);
    const stored = dirty[kind];
    assert.deepEqual(plainOf(got.issues.missing), typeof stored === 'string' && stored ? [stored] : [], kind);
  }
});

test('kind level (was: the next level is the map or the workspace; grilling Q5/Q10/Q15): a missing kind style is reported in missing and the kind\'s built-in style is used', async () => {
  const { store } = await world({ noteStyleByKind: { hypothesis: 'file:Nope' }, noteTemplateBlock: 'builtin:textbook' });
  const got = store.runStyle({ outputLanguage: 'en', kind: 'hypothesis', map: { template: 'standard' } });
  assert.deepEqual(plainOf(got.issues.missing), ['file:Nope']);
  assert.equal(got.template.id, 'hypothesis');
  assert.equal(got.recipe.ref, 'builtin:hypothesis');
  assert.equal(got.label.templateSource, 'kind');
  const std = (await world({ noteStyleByKind: { hypothesis: 'builtin:ghost' } })).store.runStyle({ outputLanguage: 'en', kind: 'hypothesis' });
  assert.deepEqual(plainOf(std.issues.missing), ['builtin:ghost']);
  assert.equal(std.recipe.ref, 'builtin:hypothesis');
});

test('kind level: a broken structure file in the kind style gets the Standard stand-in and block issues, and does not fall to another level', async () => {
  // A count line that is not a number: still a problem the sections parser reports (a second format heading is not one any more, Q1).
  const BROKEN = '## A\nCount: x\nbody\n';
  const { store } = await mixWorld({ structure: 'file:Mine' }, { noteTemplateBlock: 'builtin:textbook' }, { [`${TPL}/Mine.md`]: BROKEN }, 'evidence');
  const got = store.runStyle({ outputLanguage: 'en', kind: 'evidence', map: { template: 'standard' } });
  assert.equal(got.label.templateSource, 'kind');
  assert.deepEqual(plainOf(got.issues.missing), []);
  assert.ok(got.issues.blockIssues.length > 0);
  assert.equal(got.issues.blockIssues[0].fileName, 'Mine.md');
  assert.equal(got.template.id, 'standard', 'a non-built-in broken block is stood in for by Standard');
});

test('kind level: interface zh-TW, output language en, kind style builtin:hypothesis gives the eight English headings', async () => {
  const { store } = await world({ language: 'zh-TW', noteStyleByKind: { hypothesis: 'builtin:hypothesis' } });
  const got = store.runStyle({ outputLanguage: 'en', kind: 'hypothesis' });
  assert.deepEqual(plainOf(names(got.template)), HEADINGS.hypothesis.en);
  assert.equal(got.label.templateName, NAMES['zh-TW'].hypothesis);
  assert.equal(got.label.templateSource, 'kind');
  const { text } = promptOf(got, 'en');
  assert.ok(text.includes(HEADINGS.hypothesis.en.map(heading => `### ${heading}`).join(', ')));
  assert.equal(text.includes('### Core conclusions'), false);
});

test('kind level: a user file named like an old kind structure still resolves to that file when the kind style picks file:<name>', async () => {
  const { store } = await mixWorld({ structure: 'file:假設結構' }, {}, { [`${TPL}/假設結構.md`]: '## 自己的\n說明。\n' });
  const got = store.runStyle({ outputLanguage: 'en' });
  assert.deepEqual(plainOf(names(got.template)), ['自己的']);
  assert.equal(got.label.templateSource, 'kind');
});

test('kind level: the i18n Notice text exists in three languages and names the type and the structure', () => {
  const kindName = { 'zh-TW': '假設', en: 'Hypothesis', 'zh-CN': '假设' };
  const text = language => M.translate(language, 'ui.note_style_kind_missing_0_1', kindName[language], 'Nope');
  assert.equal(text('zh-TW'), '為「假設」議題類型指定的筆記結構「Nope」找不到，這個議題改用下一順位的結構。');
  assert.equal(text('en'), 'The structure set for Hypothesis topics, "Nope", was not found; this topic uses the next one in line.');
  assert.equal(text('zh-CN'), '为“假设”议题类型指定的笔记结构“Nope”找不到，这个议题改用下一顺位的结构。');
});

// ---- the view call sites (the real prototype methods over a small stand-in view) ----
const S = require('./support.cjs');
const replay = require('./support-replay.cjs');
const notices = [];
const { VisualAgentMapView } = replay.load(
  'experiences/visual-map/view.ts',
  { obsidian: { ...S.obsidian, Component: class {}, MarkdownRenderChild: class {}, Notice: class { constructor(message) { notices.push(String(message)); } } } },
  { window: { setTimeout, clearTimeout }, CSS: { escape: s => s } }
);
async function viewWorld(settingsPatch, note) {
  const w = await world(settingsPatch);
  const updates = [];
  const view = Object.create(VisualAgentMapView.prototype);
  Object.defineProperty(view, 'noteStyles', { value: w.store });
  Object.assign(view, {
    map: { detailTemplateId: undefined, toneId: undefined },
    plugin: { settings: w.settings, repo: { updateNote: async (path, patch) => { updates.push(patch); }, readNote: async () => note } }
  });
  notices.length = 0;
  return { ...w, view, updates };
}

test('kind level (view): topicStyle passes the topic\'s type, a topic without one counts as the general topic; mapStyle passes the kind it is given (none counts as topic)', async () => {
  const { view } = await viewWorld({ noteStyleByKind: { hypothesis: 'builtin:hypothesis', topic: 'builtin:atomic' } }, {});
  assert.equal(view.topicStyle({ topicKind: 'hypothesis' }, undefined, undefined, 'en').template.id, 'hypothesis');
  assert.equal(view.topicStyle({}, undefined, undefined, 'en').template.id, 'atomic');
  assert.equal(view.topicStyle({ topicKind: 'action' }, undefined, undefined, 'en').template.id, 'action');
  assert.equal(view.mapStyle('en', { kind: 'hypothesis' }).template.id, 'hypothesis');
  assert.equal(view.mapStyle('en', { kind: 'topic' }).template.id, 'atomic');
  assert.equal(view.mapStyle('en').template.id, 'atomic', 'a call site that gives no kind is the general topic kind');
});

test('kind level (view): a missing kind structure raises the kind Notice once per gate and never rewrites the topic', async () => {
  const note = { path: 'T.md', topicKind: 'hypothesis' };
  // P3 moves the view's Notice to noteStyleByKind; until then it still looks the ref up in the old key, so both hold it.
  const { view, updates } = await viewWorld({ noteStyleByKind: { hypothesis: 'file:Nope' }, noteTemplateByKind: { hypothesis: 'file:Nope' } }, note);
  const gate = { shown: false };
  const style = await view.detailTemplateFor({ path: 'T.md' }, undefined, undefined, gate);
  assert.deepEqual(plainOf(style.issues.missing), ['file:Nope']);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /Nope/);
  assert.match(notices[0], /Hypothesis|假設/);
  await view.detailTemplateFor({ path: 'T.md' }, undefined, undefined, gate);
  assert.equal(notices.length, 1, 'the same gate tells once');
  assert.deepEqual(updates, [], 'the topic frontmatter is not written');
});

test('kind level (view): when the topic\'s own missing structure is the one named by the kind, only the topic\'s Notice shows', async () => {
  const note = { path: 'T.md', topicKind: 'hypothesis', detailTemplateId: 'file:Nope' };
  const { view } = await viewWorld({ noteTemplateByKind: { hypothesis: 'file:Nope' } }, note);
  await view.detailTemplateFor({ path: 'T.md' });
  assert.equal(notices.length, 1);
  assert.match(notices[0], /Nope/);
  assert.equal(/topics, "Nope"|議題類型/.test(notices[0]), false, 'the topic Notice, not the kind Notice');
});

test('kind level (view): mapStyle with notify and a kind shows the kind Notice for a missing structure; without notify it is silent', async () => {
  // P3 moves the view's Notice to noteStyleByKind; until then it still looks the ref up in the old key, so both hold it.
  const { view } = await viewWorld({ noteStyleByKind: { topic: 'file:Nope' }, noteTemplateByKind: { topic: 'file:Nope' } }, {});
  view.mapStyle('en', { kind: 'topic' });
  assert.equal(notices.length, 0);
  view.mapStyle('en', { kind: 'topic', notify: true });
  assert.equal(notices.length, 1);
  assert.match(notices[0], /Nope/);
});

test('decision 18: keep current (no explicit choice) writes no detail-template to the topic, even when the kind level applies', async () => {
  const note = { path: 'T.md', topicKind: 'hypothesis' };
  const { view, updates } = await viewWorld({ noteStyleByKind: { hypothesis: 'builtin:hypothesis' } }, note);
  const style = await view.detailTemplateFor({ path: 'T.md' });
  assert.equal(style.template.id, 'hypothesis');
  assert.deepEqual(updates, []);
});

// P3: the research progress line.
test('progress label: "Note style: <structure> · <voice> (<source>)" in three languages; run and topic add no bracket', () => {
  const label = source => ({ templateName: 'Standard', toneName: 'Plain', templateSource: source });
  const text = (source, lang = 'en') => M.runStyleLabelText(label(source), lang);
  assert.equal(text('workspace'), 'Note style: Standard · Plain (default)');
  assert.equal(text('standard'), 'Note style: Standard · Plain (default)');
  assert.equal(text('kind'), 'Note style: Standard · Plain (structure from topic type)');
  assert.equal(text('map'), 'Note style: Standard · Plain (follows this map)');
  assert.equal(text('run'), 'Note style: Standard · Plain');
  assert.equal(text('topic'), 'Note style: Standard · Plain');
  assert.equal(M.runStyleLabelText({ templateName: '假設結構', toneName: '學術嚴謹', templateSource: 'kind' }, 'zh-TW'), '筆記風格：假設結構 · 學術嚴謹（結構來自議題類型）');
  assert.equal(text('workspace', 'zh-CN'), '笔记风格：Standard · Plain（跟随默认）');
  assert.equal(text('map', 'zh-TW'), '筆記風格：Standard · Plain（跟隨這張圖）');
});

test('progress label: the view passes the line only for a style file or a topic-type structure, and the old key has no consumer', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const view = fs.readFileSync(path.join(__dirname, '..', 'experiences/visual-map/topic-run.ts'), 'utf8');
  assert.match(view, /runStyle\.label\.fileName \|\| runStyle\.label\.templateSource === "kind"\s*\?\s*runStyleLabelText\(runStyle\.label, this\.ports\.settings\(\)\.language\)\s*:\s*undefined/);
  assert.match(view, /progress\?\.begin\(path, progressAttempt, Date\.now\(\), used\.model, styleLabel\)/);
  for (const lang of ['en', 'zh-TW', 'zh-CN']) assert.equal(fs.readFileSync(path.join(__dirname, '..', 'i18n', `${lang}.ts`), 'utf8').includes('progress_note_style_0'), false);
  assert.equal(view.includes('progress_note_style_0'), false);
});
