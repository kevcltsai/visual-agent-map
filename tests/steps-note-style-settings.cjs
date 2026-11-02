// Settings "Note style" area (note style flow redesign P2): the heading with Preview AI instructions, the Structure and Voice
// rows (a picker in two groups, one Edit button, one more-actions menu with only the actions that apply), the File location
// row, the style-file problem texts in every language, and the dead template UI is gone.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const S = require('./support.cjs');
const dom = require('./support-dom.cjs');
const { loadSource } = require('./support-replay.cjs');

const modals = [];
class FakeModal { constructor(app) { this.app = app; } open() { modals.push(this); } close() {} }
const menus = [];
class FakeMenu {
  constructor() { this.items = []; menus.push(this); }
  addItem(build) { const item = { title: '', icon: '' }; build({ setTitle(t) { item.title = t; return this; }, setIcon(i) { item.icon = i; return this; }, onClick(fn) { item.click = fn; return this; } }); this.items.push(item); return this; }
  showAtPosition(position) { this.position = position; return this; }
  get titles() { return this.items.map(item => item.title); }
}
const notices = [];
const obsidian = { ...S.obsidian, PluginSettingTab: class { hide() {} }, Setting: class {}, Modal: FakeModal, Menu: FakeMenu, Notice: dom.makeNotice(notices) };
const { renderNoteStyleIntro, renderNoteBlockSetting, renderNoteLocationSetting, renderNoteKindSetting, renderNoteKindHeading } = S.load('ui/settings-tab.ts', { obsidian });
const { styleIssueText } = S.load('experiences/visual-map/note-style-picker.ts', { obsidian });
const { default: Plugin } = S.load('main.ts', { obsidian }, { createFragment: dom.createFragment });
const { parseNoteStyleFile } = loadSource('export { parseNoteStyleFile } from "./ai/note-style-file";');
const i18n = S.load('i18n.ts');
const { t } = i18n;
const root = path.resolve(__dirname, '..');

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const buttonOf = (log, build) => { const el = dom.element('button'); el.hide = () => { el.hidden = true; }; el.show = () => { el.hidden = false; }; el.focus = () => { log.focused = el; }; return el; };

/** A fake Setting made of real stand-in elements, recording what the row builds. */
function fakeSetting() {
  const view = { name: '', desc: '', heading: false, buttons: [], extras: [], dropdown: undefined, texts: [], descWrites: 0, classes: [], focused: undefined };
  const descEl = dom.element('div');
  const emptyDesc = descEl.empty.bind(descEl);
  descEl.empty = () => { view.descWrites++; emptyDesc(); };
  const settingEl = dom.element('div');
  view.descEl = descEl;
  const setting = {
    descEl, settingEl, nameEl: { setText: text => { view.name = text; } },
    setName(name) { view.name = name; return this; }, setDesc(desc) { view.desc = desc; return this; }, setHeading() { view.heading = true; return this; },
    addDropdown(build) {
      const selectEl = dom.element('select'); selectEl.focus = () => { view.focused = selectEl; };
      const entry = { selectEl, disabled: false };
      view.dropdown = entry;
      build({ selectEl, addOption(value, text) { selectEl.createEl('option', { value, text }); }, setValue(value) { selectEl.value = value; return this; }, setDisabled(value) { entry.disabled = value; return this; }, onChange(fn) { entry.change = fn; return this; } });
      return this;
    },
    addButton(build) {
      const entry = { disabled: false, buttonEl: buttonOf(view) };
      entry.buttonEl.focus = () => { view.focused = entry.buttonEl; };
      view.buttons.push(entry);
      build({ setButtonText(text) { entry.text = text; entry.buttonEl.text = text; return this; }, onClick(fn) { entry.click = fn; return this; }, setDisabled(value) { entry.disabled = value; return this; }, buttonEl: entry.buttonEl });
      return this;
    },
    addExtraButton(build) {
      const extraSettingsEl = dom.element('div'); extraSettingsEl.getBoundingClientRect = () => ({ left: 10, bottom: 20 }); extraSettingsEl.focus = () => { view.focused = extraSettingsEl; };
      const entry = { disabled: false, extraSettingsEl };
      view.extras.push(entry);
      build({ extraSettingsEl, setIcon(icon) { entry.icon = icon; return this; }, setTooltip(text) { entry.tooltip = text; return this; }, onClick(fn) { entry.click = fn; return this; }, setDisabled(value) { entry.disabled = value; return this; } });
      return this;
    },
    addText(build) {
      const entry = { disabled: false, value: '', change: undefined, attrs: {} };
      view.texts.push(entry);
      build({ setPlaceholder() { return this; }, setValue(value) { entry.value = value; return this; }, setDisabled(value) { entry.disabled = value; return this; }, onChange(fn) { entry.change = fn; return this; }, getValue: () => entry.value, inputEl: { setAttr: (k, v) => { entry.attrs[k] = v; } } });
      return this;
    }
  };
  return { setting, view };
}
const lines = view => view.descEl.children.map(child => child.text);
const errorLines = view => view.descEl.children.filter(child => child.hasClass('vam-block-status-error')).map(child => child.text);
const optionsOf = view => dom.findAll(view.dropdown.selectEl, node => node.tag === 'option').map(node => [node.optionValue, node.text]);
const groupsOf = view => dom.findAll(view.dropdown.selectEl, node => node.tag === 'optgroup').map(node => ({ label: node.attrs.label, options: node.children.map(child => child.text) }));

function row({ exists = true, folder = 'WS/Styles', settings = {}, items = [] } = {}) {
  const { setting, view } = fakeSetting();
  const log = { saved: 0, opened: 0, refreshed: 0, previewed: [] };
  const settingsObject = { language: 'en', ...settings };
  const plugin = {
    settings: settingsObject, saveSettings: async () => { log.saved++; }, openNoteStylesFolder: async () => { log.opened++; },
    openPromptPreview: trigger => { log.previewed.push(trigger); },
    noteStyles: { folderExists: () => exists, folder: () => settingsObject.noteStylesFolder ?? folder, refresh: async () => {}, listBlocks: () => items }
  };
  return { setting, view, log, plugin, settings: settingsObject };
}

