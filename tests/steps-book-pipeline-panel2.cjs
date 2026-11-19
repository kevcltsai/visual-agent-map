// Picture-book gate 2 panel, card right-click, seam label, ETA and panel auto-open (04c). Part A drives a real BookPipelineRuns (fake AI ports,
// real repository fixture) to gate 2 and draws the panel from the notes it wrote; part B runs the view's own methods on the stand-in DOM.
// Real Obsidian look, focus ring and the 400px pane are UI evidence for the tester.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const S = require('./support.cjs');
const dom = require('./support-dom.cjs');
const { loadSource } = require('./support-replay.cjs');

const root = path.resolve(__dirname, '..');
const bundle = loadSource(`
export * from "./experiences/visual-map/book-pipeline-ui";
export * from "./experiences/visual-map/book-pipeline-panel";
export * from "./experiences/visual-map/book-pipeline-panel2";
export { BookPipelineRuns, BookPipelineRunError } from "./experiences/visual-map/book-pipeline-run";
export { VisualAgentMapView } from "./experiences/visual-map/view";
export { setUiLanguage } from "./i18n";
export { shortHash } from "./core/book-pipeline/image-slots";
`, { obsidian: { ...S.obsidian, Modal: dom.makeModal(), Notice: dom.makeNotice([]), Component: class {}, MarkdownRenderChild: class {} } }, { createFragment: dom.createFragment, requestAnimationFrame: () => 1, cancelAnimationFrame() {}, window: { setTimeout, clearTimeout, setInterval, clearInterval } });
const { setUiLanguage } = bundle;
const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const settle = async () => { for (let i = 0; i < 20; i++) await tick(); };
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const all = (el, cls) => dom.findAll(el, i => (i.cls ?? '').split(/\s+/).includes(cls));
const one = (el, cls) => all(el, cls)[0];
const texts = el => dom.findAll(el, i => i.text).map(i => i.text);
const EVIL = 'fine <img src=x onerror=alert(1)> ![pic](http://example.test/a.png)';

// ---- part A: real runner at gate 2 ----
const confirmDone = async (runs, mapPath) => { await runs.confirmGate1(mapPath); while (runs.isRunning(mapPath)) await new Promise(resolve => setImmediate(resolve)); };
async function rig() {
  setUiLanguage('zh-TW');
  const data = S.fixture('zh-TW');
  const { repo, contents } = data;
  const mapPath = await repo.createMap('Book');
  const doc = await repo.readMap(mapPath);
  const nodes = [];
  for (const title of ['Root', 'Da Vinci', 'Michelangelo']) nodes.push(await repo.createNote(title, 'model-a', doc, mapPath, 'workspace', { summary: `summary of ${title}` }));
  nodes.forEach((node, i) => { node.x = i * 300; node.y = 0; if (i) node.parentId = nodes[0].id; });
  await repo.updateMap(mapPath, d => { d.nodes.push(...nodes); });
  const stat = { author: [], proof: [] };
  const script = {
    proof: async request => ({ items: request.checklist.map(c => ({ id: c.id, type: c.type, status: 'met', note: EVIL, sources: [] })), aggregate: 'checked' }),
    author: async input => { await input.admission.reserve(); const note = await repo.readNote(input.path); const out = await repo.updateNoteGuarded(input.path, { detail: `Body of ${note.title}` }, { authorize: input.authorize, finalize: input.finalize }); return out === 'written' ? { outcome: 'written' } : { outcome: 'discarded' }; }
  };
  let queue = Promise.resolve();
  let ids = 0;
  const ports = {
    mutate: work => { const next = queue.then(work); queue = next.catch(() => undefined); return next; },
    readMap: p => repo.readMap(p), updateMap: (p, change) => repo.updateMap(p, change),
    readCard: async p => { const note = await repo.readNote(p); return { path: p, title: note.title, summary: note.summary, prompt: note.prompt, detail: note.detail, raw: contents.get(p), settings: note.bookSettings ?? {}, fields: { ...(note.pipelineStage ? { pipelineStage: note.pipelineStage } : {}), ...(note.bookRole ? { bookRole: note.bookRole } : {}), ...(note.pipelineIssue ? { pipelineIssue: note.pipelineIssue } : {}), ...(note.pipelineSeam ? { pipelineSeam: note.pipelineSeam } : {}) } }; },
    writePipelineFields: (p, patch) => repo.writePipelineFields(p, patch),
    updateNoteGuarded: (p, patch, options) => repo.updateNoteGuarded(p, patch, options),
    updateNoteRawGuarded: (p, transform, options) => repo.updateNoteRawGuarded(p, transform, options),
    runPlan: async (step, request, run) => {
      await run.admission.reserve();
      if (step.id === 'book-pipeline.global-plan') return { thread: 'one thread', cards: nodes.map((n, i) => ({ id: n.id, role: i ? 'body' : 'intro' })), materials: [{ name: 'm', use: 'u' }], decisions: {} };
      return { covers: `covers ${request.card.position}`, entry: 'entry', handoff: 'handoff', previous: 'p', next: 'n', checklist: [{ id: 'C1', type: 'structure', text: 'has a beginning' }] };
    },
    runProofread: async (request, run) => { stat.proof.push(request); await run.admission.reserve(); return script.proof(request); },
    author: input => { stat.author.push(input.nodeId); return script.author(input); },
    probeImage: async () => ({ ok: true }),
    backupNote: async p => ({ ok: true, path: `${p}.bak` }),
    blocked: () => false,
    config: () => ({ planModel: 'm1', authorModel: 'm2', imageModel: 'm4', proofModel: 'm3', reasoning: 'low', language: 'zh-TW' }),
    now: () => '2026-11-17T00:00:00.000Z', newId: () => `run-${++ids}`, log() {}
  };
  const runs = new bundle.BookPipelineRuns(ports);
  await runs.start(mapPath);
  await confirmDone(runs, mapPath);
  const noteOf = new Map();
  const reload = async () => { for (const n of nodes) noteOf.set(n.id, await repo.readNote(n.path)); };
  const state = new bundle.GatePanelState();
  const entries = [];
  let finishing = null;
  const draw = async (over = {}) => {
    await reload();
    const map = await repo.readMap(mapPath);
    const order = map.bookPipeline.order;
    const done = map.bookPipeline.phase === 'done';
    const parent = dom.element('div');
    const actions = {
      open: id => entries.push(['open', id]),
      rerun: id => { entries.push(['rerun', id]); return over.rerun ? over.rerun(id) : runs.rerunCard(mapPath, id).then(async result => { await reload(); return result; }); },
      confirmFinish: async info => { entries.push(['confirm', info]); return over.confirm === undefined ? true : over.confirm; },
      confirmSeam: id => { entries.push(['seam', id]); return runs.confirmSeam(mapPath, id).then(reload); },
      finish: () => { entries.push(['finish']); return runs.finishRun(mapPath); },
      showChat: () => entries.push(['chat']), close: () => entries.push(['close']),
      refresh: () => { current.panel.remove(); Object.assign(current, { panel: build() }); }
    };
    const build = () => bundle.renderGate2Panel(parent, bundle.buildGate2Panel({ order, titleOf: id => noteOf.get(id)?.title ?? id, noteOf: id => noteOf.get(id), startedAt: map.bookPipeline.startedAt, writingEndedAt: map.bookPipeline.phaseStartedAt }), done, state, actions, over.busy ?? new Set(), false, over.rerunNow);
    const current = { panel: build() };
    return { parent, get panel() { return current.panel; }, actions };
  };
  return { repo, runs, nodes, mapPath, stat, script, state, entries, draw, reload, noteOf, stateOf: async () => (await repo.readMap(mapPath)).bookPipeline };
}
const rowOf = (panel, id) => all(panel, 'vam-book-panel-row').find(r => r.dataset.row === id && r.dataset.kind !== 'seam');
const unmetProof = async request => ({ items: request.checklist.map(c => ({ id: c.id, type: c.type, status: 'unmet', note: 'missing', sources: [] })), aggregate: 'needs-review' });

