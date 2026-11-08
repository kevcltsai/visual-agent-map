// Topic chat window (P1a): the component alone, driven through a fake host.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, integrationTest, root, load, core, plain, DEFAULT_SETTINGS, fixture: repoFixture, withExpansionCoordinator, until, deferred, obsidian } = require('../support.cjs');
const dom = require('../support-dom.cjs');
const { element, find, findAll, byLabel, tick } = dom;

const { TopicChatWindow } = load('experiences/visual-map/topic-chat.ts');
const { t } = load('i18n.ts');
const hasClass = (item, name) => dom.hasCls(item, name);

function fixture({ anchor, submit } = {}) {
  const doc = { activeElement: null };
  const root = element('div'); root.root = doc; root.ownerDocument = doc;
  const session = { turns: [], mode: 'quick', running: false, draftKind: null, draftText: '' };
  const watchers = [];
  const calls = { submit: [], close: 0, modes: [], opener: 0 };
  const host = {
    topicTitle: () => 'Premise',
    anchor: anchor ?? (() => null),
    session: () => session,
    subscribe: fn => { watchers.push(fn); return () => { watchers.splice(watchers.indexOf(fn), 1); }; },
    setMode: mode => { calls.modes.push(mode); session.mode = mode; watchers.slice().forEach(fn => fn()); },
    setDraft: (kind, text) => { session.draftKind = kind; session.draftText = text; },
    submit: async (kind, text) => { calls.submit.push([kind, text]); return submit ? submit(kind, text) : true; },
    close: () => { calls.close++; }
  };
  const opener = { focus: () => { calls.opener++; } };
  const win = new TopicChatWindow(host, opener, root);
  win.mount(root);
  const input = find(win.el, i => i.tag === 'textarea');
  const action = kind => find(win.el, i => i.tag === 'button' && i.text === t(`ui.topic_chat_${kind}`));
  const send = () => byLabel(win.el, t('ui.topic_chat_send'));
  const type = text => { input.value = text; input.input(); };
  const press = (key, extra = {}) => { let prevented = false; input.keydown({ key, preventDefault() { prevented = true; }, ...extra }); return prevented; };
  const refresh = () => watchers.slice().forEach(fn => fn());
  return { win, root, session, calls, input, action, send, type, press, refresh, watchers, doc };
}
const ghost = f => f.input.attrs.placeholder;

test('topic chat is a labelled dialog and the focus goes to the input', () => {
  const f = fixture();
  assert.equal(f.win.el.attrs.role, 'dialog');
  assert.equal(f.win.el.attrs['aria-label'], t('ui.topic_chat_label_0', 'Premise'));
  assert.equal(f.doc.activeElement, f.input);
});

test('topic chat counterexample 2: grey text that was not adopted cannot be sent, Tab adopts it, typing overwrites it', async () => {
  const f = fixture();
  assert.equal(f.send().disabled, true, 'nothing chosen yet');
  f.action('expand').click();
  assert.equal(f.input.value, '');
  assert.equal(ghost(f), t('ui.topic_chat_suggest_expand'));
  assert.equal(f.send().disabled, true);
  assert.equal(f.press('Enter'), true);
  f.send().click();
  await dom.tick();
  assert.deepEqual(f.calls.submit, [], 'the runner was not called');
  assert.equal(f.press('Tab'), true, 'Tab is taken over while a grey suggestion shows');
  assert.equal(f.input.value, t('ui.topic_chat_suggest_expand'));
  assert.equal(f.send().disabled, false);
  f.send().click();
  await dom.tick();
  assert.deepEqual(f.calls.submit, [['expand', t('ui.topic_chat_suggest_expand')]]);
  assert.equal(f.input.value, '', 'a started run clears the input');
  // Typing over the grey text: the typed text is what is sent.
  f.action('research').click();
  f.type('only the risks');
  assert.equal(f.send().disabled, false);
  assert.equal(f.press('Enter'), true);
  await dom.tick();
  assert.deepEqual(f.calls.submit[1], ['research', 'only the risks']);
});

test('topic chat Tab is native when there is no grey text; typing without a button is an ask, empty text is never sent', async () => {
  const f = fixture();
  assert.equal(f.press('Tab'), false);
  f.type('   ');
  assert.equal(f.send().disabled, true, 'blank text cannot be sent');
  f.press('Enter');
  await dom.tick();
  assert.deepEqual(f.calls.submit, []);
  f.type('a free question');
  assert.equal(f.send().disabled, false);
  f.press('Enter');
  await dom.tick();
  assert.deepEqual(f.calls.submit, [['ask', 'a free question']]);
  assert.equal(f.input.value, '', 'a started ask clears the input');
  f.action('research').click();
  f.type('typed');
  assert.equal(f.press('Tab'), false, 'with typed text Tab stays native');
});

test('topic chat shows an AI answer to a question through the markdown whitelist and the question as plain text', () => {
  const f = fixture();
  f.session.turns = [{ role: 'user', kind: 'ask', text: '<b>why</b>' }, { role: 'ai', text: '**yes** <script>x</script>', markdown: true }];
  f.refresh();
  const texts = findAll(f.win.el, i => hasClass(i, 'vam-topic-chat-text'));
  assert.equal(texts[0].text, '<b>why</b>'); assert.equal(texts[0].children.length, 0);
  assert.ok(texts[1].children.length > 0, 'rendered by renderChatMarkdown');
  assert.equal(findAll(texts[1], i => i.tag === 'script').length, 0);
});

test('topic chat has three equal buttons without a suggested mark', () => {
  const f = fixture();
  const buttons = findAll(f.win.el, i => hasClass(i, 'vam-topic-chat-action'));
  assert.deepEqual(buttons.map(b => b.text), [t('ui.topic_chat_research'), t('ui.topic_chat_expand'), t('ui.topic_chat_synthesize')]);
  assert.ok(buttons.every(b => b.attrs['aria-pressed'] === 'false' && b.children.length === 0 && !hasClass(b, 'is-active')));
  assert.equal(findAll(f.win.el, i => /suggested|建議/i.test(i.text)).length, 0);
  f.action('synthesize').click();
  assert.deepEqual(buttons.map(b => b.attrs['aria-pressed']), ['false', 'false', 'true']);
});

test('topic chat mode switch sets aria-pressed and a polite one-line note for the current choice only', () => {
  const f = fixture();
  const group = find(f.win.el, i => i.attrs.role === 'group');
  assert.equal(group.attrs['aria-label'], t('ui.ai_mode'));
  const [quick, standard] = findAll(group, i => i.tag === 'button');
  assert.deepEqual([quick.text, standard.text], [t('ui.quick'), t('ui.standard')]);
  assert.deepEqual([quick.attrs['aria-pressed'], standard.attrs['aria-pressed']], ['true', 'false']);
  const note = find(f.win.el, i => i.attrs['aria-live'] === 'polite');
  assert.equal(note.text, t('ui.topic_chat_mode_quick_hint'));
  standard.click();
  assert.deepEqual(f.calls.modes, ['standard']);
  assert.deepEqual([quick.attrs['aria-pressed'], standard.attrs['aria-pressed']], ['false', 'true']);
  assert.equal(note.text, t('ui.topic_chat_mode_standard_hint'));
});

test('topic chat Escape closes and gives the focus back to the opener', () => {
  const f = fixture();
  f.win.el.fire('keydown', { key: 'Escape' });
  assert.equal(f.calls.close, 1);
  assert.equal(f.calls.opener, 1);
});

test('topic chat keeps the input when the send is declined', async () => {
  const f = fixture({ submit: () => false });
  f.action('research').click();
  f.press('Tab');
  f.send().click();
  await dom.tick();
  assert.equal(f.calls.submit.length, 1);
  assert.equal(f.input.value, t('ui.topic_chat_suggest_research'));
  assert.equal(f.session.draftKind, 'research');
  assert.equal(f.send().disabled, false, 'the user can try again');
});

test('topic chat while running: shows the running line and disables the buttons and send', () => {
  const f = fixture();
  f.action('research').click();
  f.press('Tab');
  f.session.running = true;
  f.refresh();
  assert.ok(findAll(f.win.el, i => i.text === t('ui.topic_chat_running')).length === 1);
  assert.ok(['research', 'expand', 'synthesize'].every(k => f.action(k).disabled));
  assert.equal(f.send().disabled, true);
  assert.equal(f.press('Enter'), true);
  assert.deepEqual(f.calls.submit, []);
  const modes = findAll(f.win.el, i => hasClass(i, 'vam-topic-chat-mode'));
  assert.ok(modes.every(b => b.disabled));
});

test('topic chat lists turns as plain text', () => {
  const f = fixture();
  f.session.turns = [{ role: 'user', kind: 'expand', text: '<b>x</b> **y**' }, { role: 'ai', text: 'done' }];
  f.refresh();
  const texts = findAll(f.win.el, i => hasClass(i, 'vam-topic-chat-text'));
  assert.deepEqual(texts.map(i => i.text), ['<b>x</b> **y**', 'done']);
  assert.ok(texts.every(i => i.children.length === 0));
  assert.ok(findAll(f.win.el, i => i.text === t('ui.topic_chat_you_0', t('ui.topic_chat_expand'))).length === 1);
});

