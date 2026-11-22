// The chief editor's pass over every card's plan: the machine action and its tokens, the step (render, refusal, parse) and the pure
// Prompt rewrite (editedPrompt). The runner side lives in steps-book-pipeline-run.cjs.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('./support.cjs');
const machine = S.load('core/book-pipeline/machine.ts');
const model = S.load('core/book-pipeline/model.ts');
const planText = S.load('core/book-pipeline/plan-text.ts');
const { editedPrompt, readBrief } = S.load('core/book-pipeline/plan-edit.ts');
const step = S.load('core/steps/book-pipeline/plan-edit.ts');

const plain = value => JSON.parse(JSON.stringify(value));
const NOW = '2026-11-16T00:00:00.000Z';
const IDS = ['a', 'b', 'c'];
const fresh = () => { const state = machine.newBookPipeline({ runId: 'run-1', order: IDS, now: NOW }); delete state.trial; return state; };
const planned = () => Object.fromEntries(IDS.map(id => [id, 'planned']));
const actionsOf = (state, stages = planned(), busy) => plain(machine.nextActions({ ...state, globalPlanned: true }, stages, busy)).actions;
const begin = state => machine.beginPlanEdit(state);
const read = state => model.readBookPipeline({ bookPipeline: JSON.parse(JSON.stringify(state)) });

test('plan edit machine: emitted once after every card is planned and before gate 1; not when the flag is set or with fewer than three cards', () => {
  const state = fresh();
  assert.deepEqual(actionsOf(state), [{ type: 'plan_edit' }]);
  assert.deepEqual(actionsOf(state, planned(), new Set(['x'])), [], 'waits while something else is busy');
  assert.deepEqual(actionsOf(state, { a: 'planned', b: 'planned', c: undefined }).map(a => a.type), ['card_plan'], 'not before every card is planned');
  const d = begin(state);
  const done = machine.applyPlanEditSuccess(d.state, d.token);
  assert.equal(done.accepted, true);
  assert.equal(done.state.planEdited, true);
  assert.deepEqual(actionsOf(done.state), [{ type: 'advance_phase' }]);
  const small = machine.newBookPipeline({ runId: 'r', order: ['a', 'b'], now: NOW }); delete small.trial;
  assert.deepEqual(actionsOf(small, { a: 'planned', b: 'planned' }), [{ type: 'advance_phase' }], 'two cards: nothing to compare');
  assert.equal(begin(done.state), null, 'a finished pass does not start again');
});

test('plan edit machine: three failures give up (flag set, the book goes on); a failure before that leaves it due', () => {
  let state = fresh();
  for (let n = 1; n <= 3; n++) {
    assert.deepEqual(actionsOf(state), [{ type: 'plan_edit' }], `attempt ${n} is allowed`);
    const d = begin(state);
    assert.equal(d.state.planEditAttempts, n);
    const failed = machine.applyPlanEditFailure(d.state, d.token);
    assert.equal(failed.accepted, true);
    assert.equal(!!failed.gaveUp, n === 3);
    state = failed.state;
  }
  assert.equal(state.planEdited, true);
  assert.deepEqual(actionsOf(state), [{ type: 'advance_phase' }]);
});

test('plan edit machine: a stop gives the attempt back and sets no flag; a budget stop also pauses the run', () => {
  const state = fresh();
  const d = begin(state);
  const stopped = machine.applyPlanEditStopped(d.state, d.token, false);
  assert.equal(stopped.state.planEditAttempts, undefined);
  assert.equal(stopped.state.planEdited, undefined);
  assert.deepEqual(actionsOf(stopped.state), [{ type: 'plan_edit' }], 'it runs again after a resume');
  const budget = machine.applyPlanEditStopped(d.state, d.token, true).state;
  assert.equal(budget.status, 'stopped'); assert.equal(budget.pauseReason, 'budget');
});

test('plan edit machine accounting: applyPlanEditStopped gives back one attempt of several and keeps the flag unset; a stale or foreign token for it', () => {
  let state = fresh();
  const first = begin(state);
  state = machine.applyPlanEditFailure(first.state, first.token).state;
  const second = begin(state);
  assert.equal(second.state.planEditAttempts, 2);
  const stopped = machine.applyPlanEditStopped(second.state, second.token, false);
  assert.equal(stopped.accepted, true);
  assert.equal(stopped.state.planEditAttempts, 1, 'only the stopped attempt is given back');
  assert.equal(stopped.state.status, 'running'); assert.equal(stopped.state.planEdited, undefined);
  assert.equal(machine.applyPlanEditStopped(second.state, { ...second.token, runId: 'other' }, true).accepted, false, 'another run: refused');
  assert.equal(machine.applyPlanEditStopped(stopped.state, second.token, false).state.planEditAttempts, undefined, 'never below zero');
});

