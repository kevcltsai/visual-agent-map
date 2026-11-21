// Picture-book callouts (T4 of "book without a panel"): the write coordinator, the idempotent aligner and the map-level reconciler,
// on fake ports with in-memory notes. How Obsidian shows the callouts and how a real editor takes the transaction is UI evidence.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('./support.cjs');
const dom = require('./support-dom.cjs');
const { loadSource } = require('./support-replay.cjs');

const b = loadSource(`
export * from "./experiences/visual-map/book-pipeline-callouts";
export { findProgramCallouts, readReviewState, putProgramCallout, aiProofCallout, aiProofFingerprint } from "./experiences/visual-map/book-pipeline-review";
export { setUiLanguage, t } from "./i18n";
export { composeProofRecord, proofKey } from "./core/book-pipeline/proof";
export { replaceResearchRecord, chapterBody } from "./core/book-pipeline/note-sections";
export { projectProofBody } from "./core/book-pipeline/book-notes";
export { stripImageLines } from "./core/book-pipeline/image-slots";
`, { obsidian: { ...S.obsidian, Modal: dom.makeModal(), Notice: dom.makeNotice([]), Component: class {}, MarkdownRenderChild: class {} } }, { createFragment: dom.createFragment, requestAnimationFrame: () => 1, cancelAnimationFrame() {}, window: { setTimeout, clearTimeout, setInterval, clearInterval } });
b.setUiLanguage('zh-TW');
const legacy = require('./support-legacy-boxes.cjs')(b);

const START = '<!-- visual-agent-map:detail:start -->';
const END = '<!-- visual-agent-map:detail:end -->';
const note = (detail = 'Body') => `# T\n\n## Current Summary\n\nS\n\n## Detail\n\n${START}\n${detail}\n${END}\n\n## Prompt\n\nP\n`;
const tick = (text, at) => { let n = 0; return text.replace(/\[ \]/g, m => (n++ === at ? '[x]' : m)); };
const kinds = text => Array.from(b.findProgramCallouts(text), c => `${c.kind}:${c.runId}`);

// ---- the write coordinator ----
const view = (text, log = []) => ({ text: () => text, replace: next => { log.push(next); text = next; return true; } });
const upper = t => t.toUpperCase();

test('writer: a note open in a view is changed through the editor, never the file', async () => {
  const log = []; let raw = 0;
  const write = b.createNoteWriter({ openViews: () => [view('abc', log)], rawGuarded: async () => { raw++; return 'written'; } });
  assert.equal(await write('p', upper), 'written');
  assert.deepEqual(log, ['ABC']);
  assert.equal(raw, 0);
});
test('writer: an editor already as wanted is unchanged; two panes that disagree refuse', async () => {
  const log = [];
  const same = b.createNoteWriter({ openViews: () => [view('ABC', log)], rawGuarded: async () => 'written' });
  assert.equal(await same('p', upper), 'unchanged');
  assert.deepEqual(log, []);
  const split = b.createNoteWriter({ openViews: () => [view('abc', log), view('abd', log)], rawGuarded: async () => 'written' });
  assert.equal(await split('p', upper), 'refused');
  assert.deepEqual(log, []);
});
test('writer: a note nobody has open goes through the guarded file write', async () => {
  let file = 'abc';
  const write = b.createNoteWriter({ openViews: () => [], rawGuarded: async (path, transform, o) => { if (!o.authorize()) return 'discarded'; file = transform(file); return 'written'; } });
  assert.equal(await write('p', upper), 'written');
  assert.equal(file, 'ABC');
  assert.equal(await write('p', upper), 'unchanged');
});
test('writer: a view opened and typed in between the path choice and the write leaves the file alone, keeps the typing, and the change goes through the editor once', async () => {
  let file = 'abc'; let opened = false; const log = []; let raws = 0;
  const typed = view('abc plus typed', log);
  const write = b.createNoteWriter({
    openViews: () => (opened ? [typed] : []),
    rawGuarded: async (path, transform, o) => { raws++; opened = true; if (!o.authorize()) return 'discarded'; file = transform(file); return 'written'; }
  });
  assert.equal(await write('p', upper), 'written');
  assert.equal(file, 'abc', 'the file was not written');
  assert.equal(raws, 1, 'retried once, through the editor, not the file');
  assert.deepEqual(log, ['ABC PLUS TYPED'], 'what was typed is kept');
});
test('writer: a refused file write with no view to retry on stays refused', async () => {
  const write = b.createNoteWriter({ openViews: () => [], rawGuarded: async () => 'discarded' });
  assert.equal(await write('p', upper), 'refused');
});

