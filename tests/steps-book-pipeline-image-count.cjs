// Picture-book pipeline: the owner's "pictures per chapter" whole-book setting (e.g. 「每章圖片 6–10 張」) reaches the card plan as a
// hard rule for every role, the program keeps the plan inside it, and the per-chapter probe limit leaves room for that many slots.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./support-replay.cjs');

const settings = load('core/book-pipeline/settings.ts');
const cardPlan = load('core/steps/book-pipeline/card-plan.ts');
const slots = load('core/book-pipeline/image-slots.ts');
const plain = value => JSON.parse(JSON.stringify(value));

const base = { model: 'claude:haiku', language: 'zh-TW', reasoning: 'low', usageMapPath: 'm.md' };
const chapters = [{ position: 1, title: '導讀' }, { position: 2, title: '睡眠週期' }, { position: 3, title: '結語' }];
const requestFor = (role, bookSettings) => ({
  ...base, thread: 't', settings: bookSettings, materials: [], chapters,
  card: { id: 'n1', position: 1, total: 3, role, title: '導讀', summary: 's' }
});
const reply = count => JSON.stringify({
  covers: 'c', points: ['p1', 'p2', 'p3'], entry: 'e', handoff: 'h', previous: '', next: '', checklist: [{ type: 'structure', text: 'Shape' }],
  cover: { explains: 'x', search: ['a b', 'c d'] },
  images: Array.from({ length: count }, (_, i) => ({ kind: 'diagram', explains: `point ${i + 1}`, anchor: `paragraph ${i + 1}` }))
});

test('imageCountRange reads the owner\'s pictures-per-chapter setting in the common phrasings, from any field', () => {
  const r = s => plain(settings.imageCountRange(s) ?? null);
  assert.deepEqual(r({ style: '每章圖片 6–10 張' }), { min: 6, max: 10 });
  assert.deepEqual(r({ length: '每章 2000–3000 字，圖片 6-10 張' }), { min: 6, max: 10 }, 'the length range is not a picture count');
  assert.deepEqual(r({ style: '每章 6～10 張圖' }), { min: 6, max: 10 });
  assert.deepEqual(r({ style: '配圖：6 到 10 張' }), { min: 6, max: 10 });
  assert.deepEqual(r({ style: '每章 8 張圖片' }), { min: 8, max: 8 });
  assert.deepEqual(r({ style: '6 to 10 pictures per chapter' }), { min: 6, max: 10 });
  assert.deepEqual(r({ style: '6-10 images each chapter' }), { min: 6, max: 10 });
  assert.deepEqual(r({ style: '圖片 6–20 張' }), { min: 6, max: slots.MAX_IMAGE_SLOTS }, 'capped at the program ceiling');
  assert.equal(r({ style: '圖文並茂' }), null, 'no number: no rule');
  assert.equal(r({ length: '每章 2000–3000 字' }), null, 'a length is not a picture count');
  assert.equal(r({ style: '圖片 10–6 張' }), null, 'inverted: no rule');
  assert.equal(r({ style: '圖片 6–10 張', goal: '每章 3 張圖' }), null, 'two different counts: no guess');
  assert.equal(r({}), null);
});

test('repro: with 「每章圖片 6–10 張」 the card plan prompt asks for 6 to 10 slots for an introduction too, not the old 0 to 2', () => {
  const owner = { style: '每章圖片 6–10 張' };
  for (const role of ['intro', 'body', 'gallery', 'closing']) {
    const prompt = cardPlan.cardPlanStep.render(requestFor(role, owner));
    assert.match(prompt, /between 6 and 10 slots/, role);
    assert.doesNotMatch(prompt, /0 to 2|never add one only to fill space/, role);
  }
  const exact = cardPlan.cardPlanStep.render(requestFor('body', { style: '每章 8 張圖片' }));
  assert.match(exact, /exactly 8 slots/);
});

test('without a pictures-per-chapter setting the card plan prompt keeps its old role-based picture rule word for word', () => {
  const prompt = cardPlan.cardPlanStep.render(requestFor('intro', { tone: 'warm' }));
  assert.match(prompt, /images: the picture plan for this chapter, 0 to 8 slots\. You decide how many and where/);
  assert.match(prompt, /an introduction or a closing needs few \(0 to 2\)/);
});

test('repro: a 10-slot plan is accepted under 6–10; more than the owner\'s maximum is cut to it; fewer than the minimum is kept as planned', () => {
  const owner = { style: '每章圖片 6–10 張' };
  assert.equal(cardPlan.cardPlanStep.parse(reply(10), requestFor('intro', owner)).images.length, 10);
  const cut = cardPlan.cardPlanStep.parse(reply(12), requestFor('body', owner)).images;
  assert.deepEqual(plain(cut.map(s => s.index)), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(cardPlan.cardPlanStep.parse(reply(4), requestFor('body', owner)).images.length, 4, 'never padded with invented slots');
  assert.equal(cardPlan.CARD_PLAN_SCHEMA.properties.images.maxItems, slots.MAX_IMAGE_SLOTS);
  assert.throws(() => cardPlan.cardPlanStep.parse(reply(slots.MAX_IMAGE_SLOTS + 1), requestFor('body', {})), /0 to 12/);
});

test('the Prompt image plan and the slot record keep all 10 slots (no hidden 8 cut)', () => {
  const planText = load('core/book-pipeline/plan-text.ts');
  const ten = Array.from({ length: 10 }, (_, i) => ({ index: i + 1, kind: 'diagram', explains: `point ${i + 1}`, anchor: `p ${i + 1}` }));
  const prompt = planText.composeCardPrompt({ role: 'body', covers: 'c', entry: 'e', handoff: 'h', checklist: [{ id: 'C1', type: 'structure', text: 'x' }], images: ten }, 'zh-TW');
  assert.equal(planText.parseImageSlots(prompt).length, 10);
  const record = slots.composeSlotsRecord({ placed: [], missing: ten.map(s => ({ index: s.index, reasonCode: 'not_found' })), bad: 0 });
  assert.equal(slots.latestSlotsRecord(record).slots.length, 10);
});
