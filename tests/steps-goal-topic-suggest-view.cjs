// Goal-banner P5: the "suggest new topics for the goal" list on the real view and repository.
// The AI is a fake behind the real GoalTopicSuggestService and RelevanceGradeService (strict parsers included); the DOM is tests/support-dom.cjs.
// No provider is called. Picked up by `npm run test:unit` through the tests/steps-*.cjs glob.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const INSET_GAP = 8;
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
  const others = h.icons().filter(b => b.attrs['data-goal-action'] !== 'suggest');
  assert.equal(others.length, 3);
  for (const label of ['Grade with this', 'Sort by relevance', 'Edit goal']) {
    const icon = others.find(b => b.attrs['aria-label'] === label);
    assert.ok(icon, `the ${label} icon exists`); assert.equal(icon.disabled, false, `${label} is enabled while the list is ready`);
  }
  assert.equal(h.spark().disabled, false, 'the spark (closes the list) is enabled too');
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

test('goal suggest: one undo removes every card the Add step created', async () => {
  const h = await harness();
  await h.open();
  h.control.decline = true; // the follow-up grade is declined, so the only history entry is the add step
  const past = h.view.history.past.length;
  h.addBtn().click();
  await until(() => h.view.history.past.length === past + 1);
  await until(async () => (await h.repo.readMap(MAP)).nodes.length === 7);
  assert.deepEqual(await h.titlesOnDisk(), [...BASE, 'Sleep stages', 'Stress habits'].sort(), 'both cards were added');
  await h.view.travel(false);
  assert.equal(h.view.history.past.length, past, 'one undo takes the whole step back');
  assert.deepEqual(await h.titlesOnDisk(), BASE, 'every card the step added is gone');
  assert.equal((await h.repo.readMap(MAP)).nodes.length, 5);
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
    else { await new Promise(r => setTimeout(r, 5)); assert.equal(h.spark().focused, true, 'outside press: focus comes back once the browser has settled'); }
  }
});

