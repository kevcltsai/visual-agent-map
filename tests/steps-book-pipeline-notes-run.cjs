// Picture-book notes, apply controller (T6c): the running clock, cancel, timeout, messages, the undo (success, partial, refused) and the
// applied highlight lifecycle (10 s, switch, close, unload) with a hand-driven clock. Fake ports; no AI. How a real editor draws the mark
// and the Notice looks is UI evidence for the tester.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadSource } = require('./support-replay.cjs');
const S = require('./support.cjs');

const b = loadSource(`
export { BookNotesApply, NOTES_TIMEOUT_MS, UNDO_NOTICE_MS } from "./experiences/visual-map/book-pipeline-notes-apply";
export { stampRaw, bodyStateRaw, readBodyRecord, integrityFpRaw } from "./core/book-pipeline/body-integrity";
export { AppliedHighlights, HIGHLIGHT_MS, appliedField, setApplied } from "./experiences/visual-map/book-applied-highlight";
export { locateApplied, locateAppliedShown } from "./core/book-pipeline/notes-apply";
export { ReadingMarks, rerenderReadingViews, sectionSource } from "./experiences/visual-map/book-applied-highlight";
export { shownText } from "./experiences/visual-map/book-pipeline-callouts";
export { showAppliedNotice } from "./experiences/visual-map/book-applied-notice";
export { EditorState } from "@codemirror/state";
export { setUiLanguage } from "./i18n";
`, { obsidian: { ...S.obsidian } }, {});
b.setUiLanguage('zh-TW');

const W = (text, n, note) => `==${text}==%%備註#${n}：${note}%%`;
const detail = body => `<!-- visual-agent-map:detail:start -->\n${body}\n<!-- visual-agent-map:detail:end -->`;

function clock() {
  const c = { t: 0, timers: [], next: 1 };
  c.set = (run, ms) => { const h = c.next++; c.timers.push({ h, at: c.t + ms, run, every: 0 }); return h; };
  c.tick = (run, ms) => { const h = c.next++; c.timers.push({ h, at: c.t + ms, run, every: ms }); return h; };
  c.clear = h => { c.timers = c.timers.filter(x => x.h !== h); };
  c.advance = ms => {
    const end = c.t + ms;
    for (;;) {
      const due = c.timers.filter(x => x.at <= end).sort((x, y) => x.at - y.at)[0];
      if (!due) break;
      c.t = due.at;
      if (due.every) due.at += due.every; else c.timers = c.timers.filter(x => x !== due);
      due.run();
    }
    c.t = end;
  };
  return c;
}

function rig({ run, text = '', busy = null } = {}) {
  const c = clock();
  const r = { c, notices: [], actions: [], writes: [], highlights: [], undones: [], order: [], releases: 0, changed: 0, cancels: [], text, busy };
  r.deferred = null;
  r.ports = {
    run: (path, signal) => run ? run(path, signal, r) : new Promise((resolve, reject) => { r.deferred = { resolve, reject }; signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'cancelled' }))); }),
    cancel: path => { r.cancels.push(path); r.deferred?.reject(Object.assign(new Error('cancelled'), { code: 'cancelled' })); },
    mapBusy: () => r.busy,
    codeOf: e => e && e.code,
    refusalText: e => `refused:${e.code}`,
    reasonText: e => `reason:${e.name}`,
    write: async (path, transform) => { const next = transform(r.text); r.writes.push(path); if (r.refuse) return 'refused'; if (next === r.text) return 'unchanged'; r.text = next; return 'written'; },
    notice: m => r.notices.push(m),
    noticeAction: (message, label, onClick, ms) => { const a = { message, label, onClick, ms, hidden: false }; r.actions.push(a); return { hide: () => { a.hidden = true; } }; },
    highlight: (path, ranges) => r.highlights.push({ path, ranges }),
    releaseHighlight: () => { r.releases++; },
    flush: async path => { r.order.push('flush:' + path); },
    undone: path => { r.order.push('undone'); r.undones.push(path); },
    changed: () => { r.changed++; },
    now: () => c.t, setTimer: c.set, clearTimer: c.clear, setTick: c.tick, clearTick: c.clear
  };
  r.ctl = new b.BookNotesApply(r.ports);
  return r;
}
const flush = () => new Promise(resolve => setImmediate(resolve));
const result = (over = {}) => ({ applied: 1, skipped: 0, marked: 0, edits: [{ id: 'p1', before: 'B', after: 'A', from: 3, to: 4 }], ...over });