test('gate 2 panel, nothing needs a person: one sentence "N 章都做好了" and the finish button; no card list, no proof record, no picture list', async () => {
  const r = await rig();
  assert.equal((await r.stateOf()).phase, 'gate2');
  const d = await r.draw();
  const panel = d.panel;
  assert.equal(panel.attrs.role, 'region');
  assert.equal(one(panel, 'vam-book-panel-g2-line').text, '3 章都做好了');
  assert.equal(one(panel, 'vam-book-panel-g2-line').dataset.state, 'clear');
  assert.equal(all(panel, 'vam-book-panel-row').length, 0, 'passed cards are not listed');
  assert.equal(all(panel, 'vam-book-panel-gate2-list').length, 0);
  assert.equal(dom.findAll(panel, i => ['vam-book-panel-proof', 'vam-book-panel-images', 'vam-book-panel-add-images'].some(c => (i.cls ?? '').split(/\s+/).includes(c))).length, 0);
  assert.equal(all(panel, 'vam-book-panel-finish').length, 1);
  assert.ok(!texts(panel).some(x => /通過|查證|\bC\d|\bN\d|proof/i.test(x)), JSON.stringify(texts(panel)));
  one(panel, 'vam-book-panel-finish').click();
  await settle();
  assert.equal(r.entries.filter(x => x[0] === 'confirm').length, 0, 'no question when nothing is left');
  assert.equal((await r.stateOf()).phase, 'done');
});

test('gate 2 panel, a card that needs a person: the sentence counts it, only that card is listed with a plain reason (no codes), rerun and "我自己改"; neighbours with an unconfirmed join are listed too and the join can be confirmed', async () => {
  const r = await rig();
  r.script.proof = unmetProof;
  await r.runs.rerunCard(r.mapPath, r.nodes[1].id);
  const d = await r.draw();
  const line = one(d.panel, 'vam-book-panel-g2-line');
  assert.equal(line.text, '3 章已產出，3 章仍需注意', 'the card and both neighbours (their join is not confirmed)');
  assert.equal(line.dataset.state, 'attention');
  const row = rowOf(d.panel, r.nodes[1].id);
  assert.equal(row.dataset.kind, 'attention');
  assert.ok(!texts(d.panel).some(x => /\b[CN]\d+\b|proof|unmet/i.test(x)), JSON.stringify(texts(d.panel)));
  assert.ok(texts(row).some(x => x.includes('missing')), 'the proof note in words');
  assert.equal(one(row, 'vam-book-panel-rerun-card').text, '重跑這張');
  assert.equal(one(row, 'vam-book-panel-open').text, '我自己改');
  one(row, 'vam-book-panel-open').click();
  assert.deepEqual(r.entries.at(-1), ['open', r.nodes[1].id]);
  const neighbour = rowOf(d.panel, r.nodes[0].id);
  assert.ok(texts(neighbour).some(x => x.includes('銜接')), JSON.stringify(texts(neighbour)));
  const confirm = one(neighbour, 'vam-book-panel-confirm-seam');
  assert.ok(confirm.attrs['aria-label']);
  confirm.click();
  assert.deepEqual(r.entries.at(-1), ['seam', r.nodes[0].id]);
  await settle();
  assert.equal(r.noteOf.get(r.nodes[0].id).pipelineSeam, undefined, 'the seam is gone from the note');
  assert.equal(rowOf(one(d.parent, 'vam-book-panel-gate2') ?? d.panel, r.nodes[0].id), undefined, 'the confirmed card leaves the list');
});

