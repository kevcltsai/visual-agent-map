// Picture-book gate 1 side panel (04b): content from real notes, "say more about X", confirm, plain-text rendering, and the panel's
// place beside the chat window. Part A drives a real BookPipelineRuns (fake AI ports, real repository fixture) to gate 1 and draws the
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
const bundle = loadSource(`
export * from "./experiences/visual-map/book-pipeline-ui";
export * from "./experiences/visual-map/book-pipeline-panel";
export { BookPipelineRuns, BookPipelineRunError } from "./experiences/visual-map/book-pipeline-run";
export { VisualAgentMapView } from "./experiences/visual-map/view";
export { setUiLanguage } from "./i18n";
`, { obsidian: { ...S.obsidian, Modal: dom.makeModal(), Notice: dom.makeNotice([]), Component: class {}, MarkdownRenderChild: class {} } }, { createFragment: dom.createFragment, requestAnimationFrame: () => 1, cancelAnimationFrame() {}, window: { setTimeout, clearTimeout, setInterval, clearInterval } });
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
    readMap: p => repo.readMap(p), updateMap: (p, change) => repo.updateMap(p, change),
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
    config: () => ({ planModel: 'm1', authorModel: 'm2', proofModel: 'm3', reasoning: 'low', language: 'zh-TW' }),
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
      editPlan: id => entries.push(['edit', id]),
      replan: (id, instruction) => { entries.push(['replan', id, instruction]); return runs.replanCard(mapPath, id, instruction); },
      rerunPlan: id => { entries.push(['rerun', id]); return runs.rerunCard(mapPath, id); },
      confirm: () => { entries.push(['confirm']); return over.confirm ? over.confirm() : runs.confirmGate1(mapPath); },
      showChat: () => entries.push(['chat']), close: () => entries.push(['close']),
      refresh: () => { current.panel.remove(); Object.assign(current, { panel: bundle.renderGatePanel(parent, build(), gate1, state, actions) }); }
    };
    const build = () => bundle.buildGatePanel({ order, titleOf: id => noteOf.get(id)?.title ?? id, noteOf: id => noteOf.get(id), rootRaw });
    const current = { panel: bundle.renderGatePanel(parent, build(), gate1, state, actions) };
    return { parent, get panel() { return current.panel; }, actions };
  };
  return { repo, runs, nodes, mapPath, contents, stat, state, entries, draw, reload };
}