test('running: the clock reads m:ss from the start, the tick repaints, press while running cancels and nothing changes', async () => {
  const r = rig();
  r.ctl.press('N/c.md');
  await flush();
  assert.equal(r.ctl.isRunning('N/c.md'), true);
  assert.equal(r.ctl.elapsed('N/c.md'), '0:00');
  const before = r.changed;
  r.c.advance(65_000);
  assert.equal(r.ctl.elapsed('N/c.md'), '1:05');
  assert.ok(r.changed >= before + 65, 'one repaint per second');
  r.ctl.press('N/c.md');
  await flush();
  assert.deepEqual(r.cancels, ['N/c.md']);
  assert.equal(r.ctl.isRunning('N/c.md'), false);
  assert.deepEqual(r.notices, ['refused:cancelled']);
  assert.deepEqual(r.writes, []);
  assert.equal(r.highlights.length, 0);
  assert.equal(r.c.timers.length, 0, 'the timeout and the tick are released');
});
test('disabled: a running drive or another notes job gives the reason, a press shows it and starts nothing', async () => {
  const r = rig({ busy: 'drive' });
  assert.match(r.ctl.disabledReason('N/c.md'), /圖文書正在執行中/);
  r.ctl.press('N/c.md');
  assert.equal(r.notices.length, 1);
  assert.equal(r.ctl.isRunning('N/c.md'), false);
  r.busy = 'notes';
  assert.match(r.ctl.disabledReason('N/c.md'), /備註正在套用中/);
  r.busy = null;
  assert.equal(r.ctl.disabledReason('N/c.md'), null);
});
test('timeout: after 3 minutes the job is aborted and the notice says the notes are kept; nothing written', async () => {
  const r = rig();
  r.ctl.press('N/c.md');
  await flush();
  r.c.advance(b.NOTES_TIMEOUT_MS);
  await flush();
  assert.equal(r.notices.length, 1);
  assert.match(r.notices[0], /太久.*備註都還在/);
  assert.equal(r.ctl.isRunning('N/c.md'), false);
});
test('AI failure: the notice shows the plain reason from the port, never the raw message, and says the notes are kept', async () => {
  const r = rig({ run: async () => { throw new Error('provider down'); } });
  r.ctl.press('N/c.md');
  await flush();
  assert.match(r.notices[0], /失敗（reason:Error）.*備註都還在/);
  assert.doesNotMatch(r.notices[0], /provider down/);
});
test('messages: nothing sendable, and every note skipped, say why (different texts)', async () => {
  const r = rig({ run: async () => ({ applied: 0, skipped: 0, marked: 0, edits: [] }) });
  r.ctl.press('N/c.md'); await flush();
  assert.match(r.notices[0], /沒有改寫任何段落.*都沒有可送出/);
  const q = rig({ run: async () => ({ applied: 0, skipped: 2, marked: 2, edits: [] }) });
  q.ctl.press('N/c.md'); await flush();
  assert.match(q.notices[0], /2 段都被略過/);
  assert.equal(q.actions.length, 0, 'no undo for nothing');
});
test('applied: the notice shows the count and the skipped count with 還原, lasts 10 s, and the paragraphs are highlighted', async () => {
  const r = rig({ run: async () => result({ skipped: 2 }) });
  r.ctl.press('N/c.md'); await flush();
  assert.equal(r.actions.length, 1);
  assert.equal(r.actions[0].message, '已改 1 段（2 段略過） · ');
  assert.equal(r.actions[0].label, '還原');
  assert.equal(r.actions[0].ms, b.UNDO_NOTICE_MS);
  assert.deepEqual(JSON.parse(JSON.stringify(r.highlights)), [{ path: 'N/c.md', ranges: [{ from: 3, to: 4 }] }]);
  assert.equal(r.ctl.canUndo(), true);
  const plain = rig({ run: async () => result() });
  plain.ctl.press('N/c.md'); await flush();
  assert.equal(plain.actions[0].message, '已改 1 段 · ');
});

