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

// ---- P2: the topic-kind level of the resolution (ticket 07; decisions #10, #18, #19) ----
const KINDS = ['topic', 'action', 'atomic', 'hypothesis', 'evidence', 'conclusion'];
const plainOf = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const FREE_TONE = '---\ntone: Short sentences, friendly.\n---\n## A\ntext\n';
const summaryOf = style => plainOf({ template: style.template, toneText: style.toneText, label: style.label, contextFields: style.contextFields, issues: style.issues });

test('kind level: noteTemplateByKind set but request.topicKind not given (preview, proposal tone, outline import) is the same as no kind level', async () => {
  const withMap = { template: 'builtin:action' };
  const a = await world({ noteTemplateByKind: { hypothesis: 'builtin:hypothesis', topic: 'builtin:atomic' } });
  const b = await world({});
  for (const request of [{ outputLanguage: 'en' }, { outputLanguage: 'en', map: withMap }, { outputLanguage: 'zh-TW', topic: { template: 'textbook' } }])
    assert.deepEqual(summaryOf(a.store.runStyle(request)), summaryOf(b.store.runStyle(request)));
});

test('kind level: no noteTemplateByKind key, or no value for that kind, gives the same template, tone and label as no topicKind, for all six kinds', async () => {
  const none = await world({});
  const other = await world({ noteTemplateByKind: { action: 'builtin:action' } });
  for (const settings of [none, other]) for (const kind of KINDS) {
    if (settings === other && kind === 'action') continue;
    for (const extra of [{}, { map: { template: 'textbook', tone: 'summary' } }]) {
      const withKind = settings.store.runStyle({ outputLanguage: 'en', topicKind: kind, ...extra });
      const without = none.store.runStyle({ outputLanguage: 'en', ...extra });
      assert.deepEqual(summaryOf(withKind), summaryOf(without), kind);
    }
  }
});

test('kind level: the kind structure wins over the map and the workspace; the run choice and the topic win over the kind level', async () => {
  const { store } = await world({ noteTemplateBlock: 'builtin:textbook', noteTemplateByKind: { hypothesis: 'builtin:hypothesis' } }, { [`${TPL}/Mine.md`]: '## Mine\nText.\n', [`${TPL}/Mine2.md`]: '## Mine2\nText.\n' });
  const request = extra => ({ outputLanguage: 'en', topicKind: 'hypothesis', map: { template: 'standard' }, ...extra });
  const got = store.runStyle(request({}));
  assert.equal(got.template.id, 'hypothesis');
  assert.equal(got.label.templateSource, 'kind');
  const topic = store.runStyle(request({ topic: { template: 'file:Mine' } }));
  assert.equal(topic.template.id, 'file:Mine');
  assert.equal(topic.label.templateSource, 'topic');
  const run = store.runStyle(request({ topic: { template: 'file:Mine' }, choice: { template: 'file:Mine2' } }));
  assert.equal(run.template.id, 'file:Mine2');
  assert.equal(run.label.templateSource, 'run');
  const mapOnly = store.runStyle({ outputLanguage: 'en', topicKind: 'evidence', map: { template: 'standard' } });
  assert.equal(mapOnly.label.templateSource, 'map', 'a kind with no value falls to the map');
  assert.equal(store.runStyle({ outputLanguage: 'en', topicKind: 'evidence' }).label.templateSource, 'workspace');
  assert.equal((await world({})).store.runStyle({ outputLanguage: 'en' }).label.templateSource, 'standard');
});

test('kind level: the kind structure comes with the same tone as without it, even when the map level is a style file that decides its own tone', async () => {
  const files = { [`${STYLES}/Free.md`]: FREE_TONE };
  const { store } = await world({ noteTemplateByKind: { hypothesis: 'builtin:hypothesis' } }, files);
  const base = { outputLanguage: 'en', map: { template: 'style:Free' } };
  const without = store.runStyle({ ...base });
  const got = store.runStyle({ ...base, topicKind: 'hypothesis' });
  assert.equal(without.toneText, 'Short sentences, friendly.');
  assert.equal(got.template.id, 'hypothesis');
  assert.equal(got.toneText, without.toneText);
  assert.equal(got.label.toneName, without.label.toneName);
  assert.deepEqual(plainOf(got.contextFields.styleSelection?.tone), plainOf(without.contextFields.styleSelection?.tone));
  // A topic that names a style file wins over the kind and decides its tone too.
  const topic = store.runStyle({ outputLanguage: 'en', topicKind: 'hypothesis', topic: { template: 'style:Free' } });
  assert.equal(topic.toneText, 'Short sentences, friendly.');
  assert.equal(topic.label.templateSource, 'topic');
});

