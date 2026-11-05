// Goal-banner P5: the "suggest new topics for the goal" list on the real view and repository.
// The AI is a fake behind the real GoalTopicSuggestService and RelevanceGradeService (strict parsers included); the DOM is tests/support-dom.cjs.
// No provider is called. Picked up by `npm run test:unit` through the tests/steps-*.cjs glob.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, root, load, DEFAULT_SETTINGS, fixture, withExpansionCoordinator, until, deferred, obsidian } = require('./support.cjs');
const dom = require('./support-dom.cjs');
const { hasCls, element, find, findAll, tick } = dom;

const MAP = 'Agent Workspace/Topics/map-a/Map.md';
const TITLES = { Body: 'core', Mind: 'support', REM: 'side', Dreams: 'support' };
const labelOf = (request, id) => `c${request.nodes.findIndex(n => n.id === id) + 1}`;
const gradeAll = request => ({ items: request.nodes.filter(n => n.parentId !== null).map(n => ({ id: labelOf(request, n.id), tier: TITLES[n.title] ?? 'support' })) });
const recalibrateNew = request => ({ changes: request.nodes.filter(n => n.parentId !== null && !request.previous.some(p => p.id === n.id)).map(n => ({ id: labelOf(request, n.id), tier: 'support', anchor: null })) });
// The model sees the map parent-first: c1 Sleep (root), c2 Body, c3 REM (under Body), c4 Mind, c5 Dreams
const TWO = [{ parentId: 'c2', title: 'Sleep stages' }, { parentId: 'c4', title: 'Stress habits' }];

