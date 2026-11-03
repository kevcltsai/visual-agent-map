// Note style recipe T5 P1: the store's and the pure model's new API for the custom-style pages (listParts, listRecipes, createPart,
// saveRecipe, draftStyle, recipeFileText, updateRecipeFileText). Unit level over an in-memory vault; the pages come in later packets.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadSource } = require('./support-replay.cjs');

const M = loadSource(`
export * from "./ai/note-style-recipe";
export { NoteStyleStore } from "./ai/note-style-store";
export { translate } from "./i18n";
`);

const LANGUAGES = ['zh-TW', 'zh-CN', 'en'];
const plain = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const ROOT = 'WS/S';
const dirOf = (language, role) => `${ROOT}/${M.translate(language, `ui.style_folder_${role}`)}`;

/** An in-memory vault that records every write; `create` never overwrites, `modify` needs an existing file. */
function vault(files = {}) {
  const state = { files: { ...files }, folders: new Set(), creates: [], modifies: [], folderCalls: 0, trashes: 0 };
  const under = folder => Object.keys(state.files).filter(file => file.startsWith(`${folder}/`) && !file.slice(folder.length + 1).includes('/'));
  state.port = {
    list: async folder => under(folder).map(file => file.slice(folder.length + 1)).filter(name => name.endsWith('.md')),
    read: async file => { if (!(file in state.files)) throw new Error(file); return state.files[file]; },
    folderExists: folder => state.folders.has(folder) || Object.keys(state.files).some(file => file.startsWith(`${folder}/`)),
    createFolder: async folder => { state.folderCalls++; state.folders.add(folder); },
    create: async (file, content) => {
      if (Object.keys(state.files).some(existing => existing.toLowerCase() === file.toLowerCase())) throw new Error(`exists: ${file}`);
      state.files[file] = content; state.creates.push(file);
    },
    modify: async (file, content) => { if (!(file in state.files)) throw new Error(file); state.files[file] = content; state.modifies.push(file); },
    trash: async file => { state.trashes++; delete state.files[file]; }
  };
  return state;
}
async function makeStore(files = {}, settingsPatch = {}) {
  const v = vault(files);
  const settings = { detailTemplates: [], workspaceFolder: 'WS', noteStylesFolder: ROOT, language: 'en', ...settingsPatch };
  let saves = 0;
  const store = new M.NoteStyleStore({ settings: () => settings, port: v.port, save: async () => { saves++; } });
  await store.refresh();
  return { store, v, settings, saves: () => saves };
}
const writes = v => v.creates.length + v.modifies.length + v.folderCalls + v.trashes;
const STD = { structure: 'builtin:standard', voice: 'builtin:academic', format: 'builtin:standard', update: 'merge' };

// ---- the pure text functions ----
test('recipeFileText: the four keys in the interface language, built-ins by that language\'s name, files by file name; parseRecipeFile reads back the same four values and the description (round trip)', () => {
  for (const language of LANGUAGES) for (const update of M.UPDATE_MODES) for (const description of [undefined, 'A style for notes.']) {
    const parts = { structure: 'file:My six', voice: 'builtin:guide', format: 'file:My format', update };
    const text = M.recipeFileText({ ...parts, ...(description ? { description } : {}) }, language);
    const lines = text.split('\n');
    assert.equal(lines[0], '---');
    assert.equal(lines[1], `${M.translate(language, 'ui.recipe_key_structure')}: My six`);
    assert.equal(lines[2], `${M.translate(language, 'ui.recipe_key_voice')}: ${M.translate(language, 'ui.preset_name_guide')}`);
    assert.equal(lines[4], `${M.translate(language, 'ui.recipe_key_update')}: ${update}`);
    const read = M.parseRecipeFile(text);
    assert.deepEqual(plain({ structure: read.structure, voice: read.voice, format: read.format, update: read.update }), parts, language);
    assert.equal(read.description, description ?? '');
    assert.deepEqual(plain(read.issues), []);
  }
  const builtin = M.recipeFileText(STD, 'zh-TW');
  assert.equal(M.parseRecipeFile(builtin).structure, 'builtin:standard');
  assert.throws(() => M.recipeFileText({ ...STD, structure: 'builtin:aim-delivery' }, 'en'));
});

