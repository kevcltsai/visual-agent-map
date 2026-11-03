// run-style-resolution P1, rewritten for the style model of note-style-recipe T2 (run -> topic -> kind; grilling Q5/Q10/Q12/Q15):
// the single `runStyle` entry of the note style store, tested only through that entry over an in-memory vault. Expected values are literals, fixtures written here, or the spec; never the output of the older
// resolve / toneTextFor methods. Unit level.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadSource } = require('./support-replay.cjs');

const M = loadSource(`
export { NoteStyleStore } from "./ai/note-style-store";
export { normalizeTemplates } from "./ai/detail-templates";
export { lookupBuiltinBlock } from "./core/blocks/builtin";
export { OBSIDIAN_FORMAT, inLanguage } from "./core/steps/_shared/fragments";
`);

const STYLES = 'WS/S';
const TPL = `${STYLES}/Structures`;
const TONE = `${STYLES}/Voices`;
const PRESETS = [{ id: 'custom-tone-1', kind: 'tone', name: 'Pirate', text: 'Talk like a pirate.' }];
const custom = (id, name) => ({ id, name, sections: [{ id: `${id}-s`, name: `${name} section`, description: 'd', role: 'none', aliases: [] }] });
const CUSTOM = () => M.normalizeTemplates([custom('A', 'Template A'), custom('B', 'Template B'), custom('C', 'Template C')]);
const RECIPES = `${STYLES}/Styles`;
const plain = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

/** An in-memory vault that records every write, so a test can say the resolution wrote nothing. */
function vault(files = {}) {
  const state = { files: { ...files }, folders: new Set(), writes: [] };
  const under = folder => Object.keys(state.files).filter(file => file.startsWith(`${folder}/`) && !file.slice(folder.length + 1).includes('/'));
  state.port = {
    list: async folder => under(folder).map(file => file.slice(folder.length + 1)).filter(name => name.endsWith('.md')),
    read: async file => { if (!(file in state.files)) throw new Error(file); return state.files[file]; },
    folderExists: folder => state.folders.has(folder) || Object.keys(state.files).some(file => file.startsWith(`${folder}/`)),
    createFolder: async folder => { state.writes.push(`folder ${folder}`); },
    create: async file => { state.writes.push(`create ${file}`); },
    trash: async file => { state.writes.push(`trash ${file}`); }
  };
  return state;
}
async function world(settingsPatch = {}, files = {}) {
  const v = vault(files);
  const settings = { detailTemplates: [], promptPresets: PRESETS, workspaceFolder: 'WS', noteStylesFolder: STYLES, language: 'en', ...settingsPatch };
  const counter = { saves: 0 };
  const store = new M.NoteStyleStore({ settings: () => settings, port: v.port, save: async () => { counter.saves++; } });
  await store.refresh();
  return { store, v, settings, counter };
}
const headingOf = template => template.sections[0].name;

/** A style file "Mix" (the style of general research) that names a structure and a voice by name. */
const mix = (structure, voice) => ({ [`${RECIPES}/Mix.md`]: `---\n${structure ? `structure: ${structure}\n` : ''}${voice ? `voice: ${voice}\n` : ''}---\n` });
const MIX_KIND = { noteStyleByKind: { topic: 'file:Mix' } };

test('slice 1 (tracer): an empty store with no levels gives general research: Standard, no tone, no fields, no issues, and the built-in names', async () => {
  const { store } = await world();
  const got = store.runStyle({ outputLanguage: 'en' });
  assert.equal(got.template.id, 'standard');
  assert.equal(headingOf(got.template), 'Core conclusions');
  assert.equal(got.toneText, undefined);
  assert.equal(got.formatText, M.inLanguage(M.OBSIDIAN_FORMAT, 'en'));
  assert.equal(got.updateMode, 'merge');
  assert.deepEqual(plain(got.contextFields), {});
  assert.deepEqual(plain(got.issues), { missing: [], blockIssues: [], notices: [] });
  assert.deepEqual(plain(got.recipe), { ref: 'builtin:general', name: 'General research', source: 'kind' });
  assert.deepEqual(plain(got.label), { templateName: 'Standard six', templateSource: 'kind', toneName: 'Academic rigor', styleName: 'General research' });
});

