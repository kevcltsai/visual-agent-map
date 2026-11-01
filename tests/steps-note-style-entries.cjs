// Note style entries (P3): the shared "Note style" field, bad files, edit link, and the error Notice with an action.
// Unit level over the DOM stand-in; the Obsidian wiring (open in a new tab, keyboard, 380px) is for UI checks.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const support = require('./support.cjs');
const dom = require('./support-dom.cjs');

const { load, obsidian, plain } = support;
const fields = load('experiences/visual-map/research-fields.ts', { obsidian });
const noticeLog = [];
const Notice = dom.makeNotice(noticeLog);
const picker = load('experiences/visual-map/note-style-picker.ts', { obsidian: { ...obsidian, Notice } }, { createFragment: dom.createFragment });

const good = { kind: 'file', id: 'style:Mine', name: 'Mine', fileName: 'Mine.md', issues: [] };
const bad = { kind: 'file', id: 'style:Broken', name: 'Broken', fileName: 'Broken.md', issues: [{ line: 4, message: 'Section "A" is repeated.' }] };
const badBuiltin = { kind: 'builtin', id: 'plain', fileName: 'Plain language.md', issues: [{ line: 1, message: 'No ## section.' }] };
const legacy = { kind: 'legacy', id: 'uuid-1', name: 'Old one', fileName: 'Old one.md', issues: [] };

function build(items, extra = {}) {
  const edited = [];
  let current = items;
  const styles = { refresh: async () => {}, list: () => current, unexported: () => [{ id: 'uuid-2', name: 'Not exported' }], edit: async ref => { edited.push(plain(ref)); } };
  const parent = dom.element('div');
  const field = fields.noteStyleField(parent, { styles, templates: [{ id: 'uuid-1', name: 'Old one' }], tones: [{ id: 'plain', name: 'Plain' }], keepLabel: 'Keep current (Standard)', ...extra });
  return { parent, field, edited, select: dom.byLabel(parent, 'Note style'), set: next => { current = next; } };
}
const values = select => dom.findAll(select, i => i.tag === 'option').map(i => i.value);

test('note style field lists keep, the five built-ins, the folder files and the old templates without a file', () => {
  const h = build([good, legacy]);
  assert.deepEqual(values(h.select), ['', 'preset:standard', 'preset:textbook', 'preset:summary', 'preset:plain', 'preset:guide', 'file:style:Mine', 'legacy:uuid-1', 'legacy:uuid-2']);
  assert.equal(dom.find(h.parent, i => i.tag === 'button' && i.text === 'Custom…'), undefined);
  assert.equal(dom.byLabel(h.parent, 'Content template'), undefined); assert.equal(dom.byLabel(h.parent, 'Writing tone'), undefined);
});

test('note style field: a file sends only its id; a built-in sends its pair; an old template sends only its id', () => {
  const h = build([good, legacy]);
  h.select.value = 'file:style:Mine'; h.select.fire('change');
  assert.deepEqual([h.field.templateId(), h.field.toneId(), h.field.name()], ['style:Mine', undefined, 'Mine']);
  h.select.value = 'preset:summary'; h.select.fire('change');
  assert.deepEqual([h.field.templateId(), h.field.toneId()], ['standard', 'summary']);
  h.select.value = 'legacy:uuid-2'; h.select.fire('change');
  assert.deepEqual([h.field.templateId(), h.field.toneId()], ['uuid-2', undefined]);
  h.select.value = ''; h.select.fire('change');
  assert.deepEqual([h.field.templateId(), h.field.toneId()], [undefined, undefined]);
});

test('note style field: a file that does not parse cannot be chosen and shows its reason and an Open this file button', () => {
  const h = build([good, bad, badBuiltin]);
  const option = value => dom.find(h.select, i => i.tag === 'option' && i.value === value);
  assert.equal(option('file:style:Broken').disabled, true); assert.match(option('file:style:Broken').text, /Broken \(cannot be used\)/);
  assert.equal(option('preset:plain').disabled, true);
  assert.equal(option('file:style:Mine').disabled, false);
  const rows = dom.findAll(h.parent, i => dom.hasCls(i, 'vam-note-style-problem'));
  assert.equal(rows.length, 2); assert.equal(rows[0].attrs?.role ?? rows[0].role, 'status');
  assert.match(rows.map(r => dom.texts ? dom.texts(r).join(' ') : r.children.map(c => c.text).join(' ')).join('|'), /"Broken\.md" cannot be chosen \(line 4\): Section "A" is repeated\./);
  const open = dom.findAll(h.parent, i => i.tag === 'button' && i.text === 'Open this file');
  open[0].click(); open[1].click();
  assert.deepEqual(h.edited, [{ kind: 'builtin', id: 'plain' }, { kind: 'file', id: 'style:Broken' }]);
});

test('note style field: Edit this style opens the chosen style, and the current one on the first option', () => {
  const h = build([good, legacy], { currentRef: { kind: 'builtin', id: 'standard' } });
  const edit = () => dom.find(h.parent, i => i.tag === 'button' && i.text === 'Edit this style');
  assert.equal(edit().disabled, false); edit().click();
  h.select.value = 'file:style:Mine'; h.select.fire('change'); edit().click();
  h.select.value = 'legacy:uuid-2'; h.select.fire('change'); edit().click();
  assert.deepEqual(h.edited, [{ kind: 'builtin', id: 'standard' }, { kind: 'file', id: 'style:Mine' }, { kind: 'legacy', id: 'uuid-2' }]);
  const none = build([good]);
  assert.equal(dom.find(none.parent, i => i.tag === 'button' && i.text === 'Edit this style').disabled, true, 'nothing to edit on the first option without a current style');
  const bare = fields.noteStyleField(dom.element('div'), { templates: [], tones: [], keepLabel: 'Keep' });
  assert.equal(bare.templateId(), undefined);
});

test('note style field: an older pair stays selectable as "Custom: X · Y", a file or old template comes back selected, reload redraws', async () => {
  const h = build([good, legacy]);
  h.field.set('style:Mine', undefined); assert.equal(h.select.value, 'file:style:Mine');
  h.field.set('uuid-1', undefined); assert.equal(h.select.value, 'legacy:uuid-1');
  h.field.set('uuid-1', 'plain'); assert.equal(h.select.value, 'custom');
  assert.equal(dom.find(h.select, i => i.tag === 'option' && i.value === 'custom').text, 'Custom: Old one · Plain');
  assert.deepEqual([h.field.templateId(), h.field.toneId()], ['uuid-1', 'plain'], 'the older pair is sent as it was');
  h.field.set('textbook', 'academic'); assert.equal(h.select.value, 'preset:textbook');
  h.field.set(undefined, undefined); assert.equal(h.select.value, '');
  h.field.set('style:Gone', undefined); assert.equal(h.select.value, 'custom');
  assert.equal(dom.find(h.select, i => i.tag === 'option' && i.value === 'custom').text, 'Custom: Gone · ');
  h.set([good, { ...good, id: 'style:Other', name: 'Other', fileName: 'Other.md' }]); await h.field.reload();
  assert.ok(values(h.select).includes('file:style:Other'));
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
  assert.deepEqual(plain(picker.styleRefOf('style:Mine', undefined)), { kind: 'file', id: 'style:Mine' });
  assert.deepEqual(plain(picker.styleRefOf('u1', undefined, ['u1'])), { kind: 'legacy', id: 'u1' });
  assert.equal(picker.styleRefOf('u1', undefined, []), undefined);
});
