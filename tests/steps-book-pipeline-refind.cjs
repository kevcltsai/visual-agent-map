// "Find another picture" for one picture slot (V3.3 G03 / P5.1b): the pure swap (core/book-pipeline/refind-slot.ts), the runner's
// `refindSlot` (guards, budget, cancel, re-check, one guarded write) over the real repository fixture with fake model ports, and the
// BookRefindSlot controller (cancel, timeout, messages, undo) on fake ports. How the editor menu looks and a real search are UI/live
// evidence for the tester.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('./support.cjs');
const dom = require('./support-dom.cjs');
const { loadSource } = require('./support-replay.cjs');
const b = loadSource(`
export { BookPipelineRuns, BookPipelineRunError } from "./experiences/visual-map/book-pipeline-run";
export { readBookPipeline } from "./core/book-pipeline/model";
export { BudgetExhaustedError } from "./core/admission";
export { CommonsQueue } from "./core/book-pipeline/commons-search";
export * as R from "./core/book-pipeline/refind-slot";
export * as BI from "./core/book-pipeline/body-integrity";
export { detailBlockOf } from "./core/book-pipeline/note-sections";
export { shortHash } from "./core/book-pipeline/image-slots";
export { createNoteWriter, BookCallouts } from "./experiences/visual-map/book-pipeline-callouts";
export { BookRefindSlot, REFIND_TIMEOUT_MS, REFIND_UNDO_MS } from "./experiences/visual-map/book-pipeline-refind-slot";
export { BookHandEdits } from "./experiences/visual-map/book-pipeline-handedit";
export { readReviewState, putProgramCallout } from "./experiences/visual-map/book-pipeline-review";
export { setUiLanguage, t } from "./i18n";
`, { obsidian: { ...S.obsidian, Modal: dom.makeModal(), Notice: dom.makeNotice([]), Component: class {}, MarkdownRenderChild: class {} } }, { createFragment: dom.createFragment, requestAnimationFrame: () => 1, cancelAnimationFrame() {}, window: { setTimeout, clearTimeout, setInterval, clearInterval } });
const { BookPipelineRuns, BookPipelineRunError, readBookPipeline, BudgetExhaustedError, R, BI, detailBlockOf, shortHash, createNoteWriter, BookCallouts, BookRefindSlot, REFIND_TIMEOUT_MS, REFIND_UNDO_MS, BookHandEdits, readReviewState, putProgramCallout, setUiLanguage, t } = b;
const C = { CommonsQueue: b.CommonsQueue };
setUiLanguage('zh-TW');

const tick = () => new Promise(resolve => setImmediate(resolve));
const settle = async () => { for (let i = 0; i < 30; i++) await tick(); };
const stageOf = raw => /^pipeline-stage: "?([a-z-]+)"?$/m.exec(raw)?.[1];
const cand = n => ({ title: `Work ${n}`, caption: `Caption ${n}`, url: `https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/W${n}.jpg/1280px-W${n}.jpg`, source: `https://commons.wikimedia.org/wiki/File:W${n}.jpg` });
const found = bySlotObj => { const bySlot = new Map(Object.entries(bySlotObj).map(([k, v]) => [Number(k), v])); return { bySlot, found: [...bySlot.values()].reduce((n, v) => n + v.length, 0), offTopic: 0 }; };
const mk = n => `〔圖位 ${n}：explains ${n} perspective〕`;
const TEXT = title => `正文一。${title}\n\n${mk(1)}\n\n正文二。\n\n${mk(2)}\n\n正文三。\n\n### 來源\n- https://example.com/a\n`;
const slotsOf = n => Array.from({ length: n }, (_, i) => ({ index: i + 1, kind: 'diagram', explains: `explains ${i + 1} perspective`, anchor: `after paragraph ${i + 1}` }));
const URL1 = cand(1).url;
const URL3 = cand(3).url;
const refusal = code => error => error instanceof BookPipelineRunError && error.code === code;

/**
 * A book whose first chapter (nodes[0]) got pictures W1 and W2 from the run; the refind search answers `again` (default: W3 for slot 1).
 * The notes port writes through the real writer; `views` (when set) are the open editors.
 */
