// Ticket 06 P1/P2: the one-time upgrade of the old note style data (style files, exported templates, custom tone presets,
// the workspace default) into template and tone blocks. From P2 the old switches no longer reach the prompt, so the
// "old prompt" each case compares with is what the old path sent: the old path's sections with the frozen switch
// function (applyFormatPreferences, kept in the upgrade module) applied to the built-in format text, and charts off when
// the file turned diagrams off. The upgraded prompt must equal it byte for byte.
// Unit and integration level over an in-memory vault; the plugin wiring is covered by one onload check at the end.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadSource } = require('./support-replay.cjs');
const S = require('./support.cjs');

const M = loadSource(`
export * from "./ai/note-style-store";
export * from "./ai/note-style-file";
export { planNoteStyleUpgrade, normalizeNoteStyleAliases, readLegacyFormatPreferences, legacyObsidianFormat } from "./ai/note-style-upgrade";
export { normalizeTemplates } from "./ai/detail-templates";
export { previewPrompt, sampleTaskContext, PREVIEW_STEPS } from "./core/blocks/prompt-preview";
export { parseTemplateBlock } from "./core/blocks/template-block";
export { inLanguage, OBSIDIAN_FORMAT } from "./core/steps/_shared/fragments";
export { customDetailRule } from "./core/steps/task/fragments";
export { AiTaskService } from "./core/ai-task-service";
export { translate } from "./i18n";
`);
const plain = value => JSON.parse(JSON.stringify(value));
const eq = (actual, expected, label) => assert.deepEqual(plain(actual), plain(expected), label);
const LANGUAGES = ['zh-TW', 'zh-CN', 'en'];
const FIXTURES = path.join(__dirname, 'fixtures', 'note-style-legacy');
const fixture = name => fs.readFileSync(path.join(FIXTURES, name), 'utf8');
const FOLDER = 'WS/S';

function vault(files = {}) {
  const state = { files: { ...files }, folders: new Set(), trashed: [], ops: [], creates: 0, failCreateAt: 0, failTrash: false, failSave: false, gate: null };
  const under = folder => Object.keys(state.files).filter(file => file.startsWith(`${folder}/`) && !file.slice(folder.length + 1).includes('/'));
  state.port = {
    list: async folder => under(folder).map(file => file.slice(folder.length + 1)).filter(name => name.endsWith('.md')),
    read: async file => { if (!(file in state.files)) throw new Error(file); return state.files[file]; },
    folderExists: folder => state.folders.has(folder) || under(folder).length > 0 || Object.keys(state.files).some(file => file.startsWith(`${folder}/`)),
    createFolder: async folder => { state.ops.push(['folder', folder]); state.folders.add(folder); },
    create: async (file, content) => {
      if (state.gate) await state.gate;
      state.creates++;
      if (state.failCreateAt && state.creates === state.failCreateAt) throw new Error('write failed');
      if (Object.keys(state.files).some(existing => existing.toLowerCase() === file.toLowerCase())) throw new Error(`exists: ${file}`);
      state.files[file] = content; state.ops.push(['create', file]);
    },
    trash: async file => {
      if (state.failTrash) throw new Error('trash failed');
      state.trashed.push({ path: file, content: state.files[file] }); state.ops.push(['trash', file]); delete state.files[file];
    }
  };
  return state;
}
const PRESETS = [];
function world(settingsPatch = {}, files = {}, shared = {}) {
  const v = shared.v ?? vault(Object.fromEntries(Object.entries(files).map(([name, text]) => [name.includes('/') ? name : `${FOLDER}/${name}`, text])));
  const settings = shared.settings ?? { detailTemplates: [], promptPresets: PRESETS, workspaceFolder: 'WS', language: 'en', noteStylesFolder: FOLDER, ...settingsPatch };
  const events = [];
  const saves = [];
  const store = new M.NoteStyleStore({
    settings: () => settings, port: v.port,
    save: async () => { if (v.failSave) throw new Error('save failed'); v.ops.push(['save']); saves.push(JSON.stringify(settings)); },
    now: () => new Date(2026, 10, 2, 9, 30, 0), report: event => events.push(event)
  });
  return { store, v, settings, events, saves };
}
const dirs = language => {
  const root = `${FOLDER}/${M.translate(language, 'ui.block_folder_name')}`;
  return { root, template: `${root}/${M.translate(language, 'ui.block_folder_template')}`, tone: `${root}/${M.translate(language, 'ui.block_folder_tone')}`, backup: `${root}/${M.translate(language, 'ui.block_folder_backup')}` };
};
const inDir = (v, folder) => Object.fromEntries(Object.entries(v.files).filter(([file]) => file.startsWith(`${folder}/`) && !file.slice(folder.length + 1).includes('/')).map(([file, text]) => [file.slice(folder.length + 1), text]));

/** The style fields a run gets, as the map view builds them from runStyle (the three levels are the run's choice, the topic and the map). */
function fieldsFor(store, levels, ids, language) {
  const resolved = store.runStyle({ choice: levels[0], topic: levels[1], map: levels[2], outputLanguage: language });
  assert.equal(resolved.issues.invalid, undefined);
  return { resolved, fields: { detailTemplate: resolved.template, ...(resolved.toneText ? { toneText: resolved.toneText } : {}), ...resolved.contextFields } };
}
const service = new M.AiTaskService({ pluginDirectory: () => '/plugin', language: () => 'en', defaultReasoning: () => 'low', exchangeLoggingEnabled: () => false });
/** The five step prompts and the chart answer for one scenario. */
function promptsOf(store, language, scenario) {
  const { resolved, fields } = fieldsFor(store, scenario.levels, scenario.ids, language);
  const prompts = M.PREVIEW_STEPS.map(step => M.previewPrompt(step.id, language, 'codex', fields).text);
  const context = { ...M.sampleTaskContext('research', language, fields), addCharts: true };
  return { prompts, charts: service.chartEligible(context), resolved, fields };
}
/**
 * What the old path sent for a scenario: the prompts of a store that has not upgraded (the file's sections and tone), with
 * the built-in format text replaced by the frozen switches applied to it, and the chart answer ANDed with the file's
 * diagrams switch (the old `styleDiagrams` gate).
 */
