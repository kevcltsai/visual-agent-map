// V3.3 B08: the card toolbar from the action list (card-actions.ts CARD_TOOLBAR), the Style button wired to style-popover.ts
// and its write gates, and the entries that left the toolbar (Add subtopic, Add summary) kept in the card ⋯ and right-click.
// Harness copied from tests/steps-prompt-run.cjs (real view + repository, provider stubbed).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('./support.cjs');
const dom = require('./support-dom.cjs');
const { core, fixture, DEFAULT_SETTINGS, obsidian, withExpansionCoordinator, attachTopicRuns, until } = S;
const { element, findAll } = dom;
const contentLanguage = S.load('core/content-language.ts');
const MAP = 'Agent Workspace/Topics/map-a/Map.md';

async function harness(spec, { confirm = true } = {}) {
  const { repo, app, contents } = fixture('en');
  const mapDoc = { id: 'map-a', title: 'map-a', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  await repo.ensureTopicFolders('Agent Workspace/Topics/map-a');
  await app.vault.create(MAP, core.serializeMap(mapDoc));
  const byKey = new Map();
  for (const [key, parent, opt = {}] of spec) {
    const created = await repo.createNote(key, 'gpt-6-luna', mapDoc, MAP, 'workspace');
    if (parent) created.parentId = byKey.get(parent).id;
    Object.assign(created, { x: byKey.size * 400, y: 0 });
    mapDoc.nodes.push(created);
    byKey.set(key, created);
    const prompt = opt.prompt === undefined ? `Prompt ${key}` : opt.prompt;
    await repo.updateNote(created.path, { prompt });
    if (!opt.noAi) await repo.writeAiCard(created.path, true);
    if (opt.fresh) await repo.writeAiUpdateMode(created.path, 'fresh');
    if (opt.locked) await repo.writeAiLocked(created.path, true);
  }
  await repo.saveMap(MAP, mapDoc);
  const notices = [], menus = [], modals = [], calls = [], usage = [];
  let gate = null;
  const host = withExpansionCoordinator({
    repo, settings: { ...DEFAULT_SETTINGS, language: 'en', cliModel: 'gpt-6-luna', cliReasoning: 'low' }, running: new Set(), logs: { appendLog() {} },
    pendingSuggestions: new Map(), pendingResearchOptions: new Map(), rebuildDerivedData: async () => {}, expansionBatches: new Map(),
    recordFailure: (_l, e) => String(e?.message ?? e), views: () => [], mutate: async work => work(), releaseOutline() {}, setOutlineActive() {}, detailsShown: () => false,
    openDetails: async () => {}, invalidateLivingTrial() {}, restoreLivingOfficial: async () => {}, showLivingTrial: async () => {},
    confirmAiUsage: async (model, run) => { usage.push(model); if (!confirm) return false; await run(); return true; },
    askModel: async (_c, _m, _r, signal, _x, accepted) => {
      accepted?.();
      if (gate) await new Promise((resolve, reject) => { gate.push(resolve); signal?.addEventListener('abort', () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }))); });
      return { summary: 's', detail: 'd', visualReferences: [], suggestions: [] };
    }
  });
  repo.settings = host.settings;
  class Menu {
    constructor() { this.items = []; menus.push(this); }
    addItem(cb) { const item = { title: '', checked: undefined, click: null }; cb({ setTitle(v) { item.title = v; return this; }, setIcon() { return this; }, setChecked(v) { item.checked = v; return this; }, onClick(fn) { item.click = fn; return this; }, setWarning() { return this; } }); this.items.push(item); return this; }
    addSeparator() { this.items.push({ separator: true }); return this; } showAtMouseEvent() { return this; } showAtPosition() { return this; }
  }
  const Modal = dom.makeModal();
  const { VisualAgentMapView, setLivingIdentityStore: setViewIdentityStore, livingCoordinator: viewCoordinator } = S.load('tests/support-view-identity-entry.ts', { obsidian: { ...obsidian, Notice: dom.makeNotice(notices), Modal, Menu } }, { createFragment: dom.createFragment, CSS: { escape: v => v }, createSvg: dom.createSvg, createEl: (tag, value) => element(tag, value), createSpan: value => element('span', typeof value === 'string' ? { cls: value } : value), requestAnimationFrame: () => 1, cancelAnimationFrame() {} });
  const view = new VisualAgentMapView({ app }, attachTopicRuns(host));
  view.armHighlightFade = () => {};
  const hydrate = async () => { view.notes = new Map(await Promise.all(mapDoc.nodes.map(async n => [n.id, await repo.readNote(n.path, mapDoc)]))); };
  Object.assign(view, { path: MAP, map: mapDoc, contentEl: element('div'), stageEl: element('div'), render() {}, hydrate, ancestorContext: async () => '', queueCharts() {}, focusNode() {}, openDetails() {} });
  view.viewportEl = element('div');
  view.viewportEl.getBoundingClientRect = () => ({ left: 10, top: 5, right: 810, bottom: 605, width: 800, height: 600 });
  view.viewportEl.clientWidth = 800; view.viewportEl.clientHeight = 600;
  await hydrate();
  // Exercise the production execution path through the real Repository. Only the provider transport is stubbed.
  const plan = { fail: new Set(), errors: new Map(), reply: new Map(), hang: new Set(), pause: new Set(), waiters: [], go() { this.waiters.splice(0).forEach(resolve => resolve()); } };
  view.readMapSourceGroups = async () => [];
  host.aiCalls = { run: async (prepared, options, finish) => {
    const input = prepared.input;
    const key = JSON.parse(input.context).documents[0].title;
    calls.push({ key, input, options });
    if (plan.hang.has(key)) await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }));
    if (options.signal.aborted) throw new Error('stopped');
    if (plan.pause.has(key)) await new Promise(resolve => plan.waiters.push(resolve));
    if (plan.fail.has(key)) throw new Error('provider failed: ' + key);
    if (plan.errors.has(key)) throw plan.errors.get(key);
    if (plan.reply.has(key)) return finish(plan.reply.get(key), { signal: options.signal, parsed() {} });
    const text = 'Result: ' + key;
    const operations = input.base.output.text === text ? [] : [{ kind: 'output', text, evidence: [] }];
    return finish(JSON.stringify({ baseRevision: input.base.revision, requiresWeb: false, operations }), { signal: options.signal, parsed() {} });
  } };
  const { inspectLivingValidity } = S.load('experiences/visual-map/living-node-runtime.ts', { obsidian });
  view.hydrate = async () => {
    await hydrate();
    view.livingValidity = await inspectLivingValidity({
      app, repo, calls: host.aiCalls, mapPath: MAP, viewSession: 'test-validity',
      signal: new AbortController().signal, current: () => true,
      language: () => 'English', mapSources: async () => []
    });
  };
  // A second view of the same map on the same plugin (another pane or window).
  const otherView = async () => {
    const v = new VisualAgentMapView({ app }, attachTopicRuns(host));
    v.armHighlightFade = () => {};
    Object.assign(v, { path: MAP, map: mapDoc, contentEl: element('div'), stageEl: element('div'), render() {}, ancestorContext: async () => '', queueCharts() {}, focusNode() {}, openDetails() {} });
    v.viewportEl = view.viewportEl;
    v.readMapSourceGroups = async () => [];
    v.hydrate = async () => { v.notes = new Map(await Promise.all(mapDoc.nodes.map(async n => [n.id, await repo.readNote(n.path, mapDoc)]))); };
    await v.hydrate();
    return v;
  };
  // The round on its own, against a coordinator this test owns: used to hold a trial lease on a card.
  const runtime = S.load('experiences/visual-map/living-node-runtime.ts', { obsidian });
  const roundPort = () => {
    const seen = { settled: new Map(), boundary: undefined, failures: [] };
    const port = {
      app, repo, calls: host.aiCalls, coordinator: runtime.livingCoordinator(host), mapPath: MAP, viewSession: 'round-test',
      signal: new AbortController().signal, current: () => true, busy: () => false, language: (live, note) => contentLanguage.cardOutputLanguage(live, 'en', note.title), mapSources: async () => [],
      confirm: async (_model, work) => { await work(); return true; },
      onStart() {}, onRunning() {}, onSettled: (id, result) => seen.settled.set(id, result), onFailure: id => seen.failures.push(id),
      onTrialBoundary: boundary => { seen.boundary = boundary; }
    };
    return { port, seen, run: requested => runtime.runLivingRound(port, requested) };
  };
  const raw = key => contents.get(byKey.get(key).path);
  const node = key => byKey.get(key);
  const status = key => view.promptRuns.get(MAP)?.get(node(key).id)?.status;
  const done = () => until(() => view.promptBatch?.outcome);
  const runAll = async () => { view.startPromptRun(); };
  return { hold: () => (gate = []), repo, app, contents, view, host, calls, notices, menus, modals, usage, plan, raw, node, status, done, runAll, hydrate, mapDoc, byKey, otherView, roundPort, runtime, setViewIdentityStore, viewCoordinator };
}