test('topic chat reposition: right when it fits, left when not, bottom on a narrow area, and missing geometry is tolerated', () => {
  const rects = {};
  const f = fixture({ anchor: () => rects.value });
  rects.value = null;
  f.win.reposition();
  rects.value = { card: { left: 100, top: 50, right: 270, bottom: 120 }, area: { left: 0, top: 0, right: 1000, bottom: 600 } };
  f.win.reposition();
  assert.equal(f.win.el.style.left, '278px');
  assert.equal(f.win.el.style.top, '50px');
  rects.value = { card: { left: 700, top: 50, right: 870, bottom: 120 }, area: { left: 0, top: 0, right: 1000, bottom: 600 } };
  f.win.reposition();
  assert.equal(f.win.el.style.left, '352px');
  rects.value = { card: { left: 10, top: 50, right: 100, bottom: 120 }, area: { left: 0, top: 0, right: 300, bottom: 600 } };
  f.win.reposition();
  assert.ok(hasClass(f.win.el, 'is-bottom'));
  rects.value = { card: { left: 100, top: 50, right: 270, bottom: 120 }, area: { left: 0, top: 0, right: 1000, bottom: 600 } };
  f.win.reposition();
  assert.ok(!hasClass(f.win.el, 'is-bottom'));
});

test('topic chat side placement stops above the zoom/layout controls and ignores controls it does not share columns with', () => {
  const rects = {};
  const f = fixture({ anchor: () => rects.value });
  const area = { left: 0, top: 0, right: 1000, bottom: 800 };
  const controls = { left: 600, top: 750, right: 990, bottom: 790 };
  Object.defineProperty(f.win.el, 'offsetHeight', { value: 300, configurable: true });
  Object.defineProperty(f.win.el, 'offsetWidth', { value: 340, configurable: true });
  rects.value = { card: { left: 700, top: 700, right: 870, bottom: 760 }, area, controls };
  f.win.reposition();
  assert.equal(f.win.el.style.left, '352px');
  assert.equal(f.win.el.style.top, '442px', 'bottom edge sits 8px above the controls (750-8-300)');
  rects.value = { card: { left: 100, top: 700, right: 270, bottom: 760 }, area, controls: { ...controls, left: 700 } };
  f.win.reposition();
  assert.equal(f.win.el.style.top, '500px', 'controls in other columns do not push it up (800-300)');
});

test('topic chat lifts its overlay above the controls overlay while mounted and drops it on destroy (class + CSS string check)', () => {
  const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  assert.match(css, /\.has-topic-chat\.vam-canvas-overlay\s*\{[^}]*z-index:\s*5/);
  const f = fixture();
  assert.ok(hasClass(f.root, 'has-topic-chat'));
  f.win.destroy();
  assert.ok(!hasClass(f.root, 'has-topic-chat'));
});

test('topic chat puts the Tab chip in the same grey-text line, not in its own row', () => {
  const f = fixture();
  f.action('expand').click();
  const tab = find(f.win.el, i => hasClass(i, 'vam-topic-chat-tab'));
  assert.ok(tab && !tab.hidden);
  assert.ok(hasClass(tab.parent, 'vam-topic-chat-ghost'), 'chip is inside the ghost line');
  const text = find(tab.parent, i => hasClass(i, 'vam-topic-chat-ph'));
  assert.equal(text.text, t('ui.topic_chat_suggest_expand'));
  assert.ok(find(f.win.el, i => hasClass(i, 'vam-topic-chat-composer')).children.includes(tab.parent));
  f.press('Tab');
  assert.ok(tab.hidden && tab.parent.hidden, 'adopted: grey line and chip go away');
});

test('topic chat destroy releases every listener and the host subscription', () => {
  const f = fixture();
  const all = findAll(f.win.el, () => true);
  f.win.destroy();
  assert.equal(f.watchers.length, 0);
  assert.ok(all.every(el => Object.values(el.listeners).every(list => list.length === 0)));
  assert.equal(f.root.children.includes(f.win.el), false);
});


// ---- the view: entries, submit, background -------------------------------------------------------------------------

const MAP = 'Agent Workspace/Topics/map-a/Map.md';
const outlineApi = load('experiences/visual-map/outline-import.ts', { obsidian });
const { chatSynthesisOptions } = load('experiences/visual-map/view.ts', { obsidian: { ...obsidian, MarkdownView: class {} } });
class MarkdownView {}

function page() {
  const doc = { activeElement: null };
  const rootEl = element('div'); rootEl.root = doc; rootEl.ownerDocument = doc;
  return { doc, root: rootEl };
}

/** A trimmed copy of the map-chat harness: the real view and repository, a fake render() that repaints the overlay like render() does. */
async function harness({ aim = false } = {}) {
  const { repo, app, files } = repoFixture('en');
  app.vault.configDir = '.obsidian';
  const settings = { ...DEFAULT_SETTINGS, language: 'en', cliModel: 'claude:sonnet' };
  repo.settings = settings;
  const mapDoc = { id: 'map-a', title: 'Sleep map', version: 1, nodes: [], viewport: { x: 0, y: 0, zoom: 1 } };
  await repo.ensureTopicFolders('Agent Workspace/Topics/map-a');
  const ids = {};
  const add = async (key, title, parent) => {
    const created = await repo.createNote(title, 'gpt-6-luna', mapDoc, MAP, parent ? 'inherited' : 'workspace');
    Object.assign(created, { parentId: parent ? ids[parent] : null, x: parent ? 400 : 80, y: 80 + mapDoc.nodes.length * 200 });
    mapDoc.nodes.push(created); ids[key] = created.id;
  };
  await add('root', 'Sleep'); await add('a', 'Body', 'root'); await add('b', 'Mind', 'root'); await add('c', 'REM', 'a');
  await app.vault.create(MAP, core.serializeMap(mapDoc));
  await repo.rebuildDerivedData();
  const notices = [];
  const control = { usageAsks: 0, decline: false, nested: 0, depth: 0, modals: [] };
  let queue = Promise.resolve();
  const ctx = {};
  const plugin = withExpansionCoordinator({
    repo, settings, running: new Set(), views: () => [], logs: { appendLog() {} }, rebuildDerivedData: () => repo.rebuildDerivedData(), relevanceGrades: new Map(), closeStaleDetails() {}, releaseOutline() {}, syncOutline() {}, setOutlineActive() {},
    pendingSuggestions: new Map(), pendingResearchOptions: new Map(), detailsShown: () => false, activeTasks: new Map(), quickExpandPending: new Set(), recordFailure: error => String(error?.message ?? error),
    mutate(work) {
      control.depth > 0 && control.nested++;
      const result = queue.then(async () => { control.depth++; try { await work(); await ctx.view?.hydrate(); } finally { control.depth--; } });
      queue = result.catch(() => {});
      return result;
    },
    saveSettings: async () => {}, modelLabel: model => String(model),
    aiReadyForModel: async () => true,
    confirmAiUsage: async (model, run) => { control.usageAsks++; if (control.decline) return false; await run(); return true; },
    manifest: { version: '9.9.9' }
  });
  app.workspace = { getLeavesOfType: () => [], getActiveViewOfType: () => null, requestSaveLayout() {}, on() { return {}; } };
  const Notice = dom.makeNotice(notices);
  const { VisualAgentMapView } = load('main.ts', { obsidian: { ...obsidian, MarkdownView, Notice, Modal: class { constructor(a) { this.app = a; } open() { control.modals.push(this); } close() {} }, Component: class { load() {} unload() {} } } }, { requestAnimationFrame: run => { run(); return 1; }, cancelAnimationFrame() {}, createFragment: dom.createFragment, CSS: { escape: v => String(v) } });
  const view = new VisualAgentMapView({ app }, plugin);
  ctx.view = view;
  const p = page();
  Object.assign(view, { path: MAP, contentEl: p.root, focusNode() {}, fit() {}, closed: false });
  view.map = await repo.readMap(MAP);
  if (aim) view.map.aim = { version: 1, branches: [], runs: [], pendingCommits: [] };
  const reload = async () => { view.notes = new Map(await Promise.all(view.map.nodes.map(async n => [n.id, await repo.readNote(n.path)]))); };
  view.hydrate = reload;
  let overlay = null;
  // What render() does around the topic chat window: take it out first, put it into the new overlay last.
  const repaint = () => {
    const held = view.detachTopicChat();
    p.root.empty(); overlay = p.root.createDiv('vam-canvas-overlay');
    view.remountTopicChat(held);
  };
  view.render = () => { repaint(); };
  await reload(); repaint();
  const h = {
    repo, files, app, view, plugin, ids, control, notices, Notice, page: p, repaint, overlay: () => overlay,
    node: key => view.map.nodes.find(n => n.id === ids[key]),
    saved: async () => (await repo.readMap(MAP)).nodes,
    entry: key => view.topicChatSessions.get(ids[key]),
    host: key => view.topicChatHost(h.entry(key) ?? (view.openTopicChat(h.node(key)), h.entry(key))),
    win: () => view.topicChatOpen?.win,
    texts: () => findAll(h.win().el, () => true).map(i => i.text).join('|')
  };
  return h;
}
const outlineOf = markdown => ({ markdown, nodes: outlineApi.parseOutline(markdown).nodes });
const waitFor = async predicate => { for (let i = 0; i < 800; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 5)); } throw new Error('condition not reached'); };
const finished = h => waitFor(() => h.plugin.running.size === 0 && h.plugin.activeTasks.size === 0 && !h.entry('a').session.running);
// Subtopics that count as researched, so a synthesis goes straight to the integration.
const researched = async h => { const load0 = h.view.hydrate; h.view.hydrate = async () => { await load0(); for (const note of h.view.notes.values()) note.status = 'completed'; }; await h.view.hydrate(); };
const stubResearch = h => {
  const calls = [];
  h.view.runAgent = async (node, done, failed, request, accepted) => {
    const call = { node, request, done, failed, gate: deferred() };
    calls.push(call); accepted?.();
    return { finished: call.gate.promise };
  };
  h.view.detailTemplateFor = async () => undefined;
  return calls;
};