test('gate 1 panel: title, count, plan area, and one block per card with role, covers, entry, handoff, edit button and a "say more" box', async () => {
  const r = await rig();
  const d = await r.draw();
  const panel = d.panel;
  assert.equal(panel.attrs.role, 'region');
  assert.ok(panel.attrs['aria-label']);
  assert.ok(texts(panel).includes('關卡 1：這本書要這樣寫，可以嗎？'));
  assert.ok(texts(panel).includes('3 張都已企劃'));
  const cards = all(panel, 'vam-book-panel-card');
  assert.equal(cards.length, 3);
  const second = cards[1];
  assert.ok(texts(second).includes('2 Da Vinci'));
  assert.ok(texts(second).includes('本文'));
  assert.ok(texts(second).includes('covers 2'), 'one sentence, no label');
  assert.ok(texts(second).includes('接入點：entry'));
  assert.ok(texts(second).includes('留給下一張的問題：handoff'));
  assert.ok(all(second, 'vam-book-panel-edit')[0].attrs['aria-label'].includes('Da Vinci'));
  const input = one(second, 'vam-book-panel-more-input');
  assert.ok(input.attrs['aria-label'].includes('Da Vinci'), 'the box has a label');
  assert.equal(texts(panel).filter(x => x === '確認，開始寫作').length, 1);
  // the plan area is open at the top, thread in big text, material in plain words; no fold left
  const plan = one(panel, 'vam-book-panel-plan');
  assert.equal(all(panel, 'vam-book-panel-plan-toggle').length, 0);
  assert.ok(texts(plan).includes('全書主線'));
  assert.ok(texts(plan).includes('one thread'));
  assert.ok(texts(plan).some(x => x.includes('讀者：kids')));
  assert.ok(texts(plan).includes('準備引用的資料 1 件'));
  assert.ok(!texts(panel).some(x => x.includes('素材登記表')));
  assert.equal(dom.findAll(panel, i => i.tag === 'h3')[0].text, '關卡 1：這本書要這樣寫，可以嗎？');
  // per card: one sentence, role, image line; entry / hand-off / "say more" are behind "看細節"
  const toggle = one(second, 'vam-book-panel-details-toggle');
  const details = one(second, 'vam-book-panel-details');
  assert.equal(toggle.tag, 'button');
  assert.equal(toggle.text, '看細節');
  assert.ok(toggle.attrs['aria-label'].includes('看細節'));
  for (const lang of ['zh-TW', 'zh-CN', 'en']) {
    const line = fs.readFileSync(path.join(root, `i18n/${lang}.ts`), 'utf8').split('\n').find(l => l.includes('"ui.book_gate1_details_0"'));
    const word = lang === 'en' ? 'Details' : lang === 'zh-CN' ? '看细节' : '看細節';
    assert.ok(line.includes(`"${word}`), lang);
  }
  // symbol follows aria-expanded: folded ▸, open ▾ (CSS), and the one-sentence rule beats the small grey field rule
  assert.match(css, /\.vam-book-panel-details-toggle::after \{ content: " ▸"/);
  assert.match(css, /\.vam-book-panel-details-toggle\[aria-expanded="true"\]::after \{ content: " ▾"/);
  assert.match(css, /\.vam-book-panel-field\.vam-book-panel-covers \{[^}]*var\(--font-ui-small\)[^}]*var\(--text-normal\)/);
  assert.equal((css.match(/^\.vam-book-panel-plan \{/gm) || []).length, 1);
  assert.equal(toggle.attrs['aria-expanded'], 'false');
  assert.equal(toggle.attrs['aria-controls'], details.attrs.id);
  assert.equal(details.hidden, true);
  assert.ok(texts(details).includes('接入點：entry'));
  assert.ok(texts(details).includes('留給下一張的問題：handoff'));
  assert.ok(one(details, 'vam-book-panel-more-input') && one(details, 'vam-book-panel-replan'));
  toggle.click();
  assert.equal(details.hidden, false);
  assert.equal(toggle.attrs['aria-expanded'], 'true');
  toggle.click();
  assert.equal(details.hidden, true);
  one(panel, 'vam-book-panel-card'); // unchanged
  all(cards[0], 'vam-book-panel-edit')[0].click();
  assert.equal(JSON.stringify(r.entries.at(-1)), JSON.stringify(['edit', r.nodes[0].id]));
});

test('say more: calls replanCard with the sentence, shows busy then the new plan and the seam line; an empty sentence is not sent; a refusal shows its reason', async () => {
  const r = await rig({ card: (request, n) => ({ covers: n > 1 ? 'NEW covers' : `covers ${request.card.position}`, entry: 'entry', handoff: 'handoff', previous: 'p', next: 'n', checklist: [{ id: 'C1', type: 'structure', text: 'x' }] }) });
  const d = await r.draw();
  const input = () => one(all(d.panel, 'vam-book-panel-card')[1], 'vam-book-panel-more-input');
  const send = () => one(all(d.panel, 'vam-book-panel-card')[1], 'vam-book-panel-replan');
  input().value = '   ';
  send().click();
  await settle();
  assert.equal(r.entries.filter(e => e[0] === 'replan').length, 0, 'blank sentence is not sent');
  input().value = '多講他的手稿';
  input().fire('input');
  send().click();
  assert.equal(JSON.stringify(r.entries.at(-1)), JSON.stringify(['replan', r.nodes[1].id, '多講他的手稿']));
  assert.equal(send().disabled, true, 'busy while it runs');
  assert.equal(all(d.panel, 'vam-book-panel-card')[1].attrs['aria-busy'], 'true');
  send().click(); // a second press does nothing
  assert.equal(r.entries.filter(e => e[0] === 'replan').length, 1);
  await settle();
  assert.ok(texts(d.panel).includes('已重寫這張企劃，前後卡接縫已標記。'));
  await r.reload();
  const d2 = await r.draw();
  assert.ok(texts(d2.panel).includes('NEW covers'), 'the card shows the new plan from the note');
});

test('say more refusal: the runner error becomes a plain Chinese sentence under that card, and the box keeps what was typed', async () => {
  const r = await rig();
  const data = bundle.buildGatePanel({ order: r.nodes.map(n => n.id), titleOf: id => id, noteOf: () => undefined, rootRaw: '' });
  const actions = { editPlan() {}, replan: async () => { throw new bundle.BookPipelineRunError('not_gate1'); }, rerunPlan: async () => {}, confirm: async () => {}, showChat() {}, close() {}, refresh() {} };
  const p = bundle.renderGatePanel(dom.element('div'), data, true, r.state, actions);
  one(all(p, 'vam-book-panel-card')[0], 'vam-book-panel-more-input').value = '多講';
  one(all(p, 'vam-book-panel-card')[0], 'vam-book-panel-more-input').fire('input');
  one(all(p, 'vam-book-panel-card')[0], 'vam-book-panel-replan').click();
  await settle();
  const note = r.state.notes.get(r.nodes[0].id);
  assert.equal(note.error, true);
  assert.equal(note.text, '目前不在「等你確認」階段，不需要確認。');
  assert.equal(r.state.drafts.get(r.nodes[0].id), '多講', 'the typed sentence stays for another try');
  const p2 = bundle.renderGatePanel(dom.element('div'), data, true, r.state, actions);
  const status = one(all(p2, 'vam-book-panel-card')[0], 'vam-book-panel-card-status');
  assert.equal(status.text, note.text);
  assert.equal(status.attrs.role, 'alert');
  // a replan that the plan step itself failed ends with its reason, not a success line
  const failing = { ...actions, replan: async () => ({ reason: 'invalid_reply' }) };
  const p3 = bundle.renderGatePanel(dom.element('div'), data, true, r.state, failing);
  one(all(p3, 'vam-book-panel-card')[1], 'vam-book-panel-more-input').value = 'x';
  one(all(p3, 'vam-book-panel-card')[1], 'vam-book-panel-replan').click();
  await settle();
  assert.match(r.state.notes.get(r.nodes[1].id).text, /^這張沒有重寫：/);
  assert.equal(r.state.notes.get(r.nodes[1].id).error, true);
});

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
  assert.equal(one(d2.panel, 'vam-book-panel-status').text, '額度已用完，請先再加額度。'.length ? one(d2.panel, 'vam-book-panel-status').text : '');
  assert.ok(one(d2.panel, 'vam-book-panel-status').text.length > 0);
  assert.equal(one(d2.panel, 'vam-book-panel-confirm').disabled, false, 'pressable again after a refusal');
});

