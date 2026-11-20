// Picture-book whole-book consistency check: the research-voice patterns (V1), the reply parser and chapter compaction, the machine
// gate (due, begin, apply, stop, resume), and the review box sentence a finding gives. The runner path is in steps-book-pipeline-run.cjs.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('./support.cjs');
const { load, loadSource } = require('./support-replay.cjs');

const prose = load('core/book-pipeline/prose-checks.ts');
const consistency = load('core/book-pipeline/consistency.ts');
const step = load('core/steps/book-pipeline/consistency.ts');
const machine = load('core/book-pipeline/machine.ts');
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
  assert.equal(step.parseConsistency(reply(Array.from({ length: 25 }, () => issue(1, 2))), 2).length, step.CONSISTENCY_MAX_ISSUES);
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

test('compactChapters: chapters that fit go whole; a long book keeps each chapter\'s sentences with numbers, cut to an equal share', () => {
  const small = [{ title: 'A', text: '種子三天發芽。天氣很好。' }, { title: 'B', text: '一到兩天就會發芽。' }];
  assert.deepEqual(plain(consistency.compactChapters(small, 1000)), plain(small));
  const long = [
    { title: 'A', text: `${'風景很美。'.repeat(100)}種子三天發芽。花盆深 15 公分。` },
    { title: 'B', text: `${'光線柔和。'.repeat(100)}一到兩天就會發芽。` }
  ];
  const out = plain(consistency.compactChapters(long, 400));
  assert.deepEqual(out.map(c => c.title), ['A', 'B']);
  assert.equal(out[0].text, '種子三天發芽。 花盆深 15 公分。');
  assert.equal(out[1].text, '一到兩天就會發芽。');
  const cut = plain(consistency.compactChapters([{ title: 'A', text: '1 天。'.repeat(500) }, { title: 'B', text: '2 天。'.repeat(500) }], 600));
  assert.ok(cut.every(c => Array.from(c.text).length <= 300));
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

// ---- removed chapters still named ----

test('removedChapterRefs: a chapter naming a removed chapter by title is found once per pair with the first sentence; short, still-present or unnamed titles are not', () => {
  const data = { order: ['a', 'b', 'c', 'd'], removed: ['b', 'd'], chapters: { a: { title: '發芽', path: 'A' }, b: { title: '換盆', path: 'B' }, c: { title: '照顧', path: 'C' }, d: { title: '光', path: 'D' } } };
  const chapters = [
    { id: 'a', title: '發芽', text: '種子三天發芽。下一步見換盆一章。之後再換盆。' },
    { id: 'c', title: '照顧', text: '照顧要用心。光很重要。' }
  ];
  assert.deepEqual(plain(consistency.removedChapterRefs(data, chapters)), [{ kind: 'removed', a: 'a', b: 'b', claimA: '下一步見換盆一章。', claimB: '換盆', suggestion: '' }]);
  // A title a present chapter also has is not a removed reference.
  const same = { ...data, chapters: { ...data.chapters, c: { title: '換盆', path: 'C' } } };
  assert.deepEqual(plain(consistency.removedChapterRefs(same, [chapters[0], { id: 'c', title: '換盆', text: 'x' }])), []);
  assert.deepEqual(plain(consistency.removedChapterRefs({ ...data, removed: [] }, chapters)), []);
  assert.deepEqual(plain(consistency.removedChapterRefs({ order: ['a'], chapters: data.chapters }, chapters)), [], 'no removed list (older data)');
  // A long sentence is quoted up to 80 characters.
  const long = consistency.removedChapterRefs(data, [{ id: 'a', title: '發芽', text: `換盆${'字'.repeat(100)}。` }]);
  assert.equal(Array.from(long[0].claimA).length, 80);
});

test('removed reference through the check: stored with its kind, shown on the naming chapter only, read back from the map, and the review box names the removed chapter', () => {
  review.setUiLanguage('zh-TW');
  const { state } = written();
  state.removed = ['b'];
  state.chapters = { a: { title: '發芽', path: 'A' }, b: { title: '換盆', path: 'B' }, c: { title: '照顧', path: 'C' } };
  const refs = consistency.removedChapterRefs(state, [{ id: 'a', title: '發芽', text: '之後見換盆。' }, { id: 'c', title: '照顧', text: '照顧好。' }]);
  const begun = machine.beginConsistency(state);
  const data = machine.applyConsistency(begun.state, begun.token, [finding, ...refs]).state;
  assert.deepEqual(plain(consistency.chapterInconsistencies(data, 'a')), [
    { other: 'c', own: '三天', theirs: '一到兩天', suggestion: '統一寫一到三天' },
    { kind: 'removed', other: 'b', own: '之後見換盆。', theirs: '換盆', suggestion: '' }
  ]);
  assert.deepEqual(plain(consistency.chapterInconsistencies(data, 'b')), [], 'the removed chapter is not told about itself');
  assert.equal(consistency.chapterInconsistencies(data, 'c').length, 1, 'the other chapter sees only the model finding');
  const read = load('core/book-pipeline/model.ts');
  assert.equal(read.readBookPipeline({ bookPipeline: data }).kind, 'usable');
  const bad = JSON.parse(JSON.stringify(data)); bad.consistency.findings[1].kind = 'other';
  assert.equal(read.readBookPipeline({ bookPipeline: bad }).kind, 'unusable', 'an unknown kind is not read as a finding');
  const notes = { a: { pipelineStage: 'needs-review', pipelineIssue: 'consistency' } };
  const entries = review.reviewEntries({ order: ['a'], titleOf: id => data.chapters[id].title, noteOf: id => notes[id], inconsistencies: id => consistency.chapterInconsistencies(data, id) });
  assert.deepEqual(plain(entries[0].problems.map(p => p.text)), ['和〈照顧〉說法不一致：這章寫「三天」，〈照顧〉寫「一到兩天」，統一寫一到三天', '這章還提到已移除的〈換盆〉：「之後見換盆。」']);
});