integrationTest('topic chat counterexample 7: openTopicChat does not open while notes load, in presentation, on AIM or on a locked topic', async () => {
  const h = await harness();
  h.view.noteLoad = {}; h.view.openTopicChat(h.node('a')); assert.equal(h.win(), undefined, 'notes loading');
  h.view.noteLoad = null; h.view.presentation = {}; h.view.openTopicChat(h.node('a')); assert.equal(h.win(), undefined, 'presentation');
  h.view.presentation = null;
  h.view.notes.get(h.ids.a).aiLocked = true; h.view.openTopicChat(h.node('a'));
  assert.equal(h.win(), undefined, 'AI lock'); assert.equal(h.notices.at(-1), t('ui.ai_locked_notice'));
  h.view.notes.get(h.ids.a).aiLocked = false; h.view.openTopicChat(h.node('a'));
  assert.ok(h.win(), 'a plain topic opens'); assert.ok(find(h.overlay(), i => hasClass(i, 'vam-topic-chat')), 'in the canvas overlay');
  const aim = await harness({ aim: true });
  aim.view.openTopicChat(aim.node('a')); assert.equal(aim.win(), undefined, 'AIM');
});

integrationTest('topic chat counterexample 7: AIM offers no AI explore on the card menu or the command; the plain map offers both', async () => {
  const item = () => { const it = { setTitle(title) { it.title = title; return it; }, setIcon() { return it; }, setSection() { return it; }, setDisabled() { return it; }, onClick(fn) { it.fn = fn; return it; } }; return it; };
  const menuOf = (h) => { const items = []; return { items, menu: { addItem(cb) { const it = item(); cb(it); items.push(it); return this; }, addSeparator() { return this; } } }; };
  const aim = await harness({ aim: true });
  const a = menuOf(aim); aim.view.addCardMenuActions(a.menu, aim.node('a'));
  assert.equal(a.items.some(i => i.title === t('ui.ai_explore')), false, 'no menu entry on AIM');
  aim.view.selection.setSelected(aim.ids.a);
  assert.equal(aim.view.mapCommand('ai-explore', true), false, 'no command on AIM');
  const h = await harness();
  const m = menuOf(h); h.view.addCardMenuActions(m.menu, h.node('a'));
  const entry = m.items.find(i => i.title === t('ui.ai_explore'));
  assert.ok(entry, 'the plain map has the menu entry'); entry.fn();
  assert.equal(h.view.topicChatOpen?.entry.nodeId, h.ids.a, 'the right-click entry opens the topic chat');
  h.view.closeTopicChatWindow();
  h.view.selection.setSelected(h.ids.b);
  assert.equal(h.view.mapCommand('ai-explore', false), true);
  assert.equal(h.view.topicChatOpen?.entry.nodeId, h.ids.b, 'the command opens the topic chat');
});

integrationTest('topic chat entries: the empty suggestion panel and the card tool open the topic chat; no entry opens the old dialog', async () => {
  const h = await harness();
  const panel = element('div'); panel.root = h.page.doc;
  h.view.renderPendingProposals(panel, h.node('c'), h.view.notes.get(h.ids.c), () => {});
  const open = find(panel, i => i.tag === 'button' && i.text === t('ui.ai_explore')); assert.ok(open, 'the empty panel has the button');
  const before = h.view.topicChatOpen; assert.equal(before?.entry.nodeId, undefined, 'no window before the click'); open.click();
  assert.equal(h.view.topicChatOpen?.entry.nodeId, h.ids.c, 'the panel button opens the topic chat');
  // The card tool is built by renderNode, which needs the full page; its source is checked instead (the tester sees the real button).
  const source = fs.readFileSync(path.join(root, 'experiences/visual-map/view.ts'), 'utf8');
  const sites = [...source.matchAll(/t\("ui\.ai_explore"\)/g)].map(m => source.slice(m.index, m.index + 170));
  assert.ok(sites.length >= 3); assert.ok(sites.every(site => site.includes('openTopicChat') && !/NextStep|Modal/.test(site)), sites.join('\n'));
});

integrationTest('topic chat opens one window at a time: opening B closes A, A keeps its conversation, a repaint keeps the window and its draft', async () => {
  const h = await harness();
  const a = h.host('a'); a.setDraft('expand', 'my draft');
  const first = h.win(); assert.equal(h.view.topicChatOpen.entry.nodeId, h.ids.a);
  h.repaint(); assert.equal(h.win(), first); assert.ok(h.overlay().children.includes(first.el), 'put into the new overlay');
  assert.equal(h.entry('a').session.draftText, 'my draft');
  h.view.openTopicChat(h.node('b'));
  assert.equal(h.view.topicChatOpen.entry.nodeId, h.ids.b); assert.equal(h.overlay().children.filter(i => hasClass(i, 'vam-topic-chat')).length, 1);
  assert.equal(h.entry('a').session.draftText, 'my draft', 'A kept its draft');
  h.view.map.nodes = h.view.map.nodes.filter(n => n.id !== h.ids.b); h.repaint();
  assert.equal(h.win(), undefined, 'the window closes when its topic is gone');
  h.view.openTopicChat(h.node('a')); await h.view.onClose();
  assert.equal(h.win(), undefined); assert.equal(h.view.topicChatSessions.size, 0, 'view close releases the sessions');
});

integrationTest('topic chat counterexample 1: Standard integration is not Local (web search on), Quick is Local; the sidebar integration stays Local', async () => {
  const h = await harness(); const seen = []; await researched(h);
  h.view.startSynthesis = async (node, options, direction, failed, accepted, observer) => { seen.push({ id: node.id, options, direction, observer }); accepted(); };
  const host = h.host('root');
  host.setMode('standard');
  assert.equal(await host.submit('synthesize', 'Integrate sleep'), true);
  host.setMode('quick');
  await waitFor(() => !h.entry('root').session.running);
  assert.equal(await host.submit('synthesize', 'Again'), true);
  await waitFor(() => seen.length === 2 && !h.entry('root').session.running);
  assert.equal(seen[0].options.researchMode, 'research'); assert.equal(seen[1].options.researchMode, 'local');
  assert.equal(seen[0].direction, 'Integrate sleep');
  assert.equal(seen[0].options.visualMode, 'off'); assert.equal(seen[0].options.researchDepth, 'normal'); assert.deepEqual(plain(seen[0].options.referenceGroups), []);
  assert.equal(h.view.map.aiMode, undefined, 'an integration does not remember the mode on the map (only research and expand do)');
  assert.equal(chatSynthesisOptions({ outputLanguage: 'en' }).researchMode, 'local', 'the sidebar integration is still Quick');
  // The task service turns the Standard value into a web search, Quick into none.
  const { default: Plugin } = load('main.ts', { obsidian });
  for (const [mode, web] of [['research', true], ['local', false]]) {
    const plugin = new Plugin(); plugin.app = { vault: { adapter: new obsidian.FileSystemAdapter() } }; plugin.manifest = { dir: '.obsidian/plugins/visual-agent-map' };
    let call; plugin.claudeCli = () => ({ runTask: async (...args) => { call = args; return JSON.stringify({ summary: 'S', detail: 'D', suggestions: [], visualReferences: [] }); } });
    await plugin.askModel({ title: 'T', summary: '', rules: '', detail: '', task: 'x', ancestors: '', mode: 'synthesize', researchMode: mode, researchDepth: 'normal', visualMode: 'off' }, 'claude:sonnet', 'low');
    assert.equal(call[4].webSearch, web, mode);
  }
});