test('kind level: a stored value that is a style file, an old template id or a random string is dropped on load and skipped by the store, with no toneDecided and no exception', async () => {
  const dirty = { topic: 'style:Free', action: 'standard', atomic: 'whatever', hypothesis: 'builtin:', evidence: '', conclusion: 7, bogus: 'builtin:hypothesis' };
  assert.equal(M.normalizeNoteTemplateByKind(dirty), undefined);
  assert.equal(M.normalizeNoteTemplateByKind([]), undefined);
  assert.equal(M.normalizeNoteTemplateByKind('x'), undefined);
  assert.equal(M.normalizeNoteTemplateByKind(null), undefined);
  assert.equal(M.normalizeNoteTemplateByKind({}), undefined);
  assert.deepEqual(plainOf(M.normalizeNoteTemplateByKind({ ...dirty, atomic: 'builtin:atomic', topic: 'file:Mine' })), { atomic: 'builtin:atomic', topic: 'file:Mine' });
  const files = { [`${STYLES}/Free.md`]: FREE_TONE };
  const none = await world({}, files);
  const { store } = await world({ noteTemplateByKind: dirty }, files);
  for (const kind of KINDS) {
    let got;
    assert.doesNotThrow(() => { got = store.runStyle({ outputLanguage: 'en', topicKind: kind }); }, kind);
    assert.deepEqual(summaryOf(got), summaryOf(none.store.runStyle({ outputLanguage: 'en' })), kind);
    assert.equal(got.toneText, undefined, `${kind}: no tone decided by a dropped style file`);
  }
});

test('kind level: a missing file is reported in missing and the next level is used', async () => {
  const { store } = await world({ noteTemplateByKind: { hypothesis: 'file:Nope' }, noteTemplateBlock: 'builtin:textbook' });
  const got = store.runStyle({ outputLanguage: 'en', topicKind: 'hypothesis', map: { template: 'standard' } });
  assert.deepEqual(plainOf(got.issues.missing), ['file:Nope']);
  assert.equal(got.template.id, 'standard');
  assert.equal(got.label.templateSource, 'map');
  const ws = store.runStyle({ outputLanguage: 'en', topicKind: 'hypothesis' });
  assert.deepEqual(plainOf(ws.issues.missing), ['file:Nope']);
  assert.equal(ws.template.id, 'textbook');
  assert.equal(ws.label.templateSource, 'workspace');
  const std = (await world({ noteTemplateByKind: { hypothesis: 'builtin:ghost' } })).store.runStyle({ outputLanguage: 'en', topicKind: 'hypothesis' });
  assert.deepEqual(plainOf(std.issues.missing), ['builtin:ghost']);
  assert.equal(std.label.templateSource, 'standard');
});

test('kind level: a broken file gets the built-in stand-in and block issues, and does not fall to the next level', async () => {
  const BROKEN = '## A\nbody\n# Format rules\nr\n# Format rules\nr2\n';
  const { store } = await world({ noteTemplateByKind: { evidence: 'file:Mine' }, noteTemplateBlock: 'builtin:textbook' }, { [`${TPL}/Mine.md`]: BROKEN });
  const got = store.runStyle({ outputLanguage: 'en', topicKind: 'evidence', map: { template: 'standard' } });
  assert.equal(got.label.templateSource, 'kind');
  assert.deepEqual(plainOf(got.issues.missing), []);
  assert.ok(got.issues.blockIssues.length > 0);
  assert.equal(got.issues.blockIssues[0].fileName, 'Mine.md');
  assert.equal(got.template.id, 'standard', 'a non-built-in broken block is stood in for by Standard, as at the other levels');
});