test('counter 3: updateRecipeFileText changes only the values of the four known keys (any language key, quotes, CRLF, BOM); every other line and the body keep their bytes; the result reads back to the new values', () => {
  const body = '\n這是一份我的風格。\n\n%% a comment %%\nSecond line  \n';
  const old = ['---', 'tags: [a, b]', 'structure: Standard six', '# a comment line', '寫作口吻 : "Practical guide"', 'update: merge', 'author: me', '---'].join('\n') + body;
  const parts = { structure: 'file:Mine', voice: 'builtin:plain', format: 'builtin:rich', update: 'fresh' };
  for (const language of LANGUAGES) {
    const next = M.updateRecipeFileText(old, parts, language);
    const before = old.split('\n');
    const after = next.split('\n');
    // the body and the unrelated frontmatter lines are the same lines in the same order
    assert.ok(after.includes('tags: [a, b]') && after.includes('# a comment line') && after.includes('author: me'));
    assert.equal(next.endsWith(body), true);
    assert.equal(after[2], `structure: Mine`, 'the key as the user wrote it, only the value changes');
    assert.equal(after[4], `寫作口吻 : ${M.translate(language, 'ui.preset_name_plain')}`);
    assert.equal(after[5], 'update: fresh');
    // the missing key (format) is added before the closing ---
    const close = after.indexOf('---', 1);
    assert.equal(after[close - 1], `${M.translate(language, 'ui.recipe_key_format')}: ${M.translate(language, 'ui.format_name_rich')}`);
    assert.equal(after.length, before.length + 1, language);
    const read = M.parseRecipeFile(next);
    assert.deepEqual(plain({ structure: read.structure, voice: read.voice, format: read.format, update: read.update }), parts, language);
    assert.deepEqual(plain(read.issues), []);
  }
  // values that already mean the wanted ones keep their lines byte for byte (here: the whole text)
  const same = '---\nstructure: Standard six\nvoice: "學術嚴謹"\nformat: Standard format\nupdate: merge\n---\nbody';
  assert.equal(M.updateRecipeFileText(same, STD, 'en'), same);
  // CRLF and a BOM survive
  const crlf = '﻿---\r\nstructure: Standard six\r\n---\r\nbody\r\n';
  const out = M.updateRecipeFileText(crlf, { ...STD, structure: 'file:Mine' }, 'en');
  assert.ok(out.startsWith('﻿---\r\n') && out.endsWith('---\r\nbody\r\n'), JSON.stringify(out));
  assert.ok(!/[^\r]\n/.test(out.slice(1)), 'no bare LF added');
  assert.equal(M.parseRecipeFile(out).structure, 'file:Mine');
  // no frontmatter: one is put in front, the text after it is untouched
  const bare = 'Just text\n';
  const framed = M.updateRecipeFileText(bare, STD, 'en');
  assert.ok(framed.endsWith(`---\n${bare}`));
  assert.equal(M.parseRecipeFile(framed).update, 'merge');
});

// ---- listParts (decision #22) ----
test('listParts: built-ins first (7 structures, 6 voices, 3 formats), then the user\'s files; a file named like a built-in in any language or case is the user\'s file with a builtin_name issue and does not mark the built-in as changed (counter 6, decision #22)', async () => {
  const files = {
    [`${dirOf('en', 'template')}/Standard six.md`]: '## A\nx\n',
    [`${dirOf('en', 'template')}/標準六段.md`]: '## A\nx\n',
    [`${dirOf('en', 'template')}/standard SIX.md`]: '## A\nx\n',
    [`${dirOf('en', 'template')}/Mine.md`]: '## A\nx\n',
    [`${dirOf('en', 'template')}/Broken.md`]: '## A\nCount: x\nbody\n',
    [`${dirOf('en', 'tone')}/Practical guide.md`]: 'talk',
    [`${dirOf('en', 'format')}/Lean format.md`]: ''
  };
  const { store, v, saves } = await makeStore(files);
  const structures = store.listParts('structure');
  assert.equal(structures.filter(item => item.kind === 'builtin').length, 7);
  assert.equal(structures.filter(item => item.kind === 'builtin').map(item => item.ref).join(), 'builtin:standard,builtin:textbook,builtin:hypothesis,builtin:evidence,builtin:action,builtin:atomic,builtin:conclusion');
  assert.deepEqual(plain(structures.slice(0, 7).map(item => item.kind)), Array(7).fill('builtin'));
  for (const item of structures.filter(entry => entry.kind === 'builtin')) {
    assert.equal(item.fileName, undefined, item.ref);
    assert.deepEqual(plain(item.issues), [], item.ref);
    assert.ok(!('modified' in item), 'no "modified" mark on a built-in');
  }
  const own = Object.fromEntries(structures.filter(item => item.kind === 'file').map(item => [item.name, item]));
  for (const name of ['Standard six', '標準六段', 'standard SIX']) {
    assert.ok(own[name], name);
    assert.equal(own[name].ref, `file:${name}`);
    assert.ok(own[name].issues.some(issue => issue.code === 'builtin_name'), name);
  }
  assert.deepEqual(plain(own.Mine.issues), []);
  assert.ok(own.Broken.issues.length > 0 && own.Broken.issues[0].line === 2);
  const voices = store.listParts('voice');
  assert.equal(voices.filter(item => item.kind === 'builtin').length, 6);
  assert.ok(voices.find(item => item.ref === 'file:Practical guide').issues.some(issue => issue.code === 'builtin_name'));
  const formats = store.listParts('format');
  assert.equal(formats.filter(item => item.kind === 'builtin').length, 3);
  assert.ok(formats.find(item => item.ref === 'file:Lean format').issues.some(issue => issue.code === 'builtin_name'));
  assert.equal(writes(v), 0);
  assert.equal(saves(), 0);
});