integrationTest('topic chat integration: a written result reaches the window even though the observer says closed; a topic without subtopics answers at once without a usage question', async () => {
  const h = await harness(); await researched(h);
  h.view.startSynthesis = async (node, options, direction, failed, accepted, observer) => { accepted(); observer.onWritten(); };
  const host = h.host('root');
  await host.submit('synthesize', 'x'); await waitFor(() => !h.entry('root').session.running);
  assert.equal(h.entry('root').session.turns.at(-1).text, t('ui.topic_chat_synthesis_done_0', 2));
  const asks = h.control.usageAsks;
  const leaf = h.host('b');
  assert.equal(await leaf.submit('synthesize', 'x'), true);
  assert.equal(h.control.usageAsks, asks, 'no usage question');
  assert.equal(h.entry('b').session.turns.at(-1).text, t('ui.topic_chat_no_children'));
});

integrationTest('topic chat counterexample 4: expand makes the subtopics at once - no dialog, no proposal step, one undo step, one sentence with the titles', async () => {
  const h = await harness();
  h.view.proposeChildren = () => assert.fail('the guided proposal path is not used'); h.view.openChildSuggestions = () => assert.fail('no review window');
  h.plugin.outlineGeneration = { generate: async () => outlineOf('# Body\n## Light\n## Noise\n## Heat') };
  await h.view.aiModeMemory().rememberAiMode('quick'); // an unchanged mode adds no undo step of its own
  const before = (await h.saved()).length; const steps = h.view.history.past.length;
  const host = h.host('a');
  assert.equal(await host.submit('expand', 'split by cause'), true);
  await finished(h).catch(e => { throw new Error(e.message + JSON.stringify([h.notices, h.entry('a').session, [...h.plugin.running]])); });
  const created = (await h.saved()).length - before;
  assert.equal(created, 3, 'created directly');
  assert.equal(h.control.modals.length, 0, 'no modal');
  assert.equal(h.view.history.past.length, steps + 1, 'one undo step');
  assert.equal(h.entry('a').session.turns.at(-1).text, t('ui.topic_chat_expand_done_0_1', 3, ['Light', 'Noise', 'Heat'].join(t('ui.list_separator'))));
  assert.equal(h.entry('a').session.turns[0].kind, 'expand');
  await h.plugin.mutate(() => h.view.travel(false));
  assert.equal((await h.saved()).length, before, 'one undo removes all of them');
});

integrationTest('topic chat counterexample 5: closing the window does not stop the task; the result lands in the conversation and a Notice tells it; reopening shows it', async () => {
  const h = await harness(); const gate = deferred(); let signal;
  h.plugin.outlineGeneration = { generate: async (_r, s) => { signal = s; await gate.promise; return outlineOf('# Body\n## Light'); } };
  const host = h.host('a');
  await host.submit('expand', 'x');
  await waitFor(() => signal);
  host.close(); assert.equal(h.win(), undefined, 'closed');
  assert.equal(signal.aborted, false, 'closing does not abort'); assert.equal(h.entry('a').session.running, true);
  gate.resolve(); await finished(h);
  const sentence = t('ui.topic_chat_expand_done_0_1', 1, 'Light');
  assert.equal(h.entry('a').session.turns.at(-1).text, sentence);
  assert.ok(h.notices.includes(sentence), 'the Notice tells the result');
  h.view.openTopicChat(h.node('a')); assert.ok(h.texts().includes(sentence), 'visible after reopening');
});

integrationTest('topic chat research: Quick is local without charts, Standard searches the web; a result with the window closed goes through the usual completed Notice; stop says stopped', async () => {
  const h = await harness(); const calls = stubResearch(h);
  const host = h.host('a');
  host.setMode('standard'); await host.submit('research', 'dig deeper');
  await waitFor(() => calls.length === 1);
  assert.equal(calls[0].request.researchMode, 'research'); assert.equal(calls[0].request.addCharts, true); assert.match(calls[0].request.task, /dig deeper$/);
  host.close();
  calls[0].done({ summary: 'S', detail: 'D' }); calls[0].gate.resolve(); await finished(h);
  assert.ok(h.notices.some(n => n.includes('Body')), 'completed Notice: ' + h.notices.join('|'));
  assert.equal(h.entry('a').session.turns.at(-1).text, t('ui.topic_chat_research_done'));
  h.view.openTopicChat(h.node('a')); host.setMode('quick'); await host.submit('research', 'again');
  await waitFor(() => calls.length === 2);
  assert.equal(calls[1].request.researchMode, 'local'); assert.equal(calls[1].request.addCharts, false);
  calls[1].failed(t('ui.research_stopped_existing_content_was_preserved')); calls[1].gate.resolve(); await finished(h);
  assert.equal(h.entry('a').session.turns.at(-1).text, t('ui.topic_chat_stopped'));
});

integrationTest('topic chat busy topic: submit is refused with a Notice and nothing starts', async () => {
  const h = await harness(); const calls = stubResearch(h);
  h.plugin.quickExpandPending.add(h.node('a').path);
  assert.equal(await h.host('a').submit('research', 'x'), false);
  h.plugin.quickExpandPending.clear(); h.view.startingTasks.set(h.node('a').path, new AbortController());
  assert.equal(await h.host('a').submit('research', 'x'), false);
  h.view.startingTasks.clear(); h.view.synthesisTasks.set(h.node('a').path, { state: 'running' });
  assert.equal(await h.host('a').submit('research', 'x'), false);
  assert.equal(calls.length, 0); assert.equal(h.control.usageAsks, 0); assert.equal(h.notices.at(-1), t('ui.ai_running_ai'));
});

integrationTest('topic chat counterexample 8: a declined usage question starts nothing and the typed text stays in the window', async () => {
  const h = await harness(); const calls = stubResearch(h); let generated = 0; let synthesized = 0;
  h.plugin.outlineGeneration = { generate: async () => { generated++; return outlineOf('# Body\n## X'); } };
  h.view.startSynthesis = async () => { synthesized++; };
  h.control.decline = true;
  const host = h.host('a');
  for (const kind of ['research', 'expand', 'synthesize']) assert.equal(await host.submit(kind, 'go'), false, kind);
  assert.deepEqual([calls.length, generated, synthesized], [0, 0, 0]);
  assert.equal(h.entry('a').session.running, false); assert.equal(h.entry('a').session.turns.length, 0);
  assert.equal(h.plugin.running.size, 0); assert.equal(h.plugin.activeTasks.size, 0);
  // Through the real window: the text and the pressed button stay.
  const win = h.win(); const input = find(win.el, i => i.tag === 'textarea');
  find(win.el, i => i.tag === 'button' && i.text === t('ui.topic_chat_research')).click();
  input.value = 'dig deeper'; input.input();
  byLabel(win.el, t('ui.topic_chat_send')).click(); await tick(); await tick();
  assert.equal(input.value, 'dig deeper'); assert.equal(h.entry('a').session.draftKind, 'research');
  assert.equal(calls.length, 0);
});

// ---- P2: records on disk --------------------------------------------------------------------------------------------

const records = load('core/topic-chat-records.ts');
const chatRecords = load('core/map-chat-records.ts');
const vaultFiles = h => [...h.files.values()].filter(f => f instanceof obsidian.TFile);
const topicPath = (h, key, id) => `${h.repo.topicRoot(MAP)}/Chats/topics/${id ?? h.ids[key]}.jsonl`;
const topicText = async (h, key, id) => { const p = topicPath(h, key, id); return (await h.repo.app.vault.adapter.exists(p)) ? h.repo.app.vault.adapter.read(p) : null; };
const topicLines = async (h, key, id) => { await h.view.topicChatRecords?.idle(); const text = await topicText(h, key, id); return text === null ? null : text.split('\n').filter(Boolean).map(l => JSON.parse(l)); };
const settled = h => waitFor(() => h.plugin.running.size === 0 && h.plugin.activeTasks.size === 0 && !h.view.topicChatSessions.get(h.ids.a)?.session.running);

test('topic chat record format: path whitelist, cut last line, broken lines, unknown version, pairing', () => {
  assert.equal(records.isSafeTopicNodeId('abc_DEF-1'), true);
  for (const bad of ['', 'a/b', '..', '../x', 'a.b', 'x'.repeat(65), 'a b', 7, null]) assert.equal(records.isSafeTopicNodeId(bad), false, String(bad));
  assert.equal(records.topicChatPath('Agent Workspace/Topics/m', 'n1'), 'Agent Workspace/Topics/m/Chats/topics/n1.jsonl');
  assert.throws(() => records.topicChatPath('Agent Workspace/Topics/m', '../n1'));
  assert.throws(() => records.topicChatPath('../m', 'n1'));
  const turn = { type: 'turn', id: 't1', at: '2026-11-08T00:00:00.000Z', kind: 'research', mode: 'quick', message: 'hi' };
  const result = { type: 'result', id: 't1', at: '2026-11-08T00:00:01.000Z', status: 'done', text: 'ok' };
  const text = records.serializeTopicChatLine(turn) + records.serializeTopicChatLine(result);
  assert.deepEqual(Object.keys(JSON.parse(text.split('\n')[0]))[0], 'v');
  // A cut last line and a broken line are skipped; the rest is read.
  const damaged = text + 'not json\n' + '{"v":1,"type":"turn","id":"x","at":"a","kind":"bogus","mode":"quick","message":"m"}\n' + '{"v":1,"type":"result","id":"t2","at":"a","sta';
  const parsed = records.parseTopicChat(damaged);
  assert.equal(parsed.lines.length, 2); assert.equal(parsed.skipped, 3); assert.equal(parsed.cleanEnd, false); assert.equal(parsed.unrecoverable, false);
  assert.equal(records.parseTopicChat(text).cleanEnd, true);
  assert.equal(records.parseTopicChat(text + '{"v":2,"type":"turn"}\n').unrecoverable, true);
  const restored = records.restoreTopicChat(parsed.lines.concat([{ ...turn, id: 't3' }, { ...result, id: 'orphan' }]));
  assert.deepEqual(plain(restored.map(r => [r.id, r.result?.text ?? null])), [['t1', 'ok'], ['t3', null]]);
});

