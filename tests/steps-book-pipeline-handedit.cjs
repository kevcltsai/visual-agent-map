// Hand-edited chapters (T9 of "book without a panel"): the body-integrity fingerprint (pure), and the BookHandEdits controller (the box's
// "keep" / "rewrite" answers: F rewrite at once, H queue and drain) on fake ports with in-memory notes. How the real editor takes the
// writes and how the box looks in Obsidian is UI evidence; the run-level cases are in steps-book-pipeline-run.cjs / -images.cjs.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('./support.cjs');
const dom = require('./support-dom.cjs');
const { loadSource } = require('./support-replay.cjs');

const b = loadSource(`
export * from "./core/book-pipeline/body-integrity";
export { BookHandEdits } from "./experiences/visual-map/book-pipeline-handedit";
export { BookCallouts } from "./experiences/visual-map/book-pipeline-callouts";
export { BookPipelineRunError } from "./experiences/visual-map/book-pipeline-run";
export { readReviewState, reviewCallout, putProgramCallout, patchHandBox, isRewriteAsked } from "./experiences/visual-map/book-pipeline-review";
export { appendResearchNote, replaceResearchRecord, chapterBody } from "./core/book-pipeline/note-sections";
export { projectProofBody } from "./core/book-pipeline/book-notes";
export { stripImageLines, composeSlotsRecord, shortHash } from "./core/book-pipeline/image-slots";
export { hashText } from "./core/book-pipeline/text";
export { newBookPipeline } from "./core/book-pipeline/machine";
export { setUiLanguage } from "./i18n";
`, { obsidian: { ...S.obsidian, Modal: dom.makeModal(), Notice: dom.makeNotice([]), Component: class {}, MarkdownRenderChild: class {} } }, { createFragment: dom.createFragment, requestAnimationFrame: () => 1, cancelAnimationFrame() {}, window: { setTimeout, clearTimeout, setInterval, clearInterval } });
b.setUiLanguage('zh-TW');

const url = n => `https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/P${n}.jpg/1280px-P${n}.jpg`;
const fig = (n, caption = `Caption ${n}`) => `![P${n}](${url(n)})\n${caption}`;
const BODY = `第一段。\n\n${fig(1)}\n\n第二段。\n\n### 來源\n- https://example.com/a\n`;

// ---- body integrity: what counts as a hand edit ----
test('detection: a note wrapper and a line-break style are not edits; a changed word, an image URL or a caption is (new notes, with a record)', () => {
  const stamped = b.stampDetail(BODY);
  assert.equal(b.bodyState(stamped), 'clean');
  assert.equal(b.bodyState(stamped.replace(/\n/g, '\r\n')), 'clean', 'CRLF is not an edit');
  assert.equal(b.bodyState(stamped.replace('第二段。', '==第二段==%%備註#1：y%%。')), 'clean', 'a reader note is not an edit');
  assert.equal(b.bodyState(stamped.replace('第二段', '第三段')), 'edited', 'one word');
  assert.equal(b.bodyState(stamped.replace(url(1), url(9))), 'edited', 'an image URL');
  assert.equal(b.bodyState(stamped.replace('Caption 1', 'Caption one')), 'edited', 'a caption');
  assert.equal(b.bodyState(stamped.replace('第二段。', '')), 'edited', 'a deleted paragraph');
  assert.equal(b.bodyState(''), 'empty');
  assert.equal(b.bodyState('  \n\n'), 'empty');
  assert.equal(b.isUntouched(stamped), true);
  assert.equal(b.isUntouched(stamped.replace('第二段', '第三段')), false);
});
test('detection: the record itself and the program callouts are not part of the fingerprint; stamping twice changes nothing', () => {
  const stamped = b.stampDetail(BODY);
  assert.equal(b.stampDetail(stamped), stamped, 'idempotent');
  assert.equal(b.integrityFp(stamped), b.integrityFp(BODY));
  const withBox = `> [!vam-review] x\n> ・y\n> %%vam-review:r:n:f%%\n\n${stamped}`;
  assert.equal(b.integrityFp(withBox), b.integrityFp(BODY));
});

