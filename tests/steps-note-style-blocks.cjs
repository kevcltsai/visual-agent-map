// Ticket 04 P1: note style blocks in the store. The workspace template and tone come from two new settings keys
// (`noteTemplateBlock`, `noteToneBlock`) and part files in `<style folder>/<Structures|Voices>/`; a user's own block
// reaches the prompt through `styleSelection`; copy and restore write files only on a user action and never overwrite.
// Unit level over an in-memory vault, plus service-level checks with a fake provider. The settings page is UI-checked later.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadSource } = require('./support-replay.cjs');

const M = loadSource(`
export { NoteStyleStore } from "./ai/note-style-store";
export { previewPrompt, PREVIEW_STEPS } from "./core/blocks/prompt-preview";
export { lookupBuiltinBlock, builtinTemplateText, academicToneNote, stripToneComments } from "./core/blocks/builtin";
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
const TPL = `${STYLES}/Structures`;
const TONE = `${STYLES}/Voices`;
const BAK = `${STYLES}/Backups`;
const PRESETS = [{ id: 'custom-tone-1', kind: 'tone', name: 'Pirate', text: 'Talk like a pirate.' }];
const OWN = '---\n語氣: 簡明\n---\n## 重點\n說明\n';
// A count line that is not a number is a problem the sections parser reports (line 2); a second format rules heading is not one any more (Q1).
const BROKEN = '## A\nCount: x\nbody\n';
// The format rules are a part of their own (Q1): the marker line sits in a section, where the prompt reads it.
const MINE = '## Alpha\nDescribe alpha.\n\n## Beta\nDescribe beta. FORMAT-LINE-MINE\n';

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

// Since note-style-recipe T2 a run reads a style (recipe) and its parts, not the workspace block keys. A recipe file "Mix"
// in the style folder picks a structure and a voice by name (a built-in by its English name, an own file by its base name)
// and is made the style of general research with `noteStyleByKind.topic`.
const RECIPES = `${STYLES}/Styles`;
const partNameOf = (ref, kind) => (ref.startsWith('file:') ? ref.slice(5) : M.translate('en', kind === 'tone' ? `ui.preset_name_${ref.slice(8)}` : `ui.structure_name_${ref.slice(8)}`));
function mixOf({ structure, voice, format } = {}, settingsPatch = {}, files = {}) {
  const lines = ['---', ...(structure ? [`structure: ${partNameOf(structure, 'template')}`] : []), ...(voice ? [`voice: ${partNameOf(voice, 'tone')}`] : []), ...(format ? [`format: ${format}`] : []), '---', ''];
  return [{ ...settingsPatch, noteStyleByKind: { topic: 'file:Mix' } }, { ...files, [`${RECIPES}/Mix.md`]: lines.join('\n') }];
}
const makeMix = (parts, settingsPatch, files, now) => { const [settings, vault] = mixOf(parts, settingsPatch, files); return makeStore(settings, vault, now); };

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
// The style fields a run with no choice of its own gets, built from runStyle the way the preview modal and the map view build them.
const fieldsFrom = (style) => ({ detailTemplate: style.template, ...(style.toneText ? { toneText: style.toneText } : {}), ...style.contextFields });
const fieldsNow = (store, language = 'en') => fieldsFrom(store.runStyle({ outputLanguage: language }));
const fieldsOf = async (store, language = 'en') => { await store.refresh(); return fieldsNow(store, language); };

// ---- counter 1 and D7: nothing new set, no block folder ----
test('counter 1 (was: workspace presets, style file, old template; grilling Q5/Q10): with no style folder every old workspace key is ignored and a run gets no fields and the default prompt, in all three languages', async () => {
  const cases = [...["standard", "textbook", "summary", "plain", "guide"].map(id => ({ defaultNoteStyleId: id })), { defaultNoteStyleId: 'style:Own' }, {}, { defaultDetailTemplateId: 'textbook' }, { noteToneBlock: 'builtin:guide', noteTemplateBlock: 'builtin:textbook' }];
  for (const patch of cases) for (const language of LANGUAGES) {
    const { store } = makeStore({ ...patch, language }, { [`${STYLES}/Own.md`]: OWN });
    await store.refresh();
    const got = fieldsNow(store, language);
    const resolved = store.runStyle({ outputLanguage: language });
    const label = JSON.stringify(patch) + language;
    assert.equal(got.toneText, undefined, label);
    assert.equal(resolved.template.id, 'standard', label);
    assert.equal(resolved.recipe.ref, 'builtin:general', label);
    assert.equal(got.styleSelection, undefined, label);
    assert.deepEqual(plain(resolved.issues.blockIssues), [], label);
    assert.deepEqual(plain(resolved.contextFields), {}, label);
    for (const step of M.PREVIEW_STEPS) assert.equal(M.previewPrompt(step.id, language, 'codex', got).text, M.previewPrompt(step.id, language, 'codex', {}).text, `${label} ${step.id}`);
  }
});

test('voice chain (was D7 chain with the workspace tone; grilling Q5/Q10): academic is no text; an unknown id is skipped; no workspace tone exists', async () => {
  const { store } = makeStore({ defaultNoteStyleId: 'summary', noteToneBlock: 'builtin:summary' });
  await store.refresh();
  const plainText = M.lookupBuiltinBlock('tone', 'plain', 'en');
  assert.equal(store.runStyle({ outputLanguage: 'en' }).toneText, undefined, 'the old workspace tone keys are not read');
  assert.equal(store.runStyle({ topic: { tone: 'plain' }, outputLanguage: 'en' }).toneText, plainText);
  // #18: the run's own tone is gone (replacement: the run-choice test in steps-run-style.cjs, slice 12); the topic's voice chain stays
  assert.equal(store.runStyle({ topic: { tone: 'academic' }, outputLanguage: 'en' }).toneText, undefined);
  assert.equal(store.runStyle({ topic: { tone: 'custom-tone-1' }, outputLanguage: 'en' }).toneText, 'Talk like a pirate.');
  assert.equal(store.runStyle({ topic: { tone: 'gone-tone' }, outputLanguage: 'en' }).toneText, undefined);
});

test('Later item: a built-in tone cannot be overridden through the promptPresets setting, so its effective text is the built-in text', () => {
  const sneaky = [{ id: 'plain', kind: 'tone', name: 'x', text: 'override' }];
  assert.equal(M.findPreset(sneaky, 'tone', 'plain', 'en').text, M.lookupBuiltinBlock('tone', 'plain', 'en'));
  assert.equal(M.listPresets(sneaky, 'tone', 'en').filter(item => item.id === 'plain')[0].text, M.lookupBuiltinBlock('tone', 'plain', 'en'));
});

// ---- counter 2: an unchanged override is not a change ----
test('counter 2 (was: an unchanged override is not a change; grilling Q5/decision #22): a built-in structure is always the built-in text, whatever a file of its name holds', async () => {
  for (const written of LANGUAGES) for (const run of LANGUAGES) {
    const changed = `${M.builtinTemplateText('standard', written)}\n\nFORMAT-LINE-OVERRIDE\n`.replace(/\n/g, ' \r\n');
    const { store } = makeStore({ language: run, noteStyleByKind: { topic: 'builtin:general' } }, { [`${TPL}/Standard six.md`]: changed, [`${TPL}/標準六段.md`]: changed });
    const fields = await fieldsOf(store, run);
    assert.equal(fields.styleSelection, undefined, `${written} ${run}`);
    for (const step of M.PREVIEW_STEPS)
      assert.equal(M.previewPrompt(step.id, run, 'codex', fields).text, M.previewPrompt(step.id, run, 'codex', {}).text, `${written} ${run} ${step.id}`);
  }
  // Textbook is the textbook template with no body
  const { store } = makeStore({ noteStyleByKind: { topic: 'builtin:textbook' } });
  const fields = await fieldsOf(store);
  assert.equal(fields.styleSelection, undefined);
  assert.equal(fields.detailTemplate.id, 'textbook');
});

// ---- counter 3: a changed block is sent ----
test('counter 3 (was: a changed override or a user block puts body and fileName in styleSelection; grilling Q5/decision #22): a structure file picked by a style puts body and fileName in styleSelection; the prompt holds the new line; the template is the parsed one', async () => {
  const item = { id: 'file:My tpl', fileName: 'My tpl.md', line: 'FORMAT-LINE-MINE', text: MINE };
  const { store } = makeMix({ structure: 'file:My tpl' }, {}, { [`${TPL}/My tpl.md`]: MINE });
  const fields = await fieldsOf(store);
  const resolved = store.runStyle({ outputLanguage: 'en' });
  assert.deepEqual(plain(fields.styleSelection.template), { id: item.id, body: item.text, fileName: item.fileName });
  assert.deepEqual(plain(fields.styleSelection.tone), { id: 'academic' });
  assert.deepEqual(plain(resolved.issues.blockIssues), []);
  const parsed = M.parseTemplateBlock(item.text, { id: item.id, name: 'My tpl' });
  assert.equal(parsed.ok, true);
  assert.deepEqual(plain(resolved.template.sections), plain(parsed.template.sections));
  assert.deepEqual(plain(fields.detailTemplate.sections), plain(parsed.template.sections));
  for (const step of M.PREVIEW_STEPS.filter(s => s.id !== 'decompose')) {
    const text = M.previewPrompt(step.id, 'en', 'codex', fields).text;
    if (step.id !== 'merge') assert.ok(text.includes(item.line), step.id);
  }
  assert.ok((await serviceText(fields)).includes(item.line));
});

test('counter 4 (store part) (was: the workspace block; grilling Q5/Q10): a structure file the sections parser rejects falls back to the built-in template, names file and line, and the service still produces the note', async () => {
  const { store } = makeMix({ structure: 'file:Bad' }, {}, { [`${TPL}/Bad.md`]: BROKEN });
  const fields = await fieldsOf(store);
  const resolved = store.runStyle({ outputLanguage: 'en' });
  assert.equal(resolved.issues.blockIssues.length, 1);
  assert.equal(resolved.issues.blockIssues[0].fileName, 'Bad.md');
  assert.equal(resolved.issues.blockIssues[0].line, 2);
  assert.equal(resolved.template.id, 'standard');
  assert.equal(fields.styleSelection.template.body, BROKEN);
  const preview = M.previewPrompt('research', 'en', 'codex', fields);
  assert.equal(preview.text, defaultText('research'));
  assert.equal(preview.issues[0].fileName, 'Bad.md');
  assert.equal(preview.issues[0].line, 2);
  assert.equal(await serviceText(fields), await serviceText({}));
  // a file of a built-in's name is never read: Textbook stays Textbook, with no issue
  const textbook = makeStore({ noteStyleByKind: { topic: 'builtin:textbook' } }, { [`${TPL}/Intro + six.md`]: BROKEN });
  await textbook.store.refresh();
  assert.equal(textbook.store.runStyle({ outputLanguage: 'en' }).template.id, 'textbook');
  assert.equal(textbook.store.runStyle({ outputLanguage: 'en' }).issues.blockIssues.length, 0);
});

// ---- counter 5 ----
test('counter 5 (was: a chosen workspace block that was deleted; grilling Q5/Q10): a style that cannot be read, or a style naming a structure that is gone, does not throw and falls back', async () => {
  for (const ref of ['file:Gone', 'builtin:nope', 'weird', 'builtin:aim']) {
    const { store } = makeStore({ noteStyleByKind: { topic: ref } });
    await store.refresh();
    let resolved;
    assert.doesNotThrow(() => { resolved = store.runStyle({ outputLanguage: 'en' }); });
    assert.equal(resolved.template.id, 'standard', ref);
    assert.equal(resolved.recipe.ref, 'builtin:general', ref);
    assert.equal(resolved.contextFields.styleSelection, undefined, ref);
    assert.ok(resolved.issues.missing.includes(ref), ref);
    const fields = fieldsNow(store, 'en');
    assert.equal(fields.styleSelection, undefined, ref);
    for (const step of M.PREVIEW_STEPS) assert.equal(M.previewPrompt(step.id, 'en', 'codex', fields).text, defaultText(step.id), `${ref} ${step.id}`);
  }
  // a style that names a structure file that is gone: Standard, with an issue naming the style file
  const { store } = makeMix({ structure: 'file:Gone' });
  await store.refresh();
  const got = store.runStyle({ outputLanguage: 'en' });
  assert.equal(got.template.id, 'standard');
  assert.equal(got.issues.blockIssues[0].fileName, 'Mix.md');
  assert.equal(got.issues.blockIssues[0].code, 'ui.note_style_issue_part_missing');
});

// ---- counter 6 ----
test('counter 6 (was: map/topic template over the workspace block, workspace tone fills the gap; grilling Q5/Q10/Q15): an old topic template is a style of its own; the kind style\'s voice does not fill its gap, the kind default part does', async () => {
  const { store } = makeMix({ structure: 'file:My tpl', voice: 'builtin:guide' }, {}, { [`${TPL}/My tpl.md`]: MINE });
  await store.refresh();
  const guide = M.lookupBuiltinBlock('tone', 'guide', 'en');
  const own = store.runStyle({ outputLanguage: 'en' });
  assert.equal(own.contextFields.styleSelection.template.id, 'file:My tpl');
  assert.equal(own.toneText, guide);
  assert.equal(own.recipe.source, 'kind');
  const topic = store.runStyle({ topic: { template: 'textbook' }, outputLanguage: 'en' });
  assert.equal(topic.template.id, 'textbook');
  assert.equal(topic.contextFields.styleSelection, undefined);
  assert.equal(topic.toneText, undefined, 'no tone key: academic, the kind default part (not the kind style\'s voice)');
  assert.equal(topic.recipe.source, 'topic');
  assert.equal(store.runStyle({ topic: { template: 'textbook', tone: 'plain' }, outputLanguage: 'en' }).toneText, M.lookupBuiltinBlock('tone', 'plain', 'en'));
  assert.equal(store.runStyle({ topic: { tone: 'academic' }, outputLanguage: 'en' }).toneText, undefined, 'academic named on the topic stays academic');
  // a voice file is a style's voice; a topic tone preset wins over the kind style in its whole
  const file = makeMix({ voice: 'file:Pirate' }, {}, { [`${TONE}/Pirate.md`]: 'Arr.\n' });
  await file.store.refresh();
  assert.equal(file.store.runStyle({ outputLanguage: 'en' }).toneText, 'Arr.');
  assert.equal(file.store.runStyle({ topic: { tone: 'academic' }, outputLanguage: 'en' }).toneText, undefined);
});

// ---- counter 7: change of tone ----
test('counter 7 (was: noteToneBlock; grilling Q5/Q10): changing the style\'s voice A to B puts only B in every preview step and in the service prompt (built-in to built-in, built-in to own file, own file to academic, empty file)', async () => {
  const pirate = 'Write like a pirate captain.';
  const files = { [`${TONE}/Pirate.md`]: `${pirate}\n`, [`${TONE}/Hollow.md`]: '' };
  const summary = M.lookupBuiltinBlock('tone', 'summary', 'en');
  const guide = M.lookupBuiltinBlock('tone', 'guide', 'en');
  const run = async (key, steps = M.PREVIEW_STEPS.map(s => s.id)) => {
    const { store } = makeMix({ voice: key }, {}, files);
    const fields = await fieldsOf(store);
    return { fields, previews: steps.map(step => M.previewPrompt(step, 'en', 'codex', fields).text), sent: await serviceText(fields) };
  };
  const a1 = await run('builtin:summary');
  for (const text of [...a1.previews, a1.sent]) assert.ok(text.includes(summary));
  const b1 = await run('builtin:guide');
  for (const text of [...b1.previews, b1.sent]) { assert.ok(text.includes(guide)); assert.equal(text.includes(summary), false); }
  const b2 = await run('file:Pirate');
  for (const text of [...b2.previews, b2.sent]) { assert.ok(text.includes(pirate)); assert.equal(text.includes(guide), false); assert.equal(text.includes(summary), false); }
  const b3 = await run('builtin:academic');
  M.PREVIEW_STEPS.forEach((step, index) => assert.equal(b3.previews[index], defaultText(step.id), step.id));
  assert.equal(b3.sent, await serviceText({}));
  const b4 = await run('file:Hollow');
  M.PREVIEW_STEPS.forEach((step, index) => assert.equal(b4.previews[index], defaultText(step.id), step.id));
  assert.equal(b4.sent, await serviceText({}));
  // decision #22: a file named like a built-in voice is never read; the built-in text is sent
  const edited = makeMix({ voice: 'builtin:plain' }, {}, { [`${TONE}/Plain explanation.md`]: 'My plain.\n' });
  const e = await fieldsOf(edited.store);
  assert.equal(e.toneText, M.lookupBuiltinBlock('tone', 'plain', 'en'));
  assert.equal(M.previewPrompt('research', 'en', 'codex', e).text.includes('My plain.'), false);
  // the styleSelection of a structure file carries the same tone choice the context holds
  const both = makeMix({ structure: 'file:My tpl', voice: 'file:Pirate' }, {}, { ...files, [`${TPL}/My tpl.md`]: MINE });
  const bf = await fieldsOf(both.store);
  assert.deepEqual(plain(bf.styleSelection.tone), { id: 'custom-legacy', body: pirate });
  assert.ok((await serviceText(bf)).includes(pirate));
});

// ---- counter 8 ----
test('counter 8 (was: a style file that decides the tone; grilling Q10/Q12): a style\'s voice is its own; an old run tone or structure does not replace it', async () => {
  const { store } = makeMix({ voice: 'builtin:summary' });
  await store.refresh();
  const summary = M.lookupBuiltinBlock('tone', 'summary', 'en');
  assert.equal(store.runStyle({ outputLanguage: 'en' }).toneText, summary);
  assert.equal(store.runStyle({ outputLanguage: 'en' }).label.fileName, 'Mix.md');
  // #18: an old run tone or structure id is ignored (replacement: steps-run-style.cjs slice 12)
  assert.equal(store.runStyle({ choice: { tone: 'plain' }, outputLanguage: 'en' }).toneText, summary);
  assert.equal(store.runStyle({ choice: { tone: 'plain' }, outputLanguage: 'en' }).recipe.source, 'kind');
  assert.equal(store.runStyle({ choice: { template: 'textbook' }, outputLanguage: 'en' }).toneText, summary);
});

// ---- counter 9: copy ----
test('counter 9 (was copyBlock; decisions #31): a part created from a built-in structure and edited reaches a run through a style that names it, in the preview and the service prompt', async () => {
  const edit = makeStore({});
  await edit.store.refresh();
  const editRef = await edit.store.createPart('structure', 'builtin:standard');
  const file = `${TPL}/${editRef.slice('file:'.length)}.md`;
  edit.v.files[file] = `${edit.v.files[file]}\nADDED-LINE-COPY\n`;
  edit.v.files[`${RECIPES}/Mix.md`] = `---\nstructure: ${editRef.slice('file:'.length)}\n---\n`;
  edit.settings.noteStyleByKind = { topic: 'file:Mix' };
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
test('counter 10 (menu): the list marks a changed built-in, shows own files, ignores the backup folder', async () => {
  const { store } = makeStore({}, {
    [`${TPL}/標準六段.md`]: `${M.builtinTemplateText('standard', 'zh-TW')}\nX\n`,
    [`${TPL}/Intro + six.md`]: M.builtinTemplateText('textbook', 'en'),
    [`${TPL}/Mine.md`]: MINE,
    [`${BAK}/Standard 2026-11-02 030405.md`]: 'old'
  });
  await store.refresh();
  const items = store.listBlocks('template');
  const standard = items.find(item => item.ref === 'builtin:standard');
  const textbook = items.find(item => item.ref === 'builtin:textbook');
  assert.equal(standard.modified, true);
  assert.equal(standard.fileName, '標準六段.md');
  assert.equal(textbook.modified, false);
  assert.equal(textbook.fileName, 'Intro + six.md');
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
// ---- opening a block: the file exists, in the first spelling that exists ----
test('ensureBlockFile writes a built-in block once in the UI language, reuses an existing folder spelling and an existing file, and never overwrites', async () => {
  const { store, v } = makeStore({ language: 'zh-TW' });
  await store.refresh();
  const first = await store.ensureBlockFile('template', 'builtin:standard');
  assert.equal(first.path, `${STYLES}/段落結構/標準六段.md`);
  assert.equal(v.files[first.path], M.builtinTemplateText('standard', 'zh-TW'));
  v.files[first.path] = 'EDITED';
  const again = await store.ensureBlockFile('template', 'builtin:standard');
  assert.equal(again.path, first.path);
  assert.equal(v.files[first.path], 'EDITED');
  // a vault that already has the English folder names keeps them, whatever the UI language
  const english = makeStore({ language: 'zh-TW' }, { [`${STYLES}/Voices/Mine.md`]: 'x' });
  await english.store.refresh();
  const tone = await english.store.ensureBlockFile('tone', 'builtin:plain');
  assert.equal(tone.path, `${STYLES}/Voices/白話說明.md`);
  assert.equal(english.v.files[tone.path], M.lookupBuiltinBlock('tone', 'plain', 'zh-TW'));
  await assert.rejects(() => english.store.ensureBlockFile('tone', 'file:Nope'));
  const own = await english.store.ensureBlockFile('tone', 'file:Mine');
  assert.equal(own.path, `${STYLES}/Voices/Mine.md`);
});

// ---- the pure helpers ----
test('block-files: folder names are found by any spelling (existing first), built-in names match any language exactly, unmodified means equal to a built-in text', () => {
  const b = B();
  const exists = set => name => set.includes(name);
  // design §2: the style folder is the root; the five roles sit directly in it, spelled per language (first existing spelling wins)
  const SPELLED = { recipe: ['風格', 'Styles', '风格'], template: ['段落結構', 'Structures', '段落结构'], tone: ['寫作口吻', 'Voices', '写作口吻'], format: ['格式規則', 'Formats', '格式规则'], backup: ['備份', 'Backups', '备份'] };
  for (const [role, [tw, en, cn]] of Object.entries(SPELLED)) {
    assert.equal(b.resolveBlockFolder('S', role, exists([]), 'zh-TW'), `S/${tw}`, role);
    assert.equal(b.resolveBlockFolder('S', role, exists([]), 'en'), `S/${en}`, role);
    assert.equal(b.resolveBlockFolder('S', role, exists([]), 'zh-CN'), `S/${cn}`, role);
    assert.equal(b.resolveBlockFolder('S', role, exists([`S/${cn}`, `S/${en}`]), 'en'), `S/${cn}`, `${role}: the first existing spelling in registered-language order`);
    assert.equal(b.resolveBlockFolder('S', role, exists([`S/${en}`]), 'zh-TW'), `S/${en}`, role);
  }
  assert.equal(b.builtinBlockIdOfName('template', 'Standard six'), 'standard');
  assert.equal(b.builtinBlockIdOfName('template', 'Standard'), undefined, 'the old short name is not a built-in name any more');
  assert.equal(b.builtinBlockIdOfName('template', '導讀加六段'), 'textbook');
  assert.equal(b.builtinBlockIdOfName('tone', 'Key-point summary'), 'summary');
  assert.equal(b.builtinBlockIdOfName('template', 'Standard (2)'), undefined);
  assert.equal(b.builtinBlockIdOfName('template', 'My Standard six'), undefined);
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

// ---- ticket 04 P2: the preview modal (counter 4 preview part, counter 14) ----
function openPreviewModal(store, language = 'en') {
  const S = require('./support.cjs');
  const dom = require('./support-dom.cjs');
  const { PromptPreviewModal } = S.load('ui/modals/prompt-preview-modal.ts', { obsidian: { ...S.obsidian, Modal: dom.makeModal() } });
  const modal = new PromptPreviewModal({}, store, language, 'codex');
  modal.open();
  const select = dom.find(modal.contentEl, item => item.tag === 'select');
  const region = () => dom.find(modal.contentEl, item => item.attrs['aria-live'] === 'polite');
  return { modal, select, region, dom };
}

test('counter 4 (preview part): the modal names the same file and line the run reports, in one polite region', async () => {
  const { store } = makeMix({ structure: 'file:Bad' }, {}, { [`${TPL}/Bad.md`]: BROKEN });
  await store.refresh();
  const { modal, region } = openPreviewModal(store);
  const shown = region().children.map(item => item.text);
  assert.equal(shown.length, 1);
  assert.match(shown[0], /Bad\.md/);
  assert.match(shown[0], /\b2\b/);
  const issue = store.runStyle({ outputLanguage: 'en' }).issues.blockIssues[0];
  assert.equal(issue.fileName, 'Bad.md');
  assert.equal(issue.line, 2);
  modal.close();
});

test('counter 14: changing the step does not touch the live region while the problem is the same; a changed problem updates it; headings never skip a level', async () => {
  const { store, v } = makeMix({ structure: 'file:Bad' }, {}, { [`${TPL}/Bad.md`]: BROKEN });
  await store.refresh();
  const { modal, select, region, dom } = openPreviewModal(store);
  const everything = () => dom.findAll(modal.contentEl, () => true);
  assert.equal(region().attrs['aria-live'], 'polite');
  assert.equal(everything().some(item => item.attrs.role === 'alert'), false, 'no role=alert anywhere');
  assert.equal(everything().filter(item => item.attrs['aria-live']).length, 1, 'one live region only');
  const first = region().children[0];
  const fields = fieldsNow(store, 'en');
  const withIssue = M.PREVIEW_STEPS.filter(step => M.previewPrompt(step.id, 'en', 'codex', fields).issues.length > 0);
  const without = M.PREVIEW_STEPS.filter(step => !withIssue.includes(step));
  assert.ok(withIssue.length >= 2, 'several steps show the same problem');
  for (const step of withIssue.slice(1)) {
    select.value = step.id;
    select.fire('change');
    assert.equal(region().children[0], first, `step ${step.id}: the same problem element stays, so nothing is announced again`);
    const levels = new Set(everything().filter(item => /^h\d$/.test(item.tag)).map(item => item.tag));
    assert.deepEqual([...levels], ['h2'], `step ${step.id}: headings start at h2 and do not jump`);
    assert.ok(dom.findAll(modal.contentEl, item => item.tag === 'h2').length > 0);
  }
  // a step the problem does not touch shows no problem, so the text did change
  for (const step of without) {
    select.value = step.id;
    select.fire('change');
    assert.equal(region().children.length, 0, `step ${step.id}: nothing to report`);
  }
  select.value = withIssue[0].id;
  select.fire('change');
  assert.equal(region().children.length, 1);
  // the problem is fixed: the region is updated (emptied) on the next render
  v.files[`${TPL}/Bad.md`] = MINE;
  await store.refresh();
  select.fire('change');
  assert.equal(region().children.length, 0);
  // and a new problem is written once
  v.files[`${TPL}/Bad.md`] = BROKEN;
  await store.refresh();
  select.fire('change');
  assert.equal(region().children.length, 1);
  assert.notEqual(region().children[0], first);
  modal.close();
});

test('FB1 B1: opening the preview reads the block files again, so a block edited after the settings page opened shows its new line', async () => {
  const { store, v } = makeMix({ structure: 'file:Mine' }, {}, { [`${TPL}/Mine.md`]: MINE });
  await store.refresh();
  v.files[`${TPL}/Mine.md`] = MINE.replace('FORMAT-LINE-MINE', 'FORMAT-LINE-EDITED-LATER');
  const { modal, dom } = openPreviewModal(store);
  const texts = () => dom.findAll(modal.contentEl, item => item.tag === 'pre').map(item => item.text).join('\n');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.match(texts(), /FORMAT-LINE-EDITED-LATER/);
  assert.doesNotMatch(texts(), /FORMAT-LINE-MINE\b/);
  modal.close();
});

// ---- note style flow redesign, P2: tone files are read without HTML comments; academic rigor "Edit" writes only a note ----
// The tone text a style gets when its voice is `ref` (#18: a run no longer names a tone, a style does).
const toneTextOf = async (files, ref) => {
  const { store } = makeMix({ voice: ref }, {}, files);
  await store.refresh();
  return store.runStyle({ outputLanguage: 'en' }).toneText;
};

test('P2 comments: a tone file with a comment and text sends only the text; a lone "<" or an unclosed "<!--" is kept as written (counter: not a comment)', async () => {
  assert.equal(M.stripToneComments('<!-- note -->\nSpeak calmly.'), 'Speak calmly.');
  assert.equal(M.stripToneComments('Before <!-- a\nb --> after'), 'Before  after');
  assert.equal(M.stripToneComments('<!-- one --><!-- two -->'), '');
  assert.equal(M.stripToneComments('Use a < b and <b>bold</b> words.'), 'Use a < b and <b>bold</b> words.');
  assert.equal(M.stripToneComments('Text <!-- never closed'), 'Text <!-- never closed');
  const files = {
    [`${TONE}/Calm.md`]: '<!-- my note -->\nSpeak calmly.\n',
    [`${TONE}/Plain text.md`]: 'Speak calmly.\n',
    [`${TONE}/Angle.md`]: 'Prefer a < b over <b>bold</b>.\n'
  };
  assert.equal(await toneTextOf(files, 'file:Calm'), 'Speak calmly.');
  assert.equal(await toneTextOf(files, 'file:Calm'), await toneTextOf(files, 'file:Plain text'));
  assert.equal((await toneTextOf(files, 'file:Angle')).trim(), 'Prefer a < b over <b>bold</b>.');
  const calm = M.previewPrompt('research', 'en', 'codex', { toneText: await toneTextOf(files, 'file:Calm') }).text;
  const plainText = M.previewPrompt('research', 'en', 'codex', { toneText: await toneTextOf(files, 'file:Plain text') }).text;
  assert.equal(calm, plainText, 'the prompt only loses the comment');
  assert.ok(!calm.includes('my note'));
});

test('P2 comments: a comment-only file is no change (academic: unmodified, prompt equal to the default; a built-in tone with its text plus a comment likewise)', async () => {
  const academicFile = M.academicToneNote('en');
  const plainWithNote = `<!-- hello -->\n${M.lookupBuiltinBlock('tone', 'plain', 'en')}\n`;
  const { store } = makeStore({}, { [`${TONE}/Academic rigor.md`]: academicFile, [`${TONE}/Plain explanation.md`]: plainWithNote });
  const fields = await fieldsOf(store);
  const academic = store.listBlocks('tone').find(item => item.ref === 'builtin:academic');
  assert.equal(academic.fileName, 'Academic rigor.md');
  assert.equal(academic.modified, false, 'not shown as modified');
  assert.equal(fields.toneText, undefined);
  assert.equal(fields.styleSelection, undefined);
  for (const step of M.PREVIEW_STEPS)
    assert.equal(M.previewPrompt(step.id, 'en', 'codex', fields).text, M.previewPrompt(step.id, 'en', 'codex', {}).text, step.id);
  const plainItem = store.listBlocks('tone').find(item => item.ref === 'builtin:plain');
  assert.equal(plainItem.modified, false);
  const plainRun = makeMix({ voice: 'builtin:plain' }, {}, { [`${TONE}/Plain explanation.md`]: plainWithNote });
  await plainRun.store.refresh();
  assert.equal(plainRun.store.runStyle({ outputLanguage: 'en' }).toneText, M.lookupBuiltinBlock('tone', 'plain', 'en'));
  // text under the note IS a change
  const edited = makeStore({}, { [`${TONE}/Academic rigor.md`]: `${academicFile}\nUse short sentences.\n` });
  await edited.store.refresh();
  assert.equal(edited.store.listBlocks('tone').find(item => item.ref === 'builtin:academic').modified, true);
  // decision #22: the menu still marks the edited file, but a run reads the built-in text (academic rigor: nothing)
  assert.equal(await toneTextOf({ [`${TONE}/Academic rigor.md`]: `${academicFile}\nUse short sentences.\n` }, 'builtin:academic'), undefined);
});

test('K2 counter: an override file named after a voice\'s old name (three languages) or new name is still found for that voice; both names are the built-in\'s names', async () => {
  for (const [id, names] of [['academic', ['學術嚴謹', '学术严谨', 'Academic rigor', '專業', '专业', 'Professional']], ['magazine', ['雜誌專欄', '杂志专栏', 'Magazine column', '敘事', '叙事', 'Narrative']]]) {
    for (const name of names) {
      assert.equal(B().builtinBlockIdOfName('tone', name), id, name);
      assert.ok(B().builtinBlockNames('tone', id).includes(name), name);
      const { store } = makeStore({}, { [`${TONE}/${name}.md`]: 'Edited.\n' });
      await store.refresh();
      assert.equal(store.listBlocks('tone').find(item => item.ref === `builtin:${id}`).fileName, `${name}.md`, name);
    }
  }
});

test('K2: the skim format is the lean text plus its skim rules (the lean safety rules stay), the guide structure and the skim format are built-in parts a style can name and a copy keeps', async () => {
  const M2 = loadSource(`export { lookupBuiltinFormat, BUILTIN_FORMATS } from "./core/blocks/builtin";\nexport { parseRecipeFile } from "./ai/note-style-recipe";`);
  for (const language of ['en', 'zh-TW', 'zh-CN']) {
    const lean = M2.lookupBuiltinFormat('lean', language), skim = M2.lookupBuiltinFormat('skim', language);
    assert.ok(skim.startsWith(lean), `${language}: skim starts with the whole lean text`);
    assert.ok(skim.length > lean.length + 100, language);
    for (const rule of language === 'en' ? ['never use callouts', 'never use <iframe>'] : ['不要使用 callout', '不要用 <iframe>']) assert.ok(skim.includes(rule), `${language} ${rule}`);
  }
  assert.equal(M2.parseRecipeFile('---\n格式規則: 條列速讀\n結構: x\n---\n').format, 'builtin:skim');
  assert.equal(M2.parseRecipeFile('---\nformat: Skim list\n---\n').format, 'builtin:skim');
  assert.equal(M2.parseRecipeFile('---\n段落結構: 操作指南\n---\n').structure, 'builtin:guide');
  const { store, v } = makeStore({});
  await store.refresh();
  for (const [category, id] of [['structure', 'guide'], ['format', 'skim']]) {
    const ref = await store.createPart(category, `builtin:${id}`);
    assert.match(ref, /^file:/, `${category} copy`);
    await store.refresh();
    assert.ok(store.listParts(category).some(item => item.ref === ref), `${category} copy is listed`);
  }
  assert.ok(Object.keys(v.files).length >= 2, 'both copies are files');
});

test('P2 academic Edit: ensureBlockFile writes only the design note (three languages), the file then reads as unmodified; other tones still get their own text', async () => {
  for (const language of LANGUAGES) {
    const { store, v } = makeStore({ language });
    await store.refresh();
    const made = await store.ensureBlockFile('tone', 'builtin:academic');
    const text = v.files[made.path];
    assert.equal(text, M.academicToneNote(language), language);
    assert.ok(text.startsWith('<!--') && text.trimEnd().endsWith('-->'), language);
    assert.equal(M.stripToneComments(text), '', language);
    assert.equal(store.listBlocks('tone').find(item => item.ref === 'builtin:academic').modified, false, language);
    const guide = await store.ensureBlockFile('tone', 'builtin:guide');
    assert.equal(v.files[guide.path], M.lookupBuiltinBlock('tone', 'guide', language), language);
  }
});

test('P2 preview: with the default voice the modal shows the voice heading and "(Default voice; no extra instruction)"; with a voice it shows the voice text instead', async () => {
  const none = makeStore({});
  await none.store.refresh();
  const { modal, dom } = openPreviewModal(none.store);
  const titles = () => dom.findAll(modal.contentEl, item => item.tag === 'h2').map(item => item.text);
  const empty = () => dom.findAll(modal.contentEl, item => (item.attrs.class ?? item.cls ?? '').toString().includes('vam-prompt-preview-empty'));
  assert.ok(titles().includes('Voice'), titles().join('|'));
  assert.equal(empty().length, 1);
  assert.equal(empty()[0].text, '(Default voice; no extra instruction)');
  assert.ok(titles().indexOf('Voice') > titles().indexOf('Structure'), 'after the structure part');
  modal.close();
  const guide = makeMix({ voice: 'builtin:guide' });
  await guide.store.refresh();
  const second = openPreviewModal(guide.store);
  assert.equal(second.dom.findAll(second.modal.contentEl, item => (item.attrs.class ?? item.cls ?? '').toString().includes('vam-prompt-preview-empty')).length, 0);
  assert.ok(second.dom.findAll(second.modal.contentEl, item => item.tag === 'h2').some(item => item.text === 'Voice'));
  second.modal.close();
});

test('ensureBlockFile reports created: true for a file it just wrote, false for an existing file or an override', async () => {
  const { store } = makeStore({}, { [`${TONE}/Mine.md`]: 'x' });
  await store.refresh();
  assert.equal((await store.ensureBlockFile('template', 'builtin:standard')).created, true);
  assert.equal((await store.ensureBlockFile('template', 'builtin:standard')).created, false);
  assert.equal((await store.ensureBlockFile('tone', 'file:Mine')).created, false);
});

test('S1b: the hypothesis Evidence table section gives a copyable Markdown header row, not a full-width bar list', () => {
  const header = { 'zh-TW': '| 證據 | 支持或反駁 | 強度 | 連到的議題 |', 'zh-CN': '| 證據 | 支持或反駁 | 強度 | 連到的議題 |', en: '| Evidence | Supports or refutes | Strength | Linked topic |' };
  for (const language of LANGUAGES) {
    const text = fs.readFileSync(path.join(__dirname, '..', 'core', 'blocks', 'template', `hypothesis.${language}.md`), 'utf8');
    assert.ok(text.includes(`\`${header[language]}\``), language);
    assert.ok(!text.includes('｜'), `${language}: no full-width bar column list`);
  }
});

