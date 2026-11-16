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
// One bundle, so the view, the screen parts and the language setting share one copy of the interface language.
const bundle = loadSource(`
export * from "./experiences/visual-map/book-pipeline-ui";
export { BookPipelineRunError } from "./experiences/visual-map/book-pipeline-run";
export { readBookPipeline } from "./core/book-pipeline/model";
export { VisualAgentMapView } from "./experiences/visual-map/view";
export { setUiLanguage, t } from "./i18n";
`, { obsidian: { ...support.obsidian, Modal: dom.makeModal(), Notice: dom.makeNotice(notices), Component: class {}, MarkdownRenderChild: class {} } }, { createFragment: dom.createFragment, requestAnimationFrame: () => 1, cancelAnimationFrame() {}, window: { setTimeout, clearTimeout, setInterval, clearInterval } });
const { setUiLanguage, t: tr } = bundle;
const ui = bundle, runModule = bundle, model = bundle;
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
const draw = (data, prog, stageOf = noStage) => {
  const parent = dom.element('div');
  const c = calls();
  const state = ui.bookBarState(data, prog, stageOf);
  const bar = ui.renderBookBar(parent, state, c.actions);
  return { parent, bar, state, ...c };
};
const buttonsOf = bar => dom.findAll(bar, i => i.tag === 'button');
const track = bar => dom.find(bar, i => i.attrs.role === 'progressbar');

test('bar: running writing phase shows the phase, the four counts, a stop button and a progressbar with aria values and a text alternative', () => {
  lang('zh-TW');
  const d = draw(bookData(), progress());
  assert.equal(d.bar.attrs.role, 'group');
  assert.ok(texts(d.bar).includes('圖文書：作者＋校對中'));
  assert.ok(texts(d.bar).includes('已校 1／4 · 已寫 1 · 已企劃 1 · 需人看 1'));
  const t = track(d.bar);
  assert.deepEqual([t.attrs['aria-valuemin'], t.attrs['aria-valuemax'], t.attrs['aria-valuenow']], ['0', '4', '1']);
  assert.equal(t.attrs['aria-valuetext'], '已校 1、已寫 1、已企劃 1、需人看 1');
  assert.deepEqual(buttonsOf(d.bar).map(b => b.text), ['停止']);
  assert.equal(dom.findAll(t, i => i.cls.includes('vam-book-seg')).length, 4);
  buttonsOf(d.bar)[0].click();
  assert.deepEqual(d.log, ['stop']);
  assert.equal(dom.findAll(d.bar, i => /分鐘/.test(i.text ?? '')).length, 0, 'no remaining-time number in stage 1');
});

test('bar: every phase and status has its own words (zh-TW, en, zh-CN)', () => {
  const words = {
    'zh-TW': { planning: '圖文書：企劃中', gate1: '圖文書：等你確認', writing: '圖文書：作者＋校對中', gate2: '圖文書：完成待驗收', stopped: '圖文書：已停止', budget: '圖文書：額度用完' },
    en: { planning: 'Picture book: Planning', gate1: 'Picture book: Waiting for your confirmation', writing: 'Picture book: Writing and proofreading', gate2: 'Picture book: Done, waiting for review', stopped: 'Picture book: Stopped', budget: 'Picture book: Call budget used up' },
    'zh-CN': { planning: '图文书：企划中', gate1: '图文书：等你确认', writing: '图文书：作者＋校对中', gate2: '图文书：完成待验收', stopped: '图文书：已停止', budget: '图文书：额度用完' }
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
  assert.ok(texts(d.bar).includes('停在「作者＋校對中」階段，已校 1／4'));
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
  assert.ok(buttonsOf(gate.bar).some(b => b.text === '確認，開始寫作'));
  assert.ok(texts(gate.bar).includes('圖文書：等你確認'));
  buttonsOf(gate.bar).find(b => b.text === '確認，開始寫作').click();
  assert.deepEqual(gate.log, ['confirm']);
  for (const phase of ['planning', 'writing', 'gate2'])
    assert.ok(!buttonsOf(draw(bookData({ phase }), progress({ phase })).bar).some(b => b.text === '確認，開始寫作'), phase);
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
  assert.equal(ui.bookIssueText('proof failed: no_open_page'), '校對失敗：校對時沒有成功開啟任何來源頁');
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
async function harness({ book, stages = {}, issue }) {
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
  if (book) mapDoc.bookPipeline = bookData({ order: [ids.root, ids.a, ids.b] });
  await app.vault.create(MAP, support.core.serializeMap(mapDoc));
  await repo.rebuildDerivedData();
  notices.length = 0;
  setUiLanguage('zh-TW');
  const { VisualAgentMapView } = bundle;
  const entries = [];
  const plugin = support.withExpansionCoordinator({
    repo, settings, running: new Set(), logs: { appendLog() {} }, rebuildDerivedData: () => repo.rebuildDerivedData(), relevanceGrades: new Map(), expansionBatches: new Map(), pendingSuggestions: new Map(), releaseOutline() {}, setOutlineActive() {}, detailsShown: () => false,
    mutate: work => Promise.resolve().then(work),
    getBookPipelineProgress: () => undefined,
    startBookPipeline: async p => { entries.push(['start', p]); },
    stopBookPipeline: async p => { entries.push(['stop', p]); },
    resumeBookPipeline: async (p, o) => { entries.push(['resume', p, o]); },
    confirmBookGate1: async p => { entries.push(['confirm', p]); }
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
  return { view, ids, paint, entries, notices, plugin };
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

test('view: the bar draws for a book map from getBookPipelineProgress and its buttons call the plugin entries with this map', async () => {
  const h = await harness({ book: true });
  h.plugin.getBookPipelineProgress = p => (p === MAP ? progress({ phase: 'gate1', active: false }) : undefined);
  const toolbar = dom.element('div');
  h.view.renderBookPipelineBar(toolbar);
  const bar = toolbar.children[0];
  assert.equal(bar.cls, 'vam-book-bar');
  const confirm = buttonsOf(bar).find(b => b.text === '確認，開始寫作');
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
  await h.view.startBookPipelineFromUi();
  assert.equal(JSON.stringify(h.entries), JSON.stringify([['start', MAP]]));
  for (const code of ['busy', 'blocked', 'root', 'exists', 'unusable']) {
    h.plugin.startBookPipeline = async () => { throw new runModule.BookPipelineRunError(code); };
    await h.view.startBookPipelineFromUi();
  }
  assert.equal(h.notices.length, 5);
  assert.match(h.notices[2], /根議題/);
  h.plugin.startBookPipeline = async () => { throw new TypeError('network down'); };
  await h.view.startBookPipelineFromUi();
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