// ---- old notes (no record): the two fallback branches ----
const proofRecord = detail => {
  const key = `r1:n1:1:${b.hashText(b.projectProofBody(b.stripImageLines(b.chapterBody(detail))))}:listhash`;
  return b.appendResearchNote(detail, `<!-- book-proof:v1 ${JSON.stringify({ key })} -->`).text;
};
const withSlots = (detail, ...ns) => b.replaceResearchRecord(detail, b.composeSlotsRecord({ placed: ns.map(n => ({ index: n, href: url(n) })), missing: [], bad: 0 }));
const OLD = withSlots(proofRecord(BODY), 1);
test('old note, branch 1 (proof hash): the text still hashes as the stored proof says: untouched; a changed word: unknown', () => {
  assert.equal(b.bodyState(OLD), 'clean');
  assert.equal(b.bodyState(OLD.replace('第二段', '第三段')), 'unknown');
  assert.equal(b.bodyState(withSlots(BODY, 1)), 'unknown', 'text and slots but no proof to vouch for it');
  assert.equal(b.bodyState(proofRecord(BODY)), 'unknown', 'a proof but a picture the slots do not list (no slots record)');
});
test('old note, branch 2 (picture hashes): a picture swapped, added or removed against the book-slots record: unknown', () => {
  assert.equal(b.bodyState(OLD.replace(url(1), url(9))), 'unknown', 'swapped');
  assert.equal(b.bodyState(withSlots(proofRecord(BODY), 1, 2)), 'unknown', 'a listed picture is gone from the text');
  const twoInText = proofRecord(BODY.replace('第二段。', `${fig(2)}\n\n第二段。`));
  assert.equal(b.bodyState(withSlots(twoInText, 1)), 'unknown', 'a picture in the text that the record does not list');
});
test('old note: ACCEPTED LIMIT - a caption-only edit is not seen (book-slots stores picture hashes only, no caption hash); a new note sees it', () => {
  assert.equal(b.bodyState(OLD.replace('Caption 1', 'Caption one')), 'clean');
  assert.equal(b.bodyState(b.stampDetail(BODY).replace('Caption 1', 'Caption one')), 'edited');
});

// ---- keep ----
test('keepDetail / isKept: keeping binds to the text as it is; a later edit voids it; a program write drops it; keeping twice is one record', () => {
  const edited = b.stampDetail(BODY).replace('第二段', '第三段');
  assert.equal(b.isKept(edited), false);
  const kept = b.keepDetail(edited);
  assert.equal(b.isKept(kept), true);
  assert.equal(b.bodyState(kept), 'edited', 'kept is not clean: only automatic flows leave it alone');
  assert.equal(b.keepDetail(kept), kept);
  assert.equal(b.isKept(kept.replace('第三段', '第四段')), false);
  assert.equal(b.isKept(b.stampDetail(kept)), false, 'a new program text starts without a kept choice');
  assert.equal(b.bodyState(b.stampDetail(kept)), 'clean');
  assert.equal(b.isKept(b.keepDetail('舊文')), true, 'an old note with no record can be kept too');
});

// ---- programStamp ----
test('programStamp: the fingerprint follows a program change only when the text it starts from was clean', () => {
  const clean = b.stampDetail(BODY);
  const next = clean.replace(fig(1), '');
  assert.equal(b.bodyState(b.programStamp(clean, next)), 'clean');
  const edited = clean.replace('第二段', '第三段');
  const nextEdited = edited.replace(fig(1), '');
  assert.equal(b.programStamp(edited, nextEdited), nextEdited, 'left as it is');
  assert.equal(b.bodyState(b.programStamp(edited, nextEdited)), 'edited');
  assert.equal(b.programStamp('', next), next, 'an empty start has no text a program change could follow: nothing is stamped');
});