const buttons = tools => findAll(tools, i => i.tag === 'button');
const has = (i, cls) => !!i.cls?.split(' ').includes(cls);
// The tool classes in order, one per button (the first vam-* class after vam-card-tool).
const kinds = tools => buttons(tools).map(b => b.cls.split(' ').find(c => c.startsWith('vam-') && c !== 'vam-card-tool'));
const paint = (h, key) => { const tools = element('div'); h.view.paintCardToolbar(tools, h.node(key)); return tools; };
const popoverIn = (h, tools) => [tools, h.view.contentEl, h.view.stageEl, h.view.viewportEl].flatMap(root => findAll(root, i => has(i, 'vam-style-popover')))[0];
const openStyle = (h, key) => {
  const tools = paint(h, key);
  const style = buttons(tools).find(b => has(b, 'vam-card-tool-style'));
  assert.ok(style, 'the toolbar has Style');
  style.click();
  const pop = popoverIn(h, tools);
  assert.ok(pop, 'Style opens the style popover');
  return { tools, style, pop, choice: id => findAll(pop, i => i.dataset?.styleChoice === id)[0] };
};
const settle = async () => { for (let i = 0; i < 6; i++) await dom.tick(); };

test('B08 toolbar: an ordinary card shows AI explore | Style | Note | More, with no Add and no Add summary', async () => {
  const h = await harness([['a', null, { noAi: true }]]);
  const tools = paint(h, 'a');
  assert.deepEqual(kinds(tools), ['vam-ai-explore', 'vam-card-tool-style', 'vam-detail-button', 'vam-card-tool-more']);
  assert.equal(buttons(tools)[0].text, 'AI explore');
  const style = buttons(tools)[1];
  assert.equal(style.attrs['aria-haspopup'], 'dialog');
  assert.ok(!buttons(tools).some(b => has(b, 'vam-add-child-tool') || has(b, 'vam-card-tool-add-summary')));
});