integrationTest('topic chat counterexample 5 (reload): the conversation is saved and comes back after the sessions are gone', async () => {
  const h = await harness(); h.view.plugin.settings.mapChatRecords = false; // saved whatever the sidebar switch says
  h.plugin.outlineGeneration = { generate: async () => outlineOf('# Body\n## Light') };
  const host = h.host('a'); await host.submit('expand', 'split by cause'); await finished(h);
  const lines = await topicLines(h, 'a');
  assert.deepEqual(plain(lines.map(l => [l.v, l.type])), [[1, 'turn'], [1, 'result']]);
  assert.equal(lines[0].kind, 'expand'); assert.equal(lines[0].mode, 'quick'); assert.equal(lines[0].message, 'split by cause');
  assert.equal(lines[1].id, lines[0].id); assert.equal(lines[1].status, 'done');
  assert.equal(lines[1].text, t('ui.topic_chat_expand_done_0_1', 1, 'Light'));
  assert.ok(!JSON.stringify(lines).includes('prompt'), 'no prompt or context stored');
  // Reload: a new session for the same topic reads the file back.
  h.view.closeTopicChatWindow(); h.view.topicChatSessions.clear();
  h.view.openTopicChat(h.node('a'));
  await waitFor(() => h.entry('a').session.turns.length === 2);
  assert.deepEqual(plain(h.entry('a').session.turns.map(x => [x.role, x.text])), [['user', 'split by cause'], ['ai', t('ui.topic_chat_expand_done_0_1', 1, 'Light')]]);
  assert.ok(h.texts().includes('split by cause'), 'the window shows it');
});

integrationTest('topic chat counterexample 6: the sidebar switch count and delete leave Chats/topics alone; the sidebar record has no topic chat turn', async () => {
  const { turnMapChatRecordsOff } = load('ui/modals/map-chat-records-off-modal.ts', { obsidian });
  const h = await harness(); const calls = stubResearch(h);
  await h.host('a').submit('research', 'dig'); await waitFor(() => calls.length === 1);
  calls[0].done({ summary: 'S', detail: 'D' }); calls[0].gate.resolve(); await finished(h);
  assert.equal((await topicLines(h, 'a')).length, 2);
  const file = topicPath(h, 'a');
  assert.equal(chatRecords.isRecordFilePath(file), false); assert.equal(records.isTopicChatFilePath(file), true);
  assert.equal(chatRecords.isRecordFilePath(`${h.repo.topicRoot(MAP)}/Chats/records/20261108-000000-abcdef.jsonl`), true);
  assert.equal(records.isTopicChatFilePath(`${h.repo.topicRoot(MAP)}/Chats/records/20261108-000000-abcdef.jsonl`), false);
  assert.deepEqual(chatRecords.recordFilesIn(vaultFiles(h)).map(f => f.path), []);
  let asked = 0; const trashed = [];
  const app = { vault: Object.assign(Object.create(h.repo.app.vault), { getFiles: () => vaultFiles(h) }), fileManager: { trashFile: async f => { trashed.push(f.path); } } };
  const res = await turnMapChatRecordsOff({ app, writers: [], ask: async () => { asked++; return true; } });
  assert.deepEqual([res.deleted, res.failed, asked, trashed.length], [0, 0, 0, 0], 'nothing counted, nothing deleted');
  assert.ok(await topicText(h, 'a'), 'the topic chat file is still there');
  assert.equal(h.view.chatRecords, null, 'the sidebar writer was never made by a topic chat');
});

integrationTest('topic chat counterexample 9: a node id with a slash or dots writes no file, the conversation stays in memory', async () => {
  for (const bad of ['../evil', 'a/b', '..']) {
    const h = await harness(); const calls = stubResearch(h);
    const target = h.node('a'); h.view.openTopicChat(target);
    const entry = h.entry('a'); entry.nodeId = bad; // the id the records are keyed by
    const went = await h.view.submitTopicChat(entry, target, 'research', 'x'); assert.equal(went, true, JSON.stringify(h.notices)); await waitFor(() => calls.length === 1);
    calls[0].done({ summary: 'S', detail: 'D' }); calls[0].gate.resolve();
    await waitFor(() => !entry.session.running);
    await h.view.topicChatRecords.idle();
    assert.equal(entry.session.turns.length, 2, 'kept in memory');
    const stray = [...h.files.keys()].filter(p => p.includes('/Chats/'));
    assert.deepEqual(plain(stray), [], bad);
  }
});

integrationTest('topic chat late result: a view that closed meanwhile is not written to (no sentence in the session, no result line), and reopening says the result is unknown', async () => {
  const h = await harness(); const gate = deferred();
  h.plugin.outlineGeneration = { generate: async () => { await gate.promise; return outlineOf('# Body\n## Light'); } };
  const host = h.host('a'); await host.submit('expand', 'x');
  const turns = h.entry('a').session.turns.length;
  h.view.closed = true; gate.resolve();
  await waitFor(() => h.plugin.running.size === 0 && !h.entry('a').session.running);
  assert.equal(h.entry('a').session.turns.length, turns, 'no sentence written after the view closed');
  assert.deepEqual(plain((await topicLines(h, 'a')).map(l => l.type)), ['turn'], 'the turn is saved, the result is not');
  h.view.closed = false; h.view.closeTopicChatWindow(); h.view.topicChatSessions.clear(); h.view.openTopicChat(h.node('a'));
  await waitFor(() => h.entry('a').session.turns.length === 2);
  assert.deepEqual(plain(h.entry('a').session.turns.map(x => x.text)), ['x', t('ui.topic_chat_result_unknown')]);
});

integrationTest('topic chat record writer: a cut file gets a line break first, another schema version is never written, a failure notices once, a disposed writer writes nothing', async () => {
  const h = await harness(); const calls = stubResearch(h);
  const p = topicPath(h, 'a'); await h.repo.ensureTopicFolders?.(h.repo.topicRoot(MAP));
  await h.repo.app.vault.createFolder(`${h.repo.topicRoot(MAP)}/Chats`).catch(() => {}); await h.repo.app.vault.createFolder(`${h.repo.topicRoot(MAP)}/Chats/topics`).catch(() => {});
  const cut = records.serializeTopicChatLine({ type: 'turn', id: 'old', at: 'a', kind: 'research', mode: 'quick', message: 'older' }) + '{"v":1,"type":"res';
  await h.repo.app.vault.create(p, cut);
  await h.host('a').submit('research', 'new'); await waitFor(() => calls.length === 1);
  calls[0].done({ summary: 'S', detail: 'D' }); calls[0].gate.resolve(); await finished(h);
  await h.view.topicChatWriter().idle(); const parsed = records.parseTopicChat(await topicText(h, 'a'));
  assert.deepEqual(plain(parsed.lines.map(l => [l.type, l.id === 'old' ? 'old' : 'new'])), [['turn', 'old'], ['turn', 'new'], ['result', 'new']]);
  // Unknown version: untouched.
  const h2 = await harness(); const calls2 = stubResearch(h2);
  await h2.repo.app.vault.createFolder(`${h2.repo.topicRoot(MAP)}/Chats`).catch(() => {}); await h2.repo.app.vault.createFolder(`${h2.repo.topicRoot(MAP)}/Chats/topics`).catch(() => {});
  const future = '{"v":2,"type":"turn","x":1}\n'; await h2.repo.app.vault.create(topicPath(h2, 'a'), future);
  await h2.host('a').submit('research', 'new'); await waitFor(() => calls2.length === 1);
  calls2[0].done({ summary: 'S', detail: 'D' }); calls2[0].gate.resolve(); await finished(h2); await h2.view.topicChatWriter().idle();
  assert.equal(await topicText(h2, 'a'), future, 'not overwritten, not appended to');
  assert.equal(h2.entry('a').session.turns.length, 2, 'the chat itself goes on');
  // Failure: one Notice for several writes.
  const h3 = await harness(); const calls3 = stubResearch(h3);
  h3.repo.app.vault.create = async () => { throw new Error('disk busy'); };
  await h3.host('a').submit('research', 'z'); await waitFor(() => calls3.length === 1);
  calls3[0].done({ summary: 'S', detail: 'D' }); calls3[0].gate.resolve(); await finished(h3); await h3.view.topicChatWriter().idle();
  assert.equal(h3.notices.filter(n => n === t('ui.topic_chat_record_failed')).length, 1);
  // Closed or disposed writers take no line.
  const h4 = await harness(); const w = h4.view.topicChatWriter(); w.dispose();
  w.write(h4.repo.topicRoot(MAP), 'abc', { type: 'turn', id: 'q', at: 'a', kind: 'research', mode: 'quick', message: 'm' }); await w.idle();
  assert.equal(await topicText(h4, null, 'abc'), null);
});