test('listParts: usedBy names the styles that use a part (built-in styles and the user\'s style files)', async () => {
  const files = {
    [`${dirOf('en', 'template')}/Mine.md`]: '## A\nx\n',
    [`${dirOf('en', 'recipe')}/Alpha.md`]: '---\nstructure: Mine\n---\n',
    [`${dirOf('en', 'recipe')}/Beta.md`]: '---\nstructure: Mine\nvoice: Practical guide\n---\n'
  };
  const { store } = await makeStore(files);
  const byRef = Object.fromEntries(store.listParts('structure').map(item => [item.ref, item.usedBy]));
  assert.deepEqual(plain(byRef['file:Mine']), ['Alpha', 'Beta']);
  assert.deepEqual(plain(byRef['builtin:standard']), ['General research']);
  assert.deepEqual(plain(byRef['builtin:textbook']), ['Textbook']);
  assert.deepEqual(plain(byRef['builtin:conclusion']), ['Conclusion']);
  const voices = Object.fromEntries(store.listParts('voice').map(item => [item.ref, item.usedBy]));
  assert.deepEqual(plain(voices['builtin:guide']), ['Beta']);
  assert.equal(voices['builtin:academic'].includes('AIM report'), true);
  // the AIM report's delivery structure is not a structure part: it is no structure's user
  assert.ok(Object.values(byRef).every(names => !names.includes('AIM report')));
});

// ---- listRecipes (counter 14 data side) ----
test('listRecipes: eight built-ins (the AIM report is aimOnly and the only one), then the user\'s style files with their parts, update mode, description, issues and usedByKinds', async () => {
  const files = {
    [`${dirOf('en', 'recipe')}/Mine.md`]: '---\nstructure: Gone\nupdate: sideways\n---\nMy first line.\n',
    [`${dirOf('en', 'recipe')}/General research.md`]: '---\n---\n'
  };
  const { store } = await makeStore(files, { noteStyleByKind: { action: 'file:Mine', hypothesis: 'builtin:general' } });
  const items = store.listRecipes();
  assert.equal(items.filter(item => item.kind === 'builtin').length, 8);
  assert.deepEqual(plain(items.filter(item => item.aimOnly).map(item => item.ref)), ['builtin:aim']);
  const byRef = Object.fromEntries(items.map(item => [item.ref, item]));
  assert.deepEqual(plain(byRef['builtin:hypothesis'].usedByKinds), []);
  assert.deepEqual(plain(byRef['builtin:general'].usedByKinds), ['topic', 'hypothesis']);
  assert.deepEqual(plain(byRef['builtin:aim'].usedByKinds), ['aim']);
  assert.deepEqual(plain(byRef['builtin:action'].usedByKinds), [], 'the action kind saved another style');
  assert.deepEqual(plain(byRef['file:Mine'].usedByKinds), ['action']);
  assert.equal(byRef['file:Mine'].description, 'My first line.');
  assert.deepEqual(plain(byRef['file:Mine'].structure), { ref: 'file:Gone', name: 'Gone' });
  assert.equal(byRef['file:Mine'].update, 'merge');
  assert.deepEqual(plain(byRef['file:Mine'].issues.map(issue => issue.code).sort()), ['part_missing', 'update_invalid']);
  assert.equal(byRef['file:Mine'].issues.find(issue => issue.code === 'part_missing').line, 2);
  assert.ok(byRef['file:General research'].issues.some(issue => issue.code === 'builtin_name'));
  assert.deepEqual(plain(byRef['builtin:hypothesis'].structure), { ref: 'builtin:hypothesis', name: 'Claim to verdict' });
  assert.equal(byRef['builtin:hypothesis'].update, 'top');
});

