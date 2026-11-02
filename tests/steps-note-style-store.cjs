// Note style store (P2): resolution chain, "unchanged = today's path", legacy role inheritance, export, restore, lifecycle.
// Unit and integration level over an in-memory vault; the Obsidian wiring in main.ts is covered by UI/live checks.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadSource } = require('./support-replay.cjs');

const M = loadSource(`
export * from "./ai/note-style-store";
export * from "./ai/note-style-file";
export { resolveTemplate, standardTemplate, textbookTemplate, normalizeTemplates, sectionLookup, checkCounts } from "./ai/detail-templates";
export { resolveToneText } from "./ai/prompt-presets";
export { canonicalDetail } from "./ai/result-utils";
export { AiTaskService } from "./core/ai-task-service";
export { builtinBlockText } from "./core/blocks/block-files";
`);
const plain = value => JSON.parse(JSON.stringify(value));
const eq = (actual, expected) => assert.deepEqual(plain(actual), plain(expected));

const LEGACY = {
  id: 'uuid-1',
  name: 'My notes',
  sections: [
    { id: 'a', name: 'Findings', description: 'What we found.', role: 'none', count: { mode: 'min', n: 3 }, aliases: [] },
    { id: 'b', name: 'Refs', description: '', role: 'sources', aliases: ['Sources'] },
    { id: 'c', name: 'History', description: 'One dated line.', role: 'log', aliases: [] }
  ]
};
const PRESETS = [{ id: 'custom-tone-1', kind: 'tone', name: 'Pirate', text: 'Talk like a pirate.' }];

function vault(files = {}, folders = new Set()) {
  const state = { files: { ...files }, folders, trashed: [], writes: [], reads: 0 };
  const under = folder => Object.keys(state.files).filter(path => path.startsWith(`${folder}/`) && !path.slice(folder.length + 1).includes('/'));
  state.port = {
    list: async folder => under(folder).map(path => path.slice(folder.length + 1)).filter(name => name.endsWith('.md')),
    read: async path => { state.reads++; if (!(path in state.files)) throw new Error(path); return state.files[path]; },
    folderExists: path => state.folders.has(path) || under(path).length > 0,
    createFolder: async path => { state.folders.add(path); },
    create: async (path, content) => {
      if (Object.keys(state.files).some(existing => existing.toLowerCase() === path.toLowerCase())) throw new Error(`exists: ${path}`);
      state.files[path] = content; state.writes.push(path);
    },
    trash: async path => { state.trashed.push({ path, content: state.files[path] }); delete state.files[path]; }
  };
  return state;
}
function makeStore(settingsPatch = {}, files = {}) {
  const v = vault(files);
  const settings = { detailTemplates: [], promptPresets: PRESETS, workspaceFolder: 'WS', language: 'en', ...settingsPatch };
  let saves = 0;
  const store = new M.NoteStyleStore({ settings: () => settings, port: v.port, save: async () => { saves++; } });
  return { store, v, settings, saves: () => saves };
}
const todayTemplate = (settings, ids, language = 'en') => M.resolveTemplate(settings.detailTemplates, ids, language === 'en' ? 'en' : 'zh-TW');

test('no folder, no new keys: resolution equals resolveTemplate + resolveToneText over the matrix', async () => {
  const { store, settings } = makeStore({ detailTemplates: M.normalizeTemplates([LEGACY]) });
  await store.refresh();
  const templates = [undefined, 'standard', 'textbook', 'uuid-1', 'gone'];
  const tones = [undefined, 'summary', 'plain', 'guide', 'custom-tone-1', 'academic', 'nope'];
  for (const topic of templates) for (const map of templates) for (const noteTone of tones) for (const mapTone of tones) for (const workspace of [undefined, 'textbook', 'uuid-1']) {
    settings.defaultDetailTemplateId = workspace;
    const got = store.resolve([{ template: undefined }, { template: topic, tone: noteTone }, { template: map, tone: mapTone }]);
    const want = todayTemplate(settings, [undefined, topic, map, workspace]);
    eq(got.template, want.template);
    eq(got.missing, want.missing);
    assert.equal(got.toneText, M.resolveToneText(PRESETS, [undefined, noteTone, mapTone], 'en'));
    assert.equal(got.toneDecided, undefined);
    assert.equal(got.invalid, undefined);
  }
});