integrationTest('topic chat synthesize researches only idea or error subtopics first (same mode), then integrates; the sentence says so', async () => {
  const h = await harness(); const calls = stubResearch(h); const seen = [];
  h.view.startSynthesis = async (node, options, direction, failed, accepted, observer) => { seen.push(node.id); accepted(); observer.onWritten(); };
  const statuses = { a: 'completed', b: 'error' }; const load0 = h.view.hydrate;
  h.view.hydrate = async () => { await load0(); for (const [k, v] of Object.entries(statuses)) h.view.notes.get(h.ids[k]).status = v; };
  await h.view.hydrate();
  const host = h.host('root'); host.setMode('standard');
  await host.submit('synthesize', 'all'); await waitFor(() => calls.length === 1);
  assert.equal(calls[0].node.id, h.ids.b, 'only the unresearched subtopic'); assert.equal(calls[0].request.researchMode, 'research');
  assert.equal(seen.length, 0, 'integration waits for the research');
  calls[0].done({ summary: 'S', detail: 'D' }); calls[0].gate.resolve();
  await waitFor(() => !h.entry('root').session.running);
  assert.deepEqual(seen, [h.ids.root]);
  assert.equal(h.entry('root').session.turns.at(-1).text, t('ui.topic_chat_synthesis_researched_first_0_1', 1, 2));
  assert.equal(h.view.selection.selectedId ?? null, null, 'selection untouched');
  // Nothing to research: straight to the integration with the plain sentence.
  statuses.b = 'completed'; await h.view.hydrate(); calls.length = 0;
  await host.submit('synthesize', 'again'); await waitFor(() => !h.entry('root').session.running && seen.length === 2);
  assert.equal(calls.length, 0); assert.equal(h.entry('root').session.turns.at(-1).text, t('ui.topic_chat_synthesis_done_0', 2));
});

integrationTest('topic chat synthesize: when every subtopic research fails the integration does not start and one sentence says so', async () => {
  const h = await harness(); const calls = stubResearch(h); let synthesized = 0;
  h.view.startSynthesis = async () => { synthesized++; };
  const host = h.host('root');
  await host.submit('synthesize', 'all');
  for (let i = 0; i < 2; i++) { await waitFor(() => calls.length === i + 1); calls[i].failed('boom'); calls[i].gate.resolve(); }
  await waitFor(() => !h.entry('root').session.running);
  assert.equal(synthesized, 0);
  assert.equal(h.entry('root').session.turns.at(-1).text, t('ui.topic_chat_failed_0', t('ui.topic_chat_failed_children')));
  assert.equal((await topicLines(h, 'root')).at(-1).status, 'failed');
});

// ---- P3: a free question (map-chat step, subtree context, subtree-only writes) ----------------------------------------
const ACT = {
  runMap: (action, nodeIds, extra = {}) => ({ kind: 'run_map_action', action, nodeIds, title: '', goal: '', direction: '', mode: '', images: false, ...extra })
};
const mockChat = (h, make) => {
  h.requests = [];
  h.plugin.mapChat = { chat: async (request, signal) => { h.requests.push(request); return typeof make === 'function' ? make(request, signal) : make; } };
};
const answer = (actions, reply = 'ok') => ({ reply, actions, rejected: [], remaining: '' });
const snapshot = async h => {
  const out = new Map();
  for (const [p, file] of h.files) if (file.extension === 'md') out.set(p, await h.app.vault.read(file));
  return out;
};
const changedPaths = (before, after) => [...new Set([...before.keys(), ...after.keys()])].filter(p => before.get(p) !== after.get(p));

integrationTest('topic chat ask: the request carries only the subtree, no mapNeedsName or emptyMap, and the record round-trips as kind ask', async () => {
  const h = await harness(); mockChat(h, answer([], 'The **body** sleeps.'));
  const host = h.host('a');
  assert.equal(await host.submit('ask', 'what is here?'), true);
  await finished(h);
  const context = JSON.parse(h.requests[0].context.json);
  const raw = h.requests[0].context.json;
  assert.deepEqual(Array.from(h.requests[0].context.nodeIds).sort(), [h.ids.a, h.ids.c].sort(), 'only the topic and what is under it');
  assert.ok(!raw.includes('Mind'), 'siblings are not sent');
  assert.ok(!('mapNeedsName' in context) && !('emptyMap' in context));
  assert.equal(h.requests[0].message, 'what is here?');
  const last = h.entry('a').session.turns;
  assert.deepEqual([last[0].kind, last[1].text, last[1].markdown], ['ask', 'The **body** sleeps.', true]);
  const lines = await topicLines(h, 'a');
  assert.deepEqual([lines[0].kind, lines[1].status, lines[1].text], ['ask', 'done', 'The **body** sleeps.']);
  // The side panel keeps nothing of it.
  assert.equal(h.view.chatLastRecord ?? null, null);
  const { restoreTopicChat } = load('core/topic-chat-records.ts');
  const turns = restoreTopicChat(lines);
  assert.equal(turns[0].kind, 'ask'); assert.equal(turns[0].result.text, 'The **body** sleeps.');
  h.view.closeTopicChatWindow(); h.view.topicChatSessions.clear(); h.view.openTopicChat(h.node('a'));
  await waitFor(() => h.entry('a')?.session.turns.length === 2);
  assert.deepEqual([h.entry('a').session.turns[0].kind, h.entry('a').session.turns[1].markdown], ['ask', true]);
});

integrationTest('topic chat counterexample 3: a reply that reaches outside the subtree is refused item by item; the notes and the map outside stay byte for byte, the item inside is applied', async () => {
  const h = await harness(); const bNote = h.node('b').path;
  mockChat(h, answer([
    { kind: 'rename_topic', nodeId: h.ids.b, title: 'Sibling renamed' },
    { kind: 'add_child', parentId: h.ids.root, title: 'Under the parent', summary: '' },
    { kind: 'add_child', parentId: '', title: 'A new root', summary: '' },
    { kind: 'move_topic', nodeId: h.ids.c, newParentId: h.ids.b },
    { kind: 'add_relation', fromId: h.ids.c, toId: h.ids.b, relationKind: 'related' },
    { kind: 'delete_topic', nodeId: h.ids.a, branch: true },
    { kind: 'create_map', title: 'Another map' },
    { kind: 'open_map', title: 'Sleep map' },
    { kind: 'rename_map', title: 'New name' },
    ACT.runMap('expand', [h.ids.b]),
    { kind: 'edit_md_file', path: bNote, find: 'Mind', replace: 'Hacked' },
    { kind: 'rename_topic', nodeId: h.ids.c, title: 'REM stage' }
  ], 'Done.'));
  const before = await snapshot(h); const mapBefore = (await h.saved()).map(n => ({ id: n.id, parentId: n.parentId, path: n.path }));
  const host = h.host('a');
  assert.equal(await host.submit('ask', 'rewrite everything'), true);
  await finished(h);
  const after = await snapshot(h);
  const changed = changedPaths(before, after).filter(p => !p.includes('/Chats/'));
  assert.ok(changed.every(p => p === h.node('c').path || p.endsWith('/Map.md')), 'only the note inside changed: ' + changed.join(', '));
  assert.ok(changed.includes(h.node('c').path), 'the inside item was applied');
  assert.equal(after.get(bNote), before.get(bNote), 'the sibling note is byte for byte the same');
  assert.equal(after.get(h.node('root').path), before.get(h.node('root').path));
  assert.equal(after.get(h.node('a').path), before.get(h.node('a').path));
  const mapAfter = (await h.saved()).map(n => ({ id: n.id, parentId: n.parentId, path: n.path }));
  assert.deepEqual(mapAfter, mapBefore, 'no card added, moved or removed');
  assert.equal((await h.repo.readNote(h.node('c').path)).title, 'REM stage');
  assert.equal((await h.repo.readNote(bNote)).title, 'Mind');
  assert.equal(h.view.map.title, 'Sleep map');
  const sentence = h.entry('a').session.turns.at(-1).text;
  assert.ok(sentence.includes('Done.') && sentence.includes(t('ui.topic_chat_out_of_scope')), sentence);
});