test('gate 2 panel: "rerun this card" calls rerunBookCard for that card and is disabled while anything runs; a refusal shows its reason on the row', async () => {
  const r = await rig();
  r.script.proof = unmetProof;
  await r.runs.rerunCard(r.mapPath, r.nodes[1].id);
  for (const n of [r.nodes[0], r.nodes[2]]) await r.runs.confirmSeam(r.mapPath, n.id);
  const hold = defer();
  const d = await r.draw({ rerun: async () => { await hold.promise; } });
  const row = rowOf(d.panel, r.nodes[1].id);
  one(row, 'vam-book-panel-rerun-card').click();
  assert.deepEqual(r.entries.at(-1), ['rerun', r.nodes[1].id]);
  const again = rowOf(d.panel, r.nodes[1].id);
  assert.equal(one(again, 'vam-book-panel-rerun-card').disabled, true);
  assert.equal(all(d.panel, 'vam-book-panel-finish')[0].disabled, true);
  hold.resolve(); await settle();
  assert.equal(one(rowOf(d.panel, r.nodes[1].id), 'vam-book-panel-rerun-card').disabled, false);
  const busy = await r.draw({ busy: new Set([r.nodes[2].id]) });
  assert.equal(all(busy.panel, 'vam-book-panel-rerun-card').every(b => b.disabled), true, 'a card the runner is working on locks the others');
  const refused = await r.draw({ rerun: async () => { throw new bundle.BookPipelineRunError('busy', 'x'); } });
  one(rowOf(refused.panel, r.nodes[1].id), 'vam-book-panel-rerun-card').click();
  await settle();
  assert.ok(texts(rowOf(refused.panel, r.nodes[1].id)).some(x => /[一-鿿]/.test(x)), 'a Chinese reason line');
});

test('finish: the review-finished button moves gate2 to done, a second press is idempotent, and a non-gate2 run refuses', async () => {
  const r = await rig();
  const d = await r.draw();
  one(d.panel, 'vam-book-panel-finish').click();
  await settle();
  assert.equal((await r.stateOf()).phase, 'done');
  const after = await r.draw();
  assert.equal(all(after.panel, 'vam-book-panel-finish').length, 0, 'done: no finish button');
  await r.runs.finishRun(r.mapPath);
  assert.equal((await r.stateOf()).phase, 'done');
  assert.equal(r.runs.getProgress(r.mapPath).phase, 'done', 'the runner reports done right after the acceptance');
  assert.equal(bundle.bookTitleText(bundle.bookBarState(await r.stateOf(), r.runs.getProgress(r.mapPath), () => undefined)).includes('驗收'), false, 'the bar title no longer says it waits for acceptance');
  const early = await rig();
  await early.runs.rerunCard(early.mapPath, early.nodes[1].id);
  const g1 = await rig();
  await g1.repo.updateMap(g1.mapPath, doc => { doc.bookPipeline.phase = 'gate1'; });
  await assert.rejects(() => g1.runs.finishRun(g1.mapPath), e => e instanceof bundle.BookPipelineRunError);
});

test('card label: a card with a seam shows the "seam to check" label with its reason as title', async () => {
  setUiLanguage('zh-TW');
  const header = dom.element('div');
  bundle.renderBookCardLabels(header, bundle.bookCardView({ pipelineStage: 'checked', pipelineSeam: 'x（第 2 張，版本 1）' }));
  const seam = one(header, 'is-seam');
  assert.equal(seam.text, '接縫需看');
  assert.ok(seam.attrs.title);
  const plain = dom.element('div');
  bundle.renderBookCardLabels(plain, bundle.bookCardView({ pipelineStage: 'checked' }));
  assert.equal(all(plain, 'is-seam').length, 0);
});

test('bar ETA: shown only while planning or writing and only with an estimate (the runner gives none below five finished cards)', () => {
  setUiLanguage('zh-TW');
  const data = { v: 1, runId: 'r', phase: 'writing', status: 'running', order: ['a', 'b'], budget: { used: 1, limit: 300 }, revision: 1, startedAt: 'x', phaseStartedAt: 'x' };
  const progress = over => ({ runId: 'r', phase: 'writing', status: 'running', active: true, total: 6, counts: { pending: 0, planned: 0, written: 6, checked: 0, 'needs-review': 0 }, budget: { used: 1, limit: 300 }, startedAt: 'x', phaseStartedAt: 'x', busyCards: [], ...over });
  const draw = p => { const bar = dom.element('div'); bundle.renderBookBar(bar, bundle.bookBarState(data, p, () => undefined), { stop() {}, resume() {}, addBudget() {}, confirmGate1() {} }); return bar; };
  assert.equal(all(draw(progress({})), 'vam-book-bar-eta').length, 0, 'under five finished cards: no ETA');
  const shown = all(draw(progress({ etaSeconds: 600 })), 'vam-book-bar-eta');
  assert.equal(shown.length, 1);
  assert.ok(shown[0].text.includes('10'));
  assert.equal(all(draw(progress({ phase: 'gate2', active: false, etaSeconds: 600 })), 'vam-book-bar-eta').length, 0);
});

