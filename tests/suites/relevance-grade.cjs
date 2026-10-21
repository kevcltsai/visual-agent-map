// Phase 3 on the real view and repository: goal chip, AI grading run, status bar, change summary and undo.
// The AI is a fake behind the real RelevanceGradeService (strict parser included); the DOM is tests/support-dom.cjs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { integrationTest, root: projectRoot, load, core, DEFAULT_SETTINGS, fixture, withExpansionCoordinator, until, deferred, obsidian } = require('../support.cjs');
const dom = require('../support-dom.cjs');
const { hasCls, element, find, findAll, button, tick } = dom;

const MAP = 'Agent Workspace/Topics/map-a/Map.md';
const tierFor = title => ({ Body: 'core', Mind: 'support', REM: 'side', Dreams: 'support', Extra: 'support' })[title] ?? 'support';
// The default fake AI: a valid grade for every gradable card, with a reason that names the goal.
// The model speaks position ids (c1..cN in map order), never UUIDs.
const labelOf = (request, id) => `c${request.nodes.findIndex(n => n.id === id) + 1}`;
const nodeOfLabel = (request, label) => request.nodes[Number(label.slice(1)) - 1];
const gradeAll = (request, pick = tierFor) => ({ items: request.nodes.filter(n => n.parentId !== null).map(n => ({ id: labelOf(request, n.id), tier: pick(n.title), reason: `${n.title} for ${request.goal}.` })) });

