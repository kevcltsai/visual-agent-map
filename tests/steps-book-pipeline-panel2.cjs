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
      rerun: (id, options) => { entries.push(['rerun', id, options]); return over.rerun ? over.rerun(id, options) : runs.rerunCard(mapPath, id, options).then(async result => { await reload(); return result; }); },
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

test('gate 2 panel: summary, a list of checked cards, no needs-review rows when all pass, the finish button and the hint', async () => {
  const r = await rig();
  assert.equal((await r.stateOf()).phase, 'gate2');
  const d = await r.draw();
  const panel = d.panel;
  assert.equal(panel.attrs.role, 'region');
  assert.ok(texts(panel).includes('3 張通過'), JSON.stringify(texts(panel)));
  assert.equal(all(panel, 'vam-book-panel-row').length, 3);
  assert.equal(all(one(panel, 'vam-book-panel-gate2-list'), 'vam-book-panel-state').length, 3);
  assert.equal(all(panel, 'vam-book-panel-finish').length, 1);
  assert.ok(one(panel, 'vam-book-panel-gate2-list').attrs['aria-label']);
});

test('gate 2 panel: a needs-review card shows its reason in Chinese, open and rerun buttons; neighbours get a seam row; confirming a seam calls confirmBookSeam and clears it', async () => {
  const r = await rig();
  r.script.proof = unmetProof;
  await r.runs.rerunCard(r.mapPath, r.nodes[1].id);
  const d = await r.draw();
  const attention = rowOf(d.panel, r.nodes[1].id);
  assert.equal(attention.dataset.kind, 'attention');
  assert.ok(texts(attention).some(x => x.startsWith('需人看') || x.includes('原因')), JSON.stringify(texts(attention)));
  assert.ok(!texts(attention).some(x => /^[a-z_]+$/.test(x)), 'no raw code shown');
  const seams = all(d.panel, 'vam-book-panel-row').filter(x => x.dataset.kind === 'seam');
  assert.equal(seams.length, 2, 'both neighbours');
  assert.ok(texts(seams[0]).includes('接縫需看'));
  const confirm = one(seams[0], 'vam-book-panel-confirm-seam');
  assert.ok(confirm.attrs['aria-label']);
  const target = seams[0].dataset.row;
  confirm.click();
  assert.deepEqual(r.entries.at(-1), ['seam', target]);
  await settle();
  assert.equal(r.noteOf.get(target).pipelineSeam, undefined, 'the seam is gone from the note');
  assert.equal(all(d.panel, 'vam-book-panel-row').filter(x => x.dataset.kind === 'seam').length, 1);
});

test('gate 2 panel: the proof record opens as plain text; <img onerror> and markdown images make no element', async () => {
  const r = await rig();
  const d = await r.draw();
  const row = rowOf(d.panel, r.nodes[1].id);
  const body = one(row, 'vam-book-panel-proof');
  assert.equal(body.hidden, true);
  const toggle = one(row, 'vam-book-panel-proof-toggle');
  assert.equal(toggle.attrs['aria-expanded'], 'false');
  toggle.click();
  assert.equal(body.hidden, false);
  assert.equal(toggle.attrs['aria-expanded'], 'true');
  const shown = texts(body).join('\n');
  assert.ok(shown.includes('onerror=alert(1)') && shown.includes('http://example.test/a.png'), shown);
  assert.equal(dom.findAll(d.panel, i => ['img', 'a', 'script'].includes(i.tag)).length, 0);
  assert.equal(dom.findAll(d.panel, i => i.attrs && ('onerror' in i.attrs || 'src' in i.attrs)).length, 0);
});