function oldPromptsOf(w, language, scenario) {
  const got = promptsOf(w.store, language, scenario);
  const file = got.resolved.label.fileName && w.v.files[`${FOLDER}/${got.resolved.label.fileName}`];
  const preferences = file ? M.readLegacyFormatPreferences(file) : undefined;
  if (!preferences) return got;
  const plainFormat = M.inLanguage(M.OBSIDIAN_FORMAT, language), switched = M.legacyObsidianFormat(language, preferences);
  return { ...got, prompts: got.prompts.map(prompt => prompt.replace(plainFormat, () => switched)), charts: preferences.diagrams && got.charts };
}
const SCENARIOS = {
  map: { levels: [{}, {}, { template: 'style:S' }], ids: [undefined, undefined, undefined] },
  'map with its tone': { levels: [{}, {}, { template: 'style:S', tone: 'plain' }], ids: [undefined, undefined, 'plain'] },
  'run tone over the style': { levels: [{ template: 'style:S', tone: 'summary' }, {}, {}], ids: ['summary', undefined, undefined] },
  'topic style, map tone': { levels: [{}, { template: 'style:S' }, { tone: 'guide' }], ids: [undefined, undefined, 'guide'] },
  'workspace default': { levels: [{}, {}, {}], ids: [undefined, undefined, undefined], settings: { defaultNoteStyleId: 'style:S' } }
};
/** Old path vs upgraded blocks for one style file in one language over every scenario; returns how many comparisons were made. */
async function compareStyleFile(text, language, label, scenarios = SCENARIOS, patch = {}) {
  let compared = 0;
  for (const [name, scenario] of Object.entries(scenarios)) {
    const settings = { language, ...patch, ...(scenario.settings ?? {}) };
    const before = world(settings, { 'S.md': text });
    await before.store.refresh();
    const after = world(settings, { 'S.md': text });
    const result = await after.store.upgradeLegacy();
    assert.equal(result.status, 'done', label);
    await after.store.refresh();
    const old = oldPromptsOf(before, language, scenario);
    const upgraded = promptsOf(after.store, language, scenario);
    assert.ok(old.resolved.label.fileName && !old.resolved.contextFields.styleSelection, `${label}/${name}: the old path read the file`);
    assert.ok(upgraded.resolved.contextFields.styleSelection, `${label}/${name}: the upgraded run uses a block`);
    old.prompts.forEach((prompt, index) => { assert.equal(upgraded.prompts[index], prompt, `${label} ${language} ${name} step ${index}`); compared++; });
    assert.equal(upgraded.charts, old.charts, `${label} ${language} ${name} charts`);
  }
  return compared;
}

test('the four fixtures plus the default-callout file: old path and upgraded blocks send the same five prompts in all three languages', async () => {
  let compared = 0;
  for (const name of ['table-off.md', 'callouts-placed.md', 'callout-keys.md', 'charts-off.md', 'no-callout-line.md', 'all-off.md'])
    for (const language of LANGUAGES) compared += await compareStyleFile(fixture(name), language, name);
  assert.equal(compared, 6 * 3 * Object.keys(SCENARIOS).length * 5);
});

test('charts off: chartsWanted is false before and after the upgrade (the format rules zone carries no mermaid line)', async () => {
  for (const language of LANGUAGES) {
    const before = world({ language }, { 'S.md': fixture('charts-off.md') });
    await before.store.refresh();
    const after = world({ language }, { 'S.md': fixture('charts-off.md') });
    await after.store.upgradeLegacy();
    await after.store.refresh();
    assert.equal(oldPromptsOf(before, language, SCENARIOS.map).charts, false, language);
    assert.equal(promptsOf(after.store, language, SCENARIOS.map).charts, false, language);
    const block = Object.values(inDir(after.v, dirs(language).template))[0];
    assert.ok(!block.includes('```mermaid'));
  }
});

test('counter 1 and 2: a file without a callouts line is "placed" (the placed sentence is in the format zone); a key set to off drops its line and says nothing', async () => {
  const a = world({ language: 'en' }, { 'S.md': fixture('no-callout-line.md') });
  await a.store.upgradeLegacy();
  const text = Object.values(inDir(a.v, dirs('en').template))[0];
  assert.match(text, /Use callouts only where the style places them/);
  assert.ok(!text.split('\n').some(line => line.startsWith('- ') && line.includes('> [!')));
  const b = world({ language: 'en' }, { 'S.md': fixture('callout-keys.md') });
  await b.store.upgradeLegacy();
  const keys = Object.values(inDir(b.v, dirs('en').template))[0];
  assert.ok(keys.includes('`> [!abstract]`') && keys.includes('`> [!caution]`') && keys.includes('`> [!example]`'));
  assert.ok(!keys.includes('[!question]') && !keys.includes('`> [!summary]`'));
  assert.doesNotMatch(keys, /This style does not use/);
});

test('counter 3: diagrams off but the user\'s own section holds a mermaid block: the chart step runs after the upgrade (locked behaviour)', async () => {
  const text = '---\n圖表: 關\n方框: 自動\n---\n## 核心結論\n講結論。\n\n## 流程\n畫一張流程圖：\n```mermaid\nflowchart TD\n  A --> B\n```\n';
  const before = world({ language: 'en' }, { 'S.md': text });
  await before.store.refresh();
  const after = world({ language: 'en' }, { 'S.md': text });
  await after.store.upgradeLegacy();
  await after.store.refresh();
  assert.equal(oldPromptsOf(before, 'en', SCENARIOS.map).charts, false);
  assert.equal(promptsOf(after.store, 'en', SCENARIOS.map).charts, true);
});

test('counter 4: a file near 8000 characters upgrades (the limit counts the sections zone only) and the prompt is unchanged', async () => {
  const filler = '一二三四五六七八九十'.repeat(110);
  let text = '---\n圖表: 關\n---\n';
  for (let n = 1; n <= 7; n++) text += `## 段落 ${n}\n${filler}\n\n`;
  assert.ok(text.length > 7500 && text.length < 8000);
  assert.equal(await compareStyleFile(text, 'en', 'near the limit', { map: SCENARIOS.map }), 5);
  const after = world({ language: 'en' }, { 'S.md': text });
  await after.store.upgradeLegacy();
  const block = Object.values(inDir(after.v, dirs('en').template))[0];
  assert.ok(block.length > 8000, 'with the format zone the block is over the file limit');
  assert.equal(M.parseTemplateBlock(block, { id: 'file:S', name: 'S' }).ok, true);
});