test('unchanged files take today\'s path: builtins in any written language, CRLF and trailing spaces, exported legacy, missing keys', async () => {
  for (const writeLanguage of ['zh-TW', 'zh-CN', 'en']) for (const readLanguage of ['en', 'zh-TW']) {
    const files = {};
    for (const id of M.NOTE_STYLE_BUILTIN_IDS)
      files[`WS/S/${M.builtinStyleFileName(id, writeLanguage)}.md`] = M.canonicalContent(id, writeLanguage).replace(/\n/g, ' \r\n');
    files['WS/S/My notes.md'] = M.serializeLegacyV1(LEGACY, writeLanguage).replace(/\n/g, '\r\n');
    const { store, settings } = makeStore({ language: readLanguage, noteStylesFolder: 'WS/S', detailTemplates: M.normalizeTemplates([LEGACY]), noteStyleFiles: { 'uuid-1': 'My notes.md' } }, files);
    await store.refresh();
    for (const [templateId, toneId] of [['standard', undefined], ['textbook', undefined], ['standard', 'summary'], ['standard', 'plain'], ['standard', 'guide'], ['uuid-1', 'plain']]) {
      const got = store.resolve([{ template: templateId, tone: toneId }]);
      const want = todayTemplate(settings, [templateId], readLanguage);
      eq(got.template, want.template);
      assert.equal(got.toneText, M.resolveToneText(PRESETS, [toneId], readLanguage));
      assert.equal(got.toneDecided, undefined, `${templateId}/${toneId} ${writeLanguage}->${readLanguage}`);
    }
  }
  // the three new keys missing (downgrade) with the exported file still in the folder
  const { store, settings } = makeStore({ noteStylesFolder: 'WS/S', detailTemplates: M.normalizeTemplates([LEGACY]) }, { 'WS/S/My notes.md': 'whatever' });
  await store.refresh();
  eq(store.resolve([{ template: 'uuid-1' }]).template, todayTemplate(settings, ['uuid-1']).template);
});

test('an edited built-in file decides template and tone; an edited exported file keeps roles and aliases of its old sections', async () => {
  const edited = M.canonicalContent('summary', 'en').replace('3–5', '2–4');
  const { store } = makeStore({ noteStylesFolder: 'WS/S', detailTemplates: M.normalizeTemplates([LEGACY]), noteStyleFiles: { 'uuid-1': 'My notes.md' } }, {
    'WS/S/Key points.md': edited,
    'WS/S/My notes.md': M.serializeLegacyV1(LEGACY, 'en').replace('What we found.', 'What we really found.')
  });
  await store.refresh();
  const summary = store.resolve([{ template: 'standard', tone: 'summary' }]);
  assert.ok(summary.toneDecided);
  assert.equal(summary.fileName, 'Key points.md');
  const legacy = store.resolve([{ template: 'uuid-1', tone: 'plain' }]);
  assert.equal(legacy.fileName, 'My notes.md');
  const roles = Object.fromEntries(legacy.template.sections.map(section => [section.name, section.role]));
  eq(roles, { Findings: 'none', Refs: 'sources', History: 'log' });
  assert.ok(legacy.template.sections.find(section => section.name === 'Refs').aliases.includes('Sources'));
  assert.ok(M.sectionLookup(legacy.template).has('sources'));
  assert.equal(legacy.toneText, M.resolveToneText(PRESETS, ['plain'], 'en'));
  assert.match(legacy.template.sections[0].description, /really/);
  // count lines of the file reach checkCounts
  assert.equal(M.checkCounts('### Findings\n#### a\n', legacy.template).length, 1);
});

