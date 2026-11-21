// The picture-book plan blocks (root 全書企劃, a card's 提示 / Prompt) are shown; every other [!vam-book] callout stays hidden.
// The DOM folding (Range based) needs a real DOM and is checked in the UI pass; here: which callouts, the labels and the stylesheet.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { load, root } = require('./support-replay.cjs');

const view = load('core/book-pipeline/plan-view.ts');
const planText = load('core/book-pipeline/plan-text.ts');
const dom = load('experiences/visual-map/book-plan-view.ts', { obsidian: {} }, { NodeFilter: { SHOW_TEXT: 4 } });
const { zhTW } = load('i18n/zh-TW.ts');
const { zhCN } = load('i18n/zh-CN.ts');
const { en } = load('i18n/en.ts');
const env = (stage, language = 'zh-TW') => ({ language: () => language, stage: () => stage });

test('planCalloutKind: the plan titles of both languages are the root plan and the card plan; every other vam-book title is neither', () => {
  assert.deepEqual({ ...view.planCalloutKind('全書企劃') }, { kind: 'book', zh: true });
  assert.deepEqual({ ...view.planCalloutKind('Book plan') }, { kind: 'book', zh: false });
  assert.deepEqual({ ...view.planCalloutKind(' 提示 ') }, { kind: 'card', zh: true });
  assert.deepEqual({ ...view.planCalloutKind('Prompt') }, { kind: 'card', zh: false });
  for (const other of ['預覽', 'Preview', '研究備註', 'Research notes', '校對結果', '更新紀錄', '', '提示詞', '全書結構', 'prompt'])
    assert.equal(view.planCalloutKind(other), undefined, other);
});

test('fold labels and relabelled fields: stored labels are matched in both languages, a label with text after it is not a fold', () => {
  for (const w of ['圖安排', 'Image plan']) assert.ok(planText.isImagePlanLabel(w));
  for (const w of ['驗收清單', 'Acceptance checklist']) assert.ok(planText.isChecklistLabel(w));
  assert.ok(!planText.isImagePlanLabel('圖安排：無') && !planText.isChecklistLabel('圖安排'));
  assert.equal(planText.planDisplayField('接入點'), 'entry');
  assert.equal(planText.planDisplayField('留給下一張的問題'), 'handoff');
  for (const w of ['前一節', '上一章']) assert.equal(planText.planDisplayField(w), 'previous');
  for (const w of ['後一節', '下一章', '角色', 'Entry point', '所屬章']) assert.equal(planText.planDisplayField(w), undefined, w);
});

// A minimal element: enough for the early exits (no DOM Range needed).
function el(attrs, children = {}) {
  const classes = new Set(); const a = { ...attrs };
  return { classList: { add: c => classes.add(c), remove: c => classes.delete(c), has: c => classes.has(c) }, hasAttribute: n => n in a, setAttribute: (n, v) => { a[n] = v; }, matches: s => s.startsWith('.callout['), querySelector: s => children[s] ?? null, querySelectorAll: () => [], classes };
}
const title = text => ({ textContent: text });

test('markPlanCallouts: a plan callout is marked, other vam-book callouts and an untitled one are not; an empty body is only marked, not processed', () => {
  const plan = el({}, { '.callout-title-inner': title('全書企劃'), '.callout-content': { childNodes: [] } });
  dom.markPlanCallouts(plan, env()); assert.ok(plan.classes.has('vam-book-plan')); assert.ok(!plan.hasAttribute('data-vam-plan-view'), 'looked at again when rendered');
  for (const other of ['預覽', '研究備註', '校對結果', 'Research notes']) {
    const c = el({}, { '.callout-title-inner': title(other), '.callout-content': { childNodes: [{}] } });
    dom.markPlanCallouts(c, env()); assert.equal(c.classes.size, 0, other);
  }
  const untitled = el({}); dom.markPlanCallouts(untitled, env()); assert.equal(untitled.classes.size, 0);
});