const P_OLD = `舊的一段 ${W('小熊', 1, '改成小兔')}。`;
const P_NEW = '新的一段，小兔。';
const applied = (text) => ({ applied: 1, skipped: 0, marked: 0, edits: [{ id: 'p1', before: P_OLD, after: P_NEW, from: 0, to: P_NEW.length }] });

test('undo success: the paragraph comes back with its note; the notice is released and the command is gone', async () => {
  const r = rig({ text: detail(`${P_NEW}\n\n別的段`), run: async () => applied() });
  r.ctl.press('N/c.md'); await flush();
  r.actions[0].onClick();
  await flush();
  assert.equal(r.text, detail(`${P_OLD}\n\n別的段`));
  assert.equal(r.actions[0].hidden, true);
  assert.equal(r.releases, 1);
  assert.match(r.notices.at(-1), /已還原 1 段，備註都放回去了/);
  assert.equal(r.ctl.canUndo(), false);
  await r.ctl.undo();
  assert.match(r.notices.at(-1), /沒有可還原/);
});
test('undo repaints the header action at once (live v4 P: reading mode has no editor event)', async () => {
  const r = rig({ text: detail(`${P_NEW}\n\n別的段`), run: async () => applied() });
  r.ctl.press('N/c.md'); await flush();
  const before = r.changed;
  await r.ctl.undo();
  assert.ok(r.changed > before);
});
test('undo (review-a M3): a successful undo asks for the map boxes to be aligned again; a refused or empty one does not', async () => {
  const r = rig({ text: detail(`${P_NEW}\n\n別的段`), run: async () => applied() });
  r.ctl.press('N/c.md'); await flush();
  assert.deepEqual(r.undones, []);
  await r.ctl.undo();
  assert.deepEqual(r.undones, ['N/c.md']);
  assert.equal(r.order.join(), 'flush:N/c.md,undone', 'the editor is saved to the file before the callouts are re-aligned');
  const q = rig({ text: detail(`${P_NEW}\n\n別的段`), run: async () => applied() });
  q.ctl.press('N/c.md'); await flush();
  q.refuse = true;
  await q.ctl.undo();
  assert.deepEqual(q.undones, [], 'refused: nothing changed');
  q.refuse = false; q.text = detail('something else entirely');
  await q.ctl.undo();
  assert.deepEqual(q.undones, [], 'restored 0: nothing changed');
});
test('cancel (review-a M2): pressing again aborts the job\'s own signal even when the map lookup finds nothing to cancel', async () => {
  let signal;
  const r = rig({ run: (path, s) => { signal = s; return new Promise((_, reject) => s.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'cancelled' })))); } });
  r.ports.cancel = () => {};
  r.ctl.press('N/c.md'); await flush();
  assert.equal(signal.aborted, false);
  r.ctl.press('N/c.md'); await flush();
  assert.equal(signal.aborted, true);
  assert.equal(r.ctl.isRunning('N/c.md'), false);
  assert.equal(r.notices.at(-1), 'refused:cancelled');
});
test('undo (T9, live acceptance 2026-11-20): putting the text back is a program write: an untouched chapter gets the fingerprint of the restored text; a hand-edited one stays hand-edited', async () => {
  const r = rig({ text: b.stampRaw(detail(`${P_NEW}\n\n別的段`)), run: async () => applied() });
  r.ctl.press('N/c.md'); await flush();
  await r.ctl.undo();
  assert.ok(r.text.includes(P_OLD));
  assert.equal(b.bodyStateRaw(r.text), 'clean', 'not a hand edit');
  assert.equal(b.readBodyRecord(r.text.split('detail:start -->')[1]).fp, b.integrityFpRaw(r.text), 'the fingerprint of the restored text');
  const q = rig({ text: b.stampRaw(detail(`${P_NEW}\n\n別的段`)).replace('別的段', '別的段 手改'), run: async () => applied() });
  q.ctl.press('N/c.md'); await flush();
  const fp = b.readBodyRecord(q.text.split('detail:start -->')[1]).fp;
  await q.ctl.undo();
  assert.ok(q.text.includes(P_OLD));
  assert.equal(b.bodyStateRaw(q.text), 'edited');
  assert.equal(b.readBodyRecord(q.text.split('detail:start -->')[1]).fp, fp, 'the record is left as it was');
});
test('undo partial and none: a paragraph edited since is left alone and reported', async () => {
  const two = { applied: 2, skipped: 0, marked: 0, edits: [
    { id: 'p1', before: P_OLD, after: P_NEW, from: 0, to: 1 },
    { id: 'p2', before: '舊二', after: '新二', from: 2, to: 3 }] };
  const r = rig({ text: detail(`${P_NEW}\n\n新二 又被改`), run: async () => two });
  r.ctl.press('N/c.md'); await flush();
  await r.ctl.undo();
  assert.equal(r.text, detail(`${P_OLD}\n\n新二 又被改`));
  assert.match(r.notices.at(-1), /已還原 1 段.*另有 1 段/);
  const q = rig({ text: detail('全都改過了'), run: async () => applied() });
  q.ctl.press('N/c.md'); await flush();
  await q.ctl.undo();
  assert.equal(q.text, detail('全都改過了'));
  assert.match(q.notices.at(-1), /沒有還原任何段落/);
  assert.equal(q.ctl.canUndo(), false);
});
test('undo refused: the writer refuses, the chapter is untouched and the undo stays available', async () => {
  const r = rig({ text: detail(P_NEW), run: async () => applied() });
  r.ctl.press('N/c.md'); await flush();
  r.refuse = true;
  await r.ctl.undo();
  assert.equal(r.text, detail(P_NEW));
  assert.match(r.notices.at(-1), /還原沒有成功/);
  assert.equal(r.ctl.canUndo(), true);
  r.refuse = false;
  await r.ctl.undo();
  assert.equal(r.text, detail(P_OLD));
});
test('dispose: a running job is aborted, a late result shows nothing, and the undo is gone', async () => {
  const r = rig();
  r.ctl.press('N/c.md'); await flush();
  r.ctl.dispose();
  r.deferred.resolve(result());
  await flush();
  assert.deepEqual(r.notices, []);
  assert.equal(r.actions.length, 0);
  assert.equal(r.highlights.length, 0);
  assert.equal(r.ctl.canUndo(), false);
});

