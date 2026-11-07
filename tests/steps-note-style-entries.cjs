// Note style entries: the one-line style choice (T6; was the shared "Note style" select, P3), bad files, and the error Notice with an action.
// Unit level over the DOM stand-in; the Obsidian wiring (open in a new tab, keyboard, 380px) is for UI checks.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const support = require('./support.cjs');
const dom = require('./support-dom.cjs');

const { load, obsidian, plain } = support;
const { loadSource } = require('./support-replay.cjs');
const eq = (actual, expected) => assert.deepEqual(plain(actual), plain(expected));
const fields = load('experiences/visual-map/research-fields.ts', { obsidian });
const noticeLog = [];
const Notice = dom.makeNotice(noticeLog);
const picker = load('experiences/visual-map/note-style-picker.ts', { obsidian: { ...obsidian, Notice } }, { createFragment: dom.createFragment });

test('error Notice: a style file error offers Open this file; other errors are plain', () => {
  noticeLog.length = 0;
  let opened = 0;
  const notice = picker.errorNotice(new picker.NoteStyleFileError('The note style file "A.md" cannot be used (line 2): x', () => { opened++; }));
  const button = dom.findAll(notice.message, i => i.tag === 'button');
  assert.deepEqual(button.map(b => b.text), ['Open this file']);
  button[0].click(); assert.equal(opened, 1); assert.equal(notice.hidden, true);
  const plainNotice = picker.errorNotice(new Error('boom'));
  assert.equal(plainNotice.message, 'boom');
});

test('D9 (replaces styleRefOf names the style behind a stored pair): the picker no longer maps a stored template and tone pair to a style', () => {
  assert.equal(picker.styleRefOf, undefined);
});

test('plugin.mutate: a style file error from a queued write shows Open this file; other errors stay plain', async () => {
  const log = [];
  const Notice = dom.makeNotice(log);
  const loaded = load('tests/support-main-entry.ts', { obsidian: { ...obsidian, Notice } }, { createFragment: dom.createFragment });
  const host = { queue: Promise.resolve(), writing: 0, logs: { appendLog() {} }, views: () => [] };
  const mutate = work => loaded.default.prototype.mutate.call(host, work);
  const origError = console.error; console.error = () => {};
  try {
    let opened = 0;
    await mutate(async () => { throw new loaded.NoteStyleFileError('The note style file "A.md" cannot be used (line 2): x', () => { opened++; }); }).catch(() => {});
    await host.queue;
    const styled = Notice.all[Notice.all.length - 1];
    const buttons = dom.findAll(styled.message, i => i.tag === 'button');
    assert.deepEqual(buttons.map(b => b.text), ['Open this file']);
    buttons[0].click(); assert.equal(opened, 1);
    await mutate(async () => { throw new Error('boom'); }).catch(() => {});
    await host.queue;
    assert.equal(Notice.all[Notice.all.length - 1].message, 'boom');
  } finally { console.error = origError; }
});

test('stylePickerFor: a plugin without a store has no picker; the picker has no template-block list and no edit any more (R1-1)', () => {
  const store = { refresh: async () => {}, listRecipes: () => [], recipeFilePath: () => undefined };
  const styles = picker.stylePickerFor({}, { noteStyles: store });
  assert.equal(styles.list, undefined);
  assert.equal(styles.edit, undefined);
  assert.equal(typeof styles.openRecipe, 'function');
  assert.equal(picker.stylePickerFor({}, {}), undefined);
  assert.equal(picker.openStyleFile, undefined);
  assert.equal(picker.styleProblem, undefined);
});

