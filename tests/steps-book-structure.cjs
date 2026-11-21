// The book's structure (preface, chapters, sections) from the cards' parents: places, numbers, neighbours, the trial; the chapter
// references that count chapters only; the trial of a new run; the gate switch's default.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('./support.cjs');
const structureMod = S.load('core/book-pipeline/structure.ts');
const refs = S.load('core/book-pipeline/chapter-references.ts');
const machine = S.load('core/book-pipeline/machine.ts');
const model = S.load('core/book-pipeline/model.ts');

const plain = value => JSON.parse(JSON.stringify(value));
const NOW = '2026-11-21T00:00:00.000Z';
/** `tree`: id -> parent id (the root has none); `order` is the reading order. */
const build = (order, tree, root = 'r') => structureMod.bookStructure(order, id => tree[id] ?? null, root);

// Preface + 3 chapters + 6 sections (3 under chapter 1, one of them with a child of its own, 1 under 2, 2 under 3).
const TREE = { c1: 'r', s1a: 'c1', s1b: 'c1', s1c: 's1b', c2: 'r', s2a: 'c2', c3: 'r', s3a: 'c3', s3b: 'c3' };
const ORDER = ['r', 'c1', 's1a', 's1b', 's1c', 'c2', 's2a', 'c3', 's3a', 's3b'];

test('structure: the root is the preface, the first level are chapters numbered in order, everything below is a section of its chapter', () => {
  const s = build(ORDER, TREE);
  assert.deepEqual(plain(s.placeOf('r')), { kind: 'preface' });
  assert.deepEqual(plain(s.chapters), ['c1', 'c2', 'c3']);
  assert.deepEqual(plain(s.placeOf('c2')), { kind: 'chapter', chapter: 2 });
  assert.deepEqual(plain(s.placeOf('s1a')), { kind: 'section', chapterId: 'c1', sectionIndex: 1, sectionCount: 3 });
  assert.deepEqual(plain(s.placeOf('s1c')), { kind: 'section', chapterId: 'c1', sectionIndex: 3, sectionCount: 3 }, 'a third level is a section, counted flat in reading order');
  assert.deepEqual(plain(s.placeOf('s3b')), { kind: 'section', chapterId: 'c3', sectionIndex: 2, sectionCount: 2 });
  assert.equal(s.placeOf('nobody'), undefined);
});

test('structure: neighbours of the preface, a chapter and a section; only the last section carries the next chapter', () => {
  const s = build(ORDER, TREE);
  assert.deepEqual(plain(s.neighboursOf('r')), { next: 'c1' });
  assert.deepEqual(plain(s.neighboursOf('c1')), { previous: 'r', next: 'c2' }, 'the preface is the previous of chapter 1');
  assert.deepEqual(plain(s.neighboursOf('c3')), { previous: 'c2' });
  assert.deepEqual(plain(s.neighboursOf('s1a')), { parent: 'c1', next: 's1b' });
  assert.deepEqual(plain(s.neighboursOf('s1b')), { parent: 'c1', previous: 's1a', next: 's1c' });
  assert.deepEqual(plain(s.neighboursOf('s1c')), { parent: 'c1', previous: 's1b', nextChapter: 'c2' });
  assert.deepEqual(plain(s.neighboursOf('s2a')), { parent: 'c2', nextChapter: 'c3' });
  assert.deepEqual(plain(s.neighboursOf('s3b')), { parent: 'c3', previous: 's3a' }, 'the last chapter has no next chapter');
});

test('structure: the trial is the preface, chapter 1 and all its sections (third level too), in reading order', () => {
  assert.deepEqual(plain(build(ORDER, TREE).trialOf()), ['r', 'c1', 's1a', 's1b', 's1c']);
});

test('structure: a book of first-level cards only: the trial is the preface and chapter 1 (2 cards), no sections', () => {
  const s = build(['r', 'a', 'b', 'c'], { a: 'r', b: 'r', c: 'r' });
  assert.deepEqual(plain(s.trialOf()), ['r', 'a']);
  assert.deepEqual(plain(s.chapters), ['a', 'b', 'c']);
  assert.deepEqual(plain(s.placeOf('c')), { kind: 'chapter', chapter: 3 });
  assert.deepEqual(plain(s.sectionsOf('a')), []);
  assert.deepEqual(plain(s.neighboursOf('a')), { previous: 'r', next: 'b' });
});