test('slice 2 (was: choice, topic, map, workspace default; grilling Q10/Q15): the structure comes from the run, then the topic, then the kind; the map and the workspace default are not levels', async () => {
  const { store } = await world({ detailTemplates: CUSTOM(), defaultDetailTemplateId: 'textbook', noteStyleByKind: { topic: 'builtin:atomic' } });
  const ask = request => store.runStyle({ outputLanguage: 'en', ...request });
  const names = got => [got.template.id, got.label.templateName, got.label.templateSource];
  assert.deepEqual(names(ask({})), ['atomic', 'Definition & example', 'kind']);
  assert.deepEqual(names(ask({ map: { template: 'A' } })), ['atomic', 'Definition & example', 'kind']);
  assert.deepEqual(names(ask({ topic: { template: 'B' }, map: { template: 'A' } })), ['B', 'Template B', 'topic']);
  assert.deepEqual(names(ask({ choice: { template: 'C' }, topic: { template: 'B' }, map: { template: 'A' } })), ['C', 'Template C', 'run']);
  assert.deepEqual(names(ask({ choice: { template: 'standard' }, topic: { template: 'B' } })), ['standard', 'Standard six', 'run']);
});

const TONE_FILES = {
  [`${TONE}/Pirate.md`]: 'Talk like a pirate.',
  [`${TONE}/Poet.md`]: 'Write as a poet.',
  [`${TONE}/Clerk.md`]: 'Write as a dry clerk.'
};

test('slice 3 (was: the tone chain choice, topic, map; grilling Q10/Q15): the voice comes from the run, then the topic; academic is no text; an unknown id is skipped; the map is no level', async () => {
  const { store } = await world({}, TONE_FILES);
  const ask = request => store.runStyle({ outputLanguage: 'en', ...request });
  const tone = got => [got.toneText, got.label.toneName];
  assert.deepEqual(tone(ask({ choice: { tone: 'file:Pirate' }, topic: { tone: 'plain' } })), ['Talk like a pirate.', 'Pirate']);
  assert.deepEqual(tone(ask({ choice: { tone: 'file:Poet' } })), ['Write as a poet.', 'Poet']);
  assert.deepEqual(tone(ask({ topic: { tone: 'custom-tone-1' }, map: { tone: 'file:Clerk' } })), ['Talk like a pirate.', 'Pirate']);
  assert.deepEqual(tone(ask({ map: { tone: 'file:Clerk' } })), [undefined, 'Academic rigor'], 'the map is no level');
  assert.deepEqual(tone(ask({ topic: { tone: 'plain' }, choice: { tone: 'academic' } })), [undefined, 'Academic rigor'], 'academic named by the run beats the topic');
  assert.deepEqual(tone(ask({ topic: { tone: 'plain' }, choice: { tone: 'gone' } })), [M.lookupBuiltinBlock('tone', 'plain', 'en'), 'Plain explanation'], 'a run tone that does not exist leaves the lower level');
  assert.deepEqual(tone(ask({ topic: { tone: 'gone' } })), [undefined, 'Academic rigor']);
});

test('slice 4 (was: the workspace tone block fills in; grilling Q10): the kind style\'s voice is the voice and its name is the shown name; a topic tone or a run tone replaces it; the workspace tone key is not read', async () => {
  const { store } = await world({ ...MIX_KIND, noteToneBlock: 'file:Clerk' }, { ...TONE_FILES, ...mix('Standard six', 'Pirate') });
  const ask = request => store.runStyle({ outputLanguage: 'en', ...request });
  const tone = got => [got.toneText, got.label.toneName];
  assert.deepEqual(tone(ask({})), ['Talk like a pirate.', 'Pirate']);
  assert.deepEqual(tone(ask({ topic: {}, map: {} })), ['Talk like a pirate.', 'Pirate']);
  assert.deepEqual(tone(ask({ choice: { tone: 'file:Poet' } })), ['Write as a poet.', 'Poet']);
  assert.deepEqual(tone(ask({ choice: { tone: 'academic' } })), [undefined, 'Academic rigor'], 'academic named by the run beats the style\'s voice');
  assert.equal(ask({}).label.styleName, 'Mix', 'the style is shown by its name');
});

