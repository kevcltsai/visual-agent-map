// Picture-book pipeline screen (03b): the top progress bar, the card labels, the toolbar entry and the refusal messages.
// Unit level on a stand-in DOM; the real Obsidian look (colors, narrow toolbar, focus ring) is UI evidence for the tester.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const support = require('./support.cjs');
const dom = require('./support-dom.cjs');
const { loadSource } = require('./support-replay.cjs');

const root = path.resolve(__dirname, '..');
const MAP = 'Agent Workspace/Topics/map-bk1/Map.md';
const notices = [];
// The suggestion timeout is held so a test can fire it by hand; an <option> is a stand-in element like the real one (text, value).
const timers = { hold: false, held: [] };
class OptionStub { constructor(text, value) { const o = dom.element('option', { text }); o.optionValue = value; o.value = value; o.disabled = false; return o; } }
// One bundle, so the view, the screen parts and the language setting share one copy of the interface language.
const bundle = loadSource(`
export * from "./experiences/visual-map/book-pipeline-ui";
export { bookStartEstimate, bookStartEstimateText, bookSettingsPatch, BookStartModal, BOOK_SUGGEST_TIMEOUT_MS } from "./experiences/visual-map/book-pipeline-start-modal";
export { BookPipelineRunError, stepCounts } from "./experiences/visual-map/book-pipeline-run";
export { readBookPipeline } from "./core/book-pipeline/model";
export { VisualAgentMapView } from "./experiences/visual-map/view";
export { setUiLanguage, t } from "./i18n";
`, { obsidian: { ...support.obsidian, Modal: dom.makeModal(), Notice: dom.makeNotice(notices), Component: class {}, MarkdownRenderChild: class {} } }, { createFragment: dom.createFragment, requestAnimationFrame: () => 1, cancelAnimationFrame() {}, Option: OptionStub, window: { setTimeout: (fn, ms) => (ms === 20000 && timers.hold ? (timers.held.push(fn), 99) : setTimeout(fn, ms)), clearTimeout, setInterval, clearInterval } });
const { setUiLanguage, t: tr } = bundle;
const ui = bundle, runModule = bundle, model = bundle, bundleStart = bundle;
const flat = text => text.replace(/\s+/g, ' ');
const view_ts = flat(fs.readFileSync(path.join(root, 'experiences/visual-map/view.ts'), 'utf8'));
const main_ts = fs.readFileSync(path.join(root, 'main.ts'), 'utf8');
const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
const lang = language => { setUiLanguage(language); };
const texts = el => dom.findAll(el, i => i.text).map(i => i.text);
const bookData = (over = {}) => ({
  v: 1, runId: 'r1', phase: 'writing', status: 'running', order: ['a', 'b', 'c', 'd'], globalPlanned: true, attempts: { global: 1 }, revisions: {},
  budget: { used: 12, limit: 300 }, revision: 1, startedAt: '2026-11-17T00:00:00.000Z', phaseStartedAt: '2026-11-17T00:00:00.000Z', ...over
});
const progress = (over = {}) => ({
  runId: 'r1', phase: 'writing', status: 'running', active: true, total: 4,
  counts: { pending: 0, planned: 1, written: 1, checked: 1, 'needs-review': 1 }, budget: { used: 12, limit: 300 },
  startedAt: '2026-11-17T00:00:00.000Z', phaseStartedAt: '2026-11-17T00:00:00.000Z', ...over
});
const noStage = () => undefined;
const calls = () => { const log = []; return { log, actions: { stop: () => log.push('stop'), resume: () => log.push('resume'), addBudget: () => log.push('add'), confirmGate1: () => log.push('confirm') } }; };
const draw = (data, prog, stageOf = noStage, withRestart = false) => {
  const parent = dom.element('div');
  const c = calls();
  if (withRestart) c.actions.restart = () => c.log.push('restart');
  const state = ui.bookBarState(data, prog, stageOf);
  const bar = ui.renderBookBar(parent, state, c.actions);
  return { parent, bar, state, ...c };
};
const buttonsOf = bar => dom.findAll(bar, i => i.tag === 'button');
const track = bar => dom.find(bar, i => i.attrs.role === 'progressbar');

test('bar: running writing phase shows the phase, one plain sentence with the progress, a stop button and a progressbar with aria values and a text alternative; no stage list', () => {
  lang('zh-TW');
  const d = draw(bookData(), progress({ current: [{ nodeId: 'a', step: 'proof', startedAt: 1 }] }));
  assert.equal(d.bar.attrs.role, 'group');
  assert.ok(texts(d.bar).includes('圖文書：寫作、找圖與校對中'));
  assert.equal(dom.findAll(d.bar, i => i.tag === 'li').length, 0, 'no five-stage list');
  assert.equal(dom.find(d.bar, i => i.cls.includes('vam-book-now-text')).text, '正在寫第 1／4 章');
  const t = track(d.bar);
  assert.deepEqual([t.attrs['aria-valuemin'], t.attrs['aria-valuemax'], t.attrs['aria-valuenow']], ['0', '4', '1']);
  assert.equal(t.attrs['aria-valuetext'], '正在寫第 1／4 章');
  assert.deepEqual(buttonsOf(d.bar).map(b => b.text), ['停止']);
  assert.equal(dom.findAll(t, i => i.cls.includes('vam-book-seg')).length, 4);
  buttonsOf(d.bar)[0].click();
  assert.deepEqual(d.log, ['stop']);
  assert.equal(dom.findAll(d.bar, i => /分鐘/.test(i.text ?? '')).length, 0, 'no remaining-time number in stage 1');
  assert.ok(!texts(d.bar).some(x => /全書企劃|逐章企劃|找圖 |校對 \d/.test(x)), JSON.stringify(texts(d.bar)));
});

test('bar: every phase and status has its own words (zh-TW, en, zh-CN)', () => {
  const words = {
    'zh-TW': { planning: '圖文書：企劃中', gate1: '圖文書：等你確認', writing: '圖文書：寫作、找圖與校對中', gate2: '圖文書：完成待驗收', stopped: '圖文書：已停止', budget: '圖文書：額度用完' },
    en: { planning: 'Picture book: Planning', gate1: 'Picture book: Waiting for your confirmation', writing: 'Picture book: Writing, finding pictures and proofreading', gate2: 'Picture book: Done, waiting for review', stopped: 'Picture book: Stopped', budget: 'Picture book: Call budget used up' },
    'zh-CN': { planning: '图文书：企划中', gate1: '图文书：等你确认', writing: '图文书：写作、找图与校对中', gate2: '图文书：完成待验收', stopped: '图文书：已停止', budget: '图文书：额度用完' }
  };
  for (const [language, expected] of Object.entries(words)) {
    lang(language);
    for (const phase of ['planning', 'gate1', 'writing', 'gate2'])
      assert.equal(ui.bookTitleText(ui.bookBarState(bookData({ phase }), progress({ phase }), noStage)), expected[phase], `${language} ${phase}`);
    assert.equal(ui.bookTitleText(ui.bookBarState(bookData({ status: 'stopped' }), progress({ status: 'stopped', active: false }), noStage)), expected.stopped);
    assert.equal(ui.bookTitleText(ui.bookBarState(bookData(), progress({ status: 'stopped', active: false, pauseReason: 'budget' }), noStage)), expected.budget);
  }
  lang('zh-TW');
});

test('bar: a stopped run says stopped, names the phase, and offers "continue from where it stopped" (which calls resume)', () => {
  lang('zh-TW');
  const d = draw(bookData({ status: 'stopped' }), progress({ status: 'stopped', active: false }));
  assert.ok(texts(d.bar).includes('圖文書：已停止'));
  assert.ok(texts(d.bar).includes('停在「寫作、找圖與校對中」階段，已校 1／4'));
  assert.deepEqual(buttonsOf(d.bar).map(b => b.text), ['從停處繼續']);
  buttonsOf(d.bar)[0].click();
  assert.deepEqual(d.log, ['resume']);
});

test('bar: after a reload the runner knows nothing; a saved "running" with nothing driving it reads as stopped, counts come from the cards', () => {
  lang('zh-TW');
  const stages = { a: 'checked', b: 'checked', c: 'written' };
  const d = draw(bookData(), undefined, id => stages[id]);
  assert.ok(texts(d.bar).includes('圖文書：已停止'));
  assert.deepEqual([d.state.counts.checked, d.state.counts.written, d.state.counts.pending, d.state.total], [2, 1, 1, 4]);
  assert.deepEqual(buttonsOf(d.bar).map(b => b.text), ['從停處繼續']);
  const saved = draw(bookData({ status: 'stopped', pauseReason: 'budget' }), undefined, noStage);
  assert.equal(saved.state.mode, 'budget');
});

test('bar: budget exhausted shows the used-up line with "add 100" and "stop"; add 100 resumes with the extra', () => {
  lang('zh-TW');
  const d = draw(bookData({ status: 'stopped', pauseReason: 'budget' }), progress({ status: 'stopped', active: false, pauseReason: 'budget', budget: { used: 300, limit: 300 } }));
  assert.ok(texts(d.bar).includes('額度用完：已用 300／300 次'));
  assert.deepEqual(buttonsOf(d.bar).map(b => b.text), ['再加 100 次', '停止']);
  buttonsOf(d.bar)[0].click(); buttonsOf(d.bar)[1].click();
  assert.deepEqual(d.log, ['add', 'stop']);
});

test('bar: at gate 1 the confirm button shows (and calls confirmGate1); not in other phases', () => {
  lang('zh-TW');
  const gate = draw(bookData({ phase: 'gate1' }), progress({ phase: 'gate1', active: false }));
  assert.ok(buttonsOf(gate.bar).some(b => b.text === '這樣可以，跑完全書'));
  assert.ok(texts(gate.bar).includes('圖文書：等你確認'));
  buttonsOf(gate.bar).find(b => b.text === '這樣可以，跑完全書').click();
  assert.deepEqual(gate.log, ['confirm']);
  for (const phase of ['planning', 'writing', 'gate2'])
    assert.ok(!buttonsOf(draw(bookData({ phase }), progress({ phase })).bar).some(b => b.text === '這樣可以，跑完全書'), phase);
});

test('bar: a bar with nothing finished still has valid aria values (total 0 does not divide)', () => {
  const d = draw(bookData({ order: [] }), progress({ total: 0, counts: { pending: 0, planned: 0, written: 0, checked: 0, 'needs-review': 0 } }));
  const t = track(d.bar);
  assert.deepEqual([t.attrs['aria-valuemax'], t.attrs['aria-valuenow']], ['0', '0']);
  assert.equal(dom.findAll(t, i => i.cls.includes('vam-book-seg')).length, 0);
});