async function rig(over = {}) {
  const data = S.fixture('zh-TW');
  const { repo, contents } = data;
  const mapPath = await repo.createMap('Book');
  const doc = await repo.readMap(mapPath);
  const nodes = [];
  for (const title of ['SecretRootTitle', 'FillerChapter']) nodes.push(await repo.createNote(title, 'model-a', doc, mapPath, 'workspace', { summary: `summary of ${title}` }));
  nodes.forEach((node, i) => { node.x = i * 300; node.y = 0; if (i) node.parentId = nodes[0].id; });
  await repo.updateMap(mapPath, d => { d.nodes.push(...nodes); });
  const stat = { logs: [], backups: [], searches: [], probes: [] };
  let queue = Promise.resolve();
  let ids = 0;
  const r = { ...data, mapPath, nodes, stat, views: null };
  const ports = {
    mutate: work => { const next = queue.then(work); queue = next.catch(() => undefined); return next; },
    readMap: path => repo.readMap(path),
    updateMap: (path, change) => repo.updateMap(path, d => { change(d); if (d.bookPipeline) delete d.bookPipeline.trial; }),
    readCard: async path => {
      const note = await repo.readNote(path);
      return { path, title: note.title, summary: note.summary, prompt: note.prompt, detail: note.detail, raw: contents.get(path), settings: note.bookSettings ?? {}, aiLocked: r.locked?.(path) ?? false, fields: { ...(note.pipelineStage ? { pipelineStage: note.pipelineStage } : {}), ...(note.pipelineIssue ? { pipelineIssue: note.pipelineIssue } : {}), ...(note.bookRole ? { bookRole: note.bookRole } : {}) } };
    },
    writePipelineFields: (path, patch) => repo.writePipelineFields(path, patch),
    updateNoteGuarded: (path, patch, options) => repo.updateNoteGuarded(path, patch, options),
    updateNoteRawGuarded: (path, transform, options) => repo.updateNoteRawGuarded(path, transform, options),
    runPlan: async (step, request, run) => {
      await run.admission.reserve();
      if (step.id === 'book-pipeline.global-plan') return { thread: 'one thread', cards: nodes.map((n, i) => ({ id: n.id, role: i ? 'body' : 'intro' })), materials: [{ name: 'm', use: 'u' }], decisions: { reader: 'kids' } };
      return { covers: 'covers', entry: 'entry', handoff: 'handoff', previous: 'p', next: 'n', checklist: [{ id: 'C1', type: 'structure', text: 'has a beginning' }], images: slotsOf(2) };
    },
    runProofread: async (request, run) => { await run.admission.reserve(); return { items: request.checklist.map(c => ({ id: c.id, type: c.type, status: 'met', note: 'fine', sources: [] })), aggregate: 'checked' }; },
    author: async input => { await input.admission.reserve(); const n = await repo.readNote(input.path); const out = await repo.updateNoteGuarded(input.path, { detail: TEXT(n.title) }, { authorize: input.authorize, finalize: input.finalize }); return out === 'written' ? { outcome: 'written' } : { outcome: 'discarded' }; },
    probeImage: async url => { stat.probes.push(url); return { ok: true }; },
    commonsQueue: new C.CommonsQueue(0, async () => {}),
    findImages: async (request, run) => {
      await run.admission.reserve();
      if (/FillerChapter/.test(request.chapter)) return found({});
      if (!request.again) return found({ 1: [cand(1)], 2: [cand(2)] });
      stat.searches.push(request);
      return (over.again ?? (() => found({ 1: [cand(3)] })))(request, run, stat.searches.length);
    },
    backupNote: async path => { stat.backups.push(path); return over.backup && r.armed ? over.backup() : { ok: true, path: `${path}.bak` }; },
    blocked: () => false,
    config: () => ({ planModel: 'm1', authorModel: 'm2', imageModel: 'm4', proofModel: 'm3', reasoning: 'low', language: 'zh-TW' }),
    now: () => '2026-11-17T00:00:00.000Z',
    newId: () => `run-${++ids}`,
    log: line => stat.logs.push(line)
  };
  const runs = new BookPipelineRuns(ports);
  await runs.start(mapPath);
  await runs.confirmGate1(mapPath);
  while (runs.isRunning(mapPath)) await tick();
  const rawWriter = createNoteWriter({ openViews: () => (r.views ? r.views : []), rawGuarded: (p, tr, o) => repo.updateNoteRawGuarded(p, tr, o) });
  r.armed = true;
  r.writes = 0;
  ports.notes = { readText: async path => contents.get(path), write: (p, tr) => { r.writes++; return rawWriter(p, tr); } };
  Object.assign(r, { runs, ports, path: nodes[0].path, raw: () => contents.get(nodes[0].path), state: async () => readBookPipeline(await repo.readMap(mapPath)).data });
  r.refind = (url = URL1, options) => runs.refindSlot(mapPath, nodes[0].id, url, options);
  return r;
}