const item = (ref, name, extra = {}) => ({ ref, kind: ref.startsWith('builtin:') ? 'builtin' : 'file', name, modified: false, issues: [], ...extra });
const TEMPLATES = () => [item('builtin:standard', 'Standard'), item('builtin:textbook', 'Textbook')];
const TONES = () => ['academic', 'plain', 'magazine', 'summary', 'guide', 'auto'].map(id => item(`builtin:${id}`, id));

// One Structure or Voice row against a fake plugin and store; `calls` records what the controls asked of the plugin.
function blockRow(category, { settings = {}, templates = TEMPLATES(), tones = TONES(), hold = {}, pending, copyResult, onChanged } = {}) {
  const calls = [];
  const { setting, view } = fakeSetting();
  const settingsObject = { language: 'en', detailTemplates: [], ...settings };
  const plugin = {
    app: {}, settings: settingsObject, saveSettings: async () => { calls.push(['save', { ...settingsObject }]); },
    openBlock: async (...args) => { calls.push(['open', ...args]); await (hold.open ?? Promise.resolve()); return true; },
    copyBlock: async (...args) => {
      calls.push(['copy', ...args]);
      if (copyResult === null) return null;
      const name = args[2] ?? 'Copy';
      settingsObject[args[0] === 'template' ? 'noteTemplateBlock' : 'noteToneBlock'] = `file:${name}`;
      (args[0] === 'template' ? templates : tones).push(item(`file:${name}`, name, { fileName: `${name}.md` }));
      return `file:${name}`;
    },
    restoreBlock: async (...args) => { calls.push(['restore', ...args]); const target = (args[0] === 'template' ? templates : tones).find(entry => entry.ref === args[1]); delete target.fileName; target.modified = false; return true; },
    openNoteStylesFolder: async () => { calls.push(['folder']); return 'WS/Styles'; },
    noteStyles: {
      refresh: async () => {}, listBlocks: kind => (kind === 'template' ? templates : tones),
      // as the store: what is saved, else what an unfinished upgrade holds in memory
      effectiveBlockKeys: () => ({ template: settingsObject.noteTemplateBlock || pending?.template, tone: settingsObject.noteToneBlock || pending?.tone, pending: pending !== undefined })
    }
  };
  renderNoteBlockSetting(setting, plugin, category, onChanged);
  const menu = () => { const before = menus.length; view.extras[0].click(); return menus.length > before ? menus.at(-1) : undefined; };
  return { view, setting, calls, settings: settingsObject, templates, tones, plugin, menu, edit: () => view.buttons[0] };
}

test('intro: the Note style sub-page opens with a plain row (not a heading) holding the help line and a muted Preview AI instructions button that gets the focus back', () => {
  const { setting, view, log, plugin } = row();
  renderNoteStyleIntro(setting, plugin);
  assert.notEqual(view.heading, true, 'an ordinary row, not a heading');
  assert.equal(view.desc, t('ui.settings_note_style_intro'));
  assert.equal(view.desc, 'Default structure and voice for AI notes. A map or topic that sets its own wins.');
  assert.equal(view.buttons.length, 1);
  assert.equal(view.buttons[0].text, 'Preview AI instructions');
  assert.equal(view.buttons[0].buttonEl.hasClass('mod-muted'), true);
  view.buttons[0].click();
  assert.deepEqual(log.previewed, [view.buttons[0].buttonEl]);
});
test('File location row: the folder path (read-only), a Show in file explorer button, and "no files yet" until a file exists', async () => {
  const none = row({ items: TEMPLATES() });
  renderNoteLocationSetting(none.setting, none.plugin, () => { none.log.refreshed++; });
  assert.equal(none.view.name, 'File location');
  assert.equal(none.view.desc, t('ui.note_style_location_desc'), 'before the files are read nothing is claimed');
  await flush();
  assert.equal(none.view.desc, 'No files yet. The first edit or save creates them.');
  assert.equal(none.view.texts[0].disabled, true);
  assert.equal(none.view.texts[0].value, 'WS/Styles');
  assert.equal(none.view.buttons.length, 1);
  assert.equal(none.view.buttons[0].text, 'Show in file explorer');
  await none.view.buttons[0].click();
  assert.equal(none.log.opened, 1);
  const some = row({ items: [...TEMPLATES(), item('file:Mine', 'Mine', { fileName: 'Mine.md' })] });
  renderNoteLocationSetting(some.setting, some.plugin, () => {});
  await flush();
  assert.equal(some.view.desc, 'Structures and voices you edited or created are stored here.');
  // a folder never made and never chosen is not "not found"
  const fresh = row({ exists: false, items: TEMPLATES() });
  renderNoteLocationSetting(fresh.setting, fresh.plugin, () => {});
  await flush();
  assert.equal(fresh.view.name, 'File location');
  assert.equal(fresh.view.desc, 'No files yet. The first edit or save creates them.');
});

test('File location row: a chosen folder that is gone says so and can be chosen again (only the words changed)', async () => {
  const { setting, view, log, plugin, settings } = row({ exists: false, settings: { noteStylesFolder: 'WS/Old' }, items: TEMPLATES() });
  renderNoteLocationSetting(setting, plugin, () => { log.refreshed++; });
  assert.match(view.name, /File location not found/);
  assert.equal(view.texts[0].disabled, false);
  view.texts[0].change(' WS/Moved ');
  await view.buttons[0].click();
  assert.equal(settings.noteStylesFolder, 'WS/Moved');
  assert.equal(log.refreshed, 1);
  assert.equal(view.buttons[1].text, 'Show in file explorer');
});

