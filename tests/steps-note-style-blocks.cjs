// Ticket 04 P1: note style blocks in the store. The workspace template and tone come from two new settings keys
// (`noteTemplateBlock`, `noteToneBlock`) and block files in `<style folder>/<Blocks>/<Templates|Tones>/`; a user's own block
// reaches the prompt through `styleSelection`; copy and restore write files only on a user action and never overwrite.
// Unit level over an in-memory vault, plus service-level checks with a fake provider. The settings page is UI-checked later.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadSource } = require('./support-replay.cjs');

const M = loadSource(`
export { NoteStyleStore, runToneText } from "./ai/note-style-store";
export { NOTE_STYLE_BUILTIN_IDS } from "./ai/note-style-file";
export { previewPrompt, PREVIEW_STEPS } from "./core/blocks/prompt-preview";
export { lookupBuiltinBlock, builtinTemplateText } from "./core/blocks/builtin";
export { parseTemplateBlock } from "./core/blocks/template-block";
export { textbookTemplate } from "./ai/detail-templates";
export { listPresets, findPreset } from "./ai/prompt-presets";
export { translate, noteLanguageOf } from "./i18n";
export { AiTaskService } from "./core/ai-task-service";
`);
// The pure helpers are loaded when a test needs them, so a missing module fails that test and not the whole file.
const B = () => loadSource(`export * from "./core/blocks/block-files";`);

const LANGUAGES = ['zh-TW', 'zh-CN', 'en'];
const plain = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const STYLES = 'WS/S';
const TPL = `${STYLES}/Blocks/Templates`;
const TONE = `${STYLES}/Blocks/Tones`;
const BAK = `${STYLES}/Blocks/Backups`;
const PRESETS = [{ id: 'custom-tone-1', kind: 'tone', name: 'Pirate', text: 'Talk like a pirate.' }];
const OWN = '---\n語氣: 簡明\n---\n## 重點\n說明\n';
const BROKEN = '## A\nbody\n# Format rules\nr\n# Format rules\nr2\n';
const MINE = '## Alpha\nDescribe alpha.\n\n## Beta\nDescribe beta.\n\n# Format rules\n\nFORMAT-LINE-MINE\n';

/** An in-memory vault: folders are explicit, a created file never overwrites (names compare case-insensitively). */
function vault(files = {}) {
  const state = { files: { ...files }, folders: new Set(), trashed: [], created: [], failCreateUnder: undefined, log: [] };
  const under = folder => Object.keys(state.files).filter(file => file.startsWith(`${folder}/`) && !file.slice(folder.length + 1).includes('/'));
  state.port = {
    list: async folder => under(folder).map(file => file.slice(folder.length + 1)).filter(name => name.endsWith('.md')),
    read: async file => { if (!(file in state.files)) throw new Error(file); return state.files[file]; },
    folderExists: folder => state.folders.has(folder) || Object.keys(state.files).some(file => file.startsWith(`${folder}/`)),
    createFolder: async folder => { let cur = ''; for (const part of folder.split('/')) { cur = cur ? `${cur}/${part}` : part; state.folders.add(cur); } },
    create: async (file, content) => {
      if (state.failCreateUnder && file.startsWith(state.failCreateUnder)) throw new Error(`cannot write ${file}`);
      if (Object.keys(state.files).some(existing => existing.toLowerCase() === file.toLowerCase())) throw new Error(`exists: ${file}`);
      state.files[file] = content; state.created.push(file); state.log.push(`create ${file}`);
    },
    trash: async file => { state.log.push(`trash ${file}`); state.trashed.push({ file, content: state.files[file], backups: Object.keys(state.files).filter(f => f.startsWith(`${BAK}/`)) }); delete state.files[file]; }
  };
  return state;
}
function makeStore(settingsPatch = {}, files = {}, now) {
  const v = vault(files);
  const settings = { detailTemplates: [], promptPresets: PRESETS, workspaceFolder: 'WS', noteStylesFolder: STYLES, language: 'en', ...settingsPatch };
  let saves = 0;
  const store = new M.NoteStyleStore({ settings: () => settings, port: v.port, save: async () => { saves++; }, ...(now ? { now } : {}) });
  return { store, v, settings, saves: () => saves };
}
const stylesPath = (...parts) => parts.join('/');