test('B08 toolbar: an AI card shows Run | Lock | AI explore | Settings | Note | More; running swaps Run for a red Stop; locked is pressed and says Locked', async () => {
  const h = await harness([['idle', null], ['busy', null], ['locked', null, { locked: true }]]);
  assert.deepEqual(kinds(paint(h, 'idle')), ['vam-card-tool-run', 'vam-card-tool-ai-lock', 'vam-ai-explore', 'vam-card-tool-ai-settings', 'vam-detail-button', 'vam-card-tool-more']);
  const lock = buttons(paint(h, 'idle')).find(b => has(b, 'vam-card-tool-ai-lock'));
  assert.equal(lock.attrs['aria-pressed'], 'false');
  h.view.promptRuns.set(MAP, new Map([[h.node('busy').id, { status: 'running' }]]));
  const busy = kinds(paint(h, 'busy'));
  assert.equal(busy[0], 'vam-card-tool-stop', 'running: Stop comes first');
  assert.ok(!busy.includes('vam-card-tool-run'), 'running: no Run');
  const locked = buttons(paint(h, 'locked')).find(b => has(b, 'vam-card-tool-ai-lock'));
  assert.equal(locked.attrs['aria-pressed'], 'true');
  assert.equal(locked.text, 'Locked');
});

test('B08 toolbar: read-only (notes still loading) leaves only Note and ⋯ (its rows greyed, decision #35) on an ordinary and an AI card', async () => {
  const h = await harness([['a', null, { noAi: true }], ['b', null]]);
  h.view.noteLoad = { pending: true };
  for (const key of ['a', 'b']) assert.deepEqual(kinds(paint(h, key)), ['vam-detail-button', 'vam-card-tool-more'], `${key} while loading`);
});

