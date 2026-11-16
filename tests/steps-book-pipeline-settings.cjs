// Picture-book model menus on the settings page (05): three dropdowns with the AI dropdown's model list, defaults, writes, unavailable values.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const S = require('./support.cjs');
const { obsidian, DEFAULT_SETTINGS } = S;
const M = S.load('i18n.ts');
const tab = S.load('ui/settings-tab.ts', { obsidian });

globalThis.Option = class { constructor(text, value) { this.text = text; this.value = value; this.disabled = false; } };
const fakeSelect = () => {
  const select = { options: [], attrs: {}, isConnected: true, value: '',
    add(o) { this.options.push(o); }, replaceChildren() { this.options = []; }, setAttribute(k, v) { this.attrs[k] = v; } };
  return select;
};
function render(settings, models, spec) {
  const saved = [];
  const select = fakeSelect();
  let onChange;
  const setting = { setName() { return this; }, setDesc() { return this; }, addDropdown(fn) { fn({ selectEl: select, onChange: cb => { onChange = cb; } }); return this; } };
  const plugin = { settings, availableModels: () => models, modelLabel: id => id.toUpperCase(), saveSettings: async () => { saved.push({ ...settings }); } };
  tab.renderBookModelSetting(setting, plugin, spec, () => {});
  return { select, saved, change: v => onChange(v) };
}
const [PLAN, WRITE, PROOF] = tab.BOOK_MODEL_SETTINGS;

test('three book model settings exist with the defaults planning haiku, author and proofread sonnet', () => {
  assert.deepEqual(S.plain(tab.BOOK_MODEL_SETTINGS.map(s => s.key)), ['bookPlanModel', 'bookWriteModel', 'bookProofModel']);
  assert.equal(DEFAULT_SETTINGS.bookPlanModel, 'claude:haiku');
  assert.equal(DEFAULT_SETTINGS.bookWriteModel, 'claude:sonnet');
  assert.equal(DEFAULT_SETTINGS.bookProofModel, 'claude:sonnet');
  const r = render({ ...DEFAULT_SETTINGS }, ['claude:haiku', 'claude:sonnet'], PLAN);
  assert.equal(r.select.value, 'claude:haiku');
});

test('options come from the same list, order and label as the AI model dropdown, and each dropdown has an accessible name', () => {
  const models = ['claude:sonnet', 'codex:gpt', 'claude:haiku'];
  const book = render({ ...DEFAULT_SETTINGS }, models, WRITE);
  const ref = fakeSelect(); ref.value = 'claude:sonnet';
  S.load('core/model-discovery.ts').syncModelSelect(ref, models, id => id.toUpperCase(), M.translate('en', 'ui.current_model_is_unavailable'));
  assert.deepEqual(book.select.options.map(o => [o.text, o.value]), ref.options.map(o => [o.text, o.value]));
  assert.equal(book.select.attrs['aria-label'], M.translate('en', WRITE.name));
});

test('a change writes the matching setting only and saves; cliModel is untouched', () => {
  const settings = { ...DEFAULT_SETTINGS };
  const r = render(settings, ['claude:haiku', 'claude:sonnet', 'codex:x'], PROOF);
  r.change('codex:x');
  assert.equal(settings.bookProofModel, 'codex:x');
  assert.equal(settings.bookPlanModel, DEFAULT_SETTINGS.bookPlanModel);
  assert.equal(settings.bookWriteModel, DEFAULT_SETTINGS.bookWriteModel);
  assert.equal(settings.cliModel, DEFAULT_SETTINGS.cliModel);
  assert.equal(r.saved.length, 1);
  r.change('');
  assert.equal(settings.bookProofModel, 'codex:x', 'an empty value is ignored');
});

test('a value missing from the list stays shown, is marked unavailable and is not rewritten', () => {
  const settings = { ...DEFAULT_SETTINGS, bookPlanModel: 'claude:gone' };
  const r = render(settings, ['claude:haiku'], PLAN);
  assert.equal(r.select.value, 'claude:gone');
  const gone = r.select.options.find(o => o.value === 'claude:gone');
  assert.ok(gone.disabled && gone.text.includes(M.translate('en', 'ui.current_model_is_unavailable')));
  assert.equal(settings.bookPlanModel, 'claude:gone');
  assert.equal(r.saved.length, 0);
});

test('the page has a Picture book heading inside the AI group with the three rows and the next-run note; cliModel wiring and the config port stay as they were', () => {
  const root = path.join(__dirname, '..');
  const src = fs.readFileSync(path.join(root, 'ui/settings-tab.ts'), 'utf8');
  assert.match(src, /setName\(t\("ui\.settings_group_book"\)\)\.setHeading\(\)[\s\S]*BOOK_MODEL_SETTINGS\.map[\s\S]*ui\.settings_book_note/);
  assert.match(src, /key === "cliModel"\) \{\s*if \(typeof value === "string"\) await this\.plugin\.setCurrentModel\(value\)/);
  const main = fs.readFileSync(path.join(root, 'main.ts'), 'utf8');
  assert.match(main, /config: \(\) => \(\{\s*planModel: this\.settings\.bookPlanModel/);
});

test('every new string exists in en, zh-TW and zh-CN; Chinese uses mind map wording only where it mentions the map', () => {
  const keys = ['group_book', 'book_plan_name', 'book_plan_desc', 'book_write_name', 'book_write_desc', 'book_proof_name', 'book_proof_desc', 'book_note'].map(k => `ui.settings_${k}`);
  for (const lang of ['en', 'zh-TW', 'zh-CN']) for (const k of keys) { const v = M.translate(lang, k); assert.ok(v && v !== k, `${lang} ${k}`); assert.doesNotMatch(v, /地圖|地图/); }
  assert.equal(M.translate('zh-TW', 'ui.settings_group_book'), '圖文書');
  assert.equal(M.translate('zh-CN', 'ui.settings_group_book'), '图文书');
});