/** The lines of `a` and `b` that differ, as [index, a-line, b-line] (same line count required). */
// The body fingerprint line moves (with the blank quote line before it) to the end of the research note when it is re-stamped: leave it out.
const noBody = text => text.replace(/\r?\n>\r?\n> <!-- book-body:v1 .* -->/, '');
const bodyLines = text => text.split('\n').filter(l => l.includes('book-body:v1')).length;
const lineDiff = (a, b) => { const x = noBody(a).split('\n'), y = noBody(b).split('\n'); return x.length === y.length ? x.flatMap((l, i) => (l === y[i] ? [] : [[i, l, y[i]]])) : null; };

// ---- the runner ----

test('refind: swaps only the picture block, its Sources entry, its slot record item and the body fingerprint; spends budget; backs up first', async () => {
  const r = await rig();
  const before = r.raw();
  assert.ok(before.includes(`![Work 1](${URL1})`) && before.includes('Caption 1'));
  assert.equal(BI.bodyStateRaw(before), 'clean');
  const used = (await r.state()).budget.used;
  const result = await r.refind();
  const after = r.raw();
  assert.equal(result.kind, 'replaced');
  assert.equal(result.before, before); assert.equal(result.after, after);
  const diff = lineDiff(before, after);
  assert.ok(diff, 'same number of lines (the block keeps its shape)');
  const kinds = diff.map(([, a]) => (a.startsWith('![Work 1]') ? 'image' : a === 'Caption 1' ? 'caption' : a.startsWith('來源：') ? 'source' : a.startsWith('- 圖「Work 1」') ? 'entry' : a.includes('book-slots:v1') ? 'record' : `other:${a}`));
  assert.deepEqual(kinds.sort(), ['caption', 'entry', 'image', 'record', 'source']);
  // The fingerprint line moves to the end of the research note when it is re-stamped (existing behaviour): still exactly one, and changed.
  assert.equal(bodyLines(before), 1); assert.equal(bodyLines(after), 1);
  assert.notEqual(/<!-- book-body:v1 .* -->/.exec(before)[0], /<!-- book-body:v1 .* -->/.exec(after)[0]);
  assert.ok(after.includes(`![Work 3](${URL3})\nCaption 3\n來源：`));
  assert.ok(after.includes('- 圖「Work 3」') && !after.includes('- 圖「Work 1」') && after.includes('- 圖「Work 2」'));
  assert.ok(after.includes(cand(2).url), 'the other picture stays');
  assert.equal(BI.bodyStateRaw(after), 'clean', 'a clean chapter stays clean (program write)');
  const record = JSON.parse(/<!-- book-slots:v1 (\{.*\}) -->/.exec(after)[1]);
  const old = JSON.parse(/<!-- book-slots:v1 (\{.*\}) -->/.exec(before)[1]);
  assert.equal(record.slots[0].hash, shortHash(URL3));
  assert.deepEqual(record.slots[1], old.slots[1], 'the other slot item is as it was');
  assert.ok((await r.state()).budget.used > used, 'the search calls count against the book budget');
  assert.deepEqual(r.stat.backups.slice(-1), [r.path]);
  assert.equal(r.stat.searches.length, 1);
  assert.equal(r.stat.searches[0].again, true);
  assert.deepEqual(JSON.parse(JSON.stringify(r.stat.searches[0].slots.map(s => s.index))), [1]);
  assert.match(r.stat.logs.join('\n'), /refind_slot .*result=ok/);
  assert.ok(!/wikimedia|SecretRootTitle/.test(r.stat.logs.filter(l => l.includes('refind_slot')).join('\n')));
});