const OWNER = '---\n語氣: Pirate\n圖表: 關\n---\n導讀。\n\n## 核心結論\n> [!summary]\n> 講結論。\n';
const FREE = '---\ntone: Short sentences, friendly.\n---\n## A\ntext\n';

test('tone: the file\'s tone is a name or free text; a same or more specific level wins; the less specific level does not', async () => {
  const { store } = makeStore({ noteStylesFolder: 'WS/S', defaultNoteStyleId: 'style:Own' }, { 'WS/S/Own.md': OWNER, 'WS/S/Free.md': FREE });
  await store.refresh();
  // file named by tone name: full text of the preset
  assert.equal(store.resolve([{ template: 'style:Own' }]).toneText, 'Talk like a pirate.');
  assert.equal(store.resolve([{ template: 'style:Free' }]).toneText, 'Short sentences, friendly.');
  // topic picks the style, map has a tone (less specific): the file's tone wins
  assert.equal(store.resolve([{ template: 'style:Free' }, { tone: 'plain' }]).toneText, 'Short sentences, friendly.');
  // topic has a tone at the same level as the style: that tone wins
  const same = store.resolve([{ template: 'style:Free', tone: 'plain' }]);
  assert.equal(same.toneText, M.resolveToneText(PRESETS, ['plain'], 'en'));
  // the style is chosen at the workspace: every tone level is more specific
  const ws = store.resolve([{ tone: 'plain' }]);
  assert.equal(ws.fileName, 'Own.md');
  assert.equal(ws.toneText, M.resolveToneText(PRESETS, ['plain'], 'en'));
  // academic at a specific level means no tone text and beats the file
  assert.equal(store.resolve([{ template: 'style:Free', tone: 'academic' }]).toneText, undefined);
});

// Scope 5 matrix: topic x map in {none, template only, tone only, template + tone}, x workspace in {none, textbook,
// defaultNoteStyleId = style:S (S has a tone), old uuid exported and edited}. The oracle below is written from the rule,
// not from the store: the first level whose template can be used decides the style; a style file takes the tone of its own
// or a more specific level, else its own `tone`; an old template's file takes the whole chain; no file = today's path.
test('resolution matrix (topic x map x workspace x file tone): 4 x 4 x 4 x 2 = 128 cells follow Scope 5', async () => {
  const S = '---\ntone: Pirate\n---\n## A\ntext\n';
  const T = '---\n---\n## A\ntext\n';
  const U = FREE;
  const editedLegacy = M.serializeLegacyV1(LEGACY, 'en').replace('What we found.', 'What we really found.');
  const files = { 'WS/S/S.md': S, 'WS/S/T.md': T, 'WS/S/U.md': U, 'WS/S/My notes.md': editedLegacy };
  const fileTone = { S: 'Talk like a pirate.', T: undefined, U: 'Short sentences, friendly.' };
  const states = file => [
    {},
    { template: `style:${file}` },
    { tone: 'plain' },
    { template: `style:${file}`, tone: 'plain' }
  ];
  const workspaces = [
    { name: 'none', patch: {} },
    { name: 'textbook', patch: { defaultDetailTemplateId: 'textbook' } },
    { name: 'style:S', patch: { defaultNoteStyleId: 'style:S' } },
    { name: 'old uuid', patch: { defaultDetailTemplateId: 'uuid-1' } }
  ];
  let cells = 0;
  for (const file of ['T', 'U']) for (const topic of states(file)) for (const map of states(file)) for (const ws of workspaces) {
    const { store, settings } = makeStore({
      noteStylesFolder: 'WS/S', detailTemplates: M.normalizeTemplates([LEGACY]), noteStyleFiles: { 'uuid-1': 'My notes.md' }, ...ws.patch
    }, files);
    await store.refresh();
    const got = store.resolve([topic, map]);
    // oracle
    const levels = [topic, map, { template: ws.patch.defaultNoteStyleId ?? ws.patch.defaultDetailTemplateId }];
    const at = levels.findIndex(level => level.template);
    const chosen = at < 0 ? undefined : levels[at].template;
    const tones = levels.map(level => level.tone);
    const label = `${file} topic=${JSON.stringify(topic)} map=${JSON.stringify(map)} ws=${ws.name}`;
    if (chosen?.startsWith('style:')) {
      const base = chosen.slice(6);
      assert.equal(got.fileName, `${base}.md`, label);
      assert.ok(got.toneDecided, label);
      const own = tones.slice(0, at + 1).find(Boolean);
      assert.equal(got.toneText, own ? M.resolveToneText(PRESETS, [own], 'en') : fileTone[base], label);
    } else if (chosen === 'uuid-1') {
      assert.equal(got.fileName, 'My notes.md', label);
      assert.ok(got.toneDecided, label);
      assert.equal(got.toneText, M.resolveToneText(PRESETS, tones, 'en'), label);
    } else {
      // no style file decides: today's template and tone
      assert.equal(got.toneDecided, undefined, label);
      eq(got.template, todayTemplate(settings, [undefined, undefined, chosen]).template);
      assert.equal(got.toneText, M.resolveToneText(PRESETS, tones, 'en'), label);
    }
    eq(got.missing, [], label);
    cells++;
  }
  assert.equal(cells, 128);
});

