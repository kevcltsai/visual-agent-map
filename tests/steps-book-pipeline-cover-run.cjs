// Cover image B3: download, save and write back of a card's cover (plan 2026-11-21-book-cover-image): the real downloadCover and saveCover run behind fake network and vault ports;
// the block and topic-cover land in the one guarded write; owner-held, old-book, failed, stopped and parallel cases. (rig copied from steps-book-pipeline-images.cjs)
// allow-list of BookPipelineRuns, with fake ports over the real repository fixture. The provider, probe and step runner are fakes.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('./support.cjs');
const { load: loadReplay } = require('./support-replay.cjs');
const { BookPipelineRuns, BookPipelineRunError, bodyImageUrls, replaceBodyImages, unsafeBody } = S.load('experiences/visual-map/book-pipeline-run.ts');
const C = S.load('core/book-pipeline/commons-search.ts');
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
    card: request => ({ covers: `covers ${(request.chapters.findIndex(c => c.title === request.card.title) + 1)}`, entry: 'entry', handoff: 'handoff', previous: 'p', next: 'n', checklist: [{ id: 'C1', type: 'structure', text: 'has a beginning' }, { id: 'C2', type: 'structure', text: 'has an end' }] }),
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
/** The stage of a chapter whose placed pictures the fixture text names nothing of: every picture off its text is a reason to look (Primary decision after the v5 run). */
const MISMATCH_STAGE = 'needs-review';
const slotsOf = n => Array.from({ length: n }, (_, i) => ({ index: i + 1, kind: 'diagram', explains: `explains ${i + 1} perspective`, anchor: `after paragraph ${i + 1}` }));
const mk = (n, text = `explains ${n} perspective`) => `〔圖位 ${n}：${text}〕`;
/** Two paragraphs, each followed by its marker line, then a Sources section. */
const twoMarkers = title => `正文一。${title}\n\n${mk(1)}\n\n正文二。\n\n${mk(2)}\n\n正文三。\n\n### 來源\n- https://example.com/a\n`;
/** A rig whose card plan arranges `slots` pictures (null: an old Prompt without an image plan) and whose author writes `text`; `finder` is the fake picture search (request, run, callNumber) -> found(). */
async function picRig({ finder, probe, text = twoMarkers, titles, proof, slots = 2, ports, checklist, cover } = {}) {
  const calls = [];
  const holder = {};
  const r = await rig({
    titles: titles ?? ['SecretRootTitle', 'FillerChapter'],
    script: { card: request => ({ covers: `covers ${(request.chapters.findIndex(c => c.title === request.card.title) + 1)}`, entry: 'entry', handoff: 'handoff', previous: 'p', next: 'n', checklist: checklist ?? [{ id: 'C1', type: 'structure', text: 'has a beginning' }, { id: 'C2', type: 'structure', text: 'has an end' }], ...(slots === null ? {} : { images: Array.isArray(slots) ? slots : slotsOf(slots) }), ...(cover ? { cover } : {}) }),
      author: (input, n) => writeAuthor(holder.r, text)(input), ...(probe ? { probe } : {}), ...(proof ? { proof } : {}) },
    // A Commons queue without the production 1 s spacing (the queue's own tests check the spacing and the 429 waits).
    ports: { commonsQueue: new C.CommonsQueue(0, async () => {}), findImages: async (request, run) => { if (!titles && /FillerChapter/.test(request.chapter)) { await run.admission.reserve(); return found({}); } calls.push(request); await run.admission.reserve(); return finder(request, run, calls.length); }, ...ports }
  });
  holder.r = r;
  r.calls = calls;
  return r;
}
const plain = value => JSON.parse(JSON.stringify(value));
const run = async r => { await r.runs.start(r.mapPath); await confirmDone(r.runs, r.mapPath); };
const recordOf = detail => JSON.parse(/<!-- book-slots:v1 (\{.*\}) -->/.exec(detail)[1]);
const figures = detail => detail.match(/!\[[^\]]*\]\([^)\s]+\)/g) ?? [];