test('refind: nothing found, a failed search (failed, not none: behaviour fix of the G03 review), a failed backup or a cancel write nothing', async () => {
  const plain = async p => JSON.parse(JSON.stringify(await p));
  const cases = [
    ['none', { again: () => found({}) }, async r => assert.deepEqual(await plain(r.refind()), { kind: 'none' })],
    // Every search call failed (sign-in, connection): the picture service did not answer, which is not "no other picture" (G03 review M1).
    ['fail', { again: () => { throw new Error('provider down'); } }, async r => {
      assert.deepEqual(await plain(r.refind()), { kind: 'failed', reason: 'search_failed' });
      assert.match(r.stat.logs.join('\n'), /refind_slot .*result=search_failed/);
    }],
    ['fail, Commons fails too', { again: () => { throw new Error('provider down'); } }, async r => {
      let asked = 0;
      r.ports.fetchCommons = async () => { asked++; throw new Error('offline'); };
      assert.deepEqual(await plain(r.refind()), { kind: 'failed', reason: 'search_failed' });
      assert.ok(asked > 0, 'Commons was asked');
    }],
    ['fail, Commons answers with nothing', { again: () => { throw new Error('provider down'); } }, async r => {
      r.ports.fetchCommons = async () => ({ status: 200, text: '{}' });
      assert.deepEqual(await plain(r.refind()), { kind: 'none' }, 'one search answered: nothing found, not a failure');
    }],
    ['backup', { backup: () => ({ ok: false }) }, async r => assert.rejects(r.refind(), refusal('backup_failed'))],
    ['cancel during the search', { again: (req, run) => new Promise((_, reject) => run.signal.addEventListener('abort', () => reject(new Error('aborted')))) }, async r => {
      const ac = new AbortController();
      const p = r.refind(URL1, { signal: ac.signal });
      await settle(); ac.abort();
      await assert.rejects(p, refusal('cancelled'));
    }],
    ['cancel before the write', { again: () => { r0.cancel(); return found({ 1: [cand(3)] }); } }, async r => assert.rejects(r.refind(URL1, { signal: r0.signal }), refusal('cancelled'))]
  ];
  let r0;
  for (const [name, over, act] of cases) {
    const ac = new AbortController();
    r0 = { cancel: () => ac.abort(), signal: ac.signal };
    const r = await rig(over);
    const before = r.raw();
    r.writes = 0;
    await act(r);
    assert.equal(r.raw(), before, `${name}: the chapter is byte for byte as it was`);
    assert.equal(r.writes, 0, `${name}: no write`);
    assert.equal(r.runs.isApplyingNotes(r.mapPath), false, `${name}: the slot is free again`);
  }
});

test('refind: the call cap stops it before the search and nothing is written', async () => {
  const r = await rig({ again: () => { throw new BudgetExhaustedError(); } });
  const before = r.raw();
  r.writes = 0;
  await assert.rejects(r.refind(), refusal('budget'));
  assert.equal(r.raw(), before); assert.equal(r.writes, 0);
  const full = await rig();
  await full.repo.updateMap(full.mapPath, d => { d.bookPipeline.budget.limit = d.bookPipeline.budget.used; });
  const kept = full.raw();
  full.writes = 0;
  await assert.rejects(full.refind(), refusal('budget'));
  assert.equal(full.raw(), kept); assert.equal(full.writes, 0);
  assert.equal(full.stat.searches.length, 0, 'no model call past the cap');
});

test('refind: a chapter changed during the search (the picture lines edited) is not written: stale', async () => {
  const r = await rig({ again: async () => { await r.repo.updateNoteRawGuarded(r.path, text => text.replace('Caption 1', 'My own caption'), { authorize: () => true }); return found({ 1: [cand(3)] }); } });
  await assert.rejects(r.refind(), refusal('stale'));
  assert.ok(r.raw().includes('My own caption') && r.raw().includes(`![Work 1](${URL1})`) && !r.raw().includes(URL3));
});

