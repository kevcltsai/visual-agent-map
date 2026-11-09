// UI audit bugfix-2, packet P5 (AI panel, styles, English leftovers): the synthesis name and reasoning labels follow the
// interface language, the usage filter and debug log are localized, the style editor and style rows show readable text,
// and a saved chat style asks before it is removed. The selection-AI reading-view and insert-here cases live in steps-markdown.cjs.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { load } = require('./support.cjs');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const dictionary = file => Object.values(load(file)).find(value => value && typeof value === 'object' && 'coffee.unreadable' in value);
const LANGUAGES = ['i18n/en.ts', 'i18n/zh-TW.ts', 'i18n/zh-CN.ts'];
const NEW_KEYS = [
  'ui.context_ai_inserted_after', 'ui.context_ai_accept_unavailable', 'ui.editor_sections_none', 'ui.note_style_part_unknown_0',
  'ui.usage_filter_total', 'ui.ai_status_preparing', 'ui.ai_status_sent', 'ui.ai_status_received', 'ui.ai_status_parsed',
  'ui.ai_status_completed', 'ui.ai_status_failed', 'coffee.delete_style_confirm_title', 'coffee.delete_style_confirm_body'
];

// style-editor-empty-raw-english / style-summary-raw-refs / usage / debug log / confirm: every new key exists in all three languages.
test('P5 i18n: every new key is in en, zh-TW and zh-CN, and the zh-TW text is Chinese', () => {
  for (const file of LANGUAGES) {
    const dict = dictionary(file);
    for (const key of NEW_KEYS) assert.equal(typeof dict[key], 'string', `${key} in ${file}`);
  }
  const zh = dictionary('i18n/zh-TW.ts');
  for (const key of NEW_KEYS) if (!key.includes('ai_status_') || key.endsWith('failed')) assert.match(zh[key], /[一-鿿]/, key);
  assert.equal(zh['ui.usage_filter_total'], '全部');
  assert.equal(zh['ui.editor_sections_none'], '至少需要一個段落。');
});

// synthesis (wording part of synthesis-name-prefill-english): the reasoning labels and content hints are Chinese in zh-TW.
// The prefilled name itself is not changed here: the map text language rule (tests/steps-i18n-fixed-text.cjs) decides it.
test('P5 synthesis: zh-TW reasoning labels and content hints have no English leftovers', () => {
  const zh = dictionary('i18n/zh-TW.ts');
  for (const key of ['ui.low', 'ui.medium', 'ui.high', 'ui.auto']) assert.doesNotMatch(zh[key], /[A-Za-z]/, key);
  assert.doesNotMatch(zh['ui.synthesis_content_full_hint'], /Detail/);
  assert.doesNotMatch(zh['ui.synthesis_content_summary_hint'], /Detail/);
  assert.doesNotMatch(dictionary('i18n/zh-CN.ts')['ui.synthesis_content_full_hint'], /Detail/);
});

// usage-filter-total-english: the all-providers option goes through i18n; no hard-coded "Total" remains.
test('P5 usage: the all-providers filter option is translated, not hard-coded', () => {
  const source = read('experiences/visual-map/usage-panel.ts');
  assert.doesNotMatch(source, /"Total"/);
  assert.match(source, /t\("ui\.usage_filter_total"\)/);
});

// debug-log-time-english-format: times use the interface locale, and the exchange status is translated.
test('P5 debug log: times use the interface locale and the status word is translated', () => {
  const source = read('ui/modals/debug-log-modal.ts');
  assert.doesNotMatch(source, /toLocaleString\(\)/);
  assert.equal((source.match(/toLocaleString\(getUiLanguage\(\)\)/g) || []).length, 2);
  assert.match(source, /t\(EXCHANGE_STATUS_KEYS\[exchange\.status\]\)/);
});

// style-summary-raw-refs: an unknown part shows its bare name marked as not found, never the builtin:/file: reference.
test('P5 style summary: an unknown part is named without its builtin:/file: reference', () => {
  const store = read('ai/note-style-store.ts');
  assert.doesNotMatch(store, /\{ ref, name: ref \}/);
  assert.match(store, /ui\.note_style_part_unknown_0/);
  const settings = read('ui/settings-tab.ts');
  assert.match(settings, /found\?\.name \?\? t\("ui\.note_style_part_unknown_0"/);
  const language = dictionary('i18n/zh-TW.ts')['ui.note_style_part_unknown_0'];
  assert.equal(language, '{0}（找不到）');
});

// style-editor-empty-raw-english: removing every section shows the Chinese reason and an empty sample, not the parser's English.
test('P5 style editor: removing every section gives a translated reason and an empty sample', () => {
  const source = read('ui/modals/note-style-editor-modal.ts');
  assert.match(source, /if \(!rows\.length\) return say\(t\("ui\.editor_sections_none"\)\);/);
  assert.match(source, /if \(this\.sectionsEdited\(\) && this\.cleanRows\(\)\.length === 0\) \{\s*host\.empty\(\);/);
});

// ct-style-delete-no-confirm: deleting a saved chat style asks first, and the removal runs only after the confirm.
test('P5 chat style delete: a confirm dialog runs before the style is removed', () => {
  const source = read('experiences/coffee-tables/view.ts');
  const handler = source.slice(source.indexOf('this.button(styleActions, this.t("coffee.delete_style")'), source.indexOf('this.button(styleActions, this.t("coffee.default_for_new_tables")'));
  const confirmAt = handler.indexOf('new CoffeeStyleDeleteModal(');
  const removeAt = handler.indexOf('this.changeCoffeeStyles(');
  assert.ok(confirmAt > 0 && removeAt > confirmAt, 'the confirm comes before the removal');
  assert.match(handler, /if \(!\(await new CoffeeStyleDeleteModal\(this\.app, items\[index\]\.name, this\.plugin\.settings\.language\)\.confirm\(\)\)\)\s*return;/);
});