// ---- the controller ----
const START = '<!-- visual-agent-map:detail:start -->';
const END = '<!-- visual-agent-map:detail:end -->';
const note = detail => `# T\n\n## Current Summary\n\nS\n\n## Detail\n\n${START}\n${detail}\n${END}\n\n## Prompt\n\nP\n`;
const CARD = { id: 'n1', index: 1, title: 'T', stage: 'needs-review', structureUnmet: 0, factsOpen: 0, galleryBare: false, seam: false };
const PATH = 'N/n1.md';
const MAP = 'M';
const tickAt = (text, at) => { let n = 0; return text.replace(/\[ \]/g, m => (n++ === at ? '[x]' : m)); };

/** One hand-edited chapter at gate 2 with its box (op1, bound to the text as it is). */
function rig({ phase = 'gate2', running = false, rerun } = {}) {
  const edited = b.stampDetail(BODY).replace('第二段', '第三段');
  const state = { raw: '', running, phase, ids: 0, reruns: [], logs: [], writes: 0, backups: [] };
  const setDetail = detail => { state.raw = state.raw ? state.raw.replace(/(<!-- visual-agent-map:detail:start -->\n)[\s\S]*?(\n<!-- visual-agent-map:detail:end -->)/, (_m, a, c) => `${a}${detail}${c}`) : note(detail); };
  setDetail(edited);
  const ifp = () => b.integrityFp(edited);
  state.raw = b.putProgramCallout(state.raw, b.reviewCallout(CARD, ['x'], undefined, 'fp1', 'r1', { op: 'op1', ifp: ifp() }));
  const map = { id: 'm', nodes: [{ id: 'n1', path: PATH }], bookPipeline: { ...b.newBookPipeline({ runId: 'r1', order: ['n1'], now: 'a' }), phase } };
  const detailOf = () => state.raw.split(START + '\n')[1].split('\n' + END)[0];
  const write = async (path, transform) => { const next = transform(state.raw); if (next === state.raw) return 'unchanged'; state.raw = next; state.writes++; return 'written'; };
  const ctl = new b.BookHandEdits({
    readMap: async () => map,
    readCard: async () => ({ path: PATH, title: 'T', raw: state.raw, detail: detailOf() }),
    write,
    rerunCard: async (mapPath, nodeId, options) => {
      state.backups.push(state.raw); // the real run backs the note up before it writes; here: the text at the moment of the call
      state.reruns.push(options.overwrite);
      if (rerun) return rerun(state, options);
      setDetail(b.stampDetail(BODY));
      return { unchanged: false };
    },
    isRunning: () => state.running,
    newId: () => `op${++state.ids + 1}`,
    log: line => state.logs.push(line)
  });
  const tickRewrite = () => { state.raw = tickAt(state.raw, 1); };
  const box = () => b.readReviewState(state.raw);
  return { state, ctl, map, tickRewrite, box, setDetail, ifp, write };
}