test('slice 5 (was: a style file brings its own tone; grilling Q12): a style file brings its own voice; a run tone replaces it, the topic\'s old structure makes a style of its own', async () => {
  const { store } = await world(MIX_KIND, { ...TONE_FILES, ...mix('Intro + six', 'Pirate') });
  const ask = request => store.runStyle({ outputLanguage: 'en', ...request });
  const tone = got => [got.template.id, got.toneText, got.label.toneName];
  assert.deepEqual(tone(ask({})), ['textbook', 'Talk like a pirate.', 'Pirate']);
  assert.deepEqual(tone(ask({ choice: { tone: 'file:Poet' } })), ['textbook', 'Write as a poet.', 'Poet'], 'the run names a tone');
  assert.deepEqual(tone(ask({ topic: { template: 'standard' } })), ['standard', undefined, 'Academic rigor'], 'an old topic structure is a style of its own: the voice is the kind default');
  assert.deepEqual(tone(ask({ topic: { template: 'standard' }, map: { tone: 'file:Poet' } })), ['standard', undefined, 'Academic rigor']);
  assert.equal(ask({}).label.styleName, 'Mix');
  assert.equal(ask({}).label.fileName, 'Mix.md');
});

test('slice 5b (was: an old style file with "語氣: 簡明"; grilling Q12): an old style file in the style folder is no style: its id is reported missing and Standard is used', async () => {
  const { store } = await world({}, { [`${STYLES}/Own.md`]: '---\n語氣: 簡明\n---\n## 重點\n說明\n' });
  const got = store.runStyle({ outputLanguage: 'en', topic: { template: 'style:Own' } });
  assert.equal(got.toneText, undefined);
  assert.equal(got.template.id, 'standard');
  assert.deepEqual(plain(got.issues.missing), ['style:Own']);
  assert.equal(got.label.fileName, undefined);
  assert.equal(got.issues.invalid, undefined);
});

// A count line that is not a number: the sections parser reports it. A second format rules heading is no problem any more (Q1).
const BROKEN = '## A\nCount: x\nbody\n';
const MINE = '## Alpha\nDescribe alpha.\n\n## Beta\nDescribe beta.\n';

test('slice 6 (was: an unreadable workspace template block; grilling Q10): a structure file that cannot be read gives the built-in template in the output language, the file and the reasons; nothing throws or is written', async () => {
  const { store, v, counter } = await world(MIX_KIND, { ...TONE_FILES, ...mix('Bad', 'Pirate'), [`${TPL}/Bad.md`]: BROKEN });
  let got;
  assert.doesNotThrow(() => { got = store.runStyle({ outputLanguage: 'zh-TW' }); });
  assert.equal(got.template.id, 'standard');
  assert.equal(headingOf(got.template), '核心結論', 'the stand-in follows the output language');
  assert.equal(got.contextFields.styleSelection.template.id, 'file:Bad');
  assert.equal(got.contextFields.styleSelection.template.body, BROKEN);
  assert.equal(got.contextFields.styleSelection.template.fileName, 'Bad.md');
  assert.equal(got.contextFields.styleSelection.tone.body, 'Talk like a pirate.', 'the tone choice rides with the block');
  const first = got.issues.blockIssues[0];
  assert.equal(first.fileName, 'Bad.md');
  assert.ok(first.line >= 1);
  assert.equal(typeof first.code, 'string');
  assert.deepEqual(v.writes, []);
  assert.equal(counter.saves, 0);
});

test('slice 6b (was: a changed built-in block that cannot be read; decision #22): a file named like a built-in is not read, so the built-in stands without issues; a readable own file is used as written', async () => {
  const changed = await world({ noteStyleByKind: { topic: 'builtin:textbook' } }, { [`${TPL}/Intro + six.md`]: BROKEN });
  const got = changed.store.runStyle({ outputLanguage: 'en' });
  assert.equal(got.template.id, 'textbook');
  assert.equal(got.contextFields.styleSelection, undefined);
  assert.deepEqual(plain(got.issues.blockIssues), []);
  const own = await world(MIX_KIND, { ...mix('Mine'), [`${TPL}/Mine.md`]: MINE });
  const ok = own.store.runStyle({ outputLanguage: 'en' });
  assert.equal(ok.template.id, 'file:Mine');
  assert.deepEqual(plain(ok.template.sections.map(section => section.name)), ['Alpha', 'Beta']);
  assert.deepEqual(plain(ok.issues), { missing: [], blockIssues: [], notices: [] });
  assert.equal(ok.contextFields.styleSelection.template.body, MINE);
});