// R1-1 (T6 F1): "Open this file" of a style opens the style file, never a structure file of the same name (real store, in-memory vault).
test('R1-1: "Open this file" of a style file with a problem opens <Styles folder>/Broken.md, and not the structure file with the same name', async () => {
  const S = loadSource('export { NoteStyleStore } from "./ai/note-style-store";');
  const root = 'WS/S';
  const files = {
    [`${root}/Styles/Broken.md`]: '---\nstructure: Mine\nupdate: nonsense\n---\n',
    [`${root}/Structures/Broken.md`]: '## A\nx\n',
    [`${root}/Structures/Mine.md`]: '## A\nx\n'
  };
  const under = folder => Object.keys(files).filter(f => f.startsWith(`${folder}/`) && !f.slice(folder.length + 1).includes('/'));
  const port = {
    list: async folder => under(folder).map(f => f.slice(folder.length + 1)),
    read: async f => files[f],
    folderExists: folder => Object.keys(files).some(f => f.startsWith(`${folder}/`)),
    createFolder: async () => {},
    create: async (f, c) => { files[f] = c; },
    trash: async () => {}
  };
  const settings = { detailTemplates: [], promptPresets: [], workspaceFolder: 'WS', noteStylesFolder: root, language: 'en' };
  const store = new S.NoteStyleStore({ settings: () => settings, port, save: async () => {} });
  await store.refresh();
  const opened = [];
  class TFile { constructor(path) { this.path = path; } }
  const app = { vault: { getAbstractFileByPath: path => (path in files ? new TFile(path) : null) }, workspace: { getLeaf: () => ({ openFile: async f => { opened.push(f.path); } }) } };
  const loaded = load('experiences/visual-map/note-style-picker.ts', { obsidian: { ...obsidian, TFile } });
  const styles = loaded.stylePickerFor(app, { noteStyles: store });
  await styles.refresh();
  const parent = dom.element('div');
  fields.styleChoiceField(parent, { styles, current: 'x', changed: () => {} });
  const toggle = dom.find(parent, i => i.tag === 'button' && dom.hasCls(i, 'vam-field-link') && !dom.hasCls(i, 'vam-note-style-problem'));
  toggle.click();
  const row = dom.find(parent, i => dom.hasCls(i, 'vam-note-style-problem'));
  const open = dom.find(row, i => i.tag === 'button');
  assert.ok(open, 'the problem row has the open button');
  open.click();
  await new Promise(resolve => setTimeout(resolve, 20));
  eq(opened, [`${root}/Styles/Broken.md`]);
});

// T6 P1: the one-line style choice (`styleChoiceField`), added beside the old field; the dialogs switch to it in P2.
const recipe = (ref, name, extra = {}) => ({ ref, kind: ref.startsWith('file:') ? 'file' : 'builtin', name, structure: { name: 'Standard' }, voice: { name: 'Professional' }, format: { name: 'Standard' }, update: 'merge', issues: [], ...extra });
const mineRecipe = recipe('file:Mine', 'Mine', { fileName: 'Mine.md', update: 'top' });
const brokenRecipe = recipe('file:Broken', 'Broken', { fileName: 'Broken.md', issues: [{ line: 4, code: 'ui.detail_template_error_section_name_taken', values: [2], message: 'x' }] });
const recipes = [recipe('builtin:general', 'General research'), recipe('builtin:textbook', 'Textbook', { structure: { name: 'Textbook' } }), recipe('builtin:aim', 'AIM report', { aimOnly: true }), mineRecipe, brokenRecipe];

function choice(list = recipes, extra = {}) {
  const edited = [], changes = [];
  let current = list;
  const styles = { refresh: async () => {}, recipes: () => current, openRecipe: async ref => { edited.push(ref); } };
  const parent = dom.element('div');
  const field = fields.styleChoiceField(parent, { styles, current: 'Hypothesis test', changed: () => changes.push(1), ...extra });
  const toggle = dom.find(parent, i => i.tag === 'button' && dom.hasCls(i, 'vam-field-link') && !dom.hasCls(i, 'vam-note-style-problem'));
  return { parent, field, edited, changes, toggle, select: dom.byLabel(parent, 'Note style for this run'), set: next => { current = next; } };
}
const optionValues = select => dom.findAll(select, i => i.tag === 'option').map(i => i.value);
const lineText = parent => dom.findAll(dom.find(parent, i => dom.hasCls(i, 'vam-style-choice-text')), i => i.text).map(i => i.text).join('');

test('styleChoiceField: one line "Note style: X" and a collapsed button; nothing is chosen, so no style is sent (counter-example 6)', () => {
  const h = choice();
  assert.equal(lineText(h.parent), 'Note style: Hypothesis test');
  assert.equal(h.toggle.text, 'Use another style this time');
  assert.equal(h.toggle.attrs['aria-expanded'], 'false');
  const panel = dom.find(h.parent, i => dom.hasCls(i, 'vam-style-choice-panel'));
  assert.equal(panel.hidden, true); assert.equal(h.toggle.attrs['aria-controls'], panel.attrs.id);
  assert.equal(h.field.style(), undefined); assert.equal(h.field.label(), 'Hypothesis test'); assert.equal(h.field.name(), 'Hypothesis test');
  const none = h.changes.length; assert.equal(none, 0, 'building the field calls nothing back');
});

