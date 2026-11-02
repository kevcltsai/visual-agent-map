// note-style-recipe T3 P1: the conversion of the 0.28.0 custom detail templates and tone presets into structure files, voice files
// and style files (design §9, grilling Q1/Q10/Q12, decisions #2-#5, D3-D6). Unit and integration level over an in-memory vault;
// the plugin wiring (map scan, notice, failure message) is in steps-note-style-onload.cjs.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadSource } = require('./support-replay.cjs');

const M = loadSource(`
export * from "./ai/note-style-store";
export * from "./ai/note-style-file";
export { planRecipeMigration } from "./ai/note-style-migrate";
export { parseRecipeFile, validatePartName } from "./ai/note-style-recipe";
export { normalizeTemplates } from "./ai/detail-templates";
export { normalizePresets } from "./ai/prompt-presets";
export { previewPrompt, PREVIEW_STEPS } from "./core/blocks/prompt-preview";
export { parseTemplateBlock } from "./core/blocks/template-block";
export { translate } from "./i18n";
`);
const plain = value => JSON.parse(JSON.stringify(value));
const eq = (actual, expected, label) => assert.deepEqual(plain(actual), plain(expected), label);
const LANGUAGES = ['zh-TW', 'zh-CN', 'en'];
const FIXTURE = path.join(__dirname, 'fixtures', 'note-style-0.28.0');
const DATA = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'data.json'), 'utf8'));
const FOLDER = 'WS/S';
const [T_WEEKLY, T_FIELD, T_CONCLUSION, T_TEXTBOOK] = DATA.detailTemplates.map(template => template.id);

function vault(files = {}) {
  const state = { files: { ...files }, folders: new Set(), ops: [], creates: 0, failCreateAt: 0, failSave: false, gate: null };
  const under = folder => Object.keys(state.files).filter(file => file.startsWith(`${folder}/`) && !file.slice(folder.length + 1).includes('/'));
  state.port = {
    list: async folder => under(folder).map(file => file.slice(folder.length + 1)).filter(name => name.endsWith('.md')),
    read: async file => { if (!(file in state.files)) throw new Error(file); return state.files[file]; },
    folderExists: folder => state.folders.has(folder) || Object.keys(state.files).some(file => file.startsWith(`${folder}/`)),
    createFolder: async folder => { state.ops.push(['folder', folder]); state.folders.add(folder); },
    create: async (file, content) => {
      if (state.gate) await state.gate;
      state.creates++;
      if (state.failCreateAt && state.creates === state.failCreateAt) throw new Error('write failed');
      if (Object.keys(state.files).some(existing => existing.toLowerCase() === file.toLowerCase())) throw new Error(`exists: ${file}`);
      state.files[file] = content; state.ops.push(['create', file]);
    },
    trash: async file => { state.ops.push(['trash', file]); delete state.files[file]; }
  };
  return state;
}
/** A store over the 0.28.0 fixture settings (a patch replaces keys); `shared` reuses a vault and settings, as a new session does. */
function world(patch = {}, files = {}, shared = {}) {
  const v = shared.v ?? vault(files);
  const settings = shared.settings ?? { ...plain(DATA), workspaceFolder: 'WS', language: 'en', noteStylesFolder: FOLDER, ...patch };
  const saves = [];
  const store = new M.NoteStyleStore({
    settings: () => settings, port: v.port,
    save: async () => { if (v.failSave) throw new Error('save failed'); v.ops.push(['save']); saves.push(plain(settings)); }
  });
  return { store, v, settings, saves };
}
const dirsOf = language => { const at = role => `${FOLDER}/${M.translate(language, `ui.style_folder_${role}`)}`; return { template: at('template'), tone: at('tone'), recipe: at('recipe') }; };
const DIRS = dirsOf('en');
const inDir = (v, folder) => Object.fromEntries(Object.entries(v.files).filter(([file]) => file.startsWith(`${folder}/`) && !file.slice(folder.length + 1).includes('/')).map(([file, text]) => [file.slice(folder.length + 1), text]));
const names = (v, folder) => Object.keys(inDir(v, folder)).sort();
const count = (v, kind) => v.ops.filter(op => op[0] === kind).length;
const OLD_KEYS = settings => plain({ detailTemplates: settings.detailTemplates, promptPresets: settings.promptPresets, defaultDetailTemplateId: settings.defaultDetailTemplateId });

