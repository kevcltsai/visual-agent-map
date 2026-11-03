// T6 P3: the topic note-style chooser (openTopicStyleChooser) replaced the map-default chooser (openStyleChooser; grilling Q15/Q17, C5, #15, #45).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('./support.cjs');

const shown = [];
class Notice { constructor(text) { shown.push(text); } }
const opened = [];
class FakeModal {
  constructor(app) { this.app = app; this.titleEl = { setText() {} }; this.contentEl = { createEl: () => ({}) }; }
  open() { opened.push(this); }
}
const obsidian = { ...S.obsidian, Notice, Modal: FakeModal };
const { openTopicStyleChooser } = S.load('experiences/visual-map/note-style-picker.ts', { obsidian });
const { NoteStyleStore } = S.load('ai/note-style-store.ts');
const { default: Plugin } = S.load('main.ts', { obsidian });
const plain = value => JSON.parse(JSON.stringify(value));

async function world(files = {}, settingsPatch = {}) {
  const settings = { language: 'en', workspaceFolder: 'WS', noteStylesFolder: 'WS/S', detailTemplates: [], promptPresets: [], ...settingsPatch };
  const port = { list: async folder => Object.keys(files).filter(f => f.startsWith(`${folder}/`)).map(f => f.slice(folder.length + 1)), read: async f => files[f], folderExists: folder => Object.keys(files).some(f => f.startsWith(`${folder}/`)), createFolder: async () => {}, create: async () => {}, trash: async () => {} };
  const plugin = { settings, noteStyles: new NoteStyleStore({ settings: () => settings, port, save: async () => {} }) };
  await plugin.noteStyles.refresh();
  return { plugin, files };
}
const open = async (w, options) => { const writes = []; await openTopicStyleChooser({}, w.plugin, { write: ref => { writes.push(ref); }, ...options }); return { modal: opened.at(-1), writes }; };

test('chooser rows: Follow the topic type (X) first, then the built-ins without the AIM report, then the user\'s styles; every row is named and has one line of labels; the AIM report never appears (counterexample 8)', async () => {
  const w = await world({ 'WS/S/Styles/Mine.md': '---\nstructure: Standard\n---\n' });
  const { modal } = await open(w, { note: {}, kind: 'topic' });
  const labels = plain(modal.choices.map(choice => choice.label));
  assert.equal(labels[0], 'Follow the topic type (General research)');
  assert.deepEqual(labels.slice(1, 8), ['General research', 'Atomic note', 'Hypothesis test', 'Evidence record', 'Conclusion', 'Action plan', 'Textbook']);
  assert.equal(labels.at(-1), 'Mine', 'a style file with a problem is listed too');
  assert.ok(!labels.some(label => /AIM/i.test(label)));
  const usable = modal.choices.filter(choice => !choice.buttonLabel);
  assert.ok(modal.choices.every(choice => choice.named === true) && usable.length === modal.choices.length - 1);
  assert.ok(usable.every(choice => /^(Current setting · )?[^·]+ · [^·]+ · [^·]+ · [^·]+$/.test(choice.description)), plain(usable.map(c => c.description)).join('|'));
  assert.match(modal.choices.at(-1).description, /Mine\.md.*line \d+.*was not found; the built-in one is used/, 'a style file with a problem says why in words, not in a code');
  const hypothesis = await open(w, { note: {}, kind: 'hypothesis' });
  assert.equal(hypothesis.modal.choices[0].label, 'Follow the topic type (Hypothesis test)', 'X follows the topic type');
});

test('chooser: the row in force is marked and writes nothing; any other row writes its ref; Follow the topic type writes null (counterexamples 1, 2, 3)', async () => {
  const w = await world();
  const none = await open(w, { note: {}, kind: 'topic' });
  assert.match(none.modal.choices[0].description, /^Current setting/);
  await none.modal.choices[0].action();
  assert.deepEqual(none.writes, [], 'no style set: Follow the topic type is already in force');
  await none.modal.choices.find(c => c.label === 'Textbook').action();
  assert.deepEqual(none.writes, ['builtin:textbook']);
  const own = await open(w, { note: { noteStyle: 'builtin:textbook' }, kind: 'topic' });
  assert.match(own.modal.choices.find(c => c.label === 'Textbook').description, /^Current setting/);
  assert.doesNotMatch(own.modal.choices[0].description, /^Current setting/);
  await own.modal.choices.find(c => c.label === 'Textbook').action();
  assert.deepEqual(own.writes, [], 'the row in force writes nothing');
  await own.modal.choices[0].action();
  assert.deepEqual(own.writes, [null]);
});

