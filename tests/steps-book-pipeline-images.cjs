// Picture search of the picture-book writer (Q13): the found pictures are loaded by the program and embedded in one standard form.
// (rig copied from the run test) Picture-book pipeline runner (03a): the gates, retries, budget pause, stop/resume, stale fence, dispose, guarded writes and the picture
// allow-list of BookPipelineRuns, with fake ports over the real repository fixture. The provider, probe and step runner are fakes.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('./support.cjs');
const { load: loadReplay } = require('./support-replay.cjs');
const { BookPipelineRuns, BookPipelineRunError, bodyImageUrls, replaceBodyImages, unsafeBody } = S.load('experiences/visual-map/book-pipeline-run.ts');
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
  return { ...data, runs, ports, stat, script, mapPath, nodes, state, note, raw, mapRaw: () => contents.get(mapPath) };
}
/** Lowers the saved call limit (the pipeline has no port for it; the file is the owner's control). */
const setLimit = (r, limit) => r.repo.updateMap(r.mapPath, d => { d.bookPipeline.budget.limit = limit; });

const BODY = '正文開頭《蒙娜麗莎》結尾。';
const withSources = title => `${BODY} ${title}\n\n### 來源\n- https://example.com/a\n`;
const writeAuthor = (r, text) => async input => { await input.admission.reserve(); const n = await r.repo.readNote(input.path); const out = await r.repo.updateNoteGuarded(input.path, { detail: typeof text === 'function' ? text(n.title) : text }, { authorize: input.authorize, finalize: input.finalize }); return out === 'written' ? { outcome: 'written' } : { outcome: 'discarded' }; };
const cand = (n, over = {}) => ({ title: `Work ${n}`, url: `https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/W${n}.jpg/1280px-W${n}.jpg`, source: `https://commons.wikimedia.org/wiki/File:W${n}.jpg`, ...over });
/** A rig whose author writes a body with a Sources section; `finder` is the fake picture search. */
async function picRig({ finder, probe, text = withSources, titles, proof } = {}) {
  const calls = [];
  const holder = {};
  const r = await rig({
    titles: titles ?? ['SecretRootTitle'],
    script: { author: (input, n) => writeAuthor(holder.r, text)(input), ...(probe ? { probe } : {}), ...(proof ? { proof } : {}) },
    ports: { findImages: async (request, run) => { calls.push(request); await run.admission.reserve(); return finder(request, run, calls.length); } }
  });
  holder.r = r;
  r.calls = calls;
  return r;
}
const run = async r => { await r.runs.start(r.mapPath); await confirmDone(r.runs, r.mapPath); };

test('images: two verified pictures are embedded as standard images with plain captions between the text and the Sources section', async () => {
  const r = await picRig({ finder: () => [cand(1), cand(2)] });
  await run(r);
  const detail = (await r.note(0)).detail;
  const expected = /正文開頭《蒙娜麗莎》結尾。 SecretRootTitle\n\n### 圖像\n\n!\[Work 1\]\(https:\/\/upload\.wikimedia\.org[^)\s]+\)\nWork 1／來源：commons\.wikimedia\.org\n\n!\[Work 2\]\([^)\s]+\)\nWork 2／來源：commons\.wikimedia\.org\n\n### 來源\n/;
  assert.match(detail, expected);
  assert.equal(r.calls.length, 1, 'one search call per card');
  assert.equal(r.calls[0].model, 'm2', 'the author model');
  assert.match(r.calls[0].query, /SecretRootTitle/); assert.match(r.calls[0].query, /蒙娜麗莎/);
  assert.equal(stageOf(r.raw(0)), 'checked');
  assert.ok(!/無圖：/.test(detail));
  const log = r.stat.logs.filter(l => l.includes('pictures ')).join('\n');
  assert.match(log, /pictures=2 found=2 verified=2/);
  assert.ok(!/SecretRootTitle|wikimedia|蒙娜麗莎/.test(r.stat.logs.join('\n')), 'the log has counts only');
});