test('kind level: interface zh-TW, output language en, kind structure builtin:hypothesis gives the eight English headings', async () => {
  const { store } = await world({ language: 'zh-TW', noteTemplateByKind: { hypothesis: 'builtin:hypothesis' } });
  const got = store.runStyle({ outputLanguage: 'en', topicKind: 'hypothesis' });
  assert.deepEqual(plainOf(names(got.template)), HEADINGS.hypothesis.en);
  assert.equal(got.label.templateName, '假設結構');
  assert.equal(got.label.templateSource, 'kind');
  const { text } = promptOf(got, 'en');
  assert.ok(text.includes(HEADINGS.hypothesis.en.map(heading => `### ${heading}`).join(', ')));
  assert.equal(text.includes('### Core conclusions'), false);
});

test('kind level: a user file named like a built-in kind structure still resolves to that file when the workspace picks file:<name>', async () => {
  const { store } = await world({ noteTemplateBlock: 'file:假設結構' }, { [`${TPL}/假設結構.md`]: '## 自己的\n說明。\n' });
  const got = store.runStyle({ outputLanguage: 'en' });
  assert.deepEqual(plainOf(names(got.template)), ['自己的']);
  assert.equal(got.label.templateSource, 'workspace');
});

test('kind level: the i18n Notice text exists in three languages and names the type and the structure', () => {
  const kindName = { 'zh-TW': '假設', en: 'Hypothesis', 'zh-CN': '假设' };
  const text = language => M.translate(language, 'ui.note_style_kind_missing_0_1', kindName[language], 'Nope');
  assert.equal(text('zh-TW'), '為「假設」議題類型指定的筆記結構「Nope」找不到，這個議題改用下一順位的結構。');
  assert.equal(text('en'), 'The structure set for Hypothesis topics, "Nope", was not found; this topic uses the next one in line.');
  assert.equal(text('zh-CN'), '为「假设」议题类型指定的笔记结构「Nope」找不到，这个议题改用下一顺位的结构。');
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

test('kind level (view): topicStyle passes the topic\'s type, a topic without one counts as the general topic; mapStyle passes only the kind it is given', async () => {
  const { view } = await viewWorld({ noteTemplateByKind: { hypothesis: 'builtin:hypothesis', topic: 'builtin:atomic' } }, {});
  assert.equal(view.topicStyle({ topicKind: 'hypothesis' }, undefined, undefined, 'en').template.id, 'hypothesis');
  assert.equal(view.topicStyle({}, undefined, undefined, 'en').template.id, 'atomic');
  assert.equal(view.topicStyle({ topicKind: 'action' }, undefined, undefined, 'en').template.id, 'standard');
  assert.equal(view.mapStyle('en', { kind: 'hypothesis' }).template.id, 'hypothesis');
  assert.equal(view.mapStyle('en', { kind: 'topic' }).template.id, 'atomic');
  assert.equal(view.mapStyle('en').template.id, 'standard', 'a call site that gives no kind has no kind level');
});

test('kind level (view): a missing kind structure raises the kind Notice once per gate and never rewrites the topic', async () => {
  const note = { path: 'T.md', topicKind: 'hypothesis' };
  const { view, updates } = await viewWorld({ noteTemplateByKind: { hypothesis: 'file:Nope' } }, note);
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
  const { view } = await viewWorld({ noteTemplateByKind: { topic: 'file:Nope' } }, {});
  view.mapStyle('en', { kind: 'topic' });
  assert.equal(notices.length, 0);
  view.mapStyle('en', { kind: 'topic', notify: true });
  assert.equal(notices.length, 1);
  assert.match(notices[0], /Nope/);
});

test('decision 18: keep current (no explicit choice) writes no detail-template to the topic, even when the kind level applies', async () => {
  const note = { path: 'T.md', topicKind: 'hypothesis' };
  const { view, updates } = await viewWorld({ noteTemplateByKind: { hypothesis: 'builtin:hypothesis' } }, note);
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
  const view = fs.readFileSync(path.join(__dirname, '..', 'experiences/visual-map/view.ts'), 'utf8');
  assert.match(view, /runStyle\.label\.fileName \|\| runStyle\.label\.templateSource === "kind"\s*\?\s*runStyleLabelText\(runStyle\.label, language\)\s*:\s*undefined/);
  assert.match(view, /progress\?\.begin\(taskPath, progressAttempt, Date\.now\(\), used\.model, styleLine\)/);
  for (const lang of ['en', 'zh-TW', 'zh-CN']) assert.equal(fs.readFileSync(path.join(__dirname, '..', 'i18n', `${lang}.ts`), 'utf8').includes('progress_note_style_0'), false);
  assert.equal(view.includes('progress_note_style_0'), false);
});
