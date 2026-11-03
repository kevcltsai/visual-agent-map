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
export { splitTemplateZones } from "./core/blocks/template-block";
`);
const plain = value => JSON.parse(JSON.stringify(value));
const eq = (actual, expected) => assert.deepEqual(plain(actual), plain(expected));
// A request from the old per-level lists: the first level is the topic, the second the map; outputLanguage is the interface language.
const request = (levels, outputLanguage = 'en', choice) => ({ topic: levels[0], map: levels[1], ...(choice ? { choice } : {}), outputLanguage });

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

test('no folder, no new keys (was: topic x map x workspace matrix; grilling Q10/Q15): the old topic template and tone give the 0.28.0 template and tone over the matrix; the map and the workspace default do not matter', async () => {
  const { store, settings } = makeStore({ detailTemplates: M.normalizeTemplates([LEGACY]) });
  await store.refresh();
  const templates = [undefined, 'standard', 'textbook', 'uuid-1', 'gone'];
  const tones = [undefined, 'summary', 'plain', 'guide', 'custom-tone-1', 'academic', 'nope'];
  for (const topic of templates) for (const map of templates) for (const noteTone of tones) for (const mapTone of tones) for (const workspace of [undefined, 'textbook', 'uuid-1']) {
    settings.defaultDetailTemplateId = workspace;
    const got = store.runStyle(request([{ template: topic, tone: noteTone }, { template: map, tone: mapTone }]));
    const want = todayTemplate(settings, [topic]);
    eq(got.template, want.template);
    // R1-L1 (T6 P3): a topic tone that names nothing is reported after the structure (academic rigor still stands in).
    eq(got.issues.missing, [...want.missing, ...(noteTone === 'nope' ? ['nope'] : [])]);
    assert.equal(got.toneText, M.resolveToneText(PRESETS, [noteTone], 'en'));
    assert.equal(got.label.fileName, undefined);
    assert.equal(got.issues.invalid, undefined);
  }
});

test('old style files (was: unchanged files take today\'s path; grilling Q12): old style files in the folder, in any written language, are not read: the 0.28.0 template and tone come out, with no file name', async () => {
  for (const writeLanguage of ['zh-TW', 'zh-CN', 'en']) for (const readLanguage of ['en', 'zh-TW']) {
    const files = {};
    for (const name of ['Standard', 'Key points', '精簡重點'])
      files[`WS/S/${name}.md`] = `---\n語氣: 簡明\n---\n## 重點\n${writeLanguage}\n`.replace(/\n/g, ' \r\n');
    files['WS/S/My notes.md'] = M.serializeLegacyV1(LEGACY, writeLanguage).replace(/\n/g, '\r\n');
    const { store, settings } = makeStore({ language: readLanguage, noteStylesFolder: 'WS/S', detailTemplates: M.normalizeTemplates([LEGACY]), noteStyleFiles: { 'uuid-1': 'My notes.md' } }, files);
    await store.refresh();
    for (const [templateId, toneId] of [['standard', undefined], ['textbook', undefined], ['standard', 'summary'], ['standard', 'plain'], ['standard', 'guide'], ['uuid-1', 'plain']]) {
      const got = store.runStyle(request([{ template: templateId, tone: toneId }], readLanguage));
      const want = todayTemplate(settings, [templateId], readLanguage);
      eq(got.template, want.template);
      assert.equal(got.toneText, M.resolveToneText(PRESETS, [toneId], readLanguage));
      assert.equal(got.label.fileName, undefined, `${templateId}/${toneId} ${writeLanguage}->${readLanguage}`);
    }
  }
  // the exported file still in the folder, with the keys missing (downgrade)
  const { store, settings } = makeStore({ noteStylesFolder: 'WS/S', detailTemplates: M.normalizeTemplates([LEGACY]) }, { 'WS/S/My notes.md': 'whatever' });
  await store.refresh();
  eq(store.runStyle(request([{ template: 'uuid-1' }])).template, todayTemplate(settings, ['uuid-1']).template);
});