const cardCover = S.load('experiences/visual-map/card-cover.ts', { obsidian: { parseYaml: () => ({}), stringifyYaml: () => '' } });
const dl = S.load('core/book-pipeline/cover-download.ts');
const coverLib = S.load('core/book-pipeline/cover.ts');
const blockLib = S.load('core/book-pipeline/cover-block.ts');
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const coverAsk = { explains: 'the dome of the cathedral', search: ['Florence Cathedral dome', 'Brunelleschi'] };
const coverCand = (n, over = {}) => cand(n, { url: `https://upload.wikimedia.org/wikipedia/commons/thumb/c/cd/Cover${n}.jpg/1280px-Cover${n}.jpg`, source: `https://commons.wikimedia.org/wiki/File:Cover${n}.jpg`, title: 'Florence Cathedral dome', caption: `The dome of the cathedral ${n}`, ...over });
const zhCaption = n => `大教堂圓頂的照片 ${n}`;
/** The real downloadCover and saveCover behind a fake network and a fake vault: `net` records every request, `files` the saved files. */
function coverPorts({ respond, ports } = {}) {
  const net = []; const files = new Map();
  const answerPng = () => ({ status: 200, headers: { 'content-type': 'image/png' }, bytes: PNG.buffer.slice(0) });
  return {
    net, files,
    ports: {
      fetchCoverImage: (url, signal) => dl.downloadCover(url, async (address, init) => { net.push({ url: address, headers: init.headers }); return respond ? respond(address, net.length) : answerPng(); }, { signal, userAgent: 'VisualAgentMap-Obsidian-plugin/0.0.0 (https://example.org/repo)' }),
      saveCover: (folder, title, url, download, signal) => dl.saveCover({ exists: async path => files.has(path), createBinary: async (path, data) => { files.set(path, data); } }, folder, title, url, download, signal),
      setCoverLink: (content, link) => cardCover.withCover(content, link),
      ...ports
    }
  };
}
const coverRig = async ({ cover = coverAsk, finder, titles, net: netOptions, ...rest } = {}) => {
  const net = coverPorts(netOptions);
  const r = await picRig({ titles, cover, slots: 1, text: title => `正文。${title}\n\n${mk(1)}\n`, finder: finder ?? ((request) => found({ 1: [cand(1)], ...(coverSlotOf(request) ? { 0: [coverCand(1, { caption: zhCaption(1) })] } : {}) })), ports: { ...net.ports }, ...rest });
  r.net = net.net; r.files = net.files;
  return r;
};
const coverSlotOf = request => request.slots.find(slot => slot.index === 0);
const topicCover = raw => /^topic-cover: "?(.*?)"?$/m.exec(raw)?.[1];
const FOLDER_RE = /封面圖\/SecretRootTitle-[0-9a-z]+\.png/;

const coverBlockOf = raw => { const b = blockLib.readCoverBlock(raw); return b ? raw.slice(b.from, b.to) : undefined; };
/** Each card is offered its own cover picture (the second chapter Cover2, the others Cover1), so no card loses its cover to another. */
const perCard = request => found({ 1: [cand(/SecondChapter/.test(request.chapter) ? 2 : 1)], ...(coverSlotOf(request) ? { 0: [coverCand(/SecondChapter/.test(request.chapter) ? 2 : 1, { caption: zhCaption(1) })] } : {}) });
const coverFiles = r => [...r.files.keys()];
const html = () => ({ status: 200, headers: { 'content-type': 'text/html' }, bytes: Buffer.from('<html>').buffer.slice(0) });