test('counter 1 (design §9): the 0.28.0 fixture becomes structure, voice and style files, the topic style and the table; the old keys stay as they were and the outline preset is not a voice', async () => {
  // The fixture has the shape of 0.28.0 data: today's normalizers give back what is saved.
  eq(M.normalizeTemplates(DATA.detailTemplates), DATA.detailTemplates, 'detailTemplates round-trip');
  eq(M.normalizePresets(DATA.promptPresets), DATA.promptPresets, 'promptPresets round-trip');
  const { store, v, settings, saves } = world();
  const oldKeys = OLD_KEYS(settings);
  const result = await store.migrateLegacy({ mapsWithStyle: [] });
  assert.equal(result.status, 'done');
  eq(names(v, DIRS.template), ['Conclusion.md', 'Field notes draft.md', 'My textbook.md', 'Weekly review.md']);
  eq(names(v, DIRS.tone), ['Academic rigor (2).md', 'Pirate.md']);
  eq(names(v, DIRS.recipe), ['Conclusion (2).md', 'Field notes draft.md', 'My textbook.md', 'Weekly review.md']);
  assert.equal(v.files[`${DIRS.template}/Conclusion.md`], '## Answer\nState the answer first.\n\n## Why\nThe reasons.\n');
  assert.equal(v.files[`${DIRS.template}/Field notes draft.md`], '## Findings\nCount: at least 3\nWhat we saw.\n\n## Refs\nWhere it came from.\n\n## Open items\nWhat is still unclear.\n\n## History\nOne dated line.\n');
  assert.equal(v.files[`${DIRS.tone}/Pirate.md`], 'Talk like a pirate.\nKeep the facts straight.');
  assert.equal(v.files[`${DIRS.recipe}/Weekly review.md`], '---\nstructure: Weekly review\nvoice: Academic rigor\nformat: Standard format\nupdate: merge\n---\n');
  for (const file of names(v, DIRS.recipe)) {
    const parsed = M.parseRecipeFile(v.files[`${DIRS.recipe}/${file}`]);
    eq([parsed.voice, parsed.format, parsed.update, parsed.issues], ['builtin:academic', 'builtin:standard', 'merge', []], file);
    assert.match(parsed.structure, /^file:/);
  }
  eq(M.parseRecipeFile(v.files[`${DIRS.recipe}/Conclusion (2).md`]).structure, 'file:Conclusion', 'the style named like a built-in style points at the structure of the template');
  assert.equal(Object.keys(v.files).some(file => /Two levels/.test(file)), false, 'the outline preset is not converted');
  const marker = settings.noteStyleRecipe;
  assert.equal(marker.migrated, 1);
  eq(marker.legacy, { templates: { [T_WEEKLY]: 'file:Weekly review', [T_FIELD]: 'file:Field notes draft', [T_CONCLUSION]: 'file:Conclusion', [T_TEXTBOOK]: 'file:My textbook' }, tones: { 'custom-tone-1': 'file:Academic rigor (2)', 'custom-tone-2': 'file:Pirate' } });
  assert.equal(settings.noteStyleByKind.topic, 'file:Weekly review');
  eq(OLD_KEYS(settings), oldKeys, 'the 0.28.0 keys are not changed');
  assert.equal(saves.length, 1);
  assert.equal(result.notify, undefined, 'no map carries a style: nothing to tell');
  assert.ok(v.ops.every(op => ['folder', 'create', 'save'].includes(op[0])), 'only folders and new files are written');
});

test('counter 2 (duplicate write): a second run on the same store, and a new store over the saved state, create nothing, save nothing and answer "already"', async () => {
  const first = world();
  await first.store.migrateLegacy({ mapsWithStyle: [] });
  const written = { ...first.v.files };
  const before = first.v.ops.length;
  const again = await first.store.migrateLegacy({ mapsWithStyle: [] });
  assert.equal(again.status, 'already');
  assert.equal(first.v.ops.length, before, 'no create, createFolder or save');
  const fresh = world({}, {}, { v: first.v, settings: first.settings });
  assert.equal((await fresh.store.migrateLegacy({ mapsWithStyle: [] })).status, 'already');
  assert.equal(first.v.ops.length, before);
  eq(first.v.files, written);
});

test('counter 3a: a structure, voice or style file that already holds the same text is reused (not created again) and the table points at it; other text gets " (2)" and the old file is untouched', async () => {
  const same = '## Answer\nState the answer first.\n\n## Why\nThe reasons.\n'.replace(/\n/g, '\r\n');
  const other = '## Something else\nNot the same.\n';
  const pirate = 'Talk like a pirate.\nKeep the facts straight.\n';
  const files = {
    [`${DIRS.template}/Conclusion.md`]: same, [`${DIRS.template}/My textbook.md`]: other, [`${DIRS.tone}/Pirate.md`]: pirate, [`${DIRS.tone}/pirate (2).md`]: 'other pirate'
  };
  const { store, v, settings } = world({}, files);
  assert.equal((await store.migrateLegacy({ mapsWithStyle: [] })).status, 'done');
  assert.equal(v.files[`${DIRS.template}/Conclusion.md`], same, 'the reused file is byte-identical');
  assert.equal(v.files[`${DIRS.template}/My textbook.md`], other, 'a file with other text is never changed');
  assert.ok(`${DIRS.template}/My textbook (2).md` in v.files);
  assert.equal(settings.noteStyleRecipe.legacy.templates['custom-textbook'], 'file:My textbook (2)');
  assert.equal(settings.noteStyleRecipe.legacy.templates[T_CONCLUSION], 'file:Conclusion');
  assert.equal(count(v, 'create'), 8, 'ten files are planned; the structure and the voice that exist with the same text are not created again');
  assert.equal(v.files[`${DIRS.tone}/Pirate.md`], pirate);
  assert.equal(settings.noteStyleRecipe.legacy.tones['custom-tone-2'], 'file:Pirate', 'a voice file with the same text (newline aside) is reused');
});