test('plan edit machine accounting: applyPlanEditFailure counts up to three, gives up only on the last, and drops a stale result', () => {
  let state = fresh();
  const one = begin(state);
  const failed = machine.applyPlanEditFailure(one.state, one.token);
  assert.equal(failed.accepted, true); assert.equal(failed.gaveUp, undefined); assert.equal(failed.state.planEdited, undefined);
  assert.equal(failed.state.planEditAttempts, 1, 'a failure does not change the count (it was counted at the start)');
  const stale = machine.applyPlanEditFailure(one.state, { ...one.token, stopEpoch: one.token.stopEpoch + 1 });
  assert.equal(stale.accepted, false); assert.equal(stale.state, one.state);
  const done = machine.applyPlanEditSuccess(one.state, one.token).state;
  assert.equal(machine.applyPlanEditFailure(done, one.token).accepted, false, 'after the flag is set a late failure is dropped');
});

test('plan edit machine: a result under an older stop generation or older card revisions is dropped', () => {
  const state = fresh();
  const d = begin(state);
  assert.equal(machine.applyPlanEditSuccess({ ...d.state, stopEpoch: (d.state.stopEpoch ?? 0) + 1 }, d.token).accepted, false);
  const replanned = { ...d.state, revisions: { ...d.state.revisions, b: machine.cardRevision(d.state, 'b') + 1 } };
  assert.equal(machine.applyPlanEditSuccess(replanned, d.token).accepted, false);
  assert.equal(machine.applyPlanEditFailure(replanned, d.token).accepted, false);
  assert.equal(machine.applyPlanEditSuccess({ ...d.state, status: 'stopped' }, d.token).accepted, false);
});

test('plan edit machine: a replan clears the flag so the pass runs again (retryTrial, backToPlan, acceptMapChange, resetCard)', () => {
  const edited = () => { const s = fresh(); const d = begin(s); const ok = machine.applyPlanEditSuccess(d.state, d.token).state; ok.planEditAttempts = 2; return ok; };
  const cleared = s => s.planEdited === undefined && s.planEditAttempts === undefined;
  const trial = edited(); trial.phase = 'gate1'; trial.trial = ['a', 'b']; trial.planReview = false;
  assert.ok(cleared(machine.retryTrial(trial, NOW)), 'retryTrial');
  assert.ok(cleared(machine.backToPlan(trial, NOW)), 'backToPlan');
  assert.ok(cleared(machine.acceptMapChange(edited(), ['a', 'b', 'c', 'd'], NOW)), 'a new card');
  assert.ok(cleared(machine.acceptMapChange(edited(), ['a', 'b'], NOW)), 'a missing card');
  assert.ok(!cleared(machine.acceptMapChange(edited(), IDS, NOW)), 'the same map keeps it');
  assert.ok(cleared(machine.resetCard(edited(), 'b')), 'resetCard');
});

test('plan edit machine: the flag survives a JSON save and reload (the pass runs exactly once); the model rejects bad values', () => {
  const s = fresh();
  const d = begin(s);
  const done = machine.applyPlanEditSuccess(d.state, d.token).state;
  const back = read(done);
  assert.equal(back.data.planEdited, true);
  assert.deepEqual(actionsOf(back.data), [{ type: 'advance_phase' }]);
  assert.ok(read(s).data, 'absent fields are fine');
  const bad = patch => read({ ...JSON.parse(JSON.stringify(s)), ...patch });
  assert.equal(bad({ planEdited: false }).data, undefined);
  assert.equal(bad({ planEditAttempts: -1 }).data, undefined);
  assert.ok(bad({ planEditAttempts: 2 }).data);
});

// ---- the step ----

const settings = {};
const card = (id, role, extra = {}) => ({ id, place: id, role, title: `T-${id}`, covers: 'covers', points: ['p1', 'p2', 'p3'], entry: 'e', handoff: 'h', previous: '', next: '', checklist: ['c'], ...extra });
const request = (cards = [card('a', 'intro'), card('b', 'body'), card('c', 'body')]) => ({ language: 'zh-TW', model: 'm', reasoning: 'low', bookTitle: 'Book', thread: 'thread', settings, cards });

test('plan edit step: renders every card as data, with the book data marked as not instructions', () => {
  const prompt = step.planEditStep.render(request());
  for (const id of ['a', 'b', 'c']) assert.ok(prompt.includes(`"id":"${id}"`));
  assert.match(prompt, /not instructions/);
  assert.equal(step.planEditStep.id, 'book-pipeline.plan-edit');
  assert.doesNotThrow(() => step.planEditStep.policy(prompt, request()));
});