test('counter 5: the format zone is written in the interface language of the upgrade; a map run in another language gets that zone', async () => {
  const text = fixture('table-off.md');
  const before = world({ language: 'zh-TW' }, { 'S.md': text });
  await before.store.refresh();
  const after = world({ language: 'zh-TW' }, { 'S.md': text });
  await after.store.upgradeLegacy();
  await after.store.refresh();
  const old = oldPromptsOf(before, 'en', SCENARIOS.map).prompts[0];
  const upgraded = promptsOf(after.store, 'en', SCENARIOS.map).prompts[0];
  const zhFormat = M.inLanguage(M.OBSIDIAN_FORMAT, 'zh-TW');
  assert.ok(upgraded.includes('Markdown 表格') || upgraded.includes(zhFormat.split('\n')[0]), 'the zone stays zh');
  assert.notEqual(upgraded, old);
  assert.ok(old.includes('Markdown'), 'the old path wrote the format in the run language');
  assert.ok(!old.includes(zhFormat.split('\n')[0]));
});

test('counter 6 and 7: a file with no tone gives no tone even when the workspace tone is Key points; a more specific tone choice still wins', async () => {
  const text = fixture('charts-off.md');
  const scenarios = { map: SCENARIOS.map, 'map with its tone': SCENARIOS['map with its tone'], 'topic style, map tone': SCENARIOS['topic style, map tone'] };
  for (const language of LANGUAGES) {
    const before = world({ language, defaultNoteStyleId: 'summary' }, { 'S.md': text });
    await before.store.refresh();
    const after = world({ language, defaultNoteStyleId: 'summary' }, { 'S.md': text });
    await after.store.upgradeLegacy();
    await after.store.refresh();
    for (const [name, scenario] of Object.entries(scenarios)) {
      const old = oldPromptsOf(before, language, scenario), upgraded = promptsOf(after.store, language, scenario);
      assert.deepEqual(upgraded.prompts, old.prompts, `${language} ${name}`);
    }
    assert.equal(promptsOf(after.store, language, SCENARIOS.map).fields.toneText, undefined);
    assert.ok(promptsOf(after.store, language, SCENARIOS['map with its tone']).fields.toneText);
  }
});

test('counter 18 (P1 part): a block that still carries old frontmatter switches reads the same as without them', () => {
  const body = '## 核心結論\n講結論。\n';
  const format = M.inLanguage(M.OBSIDIAN_FORMAT, 'en');
  const withSwitches = M.parseTemplateBlock(`---\n圖表: 關\n表格: 關\n問題方框: 關\n---\n${body}\n# ${M.translate('en', 'ui.block_template_format_heading')}\n\n${format}\n`, { id: 'file:X', name: 'X' });
  const without = M.parseTemplateBlock(`${body}\n# ${M.translate('en', 'ui.block_template_format_heading')}\n\n${format}\n`, { id: 'file:X', name: 'X' });
  assert.equal(withSwitches.ok, true);
  eq(withSwitches.template.sections.map(({ line, ...rest }) => rest), without.template.sections.map(({ line, ...rest }) => rest));
  assert.equal(withSwitches.format, without.format);
});

test('intro layout (locked): a file with a lead-in becomes a block with a lead; its prompt differs from the old lead-in sentence', async () => {
  const text = fixture('intro.md');
  const before = world({ language: 'en' }, { 'S.md': text });
  await before.store.refresh();
  const after = world({ language: 'en' }, { 'S.md': text });
  await after.store.upgradeLegacy();
  await after.store.refresh();
  const old = oldPromptsOf(before, 'en', SCENARIOS.map).prompts[0], upgraded = promptsOf(after.store, 'en', SCENARIOS.map).prompts[0];
  assert.match(old, /lead-in paragraphs with no heading/);
  assert.ok(upgraded.includes('先用 2–4 段導讀\n帶讀者進入主題。'));
  assert.doesNotMatch(upgraded, /lead-in paragraphs with no heading/);
  assert.equal(promptsOf(after.store, 'en', SCENARIOS.map).charts, false);
});

test('backups: every old file has a byte-identical copy in the backup folder; the order is backups, blocks, data.json, trash', async () => {
  const files = Object.fromEntries(['table-off.md', 'callouts-placed.md', 'callout-keys.md', 'charts-off.md'].map(name => [name, fixture(name)]));
  files['crlf.md'] = fixture('table-off.md').replace(/\n/g, '\r\n');
  const w = world({ language: 'en' }, files);
  const result = await w.store.upgradeLegacy();
  assert.equal(result.status, 'done');
  const backups = inDir(w.v, dirs('en').backup);
  for (const [name, text] of Object.entries(files)) {
    const base = name.replace(/\.md$/, '');
    const found = Object.entries(backups).filter(([backup]) => backup.startsWith(`${base} 2026-11-02 093000`));
    assert.equal(found.length, 1, name);
    assert.equal(found[0][1], text, `${name} is byte-identical`);
  }
  assert.equal(Object.keys(backups).length, 5);
  const kinds = w.v.ops.map(op => op[0] === 'create' ? (op[1].startsWith(dirs('en').backup) ? 'backup' : 'block') : op[0]);
  const lastBackup = kinds.lastIndexOf('backup'), firstBlock = kinds.indexOf('block'), save = kinds.indexOf('save'), firstTrash = kinds.indexOf('trash');
  assert.ok(lastBackup < firstBlock && firstBlock < save && save < firstTrash, kinds.join());
  assert.equal(kinds.filter(kind => kind === 'save').length, 1);
  eq(w.v.trashed.map(item => item.path).sort(), Object.keys(files).map(name => `${FOLDER}/${name}`).sort());
  for (const item of w.v.trashed) assert.equal(item.content, files[item.path.slice(FOLDER.length + 1)]);
  assert.deepEqual(Object.keys(inDir(w.v, FOLDER)), [], 'the style folder holds no style file any more');
  eq(w.settings.noteStyleUpgrade, { version: 1 });
});

test('idempotent: a second run on the same store, and a new store over the saved state, write nothing and leave data.json alone', async () => {
  const w = world({ language: 'en', defaultNoteStyleId: 'style:table-off' }, { 'table-off.md': fixture('table-off.md'), 'charts-off.md': fixture('charts-off.md') });
  assert.equal((await w.store.upgradeLegacy()).status, 'done');
  const files = JSON.stringify(w.v.files), data = JSON.stringify(w.settings), ops = w.v.ops.length, saves = w.saves.length;
  assert.equal((await w.store.upgradeLegacy()).status, 'done', 'the same promise');
  const again = world({}, {}, { v: w.v, settings: JSON.parse(data) });
  assert.equal((await again.store.upgradeLegacy()).status, 'already');
  await again.store.refresh();
  assert.equal(JSON.stringify(w.v.files), files);
  assert.equal(w.v.ops.length, ops);
  assert.equal(again.saves.length, 0);
  assert.equal(JSON.stringify(again.settings), data);
  assert.equal(w.saves.length, saves);
});