test('plain text only: plan text with <img onerror>, <script>, markdown images and links becomes text; no such element exists in the panel', async () => {
  const evil = '<img src=x onerror=alert(1)> <script>alert(2)</script> ![p](https://evil.test/a.png) [l](javascript:alert(3))';
  const r = await rig({ card: request => ({ covers: evil, entry: evil, handoff: evil, previous: 'p', next: 'n', checklist: [{ id: 'C1', type: 'structure', text: 'x' }] }), global: (request, list) => ({ thread: evil, cards: list.map((n, i) => ({ id: n.id, role: i ? 'body' : 'intro' })), materials: [{ name: evil, use: evil }], decisions: { reader: evil } }) });
  const d = await r.draw();
  const tags = dom.findAll(d.panel, () => true).map(i => i.tag);
  for (const bad of ['img', 'script', 'a', 'iframe', 'svg']) assert.ok(!tags.includes(bad), bad);
  const shown = texts(d.panel).join('\n');
  assert.match(shown, /onerror/);
  assert.match(shown, /alert\(2\)/);
  // and straight from a note body that the owner may have edited (no escaping at all)
  const data = bundle.buildGatePanel({ order: ['x'], titleOf: () => '<b>t</b>', noteOf: () => ({ prompt: `本章會講：${evil}`, summary: '', pipelineStage: 'planned' }), rootRaw: `## 全書企劃\n### 主線\n${evil}\n` });
  const p = bundle.renderGatePanel(dom.element('div'), data, true, new bundle.GatePanelState(), { editPlan() {}, replan: async () => ({}), rerunPlan: async () => {}, confirm: async () => {}, showChat() {}, close() {}, refresh() {} });
  const tags2 = dom.findAll(p, () => true).map(i => i.tag);
  for (const bad of ['img', 'script', 'a', 'iframe']) assert.ok(!tags2.includes(bad), bad);
  assert.ok(texts(p).includes('1 <b>t</b>'));
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML/.test(fs.readFileSync(path.join(root, 'experiences/visual-map/book-pipeline-panel.ts'), 'utf8')));
});