test('Structure and Voice rows: one Edit button and one more-actions button per row, no disabled button, aria names tell the rows apart', async () => {
  const template = blockRow('template');
  await flush();
  assert.equal(template.view.name, 'Structure');
  assert.equal(template.view.buttons.length, 1, 'one ordinary button');
  assert.equal(template.view.extras.length, 1, 'one more-actions button');
  assert.equal(template.edit().text, 'Edit');
  assert.equal(template.edit().buttonEl.attrs['aria-label'], 'Edit note structure');
  assert.equal(template.view.extras[0].icon, 'more-horizontal');
  assert.equal(template.view.extras[0].tooltip, 'More actions: structure');
  assert.equal(template.view.extras[0].extraSettingsEl.attrs['aria-label'], 'More actions: structure');
  assert.equal(template.view.dropdown.selectEl.attrs['aria-label'], 'Note style structure');
  assert.equal(template.view.descEl.attrs['aria-live'], 'polite');
  const tone = blockRow('tone');
  assert.equal(tone.view.name, 'Voice');
  assert.equal(tone.edit().buttonEl.attrs['aria-label'], 'Edit writing voice');
  assert.equal(tone.view.extras[0].tooltip, 'More actions: voice');
  assert.equal(tone.view.extras[0].extraSettingsEl.attrs['aria-label'], 'More actions: voice');
  assert.equal(tone.view.dropdown.selectEl.attrs['aria-label'], 'Note style voice');
  for (const view of [template.view, tone.view]) assert.ok([...view.buttons, ...view.extras].every(control => control.disabled === false), 'nothing is shown disabled while idle');
});

test('the picker has a Built-in group, and a Mine group only when own files exist; a changed built-in is marked, a block with a problem too', async () => {
  const only = blockRow('template');
  assert.deepEqual(groupsOf(only.view), [{ label: 'Built-in', options: ['Standard', 'Textbook'] }]);
  const bad = item('file:Bad', 'Bad', { fileName: 'Bad.md', issues: [{ line: 7, code: 'format_heading_repeated', values: [], message: 'x' }] });
  const both = blockRow('template', { templates: [item('builtin:standard', 'Standard', { modified: true, fileName: 'Standard.md' }), item('builtin:textbook', 'Textbook'), item('file:Mine', 'Mine', { fileName: 'Mine.md' }), bad] });
  assert.deepEqual(groupsOf(both.view), [{ label: 'Built-in', options: ['Standard (modified)', 'Textbook'] }, { label: 'Mine', options: ['Mine', 'Bad (has a problem)'] }]);
  assert.equal(blockRow('tone').view.dropdown.selectEl.children[0].children.length, 6);
});

test('first line says what the block does (built-in hints for every structure and voice, "created yourself" for own files); no file-state sentences', async () => {
  for (const id of ['standard', 'textbook'])
    assert.deepEqual(lines(blockRow('template', { settings: { noteTemplateBlock: `builtin:${id}` } }).view), [t(`ui.note_style_${id}_hint`)]);
  for (const id of ['academic', 'plain', 'magazine', 'summary', 'guide', 'auto'])
    assert.deepEqual(lines(blockRow('tone', { settings: { noteToneBlock: `builtin:${id}` } }).view), [t(`ui.tone_hint_${id}`)], id);
  assert.equal(lines(blockRow('tone').view)[0], 'Neutral, precise, evidence-first, no opinions. The default voice; adds no instruction.');
  const own = blockRow('template', { settings: { noteTemplateBlock: 'file:Mine' }, templates: [...TEMPLATES(), item('file:Mine', 'Mine', { fileName: 'Mine.md' })] });
  assert.deepEqual(lines(own.view), ['A structure you created yourself.']);
  const ownTone = blockRow('tone', { settings: { noteToneBlock: 'file:Calm' }, tones: [...TONES(), item('file:Calm', 'Calm', { fileName: 'Calm.md' })] });
  assert.deepEqual(lines(ownTone.view), ['A voice you created yourself.']);
  for (const row of [own, ownTone, blockRow('template'), blockRow('tone')]) assert.ok(!/Built-in version|matches the built-in|disabled/i.test(lines(row.view).join(' ')));
});

test('state: empty (no files) — built-in group only, menu offers Save as my own… and Show in file explorer, no Restore', async () => {
  const state = blockRow('template');
  const menu = state.menu();
  assert.deepEqual(menu.titles, ['Save as my own…', 'Show in file explorer']);
  assert.deepEqual(JSON.parse(JSON.stringify(menu.position)), { x: 10, y: 20 });
  assert.equal(blockRow('tone').menu().titles.includes('Restore built-in'), false);
});

test('state: modified — marked in the picker, second line says the AI uses your version, the menu gets Restore built-in', async () => {
  const state = blockRow('template', { templates: [item('builtin:standard', 'Standard', { modified: true, fileName: 'Standard.md' }), item('builtin:textbook', 'Textbook')] });
  assert.deepEqual(lines(state.view), [t('ui.note_style_standard_hint'), 'You edited this built-in structure; AI writes with your version.']);
  assert.deepEqual(errorLines(state.view), []);
  assert.deepEqual(state.menu().titles, ['Save as my own…', 'Restore built-in', 'Show in file explorer']);
  const tone = blockRow('tone', { tones: TONES().map(entry => (entry.ref === 'builtin:plain' ? { ...entry, modified: true, fileName: 'Plain.md' } : entry)), settings: { noteToneBlock: 'builtin:plain' } });
  assert.equal(lines(tone.view)[1], 'You edited this built-in voice; AI writes with your version.');
  assert.ok(tone.menu().titles.includes('Restore built-in'));
});

test('state: has a problem — error line with the line number and the built-in it falls back to, in the error style; Edit stays', async () => {
  const bad = item('file:Bad', 'Bad', { fileName: 'Bad.md', issues: [{ line: 7, code: 'format_heading_repeated', values: [], message: 'x' }] });
  const state = blockRow('template', { settings: { noteTemplateBlock: 'file:Bad' }, templates: [...TEMPLATES(), bad] });
  const [error] = errorLines(state.view);
  assert.match(error, /^⚠ Line 7: /);
  assert.match(error, /Until it is fixed, AI uses the built-in "Standard"\.$/);
  assert.equal(state.edit().buttonEl.hidden, false);
  for (const language of ['zh-TW', 'zh-CN']) {
    i18n.setUiLanguage(language);
    const text = t('ui.block_status_issue_template_0_1', 12, '原因。');
    assert.match(text, /第 12 行/);
    assert.match(text, /(標準|标准)/);
    assert.match(t('ui.block_status_issue_tone_0_1', 3, '原因。'), /(學術嚴謹|学术严谨)/);
  }
  i18n.setUiLanguage('en');
});