async function harness({ language = 'en' } = {}) {
  const { repo, app, contents } = fixture(language);
  const settings = { ...DEFAULT_SETTINGS, language, cliModel: 'gpt-6-luna' };
  repo.settings = settings;
  const mapDoc = { id: 'map-a', title: 'Sleep map', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  await repo.ensureTopicFolders('Agent Workspace/Topics/map-a');
  const ids = {};
  const add = async (key, title, parent) => {
    const created = await repo.createNote(title, 'gpt-6-luna', mapDoc, MAP, parent ? 'inherited' : 'workspace');
    Object.assign(created, { parentId: parent ? ids[parent] : null, x: parent ? 400 : 80, y: 80 + mapDoc.nodes.length * 200 });
    mapDoc.nodes.push(created); ids[key] = created.id;
  };
  await add('root', 'Sleep'); await add('a', 'Body', 'root'); await add('b', 'Mind', 'root'); await add('c', 'REM', 'a'); await add('d', 'Dreams', 'b');
  await app.vault.create(MAP, require('./support.cjs').core.serializeMap(mapDoc));
  await repo.rebuildDerivedData();
  await repo.writeRelevanceGoal(MAP, 'Sleep better');
  const notices = [], ctx = {}, listeners = { pointerdown: [] };
  const control = {
    decline: false, usageAsks: 0, suggestCalls: [], gradeCalls: [], gradeGate: null,
    suggest: async () => JSON.stringify({ suggestions: TWO }),
    grade: async (request, _signal, prepared) => prepared.step.id.startsWith('relevance-recalibrate') ? recalibrateNew(request) : gradeAll(request)
  };
  const plugin = withExpansionCoordinator({
    repo, settings, running: new Set(), abortChartJobs: () => {}, addChartsAfterWrite: () => {}, logs: { appendLog() {} }, rebuildDerivedData: () => repo.rebuildDerivedData(), relevanceGrades: new Map(), releaseOutline() {},
    mutate: async work => {
      await work();
      const view = ctx.view; if (!view) return;
      const before = JSON.stringify(Array.from(view.notes));
      await view.hydrate();
      if (before !== JSON.stringify(Array.from(view.notes))) view.render();
    },
    runMutation(work) { this.mutate(work).catch(() => {}); },
    usageNoticePending: () => false, prewarmClaudeStep: () => {}, releaseWarmClaude: () => {},
    confirmAiUsage: async (_model, run) => { control.usageAsks++; if (control.decline) return false; await run(); return true; }
  });
  const { VisualAgentMapView } = load('main.ts', { obsidian: { ...obsidian, Modal: dom.makeModal(), Notice: class { constructor(m) { notices.push(m); } }, setTooltip() {} } }, { setInterval: () => 1, clearInterval: () => {}, createSvg: tag => ({ tag, attrs: {}, children: [], setAttribute(n, v) { this.attrs[n] = v; }, appendChild(c) { this.children.push(c); } }) });
  plugin.relevanceGrade = new (load('core/relevance-grade-service.ts').RelevanceGradeService)(async (request, signal, prepared) => {
    control.gradeCalls.push({ request, step: prepared.step.id });
    if (control.gradeGate) await control.gradeGate.promise;
    const out = await control.grade(request, signal, prepared);
    return typeof out === 'string' ? out : JSON.stringify(out);
  });
  plugin.goalTopicSuggest = new (load('core/goal-topic-suggest-service.ts', { obsidian }).GoalTopicSuggestService)(async (request, signal) => {
    control.suggestCalls.push({ request, signal });
    return control.suggest(request, signal);
  });
  const view = new VisualAgentMapView({ app }, plugin);
  ctx.view = view;
  const rootEl = element('div');
  rootEl.ownerDocument = { addEventListener: (name, fn) => listeners[name]?.push(fn), removeEventListener: (name, fn) => { listeners[name] = listeners[name]?.filter(f => f !== fn); } };
  rootEl.querySelector = selector => selector.includes('data-goal-action="suggest"') ? find(rootEl, i => i.attrs['data-goal-action'] === 'suggest') ?? null : find(rootEl, i => hasCls(i, selector.replace(/^\./, ''))) ?? null;
  const reload = async () => {
    view.notes = new Map(await Promise.all(view.map.nodes.map(async n => [n.id, await repo.readNote(n.path)])));
    ({ goal: view.relevanceGoal, context: view.relevanceContext } = await repo.readRelevanceSetup(MAP));
  };
  view.path = MAP; view.map = await repo.readMap(MAP); view.contentEl = rootEl; view.focusNode = () => {}; view.hydrate = reload;
  view.render = () => { view.paintCount++; rootEl.empty(); view.renderRelevanceStatus(rootEl); view.renderGoalBar(rootEl); };
  await reload(); view.render();
  const h = {
    repo, view, plugin, ids, control, notices, rootEl, listeners,
    spark: () => find(rootEl, i => i.tag === 'button' && i.attrs['data-goal-action'] === 'suggest'),
    icons: () => findAll(rootEl, i => i.tag === 'button' && hasCls(i, 'vam-goal-icon')),
    panel: () => find(rootEl, i => hasCls(i, 'vam-goal-suggest')),
    rows: () => findAll(rootEl, i => hasCls(i, 'vam-goal-suggest-row')),
    boxes: () => findAll(rootEl, i => i.tag === 'input'),
    titles: () => findAll(rootEl, i => hasCls(i, 'vam-goal-suggest-title')).map(i => i.text),
    whys: () => findAll(rootEl, i => hasCls(i, 'vam-goal-suggest-why')).map(i => i.text),
    addBtn: () => find(rootEl, i => hasCls(i, 'vam-goal-suggest-add')),
    skipBtn: () => find(rootEl, i => hasCls(i, 'vam-goal-suggest-skip')),
    stopBtn: () => find(rootEl, i => hasCls(i, 'vam-goal-suggest-stop')),
    titlesOnDisk: async () => (await Promise.all((await repo.readMap(MAP)).nodes.map(async n => (await repo.readNote(n.path)).title))).sort(),
    // Press the spark and wait for the list.
    open: async () => { h.spark().click(); await until(() => h.panel() && !h.stopBtn()); },
    run: () => plugin.relevanceGrades.get(MAP),
    settled: () => until(() => h.run() && h.run().status !== 'running')
  };
  return h;
}
const BASE = ['Body', 'Dreams', 'Mind', 'REM', 'Sleep'];

test('goal suggest: the spark asks for the usage confirmation, shows "Suggesting…" with Stop and four disabled icons, then the list', async () => {
  const h = await harness();
  assert.equal(h.spark().disabled, false);
  const gate = deferred(); h.control.suggest = async () => { await gate.promise; return JSON.stringify({ suggestions: TWO }); };
  h.spark().click();
  assert.equal(h.control.usageAsks, 1);
  await until(() => h.stopBtn());
  assert.equal(find(h.panel(), i => i.attrs.role === 'status').text, 'Suggesting…');
  assert.equal(h.stopBtn().text, 'Stop'); assert.equal(h.stopBtn().focused, true, 'the keyboard stays in the panel');
  assert.ok(h.icons().length === 4 && h.icons().every(b => b.disabled), 'the four goal icons are disabled while asking');
  gate.resolve(); await until(() => !h.stopBtn() && h.rows().length);
  assert.deepEqual(h.titles(), ['Sleep stages', 'Stress habits']);
  assert.deepEqual(h.whys(), ['Goes under “Body”', 'Goes under “Mind”']);
  assert.equal(h.panel().attrs.role, 'group'); assert.equal(h.panel().attrs['aria-label'], 'Suggested new topics');
  assert.ok(h.boxes().every(b => b.attrs.type === 'checkbox' || b.type === 'checkbox'));
  assert.ok(h.boxes().every(b => b.checked), 'default: every suggestion is checked');
  assert.equal(h.addBtn().text, 'Add 2'); assert.equal(h.skipBtn().text, 'Skip');
  assert.equal(h.boxes()[0].focused, true, 'focus moves into the list');
  assert.ok(h.icons().filter(b => b.attrs['data-goal-action'] !== 'suggest').every(b => !b.disabled === (b.attrs['aria-label'] !== 'Recalibrate' || true)));
  assert.deepEqual(await h.titlesOnDisk(), BASE, 'nothing is written by suggesting');
  assert.equal(h.control.suggestCalls[0].request.goal, 'Sleep better');
});

test('goal suggest: the count follows the checked rows and Add is disabled at 0', async () => {
  const h = await harness();
  await h.open();
  h.boxes()[0].checked = false; h.boxes()[0].fire('change');
  assert.equal(h.addBtn().text, 'Add 1'); assert.equal(h.addBtn().disabled, false);
  h.boxes()[1].checked = false; h.boxes()[1].fire('change');
  assert.equal(h.addBtn().text, 'Add 0'); assert.equal(h.addBtn().disabled, true);
  h.addBtn().fire('click'); await tick();
  assert.deepEqual(await h.titlesOnDisk(), BASE, 'a forced click at N=0 still writes nothing');
  assert.equal(h.control.usageAsks, 1);
});

test('goal suggest: model text goes into the DOM as text only (an <img onerror> title stays literal)', async () => {
  const h = await harness();
  const evil = '<img src=x onerror=alert(1)>';
  h.control.suggest = async () => JSON.stringify({ suggestions: [{ parentId: 'c2', title: evil }] });
  await h.open();
  assert.deepEqual(h.titles(), [evil]);
  assert.equal(findAll(h.rootEl, i => i.tag === 'img').length, 0);
  const source = fs.readFileSync(path.join(root, 'experiences/visual-map/view.ts'), 'utf8');
  const section = source.slice(source.indexOf('Suggest new topics for the goal'), source.indexOf('Starts the Claude CLI for the grade'));
  assert.ok(section.length > 3000, 'the scanned section is the goal-suggest code');
  assert.doesNotMatch(section, /innerHTML|outerHTML|insertAdjacentHTML|createEl\(\s*"template"/);
});

test('goal suggest: Add writes only the checked cards under their parents as ONE undo step, then grades by the goal (full when nothing is graded)', async () => {
  const h = await harness();
  await h.open();
  h.boxes()[1].checked = false; h.boxes()[1].fire('change');
  const past = h.view.history.past.length;
  const gate = deferred(); h.control.gradeGate = gate;
  h.addBtn().click();
  await until(() => h.control.gradeCalls.length);
  const saved = await h.repo.readMap(MAP);
  const created = saved.nodes.filter(n => !Object.values(h.ids).includes(n.id));
  assert.equal(created.length, 1);
  assert.equal(created[0].parentId, h.ids.a, 'under Body');
  assert.equal((await h.repo.readNote(created[0].path)).title, 'Sleep stages');
  assert.equal(h.view.history.past.length, past + 1, 'the add is one undo step');
  assert.equal(h.panel(), undefined, 'the list closes');
  assert.equal(h.control.gradeCalls[0].step, 'relevance-grade', 'no AI grade yet: a full grade');
  assert.ok(h.control.gradeCalls[0].request.nodes.some(n => n.title === 'Sleep stages'), 'the new card is in the graded map');
  assert.equal(h.control.usageAsks, 2, 'the grade asks for the usage confirmation itself');
  gate.resolve(); await h.settled();
  assert.equal((await h.repo.readNote(created[0].path)).relevance?.tier, 'support', 'the new card got a tier');
});

test('goal suggest: with an AI grade already there the follow-up grade is a recalibrate', async () => {
  const h = await harness();
  h.view.relevanceAiGrades = () => [{ id: h.ids.a }];
  await h.open();
  h.addBtn().click();
  await until(() => h.control.gradeCalls.length);
  assert.equal(h.control.gradeCalls[0].step, 'relevance-recalibrate');
  await h.settled();
});

test('goal suggest: Add twice quickly adds once', async () => {
  const h = await harness();
  await h.open();
  const add = h.addBtn();
  let addNodeCalls = 0; const addNode = h.view.addNode.bind(h.view); h.view.addNode = (...args) => { addNodeCalls++; return addNode(...args); };
  h.control.gradeGate = deferred();
  add.fire('click'); add.fire('click');
  await until(() => h.control.gradeCalls.length);
  for (let i = 0; i < 30; i++) await tick(); // a second, unguarded Add would still be writing
  assert.deepEqual((await h.titlesOnDisk()).filter(x => !BASE.includes(x)), ['Sleep stages', 'Stress habits']);
  assert.equal(addNodeCalls, 2, 'two cards were written once, not twice');
  assert.equal(h.control.gradeCalls.length, 1);
  h.control.gradeGate.resolve(); await h.settled();
});

test('goal suggest: a parent deleted, renamed or AI-locked while the list waited is skipped on Add and the count is announced', async () => {
  const h = await harness();
  h.control.suggest = async () => JSON.stringify({ suggestions: [{ parentId: 'c2', title: 'Sleep stages' }, { parentId: 'c5', title: 'Stress habits' }, { parentId: 'c3', title: 'Light exposure' }] });
  await h.open();
  h.view.map.nodes = h.view.map.nodes.filter(n => n.id !== h.ids.d); // Dreams deleted (in the map file too, so the write finds no outside change)
  await h.repo.saveMap(MAP, h.view.map);
  await h.repo.writeAiLocked(h.view.map.nodes.find(n => n.id === h.ids.c).path, true); // REM locked meanwhile, on disk (Add reads the notes again)
  h.control.gradeGate = deferred();
  h.addBtn().click();
  await until(() => h.notices.some(m => /no longer fit/.test(m)));
  const added = (await h.titlesOnDisk()).filter(x => !BASE.includes(x));
  assert.ok(added.includes('Sleep stages'), 'the intact suggestion is added');
  assert.ok(!added.includes('Stress habits'), 'the deleted parent is skipped');
  assert.ok(!added.includes('Light exposure'), 'the parent locked meanwhile is skipped');
  assert.match(h.notices.find(m => /no longer fit/.test(m)), /^2 suggestions no longer fit the map and were skipped$/);
  h.control.gradeGate.resolve(); await h.settled().catch(() => {});
});

test('goal suggest: a renamed parent is skipped on Add', async () => {
  const h = await harness();
  await h.open();
  await h.repo.updateNote(h.view.map.nodes.find(n => n.id === h.ids.a).path, { title: 'Body (renamed)' });
  h.control.gradeGate = deferred();
  h.addBtn().click();
  await until(() => h.notices.some(m => /no longer fit/.test(m)));
  assert.ok(!(await h.titlesOnDisk()).includes('Sleep stages'));
  assert.ok((await h.titlesOnDisk()).includes('Stress habits'));
  h.control.gradeGate.resolve(); await h.settled().catch(() => {});
});

test('goal suggest: Stop writes nothing, and the late result is dropped', async () => {
  const h = await harness();
  const gate = deferred(); h.control.suggest = async () => { await gate.promise; return JSON.stringify({ suggestions: TWO }); };
  h.spark().click(); await until(() => h.stopBtn());
  const signal = h.control.suggestCalls[0].signal;
  h.stopBtn().click();
  assert.equal(signal.aborted, true); assert.equal(h.panel(), undefined);
  assert.ok(h.icons().every(b => !b.disabled || b.attrs['aria-label'] === 'Recalibrate'), 'icons are back');
  assert.equal(h.spark().focused, true, 'focus returns to the spark');
  gate.resolve(); await tick(); await tick();
  assert.equal(h.panel(), undefined); assert.deepEqual(await h.titlesOnDisk(), BASE); assert.equal(h.notices.length, 0, 'a stop is silent');
});

test('goal suggest: closing the view or switching maps drops the late result', async () => {
  for (const how of ['close', 'switch']) {
    const h = await harness();
    const gate = deferred(); h.control.suggest = async () => { await gate.promise; return JSON.stringify({ suggestions: TWO }); };
    h.spark().click(); await until(() => h.stopBtn());
    const signal = h.control.suggestCalls[0].signal;
    if (how === 'close') { h.view.closed = true; h.view.dropMapBackground(); } else { h.view.dropMapBackground(); h.view.path = 'Agent Workspace/Topics/other/Map.md'; }
    assert.equal(signal.aborted, true, how);
    gate.resolve(); await tick(); await tick();
    assert.equal(h.view.goalSuggestTask, null, how);
    assert.equal(h.rows().length, 0, how);
    h.view.path = MAP;
    assert.deepEqual(await h.titlesOnDisk(), BASE, how);
  }
});

test('goal suggest: a declined usage notice calls no AI and writes nothing', async () => {
  const h = await harness();
  h.control.decline = true;
  h.spark().click(); await until(() => h.view.goalSuggestTask === null);
  assert.equal(h.control.suggestCalls.length, 0); assert.equal(h.panel(), undefined);
  assert.deepEqual(await h.titlesOnDisk(), BASE);
  assert.equal(h.spark().disabled, false, 'it can be pressed again');
});

test('goal suggest: Skip, Esc and a press outside close the list, write nothing, and return focus to the spark', async () => {
  for (const how of ['skip', 'esc', 'outside']) {
    const h = await harness();
    await h.open();
    assert.equal(h.listeners.pointerdown.length, 1, 'one outside listener while the list is open');
    if (how === 'skip') h.skipBtn().click();
    else if (how === 'esc') h.panel().fire('keydown', { key: 'Escape' });
    else h.listeners.pointerdown[0]({ target: element('div') });
    assert.equal(h.panel(), undefined, how);
    assert.equal(h.listeners.pointerdown.length, 0, `${how}: listener removed`);
    assert.deepEqual(await h.titlesOnDisk(), BASE, how);
    assert.equal(h.control.gradeCalls.length, 0, how);
    if (how !== 'outside') assert.equal(h.spark().focused, true, how);
  }
});

test('goal suggest: starting a grade while the list is open closes the list', async () => {
  const h = await harness();
  await h.open();
  h.icons().find(b => b.attrs['aria-label'] === 'Grade by goal' || /alibrate|Grade/.test(b.attrs['aria-label'] ?? '')).click();
  await until(() => h.control.gradeCalls.length);
  assert.equal(h.panel(), undefined); assert.equal(h.view.goalSuggestTask, null);
  await h.settled();
});

test('goal suggest: an empty answer says so and closes; an entirely unusable one says that', async () => {
  const h = await harness();
  h.control.suggest = async () => JSON.stringify({ suggestions: [] });
  h.spark().click(); await until(() => h.notices.length);
  assert.deepEqual(h.notices, ['No topics to add']); assert.equal(h.panel(), undefined);
  h.control.suggest = async () => JSON.stringify({ suggestions: [{ parentId: 'c9', title: 'Ghost' }] });
  h.spark().click(); await until(() => h.notices.length === 2);
  assert.equal(h.notices[1], "The AI's 1 suggestions could not be used. Nothing was changed.");
  assert.equal(h.panel(), undefined);
});

test('goal suggest: a suggestion under an AI-locked parent is dropped with a count', async () => {
  const h = await harness();
  h.view.notes.set(h.ids.b, { ...h.view.notes.get(h.ids.b), aiLocked: true });
  const original = h.view.hydrate; h.view.hydrate = async () => { await original(); h.view.notes.set(h.ids.b, { ...h.view.notes.get(h.ids.b), aiLocked: true }); };
  await h.open();
  assert.deepEqual(h.titles(), ['Sleep stages']);
  assert.ok(h.notices.some(m => /^1 suggestions touch locked topics/.test(m)));
});

test('goal suggest: a provider failure shows a Notice, writes nothing, and can be pressed again', async () => {
  const h = await harness();
  h.control.suggest = async () => { throw new Error('connection timed out'); };
  h.spark().click(); await until(() => h.notices.length);
  assert.equal(h.panel(), undefined); assert.deepEqual(await h.titlesOnDisk(), BASE);
  assert.equal(h.spark().disabled, false);
});

test('goal suggest: zh-TW and zh-CN strings use the product wording (the view reads the language at load, so the strings are checked directly)', () => {
  const { translate } = load('i18n.ts');
  assert.equal(translate('zh-TW', 'ui.goal_suggest_under_0', 'Body'), '放在「Body」底下');
  assert.equal(translate('zh-TW', 'ui.goal_suggest_add_0', 2), '加入 2 個');
  assert.equal(translate('zh-TW', 'ui.goal_suggest_skip'), '略過');
  assert.equal(translate('zh-TW', 'ui.goal_suggest_running'), '建議中…');
  assert.equal(translate('zh-TW', 'ui.goal_suggest_stop'), '停止');
  assert.equal(translate('zh-TW', 'ui.goal_suggest_none'), '沒有可補的議題');
  assert.equal(translate('zh-CN', 'ui.goal_suggest_add_0', 2), '加入 2 个');
  for (const locale of ['zh-TW', 'zh-CN']) for (const key of ['ui.goal_suggest_list_label', 'ui.goal_suggest_unusable_0', 'ui.goal_suggest_skipped_0', 'ui.goal_suggest_added_0', 'ui.goal_suggest_history_label', 'error.plain_goal_suggest_context']) assert.doesNotMatch(translate(locale, key, 1), /地圖|地图/, key);
});
