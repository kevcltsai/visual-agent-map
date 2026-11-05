// T6 P3: the topic note-style chooser (openTopicStyleChooser) replaced the map-default chooser (openStyleChooser; grilling Q15/Q17, C5, #15, #45).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('./support.cjs');

const D = require('./support-dom.cjs');
const shown = [];
class Notice { constructor(text) { shown.push(text); } }
const opened = [];
class FakeModal extends D.makeModal() {
  open() { opened.push(this); super.open(); }
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
const open = async (w, options) => {
  const writes = [];
  await openTopicStyleChooser({}, w.plugin, { write: ref => { writes.push(ref); }, ...options });
  return { modal: opened.at(-1), writes };
};
// The picker as a person sees it.
const radios = modal => D.findAll(modal.contentEl, i => i.attrs.role === 'radio');
const nameOf = row => D.find(row, i => hasClass(i, 'vam-picker-name')).text;
const descOf = row => D.find(row, i => hasClass(i, 'vam-picker-desc')).text;
const hasClass = (i, c) => (i.cls ?? '').split(/\s+/).includes(c);
const shownRadios = modal => radios(modal).filter(row => !isHidden(row));
const isHidden = el => { for (let n = el; n; n = n.parent) if (n.hidden) return true; return false; };
const names = list => list.map(nameOf);
const checked = modal => radios(modal).filter(r => r.attrs['aria-checked'] === 'true');
const more = modal => D.find(modal.contentEl, i => i.attrs['aria-expanded'] !== undefined);
const apply = modal => D.button(modal.modalEl, 'Apply');
const cancel = modal => D.button(modal.modalEl, 'Cancel');
const rowNamed = (modal, name) => radios(modal).find(r => nameOf(r).startsWith(name));

test('picker: the one in force is first and marked; Follow the topic type (X) is that one when the topic has no style of its own; only 4 rows show and the rest sit under "Other N styles" with the right N; the AIM report never appears', async () => {
  const w = await world({ 'WS/S/Styles/Mine.md': '---\nstructure: Standard\n---\n', 'WS/S/Styles/Broken.md': '---\nstructure: Nope\nupdate: bogus\n---\n' });
  const { modal, writes } = await open(w, { note: {}, kind: 'topic' });
  assert.equal(modal.titleEl.text, 'Note style of this topic');
  const first = radios(modal)[0];
  assert.match(nameOf(first), /^Follow the topic type \(General research\) · Current setting$/);
  assert.deepEqual(checked(modal), [first], 'only the one in force is checked');
  assert.ok(hasClass(first, 'is-current'));
  assert.deepEqual(names(shownRadios(modal)).map(n => n.replace(/ · Current setting$/, '')), ['Follow the topic type (General research)', 'General research', 'Atomic note', 'Hypothesis test'], 'four rows on show');
  const all = names(radios(modal));
  assert.ok(!all.some(label => /AIM/i.test(label)));
  assert.ok(all.includes('Textbook'));
  assert.deepEqual(D.findAll(modal.contentEl, i => hasClass(i, 'vam-picker-broken')).map(r => nameOf(r)).sort(), ['Broken', 'Mine'], 'both style files with a problem are listed, apart from the radios');
  const usable = radios(modal).length, broken = D.findAll(modal.contentEl, i => i.tag === 'button' && i.text === 'Open this file').length;
  assert.equal(broken, 2);
  assert.equal(more(modal).text, `Other ${usable + broken - 4} styles`);
  assert.equal(more(modal).attrs['aria-expanded'], 'false');
  assert.ok(radios(modal).filter(r => !shownRadios(modal).includes(r)).length === usable - 4, 'the rest are collapsed, not removed');
  assert.ok(radios(modal).every(r => /^[^·]+ · [^·]+ · [^·]+ · [^·]+$/.test(descOf(r))), 'one line of four labels under every row');
  assert.deepEqual(writes, [], 'opening writes nothing');
  const hypothesis = await open(w, { note: {}, kind: 'hypothesis' });
  assert.match(nameOf(radios(hypothesis.modal)[0]), /^Follow the topic type \(Hypothesis test\)/, 'X follows the topic type');
});

test('picker: a topic with its own style shows that style first and marked, Follow the topic type is no longer the current one (counterexample 1); the 0.28.0 pair is the current Old setting row', async () => {
  const w = await world();
  const own = await open(w, { note: { noteStyle: 'builtin:textbook' }, kind: 'topic' });
  const rows = radios(own.modal);
  assert.match(nameOf(rows[0]), /^Textbook · Current setting$/);
  assert.equal(rows[0].attrs['aria-checked'], 'true');
  assert.deepEqual(checked(own.modal), [rows[0]]);
  assert.doesNotMatch(nameOf(rowNamed(own.modal, 'Follow the topic type')), /Current setting/);
  assert.equal(rows.filter(r => nameOf(r).startsWith('Textbook')).length, 1, 'the current one is not listed twice');
  assert.equal(shownRadios(own.modal).length, 4);
  const old = await open(w, { note: { detailTemplateId: 'textbook', toneId: 'plain' }, kind: 'topic' });
  assert.match(nameOf(radios(old.modal)[0]), /^Old setting \(Intro \+ six · Plain explanation\) · Current setting$/);
  assert.doesNotMatch(nameOf(rowNamed(old.modal, 'Follow the topic type')), /Current setting/);
  assert.equal(old.writes.length, 0);
  const gone = await open(w, { note: { toneId: 'gone' }, kind: 'topic' });
  assert.match(nameOf(radios(gone.modal)[0]), /^Old setting/, 'an unreadable tone alone is still an old setting');
});

test('picker: choosing writes nothing; Apply writes the chosen ref (Follow the topic type writes null) and closes; Cancel and Esc write nothing and call dismissed; choosing the current one leaves Apply disabled (counterexamples 1, 2, 3)', async () => {
  const w = await world();
  let dismissed = 0;
  const a = await open(w, { note: {}, kind: 'topic', dismissed: () => dismissed++ });
  assert.equal(apply(a.modal).disabled, true, 'nothing changed yet');
  rowNamed(a.modal, 'Atomic note').click();
  assert.equal(a.writes.length, 0, 'choosing alone writes nothing');
  assert.deepEqual(checked(a.modal).map(nameOf), ['Atomic note']);
  assert.equal(apply(a.modal).disabled, false);
  rowNamed(a.modal, 'Follow the topic type').click();
  assert.equal(apply(a.modal).disabled, true, 'back on the current one: nothing to apply');
  apply(a.modal).click();
  assert.deepEqual(a.writes, [], 'a disabled Apply is a no-op');
  rowNamed(a.modal, 'Atomic note').click();
  apply(a.modal).click();
  assert.deepEqual(a.writes, ['builtin:atomic']);
  assert.equal(a.modal.closeCount, 1);
  assert.equal(dismissed, 0, 'applying is not dismissing');

  const own = await open(w, { note: { noteStyle: 'builtin:textbook' }, kind: 'topic', dismissed: () => dismissed++ });
  rowNamed(own.modal, 'Follow the topic type').click();
  apply(own.modal).click();
  assert.deepEqual(own.writes, [null]);

  const c = await open(w, { note: {}, kind: 'topic', dismissed: () => dismissed++ });
  rowNamed(c.modal, 'Textbook').click(); // inside the collapsed part: still a real row
  cancel(c.modal).click();
  assert.deepEqual(c.writes, []); assert.equal(dismissed, 1);
  const esc = await open(w, { note: {}, kind: 'topic', dismissed: () => dismissed++ });
  rowNamed(esc.modal, 'Textbook').click();
  esc.modal.close(); // Esc
  assert.deepEqual(esc.writes, []); assert.equal(dismissed, 2);
});

test('picker keyboard: focus opens on the current row; arrows move and choose, wrapping; only the chosen row is a Tab stop; Enter applies a change and does nothing on the current one; Tab order ends at Cancel, Apply', async () => {
  const w = await world();
  const { modal, writes } = await open(w, { note: { noteStyle: 'builtin:atomic' }, kind: 'topic' });
  const rows = radios(modal);
  assert.equal(rows[0].focused, true, 'focus opens on the current row');
  assert.deepEqual(rows.map(r => r.attrs.tabindex), ['0', ...rows.slice(1).map(() => '-1')]);
  rows[0].keydown({ key: 'Enter' });
  assert.deepEqual(writes, [], 'Enter on the current one applies nothing');
  rows[0].keydown({ key: 'ArrowDown' });
  assert.equal(rows[1].focused, true); assert.equal(rows[1].attrs['aria-checked'], 'true'); assert.equal(rows[0].attrs['aria-checked'], 'false');
  assert.equal(rows[1].attrs.tabindex, '0'); assert.equal(rows[0].attrs.tabindex, '-1');
  assert.deepEqual(writes, [], 'arrows choose, they do not write');
  rows[1].keydown({ key: 'ArrowUp' }); rows[0].keydown({ key: 'ArrowUp' });
  const last = shownRadios(modal).at(-1);
  assert.equal(last.attrs['aria-checked'], 'true', 'ArrowUp from the first wraps to the last shown row');
  last.keydown({ key: 'ArrowDown' });
  assert.equal(rows[0].attrs['aria-checked'], 'true', 'and ArrowDown wraps back');
  rows[0].keydown({ key: 'ArrowRight' });
  rows[1].keydown({ key: 'Enter' });
  assert.deepEqual(writes, [null], 'the second row is Follow the topic type');
  assert.equal(modal.closeCount, 1);
  const order = D.findAll(modal.modalEl, i => i.tag === 'button' && i.attrs.role !== 'radio').map(b => b.text);
  assert.deepEqual(order.slice(-2), ['Cancel', 'Apply'], 'Cancel then Apply at the end of the Tab order');
});

test('picker: "Other N styles" expands, moves focus to the first row it revealed, and those rows are chosen and applied like the rest; arrows then pass through them; a style file with a problem shows its reason and opens instead of being chosen', async () => {
  const w = await world({ 'WS/S/Styles/Broken.md': '---\nupdate: bogus\nvoice: x\nstructure: y\n---\n' });
  const { modal, writes } = await open(w, { note: {}, kind: 'topic' });
  const hiddenBefore = radios(modal).filter(r => isHidden(r));
  assert.ok(hiddenBefore.length >= 3);
  more(modal).click();
  assert.equal(more(modal).attrs['aria-expanded'], 'true');
  assert.equal(shownRadios(modal).length, radios(modal).length, 'all rows on show');
  assert.equal(hiddenBefore[0].focused, true, 'focus lands on the first row the expansion revealed');
  const shownNames = names(shownRadios(modal));
  assert.equal(shownNames.indexOf(nameOf(hiddenBefore[0])), 4, 'revealed rows follow the four');
  hiddenBefore.at(-1).keydown({ key: 'ArrowDown' });
  assert.equal(radios(modal)[0].attrs['aria-checked'], 'true', 'the arrows wrap over all the rows now shown');
  const textbook = rowNamed(modal, 'Textbook');
  textbook.click(); apply(modal).click();
  assert.deepEqual(writes, ['builtin:textbook']);
  const row = D.find(modal.contentEl, i => hasClass(i, 'vam-picker-broken'));
  assert.equal(nameOf(row), 'Broken');
  assert.equal(D.button(row, 'Open this file') !== undefined, true);
  assert.match(descOf(row), /Broken\.md/);
  assert.equal(row.attrs.role, undefined, 'a problem file is not a radio');
});

test('picker without a style store (a plugin test double) still lists the built-ins and opens', async () => {
  const w = { plugin: { settings: { language: 'en', detailTemplates: [], promptPresets: [] } } };
  const { modal } = await open(w, { note: {}, kind: 'topic' });
  assert.match(nameOf(radios(modal)[0]), /^Follow the topic type \(General research\)/);
  assert.ok(radios(modal).length >= 8, 'a plugin test double without a store still lists the built-ins');
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