test('counter 3b (grilling Q12): a template named like a built-in style ("Conclusion"): the structure "Conclusion" is free, the style must be "Conclusion (2)"; a voice named like a built-in voice gets " (2)"', async () => {
  const { store, v } = world();
  await store.migrateLegacy({ mapsWithStyle: [] });
  assert.ok(`${DIRS.template}/Conclusion.md` in v.files);
  assert.ok(`${DIRS.recipe}/Conclusion (2).md` in v.files);
  assert.equal(`${DIRS.recipe}/Conclusion.md` in v.files, false);
  assert.ok(`${DIRS.tone}/Academic rigor (2).md` in v.files);
  assert.equal(`${DIRS.tone}/Academic rigor.md` in v.files, false);
});

test('counter 3c: the built-in names of every language count as taken (structure, voice and style names)', async () => {
  const section = [{ id: 's', name: 'S', description: 'd', role: 'none', aliases: [] }];
  const templates = [
    { id: 'x1', name: M.translate('zh-TW', 'ui.structure_name_standard'), sections: section },
    { id: 'x2', name: M.translate('zh-CN', 'ui.structure_name_textbook').toUpperCase(), sections: section },
    { id: 'x3', name: M.translate('zh-TW', 'ui.recipe_name_textbook'), sections: section },
    { id: 'x4', name: M.translate('en', 'ui.recipe_name_aim').toLowerCase(), sections: section }
  ];
  const presets = LANGUAGES.map((language, index) => ({ id: `custom-tone-${index + 1}`, kind: 'tone', name: M.translate(language, 'ui.preset_name_academic'), text: `Voice ${index + 1}.` }));
  const { store, v, settings } = world({ detailTemplates: templates, promptPresets: presets, defaultDetailTemplateId: undefined });
  await store.migrateLegacy({ mapsWithStyle: [] });
  for (const file of [...names(v, DIRS.template), ...names(v, DIRS.tone), ...names(v, DIRS.recipe)]) assert.match(file, / \(\d+\)\.md$|^[^()]+\.md$/);
  for (const [folder, category] of [[DIRS.template, 'structure'], [DIRS.tone, 'voice'], [DIRS.recipe, 'recipe']])
    for (const file of names(v, folder)) assert.equal(M.validatePartName(file.replace(/\.md$/, ''), category).ok, true, `${folder}/${file} is not a built-in's name`);
  assert.equal(settings.noteStyleRecipe.legacy.templates.x1, `file:${M.translate('zh-TW', 'ui.structure_name_standard')} (2)`);
  eq(Object.values(settings.noteStyleRecipe.legacy.tones).sort(), ['file:' + M.translate('en', 'ui.preset_name_academic') + ' (2)', 'file:' + M.translate('zh-CN', 'ui.preset_name_academic') + ' (2)', 'file:' + M.translate('zh-TW', 'ui.preset_name_academic') + ' (2)'].sort());
  assert.ok(names(v, DIRS.recipe).some(name => name.startsWith(M.translate('zh-TW', 'ui.recipe_name_textbook')) && name.includes('(2)')));
});

test('counter 4a: a write that fails at the first create sets no marker, changes no key and no setting object, saves nothing and says "failed"; the next load finishes with no duplicate files', async () => {
  const w = world();
  const before = plain(w.settings);
  w.v.failCreateAt = 1;
  const result = await w.store.migrateLegacy({ mapsWithStyle: ['Taiwan trip'] });
  assert.equal(result.status, 'failed');
  assert.match(result.error, /write failed/);
  assert.equal(result.notify, undefined);
  eq(w.settings, before);
  assert.equal(w.saves.length, 0);
  assert.equal(Object.keys(w.v.files).length, 0);
  w.v.failCreateAt = 0;
  assert.equal((await w.store.migrateLegacy({ mapsWithStyle: ['Taiwan trip'] })).status, 'done');
  assert.equal(Object.keys(w.v.files).length, 10);
});

test('counter 4b: a failure at the last create leaves the files already written in place; the retry reuses them: no " (2)" copies, same ten files', async () => {
  const w = world();
  const before = plain(w.settings);
  w.v.failCreateAt = 10;
  assert.equal((await w.store.migrateLegacy({ mapsWithStyle: [] })).status, 'failed');
  eq(w.settings, before);
  assert.equal(Object.keys(w.v.files).length, 9, 'the nine files written before the failure stay');
  assert.equal(w.settings.noteStyleRecipe, undefined);
  assert.equal(w.settings.noteStyleByKind, undefined);
  // a new session: new store, same vault and settings
  w.v.failCreateAt = 0;
  const next = world({}, {}, { v: w.v, settings: w.settings });
  assert.equal((await next.store.migrateLegacy({ mapsWithStyle: [] })).status, 'done');
  eq(names(w.v, DIRS.template), ['Conclusion.md', 'Field notes draft.md', 'My textbook.md', 'Weekly review.md']);
  eq(names(w.v, DIRS.recipe), ['Conclusion (2).md', 'Field notes draft.md', 'My textbook.md', 'Weekly review.md']);
  assert.equal(Object.keys(w.v.files).length, 10);
  assert.equal(Object.keys(w.v.files).filter(file => /\(\d+\)\.md$/.test(file)).length, 2, 'only the two names that are built-ins\' carry a number');
});