// ---- the highlight lifecycle ----
function targets(...paths) {
  const list = paths.map(path => ({ key: {}, shown: path, calls: [], path() { return this.shown; }, set(ranges) { this.calls.push(ranges); } }));
  return list;
}
function lights(list) {
  const c = clock();
  const h = new b.AppliedHighlights({ targets: () => list.filter(t => !t.closed), setTimer: c.set, clearTimer: c.clear });
  return { c, h };
}
const R = [{ from: 1, to: 5 }];
test('highlight: shown in every open editor of the note, released after 10 s', () => {
  const [a, other, a2] = targets('N/c.md', 'N/o.md', 'N/c.md');
  const { c, h } = lights([a, other, a2]);
  h.show('N/c.md', R);
  assert.deepEqual(a.calls, [R]); assert.deepEqual(a2.calls, [R]); assert.deepEqual(other.calls, []);
  c.advance(b.HIGHLIGHT_MS - 1);
  assert.equal(a.calls.length, 1);
  c.advance(1);
  assert.deepEqual(a.calls, [R, null]); assert.deepEqual(a2.calls, [R, null]);
  assert.equal(c.timers.length, 0);
});
test('highlight: a file switch releases that editor only; a closed view is forgotten; the last one going releases the timer', () => {
  const [a, a2] = targets('N/c.md', 'N/c.md');
  const { c, h } = lights([a, a2]);
  h.show('N/c.md', R);
  a.shown = 'N/o.md'; h.sync();
  assert.deepEqual(a.calls, [R, null]); assert.deepEqual(a2.calls, [R]);
  a2.closed = true; h.sync();
  assert.equal(c.timers.length, 0, 'no editor left: the timer is released');
  c.advance(20_000);
  assert.deepEqual(a2.calls, [R], 'a closed editor is never touched again');
});
test('highlight: a newer apply replaces the older one; unload releases; nothing is drawn for an empty list or a note that is not open', () => {
  const [a] = targets('N/c.md');
  const { c, h } = lights([a]);
  h.show('N/c.md', R);
  h.show('N/c.md', [{ from: 7, to: 9 }]);
  assert.deepEqual(a.calls, [R, null, [{ from: 7, to: 9 }]]);
  h.dispose();
  assert.deepEqual(a.calls.at(-1), null);
  assert.equal(c.timers.length, 0);
  h.show('N/c.md', []); h.show('N/x.md', R);
  assert.equal(a.calls.length, 4);
});
test('highlight field: the marks map through edits, out-of-range ranges are dropped, null clears', () => {
  const { EditorState } = b;
  const count = state => { let n = 0; state.field(b.appliedField).between(0, state.doc.length, () => { n++; }); return n; };
  let state = EditorState.create({ doc: 'abcdefghij', extensions: [b.appliedField] });
  state = state.update({ effects: b.setApplied.of([{ from: 2, to: 5 }, { from: 8, to: 99 }, { from: 4, to: 4 }]) }).state;
  assert.equal(count(state), 1);
  state = state.update({ changes: { from: 0, insert: 'XX' } }).state;
  let at = -1; state.field(b.appliedField).between(0, 20, from => { at = from; });
  assert.equal(at, 4, 'mapped through the insert');
  state = state.update({ effects: b.setApplied.of(null) }).state;
  assert.equal(count(state), 0);
});