test('styleChoiceField: expand, choose, restore: the line follows, aria-expanded flips, restore goes back to the empty value (counter-example 6, 16)', () => {
  const h = choice();
  h.toggle.click();
  assert.equal(h.toggle.attrs['aria-expanded'], 'true'); assert.equal(h.toggle.text, 'Go back to the original style');
  assert.equal(dom.find(h.parent, i => dom.hasCls(i, 'vam-style-choice-panel')).hidden, false);
  assert.equal(h.field.style(), undefined, 'expanded on the first option still sends nothing');
  assert.equal(dom.find(h.select, i => i.tag === 'option').text, 'Keep (Hypothesis test)');
  h.select.value = 'builtin:textbook'; h.select.fire('change');
  assert.equal(h.field.style(), 'builtin:textbook'); assert.equal(lineText(h.parent), 'Note style: Textbook'); assert.equal(h.field.label(), 'Textbook');
  h.toggle.click();
  assert.equal(h.toggle.attrs['aria-expanded'], 'false'); assert.equal(h.select.value, '');
  assert.equal(h.field.style(), undefined); assert.equal(lineText(h.parent), 'Note style: Hypothesis test');
  assert.equal(h.changes.length, 3, 'toggle, choice and restore each call back once');
  const strong = dom.find(h.parent, i => i.tag === 'strong'); assert.equal(strong.text, 'Hypothesis test');
});

test('styleChoiceField: the select lists "Keep (X)", then Built-in and Mine groups; the AIM report is never listed (counter-example 8)', () => {
  const h = choice();
  assert.deepEqual(optionValues(h.select), ['', 'builtin:general', 'builtin:textbook', 'file:Mine', 'file:Broken']);
  assert.ok(!optionValues(h.select).includes('builtin:aim'));
  const groups = dom.findAll(h.select, i => i.tag === 'optgroup').map(i => i.attrs.label);
  assert.deepEqual(groups, ['Built-in', 'Mine']);
  // no picker (a test double): the seven built-ins by name, no file read
  const bare = dom.element('div');
  const field = fields.styleChoiceField(bare, { current: 'X' });
  const names = dom.findAll(dom.byLabel(bare, 'Note style for this run'), i => i.tag === 'option').map(i => i.text);
  assert.deepEqual(names, ['Keep (X)', 'General research', 'Atomic note', 'Hypothesis test', 'Evidence record', 'Conclusion', 'Action plan', 'Textbook']);
  assert.equal(field.style(), undefined);
});

test('styleChoiceField: a topic-only style (AI suggested) is never listed in a run\'s choice, and cannot be set by code', () => {
  const h = choice([...recipes, recipe('builtin:ai-suggested', 'AI suggested', { topicOnly: true, noCopy: true })]);
  assert.deepEqual(optionValues(h.select), ['', 'builtin:general', 'builtin:textbook', 'file:Mine', 'file:Broken']);
  h.toggle.click(); h.select.value = 'builtin:ai-suggested'; h.select.fire('change');
  assert.equal(h.field.style(), undefined);
});

test('styleChoiceField: a style file with a problem is disabled with its reason and Open this file, and cannot be sent even when set by code (counter-example 7)', () => {
  const h = choice();
  const option = value => dom.find(h.select, i => i.tag === 'option' && i.value === value);
  assert.equal(option('file:Broken').disabled, true); assert.match(option('file:Broken').text, /Broken \(has a problem\)/);
  assert.equal(option('file:Mine').disabled, false); assert.equal(option('builtin:general').disabled, false);
  const rows = dom.findAll(h.parent, i => dom.hasCls(i, 'vam-note-style-problem'));
  assert.equal(rows.length, 1); assert.equal(rows[0].attrs.role, 'status');
  assert.match(dom.texts(rows[0]).join(' '), /"Broken\.md" has a problem and cannot be chosen \(line 4\): Section 2: another section already uses this name\./);
  const open = dom.findAll(h.parent, i => i.tag === 'button' && i.text === 'Open this file');
  assert.equal(open.length, 1); open[0].click();
  assert.deepEqual(h.edited, ['file:Broken']);
  h.toggle.click(); h.select.value = 'file:Broken'; h.select.fire('change');
  assert.equal(h.field.style(), undefined, 'a bad file is never sent');
  assert.equal(h.field.name(), 'Hypothesis test');
  h.select.value = 'builtin:aim'; h.select.fire('change');
  assert.equal(h.field.style(), undefined, 'the AIM report is never sent for a topic');
});

