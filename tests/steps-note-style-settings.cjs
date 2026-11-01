// P4: the settings "Note style" row, the style-file problem texts in every language, and the dead template UI is gone.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const S = require('./support.cjs');
const { loadSource } = require('./support-replay.cjs');

const obsidian = { ...S.obsidian, PluginSettingTab: class { hide() {} }, Setting: class {}, Modal: class {} };
const { renderNoteStyleSetting } = S.load('ui/settings-tab.ts', { obsidian });
const { styleIssueText } = S.load('experiences/visual-map/note-style-picker.ts', { obsidian });
const { parseNoteStyleFile } = loadSource('export { parseNoteStyleFile } from "./ai/note-style-file";');
const i18n = S.load('i18n.ts');
const root = path.resolve(__dirname, '..');

function row({ exists, folder = 'WS/Styles', settings = {}, items = [], old = [] } = {}) {
  const log = { name: '', desc: '', texts: [], buttons: [], options: [], saved: 0, opened: 0, refreshed: 0 };
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
      build({ setButtonText(text) { entry.text = text; return this; }, onClick(fn) { entry.click = fn; return this; } });
      return this;
    },
    addDropdown(build) {
      const entry = { options: [], value: undefined };
      log.dropdown = entry;
      build({ selectEl: { replaceChildren() { entry.options = []; } }, addOption(id, name) { entry.options.push([id, name]); }, setValue(value) { entry.value = value; return this; }, onChange(fn) { entry.change = fn; return this; } });
      return this;
    }
  };
  const settingsObject = { language: 'en', ...settings };
  const plugin = {
    settings: settingsObject, saveSettings: async () => { log.saved++; }, openNoteStylesFolder: async () => { log.opened++; },
    noteStyles: { folderExists: () => exists, folder: () => settingsObject.noteStylesFolder ?? folder, list: () => items, unexportedTemplates: () => old, refresh: async () => {} }
  };
  renderNoteStyleSetting(setting, plugin, () => { log.refreshed++; });
  return { log, settings: settingsObject };
}

test('settings row: default dropdown, read-only folder path and the open-folder button', async () => {
  const { log, settings } = row({ exists: true, items: [{ kind: 'file', id: 'style:Mine', name: 'Mine', issues: [] }, { kind: 'file', id: 'style:Bad', name: 'Bad', issues: [{}] }], old: [{ id: 'u1', name: 'Old one' }] });
  assert.equal(log.texts[0].disabled, true);
  assert.equal(log.texts[0].value, 'WS/Styles');
  assert.deepEqual(log.dropdown.options.map(option => option[0]), ['standard', 'textbook', 'summary', 'plain', 'guide', 'style:Mine', 'u1']);
  assert.equal(log.dropdown.value, 'standard');
  log.dropdown.change('style:Mine');
  assert.equal(settings.defaultNoteStyleId, 'style:Mine');
  assert.equal(log.buttons[0].text, 'Open style folder');
  await log.buttons[0].click();
  assert.equal(log.opened, 1);
  assert.equal(row({ exists: true, settings: { defaultDetailTemplateId: 'textbook' } }).log.dropdown.value, 'textbook', 'without defaultNoteStyleId the old default is shown');
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
    frontmatter_line: '---\nno colon here\n---\n## A\nx',
    value_invalid: '---\n圖表: maybe\n---\n## A\nx',
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