test('applied notice: bottom-right box removed by its own 10 s timer; undo click works; hide clears the timer', () => {
  const c = clock();
  const made = [];
  const host = { createDiv: o => { const box = { o, removed: false, clicks: [], createSpan() {}, createEl: () => ({ addEventListener: (_t, fn) => box.clicks.push(fn) }), remove() { box.removed = true; } }; made.push(box); return box; } };
  const timers = { set: c.set, clear: c.clear };
  let undone = 0;
  const n = b.showAppliedNotice(host, timers, 'm', 'u', () => undone++, 10000);
  assert.equal(made[0].o.cls, 'vam-book-applied-notice');
  made[0].clicks[0]({ preventDefault() {} });
  assert.equal(undone, 1);
  c.advance(9999);
  assert.equal(made[0].removed, false);
  c.advance(1);
  assert.equal(made[0].removed, true);
  const n2 = b.showAppliedNotice(host, timers, 'm', 'u', () => {}, 10000);
  n2.hide();
  assert.equal(made[1].removed, true);
  assert.equal(c.timers.length, 0);
});

test('reading marks: a section is matched by its source text (CRLF-safe), on its own note only; clear removes', () => {
  const text = 'a\r\nb\r\n\r\nc\r\nd';
  assert.equal(b.sectionSource(text, 3, 4), 'c\r\nd');
  const m = new b.ReadingMarks();
  m.set('n.md', ['c\nd']);
  assert.equal(m.wears('n.md', b.sectionSource(text, 3, 4)), true);
  assert.equal(m.wears('n.md', b.sectionSource(text, 0, 1)), false);
  assert.equal(m.wears('o.md', b.sectionSource(text, 3, 4)), false);
  m.clear();
  assert.equal(m.wears('n.md', b.sectionSource(text, 3, 4)), false);
  m.set('n.md', ['', '  ']);
  assert.equal(m.wears('n.md', ''), false, 'an empty text marks nothing');
});

test('reading mode apply (live v4 P): the mark is set while the view still shows the old text and lands on the new paragraph when it renders, also after a callout moved the lines', () => {
  const callout = '> [!vam-review] 待審\n> 已修改，未重新校對';
  const before = detail('Para A\n\n==Para B==%%備註#1：改%%');
  const after = detail(callout + '\n\nPara A\n\nPara B new');
  const m = new b.ReadingMarks();
  m.set('n.md', ['Para B new']);
  const lines = t => t.split('\n');
  const sectionAt = (t, needle) => { const i = lines(t).findIndex(l => l.includes(needle)); return b.sectionSource(t, i, i); };
  // the old render (before the view reloaded the file): nothing is marked
  assert.equal(m.wears('n.md', sectionAt(before, 'Para B')), false);
  assert.equal(m.wears('n.md', sectionAt(before, 'Para A')), false);
  // the new render: only the applied paragraph, never the callout or another paragraph
  assert.equal(m.wears('n.md', sectionAt(after, 'Para B new')), true);
  assert.equal(m.wears('n.md', sectionAt(after, 'Para A')), false);
  const ci = lines(after).findIndex(l => l.includes('[!vam-review]'));
  assert.equal(m.wears('n.md', b.sectionSource(after, ci, ci + 1)), false);
});