test('plan edit step: fewer than three cards, or plans too long for one request, are refused before any call', () => {
  const two = request([card('a', 'intro'), card('b', 'body')]);
  assert.throws(() => step.planEditStep.policy('p', two), /three cards/);
  const huge = request(Array.from({ length: 400 }, (_, i) => card(`c${i}`, 'body', { covers: 'x'.repeat(400), entry: 'y'.repeat(400), handoff: 'z'.repeat(400), previous: 'w'.repeat(400), next: 'v'.repeat(400), checklist: Array(8).fill('q'.repeat(200)) })));
  assert.equal(step.planEditFits(huge), false);
  assert.throws(() => step.planEditStep.policy(step.planEditStep.render(huge), huge), /too long/);
  assert.equal(step.planEditFits(request()), true);
});

test('plan edit step parse: valid changes kept in order; unknown ids, bad shapes, unknown fields and repeated ids are dropped one by one', () => {
  const reply = JSON.stringify({ changes: [
    { id: 'b', covers: 'new covers', previous: 'prev' },
    { id: 'zzz', covers: 'x' },
    { id: 'c', covers: 5 },
    { id: 'c', title: 'renamed' },
    { id: 'a' },
    { id: 'c', points: ['one', 'two', 'three', 'four'], checklist: [{ type: 'fact', text: 'the sea is salty' }] },
    { id: 'c', entry: 'second change for c' },
    'text'
  ] });
  const out = plain(step.planEditStep.parse(reply, request()).changes);
  assert.deepEqual(out.map(c => c.id), ['b', 'c']);
  assert.deepEqual(out[0], { id: 'b', covers: 'new covers', previous: 'prev' });
  assert.deepEqual(out[1].points, ['one', 'two', 'three', 'four']);
  assert.deepEqual(plain(step.planEditStep.parse('{"changes":[]}', request()).changes), []);
});

test('plan edit step parse: a points list that is too short drops the change; a checklist without a new covers, points or previous is ignored; malformed replies throw', () => {
  const parse = changes => plain(step.planEditStep.parse(JSON.stringify({ changes }), request()).changes);
  assert.deepEqual(parse([{ id: 'b', points: ['one'] }]), []);
  assert.deepEqual(parse([{ id: 'b', checklist: [{ type: 'fact', text: 'x' }] }]), []);
  assert.deepEqual(parse([{ id: 'b', entry: 'e2', checklist: [{ type: 'fact', text: 'x' }] }]), [{ id: 'b', entry: 'e2' }], 'an entry change leaves the checklist alone');
  assert.throws(() => step.planEditStep.parse('not json', request()));
  assert.throws(() => step.planEditStep.parse('{"changes":[],"extra":1}', request()), /unexpected/);
  assert.throws(() => step.planEditStep.parse('{"changes":"x"}', request()));
});

test('plan edit step parse: a checklist replaces the whole list when covers, points or previous change; without one the change is flagged by changesBrief', () => {
  const parse = changes => plain(step.planEditStep.parse(JSON.stringify({ changes }), request()).changes);
  const list = [{ type: 'structure', text: 'names the earlier ideas "X" and "Y" and states that they lead to "Z"' }];
  for (const field of [{ covers: 'new' }, { previous: 'new prev' }, { points: ['one', 'two', 'three'] }]) {
    const [out] = parse([{ id: 'b', ...field, checklist: list }]);
    assert.deepEqual(out.checklist, list, JSON.stringify(field));
    assert.equal(step.changesBrief(out), true);
  }
  const [bare] = parse([{ id: 'b', covers: 'new' }]);
  assert.equal(bare.checklist, undefined); assert.equal(step.changesBrief(bare), true, 'the runner discards it');
  const [emptied] = parse([{ id: 'b', covers: 'new', checklist: [{ type: 'structure', text: 'the prose is vivid' }] }]);
  assert.equal(emptied.checklist, undefined, 'a list the filter empties is no replacement');
  assert.equal(step.changesBrief({ id: 'b', entry: 'x' }), false);
});

test('plan edit step: a locked card is marked in the request and its changes are dropped; the prompt tells the editor so', () => {
  const locked = request([card('a', 'intro'), card('b', 'body', { locked: true }), card('c', 'body')]);
  const prompt = step.planEditStep.render(locked);
  assert.match(prompt, /"id":"b"[^}]*"locked":true/);
  assert.doesNotMatch(prompt, /"id":"a"[^}]*"locked"/);
  assert.match(prompt, /locked.*must not change/);
  const out = plain(step.planEditStep.parse(JSON.stringify({ changes: [{ id: 'b', entry: 'x' }, { id: 'c', entry: 'y' }] }), locked).changes);
  assert.deepEqual(out.map(c => c.id), ['c']);
});

