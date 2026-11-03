// Note style entries (P3): the shared "Note style" field, bad files, edit link, and the error Notice with an action.
// Unit level over the DOM stand-in; the Obsidian wiring (open in a new tab, keyboard, 380px) is for UI checks.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const support = require('./support.cjs');
const dom = require('./support-dom.cjs');

const { load, obsidian, plain } = support;
const eq = (actual, expected) => assert.deepEqual(plain(actual), plain(expected));
const fields = load('experiences/visual-map/research-fields.ts', { obsidian });
const noticeLog = [];
const Notice = dom.makeNotice(noticeLog);
const picker = load('experiences/visual-map/note-style-picker.ts', { obsidian: { ...obsidian, Notice } }, { createFragment: dom.createFragment });

// 06 P3: the picker lists the five built-ins and the user's template blocks (`file:<name>`); the old style files, the
// "old template without a file" group and the per-built-in file are gone.
const good = { kind: 'file', id: 'file:Mine', name: 'Mine', fileName: 'Mine.md', issues: [] };
const bad = { kind: 'file', id: 'file:Broken', name: 'Broken', fileName: 'Broken.md', issues: [{ line: 4, code: 'ui.detail_template_error_section_name_taken', values: [2], message: 'x' }] };
const other = { kind: 'file', id: 'file:Old one', name: 'Old one', fileName: 'Old one.md', issues: [] };

function build(items, extra = {}) {
  const edited = [];
  let current = items;
  const styles = { refresh: async () => {}, list: () => current, edit: async ref => { edited.push(plain(ref)); } };
  const parent = dom.element('div');
  const field = fields.noteStyleField(parent, { styles, templates: [{ id: 'uuid-1', name: 'Old one' }], tones: [{ id: 'plain', name: 'Plain' }], keepLabel: 'Keep current (Standard)', ...extra });
  return { parent, field, edited, select: dom.byLabel(parent, 'Note style'), set: next => { current = next; } };
}
const values = select => dom.findAll(select, i => i.tag === 'option').map(i => i.value);

test('note style field lists keep, the five built-ins and the template blocks (was: and the old templates without a file)', () => {
  const h = build([good, other]);
  assert.deepEqual(values(h.select), ['', 'preset:standard', 'preset:textbook', 'preset:summary', 'preset:plain', 'preset:guide', 'file:Mine', 'file:Old one']);
  assert.equal(dom.find(h.parent, i => i.tag === 'button' && i.text === 'Custom…'), undefined);
  assert.equal(dom.byLabel(h.parent, 'Content template'), undefined); assert.equal(dom.byLabel(h.parent, 'Writing tone'), undefined);
});

test('note style field: a template block sends only its file: id; a built-in sends its pair', () => {
  const h = build([good, other]);
  h.select.value = 'file:Mine'; h.select.fire('change');
  assert.deepEqual([h.field.templateId(), h.field.toneId(), h.field.name()], ['file:Mine', undefined, 'Mine']);
  h.select.value = 'preset:summary'; h.select.fire('change');
  assert.deepEqual([h.field.templateId(), h.field.toneId()], ['standard', 'summary']);
  h.select.value = 'file:Old one'; h.select.fire('change');
  assert.deepEqual([h.field.templateId(), h.field.toneId()], ['file:Old one', undefined]);
  h.select.value = ''; h.select.fire('change');
  assert.deepEqual([h.field.templateId(), h.field.toneId()], [undefined, undefined]);
});

test('note style field: a block that does not parse cannot be chosen and shows its reason and an Open this file button; a built-in is never unusable', () => {
  const h = build([good, bad]);
  const option = value => dom.find(h.select, i => i.tag === 'option' && i.value === value);
  assert.equal(option('file:Broken').disabled, true); assert.match(option('file:Broken').text, /Broken \(has a problem\)/);
  assert.equal(option('preset:plain').disabled, false);
  assert.equal(option('file:Mine').disabled, false);
  const rows = dom.findAll(h.parent, i => dom.hasCls(i, 'vam-note-style-problem'));
  assert.equal(rows.length, 1); assert.equal(rows[0].attrs?.role ?? rows[0].role, 'status');
  assert.match(rows.map(r => dom.texts ? dom.texts(r).join(' ') : r.children.map(c => c.text).join(' ')).join('|'), /"Broken\.md" has a problem and cannot be chosen \(line 4\): Section 2: another section already uses this name\./);
  const open = dom.findAll(h.parent, i => i.tag === 'button' && i.text === 'Open this file');
  assert.equal(open.length, 1);
  open[0].click();
  assert.deepEqual(h.edited, [{ kind: 'file', id: 'file:Broken' }]);
});