test('refind: what changed while the search ran is re-checked after it, and each refusal writes nothing (G03 review M2)', async () => {
  const swapAt = async (r, change) => { await change(r); return found({ 1: [cand(3)] }); };
  const cases = [
    ['the run was replaced (other runId)', 'stale', r => r.repo.updateMap(r.mapPath, d => { d.bookPipeline.runId = 'run-other'; })],
    ['the card left the order', 'stale', r => r.repo.updateMap(r.mapPath, d => { d.bookPipeline.removed = [...(d.bookPipeline.removed ?? []), r.nodes[0].id]; })],
    ['the card points at another path', 'stale', r => r.repo.updateMap(r.mapPath, d => { d.nodes.find(n => n.id === r.nodes[0].id).path = 'Elsewhere/moved.md'; })],
    ['the chapter got ai-locked during the search', 'ai_locked', r => { r.locked = () => true; }]
  ];
  for (const [name, code, change] of cases) {
    let r;
    r = await rig({ again: () => swapAt(r, change) });
    const before = r.raw();
    r.writes = 0;
    await assert.rejects(r.refind(), refusal(code), name);
    assert.equal(r.stat.searches.length, 1, `${name}: the search did run`);
    assert.equal(r.raw(), before, `${name}: the chapter is byte for byte as it was`);
    assert.equal(r.writes, 0, `${name}: no write`);
    assert.equal(r.runs.isApplyingNotes(r.mapPath), false, `${name}: the slot is free again`);
  }
  // A cancel that comes while the writer waits: the transform's own gate leaves the text as it is (the writer writes nothing).
  const w = await rig();
  const before = w.raw();
  const ac = new AbortController();
  const write = w.ports.notes.write;
  const answers = [];
  w.ports.notes.write = async (p, tr) => { ac.abort(); const out = await write(p, tr); answers.push(out); return out; };
  await assert.rejects(w.refind(URL1, { signal: ac.signal }), refusal('cancelled'));
  assert.deepEqual(answers, ['unchanged'], 'the writer was reached and changed nothing');
  assert.equal(w.raw(), before);
});

test('refind: refused at once while a drive runs on the map (drive_running): no backup, no search, no write', async () => {
  const r = await rig();
  const before = r.raw();
  const backups = r.stat.backups.length;
  r.writes = 0;
  // A drive of the map holds it (registered at once by start; held at its first map read, so it writes nothing itself): refused first.
  r.ports.readMap = () => new Promise(() => {});
  void r.runs.start(r.mapPath).catch(() => undefined);
  assert.equal(r.runs.isRunning(r.mapPath), true, 'a drive is running');
  await assert.rejects(r.refind(), refusal('drive_running'));
  assert.ok(!r.stat.logs.some(l => l.includes('refind_slot')), 'refused before the job starts');
  assert.equal(r.stat.searches.length, 0); assert.equal(r.stat.backups.length, backups); assert.equal(r.writes, 0);
  assert.equal(r.raw(), before);
});

test('refind: a picture the reader put in (or one not in the record) is refused as not_slot, before any call or backup', async () => {
  const r = await rig();
  const mine = 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Mine.jpg';
  await r.repo.updateNoteRawGuarded(r.path, text => text.replace('正文二。', `正文二。\n\n![mine](${mine})\nmy caption`), { authorize: () => true });
  const before = r.raw();
  const backups = r.stat.backups.length;
  await assert.rejects(r.refind(mine), refusal('not_slot'));
  assert.equal(r.raw(), before); assert.equal(r.stat.searches.length, 0); assert.equal(r.stat.backups.length, backups);
});

test('refind: refused while a drive or a notes job holds the map, or the chapter is ai-locked; the slot is shared with the notes job', async () => {
  const r = await rig({ again: () => new Promise(() => {}) });
  void r.refind();
  await settle();
  assert.equal(r.runs.isApplyingNotes(r.mapPath), true);
  await assert.rejects(r.runs.refindSlot(r.mapPath, r.nodes[0].id, URL1), refusal('notes_busy'));
  await assert.rejects(r.runs.applyNotes(r.mapPath, r.nodes[0].id), refusal('notes_busy'));
  const l = await rig();
  l.locked = () => true;
  await assert.rejects(l.refind(), refusal('ai_locked'));
});