test('state: own file — in the Mine group, first line says you created it, the menu has no Restore built-in', async () => {
  const state = blockRow('template', { settings: { noteTemplateBlock: 'file:Mine' }, templates: [...TEMPLATES(), item('file:Mine', 'Mine', { fileName: 'Mine.md' })] });
  assert.equal(state.view.dropdown.selectEl.value, 'file:Mine');
  assert.deepEqual(state.menu().titles, ['Save as my own…', 'Show in file explorer']);
});

test('state: not found — "Not found: X" is shown and selected, no Edit, an error line, the menu offers only Show in file explorer, and the saved value is never rewritten', async () => {
  const state = blockRow('template', { settings: { noteTemplateBlock: 'file:Gone' } });
  await flush();
  assert.equal(state.view.dropdown.selectEl.value, 'file:Gone');
  assert.deepEqual(optionsOf(state.view)[0], ['file:Gone', 'Not found: Gone']);
  assert.equal(state.edit().buttonEl.hidden, true, 'no Edit button');
  assert.deepEqual(lines(state.view), ['⚠ "Gone" was not found; AI is using the built-in "Standard". Pick another from the menu.']);
  assert.deepEqual(errorLines(state.view), lines(state.view));
  assert.deepEqual(state.menu().titles, ['Show in file explorer']);
  assert.equal(state.settings.noteTemplateBlock, 'file:Gone');
  assert.equal(state.calls.length, 0, 'nothing was saved');
  // the other row acting does not write the standard template over the missing choice
  const tone = blockRow('tone', { settings: { noteTemplateBlock: 'file:Gone' } });
  await flush();
  await tone.view.dropdown.change('builtin:guide');
  assert.equal(tone.settings.noteToneBlock, 'builtin:guide');
  assert.equal(tone.settings.noteTemplateBlock, 'file:Gone', 'the missing structure stays as it was saved');
  // choosing another block brings Edit back
  await state.view.dropdown.change('builtin:textbook');
  assert.equal(state.settings.noteTemplateBlock, 'builtin:textbook');
  assert.equal(state.edit().buttonEl.hidden, false);
  assert.equal(optionsOf(state.view).some(option => /Not found/.test(option[1])), false);
});

test('the rows show what the old default stands for, and nothing is written until the user acts', async () => {
  const summary = blockRow('tone', { settings: { defaultNoteStyleId: 'summary' } });
  assert.equal(summary.view.dropdown.selectEl.value, 'builtin:summary');
  const valueOf = (category, settings) => blockRow(category, { settings }).view.dropdown.selectEl.value;
  assert.equal(valueOf('template', { defaultNoteStyleId: 'summary' }), 'builtin:standard');
  assert.equal(valueOf('template', { defaultNoteStyleId: 'textbook' }), 'builtin:textbook');
  assert.equal(valueOf('template', { defaultDetailTemplateId: 'textbook' }), 'builtin:textbook');
  assert.equal(valueOf('tone', {}), 'builtin:academic');
  assert.equal(summary.calls.length, 0);
  assert.equal(summary.settings.noteToneBlock, undefined);
});

test('changing a picker writes both shown values into the settings', async () => {
  const tone = blockRow('tone', { settings: { defaultNoteStyleId: 'textbook' } });
  await tone.view.dropdown.change('builtin:guide');
  assert.equal(tone.settings.noteTemplateBlock, 'builtin:textbook');
  assert.equal(tone.settings.noteToneBlock, 'builtin:guide');
  assert.equal(tone.calls.at(-1)[0], 'save');
});

test('M1: the rows show the blocks the runs use, also while an upgrade has not been saved', async () => {
  const pending = { template: 'file:Upgraded', tone: 'file:Calm' };
  const templates = [...TEMPLATES(), item('file:Upgraded', 'Upgraded')];
  const tones = [...TONES(), item('file:Calm', 'Calm')];
  assert.equal(blockRow('template', { pending, templates, tones }).view.dropdown.selectEl.value, 'file:Upgraded');
  assert.equal(blockRow('tone', { pending, templates, tones }).view.dropdown.selectEl.value, 'file:Calm');
});

test('M1: after a failed upgrade, changing only the tone does not write the standard template over the pending one', async () => {
  const pending = { template: 'file:Upgraded' };
  const templates = [...TEMPLATES(), item('file:Upgraded', 'Upgraded')];
  const tone = blockRow('tone', { pending, templates });
  await tone.view.dropdown.change('builtin:guide');
  assert.equal(tone.settings.noteToneBlock, 'builtin:guide');
  assert.equal(tone.settings.noteTemplateBlock, undefined, 'the pending template stays unsaved, so a retry still writes it');
  const open = blockRow('template', { pending, templates });
  await open.edit().click();
  assert.equal(open.settings.noteTemplateBlock, undefined);
  assert.equal(open.calls.find(call => call[0] === 'open')[2], 'file:Upgraded');
});

test('Edit asks the plugin, locks every control meanwhile (a second press does nothing) and gets the focus back', async () => {
  let release;
  const hold = { open: new Promise(resolve => { release = resolve; }) };
  const open = blockRow('template', { hold });
  const pending = open.edit().click();
  await flush();
  assert.deepEqual(open.calls.map(call => call[0]), ['save', 'open']);
  assert.deepEqual(open.calls[1], ['open', 'template', 'builtin:standard']);
  assert.equal(open.settings.noteTemplateBlock, 'builtin:standard', 'the shown values were written first');
  assert.equal(open.settings.noteToneBlock, 'builtin:academic');
  assert.ok(open.edit().disabled && open.view.extras[0].disabled && open.view.dropdown.disabled, 'everything is off while it runs');
  assert.equal(open.menu(), undefined, 'the menu does not open while an action runs');
  await open.edit().click();
  assert.equal(open.calls.filter(call => call[0] === 'open').length, 1);
  release();
  await pending;
  assert.equal(open.view.dropdown.disabled, false);
  assert.equal(open.view.focused, open.edit().buttonEl);
});