test('edited old files (was: an edited built-in file decides template and tone; grilling Q12/decision #22): an edited style file or an edited exported file changes nothing; the roles and aliases come from the saved template', async () => {
  const edited = '---\n語氣: 簡明\n---\n## 重點\n說明 2–4\n';
  const { store } = makeStore({ noteStylesFolder: 'WS/S', detailTemplates: M.normalizeTemplates([LEGACY]), noteStyleFiles: { 'uuid-1': 'My notes.md' } }, {
    'WS/S/Key points.md': edited,
    'WS/S/My notes.md': M.serializeLegacyV1(LEGACY, 'en').replace('What we found.', 'What we really found.')
  });
  await store.refresh();
  const summary = store.runStyle(request([{ template: 'standard', tone: 'summary' }]));
  assert.equal(summary.label.fileName, undefined);
  assert.equal(summary.toneText, M.resolveToneText(PRESETS, ['summary'], 'en'));
  const legacy = store.runStyle(request([{ template: 'uuid-1', tone: 'plain' }]));
  assert.equal(legacy.label.fileName, undefined);
  const roles = Object.fromEntries(legacy.template.sections.map(section => [section.name, section.role]));
  eq(roles, { Findings: 'none', Refs: 'sources', History: 'log' });
  assert.ok(legacy.template.sections.find(section => section.name === 'Refs').aliases.includes('Sources'));
  assert.ok(M.sectionLookup(legacy.template).has('sources'));
  assert.equal(legacy.toneText, M.resolveToneText(PRESETS, ['plain'], 'en'));
  assert.match(legacy.template.sections[0].description, /found/);
  assert.doesNotMatch(legacy.template.sections[0].description, /really/);
  // count lines of the saved template reach checkCounts
  assert.equal(M.checkCounts('### Findings\n#### a\n', legacy.template).length, 1);
});


test('voice names (was: the style file\'s tone is a name or free text; grilling Q12): a style file names its voice by a built-in name in any language or by an own file; a run tone replaces it', async () => {
  const RECIPES = 'WS/S/Styles';
  const recipe = voice => `---\nvoice: ${voice}\n---\n`;
  const { store } = makeStore({ noteStylesFolder: 'WS/S', noteStyleByKind: { topic: 'file:Own' } }, {
    [`${RECIPES}/Own.md`]: recipe('Practical guide'), [`${RECIPES}/Zh.md`]: recipe('實用指南'), [`WS/S/Voices/Free.md`]: 'Short sentences, friendly.', [`${RECIPES}/Free.md`]: recipe('Free'), [`${RECIPES}/Gone.md`]: recipe('Nothing here')
  });
  await store.refresh();
  const guide = M.resolveToneText(PRESETS, ['guide'], 'en');
  assert.equal(store.runStyle({ outputLanguage: 'en' }).toneText, guide);
  assert.equal(store.runStyle({ outputLanguage: 'en', choice: { style: 'file:Free' } }).toneText, 'Short sentences, friendly.');
  const zh = store.runStyle({ outputLanguage: 'en', choice: { style: 'file:Zh' } });
  assert.ok(zh.toneText, 'a built-in name in another language names the same voice');
  assert.equal(zh.label.toneName, 'Practical guide');
  // #18: a run tone no longer replaces the voice of the style (replacement: the run-choice test in steps-run-style.cjs, slice 12)
  assert.equal(store.runStyle({ outputLanguage: 'en', choice: { style: 'file:Free', tone: 'plain' } }).toneText, 'Short sentences, friendly.');
  // a voice that is not there: academic rigor with an issue that names the style file
  const gone = store.runStyle({ outputLanguage: 'en', choice: { style: 'file:Gone' } });
  assert.equal(gone.toneText, undefined);
  assert.equal(gone.issues.blockIssues[0].fileName, 'Gone.md');
});