// ---- part B: the view ----
const MAP = 'Agent Workspace/Topics/map-bk2/Map.md';
async function viewRig({ book = true, phase = 'gate2' } = {}) {
  setUiLanguage('zh-TW');
  const { repo, app } = S.fixture('zh-TW', { linkIndex: true });
  const settings = { ...S.DEFAULT_SETTINGS, language: 'zh-TW', cliModel: 'gpt-6-luna' };
  repo.settings = settings;
  const mapDoc = { id: 'map-bk2', title: 'BK', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  await repo.ensureTopicFolders('Agent Workspace/Topics/map-bk2');
  const ids = [];
  for (const key of ['root', 'a']) {
    const created = await repo.createNote(key, 'gpt-6-luna', mapDoc, MAP, 'workspace', { summary: `summary of ${key}` });
    Object.assign(created, { parentId: ids.length ? ids[0] : null, x: 0, y: mapDoc.nodes.length * 100 });
    mapDoc.nodes.push(created); ids.push(created.id);
  }
  if (book) mapDoc.bookPipeline = { v: 1, runId: 'r1', phase, status: 'running', order: ids, globalPlanned: true, attempts: { global: 1 }, revisions: {}, budget: { used: 1, limit: 300 }, revision: 1, startedAt: '2026-11-17T00:00:00.000Z', phaseStartedAt: '2026-11-17T00:00:00.000Z' };
  await app.vault.create(MAP, S.core.serializeMap(mapDoc));
  await repo.rebuildDerivedData();
  const calls = [];
  const plugin = S.withExpansionCoordinator({ repo, settings, running: new Set(), logs: { appendLog() {} }, rebuildDerivedData: () => repo.rebuildDerivedData(), relevanceGrades: new Map(), expansionBatches: new Map(), pendingSuggestions: new Map(), releaseOutline() {}, setOutlineActive() {}, detailsShown: () => false, mutate: work => Promise.resolve().then(work), getBookPipelineProgress: () => undefined, argumentRuns: { isRunning: () => false }, rerunBookCard: async (p, id) => { calls.push(['rerun', p, id]); } });
  S.attachTopicRuns(plugin);
  const view = new bundle.VisualAgentMapView({ app }, plugin);
  view.path = MAP; view.map = await repo.readMap(MAP); view.stageEl = dom.element('div'); view.contentEl = dom.element('div');
  view.notes = new Map(await Promise.all(view.map.nodes.map(async n => [n.id, await repo.readNote(n.path)])));
  view.render = () => {};
  const log = [];
  view.chat = { isHero: false, isOpen: true, setOpen: (open, focus) => { log.push(['chat', open, !!focus]); } };
  const progress = over => { plugin.getBookPipelineProgress = () => over; };
  const menu = node => { const items = []; const m = { addItem(build) { const it = {}; const chain = { setTitle(v) { it.title = v; return chain; }, setIcon(v) { it.icon = v; return chain; }, setDisabled(v) { it.disabled = !!v; return chain; }, onClick(fn) { it.click = fn; return chain; } }; build(chain); items.push(it); return m; }, addSeparator() { items.push({ separator: true }); return m; } }; view.addCardMenuActions(m, node); return items; };
  const prog = (phase2, extra = {}) => ({ runId: 'r1', phase: phase2, status: 'running', active: false, total: 2, counts: { pending: 0, planned: 0, written: 0, checked: 2, 'needs-review': 0 }, budget: { used: 1, limit: 300 }, startedAt: 'x', phaseStartedAt: 'x', busyCards: [], ...extra });
  return { view, plugin, log, calls, progress, menu, prog, mount: () => { const workspace = dom.element('div'); view.mountBookPanel(workspace); return workspace; } };
}

test('right-click: the rerun item and its disabled sub line show at gate 2 and done (not at gate 1, where a trial retry replaces it); busy or active disables; clicking calls rerunBookCard and rereads the card', async () => {
  const h = await viewRig();
  const node = h.view.map.nodes[1];
  h.progress(h.prog('gate1'));
  assert.ok(h.menu(node).every(i => i.title !== '重跑圖文書這一張'), 'no rerun item at gate 1');
  for (const phase of ['gate2', 'done']) {
    h.progress(h.prog(phase));
    const items = h.menu(node);
    const at = items.findIndex(i => i.title === '重跑圖文書這一張');
    assert.ok(at >= 0, phase);
    assert.equal(items[at].disabled, false);
    // The second line is a note (never the permanent grey "disabled" line it was): it describes the rerun while it can be used.
    assert.equal(items[at + 1].title, '企劃 → 寫 → 校，約 2 分鐘；前後章不動，只標「接縫需看」');
    assert.notEqual(items[at + 1].disabled, true);
  }
  // When it cannot be used the second line says why.
  const why = progressOver => { h.progress(h.prog('gate2', progressOver)); const items = h.menu(node); const at = items.findIndex(i => i.title === '重跑圖文書這一張'); return { disabled: items[at].disabled, line: items[at + 1].title }; };
  assert.deepEqual(why({ active: true }), { disabled: true, line: '圖文書正在執行，等它結束後再重跑' });
  assert.deepEqual(why({ busyCards: [node.id] }), { disabled: true, line: '這一張正在重跑' });
  assert.deepEqual(why({ rerun: { nodeId: node.id, startedAt: 1 } }), { disabled: true, line: '這一張正在重跑' });
  assert.deepEqual(why({ rerun: { nodeId: 'other', startedAt: 1 } }), { disabled: true, line: '另一張正在重跑' });
  h.view.chatChainRunner = { current: {} };
  assert.deepEqual(why({}), { disabled: true, line: '對話進行中，等它結束後再重跑' });
  h.view.chatChainRunner = null;
  h.progress(h.prog('writing'));
  assert.equal(h.menu(node).some(i => i.title === '重跑圖文書這一張'), false, 'not while planning or writing');
  h.progress(h.prog('gate2'));
  let reread = 0;
  h.view.rereadBookCard = async () => { reread++; };
  h.menu(node).find(i => i.title === '重跑圖文書這一張').click();
  await settle();
  assert.deepEqual(h.calls, [['rerun', MAP, node.id]]);
  assert.equal(reread, 1);
});

test('right-click rerun through the view: "same result" lands on the panel state (block with both actions), a changed result clears the old mark', async () => {
  const h = await viewRig();
  const node = h.view.map.nodes[1];
  h.progress(h.prog('gate2'));
  h.view.rereadBookCard = async () => {};
  h.view.paintBookPanel = () => {};
  let next = { unchanged: true };
  h.plugin.rerunBookCard = async () => next;
  const click = async () => { h.menu(node).find(i => i.title === '重跑圖文書這一張').click(); await settle(); };
  await click();
  assert.ok(h.view.bookPanel.unchanged.has(node.id), 'the same result is remembered');
  next = { unchanged: false };
  await click();
  assert.ok(!h.view.bookPanel.unchanged.has(node.id), 'a changed result clears it');
  const view_ts = fs.readFileSync(path.join(root, 'experiences/visual-map/view.ts'), 'utf8');
  assert.match(view_ts, /runTrackedRerun\(this\.bookPanel, node\.id,/);
  assert.match(view_ts, /dom\?\.setAttr\("aria-disabled", "true"\)/);
});

test('right-click: a map without bookPipeline gets the same items as before (no rerun item, no extra separator)', async () => {
  const h = await viewRig({ book: false });
  const node = h.view.map.nodes[1];
  const items = h.menu(node);
  assert.equal(items.some(i => /圖文書/.test(i.title ?? '')), false);
  const rebuilt = h.menu(node).map(i => i.title ?? '|');
  assert.equal(rebuilt.filter(x => x === '|').length, 3, 'the three separators it always had');
});

test('auto-open: first sight of a gate (reopened map) does not open; a drive reaching a gate opens once, without taking focus; a manual close keeps it shut; a new gate opens again', async () => {
  const h = await viewRig({ phase: 'gate1' });
  h.progress(h.prog('gate1'));
  h.mount();
  assert.equal(h.view.bookPanel.open, false, 'reopened at gate 1: not opened');
  h.progress(h.prog('writing', { active: true }));
  h.mount();
  assert.equal(h.view.bookPanel.open, false);
  h.progress(h.prog('gate2', { active: true }));
  h.mount();
  assert.equal(h.view.bookPanel.open, false, 'still driving');
  h.view.map = { ...h.view.map, bookPipeline: { ...h.view.map.bookPipeline, phase: 'gate2' } }; h.view.bookPipelineSeen = null;
  h.progress(h.prog('gate2'));
  const workspace = h.mount();
  assert.equal(h.view.bookPanel.open, true);
  assert.ok(one(workspace, 'vam-book-side'));
  assert.equal(h.view.bookPanel.pendingFocus, null, 'focus not taken');
  assert.deepEqual(h.log, [['chat', false, false]], 'the chat folds like the button does');
  h.view.closeBookPanel();
  assert.equal(h.view.bookPanel.open, false);
  h.mount(); h.mount();
  assert.equal(h.view.bookPanel.open, false, 'closed by hand: not again for this run and gate');
  h.progress(h.prog('writing', { active: true })); h.mount();
  h.progress(h.prog('gate2')); h.mount();
  assert.equal(h.view.bookPanel.open, false, 'same run, same gate stays handled');
  h.progress({ ...h.prog('writing', { active: true }), runId: 'r2' }); h.mount();
  h.progress({ ...h.prog('gate1'), runId: 'r2' }); h.mount();
  assert.equal(h.view.bookPanel.open, true, 'a new run reaching its gate opens');
});

test('auto-open: a map with no bookPipeline never opens a panel', async () => {
  const h = await viewRig({ book: false });
  h.mount();
  assert.equal(h.view.bookPanel.open, false);
  assert.equal(h.log.length, 0);
});

test('styles: the gate 2 sentence, the row and the seam classes exist, use theme variables only and have focus rings; the folded-record and picture-list rules are gone; the view has the wiring', () => {
  for (const cls of ['vam-book-panel-state', 'vam-book-state.is-seam', 'vam-book-bar-eta', 'vam-book-panel-summary', 'vam-book-panel-g2-line', 'vam-book-panel-actions', 'vam-book-panel-row']) assert.ok(css.includes(`.${cls}`), cls);
  const rules = css.split('\n').filter(line => /^\.vam-book-(panel-(state|summary|row|actions)|state\.is-seam|bar-eta)/.test(line)).join('\n');
  assert.ok(rules.length > 300);
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(rules) && !/\brgba?\(/.test(rules), 'no hard-coded colour');
  assert.ok(!/vam-book-panel-(proof|images|image-row|unchanged)|vam-book-steps/.test(css), 'no rule is left for removed parts');
  assert.match(css, /\.vam-book-panel-row button:focus-visible[^}]*outline: 2px solid var\(--interactive-accent\)/);
  assert.match(css, /@media \(max-width: 700px\) \{[^}]*vam-book-panel-row/);
  const view_ts = fs.readFileSync(path.join(root, 'experiences/visual-map/view.ts'), 'utf8');
  assert.match(view_ts, /this\.addBookRerunMenuItem\(menu, node\);/);
  assert.match(view_ts, /if \(this\.bookPanelPath\) this\.maybeAutoOpenBookPanel\(\);/);
});

test('finish after a rerun that stays needs-review: the finish button is enabled and the run reaches done', async () => {
  const r = await rig();
  r.script.proof = unmetProof;
  await r.runs.rerunCard(r.mapPath, r.nodes[1].id);
  await r.runs.rerunCard(r.mapPath, r.nodes[2].id);
  assert.equal(r.runs.isRunning(r.mapPath), false, 'no drive left behind');
  const saved = await r.stateOf();
  assert.equal(saved.phase, 'gate2');
  const d = await r.draw();
  const finish = one(d.panel, 'vam-book-panel-finish');
  assert.equal(finish.disabled, false, JSON.stringify({ status: saved.status, phase: saved.phase }));
  finish.click();
  await settle();
  assert.equal((await r.stateOf()).phase, 'done', one(d.panel, 'vam-book-panel-status').children.map(c => c.text).join());
});

test('finish: a disabled button says why in the aria-live status line; a refusal text shows there too', async () => {
  const r = await rig();
  const parent = dom.element('div');
  const noop = () => undefined;
  const actions = { open: noop, rerun: async () => {}, confirmSeam: async () => {}, finish: async () => { throw new bundle.BookPipelineRunError('busy', 'x'); }, showChat: noop, close: noop, refresh: () => { panel.remove(); panel = build(); } };
  const state = new bundle.GatePanelState();
  const view = () => bundle.buildGate2Panel({ order: [], titleOf: id => id, noteOf: () => undefined, startedAt: undefined, writingEndedAt: undefined });
  let active = true;
  const build = () => bundle.renderGate2Panel(parent, view(), false, state, actions, new Set(), active);
  let panel = build();
  assert.equal(one(panel, 'vam-book-panel-finish').disabled, true, 'a live drive with no busy card still waits');
  const status = one(panel, 'vam-book-panel-status');
  assert.equal(status.attrs['aria-live'], 'polite');
  assert.ok(texts(status).join('').length > 0, 'the wait is explained');
  active = false; panel.remove(); panel = build();
  assert.equal(one(panel, 'vam-book-panel-finish').disabled, false);
  assert.equal(texts(one(panel, 'vam-book-panel-status')).join(''), '');
  one(panel, 'vam-book-panel-finish').click(); await settle();
  assert.ok(texts(one(panel, 'vam-book-panel-status')).join('').length > 0, 'a refusal is visible');
});



// ---- the single "needs attention" decision, the sentence, the list, the finish question ----
const PROOF = items => `### Research notes\n\n<!-- book-proof:v1 ${JSON.stringify({ key: 'k', result: { aggregate: 'checked', items } })} -->\n`;
const SLOTS_PROMPT = '圖安排：\n- 圖位 1｜圖表｜睡眠週期｜位置：第二段\n- 圖位 2｜照片｜腦波｜位置：結尾\n';
const IMG = 'https://example.test/p.png';
const SLOTS_REC = state => `<!-- book-slots:v1 ${JSON.stringify({ slots: [{ index: 1, state, ...(state === 'missing' ? { reasonCode: 'not_found' } : { hash: bundle.shortHash(IMG) }) }, { index: 2, state: 'missing', reasonCode: 'not_found' }], bad: 0 })} -->\n`;
function synth(extra = {}, only) {
  setUiLanguage('zh-TW');
  const notes = new Map();
  const add = (id, fields) => notes.set(id, { title: `T${id}`, prompt: '', summary: '', ...fields });
  // A fine card: checked, one of two optional pictures missing (not a reason by itself).
  add('fine', { pipelineStage: 'checked', prompt: SLOTS_PROMPT, detail: `text\n\n![x](${IMG})\n\n${SLOTS_REC('placed')}` });
  add('fail', { pipelineStage: 'needs-review', pipelineIssue: 'proof unmet: C1', prompt: '圖安排：無\n', detail: PROOF([{ id: 'C1', type: 'fact', status: 'unmet', note: 'C1: Xie 2013 沒能打開核對', sources: [] }]) });
  add('unfinished', { pipelineStage: 'planned' });
  add('old', { pipelineStage: 'needs-review', pipelineIssue: 'proof unmet: C1', prompt: 'Role: body', detail: '' });
  for (const [k, v] of Object.entries(extra)) add(k, v);
  for (const id of [...notes.keys()]) if (only && !only.includes(id)) notes.delete(id);
  const order = [...notes.keys()];
  return { notes, order, data: () => bundle.buildGate2Panel({ order, titleOf: id => notes.get(id).title, noteOf: id => notes.get(id) }) };
}
const baseActions = (log = []) => ({
  open: id => log.push(['open', id]), rerun: async id => { log.push(['rerun', id]); return { unchanged: true }; }, confirmSeam: async id => { log.push(['seam', id]); },
  finish: async () => { log.push(['finish']); }, confirmFinish: async info => { log.push(['confirm', info]); return true; },
  showChat() {}, close() {}, refresh() {}
});
const lineOf = r => one(bundle.renderGate2Panel(dom.element('div'), r.data(), false, new bundle.GatePanelState(), baseActions()), 'vam-book-panel-g2-line').text;

test('the one decision: needs-review, unfinished, checked with unmet structure, checked with unconfirmed facts, a bare gallery chapter and an unconfirmed join all keep the panel from saying "都做好了"; a missing optional picture does not', () => {
  const structure = JSON.stringify([{ id: 'S1', type: 'structure', status: 'unmet', note: '', sources: [] }]);
  const cases = {
    structure: { pipelineStage: 'checked', pipelineIssue: 'structure unmet: S1 S2', prompt: '圖安排：無\n', detail: PROOF(JSON.parse(structure)) },
    facts: { pipelineStage: 'checked', prompt: '圖安排：無\n', detail: PROOF([{ id: 'C1', type: 'fact', status: 'unverified', note: 'x', sources: [] }, { id: 'C2', type: 'fact', status: 'met', note: '', sources: [] }]) },
    gallery: { pipelineStage: 'checked', bookRole: 'gallery', prompt: SLOTS_PROMPT, detail: `text\n\n<!-- book-slots:v1 ${JSON.stringify({ slots: [{ index: 1, state: 'missing', reasonCode: 'not_found' }, { index: 2, state: 'missing', reasonCode: 'not_found' }], bad: 0 })} -->\n` },
    seam: { pipelineStage: 'checked', pipelineSeam: '前後章變了（第 2 張，版本 2）', prompt: '圖安排：無\n', detail: 'plain' },
    review: { pipelineStage: 'needs-review', pipelineIssue: 'write failed: invalid_reply' },
    unfinished: { pipelineStage: 'written' }
  };
  const clean = synth({}, ['fine']);
  assert.equal(lineOf(clean), '1 章都做好了', 'a checked card with one optional picture missing is fine');
  for (const [name, fields] of Object.entries(cases)) {
    const r = synth({ x: fields }, ['fine', 'x']);
    assert.equal(lineOf(r), '2 章已產出，1 章仍需注意', name);
    const card = r.data().cards.find(c => c.id === 'x');
    assert.ok(bundle.needsAttention(card), name);
    assert.ok(bundle.attentionReasons(card).every(x => x && !/\b[CN]\d+\b|unmet|proof/i.test(x)), `${name}: ${JSON.stringify(bundle.attentionReasons(card))}`);
  }
  // A picture-only gap in an ordinary chapter, or an unrecorded slot, stays quiet.
  const gap = synth({ g: { pipelineStage: 'checked', prompt: SLOTS_PROMPT, detail: `text\n\n<!-- book-slots:v1 ${JSON.stringify({ slots: [{ index: 1, state: 'missing', reasonCode: 'not_found' }, { index: 2, state: 'missing', reasonCode: 'not_found' }], bad: 0 })} -->\n` }, u: { pipelineStage: 'checked', prompt: SLOTS_PROMPT, detail: 'plain' } }, ['g', 'u']);
  assert.equal(lineOf(gap), '2 章都做好了');
  const imageToken = synth({ i: { pipelineStage: 'checked', pipelineIssue: 'structure unmet: image_1', prompt: '圖安排：無\n', detail: 'plain' } }, ['i']);
  assert.equal(lineOf(imageToken), '1 章都做好了', 'a picture token is not a structure item');
});

test('gate 2 list: only the cards that need a person, each with name, one plain reason and the two actions; no passed card, no proof record, no picture row, no code in any text', async () => {
  const r = synth();
  const log = [];
  const panel = bundle.renderGate2Panel(dom.element('div'), r.data(), false, new bundle.GatePanelState(), baseActions(log));
  assert.equal(one(panel, 'vam-book-panel-g2-line').text, '4 章已產出，3 章仍需注意');
  const rows = all(panel, 'vam-book-panel-row');
  assert.deepEqual(rows.map(x => x.dataset.row), ['fail', 'unfinished', 'old']);
  const failRow = rows[0];
  assert.ok(texts(failRow).includes('2 Tfail'));
  assert.ok(texts(failRow).some(x => x.includes('Xie 2013 沒能打開核對') && !/C1/.test(x)), 'the note without its code');
  assert.ok(texts(rows[1]).includes('這章還沒完成'));
  assert.ok(texts(rows[2]).every(x => !/proof unmet/.test(x)), 'an old card with no record still reads as a plain sentence');
  one(failRow, 'vam-book-panel-open').click();
  assert.deepEqual(log.at(-1), ['open', 'fail']);
  assert.equal(all(panel, 'vam-book-panel-rerun-card').length, 3);
  assert.equal(all(panel, 'vam-book-panel-confirm-seam').length, 0, 'the join button only where a join is open');
  assert.ok(!texts(panel).some(x => /\b[CN]\d+\b|proof|^通過|查證|自己加圖|沒找到合適的圖/i.test(x)), JSON.stringify(texts(panel)));
  assert.ok(!texts(panel).some(x => /地圖/.test(x)));
});

test('gate 2: a rerun left unchanged marks the row "還是要你看"; a second rerun clears it; the right-click path lands on the same mark', async () => {
  const r = synth({}, ['fail']);
  const log = [];
  const state = new bundle.GatePanelState();
  let panel;
  const actions = { ...baseActions(log), refresh() { panel.remove(); panel = draw(); } };
  const parent = dom.element('div');
  const draw = () => bundle.renderGate2Panel(parent, r.data(), false, state, actions);
  panel = draw();
  const row = () => all(panel, 'vam-book-panel-row').find(x => x.dataset.row === 'fail');
  assert.ok(!texts(row()).includes('還是要你看'), 'not before a rerun');
  one(row(), 'vam-book-panel-rerun-card').click();
  await settle();
  assert.deepEqual(log.at(-1), ['rerun', 'fail']);
  assert.ok(state.unchanged.has('fail'));
  assert.ok(texts(row()).includes('還是要你看'));
  await bundle.runTrackedRerun(state, 'fail', async () => ({ unchanged: false }));
  assert.ok(!state.unchanged.has('fail'), 'a changed result clears the old mark');
  await bundle.runTrackedRerun(state, 'fail', async () => ({ unchanged: true }));
  let seen;
  await bundle.runTrackedRerun(state, 'fail', async () => { seen = state.unchanged.has('fail'); return undefined; });
  assert.equal(seen, false, 'cleared before the run starts');
  await assert.rejects(() => bundle.runTrackedRerun(state, 'fail', async () => { throw new Error('x'); }));
  assert.ok(!state.unchanged.has('fail'));
});

test('gate 2: finish asks once when something is left (count and names), not when nothing is; "go back" does not finish; a card still working beats the question', async () => {
  const r = synth();
  const log = [];
  const state = new bundle.GatePanelState();
  const press = panel => one(panel, 'vam-book-panel-finish').click();
  const answer = { yes: false };
  const actions = { ...baseActions(log), confirmFinish: async info => { log.push(['confirm', info]); return answer.yes; } };
  const panel = bundle.renderGate2Panel(dom.element('div'), r.data(), false, state, actions);
  press(panel);
  await settle();
  assert.deepEqual(log.filter(x => x[0] === 'confirm').map(x => [x[1].count, x[1].titles]), [[3, ['2 Tfail', '3 Tunfinished', '4 Told']]]);
  assert.equal(log.filter(x => x[0] === 'finish').length, 0);
  assert.equal(state.finishAsking, false);
  answer.yes = true;
  press(panel);
  await settle();
  assert.equal(log.filter(x => x[0] === 'confirm').length, 2);
  assert.equal(log.filter(x => x[0] === 'finish').length, 1);
  const clean = synth({}, ['fine']);
  const log2 = [];
  const p2 = bundle.renderGate2Panel(dom.element('div'), clean.data(), false, new bundle.GatePanelState(), baseActions(log2));
  press(p2);
  await settle();
  assert.deepEqual(log2.map(x => x[0]), ['finish']);
  const log3 = [];
  const p3 = bundle.renderGate2Panel(dom.element('div'), r.data(), false, new bundle.GatePanelState(), baseActions(log3), new Set(['fail']));
  assert.equal(one(p3, 'vam-book-panel-finish').disabled, true);
  press(p3);
  await settle();
  assert.deepEqual(log3, [], 'busy comes first');
});

test('gate 2: the card being rerun shows "處理中" (no clock) instead of its state', () => {
  const r = synth();
  const panel = bundle.renderGate2Panel(dom.element('div'), r.data(), false, new bundle.GatePanelState(), baseActions(), new Set(['fail']), true, { nodeId: 'fail', startedAt: 12345 });
  const row = all(panel, 'vam-book-panel-row').find(x => x.dataset.row === 'fail');
  assert.ok(texts(row).includes('處理中'), JSON.stringify(texts(row)));
  assert.ok(!texts(row).includes('要你看'));
  assert.ok(!texts(row).some(x => /\d:\d\d/.test(x)), 'no clock');
});

test('gate 2: the sentence and the actions read in English and Simplified Chinese (no 地圖 in zh-TW, no codes)', () => {
  for (const [lang, line] of [['en', /still need attention/], ['zh-CN', /仍需注意/]]) {
    const r = synth();
    setUiLanguage(lang);
    const panel = bundle.renderGate2Panel(dom.element('div'), r.data(), false, new bundle.GatePanelState(), baseActions());
    assert.match(one(panel, 'vam-book-panel-g2-line').text, line, lang);
    assert.ok(!texts(panel).some(x => /\b[CN]\d+\b/.test(x)), lang);
  }
  setUiLanguage('zh-TW');
});