test('counter 4c: a save that fails undoes the keys it had set (folder, topic style, marker), says "failed", and the retry finishes', async () => {
  const w = world({ noteStylesFolder: undefined });
  const before = plain(w.settings);
  w.v.failSave = true;
  assert.equal((await w.store.migrateLegacy({ mapsWithStyle: [] })).status, 'failed');
  eq(w.settings, before);
  assert.equal('noteStylesFolder' in w.settings, false);
  w.v.failSave = false;
  assert.equal((await w.store.migrateLegacy({ mapsWithStyle: [] })).status, 'done');
  assert.equal(w.settings.noteStyleRecipe.migrated, 1);
  assert.equal(Object.keys(w.v.files).length, 10, 'the files written before the failed save were reused');
});

test('counter 5: success is one save that holds the marker, the table, the topic style and (when it had none) the style folder', async () => {
  const w = world({ noteStylesFolder: undefined });
  const result = await w.store.migrateLegacy({ mapsWithStyle: [] });
  assert.equal(result.status, 'done');
  assert.equal(w.saves.length, 1);
  const saved = w.saves[0];
  assert.equal(saved.noteStyleRecipe.migrated, 1);
  assert.ok(saved.noteStyleRecipe.legacy.templates[T_WEEKLY]);
  assert.equal(saved.noteStyleByKind.topic, 'file:Weekly review');
  assert.equal(saved.noteStylesFolder, 'WS/' + M.translate('en', 'ui.note_styles_folder_name'));
  assert.ok(Object.keys(w.v.files).every(file => file.startsWith(saved.noteStylesFolder + '/')), 'the files are in the folder that was kept');
  // the save comes after every file
  const ops = w.v.ops.map(op => op[0]);
  assert.equal(ops.lastIndexOf('create') < ops.indexOf('save'), true);
  // a saved folder is never replaced
  const kept = world({ noteStylesFolder: 'Elsewhere' });
  await kept.store.migrateLegacy({ mapsWithStyle: [] });
  assert.equal(kept.saves[0].noteStylesFolder, 'Elsewhere');
});

test('counter 6a: a topic style the user already chose is not replaced, and no other kind is written', async () => {
  const w = world({ noteStyleByKind: { topic: 'builtin:textbook', hypothesis: 'file:Mine' } });
  await w.store.migrateLegacy({ mapsWithStyle: [] });
  eq(w.settings.noteStyleByKind, { topic: 'builtin:textbook', hypothesis: 'file:Mine' });
});

test('counter 6b (decisions #3): the old default becomes the topic style only when it was Textbook (built-in) or a custom template that was converted; Standard, nothing, a deleted id and a template that failed its check write no topic style', async () => {
  const run = async (patch) => { const w = world(patch); await w.store.migrateLegacy({ mapsWithStyle: [] }); return w.settings.noteStyleByKind?.topic; };
  assert.equal(await run({ defaultDetailTemplateId: 'textbook' }), 'builtin:textbook');
  assert.equal(await run({ defaultDetailTemplateId: T_FIELD }), 'file:Field notes draft');
  assert.equal(await run({ defaultDetailTemplateId: T_CONCLUSION }), 'file:Conclusion (2)');
  assert.equal(await run({ defaultDetailTemplateId: 'standard' }), undefined);
  assert.equal(await run({ defaultDetailTemplateId: undefined }), undefined);
  assert.equal(await run({ defaultDetailTemplateId: '' }), undefined);
  assert.equal(await run({ defaultDetailTemplateId: 'deleted-uuid' }), undefined);
  const broken = [{ id: 'bad', name: 'Broken', sections: [{ id: 's', name: 'S', description: 'text\n## not a section', role: 'none', aliases: [] }] }];
  assert.equal(await run({ detailTemplates: broken, defaultDetailTemplateId: 'bad' }), undefined);
});