test('gate 2 panel: "rerun this card" calls rerunBookCard for that card and is disabled while anything runs; a refusal shows its reason on the row', async () => {
  const r = await rig();
  const hold = defer();
  const d = await r.draw({ rerun: async () => { await hold.promise; } });
  const row = rowOf(d.panel, r.nodes[2].id);
  one(row, 'vam-book-panel-rerun-card').click();
  assert.deepEqual(r.entries.at(-1), ['rerun', r.nodes[2].id, undefined]);
  const again = rowOf(d.panel, r.nodes[2].id);
  assert.equal(one(again, 'vam-book-panel-rerun-card').disabled, true);
  assert.equal(all(d.panel, 'vam-book-panel-finish')[0].disabled, true);
  hold.resolve(); await settle();
  assert.equal(one(rowOf(d.panel, r.nodes[2].id), 'vam-book-panel-rerun-card').disabled, false);
  const busy = await r.draw({ busy: new Set([r.nodes[1].id]) });
  assert.equal(all(busy.panel, 'vam-book-panel-rerun-card').every(b => b.disabled), true, 'a card the runner is working on locks the others');
  const refused = await r.draw({ rerun: async () => { throw new bundle.BookPipelineRunError('busy', 'x'); } });
  one(rowOf(refused.panel, r.nodes[1].id), 'vam-book-panel-rerun-card').click();
  await settle();
  assert.ok(texts(rowOf(refused.panel, r.nodes[1].id)).some(x => /[一-鿿]/.test(x) && x !== ''), 'a Chinese reason line');
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

test('right-click: the rerun item and its disabled sub line show at gate 1, gate 2 and done; busy or active disables; clicking calls rerunBookCard and rereads the card', async () => {
  const h = await viewRig();
  const node = h.view.map.nodes[1];
  for (const phase of ['gate1', 'gate2', 'done']) {
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

test('styles: the new gate 2 and seam classes exist, use theme variables only and have focus rings; the view has the wiring', () => {
  for (const cls of ['vam-book-panel-state', 'vam-book-state.is-seam', 'vam-book-bar-eta', 'vam-book-panel-summary', 'vam-book-panel-row', 'vam-book-panel-proof', 'vam-book-panel-proof-items']) assert.ok(css.includes(`.${cls}`), cls);
  const rules = css.split('\n').filter(line => /^\.vam-book-(panel-(state|summary|row|proof)|state\.is-seam|bar-eta)/.test(line)).join('\n');
  assert.ok(rules.length > 300);
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(rules) && !/\brgba?\(/.test(rules), 'no hard-coded colour');
  assert.match(css, /\.vam-book-panel-proof\[hidden\] \{ display: none; \}/, 'a folded proof record must stay folded: the class display:flex would otherwise beat the hidden attribute');
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


// ---- T5: lead line, reasons, picture rows, unchanged block, finish question, rerun clock ----
const PROOF = items => `### Research notes\n\n<!-- book-proof:v1 ${JSON.stringify({ key: 'k', result: { aggregate: 'needs-review', items } })} -->\n`;
const SLOTS_PROMPT = '圖安排：\n- 圖位 1｜圖表｜睡眠週期｜位置：第二段\n- 圖位 2｜照片｜腦波｜位置：結尾\n';
const IMG = 'https://example.test/p.png';
function synth(extra = {}) {
  setUiLanguage('zh-TW');
  const notes = new Map();
  const add = (id, fields) => notes.set(id, { title: `T${id}`, prompt: '', summary: '', ...fields });
  add('a', { pipelineStage: 'checked', prompt: SLOTS_PROMPT, detail: `text\n\n![x](${IMG})\n\n<!-- book-slots:v1 ${JSON.stringify({ slots: [{ index: 1, state: 'placed', hash: bundle.shortHash(IMG) }, { index: 2, state: 'missing', reasonCode: 'not_found' }], bad: 0 })} -->\n` });
  add('b', { pipelineStage: 'needs-review', pipelineIssue: 'proof unmet: C1', prompt: '圖安排：無\n', detail: PROOF([{ id: 'C1', type: 'fact', status: 'unverified', note: 'Xie 2013 沒能打開核對', sources: [`${IMG}/paper`, 'http://insecure.test/x'] }, { id: 'C2', type: 'fact', status: 'met', note: '', sources: [] }]) });
  add('c', { pipelineStage: 'checked', pipelineSeam: '前後章變了（第 2 張，版本 2）', prompt: SLOTS_PROMPT, detail: 'plain' });
  add('d', { pipelineStage: 'planned' });
  add('old', { pipelineStage: 'needs-review', pipelineIssue: 'proof unmet: C1', prompt: 'Role: body', detail: '' });
  for (const [k, v] of Object.entries(extra)) add(k, v);
  const order = [...notes.keys()];
  return { notes, order, data: () => bundle.buildGate2Panel({ order, titleOf: id => notes.get(id).title, noteOf: id => notes.get(id) }) };
}
const baseActions = (log = []) => ({
  open: id => log.push(['open', id]), rerun: async (id, options) => { log.push(['rerun', id, options]); return { unchanged: true }; }, confirmSeam: async () => {},
  finish: async () => { log.push(['finish']); }, confirmFinish: async info => { log.push(['confirm', info]); return true; },
  showChat() {}, close() {}, refresh() {}
});

test('T5 gate 2: one lead line (passed, review, seams, picture gaps); the reason is the proof note in words; the unverified https sources are kept for "use other sources"', () => {
  const r = synth();
  const data = r.data();
  assert.deepEqual([data.checked, data.needsReview, data.seams, data.imageGaps], [2, 2, 1, 1]);
  const panel = bundle.renderGate2Panel(dom.element('div'), data, false, new bundle.GatePanelState(), baseActions());
  assert.equal(one(panel, 'vam-book-panel-summary').text, '2 張通過，2 張要你看，1 個接縫還沒確認，圖有 1 處缺');
  const b = data.cards.find(card => card.id === 'b');
  assert.equal(b.reasonText, 'Xie 2013 沒能打開核對');
  assert.deepEqual([...b.avoidSources], [`${IMG}/paper`], 'only https, from the unverified items');
  assert.ok(!texts(panel).some(x => /^C\d/.test(x)), 'no item codes shown');
  // An older card (no image plan, no proof section) still draws and reads as a plain reason.
  const old = data.cards.find(card => card.id === 'old');
  assert.equal(old.images.planned, 0);
  assert.ok(old.reasonText && !/proof unmet/.test(old.reasonText));
});

test('T5 gate 2: picture rows say placed, no fitting picture, edited, unrecorded, or none planned; a gap has "add pictures myself" that opens the note; planned cards have no row', () => {
  const r = synth();
  const log = [];
  const panel = bundle.renderGate2Panel(dom.element('div'), r.data(), false, new bundle.GatePanelState(), baseActions(log));
  const rows = all(panel, 'vam-book-panel-image-row');
  assert.deepEqual(rows.map(x => x.dataset.row), ['a', 'b', 'c', 'old'], 'the planned card d has no picture row');
  const say = id => texts(rows.find(x => x.dataset.row === id)).join(' ');
  assert.match(say('a'), /1 張圖，1 處缺/);
  assert.match(say('a'), /圖 2：沒找到合適的圖/);
  assert.match(say('b'), /企劃未安排圖/);
  assert.match(say('c'), /尚未記錄圖的結果/);
  one(rows[0], 'vam-book-panel-add-images').click();
  assert.deepEqual(log.at(-1), ['open', 'a']);
  assert.equal(all(rows[1], 'vam-book-panel-add-images').length, 0);
  // The recorded picture is no longer in the text: it reads as edited; no record of a missing slot becomes a gap.
  const edited = synth({ e: { pipelineStage: 'checked', prompt: SLOTS_PROMPT, detail: `text <!-- x -->\n<!-- book-slots:v1 ${JSON.stringify({ slots: [{ index: 1, state: 'placed', hash: '00000000' }, { index: 2, state: 'missing', reasonCode: 'load_failed' }], bad: 0 })} -->\n` } });
  const eRows = all(bundle.renderGate2Panel(dom.element('div'), edited.data(), false, new bundle.GatePanelState(), baseActions()), 'vam-book-panel-image-row');
  const e = texts(eRows.find(x => x.dataset.row === 'e')).join(' ');
  assert.match(e, /1 張圖，1 處缺/);
  assert.match(e, /1 張被手動改過/);
  assert.match(e, /圖載入失敗/);
});

test('T5 gate 2: a rerun left unchanged shows the block with "use other sources" (only the unverified https addresses go with it) and "I will look myself"; a second rerun clears it', async () => {
  const r = synth();
  const log = [];
  const state = new bundle.GatePanelState();
  let panel;
  const actions = { ...baseActions(log), refresh() { panel.remove(); panel = draw(); } };
  const parent = dom.element('div');
  const draw = () => bundle.renderGate2Panel(parent, r.data(), false, state, actions);
  panel = draw();
  const row = () => all(panel, 'vam-book-panel-row').find(x => x.dataset.row === 'b');
  assert.equal(all(row(), 'vam-book-panel-unchanged').length, 0, 'not before a rerun');
  one(row(), 'vam-book-panel-rerun-card').click();
  await settle();
  assert.deepEqual(log.at(-1), ['rerun', 'b', undefined]);
  assert.ok(state.unchanged.has('b'));
  assert.ok(texts(row()).includes('還是要你看'));
  assert.ok(texts(row()).includes('這次重跑的結果相同，仍需人看。'));
  assert.ok(!texts(row()).some(x => /仍無法打開|同一來源/.test(x)), 'does not claim the same source still fails');
  one(row(), 'vam-book-panel-look-myself').click();
  assert.deepEqual(log.at(-1), ['open', 'b']);
  one(row(), 'vam-book-panel-swap-source').click();
  await settle();
  assert.equal(JSON.stringify(log.at(-1)), JSON.stringify(['rerun', 'b', { avoidSources: [`${IMG}/paper`] }]));
  // The old row had no sources to swap: no such button.
  state.unchanged.add('old');
  panel.remove(); panel = draw();
  assert.equal(all(all(panel, 'vam-book-panel-row').find(x => x.dataset.row === 'old'), 'vam-book-panel-swap-source').length, 0);
});

test('T5 gate 2: finish asks once when something is left (cards to look at, seams), not when nothing is; "go back" does not finish; a card still working beats the question', async () => {
  const r = synth();
  const log = [];
  const state = new bundle.GatePanelState();
  const press = (panel) => one(panel, 'vam-book-panel-finish').click();
  // Left over: the question, with counts and titles; "go back" (false) finishes nothing.
  const answer = { yes: false };
  const actions = { ...baseActions(log), confirmFinish: async info => { log.push(['confirm', info]); return answer.yes; } };
  const panel = bundle.renderGate2Panel(dom.element('div'), r.data(), false, state, actions);
  press(panel);
  await settle();
  assert.deepEqual(log.filter(x => x[0] === 'confirm').map(x => [x[1].review, x[1].seams, x[1].reviewTitles]), [[2, 1, ['2 Tb', '5 Told']]]);
  assert.equal(log.filter(x => x[0] === 'finish').length, 0);
  assert.equal(state.finishAsking, false);
  answer.yes = true;
  press(panel);
  await settle();
  assert.equal(log.filter(x => x[0] === 'confirm').length, 2);
  assert.equal(log.filter(x => x[0] === 'finish').length, 1);
  // Nothing left: no question, finish at once.
  const clean = new Map([['a', { title: 'A', prompt: '', summary: '', pipelineStage: 'checked' }]]);
  const log2 = [];
  const p2 = bundle.renderGate2Panel(dom.element('div'), bundle.buildGate2Panel({ order: ['a'], titleOf: () => 'A', noteOf: id => clean.get(id) }), false, new bundle.GatePanelState(), baseActions(log2));
  press(p2);
  await settle();
  assert.deepEqual(log2.map(x => x[0]), ['finish']);
  // A card still working: the button waits (no question, no finish).
  const log3 = [];
  const p3 = bundle.renderGate2Panel(dom.element('div'), r.data(), false, new bundle.GatePanelState(), baseActions(log3), new Set(['b']));
  assert.equal(one(p3, 'vam-book-panel-finish').disabled, true);
  press(p3);
  await settle();
  assert.deepEqual(log3, [], 'busy comes first');
});

test('T3 gate 2: the card being rerun shows "處理中" (no clock) instead of its stage', () => {
  const r = synth();
  const log = [];
  const panel = bundle.renderGate2Panel(dom.element('div'), r.data(), false, new bundle.GatePanelState(), baseActions(log), new Set(['b']), true, { nodeId: 'b', startedAt: 12345 });
  const row = all(panel, 'vam-book-panel-row').find(x => x.dataset.row === 'b');
  assert.ok(texts(row).includes('處理中'), JSON.stringify(texts(row)));
  assert.ok(!texts(row).includes('需人看'));
  assert.ok(!texts(row).some(x => /\d:\d\d/.test(x)), 'no clock');
});

test('T5 right-click rerun path: the same result shows the block with both actions; the old mark goes when the result changes', async () => {
  const r = synth();
  const state = new bundle.GatePanelState();
  const log = [];
  const draw = () => bundle.renderGate2Panel(dom.element('div'), r.data(), false, state, baseActions(log));
  const row = panel => all(panel, 'vam-book-panel-row').find(x => x.dataset.row === 'b');
  // What the view's menu item runs: runTrackedRerun over the plugin's rerun result.
  await bundle.runTrackedRerun(state, 'b', async () => ({ unchanged: true }));
  const panel = draw();
  assert.ok(texts(row(panel)).includes('這次重跑的結果相同，仍需人看。'));
  assert.equal(all(row(panel), 'vam-book-panel-swap-source').length, 1);
  assert.equal(all(row(panel), 'vam-book-panel-look-myself').length, 1);
  await bundle.runTrackedRerun(state, 'b', async () => ({ unchanged: false }));
  assert.ok(!state.unchanged.has('b'), 'a changed result clears the old mark');
  assert.equal(all(row(draw()), 'vam-book-panel-unchanged').length, 0);
  await bundle.runTrackedRerun(state, 'b', async () => ({ unchanged: true }));
  let seen;
  await bundle.runTrackedRerun(state, 'b', async () => { seen = state.unchanged.has('b'); return undefined; });
  assert.equal(seen, false, 'cleared before the run starts');
  assert.ok(!state.unchanged.has('b'), 'a rerun that returns nothing leaves no mark');
  await assert.rejects(() => bundle.runTrackedRerun(state, 'b', async () => { throw new Error('x'); }));
  assert.ok(!state.unchanged.has('b'));
});

test('T5 gate 2: a passed card reads "通過" or "通過，n 處可留意" (not 已校), no 地圖 in zh-TW', () => {
  const r = synth({ p: { pipelineStage: 'checked', prompt: '圖安排：無\n', detail: PROOF([{ id: 'C1', type: 'fact', status: 'unverified', note: 'x', sources: [] }, { id: 'C2', type: 'fact', status: 'unverified', note: 'y', sources: [] }, { id: 'C3', type: 'fact', status: 'met', note: '', sources: [] }]) } });
  const panel = bundle.renderGate2Panel(dom.element('div'), r.data(), false, new bundle.GatePanelState(), baseActions());
  const tag = id => texts(all(panel, 'vam-book-panel-row').find(x => x.dataset.row === id)).join('|');
  assert.match(tag('p'), /通過，2 處可留意/);
  assert.ok(!/已校/.test(tag('p')) && !/已校/.test(tag('a')));
  assert.match(tag('a'), /通過/);
  assert.ok(!texts(panel).some(x => /地圖/.test(x)));
});

test('F-a gate 2: a passed card with unmet structure keeps the structure line out of the card body (only in the proof record); a needs-review card still shows its reason', () => {
  const proof = PROOF([{ id: 'S1', type: 'structure', status: 'unmet', note: 'x', sources: [] }, { id: 'C1', type: 'fact', status: 'met', note: '', sources: [] }]);
  const r = synth({ p: { pipelineStage: 'checked', pipelineIssue: 'structure unmet: S1', prompt: '圖安排：無\n', detail: proof } });
  const panel = bundle.renderGate2Panel(dom.element('div'), r.data(), false, new bundle.GatePanelState(), baseActions());
  const row = all(panel, 'vam-book-panel-row').find(x => x.dataset.row === 'p');
  const outside = (row.children ?? []).filter(c => !(c.cls ?? '').split(/\s+/).includes('vam-book-panel-proof'));
  assert.ok(!outside.some(c => texts(c).some(x => /結構/.test(x))), 'no structure line outside the proof record');
  const proofBody = all(row, 'vam-book-panel-proof')[0];
  assert.ok(texts(proofBody).some(x => /結構/.test(x)), 'proof record has it');
  assert.ok(!texts(panel).some(x => /地圖/.test(x)));
});
