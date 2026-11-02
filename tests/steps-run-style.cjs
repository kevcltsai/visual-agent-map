// run-style-resolution P1: the single `runStyle` entry of the note style store, tested only through that entry over an
// in-memory vault. Expected values are literals, fixtures written here, or the spec; never the output of the older
// resolve / toneTextFor methods. Unit level.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadSource } = require('./support-replay.cjs');

const M = loadSource(`
export { NoteStyleStore } from "./ai/note-style-store";
export { normalizeTemplates } from "./ai/detail-templates";
export { lookupBuiltinBlock } from "./core/blocks/builtin";
`);

const STYLES = 'WS/S';
const TPL = `${STYLES}/Blocks/Templates`;
const TONE = `${STYLES}/Blocks/Tones`;
const PRESETS = [{ id: 'custom-tone-1', kind: 'tone', name: 'Pirate', text: 'Talk like a pirate.' }];
const custom = (id, name) => ({ id, name, sections: [{ id: `${id}-s`, name: `${name} section`, description: 'd', role: 'none', aliases: [] }] });
const CUSTOM = () => M.normalizeTemplates([custom('A', 'Template A'), custom('B', 'Template B'), custom('C', 'Template C')]);
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

test('slice 1 (tracer): an empty store with no levels gives Standard, no tone, no fields, no issues, and the Standard names', async () => {
  const { store } = await world();
  const got = store.runStyle({ outputLanguage: 'en' });
  assert.equal(got.template.id, 'standard');
  assert.equal(headingOf(got.template), 'Core conclusions');
  assert.equal(got.toneText, undefined);
  assert.deepEqual(plain(got.contextFields), {});
  assert.deepEqual(plain(got.issues), { missing: [], blockIssues: [] });
  assert.deepEqual(plain(got.label), { templateName: 'Standard', templateSource: 'standard', toneName: 'Academic rigor', styleName: 'Standard', styleRef: { kind: 'builtin', id: 'standard' } });
});

test('slice 2: the template comes from the choice, then the topic, then the map, then the workspace default', async () => {
  const { store } = await world({ detailTemplates: CUSTOM(), defaultDetailTemplateId: 'textbook' });
  const ask = request => store.runStyle({ outputLanguage: 'en', ...request });
  const names = got => [got.template.id, got.label.templateName];
  assert.deepEqual(names(ask({})), ['textbook', 'Textbook']);
  assert.deepEqual(names(ask({ map: { template: 'A' } })), ['A', 'Template A']);
  assert.deepEqual(names(ask({ topic: { template: 'B' }, map: { template: 'A' } })), ['B', 'Template B']);
  assert.deepEqual(names(ask({ choice: { template: 'C' }, topic: { template: 'B' }, map: { template: 'A' } })), ['C', 'Template C']);
  assert.deepEqual(names(ask({ choice: { template: 'standard' }, topic: { template: 'B' } })), ['standard', 'Standard']);
});

const TONE_FILES = {
  [`${TONE}/Pirate.md`]: 'Talk like a pirate.',
  [`${TONE}/Poet.md`]: 'Write as a poet.',
  [`${TONE}/Clerk.md`]: 'Write as a dry clerk.'
};

test('slice 3: the writing tone comes from the choice, then the topic, then the map; academic is no text; an unknown id is skipped', async () => {
  const { store } = await world({}, TONE_FILES);
  const ask = request => store.runStyle({ outputLanguage: 'en', ...request });
  const tone = got => [got.toneText, got.label.toneName];
  assert.deepEqual(tone(ask({ choice: { tone: 'file:Pirate' }, topic: { tone: 'file:Poet' }, map: { tone: 'file:Clerk' } })), ['Talk like a pirate.', 'Pirate']);
  assert.deepEqual(tone(ask({ topic: { tone: 'file:Poet' }, map: { tone: 'file:Clerk' } })), ['Write as a poet.', 'Poet']);
  assert.deepEqual(tone(ask({ map: { tone: 'file:Clerk' } })), ['Write as a dry clerk.', 'Clerk']);
  assert.deepEqual(tone(ask({ topic: { tone: 'academic' }, map: { tone: 'file:Clerk' } })), [undefined, 'Academic rigor'], 'academic named by the topic stops the chain');
  assert.deepEqual(tone(ask({ topic: { tone: 'gone' }, map: { tone: 'file:Clerk' } })), ['Write as a dry clerk.', 'Clerk'], 'a topic tone that does not exist falls to the map');
  assert.deepEqual(tone(ask({ topic: { tone: 'gone' } })), [undefined, 'Academic rigor']);
});