test('Save as my own…: asks for a name (default "<name> (my version)", a taken name is refused as typed), then saves, selects the new file and opens it', async () => {
  modals.length = 0;
  const state = blockRow('template', { templates: [...TEMPLATES(), item('file:Taken', 'Taken', { fileName: 'Taken.md' })] });
  state.menu().items[0].click();
  assert.equal(modals.length, 1);
  const modal = modals[0];
  assert.equal(modal.titleText, 'Save as my own');
  assert.equal(modal.value, 'Standard (my version)');
  assert.equal(modal.options.problem('taken'), t('ui.block_name_taken'), 'case-insensitive, existing file');
  assert.equal(modal.options.problem('Textbook'), t('ui.block_name_taken'), 'a built-in name');
  assert.equal(modal.options.problem('Standard'), t('ui.block_name_taken'));
  assert.equal(modal.options.problem('Weekly report'), '');
  assert.equal(state.calls.length, 0, 'nothing is written before the name is confirmed');
  modal.submit('Weekly report');
  await flush();
  assert.deepEqual(state.calls.filter(call => call[0] !== 'save'), [['copy', 'template', 'builtin:standard', 'Weekly report'], ['open', 'template', 'file:Weekly report']]);
  assert.equal(state.settings.noteTemplateBlock, 'file:Weekly report');
  assert.equal(state.view.dropdown.selectEl.value, 'file:Weekly report', 'the new file is selected');
  assert.equal(state.view.focused, state.view.dropdown.selectEl);
  assert.equal(state.templates.filter(entry => entry.kind === 'builtin').length, 2);
});

test('Save as my own…: when the plugin could not save (name taken meanwhile), the new file is not opened and the choice does not change', async () => {
  modals.length = 0;
  const state = blockRow('template', { copyResult: null });
  state.menu().items[0].click();
  modals[0].submit('Anything');
  await flush();
  assert.deepEqual(state.calls.filter(call => call[0] !== 'save').map(call => call[0]), ['copy']);
  assert.equal(state.settings.noteTemplateBlock, 'builtin:standard', 'still the block that was shown');
});

test('Restore built-in: no confirmation, the plugin restores, and with nothing left to restore the menu loses the item', async () => {
  modals.length = 0;
  const state = blockRow('template', { templates: [item('builtin:standard', 'Standard', { modified: true, fileName: 'Standard.md' }), item('builtin:textbook', 'Textbook')] });
  const restore = state.menu().items.find(entry => entry.title === 'Restore built-in');
  await restore.click();
  assert.equal(modals.length, 0, 'no confirmation dialog');
  assert.deepEqual(state.calls.find(call => call[0] === 'restore'), ['restore', 'template', 'builtin:standard']);
  assert.deepEqual(state.menu().titles, ['Save as my own…', 'Show in file explorer']);
  assert.equal(state.view.focused, state.view.extras[0].extraSettingsEl, 'focus returns to the more-actions button');
});

test('Show in file explorer (menu) asks the plugin and keeps the focus on the more-actions button', async () => {
  const state = blockRow('tone');
  await state.menu().items.at(-1).click();
  await flush();
  assert.deepEqual(state.calls.map(call => call[0]), ['folder']);
  assert.equal(state.view.focused, state.view.extras[0].extraSettingsEl);
});

// After the upgrade the default is a block: no "(old style file)" item.
test('after the upgrade the default is a block: no "(old style file)" item in either row, the block is selected and the voice row stays usable', async () => {
  const upgraded = { settings: { defaultNoteStyleId: 'style:Mine', noteTemplateBlock: 'file:Mine', noteToneBlock: 'builtin:plain' }, templates: [...TEMPLATES(), item('file:Mine', 'Mine', { fileName: 'Mine.md' })] };
  const template = blockRow('template', upgraded);
  assert.equal(template.view.dropdown.selectEl.value, 'file:Mine');
  assert.equal(optionsOf(template.view).some(option => option[0] === 'legacy:' || /old style file/.test(option[1])), false);
  assert.doesNotMatch(lines(template.view).join(' '), /old style file/);
  assert.equal(template.edit().disabled, false);
  const tone = blockRow('tone', upgraded);
  assert.equal(tone.view.dropdown.selectEl.value, 'builtin:plain');
  assert.equal(tone.view.dropdown.disabled, false, 'the voice row is not turned off by an old default any more');
  assert.equal(tone.edit().disabled, false);
  await tone.menu().items[0].click();
  assert.equal(modals.at(-1).value, 'plain (my version)', 'Save as acts on the shown voice');
  await template.view.dropdown.change('builtin:textbook');
  assert.equal(template.settings.noteTemplateBlock, 'builtin:textbook');
  assert.equal(template.settings.noteToneBlock, 'builtin:plain', 'the other shown value is kept');
});

test('a default that is not a built-in and has no block key yet shows the standard template (O2 is gone: there is no old-style-file item)', async () => {
  const oldTemplate = blockRow('template', { settings: { defaultNoteStyleId: 'u1', detailTemplates: [{ id: 'u1', name: 'Old one' }] } });
  assert.equal(oldTemplate.view.dropdown.selectEl.value, 'builtin:standard');
  assert.equal(optionsOf(oldTemplate.view).length, 2);
  assert.equal(optionsOf(oldTemplate.view).some(option => /Old one|legacy/.test(option.join(' '))), false);
  assert.equal(oldTemplate.calls.length, 0, 'nothing is written until the user acts');
});

test('the settings page has no tone presets row and the modal file no longer offers the settings renderer', () => {
  const tab = fs.readFileSync(path.join(root, 'ui/settings-tab.ts'), 'utf8');
  assert.ok(!/tone_presets|renderTonePresetsSetting|LEGACY_PICK|legacyName/.test(tab));
  const modal = fs.readFileSync(path.join(root, 'ui/modals/prompt-presets-modal.ts'), 'utf8');
  assert.ok(!/renderTonePresetsSetting|ui\.tone_preset|"tone"/.test(modal), 'the library lists outline presets only');
});

