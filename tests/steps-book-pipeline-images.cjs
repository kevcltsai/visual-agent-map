// Picture search of the picture-book writer (Q13): the found pictures are loaded by the program and embedded in one standard form.
// (rig copied from the run test) Picture-book pipeline runner (03a): the gates, retries, budget pause, stop/resume, stale fence, dispose, guarded writes and the picture
// allow-list of BookPipelineRuns, with fake ports over the real repository fixture. The provider, probe and step runner are fakes.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('./support.cjs');
const { load: loadReplay } = require('./support-replay.cjs');
const { BookPipelineRuns, BookPipelineRunError, bodyImageUrls, replaceBodyImages, unsafeBody } = S.load('experiences/visual-map/book-pipeline-run.ts');
const { imageKey } = S.load('core/book-pipeline/image-dedupe.ts');
const { BudgetExhaustedError } = S.load('core/admission.ts');
const { readBookPipeline } = S.load('core/book-pipeline/model.ts');
const { cardRevision } = S.load('core/book-pipeline/machine.ts');
const { proofKey, evaluateProof } = S.load('core/book-pipeline/proof.ts');
const { findStoredProof, withoutResearchNotes } = S.load('core/book-pipeline/note-sections.ts');
const { parseChecklist } = S.load('core/book-pipeline/plan-text.ts');
const { stampDetail, bodyStateRaw, bodyState, readBodyRecord, integrityFp } = S.load('core/book-pipeline/body-integrity.ts');

const tick = () => new Promise(resolve => setImmediate(resolve));
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const settle = async () => { for (let i = 0; i < 30; i++) await tick(); };
const TITLES = ['SecretRootTitle', 'SecretTitleA', 'SecretTitleB'];
const bodyOf = title => `SecretBody ${title}`;
const stageOf = raw => /^pipeline-stage: "?([a-z-]+)"?$/m.exec(raw)?.[1];

/** A map of one root and two child cards (reading order: root, A, B), the fake ports and call counters. `over` replaces ports/script. */
const confirmDone = async (runs, mapPath) => { await runs.confirmGate1(mapPath); while (runs.isRunning(mapPath)) await new Promise(resolve => setImmediate(resolve)); };
async function rig(over = {}) {
  const data = S.fixture('zh-TW');
  const { repo, contents } = data;
  const mapPath = await repo.createMap('Book');
  const doc = await repo.readMap(mapPath);
  const nodes = [];
  for (const title of over.titles ?? TITLES) nodes.push(await repo.createNote(title, 'model-a', doc, mapPath, 'workspace', { summary: `summary of ${title}` }));
  nodes.forEach((node, i) => { node.x = i * 300; node.y = 0; if (i) node.parentId = nodes[0].id; });
  await repo.updateMap(mapPath, d => { d.nodes.push(...nodes); });
  const stat = { logs: [], plan: [], author: [], proof: [], probes: [], backups: [], writes: 0 };
  let queue = Promise.resolve();
  let ids = 0;
  const script = { global: () => ({ thread: 'one thread', cards: nodes.map((n, i) => ({ id: n.id, role: i ? 'body' : 'intro' })), materials: [{ name: 'm', use: 'u' }], decisions: { reader: 'kids' } }),
    card: request => ({ covers: `covers ${request.card.position}`, entry: 'entry', handoff: 'handoff', previous: 'p', next: 'n', checklist: [{ id: 'C1', type: 'structure', text: 'has a beginning' }, { id: 'C2', type: 'structure', text: 'has an end' }] }),
    author: async input => { await input.admission.reserve(); const note = await repo.readNote(input.path); const r = await repo.updateNoteGuarded(input.path, { detail: bodyOf(note.title) }, { authorize: input.authorize, finalize: input.finalize }); return r === 'written' ? { outcome: 'written' } : { outcome: 'discarded' }; },
    proof: async request => ({ items: request.checklist.map(c => ({ id: c.id, type: c.type, status: 'met', note: 'fine', sources: [] })), aggregate: 'checked' }),
    probe: async () => ({ ok: true }), ...over.script };
  const ports = {
    mutate: work => { const next = queue.then(work); queue = next.catch(() => undefined); return next; },
    readMap: path => repo.readMap(path),
    // These tests pin the older run without a trial (every card planned before gate 1): the run's `trial` is dropped.
    updateMap: (path, change) => repo.updateMap(path, d => { change(d); if (d.bookPipeline) delete d.bookPipeline.trial; }),
    readCard: async path => {
      const note = await repo.readNote(path);
      return { path, title: note.title, summary: note.summary, prompt: note.prompt, detail: note.detail, raw: contents.get(path), settings: note.bookSettings ?? {}, fields: { ...(note.pipelineStage ? { pipelineStage: note.pipelineStage } : {}), ...(note.bookRole ? { bookRole: note.bookRole } : {}), ...(note.pipelineRole ? { pipelineRole: note.pipelineRole } : {}), ...(note.pipelineIssue ? { pipelineIssue: note.pipelineIssue } : {}) } };
    },
    writePipelineFields: (path, patch) => { stat.writes++; return repo.writePipelineFields(path, patch); },
    updateNoteGuarded: (path, patch, options) => repo.updateNoteGuarded(path, patch, options),
    updateNoteRawGuarded: (path, transform, options) => repo.updateNoteRawGuarded(path, transform, options),
    runPlan: async (step, request, run) => {
      if (step.id === 'book-pipeline.global-plan') { stat.plan.push('global'); await run.admission.reserve(); return script.global(request, stat.plan.filter(x => x === 'global').length); }
      stat.plan.push(request.card.id); await run.admission.reserve(); return script.card(request, stat.plan.filter(x => x === request.card.id).length);
    },
    runProofread: async (request, run) => { stat.proof.push(request); await run.admission.reserve(); return script.proof(request, stat.proof.length); },
    author: input => { stat.author.push(input.nodeId); return script.author(input, stat.author.filter(x => x === input.nodeId).length); },
    probeImage: async (url, signal) => { stat.probes.push(url); return script.probe(url, signal, stat.probes.length); },
    backupNote: async path => { stat.backups.push(path); return { ok: true, path: `${path}.bak` }; },
    blocked: () => false,
    config: () => ({ planModel: 'm1', authorModel: 'm2', imageModel: 'm4', proofModel: 'm3', reasoning: 'low', language: 'zh-TW' }),
    now: () => '2026-11-17T00:00:00.000Z',
    newId: () => `run-${++ids}`,
    log: line => stat.logs.push(line),
    ...over.ports
  };
  const runs = new BookPipelineRuns(ports);
  const state = async () => readBookPipeline(await repo.readMap(mapPath)).data;
  const note = async i => repo.readNote(nodes[i].path);
  const raw = i => contents.get(nodes[i].path);
  return { ...data, runs, ports, stat, script, mapPath, nodes, state, note, raw, contents, mapRaw: () => contents.get(mapPath) };
}
/** Lowers the saved call limit (the pipeline has no port for it; the file is the owner's control). */
const setLimit = (r, limit) => r.repo.updateMap(r.mapPath, d => { d.bookPipeline.budget.limit = limit; });

const BODY = '正文開頭《蒙娜麗莎》結尾。';
const writeAuthor = (r, text) => async input => { await input.admission.reserve(); const n = await r.repo.readNote(input.path); const out = await r.repo.updateNoteGuarded(input.path, { detail: typeof text === 'function' ? text(n.title, input) : text }, { authorize: input.authorize, finalize: input.finalize }); return out === 'written' ? { outcome: 'written' } : { outcome: 'discarded' }; };
const cand = (n, over = {}) => ({ title: `Work ${n}`, caption: `Caption ${n}`, url: `https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/W${n}.jpg/1280px-W${n}.jpg`, source: `https://commons.wikimedia.org/wiki/File:W${n}.jpg`, ...over });
/** The finder's answer: `{ 1: [cand...], 2: [...] }` by slot index. */
const found = bySlotObj => { const bySlot = new Map(Object.entries(bySlotObj).map(([k, v]) => [Number(k), v])); return { bySlot, found: [...bySlot.values()].reduce((n, v) => n + v.length, 0), offTopic: 0 }; };
const slotsOf = n => Array.from({ length: n }, (_, i) => ({ index: i + 1, kind: 'diagram', explains: `explains ${i + 1} perspective`, anchor: `after paragraph ${i + 1}` }));
const mk = (n, text = `explains ${n} perspective`) => `〔圖位 ${n}：${text}〕`;
/** Two paragraphs, each followed by its marker line, then a Sources section. */
const twoMarkers = title => `正文一。${title}\n\n${mk(1)}\n\n正文二。\n\n${mk(2)}\n\n正文三。\n\n### 來源\n- https://example.com/a\n`;
/** A rig whose card plan arranges `slots` pictures (null: an old Prompt without an image plan) and whose author writes `text`; `finder` is the fake picture search (request, run, callNumber) -> found(). */
async function picRig({ finder, probe, text = twoMarkers, titles, proof, slots = 2, ports, checklist } = {}) {
  const calls = [];
  const holder = {};
  const r = await rig({
    titles: titles ?? ['SecretRootTitle', 'FillerChapter'],
    script: { card: request => ({ covers: `covers ${request.card.position}`, entry: 'entry', handoff: 'handoff', previous: 'p', next: 'n', checklist: checklist ?? [{ id: 'C1', type: 'structure', text: 'has a beginning' }, { id: 'C2', type: 'structure', text: 'has an end' }], ...(slots === null ? {} : { images: Array.isArray(slots) ? slots : slotsOf(slots) }) }),
      author: (input, n) => writeAuthor(holder.r, text)(input), ...(probe ? { probe } : {}), ...(proof ? { proof } : {}) },
    ports: { findImages: async (request, run) => { if (!titles && /FillerChapter/.test(request.chapter)) { await run.admission.reserve(); return found({}); } calls.push(request); await run.admission.reserve(); return finder(request, run, calls.length); }, ...ports }
  });
  holder.r = r;
  r.calls = calls;
  return r;
}
const plain = value => JSON.parse(JSON.stringify(value));
const run = async r => { await r.runs.start(r.mapPath); await confirmDone(r.runs, r.mapPath); };
const recordOf = detail => JSON.parse(/<!-- book-slots:v1 (\{.*\}) -->/.exec(detail)[1]);
const figures = detail => detail.match(/!\[[^\]]*\]\([^)\s]+\)/g) ?? [];

test('slots: two markers become two standard images with one plain caption line each, in place; the card has one book-slots record and no marker', async () => {
  const r = await picRig({ finder: () => found({ 1: [cand(1)], 2: [cand(2)] }) });
  await run(r);
  const detail = (await r.note(0)).detail;
  assert.match(detail, /正文一。SecretRootTitle\n\n!\[Work 1\]\(https:\/\/upload\.wikimedia\.org[^)\s]+\)\nCaption 1\n來源：commons\.wikimedia\.org（\[連結\]\(https:\/\/commons\.wikimedia\.org\/wiki\/File:W1\.jpg\)）\n\n正文二。\n\n!\[Work 2\]\([^)\s]+\)\nCaption 2\n來源：commons\.wikimedia\.org（\[連結\]\([^)\s]+\)）\n\n正文三。\n\n### 來源\n- https:\/\/example\.com\/a\n- 圖「Work 1」：commons\.wikimedia\.org（\[連結\]\(https:\/\/commons\.wikimedia\.org\/wiki\/File:W1\.jpg\)）\n- 圖「Work 2」：/);
  assert.ok(!/〔圖位|無圖：|### 圖像/.test(detail));
  assert.equal(r.calls.length, 1, 'one search call per card');
  assert.equal(r.calls[0].model, 'm4', 'the picture model (not the author model m2)');
  assert.deepEqual(plain(r.calls[0].slots.map(s => s.index)), [1, 2]);
  assert.match(r.calls[0].chapter, /SecretRootTitle/);
  assert.equal(detail.split('book-slots:v1').length - 1, 1, 'one record');
  assert.deepEqual(plain(recordOf(detail).slots.map(s => [s.index, s.state])), [[1, 'placed'], [2, 'placed']]);
  assert.equal(stageOf(r.raw(0)), 'checked');
  const log = r.stat.logs.filter(l => l.includes(' slots ')).join('\n');
  assert.match(log, /book-pipeline slots .* placed=2 missing=0$/m);
  assert.ok(!/SecretRootTitle|wikimedia|蒙娜麗莎/.test(r.stat.logs.join('\n')), 'the log has counts and codes only');
});

