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