test('missing and invalid style files: next level is used, missing names the id, a bad file stops with its line, nothing is written', async () => {
  const { store, v } = makeStore({ noteStylesFolder: 'WS/S', defaultDetailTemplateId: 'textbook' }, { 'WS/S/Bad.md': '---\ntone: x\n---\nno sections here\n' });
  await store.refresh();
  const before = JSON.stringify(v.files);
  const gone = store.resolve([{ template: 'style:Gone' }, { template: 'style:Gone' }]);
  eq(gone.missing, ['style:Gone', 'style:Gone']);
  assert.equal(gone.template.id, 'textbook');
  const bad = store.resolve([{ template: 'style:Bad' }]);
  assert.equal(bad.invalid.fileName, 'Bad.md');
  assert.ok(bad.invalid.issues[0].line >= 1);
  assert.equal(JSON.stringify(v.files), before);
  assert.deepEqual(v.writes, []);
  // case differs: the file name is the identity
  eq(store.resolve([{ template: 'style:bad' }]).missing, ['style:bad']);
});

test('lifecycle: rename, move out and back, delete, and a new file with the old name', async () => {
  const note = 'WS/S/A.md';
  const { store, v } = makeStore({ noteStylesFolder: 'WS/S' }, { [note]: FREE });
  await store.refresh();
  assert.ok(store.resolve([{ template: 'style:A' }]).toneDecided);
  v.files['WS/S/B.md'] = v.files[note]; delete v.files[note]; // renamed
  await store.refresh();
  eq(store.resolve([{ template: 'style:A' }]).missing, ['style:A']);
  assert.ok(store.resolve([{ template: 'style:B' }]).toneDecided);
  v.files[note] = '---\ntone: New A.\n---\n## X\nnew\n'; // someone creates A again: that is style A (contract), label shows A.md
  await store.refresh();
  const again = store.resolve([{ template: 'style:A' }]);
  assert.equal(again.fileName, 'A.md');
  assert.equal(again.toneText, 'New A.');
  v.files['WS/Other/A.md'] = v.files[note]; delete v.files[note]; // moved out
  await store.refresh();
  eq(store.resolve([{ template: 'style:A' }]).missing, ['style:A']);
  v.files[note] = v.files['WS/Other/A.md']; // moved back
  await store.refresh();
  assert.ok(store.resolve([{ template: 'style:A' }]).toneDecided);
});