test('no old data: only the marker is written, no folder and no file', async () => {
  const w = world({ language: 'en', noteStylesFolder: undefined }, {});
  const before = plain(w.settings);
  assert.equal((await w.store.upgradeLegacy()).status, 'done');
  assert.deepEqual(w.v.ops, [['save']]);
  assert.equal(w.v.folders.size, 0);
  assert.deepEqual(w.v.files, {});
  eq({ ...plain(w.settings), noteStyleUpgrade: undefined }, before);
  eq(w.settings.noteStyleUpgrade, { version: 1 });
  assert.equal(w.settings.noteStyleAliases, undefined);
  assert.equal(w.settings.noteTemplateBlock, undefined);
});

const EDITS = {
  files: { 'table-off.md': fixture('table-off.md'), 'callout-keys.md': fixture('callout-keys.md'), 'charts-off.md': fixture('charts-off.md') },
  presets: [{ id: 'custom-tone-1', kind: 'tone', name: 'Pirate', text: 'Talk like a pirate.' }]
};
const successRun = async () => {
  const w = world({ language: 'en', promptPresets: EDITS.presets, defaultNoteStyleId: 'style:table-off' }, EDITS.files);
  await w.store.upgradeLegacy();
  return w;
};

test('failure: a write that fails at any step sets no marker, changes no key, trashes nothing, keeps the prompt, and the next load finishes and reuses what was written', async () => {
  const done = await successRun();
  const totalCreates = done.v.creates;
  const finalTemplates = Object.keys(inDir(done.v, dirs('en').template)).sort();
  const finalTones = Object.keys(inDir(done.v, dirs('en').tone)).sort();
  assert.ok(totalCreates >= 7);
  const scenario = { levels: [{}, {}, { template: 'style:table-off' }], ids: [undefined, undefined, undefined] };
  const reference = world({ language: 'en', promptPresets: EDITS.presets, defaultNoteStyleId: 'style:table-off' }, EDITS.files);
  await reference.store.refresh();
  const wanted = oldPromptsOf(reference, 'en', scenario).prompts;
  const modes = [...Array(totalCreates).keys()].map(index => ({ failCreateAt: index + 1 })).concat([{ failSave: true }]);
  for (const mode of modes) {
    const w = world({ language: 'en', promptPresets: EDITS.presets, defaultNoteStyleId: 'style:table-off' }, EDITS.files);
    Object.assign(w.v, mode);
    const first = await w.store.startUpgrade();
    const label = JSON.stringify(mode);
    assert.equal(first.status, 'failed', label);
    eq(w.events, [{ kind: 'failed' }], label);
    assert.equal(w.settings.noteStyleUpgrade, undefined, label);
    assert.equal(w.settings.noteTemplateBlock, undefined, label);
    assert.equal(w.settings.noteToneBlock, undefined, label);
    assert.equal(w.settings.noteStyleAliases, undefined, label);
    assert.deepEqual(w.v.trashed, [], label);
    for (const name of Object.keys(EDITS.files)) assert.equal(w.v.files[`${FOLDER}/${name}`], EDITS.files[name], `${label}: ${name} is still there`);
    // this session still answers as before, from the plan in memory
    await w.store.refresh();
    assert.deepEqual(promptsOf(w.store, 'en', scenario).prompts, wanted, label);
    assert.equal(promptsOf(w.store, 'en', scenario).resolved.contextFields.styleSelection?.template.id.startsWith('file:'), true, `${label}: from the memory plan`);
    // the next load
    const next = world({}, {}, { v: w.v, settings: w.settings });
    Object.assign(w.v, { failCreateAt: 0, failSave: false, creates: 0 });
    const second = await next.store.startUpgrade();
    assert.equal(second.status, 'done', label);
    assert.deepEqual(Object.keys(inDir(w.v, dirs('en').template)).sort(), finalTemplates, `${label}: no duplicate names`);
    assert.deepEqual(Object.keys(inDir(w.v, dirs('en').tone)).sort(), finalTones, `${label}: no duplicate names`);
    assert.deepEqual(Object.keys(inDir(w.v, FOLDER)), [], label);
    assert.ok(Object.keys(inDir(w.v, dirs('en').backup)).length >= 3, `${label}: backups, possibly extra`);
    await next.store.refresh();
    assert.deepEqual(promptsOf(next.store, 'en', scenario).prompts, wanted, label);
    assert.equal(next.settings.noteTemplateBlock, 'file:table-off', label);
  }
});

test('failure: the old file that cannot be moved to the trash is told once; the marker stays and the blocks are in use', async () => {
  const w = world({ language: 'en' }, { 'S.md': fixture('table-off.md') });
  w.v.failTrash = true;
  const result = await w.store.upgradeLegacy();
  assert.equal(result.status, 'done');
  eq(result.trashFailed, ['S']);
  eq(w.events, [{ kind: 'trash-failed', names: ['S'] }]);
  eq(w.settings.noteStyleUpgrade, { version: 1 });
  assert.ok(w.v.files[`${FOLDER}/S.md`], 'the old file stays');
  await w.store.refresh();
  assert.ok(w.store.runStyle({ topic: { template: 'style:S' }, outputLanguage: 'en' }).contextFields.styleSelection, 'the block answers, not the file');
});

test('a file that changed while the upgrade ran is not trashed over', async () => {
  const w = world({ language: 'en' }, { 'S.md': fixture('table-off.md') });
  w.v.gate = new Promise(resolve => setTimeout(resolve, 20)).then(() => { w.v.files[`${FOLDER}/S.md`] += '\nchanged'; });
  const result = await w.store.upgradeLegacy();
  eq(result.trashFailed, ['S']);
  assert.deepEqual(w.v.trashed, []);
});

test('counter 14: a run that starts while the upgrade is under way waits for it', async () => {
  const w = world({ language: 'en' }, { 'S.md': fixture('table-off.md') });
  let release;
  w.v.gate = new Promise(resolve => { release = resolve; });
  const upgrade = w.store.startUpgrade();
  let refreshed = false;
  const refresh = w.store.refresh().then(() => { refreshed = true; });
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(refreshed, false, 'refresh() waits');
  release();
  await upgrade; await refresh;
  assert.equal(refreshed, true);
  assert.ok(w.store.runStyle({ topic: { template: 'style:S' }, outputLanguage: 'en' }).contextFields.styleSelection);
});

test('counter 15: keys the user already set are not overwritten; the aliases are still written', async () => {
  const w = world({ language: 'en', defaultNoteStyleId: 'style:S', noteTemplateBlock: 'builtin:textbook', noteToneBlock: 'builtin:guide' }, { 'S.md': fixture('table-off.md') });
  await w.store.upgradeLegacy();
  assert.equal(w.settings.noteTemplateBlock, 'builtin:textbook');
  assert.equal(w.settings.noteToneBlock, 'builtin:guide');
  assert.equal(w.settings.noteStyleAliases['style:S'].template, 'file:S');
});