test('stylesheet: vam-book stays hidden, only the marked plan block is shown, the rule order lets it win without !important', () => {
  const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  const hide = css.indexOf('.callout[data-callout="vam-book"] { display: none; }');
  const show = css.indexOf('.callout[data-callout="vam-book"].vam-book-plan { display: block; }');
  assert.ok(hide >= 0 && show > hide);
  assert.ok(css.includes('.vam-book-plan .vam-book-plan-hidden { display: none; }'));
});

const lines = (...l) => l.join('\n');
const CHAPTER = lines('角色：本文', '本章會講：x', '接入點：y', '留給下一張的問題：z', '上一章：(1) A — a', '下一章：(3) C — c', '驗收清單：', '- C1 [結構型] t');
test('cardKindOfPrompt: a parent-chapter line is a section, a chapter-level card with nothing before it is the preface, the rest are chapters', () => {
  assert.equal(planText.cardKindOfPrompt(lines('角色：本文', '所屬章：(2) B', '前一節：無', '後一節：(Next) N — n')), 'section');
  assert.equal(planText.cardKindOfPrompt(lines('Role: Body', 'Chapter: (2) B', 'Previous section: none')), 'section');
  assert.equal(planText.cardKindOfPrompt(lines('角色：導讀', '接入點：y', '上一章：無', '下一章：(1) A — a')), 'preface');
  assert.equal(planText.cardKindOfPrompt(lines('Role: Intro', 'Previous chapter: none', 'Next chapter: (1) A')), 'preface');
  assert.equal(planText.cardKindOfPrompt(CHAPTER), 'chapter');
  assert.equal(planText.cardKindOfPrompt(lines('角色：導讀', '上一章：(前言) P — p')), 'chapter', 'role alone is not the signal');
  assert.equal(planText.cardKindOfPrompt(''), 'chapter');
});

test('planStartsOpen: open before anything is written (no stage, planned, unreadable), closed once a chapter is written or later', () => {
  for (const stage of [undefined, null, 'planned', '', 7, 'bogus']) assert.equal(view.planStartsOpen(stage), true, String(stage));
  for (const stage of ['written', 'checked', 'needs-review']) assert.equal(view.planStartsOpen(stage), false, stage);
});

test('markPlanCallouts: a plan callout opens (is-collapsed removed) only while the note is unwritten; a written one keeps Obsidian\'s folded rendering; the data attribute is set once', () => {
  const make = () => {
    const c = el({}, { '.callout-title-inner': { textContent: '全書企劃' }, '.callout-content': { childNodes: [], querySelectorAll: () => [], children: [], ownerDocument: { createTreeWalker: () => ({ nextNode: () => null }) } } });
    c.classes.add('is-collapsed'); return c;
  };
  // Obsidian folds a `]-` callout three ways: the callout's class, the chevron's class and the content's inline display.
  const parts = () => {
    const style = { display: 'none', removeProperty(name) { delete this[name]; } };
    const fold = { classes: new Set(['is-collapsed']) };
    fold.classList = { remove: c => fold.classes.delete(c) };
    const content = { childNodes: [{}], children: [], style, ownerDocument: { createTreeWalker: () => ({ nextNode: () => null }) } };
    const query = s => (s === '.callout-title-inner' ? { textContent: '全書企劃' } : s === '.callout-fold' ? fold : content);
    return { style, fold, query };
  };
  const open = make(); const o = parts(); open.querySelector = o.query;
  dom.markPlanCallouts(open, env('planned'));
  assert.ok(!open.classes.has('is-collapsed')); assert.ok(!o.fold.classes.has('is-collapsed'), 'the chevron opens too');
  assert.equal(o.style.display, undefined, "the content's inline display:none is removed"); assert.ok(open.hasAttribute('data-vam-plan-view'));
  const written = make(); const w = parts(); written.querySelector = w.query;
  dom.markPlanCallouts(written, env('written'));
  assert.ok(written.classes.has('is-collapsed')); assert.ok(w.fold.classes.has('is-collapsed')); assert.equal(w.style.display, 'none', 'a written note keeps the fold');
});

