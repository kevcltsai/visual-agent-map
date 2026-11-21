// Picture-book callouts (T4 of "book without a panel"): the write coordinator, the idempotent aligner and the map-level reconciler,
// on fake ports with in-memory notes. How Obsidian shows the callouts and how a real editor takes the transaction is UI evidence.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('./support.cjs');
const dom = require('./support-dom.cjs');
const { loadSource } = require('./support-replay.cjs');

const b = loadSource(`
export * from "./experiences/visual-map/book-pipeline-callouts";
export { findProgramCallouts, readReviewState, putProgramCallout, reviewCallout, trialCallout } from "./experiences/visual-map/book-pipeline-review";
export { setUiLanguage } from "./i18n";
export { composeProofRecord, proofKey } from "./core/book-pipeline/proof";
export { replaceResearchRecord, chapterBody } from "./core/book-pipeline/note-sections";
export { projectProofBody } from "./core/book-pipeline/book-notes";
export { stripImageLines } from "./core/book-pipeline/image-slots";
`, { obsidian: { ...S.obsidian, Modal: dom.makeModal(), Notice: dom.makeNotice([]), Component: class {}, MarkdownRenderChild: class {} } }, { createFragment: dom.createFragment, requestAnimationFrame: () => 1, cancelAnimationFrame() {}, window: { setTimeout, clearTimeout, setInterval, clearInterval } });
b.setUiLanguage('zh-TW');

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
const box = (fp = 'fp1') => ({ fp, build: () => b.reviewCallout({ id: 'n1', index: 1, title: 'T', stage: 'needs-review', structureUnmet: 0, factsOpen: 0, galleryBare: false, seam: false }, ['x'], undefined, fp, 'r1') });
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
test('align: a callout of another run or another chapter always goes', () => {
  const other = b.alignCallouts(note(), { runId: 'old', nodeId: 'n1', review: box() });
  assert.deepEqual(kinds(b.alignCallouts(other, want())), []);
});

