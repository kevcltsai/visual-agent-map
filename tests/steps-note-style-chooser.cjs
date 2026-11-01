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

const picker = (edits) => ({ refresh: async () => {}, list: () => [], unexported: () => [], edit: async ref => { edits.push(ref); } });

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

test('openNoteStylesFolder shows a Notice with the folder path', async () => {
  shown.length = 0;
  const self = { noteStyles: { ensureStyleFolder: async () => 'WS/Styles', list: () => [] }, app: { vault: { getAbstractFileByPath: () => null }, workspace: {} } };
  const folder = await Plugin.prototype.openNoteStylesFolder.call(self);
  assert.equal(folder, 'WS/Styles');
  assert.ok(shown.some(text => String(text).includes('WS/Styles')));
});