test('refusal text: every refusal code has a Chinese sentence in all three languages; unknown errors get the generic line; nothing throws', async () => {
  const codes = ['busy', 'blocked', 'root', 'exists', 'unusable', 'missing', 'finished', 'budget', 'disposed', 'unreadable', 'not_gate1'];
  for (const language of ['zh-TW', 'en', 'zh-CN']) {
    lang(language);
    const seen = new Set();
    for (const code of codes) {
      const text = ui.bookRefusalText(new runModule.BookPipelineRunError(code));
      assert.ok(text && !text.startsWith('ui.'), `${language} ${code}`);
      seen.add(text);
    }
    assert.equal(seen.size, codes.length, `${language}: one sentence per code`);
  }
  lang('zh-TW');
  assert.match(ui.bookRefusalText(new Error('boom')), /^圖文書流水線無法執行：boom/);
  assert.match(ui.bookRefusalText('weird'), /weird/);
  const messages = [];
  await ui.runBookEntry(() => Promise.reject(new runModule.BookPipelineRunError('root')), m => messages.push(m));
  await ui.runBookEntry(() => Promise.resolve(), m => messages.push(m));
  assert.equal(messages.length, 1);
  assert.match(messages[0], /根議題/);
});

test('issue text: neutral codes become Chinese reasons; unknown codes get the generic sentence', () => {
  lang('zh-TW');
  assert.equal(ui.bookIssueText('write failed: invalid_reply'), '寫作失敗：AI 回覆格式不符');
  assert.equal(ui.bookIssueText('plan failed: failed'), '企劃失敗：執行失敗');
  assert.equal(ui.bookIssueText('proof failed: no_open_page'), '校對時一個來源頁都打不開，無法核對。請按「重跑這張」，或打開卡片自己查證。');
  assert.equal(ui.bookIssueText('proof failed: no_body'), '這張卡還沒有正文，沒東西可校對。請按「重跑這張」重寫，或打開卡片自己補上內文。');
  assert.equal(ui.bookIssueText('write failed: no_body'), 'AI 這次沒寫出正文，卡片維持原樣。請按「重跑這張」再寫一次。');
  for (const code of ['no_body', 'empty_list', 'unparsable', 'missing_item', 'duplicate_item', 'unknown_item', 'no_open_page', 'invalid_reply', 'failed']) { const text = ui.bookIssueText(`proof failed: ${code}`); assert.ok(!/校對失敗|地圖|[a-z]+_[a-z]+/.test(text), `${code}: ${text}`); assert.ok(text.includes('這張'), code); }
  assert.equal(ui.bookIssueText('proof unmet: C1 C3'), '校對未達成項目：C1 C3');
  const generic = '需要人工查看（原因代碼無法辨識）。';
  for (const unknown of ['write failed: brand_new_code', 'something else', '', 'write failed: __proto__', 'proof failed: constructor']) assert.equal(ui.bookIssueText(unknown), generic, unknown);
});

test('issue text: every code the runner, the proof and the author wiring can produce has its own sentence in all three languages', () => {
  const codes = ['missing', 'card_removed', 'backup_failed', 'discarded', 'empty_list', 'no_body', 'invalid_reply', 'invalid_step', 'failed', 'author_failed', 'unparsable', 'missing_item', 'duplicate_item', 'unknown_item', 'no_open_page', 'all_facts_unverified', 'unsafe_body', 'no_view'];
  for (const language of ['zh-TW', 'zh-CN', 'en']) {
    lang(language);
    const generic = ui.bookIssueText('write failed: brand_new_code');
    for (const code of codes) assert.notEqual(ui.bookIssueText(`write failed: ${code}`), generic, `${language} ${code}`);
  }
});

test('card view: five stage labels and four role labels, each with words; a card with no stage reads "to plan"', () => {
  lang('zh-TW');
  const stages = { undefined: '待企劃', planned: '已企劃', written: '已寫', checked: '已校', 'needs-review': '需人看' };
  for (const [stage, text] of Object.entries(stages)) assert.equal(ui.bookCardView({ pipelineStage: stage === 'undefined' ? undefined : stage }).stageText, text);
  const roles = { intro: '導讀', body: '本文', gallery: '素材導覽', closing: '收尾' };
  for (const [role, text] of Object.entries(roles)) assert.equal(ui.bookCardView({ bookRole: role }).roleText, text);
  assert.equal(ui.bookCardView({ bookRole: 'weird' }).roleText, undefined);
  assert.equal(ui.bookCardView({ pipelineStage: 'bogus' }).stage, 'pending');
});

test('card view: summary prefix follows the stage; the reason shows only on needs-review cards', () => {
  lang('zh-TW');
  assert.equal(ui.bookCardView({}).summaryPrefix, undefined);
  assert.equal(ui.bookCardView({ pipelineStage: 'planned' }).summaryPrefix, '本章會講：');
  for (const stage of ['written', 'checked', 'needs-review']) assert.equal(ui.bookCardView({ pipelineStage: stage }).summaryPrefix, '實際講了：');
  assert.equal(ui.bookCardView({ pipelineStage: 'needs-review', pipelineIssue: 'proof unmet: C1' }).issueText, '需人看：校對未達成項目：C1');
  assert.equal(ui.bookCardView({ pipelineStage: 'checked', pipelineIssue: 'write failed: failed' }).issueText, undefined);
  assert.equal(ui.bookCardView({ pipelineStage: 'needs-review' }).issueText, undefined, 'no issue text, no line');
});

test('view: proof marks (needs-review pill, issue line, seam pill) show at gate 2 and are hidden once the book is done; other pills stay', async () => {
  const marks = async phase => {
    const h = await harness({ book: true, phase, stages: { root: 'planned', a: 'checked', b: 'needs-review' }, issue: 'write failed: invalid_reply' });
    Object.assign(h.view.notes.get(h.ids.a), { pipelineIssue: 'structure unmet: C1', pipelineSeam: 'x' });
    const stage = h.paint();
    return { states: dom.findAll(stage, i => i.cls.includes('vam-book-state')).map(i => i.text), issues: dom.findAll(stage, i => i.cls.includes('vam-card-book-issue')).length, roles: dom.findAll(stage, i => i.cls === 'vam-book-role').length };
  };
  const gate2 = await marks('gate2');
  assert.deepEqual(gate2.states, ['已企劃', '已校', '接縫需看', '需人看']);
  assert.equal(gate2.issues, 2);
  const done = await marks('done');
  assert.deepEqual(done.states, ['已企劃', '已校'], 'no needs-review pill, no seam pill; planned and checked stay');
  assert.equal(done.issues, 0);
  assert.equal(done.roles, 3, 'role tags stay');
});

test('card labels: dot-and-word state beside a role tag; the writing state shows "writing" with a clock and no stage chip', () => {
  lang('zh-TW');
  const header = dom.element('div');
  ui.renderBookCardLabels(header, ui.bookCardView({ pipelineStage: 'checked', bookRole: 'body' }));
  const [state, role] = header.children;
  assert.deepEqual([state.cls, state.text, role.cls, role.text], ['vam-status vam-book-state is-checked', '已校', 'vam-book-role', '本文']);
  const writingHeader = dom.element('div');
  let tracked = null;
  ui.renderBookCardLabels(writingHeader, ui.bookCardView({ pipelineStage: 'planned', bookRole: 'gallery' }), { track: el => { tracked = el; el.setText('0:42'); } });
  const chip = writingHeader.children[0];
  assert.match(chip.cls, /vam-status-running/);
  assert.equal(chip.children[0].text, '寫作中');
  assert.equal(tracked.text, '0:42');
  assert.equal(tracked.attrs['aria-hidden'], 'true', 'the clock is not read out each second');
  assert.equal(writingHeader.children[1].text, '素材導覽');
});

