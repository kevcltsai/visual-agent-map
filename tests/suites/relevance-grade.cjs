// Phase 3 on the real view and repository: goal chip, AI grading run, status bar, change summary and undo.
// The AI is a fake behind the real RelevanceGradeService (strict parser included); the DOM is tests/support-dom.cjs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, integrationTest, root: projectRoot, load, core, DEFAULT_SETTINGS, node, map, fixture, withExpansionCoordinator, deferred, obsidian } = require('../support.cjs');
// A goal save that follows a press or Tab waits on a 0 ms timer, which a loop of setImmediate turns can outrun on a fast machine; wait on real timers.
const until = async predicate => { for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 2)); } throw new Error('condition not reached'); };
const dom = require('../support-dom.cjs');
const { hasCls, element, find, findAll, button, tick } = dom;

const MAP = 'Agent Workspace/Topics/map-a/Map.md';
const tierFor = title => ({ Body: 'core', Mind: 'support', REM: 'side', Dreams: 'support', Extra: 'support' })[title] ?? 'support';
// The default fake AI: a valid grade for every gradable card (tier only: a grade carries no reason).
// The model speaks position ids (c1..cN in map order), never UUIDs.
const labelOf = (request, id) => `c${request.nodes.findIndex(n => n.id === id) + 1}`;
const nodeOfLabel = (request, label) => request.nodes[Number(label.slice(1)) - 1];
const gradeAll = (request, pick = tierFor) => ({ items: request.nodes.filter(n => n.parentId !== null).map(n => ({ id: labelOf(request, n.id), tier: pick(n.title) })) });

const recalibrateNew = request => ({ changes: request.nodes.filter(n => n.parentId !== null && !request.previous.some(p => p.id === n.id) && !(request.pins ?? []).some(p => p.id === n.id)).map(n => ({ id: labelOf(request, n.id), tier: tierFor(n.title), anchor: null })) });

