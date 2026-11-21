// The picture-book plan blocks (root 全書企劃, a card's 提示 / Prompt) are shown; every other [!vam-book] callout stays hidden.
// The DOM folding (Range based) needs a real DOM and is checked in the UI pass; here: which callouts, the labels and the stylesheet.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { load, root } = require('./support-replay.cjs');

const view = load('core/book-pipeline/plan-view.ts');
const planText = load('core/book-pipeline/plan-text.ts');
const dom = load('experiences/visual-map/book-plan-view.ts', { obsidian: {} });

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
  return { classList: { add: c => classes.add(c), has: c => classes.has(c) }, hasAttribute: n => n in a, setAttribute: (n, v) => { a[n] = v; }, matches: s => s.startsWith('.callout['), querySelector: s => children[s] ?? null, querySelectorAll: () => [], classes };
}
const title = text => ({ textContent: text });

test('markPlanCallouts: a plan callout is marked, other vam-book callouts and an untitled one are not; an empty body is only marked, not processed', () => {
  const plan = el({}, { '.callout-title-inner': title('全書企劃'), '.callout-content': { childNodes: [] } });
  dom.markPlanCallouts(plan); assert.ok(plan.classes.has('vam-book-plan')); assert.ok(!plan.hasAttribute('data-vam-plan-view'), 'looked at again when rendered');
  for (const other of ['預覽', '研究備註', '校對結果', 'Research notes']) {
    const c = el({}, { '.callout-title-inner': title(other), '.callout-content': { childNodes: [{}] } });
    dom.markPlanCallouts(c); assert.equal(c.classes.size, 0, other);
  }
  const untitled = el({}); dom.markPlanCallouts(untitled); assert.equal(untitled.classes.size, 0);
});

test('stylesheet: vam-book stays hidden, only the marked plan block is shown, the rule order lets it win without !important', () => {
  const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  const hide = css.indexOf('.callout[data-callout="vam-book"] { display: none; }');
  const show = css.indexOf('.callout[data-callout="vam-book"].vam-book-plan { display: block; }');
  assert.ok(hide >= 0 && show > hide);
  assert.ok(css.includes('.vam-book-plan .vam-book-plan-hidden { display: none; }'));
});