test('slice 7 (was: an old style file that does not parse is invalid; grilling Q12): a style file with a line that cannot be read keeps the style, reports the line, and nothing throws', async () => {
  const { store, v } = await world(MIX_KIND, { [`${RECIPES}/Mix.md`]: '---\nstructure: Standard six\nupdate: whenever\n---\n' });
  let got;
  assert.doesNotThrow(() => { got = store.runStyle({ outputLanguage: 'en' }); });
  assert.equal(got.issues.invalid, undefined, 'no run is stopped any more');
  assert.equal(got.updateMode, 'merge');
  assert.equal(got.issues.blockIssues[0].fileName, 'Mix.md');
  assert.equal(got.issues.blockIssues[0].line, 3);
  assert.deepEqual(v.writes, []);
});

test('slice 8 (was: ids that are gone, most specific first; grilling Q10/Q15): refs that are gone are listed most specific first and the next level that works is used; nothing is written back', async () => {
  const { store, v, counter } = await world({ detailTemplates: CUSTOM(), defaultDetailTemplateId: 'textbook', noteStyleByKind: { topic: 'file:Nope' } });
  const all = store.runStyle({ outputLanguage: 'en', choice: { style: 'file:Gone' }, topic: { style: 'builtin:nope', template: 'gone-id' }, map: { template: 'file:Gone2' } });
  assert.deepEqual(plain(all.issues.missing), ['file:Gone', 'builtin:nope', 'gone-id'], 'the kind ref is not asked once the topic reads');
  assert.equal(all.template.id, 'standard', 'an unknown old id is Standard');
  assert.equal(all.recipe.source, 'topic');
  const some = store.runStyle({ outputLanguage: 'en', choice: { template: 'style:Gone' }, topic: { template: 'A' } });
  assert.deepEqual(plain(some.issues.missing), ['style:Gone']);
  assert.equal(some.template.id, 'A');
  const kind = store.runStyle({ outputLanguage: 'en' });
  assert.deepEqual(plain(kind.issues.missing), ['file:Nope']);
  assert.equal(kind.recipe.ref, 'builtin:general');
  assert.deepEqual(v.writes, []);
  assert.equal(counter.saves, 0);
});

test('slice 9: the template follows the output language and the names follow the interface language', async () => {
  for (const [ui, expected, style] of [['zh-TW', '標準六段', '一般研究'], ['zh-CN', '标准六段', '一般研究']]) {
    const { store } = await world({ language: ui });
    const got = store.runStyle({ outputLanguage: 'en' });
    assert.equal(headingOf(got.template), 'Core conclusions', ui);
    assert.equal(got.label.templateName, expected, ui);
    assert.equal(got.label.styleName, style, ui);
  }
  const { store } = await world({ language: 'en' });
  assert.equal(headingOf(store.runStyle({ outputLanguage: 'zh-TW' }).template), '核心結論');
  // a Simplified Chinese output keeps the Traditional headings (the note language), while the template name is shown in the interface language
  assert.equal(headingOf(store.runStyle({ outputLanguage: 'zh-CN' }).template), '核心結論');
  assert.equal(store.runStyle({ outputLanguage: 'zh-TW' }).label.templateName, 'Standard six');
  const zh = await world({ language: 'zh-TW' });
  assert.equal(zh.store.runStyle({ outputLanguage: 'en' }).label.toneName, '學術嚴謹');
});

// The tone names a run can show, each with the text that tone really is (written here from the fixtures, not read from the store).
const TEXT_OF_NAME = {
  'Academic rigor': undefined,
  Pirate: 'Talk like a pirate.',
  Poet: 'Write as a poet.',
  Clerk: 'Write as a dry clerk.',
  'Plain explanation': () => M.lookupBuiltinBlock('tone', 'plain', 'en'),
  'Magazine column': () => M.lookupBuiltinBlock('tone', 'magazine', 'en')
};
const textOfName = name => { const text = TEXT_OF_NAME[name]; return typeof text === 'function' ? text() : text; };