test('every style-file problem has a translated message in en, zh-TW and zh-CN, with the limits filled in', () => {
  const bad = {
    file_long: `---\n圖表: 關\n---\n## A\n${'x'.repeat(8100)}`,
    tone_long: `---\n語氣: ${'x'.repeat(1100)}\n---\n## A\nx`,
    frontmatter_unclosed: '---\n圖表: 關\n## A\nx',
    // P2: frontmatter_line and value_invalid are no longer raised by the parser (the old switches are skipped there)
    no_sections: 'just text',
    count_invalid: '## A\n數量: abc\nx',
    comment_unclosed: '## A\n%% never closed\nx'
  };
  for (const [code, text] of Object.entries(bad)) {
    const parsed = parseNoteStyleFile(text, { id: 'x', name: 'x' });
    assert.equal(parsed.ok, false, code);
    const issue = parsed.issues.find(item => item.code === code);
    assert.ok(issue, `${code} is reported`);
    for (const language of ['en', 'zh-TW', 'zh-CN']) {
      i18n.setUiLanguage(language);
      const shown = styleIssueText(issue);
      assert.ok(shown && !/ui\.|\{\d\}/.test(shown), `${code} ${language}: ${shown}`);
    }
  }
  i18n.setUiLanguage('en');
});

test('the old template library is gone from the code and the dictionaries', () => {
  assert.ok(!fs.existsSync(path.join(root, 'ui/modals/detail-templates-modal.ts')));
  for (const language of ['en', 'zh-TW', 'zh-CN']) assert.ok(!fs.readFileSync(path.join(root, `i18n/${language}.ts`), 'utf8').includes('"ui.note_style_custom"'));
});


test('FB1 L2/B2: the row description is written only when its text changes, and the row carries the wrapping class', async () => {
  const state = blockRow('template');
  await flush();
  assert.deepEqual(state.setting.settingEl.classes, ['vam-block-row']);
  const writes = state.view.descWrites;
  assert.ok(writes >= 1);
  await state.edit().click();
  await flush();
  assert.equal(state.view.descWrites, writes, 'an action that leaves the text alone does not write it twice (aria-live)');
  const css = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
  assert.match(css, /^\.vam-block-row > \.setting-item-control \{[^}]*flex-wrap: wrap/m);
  assert.match(css, /^\.vam-block-row \.vam-block-status-error \{ color: var\(--text-error\); \}/m);
});

// ---- the plugin methods behind the menu: Save as my own and Restore built-in ----
function pluginSelf(store) {
  const opened = [];
  const file = new obsidian.TFile('WS/Styles/Backups/Standard backup.md');
  const self = { noteStyles: store, app: { vault: { getAbstractFileByPath: path => (path === file.path ? file : null) }, workspace: { getLeaf: () => ({ openFile: async target => { opened.push(target); } }) } } };
  return { self, opened, file };
}

test('plugin copyBlock: passes the chosen name, says "Saved as … and switched to it", and returns the new ref; a refusal writes nothing, says so and returns null', async () => {
  notices.length = 0;
  const asked = [];
  const ok = pluginSelf({ copyBlock: async (...args) => { asked.push(args); return 'file:Weekly report'; } });
  assert.equal(await Plugin.prototype.copyBlock.call(ok.self, 'template', 'builtin:standard', 'Weekly report'), 'file:Weekly report');
  assert.deepEqual(asked, [['template', 'builtin:standard', 'Weekly report']]);
  assert.deepEqual(notices, ['Saved as "Weekly report" and switched to it.']);
  notices.length = 0;
  const refused = pluginSelf({ copyBlock: async () => { throw new Error('Block name not available'); } });
  assert.equal(await Plugin.prototype.copyBlock.call(refused.self, 'template', 'builtin:standard', 'Standard'), null);
  assert.deepEqual(notices, [t('ui.block_notice_copy_failed')]);
});

test('plugin restoreBlock: the Notice names the backup and carries an Open backup button that opens it; failures keep their own Notices', async () => {
  notices.length = 0;
  const done = pluginSelf({ restoreBlock: async () => ({ ok: true, backup: 'WS/Styles/Backups/Standard backup.md' }) });
  assert.equal(await Plugin.prototype.restoreBlock.call(done.self, 'template', 'builtin:standard'), true);
  const notice = obsidian.Notice.all.at(-1);
  assert.equal(notices.at(-1), 'Restored the built-in version. Your version is backed up at WS/Styles/Backups/Standard backup.md.');
  assert.equal(notice.actions.length, 1);
  assert.equal(notice.actions[0].text, 'Open backup');
  notice.actions[0].click();
  await flush();
  assert.deepEqual(done.opened, [done.file], 'the backup is opened in a tab');
  notices.length = 0;
  const failing = pluginSelf({ restoreBlock: async () => ({ ok: false, reason: 'backup-failed' }) });
  assert.equal(await Plugin.prototype.restoreBlock.call(failing.self, 'template', 'builtin:standard'), false);
  assert.deepEqual(notices, [t('ui.block_notice_restore_backup_failed')]);
});


test('plugin openBlock: a file that Edit just made says "Created … edit, save, next AI notes use it" (path included); an existing file says "Opened"', async () => {
  const file = new obsidian.TFile('WS/Styles/Blocks/Templates/Standard.md');
  const make = created => {
    const self = { noteStyles: { ensureBlockFile: async () => ({ path: file.path, base: 'Standard', created }) }, app: { vault: { getAbstractFileByPath: p => (p === file.path ? file : null) }, workspace: { getLeaf: () => ({ openFile: async () => {} }) } } };
    return self;
  };
  notices.length = 0;
  assert.equal(await Plugin.prototype.openBlock.call(make(true), 'template', 'builtin:standard'), true);
  assert.deepEqual(notices, ['Created "Standard" for you to edit: WS/Styles/Blocks/Templates/Standard.md. Save your changes and the next AI notes will use it.']);
  notices.length = 0;
  await Plugin.prototype.openBlock.call(make(false), 'template', 'builtin:standard');
  assert.deepEqual(notices, ['Opened WS/Styles/Blocks/Templates/Standard.md']);
  assert.equal(t('ui.block_notice_created_0_1', 'Standard', 'P'), 'Created "Standard" for you to edit: P. Save your changes and the next AI notes will use it.');
  for (const language of ['zh-TW', 'zh-CN']) {
    const text = i18n.translate(language, 'ui.block_notice_created_0_1', '標準', 'WS/標準.md');
    assert.ok(text.includes('標準') && text.includes('WS/標準.md'), language);
  }
  assert.equal(i18n.translate('zh-TW', 'ui.block_notice_created_0_1', 'A', 'B'), '已建立可編輯的「A」：B。改完存檔，下次 AI 寫筆記就會用。');
});