test('plan edit step: previous and next are shown as the sentence only (readBrief)', () => {
  const prompt = planText.composeCardPrompt(base, 'zh-TW');
  assert.equal(readBrief(prompt).previous, 'old prev');
  assert.equal(readBrief(prompt).next, 'a next');
  const section = planText.composeCardPrompt({ ...base, kind: 'section', previous: { title: 'Sec One', summary: 'sec prev' }, parent: { position: 2, title: 'Chapter Two' } }, 'en');
  assert.equal(readBrief(section).previous, 'sec prev');
  assert.equal(readBrief(planText.composeCardPrompt({ ...base, previous: undefined }, 'en')).previous, '');
});

// ---- editedPrompt ----

const base = {
  role: 'body', kind: 'chapter', covers: 'old covers', points: ['p1', 'p2', 'p3'], entry: 'old entry', handoff: 'old handoff',
  previous: { position: 1, title: 'First', summary: 'old prev' }, next: { position: 3, title: 'Third', summary: 'a next' },
  checklist: [{ id: 'C1', type: 'structure', text: 'has a beginning' }, { id: 'C2', type: 'fact', text: 'names the sea' }],
  images: [{ index: 1, kind: 'map', explains: 'the route', anchor: 'after the first paragraph' }],
  cover: { explains: 'a harbour', search: ['harbour', 'port'] }
};

test('editedPrompt: an unchanged round trip returns undefined (nothing to write)', () => {
  for (const language of ['zh-TW', 'en']) {
    const prompt = planText.composeCardPrompt(base, language);
    assert.equal(editedPrompt(prompt, {}, 'chapter', language), undefined);
    assert.equal(editedPrompt(prompt, { covers: 'old covers' }, 'chapter', language), undefined);
  }
  assert.equal(editedPrompt('free text the owner wrote', { covers: 'x' }, 'chapter', 'zh-TW'), undefined, 'not a plan: left alone');
});

test('editedPrompt: a change keeps the picture plan, cover and neighbour lines; checklist replacement renumbers ids', () => {
  const prompt = planText.composeCardPrompt(base, 'zh-TW');
  const out = editedPrompt(prompt, { covers: 'new covers', previous: 'new prev', checklist: [{ type: 'fact', text: 'a new check' }, { type: 'structure', text: 'another' }] }, 'chapter', 'zh-TW');
  assert.ok(out && out !== prompt);
  assert.equal(readBrief(out).covers, 'new covers');
  assert.match(out, /new prev/); assert.doesNotMatch(out, /old prev/);
  assert.deepEqual(plain(planText.parseChecklist(out).map(c => c.id)), ['C1', 'C2']);
  assert.equal(planText.parseChecklist(out)[0].text, 'a new check');
  assert.deepEqual(plain(planText.parseImageSlots(out)), plain(planText.parseImageSlots(prompt)));
  assert.deepEqual(plain(planText.parseCardCover(out)), plain(planText.parseCardCover(prompt)));
  assert.match(out, /Third — a next/);
  assert.equal(readBrief(out).entry, 'old entry');
});

test('editedPrompt: a section keeps its parent line; a card with no previous line gets none from a previous change', () => {
  const section = { ...base, kind: 'section', parent: { position: 2, title: 'Chapter Two' }, previous: undefined };
  const prompt = planText.composeCardPrompt(section, 'en');
  const out = editedPrompt(prompt, { previous: 'invented', handoff: 'new handoff' }, 'section', 'en');
  assert.ok(out);
  assert.match(out, /Chapter Two/);
  assert.doesNotMatch(out, /invented/);
  assert.equal(readBrief(out).handoff, 'new handoff');
  assert.equal(editedPrompt(prompt, { previous: 'invented' }, 'section', 'en'), undefined, 'only an ignored change: nothing to write');
});

