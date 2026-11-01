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
    assert.equal(got.noteStyle, undefined);
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
      assert.equal(got.noteStyle, undefined, `${templateId}/${toneId} ${writeLanguage}->${readLanguage}`);
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
  assert.ok(summary.noteStyle);
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
  assert.equal(ws.noteStyle.name, 'Own');
  assert.equal(ws.toneText, M.resolveToneText(PRESETS, ['plain'], 'en'));
  // academic at a specific level means no tone text and beats the file
  assert.equal(store.resolve([{ template: 'style:Free', tone: 'academic' }]).toneText, undefined);
  assert.equal(store.resolve([{ template: 'style:Own' }]).noteStyle.diagrams, undefined, 'the switches are not part of the parsed file any more (P2); the upgrade reads them');
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
      assert.ok(got.noteStyle, label);
      const own = tones.slice(0, at + 1).find(Boolean);
      assert.equal(got.toneText, own ? M.resolveToneText(PRESETS, [own], 'en') : fileTone[base], label);
    } else if (chosen === 'uuid-1') {
      assert.equal(got.fileName, 'My notes.md', label);
      assert.ok(got.noteStyle, label);
      assert.equal(got.toneText, M.resolveToneText(PRESETS, tones, 'en'), label);
    } else {
      // no style file decides: today's template and tone
      assert.equal(got.noteStyle, undefined, label);
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
  assert.ok(store.resolve([{ template: 'style:A' }]).noteStyle);
  v.files['WS/S/B.md'] = v.files[note]; delete v.files[note]; // renamed
  await store.refresh();
  eq(store.resolve([{ template: 'style:A' }]).missing, ['style:A']);
  assert.ok(store.resolve([{ template: 'style:B' }]).noteStyle);
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
  assert.ok(store.resolve([{ template: 'style:A' }]).noteStyle);
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

test('ensureStyleFolder: idempotent, five built-ins plus legacy export, detailTemplates and promptPresets unchanged, onload-style reads create nothing', async () => {
  const templates = M.normalizeTemplates([LEGACY]);
  const { store, v, settings, saves } = makeStore({ detailTemplates: templates });
  const templatesBefore = plain(settings.detailTemplates), presetsBefore = plain(settings.promptPresets);
  await store.refresh();
  assert.deepEqual(v.writes, [], 'refresh writes nothing');
  assert.equal(settings.noteStylesFolder, undefined);
  const folder = await store.ensureStyleFolder();
  assert.equal(folder, 'WS/Note styles');
  assert.equal(settings.noteStylesFolder, 'WS/Note styles');
  const after = JSON.stringify(v.files);
  assert.equal(v.writes.length, 6);
  eq(Object.keys(settings.noteStyleFiles), ['uuid-1']);
  await store.ensureStyleFolder();
  assert.equal(JSON.stringify(v.files), after);
  assert.equal(v.writes.length, 6);
  eq(settings.detailTemplates, templatesBefore);
  eq(settings.promptPresets, presetsBefore);
  assert.ok(saves() >= 1);
  // the written files are all "unchanged": resolution still equals today's
  await store.refresh();
  assert.equal(store.resolve([{ template: 'standard', tone: 'summary' }]).noteStyle, undefined);
  assert.equal(store.resolve([{ template: 'uuid-1' }]).noteStyle, undefined);
  assert.equal(store.list().filter(item => item.kind === 'builtin').length, 5);
  assert.equal(store.list().find(item => item.kind === 'legacy').id, 'uuid-1');
});

test('export conflicts: a different file (also different case) keeps its bytes, the export gets a unique name; builtin names taken by users too', async () => {
  const { store, v, settings } = makeStore({ noteStylesFolder: 'WS/S', detailTemplates: M.normalizeTemplates([LEGACY]) }, {
    'WS/S/my NOTES.md': 'the user\'s own file\n',
    'WS/S/Standard.md': '---\ntone: mine\n---\n## Mine\nstuff\n'
  });
  await store.ensureStyleFolder();
  assert.equal(v.files['WS/S/my NOTES.md'], 'the user\'s own file\n');
  assert.equal(v.files['WS/S/Standard.md'], '---\ntone: mine\n---\n## Mine\nstuff\n');
  assert.equal(settings.noteStyleFiles['uuid-1'], 'My notes (2).md');
  assert.ok(v.files['WS/S/My notes (2).md']);
  assert.ok(v.files['WS/S/Standard (2).md'], 'built-in written under a unique name');
  // the legacy uuid still resolves as before
  await store.refresh();
  eq(store.resolve([{ template: 'uuid-1' }]).template, todayTemplate(settings, ['uuid-1']).template);
  // the user's own file is a plain style
  assert.ok(store.resolve([{ template: 'style:Standard' }]).noteStyle);
});

test('lost mapping (downgrade): an unchanged export is adopted again, a changed one is not and the uuid keeps the data.json template', async () => {
  const exported = M.serializeLegacyV1(LEGACY, 'en');
  const a = makeStore({ noteStylesFolder: 'WS/S', detailTemplates: M.normalizeTemplates([LEGACY]) }, { 'WS/S/My notes.md': exported });
  await a.store.ensureStyleFolder();
  assert.equal(a.settings.noteStyleFiles['uuid-1'], 'My notes.md');
  assert.equal(Object.keys(a.v.files).filter(path => /My notes/.test(path)).length, 1);
  const changed = exported.replace('What we found.', 'Edited by hand.');
  const b = makeStore({ noteStylesFolder: 'WS/S', detailTemplates: M.normalizeTemplates([LEGACY]) }, { 'WS/S/My notes.md': changed });
  await b.store.ensureStyleFolder();
  assert.equal(b.v.files['WS/S/My notes.md'], changed);
  assert.equal(b.settings.noteStyleFiles['uuid-1'], 'My notes (2).md');
  eq(b.store.resolve([{ template: 'uuid-1' }]).template, todayTemplate(b.settings, ['uuid-1']).template);
});

test('restore default: trash first, then the standard content; a non-builtin file is refused', async () => {
  const { store, v } = makeStore({ noteStylesFolder: 'WS/S' }, { 'WS/S/Textbook.md': M.canonicalContent('textbook', 'en').replace('3–5', '9'), 'WS/S/Mine.md': 'x', 'WS/S/Standard.md': '---\ntone: mine\n---\n## Mine\nstuff\n', 'WS/S/Plain.md': 'x' });
  const order = [];
  const trash = v.port.trash, create = v.port.create;
  v.port.trash = async path => { order.push('trash'); return trash(path); };
  v.port.create = async (path, content) => { order.push('create'); return create(path, content); };
  assert.equal(await store.restoreDefault('WS/S/Mine.md'), false);
  // a user's file called like a built-in is a style: file, so it is neither offered nor restored (before and after refresh())
  assert.equal(await store.restoreDefault('WS/S/Standard.md'), false);
  assert.equal(await store.restoreDefault('WS/S/Plain.md'), false);
  assert.equal(order.length, 0);
  await store.refresh();
  assert.equal(store.builtinIdOfFile('Standard.md'), undefined);
  assert.equal(store.builtinIdOfFile('Standard'), undefined);
  assert.equal(store.builtinIdOfFile('Textbook.md').id, 'textbook');
  assert.equal(await store.restoreDefault('WS/S/Standard.md'), false);
  assert.equal(await store.restoreDefault('WS/S/Textbook.md'), true);
  eq(order, ['trash', 'create']);
  eq(v.trashed.map(item => item.path), ['WS/S/Textbook.md']);
  assert.match(v.trashed[0].content, /Textbook|9/);
  assert.equal(v.files['WS/S/Standard.md'], '---\ntone: mine\n---\n## Mine\nstuff\n');
  assert.equal(v.files['WS/S/Textbook.md'], M.canonicalContent('textbook', 'en'));
});

test('restore default writes v2, and a v1 file is still unmodified (restorable) while a changed one is not', async () => {
  const v1 = M.CANONICAL_VERSIONS[0].textbook.en;
  assert.ok(!v1.includes('summary callout'));
  const { store, v } = makeStore({ noteStylesFolder: 'WS/S' }, { 'WS/S/Textbook.md': v1.replace('3–5', '9') });
  await store.refresh();
  assert.equal(await store.restoreDefault('WS/S/Textbook.md'), true);
  assert.equal(v.files['WS/S/Textbook.md'], M.CANONICAL_VERSIONS[1].textbook.en);
  assert.ok(v.files['WS/S/Textbook.md'].includes('summary callout: summary'));
  const old = makeStore({ noteStylesFolder: 'WS/S' }, { 'WS/S/Textbook.md': v1 });
  await old.store.refresh();
  assert.equal(M.matchCanonical(v1).version, 1);
  assert.equal(old.store.builtinIdOfFile('Textbook.md').id, 'textbook');
  assert.equal(old.v.writes.length, 0);
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