test('goal suggest: Esc anywhere on the canvas closes an open list first; with no list the old Esc handling is untouched; hidden icons send focus to the goal text', async () => {
  const h = await harness();
  const esc = () => { const e = { key: 'Escape', target: { closest: () => null }, defaultPrevented: false, prevented: 0, stopped: 0, preventDefault() { this.prevented++; }, stopPropagation() { this.stopped++; } }; return e; };
  h.view.contentEl.ownerDocument.querySelector = () => null;
  const realEscape = h.view.selection.escape.bind(h.view.selection); h.view.selection.escape = () => { h.escaped = (h.escaped ?? 0) + 1; return realEscape(); };
  await h.open();
  const e = esc(); h.view.onMapKeydown(e);
  assert.equal(h.panel(), undefined, 'the list is closed by an Esc with focus on the canvas');
  assert.equal(h.escaped, undefined, 'the selection was not cleared by that Esc'); assert.ok(e.prevented && e.stopped);
  assert.equal(h.spark().focused, true);
  // A hidden spark (no hover, icons display:none) cannot take focus: the goal text gets it and shows the icons.
  await h.open();
  const query = h.rootEl.querySelector;
  h.rootEl.querySelector = selector => { const el = query(selector); if (el && selector.includes('data-goal-action="suggest"')) Object.defineProperty(el, 'offsetParent', { value: null, configurable: true }); return el; };
  const hidden = esc(); h.view.onMapKeydown(hidden);
  assert.equal(h.panel(), undefined);
  assert.equal(find(h.rootEl, i => hasCls(i, 'vam-goal-text')).focused, true, 'focus fell back to the goal text');
  assert.ok(!h.spark().focused, 'not on the hidden spark');
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

test('goal suggest: the card scrolls its rows inside the canvas height and keeps the footer outside the scroll area', async () => {
  const h = await harness();
  await h.open();
  const panel = h.panel();
  const rowsEl = find(panel, i => hasCls(i, 'vam-goal-suggest-rows'));
  assert.ok(rowsEl, 'the rows have their own container');
  assert.equal(h.rows().length, 2); assert.ok(h.rows().every(r => find(rowsEl, i => i === r)), 'every row is inside the scroll container');
  assert.ok(!find(rowsEl, i => hasCls(i, 'vam-goal-suggest-foot')) && !find(rowsEl, i => i === h.addBtn()) && !find(rowsEl, i => i === h.skipBtn()), 'the footer buttons are outside the scroll container');
  const bar = find(h.rootEl, i => hasCls(i, 'vam-goal-bar'));
  const tools = element('div'); tools.addClass('vam-map-tools'); h.rootEl.appendChild(tools);
  // A tall bar (long goal, narrow canvas): 12 + 295 tall in a 774px canvas.
  Object.assign(bar, { offsetTop: 12, offsetHeight: 295, parentElement: { clientHeight: 774 } });
  panel.offsetHeight = 300;
  h.view.layoutTopStack(bar);
  assert.equal(panel.style['--vam-goal-attach-max'], `${774 - 307 - 6 - 8 - 8}px`, 'max-height is the room under the bar minus the card gap, the tools gap and the inset gap (no zoom bar laid out)');
  Object.assign(bar, { offsetHeight: 100, parentElement: { clientHeight: 500 } });
  h.view.layoutTopStack(bar);
  assert.equal(panel.style['--vam-goal-attach-max'], `${500 - 112 - 6 - 8 - 8}px`, 'follows the canvas size');
  const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  assert.match(css, /\.vam-goal-suggest \{[^}]*max-height: var\(--vam-goal-attach-max/);
  assert.match(css, /\.vam-goal-suggest-rows \{[^}]*overflow-y: auto/);
  assert.match(css, /\.vam-goal-suggest-foot \{ flex: none; \}/);
});

test('goal suggest: on a narrow canvas the card stops above the zoom bar and the hint; no floating control overlaps another', async () => {
  const h = await harness();
  await h.open();
  const panel = h.panel();
  const bar = find(h.rootEl, i => hasCls(i, 'vam-goal-bar'));
  const rect = (left, top, right, bottom) => ({ left, top, right, bottom, width: right - left, height: bottom - top });
  // 360 x 774 canvas at the screen origin; the bar is 12 + 295 tall; zoom bar y 697-737; the status bar adds 0 here.
  const canvas = rect(0, 0, 360, 774);
  const tools = element('div'); tools.addClass('vam-map-tools'); h.rootEl.appendChild(tools);
  const zoom = element('div'); zoom.addClass('vam-zoom-controls'); h.rootEl.appendChild(zoom);
  const hint = element('div'); hint.addClass('vam-canvas-hint'); h.rootEl.appendChild(hint);
  zoom.getBoundingClientRect = () => rect(150, 697, 348, 737);
  hint.getBoundingClientRect = () => rect(12, 640, 180, 700);
  h.view.viewportEl = { getBoundingClientRect: () => canvas };
  Object.assign(bar, { offsetTop: 12, offsetHeight: 295, parentElement: { clientHeight: 774, getBoundingClientRect: () => canvas } });
  bar.getBoundingClientRect = () => rect(12, 12, 348, 307);
  tools.offsetHeight = 36; panel.offsetHeight = 300;
  h.view.layoutTopStack(bar);
  const max = parseInt(panel.style['--vam-goal-attach-max'], 10);
  const cardTop = 307 + 6;
  assert.ok(cardTop + max + 8 + 36 <= 640 - INSET_GAP, `the card's bottom (${cardTop + max}) stays above the hint (top 640) with the gap`);
  assert.ok(cardTop + max + 8 + 36 <= 697 - INSET_GAP, `the card's bottom stays above the zoom bar (top 697) with the gap`);
  // Without the hint the zoom bar alone limits it.
  hint.getBoundingClientRect = () => rect(0, 0, 0, 0);
  h.view.layoutTopStack(bar);
  assert.equal(cardTop + parseInt(panel.style['--vam-goal-attach-max'], 10) + 8 + 36, 697 - INSET_GAP, 'the card, the tools gap and the tools end at the zoom bar minus the gap');
  // Generic check: the bar, the card at its max height, the tools and every other floating control do not overlap.
  const cardHeight = parseInt(panel.style['--vam-goal-attach-max'], 10);
  panel.offsetHeight = cardHeight;
  h.view.layoutTopStack(bar);
  const toolsTop = parseInt(tools.style.top, 10);
  tools.getBoundingClientRect = () => rect(12, toolsTop, 200, toolsTop + 36);
  const { rectsIntersect } = load('experiences/visual-map/viewport-inset.ts');
  const rects = [['card', rect(12, cardTop, 348, cardTop + cardHeight)], ...h.view.floatingControlRects().map((r, n) => ['control ' + n, r])];
  assert.equal(rects.length, 4, 'tools, bar and zoom bar are counted besides the card (the hint is empty)');
  for (let a = 0; a < rects.length; a++) for (let b = a + 1; b < rects.length; b++) assert.ok(!rectsIntersect(rects[a][1], rects[b][1]), `${rects[a][0]} overlaps ${rects[b][0]}`);
});

// ---- Goal-banner P5e: the top stack (goal bar, its attachment, the tool group, the sources panel) in every state x width ----
// The geometry below is a stand-in for CSS: every rect is derived from what the view writes (style.top / left / width, --vam-*
// variables, classes), so a view that stops writing the right value fails here. The compared rects come from the view's own
// floatingControlRects(), so a layer missing from the shared list is missing from the check too.
const R = (left, top, right, bottom) => ({ left, top, right, bottom, width: right - left, height: bottom - top });
const px = value => { const n = parseFloat(value); return Number.isFinite(n) ? n : null; };
const CANVAS_H = 774, CANVAS_LEFT = 100;
const WIDTHS = [
  { name: '360', width: 360, chat: 0 },
  { name: '640 + chat overlay', width: 640, chat: 200 },
  { name: '936', width: 936, chat: 0 }
];
const STATES = [
  { name: 'none' },
  { name: 'suggest list at its tallest', attachment: 'suggest', content: 900 },
  { name: 'edit panel, short goal', attachment: 'edit', content: 110 },
  { name: 'edit panel, long wrapped goal', attachment: 'edit', content: 110, goalHeight: 150 },
  { name: 'sources panel', sources: 500 },
  { name: 'suggest list + tools hover', attachment: 'suggest', content: 900, hover: true },
  { name: 'edit panel + tools hover', attachment: 'edit', content: 110, hover: true },
  { name: 'sources panel + tools hover', sources: 500, hover: true }
];

async function stackRig(width, chat, state) {
  const h = await harness();
  const view = h.view;
  const canvas = R(CANVAS_LEFT, 0, CANVAS_LEFT + width, CANVAS_H);
  const overlay = { clientHeight: CANVAS_H, getBoundingClientRect: () => canvas };
  view.viewportEl = { getBoundingClientRect: () => canvas };
  view.chat = chat ? { isOverlay: true, overlayWidth: 44 + chat } : null;
  if (state.attachment === 'suggest') await h.open();
  else if (state.attachment === 'edit') view.editRelevanceGoal();
  const bar = find(h.rootEl, i => hasCls(i, 'vam-goal-bar'));
  const goalHeight = state.goalHeight ?? 62;
  const barRect = () => {
    const inset = px(bar.style['--vam-goal-inset']) ?? 0;
    const w = Math.min(460, width - 24 - inset);
    const centre = CANVAS_LEFT + width / 2 + inset / 2;
    return R(centre - w / 2, 12, centre + w / 2, 12 + goalHeight);
  };
  Object.assign(bar, { offsetTop: 12, offsetHeight: goalHeight, parentElement: overlay, getBoundingClientRect: barRect });
  const tools = element('div'); tools.addClass('vam-map-tools'); h.rootEl.appendChild(tools);
  tools.offsetHeight = 36; tools.parentElement = overlay;
  const toolsRect = () => { const left = CANVAS_LEFT + (px(tools.style.left) ?? 12), top = px(tools.style.top) ?? 12; return R(left, top, left + (state.hover ? 246 : 165), top + 36); };
  tools.getBoundingClientRect = toolsRect;
  const zoom = element('div'); zoom.addClass('vam-zoom-controls'); h.rootEl.appendChild(zoom);
  zoom.getBoundingClientRect = () => R(canvas.right - 12 - 198, 697, canvas.right - 12, 737);
  const hint = element('div'); hint.addClass('vam-canvas-hint'); h.rootEl.appendChild(hint);
  hint.getBoundingClientRect = () => width === 360 ? R(canvas.left + 12, 640, canvas.left + 132, 700) : R(canvas.left + 12, 704, canvas.left + 190, 744);
  const attachment = find(h.rootEl, i => hasCls(i, 'vam-goal-attachment'));
  if (state.attachment) {
    assert.ok(attachment, `${state.attachment} panel carries vam-goal-attachment`);
    const attachRect = () => { const b = barRect(), top = b.bottom + 6; return R(b.left, top, b.right, top + attachment.offsetHeight); };
    Object.defineProperty(attachment, 'offsetHeight', { get() { const max = px(this.style['--vam-goal-attach-max']); return max === null ? state.content : Math.min(state.content, max); } });
    attachment.getBoundingClientRect = attachRect;
  }
  let sources = null;
  if (state.sources) {
    const button = element('button'); tools.appendChild(button);
    sources = element('div', 'vam-map-sources-panel'); tools.appendChild(sources);
    Object.assign(view, { mapSourcesToolsEl: tools, mapSourcesButtonEl: button, mapSourcesPanelEl: sources, mapSourcesOpen: true });
    button.getBoundingClientRect = () => { const t = toolsRect(); return R(t.left + (state.hover ? 110 : 35), t.top + 3, t.right - 3, t.bottom - 3); };
    Object.defineProperty(sources, 'offsetHeight', { get() { const max = px(this.style['--vam-sources-max']); return max === null ? state.sources : Math.min(state.sources, max); } });
    sources.getBoundingClientRect = () => { const t = toolsRect(), top = t.bottom + 6, left = t.left + (px(sources.style.left) ?? 0) + 1; return R(left, top, left + (px(sources.style.width) ?? 440), top + sources.offsetHeight); };
  }
  view.placeMapTools();
  const labelled = [['bar', barRect()], ['tools', toolsRect()], ['zoom', zoom.getBoundingClientRect()], ['hint', hint.getBoundingClientRect()]];
  if (state.attachment) labelled.push(['attachment', attachment.getBoundingClientRect()]);
  if (sources) labelled.push(['sources panel', sources.getBoundingClientRect()]);
  return { h, view, bar, tools, canvas, labelled, attachment, sources };
}

test('goal stack: in every state and width no floating layer overlaps another, and all stay on the canvas', async () => {
  const { rectsIntersect } = load('experiences/visual-map/viewport-inset.ts');
  const parentChild = new Set(['bar|attachment', 'tools|sources panel']);
  for (const w of WIDTHS) for (const state of STATES) {
    const where = `${w.name} / ${state.name}`;
    const { view, canvas, labelled } = await stackRig(w.width, w.chat, state);
    const name = rect => labelled.find(([, r]) => JSON.stringify(r) === JSON.stringify(rect))?.[0];
    const seen = view.floatingControlRects().map(rect => ({ rect, label: name(rect) }));
    assert.ok(seen.every(s => s.label), `${where}: floatingControlRects returned a rect that is no known layer`);
    assert.equal(seen.map(s => s.label).sort().join(), labelled.map(([label]) => label).sort().join(), `${where}: floatingControlRects lists every layer that is on screen`);
    for (let a = 0; a < seen.length; a++) {
      assert.ok(seen[a].rect.left >= canvas.left && seen[a].rect.right <= canvas.right && seen[a].rect.top >= canvas.top && seen[a].rect.bottom <= canvas.bottom, `${where}: ${seen[a].label} stays on the canvas ${JSON.stringify(seen[a].rect)}`);
      for (let b = a + 1; b < seen.length; b++) {
        if (parentChild.has(`${seen[a].label}|${seen[b].label}`) || parentChild.has(`${seen[b].label}|${seen[a].label}`)) continue;
        assert.ok(!rectsIntersect(seen[a].rect, seen[b].rect), `${where}: ${seen[a].label} ${JSON.stringify(seen[a].rect)} overlaps ${seen[b].label} ${JSON.stringify(seen[b].rect)}`);
      }
    }
    // Whatever hangs under the bar (the attachment, the tools, the sources panel) ends above the zoom bar and the hint, INSET_GAP clear.
    const limit = Math.min(...labelled.filter(([l]) => l === 'zoom' || l === 'hint').map(([, r]) => r.top)) - INSET_GAP;
    for (const [label, rect] of labelled.filter(([l]) => ['attachment', 'tools', 'sources panel'].includes(l))) assert.ok(rect.bottom <= limit, `${where}: ${label} bottom ${rect.bottom} clears the bottom controls (limit ${limit})`);
  }
});

test('goal stack: the 936px canvas keeps its look: tools 8px under the goal bar, sources button always in the tool group', async () => {
  const { tools, bar } = await stackRig(936, 0, { name: 'none' });
  assert.equal(tools.style.top, `${12 + 62 + 8}px`, 'tools sit GOAL_BAR_TOOLS_GAP under the bar');
  const { tools: tallTools } = await stackRig(936, 0, { name: 'wrapped', goalHeight: 150 });
  assert.equal(tallTools.style.top, `${12 + 150 + 8}px`, 'and follow a wrapped goal');
  const edit = await stackRig(936, 0, { name: 'edit', attachment: 'edit', content: 110 });
  assert.equal(edit.tools.style.top, `${12 + 62 + 8}px`, 'a panel that does not reach the tools leaves them where they are');
  assert.ok(edit.bar.hasClass('has-attachment'), 'the bar that carries an attachment is marked');
  assert.ok(!bar.hasClass('has-attachment'), 'and an idle bar is not');
});

test('goal stack: the layer list is complete: every absolutely positioned layer the overlay and the goal bar draw is in FLOATING_LAYER_SELECTORS', async () => {
  const { FLOATING_LAYER_SELECTORS } = load('experiences/visual-map/viewport-inset.ts');
  const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  // Class names whose rule (outside @media) sets position: absolute.
  const absolute = new Set();
  for (const [, selectors, body] of css.matchAll(/^([^{}@\n][^{}\n]*)\{([^{}]*)\}/gm)) {
    if (!/position:\s*absolute/.test(body)) continue;
    for (const part of selectors.split(',')) { const m = part.trim().match(/^\.([\w-]+)$/); if (m) absolute.add(m[1]); }
  }
  const listed = new Set(FLOATING_LAYER_SELECTORS.map(s => s.replace(/^\./, '')));
  for (const needed of ['vam-map-tools', 'vam-goal-bar', 'vam-goal-attachment', 'vam-map-sources-panel', 'vam-zoom-controls', 'vam-canvas-hint']) assert.ok(listed.has(needed), `${needed} is in the list`);
  // Visually hidden helpers are not layers.
  const notLayers = new Set(['vam-sr-only']);
  for (const state of STATES) {
    const { h, tools, sources } = await stackRig(936, 0, state);
    for (const el of [...findAll(h.rootEl, () => true), ...(sources ? [sources] : []), tools]) {
      const classes = (el.cls ?? '').split(/\s+/).filter(Boolean);
      for (const cls of classes) {
        if (!absolute.has(cls) || notLayers.has(cls) || !/^vam-(goal|relevance|map-sources-panel|map-tools|zoom|canvas-hint)/.test(cls)) continue;
        assert.ok(listed.has(cls) || classes.some(c => listed.has(c)), `${state.name}: .${cls} is positioned absolute under the overlay or the goal bar but is not in FLOATING_LAYER_SELECTORS`);
      }
    }
  }
  // Every goal-bar attachment is also marked as one.
  for (const [cls, state] of [['vam-goal-suggest', STATES[1]], ['vam-relevance-panel', STATES[2]]]) {
    const { h } = await stackRig(936, 0, state);
    assert.ok(find(h.rootEl, i => hasCls(i, cls) && hasCls(i, 'vam-goal-attachment')), `.${cls} is a vam-goal-attachment`);
  }
});

test('goal stack: only one attachment is open at a time (opening the list closes the editor)', async () => {
  const h = await harness();
  h.view.editRelevanceGoal();
  assert.ok(find(h.rootEl, i => hasCls(i, 'vam-relevance-panel')), 'the editor is open');
  await h.open();
  assert.ok(!find(h.rootEl, i => hasCls(i, 'vam-relevance-panel')), 'the editor closed');
  assert.equal(findAll(h.rootEl, i => hasCls(i, 'vam-goal-attachment')).length, 1);
});

test('goal stack: CSS gives an open attachment and an open sources panel a z-index above the mini tool group, and bounds their height', () => {
  const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  const rule = selector => { const m = css.match(new RegExp(`^${selector.replace(/[.\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'm')); assert.ok(m, `${selector} rule exists`); return m[1]; };
  const z = body => Number(body.match(/z-index:\s*(\d+)/)?.[1]);
  const mini = z(rule('.vam-tools-mini'));
  assert.ok(z(rule('.vam-goal-bar.has-attachment')) > mini, 'the goal bar with an attachment is above .vam-tools-mini');
  assert.ok(z(rule('.vam-map-tools.has-panel')) > mini, 'the tool group with a panel is above .vam-tools-mini');
  assert.ok(z(rule('.vam-goal-bar.has-attachment')) < 6, 'below the selection bar (6)');
  assert.match(rule('.vam-relevance-panel'), /max-height:\s*var\(--vam-goal-attach-max, none\)/);
  assert.match(rule('.vam-relevance-panel'), /overflow-y:\s*auto/);
  assert.match(rule('.vam-goal-suggest'), /max-height:\s*var\(--vam-goal-attach-max, none\)/);
  assert.match(rule('.vam-map-sources-panel'), /max-height:\s*var\(--vam-sources-max, none\)/);
  assert.match(rule('.vam-map-sources-panel'), /overflow-y:\s*auto/);
  // Children of the attachment never outrank layers outside the bar: its stacking context decides, so no z-index inside it.
  for (const cls of ['vam-relevance-panel', 'vam-goal-suggest']) assert.doesNotMatch(rule(`.${cls}`), /z-index/, `.${cls} sets no z-index of its own`);
});

// ---- the tier floor for just-added cards, and no suggestion under a skippable card --------------------------------

const SIDE_FOR_NEW = request => request.nodes.filter(n => n.parentId !== null).map(n => ({ id: labelOf(request, n.id), tier: ['Sleep stages', 'Stress habits'].includes(n.title) ? 'side' : (TITLES[n.title] ?? 'support') }));
const tierOnDisk = async (h, title) => {
  const map = await h.repo.readMap(MAP);
  for (const n of map.nodes) { const note = await h.repo.readNote(n.path); if (note.title === title) return note.relevance?.tier; }
  return 'missing';
};

test('goal suggest: a card the AI grades side under a non-side parent is written as support after Add (full grade; counter-examples 1, 7)', async () => {
  const h = await harness();
  h.control.grade = async request => request.nodes.length && { items: SIDE_FOR_NEW(request) };
  await h.open(); h.addBtn().click(); await until(() => h.control.gradeCalls.length); await h.settled();
  assert.equal(h.control.gradeCalls[0].step, 'relevance-grade');
  assert.equal(await tierOnDisk(h, 'Sleep stages'), 'support', 'under Body (core)');
  assert.equal(await tierOnDisk(h, 'Stress habits'), 'support', 'under Mind (support)');
  assert.equal(await tierOnDisk(h, 'REM'), 'side', 'an old card the AI called side stays side');
});

test('goal suggest: the same floor applies in recalibrate mode (counter-example 7)', async () => {
  const h = await harness();
  h.control.grade = async request => ({ changes: request.nodes.filter(n => ['Sleep stages', 'Stress habits'].includes(n.title)).map(n => ({ id: labelOf(request, n.id), tier: 'side', anchor: null })) });
  h.view.relevanceAiGrades = () => [{ id: h.ids.a, tier: 'core' }, { id: h.ids.b, tier: 'support' }, { id: h.ids.c, tier: 'side' }, { id: h.ids.d, tier: 'support' }];
  await h.open(); h.addBtn().click(); await until(() => h.control.gradeCalls.length); await h.settled();
  assert.equal(h.control.gradeCalls[0].step, 'relevance-recalibrate');
  assert.equal(await tierOnDisk(h, 'Sleep stages'), 'support');
  assert.equal(await tierOnDisk(h, 'Stress habits'), 'support');
});

test('goal suggest: an ordinary grade without suggested cards leaves side as side, and the floor is not kept (counter-examples 2, 9)', async () => {
  const h = await harness();
  h.control.grade = async request => ({ items: SIDE_FOR_NEW(request) });
  await h.open(); h.addBtn().click(); await until(() => h.control.gradeCalls.length); await h.settled();
  assert.equal(await tierOnDisk(h, 'Sleep stages'), 'support');
  await h.view.hydrate();
  await h.view.submitRelevanceGoal('Sleep better', '', 'full');
  assert.equal(await tierOnDisk(h, 'Sleep stages'), 'side', 'the next ordinary grade is not floored');
  assert.equal(await tierOnDisk(h, 'Stress habits'), 'side');
});

test('goal suggest: the request carries the current tiers (top-level and ungraded cards left out) and the prompt shows tier', async () => {
  const h = await harness();
  const write = async (key, tier) => h.repo.writeRelevance((await h.repo.readMap(MAP)).nodes.find(n => n.id === h.ids[key]).path, { tier });
  await write('a', 'core'); await write('c', 'side');
  await h.view.hydrate();
  await h.open();
  const { request } = h.control.suggestCalls[0];
  assert.deepEqual(JSON.parse(JSON.stringify(request.tiers)), { [h.ids.a]: 'core', [h.ids.c]: 'side' });
  const prompt = load('core/goal-topic-suggest-service.ts', { obsidian }).buildGoalTopicSuggestPrompt(request);
  assert.match(prompt, /"title":"Body"[^}]*"tier":"core"/);
  assert.match(prompt, /"title":"REM"[^}]*"tier":"side"/);
  assert.doesNotMatch(prompt, /"title":"Mind"[^}]*"tier"/);
  assert.doesNotMatch(prompt, /"title":"Sleep"[^}]*"tier"/);
});

test('goal suggest: a suggestion under a side card is dropped and counted as side_parent; support, core, ungraded and top-level parents stay (counter-example 8)', () => {
  const { parseGoalTopicSuggest } = load('core/goal-topic-suggest-service.ts', { obsidian });
  const node = (id, parentId, depth) => ({ id, title: id, summary: '', status: '', parentId, depth });
  const tree = [node('r', null, 0), node('s', 'r', 1), node('p', 'r', 1), node('k', 'r', 1), node('u', 'r', 1)];
  const tiers = { s: 'side', p: 'support', k: 'core' };
  const raw = JSON.stringify({ suggestions: [{ parentId: 'c2', title: 'under side' }, { parentId: 'c3', title: 'under support' }, { parentId: 'c4', title: 'under core' }, { parentId: 'c5', title: 'under ungraded' }, { parentId: 'c1', title: 'under top' }] });
  const result = parseGoalTopicSuggest(raw, tree, 'en', tiers);
  assert.deepEqual(JSON.parse(JSON.stringify(result.dropped)), [{ index: 0, code: 'side_parent' }]);
  assert.deepEqual([...result.suggestions.map(x => x.title)], ['under support', 'under core', 'under ungraded', 'under top']);
  assert.equal(parseGoalTopicSuggest(raw, tree, 'en').dropped.length, 0, 'no tiers, no drop');
  const all = parseGoalTopicSuggest(JSON.stringify({ suggestions: [{ parentId: 'c2', title: 'x' }] }), tree, 'en', tiers);
  assert.deepEqual([all.suggestions.length, all.dropped.length].map(Number), [0, 1], 'all dropped takes the existing "could not be used" path');
});