function service(prompts) {
  const runtime = { runTask: async prompt => { prompts.push(prompt); return JSON.stringify({ summary: 'S', detail: 'A written note.', suggestions: [], visualReferences: [] }); } };
  return new M.AiTaskService({
    pluginDirectory: () => '/plugin', language: () => 'en', defaultReasoning: () => 'low', exchangeLoggingEnabled: () => false,
    diagramsEnabled: () => false, mermaidParses: async () => true, codexRuntime: () => runtime, claudeRuntime: () => runtime
  });
}
const BASE = { title: 'Topic', summary: 'Sum', rules: '', detail: '', task: 'Do it', ancestors: '', sourceContext: '', mode: 'task', researchMode: 'local', researchDepth: 'fast', visualMode: 'auto', outputLanguage: 'en' };
async function serviceText(fields) {
  const prompts = [];
  await service(prompts).askModel({ ...BASE, ...fields }, 'gpt-6-luna', 'low');
  assert.equal(prompts.length, 1);
  return prompts[0];
}
const defaultText = step => M.previewPrompt(step, 'en', 'codex', {}).text;
const fieldsOf = async (store, language = 'en') => { await store.refresh(); return store.workspaceStyleFields(language); };

// ---- counter 1 and D7: nothing new set, no block folder ----
test('counter 1: with no new key and no block folder the workspace fields equal the 05 baseline (5 presets, style file, old template, unset); only summary, plain and guide now carry their tone (D7)', async () => {
  const cases = [...M.NOTE_STYLE_BUILTIN_IDS.map(id => ({ defaultNoteStyleId: id })), { defaultNoteStyleId: 'style:Own' }, {}, { defaultDetailTemplateId: 'textbook' }];
  const toneOf = { summary: 'summary', plain: 'plain', guide: 'guide' };
  for (const patch of cases) for (const language of LANGUAGES) {
    const { store } = makeStore({ ...patch, language }, { [`${STYLES}/Own.md`]: OWN });
    await store.refresh();
    const got = store.workspaceStyleFields(language);
    const resolved = store.resolve([{}, {}]);
    const label = JSON.stringify(patch) + language;
    const baseline = M.runToneText(resolved, PRESETS, [undefined, undefined, undefined], language);
    const wanted = toneOf[patch.defaultNoteStyleId] ? M.lookupBuiltinBlock('tone', toneOf[patch.defaultNoteStyleId], language) : baseline;
    assert.equal(got.toneText, wanted, label);
    assert.deepEqual(plain(got.detailTemplate), plain(resolved.template), label);
    assert.deepEqual(plain(got.noteStyle), plain(store.contextFields(resolved.template).noteStyle), label);
    assert.equal(got.styleSelection, undefined, label);
    assert.equal(resolved.block, undefined, label);
    assert.equal(resolved.blockIssues, undefined, label);
    // the contextFields of a call that names no tone are the old ones
    assert.deepEqual(plain(store.contextFields(resolved.template)), plain(resolved.noteStyle ? { noteStyle: resolved.noteStyle, ...(resolved.noteStyle.diagrams ? {} : { styleDiagrams: false }) } : {}), label);
    if (!toneOf[patch.defaultNoteStyleId]) {
      // outside the three presets the prompt is the one the baseline fields give
      const old = { detailTemplate: got.detailTemplate, ...(baseline ? { toneText: baseline } : {}), ...(got.noteStyle ? { noteStyle: got.noteStyle } : {}), ...(got.styleDiagrams === false ? { styleDiagrams: false } : {}) };
      for (const step of M.PREVIEW_STEPS) assert.equal(M.previewPrompt(step.id, language, 'codex', got).text, M.previewPrompt(step.id, language, 'codex', old).text, `${label} ${step.id}`);
    }
  }
});

test('D7 chain: a tone the map or topic names beats the workspace tone; academic stays academic; an unknown id falls through', async () => {
  const { store } = makeStore({ defaultNoteStyleId: 'summary' });
  await store.refresh();
  const template = store.resolve([{}, {}]).template;
  const summary = M.lookupBuiltinBlock('tone', 'summary', 'en');
  assert.equal(store.toneTextFor(template, [], 'en'), summary);
  assert.equal(store.toneTextFor(template, [undefined, 'plain'], 'en'), M.lookupBuiltinBlock('tone', 'plain', 'en'));
  assert.equal(store.toneTextFor(template, ['academic'], 'en'), undefined);
  assert.equal(store.toneTextFor(template, ['gone-tone', undefined], 'en'), summary);
  assert.equal(store.toneTextFor(template, ['custom-tone-1'], 'en'), 'Talk like a pirate.');
});

test('Later item: a built-in tone cannot be overridden through the promptPresets setting, so its effective text is the built-in text', () => {
  const sneaky = [{ id: 'plain', kind: 'tone', name: 'x', text: 'override' }];
  assert.equal(M.findPreset(sneaky, 'tone', 'plain', 'en').text, M.lookupBuiltinBlock('tone', 'plain', 'en'));
  assert.equal(M.listPresets(sneaky, 'tone', 'en').filter(item => item.id === 'plain')[0].text, M.lookupBuiltinBlock('tone', 'plain', 'en'));
});

