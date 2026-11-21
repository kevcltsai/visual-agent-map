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
const [PLAN, WRITE, IMAGE, PROOF] = tab.BOOK_MODEL_SETTINGS;

test('four book model settings exist with the defaults plan sonnet, author opus, pictures haiku, proofread sonnet', () => {
  assert.deepEqual(S.plain(tab.BOOK_MODEL_SETTINGS.map(s => s.key)), ['bookPlanModel', 'bookWriteModel', 'bookImageModel', 'bookProofModel']);
  assert.equal(DEFAULT_SETTINGS.bookPlanModel, 'claude:sonnet');
  assert.equal(DEFAULT_SETTINGS.bookWriteModel, 'claude:opus');
  assert.equal(DEFAULT_SETTINGS.bookImageModel, 'claude:haiku');
  assert.equal(DEFAULT_SETTINGS.bookProofModel, 'claude:sonnet');
  const r = render({ ...DEFAULT_SETTINGS }, ['claude:haiku', 'claude:sonnet'], PLAN);
  assert.equal(r.select.value, 'claude:sonnet');
  const img = render({ ...DEFAULT_SETTINGS }, ['claude:haiku', 'claude:sonnet'], IMAGE);
  assert.equal(img.select.value, 'claude:haiku');
  img.change('claude:sonnet');
  assert.equal(img.saved[0].bookImageModel, 'claude:sonnet');
  assert.equal(img.saved[0].bookWriteModel, DEFAULT_SETTINGS.bookWriteModel);
});