// Scope 5 matrix: topic x map in {none, template only, tone only, template + tone}, x workspace in {none, textbook,
// defaultNoteStyleId = style:S (S has a tone), old uuid exported and edited}. The oracle below is written from the rule,
// not from the store: the first level whose template can be used decides the style; a style file takes the tone of its own
// or a more specific level, else its own `tone`; an old template's file takes the whole chain; no file = today's path.
test('resolution matrix (was: topic x map x workspace x file tone, 128 cells; grilling Q5/Q10/Q12/Q15): run style x topic style x old topic keys x kind setting = 81 cells follow the rule run > topic > kind', async () => {
  const RECIPES = 'WS/S/Styles';
  const files = { [`${RECIPES}/R1.md`]: '', [`${RECIPES}/R2.md`]: '', [`${RECIPES}/R3.md`]: '' };
  const states = { run: [undefined, 'file:R1', 'file:Gone'], topic: [undefined, 'file:R2', 'file:Gone'], kind: [undefined, 'file:R3', 'file:Gone'] };
  const olds = [{}, { template: 'textbook' }, { tone: 'plain' }];
  let cells = 0;
  for (const run of states.run) for (const topicStyle of states.topic) for (const old of olds) for (const kind of states.kind) {
    const { store } = makeStore({ noteStylesFolder: 'WS/S', ...(kind ? { noteStyleByKind: { topic: kind } } : {}) }, files);
    await store.refresh();
    const got = store.runStyle({ outputLanguage: 'en', choice: { style: run }, topic: { style: topicStyle, ...old } });
    const label = `run=${run} topic=${topicStyle} old=${JSON.stringify(old)} kind=${kind}`;
    const missing = [];
    const readable = ref => { if (ref === undefined) return false; if (ref === 'file:Gone') { if (!missing.includes(ref)) missing.push(ref); return false; } return true; };
    let want;
    if (readable(run)) want = [run, 'run'];
    else if (readable(topicStyle)) want = [topicStyle, 'topic'];
    else if (old.template || old.tone) want = ['legacy', 'topic'];
    else if (readable(kind)) want = [kind, 'kind'];
    else want = ['builtin:general', 'kind'];
    eq([got.recipe.ref, got.recipe.source], want);
    eq(got.issues.missing, missing);
    if (want[0] === 'legacy') {
      assert.equal(got.template.id, old.template ?? 'standard', label);
      assert.equal(got.toneText, old.tone ? M.resolveToneText(PRESETS, [old.tone], 'en') : undefined, label);
    }
    cells++;
  }
  assert.equal(cells, 81);
});

test('missing style files (was: missing and invalid style files; grilling Q12): a ref that is gone is listed, the next level is used, a recipe file name is case-sensitive, nothing is written', async () => {
  const { store, v } = makeStore({ noteStylesFolder: 'WS/S', noteStyleByKind: { topic: 'builtin:textbook' } }, { 'WS/S/Styles/Bad.md': '---\nstructure: Nothing\n---\nno sections here\n' });
  await store.refresh();
  const before = JSON.stringify(v.files);
  const gone = store.runStyle({ outputLanguage: 'en', choice: { style: 'file:Gone' }, topic: { style: 'file:Gone' } });
  eq(gone.issues.missing, ['file:Gone']);
  assert.equal(gone.template.id, 'textbook');
  const bad = store.runStyle({ outputLanguage: 'en', choice: { style: 'file:Bad' } });
  assert.equal(bad.issues.invalid, undefined, 'a style file never stops a run');
  assert.equal(bad.template.id, 'standard', 'the structure it names is not there: Standard, with the issue');
  assert.equal(bad.issues.blockIssues[0].fileName, 'Bad.md');
  assert.equal(JSON.stringify(v.files), before);
  assert.deepEqual(v.writes, []);
  eq(store.runStyle({ outputLanguage: 'en', choice: { style: 'file:bad' } }).issues.missing, ['file:bad']);
});