test('counter 7 (AI semantics): for every custom template and tone of the fixture, a topic that names it gets the same prompt in all five steps and three output languages before the conversion (read-only fallback) and after it (the converted files)', async () => {
  const fieldsFrom = style => ({ detailTemplate: style.template, ...(style.toneText ? { toneText: style.toneText } : {}), ...style.contextFields });
  const promptsOf = async (migrate, language, topic) => {
    const w = world({ language });
    if (migrate) assert.equal((await w.store.migrateLegacy({ mapsWithStyle: [] })).status, 'done');
    await w.store.refresh();
    const style = w.store.runStyle({ topic, kind: 'topic', outputLanguage: language });
    assert.equal(style.issues.invalid, undefined);
    eq(style.issues.missing, [], 'nothing missing');
    return { texts: M.PREVIEW_STEPS.map(step => M.previewPrompt(step.id, language, 'codex', fieldsFrom(style)).text), style };
  };
  // The one difference the old upgrade tests locked: the log-role rule line that only a custom section name ("History") carried;
  // a converted file has no roles. Allowed only as exactly that one line missing, nothing added.
  const compared = [], differences = [];
  const topics = [
    ...DATA.detailTemplates.map(template => ({ template: template.id })),
    ...DATA.promptPresets.filter(preset => preset.kind === 'tone').map(preset => ({ tone: preset.id })),
    { template: T_WEEKLY, tone: 'custom-tone-2' }, { template: T_FIELD, tone: 'custom-tone-1' }
  ];
  for (const language of LANGUAGES) for (const topic of topics) {
    const before = await promptsOf(false, language, topic), after = await promptsOf(true, language, topic);
    // the two sides really read different sources: the saved template / preset, then the converted file
    assert.equal(before.style.label.fileName, undefined);
    if (topic.template) assert.ok(after.style.label.fileName, `${language} ${JSON.stringify(topic)}: the converted structure file is read`);
    before.texts.forEach((text, index) => {
      compared.push(1);
      if (text === after.texts[index]) return;
      differences.push(`${language} ${JSON.stringify(topic)} step ${index}`);
      assert.equal(topic.template, T_FIELD, `${language} ${JSON.stringify(topic)} step ${index}: only the template with a custom log section may differ`);
      const kept = new Set(after.texts[index].split('\n'));
      const lost = text.split('\n').filter(line => !kept.has(line));
      const gained = after.texts[index].split('\n').filter(line => !new Set(text.split('\n')).has(line));
      assert.equal(lost.length, 1, `${language} step ${index}: one line is lost`);
      assert.match(lost[0], /History/);
      assert.deepEqual(gained, []);
    });
    assert.equal(after.style.recipe.implicit, true);
  }
  assert.equal(compared.length, 3 * topics.length * M.PREVIEW_STEPS.length);
  assert.equal(differences.length, 3 * 2 * 4, 'the template with the custom log section differs in four of the five steps, with and without a tone, in three languages');
});

test('counter 7b (AI semantics): the default template of the fixture, before the conversion as {template: id} and after it as a topic with no setting (the converted style file of the general topic), gives the same prompt in all five steps and three languages', async () => {
  const fieldsFrom = style => ({ detailTemplate: style.template, ...(style.toneText ? { toneText: style.toneText } : {}), ...style.contextFields });
  const defaults = [T_WEEKLY, T_FIELD, T_CONCLUSION, T_TEXTBOOK, 'textbook'];
  let compared = 0, differences = 0;
  for (const language of LANGUAGES) for (const id of defaults) {
    const old = world({ language, defaultDetailTemplateId: id });
    await old.store.refresh();
    const before = old.store.runStyle({ topic: { template: id }, kind: 'topic', outputLanguage: language });
    const next = world({ language, defaultDetailTemplateId: id });
    assert.equal((await next.store.migrateLegacy({ mapsWithStyle: [] })).status, 'done');
    assert.ok(next.settings.noteStyleByKind?.topic, `${language} ${id}: the converted topic style is set`);
    await next.store.refresh();
    const after = next.store.runStyle({ topic: {}, kind: 'topic', outputLanguage: language });
    assert.equal(after.issues.invalid, undefined);
    eq(after.issues.missing, [], 'nothing missing');
    M.PREVIEW_STEPS.forEach(step => {
      compared++;
      const a = M.previewPrompt(step.id, language, 'codex', fieldsFrom(before)).text, b = M.previewPrompt(step.id, language, 'codex', fieldsFrom(after)).text;
      if (a === b) return;
      differences++;
      assert.equal(id, T_FIELD, `${language} ${id} ${step.id}: only the template with a custom log section may differ`);
      const kept = new Set(b.split('\n')), had = new Set(a.split('\n'));
      const lost = a.split('\n').filter(line => !kept.has(line)), gained = b.split('\n').filter(line => !had.has(line));
      assert.equal(lost.length, 1, `${language} ${step.id}: one line is lost`);
      assert.match(lost[0], /History/);
      assert.deepEqual(gained, []);
    });
  }
  assert.equal(compared, 3 * defaults.length * M.PREVIEW_STEPS.length);
  assert.equal(differences, 3 * 4, 'only the custom-log-section template differs, in four of five steps, per language');
});

test('counter 8: a template whose converted text does not read back the same (a description line that starts with "## ") is skipped: no file, no table entry, still read from detailTemplates; the other templates convert and the marker is set', async () => {
  const broken = { id: 'bad', name: 'Broken', sections: [{ id: 's', name: 'S', description: 'text\n## not a section', role: 'none', aliases: [] }] };
  const { store, v, settings } = world({ detailTemplates: [broken, ...plain(DATA.detailTemplates)], defaultDetailTemplateId: undefined });
  assert.equal((await store.migrateLegacy({ mapsWithStyle: [] })).status, 'done');
  assert.equal(Object.keys(v.files).some(file => file.includes('Broken')), false);
  assert.equal('bad' in settings.noteStyleRecipe.legacy.templates, false);
  assert.equal(Object.keys(settings.noteStyleRecipe.legacy.templates).length, 4);
  assert.equal(settings.noteStyleRecipe.migrated, 1);
  await store.refresh();
  const style = store.runStyle({ topic: { template: 'bad' }, kind: 'topic', outputLanguage: 'en' });
  assert.equal(style.template.id, 'bad', 'the read-only fallback still serves the template');
  assert.equal(settings.detailTemplates[0].id, 'bad', 'the old key is kept');
});