// ---- the reconciler ----
const DATA = (over = {}) => ({ v: 1, runId: 'r1', phase: 'gate2', status: 'running', order: ['n1', 'n2'], globalPlanned: true, attempts: { global: 1 }, revisions: {}, budget: { used: 1, limit: 300 }, revision: 1, startedAt: 'a', phaseStartedAt: 'a', ...over });
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
test('reconcile: gate 1 draws the trial hint on the trial chapters (stopped wording when stopped), leaving gate 1 removes it', async () => {
  const r = rig(DATA({ phase: 'gate1', trial: ['n1', 'n2'] }));
  await r.callouts.reconcile('M');
  assert.deepEqual(r.kinds('n1'), ['trial:r1']);
  assert.deepEqual(r.kinds('n2'), ['trial:r1']);
  const running = r.notes.get('N/n1.md');
  r.map.bookPipeline = DATA({ phase: 'gate1', status: 'stopped', trial: ['n1', 'n2'] });
  await r.callouts.reconcile('M');
  assert.notEqual(r.notes.get('N/n1.md'), running, 'the stopped wording replaced the running one');
  assert.equal(await r.callouts.reconcile('M'), undefined);
  const before = r.notes.get('N/n1.md');
  await r.callouts.reconcile('M');
  assert.equal(r.notes.get('N/n1.md'), before, 'idempotent');
  r.map.bookPipeline = DATA({ phase: 'writing' });
  await r.callouts.reconcile('M');
  assert.deepEqual(r.kinds('n1'), []);
  assert.deepEqual(r.kinds('n2'), []);
});
test('reconcile: gate 2 draws a review box only on a chapter that needs a look; an older gate 2 map reopened gets its boxes', async () => {
  const r = rig(DATA());
  await r.callouts.reconcile('M');
  assert.deepEqual(r.kinds('n1'), ['review:r1']);
  assert.deepEqual(r.kinds('n2'), []);
});
test('reconcile: a callout of another run goes, on a chapter and on a note that is not a chapter of the run', async () => {
  const r = rig(DATA(), ['x1']);
  const old = b.putProgramCallout(note('Body'), b.trialCallout(1, 2, undefined, undefined, false, { runId: 'old', nodeId: 'x1' }));
  r.notes.set('N/x1.md', old);
  r.notes.set('N/n2.md', b.putProgramCallout(note('B2'), b.trialCallout(1, 2, undefined, undefined, false, { runId: 'old', nodeId: 'n2' })));
  await r.callouts.reconcile('M');
  assert.deepEqual(r.kinds('x1'), []);
  assert.deepEqual(r.kinds('n2'), []);
});
test('reconcile: an abandon whose clear failed leaves callouts; reopening the map with no run removes them', async () => {
  const r = rig(DATA({ phase: 'gate1', trial: ['n1', 'n2'] }));
  await r.callouts.reconcile('M');
  assert.deepEqual(r.kinds('n1'), ['trial:r1']);
  r.fail.add('N/n1.md');
  assert.equal(await r.callouts.clear('M'), false, 'the clear reports it failed');
  assert.ok(r.logs.some(line => line.includes('callout_failed')));
  assert.deepEqual(r.kinds('n1'), ['trial:r1'], 'the callout is still there');
  r.fail.clear();
  delete r.map.bookPipeline;
  await r.callouts.reconcile('M');
  assert.deepEqual(r.kinds('n1'), []);
  assert.deepEqual(r.kinds('n2'), []);
});
test('reconcile: after a restart whose clear failed, the old run callouts go on the next open (the new run has its own)', async () => {
  const r = rig(DATA({ phase: 'gate1', trial: ['n1'] }));
  await r.callouts.reconcile('M');
  r.map.bookPipeline = DATA({ runId: 'r2', phase: 'writing', order: ['n2'] });
  await r.callouts.reconcile('M');
  assert.deepEqual(r.kinds('n1'), [], 'n1 is no chapter of the new run: its old callout is removed');
});
test('reconcile: an unusable bookPipeline is left alone; a failed write is logged and never thrown; dispose stops writes', async () => {
  const bad = rig({ v: 9 });
  bad.notes.set('N/n1.md', b.putProgramCallout(note(), b.trialCallout(1, 1, undefined, undefined, false, { runId: 'r1', nodeId: 'n1' })));
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
  const stale = b.putProgramCallout(note('B'), b.trialCallout(1, 2, undefined, undefined, false, { runId: 'old', nodeId: 'x1' }));
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
test('reconcile: gate 1 with three trial chapters writes the callout on every one (numbering 1/3, 2/3, 3/3), also when one already carries an older one', async () => {
  const r = rig(DATA({ phase: 'gate1', order: ['n1', 'n2', 'n3'], trial: ['n1', 'n2', 'n3'] }), ['n3']);
  // n3 was written before: it carries a trial callout of this run with another count, and a stale review box
  r.notes.set('N/n3.md', b.putProgramCallout(note('B3'), b.trialCallout(1, 2, undefined, undefined, false, { runId: 'r1', nodeId: 'n3' })));
  await r.callouts.reconcile('M');
  for (const id of ['n1', 'n2', 'n3']) assert.deepEqual(r.kinds(id), ['trial:r1'], id);
  assert.ok(r.notes.get('N/n3.md').includes('3／3') || r.notes.get('N/n3.md').includes('3/3'), 'third chapter says 3 of 3');
});
test('reconcile: a chapter rewritten after the aligner read it (its snapshot already shows the callout) still gets the callout', async () => {
  const r = rig(DATA({ phase: 'gate1', order: ['n1', 'n2', 'n3'], trial: ['n1', 'n2', 'n3'] }), ['n3']);
  await r.callouts.reconcile('M');
  assert.deepEqual(r.kinds('n3'), ['trial:r1']);
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
  assert.ok(withHint.includes('vam-trial'));
  await callouts.reconcile('M');
  assert.deepEqual(r.kinds('n3'), ['trial:r1'], 'the rewritten chapter carries the hint again');
});

// ---- truthful boxes (live v6fix2): every unresolved reason is in the reader-visible box, from the same issue data as `pipeline-issue` ----
const proofDetail = (nodeId, items, runId = 'r1') => {
  const body = 'Body text';
  const key = b.proofKey({ runId, nodeId, revision: 0, body: b.projectProofBody(b.stripImageLines(body)), checklist: [] });
  const result = { aggregate: items.some(i => i.status !== 'met') ? 'needs-review' : 'checked', items: items.map(i => ({ type: 'structure', sources: [], ...i })) };
  return b.replaceResearchRecord(body, b.composeProofRecord(key, result));
};
function truthRig(data, cards) {
  const notes = new Map(); const nodes = [];
  for (const id of Object.keys(cards)) { nodes.push({ id, path: `N/${id}.md` }); notes.set(`N/${id}.md`, note(cards[id].detail)); }
  const map = { id: 'm', nodes, bookPipeline: data };
  const callouts = new b.BookCallouts({
    readMap: async () => map,
    readCard: async path => { const raw = notes.get(path); const id = nodes.find(n => n.path === path).id; return { path, title: id, summary: '', prompt: '', detail: raw, raw, settings: {}, fields: { pipelineStage: 'needs-review', bookRole: 'body', pipelineIssue: cards[id].issue } }; },
    readText: async path => notes.get(path),
    write: async (path, transform) => { const next = transform(notes.get(path)); if (next === notes.get(path)) return 'unchanged'; notes.set(path, next); return 'written'; },
    log: () => {}
  });
  return { callouts, notes, box: id => { const m = /^> \[!vam-(?:trial|review)\][^]*?%%vam-callout-version:1%%/m.exec(notes.get(`N/${id}.md`)); return m ? m[0] : ''; } };
}
const U = (id, note) => ({ id, status: 'unmet', note });
test('gate 1 trial box lists length, images, mismatch and each unmet proof item (v6fix2 家庭菜園入門)', async () => {
  const issue = 'proof unmet: C6 C7 length:under:4854:5000-8000:字:v2 images:under:4:6 images:off:5';
  const r = truthRig(DATA({ phase: 'gate1', trial: ['n1'], order: ['n1'] }), { n1: { issue, detail: proofDetail('n1', [U('C6', '採收方式沒有交代'), U('C7', '結尾沒有接到下一章')]) } });
  await r.callouts.reconcile('M');
  const box = r.box('n1');
  assert.match(box, /\[!vam-trial\]/);
  assert.match(box, /4854/); assert.match(box, /5000/);
  assert.match(box, /採收方式沒有交代/); assert.match(box, /結尾沒有接到下一章/);
  assert.match(box, /4.*6|6.*4/, 'image count against the minimum');
  assert.match(box, /圖.*5|5.*圖/, 'image 5 does not match its text');
});
test('gate 2 review box lists every unmet proof item on its own line (v6fix2 澆水施肥與病蟲害)', async () => {
  const issue = 'proof unmet: C5 C7 images:under:3:6';
  const r = truthRig(DATA({ order: ['n1'] }), { n1: { issue, detail: proofDetail('n1', [U('C5', '練習並非最後一部分'), U('C7', '結尾並非談第一批收成'), { id: 'C1', status: 'met', note: 'ok' }]) } });
  await r.callouts.reconcile('M');
  const lines = r.box('n1').split('\n').filter(l => l.startsWith('> ・'));
  assert.ok(lines.some(l => l.includes('練習並非最後一部分')), 'C5 has its own line');
  assert.ok(lines.some(l => l.includes('結尾並非談第一批收成')), 'C7 has its own line');
  assert.ok(lines.some(l => /3.*6/.test(l)), 'images under');
  assert.ok(!lines.some(l => l.includes('練習並非最後一部分') && l.includes('結尾並非談')), 'not merged in one bullet');
});
test('gate 2 box keeps every unmet proof item even past three', async () => {
  const items = ['a', 'b', 'c', 'd', 'e'].map((x, i) => U(`C${i + 1}`, `原因${x}`));
  const r = truthRig(DATA({ order: ['n1'] }), { n1: { issue: 'proof unmet: C1 C2 C3 C4 C5', detail: proofDetail('n1', items) } });
  await r.callouts.reconcile('M');
  for (const x of ['a', 'b', 'c', 'd', 'e']) assert.match(r.box('n1'), new RegExp(`原因${x}`));
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
