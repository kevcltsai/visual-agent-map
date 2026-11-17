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
    updateMap: (path, change) => repo.updateMap(path, change),
    readCard: async path => {
      const note = await repo.readNote(path);
      return { path, title: note.title, summary: note.summary, prompt: note.prompt, detail: note.detail, raw: contents.get(path), settings: note.bookSettings ?? {}, fields: { ...(note.pipelineStage ? { pipelineStage: note.pipelineStage } : {}), ...(note.bookRole ? { bookRole: note.bookRole } : {}), ...(note.pipelineIssue ? { pipelineIssue: note.pipelineIssue } : {}) } };
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
    config: () => ({ planModel: 'm1', authorModel: 'm2', proofModel: 'm3', reasoning: 'low', language: 'zh-TW' }),
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
const writeAuthor = (r, text) => async input => { await input.admission.reserve(); const n = await r.repo.readNote(input.path); const out = await r.repo.updateNoteGuarded(input.path, { detail: typeof text === 'function' ? text(n.title) : text }, { authorize: input.authorize, finalize: input.finalize }); return out === 'written' ? { outcome: 'written' } : { outcome: 'discarded' }; };
const cand = (n, over = {}) => ({ title: `Work ${n}`, caption: `Caption ${n}`, url: `https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/W${n}.jpg/1280px-W${n}.jpg`, source: `https://commons.wikimedia.org/wiki/File:W${n}.jpg`, ...over });
/** The finder's answer: `{ 1: [cand...], 2: [...] }` by slot index. */
const found = bySlotObj => { const bySlot = new Map(Object.entries(bySlotObj).map(([k, v]) => [Number(k), v])); return { bySlot, found: [...bySlot.values()].reduce((n, v) => n + v.length, 0), offTopic: 0 }; };
const slotsOf = n => Array.from({ length: n }, (_, i) => ({ index: i + 1, kind: 'diagram', explains: `explains ${i + 1} perspective`, anchor: `after paragraph ${i + 1}` }));
const mk = (n, text = `explains ${n} perspective`) => `〔圖位 ${n}：${text}〕`;
/** Two paragraphs, each followed by its marker line, then a Sources section. */
const twoMarkers = title => `正文一。${title}\n\n${mk(1)}\n\n正文二。\n\n${mk(2)}\n\n正文三。\n\n### 來源\n- https://example.com/a\n`;
/** A rig whose card plan arranges `slots` pictures (null: an old Prompt without an image plan) and whose author writes `text`; `finder` is the fake picture search (request, run, callNumber) -> found(). */
async function picRig({ finder, probe, text = twoMarkers, titles, proof, slots = 2, ports } = {}) {
  const calls = [];
  const holder = {};
  const r = await rig({
    titles: titles ?? ['SecretRootTitle'],
    script: { card: request => ({ covers: `covers ${request.card.position}`, entry: 'entry', handoff: 'handoff', previous: 'p', next: 'n', checklist: [{ id: 'C1', type: 'structure', text: 'has a beginning' }, { id: 'C2', type: 'structure', text: 'has an end' }], ...(slots === null ? {} : { images: slotsOf(slots) }) }),
      author: (input, n) => writeAuthor(holder.r, text)(input), ...(probe ? { probe } : {}), ...(proof ? { proof } : {}) },
    ports: { findImages: async (request, run) => { calls.push(request); await run.admission.reserve(); return finder(request, run, calls.length); }, ...ports }
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
  assert.match(detail, /正文一。SecretRootTitle\n\n!\[Work 1\]\(https:\/\/upload\.wikimedia\.org[^)\s]+\)\nCaption 1\n\n正文二。\n\n!\[Work 2\]\([^)\s]+\)\nCaption 2\n\n正文三。\n\n### 來源\n/);
  assert.ok(!/〔圖位|無圖：|### 圖像/.test(detail));
  assert.equal(r.calls.length, 1, 'one search call per card');
  assert.equal(r.calls[0].model, 'm2', 'the author model');
  assert.deepEqual(plain(r.calls[0].slots.map(s => s.index)), [1, 2]);
  assert.match(r.calls[0].chapter, /SecretRootTitle/);
  assert.equal(detail.split('book-slots:v1').length - 1, 1, 'one record');
  assert.deepEqual(plain(recordOf(detail).slots.map(s => [s.index, s.state])), [[1, 'placed'], [2, 'placed']]);
  assert.equal(stageOf(r.raw(0)), 'checked');
  const log = r.stat.logs.filter(l => l.includes(' slots ')).join('\n');
  assert.match(log, /book-pipeline slots .* placed=2 missing=0$/);
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
  const lines = detail.split('\n'); const at = lines.findIndex(l => l.startsWith('![')); assert.ok(lines[at + 1] && !lines[at + 1].includes('![') && lines[at + 2] === '');
  const added = lines.slice(at, at + 2).join('\n');
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
  assert.match((await r.note(0)).pipelineIssue ?? '', /^structure unmet: image_1 image_2$/, 'only the notice tokens of the missing pictures, never a failure or needs-review');
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
  await setLimit(r, used + 1);
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
  await r.repo.updateNote(r.nodes[0].path, { detail: OLD_DETAIL });
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
  await r.repo.updateNote(r.nodes[0].path, { detail: OLD_DETAIL });
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
  const img = (n, extra) => ({ title: `T${n}`, caption: `C${n}`, imageUrl: `https://upload.wikimedia.org/a/ab/F${n}.jpg`, sourceUrl: 'https://commons.wikimedia.org/x', kind: 'diagram', shows: 'a thing', relevant: true, ...extra });
  const parsed = findImagesStep.parse(JSON.stringify({ slots: [{ slot: 1, images: [img(1), img(2, { relevant: false }), img(3, { imageUrl: 'http://bad.example/x.jpg' }), img(4, { shows: '  ' }), img(5, { caption: undefined }), img(6), img(7), img(8)] }, { slot: 2, images: [img(9)] }, { slot: 'x', images: [img(10)] }, null] }));
  assert.deepEqual([...parsed.bySlot.get(1)].map(p => [p.title, p.caption]), [['T1', 'C1'], ['T5', 'a thing'], ['T6', 'C6']], 'the caption follows its own image though one before it was dropped');
  assert.deepEqual([...parsed.bySlot.keys()], [1, 2]);
  assert.equal(parsed.offTopic, 2);
  assert.equal(parsed.found, 4);
  assert.equal(findImagesStep.parse('not json').found, 0);
  assert.equal(findImagesStep.version, 3);
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

test('slots load: 5 chapters x 8 slots whose candidates all fail probe at most 24 addresses a chapter and 4 at a time, one search call each, and every card still ends checked', async () => {
  const titles = ['T0', 'T1', 'T2', 'T3', 'T4'];
  let seq = 0;
  let inflight = 0, peak = 0;
  const text = title => `${BODY} ${title}\n\n${Array.from({ length: 8 }, (_, i) => `${mk(i + 1)}\n\n段${i + 1}。`).join('\n\n')}\n`;
  const finder = req => found(Object.fromEntries(req.slots.map(s => [s.index, Array.from({ length: 4 }, () => cand(++seq))])));
  const r = await picRig({ titles, slots: 8, text, finder, probe: async () => { inflight++; peak = Math.max(peak, inflight); await tick(); await tick(); inflight--; return { ok: false, reason: 'load_failed' }; } });
  await run(r);
  assert.equal(r.calls.length, 5, 'one search per chapter');
  assert.ok(r.calls.every(c => c.slots.length === 8));
  assert.ok(peak <= 4 && peak >= 2, `peak ${peak}`);
  assert.equal(r.stat.probes.length, 5 * 24, 'each chapter probes its first 24 distinct addresses of 32');
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
  assert.equal(done.text, '前。\r\n\r\n![T](https://a.example/x.jpg)\r\nC\r\n\r\n後。\r\n');
  assert.equal(m.verifyFill(text, done, slots), undefined);
  const none = m.fillSlotMarkers(text, slots, new Map());
  assert.equal(m.verifyFill(text, none, slots), undefined);
  assert.ok(!/〔圖位/.test(none.text));
});

// ---- the old run's stages (R1-1): a card planned/written/checked by the old version, standard and textbook template, closed and resumed ----
const TEMPLATES = { standard: '## 核心結論\n舊內文。\n\n## 背景與機制\n說明。', textbook: '## 章節本文\n舊內文。\n\n## 本章小結\n說明。' };
async function reopen(r, stage, detail) {
  await r.repo.updateNote(r.nodes[0].path, { detail });
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
    await r.repo.updateNote(r.nodes[0].path, { detail: old });
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

test('proofread: the request body has no image line or caption; the result section has one 圖文 line before the model lines; a missing or off-topic picture is a notice (structure unmet), never needs-review', async () => {
  const text = () => `開頭。\n\nexplains perspective 的說明。\n\n${mk(1)}\n\n另一段。\n\n${mk(2)}\n\n尾。\n\n### 來源\n- https://example.com/a\n`;
  const r = await picRig({ text, finder: () => found({ 1: [cand(1)] }) });
  await run(r);
  const body = r.stat.proof[0].body;
  assert.ok(!/!\[|Caption 1|Work 1|upload\.wikimedia/.test(body), body);
  assert.match(body, /explains perspective 的說明。/);
  const raw = r.raw(0);
  const section = /## 校對結果[^\n]*\n([\s\S]*?)(?:\n## |\n### |$)/.exec(raw)?.[1] ?? '';
  const lines = section.split('\n').filter(l => l.startsWith('- '));
  const at = lines.findIndex(l => /^- 圖文：/.test(l));
  assert.ok(at >= 0 && at === lines.length - 3, raw);
  assert.match(lines[at], /圖 2 沒找到合適的圖/);
  assert.equal(stageOf(raw), 'checked');
  assert.match((await r.note(0)).pipelineIssue ?? '', /^structure unmet: image_2$/);
});

test('proofread: all pictures placed next to their text: the 圖文 line says ok and the card carries no issue; an old Prompt says no image plan', async () => {
  const text = () => `開頭。\n\nexplains 1 perspective 的 explains perspective。\n\n${mk(1)}\n\n尾。\n\n### 來源\n- https://example.com/a\n`;
  const r = await picRig({ text, slots: 1, finder: () => found({ 1: [cand(1)] }) });
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
  const text = title => `${BODY}\n\n${Array.from({ length: 8 }, (_, i) => `${mk(i + 1)}\n\n段${i + 1}。`).join('\n\n')}\n`;
  let seq = 0;
  const finder = req => found(Object.fromEntries(req.slots.map(s => [s.index, Array.from({ length: 4 }, () => cand(++seq))])));
  const r = await picRig({ slots: 8, text, finder, probe: async () => ({ ok: false, reason: 'load_failed' }) });
  await run(r);
  const reasons = recordOf((await r.note(0)).detail).slots.map(s => s.reasonCode);
  assert.deepEqual(reasons, ['load_failed', 'load_failed', 'load_failed', 'load_failed', 'load_failed', 'load_failed', 'probe_capped', 'probe_capped']);
  assert.match(r.stat.logs.join('\n'), /reason=load_failed,probe_capped|reason=probe_capped/);
  const pair = await picRig({ slots: 2, text: () => `${BODY}\n\n${mk(1)}${mk(2)}\n\n尾。\n`, finder: () => found({}) });
  await run(pair);
  assert.deepEqual(recordOf((await pair.note(0)).detail).slots.map(s => s.reasonCode), ['bad_marker', 'bad_marker']);
});