// ---- counter 2: an unchanged override is not a change ----
test('counter 2: the built-in Standard whose file holds the full text of another language (and CRLF) is unmodified: no body, prompt byte-equal to the default', async () => {
  for (const written of LANGUAGES) for (const run of LANGUAGES) {
    const text = M.builtinTemplateText('standard', written).replace(/\n/g, ' \r\n');
    const { store } = makeStore({ language: run, noteTemplateBlock: 'builtin:standard' }, { [`${TPL}/Standard.md`]: text });
    const fields = await fieldsOf(store, run);
    assert.equal(fields.styleSelection, undefined, `${written} ${run}`);
    for (const step of M.PREVIEW_STEPS)
      assert.equal(M.previewPrompt(step.id, run, 'codex', fields).text, M.previewPrompt(step.id, run, 'codex', {}).text, `${written} ${run} ${step.id}`);
  }
  // with no override file at all it is the same
  const { store } = makeStore({ noteTemplateBlock: 'builtin:textbook' });
  const fields = await fieldsOf(store);
  assert.equal(fields.styleSelection, undefined);
  assert.equal(fields.detailTemplate.id, 'textbook');
});

// ---- counter 3: a changed block is sent ----
test('counter 3: a changed override or a user block puts body and fileName in styleSelection; the prompt holds the new line; the template is the parsed one', async () => {
  const changed = `${M.builtinTemplateText('standard', 'en')}\n\nFORMAT-LINE-OVERRIDE\n`;
  const cases = [
    { ref: 'builtin:standard', files: { [`${TPL}/Standard.md`]: changed }, id: 'standard', fileName: 'Standard.md', line: 'FORMAT-LINE-OVERRIDE', text: changed },
    { ref: 'file:My tpl', files: { [`${TPL}/My tpl.md`]: MINE }, id: 'file:My tpl', fileName: 'My tpl.md', line: 'FORMAT-LINE-MINE', text: MINE }
  ];
  for (const item of cases) {
    const { store } = makeStore({ noteTemplateBlock: item.ref }, item.files);
    const fields = await fieldsOf(store);
    const resolved = store.resolve([{}, {}]);
    assert.deepEqual(plain(fields.styleSelection.template), { id: item.id, body: item.text, fileName: item.fileName });
    assert.deepEqual(plain(fields.styleSelection.tone), { id: 'academic' });
    assert.equal(resolved.blockIssues, undefined);
    const parsed = M.parseTemplateBlock(item.text, { id: item.id, name: item.fileName.replace(/\.md$/, '') });
    assert.equal(parsed.ok, true);
    assert.deepEqual(plain(resolved.template.sections), plain(parsed.template.sections));
    assert.deepEqual(plain(fields.detailTemplate.sections), plain(parsed.template.sections));
    for (const step of M.PREVIEW_STEPS.filter(s => s.id !== 'decompose')) {
      const text = M.previewPrompt(step.id, 'en', 'codex', fields).text;
      if (step.id !== 'merge') assert.ok(text.includes(item.line), `${item.ref} ${step.id}`);
    }
    // the service sends the same: the line is in the prompt a fake provider gets
    assert.ok((await serviceText(fields)).includes(item.line), item.ref);
  }
});

test('counter 4 (store part): a block with two format headings falls back to the built-in template, names file and line, and the service still produces the note', async () => {
  const { store } = makeStore({ noteTemplateBlock: 'file:Bad' }, { [`${TPL}/Bad.md`]: BROKEN });
  const fields = await fieldsOf(store);
  const resolved = store.resolve([{}, {}]);
  assert.equal(resolved.blockIssues.length, 1);
  assert.equal(resolved.blockIssues[0].fileName, 'Bad.md');
  assert.equal(resolved.blockIssues[0].line, 5);
  assert.equal(resolved.template.id, 'standard');
  assert.equal(fields.styleSelection.template.body, BROKEN);
  const preview = M.previewPrompt('research', 'en', 'codex', fields);
  assert.equal(preview.text, defaultText('research'));
  assert.equal(preview.issues[0].fileName, 'Bad.md');
  assert.equal(preview.issues[0].line, 5);
  assert.equal(await serviceText(fields), await serviceText({}));
  // a broken override of a built-in falls back to the same built-in id
  const textbook = makeStore({ noteTemplateBlock: 'builtin:textbook' }, { [`${TPL}/Textbook.md`]: BROKEN });
  await textbook.store.refresh();
  assert.equal(textbook.store.resolve([{}, {}]).template.id, 'textbook');
  assert.equal(textbook.store.resolve([{}, {}]).blockIssues.length, 1);
});