test('workspace default: the old default becomes the new keys and the workspace prompt is unchanged (style file, built-in styles, old template)', async () => {
  const LEGACY = M.normalizeTemplates([{ id: 'uuid-1', name: 'My notes', sections: [
    { id: 'a', name: 'Core conclusions', description: 'Lead with the answer.', role: 'none', count: { mode: 'min', n: 3 }, aliases: [] },
    { id: 'b', name: 'Evidence and sources', description: '', role: 'sources', aliases: [] },
    { id: 'c', name: 'Update log', description: 'One dated line.', role: 'log', aliases: [] }] }]);
  const cases = [
    { patch: { defaultNoteStyleId: 'style:S' }, template: 'file:S', tone: 'builtin:academic' },
    { patch: { defaultNoteStyleId: 'textbook' }, template: 'builtin:textbook', tone: 'builtin:academic' },
    { patch: { defaultNoteStyleId: 'summary' }, template: 'builtin:standard', tone: 'builtin:summary' },
    { patch: { defaultNoteStyleId: 'guide' }, template: 'builtin:standard', tone: 'builtin:guide' },
    { patch: { defaultDetailTemplateId: 'textbook' }, template: 'builtin:textbook', tone: undefined },
    { patch: { defaultDetailTemplateId: 'uuid-1' }, template: 'file:My notes', tone: undefined },
    { patch: { defaultNoteStyleId: 'style:Gone' }, template: undefined, tone: undefined },
    { patch: {}, template: undefined, tone: undefined }
  ];
  for (const language of LANGUAGES) for (const item of cases) {
    const patch = { language, detailTemplates: LEGACY, ...item.patch };
    const before = world(patch, { 'S.md': fixture('charts-off.md') });
    await before.store.refresh();
    const after = world(patch, { 'S.md': fixture('charts-off.md') });
    await after.store.upgradeLegacy();
    await after.store.refresh();
    assert.equal(after.settings.noteTemplateBlock, item.template, JSON.stringify(item.patch));
    assert.equal(after.settings.noteToneBlock, item.tone, JSON.stringify(item.patch));
    for (const scenario of [{ levels: [{}, {}, {}], ids: [] }, { levels: [{}, {}, { tone: 'plain' }], ids: [undefined, undefined, 'plain'] }]) {
      const old = oldPromptsOf(before, language, scenario), upgraded = promptsOf(after.store, language, scenario);
      const same = item.patch.defaultNoteStyleId === 'style:Gone' || item.patch.defaultNoteStyleId === undefined && item.patch.defaultDetailTemplateId === undefined;
      assert.deepEqual(upgraded.prompts, old.prompts, `${language} ${JSON.stringify(item.patch)} ${same ? '(nothing to carry)' : ''}`);
    }
  }
});

test('old custom templates: standard-named sections upgrade to the same prompt (also through an edited exported file); a custom-named log role is a locked difference', async () => {
  const names = { a: 'Core conclusions', b: 'Evidence and sources', c: 'Update log' };
  const template = M.normalizeTemplates([{ id: 'uuid-1', name: 'My notes', sections: [
    { id: 'a', name: names.a, description: 'Lead with the answer.', role: 'none', count: { mode: 'min', n: 3 }, aliases: [] },
    { id: 'b', name: names.b, description: '', role: 'sources', aliases: [] },
    { id: 'c', name: names.c, description: 'One dated line.', role: 'log', aliases: [] }] }]);
  const scenario = { levels: [{}, {}, { template: 'uuid-1' }], ids: [undefined, undefined, undefined] };
  const withTone = { levels: [{}, {}, { template: 'uuid-1', tone: 'plain' }], ids: [undefined, undefined, 'plain'] };
  for (const language of LANGUAGES) {
    for (const exported of [false, true]) {
      const edited = M.serializeLegacyV1(template[0], language).replace('Lead with the answer.', 'Lead with the real answer.');
      const files = exported ? { 'My notes.md': edited } : {};
      const patch = { language, detailTemplates: template, ...(exported ? { noteStyleFiles: { 'uuid-1': 'My notes.md' } } : {}) };
      const before = world(patch, files); await before.store.refresh();
      const after = world(patch, files); await after.store.upgradeLegacy(); await after.store.refresh();
      for (const item of [scenario, withTone]) {
        const old = oldPromptsOf(before, language, item), upgraded = promptsOf(after.store, language, item);
        assert.deepEqual(upgraded.prompts, old.prompts, `${language} exported=${exported}`);
        assert.equal(upgraded.charts, old.charts);
        assert.ok(upgraded.resolved.contextFields.styleSelection);
      }
      assert.deepEqual(plain(after.settings.detailTemplates), plain(template), 'the old key is kept');
    }
  }
  // a custom section name that carried the log role: the role cannot be written in a block
  const custom = M.normalizeTemplates([{ id: 'uuid-2', name: 'Diary', sections: [
    { id: 'a', name: 'Findings', description: 'What we found.', role: 'none', aliases: [] },
    { id: 'b', name: 'History', description: 'One dated line.', role: 'log', aliases: [] }] }]);
  const before = world({ language: 'en', detailTemplates: custom }, {}); await before.store.refresh();
  const after = world({ language: 'en', detailTemplates: custom }, {}); await after.store.upgradeLegacy(); await after.store.refresh();
  const one = { levels: [{}, {}, { template: 'uuid-2' }], ids: [] };
  const old = oldPromptsOf(before, 'en', one).prompts[0], upgraded = promptsOf(after.store, 'en', one).prompts[0];
  const logRule = M.customDetailRule('log', 'en', { heading: '### History' });
  assert.ok(old.includes(logRule));
  assert.ok(!upgraded.includes(logRule));
  assert.notEqual(upgraded, old);
});