async function harness({ language = 'en', mapTitle = 'Sleep map' } = {}) {
  const { repo, app, contents } = fixture(language);
  const settings = { ...DEFAULT_SETTINGS, language, cliModel: 'gpt-6-luna' };
  repo.settings = settings;
  const mapDoc = { id: 'map-a', title: mapTitle, version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  await repo.ensureTopicFolders('Agent Workspace/Topics/map-a');
  const ids = {};
  const add = async (key, title, parent) => {
    const created = await repo.createNote(title, 'gpt-6-luna', mapDoc, MAP, parent ? 'inherited' : 'workspace');
    Object.assign(created, { parentId: parent ? ids[parent] : null, x: parent ? 400 : 80, y: 80 + mapDoc.nodes.length * 200 });
    mapDoc.nodes.push(created); ids[key] = created.id;
    return created;
  };
  await add('root', 'Sleep'); await add('a', 'Body', 'root'); await add('b', 'Mind', 'root'); await add('c', 'REM', 'a'); await add('d', 'Dreams', 'b');
  await app.vault.create(MAP, core.serializeMap(mapDoc));
  await repo.rebuildDerivedData();
  const notices = [], opened = [], menus = [], tips = new Map();
  // Records each menu (items with title, checked state and click handler, separators) and each tooltip.
  class Menu { constructor() { this.items = []; menus.push(this); } addItem(cb) { const it = { separator: false }; this.items.push(it); cb({ setTitle(v) { it.title = v; return this; }, setChecked(v) { it.checked = v; return this; }, setIcon(v) { it.icon = v; return this; }, setWarning() { return this; }, onClick(fn) { it.click = fn; return this; } }); return this; } addSeparator() { this.items.push({ separator: true }); return this; } showAtPosition(pos) { this.pos = pos; return this; } }
  const Base = dom.makeModal();
  class Modal extends Base { open() { opened.push(this); super.open(); } }
  const ctx = {};
  // A recalibrate answers with the cards that have no tier yet (none, once the map is graded).
  const control = { decline: false, calls: [], reply: async (request, _signal, prepared) => prepared.step.id.startsWith('relevance-recalibrate') ? recalibrateNew(request) : gradeAll(request), usageAsks: 0, prewarms: [], releases: 0, intervals: [] };
  const plugin = withExpansionCoordinator({
    repo, settings, running: new Set(), abortChartJobs: () => {}, addChartsAfterWrite: () => {}, logs: { appendLog() {} }, rebuildDerivedData: () => repo.rebuildDerivedData(), relevanceGrades: new Map(), releaseOutline() {},
    // Like the real mutate: after the work the view synchronizes, which repaints only when a note changed.
    mutate: async work => {
      await work();
      const view = ctx.view; if (!view) return;
      const before = JSON.stringify(Array.from(view.notes));
      await view.hydrate();
      if (before !== JSON.stringify(Array.from(view.notes))) view.render();
    },
    runMutation(work) { this.mutate(work).catch(() => {}); },
    usageNoticePending: () => !!control.confirmGate,
    prewarmClaudeStep: (...args) => control.prewarms.push(args), releaseWarmClaude: () => { control.releases++; },
    confirmAiUsage: async (_model, run) => { control.usageAsks++; if (control.confirmGate) await control.confirmGate; if (control.decline) return false; await run(); return true; }
  });
  const { VisualAgentMapView } = load('main.ts', { obsidian: { ...obsidian, Modal, Notice: class { constructor(m) { notices.push(m); } }, Menu, setTooltip(el, text) { tips.set(el, text); } } }, { setInterval: fn => { control.intervals.push(fn); return control.intervals.length; }, clearInterval: () => {}, createSvg: tag => ({ tag, attrs: {}, children: [], setAttribute(n, v) { this.attrs[n] = v; }, appendChild(c) { this.children.push(c); } }) });
  const gradeModule = load('core/relevance-grade-service.ts');
  const { RelevanceGradeService } = gradeModule;
  plugin.relevanceGrade = new RelevanceGradeService(async (request, signal, prepared, onJson) => {
    control.calls.push({ request, signal, step: prepared.step.id, prompt: prepared.prompt, onJson });
    const out = await control.reply(request, signal, prepared);
    return typeof out === 'string' ? out : JSON.stringify(out);
  });
  const view = new VisualAgentMapView({ app }, plugin);
  ctx.view = view;
  const rootEl = element('div');
  const reload = async () => {
    view.notes = new Map(await Promise.all(view.map.nodes.map(async n => [n.id, await repo.readNote(n.path)])));
    ({ goal: view.relevanceGoal, context: view.relevanceContext } = await repo.readRelevanceSetup(MAP));
  };
  view.path = MAP; view.map = await repo.readMap(MAP); view.contentEl = rootEl; view.focusNode = () => {}; view.hydrate = reload;
  let renders = 0;
  view.render = () => { renders++; view.paintCount++; rootEl.empty(); view.renderRelevanceStatus(rootEl); view.renderGoalBar(rootEl); };
  await reload(); view.render();
  const cards = new Map(view.map.nodes.map(n => [n.id, element('div', 'vam-node')]));
  for (const [id, card] of cards) view.cardEls.set(id, card);
  const h = {
    repo, app, contents, view, plugin, ids, gradeModule, control, notices, opened, cards, rootEl, menus, tips,
    renders: () => renders,
    chip: () => find(rootEl, i => hasCls(i, 'vam-goal-text')),
    goalBar: () => find(rootEl, i => hasCls(i, 'vam-goal-bar')),
    icons: () => findAll(rootEl, i => i.tag === 'button' && hasCls(i, 'vam-goal-icon')),
    icon: label => findAll(rootEl, i => i.tag === 'button' && hasCls(i, 'vam-goal-icon')).find(b => b.attrs['aria-label'] === label),
    input: () => find(rootEl, i => i.tag === 'textarea' && hasCls(i, 'vam-goal-input')),
    bar: () => find(rootEl, i => hasCls(i, 'vam-relevance-statusbar')),
    barText: () => find(h.bar(), i => hasCls(i, 'vam-aim-status-value')).text,
    barButtons: () => findAll(h.bar() ?? element('div'), i => i.tag === 'button').map(b => b.text || b.attrs['aria-label']),
    run: () => plugin.relevanceGrades.get(MAP),
    note: key => repo.readNote(view.map.nodes.find(n => n.id === ids[key]).path),
    relevanceOf: async key => { const n = await h.note(key); return n.relevance?.tier; },
    allRelevance: async () => Object.fromEntries(await Promise.all(Object.keys(ids).map(async key => [key, await h.relevanceOf(key)]))),
    // Click the goal chip, type, press Enter: the keyboard path.
    enter: async (goal, key = 'Enter') => {
      h.chip().click();
      const input = h.input(); assert.ok(input, 'the chip swaps in a text field');
      input.value = goal; input.fire('keydown', { key }); await tick();
    },
    settled: () => until(() => h.run() && h.run().status !== 'running'),
    saved: async () => (await repo.readMap(MAP)).nodes
  };
  return h;
}
// The accessible name of an element named through aria-labelledby (the goal bar uses hidden labels: aria-label would show as a tooltip).
const nameOf = (h, el) => find(h.rootEl, i => i.attrs.id === el.attrs['aria-labelledby'])?.text;
// The recalibrate / grade icon: the second one.
const refreshIcon = h => h.icons()[1];
const frontmatterOf = h => h.contents.get(MAP).match(/^---\n([\s\S]*?)\n---/)[1];
// The Undo button pops the history entry first and restores notes afterwards, so wait for the work as well.
const afterTravel = async h => { await until(() => h.view.history.canRedo); for (let i = 0; i < 12; i++) await tick(); };
const graded = async h => Object.values(await h.allRelevance()).filter(Boolean);

integrationTest('relevance: Prioritize by goal -> field -> Enter writes the goal and its first history entry, grades every non-top card and shows the result', async () => {
  const h = await harness();
  assert.equal(h.chip().text, 'What do you want to achieve with this map?'); assert.ok(hasCls(h.goalBar(), 'is-empty')); assert.equal(h.bar(), undefined, 'no status bar before any run');
  h.chip().click();
  const input = h.input();
  assert.equal(nameOf(h, input), 'Map goal'); assert.equal(input.focused, true); assert.equal(h.chip(), undefined, 'the goal text becomes the field in the same place; there is no panel and no key hint');
  input.value = 'Sleep better\nthrough the night'; input.fire('keydown', { key: 'Enter' });
  assert.equal(h.run().status, 'running'); assert.ok(h.icons().length === 3 && h.icons().every(b => b.disabled), 'the three goal icons are disabled while grading');
  assert.equal(h.bar().attrs['aria-live'], 'polite'); assert.equal(h.barText(), 'Grading by goal…'); assert.deepEqual(h.barButtons(), ['Stop']);
  await h.settled();
  assert.equal(await h.repo.readRelevanceGoal(MAP), 'Sleep better through the night', 'newlines are removed');
  assert.match(frontmatterOf(h), /relevance-goal-history:\n  - "\d{4}-\d{2}-\d{2}: Sleep better through the night"/);
  const request = h.control.calls[0].request;
  assert.equal(request.goal, 'Sleep better through the night'); assert.equal(request.language, 'en'); assert.equal('contentLanguage' in request, false, 'the grade has no output language');
  assert.equal(request.nodes.length, 5, 'the whole map is sent, the top-level card as context');
  assert.deepEqual(Object.keys(request.nodes[0]).sort(), ['depth', 'id', 'parentId', 'status', 'summary', 'title']);
  const all = await h.allRelevance();
  assert.equal(all.root, undefined, 'the top-level card is never graded');
  for (const key of ['a', 'b', 'c', 'd']) assert.ok(['core', 'support', 'side'].includes(all[key]));
  assert.equal(all.c, 'side');
  for (const key of ['a', 'b', 'c', 'd']) assert.doesNotMatch(rawNote(h, key), /relevance-reason/, 'no reason is written');
  assert.equal(h.view.notes.get(h.ids.a).relevance.tier, 'core', 'the view reads the new grade');
  assert.equal(h.barText(), 'Graded 4 topics, 4 changed (0 skipped)');
  assert.deepEqual(h.barButtons(), ['View changes', 'Undo', 'Dismiss']);
  assert.equal(h.chip().text, 'Sleep better through the night'); assert.equal(h.icon('Sort by relevance').disabled, false);
  assert.equal(h.control.usageAsks, 1);
  assert.equal(h.view.history.past.length, 2, 'goal and grading are two undo steps');
});

integrationTest('relevance: the prompt names no output language whatever the map or interface language is (no reason is asked for)', async () => {
  const h = await harness({ language: 'en', mapTitle: '要如何在陽台養香草' });
  await h.enter('養出香草'); await h.settled();
  assert.equal(h.control.calls[0].request.language, 'en'); assert.equal('contentLanguage' in h.control.calls[0].request, false);
  const prompt = load('core/relevance-grade-service.ts').buildRelevanceGradePrompt(h.control.calls[0].request);
  assert.doesNotMatch(prompt, /繁體中文|Write the reasons|reason/i);
});

integrationTest('relevance: changing the goal appends history and regrades; the summary lists only cards whose tier changed', async () => {
  const h = await harness();
  await h.enter('First goal'); await h.settled();
  // Second run: Body and Mind keep their tier, REM changes tier; Dreams keeps its tier too (a reason no longer counts).
  h.control.reply = async request => ({ items: request.nodes.filter(n => n.parentId !== null).map(n => {
    if (n.title === 'Body') return { id: labelOf(request, n.id), tier: 'core' };
    if (n.title === 'Mind') return { id: labelOf(request, n.id), tier: 'support' };
    if (n.title === 'REM') return { id: labelOf(request, n.id), tier: 'core' };
    return { id: labelOf(request, n.id), tier: 'support' };
  }) });
  await h.enter('Second goal'); await h.settled();
  assert.match(h.contents.get(MAP), /- "[\d-]+: First goal"\n  - "[\d-]+: Second goal"/);
  assert.equal(h.contents.get(MAP).match(/^  - "/gm).length, 2, 'both goals are in the history');
  assert.equal(h.barText(), 'Graded 4 topics, 1 changed (0 skipped)');
  button(h.bar(), 'View changes').click();
  const modal = h.opened.at(-1);
  assert.equal(modal.titleEl.text, 'Relevance changes'); assert.ok(button(modal.modalEl, 'Close').focused, 'focus starts on Close');
  const rows = findAll(modal.contentEl, i => hasCls(i, 'vam-relevance-change'));
  assert.deepEqual(rows.map(r => find(r, i => hasCls(i, 'vam-relevance-change-title')).text), ['REM']);
  const tagTexts = row => findAll(row, i => hasCls(i, 'vam-relevance-tag')).map(tag => tag.children[1].text);
  assert.deepEqual(tagTexts(rows[0]), ['Skippable', 'Must learn']);
  assert.equal(findAll(modal.contentEl, i => hasCls(i, 'vam-relevance-change-reason')).length, 0, 'the summary has no reason line');
  assert.equal(find(rows[0], i => hasCls(i, 'vam-relevance-arrow')).attrs['aria-label'], 'changed to');
  assert.equal(find(modal.contentEl, i => i.tag === 'ul').attrs['aria-label'], 'Relevance changes');
  assert.deepEqual([...h.cards].filter(([, card]) => hasCls(card, 'vam-structure-suggested')).map(([id]) => id).sort(), [h.ids.c].sort(), 'changed cards are marked');
  modal.close();
  assert.equal([...h.cards.values()].filter(card => hasCls(card, 'vam-structure-suggested')).length, 0, 'closing clears the marks');
});

integrationTest('relevance: a first grade shows "Not graded" as the old tag; Enter on an unchanged setup asks nothing (decision #2), the recalibrate icon recalibrates with no history entry and nothing to change', async () => {
  const h = await harness();
  await h.enter('Goal'); await h.settled();
  button(h.bar(), 'View changes').click();
  assert.equal(find(h.opened.at(-1).contentEl, i => hasCls(i, 'vam-relevance-ungraded')).text, 'Not graded');
  await h.enter('Goal'); await tick(); await tick();
  assert.equal(h.control.calls.length, 1, 'the same text again: Enter does not grade, the recalibrate icon does'); assert.equal(h.control.usageAsks, 1);
  refreshIcon(h).click(); await h.settled();
  assert.equal(h.control.calls.length, 2, 'asked again');
  assert.equal(h.control.calls[1].step, 'relevance-recalibrate', 'same goal, level and context after an AI grade: recalibrate, not a full grade');
  assert.equal(h.control.calls[1].request.previous.length, 4, 'the current AI tiers are sent');
  assert.equal(h.contents.get(MAP).match(/^  - "/gm).length, 1, 'no new history entry');
  assert.equal(h.view.history.past.length, 2, 'no new goal undo step either');
  assert.equal(h.barText(), 'No topics needed adjusting'); assert.deepEqual(h.barButtons(), ['Dismiss']);
});

integrationTest('relevance: one undo restores every graded note (absent before means removed); the goal is a separate undo step', async () => {
  const h = await harness();
  await h.repo.writeRelevance(h.view.map.nodes.find(n => n.id === h.ids.a).path, { tier: 'side' });
  await h.view.hydrate();
  const before = await h.allRelevance();
  await h.enter('Goal'); await h.settled();
  assert.notDeepEqual(await h.allRelevance(), before);
  assert.ok(h.barButtons().includes('Undo'));
  button(h.bar(), 'Undo').click(); await afterTravel(h);
  assert.deepEqual(await h.allRelevance(), before, 'a single undo puts back every previous value');
  assert.equal(await h.repo.readRelevanceGoal(MAP), 'Goal', 'the goal is its own undo step and stays');
  assert.equal(h.barButtons().includes('Undo'), false, 'Undo is only offered while the grading is the latest step');
  await h.view.travel(false);
  assert.equal(await h.repo.readRelevanceGoal(MAP), undefined, 'the second undo removes the goal');
  assert.doesNotMatch(h.contents.get(MAP), /relevance-goal/);
  await h.view.travel(true); await h.view.travel(true);
  assert.equal(await h.repo.readRelevanceGoal(MAP), 'Goal'); assert.equal(await h.relevanceOf('c'), 'side', 'redo grades again');
});

integrationTest('relevance: undo and redo never overwrite a note the owner edited after grading; they say how many were left', async () => {
  const h = await harness();
  await h.enter('Goal'); await h.settled();
  const afterGrading = await h.allRelevance();
  const dreams = h.view.map.nodes.find(n => n.id === h.ids.d);
  await h.repo.writeRelevance(dreams.path, { tier: 'side' });
  button(h.bar(), 'Undo').click(); await afterTravel(h);
  assert.equal(await h.relevanceOf('d'), 'side', 'the owner edit stays');
  assert.equal(await h.relevanceOf('a'), undefined); assert.equal(await h.relevanceOf('c'), undefined, 'the untouched notes are put back');
  assert.deepEqual(h.notices, ['1 topics were edited after grading and were left as they are.']);
  h.notices.length = 0;
  await h.view.travel(true);
  assert.equal(await h.relevanceOf('d'), 'side', 'redo leaves it alone too');
  assert.deepEqual(await h.relevanceOf('a'), afterGrading.a);
  assert.equal(h.notices.length, 1);
});

integrationTest('relevance: Stop aborts the call, writes no note, keeps the goal and says so; a late reply is dropped', async () => {
  const h = await harness();
  const gate = deferred(); h.control.reply = request => gate.promise.then(() => gradeAll(request));
  await h.enter('Goal'); await until(() => h.control.calls.length);
  assert.equal(h.run().status, 'running');
  button(h.bar(), 'Stop').click();
  assert.equal(h.control.calls[0].signal.aborted, true); assert.equal(h.run().status, 'stopped');
  assert.equal(h.barText(), 'Grading stopped. No topic was changed.'); assert.deepEqual(h.barButtons(), ['Dismiss']);
  gate.resolve(); await tick(); await tick(); await tick();
  assert.deepEqual(await graded(h), [], 'the late result writes nothing');
  assert.equal(h.run().status, 'stopped', 'and does not reopen the status');
  assert.equal(await h.repo.readRelevanceGoal(MAP), 'Goal', 'the confirmed goal is kept');
  assert.equal(h.view.history.past.length, 1, 'only the goal step');
  find(h.bar(), i => i.attrs['aria-label'] === 'Dismiss').click();
  assert.equal(h.bar(), undefined, 'the status can be dismissed'); assert.equal(h.chip().text, 'Goal');
});

integrationTest('relevance: while the AI usage confirmation is pending the bar says so, not "grading", the map stays locked, the chip is disabled and a second submit is refused', async () => {
  const h = await harness();
  const gate = deferred();
  h.control.confirmGate = gate.promise;
  await h.enter('Goal'); await until(() => h.control.usageAsks === 1);
  assert.equal(h.run().status, 'running', 'the map is locked during the wait');
  assert.equal(h.barText(), 'Waiting for AI usage confirmation…');
  assert.notEqual(h.barText(), 'Grading by goal…');
  assert.equal(h.control.calls.length, 0, 'nothing is sent while waiting');
  assert.ok(h.icons().every(b => b.disabled), 'the icons are disabled during the wait');
  await h.view.submitRelevanceGoal('Another goal'); await tick();
  assert.equal(h.control.usageAsks, 1, 'a second submit is refused while the confirmation is pending');
  assert.equal(h.run().goal, 'Goal');
  gate.resolve(); await h.settled();
  assert.equal(h.run().status, 'done');
});

integrationTest('relevance: a reply that is not exactly one valid grade per card writes nothing and the bar names the problem', async () => {
  const cases = {
    'not JSON': () => 'sorry, I cannot',
    'a missing card': r => { const o = gradeAll(r); o.items.pop(); return o; },
    'a duplicate card': r => { const o = gradeAll(r); o.items.push(o.items[0]); return o; },
    'an unknown card': r => { const o = gradeAll(r); o.items.push({ id: 'ghost', tier: 'core' }); return o; },
    'the top-level card': r => { const o = gradeAll(r); o.items.push({ id: 'c1', tier: 'core' }); return o; },
    'a bad tier': r => { const o = gradeAll(r); o.items[0].tier = 'must'; return o; },
    'a reason key': r => { const o = gradeAll(r); o.items[0].reason = 'Because.'; return o; },
    'an extra key': r => { const o = gradeAll(r); o.items[0].title = 'x'; return o; },
    'an extra top-level key': r => ({ ...gradeAll(r), goal: 'x' }),
    'a child above its parent': r => { const o = gradeAll(r); o.items.find(i => nodeOfLabel(r, i.id).title === 'Dreams').tier = 'core'; return o; }
  };
  for (const [name, reply] of Object.entries(cases)) {
    const h = await harness();
    h.control.reply = async request => reply(request);
    await h.enter('Goal'); await h.settled();
    assert.equal(h.run().status, 'failed', name);
    // A hierarchy-only failure that survives both repair rounds shows a plain message instead of card ids.
    if (name === 'a child above its parent') assert.equal(h.barText(), "Grading failed. No topic was changed. The AI's parent-child tiers were still inconsistent. Click Recalibrate next to the goal to try again.", name);
    else assert.match(h.barText(), /^Grading failed\. No topic was changed\. The AI grading could not be used: /, name);
    assert.deepEqual(await graded(h), [], `${name}: no note written`);
    assert.deepEqual(h.barButtons(), ['Dismiss'], name);
    assert.equal(h.view.history.past.length, 1, `${name}: only the goal step`);
  }
});

integrationTest('relevance: a provider error or an over-budget map writes nothing and shows the reason', async () => {
  const { RelevanceGradeError } = load('core/relevance-grade-service.ts');
  const h = await harness();
  h.control.reply = async () => { throw new RelevanceGradeError('over_budget', 'The map is too large to grade at once. Nothing was changed.'); };
  await h.enter('Goal'); await h.settled();
  assert.equal(h.barText(), 'Grading failed. No topic was changed. The map is too large to grade at once. Nothing was changed.');
  assert.deepEqual(await graded(h), []);
  h.control.reply = async () => { throw new Error('provider exploded'); };
  await h.enter('Goal two'); await h.settled();
  assert.equal(h.barText(), 'Grading failed. No topic was changed. provider exploded');
  assert.deepEqual(await graded(h), []);
});

integrationTest('relevance: declining the AI usage notice keeps the goal, calls no AI and writes no note', async () => {
  const h = await harness();
  h.control.decline = true;
  await h.enter('Goal'); await h.settled();
  assert.equal(h.control.calls.length, 0); assert.equal(h.run().status, 'declined');
  assert.equal(h.barText(), 'Grading did not start. The goal was saved; no topic was changed.');
  assert.equal(await h.repo.readRelevanceGoal(MAP), 'Goal'); assert.deepEqual(await graded(h), []);
  assert.equal(h.icon('Sort by relevance').disabled, false, 'the icons can be used again');
});

integrationTest('relevance: closing the view or leaving the map while grading aborts the call; the late result is never written', async () => {
  for (const how of ['close', 'switch']) {
    const h = await harness();
    const gate = deferred(); h.control.reply = request => gate.promise.then(() => gradeAll(request));
    await h.enter('Goal'); await until(() => h.control.calls.length);
    if (how === 'close') await h.view.onClose(); else h.view.abortRelevanceGrade();
    assert.equal(h.control.calls[0].signal.aborted, true, how);
    assert.equal(h.plugin.relevanceGrades.has(MAP), false, `${how}: the run is forgotten`);
    gate.resolve(); await tick(); await tick(); await tick();
    assert.deepEqual(await graded(h), [], `${how}: nothing written`);
  }
});

integrationTest('relevance: a result for a map the view has since left is dropped even when nothing aborted it', async () => {
  const h = await harness();
  const gate = deferred(); h.control.reply = request => gate.promise.then(() => gradeAll(request));
  await h.enter('Goal'); await until(() => h.control.calls.length);
  h.view.path = 'Agent Workspace/Topics/other/Map.md';
  gate.resolve(); await tick(); await tick(); await tick();
  assert.deepEqual(await graded(h), []);
});

integrationTest('relevance: a card deleted, renamed or moved while the AI worked is skipped and counted; a card added meanwhile stays ungraded', async () => {
  const h = await harness();
  const gate = deferred(); h.control.reply = request => gate.promise.then(() => gradeAll(request));
  await h.repo.writeRelevance(h.view.map.nodes.find(n => n.id === h.ids.c).path, { tier: 'core' });
  await h.enter('Goal'); await until(() => h.control.calls.length);
  // While the AI works: Mind is renamed, REM is moved under Mind, Dreams is deleted, and a new card appears under Body.
  const mind = h.view.map.nodes.find(n => n.id === h.ids.b);
  await h.repo.updateNote(mind.path, { title: 'Mind renamed' });
  h.view.map.nodes.find(n => n.id === h.ids.c).parentId = h.ids.b;
  h.view.map.nodes = h.view.map.nodes.filter(n => n.id !== h.ids.d);
  const doc = { id: 'map-a', title: 'Sleep map', version: 1, nodes: h.view.map.nodes, viewport: { x: 0, y: 0, zoom: 1 } };
  const extra = await h.repo.createNote('Extra', 'gpt-6-luna', doc, MAP, 'inherited');
  Object.assign(extra, { parentId: h.ids.a, x: 400, y: 900 }); h.view.map.nodes.push(extra);
  gate.resolve(); await h.settled();
  assert.equal(h.barText(), 'Graded 1 topics, 1 changed (3 skipped)');
  assert.equal(await h.relevanceOf('a'), 'core');
  assert.equal(await h.relevanceOf('b'), undefined, 'renamed: skipped'); assert.equal(await h.relevanceOf('c'), 'core', 'moved: the old grade stays');
  assert.equal((await h.repo.readNote(extra.path)).relevance, undefined, 'added later: ungraded');
  // The in-memory edits above stand for changes that were saved; Undo now checks Map.md like every other change.
  await h.repo.saveMap(MAP, h.view.map);
  button(h.bar(), 'Undo').click(); await afterTravel(h);
  assert.equal(await h.relevanceOf('a'), undefined);
});

integrationTest('relevance: if one note cannot be written the others are, the bar counts the failure, and undo covers only what was written', async () => {
  const h = await harness();
  const real = h.repo.writeRelevance.bind(h.repo);
  const failing = h.view.map.nodes.find(n => n.id === h.ids.b).path;
  h.repo.writeRelevance = async (p, value) => { if (p === failing && value) throw new Error('disk full'); return real(p, value); };
  await h.enter('Goal'); await h.settled();
  assert.equal(h.barText(), 'Graded 3 topics, 3 changed (0 skipped) 1 could not be saved.');
  assert.equal(await h.relevanceOf('b'), undefined); assert.equal(h.run().outcome.changes.length, 3);
  button(h.bar(), 'Undo').click(); await afterTravel(h);
  assert.deepEqual(await graded(h), []);
});

integrationTest('relevance: only one run per map; a second Enter, or a second view of the same map, cannot start another', async () => {
  const h = await harness();
  const gate = deferred(); h.control.reply = request => gate.promise.then(() => gradeAll(request));
  await h.enter('Goal'); await until(() => h.control.calls.length);
  await h.view.submitRelevanceGoal('Another');
  const { VisualAgentMapView } = load('main.ts', { obsidian: { ...obsidian, setTooltip() {} } });
  const other = new VisualAgentMapView({ app: h.app }, h.plugin); Object.assign(other, { path: MAP, map: h.view.map, render() {} });
  await other.submitRelevanceGoal('Third');
  assert.equal(h.control.calls.length, 1); assert.equal(await h.repo.readRelevanceGoal(MAP), 'Goal');
  gate.resolve(); await h.settled();
});

integrationTest('relevance: Esc cancels and returns focus to the goal text, an empty Enter never reaches the AI, and focus events never cancel or save', async () => {
  const h = await harness();
  h.chip().click(); h.input().value = 'ignored'; h.input().fire('keydown', { key: 'Escape' }); await tick();
  assert.equal(h.input(), undefined); assert.equal(h.chip().focused, true); assert.equal(h.chip().text, 'What do you want to achieve with this map?');
  h.chip().click(); h.input().value = 'still open'; h.input().fire('focusout', { relatedTarget: element('button') }); h.input().fire('blur', { relatedTarget: null }); await tick();
  assert.equal(h.input().value, 'still open', 'leaving the field with the keyboard is not an exit'); assert.equal(h.control.calls.length, 0);
  h.input().value = '   '; h.input().fire('keydown', { key: 'Enter' }); await tick();
  assert.equal(h.input(), undefined, 'the field closes'); assert.equal(h.chip().focused, true);
  assert.equal(h.control.calls.length, 0); assert.equal(h.control.usageAsks, 0); assert.equal(h.run(), undefined);
  assert.equal(await h.repo.readRelevanceGoal(MAP), undefined, 'no goal written either');
  // A focus event after Enter must not cancel the run that Enter started.
  h.chip().click(); const input = h.input(); input.value = 'Real goal'; input.fire('keydown', { key: 'Enter' }); input.fire('focusout', { relatedTarget: null }); await h.settled();
  assert.equal(h.control.calls.length, 1);
});

integrationTest('relevance: an existing goal prefills the field and the goal is stored at most 200 characters', async () => {
  const h = await harness();
  await h.enter('Existing goal'); await h.settled();
  h.chip().click();
  assert.equal(h.input().value, 'Existing goal'); assert.equal(h.input().maxLength, 200);
  h.input().value = `  ${'x'.repeat(250)}  `; h.input().fire('keydown', { key: 'Enter' }); await h.settled();
  assert.equal((await h.repo.readRelevanceGoal(MAP)).length, 200);
});

integrationTest('relevance: AIM maps have no goal entry and never grade', async () => {
  const h = await harness();
  h.view.map.aim = { runs: [] };
  await h.view.submitRelevanceGoal('Goal'); assert.equal(h.control.calls.length, 0); assert.equal(h.run(), undefined); assert.equal(await h.repo.readRelevanceGoal(MAP), undefined);
  // The goal bar and the status bar sit behind the same guards in the real render: not on an AIM map, not on an empty map.
  const source = fs.readFileSync(path.join(projectRoot, 'experiences/visual-map/view.ts'), 'utf8');
  assert.match(source, /if \(this\.relevanceGradeable\(\) && this\.map\.nodes\.length\) this\.mountGoalBar\(\);/);
  assert.match(source, /private relevanceGradeable\(\): boolean \{\s*return !!this\.map && !this\.map\.aim && !!this\.path;/);
  assert.match(source, /if \(!this\.map\.aim\) this\.renderRelevanceStatus\(this\.contentEl\);/);
});

integrationTest('relevance: grading changes only frontmatter of the graded notes, never a body, and the map structure stays', async () => {
  const h = await harness();
  const bodyOf = text => text.replace(/^---\r?\n[\s\S]*?\r?\n---/, '');
  const updatedOf = text => /updated: (.*)/.exec(text)?.[1];
  const before = new Map(h.view.map.nodes.map(n => [n.id, h.contents.get(n.path)]));
  const mapBefore = JSON.stringify(await h.saved());
  await h.enter('Goal'); await h.settled();
  for (const n of h.view.map.nodes) {
    assert.equal(bodyOf(h.contents.get(n.path)), bodyOf(before.get(n.id)), 'body unchanged');
    assert.equal(updatedOf(h.contents.get(n.path)), updatedOf(before.get(n.id)), '`updated` unchanged');
  }
  assert.equal(h.contents.get(h.view.map.nodes.find(n => n.id === h.ids.root).path), before.get(h.ids.root), 'the top-level note is byte-identical');
  assert.equal(JSON.stringify(await h.saved()), mapBefore, 'the map structure is unchanged');
});

integrationTest('relevance: the suggested-card ring outranks every status rule that sets a box-shadow (idea cards used to hide it)', () => {
  const css = fs.readFileSync(path.join(projectRoot, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  // Class-level specificity: classes, attributes and pseudo-classes (:not(x) counts as x); no ids or elements are used.
  const specificity = selector => (selector.replace(/:not\(/g, ' (').match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/g) ?? []).length;
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => ({ selectors: m[1].split(',').map(s => s.trim()), body: m[2] }));
  const ring = rules.filter(r => r.selectors.some(s => /\.vam-structure-suggested$/.test(s)) && /box-shadow/.test(r.body));
  assert.ok(ring.length, 'a ring rule exists');
  const ringSpec = Math.max(...ring.flatMap(r => r.selectors.filter(s => s.includes('vam-structure-suggested')).map(specificity)));
  const statusRules = rules.filter(r => r.selectors.some(s => /^\.vam-node:not\(\[data-aim-kind\]\)\[data-status=/.test(s)) && /box-shadow/.test(r.body));
  assert.ok(statusRules.some(r => /data-status="idea"/.test(r.selectors[0])), 'the idea rule that hides shadows is found');
  for (const rule of statusRules) assert.ok(ringSpec > Math.max(...rule.selectors.map(specificity)), `ring beats ${rule.selectors[0]}`);
});

integrationTest('relevance: the goal text is named "Goal: <goal>" for assistive tech through a hidden label, and by the placeholder when empty (zh too)', async () => {
  const h = await harness();
  assert.equal(nameOf(h, h.chip()), 'What do you want to achieve with this map?'); assert.equal(h.chip().attrs['aria-label'], undefined);
  await h.enter('Sleep better'); await h.settled();
  assert.equal(nameOf(h, h.chip()), 'Goal: Sleep better'); assert.equal(h.chip().attrs['aria-label'], undefined);
  // The view builds the name from these two keys; each bundle has its own language, so check the zh strings directly.
  const { translate } = load('i18n.ts');
  assert.equal(translate('zh-TW', 'ui.relevance_goal_0', '睡得更好'), '目標：睡得更好');
});

integrationTest('relevance: focus inside the status bar survives a repaint (Stop vanishing on completion, Undo by keyboard) and is never stolen', async () => {
  const h = await harness();
  const doc = { activeElement: null };
  h.rootEl.ownerDocument = doc; h.rootEl.root = doc;
  const focus = el => { el.focus(); doc.activeElement = el; };
  // Re-render the way view.render does: capture before, rebuild, restore after.
  const render = h.view.render;
  h.view.render = () => { const restore = h.view.keepRelevanceBarFocus(); render(); restore(); };
  h.control.reply = async request => { await tick(); return gradeAll(request); };
  h.chip().click(); const input = h.input(); input.value = 'Goal'; input.fire('keydown', { key: 'Enter' });
  assert.deepEqual(h.barButtons(), ['Stop']); focus(h.bar().children.find(c => c.tag === 'button'));
  await h.settled(); await tick(); await tick();
  assert.ok(h.barText().startsWith('Graded'));
  h.view.render();
  assert.equal(doc.activeElement.text, 'View changes', 'focus lands on a button that still exists, not on the page');
  // Undo by keyboard: the bar is repainted without the Undo button.
  focus(button(h.bar(), 'Undo')); button(h.bar(), 'Undo').click(); await afterTravel(h);
  assert.equal(h.barButtons().includes('Undo'), false);
  assert.ok(h.bar().contains(doc.activeElement), 'focus stays in the status bar after Undo');
  // Focus elsewhere is left alone.
  const chip = h.chip(); focus(chip); h.view.render();
  assert.equal(h.bar().contains(doc.activeElement), false, 'a repaint never pulls focus into the bar');
  assert.equal(doc.activeElement, chip);
});

// ---- Phase 4: context in the same inline group ----------------------------------------------------------
// An old map carrying the retired `relevance-level` key (decision 2026-11-05-goal-banner#1: read-but-ignore, never write or delete).
const withOldLevel = (h, value = 'beginner') => { h.contents.set(MAP, h.contents.get(MAP).replace(/^---\n/, `---\nrelevance-level: "${value}"\n`)); };
const contextInput = h => find(h.rootEl, i => i.tag === 'input' && hasCls(i, 'vam-goal-context-input'));
const addContext = h => find(h.rootEl, i => hasCls(i, 'vam-goal-add-context'));
const open = h => { h.chip().click(); return h.input(); };
// Opens the editor (typing `goal` when given, as the "+ Context" chip needs text) and the context row; returns the context field.
const openWithContext = (h, goal) => { const area = open(h); if (goal !== undefined) { area.value = goal; area.fire('input'); } if (!contextInput(h)) addContext(h).click(); return contextInput(h); };

integrationTest('goal bar: the group is named by a hidden label, not aria-label (Obsidian would show that as a tooltip over the whole bar)', async () => {
  const h = await harness();
  const bar = h.goalBar();
  assert.equal(bar.attrs.role, 'group'); assert.equal(bar.attrs['aria-label'], undefined, 'no aria-label on the bar');
  const label = findAll(bar, i => hasCls(i, 'vam-sr-only'))[0];
  assert.ok(label); assert.equal(label.text, 'Map goal'); assert.equal(bar.attrs['aria-labelledby'], label.attrs.id);
});

integrationTest('relevance: editing happens in place: one field replaces the goal text, no dialog, no hint, no button but "+ Context", and the context row opens on request (en)', async () => {
  const h = await harness();
  const area = open(h);
  assert.equal(area.tag, 'textarea'); assert.equal(area.attrs.rows, '1'); assert.equal(area.attrs.dir, 'auto'); assert.equal(area.maxLength, 200);
  assert.equal(area.attrs.placeholder, 'What do you want to achieve with this map?'); assert.equal(nameOf(h, area), 'Map goal');
  assert.equal(h.chip(), undefined, 'the shown goal is replaced by the field, not kept beside it');
  assert.equal(findAll(h.rootEl, i => i.attrs.role === 'dialog').length, 0, 'no dialog'); assert.equal(h.goalBar().attrs.role, 'group');
  assert.equal(h.icons().length, 0, 'no icons are drawn while editing'); assert.equal(contextInput(h), undefined, 'the context row is closed until asked for');
  assert.deepEqual(findAll(h.goalBar(), i => i.tag === 'button').map(b => b.text), ['+ Context'], 'the only button is "+ Context"');
  assert.equal(addContext(h).attrs['aria-expanded'], 'false');
  const slot = () => find(h.goalBar(), i => hasCls(i, 'vam-goal-actions'));
  assert.ok(hasCls(slot(), 'is-vacant'), 'no text yet: nothing on offer, the slot stays');
  area.value = 'Grow herbs'; area.fire('input'); assert.ok(!hasCls(slot(), 'is-vacant'), 'text: "+ Context" is on offer');
  addContext(h).click();
  assert.equal(addContext(h), undefined, 'the chip is replaced by the row');
  const row = contextInput(h);
  assert.equal(row.attrs.placeholder, 'Optional: what you already know, conditions or limits'); assert.equal(nameOf(h, row), 'Extra context'); assert.equal(row.maxLength, 200);
  assert.ok(hasCls(find(h.goalBar(), i => hasCls(i, 'vam-goal-context')), 'vam-goal-attachment'), 'the row is an attachment, not part of the bar');
  assert.equal(row.focused, true, 'the keyboard moves to the context row'); assert.equal(h.input().value, 'Grow herbs', 'the draft survives the redraw');
  assert.equal(findAll(h.goalBar(), i => i.tag === 'input' || i.tag === 'textarea').length, 2, 'exactly two fields: the goal and the context');
  assert.equal(h.control.calls.length, 0);
});

integrationTest('relevance: goal and context are saved in one write, sent to the AI (level null), and are one undo step; grading stays its own step', async () => {
  const h = await harness();
  openWithContext(h, 'Grow herbs').value = '  Half a day\nof sun  ';
  contextInput(h).fire('keydown', { key: 'Enter' }); await h.settled();
  assert.match(frontmatterOf(h), /relevance-goal: "Grow herbs"\nrelevance-context: "Half a day of sun"/);
  assert.doesNotMatch(frontmatterOf(h), /relevance-level/, 'no level key is written');
  const request = h.control.calls[0].request;
  assert.equal(request.goal, 'Grow herbs'); assert.equal(request.level, undefined); assert.equal(request.context, 'Half a day of sun');
  assert.match(load('core/relevance-grade-service.ts').buildRelevanceGradePrompt(request), /Learner level \(JSON string[^\n]*: null\nLearner context \(JSON string, or null\): "Half a day of sun"\n/);
  assert.equal(h.view.history.past.length, 2, 'one setup step plus one grading step');
  assert.equal(h.chip().text, 'Grow herbs'); assert.equal(nameOf(h, h.chip()), 'Goal: Grow herbs');
  const history = h.contents.get(MAP).match(/^  - "/gm); assert.equal(history.length, 1, 'the history records the goal only');
  assert.doesNotMatch(h.contents.get(MAP), /relevance-goal-history:[\s\S]*Half a day/);
  button(h.bar(), 'Undo').click(); await afterTravel(h);
  await h.view.travel(false);
  assert.doesNotMatch(h.contents.get(MAP), /relevance-(goal|level|context)/, 'the second undo removes both keys together');
  await h.view.travel(true);
  assert.match(frontmatterOf(h), /relevance-goal: "Grow herbs"\nrelevance-context: "Half a day of sun"/);
});

integrationTest('relevance: only a context change is one undo step without a new history entry; the same text again asks nothing, the recalibrate icon regrades with no new step', async () => {
  const h = await harness();
  await h.enter('Goal'); await h.settled();
  assert.equal(h.view.history.past.length, 2);
  openWithContext(h).value = 'Half a day'; h.input().fire('keydown', { key: 'Enter' }); await h.settled();
  assert.equal(h.view.history.past.length, 3, 'a context change adds one setup step; the regrade changed no card, so no grading step');
  assert.equal(h.contents.get(MAP).match(/^  - "/gm).length, 1, 'no history entry: the goal is the same');
  assert.equal(h.control.calls.at(-1).request.level, undefined); assert.equal(h.control.calls.at(-1).request.context, 'Half a day');
  open(h); assert.equal(contextInput(h).value, 'Half a day', 'the saved context is shown straight away'); assert.equal(addContext(h), undefined, 'and "+ Context" is not offered');
  h.input().fire('keydown', { key: 'Enter' }); await tick(); await tick();
  assert.equal(h.control.calls.length, 2, 'nothing changed: Enter asks nothing'); assert.equal(h.control.usageAsks, 2); assert.equal(h.input(), undefined, 'and the editor closes');
  refreshIcon(h).click(); await h.settled();
  assert.equal(h.control.calls.length, 3, 'the recalibrate icon regrades'); assert.equal(h.view.history.past.length, 3, 'nothing changed: no setup step, no grading step');
  // Clearing the context removes its key.
  open(h); contextInput(h).value = '   '; h.input().fire('keydown', { key: 'Enter' }); await h.settled();
  assert.doesNotMatch(h.contents.get(MAP), /relevance-context/); assert.equal(h.chip().text, 'Goal');
  assert.equal(h.control.calls.at(-1).request.level, undefined);
});

integrationTest('relevance: Enter in the context field saves; Tab between the fields does not; Tab out of the last field (Shift+Tab out of the first) does, once the browser moved the keyboard; no focus event saves', async () => {
  const h = await harness();
  openWithContext(h, 'Via enter');
  // Tab from the goal to the context row stays inside: nothing is asked, even after the timers ran.
  h.input().fire('keydown', { key: 'Tab' }); h.input().fire('focusin'); await new Promise(r => setTimeout(r, 5));
  assert.ok(h.input() && contextInput(h), 'still open'); assert.equal(h.control.calls.length, 0);
  contextInput(h).fire('keydown', { key: 'Enter' }); await h.settled();
  assert.equal(await h.repo.readRelevanceGoal(MAP), 'Via enter'); assert.equal(h.control.calls.length, 1);
  for (const [name, pick, shiftKey] of [['Tab out of the context row', contextInput, false], ['Shift+Tab out of the goal field', g => g.input(), true]]) {
    const g = await harness();
    openWithContext(g, `Goal for ${name}`);
    const field = pick(g);
    field.fire('keydown', { key: 'Tab', shiftKey });
    assert.equal(g.control.calls.length, 0, `${name}: not at once, the browser moves the keyboard first`);
    await until(() => g.control.calls.length); await g.settled();
    assert.equal(await g.repo.readRelevanceGoal(MAP), `Goal for ${name}`);
  }
});

integrationTest('relevance: Esc cancels from either field, an IME-confirming Enter or Esc is ignored, and an empty goal never reaches the AI', async () => {
  const h = await harness();
  for (const pick of [h.input, contextInput]) {
    openWithContext(h, 'Draft'); pick(h).fire('keydown', { key: 'Escape' }); await tick();
    assert.equal(h.input(), undefined); assert.equal(h.chip().focused, true, 'focus returns to the goal text'); assert.equal(h.chip().text, 'What do you want to achieve with this map?');
  }
  openWithContext(h, 'Goal'); h.input().fire('keydown', { key: 'Enter', isComposing: true }); contextInput(h).fire('keydown', { key: 'Enter', isComposing: true }); h.input().fire('keydown', { key: 'Escape', isComposing: true });
  assert.ok(h.input(), 'composition Enter and Esc do nothing: not saved, not cancelled'); assert.equal(h.control.calls.length, 0);
  h.input().value = '  '; contextInput(h).value = 'only context'; contextInput(h).fire('keydown', { key: 'Enter' }); await tick();
  assert.equal(h.input(), undefined); assert.equal(h.control.calls.length, 0); assert.equal(h.control.usageAsks, 0);
  assert.equal(await h.repo.readRelevanceGoal(MAP), undefined, 'nothing written for a blank goal');
});

integrationTest('relevance: while a run is going the three goal icons are disabled and the goal text opens no editor (it says why)', async () => {
  const h = await harness();
  const gate = deferred(); h.control.reply = request => gate.promise.then(() => gradeAll(request));
  await h.enter('Goal'); await until(() => h.control.calls.length);
  assert.ok(h.icons().length === 3 && h.icons().every(b => b.disabled)); const before = h.renders();
  h.chip().click(); assert.equal(h.input(), undefined, 'a running map opens no editor'); assert.deepEqual(h.notices, ['Grading is still running; try again when it finishes.']);
  assert.equal(h.renders(), before);
  gate.resolve(); await h.settled();
});

integrationTest('relevance: the context key survives map saves and is capped at 200; an old level key is neither read nor changed', async () => {
  const h = await harness();
  openWithContext(h, 'Goal').value = 'c'.repeat(260); h.input().fire('keydown', { key: 'Enter' }); await h.settled();
  assert.equal((await h.repo.readRelevanceSetup(MAP)).context.length, 200);
  const map = await h.repo.readMap(MAP); map.viewport = { x: 1, y: 2, zoom: 1.5 }; await h.repo.saveMap(MAP, map);
  assert.deepEqual({ ...(await h.repo.readRelevanceSetup(MAP)), context: '' }, { goal: 'Goal', context: '' });
});

// Old maps: the retired `relevance-level` key is read-but-ignored. Saving a goal, saving the map, undo and redo leave it exactly as it was.
integrationTest('relevance: an old relevance-level key stays unchanged through goal save, map save, undo and redo; the prompt level is null', async () => {
  const h = await harness();
  withOldLevel(h);
  assert.deepEqual(Object.keys(await h.repo.readRelevanceSetup(MAP)).sort(), ['context', 'goal'], 'the level is not part of the setup');
  await h.view.hydrate();
  openWithContext(h, 'Grow herbs').value = 'Half a day of sun'; h.input().fire('keydown', { key: 'Enter' }); await h.settled();
  assert.match(frontmatterOf(h), /^relevance-level: "beginner"$/m, 'the old key is still there, unchanged');
  assert.match(frontmatterOf(h), /relevance-goal: "Grow herbs"/);
  assert.equal(h.control.calls[0].request.level, undefined);
  assert.match(h.control.calls[0].prompt, /Learner level \(JSON string[^\n]*: null\n/, 'the prompt level is null');
  const map = await h.repo.readMap(MAP); map.viewport = { x: 1, y: 2, zoom: 1.5 }; await h.repo.saveMap(MAP, map);
  assert.match(frontmatterOf(h), /^relevance-level: "beginner"$/m, 'a map save keeps it');
  await h.view.travel(false); await h.view.travel(false);
  assert.doesNotMatch(h.contents.get(MAP), /relevance-(goal|context)/, 'undo removes goal and context');
  assert.match(frontmatterOf(h), /^relevance-level: "beginner"$/m, 'undo leaves the old key');
  await h.view.travel(true);
  assert.match(frontmatterOf(h), /^relevance-level: "beginner"$/m, 'redo leaves the old key');
  assert.match(frontmatterOf(h), /relevance-goal: "Grow herbs"/);
});

integrationTest('relevance: changing only the old level key is not a setup change (the same setup recalibrates)', async () => {
  const h = await harness();
  await h.enter('Goal'); await h.settled();
  const past = h.view.history.past.length;
  h.contents.set(MAP, h.contents.get(MAP).replace(/^---\n/, '---\nrelevance-level: "familiar"\n'));
  const before = h.contents.get(MAP).match(/relevance-level: "familiar"/g).length;
  const written = await h.repo.writeRelevanceGoal(MAP, 'Goal');
  assert.equal(written.setupChanged, false, 'the level is not compared'); assert.equal(written.changed, false);
  h.contents.set(MAP, h.contents.get(MAP).replace('relevance-level: "familiar"', 'relevance-level: "beginner"'));
  assert.equal((await h.repo.writeRelevanceGoal(MAP, 'Goal')).setupChanged, false, 'a different old level is still no change');
  assert.equal(h.contents.get(MAP).match(/relevance-level: "beginner"/g).length, before);
  assert.equal(h.view.history.past.length, past);
});

// ---- Repair round (v2.1) -----------------------------------------------------------------------------------------
const dreamsAboveParent = request => { const o = gradeAll(request); o.items.find(i => nodeOfLabel(request, i.id).title === 'Dreams').tier = 'core'; return o; };

integrationTest('relevance repair: a parent-child violation sends ONE repair request carrying the pairs; a valid repair is written as one history entry', async () => {
  const h = await harness();
  const seen = [];
  h.control.reply = async (request, _signal, prepared) => {
    seen.push(prepared.step.id);
    if (prepared.step.id === 'relevance-grade') return dreamsAboveParent(request);
    seen.push(h.barText());
    return gradeAll(request);
  };
  await h.enter('Goal'); await h.settled();
  assert.deepEqual(h.control.calls.map(c => c.step), ['relevance-grade', 'relevance-grade-repair']);
  const mind = labelOf(h.control.calls[0].request, h.ids.b), dreams = labelOf(h.control.calls[0].request, h.ids.d);
  assert.doesNotMatch(h.control.calls[1].prompt, new RegExp(h.ids.b), 'the repair prompt carries no real id');
  assert.ok(h.control.calls[1].prompt.includes(`{"childId":"${dreams}","childTier":"core","parentId":"${mind}","parentTier":"support","ancestors":[{"id":"${mind}","tier":"support"}`), 'the pair and its ancestor chain (parent first) are in the repair prompt');
  assert.equal(seen[2], 'Fixing parent-child order…', 'the bar shows the repair text while it runs');
  assert.equal(h.run().status, 'done'); assert.equal(h.barText(), 'Graded 4 topics, 4 changed (0 skipped)');
  assert.equal(await h.relevanceOf('d'), 'support');
  assert.equal(h.view.history.past.length, 2, 'goal step plus ONE grading step');
  assert.equal(h.control.usageAsks, 1, 'one usage notice for both requests');
});

integrationTest('relevance repair: still violating after TWO repair rounds writes nothing, sends no third repair and shows a plain error bar without ids', async () => {
  const h = await harness();
  h.control.reply = async request => dreamsAboveParent(request);
  await h.enter('Goal'); await h.settled();
  assert.deepEqual(h.control.calls.map(c => c.step), ['relevance-grade', 'relevance-grade-repair', 'relevance-grade-repair'], 'at most two repair rounds');
  assert.equal(h.run().status, 'failed');
  assert.equal(h.barText(), "Grading failed. No topic was changed. The AI's parent-child tiers were still inconsistent. Click Recalibrate next to the goal to try again.");
  assert.doesNotMatch(h.barText(), /hierarchy|[0-9a-f]{8}-[0-9a-f]{4}/, 'no card id or UUID in the user-facing text');
  assert.deepEqual(await graded(h), [], 'nothing written'); assert.equal(h.view.history.past.length, 1, 'only the goal step');
});

integrationTest('relevance repair: a failure that is not only about hierarchy sends no repair request', async () => {
  const h = await harness();
  h.control.reply = async request => { const o = dreamsAboveParent(request); o.items.pop(); return o; };
  await h.enter('Goal'); await h.settled();
  assert.equal(h.control.calls.length, 1); assert.equal(h.run().status, 'failed'); assert.deepEqual(await graded(h), []);
});

integrationTest('relevance repair: Stop during the repair aborts it, writes nothing and a late repair reply is dropped', async () => {
  const h = await harness();
  const gate = deferred();
  h.control.reply = async (request, _s, prepared) => prepared.step.id === 'relevance-grade' ? dreamsAboveParent(request) : gate.promise.then(() => gradeAll(request));
  await h.enter('Goal'); await until(() => h.control.calls.length === 2);
  assert.equal(h.barText(), 'Fixing parent-child order…'); assert.deepEqual(h.barButtons(), ['Stop']);
  button(h.bar(), 'Stop').click();
  assert.equal(h.control.calls[1].signal.aborted, true); assert.equal(h.run().status, 'stopped');
  gate.resolve(); await tick(); await tick(); await tick();
  assert.deepEqual(await graded(h), []); assert.equal(h.run().status, 'stopped'); assert.equal(h.view.history.past.length, 1);
});

integrationTest('relevance repair: an over-budget repair is refused with the over-budget message and nothing is sent or written', async () => {
  const h = await harness();
  // The grade request fits; the repair request (original prompt + first reply + pairs) is judged against the same budget.
  const { relevanceGradeRepairStep, RelevanceGradeError } = h.gradeModule;
  const original = relevanceGradeRepairStep.policy;
  relevanceGradeRepairStep.policy = () => { throw new RelevanceGradeError('over_budget', 'The map is too large to grade at once. Nothing was changed.'); };
  try {
    h.control.reply = async request => dreamsAboveParent(request);
    await h.enter('Goal'); await h.settled();
  } finally { relevanceGradeRepairStep.policy = original; }
  assert.equal(h.control.calls.length, 1, 'the repair request is never sent');
  assert.equal(h.barText(), 'Grading failed. No topic was changed. The map is too large to grade at once. Nothing was changed.');
  assert.deepEqual(await graded(h), []);
});

integrationTest('relevance sort: adding a child while sorted saves coordinates from the real parent, never from the display copy', async () => {
  const h = await harness();
  const { view } = h;
  // Give the cards tiers so the display order differs from the saved one.
  for (const [key, tier] of [['a', 'side'], ['b', 'core'], ['c', 'core'], ['d', 'support']]) view.notes.get(h.ids[key]).relevance = { tier };
  const toggle = h.icon('Sort by relevance');
  assert.equal(toggle.attrs['aria-pressed'], 'false'); toggle.click();
  assert.equal(view.relevanceSortOn(), true);
  const before = h.contents.get(MAP);
  const real = view.map.nodes.find(n => n.id === h.ids.b);
  const display = view.canvasNodes().find(n => n.id === h.ids.b);
  assert.ok(display.x !== real.x || display.y !== real.y, 'the display copy is somewhere else');
  assert.equal(h.contents.get(MAP), before, 'toggling wrote nothing');
  const siblingsBefore = view.map.nodes.filter(n => n.parentId === real.id);
  await view.addNode(display, 'Child while sorted');
  const saved = (await h.saved()).find(n => n.parentId === real.id && !siblingsBefore.some(s => s.id === n.id));
  assert.ok(saved, 'the child was added under the real parent');
  // 0.25 FG20-08: the child is laid out by arrangeNewBranch (one column right of the real parent, clear of its siblings by their card height).
  assert.equal(saved.x, real.x + 360);
  assert.ok(saved.y >= Math.max(...siblingsBefore.map(n => n.y)) + 204, 'below the real siblings');
  const realAfter = (await h.saved()).find(n => n.id === real.id);
  assert.deepEqual([realAfter.x, realAfter.y], [real.x, real.y], 'the parent keeps its saved position');
});

// ---- Phase 6: one toolbar button + popover panel ------------------------------------------------------------------
const fakeDoc = () => { const doc = { activeElement: null, listeners: {}, addEventListener(n, f) { (this.listeners[n] ??= []).push(f); }, removeEventListener(n, f) { this.listeners[n] = (this.listeners[n] ?? []).filter(x => x !== f); } }; return doc; };

integrationTest('relevance goal bar: the text is one tab stop named by a hidden label (no aria-expanded, aria-haspopup, aria-controls or aria-label); three named icons; no separate goal line or sort chip', async () => {
  const h = await harness();
  const chip = h.chip();
  assert.equal(chip.text, 'What do you want to achieve with this map?');
  for (const attr of ['aria-expanded', 'aria-haspopup', 'aria-controls', 'aria-label']) assert.equal(chip.attrs[attr], undefined, `no ${attr} on the goal text`);
  assert.equal(nameOf(h, chip), 'What do you want to achieve with this map?');
  assert.equal(chip.attrs.tabindex, '0'); assert.equal(chip.attrs.role, 'button');
  assert.deepEqual(h.icons().map(b => b.attrs['aria-label']), ['Suggest new topics for this goal', 'Grade with this', 'Sort by relevance'], 'three icons, each with an accessible name');
  assert.equal(findAll(h.rootEl, i => hasCls(i, 'vam-relevance-goal-slot')).length, 0);
  chip.click();
  assert.ok(h.input(), 'a click turns the text into the field'); assert.equal(h.chip(), undefined);
  h.input().fire('keydown', { key: 'Escape' });
  assert.equal(h.input(), undefined, 'Esc closes it'); assert.equal(h.chip().focused, true);
  h.view.relevanceGoal = 'Sleep better'; h.view.relevanceContext = 'Night shifts'; h.view.render();
  assert.equal(h.chip().text, 'Sleep better', 'the goal text is shown whole, not "Goal: ..." and not cut'); assert.equal(nameOf(h, h.chip()), 'Goal: Sleep better');
  assert.equal(h.chip().attrs['aria-description'], 'Change the goal and grade again');
  assert.equal(h.icon('Sort by relevance').attrs['aria-pressed'], 'false');
  const long = 'x'.repeat(200); h.view.relevanceGoal = long; h.view.render();
  assert.equal(h.chip().text, long, 'a 200-character goal is not truncated');
  // The suggest icon (P5) is on once there is a goal (the list itself is tested in tests/steps-goal-topic-suggest-view.cjs) and off without one.
  assert.equal(h.icon('Suggest new topics for this goal').disabled, false);
  h.view.relevanceGoal = null; h.view.render();
  assert.equal(h.icon('Suggest new topics for this goal').disabled, true, 'no goal: nothing to suggest for');
});

integrationTest('relevance goal bar: the recalibrate icon is named by its mode and runs the grade it names; Enter and Space on the goal text open the field and Esc closes it', async () => {
  const h = await harness();
  await h.enter('Goal'); await h.settled();
  assert.equal(h.icon('Grade with this'), undefined, 'the map holds an AI grade now, so the icon says Recalibrate');
  const calls = h.control.calls.length;
  const grade = h.icon('Recalibrate');
  grade.click(); await h.settled();
  assert.equal(h.control.calls.length, calls + 1, 'the icon runs one grade with the saved goal');
  h.chip().fire('keydown', { key: 'Enter', preventDefault() {}, stopPropagation() {} }); assert.ok(h.input(), 'Enter on the goal text opens the field'); assert.equal(h.input().focused, true);
  h.input().fire('keydown', { key: 'Escape' }); assert.equal(h.input(), undefined);
  h.chip().fire('keydown', { key: ' ', preventDefault() {}, stopPropagation() {} }); assert.ok(h.input(), 'Space opens it too');
  h.input().fire('keydown', { key: 'Escape' });
  h.chip().fire('keydown', { key: 'Escape', stopPropagation() {} }); assert.equal(h.input(), undefined, 'Esc on the shown goal does nothing');
});

const texts = root => findAll(root, i => i.text).map(i => i.text);

integrationTest('relevance goal bar: Enter closes the editor, disables the icons while grading and submits once', async () => {
  const h = await harness();
  const gate = deferred(); h.control.reply = request => gate.promise.then(() => gradeAll(request));
  open(h); h.input().value = 'Goal via editor'; h.input().fire('keydown', { key: 'Enter' });
  assert.equal(h.input(), undefined); assert.ok(h.icons().every(b => b.disabled)); assert.equal(h.chip().attrs['aria-expanded'], undefined);
  await until(() => h.control.calls.length); assert.equal(h.control.calls.length, 1);
  gate.resolve(); await h.settled(); assert.equal(h.chip().text, 'Goal via editor');
});

integrationTest('relevance goal bar: the sort icon toggles aria-pressed and the on style, keeps the goal text, and writes nothing', async () => {
  const h = await harness();
  const { view } = h;
  for (const [key, tier] of [['a', 'side'], ['b', 'core']]) view.notes.get(h.ids[key]).relevance = { tier };
  const before = h.contents.get(MAP), writes = [];
  const create = h.app.vault.create, modify = h.app.vault.modify; h.app.vault.create = (...a) => { writes.push(a[0]); return create.apply(h.app.vault, a); }; h.app.vault.modify = (...a) => { writes.push(a[0]); return modify.apply(h.app.vault, a); };
  view.renderPreservingFocus = () => view.render();
  assert.equal(h.icon('Sort by relevance').attrs['aria-pressed'], 'false'); assert.ok(!hasCls(h.icon('Sort by relevance'), 'on'));
  h.icon('Sort by relevance').click();
  assert.equal(h.icon('Sort by relevance').attrs['aria-pressed'], 'true'); assert.ok(hasCls(h.icon('Sort by relevance'), 'on'));
  assert.equal(nameOf(h, h.chip()), 'What do you want to achieve with this map? (sorted by relevance)');
  assert.equal(h.contents.get(MAP), before); assert.deepEqual(writes, [], 'no file write');
  h.icon('Sort by relevance').click(); assert.equal(h.icon('Sort by relevance').attrs['aria-pressed'], 'false');
  assert.equal(nameOf(h, h.chip()), 'What do you want to achieve with this map?');
  assert.equal(view.relevanceSortOn(), false); assert.deepEqual(writes, []);
  h.app.vault.create = create; h.app.vault.modify = modify;
});

integrationTest('relevance toolbar: the zh-TW strings for the sorted state and the toolbar button', async () => {
  const { translate } = load('i18n.ts');
  assert.equal(translate('zh-TW', 'ui.relevance_sorted_suffix'), '（已依重要度排序）');
  assert.equal(translate('en', 'ui.relevance_sorted_suffix'), ' (sorted by relevance)');
});

integrationTest('relevance toolbar: the sort hint uses the same tier words as the card tags (en and zh)', async () => {
  const { translate } = load('i18n.ts');
  for (const [lang, words] of [['en', ['Must learn', 'Learn when needed', 'Skippable']], ['zh-TW', ['必學', '需要時學', '可跳過']]]) {
    const hint = translate(lang, 'ui.relevance_sort_hint');
    assert.deepEqual(['core', 'support', 'side'].map(k => translate(lang, `ui.relevance_${k}`)), words);
    let at = -1; for (const w of words) { const i = hint.indexOf(w); assert.ok(i > at, `${lang}: "${w}" in order`); at = i; }
    assert.doesNotMatch(hint, /核心|支援|旁支|core topics|supporting|side topics/);
  }
  for (const [lang, text] of [['en', '+ Context'], ['zh-TW', '＋ 補充'], ['zh-CN', '＋ 补充']]) assert.equal(translate(lang, 'ui.goal_add_context'), text);
});

// ---- Phase 7: change a tier by hand from the card tag ----------------------------------------------------------------
const pathOfKey = (h, key) => h.view.map.nodes.find(n => n.id === h.ids[key]).path;
const rawNote = (h, key) => h.contents.get(pathOfKey(h, key));
const manualKeys = /^relevance-(tier|reason|manual):.*\n/gm;
// Draws one real card on a stage, the way render does, and returns its tag button.
const paintCard = (h, key) => {
  h.plugin.expansionBatches ??= new Map(); h.plugin.pendingSuggestions ??= new Map(); h.plugin.detailsShown ??= () => false;
  h.view.labelCard = () => {}; h.view.stageEl = element('stage'); h.view.cardEls = new Map(); h.view.selection.moveTabStop(null);
  h.view.renderNode(h.view.map.nodes.find(n => n.id === h.ids[key]));
  const card = h.view.stageEl.children[0];
  card.matches = () => false;
  const tag = find(card, i => hasCls(i, 'vam-relevance-tag-button'));
  if (tag) tag.getBoundingClientRect = () => ({ left: 10, bottom: 20 });
  return { card, tag };
};
const pick = (menu, title) => menu.items.find(i => i.title === title);
const afterWrite = async () => { for (let i = 0; i < 12; i++) await tick(); };

integrationTest('relevance manual: the tag is a keyboard-reachable button with an aria-label; its menu has the three tiers (current checked), a separator and Hand back to AI', async () => {
  const h = await harness();
  await h.enter('Goal'); await h.settled();
  const { card, tag } = paintCard(h, 'a');
  assert.equal(tag.tag, 'button'); assert.equal(tag.type, 'button'); assert.equal(tag.attrs['aria-label'], 'Relevance: Must learn, click to change');
  const nameEl = find(tag, i => hasCls(i, 'vam-relevance-tag-name'));
  assert.equal(nameEl.text, 'Relevance: Must learn, click to change'); assert.equal(tag.attrs['aria-labelledby'], nameEl.attrs.id, 'the name survives setTooltip, which overwrites aria-label');
  assert.equal(tag.dataset.tier, 'core'); assert.equal(tag.disabled, false); assert.equal(tag.attrs['aria-haspopup'], 'menu');
  assert.equal(tag.tabIndex, -1, 'in the tab order only while its card has focus, like the card tools');
  card.fire('focusin', { target: card }); assert.equal(tag.tabIndex, 0, 'focusing the card makes the tag a tab stop');
  // A native button turns Enter and Space into a click; the card's own Enter handler must not also open the card.
  let detailsOpened = 0; h.view.openDetails = () => { detailsOpened++; };
  card.fire('keydown', { key: 'Enter', target: tag }); card.fire('keydown', { key: ' ', target: tag });
  assert.equal(detailsOpened, 0); assert.equal(h.menus.length, 0);
  tag.click();
  assert.equal(h.menus.length, 1);
  const menu = h.menus[0];
  assert.deepEqual(menu.items.map(i => i.separator ? '-' : i.title), ['Must learn', 'Learn when needed', 'Skippable', '-', 'Hand back to AI']);
  assert.deepEqual(menu.items.slice(0, 3).map(i => i.checked), [true, false, false]);
  assert.ok(menu.pos && 'x' in menu.pos && 'y' in menu.pos, 'opens at the tag');
  assert.equal(h.view.selection.state.selected, null, 'a click on the tag does not select the card'); assert.equal(detailsOpened, 0);
  assert.equal(h.opened.length, 0);
});

integrationTest('relevance manual: a hand-set tier writes only tier + manual, then change, then clear touch only those keys; no Map.md or viewport write', async () => {
  const h = await harness();
  await h.enter('Goal'); await h.settled();
  const mapBefore = h.contents.get(MAP), viewportBefore = JSON.stringify(h.view.map.viewport);
  let fits = 0, saves = 0; h.view.fit = () => { fits++; }; h.view.saveViewport = () => { saves++; };
  const writes = [];
  const create = h.app.vault.create, modify = h.app.vault.modify, process = h.app.vault.process;
  h.app.vault.create = (...a) => { writes.push(a[0]); return create.apply(h.app.vault, a); };
  h.app.vault.modify = (...a) => { writes.push(a[0]); return modify.apply(h.app.vault, a); };
  h.app.vault.process = (file, ...a) => { writes.push(file.path); return process.call(h.app.vault, file, ...a); };
  const start = rawNote(h, 'c');
  assert.doesNotMatch(start, /relevance-reason:/, 'an AI grade writes no reason');
  const stripped = text => text.replace(manualKeys, '');
  const before = h.view.map.nodes.length;
  paintCard(h, 'c').tag.click(); pick(h.menus.at(-1), 'Must learn').click(); await afterWrite();
  let now = rawNote(h, 'c');
  assert.match(now, /^relevance-tier: "core"$/m); assert.match(now, /^relevance-manual: true$/m); assert.doesNotMatch(now, /relevance-reason/);
  assert.equal(stripped(now), stripped(start), 'nothing else in the note changed');
  assert.deepEqual(JSON.parse(JSON.stringify((await h.note('c')).relevance)), { tier: 'core', manual: true });
  // Change it again, to a third tier.
  paintCard(h, 'c').tag.click(); pick(h.menus.at(-1), 'Learn when needed').click(); await afterWrite();
  now = rawNote(h, 'c');
  assert.equal(now.match(/^relevance-tier:/gm).length, 1); assert.match(now, /^relevance-tier: "support"$/m); assert.equal(now.match(/^relevance-manual:/gm).length, 1);
  assert.equal(stripped(now), stripped(start));
  // The menu for a card that is now manual checks the new tier.
  paintCard(h, 'c').tag.click(); assert.deepEqual(h.menus.at(-1).items.slice(0, 3).map(i => i.checked), [false, true, false]);
  pick(h.menus.at(-1), 'Hand back to AI').click(); await afterWrite();
  now = rawNote(h, 'c');
  assert.doesNotMatch(now, /relevance-(tier|reason|manual)/); assert.equal(now, stripped(start), 'clear removes all three keys and nothing else');
  assert.equal(await h.note('c').then(n => n.relevance), undefined);
  assert.equal(h.contents.get(MAP), mapBefore, 'Map.md untouched'); assert.equal(JSON.stringify(h.view.map.viewport), viewportBefore);
  assert.equal(fits, 0, 'no refit'); assert.equal(saves, 0, 'no viewport save'); assert.equal(h.view.map.nodes.length, before);
  assert.ok(writes.length > 0 && writes.every(p => p === pathOfKey(h, 'c')), 'only the one note was written');
  assert.equal(h.control.calls.length, 1, 'no AI call for a manual change');
  assert.equal(h.view.history.past.length, 2, 'goal and grading only');
  h.app.vault.create = create; h.app.vault.modify = modify; h.app.vault.process = process;
});

integrationTest('relevance manual: an AI tag has no tooltip or description, a hand-set one says you set it; parent-child order is not enforced', async () => {
  const h = await harness();
  await h.enter('Goal'); await h.settled();
  const aiCard = paintCard(h, 'a');
  assert.equal(h.tips.has(aiCard.tag), false, 'an AI grade has no tooltip'); assert.equal(aiCard.card.attrs['aria-description'], undefined, 'and no description');
  // Parent (a) Skippable while its child (c) stays Skippable-or-higher: nothing is checked or repaired.
  paintCard(h, 'a').tag.click(); pick(h.menus.at(-1), 'Skippable').click(); await afterWrite();
  paintCard(h, 'c').tag.click(); pick(h.menus.at(-1), 'Must learn').click(); await afterWrite();
  assert.equal((await h.note('a')).relevance.tier, 'side'); assert.equal((await h.note('c')).relevance.tier, 'core');
  const { card, tag } = paintCard(h, 'a');
  assert.equal(h.tips.get(tag), 'You set this');
  assert.equal(card.attrs['aria-description'], 'Skippable: You set this');
  assert.equal(h.control.calls.length, 1);
  const { translate } = load('i18n.ts');
  assert.equal(translate('zh-TW', 'ui.relevance_manual_reason'), '你手動設定');
  assert.equal(translate('zh-TW', 'ui.relevance_tag_label_0').replace('{0}', '必學'), '分級：必學，點擊更改');
  assert.equal(translate('zh-TW', 'ui.relevance_clear'), '交還 AI');
  assert.equal(translate('zh-TW', 'ui.relevance_clear_hint'), '下次分級由 AI 判斷');
  assert.equal(translate('en', 'ui.relevance_clear_hint'), 'The AI decides the next time you grade');
});

integrationTest('relevance manual: the tag and its menu are disabled while this map is being graded', async () => {
  const h = await harness();
  await h.enter('Goal'); await h.settled();
  const note = rawNote(h, 'a');
  h.plugin.relevanceGrades.set(MAP, { status: 'running', token: 99, owner: {}, controller: new AbortController(), goal: 'g' });
  const { tag } = paintCard(h, 'a');
  assert.equal(tag.disabled, true); tag.click(); assert.equal(h.menus.length, 0, 'a disabled button opens nothing');
  h.view.openRelevanceMenu(h.view.map.nodes.find(n => n.id === h.ids.a), 'core', tag); assert.equal(h.menus.length, 0, 'not even by calling the handler');
  h.view.setManualRelevance(h.view.map.nodes.find(n => n.id === h.ids.a), 'side'); await afterWrite();
  assert.equal(rawNote(h, 'a'), note, 'no write while running');
  h.plugin.relevanceGrades.delete(MAP);
  assert.equal(paintCard(h, 'a').tag.disabled, false);
});

integrationTest('relevance manual: readRelevance and the frontmatter writer handle relevance-manual', async () => {
  const { readRelevance } = load('note-values.ts');
  const plainOf = v => JSON.parse(JSON.stringify(v));
  assert.deepEqual(plainOf(readRelevance({ 'relevance-tier': 'side', 'relevance-manual': true })), { tier: 'side', manual: true });
  assert.deepEqual(plainOf(readRelevance({ 'relevance-tier': 'side', 'relevance-reason': ' r ', 'relevance-manual': false })), { tier: 'side' }, 'a leftover reason is ignored');
  assert.deepEqual(plainOf(readRelevance({ 'relevance-tier': 'support' })), { tier: 'support' }, 'a valid tier alone is a grade');
  assert.equal(readRelevance({ 'relevance-reason': 'only a reason' }), undefined, 'a reason without a tier reads as nothing');
  assert.equal(readRelevance({ 'relevance-tier': 'huge', 'relevance-manual': true }), undefined);
  assert.deepEqual(plainOf(readRelevance({ 'relevance-tier': 'side', 'relevance-manual': 'true' })), { tier: 'side' }, 'only a real true makes it manual');
  const { repo } = fixture('en');
  await assert.rejects(() => repo.writeRelevance('missing.md', { tier: 'core' }), /not found|missing/i);
});

integrationTest('relevance manual: the AI never writes a pinned (hand-set) card, whether its tier differs or not; the flag stays; undo touches only written cards', async () => {
  const h = await harness();
  const set = async (key, value) => { await h.repo.writeRelevance(pathOfKey(h, key), value); };
  await set('a', { tier: 'side', manual: true });      // Body: AI will say core -> still untouched
  await set('b', { tier: 'support', manual: true });   // Mind: AI will say support (same tier) -> still untouched, flag kept
  await set('c', { tier: 'support' });                 // REM: not manual, AI says side -> ordinary change
  await h.view.hydrate();
  const rawBefore = Object.fromEntries(['a', 'b', 'c', 'd'].map(k => [k, rawNote(h, k)]));
  await h.enter('Goal'); await h.settled();
  for (const key of ['a', 'b']) { assert.equal(rawNote(h, key), rawBefore[key], `${key} is byte-identical`); assert.match(rawNote(h, key), /relevance-manual: true/); assert.doesNotMatch(rawNote(h, key), /relevance-reason/); }
  assert.deepEqual(await h.allRelevance(), { root: undefined, a: 'side', b: 'support', c: 'side', d: 'support' });
  assert.equal(h.barText(), 'Graded 2 topics, 2 changed (0 skipped) Kept 2 you set.', 'pinned cards are neither graded, changed nor skipped');
  button(h.bar(), 'View changes').click();
  const modal = h.opened.at(-1);
  assert.equal(findAll(modal.contentEl, i => i.tag === 'h4').length, 0, 'no "changed back" section: nothing of yours is changed');
  const lists = findAll(modal.contentEl, i => i.tag === 'ul');
  assert.equal(lists.length, 1);
  assert.deepEqual(findAll(lists[0], i => hasCls(i, 'vam-relevance-change-title')).map(i => i.text), ['REM', 'Dreams']);
  modal.close();
  button(h.bar(), 'Undo').click(); await afterTravel(h);
  for (const key of ['a', 'b', 'c', 'd']) assert.equal(rawNote(h, key), rawBefore[key], `${key} is back exactly`);
  assert.match(rawNote(h, 'a'), /relevance-manual: true/);
  // Redo re-applies only what was written; the pinned cards stay as they were.
  await h.view.travel(true); await h.view.travel(true);
  assert.equal(await h.relevanceOf('c'), 'side');
  for (const key of ['a', 'b']) assert.equal(rawNote(h, key), rawBefore[key]);
});

integrationTest('relevance manual: an AI grade of a non-manual card is unchanged (no manual section, no flag written)', async () => {
  const h = await harness();
  await h.enter('Goal'); await h.settled();
  for (const key of ['a', 'b', 'c', 'd']) assert.doesNotMatch(rawNote(h, key), /relevance-manual/);
  button(h.bar(), 'View changes').click();
  const modal = h.opened.at(-1);
  assert.equal(findAll(modal.contentEl, i => i.tag === 'h4').length, 0); assert.equal(findAll(modal.contentEl, i => i.tag === 'ul').length, 1);
});

// ---- Recalibrate: pins as anchors, one button whose words follow the mode, hand back to the AI ---------------------
const pinNote = async (h, key, tier) => { await h.repo.writeRelevance(pathOfKey(h, key), { tier, manual: true }); await h.view.hydrate(); };
const marked = h => [...h.cards].filter(([, card]) => hasCls(card, 'vam-structure-suggested')).map(([id]) => id).sort();
const keyOfId = (h, id) => Object.entries(h.ids).find(([, value]) => value === id)[0];
const pinsRow = h => find(h.rootEl, i => hasCls(i, 'vam-relevance-pins-row'));
// The old hand-back row of the edit panel is gone with the panel; the More menu carries the entry (tested below).

integrationTest('relevance recalibrate: the recalibrate icon is named by the mode (saved setup + AI grades); the editor shows neither a pinned count nor a hand-back button (en)', async () => {
  const h = await harness();
  assert.equal(h.icon('Grade with this').disabled, true, 'no goal yet: the full-grade icon is disabled');
  await h.enter('Goal'); await h.settled();
  assert.equal(h.icon('Recalibrate').disabled, false, 'the saved setup is unchanged and the map holds an AI grade');
  assert.equal(h.icon('Grade with this'), undefined);
  open(h); assert.equal(pinsRow(h), undefined, 'no pins: no line and no hand-back button'); h.input().fire('keydown', { key: 'Escape' });
  await pinNote(h, 'a', 'side');
  h.view.render();
  assert.equal(h.icon('Recalibrate').disabled, false);
  open(h);
  assert.equal(pinsRow(h), undefined, 'pins: the old "Keeping the N you set" row is gone with the panel');
  assert.deepEqual(findAll(h.goalBar(), i => i.tag === 'button').map(b => b.text), ['+ Context'], 'the editor has no hand-back button; the More menu has the entry');
  // Only pinned cards graded by hand: nothing for the AI to recalibrate from, so the icon grades in full.
  const empty = await harness();
  await pinNote(empty, 'a', 'core'); await pinNote(empty, 'b', 'core'); await pinNote(empty, 'c', 'core'); await pinNote(empty, 'd', 'core');
  await empty.repo.writeRelevanceGoal(MAP, 'Goal'); await empty.view.hydrate(); empty.view.render();
  assert.ok(empty.icon('Grade with this')); assert.equal(empty.icon('Grade with this').disabled, false);
});

integrationTest('relevance recalibrate: the AI gets the pins, the current tiers and the bounds, answers only with the moves, and only those are written (one history entry, pins untouched)', async () => {
  const h = await harness();
  await h.enter('Goal'); await h.settled();
  await pinNote(h, 'b', 'side');   // Mind pinned Skippable; Dreams (support) is now above its pinned parent
  const rawBefore = Object.fromEntries(['a', 'b', 'c', 'd'].map(k => [k, rawNote(h, k)]));
  const past = h.view.history.past.length;
  h.control.reply = async request => ({ changes: [{ id: labelOf(request, h.ids.d), tier: 'side', anchor: labelOf(request, h.ids.b) }] });
  await refreshIcon(h).click(); await h.settled();
  const call = h.control.calls.at(-1);
  assert.equal(call.step, 'relevance-recalibrate'); assert.equal(h.control.calls.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(call.request.pins)), [{ id: h.ids.b, tier: 'side' }]);
  assert.deepEqual(JSON.parse(JSON.stringify(call.request.previous.map(p => [keyOfId(h, p.id), p.tier]).sort())), [['a', 'core'], ['c', 'side'], ['d', 'support']], 'the current AI tiers, the pinned card is not among them');
  assert.ok(call.prompt.includes(`{"id":"${labelOf(call.request, h.ids.d)}","max":"side"}`), 'Dreams may be at most Skippable');
  assert.ok(call.prompt.includes('"pinned":true'));
  assert.deepEqual(await h.allRelevance(), { root: undefined, a: 'core', b: 'side', c: 'side', d: 'side' });
  for (const key of ['a', 'b', 'c']) assert.equal(rawNote(h, key), rawBefore[key], `${key} was not written`);
  assert.match(rawNote(h, 'b'), /relevance-manual: true/);
  assert.equal(h.barText(), 'Adjusted 1 topics based on your 1 settings');
  assert.deepEqual(h.barButtons(), ['View changes', 'Undo', 'Dismiss']);
  assert.equal(h.view.history.past.length, past + 1, 'one history entry for the whole run');
  assert.equal(h.contents.get(MAP).match(/^  - "/gm).length, 1, 'no goal history entry: the goal did not change');
  button(h.bar(), 'View changes').click();
  const modal = h.opened.at(-1);
  assert.deepEqual(findAll(modal.contentEl, i => i.tag === 'h4').map(i => i.text), ['Because you set “Mind” to Skippable']);
  const rows = findAll(modal.contentEl, i => hasCls(i, 'vam-relevance-change'));
  assert.deepEqual(rows.map(r => find(r, i => hasCls(i, 'vam-relevance-change-title')).text), ['Dreams']);
  assert.deepEqual(findAll(rows[0], i => hasCls(i, 'vam-relevance-tag')).map(tag => tag.children[1].text), ['Learn when needed', 'Skippable'], 'old to new');
  assert.equal(find(rows[0], i => hasCls(i, 'vam-relevance-change-reason')), undefined, 'no reason line');
  assert.deepEqual(marked(h), [h.ids.d], 'the moved card is marked on the map while the window is open');
  modal.close();
  assert.deepEqual(marked(h), [], 'closing clears the marks');
  button(h.bar(), 'Undo').click(); await afterTravel(h);
  assert.equal(await h.relevanceOf('d'), 'support');
  for (const key of ['a', 'b', 'c']) assert.equal(rawNote(h, key), rawBefore[key]);
});

integrationTest('relevance recalibrate: an answer that leaves a card outside a pin\'s bounds is sent back once; the fixed answer is what is written', async () => {
  const h = await harness();
  await h.enter('Goal'); await h.settled();
  await pinNote(h, 'b', 'side');
  const replies = [{ changes: [] }, { changes: [{ id: '', tier: 'side', anchor: null }] }];
  h.control.reply = async request => {
    const next = replies.shift();
    next.changes.forEach(change => { change.id = labelOf(request, h.ids.d); change.anchor = labelOf(request, h.ids.b); });
    return next;
  };
  await refreshIcon(h).click(); await h.settled();
  assert.deepEqual(h.control.calls.slice(1).map(c => c.step), ['relevance-recalibrate', 'relevance-recalibrate-repair']);
  assert.ok(h.control.calls.at(-1).prompt.includes('A pinned card cannot move'));
  assert.equal(await h.relevanceOf('d'), 'side');
  assert.equal(h.barText(), 'Adjusted 1 topics based on your 1 settings');
});

integrationTest('relevance recalibrate: nothing to adjust says so; an entry for a pinned card is never written; a wrong reply writes nothing', async () => {
  const h = await harness();
  await h.enter('Goal'); await h.settled();
  await pinNote(h, 'a', 'side');
  const rawBefore = Object.fromEntries(['a', 'b', 'c', 'd'].map(k => [k, rawNote(h, k)]));
  h.control.reply = async request => ({ changes: [{ id: labelOf(request, h.ids.a), tier: 'core', anchor: null }] });
  await refreshIcon(h).click(); await h.settled();
  assert.equal(h.barText(), 'No topics needed adjusting'); assert.deepEqual(h.barButtons(), ['Dismiss']);
  for (const key of ['a', 'b', 'c', 'd']) assert.equal(rawNote(h, key), rawBefore[key], `${key} byte-identical`);
  const past = h.view.history.past.length;
  h.control.reply = async () => ({ items: [] });
  await refreshIcon(h).click(); await h.settled();
  assert.equal(h.run().status, 'failed'); assert.match(h.barText(), /^Grading failed\. No topic was changed\./);
  for (const key of ['a', 'b', 'c', 'd']) assert.equal(rawNote(h, key), rawBefore[key]);
  assert.equal(h.view.history.past.length, past, 'a failed run adds no history');
});

integrationTest('relevance recalibrate: a card that has no tier yet must be graded in the answer; the other cards are left alone', async () => {
  const h = await harness();
  await h.enter('Goal'); await h.settled();
  await h.repo.writeRelevance(pathOfKey(h, 'c'), null); await h.view.hydrate();   // REM handed back
  h.control.reply = async request => ({ changes: [{ id: labelOf(request, h.ids.c), tier: 'support', anchor: null }] });
  await refreshIcon(h).click(); await h.settled();
  assert.equal(await h.relevanceOf('c'), 'support');
  assert.equal(h.barText(), 'Graded 1 topics, 1 changed (0 skipped)', 'no pins: the plain wording');
  const missing = await harness();
  await missing.enter('Goal'); await missing.settled();
  await missing.repo.writeRelevance(pathOfKey(missing, 'c'), null); await missing.view.hydrate();
  missing.control.reply = async () => ({ changes: [] });
  await refreshIcon(missing).click(); await missing.settled();
  assert.equal(missing.run().status, 'failed'); assert.equal(await missing.relevanceOf('c'), undefined);
});

integrationTest('relevance recalibrate: a changed setup is graded in full even when the panel planned a recalibration (the repository decides)', async () => {
  const h = await harness();
  await h.enter('Goal'); await h.settled();
  await h.view.submitRelevanceGoal('Other goal', undefined, undefined, 'recalibrate');
  assert.equal(h.control.calls.at(-1).step, 'relevance-grade');
  assert.equal(h.control.calls.at(-1).request.goal, 'Other goal');
  assert.match(h.barText(), /^Graded 4 topics/);
});

integrationTest('relevance pins: a full grade keeps pinned cards, asks only about the others, takes anchors, and names pins that disagree once', async () => {
  const h = await harness();
  await pinNote(h, 'a', 'side');   // Body Skippable ...
  await pinNote(h, 'c', 'core');   // ... with REM under it Must learn: the learner's own disagreement
  const rawBefore = { a: rawNote(h, 'a'), c: rawNote(h, 'c') };
  h.control.reply = async request => ({ items: [
    { id: labelOf(request, h.ids.b), tier: 'support' },
    { id: labelOf(request, h.ids.d), tier: 'support', anchor: labelOf(request, h.ids.c) }
  ] });
  await h.enter('Goal'); await h.settled();
  const call = h.control.calls[0];
  assert.equal(call.step, 'relevance-grade');
  assert.deepEqual(JSON.parse(JSON.stringify(call.request.pins)), [{ id: h.ids.a, tier: 'side' }, { id: h.ids.c, tier: 'core' }]);
  assert.equal(call.request.previous, undefined);
  assert.ok(call.prompt.includes('never output a pinned card'));
  assert.deepEqual(await h.allRelevance(), { root: undefined, a: 'side', b: 'support', c: 'core', d: 'support' });
  for (const key of ['a', 'c']) assert.equal(rawNote(h, key), rawBefore[key], `${key} byte-identical`);
  assert.equal(h.barText(), 'Graded 2 topics, 2 changed (0 skipped) Kept 2 you set.');
  assert.deepEqual(h.barButtons(), ['View changes', 'Undo', 'Dismiss']);
  button(h.bar(), 'View changes').click();
  const modal = h.opened.at(-1);
  assert.deepEqual(findAll(modal.contentEl, i => i.tag === 'h4').map(i => i.text), ['Because you set “REM” to Must learn', 'Other changes', 'Your settings disagree']);
  const lists = findAll(modal.contentEl, i => i.tag === 'ul');
  assert.deepEqual(lists.map(l => findAll(l, i => hasCls(i, 'vam-relevance-change-title')).map(i => i.text)), [['Dreams'], ['Mind'], []], 'Dreams under its anchor, Mind under Other changes');
  const conflicts = findAll(modal.contentEl, i => hasCls(i, 'vam-relevance-conflict'));
  assert.deepEqual(conflicts.map(i => i.text), ['You set “Body” to Skippable, but “REM” under it to Must learn. Both were kept as you set them.']);
  assert.deepEqual(marked(h), [h.ids.b, h.ids.d].sort());
  modal.close();
  assert.deepEqual(marked(h), []);
  // Undo covers only what was written; the pins stay.
  button(h.bar(), 'Undo').click(); await afterTravel(h);
  assert.equal(await h.relevanceOf('b'), undefined); assert.equal(await h.relevanceOf('d'), undefined);
  for (const key of ['a', 'c']) assert.equal(rawNote(h, key), rawBefore[key]);
});

integrationTest('relevance pins: a conflict between two pins is told even when the run changes nothing; a repeat names it again only if it is still there', async () => {
  const h = await harness();
  await h.enter('Goal'); await h.settled();
  await pinNote(h, 'a', 'side'); await pinNote(h, 'c', 'core');
  h.control.reply = async () => ({ changes: [] });
  await refreshIcon(h).click(); await h.settled();
  assert.equal(h.barText(), 'No topics needed adjusting');
  assert.deepEqual(h.barButtons(), ['View changes', 'Dismiss'], 'the window is offered for the notice; there is nothing to undo');
  button(h.bar(), 'View changes').click();
  const modal = h.opened.at(-1);
  assert.equal(findAll(modal.contentEl, i => hasCls(i, 'vam-relevance-conflict')).length, 1);
  assert.equal(findAll(modal.contentEl, i => hasCls(i, 'vam-relevance-change')).length, 0);
  modal.close();
});

integrationTest('relevance pins: when every gradable card is pinned a grade sends no request and says what it kept', async () => {
  const h = await harness();
  for (const key of ['a', 'b', 'c', 'd']) await pinNote(h, key, 'support');
  await h.enter('Goal'); await h.settled();
  assert.equal(h.control.calls.length, 0, 'no AI request');
  assert.equal(h.barText(), 'Graded 0 topics, 0 changed (0 skipped) Kept 4 you set.');
  assert.equal(await h.repo.readRelevanceGoal(MAP), 'Goal');
});

// Goal header P2 (counter-example 18): the "More mind map actions" menu carries the hand-back entry, with the count, only for a gradable map with pins that is not being graded.
integrationTest('relevance pins: the More menu offers "Hand all back to AI (N cards)" only with pins, not while grading and not on an AIM map; it hands them back in one undo step without an AI call', async () => {
  const h = await harness();
  await h.enter('Goal'); await h.settled();
  const titles = () => { h.view.openMapActions(); return h.menus.at(-1).items.filter(i => !i.separator).map(i => i.title); };
  const entry = /^Hand all back to AI/;
  assert.ok(!titles().some(x => entry.test(x)), 'no pins: no entry');
  await pinNote(h, 'a', 'side'); await pinNote(h, 'c', 'core');
  const before = { a: rawNote(h, 'a'), c: rawNote(h, 'c'), b: rawNote(h, 'b') };
  assert.ok(titles().includes('Hand all back to AI (2 cards)'), 'pins: the entry shows the count');
  // While this map is being graded: no entry.
  h.plugin.relevanceGrades.set(MAP, { status: 'running', token: 99, owner: {}, controller: new AbortController(), goal: 'g' });
  assert.ok(!titles().some(x => entry.test(x)), 'grading: no entry');
  h.plugin.relevanceGrades.delete(MAP);
  // An AIM map is not gradable: no entry even with pinned notes.
  const real = h.view.map; h.view.map = { ...real, aim: { runs: [] } };
  assert.ok(!titles().some(x => entry.test(x)), 'AIM map: no entry');
  h.view.map = real;
  // Choosing it: one mutation, one undo step, no AI call (the only hand-back entry since the edit panel went).
  const past = h.view.history.past.length, calls = h.control.calls.length;
  h.view.openMapActions();
  h.menus.at(-1).items.find(i => entry.test(i.title)).click(); await afterWrite();
  for (const key of ['a', 'c']) assert.equal(await h.relevanceOf(key), undefined, `${key} handed back`);
  assert.equal(rawNote(h, 'b'), before.b, 'an AI grade stays');
  assert.equal(h.view.history.past.length, past + 1, 'one undo step'); assert.equal(h.control.calls.length, calls, 'no AI call');
  await h.view.travel(false); await afterWrite();
  for (const key of ['a', 'c']) assert.equal(rawNote(h, key), before[key], `${key} pinned again by undo`);
  const { translate } = load('i18n.ts');
  assert.equal(translate('zh-TW', 'ui.relevance_unpin_all_0', 3), '全部交還 AI（3 張）');
  assert.equal(translate('zh-CN', 'ui.relevance_unpin_all_0', 3), '全部交还 AI（3 张）');
});

integrationTest('relevance pins: Hand all back to AI removes every pin in one mutation and one undo step; the AI grades stay', async () => {
  const h = await harness();
  await h.enter('Goal'); await h.settled();
  await pinNote(h, 'a', 'side'); await pinNote(h, 'c', 'core');
  const pinned = { a: rawNote(h, 'a'), c: rawNote(h, 'c') };
  const aiKept = { b: rawNote(h, 'b'), d: rawNote(h, 'd') };
  const past = h.view.history.past.length;
  h.view.openMapActions();
  h.menus.at(-1).items.find(i => /^Hand all back to AI/.test(i.title)).click(); await afterWrite();
  for (const key of ['a', 'c']) { assert.doesNotMatch(rawNote(h, key), /relevance-(tier|reason|manual)/); assert.equal(await h.relevanceOf(key), undefined); }
  for (const key of ['b', 'd']) assert.equal(rawNote(h, key), aiKept[key], `${key} untouched`);
  assert.equal(h.view.history.past.length, past + 1, 'one undo step');
  assert.equal(h.control.calls.length, 1, 'no AI call');
  await h.view.travel(false); await afterWrite();
  for (const key of ['a', 'c']) assert.equal(rawNote(h, key), pinned[key], `${key} pinned again`);
  assert.equal(h.view.history.past.length, past);
  await h.view.travel(true); await afterWrite();
  for (const key of ['a', 'c']) assert.equal(await h.relevanceOf(key), undefined, 'redo hands them back again');
  // The next recalibration must grade them (they have no tier now).
  h.view.openMapActions();
  assert.ok(!h.menus.at(-1).items.some(i => /^Hand all back to AI/.test(i.title)), 'no pins left: no entry');
});

integrationTest('relevance pins: handing one card back (the tag menu) leaves it ungraded so the next run grades it; the hint is on the item where the host allows', async () => {
  const h = await harness();
  await h.enter('Goal'); await h.settled();
  await pinNote(h, 'c', 'core');
  paintCard(h, 'c').tag.click();
  const menu = h.menus.at(-1);
  const item = menu.items.at(-1);
  assert.equal(item.title, 'Hand back to AI');
  item.click(); await afterWrite();
  assert.equal(await h.relevanceOf('c'), undefined);
});

integrationTest('relevance pins: undo never writes a card that was pinned after the run; it is skipped and counted', async () => {
  const h = await harness();
  await h.enter('Goal'); await h.settled();
  await pinNote(h, 'c', 'side');
  const pinned = rawNote(h, 'c');
  button(h.bar(), 'Undo').click(); await afterTravel(h);
  assert.equal(rawNote(h, 'c'), pinned, 'the pinned card is byte-identical');
  assert.match(rawNote(h, 'c'), /relevance-manual: true/);
  assert.equal(await h.relevanceOf('a'), undefined, 'the other cards were put back');
  assert.deepEqual(h.notices, ['1 topics were edited after grading and were left as they are.']);
});

// ---- Grade without a reason: old notes, repaint count and the pre-started Claude CLI (D-2026-10-99..103) ------------
const withOldReason = (h, key, tier, reason) => {
  const file = pathOfKey(h, key);
  h.contents.set(file, h.contents.get(file).replace('---\n', `---\nrelevance-tier: ${tier}\nrelevance-reason: ${JSON.stringify(reason)}\n`));
};

integrationTest('relevance: notes graded by an older version read as their tier only; a run rewrites a note only when its tier changes, and then drops the old reason', async () => {
  const h = await harness();
  withOldReason(h, 'a', 'core', 'Old reason for Body.');   // the AI will say core again: nothing to write
  withOldReason(h, 'c', 'support', 'Old reason for REM.'); // the AI will say side: tier changes, the old reason goes
  await h.view.hydrate();
  assert.equal(await h.relevanceOf('a'), 'core'); assert.equal(await h.relevanceOf('c'), 'support');
  assert.equal(paintCard(h, 'a').tag !== undefined, true);
  assert.equal(h.tips.has(paintCard(h, 'a').tag), false, 'the old reason is not shown');
  assert.equal(paintCard(h, 'a').card.attrs['aria-description'], undefined);
  const untouched = rawNote(h, 'a');
  await h.enter('Goal'); await h.settled();
  assert.equal(rawNote(h, 'a'), untouched, 'same tier: the file is not written, the old reason stays until the tier changes');
  assert.doesNotMatch(rawNote(h, 'c'), /relevance-reason|Old reason/); assert.match(rawNote(h, 'c'), /^relevance-tier: "side"$/m);
  assert.equal(h.barText(), 'Graded 4 topics, 3 changed (0 skipped)', 'Body kept its tier; the other three changed');
  button(h.bar(), 'View changes').click();
  const modal = h.opened.at(-1);
  assert.deepEqual(findAll(modal.contentEl, i => hasCls(i, 'vam-relevance-change-title')).map(i => i.text), ['REM', 'Mind', 'Dreams']);
  modal.close();
  // Undo puts back the tier only (an older reason is not kept in memory); an unchanged note stays as it was.
  button(h.bar(), 'Undo').click(); await afterTravel(h);
  assert.equal(await h.relevanceOf('c'), 'support'); assert.doesNotMatch(rawNote(h, 'c'), /relevance-reason/);
  assert.equal(rawNote(h, 'a'), untouched);
});

integrationTest('relevance: one run repaints the map at most twice when the usage notice was already seen and no repair is needed, and apply reads notes with the map', async () => {
  const h = await harness();
  const mapsSeen = []; const readNote = h.repo.readNote.bind(h.repo);
  h.repo.readNote = (file, map) => { mapsSeen.push(map); return readNote(file, map); };
  const startRenders = h.renders();
  await h.enter('Goal'); await h.settled();
  assert.ok(h.renders() - startRenders <= 2, `a full grade repaints ${h.renders() - startRenders} times`);
  assert.equal(h.control.usageAsks, 1);
  // The apply step reads every card's note with the map (no extra read of the map file per card).
  const withMap = mapsSeen.filter(Boolean);
  assert.equal(withMap.length, h.view.map.nodes.length, 'one read per card carries the map'); assert.ok(withMap.every(map => map === h.view.map));
  // A recalibrate that changes nothing repaints twice too: the start and the end.
  const second = h.renders();
  await refreshIcon(h).click(); await h.settled();
  assert.ok(h.renders() - second <= 2, `a recalibrate with nothing to change repaints ${h.renders() - second} times`);
  // The notice still shows its own state when it really opens.
  const waiting = await harness();
  waiting.control.confirmGate = deferred().promise;
  await waiting.enter('Goal'); await until(() => waiting.control.usageAsks === 1);
  assert.equal(waiting.barText(), 'Waiting for AI usage confirmation…');
});

integrationTest('relevance: opening the goal pre-starts nothing; the first edit that differs from the saved setup pre-starts the grade once; Esc kills it; sending keeps it (decision #4)', async () => {
  const h = await harness();
  h.plugin.settings.cliReasoning = 'auto';
  const mode = () => h.control.prewarms.map(([model, reasoning, schema]) => [model, reasoning, schema.properties.changes ? 'recalibrate' : schema.properties.items ? 'grade' : 'other']);
  h.chip().click();
  assert.deepEqual(mode(), [], 'a click on the goal starts no process');
  h.input().value = 'Goal'; h.input().fire('input');
  assert.deepEqual(mode(), [['gpt-6-luna', 'auto', 'grade']], 'the first edit that differs pre-starts the grade');
  h.input().value = 'Goal two'; h.input().fire('input');
  assert.equal(h.control.prewarms.length, 1, 'one start per edit, however many keystrokes');
  h.input().fire('keydown', { key: 'Escape' });
  assert.equal(h.control.releases, 1, 'Escape kills the waiting process');
  h.control.prewarms.length = 0;
  h.chip().click(); h.input().value = 'Goal'; h.input().fire('input'); h.input().fire('keydown', { key: 'Enter' }); await h.settled();
  assert.equal(h.control.prewarms.length, 1); assert.equal(h.control.releases, 1, 'sending keeps the pre-started process for the run (the Escape above was the only release)');
  // A changed setup is always a full grade, so the grade schema is what starts, also after an AI grade.
  h.control.prewarms.length = 0;
  h.chip().click(); h.input().value = 'Another goal'; h.input().fire('input');
  assert.deepEqual(mode(), [['gpt-6-luna', 'auto', 'grade']], 'a new goal needs a full grade');
  h.input().fire('keydown', { key: 'Escape' });
  assert.equal(h.control.releases, 2);
});

integrationTest('relevance: Stop, a declined notice, a failed run and closing the view with an edit open each leave no pre-started process; a run that finishes does not kill another', async () => {
  const stopped = await harness();
  const gate = deferred(); stopped.control.reply = request => gate.promise.then(() => gradeAll(request));
  await stopped.enter('Goal'); await until(() => stopped.control.calls.length);
  const before = stopped.control.releases;
  button(stopped.bar(), 'Stop').click();
  assert.equal(stopped.control.releases, before + 1, 'Stop');
  gate.resolve(); await tick();
  const declined = await harness(); declined.control.decline = true;
  await declined.enter('Goal'); await declined.settled();
  assert.ok(declined.control.releases >= 1, 'a declined notice');
  const failed = await harness(); failed.control.reply = async () => { throw new Error('boom'); };
  await failed.enter('Goal'); await failed.settled();
  assert.equal(failed.run().status, 'failed'); assert.ok(failed.control.releases >= 1, 'a failed run');
  const closing = await harness();
  closing.chip().click(); closing.input().value = 'Typed'; closing.input().fire('input'); const open = closing.control.releases;
  await closing.view.onClose();
  assert.equal(closing.control.releases, open + 1, 'closing the view while an edit with a pre-started process is open');
  const quiet = await harness();
  await quiet.enter('Goal'); await quiet.settled();
  assert.equal(quiet.control.releases, 0, 'a run that finishes leaves the pool alone (it took its process)');
});

// ---- Status bar progress: "N of M received" and seconds (Packet B, F5 minimal) ------------------------------------
const receivedEl = h => find(h.bar(), i => hasCls(i, 'vam-relevance-received'));
const elapsedEl = h => find(h.bar(), i => hasCls(i, 'vam-relevance-elapsed'));
const tiersJson = count => `{"items":[${Array.from({ length: count }, (_, i) => `{"id":"c${i + 2}","tier":"core"}`).join(',')}`;
// A fake clock for the service's 200 ms throttle is not needed here: each test spaces its updates with real waits of 0, so
// only the first count after "" passes; tests that need more feed the service through a service built with a hand clock.
async function progressHarness() {
  const h = await harness();
  let now = 1_000_000;
  h.plugin.relevanceGrade = new h.gradeModule.RelevanceGradeService(async (request, signal, prepared, onJson) => {
    h.control.calls.push({ request, signal, step: prepared.step.id, onJson });
    const out = await h.control.reply(request, signal, prepared);
    return JSON.stringify(out);
  }, () => now);
  h.advance = ms => { now += ms; };
  return h;
}

integrationTest('relevance: while Claude streams, the status bar shows "N of M received" and seconds, changed in place without a repaint, hidden from the live region, and cleared when the run ends', async () => {
  const h = await progressHarness();
  const gate = deferred(); h.control.reply = request => gate.promise.then(() => gradeAll(request));
  await h.enter('Goal'); await until(() => h.control.calls.length);
  assert.ok(elapsedEl(h), 'seconds are on screen as soon as the request is out'); assert.equal(elapsedEl(h).attrs['aria-hidden'], 'true'); assert.match(elapsedEl(h).text, /0:0\d$/); assert.equal(h.control.intervals.length, 1, 'the shared one-second tick rewrites the seconds');
  assert.equal(receivedEl(h).attrs['aria-hidden'], 'true'); assert.equal(receivedEl(h).text, '', 'nothing yet: seconds only');
  assert.equal(h.barText(), 'Grading by goal…', 'the live-region text is unchanged by progress');
  const onJson = h.control.calls[0].onJson; const rendersBefore = h.renders(); const bar = h.bar();
  onJson('');
  assert.equal(receivedEl(h).text, ' · 0 of 4 cards received');
  h.advance(300); onJson(tiersJson(3));
  assert.equal(receivedEl(h).text, ' · 3 of 4 cards received');
  assert.equal(h.renders(), rendersBefore, 'text only: no repaint'); assert.equal(h.bar(), bar, 'the same status bar element');
  assert.equal(h.barText(), 'Grading by goal…');
  gate.resolve(); await h.settled();
  assert.equal(receivedEl(h), undefined, 'the finished run shows its result, not the count'); assert.equal(elapsedEl(h), undefined);
  assert.equal(h.run().received, undefined);
});

integrationTest('relevance: a repair request restarts the count; a recalibration says "changes received"; Stop, failure and Codex show no count', async () => {
  const h = await progressHarness();
  const gate = deferred(); h.control.reply = request => gate.promise.then(() => gradeAll(request));
  await h.enter('Goal'); await until(() => h.control.calls.length);
  h.control.calls[0].onJson(''); h.advance(300); h.control.calls[0].onJson(tiersJson(2));
  assert.equal(receivedEl(h).text, ' · 2 of 4 cards received');
  h.run().repairing = true; h.run().received = undefined; h.view.refreshRelevance();
  assert.equal(receivedEl(h).text, '', 'after the repair starts there is nothing counted yet');
  h.advance(300); h.control.calls[0].onJson('');
  assert.equal(receivedEl(h).text, ' · 0 of 4 cards received');
  button(h.bar(), 'Stop').click();
  assert.equal(receivedEl(h), undefined, 'Stop clears it'); assert.equal(h.run().received, undefined);
  gate.resolve(); await tick();
  // Codex: the runner never calls the listener, so only the seconds are there.
  const codex = await progressHarness();
  const hold = deferred(); codex.control.reply = request => hold.promise.then(() => gradeAll(request));
  await codex.enter('Goal'); await until(() => codex.control.calls.length);
  assert.equal(receivedEl(codex).text, ''); assert.ok(elapsedEl(codex));
  hold.resolve(); await codex.settled();
  // A failed run clears it as well.
  const failed = await progressHarness();
  failed.control.reply = async () => { failed.control.calls[0].onJson(''); throw new Error('boom'); };
  await failed.enter('Goal'); await failed.settled();
  assert.equal(failed.run().status, 'failed'); assert.equal(receivedEl(failed), undefined); assert.equal(failed.run().received, undefined);
});

integrationTest('relevance: a recalibration counts changes received, without a total; waiting for the usage notice shows no seconds or count', async () => {
  const h = await progressHarness();
  await h.enter('Goal'); await h.settled();
  const gate = deferred(); h.control.reply = request => gate.promise.then(() => recalibrateNew(request));
  refreshIcon(h).click(); await until(() => h.control.calls.length === 2);
  assert.equal(h.run().mode ?? 'recalibrate', 'recalibrate');
  h.control.calls[1].onJson('');
  h.advance(300); h.control.calls[1].onJson('{"changes":[{"id":"c2","tier":"core","anchor":null},{"id":"c3","tier":"side","anchor":null}');
  assert.equal(receivedEl(h).text, ' · 2 changes received');
  gate.resolve(); await h.settled();
  const waiting = await progressHarness();
  waiting.control.confirmGate = deferred().promise;
  await waiting.enter('Goal'); await until(() => waiting.control.usageAsks === 1);
  assert.equal(receivedEl(waiting), undefined); assert.equal(elapsedEl(waiting), undefined);
});

// Goal editing in place on the bare view (no repository): the unset bar, a repaint under an open edit. Unit layer (`test`): the tests/support-dom.cjs stand-in.
const PANEL_MAP_PATH = 'Agent Workspace/Topics/m/Map.md';

function goalEditFixture(language = 'en') {
  const notices = [], prewarms = [], counts = { releases: 0 };
  const { VisualAgentMapView } = load('main.ts', { obsidian: { ...obsidian, Notice: class { constructor(message) { notices.push(message); } }, setTooltip() {} } }, { createSvg: tag => ({ tag, attrs: {}, children: [], setAttribute(n, v) { this.attrs[n] = v; }, appendChild(c) { this.children.push(c); } }) });
  const docListeners = { pointerdown: [], pointerup: [], pointercancel: [] };
  const doc = { activeElement: null, addEventListener(name, fn) { (docListeners[name] ??= []).push(fn); }, removeEventListener(name, fn) { docListeners[name] = (docListeners[name] ?? []).filter(f => f !== fn); } };
  const plugin = { settings: { ...DEFAULT_SETTINGS, language }, relevanceGrades: new Map(), releaseOutline() {}, prewarmClaudeStep: (...args) => prewarms.push(args), releaseWarmClaude: () => { counts.releases++; } };
  plugin.currentModelChoice = () => ({ model: plugin.settings.cliModel, reasoning: plugin.settings.cliReasoning });
  const view = new VisualAgentMapView({ app: {} }, plugin);
  const root = node('root'), child = node('child', 'root');
  view.path = PANEL_MAP_PATH; view.map = map([root, child]);
  view.notes = new Map([[root.id, { title: 'Root' }], [child.id, { title: 'Child' }]]);
  const content = element('div'); content.ownerDocument = doc; content.root = doc;
  view.contentEl = content;
  // What render() does: the old DOM goes (after the editor's fields were read back), the bar is drawn again.
  const paint = () => { view.captureGoalEdit(); content.empty(); view.renderGoalBar(content); view.focusGoalEdit(); };
  paint();
  const chip = () => find(content, i => hasCls(i, 'vam-goal-text'));
  const input = () => find(content, i => i.tag === 'textarea');
  const label = el => find(content, i => i.attrs.id === el.attrs['aria-labelledby'])?.text;
  return { view, plugin, content, doc, docListeners, notices, prewarms, counts, paint, chip, input, label, translate: load('i18n.ts').translate };
}

test('the unset goal bar shows the placeholder as its name, with a hint that says what AI does; the new icon names are translated', () => {
  const f = goalEditFixture();
  assert.equal(f.chip().text, 'What do you want to achieve with this map?', 'an unset goal shows the placeholder');
  assert.equal(f.chip().attrs['aria-label'], undefined, 'no aria-label (Obsidian would show it as a tooltip)');
  assert.equal(f.label(f.chip()), 'What do you want to achieve with this map?', 'the accessible name is the placeholder, from a hidden label');
  for (const [language, hint] of [['en', /Must learn.*Learn when needed.*Skippable/], ['zh-TW', /必學.*需要時學.*可跳過/]])
    assert.match(f.translate(language, 'ui.relevance_goal_set_hint'), hint);
  assert.equal(f.translate('zh-TW', 'ui.goal_suggest_topics'), '依目標建議新議題');
  assert.doesNotMatch(f.translate('zh-TW', 'ui.goal_suggest_topics'), /地圖/);
});

test('counter-example 7: a repaint rebuilds the open editor from its state; draft, caret and the keyboard survive three repaints, nothing is asked and nothing is pre-started again', () => {
  const f = goalEditFixture();
  f.chip().click();
  const first = f.input(); first.value = 'A draft'; first.fire('input'); first.selectionStart = 4; first.focus(); f.doc.activeElement = first;
  assert.equal(f.prewarms.length, 1, 'the first differing keystroke pre-started once');
  const seen = [first];
  for (let n = 0; n < 3; n++) {
    f.paint();
    const now = f.input();
    assert.ok(now && !seen.includes(now), `repaint ${n + 1}: a new field`); seen.push(now);
    assert.equal(now.value, 'A draft', `repaint ${n + 1}: the draft stays`); assert.equal(f.view.goalEdit.caret, 4, `repaint ${n + 1}: the caret is kept in the state`);
    assert.equal(now.focused, true, `repaint ${n + 1}: the keyboard is back in the field`); f.doc.activeElement = now;
  }
  assert.equal(f.prewarms.length, 1, 'repainting pre-starts nothing'); assert.equal(f.counts.releases, 0); assert.equal(f.plugin.relevanceGrades.size, 0, 'and asks nothing');
  assert.equal(f.docListeners.pointerdown.length, 1, 'one outside listener, however often it was repainted');
});

test('the editor reads its fields back before a repaint empties the view (source order in render())', () => {
  const source = fs.readFileSync(path.join(projectRoot, 'experiences/visual-map/view.ts'), 'utf8');
  const body = source.slice(source.indexOf('  private render(): void {'));
  const capture = body.indexOf('this.captureGoalEdit()'), remove = body.indexOf('this.removeGoalBar()'), empty = body.indexOf('this.contentEl.empty()'), refocus = body.indexOf('this.focusGoalEdit()');
  assert.ok(capture > 0 && remove > capture && empty > remove, 'capture, then the bar goes, then the view is emptied');
  assert.ok(refocus > empty, 'the keyboard is given back after the repaint');
  assert.match(source, /this\.relevanceBarEl = null;\s*this\.dropGoalEdit\(\);/, 'a render that finds nothing to grade (empty map, AIM, no map) drops an open edit');
});

test('a click on the goal while a grade runs says why and opens nothing; an AIM map opens no editor either', () => {
  const f = goalEditFixture();
  f.plugin.relevanceGrades.set(PANEL_MAP_PATH, { status: 'running' });
  f.chip().fire('click');
  assert.equal(f.input(), undefined); assert.deepEqual(f.notices, [f.translate('en', 'ui.relevance_goal_unavailable_grading')]);
  assert.notEqual(f.translate('zh-TW', 'ui.relevance_goal_unavailable_grading'), f.translate('en', 'ui.relevance_goal_unavailable_grading'), 'translated');
  f.plugin.relevanceGrades.clear();
  f.view.map.aim = { runs: [] }; f.view.startGoalEdit({});
  assert.equal(f.view.goalEdit, null, 'not gradable: no editor'); assert.equal(f.docListeners.pointerdown.length, 0);
});

// ---- Goal edit in place: when it saves and when it never does (plan section 6, counter-examples 1-18) --------------------
// A document stand-in for the editor's listeners: a press outside saves once it is over.
function withDoc(h) {
  const listeners = { pointerdown: [], pointerup: [], pointercancel: [] };
  const doc = { listeners, get activeElement() { return dom.focusedNow(); }, addEventListener(n, f) { (listeners[n] ??= []).push(f); }, removeEventListener(n, f) { listeners[n] = (listeners[n] ?? []).filter(x => x !== f); } };
  h.rootEl.ownerDocument = doc;
  const fire = (name, event) => [...(listeners[name] ?? [])].forEach(f => f(event));
  return { doc, listeners, count: () => Object.values(listeners).reduce((n, a) => n + a.length, 0), press: (target, event = {}) => fire('pointerdown', { target, ...event }), release: () => fire('pointerup', {}), cancel: () => fire('pointercancel', {}) };
}
const later = () => new Promise(r => setTimeout(r, 5));
const noAi = (h, where) => { assert.equal(h.control.calls.length, 0, `${where}: no grading call`); assert.equal(h.control.usageAsks, 0, `${where}: no usage confirmation`); assert.equal(h.plugin.relevanceGrades.size, 0, `${where}: no run`); };
const withGoal = async (goal = 'Sleep better') => { const h = await harness(); await h.repo.writeRelevanceGoal(MAP, goal); await h.view.hydrate(); h.view.render(); return h; };
// A target the way Obsidian's own overlays look to the editor: `closest` finds the overlay.
const insideOverlay = cls => { const overlay = element('div', cls), inner = element('span'); overlay.appendChild(inner); inner.closest = selector => selector.split(',').some(part => part.trim() === `.${cls}`) ? overlay : null; return inner; };

integrationTest('goal edit (counter-examples 1 and 2): the same text, or only its spaces changed, saves nothing and never reaches the AI, whether Enter, a press elsewhere or Tab ends it', async () => {
  for (const edit of ['same', 'spaces']) for (const how of ['enter', 'outside', 'tab']) {
    const h = await withGoal(); const d = withDoc(h); const where = `${edit} / ${how}`;
    const before = h.contents.get(MAP), past = h.view.history.past.length;
    open(h);
    if (edit === 'spaces') { h.input().value = '  Sleep   better '; h.input().fire('input'); }
    if (how === 'enter') h.input().fire('keydown', { key: 'Enter' });
    else if (how === 'tab') addContext(h).fire('keydown', { key: 'Tab' });
    else { d.press(element('div', 'vam-viewport')); d.release(); }
    await later();
    noAi(h, where); assert.equal(h.contents.get(MAP), before, `${where}: nothing written`); assert.equal(h.view.history.past.length, past, `${where}: no undo step`);
    assert.equal(h.input(), undefined, `${where}: the editor closed`); assert.equal(h.chip().text, 'Sleep better', `${where}: the goal is shown again`);
    assert.equal(h.control.prewarms.length, 0, `${where}: nothing was pre-started`); assert.equal(d.count(), 0, `${where}: the document listeners are gone`);
  }
});

integrationTest('goal edit (counter-example 3): clearing the goal then Enter or a press elsewhere keeps the original goal and calls nothing', async () => {
  for (const how of ['enter', 'outside']) {
    const h = await withGoal(); const d = withDoc(h);
    const before = h.contents.get(MAP);
    open(h); h.input().value = ''; h.input().fire('input');
    assert.ok(hasCls(find(h.goalBar(), i => hasCls(i, 'vam-goal-actions')), 'is-vacant'), `${how}: an empty goal offers no "+ Context"`);
    if (how === 'enter') h.input().fire('keydown', { key: 'Enter' }); else { d.press(element('div')); d.release(); }
    await later();
    noAi(h, how); assert.equal(h.contents.get(MAP), before, `${how}: nothing written`); assert.equal(await h.repo.readRelevanceGoal(MAP), 'Sleep better'); assert.equal(h.chip().text, 'Sleep better');
    assert.equal(d.count(), 0);
  }
});

integrationTest('goal edit (counter-example 4): Enter and Esc while an IME composes neither save nor cancel, even with a changed text and after the timers ran', async () => {
  const h = await withGoal(); const d = withDoc(h);
  open(h); h.input().value = 'A different goal'; h.input().fire('input');
  h.input().fire('keydown', { key: 'Enter', isComposing: true }); h.input().fire('keydown', { key: 'Escape', isComposing: true });
  await later();
  noAi(h, 'composing'); assert.ok(h.input(), 'still editing'); assert.equal(h.input().value, 'A different goal'); assert.equal(h.control.releases, 0); assert.ok(d.count() > 0);
  h.input().fire('keydown', { key: 'Enter', isComposing: false }); await h.settled();
  assert.equal(await h.repo.readRelevanceGoal(MAP), 'A different goal', 'the same Enter after the composition ended saves');
});

integrationTest('goal edit (counter-example 5): Esc discards a changed draft, saves nothing, calls nothing and kills the pre-started process', async () => {
  const h = await withGoal(); const d = withDoc(h);
  const before = h.contents.get(MAP);
  open(h); h.input().value = 'Not this one'; h.input().fire('input');
  assert.equal(h.control.prewarms.length, 1);
  h.input().fire('keydown', { key: 'Escape' }); await later();
  noAi(h, 'Esc'); assert.equal(h.contents.get(MAP), before); assert.equal(h.control.releases, 1, 'the waiting process is stopped'); assert.equal(d.count(), 0);
  assert.equal(h.chip().text, 'Sleep better'); assert.equal(h.chip().focused, true, 'focus returns to the goal text');
  open(h); assert.equal(h.input().value, 'Sleep better', 'the discarded draft does not come back');
});

integrationTest('goal edit (counter-example 6): blur and focusout (to nowhere, to something outside, window blur) save nothing; the editor stays open; the code does not listen to them at all', async () => {
  const h = await withGoal(); const d = withDoc(h);
  open(h); h.input().value = 'Typed'; h.input().fire('input');
  const bar = h.goalBar();
  for (const target of [h.input(), bar, h.rootEl]) for (const name of ['blur', 'focusout', 'focusin']) for (const relatedTarget of [null, element('button'), h.input()]) target.fire(name, { relatedTarget });
  addContext(h).click(); const row = contextInput(h);
  for (const name of ['blur', 'focusout']) for (const relatedTarget of [null, element('button')]) { row.fire(name, { relatedTarget }); h.input().fire(name, { relatedTarget }); }
  await later();
  noAi(h, 'blur'); assert.ok(h.input() && contextInput(h), 'both fields are still there'); assert.equal(h.view.goalEdit.warmed, true); assert.equal(h.control.releases, 0); assert.equal(h.control.prewarms.length, 1);
  assert.deepEqual(Object.keys(d.listeners).filter(name => d.listeners[name].length).sort(), ['pointerdown'], 'the only document listener is the press');
  // Nothing in the goal-bar code listens to blur or focusout (the rule of plan section 6).
  const source = fs.readFileSync(path.join(projectRoot, 'experiences/visual-map/view.ts'), 'utf8');
  const section = source.slice(source.indexOf('  private renderGoalBar('), source.indexOf('  // ---- Suggest new topics for the goal'));
  assert.ok(section.length > 8000 && /commitGoalEdit/.test(section), 'the scanned section is the goal bar and its editor');
  assert.doesNotMatch(section, /blur|focusout/i);
});

integrationTest('goal edit (counter-example 8): a map switch or closing the view drops the edit: nothing is asked, the process is stopped, the document listeners are gone', async () => {
  for (const how of ['close', 'switch']) {
    const h = await withGoal(); const d = withDoc(h);
    openWithContext(h, 'Half typed');
    assert.ok(d.count() > 0 && h.control.prewarms.length === 1, how);
    if (how === 'close') await h.view.onClose();
    else await h.view.openMapInMutation('Agent Workspace/Topics/other/Map.md').catch(() => {});
    noAi(h, how); assert.equal(h.view.goalEdit, null, `${how}: the edit is gone`); assert.equal(h.control.releases, 1, `${how}: the process is stopped`); assert.equal(d.count(), 0, `${how}: no document listener left`);
    assert.equal(await h.repo.readRelevanceGoal(MAP), 'Sleep better', `${how}: the saved goal is untouched`);
  }
});

integrationTest('goal edit (counter-example 9): a press elsewhere that ends after the view closed or the map changed saves nothing (checked again when it runs)', async () => {
  for (const [when, how] of [['before the release', 'close'], ['before the release', 'switch'], ['after the release, before the timer', 'close'], ['after the release, before the timer', 'switch']]) {
    const h = await withGoal(); const d = withDoc(h); const where = `${how} ${when}`;
    open(h); h.input().value = 'Changed but never saved'; h.input().fire('input');
    d.press(element('div', 'vam-viewport'));
    if (when.startsWith('after')) d.release();
    if (how === 'close') await h.view.onClose(); else { h.view.path = 'Agent Workspace/Topics/elsewhere/Map.md'; h.view.dropGoalEdit(); }
    if (!when.startsWith('after')) d.release();
    await later();
    noAi(h, where); assert.equal(await h.repo.readRelevanceGoal(MAP), 'Sleep better', where); assert.equal(d.count(), 0, where);
  }
  // The fence inside the commit itself: an edit that survived on another map is not saved either.
  const h = await withGoal(); open(h); h.input().value = 'Stale'; h.view.path = 'Agent Workspace/Topics/elsewhere/Map.md';
  h.view.commitGoalEdit('outside'); await later(); noAi(h, 'stale path'); assert.equal(await h.repo.readRelevanceGoal(MAP), 'Sleep better');
  const h2 = await withGoal(); open(h2); h2.input().value = 'Stale'; h2.view.closed = true; h2.view.commitGoalEdit('enter'); await later(); noAi(h2, 'closed view');
});

integrationTest('goal edit (counter-example 10): a press inside Obsidian\'s .menu, .modal-container or .prompt is not "elsewhere"; any other press is', async () => {
  const h = await withGoal(); const d = withDoc(h);
  open(h); h.input().value = 'Changed'; h.input().fire('input');
  for (const cls of ['menu', 'modal-container', 'prompt']) { d.press(insideOverlay(cls)); d.release(); await later(); assert.ok(h.input(), `.${cls}: the editor stays`); noAi(h, cls); }
  d.press(h.input()); d.release(); d.press(addContext(h)); d.release(); await later();
  assert.ok(h.input(), 'a press inside the bar (the field, "+ Context") is not elsewhere'); noAi(h, 'inside the bar');
  const plain = element('div'); plain.closest = () => null;
  d.press(plain); d.release(); await h.settled();
  assert.equal(await h.repo.readRelevanceGoal(MAP), 'Changed', 'a press anywhere else saves');
  assert.equal(h.control.calls.length, 1);
});

integrationTest('goal edit (counter-example 11): two Enters in a row, or Enter then a press elsewhere, run the grade once', async () => {
  const h = await withGoal(); const d = withDoc(h);
  const gate = deferred(); h.control.reply = request => gate.promise.then(() => gradeAll(request));
  open(h); const field = h.input(); field.value = 'Enter twice'; field.fire('input');
  field.fire('keydown', { key: 'Enter' }); field.fire('keydown', { key: 'Enter' });
  d.press(element('div')); d.release(); await later();
  await until(() => h.control.calls.length);
  assert.equal(h.control.calls.length, 1); assert.equal(h.control.usageAsks, 1); assert.equal(d.count(), 0);
  // The same for a press elsewhere followed by Enter before the timer ran.
  const g = await withGoal(); const e = withDoc(g); g.control.reply = request => gate.promise.then(() => gradeAll(request));
  open(g); const f = g.input(); f.value = 'Press then Enter'; f.fire('input');
  e.press(element('div')); e.release(); f.fire('keydown', { key: 'Enter' }); await later(); await until(() => g.control.calls.length);
  assert.equal(g.control.calls.length, 1); assert.equal(g.control.usageAsks, 1);
  gate.resolve(); await h.settled(); await g.settled();
});

integrationTest('goal edit (counter-example 12): a grade started from the chat while the editor is open cancels the edit; only the chat\'s run goes out, and the typed text is never saved', async () => {
  const h = await withGoal(); const d = withDoc(h);
  const gate = deferred(); h.control.reply = request => gate.promise.then(() => gradeAll(request));
  open(h); h.input().value = 'Typed in the editor'; h.input().fire('input');
  assert.equal(h.control.prewarms.length, 1);
  void h.view.submitRelevanceGoal('Goal from the chat');
  await until(() => h.control.calls.length);
  assert.equal(h.view.goalEdit, null, 'the editor was cancelled by the run'); assert.equal(h.input(), undefined); assert.equal(d.count(), 0); assert.ok(h.control.releases >= 1, 'its pre-started process is stopped');
  assert.equal(h.control.calls.length, 1); assert.equal(h.control.calls[0].request.goal, 'Goal from the chat');
  gate.resolve(); await h.settled();
  assert.equal(await h.repo.readRelevanceGoal(MAP), 'Goal from the chat'); assert.equal(h.control.calls.length, 1, 'the editor\'s text was not graded');
});

integrationTest('goal edit (counter-example 13): a click without typing pre-starts nothing; typing back to the saved text and pressing Esc stops what the typing started', async () => {
  const h = await withGoal();
  h.chip().click(); h.input().fire('keydown', { key: 'Escape' });
  assert.equal(h.control.prewarms.length, 0, 'a click alone starts no process'); assert.equal(h.control.releases, 0, 'and stops none');
  open(h); h.input().value = 'Sleep better!'; h.input().fire('input'); assert.equal(h.control.prewarms.length, 1);
  h.input().value = 'Sleep better'; h.input().fire('input'); h.input().fire('keydown', { key: 'Escape' });
  assert.equal(h.control.releases, 1, 'Esc stops it'); noAi(h, 'typed back');
});

integrationTest('goal edit (counter-example 14): "+ Context" is not "elsewhere": no save, no AI, and the keyboard moves to the context row', async () => {
  const h = await withGoal(); const d = withDoc(h);
  open(h); h.input().value = 'Changed first'; h.input().fire('input');
  d.press(addContext(h)); d.release(); addContext(h).click(); await later();
  noAi(h, '+ Context'); assert.ok(contextInput(h)); assert.equal(contextInput(h).focused, true); assert.equal(h.input().value, 'Changed first');
  assert.equal(h.view.goalEdit.warmed, true); assert.equal(h.control.releases, 0, 'the pre-started process stays');
});

integrationTest('goal edit (counter-example 15): a goal that looks like HTML is text everywhere: the shown goal, the field and the context row', async () => {
  const evil = '<img src=x onerror=alert(1)>';
  const h = await withGoal(evil);
  assert.equal(h.chip().text, evil); open(h); assert.equal(h.input().value, evil);
  h.input().value = evil; h.input().fire('input'); addContext(h).click(); contextInput(h).value = evil; assert.equal(findAll(h.rootEl, i => i.tag === 'img').length, 0);
  const source = fs.readFileSync(path.join(projectRoot, 'experiences/visual-map/view.ts'), 'utf8');
  assert.doesNotMatch(source.slice(source.indexOf('  private renderGoalBar('), source.indexOf('  // ---- Suggest new topics for the goal')), /innerHTML|outerHTML|insertAdjacentHTML/);
});

integrationTest('goal edit (counter-example 17): the bar moving to the other row during an edit keeps the draft, asks nothing and gives the keyboard back to the field', async () => {
  const h = await withGoal(); const d = withDoc(h);
  const hostA = element('div'), hostB = element('div'); h.rootEl.appendChild(hostA); h.rootEl.appendChild(hostB);
  let host = hostA; h.view.goalHostTarget = () => ({ host, before: null });
  h.rootEl.empty(); h.rootEl.appendChild(hostA); h.rootEl.appendChild(hostB);
  h.view.renderGoalBar(hostA);
  h.view.goalEdit = null; h.view.startGoalEdit({});
  const field = h.input(); field.value = 'Draft across rows'; field.fire('input'); d.doc.activeElement; field.focus();
  const bar = h.view.relevanceBarEl; Object.defineProperty(bar, 'parentElement', { get() { return this.parent; } }); bar.ownerDocument = d.doc;
  let refocused = 0; const realFocus = field.focus; field.focus = (...args) => { refocused++; return realFocus.apply(field, args); };
  host = hostB; h.view.placeGoalBar();
  assert.equal(bar.parent, hostB, 'the bar moved'); assert.equal(h.input(), field, 'the same field, with its draft'); assert.equal(field.value, 'Draft across rows');
  assert.equal(refocused, 1, 'the keyboard is given back to it');
  noAi(h, 'host switch'); assert.ok(h.view.goalEdit); assert.equal(h.control.releases, 0);
});

integrationTest('goal edit (S5, as far as the fake DOM goes): a card pressed while editing still gets its click first, the text is saved afterwards, and the press is neither stopped nor prevented', async () => {
  const h = await withGoal(); const d = withDoc(h);
  const order = [];
  const card = h.cards.get(h.ids.a); card.addEventListener('click', () => order.push('card click'));
  h.control.reply = async request => { order.push('grade'); return gradeAll(request); };
  open(h); h.input().value = 'Saved by a card press'; h.input().fire('input');
  let prevented = 0, stopped = 0;
  d.press(card, { preventDefault() { prevented++; }, stopPropagation() { stopped++; } });
  order.push('press'); assert.ok(h.input(), 'nothing happens at the press itself'); noAi(h, 'at the press');
  d.release(); order.push('release'); assert.ok(h.input(), 'nor at the release: the click is still to come'); noAi(h, 'at the release');
  card.fire('click'); order.push('after click');
  await h.settled();
  assert.deepEqual(order, ['press', 'release', 'card click', 'after click', 'grade'], 'the card got its click before the grade started');
  assert.equal(prevented + stopped, 0, 'the press was not touched'); assert.equal(await h.repo.readRelevanceGoal(MAP), 'Saved by a card press'); assert.equal(h.control.calls.length, 1);
  // A press that is cancelled (pointercancel) ends the same way.
  const g = await withGoal(); const e = withDoc(g);
  open(g); g.input().value = 'Saved after a cancel'; g.input().fire('input'); e.press(element('div')); e.cancel(); await g.settled();
  assert.equal(await g.repo.readRelevanceGoal(MAP), 'Saved after a cancel');
  // Another press starts over: only the last press ends the edit, once.
  const k = await withGoal(); const f = withDoc(k);
  open(k); k.input().value = 'Two presses'; k.input().fire('input'); f.press(element('div')); f.press(element('div')); f.release(); f.release(); await k.settled(); await later();
  assert.equal(k.control.calls.length, 1);
});

integrationTest('goal edit: a save from a press elsewhere or Tab leaves the keyboard where the user went; Enter sends it to the Stop button; pasted line breaks become spaces; the saved context goes with the goal', async () => {
  const seen = [];
  for (const how of ['enter', 'outside', 'tab']) {
    const h = await withGoal(); const d = withDoc(h);
    const real = h.view.refreshRelevance.bind(h.view); h.view.refreshRelevance = focusBar => { seen.push([how, focusBar, h.view.holdFocusOnGrade]); return real(focusBar); };
    openWithContext(h, 'First line\nsecond line');
    h.input().fire('input'); assert.equal(h.input().value, 'First line second line', 'pasted breaks became spaces');
    contextInput(h).value = 'Night shifts';
    if (how === 'enter') h.input().fire('keydown', { key: 'Enter' }); else if (how === 'tab') contextInput(h).fire('keydown', { key: 'Tab' }); else { d.press(element('div')); d.release(); }
    await until(() => h.control.calls.length); await h.settled();
    assert.equal(await h.repo.readRelevanceGoal(MAP), 'First line second line'); assert.equal((await h.repo.readRelevanceSetup(MAP)).context, 'Night shifts');
    assert.equal(h.view.holdFocusOnGrade, false, 'the hold ends with the save');
  }
  assert.deepEqual(seen.filter(s => s[1] === true).map(s => s.slice(0, 1).concat([s[2]])), [['enter', false], ['outside', true], ['tab', true]], 'the first refresh of each save asked for the Stop button; only Enter lets it have the keyboard');
});