test('note style field: Edit this style opens the chosen style, and the current one on the first option', () => {
  const h = build([good, other], { currentRef: { kind: 'builtin', id: 'standard' } });
  const edit = () => dom.find(h.parent, i => i.tag === 'button' && i.text === 'Edit this style');
  assert.equal(edit().disabled, false); edit().click();
  h.select.value = 'file:Mine'; h.select.fire('change'); edit().click();
  h.select.value = 'file:Old one'; h.select.fire('change'); edit().click();
  assert.deepEqual(h.edited, [{ kind: 'builtin', id: 'standard' }, { kind: 'file', id: 'file:Mine' }, { kind: 'file', id: 'file:Old one' }]);
  const none = build([good]);
  assert.equal(dom.find(none.parent, i => i.tag === 'button' && i.text === 'Edit this style').disabled, true, 'nothing to edit on the first option without a current style');
  const bare = fields.noteStyleField(dom.element('div'), { templates: [], tones: [], keepLabel: 'Keep' });
  assert.equal(bare.templateId(), undefined);
});

test('note style field: an older pair stays selectable as "Custom: X · Y", a template block comes back selected, reload redraws', async () => {
  const h = build([good, other]);
  h.field.set('file:Mine', undefined); assert.equal(h.select.value, 'file:Mine');
  h.field.set('uuid-1', undefined); assert.equal(h.select.value, 'custom', 'an old id that is not a block shows as an older pair');
  h.field.set('uuid-1', 'plain'); assert.equal(h.select.value, 'custom');
  assert.equal(dom.find(h.select, i => i.tag === 'option' && i.value === 'custom').text, 'Custom: Old one · Plain');
  assert.deepEqual([h.field.templateId(), h.field.toneId()], ['uuid-1', 'plain'], 'the older pair is sent as it was');
  h.field.set('textbook', 'academic'); assert.equal(h.select.value, 'preset:textbook');
  h.field.set(undefined, undefined); assert.equal(h.select.value, '');
  h.field.set('file:Gone', undefined); assert.equal(h.select.value, 'custom');
  assert.equal(dom.find(h.select, i => i.tag === 'option' && i.value === 'custom').text, 'Custom: Gone · ');
  h.set([good, { ...good, id: 'file:Other', name: 'Other', fileName: 'Other.md' }]); await h.field.reload();
  assert.ok(values(h.select).includes('file:Other'));
});

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