const recalibrateNew = request => ({ changes: request.nodes.filter(n => n.parentId !== null && !request.previous.some(p => p.id === n.id) && !(request.pins ?? []).some(p => p.id === n.id)).map(n => ({ id: labelOf(request, n.id), tier: tierFor(n.title), reason: `${n.title} for ${request.goal}.`, anchor: null })) });

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
  class Menu { constructor() { this.items = []; menus.push(this); } addItem(cb) { const it = { separator: false }; this.items.push(it); cb({ setTitle(v) { it.title = v; return this; }, setChecked(v) { it.checked = v; return this; }, setIcon(v) { it.icon = v; return this; }, onClick(fn) { it.click = fn; return this; } }); return this; } addSeparator() { this.items.push({ separator: true }); return this; } showAtPosition(pos) { this.pos = pos; return this; } }
  const Base = dom.makeModal();
  class Modal extends Base { open() { opened.push(this); super.open(); } }
  const ctx = {};
  // A recalibrate answers with the cards that have no tier yet (none, once the map is graded).
  const control = { decline: false, calls: [], reply: async (request, _signal, prepared) => prepared.step.id.startsWith('relevance-recalibrate') ? recalibrateNew(request) : gradeAll(request), usageAsks: 0 };
  const plugin = withExpansionCoordinator({
    repo, settings, running: new Set(), abortChartJobs: () => {}, addChartsAfterWrite: () => {}, logs: { appendLog() {} }, rebuildDerivedData: () => repo.rebuildDerivedData(), relevanceGrades: new Map(), releaseOutline() {},
    mutate: async work => { await work(); await ctx.view?.hydrate(); },
    runMutation(work) { this.mutate(work).catch(() => {}); },
    confirmAiUsage: async (_model, run) => { control.usageAsks++; if (control.confirmGate) await control.confirmGate; if (control.decline) return false; await run(); return true; }
  });
  const { VisualAgentMapView } = load('main.ts', { obsidian: { ...obsidian, Modal, Notice: class { constructor(m) { notices.push(m); } }, Menu, setTooltip(el, text) { tips.set(el, text); } } });
  const gradeModule = load('core/relevance-grade-service.ts');
  const { RelevanceGradeService } = gradeModule;
  plugin.relevanceGrade = new RelevanceGradeService(async (request, signal, prepared) => {
    control.calls.push({ request, signal, step: prepared.step.id, prompt: prepared.prompt });
    const out = await control.reply(request, signal, prepared);
    return typeof out === 'string' ? out : JSON.stringify(out);
  });
  const view = new VisualAgentMapView({ app }, plugin);
  ctx.view = view;
  const rootEl = element('div');
  const reload = async () => {
    view.notes = new Map(await Promise.all(view.map.nodes.map(async n => [n.id, await repo.readNote(n.path)])));
    ({ goal: view.relevanceGoal, level: view.relevanceLevel, context: view.relevanceContext } = await repo.readRelevanceSetup(MAP));
  };
  view.path = MAP; view.map = await repo.readMap(MAP); view.contentEl = rootEl; view.focusNode = () => {}; view.hydrate = reload;
  let renders = 0;
  view.render = () => { renders++; rootEl.empty(); view.renderRelevanceStatus(rootEl); view.renderRelevanceGoalControl(rootEl.createDiv('vam-map-tools')); };
  await reload(); view.render();
  const cards = new Map(view.map.nodes.map(n => [n.id, element('div', 'vam-node')]));
  for (const [id, card] of cards) view.cardEls.set(id, card);
  const h = {
    repo, app, contents, view, plugin, ids, gradeModule, control, notices, opened, cards, rootEl, menus, tips,
    renders: () => renders,
    chip: () => find(rootEl, i => hasCls(i, 'vam-relevance-goal')),
    input: () => find(rootEl, i => hasCls(i, 'vam-relevance-goal-input')),
    bar: () => find(rootEl, i => hasCls(i, 'vam-relevance-statusbar')),
    barText: () => find(h.bar(), i => hasCls(i, 'vam-aim-status-value')).text,
    barButtons: () => findAll(h.bar() ?? element('div'), i => i.tag === 'button').map(b => b.text || b.attrs['aria-label']),
    run: () => plugin.relevanceGrades.get(MAP),
    note: key => repo.readNote(view.map.nodes.find(n => n.id === ids[key]).path),
    relevanceOf: async key => { const n = await h.note(key); return n.relevance ? [n.relevance.tier, n.relevance.reason] : undefined; },
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
const frontmatterOf = h => h.contents.get(MAP).match(/^---\n([\s\S]*?)\n---/)[1];
// The Undo button pops the history entry first and restores notes afterwards, so wait for the work as well.
const afterTravel = async h => { await until(() => h.view.history.canRedo); for (let i = 0; i < 12; i++) await tick(); };
const graded = async h => Object.values(await h.allRelevance()).filter(Boolean);

integrationTest('relevance: Set goal -> field -> Enter writes the goal and its first history entry, grades every non-top card and shows the result', async () => {
  const h = await harness();
  assert.equal(h.chip().text, 'Set goal'); assert.ok(hasCls(h.chip(), 'is-empty')); assert.equal(h.bar(), undefined, 'no status bar before any run');
  h.chip().click();
  const input = h.input();
  assert.equal(input.attrs['aria-label'], 'Map goal'); assert.equal(input.focused, true); assert.equal(h.chip().attrs['aria-expanded'], 'true', 'the panel opens under the toolbar button, which stays');
  input.value = 'Sleep better\nthrough the night'; input.fire('keydown', { key: 'Enter' });
  assert.equal(h.run().status, 'running'); assert.ok(h.chip().disabled, 'the chip is disabled while grading');
  assert.equal(h.bar().attrs['aria-live'], 'polite'); assert.equal(h.barText(), 'Grading by goal…'); assert.deepEqual(h.barButtons(), ['Stop']);
  await h.settled();
  assert.equal(await h.repo.readRelevanceGoal(MAP), 'Sleep better through the night', 'newlines are removed');
  assert.match(frontmatterOf(h), /relevance-goal-history:\n  - "\d{4}-\d{2}-\d{2}: Sleep better through the night"/);
  const request = h.control.calls[0].request;
  assert.equal(request.goal, 'Sleep better through the night'); assert.equal(request.language, 'en'); assert.equal(request.contentLanguage, 'en');
  assert.equal(request.nodes.length, 5, 'the whole map is sent, the top-level card as context');
  assert.deepEqual(Object.keys(request.nodes[0]).sort(), ['depth', 'id', 'parentId', 'status', 'summary', 'title']);
  const all = await h.allRelevance();
  assert.equal(all.root, undefined, 'the top-level card is never graded');
  for (const key of ['a', 'b', 'c', 'd']) { assert.ok(['core', 'support', 'side'].includes(all[key][0])); assert.ok(all[key][1].trim()); }
  assert.deepEqual(all.c, ['side', 'REM for Sleep better through the night.']);
  assert.equal(h.view.notes.get(h.ids.a).relevance.tier, 'core', 'the view reads the new grade');
  assert.equal(h.barText(), 'Graded 4 topics, 4 changed (0 skipped)');
  assert.deepEqual(h.barButtons(), ['View changes', 'Undo', 'Dismiss']);
  assert.equal(h.chip().text, 'Goal: Sleep better through the night'); assert.equal(h.chip().disabled, false);
  assert.equal(h.control.usageAsks, 1);
  assert.equal(h.view.history.past.length, 2, 'goal and grading are two undo steps');
});

integrationTest('relevance: the map language, not the interface language, chooses the language of the reasons', async () => {
  const h = await harness({ language: 'en', mapTitle: '要如何在陽台養香草' });
  await h.enter('養出香草'); await h.settled();
  assert.equal(h.control.calls[0].request.contentLanguage, 'zh-TW'); assert.equal(h.control.calls[0].request.language, 'en');
  assert.match(load('core/relevance-grade-service.ts').buildRelevanceGradePrompt(h.control.calls[0].request), /繁體中文/);
});

integrationTest('relevance: changing the goal appends history and regrades; the summary lists only cards whose tier or reason changed', async () => {
  const h = await harness();
  await h.enter('First goal'); await h.settled();
  // Second run: Body and Mind keep tier and reason, REM changes tier, Dreams changes only the reason.
  h.control.reply = async request => ({ items: request.nodes.filter(n => n.parentId !== null).map(n => {
    if (n.title === 'Body') return { id: labelOf(request, n.id), tier: 'core', reason: 'Body for First goal.' };
    if (n.title === 'Mind') return { id: labelOf(request, n.id), tier: 'support', reason: 'Mind for First goal.' };
    if (n.title === 'REM') return { id: labelOf(request, n.id), tier: 'core', reason: 'REM for First goal.' };
    return { id: labelOf(request, n.id), tier: 'support', reason: 'A new reason.' };
  }) });
  await h.enter('Second goal'); await h.settled();
  assert.match(h.contents.get(MAP), /- "[\d-]+: First goal"\n  - "[\d-]+: Second goal"/);
  assert.equal(h.contents.get(MAP).match(/^  - "/gm).length, 2, 'both goals are in the history');
  assert.equal(h.barText(), 'Graded 4 topics, 2 changed (0 skipped)');
  button(h.bar(), 'View changes').click();
  const modal = h.opened.at(-1);
  assert.equal(modal.titleEl.text, 'Relevance changes'); assert.ok(button(modal.modalEl, 'Close').focused, 'focus starts on Close');
  const rows = findAll(modal.contentEl, i => hasCls(i, 'vam-relevance-change'));
  assert.deepEqual(rows.map(r => find(r, i => hasCls(i, 'vam-relevance-change-title')).text), ['REM', 'Dreams']);
  const tagTexts = row => findAll(row, i => hasCls(i, 'vam-relevance-tag')).map(tag => tag.children[1].text);
  assert.deepEqual(tagTexts(rows[0]), ['Skippable', 'Must learn']); assert.deepEqual(tagTexts(rows[1]), ['Learn when needed', 'Learn when needed']);
  assert.deepEqual(rows.map(r => find(r, i => hasCls(i, 'vam-relevance-change-reason')).text), ['REM for First goal.', 'A new reason.']);
  assert.equal(find(rows[0], i => hasCls(i, 'vam-relevance-arrow')).attrs['aria-label'], 'changed to');
  assert.equal(find(modal.contentEl, i => i.tag === 'ul').attrs['aria-label'], 'Relevance changes');
  assert.deepEqual([...h.cards].filter(([, card]) => hasCls(card, 'vam-structure-suggested')).map(([id]) => id).sort(), [h.ids.c, h.ids.d].sort(), 'changed cards are marked');
  modal.close();
  assert.equal([...h.cards.values()].filter(card => hasCls(card, 'vam-structure-suggested')).length, 0, 'closing clears the marks');
});

integrationTest('relevance: a first grade shows "Not graded" as the old tag; Enter on an unchanged setup recalibrates with no history entry and nothing to change', async () => {
  const h = await harness();
  await h.enter('Goal'); await h.settled();
  button(h.bar(), 'View changes').click();
  assert.equal(find(h.opened.at(-1).contentEl, i => hasCls(i, 'vam-relevance-ungraded')).text, 'Not graded');
  await h.enter('Goal'); await h.settled();
  assert.equal(h.control.calls.length, 2, 'asked again');
  assert.equal(h.control.calls[1].step, 'relevance-recalibrate', 'same goal, level and context after an AI grade: recalibrate, not a full grade');
  assert.equal(h.control.calls[1].request.previous.length, 4, 'the current AI tiers are sent');
  assert.equal(h.contents.get(MAP).match(/^  - "/gm).length, 1, 'no new history entry');
  assert.equal(h.view.history.past.length, 2, 'no new goal undo step either');
  assert.equal(h.barText(), 'No topics needed adjusting'); assert.deepEqual(h.barButtons(), ['Dismiss']);
});

integrationTest('relevance: one undo restores every graded note (absent before means removed); the goal is a separate undo step', async () => {
  const h = await harness();
  await h.repo.writeRelevance(h.view.map.nodes.find(n => n.id === h.ids.a).path, { tier: 'side', reason: 'Old reason.' });
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
  assert.equal(await h.repo.readRelevanceGoal(MAP), 'Goal'); assert.equal((await h.relevanceOf('c'))?.[0], 'side', 'redo grades again');
});

integrationTest('relevance: undo and redo never overwrite a note the owner edited after grading; they say how many were left', async () => {
  const h = await harness();
  await h.enter('Goal'); await h.settled();
  const afterGrading = await h.allRelevance();
  const dreams = h.view.map.nodes.find(n => n.id === h.ids.d);
  await h.repo.writeRelevance(dreams.path, { tier: 'side', reason: 'My own opinion.' });
  button(h.bar(), 'Undo').click(); await afterTravel(h);
  assert.deepEqual(await h.relevanceOf('d'), ['side', 'My own opinion.'], 'the owner edit stays');
  assert.equal(await h.relevanceOf('a'), undefined); assert.equal(await h.relevanceOf('c'), undefined, 'the untouched notes are put back');
  assert.deepEqual(h.notices, ['1 topics were edited after grading and were left as they are.']);
  h.notices.length = 0;
  await h.view.travel(true);
  assert.deepEqual(await h.relevanceOf('d'), ['side', 'My own opinion.'], 'redo leaves it alone too');
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
  assert.equal(h.bar(), undefined, 'the status can be dismissed'); assert.equal(h.chip().text, 'Goal: Goal');
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
  assert.ok(h.chip().disabled, 'the chip is disabled during the wait');
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
    'an unknown card': r => { const o = gradeAll(r); o.items.push({ id: 'ghost', tier: 'core', reason: 'x' }); return o; },
    'the top-level card': r => { const o = gradeAll(r); o.items.push({ id: 'c1', tier: 'core', reason: 'x' }); return o; },
    'a bad tier': r => { const o = gradeAll(r); o.items[0].tier = 'must'; return o; },
    'a blank reason': r => { const o = gradeAll(r); o.items[0].reason = '  '; return o; },
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
    if (name === 'a child above its parent') assert.equal(h.barText(), "Grading failed. No topic was changed. The AI's parent-child tiers were still inconsistent. Click Goal, then press Enter to try again.", name);
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
  assert.equal(h.chip().disabled, false, 'the chip can be used again');
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
  await h.repo.writeRelevance(h.view.map.nodes.find(n => n.id === h.ids.c).path, { tier: 'core', reason: 'Old grade for REM.' });
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
  assert.deepEqual(await h.relevanceOf('a'), ['core', 'Body for Goal.']);
  assert.equal(await h.relevanceOf('b'), undefined, 'renamed: skipped'); assert.deepEqual(await h.relevanceOf('c'), ['core', 'Old grade for REM.'], 'moved: the old grade stays');
  assert.equal((await h.repo.readNote(extra.path)).relevance, undefined, 'added later: ungraded');
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

integrationTest('relevance: Esc and focus leaving the group cancel, an empty Enter never reaches the AI, and Esc returns focus to the chip', async () => {
  const h = await harness();
  h.chip().click(); h.input().value = 'ignored'; h.input().fire('keydown', { key: 'Escape' }); await tick();
  assert.equal(h.input(), undefined); assert.equal(h.chip().focused, true); assert.equal(h.chip().text, 'Set goal');
  h.chip().click(); h.input().value = 'ignored too'; h.input().fire('focusout', { relatedTarget: null }); await tick();
  assert.equal(h.input(), undefined); assert.equal(h.chip().text, 'Set goal');
  h.chip().click(); h.input().value = '   '; h.input().fire('keydown', { key: 'Enter' }); await tick();
  assert.equal(h.input(), undefined, 'the field closes'); assert.equal(h.chip().focused, true);
  assert.equal(h.control.calls.length, 0); assert.equal(h.control.usageAsks, 0); assert.equal(h.run(), undefined);
  assert.equal(await h.repo.readRelevanceGoal(MAP), undefined, 'no goal written either');
  // A blur after Enter must not cancel the run that Enter started.
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

integrationTest('relevance: AIM maps and the built-in sample have no goal entry and never grade', async () => {
  const h = await harness();
  h.view.map.aim = { runs: [] };
  await h.view.submitRelevanceGoal('Goal'); assert.equal(h.control.calls.length, 0); assert.equal(h.run(), undefined); assert.equal(await h.repo.readRelevanceGoal(MAP), undefined);
  h.view.map.aim = undefined; h.view.builtIn = true;
  await h.view.submitRelevanceGoal('Goal'); assert.equal(h.control.calls.length, 0); assert.equal(await h.repo.readRelevanceGoal(MAP), undefined);
  // The toolbar entry and the bar sit behind the same guards in the real render.
  const source = fs.readFileSync(path.join(projectRoot, 'experiences/visual-map/view.ts'), 'utf8');
  assert.match(source, /if \(!aimMode\) \{[\s\S]{0,1400}this\.renderRelevanceGoalControl\(tools\);/);
  assert.match(source, /if \(!this\.builtIn && !this\.map\.aim\) this\.renderRelevanceStatus\(this\.contentEl\);/);
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

integrationTest('relevance: the goal chip is named "Goal: <goal>" for assistive tech, and "Set goal" when empty (zh too)', async () => {
  const h = await harness();
  assert.equal(h.chip().attrs['aria-label'], 'Set goal');
  await h.enter('Sleep better'); await h.settled();
  assert.equal(h.chip().attrs['aria-label'], 'Goal: Sleep better');
  // The view builds the name from these two keys; each bundle has its own language, so check the zh strings directly.
  const { translate } = load('i18n.ts');
  assert.equal(translate('zh-TW', 'ui.relevance_goal_0', '睡得更好'), '目標：睡得更好');
  assert.equal(translate('zh-TW', 'ui.relevance_goal_set'), '設定目標');
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

// ---- Phase 4: level and context in the same inline group ----------------------------------------------------------
const select = h => find(h.rootEl, i => hasCls(i, 'vam-relevance-level'));
const contextInput = h => find(h.rootEl, i => hasCls(i, 'vam-relevance-context-input'));
const gradeButton = h => find(h.rootEl, i => hasCls(i, 'vam-relevance-grade-button'));
const group = h => find(h.rootEl, i => hasCls(i, 'vam-relevance-setup'));
const open = h => { h.chip().click(); return h.input(); };

integrationTest('relevance: the chip expands into one group: goal, a dropdown level, an optional context and a quiet button (en)', async () => {
  const h = await harness();
  open(h);
  assert.equal(group(h).attrs.role, 'group'); assert.equal(group(h).attrs['aria-label'], 'Map goal');
  assert.ok(hasCls(select(h), 'dropdown'), 'the Obsidian dropdown class');
  assert.deepEqual(select(h).children.map(o => [o.text, o.optionValue]), [['Not set', ''], ['Beginner', 'beginner'], ['Some background', 'intermediate'], ['Familiar', 'familiar']]);
  assert.equal(select(h).value, ''); assert.equal(select(h).attrs['aria-label'], 'Your level');
  assert.equal(contextInput(h).attrs.placeholder, 'Optional: what you already know, conditions or limits'); assert.equal(contextInput(h).attrs['aria-label'], 'Extra context');
  assert.equal(contextInput(h).maxLength, 200);
  assert.equal(gradeButton(h).text, 'Grade with this'); assert.equal(h.input().focused, true, 'focus starts on the goal');
});

integrationTest('relevance: goal, level and context are saved in one write, sent to the AI, and are one undo step; grading stays its own step', async () => {
  const h = await harness();
  open(h); h.input().value = 'Grow herbs'; select(h).value = 'beginner'; contextInput(h).value = '  Half a day\nof sun  ';
  contextInput(h).fire('keydown', { key: 'Enter' }); await h.settled();
  assert.match(frontmatterOf(h), /relevance-goal: "Grow herbs"\nrelevance-level: "beginner"\nrelevance-context: "Half a day of sun"/);
  const request = h.control.calls[0].request;
  assert.equal(request.goal, 'Grow herbs'); assert.equal(request.level, 'beginner'); assert.equal(request.context, 'Half a day of sun');
  assert.match(load('core/relevance-grade-service.ts').buildRelevanceGradePrompt(request), /Learner level \(JSON string[^\n]*: "beginner"\nLearner context \(JSON string, or null\): "Half a day of sun"\n/);
  assert.equal(h.view.history.past.length, 2, 'one setup step plus one grading step');
  assert.equal(h.chip().text, 'Goal: Grow herbs · Beginner'); assert.equal(h.chip().attrs['aria-label'], 'Goal: Grow herbs · Beginner');
  const history = h.contents.get(MAP).match(/^  - "/gm); assert.equal(history.length, 1, 'the history records the goal only');
  assert.doesNotMatch(h.contents.get(MAP), /relevance-goal-history:[\s\S]*Half a day/);
  button(h.bar(), 'Undo').click(); await afterTravel(h);
  await h.view.travel(false);
  assert.doesNotMatch(h.contents.get(MAP), /relevance-(goal|level|context)/, 'the second undo removes all three keys together');
  await h.view.travel(true);
  assert.match(frontmatterOf(h), /relevance-goal: "Grow herbs"\nrelevance-level: "beginner"\nrelevance-context: "Half a day of sun"/);
});

integrationTest('relevance: only a level or context change is one undo step without a new history entry; an unchanged setup regrades with none', async () => {
  const h = await harness();
  await h.enter('Goal'); await h.settled();
  assert.equal(h.view.history.past.length, 2);
  open(h); select(h).value = 'familiar'; h.input().fire('keydown', { key: 'Enter' }); await h.settled();
  assert.equal(h.view.history.past.length, 3, 'a level change adds one setup step; the regrade changed no card, so no grading step');
  assert.equal(h.contents.get(MAP).match(/^  - "/gm).length, 1, 'no history entry: the goal is the same');
  assert.equal(h.control.calls.at(-1).request.level, 'familiar'); assert.equal(h.control.calls.at(-1).request.context, undefined);
  open(h); assert.equal(select(h).value, 'familiar', 'the saved level is preselected'); h.input().fire('keydown', { key: 'Enter' }); await h.settled();
  assert.equal(h.control.calls.length, 3, 'regraded'); assert.equal(h.view.history.past.length, 3, 'nothing changed: no setup step, no grading step');
  // Clearing the level and the context removes their keys.
  open(h); select(h).value = ''; contextInput(h).value = '   '; h.input().fire('keydown', { key: 'Enter' }); await h.settled();
  assert.doesNotMatch(h.contents.get(MAP), /relevance-(level|context)/); assert.equal(h.chip().text, 'Goal: Goal');
  assert.equal(h.control.calls.at(-1).request.level, undefined);
});

integrationTest('relevance: the button confirms; its press cannot count as leaving the group; Tab inside the group does not cancel', async () => {
  const h = await harness();
  open(h); h.input().value = 'Via button';
  let prevented = 0; gradeButton(h).fire('mousedown', { preventDefault() { prevented++; } });
  assert.equal(prevented, 1, 'mousedown on the button keeps focus in the field');
  // Tab from the goal to the select, to the context, to the button: focus stays inside the group.
  h.input().fire('focusout', { relatedTarget: select(h) }); select(h).fire('focusout', { relatedTarget: contextInput(h) });
  contextInput(h).fire('focusout', { relatedTarget: gradeButton(h) });
  assert.ok(group(h), 'still open'); assert.equal(h.control.calls.length, 0);
  gradeButton(h).click(); await h.settled();
  assert.equal(await h.repo.readRelevanceGoal(MAP), 'Via button'); assert.equal(h.control.calls.length, 1);
  // Leaving to somewhere outside (or to nowhere) cancels, from any control.
  const outside = element('button');
  for (const [name, pick] of [['context', contextInput], ['select', select], ['button', gradeButton]]) {
    open(h); assert.ok(group(h)); pick(h).fire('focusout', { relatedTarget: outside }); await tick();
    assert.equal(group(h), undefined, `${name}: focus left the group`); assert.equal(h.control.calls.length, 1);
  }
});

integrationTest('relevance: Esc cancels from any control, an IME-confirming Enter in either text field is ignored, and an empty goal never reaches the AI', async () => {
  const h = await harness();
  for (const pick of [h.input, select, contextInput, gradeButton]) {
    open(h); pick(h).fire('keydown', { key: 'Escape' }); await tick();
    assert.equal(group(h), undefined); assert.equal(h.chip().focused, true, 'focus returns to the chip');
  }
  open(h); h.input().value = 'Goal'; h.input().fire('keydown', { key: 'Enter', isComposing: true }); contextInput(h).fire('keydown', { key: 'Enter', isComposing: true });
  assert.ok(group(h), 'composition Enter does nothing'); assert.equal(h.control.calls.length, 0);
  select(h).fire('keydown', { key: 'Enter' }); assert.ok(group(h), 'Enter on the dropdown does not submit');
  h.input().value = '  '; contextInput(h).value = 'only context'; contextInput(h).fire('keydown', { key: 'Enter' }); await tick();
  assert.equal(group(h), undefined); assert.equal(h.control.calls.length, 0); assert.equal(h.control.usageAsks, 0);
  assert.equal(await h.repo.readRelevanceGoal(MAP), undefined, 'nothing written for a blank goal');
  open(h); h.input().value = ' '; gradeButton(h).click(); await tick();
  assert.equal(h.control.calls.length, 0, 'an empty goal through the button is ignored too');
});

integrationTest('relevance: while a run is going the chip is disabled and no group opens', async () => {
  const h = await harness();
  const gate = deferred(); h.control.reply = request => gate.promise.then(() => gradeAll(request));
  await h.enter('Goal'); await until(() => h.control.calls.length);
  assert.ok(h.chip().disabled); const before = h.renders();
  h.view.editRelevanceGoal(h.rootEl); assert.equal(group(h), undefined, 'a running map opens no group');
  assert.equal(h.renders(), before);
  gate.resolve(); await h.settled();
});

integrationTest('relevance: the level and context keys survive map saves, read back only when valid, and the context is capped at 200', async () => {
  const h = await harness();
  open(h); h.input().value = 'Goal'; select(h).value = 'intermediate'; contextInput(h).value = 'c'.repeat(260); h.input().fire('keydown', { key: 'Enter' }); await h.settled();
  assert.equal((await h.repo.readRelevanceSetup(MAP)).context.length, 200);
  const map = await h.repo.readMap(MAP); map.viewport = { x: 1, y: 2, zoom: 1.5 }; await h.repo.saveMap(MAP, map);
  assert.deepEqual({ ...(await h.repo.readRelevanceSetup(MAP)), context: '' }, { goal: 'Goal', level: 'intermediate', context: '' });
  h.contents.set(MAP, h.contents.get(MAP).replace('relevance-level: "intermediate"', 'relevance-level: "expert"'));
  assert.equal((await h.repo.readRelevanceSetup(MAP)).level, undefined, 'an unrecognised level reads as not set');
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
    const o = gradeAll(request);
    o.items.find(i => nodeOfLabel(request, i.id).title === 'Dreams').reason = 'Dreams, fixed.';
    return o;
  };
  await h.enter('Goal'); await h.settled();
  assert.deepEqual(h.control.calls.map(c => c.step), ['relevance-grade', 'relevance-grade-repair']);
  const mind = labelOf(h.control.calls[0].request, h.ids.b), dreams = labelOf(h.control.calls[0].request, h.ids.d);
  assert.doesNotMatch(h.control.calls[1].prompt, new RegExp(h.ids.b), 'the repair prompt carries no real id');
  assert.ok(h.control.calls[1].prompt.includes(`{"childId":"${dreams}","childTier":"core","parentId":"${mind}","parentTier":"support","ancestors":[{"id":"${mind}","tier":"support"}`), 'the pair and its ancestor chain (parent first) are in the repair prompt');
  assert.equal(seen[2], 'Fixing parent-child order…', 'the bar shows the repair text while it runs');
  assert.equal(h.run().status, 'done'); assert.equal(h.barText(), 'Graded 4 topics, 4 changed (0 skipped)');
  assert.deepEqual(await h.relevanceOf('d'), ['support', 'Dreams, fixed.']);
  assert.equal(h.view.history.past.length, 2, 'goal step plus ONE grading step');
  assert.equal(h.control.usageAsks, 1, 'one usage notice for both requests');
});

integrationTest('relevance repair: still violating after TWO repair rounds writes nothing, sends no third repair and shows a plain error bar without ids', async () => {
  const h = await harness();
  h.control.reply = async request => dreamsAboveParent(request);
  await h.enter('Goal'); await h.settled();
  assert.deepEqual(h.control.calls.map(c => c.step), ['relevance-grade', 'relevance-grade-repair', 'relevance-grade-repair'], 'at most two repair rounds');
  assert.equal(h.run().status, 'failed');
  assert.equal(h.barText(), "Grading failed. No topic was changed. The AI's parent-child tiers were still inconsistent. Click Goal, then press Enter to try again.");
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
  for (const [key, tier] of [['a', 'side'], ['b', 'core'], ['c', 'core'], ['d', 'support']]) view.notes.get(h.ids[key]).relevance = { tier, reason: 'r' };
  open(h);
  const toggle = find(h.rootEl, i => hasCls(i, 'vam-relevance-sort'));
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
  assert.equal(saved.x, real.x + 340);
  assert.equal(saved.y, Math.max(...siblingsBefore.map(n => n.y)) + 220, 'below the real siblings');
  const realAfter = (await h.saved()).find(n => n.id === real.id);
  assert.deepEqual([realAfter.x, realAfter.y], [real.x, real.y], 'the parent keeps its saved position');
});

// ---- Phase 6: one toolbar button + popover panel ------------------------------------------------------------------
const panelOf = h => find(h.rootEl, i => hasCls(i, 'vam-relevance-panel'));
const sortRow = h => find(h.rootEl, i => hasCls(i, 'vam-relevance-sort'));
const fakeDoc = () => { const doc = { activeElement: null, listeners: {}, addEventListener(n, f) { (this.listeners[n] ??= []).push(f); }, removeEventListener(n, f) { this.listeners[n] = (this.listeners[n] ?? []).filter(x => x !== f); } }; return doc; };

integrationTest('relevance toolbar: one button, label states, aria-expanded and aria-controls; no separate goal line or sort chip', async () => {
  const h = await harness();
  const chip = h.chip();
  assert.equal(chip.text, 'Set goal'); assert.equal(chip.attrs['aria-expanded'], 'false'); assert.ok(chip.attrs['aria-controls']);
  assert.equal(findAll(h.rootEl, i => i.tag === 'button' && hasCls(i, 'vam-relevance-goal')).length, 1);
  assert.equal(sortRow(h), undefined, 'no sort chip in the toolbar; it lives in the panel');
  assert.equal(findAll(h.rootEl, i => hasCls(i, 'vam-relevance-goal-slot')).length, 0);
  chip.click();
  assert.equal(h.chip().attrs['aria-expanded'], 'true'); assert.equal(panelOf(h).attrs.id, h.chip().attrs['aria-controls']);
  h.chip().click();
  assert.equal(panelOf(h), undefined, 'a second click closes it'); assert.equal(h.chip().attrs['aria-expanded'], 'false'); assert.equal(h.chip().focused, true);
  h.view.relevanceGoal = 'Sleep better'; h.view.relevanceLevel = 'intermediate'; h.view.relevanceContext = 'Night shifts'; h.view.render();
  assert.equal(h.chip().text, 'Goal: Sleep better · Some background'); assert.equal(h.chip().attrs['aria-label'], 'Goal: Sleep better · Some background');
  assert.equal(h.chip().attrs['aria-description'], 'Change the goal and grade again');
  assert.equal(h.chip().iconName, undefined);
  assert.equal(findAll(h.chip(), i => hasCls(i, 'vam-relevance-sort-icon')).length, 0, 'no indicator while sorting is off');
});

integrationTest('relevance toolbar: the panel order is goal, level + context row, grade button, divider, sort switch row', async () => {
  const h = await harness();
  open(h);
  const kids = panelOf(h).children;
  assert.deepEqual(kids.map(c => c.cls.split(' ')[0]), ['vam-relevance-setup', 'vam-relevance-divider', 'vam-relevance-sort']);
  assert.deepEqual(group(h).children.map(c => c.cls.split(' ')[0]), ['vam-relevance-goal-input', 'vam-relevance-setup-row', 'vam-relevance-grade-button']);
  assert.ok(hasCls(gradeButton(h), 'mod-cta')); assert.equal(sortRow(h).tag, 'button');
  assert.match(texts(sortRow(h)).join('|'), /Sort by relevance\|Within each group, show Must learn first, then Learn when needed, then Skippable/);
});
const texts = root => findAll(root, i => i.text).map(i => i.text);

integrationTest('relevance toolbar: Esc, an outside press and focus leaving each close the panel without submitting; the outside press and focus leaving do not steal focus', async () => {
  const h = await harness();
  const doc = fakeDoc(); h.rootEl.ownerDocument = doc; h.rootEl.root = doc;
  open(h); h.input().value = 'Not submitted';
  h.input().fire('keydown', { key: 'Escape' });
  assert.equal(panelOf(h), undefined); assert.equal(h.chip().focused, true); assert.equal(doc.listeners.pointerdown.length, 0, 'the document listener is removed');
  assert.equal(h.control.calls.length, 0); assert.equal(h.chip().attrs['aria-expanded'], 'false');
  h.chip().focused = false;
  open(h); assert.equal(doc.listeners.pointerdown.length, 1);
  doc.listeners.pointerdown[0]({ target: panelOf(h) }); assert.ok(panelOf(h), 'a press inside the panel keeps it open');
  doc.listeners.pointerdown[0]({ target: h.chip() }); assert.ok(panelOf(h), 'the toolbar button toggles it itself');
  doc.listeners.pointerdown[0]({ target: element('div', 'vam-viewport') });
  assert.equal(panelOf(h), undefined, 'a press on the canvas closes it'); assert.equal(h.chip().focused, false);
  open(h); sortRow(h).fire('focusout', { relatedTarget: h.chip() }); assert.ok(panelOf(h), 'focus moving to the button is not leaving');
  sortRow(h).fire('focusout', { relatedTarget: null }); assert.equal(panelOf(h), undefined);
  assert.equal(h.control.calls.length, 0); assert.equal(h.control.usageAsks, 0); assert.equal(await h.repo.readRelevanceGoal(MAP), undefined, 'nothing was written');
});

integrationTest('relevance toolbar: submit closes the panel, disables the button while grading and submits once', async () => {
  const h = await harness();
  const gate = deferred(); h.control.reply = request => gate.promise.then(() => gradeAll(request));
  open(h); h.input().value = 'Goal via panel'; gradeButton(h).click();
  assert.equal(panelOf(h), undefined); assert.ok(h.chip().disabled); assert.equal(h.chip().attrs['aria-expanded'], 'false');
  await until(() => h.control.calls.length); assert.equal(h.control.calls.length, 1);
  gate.resolve(); await h.settled(); assert.equal(h.chip().text, 'Goal: Goal via panel');
});

integrationTest('relevance toolbar: toggling the sort switch inside the panel keeps the panel and your typing, shows the indicator and the accessible name, and writes nothing', async () => {
  const h = await harness();
  const { view } = h;
  for (const [key, tier] of [['a', 'side'], ['b', 'core']]) view.notes.get(h.ids[key]).relevance = { tier, reason: 'r' };
  const before = h.contents.get(MAP), writes = [];
  const create = h.app.vault.create, modify = h.app.vault.modify; h.app.vault.create = (...a) => { writes.push(a[0]); return create.apply(h.app.vault, a); }; h.app.vault.modify = (...a) => { writes.push(a[0]); return modify.apply(h.app.vault, a); };
  view.renderPreservingFocus = () => view.render();
  open(h); h.input().value = 'Half typed'; h.input().fire('input');
  sortRow(h).click();
  assert.ok(panelOf(h), 'the panel stays open'); assert.equal(h.chip().attrs['aria-expanded'], 'true');
  assert.equal(sortRow(h).attrs['aria-pressed'], 'true'); assert.equal(h.input().value, 'Half typed', 'the draft survives the repaint');
  const icon = findAll(h.chip(), i => hasCls(i, 'vam-relevance-sort-icon'))[0];
  assert.ok(icon, 'a drawn indicator on the button'); assert.equal(icon.iconName, 'arrow-down-wide-narrow'); assert.ok(hasCls(h.chip(), 'is-sorted'));
  assert.equal(h.chip().attrs['aria-label'], 'Set goal (sorted by relevance)');
  assert.equal(h.contents.get(MAP), before); assert.deepEqual(writes, [], 'no file write');
  sortRow(h).click(); assert.equal(sortRow(h).attrs['aria-pressed'], 'false'); assert.equal(h.chip().attrs['aria-label'], 'Set goal');
  assert.equal(findAll(h.chip(), i => hasCls(i, 'vam-relevance-sort-icon')).length, 0);
  assert.equal(view.relevanceSortOn(), false); assert.deepEqual(writes, []);
  h.app.vault.create = create; h.app.vault.modify = modify;
});

integrationTest('relevance toolbar: the zh-TW strings for the sorted state and the toolbar button', async () => {
  const { translate } = load('i18n.ts');
  assert.equal(translate('zh-TW', 'ui.relevance_sorted_suffix'), '（已依重要度排序）');
  assert.equal(translate('en', 'ui.relevance_sorted_suffix'), ' (sorted by relevance)');
});

integrationTest('relevance toolbar: the panel is a dialog; the sort hint uses the same tier words as the card tags (en and zh)', async () => {
  const h = await harness();
  assert.equal(h.chip().attrs['aria-haspopup'], 'dialog'); open(h);
  assert.equal(panelOf(h).attrs.role, 'dialog'); assert.equal(panelOf(h).attrs['aria-label'], 'Goal');
  const { translate } = load('i18n.ts');
  for (const [lang, words] of [['en', ['Must learn', 'Learn when needed', 'Skippable']], ['zh-TW', ['必學', '需要時學', '可跳過']]]) {
    const hint = translate(lang, 'ui.relevance_sort_hint');
    assert.deepEqual(['core', 'support', 'side'].map(k => translate(lang, `ui.relevance_${k}`)), words);
    let at = -1; for (const w of words) { const i = hint.indexOf(w); assert.ok(i > at, `${lang}: "${w}" in order`); at = i; }
    assert.doesNotMatch(hint, /核心|支援|旁支|core topics|supporting|side topics/);
  }
  assert.equal(translate('zh-TW', 'ui.relevance_panel_label'), '目標');
});

integrationTest('relevance toolbar: focus leaving the button to outside both closes the panel without submitting', async () => {
  const h = await harness();
  open(h); h.input().value = 'Not submitted';
  h.chip().fire('focusout', { relatedTarget: gradeButton(h) }); assert.ok(panelOf(h), 'moving into the panel keeps it open');
  h.chip().fire('focusout', { relatedTarget: h.chip() }); assert.ok(panelOf(h), 'staying on the button keeps it open');
  h.chip().fire('focusout', { relatedTarget: element('button') });
  assert.equal(panelOf(h), undefined); assert.equal(h.chip().attrs['aria-expanded'], 'false');
  assert.equal(h.control.calls.length, 0); assert.equal(await h.repo.readRelevanceGoal(MAP), undefined);
  open(h); h.chip().fire('focusout', { relatedTarget: null }); assert.equal(panelOf(h), undefined, 'focus to nowhere closes it too');
  h.chip().fire('focusout', { relatedTarget: null }); assert.equal(panelOf(h), undefined, 'nothing happens when it is already closed');
});

integrationTest('relevance toolbar: Esc on the button closes the panel without submitting and keeps focus on the button', async () => {
  const h = await harness();
  open(h); h.input().value = 'Not submitted'; h.chip().focused = false;
  let stopped = 0; h.chip().fire('keydown', { key: 'Escape', stopPropagation() { stopped++; } });
  assert.equal(panelOf(h), undefined); assert.equal(h.chip().focused, true); assert.equal(stopped, 1);
  assert.equal(h.control.calls.length, 0); assert.equal(await h.repo.readRelevanceGoal(MAP), undefined);
  let stoppedAgain = 0; h.chip().fire('keydown', { key: 'Escape', stopPropagation() { stoppedAgain++; } });
  assert.equal(stoppedAgain, 0, 'Esc on a closed panel is left to Obsidian');
});

// ---- Phase 7: change a tier by hand from the card tag ----------------------------------------------------------------
const pathOfKey = (h, key) => h.view.map.nodes.find(n => n.id === h.ids[key]).path;
const rawNote = (h, key) => h.contents.get(pathOfKey(h, key));
const manualKeys = /^relevance-(tier|reason|manual):.*\n/gm;
// Draws one real card on a stage, the way render does, and returns its tag button.
const paintCard = (h, key) => {
  h.plugin.expansionBatches ??= new Map(); h.plugin.pendingSuggestions ??= new Map(); h.plugin.detailsShown ??= () => false;
  h.view.builtIn = false; h.view.labelCard = () => {}; h.view.stageEl = element('stage'); h.view.cardEls = new Map(); h.view.tabStopId = null;
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
  assert.equal(h.view.selected, null, 'a click on the tag does not select the card'); assert.equal(detailsOpened, 0);
  assert.equal(h.opened.length, 0);
});

integrationTest('relevance manual: a hand-set tier writes only tier + manual (reason removed), then change, then clear touch only those keys; no Map.md or viewport write', async () => {
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
  assert.match(start, /relevance-reason:/);
  const stripped = text => text.replace(manualKeys, '');
  const before = h.view.map.nodes.length;
  paintCard(h, 'c').tag.click(); pick(h.menus.at(-1), 'Must learn').click(); await afterWrite();
  let now = rawNote(h, 'c');
  assert.match(now, /^relevance-tier: "core"$/m); assert.match(now, /^relevance-manual: true$/m); assert.doesNotMatch(now, /relevance-reason/);
  assert.equal(stripped(now), stripped(start), 'nothing else in the note changed');
  assert.deepEqual(JSON.parse(JSON.stringify((await h.note('c')).relevance)), { tier: 'core', reason: '', manual: true });
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

integrationTest('relevance manual: the tag tooltip and description say you set it instead of an AI reason; parent-child order is not enforced', async () => {
  const h = await harness();
  await h.enter('Goal'); await h.settled();
  assert.equal(h.tips.get(paintCard(h, 'a').tag), 'Body for Goal.');
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
  assert.deepEqual(plainOf(readRelevance({ 'relevance-tier': 'side', 'relevance-manual': true })), { tier: 'side', reason: '', manual: true });
  assert.deepEqual(plainOf(readRelevance({ 'relevance-tier': 'side', 'relevance-reason': ' r ', 'relevance-manual': false })), { tier: 'side', reason: 'r' });
  assert.equal(readRelevance({ 'relevance-tier': 'side' }), undefined, 'a tier alone still reads as nothing');
  assert.equal(readRelevance({ 'relevance-tier': 'huge', 'relevance-manual': true }), undefined);
  assert.equal(readRelevance({ 'relevance-tier': 'side', 'relevance-manual': 'true' }), undefined, 'only a real true counts');
  const { repo } = fixture('en');
  await assert.rejects(() => repo.writeRelevance('missing.md', { tier: 'core', reason: '' }), /reason is required|not found|missing/i);
});

integrationTest('relevance manual: the AI never writes a pinned (hand-set) card, whether its tier differs or not; the flag stays; undo touches only written cards', async () => {
  const h = await harness();
  const set = async (key, value) => { await h.repo.writeRelevance(pathOfKey(h, key), value); };
  await set('a', { tier: 'side', reason: '', manual: true });      // Body: AI will say core -> still untouched
  await set('b', { tier: 'support', reason: '', manual: true });   // Mind: AI will say support (same tier) -> still untouched, flag kept
  await set('c', { tier: 'support', reason: 'Old AI reason.' });   // REM: not manual, AI says side -> ordinary change
  await h.view.hydrate();
  const rawBefore = Object.fromEntries(['a', 'b', 'c', 'd'].map(k => [k, rawNote(h, k)]));
  await h.enter('Goal'); await h.settled();
  for (const key of ['a', 'b']) { assert.equal(rawNote(h, key), rawBefore[key], `${key} is byte-identical`); assert.match(rawNote(h, key), /relevance-manual: true/); assert.doesNotMatch(rawNote(h, key), /relevance-reason/); }
  assert.deepEqual(await h.allRelevance(), { root: undefined, a: ['side', ''], b: ['support', ''], c: ['side', 'REM for Goal.'], d: ['support', 'Dreams for Goal.'] });
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
  assert.deepEqual(await h.relevanceOf('c'), ['side', 'REM for Goal.']);
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
const pinNote = async (h, key, tier) => { await h.repo.writeRelevance(pathOfKey(h, key), { tier, reason: '', manual: true }); await h.view.hydrate(); };
const marked = h => [...h.cards].filter(([, card]) => hasCls(card, 'vam-structure-suggested')).map(([id]) => id).sort();
const keyOfId = (h, id) => Object.entries(h.ids).find(([, value]) => value === id)[0];
const pinsRow = h => find(h.rootEl, i => hasCls(i, 'vam-relevance-pins-row'));
const reopen = h => { h.view.closeRelevancePanel(false); return open(h); };

integrationTest('relevance recalibrate: one button; its words follow the mode (a pure draft check), the pinned count and "Hand all back to AI" show only when cards are pinned (en)', async () => {
  const h = await harness();
  open(h); assert.equal(gradeButton(h).text, 'Grade with this'); h.view.closeRelevancePanel(false);
  await h.enter('Goal'); await h.settled();
  open(h); assert.equal(gradeButton(h).text, 'Recalibrate', 'unchanged setup and the map holds an AI grade');
  h.input().value = 'Goal two'; h.input().fire('input'); assert.equal(gradeButton(h).text, 'Grade with this', 'typing a new goal switches it back at once');
  h.input().value = '  Goal \n'; h.input().fire('input'); assert.equal(gradeButton(h).text, 'Recalibrate', 'spacing alone is no change');
  select(h).value = 'beginner'; select(h).fire('change'); assert.equal(gradeButton(h).text, 'Grade with this');
  select(h).value = ''; select(h).fire('change'); assert.equal(gradeButton(h).text, 'Recalibrate');
  contextInput(h).value = 'Half a day'; contextInput(h).fire('input'); assert.equal(gradeButton(h).text, 'Grade with this');
  contextInput(h).value = '   '; contextInput(h).fire('input'); assert.equal(gradeButton(h).text, 'Recalibrate');
  assert.equal(pinsRow(h), undefined, 'no pins: no line and no hand-back button');
  await pinNote(h, 'a', 'side');
  reopen(h);
  assert.equal(find(pinsRow(h), i => i.tag === 'span').text, 'Keeping the 1 you set');
  assert.ok(button(pinsRow(h), 'Hand all back to AI'));
  assert.equal(gradeButton(h).text, 'Recalibrate');
  // Only pinned cards graded by hand: nothing for the AI to recalibrate from, so the button grades in full.
  const empty = await harness();
  await pinNote(empty, 'a', 'core'); await pinNote(empty, 'b', 'core'); await pinNote(empty, 'c', 'core'); await pinNote(empty, 'd', 'core');
  await empty.repo.writeRelevanceGoal(MAP, 'Goal'); await empty.view.hydrate();
  open(empty); assert.equal(gradeButton(empty).text, 'Grade with this');
});

integrationTest('relevance recalibrate: the AI gets the pins, the current tiers and the bounds, answers only with the moves, and only those are written (one history entry, pins untouched)', async () => {
  const h = await harness();
  await h.enter('Goal'); await h.settled();
  await pinNote(h, 'b', 'side');   // Mind pinned Skippable; Dreams (support) is now above its pinned parent
  const rawBefore = Object.fromEntries(['a', 'b', 'c', 'd'].map(k => [k, rawNote(h, k)]));
  const past = h.view.history.past.length;
  h.control.reply = async request => ({ changes: [{ id: labelOf(request, h.ids.d), tier: 'side', reason: 'Dreams follow Mind.', anchor: labelOf(request, h.ids.b) }] });
  await h.enter('Goal'); await h.settled();
  const call = h.control.calls.at(-1);
  assert.equal(call.step, 'relevance-recalibrate'); assert.equal(h.control.calls.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(call.request.pins)), [{ id: h.ids.b, tier: 'side' }]);
  assert.deepEqual(JSON.parse(JSON.stringify(call.request.previous.map(p => [keyOfId(h, p.id), p.tier]).sort())), [['a', 'core'], ['c', 'side'], ['d', 'support']], 'the current AI tiers, the pinned card is not among them');
  assert.ok(call.prompt.includes(`{"id":"${labelOf(call.request, h.ids.d)}","max":"side"}`), 'Dreams may be at most Skippable');
  assert.ok(call.prompt.includes('"pinned":true'));
  assert.deepEqual(await h.allRelevance(), { root: undefined, a: ['core', 'Body for Goal.'], b: ['side', ''], c: ['side', 'REM for Goal.'], d: ['side', 'Dreams follow Mind.'] });
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
  assert.equal(find(rows[0], i => hasCls(i, 'vam-relevance-change-reason')).text, 'Dreams follow Mind.');
  assert.deepEqual(marked(h), [h.ids.d], 'the moved card is marked on the map while the window is open');
  modal.close();
  assert.deepEqual(marked(h), [], 'closing clears the marks');
  button(h.bar(), 'Undo').click(); await afterTravel(h);
  assert.deepEqual(await h.relevanceOf('d'), ['support', 'Dreams for Goal.']);
  for (const key of ['a', 'b', 'c']) assert.equal(rawNote(h, key), rawBefore[key]);
});

integrationTest('relevance recalibrate: an answer that leaves a card outside a pin\'s bounds is sent back once; the fixed answer is what is written', async () => {
  const h = await harness();
  await h.enter('Goal'); await h.settled();
  await pinNote(h, 'b', 'side');
  const replies = [{ changes: [] }, { changes: [{ id: '', tier: 'side', reason: 'Dreams follow Mind.', anchor: null }] }];
  h.control.reply = async request => {
    const next = replies.shift();
    next.changes.forEach(change => { change.id = labelOf(request, h.ids.d); change.anchor = labelOf(request, h.ids.b); });
    return next;
  };
  await h.enter('Goal'); await h.settled();
  assert.deepEqual(h.control.calls.slice(1).map(c => c.step), ['relevance-recalibrate', 'relevance-recalibrate-repair']);
  assert.ok(h.control.calls.at(-1).prompt.includes('A pinned card cannot move'));
  assert.deepEqual(await h.relevanceOf('d'), ['side', 'Dreams follow Mind.']);
  assert.equal(h.barText(), 'Adjusted 1 topics based on your 1 settings');
});

integrationTest('relevance recalibrate: nothing to adjust says so; an entry for a pinned card is never written; a wrong reply writes nothing', async () => {
  const h = await harness();
  await h.enter('Goal'); await h.settled();
  await pinNote(h, 'a', 'side');
  const rawBefore = Object.fromEntries(['a', 'b', 'c', 'd'].map(k => [k, rawNote(h, k)]));
  h.control.reply = async request => ({ changes: [{ id: labelOf(request, h.ids.a), tier: 'core', reason: 'Body is central.', anchor: null }] });
  await h.enter('Goal'); await h.settled();
  assert.equal(h.barText(), 'No topics needed adjusting'); assert.deepEqual(h.barButtons(), ['Dismiss']);
  for (const key of ['a', 'b', 'c', 'd']) assert.equal(rawNote(h, key), rawBefore[key], `${key} byte-identical`);
  const past = h.view.history.past.length;
  h.control.reply = async () => ({ items: [] });
  await h.enter('Goal'); await h.settled();
  assert.equal(h.run().status, 'failed'); assert.match(h.barText(), /^Grading failed\. No topic was changed\./);
  for (const key of ['a', 'b', 'c', 'd']) assert.equal(rawNote(h, key), rawBefore[key]);
  assert.equal(h.view.history.past.length, past, 'a failed run adds no history');
});

integrationTest('relevance recalibrate: a card that has no tier yet must be graded in the answer; the other cards are left alone', async () => {
  const h = await harness();
  await h.enter('Goal'); await h.settled();
  await h.repo.writeRelevance(pathOfKey(h, 'c'), null); await h.view.hydrate();   // REM handed back
  h.control.reply = async request => ({ changes: [{ id: labelOf(request, h.ids.c), tier: 'support', reason: 'REM matters now.', anchor: null }] });
  await h.enter('Goal'); await h.settled();
  assert.deepEqual(await h.relevanceOf('c'), ['support', 'REM matters now.']);
  assert.equal(h.barText(), 'Graded 1 topics, 1 changed (0 skipped)', 'no pins: the plain wording');
  const missing = await harness();
  await missing.enter('Goal'); await missing.settled();
  await missing.repo.writeRelevance(pathOfKey(missing, 'c'), null); await missing.view.hydrate();
  missing.control.reply = async () => ({ changes: [] });
  await missing.enter('Goal'); await missing.settled();
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
    { id: labelOf(request, h.ids.b), tier: 'support', reason: 'Mind is useful.' },
    { id: labelOf(request, h.ids.d), tier: 'support', reason: 'Dreams ride on REM.', anchor: labelOf(request, h.ids.c) }
  ] });
  await h.enter('Goal'); await h.settled();
  const call = h.control.calls[0];
  assert.equal(call.step, 'relevance-grade');
  assert.deepEqual(JSON.parse(JSON.stringify(call.request.pins)), [{ id: h.ids.a, tier: 'side' }, { id: h.ids.c, tier: 'core' }]);
  assert.equal(call.request.previous, undefined);
  assert.ok(call.prompt.includes('never output a pinned card'));
  assert.deepEqual(await h.allRelevance(), { root: undefined, a: ['side', ''], b: ['support', 'Mind is useful.'], c: ['core', ''], d: ['support', 'Dreams ride on REM.'] });
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
  await h.enter('Goal'); await h.settled();
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

integrationTest('relevance pins: Hand all back to AI removes every pin in one mutation and one undo step; the AI grades stay', async () => {
  const h = await harness();
  await h.enter('Goal'); await h.settled();
  await pinNote(h, 'a', 'side'); await pinNote(h, 'c', 'core');
  const pinned = { a: rawNote(h, 'a'), c: rawNote(h, 'c') };
  const aiKept = { b: rawNote(h, 'b'), d: rawNote(h, 'd') };
  const past = h.view.history.past.length;
  open(h);
  button(pinsRow(h), 'Hand all back to AI').click(); await afterWrite();
  assert.equal(panelOf(h), undefined, 'the panel closes');
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
  open(h); assert.equal(pinsRow(h), undefined);
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
