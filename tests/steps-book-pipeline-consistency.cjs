// Picture-book whole-book consistency check: the research-voice patterns (V1), the reply parser and chapter compaction, the machine
// gate (due, begin, apply, stop, resume), and the review box sentence a finding gives. The runner path is in steps-book-pipeline-run.cjs.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('./support.cjs');
const { load, loadSource } = require('./support-replay.cjs');

const prose = load('core/book-pipeline/prose-checks.ts');
const consistency = load('core/book-pipeline/consistency.ts');
const step = load('core/steps/book-pipeline/consistency.ts');
const refs = load('core/book-pipeline/chapter-references.ts');
const machine = load('core/book-pipeline/machine.ts');
const model = load('core/book-pipeline/model.ts');
const review = loadSource(`
export { reviewEntries } from "./experiences/visual-map/book-pipeline-review";
export { setUiLanguage } from "./i18n";
`, { obsidian: S.obsidian });

const plain = value => JSON.parse(JSON.stringify(value));
const NOW = '2026-11-20T00:00:00.000Z';

// ---- V1: research-voice patterns ----

test('V1 research voice: process notes about the book\'s own material are found in zh-TW, zh-CN and English', () => {
  assert.deepEqual(plain(prose.researchVoiceHits('現有資料不足，無法確認她的出生年。')), ['現有資料不足']);
  assert.deepEqual(plain(prose.researchVoiceHits('资料不足：拍摄地点不明。')), ['资料不足：']);
  assert.deepEqual(plain(prose.researchVoiceHits('這張照片的原始底片未能查到。')), ['未能查到']);
  assert.deepEqual(plain(prose.researchVoiceHits('相關紀錄查無結果。')), ['查無']);
  assert.deepEqual(plain(prose.researchVoiceHits('No data was found for the year.')), ['no data was found']);
  assert.deepEqual(plain(prose.researchVoiceHits('We could not find the original print.')), ['we could not find']);
  // A fixed phrase and the pattern hitting inside it count once.
  assert.deepEqual(plain(prose.researchVoiceHits('本次搜尋未取得蘭格的原始底片資料。')), ['本次搜尋', '搜尋未取得']);
});

test('V1 research voice: history and ordinary prose are not process notes', () => {
  for (const text of ['當時資料不足，天文學家誤判', '她在研究光線', '資料不足的年代，人們只能猜測。', 'The data from 1936 shows the light.', ''])
    assert.deepEqual(plain(prose.researchVoiceHits(text)), [], text);
});

// ---- the reply and the chapters it gets ----

const reply = issues => JSON.stringify({ issues });
const issue = (a, b, extra = {}) => ({ a, b, claimA: 'three days', claimB: 'one to two days', suggestion: 'use one range', ...extra });

test('consistency parse: a pair is kept; swapped numbers are put in order with their claims; an empty list is fine', () => {
  assert.deepEqual(plain(step.parseConsistency(reply([issue(1, 3)]), 3)), [{ a: 1, b: 3, claimA: 'three days', claimB: 'one to two days', suggestion: 'use one range' }]);
  assert.deepEqual(plain(step.parseConsistency(reply([issue(3, 1)]), 3)), [{ a: 1, b: 3, claimA: 'one to two days', claimB: 'three days', suggestion: 'use one range' }]);
  assert.deepEqual(plain(step.parseConsistency(reply([]), 2)), []);
  assert.equal(step.parseConsistency(reply(Array.from({ length: 45 }, () => issue(1, 2))), 2).length, step.CONSISTENCY_MAX_ISSUES);
});

test('consistency parse: a chapter out of range, the same chapter twice, an empty claim or an extra field fails the reply', () => {
  assert.throws(() => step.parseConsistency(reply([issue(1, 4)]), 3));
  assert.throws(() => step.parseConsistency(reply([issue(0, 2)]), 3));
  assert.throws(() => step.parseConsistency(reply([issue(2, 2)]), 3));
  assert.throws(() => step.parseConsistency(reply([issue(1.5, 2)]), 3));
  assert.throws(() => step.parseConsistency(reply([issue(1, 2, { claimA: ' ' })]), 3));
  assert.throws(() => step.parseConsistency(reply([issue(1, 2, { extra: 1 })]), 3));
  assert.throws(() => step.parseConsistency('not json', 3));
  assert.throws(() => step.consistencyStep.policy('prompt', { chapters: [{ title: 'only', text: 'x' }] }));
});