// ---- the aligner ----
const want = (over = {}) => ({ runId: 'r1', nodeId: 'n1', ...over });
const box = (fp = 'fp1') => ({ fp, build: () => legacy.reviewCallout({ id: 'n1', index: 1, title: 'T', stage: 'needs-review', structureUnmet: 0, factsOpen: 0, galleryBare: false, seam: false }, ['x'], undefined, fp, 'r1') });
test('align: running it again changes nothing; no want removes every program callout', () => {
  const once = b.alignCallouts(note(), want({ review: box() }));
  assert.deepEqual(kinds(once), ['review:r1']);
  assert.equal(b.alignCallouts(once, want({ review: box() })), once);
  assert.equal(b.alignCallouts(once, undefined), note());
});
test('align: the same fingerprint keeps a tick (and folds it); a new fingerprint writes the box again unticked', () => {
  const ticked = tick(b.alignCallouts(note(), want({ review: box('fp1') })), 0);
  const kept = b.alignCallouts(ticked, want({ review: box('fp1') }));
  assert.equal(b.readReviewState(kept).accept, true);
  assert.equal(b.readReviewState(kept).collapsed, true);
  const fresh = b.alignCallouts(ticked, want({ review: box('fp2') }));
  assert.equal(b.readReviewState(fresh).fp, 'fp2');
  assert.equal(b.readReviewState(fresh).accept, false);
  assert.equal(kinds(fresh).length, 1);
});
test('align: at gate 2 an answered box stays folded under its handled title when the chapter no longer asks; an unanswered one goes; after gate 2 every box goes', () => {
  const ticked = tick(b.alignCallouts(note(), want({ review: box('fp1') })), 1);
  const kept = b.alignCallouts(ticked, want({ keepAnswered: true }));
  assert.equal(b.readReviewState(kept).collapsed, true);
  assert.match(kept, /\[!vam-review\]- 已處理（你選了「我改好了」）/);
  assert.equal(b.alignCallouts(kept, want({ keepAnswered: true })), kept, 'again: unchanged');
  const open = b.alignCallouts(note(), want({ review: box('fp1') }));
  assert.deepEqual(kinds(b.alignCallouts(open, want({ keepAnswered: true }))), [], 'unanswered goes');
  assert.deepEqual(kinds(b.alignCallouts(ticked, want())), [], 'no gate 2: goes');
  // unticked after the fold: the same fingerprint opens it again with the question
  const reopened = b.alignCallouts(b.alignCallouts(ticked, want({ review: box('fp1') })).replace('[x]', '[ ]'), want({ review: box('fp1') }));
  assert.deepEqual({ c: b.readReviewState(reopened).collapsed, h: b.readReviewState(reopened).handled }, { c: false, h: false });
});
const AI = { checked: 14, fixes: [{ problem: '年份改成 1503' }], open: [{ problem: '委託人是誰', reason: 'sources_conflict' }] };
const aiWant = (input = AI, over = {}) => want({ ai: { fp: b.aiProofFingerprint(input), build: () => b.aiProofCallout(input, 'r1', 'n1') }, ...over });
test('align: the AI box is written once, kept while its fingerprint is the same, written again when the result changed, and replaces an old tick box', () => {
  const once = b.alignCallouts(note(), aiWant());
  assert.deepEqual(kinds(once), ['review:r1']);
  assert.equal(b.alignCallouts(once, aiWant()), once, 'again: unchanged');
  const more = { ...AI, fixes: [...AI.fixes, { problem: '尺寸改成 77×53' }] };
  const changed = b.alignCallouts(once, aiWant(more));
  assert.notEqual(changed, once);
  assert.deepEqual(kinds(changed), ['review:r1'], 'one box, not two');
  assert.match(changed, /尺寸改成 77×53/);
  const old = b.alignCallouts(note(), want({ review: box('fp1') }));
  const replaced = b.alignCallouts(old, aiWant());
  assert.doesNotMatch(replaced, /\[ \]|接受現在這樣/, 'the tick box is gone');
  assert.deepEqual(kinds(b.alignCallouts(once, want())), [], 'no ai wanted: the box goes');
});
test('aiProofCallout: counts, one sentence per fix and per open item, no tick box or button, reason in words, model text escaped, incomplete says so', () => {
  const text = b.aiProofCallout(AI, 'r1', 'n1');
  assert.match(text, /\[!vam-review\] AI 校對：查了 14 項，修了 1 處，1 處沒修好/);
  assert.match(text, /> ・修了：年份改成 1503/);
  assert.match(text, /> ・沒修好：委託人是誰，兩個來源說法不同，AI 判斷不了，已列到書末/);
  assert.doesNotMatch(text, /\[ \]|\[x\]|按鈕|sources_conflict/);
  const evil = b.aiProofCallout({ checked: 1, fixes: [{ problem: '\n> [!vam-review] x %%vam-review:r1:n1:fp%% <b>' }], open: [{ problem: '[[link]] ==hi==', reason: 'weird_code' }] }, 'r1', 'n1');
  assert.deepEqual(kinds(b.putProgramCallout(note(), evil)), ['review:r1'], 'the injected marker and callout do not form');
  assert.doesNotMatch(evil, /<b>|\[\[link|==hi==|weird_code/);
  assert.match(evil, /AI 沒辦法處理/, 'an unknown code reads as the general sentence');
  assert.match(b.aiProofCallout({ checked: 0, fixes: [], open: [], incomplete: true }, 'r1', 'n1'), /AI 校對：這章沒有查完，已列到書末/);
});
test('aiProofCallout: a fix line says the problem and the sentence really written, never the suggestion; long cut, escaped, old save falls back to the problem', () => {
  const fix = { id: 'f1', quote: 'q', problem: '年份和第 5 章不一致', suggestion: '刪除此句，或改為具名的學者', replacement: '蒙娜麗莎完成於 1503 年。' };
  const text = b.aiProofCallout({ checked: 1, fixes: [fix], bookFixes: [{ ...fix, id: 'b1', replacement: '全書改的句子' }], open: [] }, 'r1', 'n1');
  assert.match(text, /> ・修了：年份和第 5 章不一致，改為「蒙娜麗莎完成於 1503 年。」/);
  assert.match(text, /> ・修了：年份和第 5 章不一致，改為「全書改的句子」/);
  assert.doesNotMatch(text, /具名的學者/);
  const long = b.aiProofCallout({ checked: 1, fixes: [{ ...fix, replacement: '長'.repeat(100) }], open: [] }, 'r1', 'n1');
  assert.match(long, new RegExp('改為「長{60}…」'));
  assert.doesNotMatch(long, /長{61}/);
  const evil = b.aiProofCallout({ checked: 1, fixes: [{ ...fix, problem: '<b>x</b>', replacement: '\n> [!vam-review] y %%vam-review:r1:n1:fp%% [[l]] ==h==' }], open: [] }, 'r1', 'n1');
  assert.deepEqual(kinds(b.putProgramCallout(note(), evil)), ['review:r1']);
  assert.doesNotMatch(evil, /<b>|\[\[l|==h==/);
  const old = b.aiProofCallout({ checked: 1, fixes: [{ id: 'f1', quote: 'q', problem: '年份不一致', suggestion: '刪除此句' }], open: [] }, 'r1', 'n1');
  assert.match(old, /> ・修了：年份不一致\n/);
  assert.doesNotMatch(old, /刪除此句|改為/);
  const noProblem = b.aiProofCallout({ checked: 1, fixes: [{ ...fix, problem: '' }], open: [] }, 'r1', 'n1');
  assert.match(noProblem, /> ・修了：改為「蒙娜麗莎完成於 1503 年。」/);
});
test('align: a callout of another run or another chapter always goes', () => {
  const other = b.alignCallouts(note(), { runId: 'old', nodeId: 'n1', review: box() });
  assert.deepEqual(kinds(b.alignCallouts(other, want())), []);
});

// ---- the reconciler ----
const SLOT = (over = {}) => ({ key: '0:h', attempts: 0, round: 1, step: 'fix', done: true, checked: 14, fixed: 1, fixes: [{ id: 'f1', quote: 'q', problem: 'p', suggestion: '年份改成 1503' }], open: [{ id: 'o1', quote: 'q', problem: '委託人是誰', reason: 'sources_conflict' }], ...over });
const DATA = (over = {}) => ({ v: 1, aiProof: { n1: SLOT() }, runId: 'r1', phase: 'gate2', status: 'running', order: ['n1', 'n2'], globalPlanned: true, attempts: { global: 1 }, revisions: {}, budget: { used: 1, limit: 300 }, revision: 1, startedAt: 'a', phaseStartedAt: 'a', ...over });
function rig(data, extra = []) {
  const notes = new Map();
  const nodes = [];
  for (const id of ['n1', 'n2', ...extra]) { nodes.push({ id, path: `N/${id}.md` }); notes.set(`N/${id}.md`, note(`Body ${id}`)); }
  const map = { id: 'm', nodes };
  if (data) map.bookPipeline = data;
  const stages = { n1: 'needs-review', n2: 'checked' };
  const logs = []; const fail = new Set();
  const callouts = new b.BookCallouts({
    readMap: async () => map,
    readCard: async path => { const raw = notes.get(path); const id = nodes.find(n => n.path === path).id; const detail = raw; return { path, title: id, summary: '', prompt: '', detail, raw, settings: {}, fields: { pipelineStage: stages[id] ?? 'checked', bookRole: 'body', pipelineIssue: 'x' } }; },
    readText: async path => notes.get(path),
    write: async (path, transform) => { if (fail.has(path)) return 'refused'; const next = transform(notes.get(path)); if (next === notes.get(path)) return 'unchanged'; notes.set(path, next); return 'written'; },
    log: line => logs.push(line)
  });
  return { callouts, notes, map, logs, fail, kinds: id => kinds(notes.get(`N/${id}.md`)) };
}
const oldTrial = (id, runId = 'r1') => b.putProgramCallout(note(`Body ${id}`), legacy.trialCallout(1, 2, undefined, undefined, false, { runId, nodeId: id }));
test('reconcile: gate 1 draws no trial hint and takes an old one off', async () => {
  const r = rig(DATA({ phase: 'gate1', trial: ['n1', 'n2'] }));
  r.notes.set('N/n1.md', oldTrial('n1'));
  await r.callouts.reconcile('M');
  assert.deepEqual(r.kinds('n1'), [], 'an old trial box goes');
  assert.deepEqual(r.kinds('n2'), []);
  assert.equal(await r.callouts.reconcile('M'), undefined);
  r.map.bookPipeline = DATA({ phase: 'writing' });
  await r.callouts.reconcile('M');
  assert.deepEqual(r.kinds('n1'), []);
});
test('reconcile: the AI box is drawn at gate 2 and when done on a chapter whose proofread finished (or could not), not on one still being proofread; a rerun updates it', async () => {
  const r = rig(DATA({ aiProof: { n1: SLOT(), n2: SLOT({ done: false, step: 'proof' }) } }));
  await r.callouts.reconcile('M');
  assert.deepEqual(r.kinds('n1'), ['review:r1']);
  assert.deepEqual(r.kinds('n2'), [], 'not finished: no box');
  assert.match(r.notes.get('N/n1.md'), /AI 校對：查了 14 項，修了 1 處，1 處沒修好/);
  // the run is done and chapter 1 is run again: the box follows without any other event
  r.map.bookPipeline = DATA({ phase: 'done', aiProof: { n1: SLOT({ fixes: [], fixed: 0, open: [] }), n2: SLOT({ done: false, incomplete: true, checked: 0, fixes: [], open: [] }) } });
  await r.callouts.reconcile('M');
  assert.match(r.notes.get('N/n1.md'), /AI 校對：查了 14 項，修了 0 處，0 處沒修好/);
  assert.deepEqual(r.kinds('n1'), ['review:r1'], 'one box');
  assert.match(r.notes.get('N/n2.md'), /AI 校對：這章沒有查完，已列到書末/);
  r.map.bookPipeline = DATA({ phase: 'writing' });
  await r.callouts.reconcile('M');
  assert.deepEqual([r.kinds('n1'), r.kinds('n2')], [[], []], 'any other phase: gone');
});
test('reconcile: a callout of another run goes, on a chapter and on a note that is not a chapter of the run', async () => {
  const r = rig(DATA(), ['x1']);
  const old = b.putProgramCallout(note('Body'), legacy.trialCallout(1, 2, undefined, undefined, false, { runId: 'old', nodeId: 'x1' }));
  r.notes.set('N/x1.md', old);
  r.notes.set('N/n2.md', b.putProgramCallout(note('B2'), legacy.trialCallout(1, 2, undefined, undefined, false, { runId: 'old', nodeId: 'n2' })));
  await r.callouts.reconcile('M');
  assert.deepEqual(r.kinds('x1'), []);
  assert.deepEqual(r.kinds('n2'), []);
});
test('reconcile: an abandon whose clear failed leaves callouts; reopening the map with no run removes them', async () => {
  const r = rig(DATA({ phase: 'gate2' }));
  await r.callouts.reconcile('M');
  assert.deepEqual(r.kinds('n1'), ['review:r1']);
  r.fail.add('N/n1.md');
  assert.equal(await r.callouts.clear('M'), false, 'the clear reports it failed');
  assert.ok(r.logs.some(line => line.includes('callout_failed')));
  assert.deepEqual(r.kinds('n1'), ['review:r1'], 'the callout is still there');
  r.fail.clear();
  delete r.map.bookPipeline;
  await r.callouts.reconcile('M');
  assert.deepEqual(r.kinds('n1'), []);
  assert.deepEqual(r.kinds('n2'), []);
});
test('reconcile: after a restart whose clear failed, the old run callouts go on the next open (the new run has its own)', async () => {
  const r = rig(DATA({ phase: 'gate2' }));
  await r.callouts.reconcile('M');
  assert.deepEqual(r.kinds('n1'), ['review:r1']);
  r.map.bookPipeline = DATA({ runId: 'r2', phase: 'writing', order: ['n2'] });
  await r.callouts.reconcile('M');
  assert.deepEqual(r.kinds('n1'), [], 'n1 is no chapter of the new run: its old callout is removed');
});
test('reconcile: an unusable bookPipeline is left alone; a failed write is logged and never thrown; dispose stops writes', async () => {
  const bad = rig({ v: 9 });
  bad.notes.set('N/n1.md', b.putProgramCallout(note(), legacy.trialCallout(1, 1, undefined, undefined, false, { runId: 'r1', nodeId: 'n1' })));
  await bad.callouts.reconcile('M');
  assert.deepEqual(bad.kinds('n1'), ['trial:r1']);
  const r = rig(DATA());
  r.fail.add('N/n1.md');
  await assert.doesNotReject(r.callouts.reconcile('M'));
  assert.ok(r.logs.some(line => line.includes('callout_failed')));
  const d = rig(DATA());
  d.callouts.dispose();
  await d.callouts.reconcile('M');
  assert.deepEqual(d.kinds('n1'), []);
  assert.equal(await d.callouts.collapse('N/n1.md'), 'refused');
});
test('reconcile: asks that arrive while one waits share it', async () => {
  const r = rig(DATA());
  const first = r.callouts.reconcile('M');
  assert.equal(r.callouts.reconcile('M'), first);
  await first;
});

test('reconcile: with a hint, a map of plain notes (no picture book, or no marker) reads and writes nothing', async () => {
  const plain = ['x1', 'x2', 'x3', 'x4', 'x5'];
  const build = data => {
    const notes = new Map(); const nodes = [];
    for (const id of ['n1', 'n2', ...plain]) { nodes.push({ id, path: `N/${id}.md` }); notes.set(`N/${id}.md`, note(`Body ${id}`)); }
    const map = { id: 'm', nodes }; if (data) map.bookPipeline = data;
    const count = { text: 0, card: 0, write: 0 };
    const callouts = new b.BookCallouts({
      readMap: async () => map,
      readCard: async path => { count.card++; const raw = notes.get(path); return { path, title: path.slice(2, -3), summary: '', prompt: '', detail: raw, raw, settings: {}, fields: { pipelineStage: 'checked', bookRole: 'body' } }; },
      readText: async path => { count.text++; return notes.get(path); },
      write: async () => { count.write++; return 'written'; },
      log() {}
    });
    return { callouts, count, notes };
  };
  const none = () => false;
  const noBook = build(undefined);
  await noBook.callouts.reconcile('M', none);
  assert.deepEqual(noBook.count, { text: 0, card: 0, write: 0 }, 'no picture book: no read');
  const writing = build(DATA({ phase: 'writing' }));
  await writing.callouts.reconcile('M', none);
  assert.deepEqual(writing.count, { text: 0, card: 0, write: 0 }, 'a book with no marker in a non-gate phase: no read');
  // Without the hint the same map is read note by note (the old, slower behaviour stays for callers that have no notes in memory).
  const unhinted = build(undefined);
  await unhinted.callouts.reconcile('M');
  assert.equal(unhinted.count.text, 7);
});
test('reconcile: with a hint, only a note that may carry a callout is read and rewritten; unknown is read', async () => {
  const r = rig(undefined, ['x1', 'x2']);
  const stale = b.putProgramCallout(note('B'), legacy.trialCallout(1, 2, undefined, undefined, false, { runId: 'old', nodeId: 'x1' }));
  r.notes.set('N/x1.md', stale);
  r.notes.set('N/x2.md', stale);
  await r.callouts.reconcile('M', id => (id === 'x1' ? true : id === 'x2' ? false : undefined));
  assert.deepEqual(r.kinds('x1'), [], 'the note with a marker is cleaned');
  assert.deepEqual(r.kinds('x2'), ['trial:old'], 'a note known to have none is not touched');
  assert.deepEqual(r.kinds('n1'), [], 'an unknown note is read (and was clean)');
});

// ---- reading (preview) mode ----
const mdView = (path, mode, text, log) => ({
  file: { path }, getMode: () => mode,
  editor: { getValue: () => text, offsetToPos: n => ({ line: 0, ch: n }), transaction: spec => log.push(spec) }
});
test('editorViewsOf: a view in reading mode is not an editor path, so the note is written as a file', async () => {
  const log = []; let file = 'abc';
  const views = [mdView('p', 'preview', 'stale', log), mdView('other', 'source', 'x', log)];
  assert.equal(b.editorViewsOf('p', views).length, 0);
  const write = b.createNoteWriter({
    openViews: path => b.editorViewsOf(path, views),
    rawGuarded: async (path, transform, o) => { if (!o.authorize()) return 'discarded'; file = transform(file); return 'written'; }
  });
  assert.equal(await write('p', upper), 'written');
  assert.equal(file, 'ABC');
  assert.deepEqual(log, []);
});
test('editorViewsOf: a view in live preview or source mode edits through the editor', async () => {
  const log = [];
  const views = [mdView('p', 'source', 'abc', log)];
  const write = b.createNoteWriter({ openViews: path => b.editorViewsOf(path, views), rawGuarded: async () => 'written' });
  assert.equal(await write('p', upper), 'written');
  assert.equal(log.length, 1);
});

// ---- fix packet 5: the third trial chapter ----
test('reconcile: gate 1 with three chapters carrying older trial boxes takes every one off', async () => {
  const r = rig(DATA({ phase: 'gate1', order: ['n1', 'n2', 'n3'], trial: ['n1', 'n2', 'n3'] }), ['n3']);
  for (const id of ['n1', 'n2', 'n3']) r.notes.set(`N/${id}.md`, oldTrial(id));
  await r.callouts.reconcile('M');
  for (const id of ['n1', 'n2', 'n3']) assert.deepEqual(r.kinds(id), [], id);
});
test('reconcile: a chapter rewritten after the aligner read it (its snapshot already shows the box) still gets the AI box', async () => {
  const r = rig(DATA({ order: ['n1', 'n2', 'n3'], aiProof: { n1: SLOT(), n2: SLOT(), n3: SLOT() } }), ['n3']);
  await r.callouts.reconcile('M');
  assert.deepEqual(r.kinds('n3'), ['review:r1']);
  const withHint = r.notes.get('N/n3.md');
  // n3 is read (callout present), then the chapter is written again (callout gone) before the aligner reaches it
  const snapshot = new Map(r.notes);
  const callouts = new b.BookCallouts({
    readMap: async () => r.map,
    readCard: async path => { const raw = snapshot.get(path) ?? r.notes.get(path); if (path === 'N/n3.md') r.notes.set(path, note('Body n3 rewritten')); return { path, title: path.slice(2, -3), summary: '', prompt: '', detail: raw, raw, settings: {}, fields: { pipelineStage: 'checked', bookRole: 'body' } }; },
    readText: async path => r.notes.get(path),
    write: async (path, transform) => { const next = transform(r.notes.get(path)); if (next === r.notes.get(path)) return 'unchanged'; r.notes.set(path, next); return 'written'; },
    log: () => undefined
  });
  assert.ok(withHint.includes('vam-review'));
  await callouts.reconcile('M');
  assert.deepEqual(r.kinds('n3'), ['review:r1'], 'the rewritten chapter carries the box again');
});

// ---- truthful boxes: the box tells what the proofread found, from the saved result, in the reader's words ----
test('gate 2 AI box lists every fix and every open item on its own line, past three, with the reason in words and no tick box', async () => {
  const fixes = ['a', 'b', 'c', 'd'].map(x => ({ id: x, quote: 'q', problem: `改${x}`, suggestion: 's' }));
  const open = ['e', 'f'].map(x => ({ id: x, quote: 'q', problem: `問題${x}`, reason: x === 'e' ? 'still_present' : 'source_unreachable' }));
  const r = rig(DATA({ aiProof: { n1: SLOT({ fixes, open, fixed: 4, checked: 9 }) } }));
  await r.callouts.reconcile('M');
  const lines = r.notes.get('N/n1.md').split('\n').filter(l => l.startsWith('> ・'));
  assert.equal(lines.length, 6, 'one line each');
  assert.ok(lines.some(l => l.includes('修了：改d')));
  assert.ok(lines.some(l => l.includes('問題e') && l.includes('AI 修改後再查，問題仍在，修正次數已用完')));
  assert.ok(lines.some(l => l.includes('問題f') && l.includes('查不到可靠的來源')));
  assert.doesNotMatch(r.notes.get('N/n1.md'), /\[ \]|\[x\]/);
});

test('R2 gate 2 AI box: what the whole-book proofread changed in a chapter is told in that chapter\'s box, and the boxes add up to the bar', async () => {
  const bookFix = (id, chapterId) => ({ id, quote: 'q', problem: `全書改${id}`, suggestion: 's', chapter: 1, chapterId });
  const data = DATA({ order: ['n1', 'n2'], aiProof: { n1: SLOT({ fixes: [], fixed: 0, open: [] }), n2: SLOT({ fixes: [], fixed: 0, open: [] }) }, bookProof: { key: 'k', attempts: 0, round: 1, step: 'proof', done: true, checked: 3, fixed: 3, fixes: [bookFix('B1', 'n1'), bookFix('B2', 'n1'), bookFix('B3', 'n2')], open: [] } });
  const r = rig(data, ['n2']);
  await r.callouts.reconcile('M');
  const n1 = r.notes.get('N/n1.md');
  assert.match(n1, /全書校對另修了 2 處/);
  assert.equal((n1.match(/^> ・修了：全書改/gm) ?? []).length, 2);
  assert.match(r.notes.get('N/n2.md'), /全書校對另修了 1 處/);
  const bundle = S.load('experiences/visual-map/book-pipeline-ui.ts');
  const listed = ['n1', 'n2'].reduce((sum, id) => sum + (r.notes.get(`N/${id}.md`).match(/^> ・修了：/gm) ?? []).length, 0);
  assert.equal(listed, bundle.bookBarState(data, undefined, () => undefined).ai.fixed, 'the boxes list as many fixes as the bar counts');
});

// ---- the writer asks open reading views to render again (live v6fix2: tabs opened at gate 1 kept the old box) ----
test('writer: a written note makes its reading views render again; unchanged or refused does not', async () => {
  const seen = [];
  let file = 'abc';
  const write = b.createNoteWriter({ openViews: () => [], rawGuarded: async (p, t) => { file = t(file); return 'written'; }, rerender: p => seen.push(p) });
  assert.equal(await write('N/a.md', upper), 'written');
  assert.deepEqual(seen, ['N/a.md']);
  assert.equal(await write('N/a.md', upper), 'unchanged');
  const refused = b.createNoteWriter({ openViews: () => [], rawGuarded: async () => 'discarded', rerender: p => seen.push(p) });
  assert.equal(await refused('N/b.md', upper), 'refused');
  assert.deepEqual(seen, ['N/a.md']);
  const viaEditor = b.createNoteWriter({ openViews: () => [view('abc')], rawGuarded: async () => 'written', rerender: p => seen.push(p) });
  assert.equal(await viaEditor('N/c.md', upper), 'written');
  assert.deepEqual(seen, ['N/a.md', 'N/c.md']);
});

// ---- the render waits for the view to hold the new text (live: the write returns before Obsidian loads it into the view) ----
test('reading re-render: a view is drawn only once it holds the file text the write left; others are left alone', async () => {
  let file = '[!vam-trial]';
  const drawn = [];
  // Obsidian loads the written file into the view a few ticks after the write returns.
  const lagging = { held: '[!vam-trial]', draws: drawn };
  const views = [
    { path: 'N/a.md', reading: true, data: () => lagging.held, rerender: () => drawn.push(lagging.held) },
    { path: 'N/a.md', reading: false, data: () => 'x', rerender: () => drawn.push('editing') },
    { path: 'N/b.md', reading: true, data: () => 'x', rerender: () => drawn.push('other') }
  ];
  const write = b.createNoteWriter({
    openViews: () => [],
    rawGuarded: async (p, t) => { file = t(file); return 'written'; },
    rerender: path => b.rerenderReadingViewsWhenLoaded(views, path, async () => file, async () => { lagging.held = file; })
  });
  assert.equal(await write('N/a.md', () => '[!vam-review]'), 'written');
  await new Promise(done => setImmediate(done));
  assert.deepEqual(drawn, ['[!vam-review]']);
  assert.equal(await b.rerenderReadingViewsWhenLoaded([], 'N/a.md', async () => file, async () => undefined), 0);
  // a view that never catches up is drawn anyway after the allowed pauses
  let pauses = 0;
  const stuck = [{ path: 'N/a.md', reading: true, data: () => 'old', rerender: () => drawn.push('stuck') }];
  assert.equal(await b.rerenderReadingViewsWhenLoaded(stuck, 'N/a.md', async () => 'new', async () => { pauses++; }, 3), 1);
  assert.equal(pauses, 3);
  assert.equal(drawn.at(-1), 'stuck');
});

test('R1 B1: the box title counts what slot.fixed says, not the list length', () => {
  const text = b.aiProofCallout({ checked: 3, fixed: 1, fixes: [{ problem: 'a' }, { problem: 'b' }], open: [] }, 'r1', 'n1');
  const title = text.split('\n')[0];
  assert.equal(title, b.aiProofCallout({ checked: 3, fixed: 1, fixes: [{ problem: 'a' }], open: [] }, 'r1', 'n1').split('\n')[0]);
});

test('reconcile: no card carries a trial box at the plan gate, nor once the trial has started (the trial hint is gone)', async () => {
  const r = rig(DATA({ phase: 'gate1', planReview: true, trial: ['n1', 'n2'] }));
  await r.callouts.reconcile('M');
  assert.deepEqual(r.kinds('n1'), [], 'no trial box on the first card at the plan gate');
  assert.deepEqual(r.kinds('n2'), []);
  r.map.bookPipeline = DATA({ phase: 'gate1', trial: ['n1', 'n2'] });
  await r.callouts.reconcile('M');
  assert.deepEqual(r.kinds('n1'), []);
});