// ---- the view: a real renderNode on a fake vault, with and without bookPipeline ----
async function harness({ book, stages = {}, issue, phase }) {
  const { repo, app } = support.fixture('zh-TW', { linkIndex: true });
  const settings = { ...support.DEFAULT_SETTINGS, language: 'zh-TW', cliModel: 'gpt-6-luna' };
  repo.settings = settings;
  const mapDoc = { id: 'map-bk1', title: 'BK', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  await repo.ensureTopicFolders('Agent Workspace/Topics/map-bk1');
  const ids = {};
  for (const [key, parent] of [['root', null], ['a', 'root'], ['b', 'root']]) {
    const created = await repo.createNote(key, 'gpt-6-luna', mapDoc, MAP, 'workspace', { summary: `summary of ${key}` });
    Object.assign(created, { parentId: parent ? ids[parent] : null, x: 0, y: mapDoc.nodes.length * 100 });
    mapDoc.nodes.push(created); ids[key] = created.id;
  }
  if (book) mapDoc.bookPipeline = bookData({ order: [ids.root, ids.a, ids.b], ...(phase ? { phase } : {}) });
  await app.vault.create(MAP, support.core.serializeMap(mapDoc));
  await repo.rebuildDerivedData();
  notices.length = 0;
  setUiLanguage('zh-TW');
  const { VisualAgentMapView } = bundle;
  const entries = [];
  const ctl = { calls: [], saves: [], impl: async () => ({}) };
  const plugin = support.withExpansionCoordinator({
    repo, settings, running: new Set(), logs: { appendLog() {} }, rebuildDerivedData: () => repo.rebuildDerivedData(), relevanceGrades: new Map(), expansionBatches: new Map(), pendingSuggestions: new Map(), releaseOutline() {}, setOutlineActive() {}, detailsShown: () => false,
    mutate: work => Promise.resolve().then(work),
    getBookPipelineProgress: () => undefined,
    argumentRuns: { isRunning: () => false },
    modelLabel: model => `M:${model}`,
    availableModels: () => ['claude:sonnet', 'claude:opus', 'claude:haiku'],
    saveSettings: async () => { ctl.saves.push({ ...settings }); },
    suggestBookSettings: (input, signal) => { ctl.calls.push({ input, signal }); return ctl.impl(input, signal); },
    startBookPipeline: async (p, o) => { entries.push(o ? ['start', p, o] : ['start', p]); },
    stopBookPipeline: async p => { entries.push(['stop', p]); },
    resumeBookPipeline: async (p, o) => { entries.push(['resume', p, o]); },
    confirmBookGate1: async p => { entries.push(['confirm', p]); },
    abandonBookPipeline: async p => { entries.push(['abandon', p]); }
  });
  support.attachTopicRuns(plugin);
  const view = new VisualAgentMapView({ app }, plugin);
  view.path = MAP; view.map = await repo.readMap(MAP); view.stageEl = dom.element('div'); view.contentEl = dom.element('div');
  view.focusNode = () => {}; view.openDetails = () => {}; view.labelCard = () => {};
  view.hydrate = async () => { view.notes = new Map(await Promise.all(view.map.nodes.map(async n => [n.id, await repo.readNote(n.path)]))); };
  await view.hydrate();
  for (const [key, stage] of Object.entries(stages)) Object.assign(view.notes.get(ids[key]), { pipelineStage: stage, bookRole: key === 'root' ? 'intro' : 'body', ...(stage === 'needs-review' ? { pipelineIssue: issue } : {}) });
  view.render = () => { view.rendered = (view.rendered ?? 0) + 1; };
  view.selection.moveTabStop(view.defaultTabStop(view.map.nodes));
  const paint = () => { view.stageEl = dom.element('div'); view.cardEls.clear(); for (const n of view.map.nodes) view.renderNode(n); return view.stageEl; };
  return { view, ids, paint, entries, notices, plugin, ctl };
}
/** The toolbar entry opens the start card; pressing its Start button runs the entry. */
async function startFromCard(h) {
  await h.view.startBookPipelineFromUi();
  const modal = h.view.bookStartModal;
  assert.ok(modal?.isOpen, 'the start card is open');
  dom.findAll(modal.modalEl, i => i.tag === 'button').find(b => b.text === '開始').click();
  await dom.tick();
}
const cardClasses = stage => new Set(dom.findAll(stage, () => true).flatMap(i => i.classes));

test('view: a map without bookPipeline draws no new element on any card, even when a note carries pipeline fields', async () => {
  const h = await harness({ book: false, stages: { a: 'checked', b: 'needs-review' }, issue: 'write failed: failed' });
  const classes = cardClasses(h.paint());
  for (const name of classes) assert.ok(!/book/.test(name), name);
  assert.equal(dom.findAll(h.view.stageEl, i => (i.text ?? '').includes('實際講了')).length, 0);
  assert.equal(dom.find(h.view.stageEl, i => i.cls.includes('vam-card-book-issue')), undefined);
  const toolbar = dom.element('div');
  h.view.renderBookPipelineBar(toolbar);
  assert.equal(toolbar.children.length, 0);
});

test('view: a bookPipeline map shows the stage and role labels, the summary prefixes, and the reason inside the needs-review card; the old chips stay', async () => {
  const h = await harness({ book: true, stages: { root: 'planned', a: 'checked', b: 'needs-review' }, issue: 'write failed: invalid_reply' });
  const stage = h.paint();
  const states = dom.findAll(stage, i => i.cls.includes('vam-book-state')).map(i => i.text);
  assert.deepEqual(states, ['已企劃', '已校', '需人看']);
  assert.deepEqual(dom.findAll(stage, i => i.cls === 'vam-book-role').map(i => i.text), ['導讀', '本文', '本文']);
  assert.deepEqual(dom.findAll(stage, i => i.cls.includes('vam-book-summary-prefix')).map(i => i.text), ['本章會講：', '實際講了：', '實際講了：']);
  assert.deepEqual(dom.findAll(stage, i => i.cls.includes('vam-card-book-issue')).map(i => i.text), ['需人看：寫作失敗：AI 回覆格式不符']);
  const summary = dom.find(stage, i => i.cls.includes('vam-card-summary'));
  assert.equal(summary.children[0].cls, 'vam-book-summary-prefix', 'the prefix comes first');
  assert.equal(h.view.notes.get(h.ids.a).summary, 'summary of a', 'the note text is not changed');
  assert.ok(dom.findAll(stage, i => i.cls.includes('vam-status')).length >= 3, 'the existing status chips are still drawn');
});

test('view: a card the author step is writing shows "writing" and a ticking clock, and the entry is cleaned up with the view', async () => {
  const h = await harness({ book: true, stages: { a: 'planned' } });
  const path = h.view.map.nodes.find(n => n.id === h.ids.a).path;
  h.view.bookAuthoring.set(path, Date.now() - 42_000);
  const stage = h.paint();
  const chip = dom.find(stage, i => i.cls.includes('is-writing'));
  assert.ok(chip, 'writing chip drawn');
  assert.equal(chip.children[0].text, '寫作中');
  assert.match(chip.children[1].text, /0:4\d/);
  assert.ok(h.view.researchElapsed.has(chip.children[1]), 'the existing one-second tick owns the clock');
  assert.match(view_ts, /this\.bookAuthoring\.clear\(\);/);
  assert.match(view_ts, /finally \{ this\.bookAuthoring\.delete\(node\.path\);/);
});

test('T3 card button: gate 2 and done book cards carry "重跑這張" in the tool row; it runs the rerun, is disabled with the reason while another card, the whole book or a chat is busy; none at gate 1, while writing, or on a plain map', async () => {
  const h = await harness({ book: true, stages: { a: 'checked', b: 'needs-review' }, issue: 'write failed: invalid_reply' });
  const calls2 = [];
  h.plugin.rerunBookCard = async (p, id) => { calls2.push([p, id]); return {}; };
  h.view.rereadBookCard = async () => {};
  const rerunButtons = stage => dom.findAll(stage, i => i.tag === 'button' && i.cls.includes('vam-node-rerun'));
  const withProgress = over => { h.plugin.getBookPipelineProgress = () => progress({ phase: 'gate2', active: false, ...over }); h.view.bookPipelineSeen = null; };
  withProgress({});
  const stage = h.paint();
  const buttons = rerunButtons(stage);
  assert.equal(buttons.length, 3, 'every book card');
  assert.ok(buttons.every(b => /重跑這張/.test(texts(b).join('')) && !b.disabled));
  assert.ok(buttons.every(b => dom.findAll(stage, i => i.cls.includes('vam-node-header')).some(t => t.children.includes(b))), 'in the card header, which always shows (not the hover-only tool row)');
  assert.ok(buttons.every(b => !dom.findAll(stage, i => i.cls.includes('vam-node-tools')).some(t => t.children.includes(b))));
  buttons[1].click();
  await dom.tick();
  assert.deepEqual(calls2, [[MAP, h.ids.a]]);
  assert.ok(h.view.rendered >= 1, 'the map repaints afterwards');
  withProgress({ phase: 'done' });
  assert.equal(rerunButtons(h.paint()).length, 0, 'gone once the review is finished (the right-click item stays)');
  withProgress({ rerun: { nodeId: h.ids.a, startedAt: 1 }, active: true });
  const busy = rerunButtons(h.paint());
  assert.ok(busy.every(b => b.disabled), 'one rerun at a time');
  assert.equal(busy[1].attrs.title, '這一張正在重跑');
  assert.equal(busy[2].attrs.title, '這一張正在重跑'.replace('這一張', '另一張') );
  withProgress({ active: true });
  assert.equal(rerunButtons(h.paint())[0].attrs.title, '圖文書正在執行，等它結束後再重跑');
  withProgress({ busyCards: [h.ids.b] });
  assert.equal(rerunButtons(h.paint())[2].attrs.title, '這一張正在重跑');
  withProgress({});
  h.view.chatChainRunner = { current: {} };
  assert.equal(rerunButtons(h.paint())[0].attrs.title, '對話進行中，等它結束後再重跑');
  h.view.chatChainRunner = null;
  for (const phase of ['gate1', 'writing', 'planning']) { withProgress({ phase }); assert.equal(rerunButtons(h.paint()).length, 0, phase); }
  const plain = await harness({ book: false, stages: { a: 'checked' } });
  assert.equal(rerunButtons(plain.paint()).length, 0);
  assert.match(css, /\.vam-node-header > \.vam-node-rerun \{ display: inline-flex;[^}]*white-space: nowrap; \}/);
  assert.doesNotMatch(css, /vam-node-rerun[^{]*\{[^}]*display: none/);
  assert.match(css, /\.vam-viewport\.is-zoomed-out \.vam-node-header > \.vam-node-rerun \{[^}]*position: absolute;[^}]*font-size: 0;[^}]*transform: scale\(calc\(0\.6 \/ var\(--vam-zoom, 1\)\)\);[^}]*transform-origin: right bottom;/);
  withProgress({});
  h.view.map.bookPipeline.order = [h.ids.root, h.ids.a];
  const partial = rerunButtons(h.paint());
  assert.equal(partial.length, 2, 'a card that is not in the book order has no rerun button');
  assert.ok(partial.every(b => b.disabled === false || !b.disabled));
  assert.equal(h.view.bookRerunWhy(h.view.map.nodes.find(n => n.id === h.ids.b), true), undefined, 'nor a right-click item');
});

test('T3 view close: no rerun clock is left on a one-second timer (the card chip of a rerun starts none)', async () => {
  const h = await harness({ book: true, stages: { a: 'checked' } });
  h.plugin.getBookPipelineProgress = () => progress({ phase: 'gate2', active: true, current: [{ nodeId: h.ids.a, step: 'write', startedAt: 5 }], rerun: { nodeId: h.ids.a, startedAt: 5 } });
  h.view.bookPipelineSeen = null;
  const stage = h.paint();
  const chip = dom.find(stage, i => i.cls.includes('is-rerun'));
  assert.equal(chip.children[0].text, '處理中');
  assert.equal(h.view.researchElapsed.size, 0);
  assert.equal(h.view.researchTick, null, 'no interval was created');
});

test('view: the bar draws for a book map from getBookPipelineProgress and its buttons call the plugin entries with this map', async () => {
  const h = await harness({ book: true });
  h.plugin.getBookPipelineProgress = p => (p === MAP ? progress({ phase: 'gate1', active: false }) : undefined);
  const toolbar = dom.element('div');
  h.view.renderBookPipelineBar(toolbar);
  const bar = toolbar.children[0];
  assert.equal(bar.cls, 'vam-book-bar');
  const confirm = buttonsOf(bar).find(b => b.text === '這樣可以，跑完全書');
  confirm.click();
  await dom.tick();
  assert.equal(JSON.stringify(h.entries), JSON.stringify([['confirm', MAP]]));
  assert.equal(h.view.rendered, 1, 'the map repaints after the entry');
  h.plugin.getBookPipelineProgress = () => progress({ status: 'stopped', active: false, pauseReason: 'budget' });
  const second = dom.element('div');
  h.view.renderBookPipelineBar(second);
  buttonsOf(second.children[0]).find(b => b.text === '再加 100 次').click();
  await dom.tick();
  assert.equal(JSON.stringify(h.entries[1]), JSON.stringify(['resume', MAP, { addBudget: 100 }]));
});

test('view: an unreadable bookPipeline key draws no bar and no labels (the entries refuse it with a message)', async () => {
  const h = await harness({ book: true, stages: { a: 'checked' } });
  h.view.map = { ...h.view.map, bookPipeline: { v: 99 } };
  const toolbar = dom.element('div');
  h.view.renderBookPipelineBar(toolbar);
  assert.equal(toolbar.children.length, 0);
  assert.equal(dom.find(h.paint(), i => i.cls.includes('vam-book-state')), undefined);
});