test('snapshot: a file edited after refresh() changes nothing until the next refresh()', async () => {
  const { store, v } = makeStore({ noteStylesFolder: 'WS/S' }, { 'WS/S/A.md': FREE });
  await store.refresh();
  const first = store.resolve([{ template: 'style:A' }]);
  v.files['WS/S/A.md'] = '---\ntone: Changed.\n---\n## X\nx\n';
  assert.equal(store.resolve([{ template: 'style:A' }]).toneText, first.toneText);
  await store.refresh();
  assert.equal(store.resolve([{ template: 'style:A' }]).toneText, 'Changed.');
});

const BLOCKS = 'WS/Note styles/Blocks';
const TEMPLATES_DIR = `${BLOCKS}/Templates`;

test('D12 (was ensureStyleFolder): no style file is written any more; opening the block folder writes only folders; the old template becomes one block once; the old keys are kept', async () => {
  const templates = M.normalizeTemplates([LEGACY]);
  const { store, v, settings } = makeStore({ detailTemplates: templates, promptPresets: [] });
  const templatesBefore = plain(settings.detailTemplates), presetsBefore = plain(settings.promptPresets);
  await store.refresh();
  assert.deepEqual(v.writes, [], 'refresh writes nothing');
  assert.equal(settings.noteStylesFolder, undefined);
  assert.equal(store.ensureStyleFolder, undefined);
  assert.equal(store.unexportedTemplates, undefined);
  assert.equal(store.list, undefined);
  assert.equal(await store.ensureBlockFolder(), BLOCKS);
  assert.equal(settings.noteStylesFolder, 'WS/Note styles', 'the folder is remembered, as ensureStyleFolder did');
  assert.deepEqual(v.writes, [], 'only folders: not even the five built-in style files');
  assert.ok(v.folders.has(TEMPLATES_DIR) && v.folders.has(`${BLOCKS}/Tones`));
  assert.equal((await store.upgradeLegacy()).status, 'done');
  eq(v.writes, [`${TEMPLATES_DIR}/My notes.md`]);
  const after = JSON.stringify(v.files);
  await store.upgradeLegacy();
  assert.equal(JSON.stringify(v.files), after);
  assert.equal(v.writes.length, 1);
  eq(settings.detailTemplates, templatesBefore);
  eq(settings.promptPresets, presetsBefore);
  assert.equal(settings.noteStyleFiles, undefined, 'nothing is exported to a style file any more');
  await store.refresh();
  assert.equal(store.resolve([{ template: 'standard', tone: 'summary' }]).toneDecided, undefined);
  const moved = store.resolve([{ template: 'uuid-1' }]);
  assert.ok(moved.block, 'the old template runs as its block');
  eq(moved.template.sections.map(section => section.name), LEGACY.sections.map(section => section.name));
  eq(store.listBlocks('template').map(item => [item.kind, item.name]), [['builtin', 'Standard'], ['builtin', 'Textbook'], ['file', 'My notes']]);
});

test('D12 (was export conflicts): a user file with the name (also another case) keeps its bytes; the old template takes a unique name and its id points at it', async () => {
  const { store, v, settings } = makeStore({ noteStylesFolder: 'WS/Note styles', detailTemplates: M.normalizeTemplates([LEGACY]) }, {
    [`${TEMPLATES_DIR}/my NOTES.md`]: 'the user\'s own file\n'
  });
  await store.upgradeLegacy();
  assert.equal(v.files[`${TEMPLATES_DIR}/my NOTES.md`], 'the user\'s own file\n');
  assert.ok(v.files[`${TEMPLATES_DIR}/My notes (2).md`]);
  assert.equal(settings.noteStyleAliases['uuid-1'].template, 'file:My notes (2)');
  await store.refresh();
  eq(store.resolve([{ template: 'uuid-1' }]).template.sections.map(section => section.name), LEGACY.sections.map(section => section.name));
  assert.equal(Object.keys(v.files).filter(path => path.startsWith(TEMPLATES_DIR)).length, 2);
});