test('prompt that cannot be parsed: the first three lines show as they are; an empty prompt says there is no plan; a needs-review card shows its reason and "re-plan"', async () => {
  const noteOf = id => ({ x1: { prompt: 'free\nline two\n\nline three\nline four', pipelineStage: 'planned' }, x2: { prompt: '', pipelineStage: 'pending' }, x3: { prompt: '', pipelineStage: 'needs-review', pipelineIssue: 'plan failed: invalid_reply' } })[id];
  const data = bundle.buildGatePanel({ order: ['x1', 'x2', 'x3'], titleOf: id => id, noteOf, rootRaw: '' });
  assert.equal(JSON.stringify(data.cards[0].rawLines), JSON.stringify(['free', 'line two', 'line three']));
  assert.equal(data.planned, 2);
  const calls = [];
  const p = bundle.renderGatePanel(dom.element('div'), data, true, new bundle.GatePanelState(), { editPlan() {}, replan: async () => ({}), rerunPlan: async id => { calls.push(id); }, confirm: async () => {}, showChat() {}, close() {}, refresh() {} });
  assert.deepEqual(all(p, 'vam-book-panel-field').map(i => i.text), ['free', 'line two', 'line three']);
  assert.ok(texts(p).includes('這張還沒有企劃。'));
  assert.ok(texts(p).includes('已企劃 2／3 · 需人看 1'));
  const issue = one(p, 'vam-book-panel-issue');
  assert.match(texts(issue).join(' '), /需人看：企劃失敗/);
  one(issue, 'vam-book-panel-rerun').click();
  assert.equal(JSON.stringify(calls), JSON.stringify(['x3']));
});

test('T4 old data: no book plan, no image arrangement, a failed single card; thread and cards still draw, details stay folded, no throw', () => {
  setUiLanguage('zh-TW');
  const noteOf = id => ({ a: { prompt: '本章會講：舊的一句話\n接入點：舊接入', pipelineStage: 'planned' }, b: { prompt: '', pipelineStage: 'needs-review', pipelineIssue: 'plan failed: invalid_reply' }, c: { prompt: '接入點：只有接入', pipelineStage: 'planned' } })[id];
  const data = bundle.buildGatePanel({ order: ['a', 'b', 'c'], titleOf: id => `T${id}`, noteOf, rootRaw: '# Root\n' });
  const state = new bundle.GatePanelState();
  const p = bundle.renderGatePanel(dom.element('div'), data, true, state, { editPlan() {}, replan: async () => ({}), rerunPlan: async () => {}, confirm: async () => {}, showChat() {}, close() {}, refresh() {} });
  assert.ok(texts(p).includes('全書企劃還沒有內容。'));
  assert.equal(all(p, 'vam-book-panel-thread').length, 0);
  assert.equal(all(p, 'vam-book-panel-images').length, 3);
  assert.ok(texts(p).includes('未安排圖'));
  const [a, b, c] = all(p, 'vam-book-panel-card');
  assert.ok(texts(a).includes('舊的一句話'));
  // only an entry point: it shows once, inside the folded details, not also as a raw line outside
  assert.equal(texts(c).filter(x => x.includes('只有接入')).length, 1);
  assert.ok(texts(one(c, 'vam-book-panel-details')).includes('接入點：只有接入'));
  assert.equal(one(b, 'vam-book-panel-rerun').text, '重跑企劃');
  assert.match(texts(one(b, 'vam-book-panel-issue')).join(' '), /需人看/);
  assert.ok(all(b, 'vam-book-panel-details-toggle').length === 1);
  assert.equal(one(b, 'vam-book-panel-details').hidden, true);
});

test('T4 details: open state survives a repaint (kept on the panel state), and a card with the details open stays open while another is toggled', () => {
  setUiLanguage('zh-TW');
  const data = bundle.buildGatePanel({ order: ['a', 'b'], titleOf: id => id, noteOf: () => ({ prompt: '本章會講：x\n接入點：e', pipelineStage: 'planned' }), rootRaw: '## 全書企劃\n### 主線\nT\n' });
  const state = new bundle.GatePanelState();
  const actions = { editPlan() {}, replan: async () => ({}), rerunPlan: async () => {}, confirm: async () => {}, showChat() {}, close() {}, refresh() {} };
  const p1 = bundle.renderGatePanel(dom.element('div'), data, true, state, actions);
  one(all(p1, 'vam-book-panel-card')[1], 'vam-book-panel-details-toggle').click();
  const p2 = bundle.renderGatePanel(dom.element('div'), data, true, state, actions);
  const [c0, c1] = all(p2, 'vam-book-panel-card');
  assert.equal(one(c0, 'vam-book-panel-details').hidden, true);
  assert.equal(one(c1, 'vam-book-panel-details').hidden, false);
  assert.equal(one(c1, 'vam-book-panel-details-toggle').attrs['aria-expanded'], 'true');
  assert.equal(one(c0, 'vam-book-panel-details').attrs.id !== one(c1, 'vam-book-panel-details').attrs.id, true);
  state.reset();
  assert.equal(state.detailOpen.size, 0);
});