test('counter 9 (D6): nothing to convert (no custom template, no custom tone, only an outline preset) writes no file and no folder, only the marker; a later run does nothing', async () => {
  const w = world({ detailTemplates: [], promptPresets: [DATA.promptPresets[2]], defaultDetailTemplateId: 'textbook' });
  w.settings.defaultDetailTemplateId = undefined;
  const result = await w.store.migrateLegacy({ mapsWithStyle: [] });
  assert.equal(result.status, 'done');
  assert.equal(count(w.v, 'create') + count(w.v, 'folder'), 0);
  eq(w.settings.noteStyleRecipe, { migrated: 1, mapsNotified: true });
  assert.equal(w.saves.length, 1);
  assert.equal('noteStyleByKind' in w.settings, false);
  assert.equal((await w.store.migrateLegacy({ mapsWithStyle: [] })).status, 'already');
  assert.equal(w.saves.length, 1);
});

test('counter 10 (D5): maps with a style of their own are handed back once, with the converted default (Textbook counts) in the same answer; later runs and runs without maps say nothing', async () => {
  const w = world();
  const done = await w.store.migrateLegacy({ mapsWithStyle: ['Taiwan trip'] });
  eq(done.notify, { maps: ['Taiwan trip'], defaultName: 'Weekly review' });
  assert.equal(w.settings.noteStyleRecipe.mapsNotified, true, 'recorded in the same save');
  assert.equal(w.saves.length, 1);
  const again = await w.store.migrateLegacy({ mapsWithStyle: ['Taiwan trip'] });
  eq([again.status, again.notify], ['already', undefined]);
  const textbook = world({ defaultDetailTemplateId: 'textbook' });
  eq((await textbook.store.migrateLegacy({ mapsWithStyle: ['A', 'B'] })).notify, { maps: ['A', 'B'], defaultName: M.translate('en', 'ui.recipe_name_textbook') });
  const standard = world({ defaultDetailTemplateId: 'standard' });
  eq((await standard.store.migrateLegacy({ mapsWithStyle: ['A'] })).notify, { maps: ['A'] }, 'no default converted: no sentence about it');
  const none = world();
  assert.equal((await none.store.migrateLegacy({ mapsWithStyle: [] })).notify, undefined);
  // a marker saved without the maps record (an earlier build): the maps are looked at once, in one save
  const early = world({ noteStyleRecipe: { migrated: 1 } });
  eq((await early.store.migrateLegacy({ mapsWithStyle: ['M'] })).notify, { maps: ['M'] });
  assert.equal(early.saves.length, 1);
  eq(early.settings.noteStyleRecipe, { migrated: 1, mapsNotified: true });
  assert.equal((await early.store.migrateLegacy({ mapsWithStyle: ['M'] })).notify, undefined);
  assert.equal(early.v.ops.filter(op => op[0] !== 'save').length, 0, 'no file is written');
});

test('counter 10b: a save that fails while only recording the maps (the marker exists) is not "failed": no maps are told, the marker stays as it was, and the next try records them', async () => {
  const w = world({ noteStyleRecipe: { migrated: 1 } });
  w.v.failSave = true;
  const result = await w.store.migrateLegacy({ mapsWithStyle: ['M'] });
  eq([result.status, result.notify], ['already', undefined]);
  assert.match(result.error, /save failed/);
  eq(w.settings.noteStyleRecipe, { migrated: 1 });
  w.v.failSave = false;
  eq((await w.store.migrateLegacy({ mapsWithStyle: ['M'] })).notify, { maps: ['M'] });
});

test('counter 10c (R1-L1): once the conversion has finished (done, failed or already) the refresh fence is cleared, so refresh() no longer waits on it', async () => {
  for (const patch of [{}, { noteStyleRecipe: { migrated: 1, mapsNotified: true } }]) {
    const w = world(patch);
    await w.store.migrateLegacy({ mapsWithStyle: [] });
    assert.equal(w.store.migration, undefined);
  }
  const failing = world();
  failing.v.failSave = true;
  assert.equal((await failing.store.migrateLegacy({ mapsWithStyle: [] })).status, 'failed');
  assert.equal(failing.store.migration, undefined);
  const w = world();
  let open;
  w.v.gate = new Promise(resolve => { open = resolve; });
  const running = w.store.migrateLegacy({ mapsWithStyle: [] });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(w.store.migration, 'the fence is held while writing');
  w.v.gate = null; open();
  await running;
  assert.equal(w.store.migration, undefined);
});