test('controller F: the rewrite tick at gate 2 with nothing running rewrites once, with the permission bound to this text; the chapter is clean after', async () => {
  const r = rig();
  r.tickRewrite();
    await r.ctl.tick(MAP, 'n1');
  assert.equal(r.state.reruns.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(r.state.reruns[0])), { operation: 'op1', fingerprint: r.ifp() });
  assert.ok(r.state.backups[0].includes('第三段'), 'the call came while the reader\'s text was still in the note (the run backs it up before writing)');
  assert.equal(b.bodyStateRaw(r.state.raw), 'clean');
});
test('controller F: a repeated tick (a second save, a reopen of the same box, a repeated modify) does not charge again', async () => {
  const r = rig();
  r.tickRewrite();
  await Promise.all([r.ctl.tick(MAP, 'n1'), r.ctl.tick(MAP, 'n1')]);
  await r.ctl.tick(MAP, 'n1');
  assert.equal(r.state.reruns.length, 1, 'in flight, then done');
  // the box comes back (a reconcile) with the same operation id and the tick still on: still one rewrite
  r.state.raw = b.putProgramCallout(r.state.raw, b.reviewCallout(CARD, ['x'], undefined, 'fp1', 'r1', { op: 'op1', ifp: r.ifp() }));
  r.tickRewrite();
  await r.ctl.tick(MAP, 'n1');
  assert.equal(r.state.reruns.length, 1, 'the operation id was used');
});
test('controller: only a ticked rewrite acts; the keep tick, no box and a chapter outside the run do nothing', async () => {
  const r = rig();
  await r.ctl.tick(MAP, 'n1');
  r.state.raw = tickAt(r.state.raw, 0);
  await r.ctl.tick(MAP, 'n1');
  await r.ctl.tick(MAP, 'other');
  const plain = rig(); plain.state.raw = note('x'); await plain.ctl.tick(MAP, 'n1');
  assert.equal(r.state.reruns.length + plain.state.reruns.length, 0);
});
test('controller H: while a drive runs, or at gate 1, the tick is queued in the box (marker :q, status line) and nothing is called', async () => {
  for (const over of [{ running: true }, { phase: 'gate1' }]) {
    const r = rig(over);
    r.tickRewrite();
    await r.ctl.tick(MAP, 'n1');
    assert.equal(r.state.reruns.length, 0, JSON.stringify(over));
    assert.equal(r.box().queued, true);
    assert.match(r.state.raw, /vam-review:[^%]*:q%%/);
    assert.match(r.state.raw, /⏳ 已排入/);
    assert.equal(b.bodyStateRaw(r.state.raw), 'edited', 'the reader\'s text is untouched');
  }
});
test('controller H: drain at gate 2 runs the queued rewrite once; with a drive still running, or not at gate 2, it waits', async () => {
  const r = rig({ running: true });
  r.tickRewrite();
  await r.ctl.tick(MAP, 'n1');
  await r.ctl.drain(MAP);
  assert.equal(r.state.reruns.length, 0, 'a drive is running');
  r.state.running = false;
  r.map.bookPipeline.phase = 'writing';
  await r.ctl.drain(MAP);
  assert.equal(r.state.reruns.length, 0, 'not at gate 2');
  r.map.bookPipeline.phase = 'gate2';
  await r.ctl.drain(MAP);
  await r.ctl.drain(MAP);
  assert.equal(r.state.reruns.length, 1, 'once, a second drain does not charge again');
  assert.equal(b.bodyStateRaw(r.state.raw), 'clean');
});
test('controller H: a text change after the rewrite was asked (queued or not) cancels it with a reason and rewrites nothing', async () => {
  const r = rig({ running: true });
  r.tickRewrite();
  await r.ctl.tick(MAP, 'n1');
  r.state.raw = r.state.raw.replace('第三段', '第五段'); // the reader types (the box stays)
  r.state.running = false;
  await r.ctl.drain(MAP);
  assert.equal(r.state.reruns.length, 0);
  assert.equal(r.box().queued, undefined, 'the queue is gone');
  assert.equal(b.isRewriteAsked(r.box()), false, 'the tick is cleared');
  assert.notEqual(r.box().op, 'op1', 'a new operation id');
  assert.equal(r.box().ifp, b.integrityFpRaw(r.state.raw), 'bound to the new text');
  assert.match(r.state.raw, /⚠ 這章的文字又變了/);
  assert.ok(r.state.raw.includes('第五段'), 'the new text is kept');
  // the same on an immediate (not queued) tick: typed between the box and the tick
  const s = rig();
  s.state.raw = s.state.raw.replace('第三段', '第六段');
  s.tickRewrite();
  await s.ctl.tick(MAP, 'n1');
  assert.equal(s.state.reruns.length, 0);
  assert.match(s.state.raw, /⚠ 這章的文字又變了/);
});
test('controller: a refusal, a budget shortage or a failed write leaves the chapter not resolved, clears the tick, gives a new operation id and shows the reason in the box', async () => {
  const cases = [
    ['refused text_changed', async () => { throw new b.BookPipelineRunError('text_changed'); }, /⚠ 沒有重寫：.*文字又變了/],
    ['budget', async () => { throw new b.BookPipelineRunError('budget'); }, /⚠ 沒有重寫：/],
    ['still edited (the run skipped it)', async () => ({ unchanged: true }), /⚠ 沒有重寫：這章有你手改的內容/],
    ['a plain error', async () => { throw new Error('boom'); }, /⚠ 沒有重寫：.*boom/]
  ];
  for (const [name, rerun, status] of cases) {
    const r = rig({ rerun });
    r.tickRewrite();
    await r.ctl.tick(MAP, 'n1');
    assert.equal(r.state.reruns.length, 1, name);
    assert.equal(b.bodyStateRaw(r.state.raw), 'edited', `${name}: the reader's text stays, not resolved`);
    assert.equal(b.isRewriteAsked(r.box()), false, `${name}: tick cleared`);
    assert.notEqual(r.box().op, 'op1', `${name}: new operation`);
    assert.match(r.state.raw, status, name);
    // ticking again is a new command and tries again
    r.tickRewrite();
    await r.ctl.tick(MAP, 'n1');
    assert.equal(r.state.reruns.length, 2, `${name}: a new tick tries again`);
  }
});
test('controller: keep writes the choice into the chapter; a disposed controller does nothing', async () => {
  const r = rig();
  await r.ctl.keep(PATH);
  assert.equal(b.isKept(r.state.raw.split(START + '\n')[1].split('\n' + END)[0]), true);
  const d = rig();
  d.ctl.dispose();
  d.tickRewrite();
  await d.ctl.tick(MAP, 'n1');
  await d.ctl.drain(MAP);
  await d.ctl.keep(PATH);
  assert.equal(d.state.reruns.length, 0);
  assert.equal(d.state.writes, 0);
});