test('toolbar button and command: start calls the plugin entry; a refusal is a message, never an unhandled rejection', async () => {
  const h = await harness({ book: false });
  await startFromCard(h);
  assert.equal(JSON.stringify(h.entries), JSON.stringify([['start', MAP]]));
  for (const code of ['busy', 'blocked', 'root', 'exists', 'unusable']) {
    h.plugin.startBookPipeline = async () => { throw new runModule.BookPipelineRunError(code); };
    await startFromCard(h);
  }
  assert.equal(h.notices.length, 5);
  assert.match(h.notices[2], /根議題/);
  h.plugin.startBookPipeline = async () => { throw new TypeError('network down'); };
  await startFromCard(h);
  assert.match(h.notices[5], /圖文書流水線無法執行/);
});

test('toolbar button is a primary button beside the map actions and the command has the same name (source)', () => {
  assert.match(view_ts, /headerActions\.createEl\("button", \{ cls: "mod-cta vam-book-button", text: t\("ui\.book_button"\) \}\)/);
  assert.match(view_ts, /bookButton\.addEventListener\("click", \(\) => void this\.startBookPipelineFromUi\(\)\)/);
  assert.match(main_ts, /addLocalizedCommand\("book-pipeline", "ui\.command_book_pipeline"/);
  for (const language of ['zh-TW', 'en', 'zh-CN']) {
    setUiLanguage(language);
    assert.equal(tr('ui.command_book_pipeline'), tr('ui.book_button'));
  }
  lang('zh-TW');
});

test('styles: the bar wraps full width inside the toolbar, buttons are focus-visible, colors are theme variables, no !important', () => {
  const book = css.slice(css.indexOf('/* Picture-book pipeline (03b)'));
  assert.match(book, /\.vam-book-bar \{[^}]*flex: 1 1 100%/);
  assert.match(book, /\.vam-book-bar-top \{[^}]*flex-wrap: wrap/);
  assert.match(book, /\.vam-book-bar button:focus-visible/);
  assert.match(book, /\.vam-book-button:focus-visible/);
  assert.ok(!/!important/.test(book));
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(book) && !/rgb\(/.test(book), 'no hard-coded colors');
});

test('the model reads the saved key the bar relies on', () => {
  assert.equal(model.readBookPipeline({ bookPipeline: bookData() }).kind, 'usable');
});

test('bar: a run that stopped by itself shows the reason in words (three languages) and a retry button, never the raw code; an owner stop does not', () => {
  const expected = { 'zh-TW': ['停在「企劃中」階段：AI 回覆格式不符，重試多次仍失敗', '重試'], en: ['Stopped in the Planning phase: The AI reply did not fit the format after several tries', 'Retry'], 'zh-CN': ['停在“企划中”阶段：AI 回复格式不符，重试多次仍失败', '重试'] };
  for (const [language, [line, retry]] of Object.entries(expected)) {
    lang(language);
    const data = bookData({ phase: 'planning', status: 'stopped', pauseReason: 'failed', failureCode: 'invalid_reply', globalPlanned: false });
    for (const prog of [undefined, progress({ phase: 'planning', status: 'stopped', active: false, pauseReason: 'failed', failureCode: 'invalid_reply' })]) {
      const d = draw(data, prog);
      assert.ok(texts(d.bar).includes(line), `${language} ${line}`);
      assert.deepEqual(buttonsOf(d.bar).map(b => b.text), [retry]);
      assert.equal(texts(d.bar).some(x => x.includes('invalid_reply')), false);
      buttonsOf(d.bar)[0].click();
      assert.deepEqual(d.log, ['resume']);
    }
  }
  lang('zh-TW');
  assert.match(ui.bookFailureText('internal_TypeError'), /未預期/);
  const plainStop = draw(bookData({ phase: 'planning', status: 'stopped' }), undefined);
  assert.deepEqual(buttonsOf(plainStop.bar).map(b => b.text), ['從停處繼續']);
});

test('model: failureCode must be a neutral code; a pauseReason of failed is readable', () => {
  assert.equal(model.readBookPipeline({ bookPipeline: bookData({ status: 'stopped', pauseReason: 'failed', failureCode: 'backup_failed' }) }).kind, 'usable');
  assert.equal(model.readBookPipeline({ bookPipeline: bookData({ status: 'stopped', pauseReason: 'failed', failureCode: 'has space' }) }).kind, 'unusable');
  assert.equal(model.readBookPipeline({ bookPipeline: bookData({ pauseReason: 'other' }) }).kind, 'unusable');
});

test('a checked card with unmet structure items shows only a small count; a checked card without them, and a malformed issue, show nothing', () => {
  setUiLanguage('zh-TW');
  assert.equal(ui.bookCardView({ pipelineStage: 'checked', pipelineIssue: 'structure unmet: C2 C3' }).issueText, '結構 2 項未達成');
  assert.equal(ui.bookCardView({ pipelineStage: 'checked' }).issueText, undefined);
  assert.equal(ui.bookCardView({ pipelineStage: 'checked', pipelineIssue: 'whatever <b>' }).issueText, undefined);
  assert.equal(ui.bookCardView({ pipelineStage: 'written', pipelineIssue: 'structure unmet: C2' }).issueText, undefined);
});

test('slots: a card with only picture problems shows "n spots worth a look", not "structure n unmet"; real structure items stay counted apart', () => {
  setUiLanguage('zh-TW');
  assert.equal(ui.bookCardView({ pipelineStage: 'checked', pipelineIssue: 'structure unmet: image_1 image_count' }).issueText, '通過，2 處可留意');
  assert.equal(ui.bookCardView({ pipelineStage: 'checked', pipelineIssue: 'structure unmet: C2 C3' }).issueText, '結構 2 項未達成');
  assert.equal(ui.bookCardView({ pipelineStage: 'checked', pipelineIssue: 'structure unmet: C2 image_1 image_marker' }).issueText, '結構 1 項未達成；2 處可留意');
  setUiLanguage('en');
  assert.equal(ui.bookCardView({ pipelineStage: 'checked', pipelineIssue: 'structure unmet: image_1' }).issueText, 'Passed, 1 spot(s) worth a look');
  setUiLanguage('zh-CN');
  assert.equal(ui.bookCardView({ pipelineStage: 'checked', pipelineIssue: 'structure unmet: image_1' }).issueText, '通过，1 处可留意');
  setUiLanguage('zh-TW');
});

test('bar: a saved done of the same run is final even when the runner record still says gate2', () => {
  const state = ui.bookBarState(bookData({ phase: 'done', status: 'running' }), progress({ phase: 'gate2', active: false }), noStage);
  assert.equal(state.phase, 'done'); assert.equal(state.mode, 'done');
  assert.equal(ui.bookBarState(bookData({ phase: 'done' }), progress({ runId: 'r2', phase: 'planning' }), noStage).phase, 'planning', 'a newer run is not hidden');
});

// ---- T3: the start card and the plain-words progress ----
const openCard = async h => { await h.view.startBookPipelineFromUi(); return h.view.bookStartModal; };
const cardButton = (modal, text) => dom.findAll(modal.modalEl, i => i.tag === 'button').find(b => b.text === text);
const rootPath = h => h.view.map.nodes.find(n => n.id === h.ids.root).path;

/** Shown on screen as far as a stand-in DOM can tell: no ancestor is hidden or a closed <details>. The real computed style is checked live. */
const shown = el => { for (let n = el; n; n = n.parent) if (n.hidden || (n.tag === 'details' && !n.open)) return false; return true; };
const field = (modal, label) => dom.findAll(modal.modalEl, i => i.tag === 'textarea').find(f => f.attrs['aria-label'] === label);

test('start card: opens with the estimate (1+5N calls, about minutes), the six settings open (no <details>), the four model dropdowns always shown below the estimate (no summary, no change link); nothing starts yet', async () => {
  const h = await harness({ book: false });
  const modal = await openCard(h);
  assert.ok(modal.isOpen);
  assert.equal(h.entries.length, 0, 'nothing starts before the owner presses Start');
  const all = texts(modal.modalEl);
  assert.ok(all.includes('3 張卡 · 約 4 分鐘 · 最多 16 次 AI 呼叫。'), all.join('|'));
  assert.ok(all.includes('中間只會停兩次，讓你確認。'));
  assert.ok(all.includes('某一章不滿意，可以只重跑那一章。'));
  assert.equal(dom.find(modal.modalEl, i => i.tag === 'details'), undefined, 'no collapsed block: the settings are always open');
  const areas = dom.findAll(modal.modalEl, i => i.tag === 'textarea');
  assert.equal(areas.length, 6);
  for (const area of areas) assert.ok(shown(area), 'each field is on screen');
  const s = h.plugin.settings;
  assert.ok(!all.some(x => x.startsWith('模型：')), 'no summary line');
  const selects = dom.findAll(modal.modalEl, i => i.tag === 'select');
  assert.equal(selects.length, 4);
  for (const select of selects) assert.ok(shown(select), 'the four dropdowns are always shown');
  assert.equal(dom.find(modal.modalEl, i => i.cls.includes('vam-book-start-models-change')), undefined, 'no change link');
  assert.deepEqual(dom.findAll(modal.modalEl, i => i.tag === 'button').map(b => b.text), ['取消', '開始']);
  // DOM order: intro, estimate, models, stops, settings.
  const order = dom.findAll(modal.modalEl, () => true);
  const at = pred => order.findIndex(pred);
  const iIntro = at(i => i.cls.includes('vam-modal-intro')), iEst = at(i => i.cls.includes('vam-book-start-estimate'));
  const iModels = at(i => i.cls.includes('vam-book-start-model-choice')), iStops = at(i => i.cls.includes('vam-book-start-stops')), iSettings = at(i => i.cls.includes('vam-book-start-settings'));
  assert.ok(iIntro >= 0 && iIntro < iEst && iEst < iModels && iModels < iStops && iStops < iSettings, [iIntro, iEst, iModels, iStops, iSettings].join(','));
  void s;
  assert.equal(dom.focusedNow().text, '取消', 'the keyboard starts on Cancel, so a stray Enter never starts the run');
  cardButton(modal, '取消').click();
  assert.equal(modal.isOpen, false);
  assert.equal(h.entries.length, 0, 'Cancel starts nothing');
});

test('start card: the four dropdowns (plan, author, pictures, proofread) carry the AI model list; a pick is saved on Start only, the time follows, the calls do not', async () => {
  const h = await harness({ book: false });
  const modal = await openCard(h);
  const selects = dom.findAll(modal.modalEl, i => i.tag === 'select');
  for (const select of selects) assert.ok(shown(select));
  assert.deepEqual(selects.map(x => x.attrs['aria-label']), ['企劃', '寫作', '找圖', '校對']);
  assert.deepEqual(selects[1].children.map(o => o.optionValue), ['claude:sonnet', 'claude:opus', 'claude:haiku']);
  assert.equal(selects[1].value, h.plugin.settings.bookWriteModel);
  const before = texts(modal.modalEl).find(x => x.startsWith('3 張卡'));
  selects[1].value = 'claude:sonnet'; selects[1].change();
  assert.notEqual(h.plugin.settings.bookWriteModel, 'claude:sonnet', 'a pick is not saved while the card is open');
  assert.equal(h.ctl.saves.length, 0);
  const after = texts(modal.modalEl).find(x => x.startsWith('3 張卡'));
  assert.match(before, /最多 16 次/); assert.match(after, /最多 16 次/);
  assert.notEqual(before, after, 'the time follows the model');
  cardButton(modal, '開始').click(); await dom.tick();
  assert.equal(h.plugin.settings.bookWriteModel, 'claude:sonnet', 'Start saves the pick');
  assert.equal(h.ctl.saves.length, 1);
});

test('start card: Cancel after changing the models leaves the saved models exactly as they were (nothing saved, nothing started)', async () => {
  const h = await harness({ book: false });
  const was = { plan: h.plugin.settings.bookPlanModel, write: h.plugin.settings.bookWriteModel, images: h.plugin.settings.bookImageModel, proof: h.plugin.settings.bookProofModel };
  const modal = await openCard(h);
  const selects = dom.findAll(modal.modalEl, i => i.tag === 'select');
  selects[0].value = 'claude:opus'; selects[0].change();
  selects[1].value = 'claude:haiku'; selects[1].change();
  cardButton(modal, '取消').click(); await dom.tick();
  assert.deepEqual({ plan: h.plugin.settings.bookPlanModel, write: h.plugin.settings.bookWriteModel, images: h.plugin.settings.bookImageModel, proof: h.plugin.settings.bookProofModel }, was);
  assert.equal(h.ctl.saves.length, 0); assert.equal(h.entries.length, 0);
});

test('start: a map with a root and no chapter cards opens no card; the entry gives its plain refusal', async () => {
  const h = await harness({ book: false });
  h.view.map.nodes = h.view.map.nodes.filter(n => n.id === h.ids.root);
  await h.view.startBookPipelineFromUi();
  assert.equal(h.view.bookStartModal, null);
  assert.equal(h.entries.length, 1);
});

// ---- the start card's grey suggestions (T1 P1b) ----
const SUGGEST = { reader: '對心理學有興趣的一般大人', goal: '能用日常例子說出主要概念', angle: '從日常現象進到理論', tone: '親切、少用術語', length: '約 1,500 字', style: '先舉例，再說概念' };
const pending = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

test('suggestions: one call on the picture model\'s entry with only the root title, summary and first-level chapter titles; they show as grey italic placeholders, the fields stay empty', async () => {
  const h = await harness({ book: false });
  h.ctl.impl = async () => SUGGEST;
  const modal = await openCard(h);
  await dom.tick(); await dom.tick(); await dom.tick();
  assert.equal(h.ctl.calls.length, 1);
  const input = h.ctl.calls[0].input;
  assert.deepEqual(Object.keys(input).sort(), ['chapters', 'mapPath', 'summary', 'title']);
  assert.equal(input.mapPath, MAP);
  assert.equal(JSON.stringify(input.chapters), JSON.stringify(['a', 'b']));
  for (const [label, key] of [['讀者', 'reader'], ['學習目標', 'goal'], ['想看的角度', 'angle'], ['語氣', 'tone'], ['每章字數', 'length'], ['寫作風格', 'style']]) {
    const area = field(modal, label);
    assert.equal(area.attrs.placeholder, SUGGEST[key]);
    assert.equal(area.value, '', 'the suggestion is a placeholder, not text the owner would have to delete');
    assert.ok(area.hasClass('vam-book-start-suggested'));
    assert.ok(shown(area));
  }
  assert.ok(!texts(modal.modalEl).includes('正在依這張心智圖的主題想建議⋯⋯'), 'the waiting line is gone');
  // The grey italic look is real CSS on the placeholder (computed look: checked live).
  assert.match(css, /\.vam-book-start-field\.vam-book-start-suggested::placeholder \{[^}]*font-style: italic[^}]*color: var\(--text-muted\)/);
  modal.close();
});