test('compactChapters: chapters that fit go whole; a long book keeps each claim with the sentence before it, its heading and table header', () => {
  const small = [{ title: 'A', text: '種子三天發芽。天氣很好。' }, { title: 'B', text: '一到兩天就會發芽。' }];
  assert.deepEqual(plain(consistency.compactChapters(small, 1000)), plain(small));
  const long = [
    { title: 'A', text: `${'風景很美。'.repeat(100)}\n\n### 小白菜\n\n小白菜很好種。種子三天發芽。風景很美。\n\n盆要深一點，深 15 公分。` },
    { title: 'B', text: `${'光線柔和。'.repeat(100)}\n\n| 蔬菜 | 從種到採收 |\n|---|---|\n| 小白菜 | 約 30 到 40 天 |\n| 青蔥 | 很快 |` }
  ];
  const out = plain(consistency.compactChapters(long, 400));
  assert.deepEqual(out.map(c => c.title), ['A', 'B']);
  assert.equal(out[0].text, '### 小白菜\n小白菜很好種。種子三天發芽。\n盆要深一點，深 15 公分。', 'the subject sentence before a number stays with it');
  assert.equal(out[1].text, '| 蔬菜 | 從種到採收 |\n| 小白菜 | 約 30 到 40 天 |', 'a table row keeps its header');
  const cut = plain(consistency.compactChapters([{ title: 'A', text: '1 天。'.repeat(500) }, { title: 'B', text: '2 天。'.repeat(500) }], 600));
  assert.ok(cut.every(c => Array.from(c.text).length <= 300));
  // A chapter with few claims leaves the rest of its share to the others.
  const uneven = plain(consistency.compactChapters([{ title: 'A', text: `${'風。'.repeat(400)}3 天。` }, { title: 'B', text: '2 天。'.repeat(500) }], 600));
  assert.equal(uneven[0].text, '風。3 天。');
  assert.equal(Array.from(uneven[1].text).length, 600 - Array.from(uneven[0].text).length);
});

test('compactChapters: the budget sends a mid-size book (six chapters of about 6000 characters, v4) whole', () => {
  const book = Array.from({ length: 6 }, (_, i) => ({ title: `C${i}`, text: '字'.repeat(6600) }));
  assert.deepEqual(plain(consistency.compactChapters(book)), plain(book));
});

// ---- chapter references (no model) ----

/** The v4 book: the intro counts itself as chapter 1 in the order but calls the harvest chapter 第四章 and the picks 第五章. */
const V4 = [
  { id: 'intro', title: '家庭菜園入門', text: [
    '路線一共五站。第一站是土壤與容器，第二站是播種與育苗。',
    '第四站是採收與保存。小白菜可以摘外葉。細節都留給第四章。',
    '第五站是新手推薦蔬菜，我給你三個選項。怎麼選，第五章會用一張比較表幫你決定。',
    '> - [ ] 在三種蔬菜裡，先憑直覺圈出你最想種的一種，第五章再來驗證。',
    '### 土壤與容器：預告裡沒講完的小細節\n\n第一站提到培養土，細節留到第二章。'
  ].join('\n\n') },
  { id: 'soil', title: '土壤與容器準備', text: '上一章把種菜拆成五步。\n\n這些就是下一章「播種與育苗」要回答的事。' },
  { id: 'sow', title: '播種與育苗', text: '上一章你已經把盆子擺上陽台。至於怎麼用手指判斷土壤乾不乾，這是下一章的重點。' },
  { id: 'water', title: '澆水施肥與病蟲害', text: '上一章你把種子養到 3 到 4 片本葉。' },
  { id: 'harvest', title: '採收與保存', text: '上一章我們靠手指測土。下一章「播種與育苗」會教你選菜。' },
  { id: 'picks', title: '新手推薦蔬菜', text: '上一章我們學了三種收法。' }
];

test('chapter references: the v4 intro\'s wrong chapter numbers are found and name the right chapter; the right ones are not', () => {
  const found = plain(refs.chapterReferenceFindings(V4));
  assert.deepEqual(found, [
    { kind: 'reference', a: 'intro', b: 'harvest', claimA: '細節都留給第四章。', claimB: '第四章', suggestion: '第五章' },
    { kind: 'reference', a: 'intro', b: 'picks', claimA: '怎麼選，第五章會用一張比較表幫你決定。', claimB: '第五章', suggestion: '第六章' },
    { kind: 'reference', a: 'intro', b: 'picks', claimA: '在三種蔬菜裡，先憑直覺圈出你最想種的一種，第五章再來驗證。', claimB: '第五章', suggestion: '第六章' },
    { kind: 'reference', a: 'harvest', b: 'sow', claimA: '下一章「播種與育苗」會教你選菜。', claimB: '下一章', suggestion: '第三章' }
  ]);
});