test('slice 4: the workspace tone block fills in when no level names a tone, and its name is the shown name; any level that names a tone wins', async () => {
  const { store } = await world({ noteToneBlock: 'file:Pirate' }, TONE_FILES);
  const ask = request => store.runStyle({ outputLanguage: 'en', ...request });
  const tone = got => [got.toneText, got.label.toneName];
  assert.deepEqual(tone(ask({})), ['Talk like a pirate.', 'Pirate']);
  assert.deepEqual(tone(ask({ topic: {}, map: {} })), ['Talk like a pirate.', 'Pirate']);
  assert.deepEqual(tone(ask({ map: { tone: 'file:Clerk' } })), ['Write as a dry clerk.', 'Clerk']);
  assert.deepEqual(tone(ask({ topic: { tone: 'file:Poet' }, map: { tone: 'file:Clerk' } })), ['Write as a poet.', 'Poet']);
  assert.deepEqual(tone(ask({ choice: { tone: 'academic' } })), [undefined, 'Academic rigor'], 'academic named by the run beats the workspace tone');
  // the style name follows the tone that is really used: a template with the Pirate tone is a custom pair
  assert.equal(ask({}).label.styleName, 'Custom: Standard · Pirate');
});

// The state after the one-time upgrade: style file "S" became the template block file:S, and its alias carries the tone Pirate.
const UPGRADED = {
  noteStyleUpgrade: { version: 1 },
  noteStyleAliases: { 'style:S': { template: 'file:S', tone: 'file:Pirate' } }
};
const UPGRADED_FILES = { ...TONE_FILES, [`${TPL}/S.md`]: '## Alpha\nDescribe alpha.\n' };
const OWN_OLD = '---\n語氣: 簡明\n---\n## 重點\n說明\n';

test('slice 5: a style file brings its own tone; the same or a more specific level wins over it, the map does not; the name follows', async () => {
  const { store } = await world(UPGRADED, UPGRADED_FILES);
  const ask = request => store.runStyle({ outputLanguage: 'en', ...request });
  const tone = got => [got.template.id, got.toneText, got.label.toneName];
  assert.deepEqual(tone(ask({ topic: { template: 'style:S' } })), ['file:S', 'Talk like a pirate.', 'Pirate']);
  assert.deepEqual(tone(ask({ topic: { template: 'style:S', tone: 'file:Poet' } })), ['file:S', 'Write as a poet.', 'Poet'], 'the same level names a tone');
  assert.deepEqual(tone(ask({ topic: { tone: 'file:Poet' }, map: { template: 'style:S' } })), ['file:S', 'Write as a poet.', 'Poet'], 'a more specific level names a tone');
  assert.deepEqual(tone(ask({ topic: { template: 'style:S' }, map: { tone: 'file:Poet' } })), ['file:S', 'Talk like a pirate.', 'Pirate'], 'the map is less specific than the topic');
  assert.deepEqual(tone(ask({ topic: { template: 'style:S' }, map: { tone: 'file:Clerk' } })), ['file:S', 'Talk like a pirate.', 'Pirate']);
  assert.equal(ask({ topic: { template: 'style:S' } }).label.styleName, 'S', 'a style or block file is shown by its file name');
});

test('slice 5b: before the upgrade, an old style file with "語氣: 簡明" gives that text as the tone and its text as the name', async () => {
  const { store } = await world({}, { [`${STYLES}/Own.md`]: OWN_OLD });
  const got = store.runStyle({ outputLanguage: 'en', topic: { template: 'style:Own' } });
  assert.equal(got.toneText, '簡明');
  assert.equal(got.label.toneName, '簡明');
  assert.equal(got.label.fileName, 'Own.md');
  assert.equal(got.issues.invalid, undefined);
});