test('D12 (was lost mapping): a block file with the upgrade\'s own text is reused, a changed one is not and the old template takes a new name', async () => {
  const first = makeStore({ noteStylesFolder: 'WS/Note styles', promptPresets: [], detailTemplates: M.normalizeTemplates([LEGACY]) });
  await first.store.upgradeLegacy();
  const written = first.v.files[`${TEMPLATES_DIR}/My notes.md`];
  assert.ok(written);
  const same = makeStore({ noteStylesFolder: 'WS/Note styles', promptPresets: [], detailTemplates: M.normalizeTemplates([LEGACY]) }, { [`${TEMPLATES_DIR}/My notes.md`]: written });
  await same.store.upgradeLegacy();
  assert.deepEqual(same.v.writes, [], 'nothing new was written');
  assert.equal(same.settings.noteStyleAliases['uuid-1'].template, 'file:My notes');
  const changed = written.replace('What we found.', 'Edited by hand.');
  assert.notEqual(changed, written);
  const other = makeStore({ noteStylesFolder: 'WS/Note styles', detailTemplates: M.normalizeTemplates([LEGACY]) }, { [`${TEMPLATES_DIR}/My notes.md`]: changed });
  await other.store.upgradeLegacy();
  assert.equal(other.v.files[`${TEMPLATES_DIR}/My notes.md`], changed);
  assert.equal(other.settings.noteStyleAliases['uuid-1'].template, 'file:My notes (2)');
});

test('D12 (was restore default): the old restoreDefault and builtinIdOfFile are gone; restoreBlock backs a changed built-in up, then trashes it, and refuses an own block', async () => {
  const { store, v } = makeStore({ noteStylesFolder: 'WS/Note styles' }, {
    [`${TEMPLATES_DIR}/Textbook.md`]: M.builtinBlockText('template', 'textbook', 'en') + '\nA line of mine.\n',
    [`${TEMPLATES_DIR}/Mine.md`]: '## A\ntext\n'
  });
  assert.equal(store.restoreDefault, undefined);
  assert.equal(store.builtinIdOfFile, undefined);
  const order = [];
  const trash = v.port.trash, create = v.port.create;
  v.port.trash = async path => { order.push('trash'); return trash(path); };
  v.port.create = async (path, content) => { order.push('create'); return create(path, content); };
  const refused = await store.restoreBlock('template', 'file:Mine');
  assert.deepEqual(plain(refused), { ok: false, reason: 'not-builtin' });
  assert.equal(order.length, 0);
  const done = await store.restoreBlock('template', 'builtin:textbook');
  assert.equal(done.ok, true);
  eq(order, ['create', 'trash']);
  assert.match(v.files[done.backup], /A line of mine/);
  eq(v.trashed.map(item => item.path), [`${TEMPLATES_DIR}/Textbook.md`]);
  assert.equal(v.files[`${TEMPLATES_DIR}/Mine.md`], '## A\ntext\n');
});

test('D8 (the map pickers\' data source): a template block is picked at any level as file:<name>, the tone chain still applies, a missing block is "missing"', async () => {
  const { store } = makeStore({ noteStylesFolder: 'WS/Note styles' }, { [`${TEMPLATES_DIR}/Mine.md`]: '## A\ntext\n' });
  await store.refresh();
  const run = store.resolve([{ template: 'file:Mine' }]);
  assert.ok(run.block);
  assert.equal(run.template.id, 'file:Mine');
  eq(run.missing, []);
  assert.equal(store.toneTextFor(run.template, ['plain'], 'en'), M.resolveToneText(PRESETS, ['plain'], 'en'), 'the layer\'s tone is not dropped');
  assert.equal(store.resolve([{}, { template: 'file:Mine' }]).block.fileName, 'Mine.md');
  const gone = store.resolve([{ template: 'file:Gone' }, { template: 'textbook' }]);
  eq(gone.missing, ['file:Gone']);
  assert.equal(gone.template.id, 'textbook');
});