test('Low 2: the standard structure hint states the effect only, in three languages (no "same as today\'s default")', () => {
  assert.equal(t('ui.note_style_standard_hint'), 'Six fixed sections in a neutral, evidence-first voice.');
  assert.equal(i18n.translate('zh-TW', 'ui.note_style_standard_hint'), '六個固定分類，中性、以證據為本。');
  assert.equal(i18n.translate('zh-CN', 'ui.note_style_standard_hint'), '六个固定分类，中性、以证据为本。');
});

test('Low 4: after Edit or Save as makes a file, the File location description is rewritten without reopening the page', async () => {
  const items = TEMPLATES();
  const loc = row({ items });
  const update = renderNoteLocationSetting(loc.setting, loc.plugin, () => {});
  await flush();
  assert.equal(loc.view.desc, 'No files yet. The first edit or save creates them.');
  const block = blockRow('template', { templates: items, onChanged: () => update() });
  await block.edit().click();
  assert.equal(loc.view.desc, 'No files yet. The first edit or save creates them.', 'Edit made no file here');
  items.push(item('file:Mine', 'Mine', { fileName: 'Mine.md' }));
  let changed = 0;
  const saved = blockRow('template', { templates: items, onChanged: () => { changed++; update(); } });
  await saved.edit().click();
  await flush();
  assert.equal(changed, 1);
  assert.equal(loc.view.desc, 'Structures and voices you edited or created are stored here.');
});

// P3: the "By topic type" block (heading plus six pickers).
const KIND_TEMPLATES = () => [
  item('builtin:standard', 'Standard'), item('builtin:textbook', 'Textbook'), item('builtin:hypothesis', 'Hypothesis structure'),
  item('builtin:evidence', 'Evidence structure'), item('builtin:action', 'Action structure'), item('builtin:atomic', 'Atomic note structure')
];
function kindRow(kind, { settings = {}, templates = KIND_TEMPLATES() } = {}) {
  const { setting, view } = fakeSetting();
  const saves = [];
  const settingsObject = { language: 'en', ...settings };
  const plugin = {
    settings: settingsObject, saveSettings: async () => { saves.push(JSON.stringify(settingsObject.noteTemplateByKind ?? null)); },
    noteStyles: { refresh: async () => {}, listBlocks: () => templates }
  };
  renderNoteKindSetting(setting, plugin, kind);
  return { view, setting, settings: settingsObject, saves };
}
const KIND_ORDER = ['topic', 'atomic', 'hypothesis', 'evidence', 'conclusion', 'action'];

test('By topic type: a sub-heading with its help line, then six pickers named after the types, each defaulting to "Not set" and having no buttons', async () => {
  const { setting, view } = fakeSetting();
  renderNoteKindHeading(setting);
  assert.equal(view.heading, true);
  assert.equal(view.name, 'By topic type');
  assert.match(view.desc, /still wins/);
  for (const kind of KIND_ORDER) {
    const row = kindRow(kind);
    await flush();
    assert.equal(row.view.name, t(`ui.topic_kind_${kind}`));
    assert.equal(row.view.dropdown.selectEl.value, '');
    assert.deepEqual(optionsOf(row.view)[0], ['', 'Not set (use the map or default structure)']);
    assert.equal(row.view.buttons.length + row.view.extras.length, 0, 'only a picker');
    assert.deepEqual(lines(row.view), []);
  }
  const source = fs.readFileSync(path.join(root, 'ui/settings-tab.ts'), 'utf8');
  const order = source.match(/const KIND_ROWS[^=]*= (\[[^\]]*\])/)[1];
  assert.deepEqual(JSON.parse(order.replace(/\s/g, '')), KIND_ORDER);
});

test('By topic type: the Suggested group exists only for atomic, hypothesis, evidence and action, holds its own built-in, and the Built-in group drops it', async () => {
  for (const kind of KIND_ORDER) {
    const row = kindRow(kind, { templates: [...KIND_TEMPLATES(), item('file:Mine', 'Mine', { fileName: 'Mine.md' })] });
    await flush();
    const groups = groupsOf(row.view);
    const suggested = groups.find(group => group.label === 'Suggested');
    if (['atomic', 'hypothesis', 'evidence', 'action'].includes(kind)) {
      const name = { atomic: 'Atomic note structure', hypothesis: 'Hypothesis structure', evidence: 'Evidence structure', action: 'Action structure' }[kind];
      assert.deepEqual(suggested.options, [name], kind);
      assert.equal(groups.find(group => group.label === 'Built-in').options.includes(name), false, kind);
      assert.equal(groups[0].label, 'Suggested');
    } else {
      assert.equal(suggested, undefined, kind);
      assert.equal(groups.find(group => group.label === 'Built-in').options.length, 6, kind);
    }
    assert.deepEqual(groups.at(-1), { label: 'Mine', options: ['Mine'] });
  }
});

test('By topic type: choosing writes the ref; "Not set" deletes the kind and, when empty, the whole key', async () => {
  const a = kindRow('hypothesis');
  await flush();
  await a.view.dropdown.change('builtin:hypothesis');
  assert.deepEqual({ ...a.settings.noteTemplateByKind }, { hypothesis: 'builtin:hypothesis' });
  const b = kindRow('evidence', { settings: { noteTemplateByKind: { hypothesis: 'builtin:hypothesis', evidence: 'builtin:evidence' } } });
  await flush();
  assert.equal(b.view.dropdown.selectEl.value, 'builtin:evidence');
  await b.view.dropdown.change('');
  assert.deepEqual({ ...b.settings.noteTemplateByKind }, { hypothesis: 'builtin:hypothesis' });
  assert.equal(b.view.dropdown.selectEl.value, '');
  const c = kindRow('hypothesis', { settings: { noteTemplateByKind: { hypothesis: 'builtin:hypothesis' } } });
  await flush();
  await c.view.dropdown.change('');
  assert.equal('noteTemplateByKind' in c.settings, false, 'no empty object is left in data.json');
  assert.equal(c.saves.length, 1);
  const d = kindRow('topic');
  await flush();
  await d.view.dropdown.change('');
  assert.equal('noteTemplateByKind' in d.settings, false);
});