test('counter 11 (async lifecycle): refresh() started while the conversion is writing waits for it and then reads the new files; a failed conversion does not make refresh() reject', async () => {
  const w = world();
  let open;
  w.v.gate = new Promise(resolve => { open = resolve; });
  const migrating = w.store.migrateLegacy({ mapsWithStyle: [] });
  await new Promise(resolve => setImmediate(resolve));
  let refreshed = false;
  const refreshing = w.store.refresh().then(() => { refreshed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(refreshed, false, 'refresh waits while a file is being written');
  w.v.gate = null; open();
  await migrating; await refreshing;
  const style = w.store.runStyle({ topic: { template: T_FIELD }, kind: 'topic', outputLanguage: 'en' });
  assert.equal(style.template.sections[0].name, 'Findings');
  assert.equal(style.label.fileName, 'Field notes draft.md', 'the converted file is the one read');
  assert.ok(style.recipe.implicit);
  // failure: refresh() is released and does not reject
  const bad = world();
  bad.v.failCreateAt = 2;
  let release;
  bad.v.gate = new Promise(resolve => { release = resolve; });
  const failing = bad.store.migrateLegacy({ mapsWithStyle: [] });
  await new Promise(resolve => setImmediate(resolve));
  const refreshAgain = bad.store.refresh();
  bad.v.gate = null; release();
  assert.equal((await failing).status, 'failed');
  await assert.doesNotReject(refreshAgain);
});

test('counter 12: a user write (copyBlock, ensureBlockFile) that starts while the conversion runs is queued behind it, and the two never take the same file name', async () => {
  const w = world();
  let open;
  w.v.gate = new Promise(resolve => { open = resolve; });
  const migrating = w.store.migrateLegacy({ mapsWithStyle: [] });
  await new Promise(resolve => setImmediate(resolve));
  const copying = w.store.copyBlock('template', 'file:Conclusion', 'Conclusion copy');
  const ensuring = w.store.ensureBlockFile('tone', 'builtin:plain');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(w.v.creates, 0, 'nothing has been written past the gate');
  w.v.gate = null; open();
  await migrating;
  assert.equal(await copying, 'file:Conclusion copy');
  await ensuring;
  const created = w.v.ops.filter(op => op[0] === 'create').map(op => op[1].toLowerCase());
  assert.equal(new Set(created).size, created.length, 'no file was written twice');
  assert.ok(`${DIRS.template}/Conclusion copy.md` in w.v.files);
  assert.equal(w.v.files[`${DIRS.template}/Conclusion copy.md`], w.v.files[`${DIRS.template}/Conclusion.md`], 'the copy was made from the converted file');
  const ops = w.v.ops.map(op => op[0]);
  assert.equal(ops.indexOf('save') < ops.lastIndexOf('create'), true, 'the user\'s writes come after the conversion\'s save');
});

test('counter 13 (security): names with "../", "\\", "/" or spaces at the ends give files inside their own folder, with names a part name can have', async () => {
  const odd = ['../x', 'a\\b', '  padded  ', '..', 'a/b/../c', '...', 'C:\\x'];
  const templates = odd.map((name, index) => ({ id: `t${index}`, name, sections: [{ id: 's', name: 'S', description: `d${index}`, role: 'none', aliases: [] }] }));
  const presets = odd.map((name, index) => ({ id: `custom-tone-${index + 1}`, kind: 'tone', name, text: `Voice ${index}.` }));
  const { store, v, settings } = world({ detailTemplates: templates, promptPresets: presets, defaultDetailTemplateId: undefined });
  assert.equal((await store.migrateLegacy({ mapsWithStyle: [] })).status, 'done');
  const created = v.ops.filter(op => op[0] === 'create').map(op => op[1]);
  assert.ok(created.length >= odd.length * 3);
  for (const file of created) {
    const folder = [DIRS.template, DIRS.tone, DIRS.recipe].find(dir => file.startsWith(`${dir}/`));
    assert.ok(folder, file);
    const base = file.slice(folder.length + 1);
    assert.equal(base.includes('/'), false, file);
    assert.equal(file.includes('..'), false, file);
    assert.equal(file.includes('\\'), false, file);
    const name = base.replace(/\.md$/, '');
    assert.equal(M.validatePartName(name, folder === DIRS.template ? 'structure' : folder === DIRS.tone ? 'voice' : 'recipe').ok, true, name);
  }
  for (const ref of [...Object.values(settings.noteStyleRecipe.legacy.templates), ...Object.values(settings.noteStyleRecipe.legacy.tones)]) assert.equal(ref.includes('..'), false, ref);
});

test('counter 14 (was upgrade "export conflicts" and "unreadable file", decisions #32): a user file whose name differs only by case keeps its bytes and the new file takes " (2)"; files at the style folder root and in the old block folder are not touched, nothing is trashed', async () => {
  const mine = "the user's own file\n";
  const files = {
    [`${DIRS.template}/weekly REVIEW.md`]: mine,
    [`${FOLDER}/Old style.md`]: '---\n語氣: x\n---\n## A\nold style file\n', [`${FOLDER}/Broken.md`]: '---\nnot closed\n## A\n',
    [`${FOLDER}/積木/Keep.md`]: 'a file of the unpublished block folder\n'
  };
  const { store, v, settings } = world({}, files);
  const before = { ...files };
  assert.equal((await store.migrateLegacy({ mapsWithStyle: [] })).status, 'done');
  assert.equal(v.files[`${DIRS.template}/weekly REVIEW.md`], mine, 'the user file keeps its bytes');
  assert.ok(`${DIRS.template}/Weekly review (2).md` in v.files, 'the case-insensitive name is taken');
  assert.ok(!(`${DIRS.template}/Weekly review.md` in v.files));
  assert.equal(settings.noteStyleRecipe.legacy.templates[T_WEEKLY], 'file:Weekly review (2)');
  for (const [file, text] of Object.entries(before)) assert.equal(v.files[file], text, `${file} is untouched`);
  assert.equal(count(v, 'trash'), 0, 'nothing is moved to the trash');
  assert.equal(settings.noteStyleAliases, undefined);
  assert.equal(settings.noteStyleUpgrade, undefined);
});

test('counter 15 (was upgrade "T1 remembers the folder", decisions #32): the conversion pins the default folder it wrote to, so a later change of interface language still finds the files; nothing to convert pins nothing; a failed save leaves the path as it was', async () => {
  const probe = world({ language: 'zh-TW', noteStylesFolder: undefined });
  const folder = probe.store.folder();
  const other = world({ language: 'zh-CN', noteStylesFolder: undefined }).store.folder();
  assert.notEqual(folder, other, 'the default name depends on the language');
  const w = world({ language: 'zh-TW', noteStylesFolder: undefined });
  assert.equal((await w.store.migrateLegacy({ mapsWithStyle: [] })).status, 'done');
  assert.equal(w.settings.noteStylesFolder, folder);
  assert.equal(w.saves.length, 1);
  const made = Object.keys(w.v.files).sort();
  w.settings.language = 'zh-CN';
  await w.store.refresh();
  assert.equal(w.store.folder(), folder);
  assert.ok(w.store.listBlocks('template').some(item => item.kind === 'file' && item.name === 'Conclusion'), 'the converted structure is still found');
  await w.store.ensureBlockFolder();
  assert.equal(w.settings.noteStylesFolder, folder);
  assert.deepEqual([...w.v.folders].filter(path => path.startsWith(other)), []);
  assert.deepEqual(Object.keys(w.v.files).sort(), made);
  const empty = world({ language: 'zh-TW', noteStylesFolder: undefined, detailTemplates: [], promptPresets: [] });
  await empty.store.migrateLegacy({ mapsWithStyle: [] });
  assert.equal(empty.settings.noteStylesFolder, undefined, 'no file written: the path is not pinned');
  const failing = world({ language: 'zh-TW', noteStylesFolder: undefined });
  failing.v.failSave = true;
  assert.equal((await failing.store.migrateLegacy({ mapsWithStyle: [] })).status, 'failed');
  assert.equal(failing.settings.noteStylesFolder, undefined);
});

test('counter 16 (was upgrade "T1 a user action pins the folder", decisions #32): copyBlock, ensureBlockFile and ensureBlockFolder pin the default folder, and a saved path is never replaced', async () => {
  const marked = { noteStyleRecipe: { migrated: 1, mapsNotified: true } };
  const w = world({ language: 'en', noteStylesFolder: undefined, ...marked });
  await w.store.refresh();
  await w.store.copyBlock('template', 'builtin:standard');
  assert.equal(w.settings.noteStylesFolder, w.store.folder());
  const saved = w.settings.noteStylesFolder;
  w.settings.language = 'zh-CN';
  await w.store.ensureBlockFile('tone', 'builtin:plain');
  assert.equal(w.settings.noteStylesFolder, saved);
  const own = world({ language: 'en', noteStylesFolder: 'Mine/S', ...marked });
  await own.store.ensureBlockFolder();
  assert.equal(own.settings.noteStylesFolder, 'Mine/S');
});

test('pure plan: a plan with nothing to do says so; the planner reads existing files only to reuse or rename and returns the files in write order (structures, voices, styles)', () => {
  const empty = { language: 'en', detailTemplates: [], promptPresets: [], existing: { recipe: new Map(), template: new Map(), tone: new Map() } };
  eq(M.planRecipeMigration(empty), { files: [], legacy: { templates: {}, tones: {} }, skipped: [], nothing: true });
  const plan = M.planRecipeMigration({ ...empty, detailTemplates: DATA.detailTemplates, promptPresets: DATA.promptPresets });
  eq(plan.files.map(file => file.category), ['template', 'template', 'template', 'template', 'tone', 'tone', 'recipe', 'recipe', 'recipe', 'recipe']);
  assert.equal(plan.nothing, false);
  assert.equal(plan.topicStyle, undefined, 'no default given');
});

test('language gate: the conversion module does not branch on a language id', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'ai', 'note-style-migrate.ts'), 'utf8');
  assert.doesNotMatch(source, /["'`](?:zh-TW|zh-CN|en)["'`]/);
  assert.doesNotMatch(source, /startsWith\(["'`]zh/);
});