test('structure: a removed chapter leaves the numbers closed up; its sections (still in the order) become chapters', () => {
  // c1 is gone from the order, its sections stay: they hang on the root now.
  const s = build(['r', 's1a', 's1b', 'c2', 's2a'], TREE);
  assert.deepEqual(plain(s.chapters), ['s1a', 's1b', 'c2']);
  assert.equal(s.placeOf('c2').chapter, 3);
  // Without the sections too: chapter 2 becomes chapter 1.
  const t = build(['r', 'c2', 's2a', 'c3'], TREE);
  assert.deepEqual(plain(t.placeOf('c2')), { kind: 'chapter', chapter: 1 });
  assert.deepEqual(plain(t.trialOf()), ['r', 'c2', 's2a']);
  // A section whose parent section is gone still belongs to its chapter.
  const u = build(['r', 'c1', 's1a', 's1c'], TREE);
  assert.deepEqual(plain(u.placeOf('s1c')), { kind: 'section', chapterId: 'c1', sectionIndex: 2, sectionCount: 2 });
});

test('structure: a new card the run ignores is not in the order, so it is neither numbered nor a neighbour', () => {
  const s = build(['r', 'a', 'b'], { a: 'r', b: 'r', fresh: 'r' });
  assert.equal(s.placeOf('fresh'), undefined);
  assert.deepEqual(plain(s.neighboursOf('fresh')), {});
  assert.deepEqual(plain(s.neighboursOf('a')), { previous: 'r', next: 'b' });
});

test('structure: cards a parent cycle cut off are chapters; a root alone has only the preface; an empty order is empty', () => {
  const s = build(['r', 'a', 'x', 'y'], { a: 'r', x: 'y', y: 'x' });
  assert.deepEqual(plain(s.chapters), ['a', 'x', 'y']);
  assert.deepEqual(plain(build(['r'], {}).trialOf()), ['r']);
  assert.deepEqual(plain(build(['r'], {}).neighboursOf('r')), {});
  assert.deepEqual(plain(build([], {}).trialOf()), []);
});

// ---- chapter references count chapters only ----

const book = [
  { id: 'r', title: '前言', text: '第1章「以物易物」是第一站。第2章會談貨幣。' },
  { id: 'c1', title: '以物易物', chapter: 1, text: '下一章「貨幣的誕生」接著講。' },
  { id: 's1a', title: '市集', chapter: 1, section: true, text: '下一章「貨幣的誕生」接著講。' },
  { id: 'c2', title: '貨幣的誕生', chapter: 2, text: '上一章「以物易物」是前情。第2章就是這一章。' }
];

test('chapter references: 第2章 is the second first-level card; the preface is not chapter 1 and a section is not a chapter', () => {
  assert.deepEqual(plain(refs.chapterReferenceFindings(book)), []);
  const wrong = [{ ...book[0], text: '第1章「貨幣的誕生」在後面。' }, ...book.slice(1)];
  assert.deepEqual(plain(refs.chapterReferenceFindings(wrong)), [
    { kind: 'reference', a: 'r', b: 'c2', claimA: '第1章「貨幣的誕生」在後面。', claimB: '第1章', suggestion: '第2章' }
  ]);
});

test('chapter references: a chapter number that points at a section is reported, and the section is named instead', () => {
  const pointed = [book[0], book[1], { ...book[2] }, { ...book[3], text: '第3章「市集」有更多。' }];
  assert.deepEqual(plain(refs.chapterReferenceFindings(pointed)), [
    { kind: 'reference', a: 'c2', b: 's1a', claimA: '第3章「市集」有更多。', claimB: '第3章', suggestion: '「市集」' }
  ]);
});