test('refind: a kept answer ("keep my version") survives the swap, so the box is not asked again and the next reconcile leaves the chapter as the same reconcile without the swap would', async () => {
  // Hand-edited chapter, the reader ticked "keep my version": kept record, stage checked. The control rig gets no refind.
  const prep = async () => {
    const r = await rig();
    await r.repo.updateNoteRawGuarded(r.path, text => text.replace('正文三。', '正文三，我改過。'), { authorize: () => true });
    assert.equal(BI.bodyStateRaw(r.raw()), 'edited');
    await r.repo.updateNoteRawGuarded(r.path, BI.keepRaw, { authorize: () => true });
    await r.repo.writePipelineFields(r.path, { pipelineStage: 'checked', pipelineIssue: null });
    assert.equal(BI.isKeptRaw(r.raw()), true);
    r.callouts = new BookCallouts({ readMap: p => r.repo.readMap(p), readCard: p => r.ports.readCard(p), readText: async p => r.contents.get(p), write: r.ports.notes.write, log: () => {} });
    r.hands = new BookHandEdits({ readMap: p => r.repo.readMap(p), readCard: p => r.ports.readCard(p), write: r.ports.notes.write, writeFields: (p, patch) => r.repo.writePipelineFields(p, patch), rerunCard: async () => { throw new Error('no rerun'); }, isRunning: () => false, newId: () => 'op', log: () => {} });
    return r;
  };
  const r = await prep();
  const control = await prep();
  await r.refind();
  assert.equal(BI.isKeptRaw(r.raw()), true, 'the keep follows the swapped text');
  assert.equal(BI.keepVoided(detailBlockOf(r.raw())), false);
  assert.equal(BI.bodyStateRaw(r.raw()), 'edited', 'still the reader\'s text');
  for (const x of [r, control]) {
    await x.hands.tick(x.mapPath, x.nodes[0].id);
    await x.callouts.reconcile(x.mapPath);
    await x.callouts.idle();
  }
  assert.equal(stageOf(r.raw()), 'checked', 'the save after the swap does not ask the hand-edit question again');
  const pictureFree = (text, x) => text.split('\n').filter(l => !/W[13]\.jpg|Caption [13]|book-slots:v1|book-body:v1|- 圖「Work [13]」/.test(l)).join('\n').replaceAll(x.nodes[0].id, 'NODE').replaceAll(/^topic-id: (.*)$/m.exec(text)[1], 'MAP').replace(/^updated: .*$/m, 'updated: T');
  assert.equal(pictureFree(r.raw(), r), pictureFree(control.raw(), control), 'apart from the picture, reconcile left both chapters the same');
});

test('refind: a ticked review box stays ticked through the swap and the next reconcile', async () => {
  const r = await rig();
  // A box the reader ticked ("accept as it is") on the program's own text: kept record, the box as an older version wrote it.
  const box = ['> [!vam-review] 請看這章', '> ・原因', '> - [x] 接受現在這樣，不用改', '> - [ ] 我改好了', `> %%vam-review:${(await r.state()).runId}:${r.nodes[0].id}:fp1%%`, '> %%vam-callout-version:1%%'].join('\n');
  await r.repo.updateNoteRawGuarded(r.path, text => BI.keepRaw(putProgramCallout(text, box)), { authorize: () => true });
  assert.equal(readReviewState(r.raw()).accept, true);
  const callouts = new BookCallouts({ readMap: p => r.repo.readMap(p), readCard: p => r.ports.readCard(p), readText: async p => r.contents.get(p), write: r.ports.notes.write, log: () => {} });
  await callouts.reconcile(r.mapPath); await callouts.idle();
  const settled = r.raw();
  const state = readReviewState(settled);
  await r.refind();
  assert.equal(BI.isKeptRaw(r.raw()), true);
  assert.deepEqual(readReviewState(r.raw()), state, 'the swap does not touch the box');
  await callouts.reconcile(r.mapPath); await callouts.idle();
  assert.deepEqual(readReviewState(r.raw()), state, 'the next reconcile leaves the box as it was');
});

// ---- the pure swap ----

test('swap: the reverse swap of a changed text puts the picture back; a text not as the swap left it is not guessed at', async () => {
  const r = await rig();
  const result = await r.refind();
  const edited = result.after.replace('正文二。', '正文二，後來改了。');
  const back = R.swapFigureStamped(edited, R.reverseSwap(result.swap), 'zh-TW');
  assert.equal(noBody(back), noBody(result.before.replace('正文二。', '正文二，後來改了。')));
  assert.equal(bodyLines(back), 1);
  assert.equal(R.swapFigure(edited.replace('Caption 3', 'Caption three'), R.reverseSwap(result.swap), 'zh-TW'), undefined, 'the new block was edited: no undo');
  assert.equal(R.swapFigure(result.after, result.swap, 'zh-TW'), undefined, 'the old block is gone: the same swap does not apply twice');
});

test('swap: a new picture without a source removes the old Sources entry; the reverse swap adds it back at the end of the Sources list', async () => {
  const r = await rig({ again: () => found({ 1: [{ ...cand(3), source: undefined }] }) });
  const result = await r.refind();
  assert.equal(result.kind, 'replaced');
  assert.ok(!r.raw().includes('- 圖「Work 1」') && !r.raw().includes('- 圖「Work 3」'));
  const back = R.swapFigure(result.after, R.reverseSwap(result.swap), 'zh-TW');
  assert.ok(back.includes('- 圖「Work 1」'));
  // The entry comes back at the end of the list (after the other picture's), not at its earlier place: accepted.
  assert.ok(back.indexOf('- 圖「Work 1」') > back.indexOf('- 圖「Work 2」'));
});