// ---- createPart ----
test('createPart: a built-in part is written with its text in the interface language (academic voice as its design note, formats as their rules), a file part is copied, null starts blank; nothing but the new file and its folder is written and no setting key changes', async () => {
  for (const language of LANGUAGES) {
    const { store, v, settings } = await makeStore({}, { language });
    const before = JSON.stringify(settings);
    const mine = name => M.translate(language, 'ui.block_copy_name_0', name);
    const structureName = M.translate(language, 'ui.structure_name_hypothesis');
    const ref = await store.createPart('structure', 'builtin:hypothesis');
    assert.equal(ref, `file:${mine(structureName)}`, language);
    const path = `${dirOf(language, 'template')}/${mine(structureName)}.md`;
    assert.ok(v.files[path].includes('## '), language);
    const tone = await store.createPart('voice', 'builtin:academic');
    assert.equal(tone, `file:${mine(M.translate(language, 'ui.preset_name_academic'))}`);
    assert.equal(v.files[`${dirOf(language, 'tone')}/${tone.slice(5)}.md`], `${M.translate(language, 'ui.block_academic_note')}\n`);
    const format = await store.createPart('format', 'builtin:lean');
    assert.ok(v.files[`${dirOf(language, 'format')}/${format.slice(5)}.md`].length > 20);
    const copy = await store.createPart('structure', ref);
    assert.equal(v.files[`${dirOf(language, 'template')}/${copy.slice(5)}.md`], v.files[path]);
    const blank = await store.createPart('structure', null);
    assert.equal(blank, `file:${M.translate(language, 'ui.part_new_name_structure')}`);
    assert.ok(/^## /m.test(v.files[`${dirOf(language, 'template')}/${blank.slice(5)}.md`]) && v.files[`${dirOf(language, 'template')}/${blank.slice(5)}.md`].includes('%%'));
    const blankVoice = await store.createPart('voice', null);
    const blankFormat = await store.createPart('format', null);
    assert.equal(v.files[`${dirOf(language, 'tone')}/${blankVoice.slice(5)}.md`], '');
    assert.equal(v.files[`${dirOf(language, 'format')}/${blankFormat.slice(5)}.md`], '');
    assert.equal(v.modifies.length, 0);
    assert.equal(v.trashes, 0);
    // the folder is pinned once (the only setting that moves), no kind or block key is touched
    const after = JSON.parse(JSON.stringify(settings));
    assert.equal(after.noteStylesFolder, ROOT);
    assert.equal(JSON.stringify({ ...after }), before);
    // the new parts are listed as the user's files (the cache was updated), and the blank structure parses
    assert.ok(store.listParts('structure').some(item => item.ref === blank && item.issues.length === 0), language);
  }
});

test('counter 5: createPart never overwrites: a taken name (even one made after the last refresh) gives " (2)", the old file keeps its bytes; two together make two files', async () => {
  const taken = `${dirOf('en', 'template')}/My Standard six.md`;
  const { store, v } = await makeStore({});
  v.files[taken] = 'MINE, do not touch';
  v.folders.add(dirOf('en', 'template'));
  const ref = await store.createPart('structure', 'builtin:standard');
  assert.equal(ref, 'file:My Standard six (2)');
  assert.equal(v.files[taken], 'MINE, do not touch');
  const [a, b] = await Promise.all([store.createPart('voice', 'builtin:guide'), store.createPart('voice', 'builtin:guide')]);
  assert.notEqual(a, b);
  assert.deepEqual([a, b], ['file:My Practical guide', 'file:My Practical guide (2)']);
});

test('counter 4 (security): createPart with a name that is empty, padded, has / or \\ or .., a built-in name (any language, any case) or an unsafe file character, or is taken, throws and writes nothing, not even a folder', async () => {
  const { store, v, saves } = await makeStore({ [`${dirOf('en', 'template')}/Taken.md`]: '## A\nx\n' });
  const names = ['', ' a', 'a ', 'a/b', 'a\\b', '..', 'a..b', 'STANDARD SIX', '標準六段', '标准六段', 'standard six', 'a:b', 'a#b', 'taken', 'Taken'];
  for (const name of names) await assert.rejects(store.createPart('structure', 'builtin:standard', name), name);
  for (const name of ['Practical guide', '實用指南', 'ACADEMIC RIGOR']) await assert.rejects(store.createPart('voice', null, name), name);
  for (const name of ['Lean format', '精簡格式', 'a/b']) await assert.rejects(store.createPart('format', null, name), name);
  await assert.rejects(store.createPart('structure', 'file:Missing'));
  await assert.rejects(store.createPart('structure', 'builtin:nope'));
  assert.equal(writes(v), 0);
  assert.equal(saves(), 0);
  // a good name is used as given
  assert.equal(await store.createPart('structure', null, 'Fresh one'), 'file:Fresh one');
  assert.ok('WS/S/Structures/Fresh one.md' in v.files);
});

// ---- saveRecipe ----
test('saveRecipe: a new style is a new file with the four keys (read back equal); the name rules apply and a bad name writes nothing', async () => {
  const { store, v } = await makeStore({ [`${dirOf('en', 'recipe')}/Taken.md`]: '---\n---\n' });
  const parts = { structure: 'builtin:hypothesis', voice: 'builtin:plain', format: 'builtin:lean', update: 'top' };
  const result = await store.saveRecipe({ name: 'Fresh', ...parts });
  assert.deepEqual(plain(result), { ok: true, ref: 'file:Fresh' });
  const text = v.files[`${dirOf('en', 'recipe')}/Fresh.md`];
  const read = M.parseRecipeFile(text);
  assert.deepEqual(plain({ structure: read.structure, voice: read.voice, format: read.format, update: read.update }), parts);
  assert.equal(store.recipeText('file:Fresh'), text);
  // a built-in original is a new style as well
  const second = await store.saveRecipe({ name: 'Second', ...parts, original: { ref: 'builtin:general', text: '' } });
  assert.deepEqual(plain(second), { ok: true, ref: 'file:Second' });
  const before = { ...v.files };
  const count = writes(v);
  for (const name of ['', ' x', 'a/b', 'a\\b', '..', 'General research', '一般研究', 'GENERAL RESEARCH', 'taken', 'Fresh', 'a:b'])
    assert.deepEqual(plain(await store.saveRecipe({ name, ...parts })), { ok: false, reason: 'name' }, name);
  assert.deepEqual(v.files, before);
  assert.equal(writes(v), count);
});

test('counter 3/D4: saveRecipe on a user\'s style file changes it in place: the name stays, only the four values change, other lines keep their bytes', async () => {
  const path = `${dirOf('en', 'recipe')}/Mine.md`;
  const old = '---\ntags: [x]\nstructure: Standard six\n# keep me\nupdate: merge\n---\nBody line.\n';
  const { store, v } = await makeStore({ [path]: old });
  const parts = { structure: 'builtin:hypothesis', voice: 'builtin:plain', format: 'builtin:rich', update: 'fresh' };
  const result = await store.saveRecipe({ name: 'ignored', ...parts, original: { ref: 'file:Mine', text: store.recipeText('file:Mine') } });
  assert.deepEqual(plain(result), { ok: true, ref: 'file:Mine' });
  assert.deepEqual(v.modifies, [path]);
  assert.equal(v.creates.length, 0);
  const lines = v.files[path].split('\n');
  assert.ok(lines.includes('tags: [x]') && lines.includes('# keep me') && lines.includes('Body line.'));
  assert.equal(lines[2], 'structure: Claim to verdict');
  const read = M.parseRecipeFile(v.files[path]);
  assert.deepEqual(plain({ structure: read.structure, voice: read.voice, format: read.format, update: read.update }), parts);
  assert.equal(store.recipeText('file:Mine'), v.files[path]);
  assert.equal(v.files['WS/S/Styles/ignored.md'], undefined);
});

test('counter 2/D4 (data): saveRecipe does not write when the file differs from the text the editor opened ("changed"), and never overwrites a file that is gone', async () => {
  const path = `${dirOf('en', 'recipe')}/Mine.md`;
  const { store, v } = await makeStore({ [path]: '---\nstructure: Standard six\n---\n' });
  const opened = store.recipeText('file:Mine');
  v.files[path] = '---\nstructure: Standard six\n---\nEDITED ELSEWHERE\n';
  const external = v.files[path];
  const result = await store.saveRecipe({ name: 'Mine', ...STD, update: 'top', original: { ref: 'file:Mine', text: opened } });
  assert.deepEqual(plain(result), { ok: false, reason: 'changed' });
  assert.equal(v.files[path], external);
  assert.equal(v.modifies.length, 0);
  delete v.files[path];
  const gone = await store.saveRecipe({ name: 'Mine', ...STD, original: { ref: 'file:Mine', text: opened } });
  assert.deepEqual(plain(gone), { ok: false, reason: 'write-failed' });
  assert.equal(writes(v), 0);
  assert.equal(path in v.files, false);
  // a port that fails reports write-failed and leaves the cache as it was
  const failing = await makeStore({ [path]: '---\n---\n' });
  failing.v.port.modify = async () => { throw new Error('disk'); };
  const failed = await failing.store.saveRecipe({ name: 'Mine', ...STD, update: 'top', original: { ref: 'file:Mine', text: '---\n---\n' } });
  assert.deepEqual(plain(failed), { ok: false, reason: 'write-failed' });
  assert.equal(failing.store.recipeText('file:Mine'), '---\n---\n');
});

// ---- draftStyle (counter 13) ----
test('counter 13: draftStyle equals runStyle of the style file saveRecipe writes for the same parts (template, toneText, formatText, updateMode, contextFields, and the issues for a missing part), and it writes nothing', async () => {
  const files = {
    [`${dirOf('en', 'template')}/Mine.md`]: '## Alpha\nDescribe alpha.\n\n## Beta\nCount: 2\nDescribe beta.\n',
    [`${dirOf('en', 'tone')}/Pirate.md`]: 'Talk like a pirate.\n',
    [`${dirOf('en', 'format')}/Bare.md`]: 'No decorations.\n'
  };
  const cases = [
    STD,
    { structure: 'file:Mine', voice: 'file:Pirate', format: 'file:Bare', update: 'fresh' },
    { structure: 'builtin:textbook', voice: 'builtin:guide', format: 'builtin:rich', update: 'top' },
    { structure: 'file:Mine', voice: 'builtin:academic', format: 'builtin:lean', update: 'merge' },
    { structure: 'file:Gone', voice: 'file:Silent', format: 'file:Nope', update: 'merge' }
  ];
  for (const [index, parts] of cases.entries()) for (const outputLanguage of ['en', 'zh-TW']) {
    const { store, v } = await makeStore(files);
    const count = writes(v);
    const draft = store.draftStyle({ name: `Case${index}`, ...parts }, 'topic', outputLanguage);
    assert.equal(writes(v), count, 'a draft writes nothing');
    const saved = await store.saveRecipe({ name: `Case${index}`, ...parts });
    assert.equal(saved.ok, true);
    const run = store.runStyle({ choice: { style: saved.ref }, kind: 'topic', outputLanguage });
    for (const field of ['template', 'toneText', 'formatText', 'updateMode', 'contextFields'])
      assert.deepEqual(plain(draft[field]), plain(run[field]), `${index} ${outputLanguage} ${field}`);
    // a draft has no file, so its issues sit on line 1; everything else about them is the same
    const unlined = issues => plain({ ...issues, blockIssues: issues.blockIssues.map(issue => ({ ...issue, line: 0 })) });
    assert.deepEqual(unlined(draft.issues), unlined(run.issues), `${index} issues`);
    assert.deepEqual(plain(draft.label), plain(run.label), `${index} label`);
    assert.deepEqual(plain(draft.recipe), plain(run.recipe), `${index} recipe`);
  }
});

test('reading never writes: the list calls, the suggested name, the draft and recipeText write no file, no folder and no setting', async () => {
  const { store, v, settings, saves } = await makeStore({ [`${dirOf('en', 'recipe')}/Mine.md`]: '---\n---\n' });
  const before = JSON.stringify(settings);
  for (const category of ['structure', 'voice', 'format']) { store.listParts(category); store.suggestPartName(category, null); store.suggestPartName(category, `builtin:${category === 'structure' ? 'standard' : category === 'voice' ? 'guide' : 'lean'}`); }
  store.listRecipes();
  store.recipeText('file:Mine');
  store.draftStyle({ name: 'D', ...STD }, 'aim', 'en');
  assert.equal(writes(v), 0);
  assert.equal(saves(), 0);
  assert.equal(JSON.stringify(settings), before);
  assert.equal(store.suggestPartName('structure', 'builtin:standard'), 'My Standard six');
  assert.equal(store.suggestPartName('structure', null), 'New structure');
});