// ---- counter 5 ----
test('counter 5: a chosen block file that was deleted does not throw and falls back to Standard', async () => {
  for (const ref of ['file:Gone', 'builtin:nope', 'weird']) {
    const { store } = makeStore({ noteTemplateBlock: ref });
    await store.refresh();
    let resolved;
    assert.doesNotThrow(() => { resolved = store.resolve([{}, {}]); });
    assert.equal(resolved.template.id, 'standard', ref);
    assert.equal(resolved.block, undefined, ref);
    assert.ok(resolved.missing.includes(ref), ref);
    const fields = store.workspaceStyleFields('en');
    assert.equal(fields.styleSelection, undefined, ref);
    for (const step of M.PREVIEW_STEPS) assert.equal(M.previewPrompt(step.id, 'en', 'codex', fields).text, defaultText(step.id), `${ref} ${step.id}`);
  }
});

// ---- counter 6 ----
test('counter 6: a template the map or topic names wins over the workspace block; the workspace tone applies only when no tone is named', async () => {
  const { store } = makeStore({ noteTemplateBlock: 'file:My tpl', noteToneBlock: 'builtin:guide' }, { [`${TPL}/My tpl.md`]: MINE });
  await store.refresh();
  const mapWins = store.resolve([{ template: 'textbook' }, {}]);
  assert.equal(mapWins.template.id, 'textbook');
  assert.equal(mapWins.block, undefined);
  assert.equal(store.contextFields(mapWins.template, undefined, 'en').styleSelection, undefined);
  const own = store.resolve([{}, {}]);
  assert.equal(own.block.id, 'file:My tpl');
  const guide = M.lookupBuiltinBlock('tone', 'guide', 'en');
  assert.equal(store.toneTextFor(own.template, ['academic'], 'en'), undefined, 'academic named on the map stays academic');
  assert.equal(store.toneTextFor(own.template, [undefined, undefined], 'en'), guide);
  assert.equal(store.toneTextFor(mapWins.template, [undefined], 'en'), guide);
  assert.equal(store.toneTextFor(own.template, ['plain'], 'en'), M.lookupBuiltinBlock('tone', 'plain', 'en'));
  // a tone file only fills the gap when no tone preset is named
  const file = makeStore({ noteToneBlock: 'file:Pirate' }, { [`${TONE}/Pirate.md`]: 'Arr.\n' });
  await file.store.refresh();
  const t = file.store.resolve([{}, {}]).template;
  assert.equal(file.store.toneTextFor(t, [], 'en'), 'Arr.');
  assert.equal(file.store.toneTextFor(t, ['academic'], 'en'), undefined);
  assert.equal(file.store.toneTextFor(t, ['plain'], 'en'), M.lookupBuiltinBlock('tone', 'plain', 'en'));
});