test('options come from the same list, order and label as the AI model dropdown, and each dropdown has an accessible name', () => {
  const models = ['claude:sonnet', 'codex:gpt', 'claude:haiku'];
  const book = render({ ...DEFAULT_SETTINGS }, models, PROOF);
  const ref = fakeSelect(); ref.value = 'claude:sonnet';
  S.load('core/model-discovery.ts').syncModelSelect(ref, models, id => id.toUpperCase(), M.translate('en', 'ui.current_model_is_unavailable'));
  assert.deepEqual(book.select.options.map(o => [o.text, o.value]), ref.options.map(o => [o.text, o.value]));
  assert.equal(book.select.attrs['aria-label'], M.translate('en', PROOF.name));
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

test('the author rules say the chapter text is required and comes first; a sources-and-notes-only result is invalid', () => {
  const { BOOK_AUTHOR_RULES, bookAuthorRequirements } = S.load('core/book-pipeline/settings.ts');
  assert.match(BOOK_AUTHOR_RULES, /chapter text itself is required and comes first in the Detail[\s\S]*only sources and notes[\s\S]*invalid/);
  assert.match(bookAuthorRequirements({}, []), /chapter text itself is required/);
});

// ---- chapter length (T10c, Bug3) ----
const L = S.load('core/book-pipeline/settings.ts');
const range = text => { const heard = []; const value = L.lengthRange(text, why => heard.push(why)); return { value: value && { ...value }, heard }; };

test('lengthRange: N–M with every separator, thousands separators, 約 N as +-20%, both units', () => {
  for (const sep of ['–', '-', '~', '～', '至', '到', ' – ']) assert.deepEqual(range(`每章 300${sep}500 字`).value, { min: 300, max: 500, unit: '字' }, sep);
  assert.deepEqual(range('每章約 300–500 字').value, { min: 300, max: 500, unit: '字' }, '約 before a range is still the range');
  assert.deepEqual(range('1,000–1,500 字').value, { min: 1000, max: 1500, unit: '字' });
  assert.deepEqual(range('about 500 words per chapter').value, { min: 400, max: 600, unit: 'words' });
  assert.deepEqual(range('每章約 1,000 字').value, { min: 800, max: 1200, unit: '字' });
  assert.deepEqual(range('300-500 words').value, { min: 300, max: 500, unit: 'words' });
  assert.deepEqual(range('300 字 – 500 字').value, { min: 300, max: 500, unit: '字' });
});

test('lengthRange: ambiguous (two ranges, mixed language), inverted and zero input mean no check and say why; plain text means no check quietly', () => {
  assert.deepEqual(range('每章 300–500 字，英文 200–300 words'), { value: undefined, heard: ['ambiguous'] });
  assert.deepEqual(range('300–500 字或 800–900 字'), { value: undefined, heard: ['ambiguous'] });
  assert.deepEqual(range('每章 500–300 字'), { value: undefined, heard: ['inverted'] });
  assert.deepEqual(range('每章 0–0 字'), { value: undefined, heard: ['invalid'] });
  assert.deepEqual(range('簡短一點'), { value: undefined, heard: [] });
  assert.deepEqual(range('2024-05 年的書'), { value: undefined, heard: [] }, 'a date is not a range: no unit follows');
  assert.deepEqual(range(undefined), { value: undefined, heard: [] });
});

test('lengthRange (review-b S6): to / and as separators, 左右 / 上下 as about, 不超過 as a maximum only, and an unread number with a unit is logged as invalid', () => {
  assert.deepEqual(range('300 to 500 words').value, { min: 300, max: 500, unit: 'words' });
  assert.deepEqual(range('between 300 and 500 words per chapter').value, { min: 300, max: 500, unit: 'words' });
  assert.deepEqual(range('每章 500 字左右'), { value: { min: 400, max: 600, unit: '字' }, heard: [] });
  assert.deepEqual(range('每章 500 字上下').value, { min: 400, max: 600, unit: '字' });
  assert.deepEqual(range('每章約 500 字左右'), { value: { min: 400, max: 600, unit: '字' }, heard: [] }, 'prefix and suffix together are one rule');
  assert.deepEqual(range('每章不超過 500 字'), { value: { min: 1, max: 500, unit: '字' }, heard: [] });
  assert.deepEqual(range('no more than 500 words'), { value: { min: 1, max: 500, unit: 'words' }, heard: [] });
  assert.equal(L.lengthReason('每章不超過 500 字', '字'.repeat(100)), undefined, 'a short chapter is never under a maximum-only rule');
  assert.equal(L.lengthReason('每章不超過 500 字', '字'.repeat(700)).kind, 'over');
  assert.deepEqual(range('每章 500 字起跳'), { value: undefined, heard: ['invalid'] }, 'a number with a unit that does not parse is heard');
  assert.deepEqual(range('簡短一點'), { value: undefined, heard: [] });
});

test('chapterLength (review-b M1): words with CJK characters dominating counts the characters plus the Latin words', () => {
  assert.equal(L.chapterLength('這是一個關於 AI 的章節，內容很長很長很長。', 'words'), 17 + 1);
  assert.equal(L.chapterLength('Mostly English words here 一點', 'words'), 4, 'Latin dominates: words only');
});

test('chapterLength: 字 counts CJK characters plus Latin words; words counts Latin words (CJK only text falls back to its characters); notes, addresses, images, markers, hidden records and callouts do not count', () => {
  assert.equal(L.chapterLength('你好，世界！', '字'), 4);
  assert.equal(L.chapterLength('你好 world 2024 年', '字'), 2 + 1 + 1 + 1);
  assert.equal(L.chapterLength('Hello brave new world, it\'s 2024.', 'words'), 6);
  assert.equal(L.chapterLength('你好，世界', 'words'), 4);
  const noisy = '正文四字\n![圖說文字](https://example.org/a.png)\n看 [連結文字](https://example.org/very/long/path) 與 https://example.org/x\n〔圖位 1：不算〕\n<!-- book-body:v1 {"fp":"0123456789abcdef"} -->\n> [!vam-review] 這是程式的框\n> 框內的字\n\n收尾';
  assert.equal(L.chapterLength(noisy, '字'), 12, 'text, the link label and the closing words only');
  assert.equal(L.chapterLength('字'.repeat(1000) + '\r\n' + '字'.repeat(1000), '字'), 2000, 'CRLF and a long text');
});

test('lengthBody (rule v2): one prose-only measure; a 200-300 chapter of 319 prose characters with a 47-character caption (366 in all) is inside the first verdict, and 320 prose is over after the fix round', () => {
  const figure = `![P1](https://upload.wikimedia.org/wikipedia/commons/a/ab/P1.jpg)\n${'圖'.repeat(47)}`;
  const chapter = prose => `${'好'.repeat(prose)}\n\n${figure}\n\n收尾。`;
  const text = chapter(317);
  assert.equal(L.chapterLength(text, '字'), 366, 'with the caption');
  assert.equal(L.chapterLength(L.lengthBody(text), '字'), 319, 'prose only');
  assert.equal(L.lengthReason('每章 200–300 字', L.lengthBody(text)), undefined, '319 is inside 1.2x 300');
  assert.equal(L.lengthReason('每章 200–300 字', text)?.kind, 'over', 'the caption would have pushed it over (the old fix-round measure)');
  const after = L.lengthReason('每章 200–300 字', L.lengthBody(chapter(318)), undefined, true);
  assert.deepEqual([after?.kind, after?.measured], ['over', 320], 'strict after the fix round, measured on prose');
  assert.equal(L.chapterLength(L.lengthBody('好%%a reader note%%\n\n> [!vam-book]- 研究筆記\n> 筆記不算'), '字'), 1, 'notes and the program\'s callout do not count');
});

test('lengthReason: above max x 1.2 is over, below min x 0.8 is under, the edges are inside; the token round-trips and carries range, unit, count and rule version', () => {
  const ask = (n, setting = '每章 100–200 字') => L.lengthReason(setting, '字'.repeat(n));
  assert.equal(ask(240), undefined); assert.equal(ask(80), undefined);
  const over = ask(241); const under = ask(79);
  assert.deepEqual({ ...over }, { min: 100, max: 200, unit: '字', kind: 'over', measured: 241, version: L.LENGTH_RULE_VERSION });
  assert.equal(under.kind, 'under');
  assert.equal(L.lengthToken(over), 'length:over:241:100-200:字:v2', 'rule v2: one prose-only measure, strict both ways after the fix round');
  assert.deepEqual({ ...L.splitLengthIssue('proof unmet: C1 length:over:241:100-200:字:v2').length }, { ...over });
  assert.equal(L.splitLengthIssue('proof unmet: C1 length:over:241:100-200:字:v1').rest, 'proof unmet: C1');
  assert.equal(L.splitLengthIssue('length unmet: length:under:79:100-200:字:v1').rest, '');
  assert.equal(L.splitLengthIssue('proof unmet: C1').length, undefined);
  assert.equal(L.lengthReason('', '字'.repeat(999)), undefined);
});

test('bookAuthorRequirements: a hard length rule line appears only when the length setting is one readable range', () => {
  assert.match(L.bookAuthorRequirements({ length: '每章 300–500 字' }), /Length \(hard requirement, measured by the program\): the chapter text must be between 300 and 500 characters \(字\); aim for about 400\./);
  assert.match(L.bookAuthorRequirements({ length: '300-500 words' }), /between 300 and 500 words/);
  assert.doesNotMatch(L.bookAuthorRequirements({ length: '短一點' }), /hard requirement/);
  assert.doesNotMatch(L.bookAuthorRequirements({ length: '300–500 字，200–300 words' }), /hard requirement/);
  assert.doesNotMatch(L.bookAuthorRequirements({ tone: 'warm' }), /hard requirement/);
});

test('bookAuthorRequirements: the length rule comes first, before the chapter rules, and a long range gets a section plan that scales with it', () => {
  const text = L.bookAuthorRequirements({ length: '每章約5000至8000字，搭配6至10張示意照片或範例圖' });
  assert.ok(text.startsWith('Length (hard requirement'), 'the length rule leads the requirements');
  assert.ok(text.indexOf('Length (hard requirement') < text.indexOf('Chapter writing rules'));
  assert.match(text, /between 5000 and 8000 characters \(字\); aim for about 6500\. Only the chapter text's own characters count \(punctuation/);
  assert.match(text, /plan it as about 7 ### sections of about 950 characters \(字\) each/);
  assert.match(text, /do not finish before the text reaches 5000 characters/);
  assert.match(text, /- length: 每章約5000至8000字/, 'the setting line itself stays');
  assert.match(L.bookAuthorRequirements({ length: '每章 10000–14000 字' }), /about 12 ### sections of about 1000 characters/);
  assert.match(L.bookAuthorRequirements({ length: '每章 30000–40000 字' }), /about 12 ### sections/, 'the plan is bounded at 12 sections');
  assert.doesNotMatch(L.bookAuthorRequirements({ length: '每章 300–500 字' }), /### sections/, 'a short chapter gets no section plan');
  assert.match(L.bookAuthorRequirements({ length: '2000-3000 words' }), /about 4 ### sections of about 650 words each/);
  assert.doesNotMatch(L.bookAuthorRequirements({ length: '不超過 8000 字' }), /### sections/, 'a maximum-only setting gets no "do not finish before" plan');
  assert.match(L.bookAuthorRequirements({ length: '不超過 8000 字' }), /between 1 and 8000 characters/);
});

test('T10c splitLengthIssue: notice tokens beside a pure length issue are part of the issue but leave no text of their own', () => {
  const s = L.splitLengthIssue('length unmet: length:over:241:100-200:字:v1 image_1 C1');
  assert.equal(s.rest, '');
  assert.equal(s.length.measured, 241);
  assert.equal(L.splitLengthIssue('proof unmet: C2 length:over:241:100-200:字:v1').rest, 'proof unmet: C2');
});