test('planLocale: Chinese-stored notes follow the book language (zh-CN is not zh-TW), English-stored notes keep their stored labels', () => {
  assert.equal(view.planLocale('zh-CN', true), 'zh-CN');
  assert.equal(view.planLocale('zh-TW', true), 'zh-TW');
  assert.equal(view.planLocale('en', true), 'zh-TW');
  assert.equal(view.planLocale('zh-CN', false), 'en');
  assert.equal(view.planLocale('en', false), 'en');
});

test('planTitleKey and the titles: preface / chapter / section, in zh-TW, zh-CN and en; the book plan keeps its own title', () => {
  assert.equal(view.planTitleKey('book', 'chapter'), 'ui.book_plan_title_book');
  assert.equal(zhTW[view.planTitleKey('card', 'preface')], '前言的企劃　可以直接改');
  assert.equal(zhTW[view.planTitleKey('card', 'chapter')], '這一章的企劃　可以直接改');
  assert.equal(zhTW[view.planTitleKey('card', 'section')], '這一節的企劃　可以直接改');
  assert.equal(zhCN[view.planTitleKey('card', 'preface')], '前言的企划　可以直接改');
  assert.equal(zhCN[view.planTitleKey('card', 'chapter')], '这一章的企划　可以直接改');
  assert.equal(zhCN[view.planTitleKey('card', 'section')], '这一节的企划　可以直接改');
  assert.equal(en[view.planTitleKey('card', 'chapter')], 'Chapter plan — you can edit it here');
});

test('relabelLine: only the label text changes (value, indent and colon kept); other lines and English labels are left alone', () => {
  const t = f => ({ entry: '怎麼開場', previous: '承接的觀念', handoff: '留下的問題' })[f];
  assert.equal(view.relabelLine('接入點：一場會議', t), '怎麼開場：一場會議');
  assert.equal(view.relabelLine('  前一節: 甲 — a', t), '  承接的觀念: 甲 — a');
  assert.equal(view.relabelLine('留給下一張的問題：？', t), '留下的問題：？');
  for (const other of ['角色：本文', 'Entry point: x', '沒有冒號', '後一節：(下) B']) assert.equal(view.relabelLine(other, t), undefined, other);
});

test('foldLabelOf: a lone 圖安排 / 驗收清單 line folds (either language, either colon); text after the colon or another label does not', () => {
  assert.deepEqual({ ...view.foldLabelOf('圖安排：') }, { word: '圖安排', fold: 'images' });
  assert.deepEqual({ ...view.foldLabelOf(' Image plan: ') }, { word: 'Image plan', fold: 'images' });
  assert.deepEqual({ ...view.foldLabelOf('驗收清單:') }, { word: '驗收清單', fold: 'checklist' });
  assert.deepEqual({ ...view.foldLabelOf('Acceptance checklist：') }, { word: 'Acceptance checklist', fold: 'checklist' });
  for (const other of ['圖安排：無', '角色：', '驗收清單', '- C1 [結構型] t', '']) assert.equal(view.foldLabelOf(other), undefined, other);
});

test('the bar hints name what the owner now sees (root 全書企劃, the 企劃 of each chapter / section), not 提示', () => {
  for (const dict of [zhTW, zhCN]) for (const key of ['ui.book_bar_plan_hint', 'ui.book_bar_plan_edit_hint']) assert.ok(!dict[key].includes('提示') && /企[劃划]/.test(dict[key]) && /各节|各節/.test(dict[key]), key);
  for (const key of ['ui.book_bar_plan_hint', 'ui.book_bar_plan_edit_hint']) assert.ok(!/hint box/.test(en[key]) && /section note/.test(en[key]), key);
});