// ---- counter 7: change of tone ----
test('counter 7: changing the tone A to B puts only B in every preview step and in the service prompt (built-in to built-in, built-in to own file, own file to academic, empty file)', async () => {
  const pirate = 'Write like a pirate captain.';
  const files = { [`${TONE}/Pirate.md`]: `${pirate}\n`, [`${TONE}/Hollow.md`]: '' };
  const summary = M.lookupBuiltinBlock('tone', 'summary', 'en');
  const guide = M.lookupBuiltinBlock('tone', 'guide', 'en');
  const run = async (key, steps = M.PREVIEW_STEPS.map(s => s.id)) => {
    const { store } = makeStore({ noteToneBlock: key }, files);
    const fields = await fieldsOf(store);
    return { fields, previews: steps.map(step => M.previewPrompt(step, 'en', 'codex', fields).text), sent: await serviceText(fields) };
  };
  const a1 = await run('builtin:summary');
  for (const text of [...a1.previews, a1.sent]) assert.ok(text.includes(summary));
  // built-in to built-in
  const b1 = await run('builtin:guide');
  for (const text of [...b1.previews, b1.sent]) { assert.ok(text.includes(guide)); assert.equal(text.includes(summary), false); }
  // built-in to own file: the file text is sent as written
  const b2 = await run('file:Pirate');
  for (const text of [...b2.previews, b2.sent]) { assert.ok(text.includes(pirate)); assert.equal(text.includes(guide), false); assert.equal(text.includes(summary), false); }
  // own file to academic: nothing, not even the tone rule sentence
  const b3 = await run('builtin:academic');
  M.PREVIEW_STEPS.forEach((step, index) => assert.equal(b3.previews[index], defaultText(step.id), step.id));
  assert.equal(b3.sent, await serviceText({}));
  // an empty tone file adds nothing either
  const b4 = await run('file:Hollow');
  M.PREVIEW_STEPS.forEach((step, index) => assert.equal(b4.previews[index], defaultText(step.id), step.id));
  assert.equal(b4.sent, await serviceText({}));
  // a built-in tone whose file was edited sends the edited text, and the unedited one does not change the prompt
  const edited = makeStore({ noteToneBlock: 'builtin:plain' }, { [`${TONE}/Plain explanation.md`]: 'My plain.\n' });
  const e = await fieldsOf(edited.store);
  assert.ok(M.previewPrompt('research', 'en', 'codex', e).text.includes('My plain.'));
  const same = makeStore({ noteToneBlock: 'builtin:plain' }, { [`${TONE}/Plain explanation.md`]: `${M.lookupBuiltinBlock('tone', 'plain', 'zh-TW')}\n` });
  const s = await fieldsOf(same.store);
  assert.equal(s.toneText, M.lookupBuiltinBlock('tone', 'plain', 'en'));
  // the styleSelection of a template block carries the same tone choice the context holds
  const both = makeStore({ noteTemplateBlock: 'file:My tpl', noteToneBlock: 'file:Pirate' }, { ...files, [`${TPL}/My tpl.md`]: MINE });
  const bf = await fieldsOf(both.store);
  assert.deepEqual(plain(bf.styleSelection.tone), { id: 'custom-legacy', body: pirate });
  assert.ok((await serviceText(bf)).includes(pirate));
});

// ---- counter 8 ----
test('counter 8: a style file that decides the tone keeps it; the workspace tone does not override', async () => {
  const files = { [`${STYLES}/Own.md`]: OWN };
  const withDefault = makeStore({ defaultNoteStyleId: 'style:Own', noteToneBlock: 'builtin:summary' }, files);
  await withDefault.store.refresh();
  const resolved = withDefault.store.resolve([{}, {}]);
  assert.equal(withDefault.store.workspaceStyleFields('en').toneText, '簡明');
  assert.equal(withDefault.store.toneTextFor(resolved.template, [], 'en'), '簡明');
  const onMap = makeStore({ noteTemplateBlock: 'builtin:standard', noteToneBlock: 'builtin:summary' }, files);
  await onMap.store.refresh();
  const mapResolved = onMap.store.resolve([{ template: 'style:Own' }, {}]);
  assert.equal(onMap.store.toneTextFor(mapResolved.template, [], 'en'), '簡明');
});