test('suggestions: failure, a timeout (20 s) and a late answer leave the fields on the default hint and the card still starts', async () => {
  // failure
  let h = await harness({ book: false });
  const failing = pending(); h.ctl.impl = () => failing.promise;
  let modal = await openCard(h);
  assert.ok(texts(modal.modalEl).includes('正在依這張心智圖的主題想建議⋯⋯'));
  failing.reject(new Error('boom')); await dom.tick(); await dom.tick();
  assert.equal(field(modal, '讀者').attrs.placeholder, '留空 → 由總編輯決定');
  assert.ok(!texts(modal.modalEl).includes('正在依這張心智圖的主題想建議⋯⋯'));
  cardButton(modal, '開始').click(); await dom.tick(); await dom.tick();
  assert.equal(JSON.stringify(h.entries), JSON.stringify([['start', MAP]]));
  assert.equal((await h.plugin.repo.readNote(rootPath(h))).bookSettings, undefined, 'nothing written');
  // timeout: the held timer fires, the call is aborted and a later answer is dropped
  timers.hold = true; timers.held.length = 0;
  h = await harness({ book: false });
  const slow = pending(); h.ctl.impl = () => slow.promise;
  modal = await openCard(h);
  await dom.tick();
  assert.equal(timers.held.length, 1, 'one 20 s timer');
  assert.equal(bundleStart.BOOK_SUGGEST_TIMEOUT_MS, 20000);
  timers.held[0](); await dom.tick(); await dom.tick();
  assert.equal(h.ctl.calls[0].signal.aborted, true);
  assert.equal(field(modal, '讀者').attrs.placeholder, '留空 → 由總編輯決定');
  slow.resolve(SUGGEST); await dom.tick(); await dom.tick();
  assert.equal(field(modal, '讀者').attrs.placeholder, '留空 → 由總編輯決定', 'an answer after the timeout is dropped');
  cardButton(modal, '開始').click(); await dom.tick(); await dom.tick();
  assert.equal(h.entries.length, 1);
  timers.hold = false; timers.held.length = 0;
  // late: the card is closed by Start, then the answer arrives
  h = await harness({ book: false });
  const late = pending(); h.ctl.impl = () => late.promise;
  modal = await openCard(h);
  cardButton(modal, '開始').click(); await dom.tick(); await dom.tick();
  assert.equal(h.ctl.calls[0].signal.aborted, true, 'closing aborts the call');
  late.resolve(SUGGEST); await dom.tick(); await dom.tick();
  assert.equal((await h.plugin.repo.readNote(rootPath(h))).bookSettings, undefined, 'a suggestion after Start writes nothing');
  assert.equal(h.entries.length, 1);
});

test('suggestions: typed text is never replaced; Start writes a suggestion only into a field that is empty, with typed text as typed, nothing for a field without a suggestion', async () => {
  const h = await harness({ book: false });
  await h.plugin.repo.writeBookSettings(rootPath(h), { reader: 'kids' });
  const answer = pending(); h.ctl.impl = () => answer.promise;
  const modal = await openCard(h);
  await dom.tick(); await dom.tick();
  assert.equal(h.ctl.calls.length, 1);
  field(modal, '語氣').value = '  嚴肅  的語氣 ';     // typed before the suggestion arrives
  answer.resolve({ ...SUGGEST, style: '' });
  await dom.tick(); await dom.tick(); await dom.tick();
  assert.equal(field(modal, '語氣').value, '  嚴肅  的語氣 ', 'the owner\'s text is untouched');
  assert.equal(field(modal, '讀者').value, 'kids', 'a prefilled field shows its value, not a suggestion');
  assert.equal(field(modal, '讀者').attrs.placeholder, '留空 → 由總編輯決定');
  cardButton(modal, '開始').click(); await dom.tick(); await dom.tick();
  const root = await h.plugin.repo.readNote(rootPath(h));
  assert.equal(JSON.stringify(root.bookSettings), JSON.stringify({ reader: 'kids', goal: SUGGEST.goal, angle: SUGGEST.angle, tone: '嚴肅 的語氣', length: SUGGEST.length }), 'suggestions for empty fields, the typed tone, no style (no suggestion), reader kept');
});

test('suggestions: typed before the answer, then cleared, then Start writes nothing for that field (the owner never saw the suggestion)', async () => {
  const h = await harness({ book: false });
  const answer = pending(); h.ctl.impl = () => answer.promise;
  const modal = await openCard(h);
  await dom.tick(); await dom.tick();
  field(modal, '語氣').value = 'my tone';
  answer.resolve(SUGGEST);
  await dom.tick(); await dom.tick(); await dom.tick();
  assert.equal(field(modal, '讀者').attrs.placeholder, SUGGEST.reader, 'an untouched field shows the suggestion');
  field(modal, '語氣').value = '';
  cardButton(modal, '開始').click(); await dom.tick(); await dom.tick();
  const root = await h.plugin.repo.readNote(rootPath(h));
  assert.equal(root.bookSettings.tone, undefined, 'no tone written');
  assert.equal(root.bookSettings.reader, SUGGEST.reader, 'a field that showed its suggestion still takes it');
});

test('suggestions: a root with all six fields filled opens the card with no call and no "thinking" line', async () => {
  const h = await harness({ book: false });
  await h.plugin.repo.writeBookSettings(rootPath(h), { reader: 'a', goal: 'b', angle: 'c', tone: 'd', length: 'e', style: 'f' });
  const modal = await openCard(h);
  await dom.tick(); await dom.tick();
  assert.equal(h.ctl.calls.length, 0);
  assert.equal(texts(modal.modalEl).includes('正在依這張心智圖的主題想建議⋯⋯'), false);
});

test('suggestions: the patch helper keeps typed text over a suggestion and ignores suggestions for a cleared prefilled field', () => {
  const s = bundleStart;
  assert.equal(JSON.stringify(s.bookSettingsPatch({}, { reader: '', tone: ' x ' }, { reader: 'R', tone: 'T', goal: 'G' })), JSON.stringify({ reader: 'R', tone: 'x' }));
  assert.equal(JSON.stringify(s.bookSettingsPatch({ tone: 'warm' }, { tone: '' }, { tone: 'T' })), JSON.stringify({ tone: null }));
  assert.equal(JSON.stringify(s.bookSettingsPatch({}, { reader: '' }, { reader: 'a\nb' })), JSON.stringify({ reader: 'a b' }));
});