test('By topic type: every picker is named "Note structure for <type>" (zh-TW: "<類型>的筆記結構")', async () => {
  for (const kind of KIND_ORDER) {
    const row = kindRow(kind);
    assert.equal(row.view.dropdown.selectEl.attrs['aria-label'], `Note structure for ${t(`ui.topic_kind_${kind}`)}`);
  }
  assert.equal(i18n.translate('zh-TW', 'ui.note_style_kind_row_aria_0', i18n.translate('zh-TW', 'ui.topic_kind_hypothesis')), '假設的筆記結構');
  assert.equal(new Set(KIND_ORDER.map(kind => kindRow(kind).view.dropdown.selectEl.attrs['aria-label'])).size, 6);
});

test('By topic type: a structure that is gone shows "Not found: X" selected with an error line and is not rewritten; a file with a problem is marked with its first issue', async () => {
  const gone = kindRow('hypothesis', { settings: { noteTemplateByKind: { hypothesis: 'file:Gone' } } });
  await flush();
  assert.equal(gone.view.dropdown.selectEl.value, 'file:Gone');
  assert.deepEqual(optionsOf(gone.view)[1], ['file:Gone', 'Not found: Gone']);
  assert.deepEqual(lines(gone.view), ['⚠ ' + t('ui.note_style_kind_missing_0_1', 'Hypothesis', 'Gone')]);
  assert.deepEqual(errorLines(gone.view), lines(gone.view));
  assert.equal(gone.settings.noteTemplateByKind.hypothesis, 'file:Gone');
  assert.equal(gone.saves.length, 0);
  const bad = kindRow('action', {
    settings: { noteTemplateByKind: { action: 'file:Broken' } },
    templates: [...KIND_TEMPLATES(), item('file:Broken', 'Broken', { fileName: 'Broken.md', issues: [{ line: 3, code: 'format_heading_repeated', values: [], message: 'x' }] })]
  });
  await flush();
  assert.equal(bad.view.dropdown.selectEl.value, 'file:Broken');
  assert.deepEqual(optionsOf(bad.view).find(option => option[0] === 'file:Broken'), ['file:Broken', 'Broken (has a problem)']);
  assert.equal(lines(bad.view).length, 1);
  assert.match(lines(bad.view)[0], /^⚠ Line 3:/);
  assert.deepEqual(errorLines(bad.view), lines(bad.view));
});

test('By topic type: a user file named Evidence, saved as file:Evidence, is a listed file option and the row does not say it is missing', async () => {
  const row = kindRow('evidence', {
    settings: { noteTemplateByKind: { evidence: 'file:Evidence' } },
    templates: [...KIND_TEMPLATES(), item('file:Evidence', 'Evidence', { fileName: 'Evidence.md' })]
  });
  await flush();
  assert.equal(row.view.dropdown.selectEl.value, 'file:Evidence');
  assert.equal(optionsOf(row.view).some(option => /Not found/.test(option[1])), false);
  assert.deepEqual(lines(row.view), []);
  assert.deepEqual(groupsOf(row.view).at(-1), { label: 'Mine', options: ['Evidence'] });
});

test('By topic type: the problem line names the actual stand-in (a broken own file: Standard; a broken built-in override: that built-in) in every language', async () => {
  const issue = [{ line: 3, code: 'format_heading_repeated', values: [], message: 'x' }];
  const own = kindRow('action', {
    settings: { noteTemplateByKind: { action: 'file:Broken' } },
    templates: [...KIND_TEMPLATES(), item('file:Broken', 'Broken', { fileName: 'Broken.md', issues: issue })]
  });
  await flush();
  assert.match(lines(own.view)[0], /^⚠ Line 3: .* Until it is fixed, topics of this type use the built-in "Standard"\.$/);
  const override = kindRow('action', {
    settings: { noteTemplateByKind: { action: 'builtin:action' } },
    templates: KIND_TEMPLATES().map(entry => (entry.ref === 'builtin:action' ? { ...entry, modified: true, issues: issue } : entry))
  });
  await flush();
  assert.match(lines(override.view)[0], /use the built-in "Action structure"\.$/);
  assert.equal(i18n.translate('zh-TW', 'ui.note_style_kind_issue_0_1_2', 3, 'X。', '標準'), '⚠ 第 3 行：X。修好之前，這個類型的議題會先用內建的「標準」。');
  assert.equal(i18n.translate('zh-CN', 'ui.note_style_kind_issue_0_1_2', 3, 'X。', '标准'), '⚠ 第 3 行：X。修好之前，这个类型的议题会先用内置的“标准”。');
  const gone = kindRow('hypothesis', { settings: { noteTemplateByKind: { hypothesis: 'file:Gone' } } });
  await flush();
  assert.ok(lines(gone.view)[0].startsWith('⚠ '));
});

test('the upper Structure row explains the four new built-ins (every language, en within 80 characters)', async () => {
  for (const id of ['hypothesis', 'evidence', 'action', 'atomic']) {
    const state = blockRow('template', { settings: { noteTemplateBlock: `builtin:${id}` }, templates: [...TEMPLATES(), item(`builtin:${id}`, id)] });
    await flush();
    assert.deepEqual(lines(state.view), [t(`ui.note_style_${id}_hint`)]);
    assert.ok(t(`ui.note_style_${id}_hint`).length <= 80, id);
    for (const lang of ['zh-TW', 'zh-CN']) assert.notEqual(i18n.translate(lang, `ui.note_style_${id}_hint`), i18n.translate('en', `ui.note_style_${id}_hint`));
  }
});