test('slots: a slot with no loadable or no found picture loses its whole marker line (no "no picture" text, no double blank line) and records why', async () => {
  for (const [finder, reason] of [[() => found({ 1: [cand(1)], 2: [cand(2)] }), 'load_failed'], [() => found({}), 'not_found']]) {
    const r = await picRig({ finder, probe: async () => ({ ok: false, reason: 'load_failed' }) });
    await run(r);
    const note = await r.note(0);
    assert.match(note.detail, /正文一。SecretRootTitle\n\n正文二。\n\n正文三。\n\n### 來源/);
    assert.ok(!/〔圖位|無圖：|### 圖像|!\[/.test(note.detail));
    assert.deepEqual(recordOf(note.detail).slots.map(s => [s.state, s.reasonCode]), [['missing', reason], ['missing', reason]]);
    assert.match(r.stat.logs.join('\n'), new RegExp(`slots .* placed=0 missing=2 reason=${reason}$`, 'm'));
    assert.equal(stageOf(r.raw(0)), 'checked');
  }
});

test('slots: a candidate that is not https, has a bad address or fails to load is not placed and not probed (when unsafe); the verified one is', async () => {
  const r = await picRig({ slots: 1, text: title => `${BODY}\n\n${mk(1)}\n\n尾。\n`, finder: () => found({ 1: [cand(1, { url: 'http://example.com/a.jpg' }), cand(2, { url: 'javascript:alert(1)' }), cand(3), cand(4)] }), probe: async url => (url.includes('W3') ? { ok: false, reason: 'timeout' } : { ok: true }) });
  await run(r);
  const detail = (await r.note(0)).detail;
  assert.equal(figures(detail).length, 1);
  assert.match(detail, /!\[Work 4\]/);
  assert.ok(!/http:\/\/|javascript:|W3/.test(detail));
  assert.ok(!r.stat.probes.some(u => !u.startsWith('https:')), 'only https addresses are probed');
  const none = await picRig({ slots: 1, text: () => `${BODY}\n\n${mk(1)}\n\n尾。\n`, finder: () => found({ 1: [cand(1, { url: 'http://example.com/a.jpg' }), cand(2, { url: 'javascript:alert(1)' })] }) });
  await run(none);
  assert.equal(none.stat.probes.length, 0);
  assert.equal(recordOf((await none.note(0)).detail).slots[0].reasonCode, 'unsafe_url');
});

test('slots: addresses to an inner network, with credentials or an odd port are not probed or placed', async () => {
  const r = await picRig({ slots: 1, text: () => `${BODY}\n\n${mk(1)}\n\n尾。\n`, finder: () => found({ 1: [cand(1, { url: 'https://127.0.0.1/a.jpg' }), cand(2, { url: 'https://foo.local/b.jpg' }), cand(3, { url: 'https://example.com:8443/c.jpg' }), cand(4)] }) });
  await run(r);
  assert.equal(figures((await r.note(0)).detail).length, 1);
  assert.deepEqual(r.stat.probes.filter(u => /127\.0|\.local|8443/.test(u)), []);
});

test('U zh-TW captions: common Simplified characters are written in Traditional; a lowercase English word left in a Chinese caption makes the chapter need a look', async () => {
  const r = await picRig({ slots: 1, text: () => `${BODY}\n\n${mk(1)}\n\n尾。\n`, finder: () => found({ 1: [cand(1, { caption: '樱桃番茄的果實long在藤上' })] }) });
  await run(r);
  const detail = (await r.note(0)).detail;
  assert.ok(detail.includes('櫻桃番茄的果實long在藤上') && !detail.includes('樱'), 'caption in Traditional characters');
  assert.equal(stageOf(r.raw(0)), 'needs-review');
  assert.match((await r.note(0)).pipelineIssue, /captions:latin/);
  const IS = S.load('core/book-pipeline/image-slots.ts');
  const caption = (text, language) => IS.figureOf({ imageUrl: 'https://a.example/x.jpg', sourceUrl: 'https://b.example', title: 'T', caption: text }, 'https://a.example/x.jpg', language).caption;
  assert.equal(caption('樱桃番茄', 'zh-TW'), '櫻桃番茄');
  assert.equal(caption('这种叶子长时间发黄', 'zh-TW'), '這種葉子長時間發黃');
  assert.equal(caption('樱桃番茄', 'zh-CN'), '樱桃番茄', 'a Simplified book keeps its characters');
  const fig = text => `前。\n\n![T](https://a.example/x.jpg)\n${text}\n\n後。`;
  assert.equal(IS.captionLatinIssue(fig('果實long在藤上'), 'zh-TW'), 'captions:latin');
  assert.equal(IS.captionLatinIssue(fig('果實 long 在藤上'), 'zh-CN'), 'captions:latin');
  assert.equal(IS.captionLatinIssue(fig('櫻桃番茄 Solanum lycopersicum'), 'zh-TW'), '', 'a capitalised name stays');
  assert.equal(IS.captionLatinIssue(fig('圖：Cherry tomato.jpg'), 'zh-TW'), '', 'a file name');
  assert.equal(IS.captionLatinIssue(fig('A tomato long on the vine'), 'en'), '', 'only Chinese books');
  assert.equal(IS.captionLatinIssue('果實long在藤上', 'zh-TW'), '', 'prose, not a caption');
  assert.equal(IS.splitPictureIssue('images unmet: captions:latin').captionLatin, true);
  assert.equal(IS.splitPictureIssue('images unmet: captions:latin').rest, '');
});

test('slots: a malicious title or caption (HTML, links, line breaks, a slot marker, an image) becomes plain escaped single-line text', async () => {
  const evil = 'Evil <img src=x onerror=alert(1)> [click](https://evil.example/x)\nsecond line ![x](https://evil.example/y) 〔圖位 2：boom〕';
  const r = await picRig({ slots: 1, text: () => `${BODY}\n\n${mk(1)}\n\n尾。\n`, finder: () => found({ 1: [cand(1, { title: evil, caption: evil })] }) });
  await run(r);
  const detail = (await r.note(0)).detail;
  assert.equal(detail.split('\n').filter(l => l.startsWith('![')).length, 1, 'the text cannot form another image');
  assert.ok(!/(^|[^\\])!\[/m.test(detail.split('\n').filter(l => !l.startsWith('![')).join('\n')), 'no unescaped image start in the caption');
  assert.ok(!/<img|<[A-Za-z]|〔圖位/.test(detail));
  assert.ok(!/\]\(https:\/\/evil/.test(detail.replace(/\\\]\\\(/g, '')));
  assert.ok(!/\[click\]\(/.test(detail));
  const lines = detail.split('\n'); const at = lines.findIndex(l => l.startsWith('![')); assert.ok(lines[at + 1] && !lines[at + 1].includes('![') && lines[at + 3] === '');
  const added = lines.slice(at, at + 3).join('\n');
  assert.equal(unsafeBody(added, new Set(bodyImageUrls(added))), false);
  assert.equal(stageOf(r.raw(0)), 'checked');
});

test('slots: a marker inside a quote or a code fence stays word for word and does not count; the body marker of the same number is filled', async () => {
  const text = () => `${BODY}\n\n${mk(1)}\n\n> ${mk(1, '引用')}\n\n\`\`\`\n${mk(2, '程式')}\n\`\`\`\n\n尾。\n\n${mk(2)}\n`;
  const r = await picRig({ text, finder: () => found({ 1: [cand(1)], 2: [cand(2)] }) });
  await run(r);
  const detail = (await r.note(0)).detail;
  assert.ok(detail.includes(`> ${mk(1, '引用')}\n`) && detail.includes(`\`\`\`\n${mk(2, '程式')}\n\`\`\``), 'quote and fence verbatim');
  assert.equal(figures(detail).length, 2);
  assert.equal(stageOf(r.raw(0)), 'checked');
  assert.deepEqual(recordOf(detail).slots.map(s => s.state), ['placed', 'placed']);
});

test('slots: a repeated marker keeps the first, an out-of-range or reworded marker line is deleted (bad_marker), and nothing is left over', async () => {
  const text = () => `${BODY}\n\n${mk(1)}\n\n中。\n\n${mk(1)}\n\n${mk(5)}\n\n〔圖位 2 ：改寫〕\n\n尾。\n`;
  const r = await picRig({ text, finder: () => found({ 1: [cand(1)], 2: [cand(2)] }) });
  await run(r);
  const detail = (await r.note(0)).detail;
  assert.ok(!/〔圖位/.test(detail));
  assert.equal(figures(detail).length, 1);
  assert.match(detail, /中。\n\n尾。/);
  const rec = recordOf(detail);
  assert.deepEqual(rec.slots.map(s => [s.index, s.state, s.reasonCode]), [[1, 'placed', undefined], [2, 'missing', 'bad_marker']]);
  assert.equal(rec.bad, 2);
  assert.equal(r.calls[0].slots.length, 1, 'only the slot that has a valid marker is searched');
  assert.equal(stageOf(r.raw(0)), 'checked');
});

test('slots: markers on the same line (adjacent or inside a sentence) are removed without leaving a blank line, the rest of the line stays; no search when no slot has a marker', async () => {
  const text = () => `前文〔圖位 1：a〕〔圖位 2：b〕後文。\n\n${mk(1)}${mk(2)}\n\n尾。\n`;
  const r = await picRig({ text, finder: () => found({ 1: [cand(1)] }) });
  await run(r);
  const detail = (await r.note(0)).detail;
  assert.ok(detail.startsWith('前文後文。\n\n尾。'), detail);
  assert.ok(!/\n\n\n/.test(detail) && !/〔圖位/.test(detail));
  assert.equal(r.calls.length, 0, 'no slot had a valid marker, so no search call');
  assert.deepEqual(recordOf(detail).slots.map(s => s.reasonCode), ['bad_marker', 'bad_marker'], 'the author did leave markers (inline), so not author_omitted');
  const adjacent = await picRig({ text: () => `${BODY}\n\n${mk(1)}\n${mk(2)}\n尾。\n`, finder: () => found({ 1: [cand(1)], 2: [cand(2)] }) });
  await run(adjacent);
  const d2 = (await adjacent.note(0)).detail;
  assert.equal(figures(d2).length, 2); assert.ok(!/\n\n\n/.test(d2));
});

test('slots: a search that throws, never answers or is aborted does not make the card need review or count as a failure', async () => {
  const r = await picRig({ finder: () => { throw new Error('search boom'); } });
  await run(r);
  const s = await r.state();
  assert.equal(stageOf(r.raw(0)), 'checked');
  assert.match((await r.note(0)).pipelineIssue ?? '', /^image notice: image_1 image_2$/, 'only the notice tokens of the missing pictures, never a failure or needs-review');
  assert.deepEqual(recordOf((await r.note(0)).detail).slots.map(x => x.reasonCode), ['not_found', 'not_found']);
  assert.equal(s.cards?.[r.nodes[0].id]?.attempts?.write ?? 1, 1);
  assert.equal(r.calls.length, 1, 'no retry');
});

test('slots: a stop during the search or a probe leaves the card with its markers and not written', async () => {
  for (const where of ['search', 'probe']) {
    const hold = defer();
    const r = await picRig({ finder: async () => { if (where === 'search') await hold.promise; return found({ 1: [cand(1)] }); }, probe: async () => { if (where === 'probe') await hold.promise; return { ok: true }; } });
    await r.runs.start(r.mapPath);
    await r.runs.confirmGate1(r.mapPath);
    await settle();
    assert.equal(r.calls.length, 1);
    await r.runs.stop(r.mapPath);
    hold.resolve();
    await settle();
    assert.ok(!/book-slots/.test((await r.note(0)).detail) && figures((await r.note(0)).detail).length === 0, where);
    assert.notEqual(stageOf(r.raw(0)), 'written');
  }
});

test('slots: the budget is gated; a refusal in the search pauses the run and leaves the markers, no record and no stage on the card', async () => {
  const r = await picRig({ finder: () => found({ 1: [cand(1)] }) });
  await r.runs.start(r.mapPath);
  // global plan 1 + card plan 1 are used; allow the author call but not the search
  const used = (await r.state()).budget.used;
  await setLimit(r, used + 2);
  await r.runs.confirmGate1(r.mapPath);
  await settle();
  const s = await r.state();
  assert.equal(s.status, 'stopped'); assert.equal(s.pauseReason, 'budget');
  assert.ok(!/book-slots/.test((await r.note(0)).detail));
  assert.notEqual(stageOf(r.raw(0)), 'written');
  assert.notEqual(stageOf(r.raw(0)), 'checked');
  assert.ok(!(await r.note(0)).pipelineIssue);
});

/** The old card's Detail with a system picture section (what a T1 card looks like). */
const OLD_DETAIL = '舊文。\n\n### 圖像\n\n![Old](https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Old.jpg/1280px-Old.jpg)\nOld／來源：commons.wikimedia.org\n\n### 來源\n- https://example.com/a\n';
test('old Prompt (no image plan): no search, no record, a stray marker line is deleted, the existing picture section is carried over word for word (#12, #16)', async () => {
  const r = await picRig({ slots: null, text: () => `新文。\n\n${mk(1)}\n\n尾。\n\n### 來源\n- https://example.com/a\n`, finder: () => found({ 1: [cand(1)] }) });
  await r.repo.updateNote(r.nodes[0].path, { detail: stampDetail(OLD_DETAIL) });
  await run(r);
  const detail = (await r.note(0)).detail;
  assert.equal(r.calls.length, 0, 'no search call');
  assert.ok(!/book-slots|〔圖位/.test(detail));
  assert.match(detail, /新文。\n\n尾。/);
  assert.match(detail, /### 圖像\n\n!\[Old\]\(https:\/\/upload\.wikimedia\.org[^)\s]+Old\.jpg[^)\s]*\)\nOld／來源：commons\.wikimedia\.org\n/);
  assert.equal((detail.match(/### 圖像/g) ?? []).length, 1);
  assert.equal(stageOf(r.raw(0)), 'checked');
  assert.ok(!r.stat.logs.some(l => l.includes(' slots ')), 'no slots event without a plan');
});

test('image plan with 0 slots: no search, no record, the old picture section is not carried over (the card has a plan)', async () => {
  const r = await picRig({ slots: 0, text: () => `新文。\n\n${mk(1)}\n\n尾。\n`, finder: () => found({}) });
  await r.repo.updateNote(r.nodes[0].path, { detail: stampDetail(OLD_DETAIL) });
  await run(r);
  const detail = (await r.note(0)).detail;
  assert.equal(r.calls.length, 0);
  assert.ok(!/book-slots|〔圖位|### 圖像/.test(detail));
  assert.match(detail, /新文。\n\n尾。/);
  assert.equal(stageOf(r.raw(0)), 'checked');
});

test('slots: a write that is discarded (the owner edited the card meanwhile) does not advance the stage and releases the claimed picture for the next chapter', async () => {
  const gate = defer();
  let hit = 0;
  const r = await picRig({ titles: ['SecretRootTitle', 'SecretTitleA'], slots: 1, text: title => `${BODY} ${title}\n\n${mk(1)}\n\n尾。\n`, finder: () => found({ 1: [cand(1)] }), ports: { updateNoteGuarded: async (path, patch, options) => { return r2.repo.updateNoteGuarded(path, patch, options); } } });
  const r2 = r;
  const finder = r.ports.findImages;
  r.ports.findImages = async (request, runInfo) => { if (/SecretTitleA/.test(request.chapter)) await gate.promise; return finder(request, runInfo); };
  r.ports.updateNoteGuarded = async (path, patch, options) => {
    if (path === r.nodes[0].path && /book-slots/.test(patch.detail ?? '') && !hit++) {
      r.contents.set(path, r.raw(0) + '\nowner edit');
      const out = await r.repo.updateNoteGuarded(path, patch, options);
      gate.resolve();
      return out;
    }
    return r.repo.updateNoteGuarded(path, patch, options);
  };
  await run(r);
  assert.equal(hit >= 1, true);
  assert.match(await r.raw(0), /owner edit/, 'the owner text is not overwritten');
  assert.ok((await r.note(1)).detail.includes('![Work 1]'), 'the picture released by the discarded write went to the next chapter');
});

test('slots: a picture claimed by a chapter whose write is blocked by the exit check is released for the next chapter', async () => {
  const r = await picRig({ titles: ['SecretRootTitle', 'SecretTitleA'], slots: 1, text: title => `${BODY} ${title}\n\n${mk(1)}\n\n尾。\n`, finder: () => found({ 1: [cand(1)] }) });
  const first = defer();
  const finder = r.ports.findImages;
  r.ports.findImages = async (request, runInfo) => { if (/SecretTitleA/.test(request.chapter)) await first.promise; return finder(request, runInfo); };
  let blocked = 0;
  r.runs.exitCheck = text => { if (!text.includes('![Work 1]') || blocked++) return false; first.resolve(); return true; };
  await run(r);
  assert.equal((await embedded(r, 2)).length, 1, 'the picture went to the other chapter');
  assert.ok(figures((await r.note(1)).detail).length === 1);
});

test('quality run: a write blocked by the exit check releases the claimed work, so the other chapter offered the same work (another file, same author) places it', async () => {
  const name = title => /SecretTitleA/.test(title) ? 'Sir_Winston_Churchill_-_19086236948.jpg' : 'Sir_Winston_Churchill_(cropped).jpg';
  const r = await picRig({ titles: ['SecretRootTitle', 'SecretTitleA'], slots: 1, text: title => `${BODY} ${title}\n\n${mk(1)}\n\n尾。\n`,
    finder: req => { const n = name(req.chapter); return found({ 1: [cand(0, { url: commons(n), source: `https://commons.wikimedia.org/wiki/File:${n}`, author: 'Yousuf Karsh' })] }); } });
  const first = defer();
  const finder = r.ports.findImages;
  r.ports.findImages = async (request, runInfo) => { if (/SecretTitleA/.test(request.chapter)) await first.promise; return finder(request, runInfo); };
  let blocked = 0;
  r.runs.exitCheck = text => { if (!/!\[/.test(text) || blocked++) return false; first.resolve(); return true; };
  await run(r);
  assert.equal(figures((await r.note(1)).detail).length, 1, 'the work released by the blocked write went to the other chapter');
});

const embedded = async (r, n) => { const out = []; for (let i = 0; i < n; i++) out.push(...figures((await r.note(i)).detail)); return out; };

test('sections: chapterBody drops the picture section; setImageSection puts it before Sources, replaces an old one and removes on null', () => {
  const { chapterBody, setImageSection } = S.load('core/book-pipeline/note-sections.ts');
  const base = 'Text.\n\n### 來源\n- s\n\n### 研究備註\n\n> note';
  const withImg = setImageSection(base, '![A](https://e.com/a.jpg)\nA', 'zh-TW');
  assert.equal(withImg, 'Text.\n\n### 圖像\n\n![A](https://e.com/a.jpg)\nA\n\n### 來源\n- s\n\n### 研究備註\n\n> note');
  assert.equal(chapterBody(withImg), 'Text.');
  const again = setImageSection(withImg, '![B](https://e.com/b.jpg)\nB', 'zh-TW');
  assert.equal((again.match(/### 圖像/g) ?? []).length, 1); assert.ok(!/e\.com\/a/.test(again));
  assert.equal(setImageSection(withImg, null, 'zh-TW'), 'Text.\n\n### 來源\n- s\n\n### 研究備註\n\n> note');
  assert.equal(setImageSection('Text.', '![A](https://e.com/a.jpg)\nA', 'en'), 'Text.\n\n### Images\n\n![A](https://e.com/a.jpg)\nA\n');
  assert.equal(chapterBody('Text.\n\n### Images\n\n![A](https://e.com/a.jpg)\nA\n'), 'Text.');
});

test('sections: the author\'s own "## 圖像" / "### 圖像" text and its Sources are kept; only the system form is replaced or stripped', () => {
  const { chapterBody, setImageSection } = S.load('core/book-pipeline/note-sections.ts');
  for (const h of ['## 圖像', '### 圖像', '### Images']) {
    const authored = `開頭。\n\n${h}\n\n宗教圖像在這一章很重要。\n\n### 來源\n- s`;
    const out = setImageSection(authored, '![A](https://e.com/a.jpg)\nA', 'zh-TW');
    assert.ok(out.includes('宗教圖像在這一章很重要。') && out.includes('### 來源\n- s'), h);
    assert.equal(setImageSection(authored, null, 'zh-TW'), authored);
    assert.ok(chapterBody(authored).includes('宗教圖像在這一章很重要。'), h);
  }
  const img = '開頭。\n\n## 圖像\n\n正文\n\n### 來源\n- s';
  let n = img;
  for (let i = 0; i < 3; i++) n = setImageSection(n, `![A${i}](https://e.com/a${i}.jpg)\nA${i}`, 'zh-TW');
  assert.equal((n.match(/^### 圖像/gm) ?? []).length, 1);
  assert.ok(n.includes('## 圖像\n\n正文') && n.includes('### 來源\n- s') && !n.includes('a0.jpg'));
  assert.equal(chapterBody(n), '開頭。\n\n## 圖像\n\n正文');
});

test('images: addresses to an inner network or with credentials / odd ports are refused, public ones pass (body images too)', () => {
  const bad = ['https://127.0.0.1/a.png', 'https://localhost:8443/a.png', 'https://192.168.1.1/a.png', 'https://169.254.169.254/a.png', 'https://[::1]/a.png',
    'https://user:pw@example.com/a.png', 'https://2130706433/a.png', 'https://0x7f.0.0.1/a.png', 'https://017700000001/a.png', 'https://[::ffff:127.0.0.1]/a.png',
    'https://LOCALHOST/a.png', 'https://a.localhost/a.png', 'https://foo.local/a.png', 'https://foo.internal/a.png', 'https://foo.lan/a.png', 'https://intranet/a.png',
    'https://example.com:8443/a.png', 'https://example.com@127.0.0.1/a.png', 'https://example.com%40evil/a.png'.replace('%40', '@')];
  const ok = ['https://upload.wikimedia.org/a/a.jpg', 'https://images.metmuseum.org/a.jpg', 'https://www.rijksmuseum.nl/a.jpg', 'https://example.com:443/a.jpg'];
  for (const url of bad) {
    const out = replaceBodyImages(`![x](${url})`, new Map());
    assert.ok(!out.includes('!['), url);
    assert.match(out, /網址不安全/, url);
  }
  for (const url of ok) assert.match(replaceBodyImages(`![x](${url})`, new Map()), /^!\[x\]\(https:\/\//, url);
});

test('images: imageKey is the decoded lowercase Wikimedia file name for original and thumbnail forms on both hosts; other addresses lose query and hash', () => {
  const name = 'my_file%20%C3%A9.jpg';
  const keys = [`https://upload.wikimedia.org/wikipedia/commons/a/ab/${name}`, `https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/${name}/1280px-${name}`,
    `https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/${name}/320px-${name}`, `https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/${name}/800px-${name}`].map(imageKey);
  assert.equal(new Set(keys).size, 1);
  assert.equal(keys[0], 'my_file é.jpg');
  assert.notEqual(imageKey('https://upload.wikimedia.org/a/ab/Other.jpg'), keys[0]);
  assert.equal(imageKey('https://example.com/a/b.jpg?x=1#frag'), 'https://example.com/a/b.jpg');
  assert.equal(imageKey('https://example.com/a/b.jpg?x=2'), imageKey('https://example.com/a/b.jpg'));
});


test('slots: two chapters searched at the same time that get the same picture place it once; the other slot ends not_found', async () => {
  const r = await picRig({ titles: ['SecretRootTitle', 'SecretTitleA'], slots: 1, text: title => `${BODY} ${title}\n\n${mk(1)}\n\n尾。\n`, finder: () => found({ 1: [cand(1)] }) });
  await run(r);
  assert.equal((await embedded(r, 2)).length, 1, 'one picture in the whole book');
  assert.equal(r.calls.length, 2);
  assert.ok(r.calls.every(c => Array.isArray(c.exclude)));
  const states = [(await r.note(0)).detail, (await r.note(1)).detail].map(d => recordOf(d).slots[0]);
  assert.deepEqual(states.map(s => s.state).sort(), ['missing', 'placed']);
  assert.equal(states.find(s => s.state === 'missing').reasonCode, 'not_found');
});

test('slots: a later chapter is told the pictures other chapters already use; a single-card rerun searches again and does not exclude its own', async () => {
  const r = await picRig({ titles: ['SecretRootTitle', 'SecretTitleA'], slots: 1, text: title => `${BODY} ${title}\n\n${mk(1)}\n\n尾。\n`, finder: req => found({ 1: [cand(/SecretTitleA/.test(req.chapter) ? 2 : 1)] }) });
  await run(r);
  assert.equal((await embedded(r, 2)).length, 2, 'each chapter has its own picture');
  const key = n => imageKey(cand(n).url);
  const before = r.calls.length;
  await r.runs.rerunCard(r.mapPath, r.nodes[1].id);
  while (r.runs.isRunning(r.mapPath)) await tick();
  await settle();
  const rerun = r.calls[before];
  assert.ok(rerun, 'a card with an image plan is searched again on a rerun');
  assert.ok(/SecretTitleA/.test(rerun.chapter));
  assert.ok(rerun.exclude.includes(key(1)), 'the other chapter\'s picture is excluded');
  assert.ok(!rerun.exclude.includes(key(2)), 'its own old picture is not excluded');
  assert.equal(figures((await r.note(1)).detail).length, 1);
  assert.equal((await r.note(1)).detail.split('book-slots:v1').length - 1, 1, 'the record is replaced, not added');
});

test('images: the find-images step keeps up to 3 candidates per slot with the caption of the image the parser kept, drops not-relevant or undescribed images, and counts them', () => {
  const { findImagesStep } = require('./support-ai-calls.cjs').loadWithAiCalls('core/steps/book-pipeline/find-images.ts');
  const img = (n, extra) => ({ title: `T${n}`, caption: `C${n}`, imageUrl: `https://upload.wikimedia.org/a/ab/F${n}.jpg`, sourceUrl: 'https://commons.wikimedia.org/wiki/File:F.jpg', kind: 'diagram', shows: 'a thing', relevant: true, ...extra });
  const parsed = findImagesStep.parse(JSON.stringify({ slots: [{ slot: 1, images: [img(1), img(2, { relevant: false }), img(3, { imageUrl: 'http://bad.example/x.jpg' }), img(4, { shows: '  ' }), img(5, { caption: undefined }), img(6), img(7), img(8)] }, { slot: 2, images: [img(9)] }, { slot: 'x', images: [img(10)] }, null] }));
  assert.deepEqual([...parsed.bySlot.get(1)].map(p => [p.title, p.caption]), [['T1', 'C1'], ['T5', 'a thing'], ['T6', 'C6']], 'the caption follows its own image though one before it was dropped');
  assert.deepEqual([...parsed.bySlot.keys()], [1, 2]);
  assert.equal(parsed.offTopic, 2);
  assert.equal(parsed.found, 4);
  assert.equal(findImagesStep.parse('not json').found, 0);
  assert.equal(findImagesStep.version, 8);
  const prompt = findImagesStep.render({ chapter: 'q', slots: [{ index: 1, kind: 'diagram', explains: 'perspective' }], exclude: Array.from({ length: 40 }, (_, i) => `k${i}${'x'.repeat(200)}`), language: 'en', model: 'm', reasoning: 'low' });
  assert.equal(JSON.parse(/exclude list[^\[]*(\[.*\])/.exec(prompt)[1]).length, 30);
  assert.ok(!/x{121}/.test(prompt));
  assert.match(prompt, /"slot":1,"kind":"diagram","shows":"perspective"/);
});

test('slots: a single-card rerun (fresh run state) still refuses a picture another chapter already shows, even if the search ignores the exclude list', async () => {
  const r = await picRig({ titles: ['SecretRootTitle', 'SecretTitleA'], slots: 1, text: title => `${BODY} ${title}\n\n${mk(1)}\n\n尾。\n`, finder: req => found({ 1: [cand(/SecretTitleA/.test(req.chapter) ? 2 : 1)] }) });
  await run(r);
  const finder = r.ports.findImages;
  r.ports.findImages = async (request, runInfo) => { await finder(request, runInfo); return found({ 1: [cand(1)] }); };
  await r.runs.rerunCard(r.mapPath, r.nodes[1].id);
  while (r.runs.isRunning(r.mapPath)) await tick();
  await settle();
  assert.ok(!/W1\.jpg/.test((await r.note(1)).detail), 'the other chapter\'s picture is not placed again');
  assert.equal(recordOf((await r.note(1)).detail).slots[0].reasonCode, 'not_found');
});

test('slots: another chapter whose note cannot be read does not fail this chapter', async () => {
  const r = await picRig({ titles: ['SecretRootTitle', 'SecretTitleA'], slots: 1, text: title => `${BODY} ${title}\n\n${mk(1)}\n\n尾。\n`, finder: () => found({ 1: [cand(1)] }) });
  const author = r.script.author;
  let gone = false;
  r.script.author = async (input, n) => { const out = await author(input, n); gone = true; return out; };
  const read = r.ports.readCard;
  r.ports.readCard = path => (gone && path === r.nodes[1].path ? Promise.reject(new Error('deleted')) : read(path));
  await run(r);
  assert.equal(figures((await r.note(0)).detail).length, 1);
  assert.equal(stageOf(r.raw(0)), 'checked');
});

test('slots load: 5 chapters x 8 slots whose candidates all fail probe at most 36 addresses a chapter and 4 at a time, one search call each, and every card still ends checked', async () => {
  const titles = ['T0', 'T1', 'T2', 'T3', 'T4'];
  let seq = 0;
  let inflight = 0, peak = 0;
  const text = title => `${BODY} ${title}\n\n${Array.from({ length: 8 }, (_, i) => `${mk(i + 1)}\n\n段${i + 1}。`).join('\n\n')}\n`;
  const finder = req => found(Object.fromEntries(req.slots.map(s => [s.index, Array.from({ length: 4 }, () => cand(++seq))])));
  const r = await picRig({ titles, slots: 8, text, finder, probe: async () => { inflight++; peak = Math.max(peak, inflight); await tick(); await tick(); inflight--; return { ok: false, reason: 'load_failed' }; } });
  await run(r);
  assert.equal(r.calls.length, 10, 'one search per chapter and one more for the slots still without a picture');
  assert.equal(r.calls.filter(c => c.again).length, 5);
  assert.ok(r.calls.every(c => c.slots.length === 8));
  assert.ok(peak <= 4 && peak >= 2, `peak ${peak}`);
  assert.equal(r.stat.probes.length, 5 * 36, 'each chapter probes its first 36 distinct addresses; the limit covers both searches');
  for (let i = 0; i < 5; i++) { assert.equal(stageOf(r.raw(i)), 'checked'); assert.equal(recordOf((await r.note(i)).detail).slots.length, 8); }
});

test('slots: a failure after the write and before the stage change leaves pictures and one record; running again fills the new markers and replaces the record', async () => {
  const r = await picRig({ finder: () => found({ 1: [cand(1)], 2: [cand(2)] }) });
  let boom = 1;
  const wf = r.ports.writePipelineFields;
  r.ports.writePipelineFields = (path, patch) => { if (patch.pipelineStage === 'written' && boom-- > 0) return Promise.reject(new Error('stage write failed')); return wf(path, patch); };
  await r.runs.start(r.mapPath).catch(() => undefined);
  await confirmDone(r.runs, r.mapPath).catch(() => undefined);
  await settle();
  assert.notEqual(stageOf(r.raw(0)), 'written');
  assert.equal(figures((await r.note(0)).detail).length, 2, 'the filled text was committed');
  await r.runs.start(r.mapPath).catch(() => undefined);
  await confirmDone(r.runs, r.mapPath).catch(() => undefined);
  await settle();
  const detail = (await r.note(0)).detail;
  assert.equal(detail.split('book-slots:v1').length - 1, 1);
  assert.ok(!/〔圖位/.test(detail));
});

test('T1 fallback: the old picture-less card shape is unchanged by a card with a plan: a card plan without images parses as an old Prompt', () => {
  const { parseImageSlots, composeCardPrompt } = S.load('core/book-pipeline/plan-text.ts');
  const plan = { role: 'body', covers: 'c', entry: 'e', handoff: 'h', checklist: [{ id: 'C1', type: 'structure', text: 't' }] };
  assert.equal(parseImageSlots(composeCardPrompt(plan, 'zh-TW')), undefined);
  assert.equal(parseImageSlots(composeCardPrompt({ ...plan, images: [] }, 'zh-TW')).length, 0);
  assert.equal(parseImageSlots(composeCardPrompt({ ...plan, images: slotsOf(2) }, 'zh-TW')).length, 2);
});

test('slots: CRLF text is filled with CRLF lines and verifies; no marker is left', () => {
  const m = S.load('core/book-pipeline/image-slots.ts');
  const slots = [{ index: 1 }];
  const text = `前。\r\n\r\n${mk(1)}\r\n\r\n後。\r\n`;
  const fig = m.figureOf({ imageUrl: 'https://a.example/x.jpg', sourceUrl: 'https://b.example', title: 'T', caption: 'C' }, 'https://a.example/x.jpg', 'zh-TW');
  const done = m.fillSlotMarkers(text, slots, new Map([[1, { figure: fig }]]));
  assert.equal(done.text, '前。\r\n\r\n![T](https://a.example/x.jpg)\r\nC\r\n來源：b.example（[連結](https://b.example/)）\r\n\r\n後。\r\n');
  assert.equal(m.verifyFill(text, done, slots), undefined);
  const none = m.fillSlotMarkers(text, slots, new Map());
  assert.equal(m.verifyFill(text, none, slots), undefined);
  assert.ok(!/〔圖位/.test(none.text));
});

// ---- the old run's stages (R1-1): a card planned/written/checked by the old version, standard and textbook template, closed and resumed ----
// ---- T9: a program change of the text keeps the chapter "untouched" (the fingerprint follows) unless the reader's hand is on it ----
test('T9 fingerprint: filling the slots (pictures placed, or missing and their marker lines deleted) and swapping a failed body picture for the plain no-picture line all leave the chapter clean', async () => {
  for (const [name, over] of [
    ['placed', { finder: () => found({ 1: [cand(1)], 2: [cand(2)] }) }],
    ['missing', { finder: () => found({}) }],
    ['load failed', { finder: () => found({ 1: [cand(1)], 2: [cand(2)] }), probe: async () => ({ ok: false, reason: 'load_failed' }) }],
    ['a body picture that fails its probe', { slots: 1, text: () => `正文。\n\n![Body](https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Body.jpg/1280px-Body.jpg)\n\n${mk(1)}\n\n尾。\n`, finder: () => found({ 1: [cand(1)] }), probe: async url => (url.includes('Body') ? { ok: false, reason: 'load_failed' } : { ok: true }) }]
  ]) {
    const r = await picRig(over);
    await run(r);
    assert.equal(stageOf(r.raw(0)), 'checked', name);
    assert.equal(bodyStateRaw(r.raw(0)), 'clean', name);
  }
});
test('T9 fingerprint: the reader typing during the picture search is not stamped as program text (the pictures still go in, the chapter stays hand-edited)', async () => {
  let rr;
  const r = await picRig({ finder: async () => { const n = await rr.note(0); await rr.repo.updateNote(rr.nodes[0].path, { detail: n.detail.replace('正文二。', '正文二（我手改的）。') }); return found({ 1: [cand(1)], 2: [cand(2)] }); } });
  rr = r;
  await run(r);
  const detail = (await r.note(0)).detail;
  assert.ok(detail.includes('我手改的'), 'the reader\'s words are kept');
  assert.equal(figures(detail).length, 2, 'the pictures were placed');
  assert.equal(bodyState(detail), 'edited', 'the stored fingerprint was not moved to the typed text');
  assert.notEqual(readBodyRecord(detail).fp, integrityFp(detail));
});

const TEMPLATES = { standard: '## 核心結論\n舊內文。\n\n## 背景與機制\n說明。', textbook: '## 章節本文\n舊內文。\n\n## 本章小結\n說明。' };
async function reopen(r, stage, detail) {
  // a card the program left in that state carries its fingerprint (an old card without one would count as possibly hand-edited)
  await r.repo.updateNote(r.nodes[0].path, { detail: stampDetail(detail) });
  await r.repo.writePipelineFields(r.nodes[0].path, stage ? { pipelineStage: stage, pipelineIssue: null } : { pipelineStage: null });
  await r.repo.updateMap(r.mapPath, d => { d.bookPipeline.phase = 'writing'; d.bookPipeline.status = 'stopped'; delete d.bookPipeline.pauseReason; });
  const again = new BookPipelineRuns(r.ports);
  await again.resume(r.mapPath);
  while (again.isRunning(r.mapPath)) await tick();
  await settle();
  return again;
}
for (const [kind, template] of Object.entries(TEMPLATES)) {
  const old = `${template}\n\n### 圖像\n\n![Old](https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Old.jpg/1280px-Old.jpg)\nOld／來源：commons.wikimedia.org\n\n### 來源\n- https://example.com/a\n`;
  test(`old run stages, ${kind} card with an old Prompt (no image plan): planned = the author writes again with no marker or search; written = no search, the old picture section is kept; checked = nothing is redone`, async () => {
    const r = await picRig({ slots: null, text: () => `${template}\n\n### 來源\n- https://example.com/a\n`, finder: () => found({ 1: [cand(1)] }) });
    await run(r);
    const authorCalls = () => r.stat.author.length;
    // planned: the author has not committed yet (the card keeps its old text); the author runs again, no search, no record
    let before = authorCalls();
    await reopen(r, 'planned', old);
    assert.equal(authorCalls(), before + 1, 'planned: author runs');
    assert.equal(r.calls.length, 0, 'planned: no search for an old Prompt');
    assert.ok(!/book-slots|〔圖位/.test((await r.note(0)).detail));
    assert.equal(stageOf(r.raw(0)), 'checked');
    // written: the author committed; the old picture section stays word for word, no search, no record
    await r.repo.updateNote(r.nodes[0].path, { detail: stampDetail(old) });
    before = authorCalls();
    const proofs = r.stat.proof.length;
    await reopen(r, 'written', old);
    assert.equal(authorCalls(), before, 'written: no author');
    assert.equal(r.calls.length, 0, 'written: no search');
    assert.ok((await r.note(0)).detail.includes('### 圖像') && (await r.note(0)).detail.includes('Old.jpg'), 'written: old pictures kept');
    assert.ok(!/book-slots/.test((await r.note(0)).detail));
    assert.equal(stageOf(r.raw(0)), 'checked');
    assert.equal(r.stat.proof.length, proofs + 1, 'written: proof runs');
    // checked: nothing redone
    before = authorCalls();
    const calls = r.stat.proof.length;
    await reopen(r, 'checked', (await r.note(0)).detail);
    assert.equal(authorCalls(), before, 'checked: no author');
    assert.equal(r.calls.length, 0);
    assert.ok(r.stat.proof.length <= calls + 1);
    assert.equal(stageOf(r.raw(0)), 'checked');
  });
}
for (const [kind, template] of Object.entries(TEMPLATES)) {
  test(`old run stages, ${kind} card with an image plan: markers left by an interrupted run are filled on the next author pass; a written card with its pictures and record is not searched again`, async () => {
    const text = () => `${template}\n\n${mk(1)}\n\n${mk(2)}\n\n### 來源\n- https://example.com/a\n`;
    const r = await picRig({ text, finder: () => found({ 1: [cand(1)], 2: [cand(2)] }) });
    await run(r);
    assert.equal(r.calls.length, 1);
    const done = (await r.note(0)).detail;
    assert.equal(figures(done).length, 2);
    // planned with markers still in the text (closed before the fill): the author runs again and the pictures are placed once
    await reopen(r, 'planned', text());
    assert.equal(r.calls.length, 2, 'one more search');
    const again = (await r.note(0)).detail;
    assert.equal(figures(again).length, 2);
    assert.equal(again.split('book-slots:v1').length - 1, 1);
    assert.equal(stageOf(r.raw(0)), 'checked');
    // written, pictures and record in the text: the search is not repeated and the record is kept
    const authors = r.stat.author.length;
    await reopen(r, 'written', again);
    assert.equal(r.calls.length, 2, 'no search again');
    assert.equal(r.stat.author.length, authors, 'no author again');
    assert.equal((await r.note(0)).detail, again);
    assert.equal(stageOf(r.raw(0)), 'checked');
  });
}

test('proofread: the request body has no image line or caption; the result section has one 圖文 line before the model lines; a missing or off-topic picture is a notice (image notice), never needs-review', async () => {
  const text = () => `開頭。\n\nexplains perspective 的說明。\n\n${mk(1)}\n\n另一段。\n\n${mk(2)}\n\n尾。\n\n### 來源\n- https://example.com/a\n`;
  // The picture names its slot's words (a file that names none is off its text: see the off-topic test).
  const r = await picRig({ text, finder: () => found({ 1: [cand(1, { title: 'Perspective study 1' })] }) });
  await run(r);
  const body = r.stat.proof[0].body;
  assert.ok(!/!\[|Caption 1|Perspective study 1|upload\.wikimedia/.test(body), body);
  assert.match(body, /explains perspective 的說明。/);
  const raw = r.raw(0);
  const section = /> \[!vam-book\]- 校對結果[^\n]*\n((?:>[^\n]*(?:\n|$))*)/.exec(raw)?.[1] ?? '';
  const lines = section.split('\n').filter(l => l.startsWith('> - ')).map(l => l.slice(2));
  const at = lines.findIndex(l => /^- 圖文：/.test(l));
  assert.ok(at >= 0 && at === lines.length - 3, raw);
  assert.match(lines[at], /圖 2 沒找到合適的圖/);
  assert.equal(stageOf(raw), 'checked');
  assert.match((await r.note(0)).pipelineIssue ?? '', /^image notice: image_2$/);
});

test('proofread: all pictures placed next to their text: the 圖文 line says ok and the card carries no issue; an old Prompt says no image plan', async () => {
  const text = () => `開頭。\n\nexplains 1 perspective 的 explains perspective。\n\n${mk(1)}\n\n尾。\n\n### 來源\n- https://example.com/a\n`;
  const r = await picRig({ text, slots: 1, finder: () => found({ 1: [cand(1, { caption: 'A perspective drawing' })] }) });
  await run(r);
  assert.ok(!(await r.note(0)).pipelineIssue, (await r.note(0)).pipelineIssue);
  assert.match(r.raw(0), /- 圖文：?.*1/);
  const old = await picRig({ slots: null, text: () => '舊文。\n\n### 來源\n- https://example.com/a\n', finder: () => found({}) });
  await run(old);
  assert.ok(!(await old.note(0)).pipelineIssue);
  assert.match(old.raw(0), /圖/);
});

// ---- T2 review fixes -----------------------------------------------------------------------------------------------------------------
const IS = S.load('core/book-pipeline/image-slots.ts');
const figureWith = caption => IS.figureOf({ imageUrl: 'https://a.example/x.jpg', sourceUrl: 'https://b.example', title: 'T', caption }, 'https://a.example/x.jpg', 'zh-TW');
const fillOne = (text, outcomes = new Map()) => { const slots = [{ index: 1 }]; const done = IS.fillSlotMarkers(text, slots, outcomes); return { done, verdict: IS.verifyFill(text, done, slots) }; };

test('figureOf: a caption of only symbols (---, ===, - - -, ***, ___) is written as plain text and cannot turn the image line into a heading, rule or list', () => {
  for (const caption of ['---', '===', '- - -', '***', '___', '+++', '-']) {
    const fig = figureWith(caption);
    assert.ok(!/^[\s=*_+-]+$/.test(fig.caption), `${caption} -> ${fig.caption}`);
    assert.ok(fig.caption.startsWith('\\'), fig.caption);
    const { done, verdict } = fillOne(`前。\n\n${mk(1)}\n\n後。\n`, new Map([[1, { figure: fig }]]));
    assert.equal(verdict, undefined);
    const lines = done.text.split('\n');
    const at = lines.findIndex(l => l.startsWith('!['));
    assert.ok(!/^ {0,3}([-=*_+][ \t]*)+$/.test(lines[at + 1]), `caption line ${lines[at + 1]}`);
  }
  assert.equal(figureWith('Plain caption').caption, 'Plain caption');
});

test('fill: a bold-wrapped marker and a list-item marker leave no residue, whether the slot got a picture or not; verifyFill sees residue', () => {
  const cases = ['**〔圖位 1：藍光〕**', '- 〔圖位 1：藍光〕', '1. 〔圖位 1：藍光〕', '_〔圖位 1：藍光〕_'];
  for (const marker of cases) {
    const text = `前。\n\n${marker}\n\n後。\n`;
    const { done, verdict } = fillOne(text);
    assert.equal(done.text, '前。\n\n後。\n', marker);
    assert.equal(verdict, undefined, marker);
    assert.equal(done.missing.length, 1, marker);
  }
  const wrapped = fillOne('前。\n\n**〔圖位 1：藍光〕**\n\n後。\n', new Map([[1, { figure: figureWith('C') }]]));
  assert.equal(wrapped.done.placed.length, 1); assert.equal(wrapped.verdict, undefined);
  assert.ok(!/\*\*/.test(wrapped.done.text));
  // residue is caught: a result that kept the shell fails the independent check
  const original = '前。\n\n**〔圖位 1：藍光〕**\n\n後。\n';
  const sloppy = { text: '前。\n\n****\n\n後。\n', placed: [], missing: [{ index: 1, reasonCode: 'not_found' }], bad: 0, added: [] };
  assert.equal(IS.verifyFill(original, sloppy, [{ index: 1 }]), 'deleted_text');
  const bare = { text: '前。\n\n 1：藍光\n\n後。\n', placed: [], missing: [{ index: 1, reasonCode: 'not_found' }], bad: 0, added: [] };
  assert.equal(IS.verifyFill('前。\n\n〔圖位 1：藍光\n\n後。\n', bare, [{ index: 1 }]), 'deleted_text');
  const adjacent = fillOne('前。\n\n- 〔圖位 1：a〕〔圖位 2：b〕\n\n後。\n');
  assert.equal(adjacent.done.text, '前。\n\n後。\n'); assert.equal(adjacent.verdict, undefined);
});

test('fill: an unclosed marker (or a stray closing bracket) takes out only the marker text; the sentence after it stays, the slot is bad_marker, verifyFill catches a deleted sentence', () => {
  const a = fillOne('p\n\n〔圖位 1：藍光 讓人睡不著，這是重點。\n\nq');
  assert.equal(a.done.text, 'p\n\n藍光 讓人睡不著，這是重點。\n\nq'); assert.equal(a.verdict, undefined);
  assert.deepEqual(plain(a.done.missing), [{ index: 1, reasonCode: 'bad_marker' }]);
  const b = fillOne('p\n\n〔圖位 1：a〕重要句子。〕\n\nq');
  assert.equal(b.done.text, 'p\n\n重要句子。〕\n\nq'); assert.equal(b.verdict, undefined);
  const lone = fillOne('前。\n\n〔圖位 1：\n\n後。\n'); assert.equal(lone.done.text, '前。\n\n後。\n'); assert.equal(lone.verdict, undefined);
  assert.equal(fillOne('前。\n\n〔圖位 1：藍光\n\n後。\n').done.missing[0].reasonCode, 'bad_marker');
  const wiped = { text: 'p\n\nq', placed: [], missing: [{ index: 1, reasonCode: 'bad_marker' }], bad: 0, added: [] };
  assert.equal(IS.verifyFill('p\n\n〔圖位 1：藍光 讓人睡不著，這是重點。\n\nq', wiped, [{ index: 1 }]), 'deleted_text');
  assert.equal(IS.verifyFill('p\n\n〔圖位 1：a〕重要句子。〕\n\nq', wiped, [{ index: 1 }]), 'deleted_text');
});

test('figureOf: a symbol-only caption gets a backslash only when it starts with an ASCII punctuation character', () => {
  for (const caption of ['…', '→', '—', '（）', '★★★']) assert.equal(figureWith(caption).caption, caption);
  assert.equal(figureWith('---').caption, '\\---');
});

test('protectedLines: indented code (4 spaces or tab), indented fences and the lazy continuation of a quote are never filled; a marker after a normal paragraph still is', () => {
  const m = n => mk(n);
  const text = ['前。', '', `    ${m(1)}`, '', `\t${m(2)}`, '', '- 項目', '    ```', `    ${m(3)}`, '    ```', '', '> 引用', m(4), '', m(5), '', '後。'].join('\n');
  const slots = [1, 2, 3, 4, 5].map(index => ({ index }));
  const scan = IS.scanSlotMarkers(text, slots);
  assert.deepEqual([...scan.found.keys()], [5], 'only the marker line in plain text counts');
  assert.deepEqual(plain(IS.residualMarkerLines(text)).length, 1);
  const done = IS.fillSlotMarkers(text, slots, new Map([[5, { figure: figureWith('C') }]]));
  assert.ok(done.text.includes(`    ${m(1)}`) && done.text.includes(`\t${m(2)}`) && done.text.includes(`    ${m(3)}`) && done.text.includes(`\n${m(4)}\n`));
  assert.equal(IS.verifyFill(text, done, slots), undefined);
  const lazyEnds = IS.protectedLines(['> 引用', '續行', '', '正文', '> 又一個', '# 標題', '- 項']);
  assert.deepEqual(plain(lazyEnds), [true, true, false, false, true, false, false]);
});

test('stripImageLines: a sentence right after an image line is dropped as its caption only when a blank line or the end follows; a sentence that runs into the next lines stays', () => {
  const img = '![x](https://a.org/x.jpg)';
  assert.equal(IS.stripImageLines(`前。\n\n${img}\n圖說\n\n後。`), '前。\n\n後。');
  assert.equal(IS.stripImageLines(`前。\n\n${img}\n圖說`), '前。\n');
  assert.equal(IS.stripImageLines(`${img}\n1730 年是…\n接下來的正文。\n`), '1730 年是…\n接下來的正文。\n');
  assert.equal(IS.stripImageLines(`前。\n\n${img}\n圖說\n來源：a.org（[連結](https://a.org/)）\n\n後。`), '前。\n\n後。', 'the caption and its source line both leave the proof text');
});

const { findImagesStep } = require('./support-ai-calls.cjs').loadWithAiCalls('core/steps/book-pipeline/find-images.ts');
const FIG_SLOTS = [{ index: 1 }];
const fillSourced = (candidate, language = 'zh-TW') => {
  const m = S.load('core/book-pipeline/image-slots.ts');
  const fig = m.figureOf(candidate, 'https://a.example/x.jpg', language);
  return { m, fig, done: m.fillSlotMarkers(`前。\n\n${mk(1)}\n\n後。\n`, FIG_SLOTS, new Map([[1, { figure: fig }]])) };
};
const srcBase = { imageUrl: 'https://a.example/x.jpg', sourceUrl: 'https://www.b.example/page', title: 'T', caption: 'C' };

test('source line: under the caption in the book language; site from the host; author and license only when reported', () => {
  assert.equal(fillSourced(srcBase).fig.source.line, '來源：b.example（[連結](https://www.b.example/page)）');
  const full = fillSourced({ ...srcBase, author: 'Ada L.', license: 'CC BY-SA 4.0' });
  assert.equal(full.fig.source.line, '來源：b.example · 作者 Ada L. · CC BY-SA 4.0（[連結](https://www.b.example/page)）');
  assert.match(full.done.text, /!\[T\]\(https:\/\/a\.example\/x\.jpg\)\nC\n來源：b\.example · 作者 Ada L\./);
  assert.equal(full.m.verifyFill(`前。\n\n${mk(1)}\n\n後。\n`, full.done, FIG_SLOTS), undefined);
  assert.equal(fillSourced({ ...srcBase, author: 'Ada', license: 'CC0' }, 'en').fig.source.line, 'Source: b.example · by Ada · CC0 ([link](https://www.b.example/page))');
  assert.equal(fillSourced({ ...srcBase, author: '  ', license: '' }).fig.source.line, fillSourced(srcBase).fig.source.line);
  assert.equal(fillSourced({ ...srcBase, author: 'Ada' }, 'zh-CN').fig.source.line.slice(0, 3), '來源：', 'a Simplified book writes its notes in the Traditional note language');
});

test('source line: an unsafe page address gets no source line; author and license text is escaped and capped', () => {
  for (const sourceUrl of ['http://b.example/x', 'javascript:alert(1)', 'https://user:pw@b.example/x', 'not a url', `https://b.example/${'a'.repeat(1100)}`]) {
    const { fig, done } = fillSourced({ ...srcBase, sourceUrl });
    assert.equal(fig.source, undefined, sourceUrl.slice(0, 30));
    assert.ok(!/來源：/.test(done.text));
  }
  const evil = '[x](https://evil.example) <b>hi</b> > [!vam-book]- 〔圖位 2：boom〕\n# head ![i](https://evil.example/y)';
  const { fig, done } = fillSourced({ ...srcBase, author: evil, license: `${evil}${'z'.repeat(300)}` });
  const line = fig.source.line;
  assert.ok(!line.includes('\n') && !/<[A-Za-z]|〔圖位|\[!vam-book/.test(line));
  assert.ok(!/(^|[^\\])\[x\]\(/.test(line) && !/(^|[^\\])!\[/.test(line), 'no live link or image from the text');
  assert.ok(line.length < 400);
  const unsafe = S.load('experiences/visual-map/book-pipeline-run.ts').unsafeBody;
  assert.equal(unsafe(done.added.join('\n'), new Set(['https://a.example/x.jpg'])), false, 'the exit check accepts the written lines');
  const paren = fillSourced({ ...srcBase, sourceUrl: 'https://b.example/a_(b)' }).fig.source.line;
  assert.ok(paren.endsWith('(https://b.example/a_%28b%29)）'));
});

test('find-images parse: author and license are kept as short one-line text only when given', () => {
  const item = (n, over = {}) => ({ title: `T${n}`, shows: 's', caption: 'c', relevant: true, imageUrl: `https://a.org/${n}.jpg`, sourceUrl: 'https://b.org/p', ...over });
  const parsed = findImagesStep.parse(JSON.stringify({ slots: [{ slot: 1, images: [item(1, { author: ' Ada\n  Lovelace ', license: 'CC BY 4.0' }), item(2), item(3, { author: 5, license: 'x'.repeat(500) })] }] }));
  const [a, b, c] = parsed.bySlot.get(1);
  assert.equal(a.author, 'Ada Lovelace'); assert.equal(a.license, 'CC BY 4.0');
  assert.ok(!('author' in b) && !('license' in b));
  assert.ok(!('author' in c)); assert.equal(c.license.length, 100);
});

test('find-images prompt: asks for optional author and license, and says a caption never describes what a picture lacks', () => {
  const prompt = findImagesStep.render({ chapter: 'q', slots: [{ index: 1, kind: 'diagram', explains: 'p' }], exclude: [], language: 'en', model: 'm', reasoning: 'low' });
  assert.match(prompt, /"author":"creator name","license":"license name"/);
  assert.match(prompt, /never write a sentence about what the picture lacks or does not show/);
  assert.match(prompt, /Never guess or invent an author or a license/);
});

test('slots run: the sources of the placed pictures join the card\'s Sources section once, the author\'s own lines stay; a second fill adds nothing', async () => {
  const r = await picRig({ finder: () => found({ 1: [cand(1, { author: 'Ada', license: 'CC0' })], 2: [cand(2, { source: 'https://commons.wikimedia.org/wiki/File:W1.jpg' })] }) });
  await run(r);
  const detail = (await r.note(0)).detail;
  assert.match(detail, /來源：commons\.wikimedia\.org · 作者 Ada · CC0（\[連結\]/);
  const section = detail.slice(detail.indexOf('### 來源'));
  assert.equal(section.split('commons.wikimedia.org/wiki/File:W1.jpg').length - 1, 1, 'two pictures of one page: one entry');
  assert.match(section, /^### 來源\n- https:\/\/example\.com\/a\n- 圖「Work 1」：commons\.wikimedia\.org · 作者 Ada · CC0（/);
  assert.equal(S.load('core/book-pipeline/note-sections.ts').addPictureSources(detail, [{ href: 'https://commons.wikimedia.org/wiki/File:W1.jpg', entry: 'again' }], 'zh-TW'), detail);
  assert.ok(!/〔圖位/.test(detail));
});


test('slots: a card removed from the map while the search ran is not written, and its claimed pictures are not held', async () => {
  const r = await picRig({ slots: 1, text: () => `${BODY}\n\n${mk(1)}\n\n尾。\n`, finder: () => found({ 1: [cand(1)] }) });
  const readMap = r.ports.readMap;
  let removed = false;
  const search = r.ports.findImages;
  r.ports.findImages = async (request, runInfo) => { const out = await search(request, runInfo); removed = true; return out; };
  r.ports.readMap = async path => { const map = await readMap(path); return removed ? { ...map, nodes: map.nodes.filter(node => node.id !== r.nodes[0].id) } : map; };
  await run(r);
  const detail = (await r.note(0)).detail;
  assert.ok(detail.includes(mk(1)) && !/!\[|book-slots/.test(detail), 'nothing was written to the removed card: marker kept, no picture, no record');
  assert.notEqual(stageOf(r.raw(0)), 'checked');
});

test('slots: candidates left unprobed by the per-chapter limit end probe_capped (not load_failed); an adjacent pair on one line is bad_marker (not author_omitted)', async () => {
  const text = title => `${BODY}\n\n${Array.from({ length: 12 }, (_, i) => `${mk(i + 1)}\n\n段${i + 1}。`).join('\n\n')}\n`;
  let seq = 0;
  const finder = req => found(Object.fromEntries(req.slots.map(s => [s.index, Array.from({ length: 4 }, () => cand(++seq))])));
  const r = await picRig({ slots: 12, text, finder, probe: async () => ({ ok: false, reason: 'load_failed' }) });
  await run(r);
  const reasons = recordOf((await r.note(0)).detail).slots.map(s => s.reasonCode);
  assert.deepEqual(reasons, [...Array(9).fill('load_failed'), 'probe_capped', 'probe_capped', 'probe_capped'], '12 slots x 4 candidates: the first 36 addresses (9 slots) are probed');
  assert.match(r.stat.logs.join('\n'), /reason=load_failed,probe_capped|reason=probe_capped/);
  const pair = await picRig({ slots: 2, text: () => `${BODY}\n\n${mk(1)}${mk(2)}\n\n尾。\n`, finder: () => found({}) });
  await run(pair);
  assert.deepEqual(recordOf((await pair.note(0)).detail).slots.map(s => s.reasonCode), ['bad_marker', 'bad_marker']);
});

test('images: the find-images prompt asks for captions in the book language; a Chinese book repeats the ask once for an English caption and empties one still wrong', async () => {
  const { findImagesStep, runFindImages } = require('./support-ai-calls.cjs').loadWithAiCalls('core/steps/book-pipeline/find-images.ts');
  const base = { chapter: '巴夫洛夫與制約', slots: [{ index: 1, kind: 'diagram', explains: 'x' }], model: 'm', reasoning: 'low' };
  assert.match(findImagesStep.render({ ...base, language: 'zh-TW' }), /Traditional Chinese|繁體|zh/i);
  assert.match(findImagesStep.render({ ...base, language: 'zh-TW' }), /caption" in the language of the book/);
  assert.ok(!/not in the book's language/.test(findImagesStep.render({ ...base, language: 'zh-TW' })));
  assert.match(findImagesStep.render({ ...base, language: 'zh-TW', languageRetry: true }), /not in the book's language/);
  const reply = caption => JSON.stringify({ slots: [{ slot: 1, images: [{ title: 'T', caption, imageUrl: 'https://upload.wikimedia.org/a/ab/F.jpg', sourceUrl: 'https://commons.wikimedia.org/wiki/File:F.jpg', kind: 'diagram', shows: 'a thing', relevant: true }] }] });
  const rig = replies => { const prompts = []; return { prompts, aiCalls: { run: async (prepared, _o, parse) => { prompts.push(prepared.prompt); return parse(replies.shift()); } } }; };
  const run = { signal: new AbortController().signal };
  let r = rig([reply('This schematic lays out the procedure'), reply('示意圖：鈴聲與食物配對')]);
  let out = await runFindImages(r.aiCalls, { ...base, language: 'zh-TW' }, run);
  assert.equal(r.prompts.length, 2); assert.equal(out.bySlot.get(1)[0].caption, '示意圖：鈴聲與食物配對');
  r = rig([reply('English only'), reply('Still English')]);
  out = await runFindImages(r.aiCalls, { ...base, language: 'zh-TW' }, run);
  assert.equal(r.prompts.length, 2); assert.equal(out.bySlot.get(1)[0].caption, '');
  r = rig([reply('English only')]);
  out = await runFindImages(r.aiCalls, { ...base, language: 'en' }, run);
  assert.equal(r.prompts.length, 1); assert.equal(out.bySlot.get(1)[0].caption, 'English only');
  r = rig([reply('圖說')]);
  await runFindImages(r.aiCalls, { ...base, language: 'zh-TW' }, run);
  assert.equal(r.prompts.length, 1);
});

// ---- T4 (P4b): a second search for the slots still without a picture, and the finder's sentence in place of a picture ----
test('T4 images: a slot the first search left empty is searched once more (another direction, tried addresses excluded) and gets its picture', async () => {
  const r = await picRig({ finder: (req, run, n) => (n === 1 ? found({ 1: [cand(1)], 2: [] }) : found({ 2: [cand(2)] })) });
  await run(r);
  assert.equal(r.calls.length, 2);
  assert.equal(r.calls[0].again, undefined);
  assert.equal(r.calls[1].again, true);
  assert.deepEqual(plain(r.calls[1].slots.map(s => s.index)), [2], 'only the slot still without a picture');
  assert.ok(r.calls[1].exclude.some(key => /w1/i.test(key)), 'what the first search offered is excluded');
  const detail = (await r.note(0)).detail;
  assert.equal(figures(detail).length, 2);
  assert.match(detail, /!\[Work 2\]/);
  assert.deepEqual(plain(recordOf(detail).slots.map(s => [s.index, s.state])), [[1, 'placed'], [2, 'placed']]);
  assert.equal(stageOf(r.raw(0)), 'checked');
});

test('T4 images: when every slot has its picture there is no second search; a search that failed is not asked again', async () => {
  const a = await picRig({ finder: () => found({ 1: [cand(1)], 2: [cand(2)] }) });
  await run(a);
  assert.equal(a.calls.length, 1);
  const b = await picRig({ finder: () => { throw new Error('provider down'); } });
  await run(b);
  assert.equal(b.calls.length, 1, 'an error is an optional gain lost, not a reason to ask twice');
  assert.equal(stageOf(b.raw(0)), 'checked');
});

test('T4 images: the automatic redo of a card edits it in place: its placed picture stays and no new search runs', async () => {
  const checklist = [{ id: 'C1', type: 'structure', text: 'has a beginning' }, { id: 'C2', type: 'fact', text: 'a date' }];
  let proofs = 0;
  const r = await picRig({ checklist, slots: 1,
    text: (title, input) => input.requirements !== undefined ? `@@replace\n正文一。${title}\n@@with\n正文一（更正）。${title}` : `正文一。${title}\n\n${mk(1)}\n\n正文二。`,
    finder: () => found({ 1: [cand(1)] }),
    proof: async request => evaluateProof(request.checklist.map(c => ({ id: c.id, status: c.type === 'fact' && !/FillerChapter/.test(request.body) && ++proofs === 1 ? 'unmet' : 'met', note: 'n', sources: c.type === 'fact' ? ['https://example.org/p'] : [] })), request.checklist, ['https://example.org/p']) });
  await run(r);
  assert.equal(r.calls.length, 1, 'only the first round searched');
  const detail = (await r.note(0)).detail;
  assert.equal(figures(detail).length, 1, 'the redo keeps the picture');
  assert.ok(detail.includes('正文一（更正）。') && detail.includes('正文二。'), 'the corrected line is in, the rest stays');
});

test('slots: a card deleted from the map during the picture search pauses the run for the map, writes no picture and is not sent to review', async () => {
  const dropped = [];
  const r = await picRig({ titles: ['SecretRootTitle', 'SecretChapterY'], finder: async request => {
    if (/SecretChapterY/.test(request.chapter) && !dropped.length) {
      dropped.push(r.nodes[1].id);
      await r.repo.updateMap(r.mapPath, d => { d.nodes = d.nodes.filter(n => n.id !== r.nodes[1].id); });
    }
    return found({ 1: [cand(1)], 2: [cand(2)] });
  } });
  await r.runs.start(r.mapPath);
  await r.runs.confirmGate1(r.mapPath);
  while (r.runs.isRunning(r.mapPath)) await tick();
  await settle();
  const s = await r.state();
  assert.equal(s.pauseReason, 'map');
  assert.deepEqual(plain(s.changed.missing), dropped);
  const gone = r.nodes.findIndex(n => n.id === dropped[0]);
  assert.equal(figures((await r.note(gone)).detail).length, 0, 'no picture written for the deleted card');
  for (let i = 0; i < r.nodes.length; i++) assert.notEqual(stageOf(r.raw(i)), 'needs-review');
  assert.ok(!/SecretChapterY|SecretRootTitle/.test(JSON.stringify(r.stat.logs)), 'no title in the log');
});

// ---- picture quality (full-run bugs 2-5): the subject rule, the file-page source rule, the same work under two file names ----
const Q = S.load('core/book-pipeline/image-quality.ts');
const commons = name => `https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/${encodeURIComponent(name)}/1280px-${encodeURIComponent(name)}`;

test('quality source: an article-page source becomes the file page and loses the credits read off the article; a file page stays; an underivable wiki page drops the picture', () => {
  const base = { title: 't', caption: 'c', author: 'X', license: 'CC BY 4.0' };
  const moved = Q.fileSourceOf({ ...base, url: commons('Tree_bud_at_f22.jpg'), source: 'https://en.wikipedia.org/wiki/Depth_of_field' });
  assert.equal(moved.source, 'https://commons.wikimedia.org/wiki/File:Tree_bud_at_f22.jpg');
  assert.ok(!('author' in moved) && !('license' in moved), 'credits from an article page are not kept');
  const local = Q.fileSourceOf({ ...base, url: 'https://upload.wikimedia.org/wikipedia/en/a/ab/Poster (1).jpg', source: 'https://en.wikipedia.org/wiki/Film' });
  assert.equal(local.source, 'https://en.wikipedia.org/wiki/File:Poster_(1).jpg', 'a local file gets its own wiki\'s file page');
  const thumbHost = Q.fileSourceOf({ ...base, url: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/b/bc/Sir_Winston_Churchill_-_19086236948.jpg/330px-Sir_Winston_Churchill_-_19086236948.jpg', source: 'https://en.wikipedia.org/wiki/The_Roaring_Lion' });
  assert.equal(thumbHost.source, 'https://commons.wikimedia.org/wiki/File:Sir_Winston_Churchill_-_19086236948.jpg');
  const filePage = { ...base, url: commons('Rule_of_thirds_photo.jpg'), source: 'https://en.wikipedia.org/wiki/File:Rule_of_thirds_photo.jpg' };
  assert.equal(Q.fileSourceOf(filePage), filePage, 'a file page (any wiki) keeps its credits');
  const blog = Q.fileSourceOf({ ...base, url: commons('A.jpg'), source: 'https://blog.example/post' });
  assert.equal(blog.source, 'https://commons.wikimedia.org/wiki/File:A.jpg', 'a Commons image shown on another page still cites its file page');
  assert.equal(Q.fileSourceOf({ ...base, url: 'https://img.example/a.jpg', source: 'https://en.wikipedia.org/wiki/Exposure' }), undefined, 'a wiki article for a non-wiki image: no file page, the picture goes');
  const other = { ...base, url: 'https://img.example/a.jpg', source: 'https://museum.example/object/1' };
  assert.equal(Q.fileSourceOf(other), other, 'other sites are kept as they are');
});

test('quality subject: a position about a named person keeps only that person\'s works (author first, else the file name); no subject keeps everything', () => {
  const c = (name, author) => ({ title: 'title', url: commons(name), ...(author ? { author } : {}) });
  const cameron = 'Julia Margaret Cameron';
  assert.equal(Q.bySubject(c('Charles_Darwin_by_Julia_Margaret_Cameron,_c._1868.jpg', 'Julia Margaret Cameron (1815–1879)'), cameron), true);
  assert.equal(Q.bySubject(c('Autoportraits_de_Félix_Nadar.jpg', 'Nadar'), cameron), false, 'Nadar self-portrait in the Cameron chapter');
  assert.equal(Q.bySubject(c('Moonrise,_Hernandez,_New_Mexico.jpg', 'Ansel Adams'), 'Ansel Adams'), true);
  assert.equal(Q.bySubject(c('Moonrise,_Hernandez,_New_Mexico.jpg'), 'Ansel Adams'), false, 'no author and the file does not name him: not shown to be his');
  assert.equal(Q.bySubject(c('Portrait_of_Ansel_Adams_by_J._Malcolm_Greany.jpg'), 'Ansel Adams'), false, 'a portrait of the person by someone else');
  assert.equal(Q.bySubject(c('Ansel_Adams_-_Tetons_and_Snake_River.jpg'), 'Ansel Adams'), true);
  assert.equal(Q.bySubject(c('X.jpg', 'Henri Cartier-Bresson'), 'Henri Cartier-Bresson'), true);
  assert.equal(Q.bySubject(c('Feynman_Technique.svg', 'WiredAlexandria'), ''), true, 'no subject: the rule does not apply');
  assert.equal(Q.bySubject(c('Flowchart.svg', 'Someone Adamsson'), 'Ansel Adams'), false, 'the last name is matched as a whole word');
  assert.equal(Q.bySubject({ title: '卡梅隆的丁尼生肖像', url: commons('T.jpg') }, '卡梅隆'), true, 'a subject in another script is matched as a whole name, the title included');
  assert.equal(Q.bySubject({ title: '納達爾自拍像', url: commons('T.jpg') }, '卡梅隆'), false);
  assert.equal(Q.bySubject(c('X.jpg', '  '), ''), true, 'a blank subject is no subject');
});

test('quality work key: the same work under two Commons files by one author is one work; another author, another subject or no author is not', () => {
  const a = Q.workKey(commons('Sir_Winston_Churchill_(cropped).jpg'), 'Yousuf Karsh');
  assert.ok(a);
  assert.equal(Q.workKey('https://thumb.wikimedia.org/wikipedia/commons/thumb/b/bc/Sir_Winston_Churchill_-_19086236948.jpg/330px-Sir_Winston_Churchill_-_19086236948.jpg', 'Yousuf  Karsh'), a);
  assert.notEqual(Q.workKey(commons('Sir_Winston_Churchill.jpg'), 'Someone Else'), a);
  assert.notEqual(Q.workKey(commons('Kew_fountain_(short_exposure).jpg'), 'P'), Q.workKey(commons('Kew_fountain_(long_exposure).jpg'), 'P'));
  assert.equal(Q.workKey(commons('Sir_Winston_Churchill.jpg'), undefined), undefined);
  assert.equal(Q.workKey(commons('A.jpg'), 'P'), undefined, 'a stem too short to tell works apart');
});

test('quality parse: the finder\'s subject refuses another person\'s work (counted off-topic); an article-page source is replaced by the file page', () => {
  const { findImagesStep } = require('./support-ai-calls.cjs').loadWithAiCalls('core/steps/book-pipeline/find-images.ts');
  const img = (name, extra) => ({ title: name, caption: 'c', shows: 's', relevant: true, imageUrl: commons(name), sourceUrl: `https://commons.wikimedia.org/wiki/File:${name}`, ...extra });
  const parsed = findImagesStep.parse(JSON.stringify({ slots: [
    { slot: 1, subject: 'Julia Margaret Cameron', images: [img('Autoportrait_Nadar.jpg', { author: 'Nadar' }), img('Tennyson_by_Julia_Margaret_Cameron.jpg', { author: 'Julia Margaret Cameron' })] },
    { slot: 2, images: [img('ISO_comparison.jpg', { sourceUrl: 'https://en.wikipedia.org/wiki/Image_noise', author: 'A', license: 'L' }), img('Q.jpg', { imageUrl: 'https://img.example/q.jpg', sourceUrl: 'https://en.wikipedia.org/wiki/Exposure' })] }
  ] }));
  assert.deepEqual(plain(parsed.bySlot.get(1).map(i => i.title)), ['Tennyson_by_Julia_Margaret_Cameron.jpg']);
  const [iso] = parsed.bySlot.get(2);
  assert.equal(iso.source, 'https://commons.wikimedia.org/wiki/File:ISO_comparison.jpg');
  assert.ok(!iso.author && !iso.license);
  assert.equal(parsed.bySlot.get(2).length, 1);
  assert.equal(parsed.offTopic, 2);
  assert.equal(parsed.found, 2);
  const prompt = findImagesStep.render({ chapter: 'q', slots: [{ index: 1, kind: 'photo', explains: 'p' }], exclude: [], language: 'en', model: 'm', reasoning: 'low', again: true });
  assert.match(prompt, /"subject":""/); assert.match(prompt, /Category:<name>/); assert.match(prompt, /file description page/); assert.match(prompt, /never an article/);
  assert.match(prompt, /second search[^\n]*Commons category and its subcategories/);
});

test('quality choose: within a chapter the same work is placed once (the next candidate fills the slot); a work another chapter claimed is taken', () => {
  const { choosePictures } = S.load('core/book-pipeline/image-slots.ts');
  const slots = slotsOf(2);
  const probed = (name, author) => ({ candidate: { imageUrl: commons(name), sourceUrl: `https://commons.wikimedia.org/wiki/File:${name}`, title: name, caption: 'c', author }, href: commons(name), loaded: true });
  const per = new Map([[1, [probed('Sir_Winston_Churchill_(cropped).jpg', 'Yousuf Karsh')]], [2, [probed('Sir_Winston_Churchill_-_19086236948.jpg', 'Yousuf Karsh'), probed('Audrey_Hepburn_Karsh.jpg', 'Yousuf Karsh')]]]);
  const out = choosePictures({ id: 'n', title: 'T' }, slots, per, () => false, 'en');
  assert.match(out.get(1).figure.href, /cropped/);
  assert.match(out.get(2).figure.href, /Audrey/);
  assert.ok(out.get(1).figure.work.startsWith('work:'));
  const work = Q.workKey(commons('Sir_Winston_Churchill_(cropped).jpg'), 'Yousuf Karsh');
  const taken = choosePictures({ id: 'n', title: 'T' }, slots.slice(0, 1), new Map([[1, [probed('Sir_Winston_Churchill_-_19086236948.jpg', 'Yousuf Karsh')]]]), key => key === work, 'en');
  assert.equal(taken.get(1).reasonCode, 'not_found');
});

test('quality run: two chapters offered the same work as two Commons files place it once; the chapter that placed it may show it again on its redo', async () => {
  const churchill = title => /SecretTitleA/.test(title) ? 'Sir_Winston_Churchill_-_19086236948.jpg' : 'Sir_Winston_Churchill_(cropped).jpg';
  const r = await picRig({ titles: ['SecretRootTitle', 'SecretTitleA'], slots: 1, text: title => `${BODY} ${title}\n\n${mk(1)}\n\n尾。\n`,
    finder: req => { const name = churchill(req.chapter); return found({ 1: [cand(0, { url: commons(name), source: `https://commons.wikimedia.org/wiki/File:${name}`, author: 'Yousuf Karsh' })] }); } });
  await run(r);
  assert.equal((await embedded(r, 2)).length, 1, 'one Churchill portrait in the whole book');
  const states = [(await r.note(0)).detail, (await r.note(1)).detail].map(d => recordOf(d).slots[0]);
  assert.deepEqual(states.map(s => s.state).sort(), ['missing', 'placed']);
  const owner = states[0].state === 'placed' ? 0 : 1;
  await r.runs.rerunCard(r.mapPath, r.nodes[owner].id);
  while (r.runs.isRunning(r.mapPath)) await tick();
  await settle();
  assert.equal(figures((await r.note(owner)).detail).length, 1, 'its own work is not taken from itself');
});

// ---- the program's own Commons search for slots still empty, and the picture shortfall verdict ----
const C = S.load('core/book-pipeline/commons-search.ts');
/** A Commons API answer (formatversion 2) for files `names` in search order; `over` per file overrides imageinfo fields; `categories` is every file's category line. */
const commonsAnswer = (names, over = {}, categories = '') => JSON.stringify({ query: { pages: names.map((name, i) => ({ index: i + 1, title: `File:${name}`, imageinfo: [{
  url: `https://upload.wikimedia.org/wikipedia/commons/a/ab/${name}`,
  thumburl: `https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/${name}/1280px-${name}`,
  mime: 'image/jpeg', thumbmime: 'image/jpeg',
  descriptionurl: `https://commons.wikimedia.org/wiki/File:${name}`,
  extmetadata: { Artist: { value: '<a href="//commons.wikimedia.org/wiki/User:Ann">Ann &amp; Bo</a>' }, LicenseShortName: { value: 'CC BY-SA 4.0' }, ...(categories ? { Categories: { value: categories } } : {}) },
  ...(over[name] ?? {}) }] })) } });
const queryOf = url => new URL(url).searchParams.get('gsrsearch').replace(/ filetype:bitmap$/, '');

test('commons parse: safe types only (an SVG through its PNG thumbnail), https, the file page as source, plain credits, the subject rule', () => {
  const slot = { index: 1, explains: '葉背的蚜蟲', search: 'aphids leaf' };
  const text = commonsAnswer(['Aphids.jpg', 'Scan.tif', 'Drawing.svg', 'Plain.png', 'Http.jpg'], {
    'Scan.tif': { mime: 'image/tiff', thumbmime: 'image/tiff' },
    'Drawing.svg': { mime: 'image/svg+xml', thumbmime: 'image/png', thumburl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Drawing.svg/1280px-Drawing.svg.png' },
    'Plain.png': { thumburl: undefined, url: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Plain.png', mime: 'image/png', thumbmime: undefined },
    'Http.jpg': { thumburl: 'http://upload.wikimedia.org/x/Http.jpg' }
  }, 'Aphids on leaves');
  const got = C.parseCommonsAnswer(text, slot);
  assert.deepEqual(plain(got.map(c => c.title)), ['Aphids', 'Drawing', 'Plain']);
  assert.equal(got[0].source, 'https://commons.wikimedia.org/wiki/File:Aphids.jpg');
  assert.equal(got[0].author, 'Ann & Bo');
  assert.equal(got[0].license, 'CC BY-SA 4.0');
  assert.equal(got[0].caption, '葉背的蚜蟲', 'the slot line is the caption; the program writes none of its own');
  assert.deepEqual(plain(C.parseCommonsAnswer(text, { ...slot, subject: 'Dorothea Lange' })), [], 'another author is refused for a named person');
  assert.deepEqual(plain(C.parseCommonsAnswer('not json', slot)), []);
  assert.deepEqual(plain(C.parseCommonsAnswer('{"batchcomplete":true}', slot)), [], 'no hits');
});

test('commons search: the finder\'s English words first, the slot line next only when the ones before gave nothing; at most 3 requests a slot, 3 candidates', async () => {
  const asked = [];
  const fetch = async url => { asked.push(url); const q = queryOf(url); return { status: 200, text: q === 'aphids leaf' ? '{}' : commonsAnswer(['A1.jpg', 'A2.jpg', 'A3.jpg', 'A4.jpg'], {}, 'Aphids on a leaf|Drip irrigation') }; };
  const ctl = new AbortController();
  const out = await C.searchCommons([
    { index: 1, explains: '葉背的蚜蟲', search: 'aphids leaf' },
    { index: 2, explains: '滴灌', search: 'drip irrigation' },
    { index: 3, explains: '堆肥' }
  ], fetch, { signal: ctl.signal, skip: url => /A1\.jpg/.test(url) });
  assert.deepEqual(asked.map(queryOf), ['aphids leaf', '葉背的蚜蟲', 'drip irrigation', '堆肥']);
  assert.ok(asked.every(url => url.startsWith(`${C.COMMONS_API}?`) && /gsrnamespace=6/.test(url)), 'files only, the one API address');
  assert.equal(out.requests, 4);
  assert.deepEqual(plain(out.bySlot.get(2).map(c => c.title)), ['A2', 'A3', 'A4'], 'skipped addresses are left out; at most 3');
  assert.deepEqual(plain(C.commonsQueries({ index: 1, explains: 'x "y" | z', search: 'x "y" | z' })), ['x y z'], 'one line, no duplicate query');
});

test('commons search: a request that fails, answers non-200, never answers or runs past the chapter deadline ends quietly; a Stop asks nothing more', async () => {
  const ctl = new AbortController();
  let n = 0;
  const failing = async () => { n++; if (n === 1) throw new Error('offline'); return { status: 503, text: '' }; };
  const a = await C.searchCommons([{ index: 1, explains: 'x', search: 'y' }], failing, { signal: ctl.signal, skip: () => false });
  assert.equal(a.bySlot.size, 0); assert.equal(a.requests, 2);
  const sync = await C.searchCommons([{ index: 1, explains: 'x' }], () => { throw new Error('sync'); }, { signal: ctl.signal, skip: () => false });
  assert.equal(sync.bySlot.size, 0, 'a fetch that throws at once is a failed request too');
  let clock = 0;
  const b2 = await C.searchCommons([{ index: 1, explains: 'x' }, { index: 2, explains: 'y' }], async () => { clock += C.COMMONS_CHAPTER_MS; return { status: 200, text: '{}' }; }, { signal: ctl.signal, skip: () => false, now: () => clock });
  assert.equal(b2.requests, 1, 'no new request after the chapter deadline');
  const stop = new AbortController();
  let started; const asked = new Promise(resolve => { started = resolve; });
  const hang = C.searchCommons([{ index: 1, explains: 'x' }, { index: 2, explains: 'y' }], () => { started(); return new Promise(() => {}); }, { signal: stop.signal, skip: () => false });
  await asked;
  stop.abort();
  const c = await hang;
  assert.equal(c.requests, 1); assert.equal(c.bySlot.size, 0);
});

test('find-images: the finder gives English Commons search words per position (also with no image), kept as a hint with the subject', () => {
  const { findImagesStep } = require('./support-ai-calls.cjs').loadWithAiCalls('core/steps/book-pipeline/find-images.ts');
  const parsed = findImagesStep.parse(JSON.stringify({ slots: [{ slot: 1, subject: 'Ansel Adams', search: ' Moon and\nHalf Dome ', images: [] }, { slot: 2, search: 'x'.repeat(300) }, { slot: 3, images: [] }] }));
  assert.deepEqual(plain(parsed.hints.get(1)), { subject: 'Ansel Adams', search: 'Moon and Half Dome' });
  assert.equal(parsed.hints.get(2).search.length, 80);
  assert.equal(parsed.hints.has(3), false);
  const prompt = findImagesStep.render({ chapter: 'q', slots: [{ index: 1, kind: 'diagram', explains: 'p' }], exclude: [], language: 'en', model: 'm', reasoning: 'low' });
  assert.match(prompt, /"search" is 2 to 5 English words that a Wikimedia Commons file search would match/);
});

test('find-images: the search budget grows with the slots (about 1.5 a slot, at least 4, at most 18) so each slot can be searched', async () => {
  const { runFindImages, findImagesSearchBudget } = require('./support-ai-calls.cjs').loadWithAiCalls('core/steps/book-pipeline/find-images.ts');
  assert.deepEqual([0, 1, 2, 3, 6, 8, 9, 12, 40].map(findImagesSearchBudget), [4, 4, 4, 5, 9, 12, 14, 18, 18]);
  const budgets = [];
  const aiCalls = { run: async (prepared, options, parse) => { budgets.push(options.task.searchBudget); return parse('{"slots":[]}'); } };
  const slots = Array.from({ length: 9 }, (_, i) => ({ index: i + 1, kind: 'diagram', explains: `p${i}` }));
  await runFindImages(aiCalls, { chapter: 'q', slots, exclude: [], language: 'en', model: 'm', reasoning: 'low' }, { signal: new AbortController().signal });
  await runFindImages(aiCalls, { chapter: 'q', slots: slots.slice(0, 2), exclude: [], language: 'en', model: 'm', reasoning: 'low' }, { signal: new AbortController().signal });
  assert.deepEqual(budgets, [14, 4]);
});

test('repro v2: slots the finder left empty are filled from Commons (finder words first), probed and credited like any picture; no model call is added', async () => {
  const asked = [];
  const r = await picRig({
    finder: (req, run, n) => n === 1 ? { ...found({ 1: [cand(1)], 2: [] }), hints: new Map([[2, { search: 'drip irrigation' }]]) } : found({}),
    ports: { fetchCommons: async url => { asked.push(queryOf(url)); return { status: 200, text: commonsAnswer(['Drip_irrigation.jpg']) }; } }
  });
  await run(r);
  assert.equal(r.calls.length, 2, 'the two finder calls only');
  assert.equal(asked[0], 'drip irrigation');
  const detail = (await r.note(0)).detail;
  assert.equal(figures(detail).length, 2);
  assert.match(detail, /!\[Drip irrigation\]\(https:\/\/upload\.wikimedia\.org\/wikipedia\/commons\/thumb\/a\/ab\/Drip_irrigation\.jpg\/1280px-Drip_irrigation\.jpg\)\nexplains 2 perspective\n來源：commons\.wikimedia\.org · 作者 Ann & Bo · CC BY-SA 4\.0（\[連結\]\(https:\/\/commons\.wikimedia\.org\/wiki\/File:Drip_irrigation\.jpg\)）/);
  assert.ok(r.stat.probes.some(u => /Drip_irrigation/.test(u)), 'probed like the finder\'s candidates');
  assert.deepEqual(plain(recordOf(detail).slots.map(s => [s.index, s.state])), [[1, 'placed'], [2, 'placed']]);
  assert.match(r.stat.logs.join('\n'), /slots .* commons=1/);
});

test('commons fallback: a picture another chapter shows is not taken again; a failing Commons leaves the slot not_found and the chapter as before', async () => {
  const r = await picRig({ finder: () => found({ 1: [cand(1)], 2: [] }), ports: { fetchCommons: async () => { throw new Error('offline'); } } });
  await run(r);
  const detail = (await r.note(0)).detail;
  assert.deepEqual(plain(recordOf(detail).slots.map(s => [s.index, s.state, s.reasonCode ?? ''])), [[1, 'placed', ''], [2, 'missing', 'not_found']]);
  assert.equal(stageOf(r.raw(0)), 'checked', 'no picture setting: a missing picture stays a notice');
  assert.match(r.stat.logs.join('\n'), /slots .* commons_nohint=1/, 'a slot without English search words is counted');
  const twice = await picRig({ titles: ['SecretRootTitle', 'SecondChapter'], finder: () => found({}), ports: { fetchCommons: async () => ({ status: 200, text: commonsAnswer(['Same.jpg'], {}, 'Perspective drawings that explains') }) } });
  await run(twice);
  const all = [...figures((await twice.note(0)).detail), ...figures((await twice.note(1)).detail)].filter(f => /Same\.jpg/.test(f));
  assert.equal(all.length, 1, 'one Commons file is placed once in the book');
});

test('shortfall: under the owner\'s minimum the chapter ends needs-review with a plain reason, counts for review and gets no rewrite; enough pictures stay checked', async () => {
  const r = await picRig({ finder: () => found({ 1: [cand(1)] }) });
  await r.repo.writeBookSettings(r.nodes[0].path, { style: '每章圖片 2 張' });
  await run(r);
  assert.equal(stageOf(r.raw(0)), 'needs-review');
  const issue = (await r.note(0)).pipelineIssue;
  assert.match(issue, /^images unmet: images:under:1:2 image_2( image_1_mismatch)?$/);
  assert.equal(r.stat.author.filter(id => id === r.nodes[0].id).length, 1, 'no automatic rewrite for too few pictures');
  const review = S.load('experiences/visual-map/book-pipeline-review.ts');
  assert.equal(review.reasonOf(issue, undefined), 'Too few pictures: 1 placed, the setting asks for at least 2', 'test locale is en');
  const both = review.reasonOf('proof unmet: facts_unverified images:under:0:6', undefined);
  assert.ok(both.startsWith(review.reasonOf('proof unmet: facts_unverified', undefined)) && both.endsWith('Too few pictures: 0 placed, the setting asks for at least 6'), both);
  const ui = S.load('experiences/visual-map/book-pipeline-ui.ts');
  assert.match(ui.bookIssueText('length unmet: length:under:10:100-200:字:v1 images:under:1:6 image_2'), /^\S.*\S\s+Too few pictures: 1 placed, the setting asks for at least 6$/);
  const ok = await picRig({ finder: () => found({ 1: [cand(1)], 2: [cand(2)] }) });
  await ok.repo.writeBookSettings(ok.nodes[0].path, { style: '每章圖片 2 張' });
  await run(ok);
  assert.equal(stageOf(ok.raw(0)), 'checked');
  assert.ok(!/images:under|images unmet/.test((await ok.note(0)).pipelineIssue ?? ''), 'no shortfall (picture notices may remain)');
});

// ---- repro v3: Commons filled 29 of 41 slots with PDF / scan first pages whose plan captions had nothing to do with the picture ----
/** Encoded as Commons writes it (brackets too, as in the v3 addresses). */
const v3Enc = file => encodeURIComponent(file).replace(/\(/g, '%28').replace(/\)/g, '%29');
const v3Thumb = (hash, file, width = 960) => `https://thumb.wikimedia.org/wikipedia/commons/thumb/${hash[0]}/${hash}/${v3Enc(file)}/page1-${width}px-${v3Enc(file)}.jpg?utm_source=commons.wikimedia.org`;
const V3_DOCS = {
  swatow: ['2c', 'A_pronouncing_and_defining_dictionary_of_the_Swatow_dialect,_arranged_according_to_syllables_and_tones_(IA_pronouncingdefin00fielrich).pdf', 'application/pdf'],
  oj: ['a0', 'OJ_C_202501145_of_2025_-_EN_English.pdf', 'application/pdf'],
  igo: ['3d', 'The_historic_archaeology_of_a_Chinese_mining_venture_near_Igo_in_Northern_California_(IA_historicarchaeol00ritt).pdf', 'application/pdf'],
  containers: ['63', 'Containers_for_fruits_and_vegetables_(IA_CAT87204671).pdf', 'application/pdf'],
  home: ['0f', 'Home_Vegetable_Gardening.djvu', 'image/vnd.djvu']
};
/** The v3 document files as the API answers them: the file is a PDF or DjVu, its thumbnail a JPEG of page 1. */
const v3DocAnswer = keys => commonsAnswer(keys.map(key => V3_DOCS[key][1]), Object.fromEntries(keys.map(key => {
  const [hash, file, mime] = V3_DOCS[key];
  return [file, { mime, thumbmime: 'image/jpeg', thumburl: v3Thumb(hash, file), url: `https://upload.wikimedia.org/wikipedia/commons/${hash[0]}/${hash}/${v3Enc(file)}` }];
})), 'Bok choy|Harvesting vegetables|Containers|Vegetable gardening');

test('repro v3 G: a PDF or DjVu page is never taken from Commons, even when its title or categories name the slot, nor a JPEG made from one', () => {
  const slot = { index: 1, kind: '採收動作特寫照片', explains: '手從小白菜的外葉摘起', search: 'harvesting bok choy outer leaves' };
  assert.deepEqual(plain(C.parseCommonsAnswer(v3DocAnswer(['swatow', 'oj', 'igo', 'containers', 'home']), slot)), [], 'document files and their page thumbnails');
  const relabelled = commonsAnswer(['Scan_page.jpg'], { 'Scan_page.jpg': { thumburl: v3Thumb('2c', V3_DOCS.swatow[1]) } }, 'Bok choy|Harvesting');
  assert.deepEqual(plain(C.parseCommonsAnswer(relabelled, slot)), [], 'a page thumbnail of a PDF, whatever the stated type');
  for (const mime of ['image/tiff', 'audio/ogg', 'video/webm', 'image/gif'])
    assert.deepEqual(plain(C.parseCommonsAnswer(commonsAnswer(['Bok_choy_harvest.x'], { 'Bok_choy_harvest.x': { mime } }), slot)), [], mime);
  const Q2 = S.load('core/book-pipeline/image-quality.ts');
  assert.ok(Object.values(V3_DOCS).every(([hash, file]) => Q2.isDocumentFile(v3Thumb(hash, file))));
  assert.equal(Q2.isDocumentFile('https://upload.wikimedia.org/wikipedia/commons/thumb/7/78/Perm%C3%A9abilit%C3%A9_pot_de_fleur_10L_1h.jpg/1280px-Perm%C3%A9abilit%C3%A9_pot_de_fleur_10L_1h.jpg'), false);
});

test('repro v3 G: a Commons file must name the slot\'s words (title, description or categories); a photo slot refuses covers, printed pages and maps', () => {
  const slot = { index: 1, kind: '採收動作特寫照片', explains: '手從小白菜的外葉摘起', search: 'harvesting bok choy outer leaves' };
  const titles = text => plain(C.parseCommonsAnswer(text, slot).map(c => c.title));
  assert.deepEqual(titles(commonsAnswer(['Chinese_mining_camp_ruins.jpg', 'Bok_choy_harvest_2019.jpg'])), ['Bok choy harvest 2019'], 'the title alone is enough when it names the slot');
  assert.deepEqual(titles(commonsAnswer(['IMG_2041.jpg'], {}, 'Brassica rapa chinensis|Harvesting|Bok choy')), ['IMG 2041'], 'the categories name it');
  assert.deepEqual(titles(commonsAnswer(['IMG_2041.jpg'], { 'IMG_2041.jpg': { extmetadata: { ImageDescription: { value: '<p>Picking the <b>outer leaves</b> of bok choy</p>' } } } })), ['IMG 2041'], 'the description names it');
  assert.deepEqual(titles(commonsAnswer(['IMG_2041.jpg'], {}, 'Gardening')), [], 'one shared word is not enough');
  assert.deepEqual(titles(commonsAnswer(['Bok_choy_seed_catalog_cover.jpg', 'Bok_choy_field_map.png'])), [], 'a cover or a map for a photo slot');
  assert.deepEqual(titles(commonsAnswer(['Bok_choy_harvest.jpg'], {}, 'Book covers')), [], 'a print genre in the categories');
  assert.deepEqual(plain(C.parseCommonsAnswer(commonsAnswer(['Bok_choy_field_map.png']), { ...slot, kind: '產地地圖' }).map(c => c.title)), ['Bok choy field map'], 'a map slot takes a map');
  assert.deepEqual(plain(C.parseCommonsAnswer(commonsAnswer(['IMG_1.jpg']), { index: 1, explains: '手從小白菜的外葉摘起' })), [], 'no English words and no Chinese title: not found');
  const got = C.parseCommonsAnswer(commonsAnswer(['IMG_2041.jpg'], {}, 'Bok choy|Harvesting'), slot)[0];
  assert.equal(got.description, 'Bok choy; Harvesting', 'what the file page says is kept for the record');
  assert.match(C.commonsSearchUrl('x'), /iiextmetadatafilter=Artist%7CLicenseShortName%7CImageDescription%7CCategories/);
});

test('repro v3 G: a chapter whose Commons answers are all document pages places none of them; the empty slots are not_found and count toward the shortfall', async () => {
  const r = await picRig({
    finder: (req, run, n) => n === 1 ? { ...found({ 1: [], 2: [] }), hints: new Map([[1, { search: 'harvesting bok choy outer leaves' }], [2, { search: 'potting soil containers' }]]) } : found({}),
    ports: { fetchCommons: async () => ({ status: 200, text: v3DocAnswer(['swatow', 'oj', 'igo', 'containers', 'home']) }) }
  });
  await r.repo.writeBookSettings(r.nodes[0].path, { style: '每章圖片 2 張' });
  await run(r);
  const detail = (await r.note(0)).detail;
  assert.equal(figures(detail).filter(f => /\.(pdf|djvu)|page1-/.test(f)).length, 0, 'zero document pages');
  assert.deepEqual(plain(recordOf(detail).slots.map(s => [s.index, s.state, s.reasonCode ?? ''])), [[1, 'missing', 'not_found'], [2, 'missing', 'not_found']]);
  assert.equal(stageOf(r.raw(0)), 'needs-review');
  assert.match((await r.note(0)).pipelineIssue, /images:under:0:2/);
});

test('repro v3 I: a placed document page is image_N_mismatch even when the text around it talks about its slot; so is a picture the record marks off', () => {
  const slots = S.load('core/book-pipeline/image-slots.ts');
  const [hash, file] = V3_DOCS.swatow;
  const pdf = v3Thumb(hash, file);
  const photo = 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Bok_choy.jpg/1280px-Bok_choy.jpg';
  const plan = [{ index: 1, kind: '照片', explains: '小白菜外葉採收', anchor: 'a' }, { index: 2, kind: '照片', explains: '小白菜外葉採收', anchor: 'b' }];
  const body = `從小白菜外葉採收開始。\n\n![A pronouncing dictionary](${pdf})\n手從小白菜的外葉摘起\n\n小白菜外葉採收要輕。\n\n![Bok choy](${photo})\n小白菜外葉\n\n小白菜外葉採收完畢。`;
  const record = { slots: [{ index: 1, state: 'placed', hash: slots.shortHash(pdf) }, { index: 2, state: 'placed', hash: slots.shortHash(photo) }], bad: 0 };
  assert.deepEqual(plain(slots.imageIssueTokens(slots.checkImageText(body, plan, record))), ['image_1_mismatch']);
  const marked = slots.composeSlotsRecord({ placed: [{ index: 1, href: pdf }, { index: 2, href: photo }], missing: [], bad: 0 }, new Set([2]));
  const read = slots.latestSlotsRecord(`x\n${marked}\n`);
  assert.deepEqual(plain(read.slots.map(s => [s.index, s.off ?? false])), [[1, false], [2, true]]);
  assert.deepEqual(plain(slots.imageIssueTokens(slots.checkImageText(body, plan, read))), ['image_1_mismatch', 'image_2_mismatch']);
  assert.match(slots.composeImageTextLine('zh-TW', slots.checkImageText(body, plan, read)), /圖 1/);
  const hand = slots.latestSlotsRecord('<!-- book-slots:v1 {"slots":[{"index":1,"state":"missing","off":true},{"index":2,"state":"placed","off":"yes"}],"bad":0} -->');
  assert.deepEqual(plain(hand.slots.map(s => s.off ?? false)), [false, false], 'only a placed item with off: true');
});

test('repro v3 I: a finder picture whose title and caption name nothing its slot asks for is recorded off and reported image_N_mismatch without a model call', async () => {
  const text = () => `開頭。\n\nexplains 1 perspective 的 explains perspective。\n\n${mk(1)}\n\n尾。\n\n### 來源\n- https://example.com/a\n`;
  const r = await picRig({ text, slots: 1, finder: () => found({ 1: [cand(1, { title: 'Swatow dialect dictionary', caption: '汕頭話字典封面' })] }) });
  await run(r);
  const detail = (await r.note(0)).detail;
  assert.deepEqual(plain(recordOf(detail).slots), [{ index: 1, state: 'placed', hash: recordOf(detail).slots[0].hash, off: true }]);
  assert.equal((await r.note(0)).pipelineIssue, 'image notice: image_1_mismatch');
  assert.equal(stageOf(r.raw(0)), 'checked', 'a notice, never needs-review');
});

// ---- repro v4 K: 15 pictures for 6 chapters of 6–10; a plain Commons word search ranked scanned books (PDF/DjVu) first ----
/** What Commons answered the v4 queries without a file type: ten scanned books (PDF pages), no photograph. */
const v4PdfAnswer = () => commonsAnswer(Array.from({ length: 10 }, (_, i) => `History_of_ancient_pottery_${i}.pdf`), Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`History_of_ancient_pottery_${i}.pdf`, { mime: 'application/pdf', thumbmime: 'image/jpeg' }])), 'Pots|Containers');

test('repro v4 K: every Commons query asks for bitmap files only (20 a request), so a slot is filled where the plain search gave only PDFs', async () => {
  const asked = [];
  const fetch = async url => { const q = new URL(url).searchParams.get('gsrsearch'); asked.push(q); return { status: 200, text: /filetype:bitmap$/.test(q) ? commonsAnswer(['Plastic_and_terracotta_pots.jpg']) : v4PdfAnswer() }; };
  const out = await C.searchCommons([{ index: 2, kind: '範例照片', explains: '塑膠盆、陶盆、不織布袋並排放在一起', search: 'plastic terracotta fabric pots' }], fetch, { signal: new AbortController().signal, skip: () => false });
  assert.deepEqual(asked, ['plastic terracotta fabric pots filetype:bitmap']);
  assert.deepEqual(plain(out.bySlot.get(2).map(c => c.title)), ['Plastic and terracotta pots']);
  assert.equal(new URL(C.commonsSearchUrl('x')).searchParams.get('gsrlimit'), '20');
  assert.deepEqual(plain(C.parseCommonsAnswer(v4PdfAnswer(), { index: 2, explains: 'x', search: 'pots containers' })), [], 'the PDFs stay refused');
});

test('repro v4 K: a slot asks up to 3 queries (search words, subject, its line) only while nothing is usable; a 429 asks nothing more in the chapter', async () => {
  const asked = [];
  const out = await C.searchCommons([{ index: 1, explains: '葉背的蚜蟲', subject: 'Ann', search: 'aphids leaf' }], async url => { asked.push(queryOf(url)); return { status: 200, text: '{}' }; }, { signal: new AbortController().signal, skip: () => false });
  assert.deepEqual(asked, ['aphids leaf', 'Ann', '葉背的蚜蟲']);
  assert.equal(out.requests, 3); assert.equal(out.limited, false);
  let n = 0;
  const limited = await C.searchCommons([{ index: 1, explains: 'a', search: 'b' }, { index: 2, explains: 'c', search: 'd' }], async () => { n++; return { status: 429, text: 'You are making too many requests to the API.' }; }, { signal: new AbortController().signal, skip: () => false });
  assert.equal(n, 1, 'one 429 ends the chapter\'s Commons search');
  assert.equal(limited.limited, true); assert.equal(limited.bySlot.size, 0);
});

// ---- repro v4 L: two Commons files placed under a slot line that says something the picture does not show ----
const V4_POT = { index: 3, kind: '示意圖', explains: '比較有排水孔的盆和只在盆底鋪碎石的盆。', search: 'pot drainage hole gravel' };
const V4_PAKCHOI = { index: 4, kind: '示意圖', explains: '小白菜淺覆土播種的方式，呼應好光性種子的特性。', search: 'pak choi sowing seeds' };
const v4File = (name, description, categories) => commonsAnswer([name], { [name]: { extmetadata: { ImageDescription: { value: description }, Categories: { value: categories } } } });
/** The two v4 files with their real file page text (2026-11-20). */
const V4_POT_FILE = v4File('Glazed_Flowerpot.jpg', 'Green glazed flower pot with slightly flaring sides.  Rounded, molded lip.  Inside unglazed.  One drainage hole in bottom.  Made by Joseph Oser. Title: Glazed Flowerpot', 'PD-Art (PD-US-expired)|Images uploaded by Fæ|PD US expired|Collections of the Missouri History Museum');
const V4_PAKCHOI_FILE = v4File('Brassica_rapa_Pak_Choi_Weiß_(white-stemmed_pak_choi)_(SaatPilot).jpg', 'This white-stemmed pak choi, offered by SaatPilot as ‘Pak Choi Weiß’, is a non-heading Chinese cabbage (Brassica rapa subsp. chinensis) that forms an open rosette of green, spoon-shaped leaves on broad, crisp, pale stalks. Young leaves can be cut as baby leaf; whole heads need more space', 'Brassica rapa subsp. chinensis|Self-published work');

test('repro v4 L: a Commons file that does not name every search word of its slot keeps its own name as caption and is marked loose; a full match keeps the slot line', () => {
  const pot = C.parseCommonsAnswer(V4_POT_FILE, V4_POT)[0];
  assert.equal(pot.title, 'Glazed Flowerpot');
  assert.equal(pot.caption, 'Glazed Flowerpot', 'never "比較有排水孔的盆和只在盆底鋪碎石的盆"');
  assert.equal(pot.loose, true);
  const pak = C.parseCommonsAnswer(V4_PAKCHOI_FILE, V4_PAKCHOI)[0];
  assert.equal(pak.loose, true);
  assert.ok(!/播種/.test(pak.caption), 'never "小白菜淺覆土播種的方式"');
  const full = C.parseCommonsAnswer(commonsAnswer(['Sowing_pak_choi_seeds.jpg']), V4_PAKCHOI)[0];
  assert.equal(full.caption, V4_PAKCHOI.explains); assert.equal(full.loose, undefined);
  const slots = S.load('core/book-pipeline/image-slots.ts');
  const fig = slots.figureOf({ imageUrl: pot.url, sourceUrl: pot.source, title: pot.title, caption: pot.caption, loose: true }, pot.url, 'zh-TW');
  assert.equal(fig.caption, '圖：Glazed Flowerpot');
  assert.equal(slots.figureOf({ imageUrl: pot.url, sourceUrl: pot.source, title: pot.title, caption: pot.caption, loose: true }, pot.url, 'en').caption, 'Picture: Glazed Flowerpot');
});

test('repro v4 L: placed from Commons, the loose file reads "圖：<name>" in the chapter and the proof reports image_N_mismatch', async () => {
  const text = () => `開頭。\n\nexplains 1 perspective 的 explains perspective。\n\n${mk(1)}\n\n尾。\n\n### 來源\n- https://example.com/a\n`;
  const r = await picRig({ text, slots: 1,
    finder: (req, run, n) => n === 1 ? { ...found({ 1: [] }), hints: new Map([[1, { search: 'perspective drawing grid' }]]) } : found({}),
    ports: { fetchCommons: async () => ({ status: 200, text: v4File('Perspective_drawing_of_a_house.jpg', 'A perspective drawing', 'Perspective') }) } });
  await run(r);
  const note = await r.note(0);
  assert.match(note.detail, /!\[Perspective drawing of a house\]\([^)\s]+\)\n圖：Perspective drawing of a house\n來源：/);
  assert.equal(recordOf(note.detail).slots[0].off, true);
  assert.equal(note.pipelineIssue, 'image notice: image_1_mismatch');
  assert.match(r.stat.logs.join('\n'), /slots .* commons=1(?! .*commons_nohint)/, 'the slot had English search words');
});

// ---- planned English search terms (card plan slot field `search`), the shared Commons queue, the relaxed caption rule ----
test('commons queries: the planner\'s English terms first, the finder\'s words second, the subject, the slot line last; at most 3', () => {
  assert.deepEqual(plain(C.commonsQueries({ index: 1, explains: '盆底的排水孔', terms: ['flower pot', 'drainage hole'], search: 'pot hole', subject: 'Oser' })), ['flower pot drainage hole', 'pot hole', 'Oser']);
  assert.deepEqual(plain(C.commonsQueries({ index: 1, explains: '盆底的排水孔', terms: ['flower pot'] })), ['flower pot', '盆底的排水孔']);
  assert.deepEqual(plain(C.commonsQueries({ index: 1, explains: '盆底的排水孔', terms: [] , search: 'pot hole' })), ['pot hole', '盆底的排水孔'], 'no planned terms: as before');
});

test('commons caption: the slot line stays when the file names at least half (rounded up) of the planned terms; fewer is the file\'s name and loose', () => {
  const slot = terms => ({ index: 3, kind: '示意圖', explains: '比較有排水孔的盆和只在盆底鋪碎石的盆。', terms });
  const two = C.parseCommonsAnswer(V4_POT_FILE, slot(['flower pot', 'drainage hole', 'gravel layer', 'potting soil']))[0];
  assert.equal(two.caption, '比較有排水孔的盆和只在盆底鋪碎石的盆。', '2 of 4 terms'); assert.equal(two.loose, undefined);
  const one = C.parseCommonsAnswer(V4_POT_FILE, slot(['drainage hole', 'gravel layer', 'potting soil']))[0];
  assert.equal(one.caption, 'Glazed Flowerpot', '1 of 3 terms (2 needed)'); assert.equal(one.loose, true);
  const half = C.parseCommonsAnswer(V4_POT_FILE, slot(['drainage hole', 'gravel layer']))[0];
  assert.equal(half.loose, undefined, '1 of 2 terms is half');
  const partial = C.parseCommonsAnswer(V4_POT_FILE, slot(['drainage gravel', 'pot soil', 'clay saucer']))[0];
  assert.equal(partial.loose, true, 'a term counts only when the file has all its words');
});

test('commons queue: concurrent chapters ask one request at a time through one queue; a chapter stopped while waiting asks nothing', async () => {
  let inFlight = 0; let most = 0; const events = [];
  const fetch = name => async url => { inFlight++; most = Math.max(most, inFlight); events.push(`start ${name}`); await new Promise(resolve => setTimeout(resolve, 5)); inFlight--; events.push(`end ${name}`); return { status: 200, text: '{}' }; };
  const slots = [{ index: 1, explains: 'x', search: 'a' }, { index: 2, explains: 'y', search: 'b' }];
  const ctl = new AbortController();
  const shared = new C.CommonsQueue(0);
  const [a, b] = await Promise.all([
    C.searchCommons(slots, fetch('A'), { signal: ctl.signal, skip: () => false, queue: shared }),
    C.searchCommons(slots, fetch('B'), { signal: ctl.signal, skip: () => false, queue: shared })
  ]);
  assert.equal(most, 1, 'never two requests at once');
  assert.equal(a.requests + b.requests, 8);
  events.forEach((event, at) => assert.equal(event.split(' ')[0], at % 2 ? 'end' : 'start'));
  most = 0;
  await Promise.all([1, 2].map(() => C.searchCommons(slots, fetch('C'), { signal: ctl.signal, skip: () => false, queue: new C.CommonsQueue(0) })));
  assert.equal(most, 2, 'separate queues do overlap (the check above can see it)');
  most = 0; events.length = 0;
  const spaced = new C.CommonsQueue(10);
  await Promise.all([C.searchCommons(slots.slice(0, 1), fetch('D'), { signal: ctl.signal, skip: () => false, queue: spaced }), C.searchCommons(slots.slice(0, 1), fetch('E'), { signal: ctl.signal, skip: () => false, queue: spaced })]);
  assert.equal(most, 1, 'with spacing too'); assert.equal(events.length, 8);
  events.forEach((event, at) => assert.equal(event.split(' ')[0], at % 2 ? 'end' : 'start'));
  const stop = new AbortController(); let started; const first = new Promise(resolve => { started = resolve; });
  const queue = new C.CommonsQueue(0);
  const blocker = C.searchCommons([{ index: 1, explains: 'x', search: 'a' }], async () => { started(); stop.abort(); return { status: 503, text: '' }; }, { signal: new AbortController().signal, skip: () => false, queue });
  const waiting = C.searchCommons(slots, fetch('F'), { signal: stop.signal, skip: () => false, queue });
  await first; const [, w] = await Promise.all([blocker, waiting]);
  assert.equal(w.requests, 0, 'stopped while waiting its turn: nothing asked');
  assert.ok(C.commonsQueue instanceof C.CommonsQueue, 'one shared queue for production');
});

test('commons run: planned English terms are the first Commons query and count as search words (no commons_nohint); the finder\'s hint comes second', async () => {
  const asked = [];
  const planned = [{ index: 1, kind: 'photo', explains: '盆底的排水孔', anchor: 'a', search: ['flower pot', 'drainage hole'] }];
  const text = () => `開頭。\n\n盆底的排水孔。\n\n${mk(1, '盆底的排水孔')}\n\n尾。\n\n### 來源\n- https://example.com/a\n`;
  const r = await picRig({ text, slots: planned,
    finder: (req, run, n) => n === 1 ? { ...found({ 1: [] }), hints: new Map([[1, { search: 'pot hole' }]]) } : found({}),
    ports: { fetchCommons: async url => { asked.push(queryOf(url)); return { status: 200, text: queryOf(url) === 'pot hole' ? V4_POT_FILE : '{}' }; } } });
  await run(r);
  // Two chapters (the filler has no finder hint): each asks its planned terms first; only the hinted chapter asks 'pot hole', after them.
  assert.equal(asked[0], 'flower pot drainage hole');
  assert.equal(asked.filter(q => q === 'flower pot drainage hole').length, 2);
  assert.ok(asked.indexOf('pot hole') > 0);
  const note = await r.note(0);
  assert.match(note.detail, /!\[Glazed Flowerpot\]\([^)\s]+\)\n盆底的排水孔\n來源：/, 'both planned terms named: the slot line is the caption');
  assert.ok(!/commons_nohint/.test(r.stat.logs.join('\n')));
  const none = await picRig({ text, slots: [{ ...planned[0], search: undefined }], finder: () => found({ 1: [] }), ports: { fetchCommons: async () => ({ status: 200, text: '{}' }) } });
  await run(none);
  assert.match(none.stat.logs.join('\n'), /commons_nohint=1/, 'no planned terms and no finder words');
  assert.ok(!/commons_nohint=1/.test(r.stat.logs.join('\n')));
});