test('editedPrompt: a previous reply that echoes the whole neighbour line is stored as the sentence only (chapter, preface, section)', () => {
  const prompt = planText.composeCardPrompt(base, 'en');
  const out = editedPrompt(prompt, { previous: '(1) First — new idea' }, 'chapter', 'en');
  assert.match(out, /^Previous chapter: \(1\) First — new idea$/m);
  assert.doesNotMatch(out, /First — \(1\)|First — First/);
  const preface = planText.composeCardPrompt({ ...base, previous: { position: 'preface', title: 'Intro', summary: 'old' } }, 'zh-TW');
  const outPreface = editedPrompt(preface, { previous: '(前言) Intro — 新的想法' }, 'chapter', 'zh-TW');
  assert.match(outPreface, /\(前言\) Intro — 新的想法$/m); assert.equal((outPreface.match(/Intro/g) ?? []).length, 1);
  const sec = planText.composeCardPrompt({ ...base, kind: 'section', parent: { position: 2, title: 'Chapter Two' }, previous: { title: 'Sec One', summary: 'old' } }, 'en');
  const outSec = editedPrompt(sec, { previous: 'Sec One — a fresh idea' }, 'section', 'en');
  assert.match(outSec, /Sec One — a fresh idea$/m); assert.equal((outSec.match(/Sec One/g) ?? []).length, 1);
  const plainReply = editedPrompt(prompt, { previous: 'a sentence with a — dash' }, 'chapter', 'en');
  assert.match(plainReply, /First — a sentence with a — dash$/m, 'a sentence that is not the line is kept whole');
});

test('editedPrompt: a zh-CN Prompt round trips unchanged and an edit keeps its labels and the other lines', () => {
  const prompt = planText.composeCardPrompt(base, 'zh-CN');
  assert.equal(editedPrompt(prompt, {}, 'chapter', 'zh-CN'), undefined, 'nothing to write');
  assert.equal(readBrief(prompt).covers, 'old covers');
  const out = editedPrompt(prompt, { covers: 'new covers', handoff: 'new handoff' }, 'chapter', 'zh-CN');
  assert.ok(out);
  assert.equal(readBrief(out).covers, 'new covers'); assert.equal(readBrief(out).handoff, 'new handoff');
  assert.equal(readBrief(out).entry, 'old entry');
  assert.equal(out.replace('new covers', 'old covers').replace('new handoff', 'old handoff'), prompt, 'only the two fields moved');
  assert.deepEqual(plain(planText.parseImageSlots(out)), plain(planText.parseImageSlots(prompt)));
});

test('plan edit step parse: the opening is kept (trimmed, cut at its cap); absent or not a string means none; other extra fields still fail', () => {
  const parse = value => plain(step.planEditStep.parse(JSON.stringify(value), request()));
  assert.deepEqual(parse({ changes: [], opening: '  Hello  ' }), { changes: [], opening: 'Hello' });
  assert.deepEqual(parse({ changes: [] }), { changes: [] });
  assert.deepEqual(parse({ changes: [], opening: 5 }), { changes: [] }, 'a non-string opening is ignored');
  assert.deepEqual(parse({ changes: [], opening: '   ' }), { changes: [] });
  assert.equal(parse({ changes: [], opening: 'x'.repeat(5000) }).opening.length, step.PLAN_EDIT_OPENING_CHARS);
  assert.throws(() => step.planEditStep.parse('{"changes":[],"opening":"a","extra":1}', request()), /unexpected/);
  assert.throws(() => step.planEditStep.parse('{"opening":"a"}', request()), /unexpected/);
});

test('plan edit step: structure changes are rendered as data; none renders an empty list; the version moved', () => {
  const none = step.planEditStep.render(request());
  assert.match(none, /Structure changes already made[^\n]*\n\[\]/);
  const withChanges = step.planEditStep.render({ ...request(), structureChanges: [{ kind: 'merge', title: 'T-b', reason: 'same ground' }] });
  assert.ok(withChanges.includes('{"kind":"merge","title":"T-b","reason":"same ground"}'));
  assert.match(withChanges, /opening/);
  assert.equal(step.planEditStep.version, 3);
});

test('plan opening: a successful pass stores it; a pass without one stores none; a replan clears it; the reader drops a malformed or over-long one without refusing the run', () => {
  const d = begin(fresh());
  const done = machine.applyPlanEditSuccess(d.state, d.token, 'Hello author');
  assert.equal(done.state.planOpening, 'Hello author');
  assert.equal(machine.applyPlanEditSuccess(begin(fresh()).state, begin(fresh()).token).state.planOpening, undefined);
  assert.equal(machine.backToPlan({ ...done.state, phase: 'gate1', planReview: undefined, trial: ['a'] }, NOW).planOpening, undefined, 'a replan forgets the pass and its opening');
  const saved = read(done.state);
  assert.equal(saved.kind, 'usable'); assert.equal(saved.data.planOpening, 'Hello author');
  for (const bad of [5, ['x'], 'y'.repeat(2001)]) {
    const r = read({ ...done.state, planOpening: bad });
    assert.equal(r.kind, 'usable', 'the run is not refused');
    assert.equal(r.data.planOpening, undefined, 'the bad value is dropped');
  }
});