test('lifecycle: rename, move out and back, delete, and a new file with the old name', async () => {
  const note = 'WS/S/Styles/A.md';
  const recipe = voice => `---\nvoice: ${voice}\n---\n`;
  const ask = name => store.runStyle(request([], 'en', { style: `file:${name}` }));
  const { store, v } = makeStore({ noteStylesFolder: 'WS/S' }, { [note]: recipe('Practical guide') });
  await store.refresh();
  assert.ok(ask('A').label.fileName);
  v.files['WS/S/Styles/B.md'] = v.files[note]; delete v.files[note]; // renamed
  await store.refresh();
  eq(ask('A').issues.missing, ['file:A']);
  assert.ok(ask('B').label.fileName);
  v.files[note] = recipe('Magazine column'); // someone creates A again: that is style A (contract), label shows A.md
  await store.refresh();
  const again = ask('A');
  assert.equal(again.label.fileName, 'A.md');
  assert.equal(again.label.toneName, 'Magazine column');
  v.files['WS/Other/A.md'] = v.files[note]; delete v.files[note]; // moved out
  await store.refresh();
  eq(ask('A').issues.missing, ['file:A']);
  v.files[note] = v.files['WS/Other/A.md']; // moved back
  await store.refresh();
  assert.ok(ask('A').label.fileName);
});

test('snapshot: a file edited after refresh() changes nothing until the next refresh()', async () => {
  const { store, v } = makeStore({ noteStylesFolder: 'WS/S' }, { 'WS/S/Styles/A.md': '---\nvoice: Practical guide\n---\n' });
  await store.refresh();
  const ask = () => store.runStyle(request([], 'en', { style: 'file:A' }));
  const first = ask();
  v.files['WS/S/Styles/A.md'] = '---\nvoice: Magazine column\n---\n';
  assert.equal(ask().toneText, first.toneText);
  await store.refresh();
  assert.notEqual(ask().toneText, first.toneText);
  assert.equal(ask().label.toneName, 'Magazine column');
});

const ROOT = 'WS/Note styles';
const TEMPLATES_DIR = `${ROOT}/Structures`;
const TONES_DIR = `${ROOT}/Voices`;

test('D12 (was ensureStyleFolder): no style file is written any more; opening the block folder writes only folders; the old keys are kept (decisions #32: no upgrade module any more; the conversion is in steps-note-style-migrate.cjs)', async () => {
  const templates = M.normalizeTemplates([LEGACY]);
  const mine = LEGACY.sections.map(section => `## ${section.name}\n${section.description}\n`).join('\n');
  const { store, v, settings } = makeStore({ detailTemplates: templates, promptPresets: [] }, { [`${TEMPLATES_DIR}/My notes.md`]: mine });
  const templatesBefore = plain(settings.detailTemplates), presetsBefore = plain(settings.promptPresets);
  await store.refresh();
  assert.deepEqual(v.writes, [], 'refresh writes nothing');
  assert.equal(settings.noteStylesFolder, undefined);
  assert.equal(store.ensureStyleFolder, undefined);
  assert.equal(store.unexportedTemplates, undefined);
  assert.equal(store.list, undefined);
  assert.equal(await store.ensureBlockFolder(), ROOT);
  assert.equal(settings.noteStylesFolder, 'WS/Note styles', 'the folder is remembered, as ensureStyleFolder did');
  assert.deepEqual(v.writes, [], 'only folders: not even the five built-in style files');
  assert.ok(v.folders.has(TEMPLATES_DIR) && v.folders.has(TONES_DIR));
  assert.equal(store.upgradeLegacy, undefined);
  assert.equal(store.startUpgrade, undefined);
  eq(settings.detailTemplates, templatesBefore);
  eq(settings.promptPresets, presetsBefore);
  assert.equal(settings.noteStyleFiles, undefined, 'nothing is exported to a style file any more');
  await store.refresh();
  assert.equal(store.runStyle(request([{ template: 'standard', tone: 'summary' }])).label.fileName, undefined);
  // Q10/Q12: the alias is not read; the old template still runs from the saved template (read only), and its block file reads as a structure by the dialog's ref
  const moved = store.runStyle(request([{ template: 'uuid-1' }]));
  assert.equal(moved.contextFields.styleSelection, undefined, 'the saved template is read, not the block');
  eq(moved.template.sections.map(section => section.name), LEGACY.sections.map(section => section.name));
  eq(store.listBlocks('template').map(item => [item.kind, item.name]), [['builtin', 'Standard six'], ['builtin', 'Intro + six'], ['builtin', 'Claim to verdict'], ['builtin', 'Content & credibility'], ['builtin', 'Goal to done'], ['builtin', 'Definition & example'], ['builtin', 'Conclusion & basis'], ['file', 'My notes']]);
});