test('B08 style popover: changing the colour writes only the topic-color key, in one step that one undo reverts byte for byte', async () => {
  const h = await harness([['a', null, { noAi: true }]]);
  const before = h.raw('a');
  const { choice } = openStyle(h, 'a');
  choice('color-red').click();
  await until(() => h.raw('a') !== before);
  await settle();
  const after = h.raw('a');
  const lines = s => s.split('\n');
  const changed = lines(after).filter(l => !lines(before).includes(l));
  assert.deepEqual(changed.map(l => l.split(':')[0]), ['topic-color'], 'only the colour key is added');
  assert.deepEqual(lines(before).filter(l => !lines(after).includes(l)), [], 'nothing else is removed or rewritten');
  await h.view.history.undo().undo();
  assert.equal(h.raw('a'), before, 'one undo reverts it');
  assert.equal(h.view.history.canUndo, false, 'the change was one step');
});

test('B08 style popover: while the card is being merged, or read-only, a click writes nothing', async () => {
  const h = await harness([['a', null, { noAi: true }], ['kid', 'a', { noAi: true }]]);
  const before = { a: h.raw('a'), kid: h.raw('kid') };
  const merging = openStyle(h, 'a');
  h.view.isMerging = () => true;
  merging.choice('branch').checked = true; merging.choice('branch').change();
  merging.choice('color-blue').click();
  merging.choice('bold').click();
  await settle();
  assert.deepEqual({ a: h.raw('a'), kid: h.raw('kid') }, before, 'merging: no write');
  h.view.isMerging = () => false;
  const ro = openStyle(h, 'a');
  h.view.noteLoad = { pending: true };
  ro.choice('color-blue').click();
  ro.choice('size-large').click();
  await settle();
  assert.deepEqual({ a: h.raw('a'), kid: h.raw('kid') }, before, 'read-only: no write');
  h.view.noteLoad = null;
  const shown = openStyle(h, 'a');
  h.view.presentation = true;
  shown.choice('color-green').click();
  shown.choice('line-thick').click();
  await settle();
  assert.deepEqual({ a: h.raw('a'), kid: h.raw('kid') }, before, 'presentation: no write');
  assert.equal(h.view.history.canUndo, false);
});

test('B08 style popover: "whole branch" with only the subtopic merging refuses the whole write (neither card changes); without it the card alone is styled', async () => {
  const h = await harness([['a', null, { noAi: true }], ['kid', 'a', { noAi: true }]]);
  const before = { a: h.raw('a'), kid: h.raw('kid') };
  const kidId = h.node('kid').id;
  h.view.isMerging = id => id === kidId;
  const { choice } = openStyle(h, 'a');
  choice('branch').checked = true; choice('branch').change();
  choice('color-blue').click();
  choice('bold').click();
  await settle();
  assert.deepEqual({ a: h.raw('a'), kid: h.raw('kid') }, before, 'a merging subtopic blocks the branch write for both cards');
  assert.equal(h.view.history.canUndo, false);
  choice('branch').checked = false; choice('branch').change();
  choice('color-blue').click();
  await until(() => h.raw('a') !== before.a);
  await settle();
  assert.equal(h.raw('kid'), before.kid, 'the merging subtopic stays as it was');
});