integrationTest('topic chat ask: inside the subtree a new card and a relation are written; a reply that needs a plan is not applied and says so in one sentence', async () => {
  const h = await harness();
  mockChat(h, answer([{ kind: 'add_child', parentId: h.ids.a, title: 'Light', summary: 'S', ref: 'n1' }, { kind: 'add_relation', fromId: 'new:n1', toId: h.ids.c, relationKind: 'related' }], 'Added.'));
  const before = (await h.saved()).length;
  await h.host('a').submit('ask', 'add light'); await finished(h);
  const nodes = await h.saved();
  assert.equal(nodes.length, before + 1); assert.equal(nodes.find(n => n.path !== undefined && n.parentId === h.ids.a && n.id !== h.ids.c)?.parentId, h.ids.a);
  assert.ok(!h.entry('a').session.turns.at(-1).text.includes(t('ui.topic_chat_out_of_scope')), 'nothing was refused');
  // Too big: a new card for every one of 16 actions needs the plan screen; nothing is written.
  mockChat(h, answer(Array.from({ length: 16 }, (_, i) => ({ kind: 'add_child', parentId: h.ids.a, title: 'X' + i, summary: '' })), 'Lots.'));
  const count = (await h.saved()).length;
  await h.host('a').submit('ask', 'lots'); await finished(h);
  assert.equal((await h.saved()).length, count, 'not applied');
  assert.equal(h.entry('a').session.turns.at(-1).text, t('ui.topic_chat_too_big'));
});

integrationTest('topic chat ask: a run action in the subtree goes to the topic chat runner, one outside never runs', async () => {
  const h = await harness(); const calls = stubResearch(h);
  mockChat(h, answer([ACT.runMap('research_standard', [h.ids.a], { direction: 'focus' }), ACT.runMap('research_standard', [h.ids.b])], 'Researching.'));
  await h.host('a').submit('ask', 'research it');
  await waitFor(() => calls.length === 1);
  assert.equal(calls[0].node.id, h.ids.a); assert.match(calls[0].request.task, /focus$/);
  calls[0].done({ summary: 'S', detail: 'D' }); calls[0].gate.resolve();
  await finished(h);
  assert.equal(calls.length, 1, 'the sibling was not researched');
  assert.ok(h.entry('a').session.turns.at(-1).text.includes(t('ui.topic_chat_out_of_scope')));
});

integrationTest('topic chat ask: a declined usage question sends nothing; stop says stopped and writes nothing', async () => {
  const h = await harness(); mockChat(h, answer([]));
  h.control.decline = true;
  assert.equal(await h.host('a').submit('ask', 'hi'), false);
  assert.equal(h.requests.length, 0); assert.equal(h.entry('a').session.turns.length, 0);
  h.control.decline = false; const gate = deferred(); let signal;
  mockChat(h, async (_r, s) => { signal = s; await gate.promise; if (s.aborted) throw new Error('aborted'); return answer([{ kind: 'rename_topic', nodeId: h.ids.a, title: 'Late' }]); });
  await h.host('a').submit('ask', 'slow'); await waitFor(() => signal);
  h.view.startingTasks.get(h.node('a').path).abort(); gate.resolve(); await finished(h);
  assert.equal(h.entry('a').session.turns.at(-1).text, t('ui.topic_chat_stopped'));
  assert.equal((await h.repo.readNote(h.node('a').path)).title, 'Body');
});

integrationTest('topic chat synthesize: aborting while the unresearched subtopics are researched does not start the integration', async () => {
  const h = await harness(); const calls = stubResearch(h); let synthesized = 0;
  h.view.startSynthesis = async () => { synthesized++; };
  await h.host('root').submit('synthesize', 'all');
  await waitFor(() => calls.length === 1);
  h.view.startingTasks.get(h.node('root').path).abort();
  calls[0].done({ summary: 'S', detail: 'D' }); calls[0].gate.resolve();
  await finished(h).catch(() => {}); await waitFor(() => !h.entry('root').session.running);
  assert.equal(synthesized, 0, 'no integration after the stop');
  assert.equal(h.entry('root').session.turns.at(-1).text, t('ui.topic_chat_stopped'));
});

integrationTest('topic chat integration: the integration is written into the parent topic and the Undo button of its Notice puts the old content back', async () => {
  const h = await harness(); await researched(h);
  const rootNote = h.node('root');
  await h.repo.updateNote(rootNote.path, { status: 'completed', summary: 'Existing conclusion', detail: 'Existing knowledge' });
  await h.view.hydrate();
  const before = await h.repo.readNote(rootNote.path);
  let call = 0;
  h.plugin.abortChartJobs = () => {}; h.plugin.addChartsAfterWrite = () => {};
  h.plugin.askModel = async (_context, _model, _reasoning, _signal, _onExchange, onAccepted) => {
    onAccepted?.(); call++;
    return call === 1 ? { summary: '', detail: '', visualReferences: [], suggestions: [{ title: 'Common ground', task: 'Find shared constraints', contribution: 'A shared view', parentTitle: '' }] }
      : { summary: 'Draft summary', detail: 'Draft detail', visualReferences: [], suggestions: [] };
  };
  const options = { researchMode: 'local', researchDepth: 'normal', visualMode: 'off', referenceGroups: [] };
  const fail = message => assert.fail(message);
  await h.view.startSynthesis(h.node('root'), options, null, fail, () => {});
  await h.view.startSynthesis(h.node('root'), options, 'Find shared constraints', fail, () => {});
  assert.equal((await h.repo.readNote(rootNote.path)).summary, 'Draft summary', 'the result is written into the parent');
  const undo = h.Notice.all.flatMap(n => n.actions).find(b => b.text === t('ui.undo'));
  assert.ok(undo, 'the done Notice has an Undo button');
  undo.click();
  await waitFor(() => h.view.history.canRedo);
  assert.deepEqual(plain(await h.repo.readNote(rootNote.path)), plain(before), 'Undo restores the parent verbatim');
});

integrationTest('topic chat Escape gives the focus back: to the button that opened it, else to the topic card, never the page body', async () => {
  const h = await harness();
  const focused = [];
  const card = key => ({ focus: () => focused.push('card:' + key) });
  h.view.cardEls = new Map([[h.ids.a, card('a')], [h.ids.b, card('b')], [h.ids.c, card('c')]]);
  const escape = () => h.win().el.fire('keydown', { key: 'Escape' });
  // Button entry: the empty suggestion panel's AI explore button gets the focus back.
  const panel = element('div'); panel.root = h.page.doc;
  h.view.renderPendingProposals(panel, h.node('c'), h.view.notes.get(h.ids.c), () => {});
  const open = find(panel, i => i.tag === 'button' && i.text === t('ui.ai_explore'));
  open.focus = () => focused.push('button'); open.click(); escape();
  assert.deepEqual(plain(focused), ['button'], 'the button entry returns to its button');
  // The button was removed by a repaint meanwhile: the card of the same topic takes the focus.
  focused.length = 0; h.view.closeTopicChatWindow();
  open.click(); open.isConnected = false; escape();
  assert.deepEqual(plain(focused), ['card:c'], 'a removed opener falls back to the topic card');
  // No-button entries (right-click menu, command): the card of the topic.
  focused.length = 0; h.view.closeTopicChatWindow();
  h.view.selection.setSelected(h.ids.b);
  assert.equal(h.view.mapCommand('ai-explore', false), true); escape();
  assert.deepEqual(plain(focused), ['card:b'], 'the command entry returns to the card');
  focused.length = 0; h.view.closeTopicChatWindow();
  const items = []; const menu = { addItem(cb) { const it = { setTitle(x) { it.title = x; return it; }, setIcon() { return it; }, setSection() { return it; }, setDisabled() { return it; }, onClick(fn) { it.fn = fn; return it; } }; cb(it); items.push(it); return this; }, addSeparator() { return this; } };
  h.view.addCardMenuActions(menu, h.node('a')); items.find(i => i.title === t('ui.ai_explore')).fn(); escape();
  assert.deepEqual(plain(focused), ['card:a'], 'the right-click entry returns to the card');
});

// ---- Review round 1 ---------------------------------------------------------------------------------------------------

const RENAMED = 'Agent Workspace/Topics/map-b/Map.md';
const lineTexts = async (h, root, id) => { await h.view.topicChatRecords?.idle(); const p = `${root}/Chats/topics/${id}.jsonl`; return (await h.repo.app.vault.adapter.exists(p)) ? (await h.repo.app.vault.adapter.read(p)).split('\n').filter(Boolean).map(l => JSON.parse(l)) : null; };