test('reading mode (live v4 P): the header counts the notes in the text the view shows, not its editor that reading mode leaves behind', () => {
  const view = mode => ({ getMode: () => mode, getViewData: () => 'shown', editor: { getValue: () => 'editor' } });
  assert.equal(b.shownText(view('preview')), 'shown');
  assert.equal(b.shownText(view('source')), 'editor');
});

test('applied marks follow the paragraph text, never the review callout, in reading and edit mode', () => {
  const callout = '> [!vam-review] 這章要你看\n> 已修改，未重新校對';
  const old = detail('> [!vam-review] 這章要你看\n\nPara A\n\nPara B new');
  const stale = { from: old.indexOf('Para B new'), to: old.indexOf('Para B new') + 10 };
  // the program added the 「已修改」 line after the offsets were taken: the stale range now hits the callout
  const now = detail(callout + '\n\nPara A\n\nPara B new');
  const found = b.locateApplied(now, ['Para B new']);
  assert.equal(JSON.stringify(found), JSON.stringify([{ from: now.indexOf('Para B new'), to: now.indexOf('Para B new') + 10 }]));
  assert.notEqual(found[0].from, stale.from);
  // reading mode: only the paragraph's line wears the mark, the callout lines do not
  const m = new b.ReadingMarks();
  m.set('n.md', ['Para B new']);
  assert.equal(m.wears('n.md', b.sectionSource(now, 1, 2)), false);
  assert.equal(m.wears('n.md', b.sectionSource(now, 6, 6)), true);
  // edit mode: the CM6 mark covers exactly the paragraph
  const state = b.EditorState.create({ doc: now, extensions: [b.appliedField] }).update({ effects: b.setApplied.of(found) }).state;
  const marked = [];
  state.field(b.appliedField).between(0, now.length, (f, t) => { marked.push([f, t]); });
  assert.equal(JSON.stringify(marked), JSON.stringify([[found[0].from, found[0].to]]));
  // a callout-only text, a missing or duplicated paragraph: no mark
  assert.equal(b.locateApplied(detail(callout), ['已修改，未重新校對']).length, 0);
  assert.equal(b.locateApplied(now.replace('Para B new', 'Para A'), ['Para A']).length, 0);
});

test('edit mode: the mark is found in the editor buffer, not the file on disk the editor has not saved yet', async () => {
  const callout = '> [!vam-review] 待審\n> 已修改，未重新校對';
  const disk = detail(callout + '\n\nPara A\n\nPara B old');
  const buffer = '---\ntags: [x]\n---\r\n' + detail(callout + '\n\nPara A\n\nPara B new');
  // reading the stale file (what the highlight did before) finds nothing
  assert.equal(b.locateApplied(disk, ['Para B new']).length, 0);
  const found = await b.locateAppliedShown({ editor: () => buffer, file: async () => disk }, ['Para B new']);
  assert.equal(JSON.stringify(found), JSON.stringify([{ from: buffer.indexOf('Para B new'), to: buffer.indexOf('Para B new') + 10 }]));
  // the callout is still never marked from the buffer
  assert.equal((await b.locateAppliedShown({ editor: () => buffer, file: async () => disk }, ['已修改，未重新校對'])).length, 0);
  // no open view (reading the file is unchanged)
  const now = detail(callout + '\n\nPara B new');
  const fromFile = await b.locateAppliedShown({ editor: () => undefined, file: async () => now }, ['Para B new']);
  assert.equal(fromFile[0].from, now.indexOf('Para B new'));
});

test('undo: open reading views of that note render again at once; editing views and other notes are left alone', () => {
  const hits = [];
  const view = (path, reading, name) => ({ path, reading, rerender: () => hits.push(name) });
  const n = b.rerenderReadingViews([view('n.md', true, 'a'), view('n.md', false, 'edit'), view('o.md', true, 'other'), view('n.md', true, 'b'), view(undefined, true, 'none')], 'n.md');
  assert.equal(n, 2);
  assert.deepEqual(hits, ['a', 'b']);
  assert.equal(b.rerenderReadingViews([], 'n.md'), 0);
});