test('figureUrlAt: the image line, its caption and its source line name the picture; other lines, code and quotes do not', async () => {
  const r = await rig();
  const lines = r.raw().split('\n');
  const at = lines.findIndex(l => l.startsWith('![Work 1]'));
  for (const k of [0, 1, 2]) assert.equal(R.figureUrlAt(r.raw(), at + k), URL1);
  assert.equal(R.figureUrlAt(r.raw(), at - 2), undefined);
  assert.equal(R.figureUrlAt(r.raw(), at + 3), undefined);
  const fenced = r.raw().replace(`![Work 1](${URL1})`, m => '```\n' + m + '\n```');
  assert.equal(R.figureUrlAt(fenced, at + 1), undefined);
});

test('CRLF chapter: the new block keeps CRLF and the swap is still exact', async () => {
  const r = await rig();
  await r.repo.updateNoteRawGuarded(r.path, text => text.replace(/\r?\n/g, '\r\n'), { authorize: () => true });
  const before = r.raw();
  const result = await r.refind();
  assert.equal(result.kind, 'replaced');
  // The re-stamped fingerprint line (and the quote line before it) is written by the existing stamp with LF; every other line keeps CRLF.
  const rawLines = r.raw().split('\n').slice(0, -1);
  const stamp = rawLines.findIndex(l => l.includes('book-body:v1'));
  assert.deepEqual(rawLines.flatMap((l, i) => (l.endsWith('\r') || i === stamp || i === stamp - 1 ? [] : [i])), [], 'every line but the fingerprint pair ends with CRLF');
  const back = R.swapFigure(r.raw(), R.reverseSwap(result.swap), 'zh-TW');
  // The stamp's own lines are LF in a CRLF chapter (existing), so line ends are compared without the CR.
  assert.equal(noBody(back.replace(/\r/g, '')), noBody(before.replace(/\r/g, '')));
  assert.equal(bodyLines(back), 1);
});

// ---- undo: the editor (one transaction) and the "undo" notice ----

/** A fake open editor: each transaction is one undo step (Ctrl+Z puts the text before it back). */
const editorView = text => {
  const v = { text, history: [] };
  v.view = { text: () => v.text, replace: next => { v.history.push(v.text); v.text = next; return true; } };
  v.ctrlZ = () => { v.text = v.history.pop(); };
  return v;
};

test('undo: with the chapter open, the swap is one editor transaction and one Ctrl+Z puts every byte back', async () => {
  const r = await rig();
  const ed = editorView(r.raw());
  r.views = [ed.view];
  const before = ed.text;
  const result = await r.refind();
  assert.equal(result.kind, 'replaced');
  assert.equal(ed.history.length, 1, 'one transaction');
  assert.notEqual(ed.text, before);
  ed.ctrlZ();
  assert.equal(ed.text, before);
});

function ctlRig(run) {
  const c = { timers: [], next: 1 };
  const r = { notices: [], actions: [], cancels: [], changed: 0, writes: [] };
  r.text = 'T0';
  r.ports = {
    run: (path, url, signal) => run(path, url, signal, r),
    cancel: path => r.cancels.push(path),
    mapBusy: () => r.busy ?? null,
    codeOf: e => e && e.code,
    refusalText: e => `refused:${e.code}`,
    reasonText: e => `reason:${e.name}`,
    write: async (path, transform) => { const next = transform(r.text); r.writes.push(path); if (next === r.text) return 'unchanged'; r.text = next; return 'written'; },
    notice: m => r.notices.push(m),
    noticeAction: (message, label, onClick, ms) => { const a = { message, label, onClick, ms, hidden: false }; r.actions.push(a); return { hide: () => { a.hidden = true; } }; },
    changed: () => { r.changed++; },
    setTimer: (fn, ms) => { const h = c.next++; c.timers.push({ h, fn, ms }); return h; },
    clearTimer: h => { c.timers = c.timers.filter(x => x.h !== h); }
  };
  r.fire = () => { const due = c.timers.shift(); due?.fn(); return due; };
  r.timers = c.timers;
  r.c = c;
  r.ctl = new BookRefindSlot(r.ports);
  return r;
}
const aborted = signal => new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'cancelled' }))));