test('keyboard and labels: Escape closes, the Chat tab calls showChat, buttons are real buttons in a sensible Tab order', async () => {
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
  assert.equal(order.at(-1), 'vam-book-panel-confirm');
  const input = one(all(d.panel, 'vam-book-panel-card')[0], 'vam-book-panel-more-input');
  input.value = 'more';
  input.fire('keydown', { key: 'Enter', isComposing: false });
  assert.equal(r.entries.filter(e => e[0] === 'replan').length, 1, 'Enter sends');
  await settle();
  input.fire('keydown', { key: 'Enter', isComposing: true });
  assert.equal(r.entries.filter(e => e[0] === 'replan').length, 1, 'an IME Enter does not');
});

test('words in all three languages; zh-TW says 心智圖 not 地圖', () => {
  const keys = ['book_panel_gate1_title', 'book_panel_replan', 'book_panel_hint', 'book_panel_tab_chat'];
  for (const lang of ['zh-TW', 'en', 'zh-CN']) {
    const text = fs.readFileSync(path.join(root, `i18n/${lang}.ts`), 'utf8');
    for (const key of keys) assert.match(text, new RegExp(`"ui\\.${key}":`), `${lang} ${key}`);
  }
  assert.ok(!/地圖/.test(fs.readFileSync(path.join(root, 'i18n/zh-TW.ts'), 'utf8').split('\n').filter(l => /ui\.book_panel_/.test(l)).join('\n')));
});

// ---- part B: the view ----
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
  h.view.bookPanel.open = true; h.view.bookPanel.drafts.set('a', 'draft');
  h.view.map = { ...h.view.map, bookPipeline: undefined };
  h.view.bookPipelineSeen = null;
  assert.equal(h.mount().children.length, 0);
  assert.equal(h.view.bookPanel.drafts.size, 0);
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
  assert.match(rules, /var\(--background-primary\)/);
  assert.match(rules, /var\(--text-normal\)/);
  assert.match(rules, /:focus-visible \{ outline: 2px solid var\(--interactive-accent\)/);
});

test('gate 1 card: one plain 圖安排 line from the Prompt (not arranged / none / n pictures with kind and what it explains), set with textContent in three languages', () => {
  const planText = S.load('core/book-pipeline/plan-text.ts');
  const base = { role: 'body', covers: 'c', entry: 'e', handoff: 'h', checklist: [{ id: 'C1', type: 'fact', text: 'x' }] };
  const slots = [{ index: 1, kind: 'map', explains: 'trade <b>routes</b>', anchor: 'a' }, { index: 2, kind: '圖表', explains: '成長', anchor: 'b' }];
  const prompts = { old: planText.composeCardPrompt(base, 'zh-TW'), none: planText.composeCardPrompt({ ...base, images: [] }, 'zh-TW'), some: planText.composeCardPrompt({ ...base, images: slots }, 'zh-TW') };
  const noteOf = id => ({ prompt: prompts[id], summary: '', pipelineStage: 'planned' });
  const lines = lang => { setUiLanguage(lang); const data = bundle.buildGatePanel({ order: ['old', 'none', 'some'], titleOf: id => id, noteOf, rootRaw: '' }); return data.cards.map(c => c.imagePlan); };
  assert.deepEqual(lines('zh-TW'), ['未安排圖', '不放圖', '圖 2 張：map／trade ＜b＞routes＜/b＞；圖表／成長']);
  assert.deepEqual(lines('zh-CN'), ['未安排图', '不放图', '图 2 张：map／trade ＜b＞routes＜/b＞；圖表／成長']);
  assert.deepEqual(lines('en'), ['Pictures: not arranged', 'Pictures: none', '2 picture(s): map／trade ＜b＞routes＜/b＞；圖表／成長']);
  setUiLanguage('zh-TW');
  const data = bundle.buildGatePanel({ order: ['old', 'none', 'some'], titleOf: id => id, noteOf, rootRaw: '' });
  const p = bundle.renderGatePanel(dom.element('div'), data, true, new bundle.GatePanelState(), { editPlan() {}, replan: async () => ({}), rerunPlan: async () => {}, confirm: async () => {}, showChat() {}, close() {}, refresh() {} });
  assert.deepEqual(all(p, 'vam-book-panel-images').map(i => i.text), ['未安排圖', '不放圖', '圖 2 張：map／trade ＜b＞routes＜/b＞；圖表／成長']);
});
