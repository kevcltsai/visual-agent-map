// UI findings F2/F4: the map-default chooser offers "Edit this style" even when unset and names every row; opening the folder shows its path.
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
const { openStyleChooser } = S.load('experiences/visual-map/note-style-picker.ts', { obsidian });
const { default: Plugin } = S.load('main.ts', { obsidian });

const picker = (edits, items = []) => ({ refresh: async () => {}, list: () => items, edit: async ref => { edits.push(ref); } });

test('map default chooser: unset map still offers Edit this style (opens editRef) and every row has a name', async () => {
  opened.length = 0;
  const edits = [];
  await openStyleChooser({}, picker(edits), {
    title: 't', description: 'd',
    leading: [{ label: 'Use the default', action() {} }],
    editRef: { kind: 'builtin', id: 'textbook' },
    pick() {}
  });
  const choices = opened[0].choices;
  assert.ok(choices.every(choice => choice.named === true), 'all rows show a name');
  const edit = choices.find(choice => choice.label === S.load('i18n.ts').t('ui.note_style_edit'));
  assert.ok(edit, 'Edit this style row exists');
  edit.action();
  assert.deepEqual(edits, [{ kind: 'builtin', id: 'textbook' }]);
});

test('chooser without current or editRef has no edit row', async () => {
  opened.length = 0;
  await openStyleChooser({}, picker([]), { title: 't', description: 'd', pick() {} });
  assert.equal(opened[0].choices.some(choice => choice.buttonLabel), false);
});

test('chooser rows (D8): leading rows, the five built-ins, then the user\'s template blocks; a block that does not parse shows its reason and opens instead of being picked', async () => {
  opened.length = 0;
  const edits = [], picks = [];
  const bad = { kind: 'file', id: 'file:Broken', name: 'Broken', fileName: 'Broken.md', issues: [{ line: 3, code: 'no_sections', values: [], message: 'x' }] };
  const good = { kind: 'file', id: 'file:Mine', name: 'Mine', fileName: 'Mine.md', issues: [] };
  await openStyleChooser({}, picker(edits, [good, bad]), { title: 't', description: 'd', leading: [{ label: 'Use the default', action() {} }], current: { kind: 'file', id: 'file:Mine' }, pick: (template, tone) => picks.push([template, tone]) });
  const labels = opened[0].choices.map(choice => choice.label);
  assert.deepEqual(JSON.parse(JSON.stringify(labels.slice(0, 1).concat(labels.slice(6, 8)))), ['Use the default', 'Mine', 'Broken']);
  assert.equal(labels.length, 1 + 5 + 2 + 1, 'leading, five built-ins, two blocks, Edit this style');
  const rowOf = label => opened[0].choices.find(choice => choice.label === label);
  assert.equal(rowOf('Mine').description, S.load('i18n.ts').t('ui.detail_template_current'));
  rowOf('Mine').action(); opened[0].choices[3].action();
  assert.deepEqual(picks.map(([template, tone]) => `${template}/${tone}`), ['file:Mine/undefined', 'standard/summary']);
  assert.ok(rowOf('Broken').buttonLabel, 'a broken block opens instead of being picked');
  rowOf('Broken').action();
  assert.deepEqual(JSON.parse(JSON.stringify(edits)), [{ kind: 'file', id: 'file:Broken' }]);
  assert.equal(opened[0].choices.some(choice => choice.label.includes('old style')), false, 'no old style file item');
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
