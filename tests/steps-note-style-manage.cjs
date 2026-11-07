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
  const state = { files: { ...files }, folders: new Set(), creates: [], modifies: [], folderCalls: 0, trashes: 0, renames: [] };
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
    trash: async file => { state.trashes++; delete state.files[file]; },
    rename: async (from, to) => {
      if (!(from in state.files)) throw new Error(from);
      if (Object.keys(state.files).some(existing => existing.toLowerCase() === to.toLowerCase() && existing !== from)) throw new Error(`exists: ${to}`);
      state.files[to] = state.files[from]; delete state.files[from]; state.renames.push([from, to]);
    }
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
const writes = v => v.creates.length + v.modifies.length + v.folderCalls + v.trashes + v.renames.length;
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
test('listParts: built-ins first (8 structures, 6 voices, 4 formats), then the user\'s files; a file named like a built-in in any language or case is the user\'s file with a builtin_name issue and does not mark the built-in as changed (counter 6, decision #22)', async () => {
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
  assert.equal(structures.filter(item => item.kind === 'builtin').length, 8);
  assert.equal(structures.filter(item => item.kind === 'builtin').map(item => item.ref).join(), 'builtin:standard,builtin:textbook,builtin:hypothesis,builtin:evidence,builtin:action,builtin:atomic,builtin:conclusion,builtin:guide');
  assert.deepEqual(plain(structures.slice(0, 8).map(item => item.kind)), Array(8).fill('builtin'));
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
  assert.equal(formats.filter(item => item.kind === 'builtin').length, 4);
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
test('listRecipes: nine built-ins (the AIM report is aimOnly and the only one; the AI-suggested style is topicOnly and noCopy), then the user\'s style files with their parts, update mode, description, issues and usedByKinds', async () => {
  const files = {
    [`${dirOf('en', 'recipe')}/Mine.md`]: '---\nstructure: Gone\nupdate: sideways\n---\nMy first line.\n',
    [`${dirOf('en', 'recipe')}/General research.md`]: '---\n---\n'
  };
  const { store } = await makeStore(files, { noteStyleByKind: { action: 'file:Mine', hypothesis: 'builtin:general' } });
  const items = store.listRecipes();
  assert.equal(items.filter(item => item.kind === 'builtin').length, 9);
  assert.deepEqual(plain(items.filter(item => item.aimOnly).map(item => item.ref)), ['builtin:aim']);
  assert.deepEqual(plain(items.filter(item => item.topicOnly).map(item => item.ref)), ['builtin:ai-suggested']);
  assert.deepEqual(plain(items.filter(item => item.noCopy).map(item => item.ref)), ['builtin:aim', 'builtin:ai-suggested']);
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
  assert.equal(byRef['builtin:hypothesis'].update, 'merge');
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

// ---- Note style recipe T5 P3: the manage window (NoteStyleManageModal) over a real store on an in-memory vault ----
const S = require('./support.cjs');
const dom = require('./support-dom.cjs');
const notices = [];
const opened = [];
class FakeSetting {
  constructor(container) {
    this.settingEl = container.createDiv('setting-item');
    this.nameEl = this.settingEl.createDiv('setting-item-name');
    this.descEl = this.settingEl.createDiv('setting-item-description');
    this.controlEl = this.settingEl.createDiv('setting-item-control');
  }
  setName(name) { this.nameEl.setText(name); return this; }
  setDesc(text) { this.descEl.setText(text); return this; }
  addButton(build) {
    const el = this.controlEl.createEl('button');
    const component = { buttonEl: el, setButtonText(text) { el.setText(text); return component; }, onClick(fn) { el.addEventListener('click', fn); return component; }, setCta() { return component; }, setDisabled(value) { el.disabled = value; return component; } };
    build(component);
    return this;
  }
  addDropdown(build) {
    const el = this.controlEl.createEl('select');
    const component = { selectEl: el, onChange(fn) { el.addEventListener('change', () => fn(el.value)); return component; } };
    build(component);
    return this;
  }
  addText(build) {
    const el = this.controlEl.createEl('input', { type: 'text' });
    const component = { inputEl: el, onChange(fn) { el.addEventListener('input', () => fn(el.value)); return component; } };
    build(component);
    return this;
  }
}
const windows = [];
const BaseModal = dom.makeModal({ focusFirst: true });
class RecordingModal extends BaseModal { open() { windows.push(this); super.open(); } }
class FakeComponent { load() {} unload() {} addChild(child) { return child; } removeChild(child) { return child; } }
const obsidian = { ...S.obsidian, Modal: RecordingModal, Setting: FakeSetting, Notice: dom.makeNotice(notices), Component: FakeComponent, MarkdownRenderer: { render: async () => {} } };
const { NoteStyleManageModal, MANAGE_TABS } = S.load('ui/modals/note-style-manage-modal.ts', { obsidian });
const { default: Plugin } = S.load('main.ts', { obsidian }, { createFragment: dom.createFragment });

const flush = () => new Promise(resolve => setImmediate(resolve));
const settle = async () => { for (let n = 0; n < 6; n++) await flush(); };

/** A plugin over a real store: editNotePart and saveNoteRecipe are main's own methods; opening a file is recorded. `topics` are the notes (path -> text) that may carry `note-style`; `failTopics` are paths whose write throws. */
async function manageSetup(files = {}, settingsPatch = {}, extra = {}) {
  const made = await makeStore(files, settingsPatch);
  const { store, v, settings } = made;
  notices.length = 0;
  opened.length = 0;
  const topics = { ...(extra.topics ?? {}) };
  const failTopics = new Set(extra.failTopics ?? []);
  made.topics = topics;
  made.topicWrites = [];
  const known = path => path in v.files || path in topics;
  const noteStyleOf = path => /^note-style:\s*"?([^"\r\n]*)"?\s*$/m.exec(/^---\r?\n([\s\S]*?)\r?\n---/.exec(topics[path] ?? '')?.[1] ?? '')?.[1];
  const app = {
    vault: {
      getAbstractFileByPath: path => (known(path) ? new S.TFile(path) : null),
      getMarkdownFiles: () => Object.keys(topics).map(path => new S.TFile(path)),
      process: async (file, change) => { if (failTopics.has(file.path)) throw new Error('locked'); topics[file.path] = change(topics[file.path]); made.topicWrites.push(file.path); return topics[file.path]; }
    },
    metadataCache: { getFileCache: file => ({ frontmatter: noteStyleOf(file.path) === undefined ? {} : { 'note-style': noteStyleOf(file.path) } }) },
    workspace: { getLeaf: () => ({ openFile: async file => { opened.push(file.path); } }) }
  };
  const plugin = { app, settings, noteStyles: store, saveSettings: async () => { made.settingSaves = (made.settingSaves ?? 0) + 1; } };
  plugin.repo = { renameNoteStyleRef: (...args) => S.Repository.prototype.renameNoteStyleRef.apply({ app, file: path => new S.TFile(path) }, args) };
  for (const name of ['editNotePart', 'saveNoteRecipe', 'setKindStyle', 'topicNoteStyleRefs', 'renameNoteStyle', 'deleteNoteStyle', 'clearKindStyles'])
    plugin[name] = (...args) => Plugin.prototype[name].apply(plugin, args);
  plugin.openPromptPreview = () => {};
  windows.length = 0;
  const setup = { ...made, plugin, app };
  // `made` is copied above, so the save count is read through it.
  Object.defineProperty(setup, 'settingSaves', { get: () => made.settingSaves });
  return setup;
}
async function openManage(setup, tab = 'recipe') {
  const trigger = dom.element('button');
  const modal = new NoteStyleManageModal(setup.app, setup.plugin, tab, trigger);
  modal.open();
  await settle();
  return { modal, trigger, root: modal.contentEl };
}
const tabsOf = root => dom.findAll(root, node => node.attrs.role === 'tab');
const panelOf = (root, tab) => dom.find(root, node => node.attrs.id === `vam-manage-panel-${tab}`);
const rowsOf = root => dom.findAll(root, node => node.hasClass('setting-item') && node.hasClass('vam-manage-row'));
const rowName = row => row.children[0].text;
const rowFor = (root, name) => rowsOf(root).find(row => rowName(row) === name);
const rowTexts = row => row.children[1].children.map(child => child.text);
// P5a: a built-in row's edit button is "Copy and edit" (and "View" comes first); a user's row has "Edit" then the "..." menu.
const editOf = row => dom.find(row, node => node.tag === 'button' && (node.text === 'Edit' || node.text === 'Copy and edit'));
const formOf = (root, tab) => dom.find(root, node => node.attrs.id === `vam-manage-form-${tab}`);
const nameInputOf = form => dom.find(form, node => node.tag === 'input' && node.type === 'text');
const errorOf = form => dom.find(form, node => node.hasClass('vam-manage-error'));
const createOf = form => dom.button(form, 'Create');
const sourceOf = form => dom.find(form, node => node.tag === 'select');
const newButton = (root, tab) => dom.find(panelOf(root, tab), node => node.tag === 'button' && node.text === 'New…');
const typeName = (form, value) => { const input = nameInputOf(form); input.value = value; input.fire('input'); };

test('P3: the window is a tablist of four tabs with a tabpanel each; aria-selected, tabindex and the arrow, Home and End keys follow the selected tab; the focus returns to the trigger on close', async () => {
  const setup = await manageSetup();
  const { modal, trigger, root } = await openManage(setup, 'voice');
  assert.equal(modal.titleEl.text, 'Custom note styles');
  assert.deepEqual([...MANAGE_TABS], ['recipe', 'structure', 'voice', 'format']);
  const list = dom.find(root, node => node.attrs.role === 'tablist');
  assert.ok(list.attrs['aria-label']);
  const tabs = tabsOf(root);
  assert.deepEqual(tabs.map(tab => tab.text), ['Note styles', 'Structures', 'Voices', 'Format rules']);
  const state = () => tabs.map(tab => tab.attrs['aria-selected']);
  assert.deepEqual(state(), ['false', 'false', 'true', 'false'], 'opens on the asked tab');
  assert.deepEqual(tabs.map(tab => tab.attrs.tabindex), ['-1', '-1', '0', '-1']);
  assert.equal(tabs[2].focused, true);
  for (const tab of tabs) {
    const panel = dom.find(root, node => node.attrs.id === tab.attrs['aria-controls']);
    assert.equal(panel.attrs.role, 'tabpanel');
    assert.equal(panel.attrs['aria-labelledby'], tab.attrs.id);
  }
  assert.equal(panelOf(root, 'voice').hidden, false);
  assert.equal(panelOf(root, 'structure').hidden, true);
  tabs[2].keydown({ key: 'ArrowRight' });
  assert.deepEqual(state(), ['false', 'false', 'false', 'true']);
  assert.equal(tabs[3].focused, true);
  tabs[3].keydown({ key: 'ArrowRight' });
  assert.deepEqual(state(), ['true', 'false', 'false', 'false'], 'wraps around');
  tabs[0].keydown({ key: 'ArrowLeft' });
  assert.deepEqual(state(), ['false', 'false', 'false', 'true']);
  tabs[3].keydown({ key: 'Home' });
  assert.deepEqual(state(), ['true', 'false', 'false', 'false']);
  tabs[0].keydown({ key: 'End' });
  assert.deepEqual(state(), ['false', 'false', 'false', 'true']);
  assert.equal(panelOf(root, 'format').hidden, false);
  assert.ok(rowsOf(panelOf(root, 'format')).length === 4 && rowsOf(panelOf(root, 'voice')).length === 0, 'only the selected panel is filled');
  tabs[3].keydown({ key: 'a' });
  assert.deepEqual(state(), ['false', 'false', 'false', 'true']);
  modal.close();
  assert.equal(trigger.focused, true);
});

test('counter 1: opening the window, switching all four tabs, opening the New form and typing writes nothing (no create, createFolder, modify; no settings save; settings unchanged)', async () => {
  const setup = await manageSetup({ [`${dirOf('en', 'template')}/Mine.md`]: '## A\nx\n' });
  const before = JSON.stringify(setup.settings);
  const { modal, root } = await openManage(setup);
  for (const tab of tabsOf(root)) { tab.click(); await settle(); }
  newButton(root, 'format').click();
  typeName(formOf(root, 'format'), 'Something');
  tabsOf(root)[0].click();
  await settle();
  modal.close();
  assert.equal(writes(setup.v), 0);
  assert.equal(setup.v.trashes, 0);
  assert.equal(setup.settingSaves ?? 0, 0);
  assert.equal(JSON.stringify(setup.settings), before);
  assert.equal(opened.length, 0);
});

test('P3: each row names the item (built-ins marked), says "Used in: ..." or that nothing uses it, shows a style\'s four small labels, and lists problems with the line', async () => {
  const setup = await manageSetup({
    [`${dirOf('en', 'template')}/Mine.md`]: '## A\nx\n',
    [`${dirOf('en', 'template')}/Broken.md`]: '## A\nCount: x\nbody\n',
    [`${dirOf('en', 'template')}/Standard six.md`]: '## A\nx\n',
    [`${dirOf('en', 'recipe')}/Weekly.md`]: '---\nstructure: Mine\nvoice: Gone\nupdate: top\n---\nWeekly notes\n'
  }, { noteStyleByKind: { hypothesis: 'file:Weekly' } });
  const { root } = await openManage(setup, 'structure');
  const standard = rowFor(root, 'Standard six');
  const usedBy = setup.store.listParts('structure').find(item => item.ref === 'builtin:standard').usedBy;
  assert.equal(rowTexts(standard)[0], `Used in: ${usedBy.join(', ')}`);
  assert.ok(standard.children[0].children.some(child => child.text === 'Built-in'), 'marked built-in');
  const mine = rowFor(root, 'Mine');
  assert.equal(mine.children[0].children.some(child => child.text === 'Built-in'), false);
  assert.deepEqual(rowTexts(mine), ['Used in: Weekly']);
  const broken = rowFor(root, 'Broken');
  assert.equal(rowTexts(broken)[0], 'No style uses it now');
  assert.match(rowTexts(broken)[1], /^⚠ Line 2: /);
  assert.equal(dom.findAll(broken, node => node.hasClass('vam-block-status-error')).length, 1);
  // #22: a file with a built-in's name is a user's file with a problem, not a changed built-in
  const fileRows = rowsOf(root).filter(row => rowName(row) === 'Standard six');
  assert.equal(fileRows.length, 2);
  const userCopy = fileRows.find(row => !row.children[0].children.some(child => child.text === 'Built-in'));
  assert.match(rowTexts(userCopy).join('|'), /built-in name/);
  // styles: topic type names and the four labels
  dom.find(root, node => node.attrs.id === 'vam-manage-tab-recipe').click();
  await settle();
  const weekly = rowFor(root, 'Weekly');
  assert.deepEqual(rowTexts(weekly).slice(0, 2), ['Used in: Hypothesis', `Mine · Gone · Standard format · ${'New on top'}`]);
  assert.match(rowTexts(weekly)[2], /^⚠ Line 3: /);
  const general = rowFor(root, 'General research');
  assert.equal(rowTexts(general)[0], 'Used in: Topic');
  assert.equal(rowTexts(rowFor(root, 'Textbook'))[0], 'No topic type uses it now');
});

test('counter 14: the AIM report is listed with its topic type but has no Edit button, and is not offered as the start of a new style', async () => {
  const setup = await manageSetup();
  const { root } = await openManage(setup, 'recipe');
  const aim = rowFor(root, 'AIM report');
  assert.ok(aim);
  assert.equal(rowTexts(aim)[0], 'Used in: AIM conclusion note');
  assert.equal(editOf(aim), undefined);
  assert.ok(editOf(rowFor(root, 'General research')));
  newButton(root, 'recipe').click();
  const options = dom.findAll(sourceOf(formOf(root, 'recipe')), node => node.tag === 'option').map(node => node.text);
  assert.equal(options.includes('AIM report'), false);
  assert.equal(options.includes('AI suggested'), false);
  assert.equal(options.length, 7);
  const suggested = rowFor(root, 'AI suggested');
  assert.ok(suggested, 'listed');
  assert.equal(editOf(suggested), undefined, 'no Edit (it would copy a style that is not a text)');
  assert.equal(dom.findAll(suggested, node => node.tag === 'button').length, 0, 'no View, no Copy and edit, no menu');
  assert.equal(moreOf(suggested), undefined);
});

test('counter 5: Edit on a built-in part saves "My <name>" (a new file) and opens it, the list shows it and the focus is on its row; an existing "My ..." file is never overwritten', async () => {
  const taken = '## Taken\nkeep me\n';
  const setup = await manageSetup({ [`${dirOf('en', 'template')}/My Standard six.md`]: taken });
  const { root } = await openManage(setup, 'structure');
  editOf(rowFor(root, 'Standard six')).click();
  await settle();
  const created = `${dirOf('en', 'template')}/My Standard six (2).md`;
  assert.deepEqual(setup.v.creates, [created]);
  assert.equal(setup.v.files[`${dirOf('en', 'template')}/My Standard six.md`], taken, 'the taken file keeps its bytes');
  assert.deepEqual(opened, [created]);
  const row = rowFor(root, 'My Standard six (2)');
  assert.ok(row, 'the list was redrawn');
  assert.equal(editOf(row).focused, true);
  assert.equal(setup.settingSaves ?? 0, 0, 'editing changes no setting');
  // a file is opened as it is, nothing is written
  editOf(rowFor(root, 'My Standard six')).click();
  await settle();
  assert.equal(setup.v.creates.length, 1);
  assert.equal(opened.at(-1), `${dirOf('en', 'template')}/My Standard six.md`);
});

// Replaces the P3 test "Edit on a built-in style saves My <name> and opens the file" (decisions #41/#42 D3, D5: Edit opens the style editor; the file is written only by its Save).
test('P4: Edit on a built-in style opens the style editor on "My <name>" with the style\'s four parts and writes nothing; its Save writes the file, the list shows it and the focus is on its row', async () => {
  const setup = await manageSetup();
  const { root } = await openManage(setup, 'recipe');
  const edit = editOf(rowFor(root, 'Hypothesis test'));
  edit.click();
  await settle();
  assert.equal(windows.length, 2, 'the manage window and the editor');
  const editor = windows[1];
  assert.equal(editor.titleEl.text, 'Edit note style');
  assert.equal(writes(setup.v), 0, 'opening the editor writes nothing');
  assert.equal(dom.byLabel(editor.contentEl, 'Name').value, 'My Hypothesis test');
  editOf(rowFor(root, 'Hypothesis test')).click();
  await settle();
  assert.equal(windows.length, 2, 'a second editor is not opened on top of the first');
  dom.button(editor.modalEl, 'Save').click();
  await settle();
  const path = `${dirOf('en', 'recipe')}/My Hypothesis test.md`;
  assert.deepEqual(setup.v.creates, [path]);
  const read = M.parseRecipeFile(setup.v.files[path]);
  const hypothesis = setup.store.listRecipes().find(item => item.ref === 'builtin:hypothesis');
  assert.deepEqual(plain({ structure: read.structure, voice: read.voice, format: read.format, update: read.update }), plain({ structure: hypothesis.structure.ref, voice: hypothesis.voice.ref, format: hypothesis.format.ref, update: hypothesis.update }));
  assert.equal(opened.length, 0, 'saving opens no file tab');
  assert.equal(editOf(rowFor(root, 'My Hypothesis test')).focused, true);
  editOf(rowFor(root, 'My Hypothesis test')).click();
  await settle();
  assert.equal(windows.length, 3, 'a user\'s style opens in the editor too, as it is');
  assert.equal(dom.byLabel(windows[2].contentEl, 'Name').attrs.readonly, 'readonly');
  assert.equal(setup.v.creates.length, 1);
  assert.equal(setup.v.modifies.length, 0);
});

test('P3: the New form starts hidden, opens on a "start from" choice with a suggested name, follows the chosen source until the name is typed, and Blank turns the source off', async () => {
  const setup = await manageSetup();
  const { root } = await openManage(setup, 'structure');
  const form = formOf(root, 'structure');
  const toggle = newButton(root, 'structure');
  assert.equal(form.hidden, true);
  assert.equal(toggle.attrs['aria-expanded'], 'false');
  assert.equal(form.tag, 'fieldset');
  toggle.click();
  assert.equal(form.hidden, false);
  assert.equal(toggle.attrs['aria-expanded'], 'true');
  const radios = dom.findAll(form, node => node.type === 'radio');
  assert.equal(radios.length, 2);
  for (const radio of radios) assert.ok(dom.find(form, node => node.tag === 'label' && node.attrs.for === radio.attrs.id), 'a label for each radio');
  assert.equal(radios[0].checked, true);
  assert.equal(radios[0].focused, true);
  assert.equal(nameInputOf(form).value, 'My Standard six');
  const select = sourceOf(form);
  assert.equal(select.value, 'builtin:standard');
  select.value = 'builtin:hypothesis';
  select.change();
  assert.equal(nameInputOf(form).value, 'My Claim to verdict');
  radios[1].checked = true;
  radios[1].fire('change');
  assert.equal(select.disabled, true);
  assert.equal(nameInputOf(form).value, 'New structure');
  typeName(form, 'Mine');
  radios[0].checked = true;
  radios[0].fire('change');
  assert.equal(select.disabled, false);
  assert.equal(nameInputOf(form).value, 'Mine', 'a typed name is kept');
  assert.equal(errorOf(form).text, '');
  assert.equal(errorOf(form).attrs['aria-live'], 'polite');
  assert.equal(nameInputOf(form).attrs['aria-describedby'], errorOf(form).attrs.id);
});

test('counter 4: a name that is empty, padded, has / or \\ or .., is a built-in\'s name in any language or case, has an unsafe character, or is taken shows an error in the live region, disables Create, and writes nothing', async () => {
  const setup = await manageSetup({ [`${dirOf('en', 'tone')}/Taken.md`]: 'x' });
  const { root } = await openManage(setup, 'voice');
  newButton(root, 'voice').click();
  const form = formOf(root, 'voice');
  const cases = [['', /Enter a name/], [' x ', /start or end with a space/], ['a/b', /cannot contain \//], ['a\\b', /cannot contain \//], ['..', /"\.\."/], ['a..b', /"\.\."/], ['Academic rigor', /built-in/], ['ACADEMIC RIGOR', /built-in/], ['學術嚴謹', /built-in/], ['a:b', /any of/], ['a#b', /any of/], ['taken', /already exists/]];
  const academic = M.translate('en', 'ui.preset_name_academic');
  cases.push([academic, /built-in/], [M.translate('zh-TW', 'ui.preset_name_academic'), /built-in/], [M.translate('zh-CN', 'ui.preset_name_academic'), /built-in/]);
  for (const [value, pattern] of cases) {
    typeName(form, value);
    assert.match(errorOf(form).text, pattern, JSON.stringify(value));
    assert.equal(createOf(form).disabled, true, JSON.stringify(value));
    createOf(form).click();
    nameInputOf(form).keydown({ key: 'Enter' });
    await settle();
  }
  assert.equal(writes(setup.v), 0);
  assert.equal(opened.length, 0);
  typeName(form, 'Fine name');
  assert.equal(errorOf(form).text, '');
  assert.equal(createOf(form).disabled, false);
});

test('P3: Create on a part writes the copy (or the blank text), opens it, closes the form and puts the focus on the new row; no setting is saved', async () => {
  const setup = await manageSetup();
  const { root } = await openManage(setup, 'structure');
  newButton(root, 'structure').click();
  let form = formOf(root, 'structure');
  sourceOf(form).value = 'builtin:hypothesis';
  sourceOf(form).change();
  typeName(form, 'My own');
  createOf(form).click();
  await settle();
  const path = `${dirOf('en', 'template')}/My own.md`;
  assert.deepEqual(setup.v.creates, [path]);
  assert.match(setup.v.files[path], /^## /m);
  assert.notEqual(setup.v.files[path], M.translate('en', 'ui.part_blank_structure'), 'a copy, not the blank text');
  assert.deepEqual(opened, [path]);
  assert.equal(form.hidden, true);
  assert.equal(editOf(rowFor(root, 'My own')).focused, true);
  assert.equal(setup.settingSaves ?? 0, 0);
  // a blank structure gets the starter text, a blank voice is an empty file
  newButton(root, 'structure').click();
  const radios = dom.findAll(form, node => node.type === 'radio');
  radios[1].checked = true; radios[1].fire('change');
  assert.equal(nameInputOf(form).value, 'New structure');
  createOf(form).click();
  await settle();
  assert.equal(setup.v.files[`${dirOf('en', 'template')}/New structure.md`], M.translate('en', 'ui.part_blank_structure'));
  tabsOf(root)[2].click();
  await settle();
  newButton(root, 'voice').click();
  form = formOf(root, 'voice');
  dom.findAll(form, node => node.type === 'radio')[1].fire('change');
  createOf(form).click();
  await settle();
  assert.equal(setup.v.files[`${dirOf('en', 'tone')}/New voice.md`], '');
  assert.equal(editOf(rowFor(root, 'New voice')).focused, true);
});

// Replaces the P3 test "Create on a style writes a style file" (decision #42 D5: New opens the style editor without writing the file; Save writes it).
test('P4: Create on a style opens the style editor with the typed name and the chosen style\'s parts and writes nothing; Blank starts from the general research parts; Save writes the file, closes the form and puts the focus on the new row', async () => {
  const setup = await manageSetup();
  const { root } = await openManage(setup, 'recipe');
  newButton(root, 'recipe').click();
  const form = formOf(root, 'recipe');
  assert.equal(nameInputOf(form).value, 'My General research');
  sourceOf(form).value = 'builtin:evidence';
  sourceOf(form).change();
  assert.equal(nameInputOf(form).value, 'My Evidence record');
  typeName(form, 'Lab log');
  createOf(form).click();
  await settle();
  const path = `${dirOf('en', 'recipe')}/Lab log.md`;
  assert.equal(windows.length, 2);
  assert.equal(windows[1].titleEl.text, 'New note style');
  assert.equal(writes(setup.v), 0, 'the file is not written before Save');
  assert.equal(path in setup.v.files, false);
  assert.equal(dom.byLabel(windows[1].contentEl, 'Name').value, 'Lab log');
  dom.button(windows[1].modalEl, 'Save').click();
  await settle();
  const read = M.parseRecipeFile(setup.v.files[path]);
  const evidence = setup.store.listRecipes().find(item => item.ref === 'builtin:evidence');
  assert.deepEqual(plain({ structure: read.structure, voice: read.voice, format: read.format, update: read.update }), plain({ structure: evidence.structure.ref, voice: evidence.voice.ref, format: evidence.format.ref, update: evidence.update }));
  assert.equal(editOf(rowFor(root, 'Lab log')).focused, true);
  assert.equal(form.hidden, true);
  newButton(root, 'recipe').click();
  dom.findAll(form, node => node.type === 'radio')[1].fire('change');
  assert.equal(nameInputOf(form).value, 'New style');
  createOf(form).click();
  await settle();
  assert.equal(windows.length, 3);
  assert.equal(`${dirOf('en', 'recipe')}/New style.md` in setup.v.files, false);
  dom.button(windows[2].modalEl, 'Save').click();
  await settle();
  const blank = M.parseRecipeFile(setup.v.files[`${dirOf('en', 'recipe')}/New style.md`]);
  const general = setup.store.listRecipes().find(item => item.ref === 'builtin:general');
  assert.deepEqual(plain({ structure: blank.structure, voice: blank.voice, format: blank.format, update: blank.update }), plain({ structure: general.structure.ref, voice: general.voice.ref, format: general.format.ref, update: general.update }));
});

test('counter 15: every control in the window has a readable name (text, aria-label, or a label for it)', async () => {
  const setup = await manageSetup({ [`${dirOf('en', 'template')}/Mine.md`]: '## A\nx\n' });
  const { root } = await openManage(setup, 'structure');
  newButton(root, 'structure').click();
  const controls = dom.findAll(root, node => ['button', 'select', 'input'].includes(node.tag));
  assert.ok(controls.length > 8);
  for (const control of controls) {
    const named = control.text || control.attrs['aria-label'] || dom.find(root, node => node.tag === 'label' && node.attrs.for === control.attrs.id);
    assert.ok(named, `${control.tag} ${control.attrs.id ?? ''}`);
  }
  const edits = dom.findAll(root, node => node.tag === 'button' && node.text === 'Edit');
  assert.equal(new Set(edits.map(edit => edit.attrs['aria-label'])).size, edits.length, 'each Edit names its row');
});

test('P3: a window closed while the files are still being read draws nothing afterwards, and the closing callback runs once', async () => {
  const setup = await manageSetup();
  let closedCalls = 0;
  const modal = new NoteStyleManageModal(setup.app, setup.plugin, 'recipe', undefined, () => { closedCalls++; });
  modal.open();
  modal.close();
  await settle();
  assert.equal(closedCalls, 1);
  assert.equal(modal.contentEl.children.length, 0);
});

test('F1 R3 (was failing first): Edit on a style file reads the files again before the editor opens, so a file another program changed after the window opened is compared as it is now and the first Save writes', async () => {
  const path = `${dirOf('en', 'recipe')}/Weekly.md`;
  const text = M.recipeFileText({ ...STD, update: 'top' }, 'en');
  const setup = await manageSetup({ [path]: text });
  const { root } = await openManage(setup, 'recipe');
  const outside = `${text}Notes added in a tab.\n`;
  setup.v.files[path] = outside;
  editOf(rowFor(root, 'Weekly')).click();
  await settle();
  assert.equal(windows.length, 2);
  dom.findAll(windows[1].contentEl, node => node.type === 'radio')[2].checked = true;
  dom.findAll(windows[1].contentEl, node => node.type === 'radio')[2].fire('change');
  dom.button(windows[1].modalEl, 'Save').click();
  await settle();
  assert.deepEqual(setup.v.modifies, [path], 'the save wrote');
  assert.ok(setup.v.files[path].includes('Notes added in a tab.'), 'the other program\'s text is kept');
  assert.equal(notices.includes(M.translate('en', 'ui.recipe_notice_changed')), false, 'no "changed" notice');
});

test('K3 (P4): the voice tab lists no retired voice unless a style uses it (then marked "(retired)"); the copy source of a new voice never offers one', async () => {
  const setup = await manageSetup({ [`${dirOf('en', 'recipe')}/Old.md`]: '---\nvoice: Practical guide\n---\n' });
  const { root } = await openManage(setup, 'voice');
  const names = rowsOf(root).map(rowName);
  assert.ok(names.includes('Practical guide (retired)'));
  assert.equal(names.includes('Key-point summary') || names.includes('Key-point summary (retired)'), false);
  assert.equal(names.includes('AI choice') || names.includes('AI choice (retired)'), false);
  assert.ok(names.includes('Professional'));
  const edit = editOf(rowFor(root, 'Practical guide (retired)'));
  assert.ok(edit.attrs['aria-label'].includes('retired'));
  const sources = dom.findAll(formOf(root, 'voice'), node => node.tag === 'option').map(node => node.text);
  assert.equal(sources.some(text => /Practical guide|Key-point summary|AI choice/.test(text)), false);
});

// ---- P1 (note-style settings redesign): copy once, AIM off in the lists, modals in the trigger's window ----
test('P1 copy once: "Edit" on a built-in part twice (copyPartOnce, and main\'s editNotePart) makes one file; the second call opens that file and says nothing', async () => {
  const setup = await manageSetup();
  const first = await setup.store.copyPartOnce('voice', 'builtin:guide');
  assert.deepEqual(plain(first), { ref: 'file:My Practical guide', created: true });
  const second = await setup.store.copyPartOnce('voice', 'builtin:guide');
  assert.deepEqual(plain(second), { ref: 'file:My Practical guide', created: false });
  assert.equal(setup.v.creates.length, 1);
  // a file ref is returned as it is and nothing is written
  assert.deepEqual(plain(await setup.store.copyPartOnce('voice', 'file:My Practical guide')), { ref: 'file:My Practical guide', created: false });
  assert.equal(setup.v.creates.length, 1);
  // through the plugin: the same file opens, one notice only for a real copy
  const before = notices.length;
  assert.equal(await setup.plugin.editNotePart('structure', 'builtin:standard'), 'file:My Standard six');
  assert.equal(await setup.plugin.editNotePart('structure', 'builtin:standard'), 'file:My Standard six');
  assert.equal(setup.v.creates.length, 2);
  assert.equal(notices.length - before, 1);
  assert.equal(opened.length, 2);
  assert.equal(opened[0], opened[1]);
});

test('P1 copy once: an identical copy that already exists under another name (e.g. with " (2)") is opened, the plain name first; a changed copy does not count, so a fresh copy is made', async () => {
  const setup = await manageSetup();
  const text = (await (async () => { const ref = await setup.store.copyPartOnce('format', 'builtin:lean'); return setup.v.files[`${dirOf('en', 'format')}/${ref.ref.slice(5)}.md`]; })());
  const dir = dirOf('en', 'format');
  setup.v.files[`${dir}/Lean copy (2).md`] = text;
  setup.v.files[`${dir}/A copy.md`] = text;
  await setup.store.refresh();
  const created = setup.v.creates.length;
  assert.equal((await setup.store.copyPartOnce('format', 'builtin:lean')).ref, 'file:A copy');
  assert.equal(setup.v.creates.length, created);
  // edit every copy: none is identical to the built-in any more, so a new copy is made
  for (const file of Object.keys(setup.v.files).filter(f => f.startsWith(`${dir}/`))) setup.v.files[file] = `${setup.v.files[file]}\nMine.\n`;
  await setup.store.refresh();
  const next = await setup.store.copyPartOnce('format', 'builtin:lean');
  assert.equal(next.created, true);
  assert.equal(setup.v.creates.length, created + 1);
});

test('P1 copy once: the manage window\'s Edit on a built-in voice twice leaves one file', async () => {
  const setup = await manageSetup();
  const { root } = await openManage(setup, 'voice');
  for (let n = 0; n < 2; n++) { editOf(rowFor(root, 'Professional')).click(); await settle(); }
  const files = Object.keys(setup.v.files).filter(f => f.startsWith(`${dirOf('en', 'tone')}/`));
  assert.equal(files.length, 1);
});

test('P1 AIM off: the manage window lists no AIM report and no "AIM conclusion note"; the settings count has no AIM built-in', async () => {
  const hidden = S.loadHidden('ui/modals/note-style-manage-modal.ts', { obsidian });
  const hiddenSettings = S.loadHidden('ui/settings-tab.ts', { obsidian });
  const setup = await manageSetup();
  const modal = new hidden.NoteStyleManageModal(setup.app, setup.plugin, 'recipe');
  modal.open();
  await settle();
  assert.equal(rowFor(modal.contentEl, 'AIM report'), undefined);
  assert.ok(rowsOf(modal.contentEl).every(row => !rowTexts(row).some(text => text.includes('AIM'))));
  const count = settingsModule => {
    const setting = { name: '', descEl: dom.element('div'), setName(v) { this.name = v; return this; }, addButton() { return this; } };
    settingsModule.renderMyStylesSetting(setting, setup.plugin);
    return setting.name;
  };
  const off = count(hiddenSettings);
  const onSettings = S.load('ui/settings-tab.ts', { obsidian });
  assert.equal(count(onSettings), off, 'the AIM report is built in, so the My styles row counts the same with AIM on or off');
  assert.equal(off, M.translate('en', 'ui.my_styles_count_0_1', 0, 0));
});

test('P1 popout: a modal opened for a button in another window is moved to that window\'s body; in the same window, or with no anchor, nothing moves', () => {
  const { openInWindowOf } = S.load('ui/modals/open-in-window.ts');
  const body = name => ({ name, children: [], appendChild(node) { node.ownerDocument = this.doc; this.children.push(node); return node; } });
  const main = { body: body('main') }; main.body.doc = main;
  const popout = { body: body('popout') }; popout.body.doc = popout;
  const make = () => { const modal = { containerEl: { ownerDocument: main }, opened: 0, open() { this.opened++; } }; return modal; };
  const modal = make();
  openInWindowOf(modal, { ownerDocument: popout });
  assert.equal(modal.opened, 1);
  assert.equal(modal.containerEl.ownerDocument, popout);
  assert.equal(popout.body.children[0], modal.containerEl);
  const same = make();
  openInWindowOf(same, { ownerDocument: main });
  assert.equal(main.body.children.length, 0);
  const none = make();
  openInWindowOf(none, undefined);
  assert.equal(none.opened, 1);
  assert.equal(none.containerEl.ownerDocument, main);
});


test('P1 popout: a notice for a button in another window moves into that window\'s notice container, made when missing; in the same window, or with no anchor, it stays', () => {
  const made = [];
  class Notice { constructor(message) { this.message = message; this.containerEl = { ownerDocument: main }; made.push(this); } }
  const { noticeInWindowOf } = S.load('ui/modals/notice-in-window.ts', { obsidian: { Notice } });
  const host = doc => ({ children: [], appendChild(node) { node.ownerDocument = doc; this.children.push(node); return node; } });
  const main = {};
  const popout = { body: { hosts: [], querySelector() { return this.hosts[0] || null; }, createDiv(options) { const h = { cls: options.cls, ...host(popout) }; this.hosts.push(h); return h; } } };
  const first = noticeInWindowOf('ready', { ownerDocument: popout });
  assert.equal(first.message, 'ready');
  assert.equal(popout.body.hosts.length, 1);
  assert.equal(popout.body.hosts[0].cls, 'notice-container');
  assert.equal(first.containerEl.ownerDocument, popout);
  noticeInWindowOf('again', { ownerDocument: popout });
  assert.equal(popout.body.hosts.length, 1, 'an existing notice container is reused');
  assert.equal(popout.body.hosts[0].children.length, 2);
  main.body = { querySelector() { throw new Error('same window: nothing moves'); } };
  assert.equal(noticeInWindowOf('here', { ownerDocument: main }).containerEl.ownerDocument, main);
  assert.equal(noticeInWindowOf('none', undefined).containerEl.ownerDocument, main);
  assert.equal(made.length, 4);
});

test('P1 popout: the focus that onOpen set inside the modal is set again after the move to the other window (was failing first)', () => {
  const { openInWindowOf } = S.load('ui/modals/open-in-window.ts');
  const popout = { body: { appendChild(node) { node.ownerDocument = popout; return node; } } };
  const inside = { focusCount: 0, focus() { this.focusCount++; } };
  const outside = { focusCount: 0, focus() { this.focusCount++; } };
  const main = { activeElement: inside };
  const modal = { containerEl: { ownerDocument: main, contains: node => node === inside }, open() {} };
  openInWindowOf(modal, { ownerDocument: popout });
  assert.equal(inside.focusCount, 1);
  const other = { containerEl: { ownerDocument: { activeElement: outside }, contains: node => node === inside }, open() {} };
  openInWindowOf(other, { ownerDocument: popout });
  assert.equal(outside.focusCount, 0, 'a focus outside the modal is left alone');
});

// ---- listUnusedCopies (settings-redesign P3, A5): read-only, shared with the manage window's clean-up ----
const same = (actual, expected) => assert.deepEqual(plain(actual), expected);
const STYLES_DIR = language => dirOf(language, 'recipe');
const VOICE_DIR = language => dirOf(language, 'tone');

test('P3 unused copies: a part file equal to a built-in, or to another file, and used by nothing, is a copy; of equal unused files the one without a (n) suffix stays', async () => {
  const probe = await makeStore();
  await probe.store.createPart('format', 'builtin:lean', 'Copy of lean');
  const leanText = probe.v.files[`${dirOf('en', 'format')}/Copy of lean.md`];
  assert.ok(leanText);
  const files = {
    [`${dirOf('en', 'format')}/Copy of lean.md`]: leanText,
    [`${VOICE_DIR('en')}/Calm.md`]: 'Calm and short.\n',
    [`${VOICE_DIR('en')}/Calm (2).md`]: 'Calm and short.\n',
    [`${VOICE_DIR('en')}/Calm (3).md`]: 'Calm and short.\n',
    [`${VOICE_DIR('en')}/Unique.md`]: 'Only mine.\n'
  };
  const { store, v } = await makeStore(files);
  const before = JSON.stringify(v.files);
  const copies = store.listUnusedCopies().map(copy => [copy.category, copy.name, copy.sameAs]);
  same(copies, [['voice', 'Calm (2)', 'file:Calm'], ['voice', 'Calm (3)', 'file:Calm'], ['format', 'Copy of lean', 'builtin:lean']]);
  assert.equal(writes(v), 0);
  assert.equal(JSON.stringify(v.files), before, 'nothing is written');
  assert.ok(store.listUnusedCopies().every(copy => copy.fileName === `${copy.name}.md` && copy.ref === `file:${copy.name}`));
});

test('P3 unused copies: a copy a style uses is not unused; when the kept one is used, the others are copies; a style a topic names counts as used', async () => {
  const voiceDir = VOICE_DIR('en');
  const style = (voice) => `---\nvoice: ${voice}\n---\n`;
  const files = {
    [`${voiceDir}/Calm.md`]: 'Calm and short.\n',
    [`${voiceDir}/Calm (2).md`]: 'Calm and short.\n',
    [`${STYLES_DIR('en')}/Uses second.md`]: style('Calm (2)')
  };
  const { store } = await makeStore(files);
  // "Calm (2)" is used by a style; "Calm" is equal to it and unused, so "Calm" is the copy
  same(store.listUnusedCopies().filter(copy => copy.category === 'voice').map(copy => [copy.name, copy.sameAs]), [['Calm', 'file:Calm (2)']]);
  // two styles with the same four settings: an unused one is a copy of the other unless a topic uses it
  const twin = { [`${STYLES_DIR('en')}/Twin.md`]: '---\nstructure: Standard six\nupdate: top\n---\n', [`${STYLES_DIR('en')}/Twin (2).md`]: '---\nstructure: Standard six\nupdate: top\n---\n' };
  const pair = await makeStore(twin);
  same(pair.store.listUnusedCopies().map(copy => [copy.category, copy.name, copy.sameAs]), [['recipe', 'Twin (2)', 'file:Twin']]);
  same(pair.store.listUnusedCopies(new Set(['file:Twin (2)'])).map(copy => copy.name), ['Twin'], 'the topic keeps (2), so the other is the copy');
  same(pair.store.listUnusedCopies(new Set(['file:Twin', 'file:Twin (2)'])), []);
  // used by a type
  const used = await makeStore(twin, { noteStyleByKind: { topic: 'file:Twin (2)' } });
  same(used.store.listUnusedCopies().map(copy => copy.name), ['Twin']);
});

test('P3 unused copies: a style equal to a built-in one (same four settings, voice and format following the global ones) is a copy; a style that sets its voice apart is not, and the AIM report is never the original', async () => {
  const dir = STYLES_DIR('en');
  const files = {
    [`${dir}/Like general.md`]: '---\nstructure: Standard six\nupdate: merge\n---\n',
    [`${dir}/Own voice.md`]: '---\nstructure: Standard six\nvoice: Plain explanation\nupdate: merge\n---\n',
    [`${dir}/Like aim.md`]: '---\nstructure: Standard six\nvoice: Professional\nformat: Standard format\nupdate: merge\n---\n'
  };
  const { store } = await makeStore(files);
  same(store.listUnusedCopies().map(copy => [copy.name, copy.sameAs]), [['Like general', 'builtin:general']]);
});

test('P3 unused copies: nothing to report for a store with no files, and the call does not need a refresh or create a folder', async () => {
  const { store, v } = await makeStore();
  same(store.listUnusedCopies(), []);
  assert.equal(writes(v), 0);
});

// ---- P5a (note-style settings redesign): rename that follows, delete to the trash, restore to built-in, duplicate, clean-up and undo ----
const RECIPES = dirOf('en', 'recipe');
const STRUCTURES = dirOf('en', 'template');
const VOICES = dirOf('en', 'tone');
const topicText = (ref, extra = '') => `---\ntitle: "T"\nnote-style: "${ref}"\ntags:\n  - a\n  - b\n---\n\nBody about ${ref}.\n${extra}`;
const snapshot = setup => JSON.stringify([setup.settings, setup.v.files, setup.topics, setup.v.renames, setup.v.trashes]);
const moreOf = row => dom.find(row, node => node.tag === 'button' && /^More actions/.test(node.attrs['aria-label'] ?? ''));
const menuOf = row => dom.find(row, node => node.attrs.role === 'menu');
const itemOf = (row, text) => dom.find(row, node => node.attrs.role === 'menuitem' && node.text === text);
async function pickMenu(row, text) { moreOf(row).click(); itemOf(row, text).click(); await settle(); }
const WEEKLY = M.recipeFileText({ ...STD, update: 'top' }, 'en');

test('P5a rename a style: the file, noteStyleByKind, the topics that chose it and nothing else change; other frontmatter lines and the body keep their bytes; legacy is left alone', async () => {
  const topics = { 'Maps/a.md': topicText('file:Weekly'), 'Maps/b.md': topicText('file:Other'), 'Maps/c.md': topicText('file:Weekly', '%% more %%\n'), 'Maps/d.md': '---\ntitle: "D"\n---\nNo style.\n' };
  const legacy = { templates: { t1: 'file:Mine' }, tones: { x: 'file:Calm' } };
  const setup = await manageSetup({ [`${RECIPES}/Weekly.md`]: WEEKLY, [`${RECIPES}/Other.md`]: WEEKLY }, { noteStyleByKind: { hypothesis: 'file:Weekly', action: 'file:Weekly', atomic: 'file:Other' }, noteStyleRecipe: { migrated: 1, legacy } }, { topics });
  const result = await setup.plugin.renameNoteStyle('recipe', 'file:Weekly', 'Monthly');
  assert.equal(result.ok, true);
  assert.equal(result.ref, 'file:Monthly');
  assert.deepEqual(setup.v.renames, [[`${RECIPES}/Weekly.md`, `${RECIPES}/Monthly.md`]]);
  assert.equal(setup.v.files[`${RECIPES}/Monthly.md`], WEEKLY, 'the content is the same bytes');
  assert.equal(`${RECIPES}/Weekly.md` in setup.v.files, false);
  assert.deepEqual(plain(setup.settings.noteStyleByKind), { hypothesis: 'file:Monthly', action: 'file:Monthly', atomic: 'file:Other' });
  assert.deepEqual(plain(setup.settings.noteStyleRecipe.legacy), legacy);
  assert.equal(setup.topics['Maps/a.md'], topics['Maps/a.md'].replace('file:Weekly"\ntags', 'file:Monthly"\ntags').replace('about file:Weekly', 'about file:Weekly'));
  assert.ok(setup.topics['Maps/a.md'].includes('note-style: "file:Monthly"') && setup.topics['Maps/a.md'].includes('Body about file:Weekly.'), 'only the frontmatter value changed, not the body');
  assert.equal(setup.topics['Maps/c.md'], topics['Maps/c.md'].replace('note-style: "file:Weekly"', 'note-style: "file:Monthly"'));
  assert.equal(setup.topics['Maps/b.md'], topics['Maps/b.md']);
  assert.equal(setup.topics['Maps/d.md'], topics['Maps/d.md']);
  assert.deepEqual(setup.topicWrites.sort(), ['Maps/a.md', 'Maps/c.md']);
  assert.equal(setup.settingSaves, 1);
  assert.deepEqual(plain(setup.v.modifies), [], 'no style file is rewritten');
  assert.equal(notices.length, 1);
  assert.equal(notices[0], M.translate('en', 'ui.manage_rename_done_0_1_2', 'Monthly', 2, 0));
});

test('P5a rename a part: the file, the style files that name it (only that key\'s value), the legacy table and the global setting follow; the other categories and other bytes stay', async () => {
  const alpha = '---\r\ntags: [x]\r\nstructure: "Mine"\r\nupdate: merge\r\n---\r\nAlpha body  \r\n';
  const beta = '---\n# the structure key\n段落結構: Mine\nvoice: Mine\n---\nBeta\n';
  const gamma = '---\nstructure: Elsewhere\n---\n';
  const files = { [`${STRUCTURES}/Mine.md`]: '## A\nx\n', [`${VOICES}/Mine.md`]: 'talk', [`${RECIPES}/Alpha.md`]: alpha, [`${RECIPES}/Beta.md`]: beta, [`${RECIPES}/Gamma.md`]: gamma };
  const legacy = { templates: { t1: 'file:Mine', t2: 'file:Z' }, tones: { x: 'file:Mine' } };
  const setup = await manageSetup(files, { noteStyleRecipe: { migrated: 1, legacy }, noteStyleDefaults: { voice: 'file:Mine' } });
  const result = await setup.plugin.renameNoteStyle('structure', 'file:Mine', 'Plan');
  assert.equal(result.ok, true);
  assert.equal(setup.v.files[`${STRUCTURES}/Plan.md`], '## A\nx\n');
  assert.equal(setup.v.files[`${VOICES}/Mine.md`], 'talk', 'the voice of the same name is another file');
  assert.equal(setup.v.files[`${RECIPES}/Alpha.md`], alpha.replace('structure: "Mine"', 'structure: "Plan"'));
  assert.equal(setup.v.files[`${RECIPES}/Beta.md`], beta.replace('段落結構: Mine', '段落結構: Plan'), 'the voice line of the same value is not touched');
  assert.equal(setup.v.files[`${RECIPES}/Gamma.md`], gamma);
  assert.deepEqual(plain(setup.settings.noteStyleRecipe.legacy), { templates: { t1: 'file:Plan', t2: 'file:Z' }, tones: { x: 'file:Mine' } });
  assert.deepEqual(plain(setup.settings.noteStyleDefaults), { voice: 'file:Mine' }, 'a structure rename does not touch the global voice');
  assert.equal(notices[0], M.translate('en', 'ui.manage_rename_done_0_1_2', 'Plan', 0, 2));
  // a voice rename follows the global voice and the tones table
  const voice = await setup.plugin.renameNoteStyle('voice', 'file:Mine', 'Calm');
  assert.equal(voice.ok, true);
  assert.deepEqual(plain(setup.settings.noteStyleDefaults), { voice: 'file:Calm' });
  assert.deepEqual(plain(setup.settings.noteStyleRecipe.legacy.tones), { x: 'file:Calm' });
  assert.equal(setup.v.files[`${RECIPES}/Beta.md`].includes('voice: Calm'), true);
  assert.equal(M.parseRecipeFile(setup.v.files[`${RECIPES}/Beta.md`]).structure, 'file:Plan');
});

test('P5a rename refused (counter): a taken name (any case), a built-in name, an empty, padded, separator, dots or unsafe name, or a missing file changes nothing: data.json, topics, style files and the vault stay byte for byte', async () => {
  const files = { [`${RECIPES}/Weekly.md`]: WEEKLY, [`${RECIPES}/Other.md`]: WEEKLY, [`${STRUCTURES}/Mine.md`]: '## A\nx\n', [`${STRUCTURES}/Other part.md`]: '## B\ny\n', [`${RECIPES}/User.md`]: '---\nstructure: Mine\n---\n' };
  const setup = await manageSetup(files, { noteStyleByKind: { hypothesis: 'file:Weekly' }, noteStyleRecipe: { migrated: 1, legacy: { templates: { t: 'file:Mine' }, tones: {} } } }, { topics: { 'Maps/a.md': topicText('file:Weekly') } });
  const before = snapshot(setup);
  for (const [category, ref, name, reason] of [
    ['recipe', 'file:Weekly', 'Other', 'taken'], ['recipe', 'file:Weekly', 'oTHER', 'taken'], ['recipe', 'file:Weekly', 'Hypothesis test', 'name'], ['recipe', 'file:Weekly', '一般研究', 'name'],
    ['recipe', 'file:Weekly', '', 'name'], ['recipe', 'file:Weekly', ' x', 'name'], ['recipe', 'file:Weekly', 'a/b', 'name'], ['recipe', 'file:Weekly', 'a..b', 'name'], ['recipe', 'file:Weekly', 'a:b', 'name'],
    ['structure', 'file:Mine', 'Other part', 'taken'], ['structure', 'file:Mine', 'Standard six', 'name'], ['structure', 'file:Mine', 'x\\y', 'name'],
    ['recipe', 'file:Gone', 'Fresh', 'missing'], ['recipe', 'builtin:general', 'Fresh', 'missing']
  ]) {
    const result = await setup.plugin.renameNoteStyle(category, ref, name);
    assert.equal(result.ok, false, `${ref} -> ${JSON.stringify(name)}`);
    assert.equal(result.reason, reason, `${ref} -> ${JSON.stringify(name)}`);
    assert.equal(snapshot(setup), before, `${ref} -> ${JSON.stringify(name)}`);
  }
  assert.equal(setup.settingSaves ?? 0, 0);
  assert.equal(setup.v.modifies.length, 0);
  // the same name is a no-op, not an error
  const same = await setup.plugin.renameNoteStyle('recipe', 'file:Weekly', 'Weekly');
  assert.equal(same.ok, true);
  assert.equal(same.unchanged, true);
  assert.equal(snapshot(setup), before);
});

test('P5a rename: one topic that cannot be written does not stop the others; the Notice names it; data.json and the written topics agree on the new name', async () => {
  const topics = { 'Maps/a.md': topicText('file:Weekly'), 'Maps/b.md': topicText('file:Weekly'), 'Maps/c.md': topicText('file:Weekly') };
  const setup = await manageSetup({ [`${RECIPES}/Weekly.md`]: WEEKLY }, { noteStyleByKind: { hypothesis: 'file:Weekly' } }, { topics, failTopics: ['Maps/b.md'] });
  const result = await setup.plugin.renameNoteStyle('recipe', 'file:Weekly', 'Monthly');
  assert.equal(result.ok, true);
  assert.deepEqual(plain(result.failed), ['Maps/b.md']);
  assert.ok(setup.topics['Maps/a.md'].includes('"file:Monthly"') && setup.topics['Maps/c.md'].includes('"file:Monthly"'));
  assert.equal(setup.topics['Maps/b.md'], topics['Maps/b.md'], 'the failed one is as it was');
  assert.deepEqual(plain(setup.settings.noteStyleByKind), { hypothesis: 'file:Monthly' });
  assert.equal(notices.length, 1 + 1);
  assert.equal(notices[0], M.translate('en', 'ui.manage_rename_done_0_1_2', 'Monthly', 2, 0));
  assert.equal(notices[1], M.translate('en', 'ui.manage_rename_failed_0', 'Maps/b.md'));
  // a topic changed by someone since it was read is not overwritten with the old guess
  const raced = await manageSetup({ [`${RECIPES}/Weekly.md`]: WEEKLY }, {}, { topics: { 'Maps/r.md': topicText('file:Weekly') } });
  raced.topics['Maps/r.md'] = topicText('file:Elsewhere');
  const noted = raced.plugin.topicNoteStyleRefs();
  assert.deepEqual(plain(noted), [{ path: 'Maps/r.md', ref: 'file:Elsewhere' }]);
});

test('P5a topicNoteStyleRefs reads the metadata cache only: it lists the topics that name a style and writes nothing', async () => {
  const setup = await manageSetup({}, {}, { topics: { 'Maps/a.md': topicText('file:A'), 'Maps/b.md': '---\ntitle: x\n---\n', 'Maps/c.md': topicText('builtin:action') } });
  assert.deepEqual(plain(setup.plugin.topicNoteStyleRefs()), [{ path: 'Maps/a.md', ref: 'file:A' }, { path: 'Maps/c.md', ref: 'builtin:action' }]);
  assert.equal(writes(setup.v) + setup.topicWrites.length, 0);
});

test('P5a repository.renameNoteStyleRef: only the note-style value changes (other lines, line endings, body); it writes nothing when the note no longer names the old style', async () => {
  const crlf = '---\r\ntitle: "T"\r\nnote-style: "file:Weekly"\r\ntags: [a]\r\n---\r\nBody\r\n';
  const app = { vault: { getAbstractFileByPath: path => new S.TFile(path), process: async (file, change) => { texts[file.path] = change(texts[file.path]); } } };
  const texts = { 'a.md': crlf, 'b.md': topicText('file:Other') };
  const repo = { app, file: path => new S.TFile(path) };
  assert.equal(await S.Repository.prototype.renameNoteStyleRef.call(repo, 'a.md', 'file:Weekly', 'file:Monthly'), true);
  assert.equal(texts['a.md'], crlf.replace('file:Weekly', 'file:Monthly'));
  const other = texts['b.md'];
  assert.equal(await S.Repository.prototype.renameNoteStyleRef.call(repo, 'b.md', 'file:Weekly', 'file:Monthly'), false);
  assert.equal(texts['b.md'], other);
});

test('P5a store: renameFile / duplicateFile / trashFile / restoreTrashed are serial, never overwrite, and trash goes through the port (recoverable)', async () => {
  const { store, v } = await makeStore({ [`${VOICES}/Calm.md`]: 'soft', [`${VOICES}/Calm (2).md`]: 'soft' });
  assert.equal(await store.duplicateFile('voice', 'file:Calm'), 'file:Calm (3)');
  assert.equal(v.files[`${VOICES}/Calm (3).md`], 'soft');
  assert.equal(await store.duplicateFile('voice', 'file:Calm'), 'file:Calm (4)');
  await assert.rejects(store.duplicateFile('voice', 'file:Gone'));
  assert.equal(await store.duplicateFile('voice', 'builtin:guide').catch(() => 'refused'), 'refused', 'a built-in is copied by createPart, not duplicated');
  const gone = await store.trashFile('voice', 'file:Calm (4)');
  assert.deepEqual(plain(gone), { category: 'voice', name: 'Calm (4)', text: 'soft' });
  assert.equal(v.trashes, 1);
  assert.equal(`${VOICES}/Calm (4).md` in v.files, false);
  assert.equal(store.listParts('voice').some(item => item.name === 'Calm (4)'), false);
  // restore: the old name when free, " (n)" when someone took it meanwhile
  v.files[`${VOICES}/Calm (4).md`] = 'taken meanwhile';
  await store.refresh();
  const restored = await store.restoreTrashed([gone]);
  assert.deepEqual(plain(restored), { restored: ['file:Calm (4) (2)'], failed: [] });
  assert.equal(v.files[`${VOICES}/Calm (4).md`], 'taken meanwhile');
  assert.equal(v.files[`${VOICES}/Calm (4) (2).md`], 'soft');
});

test('P5a clean-up: unused copies move to the trash at once and Undo brings them back (with " (n)" when the name is taken); a style a topic names is not a copy; the count on the settings row uses the same rule', async () => {
  const dup = { [`${VOICES}/Calm.md`]: 'soft', [`${VOICES}/Calm (2).md`]: 'soft', [`${RECIPES}/Like general.md`]: '---\n---\n', [`${RECIPES}/Like general (2).md`]: '---\n---\n' };
  const setup = await manageSetup(dup, {}, { topics: { 'Maps/a.md': topicText('file:Like general') } });
  const { root, modal } = await openManage(setup, 'recipe');
  const banner = dom.find(root, node => node.hasClass('vam-manage-banner'));
  assert.ok(banner, 'a banner offers the clean-up');
  assert.match(dom.texts(banner).join('|'), /Calm \(2\)/);
  assert.match(dom.texts(banner).join('|'), /Like general \(2\)/);
  assert.equal(dom.texts(banner).join('|').includes('|Like general|'), false, 'the style the topic names is kept');
  assert.equal(writes(setup.v), 0, 'opening the window and showing the banner write nothing');
  // the settings row counts the same
  const setting = { name: '', descEl: dom.element('div'), setName(value) { this.name = value; return this; }, addButton() { return this; } };
  S.load('ui/settings-tab.ts', { obsidian }).renderMyStylesSetting(setting, setup.plugin);
  assert.equal(dom.texts(setting.descEl)[0], M.translate('en', 'ui.my_styles_unused_0', 2));
  dom.button(banner, 'Move to trash').click();
  await settle();
  assert.equal(setup.v.trashes, 2);
  assert.equal(`${VOICES}/Calm (2).md` in setup.v.files, false);
  assert.equal(`${RECIPES}/Like general (2).md` in setup.v.files, false);
  assert.ok(setup.v.files[`${VOICES}/Calm.md`] && setup.v.files[`${RECIPES}/Like general.md`], 'the ones that stay are still there');
  const done = dom.find(root, node => node.hasClass('vam-manage-banner'));
  assert.match(dom.texts(done).join('|'), /Obsidian trash/);
  assert.equal(rowFor(root, 'Like general (2)'), undefined, 'the list is drawn again');
  setup.v.files[`${VOICES}/Calm (2).md`] = 'someone made this';
  dom.button(done, 'Undo').click();
  await settle();
  assert.equal(setup.v.files[`${VOICES}/Calm (2).md`], 'someone made this', 'a name taken meanwhile is not overwritten');
  assert.equal(setup.v.files[`${VOICES}/Calm (2) (2).md`], 'soft');
  assert.equal(setup.v.files[`${RECIPES}/Like general (2).md`], '---\n---\n');
  assert.ok(rowFor(root, 'Like general (2)'), 'the list shows the restored file');
  modal.close();
});

test('P5a clean-up never trashes a part a style, the global setting or the legacy table uses (stylesUsing counts the global voice and format)', async () => {
  const files = { [`${VOICES}/Calm.md`]: 'soft', [`${VOICES}/Calm (2).md`]: 'soft', [`${STRUCTURES}/Old.md`]: '## A\nx\n', [`${STRUCTURES}/Old (2).md`]: '## A\nx\n' };
  const setup = await manageSetup(files, { noteStyleDefaults: { voice: 'file:Calm (2)' }, noteStyleRecipe: { migrated: 1, legacy: { templates: { t: 'file:Old (2)' }, tones: {} } } });
  assert.deepEqual(plain(setup.store.listUnusedCopies().map(copy => copy.name)), ['Old', 'Calm'], 'the used one is kept and its twin is the copy');
  assert.ok(setup.store.listParts('voice').find(item => item.ref === 'file:Calm (2)').usedBy.includes('General research'), 'a style that follows the global voice uses it');
  const plainVoice = setup.store.listParts('voice').find(item => item.ref === 'builtin:academic');
  assert.equal(plainVoice.usedBy.includes('General research'), false, 'the built-in default is not used by a style that follows another global voice');
});

test('P5a built-in rows: "View" then "Copy and edit"; View shows the text or the four settings in a read-only window and writes nothing; the AIM report has neither', async () => {
  const setup = await manageSetup();
  const { root } = await openManage(setup, 'recipe');
  const row = rowFor(root, 'Hypothesis test');
  assert.deepEqual(dom.findAll(row, node => node.tag === 'button').map(node => node.text), ['View', 'Copy and edit']);
  assert.equal(moreOf(row), undefined, 'a built-in has no menu');
  assert.equal(dom.findAll(rowFor(root, 'AIM report'), node => node.tag === 'button').length, 0);
  dom.button(row, 'View').click();
  await settle();
  assert.equal(windows.length, 2);
  assert.equal(writes(setup.v), 0);
  assert.ok(dom.findAll(windows[1].contentEl, node => node.tag === 'input' || node.tag === 'textarea').every(node => node.attrs.readonly === 'readonly' || node.disabled), 'nothing in it can be typed');
  assert.match(dom.texts(windows[1].contentEl).join('|'), /Claim to verdict/);
  assert.ok(dom.button(windows[1].modalEl, 'Close'));
  dom.button(row, 'View').click();
  await settle();
  assert.equal(windows.length, 2, 'one small window at a time');
  dom.button(windows[1].modalEl, 'Close').click();
  assert.equal(windows[1].closeCount, 1);
  tabsOf(root)[1].click();
  await settle();
  dom.button(rowFor(root, 'Standard six'), 'View').click();
  await settle();
  assert.match(dom.texts(windows[2].contentEl).join('\n'), /## /);
  assert.equal(writes(setup.v), 0, 'viewing never copies');
  assert.deepEqual(opened, []);
});

test('Esc reaches the window through its onEscapeKey (what Obsidian binds): with the "..." menu open only the menu closes and focus returns to the button; with it closed the window closes (was failing first)', async () => {
  const setup = await manageSetup({ [`${RECIPES}/Weekly.md`]: WEEKLY }, {});
  const { root, modal } = await openManage(setup, 'recipe');
  const row = rowFor(root, 'Weekly');
  const more = moreOf(row);
  more.click();
  assert.ok(menuOf(row));
  assert.equal(modal.scope.press('Escape'), false);
  assert.equal(menuOf(row), undefined);
  assert.equal(more.focused, true);
  assert.equal(modal.closeCount, 0, 'the window stays');
  more.click();
  modal.onEscapeKey();
  assert.equal(menuOf(row), undefined);
  assert.equal(modal.closeCount, 0);
  modal.scope.press('Escape');
  assert.equal(modal.closeCount, 1, 'no menu: Escape closes the window');
});

test('P5a own rows: "Edit" and a "..." menu button named for the row; the menu is role=menu with items, opens and closes with the button and Escape (focus back on the button)', async () => {
  const setup = await manageSetup({ [`${RECIPES}/Weekly.md`]: WEEKLY, [`${RECIPES}/Used.md`]: WEEKLY }, { noteStyleByKind: { action: 'file:Used' } });
  const { root } = await openManage(setup, 'recipe');
  const row = rowFor(root, 'Weekly');
  assert.ok(editOf(row));
  const more = moreOf(row);
  assert.equal(more.attrs['aria-label'], 'More actions: Weekly');
  assert.equal(more.attrs['aria-expanded'], 'false');
  assert.equal(menuOf(row), undefined, 'closed at first');
  more.click();
  assert.equal(more.attrs['aria-expanded'], 'true');
  assert.equal(menuOf(row).attrs.role, 'menu');
  assert.deepEqual(dom.findAll(menuOf(row), node => node.attrs.role === 'menuitem').map(node => node.text), ['Rename…', 'Duplicate', 'Delete (move to trash)'], 'no "restore" for a style no topic type uses');
  menuOf(row).keydown({ key: 'Escape' });
  assert.equal(menuOf(row), undefined);
  assert.equal(more.attrs['aria-expanded'], 'false');
  assert.equal(more.focused, true);
  more.click();
  more.click();
  assert.equal(menuOf(row), undefined, 'the button toggles');
  // a style a topic type uses has the restore item
  const used = rowFor(root, 'Used');
  moreOf(used).click();
  assert.deepEqual(dom.findAll(menuOf(used), node => node.attrs.role === 'menuitem').map(node => node.text), ['Rename…', 'Duplicate', 'Restore the built-in default', 'Delete (move to trash)']);
  moreOf(row).click();
  assert.equal(menuOf(used), undefined, 'one menu at a time');
  assert.equal(writes(setup.v), 0);
});

test('P5a Rename… opens a small window in the same window as the manage one (name field prefilled, error live, Rename disabled for a bad or taken name); Cancel changes nothing; Rename follows through and puts the focus on the row', async () => {
  const setup = await manageSetup({ [`${RECIPES}/Weekly.md`]: WEEKLY, [`${RECIPES}/Other.md`]: WEEKLY }, { noteStyleByKind: { hypothesis: 'file:Weekly' } }, { topics: { 'Maps/a.md': topicText('file:Weekly') } });
  const { root } = await openManage(setup, 'recipe');
  const before = snapshot(setup);
  await pickMenu(rowFor(root, 'Weekly'), 'Rename…');
  assert.equal(windows.length, 2);
  const dialog = windows[1];
  const input = dom.byLabel(dialog.contentEl, 'Name');
  assert.equal(input.value, 'Weekly');
  const rename = dom.button(dialog.modalEl, 'Rename');
  const error = dom.find(dialog.contentEl, node => node.hasClass('vam-manage-error'));
  assert.equal(error.attrs['aria-live'], 'polite');
  for (const [value, pattern] of [['Other', /already exists/], ['', /Enter a name/], ['Hypothesis test', /built-in/], ['a/b', /cannot contain \//]]) {
    input.value = value; input.fire('input');
    assert.match(error.text, pattern, value);
    assert.equal(rename.disabled, true, value);
  }
  rename.click();
  await settle();
  assert.equal(snapshot(setup), before);
  input.value = 'Weekly'; input.fire('input');
  assert.equal(rename.disabled, true, 'the old name is not a rename');
  dom.button(dialog.modalEl, 'Cancel').click();
  await settle();
  assert.equal(dialog.closeCount, 1);
  assert.equal(snapshot(setup), before);
  await pickMenu(rowFor(root, 'Weekly'), 'Rename…');
  const second = windows[2];
  const field = dom.byLabel(second.contentEl, 'Name');
  field.value = 'Monthly'; field.fire('input');
  assert.equal(dom.find(second.contentEl, node => node.hasClass('vam-manage-error')).text, '');
  dom.button(second.modalEl, 'Rename').click();
  await settle();
  assert.equal(second.closeCount, 1);
  assert.ok(rowFor(root, 'Monthly') && !rowFor(root, 'Weekly'));
  assert.equal(editOf(rowFor(root, 'Monthly')).focused, true);
  assert.deepEqual(plain(setup.settings.noteStyleByKind), { hypothesis: 'file:Monthly' });
  assert.ok(setup.topics['Maps/a.md'].includes('"file:Monthly"'));
});

test('P5a Duplicate makes a " (n)" copy of the file and puts the focus on it; the copy is a plain file nothing uses', async () => {
  const setup = await manageSetup({ [`${RECIPES}/Weekly.md`]: WEEKLY });
  const { root } = await openManage(setup, 'recipe');
  await pickMenu(rowFor(root, 'Weekly'), 'Duplicate');
  assert.equal(setup.v.files[`${RECIPES}/Weekly (2).md`], WEEKLY);
  assert.equal(editOf(rowFor(root, 'Weekly (2)')).focused, true);
  await pickMenu(rowFor(root, 'Weekly'), 'Duplicate');
  assert.equal(setup.v.files[`${RECIPES}/Weekly (3).md`], WEEKLY);
  assert.equal(setup.settingSaves ?? 0, 0);
});

test('P5a Restore the built-in default removes the keys of the topic types that use the style (one save); the file stays; topics are not touched', async () => {
  const setup = await manageSetup({ [`${RECIPES}/Weekly.md`]: WEEKLY, [`${RECIPES}/Other.md`]: WEEKLY }, { noteStyleByKind: { hypothesis: 'file:Weekly', action: 'file:Weekly', atomic: 'file:Other' } }, { topics: { 'Maps/a.md': topicText('file:Weekly') } });
  const { root } = await openManage(setup, 'recipe');
  await pickMenu(rowFor(root, 'Weekly'), 'Restore the built-in default');
  assert.deepEqual(plain(setup.settings.noteStyleByKind), { atomic: 'file:Other' });
  assert.equal(setup.settingSaves, 1);
  assert.equal(setup.v.trashes, 0);
  assert.equal(setup.v.files[`${RECIPES}/Weekly.md`], WEEKLY);
  assert.equal(setup.topics['Maps/a.md'], topicText('file:Weekly'));
  assert.ok(rowFor(root, 'Weekly'));
  assert.match(rowTexts(rowFor(root, 'Weekly'))[0], /No topic type uses it now/);
  // the last key goes: the whole object goes
  await pickMenu(rowFor(root, 'Other'), 'Restore the built-in default');
  assert.equal('noteStyleByKind' in setup.settings, false);
});

test('P5a Delete: the delete question opens with the focus on the safe "Cancel", not on "Move to trash", even though open() moves focus to the first button after onOpen (was failing first)', async () => {
  const setup = await manageSetup({ [`${RECIPES}/Weekly.md`]: WEEKLY }, {});
  const { root } = await openManage(setup, 'recipe');
  await pickMenu(rowFor(root, 'Weekly'), 'Delete (move to trash)');
  assert.equal(dom.focusedNow(), dom.button(windows[1].modalEl, 'Cancel'), 'the last focus move leaves it on Cancel');
});

test('P5a Delete asks first and lists where the style is used; Cancel changes nothing; Move to trash uses the trash, frees the topic types (back to built-in) and leaves the topics alone', async () => {
  const setup = await manageSetup({ [`${RECIPES}/Weekly.md`]: WEEKLY }, { noteStyleByKind: { hypothesis: 'file:Weekly', action: 'file:Weekly' } }, { topics: { 'Maps/a.md': topicText('file:Weekly'), 'Maps/b.md': topicText('file:Weekly') } });
  const { root } = await openManage(setup, 'recipe');
  const before = snapshot(setup);
  await pickMenu(rowFor(root, 'Weekly'), 'Delete (move to trash)');
  assert.equal(windows.length, 2);
  assert.equal(setup.v.trashes, 0, 'nothing is trashed before the answer');
  const text = dom.texts(windows[1].contentEl).join('\n');
  assert.match(windows[1].titleEl.text, /Weekly/);
  assert.match(text, /Hypothesis, Action/);
  assert.match(text, /2 topics/);
  dom.button(windows[1].modalEl, 'Cancel').click();
  await settle();
  assert.equal(snapshot(setup), before, 'Cancel changes nothing');
  assert.equal(setup.settingSaves ?? 0, 0);
  await pickMenu(rowFor(root, 'Weekly'), 'Delete (move to trash)');
  dom.button(windows[2].modalEl, 'Move to trash').click();
  await settle();
  assert.equal(setup.v.trashes, 1);
  assert.equal(`${RECIPES}/Weekly.md` in setup.v.files, false);
  assert.equal('noteStyleByKind' in setup.settings, false, 'the keys of the types that used it are gone');
  assert.equal(setup.topics['Maps/a.md'], topicText('file:Weekly'));
  assert.equal(setup.topicWrites.length, 0);
  assert.equal(rowFor(root, 'Weekly'), undefined);
  // the topic that still names it falls back with the existing "not found" path
  const run = setup.store.runStyle({ topic: { style: 'file:Weekly' }, kind: 'hypothesis', outputLanguage: 'en' });
  assert.deepEqual(plain(run.issues.missing), ['file:Weekly'], 'the existing "not found" path reports the missing style');
  assert.equal(run.recipe.ref, 'builtin:hypothesis', 'and the type\'s built-in style is used');
});

test('P5a Delete of an unused style says so and still asks; Delete of a part lists the styles that name it, trashes it and leaves their files as they are (they fall back with a problem)', async () => {
  const user = '---\nstructure: Mine\n---\nbody\n';
  const setup = await manageSetup({ [`${RECIPES}/User.md`]: user, [`${STRUCTURES}/Mine.md`]: '## A\nx\n', [`${STRUCTURES}/Free.md`]: '## B\ny\n' }, { noteStyleDefaults: { voice: 'file:Calm' } });
  const { root } = await openManage(setup, 'structure');
  await pickMenu(rowFor(root, 'Free'), 'Delete (move to trash)');
  assert.match(dom.texts(windows[1].contentEl).join('\n'), /Nothing uses it/);
  dom.button(windows[1].modalEl, 'Cancel').click();
  await pickMenu(rowFor(root, 'Mine'), 'Delete (move to trash)');
  assert.match(dom.texts(windows[2].contentEl).join('\n'), /User/);
  assert.equal(setup.v.trashes, 0);
  dom.button(windows[2].modalEl, 'Move to trash').click();
  await settle();
  assert.equal(setup.v.trashes, 1);
  assert.equal(setup.v.files[`${RECIPES}/User.md`], user);
  const item = setup.store.listRecipes().find(entry => entry.ref === 'file:User');
  assert.ok(item.issues.some(issue => issue.code === 'part_missing'), 'the style shows the problem');
  assert.equal(item.structure.name, 'Mine');
  assert.deepEqual(plain(setup.settings.noteStyleDefaults), { voice: 'file:Calm' }, 'a structure delete leaves the global voice');
});

test('P5a opening the window, the menus, View and the dialogs\' Cancel write nothing: no create, modify, rename, trash, settings save or topic write', async () => {
  const setup = await manageSetup({ [`${RECIPES}/Weekly.md`]: WEEKLY, [`${STRUCTURES}/Mine.md`]: '## A\nx\n' }, { noteStyleByKind: { hypothesis: 'file:Weekly' } }, { topics: { 'Maps/a.md': topicText('file:Weekly') } });
  const before = snapshot(setup);
  const { root, modal } = await openManage(setup, 'recipe');
  for (const tab of tabsOf(root)) { tab.click(); await settle(); }
  tabsOf(root)[0].click();
  await settle();
  moreOf(rowFor(root, 'Weekly')).click();
  moreOf(rowFor(root, 'Weekly')).click();
  dom.button(rowFor(root, 'Textbook'), 'View').click();
  await settle();
  dom.button(windows.at(-1).modalEl, 'Close').click();
  await pickMenu(rowFor(root, 'Weekly'), 'Rename…');
  dom.button(windows.at(-1).modalEl, 'Cancel').click();
  await pickMenu(rowFor(root, 'Weekly'), 'Delete (move to trash)');
  dom.button(windows.at(-1).modalEl, 'Cancel').click();
  await settle();
  modal.close();
  assert.equal(snapshot(setup), before);
  assert.equal(setup.settingSaves ?? 0, 0);
  assert.equal(setup.topicWrites.length, 0);
});

test('P5a "Used in" for a part counts the global voice and format (a style that follows the global one uses it), and the AIM report stays out of every list when AIM is off', async () => {
  const hidden = S.loadHidden('ui/modals/note-style-manage-modal.ts', { obsidian });
  const setup = await manageSetup({ [`${VOICES}/Calm.md`]: 'soft' }, { noteStyleDefaults: { voice: 'file:Calm' } });
  const modal = new hidden.NoteStyleManageModal(setup.app, setup.plugin, 'voice');
  modal.open();
  await settle();
  const calm = rowFor(modal.contentEl, 'Calm');
  assert.match(rowTexts(calm)[0], /^Used in: .*General research/);
  assert.equal(rowTexts(calm)[0].includes('AIM'), false);
  const academic = rowFor(modal.contentEl, 'Academic rigor') ?? rowFor(modal.contentEl, 'Professional');
  assert.equal(rowTexts(academic)[0].includes('General research'), false, 'the built-in default no longer lists a style that follows another global voice');
});