test('B08 render: an ordinary card builds one action context and never looks the selection up for references; an AI card reuses its toolbar context for the Run button', async () => {
  const h = await harness([['a', null, { noAi: true }], ['b', null]]);
  h.view.labelCard = () => {};
  const count = { ctx: 0, outline: 0 };
  const ctxOf = h.view.cardActionContext.bind(h.view), outlineOf = h.view.outlineImportTarget.bind(h.view);
  h.view.cardActionContext = target => { count.ctx++; return ctxOf(target); };
  h.view.outlineImportTarget = () => { count.outline++; return outlineOf(); };
  h.view.renderNode(h.node('a'));
  assert.deepEqual(count, { ctx: 1, outline: 0 }, 'ordinary card');
  count.ctx = 0; count.outline = 0;
  h.view.renderNode(h.node('b'));
  assert.deepEqual(count, { ctx: 1, outline: 0 }, 'AI card: the Run button is drawn from the toolbar context');
  assert.ok(findAll(h.view.cardEls.get(h.node('b').id), i => has(i, 'vam-card-tool-run')).length === 1, 'the AI card still has its Run');
});

test('B08 toolbar: Add subtopic and Add summary left the toolbar and are in both the card ⋯ and its right-click menu', async () => {
  const h = await harness([['a', null, { noAi: true }]]);
  const tools = paint(h, 'a');
  const moreButton = buttons(tools).find(b => has(b, 'vam-card-tool-more'));
  moreButton.getBoundingClientRect = () => ({ left: 0, bottom: 0 });
  moreButton.click();
  const more = h.menus.at(-1).items.map(i => i.title);
  const Menu = h.menus[0].constructor;
  const context = new Menu();
  h.view.addCardMenuActions(context, h.node('a'));
  const right = context.items.map(i => i.title);
  for (const title of ['Add subtopic', 'Add summary']) {
    assert.ok(more.includes(title), `⋯ has ${title}: ${more.join(' | ')}`);
    assert.ok(right.includes(title), `right-click has ${title}: ${right.join(' | ')}`);
  }
  assert.ok(right.includes('Style…') && !more.includes('Style…'), 'Style is on the toolbar and the right-click, not in ⋯');
});

test('B08 style popover: "apply to the whole branch" styles the card and its subtopic in one step that one undo reverts', async () => {
  const h = await harness([['a', null, { noAi: true }], ['kid', 'a', { noAi: true }]]);
  const before = { a: h.raw('a'), kid: h.raw('kid') };
  const { choice } = openStyle(h, 'a');
  choice('branch').checked = true;
  choice('bold').click();
  await until(() => h.raw('kid') !== before.kid);
  await settle();
  for (const key of ['a', 'kid']) assert.match(h.raw(key), /topic-style:[\s\S]*bold/, `${key} is bold`);
  await h.view.history.undo().undo();
  assert.deepEqual({ a: h.raw('a'), kid: h.raw('kid') }, before, 'one undo reverts both');
  assert.equal(h.view.history.canUndo, false, 'the branch change was one step');
});

test('B08 toolbar (B19b-x, decision #62: the structure lock covers parent and order only): Style stays under the picture-book structure lock; the AI lock hides AI explore, Run and Settings', async () => {
  const h = await harness([['a', null, { noAi: true }], ['b', null]]);
  h.view.bookLock = () => ({ ai: false, structure: true });
  assert.deepEqual(kinds(paint(h, 'a')), ['vam-ai-explore', 'vam-card-tool-style', 'vam-detail-button', 'vam-card-tool-more']);
  h.view.bookLock = () => ({ ai: true, structure: false });
  assert.deepEqual(kinds(paint(h, 'b')), ['vam-card-tool-ai-lock', 'vam-detail-button', 'vam-card-tool-more']);
});

