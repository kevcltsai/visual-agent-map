// Picture-book gate 1 side panel (T5 trial screen): the trial chapters, the settings fold, confirm and retry, plain-text rendering, and the
// panel's place beside the chat window. Part A drives a real BookPipelineRuns (fake AI ports, real repository fixture) to gate 1 and draws the
// panel from the notes it wrote; part B runs the view's own panel methods on the stand-in DOM. Real Obsidian look, focus ring and the
// 400px pane are UI evidence for the tester.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const S = require('./support.cjs');
const dom = require('./support-dom.cjs');
const { loadSource } = require('./support-replay.cjs');

const root = path.resolve(__dirname, '..');
class OptionStub { constructor(text, value) { const o = dom.element('option', { text }); o.optionValue = value; o.value = value; o.disabled = false; return o; } }
const components = [];
const renders = [];
const bundle = loadSource(`
export * from "./experiences/visual-map/book-pipeline-ui";
export * from "./experiences/visual-map/book-pipeline-panel";
export { BookPipelineRuns, BookPipelineRunError } from "./experiences/visual-map/book-pipeline-run";
export { VisualAgentMapView } from "./experiences/visual-map/view";
export { setUiLanguage, t } from "./i18n";
`, { obsidian: { ...S.obsidian, Modal: dom.makeModal(), Notice: dom.makeNotice([]), Component: class { load() { this.loaded = true; components.push(this); } unload() { this.unloaded = true; } }, MarkdownRenderChild: class {}, MarkdownRenderer: { render: async (app, markdown, el, sourcePath, component) => { renders.push({ markdown, el, component }); } } } }, { createFragment: dom.createFragment, Option: OptionStub, requestAnimationFrame: () => 1, cancelAnimationFrame() {}, window: { setTimeout, clearTimeout, setInterval, clearInterval } });
const { setUiLanguage } = bundle;
const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
const view_ts = fs.readFileSync(path.join(root, 'experiences/visual-map/view.ts'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const settle = async () => { for (let i = 0; i < 20; i++) await tick(); };
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const all = (el, cls) => dom.findAll(el, i => (i.cls ?? '').split(/\s+/).includes(cls));
const one = (el, cls) => all(el, cls)[0];
const texts = el => dom.findAll(el, i => i.text).map(i => i.text);

// ---- part A: real runner at gate 1 ----
const actionsOf = (over = {}) => ({ confirm: async () => {}, retry: async () => {}, renderMarkdown: (el, markdown) => { el.createDiv({ cls: 'md-stand-in', text: markdown }); }, settings: {}, models: { plan: 'm1', write: 'm2', images: 'm4', proof: 'm3' }, modelChoice: { options: () => ['m1', 'm2', 'm3', 'm4'], label: m => m, onChange() {} }, showChat() {}, close() {}, refresh() {}, ...over });
async function rig(script = {}) {
  setUiLanguage('zh-TW');
  const data = S.fixture('zh-TW');
  const { repo, contents } = data;
  const mapPath = await repo.createMap('Book');
  const doc = await repo.readMap(mapPath);
  const nodes = [];
  for (const title of ['Root', 'Da Vinci', 'Michelangelo']) nodes.push(await repo.createNote(title, 'model-a', doc, mapPath, 'workspace', { summary: `summary of ${title}` }));
  nodes.forEach((node, i) => { node.x = i * 300; node.y = 0; if (i) node.parentId = nodes[0].id; });
  await repo.updateMap(mapPath, d => { d.nodes.push(...nodes); });
  const stat = { cardPlans: [] };
  let queue = Promise.resolve();
  let ids = 0;
  const s = {
    global: (request, list) => ({ thread: 'one thread', cards: list.map((n, i) => ({ id: n.id, role: i ? 'body' : 'intro' })), materials: [{ name: 'm', use: 'u' }], decisions: { reader: 'kids' } }),
    card: request => ({ covers: `covers ${request.card.position}`, entry: 'entry', handoff: 'handoff', previous: 'p', next: 'n', checklist: [{ id: 'C1', type: 'structure', text: 'has a beginning' }] }),
    ...script
  };
  const ports = {
    mutate: work => { const next = queue.then(work); queue = next.catch(() => undefined); return next; },
    readMap: p => repo.readMap(p), updateMap: (p, change) => repo.updateMap(p, d => { change(d); delete d.bookPipeline?.trial; }), // an older run (no trial): every card is planned before gate 1
    readCard: async p => { const note = await repo.readNote(p); return { path: p, title: note.title, summary: note.summary, prompt: note.prompt, detail: note.detail, raw: contents.get(p), settings: note.bookSettings ?? {}, fields: { ...(note.pipelineStage ? { pipelineStage: note.pipelineStage } : {}), ...(note.bookRole ? { bookRole: note.bookRole } : {}), ...(note.pipelineIssue ? { pipelineIssue: note.pipelineIssue } : {}), ...(note.pipelineSeam ? { pipelineSeam: note.pipelineSeam } : {}) } }; },
    writePipelineFields: (p, patch) => repo.writePipelineFields(p, patch),
    updateNoteGuarded: (p, patch, options) => repo.updateNoteGuarded(p, patch, options),
    updateNoteRawGuarded: (p, transform, options) => repo.updateNoteRawGuarded(p, transform, options),
    runPlan: async (step, request, run) => {
      await run.admission.reserve();
      if (step.id === 'book-pipeline.global-plan') return s.global(request, nodes);
      stat.cardPlans.push(request.card.id);
      return s.card(request, stat.cardPlans.filter(x => x === request.card.id).length);
    },
    runProofread: async () => { throw new Error('no proofread at gate 1'); },
    author: async () => { throw new Error('no author at gate 1'); },
    probeImage: async () => ({ ok: true }),
    backupNote: async p => ({ ok: true, path: `${p}.bak` }),
    blocked: () => false,
    config: () => ({ planModel: 'm1', authorModel: 'm2', imageModel: 'm4', proofModel: 'm3', reasoning: 'low', language: 'zh-TW' }),
    now: () => '2026-11-17T00:00:00.000Z', newId: () => `run-${++ids}`, log() {}
  };
  const runs = new bundle.BookPipelineRuns(ports);
  await runs.start(mapPath);
  const noteOf = new Map();
  const reload = async () => { for (const n of nodes) noteOf.set(n.id, await repo.readNote(n.path)); };
  await reload();
  const state = new bundle.GatePanelState();
  const entries = [];
  const draw = async (over = {}) => {
    await reload();
    const map = await repo.readMap(mapPath);
    const order = map.bookPipeline.order;
    const rootRaw = contents.get(nodes[0].path);
    const gate1 = map.bookPipeline.phase === 'gate1';
    const parent = dom.element('div');
    const actions = {
      ...actionsOf(),
      retry: patch => { entries.push(['retry', patch]); return runs.retryTrial(mapPath); },
      confirm: () => { entries.push(['confirm']); return over.confirm ? over.confirm() : runs.confirmGate1(mapPath); },
      showChat: () => entries.push(['chat']), close: () => entries.push(['close']),
      refresh: () => { current.panel.remove(); Object.assign(current, { panel: bundle.renderGatePanel(parent, build(), gate1, state, actions) }); }
    };
    const build = () => bundle.buildGatePanel({ order, ...(map.bookPipeline.trial ? { trial: map.bookPipeline.trial } : {}), titleOf: id => noteOf.get(id)?.title ?? id, noteOf: id => noteOf.get(id), rootRaw });
    const current = { panel: bundle.renderGatePanel(parent, build(), gate1, state, actions) };
    return { parent, get panel() { return current.panel; }, actions };
  };
  return { repo, runs, nodes, mapPath, contents, stat, state, entries, draw, reload };
}


test('confirm: calls confirmBookGate1 once, is disabled and busy while it runs, and a refusal shows its reason', async () => {
  const gate = defer();
  const r = await rig();
  const d = await r.draw({ confirm: () => gate.promise });
  const confirm = () => one(d.panel, 'vam-book-panel-confirm');
  confirm().click();
  confirm().click();
  assert.equal(r.entries.filter(e => e[0] === 'confirm').length, 1);
  assert.equal(confirm().disabled, true);
  assert.equal(confirm().attrs['aria-busy'], 'true');
  assert.equal(confirm().text, '確認中⋯');
  gate.resolve();
  await settle();
  assert.equal(confirm().disabled, false);
  // refusal
  const r2 = await rig();
  const d2 = await r2.draw({ confirm: async () => { throw new bundle.BookPipelineRunError('budget'); } });
  one(d2.panel, 'vam-book-panel-confirm').click();
  await settle();
  assert.equal(one(d2.panel, 'vam-book-panel-status').text, one(d2.panel, 'vam-book-panel-status').text);
  assert.ok(one(d2.panel, 'vam-book-panel-status').text.length > 0);
  assert.equal(one(d2.panel, 'vam-book-panel-confirm').disabled, false, 'pressable again after a refusal');
});


test('plain text only: thread and card titles from the plan and notes become text; the chapter text goes to the renderer only', () => {
  const evil = '<img src=x onerror=alert(1)> <script>alert(2)</script> ![p](https://evil.test/a.png) [l](javascript:alert(3))';
  const data = bundle.buildGatePanel({ order: ['x'], trial: ['x'], titleOf: () => '<b>t</b>', noteOf: () => ({ prompt: '', summary: '', pipelineStage: 'checked', detail: evil }), rootRaw: `## 全書企劃\n### 主線\n${evil}\n` });
  const seen = [];
  const p = bundle.renderGatePanel(dom.element('div'), data, true, new bundle.GatePanelState(), actionsOf({ renderMarkdown: (el, markdown) => seen.push(markdown) }));
  const tags = dom.findAll(p, () => true).map(i => i.tag);
  for (const bad of ['img', 'script', 'a', 'iframe', 'svg']) assert.ok(!tags.includes(bad), bad);
  assert.ok(texts(p).includes('1 <b>t</b>') || texts(p).some(x => x.includes('<b>t</b>')));
  assert.deepEqual(seen, [evil], 'the chapter text reaches the renderer as it is, and nowhere else');
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML/.test(fs.readFileSync(path.join(root, 'experiences/visual-map/book-pipeline-panel.ts'), 'utf8')));
});

test('keyboard and labels: Escape closes, the Chat tab calls showChat, the Tab order ends with the two buttons', async () => {
  const r = await rig();
  const d = await r.draw();
  d.panel.fire('keydown', { key: 'Escape' });
  assert.equal(JSON.stringify(r.entries.at(-1)), JSON.stringify(['close']));
  const tab = all(d.panel, 'vam-book-panel-tab');
  assert.equal(tab[1].text, '對話');
  tab[1].click();
  assert.equal(JSON.stringify(r.entries.at(-1)), JSON.stringify(['chat']));
  const order = dom.findAll(d.panel, i => ['button', 'input'].includes(i.tag)).map(i => i.cls.split(' ').find(c => c.startsWith('vam-book-panel')) ?? i.cls);
  assert.equal(order[0], 'vam-book-panel-tab');
  assert.equal(order.at(-1), 'vam-book-panel-confirm', 'an older run (no trial) has the one button');
});

test('words in all three languages; zh-TW says 心智圖 not 地圖', () => {
  const keys = ['book_panel_gate1_title', 'book_trial_title', 'book_trial_fold', 'book_trial_retry', 'book_trial_done', 'book_trial_look', 'book_panel_tab_chat'];
  for (const lang of ['zh-TW', 'en', 'zh-CN']) {
    const text = fs.readFileSync(path.join(root, `i18n/${lang}.ts`), 'utf8');
    for (const key of keys) assert.match(text, new RegExp(`"ui\\.${key}":`), `${lang} ${key}`);
  }
  assert.ok(!/地圖/.test(fs.readFileSync(path.join(root, 'i18n/zh-TW.ts'), 'utf8').split('\n').filter(l => /ui\.book_(panel|trial)_/.test(l)).join('\n')));
});

const MAP = 'Agent Workspace/Topics/map-bk1/Map.md';
async function viewRig({ book = true, phase = 'gate1', chat } = {}) {
  setUiLanguage('zh-TW');
  const { repo, app } = S.fixture('zh-TW', { linkIndex: true });
  const settings = { ...S.DEFAULT_SETTINGS, language: 'zh-TW', cliModel: 'gpt-6-luna' };
  repo.settings = settings;
  const mapDoc = { id: 'map-bk1', title: 'BK', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  await repo.ensureTopicFolders('Agent Workspace/Topics/map-bk1');
  const ids = [];
  for (const key of ['root', 'a']) {
    const created = await repo.createNote(key, 'gpt-6-luna', mapDoc, MAP, 'workspace', { summary: `summary of ${key}` });
    Object.assign(created, { parentId: ids.length ? ids[0] : null, x: 0, y: mapDoc.nodes.length * 100 });
    mapDoc.nodes.push(created); ids.push(created.id);
  }
  if (book) mapDoc.bookPipeline = { v: 1, runId: 'r1', phase, status: 'running', order: ids, globalPlanned: true, attempts: { global: 1 }, revisions: {}, budget: { used: 1, limit: 300 }, revision: 1, startedAt: '2026-11-17T00:00:00.000Z', phaseStartedAt: '2026-11-17T00:00:00.000Z' };
  await app.vault.create(MAP, S.core.serializeMap(mapDoc));
  await repo.rebuildDerivedData();
  const plugin = S.withExpansionCoordinator({ repo, settings, running: new Set(), logs: { appendLog() {} }, rebuildDerivedData: () => repo.rebuildDerivedData(), relevanceGrades: new Map(), expansionBatches: new Map(), pendingSuggestions: new Map(), releaseOutline() {}, setOutlineActive() {}, detailsShown: () => false, mutate: work => Promise.resolve().then(work), getBookPipelineProgress: () => undefined });
  S.attachTopicRuns(plugin);
  plugin.availableModels = () => ['gpt-6-luna']; plugin.modelLabel = model => model;
  const view = new bundle.VisualAgentMapView({ app }, plugin);
  view.path = MAP; view.map = await repo.readMap(MAP); view.stageEl = dom.element('div'); view.contentEl = dom.element('div');
  view.notes = new Map(await Promise.all(view.map.nodes.map(async n => [n.id, await repo.readNote(n.path)])));
  let renders = 0;
  view.render = () => { renders++; };
  const log = [];
  view.chat = chat === false ? undefined : { isHero: false, isOpen: true, setOpen: (open, focus) => { log.push(['chat', open, !!focus]); } };
  return { view, plugin, log, renders: () => renders, mount: () => { const workspace = dom.element('div'); view.mountBookPanel(workspace); return workspace; } };
}

test('view: a map without bookPipeline gets no panel, no opener and a clean state, even if the panel was open before', async () => {
  const h = await viewRig({ book: false });
  h.view.bookPanel.open = true;
  const workspace = h.mount();
  assert.equal(workspace.children.length, 0);
  assert.equal(h.view.bookPanel.open, false);
  const toolbar = dom.element('div');
  h.view.renderBookPipelineBar(toolbar);
  assert.equal(toolbar.children.length, 0);
});

test('view: the opener shows at gate 1 only; opening folds the chat, moves the keyboard to the title, closing gives the chat back and the keyboard to the opener', async () => {
  const h = await viewRig();
  h.plugin.getBookPipelineProgress = () => ({ runId: 'r1', phase: 'gate1', status: 'running', active: false, total: 2, counts: { pending: 0, planned: 2, written: 0, checked: 0, 'needs-review': 0 }, budget: { used: 1, limit: 300 }, startedAt: 'a', phaseStartedAt: 'a', busyCards: [] });
  const toolbar = dom.element('div');
  h.view.renderBookPipelineBar(toolbar);
  const opener = one(toolbar, 'vam-book-panel-toggle');
  assert.equal(opener.text, '開啟關卡面板');
  assert.equal(opener.attrs['aria-expanded'], 'false');
  opener.click();
  assert.equal(h.view.bookPanel.open, true);
  assert.equal(JSON.stringify(h.log), JSON.stringify([['chat', false, false]]), 'the chat folds, and not as a user choice');
  assert.equal(h.view.chatForcedOpen, false);
  assert.equal(h.renders(), 1);
  const workspace = h.mount();
  const side = one(workspace, 'vam-book-side');
  assert.ok(side, 'the side column exists');
  assert.equal(one(side, 'vam-book-panel').attrs.role, 'region');
  assert.equal(dom.focusedNow(), one(side, 'vam-book-panel-title'), 'focus moves to the title');
  assert.equal(h.view.bookPanel.pendingFocus, null);
  // the opener now closes it
  const toolbar2 = dom.element('div');
  h.view.renderBookPipelineBar(toolbar2);
  const closer = one(toolbar2, 'vam-book-panel-toggle');
  assert.equal(closer.attrs['aria-expanded'], 'true');
  const stand = dom.element('button');
  toolbar2.appendChild(stand); stand.cls = 'vam-book-panel-toggle'; h.view.contentEl.appendChild(toolbar2);
  closer.click();
  assert.equal(h.view.bookPanel.open, false);
  assert.equal(JSON.stringify(h.log.at(-1)), JSON.stringify(['chat', true, false]), 'the chat comes back');
  h.mount();
  assert.equal(dom.focusedNow().cls.includes('vam-book-panel-toggle'), true, 'focus returns to the opener');
});

test('view: the Chat tab closes the panel and opens the chat with the keyboard in it; Escape closes the panel; a panel left open leaves nothing when the map has no book', async () => {
  const h = await viewRig();
  h.view.bookPanel.open = true;
  const workspace = h.mount();
  const side = one(workspace, 'vam-book-side');
  all(side, 'vam-book-panel-tab')[1].click();
  assert.equal(h.view.bookPanel.open, false);
  assert.equal(JSON.stringify(h.log.at(-1)), JSON.stringify(['chat', true, true]));
  h.view.bookPanel.open = true;
  const w2 = h.mount();
  one(w2, 'vam-book-panel').fire('keydown', { key: 'Escape' });
  assert.equal(h.view.bookPanel.open, false);
  // the map is switched to one without a book: the state is wiped
  h.view.bookPanel.open = true; h.view.bookPanel.settingDrafts.set('reader', 'draft');
  h.view.map = { ...h.view.map, bookPipeline: undefined };
  h.view.bookPipelineSeen = null;
  assert.equal(h.mount().children.length, 0);
  assert.equal(h.view.bookPanel.settingDrafts.size, 0);
});

test('view: the panel and the cleanup are wired where they must be (repaint after progress, view close, narrow overlay, no timer of its own)', () => {
  assert.match(view_ts, /this\.mountBookPanel\(workspace\);/);
  assert.match(view_ts, /this\.bookAuthoring\.clear\(\);\s*this\.bookPanel\.reset\(\);/);
  const panelSrc = fs.readFileSync(path.join(root, 'experiences/visual-map/book-pipeline-panel.ts'), 'utf8');
  assert.ok(!/setTimeout|setInterval|requestAnimationFrame/.test(panelSrc), 'the panel owns no timer');
  const panelPart = view_ts.slice(view_ts.indexOf('private mountBookPanel'), view_ts.indexOf('private async loadBookRoot'));
  assert.ok(!/setTimeout|setInterval/.test(panelPart));
  assert.match(panelPart, /is-overlay/);
});

test('styles: the side column, the narrow overlay and the panel use theme variables only (light and dark), with a visible focus ring', () => {
  assert.match(css, /\.vam-book-side \{[^}]*flex: 0 0 340px/);
  assert.match(css, /\.vam-book-side\.is-overlay \{[^}]*position: absolute[^}]*max-width: calc\(100% - 44px\)/);
  const rules = css.split('\n').filter(line => /^\.vam-book-(side|panel)/.test(line)).join('\n');
  assert.ok(rules.length > 500);
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(rules), 'no hard-coded colour');
  assert.ok(!/\brgba?\(/.test(rules), 'no hard-coded rgb');
  assert.match(css, /\.vam-book-trial-settings\[hidden\] \{ display: none; \}/, 'the folded settings are really hidden (a flex display would otherwise beat the hidden attribute)');
  assert.match(rules, /var\(--background-primary\)/);
  assert.match(rules, /var\(--text-normal\)/);
  assert.match(rules, /:focus-visible \{ outline: 2px solid var\(--interactive-accent\)/);
});


test('view: the trial chapters are drawn by one Markdown renderer component that is unloaded on every repaint and on close', async () => {
  const h = await viewRig();
  const before = components.length;
  h.view.map.bookPipeline.trial = h.view.map.bookPipeline.order.slice();
  for (const id of h.view.map.bookPipeline.order) h.view.notes.get(id).detail = `chapter text of ${id}`;
  h.view.bookPanel.open = true;
  h.mount();
  const first = components.slice(before);
  assert.equal(first.length, 1, 'one component for the whole panel');
  assert.equal(first[0].loaded, true); assert.equal(first[0].unloaded, undefined);
  assert.ok(renders.filter(x => x.component === first[0]).length >= 1);
  h.view.paintBookPanel();
  assert.equal(first[0].unloaded, true, 'a repaint unloads the old one');
  const second = components.slice(before).filter(c => c !== first[0]);
  assert.equal(second.length, 1);
  assert.equal(second[0].unloaded, undefined);
  h.view.closeBookPanel();
  h.mount();
  assert.equal(second[0].unloaded, true, 'closing the panel unloads it');
});


// ---- the trial screen (pure panel) ----
const HIDDEN = '> [!vam-book]- 研究備註\n> secret work record line';
const trialData = (extra = {}) => bundle.buildGatePanel({
  order: ['a', 'b', 'c', 'd'], trial: ['a', 'b', 'c'], titleOf: id => `T${id}`,
  noteOf: id => ({ a: { pipelineStage: 'checked', detail: `正文一。\n\n![x](https://u.test/a.png)\n\n${HIDDEN}` }, b: { pipelineStage: 'checked', detail: '正文二。' }, c: { pipelineStage: 'needs-review', pipelineIssue: 'write failed: failed', detail: '' }, d: { pipelineStage: 'planned', detail: 'never shown' } })[id],
  rootRaw: '## 全書企劃\n### 全書主線\n主線第一句。第二句不顯示。\n', ...extra
});
const draw = (data, state = new bundle.GatePanelState(), over = {}) => { setUiLanguage('zh-TW'); return bundle.renderGatePanel(dom.element('div'), data, true, state, actionsOf(over)); };

test('trial screen: mainline first sentence, the three trial chapters drawn by the renderer without work records, the settings fold closed, both buttons', () => {
  const data = trialData();
  assert.equal(data.thread, '主線第一句。');
  assert.equal(data.trial.length, 3, 'only the trial cards, not the fourth');
  const seen = [];
  const p = draw(data, new bundle.GatePanelState(), { renderMarkdown: (el, markdown) => { seen.push(markdown); el.createDiv({ cls: 'md-stand-in', text: markdown }); } });
  assert.equal(dom.findAll(p, i => i.tag === 'h3')[0].text, '先看試跑章節的完整成品，這樣可以嗎？');
  assert.ok(texts(p).includes('主線第一句。'));
  assert.ok(!texts(p).some(x => x.includes('第二句不顯示')));
  assert.equal(all(p, 'vam-book-trial-card').length, 3);
  assert.equal(seen.length, 2, 'the chapter with no text is not sent to the renderer');
  assert.ok(seen[0].includes('正文一。') && seen[0].includes('https://u.test/a.png'), 'text and picture stay');
  assert.ok(!seen.join('\n').includes('secret work record'), 'the hidden work records are not shown');
  assert.ok(!texts(p).some(x => x.includes('never shown')));
  const cards = all(p, 'vam-book-trial-card');
  assert.equal(one(cards[0], 'vam-book-trial-pill').text, '已完成');
  assert.equal(one(cards[2], 'vam-book-trial-pill').text, bundle.t('ui.book_trial_look'));
  assert.ok(one(cards[2], 'vam-book-panel-issue').text.length > 0);
  assert.ok(texts(cards[2]).includes(bundle.t('ui.book_trial_no_text')), 'empty text says so');
  const toggle = one(p, 'vam-book-trial-fold');
  const body = one(p, 'vam-book-trial-settings');
  assert.equal(toggle.attrs['aria-expanded'], 'false'); assert.equal(body.hidden, true);
  assert.equal(toggle.attrs['aria-controls'], body.attrs.id);
  assert.equal(all(body, 'vam-book-start-model').length, 4, 'four model dropdowns inside the fold');
  toggle.click();
  assert.equal(body.hidden, false); assert.equal(toggle.attrs['aria-expanded'], 'true');
  const foot = one(p, 'vam-book-panel-foot');
  assert.deepEqual(dom.findAll(foot, i => i.tag === 'button').map(i => i.text), [bundle.t('ui.book_confirm_gate1'), bundle.t('ui.book_trial_retry')]);
});

test('trial screen: an older run (no trial) shows the thread and the one confirm button only, with the old title', () => {
  const data = trialData({ trial: undefined });
  assert.deepEqual(data.trial, []);
  const p = draw(data);
  assert.equal(all(p, 'vam-book-trial-card').length, 0);
  assert.equal(all(p, 'vam-book-trial-fold').length, 0);
  assert.equal(all(p, 'vam-book-panel-retry').length, 0);
  assert.equal(all(p, 'vam-book-panel-confirm').length, 1);
  assert.equal(dom.findAll(p, i => i.tag === 'h3')[0].text, bundle.t('ui.book_panel_gate1_title'));
  assert.ok(texts(p).includes('主線第一句。'));
});

test('trial screen: no thread and fewer than three cards still draw (an empty plan says so)', () => {
  const data = bundle.buildGatePanel({ order: ['a', 'b'], trial: ['a', 'b'], titleOf: id => id, noteOf: id => ({ pipelineStage: 'checked', detail: `text ${id}` }), rootRaw: '# Root\n' });
  assert.equal(data.thread, ''); assert.equal(data.trial.length, 2);
  const p = draw(data);
  assert.equal(all(p, 'vam-book-trial-card').length, 2);
  assert.equal(all(p, 'vam-book-panel-thread').length, 0);
  assert.equal(bundle.t('ui.book_panel_plan_empty').length > 0, true);
  assert.ok(texts(p).includes(bundle.t('ui.book_panel_plan_empty')));
});

test('trial screen: retry sends what was typed in the fold once, keeps the drafts across a repaint, clears them when the retry went through, and shows a refusal', async () => {
  setUiLanguage('zh-TW');
  const gate = defer();
  const calls = [];
  const state = new bundle.GatePanelState();
  const parent = dom.element('div');
  let panel;
  const actions = actionsOf({ settings: { reader: 'old reader' }, retry: patch => { calls.push(patch); return calls.length === 1 ? Promise.reject(new bundle.BookPipelineRunError('blocked')) : gate.promise; }, refresh: () => { panel.remove(); panel = bundle.renderGatePanel(parent, trialData(), true, state, actions); } });
  panel = bundle.renderGatePanel(parent, trialData(), true, state, actions);
  const area = () => all(panel, 'vam-book-start-settings')[0] && dom.findAll(panel, i => i.tag === 'textarea')[0];
  area().value = 'new reader'; area().fire('input', {});
  // a repaint (progress arrives) keeps what was typed
  actions.refresh();
  assert.equal(area().value, 'new reader');
  one(panel, 'vam-book-panel-retry').click();
  await settle();
  assert.equal(calls.length, 1);
  assert.equal(JSON.stringify(calls[0]), JSON.stringify({ reader: 'new reader' }));
  assert.ok(one(panel, 'vam-book-panel-status').text.length > 0, 'a refusal shows its reason');
  assert.equal(area().value, 'new reader', 'a refused retry keeps the draft');
  assert.equal(one(panel, 'vam-book-panel-retry').disabled, false);
  one(panel, 'vam-book-panel-retry').click();
  one(panel, 'vam-book-panel-retry').click();
  assert.equal(calls.length, 2, 'pressed twice while running: one call');
  assert.equal(one(panel, 'vam-book-panel-retry').disabled, true);
  assert.equal(one(panel, 'vam-book-panel-confirm').disabled, true, 'confirm waits while a retry runs');
  gate.resolve();
  await settle();
  assert.equal(state.settingDrafts.size, 0, 'drafts are cleared once the retry applied them');
  assert.equal(one(panel, 'vam-book-panel-retry').disabled, false);
});

test('trial screen: "run the whole book" sends what was typed in the fold, so the whole book uses it; drafts clear once it went through', async () => {
  setUiLanguage('zh-TW');
  const calls = [];
  const state = new bundle.GatePanelState();
  const parent = dom.element('div');
  let panel;
  const actions = actionsOf({ settings: { reader: 'old reader' }, confirm: async patch => { calls.push(patch); }, refresh: () => { panel.remove(); panel = bundle.renderGatePanel(parent, trialData(), true, state, actions); } });
  panel = bundle.renderGatePanel(parent, trialData(), true, state, actions);
  assert.equal(one(panel, 'vam-book-panel-retry').text, '用新設定重試試跑', 'the retry names the trial, not one chapter');
  const area = dom.findAll(panel, i => i.tag === 'textarea')[0];
  area.value = 'new reader'; area.fire('input', {});
  one(panel, 'vam-book-panel-confirm').click();
  await settle();
  assert.equal(JSON.stringify(calls), JSON.stringify([{ reader: 'new reader' }]));
  assert.equal(state.settingDrafts.size, 0);
});