test('styleRefOf names the style behind a stored pair', () => {
  assert.deepEqual(plain(picker.styleRefOf('textbook', 'academic')), { kind: 'builtin', id: 'textbook' });
  assert.deepEqual(plain(picker.styleRefOf('file:Mine', undefined)), { kind: 'file', id: 'file:Mine' });
  // decisions #32: no alias table; an old id stands for nothing, even when a third argument still names it
  assert.equal(picker.styleRefOf('u1', undefined), undefined);
  assert.equal(picker.styleRefOf('style:S', undefined, { 'style:S': { template: 'file:S', tone: 'builtin:academic' } }), undefined);
  assert.equal(picker.styleRefOf.length, 2, 'two parameters: the alias table is gone');
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

test('stylePickerFor: the picker lists only the user\'s template blocks (built-in rows and tone blocks stay out) and edit opens the block\'s file', async () => {
  const opened = [], ensured = [];
  const file = new (class TFile {})();
  const app = { vault: { getAbstractFileByPath: path => (path === 'WS/Blocks/Templates/Mine.md' ? file : null) }, workspace: { getLeaf: () => ({ openFile: async f => { opened.push(f); } }) } };
  const store = {
    refresh: async () => {},
    listBlocks: category => (category === 'template'
      ? [{ ref: 'builtin:standard', kind: 'builtin', name: 'Standard', fileName: 'Standard.md', modified: true, issues: [] }, { ref: 'file:Mine', kind: 'file', name: 'Mine', fileName: 'Mine.md', modified: false, issues: [] }]
      : [{ ref: 'file:Calm', kind: 'file', name: 'Calm', fileName: 'Calm.md', modified: false, issues: [] }]),
    ensureBlockFile: async (category, ref) => { ensured.push([category, ref]); return { path: 'WS/Blocks/Templates/Mine.md', base: 'Mine' }; }
  };
  const loaded = load('experiences/visual-map/note-style-picker.ts', { obsidian: { ...obsidian, TFile: file.constructor } });
  const styles = loaded.stylePickerFor(app, { noteStyles: store });
  eq(styles.list(), [{ kind: 'file', id: 'file:Mine', name: 'Mine', fileName: 'Mine.md', issues: [] }]);
  await styles.edit({ kind: 'file', id: 'file:Mine' });
  await styles.edit({ kind: 'builtin', id: 'summary' });
  eq(ensured, [['template', 'file:Mine'], ['template', 'builtin:standard']]);
  assert.equal(opened.length, 2);
  assert.equal(loaded.stylePickerFor(app, {}), undefined, 'a plugin without a store has no picker');
});

// T6 P1: the one-line style choice (`styleChoiceField`), added beside the old field; the dialogs switch to it in P2.
const recipe = (ref, name, extra = {}) => ({ ref, kind: ref.startsWith('file:') ? 'file' : 'builtin', name, structure: { name: 'Standard' }, voice: { name: 'Academic rigor' }, format: { name: 'Standard' }, update: 'merge', issues: [], ...extra });
const mineRecipe = recipe('file:Mine', 'Mine', { fileName: 'Mine.md', update: 'top' });
const brokenRecipe = recipe('file:Broken', 'Broken', { fileName: 'Broken.md', issues: [{ line: 4, code: 'ui.detail_template_error_section_name_taken', values: [2], message: 'x' }] });
const recipes = [recipe('builtin:general', 'General research'), recipe('builtin:textbook', 'Textbook', { structure: { name: 'Textbook' } }), recipe('builtin:aim', 'AIM report', { aimOnly: true }), mineRecipe, brokenRecipe];

function choice(list = recipes, extra = {}) {
  const edited = [], changes = [];
  let current = list;
  const styles = { refresh: async () => {}, list: () => [], recipes: () => current, edit: async ref => { edited.push(plain(ref)); } };
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
  assert.deepEqual(h.edited, [{ kind: 'file', id: 'file:Broken' }]);
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
  assert.equal(tags.hidden, false); assert.equal(tags.text, 'Standard · Academic rigor · Standard · New on top');
  let writes = 0; const setText = tags.setText.bind(tags); tags.setText = value => { writes++; setText(value); };
  h.select.fire('change'); h.select.fire('change');
  assert.equal(writes, 0, 'the same text is not written again');
  h.select.value = 'builtin:textbook'; h.select.fire('change');
  assert.equal(writes, 1); assert.equal(tags.text, 'Textbook · Academic rigor · Standard · Merge and rewrite');
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
  const h = choice(recipes, { styles: { refresh: async () => { writes.push('refresh'); }, list: () => [], recipes: () => recipes, edit: async () => { writes.push('edit'); } } });
  h.toggle.click(); h.select.value = 'builtin:textbook'; h.select.fire('change'); h.toggle.click();
  assert.deepEqual(writes, []);
});

test('stylePickerFor: recipes() is the store\'s listRecipes() as it is; builtinRecipeItems() names the built-in styles for a picker-less test double; list() stays the template blocks', () => {
  const file = new (class TFile {})();
  const loaded = load('experiences/visual-map/note-style-picker.ts', { obsidian: { ...obsidian, TFile: file.constructor } });
  const base = { refresh: async () => {}, listBlocks: () => [] };
  const builtins = loaded.builtinRecipeItems();
  assert.equal(builtins.length, 8); eq(builtins.filter(i => i.aimOnly).map(i => i.ref), ['builtin:aim']);
  eq(builtins.map(i => i.ref).slice(0, 2), ['builtin:general', 'builtin:atomic']);
  const textbook = builtins.find(i => i.ref === 'builtin:textbook');
  eq([textbook.name, textbook.structure.name, textbook.voice.name, textbook.format.name, textbook.update], ['Textbook', 'Intro + six', 'Academic rigor', 'Standard format', 'merge']);
  const listed = [recipe('builtin:general', 'General research'), mineRecipe];
  const withList = loaded.stylePickerFor({}, { noteStyles: { ...base, listRecipes() { return listed; } } });
  assert.equal(withList.recipes(), listed);
  eq(withList.list(), []);
});