test('chapter references: digits, English, a title in quotes, and a number the chapter never ties to a chapter', () => {
  const book = [
    { id: 'a', title: 'Getting started', text: 'Chapter 3, “Soil”, explains pots. Chapter 2 covers soil too.\n\nSee chapter 9 later.' },
    { id: 'b', title: 'Soil', text: '第 3 章「澆水」會再說。' },
    { id: 'c', title: '澆水', text: 'The previous chapter, “Soil”, set this up. The next chapter does not exist.' }
  ];
  assert.deepEqual(plain(refs.chapterReferenceFindings(book)), [
    { kind: 'reference', a: 'a', b: 'b', claimA: 'Chapter 3, “Soil”, explains pots.', claimB: 'Chapter 3', suggestion: 'Chapter 2' }
  ]);
  assert.deepEqual(plain(refs.chapterReferenceFindings([{ id: 'x', title: 'X', text: '' }])), []);
});

// ---- the machine ----

const IDS = ['a', 'b', 'c'];
const succeed = (state, kind, nodeId) => { const d = machine.beginStep(state, kind, nodeId); return machine.applySuccess(d.state, d.token).state; };
/** A run in the writing phase with every chapter written and proofread. */
function written() {
  let state = machine.newBookPipeline({ runId: 'run-1', order: IDS, now: NOW });
  delete state.trial;
  const stages = {};
  state = succeed(state, 'global');
  for (const id of IDS) { state = succeed(state, 'plan', id); stages[id] = 'planned'; }
  state = machine.advancePhase(state, stages, NOW);
  state = machine.confirmGate1(state, NOW);
  for (const id of IDS) { state = succeed(state, 'write', id); state = succeed(state, 'proof', id); stages[id] = 'checked'; }
  return { state, stages };
}
const types = (state, stages, options) => plain(machine.nextActions(state, stages, new Set(), options)).actions.map(a => a.type);
const finding = { a: 'a', b: 'c', claimA: '三天', claimB: '一到兩天', suggestion: '統一寫一到三天' };

test('machine: with the runner able to check, the writing phase asks for the check once before it moves on; without, as before', () => {
  const { state, stages } = written();
  assert.deepEqual(types(state, stages), ['advance_phase']);
  assert.deepEqual(types(state, stages, { consistency: true }), ['book_consistency']);
  assert.equal(machine.consistencyDue(state), true);
  const begun = machine.beginConsistency(state);
  assert.equal(begun.state.consistency.attempts, 1);
  assert.equal(begun.token.key, consistency.consistencyKey(state));
  const done = machine.applyConsistency(begun.state, begun.token, [finding]);
  assert.equal(done.accepted, true);
  assert.equal(done.state.consistency.done, true);
  assert.deepEqual(plain(done.state.consistency.revisions), { a: 2, b: 2, c: 2 });
  assert.equal(machine.consistencyDue(done.state), false);
  assert.deepEqual(types(done.state, stages, { consistency: true }), ['advance_phase']);
  assert.equal(machine.beginConsistency(done.state), null, 'a finished check for the same chapters is not asked again');
  assert.deepEqual(plain(consistency.chapterInconsistencies(done.state, 'c')), [{ other: 'a', own: '一到兩天', theirs: '三天', suggestion: '統一寫一到三天' }]);
  assert.deepEqual(plain(consistency.chapterInconsistencies(done.state, 'b')), []);
});

test('machine: resume skips the check while no chapter changed; a chapter written again asks again and drops its old findings', () => {
  const { state, stages } = written();
  const begun = machine.beginConsistency(state);
  const done = machine.applyConsistency(begun.state, begun.token, [finding]).state;
  const stopped = machine.stopRun(done);
  assert.equal(machine.consistencyDue(stopped), false, 'same key: a resume does not ask again');
  const rewritten = succeed(done, 'write', 'c');
  assert.equal(machine.consistencyDue(rewritten), true);
  assert.deepEqual(plain(consistency.chapterInconsistencies(rewritten, 'c')), [], 'the changed chapter no longer shows the finding');
  assert.equal(consistency.chapterInconsistencies(rewritten, 'a').length, 1, 'the unchanged one still does');
  void stages;
});

test('machine: a result for chapters that changed meanwhile is dropped; three failures for the same chapters never hold the run', () => {
  const { state, stages } = written();
  const begun = machine.beginConsistency(state);
  const changed = succeed(begun.state, 'write', 'b');
  assert.equal(machine.applyConsistency(changed, begun.token, [finding]).accepted, false);
  let s = state;
  for (let i = 0; i < 3; i++) s = machine.beginConsistency(s).state; // each attempt fails (nothing committed)
  assert.equal(s.consistency.attempts, 3);
  assert.equal(machine.consistencyDue(s), false);
  assert.equal(machine.beginConsistency(s), null);
  assert.deepEqual(types(s, stages, { consistency: true }), ['advance_phase']);
});