test('start card: the estimate numbers (1+5N calls; the 135 s whole-book plan, then cards five at a time at the measured median) and the minutes wording', () => {
  const start = bundleStart;
  assert.equal(JSON.stringify(start.bookStartEstimate(15)), JSON.stringify({ cards: 15, calls: 76, seconds: 135 + 3 * 88.5 }));
  assert.equal(JSON.stringify(start.bookStartEstimate(0)), JSON.stringify({ cards: 0, calls: 1, seconds: 135 }));
  lang('zh-TW');
  assert.equal(start.bookStartEstimateText(start.bookStartEstimate(15)), '15 張卡 · 約 7 分鐘 · 最多 76 次 AI 呼叫。');
  assert.equal(start.bookStartEstimateText(start.bookStartEstimate(0)), '0 張卡 · 約 2 分鐘 · 最多 1 次 AI 呼叫。');
  lang('en');
  assert.equal(start.bookStartEstimateText(start.bookStartEstimate(15)), '15 cards · about 7 minutes · up to 76 AI calls.');
  lang('zh-TW');
});

test('start card: Start without touching the fields writes nothing to the root topic and starts once, even when pressed twice; the map file is not touched', async () => {
  const h = await harness({ book: false });
  await h.plugin.repo.writeBookSettings(rootPath(h), { reader: 'kids', tone: 'warm' });
  const before = h.plugin.repo.app?.vault ? undefined : undefined;
  void before;
  const writes = [];
  const original = h.plugin.repo.writeBookSettings.bind(h.plugin.repo);
  h.plugin.repo.writeBookSettings = (path, patch) => { writes.push([path, patch]); return original(path, patch); };
  const modal = await openCard(h);
  const fields = dom.findAll(modal.modalEl, i => i.tag === 'textarea');
  assert.equal(fields.find(f => f.attrs['aria-label'] === '讀者').value, 'kids', 'prefilled with the current value');
  assert.equal(fields.find(f => f.attrs['aria-label'] === '語氣').value, 'warm');
  const go = cardButton(modal, '開始');
  go.click(); go.click();
  await dom.tick();
  assert.equal(writes.length, 0);
  assert.equal(JSON.stringify(h.entries), JSON.stringify([['start', MAP]]));
});

test('start card: only the fields the owner changed are written, to the root topic only; clearing a prefilled field removes it; other fields keep their bytes', async () => {
  const h = await harness({ book: false });
  await h.plugin.repo.writeBookSettings(rootPath(h), { reader: 'kids', tone: 'warm' });
  const modal = await openCard(h);
  const field = label => dom.findAll(modal.modalEl, i => i.tag === 'textarea').find(f => f.attrs['aria-label'] === label);
  field('讀者').value = '  kids   ';      // same after whitespace is squashed: not touched
  field('語氣').value = '';               // cleared: removed
  field('想看的角度').value = 'sleep science'; // new
  cardButton(modal, '開始').click();
  await dom.tick(); await dom.tick();
  const root = await h.plugin.repo.readNote(rootPath(h));
  assert.equal(JSON.stringify(root.bookSettings), JSON.stringify({ reader: 'kids', angle: 'sleep science' }));
  const other = await h.plugin.repo.readNote(h.view.map.nodes.find(n => n.id === h.ids.a).path);
  assert.equal(other.bookSettings, undefined, 'a non-root card is not written');
  assert.equal(JSON.stringify(h.entries), JSON.stringify([['start', MAP]]));
});

test('start card: a map that already has a run opens no card (the entry answers with its own sentence); a second press while the card is open opens no second one', async () => {
  const withRun = await harness({ book: true });
  await withRun.view.startBookPipelineFromUi();
  assert.equal(withRun.view.bookStartModal, null);
  assert.equal(JSON.stringify(withRun.entries), JSON.stringify([['start', MAP]]));
  const h = await harness({ book: false });
  const first = await openCard(h);
  await h.view.startBookPipelineFromUi();
  assert.equal(h.view.bookStartModal, first);
});

test('start card: closing clears the focus timer, the view closes an open card with itself, and the entry is the same for the command', async () => {
  const h = await harness({ book: false });
  const modal = await openCard(h);
  assert.notEqual(modal.focusTimer, null);
  modal.close();
  assert.equal(modal.focusTimer, null, 'the focus timer is cleared on close');
  assert.equal(modal.isOpen, false);
  assert.match(view_ts, /this\.closed = true; this\.bookStartModal\?\.close\(\); this\.bookStartModal = null;/);
  assert.match(main_ts, /view\.startBookPipelineFromUi\(\)/);
});

test('start card: Escape closes it without starting', async () => {
  const h = await harness({ book: false });
  const modal = await openCard(h);
  assert.equal(modal.scope.press('Escape'), false);
  assert.equal(modal.isOpen, false);
  assert.equal(h.entries.length, 0);
});

test('bar: the sentence names the chapter being written out of the total (never a title from a note), and the whole-book plan and chapter plans have their own words; unknown cards are ignored; nothing running means no line', () => {
  lang('zh-TW');
  const order = ['a', 'b', 'c', 'd', 'e'];
  const prog = progress({ total: 5, counts: { pending: 0, planned: 0, written: 2, checked: 1, 'needs-review': 0 },
    current: [{ nodeId: 'd', step: 'images', startedAt: 1 }, { nodeId: 'c', step: 'write', startedAt: 2 }] });
  const parent = dom.element('div');
  ui.renderBookBar(parent, ui.bookBarState(bookData({ order }), prog, noStage), calls().actions);
  const now = dom.find(parent, i => i.cls.includes('vam-book-now-text'));
  assert.equal(now.text, '正在寫第 3／5 章');
  const withCurrent = (current, over = {}) => ui.bookBarState(bookData({ phase: 'planning', globalPlanned: false, ...over }), progress({ phase: 'planning', current }), noStage);
  const s = withCurrent([{ nodeId: 'a', step: 'plan', startedAt: 1 }, { nodeId: 'global', step: 'plan', startedAt: 1 }]);
  assert.equal(s.current.step, 'global');
  assert.equal(ui.bookProgressText(s), '正在規劃全書，已完成 2／4 章');
  const chapters = withCurrent([{ nodeId: 'b', step: 'plan', startedAt: 1 }], { globalPlanned: true });
  assert.equal(ui.bookProgressText(chapters), '正在企劃第 2／4 章，已完成 2／4 章');
  assert.equal(withCurrent([{ nodeId: 'zzz', step: 'write', startedAt: 1 }]).current, undefined);
  assert.equal(ui.bookBarState(bookData(), progress({ active: false, current: [{ nodeId: 'a', step: 'write', startedAt: 1 }] }), noStage).current, undefined);
  const gate = dom.element('div');
  ui.renderBookBar(gate, ui.bookBarState(bookData({ phase: 'gate1' }), progress({ phase: 'gate1', active: false }), noStage), calls().actions);
  assert.equal(dom.find(gate, i => i.cls.includes('vam-book-now')), undefined);
  // Without a current card (a reload) the number comes from the settled cards, never past the total.
  lang('en');
  assert.equal(ui.bookProgressText(ui.bookBarState(bookData(), progress({ counts: { pending: 0, planned: 0, written: 0, checked: 4, 'needs-review': 0 } }), noStage)), 'Writing chapter 4/4, 4/4 chapters done');
  lang('zh-TW');
});

test('bar: the remaining time sits on the "now" line and only when the runner gave one (it gives none below five finished cards)', () => {
  lang('zh-TW');
  const cur = [{ nodeId: 'a', step: 'write', startedAt: 1 }];
  const draw2 = over => { const parent = dom.element('div'); ui.renderBookBar(parent, ui.bookBarState(bookData(), progress({ current: cur, ...over }), noStage), calls().actions); return parent; };
  assert.equal(dom.find(draw2({}), i => i.cls.includes('vam-book-bar-eta')), undefined);
  assert.equal(dom.find(draw2({ etaSeconds: 130 }), i => i.cls.includes('vam-book-bar-eta')).text, '約剩 2 分鐘');
  assert.equal(dom.find(draw2({}), i => i.cls.includes('vam-book-now')).children.length, 1);
});

test('bar: a saved v1 map is only read: the data is not changed, and after a reload the progress comes from the cards\' stages', () => {
  lang('zh-TW');
  const data = bookData({ phase: 'writing', status: 'running' });
  const frozen = JSON.stringify(data);
  const stages = { a: 'checked', b: 'written', c: 'planned', d: undefined };
  const state = ui.bookBarState(data, undefined, id => stages[id]);
  assert.equal(JSON.stringify(state.counts), JSON.stringify({ pending: 1, planned: 1, written: 1, checked: 1, 'needs-review': 0 }));
  assert.equal(state.current, undefined);
  assert.equal(JSON.stringify(data), frozen);
  assert.equal(Object.keys(data).includes('current') || Object.keys(data).includes('steps'), false);
});

test('card labels: the label says which step the card is in (planning, writing, finding pictures, proofreading) and keeps the clock', () => {
  lang('zh-TW');
  const words = { plan: '企劃中', write: '寫作中', images: '找圖中', proof: '校對中' };
  for (const [step, word] of Object.entries(words)) {
    const header = dom.element('div');
    let ticked = false;
    ui.renderBookCardLabels(header, ui.bookCardView({ pipelineStage: 'planned' }), { step, track: el => { ticked = true; el.setText('0:07'); } });
    const chip = header.children[0];
    assert.equal(chip.children[0].text, word);
    assert.match(chip.cls, new RegExp(`is-${step}`));
    assert.ok(ticked && chip.children[1].text === '0:07');
  }
  for (const language of ['en', 'zh-CN']) { lang(language); const header = dom.element('div'); ui.renderBookCardLabels(header, ui.bookCardView({}), { step: 'images', track() {} }); assert.ok(header.children[0].children[0].text.length > 0); }
  lang('zh-TW');
});