test('chapter references: "next chapter" inside a section means its own chapter\'s next one, and the preface\'s next chapter is chapter 1', () => {
  assert.deepEqual(plain(refs.chapterReferenceFindings(book)), [], 'the section\'s 下一章「貨幣的誕生」 is chapter 2: right');
  const bad = [{ ...book[0], text: '下一章「貨幣的誕生」才開始。' }, ...book.slice(1)];
  assert.deepEqual(plain(refs.chapterReferenceFindings(bad)), [
    { kind: 'reference', a: 'r', b: 'c2', claimA: '下一章「貨幣的誕生」才開始。', claimB: '下一章', suggestion: '第二章' }
  ]);
  const sectionBad = [book[0], book[1], { ...book[2], text: '上一章「貨幣的誕生」不對。' }, book[3]];
  assert.equal(plain(refs.chapterReferenceFindings(sectionBad)).length, 1, 'chapter 1\'s previous is no chapter: a quoted title of chapter 2 is wrong');
});

// ---- trial of a run ----

test('trial: a new run takes the trial it is given; without one it is the first two cards; every id must be in the order', () => {
  const s = build(ORDER, TREE);
  const run = machine.newBookPipeline({ runId: 'r1', order: ORDER, now: NOW, trial: s.trialOf() });
  assert.deepEqual(plain(run.trial), ['r', 'c1', 's1a', 's1b', 's1c']);
  assert.equal(model.readBookPipeline({ bookPipeline: plain(run) }).kind, 'usable');
  assert.deepEqual(plain(machine.newBookPipeline({ runId: 'r2', order: ['r', 'a', 'b'], now: NOW }).trial), ['r', 'a']);
  assert.equal(model.TRIAL_SIZE, undefined, 'no fixed trial size any more');
});

test('trial: an older run (first three cards, no plan review, no accepted list) reads and schedules as before', () => {
  const old = plain(machine.newBookPipeline({ runId: 'old', order: ['a', 'b', 'c', 'd'], now: NOW }));
  old.trial = ['a', 'b', 'c'];
  delete old.planReview; delete old.accepted;
  assert.equal(model.readBookPipeline({ bookPipeline: old }).kind, 'usable');
  const stages = { a: 'planned', b: 'planned', c: 'planned', d: 'planned' };
  old.globalPlanned = true;
  const next = machine.nextActions(old, stages);
  assert.deepEqual(plain(next.actions.map(a => `${a.type}:${a.nodeId}`)), ['card_write:a', 'card_write:b', 'card_write:c']);
});

test('trial: when every trial card is removed, "carry on as before" picks the trial again with trialOf; it is not asked when one remains', () => {
  const order = ORDER;
  const gate = { ...plain(machine.newBookPipeline({ runId: 'r3', order, now: NOW, trial: build(order, TREE).trialOf() })), phase: 'gate1' };
  const paused = machine.pauseForMap(gate, { added: [], missing: ['r', 'c1', 's1a', 's1b', 's1c'] });
  const remaining = ['c2', 's2a', 'c3', 's3a', 's3b'];
  const next = machine.acceptMapChange(paused, remaining, 'later', left => build(left, TREE, 'c2').trialOf());
  assert.deepEqual(plain(next.trial), ['c2', 's2a'], 'the new first chapter with its sections');
  assert.equal(next.phase, 'planning');
  const some = machine.acceptMapChange(machine.pauseForMap(gate, { added: [], missing: ['s1c'] }), ORDER.filter(id => id !== 's1c'), 'later', () => ['zzz']);
  assert.deepEqual(plain(some.trial), ['r', 'c1', 's1a', 's1b', 's1c']);
  assert.equal(some.phase, 'gate1');
});

test('gates: gateWaitsForPerson holds every gate by default, so the plan review, the trial and the final gate behave as before', () => {
  const run = machine.newBookPipeline({ runId: 'g', order: ['r', 'a'], now: NOW });
  for (const gate of ['plan', 'trial', 'final']) assert.equal(machine.gateWaitsForPerson(run, gate), true, gate);
  assert.deepEqual(plain(machine.nextActions({ ...run, phase: 'gate1' }, {})), { actions: [], hold: 'gate1' });
  assert.deepEqual(plain(machine.nextActions({ ...run, phase: 'gate1', planReview: undefined }, {})), { actions: [], hold: 'gate1' });
  assert.deepEqual(plain(machine.nextActions({ ...run, phase: 'gate2' }, {})), { actions: [], hold: 'gate2' });
});