test('cover run: a found cover is downloaded (thumbnail only, policy headers only), saved in the book\'s cover folder and written in the one write: block under the title, topic-cover, source link, log counts only', async () => {
  const r = await coverRig();
  await run(r);
  const raw = r.raw(0);
  assert.match(raw, /^# SecretRootTitle\n\n<!-- book-cover:v1 /m, 'the block sits directly under the title');
  assert.match(raw, /\n!\[\[Agent Workspace\/Mind Maps\/Book\/Notes\/封面圖\/SecretRootTitle-[0-9a-f]+\.png\]\]\n大教堂圓頂的照片 1\n來源：\[Wikimedia Commons\]\(https:\/\/commons\.wikimedia\.org\/wiki\/File:Cover1\.jpg\)\n<!-- book-cover:end -->/);
  assert.match(topicCover(raw), /^\[\[Agent Workspace\/Mind Maps\/Book\/Notes\/封面圖\/SecretRootTitle-[0-9a-f]+\.png\]\]$/);
  assert.equal(blockLib.coverOwnership(raw), 'program', 'block and topic-cover agree');
  assert.equal(raw.split('book-cover:v1').length - 1, 1);
  assert.deepEqual(coverFiles(r).length, 1); assert.match(coverFiles(r)[0], /\/封面圖\/SecretRootTitle-[0-9a-f]+\.png$/);
  assert.deepEqual(plain(r.net.map(call => call.url)), ['https://upload.wikimedia.org/wikipedia/commons/thumb/c/cd/Cover1.jpg/1280px-Cover1.jpg'].concat(r.net.length > 1 ? plain(r.net.slice(1).map(call => call.url)) : []).slice(0, r.net.length));
  assert.ok(r.net.every(call => /^https:\/\/upload\.wikimedia\.org\//.test(call.url)), 'only upload.wikimedia.org is asked');
  assert.deepEqual(Object.keys(r.net[0].headers).sort(), ['Api-User-Agent', 'User-Agent']);
  assert.match(r.net[0].headers['User-Agent'], /^VisualAgentMap-Obsidian-plugin\/0\.0\.0 \(https:\/\/example\.org\/repo\)$/);
  const log = r.stat.logs.join('\n');
  assert.match(log, /book-pipeline cover_placed run=\S+ card=\S+ step=write attempt=\d+ result=ok ms=0$/m);
  assert.ok(!/Cover1|wikimedia|封面圖|SecretRootTitle/.test(r.stat.logs.filter(line => line.includes('cover_')).join('\n')), 'the cover log lines carry no address, title or file name');
  // The picture's key is on the note, so another card reads it (one picture once per book).
  assert.equal(blockLib.coverSourceKey(raw), imageKey(coverCand(1).url));
});

test('cover run: nothing found is said at each level (book, chapter, section) and written as the only content of the block; no topic-cover, nothing borrowed from the level above', async () => {
  const r = await coverRig({ titles: ['SecretRootTitle', 'ChapterA', 'SectionB'], finder: request => found({ 1: [cand(request.slots.length)], ...(/SecretRootTitle/.test(request.chapter) ? { 0: [coverCand(1, { caption: zhCaption(1) })] } : {}) }) });
  await r.repo.updateMap(r.mapPath, d => { d.nodes[2].parentId = d.nodes[1].id; });
  await run(r);
  assert.match(coverBlockOf(r.raw(0)), /!\[\[/, 'the book has its cover');
  assert.equal(coverBlockOf(r.raw(1)).split('\n').slice(1, -1).join('\n'), '這一章沒找到合適的封面圖。');
  assert.equal(coverBlockOf(r.raw(2)).split('\n').slice(1, -1).join('\n'), '這一節沒找到合適的封面圖。');
  for (const i of [1, 2]) { assert.equal(topicCover(r.raw(i)), undefined); assert.ok(!/封面圖\//.test(r.raw(i)), 'no file of the level above'); assert.equal(blockLib.coverOwnership(r.raw(i)), 'program'); }
  assert.equal(coverFiles(r).length, 1);
  assert.ok(r.stat.logs.some(line => /cover_missing/.test(line)));
});

test('cover run: the book root with no body slots searches for its cover alone and gets it (the +1 search); a root with slots adds no call', async () => {
  const none = await coverRig({ slots: 0, titles: ['SecretRootTitle', 'SecondChapter'], finder: request => found(coverSlotOf(request) ? { 0: [coverCand(request.slots.length === 1 ? 1 : 2, { caption: zhCaption(1) })] } : {}) });
  await run(none);
  assert.equal(none.calls.length, 2, 'one cover-only search for each card (no body slot anywhere)');
  assert.ok(none.calls.every(call => call.slots.length === 1 && call.slots[0].index === 0));
  assert.ok(coverBlockOf(none.raw(0)) && coverBlockOf(none.raw(1)));
});

test('cover run: a failed download (error status, html, six megabytes, bytes that are not the header\'s type, a thrown request) is "not found" with no file written and no topic-cover; the claim is given back so a rerun gets it', async () => {
  const six = new Uint8Array(6 * 1024 * 1024); six.set(PNG);
  const bad = [() => ({ status: 404, headers: {}, bytes: new ArrayBuffer(0) }), html, () => ({ status: 200, headers: { 'content-type': 'image/png' }, bytes: six.buffer }), () => ({ status: 200, headers: { 'content-type': 'image/png' }, bytes: Uint8Array.from([0xff, 0xd8, 0xff, 1]).buffer }), () => { throw new Error('offline'); }];
  for (const respond of bad) {
    let working = false;
    const r = await coverRig({ titles: ['SecretRootTitle', 'SecondChapter'], net: { respond: (url, n) => working ? { status: 200, headers: { 'content-type': 'image/png' }, bytes: PNG.buffer.slice(0) } : respond(url, n) }, finder: request => found({ 1: [cand(/SecondChapter/.test(request.chapter) ? 2 : 1)], ...(coverSlotOf(request) && /SecondChapter/.test(request.chapter) ? { 0: [coverCand(1, { caption: zhCaption(1) })] } : {}) }) });
    await run(r);
    assert.equal(r.files.size, 0, 'nothing written to the vault');
    assert.equal(coverBlockOf(r.raw(1)).split('\n').slice(1, -1).join('\n'), '這一章沒找到合適的封面圖。');
    assert.equal(topicCover(r.raw(1)), undefined);
    assert.ok(r.stat.logs.some(line => /cover_download_failed/.test(line)));
    // The network is back: the same card again. A claim left behind by the failure would keep it from the same picture.
    working = true;
    await r.runs.rerunCard(r.mapPath, r.nodes[1].id);
    while (r.runs.isRunning(r.mapPath)) await tick();
    await settle();
    assert.equal(r.files.size, 1, 'the picture is saved on the second try');
    assert.ok(topicCover(r.raw(1)));
  }
});

test('cover run: a cover the owner holds is left byte for byte: topic-cover none, a topic-cover of their own with no block, a block they edited', async () => {
  for (const seed of ['topic-cover: none', 'topic-cover: "[[mine.png]]"']) {
    const r = await coverRig();
    await r.repo.updateNoteRawGuarded(r.nodes[0].path, raw => raw.replace(/^---\n/, `---\n${seed}\n`), {});
    await run(r);
    const raw = r.raw(0);
    assert.equal(r.net.length, 0, `${seed}: no request`);
    assert.ok(!/book-cover/.test(raw), `${seed}: no block`);
    assert.equal(/^topic-cover: .*$/m.exec(raw)[0], seed, `${seed}: the line is as it was`);
    assert.equal(r.files.size, 0);
  }
  // A block the owner edited: placed by a first run, then changed; the chapter written again leaves it as it is.
  const r = await coverRig({ titles: ['SecretRootTitle', 'SecondChapter'], finder: perCard });
  await run(r);
  const placed = coverBlockOf(r.raw(1));
  assert.ok(placed);
  const edited = placed.replace(/來源：/, '我自己加的一行\n來源：');
  await r.repo.updateNoteRawGuarded(r.nodes[1].path, raw => raw.replace(placed, edited), {});
  const before = r.net.length;
  await r.runs.rerunCard(r.mapPath, r.nodes[1].id);
  while (r.runs.isRunning(r.mapPath)) await tick();
  await settle();
  assert.equal(coverBlockOf(r.raw(1)), edited, 'the edited block is untouched');
  assert.equal(r.net.length, before, 'no new download');
  assert.ok(r.stat.logs.some(line => /cover_owner_kept/.test(line)), 'the kept cover is counted');
});

test('cover run: an older book (no cover line in the Prompt) gets no cover search, no block, no "not found" line, and no new request', async () => {
  const r = await coverRig({ cover: null });
  await run(r);
  for (const i of [0, 1]) { assert.ok(!/book-cover|topic-cover/.test(r.raw(i))); assert.ok(!/沒找到合適的封面圖/.test(r.raw(i))); }
  assert.equal(r.net.length, 0); assert.ok(r.calls.every(call => !coverSlotOf(call)));
});

test('cover run: the same chosen picture again is idempotent: the block and the file are the same after the card is written again', async () => {
  const r = await coverRig({ titles: ['SecretRootTitle', 'SecondChapter'], finder: perCard });
  await run(r);
  const first = coverBlockOf(r.raw(1)); const link = topicCover(r.raw(1)); const filesBefore = r.files.size;
  assert.ok(first);
  await r.runs.rerunCard(r.mapPath, r.nodes[1].id);
  while (r.runs.isRunning(r.mapPath)) await tick();
  await settle();
  assert.equal(coverBlockOf(r.raw(1)), first); assert.equal(topicCover(r.raw(1)), link);
  assert.equal(r.files.size, filesBefore, 'the rerun reused its file (nothing new saved)');
});

test('cover run: three cards ask for the same picture at once: exactly one gets it, one request is made for it, the others say not found', async () => {
  const r = await coverRig({ titles: ['SecretRootTitle', 'ChapterA', 'ChapterB'], finder: request => found({ 1: [cand(1 + request.chapter.length % 3 * 0 + (request.chapter.includes('ChapterA') ? 2 : request.chapter.includes('ChapterB') ? 3 : 1))], 0: [coverCand(1, { caption: zhCaption(1) })] }) });
  await run(r);
  const owners = [0, 1, 2].filter(i => topicCover(r.raw(i)));
  assert.equal(owners.length, 1, 'one card has the picture');
  assert.equal(r.net.length, 1);
  assert.equal([0, 1, 2].filter(i => /沒找到合適的封面圖/.test(r.raw(i))).length, 2);
  const keys = [0, 1, 2].map(i => blockLib.coverSourceKey(r.raw(i))).filter(Boolean);
  assert.deepEqual(keys, [imageKey(coverCand(1).url)]);
});

test('cover run: the caption: a file name alone, or another script than the book\'s, is left out; a placed cover that names none of what was asked says "this picture may not match"', async () => {
  const run1 = async caption => { const r = await coverRig({ finder: request => found({ 1: [cand(1)], ...(coverSlotOf(request) ? { 0: [coverCand(1, { caption, title: 'Florence Cathedral dome' })] } : {}) }) }); await run(r); return coverBlockOf(r.raw(0)).split('\n').slice(1, -1); };
  assert.equal((await run1('Cover1.jpg')).length, 2, 'embed and source only');
  assert.equal((await run1('File:Cover1.jpg')).length, 2);
  assert.equal((await run1('The dome of Florence cathedral seen from the south')).length, 2, 'an English caption in a Chinese book');
  assert.equal((await run1(zhCaption(1))).length, 3, 'a Chinese caption stays');
  const r = await coverRig({ finder: request => found({ 1: [cand(1)], ...(coverSlotOf(request) ? { 0: [coverCand(1, { caption: zhCaption(1), title: 'Mountain lake', description: 'A lake in the Alps' })] } : {}) }) });
  await run(r);
  assert.match(coverBlockOf(r.raw(0)), /\n這張圖可能對不上\n/);
});

test('cover run: a candidate whose source page is not a Commons file page cannot be placed: not found, no topic-cover', async () => {
  const r = await coverRig({ finder: request => found({ 1: [cand(1)], ...(coverSlotOf(request) ? { 0: [coverCand(1, { source: 'https://example.org/page', caption: zhCaption(1) })] } : {}) }) });
  await run(r);
  assert.equal(topicCover(r.raw(0)), undefined);
  assert.match(coverBlockOf(r.raw(0)), /沒找到合適的封面圖/);
});

test('cover run: a stop during the download: the late bytes are dropped, no file, no block, no topic-cover', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const r = await coverRig({ net: { respond: async () => { await gate; return { status: 200, headers: { 'content-type': 'image/png' }, bytes: PNG.buffer.slice(0) }; } } });
  await r.runs.start(r.mapPath);
  await r.runs.confirmGate1(r.mapPath);
  for (let i = 0; i < 400 && !r.net.length; i++) await tick();
  assert.ok(r.net.length, 'the download started');
  await r.runs.stop(r.mapPath);
  release();
  while (r.runs.isRunning(r.mapPath)) await tick();
  await settle();
  assert.equal(r.files.size, 0, 'nothing saved after the stop');
  assert.ok(!/book-cover/.test(r.raw(0)) && topicCover(r.raw(0)) === undefined);
});

test('cover run: the body slots, the proof stage and the picture count are the same with and without a cover', async () => {
  const finder = request => found({ 1: [cand(1)], 2: [cand(2)], ...(coverSlotOf(request) ? { 0: [coverCand(7, { caption: zhCaption(7) })] } : {}) });
  const bodyOnly = async cover => { const r = await coverRig({ cover, slots: 2, text: twoMarkers, finder }); await run(r); const note = await r.note(0); return { detail: note.detail, stage: stageOf(r.raw(0)), record: recordOf(note.detail), issue: /^pipeline-issue: .*$/m.exec(r.raw(0))?.[0], calls: r.calls.length }; };
  const without = await bodyOnly(null); const withCover = await bodyOnly(coverAsk);
  const noProofIds = text => text.replace(/^> <!-- book-proof:v1 .*$/gm, '');
  assert.equal(noProofIds(withCover.detail), noProofIds(without.detail), 'the body text, captions and sources are byte for byte the same');
  assert.deepEqual(plain(withCover.record), plain(without.record)); assert.equal(withCover.stage, without.stage); assert.equal(withCover.issue, without.issue);
  assert.equal(withCover.calls, without.calls);
});