test('D12 (was restore default; T5 P2b, decisions #22/#31): restoreDefault, builtinIdOfFile, restoreBlock, copyBlock and effectiveBlockKeys are gone from the store', () => {
  const { store } = makeStore({ noteStylesFolder: 'WS/Note styles' });
  for (const name of ['restoreDefault', 'builtinIdOfFile', 'restoreBlock', 'copyBlock', 'effectiveBlockKeys']) assert.equal(store[name], undefined, name);
});

test('D8 (was: the map pickers\' data source, a block at any level; grilling Q10/Q15): a structure file is picked by the dialog as file:<name> or by a style that names it; a topic id is never a part ref; a missing file is "missing"', async () => {
  const { store } = makeStore({ noteStylesFolder: 'WS/Note styles' }, { [`${TEMPLATES_DIR}/Mine.md`]: '## A\ntext\n', [`${ROOT}/Styles/S.md`]: '---\nstructure: Mine\n---\n' });
  await store.refresh();
  // #18: a run no longer names a bare structure file; a structure file is read through a style that names it
  assert.equal(store.runStyle(request([], 'en', { style: 'file:S' })).contextFields.styleSelection.template.fileName, 'Mine.md');
  const asId = store.runStyle(request([{ template: 'file:Mine' }]));
  assert.equal(asId.template.id, 'standard', 'at the topic a file ref is an unknown old id');
  eq(asId.issues.missing, ['file:Mine']);
  const gone = store.runStyle(request([{ template: 'textbook' }], 'en', { style: 'file:Gone' }));
  eq(gone.issues.missing, ['file:Gone']);
  assert.equal(gone.template.id, 'textbook');
});

test('D8 (was: tones, an upgraded custom preset keeps its name through its alias; grilling Q10/Q12): the tone choices are the built-in tones and the tone blocks; a tone block is picked as file:<name>; the conversion makes the preset a block and no alias is read', async () => {
  const { store, v, settings } = makeStore({ noteStylesFolder: 'WS/Note styles' }, { [`${TONES_DIR}/Calm.md`]: 'Speak calmly.\n' });
  assert.equal((await store.migrateLegacy({ mapsWithStyle: [] })).status, 'done');
  assert.equal(settings.noteStyleAliases, undefined);
  await store.refresh();
  const choices = store.toneChoices();
  assert.ok(['academic', 'summary', 'plain'].every(id => choices.some(choice => choice.id === id)), 'the built-in tones come by tone id');
  assert.ok(choices.some(choice => choice.id === 'file:Calm' && choice.name === 'Calm'));
  assert.ok(choices.some(choice => choice.id === 'file:Pirate' && choice.name === 'Pirate'), 'the custom preset is a tone block now');
  assert.ok(!choices.some(choice => choice.id === 'custom-tone-1'));
  assert.equal(store.runStyle({ topic: { tone: 'custom-tone-1' }, outputLanguage: 'en' }).toneText, 'Talk like a pirate.', 'the saved preset is read, not its alias');
  assert.ok(Object.keys(v.files).some(path => path.includes('/Voices/Pirate')));
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