test('tones: a custom preset becomes a tone block (cleaned name, never a built-in\'s), its id is an alias, and the file\'s 語氣 maps to a built-in, a custom block or a new block', async () => {
  const presets = [
    { id: 'custom-tone-1', kind: 'tone', name: 'Pirate', text: 'Talk like a pirate.' },
    { id: 'custom-tone-2', kind: 'tone', name: M.translate('en', 'ui.preset_name_plain'), text: 'Say it plainly.' },
    { id: 'custom-tone-3', kind: 'tone', name: 'a/b: c', text: 'Odd name.' }
  ];
  const named = (language, key) => M.translate(language, key);
  for (const language of LANGUAGES) {
    const toneName = text => `---\n語氣: ${text}\n---\n## 核心結論\n講結論。\n\n## 更新紀錄\n一行摘要。\n`;
    const files = {
      'Builtin.md': toneName(named(language, 'ui.preset_name_summary')),
      'ById.md': toneName('guide'),
      'Academic.md': toneName('academic'),
      'Custom.md': toneName('Pirate'),
      'Free.md': toneName('Short sentences, friendly.'),
      'OtherLanguage.md': toneName(M.translate(language === 'en' ? 'zh-TW' : 'en', 'ui.preset_name_plain'))
    };
    const before = world({ language, promptPresets: presets }, files); await before.store.refresh();
    const after = world({ language, promptPresets: presets }, files); await after.store.upgradeLegacy(); await after.store.refresh();
    const aliases = after.settings.noteStyleAliases;
    assert.equal(aliases['style:Builtin'].tone, 'builtin:summary', language);
    assert.equal(aliases['style:ById'].tone, 'builtin:guide');
    assert.equal(aliases['style:Academic'].tone, 'builtin:academic');
    assert.equal(aliases['style:Custom'].tone, aliases['custom-tone-1'].tone);
    assert.match(aliases['style:Free'].tone, /^file:/);
    const toneFiles = inDir(after.v, dirs(language).tone);
    const toneNames = Object.keys(toneFiles);
    assert.equal(toneFiles['Pirate.md'], 'Talk like a pirate.');
    assert.ok(!toneNames.some(name => name.toLowerCase() === `${M.translate(language, 'ui.preset_name_plain').toLowerCase()}.md`), 'never a built-in tone\'s name');
    assert.ok(toneNames.includes(`${M.translate('en', 'ui.preset_name_plain')} (2).md`) || language !== 'en');
    assert.ok(toneNames.includes('a b c.md'), toneNames.join());
    assert.equal(after.store.listBlocks('tone').filter(item => item.kind === 'builtin').every(item => !item.modified), true);
    for (const [name, text] of Object.entries(toneFiles)) assert.ok(text.length > 0, name);
    eq(Object.keys(inDir(after.v, dirs(language).template)).length, 6);
    for (const base of ['Builtin', 'ById', 'Academic', 'Custom', 'Free', 'OtherLanguage']) {
      const scenario = { levels: [{}, {}, { template: `style:${base}` }], ids: [] };
      assert.deepEqual(promptsOf(after.store, language, scenario).prompts, oldPromptsOf(before, language, scenario).prompts, `${language} ${base}`);
    }
    // the custom tone preset's id, chosen on a map or a topic, keeps its text through the alias
    for (const scenario of [
      { levels: [{}, {}, { tone: 'custom-tone-1' }], ids: [undefined, undefined, 'custom-tone-1'] },
      { levels: [{}, { template: 'style:Free', tone: 'custom-tone-2' }, {}], ids: [undefined, 'custom-tone-2', undefined] },
      { levels: [{}, {}, { template: 'textbook', tone: 'custom-tone-1' }], ids: [undefined, undefined, 'custom-tone-1'] }
    ]) assert.deepEqual(promptsOf(after.store, language, scenario).prompts, oldPromptsOf(before, language, scenario).prompts, `${language} ${JSON.stringify(scenario)}`);
  }
});

test('a tone alias whose file was deleted names nothing: the run goes on without it (counter 17)', async () => {
  const presets = [{ id: 'custom-tone-1', kind: 'tone', name: 'Pirate', text: 'Talk like a pirate.' }];
  const w = world({ language: 'en', promptPresets: presets }, { 'S.md': fixture('table-off.md') });
  await w.store.upgradeLegacy();
  await w.store.refresh();
  const scenario = { levels: [{}, {}, { tone: 'custom-tone-1' }], ids: [undefined, undefined, 'custom-tone-1'] };
  assert.match(promptsOf(w.store, 'en', scenario).prompts[0], /Talk like a pirate\./);
  delete w.v.files[`${dirs('en').tone}/Pirate.md`];
  await w.store.refresh();
  assert.doesNotMatch(promptsOf(w.store, 'en', scenario).prompts[0], /Talk like a pirate\./);
});

test('counter 17: an alias whose template block was deleted goes back to the standard template and does not throw', async () => {
  const w = world({ language: 'en' }, { 'S.md': fixture('table-off.md') });
  await w.store.upgradeLegacy();
  delete w.v.files[`${dirs('en').template}/S.md`];
  await w.store.refresh();
  const resolved = w.store.runStyle({ map: { template: 'style:S' }, outputLanguage: 'en' });
  eq(resolved.issues.missing, ['style:S']);
  assert.equal(resolved.template.id, 'standard');
  assert.equal(resolved.contextFields.styleSelection, undefined);
});

test('after the upgrade the old sources are not read: a style file that shows up later is not a style', async () => {
  const w = world({ language: 'en' }, { 'S.md': fixture('table-off.md') });
  await w.store.upgradeLegacy();
  w.v.files[`${FOLDER}/Late.md`] = fixture('charts-off.md');
  await w.store.refresh();
  eq(w.store.runStyle({ topic: { template: 'style:Late' }, outputLanguage: 'en' }).issues.missing, ['style:Late']);
  assert.ok(w.store.runStyle({ topic: { template: 'style:S' }, outputLanguage: 'en' }).contextFields.styleSelection);
});