test('B19b-x style popover under both picture-book locks: every choice writes (colour only topic-color, the rest only topic-style, the whole branch too); Map.md unchanged', async () => {
  const h = await harness([['a', null, { noAi: true }], ['kid', 'a', { noAi: true }], ['other', null, { noAi: true }]]);
  h.view.bookLock = () => ({ ai: true, structure: true });
  const map = () => h.contents.get(MAP);
  const before = { a: h.raw('a'), kid: h.raw('kid'), other: h.raw('other'), map: map() };
  const lines = s => s.split('\n');
  const { choice } = openStyle(h, 'a');
  choice('color-red').click();
  await until(() => h.raw('a') !== before.a);
  await settle();
  assert.deepEqual(lines(h.raw('a')).filter(l => !lines(before.a).includes(l)).map(l => l.split(':')[0]), ['topic-color'], 'colour: only the topic-color key is added');
  assert.deepEqual(lines(before.a).filter(l => !lines(h.raw('a')).includes(l)), [], 'colour: nothing else is removed or rewritten');
  assert.equal(h.raw('kid'), before.kid, 'colour: the subtopic is not touched');
  assert.equal(map(), before.map, 'colour: Map.md unchanged');
  const colored = h.raw('a');
  for (const id of ['bold', 'border-thick', 'line-thick', 'size-large']) {
    const was = h.raw('a');
    choice(id).click();
    await until(() => h.raw('a') !== was);
    await settle();
  }
  assert.match(h.raw('a'), /topic-style:[\s\S]*bold[\s\S]*text-large/, 'bold, outline, line and size all written');
  const strip = s => s.replace(/^topic-style:.*(\n\s+- .*)*\n?/m, '');
  assert.equal(strip(h.raw('a')), strip(colored), 'styles: only the topic-style key changes');
  const kidBefore = h.raw('kid');
  choice('branch').checked = true; choice('branch').change();
  choice('size-small').click();
  await until(() => h.raw('kid') !== kidBefore);
  await settle();
  assert.match(h.raw('kid'), /text-small/, 'the whole branch is styled under the lock');
  assert.equal(strip(h.raw('kid')), strip(before.kid), 'branch: only topic-style changes on the subtopic');
  assert.equal(h.raw('other'), before.other, 'a card outside the branch is not touched');
  assert.equal(map(), before.map, 'Map.md unchanged (no parent, order or position change)');
});

test('B08 style popover: a refused choice puts the saved pressed state back (no colour stays pressed)', async () => {
  const h = await harness([['a', null, { noAi: true }]]);
  const before = h.raw('a');
  const { choice } = openStyle(h, 'a');
  h.view.isMerging = () => true;
  choice('color-red').click();
  await settle();
  assert.equal(h.raw('a'), before, 'no write');
  assert.equal(choice('color-red').attrs['aria-pressed'], 'false', 'red is not left pressed');
  assert.equal(choice('color-none').attrs['aria-pressed'], 'true', 'the saved "none" is pressed again');
});

test('B08 style popover: a repaint takes it out and puts it back under its card; it closes when the card is gone', async () => {
  const h = await harness([['a', null, { noAi: true }]]);
  const overlay = h.view.contentEl.createDiv('vam-canvas-overlay');
  h.view.cardEls.set(h.node('a').id, element('div'));
  const { pop } = openStyle(h, 'a');
  const inside = findAll(pop, i => i.tag === 'button')[0];
  h.view.contentEl.ownerDocument = { activeElement: inside };
  let refocused = 0; inside.focus = () => { refocused++; };
  const held = h.view.detachStylePopover();
  assert.equal(held, inside, 'it held the focus');
  assert.ok(!findAll(h.view.contentEl, i => i === pop).length, 'taken out for the repaint');
  h.view.remountStylePopover(held);
  assert.ok(overlay.children.includes(pop), 'put back into the overlay');
  assert.equal(refocused, 1, 'the focus goes back inside');
  assert.ok(h.view.styleOpen, 'still open');
  h.view.cardEls.delete(h.node('a').id);
  h.view.remountStylePopover(h.view.detachStylePopover());
  assert.equal(h.view.styleOpen, null, 'closed: the card is gone');
});