test('D8 (tones): the tone choices are the built-in tones and the tone blocks; an upgraded custom preset keeps its name through its alias; a tone block is picked as file:<name>', async () => {
  const { store, v } = makeStore({ noteStylesFolder: 'WS/Note styles' }, { [`${BLOCKS}/Tones/Calm.md`]: 'Speak calmly.\n' });
  await store.upgradeLegacy();
  await store.refresh();
  const choices = store.toneChoices();
  assert.ok(['academic', 'summary', 'plain'].every(id => choices.some(choice => choice.id === id)), 'the built-in tones come by tone id');
  assert.ok(choices.some(choice => choice.id === 'file:Calm' && choice.name === 'Calm'));
  assert.ok(choices.some(choice => choice.id === 'file:Pirate' && choice.name === 'Pirate'), 'the custom preset is a tone block now');
  assert.ok(!choices.some(choice => choice.id === 'custom-tone-1'));
  assert.equal(store.toneName('custom-tone-1'), 'Pirate');
  assert.equal(store.toneName('file:Calm'), 'Calm');
  assert.equal(store.toneName('summary'), choices.find(choice => choice.id === 'summary').name);
  assert.equal(store.toneName('nothing'), undefined);
  assert.equal(store.toneTextFor(undefined, ['file:Calm'], 'en'), 'Speak calmly.');
  assert.equal(store.toneTextFor(undefined, ['custom-tone-1'], 'en'), 'Talk like a pirate.');
  assert.equal(store.toneTextFor(undefined, ['file:Gone', 'plain'], 'en'), M.resolveToneText(PRESETS, ['plain'], 'en'), 'a tone block that is gone names nothing');
  assert.ok(Object.keys(v.files).some(path => path.includes('/Tones/Pirate')));
});

test('folder rename follows the folder only; default folder name follows the language', async () => {
  const { store, settings, saves } = makeStore({ noteStylesFolder: 'WS/S' });
  assert.equal(await store.followFolderRename('WS/Other', 'WS/X'), false);
  assert.equal(await store.followFolderRename('WS/S', 'WS/Renamed'), true);
  assert.equal(settings.noteStylesFolder, 'WS/Renamed');
  assert.equal(saves(), 1);
  assert.equal(makeStore({ language: 'zh-CN' }).store.folder(), 'WS/笔记风格');
  assert.equal(makeStore({ language: 'zh-TW' }).store.folder(), 'WS/筆記風格');
  assert.equal(store.folderExists(), false);
});

test('diagrams off (P2: through the upgrade): the old flag is not in the context; after the upgrade the block has no mermaid line and no chart step is eligible (research and synthesis)', async () => {
  const { store } = makeStore({ noteStylesFolder: 'WS/S' }, { 'WS/S/Own.md': OWNER, 'WS/S/Free.md': FREE });
  await store.refresh();
  const service = new M.AiTaskService({ pluginDirectory: () => '/plugin', language: () => 'en', defaultReasoning: () => 'low', exchangeLoggingEnabled: () => false, diagramsEnabled: () => true });
  const base = { title: 'T', summary: 's', rules: '', detail: '', task: 'x', ancestors: '', addCharts: true };
  // before the upgrade the old path carries no switch: neither styleDiagrams nor noteStyle is in the context any more
  eq(store.contextFields(store.resolve([{ template: 'style:Own' }]).template), {});
  assert.equal((await store.upgradeLegacy()).status, 'done');
  await store.refresh();
  for (const mode of ['task', 'synthesize']) {
    const off = store.resolve([{ template: 'style:Own' }]);
    const fields = store.contextFields(off.template);
    eq(Object.keys(fields), ['styleSelection']);
    assert.ok(!fields.styleSelection.template.body.includes('```mermaid'));
    assert.equal(service.chartEligible({ ...base, mode, ...fields }), false);
    const on = store.resolve([{ template: 'style:Free' }]);
    assert.equal(service.chartEligible({ ...base, mode, ...store.contextFields(on.template) }), true);
  }
  eq(store.contextFields(store.resolve([{ template: 'standard' }]).template), {});
});