test('built-in style files: unchanged canonical files (v1 and v2, any language) make no block and are backed up and trashed; a changed one becomes a block under a name that is not a built-in\'s, reached through pair:<id>', async () => {
  for (const version of [0, 1]) for (const fileLanguage of LANGUAGES) for (const language of ['en', 'zh-TW']) {
    const files = Object.fromEntries(M.NOTE_STYLE_BUILTIN_IDS.map(id => [`${M.builtinStyleFileName(id, fileLanguage)}.md`, M.CANONICAL_VERSIONS[version][id][fileLanguage]]));
    const w = world({ language }, files);
    await w.store.upgradeLegacy();
    assert.equal(Object.keys(inDir(w.v, dirs(language).template)).length, 0);
    assert.equal(Object.keys(inDir(w.v, dirs(language).tone)).length, 0);
    assert.equal(Object.keys(inDir(w.v, dirs(language).backup)).length, 5);
    assert.equal(w.v.trashed.length, 5);
    assert.equal(w.settings.noteStyleAliases, undefined);
    await w.store.refresh();
    const r = w.store.runStyle({ topic: { template: 'standard', tone: 'summary' }, outputLanguage: language });
    assert.equal(r.contextFields.styleSelection, undefined);
    assert.equal(r.label.fileName, undefined);
  }
  for (const language of LANGUAGES) {
    const summaryName = M.builtinStyleFileName('summary', language);
    const standardName = M.builtinStyleFileName('standard', language);
    const editedSummary = M.canonicalContent('summary', language).replace(/\n## /, '\n## 先看這裡\n新的段落。\n\n## ');
    const editedStandard = M.canonicalContent('standard', language).replace(/(\n## [^\n]*\n)/, '$1額外要求。\n');
    const files = { [`${summaryName}.md`]: editedSummary, [`${standardName}.md`]: editedStandard };
    const before = world({ language }, files); await before.store.refresh();
    const after = world({ language }, files); await after.store.upgradeLegacy(); await after.store.refresh();
    const templates = Object.keys(inDir(after.v, dirs(language).template));
    assert.ok(templates.includes(`${summaryName}.md`), templates.join());
    assert.ok(templates.includes(`${standardName} (2).md`), 'a built-in\'s name is not reused');
    assert.ok(after.store.listBlocks('template').filter(item => item.kind === 'builtin').every(item => !item.modified));
    assert.ok(after.settings.noteStyleAliases['pair:summary'] && after.settings.noteStyleAliases['pair:standard']);
    for (const scenario of [
      { levels: [{}, {}, { template: 'standard', tone: 'summary' }], ids: [undefined, undefined, 'summary'] },
      { levels: [{}, {}, { template: 'standard' }], ids: [] },
      { levels: [{}, {}, { template: 'textbook', tone: 'summary' }], ids: [undefined, undefined, 'summary'] },
      { levels: [{}, {}, {}], ids: [], settings: { defaultNoteStyleId: 'summary' } }
    ]) {
      const a = world({ language, ...(scenario.settings ?? {}) }, files); await a.store.refresh();
      const b = world({ language, ...(scenario.settings ?? {}) }, files); await b.store.upgradeLegacy(); await b.store.refresh();
      const old = oldPromptsOf(a, language, scenario), upgraded = promptsOf(b.store, language, scenario);
      assert.deepEqual(upgraded.prompts, old.prompts, `${language} ${JSON.stringify(scenario)}`);
    }
  }
});

test('counter 12: a block file that is already there with the same text is reused; with other text the new file takes " (2)"; nothing is overwritten', async () => {
  const first = world({ language: 'en' }, { 'S.md': fixture('table-off.md') });
  await first.store.upgradeLegacy();
  const text = inDir(first.v, dirs('en').template)['S.md'];
  const same = world({ language: 'en' }, { 'S.md': fixture('table-off.md'), [`${dirs('en').template}/S.md`]: text });
  await same.store.upgradeLegacy();
  assert.deepEqual(Object.keys(inDir(same.v, dirs('en').template)), ['S.md']);
  assert.equal(same.settings.noteStyleAliases['style:S'].template, 'file:S');
  const other = world({ language: 'en' }, { 'S.md': fixture('table-off.md'), [`${dirs('en').template}/S.md`]: 'my own block\n' });
  await other.store.upgradeLegacy();
  assert.deepEqual(Object.keys(inDir(other.v, dirs('en').template)).sort(), ['S (2).md', 'S.md']);
  assert.equal(inDir(other.v, dirs('en').template)['S.md'], 'my own block\n');
  assert.equal(other.settings.noteStyleAliases['style:S'].template, 'file:S (2)');
});

test('decision #20 (locked, CHANGELOG upgrade point 5): the workspace default is an edited built-in pair file and a lower level picks another tone', async () => {
  const language = 'en';
  const name = M.builtinStyleFileName('summary', language);
  const edited = M.canonicalContent('summary', language).replace(/\n## /, '\n## Look here first\nNew paragraph.\n\n## ');
  const files = { [`${name}.md`]: edited };
  const scenario = { levels: [{}, {}, { tone: 'plain' }], ids: [undefined, undefined, 'plain'] };
  const before = world({ language, defaultNoteStyleId: 'summary' }, files); await before.store.refresh();
  const after = world({ language, defaultNoteStyleId: 'summary' }, files); await after.store.upgradeLegacy(); await after.store.refresh();
  const old = promptsOf(before.store, language, scenario), upgraded = promptsOf(after.store, language, scenario);
  const names = got => got.resolved.template.sections.map(section => section.name);
  // before: the picked tone selects that tone's own pair, so the edited summary file is not used at all
  assert.ok(!names(old).includes('Look here first'));
  assert.equal(old.resolved.contextFields.styleSelection, undefined);
  // after: the file's template stays (the static key), and only the tone changes
  assert.equal(names(upgraded)[0], 'Look here first');
  assert.deepEqual(names(upgraded).slice(1), names(old));
  assert.ok(upgraded.resolved.contextFields.styleSelection);
  const toneOf = got => got.fields.toneText;
  assert.ok(toneOf(old), 'the picked tone applies before');
  assert.equal(toneOf(upgraded), toneOf(old), 'and after: the same tone text');
  assert.notEqual(upgraded.prompts.join(), old.prompts.join(), 'the known difference: the template is the edited file');
  // with no lower pick both agree, so the difference is only the lower-level pick
  const plain = { levels: [{}, {}, {}], ids: [] };
  assert.deepEqual(promptsOf(after.store, language, plain).prompts, promptsOf(before.store, language, plain).prompts);
});

test('T1: the upgrade remembers the folder it wrote to, so a later change of interface language still finds the blocks', async () => {
  const text = fixture('table-off.md');
  const probe = world({ language: 'zh-TW', noteStylesFolder: undefined });
  const folder = probe.store.folder();
  const other = world({ language: 'zh-CN', noteStylesFolder: undefined }).store.folder();
  assert.notEqual(folder, other, 'the default name depends on the language');
  const w = world({ language: 'zh-TW', noteStylesFolder: undefined }, { [`${folder}/S.md`]: text });
  assert.equal((await w.store.upgradeLegacy()).status, 'done');
  assert.equal(w.settings.noteStylesFolder, folder, 'written with the marker in the one save');
  assert.equal(w.saves.length, 1);
  const made = Object.keys(w.v.files).sort();
  w.settings.language = 'zh-CN';
  await w.store.refresh();
  assert.equal(w.store.folder(), folder);
  eq(w.store.listBlocks('template').filter(item => item.kind === 'file').map(item => item.ref), ['file:S'], 'the block is still found');
  // opening the folder after the language changed makes nothing new and keeps the saved path
  await w.store.ensureBlockFolder();
  assert.equal(w.settings.noteStylesFolder, folder);
  eq([...w.v.folders].filter(path => path.startsWith(other)), []);
  eq(Object.keys(w.v.files).sort(), made);
  // no old data: nothing is written, so the folder path is not pinned either
  const empty = world({ language: 'zh-TW', noteStylesFolder: undefined });
  await empty.store.upgradeLegacy();
  assert.equal(empty.settings.noteStylesFolder, undefined);
  // a save that fails leaves the path as it was
  const failing = world({ language: 'zh-TW', noteStylesFolder: undefined }, { [`${folder}/S.md`]: text });
  failing.v.failSave = true;
  assert.equal((await failing.store.upgradeLegacy()).status, 'failed');
  assert.equal(failing.settings.noteStylesFolder, undefined);
});

test('T1: a user action that makes a block file pins the folder too (open, copy), and a saved path is never replaced', async () => {
  const w = world({ language: 'en', noteStylesFolder: undefined, noteStyleUpgrade: { version: 1 } });
  await w.store.refresh();
  await w.store.copyBlock('template', 'builtin:standard');
  assert.equal(w.settings.noteStylesFolder, w.store.folder());
  const saved = w.settings.noteStylesFolder;
  w.settings.language = 'zh-CN';
  await w.store.ensureBlockFile('tone', 'builtin:plain');
  assert.equal(w.settings.noteStylesFolder, saved);
  const own = world({ language: 'en', noteStylesFolder: 'Mine/S', noteStyleUpgrade: { version: 1 } });
  await own.store.ensureBlockFolder();
  assert.equal(own.settings.noteStylesFolder, 'Mine/S');
});

test('M1: after a failed upgrade the store reports the blocks the runs use (the pending ones), and nothing is saved', async () => {
  const w = world({ language: 'en', defaultNoteStyleId: 'style:table-off' }, { 'table-off.md': fixture('table-off.md') });
  w.v.failSave = true;
  assert.equal((await w.store.startUpgrade()).status, 'failed');
  assert.equal(w.settings.noteTemplateBlock, undefined);
  const keys = w.store.effectiveBlockKeys();
  assert.equal(keys.template, 'file:table-off');
  assert.equal(keys.pending, true);
  w.v.failSave = false;
  assert.equal((await world({}, {}, { v: w.v, settings: w.settings }).store.startUpgrade()).status, 'done');
  assert.equal(w.settings.noteTemplateBlock, 'file:table-off');
});

test('a style file that does not read stays where it is, is not backed up or trashed, and is told once', async () => {
  const w = world({ language: 'en' }, { 'Bad.md': '---\ntone: x\n---\nno sections here\n', 'S.md': fixture('table-off.md') });
  const result = await w.store.upgradeLegacy();
  eq(result.skipped, ['Bad']);
  assert.ok(w.v.files[`${FOLDER}/Bad.md`]);
  assert.equal(w.settings.noteStyleAliases['style:Bad'], undefined);
  eq(w.events, [{ kind: 'skipped', names: ['Bad'] }]);
  assert.equal(Object.keys(inDir(w.v, dirs('en').backup)).length, 1);
});

test('counter 18 (P2): the parser skips old switches and callout keys; the upgrade still skips a file whose switches the old parser refused', async () => {
  // the parser reads the sections of a file with a bad value; the frozen reader refuses it, so the file is skipped as before
  const text = '---\n圖表: maybe\n---\n## A\nx\n';
  assert.equal(M.parseNoteStyleFile(text, { id: 'style:Bad', name: 'Bad' }).ok, true);
  assert.equal(M.readLegacyFormatPreferences(text), undefined);
  const w = world({ language: 'en' }, { 'Bad.md': text, 'S.md': fixture('table-off.md') });
  const result = await w.store.upgradeLegacy();
  eq(result.skipped, ['Bad']);
  assert.ok(w.v.files[`${FOLDER}/Bad.md`]);
  assert.equal(w.settings.noteStyleAliases['style:Bad'], undefined);
});

test('the upgrade module does not branch on a language id (language gate)', () => {
  const source = fs.readFileSync(path.join(S.root, 'ai', 'note-style-upgrade.ts'), 'utf8');
  assert.doesNotMatch(source, /["'`](?:zh-TW|zh-CN|en)["'`]/);
  assert.doesNotMatch(source, /startsWith\(["'`]zh/);
});

test('plugin wiring: layout-ready starts the upgrade once, a user without old data gets the marker saved and no vault write', async () => {
  const { default: Plugin } = S.load('main.ts', { obsidian: S.obsidian });
  const writes = [];
  const record = name => (...args) => { writes.push([name, args[0]]); return Promise.resolve(); };
  const vault = {
    adapter: { exists: async () => false, list: async () => ({ files: [], folders: [] }), read: async () => '', write: record('adapter.write'), mkdir: record('adapter.mkdir') },
    getAbstractFileByPath: () => null, getMarkdownFiles: () => [], getFiles: () => [], getAllLoadedFiles: () => [], getRoot: () => ({ children: [] }),
    on: (name, handler) => ({ name, handler }),
    create: record('create'), createFolder: record('createFolder'), modify: record('modify'), process: record('process'), rename: record('rename'), trash: record('trash'), delete: record('delete')
  };
  const bare = new Plugin();
  const plugin = new Proxy(bare, { get: (target, key, receiver) => key in target || typeof key !== 'string' || !/^(register|add)/.test(key) ? Reflect.get(target, key, receiver) : () => ({ setAttribute() {}, addClass() {}, addEventListener() {} }) });
  plugin.manifest = { id: 'visual-agent-map', version: '0.0.0-test', dir: '' };
  plugin.app = { vault, fileManager: { trashFile: record('trashFile'), renameFile: record('renameFile') }, metadataCache: { on: () => ({}), getFileCache: () => null },
    workspace: { onLayoutReady: callback => callback(), on: () => ({}), getLeavesOfType: () => [], getActiveFile: () => null, getActiveViewOfType: () => null, layoutReady: true }, loadLocalStorage: () => null, saveLocalStorage() {} };
  const saved = [];
  plugin.loadData = async () => ({ migrated: true, structureVersion: 2, workspaceInitialized: true, noteStylesFolder: 'WS/Styles' });
  plugin.saveData = async data => { saved.push(JSON.parse(JSON.stringify(data))); };
  plugin.addCommand = command => command;
  await plugin.onload(); await plugin.ready;
  await plugin.noteStyles.startUpgrade();
  assert.deepEqual(writes, []);
  assert.equal(saved.length, 1);
  eq(saved[0].noteStyleUpgrade, { version: 1 });
  eq(plugin.settings.noteStyleUpgrade, { version: 1 });
});