test('controller: press runs, a second press cancels (no write), the 3-minute limit says timeout; refusals and failures are messages', async () => {
  const r = ctlRig((path, url, signal) => aborted(signal));
  r.ctl.press('N/c.md', URL1);
  await tick();
  assert.equal(r.ctl.isRunning('N/c.md'), true);
  assert.deepEqual(r.notices, [t('ui.book_refind_started')]);
  r.ctl.press('N/c.md', URL1);
  await settle();
  assert.deepEqual(r.cancels, ['N/c.md']);
  assert.equal(r.notices.at(-1), t('ui.book_refind_cancelled'));
  assert.equal(r.ctl.isRunning('N/c.md'), false);
  assert.equal(r.c.timers.length, 0, 'the time limit is cleared');
  r.ctl.press('N/c.md', URL1);
  await tick();
  assert.equal(r.c.timers[0].ms, REFIND_TIMEOUT_MS);
  r.fire();
  await settle();
  assert.equal(r.notices.at(-1), t('ui.book_refind_timeout'));
  assert.deepEqual(r.writes, []);
  const f = ctlRig(async () => { throw Object.assign(new Error('x'), { name: 'TypeError' }); });
  f.ctl.press('p', URL1); await settle();
  assert.equal(f.notices.at(-1), t('ui.book_refind_failed_0', 'reason:TypeError'));
  const s = ctlRig(async () => { throw Object.assign(new Error('x'), { code: 'not_slot' }); });
  s.ctl.press('p', URL1); await settle();
  assert.equal(s.notices.at(-1), 'refused:not_slot');
  const down = ctlRig(async () => ({ kind: 'failed', reason: 'search_failed' }));
  down.ctl.press('p', URL1); await settle();
  assert.equal(down.notices.at(-1), t('ui.book_refind_service_down'));
  assert.notEqual(t('ui.book_refind_service_down'), t('ui.book_refind_none'));
  assert.equal(down.actions.length, 0); assert.equal(down.ctl.canUndo(), false);
  const n = ctlRig(async () => ({ kind: 'none' }));
  n.ctl.press('p', URL1); await settle();
  assert.equal(n.notices.at(-1), t('ui.book_refind_none'));
  assert.equal(n.actions.length, 0); assert.equal(n.ctl.canUndo(), false);
  const busy = ctlRig(async () => assert.fail('must not run'));
  busy.busy = 'drive';
  busy.ctl.press('p', URL1); await settle();
  assert.equal(busy.notices.at(-1), t('ui.book_refused_drive_running'));
});

test('controller undo: an untouched chapter gets its earlier text back byte for byte; a changed one gets the reverse swap; a gone picture is refused', async () => {
  const real = await rig();
  const result = await real.refind();
  const r = ctlRig(async () => result);
  r.text = result.after;
  r.ctl.press(result.path, URL1); await settle();
  assert.equal(r.actions.length, 1);
  assert.equal(r.actions[0].ms, REFIND_UNDO_MS);
  assert.equal(r.actions[0].label, t('ui.book_note_undo_label'));
  r.actions[0].onClick(); await settle();
  assert.equal(r.text, result.before, 'byte for byte');
  assert.equal(r.notices.at(-1), t('ui.book_refind_undo_done'));
  assert.equal(r.ctl.canUndo(), false);
  // changed since: only the picture goes back
  const c = ctlRig(async () => result);
  c.text = result.after.replace('正文二。', '正文二，又改。');
  c.ctl.press(result.path, URL1); await settle();
  await c.ctl.undo();
  assert.ok(c.text.includes(`![Work 1](${URL1})`) && c.text.includes('正文二，又改。') && !c.text.includes(URL3));
  // the new picture edited: nothing written, refused message
  const g = ctlRig(async () => result);
  g.text = result.after.replace('Caption 3', 'mine');
  g.ctl.press(result.path, URL1); await settle();
  const kept = g.text;
  await g.ctl.undo();
  assert.equal(g.text, kept);
  assert.equal(g.notices.at(-1), t('ui.book_refind_undo_refused'));
  // dispose: the notice goes, nothing afterwards
  const d = ctlRig(async () => result);
  d.ctl.press(result.path, URL1); await settle();
  d.ctl.dispose();
  assert.equal(d.actions[0].hidden, true);
  assert.equal(d.ctl.canUndo(), false);
});