integrationTest('topic chat B1: after a map rename or Organize the next turn is written into the new folder and the old folder is not made again; a task running through the rename still tells its result', async () => {
  const h = await harness(); const calls = stubResearch(h);
  const oldRoot = h.repo.topicRoot(MAP), newRoot = h.repo.topicRoot(RENAMED);
  assert.notEqual(oldRoot, newRoot);
  h.view.openTopicChat(h.node('a')); // the entry is made on the old path
  await h.repo.ensureTopicFolders('Agent Workspace/Topics/map-b'); // the renamed map file (same content)
  await h.app.vault.create(RENAMED, await h.app.vault.read(h.app.vault.getAbstractFileByPath(MAP)));
  h.view.relocate(new Map([[MAP, RENAMED]]));
  const went = await h.host('a').submit('research', 'after the rename'); assert.equal(went, true, JSON.stringify(h.notices)); await waitFor(() => calls.length === 1);
  // The rename happens again in the middle of the task: the result still lands in the conversation.
  h.view.relocate(new Map([[RENAMED, MAP]]));
  h.view.relocate(new Map([[MAP, RENAMED]]));
  calls[0].done({ summary: 'S', detail: 'D' }); calls[0].gate.resolve(); await finished(h);
  assert.equal(h.entry('a').session.turns.at(-1).text, t('ui.topic_chat_research_done'), 'the result sentence is not dropped');
  const lines = await lineTexts(h, newRoot, h.ids.a);
  assert.deepEqual(plain(lines.map(l => l.type)), ['turn', 'result']);
  assert.equal(lines[0].message, 'after the rename');
  assert.equal(await lineTexts(h, oldRoot, h.ids.a), null, 'the old folder has no record file');
  assert.ok(![...h.files.keys()].some(p => p.startsWith(`${oldRoot}/Chats`)), 'the old folder was not made again');
});

integrationTest('topic chat B1: a rename in the middle of a task keeps the result sentence (the task is bound to the map, not to its path)', async () => {
  const h = await harness(); const calls = stubResearch(h);
  await h.host('a').submit('research', 'x'); await waitFor(() => calls.length === 1);
  await h.repo.ensureTopicFolders('Agent Workspace/Topics/map-b');
  await h.app.vault.create(RENAMED, await h.app.vault.read(h.app.vault.getAbstractFileByPath(MAP)));
  h.view.relocate(new Map([[MAP, RENAMED]]));
  calls[0].done({ summary: 'S', detail: 'D' }); calls[0].gate.resolve(); await finished(h);
  assert.equal(h.entry('a').session.turns.at(-1).text, t('ui.topic_chat_research_done'));
  const lines = await lineTexts(h, h.repo.topicRoot(RENAMED), h.ids.a);
  assert.deepEqual(plain(lines.map(l => l.type)), ['result'], 'the result goes to the folder the map has now');
});

integrationTest('topic chat B2: the map remembers aiMode only after the usage question is confirmed, and only for research and expand', async () => {
  const h = await harness(); const calls = stubResearch(h);
  h.plugin.outlineGeneration = { generate: async () => outlineOf('# Body\n## Light') };
  h.view.startSynthesis = async (node, options, direction, failed, accepted, observer) => { accepted(); observer.onWritten(); };
  mockChat(h, answer([], 'hi')); await researched(h);
  assert.equal(h.view.map.aiMode, undefined);
  const host = h.host('a'); host.setMode('standard');
  h.control.decline = true;
  for (const kind of ['research', 'expand']) assert.equal(await host.submit(kind, 'go'), false, kind);
  assert.equal(h.view.map.aiMode, undefined, 'a declined question writes nothing');
  assert.equal((await h.saved()).length, 4); assert.equal((await core.parseMap(await h.app.vault.read(h.app.vault.getAbstractFileByPath(MAP)))).aiMode, undefined, 'nor on disk');
  h.control.decline = false;
  const root = h.host('root'); root.setMode('standard');
  await root.submit('synthesize', 'all'); await waitFor(() => !h.entry('root').session.running);
  await host.submit('ask', 'hi'); await finished(h);
  assert.equal(h.view.map.aiMode, undefined, 'an integration and a free question do not remember the mode');
  await host.submit('research', 'go'); await waitFor(() => calls.length === 1);
  assert.equal(h.view.map.aiMode, 'standard', 'a confirmed research remembers it');
  calls[0].done({ summary: 'S', detail: 'D' }); calls[0].gate.resolve(); await finished(h);
  host.setMode('quick'); await host.submit('expand', 'split'); await finished(h);
  assert.equal(h.view.map.aiMode, 'quick', 'a confirmed expand remembers it');
});

integrationTest('topic chat B3: the parent topic edited while the integration was made keeps the edit, leaves no history or Undo, and one failure sentence is told', async () => {
  const h = await harness(); await researched(h);
  const rootNote = h.node('root');
  await h.repo.updateNote(rootNote.path, { status: 'completed', summary: 'Existing conclusion', detail: 'Existing knowledge' });
  await h.view.hydrate();
  h.plugin.abortChartJobs = () => {}; h.plugin.addChartsAfterWrite = () => {};
  h.plugin.askModel = async (_context, _model, _reasoning, _signal, _onExchange, onAccepted) => {
    onAccepted?.();
    await h.repo.updateNote(rootNote.path, { summary: 'Edited meanwhile' });
    return { summary: 'Draft summary', detail: 'Draft detail', visualReferences: [], suggestions: [] };
  };
  const host = h.host('root'); const historyBefore = h.view.history.canUndo;
  await host.submit('synthesize', 'Integrate'); await waitFor(() => !h.entry('root').session.running);
  const after = await h.repo.readNote(rootNote.path);
  assert.deepEqual([after.summary, after.detail], ['Edited meanwhile', 'Existing knowledge'], 'the edit stays, nothing of the integration is written');
  assert.equal(h.view.history.canUndo, historyBefore, 'no history entry'); assert.equal(h.view.history.canRedo, false);
  assert.equal(h.Notice.all.flatMap(n => n.actions ?? []).some(b => b.text === t('ui.undo')), false, 'no Undo button');
  assert.equal(h.entry('root').session.turns.at(-1).text, t('ui.topic_chat_failed_0', t('log.child_integration_failed')));
  assert.equal((await topicLines(h, 'root')).at(-1).status, 'failed');
});

integrationTest('topic chat M1: starting a presentation closes the small window (a running task keeps going) and nothing can be sent during it', async () => {
  const h = await harness(); const calls = stubResearch(h);
  const host = h.host('a'); await host.submit('research', 'x'); await waitFor(() => calls.length === 1);
  assert.ok(h.win(), 'the window is open');
  h.view.canPresent = () => true; h.view.presentationOrder = () => [h.ids.a]; h.view.startPresentation();
  assert.ok(h.view.presentation, 'the presentation started');
  assert.equal(h.view.topicChatOpen, null, 'the window was closed');
  assert.equal(h.entry('a').session.running, true, 'the task goes on');
  calls[0].done({ summary: 'S', detail: 'D' }); calls[0].gate.resolve(); await finished(h);
  assert.equal(h.entry('a').session.turns.at(-1).text, t('ui.topic_chat_research_done'));
  const asks = h.control.usageAsks;
  assert.equal(await h.view.submitTopicChat(h.entry('a'), h.node('a'), 'research', 'again'), false, 'no send while presenting');
  assert.equal(h.control.usageAsks, asks); assert.equal(calls.length, 1);
});

integrationTest('topic chat M2: a run action on a card this reply made (new:<ref>) researches that card', async () => {
  const h = await harness(); const calls = stubResearch(h);
  mockChat(h, answer([{ kind: 'add_child', parentId: h.ids.a, title: 'Light', summary: 'S', ref: 'n1' }, ACT.runMap('research_standard', ['new:n1'])], 'Added and researching.'));
  await h.host('a').submit('ask', 'add light and research it');
  await waitFor(() => calls.length === 1);
  assert.equal((await h.repo.readNote(calls[0].node.path)).title, 'Light'); assert.notEqual(calls[0].node.id, h.ids.a);
  calls[0].done({ summary: 'S', detail: 'D' }); calls[0].gate.resolve(); await finished(h);
  // A reference that was never made is skipped, not turned into the topic itself.
  mockChat(h, answer([ACT.runMap('research_standard', ['new:nope'])], 'Researching.'));
  await h.host('a').submit('ask', 'research a ghost'); await finished(h);
  assert.equal(calls.length, 1, 'nothing ran for a card that was never made');
});

integrationTest('topic chat M3: a failed or skipped action is shown with the AI sentence and the record says failed', async () => {
  const h = await harness(); const calls = stubResearch(h);
  mockChat(h, answer([ACT.runMap('research_standard', [h.ids.a])], 'All done!'));
  await h.host('a').submit('ask', 'research it'); await waitFor(() => calls.length === 1);
  calls[0].failed('model unavailable'); calls[0].gate.resolve(); await finished(h);
  const text = h.entry('a').session.turns.at(-1).text;
  assert.ok(text.includes('All done!'), 'the AI sentence stays'); assert.ok(text.includes('model unavailable'), 'the failure is shown with it');
  assert.match(text, /^All done!\n\n.*Failed:.*model unavailable/s);
  assert.equal((await topicLines(h, 'a')).at(-1).status, 'failed');
  // Everything went well: only the AI sentence, status done.
  mockChat(h, answer([{ kind: 'add_child', parentId: h.ids.b, title: 'Calm', summary: 'S' }], 'Added.'));
  await h.host('b').submit('ask', 'rename'); await waitFor(() => !h.entry('b').session.running);
  assert.equal(h.entry('b').session.turns.at(-1).text, 'Added.'); assert.equal((await topicLines(h, 'b')).at(-1).status, 'done');
});