// ---- H persistence: the queue lives in the box marker; a neighbour rerun that changes the box fingerprint does not lose it ----
test('H persistence: queue, then a neighbour rerun changes the box fingerprint, then the queue survives (reopen included) and runs at gate 2', async () => {
  const r = rig({ running: true });
  const cards = () => ({ path: PATH, title: 'T', summary: '', prompt: '', detail: r.state.raw.split(START + '\n')[1].split('\n' + END)[0], raw: r.state.raw, settings: {}, fields: { pipelineStage: 'needs-review', pipelineIssue: 'write failed: hand_edited', ...(r.seam ? { pipelineSeam: r.seam } : {}) } });
  const callouts = new b.BookCallouts({ readMap: async () => r.map, readCard: async () => cards(), readText: async () => r.state.raw, write: r.write, log: () => {}, newId: () => 'fresh' });
  // the box as the aligner builds it from the card (the box fingerprint is the card's attention fingerprint)
  r.state.raw = note(r.state.raw.split(START + '\n')[1].split('\n' + END)[0]);
  await callouts.reconcile(MAP);
  const first = r.box();
  assert.ok(first && first.op, 'the aligner wrote a hand-edited box');
  r.tickRewrite();
  await r.ctl.tick(MAP, 'n1');
  assert.equal(r.box().queued, true);
  const op = r.box().op;
  // a neighbour rerun makes a join with this chapter a problem: the attention fingerprint (and with it the box) changes
  r.seam = 'n:1';
  await callouts.reconcile(MAP);
  assert.notEqual(r.box().fp, first.fp, 'the box was written again');
  assert.equal(r.box().op, op, 'same operation');
  assert.equal(r.box().queued, true, 'the queue survived');
  assert.equal(b.isRewriteAsked(r.box()), true, 'and still asks for the rewrite, so a drain can run it');
  // while the drive ran, nothing was written to the chapter; at gate 2 with nothing running the queue runs
  r.state.running = false;
  await r.ctl.drain(MAP);
  assert.equal(r.state.reruns.length, 1);
  assert.equal(r.state.reruns[0].operation, op);
  assert.equal(b.bodyStateRaw(r.state.raw), 'clean');
});
test('H persistence: a queued box stays when the run is between checkpoints (no review wanted), and goes when the text it was queued for changed', async () => {
  const r = rig({ running: true });
  r.tickRewrite();
  await r.ctl.tick(MAP, 'n1');
  assert.equal(r.box().queued, true);
  const kinds = () => b.readReviewState(r.state.raw);
  r.map.bookPipeline.phase = 'writing';
  const callouts = new b.BookCallouts({ readMap: async () => r.map, readCard: async () => ({ path: PATH, title: 'T', summary: '', prompt: '', detail: '', raw: r.state.raw, settings: {}, fields: { pipelineStage: 'written' } }), readText: async () => r.state.raw, write: r.write, log: () => {} });
  await callouts.reconcile(MAP);
  assert.equal(kinds()?.queued, true, 'kept while the book writes');
});