test('chooser: a topic with only the 0.28.0 template and tone gets the Old setting row as the one in force; picking it writes nothing, Follow the topic type clears (counterexample 1)', async () => {
  const w = await world();
  const old = await open(w, { note: { detailTemplateId: 'textbook', toneId: 'plain' }, kind: 'topic' });
  assert.equal(old.modal.choices[1].label, 'Old setting (Intro + six · Plain explanation)');
  assert.match(old.modal.choices[1].description, /^Current setting/);
  assert.doesNotMatch(old.modal.choices[0].description, /^Current setting/);
  await old.modal.choices[1].action();
  assert.deepEqual(old.writes, []);
  await old.modal.choices[0].action();
  assert.deepEqual(old.writes, [null]);
  const gone = await open(w, { note: { toneId: 'gone' }, kind: 'topic' });
  assert.match(gone.modal.choices[1].label, /^Old setting/, 'an unreadable tone alone is still an old setting');
});

test('chooser: a style file with a problem shows its reason and opens instead of being chosen; Cancel is passed through as dismissed', async () => {
  const w = await world({ 'WS/S/Styles/Broken.md': '---\nupdate: bogus\nvoice: x\nstructure: y\n---\n' });
  let dismissed = 0;
  const { modal, writes } = await open(w, { note: {}, kind: 'topic', dismissed: () => dismissed++ });
  const row = modal.choices.at(-1);
  assert.equal(row.label, 'Broken');
  assert.equal(row.buttonLabel, 'Open this file');
  assert.match(row.description, /Broken\.md/);
  assert.deepEqual(writes, []);
  assert.equal(typeof modal.dismissed, 'function');
  modal.dismissed(); assert.equal(dismissed, 1);
});

test('chooser without a style store (a plugin test double) still lists the built-ins and opens', async () => {
  const w = { plugin: { settings: { language: 'en', detailTemplates: [], promptPresets: [] } } };
  const { modal } = await open(w, { note: {}, kind: 'topic' });
  assert.equal(modal.choices[0].label, 'Follow the topic type (General research)');
  assert.ok(modal.choices.length >= 8);
});

test('openNoteStylesFolder (D15) creates the block folders, shows their path and reveals the folder', async () => {
  shown.length = 0;
  const revealed = [];
  const target = { path: 'WS/Styles/Blocks' };
  const self = {
    noteStyles: { ensureBlockFolder: async () => 'WS/Styles/Blocks' },
    app: { vault: { getAbstractFileByPath: path => (path === 'WS/Styles/Blocks' ? target : null) }, workspace: { getLeavesOfType: type => (type === 'file-explorer' ? [{ view: { revealInFolder: item => revealed.push(item) } }] : []) } }
  };
  const folder = await Plugin.prototype.openNoteStylesFolder.call(self);
  assert.equal(folder, 'WS/Styles/Blocks');
  assert.ok(shown.some(text => String(text).includes('WS/Styles/Blocks')));
  assert.deepEqual(revealed, [target]);
  const bare = await Plugin.prototype.openNoteStylesFolder.call({ noteStyles: { ensureBlockFolder: async () => 'WS/Styles/Blocks' }, app: { vault: { getAbstractFileByPath: () => null }, workspace: {} } });
  assert.equal(bare, 'WS/Styles/Blocks', 'a vault without the file explorer still gets the Notice');
  const failing = await Plugin.prototype.openNoteStylesFolder.call({ noteStyles: { ensureBlockFolder: async () => { throw new Error('disk full'); } }, app: {} });
  assert.equal(failing, null);
  assert.ok(shown.some(text => /disk full/.test(String(text))));
});