// ---- counter 9: copy ----
test('counter 9: copy gives a unique name ("x copy", "x copy (2)"), never overwrites, never takes a built-in name, is cleaned, stays in the block folder, and the setting points at it', async () => {
  for (const language of LANGUAGES) {
    const { store, v, settings, saves } = makeStore({ language });
    await store.refresh();
    const name = M.translate(language, 'ui.note_style_standard_short');
    const first = await store.copyBlock('template', 'builtin:standard');
    const second = await store.copyBlock('template', 'builtin:standard');
    const copy = M.translate(language, 'ui.block_copy_name_0', name);
    assert.equal(first, `file:${copy}`, language);
    assert.equal(second, `file:${copy} (2)`, language);
    assert.equal(settings.noteTemplateBlock, second);
    assert.ok(saves() >= 2);
    const root = `${STYLES}/${M.translate(language, 'ui.block_folder_name')}/${M.translate(language, 'ui.block_folder_template')}`;
    assert.equal(v.files[`${root}/${copy}.md`], M.builtinTemplateText('standard', language), language);
    assert.equal(v.files[`${root}/${copy} (2).md`], M.builtinTemplateText('standard', language), language);
    const items = store.listBlocks('template');
    assert.ok(items.some(item => item.ref === first && item.kind === 'file'));
    assert.ok(items.some(item => item.ref === second && item.kind === 'file'));
    assert.deepEqual(plain(items.filter(item => item.kind === 'builtin').map(item => item.ref)), ['builtin:standard', 'builtin:textbook']);
  }
  // a user's file of that name, created after the last refresh, is not touched
  const { store, v } = makeStore({});
  await store.refresh();
  v.files[`${TPL}/Standard copy.md`] = 'MINE, do not touch';
  v.folders.add(`${STYLES}/Blocks`); v.folders.add(TPL);
  const ref = await store.copyBlock('template', 'builtin:standard');
  assert.equal(ref, 'file:Standard copy (2)');
  assert.equal(v.files[`${TPL}/Standard copy.md`], 'MINE, do not touch');
  // the name is cleaned, and the path stays inside the folder
  const odd = makeStore({}, { [`${TPL}/We*ird [a].md`]: MINE });
  await odd.store.refresh();
  const oddRef = await odd.store.copyBlock('template', 'file:We*ird [a]');
  assert.equal(oddRef, 'file:We ird a copy');
  const made = odd.v.created[odd.v.created.length - 1];
  assert.ok(made.startsWith(`${TPL}/`) && !made.slice(TPL.length + 1).includes('/') && !/[\\/:*?"<>|#^[\]]/.test(made.slice(TPL.length + 1)), made);
  // a tone is copied the same way, into the tone folder; academic copies as an empty file
  const tone = makeStore({});
  await tone.store.refresh();
  const toneRef = await tone.store.copyBlock('tone', 'builtin:academic');
  assert.equal(toneRef, 'file:Academic rigor copy');
  assert.equal(tone.v.files[`${TONE}/Academic rigor copy.md`], '');
  assert.equal(tone.settings.noteToneBlock, toneRef);
  // the copy can be edited and the prompt follows
  const edit = makeStore({});
  await edit.store.refresh();
  const editRef = await edit.store.copyBlock('template', 'builtin:standard');
  const file = `${TPL}/${editRef.slice('file:'.length)}.md`;
  edit.v.files[file] = `${edit.v.files[file]}\nADDED-LINE-COPY\n`;
  const fields = await fieldsOf(edit.store);
  assert.ok(M.previewPrompt('research', 'en', 'codex', fields).text.includes('ADDED-LINE-COPY'));
  assert.ok((await serviceText(fields)).includes('ADDED-LINE-COPY'));
});

test('counter 9 (names): a copy name is never a built-in name, backup names carry the clock and are made unique', () => {
  const b = B();
  const taken = new Set();
  for (const category of ['template', 'tone']) for (const language of LANGUAGES) {
    const name = b.copyBlockName(category, '', language, taken);
    assert.equal(b.builtinBlockIdOfName(category, name), undefined, `${category} ${language} "${name}"`);
  }
  const clock = new Date(2026, 10, 2, 3, 4, 5);
  assert.equal(b.backupName('Standard', clock, new Set()), 'Standard 2026-11-02 030405.md');
  assert.equal(b.backupName('Standard', clock, new Set(['standard 2026-11-02 030405.md'])), 'Standard 2026-11-02 030405 (2).md');
});

// ---- counter 10: restore ----
test('counter 10: restore saves a byte-equal backup first, then moves the override to the trash; the prompt returns to the built-in text', async () => {
  const clock = new Date(2026, 10, 2, 3, 4, 5);
  for (const [category, ref, file, text] of [
    ['template', 'builtin:standard', `${TPL}/Standard.md`, `${M.builtinTemplateText('standard', 'en')}\nCHANGED-LINE\r\n  `],
    ['tone', 'builtin:plain', `${TONE}/Plain explanation.md`, 'My own plain tone \r\n']
  ]) {
    const { store, v, settings } = makeStore({ noteTemplateBlock: 'builtin:standard', noteToneBlock: 'builtin:plain' }, { [file]: text }, () => clock);
    await store.refresh();
    const before = await fieldsOf(store);
    if (category === 'template') assert.ok(before.styleSelection); else assert.ok(before.toneText.includes('My own plain tone'));
    const result = await store.restoreBlock(category, ref);
    assert.equal(result.ok, true, category);
    const backupFile = Object.keys(v.files).find(name => name.startsWith(`${BAK}/`));
    assert.ok(backupFile, category);
    assert.ok(/ 2026-11-02 030405\.md$/.test(backupFile), backupFile);
    assert.equal(v.files[backupFile], text, 'byte-equal');
    assert.equal(v.trashed.length, 1);
    assert.equal(v.trashed[0].file, file);
    assert.deepEqual(v.trashed[0].backups, [backupFile], 'the backup existed before the trash');
    assert.equal(file in v.files, false);
    const after = await fieldsOf(store);
    assert.equal(after.styleSelection, undefined);
    assert.equal(after.toneText, category === 'tone' ? M.lookupBuiltinBlock('tone', 'plain', 'en') : after.toneText);
    if (category === 'template') for (const step of M.PREVIEW_STEPS) assert.equal(M.previewPrompt(step.id, 'en', 'codex', after).text, M.previewPrompt(step.id, 'en', 'codex', { toneText: after.toneText }).text);
    // the backup folder is not a menu
    for (const c of ['template', 'tone']) assert.equal(store.listBlocks(c).some(item => item.name.includes('2026-11-02')), false);
    assert.equal(settings.noteTemplateBlock, 'builtin:standard');
    // again: nothing to restore
    const again = await store.restoreBlock(category, ref);
    assert.equal(again.ok, false);
    assert.equal(v.trashed.length, 1);
  }
});

test('counter 10 (refusals): a failed backup leaves the override alone; own blocks, files without an override and unknown refs are refused', async () => {
  const text = `${M.builtinTemplateText('standard', 'en')}\nCHANGED\n`;
  const files = { [`${TPL}/Standard.md`]: text, [`${TPL}/Mine.md`]: MINE };
  const failing = makeStore({}, files);
  await failing.store.refresh();
  failing.v.failCreateUnder = `${BAK}/`;
  const result = await failing.store.restoreBlock('template', 'builtin:standard');
  assert.equal(result.ok, false);
  assert.equal(failing.v.trashed.length, 0, 'no trash without a backup');
  assert.equal(failing.v.files[`${TPL}/Standard.md`], text);
  const ok = makeStore({}, files);
  await ok.store.refresh();
  for (const ref of ['file:Mine', 'builtin:textbook', 'builtin:nope', 'junk']) {
    const refused = await ok.store.restoreBlock('template', ref);
    assert.equal(refused.ok, false, ref);
  }
  assert.equal(ok.v.trashed.length, 0);
  assert.equal(Object.keys(ok.v.files).filter(name => name.startsWith(`${BAK}/`)).length, 0);
  // a file that is only named like a built-in with a "(2)" suffix is a user block, not an override
  const suffixed = makeStore({}, { [`${TPL}/Standard (2).md`]: MINE });
  await suffixed.store.refresh();
  assert.equal((await suffixed.store.restoreBlock('template', 'builtin:standard')).ok, false);
  assert.equal(suffixed.store.listBlocks('template').some(item => item.ref === 'file:Standard (2)'), true);
});

test('counter 10 (menu): the list marks a changed built-in, shows own files, ignores the backup folder', async () => {
  const { store } = makeStore({}, {
    [`${TPL}/標準.md`]: `${M.builtinTemplateText('standard', 'zh-TW')}\nX\n`,
    [`${TPL}/Textbook.md`]: M.builtinTemplateText('textbook', 'en'),
    [`${TPL}/Mine.md`]: MINE,
    [`${BAK}/Standard 2026-11-02 030405.md`]: 'old'
  });
  await store.refresh();
  const items = store.listBlocks('template');
  const standard = items.find(item => item.ref === 'builtin:standard');
  const textbook = items.find(item => item.ref === 'builtin:textbook');
  assert.equal(standard.modified, true);
  assert.equal(standard.fileName, '標準.md');
  assert.equal(textbook.modified, false);
  assert.equal(textbook.fileName, 'Textbook.md');
  assert.deepEqual(plain(items.filter(item => item.kind === 'file').map(item => item.ref)), ['file:Mine']);
  assert.equal(store.listBlocks('tone').filter(item => item.kind === 'builtin').length, 6);
});

// ---- counter 11: language gate ----
test('counter 11: the new block code never compares a language id and never uses one as a key', () => {
  const root = path.join(__dirname, '..');
  for (const file of ['core/blocks/block-files.ts', 'ai/note-style-store.ts']) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    assert.equal(/['"](zh-TW|zh-CN|en)['"]/.test(source), false, `${file} names a language id`);
  }
});

// ---- counter 12: zh-CN built-in text ----
test('counter 12: the zh-CN built-in template text has no Simplified heading, parses, and as a body gives a prompt byte-equal to no body', () => {
  for (const id of ['standard', 'textbook']) {
    const text = M.builtinTemplateText(id, 'zh-CN');
    assert.equal(text.includes('格式规则'), false, id);
    assert.equal(M.parseTemplateBlock(text, { id, name: id }).ok, true, id);
    for (const step of M.PREVIEW_STEPS) {
      const plainFields = id === 'textbook' ? { detailTemplate: M.textbookTemplate(M.noteLanguageOf('zh-CN')) } : {};
      const withBody = M.previewPrompt(step.id, 'zh-CN', 'codex', { ...plainFields, styleSelection: { template: { id, body: text }, tone: { id: 'academic' } } });
      assert.equal(withBody.text, M.previewPrompt(step.id, 'zh-CN', 'codex', plainFields).text, `${id} ${step.id}`);
      assert.equal(withBody.issues.length, 0);
    }
  }
});

// ---- counter 13: double copy ----
test('counter 13: two copies started together make two different files and lose nothing', async () => {
  const { store, v } = makeStore({});
  await store.refresh();
  const [a, b, c] = await Promise.all([store.copyBlock('template', 'builtin:standard'), store.copyBlock('template', 'builtin:standard'), store.copyBlock('tone', 'builtin:guide')]);
  assert.notEqual(a, b);
  assert.deepEqual([a, b], ['file:Standard copy', 'file:Standard copy (2)']);
  assert.equal(c, 'file:Practical guide copy');
  for (const name of ['Standard copy', 'Standard copy (2)']) assert.equal(v.files[`${TPL}/${name}.md`], M.builtinTemplateText('standard', 'en'));
  assert.equal(v.files[`${TONE}/Practical guide copy.md`], M.lookupBuiltinBlock('tone', 'guide', 'en'));
});

// ---- opening a block: the file exists, in the first spelling that exists ----
test('ensureBlockFile writes a built-in block once in the UI language, reuses an existing folder spelling and an existing file, and never overwrites', async () => {
  const { store, v } = makeStore({ language: 'zh-TW' });
  await store.refresh();
  const first = await store.ensureBlockFile('template', 'builtin:standard');
  assert.equal(first.path, `${STYLES}/積木/模板/標準.md`);
  assert.equal(v.files[first.path], M.builtinTemplateText('standard', 'zh-TW'));
  v.files[first.path] = 'EDITED';
  const again = await store.ensureBlockFile('template', 'builtin:standard');
  assert.equal(again.path, first.path);
  assert.equal(v.files[first.path], 'EDITED');
  // a vault that already has the English folder names keeps them, whatever the UI language
  const english = makeStore({ language: 'zh-TW' }, { [`${STYLES}/Blocks/Tones/Mine.md`]: 'x' });
  await english.store.refresh();
  const tone = await english.store.ensureBlockFile('tone', 'builtin:plain');
  assert.equal(tone.path, `${STYLES}/Blocks/Tones/白話說明.md`);
  assert.equal(english.v.files[tone.path], M.lookupBuiltinBlock('tone', 'plain', 'zh-TW'));
  await assert.rejects(() => english.store.ensureBlockFile('tone', 'file:Nope'));
  const own = await english.store.ensureBlockFile('tone', 'file:Mine');
  assert.equal(own.path, `${STYLES}/Blocks/Tones/Mine.md`);
});

// ---- the pure helpers ----
test('block-files: folder names are found by any spelling (existing first), built-in names match any language exactly, unmodified means equal to a built-in text', () => {
  const b = B();
  const exists = set => name => set.includes(name);
  assert.equal(b.resolveBlockFolder('S', 'root', exists([]), 'zh-TW'), 'S/積木');
  assert.equal(b.resolveBlockFolder('S', 'root', exists([]), 'en'), 'S/Blocks');
  assert.equal(b.resolveBlockFolder('S', 'root', exists(['S/积木', 'S/Blocks']), 'en'), 'S/积木');
  assert.equal(b.resolveBlockFolder('S', 'root', exists(['S/Blocks']), 'zh-TW'), 'S/Blocks');
  assert.equal(b.builtinBlockIdOfName('template', 'standard'), 'standard');
  assert.equal(b.builtinBlockIdOfName('template', '教科書'), 'textbook');
  assert.equal(b.builtinBlockIdOfName('tone', 'Key-point summary'), 'summary');
  assert.equal(b.builtinBlockIdOfName('template', 'Standard (2)'), undefined);
  assert.equal(b.builtinBlockIdOfName('template', 'Standard copy'), undefined);
  assert.equal(b.builtinBlockIdOfName('tone', 'Standard'), undefined);
  for (const language of LANGUAGES) {
    assert.equal(b.isUnmodifiedBlock('template', 'standard', M.builtinTemplateText('standard', language)), true);
    assert.equal(b.isUnmodifiedBlock('template', 'standard', `${M.builtinTemplateText('standard', language)}\nx`), false);
    assert.equal(b.isUnmodifiedBlock('tone', 'guide', M.lookupBuiltinBlock('tone', 'guide', language)), true);
  }
  assert.equal(b.isUnmodifiedBlock('tone', 'academic', ' \n'), true);
  assert.equal(b.isUnmodifiedBlock('tone', 'academic', 'x'), false);
  assert.deepEqual(plain(b.parseBlockRef('builtin:standard')), { kind: 'builtin', id: 'standard' });
  assert.deepEqual(plain(b.parseBlockRef('file:A b')), { kind: 'file', base: 'A b' });
  assert.equal(b.parseBlockRef('file:'), undefined);
  assert.equal(b.parseBlockRef('x'), undefined);
});