test('images: nothing verified keeps the no-picture note and no image section; a card with no found candidates likewise', async () => {
  for (const finder of [() => [cand(1), cand(2)], () => []]) {
    const r = await picRig({ finder, probe: async () => ({ ok: false, reason: 'load_failed' }) });
    await run(r);
    const note = await r.note(0);
    assert.ok(!/### 圖像/.test(note.detail));
    assert.match(note.detail, /無圖：未找到可驗證的公開圖片/);
    assert.match(r.stat.logs.join('\n'), /pictures=0 found=[02] verified=0/);
    assert.equal(stageOf(r.raw(0)), 'checked');
  }
});

test('images: a candidate that is not https, has a bad address or fails to load is not embedded; the verified one is', async () => {
  const r = await picRig({ finder: () => [cand(1, { url: 'http://example.com/a.jpg' }), cand(2, { url: 'https://example.com/b c.jpg' }), cand(3), cand(4)], probe: async url => (url.includes('W3') ? { ok: false, reason: 'timeout' } : { ok: true }) });
  await run(r);
  const detail = (await r.note(0)).detail;
  assert.equal((detail.match(/!\[/g) ?? []).length, 1);
  assert.match(detail, /!\[Work 4\]/);
  assert.ok(!/http:\/\/|W3/.test(detail));
  assert.ok(!r.stat.probes.some(u => u.startsWith('http:')), 'only https addresses are probed');
});

test('images: a caption with HTML, a markdown link or a line break becomes plain escaped single-line text', async () => {
  const r = await picRig({ finder: () => [cand(1, { title: 'Evil <img src=x onerror=alert(1)> [click](https://evil.example/x)\nsecond line ![x](https://evil.example/y)' , source: 'https://commons.wikimedia.org/wiki/File:X.jpg' })] });
  await run(r);
  const detail = (await r.note(0)).detail;
  const section = detail.slice(detail.indexOf('### 圖像'), detail.indexOf('### 來源'));
  assert.ok(!/<img|<[A-Za-z]/.test(section));
  assert.equal((section.match(/!\[/g) ?? []).length, 1, 'the title cannot form another image');
  assert.ok(!/\]\(https:\/\/evil/.test(section.replace(/\\\]\\\(/g, '')));
  assert.ok(!/\[click\]\(/.test(section));
  const caption = section.trim().split('\n').filter(Boolean).pop();
  assert.ok(!caption.includes('\n') && !/(^|[^\\])\[/.test(caption));
  assert.equal(unsafeBody(section, new Set(bodyImageUrls(section))), false);
});

test('images: more candidates than the cap are cut to 3, a gallery card keeps up to 6', async () => {
  const six = () => [1, 2, 3, 4, 5, 6].map(n => cand(n));
  const a = await picRig({ finder: six });
  await run(a);
  assert.equal(((await a.note(0)).detail.match(/!\[Work/g) ?? []).length, 3);
  const b = await picRig({ finder: six });
  await b.repo.updateMap(b.mapPath, d => { d.nodes[0].bookRole = 'gallery'; });
  await b.repo.writePipelineFields(b.nodes[0].path, { bookRole: 'gallery' });
  await run(b);
  assert.equal(((await b.note(0)).detail.match(/!\[Work/g) ?? []).length, 6);
});

test('images: a search that throws, never answers or is aborted does not make the card need review or count as a failure', async () => {
  const r = await picRig({ finder: () => { throw new Error('search boom'); } });
  await run(r);
  const s = await r.state();
  assert.equal(stageOf(r.raw(0)), 'checked');
  assert.ok(!(await r.note(0)).pipelineIssue);
  assert.match((await r.note(0)).detail, /無圖：未找到可驗證的公開圖片/);
  assert.equal(s.cards?.[r.nodes[0].id]?.attempts?.write ?? 1, 1);
  assert.equal(r.calls.length, 1, 'no retry');
});

test('images: a stop during the search leaves the card unmarked and the card is not written as pictures', async () => {
  const hold = defer();
  const r = await picRig({ finder: async () => { await hold.promise; return [cand(1)]; } });
  await r.runs.start(r.mapPath);
  await r.runs.confirmGate1(r.mapPath);
  await settle();
  assert.equal(r.calls.length, 1);
  await r.runs.stop(r.mapPath);
  hold.resolve();
  await settle();
  assert.ok(!/### 圖像/.test((await r.note(0)).detail));
  assert.notEqual(stageOf(r.raw(0)), 'written');
});

test('images: the budget is gated; a refusal in the search pauses the run and leaves no pictures or stage on the card', async () => {
  const r = await picRig({ finder: () => [cand(1)] });
  await r.runs.start(r.mapPath);
  // global plan 1 + card plan 1 are used; allow the author call but not the search
  const used = (await r.state()).budget.used;
  await setLimit(r, used + 1);
  await r.runs.confirmGate1(r.mapPath);
  await settle();
  const s = await r.state();
  assert.equal(s.status, 'stopped'); assert.equal(s.pauseReason, 'budget');
  assert.ok(!/### 圖像/.test((await r.note(0)).detail));
  assert.notEqual(stageOf(r.raw(0)), 'written');
  assert.notEqual(stageOf(r.raw(0)), 'checked');
  assert.ok(!(await r.note(0)).pipelineIssue);
});

test('images: the proofread sees the chapter text without the picture section; a rewrite replaces the section and searches again', async () => {
  const r = await picRig({ finder: (req, run, n) => [cand(n * 10)] });
  await run(r);
  assert.match((await r.note(0)).detail, /### 圖像/);
  assert.ok(r.stat.proof.length >= 1);
  for (const request of r.stat.proof) { assert.ok(!/圖像|Work|wikimedia/.test(request.body)); }
  await r.runs.rerunCard(r.mapPath, r.nodes[0].id);
  while (r.runs.isRunning(r.mapPath)) await tick();
  await settle();
  const detail = (await r.note(0)).detail;
  assert.equal((detail.match(/### 圖像/g) ?? []).length, 1);
  assert.match(detail, /Work 20/); assert.ok(!/Work 10/.test(detail));
  assert.equal(r.calls.length, 2);
});

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