test('slice 10: in every case the tone name shown is the tone whose text is sent; the style names match the known literals', async () => {
  const rows = [
    { name: 'empty', request: {}, style: 'General research', tone: 'Academic rigor' },
    { name: 'tone on the run', request: { choice: { tone: 'file:Pirate' }, topic: { tone: 'plain' } }, files: TONE_FILES, tone: 'Pirate' },
    { name: 'tone on the topic', request: { topic: { tone: 'custom-tone-1' }, map: { tone: 'file:Clerk' } }, files: TONE_FILES, tone: 'Pirate' },
    { name: 'unknown topic tone', request: { topic: { tone: 'gone' } }, files: TONE_FILES, tone: 'Academic rigor' },
    { name: 'academic stops it', request: { topic: { tone: 'plain' }, choice: { tone: 'academic' } }, files: TONE_FILES, tone: 'Academic rigor' },
    { name: 'style voice', settings: MIX_KIND, request: {}, files: { ...TONE_FILES, ...mix('Standard six', 'Pirate') }, tone: 'Pirate', style: 'Mix' },
    { name: 'style voice beaten by the run', settings: MIX_KIND, request: { choice: { tone: 'file:Clerk' } }, files: { ...TONE_FILES, ...mix('Standard six', 'Pirate') }, tone: 'Clerk', style: 'Mix' },
    { name: 'unreadable structure with a voice', settings: MIX_KIND, request: {}, files: { ...TONE_FILES, ...mix('Bad', 'Pirate'), [`${TPL}/Bad.md`]: BROKEN }, tone: 'Pirate' },
    { name: 'missing template', settings: { detailTemplates: CUSTOM() }, request: { topic: { template: 'gone-id', tone: 'plain' } }, tone: 'Plain explanation', style: 'Old setting (Standard six · Plain explanation)' },
    // literal names from the dialog
    { name: 'Textbook', request: { topic: { template: 'textbook' } }, style: 'Old setting (Intro + six · Academic rigor)' },
    { name: 'Plain language', request: { topic: { template: 'standard', tone: 'plain' } }, style: 'Old setting (Standard six · Plain explanation)', tone: 'Plain explanation' },
    { name: 'Custom A', settings: { detailTemplates: CUSTOM() }, request: { topic: { template: 'A', tone: 'magazine' } }, style: 'Old setting (Template A · Magazine column)', tone: 'Magazine column' },
    { name: 'builtin Textbook style', settings: { noteStyleByKind: { topic: 'builtin:textbook' } }, request: {}, style: 'Textbook', tone: 'Academic rigor' }
  ];
  for (const row of rows) {
    const { store } = await world(row.settings ?? {}, row.files ?? {});
    const got = store.runStyle({ outputLanguage: 'en', ...row.request });
    assert.equal(got.toneText, textOfName(got.label.toneName), `${row.name}: the shown tone name is the tone whose text is sent`);
    if (row.tone) assert.equal(got.label.toneName, row.tone, row.name);
    if (row.style) assert.equal(got.label.styleName, row.style, row.name);
  }
});

test('slice 11: the result is a frozen value; the same input twice is equal; a later call never changes an earlier result; nothing is written', async () => {
  const { store, v, counter, settings } = await world(MIX_KIND, { ...TONE_FILES, ...mix('Mine', 'Pirate'), [`${TPL}/Mine.md`]: MINE });
  const first = store.runStyle({ outputLanguage: 'en' });
  const again = store.runStyle({ outputLanguage: 'en' });
  assert.notEqual(first, again, 'a new object per call');
  assert.deepEqual(plain(first), plain(again));
  for (const frozen of [first, first.recipe, first.label, first.issues, first.issues.missing, first.issues.blockIssues, first.issues.notices, first.contextFields, first.contextFields.styleSelection])
    assert.ok(Object.isFrozen(frozen));
  assert.throws(() => { 'use strict'; first.label.toneName = 'x'; }, TypeError);
  // style A, then the style file changes to B: the earlier result keeps A
  const snapshot = plain(first.contextFields);
  v.files[`${RECIPES}/Mix.md`] = '---\nstructure: Other\n---\n';
  v.files[`${TPL}/Other.md`] = '## Gamma\nDescribe gamma.\n';
  await store.refresh();
  const second = store.runStyle({ outputLanguage: 'en' });
  assert.equal(second.contextFields.styleSelection.template.id, 'file:Other');
  assert.deepEqual(plain(first.contextFields), snapshot);
  assert.equal(first.contextFields.styleSelection.template.id, 'file:Mine');
  assert.equal(settings.noteStyleByKind.topic, 'file:Mix');
  assert.deepEqual(v.writes, []);
  assert.equal(counter.saves, 0);
});