// A count line that is not a number: the sections parser reports it. A second format rules heading is no problem any more (Q1).
const BROKEN = '## A\nCount: x\nbody\n';
const MINE = '## Alpha\nDescribe alpha.\n\n## Beta\nDescribe beta.\n';

test('slice 6: a template block that cannot be read gives the built-in template in the output language, the block and the reasons; nothing throws or is written', async () => {
  const { store, v, counter } = await world({ noteTemplateBlock: 'file:Bad', noteToneBlock: 'file:Pirate' }, { ...TONE_FILES, [`${TPL}/Bad.md`]: BROKEN });
  let got;
  assert.doesNotThrow(() => { got = store.runStyle({ outputLanguage: 'zh-TW' }); });
  assert.equal(got.template.id, 'standard');
  assert.equal(headingOf(got.template), '核心結論', 'the stand-in follows the output language');
  assert.equal(got.label.templateName, 'Standard', 'the run uses the built-in stand-in, so that is the name shown');
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

test('slice 6b: a changed built-in block that cannot be read is stood in for by the same built-in id; a readable own block is used as written', async () => {
  const changed = await world({ noteTemplateBlock: 'builtin:textbook' }, { [`${TPL}/Intro + six.md`]: BROKEN });
  const got = changed.store.runStyle({ outputLanguage: 'en' });
  assert.equal(got.template.id, 'textbook');
  assert.equal(got.contextFields.styleSelection.template.id, 'textbook');
  assert.equal(got.issues.blockIssues.length > 0, true);
  const own = await world({ noteTemplateBlock: 'file:Mine' }, { [`${TPL}/Mine.md`]: MINE });
  const ok = own.store.runStyle({ outputLanguage: 'en' });
  assert.equal(ok.template.id, 'file:Mine');
  assert.deepEqual(plain(ok.template.sections.map(section => section.name)), ['Alpha', 'Beta']);
  assert.deepEqual(plain(ok.issues), { missing: [], blockIssues: [] });
  assert.equal(ok.contextFields.styleSelection.template.body, MINE);
});

test('slice 7: an old style file that does not parse is reported as invalid with file and line, and nothing throws', async () => {
  const { store, v } = await world({}, { [`${STYLES}/Bad.md`]: '---\n語氣: x\n' });
  let got;
  assert.doesNotThrow(() => { got = store.runStyle({ outputLanguage: 'en', topic: { template: 'style:Bad' } }); });
  assert.equal(got.issues.invalid.fileName, 'Bad.md');
  assert.ok(got.issues.invalid.issues[0].line >= 1);
  assert.deepEqual(v.writes, []);
  // a style file that parses has no such report
  const fine = await world({}, { [`${STYLES}/Own.md`]: OWN_OLD });
  assert.equal(fine.store.runStyle({ outputLanguage: 'en', topic: { template: 'style:Own' } }).issues.invalid, undefined);
});

test('slice 8: template ids that are gone are listed most specific first and the next level that exists is used; nothing is written back', async () => {
  const { store, v, counter } = await world({ detailTemplates: CUSTOM(), defaultDetailTemplateId: 'textbook' });
  const both = store.runStyle({ outputLanguage: 'en', topic: { template: 'gone-id' }, map: { template: 'file:Gone' } });
  assert.deepEqual(plain(both.issues.missing), ['gone-id', 'file:Gone']);
  assert.equal(both.template.id, 'textbook', 'the workspace default stands in');
  const some = store.runStyle({ outputLanguage: 'en', choice: { template: 'style:Gone' }, topic: { template: 'gone-id' }, map: { template: 'A' } });
  assert.deepEqual(plain(some.issues.missing), ['style:Gone', 'gone-id']);
  assert.equal(some.template.id, 'A');
  assert.deepEqual(v.writes, []);
  assert.equal(counter.saves, 0);
});

test('slice 9: the template follows the output language and the names follow the interface language', async () => {
  for (const [ui, expected] of [['zh-TW', '標準'], ['zh-CN', '标准']]) {
    const { store } = await world({ language: ui });
    const got = store.runStyle({ outputLanguage: 'en' });
    assert.equal(headingOf(got.template), 'Core conclusions', ui);
    assert.equal(got.label.templateName, expected, ui);
    assert.equal(got.label.styleName, expected, ui);
  }
  const { store } = await world({ language: 'en' });
  assert.equal(headingOf(store.runStyle({ outputLanguage: 'zh-TW' }).template), '核心結論');
  // a Simplified Chinese output keeps the Traditional headings (the note language), while the template name is shown in the interface language
  assert.equal(headingOf(store.runStyle({ outputLanguage: 'zh-CN' }).template), '核心結論');
  assert.equal(store.runStyle({ outputLanguage: 'zh-TW' }).label.templateName, 'Standard');
  const zh = await world({ language: 'zh-TW' });
  assert.equal(zh.store.runStyle({ outputLanguage: 'en' }).label.toneName, '學術嚴謹');
});

// The tone names a run can show, each with the text that tone really is (written here from the fixtures, not read from the store).
const TEXT_OF_NAME = {
  'Academic rigor': undefined,
  Pirate: 'Talk like a pirate.',
  Poet: 'Write as a poet.',
  Clerk: 'Write as a dry clerk.',
  '簡明': '簡明',
  'Plain explanation': () => M.lookupBuiltinBlock('tone', 'plain', 'en'),
  'Magazine column': () => M.lookupBuiltinBlock('tone', 'magazine', 'en')
};
const textOfName = name => { const text = TEXT_OF_NAME[name]; return typeof text === 'function' ? text() : text; };

test('slice 10: in every case the tone name shown is the tone whose text is sent; the style names match the known literals', async () => {
  const rows = [
    { name: 'empty', request: {}, style: 'Standard' },
    { name: 'tone on the choice', request: { choice: { tone: 'file:Pirate' }, topic: { tone: 'file:Poet' } }, files: TONE_FILES, tone: 'Pirate' },
    { name: 'tone on the topic', request: { topic: { tone: 'file:Poet' }, map: { tone: 'file:Clerk' } }, files: TONE_FILES, tone: 'Poet' },
    { name: 'unknown topic tone, map tone', request: { topic: { tone: 'gone' }, map: { tone: 'file:Clerk' } }, files: TONE_FILES, tone: 'Clerk' },
    { name: 'academic stops the chain', request: { topic: { tone: 'academic' }, map: { tone: 'file:Clerk' } }, files: TONE_FILES, tone: 'Academic rigor' },
    { name: 'workspace tone', settings: { noteToneBlock: 'file:Pirate' }, request: {}, files: TONE_FILES, tone: 'Pirate' },
    { name: 'workspace tone beaten by the map', settings: { noteToneBlock: 'file:Pirate' }, request: { map: { tone: 'file:Clerk' } }, files: TONE_FILES, tone: 'Clerk' },
    { name: 'style file tone', settings: UPGRADED, request: { topic: { template: 'style:S' } }, files: UPGRADED_FILES, tone: 'Pirate', style: 'S' },
    { name: 'style file, topic tone', settings: UPGRADED, request: { topic: { template: 'style:S', tone: 'file:Poet' } }, files: UPGRADED_FILES, tone: 'Poet', style: 'S' },
    { name: 'style file, map tone ignored', settings: UPGRADED, request: { topic: { template: 'style:S' }, map: { tone: 'file:Clerk' } }, files: UPGRADED_FILES, tone: 'Pirate', style: 'S' },
    { name: 'old style file with free text', request: { topic: { template: 'style:Own' } }, files: { [`${STYLES}/Own.md`]: OWN_OLD }, tone: '簡明', style: 'Own' },
    { name: 'unreadable block with a tone', settings: { noteTemplateBlock: 'file:Bad', noteToneBlock: 'file:Pirate' }, request: {}, files: { ...TONE_FILES, [`${TPL}/Bad.md`]: BROKEN }, tone: 'Pirate' },
    { name: 'missing template', settings: { defaultDetailTemplateId: 'textbook' }, request: { topic: { template: 'gone-id', tone: 'file:Poet' }, map: { template: 'file:Gone' } }, files: TONE_FILES, tone: 'Poet', style: 'Custom: Textbook · Poet' },
    // literal names from the dialog
    { name: 'Textbook', request: { topic: { template: 'textbook' } }, style: 'Textbook' },
    { name: 'Plain language', request: { topic: { template: 'standard', tone: 'plain' } }, style: 'Plain language', tone: 'Plain explanation' },
    { name: 'Custom A', settings: { detailTemplates: CUSTOM() }, request: { topic: { template: 'A', tone: 'magazine' } }, style: 'Custom: Template A · Magazine column', tone: 'Magazine column' },
    { name: 'Custom Textbook', request: { topic: { template: 'textbook', tone: 'plain' } }, style: 'Custom: Textbook · Plain explanation', tone: 'Plain explanation' }
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
  const { store, v, counter, settings } = await world({ noteTemplateBlock: 'file:Mine', noteToneBlock: 'file:Pirate' }, { ...TONE_FILES, [`${TPL}/Mine.md`]: MINE });
  const first = store.runStyle({ outputLanguage: 'en' });
  const again = store.runStyle({ outputLanguage: 'en' });
  assert.notEqual(first, again, 'a new object per call');
  assert.deepEqual(plain(first), plain(again));
  for (const frozen of [first, first.label, first.issues, first.issues.missing, first.issues.blockIssues, first.contextFields, first.contextFields.styleSelection])
    assert.ok(Object.isFrozen(frozen));
  assert.throws(() => { 'use strict'; first.label.toneName = 'x'; }, TypeError);
  // block A, then the workspace changes to block B: the earlier result keeps A
  const snapshot = plain(first.contextFields);
  settings.noteTemplateBlock = 'file:Other';
  v.files[`${TPL}/Other.md`] = '## Gamma\nDescribe gamma.\n';
  await store.refresh();
  const second = store.runStyle({ outputLanguage: 'en' });
  assert.equal(second.contextFields.styleSelection.template.id, 'file:Other');
  assert.deepEqual(plain(first.contextFields), snapshot);
  assert.equal(first.contextFields.styleSelection.template.id, 'file:Mine');
  assert.deepEqual(v.writes, []);
  assert.equal(counter.saves, 0);
});

// Slice 12. Values worked out by hand from the code of fba004b (the view's map-only template lookup and its tone lookup), not from runStyle:
//  - the run's own tone is not in the tone chain that finds the template (resolve got `{ template: chosenId }` for the run level);
//    so with the alias pair:standard -> file:S (no tone) the map-only run `standard` is file:S with or without the run tone;
//  - that alias decides its tone together with the template (toneDecided), and toneTextFor then returns the alias's tone,
//    here none, whatever tone the run chose; so toneText is undefined and the name is Academic rigor in both cases;
//  - with no alias deciding, the run's tone is simply the first tone of the chain: Pirate.
test('slice 12: the run\'s own tone takes no part in finding the template; it only picks the tone text when the template does not decide it', async () => {
  const pair = await world({ noteStyleUpgrade: { version: 1 }, noteStyleAliases: { 'pair:standard': { template: 'file:S' } } }, UPGRADED_FILES);
  const without = pair.store.runStyle({ outputLanguage: 'en', map: { template: 'standard' } });
  const withTone = pair.store.runStyle({ outputLanguage: 'en', choice: { tone: 'file:Pirate' }, map: { template: 'standard' } });
  assert.equal(without.template.id, 'file:S');
  assert.equal(withTone.template.id, 'file:S', 'the same template with or without the run tone');
  assert.equal(without.toneText, undefined);
  assert.equal(withTone.toneText, undefined, 'the alias decided the tone with the template');
  assert.equal(withTone.label.toneName, 'Academic rigor');
  // no alias: the run's tone is the tone of the run, and the template does not change
  const free = await world({}, TONE_FILES);
  const got = free.store.runStyle({ outputLanguage: 'en', choice: { tone: 'file:Pirate' }, map: { template: 'textbook' } });
  assert.equal(got.template.id, 'textbook');
  assert.equal(got.toneText, 'Talk like a pirate.');
  assert.equal(got.label.toneName, 'Pirate');
});

// decisions 2026-11-02-deepen-modules#7: a proposal run (new subtopics, selection synthesis) asks for its tone only. Before this
// change the view's `toneField` never looked at a style file, so the workspace default being an old style file or the alias of
// one gave no tone of its own to a proposal: the tone came from the run, topic and map, else the workspace tone setting.
// Expected values are what `toneField` gave at fba004b (no template level, so only the tone chain and the workspace tone).
test('toneOnly: a proposal run takes no tone from the workspace default style file or pair alias, only from the tone chain and the workspace tone', async () => {
  const oldFile = await world({ defaultNoteStyleId: 'style:Own' }, { ...TONE_FILES, [`${STYLES}/Own.md`]: OWN_OLD });
  const proposal = (w, request = {}) => w.store.runStyle({ outputLanguage: 'en', toneOnly: true, ...request });
  assert.equal(proposal(oldFile).toneText, undefined, 'the style file\'s tone does not reach a proposal');
  assert.equal(proposal(oldFile).label.toneName, 'Academic rigor');
  assert.equal(proposal(oldFile, { map: { tone: 'file:Poet' } }).toneText, 'Write as a poet.');
  assert.equal(proposal(oldFile, { topic: { tone: 'file:Pirate' }, map: { tone: 'file:Poet' } }).toneText, 'Talk like a pirate.');
  assert.equal(proposal(oldFile, { choice: { tone: 'academic' }, map: { tone: 'file:Poet' } }).toneText, undefined);
  const withWorkspaceTone = await world({ defaultNoteStyleId: 'style:Own', noteToneBlock: 'file:Clerk' }, { ...TONE_FILES, [`${STYLES}/Own.md`]: OWN_OLD });
  assert.equal(proposal(withWorkspaceTone).toneText, 'Write as a dry clerk.', 'the workspace tone fills the gap, as before');
  const pair = await world({ ...UPGRADED, defaultNoteStyleId: 'style:S' }, UPGRADED_FILES);
  assert.equal(proposal(pair).toneText, undefined, 'the alias\'s tone does not reach a proposal');
  assert.equal(proposal(pair, { map: { tone: 'file:Clerk' } }).toneText, 'Write as a dry clerk.');
  // the template still resolves, so the answer is a full RunStyle either way
  assert.equal(proposal(pair).template.id, 'file:S');
  // a built-in workspace style brings its tone through the workspace tone, with or without the option
  const builtin = await world({ defaultNoteStyleId: 'summary' });
  assert.equal(proposal(builtin).toneText, M.lookupBuiltinBlock('tone', 'summary', 'en'));
  assert.equal(builtin.store.runStyle({ outputLanguage: 'en' }).toneText, M.lookupBuiltinBlock('tone', 'summary', 'en'));
  // without the option nothing changes: the style file decides its own tone
  assert.equal(oldFile.store.runStyle({ outputLanguage: 'en' }).toneText, '簡明');
  assert.equal(pair.store.runStyle({ outputLanguage: 'en' }).toneText, 'Talk like a pirate.');
});

test('P3: the style name of a template and tone pair is the preset name, else "Custom: template · tone"', async () => {
  const { store } = await world({ detailTemplates: CUSTOM() });
  const name = (template, tone) => store.runStyle({ outputLanguage: 'en', topic: { template, tone } }).label.styleName;
  assert.equal(name('standard', 'academic'), 'Standard');
  assert.equal(name('textbook', 'academic'), 'Textbook');
  assert.equal(name('standard', 'plain'), 'Plain language');
  assert.equal(name('A', 'magazine'), 'Custom: Template A · Magazine column');
  assert.equal(name('textbook', 'plain'), 'Custom: Textbook · Plain explanation');
});