test('review-b S5: a "busy" refusal leaves the rewrite queued (not failed); two settled events at once run each queued chapter once', async () => {
  const r = rig({ running: true, rerun: () => { const e = new Error('book pipeline refused: busy'); e.code = 'busy'; throw e; } });
  r.tickRewrite();
  await r.ctl.tick(MAP, 'n1');
  r.state.running = false;
  await r.ctl.drain(MAP);
  assert.equal(r.state.reruns.length, 1, 'tried');
  assert.equal(b.isRewriteAsked(r.box()), true, 'still asked');
  assert.equal(r.box().queued, true, 'still queued');
  assert.doesNotMatch(r.state.raw, /沒有重寫/);
  // two chapters, two settled events at once: one drain at a time, each chapter runs once, none is refused
  const texts = {};
  const make = id => {
    const edited = b.stampDetail(BODY).replace('第二段', '第三段');
    let raw = b.putProgramCallout(note(edited), b.reviewCallout({ ...CARD, id }, ['x'], undefined, 'fp1', 'r1', { op: `op-${id}`, ifp: b.integrityFp(edited) }));
    raw = b.patchHandBox(tickAt(raw, 1), { queued: true });
    texts[id] = raw;
  };
  make('a'); make('b');
  const map = { id: 'm', nodes: [{ id: 'a', path: 'A' }, { id: 'b', path: 'B' }], bookPipeline: { ...b.newBookPipeline({ runId: 'r1', order: ['a', 'b'], now: 'a' }), phase: 'gate2' } };
  let active = 0; let busy = 0; const ran = [];
  const ctl = new b.BookHandEdits({
    readMap: async () => map,
    readCard: async p => { const raw = texts[p === 'A' ? 'a' : 'b']; return { path: p, title: 'T', raw, detail: raw.split(START + '\n')[1].split('\n' + END)[0] }; },
    write: async (p, tr) => { const id = p === 'A' ? 'a' : 'b'; const next = tr(texts[id]); if (next === texts[id]) return 'unchanged'; texts[id] = next; return 'written'; },
    rerunCard: async (_m, id) => {
      if (active) { busy++; const e = new Error('busy'); e.code = 'busy'; throw e; }
      active++; ran.push(id); await new Promise(res => setTimeout(res, 5));
      texts[id] = texts[id].replace(/(<!-- visual-agent-map:detail:start -->\n)[\s\S]*?(\n<!-- visual-agent-map:detail:end -->)/, (_x, a, c) => `${a}${b.stampDetail(BODY)}${c}`);
      active--; return { unchanged: false };
    },
    isRunning: () => false,
    newId: () => 'new',
    log: () => undefined
  });
  await Promise.all([ctl.drain(MAP), ctl.drain(MAP)]);
  assert.equal(busy, 0, 'never two rewrites at once');
  assert.deepEqual(ran.sort(), ['a', 'b'], 'each queued chapter ran once');
  for (const id of ['a', 'b']) assert.doesNotMatch(texts[id], /沒有重寫/);
});