test('view: a card the runner is finding pictures for shows "找圖中" from the runner\'s sub-step; the author call of this view still reads "寫作中"', async () => {
  const h = await harness({ book: true, stages: { a: 'planned', b: 'written' } });
  const noteA = h.view.map.nodes.find(n => n.id === h.ids.a);
  const noteB = h.view.map.nodes.find(n => n.id === h.ids.b);
  h.plugin.getBookPipelineProgress = () => progress({ current: [{ nodeId: h.ids.a, step: 'images', startedAt: Date.now() - 12_000 }, { nodeId: h.ids.b, step: 'proof', startedAt: Date.now() - 5_000 }] });
  let stage = h.paint();
  const chips = dom.findAll(stage, i => i.cls.includes('is-writing')).map(c => c.children[0].text);
  assert.deepEqual(chips.sort(), ['找圖中', '校對中']);
  h.view.bookAuthoring.set(noteA.path, Date.now() - 3_000);
  stage = h.paint();
  assert.deepEqual(dom.findAll(stage, i => i.cls.includes('is-writing')).map(c => c.children[0].text).sort(), ['寫作中', '校對中']);
  void noteB;
  assert.match(view_ts, /refreshBookProgress\(\): void \{ if \(!this\.closed && this\.hasBookPipeline\(\)\) this\.render\(\);/);
  assert.match(main_ts, /progressed: mapPath =>[\s\S]*?refreshBookProgress\(\)/);
});

test('bar: 31 cards with 5 needing a look at gate 2 or done: the bar draws no running sentence and no stage list; the runner step counts keep their rule (S1)', () => {
  lang('zh-TW');
  const counts = { pending: 0, planned: 0, written: 0, checked: 26, 'needs-review': 5 };
  for (const phase of ['gate2', 'done']) {
    const order = Array.from({ length: 31 }, (_, i) => 'c' + i);
    const state = ui.bookBarState(bookData({ phase, order }), undefined, id => (Number(id.slice(1)) < 26 ? 'checked' : 'needs-review'));
    const parent = dom.element('div');
    ui.renderBookBar(parent, state, calls().actions);
    assert.equal(dom.findAll(parent, i => i.tag === 'li').length, 0, phase);
    assert.equal(dom.find(parent, i => i.cls.includes('vam-book-now')), undefined, phase);
  }
  assert.equal(JSON.stringify(runModule.stepCounts(counts, 0, { settled: true })), JSON.stringify({ plan: 31, write: 31, images: 31, proof: 31 }));
  assert.equal(JSON.stringify(runModule.stepCounts(counts, 0, { proofFailed: 2 })), JSON.stringify({ plan: 31, write: 28, images: 28, proof: 26 }));
  assert.equal(JSON.stringify(runModule.stepCounts(counts)), JSON.stringify({ plan: 31, write: 26, images: 26, proof: 26 }));
});

test('start card: a finished map opens the card again; a running, gate, stopped or unreadable map still answers with its own sentence (S2)', async () => {
  const done = await harness({ book: false });
  const map = done.view.map; map.bookPipeline = bookData({ phase: 'done', order: [done.ids.root, done.ids.a, done.ids.b] });
  const card = await openCard(done);
  assert.ok(card?.isOpen, 'a finished map confirms again');
  assert.equal(done.entries.length, 0);
  for (const phase of ['planning', 'gate1', 'writing', 'gate2']) {
    const h = await harness({ book: true });
    h.view.map.bookPipeline = bookData({ phase, order: [h.ids.root, h.ids.a, h.ids.b] });
    await h.view.startBookPipelineFromUi();
    assert.equal(h.view.bookStartModal, null, phase);
    assert.equal(h.entries.length, 1, phase);
  }
  const stopped = await harness({ book: true });
  stopped.view.map.bookPipeline = bookData({ status: 'stopped', order: [stopped.ids.root] });
  await stopped.view.startBookPipelineFromUi();
  assert.equal(stopped.view.bookStartModal, null);
  assert.equal(stopped.entries.length, 1);
  const unreadable = await harness({ book: true });
  unreadable.view.map.bookPipeline = { v: 99 };
  await unreadable.view.startBookPipelineFromUi();
  assert.equal(unreadable.view.bookStartModal, null);
  assert.equal(unreadable.entries.length, 1);
});

test('start card: several root topics are refused before the card opens (M2); a chat chain holding the map refuses before any setting is written (M3)', async () => {
  const many = await harness({ book: false });
  many.view.map.nodes.find(n => n.id === many.ids.a).parentId = null;
  await many.view.startBookPipelineFromUi();
  assert.equal(many.view.bookStartModal, null, 'no card for a map the entry would refuse');
  assert.equal(many.entries.length, 1, 'the entry answers with its refusal');
  const h = await harness({ book: false });
  const writes = [];
  h.plugin.repo.writeBookSettings = async (path, patch) => { writes.push([path, patch]); };
  const modal = await openCard(h);
  h.view.chatChainRunner = { current: {} };
  dom.findAll(modal.modalEl, i => i.tag === 'textarea').find(f => f.attrs['aria-label'] === '讀者').value = 'kids';
  cardButton(modal, '開始').click();
  await dom.tick(); await dom.tick();
  assert.equal(writes.length, 0, 'blocked: nothing written');
  assert.equal(h.entries.length, 0, 'blocked: nothing started');
  assert.ok(notices.length > 0, 'the owner is told');
});

// ---- T5: the rerun line of the bar, the card chip, the finish question ----
test('T3 bar: a single-card rerun draws no rerun line (no title, no clock, no three steps): no stage list either, just the stop button (the one-line rerun hint went with the panel, owner OK 7-5)', () => {
  lang('zh-TW');
  const order = ['a', 'b', 'c'];
  const prog = progress({ phase: 'gate2', total: 3, current: [{ nodeId: 'b', step: 'write', startedAt: 5 }], rerun: { nodeId: 'b', startedAt: 777 } });
  const parent = dom.element('div');
  const c = calls();
  const state = ui.bookBarState(bookData({ order, phase: 'gate2' }), prog, noStage);
  assert.equal(state.rerun, true);
  ui.renderBookBar(parent, state, c.actions);
  assert.equal(dom.find(parent, i => i.classes.includes('vam-book-rerun')), undefined, 'no rerun row');
  assert.ok(!texts(parent).some(x => /正在重跑|重跑中|\d:\d\d/.test(x)), JSON.stringify(texts(parent)));
  assert.equal(dom.findAll(parent, i => i.tag === 'li').length, 0, 'no stage list');
  assert.ok(!texts(parent).includes('某一章不滿意？可以只重跑那一章，不用整本重來。'), 'the rerun hint is gone');
  assert.deepEqual(buttonsOf(parent).map(b => b.text), ['停止']);
  buttonsOf(parent)[0].click();
  assert.deepEqual(c.log, ['stop']);
});

test('T3 card chip: a card being rerun says 處理中 with no clock and keeps the step in the tooltip; a plain working card still has its clock', () => {
  lang('zh-TW');
  const header = dom.element('div');
  let ticked = 0;
  ui.renderBookCardLabels(header, ui.bookCardView({ pipelineStage: 'needs-review' }), { step: 'proof', rerun: true, track: el => { ticked++; el.setText('0:41'); } });
  const chip = header.children[0];
  assert.match(chip.cls, /is-rerun/);
  assert.equal(chip.children.length, 1);
  assert.equal(chip.children[0].text, '處理中');
  assert.equal(chip.attrs.title, '校對中');
  assert.equal(ticked, 0, 'no clock is started for a rerun');
});

test('T5 view wiring: "global" is never a card; the menu note is not a disabled grey line', () => {
  assert.doesNotMatch(view_ts, /trackRerunClock|book_rerun_elapsed/);
  assert.match(view_ts, /item\.nodeId === nodeId && item\.nodeId !== "global"/);
  assert.ok(!/item\.setTitle\(t\("ui\.book_card_menu_rerun_sub"\)\)\.setDisabled\(true\)/.test(view_ts));
  assert.doesNotMatch(css, /vam-book-rerun-clock/);
  assert.match(css, /\.vam-book-menu-note \{[^}]*pointer-events: none/);
});

test('fix1: the start card works on a Modal whose isOpen is a writable base property (no subclass getter shadows it)', () => {
  const { loadSource: load } = require('./support-replay.cjs');
  const b = load(`
export { BookStartModal } from "./experiences/visual-map/book-pipeline-start-modal";
`, { obsidian: { ...support.obsidian, Modal: dom.makeModal() } }, { createFragment: dom.createFragment, Option: OptionStub, window: { setTimeout, clearTimeout } });
  const settings = { reader: '', goal: '', angle: '', tone: '', length: '', style: '' };
  const start = new b.BookStartModal({}, { cards: 3, models: { plan: 'a', write: 'b', images: 'c', proof: 'd' }, modelChoice: { options: () => ['a'], label: x => x, onChange() {} }, settings, onStart() {} });
  start.open();
  assert.equal(start.isShown, true);
  assert.equal(start.isOpen, true, 'the base class owns isOpen');
  start.close();
  assert.equal(start.isShown, false);
  assert.equal(start.isOpen, false);
  // Every member the start card adds (prototype and instance) is checked against the real Obsidian Modal declaration: a same-name member would shadow or be written by the base class.
  const dts = fs.readFileSync(path.join(root, 'node_modules/obsidian/obsidian.d.ts'), 'utf8');
  const modalDecl = dts.slice(dts.indexOf('export class Modal '), dts.indexOf('export class Modal ') + 4000).split(/\n}\n/)[0];
  const baseMembers = new Set([...modalDecl.matchAll(/^\s{4}(?:static\s+)?(?:readonly\s+)?(\w+)\s*[(:?]/gm)].map(m => m[1]));
  for (const must of ['open', 'close', 'onOpen', 'onClose', 'titleEl', 'contentEl', 'modalEl', 'scope', 'app']) assert.ok(baseMembers.has(must), `parsed d.ts has Modal.${must}`);
  const own = [...Object.getOwnPropertyNames(b.BookStartModal.prototype), ...Object.keys(start).filter(k => !(k in new (dom.makeModal())({})))].filter(k => !['constructor', 'onOpen', 'onClose'].includes(k));
  assert.deepEqual(own.filter(k => baseMembers.has(k)), [], 'no start-card member shares a name with an Obsidian Modal member');
  for (const name of ['BookStartModal']) {
    for (const key of ['isOpen', 'app', 'scope', 'contentEl', 'titleEl', 'modalEl']) {
      assert.equal(Object.getOwnPropertyDescriptor(b[name].prototype, key), undefined, `${name} must not define ${key} on its prototype`);
    }
  }
});

test('T5 bar: while a run with a trial is planning, the sentence says which trial chapter is tried; the whole-book plan and a run without a trial keep their words', () => {
  lang('zh-TW');
  const trialState = (current, over = {}) => ui.bookBarState(bookData({ phase: 'planning', trial: ['a', 'b', 'c'], ...over }), progress({ phase: 'planning', current }), noStage);
  assert.equal(ui.bookProgressText(trialState([{ nodeId: 'b', step: 'write', startedAt: 1 }])), '正在試跑第 2／3 章');
  assert.equal(ui.bookProgressText(trialState([{ nodeId: 'global', step: 'plan', startedAt: 1 }])), '正在規劃全書，已完成 2／4 章', 'the whole-book plan comes first');
  assert.equal(ui.bookProgressText(trialState(undefined)), '正在試跑第 3／3 章', 'no current card: the next unsettled trial chapter, never past the trial size');
  assert.equal(ui.bookProgressText(trialState([{ nodeId: 'b', step: 'plan', startedAt: 1 }], { trial: undefined })), '正在企劃第 2／4 章，已完成 2／4 章', 'an older run');
  lang('en');
  assert.equal(ui.bookProgressText(trialState([{ nodeId: 'a', step: 'plan', startedAt: 1 }])), 'Trying chapter 1/3 first');
  lang('zh-CN');
  assert.equal(ui.bookProgressText(trialState([{ nodeId: 'a', step: 'plan', startedAt: 1 }])), '正在试跑第 1／3 章');
  lang('zh-TW');
});

test('stop and restart: stop shows at gate 1 and gate 2 (not at done); a stopped run in any phase before done shows continue, restart and give up; a budget pause and a running run show no restart', () => {
  lang('zh-TW');
  for (const phase of ['gate1', 'gate2']) {
    const d = draw(bookData({ phase }), progress({ phase, active: false }), noStage, true);
    assert.ok(buttonsOf(d.bar).some(b => b.text === '停止'), `stop at ${phase}`);
    buttonsOf(d.bar).find(b => b.text === '停止').click();
    assert.deepEqual(d.log, ['stop']);
  }
  const done = draw(bookData({ phase: 'done' }), progress({ phase: 'done', active: false }), noStage, true);
  assert.ok(!buttonsOf(done.bar).some(b => b.text === '停止'), 'no stop when done');
  const rerunning = draw(bookData({ phase: 'gate2' }), progress({ phase: 'gate2', rerun: { nodeId: 'a', startedAt: 1 } }), noStage, true);
  assert.equal(buttonsOf(rerunning.bar).filter(b => b.text === '停止').length, 1, 'a rerun at a gate has one stop button');
  for (const phase of ['planning', 'writing', 'gate1', 'gate2']) {
    const d = draw(bookData({ status: 'stopped', phase }), progress({ status: 'stopped', active: false, phase }), noStage, true);
    assert.deepEqual(buttonsOf(d.bar).map(b => b.text), ['從停處繼續', '重新設定再開始'], phase + ' (no abandon without the action)');
    buttonsOf(d.bar)[1].click();
    assert.deepEqual(d.log, ['restart']);
  }
  const running = draw(bookData(), progress(), noStage, true);
  assert.ok(!buttonsOf(running.bar).some(b => b.text === '重新設定再開始'));
  const budget = draw(bookData({ status: 'stopped', pauseReason: 'budget' }), progress({ status: 'stopped', active: false, pauseReason: 'budget' }), noStage, true);
  assert.ok(!buttonsOf(budget.bar).some(b => b.text === '重新設定再開始'));
  const gate1Stopped = draw(bookData({ status: 'stopped', phase: 'gate1' }), progress({ status: 'stopped', active: false, phase: 'gate1' }), noStage, true);
  assert.ok(!buttonsOf(gate1Stopped.bar).some(b => b.text === '這樣可以，跑完全書'), 'a stopped gate 1 shows no confirm beside the three choices');
});

test('abandon: stopped, budget pause and done show the entry (放棄這本 / 移除圖文書); running and the waiting gates do not; the confirmation card has the notes-kept sentence, Cancel and confirm', () => {
  lang('zh-TW');
  const abandon = (asking = false) => { const log = []; return { log, abandon: { asking, ask: () => log.push('ask'), cancel: () => log.push('cancel'), confirm: () => log.push('confirm') } }; };
  const drawWith = (data, prog, a) => { const c = calls(); c.actions.abandon = a.abandon; c.actions.restart = () => undefined; const parent = dom.element('div'); return renderedBar(parent, data, prog, c); };
  const renderedBar = (parent, data, prog, c) => ui.renderBookBar(parent, ui.bookBarState(data, prog, noStage), c.actions);
  const labelOf = (data, prog) => { const a = abandon(); const bar = drawWith(data, prog, a); return [buttonsOf(bar).map(b => b.text), a, bar]; };
  let [texts1, a1, bar1] = labelOf(bookData({ status: 'stopped', phase: 'gate1' }), progress({ status: 'stopped', active: false, phase: 'gate1' }));
  assert.deepEqual(texts1, ['從停處繼續', '重新設定再開始', '放棄這本']);
  buttonsOf(bar1).find(b => b.text === '放棄這本').click();
  assert.deepEqual(a1.log, ['ask']);
  assert.ok(texts1.includes('放棄這本'));
  const budgetTexts = labelOf(bookData({ status: 'stopped', pauseReason: 'budget' }), progress({ status: 'stopped', active: false, pauseReason: 'budget' }))[0];
  assert.ok(budgetTexts.includes('放棄這本'));
  assert.deepEqual(labelOf(bookData({ phase: 'done' }), progress({ phase: 'done', active: false }))[0].filter(x => x.includes('移除') || x.includes('放棄')), ['移除圖文書']);
  for (const phase of ['writing', 'gate1', 'gate2']) assert.ok(!labelOf(bookData({ phase }), progress({ phase, active: phase === 'writing' }))[0].some(x => x === '放棄這本' || x === '移除圖文書'), phase);
  for (const data of [bookData({ status: 'stopped', phase: 'writing' }), bookData({ phase: 'done' })]) {
    const a = abandon(true);
    const bar = drawWith(data, progress({ phase: data.phase, status: data.status, active: false }), a);
    const card = dom.find(bar, i => i.cls.includes('vam-book-abandon-card'));
    assert.ok(card, 'the card is drawn in the bar (no window.confirm)');
    assert.ok(texts(card).some(x => x.includes('已寫好的章節筆記會原封不動保留')));
    assert.ok(!/地圖/.test(texts(card).join('')));
    dom.find(card, i => i.cls.includes('vam-book-abandon-cancel')).click();
    dom.find(card, i => i.cls.includes('vam-book-abandon-confirm')).click();
    assert.deepEqual(a.log, ['cancel', 'confirm']);
  }
});

test('abandon (view): asking shows the card; Cancel clears it without an entry; confirm calls the plugin entry once with this map; running stays without the entry', async () => {
  const h = await harness({ book: true, phase: 'writing' });
  h.view.map.bookPipeline.status = 'stopped';
  h.plugin.getBookPipelineProgress = () => progress({ status: 'stopped', active: false });
  const draw1 = () => { const t = dom.element('div'); h.view.renderBookPipelineBar(t); return t.children[0]; };
  buttonsOf(draw1()).find(b => b.text === '放棄這本').click();
  assert.equal(h.view.rendered, 1);
  assert.ok(dom.find(draw1(), i => i.cls.includes('vam-book-abandon-card')));
  dom.find(draw1(), i => i.cls.includes('vam-book-abandon-cancel')).click();
  assert.equal(dom.find(draw1(), i => i.cls.includes('vam-book-abandon-card')), undefined);
  assert.equal(h.entries.length, 0);
  buttonsOf(draw1()).find(b => b.text === '放棄這本').click();
  dom.find(draw1(), i => i.cls.includes('vam-book-abandon-confirm')).click();
  await dom.tick();
  assert.equal(JSON.stringify(h.entries), JSON.stringify([['abandon', MAP]]));
  assert.equal(dom.find(draw1(), i => i.cls.includes('vam-book-abandon-card')), undefined, 'the card closes once confirmed');
  delete h.view.map.bookPipeline;
  assert.equal((await openCard(h))?.isOpen, true, 'after the book is given up, 圖文書 opens the start card as for a fresh map');
});

test('restart (view): a run stopped at a gate opens the card and Start forwards the restart flag; a running gate and a plain gate refuse', async () => {
  for (const phase of ['gate1', 'gate2']) {
    const g = await harness({ book: true });
    g.view.map.bookPipeline = bookData({ status: 'stopped', phase, order: [g.ids.root, g.ids.a, g.ids.b] });
    await g.view.startBookPipelineFromUi({ restart: true });
    assert.ok(g.view.bookStartModal?.isOpen, phase);
    cardButton(g.view.bookStartModal, '開始').click(); await dom.tick();
    assert.equal(JSON.stringify(g.entries), JSON.stringify([['start', MAP, { restart: true }]]), phase);
    const running = await harness({ book: true });
    running.view.map.bookPipeline = bookData({ status: 'running', phase, order: [running.ids.root, running.ids.a, running.ids.b] });
    await running.view.startBookPipelineFromUi({ restart: true });
    assert.equal(running.view.bookStartModal, null, 'a waiting gate is not restarted');
  }
});

test('restart: the card opens with the current settings; Start replaces the stopped run (restart flag, settings written first); Cancel leaves everything; gate and running runs refuse a restart', async () => {
  const h = await harness({ book: false });
  await h.plugin.repo.writeBookSettings(rootPath(h), { reader: 'kids', tone: 'warm' });
  h.view.map.bookPipeline = bookData({ status: 'stopped', phase: 'planning', order: [h.ids.root, h.ids.a, h.ids.b] });
  await h.view.startBookPipelineFromUi({ restart: true });
  let modal = h.view.bookStartModal;
  assert.ok(modal?.isOpen, 'the card opens for a stopped run');
  assert.equal(field(modal, dom.findAll(modal.modalEl, i => i.tag === 'textarea')[0].attrs['aria-label']).value.length > 0, true, 'prefilled');
  assert.ok(dom.findAll(modal.modalEl, i => i.tag === 'textarea').some(f => f.value === 'warm'), 'the saved tone is shown');
  assert.equal(h.entries.length, 0);
  cardButton(modal, '取消').click(); await dom.tick();
  assert.equal(h.entries.length, 0, 'Cancel starts nothing');
  assert.equal(h.view.map.bookPipeline.status, 'stopped', 'the stopped run is untouched');
  h.view.bookStartModal = null;
  await h.view.startBookPipelineFromUi({ restart: true });
  modal = h.view.bookStartModal;
  dom.findAll(modal.modalEl, i => i.tag === 'textarea').find(f => f.value === 'warm').value = 'cold';
  cardButton(modal, '開始').click(); await dom.tick();
  assert.equal(JSON.stringify(h.entries), JSON.stringify([['start', MAP, { restart: true }]]));
  for (const phase of ['done']) {
    const g = await harness({ book: true });
    g.view.map.bookPipeline = bookData({ status: 'running', phase, order: [g.ids.root, g.ids.a, g.ids.b] });
    await g.view.startBookPipelineFromUi({ restart: true });
    if (phase === 'done') { assert.ok(g.view.bookStartModal?.isOpen, 'done opens its normal card'); assert.equal(g.entries.length, 0); }
    else { assert.equal(g.view.bookStartModal, null, phase); assert.equal(g.entries.length, 1, phase); assert.equal(g.entries[0].length, 2, 'no restart flag is forwarded for ' + phase); }
  }
  const running = await harness({ book: true });
  running.view.map.bookPipeline = bookData({ phase: 'planning', order: [running.ids.root, running.ids.a, running.ids.b] });
  await running.view.startBookPipelineFromUi({ restart: true });
  assert.equal(running.view.bookStartModal, null);
});