// ---- AI suggested (P4): the preview shows the decide text, and only for that style ----
test('P4 preview: with AI suggested chosen the AI instructions show the decide text; other styles show what they showed (no aiSections leaks)', () => {
  const fs = require('node:fs'), path = require('node:path');
  const decide = fs.readFileSync(path.join(__dirname, '..', 'core/steps/task/ai-decided-sections.en.md'), 'utf8').split('\n')[0];
  const follow = fs.readFileSync(path.join(__dirname, '..', 'core/steps/task/ai-followed-sections.en.md'), 'utf8').split('\n')[0];
  const textOf = patch => {
    const { store } = makeStore({ noteStyleByKind: { topic: patch } });
    const { modal, dom } = openPreviewModal(store);
    const text = dom.texts(modal.contentEl).join('\n');
    modal.close();
    return text;
  };
  const suggested = textOf('builtin:ai-suggested');
  assert.ok(suggested.includes(decide), 'the decide fragment is shown');
  assert.ok(!suggested.includes(follow));
  for (const ref of ['builtin:general', 'builtin:textbook']) {
    const other = textOf(ref);
    assert.ok(!other.includes(decide) && !other.includes(follow), ref);
  }
  // Same fields as the store gives for any other style: no aiSections key at all.
  const { store } = makeStore({ noteStyleByKind: { topic: 'builtin:textbook' } });
  assert.equal('aiSections' in store.runStyle({ kind: 'topic', detail: '', outputLanguage: 'en' }).contextFields, false);
});