test('machine: a stopped or budget-paused check gives its attempt back; a budget pause stops the run', () => {
  const { state } = written();
  const begun = machine.beginConsistency(state);
  const cancelled = machine.applyConsistencyStopped(begun.state, begun.token, false);
  assert.equal(cancelled.state.consistency.attempts, 0);
  assert.equal(cancelled.state.status, 'running');
  const budget = machine.applyConsistencyStopped(begun.state, begun.token, true).state;
  assert.deepEqual([budget.consistency.attempts, budget.status, budget.pauseReason], [0, 'stopped', 'budget']);
  assert.equal(machine.applyConsistencyStopped(begun.state, { ...begun.token, runId: 'other' }, true).accepted, false);
});

test('chapter references: kept with the check\'s findings, shown only on the chapter that says it, and read back from the map', () => {
  const { state } = written();
  const begun = machine.beginConsistency(state);
  const ref = { kind: 'reference', a: 'a', b: 'c', claimA: '細節都留給第二章。', claimB: '第二章', suggestion: '第三章' };
  const data = machine.applyConsistency(begun.state, begun.token, [ref]).state;
  assert.deepEqual(plain(consistency.chapterInconsistencies(data, 'a')), [{ other: 'c', own: '細節都留給第二章。', theirs: '第二章', suggestion: '第三章', reference: true }]);
  assert.deepEqual(plain(consistency.chapterInconsistencies(data, 'c')), [], 'the chapter it should name has nothing to fix');
  assert.equal(model.readBookPipeline({ bookPipeline: plain(data) }).kind, 'usable');
  const bad = plain(data);
  bad.consistency.findings[0].kind = 'other';
  assert.equal(model.readBookPipeline({ bookPipeline: bad }).kind, 'unusable');
  review.setUiLanguage('zh-TW');
  const shown = review.reviewEntries({ order: ['a'], titleOf: id => ({ a: '入門', c: '採收' })[id], noteOf: () => ({ pipelineStage: 'needs-review', pipelineIssue: 'consistency' }), inconsistencies: id => consistency.chapterInconsistencies(data, id) });
  assert.deepEqual(plain(shown[0].problems), [{ kind: 'consistency', text: '章號指錯：「細節都留給第二章。」裡的「第二章」說的是〈採收〉，那是第三章' }]);
});

// ---- the review box ----

test('review box: a chapter marked for the check says what differs and the fix, not the generic reason; the fingerprint holds the findings only when present', () => {
  review.setUiLanguage('zh-TW');
  const { state } = written();
  const begun = machine.beginConsistency(state);
  const data = machine.applyConsistency(begun.state, begun.token, [finding]).state;
  const titles = { a: '發芽', b: '換盆', c: '照顧' };
  const notes = { a: { pipelineStage: 'needs-review', pipelineIssue: 'consistency' }, b: { pipelineStage: 'checked' }, c: { pipelineStage: 'needs-review', pipelineIssue: 'consistency' } };
  const entries = with_ => review.reviewEntries({ order: IDS, titleOf: id => titles[id], noteOf: id => notes[id], ...(with_ ? { inconsistencies: id => consistency.chapterInconsistencies(data, id) } : {}) });
  const shown = entries(true);
  assert.deepEqual(plain(shown.map(e => e.card.id)), ['a', 'c']);
  assert.deepEqual(plain(shown[1].problems), [{ kind: 'consistency', text: '和〈發芽〉說法不一致：這章寫「一到兩天」，〈發芽〉寫「三天」，統一寫一到三天' }]);
  assert.equal(shown[0].problems[0].text, '和〈照顧〉說法不一致：這章寫「三天」，〈照顧〉寫「一到兩天」，統一寫一到三天');
  // Without findings (an older caller, or the chapter changed) the issue reads as a plain sentence, and the fingerprint is the old one.
  const bare = entries(false);
  assert.deepEqual(plain(bare[1].problems), [{ kind: 'failed', text: '和其他章節的說法不一致，請看一下。' }]);
  assert.notEqual(bare[1].fp, shown[1].fp);
  const noSuggestion = review.reviewEntries({ order: ['c'], titleOf: id => titles[id], noteOf: id => notes[id], inconsistencies: () => [{ other: 'a', own: 'x', theirs: 'y', suggestion: '' }] });
  assert.equal(noSuggestion[0].problems[0].text, '和〈發芽〉說法不一致：這章寫「x」，〈發芽〉寫「y」');
  // A chapter that needs review for its own reason keeps that reason and also lists the finding.
  const own = review.reviewEntries({ order: ['c'], titleOf: id => titles[id], noteOf: () => ({ pipelineStage: 'needs-review', pipelineIssue: 'proof failed: timeout' }), inconsistencies: id => consistency.chapterInconsistencies(data, id) });
  assert.deepEqual(plain(own[0].problems.map(p => p.kind)), ['failed', 'consistency']);
});