test('slice 12 (was: the run tone takes no part in finding the template; grilling Q10): the run\'s own tone changes only the voice, never the structure', async () => {
  const free = await world({}, TONE_FILES);
  const got = free.store.runStyle({ outputLanguage: 'en', choice: { tone: 'file:Pirate' }, topic: { template: 'textbook' } });
  assert.equal(got.template.id, 'textbook');
  assert.equal(got.toneText, 'Talk like a pirate.');
  assert.equal(got.label.toneName, 'Pirate');
  assert.equal(got.recipe.source, 'run');
  const without = free.store.runStyle({ outputLanguage: 'en', topic: { template: 'textbook' } });
  assert.equal(without.template.id, 'textbook');
  assert.equal(without.recipe.source, 'topic');
});

test('toneOnly and map (was: a proposal run takes no tone from the workspace default; grilling Q10/Q15): neither the map nor toneOnly changes anything, and the workspace default styles are not read', async () => {
  const w = await world({ defaultNoteStyleId: 'style:Own', noteToneBlock: 'file:Clerk', noteStyleAliases: { 'style:S': { template: 'file:S', tone: 'file:Pirate' } } }, { ...TONE_FILES, [`${STYLES}/Own.md`]: '---\n語氣: 簡明\n---\n## 重點\n說明\n' });
  const plainRun = w.store.runStyle({ outputLanguage: 'en' });
  for (const extra of [{ toneOnly: true }, { map: { tone: 'file:Poet', template: 'style:S' } }, { toneOnly: true, map: { tone: 'file:Poet' }, topic: {} }])
    assert.deepEqual(plain(w.store.runStyle({ outputLanguage: 'en', ...extra })), plain(plainRun), JSON.stringify(extra));
  assert.equal(plainRun.toneText, undefined);
  assert.equal(w.store.runStyle({ outputLanguage: 'en', toneOnly: true, topic: { tone: 'custom-tone-1' } }).toneText, 'Talk like a pirate.', 'the topic tone still applies');
});

test('P3 (was: the style name of a template and tone pair is the preset name or "Custom: template · tone"; grilling Q10): the style name is the style\'s own name, or "Old setting (structure · voice)" for an old topic', async () => {
  const { store } = await world({ detailTemplates: CUSTOM() });
  const name = (template, tone) => store.runStyle({ outputLanguage: 'en', topic: { template, tone } }).label.styleName;
  assert.equal(name('standard', 'academic'), 'Old setting (Standard six · Academic rigor)');
  assert.equal(name('textbook', 'academic'), 'Old setting (Intro + six · Academic rigor)');
  assert.equal(name('A', 'magazine'), 'Old setting (Template A · Magazine column)');
  assert.equal(name('textbook', 'plain'), 'Old setting (Intro + six · Plain explanation)');
  assert.equal(store.runStyle({ outputLanguage: 'en', topic: { template: 'A' } }).recipe.implicit, true);
  assert.equal(store.runStyle({ outputLanguage: 'en' }).label.styleName, 'General research');
});

test('R1-L1 (T6 P3): a topic tone that cannot be read is reported missing and the voice is academic rigor; nothing is written; a readable tone or a topic without tone reports nothing', async () => {
  const { store, v, counter } = await world();
  const gone = store.runStyle({ topic: { tone: 'gone' }, kind: 'topic', outputLanguage: 'en' });
  assert.deepEqual(plain(gone.issues.missing), ['gone']);
  assert.equal(gone.toneText, undefined, 'academic rigor adds no tone text');
  assert.equal(gone.label.toneName, store.runStyle({ outputLanguage: 'en' }).label.toneName);
  const both = store.runStyle({ topic: { template: 'gone-id', tone: 'gone' }, kind: 'topic', outputLanguage: 'en' });
  assert.deepEqual(plain(both.issues.missing), ['gone-id', 'gone'], 'structure first, then voice, each once');
  assert.deepEqual(plain(store.runStyle({ topic: { tone: 'plain' }, kind: 'topic', outputLanguage: 'en' }).issues.missing), []);
  assert.deepEqual(plain(store.runStyle({ topic: {}, kind: 'topic', outputLanguage: 'en' }).issues.missing), []);
  // A topic style that reads makes the implicit tone moot: it is not asked, so it is not reported.
  assert.deepEqual(plain(store.runStyle({ topic: { style: 'builtin:textbook', tone: 'gone' }, kind: 'topic', outputLanguage: 'en' }).issues.missing), []);
  assert.deepEqual(v.writes, []); assert.equal(counter.saves, 0);
});