test('styleChoiceField: four small labels under the select, polite live region, rewritten only when the text changes', () => {
  const h = choice();
  const tags = dom.find(h.parent, i => i.attrs?.['aria-live'] === 'polite');
  assert.equal(tags.hidden, true);
  h.toggle.click(); h.select.value = 'file:Mine'; h.select.fire('change');
  assert.equal(tags.hidden, false); assert.equal(tags.text, 'Standard · Professional · Standard · New on top');
  let writes = 0; const setText = tags.setText.bind(tags); tags.setText = value => { writes++; setText(value); };
  h.select.fire('change'); h.select.fire('change');
  assert.equal(writes, 0, 'the same text is not written again');
  h.select.value = 'builtin:textbook'; h.select.fire('change');
  assert.equal(writes, 1); assert.equal(tags.text, 'Textbook · Professional · Standard · Merge and rewrite');
  h.select.value = ''; h.select.fire('change');
  assert.equal(tags.text, ''); assert.equal(tags.hidden, true);
});

test('styleChoiceField: set restores a choice, an unknown or unusable ref leaves it empty; reload keeps a usable choice and drops one that went away', async () => {
  const h = choice();
  h.field.set('file:Mine');
  assert.equal(h.select.value, 'file:Mine'); assert.equal(h.field.style(), 'file:Mine'); assert.equal(h.toggle.attrs['aria-expanded'], 'true');
  h.field.set('file:Gone'); assert.equal(h.select.value, ''); assert.equal(h.field.style(), undefined); assert.equal(h.toggle.attrs['aria-expanded'], 'false');
  h.field.set('file:Broken'); assert.equal(h.field.style(), undefined);
  h.field.set(undefined); assert.equal(h.field.style(), undefined);
  h.field.set('file:Mine');
  h.set([recipe('builtin:general', 'General research'), mineRecipe, recipe('file:New', 'New', { fileName: 'New.md' })]); await h.field.reload();
  assert.ok(optionValues(h.select).includes('file:New')); assert.equal(h.field.style(), 'file:Mine');
  h.set([recipe('builtin:general', 'General research')]); await h.field.reload();
  assert.equal(h.field.style(), undefined, 'a style that went away is no longer sent');
});

test('styleChoiceField: building, expanding and choosing write nothing to the vault', () => {
  const writes = [];
  const h = choice(recipes, { styles: { refresh: async () => { writes.push('refresh'); }, recipes: () => recipes, openRecipe: async () => { writes.push('edit'); } } });
  h.toggle.click(); h.select.value = 'builtin:textbook'; h.select.fire('change'); h.toggle.click();
  assert.deepEqual(writes, []);
});

test('stylePickerFor: recipes() is the store\'s listRecipes() as it is; builtinRecipeItems() names the built-in styles for a picker-less test double; list() is gone (R1-1)', () => {
  const file = new (class TFile {})();
  const loaded = load('experiences/visual-map/note-style-picker.ts', { obsidian: { ...obsidian, TFile: file.constructor } });
  const base = { refresh: async () => {}, listBlocks: () => [] };
  const builtins = loaded.builtinRecipeItems();
  assert.equal(builtins.length, 9); eq(builtins.filter(i => i.aimOnly).map(i => i.ref), ['builtin:aim']);
  eq(builtins.filter(i => i.topicOnly).map(i => i.ref), ['builtin:ai-suggested']);
  eq(builtins.find(i => i.ref === 'builtin:ai-suggested').name, 'AI suggested');
  eq(builtins.map(i => i.ref).slice(0, 2), ['builtin:general', 'builtin:atomic']);
  const textbook = builtins.find(i => i.ref === 'builtin:textbook');
  eq([textbook.name, textbook.structure.name, textbook.voice.name, textbook.format.name, textbook.update], ['Textbook', 'Intro + six', 'Professional', 'Standard format', 'merge']);
  const listed = [recipe('builtin:general', 'General research'), mineRecipe];
  const withList = loaded.stylePickerFor({}, { noteStyles: { ...base, listRecipes() { return listed; } } });
  assert.equal(withList.recipes(), listed);
  assert.equal(withList.list, undefined);
});
