// P4: the settings "Note style" row (04: now the folder row plus the Template and Tone rows), the style-file problem texts in every language, and the dead template UI is gone.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const S = require('./support.cjs');
const { loadSource } = require('./support-replay.cjs');

const obsidian = { ...S.obsidian, PluginSettingTab: class { hide() {} }, Setting: class {}, Modal: class {} };
const { renderNoteStyleSetting, renderNoteBlockSetting } = S.load('ui/settings-tab.ts', { obsidian });
const { styleIssueText } = S.load('experiences/visual-map/note-style-picker.ts', { obsidian });
const { parseNoteStyleFile } = loadSource('export { parseNoteStyleFile } from "./ai/note-style-file";');
const i18n = S.load('i18n.ts');
const root = path.resolve(__dirname, '..');

function row({ exists, folder = 'WS/Styles', settings = {} } = {}) {
  const log = { name: '', desc: '', texts: [], buttons: [], saved: 0, opened: 0, refreshed: 0 };
  const setting = {
    nameEl: { setText: text => { log.name = text; } },
    setName(name) { log.name = name; return this; }, setDesc(desc) { log.desc = desc; return this; },
    addText(build) {
      const entry = { disabled: false, value: '', change: undefined, attrs: {} };
      log.texts.push(entry);
      build({ setPlaceholder() { return this; }, setValue(value) { entry.value = value; return this; }, setDisabled(value) { entry.disabled = value; return this; }, onChange(fn) { entry.change = fn; return this; }, getValue: () => entry.value, inputEl: { setAttr: (k, v) => { entry.attrs[k] = v; } } });
      return this;
    },
    addButton(build) {
      const entry = {};
      log.buttons.push(entry);
      build({ setButtonText(text) { entry.text = text; return this; }, onClick(fn) { entry.click = fn; return this; }, buttonEl: {} });
      return this;
    }
  };
  const settingsObject = { language: 'en', ...settings };
  const plugin = {
    settings: settingsObject, saveSettings: async () => { log.saved++; }, openNoteStylesFolder: async () => { log.opened++; },
    noteStyles: { folderExists: () => exists, folder: () => settingsObject.noteStylesFolder ?? folder },
    openPromptPreview: () => { log.previewed = (log.previewed ?? 0) + 1; }
  };
  renderNoteStyleSetting(setting, plugin, () => { log.refreshed++; });
  return { log, settings: settingsObject };
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const item = (ref, name, extra = {}) => ({ ref, kind: ref.startsWith('builtin:') ? 'builtin' : 'file', name, modified: false, issues: [], ...extra });
const TEMPLATES = () => [item('builtin:standard', 'Standard'), item('builtin:textbook', 'Textbook')];
const TONES = () => ['academic', 'plain', 'magazine', 'summary', 'guide', 'auto'].map(id => item(`builtin:${id}`, id));

// One Template or Tone row against a fake plugin and store; `calls` records what the buttons asked of the plugin.
function blockRow(category, { settings = {}, templates = TEMPLATES(), tones = TONES(), hold = {}, pending } = {}) {
  const calls = [];
  const view = { options: [], value: undefined, disabled: false, attrs: {}, focused: 0, buttons: [], desc: '', descAttrs: {}, name: '', classes: [], descWrites: 0 };
  const settingsObject = { language: 'en', detailTemplates: [], ...settings };
  const setting = {
    descEl: { setAttr: (k, v) => { view.descAttrs[k] = v; } },
    settingEl: { addClass: name => { view.classes.push(name); } },
    setName(name) { view.name = name; return this; }, setDesc(desc) { view.desc = desc; view.descWrites++; return this; },
    addDropdown(build) {
      build({
        selectEl: { replaceChildren() { view.options = []; }, setAttr: (k, v) => { view.attrs[k] = v; }, focus() { view.focused++; view.focusedEl = 'select'; } },
        addOption(id, name) { view.options.push([id, name]); }, setValue(value) { view.value = value; return this; },
        setDisabled(value) { view.disabled = value; return this; }, onChange(fn) { view.change = fn; return this; }
      });
      return this;
    },
    addButton(build) {
      const entry = { disabled: false, attrs: {} };
      view.buttons.push(entry);
      entry.buttonEl = { setAttr: (k, v) => { entry.attrs[k] = v; }, getAttribute: k => entry.attrs[k], focus() { view.focusedEl = entry.text; } };
      build({ setButtonText(text) { entry.text = text; return this; }, onClick(fn) { entry.click = fn; return this; }, setDisabled(value) { entry.disabled = value; return this; }, buttonEl: entry.buttonEl });
      return this;
    }
  };
  const plugin = {
    settings: settingsObject, saveSettings: async () => { calls.push(['save', { ...settingsObject }]); },
    openBlock: async (...args) => { calls.push(['open', ...args]); await (hold.open ?? Promise.resolve()); return true; },
    copyBlock: async (...args) => { calls.push(['copy', ...args]); settingsObject[args[0] === 'template' ? 'noteTemplateBlock' : 'noteToneBlock'] = 'file:Copy'; (args[0] === 'template' ? templates : tones).push(item('file:Copy', 'Copy')); return 'file:Copy'; },
    restoreBlock: async (...args) => { calls.push(['restore', ...args]); const target = (args[0] === 'template' ? templates : tones).find(entry => entry.ref === args[1]); delete target.fileName; target.modified = false; return true; },
    noteStyles: {
      refresh: async () => {}, listBlocks: kind => (kind === 'template' ? templates : tones),
      // as the store: what is saved, else what an unfinished upgrade holds in memory
      effectiveBlockKeys: () => ({ template: settingsObject.noteTemplateBlock || pending?.template, tone: settingsObject.noteToneBlock || pending?.tone, pending: pending !== undefined })
    }
  };
  renderNoteBlockSetting(setting, plugin, category);
  return { view, calls, settings: settingsObject, templates, tones };
}

test('settings row: read-only folder path, open-folder and preview buttons, no picker of its own', async () => {
  const { log } = row({ exists: true });
  assert.equal(log.texts[0].disabled, true);
  assert.equal(log.texts[0].value, 'WS/Styles');
  assert.equal(log.dropdown, undefined);
  assert.equal(log.buttons[0].text, 'Open block folder');
  await log.buttons[0].click();
  assert.equal(log.opened, 1);
  assert.equal(log.buttons[1].text, 'Preview full prompt');
});

test('Template and Tone rows: pickers with a label, the built-ins first, a changed built-in marked', async () => {
  const template = blockRow('template', { templates: [item('builtin:standard', 'Standard', { modified: true, fileName: 'Standard.md' }), item('builtin:textbook', 'Textbook'), item('file:Mine', 'Mine', { fileName: 'Mine.md' })] });
  await flush();
  assert.equal(template.view.name, 'Template');
  assert.equal(template.view.attrs['aria-label'], 'Note style template');
  assert.equal(template.view.descAttrs['aria-live'], 'polite');
  assert.deepEqual(template.view.options, [['builtin:standard', 'Standard (modified)'], ['builtin:textbook', 'Textbook'], ['file:Mine', 'Mine']]);
  assert.deepEqual(template.view.buttons.map(button => button.text), ['Open', 'Copy', 'Restore default']);
  const tone = blockRow('tone');
  assert.equal(tone.view.name, 'Tone');
  assert.equal(tone.view.attrs['aria-label'], 'Note style tone');
  assert.equal(tone.view.options.length, 6);
});

test('the rows show what the old default stands for, and nothing is written until the user acts', async () => {
  const summary = blockRow('tone', { settings: { defaultNoteStyleId: 'summary' } });
  assert.equal(summary.view.value, 'builtin:summary');
  assert.equal(blockRow('template', { settings: { defaultNoteStyleId: 'summary' } }).view.value, 'builtin:standard');
  assert.equal(blockRow('template', { settings: { defaultNoteStyleId: 'textbook' } }).view.value, 'builtin:textbook');
  assert.equal(blockRow('template', { settings: { defaultDetailTemplateId: 'textbook' } }).view.value, 'builtin:textbook');
  assert.equal(blockRow('tone', { settings: {} }).view.value, 'builtin:academic');
  assert.equal(summary.calls.length, 0);
  assert.equal(summary.settings.noteToneBlock, undefined);
  const gone = blockRow('template', { settings: { noteTemplateBlock: 'file:Deleted' } });
  assert.equal(gone.view.value, 'builtin:standard', 'a chosen block that is gone shows as the standard template, as the run falls back');
});

test('changing a picker writes both shown values into the settings', async () => {
  const tone = blockRow('tone', { settings: { defaultNoteStyleId: 'textbook' } });
  await tone.view.change('builtin:guide');
  assert.equal(tone.settings.noteTemplateBlock, 'builtin:textbook');
  assert.equal(tone.settings.noteToneBlock, 'builtin:guide');
  assert.equal(tone.calls.at(-1)[0], 'save');
});

test('M1: the rows show the blocks the runs use, also while an upgrade has not been saved', async () => {
  const pending = { template: 'file:Upgraded', tone: 'file:Calm' };
  const templates = [...TEMPLATES(), item('file:Upgraded', 'Upgraded')];
  const tones = [...TONES(), item('file:Calm', 'Calm')];
  assert.equal(blockRow('template', { pending, templates, tones }).view.value, 'file:Upgraded');
  assert.equal(blockRow('tone', { pending, templates, tones }).view.value, 'file:Calm');
});

test('M1: after a failed upgrade, changing only the tone does not write the standard template over the pending one', async () => {
  const pending = { template: 'file:Upgraded' };
  const templates = [...TEMPLATES(), item('file:Upgraded', 'Upgraded')];
  const tone = blockRow('tone', { pending, templates });
  await tone.view.change('builtin:guide');
  assert.equal(tone.settings.noteToneBlock, 'builtin:guide');
  assert.equal(tone.settings.noteTemplateBlock, undefined, 'the pending template stays unsaved, so a retry still writes it');
  const open = blockRow('template', { pending, templates });
  await open.view.buttons[0].click();
  assert.equal(open.settings.noteTemplateBlock, undefined);
  assert.equal(open.calls.find(call => call[0] === 'open')[2], 'file:Upgraded');
});

test('Restore default is off, aria-disabled and explained when it does not apply', async () => {
  const none = blockRow('template');
  const restore = none.view.buttons[2];
  assert.equal(restore.disabled, true);
  assert.equal(restore.attrs['aria-disabled'], 'true');
  assert.match(none.view.desc, /no file yet/);
  assert.equal(none.view.buttons[0].disabled, false);
  const own = blockRow('template', { settings: { noteTemplateBlock: 'file:Mine' }, templates: [...TEMPLATES(), item('file:Mine', 'Mine', { fileName: 'Mine.md' })] });
  assert.equal(own.view.buttons[2].disabled, true);
  assert.match(own.view.desc, /Your own block/);
  const changed = blockRow('template', { templates: [item('builtin:standard', 'Standard', { modified: true, fileName: 'Standard.md' }), item('builtin:textbook', 'Textbook')] });
  assert.equal(changed.view.buttons[2].disabled, false);
  assert.equal(changed.view.buttons[2].attrs['aria-disabled'], 'false');
  assert.match(changed.view.desc, /backup first/);
});

test('an unreadable template block says which line, in the row text', async () => {
  const bad = item('file:Bad', 'Bad', { fileName: 'Bad.md', issues: [{ line: 7, code: 'format_heading_repeated', values: [], message: 'x' }] });
  const view = blockRow('template', { settings: { noteTemplateBlock: 'file:Bad' }, templates: [...TEMPLATES(), bad] }).view;
  assert.match(view.desc, /Bad\.md cannot be read \(line 7\)/);
});

test('Open, Copy and Restore ask the plugin, lock the buttons meanwhile and keep focus where it belongs', async () => {
  let release;
  const hold = { open: new Promise(resolve => { release = resolve; }) };
  const open = blockRow('template', { hold });
  const pending = open.view.buttons[0].click();
  await flush();
  assert.deepEqual(open.calls.map(call => call[0]), ['save', 'open']);
  assert.deepEqual(open.calls[1], ['open', 'template', 'builtin:standard']);
  assert.equal(open.settings.noteTemplateBlock, 'builtin:standard', 'the shown values were written first');
  assert.equal(open.settings.noteToneBlock, 'builtin:academic');
  assert.ok(open.view.buttons.every(button => button.disabled) && open.view.disabled, 'everything is off while it runs');
  await open.view.buttons[0].click();
  assert.equal(open.calls.filter(call => call[0] === 'open').length, 1, 'a second press while busy does nothing');
  release();
  await pending;
  assert.equal(open.view.disabled, false);
  assert.equal(open.view.focusedEl, 'Open');

  const copy = blockRow('tone');
  await copy.view.buttons[1].click();
  assert.deepEqual(copy.calls.find(call => call[0] === 'copy'), ['copy', 'tone', 'builtin:academic']);
  assert.equal(copy.view.value, 'file:Copy', 'the new block is selected');
  assert.equal(copy.view.focusedEl, 'select');

  const restore = blockRow('template', { templates: [item('builtin:standard', 'Standard', { modified: true, fileName: 'Standard.md' }), item('builtin:textbook', 'Textbook')] });
  await restore.view.buttons[2].click();
  assert.deepEqual(restore.calls.find(call => call[0] === 'restore'), ['restore', 'template', 'builtin:standard']);
  assert.equal(restore.view.buttons[2].disabled, true, 'nothing left to restore');
  assert.equal(restore.view.focusedEl, 'select', 'focus moves to the picker when the button turns off');
});

// 06 P4: the old "an old style file as the default" item is gone (the upgrade moves the file to a template block and writes the keys).
test('after the upgrade the default is a block: no "(old style file)" item in either row, the block is selected and the tone row stays usable', async () => {
  const upgraded = { settings: { defaultNoteStyleId: 'style:Mine', noteTemplateBlock: 'file:Mine', noteToneBlock: 'builtin:plain' }, templates: [...TEMPLATES(), item('file:Mine', 'Mine', { fileName: 'Mine.md' })] };
  const template = blockRow('template', upgraded);
  assert.equal(template.view.value, 'file:Mine');
  assert.equal(template.view.options.some(option => option[0] === 'legacy:' || /old style file/.test(option[1])), false);
  assert.doesNotMatch(template.view.desc, /old style file/);
  assert.equal(template.view.buttons[0].disabled, false);
  const tone = blockRow('tone', upgraded);
  assert.equal(tone.view.value, 'builtin:plain');
  assert.equal(tone.view.disabled, false, 'the tone row is not turned off by an old default any more');
  assert.ok(tone.view.buttons.slice(0, 2).every(button => button.disabled === false));
  assert.doesNotMatch(tone.view.desc, /old style file/);
  await tone.view.buttons[1].click();
  assert.deepEqual(tone.calls.find(call => call[0] === 'copy'), ['copy', 'tone', 'builtin:plain'], 'Copy acts on the shown tone');
  await template.view.change('builtin:textbook');
  assert.equal(template.settings.noteTemplateBlock, 'builtin:textbook');
  assert.equal(template.settings.noteToneBlock, 'builtin:plain', 'the other shown value is kept');
});

test('a default that is not a built-in and has no block key yet shows the standard template (O2 is gone: there is no old-style-file item)', async () => {
  const oldTemplate = blockRow('template', { settings: { defaultNoteStyleId: 'u1', detailTemplates: [{ id: 'u1', name: 'Old one' }] } });
  assert.equal(oldTemplate.view.value, 'builtin:standard');
  assert.equal(oldTemplate.view.options.length, 2);
  assert.equal(oldTemplate.view.options.some(option => /Old one|legacy/.test(option.join(' '))), false);
  assert.equal(oldTemplate.calls.length, 0, 'nothing is written until the user acts');
});

test('the settings page has no tone presets row and the modal file no longer offers the settings renderer', () => {
  const tab = fs.readFileSync(path.join(root, 'ui/settings-tab.ts'), 'utf8');
  assert.ok(!/tone_presets|renderTonePresetsSetting|LEGACY_PICK|legacyName/.test(tab));
  const modal = fs.readFileSync(path.join(root, 'ui/modals/prompt-presets-modal.ts'), 'utf8');
  assert.ok(!/renderTonePresetsSetting|ui\.tone_preset|"tone"/.test(modal), 'the library lists outline presets only');
});

test('settings row: a missing folder says so and can be chosen again', async () => {
  const { log, settings } = row({ exists: false });
  assert.match(log.name, /Style folder not found/);
  assert.equal(log.texts[0].disabled, false);
  log.texts[0].change(' WS/Moved ');
  await log.buttons[0].click();
  assert.equal(settings.noteStylesFolder, 'WS/Moved');
  assert.equal(log.refreshed, 1);
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
  const row = blockRow('template');
  await flush();
  assert.deepEqual(row.view.classes, ['vam-block-row']);
  const writes = row.view.descWrites;
  assert.ok(writes >= 1);
  await row.view.buttons[0].click();
  await flush();
  assert.equal(row.view.descWrites, writes, 'an action that leaves the text alone does not write it twice (aria-live)');
  const css = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'styles.css'), 'utf8');
  assert.match(css, /^\.vam-block-row > \.setting-item-control \{[^}]*flex-wrap: wrap/m);
});
