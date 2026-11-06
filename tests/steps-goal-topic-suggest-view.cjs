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
const TWO = [{ parentId: 'c2', title: 'Sleep stages', summary: 'About it.' }, { parentId: 'c4', title: 'Stress habits', summary: 'About it.' }];

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
  const notices = [], ctx = {}, listeners = { pointerdown: [], pointerup: [], pointercancel: [] };
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

test('goal suggest: the spark asks for the usage confirmation, shows "Suggesting…" with Stop and three disabled icons, then the list', async () => {
  const h = await harness();
  assert.equal(h.spark().disabled, false);
  const gate = deferred(); h.control.suggest = async () => { await gate.promise; return JSON.stringify({ suggestions: TWO }); };
  h.spark().click();
  assert.equal(h.control.usageAsks, 1);
  await until(() => h.stopBtn());
  assert.equal(find(h.panel(), i => i.attrs.role === 'status').text, 'Suggesting…');
  assert.equal(h.stopBtn().text, 'Stop'); assert.equal(h.stopBtn().focused, true, 'the keyboard stays in the panel');
  assert.ok(h.icons().length === 3 && h.icons().every(b => b.disabled), 'the three goal icons are disabled while asking');
  gate.resolve(); await until(() => !h.stopBtn() && h.rows().length);
  assert.deepEqual(h.titles(), ['Sleep stages', 'Stress habits']);
  assert.deepEqual(h.whys(), ['Goes under “Body”', 'Goes under “Mind”']);
  assert.equal(h.panel().attrs.role, 'group'); assert.equal(h.panel().attrs['aria-label'], 'Suggested new topics');
  assert.ok(h.boxes().every(b => b.attrs.type === 'checkbox' || b.type === 'checkbox'));
  assert.ok(h.boxes().every(b => b.checked), 'default: every suggestion is checked');
  assert.equal(h.addBtn().text, 'Add 2'); assert.equal(h.skipBtn().text, 'Skip');
  assert.equal(h.boxes()[0].focused, true, 'focus moves into the list');
  const others = h.icons().filter(b => b.attrs['data-goal-action'] !== 'suggest');
  assert.equal(others.length, 2);
  for (const label of ['Grade with this', 'Sort by relevance']) {
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
  h.control.suggest = async () => JSON.stringify({ suggestions: [{ parentId: 'c2', title: evil, summary: 'About it.' }] });
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
  assert.equal((await h.repo.readNote(created[0].path)).summary, 'About it.', 'the AI summary is the new card\'s summary, not the placeholder');
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
  h.control.suggest = async () => JSON.stringify({ suggestions: [{ parentId: 'c2', title: 'Sleep stages', summary: 'About it.' }, { parentId: 'c5', title: 'Stress habits', summary: 'About it.' }, { parentId: 'c3', title: 'Light exposure', summary: 'About it.' }] });
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
  h.control.suggest = async () => JSON.stringify({ suggestions: [{ parentId: 'c9', title: 'Ghost', summary: 'About it.' }] });
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
  // The list starts 6px under a tall bar (long goal, narrow canvas) and may use the canvas down to the bottom limit.
  const rect = (left, top, right, bottom) => ({ left, top, right, bottom, width: right - left, height: bottom - top });
  const canvas = rect(0, 100, 360, 874);
  const overlay = element('div'); overlay.addClass('vam-canvas-overlay'); overlay.clientHeight = 774; overlay.getBoundingClientRect = () => canvas; h.rootEl.appendChild(overlay);
  h.view.viewportEl = { getBoundingClientRect: () => canvas };
  bar.getBoundingClientRect = () => rect(12, 4, 348, 90);
  panel.getBoundingClientRect = () => { throw new Error('the list rect is not an input: its entry animation moves it'); };
  h.view.layoutTopStack(bar);
  assert.equal(panel.style['--vam-goal-attach-max'], `${874 - 8 - 96}px`, 'max-height runs from where the list starts to the canvas bottom minus the inset gap (no zoom bar laid out)');
  overlay.clientHeight = 500; canvas.bottom = 600;
  h.view.layoutTopStack(bar);
  assert.equal(panel.style['--vam-goal-attach-max'], `${600 - 8 - 96}px`, 'follows the canvas size');
  assert.equal(tools.style.top, undefined, 'the tool group is never pushed');
  const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  assert.match(css, /\.vam-goal-suggest \{[^}]*max-height: var\(--vam-goal-attach-max/);
  assert.match(css, /\.vam-goal-suggest-rows \{[^}]*overflow-y: auto/);
  assert.match(css, /\.vam-goal-suggest-foot \{ flex: none; \}/);
});

// ---- Goal header P1: the layers around the goal (bar in a header row, its attachment and icons, the tool group, the sources panel) in every host x state x width ----
// The geometry below is a stand-in for CSS: the icon size, gaps and offsets are read from styles.css, and every rect is derived from
// what the view writes (style.top / left / width, --vam-* variables incl. --vam-tools-max, classes), so a view that stops writing the right
// value fails here. The compared rects come from the view's own floatingControlRects(), so a layer missing from the shared list
// (or an invisible one that is not skipped) is wrong in the check too.
const R = (left, top, right, bottom) => ({ left, top, right, bottom, width: right - left, height: bottom - top });
const px = value => { const n = parseFloat(value); return Number.isFinite(n) ? n : null; };
const STYLES = fs.readFileSync(path.join(root, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const cssRule = (selector, has) => { const hits = [...STYLES.matchAll(new RegExp(`(?:^|[};{])\\s*${selector.replace(/[.\\]/g, '\\$&')} \\{([^{}]*)\\}`, 'g'))].map(m => m[1]).filter(body => !has || has.test(body)); assert.equal(hits.length, 1, `exactly one ${selector} rule${has ? ` matching ${has}` : ''}`); return hits[0]; };
const cssPx = (body, prop) => { const m = body.match(new RegExp(`(?:^|[\\s;])${prop}:\\s*(-?[\\d.]+)px`)); assert.ok(m, `${prop} in ${body}`); return Number(m[1]); };
const ICON = cssRule('.vam-goal-icon', /width:/), ICON_W = cssPx(ICON, 'width'), ICON_H = cssPx(ICON, 'height');
const ACTIONS_BASE = cssRule('.vam-goal-actions', /display: flex/);
// The rule that floats the icons: the selector decides which host it applies to (scoped to .view-header.vam-goal-host = the header row only; unscoped = the toolbar fallback too).
const HEADER_SCOPE = '.view-header.vam-goal-host ';
const FLOAT_MATCH = [...STYLES.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(m => /position: absolute/.test(m[2]) && /\.vam-goal-actions$/.test(m[1].trim()));
assert.equal(FLOAT_MATCH.length, 1, 'exactly one rule floats the icons'); const ACTIONS_FLOAT = FLOAT_MATCH[0][2], FLOAT_SELECTOR = FLOAT_MATCH[0][1].trim();
const floatsIn = inHeader => FLOAT_SELECTOR.startsWith(HEADER_SCOPE) ? inHeader : true; // does the narrow floating rule reach this host?
const ICON_GAP = cssPx(ACTIONS_BASE, 'gap'), ICON_COUNT = 3; // three icons since P3 (the pencil is gone): the narrow icon box is 82 wide, not 108, and the wide slot 84, not 108; both are computed from these CSS values below
const FLOAT_PAD = cssPx(ACTIONS_FLOAT, 'padding'), FLOAT_BORDER = cssPx(ACTIONS_FLOAT, 'border'), FLOAT_GAP = Number(ACTIONS_FLOAT.match(/top: calc\(100% \+ (\d+)px\)/)[1]), FLOAT_RIGHT = cssPx(ACTIONS_FLOAT, 'right');
// In the bar: the icons plus the left padding. Floating under the row: the icons in a bordered chip.
const INLINE_W = ICON_COUNT * ICON_W + (ICON_COUNT - 1) * ICON_GAP + cssPx(ACTIONS_BASE, 'padding-left'), INLINE_H = ICON_H;
const FLOAT_W = ICON_COUNT * ICON_W + (ICON_COUNT - 1) * ICON_GAP + 2 * FLOAT_PAD + 2 * FLOAT_BORDER, FLOAT_H = ICON_H + 2 * FLOAT_PAD + 2 * FLOAT_BORDER;
// While editing the slot holds "+ Context" (at most as wide as the icons' content) and keeps the icons' width in the wide bar; narrow it floats in the same kind of box.
const EDIT_SLOT_W = cssPx(cssRule('.vam-goal-bar.is-editing .vam-goal-actions', /width: \d+px/), 'width'), CHIP_H = cssPx(cssRule('.vam-goal-add-context', /height:/), 'height');
assert.equal(EDIT_SLOT_W, INLINE_W, 'the editing slot is as wide as the idle icon slot (the text wraps the same)'); assert.equal(CHIP_H, ICON_H, 'the chip is as high as an icon');
const ATTACH_GAP = Number(cssRule('.vam-goal-attachment').match(/top: calc\(100% \+ (\d+)px \+ var\(--vam-goal-attach-clear, 0px\)\)/)[1]);
// MEASURED, not derived (vam-tester's CDP run on the real view, 2026-11-06, ui-evidence-p1.md; screen coordinates of that window): the pane
// (.workspace-leaf-content) starts at x 44, y 40 and ends at y 800; the canvas starts CHAT_COLUMN right of the pane's left edge (the chat
// toggle column) and ends at the pane's right edge and bottom; a host's bottom border is 1px (an absolutely positioned child is placed
// from the padding box, so it sits 1px higher than the border-box bottom).
const PANE_LEFT = 44, PANE_TOP = 40, PANE_BOTTOM = 800, CHAT_COLUMN = 44, HOST_BORDER = 1, HEADER_MIN = 40;
// MEASURED: a one-line goal bar is 29.5 high narrow, 34 high wide (its icons sit in the row); the header row of a taller bar is bar + 1.
const BAR_H_NARROW = 29.5, BAR_H_WIDE = 34;
// MEASURED toolbar heights (the info row: map name, "+ New map", outline/undo/redo/export/more; ui-evidence-final item C, 2026-11-06). Header
// row shown: 78.5 at 360, 440, 520 and 540 (it wraps onto two lines), 48 in one line at 600 and wider. Header row hidden (the bar is a
// toolbar child): 114 at 360 to 540, 78.5 at 600, 83 at 936 (640 is not measured: 83 is assumed, the same wrapped layout as 936).
const TOOLBAR_H_HEADER = width => width <= 540 ? 78.5 : 48;
const TOOLBAR_H_FALLBACK = width => width <= 540 ? 114 : width <= 600 ? 78.5 : 83;
// MEASURED button geometry of the info row: 28 x 24 buttons 2px apart, the last one ends 10px inside the pane's right edge; "+ New map" is
// a 120.4 x 30 span 8px left of the outline button. Button top inside the toolbar: header row shown 44.5 (wrapped, 2nd line) / 11.5 (one
// line); header row hidden 80 (3rd line, 360 to 540) / 44.5 (2nd line, 600) / 49 (2nd line, 936; 640 is not measured and taken as 936).
const INFO_BUTTONS = ['outline', 'undo', 'redo', 'export', 'more'];
const INFO_BTN_W = 28, INFO_BTN_H = 24, INFO_BTN_GAP = 2, INFO_RIGHT_INSET = 10, NEW_MAP_W = 120.4, NEW_MAP_H = 30, NEW_MAP_GAP = 8;
const infoButtonTop = (inHeader, width, toolbarTop) => toolbarTop + (inHeader ? (width <= 540 ? 44.5 : 11.5) : (width <= 540 ? 80 : width <= 600 ? 44.5 : 49));
// MEASURED: the tools group wrapped onto two lines by --vam-tools-max is 68 high (30 + 2 + 30 + 3 + 3 padding), not 72.
const WRAPPED_TOOLS_H = 68;
// MEASURED at 360: the zoom bar (with the Token button) is 286 x 40, 12px from the canvas' right and bottom edges. Not measured at other widths.
const ZOOM_W = 286, ZOOM_H = 40, ZOOM_INSET = 12;
// MEASURED goal bar width/left (360): next to the nav buttons and the more button in the header row 236 wide at pane.left + 76; as a toolbar
// child 344 wide at pane.left + 6. Wide widths: the bar is centred in the space left and capped at 460 (item 4 of the run).
const BAR_NARROW = { header: { w: 236, left: 76 }, toolbar: { w: 344, left: 6 } };
// MEASURED: with the header row hidden the goal bar had 245.7px next to the other toolbar children at 936 (it fills what is left); a bar whose
// flex-basis is larger than that wraps onto its own row (then it can use the row, capped at 460). One CJK character of the goal is 13px wide
// (--font-ui-small), the bar spends 2 border + 16 padding + 16 target + 14 gaps + the wide icon slot on everything but the text.
const TOOLBAR_ROOM_FOR_BAR = 245.7, CJK_W = 13;
const WIDTHS = [
  { name: '360', width: 360, chat: 0 },
  { name: '540', width: 540, chat: 0 },
  { name: '640 + chat overlay', width: 640, chat: 200 },
  { name: '936', width: 936, chat: 0 }
];
const HOSTS = ['header row', 'toolbar (header row hidden)'];
// goalHover: the pointer is on the goal. goalFocus: the keyboard is in the bar (:focus-visible). mouseFocus: focus is inside the bar only because
// a mouse press left it there (clicking an icon; or the programmatic focus the view gives the spark after a mouse action, which the browser does
// not treat as keyboard focus) while the pointer has gone.
const STATES = [
  { name: 'none' },
  { name: 'long wrapped goal', goalHeight: 120 },
  { name: 'icons hovered', goalHover: true },
  { name: 'goal focused (keyboard)', goalFocus: true },
  { name: 'goal focused + tools hover', goalFocus: true, hover: true },
  { name: 'icon clicked by mouse, pointer left', mouseFocus: true },
  { name: 'icon clicked by mouse, pointer left + tools hover', mouseFocus: true, hover: true },
  { name: 'suggest list at its tallest', attachment: 'suggest', content: 900 },
  { name: 'suggest list, long goal', attachment: 'suggest', content: 900, goalHeight: 120 },
  { name: 'suggest list running', attachment: 'suggest', content: 40, running: true },
  { name: 'suggest list + tools hover', attachment: 'suggest', content: 900, hover: true },
  // Edit in place (P3): the slot holds "+ Context" once the goal has text (empty: nothing in it), and the context row is a one-line attachment. The textarea always matches :focus-visible.
  { name: 'editing, empty goal (nothing in the slot)', edit: 'empty' },
  { name: 'editing, empty goal + tools hover', edit: 'empty', hover: true },
  { name: 'editing + "+ Context"', edit: 'chip' },
  { name: 'editing + "+ Context" + tools hover', edit: 'chip', hover: true },
  { name: 'editing, long goal + "+ Context"', edit: 'chip', goalHeight: 120 },
  { name: 'editing + context row', edit: 'context', attachment: 'context', content: 36 },
  { name: 'editing + context row + tools hover', edit: 'context', attachment: 'context', content: 36, hover: true },
  { name: 'sources panel', sources: 500 },
  { name: 'tools hover', hover: true },
  { name: 'sources panel + tools hover', sources: 500, hover: true }
];

// What the stylesheet shows of the icons, for a set of conditions ({ hover, focusWithin, focusVisible, attachment }) at a width: a small cascade over the
// rules whose subject is `.vam-goal-actions` under `.vam-goal-bar` (pseudo-classes :hover, :focus-within, :has(:focus-visible), class .has-attachment),
// the narrow container block counted only when narrow. Specificity = number of classes and pseudo-classes; later rules win ties. Returns { opacity, pointerEvents }.
const NARROW_SPAN = (() => { const i = STYLES.indexOf('@container vam-goal-host (max-width: 600px) {'); assert.ok(i >= 0, 'the narrow container block exists'); const m = STYLES.slice(i).match(/\n\}/); return [i, i + m.index]; })();
const ACTION_RULES = [...STYLES.matchAll(/([^{}]+)\{([^{}]*)\}/g)].flatMap(m => {
  const at = m.index + m[1].length - m[1].trimStart().length, narrowRule = at > NARROW_SPAN[0] && at < NARROW_SPAN[1];
  return m[1].split(',').map(x => x.trim()).flatMap(sel => {
    const parsed = sel.match(/^(\.view-header\.vam-goal-host )?(?:\.vam-goal-bar((?::hover|:focus-within|:has\(:focus-visible\)|\.has-attachment)*) )?\.vam-goal-actions$/);
    if (!parsed) return [];
    const tokens = (parsed[2] ?? '').match(/:hover|:focus-within|:has\(:focus-visible\)|\.has-attachment/g) ?? [];
    return [{ tokens, narrowRule, headerOnly: !!parsed[1], spec: tokens.length + (parsed[2] === undefined ? 1 : 2) + (parsed[1] ? 2 : 0), at, opacity: m[2].match(/opacity:\s*([\d.]+)/)?.[1], pe: m[2].match(/pointer-events:\s*(\w+)/)?.[1] }];
  });
});
const actionsStyle = (floating, on) => {
  const key = { ':hover': on.hover, ':focus-within': on.focusWithin, ':has(:focus-visible)': on.focusVisible, '.has-attachment': on.attachment };
  const hits = ACTION_RULES.filter(r => (floating || !r.narrowRule) && r.tokens.every(t => key[t])).sort((a, b) => a.spec - b.spec || a.at - b.at);
  const last = prop => hits.filter(r => r[prop] !== undefined).at(-1)?.[prop];
  return { opacity: last('opacity'), pointerEvents: last('pe') };
};
// The strip between the goal and the floating icons is owned by the bar (::after on .vam-goal-bar, not on the icons that take no pointer while hidden) and reads its box from what the view writes.
{ const stripRules = [...STYLES.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(m => /\.vam-goal-bar::after$/.test(m[1].trim()) && /content/.test(m[2])); assert.equal(stripRules.length, 1, 'exactly one strip rule'); const strip = stripRules[0][2]; for (const n of ['top', 'left', 'width', 'height']) assert.match(strip, new RegExp(`${n}: var\\(--vam-goal-bridge-${n}, 0\\)`), `the strip's ${n} comes from --vam-goal-bridge-${n}`); assert.match(strip, /position: absolute/); assert.doesNotMatch(STYLES, /\.vam-goal-actions::before/, 'the icons own no strip'); }
const actions_isVacant = bar => bar.querySelector?.('.vam-goal-actions')?.hasClass?.('is-vacant');
assert.ok(ACTION_RULES.length >= 4, 'the scan finds the icon visibility rules');

async function stackRig(width, chat, state, host = HOSTS[0]) {
  const h = await harness();
  const view = h.view;
  const inHeader = host === HOSTS[0];
  const narrow = width <= 600;
  const floating = narrow && floatsIn(inHeader); // the icons float under the row (narrow header row only; in the toolbar fallback they keep the bar's slot)
  const barH = state.goalHeight ?? (narrow ? BAR_H_NARROW : BAR_H_WIDE);
  const paneRight = PANE_LEFT + width;
  // Rows above the canvas: the header row (when shown) then the toolbar; the row holding the bar grows with the goal.
  const headerH = inHeader ? Math.max(HEADER_MIN, barH + 1) : 0;
  const baseBar = narrow ? BAR_H_NARROW : BAR_H_WIDE;
  const toolbarH = inHeader ? TOOLBAR_H_HEADER(width) : TOOLBAR_H_FALLBACK(width) + Math.max(0, barH - baseBar);
  const toolbarTop = PANE_TOP + headerH;
  const hostBottom = PANE_TOP + (inHeader ? headerH : toolbarH);
  const canvasTop = toolbarTop + toolbarH;
  const canvas = R(PANE_LEFT + CHAT_COLUMN, canvasTop, paneRight, PANE_BOTTOM);
  const pane = R(PANE_LEFT, PANE_TOP, paneRight, PANE_BOTTOM);
  const overlay = element('div'); overlay.addClass('vam-canvas-overlay'); overlay.clientHeight = PANE_BOTTOM - canvasTop; overlay.getBoundingClientRect = () => canvas;
  view.viewportEl = { getBoundingClientRect: () => canvas };
  view.chat = chat ? { isOverlay: true, overlayWidth: 44 + chat } : null;
  if (state.attachment === 'suggest') await h.open();
  if (state.edit) {
    view.startGoalEdit({});
    if (state.edit === 'empty') { const area = find(h.rootEl, i => i.tag === 'textarea'); area.value = ''; area.fire('input'); }
    if (state.edit === 'context') find(h.rootEl, i => hasCls(i, 'vam-goal-add-context')).click();
  }
  if (state.running) { const task = view.goalSuggestTask; task.state = 'running'; task.focus = null; view.render(); }
  h.rootEl.appendChild(overlay);
  const bar = find(h.rootEl, i => hasCls(i, 'vam-goal-bar'));
  // Narrow: measured widths; wide: centred in the row, capped at 460.
  const barW = narrow ? BAR_NARROW[inHeader ? 'header' : 'toolbar'].w : Math.min(460, width - 200);
  const barLeft = PANE_LEFT + (narrow ? BAR_NARROW[inHeader ? 'header' : 'toolbar'].left : (width - barW) / 2);
  const barTop = narrow && !inHeader ? PANE_TOP + 41.5 : PANE_TOP + ((inHeader ? headerH : toolbarH) - barH) / 2;
  const barRect = () => R(barLeft, barTop, barLeft + barW, barTop + barH);
  bar.getBoundingClientRect = barRect;
  const actions = find(h.rootEl, i => hasCls(i, 'vam-goal-actions'));
  assert.equal(findAll(actions, i => i.tag === 'button').length, state.edit ? (state.edit === 'context' ? 0 : 1) : ICON_COUNT, 'the icon count the rig assumes (editing: no icons, only "+ Context" until the context row replaces it)');
  if (state.edit) {
    assert.equal(findAll(h.rootEl, i => hasCls(i, 'vam-goal-icon')).length, 0, 'no icons are drawn while editing');
    assert.equal(actions.hasClass('is-vacant'), state.edit !== 'chip', 'the slot is vacant exactly when "+ Context" is not on offer');
  }
  // Wide: in the bar's own row. Narrow: FLOAT_GAP under the row (from the host's padding box, HOST_BORDER above its border-box bottom), right-aligned (styles.css, container query).
  const actionsRect = () => floating && actions.hasClass('is-vacant') ? R(0, 0, 0, 0) : floating ? R(paneRight - FLOAT_RIGHT - FLOAT_W, hostBottom - HOST_BORDER + FLOAT_GAP, paneRight - FLOAT_RIGHT, hostBottom - HOST_BORDER + FLOAT_GAP + FLOAT_H) : R(barLeft + barW - 8 - INLINE_W, barTop + (barH - INLINE_H) / 2, barLeft + barW - 8, barTop + (barH - INLINE_H) / 2 + INLINE_H);
  actions.getBoundingClientRect = actionsRect;
  // What shows the icons comes from the stylesheet (actionsStyle): hover, keyboard focus (focus-visible), focus a mouse press left (focus-within only), an open panel.
  const conditions = { hover: !!state.goalHover, focusVisible: !!state.goalFocus || !!state.edit, focusWithin: !!state.goalFocus || !!state.mouseFocus || !!state.attachment || !!state.edit, // a list opened from the spark leaves focus in the bar
     attachment: !!state.attachment };
  const shownStyle = actionsStyle(floating, conditions);
  const actionsShown = shownStyle.opacity !== '0';
  actions.ownerDocument = { defaultView: { getComputedStyle: () => ({ opacity: shownStyle.opacity }) } };
  const tools = element('div'); tools.addClass('vam-map-tools'); h.rootEl.appendChild(tools);
  tools.offsetHeight = 36; tools.parentElement = overlay;
  // The group is 165 wide, 246 hovered; when the view caps its width (--vam-tools-max) it wraps onto a second row (68 high, measured).
  const toolsRect = () => { const left = canvas.left + (px(tools.style.left) ?? 12), top = canvasTop + (px(tools.style.top) ?? 12), natural = state.hover ? 246 : 165, cap = px(tools.style['--vam-tools-max']), w = cap === null ? natural : Math.min(natural, cap); return R(left, top, left + w, top + (w < natural ? WRAPPED_TOOLS_H : 36)); };
  tools.getBoundingClientRect = toolsRect;
  const zoom = element('div'); zoom.addClass('vam-zoom-controls'); h.rootEl.appendChild(zoom);
  zoom.getBoundingClientRect = () => R(canvas.right - ZOOM_INSET - ZOOM_W, canvas.bottom - ZOOM_INSET - ZOOM_H, canvas.right - ZOOM_INSET, canvas.bottom - ZOOM_INSET);
  // The hint's rect is not measured here (hidden at 360 in the run); it keeps the earlier stand-in.
  const hint = element('div'); hint.addClass('vam-canvas-hint'); h.rootEl.appendChild(hint);
  hint.getBoundingClientRect = () => width === 360 ? R(canvas.left + 12, canvas.bottom - 134, canvas.left + 132, canvas.bottom - 74) : R(canvas.left + 12, canvas.bottom - 70, canvas.left + 190, canvas.bottom - 30);
  // The info row's buttons (outline, undo, redo, export, more) and the "+ New map" span: not floating layers, but what the icons must not sit on.
  // Hidden header row: the info row sits under the goal, so a taller goal pushes it down by the same amount (toolbarH grows the same way).
  const top = infoButtonTop(inHeader, width, toolbarTop) + (inHeader ? 0 : Math.max(0, barH - baseBar));
  const infoButtons = INFO_BUTTONS.map((label, i) => { const right = paneRight - INFO_RIGHT_INSET - (INFO_BUTTONS.length - 1 - i) * (INFO_BTN_W + INFO_BTN_GAP); return [label, R(right - INFO_BTN_W, top, right, top + INFO_BTN_H)]; });
  infoButtons.unshift(['new map', R(infoButtons[0][1].left - NEW_MAP_GAP - NEW_MAP_W, top - 3, infoButtons[0][1].left - NEW_MAP_GAP, top - 3 + NEW_MAP_H)]);
  // The box the icons are positioned in: the whole row narrow (the host; with the info row's buttons inside it only when the host is the toolbar), the bar wide.
  const infoBox = element('div'); infoBox.clientTop = HOST_BORDER; infoBox.clientLeft = 0; infoBox.getBoundingClientRect = () => R(PANE_LEFT, PANE_TOP, paneRight, hostBottom);
  if (!inHeader || state.gapButton) for (const [, rect] of state.gapButton ? [['gap', R(paneRight - 60, barTop + barH + 2, paneRight - 30, barTop + barH + 8)]] : infoButtons) { const b = element('button'); b.getBoundingClientRect = () => rect; infoBox.appendChild(b); }
  actions.offsetParent = floating ? infoBox : bar;
  const attachment = find(h.rootEl, i => hasCls(i, 'vam-goal-attachment'));
  if (state.attachment) {
    assert.ok(attachment, `${state.attachment} panel carries vam-goal-attachment`);
    // The panel is positioned in the bar (wide) or in the whole host row (narrow, where the bar is static): the view reads that box
    // through offsetParent. Its top is ATTACH_GAP under the box (from its padding box) plus --vam-goal-attach-clear, the value the view wrote.
    // Narrow it spans the pane (not the canvas): left 8 .. right 8 of the host.
    const rowBox = { getBoundingClientRect: () => R(PANE_LEFT, PANE_TOP, paneRight, hostBottom) };
    attachment.offsetParent = narrow ? rowBox : bar;
    const attachRect = () => { const box = attachment.offsetParent.getBoundingClientRect(), top = box.bottom - (narrow ? HOST_BORDER : 0) + ATTACH_GAP + (px(attachment.style['--vam-goal-attach-clear']) ?? 0); const left = narrow ? pane.left + 8 : barLeft, right = narrow ? pane.right - 8 : barLeft + barW; return R(left, top, right, top + attachment.offsetHeight); };
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
  // What is on screen. The idle icons are invisible (opacity 0), so they are not a layer then.
  const labelled = [['tools', toolsRect()], ['zoom', zoom.getBoundingClientRect()], ['hint', hint.getBoundingClientRect()]];
  if (actionsShown && actionsRect().right > actionsRect().left) labelled.push(['actions', actionsRect()]);
  if (state.attachment) labelled.push(['attachment', attachment.getBoundingClientRect()]);
  if (sources) labelled.push(['sources panel', sources.getBoundingClientRect()]);
  return { h, view, bar, tools, canvas, pane, labelled, attachment, sources, actionsShown, actions, narrow, floating, hostBottom, actionsRect, toolsRect, infoButtons, conditions, barW, inHeader };
}

test('goal stack: in every host, state and width the layers around the goal do not overlap, the tool group never moves, and the list stops above the bottom controls', async () => {
  const { rectsIntersect } = load('experiences/visual-map/viewport-inset.ts');
  const parentChild = new Set(['tools|sources panel']);
  let cells = 0;
  for (const host of HOSTS) for (const w of WIDTHS) for (const state of STATES) {
    cells++;
    const where = `${host} / ${w.name} / ${state.name}`;
    const { view, canvas, labelled, tools, actionsShown, bar, attachment, narrow, floating, hostBottom, actionsRect, toolsRect, infoButtons, conditions, barW, inHeader } = await stackRig(w.width, w.chat, state, host);
    assert.ok(!tools.style.top, `${where}: the tool group keeps the stylesheet top (style.top is empty)`);
    const name = rect => labelled.find(([, r]) => JSON.stringify(r) === JSON.stringify(rect))?.[0];
    const seen = view.floatingControlRects().map(rect => ({ rect, label: name(rect) }));
    assert.ok(seen.every(s => s.label), `${where}: floatingControlRects returned a rect that is no known layer`);
    assert.equal(seen.map(s => s.label).sort().join(), labelled.map(([label]) => label).sort().join(), `${where}: floatingControlRects lists every layer that is on screen`);
    if (!actionsShown) assert.ok(!seen.some(s => s.label === 'actions'), `${where}: idle (invisible) icons are not a floating layer`);
    assert.equal(bar.hasClass('has-attachment'), !!state.attachment, `${where}: has-attachment follows the open panel`);
    if (attachment) {
      const clear = px(attachment.style['--vam-goal-attach-clear']);
      assert.equal(clear, floating ? Math.max(0, actionsRect().bottom - hostBottom) : 0, `${where}: the panel clears exactly the part of the icons that hangs below its box (0 when they are in the bar)`);
      if (state.edit) assert.equal(clear, 0, `${where}: no icons are drawn while editing, so nothing hangs below the box (narrow and wide)`);
      else if (floating) assert.ok(clear > 0, `${where}: floating icons hang below the row`);
      else assert.equal(clear, 0, `${where}: icons in the bar's slot hang below nothing (the toolbar fallback measures 0 by itself)`);
      assert.ok(px(attachment.style['--vam-goal-attach-max']) > 0, `${where}: the list has room`);
    }
    // Narrow, the icons float over the info row's buttons: they show only while the pointer is on the goal, the keyboard is in the bar (:focus-visible) or a panel is
    // open (the user just opened it; approved: it covers the row too). The focus a mouse click leaves behind, or the focus the view gives the spark again after a
    // mouse action, is not a reason (decision #9). Wide, they sit in the bar's own row, so focus-within may show them.
    if (floating) {
      assert.equal(actionsShown, conditions.hover || conditions.focusVisible || conditions.attachment, `${where}: the floating icons are shown exactly for hover, keyboard focus or an open panel`);
      if (!conditions.hover && !conditions.focusVisible && !conditions.attachment) for (const [label, rect] of infoButtons) assert.ok(!actionsShown || !load('experiences/visual-map/viewport-inset.ts').rectsIntersect(actionsRect(), rect), `${where}: the shown icons ${JSON.stringify(actionsRect())} sit on the ${label} button ${JSON.stringify(rect)} without hover or keyboard focus`);
    } else assert.equal(actionsShown, conditions.hover || conditions.focusWithin, `${where}: wide or toolbar fallback, the icons in the bar's slot show for hover, focus or an open panel`);
    // The goal in the toolbar fallback (decision #10): its flex-basis is more than the room next to the other children (measured), so it takes its own row and a goal is
    // not squeezed into a narrow column: the short goal is one line, the 60-character goal stays within its row and is far from 9 lines.
    if (state.name === 'none' && !inHeader) {
      const basis = cssPx(cssRule('.vam-toolbar > .vam-goal-bar'), 'flex-basis'), row = w.width - 16, iconSlot = narrow ? 0 : INLINE_W;
      const ownRow = basis > TOOLBAR_ROOM_FOR_BAR, laidOutW = narrow ? barW : ownRow ? Math.min(460, row) : Math.min(460, TOOLBAR_ROOM_FOR_BAR);
      const lines = chars => Math.ceil(chars * CJK_W / (laidOutW - 2 - 16 - 16 - 14 - iconSlot));
      assert.ok(laidOutW <= row, `${where}: the bar is not wider than its row`);
      assert.equal(lines(9), 1, `${where}: a short goal (9 characters) is on one line`);
      assert.ok(lines(60) <= 4, `${where}: a 60-character goal is not ${lines(60)} lines`);
    }
    // The bar owns a strip from its bottom to the icons' top, as wide as the icons (so the pointer keeps the hover on its way down to them), only inside the gap:
    // it sits on no button of the info row; where such a button lies in the gap (toolbar fallback, icons below the info row) there is no strip.
    const bridge = ['top', 'left', 'width', 'height'].map(n => px(bar.style[`--vam-goal-bridge-${n}`]));
    const barBox = bar.getBoundingClientRect(), iconBox = actionsRect();
    if (bridge[0] === null) assert.ok(bridge.every(v => v === null), `${where}: the strip is written whole or not at all`);
    else {
      const strip = R(PANE_LEFT + bridge[1], PANE_TOP + HOST_BORDER + bridge[0], PANE_LEFT + bridge[1] + bridge[2], PANE_TOP + HOST_BORDER + bridge[0] + bridge[3]);
      assert.ok(floating, `${where}: only floating icons (narrow header row) have a strip (${JSON.stringify(strip)})`);
      assert.equal(strip.top, barBox.bottom, `${where}: the strip starts at the bar's bottom`); assert.equal(strip.bottom, iconBox.top, `${where}: and ends at the icons' top`);
      assert.equal(strip.left, iconBox.left, `${where}: as wide as the icons`); assert.equal(strip.right, iconBox.right, `${where}: as wide as the icons`);
      for (const [label, rect] of infoButtons) assert.ok(!rectsIntersect(strip, rect), `${where}: the strip sits on the ${label} button`);
    }
    if (floating && !actions_isVacant(bar) && iconBox.top > barBox.bottom) assert.ok(bridge[0] !== null, `${where}: a goal with a gap above its icons has a strip (the pointer reaches them)`);
    // Not floating (wide, or the toolbar fallback at any width): the icons sit inside the bar, so hovering the bar reaches them, no strip, nothing hangs below, and no info-row button is under them.
    if (!floating) {
      assert.ok(bridge.every(v => v === null), `${where}: no strip when the icons are in the bar`);
      assert.ok(iconBox.left >= barBox.left && iconBox.right <= barBox.right && iconBox.top >= barBox.top && iconBox.bottom <= barBox.bottom, `${where}: the icons ${JSON.stringify(iconBox)} are inside the bar ${JSON.stringify(barBox)} (mouse reach)`);
      assert.ok(iconBox.bottom <= hostBottom, `${where}: nothing hangs below the host`);
      if (narrow) for (const [label, rect] of infoButtons) assert.ok(!rectsIntersect(iconBox, rect), `${where}: the icons sit on the ${label} button`); // narrow geometry is measured; the wide fallback rig positions are assumed (640), left to the existing wide checks
      assert.equal(iconBox.width, state.edit ? EDIT_SLOT_W : INLINE_W, `${where}: the slot is the same width idle, hovered and editing`);
    }
    const capped = px(tools.style['--vam-tools-max']);
    if (floating && actionsRect().bottom > canvas.top + 12) assert.ok(capped !== null && toolsRect().right <= actionsRect().left, `${where}: the tool group gives way to the icons`);
    else assert.equal(capped, null, `${where}: the tool group keeps its width when the icons are not over its row`);
    for (let a = 0; a < seen.length; a++) {
      const label = seen[a].label, rect = seen[a].rect;
      if (['tools', 'zoom', 'hint', 'sources panel'].includes(label)) assert.ok(rect.left >= canvas.left && rect.right <= canvas.right && rect.top >= canvas.top && rect.bottom <= canvas.bottom, `${where}: ${label} stays on the canvas ${JSON.stringify(rect)}`);
      for (let b = a + 1; b < seen.length; b++) {
        const pair = `${label}|${seen[b].label}`, back = `${seen[b].label}|${label}`;
        if (parentChild.has(pair) || parentChild.has(back)) continue;
        // An open list is allowed to cover the tool group and the canvas (approved), not the icons next to it, the zoom bar or the hint.
        if ((label === 'attachment' && seen[b].label === 'tools') || (label === 'tools' && seen[b].label === 'attachment')) continue;
        assert.ok(!rectsIntersect(rect, seen[b].rect), `${where}: ${label} ${JSON.stringify(rect)} overlaps ${seen[b].label} ${JSON.stringify(seen[b].rect)}`);
      }
    }
    // The list and the sources panel end above the zoom bar and the hint, INSET_GAP clear.
    const limit = Math.min(...labelled.filter(([l]) => l === 'zoom' || l === 'hint').map(([, r]) => r.top)) - INSET_GAP;
    for (const [label, rect] of labelled.filter(([l]) => ['attachment', 'sources panel'].includes(l))) assert.ok(rect.bottom <= limit, `${where}: ${label} bottom ${rect.bottom} clears the bottom controls (limit ${limit})`);
  }
  assert.equal(cells, HOSTS.length * WIDTHS.length * STATES.length, 'every cell of the matrix ran');
  assert.ok(STATES.filter(x => x.edit).length >= 7 && cells >= 168, `the matrix covers the editing states (${cells} cells)`);
});

test('goal stack: the tool group sits at the stylesheet top whatever the goal does, and the layer list is complete: every absolutely positioned layer the overlay and the goal bar draw is in FLOATING_LAYER_SELECTORS', async () => {
  const { FLOATING_LAYER_SELECTORS } = load('experiences/visual-map/viewport-inset.ts');
  // Class names whose rule sets position: absolute, also inside @container / @media blocks (the narrow layout floats the icons there).
  const absolute = new Set();
  for (const [, selectors, body] of STYLES.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!/position:\s*absolute/.test(body)) continue;
    for (const part of selectors.split(',')) { const m = part.trim().match(/^(?:.*\s)?\.([\w-]+)$/); if (m) absolute.add(m[1]); }
  }
  assert.ok(absolute.has('vam-goal-actions'), 'the scan sees the icons, which float only inside the container query');
  const listed = new Set(FLOATING_LAYER_SELECTORS.map(s => s.replace(/^\./, '')));
  for (const needed of ['vam-map-tools', 'vam-goal-actions', 'vam-goal-attachment', 'vam-map-sources-panel', 'vam-zoom-controls', 'vam-canvas-hint']) assert.ok(listed.has(needed), `${needed} is in the list`);
  assert.ok(!listed.has('vam-goal-bar'), 'the goal bar is in a row above the canvas, not a layer over it');
  // Visually hidden helpers are not layers.
  const notLayers = new Set(['vam-sr-only']);
  for (const state of STATES) {
    const { h, tools, sources } = await stackRig(936, 0, state);
    assert.ok(!tools.style.top, `${state.name}: tools keep the stylesheet top`);
    for (const el of [...findAll(h.rootEl, () => true), ...(sources ? [sources] : []), tools]) {
      const classes = (el.cls ?? '').split(/\s+/).filter(Boolean);
      for (const cls of classes) {
        if (!absolute.has(cls) || notLayers.has(cls) || cls === 'vam-goal-bar' || !/^vam-(goal|relevance|map-sources-panel|map-tools|zoom|canvas-hint)/.test(cls)) continue;
        assert.ok(listed.has(cls) || classes.some(c => listed.has(c)), `${state.name}: .${cls} is positioned absolute under the overlay or the goal bar but is not in FLOATING_LAYER_SELECTORS`);
      }
    }
  }
  // Every goal-bar attachment is also marked as one.
  for (const [cls, state] of [['vam-goal-suggest', STATES.find(x => x.attachment === 'suggest')], ['vam-goal-context', STATES.find(x => x.attachment === 'context')]]) {
    const { h } = await stackRig(936, 0, state);
    assert.ok(find(h.rootEl, i => hasCls(i, cls) && hasCls(i, 'vam-goal-attachment')), `.${cls} is a vam-goal-attachment`);
  }
});

test('goal stack: only one attachment is open at a time (the list and the editor close each other)', async () => {
  const h = await harness();
  const textarea = () => find(h.rootEl, i => i.tag === 'textarea');
  h.view.startGoalEdit({}); find(h.rootEl, i => hasCls(i, 'vam-goal-add-context')).click();
  assert.ok(textarea() && find(h.rootEl, i => hasCls(i, 'vam-goal-context')), 'the editor with its context row is open');
  assert.equal(h.icons().length, 0, 'no icons while editing, so the spark cannot open the list; startGoalSuggest is the only way in');
  await h.view.startGoalSuggest(); await until(() => h.panel() && !h.stopBtn());
  assert.equal(textarea(), undefined, 'opening the list drops the editor'); assert.equal(h.view.goalEdit, null);
  assert.equal(findAll(h.rootEl, i => hasCls(i, 'vam-goal-attachment')).length, 1);
  find(h.rootEl, i => hasCls(i, 'vam-goal-text')).click();
  assert.ok(textarea(), 'a press on the goal opens the editor'); assert.equal(h.panel(), undefined, 'and closes the list'); assert.equal(h.view.goalSuggestTask, null);
  assert.equal(findAll(h.rootEl, i => hasCls(i, 'vam-goal-attachment')).length, 0, 'the editor has no attachment until its context row is asked for');
  assert.equal(h.control.gradeCalls.length, 0);
});

test('goal stack: the one z rule is on the goal host (above the overlay chat 12 and the hover card 10); the bar and its panels set none; the sources panel and its bounds stay', () => {
  const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  const rule = selector => { const m = css.match(new RegExp(`^${selector.replace(/[.\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'm')); assert.ok(m, `${selector} rule exists`); return m[1]; };
  const z = body => Number(body.match(/z-index:\s*(\d+)/)?.[1]);
  const mini = z(rule('.vam-tools-mini'));
  assert.ok(z(rule('.vam-goal-host')) > z(rule('.vam-map-chat.is-overlay')), 'the host is above the overlay chat window (12)');
  assert.ok(z(rule('.vam-goal-host')) > z(rule('.vam-hover-card')), 'and the hover card (10)');
  assert.match(rule('.vam-goal-host'), /position: relative/); assert.match(rule('.vam-goal-host'), /overflow: visible/); assert.match(rule('.vam-goal-host'), /container: vam-goal-host \/ inline-size/);
  assert.equal((css.match(/z-index: 20;/g) ?? []).length >= 1 && css.split('\n').filter(l => /^\.vam-goal[\w-]*[^{]*\{[^}]*z-index/.test(l)).length, 1, 'the host rule is the only goal rule with a z-index');
  assert.ok(z(rule('.vam-map-tools.has-panel')) > mini, 'the tool group with a panel is above .vam-tools-mini');
  assert.doesNotMatch(css, /--vam-goal-inset/, 'the chat inset is gone');
  assert.doesNotMatch(css, /\.vam-goal-bar\.has-attachment \{/, 'the bar-raising rule (z-index 4) is gone; has-attachment only shows the icons');
  assert.match(rule('.vam-goal-context'), /position: absolute/); assert.doesNotMatch(css, /\.vam-relevance-panel|\.vam-relevance-setup|\.vam-relevance-goal-input|\.vam-relevance-pins-row|\.vam-relevance-unpin-all/, 'the old panel rules are gone');
  assert.match(rule('.vam-goal-suggest'), /max-height:\s*var\(--vam-goal-attach-max, none\)/);
  assert.match(rule('.vam-map-sources-panel'), /max-height:\s*var\(--vam-sources-max, none\)/);
  assert.match(rule('.vam-map-sources-panel'), /overflow-y:\s*auto/);
  // Children of the attachment never outrank layers outside the host: its stacking context decides, so no z-index inside it.
  for (const cls of ['vam-goal-context', 'vam-goal-suggest']) assert.doesNotMatch(rule(`.${cls}`), /z-index/, `.${cls} sets no z-index of its own`);
  // Only .vam-goal-attachment places a panel under the goal; the panels set no top of their own.
  for (const cls of ['vam-goal-context', 'vam-goal-suggest']) assert.doesNotMatch(rule(`.${cls}`), /(^|[\s;])top:/, `.${cls} sets no top (.vam-goal-attachment does)`);
  assert.match(rule('.vam-map-tools'), /--vam-tools-max: 100%; max-width: min\(calc\(100% - 24px\), var\(--vam-tools-max\)\)/, 'the tool group is capped by --vam-tools-max (default: no cap), which the view sets when the icons float over its row');
  assert.match(rule('.vam-goal-attachment'), /top: calc\(100% \+ 6px \+ var\(--vam-goal-attach-clear, 0px\)\)/);
  // The narrow layout: the attachment's side margins and the icons kept shown while a panel is open, without any z-index.
  const narrowBlock = css.match(/@container vam-goal-host \(max-width: 600px\) \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(narrowBlock, 'the narrow container block exists');
  assert.match(narrowBlock, /\.vam-goal-bar \.vam-goal-attachment \{ left: 8px; right: 8px; \}/);
  const HS = String.raw`\.view-header\.vam-goal-host `;
  assert.match(narrowBlock, new RegExp(HS + String.raw`\.vam-goal-bar\.has-attachment \.vam-goal-actions \{ opacity: 1; pointer-events: auto; \}`));
  assert.match(narrowBlock, new RegExp(HS + String.raw`\.vam-goal-actions\.is-vacant \{ display: none; \}`), 'narrow header row: an empty slot is not drawn (no empty box floats under the goal)');
  assert.match(narrowBlock, new RegExp(HS + String.raw`\.vam-goal-bar\.is-editing \.vam-goal-actions \{ width: auto; \}`), 'narrow header row: the editing slot is as wide as its content');
  assert.match(narrowBlock, new RegExp(HS + String.raw`\.vam-goal-bar:focus-within \.vam-goal-actions \{ opacity: 0; pointer-events: none; \}`), 'narrow header row: the focus a mouse click leaves does not show the icons');
  assert.match(narrowBlock, new RegExp(HS + String.raw`\.vam-goal-bar:hover \.vam-goal-actions, ` + HS + String.raw`\.vam-goal-bar:has\(:focus-visible\) \.vam-goal-actions \{ opacity: 1; pointer-events: auto; \}`));
  // The toolbar fallback keeps the bar's slot at every width: no rule in the narrow block that touches the icons, their slot or the strip may reach it, so every such rule is scoped to the header row.
  for (const line of narrowBlock.split('\n')) { const [selectors, body] = line.split('{'); if (body === undefined || !/vam-goal-actions|::after/.test(selectors)) continue; for (const sel of selectors.split(',')) assert.ok(sel.trim().startsWith('.view-header.vam-goal-host '), `narrow rule not scoped to the header row: ${sel.trim()}`); }
  assert.match(rule('.vam-toolbar > .vam-goal-bar'), /flex-basis: 280px/);
  for (const m of css.matchAll(/([^{}]*has-attachment[^{}]*)\{([^{}]*)\}/g)) assert.doesNotMatch(m[2], /z-index/, `${m[1].trim()} sets no z-index (display only)`);
  assert.doesNotMatch(css, /!important/);
});

test('goal stack: the strip is left out where a clickable lies in the gap between the goal and the floating icons (header row)', async () => {
  const plain = await stackRig(360, 0, { name: 'plain', goalHover: true }, HOSTS[0]);
  assert.equal(px(plain.bar.style['--vam-goal-bridge-top']) !== null, true, 'without a clickable in the gap the strip is written');
  const blocked = await stackRig(360, 0, { name: 'button in the gap', goalHover: true, gapButton: true }, HOSTS[0]);
  assert.equal(blocked.floating, true);
  assert.equal(px(blocked.bar.style['--vam-goal-bridge-top']), null, 'a button in the gap: no strip over it');
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

